// The commitment gate in the UI (FR-4, UC-6). Every page changes state through
// applyChange() here. If the worker answers 'gate', this opens a modal for the
// password, the typing Challenge, or its accessible alternative (a timed delay),
// then resends the change with the proof. The worker re-checks everything.

import type { Change } from '../shared/changes.ts';
import { send, type ApplyResult, type ChallengeInfo, type GateProof } from '../shared/messages.ts';
import { formatCountdown, h, toast } from './dom.ts';

export interface ApplyOptions {
  /** Toast on success (default none). */
  successMessage?: string;
  /** Show a toast for refusals (default true). */
  reportErrors?: boolean;
}

/** Apply a change through the worker, running the gate when needed. Resolves with the final result. */
export async function applyChange(change: Change, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const report = opts.reportErrors ?? true;
  let res = await send({ type: 'applyChange', change });
  while (!res.ok && res.error === 'gate') {
    const proof = await runGate(res.level, res.message);
    if (!proof) return res; // cancelled
    res = await send({ type: 'applyChange', change, proof });
    if (!res.ok && res.error === 'wrongProof') {
      toast(res.message, 'error');
      res = { ok: false, error: 'gate', level: proofLevel(proof), message: res.message };
    }
  }
  if (res.ok && opts.successMessage) toast(opts.successMessage, 'success');
  if (!res.ok && report) toast(res.message, 'error', 6000);
  return res;
}

function proofLevel(p: GateProof): 'password' | 'challenge' | 'guardian' {
  return p.kind === 'password' ? 'password' : p.kind === 'guardian' ? 'guardian' : 'challenge';
}

/** Open a modal <dialog>; resolves with whatever `done` is called with (null on Esc/cancel). */
export function modal<T>(title: string, build: (done: (v: T | null) => void) => HTMLElement[]): Promise<T | null> {
  return new Promise((resolve) => {
    const titleId = `dlg-${Math.random().toString(36).slice(2)}`;
    const dlg = h('dialog', { class: 'modal', 'aria-labelledby': titleId });
    let settled = false;
    const done = (v: T | null) => {
      if (settled) return;
      settled = true;
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(null);
    });
    dlg.append(h('h2', { id: titleId }, title), ...build(done));
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}

/** Simple confirm dialog. */
export function confirmDialog(title: string, body: string, confirmLabel = 'Confirm', danger = false): Promise<boolean> {
  return modal<boolean>(title, (done) => [
    h('p', null, body),
    h(
      'div',
      { class: 'row end' },
      h('button', { class: 'btn', type: 'button', onclick: () => done(false) }, 'Cancel'),
      h('button', { class: danger ? 'btn danger' : 'btn primary', type: 'button', onclick: () => done(true) }, confirmLabel),
    ),
  ]).then((v) => !!v);
}

async function runGate(level: 'password' | 'challenge' | 'guardian', message: string): Promise<GateProof | null> {
  if (level === 'guardian') return pinGate(message);
  return level === 'password' ? passwordGate(message) : challengeGate(message);
}

/** Guardian PIN for parental-control changes. */
function pinGate(message: string): Promise<GateProof | null> {
  return modal<GateProof>('Parent or guardian PIN', (done) => {
    const input = h('input', { type: 'password', autocomplete: 'off', inputmode: 'numeric', class: 'input', id: 'gate-pin' });
    const submit = () => input.value && done({ kind: 'guardian', pin: input.value });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    queueMicrotask(() => input.focus());
    return [
      h('p', null, message),
      h('div', { class: 'field' }, h('label', { for: 'gate-pin' }, 'Guardian PIN'), input),
      h(
        'div',
        { class: 'row end' },
        h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onclick: submit }, 'Unlock'),
      ),
    ];
  });
}

function passwordGate(message: string): Promise<GateProof | null> {
  return modal<GateProof>('Enter your FocusGuard password', (done) => {
    const input = h('input', { type: 'password', autocomplete: 'current-password', class: 'input', id: 'gate-pw' });
    const submit = () => input.value && done({ kind: 'password', password: input.value });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    queueMicrotask(() => input.focus());
    return [
      h('p', null, message),
      h('div', { class: 'field' }, h('label', { for: 'gate-pw' }, 'Password'), input),
      h(
        'div',
        { class: 'row end' },
        h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onclick: submit }, 'Unlock change'),
      ),
    ];
  });
}

async function challengeGate(message: string): Promise<GateProof | null> {
  const typed = await send({ type: 'requestChallenge', mode: 'type' });
  return modal<GateProof>('Complete the challenge', (done) => {
    const body = h('div', null);
    const showTyping = (c: ChallengeInfo) => {
      body.replaceChildren();
      const area = h('textarea', {
        class: 'input challenge-input',
        rows: 6,
        id: 'gate-typed',
        spellcheck: 'false',
        autocomplete: 'off',
        'aria-describedby': 'gate-passage',
      });
      const block = (e: Event) => {
        e.preventDefault();
        toast('Pasting is turned off for the challenge.', 'error');
      };
      area.addEventListener('paste', block);
      area.addEventListener('drop', block);
      const counter = h('div', { class: 'hint', 'aria-live': 'polite' }, `0 / ${c.text?.length ?? 0} characters`);
      area.addEventListener('input', () => {
        counter.textContent = `${area.value.length} / ${c.text?.length ?? 0} characters`;
      });
      const passage = h('p', { class: 'challenge-passage', id: 'gate-passage', oncopy: (e: Event) => e.preventDefault() }, c.text ?? '');
      body.append(
        h('p', null, message),
        h('p', { class: 'hint' }, 'Type the passage below exactly, including capitals and full stops.'),
        passage,
        h('div', { class: 'field' }, h('label', { for: 'gate-typed' }, 'Your typing'), area, counter),
        h(
          'div',
          { class: 'row between' },
          h('button', { class: 'btn link', type: 'button', onclick: () => void switchToDelay() }, 'I can’t type this — wait instead'),
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'Cancel'),
            h(
              'button',
              { class: 'btn primary', type: 'button', onclick: () => done({ kind: 'challenge', challengeId: c.id, typed: area.value }) },
              'Submit',
            ),
          ),
        ),
      );
      queueMicrotask(() => area.focus());
    };
    const switchToDelay = async () => {
      const c = await send({ type: 'requestChallenge', mode: 'delay' });
      body.replaceChildren();
      const status = h('p', { class: 'countdown', 'aria-live': 'polite' });
      const confirm = h(
        'button',
        { class: 'btn primary', type: 'button', disabled: true, onclick: () => done({ kind: 'delay', challengeId: c.id }) },
        'Confirm change',
      );
      const tick = () => {
        const left = (c.readyAt ?? 0) - Date.now();
        if (left <= 0) {
          status.textContent = 'The wait is over. You can confirm the change now.';
          confirm.disabled = false;
          clearInterval(iv);
        } else {
          status.textContent = `Wait ${formatCountdown(left)} before you can confirm. You can close this and come back; the timer keeps running.`;
        }
      };
      const iv = setInterval(tick, 1000);
      tick();
      body.append(
        h('p', null, message),
        h('p', { class: 'hint' }, 'Instead of typing, wait out a cooling-off delay. Reopen the same change later to confirm it.'),
        status,
        h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'Cancel'), confirm),
      );
    };
    showTyping(typed);
    return [body];
  });
}
