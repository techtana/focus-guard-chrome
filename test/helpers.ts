import { defaultConfig, defaultRuntime } from '../src/shared/defaults.ts';
import type { EngineState } from '../src/shared/rules.ts';
import type { Action, Config, Rule, Runtime, Target } from '../src/shared/types.ts';
import { parseTargetInput } from '../src/shared/url.ts';

let n = 0;
export function rule(sites: string[] | Target[], action: Action = { kind: 'block' }, extra: Partial<Rule> = {}): Rule {
  const targets = sites.map((s) => (typeof s === 'string' ? parseTargetInput(s)! : s));
  return { id: `r${++n}`, name: `rule ${n}`, targets, action, enabled: true, createdAt: 0, ...extra };
}

/** A local-time timestamp: 2026-11-09 is a Monday. */
export function at(y: number, m: number, d: number, hh = 0, mm = 0): number {
  return new Date(y, m - 1, d, hh, mm).getTime();
}
export const MONDAY_10 = at(2026, 11, 9, 10, 0);

export function state(rules: Rule[], now = MONDAY_10, patch: { config?: Partial<Config>; runtime?: Partial<Runtime> } = {}): EngineState {
  const config = { ...defaultConfig(), rules, ...patch.config };
  const runtime = { ...defaultRuntime(now, config.settings.resetTime), ...patch.runtime };
  return { config, runtime, now };
}
