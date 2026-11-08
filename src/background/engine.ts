// Recompute and enforce (PRD "Rule evaluation" steps 1-3 and 6). Runs on every
// trigger: rule edit, alarm, focus interval change, lock start/end, budget
// exhausted, browser startup. Idempotent: it can run any time.

import { blockPagePath, compileDnr, isRedirectLoop, type DnrRule } from '../shared/dnr.ts';
import { currentPhase, focusPhases, phaseLabel, sessionEndsAt } from '../shared/focus.ts';
import { newId } from '../shared/defaults.ts';
import {
  activeLocks,
  budgetLimitSec,
  budgetUsed,
  computeActive,
  decideUrl,
  entryPriority,
  isPaused,
  nextChangeTime,
  type ActiveEntry,
  type Decision,
  type EngineState,
} from '../shared/rules.ts';
import { atLocalMinutes, budgetPeriodKey, localDateKey, parseHHMM, startOfLocalDay } from '../shared/schedule.ts';
import type { Config, FocusSession, HideIndex, Runtime } from '../shared/types.ts';
import { KNOWN_ADULT_SITES } from '../parental/known-sites.ts';
import {
  compileParentalDnr,
  needsParentalScript,
  parentalBlockFor,
  parentalBlockPath,
  parentalIndexOf,
} from '../shared/parental.ts';
import { parseHttpUrl } from '../shared/url.ts';
import { notify, setGlobalBadge, setTabBadge } from './notify.ts';
import { dayRecord, getPresets, getState, save, updateStats, withLock } from './state.ts';

/** Hosts where Chrome does not let extensions act. */
const UNSUPPORTED_HOSTS = ['chromewebstore.google.com', 'chrome.google.com'];

export function isSupportedUrl(url: string | undefined): boolean {
  const u = url ? parseHttpUrl(url) : null;
  return !!u && !UNSUPPORTED_HOSTS.includes(u.hostname);
}

export function engineState(config: Config, runtime: Runtime, now = Date.now()): EngineState {
  return { config, runtime, now };
}

export const KNOWN_SET = new Set(KNOWN_ADULT_SITES);

/** Parental block page URL for a tab URL, or null. Parental blocks win over everything else. */
export function parentalUrl(url: string, config: Config, rt: Runtime): string | null {
  const b = parentalBlockFor(url, config.parental, rt.parentalDetected, KNOWN_SET);
  return b ? chrome.runtime.getURL(parentalBlockPath(b.t, b.host).slice(1)) : null;
}

/** Where a tab on a blocked/redirected URL should go, or null. */
export function enforcementUrl(d: Decision, entries: ActiveEntry[]): string | null {
  if (!d.entry || (d.action !== 'block' && d.action !== 'redirect')) return null;
  if (d.action === 'redirect' && d.redirectUrl && !isRedirectLoop(d.entry, entries)) return d.redirectUrl;
  return chrome.runtime.getURL(blockPagePath(d.entry.ruleId, d.targetIndex).slice(1));
}

// ---- Housekeeping: time-driven state transitions ----

interface FocusCredit {
  date: string;
  seconds: number;
}

/** Credit work phases [from, to) of a session; partial credit for a phase cut at `cutAt`. */
export function focusCredits(s: FocusSession, from: number, to: number, cutAt?: number): FocusCredit[] {
  const out: FocusCredit[] = [];
  for (const p of focusPhases(s).slice(from, to)) {
    if (p.kind !== 'work') continue;
    const end = cutAt !== undefined ? Math.min(p.endsAt, cutAt) : p.endsAt;
    if (end > p.startsAt) out.push({ date: localDateKey(p.startsAt), seconds: Math.round((end - p.startsAt) / 1000) });
  }
  return out;
}

export async function addFocusCredits(credits: FocusCredit[]): Promise<void> {
  if (!credits.length) return;
  await updateStats((stats) => {
    for (const c of credits) dayRecord(stats, c.date).focusSeconds += c.seconds;
  });
}

function lockScheduleOccurrence(day: number, start: string): number | null {
  const m = parseHHMM(start);
  return Number.isNaN(m) ? null : atLocalMinutes(day, m % 1440);
}

/** Start recurring locks whose window contains now (FR-3.1). */
function startScheduledLocks(config: Config, rt: Runtime, now: number): boolean {
  let changed = false;
  for (const s of config.lockSchedules) {
    if (!s.enabled || s.durationMin <= 0) continue;
    for (const off of [-1, 0]) {
      const occ = lockScheduleOccurrence(startOfLocalDay(now, off), s.start);
      if (occ === null || !s.days.includes(new Date(occ).getDay())) continue;
      const end = occ + s.durationMin * 60_000;
      if (now < occ || now >= end) continue;
      if (rt.locks.some((l) => l.scheduleId === s.id && l.startedAt === occ)) continue;
      rt.locks.push({ id: newId(), ruleIds: [...s.ruleIds], targets: [...s.targets], startedAt: occ, endsAt: end, scheduleId: s.id });
      notify('lock', 'Hard Lock started', `${s.name || 'Recurring lock'} runs until ${new Date(end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`);
      changed = true;
    }
  }
  return changed;
}

/** Next start of any recurring lock, for alarm scheduling. */
export function nextLockScheduleStart(config: Config, now: number): number | null {
  let best: number | null = null;
  for (const s of config.lockSchedules) {
    if (!s.enabled) continue;
    for (let off = 0; off <= 7; off++) {
      const occ = lockScheduleOccurrence(startOfLocalDay(now, off), s.start);
      if (occ === null || occ <= now || !s.days.includes(new Date(occ).getDay())) continue;
      if (best === null || occ < best) best = occ;
      break;
    }
  }
  return best;
}

async function housekeeping(config: Config, rt: Runtime, now: number): Promise<void> {
  // Budget period rollover (FR-2.2).
  const period = budgetPeriodKey(now, config.settings.resetTime);
  if (rt.budget.period !== period) rt.budget = { period, used: {}, warned: [] };
  // Pause expiry.
  if (rt.pausedUntil !== null && now >= rt.pausedUntil) rt.pausedUntil = null;
  // Recurring locks, then drop expired locks (also those that ended while Chrome was closed).
  startScheduledLocks(config, rt, now);
  rt.locks = rt.locks.filter((l) => l.endsAt > now);
  // Focus session phase changes (FR-6.3).
  const s = rt.focus;
  if (s) {
    const last = s.lastPhaseIndex ?? 0;
    const ph = currentPhase(s, now);
    const phases = focusPhases(s);
    if (!ph && now >= sessionEndsAt(s)) {
      await addFocusCredits(focusCredits(s, last, phases.length));
      rt.focus = null;
      notify('focus', 'Focus session complete', `Nice work: ${s.cycles} focus interval${s.cycles > 1 ? 's' : ''} done.`);
    } else if (ph && ph.index !== last) {
      await addFocusCredits(focusCredits(s, last, ph.index));
      s.lastPhaseIndex = ph.index;
      const min = Math.round((ph.endsAt - ph.startsAt) / 60_000);
      if (ph.kind === 'work') notify('focus', `Back to focus · ${min} min`, `Interval ${ph.cycle} of ${s.cycles}. Your focus list is blocked again.`);
      else notify('focus', `${phaseLabel(ph.kind)} · ${min} min`, 'Your focus list is open until the break ends.');
    }
  }
}

// ---- Enforcement ----

let lastDnrJson = '';

async function applyDnr(rules: DnrRule[]): Promise<void> {
  const json = JSON.stringify(rules);
  if (json === lastDnrJson) return;
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: rules as chrome.declarativeNetRequest.Rule[] });
  } catch (err) {
    // One bad rule (e.g. a regex RE2 rejects) must not disable all blocking: add them one by one.
    console.warn('FocusGuard: bulk DNR update failed, adding rules individually', err);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
    for (const r of rules) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [r as chrome.declarativeNetRequest.Rule] });
      } catch (e) {
        console.warn('FocusGuard: rejected DNR rule', r, e);
      }
    }
  }
  lastDnrJson = json;
}

let lastHideJson = '';

async function writeHideIndex(entries: ActiveEntry[]): Promise<void> {
  const hide = entries
    .filter((e) => e.kind === 'hide')
    .map((e) => ({ targets: e.targets, priorities: e.targets.map((t) => entryPriority(e, t)), selectors: e.selectors ?? [] }));
  const allow = entries
    .filter((e) => e.kind === 'allow')
    .map((e) => ({ targets: e.targets, priorities: e.targets.map((t) => entryPriority(e, t)) }));
  const json = JSON.stringify({ hide, allow });
  if (json === lastHideJson) return;
  const got = await chrome.storage.local.get('hideIndex');
  const prev = got.hideIndex as HideIndex | undefined;
  if (prev && JSON.stringify({ hide: prev.hide, allow: prev.allow }) === json) {
    lastHideJson = json;
    return;
  }
  const index: HideIndex = { rev: (prev?.rev ?? 0) + 1, hide, allow };
  await chrome.storage.local.set({ hideIndex: index });
  lastHideJson = json;
}

/** Send every open tab on a now-blocked URL to the block page or redirect (FR-2.3, UC-4). */
async function sweepTabs(entries: ActiveEntry[], config: Config, rt: Runtime): Promise<void> {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined || !isSupportedUrl(tab.url)) continue;
    const target = parentalUrl(tab.url!, config, rt) ?? enforcementUrl(decideUrl(tab.url!, entries), entries);
    if (target) await chrome.tabs.update(tab.id, { url: target }).catch(() => undefined);
  }
}

export async function updateBadges(es: EngineState, entries: ActiveEntry[]): Promise<void> {
  const { runtime, now, config } = es;
  const ph = runtime.focus ? currentPhase(runtime.focus, now) : null;
  const locks = activeLocks(runtime, now);
  if (ph) {
    const min = Math.max(1, Math.ceil((ph.endsAt - now) / 60_000));
    await setGlobalBadge({ text: `${min}m`, color: ph.kind === 'work' ? 'focus' : 'break', title: `${phaseLabel(ph.kind)}: ${min} min left` });
  } else if (locks.length) {
    const end = Math.max(...locks.map((l) => l.endsAt));
    await setGlobalBadge({ text: 'LOCK', color: 'lock', title: `Hard Lock until ${new Date(end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` });
  } else if (isPaused(runtime, now)) {
    await setGlobalBadge({ text: 'OFF', color: 'pause', title: 'Paused' });
  } else {
    await setGlobalBadge(null);
  }
  const active = await chrome.tabs.query({ active: true });
  for (const tab of active) {
    if (tab.id === undefined) continue;
    let remaining: number | null = null;
    if (isSupportedUrl(tab.url)) {
      for (const id of decideUrl(tab.url!, entries).budgetRuleIds) {
        const rule = config.rules.find((r) => r.id === id);
        if (!rule) continue;
        const left = budgetLimitSec(rule) - budgetUsed(rule, es);
        remaining = remaining === null ? left : Math.min(remaining, left);
      }
    }
    await setTabBadge(tab.id, remaining);
  }
}

function scheduleNext(es: EngineState): void {
  const times = [nextChangeTime(es), nextLockScheduleStart(es.config, es.now)].filter((t): t is number => t !== null);
  if (!times.length) {
    void chrome.alarms.clear('recompute');
    return;
  }
  // Chrome fires alarms no sooner than 30 s out; the 1-minute tick covers the gap.
  const when = Math.max(Math.min(...times) + 500, es.now + 30_000);
  void chrome.alarms.create('recompute', { when });
}

/** Write each budget rule's limit and use into today's stats, for "time saved" (FR-8.3). */
export async function recordBudgetsForInsights(config: Config, rt: Runtime): Promise<void> {
  const rules = config.rules.filter((r) => r.enabled && !r.allow && r.action.kind === 'budget');
  if (!rules.length) return;
  await updateStats((stats) => {
    const day = dayRecord(stats, rt.budget.period);
    for (const r of rules) {
      day.budgets[r.id] = { name: r.name || 'Budget', limit: budgetLimitSec(r), used: rt.budget.used[r.id] ?? 0 };
    }
  });
}

// ---- Parental mode plumbing ----

const PARENTAL_SCRIPT_ID = 'fg-parental';
let lastParentalJson = '';

async function syncParental(config: Config): Promise<void> {
  const p = config.parental;
  // Content script, registered only while needed so normal browsing pays nothing.
  const want = needsParentalScript(p);
  const have = (await chrome.scripting.getRegisteredContentScripts({ ids: [PARENTAL_SCRIPT_ID] })).length > 0;
  if (want && !have) {
    await chrome.scripting.registerContentScripts([
      { id: PARENTAL_SCRIPT_ID, js: ['parental.js'], matches: ['http://*/*', 'https://*/*'], runAt: 'document_start', allFrames: false, persistAcrossSessions: true },
    ]);
    // Tabs already open get it too.
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    await Promise.all(
      tabs.map((t) => (t.id === undefined || !isSupportedUrl(t.url) ? undefined : chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['parental.js'] }).catch(() => undefined))),
    );
  } else if (!want && have) {
    await chrome.scripting.unregisterContentScripts({ ids: [PARENTAL_SCRIPT_ID] });
  }
  // Index for the content script.
  const json = JSON.stringify(parentalIndexOf(p, 0));
  if (json !== lastParentalJson) {
    const got = await chrome.storage.local.get('parentalIndex');
    const prevRev = (got.parentalIndex as { rev?: number } | undefined)?.rev ?? 0;
    const prevJson = got.parentalIndex ? JSON.stringify({ ...(got.parentalIndex as object), rev: 0 }) : '';
    if (prevJson !== json) await chrome.storage.local.set({ parentalIndex: parentalIndexOf(p, prevRev + 1) });
    lastParentalJson = json;
  }
  await syncOffscreen(p.enabled && p.scanImages);
}

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  return contexts.length > 0;
}

let creatingOffscreen: Promise<void> | null = null;

/** Create or close the offscreen document that runs the image classifier. */
export async function syncOffscreen(on: boolean): Promise<void> {
  const has = await hasOffscreen();
  if (on && !has) {
    creatingOffscreen ??= chrome.offscreen
      .createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.WORKERS], justification: 'Run the on-device image classifier for parental controls' })
      .catch((err) => console.warn('FocusGuard: offscreen document failed', err))
      .finally(() => {
        creatingOffscreen = null;
      });
    await creatingOffscreen;
  } else if (!on && has) {
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }
}

/** Must be called inside withLock(). */
export async function recomputeLocked(): Promise<ActiveEntry[]> {
  const st = await getState();
  const now = Date.now();
  await housekeeping(st.config, st.runtime, now);
  const es = engineState(st.config, st.runtime, now);
  const entries = computeActive(es, await getPresets());
  const userRules = compileDnr(entries);
  await applyDnr([...userRules, ...compileParentalDnr(st.config.parental, st.runtime.parentalDetected, KNOWN_ADULT_SITES, userRules.length + 1)]);
  await writeHideIndex(entries);
  await syncParental(st.config).catch((err) => console.warn('FocusGuard: parental sync failed', err));
  await sweepTabs(entries, st.config, st.runtime);
  await updateBadges(es, entries);
  scheduleNext(es);
  await save({ runtime: true });
  return entries;
}

export function recompute(): Promise<ActiveEntry[]> {
  return withLock(recomputeLocked);
}

/** Active entries for read-only questions (no side effects). */
export async function currentEntries(now = Date.now()): Promise<{ es: EngineState; entries: ActiveEntry[] }> {
  const st = await getState();
  const es = engineState(st.config, st.runtime, now);
  return { es, entries: computeActive(es, await getPresets()) };
}
