import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  aggregate,
  budgetUnused,
  csvField,
  dailyCsv,
  dateRange,
  dayTimeSaved,
  sitesCsv,
  topSites,
} from '../src/shared/insights.ts';
import type { StatsStore } from '../src/shared/types.ts';

const stats: StatsStore = {
  '2026-11-02': {
    date: '2026-11-02',
    domains: { 'reddit.com': { active: 600, blocked: 2 }, 'github.com': { active: 3000, blocked: 0 } },
    focusSeconds: 3000,
    budgets: { r1: { name: 'Reddit', limit: 1200, used: 600 } },
  },
  '2026-11-03': {
    date: '2026-11-03',
    domains: { 'reddit.com': { active: 1500, blocked: 5 }, 'm.youtube.com': { active: 900, blocked: 1 } },
    focusSeconds: 0,
    budgets: { r1: { name: 'Reddit', limit: 1200, used: 1500 } },
  },
  '2026-10-20': {
    date: '2026-10-20',
    domains: { 'x.com': { active: 100, blocked: 0 } },
    focusSeconds: 0,
    budgets: {},
  },
};

test('date helpers cross month boundaries', () => {
  assert.equal(addDays('2026-11-01', -1), '2026-10-31');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(dateRange('2026-11-03', 3), ['2026-11-01', '2026-11-02', '2026-11-03']);
  assert.equal(dateRange('2026-11-08', 7).length, 7);
});

test('budget unused never goes negative', () => {
  assert.equal(budgetUnused(stats['2026-11-02']), 600);
  assert.equal(budgetUnused(stats['2026-11-03']), 0);
  assert.equal(budgetUnused(undefined), 0);
});

test('time saved = unused budget + blocked attempts x minutes', () => {
  assert.equal(dayTimeSaved(stats['2026-11-02'], 3), 600 + 2 * 180);
  assert.equal(dayTimeSaved(stats['2026-11-03'], 3), 6 * 180);
});

test('week aggregate sums days, sites and categories', () => {
  const a = aggregate(stats, dateRange('2026-11-03', 7), { minutesPerBlockedAttempt: 3 });
  assert.equal(a.series.length, 7);
  assert.equal(a.active, 600 + 3000 + 1500 + 900);
  assert.equal(a.focus, 3000);
  assert.equal(a.blocked, 8);
  assert.equal(a.budgetUnused, 600);
  assert.equal(a.blockedSaved, 8 * 180);
  assert.equal(a.timeSaved, 600 + 8 * 180);
  assert.deepEqual(
    a.sites.map((s) => [s.domain, s.active, s.blocked]),
    [
      ['github.com', 3000, 0],
      ['reddit.com', 2100, 7],
      ['m.youtube.com', 900, 1],
    ],
  );
  assert.deepEqual(a.categories, [
    { category: 'work', active: 3000 },
    { category: 'social', active: 2100 },
    { category: 'video', active: 900 },
  ]);
  // Out-of-range day is excluded.
  assert.ok(!a.sites.some((s) => s.domain === 'x.com'));
  // Empty days still appear in the series.
  assert.deepEqual(a.series[0], { date: '2026-10-28', active: 0, focus: 0, blocked: 0, timeSaved: 0 });
});

test('category overrides apply to aggregates', () => {
  const a = aggregate(stats, ['2026-11-03'], { minutesPerBlockedAttempt: 3, overrides: { 'youtube.com': 'work' } });
  assert.equal(a.sites.find((s) => s.domain === 'm.youtube.com')?.category, 'work');
});

test('day aggregate of a missing day is all zero', () => {
  const a = aggregate(stats, ['2026-11-05'], { minutesPerBlockedAttempt: 3 });
  assert.equal(a.active + a.focus + a.blocked + a.timeSaved, 0);
  assert.deepEqual(a.sites, []);
  assert.deepEqual(a.categories, []);
});

test('topSites folds the rest into one row', () => {
  const a = aggregate(stats, dateRange('2026-11-03', 7), { minutesPerBlockedAttempt: 3 });
  const { top, other } = topSites(a.sites, 2);
  assert.equal(top.length, 2);
  assert.equal(other?.active, 900);
  assert.equal(other?.blocked, 1);
  assert.equal(topSites(a.sites, 5).other, null);
});

test('CSV quoting follows RFC 4180', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('line\nbreak'), '"line\nbreak"');
  assert.equal(csvField(42), '42');
});

test('sites CSV: one row per site per day, sorted by date', () => {
  const out = sitesCsv(stats).split('\r\n');
  assert.equal(out[0], 'date,domain,category,active_seconds,blocked_attempts');
  assert.equal(out[1], '2026-10-20,x.com,social,100,0');
  assert.equal(out[2], '2026-11-02,github.com,work,3000,0');
  assert.equal(out[3], '2026-11-02,reddit.com,social,600,2');
  assert.equal(out.at(-1), '');
  assert.equal(out.length, 1 + 5 + 1);
});

test('daily CSV includes focus and time saved', () => {
  const out = dailyCsv(stats, 3, ['2026-11-02', '2026-11-03', '2026-11-04']).split('\r\n');
  assert.equal(out[0], 'date,active_seconds,focus_seconds,blocked_attempts,time_saved_seconds');
  assert.equal(out[1], '2026-11-02,3600,3000,2,960');
  assert.equal(out[2], '2026-11-03,2400,0,6,1080');
  assert.equal(out.length, 4); // header + 2 days + trailing empty
});
