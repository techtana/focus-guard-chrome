// Rules section (FR-1 rules and matching, FR-2 budgets, FR-7.3 redirects) and groups.
import { newId } from '../../shared/defaults.ts';
import type { Snapshot } from '../../shared/messages.ts';
import { describeSchedule } from '../../shared/schedule.ts';
import type { Action, Group, Rule, Target } from '../../shared/types.ts';
import { isValidRedirectUrl, targetLabel } from '../../shared/url.ts';
import { field, h, t, uniqueId } from '../../ui/dom.ts';
import { applyChange, confirmDialog } from '../../ui/gate.ts';
import {
  actionSummary,
  budgetBar,
  checkbox,
  ensureRulesCss,
  errorBox,
  modeFor,
  parseTargetsText,
  rulePills,
  scheduleEditor,
  subdomainsFor,
  targetsToText,
  type TargetMode,
} from '../rules-common.ts';
import type { Section, SectionCtx } from '../section.ts';

type RuleType = 'block' | 'redirect' | 'budget' | 'allow';

function ruleType(rule: Rule): RuleType {
  if (rule.allow) return 'allow';
  const k = rule.action.kind;
  return k === 'redirect' || k === 'budget' ? k : 'block';
}

function ruleTitle(rule: Rule, snap: Snapshot): string {
  return rule.name || (rule.targets[0] ? targetLabel(rule.targets[0], snap.config.groups) : t('rules_untitled', 'Untitled rule'));
}

// ---- Rule editor ----

function ruleEditor(snap: Snapshot, ctx: SectionCtx, existing: Rule | undefined, close: () => void): HTMLElement {
  const dirty = () => ctx.setDirty(true);
  const groups = snap.config.groups;
  const startTargets = existing?.targets ?? [];

  const name = h('input', { class: 'input', value: existing?.name ?? '', placeholder: t('rules_name_ph', 'e.g. Social media') });
  name.addEventListener('input', dirty);

  // Targets
  const initialMode: TargetMode = modeFor(startTargets);
  const mode = h(
    'select',
    { class: 'input' },
    h('option', { value: 'auto', selected: initialMode === 'auto' }, t('rules_mode_auto', 'Sites and URL prefixes')),
    h('option', { value: 'exact', selected: initialMode === 'exact' }, t('rules_mode_exact', 'Exact URLs only')),
  );
  const targetsText = h('textarea', {
    class: 'input mono',
    rows: 4,
    spellcheck: 'false',
    placeholder: 'reddit.com\nyoutube.com/shorts',
    value: targetsToText(startTargets, initialMode),
  });
  const subs = checkbox(t('rules_subdomains', 'Include subdomains (m.reddit.com, old.reddit.com …)'), subdomainsFor(startTargets), dirty);
  const preview = h('div', { class: 'hint', 'aria-live': 'polite' });
  const updatePreview = () => {
    const { targets, errors } = parseTargetsText(targetsText.value, mode.value as TargetMode, subs.input.checked);
    preview.replaceChildren(
      targets.length ? h('span', null, t('rules_matches', 'Matches:') + ' ' + targets.map((x) => targetLabel(x)).join(', ')) : '',
      errors.length ? h('div', { class: 'error-text' }, errors.join(' ')) : '',
    );
  };
  targetsText.addEventListener('input', () => (dirty(), updatePreview()));
  mode.addEventListener('change', () => (dirty(), updatePreview()));
  subs.input.addEventListener('change', updatePreview);
  updatePreview();

  const groupBoxes = groups.map((g) => {
    const on = startTargets.some((x) => x.kind === 'group' && x.groupId === g.id);
    const cb = checkbox(g.name, on, dirty);
    return { g, input: cb.input, el: cb.el };
  });

  // Type
  const typeName = uniqueId('type');
  const current: RuleType = existing ? ruleType(existing) : 'block';
  const types: { v: RuleType; label: string; hint: string }[] = [
    { v: 'block', label: t('rules_type_block', 'Block'), hint: t('rules_type_block_hint', 'Show the block page.') },
    { v: 'redirect', label: t('rules_type_redirect', 'Redirect'), hint: t('rules_type_redirect_hint', 'Send the tab to another page.') },
    { v: 'budget', label: t('rules_type_budget', 'Daily time budget'), hint: t('rules_type_budget_hint', 'Allow some minutes a day, then block.') },
    { v: 'allow', label: t('rules_type_allow', 'Allow (exception)'), hint: t('rules_type_allow_hint', 'Keep these URLs open even when a broader rule blocks the site.') },
  ];
  const radios = types.map((x) => {
    const input = h('input', { type: 'radio', name: typeName, value: x.v, checked: x.v === current });
    return { v: x.v, input, el: h('label', { class: 'check type-option' }, input, h('span', null, h('strong', null, x.label), h('span', { class: 'hint' }, ` ${x.hint}`))) };
  });
  const redirectUrl = h('input', {
    class: 'input',
    type: 'url',
    placeholder: 'https://',
    value: existing?.action.kind === 'redirect' ? existing.action.url : '',
  });
  const minutes = h('input', {
    class: 'input narrow',
    type: 'number',
    min: 1,
    max: 1440,
    step: 1,
    value: existing?.action.kind === 'budget' ? String(existing.action.minutesPerDay) : '20',
  });
  redirectUrl.addEventListener('input', dirty);
  minutes.addEventListener('input', dirty);
  const redirectField = field(t('rules_redirect_to', 'Redirect to'), redirectUrl, t('rules_redirect_hint', 'An http or https address. If it is blocked too, the block page shows instead.'));
  const minutesField = field(t('rules_minutes', 'Minutes per day'), minutes, t('rules_minutes_hint', 'Counts only while the tab is active, the window is focused and you are not idle.'));
  const selected = () => (radios.find((r) => r.input.checked)?.v ?? 'block') as RuleType;
  const syncType = () => {
    redirectField.hidden = selected() !== 'redirect';
    minutesField.hidden = selected() !== 'budget';
  };
  radios.forEach((r) => r.input.addEventListener('change', () => (syncType(), dirty())));
  syncType();

  const sched = scheduleEditor(existing?.schedule, dirty);
  const focusOnly = checkbox(
    t('rules_focus_only', 'Only during focus work intervals (adds the sites to the focus list)'),
    !!existing?.onlyDuringFocus,
    dirty,
  );
  const errors = errorBox();

  const save = async () => {
    const errs: string[] = [];
    const { targets: plain, errors: tErr } = parseTargetsText(targetsText.value, mode.value as TargetMode, subs.input.checked);
    errs.push(...tErr);
    const targets: Target[] = [...plain, ...groupBoxes.filter((b) => b.input.checked).map((b) => ({ kind: 'group' as const, groupId: b.g.id }))];
    if (!targets.length) errs.push(t('rules_err_no_targets', 'Add at least one site, URL or group.'));
    const type = selected();
    let action: Action = { kind: 'block' };
    if (type === 'redirect') {
      const url = redirectUrl.value.trim();
      if (!isValidRedirectUrl(url)) errs.push(t('rules_err_redirect', 'Enter a redirect address that starts with http:// or https://.'));
      action = { kind: 'redirect', url };
    } else if (type === 'budget') {
      const m = Number(minutes.value);
      if (!Number.isInteger(m) || m < 1 || m > 1440) errs.push(t('rules_err_minutes', 'Minutes per day must be a whole number from 1 to 1440.'));
      action = { kind: 'budget', minutesPerDay: m };
    }
    const s = sched.read();
    errs.push(...s.errors);
    errors.show(errs);
    if (errs.length) return;
    const rule: Rule = {
      id: existing?.id ?? newId(),
      targets,
      action,
      enabled: existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    const n = name.value.trim();
    if (n) rule.name = n;
    if (s.schedule) rule.schedule = s.schedule;
    if (focusOnly.input.checked) rule.onlyDuringFocus = true;
    if (type === 'allow') rule.allow = true;
    const res = await applyChange({ kind: 'rule.upsert', rule }, { successMessage: t('rules_saved', 'Rule saved.') });
    if (res.ok) close();
  };

  return h(
    'div',
    { class: 'card rule-editor', role: 'region', 'aria-label': existing ? t('rules_edit', 'Edit rule') : t('rules_new', 'New rule') },
    h('h2', null, existing ? t('rules_edit', 'Edit rule') : t('rules_new', 'New rule')),
    field(t('rules_name', 'Name (optional)'), name),
    field(
      t('rules_sites', 'Sites and URLs'),
      targetsText,
      t('rules_sites_hint', 'One per line. A bare domain blocks the whole site; add a path for part of a site; start a line with = for one exact URL.'),
    ),
    preview,
    h('div', { class: 'row' }, field(t('rules_match_mode', 'Match'), mode), subs.el),
    groupBoxes.length
      ? h('fieldset', null, h('legend', null, t('rules_groups_include', 'Include groups')), h('div', { class: 'row' }, groupBoxes.map((b) => b.el)))
      : null,
    h('fieldset', null, h('legend', null, t('rules_type', 'What happens')), h('div', { class: 'stack type-list' }, radios.map((r) => r.el))),
    redirectField,
    minutesField,
    sched.el,
    focusOnly.el,
    errors.el,
    h(
      'div',
      { class: 'row end' },
      h('button', { type: 'button', class: 'btn', onclick: close }, t('rules_cancel', 'Cancel')),
      h('button', { type: 'button', class: 'btn primary', onclick: () => void save() }, t('rules_save', 'Save rule')),
    ),
  );
}

// ---- Rule list ----

function ruleRow(rule: Rule, snap: Snapshot, ctx: SectionCtx, openEditor: (r?: Rule) => void): HTMLElement {
  const isHide = rule.action.kind === 'hide' && !rule.allow;
  const budget = snap.budgets.find((b) => b.ruleId === rule.id);
  const toggle = h('input', { type: 'checkbox', checked: rule.enabled });
  toggle.addEventListener('change', async () => {
    const res = await applyChange({ kind: 'rule.setEnabled', id: rule.id, enabled: toggle.checked });
    if (!res.ok) toggle.checked = !toggle.checked;
  });
  const title = ruleTitle(rule, snap);
  return h(
    'li',
    { class: 'rule-row' },
    h(
      'div',
      { class: 'rule-main' },
      h('div', { class: 'row' }, h('h3', { class: 'rule-name' }, title), rulePills(rule, snap)),
      h('div', { class: 'rule-line' }, rule.targets.map((x) => targetLabel(x, snap.config.groups)).join(', ')),
      h('div', { class: 'rule-line muted' }, `${actionSummary(rule, snap.presets)} · ${describeSchedule(rule.schedule)}`),
      budget ? budgetBar(budget) : null,
    ),
    h(
      'div',
      { class: 'rule-actions row' },
      h('label', { class: 'check' }, toggle, h('span', { class: 'sr-only' }, `${title}: `), t('rules_enabled', 'On')),
      isHide
        ? h('button', { type: 'button', class: 'btn small', onclick: () => ctx.go('hide') }, t('rules_edit_hide', 'Edit in Element hiding'))
        : h('button', { type: 'button', class: 'btn small', 'aria-label': `${t('rules_edit_btn', 'Edit')} ${title}`, onclick: () => openEditor(rule) }, t('rules_edit_btn', 'Edit')),
      h(
        'button',
        {
          type: 'button',
          class: 'btn small ghost',
          'aria-label': `${t('rules_delete', 'Delete')} ${title}`,
          onclick: async () => {
            const ok = await confirmDialog(
              t('rules_delete_title', 'Delete this rule?'),
              `“${title}” ` + t('rules_delete_body', 'will be removed. This cannot be undone.'),
              t('rules_delete', 'Delete'),
              true,
            );
            if (ok) await applyChange({ kind: 'rule.delete', id: rule.id }, { successMessage: t('rules_deleted', 'Rule deleted.') });
          },
        },
        t('rules_delete', 'Delete'),
      ),
    ),
  );
}

// ---- Groups ----

function groupEditor(snap: Snapshot, ctx: SectionCtx, existing: Group | undefined, close: () => void): HTMLElement {
  const dirty = () => ctx.setDirty(true);
  const name = h('input', { class: 'input', value: existing?.name ?? '', placeholder: t('rules_group_name_ph', 'e.g. Social') });
  name.addEventListener('input', dirty);
  const startTargets = existing?.targets ?? [];
  const mode = modeFor(startTargets);
  const text = h('textarea', { class: 'input mono', rows: 4, spellcheck: 'false', value: targetsToText(startTargets, mode), placeholder: 'reddit.com\nx.com' });
  text.addEventListener('input', dirty);
  const subs = checkbox(t('rules_subdomains', 'Include subdomains (m.reddit.com, old.reddit.com …)'), subdomainsFor(startTargets), dirty);
  const errors = errorBox();
  const save = async () => {
    const errs: string[] = [];
    const n = name.value.trim();
    if (!n) errs.push(t('rules_err_group_name', 'Give the group a name.'));
    const { targets, errors: tErr } = parseTargetsText(text.value, mode, subs.input.checked);
    errs.push(...tErr);
    if (!targets.length) errs.push(t('rules_err_group_targets', 'Add at least one site to the group.'));
    errors.show(errs);
    if (errs.length) return;
    const res = await applyChange(
      { kind: 'group.upsert', group: { id: existing?.id ?? newId(), name: n, targets } },
      { successMessage: t('rules_group_saved', 'Group saved.') },
    );
    if (res.ok) close();
  };
  return h(
    'div',
    { class: 'card rule-editor', role: 'region', 'aria-label': existing ? t('rules_group_edit', 'Edit group') : t('rules_group_new', 'New group') },
    h('h2', null, existing ? t('rules_group_edit', 'Edit group') : t('rules_group_new', 'New group')),
    field(t('rules_group_name', 'Group name'), name),
    field(t('rules_sites', 'Sites and URLs'), text, t('rules_group_sites_hint', 'One per line. Rules that include this group apply to all of these sites.')),
    subs.el,
    errors.el,
    h(
      'div',
      { class: 'row end' },
      h('button', { type: 'button', class: 'btn', onclick: close }, t('rules_cancel', 'Cancel')),
      h('button', { type: 'button', class: 'btn primary', onclick: () => void save() }, t('rules_group_save', 'Save group')),
    ),
  );
}

function groupRow(g: Group, snap: Snapshot, openEditor: (g?: Group) => void): HTMLElement {
  const users = snap.config.rules.filter((r) => r.targets.some((x) => x.kind === 'group' && x.groupId === g.id)).length;
  return h(
    'li',
    { class: 'rule-row' },
    h(
      'div',
      { class: 'rule-main' },
      h('h3', { class: 'rule-name' }, g.name),
      h('div', { class: 'rule-line' }, g.targets.map((x) => targetLabel(x)).join(', ')),
      h('div', { class: 'rule-line muted' }, `${t('rules_group_used_by', 'Used by rules:')} ${users}`),
    ),
    h(
      'div',
      { class: 'rule-actions row' },
      h('button', { type: 'button', class: 'btn small', 'aria-label': `${t('rules_edit_btn', 'Edit')} ${g.name}`, onclick: () => openEditor(g) }, t('rules_edit_btn', 'Edit')),
      h(
        'button',
        {
          type: 'button',
          class: 'btn small ghost',
          'aria-label': `${t('rules_delete', 'Delete')} ${g.name}`,
          onclick: async () => {
            const body = users
              ? t('rules_group_delete_used', 'Rules that use this group will stop covering its sites. This cannot be undone.')
              : t('rules_group_delete_body', 'This cannot be undone.');
            const ok = await confirmDialog(t('rules_group_delete_title', 'Delete this group?'), body, t('rules_delete', 'Delete'), true);
            if (ok) await applyChange({ kind: 'group.delete', id: g.id }, { successMessage: t('rules_group_deleted', 'Group deleted.') });
          },
        },
        t('rules_delete', 'Delete'),
      ),
    ),
  );
}

// ---- Section ----

const section: Section = {
  id: 'rules',
  title: t('rules_title', 'Rules'),
  render(root, snap, ctx) {
    ensureRulesCss();
    const { rules, groups } = snap.config;

    const ruleEditorHost = h('div');
    const groupEditorHost = h('div');
    const closeEditors = () => {
      ruleEditorHost.replaceChildren();
      groupEditorHost.replaceChildren();
      ctx.setDirty(false);
      void ctx.refresh();
    };
    const openRule = (r?: Rule) => {
      groupEditorHost.replaceChildren();
      ruleEditorHost.replaceChildren(ruleEditor(snap, ctx, r, closeEditors));
      ctx.setDirty(true);
      ruleEditorHost.querySelector<HTMLElement>('input, textarea')?.focus();
    };
    const openGroup = (g?: Group) => {
      ruleEditorHost.replaceChildren();
      groupEditorHost.replaceChildren(groupEditor(snap, ctx, g, closeEditors));
      ctx.setDirty(true);
      groupEditorHost.querySelector<HTMLElement>('input')?.focus();
    };

    root.append(
      h(
        'p',
        { class: 'muted' },
        t(
          'rules_intro',
          'Rules block, redirect or budget sites. When rules overlap, a more specific exception wins over a broader rule; otherwise the strictest rule wins.',
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'row between' },
          h('h2', null, t('rules_heading', 'Rules')),
          h('button', { type: 'button', class: 'btn primary', onclick: () => openRule() }, t('rules_add', 'Add rule')),
        ),
        ruleEditorHost,
        rules.length
          ? h('ul', { class: 'rule-list' }, rules.map((r) => ruleRow(r, snap, ctx, openRule)))
          : h('p', { class: 'muted' }, t('rules_empty', 'No rules yet. Add one, or block the current site from the toolbar button.')),
      ),
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'row between' },
          h('h2', null, t('rules_groups', 'Groups')),
          h('button', { type: 'button', class: 'btn', onclick: () => openGroup() }, t('rules_group_add', 'Add group')),
        ),
        h('p', { class: 'hint' }, t('rules_groups_intro', 'A group is a named list of sites that several rules can share.')),
        groupEditorHost,
        groups.length
          ? h('ul', { class: 'rule-list' }, groups.map((g) => groupRow(g, snap, openGroup)))
          : h('p', { class: 'muted' }, t('rules_groups_empty', 'No groups yet.')),
      ),
    );
  },
};
export default section;
