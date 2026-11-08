// Helpers shared by the Rules and Element hiding sections.
import type { BudgetView, Snapshot } from '../shared/messages.ts';
import { DAY_NAMES, isValidHHMM } from '../shared/schedule.ts';
import type { PlainTarget, PresetFile, Rule, Schedule, Target } from '../shared/types.ts';
import { parseTargetInput, targetKey } from '../shared/url.ts';
import { formatDuration, h, t, uniqueId } from '../ui/dom.ts';

/** Load rules.css once (options.html only links common.css and options.css). */
export function ensureRulesCss(): void {
  if (document.querySelector('link[data-fg="rules-css"]')) return;
  document.head.append(h('link', { rel: 'stylesheet', href: 'rules.css', dataset: { fg: 'rules-css' } }));
}

export type TargetMode = 'auto' | 'exact';

/** Plain targets as editable lines. Exact URLs get a leading "= " in auto mode. */
export function targetsToText(targets: Target[], mode: TargetMode): string {
  const lines: string[] = [];
  for (const tg of targets) {
    if (tg.kind === 'domain') lines.push(tg.host);
    else if (tg.kind === 'prefix') lines.push(tg.url);
    else if (tg.kind === 'exact') lines.push(mode === 'exact' ? tg.url : `= ${tg.url}`);
  }
  return lines.join('\n');
}

/** Pick the editor mode that round-trips a rule's targets. */
export function modeFor(targets: Target[]): TargetMode {
  const paths = targets.filter((x) => x.kind === 'prefix' || x.kind === 'exact');
  return paths.length > 0 && paths.every((x) => x.kind === 'exact') ? 'exact' : 'auto';
}

/** Whether all domain targets include subdomains (true when there are none). */
export function subdomainsFor(targets: Target[]): boolean {
  return targets.every((x) => x.kind !== 'domain' || x.includeSubdomains);
}

/**
 * Parse one site or URL per line (commas and spaces also separate entries).
 * A line starting with "=" is an exact URL.
 */
export function parseTargetsText(
  text: string,
  mode: TargetMode,
  includeSubdomains: boolean,
): { targets: PlainTarget[]; errors: string[] } {
  const targets: PlainTarget[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line) return;
    let entries: string[];
    let lineMode: 'auto' | 'exact' = mode;
    if (line.startsWith('=')) {
      lineMode = 'exact';
      entries = [line.slice(1).trim()];
    } else {
      entries = line.split(/[\s,]+/).filter(Boolean);
    }
    for (const e of entries) {
      const tg = parseTargetInput(e, lineMode);
      if (!tg) {
        errors.push(t('rules_err_target_line', 'Line') + ` ${i + 1}: “${e}” ` + t('rules_err_target_bad', 'is not a site or URL.'));
        continue;
      }
      const fixed: PlainTarget = tg.kind === 'domain' ? { ...tg, includeSubdomains } : tg;
      const k = targetKey(fixed);
      if (!seen.has(k)) {
        seen.add(k);
        targets.push(fixed);
      }
    }
  });
  return { targets, errors };
}

/** Validate CSS selectors, one per line. */
export function parseSelectors(text: string): { selectors: string[]; errors: string[] } {
  const selectors: string[] = [];
  const errors: string[] = [];
  const frag = document.createDocumentFragment();
  text.split(/\r?\n/).forEach((raw, i) => {
    const sel = raw.trim();
    if (!sel) return;
    try {
      frag.querySelector(sel);
      if (!selectors.includes(sel)) selectors.push(sel);
    } catch {
      errors.push(t('rules_err_target_line', 'Line') + ` ${i + 1}: “${sel}” ` + t('hide_err_selector_bad', 'is not a valid CSS selector.'));
    }
  });
  return { selectors, errors };
}

export function presetName(presetId: string | undefined, presets: PresetFile): string {
  if (!presetId) return '';
  return presets.presets.find((p) => p.id === presetId)?.name ?? presetId;
}

/** "Block", "Redirect to …", "Daily budget: 20 min", "Allow (exception)", "Hide 3 elements". */
export function actionSummary(rule: Rule, presets: PresetFile): string {
  if (rule.allow) return t('rules_action_allow', 'Allow (exception to other rules)');
  const a = rule.action;
  switch (a.kind) {
    case 'block':
      return t('rules_action_block', 'Block');
    case 'redirect':
      return t('rules_action_redirect', 'Redirect to') + ` ${a.url}`;
    case 'budget':
      return t('rules_action_budget', 'Daily budget:') + ` ${a.minutesPerDay} min`;
    case 'hide': {
      const parts: string[] = [];
      if (a.presetId) {
        const p = presets.presets.find((x) => x.id === a.presetId);
        const opts = p
          ? p.options.filter((o) => !a.presetOptions || a.presetOptions.includes(o.id)).map((o) => o.label)
          : a.presetOptions ?? [];
        parts.push(`${presetName(a.presetId, presets)}: ${opts.join(', ') || '—'}`);
      }
      if (a.selectors.length) parts.push(`${a.selectors.length} ` + t('hide_custom_selectors', 'custom selectors'));
      return t('rules_action_hide', 'Hide elements') + (parts.length ? ` (${parts.join('; ')})` : '');
    }
  }
}

/** Usage bar for a budget rule. */
export function budgetBar(view: BudgetView): HTMLElement {
  const pct = view.limitSec > 0 ? Math.min(100, (view.usedSec / view.limitSec) * 100) : 100;
  const cls = pct >= 100 ? 'bar over' : pct >= 80 ? 'bar warn' : 'bar';
  const label =
    `${formatDuration(view.usedSec)} ` + t('rules_budget_of', 'of') + ` ${formatDuration(view.limitSec)} ` + t('rules_budget_used', 'used today');
  return h(
    'div',
    { class: 'rule-budget' },
    h(
      'div',
      {
        class: cls,
        role: 'progressbar',
        'aria-valuemin': 0,
        'aria-valuemax': Math.round(view.limitSec / 60),
        'aria-valuenow': Math.round(view.usedSec / 60),
        'aria-label': label,
      },
      h('span', { style: `width:${pct.toFixed(1)}%` }),
    ),
    h('div', { class: 'hint' }, label),
  );
}

/** Status pills shared by rule rows. */
export function rulePills(rule: Rule, snap: Snapshot): HTMLElement[] {
  const pills: HTMLElement[] = [];
  const locked = snap.lockedRuleIds.includes(rule.id);
  // A Hard Lock forces a rule on, whatever its own switch says.
  if (locked) pills.push(h('span', { class: 'pill lock' }, t('rules_pill_locked_on', 'Locked on')));
  else if (!rule.enabled) pills.push(h('span', { class: 'pill' }, t('rules_pill_off', 'Off')));
  else if (snap.activeRuleIds.includes(rule.id)) pills.push(h('span', { class: 'pill on' }, t('rules_pill_active', 'Active now')));
  else pills.push(h('span', { class: 'pill' }, t('rules_pill_idle', 'Not active now')));
  if (rule.onlyDuringFocus) pills.push(h('span', { class: 'pill info' }, t('rules_pill_focus', 'Focus only')));
  if (rule.allow) pills.push(h('span', { class: 'pill info' }, t('rules_pill_allow', 'Exception')));
  if (snap.redirectLoopRuleIds.includes(rule.id))
    pills.push(h('span', { class: 'pill warn' }, t('rules_pill_loop', 'Redirect loop: shows block page')));
  return pills;
}

/** A labelled checkbox. */
export function checkbox(label: string, checked: boolean, onchange?: (v: boolean) => void): { el: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { type: 'checkbox', checked });
  if (onchange) input.addEventListener('change', () => onchange(input.checked));
  return { el: h('label', { class: 'check' }, input, label), input };
}

/** Error list announced to screen readers. */
export function errorBox(): { el: HTMLElement; show(errors: string[]): void } {
  const el = h('div', { class: 'rules-errors', role: 'alert', 'aria-live': 'assertive' });
  return {
    el,
    show(errors) {
      el.replaceChildren(...(errors.length ? [h('ul', null, errors.map((e) => h('li', { class: 'error-text' }, e)))] : []));
    },
  };
}

// ---- Schedule editor ----

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export interface ScheduleEditor {
  el: HTMLElement;
  read(): { schedule?: Schedule; errors: string[] };
}

/** Always / on a schedule (days + HH:mm windows; no windows = all day). */
export function scheduleEditor(initial: Schedule | undefined, onDirty: () => void): ScheduleEditor {
  const name = uniqueId('sched');
  const always = h('input', { type: 'radio', name, value: 'always', checked: !initial });
  const scheduled = h('input', { type: 'radio', name, value: 'scheduled', checked: !!initial });
  const start: Schedule = initial ?? { days: [1, 2, 3, 4, 5], windows: [{ start: '09:00', end: '17:00' }] };

  const dayBoxes = WEEK_ORDER.map((d) => {
    const input = h('input', { type: 'checkbox', checked: start.days.includes(d), value: String(d) });
    input.addEventListener('change', onDirty);
    return { d, input, el: h('label', { class: 'check day' }, input, DAY_NAMES[d]) };
  });

  const windowsHost = h('div', { class: 'stack windows' });
  const rows: { el: HTMLElement; s: HTMLInputElement; e: HTMLInputElement }[] = [];
  const addRow = (w: { start: string; end: string }) => {
    const s = h('input', { type: 'time', class: 'input narrow', value: w.start, 'aria-label': t('rules_win_from', 'From') });
    const e = h('input', { type: 'time', class: 'input narrow', value: w.end === '24:00' ? '00:00' : w.end, 'aria-label': t('rules_win_to', 'To') });
    s.addEventListener('input', onDirty);
    e.addEventListener('input', onDirty);
    const row = {
      s,
      e,
      el: h(
        'div',
        { class: 'row' },
        h('span', null, t('rules_win_from', 'From')),
        s,
        h('span', null, t('rules_win_to', 'To')),
        e,
        h(
          'button',
          {
            type: 'button',
            class: 'btn small ghost',
            'aria-label': t('rules_win_remove', 'Remove time window'),
            onclick: () => {
              rows.splice(rows.indexOf(row), 1);
              row.el.remove();
              onDirty();
            },
          },
          t('rules_remove', 'Remove'),
        ),
      ),
    };
    rows.push(row);
    windowsHost.append(row.el);
  };
  start.windows.forEach(addRow);

  const details = h(
    'div',
    { class: 'schedule-details' },
    h('fieldset', null, h('legend', null, t('rules_days', 'Days')), h('div', { class: 'row' }, dayBoxes.map((b) => b.el))),
    h(
      'fieldset',
      null,
      h('legend', null, t('rules_windows', 'Time windows')),
      windowsHost,
      h(
        'button',
        {
          type: 'button',
          class: 'btn small',
          onclick: () => {
            addRow({ start: '09:00', end: '17:00' });
            onDirty();
          },
        },
        t('rules_win_add', 'Add time window'),
      ),
      h(
        'div',
        { class: 'hint' },
        t('rules_win_hint', 'No time windows means all day on the chosen days. An end time earlier than the start runs past midnight.'),
      ),
    ),
  );
  const sync = () => {
    details.hidden = !scheduled.checked;
  };
  always.addEventListener('change', () => (sync(), onDirty()));
  scheduled.addEventListener('change', () => (sync(), onDirty()));
  sync();

  const el = h(
    'fieldset',
    null,
    h('legend', null, t('rules_when', 'When')),
    h(
      'div',
      { class: 'row' },
      h('label', { class: 'check' }, always, t('rules_always', 'Always')),
      h('label', { class: 'check' }, scheduled, t('rules_on_schedule', 'On a schedule')),
    ),
    details,
  );

  return {
    el,
    read() {
      if (always.checked) return { errors: [] };
      const errors: string[] = [];
      const days = dayBoxes.filter((b) => b.input.checked).map((b) => b.d).sort((a, b) => a - b);
      if (!days.length) errors.push(t('rules_err_days', 'Pick at least one day for the schedule.'));
      const windows = rows.map((r) => ({ start: r.s.value, end: r.e.value }));
      windows.forEach((w, i) => {
        if (!isValidHHMM(w.start) || !isValidHHMM(w.end))
          errors.push(t('rules_err_window', 'Time window') + ` ${i + 1}: ` + t('rules_err_window_bad', 'enter a start and end time.'));
      });
      return { schedule: { days, windows }, errors };
    },
  };
}
