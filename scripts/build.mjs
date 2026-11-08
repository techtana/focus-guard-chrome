// Build the unpacked extension into dist/.
//   node scripts/build.mjs           one-off build
//   node scripts/build.mjs --watch   rebuild on change
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');

const entries = [
  { in: 'background/index.ts', out: 'background', format: 'esm' },
  { in: 'content/hide.ts', out: 'content', format: 'iife' },
  { in: 'content/picker.ts', out: 'picker', format: 'iife' },
  { in: 'popup/popup.ts', out: 'popup', format: 'iife' },
  { in: 'options/options.ts', out: 'options', format: 'iife' },
  { in: 'blocked/blocked.ts', out: 'blocked', format: 'iife' },
  { in: 'onboarding/onboarding.ts', out: 'onboarding', format: 'iife' },
  { in: 'content/parental.ts', out: 'parental', format: 'iife' },
  { in: 'offscreen/offscreen.ts', out: 'offscreen', format: 'esm' },
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function copyStatic() {
  mkdirSync(dist, { recursive: true });
  cpSync(join(src, 'manifest.json'), join(dist, 'manifest.json'));
  for (const dir of ['icons', 'presets']) {
    if (existsSync(join(src, dir))) cpSync(join(src, dir), join(dist, dir), { recursive: true });
  }
  // Every .html and .css under src/ is copied flat into dist/ (names must be unique).
  const seen = new Map();
  for (const f of walk(src)) {
    const ext = extname(f);
    if (ext !== '.html' && ext !== '.css') continue;
    const name = basename(f);
    if (seen.has(name)) throw new Error(`Duplicate static file name ${name}: ${seen.get(name)} and ${f}`);
    seen.set(name, f);
    cpSync(f, join(dist, name));
  }
  // Merge src/locales/*.json fragments into _locales/en/messages.json.
  const messages = {};
  const locDir = join(src, 'locales');
  for (const f of readdirSync(locDir).filter((n) => n.endsWith('.json')).sort()) {
    const frag = JSON.parse(readFileSync(join(locDir, f), 'utf8'));
    for (const [k, v] of Object.entries(frag)) {
      if (k in messages) throw new Error(`Duplicate locale key ${k} in ${f}`);
      messages[k] = v;
    }
  }
  mkdirSync(join(dist, '_locales', 'en'), { recursive: true });
  writeFileSync(join(dist, '_locales', 'en', 'messages.json'), JSON.stringify(messages, null, 2));
  // NSFW image classifier (parental controls): nsfwjs ships MobileNetV2 as base64 inside JS
  // modules. Decode it once into a TF.js layers model (model.json + binary shard) so the
  // offscreen document loads ~2.6 MB of binary from the extension package, never the network.
  const nsfwDir = join(root, 'node_modules', 'nsfwjs', 'dist', 'models', 'mobilenet_v2');
  if (existsSync(nsfwDir)) {
    const req = createRequire(join(root, 'package.json'));
    const modelJson = req(join(nsfwDir, 'model.min.js'));
    const weights = req(join(nsfwDir, 'group1-shard1of1.min.js'));
    const out = join(dist, 'models', 'nsfw_mobilenet_v2');
    mkdirSync(out, { recursive: true });
    const manifest = modelJson.weightsManifest.map((g) => ({ ...g, paths: g.paths.map((p) => `${p}.bin`) }));
    writeFileSync(join(out, 'model.json'), JSON.stringify({ format: 'layers-model', modelTopology: modelJson.modelTopology, weightsManifest: manifest }));
    writeFileSync(join(out, 'group1-shard1of1.bin'), Buffer.from(String(weights.default ?? weights), 'base64'));
  } else {
    console.warn('skip: nsfwjs not installed, image classifier model not copied');
  }
}

async function main() {
  if (!watch) rmSync(dist, { recursive: true, force: true });
  copyStatic();
  const present = entries.filter((e) => {
    const ok = existsSync(join(src, e.in));
    if (!ok) console.warn(`skip: src/${e.in} not found`);
    return ok;
  });
  const contexts = await Promise.all(
    present.map((e) =>
      esbuild.context({
        entryPoints: [join(src, e.in)],
        outfile: join(dist, `${e.out}.js`),
        bundle: true,
        format: e.format,
        target: 'chrome120',
        sourcemap: watch ? 'inline' : false,
        legalComments: 'none',
        logLevel: 'warning',
      }),
    ),
  );
  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('watching src/ ... (static files are copied at start; restart to recopy)');
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
    const kb = (f) => (statSync(join(dist, f)).size / 1024).toFixed(1);
    console.log(`built dist/ (${present.map((e) => `${e.out}.js ${kb(e.out + '.js')} KB`).join(', ')})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
