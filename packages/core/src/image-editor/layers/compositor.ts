/**
 * The per-tile layer compositor. Composites a layer stack (pixel, adjustment, group and
 * annotation layers, with masks, clipping, blend modes, opacity and fill) tile by tile in
 * document space, in pure TypeScript, so results are deterministic and testable in Node.
 *
 * Caches:
 * - Each top-level *step* (a pixel layer and the layers clipped to it, a run of adjustment layers,
 *   a group, an annotation layer) has a per-tile *signature*: its properties plus the identity of
 *   every surface tile it reads. A tile whose signatures are unchanged returns the cached result
 *   (same buffer object, so callers can skip uploading it).
 * - A prefix cache keeps the accumulator *before* the step that changed last time. Dragging a
 *   slider on layer k, or a stroke on layer k, recomposites from step k upwards only.
 * - Spatial filters (blur) and feathered or parametric masks are computed once over the canvas
 *   and cached by the identity of their inputs.
 *
 * Consecutive adjustment layers run as one float pass with one rounding at the end, exactly as
 * `applyAdjustmentLayers` does, so a document migrated from adjustment layers renders identically.
 */

import { blendChannel, blendRgb, isSeparableBlendMode, type BlendMode } from '../blend';
import { applyAdjustmentLayers } from '../adjustment-layers';
import { applyBoxBlur, applyLegacyAdjustments, applyProcess2Adjustments } from '../filters';
import { LATEST_PROCESS_VERSION, normalizeProcessVersion } from '../color';
import { gaussianBlur } from '../selection/modify';
import type { AdjustmentLayer, Annotation, CropBox, DepthMaskOptions, ImageAdjustments } from '../types';
import {
  isActiveFilter,
  isSpatialFilter,
  type AdjustmentLayerNode,
  type AnnotationLayer,
  type GroupLayer,
  type ImageLayer,
  type LayerFilter,
  type PixelLayer,
  type RasterMask,
} from './model';
import {
  TILE,
  emptySurface,
  readRegion,
  surfaceFromPixels,
  tileKey,
  tilesInRect,
  type PixelSurface,
  type TileKey,
  type TiledSurface,
} from './surface';

const TILE_PIXELS = TILE * TILE;
const TILE_BYTES = TILE_PIXELS * 4;

/** What the compositor needs from its host besides the layers. */
export interface CompositorSources {
  /** Canvas (document) size: the blur filter and mask feathering clamp at this rect. */
  width: number;
  height: number;
  /** The pixels of a pixel layer (resolves layers whose pixels are the document source). */
  surfaceOf?(layer: PixelLayer): PixelSurface;
  /**
   * A parametric mask's depth map as RGBA at canvas size (the red channel is the depth), or
   * `null` while it is unavailable (the mask then reveals everything).
   */
  depthMap?(source: DepthMaskOptions): { width: number; height: number; data: ArrayLike<number> } | null;
  /** Draws one annotation into RGBA for `rect` (canvas hosts only); `null` when unavailable. */
  rasterizeAnnotation?(annotation: Annotation, rect: CropBox): Uint8ClampedArray | null;
  /** Changes whenever one of the callbacks above would return something new for the same layers. */
  version?: number | string;
}

export interface CompositorOptions {
  /** Upper bound for cached tile buffers (default 256 MiB). */
  maxCacheBytes?: number;
}

export interface CompositeCallOptions {
  /**
   * The layer about to be edited (the active layer): every tile composited in this call keeps a
   * checkpoint below its step, so strokes and slider drags on it start there.
   */
  checkpointLayerId?: string | null;
  /**
   * Where the layers changed since the previous call, when the caller knows (a stroke's dabs).
   * Changed tiles are then recomposited only inside these rectangles. Changes outside them would
   * be missed, so pass nothing when unsure.
   */
  dirty?: CropBox[];
}

// ---------------------------------------------------------------------------
// Steps and signatures
// ---------------------------------------------------------------------------

type ContentLayer = PixelLayer | AnnotationLayer;

type Step =
  | { kind: 'content'; layer: ContentLayer; clipped: ImageLayer[] }
  | { kind: 'adjust'; layers: AdjustmentLayerNode[] }
  | { kind: 'group'; layer: GroupLayer; clipped: ImageLayer[]; steps: Step[] };

interface Sig {
  key: string;
  refs: unknown[];
}

function sameSig(a: Sig | undefined, b: Sig): boolean {
  if (!a || a.key !== b.key || a.refs.length !== b.refs.length) return false;
  for (let i = 0; i < a.refs.length; i++) if (a.refs[i] !== b.refs[i]) return false;
  return true;
}

const stepsCache = new WeakMap<readonly ImageLayer[], Step[]>();

/**
 * Groups a layer list into compositing steps: clipped layers join the nearest unclipped
 * content or group layer below; consecutive unclipped adjustment layers form one run.
 */
function buildSteps(layers: readonly ImageLayer[]): Step[] {
  const cached = stepsCache.get(layers);
  if (cached) return cached;
  const steps: Step[] = [];
  for (const layer of layers) {
    const last = steps[steps.length - 1];
    if (layer.clipped && last && (last.kind === 'content' || last.kind === 'group')) {
      last.clipped.push(layer);
      continue;
    }
    if (layer.type === 'adjustment') {
      if (last && last.kind === 'adjust') last.layers.push(layer);
      else steps.push({ kind: 'adjust', layers: [layer] });
    } else if (layer.type === 'group') {
      steps.push({ kind: 'group', layer, clipped: [], steps: buildSteps(layer.children) });
    } else {
      steps.push({ kind: 'content', layer, clipped: [] });
    }
  }
  stepsCache.set(layers, steps);
  return steps;
}

/** The bounding box of the parts of `rects` inside tile (tx, ty), or `null` when none is. */
function dirtyInTile(rects: CropBox[], tx: number, ty: number): CropBox | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const ox = tx * TILE;
  const oy = ty * TILE;
  for (const r of rects) {
    const a = Math.max(ox, Math.floor(r.x));
    const b = Math.max(oy, Math.floor(r.y));
    const c = Math.min(ox + TILE, Math.ceil(r.x + r.width));
    const d = Math.min(oy + TILE, Math.ceil(r.y + r.height));
    if (c <= a || d <= b) continue;
    x0 = Math.min(x0, a);
    y0 = Math.min(y0, b);
    x1 = Math.max(x1, c);
    y1 = Math.max(y1, d);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The index of the top-level step that holds layer `id` (searching groups and clipped layers), or -1. */
function stepIndexOf(steps: Step[], id: string): number {
  const holds = (l: ImageLayer): boolean => l.id === id || (l.type === 'group' && l.children.some(holds));
  return steps.findIndex((s) =>
    s.kind === 'adjust' ? s.layers.some(holds) : holds(s.layer) || s.clipped.some(holds)
  );
}

/** Properties of a layer that change pixels, minus its surfaces (memoised per object). */
const propsKeyCache = new WeakMap<object, string>();
function propsKey(layer: ImageLayer): string {
  let key = propsKeyCache.get(layer);
  if (key !== undefined) return key;
  const mask = layer.mask
    ? [layer.mask.enabled !== false, layer.mask.density ?? 1, layer.mask.feather ?? 0, layer.mask.defaultValue, layer.mask.source ?? null]
    : null;
  const base: unknown[] = [layer.type, layer.id, layer.visible, layer.opacity, layer.blend, Boolean(layer.clipped), mask];
  if (layer.type === 'pixel') base.push(layer.offset.x, layer.offset.y, layer.fillOpacity ?? 1, layer.filters ?? null, layer.source ?? null);
  else if (layer.type === 'adjustment') base.push(layer.kind, layer.params);
  else if (layer.type === 'annotation') base.push(layer.annotation);
  key = JSON.stringify(base);
  propsKeyCache.set(layer, key);
  return key;
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

const legacyViewCache = new WeakMap<AdjustmentLayerNode, AdjustmentLayer>();

/** The `AdjustmentLayer` shape `applyAdjustmentLayers` evaluates, for a node (memoised). */
export function adjustmentNodeAsLayer(node: AdjustmentLayerNode): AdjustmentLayer {
  let view = legacyViewCache.get(node);
  if (!view) {
    view = {
      id: node.id,
      kind: node.kind,
      enabled: node.visible,
      opacity: node.opacity,
      blend: node.blend,
      params: node.params,
    } as AdjustmentLayer;
    legacyViewCache.set(node, view);
  }
  return view;
}

/** Develop settings as `ImageAdjustments` for the process functions (opacity is document-level). */
function developAdjustments(f: Extract<LayerFilter, { kind: 'develop' }>): ImageAdjustments {
  return {
    brightness: f.brightness,
    contrast: f.contrast,
    saturation: f.saturation,
    exposure: f.exposure,
    temperature: f.temperature,
    tint: f.tint ?? 0,
    blur: 0,
    opacity: 1,
    process: f.process,
  };
}

/** Runs per-pixel filters over RGBA `data` in place. */
function applyPixelFilters(data: Uint8ClampedArray, filters: readonly LayerFilter[]): void {
  for (const f of filters) {
    if (!isActiveFilter(f) || f.kind !== 'develop') continue;
    const adj = developAdjustments(f);
    if (normalizeProcessVersion(adj.process) === LATEST_PROCESS_VERSION) applyProcess2Adjustments({ data }, adj);
    else applyLegacyAdjustments({ data }, adj);
  }
}

/** Evaluates a depth mask (see `applyDepthMask`) into one coverage byte per depth sample. */
export function depthMaskAlpha(depth: number, options: DepthMaskOptions): number {
  const { mode, depthRange, softness, invert } = options;
  let v = invert ? 255 - depth : depth;
  const soft = Math.max(1, softness || 10);
  const [lo, hi] = depthRange;
  if (mode === 'threshold') {
    if (v >= hi + soft) return 0;
    if (v > hi) return Math.round(((hi + soft - v) / soft) * 255);
    if (v >= lo) return 255;
    if (v < lo - soft) return 0;
    return Math.round(((v - (lo - soft)) / soft) * 255);
  }
  v += lo;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// ---------------------------------------------------------------------------
// Blending
// ---------------------------------------------------------------------------

/**
 * Blends straight-alpha `src` over `dst` (both RGBA tiles) in place with `mode`, scaling the
 * source alpha by `alpha` and, per pixel, by `coverage`. Same maths as `blendPixel`.
 */
export function blendTile(
  dst: Uint8ClampedArray,
  src: ArrayLike<number>,
  mode: BlendMode,
  alpha: number,
  coverage: ArrayLike<number> | null
): void {
  if (!(alpha > 0)) return;
  const normal = mode === 'normal';
  const lut = !normal && isSeparableBlendMode(mode) ? separableLut(mode) : null;
  const cb = [0, 0, 0];
  const cs = [0, 0, 0];
  const n = dst.length;
  for (let i = 0, p = 0; i < n; i += 4, p++) {
    const sa = src[i + 3];
    if (sa === 0) continue;
    const k = coverage ? alpha * coverage[p] : alpha;
    if (!(k > 0)) continue;
    if (normal && sa === 255 && k >= 1) {
      // Opaque normal source: the result is the source (what the general formula rounds to).
      dst[i] = src[i];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i + 2];
      dst[i + 3] = 255;
      continue;
    }
    const as = (sa / 255) * k;
    const ab = dst[i + 3] / 255;
    const ao = as + ab * (1 - as);
    if (ao <= 0) {
      dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0;
      continue;
    }
    const d0 = dst[i];
    const d1 = dst[i + 1];
    const d2 = dst[i + 2];
    const b0 = d0 / 255;
    const b1 = d1 / 255;
    const b2 = d2 / 255;
    const s0 = src[i] / 255;
    const s1 = src[i + 1] / 255;
    const s2 = src[i + 2] / 255;
    let m0: number;
    let m1: number;
    let m2: number;
    if (normal) {
      m0 = s0;
      m1 = s1;
      m2 = s2;
    } else if (lut) {
      m0 = lut[(d0 << 8) | src[i]];
      m1 = lut[(d1 << 8) | src[i + 1]];
      m2 = lut[(d2 << 8) | src[i + 2]];
    } else {
      cb[0] = b0;
      cb[1] = b1;
      cb[2] = b2;
      cs[0] = s0;
      cs[1] = s1;
      cs[2] = s2;
      const m = blendRgb(mode, cb, cs);
      m0 = m[0];
      m1 = m[1];
      m2 = m[2];
    }
    const wb = (1 - as) * ab;
    const ws = (1 - ab) * as;
    const wm = as * ab;
    dst[i] = Math.round(((wb * b0 + ws * s0 + wm * m0) / ao) * 255);
    dst[i + 1] = Math.round(((wb * b1 + ws * s1 + wm * m1) / ao) * 255);
    dst[i + 2] = Math.round(((wb * b2 + ws * s2 + wm * m2) / ao) * 255);
    dst[i + 3] = Math.round(ao * 255);
  }
}

const separableLuts = new Map<BlendMode, Float64Array>();

/** `B(cb, cs)` of a separable mode for every pair of 8-bit values (index `cb << 8 | cs`). */
function separableLut(mode: BlendMode): Float64Array {
  let lut = separableLuts.get(mode);
  if (!lut) {
    lut = new Float64Array(65536);
    for (let b = 0; b < 256; b++) for (let c = 0; c < 256; c++) lut[(b << 8) | c] = blendChannel(mode, b / 255, c / 255);
    separableLuts.set(mode, lut);
  }
  return lut;
}

/** Composites `src` onto `dst` but keeps `dst`'s alpha (clipping: source-atop). */
function blendAtop(dst: Uint8ClampedArray, src: ArrayLike<number>, mode: BlendMode, alpha: number, coverage: ArrayLike<number> | null): void {
  const keep = new Uint8ClampedArray(dst.length >> 2);
  for (let i = 3, p = 0; i < dst.length; i += 4, p++) keep[p] = dst[i];
  blendTile(dst, src, mode, alpha, coverage);
  for (let i = 3, p = 0; i < dst.length; i += 4, p++) dst[i] = keep[p];
}

/** `dst = lerp(before, dst, alpha · coverage)` per channel (pass-through groups with opacity). */
function lerpTile(dst: Uint8ClampedArray, before: Uint8ClampedArray, alpha: number, coverage: ArrayLike<number> | null): void {
  for (let i = 0, p = 0; i < dst.length; i += 4, p++) {
    const k = coverage ? alpha * coverage[p] : alpha;
    if (k >= 1) continue;
    for (let c = 0; c < 4; c++) dst[i + c] = Math.round(before[i + c] + (dst[i + c] - before[i + c]) * k);
  }
}

// ---------------------------------------------------------------------------
// The compositor
// ---------------------------------------------------------------------------

interface TileEntry {
  sigs: Sig[];
  /** Accumulator before step `index` (index 0 is the empty accumulator and is never stored). */
  checkpoints: Map<number, { data: Uint8ClampedArray; empty: boolean }>;
  result: Uint8ClampedArray;
  /** The root list the entry was computed for (sigs are only comparable per root). */
  root: readonly ImageLayer[];
  stamp: number;
}

interface CoveragePlane {
  /** Coverage over the canvas (`width × height`), or per-tile for unfeathered masks. */
  data: Float32Array;
  width: number;
  height: number;
}

const ZERO_TILE = new Uint8ClampedArray(TILE_BYTES);

/** Statistics of the last `composite` call (for benchmarks and tests). */
export interface CompositeStats {
  tiles: number;
  /** Tiles returned straight from the cache. */
  cached: number;
  /** Steps actually run, summed over tiles. */
  stepsRun: number;
}

export class LayerCompositor {
  private readonly tiles = new Map<TileKey, TileEntry>();
  private readonly maxCacheBytes: number;
  private cacheBytes = 0;
  private stamp = 0;
  private sources: CompositorSources = { width: 1, height: 1 };
  private sourcesVersion: unknown = undefined;
  private filteredCache = new WeakMap<object, Map<string, PixelSurface>>();
  private planeCache = new Map<string, CoveragePlane>();
  private planeIds = new WeakMap<object, number>();
  private nextPlaneId = 1;
  private contentCache = new WeakMap<object, Map<string, Uint8ClampedArray>>();
  lastStats: CompositeStats = { tiles: 0, cached: 0, stepsRun: 0 };
  private hint = -1;

  constructor(options: CompositorOptions = {}) {
    this.maxCacheBytes = options.maxCacheBytes ?? 256 * 1024 * 1024;
  }

  /** Drops every cached tile and plane. */
  clear(): void {
    this.tiles.clear();
    this.cacheBytes = 0;
    this.planeCache.clear();
    this.filteredCache = new WeakMap();
    this.contentCache = new WeakMap();
  }

  private setSources(sources: CompositorSources): void {
    const version = `${sources.width}x${sources.height}:${sources.version ?? ''}`;
    if (version !== this.sourcesVersion) {
      this.clear();
      this.sourcesVersion = version;
    }
    this.sources = sources;
  }

  /**
   * The composite of `layers` over `rect` as `rect.width × rect.height` RGBA (straight alpha).
   */
  composite(layers: readonly ImageLayer[], rect: CropBox, sources: CompositorSources, options: CompositeCallOptions = {}): Uint8ClampedArray {
    const out = new Uint8ClampedArray(Math.max(0, rect.width * rect.height * 4));
    this.compositeTiles(layers, rect, sources, (tx, ty, data) => {
      const ox = tx * TILE;
      const oy = ty * TILE;
      const x0 = Math.max(rect.x, ox);
      const y0 = Math.max(rect.y, oy);
      const x1 = Math.min(rect.x + rect.width, ox + TILE);
      const y1 = Math.min(rect.y + rect.height, oy + TILE);
      const span = (x1 - x0) * 4;
      for (let y = y0; y < y1; y++) {
        const s = ((y - oy) * TILE + (x0 - ox)) * 4;
        out.set(data.subarray(s, s + span), ((y - rect.y) * rect.width + (x0 - rect.x)) * 4);
      }
    }, options);
    return out;
  }

  /**
   * Composites every tile intersecting `rect` and calls `onTile` with each tile's RGBA buffer
   * (TILE × TILE). A tile whose inputs did not change since the last call returns the same buffer
   * object; never mutate it.
   */
  compositeTiles(
    layers: readonly ImageLayer[],
    rect: CropBox,
    sources: CompositorSources,
    onTile: (tx: number, ty: number, data: Uint8ClampedArray, changed: boolean) => void,
    options: CompositeCallOptions = {}
  ): void {
    this.setSources(sources);
    const steps = buildSteps(layers);
    this.hint = options.checkpointLayerId ? stepIndexOf(steps, options.checkpointLayerId) : -1;
    this.stamp++;
    const stats: CompositeStats = { tiles: 0, cached: 0, stepsRun: 0 };
    for (const { tx, ty } of tilesInRect(rect)) {
      stats.tiles++;
      const before = this.tiles.get(tileKey(tx, ty))?.result;
      const data = this.compositeTile(layers, steps, tx, ty, stats, options.dirty ? dirtyInTile(options.dirty, tx, ty) : null);
      onTile(tx, ty, data, data !== before);
    }
    this.lastStats = stats;
    this.evict();
  }

  /** The composite of one tile (cached; do not mutate the result). */
  tile(layers: readonly ImageLayer[], tx: number, ty: number, sources: CompositorSources): Uint8ClampedArray {
    this.setSources(sources);
    this.stamp++;
    const stats: CompositeStats = { tiles: 1, cached: 0, stepsRun: 0 };
    this.hint = -1;
    const data = this.compositeTile(layers, buildSteps(layers), tx, ty, stats);
    this.lastStats = stats;
    this.evict();
    return data;
  }

  private compositeTile(
    root: readonly ImageLayer[],
    steps: Step[],
    tx: number,
    ty: number,
    stats: CompositeStats,
    dirty: CropBox | null = null
  ): Uint8ClampedArray {
    const key = tileKey(tx, ty);
    const entry = this.tiles.get(key);
    const sigs = steps.map((s) => this.stepSig(s, tx, ty));
    let first = 0;
    if (entry) {
      while (first < sigs.length && first < entry.sigs.length && sameSig(entry.sigs[first], sigs[first])) first++;
      if (first === sigs.length && first === entry.sigs.length) {
        entry.stamp = this.stamp;
        stats.cached++;
        return entry.result;
      }
    }
    // Resume from the best checkpoint at or below the first changed step.
    let start = 0;
    let base: { data: Uint8ClampedArray; empty: boolean } | null = null;
    if (entry) {
      for (const [index, cp] of entry.checkpoints) {
        if (index <= first && index > start) {
          start = index;
          base = cp;
        }
      }
    }
    const tileRect = { x: tx * TILE, y: ty * TILE, width: TILE, height: TILE };
    const hint = this.hint;
    const checkpoints = new Map<number, { data: Uint8ClampedArray; empty: boolean }>();
    if (entry) for (const [index, cp] of entry.checkpoints) if (index <= start) checkpoints.set(index, cp);
    let result: Uint8ClampedArray;

    if (entry && dirty && (dirty.width < TILE || dirty.height < TILE)) {
      // Only `dirty` changed: recomposite that part from the checkpoint and patch the previous result.
      const r = dirty;
      const sub = (data: Uint8ClampedArray | null) => {
        const out = new Uint8ClampedArray(r.width * r.height * 4);
        if (!data) return out;
        for (let y = 0; y < r.height; y++) {
          const s = ((r.y - tileRect.y + y) * TILE + (r.x - tileRect.x)) * 4;
          out.set(data.subarray(s, s + r.width * 4), y * r.width * 4);
        }
        return out;
      };
      const acc = sub(base ? base.data : null);
      let empty = base ? base.empty : true;
      for (let i = start; i < steps.length; i++) {
        empty = this.runStep(steps[i], acc, empty, r);
        stats.stepsRun++;
      }
      result = new Uint8ClampedArray(entry.result);
      for (let y = 0; y < r.height; y++) {
        result.set(acc.subarray(y * r.width * 4, (y + 1) * r.width * 4), ((r.y - tileRect.y + y) * TILE + (r.x - tileRect.x)) * 4);
      }
    } else {
      const acc = base ? new Uint8ClampedArray(base.data) : new Uint8ClampedArray(TILE_BYTES);
      let empty = base ? base.empty : true;
      for (let i = start; i < steps.length; i++) {
        if ((i === first || i === hint) && i > 0 && !checkpoints.has(i)) checkpoints.set(i, { data: new Uint8ClampedArray(acc), empty });
        empty = this.runStep(steps[i], acc, empty, tileRect);
        stats.stepsRun++;
      }
      result = empty ? ZERO_TILE : acc;
    }
    // Keep few checkpoints: below the active layer, below the step that changed, and the newest.
    if (checkpoints.size > 2) {
      const keys = [...checkpoints.keys()].sort((a, b) => a - b);
      const keep = new Set([keys[keys.length - 1], first, hint]);
      for (const k of keys) if (!keep.has(k)) checkpoints.delete(k);
    }
    const prevBytes = entry ? this.entryBytes(entry) : 0;
    const next: TileEntry = { sigs, checkpoints, result, root, stamp: this.stamp };
    this.tiles.set(key, next);
    this.cacheBytes += this.entryBytes(next) - prevBytes;
    return result;
  }

  private entryBytes(e: TileEntry): number {
    let n = e.result === ZERO_TILE ? 0 : TILE_BYTES;
    for (const cp of e.checkpoints.values()) n += cp.data.byteLength;
    return n;
  }

  private evict(): void {
    if (this.cacheBytes <= this.maxCacheBytes) return;
    // Drop checkpoints first (oldest tiles first), then whole entries not used this call.
    const entries = [...this.tiles.entries()].sort((a, b) => a[1].stamp - b[1].stamp);
    for (const [, e] of entries) {
      if (this.cacheBytes <= this.maxCacheBytes) return;
      for (const cp of e.checkpoints.values()) this.cacheBytes -= cp.data.byteLength;
      e.checkpoints.clear();
    }
    for (const [k, e] of entries) {
      if (this.cacheBytes <= this.maxCacheBytes) return;
      if (e.stamp === this.stamp) continue;
      this.cacheBytes -= this.entryBytes(e);
      this.tiles.delete(k);
    }
  }

  // --- Signatures -----------------------------------------------------------

  private stepSig(step: Step, tx: number, ty: number): Sig {
    if (step.kind === 'adjust') {
      const refs: unknown[] = [];
      let key = 'A';
      for (const l of step.layers) {
        key += propsKey(l);
        refs.push(...this.maskRefs(l, tx, ty, 0, 0));
      }
      return { key, refs };
    }
    const own = step.kind === 'content' ? this.contentSig(step.layer, tx, ty) : this.groupSig(step.layer, step.steps, tx, ty);
    if (!step.clipped.length) return own;
    const refs = [...own.refs];
    let key = own.key;
    for (const c of step.clipped) {
      const s = this.layerSig(c, tx, ty);
      key += '|' + s.key;
      refs.push(...s.refs);
    }
    return { key, refs };
  }

  private layerSig(layer: ImageLayer, tx: number, ty: number): Sig {
    if (layer.type === 'adjustment') return { key: propsKey(layer), refs: this.maskRefs(layer, tx, ty, 0, 0) };
    if (layer.type === 'group') return this.groupSig(layer, buildSteps(layer.children), tx, ty);
    return this.contentSig(layer, tx, ty);
  }

  private groupSig(group: GroupLayer, steps: Step[], tx: number, ty: number): Sig {
    let key = 'G' + propsKey(group);
    const refs = this.maskRefs(group, tx, ty, 0, 0);
    if (!group.visible) return { key, refs };
    for (const s of steps) {
      const sig = this.stepSig(s, tx, ty);
      key += '[' + sig.key + ']';
      refs.push(...sig.refs);
    }
    return { key, refs };
  }

  private contentSig(layer: ContentLayer, tx: number, ty: number): Sig {
    const key = 'C' + propsKey(layer);
    if (!layer.visible) return { key, refs: [] };
    if (layer.type === 'annotation') return { key, refs: this.maskRefs(layer, tx, ty, 0, 0) };
    const { surface, dx, dy } = this.layerPixels(layer);
    const refs: unknown[] = [surface.defaultValue];
    const r = { x: tx * TILE - dx, y: ty * TILE - dy, width: TILE, height: TILE };
    for (const t of tilesInRect(r)) refs.push(surface.getTile(t.tx, t.ty) ?? null);
    refs.push(...this.maskRefs(layer, tx, ty, layer.offset.x, layer.offset.y));
    return { key, refs };
  }

  private maskRefs(layer: ImageLayer, tx: number, ty: number, ox: number, oy: number): unknown[] {
    const mask = layer.mask;
    if (!mask || mask.enabled === false) return [];
    if (mask.source || (mask.feather ?? 0) > 0) return [this.planeFor(mask, ox, oy)];
    const refs: unknown[] = [];
    for (const t of tilesInRect({ x: tx * TILE - ox, y: ty * TILE - oy, width: TILE, height: TILE })) {
      refs.push(mask.surface.getTile(t.tx, t.ty) ?? null);
    }
    return refs;
  }

  // --- Layer pixels ------------------------------------------------------------

  /**
   * A pixel layer's pixels after spatial filters: the surface and the offset to apply. Layers
   * with a spatial filter are filtered once over the canvas (in document space, offset 0).
   */
  private layerPixels(layer: PixelLayer): { surface: PixelSurface; dx: number; dy: number; perPixel: LayerFilter[] } {
    const raw = this.sources.surfaceOf ? this.sources.surfaceOf(layer) : layer.surface;
    const filters = (layer.filters ?? []).filter(isActiveFilter);
    if (!filters.some(isSpatialFilter)) return { surface: raw, dx: layer.offset.x, dy: layer.offset.y, perPixel: filters };
    const fkey = `${layer.offset.x},${layer.offset.y}:${JSON.stringify(filters)}`;
    let byKey = this.filteredCache.get(raw);
    if (!byKey) {
      byKey = new Map();
      this.filteredCache.set(raw, byKey);
    }
    let filtered = byKey.get(fkey);
    if (!filtered) {
      filtered = filterOverCanvas(raw, layer.offset.x, layer.offset.y, filters, this.sources.width, this.sources.height);
      byKey.clear();
      byKey.set(fkey, filtered);
    }
    return { surface: filtered, dx: 0, dy: 0, perPixel: [] };
  }

  /** RGBA of a content layer over `r` (document space, inside one tile), or `null` when it has nothing there. */
  private contentTile(layer: ContentLayer, r: CropBox): Uint8ClampedArray | null {
    if (layer.type === 'annotation') {
      return this.sources.rasterizeAnnotation?.(layer.annotation, r) ?? null;
    }
    const { surface, dx, dy, perPixel } = this.layerPixels(layer);
    const src = { x: r.x - dx, y: r.y - dy, width: r.width, height: r.height };
    const covered = tilesInRect(src).map((t) => surface.getTile(t.tx, t.ty));
    if (surface.defaultValue === 0 && covered.every((t) => !t)) return null;
    const aligned = r.width === TILE && r.height === TILE && src.x % TILE === 0 && src.y % TILE === 0;
    if (!perPixel.length) {
      if (aligned && covered[0]) return covered[0].data;
      return readRegion(surface, src);
    }
    // Per-pixel filters: cache the filtered tile by its source tile and the filter settings.
    const fkey = `${dx},${dy}:${JSON.stringify(perPixel)}`;
    const anchor = (covered.find(Boolean) ?? surface) as object;
    let byKey = this.contentCache.get(anchor);
    const refsKey = `${r.x},${r.y}:${fkey}`;
    if (aligned) {
      const hit = byKey?.get(refsKey);
      if (hit) return hit;
    }
    const data = readRegion(surface, src);
    applyPixelFilters(data, perPixel);
    if (aligned) {
      if (!byKey) {
        byKey = new Map();
        this.contentCache.set(anchor, byKey);
      }
      byKey.set(refsKey, data);
    }
    return data;
  }

  // --- Masks -------------------------------------------------------------------

  private planeKey(mask: RasterMask, ox: number, oy: number): string {
    const W = this.sources.width;
    const H = this.sources.height;
    let id = this.planeIds.get(mask.surface);
    if (id === undefined) {
      id = this.nextPlaneId++;
      this.planeIds.set(mask.surface, id);
    }
    return `${id}:${ox},${oy}:${W}x${H}:${mask.feather ?? 0}:${mask.density ?? 1}:${mask.source ? JSON.stringify(mask.source) : ''}`;
  }

  /** Canvas-sized coverage of a feathered or parametric mask (cached). */
  private planeFor(mask: RasterMask, ox: number, oy: number): CoveragePlane {
    const key = this.planeKey(mask, ox, oy);
    let plane = this.planeCache.get(key);
    if (plane) {
      this.planeCache.delete(key);
      this.planeCache.set(key, plane);
      return plane;
    }
    const W = this.sources.width;
    const H = this.sources.height;
    let v: Float32Array = new Float32Array(W * H);
    if (mask.source) {
      const depth = this.sources.depthMap?.(mask.source) ?? null;
      if (!depth || depth.width !== W || depth.height !== H) v.fill(1);
      else for (let i = 0; i < v.length; i++) v[i] = depthMaskAlpha(depth.data[i * 4], mask.source) / 255;
    } else {
      const bytes = readRegion(mask.surface, { x: -ox, y: -oy, width: W, height: H });
      for (let i = 0; i < v.length; i++) v[i] = bytes[i] / 255;
    }
    const feather = mask.feather ?? 0;
    if (feather > 0) v = gaussianBlur(v, W, H, feather, 'clamp') as Float32Array;
    const density = mask.density ?? 1;
    if (density !== 1) for (let i = 0; i < v.length; i++) v[i] = 1 - density * (1 - v[i]);
    plane = { data: v, width: W, height: H };
    this.planeCache.set(key, plane);
    while (this.planeCache.size > 8) this.planeCache.delete(this.planeCache.keys().next().value as string);
    return plane;
  }

  /**
   * Per-pixel coverage (0..1) of a layer's mask over `r`, or `null` when the mask is missing,
   * disabled or reveals all of `r`.
   */
  private maskTile(layer: ImageLayer, r: CropBox): Float32Array | null {
    const mask = layer.mask;
    if (!mask || mask.enabled === false) return null;
    const ox = layer.type === 'pixel' ? layer.offset.x : 0;
    const oy = layer.type === 'pixel' ? layer.offset.y : 0;
    const n = r.width * r.height;
    const out = new Float32Array(n);
    const density = mask.density ?? 1;
    if (mask.source || (mask.feather ?? 0) > 0) {
      const plane = this.planeFor(mask, ox, oy);
      const W = plane.width;
      const H = plane.height;
      // Outside the canvas the mask holds its default (feathering clamps at the canvas edge).
      const outside = mask.source ? 1 : 1 - density * (1 - mask.defaultValue / 255);
      out.fill(outside);
      const x0 = Math.max(0, r.x);
      const y0 = Math.max(0, r.y);
      const x1 = Math.min(W, r.x + r.width);
      const y1 = Math.min(H, r.y + r.height);
      for (let y = y0; y < y1; y++) {
        const s = y * W;
        const d = (y - r.y) * r.width - r.x;
        for (let x = x0; x < x1; x++) out[d + x] = plane.data[s + x];
      }
    } else {
      const bytes = readRegion(mask.surface, { x: r.x - ox, y: r.y - oy, width: r.width, height: r.height });
      let all = true;
      for (let i = 0; i < n; i++) {
        out[i] = bytes[i] / 255;
        if (bytes[i] !== 255) all = false;
      }
      if (all) return null;
      if (density !== 1) for (let i = 0; i < n; i++) out[i] = 1 - density * (1 - out[i]);
    }
    return out;
  }

  // --- Running steps ---------------------------------------------------------

  /** Runs one step onto `acc`; returns whether `acc` is still empty. */
  private runStep(step: Step, acc: Uint8ClampedArray, empty: boolean, r: CropBox): boolean {
    if (step.kind === 'adjust') {
      if (empty) return true;
      this.applyAdjustRun(step.layers, acc, r);
      return false;
    }
    const layer = step.layer;
    if (!layer.visible) return empty;
    const clipped = step.clipped.filter((l) => l.visible);
    const coverage = this.maskTile(layer, r);
    if (coverage && coverage.every((v) => v <= 0)) return empty;
    if (step.kind === 'group') {
      if (layer.blend === 'pass-through' && !clipped.length) {
        if (layer.opacity >= 1 && !coverage) return this.runSteps(step.steps, acc, empty, r);
        const before = new Uint8ClampedArray(acc);
        const stillEmpty = this.runSteps(step.steps, acc, empty, r);
        lerpTile(acc, before, layer.opacity, coverage);
        return empty && stillEmpty;
      }
      const buf = new Uint8ClampedArray(acc.length);
      if (this.runSteps(step.steps, buf, true, r)) return empty;
      this.applyClipped(clipped, buf, r);
      const mode = (layer.blend === 'pass-through' ? 'normal' : layer.blend) as BlendMode;
      return this.blendOnto(acc, buf, empty, mode, layer.opacity, coverage);
    }
    const content = this.contentTile(step.layer, r);
    if (!content) return empty;
    const fill = step.layer.type === 'pixel' ? step.layer.fillOpacity ?? 1 : 1;
    const blend = this.contentBlend(step.layer);
    if (!clipped.length) return this.blendOnto(acc, content, empty, blend, layer.opacity * fill, coverage);
    // Clipping group: the base (with its mask and fill) is the shape the clipped layers paint in.
    const buf = new Uint8ClampedArray(acc.length);
    blendTile(buf, content, 'normal', fill, coverage);
    this.applyClipped(clipped, buf, r);
    return this.blendOnto(acc, buf, empty, blend, layer.opacity, null);
  }

  private runSteps(steps: Step[], acc: Uint8ClampedArray, empty: boolean, r: CropBox): boolean {
    for (const s of steps) empty = this.runStep(s, acc, empty, r);
    return empty;
  }

  /** Annotation layers draw with their annotation's blend mode unless the layer sets one. */
  private contentBlend(layer: ContentLayer): BlendMode {
    if (layer.type === 'annotation' && layer.blend === 'normal' && layer.annotation.blend) return layer.annotation.blend;
    return layer.blend;
  }

  private blendOnto(
    acc: Uint8ClampedArray,
    src: Uint8ClampedArray,
    empty: boolean,
    mode: BlendMode,
    alpha: number,
    coverage: Float32Array | null
  ): boolean {
    if (!(alpha > 0)) return empty;
    if (empty && mode === 'normal' && alpha >= 1 && !coverage) {
      // Over a transparent accumulator a normal, opaque, unmasked layer is a plain copy (which also
      // keeps the colour of transparent pixels, as a single-layer render always has).
      acc.set(src);
      return false;
    }
    blendTile(acc, src, mode, alpha, coverage);
    return false;
  }

  private applyClipped(clipped: ImageLayer[], buf: Uint8ClampedArray, r: CropBox): void {
    let run: AdjustmentLayerNode[] = [];
    const flush = () => {
      if (run.length) this.applyAdjustRun(run, buf, r);
      run = [];
    };
    for (const c of clipped) {
      if (c.type === 'adjustment') {
        run.push(c);
        continue;
      }
      flush();
      const coverage = this.maskTile(c, r);
      if (c.type === 'group') {
        const inner = new Uint8ClampedArray(buf.length);
        if (this.runSteps(buildSteps(c.children), inner, true, r)) continue;
        const mode = (c.blend === 'pass-through' ? 'normal' : c.blend) as BlendMode;
        blendAtop(buf, inner, mode, c.opacity, coverage);
        continue;
      }
      const content = this.contentTile(c, r);
      if (!content) continue;
      const fill = c.type === 'pixel' ? c.fillOpacity ?? 1 : 1;
      blendAtop(buf, content, this.contentBlend(c), c.opacity * fill, coverage);
    }
    flush();
  }

  private applyAdjustRun(layers: AdjustmentLayerNode[], acc: Uint8ClampedArray, r: CropBox): void {
    const views: AdjustmentLayer[] = [];
    let masks: Map<string, Float32Array> | undefined;
    for (const node of layers) {
      if (!node.visible) continue;
      const cov = this.maskTile(node, r);
      if (cov) {
        if (cov.every((v) => v <= 0)) continue;
        (masks ??= new Map()).set(node.id, cov);
      }
      views.push(adjustmentNodeAsLayer(node));
    }
    if (views.length) applyAdjustmentLayers({ data: acc }, views, masks);
  }
}

/**
 * Applies a layer's filters (in order) over the canvas rect in document space: the result is a
 * surface at offset 0 holding only canvas pixels (spatial filters clamp at the canvas edges).
 */
function filterOverCanvas(
  surface: PixelSurface,
  ox: number,
  oy: number,
  filters: readonly LayerFilter[],
  width: number,
  height: number
): PixelSurface {
  if (width <= 0 || height <= 0) return emptySurface(4);
  const data = readRegion(surface, { x: -ox, y: -oy, width, height });
  const img = { width, height, data };
  for (const f of filters) {
    if (f.kind === 'develop') applyPixelFilters(data, [f]);
    else if (f.kind === 'blur') applyBoxBlur(img, Math.min(Math.round(f.radius), 40));
  }
  return surfaceFromPixels(img, 4, 0, 0);
}

/** Tiles of `surface` that differ between two surfaces (by tile identity), as tile keys. */
export function changedTiles(a: TiledSurface, b: TiledSurface): TileKey[] {
  const out: TileKey[] = [];
  for (const [k, t] of b.tiles) if (a.tiles.get(k) !== t) out.push(k);
  for (const k of a.tiles.keys()) if (!b.tiles.has(k)) out.push(k);
  return out;
}
