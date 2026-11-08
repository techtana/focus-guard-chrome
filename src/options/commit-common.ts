// Helpers shared by the focus, lock, settings and block page sections.
import type { Group, PlainTarget, Rule, Runtime, Target } from '../shared/types.ts';
import { parseTargetInput, targetLabel } from '../shared/url.ts';
import { h, uniqueId } from '../ui/dom.ts';

/** Inject commit.css once. */
export function ensureCommitCss(): void {
  if (!document.querySelector('link[href="commit.css"]')) {
    document.head.append(h('link', { rel: 'stylesheet', href: 'commit.css' }));
  }
}

/** One editable text line for a plain target ("=" prefix marks an exact URL). */
export function targetToLine(t: PlainTarget): string {
  switch (t.kind) {
    case 'domain':
      return t.host;
    case 'prefix':
      return t.url;
    case 'exact':
      return `=${t.url}`;
  }
}

/** Plain targets as textarea text; group targets are left out (callers keep them). */
export function targetsToText(targets: Target[]): string {
  return targets
    .filter((t): t is PlainTarget => t.kind !== 'group')
    .map(targetToLine)
    .join('\n');
}

/** Parse a textarea of sites, one per line (commas also split). Lines starting with "=" are exact URLs. */
export function parseSitesText(text: string): { targets: PlainTarget[]; invalid: string[] } {
  const targets: PlainTarget[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\n,]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const exact = line.startsWith('=');
    const t = parseTargetInput(exact ? line.slice(1) : line, exact ? 'exact' : 'auto');
    if (!t) {
      invalid.push(line);
      continue;
    }
    const key = JSON.stringify(t);
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(t);
    }
  }
  return { targets, invalid };
}

export function activeLocksOf(rt: Runtime, now: number) {
  return rt.locks.filter((l) => l.startedAt <= now && now < l.endsAt);
}

export function actionLabel(r: Rule): string {
  if (r.allow) return 'Exception (allow)';
  switch (r.action.kind) {
    case 'block':
      return 'Block';
    case 'redirect':
      return 'Redirect';
    case 'hide':
      return 'Hide elements';
    case 'budget':
      return `Budget ${r.action.minutesPerDay} min/day`;
  }
}

export function ruleTitle(r: Rule, groups: Group[]): string {
  const name = r.name || r.targets.map((t) => targetLabel(t, groups)).slice(0, 3).join(', ') || 'Untitled rule';
  return `${name} — ${actionLabel(r)}`;
}

/** A checkbox list of rules; returns the element and a getter for checked ids. */
export function ruleCheckboxes(
  rules: Rule[],
  groups: Group[],
  checked: string[],
  legend: string,
  onChange?: () => void,
): { el: HTMLElement; get: () => string[] } {
  const boxes: { id: string; input: HTMLInputElement }[] = [];
  const fs = h('fieldset', { class: 'rule-checks' }, h('legend', null, legend));
  if (rules.length === 0) fs.append(h('p', { class: 'hint' }, 'No rules yet. Add rules on the Rules page.'));
  for (const r of rules) {
    const id = uniqueId('rc');
    const input = h('input', { type: 'checkbox', id, checked: checked.includes(r.id), onchange: () => onChange?.() });
    boxes.push({ id: r.id, input });
    fs.append(h('div', null, h('label', { class: 'check', for: id }, input, ruleTitle(r, groups))));
  }
  return { el: fs, get: () => boxes.filter((b) => b.input.checked).map((b) => b.id) };
}

/** Labelled number input. */
export function numberInput(value: number, min: number, max: number, onInput?: () => void, step = 1): HTMLInputElement {
  return h('input', {
    type: 'number',
    class: 'input narrow',
    value: String(value),
    min,
    max,
    step,
    inputmode: 'numeric',
    oninput: () => onInput?.(),
  });
}

/** "2 h 30 min" */
export function durationText(min: number): string {
  const hrs = Math.floor(min / 60);
  const m = min % 60;
  if (hrs && m) return `${hrs} h ${m} min`;
  if (hrs) return `${hrs} h`;
  return `${m} min`;
}
