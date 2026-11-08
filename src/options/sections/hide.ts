// Element hiding section (FR-5): built-in presets and custom CSS-selector rules.
import { newId } from '../../shared/defaults.ts';
import type { Snapshot } from '../../shared/messages.ts';
import { describeSchedule } from '../../shared/schedule.ts';
import type { Preset, Rule } from '../../shared/types.ts';
import { targetLabel } from '../../shared/url.ts';
import { field, h, t } from '../../ui/dom.ts';
import { applyChange, confirmDialog } from '../../ui/gate.ts';
import {
  checkbox,
  ensureRulesCss,
  errorBox,
  modeFor,
  parseSelectors,
  parseTargetsText,
  rulePills,
  subdomainsFor,
  targetsToText,
} from '../rules-common.ts';
import type { Section, SectionCtx } from '../section.ts';

function presetRule(snap: Snapshot, presetId: string): Rule | undefined {
  return snap.config.rules.find((r) => !r.allow && r.action.kind === 'hide' && r.action.presetId === presetId);
}

function presetCard(p: Preset, snap: Snapshot, ctx: SectionCtx): HTMLElement {
  const rule = presetRule(snap, p.id);
  const action = rule?.action.kind === 'hide' ? rule.action : undefined;
  const isOn = (optId: string) => !!rule && rule.enabled && (!action?.presetOptions || action.presetOptions.includes(optId));
  const changed = () => ctx.setDirty(true);
  const boxes = p.options.map((o) => ({ o, ...checkbox(o.label, isOn(o.id), changed) }));
  const focusOnly = checkbox(t('hide_focus_only', 'Only during focus work intervals'), !!rule?.onlyDuringFocus, changed);
  const status = rule && rule.enabled ? rulePills(rule, snap) : [h('span', { class: 'pill' }, t('hide_off', 'Off'))];

  const save = async () => {
    const chosen = boxes.filter((b) => b.input.checked).map((b) => b.o.id);
    if (!chosen.length) {
      if (rule) {
        const ok = await confirmDialog(
          t('hide_preset_off_title', 'Turn off this preset?'),
          t('hide_preset_off_body', 'All of its elements will show again.'),
          t('hide_turn_off', 'Turn off'),
        );
        if (!ok) return;
        const res = await applyChange({ kind: 'rule.delete', id: rule.id }, { successMessage: t('hide_preset_saved', 'Preset saved.') });
        if (res.ok) {
          ctx.setDirty(false);
          void ctx.refresh();
        }
      } else {
        ctx.setDirty(false);
      }
      return;
    }
    const next: Rule = {
      id: rule?.id ?? newId(),
      name: rule?.name ?? `${p.name} ` + t('hide_preset_suffix', 'preset'),
      targets: p.sites.map((s) => ({ kind: 'domain' as const, host: s, includeSubdomains: true })),
      action: {
        kind: 'hide',
        selectors: action?.selectors ?? [],
        presetId: p.id,
        presetOptions: chosen,
      },
      enabled: true,
      createdAt: rule?.createdAt ?? Date.now(),
    };
    if (rule?.schedule) next.schedule = rule.schedule;
    if (focusOnly.input.checked) next.onlyDuringFocus = true;
    const res = await applyChange({ kind: 'rule.upsert', rule: next }, { successMessage: t('hide_preset_saved', 'Preset saved.') });
    if (res.ok) {
      ctx.setDirty(false);
      void ctx.refresh();
    }
  };

  return h(
    'div',
    { class: 'card preset-card' },
    h('div', { class: 'row between' }, h('h3', null, p.name), h('div', { class: 'row' }, status)),
    h('div', { class: 'hint' }, p.sites.join(', ')),
    h('fieldset', null, h('legend', null, t('hide_preset_legend', 'Hide')), h('div', { class: 'stack preset-options' }, boxes.map((b) => b.el))),
    focusOnly.el,
    rule?.schedule ? h('div', { class: 'hint' }, `${t('hide_schedule', 'Schedule:')} ${describeSchedule(rule.schedule)}`) : null,
    h(
      'div',
      { class: 'row end' },
      h('button', { type: 'button', class: 'btn primary', onclick: () => void save() }, t('hide_preset_save', 'Save') + ` ${p.name}`),
    ),
  );
}

function customEditor(snap: Snapshot, ctx: SectionCtx, existing: Rule | undefined, close: () => void): HTMLElement {
  const dirty = () => ctx.setDirty(true);
  const action = existing?.action.kind === 'hide' ? existing.action : undefined;
  const startTargets = existing?.targets ?? [];
  const mode = modeFor(startTargets);
  const name = h('input', { class: 'input', value: existing?.name ?? '' });
  const sites = h('textarea', { class: 'input mono', rows: 2, spellcheck: 'false', value: targetsToText(startTargets, mode), placeholder: 'news.example.com' });
  const subs = checkbox(t('hide_subdomains', 'Include subdomains'), subdomainsFor(startTargets), dirty);
  const selectors = h('textarea', {
    class: 'input mono',
    rows: 5,
    spellcheck: 'false',
    value: (action?.selectors ?? []).join('\n'),
    placeholder: '#comments\n.sidebar-recommendations',
  });
  const focusOnly = checkbox(t('hide_focus_only', 'Only during focus work intervals'), !!existing?.onlyDuringFocus, dirty);
  [name, sites, selectors].forEach((el) => el.addEventListener('input', dirty));
  const errors = errorBox();

  const save = async () => {
    const errs: string[] = [];
    const { targets, errors: tErr } = parseTargetsText(sites.value, mode, subs.input.checked);
    errs.push(...tErr);
    if (!targets.length) errs.push(t('hide_err_site', 'Enter the site to hide elements on.'));
    const sel = parseSelectors(selectors.value);
    errs.push(...sel.errors);
    if (!sel.selectors.length && !action?.presetId) errs.push(t('hide_err_no_selectors', 'Add at least one CSS selector.'));
    errors.show(errs);
    if (errs.length) return;
    const groupTargets = startTargets.filter((x) => x.kind === 'group');
    const rule: Rule = {
      id: existing?.id ?? newId(),
      targets: [...targets, ...groupTargets],
      action: { kind: 'hide', selectors: sel.selectors, ...(action?.presetId ? { presetId: action.presetId, presetOptions: action.presetOptions } : {}) },
      enabled: existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    const n = name.value.trim();
    if (n) rule.name = n;
    if (existing?.schedule) rule.schedule = existing.schedule;
    if (focusOnly.input.checked) rule.onlyDuringFocus = true;
    const res = await applyChange({ kind: 'rule.upsert', rule }, { successMessage: t('hide_saved', 'Hiding rule saved.') });
    if (res.ok) close();
  };

  return h(
    'div',
    { class: 'card rule-editor', role: 'region', 'aria-label': existing ? t('hide_edit', 'Edit hiding rule') : t('hide_new', 'New hiding rule') },
    h('h2', null, existing ? t('hide_edit', 'Edit hiding rule') : t('hide_new', 'New hiding rule')),
    field(t('hide_name', 'Name (optional)'), name),
    field(t('hide_sites', 'Site'), sites, t('hide_sites_hint', 'A domain, or a URL prefix such as youtube.com/watch. One per line.')),
    subs.el,
    field(t('hide_selectors', 'CSS selectors to hide'), selectors, t('hide_selectors_hint', 'One per line. Each line is checked separately.')),
    focusOnly.el,
    errors.el,
    h(
      'div',
      { class: 'row end' },
      h('button', { type: 'button', class: 'btn', onclick: close }, t('hide_cancel', 'Cancel')),
      h('button', { type: 'button', class: 'btn primary', onclick: () => void save() }, t('hide_save', 'Save hiding rule')),
    ),
  );
}

function customRow(rule: Rule, snap: Snapshot, open: (r?: Rule) => void): HTMLElement {
  const action = rule.action.kind === 'hide' ? rule.action : undefined;
  const title = rule.name || rule.targets.map((x) => targetLabel(x, snap.config.groups)).join(', ');
  const toggle = h('input', { type: 'checkbox', checked: rule.enabled });
  toggle.addEventListener('change', async () => {
    const res = await applyChange({ kind: 'rule.setEnabled', id: rule.id, enabled: toggle.checked });
    if (!res.ok) toggle.checked = !toggle.checked;
  });
  return h(
    'li',
    { class: 'rule-row' },
    h(
      'div',
      { class: 'rule-main' },
      h('div', { class: 'row' }, h('h3', { class: 'rule-name' }, title), rulePills(rule, snap)),
      h('div', { class: 'rule-line' }, rule.targets.map((x) => targetLabel(x, snap.config.groups)).join(', ')),
      h('div', { class: 'rule-line mono selector-list' }, (action?.selectors ?? []).join('  ·  ')),
    ),
    h(
      'div',
      { class: 'rule-actions row' },
      h('label', { class: 'check' }, toggle, h('span', { class: 'sr-only' }, `${title}: `), t('hide_on', 'On')),
      h('button', { type: 'button', class: 'btn small', 'aria-label': `${t('hide_edit_btn', 'Edit')} ${title}`, onclick: () => open(rule) }, t('hide_edit_btn', 'Edit')),
      h(
        'button',
        {
          type: 'button',
          class: 'btn small ghost',
          'aria-label': `${t('hide_delete', 'Delete')} ${title}`,
          onclick: async () => {
            const ok = await confirmDialog(
              t('hide_delete_title', 'Delete this hiding rule?'),
              t('hide_delete_body', 'The hidden elements will show again. This cannot be undone.'),
              t('hide_delete', 'Delete'),
              true,
            );
            if (ok) await applyChange({ kind: 'rule.delete', id: rule.id }, { successMessage: t('hide_deleted', 'Hiding rule deleted.') });
          },
        },
        t('hide_delete', 'Delete'),
      ),
    ),
  );
}

const section: Section = {
  id: 'hide',
  title: t('hide_title', 'Element hiding'),
  render(root, snap, ctx) {
    ensureRulesCss();
    const presets = snap.presets?.presets ?? [];
    const custom = snap.config.rules.filter(
      (r) => !r.allow && r.action.kind === 'hide' && (!r.action.presetId || !presets.some((p) => p.id === (r.action as { presetId?: string }).presetId) || r.action.selectors.length > 0),
    );
    const editorHost = h('div');
    const close = () => {
      editorHost.replaceChildren();
      ctx.setDirty(false);
      void ctx.refresh();
    };
    const open = (r?: Rule) => {
      editorHost.replaceChildren(customEditor(snap, ctx, r, close));
      ctx.setDirty(true);
      editorHost.querySelector<HTMLElement>('input, textarea')?.focus();
    };

    root.append(
      h(
        'p',
        { class: 'muted' },
        t('hide_intro', 'Hide the distracting parts of a site and keep the useful part: Shorts, comments, feeds and recommendations.'),
      ),
      h(
        'div',
        { class: 'card picker-tip' },
        h('h2', null, t('hide_picker_title', 'Pick an element on the page')),
        h(
          'p',
          null,
          t('hide_picker_body', 'Open the site, click the FocusGuard toolbar button, choose Hide an element, then click the part of the page to hide. Press Esc to cancel.'),
        ),
      ),
      h('h2', null, t('hide_presets', 'Presets')),
      presets.length
        ? h('div', { class: 'preset-grid' }, presets.map((p) => presetCard(p, snap, ctx)))
        : h('p', { class: 'muted' }, t('hide_no_presets', 'No presets are available.')),
      h('p', { class: 'hint', hidden: !snap.presets?.version }, `${t('hide_presets_version', 'Preset version')} ${snap.presets?.version ?? ''} (${snap.presets?.updated ?? ''})`),
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'row between' },
          h('h2', null, t('hide_custom', 'Custom hiding rules')),
          h('button', { type: 'button', class: 'btn primary', onclick: () => open() }, t('hide_add', 'Add hiding rule')),
        ),
        editorHost,
        custom.length
          ? h('ul', { class: 'rule-list' }, custom.map((r) => customRow(r, snap, open)))
          : h('p', { class: 'muted' }, t('hide_custom_empty', 'No custom hiding rules yet.')),
      ),
    );
  },
};
export default section;
