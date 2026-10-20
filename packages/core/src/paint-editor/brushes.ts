/**
 * Paint editor brushes: the shared engine's tip settings (`@pixerate/editor/paint`) plus what a
 * natural-media brush adds: paper grain response, pen dynamics (pressure, tilt, barrel rotation,
 * velocity), separate pressure smoothing, a rotation mode, jitter, and Mixer Brush settings for
 * the blending brushes. The built-in presets are our own settings; none come from another product.
 */

import { DEFAULT_BRUSH, MAX_BRUSH_SIZE, normalizeBrush, type BrushSettings } from '../paint/brush';
import { DEFAULT_BLENDER, DEFAULT_SMUDGE, normalizeBlender, normalizeSmudge, type BlenderSettings, type SmudgeSettings } from '../paint/blending';
import type { MixingModel } from '../paint/exchange';
import { DEFAULT_MIXER, normalizeMixer, type MixerSettings } from '../paint/mixer';

/**
 * How a brush makes marks: `dab` (dabs into a stroke buffer, or dab by dab through the pick-up /
 * mix exchange when its behaviour asks for it), `eraser` (removes alpha), `mixer` (the Mixer
 * Brush), `blender` (mixes the colours under and near the tip) or `smudge` (drags paint along).
 */
export type PaintBrushEngine = 'dab' | 'eraser' | 'mixer' | 'blender' | 'smudge' | 'wet';

export const PAINT_BRUSH_ENGINES: readonly PaintBrushEngine[] = ['dab', 'eraser', 'mixer', 'blender', 'smudge', 'wet'];

export type PaintBrushCategory = 'pencil' | 'pastel' | 'charcoal' | 'airbrush' | 'marker' | 'ink' | 'paint' | 'eraser' | 'blender' | 'smudge' | 'mixer' | 'watercolor' | 'wet-tool' | 'custom';

export const PAINT_BRUSH_CATEGORIES: readonly PaintBrushCategory[] = ['pencil', 'pastel', 'charcoal', 'airbrush', 'marker', 'ink', 'paint', 'eraser', 'blender', 'smudge', 'mixer', 'watercolor', 'wet-tool', 'custom'];

/**
 * What a wet brush does to the wet layer: `paint` (water and pigment), `water` (clear water;
 * with `rewet` it lifts dried paint), `dry` (a hair dryer: takes water, the pigment settles),
 * `blow` (pushes the water along the stroke), `blend` (evens out the wet pigment under the tip),
 * `smudge` (drags wet paint along) or `blot` (a tissue: takes up wet paint).
 */
export type WetTool = 'paint' | 'water' | 'dry' | 'blow' | 'blend' | 'smudge' | 'blot';

export const WET_TOOLS: readonly WetTool[] = ['paint', 'water', 'dry', 'blow', 'blend', 'smudge', 'blot'];

/** Wet engine settings, each 0..1. */
export interface WetBrushSettings {
  tool: WetTool;
  /** Water the brush lays down (wetness): 0.2 a damp brush, 1 a dripping one. */
  water: number;
  /** Pigment concentration: 0 clear water .. 1 paint straight from the tube. */
  pigment: number;
  /** Body: 0 a transparent watercolour .. 1 opaque gouache that hides what is under it. */
  body: number;
  /** Strength of the dry, blow, blend, smudge and blot tools. */
  strength: number;
  /** How much dried paint the water lifts again (re-wetting): 0 none (staining) .. 1. */
  rewet: number;
}

export const DEFAULT_WET_BRUSH: Readonly<WetBrushSettings> = { tool: 'paint', water: 0.5, pigment: 0.5, body: 0, strength: 0.5, rewet: 0 };

export function normalizeWetBrush(raw: Partial<WetBrushSettings> = {}, base: WetBrushSettings = DEFAULT_WET_BRUSH): WetBrushSettings {
  return {
    tool: WET_TOOLS.includes(raw.tool as WetTool) ? (raw.tool as WetTool) : base.tool,
    water: unit(raw.water, base.water),
    pigment: unit(raw.pigment, base.pigment),
    body: unit(raw.body, base.body),
    strength: unit(raw.strength, base.strength),
    rewet: unit(raw.rewet, base.rewet),
  };
}

/** Multi-coloured brush: `tip` lays the colours across the tip, `dab` changes colour from dab to dab. */
export type MultiColorMode = 'off' | 'tip' | 'dab';

export const MULTI_COLOR_MODES: readonly MultiColorMode[] = ['off', 'tip', 'dab'];

export interface MultiColorSettings {
  /** `off` (default), `tip` (the colours side by side across the tip, like a brush loaded with several paints; the stripes follow the stroke) or `dab` (the colour changes along the stroke). */
  mode: MultiColorMode;
  /** 2..8 colours #rrggbb. Fewer than 2: the paint colour and the secondary colour. */
  colors: string[];
  /** `dab` mode: `sequence` (default) runs through the colours in order, blending between them; `random` picks one per run of dabs (seeded, so replays match). */
  order: 'sequence' | 'random';
  /** `dab` mode: dabs per colour, 1..500 (default 12). */
  length: number;
  /** How softly neighbouring colours blend, 0 (hard stripes or steps) .. 1 (smooth gradient, default). */
  softness: number;
}

export const DEFAULT_MULTI_COLOR: Readonly<MultiColorSettings> = { mode: 'off', colors: [], order: 'sequence', length: 12, softness: 1 };

/**
 * How a brush handles paint on the canvas. The pick-up / mix ratios are the shared exchange's
 * (`@pixerate/editor/paint` `PaintExchange`); wet media will use the same ones. On a Mixer Brush
 * they are its `mixer.wet`, `mixer.mix`, `!mixer.cleanEachStroke` and `mixer.mixing`, kept in sync.
 */
export interface BrushBehavior {
  /** Pick-up ratio, 0..1: how much of the paint under each dab the brush lifts and carries (0: none, default). */
  pickup: number;
  /** Mix ratio, 0..1: how much of the carried paint goes into what the brush lays down, against its own colour (default 0.5). */
  mix: number;
  /** Dirty brush: keep the carried paint after the stroke, so the next stroke starts with the last colour the brush touched (default false). */
  dirty: boolean;
  /** How picked-up paint, multi-colour gradients and the deposit mix: `pigment` (default, Kubelka-Munk) or `rgb`. */
  mixing: MixingModel;
  /** Multi-coloured brush. */
  multicolor: MultiColorSettings;
}

export const DEFAULT_BEHAVIOR: Readonly<BrushBehavior> = { pickup: 0, mix: 0.5, dirty: false, mixing: 'pigment', multicolor: DEFAULT_MULTI_COLOR };

/** What turns the tip: a fixed angle, the direction of the stroke, or the pen's barrel rotation. */
export type BrushRotation = 'fixed' | 'stroke' | 'barrel';

export const BRUSH_ROTATIONS: readonly BrushRotation[] = ['fixed', 'stroke', 'barrel'];

/** Pen dynamics and jitter. Every amount is 0 (off) .. 1 unless noted. */
export interface BrushDynamics {
  /** Size at zero pressure as a fraction of the full size, when pressure controls size (default 0). */
  minSize: number;
  /** How much pressure scales flow (default 0). */
  pressureFlow: number;
  /** Laying the pen down widens the tip, up to 2.5× (default 0). */
  tiltSize: number;
  /** Laying the pen down flattens the tip along the tilt direction (default 0). */
  tiltRoundness: number;
  /** Laying the pen down lightens the mark, as when shading with the side of a pencil (default 0). */
  tiltOpacity: number;
  /** -1..1: positive grows the tip when the pen moves fast, negative thins it (default 0). */
  velocitySize: number;
  /** -1..1: positive darkens fast marks, negative lightens them (default 0). */
  velocityOpacity: number;
  /** Random size change per dab (default 0). */
  sizeJitter: number;
  /** Random angle per dab, as a fraction of ±180° (default 0). */
  angleJitter: number;
  /** Random opacity drop per dab (default 0). */
  opacityJitter: number;
  /** Random offset across the stroke in diameters, 0..4 (default 0). */
  scatter: number;
}

export const DEFAULT_DYNAMICS: Readonly<BrushDynamics> = {
  minSize: 0,
  pressureFlow: 0,
  tiltSize: 0,
  tiltRoundness: 0,
  tiltOpacity: 0,
  velocitySize: 0,
  velocityOpacity: 0,
  sizeJitter: 0,
  angleJitter: 0,
  opacityJitter: 0,
  scatter: 0,
};

export interface PaintBrush {
  /** Library id (lowercase letters, digits and dashes). */
  id: string;
  name: string;
  category: PaintBrushCategory;
  engine: PaintBrushEngine;
  /** The shared engine's tip: size, hardness, spacing, angle, roundness, opacity, flow, position smoothing, pressure to size / opacity, blend. */
  tip: BrushSettings;
  /** How strongly the mark follows the paper grain, 0 (ignores it) .. 1 (catches only the peaks at light pressure). */
  grain: number;
  /** Pressure smoothing 0..0.95, separate from the tip's position smoothing (default 0). */
  pressureSmoothing: number;
  rotation: BrushRotation;
  dynamics: BrushDynamics;
  /** Mixer engine only: the Mixer Brush settings. */
  mixer: MixerSettings;
  /** Mixer engine only: load the current colour each stroke (false: a smudge or blender that only moves paint). */
  loadsColor: boolean;
  /** Pick-up and mix ratios, dirty brush and multi-colour (dab and mixer engines). */
  behavior: BrushBehavior;
  /** Blender engine only: strength, blend distance and mixing. */
  blender: BlenderSettings;
  /** Smudge engine only: strength, length and mixing. */
  smudge: SmudgeSettings;
  /** Wet engine only: the wet tool, water, pigment, body and strength. */
  wet: WetBrushSettings;
  /** True for the built-in presets (they cannot be removed or overwritten). */
  builtin?: boolean;
}

const unit = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
const range = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function normalizeDynamics(raw: Partial<BrushDynamics> = {}, base: BrushDynamics = DEFAULT_DYNAMICS): BrushDynamics {
  return {
    minSize: unit(raw.minSize, base.minSize),
    pressureFlow: unit(raw.pressureFlow, base.pressureFlow),
    tiltSize: unit(raw.tiltSize, base.tiltSize),
    tiltRoundness: unit(raw.tiltRoundness, base.tiltRoundness),
    tiltOpacity: unit(raw.tiltOpacity, base.tiltOpacity),
    velocitySize: range(raw.velocitySize, -1, 1, base.velocitySize),
    velocityOpacity: range(raw.velocityOpacity, -1, 1, base.velocityOpacity),
    sizeJitter: unit(raw.sizeJitter, base.sizeJitter),
    angleJitter: unit(raw.angleJitter, base.angleJitter),
    opacityJitter: unit(raw.opacityJitter, base.opacityJitter),
    scatter: range(raw.scatter, 0, 4, base.scatter),
  };
}

export const BRUSH_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const HEX = /^#[0-9a-f]{6}$/i;

export function normalizeMultiColor(raw: Partial<MultiColorSettings> = {}, base: MultiColorSettings = DEFAULT_MULTI_COLOR): MultiColorSettings {
  const colors = Array.isArray(raw.colors) ? raw.colors.filter((c): c is string => typeof c === 'string' && HEX.test(c.trim())).map((c) => c.trim().toLowerCase()).slice(0, 8) : base.colors;
  return {
    mode: MULTI_COLOR_MODES.includes(raw.mode as MultiColorMode) ? (raw.mode as MultiColorMode) : base.mode,
    colors: [...colors],
    order: raw.order === 'random' || raw.order === 'sequence' ? raw.order : base.order,
    length: typeof raw.length === 'number' && Number.isFinite(raw.length) ? Math.min(500, Math.max(1, Math.round(raw.length))) : base.length,
    softness: unit(raw.softness, base.softness),
  };
}

/** Behaviour input: any subset, with a partial multi-colour block. */
export type BrushBehaviorInput = Partial<Omit<BrushBehavior, 'multicolor'>> & { multicolor?: Partial<MultiColorSettings> };

export function normalizeBehavior(raw: BrushBehaviorInput = {}, base: BrushBehavior = DEFAULT_BEHAVIOR): BrushBehavior {
  return {
    pickup: unit(raw.pickup, base.pickup),
    mix: unit(raw.mix, base.mix),
    dirty: typeof raw.dirty === 'boolean' ? raw.dirty : base.dirty,
    mixing: raw.mixing === 'rgb' || raw.mixing === 'pigment' ? raw.mixing : base.mixing,
    multicolor: normalizeMultiColor(raw.multicolor ?? {}, base.multicolor),
  };
}

/** Brush settings to change or read: any subset of a brush and of its blocks. */
export type PaintBrushInput = Partial<Omit<PaintBrush, 'tip' | 'dynamics' | 'mixer' | 'behavior' | 'blender' | 'smudge' | 'wet'>> & {
  tip?: Partial<BrushSettings>;
  dynamics?: Partial<BrushDynamics>;
  mixer?: Partial<MixerSettings>;
  behavior?: BrushBehaviorInput;
  blender?: Partial<BlenderSettings>;
  smudge?: Partial<SmudgeSettings>;
  wet?: Partial<WetBrushSettings>;
};

/** Whether a brush can pick paint up from the canvas (the pick-up / mix ratios apply): dab, mixer and wet brushes. */
export function isWetCapable(brush: Pick<PaintBrush, 'engine'>): boolean {
  return brush.engine === 'dab' || brush.engine === 'mixer' || brush.engine === 'wet';
}

/** Whether a brush paints wet media (on the layer's wet layer). */
export function isWetBrush(brush: Pick<PaintBrush, 'engine'>): boolean {
  return brush.engine === 'wet';
}

/**
 * Whether a dab brush paints dab by dab through the exchange (it picks up paint or is
 * multi-coloured) instead of building one coverage buffer of one colour.
 */
export function usesPaintExchange(brush: PaintBrush): boolean {
  return brush.engine === 'dab' && (brush.behavior.pickup > 0 || brush.behavior.multicolor.mode !== 'off');
}

/** A brush with every field in range; missing fields come from `base` (default: a plain round dab brush). */
export function normalizePaintBrush(raw: PaintBrushInput = {}, base?: PaintBrush): PaintBrush {
  const b = base ?? BASE_BRUSH;
  const id = typeof raw.id === 'string' && BRUSH_ID.test(raw.id) ? raw.id : b.id;
  const engine = PAINT_BRUSH_ENGINES.includes(raw.engine as PaintBrushEngine) ? (raw.engine as PaintBrushEngine) : b.engine;
  // A Mixer Brush's pick-up / mix ratios, dirtiness and mixing are its mixer settings: behaviour
  // changes are written into the mixer, then the behaviour is read back from it.
  const rb = raw.behavior ?? {};
  const mixerIn: Partial<MixerSettings> = { ...b.mixer, ...(raw.mixer ?? {}) };
  if (engine === 'mixer') {
    if (rb.pickup !== undefined) mixerIn.wet = rb.pickup;
    if (rb.mix !== undefined) mixerIn.mix = rb.mix;
    if (rb.dirty !== undefined) mixerIn.cleanEachStroke = !rb.dirty;
    if (rb.mixing !== undefined) mixerIn.mixing = rb.mixing;
  }
  const mixer = normalizeMixer(mixerIn);
  let behavior = normalizeBehavior(rb, b.behavior);
  if (engine === 'mixer') behavior = { ...behavior, pickup: mixer.wet, mix: mixer.mix, dirty: !mixer.cleanEachStroke, mixing: mixer.mixing };
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : b.name,
    category: PAINT_BRUSH_CATEGORIES.includes(raw.category as PaintBrushCategory) ? (raw.category as PaintBrushCategory) : b.category,
    engine,
    tip: normalizeBrush({ ...b.tip, ...(raw.tip ?? {}) }),
    grain: unit(raw.grain, b.grain),
    pressureSmoothing: range(raw.pressureSmoothing, 0, 0.95, b.pressureSmoothing),
    rotation: BRUSH_ROTATIONS.includes(raw.rotation as BrushRotation) ? (raw.rotation as BrushRotation) : b.rotation,
    dynamics: normalizeDynamics(raw.dynamics ?? {}, b.dynamics),
    mixer,
    loadsColor: typeof raw.loadsColor === 'boolean' ? raw.loadsColor : b.loadsColor,
    behavior,
    blender: normalizeBlender(raw.blender ?? {}, b.blender),
    smudge: normalizeSmudge(raw.smudge ?? {}, b.smudge),
    wet: normalizeWetBrush(raw.wet ?? {}, b.wet ?? DEFAULT_WET_BRUSH),
    ...(raw.builtin ? { builtin: true } : {}),
  };
}

const BASE_BRUSH: PaintBrush = {
  id: 'round',
  name: 'Round',
  category: 'custom',
  engine: 'dab',
  tip: { ...DEFAULT_BRUSH },
  grain: 0,
  pressureSmoothing: 0,
  rotation: 'fixed',
  dynamics: { ...DEFAULT_DYNAMICS },
  mixer: { ...DEFAULT_MIXER },
  loadsColor: true,
  behavior: { ...DEFAULT_BEHAVIOR, multicolor: { ...DEFAULT_MULTI_COLOR, colors: [] } },
  blender: { ...DEFAULT_BLENDER },
  smudge: { ...DEFAULT_SMUDGE },
  wet: { ...DEFAULT_WET_BRUSH },
};

type BrushInit = PaintBrushInput & { id: string; name: string; category: PaintBrushCategory };

const builtin = (init: BrushInit): PaintBrush => ({ ...normalizePaintBrush(init), builtin: true });

/** The built-in brush library. */
export const BUILTIN_BRUSHES: readonly PaintBrush[] = [
  builtin({
    id: 'pencil-hb', name: 'HB pencil', category: 'pencil',
    tip: { size: 4, hardness: 0.7, spacing: 0.08, opacity: 0.85, flow: 0.55, smoothing: 0.25, pressureSize: true, pressureOpacity: true },
    grain: 0.85, pressureSmoothing: 0.3,
    dynamics: { minSize: 0.55, tiltSize: 0.9, tiltRoundness: 0.7, tiltOpacity: 0.5 },
  }),
  builtin({
    id: 'pencil-6b', name: '6B pencil', category: 'pencil',
    tip: { size: 7, hardness: 0.55, spacing: 0.07, opacity: 1, flow: 0.75, smoothing: 0.2, pressureSize: true, pressureOpacity: true },
    grain: 0.7, pressureSmoothing: 0.3,
    dynamics: { minSize: 0.5, tiltSize: 1, tiltRoundness: 0.75, tiltOpacity: 0.35 },
  }),
  builtin({
    id: 'soft-pastel', name: 'Soft pastel', category: 'pastel', rotation: 'stroke',
    tip: { size: 32, hardness: 0.55, spacing: 0.05, angle: 90, roundness: 0.55, opacity: 1, flow: 0.7, smoothing: 0.15, pressureSize: false, pressureOpacity: true },
    grain: 1, pressureSmoothing: 0.25,
    dynamics: { sizeJitter: 0.06, angleJitter: 0.02 },
  }),
  builtin({
    id: 'oil-pastel', name: 'Oil pastel', category: 'pastel', rotation: 'stroke',
    tip: { size: 26, hardness: 0.8, spacing: 0.05, angle: 90, roundness: 0.7, opacity: 1, flow: 0.9, smoothing: 0.15, pressureSize: true, pressureOpacity: false, blend: 'pigment' },
    grain: 0.5, pressureSmoothing: 0.25,
    dynamics: { minSize: 0.6 },
  }),
  builtin({
    id: 'charcoal-stick', name: 'Charcoal stick', category: 'charcoal', rotation: 'stroke',
    tip: { size: 26, hardness: 0.4, spacing: 0.05, angle: 90, roundness: 0.35, opacity: 0.95, flow: 0.5, smoothing: 0.15, pressureSize: false, pressureOpacity: true },
    grain: 0.95, pressureSmoothing: 0.2,
    dynamics: { sizeJitter: 0.1, angleJitter: 0.03, tiltSize: 0.6 },
  }),
  builtin({
    id: 'vine-charcoal', name: 'Vine charcoal', category: 'charcoal',
    tip: { size: 10, hardness: 0.3, spacing: 0.06, opacity: 0.75, flow: 0.45, smoothing: 0.2, pressureSize: true, pressureOpacity: true },
    grain: 0.9, pressureSmoothing: 0.2,
    dynamics: { minSize: 0.4, tiltSize: 0.8, tiltRoundness: 0.5, tiltOpacity: 0.3, sizeJitter: 0.08 },
  }),
  builtin({
    id: 'airbrush', name: 'Airbrush', category: 'airbrush',
    tip: { size: 90, hardness: 0, spacing: 0.04, opacity: 1, flow: 0.06, smoothing: 0.3, pressureSize: false, pressureOpacity: false },
    grain: 0, pressureSmoothing: 0.3,
    dynamics: { pressureFlow: 1, tiltSize: 0.5, tiltRoundness: 0.6 },
  }),
  builtin({
    id: 'marker', name: 'Chisel marker', category: 'marker',
    tip: { size: 24, hardness: 0.85, spacing: 0.04, angle: 45, roundness: 0.35, opacity: 0.6, flow: 1, smoothing: 0.3, pressureSize: false, pressureOpacity: false, blend: 'multiply' },
    grain: 0.1,
  }),
  builtin({
    id: 'ink-pen', name: 'Ink pen', category: 'ink',
    tip: { size: 4, hardness: 1, spacing: 0.05, opacity: 1, flow: 1, smoothing: 0.5, pressureSize: true, pressureOpacity: false },
    pressureSmoothing: 0.4,
    dynamics: { minSize: 0.25, velocitySize: -0.45 },
  }),
  builtin({
    id: 'brush-pen', name: 'Brush pen', category: 'ink', rotation: 'stroke',
    tip: { size: 14, hardness: 0.9, spacing: 0.04, roundness: 0.8, opacity: 1, flow: 1, smoothing: 0.5, pressureSize: true, pressureOpacity: false },
    pressureSmoothing: 0.45,
    dynamics: { minSize: 0.05, velocitySize: -0.3 },
  }),
  builtin({
    id: 'eraser-soft', name: 'Soft eraser', category: 'eraser', engine: 'eraser',
    tip: { size: 40, hardness: 0.2, spacing: 0.08, opacity: 1, flow: 0.6, pressureSize: false, pressureOpacity: true },
  }),
  builtin({
    id: 'eraser-hard', name: 'Hard eraser', category: 'eraser', engine: 'eraser',
    tip: { size: 16, hardness: 0.9, spacing: 0.06, opacity: 1, flow: 1, pressureSize: true, pressureOpacity: false },
    grain: 0.3,
    dynamics: { minSize: 0.5 },
  }),
  builtin({
    id: 'blender', name: 'Blender', category: 'blender', engine: 'blender', loadsColor: false,
    tip: { size: 34, hardness: 0.4, spacing: 0.1, opacity: 1, flow: 1, smoothing: 0.2, pressureSize: false, pressureOpacity: true },
    blender: { strength: 0.5, distance: 0.35, mixing: 'pigment' },
  }),
  builtin({
    id: 'smudge', name: 'Smudge', category: 'smudge', engine: 'smudge', loadsColor: false,
    tip: { size: 26, hardness: 0.6, spacing: 0.06, opacity: 1, flow: 1, smoothing: 0.2, pressureSize: false, pressureOpacity: true },
    smudge: { strength: 0.75, length: 0.85, mixing: 'rgb' },
  }),
  builtin({
    id: 'wet-smudge', name: 'Pigment smudge', category: 'smudge', engine: 'smudge', loadsColor: false,
    tip: { size: 30, hardness: 0.5, spacing: 0.06, opacity: 1, flow: 1, smoothing: 0.2, pressureSize: true, pressureOpacity: true },
    smudge: { strength: 0.7, length: 0.9, mixing: 'pigment' },
    dynamics: { minSize: 0.6 },
  }),
  builtin({
    id: 'dirty-round', name: 'Dirty round', category: 'paint',
    tip: { size: 22, hardness: 0.65, spacing: 0.06, opacity: 1, flow: 0.7, smoothing: 0.2, pressureSize: true, pressureOpacity: false },
    behavior: { pickup: 0.55, mix: 0.6, dirty: true, mixing: 'pigment' },
    dynamics: { minSize: 0.5 },
  }),
  builtin({
    id: 'multicolor-flat', name: 'Multi-colour flat', category: 'paint', rotation: 'stroke',
    tip: { size: 30, hardness: 0.75, spacing: 0.05, angle: 90, roundness: 0.3, opacity: 1, flow: 0.85, smoothing: 0.2, pressureSize: true, pressureOpacity: false },
    behavior: { pickup: 0.15, mix: 0.4, mixing: 'pigment', multicolor: { mode: 'tip', softness: 0.7 } },
    dynamics: { minSize: 0.6 },
  }),
  builtin({
    id: 'palette-dabber', name: 'Palette dabber', category: 'paint',
    tip: { size: 18, hardness: 0.7, spacing: 0.35, opacity: 1, flow: 0.9, smoothing: 0.1, pressureSize: true, pressureOpacity: false },
    behavior: { multicolor: { mode: 'dab', order: 'sequence', length: 6, softness: 0.4 } },
    dynamics: { minSize: 0.5, sizeJitter: 0.15, scatter: 0.3 },
  }),
  builtin({
    id: 'mixer-brush', name: 'Mixer Brush', category: 'mixer', engine: 'mixer',
    tip: { size: 30, hardness: 0.7, spacing: 0.1, opacity: 1, flow: 0.5, smoothing: 0.2, pressureSize: true, pressureOpacity: false },
    mixer: { wet: 0.5, load: 0.95, mix: 0.5, loadEachStroke: true, cleanEachStroke: true, mixing: 'pigment' },
    dynamics: { minSize: 0.5 },
  }),
  builtin({
    id: 'watercolor-round', name: 'Watercolour round', category: 'watercolor', engine: 'wet',
    tip: { size: 28, hardness: 0.6, spacing: 0.12, opacity: 1, flow: 1, smoothing: 0.25, pressureSize: true, pressureOpacity: true },
    dynamics: { minSize: 0.35 },
    behavior: { pickup: 0.3, mix: 0.4, mixing: 'pigment' },
    wet: { tool: 'paint', water: 0.55, pigment: 0.5, body: 0 },
  }),
  builtin({
    id: 'watercolor-wash', name: 'Wash brush', category: 'watercolor', engine: 'wet', rotation: 'stroke',
    tip: { size: 90, hardness: 0.35, spacing: 0.1, angle: 90, roundness: 0.45, opacity: 1, flow: 1, smoothing: 0.3, pressureSize: false, pressureOpacity: true },
    behavior: { pickup: 0.2, mix: 0.3, mixing: 'pigment' },
    wet: { tool: 'paint', water: 0.8, pigment: 0.45, body: 0 },
  }),
  builtin({
    id: 'watercolor-detail', name: 'Watercolour rigger', category: 'watercolor', engine: 'wet',
    tip: { size: 7, hardness: 0.75, spacing: 0.1, opacity: 1, flow: 1, smoothing: 0.4, pressureSize: true, pressureOpacity: false },
    dynamics: { minSize: 0.2 },
    wet: { tool: 'paint', water: 0.4, pigment: 0.7, body: 0 },
  }),
  builtin({
    id: 'gouache', name: 'Gouache', category: 'watercolor', engine: 'wet',
    tip: { size: 26, hardness: 0.7, spacing: 0.1, opacity: 1, flow: 1, smoothing: 0.25, pressureSize: true, pressureOpacity: false },
    dynamics: { minSize: 0.5 },
    behavior: { pickup: 0.35, mix: 0.5, mixing: 'pigment' },
    wet: { tool: 'paint', water: 0.35, pigment: 0.8, body: 1 },
  }),
  builtin({
    id: 'add-water', name: 'Add water', category: 'wet-tool', engine: 'wet',
    tip: { size: 40, hardness: 0.4, spacing: 0.12, opacity: 1, flow: 1, smoothing: 0.25, pressureSize: true, pressureOpacity: true },
    dynamics: { minSize: 0.5 },
    wet: { tool: 'water', water: 0.6, pigment: 0, rewet: 0.3 },
  }),
  builtin({
    id: 'hair-dryer', name: 'Dry', category: 'wet-tool', engine: 'wet',
    tip: { size: 80, hardness: 0.1, spacing: 0.15, opacity: 1, flow: 1, smoothing: 0.3, pressureSize: false, pressureOpacity: true },
    wet: { tool: 'dry', strength: 0.5 },
  }),
  builtin({
    id: 'blow', name: 'Blow', category: 'wet-tool', engine: 'wet',
    tip: { size: 50, hardness: 0.2, spacing: 0.1, opacity: 1, flow: 1, smoothing: 0.3, pressureSize: false, pressureOpacity: true },
    wet: { tool: 'blow', strength: 0.6 },
  }),
  builtin({
    id: 'wet-blend', name: 'Wet blend', category: 'wet-tool', engine: 'wet',
    tip: { size: 36, hardness: 0.3, spacing: 0.1, opacity: 1, flow: 1, smoothing: 0.25, pressureSize: false, pressureOpacity: true },
    wet: { tool: 'blend', strength: 0.4 },
  }),
  builtin({
    id: 'wet-drag', name: 'Wet smudge', category: 'wet-tool', engine: 'wet',
    tip: { size: 30, hardness: 0.5, spacing: 0.08, opacity: 1, flow: 1, smoothing: 0.25, pressureSize: false, pressureOpacity: true },
    wet: { tool: 'smudge', strength: 0.6 },
  }),
  builtin({
    id: 'blot', name: 'Blot (erase wet)', category: 'wet-tool', engine: 'wet',
    tip: { size: 40, hardness: 0.5, spacing: 0.12, opacity: 1, flow: 1, smoothing: 0.2, pressureSize: false, pressureOpacity: true },
    wet: { tool: 'blot', strength: 0.7 },
  }),
];

export const DEFAULT_BRUSH_ID = 'pencil-6b';

export { MAX_BRUSH_SIZE };

/** A brush as plain JSON (for export, agents and saved libraries): no `builtin` flag. */
export function brushToJSON(brush: PaintBrush): Omit<PaintBrush, 'builtin'> {
  const { builtin: _b, ...rest } = brush;
  return JSON.parse(JSON.stringify(rest));
}

/** The JSON file a brush library exports to and imports from. */
export interface BrushLibraryFile {
  format: 'pixerate-brushes';
  version: 1;
  brushes: Array<Omit<PaintBrush, 'builtin'>>;
}

/**
 * Brushes read from a brush library file (or a bare array of brushes). Each is normalised; ones
 * without a valid id or name are reported in `problems` and skipped.
 */
export function parseBrushLibrary(raw: unknown, problems: string[] = []): PaintBrush[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as BrushLibraryFile).brushes) ? (raw as BrushLibraryFile).brushes : null;
  if (!list) throw new Error('Not a brush library: expected {"format":"pixerate-brushes","version":1,"brushes":[...]} or an array of brushes.');
  const out: PaintBrush[] = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      problems.push(`brushes[${i}] is not an object; skipped.`);
      return;
    }
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || !BRUSH_ID.test(r.id)) {
      problems.push(`brushes[${i}] has no valid id (lowercase letters, digits and dashes); skipped.`);
      return;
    }
    if (typeof r.name !== 'string' || !r.name.trim()) {
      problems.push(`brushes[${i}] ("${r.id}") has no name; skipped.`);
      return;
    }
    const { builtin: _b, ...rest } = r;
    out.push(normalizePaintBrush(rest as PaintBrushInput));
  });
  return out;
}
