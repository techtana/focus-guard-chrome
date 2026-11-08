import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyChange } from '../src/shared/changes.ts';
import { DEFAULT_PARENTAL } from '../src/shared/defaults.ts';
import { compileParentalDnr, learnSite, parentalBlockFor, PARENTAL_BAND } from '../src/shared/parental.ts';
import type { ParentalConfig } from '../src/shared/types.ts';
import { rule, state } from './helpers.ts';

const on = (patch: Partial<ParentalConfig> = {}): ParentalConfig => ({ ...DEFAULT_PARENTAL, enabled: true, pinHash: 'x', ...patch });
const known = ['adult.test', 'xxx.test'];
const knownSet = new Set(known);

test('off: no rules, no blocks', () => {
  assert.deepEqual(compileParentalDnr(DEFAULT_PARENTAL, [], known, 1), []);
  assert.equal(parentalBlockFor('https://adult.test/', DEFAULT_PARENTAL, [], knownSet), null);
});

test('known sites block with subdomains; allowed sites are excluded', () => {
  assert.deepEqual(parentalBlockFor('https://www.adult.test/x', on(), [], knownSet), { t: 0 });
  assert.deepEqual(parentalBlockFor('https://cdn.xxx.test/', on(), [], knownSet), { t: 0 });
  assert.equal(parentalBlockFor('https://notadult.test/', on(), [], knownSet), null);
  assert.equal(parentalBlockFor('https://adult.test/', on({ allowedSites: ['adult.test'] }), [], knownSet), null);
  assert.equal(parentalBlockFor('https://adult.test/', on({ blockKnownSites: false }), [], knownSet), null);
  const [r] = compileParentalDnr(on({ allowedSites: ['xxx.test'] }), [], known, 7);
  assert.equal(r.id, 7);
  assert.deepEqual(r.condition.requestDomains, ['adult.test']);
  assert.deepEqual(r.condition.excludedRequestDomains, ['xxx.test']);
  assert.ok(r.priority > PARENTAL_BAND && r.priority > 100_000 + 10_000, 'above Hard Lock band');
});

test('learned sites block with the host in the block page URL', () => {
  const detected = learnSite([], { host: 'www.found.test', at: 1, score: 9, source: 'text' });
  assert.equal(detected[0].host, 'found.test');
  assert.deepEqual(parentalBlockFor('https://m.found.test/p', on(), detected, knownSet), { t: 1, host: 'found.test' });
  const rules = compileParentalDnr(on({ blockKnownSites: false, safeSearch: false }), detected, known, 1);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].action, { type: 'redirect', redirect: { extensionPath: '/blocked.html?r=parental&t=1&h=found.test' } });
  assert.equal(learnSite(detected, { host: 'found.test', at: 2, score: 1, source: 'images' }).length, 1, 'deduped');
});

test('SafeSearch rewrites search URLs and sets the YouTube header', () => {
  const rules = compileParentalDnr(on({ blockKnownSites: false }), [], known, 1);
  const google = rules.find((r) => r.condition.regexFilter?.includes('google'))!;
  assert.ok(new RegExp(google.condition.regexFilter!).test('https://www.google.co.uk/search?q=x'));
  assert.ok(!new RegExp(google.condition.regexFilter!).test('https://www.google.com/maps'));
  assert.deepEqual(google.action, { type: 'redirect', redirect: { transform: { queryTransform: { addOrReplaceParams: [{ key: 'safe', value: 'active' }] } } } });
  const yt = rules.find((r) => r.action.type === 'modifyHeaders')!;
  assert.ok(yt.condition.requestDomains!.includes('youtube.com'));
  assert.equal(compileParentalDnr(on({ blockKnownSites: false, safeSearch: false }), [], known, 1).length, 0);
});

test('every parental change needs the guardian PIN once on; none before', () => {
  const st = state([rule(['a.test'])]);
  const off = classifyChange({ kind: 'parental.enable', pin: '1234' }, st.config, st.runtime, st.now);
  assert.equal(off.guardian, false);
  const cfg = { ...st.config, parental: on() };
  for (const change of [
    { kind: 'parental.disable' as const },
    { kind: 'parental.update' as const, patch: { sensitivity: 'high' as const } },
    { kind: 'parental.allowSite' as const, host: 'x.test' },
    { kind: 'parental.forget' as const, host: null },
  ]) {
    assert.equal(classifyChange(change, cfg, st.runtime, st.now).guardian, true, change.kind);
  }
  // The user's own rule changes are unaffected by parental mode.
  assert.equal(classifyChange({ kind: 'rule.delete', id: st.config.rules[0].id }, cfg, st.runtime, st.now).guardian, false);
});
