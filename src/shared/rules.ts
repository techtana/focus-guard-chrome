// Rule evaluation (PRD "Rule evaluation" steps 1 and 2, FR-1.5, FR-1.6).
//
// computeActive() turns config + runtime into the set of rules in force now.
// decideUrl() answers "what happens to this URL" exactly the way the compiled
// declarativeNetRequest rules do, using the same priorities:
//
//   priority = band * 100000 + specificity * 10 + rank
//   band: 1 for rules forced on by a Hard Lock, 0 otherwise
//   rank: block 4, redirect 3, hide 2, allow 0
//
// So an allow rule beats any less specific block/redirect/hide in its band
// (FR-1.5), the most restrictive action wins at equal specificity (FR-1.6),
// and nothing outside a Hard Lock can punch a hole in it.

import { isWorkInterval, currentPhase } from './focus.ts';
import { budgetPeriodKey, nextBudgetReset, nextScheduleChange, scheduleActiveAt } from './schedule.ts';
import type { Config, HardLock, PlainTarget, PresetFile, Rule, Runtime } from './types.ts';
import { expandTargets, matchTarget, parseHttpUrl, specificity } from './url.ts';

export interface EngineState {
  config: Config;
  runtime: Runtime;
  now: number;
}

/** What an active entry does to matching URLs. `budget` = still counting (not yet exhausted). */
export type EntryKind = 'block' | 'redirect' | 'hide' | 'allow' | 'budget';

export interface ActiveEntry {
  /** Rule id, or `lock:<lockId>` for a Hard Lock's own sites. */
  ruleId: string;
  name: string;
  kind: EntryKind;
  /** Why it is a block: 'budget' when a budget ran out. */
  cause: 'rule' | 'budget' | 'lock';
  locked: boolean;
  targets: PlainTarget[];
  redirectUrl?: string;
  selectors?: string[];
  /** For budget entries (exhausted or not): the rule's limit in seconds. */
  budgetLimitSec?: number;
}

export const RANK: Record<EntryKind, number> = { block: 4, redirect: 3, hide: 2, budget: 1, allow: 0 };

export function entryPriority(e: Pick<ActiveEntry, 'kind' | 'locked'>, t: PlainTarget): number {
  return (e.locked ? 100_000 : 0) + specificity(t) * 10 + RANK[e.kind];
}

export function activeLocks(rt: Runtime, now: number): HardLock[] {
  return rt.locks.filter((l) => l.startedAt <= now && now < l.endsAt);
}

export function isPaused(rt: Runtime, now: number): boolean {
  return rt.pausedUntil !== null && now < rt.pausedUntil;
}

export function lockedRuleIds(rt: Runtime, now: number): Set<string> {
  const s = new Set<string>();
  for (const l of activeLocks(rt, now)) for (const id of l.ruleIds) s.add(id);
  return s;
}

/** Latest end time among active locks, or null. */
export function lockEndsAt(rt: Runtime, now: number): number | null {
  const ends = activeLocks(rt, now).map((l) => l.endsAt);
  return ends.length ? Math.max(...ends) : null;
}

/** Enabled, schedule matches now, and its focus condition holds. Ignores locks and pause. */
export function ruleNormallyActive(rule: Rule, st: EngineState): boolean {
  if (!rule.enabled) return false;
  if (!scheduleActiveAt(rule.schedule, st.now)) return false;
  if (rule.onlyDuringFocus && !isWorkInterval(st.runtime.focus, st.now)) return false;
  return true;
}

/** Seconds used of a budget rule in the current period (0 when the stored period is stale). */
export function budgetUsed(rule: Rule, st: EngineState): number {
  const b = st.runtime.budget;
  if (b.period !== budgetPeriodKey(st.now, st.config.settings.resetTime)) return 0;
  return b.used[rule.id] ?? 0;
}

export function budgetLimitSec(rule: Rule): number {
  return rule.action.kind === 'budget' ? Math.round(rule.action.minutesPerDay * 60) : 0;
}

export function isBudgetExhausted(rule: Rule, st: EngineState): boolean {
  return rule.action.kind === 'budget' && budgetUsed(rule, st) >= budgetLimitSec(rule);
}

/** Selectors of a hide action, custom + chosen preset options. */
export function resolveSelectors(rule: Rule, presets: PresetFile | null): string[] {
  if (rule.action.kind !== 'hide') return [];
  const out = [...rule.action.selectors];
  const { presetId, presetOptions } = rule.action;
  if (presetId && presets) {
    const p = presets.presets.find((x) => x.id === presetId);
    if (p) for (const o of p.options) if (!presetOptions || presetOptions.includes(o.id)) out.push(...o.selectors);
  }
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))];
}

function entryFromRule(rule: Rule, st: EngineState, locked: boolean, presets: PresetFile | null): ActiveEntry | null {
  const targets = expandTargets(rule.targets, st.config.groups);
  if (targets.length === 0) return null;
  const base = { ruleId: rule.id, name: rule.name || 'Rule', locked, targets };
  if (rule.allow) return { ...base, kind: 'allow', cause: 'rule' };
  const a = rule.action;
  switch (a.kind) {
    case 'block':
      return { ...base, kind: 'block', cause: locked ? 'lock' : 'rule' };
    case 'redirect':
      return { ...base, kind: 'redirect', cause: locked ? 'lock' : 'rule', redirectUrl: a.url };
    case 'hide': {
      const selectors = resolveSelectors(rule, presets);
      return selectors.length ? { ...base, kind: 'hide', cause: 'rule', selectors } : null;
    }
    case 'budget': {
      const budgetLimit = budgetLimitSec(rule);
      // A Hard Lock turns a budget rule into a plain block (FR-3, "non-cancelable block").
      if (locked) return { ...base, kind: 'block', cause: 'lock', budgetLimitSec: budgetLimit };
      return isBudgetExhausted(rule, st)
        ? { ...base, kind: 'block', cause: 'budget', budgetLimitSec: budgetLimit }
        : { ...base, kind: 'budget', cause: 'rule', budgetLimitSec: budgetLimit };
    }
  }
}

/** All entries in force now. */
export function computeActive(st: EngineState, presets: PresetFile | null): ActiveEntry[] {
  const { config, runtime, now } = st;
  const locks = activeLocks(runtime, now);
  const locked = lockedRuleIds(runtime, now);
  const paused = isPaused(runtime, now);
  const out: ActiveEntry[] = [];
  for (const rule of config.rules) {
    const isLocked = locked.has(rule.id);
    if (!isLocked && (paused || !ruleNormallyActive(rule, st))) continue;
    const e = entryFromRule(rule, st, isLocked, presets);
    if (e) out.push(e);
  }
  for (const l of locks) {
    const targets = expandTargets(l.targets, config.groups);
    if (targets.length) out.push({ ruleId: `lock:${l.id}`, name: 'Hard Lock', kind: 'block', cause: 'lock', locked: true, targets });
  }
  return out;
}

export interface Decision {
  /** Navigation outcome. */
  action: 'none' | 'allow' | 'block' | 'redirect';
  /** The entry that decided the navigation (block/redirect/allow). */
  entry?: ActiveEntry;
  /** Index into entry.targets of the matching target. */
  targetIndex: number;
  redirectUrl?: string;
  /** CSS selectors to hide on this URL. */
  selectors: string[];
  /** Ids of hide rules that apply. */
  hideRuleIds: string[];
  /** Budget rules (not yet exhausted) that this URL's time counts against. */
  budgetRuleIds: string[];
}

const NAV_KINDS: EntryKind[] = ['block', 'redirect', 'allow'];

/** Best matching priority of an entry for a URL, or -1. */
function bestMatch(e: ActiveEntry, u: URL): { p: number; i: number } {
  let best = { p: -1, i: -1 };
  e.targets.forEach((t, i) => {
    if (matchTarget(t, u)) {
      const p = entryPriority(e, t);
      if (p > best.p) best = { p, i };
    }
  });
  return best;
}

export function decideUrl(url: string, entries: ActiveEntry[]): Decision {
  const d: Decision = { action: 'none', targetIndex: -1, selectors: [], hideRuleIds: [], budgetRuleIds: [] };
  const u = parseHttpUrl(url);
  if (!u) return d;
  let navP = -1;
  let allowP = -1;
  const matched: { e: ActiveEntry; p: number; i: number }[] = [];
  for (const e of entries) {
    const m = bestMatch(e, u);
    if (m.p < 0) continue;
    matched.push({ e, ...m });
    if (e.kind === 'allow') allowP = Math.max(allowP, m.p);
    if (NAV_KINDS.includes(e.kind) && m.p > navP) {
      navP = m.p;
      d.entry = e;
      d.targetIndex = m.i;
    }
  }
  if (d.entry) {
    d.action = d.entry.kind === 'allow' ? 'allow' : (d.entry.kind as 'block' | 'redirect');
    if (d.entry.kind === 'redirect') d.redirectUrl = d.entry.redirectUrl;
  }
  for (const m of matched) {
    if (m.p <= allowP) continue;
    if (m.e.kind === 'hide') {
      d.selectors.push(...(m.e.selectors ?? []));
      d.hideRuleIds.push(m.e.ruleId);
    } else if (m.e.kind === 'budget') {
      d.budgetRuleIds.push(m.e.ruleId);
    }
  }
  d.selectors = [...new Set(d.selectors)];
  return d;
}

/**
 * When does a rule stop applying (for "time until unblock", FR-7.1)?
 * Returns null when it has no foreseeable end.
 */
export function ruleUnblockAt(ruleId: string, st: EngineState): number | null {
  const { runtime, now, config } = st;
  if (ruleId.startsWith('lock:')) {
    const l = runtime.locks.find((x) => `lock:${x.id}` === ruleId);
    return l ? l.endsAt : null;
  }
  const rule = config.rules.find((r) => r.id === ruleId);
  if (!rule) return null;
  const lockEnd = activeLocks(runtime, now)
    .filter((l) => l.ruleIds.includes(ruleId))
    .reduce<number | null>((m, l) => (m === null ? l.endsAt : Math.max(m, l.endsAt)), null);
  const t = lockEnd ?? now;
  const at: EngineState = { ...st, now: t };
  if (!ruleNormallyActive(rule, at) || (isPaused(runtime, t) && !lockEnd)) return lockEnd;
  if (rule.action.kind === 'budget' && !rule.allow) {
    if (!isBudgetExhausted(rule, at)) return lockEnd;
    const reset = nextBudgetReset(t, config.settings.resetTime);
    const sched = nextScheduleChange(rule.schedule, t);
    return sched !== null && sched < reset ? sched : reset;
  }
  const ends: number[] = [];
  const sched = nextScheduleChange(rule.schedule, t);
  if (sched !== null) ends.push(sched);
  if (rule.onlyDuringFocus && runtime.focus) {
    const ph = currentPhase(runtime.focus, t);
    if (ph) ends.push(ph.endsAt);
  }
  return ends.length ? Math.min(...ends) : null;
}

/**
 * The next time anything time-based may change the active set: a schedule
 * edge, a focus phase change, a lock start or end, pause end, or budget reset.
 */
export function nextChangeTime(st: EngineState): number | null {
  const { config, runtime, now } = st;
  const times: number[] = [];
  for (const r of config.rules) {
    const t = nextScheduleChange(r.schedule, now);
    if (t !== null) times.push(t);
  }
  if (runtime.focus) {
    const ph = currentPhase(runtime.focus, now);
    if (ph) times.push(ph.endsAt);
  }
  for (const l of runtime.locks) {
    if (l.startedAt > now) times.push(l.startedAt);
    if (l.endsAt > now) times.push(l.endsAt);
  }
  if (runtime.pausedUntil !== null && runtime.pausedUntil > now) times.push(runtime.pausedUntil);
  times.push(nextBudgetReset(now, config.settings.resetTime));
  const future = times.filter((t) => t > now);
  return future.length ? Math.min(...future) : null;
}
