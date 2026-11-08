// Focus Mode (Pomodoro) phases, FR-6. Phases are computed from startedAt so a
// restarted service worker always lands in the right phase.
// Sequence for cycles = 4: work, break, work, break, work, break, work, long break.

import type { FocusConfig, FocusSession } from './types.ts';

export type FocusPhaseKind = 'work' | 'break' | 'longBreak';

export interface FocusPhase {
  index: number;
  kind: FocusPhaseKind;
  /** 1-based work cycle this phase belongs to. */
  cycle: number;
  startsAt: number;
  endsAt: number;
}

export const DEFAULT_FOCUS: FocusConfig = { workMin: 25, breakMin: 5, longBreakMin: 15, cycles: 4 };

export function focusPhases(s: FocusSession): FocusPhase[] {
  const out: FocusPhase[] = [];
  let t = s.startedAt;
  const push = (kind: FocusPhaseKind, cycle: number, min: number) => {
    if (min <= 0) return;
    out.push({ index: out.length, kind, cycle, startsAt: t, endsAt: t + min * 60_000 });
    t += min * 60_000;
  };
  for (let c = 1; c <= s.cycles; c++) {
    push('work', c, s.workMin);
    if (c < s.cycles) push('break', c, s.breakMin);
    else push('longBreak', c, s.longBreakMin);
  }
  return out;
}

/** The phase at `now`, or null when the session has ended (or not started). */
export function currentPhase(s: FocusSession, now: number): FocusPhase | null {
  for (const p of focusPhases(s)) if (now >= p.startsAt && now < p.endsAt) return p;
  return null;
}

export function sessionEndsAt(s: FocusSession): number {
  const ph = focusPhases(s);
  return ph.length ? ph[ph.length - 1].endsAt : s.startedAt;
}

export function isWorkInterval(s: FocusSession | null, now: number): boolean {
  return !!s && currentPhase(s, now)?.kind === 'work';
}

export function validateFocusConfig(c: FocusConfig): string | null {
  const ok = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
  if (!ok(c.workMin, 1, 240)) return 'Work length must be 1–240 minutes.';
  if (!ok(c.breakMin, 0, 120)) return 'Break length must be 0–120 minutes.';
  if (!ok(c.longBreakMin, 0, 240)) return 'Long break must be 0–240 minutes.';
  if (!ok(c.cycles, 1, 12)) return 'Cycles must be 1–12.';
  return null;
}

export function phaseLabel(kind: FocusPhaseKind): string {
  return kind === 'work' ? 'Focus' : kind === 'break' ? 'Break' : 'Long break';
}
