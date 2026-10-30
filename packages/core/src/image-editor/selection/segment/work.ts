/**
 * The reduced copy of the image the segmentations (Quick, Object and Subject Selection, Focus
 * Area) work on, and scaling their result back up to the image.
 */

import { selectionFromRegion, type PixelBuffer, type SelectionMask } from '../mask';

/** The reduced image the segmentations work on (sRGB, 0..255 per channel). */
export interface WorkImage {
  /** Natural size of the image it was made from. */
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  /** Reduced pixels per natural pixel (≤ 1). */
  scale: number;
  /** RGB, 3 values per pixel. */
  rgb: Float32Array;
}

/** Long side of the work image (the issue's 512²). */
export const WORK_SIZE = 512;

/** Per pixel buffer, a reduced copy per long side (512 for the graph cuts, more for Focus Area). */
const workCache = new WeakMap<object, Map<number, WorkImage>>();

/**
 * `pixels` reduced to at most {@link WORK_SIZE} px on the long side by area averaging (alpha
 * composited over white). Cached per pixel buffer.
 */
export function workImage(pixels: PixelBuffer, maxSide = WORK_SIZE): WorkImage {
  const sizes = workCache.get(pixels.data as object);
  const cached = sizes?.get(maxSide);
  if (cached && cached.sourceWidth === pixels.width && cached.sourceHeight === pixels.height) return cached;
  const { width: W, height: H, data } = pixels;
  const scale = Math.min(1, maxSide / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const sum = new Float64Array(w * h * 3);
  const count = new Float64Array(w * h);
  const xs = new Int32Array(W);
  for (let x = 0; x < W; x++) xs[x] = Math.min(w - 1, Math.floor((x * w) / W));
  for (let y = 0; y < H; y++) {
    const row = Math.min(h - 1, Math.floor((y * h) / H)) * w;
    for (let x = 0, p = y * W * 4; x < W; x++, p += 4) {
      const o = row + xs[x];
      const a = data[p + 3] / 255;
      const k = o * 3;
      sum[k] += data[p] * a + 255 * (1 - a);
      sum[k + 1] += data[p + 1] * a + 255 * (1 - a);
      sum[k + 2] += data[p + 2] * a + 255 * (1 - a);
      count[o]++;
    }
  }
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const c = count[i] || 1;
    rgb[i * 3] = sum[i * 3] / c;
    rgb[i * 3 + 1] = sum[i * 3 + 1] / c;
    rgb[i * 3 + 2] = sum[i * 3 + 2] / c;
  }
  const work: WorkImage = { sourceWidth: W, sourceHeight: H, width: w, height: h, scale: w / W, rgb };
  if (sizes) sizes.set(maxSide, work);
  else workCache.set(pixels.data as object, new Map([[maxSide, work]]));
  return work;
}

/** Edge weight between neighbours: high for similar colours, low across an edge (GrabCut's γ, β). */
export const GAMMA = 50;
/**
 * Capacities are whole multiples of 1 / UNITS: in floating point, residuals that should reach
 * zero are left a hair above it and max-flow then pushes thousands of near-empty paths.
 */
export const UNITS = 64;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Capacities of the edges between neighbours in `roi` (to the right and below, indexed by the
 * pixel in the window): high between similar colours, low across an edge, GrabCut's
 * γ·exp(−β‖Δc‖²) with β from the window's mean squared difference, in whole {@link UNITS}.
 */
export function smoothnessWeights(work: WorkImage, roi: Rect): { right: Float64Array; down: Float64Array } {
  const { width: w, rgb } = work;
  const { x: rx, y: ry, width: rw, height: rh } = roi;
  const right = new Float64Array(rw * rh);
  const down = new Float64Array(rw * rh);
  let sumSq = 0;
  let pairs = 0;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const p = y * rw + x;
      const c = ((ry + y) * w + rx + x) * 3;
      if (x + 1 < rw) {
        right[p] = (rgb[c] - rgb[c + 3]) ** 2 + (rgb[c + 1] - rgb[c + 4]) ** 2 + (rgb[c + 2] - rgb[c + 5]) ** 2;
        sumSq += right[p];
        pairs++;
      }
      if (y + 1 < rh) {
        const k = c + w * 3;
        down[p] = (rgb[c] - rgb[k]) ** 2 + (rgb[c + 1] - rgb[k + 1]) ** 2 + (rgb[c + 2] - rgb[k + 2]) ** 2;
        sumSq += down[p];
        pairs++;
      }
    }
  }
  const beta = 1 / (2 * Math.max(1e-6, sumSq / Math.max(1, pairs)));
  for (let p = 0; p < right.length; p++) {
    right[p] = Math.round(GAMMA * UNITS * Math.exp(-beta * right[p]));
    down[p] = Math.round(GAMMA * UNITS * Math.exp(-beta * down[p]));
  }
  return { right, down };
}

/** A 3 × 3 box blur of `src` (w × h), `passes` times. */
export function boxBlur(src: Float32Array, w: number, h: number, passes: number): Float32Array {
  let a = src;
  for (let k = 0; k < passes; k++) {
    const b = new Float32Array(a.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        let c = 0;
        for (let j = Math.max(0, y - 1); j <= Math.min(h - 1, y + 1); j++) {
          for (let i = Math.max(0, x - 1); i <= Math.min(w - 1, x + 1); i++) {
            s += a[j * w + i];
            c++;
          }
        }
        b[y * w + x] = s / c;
      }
    }
    a = b;
  }
  return a;
}

/**
 * The region of the work-image `label` over `roi` at natural size: inside and outside as they
 * are, and the pixels along the edge anti-aliased by where their colour lies between the region's
 * colour and the surroundings' just either side.
 */
export function upscaleRegion(work: WorkImage, pixels: PixelBuffer, roi: Rect, label: Uint8Array, enhance: boolean): SelectionMask {
  const { sourceWidth: W, sourceHeight: H, scale, rgb, width: ww } = work;
  const { x: rx, y: ry, width: rw, height: rh } = roi;
  let soft: Float32Array = Float32Array.from(label);
  if (enhance) {
    // Smooth the blocky outline, then make it hard again where it is clearly in or out.
    soft = boxBlur(soft, rw, rh, 2);
    for (let i = 0; i < soft.length; i++) soft[i] = Math.min(1, Math.max(0, (soft[i] - 0.5) * 3 + 0.5));
  }
  const X0 = Math.max(0, Math.floor(rx / scale));
  const Y0 = Math.max(0, Math.floor(ry / scale));
  const X1 = Math.min(W, Math.ceil((rx + rw) / scale));
  const Y1 = Math.min(H, Math.ceil((ry + rh) / scale));
  const RW = X1 - X0;
  const RH = Y1 - Y0;
  const out = new Uint8Array(RW * RH);
  const at = (x: number, y: number) => soft[Math.min(rh - 1, Math.max(0, y)) * rw + Math.min(rw - 1, Math.max(0, x))];
  const data = pixels.data;
  // Work-pixel column of each output column, and whether each 2 × 2 cell of the reduced region is
  // all in (1), all out (0) or on the edge (2): most of a large region is filled a run at a time.
  const colOf = new Int32Array(RW);
  const fxOf = new Float32Array(RW);
  for (let X = 0; X < RW; X++) {
    const u = (X0 + X + 0.5) * scale - 0.5 - rx;
    colOf[X] = Math.floor(u);
    fxOf[X] = u - colOf[X];
  }
  const cellState = (i: number, j: number) => {
    const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
    if (a === 1 && b === 1 && c === 1 && d === 1) return 1;
    if (a === 0 && b === 0 && c === 0 && d === 0) return 0;
    return 2;
  };
  for (let Y = 0; Y < RH; Y++) {
    const v = (Y0 + Y + 0.5) * scale - 0.5 - ry;
    const j = Math.floor(v);
    const fy = v - j;
    for (let X = 0; X < RW; X++) {
      const i = colOf[X];
      const state = cellState(i, j);
      if (state !== 2) {
        let end = X + 1;
        while (end < RW && colOf[end] === i) end++;
        if (state === 1) out.fill(255, Y * RW + X, Y * RW + end);
        X = end - 1;
        continue;
      }
      const fx = fxOf[X];
      const m = (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy;
      if (m <= 0.001 || m >= 0.999) {
        out[Y * RW + X] = m >= 0.999 ? 255 : 0;
        continue;
      }
      // On the edge: mean colours of the region and of the rest in the 4 × 4 work pixels around.
      let fr = 0, fg = 0, fb = 0, fn = 0, br = 0, bg = 0, bb = 0, bn = 0;
      for (let jj = j - 1; jj <= j + 2; jj++) {
        for (let ii = i - 1; ii <= i + 2; ii++) {
          if (ii < 0 || jj < 0 || ii >= rw || jj >= rh) continue;
          const k = ((ry + jj) * ww + rx + ii) * 3;
          if (soft[jj * rw + ii] >= 0.5) {
            fr += rgb[k]; fg += rgb[k + 1]; fb += rgb[k + 2]; fn++;
          } else {
            br += rgb[k]; bg += rgb[k + 1]; bb += rgb[k + 2]; bn++;
          }
        }
      }
      let alpha = m;
      if (fn && bn) {
        fr /= fn; fg /= fn; fb /= fn; br /= bn; bg /= bn; bb /= bn;
        const dr = fr - br, dg = fg - bg, db = fb - bb;
        const len2 = dr * dr + dg * dg + db * db;
        if (len2 > 400) {
          const p = ((Y0 + Y) * W + X0 + X) * 4;
          const a = data[p + 3] / 255;
          const cr = data[p] * a + 255 * (1 - a) - br;
          const cg = data[p + 1] * a + 255 * (1 - a) - bg;
          const cb = data[p + 2] * a + 255 * (1 - a) - bb;
          // The colour's position between the two, kept near the scaled-up edge.
          const proj = Math.min(1, Math.max(0, (cr * dr + cg * dg + cb * db) / len2));
          alpha = Math.min(1, Math.max(0, proj * 0.75 + m * 0.25));
        } else alpha = Math.min(1, Math.max(0, (m - 0.5) * 2 + 0.5));
      }
      out[Y * RW + X] = Math.round(alpha * 255);
    }
  }
  return selectionFromRegion(W, H, { x: X0, y: Y0, width: RW, height: RH }, out);
}

