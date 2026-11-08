import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_CATEGORIES, CATEGORIES, CATEGORY_LABELS, categoryOf } from '../src/shared/categories.ts';

test('built-in map covers the main categories with ~150 domains', () => {
  const n = Object.keys(BUILTIN_CATEGORIES).length;
  assert.ok(n >= 140, `only ${n} domains`);
  for (const c of CATEGORIES) assert.ok(CATEGORY_LABELS[c]);
});

test('exact and parent-domain matches', () => {
  assert.equal(categoryOf('youtube.com'), 'video');
  assert.equal(categoryOf('m.youtube.com'), 'video');
  assert.equal(categoryOf('www.reddit.com'), 'social');
  assert.equal(categoryOf('old.reddit.com'), 'social');
  assert.equal(categoryOf('claude.ai'), 'ai');
  assert.equal(categoryOf('chat.openai.com'), 'ai');
  assert.equal(categoryOf('gemini.google.com'), 'ai');
  assert.equal(categoryOf('mail.google.com'), 'work');
  assert.equal(categoryOf('example.org'), 'other');
  assert.equal(categoryOf('localhost'), 'other');
});

test('the most specific entry wins (music.youtube.com is in the list itself)', () => {
  assert.equal(categoryOf('news.ycombinator.com'), 'news');
  assert.equal(categoryOf('aws.amazon.com'), 'work');
  assert.equal(categoryOf('amazon.com'), 'shopping');
});

test('overrides win over the built-in map, including for subdomains', () => {
  const o = { 'youtube.com': 'work' as const, 'example.org': 'news' as const };
  assert.equal(categoryOf('youtube.com', o), 'work');
  assert.equal(categoryOf('m.youtube.com', o), 'work');
  assert.equal(categoryOf('blog.example.org', o), 'news');
  // A more specific built-in entry still beats a parent override.
  assert.equal(categoryOf('music.youtube.com', o), 'video');
});

test('does not fall back to the bare TLD', () => {
  assert.equal(categoryOf('foo.com', { com: 'news' }), 'other');
});
