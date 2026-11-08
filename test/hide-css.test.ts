import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCss, selectorsFor } from '../src/content/hide-css.ts';
import type { HideIndex } from '../src/shared/types.ts';

const index: HideIndex = {
  rev: 1,
  hide: [
    {
      targets: [{ kind: 'domain', host: 'youtube.com', includeSubdomains: true }],
      priorities: [122],
      selectors: ['#comments', 'ytd-reel-shelf-renderer'],
    },
    {
      targets: [{ kind: 'prefix', url: 'reddit.com/r/funny' }],
      priorities: [1132],
      selectors: ['shreddit-feed', '#comments'],
    },
  ],
  allow: [
    // allow youtube.com/feed/subscriptions (more specific than the hide)
    { targets: [{ kind: 'prefix', url: 'youtube.com/feed/subscriptions' }], priorities: [1300] },
  ],
};

test('selectors for a matching domain', () => {
  assert.deepEqual(selectorsFor(index, 'https://www.youtube.com/watch?v=1'), ['#comments', 'ytd-reel-shelf-renderer']);
  assert.deepEqual(selectorsFor(index, 'https://m.youtube.com/'), ['#comments', 'ytd-reel-shelf-renderer']);
});

test('no selectors on other sites or schemes', () => {
  assert.deepEqual(selectorsFor(index, 'https://example.com/'), []);
  assert.deepEqual(selectorsFor(index, 'chrome://extensions'), []);
  assert.deepEqual(selectorsFor(null, 'https://youtube.com/'), []);
});

test('prefix targets apply only under the prefix and de-duplicate', () => {
  assert.deepEqual(selectorsFor(index, 'https://old.reddit.com/r/funny/top'), ['shreddit-feed', '#comments']);
  assert.deepEqual(selectorsFor(index, 'https://reddit.com/r/news'), []);
});

test('a more specific allow overrides hiding', () => {
  assert.deepEqual(selectorsFor(index, 'https://www.youtube.com/feed/subscriptions'), []);
});

test('an allow with lower priority does not override', () => {
  const idx: HideIndex = {
    rev: 2,
    hide: [{ targets: [{ kind: 'prefix', url: 'youtube.com/watch' }], priorities: [1092], selectors: ['#related'] }],
    allow: [{ targets: [{ kind: 'domain', host: 'youtube.com', includeSubdomains: true }], priorities: [120] }],
  };
  assert.deepEqual(selectorsFor(idx, 'https://youtube.com/watch?v=x'), ['#related']);
});

test('buildCss emits one rule per selector and drops braces', () => {
  assert.equal(buildCss(['a', 'b > c']), 'a{display:none!important}\nb > c{display:none!important}');
  assert.equal(buildCss(['x} body{display:none', 'ok']), 'ok{display:none!important}');
  assert.equal(buildCss([]), '');
});
