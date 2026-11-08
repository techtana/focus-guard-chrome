// Build a short, stable CSS selector for an element (FR-5.1 picker).
// Prefers ids that look hand-written, data-testid, aria-label, role and
// custom element tags; falls back to classes and finally :nth-of-type.

const MAX_DEPTH = 6;

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function attrValue(s: string): string {
  return `"${s.replace(/["\\]/g, '\\$&')}"`;
}

/** Ids/classes with long digit runs or hash-like chunks are usually generated. */
export function looksGenerated(s: string): boolean {
  if (s.length > 40) return true;
  if (/\d{3,}/.test(s)) return true;
  if (/^[a-z]{1,3}-?[A-Za-z0-9]{5,}$/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s)) return true;
  if (/^(css|sc|jsx|emotion|_)-?[a-z0-9]{4,}/i.test(s)) return true;
  if (/^[a-zA-Z0-9]{6,}$/.test(s) && /\d/.test(s) && /[a-zA-Z]/.test(s)) return true;
  return false;
}

function uniqueIn(root: ParentNode, sel: string, el: Element): boolean {
  try {
    const m = root.querySelectorAll(sel);
    return m.length === 1 && m[0] === el;
  } catch {
    return false;
  }
}

function matches(el: Element, sel: string): boolean {
  try {
    return el.matches(sel);
  } catch {
    return false;
  }
}

/** Candidate single-element selectors, most stable first. */
function candidates(el: Element): string[] {
  const tag = el.tagName.toLowerCase();
  const out: string[] = [];
  const id = el.id;
  if (id && !looksGenerated(id)) out.push(`#${cssEscape(id)}`);
  for (const a of ['data-testid', 'data-test-id', 'data-test', 'data-qa']) {
    const v = el.getAttribute(a);
    if (v && v.length <= 60) out.push(`${tag}[${a}=${attrValue(v)}]`);
  }
  const aria = el.getAttribute('aria-label');
  if (aria && aria.length <= 60) out.push(`${tag}[aria-label=${attrValue(aria)}]`);
  if (tag.includes('-')) out.push(tag); // custom element, e.g. ytd-reel-shelf-renderer
  const role = el.getAttribute('role');
  if (role) out.push(`${tag}[role=${attrValue(role)}]`);
  const classes = Array.from(el.classList).filter((c) => !looksGenerated(c)).slice(0, 2);
  if (classes.length) out.push(tag + classes.map((c) => `.${cssEscape(c)}`).join(''));
  return out;
}

function nthOfType(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) return tag;
  const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  return same.length === 1 ? tag : `${tag}:nth-of-type(${same.indexOf(el) + 1})`;
}

/** `tag:has(a[href="/path"])` when the element holds a link with a short relative path. */
function linkRefinement(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  const a = el.matches('a[href]') ? el : el.querySelector('a[href]');
  const href = a?.getAttribute('href');
  if (!href || !href.startsWith('/') || href.length > 60 || /[?#]/.test(href) || /\d{4,}/.test(href)) return null;
  return a === el ? `a[href=${attrValue(href)}]` : `${tag}:has(a[href=${attrValue(href)}])`;
}

/**
 * A selector that matches `el` and always includes it.
 * - 'similar' (default) may match look-alike elements too, e.g. every Shorts shelf.
 * - 'exact' tries hard to match only `el`.
 */
export function buildSelector(el: Element, mode: 'similar' | 'exact' = 'similar'): string {
  if (mode === 'exact') return exactSelector(el);
  return similarSelector(el);
}

function exactSelector(el: Element): string {
  const doc = el.ownerDocument;
  const tries = [...candidates(el)];
  const link = linkRefinement(el);
  if (link) tries.push(link);
  for (const c of tries) if (uniqueIn(doc, c, el)) return c;
  // Unique ancestor anchor + own candidate.
  let node = el.parentElement;
  for (let depth = 0; node && node !== doc.documentElement && depth < MAX_DEPTH; depth++, node = node.parentElement) {
    for (const anc of candidates(node)) {
      for (const c of tries) {
        const sel = `${anc} ${c}`;
        if (uniqueIn(doc, sel, el)) return sel;
      }
    }
  }
  return pathSelector(el);
}

function pathSelector(el: Element): string {
  const doc = el.ownerDocument;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== doc.documentElement) {
    const node: Element = cur;
    const stable = candidates(node).find((c) => uniqueIn(doc, c, node));
    if (stable) {
      parts.unshift(stable);
      break;
    }
    parts.unshift(nthOfType(node));
    cur = node.parentElement;
    if (parts.length >= 10) break;
  }
  const sel = parts.join(' > ');
  return matches(el, sel) ? sel : el.tagName.toLowerCase();
}

function similarSelector(el: Element): string {
  const doc = el.ownerDocument;
  const own = candidates(el);
  // 1. A stable selector on the element itself that is not absurdly broad.
  for (const c of own) {
    if (!matches(el, c)) continue;
    const n = doc.querySelectorAll(c).length;
    // Ids are only trusted when unique (YouTube reuses ids like #contents everywhere).
    if (c.startsWith('#') ? n === 1 : n <= 50) return c;
  }
  // 2. Anchor on a stable ancestor: "anchor descendant".
  const self = own.find((c) => matches(el, c)) ?? nthOfType(el);
  let node = el.parentElement;
  for (let depth = 0; node && node !== doc.documentElement && depth < MAX_DEPTH; depth++, node = node.parentElement) {
    const anc = candidates(node).find((c) => matches(node as Element, c));
    if (anc) {
      const sel = `${anc} ${self}`;
      if (matches(el, sel)) return sel;
    }
  }
  // 3. Exact path with :nth-of-type (unique, less stable).
  return pathSelector(el);
}
