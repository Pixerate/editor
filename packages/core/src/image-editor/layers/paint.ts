// Portions ported from photocraft/crates/paint/src/lib.rs, dynamics.rs and render.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * The brush engine (a subset of photocraft's `crates/paint`): a computed round tip with size,
 * hardness, angle, roundness and spacing; pressure to size and opacity; smoothing; and Photoshop's
 * opacity-versus-flow build-up. Strokes are data, so one replays the same way for undo, agents
 * and tests.
 *
 * - Points are walked into dabs at `spacing × diameter` (`walkDabs`).
 * - Each dab's coverage (`dabCoverage`, photocraft's measured Photoshop profile) builds up in a
 *   stroke coverage map with flow towards the dab's opacity ceiling: `c ← c + v·(ceil − c)`.
 * - The stroke composites once at the stroke opacity over the layer as it was before the stroke,
 *   so overlapping dabs never exceed the opacity.
 */

import { blendPixel, type BlendMode } from '../blend';
import type { CropBox } from '../types';
import { TILE, tileKey, tileCoord, type TileKey } from './surface';

/** One input sample. Missing pressure is a mouse (1). */
export interface StrokePoint {
  x: number;
  y: number;
  /** 0..1 (default 1). */
  pressure?: number;
  /** Milliseconds (optional; kept for replays). */
  t?: number;
}

export interface BrushSettings {
  /** Diameter in pixels (1..2500, default 20). */
  size: number;
  /** 0 (soft) .. 1 (hard, default). */
  hardness: number;
  /** Dab spacing as a fraction of the diameter (0.01..10, default 0.1). */
  spacing: number;
  /** Tip angle in degrees (default 0). */
  angle: number;
  /** Tip roundness 0.01..1 (default 1). */
  roundness: number;
  /** Stroke opacity ceiling 0..1 (default 1). */
  opacity: number;
  /** Build-up per dab 0..1 (default 1). */
  flow: number;
  /** Input smoothing 0..0.95 (default 0). */
  smoothing: number;
  /** Pressure controls size (default true). */
  pressureSize: boolean;
  /** Pressure controls opacity (default false). */
  pressureOpacity: boolean;
  /** How the stroke paints onto the layer (default normal). */
  blend: BlendMode;
}

export const DEFAULT_BRUSH: Readonly<BrushSettings> = {
  size: 20,
  hardness: 1,
  spacing: 0.1,
  angle: 0,
  roundness: 1,
  opacity: 1,
  flow: 1,
  smoothing: 0,
  pressureSize: true,
  pressureOpacity: false,
  blend: 'normal',
};

export const MAX_BRUSH_SIZE = 2500;

/** A brush with every field in range (missing fields from `DEFAULT_BRUSH`). */
export function normalizeBrush(raw: Partial<BrushSettings> = {}): BrushSettings {
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    size: num(raw.size, 1, MAX_BRUSH_SIZE, DEFAULT_BRUSH.size),
    hardness: num(raw.hardness, 0, 1, DEFAULT_BRUSH.hardness),
    spacing: num(raw.spacing, 0.01, 10, DEFAULT_BRUSH.spacing),
    angle: num(raw.angle, -360, 360, DEFAULT_BRUSH.angle),
    roundness: num(raw.roundness, 0.01, 1, DEFAULT_BRUSH.roundness),
    opacity: num(raw.opacity, 0, 1, DEFAULT_BRUSH.opacity),
    flow: num(raw.flow, 0, 1, DEFAULT_BRUSH.flow),
    smoothing: num(raw.smoothing, 0, 0.95, DEFAULT_BRUSH.smoothing),
    pressureSize: typeof raw.pressureSize === 'boolean' ? raw.pressureSize : DEFAULT_BRUSH.pressureSize,
    pressureOpacity: typeof raw.pressureOpacity === 'boolean' ? raw.pressureOpacity : DEFAULT_BRUSH.pressureOpacity,
    blend: raw.blend ?? 'normal',
  };
}

// ---------------------------------------------------------------------------
// The round tip (photocraft's measured Photoshop profile)
// ---------------------------------------------------------------------------

/**
 * Photoshop's round tip, measured by photocraft: a solid core of radius `r0 · R`, then a Gaussian
 * shoulder `exp(-((d − r0) / s)²)` of width `s · R`, both by hardness (0, 0.1, … 1).
 */
const TIP_SHAPE: ReadonlyArray<[number, number]> = [
  [0.0, 0.664], [0.14, 0.58], [0.28, 0.5], [0.4, 0.44], [0.52, 0.36], [0.63, 0.29],
  [0.7, 0.24], [0.78, 0.19], [0.84, 0.15], [0.89, 0.11], [1.0, 0.0],
];
/** The anti-aliased edge: the shoulder never narrows below this many pixels. */
const TIP_EDGE_PX = 1.2;
const SMALL_TIP_RADIUS = 3;
const SUBPIXEL = [-0.375, -0.125, 0.125, 0.375];

/** The core radius and shoulder width (pixels) of a round tip of `radius` and `hardness`. */
export function tipShape(radius: number, hardness: number): [number, number] {
  const h = (Number.isNaN(hardness) ? 0 : Math.min(1, Math.max(0, hardness))) * 10;
  const i = Math.min(9, Math.floor(h));
  const t = h - i;
  const a = TIP_SHAPE[i];
  const b = TIP_SHAPE[i + 1];
  const r0 = a[0] + (b[0] - a[0]) * t;
  const s = a[1] + (b[1] - a[1]) * t;
  const r = Number.isFinite(radius) ? Math.max(0, radius) : 0;
  const edge = Math.max(0.25, Math.min(TIP_EDGE_PX, 0.3 * r));
  return [Math.max(0, Math.min(r0 * r, r - edge)), Math.max(1e-3, s * r, edge)];
}

/** `exp(-u)` as `(1 − u/64)^64` by six squarings: exactly 0 from u = 64. */
function softExp(u: number): number {
  let g = Math.min(1, Math.max(0, 1 - u / 64));
  for (let k = 0; k < 6; k++) g *= g;
  return g;
}

/** Opacity of a round tip at distance `d` from its centre. */
export function tipFalloff(d: number, radius: number, hardness: number): number {
  const [r0, s] = tipShape(radius, hardness);
  if (d <= r0) return 1;
  const x = (d - r0) / s;
  return softExp(x * x);
}

/** How far from its centre a round tip still paints. */
export function tipReach(radius: number, hardness: number): number {
  const [r0, s] = tipShape(radius, hardness);
  return r0 + 2.6 * s;
}

/** Coverage of a round dab at distance `d` from its centre. */
export function dabCoverage(d: number, radius: number, hardness: number): number {
  if (Number.isNaN(d) || d >= tipReach(radius, hardness) + 0.5) return 0;
  return tipFalloff(d, radius, hardness);
}

// ---------------------------------------------------------------------------
// Points → dabs
// ---------------------------------------------------------------------------

export interface Dab {
  x: number;
  y: number;
  radius: number;
  /** Flow (per-dab build-up). */
  alpha: number;
  /** Opacity ceiling this dab builds up to. */
  opacity: number;
  /** Radians. */
  angle: number;
  roundness: number;
}

/** Exponential smoothing of input points; the first and last point are kept. */
export function smoothPoints(points: readonly StrokePoint[], amount: number): StrokePoint[] {
  const a = 1 - Math.min(0.95, Math.max(0, amount));
  if (a >= 1 || points.length < 3) return points.slice();
  const out: StrokePoint[] = [];
  let cur: StrokePoint | null = null;
  for (const p of points) {
    const n: StrokePoint = cur ? { ...p, x: cur.x + (p.x - cur.x) * a, y: cur.y + (p.y - cur.y) * a } : p;
    out.push(n);
    cur = n;
  }
  out[out.length - 1] = points[points.length - 1];
  return out;
}

const pressureOf = (p: StrokePoint) => (typeof p.pressure === 'number' && Number.isFinite(p.pressure) ? Math.min(1, Math.max(0, p.pressure)) : 1);

/**
 * Walks points into dabs (incrementally: feed points in any chunks and get the same dabs). The
 * first point is a dab; then one every `spacing × diameter` along the path.
 */
export class DabWalker {
  private last: StrokePoint | null = null;
  private nextAt = 0;
  private pendingFirst: StrokePoint | null = null;

  constructor(readonly brush: BrushSettings) {}

  private diameter(p: StrokePoint): number {
    return this.brush.pressureSize ? this.brush.size * pressureOf(p) : this.brush.size;
  }

  private stepLen(p: StrokePoint): number {
    return Math.max(0.5, Math.max(1, this.diameter(p)) * Math.max(0.01, this.brush.spacing));
  }

  private dab(p: StrokePoint): Dab {
    const b = this.brush;
    return {
      x: p.x,
      y: p.y,
      radius: Math.max(0.5, this.diameter(p) / 2),
      alpha: Math.min(1, Math.max(0, b.flow)),
      opacity: b.pressureOpacity ? pressureOf(p) : 1,
      angle: (b.angle * Math.PI) / 180,
      roundness: Math.min(1, Math.max(0.01, b.roundness)),
    };
  }

  push(p: StrokePoint, out: Dab[]): void {
    const a = this.last;
    if (!a) {
      this.last = p;
      this.pendingFirst = p;
      this.nextAt = this.stepLen(p);
      return;
    }
    if (this.pendingFirst) {
      out.push(this.dab(this.pendingFirst));
      this.pendingFirst = null;
    }
    const dx = p.x - a.x;
    const dy = p.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-9) {
      while (this.nextAt <= len + 1e-9) {
        const f = Math.min(1, this.nextAt / len);
        const q: StrokePoint = {
          x: a.x + dx * f,
          y: a.y + dy * f,
          pressure: pressureOf(a) + (pressureOf(p) - pressureOf(a)) * f,
        };
        out.push(this.dab(q));
        this.nextAt += this.stepLen(q);
      }
      this.nextAt -= len;
    }
    this.last = p;
  }

  finish(out: Dab[]): void {
    if (this.pendingFirst) {
      out.push(this.dab(this.pendingFirst));
      this.pendingFirst = null;
    }
  }
}

/** All dabs of a point list (smoothing applied). */
export function walkDabs(points: readonly StrokePoint[], brush: BrushSettings): Dab[] {
  const w = new DabWalker(brush);
  const out: Dab[] = [];
  for (const p of smoothPoints(points, brush.smoothing)) w.push(p, out);
  w.finish(out);
  return out;
}

/** The pixel rectangle a dab can touch. */
export function dabRect(d: Dab, hardness: number): CropBox {
  // As `rasterizeDab`: the tip reaches `reach` across its minor axis and `reach / roundness` along it.
  const ro = Math.min(1, Math.max(0.5 / d.radius, d.roundness));
  const rm = Math.max(0.5, d.radius * ro);
  const r = Math.max(rm, tipReach(rm, hardness)) / ro + 1.5;
  const x0 = Math.floor(d.x - r);
  const y0 = Math.floor(d.y - r);
  return { x: x0, y: y0, width: Math.ceil(d.x + r) - x0, height: Math.ceil(d.y + r) - y0 };
}

/**
 * Rasterizes one dab over `rect` into `out` (rect.width × rect.height values, coverage × flow).
 * Small tips (radius below 3 px) take each pixel's covered area from a 4×4 grid.
 */
export function rasterizeDab(d: Dab, hardness: number, rect: CropBox, out: Float32Array): void {
  const w = rect.width;
  const h = rect.height;
  out.fill(0, 0, w * h);
  const r = d.radius;
  const ro = Math.min(1, Math.max(0.5 / r, d.roundness));
  const rm = Math.max(0.5, r * ro);
  const reach = Math.max(rm, tipReach(rm, hardness));
  const sn = Math.sin(d.angle);
  const cs = Math.cos(d.angle);
  const toTip = (dx: number, dy: number): [number, number] => {
    const ux = dx;
    const uy = -dy;
    return [ux * cs + uy * sn, -ux * sn + uy * cs];
  };
  const small = rm < SMALL_TIP_RADIUS;
  const reach2 = (reach + (small ? 0.75 : 0.5)) ** 2;
  for (let yy = 0; yy < h; yy++) {
    const dy = rect.y + yy + 0.5 - d.y;
    for (let xx = 0; xx < w; xx++) {
      const dx = rect.x + xx + 0.5 - d.x;
      const [u, v] = toTip(dx, dy);
      const d2 = (u * ro) ** 2 + v * v;
      if (d2 >= reach2) continue;
      let val: number;
      if (small) {
        let sum = 0;
        for (const sy of SUBPIXEL) {
          for (const sx of SUBPIXEL) {
            const [su, sv] = toTip(dx + sx, dy + sy);
            sum += tipFalloff(Math.sqrt((su * ro) ** 2 + sv * sv), rm, hardness);
          }
        }
        val = sum / 16;
      } else {
        val = dabCoverage(Math.sqrt(d2), rm, hardness);
      }
      if (val > 0) out[yy * w + xx] = val * d.alpha;
    }
  }
}

// ---------------------------------------------------------------------------
// Stroke coverage
// ---------------------------------------------------------------------------

const TILE_PIXELS = TILE * TILE;

/** A stroke's accumulated coverage, in 256 px tiles over document space. */
export class CoverageMap {
  readonly tiles = new Map<TileKey, Float32Array>();
  bounds: CropBox | null = null;
  private dirty = new Set<TileKey>();

  get(x: number, y: number): number {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    const t = this.tiles.get(tileKey(tx, ty));
    return t ? t[(y - ty * TILE) * TILE + (x - tx * TILE)] : 0;
  }

  /** Builds up `vals` (over `rect`) with flow towards `ceil`: `c ← c + v·(ceil − c)`. */
  accumulate(rect: CropBox, vals: Float32Array, ceil: number): void {
    if (rect.width <= 0 || rect.height <= 0) return;
    const w = rect.width;
    const tx0 = Math.floor(rect.x / TILE);
    const ty0 = Math.floor(rect.y / TILE);
    const tx1 = Math.floor((rect.x + rect.width - 1) / TILE);
    const ty1 = Math.floor((rect.y + rect.height - 1) / TILE);
    let touched = false;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const x0 = Math.max(rect.x, tx * TILE);
        const y0 = Math.max(rect.y, ty * TILE);
        const x1 = Math.min(rect.x + rect.width, tx * TILE + TILE);
        const y1 = Math.min(rect.y + rect.height, ty * TILE + TILE);
        let tile: Float32Array | undefined;
        for (let y = y0; y < y1; y++) {
          const row = (y - rect.y) * w;
          const trow = (y - ty * TILE) * TILE;
          for (let x = x0; x < x1; x++) {
            const v = vals[row + (x - rect.x)];
            if (v <= 0) continue;
            if (!tile) {
              const key = tileKey(tx, ty);
              tile = this.tiles.get(key);
              if (!tile) {
                tile = new Float32Array(TILE_PIXELS);
                this.tiles.set(key, tile);
              }
              this.dirty.add(key);
              touched = true;
            }
            const ti = trow + (x - tx * TILE);
            const c = tile[ti];
            if (ceil > c) tile[ti] = c + v * (ceil - c);
          }
        }
      }
    }
    if (touched) this.bounds = unionRect(this.bounds, rect);
  }

  /** Tiles changed since the last call. */
  takeDirty(): TileKey[] {
    const out = [...this.dirty];
    this.dirty.clear();
    return out;
  }
}

function unionRect(a: CropBox | null, b: CropBox): CropBox {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Paints a stroke's dabs into a coverage map, incrementally. */
export class StrokeCoverage {
  readonly coverage = new CoverageMap();
  private walker: DabWalker;
  private smoothing: number;
  private smoothPos: StrokePoint | null = null;
  private buf = new Float32Array(0);
  dabCount = 0;

  constructor(readonly brush: BrushSettings) {
    this.walker = new DabWalker(brush);
    this.smoothing = brush.smoothing;
  }

  /** Feeds input points; returns the document rectangles the new dabs touched. */
  push(points: readonly StrokePoint[]): CropBox[] {
    const dabs: Dab[] = [];
    for (const p of points) this.walker.push(this.smooth(p), dabs);
    return this.paint(dabs);
  }

  /** Ends the stroke (a single click still paints one dab). */
  finish(last?: StrokePoint): CropBox[] {
    const dabs: Dab[] = [];
    if (last && this.smoothPos && (this.smoothPos.x !== last.x || this.smoothPos.y !== last.y)) this.walker.push(last, dabs);
    this.walker.finish(dabs);
    return this.paint(dabs);
  }

  private smooth(p: StrokePoint): StrokePoint {
    const a = 1 - Math.min(0.95, Math.max(0, this.smoothing));
    const cur = this.smoothPos;
    const n = cur && a < 1 ? { ...p, x: cur.x + (p.x - cur.x) * a, y: cur.y + (p.y - cur.y) * a } : p;
    this.smoothPos = n;
    return n;
  }

  private paint(dabs: Dab[]): CropBox[] {
    const rects: CropBox[] = [];
    for (const d of dabs) {
      const rect = dabRect(d, this.brush.hardness);
      const n = rect.width * rect.height;
      if (this.buf.length < n) this.buf = new Float32Array(n);
      const vals = this.buf.subarray(0, n);
      rasterizeDab(d, this.brush.hardness, rect, vals);
      this.coverage.accumulate(rect, vals, d.opacity);
      rects.push(rect);
      this.dabCount++;
    }
    return rects;
  }
}

/** How a stroke changes pixels. */
export interface StrokeApply {
  /** `paint` puts colour down; `erase` removes alpha (or, with transparency locked, paints `background`). */
  mode: 'paint' | 'erase';
  /** RGBA 0..255 (paint colour, or the mask grey in `r`). */
  color: readonly [number, number, number, number];
  /** RGBA 0..255 the eraser paints on a transparency-locked layer (and on masks). */
  background: readonly [number, number, number, number];
  opacity: number;
  blend: BlendMode;
  lockTransparency: boolean;
  /** Selection coverage (document space, canvas-sized), or `null`. */
  selection: { width: number; height: number; data: ArrayLike<number> } | null;
  /** Layer offset (target pixels are in layer space). */
  offset: { x: number; y: number };
}

/**
 * Composites the stroke's coverage over `tileData` (the target's tile (tx, ty) as it was before
 * the stroke, in layer space; RGBA or one byte for masks) and returns the new tile data. With
 * `into` (the tile's previous result) and `region` (document space), only `region` is recomputed
 * and the rest of `into` is kept.
 */
export function applyStrokeToTile(
  coverage: CoverageMap,
  tileData: Uint8ClampedArray,
  channels: 1 | 4,
  tx: number,
  ty: number,
  s: StrokeApply,
  options: { into?: Uint8ClampedArray; region?: CropBox } = {}
): Uint8ClampedArray {
  const out = options.into ? new Uint8ClampedArray(options.into) : new Uint8ClampedArray(tileData);
  const ox = tx * TILE + s.offset.x;
  const oy = ty * TILE + s.offset.y;
  let x0 = 0;
  let y0 = 0;
  let x1 = TILE;
  let y1 = TILE;
  if (options.region) {
    const r = options.region;
    x0 = Math.max(0, Math.floor(r.x) - ox);
    y0 = Math.max(0, Math.floor(r.y) - oy);
    x1 = Math.min(TILE, Math.ceil(r.x + r.width) - ox);
    y1 = Math.min(TILE, Math.ceil(r.y + r.height) - oy);
    if (x1 <= x0 || y1 <= y0) return out;
    // Start the region from the pre-stroke pixels: coverage is cumulative.
    if (options.into) {
      for (let y = y0; y < y1; y++) out.set(tileData.subarray((y * TILE + x0) * channels, (y * TILE + x1) * channels), (y * TILE + x0) * channels);
    }
  }
  const sel = s.selection;
  const cb = [0, 0, 0, 0];
  const cs = [s.color[0] / 255, s.color[1] / 255, s.color[2] / 255, s.color[3] / 255];
  const bg = [s.background[0] / 255, s.background[1] / 255, s.background[2] / 255, s.background[3] / 255];
  // With a tile-aligned offset the layer tile is one coverage tile: read it directly.
  const aligned = s.offset.x % TILE === 0 && s.offset.y % TILE === 0;
  const covTile = aligned ? coverage.tiles.get(tileKey(Math.floor(ox / TILE), Math.floor(oy / TILE))) : undefined;
  if (aligned && !covTile) return out;
  for (let y = y0; y < y1; y++) {
    const dy = oy + y;
    for (let x = x0; x < x1; x++) {
      const dx = ox + x;
      const c = covTile ? covTile[y * TILE + x] : coverage.get(dx, dy);
      if (c <= 0) continue;
      let k = c * s.opacity;
      if (sel) {
        if (dx < 0 || dy < 0 || dx >= sel.width || dy >= sel.height) continue;
        k *= sel.data[dy * sel.width + dx] / 255;
      }
      if (k > 1) k = 1;
      if (k <= 0) continue;
      const p = y * TILE + x;
      if (channels === 1) {
        const target = s.mode === 'erase' ? s.background[0] : s.color[0];
        out[p] = Math.round(out[p] + (target - out[p]) * k);
        continue;
      }
      const i = p * 4;
      if (s.mode === 'erase' && !s.lockTransparency) {
        out[i + 3] = Math.round(out[i + 3] * (1 - k));
        continue;
      }
      if (s.lockTransparency && out[i + 3] === 0) continue;
      const src = s.mode === 'erase' ? bg : cs;
      for (let ch = 0; ch < 4; ch++) cb[ch] = out[i + ch] / 255;
      const o = blendPixel(s.blend, cb, src, k);
      out[i] = Math.round(o[0] * 255);
      out[i + 1] = Math.round(o[1] * 255);
      out[i + 2] = Math.round(o[2] * 255);
      if (!s.lockTransparency) out[i + 3] = Math.round(o[3] * 255);
    }
  }
  return out;
}

/** Tile coordinates of coverage tile keys (for callers that track dirty tiles). */
export function coverageTileCoord(key: TileKey): { tx: number; ty: number } {
  return tileCoord(key);
}
