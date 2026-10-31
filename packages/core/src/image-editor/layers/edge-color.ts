/**
 * Edge colour on a layer's soft edge (`LayerEdgeColor`): decontamination and despill, run over the
 * canvas by the compositor from the layer's own pixels and its mask, so nothing is baked. The live
 * edge cast (`ambient`) needs what is behind the layer and runs in the compositor's blend step.
 */

import type { LayerEdgeColor, RasterMask } from '../../raster/layers';
import { readRegion } from '../../raster/surface';
import { gaussianBlur } from '../../raster/blur';
import { boxMean, decontaminateColors } from '../selection/refine';

/** How far (px) the old background's colour is looked for around the edge. */
export const EDGE_COLOR_RADIUS = 8;

/** True when decontamination or despill is on (they need the layer's mask). */
export function hasEdgeUnmix(edge: LayerEdgeColor | undefined): boolean {
  return Boolean(edge && ((edge.decontaminate ?? 0) > 0 || (edge.despill ?? 0) > 0));
}

/**
 * A mask's coverage (0..255) over the canvas, `width × height`, for a layer at `offset`: the
 * painted mask with its feather (density only changes how much shows, not the matte).
 */
export function maskCoverageOverCanvas(mask: RasterMask, ox: number, oy: number, width: number, height: number): Uint8ClampedArray {
  const bytes = readRegion(mask.surface, { x: -ox, y: -oy, width, height });
  const feather = mask.feather ?? 0;
  if (!(feather > 0)) return new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.length);
  const v = new Float32Array(bytes.length);
  for (let i = 0; i < v.length; i++) v[i] = bytes[i];
  const blurred = gaussianBlur(v, width, height, feather, 'clamp') as Float32Array;
  return Uint8ClampedArray.from(blurred);
}

/** True when a coverage has a soft band (some pixels partly covered). */
export function hasSoftBand(coverage: ArrayLike<number>): boolean {
  for (let i = 0; i < coverage.length; i++) if (coverage[i] > 5 && coverage[i] < 250) return true;
  return false;
}

/**
 * Despill: along a soft edge, takes out (by `amount`, 0..1) the part of each pixel's colour that
 * points the way of the old background's hue (its local mean, from what is fully outside within
 * `radius`). Luminance is kept, pixels fully in or out are unchanged, and the outer edge (more
 * background) gets the most. It does not remove light that bounced onto the subject itself.
 * Works in place on RGBA `rgba` with `coverage` (0..255) over the same `w × h`.
 */
export function despillEdge(rgba: Uint8ClampedArray, coverage: ArrayLike<number>, w: number, h: number, amount: number, radius = EDGE_COLOR_RADIUS): void {
  const k = Math.min(1, Math.max(0, amount));
  if (!(k > 0)) return;
  const n = w * h;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = coverage[i] <= 5 ? 1 : 0;
  const weight = boxMean(out, w, h, radius);
  const mean = [0, 1, 2].map((c) => {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = rgba[i * 4 + c] * out[i];
    return boxMean(v, w, h, radius);
  });
  const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  for (let i = 0; i < n; i++) {
    const c = coverage[i];
    if (c <= 5 || c >= 250 || weight[i] <= 1e-6) continue;
    const br = mean[0][i] / weight[i];
    const bg = mean[1][i] / weight[i];
    const bb = mean[2][i] / weight[i];
    const bl = luma(br, bg, bb);
    let ux = br - bl;
    let uy = bg - bl;
    let uz = bb - bl;
    const len = Math.hypot(ux, uy, uz);
    if (len < 4) continue; // A grey background has no hue to spill.
    ux /= len;
    uy /= len;
    uz /= len;
    const p = i * 4;
    const l = luma(rgba[p], rgba[p + 1], rgba[p + 2]);
    const along = (rgba[p] - l) * ux + (rgba[p + 1] - l) * uy + (rgba[p + 2] - l) * uz;
    if (along <= 0) continue;
    const s = k * Math.min(1, 2 * (1 - c / 255)) * along;
    rgba[p] -= s * ux;
    rgba[p + 1] -= s * uy;
    rgba[p + 2] -= s * uz;
  }
}

/** Decontamination, then despill, of canvas RGBA `rgba` (`w × h`) in place, given the mask's coverage. */
export function applyEdgeUnmix(rgba: Uint8ClampedArray, coverage: ArrayLike<number>, w: number, h: number, edge: LayerEdgeColor): void {
  const d = edge.decontaminate ?? 0;
  if (d > 0) rgba.set(decontaminateColors(rgba, coverage, w, h, d, EDGE_COLOR_RADIUS));
  despillEdge(rgba, coverage, w, h, edge.despill ?? 0);
}
