// On-device NSFW image classifier for parental controls, running in an
// offscreen document (the service worker has no DOM, canvas or WebGL).
//
// Model: NSFWJS MobileNetV2 (224x224, ~2.6 MB), shipped inside the extension
// under models/nsfw_mobilenet_v2/ (decoded from the nsfwjs package at build
// time by scripts/build.mjs). Nothing is loaded from the network except the
// images we are asked to classify; scores are returned to the worker and kept
// only in an in-memory cache. Nothing is stored or sent anywhere else.
//
// Protocol: answers ONLY runtime messages with target 'offscreen' (see
// OffscreenClassifyRequest in shared/messages.ts); everything else returns
// false so messages meant for the service worker are left alone.

import * as tf from '@tensorflow/tfjs';
import { NSFWJS } from 'nsfwjs/core';
import type { OffscreenClassifyRequest, OffscreenClassifyResponse } from '../shared/messages.ts';
import type { ImageScores } from '../shared/types.ts';

const MODEL_URL = chrome.runtime.getURL('models/nsfw_mobilenet_v2/model.json');
const SIZE = 224;
const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_URLS_PER_CALL = 32;
const CONCURRENCY = 2;
const CACHE_MAX = 500;

// ---- Model ----

let modelPromise: Promise<NSFWJS> | null = null;
let backend = '';
/** Milliseconds the last successful model load took (for diagnostics and tests). */
let modelLoadMs = 0;

async function initBackend(): Promise<void> {
  tf.enableProdMode();
  for (const name of ['webgl', 'cpu']) {
    try {
      if (await tf.setBackend(name)) {
        await tf.ready();
        backend = tf.getBackend();
        return;
      }
    } catch {
      // Try the next backend.
    }
  }
  throw new Error('No TensorFlow.js backend available');
}

function getModel(): Promise<NSFWJS> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const t0 = performance.now();
      await initBackend();
      // An explicit HTTP IO handler: tf's URL router does not route chrome-extension:// URLs.
      const model = new NSFWJS(tf.io.browserHTTPRequest(MODEL_URL), { size: SIZE });
      await model.load(); // also runs one warm-up prediction
      modelLoadMs = Math.round(performance.now() - t0);
      return model;
    })().catch((err) => {
      modelPromise = null; // let the next request retry
      throw err;
    });
  }
  return modelPromise;
}

// ---- Cache (LRU by URL; scores only) ----

const cache = new Map<string, ImageScores>();

function cacheGet(url: string): ImageScores | undefined {
  const hit = cache.get(url);
  if (hit) {
    cache.delete(url);
    cache.set(url, hit);
  }
  return hit;
}

function cachePut(s: ImageScores): void {
  cache.set(s.url, s);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

// ---- Classification ----

function isHttpUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length > 4096) return false;
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

/** Fetch and decode one image, scaled to the model's input size. Null when it cannot be used. */
async function loadImage(url: string): Promise<ImageBitmap | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal, cache: 'force-cache' });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    // createImageBitmap cannot decode SVG; anything not an image is skipped.
    if (!type.startsWith('image/') || type.startsWith('image/svg')) return null;
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return null;
    const blob = await res.blob();
    if (blob.size === 0 || blob.size > MAX_BYTES) return null;
    // Let the decoder downscale: much cheaper than resizing a large tensor.
    return await createImageBitmap(blob, { resizeWidth: SIZE, resizeHeight: SIZE, resizeQuality: 'medium' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function classifyOne(model: NSFWJS, url: string): Promise<ImageScores | null> {
  const cached = cacheGet(url);
  if (cached) return cached;
  const bitmap = await loadImage(url);
  if (!bitmap) return null;
  try {
    const preds = await model.classify(bitmap as unknown as HTMLImageElement, 5);
    const p = (name: string) => preds.find((x) => x.className === name)?.probability ?? 0;
    const scores: ImageScores = {
      url,
      porn: p('Porn'),
      hentai: p('Hentai'),
      sexy: p('Sexy'),
      neutral: p('Neutral'),
      drawing: p('Drawing'),
    };
    cachePut(scores);
    return scores;
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

export async function classify(urls: string[]): Promise<OffscreenClassifyResponse> {
  const list = [...new Set(urls.filter(isHttpUrl))].slice(0, MAX_URLS_PER_CALL);
  if (!list.length) return { results: [] };
  let model: NSFWJS;
  try {
    model = await getModel();
  } catch (err) {
    return { results: [], error: `Classifier failed to load: ${String(err)}` };
  }
  const results: ImageScores[] = [];
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const url = list[next++];
      const s = await classifyOne(model, url);
      if (s) results.push(s);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  // Keep the caller's order.
  results.sort((a, b) => list.indexOf(a.url) - list.indexOf(b.url));
  return { results };
}

chrome.runtime.onMessage.addListener((msg: Partial<OffscreenClassifyRequest> | undefined, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'classify') return false;
  if (sender.id !== chrome.runtime.id || !Array.isArray(msg.urls)) {
    sendResponse({ results: [], error: 'Bad request' } satisfies OffscreenClassifyResponse);
    return false;
  }
  classify(msg.urls).then(sendResponse, (err) => sendResponse({ results: [], error: String(err) } satisfies OffscreenClassifyResponse));
  return true;
});

// Diagnostics (visible from DevTools on the offscreen document; used by e2e/classifier.test.mjs).
(globalThis as unknown as Record<string, unknown>).fgClassifier = {
  classify,
  warmUp: () => getModel().then(() => ({ backend, modelLoadMs })),
  info: () => ({ backend, modelLoadMs, cached: cache.size }),
};
