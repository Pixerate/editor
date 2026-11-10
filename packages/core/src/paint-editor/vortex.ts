/**
 * Vortex paint (`marks.kind: 'vortex'`, `engine: 'vortex'` and `wet.tool: 'vortex'`):
 *
 * - While the pen is down, nothing on the canvas moves; the path is recorded and shown as a live
 *   guide with an outline at `reach`.
 * - At pen-up, the stroke is classified as `'point'`, `'open'`, or `'closed'` (a non-self-crossing
 *   loop ending within one tip diameter of its start).
 * - From the Euclidean distance `d` to the stroke on a coarse grid (signed inside closed loops),
 *   a divergence-controlled velocity field `v = spin(d) · perp(∇d) − pull(d) · ∇d` with a
 *   Lamb-Oseen core profile and smooth `reach` window is integrated into a single backward
 *   displacement field `D` and resampled once across dry colour, impasto relief, and light twins.
 */

import {
  composeDisplacementFields,
  integrateVelocityField,
  warpTiledSurfaceChannel,
  warpTiledSurfaceNearest,
  warpTiledSurfaceRgba,
  type DisplacementField,
  type DisplacementSelectionMask,
  type VelocityGridField,
} from '../paint/displacement';
import { applyStrokeToTile, type StrokeApply } from '../paint/brush';
import { EMPTY_MIXER_LOAD, type PaintTileTarget } from '../paint/exchange';
import type { PaintGradientSource } from '../paint/gradient-paint';
import {
  finishTile,
  TILE,
  TiledSurface,
  tileKey,
  tilesInRect,
  type RasterRect,
  type Tile,
  type TileKey,
} from '../raster/surface';
import {
  brushVortex,
  type PaintBrush,
  type VortexDirection,
} from './brush-model';
import { PaintDabStroke } from './dab-stroke';
import type { EffectPaintPixels } from './effect-paint';
import { DryStroke, IDENTITY_COPY, type PenPoint, type StrokeCopy } from './engine';
import type { Point2 } from './guides';
import type { PaperGrain } from './paper';
import type { StickerArtLookup } from './sticker-art';
import { FilmBuffer, type ThickChannels } from './thick';

export type VortexShape = 'point' | 'open' | 'closed';
export const VORTEX_SHAPES: readonly VortexShape[] = ['point', 'open', 'closed'];

export interface VortexStrokeSummary {
  shape: VortexShape;
  maxDisplacement: number;
}

export interface VortexClassification {
  shape: VortexShape;
  pathLength: number;
  signedArea: number;
  vertices: PenPoint[];
}

/** Deduplicates consecutive samples closer than `minDist` and applies position/pressure smoothing. */
export function smoothVortexPoints(
  points: readonly PenPoint[],
  posSmoothing = 0,
  pressureSmoothing = 0
): PenPoint[] {
  if (points.length === 0) return [];
  const out: PenPoint[] = [];
  const posAlpha = 1 - Math.min(0.95, Math.max(0, posSmoothing)) * 0.85;
  const presAlpha = 1 - Math.min(0.95, Math.max(0, pressureSmoothing)) * 0.85;
  let sx = points[0]!.x;
  let sy = points[0]!.y;
  let sp = points[0]!.pressure ?? 1;
  out.push({ ...points[0]!, x: sx, y: sy, pressure: sp });

  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    sx += (p.x - sx) * posAlpha;
    sy += (p.y - sy) * posAlpha;
    sp += ((p.pressure ?? 1) - sp) * presAlpha;
    const prev = out[out.length - 1]!;
    if (Math.hypot(sx - prev.x, sy - prev.y) >= 0.5 || i === points.length - 1) {
      out.push({ ...p, x: sx, y: sy, pressure: sp });
    }
  }
  return out;
}

/** Strict proper intersection between segment AB and segment CD. */
function segmentsProperlyIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number
): { hit: boolean; x: number; y: number } {
  const rX = bx - ax;
  const rY = by - ay;
  const sX = dx - cx;
  const sY = dy - cy;
  const denom = rX * sY - rY * sX;
  if (Math.abs(denom) < 1e-8) return { hit: false, x: 0, y: 0 };
  const qpX = cx - ax;
  const qpY = cy - ay;
  const t = (qpX * sY - qpY * sX) / denom;
  const u = (qpX * rY - qpY * rX) / denom;
  if (t > 1e-4 && t < 1 - 1e-4 && u > 1e-4 && u < 1 - 1e-4) {
    return { hit: true, x: ax + t * rX, y: ay + t * rY };
  }
  return { hit: false, x: 0, y: 0 };
}

/**
 * Classifies a stroke into `'point'`, `'open'`, or `'closed'`:
 * - `'point'`: total movement is below `max(2, tipSize * 0.35)`.
 * - `'closed'`: ends within one tip diameter (`tipSize`) of its start, has length `>= tipSize * 2`,
 *   encloses non-degenerate area, and does not self-cross like a figure of eight.
 * - `'open'`: everything else.
 */
export function classifyVortexShape(
  rawPoints: readonly PenPoint[],
  tipSize: number,
  posSmoothing = 0,
  pressureSmoothing = 0
): VortexClassification {
  const vertices = smoothVortexPoints(rawPoints, posSmoothing, pressureSmoothing);
  if (vertices.length <= 1) {
    return { shape: 'point', pathLength: 0, signedArea: 0, vertices };
  }
  const cumLen = new Float64Array(vertices.length);
  let pathLength = 0;
  for (let i = 1; i < vertices.length; i++) {
    pathLength += Math.hypot(
      vertices[i]!.x - vertices[i - 1]!.x,
      vertices[i]!.y - vertices[i - 1]!.y
    );
    cumLen[i] = pathLength;
  }

  const pointThreshold = Math.max(2, tipSize * 0.35);
  if (pathLength < pointThreshold) {
    return { shape: 'point', pathLength, signedArea: 0, vertices };
  }

  const first = vertices[0]!;
  const last = vertices[vertices.length - 1]!;
  const endDist = Math.hypot(last.x - first.x, last.y - first.y);
  const closeThreshold = Math.max(4, tipSize);

  let area2 = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % vertices.length]!;
    area2 += a.x * b.y - b.x * a.y;
  }
  const signedArea = area2 * 0.5;

  if (endDist <= closeThreshold && vertices.length >= 4 && pathLength >= Math.max(8, tipSize * 2)) {
    // Check for self-intersections (excluding benign overlap right at the start/end closure).
    const nSeg = vertices.length - 1;
    let selfCrosses = false;
    const closureZone = Math.min(closeThreshold, pathLength * 0.18);
    for (let i = 0; i < nSeg && !selfCrosses; i++) {
      const a = vertices[i]!;
      const b = vertices[i + 1]!;
      for (let j = i + 2; j < nSeg; j++) {
        if (i === 0 && j === nSeg - 1) continue;
        const c = vertices[j]!;
        const d = vertices[j + 1]!;
        const inter = segmentsProperlyIntersect(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
        if (inter.hit) {
          const nearStart = cumLen[i + 1]! <= closureZone;
          const nearEnd = pathLength - cumLen[j]! <= closureZone;
          const nearClosurePt =
            Math.hypot(inter.x - first.x, inter.y - first.y) <= closeThreshold ||
            Math.hypot(inter.x - last.x, inter.y - last.y) <= closeThreshold;
          if (!(nearStart && nearEnd && nearClosurePt)) {
            selfCrosses = true;
            break;
          }
        }
      }
    }
    // A figure-of-eight also cancels its own shoelace signed area relative to a single loop.
    const minLoopArea = (pathLength * pathLength) / (16 * Math.PI);
    if (!selfCrosses && Math.abs(signedArea) >= minLoopArea) {
      return { shape: 'closed', pathLength, signedArea, vertices };
    }
  }

  return { shape: 'open', pathLength, signedArea, vertices };
}

/**
 * Resolves the spin sign (`+1` clockwise in document space where +y is down, `-1` counter-clockwise)
 * from `direction`, the primary stroke's `shape` and `signedArea`, and an optional symmetry copy.
 */
export function resolveVortexSpinSign(
  direction: VortexDirection,
  shape: VortexShape,
  signedArea: number,
  copy: StrokeCopy = IDENTITY_COPY
): 1 | -1 {
  let sign: 1 | -1 = 1;
  if (direction === 'cw') sign = 1;
  else if (direction === 'ccw') sign = -1;
  else if (shape === 'closed') sign = signedArea < 0 ? -1 : 1;
  else sign = 1;

  const det = copy.linear[0] * copy.linear[3] - copy.linear[1] * copy.linear[2];
  if (det < 0) sign = (sign === 1 ? -1 : 1);
  return sign;
}

function pointInPolygon(x: number, y: number, poly: readonly PenPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]!.x;
    const yi = poly[i]!.y;
    const xj = poly[j]!.x;
    const yj = poly[j]!.y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function smoothGrid3x3(src: Float32Array, cols: number, rows: number, passes = 2): Float32Array {
  let cur = new Float32Array(src);
  let tmp = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    // Horizontal [1, 2, 1] / 4
    for (let r = 0; r < rows; r++) {
      const rowOff = r * cols;
      for (let c = 0; c < cols; c++) {
        const c0 = c > 0 ? c - 1 : 0;
        const c1 = c < cols - 1 ? c + 1 : cols - 1;
        tmp[rowOff + c] = (cur[rowOff + c0]! + 2 * cur[rowOff + c]! + cur[rowOff + c1]!) * 0.25;
      }
    }
    // Vertical [1, 2, 1] / 4
    for (let r = 0; r < rows; r++) {
      const r0 = r > 0 ? r - 1 : 0;
      const r1 = r < rows - 1 ? r + 1 : rows - 1;
      const off0 = r0 * cols;
      const offC = r * cols;
      const off1 = r1 * cols;
      for (let c = 0; c < cols; c++) {
        cur[offC + c] = (tmp[off0 + c]! + 2 * tmp[offC + c]! + tmp[off1 + c]!) * 0.25;
      }
    }
  }
  return cur;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Computes the local reach in pixels at a sample point `p` for `brush`. */
export function localVortexReachPx(brush: PaintBrush, p: PenPoint): number {
  const vortex = brushVortex(brush);
  const tipRadius = Math.max(1, brush.tip.size * 0.5);
  const minS = Math.max(0.15, brush.dynamics.minSize);
  const pScale = brush.tip.pressureSize
    ? minS + (1 - minS) * Math.max(0, Math.min(1, p.pressure ?? 1))
    : 1;
  return Math.max(2, vortex.reach * tipRadius * pScale);
}

/**
 * Builds the coarse-grid forward velocity field `v(x, y)` for one vortex stroke (or one symmetry
 * copy of it), along with its shape classification.
 */
export function buildVortexVelocityField(
  rawPoints: readonly PenPoint[],
  brush: PaintBrush,
  spinSignOverride?: 1 | -1
): { velocity: VelocityGridField; classification: VortexClassification } {
  const vortex = brushVortex(brush);
  const tipRadius = Math.max(1, brush.tip.size * 0.5);
  const classification = classifyVortexShape(
    rawPoints,
    brush.tip.size,
    brush.tip.smoothing,
    brush.pressureSmoothing
  );
  const { shape, signedArea, vertices } = classification;
  const spinSign =
    spinSignOverride ?? resolveVortexSpinSign(vortex.direction, shape, signedArea, IDENTITY_COPY);
  const step = Math.max(1, Math.min(4, Math.round(tipRadius / 6)));

  if (vertices.length === 0) {
    const empty: VelocityGridField = {
      rect: { x: 0, y: 0, width: step, height: step },
      step,
      cols: 2,
      rows: 2,
      vx: new Float32Array(4),
      vy: new Float32Array(4),
      maxSpeed: 0,
    };
    return { velocity: empty, classification };
  }

  const reaches = vertices.map((p) => localVortexReachPx(brush, p));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxReach = 0;
  for (let i = 0; i < vertices.length; i++) {
    const p = vertices[i]!;
    const r = reaches[i]!;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if (r > maxReach) maxReach = r;
  }

  const margin = Math.ceil(maxReach + step * 3);
  const rx0 = Math.floor(minX - margin);
  const ry0 = Math.floor(minY - margin);
  const rx1 = Math.ceil(maxX + margin);
  const ry1 = Math.ceil(maxY + margin);
  const cols = Math.max(3, Math.ceil((rx1 - rx0) / step) + 1);
  const rows = Math.max(3, Math.ceil((ry1 - ry0) / step) + 1);
  const rect: RasterRect = { x: rx0, y: ry0, width: (cols - 1) * step, height: (rows - 1) * step };
  const count = cols * rows;
  const vx = new Float32Array(count);
  const vy = new Float32Array(count);
  let maxSpeed = 0;

  if (shape === 'point') {
    let cx = 0;
    let cy = 0;
    let R = 0;
    for (let i = 0; i < vertices.length; i++) {
      cx += vertices[i]!.x;
      cy += vertices[i]!.y;
      R += reaches[i]!;
    }
    cx /= vertices.length;
    cy /= vertices.length;
    R /= vertices.length;
    const rc = Math.max(1.5, Math.min(tipRadius * 0.45, R * 0.35));

    for (let r = 0; r < rows; r++) {
      const y = rect.y + r * step;
      for (let c = 0; c < cols; c++) {
        const x = rect.x + c * step;
        const idx = r * cols + c;
        const dx = x - cx;
        const dy = y - cy;
        const d = Math.hypot(dx, dy);
        if (d >= R || d <= 1e-5) continue;
        const nx = dx / d;
        const ny = dy / d;
        const tx = -ny * spinSign;
        const ty = nx * spinSign;
        const u = d / rc;
        const lamb = ((1 - Math.exp(-(u * u))) / u) / 0.63817;
        const s = d / R;
        const win = (1 - s * s) * (1 - s * s);
        const spinMag = lamb * win;
        const pullMag = vortex.pull * Math.sin(Math.PI * s) * win * 0.65;
        const ux = spinMag * tx - pullMag * nx;
        const uy = spinMag * ty - pullMag * ny;
        vx[idx] = ux;
        vy[idx] = uy;
        const sp = Math.hypot(ux, uy);
        if (sp > maxSpeed) maxSpeed = sp;
      }
    }
    return { velocity: { rect, step, cols, rows, vx, vy, maxSpeed }, classification };
  }

  // Open or closed stroke: compute exact Euclidean distance to segments on the coarse grid.
  const rawD = new Float32Array(count);
  const reachGrid = new Float32Array(count);
  const segCount = shape === 'closed' ? vertices.length : vertices.length - 1;
  const loopInteriorReach =
    shape === 'closed' ? Math.max(maxReach, Math.hypot(maxX - minX, maxY - minY) * 0.6) : maxReach;

  for (let r = 0; r < rows; r++) {
    const y = rect.y + r * step;
    for (let c = 0; c < cols; c++) {
      const x = rect.x + c * step;
      const idx = r * cols + c;
      let bestD2 = Infinity;
      let bestReach = maxReach;
      for (let i = 0; i < segCount; i++) {
        const j = (i + 1) % vertices.length;
        const ax = vertices[i]!.x;
        const ay = vertices[i]!.y;
        const bx = vertices[j]!.x;
        const by = vertices[j]!.y;
        const abx = bx - ax;
        const aby = by - ay;
        const len2 = abx * abx + aby * aby;
        const t = len2 > 1e-8 ? Math.max(0, Math.min(1, ((x - ax) * abx + (y - ay) * aby) / len2)) : 0;
        const px = ax + t * abx;
        const py = ay + t * aby;
        const d2 = (x - px) * (x - px) + (y - py) * (y - py);
        if (d2 < bestD2) {
          bestD2 = d2;
          bestReach = reaches[i]! + t * (reaches[j]! - reaches[i]!);
        }
      }
      const dist = Math.sqrt(bestD2);
      const inside = shape === 'closed' && pointInPolygon(x, y, vertices);
      rawD[idx] = inside ? -dist : dist;
      reachGrid[idx] = bestReach;
    }
  }

  const smoothD = smoothGrid3x3(rawD, cols, rows, 2);
  const rc = Math.max(1.5, tipRadius * (shape === 'closed' ? 0.55 : 0.4));

  for (let r = 0; r < rows; r++) {
    const rPrev = r > 0 ? r - 1 : 0;
    const rNext = r < rows - 1 ? r + 1 : rows - 1;
    const dySpan = (rNext - rPrev) * step;
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const dExact = rawD[idx]!;
      const R = reachGrid[idx]!;
      const limit = dExact < 0 ? loopInteriorReach : R;
      const absD = Math.abs(dExact);
      if (absD >= limit) continue;

      const cPrev = c > 0 ? c - 1 : 0;
      const cNext = c < cols - 1 ? c + 1 : cols - 1;
      const dxSpan = (cNext - cPrev) * step;
      const gx = (smoothD[r * cols + cNext]! - smoothD[r * cols + cPrev]!) / dxSpan;
      const gy = (smoothD[rNext * cols + c]! - smoothD[rPrev * cols + c]!) / dySpan;
      const gradMag = Math.hypot(gx, gy);
      if (gradMag <= 1e-5) continue;

      const nx = gx / gradMag;
      const ny = gy / gradMag;
      const tx = -ny * spinSign;
      const ty = nx * spinSign;
      const axisWeight = smoothstep(0.08, 0.55, gradMag);

      const s = absD / limit;
      const win = (1 - s * s) * (1 - s * s);
      let lamb: number;
      if (shape === 'closed') {
        // Closed loops have continuous ∇d across d = 0, so the outline itself moves smoothly and
        // fades only at the interior medial axis (via axisWeight) and towards reach.
        lamb = rc / Math.hypot(absD, rc);
      } else {
        const u = Math.max(1e-3, absD / rc);
        lamb = ((1 - Math.exp(-(u * u))) / u) / 0.63817;
      }
      const spinMag = lamb * win * axisWeight;
      const signSmooth = Math.tanh(smoothD[idx]! / Math.max(1.5, rc * 0.5));
      const pullMag = vortex.pull * Math.sin(Math.PI * Math.min(1, absD / R)) * win * 0.6 * signSmooth;
      const ux = spinMag * tx - pullMag * nx;
      const uy = spinMag * ty - pullMag * ny;
      vx[idx] = ux;
      vy[idx] = uy;
      const sp = Math.hypot(ux, uy);
      if (sp > maxSpeed) maxSpeed = sp;
    }
  }

  return { velocity: { rect, step, cols, rows, vx, vy, maxSpeed }, classification };
}

/**
 * Builds the integrated backward `DisplacementField` for a vortex stroke across all symmetry
 * copies (`copies`). Mirrored symmetry copies (`det < 0`) spin in the opposite direction.
 */
export function buildVortexDisplacement(
  rawPoints: readonly PenPoint[],
  brush: PaintBrush,
  copies: readonly StrokeCopy[] = [IDENTITY_COPY]
): { field: DisplacementField | null; shape: VortexShape; maxDisplacement: number } {
  const vortex = brushVortex(brush);
  const tipRadius = Math.max(1, brush.tip.size * 0.5);
  const primaryClass = classifyVortexShape(
    rawPoints,
    brush.tip.size,
    brush.tip.smoothing,
    brush.pressureSmoothing
  );
  if (rawPoints.length === 0) {
    return { field: null, shape: 'point', maxDisplacement: 0 };
  }

  const charRadius = tipRadius * (0.35 + 0.22 * vortex.reach);
  const totalTravel = vortex.turns * 2 * Math.PI * charRadius;

  let combined: DisplacementField | null = null;
  for (const copy of copies.length ? copies : [IDENTITY_COPY]) {
    const mapped = rawPoints.map((p) => copy.map(p));
    const spinSign = resolveVortexSpinSign(
      vortex.direction,
      primaryClass.shape,
      primaryClass.signedArea,
      copy
    );
    const { velocity } = buildVortexVelocityField(mapped, brush, spinSign);
    const disp = integrateVelocityField(velocity, totalTravel);
    if (disp.maxDisplacement <= 1e-4) continue;
    combined = combined ? composeDisplacementFields(combined, disp) : disp;
  }

  return {
    field: combined,
    shape: primaryClass.shape,
    maxDisplacement: combined ? Math.round(combined.maxDisplacement * 100) / 100 : 0,
  };
}


// ---------------------------------------------------------------------------
// Guide overlay segments (stroke path + reach outline)
// ---------------------------------------------------------------------------

/**
 * Builds the live guide segments shown while drawing a vortex stroke:
 * - `'vortex'`: the stroke path itself
 * - `'vortex-reach'`: the outline at `reach * tipRadius` around the path
 */
export function vortexGuideSegments(
  rawPoints: readonly PenPoint[],
  brush: PaintBrush,
  copies: readonly StrokeCopy[] = [IDENTITY_COPY]
): Array<{ from: Point2; to: Point2; kind: 'vortex' | 'vortex-reach' }> {
  if (rawPoints.length === 0) return [];
  const out: Array<{ from: Point2; to: Point2; kind: 'vortex' | 'vortex-reach' }> = [];
  const tipRadius = Math.max(1, brush.tip.size * 0.5);
  const smoothed = smoothVortexPoints(rawPoints, brush.tip.smoothing, brush.pressureSmoothing);
  const classification = classifyVortexShape(
    rawPoints,
    brush.tip.size,
    brush.tip.smoothing,
    brush.pressureSmoothing
  );
  const reaches = smoothed.map((p) => localVortexReachPx(brush, p));

  for (const copy of copies.length ? copies : [IDENTITY_COPY]) {
    const pts = smoothed.map((p) => copy.map(p));
    if (pts.length === 1 || classification.shape === 'point') {
      const c = pts[0]!;
      const R = reaches[0] ?? localVortexReachPx(brush, { x: c.x, y: c.y, pressure: 1 });
      const rCore = Math.max(2, Math.min(tipRadius, R * 0.25));
      const steps = 16;
      for (let i = 0; i < steps; i++) {
        const a0 = (i / steps) * Math.PI * 2;
        const a1 = ((i + 1) / steps) * Math.PI * 2;
        out.push({
          from: { x: c.x + Math.cos(a0) * rCore, y: c.y + Math.sin(a0) * rCore },
          to: { x: c.x + Math.cos(a1) * rCore, y: c.y + Math.sin(a1) * rCore },
          kind: 'vortex',
        });
        out.push({
          from: { x: c.x + Math.cos(a0) * R, y: c.y + Math.sin(a0) * R },
          to: { x: c.x + Math.cos(a1) * R, y: c.y + Math.sin(a1) * R },
          kind: 'vortex-reach',
        });
      }
      continue;
    }

    for (let i = 0; i + 1 < pts.length; i++) {
      out.push({
        from: { x: pts[i]!.x, y: pts[i]!.y },
        to: { x: pts[i + 1]!.x, y: pts[i + 1]!.y },
        kind: 'vortex',
      });
    }
    if (classification.shape === 'closed') {
      out.push({
        from: { x: pts[pts.length - 1]!.x, y: pts[pts.length - 1]!.y },
        to: { x: pts[0]!.x, y: pts[0]!.y },
        kind: 'vortex',
      });
    }

    const left: Point2[] = [];
    const right: Point2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const prev =
        i > 0 ? pts[i - 1]! : classification.shape === 'closed' ? pts[pts.length - 1]! : pts[0]!;
      const next =
        i + 1 < pts.length
          ? pts[i + 1]!
          : classification.shape === 'closed'
            ? pts[0]!
            : pts[pts.length - 1]!;
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const r = reaches[i]!;
      left.push({ x: pts[i]!.x + nx * r, y: pts[i]!.y + ny * r });
      right.push({ x: pts[i]!.x - nx * r, y: pts[i]!.y - ny * r });
    }
    for (let i = 0; i + 1 < left.length; i++) {
      out.push({ from: left[i]!, to: left[i + 1]!, kind: 'vortex-reach' });
      out.push({ from: right[i]!, to: right[i + 1]!, kind: 'vortex-reach' });
    }
    if (classification.shape === 'closed' && left.length >= 2) {
      out.push({ from: left[left.length - 1]!, to: left[0]!, kind: 'vortex-reach' });
      out.push({ from: right[right.length - 1]!, to: right[0]!, kind: 'vortex-reach' });
    } else if (left.length >= 2) {
      out.push({ from: left[0]!, to: right[0]!, kind: 'vortex-reach' });
      out.push({
        from: left[left.length - 1]!,
        to: right[right.length - 1]!,
        kind: 'vortex-reach',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dry / Relief Vortex Stroke Driver
// ---------------------------------------------------------------------------

export interface VortexStrokeDriverInit {
  brush: PaintBrush;
  base: TiledSurface;
  offset: { x: number; y: number };
  lockTransparency: boolean;
  selection: DisplacementSelectionMask | null;
  color: readonly [number, number, number, number];
  background: readonly [number, number, number, number];
  grain: PaperGrain | null;
  paperDepth: number;
  seed: number;
  copies: readonly StrokeCopy[];
  paint: PaintGradientSource | null;
  effect: EffectPaintPixels | null;
  stampArt?: StickerArtLookup;
  relief?: ThickChannels | null;
}

function sameTileContent(a: Tile | undefined, b: Tile | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a === b) return true;
  if (a.uniform !== null || b.uniform !== null) return a.uniform === b.uniform;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

function surfaceDiffers(a: TiledSurface, b: TiledSurface): boolean {
  if (a === b) return false;
  if (a.tiles.size !== b.tiles.size) return true;
  for (const [k, ta] of a.tiles) {
    if (!sameTileContent(ta, b.tiles.get(k))) return true;
  }
  return false;
}

function unionRect(a: RasterRect | null, b: RasterRect | null): RasterRect | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * Lays a vortex stroke's ink in gradient paint (`init.paint`): the stroke painted with a dab
 * brush's paint exchange over a copy of the layer (no pick-up). Returns the inked layer and the
 * rectangle it changed, or `null` when no dab landed.
 */
function layGradientInk(
  init: VortexStrokeDriverInit,
  inkBrush: PaintBrush,
  film: FilmBuffer | null,
  points: readonly PenPoint[]
): { surface: TiledSurface; bounds: RasterRect } | null {
  const base = init.base;
  const live = new Map<TileKey, Uint8ClampedArray>();
  const target: PaintTileTarget = {
    offset: init.offset,
    lockTransparency: init.lockTransparency,
    selection: init.selection,
    readTile: (tx, ty) => live.get(tileKey(tx, ty)) ?? base.tiles.get(tileKey(tx, ty))?.data ?? null,
    writeTile: (tx, ty) => {
      const key = tileKey(tx, ty);
      let t = live.get(key);
      if (!t) {
        const src = base.tiles.get(key)?.data;
        t = src ? new Uint8ClampedArray(src) : new Uint8ClampedArray(TILE * TILE * 4).fill(base.defaultValue);
        live.set(key, t);
      }
      return t;
    },
  };
  const rgb = (c: readonly number[]): [number, number, number] => [c[0]! / 255, c[1]! / 255, c[2]! / 255];
  const stroke = new PaintDabStroke(
    { ...inkBrush, engine: 'dab', behavior: { ...inkBrush.behavior, pickup: 0 } },
    {
      target,
      color: rgb(init.color),
      secondary: rgb(init.background),
      load: EMPTY_MIXER_LOAD,
      grain: init.grain,
      paperDepth: init.paperDepth,
      seed: init.seed,
      copies: init.copies,
      paint: init.paint,
      effect: init.effect,
      stampArt: init.stampArt,
      film,
    }
  );
  const rects = [...stroke.push(points), ...stroke.finish()];
  if (!rects.length || !live.size) return null;
  let bounds: RasterRect | null = null;
  for (const r of rects) bounds = unionRect(bounds, r);
  const tiles = new Map<TileKey, Tile>(base.tiles);
  for (const [key, data] of live) {
    const finished = finishTile(data, 4, base.defaultValue);
    if (finished) tiles.set(key, finished);
    else tiles.delete(key);
  }
  return { surface: new TiledSurface(4, tiles, base.defaultValue), bounds: bounds! };
}

export class VortexStrokeDriver {
  private readonly rawPoints: PenPoint[] = [];
  private warpedSurface: TiledSurface | null = null;
  private preInkSurface: TiledSurface | null = null;
  private displacementField: DisplacementField | null = null;
  private warpedRelief: ThickChannels | null = null;
  private changedBounds: RasterRect | null = null;
  private summary: VortexStrokeSummary = { shape: 'point', maxDisplacement: 0 };
  dabCount = 0;

  constructor(private readonly init: VortexStrokeDriverInit) {}

  /** While the pen is down, nothing moves on the canvas: points are recorded for pen-up. */
  push(points: readonly PenPoint[]): RasterRect[] {
    for (const p of points) this.rawPoints.push(p);
    return [];
  }

  /** At pen-up: optionally lays `ink > 0` along the stroke, integrates the vortex field, and resamples once. */
  finish(): { surface: TiledSurface | null; bounds: RasterRect | null } {
    const { init } = this;
    const brush = init.brush;
    const vortex = brushVortex(brush);

    if (this.rawPoints.length === 0) {
      this.summary = { shape: 'point', maxDisplacement: 0 };
      return { surface: null, bounds: null };
    }

    const { field, shape, maxDisplacement } = buildVortexDisplacement(
      this.rawPoints,
      brush,
      init.copies
    );
    this.displacementField = field;

    // 1. Optional pre-warp ink deposit into a scratch copy of the layer.
    let preSurface = init.base;
    let preFilm = init.relief?.film ?? null;
    let inkBounds: RasterRect | null = null;

    if (vortex.ink > 0 && init.base.channels === 4) {
      const inkBrush: PaintBrush = {
        ...brush,
        tip: { ...brush.tip, opacity: Math.min(1, brush.tip.opacity * vortex.ink) },
      };
      const filmBuf =
        init.relief && brush.iridescence
          ? new FilmBuffer(init.relief.film, init.offset, init.selection)
          : null;
      if (init.paint) {
        // Gradient paint: the ink is laid the way a dab brush paints a gradient (dab by dab, each
        // dab's colour from the gradient), with no pick-up.
        const r = layGradientInk(init, inkBrush, filmBuf, this.rawPoints);
        if (r) {
          preSurface = r.surface;
          inkBounds = r.bounds;
          if (filmBuf) preFilm = filmBuf.surface();
        }
      }
      const dry = init.paint
        ? null
        : new DryStroke(inkBrush, {
        grain: init.grain,
        paperDepth: init.paperDepth,
        seed: init.seed,
        copies: init.copies,
        effect: init.effect,
        stampArt: init.stampArt,
        film: filmBuf,
      });
      const rects = dry ? [...dry.push(this.rawPoints), ...dry.finish()] : [];
      if (dry && rects.length > 0) {
        const tiles = new Map<TileKey, Tile>(init.base.tiles);
        const apply: StrokeApply = {
          mode: 'paint',
          color: init.color,
          background: init.background,
          opacity: inkBrush.tip.opacity,
          blend: inkBrush.tip.blend,
          lockTransparency: init.lockTransparency,
          selection: init.selection,
          offset: init.offset,
        };
        const touched = new Map<TileKey, { tx: number; ty: number }>();
        for (const r of rects) {
          inkBounds = unionRect(inkBounds, r);
          for (const t of tilesInRect({
            x: r.x - init.offset.x,
            y: r.y - init.offset.y,
            width: r.width,
            height: r.height,
          })) {
            touched.set(tileKey(t.tx, t.ty), t);
          }
        }
        const defaultTile = new Uint8ClampedArray(TILE * TILE * 4).fill(init.base.defaultValue);
        for (const [key, { tx, ty }] of touched) {
          const src = init.base.tiles.get(key)?.data ?? defaultTile;
          const data = applyStrokeToTile(dry.coverage, src, 4, tx, ty, apply);
          const finished = finishTile(data, 4, init.base.defaultValue);
          if (finished) tiles.set(key, finished);
          else tiles.delete(key);
        }
        preSurface = new TiledSurface(4, tiles, init.base.defaultValue);
        if (filmBuf) preFilm = filmBuf.surface();
      }
    }
    this.preInkSurface = preSurface;

    // 2. Single-pass premultiplied bilinear warp of the layer surface.
    let finalSurface = preSurface;
    let warpBounds: RasterRect | null = null;
    if (field && field.maxDisplacement > 1e-4) {
      if (preSurface.channels === 4) {
        const res = warpTiledSurfaceRgba(preSurface, field, {
          offset: init.offset,
          lockTransparency: init.lockTransparency,
          selection: init.selection,
        });
        finalSurface = res.surface;
        warpBounds = res.bounds;
      } else {
        const res = warpTiledSurfaceChannel(preSurface, field, {
          offset: init.offset,
          selection: init.selection,
        });
        finalSurface = res.surface;
        warpBounds = res.bounds;
      }
    }

    // 3. Relief channels (impasto height + nearest-sampled material & thin-film).
    let reliefChanged = false;
    if (init.relief) {
      let height = init.relief.height;
      let material = init.relief.material;
      let film = preFilm ?? init.relief.film;
      if (field && field.maxDisplacement > 1e-4) {
        const wHeight = warpTiledSurfaceChannel(height, field, {
          offset: init.offset,
          selection: init.selection,
        });
        const wMat = warpTiledSurfaceNearest(material, field, {
          offset: init.offset,
          selection: init.selection,
        });
        const wFilm = warpTiledSurfaceNearest(film, field, {
          offset: init.offset,
          selection: init.selection,
        });
        height = wHeight.surface;
        material = wMat.surface;
        film = wFilm.surface;
        warpBounds = unionRect(warpBounds, unionRect(wHeight.bounds, unionRect(wMat.bounds, wFilm.bounds)));
      }
      reliefChanged =
        surfaceDiffers(height, init.relief.height) ||
        surfaceDiffers(material, init.relief.material) ||
        surfaceDiffers(film, init.relief.film);
      if (reliefChanged) {
        this.warpedRelief = { height, material, film };
      }
    }

    const surfaceChanged = surfaceDiffers(finalSurface, init.base);
    const anyChanged = surfaceChanged || reliefChanged;
    this.dabCount = anyChanged ? Math.max(1, this.rawPoints.length) : 0;
    this.changedBounds = anyChanged ? unionRect(inkBounds, warpBounds) ?? field?.rect ?? null : null;
    this.warpedSurface = anyChanged ? finalSurface : null;
    this.summary = {
      shape,
      maxDisplacement: anyChanged ? maxDisplacement : 0,
    };

    return {
      surface: this.warpedSurface,
      bounds: this.changedBounds,
    };
  }

  vortexResult(): VortexStrokeSummary {
    return this.summary;
  }

  reliefChannels(): ThickChannels | null {
    return this.warpedRelief;
  }

  windingAnimation(): { field: DisplacementField; preInkSurface: TiledSurface; duration: number } | null {
    const duration = brushVortex(this.init.brush).duration;
    if (!this.warpedSurface || !this.displacementField || !this.preInkSurface || !(duration > 0)) return null;
    return { field: this.displacementField, preInkSurface: this.preInkSurface, duration };
  }
}
