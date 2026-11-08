// Pure helpers for the hide content script: which selectors apply to a URL,
// and the CSS that hides them. Mirrors decideUrl() in shared/rules.ts: a hide
// entry applies when its best matching target priority beats the best matching
// allow priority.

import type { HideIndex, PlainTarget } from '../shared/types.ts';
import { matchTarget, parseHttpUrl } from '../shared/url.ts';

function bestPriority(targets: PlainTarget[], priorities: number[], u: URL): number {
  let best = -1;
  for (let i = 0; i < targets.length; i++) {
    if (matchTarget(targets[i], u)) {
      const p = priorities[i] ?? 0;
      if (p > best) best = p;
    }
  }
  return best;
}

/** Selectors to hide on `url`, de-duplicated, in index order. */
export function selectorsFor(index: HideIndex | null | undefined, url: string): string[] {
  if (!index) return [];
  const u = parseHttpUrl(url);
  if (!u) return [];
  let allowP = -1;
  for (const a of index.allow ?? []) allowP = Math.max(allowP, bestPriority(a.targets, a.priorities, u));
  const out = new Set<string>();
  for (const e of index.hide ?? []) {
    if (bestPriority(e.targets, e.priorities, u) > allowP) {
      for (const s of e.selectors) {
        const t = s.trim();
        if (t) out.add(t);
      }
    }
  }
  return [...out];
}

/** One rule per selector so an invalid selector only drops itself. */
export function buildCss(selectors: string[]): string {
  return selectors
    .filter((s) => s && !/[{}]/.test(s)) // a brace could escape the rule block
    .map((s) => `${s}{display:none!important}`)
    .join('\n');
}
