/**
 * `WetWorld`: the wet-media simulation of one canvas. It holds up to `MAX_WET_LANES` wet layers
 * ("lanes"), each a sparse set of 256 px tile slots in one `WebAssembly.Memory`, and steps all of
 * them together.
 *
 * - **Kernels.** It starts on the TypeScript kernel at once and switches to the WebAssembly SIMD
 *   kernel (in Web Workers when the page is cross-origin isolated, else on this thread) as soon as
 *   that has loaded. The kernels give identical bits, so the switch never changes the painting.
 * - **Determinism.** Time is counted in steps (`clock`), never in wall time. Batches never cross a
 *   multiple of `FREE_INTERVAL` and are at most `MAX_BATCH` steps, tiles wake up when anything
 *   alive comes within `STRIP` cells of their edge (so earlier or later wake-ups change nothing),
 *   and dry tiles are baked and freed only on multiples of `FREE_INTERVAL`, judged by their state
 *   at that step. So the result depends only on the edits and the steps at which they were made,
 *   not on frame rate, batch sizes, worker counts or the browser.
 * - **Edits** (dabs, water, drying, blowing, blending, smudging, blotting, re-wetting) run on this
 *   thread between batches; while a batch runs (`busy`) they throw, so callers queue them.
 * - **Display.** Each lane has a `base` surface: the layer's pixels under the wet paint. `display`
 *   gives the base with every live tile shaded (`filmPixel`), as an ordinary RGBA surface for the
 *   compositor. Tiles that dry are baked into the base and their slots freed.
 * - **Engine B (WebGPU).** With a GPU engine attached (`attachGpu`) and at least `gpuMinTiles` live
 *   tiles, the GPU keeps a mirror of the slots: each edit uploads the rows it changed, each batch
 *   runs on the GPU too, and `displayGpu` shades every stale tile there at once. The CPU state stays
 *   the authority (edits, reads, drying, snapshots, baking); the GPU's copy only feeds the display.
 */

import { TILE, TiledSurface, finishTile, tileKey, type RasterRect, type Tile } from '../../raster/surface';
import { filmPixel, pixelPigment, shadeTile } from './film';
import { stepSlotTs } from './kernel';
import {
  DEFAULT_WET_PAPER,
  DEFAULT_WET_PARAMS,
  DRY_EPS,
  EX,
  EY,
  FLAG_ALIVE,
  FLAG_BOTTOM,
  FLAG_LEFT,
  FLAG_RIGHT,
  FLAG_TOP,
  FLAT,
  FREE_INTERVAL,
  MAX_BATCH,
  P_D0,
  P_FX,
  P_FY,
  P_H,
  P_P0,
  P_RHO,
  P_SW,
  P_UX,
  P_UY,
  PARAM_FLOATS,
  PLANE,
  SET_PLANES,
  SLOT_BYTES,
  SLOT_PLANES,
  SLOT_SIDE,
  STRIP,
  W9,
  WET_TILE,
  normalizeTilt,
  PAPER_CAPACITY,
  normalizeWetParams,
  packWetParams,
  type WetPaper,
  type WetParams,
  type WetTilt,
} from './model';
import { canShareMemory, loadWetKernel, wetSimdSupported, wetSupport, WetWorkerPool, type WetSupport, type WetWorkerLayout } from './wasm';
import type { WetGpuEngine, WetGpuJob } from './gpu';

/** Wet layers a world can hold at once. */
export const MAX_WET_LANES = 8;
/** Tile slots at most (about 3.8 GB, inside wasm32's 4 GB). Water reaching a tile past this is lost. */
export const MAX_WET_SLOTS = 352;
/** Floats per slot. */
const SLOT_FLOATS = SLOT_PLANES * PLANE;
const S = SLOT_SIDE;
/** Planes a snapshot keeps per slot: the current set and the deposit. */
const SNAP_PLANES = SET_PLANES + 4;

/** A flow map: a vector per document pixel, in cells per step² at strength 1. */
export type WetFlowField = (x: number, y: number) => readonly [number, number];

/** The paper as the simulation reads it. */
export interface WetPaperInput extends WetPaper {
  /** Grain height 0..1 at a document position (the paper's wet height map). */
  heightAt(x: number, y: number): number;
  /** Paper colour, sRGB bytes. */
  color: readonly [number, number, number];
}

export type WetKernelKind = 'typescript' | 'wasm' | 'wasm-threads';

export interface WetBackendInfo {
  kind: WetKernelKind;
  /** Threads stepping the simulation. */
  threads: number;
  /** Why it runs slower than it could, or `null`. */
  message: string | null;
}

export interface WetWorldOptions {
  /** Which kernel: `auto` (default: the fastest available), or force `typescript` / `wasm` (one thread). */
  kernel?: 'auto' | 'typescript' | 'wasm';
  /** Worker threads for the wasm kernel: `auto` (default: cores − 1, at most 10) or a number (0: none). */
  threads?: number | 'auto';
}

export interface WetLaneOptions {
  params?: Partial<WetParams>;
  /** The layer's pixels under the wet paint (default empty). */
  base?: TiledSurface;
  flow?: WetFlowField | null;
  /** Flow map strength (default 1 when a flow map is given). */
  flowStrength?: number;
}

interface Lane {
  id: string;
  index: number;
  params: WetParams;
  flow: WetFlowField | null;
  flowStrength: number;
  base: TiledSurface;
  /** Shaded display tiles by tile key, with the stamp they were shaded at. */
  shaded: Map<number, { stamp: number; tile: Tile }>;
  /** Tile keys edited since they were last shaded (shaded first). */
  urgent: Set<number>;
  /** Changes whenever its pixels (display) may have changed. */
  stamp: number;
  display: TiledSurface | null;
  /** Bumped whenever `shaded` changes; with the base id it keys the cached display. */
  shadedVersion: number;
  displayKey: string;
}

/** Totals for one wet layer. */
export interface WetLaneStats {
  /** Tiles being simulated. */
  activeTiles: number;
  /** Cells with surface water (at least `DRY_EPS` deep). */
  wetCells: number;
  /** Water on the surface plus in the paper, in cell-depth units. */
  water: number;
  /** Suspended plus settled pigment mass (sum of the four channels). */
  pigment: number;
  /** Document rectangle of the wet cells, or `null` when nothing is wet. */
  wetBounds: RasterRect | null;
}

/** A copy of the whole simulation (for undo). */
export interface WetSnapshot {
  readonly clock: number;
  readonly tilt: WetTilt;
  readonly lanes: ReadonlyArray<{ id: string; index: number; params: WetParams; flow: WetFlowField | null; flowStrength: number; base: TiledSurface }>;
  /** Per active key: the current set and the deposit planes; and its last flags. */
  readonly slots: ReadonlyMap<number, { planes: Float32Array; last: number }>;
  /** Bytes held. */
  readonly bytes: number;
}

/** Thrown for edits while a batch is running, and for bad arguments. */
export class WetWorldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WetWorldError';
  }
}

interface Layout extends WetWorkerLayout {
  width: number;
  height: number;
}

function makeLayout(width: number, height: number): Layout {
  const tilesX = Math.ceil(width / WET_TILE);
  const tilesY = Math.ceil(height / WET_TILE);
  const perLane = tilesX * tilesY;
  const keys = perLane * MAX_WET_LANES;
  const ctl = 0;
  const params = 1024;
  const table = params + MAX_WET_LANES * PARAM_FLOATS * 4;
  const list = table + keys * 4;
  const flags = list + keys * 4;
  const last = flags + keys * 4;
  const slots = Math.ceil((last + keys * 4) / 65536) * 65536;
  return { width, height, tilesX, tilesY, perLane, keys, ctl, params, table, list, flags, last, slots, slotBytes: SLOT_BYTES };
}

/** Rounds a height to 1/65536 so tiny floating-point differences in the grain never reach the simulation. */
function quantizeHeight(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 65536) / 65536;
}

export class WetWorld {
  readonly width: number;
  readonly height: number;
  readonly layout: Layout;
  /** Steps simulated so far. */
  clock = 0;
  /** Messages for the user (slots ran out, a backend failed). */
  readonly warnings: string[] = [];
  private memory: WebAssembly.Memory;
  private readonly shared: boolean;
  private f32!: Float32Array;
  private i32!: Int32Array;
  private u32!: Uint32Array;
  private slotCount = 0;
  private readonly freeSlots: number[] = [];
  private readonly active: number[] = [];
  private parity = 0;
  private readonly lanes: (Lane | null)[] = new Array(MAX_WET_LANES).fill(null);
  private tilt: WetTilt = { ...FLAT };
  private paper: WetPaperInput;
  private paperBytes = new Uint8Array(3);
  private kind: WetKernelKind = 'typescript';
  private wasm: { step: (base: number, parity: number, prm: number) => number; halo: (table: number, slots: number, key: number, perLane: number, tilesX: number, tilesY: number, set: number) => void } | null = null;
  private pool: WetWorkerPool | null = null;
  private busyFlag = false;
  private destroyed = false;
  private support: WetSupport;
  private readonly prm = new Float32Array(PARAM_FLOATS);
  // Engine B: the GPU mirror (see `attachGpu`).
  private gpu: WetGpuEngine | null = null;
  /** Live tiles at which the GPU takes over the display (default 16: a fully wet 1024² canvas). */
  gpuMinTiles = 16;
  private gpuLive = false;
  private gpuFailure: string | null = null;
  /** Slot → rows (1..256, inclusive) to upload; `[0, 257]` means the whole slot. */
  private readonly gpuDirty = new Map<number, [number, number]>();
  private gpuParamsDirty = true;
  /** Resolves when the fastest available kernel is running (it may stay `typescript`). */
  readonly ready: Promise<WetBackendInfo>;

  constructor(width: number, height: number, paper: WetPaperInput, options: WetWorldOptions = {}) {
    if (!(width >= 1 && height >= 1 && width <= 16384 && height <= 16384)) throw new WetWorldError(`A wet canvas must be 1..16384 pixels per side, not ${width}×${height}.`);
    this.width = Math.round(width);
    this.height = Math.round(height);
    this.paper = paper;
    this.paperBytes.set(paper.color);
    this.layout = makeLayout(this.width, this.height);
    const wantKernel = options.kernel ?? 'auto';
    const threads = options.threads ?? 'auto';
    this.shared = wantKernel === 'auto' && threads !== 0 && canShareMemory();
    const pages = this.layout.slots / 65536 + Math.ceil((2 * SLOT_BYTES) / 65536);
    const maxPages = Math.min(65536, Math.ceil((this.layout.slots + MAX_WET_SLOTS * SLOT_BYTES) / 65536));
    this.memory = this.shared ? new WebAssembly.Memory({ initial: pages, maximum: maxPages, shared: true }) : new WebAssembly.Memory({ initial: pages });
    this.views();
    new Int32Array(this.memory.buffer, this.layout.table, this.layout.keys).fill(-1);
    this.support = wetSupport(true);
    this.ready = wantKernel === 'typescript' ? Promise.resolve(this.backend()) : this.start(threads);
  }

  // --- Backends ------------------------------------------------------------------

  private views(): void {
    const buf = this.memory.buffer;
    this.f32 = new Float32Array(buf);
    this.i32 = new Int32Array(buf);
    this.u32 = new Uint32Array(buf);
  }

  private async start(threads: number | 'auto'): Promise<WetBackendInfo> {
    try {
      const simd = await wetSimdSupported();
      this.support = wetSupport(simd);
      if (!simd || this.destroyed) return this.backend();
      const module = await loadWetKernel(this.shared);
      const inst = await WebAssembly.instantiate(module, { env: { memory: this.memory } });
      if (this.destroyed) return this.backend();
      this.wasm = inst.exports as unknown as NonNullable<WetWorld['wasm']>;
      this.kind = 'wasm';
      const n = threads === 'auto' ? Math.max(1, Math.min(10, this.support.cores - 1)) : Math.max(0, Math.floor(threads));
      if (this.shared && this.support.workers && n >= 2) {
        try {
          const pool = await WetWorkerPool.create(n, module, this.memory, this.layout);
          if (this.destroyed) pool.destroy();
          else {
            this.pool = pool;
            this.kind = 'wasm-threads';
          }
        } catch (e) {
          this.warnings.push(`Wet paint could not start its worker threads (${(e as Error).message}); it runs on one thread.`);
        }
      }
    } catch (e) {
      this.warnings.push(`The WebAssembly wet-media kernel did not load (${(e as Error).message}); wet paint runs in plain JavaScript.`);
    }
    return this.backend();
  }

  /** The kernel in use and why it is not faster. */
  backend(): WetBackendInfo {
    const threads = this.pool?.size ?? 1;
    let message = this.support.message;
    if (this.kind === 'typescript' && !message) message = this.wasm ? null : 'Wet paint runs in plain JavaScript until the WebAssembly kernel has loaded.';
    if (this.kind === 'wasm-threads') message = null;
    return { kind: this.kind, threads, message };
  }

  /** Whether a batch is running (edits throw until it ends). */
  get busy(): boolean {
    return this.busyFlag;
  }

  destroy(): void {
    this.destroyed = true;
    this.pool?.destroy();
    this.pool = null;
  }

  // --- Lanes ---------------------------------------------------------------------

  private laneOf(id: string): Lane {
    const l = this.lanes.find((x) => x?.id === id);
    if (!l) throw new WetWorldError(`There is no wet layer "${id}".`);
    return l;
  }

  hasLane(id: string): boolean {
    return this.lanes.some((x) => x?.id === id);
  }

  laneIds(): string[] {
    return this.lanes.filter((l): l is Lane => Boolean(l)).map((l) => l.id);
  }

  /** Adds a wet layer (or returns it). Throws when `MAX_WET_LANES` are in use. */
  ensureLane(id: string, options: WetLaneOptions = {}): void {
    this.requireIdle();
    const existing = this.lanes.find((x) => x?.id === id);
    if (existing) {
      if (options.params) this.setParams(id, options.params);
      if (options.base) this.setBase(id, options.base);
      return;
    }
    const index = this.lanes.indexOf(null);
    if (index < 0) throw new WetWorldError(`At most ${MAX_WET_LANES} layers can hold wet paint at once; dry one (dry_paint) first.`);
    this.lanes[index] = {
      id,
      index,
      params: normalizeWetParams(options.params ?? {}, DEFAULT_WET_PARAMS),
      flow: options.flow ?? null,
      flowStrength: options.flow ? (options.flowStrength ?? 1) : 0,
      base: options.base ?? new TiledSurface(4, new Map(), 0),
      shaded: new Map(),
      urgent: new Set(),
      stamp: 1,
      display: null,
      shadedVersion: 0,
      displayKey: '',
    };
    this.pack(this.lanes[index]!);
  }

  /** Drops a wet layer and its wet paint (nothing is baked). */
  removeLane(id: string): void {
    this.requireIdle();
    const lane = this.laneOf(id);
    for (const key of [...this.active]) if (this.laneIndexOf(key) === lane.index) this.free(key);
    this.lanes[lane.index] = null;
  }

  getParams(id: string): WetParams {
    return { ...this.laneOf(id).params };
  }

  setParams(id: string, params: Partial<WetParams>): WetParams {
    this.requireIdle();
    const lane = this.laneOf(id);
    lane.params = normalizeWetParams(params, lane.params);
    this.pack(lane);
    return { ...lane.params };
  }

  getTilt(): WetTilt {
    return { ...this.tilt };
  }

  setTilt(tilt: Partial<WetTilt>): WetTilt {
    this.requireIdle();
    this.tilt = normalizeTilt(tilt, this.tilt);
    for (const l of this.lanes) if (l) this.pack(l);
    return { ...this.tilt };
  }

  /** Changes the paper: heights of live tiles are refilled, rates repacked. */
  setPaper(paper: WetPaperInput): void {
    this.requireIdle();
    this.paper = paper;
    this.paperBytes.set(paper.color);
    for (const key of this.active) this.fillPaper(key);
    for (const l of this.lanes) {
      if (!l) continue;
      this.pack(l);
      this.touchAll(l);
    }
    this.refreshHalos();
  }

  /** Sets a layer's flow map (`null` removes it). */
  setFlow(id: string, flow: WetFlowField | null, strength = 1): void {
    this.requireIdle();
    const lane = this.laneOf(id);
    lane.flow = flow;
    lane.flowStrength = flow ? strength : 0;
    this.pack(lane);
    for (const key of this.active) if (this.laneIndexOf(key) === lane.index) this.fillFlow(key);
  }

  hasFlow(id: string): boolean {
    return Boolean(this.laneOf(id).flow);
  }

  /** The pixels under a layer's wet paint. */
  getBase(id: string): TiledSurface {
    return this.laneOf(id).base;
  }

  /** Replaces the pixels under a layer's wet paint. */
  setBase(id: string, base: TiledSurface): void {
    const lane = this.laneOf(id);
    if (base === lane.base) return;
    lane.base = base;
    lane.shaded.clear();
    lane.shadedVersion++;
    lane.stamp++;
  }

  private pack(lane: Lane): void {
    packWetParams(lane.params, this.paper ?? DEFAULT_WET_PAPER, this.tilt, lane.flowStrength, this.prm);
    this.f32.set(this.prm, (this.layout.params + lane.index * PARAM_FLOATS * 4) >> 2);
    this.gpuParamsDirty = true;
  }

  private touchAll(lane: Lane): void {
    lane.stamp++;
  }

  // --- Slots ---------------------------------------------------------------------

  private laneIndexOf(key: number): number {
    return Math.floor(key / this.layout.perLane);
  }

  private slotOf(key: number): number {
    return this.i32[(this.layout.table >> 2) + key];
  }

  private slotBase(slot: number): number {
    return (this.layout.slots >> 2) + slot * SLOT_FLOATS;
  }

  private requireIdle(): void {
    if (this.busyFlag) throw new WetWorldError('The wet simulation is mid-step; wait for it (whenIdle) before changing it.');
  }

  /** Writes the active list into memory for the kernels. */
  private syncList(): void {
    const base = this.layout.list >> 2;
    this.active.sort((a, b) => a - b);
    for (let i = 0; i < this.active.length; i++) this.i32[base + i] = this.active[i];
    this.i32[(this.layout.ctl >> 2) + 4] = this.active.length;
  }

  private grow(slots: number): boolean {
    const need = this.layout.slots + slots * SLOT_BYTES;
    const have = this.memory.buffer.byteLength;
    if (need <= have) return true;
    try {
      this.memory.grow(Math.ceil((need - have) / 65536));
    } catch {
      return false;
    }
    this.views();
    return true;
  }

  /** Activates a tile of a lane. Returns false when no slot can be had. */
  private activate(key: number): boolean {
    if (this.slotOf(key) >= 0) return true;
    let slot = this.freeSlots.pop();
    if (slot === undefined) {
      if (this.slotCount >= MAX_WET_SLOTS || !this.grow(this.slotCount + 1)) {
        const msg = `Wet paint reached its memory limit (${MAX_WET_SLOTS} tiles of 256 px); water spreading further is lost. Dry some paint (dry_paint) to free memory.`;
        if (!this.warnings.includes(msg)) this.warnings.push(msg);
        return false;
      }
      slot = this.slotCount++;
    }
    const base = this.slotBase(slot);
    this.f32.fill(0, base, base + SLOT_FLOATS);
    this.i32[(this.layout.table >> 2) + key] = slot;
    this.u32[(this.layout.flags >> 2) + key] = 0;
    this.u32[(this.layout.last >> 2) + key] = 0;
    this.active.push(key);
    this.fillPaper(key);
    this.fillFlow(key);
    return true;
  }

  private free(key: number): void {
    const slot = this.slotOf(key);
    if (slot < 0) return;
    this.i32[(this.layout.table >> 2) + key] = -1;
    this.freeSlots.push(slot);
    const i = this.active.indexOf(key);
    if (i >= 0) this.active.splice(i, 1);
    const lane = this.lanes[this.laneIndexOf(key)];
    if (lane) {
      if (lane.shaded.delete(this.tileKeyOf(key))) lane.shadedVersion++;
      lane.stamp++;
    }
  }

  private tileXY(key: number): [number, number] {
    const t = key % this.layout.perLane;
    return [t % this.layout.tilesX, Math.floor(t / this.layout.tilesX)];
  }

  private tileKeyOf(key: number): number {
    const [tx, ty] = this.tileXY(key);
    return tileKey(tx, ty);
  }

  private fillPaper(key: number): void {
    this.gpuDirtySlot(this.slotOf(key), 0, SLOT_SIDE - 1);
    const [tx, ty] = this.tileXY(key);
    const h = this.slotBase(this.slotOf(key)) + P_H * PLANE;
    const { width, height } = this;
    for (let y = 0; y < S; y++) {
      const gy = ty * WET_TILE + y - 1;
      for (let x = 0; x < S; x++) {
        const gx = tx * WET_TILE + x - 1;
        this.f32[h + y * S + x] = gx < 0 || gy < 0 || gx >= width || gy >= height ? -1 : quantizeHeight(this.paper.heightAt(gx + 0.5, gy + 0.5));
      }
    }
  }

  private fillFlow(key: number): void {
    this.gpuDirtySlot(this.slotOf(key), 0, SLOT_SIDE - 1);
    const lane = this.lanes[this.laneIndexOf(key)]!;
    const [tx, ty] = this.tileXY(key);
    const b = this.slotBase(this.slotOf(key));
    const fx = b + P_FX * PLANE;
    const fy = b + P_FY * PLANE;
    for (let y = 1; y <= WET_TILE; y++) {
      for (let x = 1; x <= WET_TILE; x++) {
        const v = lane.flow ? lane.flow(tx * WET_TILE + x - 1 + 0.5, ty * WET_TILE + y - 1 + 0.5) : null;
        this.f32[fx + y * S + x] = v ? Math.fround(v[0]) : 0;
        this.f32[fy + y * S + x] = v ? Math.fround(v[1]) : 0;
      }
    }
  }

  /** Activates every tile of a lane within `STRIP` cells of a document rectangle. */
  private wake(lane: Lane, x0: number, y0: number, x1: number, y1: number): void {
    const { tilesX, tilesY, perLane } = this.layout;
    const tx0 = Math.max(0, Math.floor((x0 - STRIP) / WET_TILE));
    const ty0 = Math.max(0, Math.floor((y0 - STRIP) / WET_TILE));
    const tx1 = Math.min(tilesX - 1, Math.floor((x1 + STRIP) / WET_TILE));
    const ty1 = Math.min(tilesY - 1, Math.floor((y1 + STRIP) / WET_TILE));
    let added = false;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) added = this.activate(lane.index * perLane + ty * tilesX + tx) || added;
    if (added) this.syncList();
  }

  /** Fills one slot's halo in the current set from its neighbours (TypeScript). */
  private haloTs(key: number, set: number): void {
    const { tilesX, tilesY, perLane } = this.layout;
    const laneBase = this.laneIndexOf(key) * perLane;
    const [tx, ty] = this.tileXY(key);
    const f = this.f32;
    const nb = (dx: number, dy: number) => {
      const x = tx + dx;
      const y = ty + dy;
      if (x < 0 || y < 0 || x >= tilesX || y >= tilesY) return -1;
      return this.slotOf(laneBase + y * tilesX + x);
    };
    const me = this.slotBase(this.slotOf(key)) + set * SET_PLANES * PLANE;
    const n = nb(0, -1);
    const s = nb(0, 1);
    const w = nb(-1, 0);
    const e = nb(1, 0);
    const nw = nb(-1, -1);
    const ne = nb(1, -1);
    const sw = nb(-1, 1);
    const se = nb(1, 1);
    const off = set * SET_PLANES * PLANE;
    for (let k = 0; k < SET_PLANES; k++) {
      const mp = me + k * PLANE;
      const o = off + k * PLANE;
      if (n >= 0) f.copyWithin(mp + 1, this.slotBase(n) + o + 256 * S + 1, this.slotBase(n) + o + 256 * S + 257);
      if (s >= 0) f.copyWithin(mp + 257 * S + 1, this.slotBase(s) + o + S + 1, this.slotBase(s) + o + S + 257);
      if (w >= 0) for (let y = 1; y <= 256; y++) f[mp + y * S] = f[this.slotBase(w) + o + y * S + 256];
      if (e >= 0) for (let y = 1; y <= 256; y++) f[mp + y * S + 257] = f[this.slotBase(e) + o + y * S + 1];
      if (nw >= 0) f[mp] = f[this.slotBase(nw) + o + 256 * S + 256];
      if (ne >= 0) f[mp + 257] = f[this.slotBase(ne) + o + 256 * S + 1];
      if (sw >= 0) f[mp + 257 * S] = f[this.slotBase(sw) + o + S + 256];
      if (se >= 0) f[mp + 257 * S + 257] = f[this.slotBase(se) + o + S + 1];
    }
  }

  private halo(key: number, set: number): void {
    if (this.wasm) {
      const l = this.layout;
      this.wasm.halo(l.table, l.slots, key, l.perLane, l.tilesX, l.tilesY, set);
    } else this.haloTs(key, set);
  }

  /** Refills every live slot's halo in the current set (after edits or wake-ups). */
  private refreshHalos(): void {
    for (const key of this.active) this.halo(key, this.parity);
  }

  // --- Stepping ------------------------------------------------------------------

  /** Whether anything is being simulated (in `id`, or any layer). */
  isActive(id?: string): boolean {
    if (id === undefined) return this.active.length > 0;
    const lane = this.laneOf(id);
    return this.active.some((k) => this.laneIndexOf(k) === lane.index);
  }

  /** Steps until the next batch boundary: at most `want`, `MAX_BATCH`, and the next free check. */
  private batchSize(want: number): number {
    const toFree = FREE_INTERVAL - (this.clock % FREE_INTERVAL);
    return Math.max(1, Math.min(want, MAX_BATCH, toFree));
  }

  /** Runs `n` steps on this thread (TypeScript or wasm kernel). */
  private runHere(n: number): void {
    const l = this.layout;
    const flagsBase = l.flags >> 2;
    const lastBase = l.last >> 2;
    const prmBase = l.params >> 2;
    for (let s = 0; s < n; s++) {
      for (const key of this.active) {
        const slot = this.slotOf(key);
        const lane = this.laneIndexOf(key);
        let fl: number;
        if (this.wasm) fl = this.wasm.step(l.slots + slot * SLOT_BYTES, this.parity, l.params + lane * PARAM_FLOATS * 4);
        else fl = stepSlotTs(this.f32, this.slotBase(slot), this.parity, this.f32.subarray(prmBase + lane * PARAM_FLOATS, prmBase + (lane + 1) * PARAM_FLOATS));
        this.u32[flagsBase + key] |= fl;
        this.u32[lastBase + key] = fl;
      }
      for (const key of this.active) this.halo(key, 1 - this.parity);
      this.parity = 1 - this.parity;
    }
  }

  /** After a batch: wake neighbours from the flags, free dead tiles on a free step, restamp. */
  private afterBatch(n: number): void {
    this.clock += n;
    const l = this.layout;
    const flagsBase = l.flags >> 2;
    const lastBase = l.last >> 2;
    const { tilesX, tilesY, perLane } = l;
    const wakeups: number[] = [];
    for (const key of this.active) {
      const fl = this.u32[flagsBase + key];
      this.u32[flagsBase + key] = 0;
      if (!(fl & FLAG_ALIVE)) continue;
      const laneBase = this.laneIndexOf(key) * perLane;
      const [tx, ty] = this.tileXY(key);
      const L = fl & FLAG_LEFT;
      const R = fl & FLAG_RIGHT;
      const T = fl & FLAG_TOP;
      const B = fl & FLAG_BOTTOM;
      const push = (x: number, y: number) => {
        if (x >= 0 && y >= 0 && x < tilesX && y < tilesY && this.slotOf(laneBase + y * tilesX + x) < 0) wakeups.push(laneBase + y * tilesX + x);
      };
      if (L) push(tx - 1, ty);
      if (R) push(tx + 1, ty);
      if (T) push(tx, ty - 1);
      if (B) push(tx, ty + 1);
      if (L && T) push(tx - 1, ty - 1);
      if (R && T) push(tx + 1, ty - 1);
      if (L && B) push(tx - 1, ty + 1);
      if (R && B) push(tx + 1, ty + 1);
    }
    let woke = false;
    for (const key of wakeups) woke = this.activate(key) || woke;
    if (this.clock % FREE_INTERVAL === 0) {
      const dead = this.active.filter((key) => {
        if (this.u32[lastBase + key] & FLAG_ALIVE) return false;
        const laneBase = this.laneIndexOf(key) * perLane;
        const [tx, ty] = this.tileXY(key);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = tx + dx;
            const y = ty + dy;
            if ((dx || dy) && x >= 0 && y >= 0 && x < tilesX && y < tilesY) {
              const nk = laneBase + y * tilesX + x;
              if (this.slotOf(nk) >= 0 && this.u32[lastBase + nk] & FLAG_ALIVE) return false;
            }
          }
        return true;
      });
      for (const key of dead) {
        this.bakeKey(key, false);
        this.free(key);
      }
      if (dead.length) woke = true;
    }
    if (woke) {
      this.syncList();
      this.refreshHalos();
    }
    for (const lane of this.lanes) if (lane) lane.stamp++;
  }

  /**
   * Steps the simulation `steps` times on this thread (the TypeScript or single-thread wasm
   * kernel). Throws while worker threads are in use; use `step` there.
   */
  stepSync(steps: number): number {
    this.requireIdle();
    if (this.pool) throw new WetWorldError('This wet world steps in worker threads; call step (async) instead.');
    let left = Math.max(0, Math.floor(steps));
    while (left > 0) {
      if (!this.active.length) {
        this.clock += left;
        break;
      }
      const n = this.batchSize(left);
      this.gpuBatch(n);
      this.runHere(n);
      this.afterBatch(n);
      left -= n;
    }
    return this.clock;
  }

  /** Steps the simulation `steps` times (in worker threads when there are any). */
  async step(steps: number): Promise<number> {
    this.requireIdle();
    if (!this.pool) return this.stepSync(steps);
    let left = Math.max(0, Math.floor(steps));
    while (left > 0) {
      if (!this.active.length) {
        this.clock += left;
        break;
      }
      const n = this.batchSize(left);
      this.gpuBatch(n);
      const ctl = this.layout.ctl >> 2;
      this.i32[ctl + 2] = 0;
      this.i32[ctl + 3] = 0;
      this.i32[ctl + 5] = this.parity;
      this.busyFlag = true;
      try {
        await this.pool.run(n);
      } finally {
        this.busyFlag = false;
      }
      this.parity = (this.parity + n) % 2;
      this.afterBatch(n);
      left -= n;
    }
    return this.clock;
  }

  /** Steps until nothing is wet or `maxSteps` have run. Returns the steps run. */
  async stepUntilDry(maxSteps: number): Promise<number> {
    const start = this.clock;
    while (this.active.length && this.clock - start < maxSteps) await this.step(Math.min(FREE_INTERVAL, maxSteps - (this.clock - start)));
    return this.clock - start;
  }

  // --- Edits ---------------------------------------------------------------------

  /** Float index of a cell's plane-0 value in the current set, or −1 (inactive / off the canvas). */
  private cell(lane: Lane, x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    const { tilesX, perLane } = this.layout;
    const slot = this.slotOf(lane.index * perLane + (y >> 8) * tilesX + (x >> 8));
    if (slot < 0) return -1;
    return this.slotBase(slot) + this.parity * SET_PLANES * PLANE + ((y & 255) + 1) * S + (x & 255) + 1;
  }

  /** Index of the same cell in the single (deposit, height, flow) planes, given `cell`. */
  private single(c: number): number {
    return c - this.parity * SET_PLANES * PLANE;
  }

  /**
   * Runs `fn` for every cell of a footprint (`cov` over `rect`, document cells) on a lane, waking
   * the tiles around it first, then refreshes halos. `fn` gets the cell index and its coverage.
   */
  private footprint(id: string, rect: RasterRect, cov: ArrayLike<number> | null, fn: (c: number, w: number, x: number, y: number) => void, wake = true): void {
    this.requireIdle();
    const lane = this.laneOf(id);
    const x0 = Math.max(0, rect.x);
    const y0 = Math.max(0, rect.y);
    const x1 = Math.min(this.width, rect.x + rect.width);
    const y1 = Math.min(this.height, rect.y + rect.height);
    if (x1 <= x0 || y1 <= y0) return;
    if (wake) this.wake(lane, x0, y0, x1 - 1, y1 - 1);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const w = cov ? cov[(y - rect.y) * rect.width + (x - rect.x)] : 1;
        if (!(w > 0)) continue;
        const c = this.cell(lane, x, y);
        if (c >= 0) fn(c, w, x, y);
      }
    }
    this.markEdited(lane, x0, y0, x1, y1);
    this.refreshHalos();
  }

  private markEdited(lane: Lane, x0: number, y0: number, x1: number, y1: number): void {
    const { tilesX, perLane } = this.layout;
    for (let ty = y0 >> 8; ty <= (y1 - 1) >> 8; ty++)
      for (let tx = x0 >> 8; tx <= (x1 - 1) >> 8; tx++) {
        lane.urgent.add(tileKey(tx, ty));
        const slot = this.slotOf(lane.index * perLane + ty * tilesX + tx);
        if (slot >= 0) this.gpuDirtySlot(slot, Math.max(1, y0 - ty * WET_TILE + 1), Math.min(WET_TILE, y1 - ty * WET_TILE));
      }
    lane.stamp++;
  }

  /** Adds water (depth units) at rest. */
  private addWaterAt(c: number, dw: number): void {
    const f = this.f32;
    for (let k = 0; k < 9; k++) f[c + k * PLANE] += W9[k] * dw;
    f[c + P_RHO * PLANE] += dw;
  }

  /**
   * Lays paint: `water` depth and pigment mass `pigment` (K r, g, b, S) per unit of coverage, or
   * per pixel from `field` (4 values per pixel of `rect`). Pigment without water lands straight in
   * the paper (settled).
   */
  paint(id: string, rect: RasterRect, cov: ArrayLike<number> | null, water: number, pigment: ArrayLike<number> | null, field: ArrayLike<number> | null = null): void {
    if (!(water >= 0)) throw new WetWorldError(`water ${water} must be 0 or more.`);
    this.footprint(id, rect, cov, (c, w, x, y) => {
      const dw = Math.fround(water * w);
      if (dw > 0) this.addWaterAt(c, dw);
      const into = dw > 0 ? c + P_P0 * PLANE : this.single(c) + P_D0 * PLANE;
      if (field) {
        const o = ((y - rect.y) * rect.width + (x - rect.x)) * 4;
        for (let q = 0; q < 4; q++) this.f32[into + q * PLANE] += field[o + q] * w;
      } else if (pigment) for (let q = 0; q < 4; q++) this.f32[into + q * PLANE] += pigment[q] * w;
    });
  }

  /** Damp paper: fills the paper's water towards its capacity by `amount` (0..1) × coverage, plus a thin film of surface water. */
  wetPaper(id: string, rect: RasterRect, cov: ArrayLike<number> | null, amount: number): void {
    const capacity = PAPER_CAPACITY;
    this.footprint(id, rect, cov, (c, w) => {
      const a = Math.min(1, Math.max(0, amount * w));
      const s = c + P_SW * PLANE;
      this.f32[s] = Math.max(this.f32[s], Math.fround(capacity * a));
      this.addWaterAt(c, Math.fround(0.03 * a));
    });
  }

  /**
   * Takes water (and suspended pigment, and settled pigment) away: `water`, `suspended`,
   * `settled` are fractions 0..1 × coverage. A hair dryer takes water only (the pigment stays and
   * settles); blotting takes all three.
   */
  remove(id: string, rect: RasterRect, cov: ArrayLike<number> | null, water: number, suspended: number, settled: number, paperWater = water): void {
    this.footprint(
      id,
      rect,
      cov,
      (c, w) => {
        const f = this.f32;
        const kw = 1 - Math.min(1, Math.max(0, water * w));
        const kp = 1 - Math.min(1, Math.max(0, suspended * w));
        const kd = 1 - Math.min(1, Math.max(0, settled * w));
        const ks = 1 - Math.min(1, Math.max(0, paperWater * w));
        if (kw < 1) {
          for (let k = 0; k < 9; k++) f[c + k * PLANE] *= kw;
          f[c + P_RHO * PLANE] *= kw;
        }
        if (ks < 1) f[c + P_SW * PLANE] *= ks;
        if (kp < 1) for (let q = 0; q < 4; q++) f[c + (P_P0 + q) * PLANE] *= kp;
        if (kd < 1) {
          const d = this.single(c) + P_D0 * PLANE;
          for (let q = 0; q < 4; q++) f[d + q * PLANE] *= kd;
        }
      },
      false
    );
  }

  /** Pushes the water: adds velocity (`ux`, `uy` cells per step, each at most 0.1) × coverage. */
  push(id: string, rect: RasterRect, cov: ArrayLike<number> | null, ux: number, uy: number): void {
    const cap = 0.1;
    const sp = Math.hypot(ux, uy);
    if (sp > cap) {
      ux *= cap / sp;
      uy *= cap / sp;
    }
    this.footprint(
      id,
      rect,
      cov,
      (c, w) => {
        const f = this.f32;
        const rho = f[c + P_RHO * PLANE];
        if (!(rho >= DRY_EPS)) return;
        for (let k = 1; k < 9; k++) {
          const eu = EX[k] * ux * w + EY[k] * uy * w;
          f[c + k * PLANE] = Math.max(0, f[c + k * PLANE] + 3 * W9[k] * rho * eu);
        }
      },
      false
    );
  }

  /** Blends wet paint: each wet cell's suspended pigment moves `strength` × coverage towards the footprint's mean. */
  blend(id: string, rect: RasterRect, cov: ArrayLike<number> | null, strength: number): void {
    const lane = this.laneOf(id);
    const sums = [0, 0, 0, 0];
    let wsum = 0;
    const cells: Array<[number, number]> = [];
    this.footprint(
      id,
      rect,
      cov,
      (c, w) => {
        if (!(this.f32[c + P_RHO * PLANE] >= DRY_EPS)) return;
        cells.push([c, w]);
        wsum += w;
        for (let q = 0; q < 4; q++) sums[q] += this.f32[c + (P_P0 + q) * PLANE] * w;
      },
      false
    );
    if (!(wsum > 0)) return;
    const k = Math.min(1, Math.max(0, strength));
    for (const [c, w] of cells) for (let q = 0; q < 4; q++) {
      const i = c + (P_P0 + q) * PLANE;
      this.f32[i] += k * w * (sums[q] / wsum - this.f32[i]);
    }
    lane.stamp++;
    this.refreshHalos();
  }

  /**
   * Drags wet paint by (`dx`, `dy`) cells: each footprint cell takes `strength` × coverage of the
   * water and suspended pigment of the cell it came from (a smudge through wet paint).
   */
  drag(id: string, rect: RasterRect, cov: ArrayLike<number> | null, dx: number, dy: number, strength: number): void {
    const lane = this.laneOf(id);
    const sx = Math.round(dx);
    const sy = Math.round(dy);
    if (!sx && !sy) return;
    const moves: Array<[number, number, number]> = [];
    this.footprint(
      id,
      rect,
      cov,
      (c, w, x, y) => {
        const from = this.cell(lane, x - sx, y - sy);
        if (from < 0) return;
        moves.push([from, c, Math.min(1, Math.max(0, strength * w))]);
      },
      true
    );
    const f = this.f32;
    // Take from the sources first (so a chain of moves never moves paint twice), then lay it down.
    const taken = moves.map(([from, , a]) => {
      const t = new Float32Array(14);
      for (let k = 0; k < 9; k++) {
        t[k] = f[from + k * PLANE] * a;
        f[from + k * PLANE] -= t[k];
      }
      t[9] = f[from + P_RHO * PLANE] * a;
      f[from + P_RHO * PLANE] -= t[9];
      for (let q = 0; q < 4; q++) {
        t[10 + q] = f[from + (P_P0 + q) * PLANE] * a;
        f[from + (P_P0 + q) * PLANE] -= t[10 + q];
      }
      return t;
    });
    moves.forEach(([, to], i) => {
      const t = taken[i];
      // Arriving water carries the drag direction a little.
      for (let k = 0; k < 9; k++) f[to + k * PLANE] += t[k];
      f[to + P_RHO * PLANE] += t[9];
      for (let q = 0; q < 4; q++) f[to + (P_P0 + q) * PLANE] += t[10 + q];
    });
    this.refreshHalos();
  }

  /**
   * Re-wetting: lifts `amount` × coverage of the dried paint in the layer's pixels (`base`) back into
   * the paper as settled pigment, so water can move it again. Only where there is surface water.
   */
  rewet(id: string, rect: RasterRect, cov: ArrayLike<number> | null, amount: number, paper: readonly [number, number, number]): void {
    const lane = this.laneOf(id);
    const pig = [0, 0, 0, 0];
    const tiles = new Map(lane.base.tiles);
    const written = new Set<number>();
    const scratch = new Uint8ClampedArray(4);
    this.footprint(
      id,
      rect,
      cov,
      (c, w, x, y) => {
        if (!(this.f32[c + P_RHO * PLANE] >= DRY_EPS)) return;
        const a = Math.min(1, Math.max(0, amount * w));
        if (!(a > 0)) return;
        const key = tileKey(x >> 8, y >> 8);
        let tile = tiles.get(key);
        if (!tile) return;
        if (!written.has(key)) {
          tile = { data: new Uint8ClampedArray(tile.data), uniform: null };
          tiles.set(key, tile);
          written.add(key);
        }
        const i = ((y & 255) * TILE + (x & 255)) * 4;
        if (tile.data[i + 3] === 0) return;
        pixelPigment(tile.data, i, paper, pig);
        if (!(pig[0] > 0 || pig[1] > 0 || pig[2] > 0)) return;
        // What stays: (1 − a) of the film over the paper, as a pixel; what is lifted goes to the deposit.
        const clear = new Uint8ClampedArray([0, 0, 0, 0]);
        filmPixel(pig[0] * (1 - a), pig[1] * (1 - a), pig[2] * (1 - a), 0, clear, 0, paper, 0, scratch, 0);
        tile.data.set(scratch, i);
        const d = this.single(c) + P_D0 * PLANE;
        for (let q = 0; q < 3; q++) this.f32[d + q * PLANE] += Math.fround(pig[q] * a);
      },
      false
    );
    if (written.size) {
      for (const key of written) {
        const t = finishTile(tiles.get(key)!.data, 4, 0);
        if (t) tiles.set(key, t);
        else tiles.delete(key);
      }
      this.setBase(id, new TiledSurface(4, tiles, 0));
    }
  }

  /**
   * Dries wet paint at once (everything settles where it is, the water goes): in `rect`, or the
   * whole layer. Whole tiles that end up dry are baked into the base and freed. Returns the
   * document rectangle that changed, or `null`.
   */
  dry(id: string, rect?: RasterRect): RasterRect | null {
    this.requireIdle();
    const lane = this.laneOf(id);
    const keys = this.active.filter((k) => this.laneIndexOf(k) === lane.index);
    if (!keys.length) return null;
    let bounds: RasterRect | null = null;
    const area = rect ?? { x: 0, y: 0, width: this.width, height: this.height };
    for (const key of keys) {
      const [tx, ty] = this.tileXY(key);
      const tr = { x: tx * WET_TILE, y: ty * WET_TILE, width: WET_TILE, height: WET_TILE };
      const x0 = Math.max(area.x, tr.x);
      const y0 = Math.max(area.y, tr.y);
      const x1 = Math.min(area.x + area.width, tr.x + tr.width, this.width);
      const y1 = Math.min(area.y + area.height, tr.y + tr.height, this.height);
      if (x1 <= x0 || y1 <= y0) continue;
      const whole = x0 === tr.x && y0 === tr.y && x1 >= Math.min(tr.x + WET_TILE, this.width) && y1 >= Math.min(tr.y + WET_TILE, this.height);
      if (whole) {
        if (this.bakeKey(key, true)) bounds = unionRect(bounds, { x: tr.x, y: tr.y, width: Math.min(WET_TILE, this.width - tr.x), height: Math.min(WET_TILE, this.height - tr.y) });
        this.free(key);
        continue;
      }
      const f = this.f32;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const c = this.cell(lane, x, y);
          const d = this.single(c) + P_D0 * PLANE;
          for (let q = 0; q < 4; q++) {
            f[d + q * PLANE] += f[c + (P_P0 + q) * PLANE];
            f[c + (P_P0 + q) * PLANE] = 0;
          }
          for (let k = 0; k < 9; k++) f[c + k * PLANE] = 0;
          f[c + P_RHO * PLANE] = 0;
          f[c + P_UX * PLANE] = 0;
          f[c + P_UY * PLANE] = 0;
          f[c + P_SW * PLANE] = 0;
        }
      }
      bounds = unionRect(bounds, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
      this.markEdited(lane, x0, y0, x1, y1);
    }
    this.syncList();
    this.refreshHalos();
    lane.stamp++;
    return bounds;
  }

  /**
   * Bakes a slot's pigment into its lane's base (settling suspended pigment too when `all`).
   * Returns whether any pixel changed.
   */
  private bakeKey(key: number, all: boolean): boolean {
    const lane = this.lanes[this.laneIndexOf(key)]!;
    const [tx, ty] = this.tileXY(key);
    const tk = tileKey(tx, ty);
    const src = lane.base.tiles.get(tk)?.data ?? null;
    const out = this.shadeSlot(key, src, all ? 'bake-all' : 'bake');
    if (!out) return false;
    const tiles = new Map(lane.base.tiles);
    const t = finishTile(out, 4, 0);
    if (t) tiles.set(tk, t);
    else tiles.delete(tk);
    this.setBase(lane.id, new TiledSurface(4, tiles, 0));
    return true;
  }

  /**
   * Shades one slot over a base tile. `display`: the wet look (suspended + settled, wet paper a
   * little darker); `bake`: settled pigment only; `bake-all`: suspended and settled (dry now).
   * Returns `null` when nothing would change the base.
   */
  private shadeSlot(key: number, src: Uint8ClampedArray | null, mode: 'display' | 'bake' | 'bake-all'): Uint8ClampedArray | null {
    const [tx, ty] = this.tileXY(key);
    const b = this.slotBase(this.slotOf(key));
    const cur = b + this.parity * SET_PLANES * PLANE;
    const out = src ? new Uint8ClampedArray(src) : new Uint8ClampedArray(TILE * TILE * 4);
    const w = Math.min(WET_TILE, this.width - tx * WET_TILE);
    const h = Math.min(WET_TILE, this.height - ty * WET_TILE);
    const changed = shadeTile(
      this.f32,
      PLANE,
      S,
      b + P_D0 * PLANE,
      mode === 'bake' ? -1 : cur + P_P0 * PLANE,
      mode === 'display' ? cur + P_RHO * PLANE : -1,
      cur + P_SW * PLANE,
      src,
      out,
      w,
      h,
      this.paperBytes
    );
    return changed ? out : null;
  }

  /** The layer's pixels with all its wet paint dried where it is (the bake of "dry on save"); changes nothing. */
  bakedSurface(id: string): TiledSurface {
    this.requireIdle();
    const lane = this.laneOf(id);
    const tiles = new Map(lane.base.tiles);
    for (const key of this.active) {
      if (this.laneIndexOf(key) !== lane.index) continue;
      const tk = this.tileKeyOf(key);
      const out = this.shadeSlot(key, lane.base.tiles.get(tk)?.data ?? null, 'bake-all');
      if (!out) continue;
      const t = finishTile(out, 4, 0);
      if (t) tiles.set(tk, t);
      else tiles.delete(tk);
    }
    return new TiledSurface(4, tiles, 0);
  }

  // --- Reading -------------------------------------------------------------------

  /**
   * Sums over a footprint of a lane, weighted by coverage: `weight` (coverage), `water` (surface
   * depth), `wet` (coverage of wet cells), `pigment` (suspended, 4 channels), `settled` (4 channels).
   */
  sample(id: string, rect: RasterRect, cov: ArrayLike<number> | null): { weight: number; water: number; wet: number; pigment: number[]; settled: number[] } {
    const lane = this.laneOf(id);
    const r = { weight: 0, water: 0, wet: 0, pigment: [0, 0, 0, 0], settled: [0, 0, 0, 0] };
    const x0 = Math.max(0, rect.x);
    const y0 = Math.max(0, rect.y);
    const x1 = Math.min(this.width, rect.x + rect.width);
    const y1 = Math.min(this.height, rect.y + rect.height);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const w = cov ? cov[(y - rect.y) * rect.width + (x - rect.x)] : 1;
        if (!(w > 0)) continue;
        r.weight += w;
        const c = this.cell(lane, x, y);
        if (c < 0) continue;
        const rho = this.f32[c + P_RHO * PLANE];
        r.water += rho * w;
        if (rho >= DRY_EPS) r.wet += w;
        const d = this.single(c) + P_D0 * PLANE;
        for (let q = 0; q < 4; q++) {
          r.pigment[q] += this.f32[c + (P_P0 + q) * PLANE] * w;
          r.settled[q] += this.f32[d + q * PLANE] * w;
        }
      }
    }
    return r;
  }

  /** Surface water depth at a document cell (0 where nothing is simulated). */
  waterAt(id: string, x: number, y: number): number {
    const c = this.cell(this.laneOf(id), Math.floor(x), Math.floor(y));
    return c < 0 ? 0 : this.f32[c + P_RHO * PLANE];
  }

  /** Totals for a layer (scans its live tiles). */
  stats(id: string): WetLaneStats {
    const lane = this.laneOf(id);
    const out: WetLaneStats = { activeTiles: 0, wetCells: 0, water: 0, pigment: 0, wetBounds: null };
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    const f = this.f32;
    for (const key of this.active) {
      if (this.laneIndexOf(key) !== lane.index) continue;
      out.activeTiles++;
      const [tx, ty] = this.tileXY(key);
      const b = this.slotBase(this.slotOf(key));
      const cur = b + this.parity * SET_PLANES * PLANE;
      for (let y = 1; y <= 256; y++) {
        for (let x = 1; x <= 256; x++) {
          const c = y * S + x;
          const rho = f[cur + P_RHO * PLANE + c];
          out.water += rho + f[cur + P_SW * PLANE + c];
          for (let q = 0; q < 4; q++) out.pigment += f[cur + (P_P0 + q) * PLANE + c] + f[b + (P_D0 + q) * PLANE + c];
          if (rho >= DRY_EPS) {
            out.wetCells++;
            const gx = tx * WET_TILE + x - 1;
            const gy = ty * WET_TILE + y - 1;
            if (gx < bx0) bx0 = gx;
            if (gy < by0) by0 = gy;
            if (gx > bx1) bx1 = gx;
            if (gy > by1) by1 = gy;
          }
        }
      }
    }
    if (out.wetCells) out.wetBounds = { x: bx0, y: by0, width: bx1 - bx0 + 1, height: by1 - by0 + 1 };
    return out;
  }

  /** Whether a layer (or any) has surface water anywhere. */
  isWet(id?: string): boolean {
    const ids = id === undefined ? this.laneIds() : [id];
    return ids.some((x) => this.isActive(x));
  }

  /** Document rectangles of a layer's live tiles. */
  activeRects(id: string): RasterRect[] {
    const lane = this.laneOf(id);
    return this.active
      .filter((k) => this.laneIndexOf(k) === lane.index)
      .map((k) => {
        const [tx, ty] = this.tileXY(k);
        return { x: tx * WET_TILE, y: ty * WET_TILE, width: Math.min(WET_TILE, this.width - tx * WET_TILE), height: Math.min(WET_TILE, this.height - ty * WET_TILE) };
      });
  }

  // --- Display -------------------------------------------------------------------

  /** A number that changes whenever a layer's display may have changed. */
  stamp(id: string): number {
    return this.laneOf(id).stamp;
  }

  /**
   * The layer's pixels with its wet paint shaded in: the base with each live tile shaded over it.
   * At most `maxTiles` stale tiles are reshaded per call (edited tiles first); the rest keep their
   * last shading until the next call. Returns the surface and the tiles reshaded.
   */
  display(id: string, maxTiles = Infinity): { surface: TiledSurface; changed: RasterRect[]; pending: number } {
    const lane = this.laneOf(id);
    const keys = this.active.filter((k) => this.laneIndexOf(k) === lane.index);
    const stale = keys.filter((k) => lane.shaded.get(this.tileKeyOf(k))?.stamp !== lane.stamp);
    stale.sort((a, b) => Number(lane.urgent.has(this.tileKeyOf(b))) - Number(lane.urgent.has(this.tileKeyOf(a))) || (lane.shaded.get(this.tileKeyOf(a))?.stamp ?? 0) - (lane.shaded.get(this.tileKeyOf(b))?.stamp ?? 0));
    const changed: RasterRect[] = [];
    let done = 0;
    for (const key of stale) {
      if (done >= maxTiles) break;
      const tk = this.tileKeyOf(key);
      const src = lane.base.tiles.get(tk)?.data ?? null;
      const out = this.shadeSlot(key, src, 'display');
      const tile = out ? finishTile(out, 4, 0) : (lane.base.tiles.get(tk) ?? null);
      lane.shaded.set(tk, { stamp: lane.stamp, tile: tile ?? { data: new Uint8ClampedArray(0), uniform: 0 } });
      lane.shadedVersion++;
      lane.urgent.delete(tk);
      const [tx, ty] = this.tileXY(key);
      changed.push({ x: tx * WET_TILE, y: ty * WET_TILE, width: WET_TILE, height: WET_TILE });
      done++;
    }
    // Shaded tiles of freed slots are gone; drop leftovers.
    const live = new Set(keys.map((k) => this.tileKeyOf(k)));
    for (const tk of [...lane.shaded.keys()]) if (!live.has(tk) && lane.shaded.delete(tk)) lane.shadedVersion++;
    const displayKey = `${lane.base.id}:${lane.shadedVersion}`;
    if (lane.display && lane.displayKey === displayKey) return { surface: lane.display, changed, pending: stale.length - done };
    const tiles = new Map(lane.base.tiles);
    for (const [tk, { tile }] of lane.shaded) {
      if (tile.data.length === 0) tiles.delete(tk);
      else tiles.set(tk, tile);
    }
    lane.display = new TiledSurface(4, tiles, 0);
    lane.displayKey = displayKey;
    return { surface: lane.display, changed, pending: stale.length - done };
  }

  /**
   * The water as an overlay tile (RGBA, blue, alpha from surface depth and damp paper) for a
   * document tile, or `null` where nothing is wet.
   */
  waterOverlay(id: string, tx: number, ty: number): Uint8ClampedArray | null {
    const lane = this.laneOf(id);
    const { tilesX, tilesY, perLane } = this.layout;
    if (tx < 0 || ty < 0 || tx >= tilesX || ty >= tilesY) return null;
    const slot = this.slotOf(lane.index * perLane + ty * tilesX + tx);
    if (slot < 0) return null;
    const cur = this.slotBase(slot) + this.parity * SET_PLANES * PLANE;
    const out = new Uint8ClampedArray(TILE * TILE * 4);
    let any = false;
    for (let y = 0; y < WET_TILE; y++) {
      for (let x = 0; x < WET_TILE; x++) {
        const c = (y + 1) * S + x + 1;
        const rho = this.f32[cur + P_RHO * PLANE + c];
        const sw = this.f32[cur + P_SW * PLANE + c];
        const a = Math.min(1, rho * 2.5) * 0.7 + Math.min(1, sw * 4) * 0.2;
        if (a <= 0.004) continue;
        const i = (y * TILE + x) * 4;
        out[i] = 40;
        out[i + 1] = 120;
        out[i + 2] = 255;
        out[i + 3] = Math.round(a * 255);
        any = true;
      }
    }
    return any ? out : null;
  }

  // --- Engine B (WebGPU mirror) ---------------------------------------------------

  /**
   * Attaches a GPU engine (or `null` to detach). From then on, whenever at least `gpuMinTiles` tiles
   * are live, the GPU mirrors the slots and `displayGpu` shades on it. The CPU stays the authority.
   */
  attachGpu(engine: WetGpuEngine | null): void {
    this.gpu = engine;
    this.gpuLive = false;
    this.gpuFailure = null;
  }

  /** The attached GPU engine, if any. */
  get gpuEngine(): WetGpuEngine | null {
    return this.gpu;
  }

  /** Whether the GPU mirror is in use now (an engine is attached and the wet area is large). */
  get gpuActive(): boolean {
    return this.gpuLive;
  }

  /** Why the GPU stopped (a lost device, out of GPU memory), or `null`. */
  get gpuError(): string | null {
    return this.gpuFailure;
  }

  private gpuDirtySlot(slot: number, y0: number, y1: number): void {
    if (!this.gpuLive || slot < 0) return;
    const d = this.gpuDirty.get(slot);
    this.gpuDirty.set(slot, d ? [Math.min(d[0], y0), Math.max(d[1], y1)] : [y0, y1]);
  }

  private gpuStop(reason: string | null): void {
    this.gpuLive = false;
    this.gpuDirty.clear();
    if (reason) {
      this.gpuFailure = reason;
      this.gpu = null;
      if (!this.warnings.includes(reason)) this.warnings.push(reason);
    }
  }

  /** Turns the mirror on or off for the current wet area. Returns whether it is on. */
  private gpuDecide(): boolean {
    // On at gpuMinTiles, off below half of it (so it does not flip at the threshold).
    const want = Boolean(this.gpu) && this.active.length >= (this.gpuLive ? Math.ceil(this.gpuMinTiles / 2) : this.gpuMinTiles);
    if (want && !this.gpuLive) {
      const gpu = this.gpu!;
      if (gpu.lostReason) {
        this.gpuStop(`The GPU was lost (${gpu.lostReason}); wet paint runs on the CPU.`);
        return false;
      }
      if (!gpu.ensureSlots(this.slotCount)) return false;
      this.gpuLive = true;
      this.gpuParamsDirty = true;
      for (const key of this.active) this.gpuDirtySlot(this.slotOf(key), 0, SLOT_SIDE - 1);
    } else if (!want && this.gpuLive) this.gpuStop(null);
    return this.gpuLive;
  }

  /** Uploads what the CPU changed since the last upload (the current set and deposits; whole slots on wake-up). */
  private gpuSync(): void {
    const gpu = this.gpu!;
    if (!gpu.ensureSlots(this.slotCount)) {
      this.gpuStop(null);
      return;
    }
    if (this.gpuParamsDirty) {
      for (const lane of this.lanes) if (lane) gpu.setParams(lane.index, this.f32.subarray((this.layout.params >> 2) + lane.index * PARAM_FLOATS, (this.layout.params >> 2) + (lane.index + 1) * PARAM_FLOATS));
      this.gpuParamsDirty = false;
    }
    if (!this.gpuDirty.size) return;
    for (const [slot, [y0, y1]] of this.gpuDirty) {
      const b = this.slotBase(slot);
      if (y0 === 0 && y1 === SLOT_SIDE - 1) {
        gpu.writeSlot(slot, 0, this.f32.subarray(b, b + SLOT_FLOATS));
        continue;
      }
      const from = y0 * SLOT_SIDE;
      const to = (y1 + 1) * SLOT_SIDE;
      const planes = [...Array(SET_PLANES).keys()].map((k) => this.parity * SET_PLANES + k).concat([P_D0, P_D0 + 1, P_D0 + 2, P_D0 + 3]);
      for (const plane of planes) gpu.writeSlot(slot, plane * PLANE + from, this.f32.subarray(b + plane * PLANE + from, b + plane * PLANE + to));
    }
    this.gpuDirty.clear();
    // The GPU refills halos from the uploaded interiors.
    gpu.refreshHalos(this.gpuJobs(this.active), this.parity);
  }

  private gpuJobs(keys: readonly number[]): WetGpuJob[] {
    const { tilesX, tilesY, perLane } = this.layout;
    return keys.map((key) => {
      const laneBase = this.laneIndexOf(key) * perLane;
      const [tx, ty] = this.tileXY(key);
      const at = (dx: number, dy: number) => {
        const x = tx + dx;
        const y = ty + dy;
        return x < 0 || y < 0 || x >= tilesX || y >= tilesY ? -1 : this.slotOf(laneBase + y * tilesX + x);
      };
      return {
        slot: this.slotOf(key),
        lane: this.laneIndexOf(key),
        neighbours: [at(0, -1), at(0, 1), at(-1, 0), at(1, 0), at(-1, -1), at(1, -1), at(-1, 1), at(1, 1)],
        width: Math.min(WET_TILE, this.width - tx * WET_TILE),
        height: Math.min(WET_TILE, this.height - ty * WET_TILE),
      };
    });
  }

  /** Runs the coming CPU batch of `n` steps on the GPU mirror too. */
  private gpuBatch(n: number): void {
    if (!this.gpu || !this.gpuDecide()) return;
    try {
      this.gpuSync();
      if (!this.gpuLive) return;
      this.gpu.step(this.gpuJobs(this.active), this.parity, n).catch((e: Error) => this.gpuStop(`Wet paint stopped using the GPU (${e.message}).`));
    } catch (e) {
      this.gpuStop(`Wet paint stopped using the GPU (${(e as Error).message}).`);
    }
  }

  /**
   * Like `display`, but shades every stale tile on the GPU at once (when the mirror is in use;
   * otherwise, or when the world changed while the GPU worked, it is `display(id, maxCpuTiles)`).
   * Call between batches.
   */
  async displayGpu(id: string, maxCpuTiles = Infinity): Promise<{ surface: TiledSurface; changed: RasterRect[]; pending: number; gpu: boolean }> {
    if (!this.gpu || this.busyFlag || !this.gpuDecide()) return { ...this.display(id, maxCpuTiles), gpu: false };
    const lane = this.laneOf(id);
    const keys = this.active.filter((k) => this.laneIndexOf(k) === lane.index);
    const stale = keys.filter((k) => lane.shaded.get(this.tileKeyOf(k))?.stamp !== lane.stamp);
    if (!stale.length) return { ...this.display(id, 0), gpu: true };
    let tiles: Uint8ClampedArray[];
    const stamp = lane.stamp;
    const base = lane.base;
    try {
      this.gpuSync();
      tiles = await this.gpu.shade(this.gpuJobs(stale), this.parity, stale.map((k) => base.tiles.get(this.tileKeyOf(k))?.data ?? null), [this.paperBytes[0], this.paperBytes[1], this.paperBytes[2]]);
    } catch (e) {
      this.gpuStop(`Wet paint stopped using the GPU (${(e as Error).message}).`);
      return { ...this.display(id, maxCpuTiles), gpu: false };
    }
    // The world may have moved on while the GPU worked (an edit, a step): keep the result only if nothing changed.
    if (lane.stamp !== stamp || lane.base !== base || this.lanes[lane.index] !== lane) return { ...this.display(id, maxCpuTiles), gpu: false };
    const changed: RasterRect[] = [];
    stale.forEach((key, i) => {
      const tk = this.tileKeyOf(key);
      const tile = finishTile(new Uint8ClampedArray(tiles[i]), 4, 0);
      lane.shaded.set(tk, { stamp: lane.stamp, tile: tile ?? { data: new Uint8ClampedArray(0), uniform: 0 } });
      lane.urgent.delete(tk);
      const [tx, ty] = this.tileXY(key);
      changed.push({ x: tx * WET_TILE, y: ty * WET_TILE, width: WET_TILE, height: WET_TILE });
    });
    lane.shadedVersion++;
    const d = this.display(id, 0);
    return { surface: d.surface, changed, pending: 0, gpu: true };
  }

  // --- Snapshots -----------------------------------------------------------------

  /** A copy of everything (for undo): live slots, layers, clock and tilt. */
  snapshot(): WetSnapshot {
    this.requireIdle();
    const slots = new Map<number, { planes: Float32Array; last: number }>();
    let bytes = 0;
    for (const key of this.active) {
      const b = this.slotBase(this.slotOf(key));
      const planes = new Float32Array(SNAP_PLANES * PLANE);
      planes.set(this.f32.subarray(b + this.parity * SET_PLANES * PLANE, b + (this.parity + 1) * SET_PLANES * PLANE), 0);
      planes.set(this.f32.subarray(b + P_D0 * PLANE, b + (P_D0 + 4) * PLANE), SET_PLANES * PLANE);
      slots.set(key, { planes, last: this.u32[(this.layout.last >> 2) + key] });
      bytes += planes.byteLength;
    }
    const lanes = this.lanes.filter((l): l is Lane => Boolean(l)).map((l) => ({ id: l.id, index: l.index, params: { ...l.params }, flow: l.flow, flowStrength: l.flowStrength, base: l.base }));
    return { clock: this.clock, tilt: { ...this.tilt }, lanes, slots, bytes };
  }

  /** Puts a snapshot back exactly (the simulation then continues as it would have). */
  restore(snap: WetSnapshot): void {
    this.requireIdle();
    for (const key of [...this.active]) this.free(key);
    this.lanes.fill(null);
    this.tilt = { ...snap.tilt };
    for (const l of snap.lanes) {
      this.lanes[l.index] = { id: l.id, index: l.index, params: { ...l.params }, flow: l.flow, flowStrength: l.flowStrength, base: l.base, shaded: new Map(), urgent: new Set(), stamp: 1, display: null, shadedVersion: 0, displayKey: '' };
      this.pack(this.lanes[l.index]!);
    }
    for (const [key, { planes, last }] of snap.slots) {
      if (!this.activate(key)) continue;
      const b = this.slotBase(this.slotOf(key));
      this.f32.set(planes.subarray(0, SET_PLANES * PLANE), b + this.parity * SET_PLANES * PLANE);
      this.f32.set(planes.subarray(SET_PLANES * PLANE), b + P_D0 * PLANE);
      this.u32[(this.layout.last >> 2) + key] = last;
    }
    this.clock = snap.clock;
    this.syncList();
    this.refreshHalos();
    for (const key of this.active) this.gpuDirtySlot(this.slotOf(key), 0, SLOT_SIDE - 1);
  }

  /** Bytes of wasm memory held. */
  memoryBytes(): number {
    return this.memory.buffer.byteLength;
  }

  /** Live tiles across all layers. */
  activeTiles(): number {
    return this.active.length;
  }

  /** Memory for tests and tools: the raw f32 view (read only, please). */
  get rawFloats(): Float32Array {
    return this.f32;
  }

  /** The current set's parity (tests). */
  get currentParity(): number {
    return this.parity;
  }

  /** Float index of a slot's first plane (tests). */
  slotIndex(id: string, tx: number, ty: number): number {
    const lane = this.laneOf(id);
    const slot = this.slotOf(lane.index * this.layout.perLane + ty * this.layout.tilesX + tx);
    return slot < 0 ? -1 : this.slotBase(slot);
  }
}

function unionRect(a: RasterRect | null, b: RasterRect): RasterRect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

