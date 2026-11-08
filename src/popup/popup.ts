// Toolbar popup: status of the current site, quick actions, focus session and Hard Lock.
import { newId } from '../shared/defaults.ts';
import { phaseLabel } from '../shared/focus.ts';
import { send, type Snapshot, type TabStatus } from '../shared/messages.ts';
import { activeLocks, isPaused } from '../shared/rules.ts';
import type { Rule } from '../shared/types.ts';
import { $, clear, field, formatClock, formatCountdown, formatDuration, h, onStateChange, t, toast } from '../ui/dom.ts';
import { applyChange } from '../ui/gate.ts';

/** t() plus $1..$9 substitution in the English fallback. */
function tf(key: string, fallback: string, ...subs: string[]): string {
  return t(key, fallback, subs).replace(/\$(\d)/g, (_, n) => subs[Number(n) - 1] ?? '');
}

const app = $('#app');
let tab: chrome.tabs.Tab | undefined;
let snap: Snapshot | null = null;
let status: TabStatus | null = null;
let budgetFormOpen = false;

interface Countdown {
  el: HTMLElement;
  sr: HTMLElement;
  at: number;
  lastMin: number;
}
let countdowns: Countdown[] = [];
let refreshing = false;

async function load() {
  if (refreshing) return;
  refreshing = true;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    snap = await send({ type: 'getState' });
    status = tab?.id !== undefined ? await send({ type: 'tabStatus', tabId: tab.id }) : null;
    render();
  } catch (err) {
    clear(app);
    app.append(h('p', { class: 'error-text' }, tf('popup_loadError', 'FocusGuard could not load: $1', String(err))));
  } finally {
    refreshing = false;
  }
}

function openOptions(section?: string) {
  void send({ type: 'openOptions', section }).then(() => window.close());
}

function countdown(at: number, cls = ''): HTMLElement {
  const el = h('span', { class: cls, 'aria-hidden': 'true' }, formatCountdown(at - Date.now()));
  const sr = h('span', { class: 'sr-only', 'aria-live': 'polite' });
  const c: Countdown = { el, sr, at, lastMin: -1 };
  updateCountdown(c);
  countdowns.push(c);
  return h('span', null, el, sr);
}

function updateCountdown(c: Countdown) {
  const left = c.at - Date.now();
  c.el.textContent = formatCountdown(left);
  const min = Math.ceil(Math.max(0, left) / 60_000);
  if (min !== c.lastMin) {
    c.lastMin = min;
    c.sr.textContent = tf('popup_minutesLeft', '$1 min left', String(min));
  }
}

setInterval(() => {
  let expired = false;
  for (const c of countdowns) {
    updateCountdown(c);
    if (c.at <= Date.now()) expired = true;
  }
  if (expired) {
    countdowns = countdowns.filter((c) => c.at > Date.now());
    void load();
  }
}, 1000);

function render() {
  if (!snap) return;
  countdowns = [];
  clear(app);
  app.removeAttribute('aria-busy');
  const s = snap;
  const now = s.now;

  app.append(
    h(
      'header',
      { class: 'top' },
      h('img', { src: 'icons/icon48.png', alt: '' }),
      h('span', { class: 'brand' }, 'FocusGuard'),
      s.config.parental?.enabled
        ? h('span', { class: 'pill info parental-pill' }, t('parental_popup_on', 'Parental controls on'))
        : null,
    ),
  );

  if (isPaused(s.runtime, now) && s.runtime.pausedUntil) {
    app.append(
      h(
        'div',
        { class: 'banner warn', role: 'status' },
        h('span', null, tf('popup_paused', 'Paused until $1', formatClock(s.runtime.pausedUntil, now))),
        h(
          'button',
          {
            class: 'btn small',
            type: 'button',
            onclick: () => void applyChange({ kind: 'pause', minutes: null }, { successMessage: t('popup_resumed', 'FocusGuard is back on.') }),
          },
          t('popup_resume', 'Resume'),
        ),
      ),
    );
  }

  app.append(siteCard(s));
  app.append(focusCard(s));
  app.append(lockCard(s));

  app.append(
    h(
      'footer',
      { class: 'links' },
      h('button', { class: 'btn link', type: 'button', onclick: () => openOptions('rules') }, t('popup_linkRules', 'Rules')),
      h('button', { class: 'btn link', type: 'button', onclick: () => openOptions('insights') }, t('popup_linkInsights', 'Insights')),
      h('button', { class: 'btn link', type: 'button', onclick: () => openOptions('settings') }, t('popup_linkSettings', 'Settings')),
    ),
  );
}

function siteCard(s: Snapshot): HTMLElement {
  const card = h('section', { class: 'card', 'aria-labelledby': 'site-h' });
  card.append(h('h2', { id: 'site-h', class: 'sr-only' }, t('popup_thisSite', 'This site')));
  const st = status;
  if (!st || !st.supported || !st.host) {
    card.append(h('p', { class: 'muted' }, t('popup_unsupported', 'FocusGuard can’t act on this page.')));
    return card;
  }
  const host = st.host;
  card.append(h('p', { class: 'site' }, host));

  const line = h('div', { class: 'status-line' });
  const by = st.ruleName ? tf('popup_byRule', 'by “$1”', st.ruleName) : '';
  if (st.action === 'block') line.append(h('span', { class: 'pill lock' }, t('popup_blocked', 'Blocked')), h('span', { class: 'muted' }, by));
  else if (st.action === 'redirect') line.append(h('span', { class: 'pill warn' }, t('popup_redirected', 'Redirected')), h('span', { class: 'muted' }, by));
  else if (st.action === 'allow') line.append(h('span', { class: 'pill on' }, t('popup_allowed', 'Allowed')), h('span', { class: 'muted' }, tf('popup_exception', 'exception $1', by)));
  if (st.hiding.length) line.append(h('span', { class: 'pill info' }, t('popup_hiding', 'Hiding elements')), h('span', { class: 'muted' }, st.hiding.join(', ')));
  if (st.action === 'none' && !st.hiding.length && !st.budgets.length) line.append(h('span', { class: 'muted' }, t('popup_noRules', 'No rules for this site right now.')));
  card.append(line);

  for (const b of st.budgets) {
    const left = Math.max(0, b.limitSec - b.usedSec);
    const pct = b.limitSec ? Math.min(100, (b.usedSec / b.limitSec) * 100) : 100;
    const cls = left <= 0 ? 'bar over' : left <= 120 ? 'bar warn' : 'bar';
    const bar = h('div', {
      class: cls,
      role: 'progressbar',
      'aria-valuemin': 0,
      'aria-valuemax': Math.round(b.limitSec / 60),
      'aria-valuenow': Math.round(b.usedSec / 60),
      'aria-label': tf('popup_budgetOf', 'Daily budget “$1”', b.name),
    });
    const fill = h('span');
    fill.style.width = `${pct}%`; // CSSOM, allowed by CSP
    bar.append(fill);
    card.append(
      h(
        'div',
        { class: 'budget' },
        h(
          'div',
          { class: 'row' },
          h('span', null, b.name),
          h('strong', null, left > 0 ? tf('popup_leftToday', '$1 left today', formatDuration(left)) : t('popup_budgetUsed', 'Budget used up')),
        ),
        bar,
      ),
    );
  }

  // Quick actions
  const actions = h('div', { class: 'actions' });
  if (st.action !== 'block') {
    actions.append(
      h('button', { class: 'btn', type: 'button', onclick: () => void blockSite(host) }, t('popup_blockSite', 'Block this site')),
    );
  }
  if (!st.budgets.length && st.action !== 'block') {
    if (!budgetFormOpen) {
      actions.append(
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            'aria-expanded': 'false',
            onclick: () => {
              budgetFormOpen = true;
              render();
              document.getElementById('budget-min')?.focus();
            },
          },
          t('popup_budgetSite', 'Give this site a daily budget…'),
        ),
      );
    } else {
      const input = h('input', { class: 'input', id: 'budget-min', type: 'number', min: 1, max: 1440, step: 1, value: '20', required: true });
      const save = () => void budgetSite(host, Number(input.value));
      input.addEventListener('keydown', (e) => e.key === 'Enter' && save());
      actions.append(
        h(
          'div',
          { class: 'inline-form' },
          field(t('popup_minutesPerDay', 'Minutes per day'), input),
          h('button', { class: 'btn primary', type: 'button', onclick: save }, t('popup_save', 'Save')),
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () => {
                budgetFormOpen = false;
                render();
              },
            },
            t('popup_cancel', 'Cancel'),
          ),
        ),
      );
    }
  }
  actions.append(
    h('button', { class: 'btn', type: 'button', onclick: () => void startPicker() }, t('popup_hideElement', 'Hide an element on this page')),
  );
  card.append(actions);
  return card;
}

async function blockSite(host: string) {
  const rule: Rule = {
    id: newId(),
    name: host,
    targets: [{ kind: 'domain', host, includeSubdomains: true }],
    action: { kind: 'block' },
    enabled: true,
    createdAt: Date.now(),
  };
  const res = await applyChange({ kind: 'rules.add', rules: [rule] }, { successMessage: tf('popup_blockedToast', '$1 is now blocked.', host) });
  if (res.ok) void load();
}

async function budgetSite(host: string, minutes: number) {
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440 || !Number.isInteger(minutes)) {
    toast(t('popup_budgetInvalid', 'Enter whole minutes from 1 to 1440.'), 'error');
    return;
  }
  const rule: Rule = {
    id: newId(),
    name: tf('popup_budgetName', '$1 daily budget', host),
    targets: [{ kind: 'domain', host, includeSubdomains: true }],
    action: { kind: 'budget', minutesPerDay: minutes },
    enabled: true,
    createdAt: Date.now(),
  };
  const res = await applyChange(
    { kind: 'rules.add', rules: [rule] },
    { successMessage: tf('popup_budgetToast', '$1 now has $2 minutes a day.', host, String(minutes)) },
  );
  if (res.ok) {
    budgetFormOpen = false;
    void load();
  }
}

async function startPicker() {
  if (tab?.id === undefined) return;
  const res = await send({ type: 'startPicker', tabId: tab.id });
  if (res.ok) window.close();
  else toast(res.message ?? t('popup_pickerFailed', 'The element picker can’t run on this page.'), 'error');
}

function focusCard(s: Snapshot): HTMLElement {
  const card = h('section', { class: 'card', 'aria-labelledby': 'focus-h' });
  card.append(h('h2', { id: 'focus-h' }, t('popup_focusTitle', 'Focus session')));
  const ph = s.focusPhase;
  const sess = s.runtime.focus;
  if (ph && sess) {
    card.append(
      h(
        'div',
        { class: 'row between' },
        h('strong', { class: `phase-${ph.kind}` }, phaseLabel(ph.kind)),
        h('span', { class: 'muted' }, tf('popup_cycle', 'Cycle $1 of $2', String(ph.cycle), String(sess.cycles))),
      ),
      h('div', { class: 'big-count' }, countdown(ph.endsAt)),
    );
    if (s.focusEndsAt) card.append(h('p', { class: 'hint' }, tf('popup_sessionEnds', 'Session ends at $1', formatClock(s.focusEndsAt, s.now))));
    const locked = activeLocks(s.runtime, s.now).length > 0;
    const challenge = s.config.settings.commitment === 'challenge';
    const reason = locked
      ? t('popup_endLocked', 'A Hard Lock is active, so the session can’t end early.')
      : challenge
        ? t('popup_endChallenge', 'Your commitment level is Challenge, so sessions can’t end early.')
        : '';
    card.append(
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          disabled: !!reason,
          'aria-describedby': reason ? 'end-reason' : null,
          onclick: () => void applyChange({ kind: 'focus.stop' }, { successMessage: t('popup_sessionEnded', 'Focus session ended.') }),
        },
        t('popup_endEarly', 'End early'),
      ),
    );
    if (reason) card.append(h('p', { class: 'hint', id: 'end-reason' }, reason));
  } else {
    const c = s.config.focusConfig;
    const listCount = s.config.rules.filter((r) => r.onlyDuringFocus && r.enabled).length;
    card.append(
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onclick: () => void applyChange({ kind: 'focus.start' }, { successMessage: t('popup_focusStarted', 'Focus session started.') }),
        },
        tf('popup_startFocus', 'Start focus ($1/$2 × $3)', String(c.workMin), String(c.breakMin), String(c.cycles)),
      ),
    );
    if (listCount) {
      card.append(h('p', { class: 'hint' }, tf('popup_focusList', 'Blocks $1 focus-list rule(s) during work intervals.', String(listCount))));
    } else {
      card.append(
        h(
          'p',
          { class: 'hint' },
          t('popup_focusEmpty', 'Your focus list is empty. '),
          h('button', { class: 'btn link', type: 'button', onclick: () => openOptions('focus') }, t('popup_addSites', 'Add sites')),
        ),
      );
    }
  }
  return card;
}

function lockCard(s: Snapshot): HTMLElement {
  const card = h('section', { class: 'card', 'aria-labelledby': 'lock-h' });
  card.append(h('h2', { id: 'lock-h' }, t('popup_lockTitle', 'Hard Lock')));
  const locks = activeLocks(s.runtime, s.now);
  if (locks.length) {
    const latest = locks.reduce((a, b) => (b.endsAt > a.endsAt ? b : a));
    card.append(
      h(
        'div',
        { class: 'row between' },
        h('span', { class: 'pill lock' }, tf('popup_lockedUntil', 'Locked until $1', formatClock(latest.endsAt, s.now))),
        h('strong', null, countdown(latest.endsAt)),
      ),
      h(
        'div',
        { class: 'row mt' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () =>
              void applyChange({ kind: 'lock.extend', lockId: latest.id, minutes: 30 }, { successMessage: t('popup_lockExtended', 'Hard Lock extended by 30 minutes.') }),
          },
          t('popup_extend30', '+30 min'),
        ),
      ),
    );
  } else {
    card.append(
      h('p', { class: 'hint' }, t('popup_lockHint', 'Block sites for a set time with no way to undo it.')),
      h('button', { class: 'btn', type: 'button', onclick: () => openOptions('lock') }, t('popup_lockStart', 'Hard Lock…')),
    );
  }
  return card;
}

onStateChange(() => void load());
void load();
