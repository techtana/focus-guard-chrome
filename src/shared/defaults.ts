import { DEFAULT_FOCUS } from './focus.ts';
import { budgetPeriodKey } from './schedule.ts';
import type { Config, Runtime, Settings } from './types.ts';

export const DEFAULT_SETTINGS: Settings = {
  commitment: 'none',
  challengeLength: 300,
  challengeDelayMin: 5,
  resetTime: '00:00',
  idleSeconds: 60,
  uninstallUrl: '',
  minutesPerBlockedAttempt: 3,
};

export function defaultConfig(): Config {
  return {
    schemaVersion: 1,
    rules: [],
    groups: [],
    settings: { ...DEFAULT_SETTINGS },
    focusConfig: { ...DEFAULT_FOCUS },
    lockSchedules: [],
    blockPage: { message: '', hasImage: false },
    categoryOverrides: {},
    onboarded: false,
  };
}

export function defaultRuntime(now: number, resetTime = '00:00'): Runtime {
  return {
    locks: [],
    focus: null,
    pausedUntil: null,
    budget: { period: budgetPeriodKey(now, resetTime), used: {}, warned: [] },
  };
}

/** Fill in fields missing from older or partial stored config. */
export function migrateConfig(raw: unknown): Config {
  const base = defaultConfig();
  if (!raw || typeof raw !== 'object') return base;
  const c = raw as Partial<Config>;
  return {
    ...base,
    ...c,
    schemaVersion: 1,
    settings: { ...base.settings, ...(c.settings ?? {}) },
    focusConfig: { ...base.focusConfig, ...(c.focusConfig ?? {}) },
    blockPage: { ...base.blockPage, ...(c.blockPage ?? {}) },
    rules: Array.isArray(c.rules) ? c.rules : [],
    groups: Array.isArray(c.groups) ? c.groups : [],
    lockSchedules: Array.isArray(c.lockSchedules) ? c.lockSchedules : [],
    categoryOverrides: c.categoryOverrides ?? {},
  };
}

export function migrateRuntime(raw: unknown, now: number, resetTime: string): Runtime {
  const base = defaultRuntime(now, resetTime);
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<Runtime>;
  return {
    locks: Array.isArray(r.locks) ? r.locks : [],
    focus: r.focus ?? null,
    pausedUntil: typeof r.pausedUntil === 'number' ? r.pausedUntil : null,
    budget:
      r.budget && typeof r.budget.period === 'string'
        ? { period: r.budget.period, used: r.budget.used ?? {}, warned: r.budget.warned ?? [] }
        : base.budget,
  };
}

/** Random id, 12 base36 chars. */
export function newId(): string {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
}
