/**
 * The flat engine brush (`PaintBrush`) the paint engine reads, its settings and
 * `normalizePaintBrush`. Kept apart from the built-in library (`./brushes`) so the facet
 * resolver (`brushes/resolve`) can import it while `BUILTIN_BRUSHES` resolves the facet presets.
 */

import { DEFAULT_BRUSH, normalizeBrush, type BrushSettings } from '../paint/brush';
import { DEFAULT_BLENDER, DEFAULT_SMUDGE, normalizeBlender, normalizeSmudge, type BlenderSettings, type SmudgeSettings } from '../paint/blending';
import type { MixingModel } from '../paint/exchange';
import { readPaintSource, type PaintGradientSource, type PaintSource } from '../paint/gradient-paint';
import { DEFAULT_MIXER, normalizeMixer, type MixerSettings } from '../paint/mixer';
import {
  DEFAULT_LIVE_PATTERNS,
  LIVE_PATTERN_KINDS,
  LIVE_PATTERN_PRESETS,
  normalizeLivePatterns,
  type LivePatternKind,
  type LivePatternsInput,
  type LivePatternsSettings,
} from '../paint/live-patterns';
import {
  CULTURE_SPECIES,
  DEFAULT_CULTURE,
  normalizeCulture,
  type CultureSettings,
  type CultureSpecies,
} from '../paint/culture';
import { DEFAULT_BRISTLE, DEFAULT_PARTICLE, DEFAULT_STICKER, normalizeBristle, normalizeParticle, normalizeStickerSettings, STAMP_KINDS, type BristleSettings, type ParticleSettings, type StickerSettings } from './mark-settings';

export { DEFAULT_LIVE_PATTERNS, LIVE_PATTERN_KINDS, LIVE_PATTERN_PRESETS, normalizeLivePatterns, type LivePatternKind, type LivePatternsInput, type LivePatternsSettings };
export { CULTURE_SPECIES, DEFAULT_CULTURE, normalizeCulture, type CultureSettings, type CultureSpecies };

/**
 * How a brush makes marks: `dab` (dabs into a stroke buffer, or dab by dab through the pick-up /
 * mix exchange when its behaviour asks for it), `eraser` (removes alpha), `mixer` (the Mixer
 * Brush), `blender` (mixes the colours under and near the tip) or `smudge` (drags paint along).
 */
export type PaintBrushEngine = 'dab' | 'eraser' | 'mixer' | 'blender' | 'smudge' | 'wet' | 'impasto' | 'particle' | 'bristle' | 'sticker';

export const PAINT_BRUSH_ENGINES: readonly PaintBrushEngine[] = ['dab', 'eraser', 'mixer', 'blender', 'smudge', 'wet', 'impasto', 'particle', 'bristle', 'sticker'];

export type PaintBrushCategory = 'pencil' | 'pastel' | 'charcoal' | 'airbrush' | 'marker' | 'ink' | 'paint' | 'eraser' | 'blender' | 'smudge' | 'mixer' | 'watercolor' | 'wet-tool' | 'oil' | 'impasto' | 'procedural' | 'bristle' | 'sticker' | 'light' | 'custom';

export const PAINT_BRUSH_CATEGORIES: readonly PaintBrushCategory[] = ['pencil', 'pastel', 'charcoal', 'airbrush', 'marker', 'ink', 'paint', 'eraser', 'blender', 'smudge', 'mixer', 'watercolor', 'wet-tool', 'oil', 'impasto', 'procedural', 'bristle', 'sticker', 'light', 'custom'];

/**
 * What a wet brush does to the wet layer: `paint` (water and pigment), `water` (clear water;
 * with `rewet` it lifts dried paint), `dry` (a hair dryer: takes water, the pigment settles),
 * `blow` (pushes the water along the stroke), `blend` (evens out the wet pigment under the tip),
 * `smudge` (drags wet paint along) or `blot` (a tissue: takes up wet paint).
 */
export type WetTool = 'paint' | 'water' | 'dry' | 'blow' | 'blend' | 'smudge' | 'blot';

export const WET_TOOLS: readonly WetTool[] = ['paint', 'water', 'dry', 'blow', 'blend', 'smudge', 'blot'];

/**
 * The wet medium a wet brush paints: its layer takes the medium's wet settings the first time it
 * holds wet paint (`watercolor`: runny, dries in seconds, granulates and darkens at edges;
 * `gouache`: opaque, flatter; `oil`: thick, barely flows, stays wet for a long time and blends into
 * the wet paint it meets).
 */
export type WetMediumKind = 'watercolor' | 'gouache' | 'oil';

export const WET_MEDIA: readonly WetMediumKind[] = ['watercolor', 'gouache', 'oil'];

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
  /** The medium (its layer's wet settings the first time it holds wet paint). */
  medium: WetMediumKind;
  /** Paint loading: 1 never runs out; lower, the brush runs dry along a long stroke (reload each stroke). */
  load: number;
  /** Thinner (water for watercolour, solvent for oil): thins the paint, so it is more transparent and runnier. */
  thinner: number;
}

export const DEFAULT_WET_BRUSH: Readonly<WetBrushSettings> = { tool: 'paint', water: 0.5, pigment: 0.5, body: 0, strength: 0.5, rewet: 0, medium: 'watercolor', load: 1, thinner: 0 };

export function normalizeWetBrush(raw: Partial<WetBrushSettings> = {}, base: WetBrushSettings = DEFAULT_WET_BRUSH): WetBrushSettings {
  return {
    tool: WET_TOOLS.includes(raw.tool as WetTool) ? (raw.tool as WetTool) : base.tool,
    water: unit(raw.water, base.water),
    pigment: unit(raw.pigment, base.pigment),
    body: unit(raw.body, base.body),
    strength: unit(raw.strength, base.strength),
    rewet: unit(raw.rewet, base.rewet),
    medium: WET_MEDIA.includes(raw.medium as WetMediumKind) ? (raw.medium as WetMediumKind) : (base.medium ?? 'watercolor'),
    load: unit(raw.load, base.load ?? 1),
    thinner: unit(raw.thinner, base.thinner ?? 0),
  };
}

/**
 * What an impasto brush does on a thick-paint layer: `brush` (paint with body: colour and relief),
 * `tube` (squeezes blobs of paint straight from the tube), `knife` (a palette knife: scrapes the
 * relief flat and smears the paint along), `roller` (a flat, even band with a stipple), `gloop`
 * (a thick, glossy, rounded line).
 */
export type ImpastoTool = 'brush' | 'tube' | 'knife' | 'roller' | 'gloop';

export const IMPASTO_TOOLS: readonly ImpastoTool[] = ['brush', 'tube', 'knife', 'roller', 'gloop'];

/** Impasto engine settings, each 0..1. */
export interface ImpastoSettings {
  tool: ImpastoTool;
  /** How thick the paint stands up (relief per stroke). */
  thickness: number;
  /** Shine of the paint when lit (0 matte .. 1 wet-looking gloss). */
  gloss: number;
  /** Metallic paint: highlights take the paint's colour (gold, copper, silver). */
  metallic: number;
  /** Paint loading: 1 never runs out; lower, the stroke thins and fades as the brush empties. */
  load: number;
  /** Thinner: flatter, more transparent paint that levels out. */
  thinner: number;
  /** Knife and brush: how much of the paint under the tool is dragged along (0..1). */
  drag: number;
  /** Light paint: the bead's light is stronger where its surface turns away, as on backlit glass (0..1, default 0). */
  rim: number;
  /** Light paint: the middle of a bead lets the layers below show through, its edges stay solid (0..1, default 0). */
  clarity: number;
}

export const DEFAULT_IMPASTO: Readonly<ImpastoSettings> = { tool: 'brush', thickness: 0.6, gloss: 0.4, metallic: 0, load: 0.9, thinner: 0, drag: 0.4, rim: 0, clarity: 0 };

/** Light paint: how much light a brush lays with its colour (see `doc.light`). */
export interface LightSettings {
  /** Light each dab lays, scaled by its coverage and flow (0..1, default 0: none). */
  amount: number;
  /** Pressure scales the light (default false). */
  pressure: boolean;
}

export const DEFAULT_LIGHT: Readonly<LightSettings> = { amount: 0, pressure: false };

export function normalizeLight(raw: Partial<LightSettings> = {}, base: LightSettings = DEFAULT_LIGHT): LightSettings {
  return { amount: unit(raw.amount, base.amount), pressure: typeof raw.pressure === 'boolean' ? raw.pressure : base.pressure };
}

/** UV-fluorescent ink: paint that glows in its colour under the UV blacklight (`doc.fluor`). */
export interface FluorescenceSettings {
  /** Fluorescence intensity under UV blacklight (0..1, default 0: none). */
  amount: number;
  /** Invisible ink in normal light: lays no daylight pigment and glows only under UV (default false). */
  invisible: boolean;
}

export const DEFAULT_FLUORESCENCE: Readonly<FluorescenceSettings> = { amount: 0, invisible: false };

export function normalizeFluorescence(raw: Partial<FluorescenceSettings> | number = {}, base: FluorescenceSettings = DEFAULT_FLUORESCENCE): FluorescenceSettings {
  if (typeof raw === 'number') return { amount: unit(raw, base.amount), invisible: base.invisible };
  return {
    amount: unit(raw.amount, base.amount),
    invisible: typeof raw.invisible === 'boolean' ? raw.invisible : base.invisible,
  };
}

/** Thermochromic ink: paint that shifts toward `hotColor` where the canvas is heated above `threshold` (`doc.thermo`). */
export interface ThermochromicSettings {
  /** Colour (#rrggbb) the ink turns when heated above `threshold` (`null`: off). */
  hotColor: string | null;
  /** Temperature 0.05..0.95 at which the colour shift is halfway (default 0.5). */
  threshold: number;
}

export const DEFAULT_THERMOCHROMIC: Readonly<ThermochromicSettings> = { hotColor: null, threshold: 0.5 };

export function normalizeThermochromic(raw: Partial<ThermochromicSettings> = {}, base: ThermochromicSettings = DEFAULT_THERMOCHROMIC): ThermochromicSettings {
  const hotColor = raw.hotColor === null ? null : typeof raw.hotColor === 'string' && HEX.test(raw.hotColor.trim()) ? raw.hotColor.trim().toLowerCase() : base.hotColor;
  return {
    hotColor,
    threshold: range(raw.threshold, 0.05, 0.95, base.threshold),
  };
}

/** Thin-film iridescence: structural colour whose hue shifts with the light and view angle (see `doc.thick`). */
export interface IridescenceSettings {
  /** Film thickness in nanometres (100..1000, default 400). */
  thickness: number;
  /** How much pen pressure shifts the film thickness (0..1, default 0). */
  pressureToThickness: number;
  /** Film refractive index (1.2..2.0, default 1.5). */
  ior: number;
}

export const DEFAULT_IRIDESCENCE: Readonly<IridescenceSettings> = { thickness: 400, pressureToThickness: 0, ior: 1.5 };

const withIridescence = (ir: IridescenceSettings | null): { iridescence?: IridescenceSettings } => (ir ? { iridescence: ir } : {});

function readIridescence(raw: unknown, base: IridescenceSettings | null): IridescenceSettings | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<IridescenceSettings>;
  const b = base ?? DEFAULT_IRIDESCENCE;
  return {
    thickness: range(r.thickness, 100, 1000, b.thickness),
    pressureToThickness: unit(r.pressureToThickness, b.pressureToThickness),
    ior: range(r.ior, 1.2, 2.0, b.ior),
  };
}

/** When a ghost brush's fade starts: immediately (`immediate`, default) or once claimed by an agent (`agent`). */
export type GhostTrigger = 'immediate' | 'agent';
export const GHOST_TRIGGERS: readonly GhostTrigger[] = ['immediate', 'agent'];

/** Ghost paint: wet paint whose colour vanishes after `linger` seconds, leaving only what it smeared. */
export interface GhostSettings {
  /** Seconds of simulated time before the ghost paint has fully faded, 0.5..60 (default 4). */
  linger: number;
  /** How much the ghost paint drags and lifts the paint it passes through, 0..1 (default 0.3). */
  smear: number;
  /** When the fade starts: `immediate` (default, omitted) or `agent` (waits until claimed by `read_mutation`). */
  trigger?: GhostTrigger;
}

export const DEFAULT_GHOST: Readonly<GhostSettings> = { linger: 4, smear: 0.3 };

export function normalizeGhost(raw: Partial<GhostSettings> = {}, base: GhostSettings = DEFAULT_GHOST): GhostSettings {
  const trigger = raw.trigger === 'agent' || raw.trigger === 'immediate' ? raw.trigger : base.trigger;
  return {
    linger: range(raw.linger, 0.5, 60, base.linger),
    smear: unit(raw.smear, base.smear),
    ...(trigger === 'agent' ? { trigger: 'agent' } : {}),
  };
}

/** Mutation paint: your stroke sinks away once claimed by an agent, which paints its own answer. */
export interface MutationSettings {
  /** Seconds after the last stroke before it counts as finished, 0.5..10 (default 1.5). */
  settle: number;
  /** Seconds to wait for an agent before giving up and keeping the paint, 5..300 (default 45). */
  patience: number;
  /** Seconds the paint takes to sink away once claimed, 0.5..10 (default 2). */
  fade: number;
}

export const DEFAULT_MUTATION: Readonly<MutationSettings> = { settle: 1.5, patience: 45, fade: 2 };

export function normalizeMutation(raw: Partial<MutationSettings> = {}, base: MutationSettings = DEFAULT_MUTATION): MutationSettings {
  return {
    settle: range(raw.settle, 0.5, 10, base.settle),
    patience: range(raw.patience, 5, 300, base.patience),
    fade: range(raw.fade, 0.5, 10, base.fade),
  };
}

/** Ferrofluid paint: how much liquid ferrofluid a brush lays, and its Rosensweig spike settings (see `doc.ferro`). */
export interface FerroSettings {
  /** How much liquid ferrofluid each dab lays, scaled by coverage and flow (0..1, default 0: none). */
  amount: number;
  /** Capillary wavelength (spike-to-spike spacing) in pixels (4..64, default 16). */
  wavelength: number;
  /** Critical magnetic field |B| threshold where spikes begin to rise (0.01..0.95, default 0.12). */
  threshold: number;
}

export const DEFAULT_FERRO: Readonly<FerroSettings> = { amount: 0, wavelength: 16, threshold: 0.12 };

export function normalizeFerro(raw: number | Partial<FerroSettings> | null | undefined = {}, base: FerroSettings = DEFAULT_FERRO): FerroSettings {
  if (typeof raw === 'number') {
    return { amount: unit(raw, base.amount), wavelength: base.wavelength, threshold: base.threshold };
  }
  const r = raw ?? {};
  return {
    amount: unit(r.amount, base.amount),
    wavelength: range(r.wavelength, 4, 64, base.wavelength),
    threshold: range(r.threshold, 0.01, 0.95, base.threshold),
  };
}

export function normalizeImpasto(raw: Partial<ImpastoSettings> = {}, base: ImpastoSettings = DEFAULT_IMPASTO): ImpastoSettings {
  return {
    tool: IMPASTO_TOOLS.includes(raw.tool as ImpastoTool) ? (raw.tool as ImpastoTool) : base.tool,
    thickness: unit(raw.thickness, base.thickness),
    gloss: unit(raw.gloss, base.gloss),
    metallic: unit(raw.metallic, base.metallic),
    load: unit(raw.load, base.load),
    thinner: unit(raw.thinner, base.thinner),
    drag: unit(raw.drag, base.drag),
    rim: unit(raw.rim, base.rim ?? 0),
    clarity: unit(raw.clarity, base.clarity ?? 0),
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
  /** Dabs laid at each spacing step, 1..16, each with its own jitter (missing: 1). */
  count?: number;
  /** Mirror each dab at random across these axes (missing: `none`). */
  flip?: DabFlip;
}

/** Random mirroring of dabs. */
export type DabFlip = 'none' | 'x' | 'y' | 'xy';
export const DAB_FLIPS: readonly DabFlip[] = ['none', 'x', 'y', 'xy'];

export type TipGrainMode = 'moving' | 'texturised';
export const TIP_GRAIN_MODES: readonly TipGrainMode[] = ['moving', 'texturised'];

/** Texture inside the tip (dab engines): each dab's coverage is multiplied by it. */
export interface TipGrainSettings {
  /** A grain pattern (`rough`, `canvas`…) or an image source `source:<id>`. */
  source: string;
  /** `texturised` (default): fixed to the canvas; `moving`: rolls along with the tip. */
  mode: TipGrainMode;
  /** 0.05..20: 1 the source's own size (default 1). */
  scale: number;
  /** 0..1: how much it takes out of the dab (default 0.6). */
  depth: number;
  /** 0..3 around the middle (default 1). */
  contrast: number;
  invert: boolean;
}

export const DEFAULT_TIP_GRAIN: Readonly<Omit<TipGrainSettings, 'source'>> = { mode: 'texturised', scale: 1, depth: 0.6, contrast: 1, invert: false };

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
  /** Impasto engine only: the tool, thickness, gloss, metallic, loading, thinner and drag. */
  impasto: ImpastoSettings;
  /** Particle engine only: the particles' kind, how they are drawn, and their physics. */
  particle: ParticleSettings;
  /** Bristle engine only: the tuft. */
  bristle: BristleSettings;
  /** Sticker engine only: the stamps and how they are sprayed. */
  sticker: StickerSettings;
  /** Light paint: the light it lays with its colour (amount 0: none). */
  light: LightSettings;
  /** UV-fluorescent ink: glows under the virtual UV blacklight (amount 0: none). */
  fluorescence: FluorescenceSettings;
  /** Thermochromic ink: shifts toward `hotColor` where the canvas is heated (`hotColor: null`: off). */
  thermochromic: ThermochromicSettings;
  /** Thin-film iridescence: structural colour film laid over the paint (missing: none). */
  iridescence?: IridescenceSettings;
  /** Wet engine: ghost paint settings (missing when not a ghost brush). */
  ghost?: GhostSettings;
  /** Mutation paint settings (missing when not a mutation brush). */
  mutation?: MutationSettings;
  /** Ferrofluid paint: liquid ferrofluid it lays and its Rosensweig spike settings (amount 0: none). */
  ferro: FerroSettings;
  /**
   * Dab engine: a stamp tip. Each dab (and each spray droplet) is this sticker's shape, an editor
   * stamp (`editor:star`) or any sticker ref from the sticker library, laid in the paint colour;
   * `null` (default): the round computed tip.
   */
  stamp: string | null;
  /** Dab engine: spray marks. Each dab lays a seeded scatter of droplets across the tip; `null` (default): one mark per dab. */
  spray: SpraySettings | null;
  /** Dab engines: texture inside the tip (missing: none). Recorded with the stroke, source ref included, so replays match. */
  tipGrain?: TipGrainSettings;
  /** Wet engine: Gray-Scott reaction-diffusion pattern seeded into the wet paint (missing: none). */
  livePatterns?: LivePatternsSettings;
  /** Biopaint: living mycelial ink seeded along the stroke (missing: none). */
  culture?: CultureSettings;
  /**
   * The brush's own gradient paint (`@pixerate/editor/paint` `PaintGradientSource`), used instead
   * of the editor's paint; `null` (default): the editor's paint. Stops may be `paint` / `secondary`
   * (the editor's two colours). This is what the multi-colour brush became.
   */
  paint: PaintGradientSource | null;
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
    ...countAndFlip(raw, base),
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

/** `count` and `flip`, kept only when they are not the defaults (one dab, no flip), so brushes that don't use them read as before. */
function countAndFlip(raw: Partial<BrushDynamics>, base: BrushDynamics): Pick<BrushDynamics, 'count' | 'flip'> {
  const n = typeof raw.count === 'number' && Number.isFinite(raw.count) ? Math.min(16, Math.max(1, Math.round(raw.count))) : (base.count ?? 1);
  const flip = DAB_FLIPS.includes(raw.flip as DabFlip) ? (raw.flip as DabFlip) : (base.flip ?? 'none');
  return { ...(n > 1 ? { count: n } : {}), ...(flip !== 'none' ? { flip } : {}) };
}

const withTipGrain = (g: TipGrainSettings | null): { tipGrain?: TipGrainSettings } => (g ? { tipGrain: g } : {});
const withLivePatterns = (lp: LivePatternsSettings | null): { livePatterns?: LivePatternsSettings } => (lp ? { livePatterns: lp } : {});
const withCulture = (c: CultureSettings | null): { culture?: CultureSettings } => (c ? { culture: c } : {});

function readLivePatterns(raw: unknown, base: LivePatternsSettings | null): LivePatternsSettings | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return base;
  return normalizeLivePatterns(raw as LivePatternsInput, base ?? DEFAULT_LIVE_PATTERNS);
}

function readCulture(raw: unknown, base: CultureSettings | null): CultureSettings | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return base;
  return normalizeCulture(raw, base ?? DEFAULT_CULTURE);
}

/** Tip grain settings in range, `null` to clear, or `base` when `raw` is missing or has no usable source. */
function readTipGrain(raw: unknown, base: TipGrainSettings | null): TipGrainSettings | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<TipGrainSettings>;
  const source = typeof r.source === 'string' && /^\S{1,200}$/.test(r.source) ? r.source : base?.source;
  if (!source) return base;
  const b = base ?? { source, ...DEFAULT_TIP_GRAIN };
  return {
    source,
    mode: TIP_GRAIN_MODES.includes(r.mode as TipGrainMode) ? (r.mode as TipGrainMode) : b.mode,
    scale: range(r.scale, 0.05, 20, b.scale),
    depth: unit(r.depth, b.depth),
    contrast: range(r.contrast, 0, 3, b.contrast),
    invert: typeof r.invert === 'boolean' ? r.invert : b.invert,
  };
}

/** Brush settings to change or read: any subset of a brush and of its blocks. */
/** Spray marks (dab engine). */
export interface SpraySettings {
  /** Droplets per dab: 1 + density × 31 (0..1, default 0.5). */
  density: number;
  /** Droplet size as a fraction of the tip size, 0.02..1 (default 0.12). */
  size: number;
}

export const DEFAULT_SPRAY: Readonly<SpraySettings> = { density: 0.5, size: 0.12 };

/** A stamp tip's ref: an editor stamp or any `provider:id` sticker ref (a bare editor stamp reads as `editor:<stamp>`), or null. */
function readStamp(raw: unknown, base: string | null): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') return base;
  if ((STAMP_KINDS as readonly string[]).includes(raw)) return `editor:${raw}`;
  return /^[^:\s]+:\S+$/.test(raw) && raw.length <= 200 ? raw : base;
}

function readSpray(raw: unknown, base: SpraySettings | null): SpraySettings | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<SpraySettings>;
  const b = base ?? DEFAULT_SPRAY;
  return { density: unit(r.density, b.density), size: range(r.size, 0.02, 1, b.size) };
}

export type PaintBrushInput = Partial<Omit<PaintBrush, 'tip' | 'dynamics' | 'mixer' | 'behavior' | 'blender' | 'smudge' | 'wet' | 'impasto' | 'particle' | 'bristle' | 'sticker' | 'paint' | 'light' | 'fluorescence' | 'thermochromic' | 'iridescence' | 'ghost' | 'mutation' | 'ferro' | 'spray' | 'tipGrain' | 'livePatterns' | 'culture'>> & {
  spray?: Partial<SpraySettings> | null;
  /** Tip grain (`null` removes it). */
  tipGrain?: Partial<TipGrainSettings> | null;
  /** Ghost paint (`null` removes it). */
  ghost?: Partial<GhostSettings> | null;
  /** Mutation paint (`null` removes it). */
  mutation?: Partial<MutationSettings> | null;
  /** Live reaction-diffusion patterns (`null` removes it). */
  livePatterns?: LivePatternsInput | null;
  /** Biopaint culture settings (`null` removes it). */
  culture?: Partial<CultureSettings> | null;
  light?: Partial<LightSettings>;
  fluorescence?: Partial<FluorescenceSettings> | number;
  thermochromic?: Partial<ThermochromicSettings>;
  /** Thin-film iridescence (`null` removes it). */
  iridescence?: Partial<IridescenceSettings> | null;
  ferro?: number | Partial<FerroSettings>;
  /** A gradient (or `null` for the editor's paint); a plain colour source clears it. */
  paint?: PaintSource | null;
  tip?: Partial<BrushSettings>;
  dynamics?: Partial<BrushDynamics>;
  mixer?: Partial<MixerSettings>;
  behavior?: BrushBehaviorInput;
  blender?: Partial<BlenderSettings>;
  smudge?: Partial<SmudgeSettings>;
  wet?: Partial<WetBrushSettings>;
  impasto?: Partial<ImpastoSettings>;
  particle?: Partial<ParticleSettings>;
  bristle?: Partial<BristleSettings>;
  sticker?: Partial<StickerSettings>;
};

/** Whether a brush can pick paint up from the canvas (the pick-up / mix ratios apply): dab, mixer and wet brushes. */
export function isWetCapable(brush: Pick<PaintBrush, 'engine'>): boolean {
  return brush.engine === 'dab' || brush.engine === 'mixer' || brush.engine === 'wet' || brush.engine === 'impasto';
}

/** Whether a brush paints wet media (on the layer's wet layer). */
export function isWetBrush(brush: Pick<PaintBrush, 'engine'>): boolean {
  return brush.engine === 'wet';
}

/**
 * Whether a dab brush paints dab by dab through the exchange (it picks up paint or paints a
 * gradient) instead of building one coverage buffer of one colour.
 */
export function usesPaintExchange(brush: PaintBrush, gradient = brush.paint !== null): boolean {
  return brush.engine === 'dab' && (brush.behavior.pickup > 0 || gradient);
}

/** Whether strokes of a brush paint colour, so gradient paint applies (not erasers, blenders, smudges or the wet tools other than paint). */
export function brushTakesPaint(brush: Pick<PaintBrush, 'engine' | 'loadsColor' | 'wet'>): boolean {
  if (brush.engine === 'eraser' || brush.engine === 'blender' || brush.engine === 'smudge') return false;
  if (brush.engine === 'wet') return brush.wet.tool === 'paint';
  if (brush.engine === 'mixer') return brush.loadsColor;
  return true;
}

/**
 * The multi-colour settings a gradient paints the same as (the inverse of `multiColorToPaint`), or
 * `null` when the gradient has no multi-colour equivalent. Brushes report it as
 * `behavior.multicolor`, so older readers keep working.
 */
export function paintToMultiColor(g: PaintGradientSource | null): MultiColorSettings | null {
  if (!g || g.space === 'oklab' || g.stops.some((s) => s.opacity !== undefined || s.midpoint !== undefined)) return null;
  const colors = g.stops.map((s) => s.color);
  const own = (list: string[]) => (list.length === 2 && list[0] === 'paint' && list[1] === 'secondary' ? [] : list.some((c) => c === 'paint' || c === 'secondary') ? null : list);
  const uniform = (n: number) => g.stops.every((s, k) => s.offset === k / n);
  const softness = g.softness ?? 1;
  if (g.map.by === 'across-tip' && colors.length <= 8 && uniform(colors.length - 1)) {
    const c = own(colors);
    return c ? { mode: 'tip', colors: c, order: 'sequence', length: DEFAULT_MULTI_COLOR.length, softness } : null;
  }
  if (g.map.by === 'random' && colors.length % 2 === 0 && colors.length <= 16) {
    const n = colors.length / 2;
    const pairs = Array.from({ length: n }, (_, k) => colors[2 * k]);
    const hard = g.stops.every((s, i) => s.offset === (Math.floor(i / 2) + (i % 2)) / n && s.color === pairs[Math.floor(i / 2)]);
    const c = hard ? own(pairs) : null;
    return c ? { mode: 'dab', colors: c, order: 'random', length: g.map.every ?? 1, softness } : null;
  }
  if (g.map.by === 'distance' && g.map.unit === 'dabs' && g.map.repeat === 'repeat' && colors.length >= 3 && colors.length <= 9 && colors[0] === colors[colors.length - 1] && uniform(colors.length - 1)) {
    const n = colors.length - 1;
    const c = own(colors.slice(0, n));
    const length = g.map.length / n;
    return c && Number.isInteger(length) ? { mode: 'dab', colors: c, order: 'sequence', length, softness } : null;
  }
  return null;
}

/**
 * The gradient paint a multi-coloured brush (`behavior.multicolor`, before gradient paint) paints
 * the same pixels with: `tip` → `across-tip`; `dab` in sequence → `distance` in dabs, repeating
 * through the colours and back to the first; `dab` at random → `random` per run of dabs, with hard
 * stops. Without 2 colours of its own it uses the editor's paint and second colours.
 */
export function multiColorToPaint(mc: MultiColorSettings, mixing: MixingModel): PaintGradientSource | null {
  if (mc.mode === 'off') return null;
  const colors = mc.colors.length >= 2 ? mc.colors : ['paint', 'secondary'];
  const n = colors.length;
  const space = mixing === 'rgb' ? 'srgb' : 'pigment';
  const soft = mc.softness < 1 ? { softness: mc.softness } : {};
  if (mc.mode === 'tip') return { type: 'gradient', stops: colors.map((color, k) => ({ offset: k / (n - 1), color })), space, map: { by: 'across-tip' }, ...soft };
  if (mc.order === 'random') {
    const stops = colors.flatMap((color, k) => [
      { offset: k / n, color },
      { offset: (k + 1) / n, color },
    ]);
    return { type: 'gradient', stops, space, map: { by: 'random', every: mc.length } };
  }
  return { type: 'gradient', stops: [...colors, colors[0]].map((color, k) => ({ offset: k / n, color })), space, map: { by: 'distance', length: mc.length * n, repeat: 'repeat', unit: 'dabs' }, ...soft };
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
  // Gradient paint: given (a plain colour or null clears it), or the multi-colour settings of
  // older brushes and tools, merged into what the brush's gradient amounts to.
  let paint: PaintGradientSource | null = b.paint ?? null;
  if (raw.paint !== undefined) {
    const p = readPaintSource(raw.paint);
    paint = p && p.type === 'gradient' ? p : null;
  } else if (rb.multicolor !== undefined) {
    const mc = normalizeMultiColor(rb.multicolor, paintToMultiColor(paint) ?? DEFAULT_MULTI_COLOR);
    paint = mc.mode === 'off' ? (paintToMultiColor(paint) ? null : paint) : multiColorToPaint(mc, behavior.mixing);
  }
  // `behavior.multicolor` is a read-only view of the gradient, for older readers.
  behavior = { ...behavior, multicolor: paintToMultiColor(paint) ?? { ...DEFAULT_MULTI_COLOR, colors: [] } };
  const wet = normalizeWetBrush(raw.wet ?? {}, b.wet ?? DEFAULT_WET_BRUSH);
  const wantsLight = typeof raw.light?.amount === 'number' && raw.light.amount > 0;
  const canMutate = engine === 'dab' || (engine === 'wet' && wet.tool === 'paint') || engine === 'impasto' || engine === 'particle' || engine === 'bristle';
  const mutation =
    canMutate && (raw.mutation !== undefined ? raw.mutation !== null : Boolean(b.mutation))
      ? normalizeMutation(raw.mutation ?? {}, b.mutation ?? DEFAULT_MUTATION)
      : undefined;
  const hadAutoGhost = Boolean(b.mutation && raw.mutation === null && raw.ghost === undefined);
  const ghostBase: GhostSettings = mutation ? { ...(b.ghost ?? DEFAULT_GHOST), linger: mutation.fade, trigger: 'agent' } : (b.ghost ?? DEFAULT_GHOST);
  const ghost =
    engine === 'wet' && wet.tool === 'paint' && !hadAutoGhost && (raw.ghost !== undefined ? raw.ghost !== null : Boolean(mutation) || (!wantsLight && Boolean(b.ghost)))
      ? normalizeGhost(raw.ghost ?? {}, ghostBase)
      : undefined;
  if (ghost || mutation) behavior = { ...behavior, pickup: 0, dirty: false };
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
    wet,
    impasto: normalizeImpasto(raw.impasto ?? {}, b.impasto ?? DEFAULT_IMPASTO),
    particle: normalizeParticle(raw.particle ?? {}, b.particle ?? DEFAULT_PARTICLE),
    bristle: normalizeBristle(raw.bristle ?? {}, b.bristle ?? DEFAULT_BRISTLE),
    sticker: normalizeStickerSettings(raw.sticker ?? {}, b.sticker ?? DEFAULT_STICKER),
    light: ghost && !wantsLight ? { ...DEFAULT_LIGHT } : normalizeLight(raw.light ?? {}, b.light ?? DEFAULT_LIGHT),
    fluorescence: normalizeFluorescence(raw.fluorescence ?? {}, b.fluorescence ?? DEFAULT_FLUORESCENCE),
    thermochromic: normalizeThermochromic(raw.thermochromic ?? {}, b.thermochromic ?? DEFAULT_THERMOCHROMIC),
    ...withIridescence(readIridescence(raw.iridescence, b.iridescence ?? null)),
    ...(ghost ? { ghost } : {}),
    ...(mutation ? { mutation } : {}),
    ferro: normalizeFerro(raw.ferro, b.ferro ?? DEFAULT_FERRO),
    stamp: readStamp(raw.stamp, b.stamp ?? null),
    spray: readSpray(raw.spray, b.spray ?? null),
    ...withTipGrain(readTipGrain(raw.tipGrain, b.tipGrain ?? null)),
    ...withLivePatterns(readLivePatterns(raw.livePatterns, b.livePatterns ?? null)),
    ...withCulture(canMutate || engine === 'mixer' ? readCulture(raw.culture, b.culture ?? null) : null),
    paint,
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
  impasto: { ...DEFAULT_IMPASTO },
  particle: { ...DEFAULT_PARTICLE },
  bristle: { ...DEFAULT_BRISTLE },
  sticker: { ...DEFAULT_STICKER, stamps: [...DEFAULT_STICKER.stamps] },
  light: { ...DEFAULT_LIGHT },
  fluorescence: { ...DEFAULT_FLUORESCENCE },
  thermochromic: { ...DEFAULT_THERMOCHROMIC },
  ferro: { ...DEFAULT_FERRO },
  stamp: null,
  spray: null,
  paint: null,
};
