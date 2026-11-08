import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makePassage, passageMatches } from '../src/shared/challenge.ts';
import { classifyChange, isRuleLoosening } from '../src/shared/changes.ts';
import { hashPassword, verifyPassword } from '../src/shared/crypto.ts';
import type { Rule } from '../src/shared/types.ts';
import { MONDAY_10, rule, state } from './helpers.ts';

const base = rule(['reddit.com', 'x.com'], { kind: 'budget', minutesPerDay: 20 }, {
  schedule: { days: [1, 2, 3, 4, 5], windows: [{ start: '09:00', end: '17:00' }] },
});
const edit = (patch: Partial<Rule>) => ({ ...base, ...patch });

test('UC-6 / FR-4.3: loosening edits are detected', () => {
  assert.ok(isRuleLoosening(base, edit({ enabled: false })), 'disable');
  assert.ok(isRuleLoosening(base, edit({ targets: base.targets.slice(0, 1) })), 'remove a site');
  assert.ok(isRuleLoosening(base, edit({ action: { kind: 'budget', minutesPerDay: 30 } })), 'raise budget');
  assert.ok(isRuleLoosening(base, edit({ schedule: { days: [1], windows: [{ start: '09:00', end: '17:00' }] } })), 'narrow schedule');
  assert.ok(isRuleLoosening(base, edit({ action: { kind: 'hide', selectors: ['#x'] } })), 'budget -> hide');
  assert.ok(isRuleLoosening(base, edit({ onlyDuringFocus: true })), 'focus-only');
  assert.ok(isRuleLoosening(undefined, rule(['a.com'], { kind: 'block' }, { allow: true })), 'new allow rule');
});

test('UC-6: tightening edits never need the gate', () => {
  assert.ok(!isRuleLoosening(undefined, rule(['a.com'])), 'new block rule');
  assert.ok(!isRuleLoosening(base, edit({ action: { kind: 'budget', minutesPerDay: 10 } })), 'lower budget');
  assert.ok(!isRuleLoosening(base, edit({ action: { kind: 'block' } })), 'budget -> block');
  assert.ok(!isRuleLoosening(base, edit({ schedule: undefined })), 'widen schedule of a block');
  assert.ok(!isRuleLoosening(base, edit({ targets: [...base.targets, { kind: 'domain', host: 'b.com', includeSubdomains: true }] })), 'add site');
  assert.ok(!isRuleLoosening({ ...base, enabled: false }, edit({ action: { kind: 'budget', minutesPerDay: 999 } })), 'disabled rule');
});

test('FR-3.2 / FR-3.4: locked rules can be tightened, not loosened', () => {
  const st = state([base], MONDAY_10, {
    runtime: { locks: [{ id: 'L', ruleIds: [base.id], targets: [], startedAt: MONDAY_10 - 1, endsAt: MONDAY_10 + 3600_000 }] },
  });
  const c = (change: Parameters<typeof classifyChange>[0]) => classifyChange(change, st.config, st.runtime, st.now);
  assert.ok(c({ kind: 'rule.delete', id: base.id }).lockConflict);
  assert.ok(c({ kind: 'rule.setEnabled', id: base.id, enabled: false }).lockConflict);
  assert.ok(c({ kind: 'rule.upsert', rule: edit({ action: { kind: 'budget', minutesPerDay: 60 } }) }).lockConflict);
  assert.equal(c({ kind: 'rule.upsert', rule: edit({ action: { kind: 'block' } }) }).lockConflict, null);
  assert.equal(c({ kind: 'lock.extend', lockId: 'L', minutes: 30 }).loosening, false);
  // Open question 4: the commitment level is frozen during a lock.
  assert.ok(classifyChange({ kind: 'commitment.set', level: 'none' }, { ...st.config, settings: { ...st.config.settings, commitment: 'challenge' } }, st.runtime, st.now).lockConflict);
  assert.ok(c({ kind: 'settings.update', patch: { resetTime: '03:00' } }).lockConflict);
  // FR-6.4: no early end of a focus session under a lock.
  const withFocus = { ...st.runtime, focus: { workMin: 25, breakMin: 5, longBreakMin: 15, cycles: 4, ruleIds: [], startedAt: MONDAY_10 } };
  assert.ok(classifyChange({ kind: 'focus.stop' }, st.config, withFocus, st.now).lockConflict);
});

test('FR-6.4: Challenge level forbids ending focus early; Password gates it', () => {
  const st = state([]);
  const rt = { ...st.runtime, focus: { workMin: 25, breakMin: 5, longBreakMin: 15, cycles: 4, ruleIds: [], startedAt: MONDAY_10 } };
  const challenge = { ...st.config, settings: { ...st.config.settings, commitment: 'challenge' as const } };
  assert.ok(classifyChange({ kind: 'focus.stop' }, challenge, rt, st.now).forbidden);
  const pw = { ...st.config, settings: { ...st.config.settings, commitment: 'password' as const } };
  const r = classifyChange({ kind: 'focus.stop' }, pw, rt, st.now);
  assert.ok(r.loosening && !r.forbidden);
});

test('commitment and settings changes', () => {
  const st = state([]);
  const cfg = { ...st.config, settings: { ...st.config.settings, commitment: 'challenge' as const } };
  assert.ok(classifyChange({ kind: 'commitment.set', level: 'password', newPassword: 'x'.repeat(8) }, cfg, st.runtime, st.now).loosening);
  assert.ok(!classifyChange({ kind: 'commitment.set', level: 'challenge' }, st.config, st.runtime, st.now).loosening);
  assert.ok(classifyChange({ kind: 'settings.update', patch: { idleSeconds: 30 } }, st.config, st.runtime, st.now).loosening);
  assert.ok(!classifyChange({ kind: 'settings.update', patch: { idleSeconds: 120 } }, st.config, st.runtime, st.now).loosening);
  assert.ok(classifyChange({ kind: 'pause', minutes: 15 }, st.config, st.runtime, st.now).loosening);
  assert.ok(!classifyChange({ kind: 'pause', minutes: null }, st.config, st.runtime, st.now).loosening);
});

test('group edits that shrink a used group are loosening', () => {
  const st = state([rule([{ kind: 'group', groupId: 'g' }])], MONDAY_10, {
    config: { groups: [{ id: 'g', name: 'Social', targets: [{ kind: 'domain', host: 'a.com', includeSubdomains: true }, { kind: 'domain', host: 'b.com', includeSubdomains: true }] }] },
  });
  const shrink = { kind: 'group.upsert' as const, group: { ...st.config.groups[0], targets: st.config.groups[0].targets.slice(0, 1) } };
  assert.ok(classifyChange(shrink, st.config, st.runtime, st.now).loosening);
  assert.ok(classifyChange({ kind: 'group.delete', id: 'g' }, st.config, st.runtime, st.now).loosening);
});

test('FR-4.2: challenge passage', () => {
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const p = makePassage(300, rand);
  assert.ok(p.length >= 300 && p.length < 330, `length ${p.length}`);
  assert.ok(passageMatches(p, `  ${p}\n`));
  assert.ok(!passageMatches(p, p.toLowerCase()));
});

test('PBKDF2 password hashing', async () => {
  const h = await hashPassword('correct horse', 1000);
  assert.ok(await verifyPassword('correct horse', h));
  assert.ok(!(await verifyPassword('wrong horse', h)));
  assert.ok(!(await verifyPassword('x', undefined)));
});
