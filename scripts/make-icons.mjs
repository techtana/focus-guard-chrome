// Draw the toolbar/store icons (a shield with a check-dot) as PNGs, no dependencies.
//   node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');
mkdirSync(out, { recursive: true });

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shape in unit coordinates (0..1): shield = rounded top, pointed bottom.
function inShield(x, y) {
  const cx = 0.5;
  if (y < 0.12 || y > 0.92) return false;
  const halfW = y < 0.55 ? 0.36 : 0.36 * (1 - (y - 0.55) / 0.37) ** 0.9;
  if (Math.abs(x - cx) > halfW) return false;
  if (y < 0.24) {
    // Gentle dip at the top centre.
    const top = 0.12 + 0.05 * (1 - Math.abs(x - cx) / 0.36);
    return y >= top;
  }
  return true;
}
function inDot(x, y) {
  return (x - 0.5) ** 2 + (y - 0.47) ** 2 < 0.13 ** 2;
}

const BG = [79, 70, 229]; // indigo-600
const FG = [255, 255, 255];
for (const size of [16, 32, 48, 128]) {
  const buf = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let shield = 0;
      let dot = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          if (inShield(x, y)) {
            shield++;
            if (inDot(x, y)) dot++;
          }
        }
      }
      const a = shield / (ss * ss);
      const f = shield ? dot / shield : 0;
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) buf[i + c] = Math.round(BG[c] * (1 - f) + FG[c] * f);
      buf[i + 3] = Math.round(a * 255);
    }
  }
  writeFileSync(join(out, `icon${size}.png`), png(size, buf));
}
console.log('icons written to src/icons');
