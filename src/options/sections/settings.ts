// Settings: commitment level (FR-4), general settings, pause, permissions and privacy.
import type { SettingsPatch } from '../../shared/changes.ts';
import type { Snapshot } from '../../shared/messages.ts';
import { isValidHHMM, startOfLocalDay } from '../../shared/schedule.ts';
import type { CommitmentLevel } from '../../shared/types.ts';
import { isValidRedirectUrl } from '../../shared/url.ts';
import { field, h, t, toast, uniqueId } from '../../ui/dom.ts';
import { applyChange } from '../../ui/gate.ts';
import { activeLocksOf, ensureCommitCss, numberInput } from '../commit-common.ts';
import type { Section, SectionCtx } from '../section.ts';

const LEVELS: { level: CommitmentLevel; label: string; desc: string }[] = [
  { level: 'none', label: 'None', desc: 'Changes apply immediately. Good for trying FocusGuard out.' },
  {
    level: 'password',
    label: 'Password',
    desc: 'Loosening a rule needs a password. Works best when someone else sets it for you.',
  },
  {
    level: 'challenge',
    label: 'Challenge',
    desc: 'Loosening a rule means typing a random passage exactly, with paste turned off, or waiting out a delay. Focus sessions cannot end early.',
  },
];

function commitmentCard(snap: Snapshot, ctx: SectionCtx): HTMLElement {
  const s = snap.config.settings;
  const lockActive = activeLocksOf(snap.runtime, snap.now).length > 0;
  const name = uniqueId('lvl');
  const radios = LEVELS.map((l) => {
    const id = uniqueId('lvl');
    const input = h('input', { type: 'radio', name, id, value: l.level, checked: s.commitment === l.level, onchange: () => update() });
    return {
      l,
      input,
      el: h(
        'div',
        { class: 'radio-row' },
        h('label', { class: 'check', for: id }, input, h('strong', null, l.label)),
        h('div', { class: 'hint', id: `${id}-d` }, l.desc),
      ),
    };
  });
  radios.forEach((r) => r.input.setAttribute('aria-describedby', `${r.input.id}-d`));
  const pw1 = h('input', { type: 'password', class: 'input', autocomplete: 'new-password', minlength: 8 });
  const pw2 = h('input', { type: 'password', class: 'input', autocomplete: 'new-password', minlength: 8 });
  const pwBox = h('div', { class: 'stack-sm' }, field('New password (at least 8 characters)', pw1), field('Repeat password', pw2));
  const err = h('div', { class: 'error-text', role: 'alert' });
  const applyBtn = h('button', { class: 'btn primary', type: 'button' }, 'Apply');
  const selected = () => radios.find((r) => r.input.checked)?.l.level ?? s.commitment;
  let changingPw = false;
  const changePwBtn = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      hidden: s.commitment !== 'password',
      onclick: () => {
        changingPw = true;
        update();
        pw1.focus();
      },
    },
    'Change password',
  );
  function update() {
    const lvl = selected();
    pwBox.hidden = !(lvl === 'password' && (s.commitment !== 'password' || changingPw));
    applyBtn.hidden = lvl === s.commitment && !changingPw;
    ctx.setDirty(lvl !== s.commitment || changingPw);
  }
  pw1.addEventListener('input', () => ctx.setDirty(true));
  applyBtn.addEventListener('click', async () => {
    const level = selected();
    let newPassword: string | undefined;
    if (!pwBox.hidden) {
      if (pw1.value.length < 8) return void (err.textContent = 'The password must have at least 8 characters.');
      if (pw1.value !== pw2.value) return void (err.textContent = 'The passwords do not match.');
      newPassword = pw1.value;
    }
    err.textContent = '';
    const res = await applyChange({ kind: 'commitment.set', level, newPassword }, { successMessage: 'Commitment level saved.' });
    if (res.ok) {
      ctx.setDirty(false);
      await ctx.refresh();
    }
  });
  update();
  return h(
    'div',
    { class: 'card' },
    h('h2', null, t('settings_commit_title', 'Commitment level')),
    h('p', { class: 'muted' }, t('settings_commit_intro', 'How hard should it be to loosen your own rules? Tightening rules never needs a check.')),
    h('fieldset', null, h('legend', null, 'Level'), radios.map((r) => r.el)),
    pwBox,
    err,
    h('div', { class: 'row' }, applyBtn, changePwBtn),
    lockActive ? h('p', { class: 'hint' }, 'A Hard Lock is active, so the level cannot be lowered until it ends.') : null,
  );
}

function generalCard(snap: Snapshot, ctx: SectionCtx): HTMLElement {
  const s = snap.config.settings;
  const dirty = () => ctx.setDirty(true);
  const chLen = numberInput(s.challengeLength, 100, 1000, dirty, 10);
  const chDelay = numberInput(s.challengeDelayMin, 1, 60, dirty);
  const reset = h('input', { type: 'time', class: 'input narrow', value: s.resetTime, oninput: dirty });
  const idle = numberInput(s.idleSeconds, 15, 600, dirty);
  const perVisit = numberInput(s.minutesPerBlockedAttempt, 0, 60, dirty);
  const uninstall = h('input', { type: 'url', class: 'input', value: s.uninstallUrl, placeholder: 'https://example.com/i-removed-focusguard', oninput: dirty });
  const err = h('div', { class: 'error-text', role: 'alert' });
  const save = async () => {
    const n = (el: HTMLInputElement) => Number(el.value);
    const inRange = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
    if (!inRange(n(chLen), 100, 1000)) return void (err.textContent = 'Challenge length must be 100–1000 characters.');
    if (!inRange(n(chDelay), 1, 60)) return void (err.textContent = 'Delay must be 1–60 minutes.');
    if (!isValidHHMM(reset.value)) return void (err.textContent = 'Enter a reset time.');
    if (!inRange(n(idle), 15, 600)) return void (err.textContent = 'Idle threshold must be 15–600 seconds.');
    if (!inRange(n(perVisit), 0, 60)) return void (err.textContent = 'Minutes per blocked visit must be 0–60.');
    const url = uninstall.value.trim();
    if (url && !isValidRedirectUrl(url)) return void (err.textContent = 'The accountability page must be an http or https URL.');
    err.textContent = '';
    const patch: SettingsPatch = {};
    if (n(chLen) !== s.challengeLength) patch.challengeLength = n(chLen);
    if (n(chDelay) !== s.challengeDelayMin) patch.challengeDelayMin = n(chDelay);
    if (reset.value !== s.resetTime) patch.resetTime = reset.value;
    if (n(idle) !== s.idleSeconds) patch.idleSeconds = n(idle);
    if (n(perVisit) !== s.minutesPerBlockedAttempt) patch.minutesPerBlockedAttempt = n(perVisit);
    if (url !== s.uninstallUrl) patch.uninstallUrl = url;
    if (Object.keys(patch).length === 0) {
      ctx.setDirty(false);
      toast('Nothing changed.');
      return;
    }
    const res = await applyChange({ kind: 'settings.update', patch }, { successMessage: 'Settings saved.' });
    if (res.ok) {
      ctx.setDirty(false);
      await ctx.refresh();
    }
  };
  return h(
    'div',
    { class: 'card' },
    h('h2', null, t('settings_general_title', 'General')),
    h(
      'div',
      { class: 'grid-2' },
      field('Daily reset time', reset, 'Time budgets start over at this local time.'),
      field('Idle after (seconds)', idle, 'Time stops counting after this long without mouse or keyboard input.'),
      field('Challenge length (characters)', chLen, 'Length of the passage to type.'),
      field('Challenge delay (minutes)', chDelay, 'The wait-instead alternative to typing.'),
      field('Minutes saved per blocked visit', perVisit, 'Used to estimate “time saved” in Insights.'),
    ),
    field(
      'Accountability page (opens if FocusGuard is removed)',
      uninstall,
      'Optional. Chrome opens this page when the extension is uninstalled, for example a note to a friend or a form.',
    ),
    err,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Save settings')),
    h('p', { class: 'hint' }, 'Changing the reset time, lowering the idle threshold, the challenge length or delay, or changing the accountability page counts as loosening.'),
  );
}

function pauseCard(snap: Snapshot): HTMLElement {
  const { runtime, now } = snap;
  const paused = runtime.pausedUntil !== null && now < runtime.pausedUntil;
  const pause = (minutes: number) =>
    applyChange({ kind: 'pause', minutes }, { successMessage: 'FocusGuard paused. Hard Locks still apply.' });
  const untilTomorrow = () => Math.max(1, Math.ceil((startOfLocalDay(Date.now(), 1) - Date.now()) / 60_000));
  return h(
    'div',
    { class: 'card' },
    h('h2', null, t('settings_pause_title', 'Pause FocusGuard')),
    paused
      ? [
          h('p', null, `Paused until ${new Date(runtime.pausedUntil!).toLocaleString()}. Rules are off except Hard Locks.`),
          h(
            'button',
            { class: 'btn primary', type: 'button', onclick: () => applyChange({ kind: 'pause', minutes: null }, { successMessage: 'FocusGuard resumed.' }) },
            'Resume now',
          ),
        ]
      : [
          h('p', { class: 'muted' }, 'Turn off all rules for a while. Hard Locks keep running. Pausing counts as loosening, so your commitment check applies.'),
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn', type: 'button', onclick: () => pause(15) }, '15 minutes'),
            h('button', { class: 'btn', type: 'button', onclick: () => pause(60) }, '1 hour'),
            h('button', { class: 'btn', type: 'button', onclick: () => pause(untilTomorrow()) }, 'Until tomorrow'),
          ),
        ],
  );
}

const PERMISSIONS: [string, string][] = [
  ['declarativeNetRequest', 'Blocks and redirects sites before the page loads, inside Chrome, without reading the page.'],
  ['storage', 'Saves your rules, settings and usage numbers on this device.'],
  ['alarms', 'Runs timers for schedules, budgets, focus sessions and locks, even after Chrome restarts.'],
  ['tabs', 'Sees the address of the active tab to count time per site and to block tabs that are already open.'],
  ['idle', 'Stops counting time when you step away from the computer.'],
  ['notifications', 'Tells you when a budget is almost used up or a focus interval changes.'],
  ['scripting', 'Adds the element picker to a page when you ask for it, and hides elements in tabs that were open before install.'],
  ['Access to all sites', 'Needed to hide page elements (Shorts, feeds, comments) on the sites you choose.'],
];

function aboutCards(): HTMLElement[] {
  return [
    h(
      'div',
      { class: 'card' },
      h('h2', null, t('settings_privacy_title', 'Privacy')),
      h(
        'p',
        null,
        'FocusGuard is local-first. Your rules and usage numbers stay on this device. It stores only domains, durations and counts — never page text, form data or full addresses with query strings. It has no analytics and sends nothing to any server.',
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', null, t('settings_perm_title', 'Permissions and why they are needed')),
      h(
        'table',
        { class: 'list' },
        h('thead', null, h('tr', null, h('th', null, 'Permission'), h('th', null, 'Why'))),
        h('tbody', null, PERMISSIONS.map(([p, why]) => h('tr', null, h('td', null, h('code', null, p)), h('td', null, why)))),
      ),
    ),
    h(
      'div',
      { class: 'card note' },
      h('h2', null, t('settings_uninstall_title', 'Uninstall friction')),
      h(
        'p',
        null,
        'Chrome lets you disable or remove any extension at chrome://extensions, and no extension can prevent that. FocusGuard adds friction instead: pausing or loosening goes through your commitment level, Hard Locks re-apply whenever Chrome or the extension restarts, and you can set an accountability page that opens if FocusGuard is removed.',
      ),
    ),
  ];
}

const section: Section = {
  id: 'settings',
  title: t('settings_title', 'Settings'),
  render(root, snap, ctx) {
    ensureCommitCss();
    root.append(commitmentCard(snap, ctx), generalCard(snap, ctx), pauseCard(snap), ...aboutCards());
  },
};
export default section;
