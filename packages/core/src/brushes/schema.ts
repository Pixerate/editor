/**
 * JSON Schema of a `Brush`: strict (`additionalProperties: false` at every level), every field
 * described with its units and default. `normalizeBrushSpec` clamps and checks against the same
 * ranges, so the schema, the normaliser and the engine agree.
 */

import type { JsonSchema } from '../tools/schema';
import { PAINT_GRADIENT_JSON_SCHEMA } from '../paint/gradient-paint';
import { BLEND_MODES } from '../raster/blend';
import { BRUSH_ID, BRUSH_ROTATIONS, IMPASTO_TOOLS, LIVE_PATTERN_KINDS, MAX_BRUSH_SIZE, WET_MEDIA } from '../paint-editor/brushes';
import { DOT_ROTATIONS, DOT_TEXTURE_ORDERS, MAX_DOT_TEXTURES, MAX_STICKER_STAMPS, PARTICLE_KINDS, PARTICLE_RENDERS, RIBBON_PAIRS, STAMP_KINDS } from '../paint-editor/mark-settings';
import { GRAIN_PATTERNS } from '../paint/grain';
import { BRUSH_FLIPS, BRUSH_GRAIN_MODES, BRUSH_KINDS, BRUSH_MEDIA, BRUSH_SURFACES, BRUSH_TIP_SHAPES, BRUSH_TOOLS, GHOST_TRIGGERS } from './types';

/** Most colours in a brush's palette. */
export const MAX_BRUSH_PALETTE = 16;

/** Variety and tag ids: lowercase letters, digits and dashes. */
export const BRUSH_WORD = /^[a-z0-9][a-z0-9-]{0,39}$/;

const unit = (description: string): JsonSchema => ({ type: 'number', minimum: 0, maximum: 1, description });
const num = (minimum: number, maximum: number, description: string): JsonSchema => ({ type: 'number', minimum, maximum, description });
const int = (minimum: number, maximum: number, description: string): JsonSchema => ({ type: 'integer', minimum, maximum, description });
const bool = (description: string): JsonSchema => ({ type: 'boolean', description });
const oneOf = (values: readonly string[], description: string): JsonSchema => ({ type: 'string', enum: [...values], description });
const object = (description: string, properties: Record<string, JsonSchema>, required?: string[]): JsonSchema => ({
  type: 'object',
  description,
  properties,
  ...(required ? { required } : {}),
  additionalProperties: false,
});

const MIXING = oneOf(['pigment', 'rgb'], 'How colours mix: pigment (Kubelka-Munk, blue and yellow make green) or rgb (straight averages). Default pigment; a Mixer Brush and the smudge tool default to rgb.');

/** A sticker ref `provider:id`, or a bare editor stamp (read as `editor:<stamp>`). */
export const BRUSH_STAMP_PATTERN = `^(?:[^:\\s]+:\\S+|${STAMP_KINDS.join('|')})$`;

const STAMP: JsonSchema = {
  type: 'string',
  pattern: BRUSH_STAMP_PATTERN,
  description: `A sticker ref provider:id (find_stickers lists them; the editor's own are ${STAMP_KINDS.map((k) => `editor:${k}`).join(', ')}), or an image source source:<id> (list_brush_sources lists them; add_brush_source makes one from an image). A bare editor stamp (star) means editor:star.`,
};

/** Tip grain sources: the built-in patterns (not the flat `smooth`) or an image source `source:<id>`. */
export const TIP_GRAIN_PATTERNS = GRAIN_PATTERNS.filter((p) => p !== 'smooth');
export const BRUSH_GRAIN_SOURCE_PATTERN = `^(?:source:[a-z0-9][a-z0-9-]{0,63}|${TIP_GRAIN_PATTERNS.join('|')})$`;

const TIP_GRAIN = object(
  "Texture inside the tip (a grain source), separate from the paper's grain: each dab is multiplied by it. Continuous and scatter marks of round and stamp tips.",
  {
    source: { type: 'string', pattern: BRUSH_GRAIN_SOURCE_PATTERN, description: `The texture: a built-in pattern (${TIP_GRAIN_PATTERNS.join(', ')}) or an image source source:<id> (list_brush_sources); light parts are peaks, which paint.` },
    mode: oneOf(BRUSH_GRAIN_MODES, 'texturised (default): the grain stays put on the canvas, a texture under the paint; moving: it rolls along with the tip, turning with it.'),
    scale: num(0.05, 20, "Grain size: 1 is the pattern's or image's own size, 2 twice as coarse (default 1)."),
    depth: unit('How much the grain takes out of each dab: 0 none, 1 only the peaks paint (default 0.6).'),
    contrast: num(0, 3, 'Height contrast around the middle: below 1 softer, above 1 harsher (default 1).'),
    invert: bool('Swap peaks and valleys (default false).'),
  },
  ['source'],
);

const BRISTLES = object('Bristle tips: the tuft. Missing fields take their defaults.', {
  count: int(3, 128, 'Bristles in the tuft (default 32).'),
  stiffness: unit('Stiff bristles follow the tip; soft ones lag and bend into curves at turns (default 0.5).'),
  splay: unit('How far pressure spreads the tuft (default 0.5).'),
  thickness: unit("Each bristle's line width as a fraction of the tip size (default 0.06)."),
  load: unit('Paint per bristle: 1 never runs dry; lower, bristles run out along the stroke, a dry brush (default 0.6).'),
  jitter: unit('Random variation between bristles: length, paint, position (default 0.4).'),
});

const TIP = object(
  'The tip: its shape and the dab it lays.',
  {
    shape: oneOf(BRUSH_TIP_SHAPES, 'round, flat, chisel: an ellipse set by roundness and angle (the name is for people); bristle: a tuft of bristles (see bristle); stamp: dabs shaped like a stamp, a sticker or an image source (see stamps), also laid as sprays, objects or particles.'),
    size: num(1, MAX_BRUSH_SIZE, 'Diameter in px (default 20).'),
    hardness: unit('Edge hardness, 0 soft .. 1 hard (default 1). Image-source stamps fade towards their edges below 1.'),
    spacing: num(0.01, 10, 'Dab spacing as a fraction of the diameter: 0.05 smooth, 1 dotted (default 0.1).'),
    angle: num(-360, 360, 'Tip angle in degrees, counter-clockwise; added to the stroke direction or barrel with dynamics.rotation (default 0).'),
    roundness: num(0.01, 1, 'Roundness: 1 round (default), lower a flat ellipse (pastel, chisel).'),
    opacity: unit('Stroke opacity ceiling: overlapping dabs never exceed it (default 1).'),
    flow: unit('Build-up per dab towards the opacity: low flow builds softly, like an airbrush (default 1).'),
    blend: oneOf(
      BLEND_MODES.map((m) => m.id),
      'How the stroke paints onto the layer (default normal). pigment mixes like real paint; multiply darkens like marker ink; watercolor glazes; tint, highlight and shadow recolour, light and shade.',
    ),
    bristle: BRISTLES,
    stamps: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_STICKER_STAMPS,
      items: STAMP,
      description: `Stamp tips: stickers or image sources (source:<id>). Continuous dabs and sprays lay the first; objects take only stickers and pick one at random per mark (default editor:star; repeats count once); particles use the first ${MAX_DOT_TEXTURES} in marks.stampOrder, and repeats weight the order.`,
    },
    grain: TIP_GRAIN,
  },
  ['shape'],
);

const CONTINUOUS = object('Dabs laid along the path (the default).', { kind: { type: 'string', const: 'continuous', description: 'Always "continuous".' } }, ['kind']);

const PARTICLES = object(
  'Particles that move with the pen and draw as they go. Missing fields take their defaults.',
  {
    kind: { type: 'string', const: 'particles', description: 'Always "particles".' },
    physics: oneOf(
      PARTICLE_KINDS,
      'How the particles move (default spring). string: strands dragged behind the pen (hair, fur); spring: on springs to the pen, overshooting; orbit: circling the pen (curls); flow: thrown into a swirling flow until they fade; elastic: links that stretch and snap back; fuzzy: winding strings waving out of step.',
    ),
    render: oneOf(PARTICLE_RENDERS, 'How they draw (default line). dot: a mark per step; line: a continuous line each; sequence: beads spaced along each path; ribbon: the band between neighbouring paths filled.'),
    count: int(1, 64, 'Particles (flow: thrown per tip of travel). Default 12.'),
    size: unit('Mark size as a fraction of the tip size; ribbon: its edge width (default 0.08).'),
    spread: unit('How far apart they start, as a fraction of the tip size; ribbon: its width (default 0.5).'),
    stiffness: unit('Spring, string and elastic stiffness: stiff follows closely, soft swings wide (default 0.4).'),
    damping: unit('How quickly motion dies down (default 0.25).'),
    speed: unit('Orbit and flow speed (default 0.5).'),
    gravity: num(-1, 1, 'Pull downwards; negative pulls up (default 0).'),
    life: unit('Flow particles: how long they live (default 0.5).'),
    interval: unit('Sequence: spacing of the beads (default 0.3).'),
    ribbonFill: unit('Ribbon: fill opacity between the paths, relative to their edges (default 0.5; 0 only edges).'),
    ribbonPairs: oneOf(RIBBON_PAIRS, 'Ribbon: adjacent (default) joins each particle to its neighbour; first-last makes one band between the outermost two.'),
    waveAmplitude: unit('Wave: sideways swing as a fraction of the tip size (default 0: no wave).'),
    waveLength: num(4, 2000, 'Wave: wavelength in px of pen travel (default 60).'),
    wavePhaseJitter: unit("Wave: how far out of step the particles' waves are; 0 in step, 1 random phases (default 0)."),
    stampOrder: oneOf(DOT_TEXTURE_ORDERS, 'Stamp tips: sequence (default) uses the stamps in turn; random picks one per dot, seeded.'),
    stampRotation: oneOf(DOT_ROTATIONS, "Stamp tips: follow turns each with its particle's motion; random (default); fixed uses the tip angle."),
  },
  ['kind'],
);

const SCATTER = object(
  'A spray (a spray can): each dab lays a seeded scatter of droplets across the tip; jitter and size come from dynamics and the tip. Missing fields take their defaults.',
  {
    kind: { type: 'string', const: 'scatter', description: 'Always "scatter".' },
    density: unit('Droplets per dab: 1 + density × 31 (default 0.5).'),
    size: num(0.02, 1, 'Droplet size as a fraction of the tip size (default 0.12).'),
  },
  ['kind'],
);

const OBJECTS = object(
  'Each mark stays an editable object (a sticker) on a sticker layer; needs a stamp tip. Missing fields take their defaults.',
  {
    kind: { type: 'string', const: 'objects', description: 'Always "objects".' },
    density: unit('About density × 4 marks per tip diameter of travel; 0.25 ≈ one per diameter (default 0.4).'),
    sizeJitter: unit('Random size change (default 0.4).'),
    rotationJitter: unit('Random turn as a fraction of ±180° (default 1).'),
    scatter: num(0, 2, 'How far from the path marks land, in tip diameters (default 0.5).'),
    colourJitter: unit('Random colour change: at 1 up to ±40° of hue and ±0.15 OKLab lightness (default 0.2).'),
  },
  ['kind'],
);

const SCRAPER = object(
  'A scraper blade that cuts down through the visible paint stack layer by layer, removing alpha and thick height and carrying leftover depth into the layer below, stopping at locked layers or the paper. Missing fields take their defaults.',
  {
    kind: { type: 'string', const: 'scraper', description: 'Always "scraper".' },
    depth: unit('Layers removed per full-pressure pass, 0..1 (default 0.5). Any depth left after emptying the top visible layer carries into the layer below.'),
    sharpness: unit('Blade edge sharpness, 0 feathered .. 1 razor-sharp (default 0.7).'),
  },
  ['kind'],
);

const DYNAMICS = object('Pen feel: pressure, tilt, velocity, jitter, rotation and smoothing. Every amount 0 (off) .. 1 unless noted; missing fields take their defaults.', {
  pressureSize: bool('Pressure scales the size, down to minSize (default true).'),
  pressureOpacity: bool('Pressure scales the opacity (default false).'),
  smoothing: num(0, 0.95, 'Position smoothing of the input (default 0).'),
  pressureSmoothing: num(0, 0.95, 'Pressure smoothing, separate from position smoothing (default 0).'),
  rotation: oneOf(BRUSH_ROTATIONS, 'What turns the tip: fixed (tip.angle, default), stroke (direction of travel) or barrel (pen barrel rotation).'),
  minSize: unit('Size at zero pressure as a fraction of the full size, with pressureSize (default 0).'),
  pressureFlow: unit('How much pressure scales flow (default 0).'),
  tiltSize: unit('Laying the pen down widens the tip, up to 2.5× (default 0).'),
  tiltRoundness: unit('Laying the pen down flattens the tip along the tilt, side-of-the-pencil shading (default 0).'),
  tiltOpacity: unit('Laying the pen down lightens the mark (default 0).'),
  velocitySize: num(-1, 1, 'Positive grows the tip on fast strokes, negative thins it; needs timed points (default 0).'),
  velocityOpacity: num(-1, 1, 'Positive darkens fast marks, negative lightens them; needs timed points (default 0).'),
  sizeJitter: unit('Random size change per dab (default 0).'),
  angleJitter: unit('Random angle per dab, as a fraction of ±180° (default 0).'),
  opacityJitter: unit('Random opacity drop per dab (default 0).'),
  scatter: num(0, 4, 'Random offset across the stroke, in diameters (default 0).'),
  count: int(1, 16, 'Dabs laid at each spacing step, each with its own jitter and scatter (default 1). Dab brushes.'),
  flip: oneOf(BRUSH_FLIPS, 'Mirror each dab at random across x, y or both (default none): variety for image and stamp tips.'),
});

const EXCHANGE = object('Paint exchange with the canvas: picking up paint and mixing it into what the brush lays. Paint brushes on a dry, wet or thick surface and Mixer Brushes.', {
  pickup: unit('Pick-up ratio: how much of the paint under each dab the brush lifts and carries (default 0; with a reservoir 0.5).'),
  mix: unit("Mix ratio: how much of the carried paint goes into what the brush lays, against its own colour (default 0.5)."),
  dirty: bool('Keep the carried paint after the stroke, so the next one starts with the last colour touched (default false).'),
  reservoir: object('A paint reservoir makes this a Mixer Brush (an empty object takes every default).', {
    load: unit('How much paint the reservoir holds; below 1 it drains per dab and long strokes run dry (default 0.5).'),
    refill: bool('Refill with the paint colour before each stroke (default true).'),
    loadsColour: bool('Load the current colour at all (default true; false: it only moves paint already down).'),
  }),
});

const WET = object('Wet surface (watercolour, gouache, wet oil) and the wet tools. Missing fields take their defaults.', {
  medium: oneOf(WET_MEDIA, "The wet medium; a layer takes the medium's wet settings the first time it holds wet paint (default: the variety when it is watercolor, gouache or oil, else watercolor)."),
  water: unit('Wetness: water laid, 0.2 a damp brush .. 1 dripping (default 0.5).'),
  pigment: unit('Pigment concentration: 0 clear water .. 1 straight from the tube (default 0.5).'),
  body: unit('Body: 0 transparent watercolour .. 1 opaque gouache (default 0).'),
  rewet: unit('How much dried paint the water lifts again: 0 staining (default 0).'),
  load: unit('Paint loading: 1 never runs out; lower, the brush runs dry along a long stroke (default 1).'),
  thinner: unit('Thinner (water or solvent): more transparent, runnier paint (default 0).'),
});

const THICK = object('Thick surface (impasto: paint with relief, lit by the canvas lighting). Missing fields take their defaults.', {
  applicator: oneOf(IMPASTO_TOOLS, 'What lays the paint (default brush). brush: bristle ridges; tube: blobs squeezed from the tube; knife: scrapes the relief flat and smears; roller: a flat stippled band; gloop: a thick glossy bead.'),
  thickness: unit('How far the paint stands up (default 0.6).'),
  gloss: unit('Shine: 0 matte .. 1 wet-looking gloss (default 0.4).'),
  metallic: unit('Metallic: highlights take the paint colour, gold, copper, silver (default 0).'),
  load: unit('Paint loading: 1 never runs out; lower, the stroke thins as the brush empties (default 0.9).'),
  thinner: unit('Thinner: flatter, more transparent paint (default 0).'),
  drag: unit('Knife and brush: how much of the paint under the tool is dragged along (default 0.4).'),
  rim: unit('Light paint: light is stronger where the bead turns away, as on backlit glass (default 0).'),
  clarity: unit('Glassy paint: the middle of a bead lets the layers below show through (default 0).'),
});

const BEHAVIOUR = object('What the material does on the surface, and how tools work. Missing fields take their defaults.', {
  surface: oneOf(BRUSH_SURFACES, 'dry (default): stays where it lands; wet: flows, pools and dries (see wet); thick: stands up in relief (see thick).'),
  grain: unit('Paper grain response: 0 ignores the grain, 1 catches only its peaks at light pressure (pencil, pastel, charcoal). Default 0.'),
  mixing: MIXING,
  exchange: EXCHANGE,
  wet: WET,
  thick: THICK,
  strength: unit('Tools: how strongly the blender, smudge or wet tool works per dab (default 0.5; smudge 0.7).'),
  distance: unit('Blender: how far away colours are mixed in, as a fraction of the tip diameter (default 0.35).'),
  length: unit('Smudge: how far paint is dragged, the share of carried paint kept per dab (default 0.85).'),
});

const LIGHT = object('Light the brush gives off with its colour (glow and spill). Give light brushes dark paper.', {
  amount: unit('Light per dab, scaled by its coverage and flow (default 0: none).'),
  pressure: bool('Pressure scales the light (default false).'),
  spill: object('Suggested spill for the layer, applied when it has none of its own.', {
    radius: num(0, 512, 'How far the light reaches, px; 0 turns spill off (a highlighter).'),
    strength: num(0, 2, 'How strong the spill is.'),
  }),
  glow: bool('Suggest a glow layer effect for the layer (glow stays a layer effect).'),
});

const FLUORESCENCE = object('UV-fluorescent ink: glows in its colour under the virtual UV blacklight (set_uv_light); invisible in normal light when invisible is true.', {
  amount: unit('Fluorescence intensity under UV blacklight, 0 (none) .. 1.'),
  invisible: bool('Invisible ink in normal light: lays no daylight paint and glows only under UV (default false).'),
});

const THERMOCHROMIC = object('Thermochromic ink: shifts smoothly toward hotColor where the canvas heat field warms it past threshold.', {
  hotColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Colour (#rrggbb) the ink turns when heated.' },
  threshold: num(0.05, 0.95, 'Temperature 0.05..0.95 at which the colour shift is halfway (default 0.5).'),
});

const IRIDESCENCE = object('Structural colour: a thin dielectric film over the paint whose interference hue shifts with the light and view tilt. Missing fields take their defaults.', {
  thickness: num(100, 1000, 'Film thickness in nanometres, 100..1000 (default 400).'),
  pressureToThickness: unit('How much pen pressure shifts the film thickness per dab, 0..1 (default 0: uniform thickness).'),
  ior: num(1.2, 2.0, 'Refractive index of the film, 1.2..2.0 (default 1.5; water/soap ~1.33, pearl ~1.55, beetle lacquer ~1.65).'),
});

const GHOST = object('Ghost paint: wet paint that flows and mixes visibly while wet, then fades away without leaving its colour, keeping only the smear it made in the paint it touched (needs behaviour.surface "wet").', {
  linger: num(0.5, 60, 'Seconds of simulated time before the ghost paint has fully faded (default 4).'),
  smear: unit('How much the ghost paint drags and lifts the paint it passes through: 0 none .. 1 full (default 0.3).'),
  trigger: oneOf(GHOST_TRIGGERS, 'When the fade starts: immediate (default) counts down as soon as the paint is laid; agent holds the fade until read_mutation claims the stroke.'),
});

const MUTATION = object('Mutation paint: you paint something and pause; once an agent claims it with read_mutation, your paint sinks away and the agent paints its own answer (any wet or dry paint brush that lays its own colour without reading paint beneath).', {
  settle: num(0.5, 10, 'Seconds after the last stroke before it counts as finished and raises a mutation request (default 1.5).'),
  patience: num(5, 300, 'Seconds to wait for an agent before giving up and keeping the paint as ordinary paint (default 45).'),
  fade: num(0.5, 10, 'Seconds the paint takes to sink away once claimed by read_mutation (default 2).'),
});

const FERRO = object('Liquid ferrofluid paint: rises into glossy Rosensweig spikes near magnets until cured.', {
  amount: unit('How much liquid ferrofluid the brush lays per dab (default 0: none).'),
  wavelength: num(4, 64, 'Capillary wavelength (spike-to-spike spacing) in pixels (default 16).'),
  threshold: num(0.01, 0.95, 'Critical magnetic field |B| threshold where spikes begin to rise (default 0.12).'),
});

const MOTION = object('Animation after painting.', {
  live: bool('Effect paint keeps playing on stroke layers (default false).'),
  fps: int(1, 60, 'Suggested playback rate in frames per second.'),
  waveSpeed: unit('Particle waves: how fast they run by stroke time; 0 they stand still (default 0), 1 about four a second.'),
});

const LIVE_PATTERNS = object('Gray-Scott reaction-diffusion patterns (spots, stripes, coral, maze, worms) that grow inside wet paint (behaviour.surface: wet) and freeze where the paint dries.', {
  pattern: oneOf(LIVE_PATTERN_KINDS, 'Named Pearson feed/kill preset: spots (default, dividing mitosis spots), stripes (labyrinthine stripes), coral (branching dendrites), maze (winding channels) or worms (vermicular tracks).'),
  feed: num(0.01, 0.1, 'Gray-Scott feed rate F (0.01..0.1; default from pattern).'),
  kill: num(0.03, 0.08, 'Gray-Scott kill rate k (0.03..0.08; default from pattern).'),
  scale: num(0.5, 4, 'Spatial scale of the pattern (diffusion multiplier, 0.5..4, default 1).'),
  contrast: num(0, 2, 'Visual contrast of the V concentration field (0..2, default 1).'),
  secondColor: {
    type: ['string', 'null'],
    pattern: '^#[0-9a-fA-F]{6}$',
    description: 'Optional second colour (#rrggbb) that V blends the wet paint towards; null or omitted modulates pigment density/contrast.',
  },
  relief: unit('Impasto relief height written to the layer thick map as patterns grow (0..1, default 0).'),
});

const SOLID: JsonSchema = {
  type: 'string',
  pattern: '^(#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\\(\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*,\\s*\\d{1,3}\\s*(,\\s*(0|1|0?\\.\\d+)\\s*)?\\))$',
  description: 'A solid colour: #rrggbb, #rrggbbaa or rgba(r, g, b, a).',
};

const DUAL: JsonSchema = object('A colour for each colour scheme; the host picks one when the stroke starts and records it.', { light: SOLID, dark: SOLID }, ['light', 'dark']);

const EFFECT: JsonSchema = object(
  'Effect paint: the brush paints an effect (search_effects).',
  {
    type: { type: 'string', const: 'effect', description: 'Always "effect".' },
    effect: { type: 'string', minLength: 1, description: 'The effect id.' },
    provider: { type: 'string', description: "The provider's id when it was chosen." },
    values: { type: 'object', description: 'Every control value (number, string, boolean or a number list).' },
    time: { type: 'number', minimum: 0, description: 'Which moment of an animated effect, ms.' },
    map: object(
      'Lay the effect along each stroke instead of fixing it to the canvas.',
      {
        by: { type: 'string', const: 'stroke', description: 'Always "stroke".' },
        length: num(16, 4096, 'Strip length: px of stroke per repeat of the effect.'),
        repeat: oneOf(['repeat', 'mirror', 'clamp'], 'Past the strip end: start again, run back or hold.'),
      },
      ['by', 'length', 'repeat'],
    ),
    live: bool('On a stroke layer the stroke keeps playing the effect.'),
  },
  ['type', 'effect', 'provider', 'values', 'time'],
);

const PAINT: JsonSchema = {
  description: 'A colour a brush can carry: a solid colour, a light / dark pair, a gradient or effect paint.',
  anyOf: [SOLID, DUAL, PAINT_GRADIENT_JSON_SCHEMA as unknown as JsonSchema, EFFECT],
};

const COLOUR = object("The brush's colours. The user's colour still wins unless own is set.", {
  default: {
    ...PAINT,
    description: "The colour the brush starts with. A gradient is always painted (its paint / secondary stops take the user's colours); a solid colour or effect paint is suggested to the host.",
  },
  palette: { type: 'array', maxItems: MAX_BRUSH_PALETTE, items: PAINT, description: `Up to ${MAX_BRUSH_PALETTE} suggested colours.` },
  own: bool('The brush always paints its own colour (a rainbow marker); default false.'),
});

/** JSON Schema of a `Brush`. */
export const BRUSH_JSON_SCHEMA: JsonSchema = object(
  'A brush made of facets. Only id, name, kind and tip.shape are required; every other field takes the default for its engine.',
  {
    id: { type: 'string', pattern: BRUSH_ID.source, description: 'Library id: lowercase letters, digits and dashes, up to 64 characters.' },
    name: { type: 'string', minLength: 1, maxLength: 80, description: 'Display name.' },
    description: { type: 'string', maxLength: 500, description: 'What the brush is for, in a sentence.' },
    tags: { type: 'array', maxItems: 16, uniqueItems: true, items: { type: 'string', pattern: BRUSH_WORD.source, description: 'A tag: lowercase letters, digits and dashes.' }, description: 'Search tags.' },
    kind: oneOf(BRUSH_KINDS, 'mark: lays a material (see medium); tool: works on paint already down (see tool).'),
    medium: oneOf(BRUSH_MEDIA, 'Marks: what it lays. paint (dry, wet or thick), ink, dry (pencil, pastel, charcoal) or spray (airbrush). Descriptive: the tip, marks and behaviour decide how it renders.'),
    variety: { type: 'string', pattern: BRUSH_WORD.source, description: 'What kind of the medium: oil, watercolor, gouache, pencil, pastel, charcoal, airbrush, marker, highlighter… A wet brush whose variety is watercolor, gouache or oil paints that medium.' },
    tool: oneOf(
      BRUSH_TOOLS,
      'Tools: eraser removes paint; blender mixes the colours under the tip; smudge drags paint along; water lays clear water (lifts dried paint with behaviour.wet.rewet); dryer dries wet paint; blow pushes water along; blot takes wet paint up; wet-blend evens out wet pigment; wet-drag drags wet paint.',
    ),
    tip: TIP,
    marks: { description: 'How the tip is laid along the path (default continuous): continuous dabs, a scatter of spray droplets, particles, objects (editable stickers), or a scraper blade that cuts down through layers.', oneOf: [CONTINUOUS, SCATTER, PARTICLES, OBJECTS, SCRAPER] },
    dynamics: DYNAMICS,
    behaviour: BEHAVIOUR,
    light: LIGHT,
    fluorescence: FLUORESCENCE,
    thermochromic: THERMOCHROMIC,
    iridescence: IRIDESCENCE,
    ghost: GHOST,
    mutation: MUTATION,
    ferro: FERRO,
    motion: MOTION,
    livePatterns: LIVE_PATTERNS,
    colour: COLOUR,
  },
  ['id', 'name', 'kind', 'tip'],
);

/** The facet schemas, for tools that take one facet. */
export const BRUSH_FACET_SCHEMAS = {
  tip: TIP,
  tipGrain: TIP_GRAIN,
  marks: { continuous: CONTINUOUS, scatter: SCATTER, particles: PARTICLES, objects: OBJECTS, scraper: SCRAPER },
  dynamics: DYNAMICS,
  behaviour: BEHAVIOUR,
  light: LIGHT,
  fluorescence: FLUORESCENCE,
  thermochromic: THERMOCHROMIC,
  iridescence: IRIDESCENCE,
  ghost: GHOST,
  mutation: MUTATION,
  ferro: FERRO,
  motion: MOTION,
  livePatterns: LIVE_PATTERNS,
  colour: COLOUR,
  paint: PAINT,
} as const;
