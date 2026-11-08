// Focus mode (FR-6): Pomodoro config, the focus list, start / end a session.
import { DEFAULT_FOCUS, phaseLabel, validateFocusConfig } from '../../shared/focus.ts';
import { newId } from '../../shared/defaults.ts';
import type { FocusConfig, Rule } from '../../shared/types.ts';
import { targetLabel } from '../../shared/url.ts';
import { field, formatClock, formatCountdown, h, t, toast } from '../../ui/dom.ts';
import { applyChange, confirmDialog } from '../../ui/gate.ts';
import { activeLocksOf, durationText, ensureCommitCss, numberInput, parseSitesText, targetsToText } from '../commit-common.ts';
import type { Section } from '../section.ts';

const FOCUS_LIST_NAME = 'Focus list';

function isFocusListRule(r: Rule): boolean {
  return !!r.onlyDuringFocus && r.name === FOCUS_LIST_NAME && !r.allow;
}

const section: Section = {
  id: 'focus',
  title: t('focus_title', 'Focus mode'),
  render(root, snap, ctx) {
    ensureCommitCss();
    const { config, runtime } = snap;
    const focus = runtime.focus;
    const locks = activeLocksOf(runtime, snap.now);

    root.append(
      h(
        'p',
        { class: 'muted' },
        t(
          'focus_intro',
          'Pomodoro sessions block your focus list during work intervals and open it during breaks. You get a notification at each change, and the countdown shows on the toolbar badge.',
        ),
      ),
    );

    // ---- Session status ----
    const sessionCard = h('div', { class: 'card' });
    root.append(sessionCard);
    if (focus && snap.focusPhase) {
      const ph = snap.focusPhase;
      const countdown = h('div', { class: 'countdown-big', 'aria-live': 'off' }, formatCountdown(ph.endsAt - Date.now()));
      let refreshed = false;
      ctx.every(1000, () => {
        const left = ph.endsAt - Date.now();
        countdown.textContent = formatCountdown(left);
        if (left <= 0 && !refreshed) {
          refreshed = true;
          void ctx.refresh();
        }
      });
      let reason: string | null = null;
      if (locks.length) reason = t('focus_end_locked', 'A Hard Lock is active, so this session cannot end early.');
      else if (config.settings.commitment === 'challenge')
        reason = t('focus_end_challenge', 'Your commitment level is Challenge, so sessions cannot end early.');
      const endBtn = h(
        'button',
        {
          class: 'btn',
          type: 'button',
          disabled: !!reason,
          'aria-describedby': reason ? 'focus-end-reason' : null,
          onclick: async () => {
            const ok = await confirmDialog(
              t('focus_end_title', 'End the focus session early?'),
              t('focus_end_body', 'Your focus list will open again right away.'),
              t('focus_end_confirm', 'End session'),
              true,
            );
            if (ok) await applyChange({ kind: 'focus.stop' }, { successMessage: t('focus_ended', 'Focus session ended.') });
          },
        },
        t('focus_end', 'End session early'),
      );
      sessionCard.append(
        h('h2', null, t('focus_running', 'Session in progress')),
        h(
          'div',
          { class: 'row' },
          h('span', { class: ph.kind === 'work' ? 'pill lock' : 'pill on' }, phaseLabel(ph.kind)),
          h('span', { class: 'muted' }, `Cycle ${ph.cycle} of ${focus.cycles}`),
        ),
        countdown,
        h(
          'p',
          { class: 'muted' },
          ph.kind === 'work'
            ? t('focus_work_note', 'Your focus list is blocked until this interval ends.')
            : t('focus_break_note', 'Break: your focus list is open until this interval ends.'),
          ' ',
          snap.focusEndsAt ? `Session ends at ${formatClock(snap.focusEndsAt)}.` : '',
        ),
        h('div', { class: 'row' }, endBtn),
        reason ? h('p', { class: 'hint', id: 'focus-end-reason' }, reason) : '',
      );
    } else {
      const c = config.focusConfig;
      const total = c.cycles * c.workMin + (c.cycles - 1) * c.breakMin + c.longBreakMin;
      const focusRules = config.rules.filter((r) => r.onlyDuringFocus && r.enabled);
      sessionCard.append(
        h('h2', null, t('focus_start_title', 'Start a session')),
        h(
          'p',
          null,
          `${c.cycles} × ${c.workMin} min focus, ${c.breakMin} min breaks, ${c.longBreakMin} min long break — ${durationText(total)} in total.`,
        ),
        focusRules.length === 0
          ? h('p', { class: 'hint' }, t('focus_empty_list', 'Your focus list is empty, so nothing will be blocked. Add sites below first.'))
          : '',
        h(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            onclick: () => applyChange({ kind: 'focus.start' }, { successMessage: t('focus_started', 'Focus session started.') }),
          },
          t('focus_start', 'Start focus session'),
        ),
      );
    }

    // ---- Focus list ----
    const listRule = config.rules.find(isFocusListRule);
    const otherFocusRules = config.rules.filter((r) => r.onlyDuringFocus && !isFocusListRule(r));
    const sites = h('textarea', {
      class: 'input',
      rows: 6,
      id: 'focus-sites',
      placeholder: 'reddit.com\nx.com\nyoutube.com/shorts',
      oninput: () => ctx.setDirty(true),
    });
    sites.value = listRule ? targetsToText(listRule.targets) : '';
    const listErr = h('div', { class: 'error-text', role: 'alert' });
    const saveList = async () => {
      const { targets, invalid } = parseSitesText(sites.value);
      if (invalid.length) {
        listErr.textContent = `Not a valid site: ${invalid.join(', ')}`;
        return;
      }
      listErr.textContent = '';
      const groupTargets = listRule ? listRule.targets.filter((x) => x.kind === 'group') : [];
      const all = [...targets, ...groupTargets];
      let res;
      if (listRule && all.length === 0) {
        res = await applyChange({ kind: 'rule.delete', id: listRule.id });
      } else if (listRule) {
        res = await applyChange({ kind: 'rule.upsert', rule: { ...listRule, targets: all } });
      } else if (all.length) {
        res = await applyChange({
          kind: 'rule.upsert',
          rule: {
            id: newId(),
            name: FOCUS_LIST_NAME,
            targets: all,
            action: { kind: 'block' },
            onlyDuringFocus: true,
            enabled: true,
            createdAt: Date.now(),
          },
        });
      } else {
        ctx.setDirty(false);
        return;
      }
      if (res.ok) {
        ctx.setDirty(false);
        toast(t('focus_list_saved', 'Focus list saved.'), 'success');
        await ctx.refresh();
      }
    };
    root.append(
      h(
        'div',
        { class: 'card' },
        h('h2', null, t('focus_list_title', 'Focus list')),
        h(
          'p',
          { class: 'muted' },
          t('focus_list_intro', 'Sites blocked only during work intervals. One per line: a domain (reddit.com) or a path (youtube.com/shorts). Start a line with = for an exact URL.'),
        ),
        field(t('focus_list_label', 'Sites to block during focus'), sites),
        listErr,
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: saveList }, t('focus_list_save', 'Save focus list'))),
        otherFocusRules.length
          ? h(
              'div',
              { class: 'stack-sm' },
              h('h3', null, t('focus_other_rules', 'Other rules active only during focus')),
              h(
                'ul',
                null,
                otherFocusRules.map((r) =>
                  h(
                    'li',
                    null,
                    `${r.name || 'Untitled rule'}: ${r.targets.map((x) => targetLabel(x, config.groups)).join(', ')}`,
                    r.enabled ? '' : ' (disabled)',
                  ),
                ),
              ),
              h('p', { class: 'hint' }, t('focus_other_hint', 'Edit these on the Rules page.')),
            )
          : '',
      ),
    );

    // ---- Config ----
    const c = config.focusConfig;
    const dirty = () => ctx.setDirty(true);
    const work = numberInput(c.workMin, 1, 240, dirty);
    const brk = numberInput(c.breakMin, 0, 120, dirty);
    const longBrk = numberInput(c.longBreakMin, 0, 240, dirty);
    const cycles = numberInput(c.cycles, 1, 12, dirty);
    const cfgErr = h('div', { class: 'error-text', role: 'alert' });
    const saveCfg = async (next: FocusConfig) => {
      const err = validateFocusConfig(next);
      if (err) {
        cfgErr.textContent = err;
        return;
      }
      cfgErr.textContent = '';
      const res = await applyChange({ kind: 'focus.config', config: next });
      if (res.ok) {
        ctx.setDirty(false);
        toast(t('focus_cfg_saved', 'Focus settings saved. They apply to the next session.'), 'success');
        await ctx.refresh();
      }
    };
    root.append(
      h(
        'div',
        { class: 'card' },
        h('h2', null, t('focus_cfg_title', 'Session settings')),
        h(
          'div',
          { class: 'grid-4' },
          field(t('focus_work', 'Focus (min)'), work),
          field(t('focus_break', 'Break (min)'), brk),
          field(t('focus_long', 'Long break (min)'), longBrk),
          field(t('focus_cycles', 'Cycles'), cycles),
        ),
        cfgErr,
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'btn primary',
              type: 'button',
              onclick: () =>
                saveCfg({
                  workMin: Number(work.value),
                  breakMin: Number(brk.value),
                  longBreakMin: Number(longBrk.value),
                  cycles: Number(cycles.value),
                }),
            },
            t('focus_cfg_save', 'Save settings'),
          ),
          h(
            'button',
            { class: 'btn', type: 'button', onclick: () => saveCfg({ ...DEFAULT_FOCUS }) },
            t('focus_cfg_default', 'Reset to 25 / 5 / 15 / 4'),
          ),
        ),
        h('p', { class: 'hint' }, t('focus_cfg_hint', 'Changes apply to the next session, not the one running now.')),
      ),
    );
  },
};
export default section;
