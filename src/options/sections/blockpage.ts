// Block page settings (FR-7.1, FR-7.2): custom message and image, with a preview.
import { field, h, t, toast } from '../../ui/dom.ts';
import { applyChange } from '../../ui/gate.ts';
import { ensureCommitCss } from '../commit-common.ts';
import type { Section } from '../section.ts';
import { fitImage } from '../shrink-image.ts';

const MAX_MESSAGE = 280;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const section: Section = {
  id: 'blockpage',
  title: t('blockpage_title', 'Block page'),
  render(root, snap, ctx) {
    ensureCommitCss();
    const cfg = snap.config.blockPage;
    /** undefined = unchanged, null = remove, string = new data: URL. */
    let pendingImage: string | null | undefined;
    let currentImage: string | null = null;

    const message = h('textarea', { class: 'input', rows: 3, maxlength: MAX_MESSAGE, id: 'bp-message', placeholder: 'You chose focus. Future you says thanks.' });
    message.value = cfg.message;
    const counter = h('div', { class: 'hint', 'aria-live': 'polite' });
    const file = h('input', { type: 'file', accept: 'image/*', class: 'input', id: 'bp-image' });
    const removeBtn = h('button', { class: 'btn', type: 'button' }, 'Remove image');

    // Preview
    const pvImg = h('img', { class: 'bp-preview-img', alt: '' });
    const pvMsg = h('p', { class: 'bp-preview-msg' });
    const preview = h(
      'div',
      { class: 'bp-preview', 'aria-label': 'Preview of the block page', role: 'img' },
      pvImg,
      h('div', { class: 'bp-preview-title' }, 'This site is blocked'),
      h('div', { class: 'bp-preview-reason' }, 'Rule “Social” · reddit.com · unblocks in 12:34'),
      pvMsg,
      h('div', { class: 'row' }, h('span', { class: 'btn small' }, 'Go back')),
    );

    const update = () => {
      counter.textContent = `${message.value.length} / ${MAX_MESSAGE} characters`;
      pvMsg.textContent = message.value.trim() || 'A rotating motivational message appears here when you leave this empty.';
      pvMsg.classList.toggle('muted', !message.value.trim());
      const img = pendingImage === undefined ? currentImage : pendingImage;
      if (img) {
        pvImg.src = img;
        pvImg.hidden = false;
      } else {
        pvImg.removeAttribute('src');
        pvImg.hidden = true;
      }
      removeBtn.hidden = !img;
    };

    message.addEventListener('input', () => {
      ctx.setDirty(true);
      update();
    });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      if (!f.type.startsWith('image/')) {
        toast('Choose an image file.', 'error');
        file.value = '';
        return;
      }
      if (f.size > MAX_IMAGE_BYTES) toast('Resizing the image to fit 2 MB…');
      try {
        const res = await fitImage(f, MAX_IMAGE_BYTES);
        pendingImage = res.dataUrl;
        if (res.shrunk) toast(`Image resized to ${(res.bytes / 1024 / 1024).toFixed(1)} MB to fit. Save to keep it.`);
      } catch (e) {
        toast(e instanceof Error ? e.message : 'The image could not be used.', 'error');
        file.value = '';
        return;
      }
      ctx.setDirty(true);
      update();
    });
    removeBtn.addEventListener('click', () => {
      pendingImage = null;
      file.value = '';
      ctx.setDirty(true);
      update();
    });

    const save = async () => {
      const res = await applyChange(
        { kind: 'blockPage.update', message: message.value.trim().slice(0, MAX_MESSAGE), image: pendingImage },
        { successMessage: 'Block page saved.' },
      );
      if (res.ok) {
        ctx.setDirty(false);
        await ctx.refresh();
      }
    };

    root.append(
      h(
        'p',
        { class: 'muted' },
        t('blockpage_intro', 'The block page shows why a site is blocked and when it opens again. Add your own message and image to make it yours.'),
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', null, t('blockpage_custom_title', 'Your message and image')),
        field('Message (leave empty for rotating default messages)', message),
        counter,
        field('Image (larger images are resized to fit 2 MB; stored only on this device)', file),
        h('div', { class: 'row' }, removeBtn),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Save')),
      ),
      h('div', { class: 'card' }, h('h2', null, t('blockpage_preview_title', 'Preview')), preview),
      h(
        'p',
        { class: 'hint' },
        t('blockpage_redirect_hint', 'Want to land somewhere useful instead? Create a Redirect rule on the Rules page.'),
      ),
    );
    update();

    if (cfg.hasImage) {
      chrome.storage.local.get('blockImage').then((r) => {
        const v = r.blockImage;
        currentImage = typeof v === 'string' ? v : null;
        update();
      });
    }
  },
};
export default section;
