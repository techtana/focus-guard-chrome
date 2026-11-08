import assert from 'node:assert/strict';
import { test } from 'node:test';
import { targetCondition } from '../src/shared/dnr.ts';
import type { PlainTarget } from '../src/shared/types.ts';
import { matchTarget, parseTargetInput, specificity } from '../src/shared/url.ts';

const u = (s: string) => new URL(s);

test('parseTargetInput: bare host -> domain with subdomains, www stripped', () => {
  assert.deepEqual(parseTargetInput('www.Reddit.com'), { kind: 'domain', host: 'reddit.com', includeSubdomains: true });
  assert.deepEqual(parseTargetInput('https://reddit.com/'), { kind: 'domain', host: 'reddit.com', includeSubdomains: true });
});

test('parseTargetInput: path -> prefix, exact mode, junk rejected', () => {
  assert.deepEqual(parseTargetInput('youtube.com/shorts'), { kind: 'prefix', url: 'youtube.com/shorts' });
  assert.deepEqual(parseTargetInput('https://www.youtube.com/watch?v=abc', 'exact'), { kind: 'exact', url: 'youtube.com/watch?v=abc' });
  assert.equal(parseTargetInput(''), null);
  assert.equal(parseTargetInput('not a url'), null);
  assert.equal(parseTargetInput('ftp://x.com'), null);
});

test('UC-1: domain target matches the domain and its subdomains only', () => {
  const t = parseTargetInput('reddit.com')!;
  assert.ok(matchTarget(t, u('https://reddit.com/r/all')));
  assert.ok(matchTarget(t, u('https://old.reddit.com/')));
  assert.ok(!matchTarget(t, u('https://notreddit.com/')));
  assert.ok(!matchTarget(t, u('https://reddit.com.evil.io/')));
});

test('domain without subdomains still matches www', () => {
  const t: PlainTarget = { kind: 'domain', host: 'reddit.com', includeSubdomains: false };
  assert.ok(matchTarget(t, u('https://www.reddit.com/')));
  assert.ok(!matchTarget(t, u('https://old.reddit.com/')));
});

test('prefix and exact targets', () => {
  const p = parseTargetInput('youtube.com/shorts')!;
  assert.ok(matchTarget(p, u('https://www.youtube.com/shorts/abc')));
  assert.ok(matchTarget(p, u('https://m.youtube.com/SHORTS/abc')));
  assert.ok(!matchTarget(p, u('https://youtube.com/watch?v=1')));
  const e = parseTargetInput('youtube.com/watch?v=abc', 'exact')!;
  assert.ok(matchTarget(e, u('https://www.youtube.com/watch?v=abc#t=1')));
  assert.ok(!matchTarget(e, u('https://youtube.com/watch?v=abcd')));
});

test('specificity: subdomain domain < exact host < prefix < exact url', () => {
  const s = (x: string, mode: 'auto' | 'exact' = 'auto') => specificity(parseTargetInput(x, mode)!);
  assert.ok(s('youtube.com') < specificity({ kind: 'domain', host: 'youtube.com', includeSubdomains: false }));
  assert.ok(specificity({ kind: 'domain', host: 'youtube.com', includeSubdomains: false }) < s('youtube.com/watch'));
  assert.ok(s('youtube.com/watch') < s('youtube.com/watch?v=1'));
  assert.ok(s('youtube.com/watch?v=1') < s('youtube.com/watch?v=1', 'exact'));
});

/** The DNR condition must accept exactly the URLs matchTarget() accepts. */
test('DNR conditions agree with matchTarget', () => {
  const targets: PlainTarget[] = [
    { kind: 'domain', host: 'reddit.com', includeSubdomains: true },
    { kind: 'domain', host: 'reddit.com', includeSubdomains: false },
    { kind: 'prefix', url: 'youtube.com/shorts' },
    { kind: 'prefix', url: 'example.com/a+b(c)?q=1' },
    { kind: 'exact', url: 'youtube.com/watch?v=abc' },
    { kind: 'exact', url: 'example.com/' },
  ];
  const urls = [
    'https://reddit.com/',
    'http://www.reddit.com/r/x',
    'https://old.reddit.com/',
    'https://notreddit.com/',
    'https://reddit.com:8443/x',
    'https://www.youtube.com/shorts/abc',
    'https://youtube.com/shortsxyz',
    'https://youtube.com/watch?v=abc',
    'https://youtube.com/watch/?v=abc',
    'https://youtube.com/watch?v=abcd',
    'https://example.com/a+b(c)?q=1&z',
    'https://example.com/',
    'https://example.com',
    'https://example.com/x',
  ];
  for (const t of targets) {
    const c = targetCondition(t);
    for (const url of urls) {
      const want = matchTarget(t, u(url));
      let got: boolean;
      if (c.requestDomains) {
        const host = u(url).hostname;
        got = c.requestDomains.some((d) => host === d || host.endsWith('.' + d));
      } else {
        // Chrome matches regexFilter against the URL as sent (no fragment), case-insensitively.
        got = new RegExp(c.regexFilter!, 'i').test(u(url).href);
      }
      assert.equal(got, want, `${JSON.stringify(t)} vs ${url}`);
    }
  }
});
