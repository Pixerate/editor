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
import type { BrushLibraryEntry } from './library';
import { normalizeBrushSpec } from './normalize';
import { checkBrush, PAINT_PROFILE, type BrushHostProfile } from './profiles';
import { BRUSH_FIELDS, getPath, resolveBrush, resolveEngine, setPath } from './resolve';
import { MAX_BRUSH_PALETTE } from './schema';
import { BRUSH_MEDIA, type Brush, type BrushMedium, type BrushTool } from './types';

export type BrushEditorSectionId = 'medium' | 'shape' | 'marks' | 'feel' | 'behaviour' | 'light' | 'motion' | 'colour';

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
  /** A solid colour (#rrggbb), or `null` when there is none (or the default is a gradient or effect). */
  | (ControlBase & { kind: 'colour'; value: string | null })
  | (ControlBase & { kind: 'palette'; value: string[]; max: number })
  /** Stamp refs (`editor:star`…): `options` are the editor's stamps; hosts may offer more refs. */
  | (ControlBase & { kind: 'stamps'; value: string[]; max: number; options: ReadonlyArray<{ value: string; label: string }> });

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
};
const aria = (path: string, label: string) => ARIA[path] ?? `Brush ${label.toLowerCase()}`;

/**
 * Sections of controls for a brush, in order, as the host `profile` (default the paint editor)
 * can render them: sections and controls it refuses are left out, ones it paints without carry
 * a note. Values are the brush's own, else the defaults of the engine it resolves to.
 */
export function brushEditorSections(brush: Brush, profile: BrushHostProfile = PAINT_PROFILE): BrushEditorSection[] {
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
  const warned = new Map(checkBrush(brush, profile).issues.filter((i) => i.severity === 'warning').map((i) => [i.facet, i.reason]));
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
  const marks = brush.marks?.kind ?? 'continuous';

  add('medium', 'Medium', [
    profile.kinds.length > 1 && choice('kind', 'Kind', options(profile.kinds, { mark: 'Lays a material', tool: 'Works on paint' })),
    !isTool && choice('medium', 'Medium', [{ value: '', label: 'Any' }, ...options(BRUSH_MEDIA, MEDIUM_LABELS)], ''),
    !isTool && withNote({ kind: 'text', path: 'variety', label: 'Variety', ariaLabel: 'Brush variety', value: brush.variety ?? '', placeholder: 'pencil, oil, highlighter…' }),
    isTool && profile.tools.length > 0 && choice('tool', 'Tool', options(profile.tools, TOOL_LABELS)),
  ]);

  const engineControls = brushEngineControls(resolved);
  const tipSliders = BRUSH_SLIDERS.filter((c) => c.path.startsWith('tip.') && c.path !== 'tip.smoothing');
  add('shape', 'Shape', [
    choice('tip.shape', 'Tip', options(profile.tipShapes.filter((s) => !isTool || s !== 'stamp'), SHAPE_LABELS)),
    ...tipSliders.map((c) => slider(c)),
    engine === 'dab' && choice('tip.blend', 'Blend', BLEND_MODES.map((m) => ({ value: m.id, label: m.label })), 'normal'),
    ...(shape === 'bristle' && engineControls ? engineControls.sliders.filter((c) => c.path.startsWith('bristle.')).map((c) => slider(c)) : []),
    shape === 'stamp' && withNote({ kind: 'stamps', path: 'tip.stamps', label: 'Stamps', ariaLabel: 'Brush stamps', value: [...((value('tip.stamps') as string[] | undefined) ?? [])], max: marks === 'particles' ? MAX_DOT_TEXTURES : MAX_STICKER_STAMPS, options: STAMP_OPTIONS }),
  ]);

  if (!isTool && profile.marks.length > 1) {
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

  const feel = BRUSH_SLIDERS.filter((c) => ['tip.smoothing', 'pressureSmoothing', 'dynamics.minSize', 'dynamics.tiltSize', 'dynamics.velocitySize'].includes(c.path)).filter((c) => !(c.path === 'dynamics.tiltSize' && profile.tilt === 'none') && !(c.path === 'dynamics.velocitySize' && profile.velocity === 'none'));
  add('feel', 'Feel', [
    ...feel.map((c) => slider(c)),
    toggle('dynamics.pressureSize', 'Pressure → size'),
    toggle('dynamics.pressureOpacity', 'Pressure → opacity'),
    choice('dynamics.rotation', 'Rotation', options(BRUSH_ROTATIONS, ROTATION_LABELS)),
  ]);

  const surfaces = profile.surfaces;
  const engineSliders = (engineControls?.sliders ?? []).filter((c) => !/^(bristle|particle|sticker)\./.test(c.path) && c.path !== 'light.amount' && c.path !== 'impasto.rim' && c.path !== 'impasto.clarity');
  const exchangeOk = (path: string | undefined) => !path?.startsWith('behaviour.exchange') || (path.startsWith('behaviour.exchange.reservoir') ? profile.reservoir !== 'none' : profile.exchange !== 'none');
  add('behaviour', engineControls?.title ?? 'Behaviour', [
    !isTool && surfaces.length > 1 && choice('behaviour.surface', 'Surface', options(surfaces, SURFACE_LABELS), 'dry'),
    profile.grain !== 'none' && slider({ path: 'grain', label: 'Grain', min: 0, max: 1, step: 0.01 }, 'behaviour.grain'),
    engine === 'wet' && !isTool && choice('behaviour.wet.medium', 'Medium', options(WET_MEDIA, WET_MEDIUM_LABELS), 'watercolor'),
    engine === 'impasto' && choice('behaviour.thick.applicator', 'Tool', options(IMPASTO_TOOLS, APPLICATOR_LABELS), 'brush'),
    ...engineSliders.map((c) => (exchangeOk(facetOf(c.path)) ? slider(c) : null)),
    engineControls?.mixingPath && fieldOf('behaviour.mixing') && choice('behaviour.mixing', 'Mixing', options(['pigment', 'rgb'], { pigment: 'Pigment', rgb: 'RGB' })),
    engineControls?.dirty && profile.exchange !== 'none' && fieldOf('behaviour.exchange.dirty') && toggle('behaviour.exchange.dirty', 'Dirty brush'),
    engine === 'mixer' && toggle('behaviour.exchange.reservoir.refill', 'Load each stroke'),
  ]);

  if (!isTool && profile.light !== 'none' && engineControls?.light) {
    add('light', 'Light', [
      slider({ path: 'light.amount', label: 'Light', min: 0, max: 1, step: 0.01 }),
      toggle('light.pressure', 'Light follows pressure'),
      ...(engine === 'impasto' ? [slider({ path: 'impasto.rim', label: 'Rim', min: 0, max: 1, step: 0.01 }), slider({ path: 'impasto.clarity', label: 'Clarity', min: 0, max: 1, step: 0.01 })] : []),
      withNote({ kind: 'slider', path: 'light.spill.radius', label: 'Spill', ariaLabel: 'Brush light spill', min: 0, max: 128, step: 1, value: brush.light?.spill?.radius ?? 24 }),
      toggle('light.glow', 'Suggest a glow'),
    ]);
  }

  if (profile.motion !== 'none' && marks === 'particles') add('motion', 'Motion', [slider({ path: 'particle.waveSpeed', label: 'Wave speed', min: 0, max: 1, step: 0.01 })]);

  if (!isTool) {
    const own = brush.colour?.default;
    add('colour', 'Colour', [
      withNote({ kind: 'colour', path: 'colour.default', label: 'Default colour', ariaLabel: 'Brush default colour', value: typeof own === 'string' && /^#[0-9a-f]{6}/i.test(own) ? own.slice(0, 7).toLowerCase() : null }),
      withNote({ kind: 'palette', path: 'colour.palette', label: 'Palette', ariaLabel: 'Brush palette', value: (brush.colour?.palette ?? []).filter((c): c is string => typeof c === 'string'), max: MAX_BRUSH_PALETTE }),
      toggle('colour.own', 'Always its own colour'),
    ]);
  }
  return sections;
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
      delete next.colour;
      next.tool = next.tool ?? 'eraser';
      if (next.tip.shape === 'stamp') next.tip = { shape: 'round', ...(next.tip.size !== undefined ? { size: next.tip.size } : {}) };
    } else delete next.tool;
    next.kind = value as Brush['kind'];
  } else if (path === 'marks.kind') {
    next.marks = value === 'continuous' ? undefined : ({ kind: value } as Brush['marks']);
    if (value !== 'continuous' && next.tip.shape === 'bristle') next.tip = { ...next.tip, shape: 'round', bristle: undefined };
    if (value === 'objects') next.tip = { ...next.tip, shape: 'stamp' };
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
