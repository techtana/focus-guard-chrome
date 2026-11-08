// FocusGuard service worker. Listeners are registered synchronously at the top
// level (Manifest V3 requirement) so events wake the worker reliably. All
// timers use chrome.alarms plus persisted state (reliability NFR).

import type { Request } from '../shared/messages.ts';
import { decideUrl } from '../shared/rules.ts';
import { applyChange } from './apply.ts';
import { currentEntries, enforcementUrl, isSupportedUrl, recompute } from './engine.ts';
import { handle } from './handlers.ts';
import { getState } from './state.ts';
import { flush, onActivity } from './tracker.ts';

const TICK = 'tick';

async function ensureAlarms(): Promise<void> {
  if (!(await chrome.alarms.get(TICK))) await chrome.alarms.create(TICK, { periodInMinutes: 1 });
}

async function applyEnvironment(): Promise<void> {
  const { config } = await getState();
  chrome.idle.setDetectionInterval(Math.max(15, config.settings.idleSeconds));
  await Promise.resolve(chrome.runtime.setUninstallURL(config.settings.uninstallUrl || '')).catch(() => undefined);
}

/** Restore (PRD step 6): reload state, re-apply locks and sessions, drop expired ones. */
async function restore(): Promise<void> {
  await ensureAlarms();
  await applyEnvironment();
  await recompute();
  await onActivity();
}

/** Inject the content script into tabs that were open before install/update. */
async function injectIntoOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map((t) =>
      t.id === undefined || !isSupportedUrl(t.url)
        ? undefined
        : chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }).catch(() => undefined),
    ),
  );
}

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    await restore();
    await injectIntoOpenTabs();
    if (details.reason === 'install') {
      const { config } = await getState();
      if (!config.onboarded) await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    }
  })();
});

chrome.runtime.onStartup.addListener(() => void restore());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK) void flush().then(() => recompute());
  else if (alarm.name === 'recompute') void recompute();
  else if (alarm.name === 'budget') void flush();
});

chrome.runtime.onMessage.addListener((msg: Request, sender, sendResponse) => {
  // Only our own pages and content scripts can talk to us (no externally_connectable).
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error('FocusGuard message failed', msg?.type, err);
      sendResponse({ fatal: String(err) });
    });
  return true;
});

chrome.tabs.onActivated.addListener(() => void onActivity());

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url) chrome.tabs.sendMessage(tabId, { type: 'fg-url-changed' }).catch(() => undefined);
  // SPA navigations (url change without a network load) and back/forward-cache
  // restores bypass declarativeNetRequest: enforce them here.
  const spa = !!info.url && !info.status;
  if ((spa || info.status === 'complete') && isSupportedUrl(tab.url)) {
    void currentEntries().then(({ entries }) => {
      const target = enforcementUrl(decideUrl(tab.url!, entries), entries);
      if (target) chrome.tabs.update(tabId, { url: target }).catch(() => undefined);
    });
  }
  if ((info.url || info.status === 'complete') && tab.active) void onActivity();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  void onActivity({ windowFocused: windowId !== chrome.windows.WINDOW_ID_NONE });
});

chrome.idle.onStateChanged.addListener((state) => void onActivity({ idle: state }));

// Every worker start (including after Chrome stopped an idle worker).
void ensureAlarms();

// Exposed for debugging from the service worker console.
(globalThis as unknown as Record<string, unknown>).focusGuard = { applyChange, recompute, getState, flush, onActivity };
