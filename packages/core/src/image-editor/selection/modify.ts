// Portions ported from photocraft/crates/algo/src/selection.rs, photocraft/crates/algo/src/selection/distance.rs, photocraft/crates/algo/src/selection_blur.rs and photocraft/crates/algo/src/matting.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import { createSelectionMask, coverageToByte, selectionToCoverage, type SelectionMask } from './mask';
import { gaussianBlur } from '../../raster/blur';

export { gaussianBlur, DIRECT_GAUSSIAN_MAX_SIGMA } from '../../raster/blur';

/** Distance reported for every pixel when there is no seed at all. */
export const EMPTY_DISTANCE = 1e10;

/**
 * Exact Euclidean distance from every pixel centre to the nearest seed pixel centre (row-major
 * `inside`, non-zero = seed): nearest seeds along columns, then the lower envelope of parabolas
 * along rows (Felzenszwalb & Huttenlocher). Linear in the pixel count.
 */
export function distanceTransform(inside: ArrayLike<number | boolean>, width: number, height: number): Float32Array {
  const n = width * height;
  const out = new Float32Array(n);
  let any = false;
  let all = true;
  for (let i = 0; i < n; i++) {
    if (inside[i]) any = true;
    else all = false;
  }
  if (!any) return out.fill(EMPTY_DISTANCE);
  if (all) return out;
  const NONE = 0xffffffff;
  // Vertical distance to the nearest seed in the same column.
  const vertical = new Uint32Array(n).fill(NONE);
  for (let x = 0; x < width; x++) {
    let nearest = -1;
    for (let y = 0; y < height; y++) {
      const i = y * width + x;
      if (inside[i]) nearest = y;
      if (nearest >= 0) vertical[i] = y - nearest;
    }
    nearest = -1;
    for (let y = height - 1; y >= 0; y--) {
      const i = y * width + x;
      if (vertical[i] === 0) nearest = y;
      if (nearest >= 0) vertical[i] = Math.min(vertical[i], nearest - y);
    }
  }
  const sites = new Int32Array(width);
  const starts = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    for (let q = 0; q < width; q++) {
      const dq = vertical[row + q];
      if (dq === NONE) continue;
      const fq = dq * dq;
      let start = -Infinity;
      while (count > 0) {
        const p = sites[count - 1];
        const dp = vertical[row + p];
        start = (fq - dp * dp) / (2 * (q - p)) + (q + p) * 0.5;
        if (start > starts[count - 1]) break;
        count--;
      }
      if (count === 0) start = -Infinity;
      sites[count] = q;
      starts[count] = start;
      count++;
    }
    if (count === 0) {
      out.fill(EMPTY_DISTANCE, row, row + width);
      continue;
    }
    let k = 0;
    for (let x = 0; x < width; x++) {
      while (k + 1 < count && starts[k + 1] < x) k++;
      const site = sites[k];
      const dx = x - site;
      const dv = vertical[row + site];
      out[row + x] = Math.sqrt(dx * dx + dv * dv);
    }
  }
  return out;
}

function thresholdInside(m: ArrayLike<number>, threshold = 0.5): Uint8Array {
  const out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) out[i] = m[i] >= threshold ? 1 : 0;
  return out;
}

/** Grows coverage (0..1) by `r` pixels: covered when the nearest selected centre is ≤ r away (fractional r → partial). */
export function expandCoverage(m: ArrayLike<number>, w: number, h: number, r: number): Float32Array {
  const d = distanceTransform(thresholdInside(m), w, h);
  const out = new Float32Array(m.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(m[i], Math.min(1, Math.max(0, r + 1 - d[i])));
  return out;
}

/** Shrinks coverage by `r` pixels (expands the inverse). */
export function contractCoverage(m: ArrayLike<number>, w: number, h: number, r: number): Float32Array {
  const inv = new Float32Array(m.length);
  for (let i = 0; i < inv.length; i++) inv[i] = 1 - m[i];
  const e = expandCoverage(inv, w, h, r);
  for (let i = 0; i < e.length; i++) e[i] = 1 - e[i];
  return e;
}

/**
 * Select › Modify › Border: a soft band `2r` wide centred on the edge. A pixel `D` away (centre
 * to centre) from the nearest pixel on the other side of the edge is selected `1 − (D − 1) / r`.
 */
export function borderCoverage(m: ArrayLike<number>, w: number, h: number, r: number): Float32Array {
  const inside = thresholdInside(m);
  const outside = new Uint8Array(inside.length);
  for (let i = 0; i < inside.length; i++) outside[i] = inside[i] ? 0 : 1;
  const out = new Float32Array(m.length);
  if (!(r > 0)) return out;
  const toInside = distanceTransform(inside, w, h);
  const toOutside = distanceTransform(outside, w, h);
  for (let i = 0; i < out.length; i++) {
    const d = inside[i] ? toOutside[i] : toInside[i];
    out[i] = Math.min(1, Math.max(0, 1 - (d - 1) / r));
  }
  return out;
}

/** Box average of radius `r` along one line, edges replicated, via a running sum (O(1) per sample). */
function boxLineReplicate(src: Float32Array, srcOff: number, stride: number, len: number, r: number, dst: Float32Array) {
  const at = (i: number) => src[srcOff + Math.min(len - 1, Math.max(0, i)) * stride];
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += at(i);
  const k = 2 * r + 1;
  for (let i = 0; i < len; i++) {
    dst[i] = sum / k;
    sum += at(i + r + 1) - at(i - r);
  }
}

/**
 * Select › Modify › Smooth: box average of radius `round(r)` with replicated edges, then
 * re-thresholded at ½ — specks drop, corners round, straight edges stay hard.
 */
export function smoothCoverage(m: ArrayLike<number>, w: number, h: number, r: number): Float32Array {
  const rr = Number.isFinite(r) ? Math.max(0, Math.round(r)) : 0;
  const src = Float32Array.from(m);
  const tmp = new Float32Array(src.length);
  const line = new Float32Array(Math.max(w, h));
  if (rr > 0) {
    for (let y = 0; y < h; y++) {
      boxLineReplicate(src, y * w, 1, w, rr, line);
      tmp.set(line.subarray(0, w), y * w);
    }
    for (let x = 0; x < w; x++) {
      boxLineReplicate(tmp, x, w, h, rr, line);
      for (let y = 0; y < h; y++) src[y * w + x] = line[y];
    }
  }
  for (let i = 0; i < src.length; i++) src[i] = src[i] >= 0.5 ? 1 : 0;
  return src;
}


/** Select › Modify › Feather: Gaussian blur with σ = radius (as Photoshop), zero beyond the image. */
export function featherCoverage(m: ArrayLike<number>, w: number, h: number, radius: number): Float32Array {
  const out = gaussianBlur(m, w, h, Number.isFinite(radius) ? Math.max(0, radius) : 0, 'zero');
  for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) < 1e-7) out[i] = 0;
  return out;
}

/**
 * Running max (or min) over a window of radius `r` along one line (edge-clipped), van Herk /
 * Gil–Werman: about three comparisons per sample whatever the radius.
 */
function runningExtreme(src: Float32Array, off: number, stride: number, len: number, r: number, max: boolean, g: Float32Array, hb: Float32Array, dst: Float32Array) {
  const k = 2 * r + 1;
  const pick = max ? (a: number, b: number) => (a > b ? a : b) : (a: number, b: number) => (a < b ? a : b);
  const fill = max ? -Infinity : Infinity;
  // Padded line: r fills on each side.
  const plen = len + 2 * r;
  const at = (i: number) => (i < r || i >= r + len ? fill : src[off + (i - r) * stride]);
  for (let start = 0; start < plen; start += k) {
    const end = Math.min(plen, start + k);
    g[start] = at(start);
    for (let i = start + 1; i < end; i++) g[i] = pick(g[i - 1], at(i));
    hb[end - 1] = at(end - 1);
    for (let i = end - 2; i >= start; i--) hb[i] = pick(hb[i + 1], at(i));
  }
  for (let i = 0; i < len; i++) {
    // Window over padded indices i .. i + 2r.
    const a = hb[i];
    const b = g[i + 2 * r];
    dst[i] = pick(a, b);
  }
}

/** Grey dilation (`grow`) or erosion with a square of radius `r`, separable, O(1) per pixel. */
export function greyMorphology(src: ArrayLike<number>, w: number, h: number, r: number, grow: boolean): Float32Array {
  const out = Float32Array.from(src);
  if (r <= 0) return out;
  const n = Math.max(w, h);
  const g = new Float32Array(n + 2 * r);
  const hb = new Float32Array(n + 2 * r);
  const line = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    runningExtreme(out, y * w, 1, w, r, grow, g, hb, line);
    out.set(line.subarray(0, w), y * w);
  }
  for (let x = 0; x < w; x++) {
    runningExtreme(out, x, w, h, r, grow, g, hb, line);
    for (let y = 0; y < h; y++) out[y * w + x] = line[y];
  }
  return out;
}

/**
 * Grows (positive) or shrinks (negative) soft coverage by a fractional distance: whole pixels
 * use one morphology, the remainder blends with the next pixel, so 0.3 px differs from 1 px.
 */
export function shiftCoverage(src: ArrayLike<number>, w: number, h: number, amount: number): Float32Array {
  const mag = Math.abs(amount);
  if (!Number.isFinite(mag) || mag < 1e-4) return Float32Array.from(src);
  const grow = amount > 0;
  const whole = Math.floor(mag);
  const frac = mag - whole;
  if (frac < 1e-4) return greyMorphology(src, w, h, whole, grow);
  const lo = whole === 0 ? Float32Array.from(src) : greyMorphology(src, w, h, whole, grow);
  const hi = greyMorphology(src, w, h, whole + 1, grow);
  for (let i = 0; i < lo.length; i++) lo[i] += (hi[i] - lo[i]) * frac;
  return lo;
}

// ---------------------------------------------------------------------------
// Selection-level wrappers
// ---------------------------------------------------------------------------

export type SelectionModifyOp = 'grow' | 'shrink' | 'feather' | 'border' | 'smooth';

export const SELECTION_MODIFY_OPS: readonly SelectionModifyOp[] = ['grow', 'shrink', 'feather', 'border', 'smooth'];

function wrap(mask: SelectionMask, coverage: Float32Array): SelectionMask {
  const out = new Uint8Array(coverage.length);
  for (let i = 0; i < out.length; i++) out[i] = coverageToByte(coverage[i]);
  return createSelectionMask(mask.width, mask.height, out);
}

/** Select › Modify (grow = Expand, shrink = Contract, feather, border, smooth) by `radius` pixels. */
export function modifySelection(mask: SelectionMask, op: SelectionModifyOp, radius: number): SelectionMask {
  const r = Number.isFinite(radius) ? Math.max(0, radius) : 0;
  if (r === 0 && op !== 'border') return mask;
  const m = selectionToCoverage(mask);
  const { width: w, height: h } = mask;
  switch (op) {
    case 'grow':
      return wrap(mask, expandCoverage(m, w, h, r));
    case 'shrink':
      return wrap(mask, contractCoverage(m, w, h, r));
    case 'feather':
      return wrap(mask, featherCoverage(m, w, h, r));
    case 'border':
      return wrap(mask, borderCoverage(m, w, h, r));
    case 'smooth':
      return wrap(mask, smoothCoverage(m, w, h, r));
    default:
      throw new Error(`Unknown selection modification "${op as string}"`);
  }
}
