/**
 * The brush editor as data, for the React and Svelte `BrushEditor` and `BrushLibraryBrowser`:
 * `brushEditorSections` lists a brush's facets as ordered sections of controls (Medium, Shape,
 * Marks, Feel, Behaviour, Light, Motion, Colour), each control a facet path with its value,
 * range and label, leaving out what the host profile can't render. `setBrushEditorValue` applies
 * one control's change; `brushLibraryGroups` groups a library by medium and variety, tools apart.
 *
 * Sliders reuse the paint editor's tables (`BRUSH_SLIDERS`, `brushEngineControls`), mapped from
 * engine paths to facet paths through `BRUSH_FIELDS`, so the panels and the editor agree.
 */

import { BLEND_MODES } from '../raster/blend';
import { BRUSH_ROTATIONS, IMPASTO_TOOLS, MAX_BRUSH_SIZE, WET_MEDIA } from '../paint-editor/brushes';
import { BRUSH_SLIDERS, brushEngineControls, type SliderControl } from '../paint-editor/brush-controls';
import { DOT_ROTATIONS, DOT_TEXTURE_ORDERS, MAX_DOT_TEXTURES, MAX_STICKER_STAMPS, PARTICLE_KINDS, PARTICLE_RENDERS, RIBBON_PAIRS, STAMP_KINDS } from '../paint-editor/mark-settings';
import { BrushLibraryError, type AddBrushSourceResult, type BrushLibrary, type BrushLibraryEntry, type SaveBrushResult } from './library';
import { normalizeBrushSpec } from './normalize';
import { brushColourKind, checkBrush, checkBrushEdit, degrade, PAINT_PROFILE, type BrushHostProfile, type BrushIssue, type BrushSupport } from './profiles';
import { BRUSH_FIELDS, getPath, resolveBrush, resolveEngine, setPath } from './resolve';
import { MAX_BRUSH_PALETTE, TIP_GRAIN_PATTERNS } from './schema';
import { brushSourceRef, BrushSourceError, type BrushSource, type BrushSourceChannel } from './sources';
import { bytesToBase64, isPng } from '../raster/png';
import { brushColourHex } from './colour';
import { isDualColor } from '../color/dual';
import { BRUSH_FLIPS, BRUSH_GRAIN_MODES, BRUSH_MEDIA, type Brush, type BrushMedium, type BrushTool } from './types';

export type BrushEditorSectionId = 'medium' | 'shape' | 'grain' | 'marks' | 'feel' | 'behaviour' | 'light' | 'motion' | 'colour';

interface ControlBase {
  /** Facet path the control sets (`tip.size`, `behaviour.exchange.pickup`…). */
  path: string;
  label: string;
  /** Accessible name (stable across hosts, for tests and assistive tech). */
  ariaLabel: string;
  /** Set when the host paints without this setting (its profile ignores it). */
  note?: string;
}

export type BrushEditorControl =
  | (ControlBase & { kind: 'slider'; min: number; max: number; step: number; value: number })
  | (ControlBase & { kind: 'choice'; options: ReadonlyArray<{ value: string; label: string }>; value: string })
  | (ControlBase & { kind: 'toggle'; value: boolean })
  | (ControlBase & { kind: 'text'; value: string; placeholder?: string })
  /**
   * A solid colour (#rrggbb, its light side when `dark` is set), or `null` when there is none (or
   * the default is a gradient or effect: `gradient` says so). `dark`: the dark side of a light /
   * dark pair, `null` for one colour in both schemes.
   */
  | (ControlBase & { kind: 'colour'; value: string | null; dark: string | null; gradient: boolean })
  /** Suggested colours: solid (#rrggbb) or light / dark pairs; gradient and effect entries are left out. */
  | (ControlBase & { kind: 'palette'; value: Array<string | { light: string; dark: string }>; max: number })
  /**
   * Stamp refs (`editor:star`, `source:<id>`…): `options` are the editor's stamps and the image
   * sources the host passed (`brushEditorSections`' `sources`); hosts may offer more refs.
   */
  | (ControlBase & { kind: 'stamps'; value: string[]; max: number; options: ReadonlyArray<{ value: string; label: string }> });

/** What the host knows beyond the brush: the image sources it can paint with. */
export interface BrushEditorContext {
  /** The library's image sources (`listSources`), offered as stamps and grain. */
  sources?: ReadonlyArray<Pick<BrushSource, 'id' | 'name'>>;
}

export interface BrushEditorSection {
  id: BrushEditorSectionId;
  title: string;
  controls: BrushEditorControl[];
}

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ');
const options = (values: readonly string[], labels: Readonly<Record<string, string>> = {}) => values.map((value) => ({ value, label: labels[value] ?? title(value) }));

const MEDIUM_LABELS: Readonly<Record<BrushMedium, string>> = { paint: 'Paint', ink: 'Ink', dry: 'Dry media', spray: 'Spray' };
const TOOL_LABELS: Readonly<Record<BrushTool, string>> = { eraser: 'Eraser', blender: 'Blender', smudge: 'Smudge', water: 'Add water', dryer: 'Dry', blow: 'Blow', blot: 'Blot', 'wet-blend': 'Wet blend', 'wet-drag': 'Wet smudge' };
const SHAPE_LABELS: Readonly<Record<string, string>> = { round: 'Round', flat: 'Flat', chisel: 'Chisel', bristle: 'Bristle', stamp: 'Stamp' };
const MARKS_LABELS: Readonly<Record<string, string>> = { continuous: 'Continuous', particles: 'Particles', objects: 'Stickers' };
const SURFACE_LABELS: Readonly<Record<string, string>> = { dry: 'Dry', wet: 'Wet (flows)', thick: 'Thick (impasto)' };
const ROTATION_LABELS: Readonly<Record<string, string>> = { fixed: 'Fixed', stroke: 'Follow stroke', barrel: 'Pen barrel' };
const PHYSICS_LABELS: Readonly<Record<string, string>> = { string: 'Strings', spring: 'Springs', orbit: 'Orbits', flow: 'Flow', elastic: 'Elastic', fuzzy: 'Fuzzy' };
const RENDER_LABELS: Readonly<Record<string, string>> = { dot: 'Dots', line: 'Lines', sequence: 'Beads', ribbon: 'Ribbon' };
const APPLICATOR_LABELS: Readonly<Record<string, string>> = { brush: 'Brush', tube: 'Paint tube', knife: 'Palette knife', roller: 'Roller', gloop: 'Gloop pen' };
const WET_MEDIUM_LABELS: Readonly<Record<string, string>> = { watercolor: 'Watercolour', gouache: 'Gouache', oil: 'Oil' };
const STAMP_OPTIONS = STAMP_KINDS.map((k) => ({ value: `editor:${k}`, label: title(k) }));
const GRAIN_MODE_LABELS: Readonly<Record<string, string>> = { texturised: 'Texturised (stays put)', moving: 'Moving (rolls with the tip)' };
const FLIP_LABELS: Readonly<Record<string, string>> = { none: 'None', x: 'Across', y: 'Along', xy: 'Both' };
/** Engines whose dabs take tip grain, several dabs per step and flips (as `BRUSH_FIELDS` maps them). */
const DAB_ENGINES = new Set(['dab', 'eraser', 'mixer', 'blender', 'smudge']);

/** The ariaLabels the paint panels have always used, by facet path. */
const ARIA: Readonly<Record<string, string>> = {
  'dynamics.rotation': 'Brush rotation',
  'tip.blend': 'Brush blend',
  'behaviour.mixing': 'Brush mixing',
  'behaviour.exchange.dirty': 'Dirty brush',
  'marks.physics': 'Particle kind',
  'marks.render': 'Particle render',
  'marks.ribbonPairs': 'Ribbon pairs',
  'marks.stampOrder': 'Dot texture order',
  'marks.stampRotation': 'Dot rotation',
  'behaviour.wet.medium': 'Wet medium',
  'behaviour.thick.applicator': 'Impasto tool',
  'light.pressure': 'Light follows pressure',
  'tip.grain.source': 'Tip grain',
  'dynamics.angleJitter': 'Brush rotation jitter',
};
const aria = (path: string, label: string) => ARIA[path] ?? `Brush ${label.toLowerCase()}`;

/**
 * Sections of controls for a brush, in order, as the host `profile` (default the paint editor)
 * can render them: only the sections, controls and options the host uses are listed. Facets of
 * the brush the host can't use (a paint brush's light opened in Canvas) get no control, so an
 * edit keeps them as they are; `brushEditorScope` names them. Values are the brush's own, else
 * the defaults of the engine it resolves to.
 */
export function brushEditorSections(brush: Brush, profile: BrushHostProfile = PAINT_PROFILE, context: BrushEditorContext = {}): BrushEditorSection[] {
  const resolved = resolveBrush(brush);
  const engine = resolveEngine(brush);
  const fieldOf = (facet: string) => BRUSH_FIELDS.find((f) => f.facet === facet && f.engines.includes(engine));
  // The panels set a Mixer Brush's pick-up and mix through `behavior` too; the facet is the same.
  const facetOf = (enginePath: string) => (BRUSH_FIELDS.find((f) => f.engine === enginePath && f.engines.includes(engine)) ?? BRUSH_FIELDS.find((f) => f.engine === enginePath))?.facet;
  const value = (path: string): unknown => {
    const own = getPath(brush, path);
    if (own !== undefined) return own;
    const field = fieldOf(path);
    if (!field) return undefined;
    const v = getPath(resolved, field.engine);
    return field.map ? field.map.toFacet(v) : v;
  };
  const issues = checkBrush(brush, profile).issues;
  const warned = new Map(issues.filter((i) => i.severity === 'warning').map((i) => [i.facet, i.reason]));
  const refused = new Set(issues.filter((i) => i.severity === 'error').map((i) => i.facet));
  const full = (s: BrushSupport) => s === 'full';
  // The brush paints with an engine this host has: that engine's own controls apply.
  const engineOk = !['kind', 'tool', 'tip.shape', 'marks', 'behaviour.surface'].some((f) => refused.has(f));
  const noteFor = (path: string) => [...warned].find(([facet]) => path === facet || path.startsWith(`${facet}.`))?.[1];
  const withNote = <C extends BrushEditorControl>(c: C): C => {
    const note = noteFor(c.path);
    return note ? { ...c, note } : c;
  };
  const slider = (c: SliderControl, path = facetOf(c.path)): BrushEditorControl | null => {
    if (!path) return null;
    const v = value(path);
    return withNote({ kind: 'slider', path, label: c.label, ariaLabel: aria(path, c.label), min: c.min, max: path === 'tip.size' ? Math.min(c.max, MAX_BRUSH_SIZE) : c.max, step: c.step, value: typeof v === 'number' ? v : c.min });
  };
  const choice = (path: string, label: string, opts: ReadonlyArray<{ value: string; label: string }>, fallback = opts[0]?.value ?? ''): BrushEditorControl => withNote({ kind: 'choice', path, label, ariaLabel: aria(path, label), options: opts, value: String(value(path) ?? fallback) });
  const toggle = (path: string, label: string): BrushEditorControl => withNote({ kind: 'toggle', path, label, ariaLabel: aria(path, label), value: Boolean(value(path)) });
  const present = (cs: Array<BrushEditorControl | null | false | undefined | "">) => cs.filter((c): c is BrushEditorControl => Boolean(c));
  const sections: BrushEditorSection[] = [];
  const add = (id: BrushEditorSectionId, name: string, controls: Array<BrushEditorControl | null | false | undefined | "">) => {
    const list = present(controls);
    if (list.length) sections.push({ id, title: name, controls: list });
  };
  const isTool = brush.kind === 'tool';
  const shape = brush.tip.shape;
  const sourceOptions = (context.sources ?? []).map((x) => ({ value: brushSourceRef(x.id), label: x.name }));
  const marks = brush.marks?.kind ?? 'continuous';
  // Picking paint up: the Mixer Brush's reservoir carries it where the host has one.
  const exchangeFull = full(brush.behaviour?.exchange?.reservoir ? profile.reservoir : profile.exchange);

  add('medium', 'Medium', [
    profile.kinds.length > 1 && profile.kinds.includes(brush.kind) && choice('kind', 'Kind', options(profile.kinds, { mark: 'Lays a material', tool: 'Works on paint' })),
    !isTool && choice('medium', 'Medium', [{ value: '', label: 'Any' }, ...options(BRUSH_MEDIA, MEDIUM_LABELS)], ''),
    !isTool && withNote({ kind: 'text', path: 'variety', label: 'Variety', ariaLabel: 'Brush variety', value: brush.variety ?? '', placeholder: 'pencil, oil, highlighter…' }),
    isTool && !!brush.tool && profile.tools.includes(brush.tool) && choice('tool', 'Tool', options(profile.tools, TOOL_LABELS)),
  ]);

  const engineControls = brushEngineControls(resolved);
  const tipSliders = BRUSH_SLIDERS.filter((c) => c.path.startsWith('tip.') && c.path !== 'tip.smoothing');
  add('shape', 'Shape', [
    !refused.has('tip.shape') && choice('tip.shape', 'Tip', options(profile.tipShapes.filter((s) => !isTool || s !== 'stamp'), SHAPE_LABELS)),
    ...tipSliders.map((c) => slider(c)),
    engine === 'dab' && choice('tip.blend', 'Blend', BLEND_MODES.map((m) => ({ value: m.id, label: m.label })), 'normal'),
    ...(shape === 'bristle' && engineOk && engineControls ? engineControls.sliders.filter((c) => c.path.startsWith('bristle.')).map((c) => slider(c)) : []),
    shape === 'stamp' && engineOk && withNote({ kind: 'stamps', path: 'tip.stamps', label: 'Stamps', ariaLabel: 'Brush stamps', value: [...((value('tip.stamps') as string[] | undefined) ?? [])], max: marks === 'particles' ? MAX_DOT_TEXTURES : MAX_STICKER_STAMPS, options: marks === 'objects' ? STAMP_OPTIONS : [...STAMP_OPTIONS, ...sourceOptions] }),
  ]);

  // Tip grain: texture inside each dab, where the host has it and the brush lays dabs.
  const dabs = DAB_ENGINES.has(engine) && engineOk && shape !== 'bristle' && marks !== 'particles' && marks !== 'objects';
  const grain = brush.tip.grain;
  if (dabs && full(profile.tipGrain ?? 'none')) {
    add('grain', 'Tip grain', [
      choice('tip.grain.source', 'Texture', [{ value: '', label: 'None' }, ...options(TIP_GRAIN_PATTERNS), ...sourceOptions], ''),
      !!grain && choice('tip.grain.mode', 'Grain moves', options(BRUSH_GRAIN_MODES, GRAIN_MODE_LABELS), 'texturised'),
      !!grain && withNote({ kind: 'slider', path: 'tip.grain.scale', label: 'Grain scale', ariaLabel: 'Brush grain scale', min: 0.1, max: 8, step: 0.05, value: grain.scale ?? 1 }),
      !!grain && withNote({ kind: 'slider', path: 'tip.grain.depth', label: 'Grain depth', ariaLabel: 'Brush grain depth', min: 0, max: 1, step: 0.01, value: grain.depth ?? 0.6 }),
      !!grain && withNote({ kind: 'slider', path: 'tip.grain.contrast', label: 'Grain contrast', ariaLabel: 'Brush grain contrast', min: 0, max: 3, step: 0.05, value: grain.contrast ?? 1 }),
      !!grain && toggle('tip.grain.invert', 'Invert grain'),
    ]);
  }

  if (!isTool && profile.marks.length > 1 && engineOk) {
    const particles = marks === 'particles' && engineControls ? engineControls.sliders.filter((c) => c.path.startsWith('particle.') && c.path !== 'particle.waveSpeed') : [];
    const objects = marks === 'objects' && engineControls ? engineControls.sliders.filter((c) => c.path.startsWith('sticker.')) : [];
    const render = value('marks.render');
    add('marks', 'Marks', [
      choice('marks.kind', 'Laid as', options(profile.marks, MARKS_LABELS), 'continuous'),
      marks === 'particles' && choice('marks.physics', 'Particles', options(PARTICLE_KINDS, PHYSICS_LABELS)),
      marks === 'particles' && choice('marks.render', 'Drawn as', options(PARTICLE_RENDERS, RENDER_LABELS)),
      marks === 'particles' && render === 'ribbon' && choice('marks.ribbonPairs', 'Ribbon joins', options(RIBBON_PAIRS, { adjacent: 'Neighbours', 'first-last': 'Outermost' })),
      marks === 'particles' && shape === 'stamp' && choice('marks.stampOrder', 'Texture order', options(DOT_TEXTURE_ORDERS, { sequence: 'In turn', random: 'Random' })),
      marks === 'particles' && shape === 'stamp' && choice('marks.stampRotation', 'Texture turn', options(DOT_ROTATIONS, { follow: 'Follow motion', random: 'Random', fixed: 'Tip angle' })),
      ...particles.map((c) => slider(c)),
      ...objects.map((c) => slider(c)),
    ]);
  }

  const feel = BRUSH_SLIDERS.filter((c) => ['tip.smoothing', 'pressureSmoothing', 'dynamics.minSize', 'dynamics.tiltSize', 'dynamics.velocitySize'].includes(c.path)).filter((c) => !(c.path === 'dynamics.tiltSize' && !full(profile.tilt)) && !(c.path === 'dynamics.velocitySize' && !full(profile.velocity)));
  // Variety for stamp and image tips: several dabs per step, jitter and flips.
  const stampDabs = dabs && shape === 'stamp';
  const jitter = (path: string, label: string, max = 1, step = 0.01) => withNote({ kind: 'slider', path, label, ariaLabel: aria(path, label), min: 0, max, step, value: Number(value(path) ?? 0) });
  add('feel', 'Feel', [
    ...feel.map((c) => slider(c)),
    toggle('dynamics.pressureSize', 'Pressure → size'),
    toggle('dynamics.pressureOpacity', 'Pressure → opacity'),
    choice('dynamics.rotation', 'Rotation', options(BRUSH_ROTATIONS, ROTATION_LABELS)),
    stampDabs && full(profile.dabCount ?? 'none') && withNote({ kind: 'slider', path: 'dynamics.count', label: 'Count', ariaLabel: 'Brush dab count', min: 1, max: 16, step: 1, value: brush.dynamics?.count ?? 1 }),
    stampDabs && jitter('dynamics.scatter', 'Scatter', 4),
    stampDabs && jitter('dynamics.angleJitter', 'Rotation jitter'),
    stampDabs && jitter('dynamics.sizeJitter', 'Size jitter'),
    stampDabs && choice('dynamics.flip', 'Flip', options(BRUSH_FLIPS, FLIP_LABELS), 'none'),
  ]);

  const surfaces = profile.surfaces;
  const engineSliders = (engineOk ? (engineControls?.sliders ?? []) : []).filter((c) => !/^(bristle|particle|sticker|iridescence)\./.test(c.path) && c.path !== 'light.amount' && c.path !== 'impasto.rim' && c.path !== 'impasto.clarity');
  const exchangeOk = (path: string | undefined) => !path?.startsWith('behaviour.exchange') || (path.startsWith('behaviour.exchange.reservoir') ? full(profile.reservoir) : exchangeFull);
  add('behaviour', engineControls?.title ?? 'Behaviour', [
    !isTool && surfaces.length > 1 && !refused.has('behaviour.surface') && choice('behaviour.surface', 'Surface', options(surfaces, SURFACE_LABELS), 'dry'),
    full(profile.grain) && slider({ path: 'grain', label: 'Grain', min: 0, max: 1, step: 0.01 }, 'behaviour.grain'),
    engine === 'wet' && engineOk && !isTool && choice('behaviour.wet.medium', 'Medium', options(WET_MEDIA, WET_MEDIUM_LABELS), 'watercolor'),
    engine === 'impasto' && engineOk && choice('behaviour.thick.applicator', 'Tool', options(IMPASTO_TOOLS, APPLICATOR_LABELS), 'brush'),
    ...engineSliders.map((c) => (exchangeOk(facetOf(c.path)) ? slider(c) : null)),
    engineOk && engineControls?.mixingPath && (engine === 'wet' || exchangeFull) && fieldOf('behaviour.mixing') && choice('behaviour.mixing', 'Mixing', options(['pigment', 'rgb'], { pigment: 'Pigment', rgb: 'RGB' })),
    engineOk && engineControls?.dirty && exchangeFull && fieldOf('behaviour.exchange.dirty') && toggle('behaviour.exchange.dirty', 'Dirty brush'),
    engine === 'mixer' && engineOk && full(profile.reservoir) && toggle('behaviour.exchange.reservoir.refill', 'Load each stroke'),
  ]);

  if (!isTool && full(profile.light) && engineOk && engineControls?.light) {
    add('light', 'Light', [
      slider({ path: 'light.amount', label: 'Light', min: 0, max: 1, step: 0.01 }),
      toggle('light.pressure', 'Light follows pressure'),
      ...(engine === 'impasto' ? [slider({ path: 'impasto.rim', label: 'Rim', min: 0, max: 1, step: 0.01 }), slider({ path: 'impasto.clarity', label: 'Clarity', min: 0, max: 1, step: 0.01 })] : []),
      withNote({ kind: 'slider', path: 'light.spill.radius', label: 'Spill', ariaLabel: 'Brush light spill', min: 0, max: 128, step: 1, value: brush.light?.spill?.radius ?? 24 }),
      toggle('light.glow', 'Suggest a glow'),
      withNote({ kind: 'slider', path: 'fluorescence.amount', label: 'UV fluorescence', ariaLabel: 'Brush fluorescence amount', min: 0, max: 1, step: 0.01, value: brush.fluorescence?.amount ?? 0 }),
      toggle('fluorescence.invisible', 'Invisible in daylight'),
      withNote({ kind: 'colour', path: 'thermochromic.hotColor', label: 'Hot colour', ariaLabel: 'Brush thermochromic hot colour', value: brush.thermochromic?.hotColor ?? null, dark: null, gradient: false }),
      withNote({ kind: 'slider', path: 'thermochromic.threshold', label: 'Heat threshold', ariaLabel: 'Brush thermochromic threshold', min: 0.05, max: 0.95, step: 0.01, value: brush.thermochromic?.threshold ?? 0.5 }),
      full(profile.iridescence ?? 'none') && marks !== 'objects' && withNote({ kind: 'toggle', path: 'iridescence', label: 'Thin-film iridescence', ariaLabel: 'Brush thin-film iridescence', value: Boolean(brush.iridescence) }),
      ...(brush.iridescence && full(profile.iridescence ?? 'none')
        ? [
            slider({ path: 'iridescence.thickness', label: 'Film (nm)', min: 100, max: 1000, step: 5 }),
            slider({ path: 'iridescence.pressureToThickness', label: 'Pressure → film', min: 0, max: 1, step: 0.01 }),
            slider({ path: 'iridescence.ior', label: 'Film IOR', min: 1.2, max: 2, step: 0.01 }),
          ]
        : []),
    ]);
  }

  if (full(profile.motion) && engineOk && marks === 'particles') add('motion', 'Motion', [slider({ path: 'particle.waveSpeed', label: 'Wave speed', min: 0, max: 1, step: 0.01 })]);

  if (!isTool) {
    const own = brush.colour?.default;
    const hex = (c: unknown) => (typeof c === 'string' ? (brushColourHex(c, 'light') ?? null) : null);
    const pair = isDualColor(own) ? own : null;
    add('colour', 'Colour', [
      !refused.has('colour.default') && withNote({ kind: 'colour', path: 'colour.default', label: 'Default colour', ariaLabel: 'Brush default colour', value: pair ? (brushColourHex(pair, 'light') ?? null) : hex(own), dark: pair ? (brushColourHex(pair, 'dark') ?? null) : null, gradient: own !== undefined && typeof own === 'object' && !pair }),
      withNote({
        kind: 'palette',
        path: 'colour.palette',
        label: 'Palette',
        ariaLabel: 'Brush palette',
        value: (brush.colour?.palette ?? []).flatMap((c): Array<string | { light: string; dark: string }> => (isDualColor(c) ? [{ light: brushColourHex(c, 'light')!, dark: brushColourHex(c, 'dark')! }] : hex(c) ? [hex(c)!] : [])),
        max: MAX_BRUSH_PALETTE,
      }),
      toggle('colour.own', 'Always its own colour'),
    ]);
  }
  return sections;
}

/** What a brush has that the host can't use: one facet, in words. */
export interface BrushEditorHiddenFacet {
  facet: string;
  /** In words, for a sentence: `light`, `wet behaviour`, `a bristle tip`. */
  label: string;
}

export interface BrushEditorScope {
  /** Facets the brush has that the host can't use (refused or painted without): they get no control and an edit keeps them. */
  hidden: BrushEditorHiddenFacet[];
  /** A short note naming them ("Also has light and wet behaviour, which Canvas can't use."), or `null`. */
  note: string | null;
}

const MARKS_WORDS: Readonly<Record<string, string>> = { particles: 'particle marks', objects: 'sticker marks', continuous: 'continuous marks' };

function hiddenLabel(issue: BrushIssue, b: Brush): string | null {
  switch (issue.facet) {
    case 'kind':
    case 'tool':
      return b.kind === 'tool' ? `the ${(TOOL_LABELS[b.tool!] ?? b.tool ?? 'tool').toLowerCase()} tool` : 'its marks';
    case 'tip.shape':
      return `a ${b.tip.shape} tip`;
    case 'marks':
      return MARKS_WORDS[b.marks?.kind ?? 'continuous'] ?? 'its marks';
    case 'behaviour.surface':
      return `${b.behaviour?.surface ?? 'dry'} behaviour`;
    case 'behaviour.exchange.reservoir':
      return 'a Mixer Brush reservoir';
    case 'behaviour.exchange':
      return 'paint pick-up';
    case 'behaviour.grain':
      return 'paper grain';
    case 'tip.grain':
      return 'tip grain';
    case 'dynamics.count':
      return 'several dabs per step';
    case 'light':
      return 'light';
    case 'fluorescence':
      return 'UV-fluorescent ink';
    case 'thermochromic':
      return 'thermochromic ink';
    case 'iridescence':
      return 'iridescence';
    case 'ghost':
      return 'ghost paint';
    case 'mutation':
      return 'mutation paint';
    case 'motion':
      return 'motion';
    case 'dynamics.velocity':
      return 'velocity dynamics';
    case 'dynamics.tilt':
      return 'tilt dynamics';
    case 'colour.default':
      return `a ${brushColourKind(b.colour!.default!)} default colour`;
    default:
      // Palette colours the host skips keep their control (with a note); sticker refs are checked elsewhere.
      return null;
  }
}

const sentence = (words: readonly string[]) => (words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

/**
 * What the editor leaves out of a brush for this host: the facets the host refuses or paints
 * without, which `brushEditorSections` gives no control, so saving an edit keeps them unchanged
 * for the hosts that use them. `note` names them for the editor to show.
 */
export function brushEditorScope(brush: Brush, profile: BrushHostProfile = PAINT_PROFILE): BrushEditorScope {
  const hidden: BrushEditorHiddenFacet[] = [];
  for (const issue of checkBrush(brush, profile).issues) {
    const label = hiddenLabel(issue, brush);
    if (label && !hidden.some((h) => h.label === label)) hidden.push({ facet: issue.facet, label });
  }
  return { hidden, note: hidden.length ? `Also has ${sentence(hidden.map((h) => h.label))}, which ${profile.name} can't use.` : null };
}

/** A brush id from a name: lowercase letters, digits and dashes (`'brush'` when nothing is left). */
export function brushIdFromName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'brush'
  );
}

/**
 * A new brush for a host to start editing: `from` (the brush in use) with every facet the host
 * can't use removed (`degrade` with `ignored`), else a plain round brush. It passes `checkBrush`
 * for that host, and the editor then offers only what the host uses, so it stays that way.
 */
export function newBrushFor(profile: BrushHostProfile, from?: Brush | null, name = 'New brush'): Brush {
  const id = brushIdFromName(name);
  const base: Brush = { id, name, kind: profile.kinds.includes('mark') ? 'mark' : profile.kinds[0]!, ...(profile.kinds.includes('mark') ? {} : { tool: profile.tools[0] }), tip: { shape: profile.tipShapes.includes('round') ? 'round' : profile.tipShapes[0]! } };
  if (from) {
    const stripped = degrade(from, profile, { ignored: true });
    if (!stripped.issues.length) return { ...stripped.brush, id, name };
  }
  return base;
}

export interface SaveBrushEditOptions {
  /** The brush as it was before editing (`null`: a new brush). Facets of it the host can't use are kept. */
  original: Brush | null;
  /** The edited brush. */
  brush: Brush;
  /** The host the edit was made in. */
  profile: BrushHostProfile;
  /**
   * Save as a new brush with this name (its id made from the name, `-2`… when taken). Without
   * it the original is changed in place, or a copy is saved when it is built in or new.
   */
  name?: string;
}

/** What `saveBrushEdit` stored, plus the facets kept for other hosts. */
export interface SaveBrushEditResult extends SaveBrushResult {
  /** Facets this host can't use that the brush keeps (see `checkBrushEdit`). */
  kept: BrushIssue[];
}

/**
 * Saves a brush edited in a host's editor to the shared library, by the rule the library tools
 * follow too: the edit may not add what the host can't use (a new brush must pass `checkBrush`),
 * and what the original had for other hosts is kept. Built-in presets are never changed: the
 * edit is saved as a copy (`<name> copy`). Refusals are `BrushLibraryError`s with the facet and fix.
 */
export async function saveBrushEdit(library: Pick<BrushLibrary, 'get' | 'save' | 'isBuiltin'>, options: SaveBrushEditOptions): Promise<SaveBrushEditResult> {
  const { original, profile } = options;
  const check = checkBrushEdit(original, options.brush, profile);
  if (!check.ok) {
    const errors = check.issues.filter((i) => i.severity === 'error').map((i) => `${i.facet}: ${i.reason} ${i.fix}`);
    throw new BrushLibraryError('invalid', `${profile.name} can't use this brush: ${errors.join(' ')} Nothing was saved.`);
  }
  const inPlace = !!original && options.name === undefined && !library.isBuiltin(original.id) && original.id === options.brush.id && !!(await library.get(original.id));
  let brush = options.brush;
  if (!inPlace) {
    const name = ((options.name ?? (original ? `${original.name} copy` : brush.name)).trim() || 'Brush').slice(0, 80);
    const stem = brushIdFromName(name).slice(0, 56);
    let id = stem;
    for (let n = 2; library.isBuiltin(id) || (await library.get(id)); n++) id = `${stem}-${n}`;
    brush = { ...brush, id, name };
  }
  const saved = await library.save(brush, { overwrite: inPlace });
  return { ...saved, kept: check.kept };
}

/**
 * The brush with one control's value set (`undefined` removes it), normalised. Changing the kind,
 * the marks or the tip shape starts that facet afresh. Returns the brush and what was clamped or
 * dropped; an invalid change returns the brush unchanged with the reason.
 */
export function setBrushEditorValue(brush: Brush, path: string, value: unknown): { brush: Brush; problems: string[] } {
  const next = JSON.parse(JSON.stringify(brush)) as Brush & Record<string, unknown>;
  if (path === 'kind') {
    if (value === 'tool') {
      delete next.medium;
      delete next.variety;
      delete next.marks;
      delete next.light;
      delete next.fluorescence;
      delete next.thermochromic;
      delete next.iridescence;
      delete next.ghost;
      delete next.mutation;
      delete next.colour;
      next.tool = next.tool ?? 'eraser';
      if (next.tip.shape === 'stamp') next.tip = { shape: 'round', ...(next.tip.size !== undefined ? { size: next.tip.size } : {}) };
    } else delete next.tool;
    next.kind = value as Brush['kind'];
  } else if (path === 'marks.kind') {
    next.marks = value === 'continuous' ? undefined : ({ kind: value } as Brush['marks']);
    if (value !== 'continuous' && next.tip.shape === 'bristle') next.tip = { ...next.tip, shape: 'round', bristle: undefined };
    if (value === 'objects') next.tip = { ...next.tip, shape: 'stamp' };
  } else if (path === 'iridescence') {
    if (value) next.iridescence = next.iridescence ?? { thickness: 400 };
    else delete next.iridescence;
  } else if (path === 'tip.grain.source' && (value === undefined || value === '')) {
    delete next.tip.grain;
  } else if (path === 'tip.shape' && value !== 'stamp') {
    next.tip = { ...next.tip, shape: value as Brush['tip']['shape'], stamps: undefined };
    if (value !== 'bristle') delete next.tip.bristle;
  } else if (value === undefined || value === '') {
    const keys = path.split('.');
    const parent = getPath(next, keys.slice(0, -1).join('.')) as Record<string, unknown> | undefined;
    if (keys.length === 1) delete next[keys[0]];
    else if (parent) delete parent[keys[keys.length - 1]];
  } else setPath(next, path, value);
  const problems: string[] = [];
  try {
    return { brush: normalizeBrushSpec(JSON.parse(JSON.stringify(next)), problems), problems };
  } catch (e) {
    return { brush, problems: [(e as Error).message] };
  }
}

export interface BrushLibraryGroup {
  /** `tools`, or a medium (`paint`, `ink`, `dry`, `spray`), or `other`. */
  id: string;
  title: string;
  /** Brushes by variety (`''`: no variety), in library order. */
  varieties: Array<{ variety: string; title: string; entries: BrushLibraryEntry[] }>;
}

/**
 * A library grouped for a browser: marks by medium, then variety; tools as their own group.
 * `text` keeps brushes whose id, name, variety or tags start with each word; `profile` keeps only
 * what that host renders.
 */
export function brushLibraryGroups(entries: readonly BrushLibraryEntry[], filter: { text?: string; profile?: BrushHostProfile; source?: 'builtin' | 'user' } = {}): BrushLibraryGroup[] {
  const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const wanted = words(filter.text ?? '');
  const groups = new Map<string, BrushLibraryGroup>();
  for (const e of entries) {
    const b = e.brush;
    if (filter.source && (filter.source === 'builtin') !== e.builtin) continue;
    if (wanted.length) {
      const text = words([b.id, b.name, b.variety ?? '', b.medium ?? '', b.tool ?? '', ...(b.tags ?? [])].join(' '));
      if (!wanted.every((w) => text.some((t) => t.startsWith(w)))) continue;
    }
    if (filter.profile && !checkBrush(b, filter.profile).ok) continue;
    const id = b.kind === 'tool' ? 'tools' : (b.medium ?? 'other');
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { id, title: id === 'tools' ? 'Tools' : id === 'other' ? 'Other' : MEDIUM_LABELS[id as BrushMedium], varieties: [] }));
    const variety = b.kind === 'tool' ? '' : (b.variety ?? '');
    let v = g.varieties.find((x) => x.variety === variety);
    if (!v) g.varieties.push((v = { variety, title: variety ? title(variety) : '', entries: [] }));
    v.entries.push(e);
  }
  const order = ['dry', 'ink', 'paint', 'spray', 'other', 'tools'];
  return [...groups.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/**
 * A PNG `data:` URL of an image file a person picked, for `BrushLibrary.addSource`: a PNG is kept
 * as it is; any other image (JPEG, WebP…) is drawn through the browser's `createImageBitmap` and
 * `OffscreenCanvas`. Rejects, naming PNG, where there is no browser to draw it.
 */
export async function imageFileToPngDataUrl(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isPng(bytes)) return `data:image/png;base64,${bytesToBase64(bytes)}`;
  const g = globalThis as { createImageBitmap?: (b: Blob) => Promise<ImageBitmap>; OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvas };
  if (!g.createImageBitmap || !g.OffscreenCanvas) throw new BrushSourceError('Only PNG images can be read here; convert the image to PNG.');
  const bitmap = await g.createImageBitmap(file);
  const canvas = new g.OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  return `data:image/png;base64,${bytesToBase64(png)}`;
}

/**
 * Adds an image file to the library as a source (named after the file unless `name` is given),
 * as the brush editor's "Add image" does. Returns the stored source, its `source:<id>` ref and what
 * reading it changed.
 */
export async function addBrushSourceFromFile(library: Pick<BrushLibrary, 'addSource'>, file: Blob & { name?: string }, options: { name?: string; channel?: BrushSourceChannel } = {}): Promise<AddBrushSourceResult & { ref: string }> {
  const name = (options.name ?? file.name?.replace(/\.[a-z0-9]+$/i, '') ?? 'Image').trim() || 'Image';
  const result = await library.addSource({ name, image: await imageFileToPngDataUrl(file), origin: file.name, ...(options.channel ? { channel: options.channel } : {}) });
  return { ...result, ref: brushSourceRef(result.source.id) };
}

/**
 * The brush with an image source as its tip (`as: 'tip'`: a stamp tip laying it) or as its grain
 * (`as: 'grain'`), normalised, as `setBrushEditorValue` returns it.
 */
export function withBrushSource(brush: Brush, ref: string, as: 'tip' | 'grain'): { brush: Brush; problems: string[] } {
  if (as === 'grain') return setBrushEditorValue(brush, 'tip.grain.source', ref);
  const stamp = brush.tip.shape === 'stamp' ? { brush, problems: [] as string[] } : setBrushEditorValue(brush, 'tip.shape', 'stamp');
  const r = setBrushEditorValue(stamp.brush, 'tip.stamps', [ref]);
  return { brush: r.brush, problems: [...stamp.problems, ...r.problems] };
}
