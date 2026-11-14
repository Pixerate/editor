/**
 * Antimatter paint (`engine: 'antimatter'`, `marks.kind: 'antimatter'`): animated blasts that
 * detonate where the brush touches paint across any visible layer, inverting colours in the core,
 * removing alpha, burning a soot ring around the crater, denting thick relief, clearing core light,
 * and throwing white-hot ballistic sparks on the active layer.
 */

import { oklabToRgb, rgbToOklab } from '../color/convert';
import { dabRect, rasterizeDab } from '../paint/brush';
import type { RgbTriple } from '../paint/exchange';
import { PaintGradientSampler, type PaintGradientSample, type PaintGradientSource } from '../paint/gradient-paint';
import { TILE, TiledSurface, finishTile, tileInRange, tileKey, tileKeyIn, tilesInRect, type RasterRect, type Tile, type TileKey } from '../raster/surface';
import type { PaintBrush } from './brushes';
import { sampleEffectAt, type EffectPaintPixels } from './effect-paint';
import { IDENTITY_COPY, PenDabWalker, PenSmoother, type PenDab, type PenPoint, type StrokeCopy } from './engine';
import {
  DEFAULT_ANTIMATTER,
  INVERT_MODES,
  normalizeAntimatter,
  type AntimatterSettings,
  type InvertMode,
} from './mark-settings';
import { hash2, rand01, randSigned } from './noise';
import type { ThickChannels } from './thick';

export { DEFAULT_ANTIMATTER, INVERT_MODES, normalizeAntimatter, type AntimatterSettings, type InvertMode };

/** Coverage quantum matching wet paint (`1 / 4096`) so 1×/2× replays and TS/Swift agree on fuel. */
const COVERAGE_STEPS = 4096;

/** One detonation along an antimatter stroke. */
export interface AntimatterBlast {
  index: number;
  x: number;
  y: number;
  /** Blast radius in document pixels. */
  radius: number;
  /** Tip diameter at the dab that fired this blast. */
  tipSize: number;
  /** Tip opacity at the dab that fired this blast (`0..1`). */
  tipOpacity: number;
  /** Fuel (`0..1`) that triggered this blast. */
  fuel: number;
  /** Copy-specific seed for noise and sparks. */
  seed: number;
  /** Spark target colour (0..255 RGB). */
  color: [number, number, number];
  /** Light intensity (`0..1`) sparks write to `doc.light` on the active layer. */
  lightAmount: number;
  /** Number of sparks spawned by this blast. */
  sparkCount: number;
  /** Birth timestamp in ms (from `PenPoint.t` or the host clock). */
  t: number;
}

/** Summary returned on `PaintStrokeResult.antimatter`. */
export interface AntimatterStats {
  blasts: number;
  sparks: number;
  fuel: number;
  layers: string[];
  skippedLayers: string[];
}

/** One visible layer that supplies fuel to the antimatter stroke (and is edited if `editable`). */
export interface AntimatterTarget {
  id: string;
  /** True for unlocked pixel layers (not stroke, sticker or effect layers). */
  editable: boolean;
  lockTransparency: boolean;
  opacity: number;
  offset: { x: number; y: number };
  /** Pre-stroke pixel surface (read-only fuel & recomposite source). */
  base: TiledSurface;
  /** Pre-stroke light channel (`doc.light[id]`), if any. */
  baseLight?: TiledSurface | null;
  /** Pre-stroke thick-paint channels (`doc.thick[id]`), if any. */
  baseThick?: ThickChannels | null;
}

/** Per-layer output surfaces produced by `AntimatterStrokeDriver`. */
export interface AntimatterLayerOutput {
  id: string;
  surface: TiledSurface;
  light: TiledSurface | null;
  thick: ThickChannels | null;
  changed: boolean;
}

export interface AntimatterStrokeInit {
  activeLayerId: string;
  targets: readonly AntimatterTarget[];
  brush: PaintBrush;
  /** Paint colour 0..255 RGBA. */
  color: readonly [number, number, number, number];
  seed: number;
  copies: readonly StrokeCopy[];
  selection?: { width: number; height: number; data: ArrayLike<number> } | null;
  paint?: PaintGradientSource | null;
  effect?: EffectPaintPixels | null;
  /** Current clock in ms for stamping blast birth times during live strokes. */
  now?: () => number;
}

function unionRect(a: RasterRect | null, b: RasterRect): RasterRect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function sameTile(a: Tile | undefined, b: Tile | null): boolean {
  if (!a || !b) return !a && !b;
  if (a === b) return true;
  if (a.uniform !== null || b.uniform !== null) return a.uniform === b.uniform;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/** Smooth 2D value noise in `0..1` using only `Math.floor` and `hash2` (identical across TS and Swift). */
export function blastNoise2D(ux: number, uy: number, salt: number): number {
  const x0 = Math.floor(ux);
  const y0 = Math.floor(uy);
  const fx = ux - x0;
  const fy = uy - y0;
  const tx = fx * fx * (3 - 2 * fx);
  const ty = fy * fy * (3 - 2 * fy);
  const n00 = hash2(x0, y0, salt);
  const n10 = hash2(x0 + 1, y0, salt);
  const n01 = hash2(x0, y0 + 1, salt);
  const n11 = hash2(x0 + 1, y0 + 1, salt);
  const a = n00 + (n10 - n00) * tx;
  const b = n01 + (n11 - n01) * tx;
  return a + (b - a) * ty;
}

/** Inverts an 8-bit sRGB colour in OKLab space by flipping lightness `1 - L` and hue `(-a, -b)`. */
export function invertOklab8(r: number, g: number, b: number): [number, number, number] {
  const lab = rgbToOklab({ r: r / 255, g: g / 255, b: b / 255, a: 1 });
  const rgb = oklabToRgb({ l: 1 - lab.l, a: -lab.a, b: -lab.b, alpha: 1 });
  return [
    Math.min(255, Math.max(0, Math.round(rgb.r * 255))),
    Math.min(255, Math.max(0, Math.round(rgb.g * 255))),
    Math.min(255, Math.max(0, Math.round(rgb.b * 255))),
  ];
}

/** Core (`0..1`) and soot-ring (`0..1`) weights for a heat value `h` in `0..1`. */
export function heatProfile(h: number): { core: number; ring: number } {
  if (h <= 0) return { core: 0, ring: 0 };
  const coreT = Math.min(1, Math.max(0, (h - 0.32) / 0.5));
  const core = coreT * coreT * (3 - 2 * coreT);
  const ringIn = Math.min(1, Math.max(0, h / 0.35));
  const ringOut = Math.min(1, Math.max(0, (0.82 - h) / 0.47));
  const ring = ringIn * ringOut * (3 - 2 * ringIn) * (3 - 2 * ringOut);
  return { core, ring };
}
interface AntimatterCopyState {
  walker: PenDabWalker;
  seed: number;
  blastCount: number;
  firedAny: boolean;
  travel: number;
  fuelSum: number;
  fuelDabs: number;
  lastPos: { x: number; y: number } | null;
}

export class AntimatterStrokeDriver {
  dabCount = 0;
  bounds: RasterRect | null = null;
  readonly blasts: AntimatterBlast[] = [];
  private readonly smoother: PenSmoother;
  private readonly copies: readonly StrokeCopy[];
  private readonly states: AntimatterCopyState[];
  private readonly sampler: PaintGradientSampler | null;
  private readonly sample: PaintGradientSample = { rgb: [0, 0, 0], alpha: 1 };
  private readonly effRgb: RgbTriple = [0, 0, 0];
  private readonly heat = new Map<TileKey, Float32Array>();
  private readonly heatCoords = new Map<TileKey, { tx: number; ty: number }>();
  private tipBuf = new Float32Array(0);
  private lastRaw: PenPoint | null = null;
  private lastFed: PenPoint | null = null;
  private totalFuel = 0;
  private readonly reachedSkipped = new Set<string>();
  private readonly editedIds = new Set<string>();
  private readonly outputs = new Map<string, AntimatterLayerOutput>();

  constructor(readonly init: AntimatterStrokeInit) {
    const { brush } = init;
    this.smoother = new PenSmoother(brush.tip.smoothing, brush.pressureSmoothing);
    const copies = init.copies.length ? init.copies : [IDENTITY_COPY];
    this.copies = copies;
    this.states = copies.map((c, i) => {
      const seed = (init.seed + i * 9973) | 0;
      return {
        walker: new PenDabWalker(brush, seed, c.linear),
        seed,
        blastCount: 0,
        firedAny: false,
        travel: 0,
        fuelSum: 0,
        fuelDabs: 0,
        lastPos: null,
      };
    });
    const g = init.paint ?? null;
    this.sampler = g ? new PaintGradientSampler(g.map.by === 'across-tip' ? { ...g, map: { by: 'distance', length: 300, repeat: 'mirror' } } : g, init.seed) : null;
  }

  /** Pushes raw pen samples and returns the bounding rectangles of any blasts that fired. */
  push(points: readonly PenPoint[]): RasterRect[] {
    const rects: RasterRect[] = [];
    for (const raw of points) {
      this.lastRaw = raw;
      const p = this.smoother.push(raw);
      this.lastFed = p;
      const tNow = typeof raw.t === 'number' && Number.isFinite(raw.t) ? raw.t : (this.init.now ? this.init.now() : 0);
      this.copies.forEach((c, i) => {
        const dabs: PenDab[] = [];
        this.states[i].walker.push(c.map(p), dabs);
        this.processDabs(i, dabs, tNow, rects);
      });
    }
    if (rects.length) this.recompositeAll();
    return rects;
  }

  /** Flushes the smoother tail and finishes the stroke. */
  finish(): RasterRect[] {
    const rects: RasterRect[] = [];
    const raw = this.lastRaw;
    const fed = this.lastFed;
    const tNow = raw && typeof raw.t === 'number' && Number.isFinite(raw.t) ? raw.t : (this.init.now ? this.init.now() : 0);
    this.copies.forEach((c, i) => {
      const dabs: PenDab[] = [];
      if (raw && fed && (raw.x !== fed.x || raw.y !== fed.y)) {
        this.states[i].walker.push(c.map({ ...raw, pressure: fed.pressure }), dabs);
      }
      this.states[i].walker.finish(dabs);
      this.processDabs(i, dabs, tNow, rects);
    });
    if (rects.length) this.recompositeAll();
    return rects;
  }

  private processDabs(copyIdx: number, dabs: readonly PenDab[], tNow: number, rects: RasterRect[]): void {
    const st = this.states[copyIdx];
    const settings = this.init.brush.antimatter;
    for (const d of dabs) {
      this.dabCount++;
      const stepDist = st.lastPos ? Math.hypot(d.x - st.lastPos.x, d.y - st.lastPos.y) / Math.max(1, d.radius * 2) : 0;
      st.lastPos = { x: d.x, y: d.y };
      const dabFuel = this.measureFuel(d);
      if (!st.firedAny) {
        if (dabFuel >= settings.threshold && dabFuel > 0) {
          st.firedAny = true;
          st.travel = 0;
          st.fuelSum = 0;
          st.fuelDabs = 0;
          rects.push(this.fireBlast(st, d, dabFuel, tNow));
        }
        continue;
      }
      st.travel += stepDist;
      if (dabFuel > 0) {
        st.fuelSum += dabFuel;
        st.fuelDabs++;
      }
      if (st.travel >= settings.blastSpacing) {
        const meanFuel = st.fuelDabs > 0 ? st.fuelSum / st.fuelDabs : dabFuel;
        if (meanFuel >= settings.threshold && meanFuel > 0 && dabFuel > 0) {
          st.travel = 0;
          st.fuelSum = 0;
          st.fuelDabs = 0;
          rects.push(this.fireBlast(st, d, Math.min(1, meanFuel), tNow));
        } else if (dabFuel < settings.threshold) {
          st.fuelSum = 0;
          st.fuelDabs = 0;
        }
      }
    }
  }

  /** Measures fuel (`0..1`) under `d` from the pre-stroke pixels of every visible layer. */
  private measureFuel(d: PenDab): number {
    const rect = dabRect(d, this.init.brush.tip.hardness);
    if (rect.width <= 0 || rect.height <= 0) return 0;
    const n = rect.width * rect.height;
    if (this.tipBuf.length < n) this.tipBuf = new Float32Array(n);
    const tip = this.tipBuf.subarray(0, n);
    tip.fill(0);
    rasterizeDab({ ...d, alpha: 1 }, this.init.brush.tip.hardness, rect, tip);
    const mask = this.init.selection;
    const targets = this.init.targets;
    let sum = 0;
    let activePixels = 0;
    for (let yy = 0, k = 0; yy < rect.height; yy++) {
      const py = rect.y + yy;
      for (let xx = 0; xx < rect.width; xx++, k++) {
        let rawC = tip[k];
        if (rawC <= 0) continue;
        const px = rect.x + xx;
        if (mask) {
          rawC *= px >= 0 && py >= 0 && px < mask.width && py < mask.height ? mask.data[py * mask.width + px] / 255 : 0;
        }
        const c = Math.round(rawC * COVERAGE_STEPS) / COVERAGE_STEPS;
        if (c <= 0) continue;
        activePixels++;
        let prod = 1;
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          if (t.opacity <= 0) continue;
          const lx = px - t.offset.x;
          const ly = py - t.offset.y;
          const tx = Math.floor(lx / TILE);
          const ty = Math.floor(ly / TILE);
          const tile = t.base.tiles.get(tileKeyIn(tx, ty));
          if (!tile) continue;
          const ox = lx - tx * TILE;
          const oy = ly - ty * TILE;
          const a = tile.data[(oy * TILE + ox) * 4 + 3] / 255;
          if (a > 0) prod *= 1 - a * t.opacity;
        }
        const combinedAlpha = 1 - prod;
        if (combinedAlpha > 0) sum += c * combinedAlpha;
      }
    }
    if (activePixels === 0 || sum <= 0) return 0;
    return Math.round((sum / activePixels) * COVERAGE_STEPS) / COVERAGE_STEPS;
  }
  private fireBlast(st: AntimatterCopyState, d: PenDab, fuel: number, tNow: number): RasterRect {
    const { brush, color, effect } = this.init;
    const settings = brush.antimatter;
    const blastIndex = st.blastCount++;
    const tipRadius = Math.max(1, d.radius);
    const fuelScale = 0.55 + 0.65 * Math.sqrt(fuel);
    const jitter = 0.88 + 0.24 * rand01(st.seed, blastIndex, 17);
    const radius = Math.max(2, tipRadius * settings.blastRadius * fuelScale * jitter);
    let sparkRgb: [number, number, number] = [color[0], color[1], color[2]];
    let flow = 1;
    if (effect) {
      const effA = sampleEffectAt(effect, d.x, d.y, this.effRgb, d);
      sparkRgb = [Math.round(this.effRgb[0] * 255), Math.round(this.effRgb[1] * 255), Math.round(this.effRgb[2] * 255)];
      flow = effA;
    } else if (this.sampler) {
      const g = this.sampler.dab(d, this.sample);
      sparkRgb = [Math.round(g.rgb[0] * 255), Math.round(g.rgb[1] * 255), Math.round(g.rgb[2] * 255)];
      flow = g.alpha;
    }
    const tipOpacity = Math.min(1, d.alpha * d.opacity * brush.tip.opacity * flow);
    const lightAmount = brush.light.amount * (brush.light.pressure ? d.pressure : 1);
    const sparkCount = settings.sparks > 0 ? Math.max(1, Math.round(settings.sparks * (6 + 10 * fuel))) : 0;
    const blast: AntimatterBlast = {
      index: blastIndex,
      x: d.x,
      y: d.y,
      radius,
      tipSize: d.radius * 2,
      tipOpacity,
      fuel,
      seed: st.seed,
      color: sparkRgb,
      lightAmount,
      sparkCount,
      t: tNow,
    };
    this.blasts.push(blast);
    this.totalFuel += fuel;
    const rect = this.writeBlastToHeat(blast, this.heat, this.heatCoords, 1);
    this.bounds = unionRect(this.bounds, rect);
    return rect;
  }

  /** Writes one blast into `heatMap` (at `progress` 0..1) and returns the bounding rectangle including sparks. */
  private writeBlastToHeat(
    b: AntimatterBlast,
    heatMap: Map<TileKey, Float32Array>,
    coordMap: Map<TileKey, { tx: number; ty: number }>,
    progress: number,
  ): RasterRect {
    const expand = 1 - (1 - progress) * (1 - progress);
    const effRadius = b.radius * (0.2 + 0.8 * expand);
    const maxR = Math.ceil(effRadius * 1.22);
    const x0 = Math.floor(b.x - maxR);
    const y0 = Math.floor(b.y - maxR);
    const x1 = Math.ceil(b.x + maxR);
    const y1 = Math.ceil(b.y + maxR);
    const salt = (b.seed + b.index * 4099) | 0;
    const mask = this.init.selection;
    const targets = this.init.targets;
    for (let py = y0; py <= y1; py++) {
      const dy = py + 0.5 - b.y;
      if (Math.abs(dy) > effRadius * 1.2) continue;
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - b.x;
        const dist = Math.hypot(dx, dy);
        if (dist > effRadius * 1.2) continue;
        let maskA = 1;
        if (mask) {
          if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) continue;
          maskA = mask.data[py * mask.width + px] / 255;
          if (maskA <= 0) continue;
        }
        const rNorm = dist / effRadius;
        const n = blastNoise2D((dx / effRadius) * 2.5, (dy / effRadius) * 2.5, salt) - 0.5;
        const rWarped = rNorm + n * 0.22 * Math.min(1, rNorm * 1.5);
        if (rWarped >= 1) continue;
        const t = 1 - rWarped;
        const h = t * t * (3 - 2 * t) * b.tipOpacity * maskA;
        if (h <= 0) continue;
        const tx = Math.floor(px / TILE);
        const ty = Math.floor(py / TILE);
        // Heat is kept in document tiles: past the surface range it is dropped, never aliased.
        const key = tileKeyIn(tx, ty);
        if (key < 0) continue;
        let tile = heatMap.get(key);
        if (!tile) {
          tile = new Float32Array(TILE * TILE);
          heatMap.set(key, tile);
          coordMap.set(key, { tx, ty });
        }
        const idx = (py - ty * TILE) * TILE + (px - tx * TILE);
        if (h > tile[idx]) tile[idx] = h;
        if (progress >= 1) {
          for (let ti = 0; ti < targets.length; ti++) {
            const tgt = targets[ti];
            if (tgt.editable || this.reachedSkipped.has(tgt.id)) continue;
            const lx = px - tgt.offset.x;
            const ly = py - tgt.offset.y;
            const ltx = Math.floor(lx / TILE);
            const lty = Math.floor(ly / TILE);
            const lt = tgt.base.tiles.get(tileKeyIn(ltx, lty));
            if (lt && lt.data[((ly - lty * TILE) * TILE + (lx - ltx * TILE)) * 4 + 3] > 0) {
              this.reachedSkipped.add(tgt.id);
            }
          }
        }
      }
    }
    const sparkPad = b.sparkCount > 0 ? Math.ceil(b.tipSize * this.init.brush.antimatter.sparkReach * 1.3 + 4) : 0;
    const reachR = Math.max(maxR, Math.ceil(b.radius * 0.6 + sparkPad));
    return {
      x: Math.floor(b.x - reachR),
      y: Math.floor(b.y - reachR),
      width: Math.ceil(reachR * 2) + 1,
      height: Math.ceil(reachR * 2) + 1,
    };
  }

  /** Recomposites all editable target layers from their pre-stroke tiles using the current committed `heat` and `blasts`. */
  private recompositeAll(): void {
    this.outputs.clear();
    this.editedIds.clear();
    const built = this.buildOutputs(this.heat, this.heatCoords, () => 1);
    for (const out of built) {
      this.outputs.set(out.id, out);
      if (out.changed) this.editedIds.add(out.id);
    }
  }
  /**
   * Builds per-layer outputs for the given `heatMap` and blast progress function `progressOf(b)`.
   * At `progressOf(b) === 1`, no flash or shock ring is drawn and sparks reach 100%, matching the
   * committed pixels bit-for-bit.
   */
  private buildOutputs(
    heatMap: Map<TileKey, Float32Array>,
    coordMap: Map<TileKey, { tx: number; ty: number }>,
    progressOf: (b: AntimatterBlast) => number,
  ): AntimatterLayerOutput[] {
    const settings = this.init.brush.antimatter;
    const activeId = this.init.activeLayerId;
    const outList: AntimatterLayerOutput[] = [];
    for (const tgt of this.init.targets) {
      if (!tgt.editable) continue;
      const isActive = tgt.id === activeId;
      const offX = tgt.offset.x;
      const offY = tgt.offset.y;
      const tiles = new Map<TileKey, Tile>(tgt.base.tiles);
      const lightTiles = tgt.baseLight ? new Map<TileKey, Tile>(tgt.baseLight.tiles) : new Map<TileKey, Tile>();
      const heightTiles = tgt.baseThick ? new Map<TileKey, Tile>(tgt.baseThick.height.tiles) : null;
      const touchedTiles = new Map<TileKey, Uint8ClampedArray>();
      const touchedLight = new Map<TileKey, Uint8ClampedArray>();
      const touchedHeight = new Map<TileKey, Uint8ClampedArray>();

      const getLayerTile = (ltx: number, lty: number): Uint8ClampedArray => {
        const lk = tileKey(ltx, lty);
        let buf = touchedTiles.get(lk);
        if (!buf) {
          const src = tgt.base.tiles.get(lk)?.data;
          buf = src ? new Uint8ClampedArray(src) : new Uint8ClampedArray(TILE * TILE * 4);
          touchedTiles.set(lk, buf);
        }
        return buf;
      };
      const getLightTile = (ltx: number, lty: number): Uint8ClampedArray => {
        const lk = tileKey(ltx, lty);
        let buf = touchedLight.get(lk);
        if (!buf) {
          const src = tgt.baseLight?.tiles.get(lk)?.data;
          buf = src ? new Uint8ClampedArray(src) : new Uint8ClampedArray(TILE * TILE);
          touchedLight.set(lk, buf);
        }
        return buf;
      };
      const getHeightTile = (ltx: number, lty: number): Uint8ClampedArray => {
        const lk = tileKey(ltx, lty);
        let buf = touchedHeight.get(lk);
        if (!buf) {
          const src = tgt.baseThick?.height.tiles.get(lk)?.data;
          buf = src ? new Uint8ClampedArray(src) : new Uint8ClampedArray(TILE * TILE);
          touchedHeight.set(lk, buf);
        }
        return buf;
      };

      for (const [hk, hData] of heatMap) {
        const { tx: dtx, ty: dty } = coordMap.get(hk)!;
        const docOx = dtx * TILE;
        const docOy = dty * TILE;
        for (let oy = 0; oy < TILE; oy++) {
          const py = docOy + oy;
          const ly = py - offY;
          const lty = Math.floor(ly / TILE);
          const loy = ly - lty * TILE;
          for (let ox = 0; ox < TILE; ox++) {
            const h = hData[oy * TILE + ox];
            if (h <= 0) continue;
            const px = docOx + ox;
            const lx = px - offX;
            const ltx = Math.floor(lx / TILE);
            const lox = lx - ltx * TILE;
            // A layer pixel past the surface range has no tile: nothing to burn, nothing written.
            const lk = tileKeyIn(ltx, lty);
            if (lk < 0) continue;
            const lIdx = loy * TILE + lox;
            const pIdx = lIdx * 4;
            const srcTile = tgt.base.tiles.get(lk);
            const a0 = srcTile ? srcTile.data[pIdx + 3] : 0;
            const { core, ring } = heatProfile(h);
            if (a0 > 0 || (isActive && !tgt.lockTransparency && ring * settings.scorch > 0)) {
              const dst = getLayerTile(ltx, lty);
              let r = srcTile ? srcTile.data[pIdx] : 0;
              let g = srcTile ? srcTile.data[pIdx + 1] : 0;
              let b = srcTile ? srcTile.data[pIdx + 2] : 0;
              let a = a0;
              const aNorm = a0 / 255;
              if (a0 > 0) {
                const invAmt = core * settings.invert;
                if (invAmt > 0) {
                  let ir: number;
                  let ig: number;
                  let ib: number;
                  if (settings.invertMode === 'oklab') {
                    [ir, ig, ib] = invertOklab8(r, g, b);
                  } else {
                    ir = 255 - r;
                    ig = 255 - g;
                    ib = 255 - b;
                  }
                  r = r + (ir - r) * invAmt;
                  g = g + (ig - g) * invAmt;
                  b = b + (ib - b) * invAmt;
                }
                const scorchAmt = ring * settings.scorch;
                if (scorchAmt > 0) {
                  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                  const desat = Math.min(1, scorchAmt * 0.85);
                  const sr = r + (lum * 0.85 + 2.7 - r) * desat;
                  const sg = g + (lum * 0.85 + 2.1 - g) * desat;
                  const sb = b + (lum * 0.85 + 1.8 - b) * desat;
                  const keep = 1 - scorchAmt * 0.78;
                  r = sr * keep;
                  g = sg * keep;
                  b = sb * keep;
                }
                if (!tgt.lockTransparency && settings.annihilate > 0 && core > 0) {
                  a = Math.round(a0 * (1 - core * settings.annihilate));
                  if (a <= 0) r = g = b = a = 0;
                }
              }
              if (isActive && !tgt.lockTransparency && ring * settings.scorch > 0 && a < 255) {
                const sootA = Math.round(ring * settings.scorch * 96 * (1 - aNorm));
                if (sootA > 0) {
                  const sa = sootA / 255;
                  const da = a / 255;
                  const outA = da + sa * (1 - da);
                  if (outA > 0) {
                    r = (r * da + 20 * sa * (1 - da)) / outA;
                    g = (g * da + 16 * sa * (1 - da)) / outA;
                    b = (b * da + 14 * sa * (1 - da)) / outA;
                    a = Math.round(outA * 255);
                  }
                }
              }
              dst[pIdx] = Math.min(255, Math.max(0, Math.round(r)));
              dst[pIdx + 1] = Math.min(255, Math.max(0, Math.round(g)));
              dst[pIdx + 2] = Math.min(255, Math.max(0, Math.round(b)));
              dst[pIdx + 3] = Math.min(255, Math.max(0, a));
            }
            if (tgt.baseLight && core > 0) {
              const lSrc = tgt.baseLight.tiles.get(lk);
              const l0 = lSrc ? lSrc.data[lIdx] : 0;
              if (l0 > 0) {
                const lDst = getLightTile(ltx, lty);
                lDst[lIdx] = Math.round(l0 * (1 - core));
              }
            }
            if (tgt.baseThick && settings.crater > 0 && (core > 0 || ring > 0)) {
              const hSrc = tgt.baseThick.height.tiles.get(lk);
              const h0 = hSrc ? hSrc.data[lIdx] : 0;
              if (h0 > 0 || a0 > 0) {
                const hDst = getHeightTile(ltx, lty);
                const aNorm = a0 / 255;
                const nextH = Math.round(
                  h0 * (1 - core * settings.crater * 0.85) -
                    core * settings.crater * 40 +
                    ring * settings.crater * 72 * aNorm,
                );
                hDst[lIdx] = Math.min(255, Math.max(0, nextH));
              }
            }
          }
        }
      }

      if (isActive) {
        this.drawActiveExtras(tgt, getLayerTile, getLightTile, progressOf);
      }

      let changed = false;
      for (const [lk, buf] of touchedTiles) {
        const ft = finishTile(buf, 4, 0);
        const prev = tgt.base.tiles.get(lk);
        if (ft) tiles.set(lk, ft);
        else tiles.delete(lk);
        if (!sameTile(prev, ft)) changed = true;
      }
      let lightOut: TiledSurface | null = null;
      let lightChanged = false;
      for (const [lk, buf] of touchedLight) {
        const ft = finishTile(buf, 1, 0);
        const prev = tgt.baseLight?.tiles.get(lk);
        if (ft) lightTiles.set(lk, ft);
        else lightTiles.delete(lk);
        if (!sameTile(prev, ft)) lightChanged = true;
      }
      if (lightChanged) {
        changed = true;
        lightOut = new TiledSurface(1, lightTiles, 0);
      }
      let thickOut: ThickChannels | null = null;
      if (heightTiles && tgt.baseThick) {
        let heightChanged = false;
        for (const [lk, buf] of touchedHeight) {
          const ft = finishTile(buf, 1, 0);
          const prev = tgt.baseThick.height.tiles.get(lk);
          if (ft) heightTiles.set(lk, ft);
          else heightTiles.delete(lk);
          if (!sameTile(prev, ft)) heightChanged = true;
        }
        if (heightChanged) {
          changed = true;
          thickOut = { ...tgt.baseThick, height: new TiledSurface(1, heightTiles, 0) };
        }
      }
      outList.push({
        id: tgt.id,
        surface: changed ? new TiledSurface(4, tiles, 0) : tgt.base,
        light: lightOut,
        thick: thickOut,
        changed,
      });
    }
    return outList;
  }

  /** Draws sparks and (when `progress < 1`) the view-only flash and expanding shock ring on the active layer. */
  private drawActiveExtras(
    tgt: AntimatterTarget,
    getLayerTile: (ltx: number, lty: number) => Uint8ClampedArray,
    getLightTile: (ltx: number, lty: number) => Uint8ClampedArray,
    progressOf: (b: AntimatterBlast) => number,
  ): void {
    const { selection, brush } = this.init;
    const reachFactor = brush.antimatter.sparkReach;
    const offX = tgt.offset.x;
    const offY = tgt.offset.y;

    const blendPixel = (px: number, py: number, sr: number, sg: number, sb: number, sa: number, lightVal: number) => {
      if (sa <= 0) return;
      let maskA = 1;
      if (selection) {
        if (px < 0 || py < 0 || px >= selection.width || py >= selection.height) return;
        maskA = selection.data[py * selection.width + px] / 255;
        if (maskA <= 0) return;
      }
      const lx = px - offX;
      const ly = py - offY;
      const ltx = Math.floor(lx / TILE);
      const lty = Math.floor(ly / TILE);
      // Sparks past the surface range are dropped (the layer stores no tile there).
      if (!tileInRange(ltx, lty)) return;
      const lox = lx - ltx * TILE;
      const loy = ly - lty * TILE;
      const lIdx = loy * TILE + lox;
      const pIdx = lIdx * 4;
      const dst = getLayerTile(ltx, lty);
      const da = dst[pIdx + 3] / 255;
      if (tgt.lockTransparency && da <= 0) return;
      const srcA = Math.min(1, sa * maskA);
      const outA = tgt.lockTransparency ? da : da + srcA * (1 - da);
      if (outA <= 0) return;
      const w = tgt.lockTransparency ? srcA : srcA / outA;
      dst[pIdx] = Math.min(255, Math.max(0, Math.round(dst[pIdx] * (1 - w) + sr * w)));
      dst[pIdx + 1] = Math.min(255, Math.max(0, Math.round(dst[pIdx + 1] * (1 - w) + sg * w)));
      dst[pIdx + 2] = Math.min(255, Math.max(0, Math.round(dst[pIdx + 2] * (1 - w) + sb * w)));
      if (!tgt.lockTransparency) {
        dst[pIdx + 3] = Math.min(255, Math.max(0, Math.round(outA * 255)));
      }
      if (lightVal > 0) {
        const lDst = getLightTile(ltx, lty);
        const nextL = Math.min(255, lDst[lIdx] + Math.round(lightVal * maskA * 255));
        if (nextL > lDst[lIdx]) lDst[lIdx] = nextL;
      }
    };

    for (const b of this.blasts) {
      const progress = Math.max(0, Math.min(1, progressOf(b)));
      if (progress <= 0) continue;
      const seed = b.seed;
      const bi = b.index;
      const [cr, cg, cb] = b.color;
      const baseAlpha = b.tipOpacity;

      for (let si = 0; si < b.sparkCount; si++) {
        const angle = rand01(seed, bi * 64 + si, 31) * Math.PI * 2;
        const speed = 0.45 + 0.85 * rand01(seed, bi * 64 + si, 37);
        const curve = (rand01(seed, bi * 64 + si, 41) - 0.5) * 0.45;
        const dist = b.tipSize * reachFactor * speed * progress;
        const startR = b.radius * (0.2 + 0.25 * rand01(seed, bi * 64 + si, 43));
        const steps = Math.max(2, Math.ceil(dist * 1.5));
        const ux = Math.round(Math.cos(angle) * 65536) / 65536;
        const uy = Math.round(Math.sin(angle) * 65536) / 65536;
        const nx = -uy;
        const ny = ux;
        for (let st = 0; st <= steps; st++) {
          const u = st / steps;
          const d = startR + u * dist;
          const bend = curve * u * u * dist * 0.35;
          const sx = Math.round(b.x + ux * d + nx * bend);
          const sy = Math.round(b.y + uy * d + ny * bend);
          const cool = Math.min(1, u * 1.15);
          const sr = 255 + (cr - 255) * cool;
          const sg = 252 + (cg - 252) * cool;
          const sb = 240 + (cb - 240) * cool;
          const fade = (1 - u * 0.72) * baseAlpha;
          const lightHit = b.lightAmount > 0 ? b.lightAmount * (1 - u * 0.65) : 0;
          blendPixel(sx, sy, sr, sg, sb, fade, lightHit);
        }
      }

      if (progress < 1) {
        const flashStrength = Math.max(0, 1 - progress * 2.2);
        const shockFade = (1 - progress) * (1 - progress);
        const shockR = b.radius * (0.25 + 0.75 * Math.sqrt(progress));
        const band = Math.max(1.5, b.radius * 0.14);
        const maxR = Math.ceil(shockR + band + 1);
        const minX = Math.floor(b.x - maxR);
        const maxX = Math.ceil(b.x + maxR);
        const minY = Math.floor(b.y - maxR);
        const maxY = Math.ceil(b.y + maxR);
        for (let py = minY; py <= maxY; py++) {
          const dy = py - b.y;
          for (let px = minX; px <= maxX; px++) {
            const dx = px - b.x;
            const d = Math.hypot(dx, dy);
            let a = 0;
            if (flashStrength > 0 && d < b.radius * 0.55) {
              const f = 1 - d / (b.radius * 0.55);
              a = Math.max(a, f * f * flashStrength * 0.9);
            }
            const ringDist = Math.abs(d - shockR);
            if (ringDist < band) {
              const rf = 1 - ringDist / band;
              a = Math.max(a, rf * rf * shockFade * 0.75);
            }
            if (a > 0) {
              blendPixel(px, py, 255, 250, 235, a, b.lightAmount * a);
            }
          }
        }
      }
    }
  }

  /**
   * Renders the blast state at `now` (ms) for view-only blast animation.
   * When `active` is `false` (all blasts have reached `progress === 1`), `outputs` match `layerOutputs()` bit-for-bit.
   */
  renderAtTime(now: number): { outputs: AntimatterLayerOutput[]; active: boolean } {
    const durationMs = this.init.brush.antimatter.duration * 1000;
    if (durationMs <= 0 || this.blasts.length === 0) {
      return { outputs: this.layerOutputs(), active: false };
    }
    let anyActive = false;
    const progressOf = (b: AntimatterBlast): number => {
      if (now < b.t) return 0;
      const elapsed = now - b.t;
      if (elapsed >= durationMs) return 1;
      anyActive = true;
      return Math.min(1, 0.05 + 0.95 * (elapsed / durationMs));
    };
    for (const b of this.blasts) {
      if (now - b.t < durationMs) {
        anyActive = true;
        break;
      }
    }
    if (!anyActive) {
      return { outputs: this.layerOutputs(), active: false };
    }
    const animHeat = new Map<TileKey, Float32Array>();
    const animCoords = new Map<TileKey, { tx: number; ty: number }>();
    for (const b of this.blasts) {
      const p = progressOf(b);
      if (p > 0) {
        this.writeBlastToHeat(b, animHeat, animCoords, p);
      }
    }
    const outputs = this.buildOutputs(animHeat, animCoords, progressOf);
    return { outputs, active: true };
  }

  hasBlasts(): boolean {
    return this.blasts.length > 0;
  }

  /** Rebases blast birth times so the earliest blast starts at `now` ms. */
  rebaseTime(now: number): void {
    if (!this.blasts.length) return;
    let minT = Infinity;
    for (const b of this.blasts) if (b.t < minT) minT = b.t;
    const shift = now - minT;
    for (const b of this.blasts) b.t += shift;
  }

  layerOutputs(): AntimatterLayerOutput[] {
    const list: AntimatterLayerOutput[] = [];
    for (const tgt of this.init.targets) {
      if (!tgt.editable) continue;
      const out = this.outputs.get(tgt.id);
      if (out) list.push(out);
    }
    return list;
  }

  stats(): AntimatterStats {
    const layers: string[] = [];
    const skippedLayers: string[] = [];
    for (const tgt of this.init.targets) {
      if (tgt.editable) {
        if (this.editedIds.has(tgt.id)) layers.push(tgt.id);
      } else if (this.reachedSkipped.has(tgt.id)) {
        skippedLayers.push(tgt.id);
      }
    }
    let sparks = 0;
    for (const b of this.blasts) sparks += b.sparkCount;
    return {
      blasts: this.blasts.length,
      sparks,
      fuel: Math.round(this.totalFuel * 10000) / 10000,
      layers,
      skippedLayers,
    };
  }
}
