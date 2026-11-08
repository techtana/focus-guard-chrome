// End-to-end tests: load dist/ into a real Chrome with a throwaway profile and
// drive the service worker, declarativeNetRequest, content script and pages.
//   npm run e2e                 (builds first)
//   CHROME_PATH=... npm run e2e (another Chrome/Chromium; default: installed Chrome)
// Branded Chrome ignores --load-extension, so the extension is installed over
// the DevTools pipe (Extensions.loadUnpacked) via puppeteer's installExtension().
// Test sites are served locally; *.test host names resolve to 127.0.0.1.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const shots = join(root, 'test-results');
mkdirSync(shots, { recursive: true });

const CHROME =
  process.env.CHROME_PATH ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p));

let server;
let port;
let browser;
let worker;
let extId;
let profile;

const site = (host, path = '/') => `http://${host}:${port}${path}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findWorker(exclude) {
  const target = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extId}/`) && t !== exclude,
    { timeout: 15_000 },
  );
  const w = await target.worker();
  // Wait until the module has run its top level.
  for (let i = 0; i < 50 && !(await w.evaluate(() => !!globalThis.focusGuard).catch(() => false)); i++) await sleep(100);
  return { target, w };
}

let workerTarget;
async function launch() {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    pipe: true,
    enableExtensions: true,
    userDataDir: profile,
    args: ['--host-resolver-rules=MAP *.test 127.0.0.1', '--no-first-run', '--no-default-browser-check'],
  });
  extId = await browser.installExtension(dist);
  ({ target: workerTarget, w: worker } = await findWorker());
}

/** Run applyChange in the worker (the same function the message handler calls). */
const apply = (change, proof) => worker.evaluate((c, p) => globalThis.focusGuard.applyChange(c, p), change, proof);
const state = () => worker.evaluate(async () => JSON.parse(JSON.stringify(await globalThis.focusGuard.getState())));
const newRule = (id, targets, action = { kind: 'block' }, extra = {}) => ({ id, name: id, targets, action, enabled: true, createdAt: Date.now(), ...extra });
const domain = (host) => ({ kind: 'domain', host, includeSubdomains: true });

async function open(url) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  return page;
}

async function waitUrl(page, re, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (re.test(page.url())) return;
    await sleep(50);
  }
  assert.fail(`timed out waiting for ${re}; at ${page.url()}`);
}

async function waitText(page, re, timeout = 6000) {
  const end = Date.now() + timeout;
  let text = '';
  while (Date.now() < end) {
    text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    if (re.test(text)) return text;
    await sleep(100);
  }
  assert.fail(`timed out waiting for text ${re}; page text: ${text.slice(0, 300)}`);
}

const h1 = (page) => page.$eval('h1', (e) => e.textContent);

before(async () => {
  assert.ok(CHROME, 'Set CHROME_PATH to a Chrome or Chromium executable');
  server = createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${host}</title><h1>Home of ${host}${req.url}</h1>
      <div id="shorts" class="shorts">SHORTS</div><div id="keep">KEEP</div>
      <button id="spa" data-to="/shorts/abc">spa</button>
      <script>document.getElementById('spa').addEventListener('click', (e) => history.pushState({}, '', e.target.dataset.to));</script>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  profile = mkdtempSync(join(tmpdir(), 'fg-e2e-'));
  await launch();
});

after(async () => {
  await browser?.close();
  server?.close();
  rmSync(profile, { recursive: true, force: true });
});

test('FR-9: install opens onboarding; state initialised', async () => {
  const end = Date.now() + 6000;
  let page;
  while (!page && Date.now() < end) {
    page = (await browser.pages()).find((p) => p.url().includes('onboarding.html'));
    if (!page) await sleep(100);
  }
  assert.ok(page, 'onboarding tab opened');
  await waitText(page, /Deep work/);
  await page.setViewport({ width: 1100, height: 900 });
  await page.screenshot({ path: join(shots, 'onboarding.png'), fullPage: true });
  assert.equal((await state()).config.settings.commitment, 'none');
});

test('UC-1: blocked domain and subdomain show the block page; URL carries only rule id + index', async () => {
  assert.deepEqual(await apply({ kind: 'rules.add', rules: [newRule('blk', [domain('reddit.test')])] }), { ok: true });
  for (const host of ['reddit.test', 'old.reddit.test']) {
    const page = await open(site(host, '/r/all?q=secret'));
    await waitUrl(page, /blocked\.html/);
    assert.equal(page.url(), `chrome-extension://${extId}/blocked.html?r=blk&t=0`);
    const text = await waitText(page, /is blocked/);
    assert.match(text, /reddit\.test/);
    assert.doesNotMatch(text, /secret/);
    if (host === 'reddit.test') {
      await page.setViewport({ width: 1100, height: 750 });
      await page.screenshot({ path: join(shots, 'blocked.png') });
    }
    await page.close();
  }
  const ok = await open(site('example.test'));
  assert.match(await h1(ok), /Home of example\.test/);
  await ok.close();
  await sleep(300);
  const stats = await worker.evaluate(async () => (await chrome.storage.local.get('stats')).stats);
  const today = Object.values(stats ?? {}).at(-1);
  assert.equal(today?.domains?.['reddit.test']?.blocked, 2, 'one blocked attempt per load, per domain');
});

test('FR-1.5: an allow rule opens a more specific path', async () => {
  await apply({ kind: 'rule.upsert', rule: newRule('alw', [{ kind: 'prefix', url: 'reddit.test/r/work' }], { kind: 'block' }, { allow: true }) });
  const page = await open(site('reddit.test', '/r/work/thread'));
  assert.match(await h1(page), /Home of reddit\.test/);
  await page.close();
  await apply({ kind: 'rule.delete', id: 'alw' });
});

test('SPA navigation to a blocked path is caught', async () => {
  await apply({ kind: 'rule.upsert', rule: newRule('shorts', [{ kind: 'prefix', url: 'video.test/shorts' }]) });
  const page = await open(site('video.test', '/'));
  await page.click('#spa');
  await waitUrl(page, /blocked\.html\?r=shorts/);
  await page.close();
});

test('UC-7 / FR-7.3: redirect, and a redirect loop falls back to the block page', async () => {
  await apply({ kind: 'rule.upsert', rule: newRule('redir', [domain('insta.test')], { kind: 'redirect', url: site('portal.test', '/course') }) });
  const page = await open(site('insta.test'));
  await waitUrl(page, /portal\.test/);
  assert.match(await h1(page), /portal\.test\/course/);
  await apply({ kind: 'rule.upsert', rule: newRule('redir', [domain('insta.test')], { kind: 'redirect', url: site('reddit.test') }) });
  await page.goto(site('insta.test')).catch(() => undefined);
  await waitUrl(page, /blocked\.html\?r=redir/);
  await page.close();
  await apply({ kind: 'rule.delete', id: 'redir' });
});

test('UC-3: element hiding applies live and on new pages; one bad selector does not break others', async () => {
  const page = await open(site('tube.test'));
  const shown = (p, sel) => p.$eval(sel, (e) => getComputedStyle(e).display !== 'none');
  assert.equal(await shown(page, '#shorts'), true);
  await apply({ kind: 'rule.upsert', rule: newRule('hide', [domain('tube.test')], { kind: 'hide', selectors: ['#shorts', 'bad[[selector'] }) });
  await page.waitForFunction(() => getComputedStyle(document.getElementById('shorts')).display === 'none', { timeout: 5000 });
  assert.equal(await shown(page, '#keep'), true);
  const fresh = await open(site('tube.test', '/watch'));
  assert.equal(await shown(fresh, '#shorts'), false);
  await page.close();
  await fresh.close();
});

test('UC-2: exhausted budget blocks open tabs; badge shows minutes left', async () => {
  await apply({ kind: 'rule.upsert', rule: newRule('bud', [domain('budget.test')], { kind: 'budget', minutesPerDay: 20 }) });
  const page = await open(site('budget.test'));
  await page.bringToFront();
  assert.match(await h1(page), /budget\.test/);
  await worker.evaluate(() => globalThis.focusGuard.flush());
  const badge = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://budget.test/*' });
    return chrome.action.getBadgeText({ tabId: tab.id });
  });
  assert.equal(badge, '20m');
  await worker.evaluate(async () => {
    const st = await globalThis.focusGuard.getState();
    st.runtime.budget.used.bud = 20 * 60;
    await globalThis.focusGuard.recompute();
  });
  await waitUrl(page, /blocked\.html\?r=bud/);
  await waitText(page, /daily budget/i);
  await page.close();
});

test('FR-2.1 / FR-8.1: active time counts per domain and against budgets, not while idle', async () => {
  await apply({ kind: 'rule.upsert', rule: newRule('track', [domain('tracked.test')], { kind: 'budget', minutesPerDay: 30 }) });
  const page = await open(site('tracked.test'));
  await page.bringToFront();
  // Headless Chrome never reports a focused window, so feed the tracker the events Chrome would send.
  await worker.evaluate(() => globalThis.focusGuard.onActivity({ windowFocused: true, idle: 'active' }));
  await sleep(2500);
  await worker.evaluate(() => globalThis.focusGuard.onActivity({ idle: 'idle' }));
  await sleep(1500); // idle: must not count
  await worker.evaluate(() => globalThis.focusGuard.flush());
  const { used, active } = await worker.evaluate(async () => {
    const st = await globalThis.focusGuard.getState();
    const stats = (await chrome.storage.local.get('stats')).stats;
    const day = Object.values(stats).at(-1);
    return { used: st.runtime.budget.used.track, active: day.domains['tracked.test']?.active };
  });
  assert.ok(active >= 2 && active < 3.5, `active seconds ${active}`);
  assert.ok(used >= 2 && used < 3.5, `budget seconds ${used}`);
  await worker.evaluate(() => globalThis.focusGuard.onActivity({ idle: 'active' }));
  await page.close();
});

test('UC-4: a focus session blocks the focus list during work only', async () => {
  await apply({ kind: 'rule.upsert', rule: newRule('focus', [domain('social.test')], { kind: 'block' }, { onlyDuringFocus: true }) });
  let page = await open(site('social.test'));
  assert.match(await h1(page), /social\.test/);
  assert.deepEqual(await apply({ kind: 'focus.start' }), { ok: true });
  await waitUrl(page, /blocked\.html\?r=focus/);
  await waitText(page, /focus interval/i);
  await page.close();
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '25m');
  assert.deepEqual(await apply({ kind: 'focus.stop' }), { ok: true });
  page = await open(site('social.test'));
  assert.match(await h1(page), /social\.test/);
  await page.close();
});

test('UC-6: Password gates loosening only; Challenge passes with the typed passage', async () => {
  assert.deepEqual(await apply({ kind: 'commitment.set', level: 'password', newPassword: 'correct horse' }), { ok: true });
  assert.equal((await apply({ kind: 'rule.upsert', rule: newRule('tight', [domain('tight.test')]) })).ok, true, 'tightening passes');
  assert.equal((await apply({ kind: 'rule.delete', id: 'tight' })).error, 'gate');
  assert.equal((await apply({ kind: 'rule.delete', id: 'tight' }, { kind: 'password', password: 'nope' })).error, 'wrongProof');
  assert.deepEqual(await apply({ kind: 'rule.delete', id: 'tight' }, { kind: 'password', password: 'correct horse' }), { ok: true });
  assert.deepEqual(await apply({ kind: 'commitment.set', level: 'challenge' }), { ok: true }, 'raising needs no gate');
  // Through the real message path, as the options page does it.
  const page = await open(`chrome-extension://${extId}/options.html#settings`);
  const c = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'requestChallenge', mode: 'type' }));
  assert.ok(c.text.length >= 300);
  const wrong = await page.evaluate((c) => chrome.runtime.sendMessage({ type: 'applyChange', change: { kind: 'commitment.set', level: 'none' }, proof: { kind: 'challenge', challengeId: c.id, typed: 'nope' } }), c);
  assert.equal(wrong.error, 'wrongProof');
  const c2 = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'requestChallenge', mode: 'type' }));
  const res = await page.evaluate((c) => chrome.runtime.sendMessage({ type: 'applyChange', change: { kind: 'commitment.set', level: 'none' }, proof: { kind: 'challenge', challengeId: c.id, typed: c.text } }), c2);
  assert.deepEqual(res, { ok: true });
  await page.close();
});

test('UC-6 in the UI: deleting a rule under Password opens the gate dialog', async () => {
  assert.deepEqual(await apply({ kind: 'commitment.set', level: 'password', newPassword: 'correct horse' }), { ok: true });
  const page = await open(`chrome-extension://${extId}/options.html#rules`);
  await page.setViewport({ width: 1200, height: 900 });
  await waitText(page, /blk/);
  await page.click('button[aria-label="Delete blk"]');
  const clickDialogButton = async (label) => {
    await page.waitForFunction((l) => [...document.querySelectorAll('dialog[open] button')].some((b) => b.textContent.trim() === l), {}, label);
    await page.evaluate((l) => [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.trim() === l).click(), label);
  };
  await clickDialogButton('Delete');
  await page.waitForSelector('dialog[open] #gate-pw');
  await page.screenshot({ path: join(shots, 'gate-password.png') });
  await page.type('#gate-pw', 'wrong password');
  await clickDialogButton('Unlock change');
  await waitText(page, /not right/); // toast, dialog asks again
  await page.waitForSelector('dialog[open] #gate-pw');
  await page.type('#gate-pw', 'correct horse');
  await clickDialogButton('Unlock change');
  const end = Date.now() + 5000;
  while ((await state()).config.rules.some((r) => r.id === 'blk') && Date.now() < end) await sleep(100);
  assert.ok(!(await state()).config.rules.some((r) => r.id === 'blk'), 'rule deleted after the password');
  await page.close();
  await apply({ kind: 'commitment.set', level: 'none' }, { kind: 'password', password: 'correct horse' });
});

test('UC-5: Hard Lock refuses loosening and survives extension reload and browser restart', async () => {
  await apply({ kind: 'rule.upsert', rule: newRule('locked', [domain('deadline.test')], { kind: 'block' }, { enabled: false }) });
  const started = await apply({ kind: 'lock.start', durationMin: 180, ruleIds: ['locked'], targets: [domain('news.test')] });
  assert.equal(started.ok, true);
  assert.equal((await apply({ kind: 'rule.delete', id: 'locked' })).error, 'locked');
  assert.equal((await apply({ kind: 'settings.update', patch: { resetTime: '04:00' } })).error, 'locked');
  assert.equal((await apply({ kind: 'lock.extend', lockId: started.id, minutes: 30 })).ok, true, 'tightening allowed');

  const check = async (label) => {
    for (const host of ['deadline.test', 'news.test']) {
      const page = await open(site(host));
      await waitUrl(page, /blocked\.html/).catch(() => assert.fail(`${host} not blocked after ${label}`));
      await waitText(page, /Hard Lock/);
      await page.close();
    }
  };
  await check('start');

  // Reload the extension (what the Reload button in chrome://extensions does):
  // a new service worker starts from storage.
  assert.equal(await browser.installExtension(dist), extId);
  ({ target: workerTarget, w: worker } = await findWorker(workerTarget));
  await sleep(1000);
  await check('extension reload');

  // Restart the browser with the same profile.
  await browser.close();
  await launch();
  await sleep(1000);
  await check('browser restart');
  const st = await state();
  assert.equal(st.runtime.locks.length, 1);
  assert.ok(st.runtime.locks[0].endsAt - Date.now() > 3.5 * 3600_000 - 120_000, 'extended end time kept');
});

test('UI pages render without errors', async () => {
  const errors = [];
  const pages = ['popup.html', 'options.html#rules', 'options.html#hide', 'options.html#focus', 'options.html#lock', 'options.html#blockpage', 'options.html#insights', 'options.html#settings', 'onboarding.html'];
  for (const p of pages) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(`${p}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${p}: ${m.text()}`));
    await page.setViewport(p === 'popup.html' ? { width: 380, height: 640 } : { width: 1200, height: 900 });
    await page.goto(`chrome-extension://${extId}/${p}`, { waitUntil: 'networkidle0' });
    await sleep(500);
    const text = await page.evaluate(() => document.body.innerText);
    assert.ok(text.trim().length > 50, `${p} rendered content`);
    assert.doesNotMatch(text, /failed to render|Coming soon/i, p);
    await page.screenshot({ path: join(shots, `${p.replace(/[#.]/g, '_')}.png`), fullPage: true });
    await page.close();
  }
  assert.deepEqual(errors, []);
});

test('Onboarding: ticking templates and levels re-renders without errors and keeps focus', async () => {
  const errors = [];
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${extId}/onboarding.html`, { waitUntil: 'networkidle0' });
  const boxes = await page.$$eval('.tpl input[type=checkbox]', (els) => els.map((e) => e.id));
  assert.ok(boxes.length >= 3, 'template checkboxes present');
  for (const id of [...boxes, ...boxes]) {
    await page.click(`#${id}`);
    assert.equal(await page.evaluate(() => document.activeElement?.id), id, `focus kept on ${id}`);
  }
  for (const id of ['lvl-challenge', 'lvl-password', 'lvl-none']) {
    await page.click(`#${id}`);
    assert.equal(await page.evaluate(() => document.activeElement?.id), id, `focus kept on ${id}`);
  }
  await page.close();
  assert.deepEqual(errors, []);
});
