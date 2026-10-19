/**
 * A live stroke on one pixel layer. Points arrive while the pen moves; the layer shows the stroke
 * so far through a live surface (no history); `end()` commits it as one undo step.
 *
 * - Dab and eraser brushes: the coverage is cumulative, so each update recomposites the touched
 *   region from the pre-stroke tile (`applyStrokeToTile` with `into` and `region`).
 * - Mixer engine brushes (Mixer Brush, blender, smudge): dabs read what earlier dabs laid down, so
 *   they paint into live tile copies; every tile written since the last update gets a new `Tile`
 *   object, because the compositor caches by tile identity.
 */

import { applyStrokeToTile, type StrokeApply } from '../paint/brush';
import { MixerStroke, cleanMixer, loadMixer, type MixerLoad, type MixerTarget } from '../paint/mixer';
import { TILE, TiledSurface, finishTile, tileKey, tilesInRect, type RasterRect, type Tile, type TileKey } from '../raster/surface';
import type { PaintBrush } from './brushes';
import { DryStroke, IDENTITY_COPY, PenSmoother, mixerTip, toStrokePoint, type PenPoint, type StrokeCopy } from './engine';
import type { PaperGrain } from './paper';
import type { Affine } from './strokes';

export interface StrokeSessionHost {
  /** Shows the layer's live surface (no history); `rects` are where it changed. */
  update(layerId: string, surface: TiledSurface, rects: RasterRect[]): void;
  /** Ends the stroke: `surface` is the new pixels, or `null` when nothing changed / it was cancelled. */
  commit(session: PaintStrokeSession, surface: TiledSurface | null, cancelled: boolean): void;
}

export interface StrokeSessionInit {
  layerId: string;
  surface: TiledSurface;
  offset: { x: number; y: number };
  lockTransparency: boolean;
  brush: PaintBrush;
  /** Paint colour 0..255 RGBA. */
  color: readonly [number, number, number, number];
  /** What the eraser paints on a transparency-locked layer (the paper colour). */
  background: readonly [number, number, number, number];
  grain: PaperGrain | null;
  paperDepth: number;
  seed: number;
  /** The paint colour as #rrggbb (recorded with the stroke). */
  colorHex: string;
  /** The stroke's extra copies as affine maps (recorded with the stroke); `copies` holds all of them as engine copies. */
  affineCopies: readonly Affine[];
  copies: readonly StrokeCopy[];
  /** Applied to each raw sample before it is painted and recorded (perspective snapping). */
  inputFilter?: (p: PenPoint) => PenPoint;
  /** Mixer engine: the brush load at the start of the stroke. */
  mixerLoad: MixerLoad;
}

export interface PaintStrokeResult {
  layerId: string;
  /** Document rectangle the stroke touched, or `null` when no pixel changed. */
  bounds: RasterRect | null;
  dabs: number;
  /** Id of the recorded stroke (see `list_strokes` / `replay_strokes`), or `null` when nothing changed. */
  strokeId: string | null;
  /** Mixer engine brushes: what the brush carries after the stroke. */
  mixerLoad?: MixerLoad;
}

function defaultTile(surface: TiledSurface): Uint8ClampedArray {
  const data = new Uint8ClampedArray(TILE * TILE * surface.channels);
  if (surface.defaultValue) data.fill(surface.defaultValue);
  return data;
}

function sameTile(a: Tile | undefined, b: Tile | null): boolean {
  if (!a || !b) return !a && !b;
  if (a === b) return true;
  if (a.uniform !== null || b.uniform !== null) return a.uniform === b.uniform;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

function union(a: RasterRect | null, b: RasterRect): RasterRect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

export class PaintStrokeSession {
  readonly layerId: string;
  /** The raw input so far (what a replay feeds back in). */
  readonly points: PenPoint[] = [];
  private readonly base: TiledSurface;
  private readonly live: Map<TileKey, Tile>;
  private readonly touched = new Set<TileKey>();
  private readonly fresh = new Set<TileKey>();
  private readonly dry: DryStroke | null = null;
  private readonly mixers: MixerStroke[] = [];
  private readonly mixerSmoother: PenSmoother | null = null;
  private readonly apply: StrokeApply;
  private readonly copies: readonly StrokeCopy[];
  private bounds: RasterRect | null = null;
  private lastRaw: PenPoint | null = null;
  private closed = false;
  result: PaintStrokeResult | null = null;

  constructor(private readonly host: StrokeSessionHost, readonly init: StrokeSessionInit) {
    this.layerId = init.layerId;
    this.base = init.surface;
    this.live = new Map(this.base.tiles);
    this.copies = init.copies.length ? init.copies : [IDENTITY_COPY];
    const brush = init.brush;
    this.apply = {
      mode: brush.engine === 'eraser' ? 'erase' : 'paint',
      color: init.color,
      background: init.background,
      opacity: brush.tip.opacity,
      blend: brush.tip.blend,
      lockTransparency: init.lockTransparency,
      selection: null,
      offset: init.offset,
    };
    if (brush.engine === 'mixer') {
      this.mixerSmoother = new PenSmoother(brush.tip.smoothing, brush.pressureSmoothing);
      const load = init.mixerLoad;
      for (let i = 0; i < this.copies.length; i++) this.mixers.push(new MixerStroke(mixerTip(brush), brush.mixer, load, this.mixerTarget()));
    } else {
      this.dry = new DryStroke(brush, { grain: init.grain, paperDepth: init.paperDepth, seed: init.seed, copies: this.copies });
    }
  }

  private mixerTarget(): MixerTarget {
    return {
      offset: this.init.offset,
      lockTransparency: this.init.lockTransparency,
      selection: null,
      readTile: (tx, ty) => this.live.get(tileKey(tx, ty))?.data ?? null,
      writeTile: (tx, ty) => {
        const key = tileKey(tx, ty);
        if (!this.touched.has(key)) {
          const src = this.base.tiles.get(key)?.data ?? defaultTile(this.base);
          this.live.set(key, { data: new Uint8ClampedArray(src), uniform: null });
          this.touched.add(key);
        }
        this.fresh.add(key);
        return this.live.get(key)!.data;
      },
    };
  }

  get open(): boolean {
    return !this.closed;
  }

  /** Adds raw pen samples (document pixels). */
  push(points: readonly PenPoint[]): void {
    if (this.closed || !points.length) return;
    const filter = this.init.inputFilter;
    if (filter) points = points.map(filter);
    for (const p of points) this.points.push(p);
    this.lastRaw = points[points.length - 1];
    if (this.dry) this.update(this.dry.push(points));
    else {
      const rects: RasterRect[] = [];
      for (const raw of points) {
        const p = toStrokePoint(this.mixerSmoother!.push(raw));
        this.copies.forEach((c, i) => rects.push(...this.mixers[i].push([toStrokePoint(c.map(p))])));
      }
      this.update(rects);
    }
  }

  private update(rects: RasterRect[]): void {
    if (!rects.length) return;
    for (const r of rects) this.bounds = union(this.bounds, r);
    const ch = this.base.channels;
    if (!this.dry) {
      for (const key of this.fresh) this.live.set(key, { data: this.live.get(key)!.data, uniform: null });
      this.fresh.clear();
      this.host.update(this.layerId, new TiledSurface(ch, new Map(this.live), this.base.defaultValue), rects);
      return;
    }
    const off = this.init.offset;
    const regions = new Map<TileKey, { tx: number; ty: number; r: RasterRect }>();
    for (const r of rects) {
      for (const t of tilesInRect({ x: r.x - off.x, y: r.y - off.y, width: r.width, height: r.height })) {
        const key = tileKey(t.tx, t.ty);
        const cur = regions.get(key);
        regions.set(key, { tx: t.tx, ty: t.ty, r: cur ? union(cur.r, r) : r });
      }
    }
    for (const [key, { tx, ty, r }] of regions) {
      const src = this.base.tiles.get(key)?.data ?? defaultTile(this.base);
      const prev = this.touched.has(key) ? this.live.get(key)?.data : undefined;
      this.touched.add(key);
      const data = applyStrokeToTile(this.dry.coverage, src, ch, tx, ty, this.apply, prev ? { into: prev, region: r } : {});
      this.live.set(key, { data, uniform: null });
    }
    this.host.update(this.layerId, new TiledSurface(ch, new Map(this.live), this.base.defaultValue), rects);
  }

  /** Ends the stroke (one undo step) and returns what changed. */
  end(): PaintStrokeResult {
    if (this.closed) throw new Error('This stroke has already ended.');
    if (this.dry) this.update(this.dry.finish());
    else {
      const rects: RasterRect[] = [];
      const last = this.lastRaw ? toStrokePoint(this.lastRaw) : undefined;
      this.copies.forEach((c, i) => rects.push(...this.mixers[i].finish(last ? toStrokePoint(c.map(last)) : undefined)));
      this.update(rects);
    }
    this.closed = true;
    const ch = this.base.channels;
    const tiles = new Map(this.base.tiles);
    let changed = false;
    for (const key of this.touched) {
      const tile = finishTile(this.live.get(key)!.data, ch, this.base.defaultValue);
      const prev = this.base.tiles.get(key);
      if (tile) tiles.set(key, tile);
      else tiles.delete(key);
      if (!sameTile(prev, tile)) changed = true;
    }
    const surface = changed ? new TiledSurface(ch, tiles, this.base.defaultValue) : null;
    const dabs = this.dry ? this.dry.dabCount : this.mixers.reduce((n, m) => n + m.dabCount, 0);
    this.result = { layerId: this.layerId, bounds: changed ? this.bounds : null, dabs, strokeId: null };
    if (this.mixers.length) {
      const brush = this.init.brush;
      let load = this.mixers[0].load;
      if (brush.mixer.cleanEachStroke) load = cleanMixer(load);
      this.result.mixerLoad = load;
    }
    this.host.commit(this, surface, false);
    return this.result;
  }

  /** Abandons the stroke and restores the layer. */
  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.host.commit(this, null, true);
  }
}

/** The Mixer Brush load a stroke starts with. */
export function mixerLoadForStroke(brush: PaintBrush, current: MixerLoad, color: readonly [number, number, number]): MixerLoad {
  if (!brush.loadsColor) return { reservoir: null, amount: 0, pickup: brush.mixer.cleanEachStroke ? null : current.pickup };
  if (brush.mixer.loadEachStroke || !current.reservoir) return loadMixer(current, color);
  return current;
}
