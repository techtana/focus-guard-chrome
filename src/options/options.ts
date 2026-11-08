// Options shell: left nav + one section at a time, routed by location.hash.
import { send, type Snapshot } from '../shared/messages.ts';
import { $, clear, h, onStateChange } from '../ui/dom.ts';
import type { Section, SectionCtx } from './section.ts';
import rules from './sections/rules.ts';
import hide from './sections/hide.ts';
import focus from './sections/focus.ts';
import lock from './sections/lock.ts';
import blockpage from './sections/blockpage.ts';
import insights from './sections/insights.ts';
import settings from './sections/settings.ts';

const SECTIONS: Section[] = [rules, hide, focus, lock, blockpage, insights, settings];

let current: Section = SECTIONS[0];
let snap: Snapshot | null = null;
let dirty = false;
let intervals: ReturnType<typeof setInterval>[] = [];

const nav = $('#nav');
const main = $('#main');
const banner = $('#banner');

function clearIntervals() {
  intervals.forEach(clearInterval);
  intervals = [];
}

const ctx: SectionCtx = {
  refresh: async () => {
    snap = await send({ type: 'getState' });
    render();
  },
  every: (ms, fn) => {
    intervals.push(setInterval(fn, ms));
  },
  setDirty: (d) => {
    dirty = d;
  },
  go: (id) => {
    location.hash = id;
  },
};

function renderNav() {
  clear(nav);
  nav.append(
    h(
      'ul',
      null,
      SECTIONS.map((s) =>
        h(
          'li',
          null,
          h('a', { href: `#${s.id}`, 'aria-current': s === current ? 'page' : null, class: s === current ? 'active' : null }, s.title),
        ),
      ),
    ),
  );
}

function renderBanner() {
  clear(banner);
  if (!snap) return;
  const { runtime, now } = snap;
  const locks = runtime.locks.filter((l) => l.startedAt <= now && now < l.endsAt);
  if (locks.length) {
    const end = Math.max(...locks.map((l) => l.endsAt));
    banner.append(
      h('div', { class: 'banner lock', role: 'status' }, `Hard Lock active until ${new Date(end).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. You can tighten rules but not loosen them.`),
    );
  }
  if (runtime.pausedUntil && now < runtime.pausedUntil) {
    banner.append(h('div', { class: 'banner warn', role: 'status' }, `FocusGuard is paused until ${new Date(runtime.pausedUntil).toLocaleString()}. Hard Locks still apply.`));
  }
}

function render() {
  if (!snap) return;
  clearIntervals();
  dirty = false;
  renderNav();
  renderBanner();
  clear(main);
  const root = h('section', { class: 'section', 'aria-labelledby': 'section-title' });
  root.append(h('h1', { id: 'section-title' }, current.title));
  const body = h('div', { class: 'section-body' });
  root.append(body);
  main.append(root);
  try {
    current.render(body, snap, ctx);
  } catch (err) {
    console.error(err);
    body.append(h('p', { class: 'error-text' }, `This section failed to render: ${String(err)}`));
  }
}

function route() {
  const id = location.hash.replace(/^#/, '').split('/')[0];
  current = SECTIONS.find((s) => s.id === id) ?? SECTIONS[0];
  render();
  document.title = `${current.title} · FocusGuard`;
}

window.addEventListener('hashchange', route);
onStateChange(async () => {
  snap = await send({ type: 'getState' });
  if (dirty) {
    renderBanner();
    return;
  }
  render();
});

(async () => {
  snap = await send({ type: 'getState' });
  route();
})();
