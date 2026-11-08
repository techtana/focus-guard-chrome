// Image-classifier policy for parental mode. The offscreen classifier returns
// raw NSFWJS class scores; these functions turn them into decisions.

import type { ImageScores, Sensitivity } from '../shared/types.ts';

/** porn + hentai needed to call one image explicit; 'high' also counts half of 'sexy'. */
export const IMAGE_THRESHOLD: Record<Sensitivity, number> = { low: 0.85, medium: 0.7, high: 0.5 };

/** Explicit images on one page that make the whole page explicit. */
export const PAGE_IMAGE_COUNT: Record<Sensitivity, number> = { low: 4, medium: 3, high: 1 };

export function imageIsExplicit(s: ImageScores, sensitivity: Sensitivity): boolean {
  const score = s.porn + s.hentai + (sensitivity === 'high' ? 0.5 * s.sexy : 0);
  return score >= IMAGE_THRESHOLD[sensitivity];
}

/**
 * Is the page explicit because of its images? Needs PAGE_IMAGE_COUNT explicit
 * images; with fewer than 2 scanned images at 'low'/'medium' a single image
 * never decides (it is blurred instead).
 */
export function pageExplicitByImages(explicitCount: number, scannedCount: number, sensitivity: Sensitivity): boolean {
  if (explicitCount <= 0) return false;
  if (sensitivity !== 'high' && scannedCount < 2) return false;
  return explicitCount >= PAGE_IMAGE_COUNT[sensitivity];
}
