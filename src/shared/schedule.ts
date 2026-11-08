// Schedules (FR-1.4), budget periods (FR-2.2) and local date keys.
// All times are local. Dates are built with the Date(y, m, d, h, min)
// constructor so DST changes are handled by the platform.

import type { Schedule } from './types.ts';

export const MINUTES_PER_DAY = 1440;
export const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** 'HH:mm' -> minutes since midnight (0..1440). Invalid input -> NaN. */
export function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return NaN;
  return h * 60 + min;
}

export function isValidHHMM(s: string): boolean {
  return !Number.isNaN(parseHHMM(s));
}

/** minutes -> 'HH:mm'. */
export function formatHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Is a schedule active at (day of week, minute of day)?
 * A window with end <= start runs past midnight into the next day; start == end is 24 hours.
 */
export function activeAtWeekMinute(schedule: Schedule, dow: number, minute: number): boolean {
  const days = new Set(schedule.days);
  if (schedule.windows.length === 0) return days.has(dow);
  const prev = (dow + 6) % 7;
  for (const w of schedule.windows) {
    const s = parseHHMM(w.start);
    let e = parseHHMM(w.end);
    if (Number.isNaN(s) || Number.isNaN(e)) continue;
    if (e === 0 && s > 0) e = MINUTES_PER_DAY; // "22:00-00:00" = until midnight
    if (e > s) {
      if (days.has(dow) && minute >= s && minute < e) return true;
    } else {
      // Overnight (or 24 h when s == e): [s, 1440) on the start day, [0, e) on the next day.
      if (days.has(dow) && minute >= s) return true;
      if (days.has(prev) && minute < e) return true;
    }
  }
  return false;
}

/** Is the schedule active at time `ms`? An absent schedule is always active. */
export function scheduleActiveAt(schedule: Schedule | undefined, ms: number): boolean {
  if (!schedule) return true;
  const d = new Date(ms);
  return activeAtWeekMinute(schedule, d.getDay(), d.getHours() * 60 + d.getMinutes());
}

/** Local midnight of the day containing `ms`, plus `addDays`. */
export function startOfLocalDay(ms: number, addDays = 0): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + addDays).getTime();
}

/** Local time `minutes` after midnight on the day of `dayMs`. Handles 1440 = next midnight. */
export function atLocalMinutes(dayMs: number, minutes: number): number {
  const d = new Date(dayMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(minutes / 60), minutes % 60).getTime();
}

/**
 * The next time after `now` at which the schedule's active state flips, or null
 * if it never changes (no schedule, or always/never active within 8 days).
 */
export function nextScheduleChange(schedule: Schedule | undefined, now: number): number | null {
  if (!schedule) return null;
  const current = scheduleActiveAt(schedule, now);
  const candidates: number[] = [];
  for (let off = -1; off <= 8; off++) {
    const day = startOfLocalDay(now, off);
    candidates.push(day);
    for (const w of schedule.windows) {
      const s = parseHHMM(w.start);
      const e = parseHHMM(w.end);
      if (!Number.isNaN(s)) candidates.push(atLocalMinutes(day, s));
      if (!Number.isNaN(e)) candidates.push(atLocalMinutes(day, e));
    }
  }
  candidates.sort((a, b) => a - b);
  for (const c of candidates) {
    if (c <= now) continue;
    if (scheduleActiveAt(schedule, c) !== current) return c;
  }
  return null;
}

/** Bitmap of the week's minutes when the schedule is active (for loosening checks). */
export function scheduleCoverage(schedule: Schedule | undefined): Uint8Array {
  const bits = new Uint8Array(MINUTES_PER_WEEK);
  for (let m = 0; m < MINUTES_PER_WEEK; m++) {
    bits[m] = !schedule || activeAtWeekMinute(schedule, Math.floor(m / MINUTES_PER_DAY), m % MINUTES_PER_DAY) ? 1 : 0;
  }
  return bits;
}

/** True when every minute covered by `a` is also covered by `b`. */
export function coverageSubset(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] && !b[i]) return false;
  return true;
}

/** 'YYYY-MM-DD' for the local date of `ms`. */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Start of the budget period containing `now` for a daily reset at `resetTime`. */
export function budgetPeriodStart(now: number, resetTime: string): number {
  const r = Number.isNaN(parseHHMM(resetTime)) ? 0 : parseHHMM(resetTime) % MINUTES_PER_DAY;
  const today = atLocalMinutes(startOfLocalDay(now), r);
  return now >= today ? today : atLocalMinutes(startOfLocalDay(now, -1), r);
}

/** Period key: local date on which the current budget period started. */
export function budgetPeriodKey(now: number, resetTime: string): string {
  return localDateKey(budgetPeriodStart(now, resetTime));
}

/** The next budget reset after `now`. */
export function nextBudgetReset(now: number, resetTime: string): number {
  const start = budgetPeriodStart(now, resetTime);
  const r = Number.isNaN(parseHHMM(resetTime)) ? 0 : parseHHMM(resetTime) % MINUTES_PER_DAY;
  return atLocalMinutes(startOfLocalDay(start, 1), r);
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mon–Fri 09:00–17:00", "Every day", "Sat, Sun all day". */
export function describeSchedule(schedule: Schedule | undefined): string {
  if (!schedule) return 'Always';
  const days = [...new Set(schedule.days)].sort((a, b) => a - b);
  let dayText: string;
  if (days.length === 7) dayText = 'Every day';
  else if (days.join() === '1,2,3,4,5') dayText = 'Mon–Fri';
  else if (days.join() === '0,6') dayText = 'Sat, Sun';
  else if (days.length === 0) dayText = 'No days';
  else dayText = days.map((d) => DAY_NAMES[d]).join(', ');
  const win = schedule.windows.length === 0 ? 'all day' : schedule.windows.map((w) => `${w.start}–${w.end}`).join(', ');
  return `${dayText} ${win}`;
}
