// Shrinks an image file in the browser so it fits a byte budget, for the block page image.
// Scales the longest side down and re-encodes as WebP (keeps transparency), lowering quality
// and then size until the result fits.

/** Types the background accepts as-is (see validateChange for `blockPage.update`). */
const STORABLE = /^image\/(png|jpeg|gif|webp|svg\+xml)$/;
/** Refuse to decode anything this large; it could exhaust memory. */
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
/** A block page image never needs to be bigger than this. */
const MAX_SIDE = 2048;
const QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5];

export interface ShrinkResult {
  dataUrl: string;
  /** True when the image was re-encoded rather than stored as uploaded. */
  shrunk: boolean;
  bytes: number;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode'));
    img.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Returns the file as a data: URL no larger than `maxBytes`. Files that already fit and are a
 * storable type pass through untouched. Throws an Error with a user-facing message on failure.
 */
export async function fitImage(file: File, maxBytes: number): Promise<ShrinkResult> {
  if (file.size <= maxBytes && STORABLE.test(file.type)) {
    return { dataUrl: await readAsDataUrl(file), shrunk: false, bytes: file.size };
  }
  if (file.size > MAX_INPUT_BYTES) throw new Error('The image is too large to resize (over 64 MB). Choose a smaller one.');

  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    throw new Error('This image could not be read. Try a PNG, JPEG or WebP file.');
  }
  // SVGs without intrinsic size report 0; give them a sensible canvas.
  const w0 = img.naturalWidth || 1024;
  const h0 = img.naturalHeight || 1024;
  let scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));

  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  if (!g) throw new Error('This browser could not resize the image.');

  // Each round tries a few qualities, then shrinks the dimensions by 25%.
  for (let round = 0; round < 8; round++) {
    canvas.width = Math.max(1, Math.round(w0 * scale));
    canvas.height = Math.max(1, Math.round(h0 * scale));
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const q of QUALITIES) {
      const blob = await encode(canvas, 'image/webp', q);
      if (!blob || blob.type !== 'image/webp') break; // encoder unavailable
      // base64 overhead is checked on the decoded size, so blob.size is the right measure.
      if (blob.size <= maxBytes) return { dataUrl: await readAsDataUrl(blob), shrunk: true, bytes: blob.size };
    }
    scale *= 0.75;
  }
  throw new Error('The image could not be made small enough. Choose a smaller one.');
}
