// Insights aggregation and CSV export (FR-8.1, FR-8.3, FR-8.4, UC-8).
// Pure functions over the `stats` store written by the service worker.

import { categoryOf } from './categories.ts';
import { localDateKey } from './schedule.ts';
import type { Category, DayRecord, StatsStore } from './types.ts';

export interface SiteRow {
  domain: string;
  category: Category;
  /** Active seconds. */
  active: number;
  blocked: number;
}

export interface DaySeries {
  date: string;
  active: number;
  focus: number;
  blocked: number;
  timeSaved: number;
}

export interface Aggregate {
  dates: string[];
  /** Active seconds across all sites. */
  active: number;
  focus: number;
  blocked: number;
  /** Seconds: budgetUnused + blockedSaved. */
  timeSaved: number;
  budgetUnused: number;
  blockedSaved: number;
  /** Sorted by active time, then blocked attempts, descending. */
  sites: SiteRow[];
  /** Sorted by active time descending; categories with no time are left out. */
  categories: { category: Category; active: number }[];
  series: DaySeries[];
}

export interface InsightOptions {
  overrides?: Record<string, Category>;
  minutesPerBlockedAttempt: number;
}

/** 'YYYY-MM-DD' -> local midnight ms. */
export function parseDateKey(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return localDateKey(new Date(y, m - 1, d + n).getTime());
}

/** `days` consecutive dates ending on `endDate`, oldest first. */
export function dateRange(endDate: string, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(addDays(endDate, -i));
  return out;
}

/** Unused budget seconds recorded for a day. */
export function budgetUnused(day: DayRecord | undefined): number {
  if (!day?.budgets) return 0;
  let s = 0;
  for (const b of Object.values(day.budgets)) s += Math.max(0, b.limit - b.used);
  return s;
}

function dayTotals(day: DayRecord | undefined): { active: number; blocked: number } {
  let active = 0;
  let blocked = 0;
  if (day) {
    for (const d of Object.values(day.domains)) {
      active += d.active;
      blocked += d.blocked;
    }
  }
  return { active, blocked };
}

/** Time saved for one day in seconds (FR-8.3). */
export function dayTimeSaved(day: DayRecord | undefined, minutesPerBlockedAttempt: number): number {
  return budgetUnused(day) + dayTotals(day).blocked * minutesPerBlockedAttempt * 60;
}

export function aggregate(stats: StatsStore, dates: string[], opts: InsightOptions): Aggregate {
  const overrides = opts.overrides ?? {};
  const sites = new Map<string, SiteRow>();
  const series: DaySeries[] = [];
  let unused = 0;
  for (const date of dates) {
    const day = stats[date];
    const tot = dayTotals(day);
    const u = budgetUnused(day);
    unused += u;
    series.push({
      date,
      active: tot.active,
      focus: day?.focusSeconds ?? 0,
      blocked: tot.blocked,
      timeSaved: u + tot.blocked * opts.minutesPerBlockedAttempt * 60,
    });
    if (!day) continue;
    for (const [domain, v] of Object.entries(day.domains)) {
      let row = sites.get(domain);
      if (!row) {
        row = { domain, category: categoryOf(domain, overrides), active: 0, blocked: 0 };
        sites.set(domain, row);
      }
      row.active += v.active;
      row.blocked += v.blocked;
    }
  }
  const siteList = [...sites.values()].sort((a, b) => b.active - a.active || b.blocked - a.blocked || a.domain.localeCompare(b.domain));
  const cats = new Map<Category, number>();
  for (const s of siteList) cats.set(s.category, (cats.get(s.category) ?? 0) + s.active);
  const active = series.reduce((a, s) => a + s.active, 0);
  const blocked = series.reduce((a, s) => a + s.blocked, 0);
  const blockedSaved = blocked * opts.minutesPerBlockedAttempt * 60;
  return {
    dates,
    active,
    focus: series.reduce((a, s) => a + s.focus, 0),
    blocked,
    budgetUnused: unused,
    blockedSaved,
    timeSaved: unused + blockedSaved,
    sites: siteList,
    categories: [...cats.entries()]
      .filter(([, v]) => v > 0)
      .map(([category, v]) => ({ category, active: v }))
      .sort((a, b) => b.active - a.active),
    series,
  };
}

/** Top `n` sites by active time plus an "other" row summing the rest (null when nothing is left over). */
export function topSites(sites: SiteRow[], n: number): { top: SiteRow[]; other: SiteRow | null } {
  if (sites.length <= n) return { top: sites, other: null };
  const rest = sites.slice(n);
  return {
    top: sites.slice(0, n),
    other: {
      domain: `${rest.length} other sites`,
      category: 'other',
      active: rest.reduce((a, s) => a + s.active, 0),
      blocked: rest.reduce((a, s) => a + s.blocked, 0),
    },
  };
}

// ---- CSV (RFC 4180) ----

export function csvField(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(rows: (string | number)[][]): string {
  return rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

function sortedDates(stats: StatsStore, dates?: string[]): string[] {
  return (dates ?? Object.keys(stats)).filter((d) => stats[d]).sort();
}

/** date,domain,category,active_seconds,blocked_attempts — one row per site per day. */
export function sitesCsv(stats: StatsStore, overrides: Record<string, Category> = {}, dates?: string[]): string {
  const rows: (string | number)[][] = [['date', 'domain', 'category', 'active_seconds', 'blocked_attempts']];
  for (const date of sortedDates(stats, dates)) {
    const domains = Object.entries(stats[date].domains).sort(([a], [b]) => a.localeCompare(b));
    for (const [domain, v] of domains) {
      rows.push([date, domain, categoryOf(domain, overrides), Math.round(v.active), v.blocked]);
    }
  }
  return csv(rows);
}

/** date,active_seconds,focus_seconds,blocked_attempts,time_saved_seconds — one row per day. */
export function dailyCsv(stats: StatsStore, minutesPerBlockedAttempt: number, dates?: string[]): string {
  const rows: (string | number)[][] = [['date', 'active_seconds', 'focus_seconds', 'blocked_attempts', 'time_saved_seconds']];
  for (const date of sortedDates(stats, dates)) {
    const day = stats[date];
    const tot = dayTotals(day);
    rows.push([
      date,
      Math.round(tot.active),
      Math.round(day.focusSeconds ?? 0),
      tot.blocked,
      Math.round(dayTimeSaved(day, minutesPerBlockedAttempt)),
    ]);
  }
  return csv(rows);
}
