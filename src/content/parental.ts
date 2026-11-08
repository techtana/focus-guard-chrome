// Parental-mode content script. The worker registers it (document_start, top
// frame, http/https) only while parental mode is on.
//
// - Page check: meta age labels + on-device text score; explicit -> tell the
//   worker, which blocks the tab (and learns the site when scope is 'site').
//   With hideUntilChecked the page stays invisible until the check, at most 1.5 s.
// - Social feeds: hide posts the site marks NSFW, and posts whose text is explicit.
// - Images: visible images >= 96 px go to the worker's on-device classifier;
//   explicit ones are blurred, and enough of them block the page.
// Nothing is stored; page text never leaves this script, only verdicts and
// image URLs go to the extension's own worker.

import { metaVerdict, postIsExplicit, scorePage, type DetectOptions, type PageInput } from '../parental/detect.ts';
import { imageIsExplicit, pageExplicitByImages } from '../parental/policy.ts';
import { socialSiteFor } from '../parental/social.ts';
import type { ImageScores, ParentalIndex, PageVerdict } from '../shared/types.ts';

(() => {
  const g = window as unknown as { __fgParental?: boolean };
  if (g.__fgParental) return;
  g.__fgParental = true;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  if (window.top !== window) return;

  const host = location.hostname.toLowerCase().replace(/^www\./, '');
  const social = socialSiteFor(host);
  const MAX_HIDE_MS = 1500;
  const MIN_IMAGE_PX = 96;
  const BATCH = 16;

  // ---- Pre-hide immediately; we only run while parental mode is on. ----
  const hideStyle = document.createElement('style');
  hideStyle.textContent = 'html{visibility:hidden!important}';
  (document.documentElement ?? document).appendChild(hideStyle);
  let holdHidden = false; // a block verdict is pending or confirmed
  const reveal = () => {
    if (!holdHidden) hideStyle.remove();
  };
  const hideTimer = setTimeout(() => {
    holdHidden = false; // never leave a page stuck hidden
    reveal();
  }, MAX_HIDE_MS);

  let cfg: ParentalIndex | null = null;
  let opts: DetectOptions = { sensitivity: 'medium', blockedWords: [] };
  const fgStyle = document.createElement('style');
  fgStyle.id = 'focusguard-parental';

  function allowed(c: ParentalIndex): boolean {
    return c.allowedSites.some((s) => {
      const d = s.toLowerCase().replace(/^www\./, '');
      return host === d || host.endsWith('.' + d);
    });
  }

  function active(): boolean {
    return !!cfg && cfg.enabled && !allowed(cfg);
  }

  function renderCss(): void {
    if (!cfg || !active()) {
      fgStyle.remove();
      return;
    }
    const rules = ['[data-fg-nsfw]{filter:blur(28px)!important;pointer-events:none!important}', '[data-fg-post-hidden]{display:none!important}'];
    if (cfg.socialFilter && social) for (const sel of social.nsfwSelectors) rules.push(`${sel}{display:none!important}`);
    if (cfg.scanImages && cfg.sensitivity === 'high') {
      rules.push(
        'html:not([data-fg-noscan]) img:not([data-fg-ok]){filter:blur(28px)!important}',
        'html:not([data-fg-noscan]) video[poster]:not([data-fg-ok]){filter:blur(28px)!important}',
      );
    }
    // One rule per selector: a selector the browser rejects drops only its own rule.
    fgStyle.textContent = rules.join('\n');
    if (!fgStyle.isConnected) (document.head ?? document.documentElement).appendChild(fgStyle);
  }

  // ---- Page check ----

  function gather(): PageInput {
    const meta: Record<string, string> = {};
    let n = 0;
    for (const m of Array.from(document.querySelectorAll('meta'))) {
      if (++n > 80) break;
      const k = (m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('itemprop') || '').toLowerCase().trim();
      const v = (m.getAttribute('content') || '').slice(0, 500);
      if (k && v) meta[k] = meta[k] ? `${meta[k]} ${v}` : v;
    }
    const texts = (sel: string, max: number, len: number, attr?: string) => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll(sel))) {
        if (out.length >= max) break;
        const t = (attr ? el.getAttribute(attr) : el.textContent)?.trim();
        if (t) out.push(t.slice(0, len));
      }
      return out;
    };
    const onSocial = !!social;
    return {
      url: location.href,
      title: document.title,
      meta,
      headings: texts('h1, h2', 20, 200),
      // On social sites a single explicit post must not block the whole site: feed text is judged per post.
      linkTexts: onSocial ? [] : texts('a', 300, 80),
      alts: onSocial ? [] : texts('img[alt]', 300, 120, 'alt'),
      bodySample: onSocial ? '' : bodySample(5000),
    };
  }

  function bodySample(max: number): string {
    if (!document.body) return '';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const p = node.parentElement?.tagName;
        return p === 'SCRIPT' || p === 'STYLE' || p === 'NOSCRIPT' || p === 'TEMPLATE' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    let out = '';
    while (out.length < max && walker.nextNode()) {
      const t = walker.currentNode.nodeValue?.trim();
      if (t) out += t + ' ';
    }
    return out.slice(0, max);
  }

  async function report(verdict: PageVerdict): Promise<boolean> {
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'parentalVerdict', verdict })) as { blocked?: boolean } | undefined;
      return !!res?.blocked;
    } catch {
      return false; // extension reloaded or worker unavailable
    }
  }

  let checkedHref = '';
  let pageBlocked = false;

  async function checkPage(): Promise<void> {
    if (!cfg || !active() || !cfg.detectPages) return finishCheck();
    checkedHref = location.href;
    const input = gather();
    const verdict = metaVerdict(input.meta) ?? scorePage(input, opts);
    if (verdict.explicit) {
      holdHidden = true;
      pageBlocked = await report({ explicit: true, score: verdict.score, source: verdict.source });
      holdHidden = pageBlocked;
    }
    finishCheck();
  }

  function finishCheck(): void {
    if (pageBlocked) return;
    clearTimeout(hideTimer);
    reveal();
  }

  // ---- Social posts ----

  const seenPosts = new WeakSet<Element>();

  function scanPosts(): void {
    if (!cfg || !active() || !cfg.socialFilter || !social) return;
    for (const post of Array.from(document.querySelectorAll(social.postSelector))) {
      if (seenPosts.has(post)) continue;
      const text = (post.textContent ?? '').slice(0, 1500);
      if (text.trim().length < 3) continue; // not rendered yet; try again later
      seenPosts.add(post);
      if (postIsExplicit(text, opts)) post.setAttribute('data-fg-post-hidden', '1');
    }
  }

  // ---- Images ----

  type ImgState = 'pending' | 'ok' | 'nsfw' | 'fail';
  const imageState = new Map<string, ImgState>();
  const elementsByUrl = new Map<string, Set<Element>>();
  const queued = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let scanning = true;
  let explicitOnPage = new Set<string>();
  let scannedOnPage = new Set<string>();
  let imageVerdictSent = false;

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        consider(e.target, e.boundingClientRect);
      }
    },
    { rootMargin: '300px' },
  );

  function srcOf(el: Element): string | null {
    const raw = el instanceof HTMLImageElement ? el.currentSrc || el.src : el instanceof HTMLVideoElement ? el.poster : '';
    if (!raw) return null;
    try {
      const u = new URL(raw, location.href);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch {
      return null;
    }
  }

  function mark(el: Element, state: ImgState): void {
    el.removeAttribute('data-fg-nsfw');
    if (state === 'nsfw') {
      el.setAttribute('data-fg-nsfw', '1');
      el.removeAttribute('data-fg-ok');
    } else if (state === 'ok') {
      el.setAttribute('data-fg-ok', '1');
    } else if (state === 'fail' && cfg?.sensitivity !== 'high') {
      el.setAttribute('data-fg-ok', 'unscanned');
    }
  }

  function consider(el: Element, rect: DOMRectReadOnly | DOMRect): void {
    if (!scanning || !cfg?.scanImages || !active()) return;
    if (rect.width < MIN_IMAGE_PX || rect.height < MIN_IMAGE_PX) {
      el.setAttribute('data-fg-ok', 'small');
      return;
    }
    const url = srcOf(el);
    if (!url) {
      if (el instanceof HTMLImageElement && !el.complete) return; // the load listener retries
      el.setAttribute('data-fg-ok', 'unscannable'); // data:/blob: images cannot be fetched by the classifier
      return;
    }
    (el as HTMLElement).dataset.fgSrc = url;
    let set = elementsByUrl.get(url);
    if (!set) elementsByUrl.set(url, (set = new Set()));
    set.add(el);
    const st = imageState.get(url);
    if (st && st !== 'pending') {
      mark(el, st);
      countForPage(url, st);
      return;
    }
    if (st === 'pending') return;
    imageState.set(url, 'pending');
    queued.add(url);
    if (queued.size >= BATCH) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, 150);
  }

  function flush(): void {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    if (!queued.size) return;
    const urls = [...queued].slice(0, BATCH);
    urls.forEach((u) => queued.delete(u));
    if (queued.size) flushTimer = setTimeout(flush, 50);
    void classify(urls);
  }

  async function classify(urls: string[]): Promise<void> {
    let results: ImageScores[] | null = null;
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'classifyImages', urls })) as { results: ImageScores[] | null } | undefined;
      results = res?.results ?? null;
    } catch {
      results = null;
    }
    if (results === null) {
      // Classifier off or unavailable: stop scanning and lift blur-until-checked.
      scanning = false;
      document.documentElement.setAttribute('data-fg-noscan', '1');
      return;
    }
    const byUrl = new Map(results.map((r) => [r.url, r]));
    for (const url of urls) {
      const r = byUrl.get(url);
      const st: ImgState = !r ? 'fail' : imageIsExplicit(r, opts.sensitivity) ? 'nsfw' : 'ok';
      imageState.set(url, st);
      for (const el of elementsByUrl.get(url) ?? []) if (el.isConnected) mark(el, st);
      countForPage(url, st);
    }
  }

  function countForPage(url: string, st: ImgState): void {
    if (st === 'fail' || st === 'pending') return;
    scannedOnPage.add(url);
    if (st === 'nsfw') explicitOnPage.add(url);
    // On social sites explicit images are blurred, never escalated to a whole-site block.
    if (social || imageVerdictSent || !cfg) return;
    if (pageExplicitByImages(explicitOnPage.size, scannedOnPage.size, cfg.sensitivity)) {
      imageVerdictSent = true;
      void report({ explicit: true, score: explicitOnPage.size, source: 'images' });
    }
  }

  function observeImages(root: ParentNode): void {
    if (!cfg?.scanImages || !scanning) return;
    if (root instanceof HTMLImageElement || (root instanceof HTMLVideoElement && root.poster)) io.observe(root);
    for (const el of Array.from(root.querySelectorAll?.('img, video[poster]') ?? [])) io.observe(el);
  }

  // Lazy loaders swap src after we first saw the element: re-check on load.
  document.addEventListener(
    'load',
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLImageElement) || !scanning || !active()) return;
      const url = srcOf(el);
      if (url && url !== el.dataset.fgSrc) consider(el, el.getBoundingClientRect());
    },
    true,
  );

  // ---- DOM and URL changes ----

  let pendingNodes: Node[] = [];
  let mutationTimer: ReturnType<typeof setTimeout> | undefined;

  const mo = new MutationObserver((records) => {
    for (const r of records) for (const n of Array.from(r.addedNodes)) if (n.nodeType === 1) pendingNodes.push(n);
    if (!mutationTimer) mutationTimer = setTimeout(processMutations, 250);
  });

  function processMutations(): void {
    mutationTimer = undefined;
    const nodes = pendingNodes;
    pendingNodes = [];
    if (!active()) return;
    if (location.href !== checkedHref && checkedHref) onUrlChange();
    if (cfg?.scanImages && scanning) for (const n of nodes) if (n.isConnected) observeImages(n as ParentNode);
    scanPosts();
    if (fgStyle.textContent && !fgStyle.isConnected) renderCss();
  }

  function onUrlChange(): void {
    if (location.href === checkedHref) return;
    explicitOnPage = new Set();
    scannedOnPage = new Set();
    imageVerdictSent = false;
    pageBlocked = false;
    void checkPage(); // no pre-hide on in-app navigation
  }

  window.addEventListener('popstate', () => setTimeout(onUrlChange, 0));
  chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
    if (msg?.type === 'fg-url-changed') setTimeout(onUrlChange, 50);
    return false;
  });

  // ---- Start ----

  function onReady(): void {
    renderCss();
    void checkPage();
    if (!active()) return;
    observeImages(document);
    scanPosts();
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  function apply(next: ParentalIndex | undefined): void {
    cfg = next ?? null;
    if (!cfg || !active()) {
      fgStyle.remove();
      holdHidden = false;
      finishCheck();
      return;
    }
    opts = { sensitivity: cfg.sensitivity, blockedWords: cfg.blockedWords };
    if (!cfg.detectPages || !cfg.hideUntilChecked) finishCheck();
    renderCss();
  }

  chrome.storage.local
    .get('parentalIndex')
    .then((got) => {
      apply(got.parentalIndex as ParentalIndex | undefined);
      if (!active()) return;
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
      else onReady();
    })
    .catch(() => apply(undefined));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.parentalIndex) return;
    const wasActive = active();
    apply(changes.parentalIndex.newValue as ParentalIndex | undefined);
    if (!wasActive && active() && document.readyState !== 'loading') onReady();
  });
})();
