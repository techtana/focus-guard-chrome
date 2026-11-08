// First-run page (FR-9): pick starter templates, choose a commitment level,
// read what each permission is for, finish. Minimum path: tick a template,
// press Finish — well under 2 minutes (FR-9.2).

import { newId } from '../shared/defaults.ts';
import { send, type Snapshot } from '../shared/messages.ts';
import type { CommitmentLevel, Rule } from '../shared/types.ts';
import { $, append, clear, field, h, t, toast, uniqueId } from '../ui/dom.ts';
import { applyChange } from '../ui/gate.ts';
import { buildTemplate, TEMPLATES, type TemplateId, type TemplateInfo, type TemplateOptions } from './templates.ts';

const app = $('#app');

interface TemplateState {
  info: TemplateInfo;
  selected: boolean;
  opts: TemplateOptions;
}

const state: { templates: TemplateState[]; level: CommitmentLevel; pw1: string; pw2: string; busy: boolean } = {
  templates: TEMPLATES.map((info) => ({
    info,
    selected: false,
    opts: {
      sitesText: info.defaultSites.join('\n'),
      start: '09:00',
      end: '12:00',
      workMin: 25,
      redirectUrl: '',
      minutesPerDay: 20,
    },
  })),
  level: 'none',
  pw1: '',
  pw2: '',
  busy: false,
};

const PERMISSIONS: [string, string][] = [
  ['declarativeNetRequest', 'Lets Chrome block or redirect a site before the page loads, using the rules you set. FocusGuard does not see the pages this happens to.'],
  ['storage', 'Saves your rules, settings and daily usage totals on this device.'],
  ['alarms', 'Wakes FocusGuard at the right moment: schedule changes, focus intervals, Hard Lock end, the daily budget reset.'],
  ['tabs', 'Reads the address of the tab you are on, so time budgets count the right site and open tabs are blocked when a rule starts.'],
  ['idle', 'Stops counting budget time when you step away from the computer.'],
  ['notifications', 'Tells you when a budget is about to run out and when a focus interval or break starts.'],
  ['scripting', 'Adds the element picker to a page when you ask for it, and sets up tabs that were open before installation.'],
  ['Access to all sites', 'Needed to hide parts of pages (like YouTube Shorts) and to block any site you choose. FocusGuard never reads page text or form data.'],
];

function textarea(value: string, onInput: (v: string) => void, label: string): HTMLTextAreaElement {
  const el = h('textarea', { class: 'input', rows: 5, spellcheck: 'false', 'aria-label': label });
  el.value = value;
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

function numberInput(value: number, min: number, max: number, onInput: (v: number) => void): HTMLInputElement {
  const el = h('input', { class: 'input narrow', type: 'number', min, max, step: 1, value: String(value), inputmode: 'numeric' });
  el.addEventListener('input', () => onInput(Number(el.value)));
  return el;
}

function timeInput(value: string, onInput: (v: string) => void): HTMLInputElement {
  const el = h('input', { class: 'input', type: 'time', value });
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

function templateOptions(ts: TemplateState): HTMLElement {
  const o = ts.opts;
  const sites = field('Sites, one per line', textarea(o.sitesText, (v) => (o.sitesText = v), `${ts.info.title} sites`));
  const parts: HTMLElement[] = [];
  switch (ts.info.id as TemplateId) {
    case 'deepWork':
      parts.push(
        h('p', { class: 'hint' }, 'Blocked Monday to Friday during these hours:'),
        h('div', { class: 'time-row' }, field('From', timeInput(o.start ?? '09:00', (v) => (o.start = v))), field('Until', timeInput(o.end ?? '12:00', (v) => (o.end = v)))),
        sites,
        h('p', { class: 'hint' }, 'Also adds “YouTube without rabbit holes”: Shorts, comments, recommendations and the home feed are hidden on YouTube at all times.'),
      );
      break;
    case 'pomodoro':
      parts.push(
        field('Focus interval (minutes)', numberInput(o.workMin ?? 25, 1, 240, (v) => (o.workMin = v)), 'Breaks are 5 minutes; every 4th break is 15. Change this later in Focus mode.'),
        sites,
        field('Send me here instead (optional)', h('input', { class: 'input', type: 'url', placeholder: 'https://your-course-portal.example', value: o.redirectUrl ?? '', oninput: (e: Event) => (o.redirectUrl = (e.target as HTMLInputElement).value) }), 'Leave empty to show the block page.'),
      );
      break;
    case 'socialDiet':
      parts.push(field('Minutes per site per day', numberInput(o.minutesPerDay ?? 20, 1, 720, (v) => (o.minutesPerDay = v)), 'You get a warning 2 minutes before the budget runs out.'), sites);
      break;
  }
  return h('div', { class: 'tpl-options' }, parts);
}

function templateCard(ts: TemplateState): HTMLElement {
  const id = uniqueId('tpl');
  const box = h('input', { type: 'checkbox', id, checked: ts.selected, 'aria-describedby': `${id}-sum` });
  box.addEventListener('change', () => {
    ts.selected = box.checked;
    render();
    $<HTMLInputElement>(`#${id}`).focus();
  });
  return h(
    'div',
    { class: `card tpl${ts.selected ? ' selected' : ''}` },
    h('label', { class: 'tpl-head', for: id }, box, h('span', null, h('span', { class: 'tpl-title' }, ts.info.title), h('br'), h('span', { class: 'tpl-persona' }, ts.info.persona))),
    h('p', { class: 'tpl-summary', id: `${id}-sum` }, ts.info.summary),
    ts.selected ? templateOptions(ts) : null,
  );
}

function levelOption(level: CommitmentLevel, title: string, desc: string): HTMLElement {
  const id = uniqueId('lvl');
  const radio = h('input', { type: 'radio', name: 'level', id, value: level, checked: state.level === level });
  radio.addEventListener('change', () => {
    state.level = level;
    render();
    $<HTMLInputElement>(`#${id}`).focus();
  });
  return h('label', { class: `level${state.level === level ? ' selected' : ''}`, for: id }, radio, h('span', null, h('strong', null, title), h('span', { class: 'hint' }, desc)));
}

function commitmentStep(): HTMLElement {
  const card = h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'levels', role: 'radiogroup', 'aria-label': 'Commitment level' },
      levelOption('none', 'None', 'Change or remove rules any time. Good for getting started.'),
      levelOption('password', 'Password', 'Loosening a rule asks for a password. Works best if someone else sets it for you.'),
      levelOption('challenge', 'Challenge', 'Loosening a rule means typing a long random passage exactly, with paste turned off — or waiting out a delay. Focus sessions cannot be ended early.'),
    ),
    h('p', { class: 'hint' }, 'Adding rules or making them stricter never needs a password or challenge. You can change this later in Settings.'),
  );
  if (needsNewPassword()) {
    const p1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', value: state.pw1, oninput: (e: Event) => (state.pw1 = (e.target as HTMLInputElement).value) });
    const p2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', value: state.pw2, oninput: (e: Event) => (state.pw2 = (e.target as HTMLInputElement).value) });
    card.append(h('div', { class: 'pw-fields' }, field('Password', p1, 'At least 8 characters.'), field('Repeat password', p2)));
  }
  return card;
}

function permissionsStep(): HTMLElement {
  return h(
    'div',
    { class: 'card' },
    h('ul', { class: 'perms' }, PERMISSIONS.map(([name, why]) => h('li', null, h('code', null, name), h('span', null, why)))),
    h(
      'p',
      { class: 'privacy' },
      h('strong', null, 'Privacy: '),
      'Everything stays on this device. FocusGuard keeps only domains, durations and counts — never page content, form data or full addresses — and has no analytics or tracking.',
    ),
  );
}

let errors: string[] = [];

/** A password is asked for only when switching to Password (keeping an existing one needs nothing). */
function needsNewPassword(): boolean {
  return state.level === 'password' && current?.config.settings.commitment !== 'password';
}

function render() {
  const snap = current;
  clear(app);
  append(app, [
    h('header', { class: 'ob-header' }, h('img', { src: 'icons/icon128.png', alt: '', width: 48, height: 48 }), h('h1', null, t('onboarding_title', 'Welcome to FocusGuard'))),
    h('p', { class: 'ob-lead' }, t('onboarding_lead', 'Keep the useful parts of the web and lose the rabbit holes. Pick a starting point — you can change everything later.')),
    snap?.config.onboarded ? h('p', { class: 'card already' }, 'You have already set up FocusGuard. Templates you pick here are added to your existing rules.') : null,
    errors.length
      ? h('div', { class: 'errors', role: 'alert', tabindex: '-1', id: 'errors' }, h('strong', null, 'Please fix:'), h('ul', null, errors.map((e) => h('li', null, e))))
      : null,
    h(
      'section',
      { class: 'ob-step', 'aria-labelledby': 'step1' },
      h('h2', { id: 'step1' }, h('span', { class: 'step-num', 'aria-hidden': 'true' }, '1'), t('onboarding_step1', 'Pick one or more starter templates')),
      h('div', { class: 'templates' }, state.templates.map(templateCard)),
      h('p', { class: 'hint' }, 'Or pick none to start from scratch with an empty rule list.'),
    ),
    h(
      'section',
      { class: 'ob-step', 'aria-labelledby': 'step2' },
      h('h2', { id: 'step2' }, h('span', { class: 'step-num', 'aria-hidden': 'true' }, '2'), t('onboarding_step2', 'How firm should FocusGuard be?')),
      commitmentStep(),
    ),
    h(
      'section',
      { class: 'ob-step', 'aria-labelledby': 'step3' },
      h('h2', { id: 'step3' }, h('span', { class: 'step-num', 'aria-hidden': 'true' }, '3'), t('onboarding_step3', 'What FocusGuard can access, and why')),
      permissionsStep(),
    ),
    h(
      'div',
      { class: 'finish row between' },
      h('span', { class: 'muted' }, summaryText()),
      h('button', { class: 'btn primary', type: 'button', disabled: state.busy, onclick: () => void finish() }, state.busy ? 'Setting up…' : t('onboarding_finish', 'Finish setup')),
    ),
  ]);
}

function summaryText(): string {
  const n = state.templates.filter((x) => x.selected).length;
  return n ? `${n} template${n > 1 ? 's' : ''} selected` : 'No template selected: you will start with no rules';
}

async function finish() {
  errors = [];
  const now = Date.now();
  const rules: Rule[] = [];
  let workMin: number | undefined;
  for (const ts of state.templates.filter((x) => x.selected)) {
    const r = buildTemplate(ts.info.id, ts.opts, now, newId);
    errors.push(...r.errors.map((e) => `${ts.info.title}: ${e}`));
    rules.push(...r.rules);
    if (r.focusConfig?.workMin) workMin = r.focusConfig.workMin;
  }
  if (needsNewPassword()) {
    if (state.pw1.length < 8) errors.push('The password needs at least 8 characters.');
    else if (state.pw1 !== state.pw2) errors.push('The two passwords do not match.');
  }
  if (errors.length) {
    render();
    document.getElementById('errors')?.focus();
    return;
  }

  state.busy = true;
  render();
  try {
    const snap = await send({ type: 'getState' });
    if (rules.length) {
      const res = await applyChange({ kind: 'rules.add', rules });
      if (!res.ok) throw new Error(res.message);
    }
    if (workMin !== undefined && workMin !== snap.config.focusConfig.workMin) {
      const res = await applyChange({ kind: 'focus.config', config: { ...snap.config.focusConfig, workMin } });
      if (!res.ok) throw new Error(res.message);
    }
    if (state.level !== snap.config.settings.commitment) {
      const res = await applyChange({ kind: 'commitment.set', level: state.level, newPassword: state.level === 'password' ? state.pw1 : undefined });
      if (!res.ok && res.error !== 'gate') throw new Error(res.message);
    }
    const done = await applyChange({ kind: 'onboarding.done' });
    if (!done.ok) throw new Error(done.message);
    toast(rules.length ? `Added ${rules.length} rule${rules.length > 1 ? 's' : ''}.` : 'All set.', 'success');
    location.href = 'options.html#rules';
  } catch (err) {
    state.busy = false;
    errors = [err instanceof Error ? err.message : String(err)];
    render();
    document.getElementById('errors')?.focus();
  }
}

let current: Snapshot | null = null;

(async () => {
  try {
    current = await send({ type: 'getState' });
    state.level = current.config.settings.commitment;
  } catch {
    current = null;
  }
  render();
  app.focus();
})();
