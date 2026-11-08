// Element picker (FR-5.1). Injected on demand by the worker. Pointer highlights,
// ArrowUp/ArrowDown walk parent/child, click or Enter picks, Esc cancels.
// UI lives in a closed shadow root and is built with DOM APIs only.

import { buildSelector } from './selector.ts';

(() => {
  const w = window as unknown as { __focusguardPicker?: boolean };
  if (w.__focusguardPicker) return;
  w.__focusguardPicker = true;

  const host = document.createElement('focusguard-picker');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'closed' });

  const css = document.createElement('style');
  css.textContent = `
    :host { all: initial; }
    .box { position: fixed; pointer-events: none; border: 2px solid #4f46e5; background: rgba(79,70,229,.15);
      border-radius: 3px; transition: all 60ms linear; }
    .match { position: fixed; pointer-events: none; outline: 1px dashed #c0262d; background: rgba(192,38,45,.10); }
    .panel { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); pointer-events: auto;
      font: 14px/1.4 system-ui, sans-serif; color: #1c1b29; background: #fff; border: 1px solid #d9d8e3;
      border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.25); padding: 12px 14px; width: min(560px, 92vw); }
    .title { font-weight: 700; margin-bottom: 4px; }
    code { display: block; font: 12px ui-monospace, Consolas, monospace; background: #f0f0f6; padding: 6px 8px;
      border-radius: 6px; word-break: break-all; margin: 6px 0; max-height: 5em; overflow: auto; }
    .hint { color: #5b5a6e; font-size: 12px; }
    .row { display: flex; gap: 8px; justify-content: flex-end; align-items: center; margin-top: 8px; }
    .only { margin-right: auto; font-size: 13px; color: #1c1b29; cursor: pointer; }
    button { font: inherit; font-weight: 600; padding: 6px 14px; border-radius: 8px; cursor: pointer;
      border: 1px solid #d9d8e3; background: #f0f0f6; color: #1c1b29; }
    button.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
    button:focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
  `;
  const box = document.createElement('div');
  box.className = 'box';
  const matchLayer = document.createElement('div');
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'FocusGuard element picker');
  const title = document.createElement('div');
  title.className = 'title';
  const code = document.createElement('code');
  const hint = document.createElement('div');
  hint.className = 'hint';
  const status = document.createElement('div');
  status.className = 'hint';
  status.setAttribute('aria-live', 'polite');
  const row = document.createElement('div');
  row.className = 'row';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  const hideBtn = document.createElement('button');
  hideBtn.type = 'button';
  hideBtn.className = 'primary';
  hideBtn.textContent = 'Hide';
  const onlyLabel = document.createElement('label');
  onlyLabel.className = 'only';
  const onlyBox = document.createElement('input');
  onlyBox.type = 'checkbox';
  onlyLabel.append(onlyBox, document.createTextNode(' Only this element (not similar ones)'));
  onlyLabel.style.display = 'none';
  row.append(onlyLabel, cancelBtn, hideBtn);
  panel.append(title, code, hint, status, row);
  shadow.append(css, matchLayer, box, panel);
  (document.documentElement || document.body).appendChild(host);

  let current: Element | null = null;
  let picked = false;
  let selector = '';
  const childTrail: Element[] = [];

  function showIdle() {
    title.textContent = 'Pick an element to hide';
    code.textContent = 'Point at something on the page';
    hint.textContent = 'Click or Enter to choose · ↑ parent · ↓ child · Esc to cancel';
    hideBtn.disabled = true;
  }

  function drawMatches(sel: string) {
    matchLayer.replaceChildren();
    let els: Element[] = [];
    try {
      els = Array.from(document.querySelectorAll(sel)).slice(0, 200);
    } catch {
      /* invalid selector */
    }
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const m = document.createElement('div');
      m.className = 'match';
      Object.assign(m.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      matchLayer.appendChild(m);
    }
  }

  function countMatches(sel: string): number {
    try {
      return document.querySelectorAll(sel).length;
    } catch {
      return 0;
    }
  }

  function highlight(el: Element | null) {
    current = el;
    if (!el) {
      box.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    selector = buildSelector(el, picked && onlyBox.checked ? 'exact' : 'similar');
    const n = countMatches(selector);
    title.textContent = picked ? `Hide ${n} element${n === 1 ? '' : 's'} like this?` : `${el.tagName.toLowerCase()} · ${n} match${n === 1 ? '' : 'es'}`;
    code.textContent = selector;
    if (picked) drawMatches(selector);
  }

  function isOurs(el: Element | null): boolean {
    return !el || el === host || el === document.documentElement || el === document.body;
  }

  function onMove(e: MouseEvent) {
    if (picked) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (isOurs(el)) return;
    childTrail.length = 0;
    highlight(el);
  }

  function pick() {
    if (!current) return;
    picked = true;
    hint.textContent = 'Matching elements are outlined in red. ↑ / ↓ to widen or narrow.';
    hideBtn.disabled = false;
    onlyLabel.style.display = '';
    highlight(current);
    hideBtn.focus();
  }

  function onClick(e: MouseEvent) {
    if (e.composedPath().includes(host)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!picked) pick();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (picked) {
        picked = false;
        onlyLabel.style.display = 'none';
        onlyBox.checked = false;
        matchLayer.replaceChildren();
        showIdle();
        highlight(current);
      } else {
        close();
      }
      return;
    }
    if (!current) return;
    if (e.key === 'ArrowUp') {
      const p = current.parentElement;
      if (p && !isOurs(p)) {
        childTrail.push(current);
        highlight(p);
      }
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      const c = childTrail.pop() ?? current.firstElementChild;
      if (c) highlight(c);
      e.preventDefault();
    } else if (e.key === 'Enter' && !picked && !e.composedPath().includes(host)) {
      e.preventDefault();
      pick();
    }
  }

  function close() {
    removeEventListener('mousemove', onMove, true);
    removeEventListener('click', onClick, true);
    removeEventListener('keydown', onKey, true);
    host.remove();
    w.__focusguardPicker = false;
  }

  async function confirm() {
    if (!selector) return;
    hideBtn.disabled = true;
    status.textContent = 'Saving…';
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'pickerAdd', host: location.hostname, selector })) as
        | { ok: true }
        | { ok: false; message?: string }
        | undefined;
      if (res && res.ok) {
        status.textContent = 'Hidden. Manage it in FocusGuard → Element hiding.';
        setTimeout(close, 1200);
      } else {
        status.textContent = (res && !res.ok && res.message) || 'Could not save this rule.';
        hideBtn.disabled = false;
      }
    } catch {
      status.textContent = 'FocusGuard is not reachable. Reload the page and try again.';
      hideBtn.disabled = false;
    }
  }

  onlyBox.addEventListener('change', () => highlight(current));
  cancelBtn.addEventListener('click', close);
  hideBtn.addEventListener('click', () => void confirm());
  addEventListener('mousemove', onMove, true);
  addEventListener('click', onClick, true);
  addEventListener('keydown', onKey, true);
  showIdle();
})();
