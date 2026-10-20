/**
 * Wet media in the paint editor (watercolour first): a layer painted with a wet brush gets a wet
 * layer in the document's `WetWorld` (`@pixerate/editor/paint`), and its pixels are the world's
 * display of it until the paint dries.
 *
 * - **Wet brushes** (`engine: 'wet'`) run through `WetStrokeDriver`: the same pen input as dry
 *   media (`PenDabWalker`: pressure, tilt, rotation, jitter, symmetry copies), each dab's tip
 *   coverage (quantised to 1/4096, so tiny floating-point differences between engines never reach
 *   the simulation) applied by the brush's wet tool. `paint` goes through the shared pick-up / mix
 *   exchange over a `WetMedium`, so a wet brush lifts and mixes wet paint like the phase 2 brushes.
 * - **Time** is the world's step clock. The host calls `tick` every frame (the bindings do); it
 *   steps at `speed` steps per second unless paused. Agents call `advance` or `dry`.
 * - **Dabs between steps.** Edits only happen between batches: points pushed while a batch runs
 *   (in Web Workers) wait for it, and every raw point records the clock it was applied at
 *   (`RecordedStroke.steps`), so a stroke replays exactly.
 * - **Drying.** Tiles that have dried are baked into the layer's pixels by the world; when a whole
 *   layer is dry its wet layer is dropped and it is an ordinary pixel layer again. `dry` dries at
 *   once. Saving and exporting use the deterministic bake of everything still wet ("wet paint is
 *   dried on save": the document holds dried pixels, never wet state).
 * - **Undo.** Each wet step of history keeps a snapshot of the world before and after it, within
 *   `undoMemory` bytes; older snapshots are dropped, and undoing past them leaves that paint dry
 *   as it looked.
 */

import { dabRect, rasterizeDab } from '../paint/brush';
import { exchangeRates, PaintExchange, type MixerLoad, type RgbTriple } from '../paint/exchange';
import { pigmentOf, PIGMENT_UNIT } from '../paint/wet/film';
import { DEFAULT_FLOW, flowField, normalizeFlow, type WetFlowSpec } from '../paint/wet/flow';
import { WetMedium } from '../paint/wet/medium';
import { DEFAULT_WET_PARAMS, FLAT, normalizeTilt, normalizeWetParams, type WetParams, type WetTilt } from '../paint/wet/model';
import { WetWorld, type WetBackendInfo, type WetLaneStats, type WetPaperInput, type WetSnapshot, type WetWorldOptions } from '../paint/wet/world';
import { TILE, TiledSurface, type RasterRect } from '../raster/surface';
import type { PaintBrush } from './brushes';
import { IDENTITY_COPY, PenDabWalker, PenSmoother, type PenDab, type PenPoint, type StrokeCopy } from './engine';
import { grainCatch, hexToRgb8, PaperGrain, type PaperGrain as PaperGrainType, type PaperSettings } from './paper';

/** Water depth a stroke lays at the tip's centre at `water` 1 (the sum over its dabs). */
const STROKE_WATER = 0.9;
/** Pigment mass a stroke lays at the tip's centre at `pigment` 1: a little more than a full-strength wash. */
const STROKE_MASS = PIGMENT_UNIT * 2.5;
/** Coverage quantum: dab coverage is rounded to this before it reaches the simulation. */
const COVERAGE_STEPS = 4096;

function union(a: RasterRect | null, b: RasterRect): RasterRect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** The paper as the wet simulation reads it. */
export function wetPaperInput(paper: PaperSettings): WetPaperInput {
  const grain = new PaperGrain(paper, 'wet');
  const flat = grain.flat;
  return {
    absorption: paper.absorption,
    permeability: paper.permeability,
    roughness: flat ? 0 : paper.roughness,
    color: hexToRgb8(paper.color),
    heightAt: flat ? () => 0.5 : (x, y) => grain.at(x, y),
  };
}

export interface WetStrokeInit {
  world: WetWorld;
  laneId: string;
  brush: PaintBrush;
  /** Paint colour, sRGB 0..1. */
  color: RgbTriple;
  load: MixerLoad;
  grain: PaperGrainType | null;
  paperDepth: number;
  paperColor: readonly [number, number, number];
  seed: number;
  copies: readonly StrokeCopy[];
}

interface CopyState {
  walker: PenDabWalker;
  exchange: PaintExchange | null;
  last: PenDab | null;
}

/**
 * One wet-brush stroke: pen samples → dabs → wet tool edits. Points are applied only while the
 * world is between batches (`flush` applies the ones that waited).
 */
export class WetStrokeDriver {
  dabCount = 0;
  bounds: RasterRect | null = null;
  /** The world's clock at which each raw point was applied (recorded with the stroke). */
  readonly steps: number[] = [];
  private readonly smoother: PenSmoother;
  private readonly states: CopyState[];
  private readonly medium: WetMedium;
  private readonly queue: PenPoint[] = [];
  private finishing = false;
  private finished = false;
  private lastRaw: PenPoint | null = null;
  private lastFed: PenPoint | null = null;
  private tip = new Float32Array(0);
  private cov = new Float32Array(0);
  private readonly paint: RgbTriple = [0, 0, 0];
  private readonly depth: number;

  constructor(readonly init: WetStrokeInit) {
    const brush = init.brush;
    this.smoother = new PenSmoother(brush.tip.smoothing, brush.pressureSmoothing);
    const copies = init.copies.length ? init.copies : [IDENTITY_COPY];
    const wet = brush.wet;
    const spacing = Math.max(0.02, brush.tip.spacing);
    // A stroke lays `STROKE_WATER × water` at the tip's centre: each dab a share by its spacing.
    const perDab = Math.min(1, spacing * 1.2);
    this.medium = new WetMedium(init.world, init.laneId, { water: STROKE_WATER * wet.water * perDab, mass: STROKE_MASS * wet.pigment * perDab, body: wet.body });
    const rates = exchangeRates(brush.behavior.pickup, brush.behavior.mix, 1, brush.behavior.mixing);
    this.states = copies.map((c, i) => ({
      walker: new PenDabWalker(brush, (init.seed + i * 7919) | 0, c.linear),
      exchange: wet.tool === 'paint' ? new PaintExchange(rates, init.load) : null,
      last: null,
    }));
    this.copies = copies;
    this.depth = init.grain && !init.grain.flat ? Math.min(1, Math.max(0, init.paperDepth * brush.grain)) : 0;
  }

  private readonly copies: readonly StrokeCopy[];

  /** What copy 0's brush carries after the dabs so far. */
  get load(): MixerLoad | null {
    return this.states[0].exchange?.load ?? null;
  }

  /** Whether every point (and the end) has been applied. */
  get done(): boolean {
    return this.finished;
  }

  /** Adds raw points; applies them now unless a batch is running. Returns where pixels changed. */
  push(points: readonly PenPoint[]): RasterRect[] {
    for (const p of points) this.queue.push(p);
    return this.flush();
  }

  /** Asks for the end; it happens now unless a batch is running (then at the next `flush`). */
  finish(): RasterRect[] {
    this.finishing = true;
    return this.flush();
  }

  /** Applies waiting points (and the end, when asked) if the world is between batches. */
  flush(): RasterRect[] {
    const rects: RasterRect[] = [];
    if (this.init.world.busy || this.finished) return rects;
    while (this.queue.length) {
      const raw = this.queue.shift()!;
      this.steps.push(this.init.world.clock);
      this.lastRaw = raw;
      const p = this.smoother.push(raw);
      this.lastFed = p;
      this.copies.forEach((c, i) => {
        const dabs: PenDab[] = [];
        this.states[i].walker.push(c.map(p), dabs);
        this.applyDabs(i, dabs, rects);
      });
    }
    if (this.finishing) {
      const raw = this.lastRaw;
      const fed = this.lastFed;
      this.copies.forEach((c, i) => {
        const dabs: PenDab[] = [];
        if (raw && fed && (raw.x !== fed.x || raw.y !== fed.y)) this.states[i].walker.push(c.map({ ...raw, pressure: fed.pressure }), dabs);
        this.states[i].walker.finish(dabs);
        this.applyDabs(i, dabs, rects);
      });
      this.finished = true;
    }
    for (const r of rects) this.bounds = union(this.bounds, r);
    return rects;
  }

  private applyDabs(copy: number, dabs: PenDab[], rects: RasterRect[]): void {
    for (const d of dabs) {
      const rect = dabRect(d, this.init.brush.tip.hardness);
      if (rect.width <= 0 || rect.height <= 0) continue;
      this.dab(copy, d, rect);
      rects.push(rect);
      this.dabCount++;
    }
  }

  /** The tip's coverage over `rect`, with the grain, quantised. */
  private coverage(d: PenDab, rect: RasterRect): { tip: Float32Array; cov: Float32Array } {
    const n = rect.width * rect.height;
    if (this.tip.length < n) {
      this.tip = new Float32Array(n);
      this.cov = new Float32Array(n);
    }
    const tip = this.tip.subarray(0, n);
    const cov = this.cov.subarray(0, n);
    tip.fill(0);
    rasterizeDab({ ...d, alpha: 1 }, this.init.brush.tip.hardness, rect, tip);
    const grain = this.depth > 0 ? this.init.grain : null;
    for (let yy = 0, k = 0; yy < rect.height; yy++) {
      for (let xx = 0; xx < rect.width; xx++, k++) {
        let v = tip[k];
        if (v > 0 && grain) v *= grainCatch(grain.at(rect.x + xx + 0.5, rect.y + yy + 0.5), this.depth, d.pressure);
        tip[k] = Math.round(tip[k] * COVERAGE_STEPS) / COVERAGE_STEPS;
        cov[k] = Math.round(v * COVERAGE_STEPS) / COVERAGE_STEPS;
      }
    }
    return { tip, cov };
  }

  private dab(copy: number, d: PenDab, rect: RasterRect): void {
    const { world, laneId, brush } = this.init;
    const wet = brush.wet;
    const st = this.states[copy];
    const { tip, cov } = this.coverage(d, rect);
    // How hard this dab works: flow, pressure (pressureOpacity) and the tip's opacity.
    const k = Math.round(Math.min(1, d.alpha * d.opacity * brush.tip.opacity) * COVERAGE_STEPS) / COVERAGE_STEPS;
    if (!(k > 0)) return;
    switch (wet.tool) {
      case 'paint': {
        const ex = st.exchange!;
        ex.pickUp(this.medium.sample(rect, tip));
        const total = ex.paint(this.paint);
        if (total > 0) this.medium.deposit(rect, cov, Math.min(1, total) * k, this.paint, null);
        else world.paint(laneId, rect, cov, this.medium.options.water * k, null);
        ex.drain();
        if (wet.rewet > 0) world.rewet(laneId, rect, cov, wet.rewet * k * 0.15, this.init.paperColor);
        break;
      }
      case 'water': {
        world.paint(laneId, rect, cov, this.medium.options.water * k * (wet.water > 0 ? 1 : 0), null);
        if (wet.rewet > 0) world.rewet(laneId, rect, cov, wet.rewet * k * 0.15, this.init.paperColor);
        break;
      }
      case 'dry':
        world.remove(laneId, rect, cov, wet.strength * 0.35 * k, 0, 0, wet.strength * 0.35 * k);
        break;
      case 'blow': {
        // Along the direction of travel (dab directions are counter-clockwise with y up).
        const s = wet.strength * 0.08 * k;
        world.push(laneId, rect, cov, Math.cos(d.direction) * s, -Math.sin(d.direction) * s);
        break;
      }
      case 'blend':
        world.blend(laneId, rect, cov, wet.strength * k);
        break;
      case 'smudge': {
        if (st.last) world.drag(laneId, rect, cov, d.x - st.last.x, d.y - st.last.y, wet.strength * k);
        break;
      }
      case 'blot':
        world.remove(laneId, rect, cov, wet.strength * 0.8 * k, wet.strength * 0.6 * k, wet.strength * 0.15 * k, wet.strength * 0.5 * k);
        break;
    }
    st.last = d;
  }
}

/** Settings of one wet layer (saved with the document). */
export interface WetLayerSettings {
  params: WetParams;
  flow: WetFlowSpec;
}

/** One wet layer as tools describe it. */
export interface WetLayerInfo {
  layerId: string;
  /** Surface water anywhere on the layer. */
  wet: boolean;
  /** Cells with surface water. */
  wetCells: number;
  /** Where the surface water is, or `null`. */
  wetBounds: RasterRect | null;
  /** 256 px tiles being simulated. */
  activeTiles: number;
  params: WetParams;
  flow: WetFlowSpec;
}

/** An event recorded with the clock it happened at (strokes are recorded separately), for replays. */
export interface WetEvent {
  clock: number;
  kind: 'dry' | 'tilt' | 'params' | 'flow' | 'wet-paper';
  layerId?: string;
  data?: unknown;
}

export interface PaintWetHost {
  canvas(): { width: number; height: number };
  paper(): PaperSettings;
  /** The layer's current pixels (`null` when it is not a pixel layer). */
  layerSurface(id: string): TiledSurface | null;
  /** Shows new pixels for wet layers (not an undo step); `rects` are where they changed. */
  updateSurfaces(surfaces: ReadonlyMap<string, TiledSurface>, rects: RasterRect[]): void;
  /** The paint dried while time passed (the editor records nothing, it just redraws). */
  changed(): void;
}

export interface PaintWetOptions extends WetWorldOptions {
  /** Steps per second while time runs (default 120). */
  speed?: number;
  /** Bytes of wet snapshots kept for undo (default 512 MB). */
  undoMemory?: number;
}

/** Tiles reshaded per frame at most (the rest catch up over the next frames). */
const DISPLAY_TILES_PER_TICK = 24;

/** The paint editor's wet layers: one `WetWorld` per canvas, its settings and time. */
export class PaintWetLayers {
  world: WetWorld | null = null;
  tilt: WetTilt = { ...FLAT };
  readonly settings = new Map<string, WetLayerSettings>();
  paused = false;
  speed: number;
  overlay = false;
  readonly undoMemory: number;
  /** The live wet stroke, if any. */
  driver: WetStrokeDriver | null = null;
  private lastTick: number | null = null;
  private ticking: Promise<void> | null = null;
  private stepsOwed = 0;

  constructor(
    private readonly host: PaintWetHost,
    private readonly options: PaintWetOptions = {}
  ) {
    this.speed = Math.max(1, Math.min(2000, options.speed ?? 120));
    this.undoMemory = Math.max(0, options.undoMemory ?? 512 * 1024 * 1024);
  }

  /** The world (made on first use, at the canvas size). */
  ensureWorld(): WetWorld {
    const { width, height } = this.host.canvas();
    if (this.world && (this.world.width !== width || this.world.height !== height)) throw new Error('The wet world is the wrong size; dry the paint before resizing the canvas.');
    if (!this.world) {
      this.world = new WetWorld(width, height, wetPaperInput(this.host.paper()), { kernel: this.options.kernel, threads: this.options.threads });
      this.world.setTilt(this.tilt);
    }
    return this.world;
  }

  /** Whether any layer (or `layerId`) has wet paint. */
  isWet(layerId?: string): boolean {
    const w = this.world;
    if (!w) return false;
    if (layerId !== undefined) return w.hasLane(layerId) && w.isActive(layerId);
    return w.laneIds().some((id) => w.isActive(id));
  }

  /** Layers holding a wet layer (wet or drying). */
  wetLayerIds(): string[] {
    return this.world?.laneIds() ?? [];
  }

  /** Whether a batch is running (edits wait). */
  get busy(): boolean {
    return Boolean(this.world?.busy);
  }

  /** Resolves when no batch is running. */
  async idle(): Promise<void> {
    while (this.ticking) await this.ticking;
  }

  settingsOf(layerId: string): WetLayerSettings {
    let s = this.settings.get(layerId);
    if (!s) {
      s = { params: { ...DEFAULT_WET_PARAMS }, flow: { ...DEFAULT_FLOW } };
      this.settings.set(layerId, s);
    }
    return s;
  }

  /** Puts a layer in the world (its current pixels become the base under the wet paint). */
  ensureLane(layerId: string): WetWorld {
    const w = this.ensureWorld();
    if (!w.hasLane(layerId)) {
      const base = this.host.layerSurface(layerId) ?? new TiledSurface(4, new Map(), 0);
      const s = this.settingsOf(layerId);
      w.ensureLane(layerId, { params: s.params, base });
      const { width, height } = this.host.canvas();
      if (s.flow.kind !== 'none') w.setFlow(layerId, flowField(s.flow, width, height), s.flow.strength);
    }
    return w;
  }

  setParams(layerId: string, update: Partial<WetParams>): WetParams {
    const s = this.settingsOf(layerId);
    s.params = normalizeWetParams(update, s.params);
    if (this.world?.hasLane(layerId)) this.world.setParams(layerId, s.params);
    return { ...s.params };
  }

  setFlow(layerId: string, update: Partial<WetFlowSpec>): WetFlowSpec {
    const s = this.settingsOf(layerId);
    s.flow = normalizeFlow(update, s.flow);
    if (this.world?.hasLane(layerId)) {
      const { width, height } = this.host.canvas();
      this.world.setFlow(layerId, flowField(s.flow, width, height), s.flow.strength);
    }
    return { ...s.flow };
  }

  setTilt(update: Partial<WetTilt>): WetTilt {
    this.tilt = normalizeTilt(update, this.tilt);
    this.world?.setTilt(this.tilt);
    return { ...this.tilt };
  }

  /** The paper changed. */
  paperChanged(): void {
    this.world?.setPaper(wetPaperInput(this.host.paper()));
  }

  /** A layer as tools describe it. */
  info(layerId: string): WetLayerInfo {
    const s = this.settingsOf(layerId);
    const st: WetLaneStats | null = this.world?.hasLane(layerId) ? this.world.stats(layerId) : null;
    return {
      layerId,
      wet: Boolean(st && st.wetCells > 0),
      wetCells: st?.wetCells ?? 0,
      wetBounds: st?.wetBounds ?? null,
      activeTiles: st?.activeTiles ?? 0,
      params: { ...s.params },
      flow: { ...s.flow },
    };
  }

  backend(): WetBackendInfo | null {
    return this.world?.backend() ?? null;
  }

  /** Shows the current wet pixels (at most `maxTiles` reshaded per layer). */
  syncDisplays(maxTiles = Infinity): RasterRect[] {
    const w = this.world;
    if (!w) return [];
    const surfaces = new Map<string, TiledSurface>();
    const rects: RasterRect[] = [];
    for (const id of w.laneIds()) {
      const d = w.display(id, maxTiles);
      if (this.host.layerSurface(id) !== d.surface) surfaces.set(id, d.surface);
      rects.push(...d.changed);
    }
    if (surfaces.size) this.host.updateSurfaces(surfaces, rects);
    return rects;
  }

  /** Drops the wet layers whose paint has all dried (they become ordinary pixel layers). */
  private retireDry(): void {
    const w = this.world;
    if (!w) return;
    for (const id of w.laneIds()) {
      if (w.isActive(id) || this.driver?.init.laneId === id) continue;
      const base = w.getBase(id);
      w.removeLane(id);
      this.host.updateSurfaces(new Map([[id, base]]), []);
    }
  }

  /**
   * Advances time by the wall clock (`now` in ms, e.g. `performance.now()`): `speed` steps per
   * second, at most `maxSteps` per call. Call it every frame; it does nothing while paused or dry.
   * Resolves when the steps are done and the display is up to date.
   */
  tick(now: number, maxSteps = 8): Promise<void> {
    if (this.ticking) return this.ticking;
    const last = this.lastTick;
    this.lastTick = now;
    const w = this.world;
    if (!w || this.paused || last === null) {
      this.flushDriver();
      return Promise.resolve();
    }
    if (!w.isActive()) {
      this.flushDriver();
      this.retireDry();
      return Promise.resolve();
    }
    this.stepsOwed = Math.min(maxSteps * 4, this.stepsOwed + ((now - last) / 1000) * this.speed);
    const n = Math.min(maxSteps, Math.floor(this.stepsOwed));
    if (n < 1) {
      this.flushDriver();
      return Promise.resolve();
    }
    this.stepsOwed -= n;
    const run = (async () => {
      try {
        await w.step(n);
      } finally {
        this.ticking = null;
      }
      this.flushDriver();
      this.syncDisplays(DISPLAY_TILES_PER_TICK);
      this.retireDry();
      this.host.changed();
    })();
    this.ticking = run;
    return run;
  }

  private flushDriver(): void {
    const d = this.driver;
    if (!d || !this.world) return;
    const rects = d.flush();
    if (rects.length) this.syncDisplays(DISPLAY_TILES_PER_TICK);
    if (d.done) this.onDriverDone?.(d);
  }

  /** Called when a live stroke that ended mid-batch has finished applying. */
  onDriverDone: ((driver: WetStrokeDriver) => void) | null = null;

  /** Steps `steps` times now (agents, tests). Returns the steps run. */
  async advance(steps: number): Promise<number> {
    await this.idle();
    const w = this.world;
    if (!w || !w.isActive()) return 0;
    // The fastest kernel (it gives the same bits; the TypeScript one is only a stand-in while it loads).
    await w.ready;
    await this.idle();
    const start = w.clock;
    const n = Math.max(0, Math.floor(steps));
    const job = (async () => {
      try {
        await w.step(n);
      } finally {
        this.ticking = null;
      }
    })();
    this.ticking = job;
    await job;
    this.syncDisplays();
    this.retireDry();
    return w.clock - start;
  }

  /**
   * Dries at once (everything settles where it is), on one layer or all, optionally only in a
   * rectangle. Returns the layers and rectangles that dried.
   */
  dry(layerId?: string, rect?: RasterRect): Array<{ layerId: string; bounds: RasterRect | null }> {
    const w = this.world;
    if (!w) return [];
    const ids = layerId !== undefined ? (w.hasLane(layerId) ? [layerId] : []) : w.laneIds();
    const out: Array<{ layerId: string; bounds: RasterRect | null }> = [];
    for (const id of ids) out.push({ layerId: id, bounds: w.dry(id, rect) });
    this.syncDisplays();
    this.retireDry();
    return out;
  }

  /** The layer's pixels with all its wet paint dried (deterministic), without changing anything. */
  bakedSurface(layerId: string): TiledSurface | null {
    const w = this.world;
    if (!w?.hasLane(layerId)) return null;
    return w.bakedSurface(layerId);
  }

  /** A snapshot of the world for undo (`null` when there is none). */
  snapshot(): WetSnapshot | null {
    const w = this.world;
    if (!w || !w.laneIds().length) return null;
    return w.snapshot();
  }

  /** Puts a snapshot back (`null`: no wet layers). Returns the layer surfaces it implies. */
  restore(snap: WetSnapshot | null): void {
    if (!snap) {
      if (this.world) for (const id of this.world.laneIds()) this.world.removeLane(id);
      return;
    }
    this.ensureWorld().restore(snap);
    this.syncDisplays();
  }

  /** Forgets everything wet (a new canvas, a resize, opening a document). */
  reset(): void {
    this.world?.destroy();
    this.world = null;
    this.driver = null;
    this.settings.clear();
    this.lastTick = null;
    this.stepsOwed = 0;
  }

  /** Water overlay tiles (RGBA) over a document rectangle, for the view. */
  waterOverlay(rect: RasterRect): Array<{ tx: number; ty: number; data: Uint8ClampedArray }> {
    const w = this.world;
    if (!w) return [];
    const out: Array<{ tx: number; ty: number; data: Uint8ClampedArray }> = [];
    const tx0 = Math.max(0, Math.floor(rect.x / TILE));
    const ty0 = Math.max(0, Math.floor(rect.y / TILE));
    const tx1 = Math.floor((rect.x + rect.width - 1) / TILE);
    const ty1 = Math.floor((rect.y + rect.height - 1) / TILE);
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        let merged: Uint8ClampedArray | null = null;
        for (const id of w.laneIds()) {
          const t = w.waterOverlay(id, tx, ty);
          if (!t) continue;
          if (!merged) merged = t;
          else for (let i = 3; i < t.length; i += 4) merged[i] = Math.max(merged[i], t[i]);
        }
        if (merged) out.push({ tx, ty, data: merged });
      }
    return out;
  }

  destroy(): void {
    this.world?.destroy();
    this.world = null;
  }
}

/** The pigment (K r, g, b, S) of a colour at a body, per unit mass (for tools that report it). */
export function wetPigmentOf(hex: string, body: number): number[] {
  const [r, g, b] = hexToRgb8(hex);
  return Array.from(pigmentOf([r / 255, g / 255, b / 255], body));
}
