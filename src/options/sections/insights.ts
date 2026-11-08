// Insights (FR-8, UC-8): day and week views of where time went, focus time,
// blocked attempts and time saved; per-site category overrides; CSV export;
// delete all insights data. Reads `stats` straight from chrome.storage.local.

import { CATEGORIES, CATEGORY_LABELS, categoryOf } from '../../shared/categories.ts';
import {
  addDays,
  aggregate,
  dailyCsv,
  dateRange,
  parseDateKey,
  sitesCsv,
  topSites,
  type Aggregate,
  type SiteRow,
} from '../../shared/insights.ts';
import { send, type Snapshot } from '../../shared/messages.ts';
import { localDateKey } from '../../shared/schedule.ts';
import type { Category, StatsStore } from '../../shared/types.ts';
import { clear, formatDuration, h, svg, t, toast } from '../../ui/dom.ts';
import { applyChange, confirmDialog } from '../../ui/gate.ts';
import type { Section, SectionCtx } from '../section.ts';

type Mode = 'day' | 'week';

// View state survives re-renders (the shell re-renders when stats change).
let mode: Mode = 'week';
let endDate: string | null = null;
let renderToken = 0;

const TOP_N = 15;

function ensureStyles() {
  if (document.getElementById('insights-css')) return;
  document.head.append(h('link', { id: 'insights-css', rel: 'stylesheet', href: 'insights.css' }));
}

function dayLabel(date: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  return new Date(parseDateKey(date)).toLocaleDateString([], opts);
}

function rangeLabel(dates: string[]): string {
  if (dates.length === 1) return dayLabel(dates[0], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  return `${dayLabel(dates[0], o)} – ${dayLabel(dates[dates.length - 1], { ...o, year: 'numeric' })}`;
}

async function loadStats(): Promise<StatsStore> {
  const { stats } = await chrome.storage.local.get('stats');
  return (stats as StatsStore | undefined) ?? {};
}

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: filename, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Pieces ----

function kpi(label: string, value: string, hint?: string): HTMLElement {
  return h('div', { class: 'kpi card' }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value), hint ? h('div', { class: 'hint' }, hint) : null);
}

/** Round up to a "nice" axis maximum in seconds. */
function niceMax(sec: number): number {
  const steps = [600, 1800, 3600, 2 * 3600, 3 * 3600, 4 * 3600, 6 * 3600, 8 * 3600, 12 * 3600, 16 * 3600, 24 * 3600];
  return steps.find((s) => s >= sec) ?? Math.ceil(sec / 3600) * 3600;
}

function weekChart(a: Aggregate, onPick: (date: string) => void): HTMLElement {
  const W = 640;
  const H = 230;
  const pad = { l: 56, r: 12, t: 16, b: 40 };
  const max = niceMax(Math.max(60, ...a.series.map((s) => s.active)));
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const slot = plotW / a.series.length;
  const barW = Math.min(48, slot * 0.6);
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;

  const busiest = a.series.reduce((m, s) => (s.active > m.active ? s : m), a.series[0]);
  const summary =
    a.active > 0
      ? `Active browsing time per day, ${rangeLabel(a.dates)}. Total ${formatDuration(a.active)}; busiest day ${dayLabel(busiest.date)} with ${formatDuration(busiest.active)}.`
      : `No browsing time recorded for ${rangeLabel(a.dates)}.`;

  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': summary, preserveAspectRatio: 'xMidYMid meet' });
  for (const frac of [0, 0.5, 1]) {
    const v = max * frac;
    chart.append(
      svg('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: frac === 0 ? 'chart-axis' : 'chart-grid' }),
      svg('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'chart-tick' }, formatDuration(v)),
    );
  }
  a.series.forEach((s, i) => {
    const cx = pad.l + slot * i + slot / 2;
    const top = y(s.active);
    const g = svg('g', { class: 'chart-col' });
    const bar = svg('rect', {
      x: cx - barW / 2,
      y: top,
      width: barW,
      height: Math.max(0, pad.t + plotH - top),
      rx: 3,
      class: s.active > 0 ? 'chart-bar' : 'chart-bar empty',
    });
    bar.append(svg('title', {}, `${dayLabel(s.date)}: ${formatDuration(s.active)} active, ${formatDuration(s.focus)} focus, ${s.blocked} blocked`));
    g.append(bar);
    if (s.active > 0) g.append(svg('text', { x: cx, y: top - 5, 'text-anchor': 'middle', class: 'chart-value' }, formatDuration(s.active)));
    g.append(
      svg('text', { x: cx, y: H - pad.b + 16, 'text-anchor': 'middle', class: 'chart-tick' }, dayLabel(s.date, { weekday: 'short' })),
      svg('text', { x: cx, y: H - pad.b + 30, 'text-anchor': 'middle', class: 'chart-tick sub' }, dayLabel(s.date, { day: 'numeric', month: 'short' })),
    );
    g.addEventListener('click', () => onPick(s.date));
    chart.append(g);
  });

  const table = h(
    'table',
    { class: 'sr-only' },
    h('caption', null, 'Daily totals'),
    h('thead', null, h('tr', null, h('th', null, 'Day'), h('th', null, 'Active'), h('th', null, 'Focus'), h('th', null, 'Blocked attempts'))),
    h(
      'tbody',
      null,
      a.series.map((s) => h('tr', null, h('td', null, dayLabel(s.date)), h('td', null, formatDuration(s.active)), h('td', null, formatDuration(s.focus)), h('td', null, String(s.blocked)))),
    ),
  );
  return h(
    'div',
    { class: 'card' },
    h('h2', null, t('insights_perDay', 'Active time per day')),
    h('p', { class: 'hint' }, t('insights_perDayHint', 'Time on a site counts only while its tab is active, the window has focus and you are not idle. Click a day to see it on its own.')),
    chart,
    table,
  );
}

function categoryBars(a: Aggregate): HTMLElement {
  const card = h('div', { class: 'card' }, h('h2', null, t('insights_byCategory', 'Time by category')));
  if (!a.categories.length) {
    card.append(h('p', { class: 'muted' }, t('insights_noData', 'No browsing time recorded for this period.')));
    return card;
  }
  const max = a.categories[0].active;
  const list = h('ul', { class: 'hbars' });
  for (const c of a.categories) {
    const pct = a.active ? Math.round((c.active / a.active) * 100) : 0;
    list.append(
      h(
        'li',
        null,
        h('span', { class: 'hbar-label' }, CATEGORY_LABELS[c.category]),
        h('span', { class: 'hbar-track', 'aria-hidden': 'true' }, h('span', { class: `hbar-fill cat-${c.category}`, style: `width:${Math.max(2, (c.active / max) * 100)}%` })),
        h('span', { class: 'hbar-value' }, `${formatDuration(c.active)} · ${pct}%`),
      ),
    );
  }
  card.append(list);
  return card;
}

function categorySelect(row: SiteRow, snap: Snapshot, ctx: SectionCtx): HTMLSelectElement {
  const overrides = snap.config.categoryOverrides;
  const sel = h(
    'select',
    { class: 'input cat-select', 'aria-label': `Category for ${row.domain}` },
    CATEGORIES.map((c) => h('option', { value: c, selected: c === row.category }, CATEGORY_LABELS[c])),
  );
  sel.addEventListener('focus', () => ctx.setDirty(true));
  sel.addEventListener('blur', () => ctx.setDirty(false));
  sel.addEventListener('change', async () => {
    const next: Record<string, Category> = { ...overrides };
    const chosen = sel.value as Category;
    delete next[row.domain];
    // Store an override only when it differs from what the built-in map would say.
    if (categoryOf(row.domain, next) !== chosen) next[row.domain] = chosen;
    const res = await applyChange({ kind: 'categories.set', overrides: next });
    ctx.setDirty(false);
    if (res.ok) toast(`${row.domain} is now in ${CATEGORY_LABELS[chosen]}.`, 'success');
  });
  return sel;
}

function sitesTable(a: Aggregate, snap: Snapshot, ctx: SectionCtx): HTMLElement {
  const card = h('div', { class: 'card' }, h('h2', null, t('insights_topSites', 'Top sites')));
  if (!a.sites.length) {
    card.append(h('p', { class: 'muted' }, t('insights_noSites', 'Nothing yet. Browse as usual and check back later.')));
    return card;
  }
  const { top, other } = topSites(a.sites, TOP_N);
  const rows = top.map((s) =>
    h(
      'tr',
      null,
      h('th', { scope: 'row', class: 'mono' }, s.domain, snap.config.categoryOverrides[s.domain] ? h('span', { class: 'pill info', title: 'You set this category' }, 'custom') : null),
      h('td', null, categorySelect(s, snap, ctx)),
      h('td', { class: 'num' }, formatDuration(s.active)),
      h('td', { class: 'num' }, String(s.blocked)),
    ),
  );
  if (other) {
    rows.push(h('tr', { class: 'muted' }, h('th', { scope: 'row' }, other.domain), h('td', null, '—'), h('td', { class: 'num' }, formatDuration(other.active)), h('td', { class: 'num' }, String(other.blocked))));
  }
  card.append(
    h(
      'table',
      { class: 'list sites' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Site'), h('th', { scope: 'col' }, 'Category'), h('th', { scope: 'col', class: 'num' }, 'Active time'), h('th', { scope: 'col', class: 'num' }, 'Blocked attempts'))),
      h('tbody', null, rows),
    ),
  );
  return card;
}

function dataCard(stats: StatsStore, snap: Snapshot, ctx: SectionCtx): HTMLElement {
  const days = Object.keys(stats).length;
  const minutes = snap.config.settings.minutesPerBlockedAttempt;
  return h(
    'div',
    { class: 'card' },
    h('h2', null, t('insights_yourData', 'Your data')),
    h(
      'p',
      null,
      t(
        'insights_privacy',
        'Insights stay on this device. FocusGuard stores only domains, durations and counts per day — never page content, form data or full URLs. Data older than 120 days is removed automatically.',
      ),
    ),
    h('p', { class: 'hint' }, `${days} day${days === 1 ? '' : 's'} of data stored.`),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        { class: 'btn', type: 'button', disabled: !days, onclick: () => download(`focusguard-sites-${localDateKey(Date.now())}.csv`, sitesCsv(stats, snap.config.categoryOverrides)) },
        t('insights_exportSites', 'Export site usage (CSV)'),
      ),
      h(
        'button',
        { class: 'btn', type: 'button', disabled: !days, onclick: () => download(`focusguard-daily-${localDateKey(Date.now())}.csv`, dailyCsv(stats, minutes)) },
        t('insights_exportDaily', 'Export daily summary (CSV)'),
      ),
      h(
        'button',
        {
          class: 'btn danger',
          type: 'button',
          disabled: !days,
          onclick: async () => {
            const ok = await confirmDialog(
              'Delete all insights data?',
              'This permanently deletes every day of usage history on this device. Your rules, budgets and locks are not affected. This cannot be undone.',
              'Delete all data',
              true,
            );
            if (!ok) return;
            await send({ type: 'deleteStats' });
            toast('All insights data deleted.', 'success');
            await ctx.refresh();
          },
        },
        t('insights_deleteAll', 'Delete all insights data'),
      ),
    ),
  );
}

// ---- Section ----

const section: Section = {
  id: 'insights',
  title: 'Insights',
  render(root, snap, ctx) {
    ensureStyles();
    const today = localDateKey(snap.now);
    if (!endDate || endDate > today) endDate = today;
    const token = ++renderToken;
    const body = h('div', { class: 'insights stack', 'aria-busy': 'true' }, h('p', { class: 'muted' }, 'Loading…'));
    root.append(body);

    const rerender = () => {
      clear(root);
      section.render(root, snap, ctx);
    };

    void loadStats().then((stats) => {
      if (token !== renderToken) return;
      const end = endDate ?? today;
      const dates = mode === 'day' ? [end] : dateRange(end, 7);
      const minutes = snap.config.settings.minutesPerBlockedAttempt;
      const a = aggregate(stats, dates, { overrides: snap.config.categoryOverrides, minutesPerBlockedAttempt: minutes });
      const step = mode === 'day' ? 1 : 7;

      const toggle = h(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'Period' },
        (['day', 'week'] as Mode[]).map((m) =>
          h(
            'button',
            {
              class: m === mode ? 'btn small active' : 'btn small',
              type: 'button',
              'aria-pressed': m === mode ? 'true' : 'false',
              onclick: () => {
                mode = m;
                rerender();
              },
            },
            m === 'day' ? t('insights_day', 'Day') : t('insights_week', 'Week'),
          ),
        ),
      );
      const stepper = h(
        'div',
        { class: 'row stepper' },
        h('button', { class: 'btn small', type: 'button', 'aria-label': mode === 'day' ? 'Previous day' : 'Previous week', onclick: () => ((endDate = addDays(end, -step)), rerender()) }, '←'),
        h('span', { class: 'range-label', 'aria-live': 'polite' }, rangeLabel(dates)),
        h('button', { class: 'btn small', type: 'button', 'aria-label': mode === 'day' ? 'Next day' : 'Next week', disabled: end >= today, onclick: () => ((endDate = addDays(end, step) > today ? today : addDays(end, step)), rerender()) }, '→'),
        h('button', { class: 'btn small ghost', type: 'button', disabled: end === today, onclick: () => ((endDate = today), rerender()) }, t('insights_today', 'Today')),
      );

      const blockedHint = `${a.blocked} × ${minutes} min ≈ ${formatDuration(a.blockedSaved)}`;
      const savedHint = `${formatDuration(a.budgetUnused)} unused budget + ${blockedHint} from blocked visits`;
      const kpis = h(
        'div',
        { class: 'kpis' },
        kpi(t('insights_active', 'Active time'), formatDuration(a.active), mode === 'week' ? `≈ ${formatDuration(a.active / 7)} a day` : undefined),
        kpi(t('insights_focus', 'Focus time'), formatDuration(a.focus), t('insights_focusHint', 'Work intervals of focus sessions')),
        kpi(t('insights_blocked', 'Blocked attempts'), String(a.blocked)),
        kpi(t('insights_saved', 'Time saved'), formatDuration(a.timeSaved), savedHint),
      );

      const parts: HTMLElement[] = [h('div', { class: 'row between controls' }, toggle, stepper), kpis];
      if (mode === 'week')
        parts.push(
          weekChart(a, (date) => {
            mode = 'day';
            endDate = date;
            rerender();
          }),
        );
      parts.push(h('div', { class: 'two-col' }, categoryBars(a), sitesTable(a, snap, ctx)));
      parts.push(dataCard(stats, snap, ctx));
      body.replaceChildren(...parts);
      body.setAttribute('aria-busy', 'false');
    });
  },
};

export default section;
