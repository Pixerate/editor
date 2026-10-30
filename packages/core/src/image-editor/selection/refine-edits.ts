/**
 * The Select and Mask workspace's strokes as plain data, so an agent can send what a person
 * paints: Quick Selection strokes (grow to the region's edges), Brush strokes (paint the
 * selection in or out directly) and Refine Edge Brush strokes (mark where the edge should be
 * re-estimated from the image, e.g. over hair).
 */

import type { ImagePoint } from '../types';
import { combineSelections, createSelectionMask, selectionFromRegion, type PixelBuffer, type SelectionMask } from './mask';
import { quickSelectStroke } from './segment/quick';

/** One stroke in the workspace, in natural image pixels. */
export type RefineEdit =
  | { kind: 'quick-select'; points: ImagePoint[]; size?: number; mode?: 'add' | 'subtract' }
  | { kind: 'brush'; points: ImagePoint[]; size?: number; mode?: 'add' | 'subtract'; hardness?: number }
  | { kind: 'refine-brush'; points: ImagePoint[]; size?: number };

export const REFINE_EDIT_KINDS = ['quick-select', 'brush', 'refine-brush'] as const;

/**
 * Coverage of a round brush of diameter `size` dragged along `points` (one point is a dab), over
 * a `width × height` image. `hardness` 0..1 (default 1): the solid share of the radius; the rest
 * fades out. The edge is anti-aliased either way.
 */
export function brushStrokeMask(width: number, height: number, points: readonly ImagePoint[], size: number, hardness = 1): SelectionMask {
  const r = Math.max(0.5, size / 2);
  const solid = r * Math.min(1, Math.max(0, hardness));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const bx = Math.max(0, Math.floor(x0 - r - 1));
  const by = Math.max(0, Math.floor(y0 - r - 1));
  const bw = Math.min(width, Math.ceil(x1 + r + 1)) - bx;
  const bh = Math.min(height, Math.ceil(y1 + r + 1)) - by;
  if (!(bw > 0 && bh > 0)) return createSelectionMask(width, height);
  const out = new Uint8Array(bw * bh);
  const segs = points.length === 1 ? [[points[0], points[0]]] : points.slice(1).map((p, i) => [points[i], p]);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const px = bx + x + 0.5;
      const py = by + y + 0.5;
      let d = Infinity;
      for (const [a, b] of segs) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
        d = Math.min(d, Math.hypot(px - a.x - t * dx, py - a.y - t * dy));
      }
      // Solid inside `solid`, fading to the radius, with a one-pixel anti-aliased rim.
      let v = d <= solid ? 1 : solid >= r ? 0 : 1 - (d - solid) / (r - solid);
      v = Math.min(v, Math.min(1, Math.max(0, r + 0.5 - d)));
      out[y * bw + x] = Math.round(Math.max(0, v) * 255);
    }
  }
  return selectionFromRegion(width, height, { x: bx, y: by, width: bw, height: bh }, out);
}

/**
 * Applies `edits` in order to `selection` (`null` starts empty) over `pixels` (needed for
 * Quick Selection strokes). Returns the edited selection and the Refine Edge Brush's painted
 * area (`null` when there were no such strokes), for `refineSelection`.
 */
export function applyRefineEdits(
  pixels: PixelBuffer | null,
  selection: SelectionMask | null,
  edits: readonly RefineEdit[],
  width: number,
  height: number
): { selection: SelectionMask | null; refineBrush: SelectionMask | null } {
  let sel = selection?.bounds ? selection : null;
  let band: SelectionMask | null = null;
  for (const e of edits) {
    if (!e.points.length) throw new Error(`A ${e.kind} stroke needs at least one point.`);
    if (e.kind === 'refine-brush') {
      band = combineSelections(band, brushStrokeMask(width, height, e.points, e.size ?? 40), 'add');
      continue;
    }
    const mode = e.mode ?? 'add';
    let region: SelectionMask;
    if (e.kind === 'quick-select') {
      if (!pixels) throw new Error('Quick Selection strokes need the image pixels.');
      region = quickSelectStroke(pixels, e.points, { size: e.size, selection: sel, grow: mode === 'add' });
    } else {
      region = brushStrokeMask(width, height, e.points, e.size ?? 20, e.hardness ?? 1);
    }
    sel = combineSelections(sel, region, mode);
  }
  return { selection: sel, refineBrush: band };
}
