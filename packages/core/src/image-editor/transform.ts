/**
 * Free Transform geometry for the image editor, as pure functions both the UI bindings and the
 * agent tools use: a transform is the frame being transformed (`box`, document pixels), where its
 * four corners land (`corners`, TL, TR, BR, BL) and an optional warp mesh over the box. Scale,
 * rotate, skew and flips keep the corners a parallelogram (an affine map); Distort and Perspective
 * move them freely (a projective map); Warp bends the box through a Bézier mesh before the corner
 * map.
 *
 * The maths (homographies, meshes, presets) is shared with the vector editor in `src/geom`.
 */

import {
  applyMatrix,
  invertMatrix,
  matrixAbout,
  multiplyMatrices,
  rotateMatrix,
  translateMatrix,
  type AffineMatrix,
} from '../geom/affine';
import {
  affineFromHomography,
  applyHomography,
  boxQuad,
  homographyFromAffine,
  homographyKeepsQuad,
  rectToQuad,
  type Homography,
} from '../geom/homography';
import { evalWarpMesh, identityWarpMesh, isValidWarpMesh, WARP_STYLES, warpPresetMesh, type WarpPreset } from '../geom/warp';
import type { Quad, Vec2, WarpMesh, WarpStyle } from '../geom/types';
import type { CropBox } from './types';

export type { Quad, Vec2, WarpMesh, WarpStyle, WarpPreset, AffineMatrix, Homography };
export { WARP_STYLES };

/** Free Transform modes (Edit › Transform). Scale, rotate and skew stay affine. */
export type FreeTransformMode = 'scale' | 'rotate' | 'skew' | 'distort' | 'perspective' | 'warp';

export const FREE_TRANSFORM_MODES: readonly FreeTransformMode[] = ['scale', 'rotate', 'skew', 'distort', 'perspective', 'warp'];

/** The nine reference-point positions of the options bar's locator, over the transformed box. */
export type TransformAnchor = 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';

export const TRANSFORM_ANCHORS: readonly TransformAnchor[] = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];

export const ANCHOR_FRACTION: Record<TransformAnchor, [number, number]> = {
  'top-left': [0, 0],
  top: [0.5, 0],
  'top-right': [1, 0],
  left: [0, 0.5],
  center: [0.5, 0.5],
  right: [1, 0.5],
  'bottom-left': [0, 1],
  bottom: [0.5, 1],
  'bottom-right': [1, 1],
};

export function isTransformAnchor(value: unknown): value is TransformAnchor {
  return typeof value === 'string' && value in ANCHOR_FRACTION;
}

/** A transform in progress: the frame, where its corners go and an optional warp over the frame. */
export interface FreeTransformGeometry {
  /** The frame being transformed, in document pixels (the content bounds when it began). */
  box: CropBox;
  /** Where the frame's corners land: top-left, top-right, bottom-right, bottom-left (document pixels). */
  corners: Quad;
  /**
   * A warp applied in the frame's own space before the corner map: its control points are in
   * document pixels of the untransformed frame (`identityWarpMesh(box)` is no warp).
   */
  warp?: WarpMesh | null;
}

/** The untransformed geometry of a box. */
export function identityTransform(box: CropBox): FreeTransformGeometry {
  return { box: { ...box }, corners: boxQuad(box) };
}

/** Where `box`'s corners go under the affine `m`. */
export function cornersFromMatrix(box: CropBox, m: AffineMatrix): Quad {
  const q = boxQuad(box);
  return [applyMatrix(m, q[0]), applyMatrix(m, q[1]), applyMatrix(m, q[2]), applyMatrix(m, q[3])];
}

/** The affine matrix taking `box` onto `corners` when they form a parallelogram, else `null`. */
export function matrixFromCorners(box: CropBox, corners: Quad, eps = 1e-6): AffineMatrix | null {
  const [tl, tr, br, bl] = corners;
  const size = 1 + Math.max(box.width, box.height);
  if (Math.abs(tl.x + br.x - tr.x - bl.x) > eps * size || Math.abs(tl.y + br.y - tr.y - bl.y) > eps * size) return null;
  const h = rectToQuad(box, corners);
  return h ? affineFromHomography(h, 1e-9) : null;
}

/** The projective map of the corner move (box → corners), or `null` when the corners are degenerate. */
export function transformHomography(geometry: FreeTransformGeometry): Homography | null {
  const h = rectToQuad(geometry.box, geometry.corners);
  if (!h) return null;
  // A quad folded through the horizon would wrap content round infinity.
  return homographyKeepsQuad(h, boxQuad(geometry.box)) ? h : null;
}

/** Whether a warp mesh changes anything (not the identity over the box). */
export function hasWarp(geometry: FreeTransformGeometry): boolean {
  const w = geometry.warp;
  if (!w) return false;
  const id = identityWarpMesh(geometry.box, w.us.length - 1, w.vs.length - 1);
  if (id.points.length !== w.points.length || id.us.some((u, i) => Math.abs(u - w.us[i]) > 1e-12) || id.vs.some((v, i) => Math.abs(v - w.vs[i]) > 1e-12)) return true;
  return w.points.some((p, i) => Math.abs(p.x - id.points[i].x) > 1e-6 || Math.abs(p.y - id.points[i].y) > 1e-6);
}

/** Whether the geometry changes nothing. */
export function isIdentityTransform(geometry: FreeTransformGeometry): boolean {
  if (hasWarp(geometry)) return false;
  const q = boxQuad(geometry.box);
  return geometry.corners.every((c, i) => Math.abs(c.x - q[i].x) < 1e-6 && Math.abs(c.y - q[i].y) < 1e-6);
}

/**
 * The forward map of the whole transform (document pixels of the source → document pixels of the
 * result): the warp over the box, then the corner map. `null` where it is undefined.
 */
export function transformMap(geometry: FreeTransformGeometry): ((p: Vec2) => Vec2 | null) | null {
  const h = transformHomography(geometry);
  if (!h) return null;
  const { box } = geometry;
  const warp = hasWarp(geometry) ? geometry.warp! : null;
  if (!warp) return (p) => applyHomography(h, p);
  return (p) => applyHomography(h, evalWarpMesh(warp, (p.x - box.x) / box.width, (p.y - box.y) / box.height));
}

/** A point of the transformed box at box fractions (`fx`, `fy`), warp included. */
export function transformedPoint(geometry: FreeTransformGeometry, fx: number, fy: number): Vec2 | null {
  const f = transformMap(geometry);
  const { box } = geometry;
  return f ? f({ x: box.x + fx * box.width, y: box.y + fy * box.height }) : null;
}

/** Where an anchor of the box is after the corner map (the warp ignored). */
export function anchorPoint(geometry: FreeTransformGeometry, anchor: TransformAnchor): Vec2 {
  const [fx, fy] = ANCHOR_FRACTION[anchor];
  const h = rectToQuad(geometry.box, geometry.corners);
  const p = { x: geometry.box.x + fx * geometry.box.width, y: geometry.box.y + fy * geometry.box.height };
  return (h && applyHomography(h, p)) ?? p;
}

/** Bounds of the transformed result's outline (document pixels, not rounded). */
export function transformedBox(geometry: FreeTransformGeometry): CropBox | null {
  const f = transformMap(geometry);
  if (!f) return null;
  const { box } = geometry;
  const pts: Vec2[] = [];
  const n = hasWarp(geometry) ? 16 : 1;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    for (const [fx, fy] of [[t, 0], [1, t], [1 - t, 1], [0, 1 - t]]) {
      const p = f({ x: box.x + fx * box.width, y: box.y + fy * box.height });
      if (!p) return null;
      pts.push(p);
    }
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

// ---------------------------------------------------------------------------
// Numeric transforms (the options bar, and agents)
// ---------------------------------------------------------------------------

/** Free Transform as numbers, as Photoshop's options bar shows it. */
export interface TransformParams {
  /** Width in percent of the frame (default 100; negative flips). */
  scaleX?: number;
  /** Height in percent of the frame (default 100; negative flips). */
  scaleY?: number;
  /** Rotation in degrees, clockwise (default 0). */
  rotate?: number;
  /** Horizontal skew in degrees: vertical edges lean right for positive angles (default 0). */
  skewX?: number;
  /** Vertical skew in degrees: horizontal edges lean down for positive angles (default 0). */
  skewY?: number;
  /** Move after scaling and rotating, in document pixels (default 0). */
  dx?: number;
  dy?: number;
  /** The fixed point of scale, skew and rotation: an anchor of the frame or a document point (default the centre). */
  reference?: TransformAnchor | Vec2;
}

/** The reference point of params over a box (default its centre). */
export function referencePoint(box: CropBox, reference: TransformParams['reference']): Vec2 {
  if (reference && typeof reference === 'object') return { x: reference.x, y: reference.y };
  const [fx, fy] = ANCHOR_FRACTION[reference ?? 'center'];
  return { x: box.x + fx * box.width, y: box.y + fy * box.height };
}

/**
 * The affine matrix of `params` over `box`: about the reference point, skew, then scale, then
 * rotate; then the move.
 */
export function matrixFromParams(box: CropBox, params: TransformParams): AffineMatrix {
  const sx = (params.scaleX ?? 100) / 100;
  const sy = (params.scaleY ?? 100) / 100;
  const tx = Math.tan(((params.skewX ?? 0) * Math.PI) / 180);
  const ty = Math.tan(((params.skewY ?? 0) * Math.PI) / 180);
  const ref = referencePoint(box, params.reference);
  const linear = multiplyMatrices(multiplyMatrices([1, ty, tx, 1, 0, 0], [sx, 0, 0, sy, 0, 0]), rotateMatrix(params.rotate ?? 0));
  return multiplyMatrices(matrixAbout(linear, ref), translateMatrix(params.dx ?? 0, params.dy ?? 0));
}

/** What the options bar shows for a transform. */
export interface TransformReadout {
  /** False for Distort, Perspective and Warp: only `bounds` and `corners` then mean anything. */
  affine: boolean;
  /** Width and height in percent of the frame. */
  scaleX: number;
  scaleY: number;
  /** Rotation in degrees, clockwise, in (−180, 180]. */
  rotate: number;
  /** Horizontal skew in degrees (vertical skew is folded into rotation and scale). */
  skewX: number;
  /** Where the reference point is now (document pixels). */
  x: number;
  y: number;
  /** Bounds of the transformed outline. */
  bounds: CropBox | null;
  corners: Quad;
}

/**
 * Decomposes a transform for the options bar: the linear part as rotate · scale · skew (QR) with
 * the given reference point. Non-affine geometry reports its bounds and corners only.
 */
export function describeTransform(geometry: FreeTransformGeometry, reference: TransformParams['reference'] = 'center'): TransformReadout {
  const m = hasWarp(geometry) ? null : matrixFromCorners(geometry.box, geometry.corners);
  const ref = referencePoint(geometry.box, reference);
  const bounds = transformedBox(geometry);
  if (!m) {
    const h = rectToQuad(geometry.box, geometry.corners);
    const at = (h && applyHomography(h, ref)) ?? ref;
    return { affine: false, scaleX: 100, scaleY: 100, rotate: 0, skewX: 0, x: at.x, y: at.y, bounds, corners: geometry.corners };
  }
  const [a, b, c, d] = m;
  const sxAbs = Math.hypot(a, b);
  const rot = (Math.atan2(b, a) * 180) / Math.PI;
  const shear = sxAbs ? (a * c + b * d) / sxAbs : 0;
  const sy = sxAbs ? (a * d - b * c) / sxAbs : 0;
  // Skew then scale: [[sx, sx·tan(skew)], [0, sy]], so tan(skew) = shear / sx.
  const skew = sxAbs ? (Math.atan(shear / sxAbs) * 180) / Math.PI : 0;
  const at = applyMatrix(m, ref);
  const clean = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v);
  return {
    affine: true,
    scaleX: clean(sxAbs * 100),
    scaleY: clean(sy * 100),
    rotate: clean(rot === -180 ? 180 : rot),
    skewX: clean(skew),
    x: at.x,
    y: at.y,
    bounds,
    corners: geometry.corners,
  };
}

/**
 * Corners for a transform given as numbers relative to the current corners: `params` are applied
 * after the current affine part (when the corners are a parallelogram) about the reference point
 * of the current geometry, so typing "rotate 15" rotates the box as it is now.
 */
export function applyParams(geometry: FreeTransformGeometry, params: TransformParams): Quad {
  const ref = params.reference && typeof params.reference === 'object' ? params.reference : anchorPoint(geometry, (params.reference as TransformAnchor | undefined) ?? 'center');
  const m = matrixFromParams({ x: ref.x, y: ref.y, width: 0, height: 0 }, { ...params, reference: ref });
  const c = geometry.corners;
  return [applyMatrix(m, c[0]), applyMatrix(m, c[1]), applyMatrix(m, c[2]), applyMatrix(m, c[3])];
}

/** Flip of the corners about the box's centre line (horizontal: left ↔ right). */
export function flipCorners(geometry: FreeTransformGeometry, axis: 'horizontal' | 'vertical'): Quad {
  const c = anchorPoint(geometry, 'center');
  const m: AffineMatrix = axis === 'horizontal' ? [-1, 0, 0, 1, 2 * c.x, 0] : [1, 0, 0, -1, 0, 2 * c.y];
  const q = geometry.corners;
  return [applyMatrix(m, q[0]), applyMatrix(m, q[1]), applyMatrix(m, q[2]), applyMatrix(m, q[3])];
}

/** Inverse of `matrixFromCorners` (box space → document) for mapping a document point back into the box. */
export function boxPointOf(geometry: FreeTransformGeometry, p: Vec2): Vec2 | null {
  const m = matrixFromCorners(geometry.box, geometry.corners);
  if (m) return applyMatrix(invertMatrix(m), p);
  return null;
}

/** A warp mesh from a preset over the box (null when it changes nothing). */
export function presetWarp(box: CropBox, preset: WarpPreset): WarpMesh | null {
  return warpPresetMesh(preset, box);
}

/** Validates a warp mesh for a box: well formed, finite, the right number of points. */
export function isValidWarp(mesh: unknown): mesh is WarpMesh {
  return isValidWarpMesh(mesh);
}

/** The geometry's affine map when it is one (no warp, a parallelogram), as a homography; else the projective map. */
export function geometryHomography(geometry: FreeTransformGeometry): Homography | null {
  const m = matrixFromCorners(geometry.box, geometry.corners);
  return m ? homographyFromAffine(m) : transformHomography(geometry);
}
