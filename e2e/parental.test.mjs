// End-to-end tests for parental controls in a real Chrome (see e2e.test.mjs for the approach).
// Every host name resolves to a local test server, so known-site blocking, page
// detection, SafeSearch rewriting and the YouTube header run offline. Fixtures are
// synthetic text; no explicit imagery is used.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { KNOWN_ADULT_SITES } from '../src/parental/known-sites.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const CHROME =
  process.env.CHROME_PATH ||
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) =>
    existsSync(p),
  );

let server;
let port;
let tlsServer;
let tlsPort;
let browser;
let worker;
let extId;
let profile;
const PIN = '4321';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const site = (host, path = '/') => `http://${host}:${port}${path}`;
/** HTTPS for HSTS-preloaded hosts (youtube.com, reddit.com), which Chrome never loads over http. */
const tlsSite = (host, path = '/') => `https://${host}:${tlsPort}${path}`;

const PAGES = {
  '/clean': `<title>Weeknight chicken recipes</title><h1>Roast chicken breast with lemon</h1><p>Season the breast of chicken and roast for 25 minutes.</p>`,
  '/explicit': `<meta name="rating" content="RTA-5042-1996-1400-1577-RTA"><title>Free porn videos xxx</title><h1>Hardcore porn</h1><p>xxx porn sex videos</p>`,
  '/feed': `<title>Feed</title><h1>Feed</h1><shreddit-post id="safe" post-title="Cute cats">Cute cats</shreddit-post><shreddit-post id="nsfw" nsfw="" post-title="NSFW post">NSFW post</shreddit-post>`,
};

async function launch() {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    pipe: true,
    enableExtensions: true,
    userDataDir: profile,
    args: ['--host-resolver-rules=MAP * 127.0.0.1', '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'],
  });
  extId = await browser.installExtension(dist);
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extId}/`), { timeout: 15_000 });
  worker = await target.worker();
  for (let i = 0; i < 50 && !(await worker.evaluate(() => !!globalThis.focusGuard).catch(() => false)); i++) await sleep(100);
}

const apply = (change, proof) => worker.evaluate((c, p) => globalThis.focusGuard.applyChange(c, p), change, proof);
const pin = { kind: 'guardian', pin: PIN };

async function open(url) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  return page;
}
async function waitUrl(page, re, timeout = 8000) {
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
  assert.fail(`timed out waiting for ${re}; text: ${text.slice(0, 200)}`);
}

before(async () => {
  assert.ok(CHROME, 'Set CHROME_PATH');
  const handler = (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    const path = req.url.split('?')[0];
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const body = PAGES[path] ?? `<title>${host}</title><h1>Home of ${host}</h1>`;
    res.end(`<!doctype html>${body}<pre id="yt">${req.headers['youtube-restrict'] ?? 'none'}</pre><pre id="url">${req.url}</pre>`);
  };
  server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  profile = mkdtempSync(join(tmpdir(), 'fg-e2e-parental-'));
  // Throwaway self-signed certificate (Chrome runs with --ignore-certificate-errors).
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', join(profile, 'k.pem'), '-out', join(profile, 'c.pem')], { stdio: 'ignore' });
  tlsServer = createHttpsServer({ key: readFileSync(join(profile, 'k.pem')), cert: readFileSync(join(profile, 'c.pem')) }, handler);
  await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r));
  tlsPort = tlsServer.address().port;
  await launch();
  for (const p of await browser.pages()) if (p.url().includes('onboarding')) await p.close();
});

after(async () => {
  await browser?.close();
  server?.close();
  tlsServer?.close();
  rmSync(profile, { recursive: true, force: true });
});

test('enable needs a PIN; afterwards every parental change needs it', async () => {
  assert.equal((await apply({ kind: 'parental.enable' })).error, 'invalid');
  assert.equal((await apply({ kind: 'parental.enable', pin: PIN })).ok, true);
  assert.equal((await apply({ kind: 'parental.disable' })).error, 'gate');
  assert.equal((await apply({ kind: 'parental.disable' }, { kind: 'guardian', pin: '0000' })).error, 'wrongProof');
  assert.equal((await apply({ kind: 'parental.update', patch: { sensitivity: 'medium' } }, pin)).ok, true);
  const registered = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  assert.ok(registered.some((s) => s.id === 'fg-parental'), 'parental content script registered');
});

test('known adult sites are blocked before the page loads', async () => {
  const host = KNOWN_ADULT_SITES[0];
  assert.ok(host && !host.endsWith('.test'), 'real curated list in place');
  const page = await open(site(`www.${host}`, '/anything'));
  await waitUrl(page, /blocked\.html\?r=parental&t=0/);
  await waitText(page, /parental controls/i);
  const text = await page.evaluate(() => document.body.innerText);
  assert.doesNotMatch(text, /Open FocusGuard/, 'children are not sent to settings');
  await page.close();
});

test('a clean page stays open (no false positive), an explicit page is detected and the site learned', async () => {
  const clean = await open(site('recipes.example', '/clean'));
  await sleep(1500);
  assert.match(clean.url(), /recipes\.example/);
  assert.equal(await clean.evaluate(() => getComputedStyle(document.documentElement).visibility), 'visible', 'page revealed after the check');
  await clean.close();

  const page = await open(site('unknown-site.example', '/explicit'));
  await waitUrl(page, /blocked\.html\?r=parental&t=1&h=unknown-site\.example/);
  await page.close();
  const learned = await worker.evaluate(async () => (await globalThis.focusGuard.getState()).runtime.parentalDetected.map((d) => d.host));
  assert.deepEqual(learned, ['unknown-site.example']);
  // Now blocked up front on any page of that site.
  const again = await open(site('unknown-site.example', '/clean'));
  await waitUrl(again, /blocked\.html\?r=parental&t=1/);
  await again.close();
});

test('a guardian can allow a learned site with the PIN', async () => {
  assert.equal((await apply({ kind: 'parental.allowSite', host: 'unknown-site.example' })).error, 'gate');
  assert.equal((await apply({ kind: 'parental.allowSite', host: 'unknown-site.example' }, pin)).ok, true);
  const page = await open(site('unknown-site.example', '/clean'));
  await sleep(1200);
  assert.match(page.url(), /unknown-site\.example:\d+\/clean/);
  await page.close();
});

test('SafeSearch is forced and YouTube gets Restricted Mode', async () => {
  const g = await open(site('www.google.com', '/search?q=cats'));
  await waitText(g, /safe=active/);
  assert.match(g.url(), /safe=active/);
  await g.close();
  const yt = await open(tlsSite('www.youtube.com', '/'));
  assert.equal(await yt.$eval('#yt', (e) => e.textContent), 'Strict');
  await yt.close();
});

test('social filter hides NSFW posts but keeps the feed', async () => {
  const page = await open(tlsSite('www.reddit.com', '/feed'));
  await page.waitForFunction(() => getComputedStyle(document.getElementById('nsfw')).display === 'none', { timeout: 5000 });
  assert.notEqual(await page.$eval('#safe', (e) => getComputedStyle(e).display), 'none');
  await page.close();
});

test('the parental section renders and turning it off removes the filter', async () => {
  const page = await open(`chrome-extension://${extId}/options.html#parental`);
  await waitText(page, /Learned sites|PIN/i);
  await page.setViewport({ width: 1200, height: 900 });
  await page.screenshot({ path: join(root, 'test-results', 'parental.png'), fullPage: true });
  await page.close();
  assert.equal((await apply({ kind: 'parental.disable' }, pin)).ok, true);
  const p = await open(site(`www.${KNOWN_ADULT_SITES[0]}`, '/'));
  await sleep(800);
  assert.doesNotMatch(p.url(), /blocked\.html/);
  await p.close();
  const registered = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  assert.ok(!registered.some((s) => s.id === 'fg-parental'), 'content script unregistered');
});
