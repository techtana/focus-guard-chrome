// Always-on content script (document_start, top frame). Hides page elements
// for active hide rules (FR-5.3). Reads the worker-compiled `hideIndex` from
// chrome.storage.local, injects one <style>, and keeps it right across SPA
// navigation and DOM changes. Reads no page content and sends nothing.

import type { HideIndex } from '../shared/types.ts';
import { buildCss, selectorsFor } from './hide-css.ts';

(() => {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  const w = window as unknown as { __focusguardHide?: boolean };
  if (w.__focusguardHide) return;
  w.__focusguardHide = true;

  const STYLE_ID = 'focusguard-hide';
  let index: HideIndex | null = null;
  let lastUrl = location.href;
  let css = '';
  const style = document.createElement('style');
  style.id = STYLE_ID;

  function ensureAttached(): void {
    if (!css) {
      if (style.isConnected) style.remove();
      return;
    }
    const parent = document.head ?? document.documentElement;
    if (parent && style.parentNode !== parent) parent.appendChild(style);
  }

  function apply(): void {
    const next = buildCss(selectorsFor(index, location.href));
    if (next !== css) {
      css = next;
      style.textContent = css;
    }
    ensureAttached();
  }

  function checkUrl(): void {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      apply();
    }
  }

  chrome.storage.local.get('hideIndex').then(
    (r) => {
      index = (r.hideIndex as HideIndex | undefined) ?? null;
      apply();
    },
    () => {},
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.hideIndex) {
      index = (changes.hideIndex.newValue as HideIndex | undefined) ?? null;
      apply();
    }
  });

  chrome.runtime.onMessage.addListener((msg: unknown) => {
    if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'fg-url-changed') {
      lastUrl = '';
      checkUrl();
    }
    return false;
  });

  addEventListener('popstate', checkUrl);
  addEventListener('hashchange', checkUrl);

  // Cheap SPA / removal watch: at most one check per animation frame.
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      checkUrl();
      if (css && !style.isConnected) ensureAttached();
      else if (css && document.head && style.parentNode !== document.head) ensureAttached();
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
