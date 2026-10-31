/**
 * The per-tile layer compositor engine. Composites a layer stack (pixel layers and groups with
 * masks, clipping, blend modes, opacity, fill and pass-through) tile by tile in document space,
 * in pure TypeScript, so results are deterministic and testable in Node and Workers.
 *
 * Editors add their own layer kinds through a {@link CompositorProfile}: layers that filter
 * what is below them (adjustment layers), content layers drawn by the editor (annotations),
 * per-layer pixel filters, and parametric mask sources.
 *
 * Caches:
 * - Each top-level *step* (a content layer and the layers clipped to it, a run of filter layers,
 *   a group) has a per-tile *signature*: its properties plus the identity of every surface tile
 *   it reads. A tile whose signatures are unchanged returns the cached result (same buffer
 *   object, so callers can skip uploading it).
 * - A prefix cache keeps the accumulator *before* the step that changed last time (and, when the
 *   caller names it, before the active layer). Dragging a slider on layer k, or a stroke on layer
 *   k, recomposites from step k upwards only; `dirty` rectangles limit that to where it changed.
 * - Spatial filters and feathered or parametric masks are computed once over the canvas and
 *   cached by the identity of their inputs.
 * - Layer effects: a layer's effect maps (shadow, glow, bevel, stroke distance fields) are built
 *   once over the layer's region (its bounds grown by the effects' margin, within the canvas grown
 *   the same) and cached by the identity of every surface tile the shape reads; tiles crop them.
 *   When only some of those tiles changed and every effect is local, the maps are rebuilt only
 *   within the margin of the change (narrowed by `dirty` when it covers the change) and patched in.
 *   A tile's signature then reads the layer within the margin around it (or the whole region when
 *   an effect is laid out over the layer's bounds), and `dirty` rectangles grow by the margin.
 */

import { blendChannel, blendRgb, isSeparableBlendMode, mixPigment8, type BlendMode } from './blend';
import { gaussianBlur } from './blur';
import { readDeepRegion, surfaceDepth } from './deep';
import { DEFAULT_GLOBAL_LIGHT, effectReach, effectsFingerprint, effectsMargin, hasActiveEffects, MAX_EFFECT_REACH, type GlobalLight, type LayerEffects } from './effects/model';
import { builtinPattern, PatternTile, type EffectPattern } from './effects/patterns';
import { activeEffectItems, buildEffectMaps, compositeLayerEffects, effectsAreLocal, patchEffectMaps, type EffectCompositeInput, type EffectContext, type EffectMaps } from './effects/render';
import type { RasterMask, RasterNode, LayerEdgeColor } from './layers';
import {
  TILE,
  emptySurface,
  readRegion,
  surfaceFromPixels,
  tileKey,
  tilesInRect,
  type PixelSurface,
  type RasterRect,
  type TileKey,
  type TiledSurface,
} from './surface';

const TILE_PIXELS = TILE * TILE;
const TILE_BYTES = TILE_PIXELS * 4;

/** What the compositor needs from its host besides the layers. */
export interface RasterSources {
  /** Canvas (document) size: spatial filters and mask feathering clamp at this rect. */
  width: number;
  height: number;
  /** The pixels of a pixel layer (lets a host resolve layers whose pixels live elsewhere). */
  surfaceOf?(layer: CompositorLayer): PixelSurface;
  /** Changes whenever one of the host's callbacks would return something new for the same layers. */
  version?: number | string;
  /** The document's global light for effects that use it (default angle 120°, altitude 30°). */
  globalLight?: GlobalLight;
  /** A document pattern by id for pattern effects (built-in patterns are found without it). */
  pattern?(id: string): EffectPattern | null;
}

/** The fields the engine reads; editor layer types are wider. */
export interface CompositorLayer extends RasterNode {
  visible: boolean;
  opacity: number;
  blend: string;
  clipped?: boolean;
  mask?: RasterMask;
  /** Pixel layers. */
  surface?: PixelSurface;
  offset?: { x: number; y: number };
  fillOpacity?: number;
  /** Layer effects. */
  effects?: LayerEffects;
  /** Edge colour; the engine applies `ambient` (the profile's pixel filters handle the rest). */
  edge?: LayerEdgeColor;
  /** Groups. */
  children?: readonly CompositorLayer[];
}

/**
 * Live edge cast (`LayerEdgeColor.ambient`): pulls straight RGBA `content` toward `below` (the
 * composite behind it, same size) or a fixed colour, by `amount × (1 − α)` where α is the content's
 * alpha times `coverage` (its mask). Opaque and invisible pixels are unchanged. `max` is 255 for
 * bytes or 1 for float samples; `color` is in the same units.
 */
export function applyEdgeAmbient(
  content: Uint8ClampedArray | Float32Array,
  below: ArrayLike<number>,
  coverage: ArrayLike<number> | null,
  amount: number,
  color: readonly [number, number, number] | null,
  max: number
): void {
  const k = Math.min(1, Math.max(0, amount));
  if (!(k > 0)) return;
  const n = content.length / 4;
  for (let i = 0; i < n; i++) {
    const a = (content[i * 4 + 3] / max) * (coverage ? coverage[i] : 1);
    if (a <= 0 || a >= 1) continue;
    let r: number;
    let g: number;
    let b: number;
    if (color) [r, g, b] = color;
    else {
      if (!(below[i * 4 + 3] > 0)) continue;
      r = below[i * 4];
      g = below[i * 4 + 1];
      b = below[i * 4 + 2];
    }
    const t = k * (1 - a);
    content[i * 4] += t * (r - content[i * 4]);
    content[i * 4 + 1] += t * (g - content[i * 4 + 1]);
    content[i * 4 + 2] += t * (b - content[i * 4 + 2]);
  }
}

/** A pixel layer's filters as the engine runs them. */
export interface PixelFilterSpec {
  /** Identifies the settings (part of the cache key). */
  key: string;
  /** Needs neighbouring pixels: runs once over the canvas instead of per tile. */
  spatial: boolean;
  /** Filters RGBA `data` (`width × height`) in place. */
  apply(data: Uint8ClampedArray, width: number, height: number): void;
}

/** How an editor's own layer kinds composite. Every hook is optional. */
export interface CompositorProfile<L extends CompositorLayer, S extends RasterSources> {
  /** Layers that change what is below them; adjacent ones run as one step. */
  isFilterLayer?(layer: L): boolean;
  /** Applies a run of visible filter layers to `acc` (RGBA over `r`); `coverage` holds masked ones by id. */
  applyFilterRun?(layers: L[], acc: Uint8ClampedArray, r: RasterRect, coverage: Map<string, Float32Array> | undefined, sources: S): void;
  /** RGBA of a content layer that is neither a pixel layer nor a group, over `r`, or `null`. */
  contentTile?(layer: L, r: RasterRect, sources: S): Uint8ClampedArray | null;
  /** The blend mode a content layer draws with (default `layer.blend`). */
  contentBlend?(layer: L): BlendMode;
  /** Properties of a layer beyond the generic ones that change its pixels (part of its signature). */
  layerKey?(layer: L): unknown;
  /** Active filters of a pixel layer, or `null`. */
  pixelFilters?(layer: L): PixelFilterSpec | null;
  /** Canvas coverage (0..1, `width × height`) of a parametric mask source, or `null` to reveal all. */
  maskSourcePlane?(source: unknown, width: number, height: number, sources: S): Float32Array | null;
  /**
   * Layer kinds besides `pixel` that composite exactly like pixel layers, from their `surface`,
   * `offset` and `fillOpacity` (a smart object's rendered pixels). Their tile signatures, effect
   * regions and `dirty` handling are a pixel layer's.
   */
  isPixelLike?(layer: L): boolean;
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
   * Changed tiles are then recomposited only inside these rectangles (grown by the effects' reach),
   * tiles they miss keep their pixels, and effect maps are rebuilt only around them. Changes outside
   * them would be missed, so pass nothing when unsure.
   */
  dirty?: RasterRect[];
}

// ---------------------------------------------------------------------------
// Steps and signatures
// ---------------------------------------------------------------------------

type Step<L> =
  | { kind: 'content'; layer: L; clipped: L[] }
  | { kind: 'adjust'; layers: L[] }
  | { kind: 'group'; layer: L; clipped: L[]; steps: Step<L>[] };

interface Sig {
  key: string;
  refs: unknown[];
}

function sameSig(a: Sig | undefined, b: Sig): boolean {
  if (!a || a.key !== b.key || a.refs.length !== b.refs.length) return false;
  for (let i = 0; i < a.refs.length; i++) if (a.refs[i] !== b.refs[i]) return false;
  return true;
}

/** The bounding box of the parts of `rects` inside tile (tx, ty), or `null` when none is. */
function dirtyInTile(rects: RasterRect[], tx: number, ty: number): RasterRect | null {
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

// ---------------------------------------------------------------------------
// Blending
// ---------------------------------------------------------------------------

/**
 * Blends straight-alpha `src` over `dst` (both RGBA) in place with `mode`, scaling the source
 * alpha by `alpha` and, per pixel, by `coverage`. Same maths as `blendPixel` (including the
 * `pigment` paint mix, which caches each 8-bit colour's spectrum).
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
  const pigment = mode === 'pigment';
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
    if (pigment) {
      // Not B(Cb, Cs): the colours mix like paint by amount, `as / ao` of the source.
      mixPigment8(d0, d1, d2, src[i], src[i + 1], src[i + 2], as / ao, cb);
      dst[i] = Math.round(cb[0] * 255);
      dst[i + 1] = Math.round(cb[1] * 255);
      dst[i + 2] = Math.round(cb[2] * 255);
      dst[i + 3] = Math.round(ao * 255);
      continue;
    }
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

/** A layer's cached effect maps: built for `key` over `region` from the shape tiles `tiles`. */
interface EffectEntry {
  key: string;
  region: RasterRect;
  tiles: Map<TileKey, Sig>;
  maps: EffectMaps;
  /** The call that last validated it. */
  stamp: number;
}

interface TileEntry<L> {
  sigs: Sig[];
  /** Accumulator before step `index` (index 0 is the empty accumulator and is never stored). */
  checkpoints: Map<number, { data: Uint8ClampedArray; empty: boolean }>;
  result: Uint8ClampedArray;
  /** The root list the entry was computed for (sigs are only comparable per root). */
  root: readonly L[];
  stamp: number;
}

interface CoveragePlane {
  /** Coverage over the canvas (`width × height`). */
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
  /** Layers whose effect maps were built over their whole region. */
  effectsBuilt: number;
  /** Layers whose effect maps were rebuilt only around a change and patched in. */
  effectsPatched: number;
}

const isGroup = (l: CompositorLayer) => l.type === 'group';


/** A mask surface's depth, cached per surface (surfaces are immutable). */
const maskDepths = new WeakMap<TiledSurface, number>();
function maskDepth(surface: TiledSurface): number {
  let d = maskDepths.get(surface);
  if (d === undefined) maskDepths.set(surface, (d = surfaceDepth(surface)));
  return d;
}

export class RasterCompositor<L extends CompositorLayer = CompositorLayer, S extends RasterSources = RasterSources> {
  private readonly tiles = new Map<TileKey, TileEntry<L>>();
  private readonly maxCacheBytes: number;
  private cacheBytes = 0;
  private stamp = 0;
  private sources: S = { width: 1, height: 1 } as S;
  private sourcesVersion: unknown = undefined;
  private filteredCache = new WeakMap<object, Map<string, PixelSurface>>();
  private planeCache = new Map<string, CoveragePlane>();
  private planeIds = new WeakMap<object, number>();
  private nextPlaneId = 1;
  private contentCache = new WeakMap<object, Map<string, Uint8ClampedArray>>();
  private readonly stepsCache = new WeakMap<readonly L[], Step<L>[]>();
  private readonly propsKeyCache = new WeakMap<object, string>();
  /** Effect maps by layer id (see the module comment), least recently used first. */
  private effectCache = new Map<string, EffectEntry>();
  /** Effect maps already validated in this call, by layer object. */
  private effectMemo = new WeakMap<object, { stamp: number; maps: EffectMaps }>();
  private readonly patternTiles = new WeakMap<EffectPattern, PatternTile>();
  private readonly reachCache = new WeakMap<readonly L[], number>();
  private fxContext: EffectContext | null = null;
  lastStats: CompositeStats = { tiles: 0, cached: 0, stepsRun: 0, effectsBuilt: 0, effectsPatched: 0 };
  private hint = -1;
  /** The `dirty` rectangles of the current call, as passed. */
  private callDirty: RasterRect[] | null = null;
  private callStats: CompositeStats = this.lastStats;

  constructor(
    private readonly profile: CompositorProfile<L, S> = {},
    options: CompositorOptions = {}
  ) {
    this.maxCacheBytes = options.maxCacheBytes ?? 256 * 1024 * 1024;
  }

  /** Drops every cached tile and plane. */
  clear(): void {
    this.tiles.clear();
    this.cacheBytes = 0;
    this.planeCache.clear();
    this.filteredCache = new WeakMap();
    this.contentCache = new WeakMap();
    this.effectCache.clear();
    this.effectMemo = new WeakMap();
  }

  private setSources(sources: S): void {
    const version = `${sources.width}x${sources.height}:${sources.version ?? ''}`;
    if (version !== this.sourcesVersion) {
      this.clear();
      this.sourcesVersion = version;
    }
    this.sources = sources;
    this.fxContext = null;
  }

  /** The composite of `layers` over `rect` as `rect.width × rect.height` RGBA (straight alpha). */
  composite(layers: readonly L[], rect: RasterRect, sources: S, options: CompositeCallOptions = {}): Uint8ClampedArray {
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
    layers: readonly L[],
    rect: RasterRect,
    sources: S,
    onTile: (tx: number, ty: number, data: Uint8ClampedArray, changed: boolean) => void,
    options: CompositeCallOptions = {}
  ): void {
    this.setSources(sources);
    const steps = this.buildSteps(layers);
    this.hint = options.checkpointLayerId ? this.stepIndexOf(steps, options.checkpointLayerId) : -1;
    this.stamp++;
    this.callDirty = options.dirty ?? null;
    const stats: CompositeStats = { tiles: 0, cached: 0, stepsRun: 0, effectsBuilt: 0, effectsPatched: 0 };
    this.callStats = stats;
    // A change reaches as far as the effects of any layer reach.
    const grow = options.dirty ? this.effectsReach(layers) : 0;
    const dirty = grow > 0 ? options.dirty!.map((d) => inflateRect(d, grow)) : options.dirty;
    for (const { tx, ty } of tilesInRect(rect)) {
      stats.tiles++;
      const before = this.tiles.get(tileKey(tx, ty))?.result;
      const data = this.compositeTile(layers, steps, tx, ty, stats, dirty ? dirtyInTile(dirty, tx, ty) : null);
      onTile(tx, ty, data, data !== before);
    }
    this.lastStats = stats;
    this.evict();
  }

  /** The composite of one tile (cached; do not mutate the result). */
  tile(layers: readonly L[], tx: number, ty: number, sources: S): Uint8ClampedArray {
    this.setSources(sources);
    this.stamp++;
    const stats: CompositeStats = { tiles: 1, cached: 0, stepsRun: 0, effectsBuilt: 0, effectsPatched: 0 };
    this.callStats = stats;
    this.hint = -1;
    this.callDirty = null;
    const data = this.compositeTile(layers, this.buildSteps(layers), tx, ty, stats);
    this.lastStats = stats;
    this.evict();
    return data;
  }

  /**
   * A layer's effective mask coverage (0..1, after density, feather or parametric evaluation)
   * over `r` in document space, or `null` when it reveals all of `r`.
   */
  maskCoverage(layer: L, r: RasterRect, sources: S): Float32Array | null {
    this.setSources(sources);
    return this.maskTile(layer, r);
  }

  /**
   * For the float compositor: everything `compositeLayerEffects` needs for `layer` over `r` but
   * the pixels (the area its effects reach inside `r`, the effect maps built from its 8-bit
   * shape, blend, opacities, canvas and context), or `null` when nothing reaches `r`.
   */
  effectsInput(layer: L, r: RasterRect, sources: S): Omit<EffectCompositeInput, 'backdrop' | 'content'> | null {
    this.setSources(sources);
    const maps = this.effectMapsOf(layer);
    const rect = this.effectArea(layer, maps, r);
    if (!rect) return null;
    return {
      rect,
      maps,
      blend: (isGroup(layer) ? (layer.blend === 'pass-through' ? 'normal' : layer.blend) : this.contentBlend(layer)) as BlendMode,
      opacity: layer.opacity,
      fillOpacity: this.isPixel(layer) ? (layer.fillOpacity ?? 1) : 1,
      canvas: { x: 0, y: 0, width: this.sources.width, height: this.sources.height },
      ctx: this.effectContext(),
    };
  }

  // --- Steps -------------------------------------------------------------------

  /** Pixel layers, and the layer kinds the profile composites like them. */
  private isPixel(l: CompositorLayer): boolean {
    return l.type === 'pixel' || (this.profile.isPixelLike?.(l as L) ?? false);
  }

  private isFilter(l: L): boolean {
    return this.profile.isFilterLayer?.(l) ?? false;
  }

  /**
   * Groups a layer list into compositing steps: clipped layers join the nearest unclipped
   * content or group layer below; consecutive unclipped filter layers form one run.
   */
  private buildSteps(layers: readonly L[]): Step<L>[] {
    const cached = this.stepsCache.get(layers);
    if (cached) return cached;
    const steps: Step<L>[] = [];
    for (const layer of layers) {
      const last = steps[steps.length - 1];
      if (layer.clipped && last && (last.kind === 'content' || last.kind === 'group')) {
        last.clipped.push(layer);
        continue;
      }
      if (this.isFilter(layer)) {
        if (last && last.kind === 'adjust') last.layers.push(layer);
        else steps.push({ kind: 'adjust', layers: [layer] });
      } else if (isGroup(layer)) {
        steps.push({ kind: 'group', layer, clipped: [], steps: this.buildSteps((layer.children ?? []) as L[]) });
      } else {
        steps.push({ kind: 'content', layer, clipped: [] });
      }
    }
    this.stepsCache.set(layers, steps);
    return steps;
  }

  /** The index of the top-level step that holds layer `id` (searching groups and clipped layers), or -1. */
  private stepIndexOf(steps: Step<L>[], id: string): number {
    const holds = (l: CompositorLayer): boolean => l.id === id || (isGroup(l) && (l.children ?? []).some(holds));
    return steps.findIndex((s) => (s.kind === 'adjust' ? s.layers.some(holds) : holds(s.layer) || s.clipped.some(holds)));
  }

  /** Properties of a layer that change pixels, minus its surfaces (memoised per object). */
  private propsKey(layer: L): string {
    let key = this.propsKeyCache.get(layer);
    if (key !== undefined) return key;
    const mask = layer.mask
      ? [layer.mask.enabled !== false, layer.mask.density ?? 1, layer.mask.feather ?? 0, layer.mask.defaultValue, layer.mask.source ?? null]
      : null;
    const base: unknown[] = [layer.type, layer.id, layer.visible, layer.opacity, layer.blend, Boolean(layer.clipped), mask];
    if (this.isPixel(layer)) base.push(layer.offset?.x ?? 0, layer.offset?.y ?? 0, layer.fillOpacity ?? 1);
    if (this.hasEffects(layer)) base.push(effectsFingerprint(layer.effects));
    if (layer.edge) base.push(layer.edge);
    const extra = this.profile.layerKey?.(layer);
    if (extra !== undefined) base.push(extra);
    key = JSON.stringify(base);
    this.propsKeyCache.set(layer, key);
    return key;
  }

  private compositeTile(root: readonly L[], steps: Step<L>[], tx: number, ty: number, stats: CompositeStats, dirty: RasterRect | null = null): Uint8ClampedArray {
    const key = tileKey(tx, ty);
    const entry = this.tiles.get(key);
    const sigs = steps.map((s) => this.stepSig(s, tx, ty));
    let first = 0;
    if (entry) {
      while (first < sigs.length && first < entry.sigs.length && sameSig(entry.sigs[first], sigs[first])) first++;
      if ((first === sigs.length && first === entry.sigs.length) || this.changedOnlyNearby(steps, sigs, entry, dirty)) {
        entry.sigs = sigs;
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
    const next: TileEntry<L> = { sigs, checkpoints, result, root, stamp: this.stamp };
    this.tiles.set(key, next);
    this.cacheBytes += this.entryBytes(next) - prevBytes;
    return result;
  }

  /**
   * Whether a tile with no part in this call's (grown) `dirty` rectangles changed only in what local
   * effects read beyond it: every changed step is a pixel layer with local effects whose changes stay
   * inside `dirty` (and so are farther than its margin), which leaves the tile's pixels as they were.
   */
  private changedOnlyNearby(steps: Step<L>[], sigs: Sig[], entry: TileEntry<L>, dirty: RasterRect | null): boolean {
    if (this.callDirty === null || dirty || entry.stamp !== this.stamp - 1 || sigs.length !== entry.sigs.length) return false;
    return steps.every((step, i) => {
      if (sameSig(entry.sigs[i], sigs[i])) return true;
      if (step.kind !== 'content' || entry.sigs[i].key !== sigs[i].key) return false;
      const { layer, clipped } = step;
      return this.hasEffects(layer) && effectsAreLocal(activeEffectItems(layer.effects)) && this.dirtyCoversShape(layer) && clipped.every((c) => this.dirtyCoversShape(c));
    });
  }

  private entryBytes(e: TileEntry<L>): number {
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

  private stepSig(step: Step<L>, tx: number, ty: number): Sig {
    if (step.kind === 'adjust') {
      const refs: unknown[] = [];
      let key = 'A';
      for (const l of step.layers) {
        key += this.propsKey(l);
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

  private layerSig(layer: L, tx: number, ty: number): Sig {
    if (this.isFilter(layer)) return { key: this.propsKey(layer), refs: this.maskRefs(layer, tx, ty, 0, 0) };
    if (isGroup(layer)) return this.groupSig(layer, this.buildSteps((layer.children ?? []) as L[]), tx, ty);
    return this.contentSig(layer, tx, ty);
  }

  private groupSig(group: L, steps: Step<L>[], tx: number, ty: number): Sig {
    if (group.visible && this.hasEffects(group)) return this.effectSig(group, tx, ty);
    return this.plainGroupSig(group, steps, tx, ty);
  }

  private plainGroupSig(group: L, steps: Step<L>[], tx: number, ty: number): Sig {
    let key = 'G' + this.propsKey(group);
    const refs = this.maskRefs(group, tx, ty, 0, 0);
    if (!group.visible) return { key, refs };
    for (const s of steps) {
      const sig = this.stepSig(s, tx, ty);
      key += '[' + sig.key + ']';
      refs.push(...sig.refs);
    }
    return { key, refs };
  }

  private contentSig(layer: L, tx: number, ty: number): Sig {
    if (layer.visible && this.hasEffects(layer)) return this.effectSig(layer, tx, ty);
    return this.plainContentSig(layer, tx, ty);
  }

  private plainContentSig(layer: L, tx: number, ty: number): Sig {
    const key = 'C' + this.propsKey(layer);
    if (!layer.visible) return { key, refs: [] };
    if (!this.isPixel(layer)) return { key, refs: this.maskRefs(layer, tx, ty, 0, 0) };
    const { surface, dx, dy } = this.layerPixels(layer);
    const refs: unknown[] = [surface.defaultValue];
    const r = { x: tx * TILE - dx, y: ty * TILE - dy, width: TILE, height: TILE };
    for (const t of tilesInRect(r)) refs.push(surface.getTile(t.tx, t.ty) ?? null);
    refs.push(...this.maskRefs(layer, tx, ty, layer.offset?.x ?? 0, layer.offset?.y ?? 0));
    return { key, refs };
  }

  // --- Layer effects ------------------------------------------------------------

  private hasEffects(layer: L): boolean {
    return hasActiveEffects(layer.effects) && !this.isFilter(layer);
  }

  /** The largest effects margin of any visible layer in the stack (memoised per root). */
  private effectsReach(layers: readonly L[]): number {
    let m = this.reachCache.get(layers);
    if (m !== undefined) return m;
    m = 0;
    const walk = (list: readonly CompositorLayer[]) => {
      for (const l of list) {
        if (!l.visible) continue;
        if (this.hasEffects(l as L)) m = Math.max(m!, effectsMargin(l.effects));
        if (l.children) walk(l.children);
      }
    };
    walk(layers);
    this.reachCache.set(layers, m);
    return m;
  }

  private effectContext(): EffectContext {
    if (this.fxContext) return this.fxContext;
    const sources = this.sources;
    const tiles = this.patternTiles;
    this.fxContext = {
      light: sources.globalLight ?? DEFAULT_GLOBAL_LIGHT,
      pattern: (id) => {
        const p = sources.pattern?.(id) ?? builtinPattern(id);
        if (!p || !(p.width > 0 && p.height > 0) || p.data.length < p.width * p.height * 4) return null;
        let t = tiles.get(p);
        if (!t) {
          t = new PatternTile(p);
          tiles.set(p, t);
        }
        return t;
      },
    };
    return this.fxContext;
  }

  /**
   * Where a layer's effect maps are built: its bounds (pixel layers; the canvas otherwise) grown by
   * the effects' margin, within the canvas grown the same.
   */
  private effectRegion(layer: L): RasterRect {
    const m = effectsMargin(layer.effects);
    const canvas = { x: -m, y: -m, width: this.sources.width + 2 * m, height: this.sources.height + 2 * m };
    if (!this.isPixel(layer)) return canvas;
    const { surface, dx, dy } = this.layerPixels(layer);
    if (surface.defaultValue !== 0) return canvas;
    const b = surface.bounds;
    if (!b) return { x: 0, y: 0, width: 0, height: 0 };
    return intersectRect({ x: b.x + dx - m, y: b.y + dy - m, width: b.width + 2 * m, height: b.height + 2 * m }, canvas);
  }

  /** The signature of a layer's shape (its surface tiles and mask refs) per tile of `region`. */
  private shapeSigs(layer: L, region: RasterRect): Map<TileKey, Sig> {
    const sigs = new Map<TileKey, Sig>();
    if (region.width <= 0 || region.height <= 0) return sigs;
    const steps = isGroup(layer) ? this.buildSteps((layer.children ?? []) as L[]) : null;
    for (const t of tilesInRect(region)) {
      sigs.set(tileKey(t.tx, t.ty), steps ? this.plainGroupSig(layer, steps, t.tx, t.ty) : this.plainContentSig(layer, t.tx, t.ty));
    }
    return sigs;
  }

  /** The surface tiles (and mask refs) a layer's shape reads over `region`. */
  private shapeRefs(layer: L, region: RasterRect): unknown[] {
    const refs: unknown[] = [];
    for (const sig of this.shapeSigs(layer, region).values()) for (const r of sig.refs) refs.push(r);
    return refs;
  }

  private lightKey(): string {
    const l = this.effectContext().light;
    return `${l.angle},${l.altitude}`;
  }

  /**
   * The signature of a layer with effects for tile (tx, ty): its properties and the tiles its shape
   * reads within the effects' margin around the tile, or over its whole region when an effect is
   * laid out over the layer's bounds.
   */
  private effectSig(layer: L, tx: number, ty: number): Sig {
    const key = (isGroup(layer) ? 'Gfx' : 'Cfx') + this.propsKey(layer) + this.lightKey();
    const region = this.effectRegion(layer);
    const m = effectsMargin(layer.effects);
    // Local maps over the tile do not depend on how far the region reaches (it is zero beyond the
    // shape); maps laid out over the layer's bounds do.
    if (effectsAreLocal(activeEffectItems(layer.effects))) {
      return { key, refs: this.shapeRefs(layer, intersectRect({ x: tx * TILE - m, y: ty * TILE - m, width: TILE + 2 * m, height: TILE + 2 * m }, region)) };
    }
    return { key, refs: [`${region.x},${region.y},${region.width},${region.height}`, ...this.shapeRefs(layer, region)] };
  }

  /** A layer's effect maps over its region (cached; see the module comment). */
  private effectMapsOf(layer: L): EffectMaps {
    const memo = this.effectMemo.get(layer);
    if (memo && memo.stamp === this.stamp) return memo.maps;
    const region = this.effectRegion(layer);
    const key = this.propsKey(layer) + this.lightKey();
    const tiles = this.shapeSigs(layer, region);
    const hit = this.effectCache.get(layer.id);
    this.effectCache.delete(layer.id);
    let entry: EffectEntry;
    if (hit && hit.key === key && sameRect(hit.region, region) && [...tiles].every(([k, sig]) => sameSig(hit.tiles.get(k), sig))) {
      entry = hit;
    } else {
      const items = activeEffectItems(layer.effects);
      const ctx = this.effectContext();
      let maps: EffectMaps | null = null;
      if (hit && hit.key === key && items.every((e) => effectReach(e) <= MAX_EFFECT_REACH)) {
        const changed = this.shapeChanges(layer, hit, tiles, region);
        maps = patchEffectMaps(hit.maps, items, region, changed, effectsMargin(layer.effects), (r) => this.layerShape(layer, r), ctx);
      }
      if (maps) this.callStats.effectsPatched++;
      else this.callStats.effectsBuilt++;
      entry = { key, region, tiles, maps: maps ?? buildEffectMaps(items, this.layerShape(layer, region), region, ctx), stamp: 0 };
    }
    entry.stamp = this.stamp;
    this.effectCache.set(layer.id, entry);
    if (entry !== hit) {
      let bytes = 0;
      for (const e of this.effectCache.values()) bytes += e.maps.bytes;
      while (this.effectCache.size > 1 && (this.effectCache.size > 32 || bytes > this.maxCacheBytes / 2)) {
        const [oldest, e] = this.effectCache.entries().next().value as [string, EffectEntry];
        bytes -= e.maps.bytes;
        this.effectCache.delete(oldest);
      }
    }
    this.effectMemo.set(layer, { stamp: this.stamp, maps: entry.maps });
    return entry.maps;
  }

  /**
   * Where a layer's shape may differ from the one `prev` was built from: the tiles whose signature
   * changed (a tile new to the region that reads nothing did not), narrowed to this call's `dirty`
   * rectangles when `prev` is from the previous call and they cover every change of the shape.
   */
  private shapeChanges(layer: L, prev: EffectEntry, tiles: Map<TileKey, Sig>, region: RasterRect): RasterRect[] {
    const out: RasterRect[] = [];
    for (const { tx, ty } of tilesInRect(region)) {
      const sig = tiles.get(tileKey(tx, ty))!;
      const old = prev.tiles.get(tileKey(tx, ty));
      if (old ? sameSig(old, sig) : sig.refs.every((r) => r === null || r === 0)) continue;
      const r = intersectRect({ x: tx * TILE, y: ty * TILE, width: TILE, height: TILE }, region);
      if (r.width > 0 && r.height > 0) out.push(r);
    }
    const dirty = this.callDirty;
    if (!dirty || prev.stamp !== this.stamp - 1 || !this.dirtyCoversShape(layer)) return out;
    const narrowed: RasterRect[] = [];
    for (const r of out) {
      for (const d of dirty) {
        const a = intersectRect(r, { x: Math.floor(d.x), y: Math.floor(d.y), width: Math.ceil(d.x + d.width) - Math.floor(d.x), height: Math.ceil(d.y + d.height) - Math.floor(d.y) });
        if (a.width > 0 && a.height > 0) narrowed.push(a);
      }
    }
    return narrowed;
  }

  /**
   * Whether a change to a layer stays inside the `dirty` rectangles that name it: a pixel layer
   * without filters or a feathered or parametric mask (those spread a change beyond it).
   */
  private dirtyCoversShape(layer: L): boolean {
    if (!this.isPixel(layer) || this.profile.pixelFilters?.(layer)) return false;
    const mask = layer.mask;
    return !mask || mask.enabled === false || (!mask.source && !((mask.feather ?? 0) > 0));
  }

  /** A layer's alpha over `r` after its mask (0..1, quantised to bytes as tiles see it). */
  private layerShape(layer: L, r: RasterRect): Float32Array {
    const n = r.width * r.height;
    const shape = new Float32Array(n);
    if (n <= 0) return shape;
    const rgba = this.ownPixels(layer, r);
    if (!rgba) return shape;
    for (let i = 0; i < n; i++) shape[i] = rgba[i * 4 + 3] / 255;
    return shape;
  }

  /** A content or group layer's own pixels over `r` with its mask applied to alpha, or `null` when empty. */
  private ownPixels(layer: L, r: RasterRect): Uint8ClampedArray | null {
    let rgba: Uint8ClampedArray | null;
    if (isGroup(layer)) {
      const buf = new Uint8ClampedArray(r.width * r.height * 4);
      rgba = this.runSteps(this.buildSteps((layer.children ?? []) as L[]), buf, true, r) ? null : buf;
    } else {
      const content = this.contentTile(layer, r);
      rgba = content ? new Uint8ClampedArray(content) : null;
    }
    if (!rgba) return null;
    const cov = this.maskTile(layer, r);
    if (cov) for (let i = 0, p = 3; i < cov.length; i++, p += 4) rgba[p] = Math.round(rgba[p] * cov[i]);
    return rgba;
  }

  /**
   * The part of `r` a layer with effects can change: its shape's bounds grown by the effects'
   * margin. Beyond it the layer and every effect are transparent, so the backdrop stays as it is.
   */
  private effectArea(layer: L, maps: EffectMaps, r: RasterRect): RasterRect | null {
    if (!maps.bounds) return null;
    const a = intersectRect(inflateRect(maps.bounds, effectsMargin(layer.effects)), r);
    return a.width > 0 && a.height > 0 ? a : null;
  }

  /**
   * Composites `layer`'s pixels (with `clipped` applied) and its effects onto `acc` (RGBA over `r`),
   * only where they can reach. `keepAlpha`: clipped layers keep the base's alpha.
   */
  private compositeEffects(layer: L, clipped: L[], acc: Uint8ClampedArray, r: RasterRect, keepAlpha: boolean): boolean {
    const maps = this.effectMapsOf(layer);
    const a = this.effectArea(layer, maps, r);
    if (!a) return false;
    const whole = a.width === r.width && a.height === r.height;
    const sub = whole ? acc : copyRect(acc, r, a);
    const content = this.ownPixels(layer, a) ?? new Uint8ClampedArray(a.width * a.height * 4);
    if (clipped.length) this.applyClipped(clipped, content, a);
    const keep = keepAlpha ? sub.filter((_, i) => (i & 3) === 3) : null;
    const blend = (isGroup(layer) ? (layer.blend === 'pass-through' ? 'normal' : layer.blend) : this.contentBlend(layer)) as BlendMode;
    compositeLayerEffects({
      backdrop: sub,
      content,
      rect: a,
      maps,
      blend,
      opacity: layer.opacity,
      fillOpacity: this.isPixel(layer) ? (layer.fillOpacity ?? 1) : 1,
      canvas: { x: 0, y: 0, width: this.sources.width, height: this.sources.height },
      ctx: this.effectContext(),
    });
    if (keep) for (let i = 0; i < keep.length; i++) sub[i * 4 + 3] = keep[i];
    if (!whole) pasteRect(acc, r, sub, a);
    return true;
  }

  /** Composites a layer with active effects onto `acc` over `r`; returns whether `acc` is still empty. */
  private runEffectStep(layer: L, clipped: L[], acc: Uint8ClampedArray, empty: boolean, r: RasterRect): boolean {
    return this.compositeEffects(layer, clipped, acc, r, false) ? false : empty;
  }

  private maskRefs(layer: L, tx: number, ty: number, ox: number, oy: number): unknown[] {
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
  private layerPixels(layer: L): { surface: PixelSurface; dx: number; dy: number; perPixel: PixelFilterSpec | null } {
    const raw = this.sources.surfaceOf ? this.sources.surfaceOf(layer) : (layer.surface as PixelSurface);
    const ox = layer.offset?.x ?? 0;
    const oy = layer.offset?.y ?? 0;
    const filters = this.profile.pixelFilters?.(layer) ?? null;
    if (!filters?.spatial) return { surface: raw, dx: ox, dy: oy, perPixel: filters };
    const fkey = `${ox},${oy}:${filters.key}`;
    let byKey = this.filteredCache.get(raw);
    if (!byKey) {
      byKey = new Map();
      this.filteredCache.set(raw, byKey);
    }
    let filtered = byKey.get(fkey);
    if (!filtered) {
      filtered = filterOverCanvas(raw, ox, oy, filters, this.sources.width, this.sources.height);
      byKey.clear();
      byKey.set(fkey, filtered);
    }
    return { surface: filtered, dx: 0, dy: 0, perPixel: null };
  }

  /** RGBA of a content layer over `r` (document space, inside one tile), or `null` when it has nothing there. */
  private contentTile(layer: L, r: RasterRect): Uint8ClampedArray | null {
    if (!this.isPixel(layer)) return this.profile.contentTile?.(layer, r, this.sources) ?? null;
    const { surface, dx, dy, perPixel } = this.layerPixels(layer);
    const src = { x: r.x - dx, y: r.y - dy, width: r.width, height: r.height };
    const covered = tilesInRect(src).map((t) => surface.getTile(t.tx, t.ty));
    if (surface.defaultValue === 0 && covered.every((t) => !t)) return null;
    const aligned = r.width === TILE && r.height === TILE && src.x % TILE === 0 && src.y % TILE === 0;
    if (!perPixel) {
      if (aligned && covered[0]) return covered[0].data;
      return readRegion(surface, src);
    }
    // Per-pixel filters: cache the filtered tile by its source tile and the filter settings.
    const fkey = `${dx},${dy}:${perPixel.key}`;
    const anchor = (covered.find(Boolean) ?? surface) as object;
    let byKey = this.contentCache.get(anchor);
    const refsKey = `${r.x},${r.y}:${fkey}`;
    if (aligned) {
      const hit = byKey?.get(refsKey);
      if (hit) return hit;
    }
    const data = readRegion(surface, src);
    perPixel.apply(data, r.width, r.height);
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
      const generated = this.profile.maskSourcePlane?.(mask.source, W, H, this.sources) ?? null;
      if (!generated || generated.length !== W * H) v.fill(1);
      else v.set(generated);
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

  private maskTile(layer: L, r: RasterRect): Float32Array | null {
    const mask = layer.mask;
    if (!mask || mask.enabled === false) return null;
    const ox = this.isPixel(layer) ? (layer.offset?.x ?? 0) : 0;
    const oy = this.isPixel(layer) ? (layer.offset?.y ?? 0) : 0;
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
      const rect = { x: r.x - ox, y: r.y - oy, width: r.width, height: r.height };
      let all = true;
      if (maskDepth(mask.surface) !== 8) {
        // A 16- or 32-bit mask: coverage from its deep samples.
        const d = readDeepRegion(mask.surface, rect, 32);
        for (let i = 0; i < n; i++) {
          const v = d[i] <= 0 ? 0 : d[i] >= 1 ? 1 : d[i];
          out[i] = v;
          if (v !== 1) all = false;
        }
      } else {
        const bytes = readRegion(mask.surface, rect);
        for (let i = 0; i < n; i++) {
          out[i] = bytes[i] / 255;
          if (bytes[i] !== 255) all = false;
        }
      }
      if (all) return null;
      if (density !== 1) for (let i = 0; i < n; i++) out[i] = 1 - density * (1 - out[i]);
    }
    return out;
  }

  // --- Running steps ---------------------------------------------------------

  /** Runs one step onto `acc`; returns whether `acc` is still empty. */
  private runStep(step: Step<L>, acc: Uint8ClampedArray, empty: boolean, r: RasterRect): boolean {
    if (step.kind === 'adjust') {
      if (empty) return true;
      this.applyFilterRun(step.layers, acc, r);
      return false;
    }
    const layer = step.layer;
    if (!layer.visible) return empty;
    const clipped = step.clipped.filter((l) => l.visible);
    // Effects can reach into a tile the layer's mask hides.
    if (this.hasEffects(layer)) return this.runEffectStep(layer, clipped, acc, empty, r);
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
    let content = this.contentTile(step.layer, r);
    if (!content) return empty;
    // The live edge cast needs something behind the layer, or a fixed colour.
    const ambient = layer.edge?.ambient ?? 0;
    if (ambient > 0 && (!empty || layer.edge?.ambientColor)) {
      // Tiles can be shared (cached) buffers: cast a copy.
      content = new Uint8ClampedArray(content);
      applyEdgeAmbient(content, acc, coverage, ambient, layer.edge?.ambientColor ?? null, 255);
    }
    const fill = this.isPixel(step.layer) ? (step.layer.fillOpacity ?? 1) : 1;
    const blend = this.contentBlend(step.layer);
    if (!clipped.length) return this.blendOnto(acc, content, empty, blend, layer.opacity * fill, coverage);
    // Clipping group: the base (with its mask and fill) is the shape the clipped layers paint in.
    const buf = new Uint8ClampedArray(acc.length);
    blendTile(buf, content, 'normal', fill, coverage);
    this.applyClipped(clipped, buf, r);
    return this.blendOnto(acc, buf, empty, blend, layer.opacity, null);
  }

  private runSteps(steps: Step<L>[], acc: Uint8ClampedArray, empty: boolean, r: RasterRect): boolean {
    for (const s of steps) empty = this.runStep(s, acc, empty, r);
    return empty;
  }

  private contentBlend(layer: L): BlendMode {
    return this.profile.contentBlend?.(layer) ?? (layer.blend as BlendMode);
  }

  private blendOnto(acc: Uint8ClampedArray, src: Uint8ClampedArray, empty: boolean, mode: BlendMode, alpha: number, coverage: Float32Array | null): boolean {
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

  private applyClipped(clipped: L[], buf: Uint8ClampedArray, r: RasterRect): void {
    let run: L[] = [];
    const flush = () => {
      if (run.length) this.applyFilterRun(run, buf, r);
      run = [];
    };
    for (const c of clipped) {
      if (this.isFilter(c)) {
        run.push(c);
        continue;
      }
      flush();
      if (this.hasEffects(c) && !isGroup(c)) {
        // Clipped to the base: the layer and its effects composite, then the base's alpha is kept.
        this.compositeEffects(c, [], buf, r, true);
        continue;
      }
      const coverage = this.maskTile(c, r);
      if (isGroup(c)) {
        const inner = new Uint8ClampedArray(buf.length);
        if (this.runSteps(this.buildSteps((c.children ?? []) as L[]), inner, true, r)) continue;
        const mode = (c.blend === 'pass-through' ? 'normal' : c.blend) as BlendMode;
        blendAtop(buf, inner, mode, c.opacity, coverage);
        continue;
      }
      const content = this.contentTile(c, r);
      if (!content) continue;
      const fill = this.isPixel(c) ? (c.fillOpacity ?? 1) : 1;
      blendAtop(buf, content, this.contentBlend(c), c.opacity * fill, coverage);
    }
    flush();
  }

  private applyFilterRun(layers: L[], acc: Uint8ClampedArray, r: RasterRect): void {
    const visible: L[] = [];
    let masks: Map<string, Float32Array> | undefined;
    for (const node of layers) {
      if (!node.visible) continue;
      const cov = this.maskTile(node, r);
      if (cov) {
        if (cov.every((v) => v <= 0)) continue;
        (masks ??= new Map()).set(node.id, cov);
      }
      visible.push(node);
    }
    if (visible.length) this.profile.applyFilterRun?.(visible, acc, r, masks, this.sources);
  }
}

/**
 * Applies a layer's filters over the canvas rect in document space: the result is a surface at
 * offset 0 holding only canvas pixels (spatial filters clamp at the canvas edges).
 */
function filterOverCanvas(surface: PixelSurface, ox: number, oy: number, filters: PixelFilterSpec, width: number, height: number): PixelSurface {
  if (width <= 0 || height <= 0) return emptySurface(4);
  const data = readRegion(surface, { x: -ox, y: -oy, width, height });
  filters.apply(data, width, height);
  return surfaceFromPixels({ width, height, data }, 4, 0, 0);
}

/** The part `a` of RGBA `data` over `r`, as its own buffer. */
function copyRect(data: Uint8ClampedArray, r: RasterRect, a: RasterRect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(a.width * a.height * 4);
  for (let y = 0; y < a.height; y++) {
    const s = ((a.y - r.y + y) * r.width + (a.x - r.x)) * 4;
    out.set(data.subarray(s, s + a.width * 4), y * a.width * 4);
  }
  return out;
}

/** Writes `part` (RGBA over `a`) back into `data` (over `r`). */
function pasteRect(data: Uint8ClampedArray, r: RasterRect, part: Uint8ClampedArray, a: RasterRect): void {
  for (let y = 0; y < a.height; y++) data.set(part.subarray(y * a.width * 4, (y + 1) * a.width * 4), ((a.y - r.y + y) * r.width + (a.x - r.x)) * 4);
}

function sameRect(a: RasterRect, b: RasterRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function inflateRect(r: RasterRect, m: number): RasterRect {
  return { x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m };
}

function intersectRect(a: RasterRect, b: RasterRect): RasterRect {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 <= x0 || y1 <= y0 ? { x: x0, y: y0, width: 0, height: 0 } : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Tiles that differ between two surfaces (by tile identity), as tile keys. */
export function changedTiles(a: TiledSurface, b: TiledSurface): TileKey[] {
  const out: TileKey[] = [];
  for (const [k, t] of b.tiles) if (a.tiles.get(k) !== t) out.push(k);
  for (const k of a.tiles.keys()) if (!b.tiles.has(k)) out.push(k);
  return out;
}
