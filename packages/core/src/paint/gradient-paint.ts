/**
 * Gradient paint: a colour slot (the paint colour, a swatch, a stroke's colour) holds a
 * `PaintSource`, either one colour or a gradient that the brush samples dab by dab as the stroke
 * goes: by distance travelled, pen pressure, tilt, speed, direction, time, across the tip, or at
 * random. Shared by the paint editor and the image editor.
 *
 * - **Stops** have the vector and image gradients' shape (`offset`, `color`, `opacity`,
 *   `midpoint`); opacity multiplies the brush's flow. `softness` (1, smooth, by default) turns
 *   each blend into a harder step towards 0.
 * - **Space**: `pigment` (default) mixes neighbouring stops like paint (Kubelka-Munk, so blue to
 *   yellow passes through green), `oklab` perceptually, `srgb` as plain numbers.
 * - **Mapping**: what moves along the gradient. `distance` (default: 300 px, mirrored) is the
 *   "drag it out" paint: the colour changes as the stroke travels. It never stretches over the
 *   whole stroke, whose length is unknown until the pen lifts.
 *
 * Everything is a pure function of the stroke's recorded samples and seed, so replays, time-lapses,
 * re-rendered exports and drying stay exact.
 */

import { mixPigment8 } from '../raster/blend';
import { rand01 } from './rand';

/** sRGB 0..1. */
export type PaintRgb = [number, number, number];

/** A gradient stop: the vector and image gradients' shape. */
export interface PaintGradientStop {
  /** 0..1 along the gradient. */
  offset: number;
  /**
   * #rrggbb, or `paint` / `secondary`: the editor's paint and second colours when the stroke
   * starts (a gradient between whatever two colours are chosen).
   */
  color: string;
  /** 0..1 (default 1): multiplies the brush's flow where this colour is laid. */
  opacity?: number;
  /** Where between this stop and the next (0.05..0.95 of the way) the colours are half mixed (default 0.5). */
  midpoint?: number;
}

/** How neighbouring stops mix. */
export type PaintGradientSpace = 'pigment' | 'oklab' | 'srgb';
export const PAINT_GRADIENT_SPACES: readonly PaintGradientSpace[] = ['pigment', 'oklab', 'srgb'];

/** Past the end of the gradient: hold the last colour, start again, or run back. */
export type PaintGradientRepeat = 'clamp' | 'repeat' | 'mirror';
export const PAINT_GRADIENT_REPEATS: readonly PaintGradientRepeat[] = ['clamp', 'repeat', 'mirror'];

/** What moves a stroke along its gradient. */
export type PaintGradientMapping =
  /** The stroke's travel: `length` px (or dabs, `unit` 'dabs') per run through the gradient. */
  | { by: 'distance'; length: number; repeat: PaintGradientRepeat; unit?: 'px' | 'dabs' }
  /** Pen pressure 0..1; tilt 0 (upright) .. 1 (flat); speed 0 .. 2.5 px/ms; direction of travel 0..360°. */
  | { by: 'pressure' }
  | { by: 'tilt' }
  | { by: 'velocity' }
  | { by: 'direction' }
  /** Time since the stroke began: `duration` ms per run through the gradient (needs timed samples). */
  | { by: 'time'; duration: number; repeat?: PaintGradientRepeat }
  /** Across the tip, left to right looking along the stroke: a brush loaded with several colours. */
  | { by: 'across-tip' }
  /** A random point of the gradient per dab (or per `every` dabs), seeded so replays match. */
  | { by: 'random'; every?: number };

export type PaintGradientMappingKind = PaintGradientMapping['by'];
export const PAINT_GRADIENT_MAPPINGS: readonly PaintGradientMappingKind[] = ['distance', 'pressure', 'tilt', 'velocity', 'direction', 'time', 'across-tip', 'random'];

export interface PaintColorSource {
  type: 'color';
  /** #rrggbb */
  color: string;
}

export interface PaintGradientSource {
  type: 'gradient';
  /** 2..16 stops, sorted by offset. */
  stops: PaintGradientStop[];
  space: PaintGradientSpace;
  map: PaintGradientMapping;
  /** 0 (hard steps) .. 1 (smooth blends, default). */
  softness?: number;
}

/** What a colour slot holds: one colour or a gradient. */
export type PaintSource = PaintColorSource | PaintGradientSource;

/** "Drag it out": 300 px of travel per run, mirrored back and forth. */
export const DEFAULT_PAINT_GRADIENT_MAPPING: Readonly<PaintGradientMapping> = { by: 'distance', length: 300, repeat: 'mirror', unit: 'px' };

/** Speed (px/ms) at which `velocity` reaches the end of the gradient (the brush dynamics' full speed). */
export const PAINT_GRADIENT_FULL_SPEED = 2.5;

/** Seed stream of `random` (the multi-colour brush's, so migrated brushes pick the same colours). */
const RANDOM_STREAM = 11;

export class PaintSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaintSourceError';
  }
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#rgb` / `#rrggbb` → lowercase `#rrggbb`, or null. */
export function normalizeHexColor(v: unknown): string | null {
  if (typeof v !== 'string' || !HEX.test(v.trim())) return null;
  const h = v.trim().toLowerCase();
  return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h;
}

/** `#rrggbb` → sRGB 0..1. */
export function hexToPaintRgb(hex: string): PaintRgb {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const describe = (v: unknown) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));

function parseMapping(raw: unknown, at: string): PaintGradientMapping {
  if (raw === undefined) return { ...DEFAULT_PAINT_GRADIENT_MAPPING } as PaintGradientMapping;
  if (!raw || typeof raw !== 'object') throw new PaintSourceError(`${at} must be an object like { "by": "distance", "length": 300, "repeat": "mirror" }.`);
  const r = raw as Record<string, unknown>;
  const by = r.by as PaintGradientMappingKind;
  if (!PAINT_GRADIENT_MAPPINGS.includes(by)) throw new PaintSourceError(`${at}.by ${describe(r.by)} is not a mapping; use one of ${PAINT_GRADIENT_MAPPINGS.join(', ')}.`);
  const repeat = (key: string, def: PaintGradientRepeat): PaintGradientRepeat => {
    if (r[key] === undefined) return def;
    if (!PAINT_GRADIENT_REPEATS.includes(r[key] as PaintGradientRepeat)) throw new PaintSourceError(`${at}.${key} ${describe(r[key])} is not a repeat; use ${PAINT_GRADIENT_REPEATS.join(', ')}.`);
    return r[key] as PaintGradientRepeat;
  };
  const range = (key: string, lo: number, hi: number, def: number, unit: string): number => {
    if (r[key] === undefined) return def;
    if (!finite(r[key]) || (r[key] as number) < lo || (r[key] as number) > hi) throw new PaintSourceError(`${at}.${key} ${describe(r[key])} is out of range; use ${lo}..${hi} ${unit}.`);
    return r[key] as number;
  };
  switch (by) {
    case 'distance': {
      const unit = r.unit === undefined ? 'px' : r.unit;
      if (unit !== 'px' && unit !== 'dabs') throw new PaintSourceError(`${at}.unit ${describe(r.unit)} is not a unit; use px or dabs.`);
      return { by, length: range('length', 1, unit === 'px' ? 100000 : 10000, 300, unit), repeat: repeat('repeat', 'mirror'), unit };
    }
    case 'time':
      return { by, duration: range('duration', 1, 600000, 2000, 'ms'), repeat: repeat('repeat', 'clamp') };
    case 'random':
      return { by, every: Math.round(range('every', 1, 500, 1, 'dabs')) };
    default:
      return { by };
  }
}

/**
 * Reads a paint source strictly: what tools and APIs take. Throws `PaintSourceError` saying what
 * is wrong (unknown type, an unreadable colour, fewer than 2 or more than 16 stops, offsets
 * outside 0..1 or not sorted, a bad mapping) and how to fix it. Missing optional fields get their
 * defaults (space `pigment`, the `distance` mapping, softness 1).
 */
export function parsePaintSource(raw: unknown, at = 'paint'): PaintSource {
  if (typeof raw === 'string') {
    const color = normalizeHexColor(raw);
    if (!color) throw new PaintSourceError(`${at} ${describe(raw)} is not a colour; use #rrggbb or a gradient object.`);
    return { type: 'color', color };
  }
  if (!raw || typeof raw !== 'object') throw new PaintSourceError(`${at} must be { "type": "color", "color": "#rrggbb" } or { "type": "gradient", "stops": [...] }.`);
  const r = raw as Record<string, unknown>;
  if (r.type === 'color') {
    const color = normalizeHexColor(r.color);
    if (!color) throw new PaintSourceError(`${at}.color ${describe(r.color)} is not a colour; use #rrggbb.`);
    return { type: 'color', color };
  }
  if (r.type !== 'gradient') throw new PaintSourceError(`${at}.type ${describe(r.type)} is not a paint; use "color" or "gradient".`);
  if (!Array.isArray(r.stops) || r.stops.length < 2 || r.stops.length > 16) throw new PaintSourceError(`${at}.stops needs 2..16 stops like { "offset": 0, "color": "#1d4ed8" }; got ${Array.isArray(r.stops) ? r.stops.length : describe(r.stops)}.`);
  const stops: PaintGradientStop[] = r.stops.map((s, i) => {
    const sat = `${at}.stops[${i}]`;
    if (!s || typeof s !== 'object') throw new PaintSourceError(`${sat} must be { "offset": 0..1, "color": "#rrggbb" }.`);
    const o = s as Record<string, unknown>;
    if (!finite(o.offset) || o.offset < 0 || o.offset > 1) throw new PaintSourceError(`${sat}.offset ${describe(o.offset)} must be a number 0..1.`);
    const color = o.color === 'paint' || o.color === 'secondary' ? o.color : normalizeHexColor(o.color);
    if (!color) throw new PaintSourceError(`${sat}.color ${describe(o.color)} is not a colour; use #rrggbb, "paint" or "secondary".`);
    const stop: PaintGradientStop = { offset: o.offset, color };
    if (o.opacity !== undefined) {
      if (!finite(o.opacity) || o.opacity < 0 || o.opacity > 1) throw new PaintSourceError(`${sat}.opacity ${describe(o.opacity)} must be 0..1.`);
      if (o.opacity !== 1) stop.opacity = o.opacity;
    }
    if (o.midpoint !== undefined) {
      if (!finite(o.midpoint) || o.midpoint < 0.05 || o.midpoint > 0.95) throw new PaintSourceError(`${sat}.midpoint ${describe(o.midpoint)} must be 0.05..0.95.`);
      if (o.midpoint !== 0.5) stop.midpoint = o.midpoint;
    }
    return stop;
  });
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].offset < stops[i - 1].offset) throw new PaintSourceError(`${at}.stops must be sorted by offset: stop ${i} (${stops[i].offset}) comes before stop ${i - 1} (${stops[i - 1].offset}).`);
  }
  const space = r.space === undefined ? 'pigment' : (r.space as PaintGradientSpace);
  if (!PAINT_GRADIENT_SPACES.includes(space)) throw new PaintSourceError(`${at}.space ${describe(r.space)} is not a space; use ${PAINT_GRADIENT_SPACES.join(', ')}.`);
  const out: PaintGradientSource = { type: 'gradient', stops, space, map: parseMapping(r.map, `${at}.map`) };
  if (r.softness !== undefined) {
    if (!finite(r.softness) || r.softness < 0 || r.softness > 1) throw new PaintSourceError(`${at}.softness ${describe(r.softness)} must be 0..1.`);
    if (r.softness !== 1) out.softness = r.softness;
  }
  return out;
}

/** Reads a paint source leniently (documents, presets): `null` when it is not one. */
export function readPaintSource(raw: unknown): PaintSource | null {
  try {
    return raw === undefined || raw === null ? null : parsePaintSource(raw);
  } catch {
    return null;
  }
}

/**
 * The gradient with its `paint` / `secondary` stops replaced by those colours (#rrggbb): what a
 * stroke records and samples.
 */
export function resolvePaintGradient(g: PaintGradientSource, colors: { paint: string; secondary: string }): PaintGradientSource {
  if (!g.stops.some((s) => s.color === 'paint' || s.color === 'secondary')) return g;
  return { ...g, stops: g.stops.map((s) => (s.color === 'paint' ? { ...s, color: colors.paint } : s.color === 'secondary' ? { ...s, color: colors.secondary } : s)) };
}

/** The gradient for a stroke scaled by `k` (a high-resolution re-render): pixel distances scale with it. */
export function scalePaintGradient(g: PaintGradientSource, k: number): PaintGradientSource {
  if (k === 1 || g.map.by !== 'distance' || g.map.unit === 'dabs') return g;
  return { ...g, map: { ...g.map, length: Math.min(100000, Math.max(1, g.map.length * k)) } };
}

/** A colour source. */
export function solidPaint(color: string): PaintColorSource {
  return { type: 'color', color: normalizeHexColor(color) ?? '#000000' };
}

/** Whether a source is a gradient. */
export function isGradientPaint(s: PaintSource | null | undefined): s is PaintGradientSource {
  return Boolean(s && s.type === 'gradient');
}

/** One colour that stands for the source (the colour, or a gradient's first stop): what a plain colour slot shows. */
export function paintSourceColor(s: PaintSource, colors: { paint: string; secondary: string } = { paint: '#000000', secondary: '#ffffff' }): string {
  if (s.type === 'color') return s.color;
  const c = s.stops[0].color;
  return c === 'paint' ? colors.paint : c === 'secondary' ? colors.secondary : c;
}

/** The source as a CSS `linear-gradient` (or colour) for colour wells and swatches. */
export function paintSourceCss(s: PaintSource, colors: { paint: string; secondary: string } = { paint: '#000000', secondary: '#ffffff' }): string {
  if (s.type === 'color') return s.color;
  const parts = resolvePaintGradient(s, colors).stops.map((st) => {
    const [r, g, b] = hexToPaintRgb(st.color).map((v) => Math.round(v * 255));
    return `rgba(${r}, ${g}, ${b}, ${st.opacity ?? 1}) ${Math.round(st.offset * 1000) / 10}%`;
  });
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

// --- Sampling -------------------------------------------------------------------

/** Where `u` (0..1 of a segment) lands with the midpoint `m` (the vector gradients' remap). */
function midpointRemap(u: number, m: number): number {
  if (Math.abs(m - 0.5) < 1e-6) return u;
  return u <= m ? (0.5 * u) / m : 0.5 + (0.5 * (u - m)) / (1 - m);
}

/** Softness 1 keeps the blend; towards 0 it becomes a step at ½ (the multi-colour brush's curve). */
function soften(f: number, softness: number): number {
  if (softness >= 1) return f;
  const w = Math.max(1e-3, softness);
  return Math.min(1, Math.max(0, (f - 0.5) / w + 0.5));
}

const q8 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
const mixScratch = [0, 0, 0];

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
function toOklab(c: PaintRgb): PaintRgb {
  const r = srgbToLinear(c[0]);
  const g = srgbToLinear(c[1]);
  const b = srgbToLinear(c[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab(c: PaintRgb): PaintRgb {
  const l = (c[0] + 0.3963377774 * c[1] + 0.2158037573 * c[2]) ** 3;
  const m = (c[0] - 0.1055613458 * c[1] - 0.0638541728 * c[2]) ** 3;
  const s = (c[0] - 0.0894841775 * c[1] - 1.291485548 * c[2]) ** 3;
  const out: PaintRgb = [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
  // Rounded to 16 bits so last-bit differences between JavaScript engines' pow / cbrt never show.
  return out.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 65535) / 65535) as PaintRgb;
}

interface RampStop {
  t: number;
  rgb: PaintRgb;
  lab: PaintRgb | null;
  alpha: number;
  mid: number;
}

/** A gradient's colour at a dab: sRGB 0..1 and the opacity to multiply the flow by. */
export interface PaintGradientSample {
  rgb: PaintRgb;
  alpha: number;
}

/** What a dab offers a mapping: all pure functions of the stroke's recorded samples and seed. */
export interface PaintDabParams {
  /** Path length (px) the stroke has travelled at this dab. */
  travel: number;
  /** The dab's index in its copy of the stroke (0, 1, 2 …). */
  index: number;
  /** 0..1 */
  pressure: number;
  /** 0 upright .. 1 flat. */
  lean: number;
  /** px/ms, or `null` without timed samples. */
  speed: number | null;
  /** Direction of travel, radians counter-clockwise with y up. */
  direction: number;
  /** ms since the stroke's first timed sample, or `null` without timed samples. */
  time: number | null;
}

/**
 * A gradient prepared for sampling. `dab` gives the colour of one dab; `across-tip` gradients give
 * a table across the tip instead (`tipTable`).
 */
export class PaintGradientSampler {
  private readonly stops: RampStop[];
  private readonly softness: number;
  /** Stops at exactly k/(n − 1): segments found by arithmetic, as the multi-colour brush did. */
  private readonly uniform: boolean;
  readonly acrossTip: boolean;

  constructor(
    readonly source: PaintGradientSource,
    private readonly seed = 0
  ) {
    this.stops = source.stops.map((s) => {
      // Unresolved `paint` / `secondary` stops (call `resolvePaintGradient` first) read as black and white.
      const rgb = s.color === 'paint' ? ([0, 0, 0] as PaintRgb) : s.color === 'secondary' ? ([1, 1, 1] as PaintRgb) : hexToPaintRgb(s.color);
      return { t: s.offset, rgb, lab: source.space === 'oklab' ? toOklab(rgb) : null, alpha: s.opacity ?? 1, mid: s.midpoint ?? 0.5 };
    });
    this.softness = source.softness ?? 1;
    const n = this.stops.length;
    this.uniform = this.stops.every((s, k) => s.t === k / (n - 1) && s.mid === 0.5);
    this.acrossTip = source.map.by === 'across-tip';
  }

  /** The two stops' mix `u` of the way (0..1), in the gradient's space. */
  private mix(a: RampStop, b: RampStop, u: number, out: PaintGradientSample): PaintGradientSample {
    const v = soften(u, this.softness);
    out.alpha = a.alpha + (b.alpha - a.alpha) * v;
    const ar = a.rgb;
    const br = b.rgb;
    if (v <= 0 || (ar[0] === br[0] && ar[1] === br[1] && ar[2] === br[2])) {
      out.rgb = [ar[0], ar[1], ar[2]];
      return out;
    }
    if (v >= 1) {
      out.rgb = [br[0], br[1], br[2]];
      return out;
    }
    if (this.source.space === 'pigment') {
      mixPigment8(q8(ar[0]), q8(ar[1]), q8(ar[2]), q8(br[0]), q8(br[1]), q8(br[2]), v, mixScratch);
      out.rgb = [mixScratch[0], mixScratch[1], mixScratch[2]];
    } else if (this.source.space === 'oklab') {
      const la = a.lab!;
      const lb = b.lab!;
      out.rgb = fromOklab([la[0] + (lb[0] - la[0]) * v, la[1] + (lb[1] - la[1]) * v, la[2] + (lb[2] - la[2]) * v]);
    } else out.rgb = [ar[0] + (br[0] - ar[0]) * v, ar[1] + (br[1] - ar[1]) * v, ar[2] + (br[2] - ar[2]) * v];
    return out;
  }

  /** The colour at `t` (clamped to 0..1). */
  sample(t: number, out: PaintGradientSample = { rgb: [0, 0, 0], alpha: 1 }): PaintGradientSample {
    const st = this.stops;
    const n = st.length;
    if (this.uniform) {
      const f = Math.min(1, Math.max(0, t)) * (n - 1);
      const i = Math.min(n - 2, Math.floor(f));
      return this.mix(st[i], st[i + 1], f - i, out);
    }
    if (!(t > st[0].t)) return this.mix(st[0], st[0], 0, out);
    if (t >= st[n - 1].t) return this.mix(st[n - 1], st[n - 1], 0, out);
    let i = 0;
    while (i < n - 2 && !(t < st[i + 1].t)) i++;
    const a = st[i];
    const b = st[i + 1];
    const h = b.t - a.t;
    return this.mix(a, b, h > 0 ? midpointRemap((t - a.t) / h, a.mid) : 1, out);
  }

  /** Sampled `travel / length` runs along, past the end as `repeat` says. */
  private along(travel: number, length: number, repeat: PaintGradientRepeat, out: PaintGradientSample): PaintGradientSample {
    const n = this.stops.length;
    if (repeat === 'repeat' && this.uniform) {
      // Whole segments: the multi-colour brush's `(index / length) % colours`, to the bit.
      const segs = n - 1;
      const f = (travel / (length / segs)) % segs;
      const i = Math.min(segs - 1, Math.floor(f));
      return this.mix(this.stops[i], this.stops[i + 1], f - i, out);
    }
    const x = travel / length;
    let t: number;
    if (repeat === 'clamp') t = x;
    else if (repeat === 'repeat') t = x - Math.floor(x);
    else {
      const m = x - 2 * Math.floor(x / 2);
      t = m <= 1 ? m : 2 - m;
    }
    return this.sample(t, out);
  }

  /** The colour of one dab (not for `across-tip`: see `tipTable`). */
  dab(d: PaintDabParams, out: PaintGradientSample = { rgb: [0, 0, 0], alpha: 1 }): PaintGradientSample {
    const map = this.source.map;
    switch (map.by) {
      case 'distance':
        return this.along(map.unit === 'dabs' ? d.index : d.travel, map.length, map.repeat, out);
      case 'pressure':
        return this.sample(d.pressure, out);
      case 'tilt':
        return this.sample(d.lean, out);
      case 'velocity':
        return this.sample(d.speed === null ? 0 : Math.min(1, d.speed / PAINT_GRADIENT_FULL_SPEED), out);
      case 'direction': {
        const turn = d.direction / (2 * Math.PI);
        return this.sample(turn - Math.floor(turn), out);
      }
      case 'time':
        return this.along(d.time ?? 0, map.duration, map.repeat ?? 'clamp', out);
      case 'random':
        return this.sample(rand01(this.seed, Math.floor(d.index / (map.every ?? 1)), RANDOM_STREAM), out);
      default:
        return this.sample(0.5, out);
    }
  }

  /** `steps` colours from the left edge of the tip to the right (`across-tip`). */
  tipTable(steps: number): PaintGradientSample[] {
    const out: PaintGradientSample[] = [];
    for (let j = 0; j < steps; j++) out.push(this.sample(j / (steps - 1)));
    return out;
  }
}

// --- JSON Schema (for agent tools) -------------------------------------------------

const STOP_SCHEMA = {
  type: 'object',
  description: 'A gradient stop.',
  properties: {
    offset: { type: 'number', minimum: 0, maximum: 1, description: 'Where the stop is, 0..1 along the gradient. Stops must be sorted by offset.' },
    color: { type: 'string', pattern: '^(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}|paint|secondary)$', description: '#rrggbb, or "paint" / "secondary": the editor\'s paint or second colour when the stroke starts.' },
    opacity: { type: 'number', minimum: 0, maximum: 1, description: "0..1 (default 1): multiplies the brush's flow where this colour is laid." },
    midpoint: { type: 'number', minimum: 0.05, maximum: 0.95, description: 'Where between this stop and the next the colours are half mixed, 0.05..0.95 of the way (default 0.5).' },
  },
  required: ['offset', 'color'],
  additionalProperties: false,
} as const;

/** JSON Schema of a gradient `PaintSource` (what tools accept for gradient paint). */
export const PAINT_GRADIENT_JSON_SCHEMA = {
  type: 'object',
  description:
    'Gradient paint: the brush samples it dab by dab as the stroke goes. Example (blue to yellow over 300 px of stroke, and back): { "type": "gradient", "stops": [{ "offset": 0, "color": "#1d4ed8" }, { "offset": 1, "color": "#facc15" }], "map": { "by": "distance", "length": 300, "repeat": "mirror" } }.',
  properties: {
    type: { type: 'string', enum: ['gradient'], description: 'Always "gradient".' },
    stops: { type: 'array', minItems: 2, maxItems: 16, items: STOP_SCHEMA, description: '2..16 stops sorted by offset.' },
    space: { type: 'string', enum: [...PAINT_GRADIENT_SPACES], description: 'How neighbouring stops mix: pigment (default; like paint, blue to yellow passes green), oklab (perceptual) or srgb (plain numbers).' },
    map: {
      type: 'object',
      description: 'What moves the stroke along the gradient (default distance, 300 px, mirror).',
      properties: {
        by: {
          type: 'string',
          enum: [...PAINT_GRADIENT_MAPPINGS],
          description:
            'distance: px (or dabs) of stroke travelled; pressure: pen pressure 0..1; tilt: pen lean, upright 0 .. flat 1; velocity: pen speed, 0 .. 2.5 px/ms; direction: direction of travel, once round per 360°; time: ms since the stroke began (needs timed points); across-tip: left to right across the tip, looking along the stroke (a brush loaded with several colours); random: a random point per dab (seeded, so replays match).',
        },
        length: { type: 'number', minimum: 1, maximum: 100000, description: 'distance: px of travel (or dabs, with unit "dabs") per run through the gradient (default 300).' },
        repeat: { type: 'string', enum: [...PAINT_GRADIENT_REPEATS], description: 'distance and time: past the end, clamp (hold the last colour), repeat (start again) or mirror (run back; default for distance, clamp for time).' },
        unit: { type: 'string', enum: ['px', 'dabs'], description: 'distance: px (default) or dabs.' },
        duration: { type: 'number', minimum: 1, maximum: 600000, description: 'time: ms per run through the gradient (default 2000).' },
        every: { type: 'integer', minimum: 1, maximum: 500, description: 'random: dabs per random pick (default 1).' },
      },
      required: ['by'],
      additionalProperties: false,
    },
    softness: { type: 'number', minimum: 0, maximum: 1, description: 'How softly neighbouring stops blend: 1 smooth (default) .. 0 hard steps.' },
  },
  required: ['type', 'stops'],
  additionalProperties: false,
} as const;

/** JSON Schema of a colour `PaintSource`. */
export const PAINT_COLOR_JSON_SCHEMA = {
  type: 'object',
  description: 'One colour: { "type": "color", "color": "#rrggbb" }.',
  properties: {
    type: { type: 'string', enum: ['color'], description: 'Always "color".' },
    color: { type: 'string', pattern: '^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$', description: '#rrggbb' },
  },
  required: ['type', 'color'],
  additionalProperties: false,
} as const;

/** JSON Schema of a `PaintSource`: a colour or gradient paint. */
export const PAINT_SOURCE_JSON_SCHEMA = {
  description: 'What to paint with: one colour, or gradient paint.',
  oneOf: [PAINT_COLOR_JSON_SCHEMA, PAINT_GRADIENT_JSON_SCHEMA],
} as const;

// --- Editing (for gradient editors in any framework) -------------------------------

const toHex8 = (rgb: readonly number[]) => '#' + rgb.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');

/** Labels for the mapping picker. */
export const PAINT_GRADIENT_MAPPING_LABELS: Readonly<Record<PaintGradientMappingKind, string>> = {
  distance: 'Distance',
  pressure: 'Pressure',
  tilt: 'Tilt',
  velocity: 'Speed',
  direction: 'Direction',
  time: 'Time',
  'across-tip': 'Across the tip',
  random: 'Random',
};
export const PAINT_GRADIENT_SPACE_LABELS: Readonly<Record<PaintGradientSpace, string>> = { pigment: 'Pigment', oklab: 'Perceptual', srgb: 'RGB' };
export const PAINT_GRADIENT_REPEAT_LABELS: Readonly<Record<PaintGradientRepeat, string>> = { clamp: 'Hold', repeat: 'Repeat', mirror: 'Mirror' };

/** The paint colour to the second colour, changing as the stroke is dragged out: where a gradient editor starts. */
export const DEFAULT_PAINT_GRADIENT: Readonly<PaintGradientSource> = {
  type: 'gradient',
  stops: [
    { offset: 0, color: 'paint' },
    { offset: 1, color: 'secondary' },
  ],
  space: 'pigment',
  map: { by: 'distance', length: 300, repeat: 'mirror', unit: 'px' },
};

/** A few starting gradients for gradient editors. */
export const PAINT_GRADIENT_PRESETS: readonly { name: string; paint: PaintGradientSource }[] = [
  { name: 'Paint to second colour', paint: DEFAULT_PAINT_GRADIENT },
  {
    name: 'Sky to sun',
    paint: { type: 'gradient', stops: [{ offset: 0, color: '#1d4ed8' }, { offset: 1, color: '#facc15' }], space: 'pigment', map: { by: 'distance', length: 300, repeat: 'mirror', unit: 'px' } },
  },
  {
    name: 'Sunset',
    paint: { type: 'gradient', stops: [{ offset: 0, color: '#7c3aed' }, { offset: 0.5, color: '#e11d48' }, { offset: 1, color: '#f59e0b' }], space: 'oklab', map: { by: 'distance', length: 400, repeat: 'mirror', unit: 'px' } },
  },
  {
    name: 'Rainbow',
    paint: {
      type: 'gradient',
      stops: ['#e11d48', '#f59e0b', '#facc15', '#22c55e', '#3b82f6', '#8b5cf6'].map((color, k) => ({ offset: k / 5, color })),
      space: 'oklab',
      map: { by: 'distance', length: 600, repeat: 'repeat', unit: 'px' },
    },
  },
  {
    name: 'Pressure: light to dark',
    paint: { type: 'gradient', stops: [{ offset: 0, color: 'secondary' }, { offset: 1, color: 'paint' }], space: 'pigment', map: { by: 'pressure' } },
  },
];

/** Adds a stop at `offset` with the gradient's colour there. Returns the gradient and the new stop's index. */
export function addPaintGradientStop(g: PaintGradientSource, offset: number, colors: { paint: string; secondary: string } = { paint: '#000000', secondary: '#ffffff' }): { paint: PaintGradientSource; index: number } {
  if (g.stops.length >= 16) return { paint: g, index: -1 };
  const t = Math.min(1, Math.max(0, offset));
  const s = new PaintGradientSampler({ ...resolvePaintGradient(g, colors), map: { by: 'pressure' } }).sample(t);
  const stop: PaintGradientStop = { offset: t, color: toHex8(s.rgb) };
  if (s.alpha < 1) stop.opacity = Math.round(s.alpha * 1000) / 1000;
  let index = g.stops.findIndex((x) => x.offset > t);
  if (index < 0) index = g.stops.length;
  const stops = [...g.stops.slice(0, index), stop, ...g.stops.slice(index)];
  return { paint: { ...g, stops }, index };
}

/** Removes stop `index` (a gradient keeps at least 2). */
export function removePaintGradientStop(g: PaintGradientSource, index: number): PaintGradientSource {
  if (g.stops.length <= 2 || index < 0 || index >= g.stops.length) return g;
  return { ...g, stops: g.stops.filter((_, i) => i !== index) };
}

/** Changes stop `index` (moving it keeps the stops sorted). Returns the gradient and where the stop is now. */
export function updatePaintGradientStop(g: PaintGradientSource, index: number, patch: Partial<PaintGradientStop>): { paint: PaintGradientSource; index: number } {
  const target = g.stops[index];
  if (!target) return { paint: g, index };
  const next: PaintGradientStop = { ...target, ...patch };
  next.offset = Math.min(1, Math.max(0, next.offset));
  if (next.opacity === undefined || next.opacity >= 1) delete next.opacity;
  else next.opacity = Math.max(0, next.opacity);
  if (next.midpoint === undefined || next.midpoint === 0.5) delete next.midpoint;
  else next.midpoint = Math.min(0.95, Math.max(0.05, next.midpoint));
  const rest = g.stops.filter((_, i) => i !== index);
  let at = rest.findIndex((x) => x.offset > next.offset);
  if (at < 0) at = rest.length;
  return { paint: { ...g, stops: [...rest.slice(0, at), next, ...rest.slice(at)] }, index: at };
}

/** The gradient with its stops reversed (midpoints measured from the other side). */
export function reversePaintGradient(g: PaintGradientSource): PaintGradientSource {
  const st = g.stops;
  const stops = st
    .map((s, i) => {
      const out: PaintGradientStop = { offset: 1 - s.offset, color: s.color };
      if (s.opacity !== undefined) out.opacity = s.opacity;
      // The midpoint of the segment that now follows this stop was the previous stop's.
      const prev = st[i - 1];
      if (prev?.midpoint !== undefined) out.midpoint = 1 - prev.midpoint;
      return out;
    })
    .reverse();
  return { ...g, stops };
}

/** The mapping for `by`, keeping what carries over from `current` (length, repeat, duration …). */
export function paintGradientMappingFor(by: PaintGradientMappingKind, current: PaintGradientMapping): PaintGradientMapping {
  const prev = current as Partial<Record<'length' | 'repeat' | 'unit' | 'duration' | 'every', unknown>>;
  switch (by) {
    case 'distance':
      return { by, length: typeof prev.length === 'number' ? prev.length : 300, repeat: (prev.repeat as PaintGradientRepeat) ?? 'mirror', unit: (prev.unit as 'px' | 'dabs') ?? 'px' };
    case 'time':
      return { by, duration: typeof prev.duration === 'number' ? prev.duration : 2000, repeat: (prev.repeat as PaintGradientRepeat) ?? 'clamp' };
    case 'random':
      return { by, every: typeof prev.every === 'number' ? prev.every : 1 };
    default:
      return { by };
  }
}

/** Everything a gradient-paint editor UI needs, in one object (framework bindings take it from their own entry). */
export const PAINT_GRADIENT_KIT = {
  PAINT_GRADIENT_MAPPINGS,
  PAINT_GRADIENT_MAPPING_LABELS,
  PAINT_GRADIENT_PRESETS,
  PAINT_GRADIENT_REPEATS,
  PAINT_GRADIENT_REPEAT_LABELS,
  PAINT_GRADIENT_SPACES,
  PAINT_GRADIENT_SPACE_LABELS,
  addPaintGradientStop,
  paintGradientMappingFor,
  paintSourceCss,
  removePaintGradientStop,
  reversePaintGradient,
  updatePaintGradientStop,
} as const;
export type PaintGradientKit = typeof PAINT_GRADIENT_KIT;
