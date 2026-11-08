// applyChange: validate -> classify -> lock check -> commitment gate -> apply
// -> persist -> recompute (PRD "Rule evaluation" step 5). Runs in the worker, so
// a UI page cannot skip the gate.

import { classifyChange, type Change } from '../shared/changes.ts';
import { makePassage, passageMatches } from '../shared/challenge.ts';
import { hashPassword, verifyPassword } from '../shared/crypto.ts';
import { newId } from '../shared/defaults.ts';
import { currentPhase, validateFocusConfig } from '../shared/focus.ts';
import type { ApplyResult, ChallengeInfo, GateProof } from '../shared/messages.ts';
import { activeLocks } from '../shared/rules.ts';
import { isValidHHMM } from '../shared/schedule.ts';
import type { Config, Rule, Runtime, Schedule, Settings, Target } from '../shared/types.ts';
import { isValidRedirectUrl, normalizeHost, targetKey } from '../shared/url.ts';
import type { ParentalPatch } from '../shared/changes.ts';
import { learnSite } from '../shared/parental.ts';
import { addFocusCredits, focusCredits, recomputeLocked } from './engine.ts';
import { notify } from './notify.ts';
import { getState, save, withLock } from './state.ts';

const CATEGORIES = ['social', 'video', 'news', 'shopping', 'work', 'ai', 'other'];
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const DAY_MS = 86_400_000;

// ---- Validation ----

function validTarget(t: Target, config: Config): boolean {
  switch (t.kind) {
    case 'domain':
      return typeof t.host === 'string' && /^[a-z0-9.-]+$/.test(t.host) && t.host.length <= 253;
    case 'prefix':
    case 'exact':
      return typeof t.url === 'string' && t.url.length > 0 && t.url.length <= 2000 && !/\s/.test(t.url);
    case 'group':
      return config.groups.some((g) => g.id === t.groupId);
  }
}

function validSchedule(s: Schedule | undefined): string | null {
  if (!s) return null;
  if (!Array.isArray(s.days) || !s.days.length || s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Pick at least one day.';
  if (!Array.isArray(s.windows) || s.windows.some((w) => !isValidHHMM(w.start) || !isValidHHMM(w.end))) return 'Times must be HH:mm.';
  return null;
}

export function validateRule(r: Rule, config: Config): string | null {
  if (!r || typeof r.id !== 'string' || !r.id) return 'Rule id missing.';
  if (r.name && r.name.length > 100) return 'Rule name is too long (max 100).';
  if (!Array.isArray(r.targets) || !r.targets.length) return 'Add at least one site.';
  if (r.targets.length > 500) return 'Too many sites in one rule (max 500).';
  if (r.targets.some((t) => !validTarget(t, config))) return 'One of the sites is not valid.';
  const sched = validSchedule(r.schedule);
  if (sched) return sched;
  if (r.allow) return null;
  const a = r.action;
  switch (a?.kind) {
    case 'block':
      return null;
    case 'redirect':
      return isValidRedirectUrl(a.url) ? null : 'Redirect address must start with http:// or https://.';
    case 'budget':
      return Number.isFinite(a.minutesPerDay) && a.minutesPerDay >= 1 && a.minutesPerDay <= 1440 ? null : 'Budget must be 1–1440 minutes.';
    case 'hide':
      if (!Array.isArray(a.selectors) || a.selectors.some((s) => typeof s !== 'string' || s.length > 500)) return 'Selectors are not valid.';
      return a.selectors.length || a.presetId ? null : 'Add at least one selector or preset option.';
    default:
      return 'Unknown action.';
  }
}

function validateSettingsPatch(p: Partial<Settings>): string | null {
  const range = (v: number | undefined, lo: number, hi: number) => v === undefined || (Number.isFinite(v) && v >= lo && v <= hi);
  if (!range(p.challengeLength, 100, 1000)) return 'Challenge length must be 100–1000 characters.';
  if (!range(p.challengeDelayMin, 1, 60)) return 'Delay must be 1–60 minutes.';
  if (!range(p.idleSeconds, 15, 600)) return 'Idle threshold must be 15–600 seconds.';
  if (!range(p.minutesPerBlockedAttempt, 0, 60)) return 'Minutes per blocked visit must be 0–60.';
  if (p.resetTime !== undefined && !isValidHHMM(p.resetTime)) return 'Reset time must be HH:mm.';
  if (p.uninstallUrl !== undefined && p.uninstallUrl !== '' && !isValidRedirectUrl(p.uninstallUrl)) return 'The page address must start with http:// or https://.';
  return null;
}

function validate(change: Change, config: Config, rt: Runtime, now: number): string | null {
  switch (change.kind) {
    case 'rule.upsert':
      return validateRule(change.rule, config);
    case 'rules.add': {
      if (!Array.isArray(change.rules)) return 'No rules.';
      const tmp: Config = { ...config, groups: [...config.groups, ...(change.groups ?? [])] };
      for (const r of change.rules) {
        const e = validateRule(r, tmp);
        if (e) return e;
      }
      return null;
    }
    case 'rule.delete':
    case 'rule.setEnabled':
      return config.rules.some((r) => r.id === change.id) ? null : 'That rule no longer exists.';
    case 'group.upsert': {
      const g = change.group;
      if (!g?.id || !g.name?.trim() || g.name.length > 100) return 'Give the group a name.';
      if (!Array.isArray(g.targets) || g.targets.some((t) => (t as Target).kind === 'group' || !validTarget(t, config))) return 'One of the sites is not valid.';
      return null;
    }
    case 'group.delete':
      return null;
    case 'settings.update':
      return validateSettingsPatch(change.patch);
    case 'commitment.set':
      if (!['none', 'password', 'challenge'].includes(change.level)) return 'Unknown level.';
      if (change.level === 'password' && (change.newPassword ?? '').length < 8) return 'Password must be at least 8 characters.';
      return null;
    case 'focus.config':
      return validateFocusConfig(change.config);
    case 'focus.start':
      if (rt.focus && currentPhase(rt.focus, now)) return 'A focus session is already running.';
      return validateFocusConfig(change.config ?? config.focusConfig);
    case 'focus.stop':
      return rt.focus ? null : 'No focus session is running.';
    case 'lock.start':
      if (!Number.isFinite(change.durationMin) || change.durationMin < 15 || change.durationMin > 1440) return 'Hard Lock length must be 15 minutes to 24 hours.';
      if (!change.ruleIds.length && !change.targets.length) return 'Choose at least one site or rule to lock.';
      if (change.ruleIds.some((id) => !config.rules.some((r) => r.id === id))) return 'One of the rules no longer exists.';
      if (change.targets.some((t) => !validTarget(t, config))) return 'One of the sites is not valid.';
      return null;
    case 'lock.extend': {
      const l = activeLocks(rt, now).find((x) => x.id === change.lockId);
      if (!l) return 'That Hard Lock is not active.';
      if (!Number.isFinite(change.minutes) || change.minutes < 1) return 'Extend by at least 1 minute.';
      if (l.endsAt + change.minutes * 60_000 - now > DAY_MS) return 'A Hard Lock can run at most 24 hours from now.';
      return null;
    }
    case 'lock.add': {
      if (!activeLocks(rt, now).some((x) => x.id === change.lockId)) return 'That Hard Lock is not active.';
      if (change.ruleIds.some((id) => !config.rules.some((r) => r.id === id))) return 'One of the rules no longer exists.';
      return change.targets.some((t) => !validTarget(t, config)) ? 'One of the sites is not valid.' : null;
    }
    case 'lockSchedule.upsert': {
      const s = change.schedule;
      if (!s?.id) return 'Schedule id missing.';
      if (!Array.isArray(s.days) || !s.days.length) return 'Pick at least one day.';
      if (!isValidHHMM(s.start)) return 'Start time must be HH:mm.';
      if (!Number.isFinite(s.durationMin) || s.durationMin < 15 || s.durationMin > 1440) return 'Length must be 15 minutes to 24 hours.';
      if (!s.ruleIds.length && !s.targets.length) return 'Choose at least one site or rule to lock.';
      return s.targets.some((t) => !validTarget(t, config)) ? 'One of the sites is not valid.' : null;
    }
    case 'lockSchedule.delete':
      return null;
    case 'blockPage.update':
      if (change.message !== undefined && change.message.length > 500) return 'Message is too long (max 500).';
      if (typeof change.image === 'string') {
        if (!/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/.test(change.image)) return 'Use a PNG, JPEG, GIF, WebP or SVG image.';
        if (Math.floor((change.image.length - change.image.indexOf(',') - 1) * 0.75) > MAX_IMAGE_BYTES) return 'Image must be 2 MB or smaller.';
      }
      return null;
    case 'pause':
      if (change.minutes !== null && (!Number.isFinite(change.minutes) || change.minutes < 1 || change.minutes > 525_600)) return 'Pause length is not valid.';
      return null;
    case 'categories.set':
      return Object.values(change.overrides).every((c) => CATEGORIES.includes(c)) ? null : 'Unknown category.';
    case 'onboarding.done':
      return null;
    case 'parental.enable':
      if (!config.parental.pinHash && (change.pin ?? '').length < 4) return 'Choose a guardian PIN of at least 4 characters.';
      return change.patch ? validateParentalPatch(change.patch) : null;
    case 'parental.update':
      return validateParentalPatch(change.patch);
    case 'parental.setPin':
      return (change.newPin ?? '').length >= 4 ? null : 'The PIN needs at least 4 characters.';
    case 'parental.allowSite':
      return HOST_OK.test(normalizeHost(change.host ?? '')) ? null : 'That is not a site address.';
    case 'parental.disable':
    case 'parental.forget':
      return null;
  }
}

const HOST_OK = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function validateParentalPatch(p: ParentalPatch): string | null {
  if (p.sensitivity !== undefined && !['low', 'medium', 'high'].includes(p.sensitivity)) return 'Unknown sensitivity.';
  if (p.detectScope !== undefined && !['page', 'site'].includes(p.detectScope)) return 'Unknown detection scope.';
  if (p.blockedWords !== undefined) {
    if (!Array.isArray(p.blockedWords) || p.blockedWords.length > 200) return 'Use at most 200 blocked words.';
    if (p.blockedWords.some((w) => typeof w !== 'string' || !w.trim() || w.length > 50)) return 'Each blocked word must be 1–50 characters.';
  }
  if (p.allowedSites !== undefined) {
    if (!Array.isArray(p.allowedSites) || p.allowedSites.length > 500) return 'Use at most 500 allowed sites.';
    if (p.allowedSites.some((h) => typeof h !== 'string' || !HOST_OK.test(normalizeHost(h)))) return 'One of the allowed sites is not a site address.';
  }
  return null;
}

// ---- Gate ----

interface StoredChallenge extends ChallengeInfo {
  createdAt: number;
}

async function challenges(): Promise<Record<string, StoredChallenge>> {
  const got = await chrome.storage.session.get('challenges');
  const all = (got.challenges as Record<string, StoredChallenge>) ?? {};
  const now = Date.now();
  for (const [id, c] of Object.entries(all)) if (c.expiresAt < now) delete all[id];
  return all;
}

export async function requestChallenge(mode: 'type' | 'delay'): Promise<ChallengeInfo> {
  const { config } = await getState();
  const all = await challenges();
  const now = Date.now();
  if (mode === 'delay') {
    // Reuse a pending delay so closing the popup does not restart the wait.
    const pending = Object.values(all).find((c) => c.mode === 'delay');
    if (pending) return strip(pending);
  }
  const id = newId();
  const c: StoredChallenge =
    mode === 'type'
      ? { id, mode, text: makePassage(config.settings.challengeLength), createdAt: now, expiresAt: now + 30 * 60_000 }
      : { id, mode, readyAt: now + config.settings.challengeDelayMin * 60_000, createdAt: now, expiresAt: now + (config.settings.challengeDelayMin + 15) * 60_000 };
  all[id] = c;
  await chrome.storage.session.set({ challenges: all });
  return strip(c);
}

function strip(c: StoredChallenge): ChallengeInfo {
  const { createdAt: _createdAt, ...rest } = c;
  return rest;
}

async function verifyProof(level: 'password' | 'challenge' | 'guardian', proof: GateProof, config: Config): Promise<string | null> {
  const settings = config.settings;
  if (level === 'guardian') {
    if (proof.kind !== 'guardian') return 'Enter the guardian PIN.';
    return (await verifyPassword(proof.pin, config.parental.pinHash)) ? null : 'That PIN is not right.';
  }
  if (proof.kind === 'guardian') return 'Use your own password or challenge for this change.';
  if (level === 'password') {
    if (proof.kind !== 'password') return 'Enter your password.';
    return (await verifyPassword(proof.password, settings.passwordHash)) ? null : 'That password is not right.';
  }
  if (proof.kind === 'password') return 'Complete the challenge.';
  const all = await challenges();
  const c = all[proof.challengeId];
  if (!c) return 'The challenge expired. Try again.';
  const now = Date.now();
  let error: string | null = null;
  if (proof.kind === 'challenge') {
    if (c.mode !== 'type' || !passageMatches(c.text ?? '', proof.typed)) error = 'The text did not match exactly. Try a new passage.';
  } else if (c.mode !== 'delay' || now < (c.readyAt ?? Infinity)) {
    error = 'The waiting time is not over yet.';
  }
  // Single use: a typing challenge is spent on any attempt; a delay only on success.
  if (c.mode === 'type' || !error) {
    delete all[proof.challengeId];
    await chrome.storage.session.set({ challenges: all });
  }
  return error;
}

// ---- Apply ----

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const out = [...list];
  out[i] = item;
  return out;
}

function mergeTargets(a: Target[], b: Target[]): Target[] {
  const seen = new Set(a.map(targetKey));
  return [...a, ...b.filter((t) => !seen.has(targetKey(t)) && seen.add(targetKey(t)))];
}

async function mutate(change: Change, config: Config, rt: Runtime, now: number): Promise<string | undefined> {
  switch (change.kind) {
    case 'rule.upsert':
      config.rules = upsert(config.rules, change.rule);
      return change.rule.id;
    case 'rule.delete':
      config.rules = config.rules.filter((r) => r.id !== change.id);
      delete rt.budget.used[change.id];
      return;
    case 'rule.setEnabled':
      config.rules = config.rules.map((r) => (r.id === change.id ? { ...r, enabled: change.enabled } : r));
      return;
    case 'rules.add':
      for (const g of change.groups ?? []) config.groups = upsert(config.groups, g);
      for (const r of change.rules) config.rules = upsert(config.rules, { ...r, createdAt: r.createdAt || now });
      return;
    case 'group.upsert':
      config.groups = upsert(config.groups, change.group);
      return change.group.id;
    case 'group.delete':
      config.groups = config.groups.filter((g) => g.id !== change.id);
      // Drop the dangling group target from rules; a rule left with no target is disabled.
      config.rules = config.rules.map((r) => {
        const targets = r.targets.filter((t) => !(t.kind === 'group' && t.groupId === change.id));
        return targets.length === r.targets.length ? r : { ...r, targets, enabled: targets.length ? r.enabled : false };
      });
      return;
    case 'settings.update':
      config.settings = { ...config.settings, ...change.patch };
      if (change.patch.idleSeconds !== undefined) chrome.idle.setDetectionInterval(config.settings.idleSeconds);
      if (change.patch.uninstallUrl !== undefined) await Promise.resolve(chrome.runtime.setUninstallURL(config.settings.uninstallUrl)).catch(() => undefined);
      return;
    case 'commitment.set':
      config.settings.commitment = change.level;
      if (change.level === 'password') config.settings.passwordHash = await hashPassword(change.newPassword!);
      else delete config.settings.passwordHash;
      return;
    case 'focus.config':
      config.focusConfig = { ...change.config };
      return;
    case 'focus.start': {
      const fc = change.config ?? config.focusConfig;
      rt.focus = { ...fc, ruleIds: config.rules.filter((r) => r.onlyDuringFocus).map((r) => r.id), startedAt: now, lastPhaseIndex: 0 };
      notify('focus', `Focus · ${fc.workMin} min`, `Interval 1 of ${fc.cycles}. Your focus list is blocked.`);
      return;
    }
    case 'focus.stop': {
      const s = rt.focus!;
      const ph = currentPhase(s, now);
      if (ph) await addFocusCredits(focusCredits(s, s.lastPhaseIndex ?? 0, ph.index + 1, now));
      rt.focus = null;
      return;
    }
    case 'lock.start': {
      const id = newId();
      rt.locks.push({ id, ruleIds: [...new Set(change.ruleIds)], targets: mergeTargets([], change.targets), startedAt: now, endsAt: now + change.durationMin * 60_000 });
      return id;
    }
    case 'lock.extend':
      rt.locks = rt.locks.map((l) => (l.id === change.lockId ? { ...l, endsAt: l.endsAt + change.minutes * 60_000 } : l));
      return;
    case 'lock.add':
      rt.locks = rt.locks.map((l) =>
        l.id === change.lockId ? { ...l, ruleIds: [...new Set([...l.ruleIds, ...change.ruleIds])], targets: mergeTargets(l.targets, change.targets) } : l,
      );
      return;
    case 'lockSchedule.upsert':
      config.lockSchedules = upsert(config.lockSchedules, change.schedule);
      return change.schedule.id;
    case 'lockSchedule.delete':
      config.lockSchedules = config.lockSchedules.filter((s) => s.id !== change.id);
      return;
    case 'blockPage.update':
      if (change.message !== undefined) config.blockPage.message = change.message;
      if (change.image === null) {
        await chrome.storage.local.remove('blockImage');
        config.blockPage.hasImage = false;
      } else if (typeof change.image === 'string') {
        await chrome.storage.local.set({ blockImage: change.image });
        config.blockPage.hasImage = true;
      }
      return;
    case 'pause':
      rt.pausedUntil = change.minutes === null ? null : now + change.minutes * 60_000;
      return;
    case 'categories.set':
      config.categoryOverrides = { ...change.overrides };
      return;
    case 'onboarding.done':
      config.onboarded = true;
      return;
    case 'parental.enable':
      if (change.pin) config.parental.pinHash = await hashPassword(change.pin);
      config.parental = { ...config.parental, ...(change.patch ?? {}), enabled: true };
      return;
    case 'parental.disable':
      config.parental = { ...config.parental, enabled: false };
      delete config.parental.pinHash; // turning it on again sets a new PIN
      return;
    case 'parental.update': {
      const patch = { ...change.patch };
      if (patch.blockedWords) patch.blockedWords = [...new Set(patch.blockedWords.map((w) => w.trim().toLowerCase()))];
      if (patch.allowedSites) patch.allowedSites = [...new Set(patch.allowedSites.map(normalizeHost))];
      config.parental = { ...config.parental, ...patch };
      return;
    }
    case 'parental.setPin':
      config.parental.pinHash = await hashPassword(change.newPin);
      return;
    case 'parental.allowSite': {
      const host = normalizeHost(change.host);
      config.parental.allowedSites = [...new Set([...config.parental.allowedSites, host])];
      rt.parentalDetected = rt.parentalDetected.filter((d) => d.host !== host && !d.host.endsWith('.' + host));
      return;
    }
    case 'parental.forget':
      rt.parentalDetected = change.host === null ? [] : rt.parentalDetected.filter((d) => d.host !== normalizeHost(change.host!));
      return;
  }
}

/** Record a site the detector flagged (worker-internal, not a user change). */
export function recordDetection(host: string, score: number, source: 'meta' | 'text' | 'images'): Promise<void> {
  return withLock(async () => {
    const st = await getState();
    st.runtime.parentalDetected = learnSite(st.runtime.parentalDetected, { host, at: Date.now(), score, source });
    await save({ runtime: true });
    await recomputeLocked();
  });
}

const GATE_MESSAGE = 'This change loosens your rules, so your commitment level asks for a check first.';

/** Apply a change through the gate. `trusted` skips nothing; it only exists for internal tightening calls. */
export function applyChange(change: Change, proof?: GateProof): Promise<ApplyResult> {
  return withLock(async () => {
    const st = await getState();
    const now = Date.now();
    const invalid = validate(change, st.config, st.runtime, now);
    if (invalid) return { ok: false, error: 'invalid', message: invalid };
    const cls = classifyChange(change, st.config, st.runtime, now);
    if (cls.lockConflict) return { ok: false, error: 'locked', message: cls.lockConflict };
    if (cls.forbidden) return { ok: false, error: 'forbidden', message: cls.forbidden };
    const level = st.config.settings.commitment;
    if (cls.guardian) {
      if (!proof) return { ok: false, error: 'gate', level: 'guardian', message: 'Parental controls are on. A parent or guardian needs to enter the PIN.' };
      const bad = await verifyProof('guardian', proof, st.config);
      if (bad) return { ok: false, error: 'wrongProof', message: bad };
    } else if (cls.loosening && level !== 'none') {
      if (!proof) return { ok: false, error: 'gate', level, message: GATE_MESSAGE };
      const bad = await verifyProof(level, proof, st.config);
      if (bad) return { ok: false, error: 'wrongProof', message: bad };
    }
    // Work on copies so a failure part-way leaves the cached state untouched.
    const config: Config = structuredClone(st.config);
    const runtime: Runtime = structuredClone(st.runtime);
    const id = await mutate(change, config, runtime, now);
    st.config = config;
    st.runtime = runtime;
    await save({ config: true, runtime: true });
    await recomputeLocked();
    return { ok: true, id };
  });
}
