// On-device page and post scoring for parental mode. Pure functions: no DOM,
// no storage, nothing leaves the device. `reasons` exist for debugging and
// tests only and are never stored or sent.

import type { PageVerdict, Sensitivity } from '../shared/types.ts';
import { EDUCATIONAL_HOSTS, EDUCATIONAL_SUFFIXES, HOST_STEMS, PHRASES, TERMS, THAI_TERMS } from './lexicon.ts';

export interface PageInput {
  url: string;
  title: string;
  /** Lowercased name/property/itemprop -> content. */
  meta: Record<string, string>;
  headings: string[];
  linkTexts: string[];
  alts: string[];
  /** Visible text sample, at most ~5000 characters. */
  bodySample: string;
}

export interface DetectOptions {
  sensitivity: Sensitivity;
  blockedWords: string[];
}

export interface ScoredVerdict extends PageVerdict {
  reasons: string[];
}

/** Page score needed to call a page explicit. */
export const PAGE_THRESHOLD: Record<Sensitivity, number> = { low: 24, medium: 14, high: 8 };
/** Post score needed to hide a social post. */
export const POST_THRESHOLD: Record<Sensitivity, number> = { low: 10, medium: 7, high: 4 };

/** Score multiplier per page field. Title and URL say most about a page. */
const FIELD_WEIGHT = { url: 2, title: 3, meta: 2, headings: 1.5, links: 0.5, body: 0.3 };
/** A term repeated more often than this in one field adds nothing more. */
const MAX_REPEAT = 3;

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

export function tokenize(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().match(TOKEN_RE) ?? [];
}

interface FieldHits {
  /** Sum of weight × min(count, MAX_REPEAT). */
  raw: number;
  tokens: number;
  /** term -> weight, for distinct-term checks. */
  terms: Map<string, number>;
}

function countHits(text: string): FieldHits {
  const toks = tokenize(text);
  const counts = new Map<string, number>();
  const add = (term: string) => counts.set(term, (counts.get(term) ?? 0) + 1);
  for (let i = 0; i < toks.length; i++) {
    if (TERMS[toks[i]] !== undefined) add(toks[i]);
    if (i + 1 < toks.length) {
      const pair = `${toks[i]} ${toks[i + 1]}`;
      if (PHRASES[pair] !== undefined) add(pair);
    }
  }
  // Thai: substring matching, only when the text contains Thai script.
  if (/[฀-๿]/.test(text)) {
    for (const term of Object.keys(THAI_TERMS)) {
      let n = 0;
      for (let at = text.indexOf(term); at >= 0 && n < MAX_REPEAT; at = text.indexOf(term, at + term.length)) n++;
      if (n) counts.set(term, n);
    }
  }
  const terms = new Map<string, number>();
  let raw = 0;
  for (const [term, n] of counts) {
    const w = TERMS[term] ?? PHRASES[term] ?? THAI_TERMS[term] ?? 0;
    raw += w * Math.min(n, MAX_REPEAT);
    terms.set(term, w);
  }
  return { raw, tokens: toks.length, terms };
}

/** Long fields are normalised by length so a long article with a few hits is not over-penalised. */
function normalised(h: FieldHits): number {
  return h.raw / Math.max(1, Math.sqrt(h.tokens / 100));
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function hostIn(host: string, list: string[]): boolean {
  return list.some((d) => host === d || host.endsWith('.' + d));
}

export function isEducationalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  return hostIn(h, EDUCATIONAL_HOSTS) || EDUCATIONAL_SUFFIXES.some((s) => h.endsWith(s));
}

/** Score the URL: host stems inside compound names plus host/path tokens. */
function urlHits(url: string): FieldHits {
  let host = '';
  let rest = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    rest = decodeURIComponent(u.pathname + ' ' + u.search).replace(/[-_+/.=?&]/g, ' ');
  } catch {
    rest = url;
  }
  const h = countHits(host.replace(/[.-]/g, ' ') + ' ' + rest);
  // Stems hidden inside compound host labels ("freeporntube"), when not already a token hit.
  for (const label of host.split('.').slice(0, -1)) {
    for (const [stem, w] of Object.entries(HOST_STEMS)) {
      if (label !== stem && label.includes(stem) && !h.terms.has(stem)) {
        h.raw += w;
        h.terms.set(stem, w);
      }
    }
  }
  return h;
}

/** Does the text contain a guardian-chosen word? Phrases match adjacent tokens; scripts without spaces match as substrings. */
export function blockedWordHit(text: string, blockedWords: string[]): string | null {
  if (!blockedWords.length || !text) return null;
  const toks = tokenize(text);
  const joined = ` ${toks.join(' ')} `;
  const lower = text.normalize('NFKC').toLowerCase();
  for (const raw of blockedWords) {
    const w = raw.normalize('NFKC').toLowerCase().trim();
    if (!w) continue;
    const wt = tokenize(w);
    if (!wt.length) continue;
    if (!/[a-z0-9À-ɏЀ-ӿ]/.test(w)) {
      if (lower.includes(w)) return raw; // Thai, CJK...
    } else if (joined.includes(` ${wt.join(' ')} `)) {
      return raw;
    }
  }
  return null;
}

/**
 * Age labels a site sets on itself: the RTA label, `rating` adult/mature,
 * og:restrictions:age 18+, schema.org isFamilyFriendly=false. Null = no label.
 */
export function metaVerdict(meta: Record<string, string>): ScoredVerdict | null {
  const get = (k: string) => (meta[k] ?? '').toLowerCase();
  const rating = `${get('rating')} ${get('voluntary content rating')}`.trim();
  const reasons: string[] = [];
  if (Object.values(meta).some((v) => v.toUpperCase().includes('RTA-5042-1996-1400-1577-RTA'))) reasons.push('RTA label');
  else if (/(^|[^a-z])(adult|mature|rta|restricted|explicit)([^a-z]|$)|18\+/.test(rating)) reasons.push(`rating=${rating}`);
  const age = get('og:restrictions:age');
  if (/^\s*(1[89]|2[01])\+?/.test(age)) reasons.push(`og:restrictions:age=${age}`);
  if (get('isfamilyfriendly').trim() === 'false') reasons.push('isFamilyFriendly=false');
  return reasons.length ? { explicit: true, score: 100, source: 'meta', reasons } : null;
}

/** Score a page from its text. Educational hosts are never flagged by text alone. */
export function scorePage(input: PageInput, opts: DetectOptions): ScoredVerdict {
  const host = hostOfUrl(input.url);
  const reasons: string[] = [];
  const threshold = PAGE_THRESHOLD[opts.sensitivity];

  const word = blockedWordHit(
    [input.url, input.title, input.meta['description'] ?? '', input.meta['keywords'] ?? '', ...input.headings, input.bodySample].join(' \n '),
    opts.blockedWords,
  );
  if (word) return { explicit: true, score: threshold * 2, source: 'text', reasons: [`blocked word: ${word}`] };
  if (host && isEducationalHost(host)) return { explicit: false, score: 0, source: 'text', reasons: ['educational host'] };

  const fields = {
    url: urlHits(input.url),
    title: countHits(input.title),
    meta: countHits(
      [input.meta['description'], input.meta['keywords'], input.meta['og:title'], input.meta['og:description']].filter(Boolean).join(' . '),
    ),
    headings: countHits(input.headings.join(' . ')),
    links: countHits([...input.linkTexts, ...input.alts].join(' . ')),
    body: countHits(input.bodySample),
  };
  let score = 0;
  const distinctStrong = new Set<string>();
  for (const [name, h] of Object.entries(fields) as [keyof typeof fields, FieldHits][]) {
    const value = name === 'links' || name === 'body' ? normalised(h) : h.raw;
    const add = FIELD_WEIGHT[name] * value;
    if (add > 0) reasons.push(`${name}: ${[...h.terms.keys()].join(', ')} (+${add.toFixed(1)})`);
    score += add;
    for (const [term, w] of h.terms) if (w >= 3) distinctStrong.add(term);
  }
  score = Math.round(score * 10) / 10;
  // One strong word alone ("porn addiction help") is not enough unless the score is overwhelming.
  const diverse = distinctStrong.size >= 2 || score >= threshold * 2;
  const explicit = score >= threshold && diverse;
  if (score >= threshold && !diverse) reasons.push('only one strong term: not flagged');
  return { explicit, score, source: 'text', reasons };
}

/** Should a social-feed post be hidden? Uses the post's own text only. */
export function postIsExplicit(text: string, opts: DetectOptions): boolean {
  if (!text) return false;
  if (blockedWordHit(text, opts.blockedWords)) return true;
  const h = countHits(text);
  const threshold = POST_THRESHOLD[opts.sensitivity];
  const strong = [...h.terms.values()].filter((w) => w >= 3).length;
  return h.raw >= threshold && (strong >= 2 || h.raw >= threshold * 2);
}
