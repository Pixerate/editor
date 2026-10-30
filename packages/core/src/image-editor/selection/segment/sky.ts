/**
 * Select › Sky without a segmentation model. Sky is smooth, sits at the top of the frame, and is
 * blue, or bright and grey when overcast. Each pixel gets a score from those three cues; the sky
 * is grown down from the top rows through high-scoring pixels; patches of the same colour seen
 * through gaps (between branches, under a bridge) are added; and the edge is fitted to the image
 * with the colour guided filter.
 */

import { boxMean, guidedFilterColor } from '../refine';
import { createSelectionMask, type PixelBuffer, type SelectionMask } from '../mask';
import { softMaskToSelection, workLuma, workPlanes } from './guided';
import { workImage, type SelectionProgress } from './work';

export interface SkyOptions {
  /** 0..100 (default 50): higher takes in less sky-like pixels (haze, a sunset glow). */
  threshold?: number;
  /** Soften the edge over this many natural pixels (default 4; 0 for a hard edge). */
  softness?: number;
  onProgress?: SelectionProgress;
}

export interface FoundSky {
  selection: SelectionMask;
  /** Why nothing was selected, when nothing was. */
  reason?: string;
}

const SKY_SIZE = 768;

/** sRGB (0..255) to L*, a*, b*. */
function lab(r: number, g: number, b: number): [number, number, number] {
  const lin = (v: number) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));

/** The sky in `pixels`, as a selection of the whole image (empty, with a reason, when there is none). */
export function findSky(pixels: PixelBuffer, options: SkyOptions = {}): FoundSky {
  const report = options.onProgress;
  report?.(0, 'Reducing the image');
  const work = workImage(pixels, SKY_SIZE);
  report?.(0.2, 'Scoring the sky');
  const { width: w, height: h, rgb, scale } = work;
  const n = w * h;
  const L = new Float32Array(n);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [l, a, b] = lab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    L[i] = l;
    A[i] = a;
    B[i] = b;
  }
  // Smoothness: the local mean gradient of luminance, small in sky.
  // On luminance smoothed over 3 × 3 first, so a photo's grain doesn't read as texture.
  const luma = boxMean(workLuma(work), w, h, 1);
  const grad = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const gx = x + 1 < w ? luma[i + 1] - luma[i] : 0;
      const gy = y + 1 < h ? luma[i + w] - luma[i] : 0;
      grad[i] = Math.hypot(gx, gy);
    }
  }
  const roughR = Math.max(1, Math.round(0.006 * Math.max(w, h)));
  const rough = boxMean(grad, w, h, roughR);
  const score = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const chroma = Math.hypot(A[i], B[i]);
    // Blue (b* below zero, not too dark) or bright and nearly grey (overcast, haze).
    const blue = sigmoid((-B[i] - 6) / 4) * sigmoid((L[i] - 35) / 6);
    const grey = sigmoid((L[i] - 68) / 5) * sigmoid((18 - chroma) / 4);
    const smooth = Math.exp(-rough[i] / 0.02);
    const y = Math.floor(i / w) / h;
    const high = 1 - 0.35 * y;
    score[i] = Math.max(blue, grey) * smooth * high;
  }
  const threshold = Math.min(100, Math.max(0, options.threshold ?? 50));
  const t = 0.55 - (threshold - 50) * 0.006;
  // Grow down from the top rows through scoring pixels, without jumping across an edge.
  report?.(0.5, 'Growing the sky');
  const sky = new Uint8Array(n);
  const stack: number[] = [];
  const seedRows = Math.max(1, Math.round(h * 0.04));
  for (let y = 0; y < seedRows; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (score[i] >= t) {
        sky[i] = 1;
        stack.push(i);
      }
    }
  }
  if (!stack.length) return { selection: createSelectionMask(pixels.width, pixels.height), reason: 'No sky was found along the top of the image.' };
  const low = t * 0.7;
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    for (const q of [x + 1 < w ? p + 1 : -1, x > 0 ? p - 1 : -1, p + w < n ? p + w : -1, p - w]) {
      if (q < 0 || sky[q] || score[q] < low) continue;
      if (Math.hypot(L[q] - L[p], A[q] - A[p], B[q] - B[p]) > 6) continue;
      sky[q] = 1;
      stack.push(q);
    }
  }
  // The sky's colours, to find the patches of it seen through gaps.
  let count = 0;
  const mean = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (!sky[i]) continue;
    mean[0] += L[i];
    mean[1] += A[i];
    mean[2] += B[i];
    count++;
  }
  for (let k = 0; k < 3; k++) mean[k] /= count;
  let spread = 0;
  for (let i = 0; i < n; i++) if (sky[i]) spread += (L[i] - mean[0]) ** 2 + (A[i] - mean[1]) ** 2 + (B[i] - mean[2]) ** 2;
  const limit = Math.max(8, 2.5 * Math.sqrt(spread / count));
  for (let i = 0; i < n; i++) {
    if (sky[i] || score[i] < t) continue;
    if (Math.hypot(L[i] - mean[0], A[i] - mean[1], B[i] - mean[2]) <= limit) sky[i] = 1;
  }
  // The smoothness window counts the horizon itself as rough, so sky stops a few pixels short of
  // it: reach those pixels by colour alone.
  let front: number[] = [];
  for (let i = 0; i < n; i++) if (sky[i]) front.push(i);
  for (let step = 0; step <= roughR + 1 && front.length; step++) {
    const next: number[] = [];
    for (const p of front) {
      const x = p % w;
      for (const q of [x + 1 < w ? p + 1 : -1, x > 0 ? p - 1 : -1, p + w < n ? p + w : -1, p - w]) {
        if (q < 0 || sky[q]) continue;
        if (Math.hypot(L[q] - mean[0], A[q] - mean[1], B[q] - mean[2]) > limit) continue;
        sky[q] = 1;
        next.push(q);
      }
    }
    front = next;
  }
  if (count < n * 0.005) return { selection: createSelectionMask(pixels.width, pixels.height), reason: 'No sky was found along the top of the image.' };
  report?.(0.7, 'Fitting the edge');
  let mask: Float32Array = Float32Array.from(sky);
  const softness = Math.max(0, options.softness ?? 4) * scale;
  if (softness > 0) {
    const fitted = guidedFilterColor(workPlanes(work), mask, w, h, Math.max(1, Math.round(softness * 2)), 1e-3);
    mask = new Float32Array(n);
    for (let i = 0; i < n; i++) mask[i] = Math.min(1, Math.max(0, fitted[i]));
  }
  const selection = softMaskToSelection(work, mask);
  report?.(1, 'Done');
  return { selection };
}
