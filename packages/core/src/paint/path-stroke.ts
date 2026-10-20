/**
 * A brush stroke along a path: polyline samples, each with an optional pressure and pen tilt, are
 * walked at the brush's spacing (pressure and tilt interpolated between samples) into dabs, built
 * up in a coverage map and composited onto a layer. This is what a vector editor calls to draw a
 * path with a natural-media brush ("brushstrokes on vector paths"): the path is the data, the
 * pixels are rendered from it.
 *
 * - Pressure scales size and / or opacity as the brush says.
 * - Tilt (`tiltX` / `tiltY` in degrees, or `altitude` / `azimuth` in radians, as Pointer Events give
 *   them) widens the tip (`tilt.size`), flattens it along the lean (`tilt.roundness`), and with
 *   `tilt.followAzimuth` turns the tip to the lean, as a pen laid on its side does.
 * - With `followPath` the tip turns with the path (a calligraphic nib along a curve).
 *
 * Deterministic and DOM-free: the same samples and brush give the same pixels everywhere.
 */

import { applyStrokeToTile, CoverageMap, dabRect, normalizeBrush, rasterizeDab, type BrushSettings, type Dab } from './brush';
import { TiledSurface, finishTile, tileKey, tilesInRect, TILE, type RasterRect } from '../raster/surface';
import type { BlendMode } from '../raster/blend';

/** One sample of the path (document pixels). */
export interface PathSample {
  x: number;
  y: number;
  /** 0..1 (default 1). */
  pressure?: number;
  /** Pointer Events tilt in degrees (−90..90). */
  tiltX?: number;
  tiltY?: number;
  /** Radians above the surface (π/2 upright); overrides tiltX / tiltY. */
  altitude?: number;
  /** Radians clockwise from +x: where the pen leans (with altitude). */
  azimuth?: number;
}

export interface PathStrokeOptions {
  brush: Partial<BrushSettings>;
  /** How tilt shapes the tip (each 0..1; default none). */
  tilt?: { size?: number; roundness?: number; followAzimuth?: boolean };
  /** Turn the tip with the direction of the path (added to the brush angle). */
  followPath?: boolean;
  /** Size at zero pressure as a fraction of the full size, when pressure controls size (default 0). */
  minSize?: number;
  /** Join the last sample back to the first. */
  closed?: boolean;
}

/** A pen's lean from a sample: 0 upright .. 1 flat, and the direction it leans (radians, clockwise from +x). */
function lean(s: PathSample): { amount: number; azimuth: number } | null {
  if (typeof s.altitude === 'number' && Number.isFinite(s.altitude)) {
    return { amount: 1 - Math.min(1, Math.max(0, s.altitude / (Math.PI / 2))), azimuth: s.azimuth ?? 0 };
  }
  if (typeof s.tiltX === 'number' || typeof s.tiltY === 'number') {
    const tx = ((s.tiltX ?? 0) * Math.PI) / 180;
    const ty = ((s.tiltY ?? 0) * Math.PI) / 180;
    if (tx === 0 && ty === 0) return { amount: 0, azimuth: 0 };
    const az = Math.atan2(Math.tan(ty), Math.tan(tx));
    const alt = Math.atan(1 / Math.hypot(Math.tan(tx), Math.tan(ty)));
    return { amount: 1 - alt / (Math.PI / 2), azimuth: az };
  }
  return null;
}

/** The dabs of a brush stroke along `samples`, with pressure and tilt interpolated between them. */
export function pathStrokeDabs(samples: readonly PathSample[], options: PathStrokeOptions): Dab[] {
  const brush = normalizeBrush(options.brush);
  const pts = options.closed && samples.length > 2 ? [...samples, samples[0]] : [...samples];
  if (!pts.length) return [];
  const tilt = options.tilt ?? {};
  const minSize = Math.min(1, Math.max(0, options.minSize ?? 0));
  const dab = (x: number, y: number, p: number, l: { amount: number; azimuth: number } | null, dir: number): Dab => {
    const pr = Math.min(1, Math.max(0, p));
    const lean0 = l?.amount ?? 0;
    const size = brush.size * (brush.pressureSize ? minSize + (1 - minSize) * pr : 1) * (1 + 1.5 * (tilt.size ?? 0) * lean0);
    let angle = (brush.angle * Math.PI) / 180;
    if (options.followPath) angle += dir;
    if (tilt.followAzimuth && l) angle = -l.azimuth;
    const roundness = Math.max(0.05, brush.roundness * (1 - 0.85 * (tilt.roundness ?? 0) * lean0));
    const op = brush.pressureOpacity ? pr : 1;
    return { x, y, radius: Math.max(0.5, size / 2), alpha: brush.flow, opacity: brush.opacity * op, angle, roundness };
  };
  const out: Dab[] = [];
  const pressure = (s: PathSample) => (typeof s.pressure === 'number' && Number.isFinite(s.pressure) ? s.pressure : 1);
  if (pts.length === 1) {
    out.push(dab(pts[0].x, pts[0].y, pressure(pts[0]), lean(pts[0]), 0));
    return out;
  }
  let carry = 0;
  out.push(dab(pts[0].x, pts[0].y, pressure(pts[0]), lean(pts[0]), Math.atan2(-(pts[1].y - pts[0].y), pts[1].x - pts[0].x)));
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    // Dab angles are counter-clockwise with y up, as the shared rasterizer reads them.
    const dir = Math.atan2(-dy, dx);
    const la = lean(a);
    const lb = lean(b);
    let t = carry;
    for (;;) {
      const f = t / len;
      if (f > 1) break;
      const p = pressure(a) + (pressure(b) - pressure(a)) * f;
      const l = la && lb ? { amount: la.amount + (lb.amount - la.amount) * f, azimuth: la.azimuth + (lb.azimuth - la.azimuth) * f } : (la ?? lb);
      const size = brush.size * (brush.pressureSize ? minSize + (1 - minSize) * p : 1);
      const step = Math.max(0.5, size * brush.spacing);
      if (t > 0 || i > 0) out.push(dab(a.x + dx * f, a.y + dy * f, p, l, dir));
      t += step;
    }
    carry = t - len;
  }
  return out;
}

/** The coverage of a brush stroke along `samples` (build-up towards each dab's opacity) and its bounds. */
export function pathStrokeCoverage(samples: readonly PathSample[], options: PathStrokeOptions): { coverage: CoverageMap; bounds: RasterRect | null; dabs: number } {
  const brush = normalizeBrush(options.brush);
  const coverage = new CoverageMap();
  const dabs = pathStrokeDabs(samples, options);
  let buf = new Float32Array(0);
  let bounds: RasterRect | null = null;
  for (const d of dabs) {
    const rect = dabRect(d, brush.hardness);
    const n = rect.width * rect.height;
    if (n <= 0) continue;
    if (buf.length < n) buf = new Float32Array(n);
    const vals = buf.subarray(0, n);
    rasterizeDab(d, brush.hardness, rect, vals);
    coverage.accumulate(rect, vals, d.opacity);
    if (!bounds) bounds = { ...rect };
    else {
      const x = Math.min(bounds.x, rect.x);
      const y = Math.min(bounds.y, rect.y);
      bounds = { x, y, width: Math.max(bounds.x + bounds.width, rect.x + rect.width) - x, height: Math.max(bounds.y + bounds.height, rect.y + rect.height) - y };
    }
  }
  return { coverage, bounds, dabs: dabs.length };
}

export interface PaintPathOptions extends PathStrokeOptions {
  /** RGBA 0..255 of the paint. */
  color: readonly [number, number, number, number];
  /** `erase` removes paint instead (default `paint`). */
  mode?: 'paint' | 'erase';
  /** Blend mode (default the brush's). */
  blend?: BlendMode;
  /** Layer offset: layer pixel = document pixel − offset (default 0, 0). */
  offset?: { x: number; y: number };
  lockTransparency?: boolean;
  /** Where paint may land (canvas-sized coverage 0..255), or none. */
  selection?: { width: number; height: number; data: ArrayLike<number> } | null;
}

/**
 * Paints a brush stroke along `samples` onto an RGBA layer surface and returns the new surface
 * (the input is not changed; untouched tiles are shared) with the bounds it touched.
 */
export function paintPathStroke(surface: TiledSurface, samples: readonly PathSample[], options: PaintPathOptions): { surface: TiledSurface; bounds: RasterRect | null; dabs: number } {
  if (surface.channels !== 4) throw new Error('paintPathStroke paints RGBA surfaces (4 channels).');
  const brush = normalizeBrush(options.brush);
  const { coverage, bounds, dabs } = pathStrokeCoverage(samples, options);
  if (!bounds) return { surface, bounds: null, dabs };
  const offset = options.offset ?? { x: 0, y: 0 };
  const apply = {
    mode: options.mode ?? 'paint',
    color: options.color,
    background: [0, 0, 0, 0] as const,
    opacity: brush.opacity,
    blend: options.blend ?? brush.blend,
    lockTransparency: options.lockTransparency ?? false,
    selection: options.selection ?? null,
    offset,
  };
  const tiles = new Map(surface.tiles);
  for (const { tx, ty } of tilesInRect({ x: bounds.x - offset.x, y: bounds.y - offset.y, width: bounds.width, height: bounds.height })) {
    const key = tileKey(tx, ty);
    const src = surface.tiles.get(key)?.data;
    const base = src && src.length === TILE * TILE * 4 ? src : new Uint8ClampedArray(TILE * TILE * 4);
    const t = finishTile(applyStrokeToTile(coverage, base, 4, tx, ty, apply), 4, surface.defaultValue);
    if (t) tiles.set(key, t);
    else tiles.delete(key);
  }
  return { surface: new TiledSurface(4, tiles, surface.defaultValue), bounds, dabs };
}
