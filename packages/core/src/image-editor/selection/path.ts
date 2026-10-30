/**
 * Selections ⇄ paths (Photoshop's Make Work Path and Make Selection): a selection's outline traced
 * into Bézier subpaths, and a path filled into a selection.
 */

import type { VectorSubpath } from '../../vector/types';
import { subpathsToBezier } from '../../vector/geometry';
import { traceField } from '../../vector/trace';
import { bezierPathToSvg } from '../../canvas/pathops/bezier';
import type { ShapeComponent, ShapeFillRule } from '../layers/model';
import { componentsCoverage, mapSubpaths } from '../layers/shape';
import { coverageToByte, createSelectionMask, selectionFromRegion, type SelectionMask } from './mask';
import { modifySelection } from './modify';

export interface SelectionToPathOptions {
  /** How far (px) the path may stray from the outline (default 0.5; Photoshop's Make Work Path tolerance). */
  tolerance?: number;
  /** 0: straight sides and sharp corners; 1: as smooth as the outline allows (default 0.5). */
  cornerRoundness?: number;
  /** Islands and holes smaller than this many square pixels are left out (default 4). */
  minArea?: number;
  /** Coverage (0..255) where the outline runs (default 128, half selected). */
  threshold?: number;
}

/**
 * The outline of a selection as closed subpaths in document pixels (holes included, so fill them
 * even-odd). Traced in the selection's bounds only; an empty selection gives none.
 */
export function selectionToSubpaths(mask: SelectionMask, options: SelectionToPathOptions = {}): VectorSubpath[] {
  const b = mask.bounds;
  if (!b) return [];
  // One pixel of margin so a shape touching its bounds still gets a closed outline.
  const x0 = Math.max(0, b.x - 1);
  const y0 = Math.max(0, b.y - 1);
  const x1 = Math.min(mask.width, b.x + b.width + 1);
  const y1 = Math.min(mask.height, b.y + b.height + 1);
  const w = x1 - x0;
  const h = y1 - y0;
  const data = mask.data;
  const field = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = (y0 + y) * mask.width + x0;
    for (let x = 0; x < w; x++) field[y * w + x] = data[row + x] / 255;
  }
  const threshold = Math.min(254, Math.max(1, options.threshold ?? 128)) / 255;
  const subpaths = traceField(field, w, h, threshold, {
    tolerance: Math.max(0.1, options.tolerance ?? 0.5),
    cornerRoundness: options.cornerRoundness ?? 0.5,
    minArea: options.minArea ?? 4,
    squareCorners: true,
  });
  return subpaths.map((sp) => mapSubpaths([sp], (p) => ({ x: p.x + x0, y: p.y + y0 }))[0]);
}

/** Subpaths as compact SVG path data (absolute, `precision` decimals). */
export function subpathsToSvgPath(subpaths: readonly VectorSubpath[], precision = 2): string {
  return bezierPathToSvg(subpathsToBezier(subpaths), { precision });
}

export interface PathToSelectionOptions {
  /** Feather radius in px applied after filling (default 0). */
  feather?: number;
  /** Soft edges (default true); false makes every pixel fully in or out. */
  antiAlias?: boolean;
  /** How overlapping subpaths fill (default nonzero). */
  fillRule?: ShapeFillRule;
}

/**
 * Make Selection: the area of `components` (document pixels, combined by their ops) over a
 * `width × height` image, computed in the path's bounds only.
 */
export function pathToSelection(components: readonly ShapeComponent[], width: number, height: number, options: PathToSelectionOptions = {}): SelectionMask {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of components) {
    for (const sp of c.subpaths) {
      for (const a of sp.anchors) {
        for (const p of [a, a.in, a.out]) {
          if (!p) continue;
          x0 = Math.min(x0, p.x);
          y0 = Math.min(y0, p.y);
          x1 = Math.max(x1, p.x);
          y1 = Math.max(y1, p.y);
        }
      }
    }
  }
  const rx0 = Math.max(0, Math.floor(x0));
  const ry0 = Math.max(0, Math.floor(y0));
  const rx1 = Math.min(width, Math.ceil(x1));
  const ry1 = Math.min(height, Math.ceil(y1));
  if (!(rx1 > rx0 && ry1 > ry0)) return createSelectionMask(width, height);
  const rect = { x: rx0, y: ry0, width: rx1 - rx0, height: ry1 - ry0 };
  const cov = componentsCoverage(components, rect, options.fillRule ?? 'nonzero');
  const hard = options.antiAlias === false;
  const bytes = new Uint8Array(cov.length);
  for (let i = 0; i < cov.length; i++) bytes[i] = hard ? (cov[i] >= 0.5 ? 255 : 0) : coverageToByte(cov[i]);
  const mask = selectionFromRegion(width, height, rect, bytes);
  const feather = options.feather ?? 0;
  return feather > 0 && mask.bounds ? modifySelection(mask, 'feather', feather) : mask;
}
