// Portions ported from photocraft/crates/algo/src/matting.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import type { CropBox } from '../types';
import { createSelectionMask, coverageToByte, type PixelBuffer, type SelectionMask } from './mask';
import { distanceTransform, gaussianBlur, greyMorphology, shiftCoverage } from './modify';

/**
 * Refine Edge / Select and Mask parameters (Photoshop's units). Refinement is edge-aware: within
 * `radius` pixels of the mask's edge the coverage is re-estimated from the image with a colour
 * guided filter (He et al.), so a coarse or misaligned mask (e.g. an AI segmentation) follows
 * the real edges of the image.
 */
export interface RefineEdgeParams {
  /** Edge-detection band radius in pixels (0 = no edge detection). */
  radius?: number;
  /** Narrow the band where the image edge is sharp (hair stays soft, hard edges stay hard). */
  smartRadius?: boolean;
  /** 0..100: rounds jagged edges. */
  smooth?: number;
  /** Pixels of Gaussian softening. */
  feather?: number;
  /** 0..100: hardens soft edges. */
  contrast?: number;
  /** −100..100: moves the edge out (positive) or in; 100 % is `max(radius, 4)` pixels. */
  shiftEdge?: number;
}

export const DEFAULT_REFINE_EDGE_PARAMS: Required<RefineEdgeParams> = {
  radius: 0,
  smartRadius: false,
  smooth: 0,
  feather: 0,
  contrast: 0,
  shiftEdge: 0,
};

/** Guided-filter regulariser (colour guide, samples in 0..1). */
export const GUIDED_FILTER_EPS = 1e-4;

const fin = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Clamped, complete parameters. */
export function normalizeRefineEdgeParams(p: RefineEdgeParams = {}): Required<RefineEdgeParams> {
  return {
    radius: Math.min(250, Math.max(0, fin(p.radius, 0))),
    smartRadius: p.smartRadius === true,
    smooth: Math.min(100, Math.max(0, fin(p.smooth, 0))),
    feather: Math.min(1000, Math.max(0, fin(p.feather, 0))),
    contrast: Math.min(100, Math.max(0, fin(p.contrast, 0))),
    shiftEdge: Math.min(100, Math.max(-100, fin(p.shiftEdge, 0))),
  };
}

const gfRadius = (p: Required<RefineEdgeParams>) => Math.min(64, Math.max(1, Math.ceil(p.radius)));
const smoothSigma = (p: Required<RefineEdgeParams>) => (p.smooth / 100) * 4;
const featherSigma = (p: Required<RefineEdgeParams>) => p.feather / 2;
function shiftAmount(p: Required<RefineEdgeParams>): number {
  const px = (p.shiftEdge / 100) * Math.max(p.radius, 4);
  return Number.isFinite(px) ? Math.min(64, Math.max(-64, px)) : 0;
}

/** Pixels around the mask's content that refinement can read or write. */
export function refineEdgeHalo(params: RefineEdgeParams = {}): number {
  const p = normalizeRefineEdgeParams(params);
  const g = gfRadius(p);
  const edge = p.radius > 0 ? Math.max(Math.ceil(p.radius), 2 * g + (p.smartRadius ? g + 1 : 0)) : 0;
  return (
    edge +
    Math.ceil(3 * smoothSigma(p)) +
    Math.ceil(3 * featherSigma(p)) +
    Math.ceil(Math.abs(shiftAmount(p))) +
    2
  );
}

/** Box mean of radius `r` (window clipped to the image, divided by its pixel count). O(1) per pixel. */
export function boxMean(src: ArrayLike<number>, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const pre = new Float64Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + src[row + x];
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - r);
      const hi = Math.min(w, x + r + 1);
      tmp[row + x] = (pre[hi] - pre[lo]) / (hi - lo);
    }
  }
  const out = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - r);
      const hi = Math.min(h, y + r + 1);
      out[y * w + x] = (pre[hi] - pre[lo]) / (hi - lo);
    }
  }
  return out;
}

/**
 * Guided filter with a colour guide (He et al., Eq. 19–21: `a_k = (Σ_k + εU)⁻¹ cov_k(I, p)`):
 * filters `p` so that it is locally a linear function of the guide's colour, which makes the
 * output's edges follow the guide's edges. `guide` is three planes of 0..1 values.
 */
export function guidedFilterColor(
  guide: readonly [Float32Array, Float32Array, Float32Array],
  p: Float32Array,
  w: number,
  h: number,
  r: number,
  eps = GUIDED_FILTER_EPS
): Float32Array {
  const n = w * h;
  const [c0, c1, c2] = guide;
  const prod = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) o[i] = a[i] * b[i];
    return o;
  };
  const m0 = boxMean(c0, w, h, r);
  const m1 = boxMean(c1, w, h, r);
  const m2 = boxMean(c2, w, h, r);
  const mp = boxMean(p, w, h, r);
  const mip0 = boxMean(prod(c0, p), w, h, r);
  const mip1 = boxMean(prod(c1, p), w, h, r);
  const mip2 = boxMean(prod(c2, p), w, h, r);
  const s00 = boxMean(prod(c0, c0), w, h, r);
  const s01 = boxMean(prod(c0, c1), w, h, r);
  const s02 = boxMean(prod(c0, c2), w, h, r);
  const s11 = boxMean(prod(c1, c1), w, h, r);
  const s12 = boxMean(prod(c1, c2), w, h, r);
  const s22 = boxMean(prod(c2, c2), w, h, r);
  const a0 = new Float32Array(n);
  const a1 = new Float32Array(n);
  const a2 = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u0 = m0[i], u1 = m1[i], u2 = m2[i], up = mp[i];
    const rr = s00[i] - u0 * u0 + eps;
    const rg = s01[i] - u0 * u1;
    const rb = s02[i] - u0 * u2;
    const gg = s11[i] - u1 * u1 + eps;
    const gb = s12[i] - u1 * u2;
    const bb = s22[i] - u2 * u2 + eps;
    const v0 = mip0[i] - u0 * up;
    const v1 = mip1[i] - u1 * up;
    const v2 = mip2[i] - u2 * up;
    // Inverse of the symmetric 3×3 matrix.
    const i00 = gg * bb - gb * gb;
    const i01 = gb * rb - rg * bb;
    const i02 = rg * gb - gg * rb;
    const i11 = rr * bb - rb * rb;
    const i12 = rb * rg - rr * gb;
    const i22 = rr * gg - rg * rg;
    const det = rr * i00 + rg * i01 + rb * i02;
    let x0 = 0, x1 = 0, x2 = 0;
    if (Math.abs(det) >= 1e-30) {
      x0 = (i00 * v0 + i01 * v1 + i02 * v2) / det;
      x1 = (i01 * v0 + i11 * v1 + i12 * v2) / det;
      x2 = (i02 * v0 + i12 * v1 + i22 * v2) / det;
    }
    a0[i] = x0;
    a1[i] = x1;
    a2[i] = x2;
    b[i] = up - x0 * u0 - x1 * u1 - x2 * u2;
  }
  const ma0 = boxMean(a0, w, h, r);
  const ma1 = boxMean(a1, w, h, r);
  const ma2 = boxMean(a2, w, h, r);
  const mb = boxMean(b, w, h, r);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ma0[i] * c0[i] + ma1[i] * c1[i] + ma2[i] * c2[i] + mb[i];
  return out;
}

/**
 * Per-pixel transition width (pixels) of the guide's luminance: local range over local maximum
 * gradient in a window of radius `r` (a sharp step gives about 2, a ramp of width L about L).
 */
export function edgeWidth(guide: readonly [Float32Array, Float32Array, Float32Array], w: number, h: number, r: number): Float32Array {
  const n = w * h;
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = 0.299 * guide[0][i] + 0.587 * guide[1][i] + 0.114 * guide[2][i];
  const g = new Float32Array(n);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const gx = (y[yy * w + Math.min(w - 1, xx + 1)] - y[yy * w + Math.max(0, xx - 1)]) / 2;
      const gy = (y[Math.min(h - 1, yy + 1) * w + xx] - y[Math.max(0, yy - 1) * w + xx]) / 2;
      g[yy * w + xx] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  const gm = greyMorphology(g, w, h, r, true);
  const hi = greyMorphology(y, w, h, r, true);
  const lo = greyMorphology(y, w, h, r, false);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (hi[i] - lo[i]) / Math.max(gm[i], 1e-4);
  return out;
}

/**
 * Refines soft coverage `m` (`w × h`, 0..1) with `guide` (three 0..1 planes, required when
 * `radius > 0`): edge-aware re-estimation in a band around the edge, then smooth, feather,
 * contrast and shift edge, in that order.
 */
export function refineCoverage(
  guide: readonly [Float32Array, Float32Array, Float32Array] | null,
  m: Float32Array,
  w: number,
  h: number,
  params: RefineEdgeParams = {}
): Float32Array {
  const p = normalizeRefineEdgeParams(params);
  let a: Float32Array = Float32Array.from(m);
  if (p.radius > 0 && guide) {
    const n = w * h;
    const boundary = new Uint8Array(n);
    let any = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const v = m[i] >= 0.5;
        const diff =
          (x > 0 && m[i - 1] >= 0.5 !== v) ||
          (x + 1 < w && m[i + 1] >= 0.5 !== v) ||
          (y > 0 && m[i - w] >= 0.5 !== v) ||
          (y + 1 < h && m[i + w] >= 0.5 !== v);
        if (diff) {
          boundary[i] = 1;
          any = true;
        }
      }
    }
    if (any) {
      const dist = distanceTransform(boundary, w, h);
      const r = gfRadius(p);
      const q = guidedFilterColor(guide, m, w, h, r);
      const widths = p.smartRadius ? edgeWidth(guide, w, h, r) : null;
      for (let i = 0; i < n; i++) {
        const reff = widths ? Math.min(Math.max(p.radius, 1.5), Math.max(1.5, widths[i])) : p.radius;
        const wgt = Math.min(1, Math.max(0, reff + 1 - dist[i]));
        if (wgt > 0) {
          const qi = Math.min(1, Math.max(0, q[i]));
          a[i] = m[i] + (qi - m[i]) * wgt;
        }
      }
    }
  }
  const ss = smoothSigma(p);
  if (ss >= 0.3) {
    a = gaussianBlur(a, w, h, ss, 'clamp');
    const gain = 1 + ss;
    for (let i = 0; i < a.length; i++) a[i] = Math.min(1, Math.max(0, (a[i] - 0.5) * gain + 0.5));
  }
  a = gaussianBlur(a, w, h, featherSigma(p), 'clamp');
  if (p.contrast > 0) {
    const gain = 1 / (1 - (0.99 * p.contrast) / 100);
    for (let i = 0; i < a.length; i++) a[i] = Math.min(1, Math.max(0, (a[i] - 0.5) * gain + 0.5));
  }
  const amount = shiftAmount(p);
  if (Math.abs(amount) >= 1e-4) a = shiftCoverage(a, w, h, amount);
  return a;
}

/** Three 0..1 planes of a window of an RGBA buffer. */
export function guidePlanes(pixels: PixelBuffer, win?: CropBox): [Float32Array, Float32Array, Float32Array] {
  const box = win ?? { x: 0, y: 0, width: pixels.width, height: pixels.height };
  const n = box.width * box.height;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  const d = pixels.data;
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const i = y * box.width + x;
      const p = ((box.y + y) * pixels.width + box.x + x) * 4;
      r[i] = d[p] / 255;
      g[i] = d[p + 1] / 255;
      b[i] = d[p + 2] / 255;
    }
  }
  return [r, g, b];
}

/**
 * Refine Edge on a selection (or a coarse AI mask loaded as one) against `pixels` (the image,
 * same size). Work is confined to the mask's bounds grown by {@link refineEdgeHalo}, so a small
 * selection on a large image stays cheap.
 */
export function refineSelection(pixels: PixelBuffer | null, mask: SelectionMask, params: RefineEdgeParams = {}): SelectionMask {
  const p = normalizeRefineEdgeParams(params);
  if (pixels && (pixels.width !== mask.width || pixels.height !== mask.height)) {
    throw new Error('Refine Edge needs pixels the size of the selection');
  }
  if (!mask.bounds) return mask;
  const halo = refineEdgeHalo(p);
  // The guided filter reads 2r beyond the band; the window must hold that too.
  const x0 = Math.max(0, mask.bounds.x - halo);
  const y0 = Math.max(0, mask.bounds.y - halo);
  const x1 = Math.min(mask.width, mask.bounds.x + mask.bounds.width + halo);
  const y1 = Math.min(mask.height, mask.bounds.y + mask.bounds.height + halo);
  const ww = x1 - x0;
  const wh = y1 - y0;
  const m = new Float32Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    const src = (y0 + y) * mask.width + x0;
    for (let x = 0; x < ww; x++) m[y * ww + x] = mask.data[src + x] / 255;
  }
  const guide = pixels && p.radius > 0 ? guidePlanes(pixels, { x: x0, y: y0, width: ww, height: wh }) : null;
  const refined = refineCoverage(guide, m, ww, wh, p);
  const out = new Uint8Array(mask.width * mask.height);
  for (let y = 0; y < wh; y++) {
    const dst = (y0 + y) * mask.width + x0;
    for (let x = 0; x < ww; x++) out[dst + x] = coverageToByte(refined[y * ww + x]);
  }
  return createSelectionMask(mask.width, mask.height, out);
}
