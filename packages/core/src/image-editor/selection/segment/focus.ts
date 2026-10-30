/**
 * Select › Focus Area: the parts of the image that are in focus. Fine detail survives only where
 * the lens was focused, so a sharpness map (the Laplacian's local energy, less a floor for the
 * image's noise) is split into in and out of focus, closed over smooth areas inside sharp ones,
 * and fitted to the image's edges with a guided filter.
 */

import type { PixelBuffer, SelectionMask } from '../mask';
import { boxMean, guidedFilterColor } from '../refine';
import { softMaskToSelection, workLuma, workPlanes } from './guided';
import { otsuThreshold } from './subject';
import { workImage } from './work';

export interface FocusAreaOptions {
  /** In-Focus Range 0..100 (default 50): higher takes in less sharp areas too. */
  range?: number;
  /** Image Noise Level 0..100 (default 0): raise it when grain is selected as detail. */
  noise?: number;
  /** Soften the edge over this many natural pixels (default 4; 0 for a hard edge). */
  softness?: number;
}

export interface FocusAreaResult {
  selection: SelectionMask;
  /** The noise measured in the image (σ of luminance, in levels of 255). */
  noiseLevel: number;
}

/** Long side of the copy Focus Area works on: more than the segmentations, as it measures detail. */
const FOCUS_SIZE = 1024;

/** σ of the image's noise (Immerkær, 1996): the mean response to a mask that cancels smooth shading. */
function estimateNoise(luma: Float32Array, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v =
        luma[i - w - 1] - 2 * luma[i - w] + luma[i - w + 1] - 2 * luma[i - 1] + 4 * luma[i] - 2 * luma[i + 1] + luma[i + w - 1] - 2 * luma[i + w] + luma[i + w + 1];
      sum += Math.abs(v);
    }
  }
  return (Math.sqrt(Math.PI / 2) * sum) / (6 * (w - 2) * (h - 2));
}

/** The in-focus areas of `pixels` as a selection of the whole image. */
export function focusArea(pixels: PixelBuffer, options: FocusAreaOptions = {}): FocusAreaResult {
  const work = workImage(pixels, FOCUS_SIZE);
  const { width: w, height: h, scale } = work;
  const n = w * h;
  const luma = workLuma(work);
  const sigma = estimateNoise(luma, w, h);
  const noise = Math.min(100, Math.max(0, options.noise ?? 0));
  const floor = 2 * sigma * (1 + noise / 25);
  // Detail: the Laplacian's size above the noise floor.
  const detail = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = Math.abs(4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - w] - luma[i + w]);
      const d = Math.max(0, lap - floor);
      detail[i] = d * d;
    }
  }
  // Its local energy over about 1 % of the image, on a log scale normalised to 0..1.
  const r = Math.max(2, Math.round(0.012 * Math.max(w, h)));
  const energy = boxMean(detail, w, h, r);
  const sharp = new Float32Array(n);
  for (let i = 0; i < n; i++) sharp[i] = Math.log1p(Math.sqrt(energy[i]) * 400);
  const sorted = Float32Array.from(sharp).sort();
  const top = sorted[Math.floor(n * 0.995)] || 1;
  for (let i = 0; i < n; i++) sharp[i] = Math.min(1, sharp[i] / top);
  const ones = new Float32Array(n).fill(1);
  const otsu = otsuThreshold(sharp, ones);
  const range = Math.min(100, Math.max(0, options.range ?? 50));
  const t = Math.min(0.98, otsu * Math.pow(2, (50 - range) / 25));
  let mask: Float32Array = new Float32Array(n);
  for (let i = 0; i < n; i++) mask[i] = sharp[i] >= t ? 1 : 0;
  // Close: smooth surfaces inside sharp areas (skin, a painted wall) have little detail of their own.
  const c = 2 * r;
  const grown = boxMean(mask, w, h, c);
  for (let i = 0; i < n; i++) grown[i] = grown[i] > 0.001 ? 1 : 0;
  const shrunk = boxMean(grown, w, h, c);
  for (let i = 0; i < n; i++) mask[i] = shrunk[i] >= 0.999 ? 1 : 0;
  // The energy window spreads a sharp area's detail about half its radius into blurred
  // surroundings: pull the edge back by that much.
  const pulled = boxMean(mask, w, h, Math.max(1, Math.round(r / 2)));
  for (let i = 0; i < n; i++) mask[i] = pulled[i] >= 0.999 ? 1 : 0;
  const softness = Math.max(0, options.softness ?? 4) * scale;
  if (softness > 0) {
    const fitted = guidedFilterColor(workPlanes(work), mask, w, h, Math.max(1, Math.round(softness * 2)), 1e-3);
    for (let i = 0; i < n; i++) mask[i] = Math.min(1, Math.max(0, fitted[i]));
  }
  return { selection: softMaskToSelection(work, mask), noiseLevel: Math.round(sigma * 255 * 10) / 10 };
}
