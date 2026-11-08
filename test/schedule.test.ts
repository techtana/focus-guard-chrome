import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  budgetPeriodKey,
  coverageSubset,
  describeSchedule,
  nextBudgetReset,
  nextScheduleChange,
  parseHHMM,
  scheduleActiveAt,
  scheduleCoverage,
} from '../src/shared/schedule.ts';
import type { Schedule } from '../src/shared/types.ts';
import { at } from './helpers.ts';

const workHours: Schedule = { days: [1, 2, 3, 4, 5], windows: [{ start: '09:00', end: '17:00' }] };

test('parseHHMM', () => {
  assert.equal(parseHHMM('09:30'), 570);
  assert.equal(parseHHMM('24:00'), 1440);
  assert.ok(Number.isNaN(parseHHMM('24:30')));
  assert.ok(Number.isNaN(parseHHMM('9h')));
});

test('weekday window', () => {
  assert.ok(scheduleActiveAt(workHours, at(2026, 11, 9, 9, 0))); // Monday 09:00
  assert.ok(!scheduleActiveAt(workHours, at(2026, 11, 9, 17, 0)));
  assert.ok(!scheduleActiveAt(workHours, at(2026, 11, 8, 10, 0))); // Sunday
  assert.ok(scheduleActiveAt(undefined, at(2026, 11, 8, 10, 0)));
});

test('overnight window belongs to its start day', () => {
  const late: Schedule = { days: [5], windows: [{ start: '22:00', end: '02:00' }] }; // Friday night
  assert.ok(scheduleActiveAt(late, at(2026, 11, 13, 23, 0)));
  assert.ok(scheduleActiveAt(late, at(2026, 11, 14, 1, 59))); // Saturday early
  assert.ok(!scheduleActiveAt(late, at(2026, 11, 14, 2, 0)));
  assert.ok(!scheduleActiveAt(late, at(2026, 11, 15, 1, 0))); // Sunday early: Saturday not listed
});

test('all-day schedule and until-midnight window', () => {
  assert.ok(scheduleActiveAt({ days: [0, 6], windows: [] }, at(2026, 11, 8, 3, 0)));
  const eve: Schedule = { days: [1], windows: [{ start: '20:00', end: '00:00' }] };
  assert.ok(scheduleActiveAt(eve, at(2026, 11, 9, 23, 59)));
  assert.ok(!scheduleActiveAt(eve, at(2026, 11, 10, 0, 1)));
});

test('nextScheduleChange', () => {
  assert.equal(nextScheduleChange(workHours, at(2026, 11, 9, 10, 0)), at(2026, 11, 9, 17, 0));
  assert.equal(nextScheduleChange(workHours, at(2026, 11, 9, 18, 0)), at(2026, 11, 10, 9, 0));
  assert.equal(nextScheduleChange(workHours, at(2026, 11, 13, 18, 0)), at(2026, 11, 16, 9, 0)); // Fri -> Mon
  assert.equal(nextScheduleChange(undefined, 0), null);
  assert.equal(nextScheduleChange({ days: [0, 1, 2, 3, 4, 5, 6], windows: [] }, at(2026, 11, 9)), null);
});

test('coverage subset detects narrowing', () => {
  const narrower: Schedule = { days: [1, 2, 3, 4, 5], windows: [{ start: '10:00', end: '12:00' }] };
  assert.ok(coverageSubset(scheduleCoverage(narrower), scheduleCoverage(workHours)));
  assert.ok(!coverageSubset(scheduleCoverage(workHours), scheduleCoverage(narrower)));
  assert.ok(coverageSubset(scheduleCoverage(workHours), scheduleCoverage(undefined)));
});

test('budget periods follow the reset time', () => {
  assert.equal(budgetPeriodKey(at(2026, 11, 9, 3, 0), '00:00'), '2026-11-09');
  assert.equal(budgetPeriodKey(at(2026, 11, 9, 3, 0), '04:00'), '2026-11-08');
  assert.equal(budgetPeriodKey(at(2026, 11, 9, 5, 0), '04:00'), '2026-11-09');
  assert.equal(nextBudgetReset(at(2026, 11, 9, 3, 0), '04:00'), at(2026, 11, 9, 4, 0));
  assert.equal(nextBudgetReset(at(2026, 11, 9, 23, 0), '00:00'), at(2026, 11, 10, 0, 0));
});

test('describeSchedule', () => {
  assert.equal(describeSchedule(workHours), 'Mon–Fri 09:00–17:00');
  assert.equal(describeSchedule(undefined), 'Always');
});
