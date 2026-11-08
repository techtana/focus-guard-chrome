// Every edit the UI can make, and its classification as tightening or
// loosening (FR-3.2, FR-3.4, FR-4.3, UC-6, PRD "Rule evaluation" step 5).
// The service worker runs classifyChange() before applying anything, so the
// gate cannot be skipped by a UI page.

import { activeLocks, lockedRuleIds } from './rules.ts';
import { coverageSubset, scheduleCoverage } from './schedule.ts';
import type {
  Category,
  CommitmentLevel,
  Config,
  FocusConfig,
  Group,
  LockSchedule,
  ParentalConfig,
  Rule,
  Runtime,
  Settings,
  Target,
} from './types.ts';
import { targetKey } from './url.ts';

export type SettingsPatch = Partial<Omit<Settings, 'commitment' | 'passwordHash'>>;
export type ParentalPatch = Partial<Omit<ParentalConfig, 'enabled' | 'pinHash'>>;

export type Change =
  | { kind: 'rule.upsert'; rule: Rule }
  | { kind: 'rule.delete'; id: string }
  | { kind: 'rule.setEnabled'; id: string; enabled: boolean }
  /** Add several rules (and groups) at once: onboarding templates, "block this site". */
  | { kind: 'rules.add'; rules: Rule[]; groups?: Group[] }
  | { kind: 'group.upsert'; group: Group }
  | { kind: 'group.delete'; id: string }
  | { kind: 'settings.update'; patch: SettingsPatch }
  /** `newPassword` is required when moving to 'password' or changing the password. */
  | { kind: 'commitment.set'; level: CommitmentLevel; newPassword?: string }
  | { kind: 'focus.config'; config: FocusConfig }
  /** Starts a session with the saved focus config (or `config` if given). */
  | { kind: 'focus.start'; config?: FocusConfig }
  | { kind: 'focus.stop' }
  /** durationMin 15..1440 (FR-3.1). */
  | { kind: 'lock.start'; durationMin: number; ruleIds: string[]; targets: Target[] }
  | { kind: 'lock.extend'; lockId: string; minutes: number }
  | { kind: 'lock.add'; lockId: string; ruleIds: string[]; targets: Target[] }
  | { kind: 'lockSchedule.upsert'; schedule: LockSchedule }
  | { kind: 'lockSchedule.delete'; id: string }
  /** `image`: a data: URL (max 2 MB), null to remove, undefined to keep. */
  | { kind: 'blockPage.update'; message?: string; image?: string | null }
  /** minutes > 0 pauses all non-locked rules; null resumes. */
  | { kind: 'pause'; minutes: number | null }
  | { kind: 'categories.set'; overrides: Record<string, Category> }
  | { kind: 'onboarding.done' }
  // ---- Parental controls: all need the guardian PIN once parental mode is on ----
  /** Turn parental mode on. `pin` (min 4 characters) is required the first time, when no PIN is set. */
  | { kind: 'parental.enable'; pin?: string; patch?: ParentalPatch }
  | { kind: 'parental.disable' }
  | { kind: 'parental.update'; patch: ParentalPatch }
  | { kind: 'parental.setPin'; newPin: string }
  /** Add a host to allowedSites and forget any detection of it (e.g. from the block page). */
  | { kind: 'parental.allowSite'; host: string }
  /** Forget a learned site, or all learned sites when host is null. */
  | { kind: 'parental.forget'; host: string | null };

export type ChangeKind = Change['kind'];

export interface Classification {
  /** Needs the commitment gate (password / challenge) when the level is not 'none'. */
  loosening: boolean;
  /** Refused outright because a Hard Lock covers it. */
  lockConflict: string | null;
  /** Refused outright for another reason (FR-6.4: no early end under Challenge). */
  forbidden: string | null;
  /** Needs the guardian PIN (parental mode is on and a PIN is set). Independent of `loosening`. */
  guardian: boolean;
}

const LEVEL_RANK: Record<CommitmentLevel, number> = { none: 0, password: 1, challenge: 2 };
const ACTION_RANK = { block: 4, redirect: 3, budget: 2, hide: 1 } as const;

function keys(ts: Target[]): Set<string> {
  return new Set(ts.map(targetKey));
}
function subset<T>(a: Set<T> | T[], b: Set<T> | T[]): boolean {
  const bs = b instanceof Set ? b : new Set(b);
  for (const x of a) if (!bs.has(x)) return false;
  return true;
}

/** Is replacing `old` with `next` a loosening change? */
export function isRuleLoosening(old: Rule | undefined, next: Rule): boolean {
  if (!old) return !!next.allow && next.enabled;
  if (old.allow) {
    if (!next.allow) return false; // allow -> block/hide/... is tighter
    if (!next.enabled) return false;
    if (!old.enabled) return true;
    const narrower =
      subset(keys(next.targets), keys(old.targets)) &&
      coverageSubset(scheduleCoverage(next.schedule), scheduleCoverage(old.schedule)) &&
      (!old.onlyDuringFocus || !!next.onlyDuringFocus);
    return !narrower;
  }
  if (next.allow) return next.enabled;
  if (!old.enabled) return false;
  if (!next.enabled) return true;
  if (!subset(keys(old.targets), keys(next.targets))) return true;
  if (!coverageSubset(scheduleCoverage(old.schedule), scheduleCoverage(next.schedule))) return true;
  if (!old.onlyDuringFocus && next.onlyDuringFocus) return true;
  const a = old.action;
  const b = next.action;
  if (ACTION_RANK[b.kind] < ACTION_RANK[a.kind]) return true;
  if (a.kind === 'budget' && b.kind === 'budget' && b.minutesPerDay > a.minutesPerDay) return true;
  if (a.kind === 'hide' && b.kind === 'hide') {
    if (!subset(a.selectors, b.selectors)) return true;
    if (a.presetId && a.presetId !== b.presetId) return true;
    if (a.presetId && b.presetOptions && (!a.presetOptions || !subset(a.presetOptions, b.presetOptions))) return true;
  }
  return false;
}

/** Does a rule "do something" that removing it would loosen? */
function ruleRestricts(r: Rule | undefined): boolean {
  return !!r && r.enabled && !r.allow;
}

function rulesUsingGroup(config: Config, groupId: string): Rule[] {
  return config.rules.filter((r) => r.targets.some((t) => t.kind === 'group' && t.groupId === groupId));
}

export function isLockScheduleLoosening(old: LockSchedule | undefined, next: LockSchedule): boolean {
  if (!old || !old.enabled) return false;
  if (!next.enabled) return true;
  return !(
    subset(old.days, next.days) &&
    old.start === next.start &&
    next.durationMin >= old.durationMin &&
    subset(old.ruleIds, next.ruleIds) &&
    subset(keys(old.targets), keys(next.targets))
  );
}

export function isSettingsLoosening(old: Settings, patch: SettingsPatch): boolean {
  if (patch.resetTime !== undefined && patch.resetTime !== old.resetTime) return true;
  if (patch.idleSeconds !== undefined && patch.idleSeconds < old.idleSeconds) return true;
  if (patch.challengeLength !== undefined && patch.challengeLength < old.challengeLength) return true;
  if (patch.challengeDelayMin !== undefined && patch.challengeDelayMin < old.challengeDelayMin) return true;
  if (patch.uninstallUrl !== undefined && old.uninstallUrl && patch.uninstallUrl !== old.uninstallUrl) return true;
  return false;
}

export function classifyChange(change: Change, config: Config, runtime: Runtime, now: number): Classification {
  const locks = activeLocks(runtime, now);
  const locked = lockedRuleIds(runtime, now);
  const lockActive = locks.length > 0;
  const res: Classification = { loosening: false, lockConflict: null, forbidden: null, guardian: false };
  if (change.kind.startsWith('parental.')) {
    // Parental settings are the guardian's: the user's own commitment level and Hard Locks do not apply.
    res.guardian = config.parental.enabled && !!config.parental.pinHash;
    return res;
  }
  const LOCK_MSG = 'A Hard Lock is active. You can tighten rules, but not loosen them, until it ends.';
  const conflictIf = (cond: boolean) => {
    if (res.loosening && cond) res.lockConflict = LOCK_MSG;
  };
  const groupLocked = (groupId: string) =>
    rulesUsingGroup(config, groupId).some((r) => locked.has(r.id)) ||
    locks.some((l) => l.targets.some((t) => t.kind === 'group' && t.groupId === groupId));

  switch (change.kind) {
    case 'rule.upsert': {
      const old = config.rules.find((r) => r.id === change.rule.id);
      res.loosening = isRuleLoosening(old, change.rule);
      conflictIf(locked.has(change.rule.id));
      break;
    }
    case 'rule.delete': {
      const old = config.rules.find((r) => r.id === change.id);
      res.loosening = ruleRestricts(old);
      conflictIf(locked.has(change.id));
      if (locked.has(change.id)) res.lockConflict = LOCK_MSG; // a locked rule cannot be deleted at all
      break;
    }
    case 'rule.setEnabled': {
      const old = config.rules.find((r) => r.id === change.id);
      if (old) res.loosening = isRuleLoosening(old, { ...old, enabled: change.enabled });
      conflictIf(locked.has(change.id));
      break;
    }
    case 'rules.add':
      res.loosening = change.rules.some((r) => r.allow && r.enabled);
      break;
    case 'group.upsert': {
      const old = config.groups.find((g) => g.id === change.group.id);
      if (old) {
        const users = rulesUsingGroup(config, old.id);
        const removed = !subset(keys(old.targets), keys(change.group.targets));
        const added = !subset(keys(change.group.targets), keys(old.targets));
        res.loosening =
          (removed && users.some((r) => ruleRestricts(r))) || (added && users.some((r) => r.allow && r.enabled));
        conflictIf(groupLocked(old.id));
      }
      break;
    }
    case 'group.delete':
      res.loosening = rulesUsingGroup(config, change.id).some((r) => ruleRestricts(r));
      conflictIf(groupLocked(change.id));
      break;
    case 'settings.update':
      res.loosening = isSettingsLoosening(config.settings, change.patch);
      conflictIf(lockActive);
      break;
    case 'commitment.set': {
      const cur = config.settings.commitment;
      res.loosening =
        LEVEL_RANK[change.level] < LEVEL_RANK[cur] || (change.level === 'password' && cur === 'password');
      // Open question 4, decided: a Hard Lock also freezes the commitment level.
      conflictIf(lockActive);
      break;
    }
    case 'focus.start':
    case 'focus.config':
    case 'lock.start':
    case 'lock.extend':
    case 'lock.add':
    case 'blockPage.update':
    case 'categories.set':
    case 'onboarding.done':
      break;
    case 'focus.stop':
      if (!runtime.focus) break;
      res.loosening = true;
      if (lockActive) res.lockConflict = 'A Hard Lock is active, so the focus session cannot end early.';
      else if (config.settings.commitment === 'challenge')
        res.forbidden = 'Your commitment level is Challenge, so focus sessions cannot end early.';
      break;
    case 'lockSchedule.upsert': {
      const old = config.lockSchedules.find((s) => s.id === change.schedule.id);
      res.loosening = isLockScheduleLoosening(old, change.schedule);
      conflictIf(locks.some((l) => l.scheduleId === change.schedule.id));
      break;
    }
    case 'lockSchedule.delete': {
      const old = config.lockSchedules.find((s) => s.id === change.id);
      res.loosening = !!old?.enabled;
      conflictIf(locks.some((l) => l.scheduleId === change.id));
      break;
    }
    case 'pause':
      res.loosening = change.minutes !== null && change.minutes > 0;
      break;
  }
  return res;
}
