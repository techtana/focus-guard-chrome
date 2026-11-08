// End-to-end test for the on-device image classifier (parental controls).
// Loads dist/ into a real Chrome (throwaway profile), opens offscreen.html as a
// tab (its runtime.onMessage listener works there too) and sends it classify
// requests from the service worker, exactly as the worker does in production.
// Only NEUTRAL images generated here are used.
//   npm run build && node --test e2e/classifier.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const CHROME =
  process.env.CHROME_PATH ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p));

// ---- Tiny PNG encoder for generated test images ----
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
/** pixel(x, y) -> [r, g, b] */
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      const i = y * (w * 3 + 1) + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const IMAGES = {
  '/solid.png': png(256, 256, () => [70, 110, 160]),
  // Bar chart: white background, axes, four coloured bars.
  '/chart.png': png(320, 240, (x, y) => {
    if (x === 30 || y === 210) return [40, 40, 40];
    const bars = [[50, 120, [79, 70, 229]], [110, 60, [23, 128, 61]], [170, 150, [192, 38, 45]], [230, 90, [180, 83, 9]]];
    for (const [bx, top, c] of bars) if (x >= bx && x < bx + 40 && y >= top && y < 210) return c;
    return [255, 255, 255];
  }),
  // Landscape-like: sky gradient over green ground.
  '/landscape.png': png(300, 300, (x, y) => (y < 180 ? [120 + y / 3, 170 + y / 6, 235] : [40 + (x % 7), 120 + ((x * y) % 30), 50])),
  '/icon.png': readFileSync(join(dist, 'icons', 'icon128.png')),
};

let server;
let port;
let browser;
let worker;
let profile;
let extId;
const url = (p) => `http://images.test:${port}${p}`;

before(async () => {
  assert.ok(CHROME, 'Set CHROME_PATH to a Chrome or Chromium executable');
  assert.ok(existsSync(join(dist, 'models', 'nsfw_mobilenet_v2', 'model.json')), 'run npm run build first');
  server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    const body = IMAGES[path];
    if (body) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length });
      res.end(body);
    } else if (path === '/page.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>not an image</h1>');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  profile = mkdtempSync(join(tmpdir(), 'fg-clf-'));
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    pipe: true,
    enableExtensions: true,
    userDataDir: profile,
    args: ['--host-resolver-rules=MAP *.test 127.0.0.1', '--no-first-run', '--no-default-browser-check'],
  });
  extId = await browser.installExtension(dist);
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extId}/`));
  worker = await target.worker();
});

after(async () => {
  await browser?.close();
  server?.close();
  rmSync(profile, { recursive: true, force: true });
});

/** Send from the service worker, as production does (a sender never receives its own message). */
const send = (msg) => worker.evaluate((m) => chrome.runtime.sendMessage(m).catch((e) => ({ rejected: String(e) })), msg);

test('offscreen classifier scores neutral images; skips non-images; caches', async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The deliberate 404 below logs a resource error; anything else is a real failure.
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(`chrome-extension://${extId}/offscreen.html`, { waitUntil: 'load' });

  const urls = ['/solid.png', '/chart.png', '/landscape.png', '/icon.png'].map(url);
  const t0 = Date.now();
  const cold = await send({ target: 'offscreen', type: 'classify', urls: [...urls, url('/page.html'), url('/missing.png'), 'javascript:alert(1)'] });
  const coldMs = Date.now() - t0;
  assert.equal(cold.error, undefined, cold.error);
  assert.deepEqual(cold.results.map((r) => r.url), urls, 'non-images, 404s and bad schemes are skipped; order kept');

  for (const r of cold.results) {
    const sum = r.porn + r.hentai + r.sexy + r.neutral + r.drawing;
    assert.ok(Math.abs(sum - 1) < 0.02, `${r.url} scores sum to ${sum}`);
    assert.ok(r.neutral + r.drawing > 0.5, `${r.url} is neutral/drawing: ${JSON.stringify(r)}`);
    assert.ok(r.porn + r.hentai < 0.3, `${r.url} not explicit: ${JSON.stringify(r)}`);
  }

  const info = await page.evaluate(() => globalThis.fgClassifier.info());
  // Warm, uncached: same images under new URLs (query string defeats the LRU cache).
  const fresh = urls.map((u) => `${u}?v=2`);
  const t1 = Date.now();
  const warm = await send({ target: 'offscreen', type: 'classify', urls: fresh });
  const warmMs = Date.now() - t1;
  assert.equal(warm.results.length, 4);
  // Cached.
  const t2 = Date.now();
  const again = await send({ target: 'offscreen', type: 'classify', urls });
  const cachedMs = Date.now() - t2;
  assert.deepEqual(again.results, cold.results);

  // Messages not addressed to the offscreen document get no answer from it.
  const ignored = await send({ target: 'offscreen', type: 'something-else', urls });
  assert.ok(!ignored || ignored.rejected, 'unknown offscreen message types are not answered');

  console.log(
    `classifier: backend=${info.backend} modelLoad=${info.modelLoadMs}ms coldCall(4 imgs incl. model)=${coldMs}ms ` +
      `warm=${warmMs}ms (${Math.round(warmMs / 4)}ms/img) cached=${cachedMs}ms`,
  );
  for (const r of cold.results) {
    console.log(`  ${r.url.replace(/^.*\//, '')}: ${['neutral', 'drawing', 'sexy', 'porn', 'hentai'].map((k) => `${k}=${r[k].toFixed(3)}`).join(' ')}`);
  }
  assert.deepEqual(errors, []);
  await page.close();
});
