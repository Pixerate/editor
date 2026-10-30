/**
 * Helpers for the masks Focus Area and Select Sky compute on the reduced copy: its luminance and
 * colour planes (the guide for `guidedFilterColor`, which fits a rough mask to the image's edges)
 * and scaling a soft mask back up to the image.
 */

import { selectionFromRegion, type SelectionMask } from '../mask';
import type { WorkImage } from './work';

/** The work image as three planes of 0..1 values, the guide `guidedFilterColor` takes. */
export function workPlanes(work: WorkImage): [Float32Array, Float32Array, Float32Array] {
  const n = work.width * work.height;
  const planes: [Float32Array, Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) planes[c][i] = work.rgb[i * 3 + c] / 255;
  return planes;
}

/** The work image's luminance, 0..1. */
export function workLuma(work: WorkImage): Float32Array {
  const n = work.width * work.height;
  const out = new Float32Array(n);
  const { rgb } = work;
  for (let i = 0; i < n; i++) out[i] = (0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]) / 255;
  return out;
}

/** A soft mask over the whole work image (0..1), scaled up bilinearly to a selection of the image. */
export function softMaskToSelection(work: WorkImage, mask: Float32Array): SelectionMask {
  const { sourceWidth: W, sourceHeight: H, width: w, height: h, scale } = work;
  const out = new Uint8Array(W * H);
  const col = new Int32Array(W);
  const fx = new Float32Array(W);
  for (let X = 0; X < W; X++) {
    const u = Math.min(w - 1, Math.max(0, (X + 0.5) * scale - 0.5));
    col[X] = Math.min(w - 2, Math.floor(u));
    fx[X] = u - col[X];
    if (w === 1) {
      col[X] = 0;
      fx[X] = 0;
    }
  }
  for (let Y = 0; Y < H; Y++) {
    const v = Math.min(h - 1, Math.max(0, (Y + 0.5) * scale - 0.5));
    const j = h === 1 ? 0 : Math.min(h - 2, Math.floor(v));
    const fy = h === 1 ? 0 : v - j;
    const r0 = j * w;
    const r1 = h === 1 ? r0 : r0 + w;
    for (let X = 0; X < W; X++) {
      const i = col[X];
      const i1 = w === 1 ? i : i + 1;
      const t = fx[X];
      const m = (mask[r0 + i] * (1 - t) + mask[r0 + i1] * t) * (1 - fy) + (mask[r1 + i] * (1 - t) + mask[r1 + i1] * t) * fy;
      out[Y * W + X] = Math.round(Math.min(1, Math.max(0, m)) * 255);
    }
  }
  return selectionFromRegion(W, H, { x: 0, y: 0, width: W, height: H }, out);
}
