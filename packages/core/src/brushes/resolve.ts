/**
 * From a facet `Brush` to the flat form the paint engine reads (`ResolvedBrush`, today's
 * `PaintBrush`). The engine is derived from the tip, the marks and the behaviour
 * (`resolveEngine`); the category the libraries group by is derived too (`resolveCategory`).
 *
 * `BRUSH_FIELDS` maps each facet field to the engine field it sets, for the engines that read it.
 * `migrateBrushV1` reads the same map the other way, so the two directions cannot drift apart.
 */

import { normalizePaintBrush, WET_MEDIA, type PaintBrushCategory, type PaintBrushEngine, type PaintBrushInput, type WetMediumKind, type WetTool } from '../paint-editor/brush-model';
import { editorStampOf } from '../stickers/helpers';
import type { Brush, BrushTool, ResolvedBrush } from './types';

const ALL: readonly PaintBrushEngine[] = ['dab', 'eraser', 'mixer', 'blender', 'smudge', 'wet', 'impasto', 'particle', 'bristle', 'sticker'];
/** Engines that pick up and mix paint dab by dab (the exchange ratios apply). */
const EXCHANGE: readonly PaintBrushEngine[] = ['dab', 'wet', 'impasto'];
/** Engines that lay dabs from the pen dab walker: tip grain, count and flip apply. */
const DABS: readonly PaintBrushEngine[] = ['dab', 'eraser', 'mixer', 'blender', 'smudge'];
/** Mark engines that can deposit a thin-film iridescence channel. */
const FILM: readonly PaintBrushEngine[] = ['dab', 'mixer', 'wet', 'impasto', 'particle', 'bristle'];

/** One facet field and the engine field it sets. */
export interface BrushField {
  /** Dot path in the facet brush. */
  facet: string;
  /** Dot path in the resolved brush. */
  engine: string;
  /** The engines that read it. */
  engines: readonly PaintBrushEngine[];
  /** When the two forms differ: facet value → engine value, and back. */
  map?: { toEngine(v: unknown): unknown; toFacet(v: unknown): unknown };
  /** Read only on these tip shapes. */
  shapes?: readonly string[];
  /** Read only with these marks kinds (default any). */
  marks?: readonly string[];
}

/** `dirty` is the Mixer Brush's `!cleanEachStroke`. */
const NOT = { toEngine: (v: unknown) => !v, toFacet: (v: unknown) => !v };
/** Textured particle dots: refs in the facet (`editor:star`, `host:id`); the editor's stamps are bare in the engine (`star`), other stickers stay refs. */
const EDITOR_STAMPS = {
  toEngine: (v: unknown) => (v as string[]).flatMap((ref) => {
    try {
      const stamp = editorStampOf(ref);
      return stamp ? [stamp] : ref.includes(':') ? [ref] : [];
    } catch {
      return [];
    }
  }),
  toFacet: (v: unknown) => (v as string[]).map((stamp) => (stamp.includes(':') ? stamp : `editor:${stamp}`)),
};
/** A continuous stamp tip lays one sticker: the first of `tip.stamps`. */
const ONE_STAMP = {
  toEngine: (v: unknown) => (v as string[])[0] ?? null,
  toFacet: (v: unknown) => (v ? [v as string] : undefined),
};

const f = (facet: string, engine: string, engines: readonly PaintBrushEngine[] = ALL, extra: Partial<BrushField> = {}): BrushField => ({ facet, engine, engines, ...extra });
const each = (facetPrefix: string, enginePrefix: string, keys: readonly string[], engines?: readonly PaintBrushEngine[]) => keys.map((k) => f(`${facetPrefix}.${k}`, `${enginePrefix}.${k}`, engines));

/** Every facet field and where it lands in the resolved brush. */
export const BRUSH_FIELDS: readonly BrushField[] = [
  ...each('tip', 'tip', ['size', 'hardness', 'spacing', 'angle', 'roundness', 'opacity', 'flow', 'blend']),
  ...each('dynamics', 'tip', ['smoothing', 'pressureSize', 'pressureOpacity']),
  f('dynamics.pressureSmoothing', 'pressureSmoothing'),
  f('dynamics.rotation', 'rotation'),
  ...each('dynamics', 'dynamics', ['minSize', 'pressureFlow', 'tiltSize', 'tiltRoundness', 'tiltOpacity', 'velocitySize', 'velocityOpacity', 'sizeJitter', 'angleJitter', 'opacityJitter', 'scatter']),
  f('dynamics.count', 'dynamics.count', DABS),
  f('dynamics.flip', 'dynamics.flip', DABS),
  f('tip.grain', 'tipGrain', DABS),
  f('behaviour.grain', 'grain'),
  ...each('light', 'light', ['amount', 'pressure']),
  ...each('fluorescence', 'fluorescence', ['amount', 'invisible']),
  ...each('thermochromic', 'thermochromic', ['hotColor', 'threshold']),
  ...each('iridescence', 'iridescence', ['thickness', 'pressureToThickness', 'ior'], FILM),
  // Paint exchange: the dab, wet and impasto engines' behaviour, or the Mixer Brush's settings.
  f('behaviour.exchange.pickup', 'behavior.pickup', EXCHANGE),
  f('behaviour.exchange.mix', 'behavior.mix', EXCHANGE),
  f('behaviour.exchange.dirty', 'behavior.dirty', EXCHANGE),
  f('behaviour.mixing', 'behavior.mixing', EXCHANGE),
  f('behaviour.exchange.pickup', 'mixer.wet', ['mixer']),
  f('behaviour.exchange.mix', 'mixer.mix', ['mixer']),
  f('behaviour.exchange.dirty', 'mixer.cleanEachStroke', ['mixer'], { map: NOT }),
  f('behaviour.mixing', 'mixer.mixing', ['mixer']),
  f('behaviour.exchange.reservoir.load', 'mixer.load', ['mixer']),
  f('behaviour.exchange.reservoir.refill', 'mixer.loadEachStroke', ['mixer']),
  f('behaviour.exchange.reservoir.loadsColour', 'loadsColor', ['mixer']),
  // Tools.
  f('behaviour.strength', 'blender.strength', ['blender']),
  f('behaviour.distance', 'blender.distance', ['blender']),
  f('behaviour.mixing', 'blender.mixing', ['blender']),
  f('behaviour.strength', 'smudge.strength', ['smudge']),
  f('behaviour.length', 'smudge.length', ['smudge']),
  f('behaviour.mixing', 'smudge.mixing', ['smudge']),
  f('behaviour.strength', 'wet.strength', ['wet']),
  // Surfaces.
  ...each('behaviour.wet', 'wet', ['medium', 'water', 'pigment', 'body', 'rewet', 'load', 'thinner'], ['wet']),
  ...each('ghost', 'ghost', ['linger', 'smear', 'trigger'], ['wet']),
  ...each('mutation', 'mutation', ['settle', 'patience', 'fade'], ['dab', 'wet', 'impasto', 'particle', 'bristle']),
  f('behaviour.thick.applicator', 'impasto.tool', ['impasto']),
  ...each('behaviour.thick', 'impasto', ['thickness', 'gloss', 'metallic', 'load', 'thinner', 'drag', 'rim', 'clarity'], ['impasto']),
  // Marks.
  f('marks.physics', 'particle.kind', ['particle']),
  ...each('marks', 'particle', ['render', 'count', 'size', 'spread', 'stiffness', 'damping', 'speed', 'gravity', 'life', 'interval', 'ribbonFill', 'ribbonPairs', 'waveAmplitude', 'waveLength', 'wavePhaseJitter'], ['particle']),
  f('marks.stampOrder', 'particle.dotTextureOrder', ['particle']),
  f('marks.stampRotation', 'particle.dotRotation', ['particle']),
  f('tip.stamps', 'particle.dotTextures', ['particle'], { shapes: ['stamp'], map: EDITOR_STAMPS }),
  f('motion.waveSpeed', 'particle.waveSpeed', ['particle']),
  f('tip.stamps', 'sticker.stamps', ['sticker'], { shapes: ['stamp'] }),
  f('tip.stamps', 'stamp', ['dab'], { shapes: ['stamp'], map: ONE_STAMP }),
  f('marks.density', 'spray.density', ['dab'], { marks: ['scatter'] }),
  f('marks.size', 'spray.size', ['dab'], { marks: ['scatter'] }),
  ...each('marks', 'sticker', ['density', 'sizeJitter', 'rotationJitter', 'scatter'], ['sticker']),
  f('marks.colourJitter', 'sticker.colorJitter', ['sticker']),
  ...each('tip.bristle', 'bristle', ['count', 'stiffness', 'splay', 'thickness', 'load', 'jitter'], ['bristle']),
];

/** The wet tool each wet-layer tool brush is. */
export const WET_TOOL_OF: Readonly<Partial<Record<BrushTool, WetTool>>> = { water: 'water', dryer: 'dry', blow: 'blow', blot: 'blot', 'wet-blend': 'blend', 'wet-drag': 'smudge' };

export function getPath(o: unknown, path: string): unknown {
  let v: unknown = o;
  for (const k of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

export function setPath(o: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let node = o;
  for (const k of keys.slice(0, -1)) {
    if (node[k] === null || typeof node[k] !== 'object') node[k] = {};
    node = node[k] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]] = value;
}

const copy = <T>(v: T): T => (v !== null && typeof v === 'object' ? (JSON.parse(JSON.stringify(v)) as T) : v);

/**
 * The engine that renders a brush: tools by what they do; marks by how they are laid
 * (particles, objects), the tip (bristle), the surface (thick, wet) and the paint exchange (a
 * reservoir makes a Mixer Brush); everything else paints dabs.
 */
export function resolveEngine(brush: Pick<Brush, 'kind' | 'tool' | 'tip' | 'marks' | 'behaviour'>): PaintBrushEngine {
  if (brush.kind === 'tool') return brush.tool === 'eraser' || brush.tool === 'blender' || brush.tool === 'smudge' ? brush.tool : 'wet';
  if (brush.marks?.kind === 'particles') return 'particle';
  if (brush.marks?.kind === 'objects') return 'sticker';
  if (brush.tip.shape === 'bristle') return 'bristle';
  const surface = brush.behaviour?.surface;
  if (surface === 'thick') return 'impasto';
  if (surface === 'wet') return 'wet';
  if (brush.behaviour?.exchange?.reservoir) return 'mixer';
  return 'dab';
}

/** Dab brush varieties that name a library category of their own. */
const VARIETY_CATEGORY: Readonly<Record<string, PaintBrushCategory>> = {
  pencil: 'pencil',
  pastel: 'pastel',
  'soft-pastel': 'pastel',
  'oil-pastel': 'pastel',
  crayon: 'pastel',
  chalk: 'pastel',
  charcoal: 'charcoal',
  airbrush: 'airbrush',
  marker: 'marker',
};

const MEDIUM_CATEGORY: Readonly<Record<string, PaintBrushCategory>> = { paint: 'paint', ink: 'ink', dry: 'pencil', spray: 'airbrush' };

/** The wet medium a wet brush paints: `behaviour.wet.medium`, else its variety when that is a wet medium. */
export function resolveWetMedium(brush: Pick<Brush, 'variety' | 'behaviour'>): WetMediumKind | undefined {
  return brush.behaviour?.wet?.medium ?? (WET_MEDIA.includes(brush.variety as WetMediumKind) ? (brush.variety as WetMediumKind) : undefined);
}

/**
 * The library category a brush is grouped under: tools by what they do; light brushes; then by
 * engine (particles are procedural, objects stickers, bristle, thick impasto, wet oil or
 * watercolour, the Mixer Brush); dab brushes by variety, then medium.
 */
export function resolveCategory(brush: Brush, engine: PaintBrushEngine = resolveEngine(brush)): PaintBrushCategory {
  if (brush.kind === 'tool') return brush.tool === 'eraser' || brush.tool === 'blender' || brush.tool === 'smudge' ? brush.tool : 'wet-tool';
  if ((brush.light?.amount ?? 0) > 0) return 'light';
  switch (engine) {
    case 'particle':
      return 'procedural';
    case 'sticker':
      return 'sticker';
    case 'bristle':
      return 'bristle';
    case 'impasto':
      return 'impasto';
    case 'wet':
      return resolveWetMedium(brush) === 'oil' ? 'oil' : 'watercolor';
    case 'mixer':
      return 'mixer';
    default:
      return (brush.variety && VARIETY_CATEGORY[brush.variety]) || (brush.medium && MEDIUM_CATEGORY[brush.medium]) || 'custom';
  }
}

export interface ResolveBrushOptions {
  /** Mark the result built-in (a library's presets). */
  builtin?: boolean;
}

/**
 * The flat engine form of a brush. Missing fields take the engine's defaults, and every value is
 * clamped into range, so any brush resolves (check it with `normalizeBrushSpec` first to hear
 * what was out of range).
 */
export function resolveBrush(brush: Brush, options: ResolveBrushOptions = {}): ResolvedBrush {
  const engine = resolveEngine(brush);
  const input: Record<string, unknown> = { id: brush.id, name: brush.name, category: resolveCategory(brush, engine), engine };
  for (const field of BRUSH_FIELDS) {
    if (!field.engines.includes(engine) || (field.shapes && !field.shapes.includes(brush.tip.shape)) || (field.marks && !field.marks.includes(brush.marks?.kind ?? 'continuous'))) continue;
    const v = getPath(brush, field.facet);
    if (v !== undefined) setPath(input, field.engine, field.map ? field.map.toEngine(v) : copy(v));
  }
  // Spray marks: the dab engine with droplets (their settings come from the fields above).
  if (engine === 'dab' && brush.marks?.kind === 'scatter') input.spray = { ...((input.spray as object | undefined) ?? {}) };
  if (brush.iridescence && FILM.includes(engine)) input.iridescence = { ...((input.iridescence as object | undefined) ?? {}) };
  if (engine === 'wet') {
    setPath(input, 'wet.tool', brush.kind === 'tool' ? WET_TOOL_OF[brush.tool!] : 'paint');
    const medium = resolveWetMedium(brush);
    if (medium) setPath(input, 'wet.medium', medium);
    if (brush.kind !== 'tool' && brush.ghost) input.ghost = { ...((input.ghost as object | undefined) ?? {}) };
  }
  if (brush.kind !== 'tool' && brush.mutation) input.mutation = { ...((input.mutation as object | undefined) ?? {}) };
  // Blenders and smudges only move paint already down.
  if (engine === 'blender' || engine === 'smudge') input.loadsColor = false;
  const paint = brush.colour?.default;
  if (paint && typeof paint === 'object' && 'type' in paint && paint.type === 'gradient') input.paint = copy(paint);
  return normalizePaintBrush({ ...(input as PaintBrushInput), ...(options.builtin ? { builtin: true } : {}) });
}
