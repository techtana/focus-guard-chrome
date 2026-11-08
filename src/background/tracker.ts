// Active-time tracking (FR-2.1, FR-8.1, PRD "Rule evaluation" step 4).
// Time counts only while the tab is active, its window is focused and the user
// is not idle. The open segment lives in storage.session (memory only, survives
// worker restarts, never written to disk) and is credited at every event and
// every minute. Only the domain and the matching budget rule ids are kept.

import { budgetLimitSec, decideUrl } from '../shared/rules.ts';
import { localDateKey } from '../shared/schedule.ts';
import { hostOf } from '../shared/url.ts';
import { currentEntries, isSupportedUrl, recomputeLocked, recordBudgetsForInsights, updateBadges } from './engine.ts';
import { notify } from './notify.ts';
import { dayRecord, getState, save, updateStats, withLock } from './state.ts';

interface Segment {
  tabId: number;
  domain: string;
  since: number;
  budgetRuleIds: string[];
}

interface TrackState {
  windowFocused: boolean;
  idle: 'active' | 'idle' | 'locked';
  seg: Segment | null;
}

/** Credit at most this much per segment slice: guards against sleep and missed events. */
const MAX_SLICE_MS = 120_000;

let mem: TrackState | null = null;

async function load(): Promise<TrackState> {
  if (mem) return mem;
  const got = await chrome.storage.session.get('track');
  if (got.track) {
    mem = got.track as TrackState;
  } else {
    const win = await chrome.windows.getLastFocused().catch(() => null);
    const st = await getState();
    const idle = await chrome.idle.queryState(Math.max(15, st.config.settings.idleSeconds));
    mem = { windowFocused: !!win?.focused, idle, seg: null };
  }
  return mem;
}

async function store(): Promise<void> {
  if (mem) await chrome.storage.session.set({ track: mem });
}

/** Credit the open segment up to `now`. Returns budget rule ids that crossed a threshold. Inside withLock. */
async function credit(now: number): Promise<{ exhausted: boolean }> {
  const t = await load();
  const seg = t.seg;
  if (!seg) return { exhausted: false };
  const ms = Math.min(Math.max(0, now - seg.since), MAX_SLICE_MS);
  seg.since = now;
  if (ms < 500) return { exhausted: false };
  const sec = ms / 1000;
  await updateStats((stats) => {
    const day = dayRecord(stats, localDateKey(now));
    const d = (day.domains[seg.domain] ??= { active: 0, blocked: 0 });
    d.active = Math.round((d.active + sec) * 10) / 10;
  });
  if (!seg.budgetRuleIds.length) return { exhausted: false };
  const st = await getState();
  const b = st.runtime.budget;
  let exhausted = false;
  for (const id of seg.budgetRuleIds) {
    const rule = st.config.rules.find((r) => r.id === id);
    if (!rule || rule.action.kind !== 'budget') continue;
    const limit = budgetLimitSec(rule);
    const used = (b.used[id] = Math.round(((b.used[id] ?? 0) + sec) * 10) / 10);
    const left = limit - used;
    if (left <= 120 && left > 0 && !b.warned.includes(id)) {
      b.warned.push(id);
      notify('budget', `2 minutes left: ${rule.name || seg.domain}`, `Your daily budget of ${rule.action.minutesPerDay} min is almost used up.`);
    }
    if (left <= 0) exhausted = true;
  }
  await save({ runtime: true });
  await recordBudgetsForInsights(st.config, st.runtime);
  return { exhausted };
}

let precise: ReturnType<typeof setTimeout> | undefined;

/** Re-open the segment for the currently active tab. Inside withLock. */
async function reopen(now: number): Promise<void> {
  const t = await load();
  t.seg = null;
  clearTimeout(precise);
  if (t.windowFocused && t.idle === 'active') {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id !== undefined && isSupportedUrl(tab.url)) {
      const { entries, es } = await currentEntries(now);
      const d = decideUrl(tab.url!, entries);
      t.seg = { tabId: tab.id, domain: hostOf(tab.url!)!, since: now, budgetRuleIds: d.budgetRuleIds };
      // Wake up right when the nearest budget runs out or hits the 2-minute warning.
      let soonest = Infinity;
      for (const id of d.budgetRuleIds) {
        const rule = es.config.rules.find((r) => r.id === id);
        if (!rule) continue;
        const left = budgetLimitSec(rule) - (es.runtime.budget.used[id] ?? 0);
        soonest = Math.min(soonest, left > 120 ? left - 120 : left);
      }
      if (Number.isFinite(soonest)) {
        const ms = Math.max(1000, soonest * 1000 + 300);
        precise = setTimeout(() => void flush(), ms); // precise while the worker is awake
        void chrome.alarms.create('budget', { when: Date.now() + Math.max(ms, 30_000) }); // backstop
      }
    }
  }
  await store();
}

/** Credit, re-open, and enforce if a budget ran out. */
export function flush(): Promise<void> {
  return withLock(async () => {
    const now = Date.now();
    const { exhausted } = await credit(now);
    if (exhausted) await recomputeLocked();
    await reopen(now);
  });
}

/** Something about focus/idle/tab changed. */
export function onActivity(patch: Partial<Pick<TrackState, 'windowFocused' | 'idle'>> = {}): Promise<void> {
  return withLock(async () => {
    const now = Date.now();
    const { exhausted } = await credit(now);
    const t = await load();
    Object.assign(t, patch);
    if (exhausted) await recomputeLocked();
    await reopen(now);
    const { es, entries } = await currentEntries(now);
    await updateBadges(es, entries);
  });
}
