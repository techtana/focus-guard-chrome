// Hard Lock (FR-3): start a non-cancelable lock, extend or add to active locks,
// and manage recurring locks.
import { newId } from '../../shared/defaults.ts';
import { DAY_NAMES, isValidHHMM } from '../../shared/schedule.ts';
import type { Config, HardLock, LockSchedule } from '../../shared/types.ts';
import { targetLabel } from '../../shared/url.ts';
import { clear, field, formatClock, formatCountdown, h, t, uniqueId } from '../../ui/dom.ts';
import { applyChange, confirmDialog } from '../../ui/gate.ts';
import {
  activeLocksOf,
  durationText,
  ensureCommitCss,
  numberInput,
  parseSitesText,
  ruleCheckboxes,
  targetsToText,
} from '../commit-common.ts';
import type { Section, SectionCtx } from '../section.ts';

const MIN_LOCK = 15;
const MAX_LOCK = 24 * 60;

function lockedSummary(lock: { ruleIds: string[]; targets: HardLock['targets'] }, config: Config): string[] {
  const out: string[] = [];
  for (const t0 of lock.targets) out.push(targetLabel(t0, config.groups));
  for (const id of lock.ruleIds) {
    const r = config.rules.find((x) => x.id === id);
    out.push(r ? `Rule: ${r.name || 'Untitled rule'}` : 'Rule: (deleted)');
  }
  return out;
}

/** Hours + minutes inputs with quick picks. */
function durationPicker(initialMin: number, onChange: () => void) {
  const hrs = numberInput(Math.floor(initialMin / 60), 0, 24, onChange);
  const mins = numberInput(initialMin % 60, 0, 59, onChange, 5);
  const set = (m: number) => {
    hrs.value = String(Math.floor(m / 60));
    mins.value = String(m % 60);
    onChange();
  };
  const picks = h(
    'div',
    { class: 'row quick-picks', role: 'group', 'aria-label': 'Quick durations' },
    [30, 60, 120, 180, 240].map((m) =>
      h('button', { class: 'btn small', type: 'button', onclick: () => set(m) }, durationText(m)),
    ),
  );
  const el = h('div', null, h('div', { class: 'row' }, field('Hours', hrs), field('Minutes', mins)), picks);
  return { el, get: () => (Number(hrs.value) || 0) * 60 + (Number(mins.value) || 0) };
}

function renderActive(root: HTMLElement, locks: HardLock[], config: Config, ctx: SectionCtx) {
  const card = h('div', { class: 'card lock-card' }, h('h2', null, t('lock_active_title', 'Active Hard Lock')));
  root.append(card);
  for (const lock of locks) {
    const countdown = h('div', { class: 'countdown-big' }, formatCountdown(lock.endsAt - Date.now()));
    let refreshed = false;
    ctx.every(1000, () => {
      const left = lock.endsAt - Date.now();
      countdown.textContent = formatCountdown(left);
      if (left <= 0 && !refreshed) {
        refreshed = true;
        void ctx.refresh();
      }
    });
    const extend = (minutes: number) =>
      applyChange({ kind: 'lock.extend', lockId: lock.id, minutes }, { successMessage: `Lock extended by ${durationText(minutes)}.` });

    const addArea = h('div', { hidden: true, class: 'stack' });
    const addSites = h('textarea', { class: 'input', rows: 3, placeholder: 'news.ycombinator.com', oninput: () => ctx.setDirty(true) });
    const otherRules = config.rules.filter((r) => !lock.ruleIds.includes(r.id));
    const addRules = ruleCheckboxes(otherRules, config.groups, [], 'Also lock these rules', () => ctx.setDirty(true));
    const addErr = h('div', { class: 'error-text', role: 'alert' });
    addArea.append(
      field('Sites to add (one per line)', addSites),
      addRules.el,
      addErr,
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            onclick: async () => {
              const { targets, invalid } = parseSitesText(addSites.value);
              const ruleIds = addRules.get();
              if (invalid.length) return void (addErr.textContent = `Not a valid site: ${invalid.join(', ')}`);
              if (!targets.length && !ruleIds.length) return void (addErr.textContent = 'Add at least one site or rule.');
              const res = await applyChange({ kind: 'lock.add', lockId: lock.id, ruleIds, targets }, { successMessage: 'Added to the lock.' });
              if (res.ok) {
                ctx.setDirty(false);
                await ctx.refresh();
              }
            },
          },
          'Add to lock',
        ),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              addArea.hidden = true;
              ctx.setDirty(false);
            },
          },
          'Cancel',
        ),
      ),
    );

    card.append(
      h(
        'div',
        { class: 'lock-item' },
        h('p', null, h('strong', null, `Ends at ${formatClock(lock.endsAt)}`), lock.scheduleId ? h('span', { class: 'pill info' }, ' Recurring') : null),
        countdown,
        h('p', { class: 'muted' }, 'Locked: ', lockedSummary(lock, config).join(', ') || '—'),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: () => extend(15) }, '+15 min'),
          h('button', { class: 'btn', type: 'button', onclick: () => extend(30) }, '+30 min'),
          h('button', { class: 'btn', type: 'button', onclick: () => extend(60) }, '+1 h'),
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              'aria-expanded': 'false',
              onclick: (e: Event) => {
                addArea.hidden = !addArea.hidden;
                (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(!addArea.hidden));
              },
            },
            'Add sites or rules',
          ),
        ),
        addArea,
      ),
    );
  }
  card.append(h('p', { class: 'hint' }, t('lock_active_hint', 'You can extend a lock or add to it, but not end, shorten or loosen it.')));
}

function renderStart(root: HTMLElement, config: Config, ctx: SectionCtx) {
  const dirty = () => ctx.setDirty(true);
  const dur = durationPicker(120, dirty);
  const sites = h('textarea', { class: 'input', rows: 5, id: 'lock-sites', placeholder: 'reddit.com\nyoutube.com\nx.com', oninput: dirty });
  const rules = ruleCheckboxes(config.rules, config.groups, [], 'Lock these existing rules (they stay on, ignoring schedules)', dirty);
  const err = h('div', { class: 'error-text', role: 'alert' });
  const start = async () => {
    const minutes = dur.get();
    const { targets, invalid } = parseSitesText(sites.value);
    const ruleIds = rules.get();
    if (minutes < MIN_LOCK || minutes > MAX_LOCK) return void (err.textContent = 'Pick a duration between 15 minutes and 24 hours.');
    if (invalid.length) return void (err.textContent = `Not a valid site: ${invalid.join(', ')}`);
    if (!targets.length && !ruleIds.length) return void (err.textContent = 'Add at least one site or pick a rule to lock.');
    err.textContent = '';
    const endsAt = Date.now() + minutes * 60_000;
    const what = [targets.length ? `${targets.length} site${targets.length > 1 ? 's' : ''}` : '', ruleIds.length ? `${ruleIds.length} rule${ruleIds.length > 1 ? 's' : ''}` : '']
      .filter(Boolean)
      .join(' and ');
    const ok = await confirmDialog(
      t('lock_confirm_title', 'Start a Hard Lock?'),
      `This locks ${what} for ${durationText(minutes)}, until ${formatClock(endsAt)}. You cannot end, shorten or loosen it until then — not from FocusGuard, and not by restarting Chrome or reloading the extension.`,
      t('lock_confirm', 'Start Hard Lock'),
      true,
    );
    if (!ok) return;
    const res = await applyChange({ kind: 'lock.start', durationMin: minutes, ruleIds, targets }, { successMessage: 'Hard Lock started.' });
    if (res.ok) {
      ctx.setDirty(false);
      await ctx.refresh();
    }
  };
  root.append(
    h(
      'div',
      { class: 'card' },
      h('h2', null, t('lock_start_title', 'Start a Hard Lock')),
      h('p', { class: 'muted' }, t('lock_start_intro', 'A Hard Lock blocks sites for a fixed time and cannot be cancelled. Use it for deep work or deadline days.')),
      h('fieldset', null, h('legend', null, 'Duration (15 min to 24 h)'), dur.el),
      field('Sites to block (one per line)', sites, 'A domain (reddit.com), a path (youtube.com/shorts), or =exact URL.'),
      rules.el,
      err,
      h('div', { class: 'row' }, h('button', { class: 'btn danger', type: 'button', onclick: start }, t('lock_start', 'Start Hard Lock…'))),
    ),
  );
}

function scheduleEditor(host: HTMLElement, config: Config, ctx: SectionCtx, existing?: LockSchedule) {
  clear(host);
  host.hidden = false;
  ctx.setDirty(true);
  const s: LockSchedule = existing ?? {
    id: newId(),
    name: '',
    days: [1, 2, 3, 4, 5],
    start: '09:00',
    durationMin: 120,
    ruleIds: [],
    targets: [],
    enabled: true,
  };
  const name = h('input', { class: 'input', value: s.name ?? '', placeholder: 'Morning deep work' });
  const dayBoxes = DAY_NAMES.map((d, i) => {
    const id = uniqueId('day');
    const input = h('input', { type: 'checkbox', id, checked: s.days.includes(i) });
    return { i, input, el: h('label', { class: 'check day', for: id }, input, d) };
  });
  const startTime = h('input', { type: 'time', class: 'input narrow', value: s.start });
  const dur = durationPicker(s.durationMin, () => {});
  const sites = h('textarea', { class: 'input', rows: 4 });
  sites.value = targetsToText(s.targets);
  const rules = ruleCheckboxes(config.rules, config.groups, s.ruleIds, 'Lock these rules');
  const enabled = h('input', { type: 'checkbox', id: uniqueId('en'), checked: s.enabled });
  const err = h('div', { class: 'error-text', role: 'alert' });
  const close = () => {
    clear(host);
    host.hidden = true;
    ctx.setDirty(false);
  };
  const save = async () => {
    const days = dayBoxes.filter((d) => d.input.checked).map((d) => d.i);
    const minutes = dur.get();
    const { targets, invalid } = parseSitesText(sites.value);
    const groupTargets = s.targets.filter((x) => x.kind === 'group');
    if (!days.length) return void (err.textContent = 'Pick at least one day.');
    if (!isValidHHMM(startTime.value)) return void (err.textContent = 'Enter a start time.');
    if (minutes < MIN_LOCK || minutes > MAX_LOCK) return void (err.textContent = 'Duration must be 15 minutes to 24 hours.');
    if (invalid.length) return void (err.textContent = `Not a valid site: ${invalid.join(', ')}`);
    const ruleIds = rules.get();
    if (!targets.length && !groupTargets.length && !ruleIds.length) return void (err.textContent = 'Add at least one site or rule.');
    const next: LockSchedule = {
      ...s,
      name: name.value.trim(),
      days,
      start: startTime.value,
      durationMin: minutes,
      targets: [...targets, ...groupTargets],
      ruleIds,
      enabled: enabled.checked,
    };
    const res = await applyChange({ kind: 'lockSchedule.upsert', schedule: next }, { successMessage: 'Recurring lock saved.' });
    if (res.ok) {
      close();
      await ctx.refresh();
    }
  };
  host.append(
    h('h3', null, existing ? 'Edit recurring lock' : 'New recurring lock'),
    field('Name (optional)', name),
    h('fieldset', null, h('legend', null, 'Days'), h('div', { class: 'row days' }, dayBoxes.map((d) => d.el))),
    field('Starts at', startTime),
    h('fieldset', null, h('legend', null, 'Duration'), dur.el),
    field('Sites to block (one per line)', sites),
    rules.el,
    h('label', { class: 'check', for: enabled.id }, enabled, 'Enabled'),
    err,
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Save'),
      h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
    ),
    h('p', { class: 'hint' }, 'Removing days, sites or time, or turning a recurring lock off, counts as loosening and needs your commitment check.'),
  );
  name.focus();
}

function renderSchedules(root: HTMLElement, config: Config, locks: HardLock[], ctx: SectionCtx) {
  const editor = h('div', { class: 'card inset', hidden: true });
  const list = config.lockSchedules;
  const table =
    list.length === 0
      ? h('p', { class: 'muted' }, 'No recurring locks yet.')
      : h(
          'table',
          { class: 'list' },
          h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'When'), h('th', null, 'Locks'), h('th', null, 'Status'), h('th', null, h('span', { class: 'sr-only' }, 'Actions')))),
          h(
            'tbody',
            null,
            list.map((s) => {
              const running = locks.some((l) => l.scheduleId === s.id);
              return h(
                'tr',
                null,
                h('td', null, s.name || 'Recurring lock'),
                h('td', null, `${[...s.days].sort().map((d) => DAY_NAMES[d]).join(', ')} at ${s.start}, ${durationText(s.durationMin)}`),
                h('td', null, lockedSummary(s, config).join(', ')),
                h('td', null, running ? h('span', { class: 'pill lock' }, 'Running') : s.enabled ? h('span', { class: 'pill on' }, 'On') : h('span', { class: 'pill' }, 'Off')),
                h(
                  'td',
                  { class: 'row' },
                  h('button', { class: 'btn small', type: 'button', onclick: () => scheduleEditor(editor, config, ctx, s) }, 'Edit'),
                  h(
                    'button',
                    {
                      class: 'btn small',
                      type: 'button',
                      onclick: async () => {
                        if (await confirmDialog('Delete recurring lock?', `"${s.name || 'Recurring lock'}" will no longer start.`, 'Delete', true)) {
                          await applyChange({ kind: 'lockSchedule.delete', id: s.id }, { successMessage: 'Recurring lock deleted.' });
                        }
                      },
                    },
                    'Delete',
                  ),
                ),
              );
            }),
          ),
        );
  root.append(
    h(
      'div',
      { class: 'card' },
      h('h2', null, t('lock_sched_title', 'Recurring locks')),
      h('p', { class: 'muted' }, t('lock_sched_intro', 'Start a Hard Lock automatically on chosen days, for example weekdays 09:00 for 2 hours.')),
      table,
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => scheduleEditor(editor, config, ctx) }, 'New recurring lock')),
      editor,
    ),
  );
}

const section: Section = {
  id: 'lock',
  title: t('lock_title', 'Hard Lock'),
  render(root, snap, ctx) {
    ensureCommitCss();
    const locks = activeLocksOf(snap.runtime, snap.now);
    if (locks.length) renderActive(root, locks, snap.config, ctx);
    renderStart(root, snap.config, ctx);
    renderSchedules(root, snap.config, locks, ctx);
    root.append(
      h(
        'div',
        { class: 'card note' },
        h('h2', null, t('lock_honest_title', 'What a Hard Lock can and cannot do')),
        h(
          'p',
          null,
          t(
            'lock_honest_body',
            'No extension can stop itself from being disabled or removed on chrome://extensions. FocusGuard does not pretend otherwise. What it does: the lock survives browser restarts, extension reloads and updates, and re-applies as soon as Chrome or the extension starts again.',
          ),
        ),
      ),
    );
  },
};
export default section;
