// Portions ported from photocraft-main/crates/compose/src/adjust.rs, photocraft-main/crates/doc/src/adjust.rs and photocraft-main/crates/color/src/convert.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import type {
  AdjustmentKind,
  AdjustmentLayer,
  AdjustmentLayerMask,
  AdjustmentLayerOf,
  AdjustmentParamsMap,
  BlackWhiteParams,
  ColorBalanceParams,
  ColorBalanceTone,
  CurvePoint,
  HueRange,
  HueSaturationParams,
  LevelsChannel,
  PhotoFilterParams,
  VibranceParams,
} from './types';
import { type BlendMode, blendRgb, normalizeBlendMode, setLum } from './blend';
import { linearToSrgb, srgbToLinear } from './color';
import { layerMaskKey, normalizeLayerMask } from './selection/layer-mask';

/**
 * Adjustment layers: Photoshop-matching evaluation on encoded sRGB colours in 0..1.
 *
 * Every layer is compiled once per parameter change into a per-pixel function (per-channel kinds
 * into three 4096-entry LUTs); {@link applyAdjustmentLayers} runs the stack on an ImageData.
 */

type Rgb = [number, number, number];

/** Entries in a tone LUT (curves, levels, colour balance). */
export const ADJUSTMENT_LUT_SIZE = 4096;

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);
const finite = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clampTo = (v: unknown, lo: number, hi: number, fallback: number) => Math.min(hi, Math.max(lo, finite(v, fallback)));
const remEuclid = (a: number, b: number) => ((a % b) + b) % b;

/** Linear interpolation into a 0..1-domain LUT. */
export function sampleLut(table: ArrayLike<number>, v: number): number {
  const n = table.length - 1;
  const x = clamp01(v) * n;
  const i = Math.floor(x);
  const j = Math.min(i + 1, n);
  const f = x - i;
  return table[i] * (1 - f) + table[j] * f;
}

// ---------------------------------------------------------------------------
// Kinds, labels, defaults
// ---------------------------------------------------------------------------

export interface AdjustmentKindInfo {
  kind: AdjustmentKind;
  label: string;
}

export const ADJUSTMENT_KINDS: readonly AdjustmentKindInfo[] = [
  { kind: 'curves', label: 'Curves' },
  { kind: 'levels', label: 'Levels' },
  { kind: 'hueSaturation', label: 'Hue/Saturation' },
  { kind: 'vibrance', label: 'Vibrance' },
  { kind: 'colorBalance', label: 'Color Balance' },
  { kind: 'blackWhite', label: 'Black & White' },
  { kind: 'photoFilter', label: 'Photo Filter' },
  { kind: 'invert', label: 'Invert' },
  { kind: 'posterize', label: 'Posterize' },
  { kind: 'threshold', label: 'Threshold' },
];

const KIND_LABELS = new Map(ADJUSTMENT_KINDS.map((k) => [k.kind, k.label]));

export function isAdjustmentKind(value: unknown): value is AdjustmentKind {
  return typeof value === 'string' && KIND_LABELS.has(value as AdjustmentKind);
}

export function adjustmentKindLabel(kind: AdjustmentKind): string {
  return KIND_LABELS.get(kind) ?? kind;
}

export const HUE_RANGE_LABELS = ['Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas'] as const;

/** The neutral range `i` (0 reds … 5 magentas): fully on for 30° around its centre, fading over 30° each side. */
export function neutralHueRange(i: number): HueRange {
  const c = 60 * i;
  return { hue: 0, saturation: 0, lightness: 0, bounds: [c - 45, c - 15, c + 15, c + 45] };
}

export const identityCurve = (): CurvePoint[] => [
  { input: 0, output: 0 },
  { input: 255, output: 255 },
];

export const identityLevels = (): LevelsChannel => ({ inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 });

/** Neutral parameters of every kind (fresh objects on every call). */
export function defaultAdjustmentParams<K extends AdjustmentKind>(kind: K): AdjustmentParamsMap[K] {
  const defaults: { [P in AdjustmentKind]: () => AdjustmentParamsMap[P] } = {
    curves: () => ({ master: identityCurve(), red: identityCurve(), green: identityCurve(), blue: identityCurve() }),
    levels: () => ({ master: identityLevels(), red: identityLevels(), green: identityLevels(), blue: identityLevels() }),
    hueSaturation: () => ({
      hue: 0,
      saturation: 0,
      lightness: 0,
      colorize: false,
      ranges: [0, 1, 2, 3, 4, 5].map(neutralHueRange),
    }),
    vibrance: () => ({ vibrance: 0, saturation: 0 }),
    colorBalance: () => ({ shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true }),
    blackWhite: () => ({ reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: null }),
    invert: () => ({}) as Record<string, never>,
    posterize: () => ({ levels: 4 }),
    threshold: () => ({ level: 128 }),
    photoFilter: () => ({ color: '#ec8a00', density: 25, preserveLuminosity: true }),
  };
  return defaults[kind]() as AdjustmentParamsMap[K];
}

let layerCounter = 0;

/** A new layer of `kind` with neutral (or the given) parameters, enabled, opacity 1, normal blend. */
export function createAdjustmentLayer<K extends AdjustmentKind>(
  kind: K,
  options: {
    id?: string;
    name?: string;
    params?: Partial<AdjustmentParamsMap[K]>;
    enabled?: boolean;
    opacity?: number;
    blend?: BlendMode;
    mask?: AdjustmentLayerMask;
  } = {}
): AdjustmentLayerOf<K> {
  const raw = {
    id: options.id ?? `adj_${Date.now().toString(36)}_${(++layerCounter).toString(36)}`,
    kind,
    name: options.name,
    params: { ...defaultAdjustmentParams(kind), ...(options.params ?? {}) },
    enabled: options.enabled ?? true,
    opacity: options.opacity ?? 1,
    blend: options.blend ?? 'normal',
    mask: options.mask,
  };
  return normalizeAdjustmentLayer(raw) as AdjustmentLayerOf<K>;
}

// ---------------------------------------------------------------------------
// Normalisation of stored layers
// ---------------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i;

function normCurve(points: unknown): CurvePoint[] {
  if (!Array.isArray(points)) return identityCurve();
  const out = points
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({ input: clampTo(p.input, 0, 255, 0), output: clampTo(p.output, 0, 255, 0) }))
    .sort((a, b) => a.input - b.input);
  return out.length >= 2 ? out : identityCurve();
}

function normLevels(ch: unknown): LevelsChannel {
  const c = (ch && typeof ch === 'object' ? ch : {}) as Partial<LevelsChannel>;
  return {
    inBlack: clampTo(c.inBlack, 0, 254, 0),
    inWhite: clampTo(c.inWhite, 1, 255, 255),
    gamma: clampTo(c.gamma, 0.1, 9.99, 1),
    outBlack: clampTo(c.outBlack, 0, 255, 0),
    outWhite: clampTo(c.outWhite, 0, 255, 255),
  };
}

function normTone(t: unknown): ColorBalanceTone {
  const a = Array.isArray(t) ? t : [];
  return [clampTo(a[0], -100, 100, 0), clampTo(a[1], -100, 100, 0), clampTo(a[2], -100, 100, 0)];
}

function normParams(kind: AdjustmentKind, raw: unknown): AdjustmentParamsMap[AdjustmentKind] {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const d = defaultAdjustmentParams(kind) as Record<string, any>;
  switch (kind) {
    case 'curves':
      return { master: normCurve(p.master), red: normCurve(p.red), green: normCurve(p.green), blue: normCurve(p.blue) };
    case 'levels':
      return { master: normLevels(p.master), red: normLevels(p.red), green: normLevels(p.green), blue: normLevels(p.blue) };
    case 'hueSaturation': {
      const ranges: HueRange[] = [0, 1, 2, 3, 4, 5].map((i) => {
        const r = Array.isArray(p.ranges) && p.ranges[i] && typeof p.ranges[i] === 'object' ? p.ranges[i] : {};
        const n = neutralHueRange(i);
        const b = Array.isArray(r.bounds) && r.bounds.length === 4 && r.bounds.every((v: unknown) => Number.isFinite(v)) ? r.bounds : n.bounds;
        return {
          hue: clampTo(r.hue, -180, 180, 0),
          saturation: clampTo(r.saturation, -100, 100, 0),
          lightness: clampTo(r.lightness, -100, 100, 0),
          bounds: [b[0], b[1], b[2], b[3]] as [number, number, number, number],
        };
      });
      const colorize = p.colorize === true;
      return {
        hue: colorize ? clampTo(p.hue, 0, 360, 0) : clampTo(p.hue, -180, 180, 0),
        saturation: clampTo(p.saturation, -100, 100, 0),
        lightness: clampTo(p.lightness, -100, 100, 0),
        colorize,
        ranges,
      } satisfies HueSaturationParams;
    }
    case 'vibrance':
      return { vibrance: clampTo(p.vibrance, -100, 100, 0), saturation: clampTo(p.saturation, -100, 100, 0) } satisfies VibranceParams;
    case 'colorBalance':
      return {
        shadows: normTone(p.shadows),
        midtones: normTone(p.midtones),
        highlights: normTone(p.highlights),
        preserveLuminosity: p.preserveLuminosity !== false,
      } satisfies ColorBalanceParams;
    case 'blackWhite': {
      const out = {} as BlackWhiteParams;
      for (const k of ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'] as const) out[k] = clampTo(p[k], -200, 300, d[k]);
      out.tint = typeof p.tint === 'string' && HEX.test(p.tint) ? p.tint.toLowerCase() : null;
      return out;
    }
    case 'photoFilter':
      return {
        color: typeof p.color === 'string' && HEX.test(p.color) ? p.color.toLowerCase() : d.color,
        density: clampTo(p.density, 0, 100, d.density),
        preserveLuminosity: p.preserveLuminosity !== false,
      } satisfies PhotoFilterParams;
    case 'posterize':
      return { levels: Math.round(clampTo(p.levels, 2, 255, 4)) };
    case 'threshold':
      return { level: Math.round(clampTo(p.level, 1, 255, 128)) };
    case 'invert':
      return {} as Record<string, never>;
  }
}

/**
 * A clean, deep-copied layer from stored or hand-written data: missing fields get neutral
 * defaults, numbers are clamped to their ranges. `null` for an unknown kind.
 */
export function normalizeAdjustmentLayer(raw: unknown): AdjustmentLayer | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  if (!isAdjustmentKind(r.kind)) return null;
  const layer: Record<string, unknown> = {
    id: typeof r.id === 'string' && r.id ? r.id : `adj_${Date.now().toString(36)}_${(++layerCounter).toString(36)}`,
    kind: r.kind,
    enabled: r.enabled !== false,
    opacity: clampTo(r.opacity, 0, 1, 1),
    blend: normalizeBlendMode(r.blend),
    params: normParams(r.kind, r.params),
  };
  if (typeof r.name === 'string' && r.name) layer.name = r.name;
  // Only present when the layer has a usable mask, so mask-free layers serialize as before.
  const mask = normalizeLayerMask(r.mask);
  if (mask) layer.mask = mask;
  return layer as unknown as AdjustmentLayer;
}

/** Normalises a stored layer list (drops unknown kinds, de-duplicates ids). */
export function normalizeAdjustmentLayers(raw: unknown): AdjustmentLayer[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: AdjustmentLayer[] = [];
  for (const item of raw) {
    const layer = normalizeAdjustmentLayer(item);
    if (!layer) continue;
    while (seen.has(layer.id)) layer.id = `${layer.id}_${(++layerCounter).toString(36)}`;
    seen.add(layer.id);
    out.push(layer);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/**
 * Photoshop curve: a natural cubic spline through the points (0..1 in and out; it may overshoot
 * between points, as Photoshop's does), constant outside the first / last point, clamped to
 * 0..1, sampled into a LUT. Fewer than two distinct points: the identity.
 */
export function curveLut(points: ReadonlyArray<{ input: number; output: number }>, size = ADJUSTMENT_LUT_SIZE): Float32Array {
  const pts = points
    .filter((p) => Number.isFinite(p.input) && Number.isFinite(p.output))
    .map((p) => [p.input, p.output] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const dedup: [number, number][] = [];
  for (const p of pts) {
    if (dedup.length && Math.abs(dedup[dedup.length - 1][0] - p[0]) < 1e-6) continue;
    dedup.push(p);
  }
  const out = new Float32Array(size);
  const n = dedup.length;
  if (n < 2) {
    for (let k = 0; k < size; k++) out[k] = k / (size - 1);
    return out;
  }
  const x = dedup.map((p) => p[0]);
  const y = dedup.map((p) => p[1]);
  // Second derivatives of the natural spline (tridiagonal solve).
  const m2 = new Float64Array(n);
  if (n > 2) {
    const c = new Float64Array(n);
    const d = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) {
      const h0 = x[i] - x[i - 1];
      const h1 = x[i + 1] - x[i];
      const a = h0 / 6;
      const b = (h0 + h1) / 3;
      const cc = h1 / 6;
      const r = (y[i + 1] - y[i]) / h1 - (y[i] - y[i - 1]) / h0;
      const denom = b - a * c[i - 1];
      c[i] = cc / denom;
      d[i] = (r - a * d[i - 1]) / denom;
    }
    for (let i = n - 2; i >= 1; i--) m2[i] = d[i] - c[i] * m2[i + 1];
  }
  let seg = 0;
  for (let k = 0; k < size; k++) {
    const xv = k / (size - 1);
    if (xv <= x[0]) {
      out[k] = clamp01(y[0]);
      continue;
    }
    if (xv >= x[n - 1]) {
      out[k] = clamp01(y[n - 1]);
      continue;
    }
    while (seg < n - 2 && xv > x[seg + 1]) seg++;
    const x0 = x[seg], x1 = x[seg + 1];
    const h = x1 - x0;
    const a = (x1 - xv) / h;
    const b = (xv - x0) / h;
    const v = a * y[seg] + b * y[seg + 1] + ((a * a * a - a) * m2[seg] + (b * b * b - b) * m2[seg + 1]) * (h * h) / 6;
    out[k] = clamp01(v);
  }
  return out;
}

/** {@link curveLut} for Curves points in levels (0..255). */
export function curveLutFromLevels(points: readonly CurvePoint[]): Float32Array {
  return curveLut(points.map((p) => ({ input: p.input / 255, output: p.output / 255 })));
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

/** A Levels record with values in 0..1 (as `levelsValue` takes them). */
export interface UnitLevels {
  inBlack: number;
  inWhite: number;
  gamma: number;
  outBlack: number;
  outWhite: number;
}

const toUnitLevels = (c: LevelsChannel): UnitLevels => ({
  inBlack: c.inBlack / 255,
  inWhite: c.inWhite / 255,
  gamma: c.gamma,
  outBlack: c.outBlack / 255,
  outWhite: c.outWhite / 255,
});

/**
 * One Levels record on `v` (0..1). With `quantum` (8-bit: 255) Photoshop works on whole levels:
 * the input is a level and the stretch is rounded (half up) before the gamma. A gamma above 1 has
 * Photoshop's soft shadow toe: a p-norm soft-min of the power curve and a line of slope ≈ 2^gamma.
 */
export function levelsValue(ch: UnitLevels, v: number, quantum?: number): number {
  const range = Math.max(1e-6, ch.inWhite - ch.inBlack);
  let u: number;
  if (quantum !== undefined && Number.isFinite(quantum) && quantum >= 1) {
    const q = quantum;
    const vq = Math.round(v * q) / q;
    u = Math.floor(clamp01((vq - ch.inBlack) / range) * q + 0.5 + 1e-3) / q;
  } else {
    u = clamp01((v - ch.inBlack) / range);
  }
  const g = Math.max(0.01, ch.gamma);
  let t: number;
  if (g > 1) {
    const power = Math.pow(u, 1 / g);
    const line = 0.93 * Math.pow(2, g) * u;
    if (power <= 1e-6 || line <= 1e-6) t = Math.min(power, line);
    else {
      const p = 10;
      t = Math.pow(Math.pow(power, -p) + Math.pow(line, -p), -1 / p);
    }
  } else {
    t = Math.pow(u, 1 / g);
  }
  return ch.outBlack + t * (ch.outWhite - ch.outBlack);
}

// ---------------------------------------------------------------------------
// HSL and Hue/Saturation
// ---------------------------------------------------------------------------

/** RGB (0..1) → HSL with hue in turns (0..1). */
export function rgbToHsl(c: readonly number[]): [number, number, number] {
  const max = Math.max(c[0], c[1], c[2]);
  const min = Math.min(c[0], c[1], c[2]);
  const l = (max + min) / 2;
  if (Math.abs(max - min) < 1e-7) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === c[0]) h = remEuclid((c[1] - c[2]) / d, 6);
  else if (max === c[1]) h = (c[2] - c[0]) / d + 2;
  else h = (c[0] - c[1]) / d + 4;
  return [h / 6, s, l];
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s <= 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = remEuclid(t, 1);
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 0.5) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

/** How much a pixel of hue `deg` belongs to `range` (0..1): a trapezoid that may wrap past 0/360. */
export function hueRangeWeight(range: Pick<HueRange, 'bounds'>, deg: number): number {
  const [a, b0, c0, d0] = range.bounds;
  const rel = (x: number) => (Number.isFinite(x) && Number.isFinite(a) ? remEuclid(x - a, 360) : 0);
  const b = rel(b0);
  const c = Math.max(rel(c0), b);
  const d = Math.max(rel(d0), c);
  const h = rel(deg);
  if (h <= b) return b <= 0 ? 1 : h / b;
  if (h <= c) return 1;
  if (h <= d) return d <= c ? 1 : (d - h) / (d - c);
  return 0;
}

const isNeutralRange = (r: HueRange) => r.hue === 0 && r.saturation === 0 && r.lightness === 0;

/** Range edits as three hue-indexed tables (hue shift in degrees, saturation and lightness as fractions). */
export function hueRangeTables(ranges: readonly HueRange[]): [Float32Array, Float32Array, Float32Array] {
  const n = ADJUSTMENT_LUT_SIZE;
  const t: [Float32Array, Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const active = ranges.filter((r) => !isNeutralRange(r));
  for (let k = 0; k < n; k++) {
    const deg = (k / (n - 1)) * 360;
    for (const r of active) {
      const w = hueRangeWeight(r, deg);
      t[0][k] += w * r.hue;
      t[1][k] += (w * r.saturation) / 100;
      t[2][k] += (w * r.lightness) / 100;
    }
  }
  return t;
}

/**
 * One Hue/Saturation evaluation: hue shift in degrees, saturation and lightness in -1..1.
 * Lightness first, then hue and saturation (raising divides by 1 − s, lowering multiplies by
 * 1 + s). Colorize sets hue and saturation at the lightened lightness.
 */
export function hueSaturation(c: readonly number[], hue: number, s: number, l: number, colorize: boolean): Rgb {
  const lighten = (v: number) => (l > 0 ? v + (1 - v) * l : v * (1 + l));
  if (colorize) {
    const ll = rgbToHsl(c)[2];
    return hslToRgb(remEuclid(hue, 360) / 360, Math.min(1, Math.abs(s)), lighten(ll));
  }
  const [hh0, ss0, ll] = rgbToHsl([lighten(c[0]), lighten(c[1]), lighten(c[2])]);
  const hh = remEuclid(hh0 + hue / 360, 1);
  const ss = Math.min(1, Math.max(0, s > 0 ? ss0 / Math.max(1 / 512, 1 - s) : ss0 * (1 + s)));
  return hslToRgb(hh, ss, ll);
}

/** A colour range's Lightness: towards the brightest channel when raised, the darkest when lowered. */
export function rangeLightness(c: readonly number[], l: number): Rgb {
  const k = Math.min(1, Math.max(-1, l));
  const target = k > 0 ? Math.max(c[0], c[1], c[2]) : Math.min(c[0], c[1], c[2]);
  const a = Math.abs(k);
  return [c[0] + (target - c[0]) * a, c[1] + (target - c[1]) * a, c[2] + (target - c[2]) * a];
}

// ---------------------------------------------------------------------------
// Vibrance
// ---------------------------------------------------------------------------

/** Grey Vibrance › Saturation desaturates to (linear light; blue has no weight). */
export const VIBRANCE_GREY: readonly [number, number] = [0.288, 0.712];
const VIBRANCE_BOOST = [0.5001, 0.0887, 0.4374, 0.7573, -0.8113, 0.5154, 2.8026] as const;

function vibranceSkin(h: number): number {
  if (h <= 30) return 1;
  if (h < 45) return (45 - h) / 15;
  if (h < 300) return 0;
  return (h - 300) / 60;
}

function hsvHue(c: readonly number[], mx: number, mn: number): number {
  const d = mx - mn;
  let h: number;
  if (mx === c[0]) h = remEuclid((c[1] - c[2]) / d, 6);
  else if (mx === c[1]) h = (c[2] - c[0]) / d + 2;
  else h = (c[0] - c[1]) / d + 4;
  return h * 60;
}

/** The Vibrance slider (`v` in -1..1) on a linear-light pixel: an HSV change that keeps the hue. */
export function vibranceLinear(c: Rgb, v: number): Rgb {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  if (mx <= 0 || mx - mn <= 1e-9) return c;
  const t = 1 - mn / mx;
  const shape = t * (1 - t) * (2 - t + t * t) * mx * Math.max(0, 1 - mx);
  let t2: number, v2: number;
  if (v < 0) {
    const a = -v;
    t2 = t * (1 - a / 4) * (1 - a + (a * t * (1 + t)) / 2);
    v2 = mx - a * shape;
  } else {
    const [c0, c1, p, q, r0, ra, rt] = VIBRANCE_BOOST;
    const w = vibranceSkin(hsvHue(c, mx, mn));
    const a = v * (1 - w) + 0.64 * Math.pow(v, 1.6) * w;
    const boost =
      (c0 * a + c1 * a * a) * Math.pow(t, p) * Math.pow(1 - t, q) * Math.exp((r0 + ra * a + rt * (1 - t)) * Math.max(0, 1 - mx));
    t2 = Math.min(1, t * (1 + boost));
    v2 = mx + (v / 4) * shape;
  }
  const m2 = v2 * (1 - t2);
  const k = (v2 - m2) / (mx - mn);
  return [m2 + (c[0] - mn) * k, m2 + (c[1] - mn) * k, m2 + (c[2] - mn) * k];
}

/** Photoshop's Vibrance on one encoded sRGB pixel (`v`, `s`: the sliders / 100). */
export function vibrancePixel(c: readonly number[], v: number, s: number): Rgb {
  let l: Rgb = [srgbToLinear(Math.max(0, c[0])), srgbToLinear(Math.max(0, c[1])), srgbToLinear(Math.max(0, c[2]))];
  if (v !== 0) l = vibranceLinear(l, v);
  if (s !== 0) {
    const g = VIBRANCE_GREY[0] * l[0] + VIBRANCE_GREY[1] * l[1];
    l = l.map((x) => Math.min(1, Math.max(0, g + (1 + s) * (x - g)))) as Rgb;
  }
  return l.map((x) => linearToSrgb(clamp01(x))) as Rgb;
}

// ---------------------------------------------------------------------------
// Color Balance
// ---------------------------------------------------------------------------

/** How far one Color Balance slider at ±100 moves the black or white point. */
const BALANCE_LEVELS = 0.39;

/**
 * Color Balance on channel `ch` (0 red, 1 green, 2 blue) of `v` (0..1); `tones` are the
 * shadows, midtones and highlights slider triples (-100..100). Highlights, shadows, then midtones.
 */
export function colorBalanceChannel(
  tones: readonly [readonly number[], readonly number[], readonly number[]],
  preserveLuminosity: boolean,
  ch: number,
  v: number
): number {
  const [shadows, midtones, highlights] = tones;
  const black = (x: number, b: number) => Math.max(0, (x - b) / (1 - b));
  const white = (x: number, w: number) => Math.min(1, x / w);
  let out = clamp01(v);
  for (const [tone, sliders] of [
    [2, highlights],
    [0, shadows],
    [1, midtones],
  ] as const) {
    const a = [0, 1, 2].map((i) => Math.min(1, Math.max(-1, sliders[i] / 100)));
    if (preserveLuminosity) {
      const own = a[ch] ?? 0;
      const lo = Math.min(a[0], a[1], a[2]);
      const hi = Math.max(a[0], a[1], a[2]);
      if (tone === 0) out = black(out, BALANCE_LEVELS * (hi - own));
      else if (tone === 1) out = Math.pow(out, Math.pow(2, (hi + lo) / 2 - own));
      else out = white(out, 1 - BALANCE_LEVELS * (own - lo));
      continue;
    }
    const s = a[ch];
    if (s === 0) continue;
    if (tone === 1) out = Math.pow(out, Math.pow(2, -s));
    else if (tone === 0 && s < 0) out = Math.pow(black(out, BALANCE_LEVELS * -s), Math.pow(2, -s / 2));
    else if (tone === 2 && s > 0) out = Math.pow(white(out, 1 - BALANCE_LEVELS * s), Math.pow(2, -s / 2));
    else out = Math.pow(out, Math.pow(2, -s / 2));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Black & White, Photo Filter, Posterize, Threshold
// ---------------------------------------------------------------------------

/**
 * Black & White grey: the smallest channel, plus the secondary part (middle − smallest) and the
 * primary part (largest − middle) weighted by the sliders (percent: reds, yellows, greens, cyans,
 * blues, magentas).
 */
export function blackWhiteGray(c: readonly number[], weights: readonly number[]): number {
  const [r, g, b] = c;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const mid = r + g + b - max - min;
  const primary = r >= g && r >= b ? 0 : g >= b ? 2 : 4;
  const secondary = b <= r && b <= g ? 1 : r <= g ? 3 : 5;
  return clamp01(min + ((mid - min) * weights[secondary]) / 100 + ((max - mid) * weights[primary]) / 100);
}

/** D50 white (ICC PCS). */
const D50 = [0.96422, 1.0, 0.82521] as const;
/** Linear sRGB → D50 XYZ (Bradford-adapted, as in the ICC sRGB profile). */
const SRGB_TO_XYZ_D50 = [
  [0.436074, 0.385064, 0.14308],
  [0.222504, 0.716878, 0.060618],
  [0.013932, 0.097104, 0.714173],
] as const;
/** D50 XYZ → linear sRGB. */
const XYZ_D50_TO_SRGB = [
  [3.133856, -1.616867, -0.490615],
  [-0.978768, 1.916142, 0.033454],
  [0.071945, -0.228991, 1.405243],
] as const;

/**
 * Photo Filter's linear-light RGB matrix (row-major 3×3): the pixel's D50 XYZ, relative to white,
 * multiplied by the filter colour's mixed in by `density` (0..1). `normalizeY` keeps luminance Y.
 */
export function photoFilterMatrix(color: readonly number[], density: number, normalizeY = false): number[][] {
  const d = Number.isFinite(density) ? clamp01(density) : 0;
  const lin = [0, 1, 2].map((i) => srgbToLinear(clamp01(color[i])));
  const xyz = SRGB_TO_XYZ_D50.map((r) => r[0] * lin[0] + r[1] * lin[1] + r[2] * lin[2]);
  let s = [0, 1, 2].map((i) => 1 - d + (d * xyz[i]) / D50[i]);
  if (normalizeY && s[1] > 1e-6) {
    const y = s[1];
    s = s.map((v) => v / y);
  }
  return [0, 1, 2].map((r) =>
    [0, 1, 2].map((c) => XYZ_D50_TO_SRGB[r][0] * s[0] * SRGB_TO_XYZ_D50[0][c] + XYZ_D50_TO_SRGB[r][1] * s[1] * SRGB_TO_XYZ_D50[1][c] + XYZ_D50_TO_SRGB[r][2] * s[2] * SRGB_TO_XYZ_D50[2][c])
  );
}

/** Photoshop posterize: `levels` equal input bins over 0..255, outputs `floor(k·255 / (levels − 1))`. */
export function posterizeValue(v: number, levels: number): number {
  const n = Math.min(255, Math.max(2, Math.round(levels)));
  const x = Math.round(clamp01(v) * 255);
  const bin = Math.min(n - 1, Math.floor((x * n) / 256));
  return Math.floor((bin * 255) / (n - 1)) / 255;
}

/** Rec.601 luma (Photoshop's grey for Threshold). */
export const rgbToGray = (c: readonly number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/** `#rrggbb` → 0..1 RGB (black for anything else). */
export function hexToRgb(hex: string): Rgb {
  if (!HEX.test(hex)) return [0, 0, 0];
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ---------------------------------------------------------------------------
// Compilation and evaluation
// ---------------------------------------------------------------------------

/** Mutates an encoded sRGB colour (0..1) in place. */
export type PixelOp = (c: Rgb) => void;

function lutOp(luts: [Float32Array, Float32Array, Float32Array]): PixelOp {
  const [lr, lg, lb] = luts;
  return (c) => {
    c[0] = sampleLut(lr, c[0]);
    c[1] = sampleLut(lg, c[1]);
    c[2] = sampleLut(lb, c[2]);
  };
}

const isIdentityCurve = (pts: readonly CurvePoint[]) =>
  pts.length === 2 && pts[0].input === 0 && pts[0].output === 0 && pts[1].input === 255 && pts[1].output === 255;

const isIdentityLevels = (c: LevelsChannel) =>
  c.inBlack === 0 && c.inWhite === 255 && c.gamma === 1 && c.outBlack === 0 && c.outWhite === 255;

/** Quantum Levels works in (8-bit documents: whole levels). */
const LEVELS_QUANTUM = 255;

/**
 * Per-channel LUTs of a Curves or Levels layer: each channel's record first, then the master.
 * `null` for any other kind.
 */
export function toneLuts(layer: AdjustmentLayer): [Float32Array, Float32Array, Float32Array] | null {
  const n = ADJUSTMENT_LUT_SIZE;
  if (layer.kind === 'curves') {
    const m = curveLutFromLevels(layer.params.master);
    return [layer.params.red, layer.params.green, layer.params.blue].map((pts) => {
      const ch = curveLutFromLevels(pts);
      for (let k = 0; k < n; k++) ch[k] = sampleLut(m, ch[k]);
      return ch;
    }) as [Float32Array, Float32Array, Float32Array];
  }
  if (layer.kind === 'levels') {
    const m = toUnitLevels(layer.params.master);
    return [layer.params.red, layer.params.green, layer.params.blue].map((rec) => {
      const c = toUnitLevels(rec);
      const out = new Float32Array(n);
      for (let k = 0; k < n; k++) out[k] = levelsValue(m, levelsValue(c, k / (n - 1), LEVELS_QUANTUM), LEVELS_QUANTUM);
      return out;
    }) as [Float32Array, Float32Array, Float32Array];
  }
  return null;
}

/**
 * Compiles a layer into a pixel function, or `null` when it is the identity (neutral parameters).
 * Pure: depends on `kind` and `params` only.
 */
export function compileAdjustmentLayer(layer: AdjustmentLayer): PixelOp | null {
  switch (layer.kind) {
    case 'curves': {
      const p = layer.params;
      if ([p.master, p.red, p.green, p.blue].every(isIdentityCurve)) return null;
      return lutOp(toneLuts(layer)!);
    }
    case 'levels': {
      const p = layer.params;
      if ([p.master, p.red, p.green, p.blue].every(isIdentityLevels)) return null;
      return lutOp(toneLuts(layer)!);
    }
    case 'hueSaturation': {
      const p = layer.params;
      const rangesActive = !p.colorize && p.ranges.some((r) => !isNeutralRange(r));
      if (!p.colorize && !rangesActive && p.hue === 0 && p.saturation === 0 && p.lightness === 0) return null;
      const tables = rangesActive ? hueRangeTables(p.ranges) : null;
      const sat = p.saturation / 100;
      const light = Math.min(1, Math.max(-1, p.lightness / 100));
      return (c) => {
        let dh = 0, ds = 0, dl = 0;
        if (tables) {
          const h0 = rgbToHsl(c)[0];
          dh = sampleLut(tables[0], h0);
          ds = sampleLut(tables[1], h0);
          dl = sampleLut(tables[2], h0);
        }
        const out = rangeLightness(hueSaturation(c, p.hue + dh, Math.min(1, Math.max(-1, sat + ds)), light, p.colorize), dl);
        c[0] = out[0];
        c[1] = out[1];
        c[2] = out[2];
      };
    }
    case 'vibrance': {
      const v = layer.params.vibrance / 100;
      const s = layer.params.saturation / 100;
      if (v === 0 && s === 0) return null;
      return (c) => {
        const out = vibrancePixel(c, v, s);
        c[0] = out[0];
        c[1] = out[1];
        c[2] = out[2];
      };
    }
    case 'colorBalance': {
      const p = layer.params;
      const tones = [p.shadows, p.midtones, p.highlights] as const;
      if (tones.every((t) => t[0] === 0 && t[1] === 0 && t[2] === 0)) return null;
      const n = ADJUSTMENT_LUT_SIZE;
      const luts = [0, 1, 2].map((ch) => {
        const out = new Float32Array(n);
        for (let k = 0; k < n; k++) out[k] = colorBalanceChannel(tones, p.preserveLuminosity, ch, k / (n - 1));
        return out;
      }) as [Float32Array, Float32Array, Float32Array];
      return lutOp(luts);
    }
    case 'blackWhite': {
      const p = layer.params;
      const weights = [p.reds, p.yellows, p.greens, p.cyans, p.blues, p.magentas];
      const tint = p.tint ? hexToRgb(p.tint) : null;
      return (c) => {
        const g = blackWhiteGray(c, weights);
        if (tint) {
          const t = setLum(tint, g);
          c[0] = clamp01(t[0]);
          c[1] = clamp01(t[1]);
          c[2] = clamp01(t[2]);
        } else {
          c[0] = c[1] = c[2] = g;
        }
      };
    }
    case 'photoFilter': {
      const p = layer.params;
      if (p.density <= 0) return null;
      const m = photoFilterMatrix(hexToRgb(p.color), p.density / 100, false);
      const preserve = p.preserveLuminosity;
      return (c) => {
        const l = [srgbToLinear(Math.max(0, c[0])), srgbToLinear(Math.max(0, c[1])), srgbToLinear(Math.max(0, c[2]))];
        let f: Rgb = [0, 1, 2].map((r) => linearToSrgb(Math.max(0, m[r][0] * l[0] + m[r][1] * l[1] + m[r][2] * l[2]))) as Rgb;
        if (preserve) {
          const target = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
          f = setLum(f, target);
        }
        c[0] = clamp01(f[0]);
        c[1] = clamp01(f[1]);
        c[2] = clamp01(f[2]);
      };
    }
    case 'invert':
      return (c) => {
        c[0] = 1 - c[0];
        c[1] = 1 - c[1];
        c[2] = 1 - c[2];
      };
    case 'posterize': {
      const levels = layer.params.levels;
      return (c) => {
        c[0] = posterizeValue(c[0], levels);
        c[1] = posterizeValue(c[1], levels);
        c[2] = posterizeValue(c[2], levels);
      };
    }
    case 'threshold': {
      const t = Math.round(layer.params.level);
      return (c) => {
        const v = Math.round(rgbToGray(c) * 255) >= t ? 1 : 0;
        c[0] = c[1] = c[2] = v;
      };
    }
  }
  return null;
}

// Compiled layers keyed by kind + params, so a stack is compiled once per parameter change.
const COMPILE_CACHE_LIMIT = 64;
const compileCache = new Map<string, PixelOp | null>();

function compiledFor(layer: AdjustmentLayer): PixelOp | null {
  const key = `${layer.kind}:${JSON.stringify(layer.params)}`;
  if (compileCache.has(key)) {
    const op = compileCache.get(key)!;
    // Refresh recency.
    compileCache.delete(key);
    compileCache.set(key, op);
    return op;
  }
  const op = compileAdjustmentLayer(layer);
  compileCache.set(key, op);
  if (compileCache.size > COMPILE_CACHE_LIMIT) compileCache.delete(compileCache.keys().next().value as string);
  return op;
}

/** Layers that change pixels: enabled, visible, not the identity. */
export function activeAdjustmentLayers(layers: readonly AdjustmentLayer[] | undefined): AdjustmentLayer[] {
  if (!layers?.length) return [];
  return layers.filter((l) => l.enabled !== false && (l.opacity ?? 1) > 0 && compiledFor(l) !== null);
}

/**
 * Evaluates one colour (encoded sRGB, 0..1) through a layer stack: each layer adjusts the result
 * of the layers below and is blended over it with its blend mode and opacity (an opaque
 * backdrop, so `(1 − α)·Cb + α·B(Cb, Cs)`).
 */
export function evaluateAdjustmentLayers(color: readonly number[], layers: readonly AdjustmentLayer[]): Rgb {
  const c: Rgb = [color[0], color[1], color[2]];
  for (const layer of layers) applyLayer(c, layer, compiledFor(layer));
  return c;
}

function applyLayer(c: Rgb, layer: AdjustmentLayer, op: PixelOp | null, coverage = 1): void {
  if (!op || layer.enabled === false) return;
  const alpha = Math.min(1, Math.max(0, layer.opacity ?? 1)) * coverage;
  if (alpha <= 0) return;
  const blend = layer.blend ?? 'normal';
  if (blend === 'normal' && alpha >= 1) {
    op(c);
    return;
  }
  const cb0 = c[0], cb1 = c[1], cb2 = c[2];
  op(c);
  const b = blend === 'normal' ? c : blendRgb(blend, [cb0, cb1, cb2], c);
  c[0] = (1 - alpha) * cb0 + alpha * b[0];
  c[1] = (1 - alpha) * cb1 + alpha * b[1];
  c[2] = (1 - alpha) * cb2 + alpha * b[2];
}

/**
 * Applies an adjustment-layer stack to 8-bit straight RGBA pixels in place. Each pixel is
 * decoded once, run through every layer in float, and encoded once. Transparent pixels are
 * left alone; alpha is never changed.
 *
 * `masks` (layer id → 0..1 coverage per pixel of `imageData`, see `buildLayerMaskPlanes`)
 * scales each masked layer's opacity per pixel: coverage 0 leaves the pixel as the layers below
 * made it, 1 applies the layer fully.
 */
export function applyAdjustmentLayers(
  imageData: { data: Uint8ClampedArray },
  layers: readonly AdjustmentLayer[] | undefined,
  masks?: ReadonlyMap<string, ArrayLike<number>>
): void {
  const active = activeAdjustmentLayers(layers);
  if (!active.length) return;
  const ops = active.map((l) => compiledFor(l));
  const planes = active.map((l) => masks?.get(l.id));
  const data = imageData.data;
  const len = data.length;
  const c: Rgb = [0, 0, 0];
  for (let i = 0; i < len; i += 4) {
    if (data[i + 3] === 0) continue;
    c[0] = data[i] / 255;
    c[1] = data[i + 1] / 255;
    c[2] = data[i + 2] / 255;
    for (let k = 0; k < active.length; k++) {
      const plane = planes[k];
      if (plane) {
        const cov = plane[i >> 2];
        if (cov > 0) applyLayer(c, active[k], ops[k], cov >= 1 ? 1 : cov);
      } else {
        applyLayer(c, active[k], ops[k]);
      }
    }
    data[i] = Math.round(clamp01(c[0]) * 255);
    data[i + 1] = Math.round(clamp01(c[1]) * 255);
    data[i + 2] = Math.round(clamp01(c[2]) * 255);
  }
}

/** Stable cache key of a layer stack's pixel effect (for renderer caches). */
export function adjustmentLayersKey(layers: readonly AdjustmentLayer[] | undefined): string {
  if (!layers?.length) return '';
  return JSON.stringify(
    layers.map((l) => {
      const key: unknown[] = [l.kind, l.enabled !== false, l.opacity ?? 1, l.blend ?? 'normal', l.params];
      if (l.mask) key.push(layerMaskKey(l.mask));
      return key;
    })
  );
}
