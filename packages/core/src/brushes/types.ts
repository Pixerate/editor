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
import type { CultureSpecies } from '../paint/culture';
import type { PaintGradientSource } from '../paint/gradient-paint';
import type { MixingModel } from '../paint/exchange';
import type { BlendMode } from '../raster/blend';
import type { BrushRotation, ImpastoTool, LivePatternKind, PaintBrush, WetMediumKind } from '../paint-editor/brushes';
import type { PaintEffectPaint } from '../paint-editor/effect-paint';
import type { DotRotation, DotTextureOrder, InvertMode, ParticleKind, ParticleRender, RibbonPairs } from '../paint-editor/mark-settings';
import type { StickerRef } from '../stickers/types';

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
 * the ellipse; the name is for people); `bristle` is a tuft of bristles; `stamp` lays shaped
 * dabs: an editor stamp, a sticker, or an image source (`source:<id>`, see `brushes/sources.ts`).
 */
export type BrushTipShape = 'round' | 'flat' | 'chisel' | 'bristle' | 'stamp';
export const BRUSH_TIP_SHAPES: readonly BrushTipShape[] = ['round', 'flat', 'chisel', 'bristle', 'stamp'];

/** How the tip is laid along the path. */
export type BrushMarksKind = 'continuous' | 'scatter' | 'particles' | 'objects' | 'antimatter';
export const BRUSH_MARKS_KINDS: readonly BrushMarksKind[] = ['continuous', 'scatter', 'particles', 'objects', 'antimatter'];

/** What the material does on the surface: stays where it lands (`dry`), flows and dries (`wet`) or stands up in relief (`thick`). */
export type BrushSurface = 'dry' | 'wet' | 'thick';
export const BRUSH_SURFACES: readonly BrushSurface[] = ['dry', 'wet', 'thick'];

/**
 * What a `stamp` tip lays: a sticker ref `provider:id` (`editor:star`, or a host library's
 * sticker) or an image source `source:<id>` from the brush library. Objects marks take only
 * stickers (each mark stays a sticker).
 */
export type BrushStamp = StickerRef;

/**
 * How tip grain sits: `moving` rolls with the tip along the stroke (it turns with the tip, and
 * every stroke shows it the same way); `texturised` stays put on the canvas, like a texture under
 * the paint, so overlapping strokes show the same grain.
 */
export type BrushGrainMode = 'moving' | 'texturised';
export const BRUSH_GRAIN_MODES: readonly BrushGrainMode[] = ['moving', 'texturised'];

/** Mirror each dab at random across these axes of the tip. */
export type BrushFlip = 'none' | 'x' | 'y' | 'xy';
export const BRUSH_FLIPS: readonly BrushFlip[] = ['none', 'x', 'y', 'xy'];

/** Texture inside the tip (Procreate's grain source), separate from the paper grain. */
export interface BrushTipGrain {
  /** A built-in grain pattern (`rough`, `canvas`, `sanded`…) or an image source `source:<id>` (light parts are peaks). */
  source: string;
  /** Default `texturised`. */
  mode?: BrushGrainMode;
  /** Grain size: 1 is the pattern's or image's own size, 2 twice as coarse; 0.05..20 (default 1). */
  scale?: number;
  /** How much the grain takes out of the mark: 0 none .. 1 only the peaks paint (default 0.6). */
  depth?: number;
  /** Height contrast around the middle, 0..3 (default 1). */
  contrast?: number;
  /** Swap peaks and valleys (default false). */
  invert?: boolean;
}

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
  /** `stamp` tips: sticker or source refs (objects: any sticker, one picked at random per mark; particles: up to 4, in `marks.stampOrder`; continuous dabs: the first). */
  stamps?: BrushStamp[];
  /** Texture inside each dab (continuous and scatter marks). */
  grain?: BrushTipGrain;
}

/** Dabs laid along the path (the default). */
export interface BrushContinuousMarks {
  kind: 'continuous';
}

/** A spray: each dab lays a seeded scatter of droplets across the tip (a spray can). */
export interface BrushScatterMarks {
  kind: 'scatter';
  /** Droplets per dab, 0..1: 1 + density × 31 (default 0.5). */
  density?: number;
  /** Droplet size as a fraction of the tip size, 0.02..1 (default 0.12). */
  size?: number;
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

/** Animated blasts that invert, scorch and destroy paint across every visible layer where the tip touches paint. */
export interface BrushAntimatterMarks {
  kind: 'antimatter';
  /** Blast size, in tip radii, 1..6 (default 2.5). */
  blastRadius?: number;
  /** Stroke travel between blasts, in tip diameters, 0.5..8 (default 2). */
  blastSpacing?: number;
  /** Paint needed under the tip to fire, 0..1 (default 0.1). */
  threshold?: number;
  /** Strength of the colour inversion in the blast core, 0..1 (default 1). */
  invert?: number;
  /** Colour inversion mode: `rgb` (default) or `oklab` (flips lightness and hue so mid-grey changes too). */
  invertMode?: InvertMode;
  /** Strength of the soot ring, 0..1 (default 0.6). */
  scorch?: number;
  /** Paint destroyed at the centre — alpha removed, 0..1 (default 0.25). */
  annihilate?: number;
  /** How many sparks fly out from each blast, 0..1 (default 0.5). */
  sparks?: number;
  /** How far sparks fly, in tip diameters, 0.5..8 (default 3). */
  sparkReach?: number;
  /** Depth of the dent on layers with relief, 0..1 (default 0.5). */
  crater?: number;
  /** Seconds a blast plays on screen, 0..2 (default 0.7; 0 shows the result at once). */
  duration?: number;
}

export type BrushMarks = BrushContinuousMarks | BrushScatterMarks | BrushParticleMarks | BrushObjectMarks | BrushAntimatterMarks;

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
  /** Dabs laid at each spacing step, 1..16, each with its own jitter (default 1). */
  count?: number;
  /** Mirror each dab at random across these axes (default `none`): variety for image tips. */
  flip?: BrushFlip;
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

/**
 * UV-fluorescent ink: paint that emits its colour under the virtual UV blacklight (`uvLight`).
 * With `invisible: true`, the stroke lays no daylight paint and reveals only under UV.
 */
export interface BrushFluorescence {
  /** Fluorescence intensity under UV blacklight, 0..1 (default 0: none). */
  amount?: number;
  /** Invisible in normal light: lays no daylight paint and glows only under UV (default false). */
  invisible?: boolean;
}

/**
 * Thermochromic ink: paint that shifts smoothly toward `hotColor` where the canvas heat field
 * warms it past `threshold`.
 */
export interface BrushThermochromic {
  /** Colour (#rrggbb) the ink turns when heated above `threshold`. */
  hotColor?: string;
  /** Temperature 0.05..0.95 at which the colour shift is halfway (default 0.5). */
  threshold?: number;
}

/** Structural colour: a thin dielectric film over the paint whose interference hue shifts with light and view angle. */
export interface BrushIridescence {
  /** Film thickness in nanometres, 100..1000 (default 400). */
  thickness?: number;
  /** How much pen pressure shifts the film thickness per dab, 0..1 (default 0). */
  pressureToThickness?: number;
  /** Refractive index of the film, 1.2..2.0 (default 1.5: soap film ~1.33, pearl ~1.53, scarab chitin ~1.65). */
  ior?: number;
}

/** When a ghost brush's fade starts: immediately (`immediate`, default) or once claimed by an agent (`agent`). */
export type GhostTrigger = 'immediate' | 'agent';
export const GHOST_TRIGGERS: readonly GhostTrigger[] = ['immediate', 'agent'];

/** Ghost paint: wet paint whose colour fades away after `linger` seconds, leaving only what it smeared. */
export interface BrushGhost {
  /** Seconds of simulated time before the ghost paint has fully faded, 0.5..60 (default 4). */
  linger?: number;
  /** How much the ghost paint drags and lifts the paint it passes through, 0..1 (default 0.3). */
  smear?: number;
  /** When the fade starts: `immediate` (default) or `agent` (waits until claimed by `read_mutation`). */
  trigger?: GhostTrigger;
}

/** Mutation paint: your stroke sinks away once claimed by an agent, which paints its own answer. */
export interface BrushMutation {
  /** Seconds after the last stroke before it counts as finished, 0.5..10 (default 1.5). */
  settle?: number;
  /** Seconds to wait for an agent before giving up and keeping the paint, 5..300 (default 45). */
  patience?: number;
  /** Seconds the paint takes to sink away once claimed, 0.5..10 (default 2). */
  fade?: number;
}

/** Liquid ferrofluid paint that rises into glossy Rosensweig spikes near magnets until cured. */
export interface BrushFerro {
  /** Ferrofluid per dab, 0..1 (default 0: none). */
  amount?: number;
  /** Capillary wavelength (spike-to-spike spacing) in pixels, 4..64 (default 16). */
  wavelength?: number;
  /** Critical magnetic field |B| threshold where spikes begin to rise, 0.01..0.95 (default 0.12). */
  threshold?: number;
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
 * Gray-Scott reaction-diffusion patterns (`spots`, `stripes`, `coral`, `maze`, `worms`) that grow
 * inside wet paint (`behaviour.surface: 'wet'`) and freeze where the paint dries.
 */
export interface BrushLivePatterns {
  /** Named Pearson feed/kill preset (`spots`, `stripes`, `coral`, `maze`, `worms`; default `spots`). */
  pattern?: LivePatternKind;
  /** Gray-Scott feed rate F, 0.01..0.1 (default from `pattern`). */
  feed?: number;
  /** Gray-Scott kill rate k, 0.03..0.08 (default from `pattern`). */
  kill?: number;
  /** Spatial scale of the pattern (diffusion multiplier), 0.5..4 (default 1). */
  scale?: number;
  /** Visual contrast of the V concentration field, 0..2 (default 1). */
  contrast?: number;
  /** Second colour (#rrggbb) that V blends the wet paint towards, or `null` to modulate pigment contrast (default `null`). */
  secondColor?: string | null;
  /** Impasto relief written to the layer's thick height map as patterns grow, 0..1 (default 0). */
  relief?: number;
}

/**
 * Biopaint (`culture`): living ink that seeds spores along a brush stroke, grows outward as
 * branching threads, steers towards paint on the layer and digests what it crosses.
 */
export interface BrushCulture {
  /** Living species (default `mycelium`). */
  species?: CultureSpecies;
  /** How far a colony spreads on bare canvas in tip diameters, 1..100 (default 12). */
  reach?: number;
  /** How often threads fork, 0..1 (default 0.4). */
  branching?: number;
  /** How much threads meander, 0..1 (default 0.35). */
  wander?: number;
  /** How strongly threads steer towards paint, 0..1 (default 0.5). */
  appetite?: number;
  /** How much paint is consumed as threads cross it, 0..1 (default 0.25). */
  digest?: number;
  /** Chance a thread fuses into another thread it meets rather than deflecting, 0..1 (default 0.7). */
  fuse?: number;
  /** Thread width as a fraction of tip size, 0.02..0.5 (default 0.08). */
  thickness?: number;
  /** Bioluminescence written to `doc.light`, 0..1 (default 0). */
  glow?: number;
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
  fluorescence?: BrushFluorescence;
  thermochromic?: BrushThermochromic;
  iridescence?: BrushIridescence;
  ghost?: BrushGhost;
  mutation?: BrushMutation;
  ferro?: BrushFerro;
  motion?: BrushMotion;
  livePatterns?: BrushLivePatterns;
  culture?: BrushCulture;
  colour?: BrushColour;
}

/** The flat form the paint engine reads: every engine block, filled. */
export type ResolvedBrush = PaintBrush;
