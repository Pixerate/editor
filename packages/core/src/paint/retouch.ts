// Portions ported from photocraft/crates/paint/src/retouch.rs, crates/algo/src/retouch.rs and crates/engine/src/retouch_cmds.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * The retouching tools on the shared brush engine: Clone Stamp, Healing Brush, Spot Healing
 * Brush, Smudge, Dodge, Burn and Sponge. Two stroke shapes cover them all:
 *
 * - **Accumulate, then composite** (Clone Stamp, Dodge, Burn; the Healing tools' result): the
 *   stroke's dabs build up one `CoverageMap` (flow builds towards the dab's opacity ceiling), and
 *   per-pixel paint taken from the pre-stroke state (a cloned source, a toned copy of the pixel,
 *   a healed patch) is composited through it with `applyRetouchToTile`. Pixels painted earlier in
 *   the stroke are never sampled again, and overlapping dabs never exceed the stroke's opacity.
 * - **Sequential dabs** (Smudge, Sponge): `RetouchDabStroke` runs each dab in order over live
 *   tiles, so dab n sees what dab n − 1 did.
 *
 * The Healing Brush clones while it is drawn and, when the stroke ends, replaces the clone with a
 * seamless clone (`healPixels`, Poisson blending): the source's texture with the colour and light
 * of the pixels around the stroke. The Spot Healing Brush finds its own source (`spotHealPixels`).
 *
 * Tone curves (`dodgeBurnCurve`, `dodgeBurn`, `sponge`) are photocraft's, made to behave like
 * Photoshop's tools: the chosen range moves most, black and white stay put for midtones, and
 * Protect Tones works on luma so hue and saturation are kept. Data in, pixels out; no DOM.
 */

import { blendPixel, type BlendMode } from '../raster/blend';
import type { RasterRect } from '../raster/surface';
import { TILE, tileKey } from '../raster/surface';
import { srgbDecode, srgbEncode } from '../raster/deep';
import { DabWalker, dabRect, rasterizeDab, type BrushSettings, type CoverageMap, type Dab, type StrokePoint } from './brush';
import { SmudgeTip, type SmudgeSettings } from './blending';
import { TileMedium, put255, type PaintPixels, type PaintTileTarget } from './exchange';
import { bestOffset, contentAwareFill, dilateMask, maskBounds, membraneFill, seamlessClone } from './heal';

// ---------------------------------------------------------------------------
// Tone kernels
// ---------------------------------------------------------------------------

/** The tonal range Dodge and Burn work on most. */
export type ToneRange = 'shadows' | 'midtones' | 'highlights';

export const TONE_RANGES: readonly ToneRange[] = ['shadows', 'midtones', 'highlights'];

/** Rec. 601 luma of straight RGB (0..1). */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** The dodge (or burn) transfer of one value `v` (0..1) at exposure `e` (0..1). */
export function dodgeBurnCurve(v: number, e: number, range: ToneRange, burn: boolean): number {
  const x = Math.max(0, v);
  const k = Math.min(1, Math.max(0, e));
  const c = Math.min(1, x);
  if (range === 'midtones') {
    // A gamma bend weighted to peak at mid-grey: 0 and 1 stay where they are.
    const w = Math.min(1, Math.max(0, 4 * x * (1 - x)));
    return x + w * (Math.pow(c, burn ? 1 + k : 1 / (1 + k)) - x);
  }
  // Shadows / highlights: `v + e·w·(target − v)`, weighted (1 − v)² or v², so that end moves most.
  const w = range === 'shadows' ? (1 - c) * (1 - c) : c * c;
  return burn ? x - k * w * x : x + k * w * (1 - c);
}

/** Brings RGB back into 0..1 keeping its luma (mixing towards grey) rather than clipping each channel. */
function compressGamut(c: number[], l: number): void {
  const L = Math.min(1, Math.max(0, l));
  const lo = Math.min(c[0], c[1], c[2]);
  const hi = Math.max(c[0], c[1], c[2]);
  let t = 1;
  if (hi > 1 && hi - L > 1e-9) t = Math.min(t, (1 - L) / (hi - L));
  if (lo < 0 && L - lo > 1e-9) t = Math.min(t, L / (L - lo));
  for (let i = 0; i < 3; i++) c[i] = L + (c[i] - L) * t;
}

/**
 * Dodge (or burn) straight RGB `c` (0..1, written in place) at exposure `e`. With `protectTones`
 * the curve moves luma and the colour is scaled to it (hue and saturation kept); otherwise each
 * channel goes through the curve.
 */
export function dodgeBurn(c: number[], e: number, range: ToneRange, burn: boolean, protectTones: boolean): number[] {
  if (!(e > 0)) return c;
  if (protectTones) {
    const l = luma(c[0], c[1], c[2]);
    const nl = dodgeBurnCurve(l, e, range, burn);
    if (l > 1e-6) for (let i = 0; i < 3; i++) c[i] *= nl / l;
    else c[0] = c[1] = c[2] = nl;
    compressGamut(c, nl);
  } else for (let i = 0; i < 3; i++) c[i] = dodgeBurnCurve(c[i], e, range, burn);
  return c;
}

/** HSV saturation (chroma / max) of straight RGB. */
export function saturationOf(r: number, g: number, b: number): number {
  const lo = Math.min(r, g, b);
  const hi = Math.max(r, g, b);
  return hi <= 1e-6 ? 0 : Math.min(1, Math.max(0, (hi - lo) / hi));
}

/**
 * Sponge: moves straight RGB `c` (written in place) away from (`saturate`) or towards its luma
 * grey by `amount` (0..1). `vibrance` damps it where it would clip: saturating touches already
 * saturated colours less, desaturating touches near-greys less. Gamut-compressed, never clipped.
 */
export function sponge(c: number[], amount: number, saturate: boolean, vibrance: boolean): number[] {
  let a = Math.min(1, Math.max(0, amount));
  if (!(a > 0)) return c;
  if (vibrance) {
    const s = saturationOf(c[0], c[1], c[2]);
    a *= saturate ? 1 - s : 0.25 + 0.75 * s;
  }
  const l = luma(c[0], c[1], c[2]);
  const k = saturate ? 1 + a : 1 - a;
  for (let i = 0; i < 3; i++) c[i] = l + (c[i] - l) * k;
  compressGamut(c, l);
  return c;
}

/** Per-dab strength so that one pass over a point totals about `e`, whatever the spacing. */
export function perDabStrength(e: number, spacing: number): number {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, e)), Math.min(1, Math.max(0.01, spacing)));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Which pixels the Clone Stamp and the Healing tools sample. */
export type RetouchSample = 'current' | 'current-below' | 'all';

export const RETOUCH_SAMPLES: readonly RetouchSample[] = ['current', 'current-below', 'all'];

/** How the Spot Healing Brush finds its source. */
export type SpotHealType = 'proximity-match' | 'content-aware' | 'smooth';

export const SPOT_HEAL_TYPES: readonly SpotHealType[] = ['proximity-match', 'content-aware', 'smooth'];

/** The retouching tools' options. */
export interface RetouchSettings {
  /** Clone / heal: keep the source offset from stroke to stroke (default true); off, every stroke starts at the source point. */
  aligned: boolean;
  /** Clone / heal / spot heal: what is sampled (default `current`: the target layer). */
  sample: RetouchSample;
  /** Spot heal: `proximity-match` (default: the best matching patch nearby), `content-aware` (texture and edges synthesised from patches around it) or `smooth` (a smooth fill from the edges). */
  spotType: SpotHealType;
  /** Dodge / burn: the tonal range (default `midtones`). */
  range: ToneRange;
  /** Dodge / burn: exposure 0..1 (default 0.5). */
  exposure: number;
  /** Dodge / burn: tone luma only, keeping hue and saturation (default true). */
  protectTones: boolean;
  /** Sponge: `desaturate` (default) or `saturate`. */
  spongeMode: 'desaturate' | 'saturate';
  /** Sponge: damp the change where colours would clip (default true). */
  vibrance: boolean;
  /** Smudge: how strongly the finger carries and lays paint; Blur / Sharpen: how strongly they act, 0..1 (default 0.5). */
  strength: number;
  /** History Brush: how many undo steps back it paints from; 0 (default) is the oldest state history keeps. */
  historySteps: number;
}

export const DEFAULT_RETOUCH: Readonly<RetouchSettings> = {
  aligned: true,
  sample: 'current',
  spotType: 'proximity-match',
  range: 'midtones',
  exposure: 0.5,
  protectTones: true,
  spongeMode: 'desaturate',
  vibrance: true,
  strength: 0.5,
  historySteps: 0,
};

/** Retouch settings with every field valid (missing or invalid fields from `base`). */
export function normalizeRetouch(raw: Partial<RetouchSettings> = {}, base: RetouchSettings = DEFAULT_RETOUCH): RetouchSettings {
  const unit = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const pick = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d);
  return {
    aligned: bool(raw.aligned, base.aligned),
    sample: pick(raw.sample, RETOUCH_SAMPLES, base.sample),
    spotType: pick(raw.spotType, SPOT_HEAL_TYPES, base.spotType),
    range: pick(raw.range, TONE_RANGES, base.range),
    exposure: unit(raw.exposure, base.exposure),
    protectTones: bool(raw.protectTones, base.protectTones),
    spongeMode: pick(raw.spongeMode, ['desaturate', 'saturate'] as const, base.spongeMode),
    vibrance: bool(raw.vibrance, base.vibrance),
    strength: unit(raw.strength, base.strength),
    historySteps: typeof raw.historySteps === 'number' && Number.isFinite(raw.historySteps) ? Math.min(1000, Math.max(0, Math.round(raw.historySteps))) : base.historySteps,
  };
}

/**
 * Box blur of `data` (`w × h × n` floats) in place, `r` pixels each side, edges clamped. RGBA
 * blurs premultiplied, so transparent pixels lend no colour. Run twice for a near-Gaussian.
 */
export function boxBlurPixels(data: Float32Array, w: number, h: number, n: 1 | 4, r: number): void {
  if (r < 1) return;
  if (n === 4) for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] *= data[i + 3] / 255;
  const tmp = new Float32Array(data.length);
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < n; c++) {
        let s = 0;
        for (let d = -r; d <= r; d++) s += data[(y * w + Math.min(w - 1, Math.max(0, x + d))) * n + c];
        tmp[(y * w + x) * n + c] = s * k;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < n; c++) {
        let s = 0;
        for (let d = -r; d <= r; d++) s += tmp[(Math.min(h - 1, Math.max(0, y + d)) * w + x) * n + c];
        data[(y * w + x) * n + c] = s * k;
      }
    }
  }
  if (n === 4) {
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] / 255;
      for (let c = 0; c < 3; c++) data[i + c] = a > 0 ? data[i + c] / a : 0;
    }
  }
}

/**
 * The Blur / Sharpen tools' filter over a padded region (`w × h × n` floats on the 0..255 scale,
 * in place): `blur` is two box passes of `radius`; `sharpen` is an unsharp mask of `amount`
 * over a radius-1 blur (colour only; alpha kept). Values stay at or above 0.
 */
export function retouchFilter(data: Float32Array, w: number, h: number, n: 1 | 4, kind: 'blur' | 'sharpen', radius = 2, amount = 1): void {
  if (kind === 'blur') {
    boxBlurPixels(data, w, h, n, radius);
    boxBlurPixels(data, w, h, n, radius);
    return;
  }
  const soft = data.slice();
  boxBlurPixels(soft, w, h, n, 1);
  for (let i = 0; i < data.length; i++) {
    if (n === 4 && (i & 3) === 3) continue;
    const v = data[i] + amount * (data[i] - soft[i]);
    data[i] = v > 0 ? v : 0;
  }
}

// ---------------------------------------------------------------------------
// Pixel sources
// ---------------------------------------------------------------------------

/** Pixels a retouching stroke samples, by document pixel. */
export interface PixelSource {
  /** Straight RGBA 0..255 of document pixel (x, y) into `out`; false (and `out` zeroed) where there is nothing. */
  sample(x: number, y: number, out: number[]): boolean;
}

/**
 * A source over raster tiles (layer pixels, a mask, or composite tiles): `readTile` gives tile
 * (tx, ty) in source space or `null` when it is empty; source pixel = document pixel − `offset`.
 * One-channel tiles read as grey (alpha 255). Tiles are cached, so make one per stroke.
 */
export class TilePixelSource implements PixelSource {
  private readonly cache = new Map<number, PaintPixels | null>();
  private lastKey = NaN;
  private last: PaintPixels | null = null;

  constructor(
    /** A tile's bytes, or a float working tile on the same 0..255 scale (16 / 32 bits). */
    private readonly readTile: (tx: number, ty: number) => PaintPixels | null,
    readonly channels: 1 | 4,
    readonly offset: { x: number; y: number } = { x: 0, y: 0 }
  ) {}

  sample(x: number, y: number, out: number[]): boolean {
    const lx = x - this.offset.x;
    const ly = y - this.offset.y;
    const tx = Math.floor(lx / TILE);
    const ty = Math.floor(ly / TILE);
    const key = tileKey(tx, ty);
    if (key !== this.lastKey) {
      let t = this.cache.get(key);
      if (t === undefined) {
        t = this.readTile(tx, ty);
        this.cache.set(key, t);
      }
      this.last = t;
      this.lastKey = key;
    }
    const t = this.last;
    if (!t) {
      out[0] = out[1] = out[2] = out[3] = 0;
      return false;
    }
    const p = (ly - ty * TILE) * TILE + (lx - tx * TILE);
    if (this.channels === 1) {
      out[0] = out[1] = out[2] = t[p];
      out[3] = 255;
      return true;
    }
    const i = p * 4;
    out[0] = t[i];
    out[1] = t[i + 1];
    out[2] = t[i + 2];
    out[3] = t[i + 3];
    return out[3] > 0;
  }
}

/** A source over a region of float RGBA pixels (0..255), e.g. a healed patch. */
export class RegionPixelSource implements PixelSource {
  constructor(
    readonly rect: RasterRect,
    readonly data: Float32Array
  ) {}

  sample(x: number, y: number, out: number[]): boolean {
    const r = this.rect;
    const lx = x - r.x;
    const ly = y - r.y;
    if (lx < 0 || ly < 0 || lx >= r.width || ly >= r.height) {
      out[0] = out[1] = out[2] = out[3] = 0;
      return false;
    }
    const i = (ly * r.width + lx) * 4;
    out[0] = this.data[i];
    out[1] = this.data[i + 1];
    out[2] = this.data[i + 2];
    out[3] = this.data[i + 3];
    return out[3] > 0;
  }
}

/** `rect` of a source, shifted by (dx, dy), as float RGBA 0..255 (`rect.width × rect.height × 4`). */
export function readSourceRegion(source: PixelSource, rect: RasterRect, dx = 0, dy = 0): Float32Array {
  const out = new Float32Array(rect.width * rect.height * 4);
  const px = [0, 0, 0, 0];
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      source.sample(rect.x + x + dx, rect.y + y + dy, px);
      const i = (y * rect.width + x) * 4;
      out[i] = px[0];
      out[i + 1] = px[1];
      out[i + 2] = px[2];
      out[i + 3] = px[3];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Accumulate, then composite
// ---------------------------------------------------------------------------

/** What a coverage-based retouching stroke lays through its coverage. */
export type RetouchPaint =
  /** Source pixels at document pixel + (dx, dy) (Clone Stamp, a healed patch). */
  | { kind: 'source'; source: PixelSource; dx: number; dy: number }
  /** The target pixel itself, toned (Dodge, Burn): `tone` edits straight RGB 0..1 in place. */
  | { kind: 'tone'; tone: (rgb: number[]) => void }
  /** A flat colour (the Spot Healing Brush's trail while it is drawn), RGBA 0..255. */
  | { kind: 'color'; color: readonly [number, number, number, number] };

/** How a coverage-based retouching stroke composites. */
export interface RetouchApply {
  /** Stroke opacity 0..1. */
  opacity: number;
  /** Blend mode for source paint (default normal). */
  blend?: BlendMode;
  lockTransparency: boolean;
  /** Selection coverage (document space, canvas-sized), or `null`. */
  selection: { width: number; height: number; data: ArrayLike<number> } | null;
  /** Layer offset (target pixels are in layer space). */
  offset: { x: number; y: number };
}

/**
 * Composites `paint` through the stroke's coverage over `tileData` (target tile (tx, ty) as it was
 * before the stroke, layer space; RGBA, or one byte per pixel for masks) and returns the new tile.
 * With `into` (the previous result) and `region` (document space), only `region` is recomputed.
 * Tone paint keeps alpha; source and colour paint composite with `blend` (source-over by
 * default), keeping alpha on a locked layer.
 */
export function applyRetouchToTile<T extends PaintPixels>(
  coverage: CoverageMap,
  tileData: T,
  channels: 1 | 4,
  tx: number,
  ty: number,
  paint: RetouchPaint,
  s: RetouchApply,
  options: { into?: T; region?: RasterRect } = {}
): T {
  // A float working tile (16 / 32 bits) stays float and keeps fractions; bytes round as ever.
  const out = (options.into ?? tileData).slice() as T;
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
    if (options.into) {
      for (let y = y0; y < y1; y++) out.set(tileData.subarray((y * TILE + x0) * channels, (y * TILE + x1) * channels), (y * TILE + x0) * channels);
    }
  }
  const sel = s.selection;
  const blend = s.blend ?? 'normal';
  const src = [0, 0, 0, 0];
  const rgb = [0, 0, 0];
  const cb = [0, 0, 0, 0];
  const cs = [0, 0, 0, 0];
  // The coverage tile under the pixel, looked up once per tile it crosses.
  let covKey = NaN;
  let covTile: Float32Array | undefined;
  for (let y = y0; y < y1; y++) {
    const dy = oy + y;
    const cty = Math.floor(dy / TILE);
    for (let x = x0; x < x1; x++) {
      const dx = ox + x;
      const ctx = Math.floor(dx / TILE);
      const key = tileKey(ctx, cty);
      if (key !== covKey) {
        covKey = key;
        covTile = coverage.tiles.get(key);
      }
      if (!covTile) continue;
      const c = covTile[(dy - cty * TILE) * TILE + (dx - ctx * TILE)];
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
        // Masks: grey values; the source's grey is its red channel.
        const g = out[p];
        let t: number;
        if (paint.kind === 'tone') {
          rgb[0] = rgb[1] = rgb[2] = g / 255;
          paint.tone(rgb);
          t = luma(rgb[0], rgb[1], rgb[2]) * 255;
        } else if (paint.kind === 'color') t = paint.color[0];
        else {
          if (!paint.source.sample(dx + paint.dx, dy + paint.dy, src)) continue;
          t = src[0];
          k *= src[3] / 255;
        }
        out[p] = Math.round(g + (t - g) * k);
        continue;
      }
      const i = p * 4;
      const a = out[i + 3];
      if (paint.kind === 'tone') {
        if (a === 0) continue;
        rgb[0] = out[i] / 255;
        rgb[1] = out[i + 1] / 255;
        rgb[2] = out[i + 2] / 255;
        const r0 = rgb[0];
        const g0 = rgb[1];
        const b0 = rgb[2];
        paint.tone(rgb);
        put255(out, i, r0 + (rgb[0] - r0) * k);
        put255(out, i + 1, g0 + (rgb[1] - g0) * k);
        put255(out, i + 2, b0 + (rgb[2] - b0) * k);
        continue;
      }
      if (s.lockTransparency && a === 0) continue;
      if (paint.kind === 'color') {
        src[0] = paint.color[0];
        src[1] = paint.color[1];
        src[2] = paint.color[2];
        src[3] = paint.color[3];
      } else if (!paint.source.sample(dx + paint.dx, dy + paint.dy, src)) continue;
      for (let ch = 0; ch < 4; ch++) {
        cb[ch] = out[i + ch] / 255;
        cs[ch] = src[ch] / 255;
      }
      // Source-over, as a brush lays paint: cloning transparency paints nothing.
      const o = blendPixel(blend, cb, cs, k);
      put255(out, i, o[0]);
      put255(out, i + 1, o[1]);
      put255(out, i + 2, o[2]);
      if (!s.lockTransparency) put255(out, i + 3, o[3]);
    }
  }
  return out;
}

/**
 * Dodge / Burn at 16 or 32 bits: `applyRetouchToTile`'s tone paint on a layer tile's deep samples
 * (`Uint16Array` sRGB-encoded, or `Float32Array` linear light, RGBA). The tone curves work on
 * encoded values as at 8 bits, so 32-bit samples are encoded, toned and decoded (colour above 1 is
 * toned at 1 and keeps its excess). Returns the new samples.
 */
export function applyToneToDeepTile(
  coverage: CoverageMap,
  samples: Uint16Array | Float32Array,
  tx: number,
  ty: number,
  tone: (rgb: number[]) => void,
  s: RetouchApply,
  options: { into?: Uint16Array | Float32Array; region?: RasterRect } = {}
): Uint16Array | Float32Array {
  const linear = samples instanceof Float32Array;
  const out = (options.into ?? samples).slice() as Uint16Array | Float32Array;
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
    if (options.into) for (let y = y0; y < y1; y++) out.set(samples.subarray((y * TILE + x0) * 4, (y * TILE + x1) * 4), (y * TILE + x0) * 4);
  }
  const sel = s.selection;
  const rgb = [0, 0, 0];
  const before = [0, 0, 0];
  const excess = [0, 0, 0];
  let covKey = NaN;
  let covTile: Float32Array | undefined;
  for (let y = y0; y < y1; y++) {
    const dy = oy + y;
    const cty = Math.floor(dy / TILE);
    for (let x = x0; x < x1; x++) {
      const dx = ox + x;
      const ctx = Math.floor(dx / TILE);
      const key = tileKey(ctx, cty);
      if (key !== covKey) {
        covKey = key;
        covTile = coverage.tiles.get(key);
      }
      if (!covTile) continue;
      const c = covTile[(dy - cty * TILE) * TILE + (dx - ctx * TILE)];
      if (c <= 0) continue;
      let k = c * s.opacity;
      if (sel) {
        if (dx < 0 || dy < 0 || dx >= sel.width || dy >= sel.height) continue;
        k *= sel.data[dy * sel.width + dx] / 255;
      }
      if (k > 1) k = 1;
      if (k <= 0) continue;
      const i = (y * TILE + x) * 4;
      if (out[i + 3] === 0) continue;
      for (let ch = 0; ch < 3; ch++) {
        const v = out[i + ch];
        if (linear) {
          excess[ch] = v > 1 ? v - 1 : 0;
          rgb[ch] = srgbEncode(v > 1 ? 1 : v < 0 ? 0 : v);
        } else rgb[ch] = v / 65535;
        before[ch] = rgb[ch];
      }
      tone(rgb);
      for (let ch = 0; ch < 3; ch++) {
        const e = before[ch] + (rgb[ch] - before[ch]) * k;
        if (linear) out[i + ch] = srgbDecode(e) + excess[ch];
        else out[i + ch] = e <= 0 ? 0 : e >= 1 ? 65535 : Math.round(e * 65535);
      }
    }
  }
  return out;
}

/** The tone function of a Dodge or Burn stroke. */
export function toneOf(tool: 'dodge' | 'burn', settings: Pick<RetouchSettings, 'exposure' | 'range' | 'protectTones'>): (rgb: number[]) => void {
  const burn = tool === 'burn';
  return (rgb) => {
    dodgeBurn(rgb, settings.exposure, settings.range, burn, settings.protectTones);
  };
}

// ---------------------------------------------------------------------------
// Healing
// ---------------------------------------------------------------------------

/**
 * Heals `src` into `dst` over `mask` (all `w × h`, RGBA floats 0..255): a seamless clone solved
 * only over the mask's bounds plus a one-pixel fixed ring; elsewhere the result is `dst`.
 */
export function healPixels(w: number, h: number, src: Float32Array, dst: Float32Array, mask: ArrayLike<boolean | number>): Float32Array {
  const out = new Float32Array(dst);
  const bb = maskBounds(w, h, mask);
  if (!bb) return out;
  const x0 = Math.max(0, bb[0] - 1);
  const y0 = Math.max(0, bb[1] - 1);
  const x1 = Math.min(w, bb[2] + 1);
  const y1 = Math.min(h, bb[3] + 1);
  const rw = x1 - x0;
  const rh = y1 - y0;
  const s = new Float32Array(rw * rh * 4);
  const d = new Float32Array(rw * rh * 4);
  const m = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const gi = (y + y0) * w + x + x0;
      const li = y * rw + x;
      m[li] = mask[gi] ? 1 : 0;
      for (let c = 0; c < 4; c++) {
        s[li * 4 + c] = src[gi * 4 + c];
        d[li * 4 + c] = dst[gi * 4 + c];
      }
    }
  }
  const healed = seamlessClone(rw, rh, 4, s, d, m);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const gi = ((y + y0) * w + x + x0) * 4;
      const li = (y * rw + x) * 4;
      for (let c = 0; c < 4; c++) out[gi + c] = Math.min(255, Math.max(0, healed[li + c]));
    }
  }
  return out;
}

/**
 * Spot healing: fills `hole` (`w × h`) of `img` (RGBA floats 0..255) with no given source, then
 * heals the fill into its surroundings. `proximity-match` copies the best matching nearby patch
 * (falling back to `smooth` when none fits); `smooth` interpolates the edges inwards. `size` is
 * the brush diameter in pixels. Returns the healed pixels over the whole grid.
 */
export function spotHealPixels(
  w: number,
  h: number,
  img: Float32Array,
  hole: ArrayLike<boolean | number>,
  size: number,
  type: SpotHealType,
  /** Told the patch offset it copied (`null`: a smooth fill). */
  onOffset?: (offset: [number, number] | null) => void
): Float32Array {
  // Fill a slightly larger domain than the healed area, so the solve's boundary sees filled values
  // that differ from the untouched pixels: that mismatch is what the membrane corrects.
  const domain = dilateMask(w, h, hole, 2);
  const healMask = dilateMask(w, h, hole, 1);
  let filled: Float32Array | null = null;
  let bestFound: [number, number] | null = null;
  if (type === 'proximity-match') {
    const ring = Math.min(16, Math.max(3, Math.floor(size / 8)));
    const off = bestOffset(w, h, 4, img, domain, ring, Math.floor(Math.max(w, h) / 2));
    if (off) {
      bestFound = off;
      // Copy from the pre-healing pixels, never from what this loop already wrote.
      filled = new Float32Array(img);
      const [ddx, ddy] = off;
      for (let i = 0; i < w * h; i++) {
        if (!domain[i]) continue;
        const x = (i % w) + ddx;
        const y = Math.floor(i / w) + ddy;
        const j = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) filled[i * 4 + c] = img[j + c];
      }
    }
  }
  onOffset?.(filled ? (bestFound as [number, number]) : null);
  // Content-aware: texture and edges synthesised from patches all around (PatchMatch).
  if (!filled && type === 'content-aware') filled = contentAwareFill(w, h, 4, img, domain);
  if (!filled) filled = membraneFill(w, h, 4, img, domain);
  return healPixels(w, h, filled, img, healMask);
}

/** The window a Spot Healing stroke over `bounds` looks for texture in: the bounds grown by their size, on the canvas. */
export function spotHealWindow(bounds: RasterRect, canvas: { width: number; height: number }): RasterRect {
  const g = Math.max(8, Math.ceil(Math.max(bounds.width, bounds.height)));
  const x0 = Math.max(0, bounds.x - g);
  const y0 = Math.max(0, bounds.y - g);
  const x1 = Math.min(canvas.width, bounds.x + bounds.width + g);
  const y1 = Math.min(canvas.height, bounds.y + bounds.height + g);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

// ---------------------------------------------------------------------------
// Sequential dabs
// ---------------------------------------------------------------------------

/**
 * One dab of a sequential retouching stroke: `cov` is the tip's pure coverage over `rect`
 * (document space, 0..1); `d.alpha` is the flow and `d.opacity` the pressure opacity.
 */
export type RetouchDabEffect = (medium: TileMedium, d: Dab, rect: RasterRect, cov: Float32Array) => void;

/**
 * A stroke whose dabs edit live tiles in order (Smudge, Sponge). Feed points with `push` (any
 * chunks give the same dabs), end with `finish`; each returns the document rectangles it touched.
 */
export class RetouchDabStroke {
  dabCount = 0;
  bounds: RasterRect | null = null;
  private readonly walker: DabWalker;
  private readonly medium: TileMedium;
  private smoothPos: StrokePoint | null = null;
  private buf = new Float32Array(0);

  constructor(
    readonly brush: BrushSettings,
    target: PaintTileTarget,
    private readonly effect: RetouchDabEffect
  ) {
    this.walker = new DabWalker(brush);
    this.medium = new TileMedium(target);
  }

  push(points: readonly StrokePoint[]): RasterRect[] {
    const dabs: Dab[] = [];
    for (const p of points) this.walker.push(this.smooth(p), dabs);
    return this.paint(dabs);
  }

  finish(last?: StrokePoint): RasterRect[] {
    const dabs: Dab[] = [];
    if (last && this.smoothPos && (this.smoothPos.x !== last.x || this.smoothPos.y !== last.y)) this.walker.push(last, dabs);
    this.walker.finish(dabs);
    return this.paint(dabs);
  }

  private smooth(p: StrokePoint): StrokePoint {
    const a = 1 - Math.min(0.95, Math.max(0, this.brush.smoothing));
    const cur = this.smoothPos;
    const n = cur && a < 1 ? { ...p, x: cur.x + (p.x - cur.x) * a, y: cur.y + (p.y - cur.y) * a } : p;
    this.smoothPos = n;
    return n;
  }

  private paint(dabs: Dab[]): RasterRect[] {
    const rects: RasterRect[] = [];
    for (const d of dabs) {
      const rect = dabRect(d, this.brush.hardness);
      const n = rect.width * rect.height;
      if (this.buf.length < n) this.buf = new Float32Array(n);
      const cov = this.buf.subarray(0, n);
      rasterizeDab({ ...d, alpha: 1 }, this.brush.hardness, rect, cov);
      this.medium.reset();
      this.effect(this.medium, d, rect, cov);
      rects.push(rect);
      this.bounds = unionRect(this.bounds, rect);
      this.dabCount++;
    }
    return rects;
  }
}

/** The Smudge's per-dab effect: a `SmudgeTip` whose strength carries and lays the paint. */
export function smudgeEffect(brush: BrushSettings, strength: number, mixing: SmudgeSettings['mixing'] = 'rgb'): RetouchDabEffect {
  const s = Math.min(1, Math.max(0, strength));
  const tip = new SmudgeTip({ strength: s, length: s, mixing }, brush.size);
  return (medium, d, rect, cov) => tip.dab(medium, { x: d.x, y: d.y, radius: d.radius, opacity: d.opacity * d.alpha }, rect, cov);
}

/** The Sponge's per-dab effect: each dab moves saturation by about half its flow, compounding over passes. */
export function spongeEffect(brush: BrushSettings, saturate: boolean, vibrance: boolean): RetouchDabEffect {
  const rgb = [0, 0, 0];
  return (medium, d, rect, cov) => {
    const w = rect.width;
    for (let yy = 0; yy < rect.height; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const cv = cov[yy * w + xx];
        if (cv <= 0) continue;
        const dx = rect.x + xx;
        const dy = rect.y + yy;
        const k = perDabStrength(cv * d.alpha * d.opacity * 0.5, brush.spacing) * medium.selectionAt(dx, dy);
        if (k <= 0) continue;
        const ri = medium.locate(dx, dy, false);
        if (ri < 0 || medium.pixels[ri + 3] === 0) continue;
        const i = medium.locate(dx, dy, true);
        const px = medium.pixels;
        rgb[0] = px[i] / 255;
        rgb[1] = px[i + 1] / 255;
        rgb[2] = px[i + 2] / 255;
        sponge(rgb, k, saturate, vibrance);
        put255(px, i, rgb[0]);
        put255(px, i + 1, rgb[1]);
        put255(px, i + 2, rgb[2]);
      }
    }
  };
}

/**
 * An RGBA view of one-channel tiles (masks), for the sequential-dab tools: reads expand grey to
 * opaque RGB, writes land in RGBA copies, and `flush` writes their red channel back through
 * `target.writeTile`. Alpha is locked, so a mask's values are all a dab changes.
 */
export function rgbaViewOfGrey(target: PaintTileTarget): { target: PaintTileTarget; flush(): void } {
  const views = new Map<number, Uint8ClampedArray>();
  const dirty = new Map<number, { tx: number; ty: number; data: Uint8ClampedArray }>();
  const expand = (g: Uint8ClampedArray) => {
    const out = new Uint8ClampedArray(g.length * 4);
    for (let i = 0; i < g.length; i++) {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g[i];
      out[i * 4 + 3] = 255;
    }
    return out;
  };
  const view: PaintTileTarget = {
    offset: target.offset,
    lockTransparency: true,
    selection: target.selection,
    readTile: (tx, ty) => {
      const key = tileKey(tx, ty);
      let v = views.get(key);
      if (!v) {
        // An empty mask tile is still values (0), not transparency: always give a tile.
        v = expand((target.readTile(tx, ty) as Uint8ClampedArray | null) ?? new Uint8ClampedArray(TILE * TILE));
        views.set(key, v);
      }
      return v;
    },
    writeTile: (tx, ty) => {
      const key = tileKey(tx, ty);
      let v = views.get(key);
      if (!v) {
        v = expand((target.readTile(tx, ty) as Uint8ClampedArray | null) ?? new Uint8ClampedArray(TILE * TILE));
        views.set(key, v);
      }
      dirty.set(key, { tx, ty, data: v });
      return v;
    },
  };
  return {
    target: view,
    flush: () => {
      for (const { tx, ty, data } of dirty.values()) {
        const g = target.writeTile(tx, ty);
        for (let i = 0; i < g.length; i++) g[i] = data[i * 4];
      }
      dirty.clear();
    },
  };
}

function unionRect(a: RasterRect | null, b: RasterRect): RasterRect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
