// Parental-control enforcement that does not need page content: the known
// adult-sites list, learned (detected) sites, SafeSearch and YouTube
// Restricted Mode. Compiled into DNR rules in the highest priority band, so a
// user's own allow rules, pause or Hard Lock state cannot open a filtered site.

import type { DnrRule } from './dnr.ts';
import type { ParentalConfig, ParentalDetection, ParentalIndex } from './types.ts';
import { normalizeHost, parseHttpUrl } from './url.ts';

export const PARENTAL_BAND = 200_000;
/** The block page rule id for parental blocks. */
export const PARENTAL_RULE_ID = 'parental';

/** t codes in /blocked.html?r=parental&t=<code>. */
export const PARENTAL_REASON = { known: 0, detectedSite: 1, detectedPage: 2 } as const;

export function parentalBlockPath(t: number, host?: string): string {
  return `/blocked.html?r=${PARENTAL_RULE_ID}&t=${t}${host ? `&h=${encodeURIComponent(host)}` : ''}`;
}

/** host equals d or is a subdomain of d. */
export function hostUnder(host: string, d: string): boolean {
  return host === d || host.endsWith('.' + d);
}

export function isAllowedHost(host: string, allowed: string[]): boolean {
  const h = normalizeHost(host);
  return allowed.some((a) => hostUnder(h, normalizeHost(a)));
}

/** Is `host` (or a parent domain) in the set? */
export function inDomainSet(host: string, set: Set<string>): boolean {
  const parts = normalizeHost(host).split('.');
  for (let i = 0; i < parts.length - 1; i++) if (set.has(parts.slice(i).join('.'))) return true;
  return false;
}

export interface ParentalBlock {
  t: number;
  host?: string;
}

/** JS mirror of the parental DNR block rules (for open-tab sweeps and SPA navigations). */
export function parentalBlockFor(url: string, p: ParentalConfig, detected: ParentalDetection[], known: Set<string>): ParentalBlock | null {
  if (!p.enabled) return null;
  const u = parseHttpUrl(url);
  if (!u) return null;
  const host = normalizeHost(u.hostname);
  if (isAllowedHost(host, p.allowedSites)) return null;
  const learned = detected.find((d) => hostUnder(host, d.host));
  if (learned) return { t: PARENTAL_REASON.detectedSite, host: learned.host };
  if (p.blockKnownSites && inDomainSet(host, known)) return { t: PARENTAL_REASON.known };
  return null;
}

const SAFE_SEARCH: { regex: string; key: string; value: string }[] = [
  { regex: '^https?://(www\\.)?google\\.[a-z]{2,3}(\\.[a-z]{2})?(:[0-9]+)?/(search|images)', key: 'safe', value: 'active' },
  { regex: '^https?://(www\\.)?bing\\.com(:[0-9]+)?/(search|images/search|videos/search)', key: 'adlt', value: 'strict' },
  { regex: '^https?://(www\\.|html\\.)?duckduckgo\\.com(:[0-9]+)?/', key: 'kp', value: '1' },
];

const YOUTUBE_HOSTS = ['youtube.com', 'm.youtube.com', 'youtubei.googleapis.com', 'youtube.googleapis.com', 'youtube-nocookie.com'];

/** Compile parental DNR rules with ids starting at `firstId`. */
export function compileParentalDnr(p: ParentalConfig, detected: ParentalDetection[], known: string[], firstId: number): DnrRule[] {
  if (!p.enabled) return [];
  const out: DnrRule[] = [];
  let id = firstId;
  const allowed = p.allowedSites.map(normalizeHost).filter(Boolean);
  if (p.blockKnownSites) {
    const domains = known.filter((d) => !isAllowedHost(d, allowed));
    if (domains.length) {
      out.push({
        id: id++,
        priority: PARENTAL_BAND + 1,
        action: { type: 'redirect', redirect: { extensionPath: parentalBlockPath(PARENTAL_REASON.known) } },
        condition: {
          requestDomains: domains,
          ...(allowed.length ? { excludedRequestDomains: allowed } : {}),
          resourceTypes: ['main_frame'],
        },
      });
    }
  }
  for (const d of detected) {
    if (isAllowedHost(d.host, allowed)) continue;
    out.push({
      id: id++,
      priority: PARENTAL_BAND + 2,
      action: { type: 'redirect', redirect: { extensionPath: parentalBlockPath(PARENTAL_REASON.detectedSite, d.host) } },
      condition: { requestDomains: [d.host], resourceTypes: ['main_frame'] },
    });
  }
  if (p.safeSearch) {
    for (const s of SAFE_SEARCH) {
      // Low priority: a user's own block of the search engine still wins. Chrome skips a
      // transform that leaves the URL unchanged, so this does not loop.
      out.push({
        id: id++,
        priority: 1,
        action: { type: 'redirect', redirect: { transform: { queryTransform: { addOrReplaceParams: [{ key: s.key, value: s.value }] } } } },
        condition: { regexFilter: s.regex, resourceTypes: ['main_frame'] },
      });
    }
    out.push({
      id: id++,
      priority: PARENTAL_BAND + 3,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'YouTube-Restrict', operation: 'set', value: 'Strict' }] },
      condition: { requestDomains: YOUTUBE_HOSTS, resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest'] },
    });
  }
  return out;
}

/** What the parental content script reads (no PIN hash). */
export function parentalIndexOf(p: ParentalConfig, rev: number): ParentalIndex {
  return {
    rev,
    enabled: p.enabled,
    detectPages: p.detectPages,
    detectScope: p.detectScope,
    hideUntilChecked: p.hideUntilChecked,
    scanImages: p.scanImages,
    sensitivity: p.sensitivity,
    socialFilter: p.socialFilter,
    blockedWords: p.blockedWords,
    allowedSites: p.allowedSites.map(normalizeHost),
  };
}

/** Does parental mode need the content script? */
export function needsParentalScript(p: ParentalConfig): boolean {
  return p.enabled && (p.detectPages || p.scanImages || p.socialFilter);
}

/** Add a learned site (dedupe by host, newest last, max 500). */
export function learnSite(list: ParentalDetection[], d: ParentalDetection): ParentalDetection[] {
  const host = normalizeHost(d.host);
  const rest = list.filter((x) => x.host !== host);
  return [...rest, { ...d, host }].slice(-500);
}
