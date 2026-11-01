// Portions ported from photocraft-main/crates/doc/src/effects.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Layer effects (Photoshop's layer styles) as data: drop and inner shadows, outer and inner
 * glows, bevel & emboss, satin, colour / gradient / pattern overlays and strokes. Rendering lives
 * in `./render`, PSD mapping in the image editor's PSD module.
 *
 * Angles are in degrees, counter-clockwise from 3 o'clock, and give the direction the light
 * comes *from* (Photoshop's convention). Sizes and distances are in pixels, opacities and
 * percentages in 0..1, colours are `#rrggbb`.
 */

import { isBlendMode, type BlendMode } from '../blend';

/** One point of a contour curve (input → output, both 0..1). */
export interface ContourPoint {
  input: number;
  output: number;
  /** The curve bends sharply here instead of passing smoothly through (Photoshop's corner point). */
  corner?: boolean;
}

/** A transfer curve applied to an effect's coverage. Missing on an effect = linear. */
export interface EffectContour {
  name: string;
  points: ContourPoint[];
}

export type GradientStyle = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';

export interface GradientColorStop {
  /** 0..1 along the gradient. */
  position: number;
  color: string;
}

export interface GradientOpacityStop {
  position: number;
  /** 0..1 */
  opacity: number;
}

/** A gradient as overlays, gradient strokes and gradient glows paint it. */
export interface EffectGradient {
  stops: GradientColorStop[];
  /** Missing or empty: opaque. */
  opacityStops?: GradientOpacityStop[];
  style: GradientStyle;
  /** Degrees (90 = bottom to top). */
  angle: number;
  /** 1 = 100 %. */
  scale: number;
  reverse: boolean;
  /** Align with the layer's bounds (else the canvas). */
  align: boolean;
  /** Centre offset as a fraction of the bounds. */
  offset: { x: number; y: number };
}

/** A pattern reference: the id of a document or built-in pattern (see `builtinPatternIds`). */
export interface EffectPatternRef {
  patternId: string;
  /** Display name (PSD keeps it beside the id). */
  name?: string;
  /** 1 = 100 %. */
  scale: number;
  /** Rotation in degrees (counter-clockwise). */
  angle?: number;
  /** Tile from the layer's top-left ("Link with Layer", default) instead of the canvas origin. */
  link?: boolean;
  /** Origin offset in pixels. */
  phase?: { x: number; y: number };
}

/** What a stroke or glow paints with. */
export type EffectFill =
  | { type: 'color'; color: string }
  | { type: 'gradient'; gradient: EffectGradient }
  | ({ type: 'pattern' } & EffectPatternRef);

interface EffectBase {
  /** Unique within the layer. */
  id: string;
  enabled: boolean;
}

interface Blended {
  blend: BlendMode;
  /** 0..1 */
  opacity: number;
}

export interface DropShadowEffect extends EffectBase, Blended {
  kind: 'drop-shadow';
  color: string;
  angle: number;
  useGlobalLight: boolean;
  distance: number;
  /** 0..1 of the size grown solid before the blur. */
  spread: number;
  size: number;
  contour?: EffectContour;
  antiAlias: boolean;
  /** 0..1 */
  noise: number;
  /** The layer hides the shadow beneath its see-through fill ("Layer Knocks Out Drop Shadow"). */
  knocksOut: boolean;
}

export interface InnerShadowEffect extends EffectBase, Blended {
  kind: 'inner-shadow';
  color: string;
  angle: number;
  useGlobalLight: boolean;
  distance: number;
  /** 0..1 of the size shrunk solid before the blur. */
  choke: number;
  size: number;
  contour?: EffectContour;
  antiAlias: boolean;
  noise: number;
}

export type GlowTechnique = 'softer' | 'precise';

export interface OuterGlowEffect extends EffectBase, Blended {
  kind: 'outer-glow';
  /** Colour or gradient. */
  fill: Extract<EffectFill, { type: 'color' | 'gradient' }>;
  technique: GlowTechnique;
  spread: number;
  size: number;
  contour?: EffectContour;
  antiAlias: boolean;
  /** 0..1 (default 0.5): the part of the glow the contour spans. */
  range: number;
  /** 0..1, varies a gradient glow's colours. Stored only (not rendered). */
  jitter: number;
  noise: number;
}

export interface InnerGlowEffect extends EffectBase, Blended {
  kind: 'inner-glow';
  fill: Extract<EffectFill, { type: 'color' | 'gradient' }>;
  technique: GlowTechnique;
  choke: number;
  size: number;
  contour?: EffectContour;
  antiAlias: boolean;
  range: number;
  jitter: number;
  noise: number;
  /** Glow from the edge inwards (default) or from the centre outwards. */
  source: 'edge' | 'center';
}

export type BevelStyle = 'inner-bevel' | 'outer-bevel' | 'emboss' | 'pillow-emboss' | 'stroke-emboss';
export type BevelTechnique = 'smooth' | 'chisel-hard' | 'chisel-soft';

/** The Contour element of Bevel & Emboss: shapes the bevel's height profile. */
export interface BevelContour {
  contour: EffectContour;
  /** 0..1 (default 0.5). Stored only. */
  range: number;
  antiAlias: boolean;
}

/** The Texture element of Bevel & Emboss: a pattern's luminance added to the height. */
export interface BevelTexture extends EffectPatternRef {
  /** -10..10 (1 = +100 %); negative carves the pattern in. */
  depth: number;
  invert: boolean;
}

export interface BevelEmbossEffect extends EffectBase {
  kind: 'bevel-emboss';
  style: BevelStyle;
  technique: BevelTechnique;
  /** 0..10 (1 = 100 %). */
  depth: number;
  direction: 'up' | 'down';
  size: number;
  soften: number;
  angle: number;
  /** Light altitude in degrees (0..90). */
  altitude: number;
  useGlobalLight: boolean;
  glossContour?: EffectContour;
  highlightColor: string;
  highlightBlend: BlendMode;
  highlightOpacity: number;
  shadowColor: string;
  shadowBlend: BlendMode;
  shadowOpacity: number;
  /** Contour element (shapes the bevel's height profile), or missing when off. */
  contourElement?: BevelContour;
  /** Texture element, or missing when off. */
  texture?: BevelTexture;
}

export interface SatinEffect extends EffectBase, Blended {
  kind: 'satin';
  color: string;
  angle: number;
  distance: number;
  size: number;
  contour?: EffectContour;
  antiAlias: boolean;
  invert: boolean;
}

export interface ColorOverlayEffect extends EffectBase, Blended {
  kind: 'color-overlay';
  color: string;
}

export interface GradientOverlayEffect extends EffectBase, Blended {
  kind: 'gradient-overlay';
  gradient: EffectGradient;
  dither: boolean;
}

export interface PatternOverlayEffect extends EffectBase, Blended, EffectPatternRef {
  kind: 'pattern-overlay';
}

export type StrokePosition = 'outside' | 'inside' | 'center';

export interface StrokeEffect extends EffectBase, Blended {
  kind: 'stroke';
  size: number;
  position: StrokePosition;
  fill: EffectFill;
}

/** One layer effect. Several of the same kind are allowed; the first listed of a kind is on top. */
export type LayerEffect =
  | DropShadowEffect
  | InnerShadowEffect
  | OuterGlowEffect
  | InnerGlowEffect
  | BevelEmbossEffect
  | SatinEffect
  | ColorOverlayEffect
  | GradientOverlayEffect
  | PatternOverlayEffect
  | StrokeEffect;

export type LayerEffectKind = LayerEffect['kind'];

/** A layer's effects: the master switch, Layer Style › Scale Effects and the effect list. */
export interface LayerEffects {
  /** The master switch ("effects on"); `false` keeps the effects but renders none. */
  enabled: boolean;
  /** Scale Effects: multiplies every size, distance and pattern scale (1 = 100 %; missing = 1). */
  scale?: number;
  items: LayerEffect[];
  /**
   * The PSD block the effects were read from (`lfx2`, `lfxs` or `lmfx`), kept so export writes it
   * back verbatim while the effects still map to the same values. Export regenerates it otherwise.
   */
  psd?: { key: string; data: Uint8Array };
}

/** The document-wide light that effects with `useGlobalLight` use. */
export interface GlobalLight {
  /** Degrees. */
  angle: number;
  /** Degrees. */
  altitude: number;
}

export const DEFAULT_GLOBAL_LIGHT: GlobalLight = { angle: 120, altitude: 30 };

/** Every effect kind, in the order the Layer Style dialog lists them. */
export const LAYER_EFFECT_KINDS: readonly LayerEffectKind[] = [
  'bevel-emboss',
  'stroke',
  'inner-shadow',
  'inner-glow',
  'satin',
  'color-overlay',
  'gradient-overlay',
  'pattern-overlay',
  'outer-glow',
  'drop-shadow',
];

const LABELS: Record<LayerEffectKind, string> = {
  'drop-shadow': 'Drop Shadow',
  'inner-shadow': 'Inner Shadow',
  'outer-glow': 'Outer Glow',
  'inner-glow': 'Inner Glow',
  'bevel-emboss': 'Bevel & Emboss',
  satin: 'Satin',
  'color-overlay': 'Color Overlay',
  'gradient-overlay': 'Gradient Overlay',
  'pattern-overlay': 'Pattern Overlay',
  stroke: 'Stroke',
};

export function layerEffectLabel(kind: LayerEffectKind): string {
  return LABELS[kind];
}

export function isLayerEffectKind(value: unknown): value is LayerEffectKind {
  return typeof value === 'string' && value in LABELS;
}

/** Photoshop's default black-to-white linear gradient. */
export function defaultEffectGradient(): EffectGradient {
  return {
    stops: [
      { position: 0, color: '#000000' },
      { position: 1, color: '#ffffff' },
    ],
    style: 'linear',
    angle: 90,
    scale: 1,
    reverse: false,
    align: true,
    offset: { x: 0, y: 0 },
  };
}

let fxCounter = 0;

/** A fresh effect id. */
export function newEffectId(): string {
  return `fx_${Date.now().toString(36)}_${(++fxCounter).toString(36)}`;
}

/** An effect of `kind` with Photoshop's default settings. */
export function defaultLayerEffect(kind: LayerEffectKind, id = newEffectId()): LayerEffect {
  const base = { id, enabled: true };
  switch (kind) {
    case 'drop-shadow':
      return { ...base, kind, blend: 'multiply', opacity: 0.75, color: '#000000', angle: 120, useGlobalLight: true, distance: 5, spread: 0, size: 5, antiAlias: false, noise: 0, knocksOut: true };
    case 'inner-shadow':
      return { ...base, kind, blend: 'multiply', opacity: 0.75, color: '#000000', angle: 120, useGlobalLight: true, distance: 5, choke: 0, size: 5, antiAlias: false, noise: 0 };
    case 'outer-glow':
      return { ...base, kind, blend: 'screen', opacity: 0.75, fill: { type: 'color', color: '#ffffbe' }, technique: 'softer', spread: 0, size: 5, antiAlias: false, range: 0.5, jitter: 0, noise: 0 };
    case 'inner-glow':
      return { ...base, kind, blend: 'screen', opacity: 0.75, fill: { type: 'color', color: '#ffffbe' }, technique: 'softer', choke: 0, size: 5, antiAlias: false, range: 0.5, jitter: 0, noise: 0, source: 'edge' };
    case 'bevel-emboss':
      return {
        ...base,
        kind,
        style: 'inner-bevel',
        technique: 'smooth',
        depth: 1,
        direction: 'up',
        size: 5,
        soften: 0,
        angle: 120,
        altitude: 30,
        useGlobalLight: true,
        highlightColor: '#ffffff',
        highlightBlend: 'screen',
        highlightOpacity: 0.75,
        shadowColor: '#000000',
        shadowBlend: 'multiply',
        shadowOpacity: 0.75,
      };
    case 'satin':
      return { ...base, kind, blend: 'multiply', opacity: 0.5, color: '#000000', angle: 19, distance: 11, size: 14, antiAlias: true, invert: true };
    case 'color-overlay':
      return { ...base, kind, blend: 'normal', opacity: 1, color: '#ff0000' };
    case 'gradient-overlay':
      return { ...base, kind, blend: 'normal', opacity: 1, gradient: defaultEffectGradient(), dither: false };
    case 'pattern-overlay':
      return { ...base, kind, blend: 'normal', opacity: 1, patternId: 'checker', name: 'Checker', scale: 1, angle: 0, link: true, phase: { x: 0, y: 0 } };
    case 'stroke':
      return { ...base, kind, blend: 'normal', opacity: 1, size: 3, position: 'outside', fill: { type: 'color', color: '#000000' } };
  }
}

/** True when the master switch is on and at least one effect is enabled. */
export function hasActiveEffects(effects: LayerEffects | undefined | null): effects is LayerEffects {
  return Boolean(effects && effects.enabled && effects.items.some((e) => e.enabled));
}

/** Maximum distance (px) an effect is rendered from the layer's shape. */
export const MAX_EFFECT_REACH = 512;

/** How far (px, before Scale Effects) one effect paints beyond or into the layer's shape. */
export function effectReach(e: LayerEffect): number {
  switch (e.kind) {
    case 'drop-shadow':
    case 'inner-shadow':
      return e.distance + e.size;
    case 'outer-glow':
    case 'inner-glow':
      return e.size + 1;
    case 'stroke':
      return e.size;
    case 'satin':
      return Math.max(1, e.distance) + e.size;
    case 'bevel-emboss': {
      if (e.technique === 'smooth') return e.size + e.soften + 1;
      // Chiselled heights read the nearest edge up to size + 2 px away and its normal one px past
      // that; chisel-soft and soften then blur them (tents of radius up to width + 1) and the
      // lighting reads one px around. The margin patches effect maps, so it must cover all of it.
      const size = Math.max(e.size, 1);
      const chiselSoft = e.technique === 'chisel-soft' ? Math.max(size / 4, 1) + 1 : 0;
      return size + 3 + chiselSoft + e.soften + 1 + 1;
    }
    default:
      return 0;
  }
}

/**
 * Pixels an effect stack can reach beyond the layer's shape (its enabled effects, scaled), plus
 * a little slack. 0 when no effect is active. Dirty areas and tile signatures grow by this.
 */
export function effectsMargin(effects: LayerEffects | undefined | null): number {
  if (!hasActiveEffects(effects)) return 0;
  const scale = effectsScale(effects);
  let m = 0;
  for (const e of effects.items) {
    if (!e.enabled) continue;
    const r = effectReach(e) * scale;
    if (Number.isFinite(r)) m = Math.max(m, r);
  }
  return Math.ceil(Math.min(Math.max(m, 0), MAX_EFFECT_REACH)) + 2;
}

/** Scale Effects as a usable factor (missing or invalid = 1). */
export function effectsScale(effects: Pick<LayerEffects, 'scale'>): number {
  const s = effects.scale;
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1;
}

/** `effect` with its sizes, distances and pattern scales multiplied by `s` (Scale Effects). */
export function scaleLayerEffect<E extends LayerEffect>(e: E, s: number): E {
  if (s === 1) return e;
  const pattern = <P extends EffectPatternRef>(p: P): P => ({ ...p, scale: p.scale * s });
  const fill = (f: EffectFill): EffectFill => (f.type === 'pattern' ? pattern(f) : f);
  switch (e.kind) {
    case 'drop-shadow':
    case 'inner-shadow':
    case 'satin':
      return { ...e, distance: e.distance * s, size: e.size * s };
    case 'outer-glow':
    case 'inner-glow':
      return { ...e, size: e.size * s };
    case 'stroke':
      return { ...e, size: e.size * s, fill: fill(e.fill) };
    case 'pattern-overlay':
      return pattern(e) as E;
    case 'bevel-emboss':
      return { ...e, size: e.size * s, soften: e.soften * s, texture: e.texture ? pattern(e.texture) : undefined };
    default:
      return e;
  }
}

/** `#rrggbb` (or `#rgb`, `rrggbb`) as 0..1 RGB, or `null`. */
export function parseEffectColor(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  let h = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/./g, (c) => c + c);
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

/** 0..1 RGB as `#rrggbb`. */
export function effectColorHex(rgb: readonly number[]): string {
  const c = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

// ---------------------------------------------------------------------------
// Validation (agents, JSON and PSD all go through here)
// ---------------------------------------------------------------------------

export class LayerEffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayerEffectError';
  }
}

type Rec = Record<string, unknown>;

function fail(path: string, msg: string): never {
  throw new LayerEffectError(`${path}: ${msg}`);
}

function num(r: Rec, key: string, path: string, min: number, max: number): void {
  const v = r[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${path}.${key}`, `must be a number from ${min} to ${max}.`);
  if (v < min || v > max) fail(`${path}.${key}`, `${v} is out of range (${min} to ${max}).`);
}

function bool(r: Rec, key: string, path: string): void {
  if (typeof r[key] !== 'boolean') fail(`${path}.${key}`, 'must be true or false.');
}

function color(r: Rec, key: string, path: string): void {
  if (!parseEffectColor(r[key])) fail(`${path}.${key}`, `must be a colour like "#ff8800" (got ${JSON.stringify(r[key])}).`);
}

function oneOf(r: Rec, key: string, path: string, values: readonly string[]): void {
  if (typeof r[key] !== 'string' || !values.includes(r[key] as string)) fail(`${path}.${key}`, `must be one of ${values.join(', ')}.`);
}

function blend(r: Rec, key: string, path: string): void {
  if (!isBlendMode(r[key])) fail(`${path}.${key}`, `must be a blend mode such as normal, multiply or screen (got ${JSON.stringify(r[key])}).`);
  // Pigment mixing is not a B(Cb, Cs) mode, and effects paint through one.
  if (r[key] === 'pigment') fail(`${path}.${key}`, 'pigment is a layer blend mode only; effects cannot use it.');
}

function contour(v: unknown, path: string): void {
  if (v === undefined) return;
  if (!v || typeof v !== 'object') fail(path, 'must be an object { name, points }.');
  const c = v as Rec;
  if (typeof c.name !== 'string') fail(`${path}.name`, 'must be a string.');
  if (!Array.isArray(c.points) || c.points.length < 2) fail(`${path}.points`, 'needs at least 2 points { input, output } from 0 to 1.');
  c.points.forEach((p, i) => {
    if (!p || typeof p !== 'object') fail(`${path}.points[${i}]`, 'must be { input, output }.');
    num(p as Rec, 'input', `${path}.points[${i}]`, 0, 1);
    num(p as Rec, 'output', `${path}.points[${i}]`, 0, 1);
    if ((p as Rec).corner !== undefined) bool(p as Rec, 'corner', `${path}.points[${i}]`);
  });
}

export function validateEffectGradient(v: unknown, path: string): void {
  if (!v || typeof v !== 'object') fail(path, 'must be a gradient object.');
  const g = v as Rec;
  if (!Array.isArray(g.stops) || g.stops.length < 1) fail(`${path}.stops`, 'needs at least one stop { position, color }.');
  g.stops.forEach((s, i) => {
    num(s as Rec, 'position', `${path}.stops[${i}]`, 0, 1);
    color(s as Rec, 'color', `${path}.stops[${i}]`);
  });
  if (g.opacityStops !== undefined) {
    if (!Array.isArray(g.opacityStops)) fail(`${path}.opacityStops`, 'must be a list of { position, opacity }.');
    g.opacityStops.forEach((s, i) => {
      num(s as Rec, 'position', `${path}.opacityStops[${i}]`, 0, 1);
      num(s as Rec, 'opacity', `${path}.opacityStops[${i}]`, 0, 1);
    });
  }
  oneOf(g, 'style', path, ['linear', 'radial', 'angle', 'reflected', 'diamond']);
  num(g, 'angle', path, -360, 360);
  num(g, 'scale', path, 0.1, 1.5);
  bool(g, 'reverse', path);
  bool(g, 'align', path);
  const o = g.offset as Rec | undefined;
  if (!o || typeof o !== 'object') fail(`${path}.offset`, 'must be { x, y } (fractions of the bounds).');
  num(o, 'x', `${path}.offset`, -1, 1);
  num(o, 'y', `${path}.offset`, -1, 1);
}

function patternRef(r: Rec, path: string): void {
  if (typeof r.patternId !== 'string' || !r.patternId) fail(`${path}.patternId`, 'must be a pattern id (a built-in pattern such as "checker", or one from list_layer_effects.patterns).');
  num(r, 'scale', path, 0.01, 10);
  if (r.angle !== undefined) num(r, 'angle', path, -360, 360);
  if (r.link !== undefined) bool(r, 'link', path);
  if (r.phase !== undefined) {
    const p = r.phase as Rec;
    if (!p || typeof p !== 'object') fail(`${path}.phase`, 'must be { x, y } in pixels.');
    num(p, 'x', `${path}.phase`, -1e6, 1e6);
    num(p, 'y', `${path}.phase`, -1e6, 1e6);
  }
}

function fill(v: unknown, path: string, allowPattern: boolean): void {
  if (!v || typeof v !== 'object') fail(path, 'must be { type: "color", color } or { type: "gradient", gradient }' + (allowPattern ? ' or { type: "pattern", patternId, scale }.' : '.'));
  const f = v as Rec;
  if (f.type === 'color') color(f, 'color', path);
  else if (f.type === 'gradient') validateEffectGradient(f.gradient, `${path}.gradient`);
  else if (f.type === 'pattern' && allowPattern) patternRef(f, path);
  else fail(`${path}.type`, allowPattern ? 'must be color, gradient or pattern.' : 'must be color or gradient (glows cannot use a pattern).');
}

const OPTIONAL_FIELDS: Partial<Record<LayerEffectKind, string[]>> = {
  'drop-shadow': ['contour'],
  'inner-shadow': ['contour'],
  'outer-glow': ['contour'],
  'inner-glow': ['contour'],
  satin: ['contour'],
  'bevel-emboss': ['glossContour', 'contourElement', 'texture'],
};

/** Every field an effect of `kind` has (required and optional), including `id` and `kind`. */
export function layerEffectFields(kind: LayerEffectKind): string[] {
  return [...Object.keys(defaultLayerEffect(kind, 'x')), ...(OPTIONAL_FIELDS[kind] ?? [])];
}

/**
 * Checks a complete effect (every field of its kind present and in range). Throws a
 * {@link LayerEffectError} naming the first wrong field and how to fix it.
 */
export function validateLayerEffect(v: unknown, path = 'effect'): asserts v is LayerEffect {
  if (!v || typeof v !== 'object') fail(path, 'must be an object.');
  const e = v as Rec;
  if (!isLayerEffectKind(e.kind)) fail(`${path}.kind`, `must be one of ${LAYER_EFFECT_KINDS.join(', ')}.`);
  if (typeof e.id !== 'string' || !e.id) fail(`${path}.id`, 'must be a non-empty string.');
  bool(e, 'enabled', path);
  const kind = e.kind as LayerEffectKind;
  const allowed = layerEffectFields(kind);
  for (const k of Object.keys(e)) {
    if (e[k] !== undefined && !allowed.includes(k)) fail(`${path}.${k}`, `not a setting of ${kind}. Its settings are ${allowed.filter((f) => f !== 'id' && f !== 'kind').join(', ')}.`);
  }
  if (kind !== 'bevel-emboss') {
    blend(e, 'blend', path);
    num(e, 'opacity', path, 0, 1);
  }
  switch (kind) {
    case 'drop-shadow':
    case 'inner-shadow':
      color(e, 'color', path);
      num(e, 'angle', path, -360, 360);
      bool(e, 'useGlobalLight', path);
      num(e, 'distance', path, 0, 30000);
      num(e, kind === 'drop-shadow' ? 'spread' : 'choke', path, 0, 1);
      num(e, 'size', path, 0, 250);
      contour(e.contour, `${path}.contour`);
      bool(e, 'antiAlias', path);
      num(e, 'noise', path, 0, 1);
      if (kind === 'drop-shadow') bool(e, 'knocksOut', path);
      break;
    case 'outer-glow':
    case 'inner-glow':
      fill(e.fill, `${path}.fill`, false);
      oneOf(e, 'technique', path, ['softer', 'precise']);
      num(e, kind === 'outer-glow' ? 'spread' : 'choke', path, 0, 1);
      num(e, 'size', path, 0, 250);
      contour(e.contour, `${path}.contour`);
      bool(e, 'antiAlias', path);
      num(e, 'range', path, 0.01, 1);
      num(e, 'jitter', path, 0, 1);
      num(e, 'noise', path, 0, 1);
      if (kind === 'inner-glow') oneOf(e, 'source', path, ['edge', 'center']);
      break;
    case 'bevel-emboss':
      oneOf(e, 'style', path, ['inner-bevel', 'outer-bevel', 'emboss', 'pillow-emboss', 'stroke-emboss']);
      oneOf(e, 'technique', path, ['smooth', 'chisel-hard', 'chisel-soft']);
      num(e, 'depth', path, 0, 10);
      oneOf(e, 'direction', path, ['up', 'down']);
      num(e, 'size', path, 0, 250);
      num(e, 'soften', path, 0, 16);
      num(e, 'angle', path, -360, 360);
      num(e, 'altitude', path, 0, 90);
      bool(e, 'useGlobalLight', path);
      contour(e.glossContour, `${path}.glossContour`);
      color(e, 'highlightColor', path);
      blend(e, 'highlightBlend', path);
      num(e, 'highlightOpacity', path, 0, 1);
      color(e, 'shadowColor', path);
      blend(e, 'shadowBlend', path);
      num(e, 'shadowOpacity', path, 0, 1);
      if (e.contourElement !== undefined) {
        const c = e.contourElement as Rec;
        if (!c || typeof c !== 'object') fail(`${path}.contourElement`, 'must be { contour, range, antiAlias } or left out.');
        contour(c.contour, `${path}.contourElement.contour`);
        num(c, 'range', `${path}.contourElement`, 0, 1);
        bool(c, 'antiAlias', `${path}.contourElement`);
      }
      if (e.texture !== undefined) {
        const t = e.texture as Rec;
        if (!t || typeof t !== 'object') fail(`${path}.texture`, 'must be { patternId, scale, depth, invert } or left out.');
        patternRef(t, `${path}.texture`);
        num(t, 'depth', `${path}.texture`, -10, 10);
        bool(t, 'invert', `${path}.texture`);
      }
      break;
    case 'satin':
      color(e, 'color', path);
      num(e, 'angle', path, -360, 360);
      num(e, 'distance', path, 0, 250);
      num(e, 'size', path, 0, 250);
      contour(e.contour, `${path}.contour`);
      bool(e, 'antiAlias', path);
      bool(e, 'invert', path);
      break;
    case 'color-overlay':
      color(e, 'color', path);
      break;
    case 'gradient-overlay':
      validateEffectGradient(e.gradient, `${path}.gradient`);
      bool(e, 'dither', path);
      break;
    case 'pattern-overlay':
      patternRef(e, path);
      break;
    case 'stroke':
      num(e, 'size', path, 0, 250);
      oneOf(e, 'position', path, ['outside', 'inside', 'center']);
      fill(e.fill, `${path}.fill`, true);
      break;
  }
}

/**
 * Applies `changes` to `effect` and validates the result. `kind` and `id` cannot change. Nested
 * objects (`fill`, `gradient`, `contour`, `texture`, `phase`, `offset`) are replaced whole; `null`
 * removes an optional one (`contour`, `glossContour`, bevel `contour` / `texture`).
 */
export function mergeLayerEffect(effect: LayerEffect, changes: Record<string, unknown>): LayerEffect {
  if ('kind' in changes && changes.kind !== effect.kind) throw new LayerEffectError(`kind cannot change (${effect.kind}); remove the effect and add a new one.`);
  if ('id' in changes && changes.id !== effect.id) throw new LayerEffectError('id cannot change.');
  const next: Rec = { ...effect };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }
  validateLayerEffect(next);
  return next as unknown as LayerEffect;
}

/** A layer's effects with `items` validated; throws on the first bad effect. */
export function validateLayerEffects(v: unknown): asserts v is LayerEffects {
  if (!v || typeof v !== 'object') fail('effects', 'must be { enabled, items }.');
  const r = v as Rec;
  bool(r, 'enabled', 'effects');
  if (r.scale !== undefined) num(r, 'scale', 'effects', 0.01, 10);
  if (!Array.isArray(r.items)) fail('effects.items', 'must be a list.');
  const ids = new Set<string>();
  r.items.forEach((e, i) => {
    validateLayerEffect(e, `effects.items[${i}]`);
    if (ids.has(e.id)) fail(`effects.items[${i}].id`, `duplicate id ${e.id}.`);
    ids.add(e.id);
  });
}

/**
 * Reads effects from JSON leniently: invalid effects are dropped (so one bad entry does not lose
 * a document), and missing optional fields take their defaults. `null` when nothing usable.
 */
export function normalizeLayerEffects(raw: unknown): LayerEffects | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Rec;
  const items: LayerEffect[] = [];
  const ids = new Set<string>();
  if (Array.isArray(r.items)) {
    for (const it of r.items) {
      if (!it || typeof it !== 'object' || !isLayerEffectKind((it as Rec).kind)) continue;
      const kind = (it as Rec).kind as LayerEffectKind;
      const merged = { ...defaultLayerEffect(kind), ...(it as Rec) } as Rec;
      if (typeof merged.id !== 'string' || !merged.id || ids.has(merged.id as string)) merged.id = newEffectId();
      try {
        validateLayerEffect(merged);
      } catch {
        continue;
      }
      ids.add(merged.id as string);
      items.push(merged as unknown as LayerEffect);
    }
  }
  const out: LayerEffects = { enabled: r.enabled !== false, items };
  if (typeof r.scale === 'number' && Number.isFinite(r.scale) && r.scale > 0 && r.scale !== 1) out.scale = r.scale;
  if (r.psd && typeof r.psd === 'object') {
    const p = r.psd as Rec;
    if (typeof p.key === 'string' && p.data instanceof Uint8Array) out.psd = { key: p.key, data: p.data };
  }
  return items.length || out.psd ? out : undefined;
}

/** Effects without ids or the PSD block, for comparing what two effect stacks render. */
export function effectsFingerprint(effects: LayerEffects | undefined | null): string {
  if (!effects) return '';
  const items = effects.items.map((e) => {
    const { id: _id, ...rest } = e;
    return rest;
  });
  return stableStringify([effects.enabled, effectsScale(effects), items]);
}

/** JSON with object keys sorted (and `undefined` fields left out), so key order never matters. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Rec)
      .filter((k) => (v as Rec)[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Rec)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
