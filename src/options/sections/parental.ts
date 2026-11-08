// Parental controls section. All changes go through applyChange(); once parental
// mode is on with a PIN, the worker answers 'gate' with level 'guardian' and
// ui/gate.ts asks for the PIN.
import type { ParentalPatch } from '../../shared/changes.ts';
import type { Snapshot } from '../../shared/messages.ts';
import type { ParentalConfig, ParentalDetection, Sensitivity } from '../../shared/types.ts';
import { parseTargetInput } from '../../shared/url.ts';
import { field, h, t, toast, uniqueId } from '../../ui/dom.ts';
import { applyChange, confirmDialog } from '../../ui/gate.ts';
import type { Section, SectionCtx } from '../section.ts';

const MAX_WORDS = 200;
const MAX_WORD_LEN = 50;
const MIN_PIN = 4;

function ensureCss(): void {
  if (!document.querySelector('link[href="parental.css"]')) {
    document.head.append(h('link', { rel: 'stylesheet', href: 'parental.css' }));
  }
}

function tf(key: string, fallback: string, ...subs: string[]): string {
  return t(key, fallback, subs).replace(/\$(\d)/g, (_, n) => subs[Number(n) - 1] ?? '');
}

/** A live error region; set(text) shows it, set('') hides it. */
function errorBox(): { el: HTMLElement; set: (msg: string | string[]) => void } {
  const el = h('div', { class: 'error-text parental-errors', role: 'alert' });
  return {
    el,
    set: (msg) => {
      const list = Array.isArray(msg) ? msg : msg ? [msg] : [];
      el.replaceChildren(...list.map((m) => h('div', null, m)));
    },
  };
}

function pinInput(label: string, hint?: string): { el: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { class: 'input pin-input', type: 'password', autocomplete: 'new-password', inputmode: 'numeric' });
  return { el: field(label, input, hint), input };
}

/** Validate two PIN fields; returns an error message or null. */
function checkPins(a: string, b: string): string | null {
  if (a.length < MIN_PIN) return tf('parental_pin_short', 'The PIN needs at least $1 characters.', String(MIN_PIN));
  if (a !== b) return t('parental_pin_mismatch', 'The two PINs do not match.');
  return null;
}

// ---- Cards shown in both states ----

function featureList(snap: Snapshot): HTMLElement {
  return h(
    'ul',
    { class: 'parental-features' },
    h('li', null, tf('parental_feat_known', 'Blocks $1 known adult sites, with their subdomains.', String(snap.parentalKnownSites))),
    h('li', null, t('parental_feat_pages', 'Checks each page on this device for explicit content (adult-content labels, words in the title, address and text) and blocks it. It can learn a whole site from one page.')),
    h('li', null, t('parental_feat_images', 'Scans images on this device with a built-in classifier, blurs explicit ones and blocks pages that show several.')),
    h('li', null, t('parental_feat_social', 'Hides individual NSFW or sensitive posts in social feeds, so the rest of the site still works.')),
    h('li', null, t('parental_feat_safe', 'Turns on SafeSearch for Google, Bing and DuckDuckGo, and YouTube Restricted Mode.')),
  );
}

function limitsCard(): HTMLElement {
  return h(
    'div',
    { class: 'card note' },
    h('h2', null, t('parental_limits_title', 'Limits you should know')),
    h(
      'ul',
      { class: 'parental-list' },
      h('li', null, t('parental_limits_remove', 'Anyone who can open chrome://extensions can turn off or remove any extension, including this one. The PIN protects settings inside FocusGuard, not the extension itself.')),
      h(
        'li',
        null,
        t('parental_limits_policy', 'For real enforcement, use Google Family Link, or Chrome policies on this computer:'),
        ' ',
        h('code', null, 'ExtensionInstallForcelist'),
        ' ',
        t('parental_limits_policy_force', '(force-install FocusGuard),'),
        ' ',
        h('code', null, 'IncognitoModeAvailability=1'),
        ' ',
        t('parental_limits_policy_incog', '(no Incognito) and'),
        ' ',
        h('code', null, 'DeveloperToolsAvailability=2'),
        ' ',
        t('parental_limits_policy_dev', '(no developer tools).'),
      ),
      h('li', null, t('parental_limits_detect', 'On-device detection can miss content or flag a safe page. If a safe site is blocked, a guardian can allow it with the PIN, here or on the block page.')),
    ),
  );
}

function privacyCard(): HTMLElement {
  return h(
    'div',
    { class: 'card note' },
    h('h2', null, t('parental_privacy_title', 'Privacy')),
    h('p', null, t('parental_privacy_body', 'Pages and images are checked on this device only. FocusGuard keeps just the names of sites it learns to block, never page text, images or addresses, and sends nothing anywhere.')),
  );
}

// ---- Off state ----

function renderOff(root: HTMLElement, snap: Snapshot, ctx: SectionCtx): void {
  const p = snap.config.parental;
  const errs = errorBox();
  const pin1 = pinInput(t('parental_pin_new', 'Guardian PIN'), tf('parental_pin_hint', 'At least $1 characters. Keep it from the child.', String(MIN_PIN)));
  const pin2 = pinInput(t('parental_pin_repeat', 'Repeat PIN'));
  const needsPin = !p.hasPin;
  const btn = h('button', { class: 'btn primary', type: 'submit' }, t('parental_turn_on', 'Turn on parental controls'));
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        errs.set('');
        let pin: string | undefined;
        if (needsPin) {
          const bad = checkPins(pin1.input.value, pin2.input.value);
          if (bad) {
            errs.set(bad);
            pin1.input.focus();
            return;
          }
          pin = pin1.input.value;
        }
        btn.disabled = true;
        const res = await applyChange({ kind: 'parental.enable', pin }, { successMessage: t('parental_on_toast', 'Parental controls are on.') });
        btn.disabled = false;
        if (res.ok) {
          ctx.setDirty(false);
          await ctx.refresh();
        } else if (res.error !== 'gate') {
          errs.set(res.message);
        }
      },
      oninput: () => ctx.setDirty(true),
    },
    needsPin
      ? h('div', { class: 'grid-pins' }, pin1.el, pin2.el)
      : h('p', { class: 'hint' }, t('parental_pin_kept', 'Your earlier guardian PIN is still set and will be used.')),
    errs.el,
    h('div', { class: 'row' }, btn),
  );
  root.append(
    h(
      'div',
      { class: 'card' },
      h('h2', null, t('parental_off_title', 'Keep explicit content away from a child')),
      h('p', null, t('parental_off_lead', 'Turn this on for a browser a child uses. A guardian PIN protects every parental setting.')),
      featureList(snap),
      form,
    ),
    limitsCard(),
    privacyCard(),
  );
}

// ---- On state ----

const SENSITIVITY: { value: Sensitivity; label: string; hint: string }[] = [
  { value: 'low', label: t('parental_sens_low', 'Low'), hint: t('parental_sens_low_hint', 'Only clearly explicit pages and images. Fewest false alarms.') },
  { value: 'medium', label: t('parental_sens_medium', 'Medium'), hint: t('parental_sens_medium_hint', 'Explicit pages and images, plus strongly suggestive ones. Recommended.') },
  { value: 'high', label: t('parental_sens_high', 'High'), hint: t('parental_sens_high_hint', 'Also suggestive content, and images stay blurred until checked. Best for young children; more false alarms.') },
];

function checkbox(label: string, checked: boolean, hint?: string): { el: HTMLElement; input: HTMLInputElement } {
  const id = uniqueId('pc');
  const input = h('input', { type: 'checkbox', id, checked, 'aria-describedby': hint ? `${id}-hint` : null });
  return {
    input,
    el: h('div', { class: 'parental-toggle' }, h('label', { class: 'check', for: id }, input, label), hint ? h('div', { class: 'hint', id: `${id}-hint` }, hint) : null),
  };
}

function radioGroup<T extends string>(name: string, legend: string, options: { value: T; label: string; hint: string }[], current: T): { el: HTMLElement; get: () => T } {
  const inputs: { value: T; input: HTMLInputElement }[] = [];
  const fs = h('fieldset', null, h('legend', null, legend));
  for (const o of options) {
    const id = uniqueId('pr');
    const input = h('input', { type: 'radio', name, id, value: o.value, checked: o.value === current, 'aria-describedby': `${id}-hint` });
    inputs.push({ value: o.value, input });
    fs.append(h('div', { class: 'radio-row' }, h('label', { class: 'check', for: id }, input, o.label), h('div', { class: 'hint', id: `${id}-hint` }, o.hint)));
  }
  return { el: fs, get: () => inputs.find((i) => i.input.checked)?.value ?? current };
}

function parseWords(text: string): { words: string[]; errors: string[] } {
  const words: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const w = raw.trim().toLowerCase();
    if (!w || seen.has(w)) continue;
    if (w.length > MAX_WORD_LEN) {
      errors.push(tf('parental_word_long', '“$1…” is longer than $2 characters.', w.slice(0, 20), String(MAX_WORD_LEN)));
      continue;
    }
    seen.add(w);
    words.push(w);
  }
  if (words.length > MAX_WORDS) errors.push(tf('parental_words_many', 'Use at most $1 blocked words (you have $2).', String(MAX_WORDS), String(words.length)));
  return { words, errors };
}

function parseAllowed(text: string): { hosts: string[]; errors: string[] } {
  const hosts: string[] = [];
  const errors: string[] = [];
  for (const raw of text.split(/[\n,]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const tgt = parseTargetInput(line, 'domain-only');
    if (!tgt || tgt.kind !== 'domain') {
      errors.push(tf('parental_site_bad', '“$1” is not a site address.', line));
      continue;
    }
    if (!hosts.includes(tgt.host)) hosts.push(tgt.host);
  }
  return { hosts, errors };
}

function settingsCard(snap: Snapshot, ctx: SectionCtx): HTMLElement {
  const p = snap.config.parental;
  const known = checkbox(t('parental_opt_known', 'Block known adult sites'), p.blockKnownSites, tf('parental_opt_known_hint', '$1 sites, including their subdomains.', String(snap.parentalKnownSites)));
  const pages = checkbox(t('parental_opt_pages', 'Check pages for explicit content'), p.detectPages, t('parental_opt_pages_hint', 'Looks at adult-content labels and words in the title, address and text, on this device.'));
  const scope = radioGroup<ParentalConfig['detectScope']>(
    'parental-scope',
    t('parental_scope_legend', 'When a page is detected'),
    [
      { value: 'site', label: t('parental_scope_site', 'Block the whole site once a page is detected'), hint: t('parental_scope_site_hint', 'FocusGuard learns the site and blocks it before it loads next time.') },
      { value: 'page', label: t('parental_scope_page', 'Only the page'), hint: t('parental_scope_page_hint', 'Other pages on the same site stay open and are checked one by one.') },
    ],
    p.detectScope,
  );
  const hideUntil = checkbox(t('parental_opt_hide', 'Hide pages until they are checked'), p.hideUntilChecked, t('parental_opt_hide_hint', 'Stops explicit content flashing on screen. Pages can appear a moment later.'));
  const images = checkbox(t('parental_opt_images', 'Scan images'), p.scanImages, t('parental_opt_images_hint', 'Blurs explicit images and blocks pages that show several. Uses more processing power.'));
  const sens = radioGroup<Sensitivity>('parental-sens', t('parental_sens_legend', 'Sensitivity'), SENSITIVITY, p.sensitivity);
  const safe = checkbox(t('parental_opt_safe', 'Force SafeSearch and YouTube Restricted Mode'), p.safeSearch, t('parental_opt_safe_hint', 'Google, Bing and DuckDuckGo results are filtered; YouTube hides mature videos.'));
  const social = checkbox(t('parental_opt_social', 'Filter social media feeds'), p.socialFilter, t('parental_opt_social_hint', 'Hides individual NSFW or sensitive posts (for example on Reddit and X) instead of blocking the whole site.'));

  const syncScope = () => {
    const off = !pages.input.checked;
    scope.el.querySelectorAll('input').forEach((i) => (i.disabled = off));
    hideUntil.input.disabled = off;
  };
  pages.input.addEventListener('change', syncScope);
  syncScope();

  const wordsArea = h('textarea', { class: 'input', rows: 5, spellcheck: 'false' });
  wordsArea.value = p.blockedWords.join('\n');
  const sitesArea = h('textarea', { class: 'input', rows: 4, spellcheck: 'false' });
  sitesArea.value = p.allowedSites.join('\n');

  const errs = errorBox();
  const save = h('button', { class: 'btn primary', type: 'submit' }, t('parental_save', 'Save'));
  const cancel = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: () => {
        ctx.setDirty(false);
        void ctx.refresh();
      },
    },
    t('parental_cancel', 'Undo changes'),
  );

  return h(
    'form',
    {
      class: 'card',
      'aria-labelledby': 'parental-settings-title',
      oninput: () => ctx.setDirty(true),
      onchange: () => ctx.setDirty(true),
      onsubmit: async (e: Event) => {
        e.preventDefault();
        errs.set('');
        const w = parseWords(wordsArea.value);
        const s = parseAllowed(sitesArea.value);
        const problems = [...w.errors, ...s.errors];
        if (problems.length) {
          errs.set(problems);
          return;
        }
        const patch: ParentalPatch = {
          blockKnownSites: known.input.checked,
          detectPages: pages.input.checked,
          detectScope: scope.get(),
          hideUntilChecked: hideUntil.input.checked,
          scanImages: images.input.checked,
          sensitivity: sens.get(),
          safeSearch: safe.input.checked,
          socialFilter: social.input.checked,
          blockedWords: w.words,
          allowedSites: s.hosts,
        };
        save.disabled = true;
        const res = await applyChange({ kind: 'parental.update', patch }, { successMessage: t('parental_saved', 'Parental settings saved.') });
        save.disabled = false;
        if (res.ok) {
          ctx.setDirty(false);
          await ctx.refresh();
        } else if (res.error !== 'gate') {
          errs.set(res.message);
        }
      },
    },
    h('h2', { id: 'parental-settings-title' }, t('parental_settings_title', 'What to filter')),
    h(
      'fieldset',
      null,
      h('legend', null, t('parental_layers_legend', 'Filters')),
      known.el,
      pages.el,
      h('div', { class: 'parental-sub' }, scope.el, hideUntil.el),
      images.el,
      social.el,
      safe.el,
    ),
    sens.el,
    field(
      t('parental_words_label', 'Extra blocked words'),
      wordsArea,
      tf('parental_words_hint', 'One per line, up to $1. A page that uses one of these words counts as explicit.', String(MAX_WORDS)),
    ),
    field(
      t('parental_allowed_label', 'Always allowed sites'),
      sitesArea,
      t('parental_allowed_hint', 'One site per line, for example wikipedia.org. The parental filter never blocks these. Your own rules still apply.'),
    ),
    errs.el,
    h('div', { class: 'row' }, save, cancel),
  );
}

const SOURCE_LABEL: Record<ParentalDetection['source'], string> = {
  text: t('parental_src_text', 'Page text'),
  meta: t('parental_src_meta', 'Adult-content label'),
  images: t('parental_src_images', 'Images'),
};

function learnedCard(snap: Snapshot, ctx: SectionCtx): HTMLElement {
  const list = [...(snap.runtime.parentalDetected ?? [])].sort((a, b) => b.at - a.at);
  const card = h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'row between' },
      h('h2', null, t('parental_learned_title', 'Learned sites')),
      list.length
        ? h(
            'button',
            {
              class: 'btn small',
              type: 'button',
              onclick: async () => {
                const ok = await confirmDialog(
                  t('parental_forget_all_title', 'Forget all learned sites?'),
                  t('parental_forget_all_body', 'They open again until a page on them is detected again.'),
                  t('parental_forget_all', 'Forget all'),
                  true,
                );
                if (!ok) return;
                const res = await applyChange({ kind: 'parental.forget', host: null }, { successMessage: t('parental_forgot_all', 'All learned sites forgotten.') });
                if (res.ok) await ctx.refresh();
              },
            },
            t('parental_forget_all', 'Forget all'),
          )
        : null,
    ),
    h('p', { class: 'hint' }, t('parental_learned_hint', 'Sites blocked because one of their pages was detected. Only the site name is kept.')),
  );
  if (!list.length) {
    card.append(h('p', { class: 'muted' }, t('parental_learned_none', 'No sites learned yet.')));
    return card;
  }
  card.append(
    h(
      'table',
      { class: 'list' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { scope: 'col' }, t('parental_col_site', 'Site')),
          h('th', { scope: 'col' }, t('parental_col_when', 'Detected')),
          h('th', { scope: 'col' }, t('parental_col_how', 'How')),
          h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, t('parental_col_actions', 'Actions'))),
        ),
      ),
      h(
        'tbody',
        null,
        list.map((d) =>
          h(
            'tr',
            null,
            h('td', null, h('code', null, d.host)),
            h('td', null, new Date(d.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })),
            h('td', null, SOURCE_LABEL[d.source] ?? d.source),
            h(
              'td',
              { class: 'actions-cell' },
              h(
                'button',
                {
                  class: 'btn small',
                  type: 'button',
                  'aria-label': tf('parental_forget_label', 'Forget $1', d.host),
                  onclick: async () => {
                    const res = await applyChange({ kind: 'parental.forget', host: d.host }, { successMessage: tf('parental_forgot', '$1 forgotten.', d.host) });
                    if (res.ok) await ctx.refresh();
                  },
                },
                t('parental_forget', 'Forget'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return card;
}

function pinAndOffCard(ctx: SectionCtx): HTMLElement {
  const pin1 = pinInput(t('parental_pin_new2', 'New PIN'), tf('parental_pin_hint', 'At least $1 characters. Keep it from the child.', String(MIN_PIN)));
  const pin2 = pinInput(t('parental_pin_repeat', 'Repeat PIN'));
  const errs = errorBox();
  const change = h('button', { class: 'btn', type: 'submit' }, t('parental_change_pin', 'Change PIN'));
  const off = h(
    'button',
    {
      class: 'btn danger',
      type: 'button',
      onclick: async () => {
        const ok = await confirmDialog(
          t('parental_off_confirm_title', 'Turn off parental controls?'),
          t('parental_off_confirm_body', 'Known sites, page and image checks, feed filtering and SafeSearch all stop. Learned sites are kept for when you turn it on again.'),
          t('parental_turn_off', 'Turn off'),
          true,
        );
        if (!ok) return;
        const res = await applyChange({ kind: 'parental.disable' }, { successMessage: t('parental_off_toast', 'Parental controls are off.') });
        if (res.ok) await ctx.refresh();
      },
    },
    t('parental_turn_off_btn', 'Turn off parental controls'),
  );
  return h(
    'div',
    { class: 'card' },
    h('h2', null, t('parental_pin_title', 'Guardian PIN')),
    h(
      'form',
      {
        class: 'stack',
        oninput: () => ctx.setDirty(true),
        onsubmit: async (e: Event) => {
          e.preventDefault();
          errs.set('');
          const bad = checkPins(pin1.input.value, pin2.input.value);
          if (bad) {
            errs.set(bad);
            pin1.input.focus();
            return;
          }
          change.disabled = true;
          const res = await applyChange({ kind: 'parental.setPin', newPin: pin1.input.value }, { successMessage: t('parental_pin_changed', 'PIN changed.') });
          change.disabled = false;
          if (res.ok) {
            pin1.input.value = '';
            pin2.input.value = '';
            ctx.setDirty(false);
          } else if (res.error !== 'gate') {
            errs.set(res.message);
          }
        },
      },
      h('div', { class: 'grid-pins' }, pin1.el, pin2.el),
      errs.el,
      h('div', { class: 'row' }, change),
    ),
    h('hr', { class: 'sep' }),
    h('p', { class: 'hint' }, t('parental_off_hint', 'Turning parental controls off needs the PIN.')),
    off,
  );
}

function renderOn(root: HTMLElement, snap: Snapshot, ctx: SectionCtx): void {
  const p = snap.config.parental;
  if (!snap.incognitoAllowed) {
    root.append(
      h(
        'div',
        { class: 'card parental-warning', role: 'note' },
        h('h2', null, t('parental_incog_title', 'Incognito windows are not filtered')),
        h('p', null, t('parental_incog_body', 'Chrome does not run extensions in Incognito unless you allow it, so a child could open an Incognito window to get around the filter.')),
        h(
          'ol',
          { class: 'parental-list' },
          h('li', null, t('parental_incog_1', 'Open chrome://extensions in the address bar.')),
          h('li', null, t('parental_incog_2', 'Find FocusGuard and click Details.')),
          h('li', null, t('parental_incog_3', 'Turn on “Allow in Incognito”.')),
        ),
        h('p', { class: 'hint' }, t('parental_incog_policy', 'Or turn Incognito off entirely with the Chrome policy IncognitoModeAvailability=1.')),
      ),
    );
  }
  const layers = [p.blockKnownSites, p.detectPages, p.scanImages, p.socialFilter, p.safeSearch].filter(Boolean).length;
  root.append(
    h(
      'div',
      { class: 'card parental-status', role: 'status' },
      h('div', { class: 'row' }, h('span', { class: 'pill on' }, t('parental_status_on', 'On')), h('strong', null, t('parental_status_title', 'Parental controls are protecting this browser'))),
      h(
        'p',
        { class: 'muted' },
        tf(
          'parental_status_line',
          '$1 of 5 filters on · sensitivity $2 · $3 learned sites · $4 extra words · $5 allowed sites',
          String(layers),
          SENSITIVITY.find((s) => s.value === p.sensitivity)?.label.toLowerCase() ?? p.sensitivity,
          String(snap.runtime.parentalDetected?.length ?? 0),
          String(p.blockedWords.length),
          String(p.allowedSites.length),
        ),
      ),
      h('p', { class: 'hint' }, t('parental_status_pin', 'Every change on this page asks for the guardian PIN.')),
    ),
    settingsCard(snap, ctx),
    learnedCard(snap, ctx),
    pinAndOffCard(ctx),
    limitsCard(),
    privacyCard(),
  );
}

const section: Section = {
  id: 'parental',
  title: t('parental_section_title', 'Parental controls'),
  render(root, snap, ctx) {
    ensureCss();
    if (snap.config.parental?.enabled) renderOn(root, snap, ctx);
    else renderOff(root, snap, ctx);
  },
};
export default section;
