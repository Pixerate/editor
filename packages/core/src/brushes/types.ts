/**
 * The brush model: one brush type made of facets people and agents can reason about (what it is,
 * its tip, how it lays marks, how it feels, what the material does, light, motion and colour).
 * Every facet but identity and tip is optional and sparse: a missing field takes the default the
 * engine has always used, so a brush stores only what makes it what it is.
 *
 * Medium and variety are descriptive (browsing, filtering). What the renderer does is decided by
 * the tip, the marks and the behaviour: `resolveEngine` derives the engine, and `resolveBrush`
 * turns a brush into the flat form the paint engine reads (`ResolvedBrush`).
 *
 * Type-only imports keep this module free of the renderers.
 */

import type { ColorValue } from '../color/dual';
import type { PaintGradientSource } from '../paint/gradient-paint';
import type { MixingModel } from '../paint/exchange';
import type { BlendMode } from '../raster/blend';
import type { BrushRotation, ImpastoTool, PaintBrush, WetMediumKind } from '../paint-editor/brushes';
import type { PaintEffectPaint } from '../paint-editor/effect-paint';
import type { DotRotation, DotTextureOrder, ParticleKind, ParticleRender, RibbonPairs, StampKind } from '../paint-editor/mark-settings';

/** `mark`: lays a material; `tool`: works on paint already down (erases, blends, smudges, wets…). */
export type BrushKind = 'mark' | 'tool';
export const BRUSH_KINDS: readonly BrushKind[] = ['mark', 'tool'];

/** What a mark brush lays: wet or thick `paint`, `ink`, a `dry` medium (pencil, pastel, charcoal) or a `spray`. */
export type BrushMedium = 'paint' | 'ink' | 'dry' | 'spray';
export const BRUSH_MEDIA: readonly BrushMedium[] = ['paint', 'ink', 'dry', 'spray'];

/** What a tool does to paint already down. */
export type BrushTool = 'eraser' | 'blender' | 'smudge' | 'water' | 'dryer' | 'blow' | 'blot' | 'wet-blend' | 'wet-drag';
export const BRUSH_TOOLS: readonly BrushTool[] = ['eraser', 'blender', 'smudge', 'water', 'dryer', 'blow', 'blot', 'wet-blend', 'wet-drag'];

/**
 * The tip's shape. `round`, `flat` and `chisel` are ellipses (their `roundness` and `angle` set
 * the ellipse; the name is for people); `bristle` is a tuft of bristles; `stamp` lays textured
 * stamps (with `marks` `objects` or `particles`).
 */
export type BrushTipShape = 'round' | 'flat' | 'chisel' | 'bristle' | 'stamp';
export const BRUSH_TIP_SHAPES: readonly BrushTipShape[] = ['round', 'flat', 'chisel', 'bristle', 'stamp'];

/** How the tip is laid along the path. */
export type BrushMarksKind = 'continuous' | 'particles' | 'objects';
export const BRUSH_MARKS_KINDS: readonly BrushMarksKind[] = ['continuous', 'particles', 'objects'];

/** What the material does on the surface: stays where it lands (`dry`), flows and dries (`wet`) or stands up in relief (`thick`). */
export type BrushSurface = 'dry' | 'wet' | 'thick';
export const BRUSH_SURFACES: readonly BrushSurface[] = ['dry', 'wet', 'thick'];

/** Built-in stamps a `stamp` tip can lay. */
export type BrushStamp = StampKind;

/** The tuft of a `bristle` tip (each 0..1 unless noted). */
export interface BrushBristles {
  /** Bristles in the tuft, 3..128 (default 32). */
  count?: number;
  /** Stiff bristles follow the tip; soft ones lag and bend into curves at turns (default 0.5). */
  stiffness?: number;
  /** How far pressure spreads the tuft (default 0.5). */
  splay?: number;
  /** Each bristle's line width as a fraction of the tip size (default 0.06). */
  thickness?: number;
  /** Paint per bristle: 1 never runs dry; lower, bristles run out along the stroke (default 0.6). */
  load?: number;
  /** Random variation between bristles (default 0.4). */
  jitter?: number;
}

/** The tip: its shape and the dab it lays. */
export interface BrushTip {
  shape: BrushTipShape;
  /** Diameter in px, 1..2500 (default 20). */
  size?: number;
  /** Edge hardness 0 (soft) .. 1 (hard, default). */
  hardness?: number;
  /** Dab spacing as a fraction of the diameter, 0.01..10 (default 0.1). */
  spacing?: number;
  /** Tip angle in degrees, -360..360 (default 0). */
  angle?: number;
  /** Roundness 0.01..1: 1 round (default), lower a flat ellipse. */
  roundness?: number;
  /** Stroke opacity ceiling 0..1 (default 1). */
  opacity?: number;
  /** Build-up per dab 0..1 (default 1). */
  flow?: number;
  /** How the stroke paints onto the layer (default `normal`). */
  blend?: BlendMode;
  /** `bristle` tips: the tuft. */
  bristle?: BrushBristles;
  /** `stamp` tips: the stamps (objects: one picked at random per mark; particles: up to 4, in `marks.stampOrder`). */
  stamps?: BrushStamp[];
}

/** Dabs laid along the path (the default). */
export interface BrushContinuousMarks {
  kind: 'continuous';
}

/** Particles that move with the pen and draw as they go (each 0..1 unless noted). */
export interface BrushParticleMarks {
  kind: 'particles';
  /** How the particles move (default `spring`). */
  physics?: ParticleKind;
  /** How they draw (default `line`). */
  render?: ParticleRender;
  /** Particles, 1..64 (default 12). */
  count?: number;
  /** Mark size as a fraction of the tip size (default 0.08). */
  size?: number;
  /** How far apart they start, as a fraction of the tip size (default 0.5). */
  spread?: number;
  /** Spring, string and elastic stiffness (default 0.4). */
  stiffness?: number;
  /** How quickly motion dies down (default 0.25). */
  damping?: number;
  /** Orbit and flow speed (default 0.5). */
  speed?: number;
  /** Pull downwards, -1 (up) .. 1 (default 0). */
  gravity?: number;
  /** Flow particles' lifetime (default 0.5). */
  life?: number;
  /** Sequence: spacing of the beads (default 0.3). */
  interval?: number;
  /** Ribbon: fill opacity between the paths (default 0.5). */
  ribbonFill?: number;
  /** Ribbon: which paths are joined (default `adjacent`). */
  ribbonPairs?: RibbonPairs;
  /** Wave: sideways swing as a fraction of the tip size (default 0: none). */
  waveAmplitude?: number;
  /** Wave: wavelength in px of pen travel, 4..2000 (default 60). */
  waveLength?: number;
  /** Wave: how far out of step the particles' waves are (default 0). */
  wavePhaseJitter?: number;
  /** Stamp tips: the stamps in turn or at random (default `sequence`). */
  stampOrder?: DotTextureOrder;
  /** Stamp tips: how each stamp turns (default `random`). */
  stampRotation?: DotRotation;
}

/** Each mark stays an editable object (a sticker) on a sticker layer (each 0..1 unless noted). */
export interface BrushObjectMarks {
  kind: 'objects';
  /** About `density × 4` marks per tip diameter of travel (default 0.4). */
  density?: number;
  /** Random size change (default 0.4). */
  sizeJitter?: number;
  /** Random turn as a fraction of ±180° (default 1). */
  rotationJitter?: number;
  /** How far from the path marks land, in tip diameters, 0..2 (default 0.5). */
  scatter?: number;
  /** Random colour change, hue and lightness (default 0.2). */
  colourJitter?: number;
}

export type BrushMarks = BrushContinuousMarks | BrushParticleMarks | BrushObjectMarks;

/** Pen feel. Every amount is 0 (off) .. 1 unless noted. */
export interface BrushDynamics {
  /** Pressure scales the size (default true). */
  pressureSize?: boolean;
  /** Pressure scales the opacity (default false). */
  pressureOpacity?: boolean;
  /** Position smoothing 0..0.95 (default 0). */
  smoothing?: number;
  /** Pressure smoothing 0..0.95 (default 0). */
  pressureSmoothing?: number;
  /** What turns the tip: a fixed angle, the stroke direction or the pen barrel (default `fixed`). */
  rotation?: BrushRotation;
  /** Size at zero pressure as a fraction of the full size (default 0). */
  minSize?: number;
  /** How much pressure scales flow (default 0). */
  pressureFlow?: number;
  /** Laying the pen down widens the tip, up to 2.5× (default 0). */
  tiltSize?: number;
  /** Laying the pen down flattens the tip (default 0). */
  tiltRoundness?: number;
  /** Laying the pen down lightens the mark (default 0). */
  tiltOpacity?: number;
  /** -1..1: positive grows the tip on fast strokes, negative thins it (default 0). */
  velocitySize?: number;
  /** -1..1: positive darkens fast marks, negative lightens them (default 0). */
  velocityOpacity?: number;
  /** Random size change per dab (default 0). */
  sizeJitter?: number;
  /** Random angle per dab, as a fraction of ±180° (default 0). */
  angleJitter?: number;
  /** Random opacity drop per dab (default 0). */
  opacityJitter?: number;
  /** Random offset across the stroke in diameters, 0..4 (default 0). */
  scatter?: number;
}

/** A Mixer Brush's paint reservoir: the brush is loaded with colour and mixes what it picks up into it. */
export interface BrushReservoir {
  /** How much paint it holds, 0..1 (default 0.5); below 1 it drains per dab. */
  load?: number;
  /** Refill with the paint colour at the start of each stroke (default true). */
  refill?: boolean;
  /** Load the current colour at all (default true; false: it only moves paint already down). */
  loadsColour?: boolean;
}

/** Paint exchange with the canvas: picking paint up and mixing it into what the brush lays. */
export interface BrushExchange {
  /** Pick-up ratio 0..1 (default 0; with a reservoir 0.5). */
  pickup?: number;
  /** Mix ratio 0..1 (default 0.5). */
  mix?: number;
  /** Keep the picked-up paint for the next stroke (default false). */
  dirty?: boolean;
  /** A reservoir makes this a Mixer Brush. */
  reservoir?: BrushReservoir;
}

/** Wet surface settings (each 0..1 unless noted). */
export interface BrushWet {
  /** The wet medium (default: the variety when it is one, else `watercolor`). */
  medium?: WetMediumKind;
  /** Water laid down (default 0.5). */
  water?: number;
  /** Pigment concentration (default 0.5). */
  pigment?: number;
  /** Body: 0 transparent .. 1 opaque (default 0). */
  body?: number;
  /** How much dried paint the water lifts again (default 0). */
  rewet?: number;
  /** Paint loading: 1 never runs out (default 1). */
  load?: number;
  /** Thinner: more transparent, runnier paint (default 0). */
  thinner?: number;
}

/** Thick (impasto) surface settings (each 0..1 unless noted). */
export interface BrushThick {
  /** What lays the paint (default `brush`). */
  applicator?: ImpastoTool;
  /** Relief per stroke (default 0.6). */
  thickness?: number;
  /** Shine (default 0.4). */
  gloss?: number;
  /** Metallic highlights (default 0). */
  metallic?: number;
  /** Paint loading (default 0.9). */
  load?: number;
  /** Thinner (default 0). */
  thinner?: number;
  /** Knife and brush: how much paint is dragged along (default 0.4). */
  drag?: number;
  /** Light paint: brighter rims, as on backlit glass (default 0). */
  rim?: number;
  /** Light paint: see-through middles (default 0). */
  clarity?: number;
}

/** What the material does on the surface, and how tools work. */
export interface BrushBehaviour {
  /** Default `dry`. */
  surface?: BrushSurface;
  /** Paper grain response 0 (ignores it) .. 1 (catches only the peaks), default 0. */
  grain?: number;
  /** How colours mix: `pigment` (Kubelka-Munk) or `rgb`. Default `pigment`; Mixer Brush and smudge `rgb`. */
  mixing?: MixingModel;
  exchange?: BrushExchange;
  /** `surface: 'wet'` and the wet tools. */
  wet?: BrushWet;
  /** `surface: 'thick'`. */
  thick?: BrushThick;
  /** Tools: how strongly the blender, smudge or wet tool works, 0..1 (default 0.5; smudge 0.7). */
  strength?: number;
  /** Blender: neighbourhood radius as a fraction of the tip diameter, 0..1 (default 0.35). */
  distance?: number;
  /** Smudge: share of the carried paint kept per dab, 0..1 (default 0.85). */
  length?: number;
}

/** Light the brush gives off with its colour. */
export interface BrushLight {
  /** Light per dab, 0..1 (default 0: none). */
  amount?: number;
  /** Pressure scales the light (default false). */
  pressure?: boolean;
  /** Suggested layer spill, applied when the layer has none of its own: radius 0..512 px (0 off), strength 0..2. */
  spill?: { radius?: number; strength?: number };
  /** Suggest a glow layer effect for the brush's layer (glow stays a layer effect). */
  glow?: boolean;
}

/** Animation after painting. */
export interface BrushMotion {
  /** Effect paint keeps playing on stroke layers. */
  live?: boolean;
  /** Suggested playback rate, 1..60 frames per second. */
  fps?: number;
  /** Particle waves: how fast they run, 0..1 (default 0). */
  waveSpeed?: number;
}

/**
 * A colour a brush can carry: a solid colour (hex, `#rrggbbaa`, `rgba()` or a light / dark
 * `DualColor`), a gradient, or effect paint.
 */
export type BrushPaint = ColorValue | PaintGradientSource | PaintEffectPaint;

/** The brush's colours. The user's colour still wins unless `own` is set. */
export interface BrushColour {
  /**
   * The colour the brush starts with. A gradient is always painted (its `paint` / `secondary`
   * stops take the user's colours); a solid colour or effect paint is suggested to the host.
   */
  default?: BrushPaint;
  /** Up to 16 suggested colours. */
  palette?: BrushPaint[];
  /** The brush always paints its own colour (a rainbow marker). */
  own?: boolean;
}

/** A brush: identity, what it is, and its facets. */
export interface Brush {
  /** Library id: lowercase letters, digits and dashes, up to 64 characters. */
  id: string;
  /** Display name, up to 80 characters. */
  name: string;
  description?: string;
  tags?: string[];
  kind: BrushKind;
  /** Marks only: what it lays. */
  medium?: BrushMedium;
  /** What kind of that medium (`oil`, `watercolor`, `pencil`, `highlighter`…): lowercase letters, digits and dashes. */
  variety?: string;
  /** Tools only: what it does. */
  tool?: BrushTool;
  tip: BrushTip;
  marks?: BrushMarks;
  dynamics?: BrushDynamics;
  behaviour?: BrushBehaviour;
  light?: BrushLight;
  motion?: BrushMotion;
  colour?: BrushColour;
}

/** The flat form the paint engine reads: every engine block, filled. */
export type ResolvedBrush = PaintBrush;
