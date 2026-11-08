// Tiny DOM toolkit for extension pages. Never use innerHTML with data:
// h() sets text through text nodes, so rule names and URLs cannot inject markup.

export type Child = Node | string | number | null | undefined | false | Child[];
type Handler = (ev: never) => void;
export type Attrs = Record<string, string | number | boolean | null | undefined | Handler | Record<string, string>>;

/**
 * h('button', { class: 'btn', onclick: fn, disabled: true, 'aria-label': 'Close' }, 'Close')
 * - `on<event>` keys add listeners
 * - `value`, `checked`, `disabled`, `selected`, `hidden` are set as properties
 * - `dataset: {k: v}` sets data-* attributes
 * - false/null/undefined attributes are skipped
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2), v as EventListener);
      } else if (k === 'dataset' && typeof v === 'object') {
        for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
      } else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else {
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** SVG element helper (for charts). */
export function svg(tag: string, attrs: Record<string, string | number> = {}, ...children: (SVGElement | string)[]): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
}

/** chrome.i18n lookup with an English fallback (strings live in src/locales/*.json). */
export function t(key: string, fallback: string, subs?: string | string[]): string {
  try {
    return chrome.i18n.getMessage(key, subs) || fallback;
  } catch {
    return fallback;
  }
}

// ---- Formatting ----

/** 3725 -> "1h 2m", 125 -> "2m 5s" (when `seconds`), 0 -> "0m". */
export function formatDuration(totalSec: number, seconds = false): string {
  const s = Math.max(0, Math.round(totalSec));
  const hrs = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (hrs) return `${hrs}h ${min}m`;
  if (seconds && min < 10) return min ? `${min}m ${sec}s` : `${sec}s`;
  return `${min}m`;
}

/** Remaining ms -> "4:05" or "1:02:03". */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const hrs = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hrs ? `${hrs}:${pad(min)}:${pad(sec)}` : `${min}:${pad(sec)}`;
}

/** Local clock time, "14:30"; adds the weekday when not today ("Tue 09:00"). */
export function formatClock(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const same = new Date(now).toDateString() === d.toDateString();
  return same ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

// ---- State subscription ----

/** Call `cb` (debounced) when the worker changes config or runtime. Returns an unsubscribe function. */
export function onStateChange(cb: (keys: string[]) => void, waitMs = 150): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<string>();
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local') return;
    const ks = Object.keys(changes).filter((k) => k === 'config' || k === 'runtime' || k === 'stats');
    if (!ks.length) return;
    ks.forEach((k) => pending.add(k));
    clearTimeout(timer);
    timer = setTimeout(() => {
      const list = [...pending];
      pending.clear();
      cb(list);
    }, waitMs);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// ---- Feedback ----

let toastHost: HTMLElement | null = null;

/** Short status message, announced to screen readers. */
export function toast(message: string, kind: 'info' | 'success' | 'error' = 'info', ms = 4000): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const el = h('div', { class: `toast toast-${kind}` }, message);
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** Unique id for label/input pairs. */
let uid = 0;
export function uniqueId(prefix = 'fg'): string {
  return `${prefix}-${++uid}`;
}

/** A labelled form field: label above control, optional hint below (accessible description). */
export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = control.id || uniqueId('f');
  control.id = id;
  let hintEl: HTMLElement | null = null;
  if (hint) {
    hintEl = h('div', { class: 'hint', id: `${id}-hint` }, hint);
    control.setAttribute('aria-describedby', `${id}-hint`);
  }
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hintEl);
}
