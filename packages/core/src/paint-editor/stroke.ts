/**
 * A live stroke on one pixel layer. Points arrive while the pen moves; the layer shows the stroke
 * so far through a live surface (no history); `end()` commits it as one undo step.
 *
 * - Dab and eraser brushes: the coverage is cumulative, so each update recomposites the touched
 *   region from the pre-stroke tile (`applyStrokeToTile` with `into` and `region`).
 * - Dab-by-dab brushes (`PaintDabStroke`: the Mixer Brush, blender, smudge, and dab brushes that
 *   pick up paint or are multi-coloured): dabs read what earlier dabs laid down, so they paint
 *   into live tile copies; every tile written since the last update gets a new `Tile` object,
 *   because the compositor caches by tile identity.
 */

import { applyStrokeToTile, type StrokeApply } from '../paint/brush';
import { EMPTY_MIXER_LOAD, type PaintTileTarget } from '../paint/exchange';
import { cleanMixer, loadMixer, type MixerLoad } from '../paint/mixer';
import { TILE, TiledSurface, finishTile, tileKey, tilesInRect, type RasterRect, type Tile, type TileKey } from '../raster/surface';
import { usesPaintExchange, type PaintBrush } from './brushes';
import { PaintDabStroke } from './dab-stroke';
import { DryStroke, IDENTITY_COPY, type PenPoint, type StrokeCopy } from './engine';
import type { PaperGrain } from './paper';
import type { Affine } from './strokes';
import type { WetStrokeDriver } from './wet';
import { ThickStrokeDriver, type ThickChannels } from './thick';

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
  /** Mixer and wet-capable dab brushes: what the brush carries at the start of the stroke. */
  mixerLoad: MixerLoad;
  /** The secondary colour 0..255 RGBA (a multi-colour brush without its own colours uses it). */
  secondary?: readonly [number, number, number, number];
  /**
   * Wet brushes: the driver that applies the stroke to the wet layer, and the layer's current
   * pixels (the wet layer's display). The session's own surface is not used.
   */
  wet?: { driver: WetStrokeDriver; surface: () => TiledSurface };
  /** Impasto brushes: the layer's thick-paint channels before the stroke. */
  thick?: { channels: ThickChannels };
}

export interface PaintStrokeResult {
  layerId: string;
  /** Document rectangle the stroke touched, or `null` when no pixel changed. */
  bounds: RasterRect | null;
  dabs: number;
  /** Id of the recorded stroke (see `list_strokes` / `replay_strokes`), or `null` when nothing changed. */
  strokeId: string | null;
  /** Mixer and wet-capable dab brushes: what the brush carries after the stroke (cleaned unless it is dirty). */
  mixerLoad?: MixerLoad;
  /** Wet brushes: the paint is wet (it keeps moving until it dries; see dry_paint / advance_wet_paint). */
  wet?: boolean;
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
  private readonly wet: PaintDabStroke | null = null;
  private readonly wetDriver: WetStrokeDriver | null = null;
  private readonly thickDriver: ThickStrokeDriver | null = null;
  /** A wet stroke that ended while the simulation was mid-batch: it commits when the driver catches up. */
  private wetEndPending = false;
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
    if (init.wet) this.wetDriver = init.wet.driver;
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
    if (this.wetDriver) {
      // the wet layer paints; nothing else to set up
    } else if (init.thick) {
      const rgb = (c: readonly number[]): [number, number, number] => [c[0] / 255, c[1] / 255, c[2] / 255];
      this.thickDriver = new ThickStrokeDriver({ brush, target: this.tileTarget(), channels: init.thick.channels, color: rgb(init.color), load: init.mixerLoad, seed: init.seed, copies: this.copies });
    } else if (brush.engine === 'mixer' || brush.engine === 'blender' || brush.engine === 'smudge' || usesPaintExchange(brush)) {
      const rgb = (c: readonly number[]): [number, number, number] => [c[0] / 255, c[1] / 255, c[2] / 255];
      this.wet = new PaintDabStroke(brush, {
        target: this.tileTarget(),
        color: rgb(init.color),
        secondary: rgb(init.secondary ?? init.background),
        load: init.mixerLoad,
        grain: init.grain,
        paperDepth: init.paperDepth,
        seed: init.seed,
        copies: this.copies,
      });
    } else {
      this.dry = new DryStroke(brush, { grain: init.grain, paperDepth: init.paperDepth, seed: init.seed, copies: this.copies });
    }
  }

  private tileTarget(): PaintTileTarget {
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
    if (this.wetDriver) {
      this.wetUpdate(this.wetDriver.push(points));
      return;
    }
    this.update(this.dry ? this.dry.push(points) : this.thickDriver ? this.thickDriver.push(points) : this.wet!.push(points));
  }

  /** Impasto strokes: the layer's thick-paint channels with the stroke so far. */
  thickChannels(): ThickChannels | null {
    return this.thickDriver?.channels() ?? null;
  }

  /** Shows a wet stroke's progress (the wet layer's display). */
  wetUpdate(rects: RasterRect[]): void {
    if (!rects.length || !this.init.wet) return;
    for (const r of rects) this.bounds = union(this.bounds, r);
    this.host.update(this.layerId, this.init.wet.surface(), rects);
  }

  /** Whether a wet stroke has ended but waits for the simulation to finish a batch. */
  get pendingEnd(): boolean {
    return this.wetEndPending;
  }

  /** Completes a wet stroke whose end waited (the controller calls it when the driver is done). */
  completeWetEnd(): void {
    if (!this.wetEndPending || !this.wetDriver || !this.wetDriver.done) return;
    this.wetEndPending = false;
    this.finishWet();
  }

  private finishWet(): void {
    const d = this.wetDriver!;
    const changed = d.dabCount > 0;
    this.result = { layerId: this.layerId, bounds: changed ? d.bounds : null, dabs: d.dabCount, strokeId: null, wet: true };
    const carried = d.load;
    if (carried) this.result.mixerLoad = this.init.brush.behavior.dirty ? carried : cleanMixer(carried);
    this.host.commit(this, changed ? this.init.wet!.surface() : null, false);
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
    if (this.wetDriver) {
      this.wetUpdate(this.wetDriver.finish());
      this.closed = true;
      if (this.wetDriver.done) this.finishWet();
      else {
        this.wetEndPending = true;
        this.result = { layerId: this.layerId, bounds: this.bounds, dabs: this.wetDriver.dabCount, strokeId: null, wet: true };
      }
      return this.result!;
    }
    this.update(this.dry ? this.dry.finish() : this.thickDriver ? this.thickDriver.finish() : this.wet!.finish());
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
    // An impasto stroke can change only the relief (a knife on dry colour).
    if (this.thickDriver && this.thickDriver.dabCount > 0) changed = true;
    const surface = changed ? new TiledSurface(ch, tiles, this.base.defaultValue) : null;
    const dabs = this.dry ? this.dry.dabCount : this.thickDriver ? this.thickDriver.dabCount : this.wet!.dabCount;
    this.result = { layerId: this.layerId, bounds: changed ? this.bounds : null, dabs, strokeId: null };
    const carried = this.wet?.load ?? this.thickDriver?.load;
    if (carried) this.result.mixerLoad = this.init.brush.behavior.dirty ? carried : cleanMixer(carried);
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

/**
 * What any brush carries at the start of a stroke: the Mixer Brush as `mixerLoadForStroke`; a
 * wet-capable dab brush the paint colour, full, plus the carried paint when it is dirty; other
 * brushes nothing.
 */
export function brushLoadForStroke(brush: PaintBrush, current: MixerLoad, color: readonly [number, number, number]): MixerLoad {
  if (brush.engine === 'mixer') return mixerLoadForStroke(brush, current, color);
  if (brush.engine === 'impasto') return { reservoir: [color[0], color[1], color[2]], amount: 1, pickup: brush.behavior.dirty ? current.pickup : null };
  if (brush.engine === 'wet') return brush.wet.tool === 'paint' ? { reservoir: [color[0], color[1], color[2]], amount: 1, pickup: brush.behavior.dirty ? current.pickup : null } : EMPTY_MIXER_LOAD;
  if (usesPaintExchange(brush)) return { reservoir: [color[0], color[1], color[2]], amount: 1, pickup: brush.behavior.dirty ? current.pickup : null };
  return EMPTY_MIXER_LOAD;
}
