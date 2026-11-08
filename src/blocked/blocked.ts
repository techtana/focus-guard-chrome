// Block page (FR-7.1, FR-7.2, UC-1). Reached by redirect as
// /blocked.html?r=<ruleId>&t=<targetIndex>. It never sees the visited URL.
import { send, type BlockInfo } from '../shared/messages.ts';
import { $, append, clear, formatClock, formatCountdown, h, t } from '../ui/dom.ts';
import { applyChange } from '../ui/gate.ts';

function tf(key: string, fallback: string, ...subs: string[]): string {
  return t(key, fallback, subs).replace(/\$(\d)/g, (_, n) => subs[Number(n) - 1] ?? '');
}

const app = $('#app');
const params = new URLSearchParams(location.search);
const ruleId = params.get('r') ?? '';
const targetIndex = Number(params.get('t') ?? '0') || 0;
/** Host of a parental block, when the worker knows it (detected sites). */
const hostParam = params.get('h') ?? undefined;

let timer: ReturnType<typeof setInterval> | undefined;

/** Count a blocked attempt only on a fresh navigation, not on reload or back/forward. */
function shouldCount(): boolean {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  return !nav || nav.type === 'navigate';
}

async function load(count: boolean) {
  let info: BlockInfo;
  try {
    info = await send({ type: 'blockInfo', ruleId, targetIndex, count, host: hostParam });
  } catch {
    info = {
      found: false,
      ruleName: '',
      site: '',
      reason: 'always',
      reasonText: t('blocked_unknown', 'FocusGuard blocked this page.'),
      unblockAt: null,
      message: '',
      image: null,
    };
  }
  render(info);
}

function goBackButton(primary: boolean): HTMLElement {
  return h(
    'button',
    {
      class: primary ? 'btn primary' : 'btn',
      type: 'button',
      onclick: () => {
        if (history.length > 1) history.back();
        else closeTab();
      },
    },
    t('blocked_goBack', 'Go back'),
  );
}

function closeTab() {
  chrome.tabs.getCurrent((tab) => {
    if (tab?.id !== undefined) void chrome.tabs.remove(tab.id);
    else window.close();
  });
}

function actions(primaryBack: boolean): HTMLElement {
  return h(
    'div',
    { class: 'actions' },
    history.length > 1 ? goBackButton(primaryBack) : null,
    h('button', { class: history.length > 1 ? 'btn' : 'btn primary', type: 'button', onclick: closeTab }, t('blocked_closeTab', 'Close tab')),
    h(
      'button',
      { class: 'btn ghost', type: 'button', onclick: () => void send({ type: 'openOptions' }) },
      t('blocked_openFocusGuard', 'Open FocusGuard'),
    ),
  );
}

/** Parental block: calm, no countdown, no link into settings; a guardian may allow a known host. */
function renderParental(info: BlockInfo, logo: HTMLElement) {
  document.title = t('parental_blocked_title', 'Blocked by parental controls');
  const host = info.parentalHost;
  const status = h('p', { class: 'parental-status', role: 'status', 'aria-live': 'polite' });
  append(app, [
    logo,
    h('h1', null, t('parental_blocked_heading', 'This page is blocked by parental controls')),
    host ? h('p', { class: 'parental-host' }, host) : null,
    h(
      'p',
      { class: 'reason' },
      info.reasonText ||
        t('parental_blocked_reason', 'A parent or guardian has set this browser to keep explicit content away. If you think this is a mistake, ask them to take a look.'),
    ),
    h(
      'div',
      { class: 'actions' },
      history.length > 1 ? goBackButton(true) : null,
      h('button', { class: history.length > 1 ? 'btn' : 'btn primary', type: 'button', onclick: closeTab }, t('blocked_closeTab', 'Close tab')),
    ),
  ]);
  if (host) {
    const allow = h(
      'button',
      {
        class: 'btn link',
        type: 'button',
        onclick: async () => {
          allow.disabled = true;
          status.textContent = '';
          const res = await applyChange({ kind: 'parental.allowSite', host });
          allow.disabled = false;
          if (res.ok) {
            status.textContent = t('parental_blocked_allowed', 'Allowed. Opening the site…');
            location.href = `https://${host}/`;
          }
        },
      },
      t('parental_blocked_allow', 'A parent can allow this site'),
    );
    app.append(h('div', { class: 'parental-allow' }, allow, status));
  }
}

function render(info: BlockInfo) {
  clearInterval(timer);
  clear(app);
  app.removeAttribute('aria-busy');
  const logo = h('img', { class: 'logo', src: 'icons/icon128.png', alt: '' });
  const site = info.site || t('blocked_thisSite', 'This site');

  if (info.reason === 'parental') {
    renderParental(info, logo);
    return;
  }

  if (info.reason === 'inactive') {
    document.title = t('blocked_openTitle', 'Open again · FocusGuard');
    app.append(
      logo,
      h('h1', { class: 'open' }, t('blocked_openAgain', 'This site is open again')),
      h('p', { class: 'reason' }, tf('blocked_openReason', 'The rule for $1 is no longer active.', site)),
      actions(true),
    );
    return;
  }

  document.title = tf('blocked_title', '$1 is blocked · FocusGuard', site);
  app.append(logo, h('h1', null, tf('blocked_heading', '$1 is blocked', site)), h('p', { class: 'reason' }, info.reasonText));

  if (info.unblockAt !== null) {
    const at = info.unblockAt;
    const visible = h('div', { class: 'count', 'aria-hidden': 'true' }, formatCountdown(at - Date.now()));
    const sr = h('p', { class: 'sr-only', 'aria-live': 'polite' });
    let lastMin = -1;
    const tick = () => {
      const left = at - Date.now();
      visible.textContent = formatCountdown(left);
      const min = Math.ceil(Math.max(0, left) / 60_000);
      if (min !== lastMin) {
        lastMin = min;
        sr.textContent = tf('blocked_srLeft', 'Unblocks in $1 minutes.', String(min));
      }
      if (left <= 0) {
        clearInterval(timer);
        void load(false);
      }
    };
    app.append(
      h(
        'div',
        { class: 'count-wrap' },
        h('div', { class: 'count-label' }, t('blocked_unblocksIn', 'Unblocks in')),
        visible,
        h('div', { class: 'count-label' }, tf('blocked_at', 'at $1', formatClock(at))),
        sr,
      ),
    );
    tick();
    timer = setInterval(tick, 1000);
  } else {
    app.append(h('div', { class: 'count-wrap' }, h('div', { class: 'count-label' }, t('blocked_noEnd', 'No end time'))));
  }

  if (info.message) app.append(h('p', { class: 'message' }, info.message));
  if (info.image) app.append(h('img', { class: 'custom-image', src: info.image, alt: '' }));
  app.append(actions(false));
}

void load(shouldCount());
