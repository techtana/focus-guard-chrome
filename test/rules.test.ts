import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileDnr } from '../src/shared/dnr.ts';
import { currentPhase, focusPhases, sessionEndsAt } from '../src/shared/focus.ts';
import { computeActive, decideUrl, nextChangeTime, ruleUnblockAt } from '../src/shared/rules.ts';
import type { FocusSession, PresetFile } from '../src/shared/types.ts';
import { at, MONDAY_10, rule, state } from './helpers.ts';

const decide = (url: string, st: ReturnType<typeof state>, presets: PresetFile | null = null) =>
  decideUrl(url, computeActive(st, presets));

test('UC-1: block a whole site', () => {
  const st = state([rule(['reddit.com'])]);
  assert.equal(decide('https://www.reddit.com/r/all', st).action, 'block');
  assert.equal(decide('https://example.com/', st).action, 'none');
});

test('FR-1.5: allow overrides a less specific block', () => {
  const st = state([rule(['youtube.com']), rule(['youtube.com/watch'], { kind: 'block' }, { allow: true })]);
  assert.equal(decide('https://www.youtube.com/watch?v=1', st).action, 'allow');
  assert.equal(decide('https://www.youtube.com/', st).action, 'block');
});

test('FR-1.6: most restrictive wins at equal specificity, allow loses to equal block', () => {
  const st = state([
    rule(['x.com'], { kind: 'redirect', url: 'https://example.org/' }),
    rule(['x.com']),
    rule(['x.com'], { kind: 'block' }, { allow: true }),
  ]);
  assert.equal(decide('https://x.com/home', st).action, 'block');
});

test('schedules and disabled rules', () => {
  const sched = { days: [1, 2, 3, 4, 5], windows: [{ start: '09:00', end: '12:00' }] };
  const st = state([rule(['news.com'], { kind: 'block' }, { schedule: sched }), rule(['tv.com'], { kind: 'block' }, { enabled: false })]);
  assert.equal(decide('https://news.com/', st).action, 'block');
  assert.equal(decide('https://news.com/', { ...st, now: at(2026, 11, 9, 13) }).action, 'none');
  assert.equal(decide('https://tv.com/', st).action, 'none');
});

test('UC-2: budget counts until exhausted, then blocks until reset', () => {
  const r = rule(['reddit.com'], { kind: 'budget', minutesPerDay: 20 });
  const st = state([r]);
  let d = decide('https://reddit.com/', st);
  assert.equal(d.action, 'none');
  assert.deepEqual(d.budgetRuleIds, [r.id]);
  st.runtime.budget.used[r.id] = 20 * 60;
  d = decide('https://reddit.com/', st);
  assert.equal(d.action, 'block');
  assert.equal(d.entry?.cause, 'budget');
  assert.equal(ruleUnblockAt(r.id, st), at(2026, 11, 10, 0, 0));
  // A stale period counts as zero use.
  st.runtime.budget.period = '2026-11-08';
  assert.equal(decide('https://reddit.com/', st).action, 'none');
});

test('allow exempts a more specific path from a budget', () => {
  const b = rule(['youtube.com'], { kind: 'budget', minutesPerDay: 10 });
  const st = state([b, rule(['youtube.com/watch'], { kind: 'block' }, { allow: true })]);
  assert.deepEqual(decide('https://youtube.com/watch?v=1', st).budgetRuleIds, []);
  assert.deepEqual(decide('https://youtube.com/feed', st).budgetRuleIds, [b.id]);
});

test('UC-3: hide selectors from presets and custom, scoped by allow', () => {
  const presets: PresetFile = {
    version: 1,
    updated: '',
    presets: [{ id: 'youtube', name: 'YouTube', sites: ['youtube.com'], options: [
      { id: 'shorts', label: 'Shorts', selectors: ['ytd-reel-shelf-renderer'] },
      { id: 'comments', label: 'Comments', selectors: ['#comments'] },
    ] }],
  };
  const st = state([rule(['youtube.com'], { kind: 'hide', selectors: ['#secondary'], presetId: 'youtube', presetOptions: ['shorts'] })]);
  const d = decide('https://www.youtube.com/watch?v=1', st, presets);
  assert.deepEqual(d.selectors.sort(), ['#secondary', 'ytd-reel-shelf-renderer']);
  assert.equal(d.action, 'none');
});

test('UC-4: focus list is blocked during work intervals only', () => {
  const r = rule(['instagram.com'], { kind: 'block' }, { onlyDuringFocus: true });
  const session: FocusSession = { workMin: 25, breakMin: 5, longBreakMin: 15, cycles: 4, ruleIds: [r.id], startedAt: MONDAY_10 };
  const st = state([r], MONDAY_10 + 60_000, { runtime: { focus: session } });
  assert.equal(decide('https://instagram.com/', st).action, 'block');
  assert.equal(decide('https://instagram.com/', { ...st, now: MONDAY_10 + 26 * 60_000 }).action, 'none'); // break
  assert.equal(decide('https://instagram.com/', { ...st, now: MONDAY_10 + 31 * 60_000 }).action, 'block'); // work 2
  assert.equal(decide('https://instagram.com/', state([r])).action, 'none'); // no session
  assert.equal(ruleUnblockAt(r.id, st), MONDAY_10 + 25 * 60_000);
});

test('focus phases: 25/5/15/4', () => {
  const s: FocusSession = { workMin: 25, breakMin: 5, longBreakMin: 15, cycles: 4, ruleIds: [], startedAt: 0 };
  const ph = focusPhases(s);
  assert.deepEqual(ph.map((p) => p.kind), ['work', 'break', 'work', 'break', 'work', 'break', 'work', 'longBreak']);
  assert.equal(sessionEndsAt(s), (4 * 25 + 3 * 5 + 15) * 60_000);
  assert.equal(currentPhase(s, 100 * 60_000 + 1)?.kind, 'work'); // 4th work starts at 90
  assert.equal(currentPhase(s, sessionEndsAt(s)), null);
});

test('UC-5: Hard Lock forces rules on and beats allow rules and pause', () => {
  const blockRule = rule(['reddit.com'], { kind: 'block' }, { enabled: false });
  const allow = rule(['reddit.com/r/work'], { kind: 'block' }, { allow: true });
  const budget = rule(['x.com'], { kind: 'budget', minutesPerDay: 30 });
  const st = state([blockRule, allow, budget], MONDAY_10, {
    runtime: {
      locks: [{ id: 'L', ruleIds: [blockRule.id, budget.id], targets: [{ kind: 'domain', host: 'news.com', includeSubdomains: true }], startedAt: MONDAY_10 - 1, endsAt: MONDAY_10 + 3600_000 }],
      pausedUntil: MONDAY_10 + 7200_000,
    },
  });
  assert.equal(decide('https://reddit.com/', st).action, 'block');
  assert.equal(decide('https://reddit.com/r/work', st).action, 'block'); // unlocked allow cannot punch through
  assert.equal(decide('https://x.com/', st).action, 'block'); // locked budget = block
  assert.equal(decide('https://news.com/', st).action, 'block');
  assert.equal(decide('https://news.com/', { ...st, now: MONDAY_10 + 3600_000 }).action, 'none'); // lock over, still paused
  assert.equal(ruleUnblockAt('lock:L', st), MONDAY_10 + 3600_000);
});

test('pause turns off normal rules', () => {
  const st = state([rule(['reddit.com'])], MONDAY_10, { runtime: { pausedUntil: MONDAY_10 + 60_000 } });
  assert.equal(decide('https://reddit.com/', st).action, 'none');
});

test('compileDnr: one rule per target, block page carries only rule id + index', () => {
  const r = rule(['reddit.com', 'x.com']);
  const dnr = compileDnr(computeActive(state([r]), null));
  assert.equal(dnr.length, 2);
  assert.deepEqual(dnr[1].action, { type: 'redirect', redirect: { extensionPath: `/blocked.html?r=${r.id}&t=1` } });
  assert.deepEqual(dnr[0].condition, { requestDomains: ['reddit.com'], resourceTypes: ['main_frame'] });
  assert.equal(new Set(dnr.map((d) => d.id)).size, 2);
});

test('FR-7.3: redirect loops fall back to the block page; allow compiles to allow', () => {
  const loop = rule(['instagram.com'], { kind: 'redirect', url: 'https://reddit.com/' });
  const st = state([loop, rule(['reddit.com']), rule(['reddit.com/r/work'], { kind: 'block' }, { allow: true })]);
  const dnr = compileDnr(computeActive(st, null));
  assert.deepEqual(dnr[0].action, { type: 'redirect', redirect: { extensionPath: `/blocked.html?r=${loop.id}&t=0` } });
  assert.equal(dnr[2].action.type, 'allow');
  assert.ok(dnr[2].priority > dnr[1].priority);
  const ok = rule(['instagram.com'], { kind: 'redirect', url: 'https://portal.example.edu/' });
  assert.deepEqual(compileDnr(computeActive(state([ok]), null))[0].action, { type: 'redirect', redirect: { url: 'https://portal.example.edu/' } });
});

test('nextChangeTime picks the soonest event', () => {
  const sched = { days: [1], windows: [{ start: '09:00', end: '11:00' }] };
  const st = state([rule(['a.com'], { kind: 'block' }, { schedule: sched })]);
  assert.equal(nextChangeTime(st), at(2026, 11, 9, 11, 0));
});
