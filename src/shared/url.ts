// Target parsing, normalization and URL matching (FR-1.2). The DNR compiler in
// dnr.ts must agree with matchTarget(): both are covered by test/url.test.ts.

import type { Group, PlainTarget, Target } from './types.ts';

/** Parse an http(s) URL. Returns null for other schemes or invalid input. */
export function parseHttpUrl(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** Lowercase, drop a trailing dot and a leading "www.". */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('www.')) h = h.slice(4);
  return h;
}

/** The domain used for stats: normalized hostname of an http(s) URL, or null. */
export function hostOf(url: string): string | null {
  const u = parseHttpUrl(url);
  return u ? normalizeHost(u.hostname) : null;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)*[a-z0-9-]{1,63}$/;

/**
 * Turn what a user typed ("reddit.com", "https://www.youtube.com/shorts",
 * "youtube.com/watch?v=x") into a target. A bare host becomes a domain target
 * (with subdomains); anything with a path or query becomes a prefix target,
 * or an exact target when `mode` is 'exact'. Returns null when it is not a URL.
 */
export function parseTargetInput(input: string, mode: 'auto' | 'exact' | 'domain-only' = 'auto'): PlainTarget | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = normalizeHost(u.hostname);
  if (!HOST_RE.test(host) || !host.includes('.') && host !== 'localhost') return null;
  const rest = u.pathname + u.search;
  if (mode === 'domain-only' || (mode === 'auto' && (rest === '/' || rest === ''))) {
    return { kind: 'domain', host, includeSubdomains: true };
  }
  return { kind: mode === 'exact' ? 'exact' : 'prefix', url: host + rest };
}

/** Split a stored prefix/exact url ("host/path?q") into host and rest ("/path?q"). */
export function splitTargetUrl(url: string): { host: string; rest: string } {
  const i = url.search(/[/?]/);
  if (i < 0) return { host: url.toLowerCase(), rest: '/' };
  const host = url.slice(0, i).toLowerCase();
  let rest = url.slice(i);
  if (rest.startsWith('?')) rest = '/' + rest;
  return { host, rest };
}

function hostMatches(hostname: string, host: string, includeSubdomains: boolean): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === host || h === 'www.' + host) return true;
  return includeSubdomains && h.endsWith('.' + host);
}

/** Path without trailing slash ('' for root) + query, lowercase. */
function exactKey(pathname: string, search: string): string {
  let p = pathname;
  if (p.endsWith('/')) p = p.slice(0, -1);
  return (p + (search === '?' ? '' : search)).toLowerCase();
}

/** Does a plain target match an http(s) URL? */
export function matchTarget(t: PlainTarget, u: URL): boolean {
  switch (t.kind) {
    case 'domain':
      return hostMatches(u.hostname, t.host, t.includeSubdomains);
    case 'prefix': {
      const { host, rest } = splitTargetUrl(t.url);
      if (!hostMatches(u.hostname, host, true)) return false;
      return (u.pathname + u.search).toLowerCase().startsWith(rest.toLowerCase());
    }
    case 'exact': {
      const { host, rest } = splitTargetUrl(t.url);
      if (!hostMatches(u.hostname, host, false)) return false;
      const q = rest.indexOf('?');
      const path = q < 0 ? rest : rest.slice(0, q);
      const search = q < 0 ? '' : rest.slice(q);
      return exactKey(u.pathname, u.search) === exactKey(path, search);
    }
  }
}

/** Expand group targets. Unknown groups expand to nothing. */
export function expandTargets(targets: Target[], groups: Group[]): PlainTarget[] {
  const out: PlainTarget[] = [];
  for (const t of targets) {
    if (t.kind === 'group') {
      const g = groups.find((x) => x.id === t.groupId);
      if (g) out.push(...g.targets);
    } else {
      out.push(t);
    }
  }
  return out;
}

/**
 * Specificity of a target; higher = more specific (FR-1.5).
 * domain+subdomains 10+labels < exact domain 40+labels < prefix 100+len < exact URL 1000.
 */
export function specificity(t: PlainTarget): number {
  switch (t.kind) {
    case 'domain':
      return (t.includeSubdomains ? 10 : 40) + Math.min(t.host.split('.').length, 29);
    case 'prefix':
      return 100 + Math.min(splitTargetUrl(t.url).rest.length, 800);
    case 'exact':
      return 1000;
  }
}

/** The host a target is about (used for blocked-attempt stats). */
export function targetHost(t: PlainTarget): string {
  return t.kind === 'domain' ? t.host : splitTargetUrl(t.url).host;
}

/** Human label: "reddit.com", "reddit.com (exact host)", "youtube.com/shorts*", "= youtube.com/watch?v=1", "Group: Social". */
export function targetLabel(t: Target, groups: Group[] = []): string {
  switch (t.kind) {
    case 'domain':
      return t.includeSubdomains ? t.host : `${t.host} (no subdomains)`;
    case 'prefix':
      return `${t.url}*`;
    case 'exact':
      return `= ${t.url}`;
    case 'group': {
      const g = groups.find((x) => x.id === t.groupId);
      return g ? `Group: ${g.name}` : 'Group: (deleted)';
    }
  }
}

/** Stable string key for a target, for comparisons and de-duplication. */
export function targetKey(t: Target): string {
  switch (t.kind) {
    case 'domain':
      return `d:${t.host}:${t.includeSubdomains ? 1 : 0}`;
    case 'prefix':
      return `p:${t.url.toLowerCase()}`;
    case 'exact':
      return `e:${t.url.toLowerCase()}`;
    case 'group':
      return `g:${t.groupId}`;
  }
}

/** Validate a redirect URL: http or https only (security NFR). */
export function isValidRedirectUrl(url: string): boolean {
  return parseHttpUrl(url) !== null;
}

/** Escape a string for an RE2 regex. */
export function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
