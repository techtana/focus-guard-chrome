// Compile active entries into declarativeNetRequest dynamic rules
// (PRD "Rule evaluation" step 2). One DNR rule per (entry, target) so the block
// page can name the blocked site from the rule id and target index alone; the
// visited URL is never put in the block page URL.

import { decideUrl, entryPriority, type ActiveEntry } from './rules.ts';
import type { PlainTarget } from './types.ts';
import { escapeRegex, splitTargetUrl } from './url.ts';

/** The subset of chrome.declarativeNetRequest.Rule we produce (kept local so node tests need no chrome types). */
export interface DnrRule {
  id: number;
  priority: number;
  action:
    | { type: 'block' }
    | { type: 'allow' }
    | { type: 'redirect'; redirect: { extensionPath: string } | { url: string } };
  condition: {
    requestDomains?: string[];
    regexFilter?: string;
    resourceTypes: ['main_frame'];
  };
}

export function blockPagePath(ruleId: string, targetIndex: number): string {
  return `/blocked.html?r=${encodeURIComponent(ruleId)}&t=${targetIndex}`;
}

const PORT = '(:[0-9]+)?';

/** DNR condition equivalent to url.ts matchTarget(). */
export function targetCondition(t: PlainTarget): DnrRule['condition'] {
  switch (t.kind) {
    case 'domain':
      return t.includeSubdomains
        ? { requestDomains: [t.host], resourceTypes: ['main_frame'] }
        : { regexFilter: `^https?://(www\\.)?${escapeRegex(t.host)}${PORT}([/?]|$)`, resourceTypes: ['main_frame'] };
    case 'prefix': {
      const { host, rest } = splitTargetUrl(t.url);
      return {
        regexFilter: `^https?://([^/?#]*\\.)?${escapeRegex(host)}${PORT}${escapeRegex(rest)}`,
        resourceTypes: ['main_frame'],
      };
    }
    case 'exact': {
      const { host, rest } = splitTargetUrl(t.url);
      const q = rest.indexOf('?');
      let path = q < 0 ? rest : rest.slice(0, q);
      const search = q < 0 ? '' : rest.slice(q + 1);
      if (path.endsWith('/')) path = path.slice(0, -1);
      const tail = search ? `/?\\?${escapeRegex(search)}$` : '/?$';
      return {
        regexFilter: `^https?://(www\\.)?${escapeRegex(host)}${PORT}${escapeRegex(path)}${tail}`,
        resourceTypes: ['main_frame'],
      };
    }
  }
}

/**
 * Compile entries to DNR rules. Redirects whose target would itself be blocked
 * or redirected (a loop, FR-7.3) fall back to the block page.
 */
export function compileDnr(entries: ActiveEntry[]): DnrRule[] {
  const out: DnrRule[] = [];
  let id = 1;
  for (const e of entries) {
    if (e.kind !== 'block' && e.kind !== 'redirect' && e.kind !== 'allow') continue;
    let redirectUrl: string | undefined;
    if (e.kind === 'redirect' && e.redirectUrl) {
      const d = decideUrl(e.redirectUrl, entries);
      if (d.action !== 'block' && d.action !== 'redirect') redirectUrl = e.redirectUrl;
    }
    e.targets.forEach((t, i) => {
      const action: DnrRule['action'] =
        e.kind === 'allow'
          ? { type: 'allow' }
          : redirectUrl
            ? { type: 'redirect', redirect: { url: redirectUrl } }
            : { type: 'redirect', redirect: { extensionPath: blockPagePath(e.ruleId, i) } };
      out.push({ id: id++, priority: entryPriority(e, t), action, condition: targetCondition(t) });
    });
  }
  return out;
}

/** True when a redirect entry was compiled to the block page because of a loop. */
export function isRedirectLoop(e: ActiveEntry, entries: ActiveEntry[]): boolean {
  if (e.kind !== 'redirect' || !e.redirectUrl) return false;
  const d = decideUrl(e.redirectUrl, entries);
  return d.action === 'block' || d.action === 'redirect';
}
