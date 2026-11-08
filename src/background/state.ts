// Worker state: storage is the source of truth (Chrome stops idle service
// workers), with an in-memory cache. Every read-modify-write goes through
// withLock() so event handlers never interleave.

import { defaultConfig, migrateConfig, migrateRuntime } from '../shared/defaults.ts';
import type { Config, PresetFile, Runtime, StatsStore } from '../shared/types.ts';

export interface State {
  config: Config;
  runtime: Runtime;
}

let cache: State | null = null;
let loading: Promise<State> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Run `fn` after every earlier withLock() call has finished. */
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export async function getState(): Promise<State> {
  if (cache) return cache;
  if (!loading) {
    loading = (async () => {
      const got = await chrome.storage.local.get(['config', 'runtime']);
      const config = got.config ? migrateConfig(got.config) : defaultConfig();
      const runtime = migrateRuntime(got.runtime, Date.now(), config.settings.resetTime);
      cache = { config, runtime };
      if (!got.config || !got.runtime) await chrome.storage.local.set({ config, runtime });
      return cache;
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
}

let lastRuntimeJson = '';
let lastConfigJson = '';

/** Persist config and/or runtime if they changed since the last save. */
export async function save(which: { config?: boolean; runtime?: boolean } = { config: true, runtime: true }): Promise<void> {
  const st = await getState();
  const out: Record<string, unknown> = {};
  if (which.config) {
    const j = JSON.stringify(st.config);
    if (j !== lastConfigJson) {
      out.config = st.config;
      lastConfigJson = j;
    }
  }
  if (which.runtime) {
    const j = JSON.stringify(st.runtime);
    if (j !== lastRuntimeJson) {
      out.runtime = st.runtime;
      lastRuntimeJson = j;
    }
  }
  if (Object.keys(out).length) await chrome.storage.local.set(out);
}

// ---- Stats ----

const STATS_KEEP_DAYS = 120;

export async function updateStats(fn: (s: StatsStore) => void): Promise<void> {
  const got = await chrome.storage.local.get('stats');
  const stats: StatsStore = (got.stats as StatsStore) ?? {};
  fn(stats);
  const keys = Object.keys(stats).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - STATS_KEEP_DAYS))) delete stats[k];
  await chrome.storage.local.set({ stats });
}

export function dayRecord(stats: StatsStore, date: string) {
  return (stats[date] ??= { date, domains: {}, focusSeconds: 0, budgets: {} });
}

// ---- Presets ----

let presets: PresetFile | null = null;

export async function getPresets(): Promise<PresetFile> {
  if (presets) return presets;
  try {
    const res = await fetch(chrome.runtime.getURL('presets/presets.json'));
    presets = (await res.json()) as PresetFile;
  } catch {
    presets = { version: 0, updated: '', presets: [] };
  }
  return presets;
}
