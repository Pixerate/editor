/**
 * Host capability profiles: what a host (the paint editor, the image editor, brushed canvas and
 * vector strokes, later Swift) can render. `checkBrush` explains each refusal with a fix,
 * `listPresets` filters a library down to what the host can use, and `degrade` strips the facets
 * a host can't render and says what it dropped.
 *
 * A capability is `full` (rendered), `ignored` (the brush is accepted but the host paints without
 * it: a warning) or `none` (the brush is refused: an error).
 */

import { BRUSH_PRESETS } from './presets';
import { isBrushSourceRef } from './sources';
import { BRUSH_MARKS_KINDS, BRUSH_TIP_SHAPES, BRUSH_TOOLS, type Brush, type BrushKind, type BrushMarksKind, type BrushPaint, type BrushSurface, type BrushTipShape, type BrushTool } from './types';

export type BrushSupport = 'full' | 'ignored' | 'none';

/** What a colour is: a solid colour, a light / dark pair, a gradient or effect paint. */
export type BrushColourKind = 'solid' | 'dual' | 'gradient' | 'effect';

export interface BrushHostProfile {
  /** `paint`, `image`, `canvas`, `vector`… */
  id: string;
  name: string;
  kinds: readonly BrushKind[];
  /** Tools the host has (for `kind: 'tool'`). */
  tools: readonly BrushTool[];
  tipShapes: readonly BrushTipShape[];
  marks: readonly BrushMarksKind[];
  surfaces: readonly BrushSurface[];
  /** Picking paint up and mixing it in (`behaviour.exchange` pickup, mix, dirty). */
  exchange: BrushSupport;
  /** The Mixer Brush (`behaviour.exchange.reservoir`). */
  reservoir: BrushSupport;
  /** Paper grain response (`behaviour.grain`). */
  grain: BrushSupport;
  light: BrushSupport;
  motion: BrushSupport;
  /** Colour kinds the brush's default colour may be (palette entries of other kinds are warned about). */
  colours: readonly BrushColourKind[];
  /** Velocity dynamics (needs timed input). */
  velocity: BrushSupport;
  /** Tilt dynamics (needs pen tilt). */
  tilt: BrushSupport;
  /** Texture inside the tip (`tip.grain`); missing: `none`. */
  tipGrain?: BrushSupport;
  /** Several dabs per spacing step (`dynamics.count` above 1); missing: `none`. */
  dabCount?: BrushSupport;
}

export interface BrushIssue {
  /** The facet path the issue is about, e.g. `tip.shape`, `light`, `behaviour.exchange.reservoir`. */
  facet: string;
  /** `error`: the host can't render the brush; `warning`: it renders it without this setting. */
  severity: 'error' | 'warning';
  reason: string;
  fix: string;
}

export interface BrushCheck {
  /** No errors (warnings may remain). */
  ok: boolean;
  issues: BrushIssue[];
}

const ALL_COLOURS: readonly BrushColourKind[] = ['solid', 'dual', 'gradient', 'effect'];
const ELLIPSES: readonly BrushTipShape[] = ['round', 'flat', 'chisel'];

/** The paint editor: every facet. */
export const PAINT_PROFILE: BrushHostProfile = {
  id: 'paint',
  name: 'Paint editor',
  kinds: ['mark', 'tool'],
  tools: BRUSH_TOOLS,
  tipShapes: BRUSH_TIP_SHAPES,
  marks: BRUSH_MARKS_KINDS,
  surfaces: ['dry', 'wet', 'thick'],
  exchange: 'full',
  reservoir: 'full',
  grain: 'full',
  light: 'full',
  motion: 'full',
  colours: ALL_COLOURS,
  velocity: 'full',
  tilt: 'full',
  tipGrain: 'full',
  dabCount: 'full',
};

/** The image editor's brush: dry dabs on pixels, its Mixer Brush and the eraser. */
export const IMAGE_PROFILE: BrushHostProfile = {
  id: 'image',
  name: 'Image editor',
  kinds: ['mark', 'tool'],
  tools: ['eraser'],
  tipShapes: ELLIPSES,
  marks: ['continuous'],
  surfaces: ['dry'],
  exchange: 'ignored',
  reservoir: 'full',
  grain: 'ignored',
  light: 'none',
  motion: 'none',
  colours: ['solid', 'dual', 'gradient'],
  velocity: 'ignored',
  tilt: 'ignored',
  tipGrain: 'ignored',
  dabCount: 'ignored',
};

/**
 * Brushed canvas strokes: dry dab brushes along a path. Light paint needs the paint editor's
 * light channel (glow and spill), which canvas strokes don't have, so it is refused.
 */
export const CANVAS_PROFILE: BrushHostProfile = {
  id: 'canvas',
  name: 'Canvas',
  kinds: ['mark'],
  tools: [],
  tipShapes: ELLIPSES,
  marks: ['continuous'],
  surfaces: ['dry'],
  exchange: 'ignored',
  reservoir: 'none',
  grain: 'full',
  light: 'none',
  motion: 'none',
  colours: ['solid', 'dual', 'gradient'],
  velocity: 'ignored',
  tilt: 'full',
  tipGrain: 'ignored',
  dabCount: 'ignored',
};

/** Vector brushstrokes: dry dab brushes along a path; light brushes paint as plain colour. */
export const VECTOR_PROFILE: BrushHostProfile = { ...CANVAS_PROFILE, id: 'vector', name: 'Vector editor', light: 'ignored' };

/** The built-in profiles by id. */
export const BRUSH_HOST_PROFILES: Readonly<Record<string, BrushHostProfile>> = { paint: PAINT_PROFILE, image: IMAGE_PROFILE, canvas: CANVAS_PROFILE, vector: VECTOR_PROFILE };

/** What kind of colour a `BrushPaint` is. */
export function brushColourKind(paint: BrushPaint): BrushColourKind {
  if (typeof paint === 'string') return 'solid';
  if ('type' in paint) return paint.type === 'gradient' ? 'gradient' : 'effect';
  return 'dual';
}

const list = (values: readonly string[]) => values.join(', ');
const nonZero = (v: number | undefined) => v !== undefined && v !== 0;

/** What a brush needs from a host, and what the host does about it. */
export function checkBrush(brush: Brush, profile: BrushHostProfile): BrushCheck {
  const issues: BrushIssue[] = [];
  const host = profile.name;
  const add = (facet: string, severity: BrushIssue['severity'], reason: string, fix: string) => issues.push({ facet, severity, reason, fix });
  /** One capability: refused (`none`) or painted without (`ignored`). */
  const feature = (support: BrushSupport, used: boolean, facet: string, what: string, fix: string) => {
    if (!used || support === 'full') return;
    if (support === 'none') add(facet, 'error', `${host} can't paint ${what}.`, fix);
    else add(facet, 'warning', `${host} paints this brush without ${what}.`, `Nothing to do; or ${fix.charAt(0).toLowerCase()}${fix.slice(1)}`);
  };

  if (!profile.kinds.includes(brush.kind)) add('kind', 'error', `${host} has no ${brush.kind} brushes.`, `Use a ${list(profile.kinds)} brush.`);
  else if (brush.kind === 'tool' && brush.tool && !profile.tools.includes(brush.tool)) {
    add('tool', 'error', `${host} has no ${brush.tool} tool.`, profile.tools.length ? `Use one of: ${list(profile.tools)}.` : `${host} has no tools; use a mark brush.`);
  }
  if (!profile.tipShapes.includes(brush.tip.shape)) {
    const image = brush.tip.shape === 'stamp' && (brush.tip.stamps ?? []).some(isBrushSourceRef);
    add('tip.shape', 'error', `${host} can't lay a ${image ? 'stamp tip (image tips are stamps)' : `${brush.tip.shape} tip`}.`, `Set tip.shape to one of: ${list(profile.tipShapes)}.`);
  }
  const marks = brush.marks?.kind ?? 'continuous';
  if (!profile.marks.includes(marks)) add('marks', 'error', `${host} can't lay ${marks} marks.`, `Use marks ${list(profile.marks)} (remove marks for continuous dabs).`);
  const surface = brush.behaviour?.surface ?? 'dry';
  if (brush.kind === 'mark' && !profile.surfaces.includes(surface)) add('behaviour.surface', 'error', `${host} has no ${surface} surface.`, `Set behaviour.surface to ${list(profile.surfaces)}.`);

  const ex = brush.behaviour?.exchange;
  feature(profile.reservoir, !!ex?.reservoir, 'behaviour.exchange.reservoir', 'a Mixer Brush reservoir', 'Remove behaviour.exchange.reservoir.');
  feature(profile.exchange, !ex?.reservoir && (nonZero(ex?.pickup) || !!ex?.dirty), 'behaviour.exchange', 'picking paint up', 'Remove behaviour.exchange.');
  feature(profile.grain, nonZero(brush.behaviour?.grain), 'behaviour.grain', 'paper grain', 'Set behaviour.grain to 0.');
  feature(profile.light, nonZero(brush.light?.amount), 'light', 'light paint (glow and spill)', 'Remove light (or set light.amount to 0).');
  const m = brush.motion;
  feature(profile.motion, !!m && (!!m.live || nonZero(m.waveSpeed) || m.fps !== undefined), 'motion', 'animation', 'Remove motion.');
  const d = brush.dynamics ?? {};
  feature(profile.tipGrain ?? 'none', !!brush.tip.grain, 'tip.grain', 'tip grain', 'Remove tip.grain (behaviour.grain textures with the paper instead).');
  feature(profile.dabCount ?? 'none', (d.count ?? 1) > 1, 'dynamics.count', 'several dabs per step', 'Set dynamics.count to 1.');
  feature(profile.velocity, nonZero(d.velocitySize) || nonZero(d.velocityOpacity), 'dynamics.velocity', 'velocity dynamics (its strokes carry no timing)', 'Set dynamics.velocitySize and velocityOpacity to 0.');
  feature(profile.tilt, nonZero(d.tiltSize) || nonZero(d.tiltRoundness) || nonZero(d.tiltOpacity), 'dynamics.tilt', 'tilt dynamics', 'Set dynamics.tiltSize, tiltRoundness and tiltOpacity to 0.');

  const colour = brush.colour;
  if (colour?.default !== undefined) {
    const kind = brushColourKind(colour.default);
    if (!profile.colours.includes(kind)) add('colour.default', 'error', `${host} can't paint ${kind} colours.`, `Use a ${list(profile.colours)} colour, or remove colour.default.`);
  }
  const foreign = [...new Set((colour?.palette ?? []).map(brushColourKind).filter((k) => !profile.colours.includes(k)))];
  if (foreign.length) add('colour.palette', 'warning', `${host} skips the palette's ${list(foreign)} colours.`, `Nothing to do; or keep to ${list(profile.colours)} colours.`);

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

export interface BrushEditCheck extends BrushCheck {
  /**
   * Errors the brush had before the edit: facets this host can't use, kept unchanged for the
   * hosts that can (a light paint brush edited in Canvas keeps its light). Not in `issues`.
   */
  kept: BrushIssue[];
}

/**
 * A check of an edit: errors the original brush already had (`before`, its check for the same
 * host) are kept rather than refused, so a host edits what it renders and leaves the rest alone.
 * Without `before` (a new brush) every error refuses it.
 */
export function withKeptIssues(check: BrushCheck, before: BrushCheck | null): BrushEditCheck {
  const had = new Set((before?.issues ?? []).filter((i) => i.severity === 'error').map((i) => i.facet));
  const kept = check.issues.filter((i) => i.severity === 'error' && had.has(i.facet));
  const issues = check.issues.filter((i) => !kept.includes(i));
  return { ok: !issues.some((i) => i.severity === 'error'), issues, kept };
}

/** `checkBrush` for an edit of `original` (`null`: a new brush), keeping facets it already had that the host can't use. */
export function checkBrushEdit(original: Brush | null, brush: Brush, profile: BrushHostProfile): BrushEditCheck {
  return withKeptIssues(checkBrush(brush, profile), original ? checkBrush(original, profile) : null);
}

/** The presets (default: the built-in ones) a host can render, in library order. */
export function listPresets(profile: BrushHostProfile, presets: readonly Brush[] = BRUSH_PRESETS): Brush[] {
  return presets.filter((b) => checkBrush(b, profile).ok);
}

export interface DegradedBrush {
  /** The brush with what the host can't render stripped (a copy). */
  brush: Brush;
  /** The errors fixed by stripping a facet. */
  dropped: BrushIssue[];
  /** Errors that stripping cannot fix (an unsupported kind or tool): the host still refuses it. */
  issues: BrushIssue[];
}

/**
 * The brush the host can render: facets it refuses are removed (light, motion, a reservoir, a
 * wet or thick surface, particle or object marks, bristle and stamp tips become round, an
 * unsupported default colour), each reported in `dropped`. A tool the host lacks can't be
 * stripped and stays in `issues`. `ignored: true` also removes what the host paints without
 * (its warnings: velocity on canvas, grain in the image editor, palette colours it skips), for
 * a brush made only of what the host uses.
 */
export function degrade(brush: Brush, profile: BrushHostProfile, options: { ignored?: boolean } = {}): DegradedBrush {
  const before = checkBrush(brush, profile).issues.filter((i) => i.severity === 'error' || options.ignored);
  const b = JSON.parse(JSON.stringify(brush)) as Brush;
  const dropped: BrushIssue[] = [];
  for (const issue of before) {
    switch (issue.facet) {
      case 'tip.shape':
        b.tip = { ...b.tip, shape: profile.tipShapes.includes('round') ? 'round' : profile.tipShapes[0]! };
        delete b.tip.bristle;
        delete b.tip.stamps;
        break;
      case 'marks':
        delete b.marks;
        if (b.tip.shape === 'stamp') {
          b.tip.shape = 'round';
          delete b.tip.stamps;
        }
        break;
      case 'behaviour.surface':
        delete b.behaviour!.surface;
        delete b.behaviour!.wet;
        delete b.behaviour!.thick;
        break;
      case 'behaviour.exchange.reservoir':
        delete b.behaviour!.exchange!.reservoir;
        break;
      case 'behaviour.exchange':
        delete b.behaviour!.exchange;
        break;
      case 'behaviour.grain':
        delete b.behaviour!.grain;
        break;
      case 'tip.grain':
        delete b.tip.grain;
        break;
      case 'dynamics.count':
        delete b.dynamics!.count;
        break;
      case 'light':
        delete b.light;
        break;
      case 'motion':
        delete b.motion;
        break;
      case 'dynamics.velocity':
        delete b.dynamics!.velocitySize;
        delete b.dynamics!.velocityOpacity;
        break;
      case 'dynamics.tilt':
        delete b.dynamics!.tiltSize;
        delete b.dynamics!.tiltRoundness;
        delete b.dynamics!.tiltOpacity;
        break;
      case 'colour.default':
        delete b.colour!.default;
        break;
      case 'colour.palette':
        b.colour!.palette = b.colour!.palette!.filter((c) => profile.colours.includes(brushColourKind(c)));
        if (!b.colour!.palette.length) delete b.colour!.palette;
        break;
      default:
        continue;
    }
    dropped.push(issue);
  }
  // A Mixer Brush stripped of its reservoir with nothing else to exchange.
  if (b.behaviour?.exchange && !Object.keys(b.behaviour.exchange).length) delete b.behaviour.exchange;
  if (b.colour && !Object.keys(b.colour).length) delete b.colour;
  // Removing a tip or mark facet can surface a new refusal (a stamp tip once its marks are gone).
  const after = checkBrush(b, profile).issues.filter((i) => i.severity === 'error');
  return { brush: b, dropped, issues: after };
}
