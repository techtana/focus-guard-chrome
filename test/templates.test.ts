import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplate, normalizeRedirect, parseSites, TEMPLATES } from '../src/onboarding/templates.ts';

let n = 0;
const id = () => `id${++n}`;
const NOW = 1_700_000_000_000;

test('three templates with default sites', () => {
  assert.deepEqual(TEMPLATES.map((t) => t.id), ['deepWork', 'pomodoro', 'socialDiet']);
  for (const t of TEMPLATES) assert.ok(t.defaultSites.length >= 5);
});

test('parseSites dedupes, accepts commas and URLs, reports junk', () => {
  const r = parseSites('reddit.com\nhttps://www.reddit.com/\n x.com, youtube.com/shorts\nnot a site\n');
  assert.deepEqual(r.targets, [
    { kind: 'domain', host: 'reddit.com', includeSubdomains: true },
    { kind: 'domain', host: 'x.com', includeSubdomains: true },
    { kind: 'prefix', url: 'youtube.com/shorts' },
  ]);
  assert.deepEqual(r.invalid, ['not a site']);
});

test('deep work: weekday block + YouTube hide preset', () => {
  const r = buildTemplate('deepWork', { sitesText: TEMPLATES[0].defaultSites.join('\n') }, NOW, id);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rules.length, 2);
  const [block, hide] = r.rules;
  assert.equal(block.action.kind, 'block');
  assert.deepEqual(block.schedule, { days: [1, 2, 3, 4, 5], windows: [{ start: '09:00', end: '12:00' }] });
  assert.equal(block.targets.length, TEMPLATES[0].defaultSites.length);
  assert.deepEqual(hide.action, { kind: 'hide', selectors: [], presetId: 'youtube', presetOptions: ['shorts', 'comments', 'sidebar', 'homefeed'] });
  assert.equal(hide.schedule, undefined);
  assert.ok(r.rules.every((x) => x.enabled && x.createdAt === NOW && x.id));
});

test('deep work rejects bad times', () => {
  const r = buildTemplate('deepWork', { sitesText: 'x.com', start: '9am', end: '12:00' }, NOW, id);
  assert.equal(r.rules.length, 0);
  assert.ok(r.errors.length);
});

test('pomodoro: focus-only block, or redirect when a URL is given', () => {
  const a = buildTemplate('pomodoro', { sitesText: 'instagram.com', workMin: 50 }, NOW, id);
  assert.deepEqual(a.errors, []);
  assert.equal(a.rules[0].onlyDuringFocus, true);
  assert.equal(a.rules[0].action.kind, 'block');
  assert.deepEqual(a.focusConfig, { workMin: 50 });
  const b = buildTemplate('pomodoro', { sitesText: 'instagram.com', redirectUrl: 'portal.example.edu/course' }, NOW, id);
  assert.deepEqual(b.rules[0].action, { kind: 'redirect', url: 'https://portal.example.edu/course' });
  const c = buildTemplate('pomodoro', { sitesText: 'instagram.com', redirectUrl: 'javascript:alert(1)' }, NOW, id);
  assert.equal(c.rules.length, 0);
  assert.ok(c.errors.length);
});

test('social diet: one budget rule per site', () => {
  const r = buildTemplate('socialDiet', { sitesText: 'reddit.com\nx.com', minutesPerDay: 20 }, NOW, id);
  assert.equal(r.rules.length, 2);
  assert.deepEqual(r.rules[0].action, { kind: 'budget', minutesPerDay: 20 });
  assert.equal(r.rules[0].targets.length, 1);
  assert.match(r.rules[0].name ?? '', /reddit\.com — 20 min\/day/);
});

test('empty site list is an error and makes no rules', () => {
  const r = buildTemplate('socialDiet', { sitesText: '  ' }, NOW, id);
  assert.equal(r.rules.length, 0);
  assert.ok(r.errors.includes('Add at least one site.'));
});

test('normalizeRedirect adds https only when needed', () => {
  assert.equal(normalizeRedirect(''), '');
  assert.equal(normalizeRedirect('example.com'), 'https://example.com');
  assert.equal(normalizeRedirect('http://example.com'), 'http://example.com');
});
