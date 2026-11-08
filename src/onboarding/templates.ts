// Starter templates for the first run (FR-9.1). Pure: no chrome APIs, so
// they are unit-tested in test/templates.test.ts.

import { isValidHHMM } from '../shared/schedule.ts';
import type { FocusConfig, PlainTarget, Rule } from '../shared/types.ts';
import { isValidRedirectUrl, parseTargetInput, targetKey, targetLabel } from '../shared/url.ts';

export type TemplateId = 'deepWork' | 'pomodoro' | 'socialDiet';

export interface TemplateInfo {
  id: TemplateId;
  title: string;
  persona: string;
  summary: string;
  defaultSites: string[];
}

export const YOUTUBE_PRESET_OPTIONS = ['shorts', 'comments', 'sidebar', 'homefeed'];

export const TEMPLATES: TemplateInfo[] = [
  {
    id: 'deepWork',
    title: 'Deep work',
    persona: 'For focused mornings',
    summary: 'Blocks social and news sites on weekday mornings, and keeps YouTube for tutorials while hiding Shorts, comments, recommendations and the home feed.',
    defaultSites: ['reddit.com', 'x.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'news.ycombinator.com', 'cnn.com', 'bbc.com'],
  },
  {
    id: 'pomodoro',
    title: 'Student Pomodoro',
    persona: 'For study sessions',
    summary: 'Blocks distracting sites during focus intervals and opens them in breaks. Optionally sends you to a useful page instead.',
    defaultSites: ['instagram.com', 'tiktok.com', 'x.com', 'reddit.com', 'facebook.com', 'youtube.com'],
  },
  {
    id: 'socialDiet',
    title: 'Social diet',
    persona: 'For using social media a little',
    summary: 'Gives each social site a small daily time budget. When it runs out, the site is blocked until the daily reset.',
    defaultSites: ['reddit.com', 'x.com', 'instagram.com', 'facebook.com', 'tiktok.com'],
  },
];

export interface TemplateOptions {
  /** Raw site list, one per line (or comma separated). */
  sitesText: string;
  /** deepWork: weekday window. */
  start?: string;
  end?: string;
  /** pomodoro: work interval minutes. */
  workMin?: number;
  /** pomodoro: optional redirect target. */
  redirectUrl?: string;
  /** socialDiet: minutes per site per day. */
  minutesPerDay?: number;
}

export interface TemplateResult {
  rules: Rule[];
  focusConfig?: Partial<FocusConfig>;
  errors: string[];
}

/** Parse a site list into unique plain targets; bad lines are reported. */
export function parseSites(text: string): { targets: PlainTarget[]; invalid: string[] } {
  const targets: PlainTarget[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\n,]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const t = parseTargetInput(line);
    if (!t) {
      invalid.push(line);
      continue;
    }
    const k = targetKey(t);
    if (!seen.has(k)) {
      seen.add(k);
      targets.push(t);
    }
  }
  return { targets, invalid };
}

/** Add https:// when the user typed a bare host. */
export function normalizeRedirect(url: string): string {
  const s = url.trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

export function buildTemplate(id: TemplateId, opts: TemplateOptions, now: number, newId: () => string): TemplateResult {
  const errors: string[] = [];
  const { targets, invalid } = parseSites(opts.sitesText);
  if (invalid.length) errors.push(`Not a website: ${invalid.join(', ')}`);
  if (!targets.length) errors.push('Add at least one site.');
  const rules: Rule[] = [];
  const base = (name: string, ts: PlainTarget[]): Omit<Rule, 'action'> => ({
    id: newId(),
    name,
    targets: ts,
    enabled: true,
    createdAt: now,
  });

  switch (id) {
    case 'deepWork': {
      const start = opts.start ?? '09:00';
      const end = opts.end ?? '12:00';
      if (!isValidHHMM(start) || !isValidHHMM(end)) errors.push('Enter times as HH:MM, for example 09:00.');
      else if (start === end) errors.push('Start and end time must differ.');
      if (targets.length) {
        rules.push({
          ...base('Deep work', targets),
          action: { kind: 'block' },
          schedule: { days: [1, 2, 3, 4, 5], windows: [{ start, end }] },
        });
      }
      rules.push({
        ...base('YouTube without rabbit holes', [{ kind: 'domain', host: 'youtube.com', includeSubdomains: true }]),
        action: { kind: 'hide', selectors: [], presetId: 'youtube', presetOptions: [...YOUTUBE_PRESET_OPTIONS] },
      });
      break;
    }
    case 'pomodoro': {
      const workMin = opts.workMin ?? 25;
      if (!Number.isInteger(workMin) || workMin < 1 || workMin > 240) errors.push('Focus interval must be 1–240 minutes.');
      const redirect = normalizeRedirect(opts.redirectUrl ?? '');
      if (redirect && !isValidRedirectUrl(redirect)) errors.push('The redirect must be an http or https address.');
      if (targets.length) {
        rules.push({
          ...base('Focus list', targets),
          action: redirect ? { kind: 'redirect', url: redirect } : { kind: 'block' },
          onlyDuringFocus: true,
        });
      }
      return { rules: errors.length ? [] : rules, focusConfig: { workMin }, errors };
    }
    case 'socialDiet': {
      const minutes = opts.minutesPerDay ?? 20;
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 720) errors.push('Daily budget must be 1–720 minutes.');
      for (const t of targets) {
        rules.push({
          ...base(`${targetLabel(t)} — ${minutes} min/day`, [t]),
          action: { kind: 'budget', minutesPerDay: minutes },
        });
      }
      break;
    }
  }
  return { rules: errors.length ? [] : rules, errors };
}
