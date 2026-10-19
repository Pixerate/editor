/**
 * The layer effects section's view model, shared by the React and Svelte panels: whether a layer
 * can take effects, its effect rows, the menu of kinds to add, and per effect a flat list of
 * controls (sliders, colours, toggles, choices) with how a change maps to `updateLayerEffect`.
 */

import { BLEND_MODES } from '../blend';
import {
  defaultEffectGradient,
  hasActiveEffects,
  layerEffectLabel,
  LAYER_EFFECT_KINDS,
  type EffectFill,
  type LayerEffect,
  type LayerEffectKind,
} from '../../raster/effects/model';
import { builtinPattern, builtinPatternIds, type EffectPattern } from '../../raster/effects/patterns';
import type { ImageLayer } from './model';

export interface LayerEffectRow {
  id: string;
  kind: LayerEffectKind;
  label: string;
  enabled: boolean;
}

export interface LayerEffectsPanelModel {
  /** Whether the layer can carry effects (adjustment layers cannot; a fully locked layer refuses changes). */
  available: boolean;
  /** Why not, when unavailable or read-only. */
  reason?: string;
  readOnly: boolean;
  enabled: boolean;
  /** Scale Effects, 1 = 100 %. */
  scale: number;
  rows: LayerEffectRow[];
}

/** The effects section for `layer`. */
export function layerEffectsPanel(layer: ImageLayer | null | undefined): LayerEffectsPanelModel {
  const empty = { readOnly: true, enabled: true, scale: 1, rows: [] };
  if (!layer) return { ...empty, available: false, reason: 'Select a layer to add effects.' };
  if (layer.type === 'adjustment') return { ...empty, available: false, reason: 'Adjustment layers cannot have effects.' };
  const fx = layer.effects;
  const readOnly = Boolean(layer.locks?.all);
  return {
    available: true,
    readOnly,
    reason: readOnly ? 'The layer is locked; unlock it to change its effects.' : undefined,
    enabled: fx?.enabled ?? true,
    scale: fx?.scale ?? 1,
    rows: (fx?.items ?? []).map((e) => ({ id: e.id, kind: e.kind, label: layerEffectLabel(e.kind), enabled: e.enabled })),
  };
}

/** The fx badge of a layer row: `on` (effects render), `off` (effects but switched off), or `null`. */
export function layerEffectsBadge(layer: ImageLayer): 'on' | 'off' | null {
  if (!layer.effects?.items.length) return null;
  return hasActiveEffects(layer.effects) ? 'on' : 'off';
}

/** The kinds the "Add effect" menu offers, in the Layer Style dialog's order. */
export const LAYER_EFFECT_MENU: ReadonlyArray<{ kind: LayerEffectKind; label: string }> = LAYER_EFFECT_KINDS.map((kind) => ({ kind, label: layerEffectLabel(kind) }));

export type EffectControl =
  | { key: string; label: string; type: 'range'; min: number; max: number; step: number; value: number; /** Shown and edited as percent (value × 100). */ percent?: boolean; unit?: string }
  | { key: string; label: string; type: 'color'; value: string }
  | { key: string; label: string; type: 'checkbox'; value: boolean }
  | { key: string; label: string; type: 'select'; value: string; options: Array<{ value: string; label: string }> };

const BLENDS = BLEND_MODES.filter((m) => m.id !== 'pigment').map((m) => ({ value: m.id as string, label: m.label }));
const opt = (...pairs: Array<[string, string]>) => pairs.map(([value, label]) => ({ value, label }));

function patternOptions(patterns: readonly EffectPattern[]): Array<{ value: string; label: string }> {
  return [...patterns.map((p) => ({ value: p.id, label: p.name || p.id })), ...builtinPatternIds().map((id) => ({ value: id, label: builtinPattern(id)!.name }))];
}

type Rec = Record<string, unknown>;

/** Reads a dotted path (`fill.color`, `gradient.stops.last.color`). */
function getPath(o: unknown, path: string): unknown {
  let v: unknown = o;
  for (const p of path.split('.')) {
    if (v === null || v === undefined) return undefined;
    if (Array.isArray(v)) v = p === 'last' ? v[v.length - 1] : v[Number(p)];
    else v = (v as Rec)[p];
  }
  return v;
}

/** A copy of `o` with `path` set to `value` (arrays and objects copied along the path). */
function setPath(o: unknown, parts: string[], value: unknown): unknown {
  if (!parts.length) return value;
  const [p, ...rest] = parts;
  if (Array.isArray(o)) {
    const i = p === 'last' ? o.length - 1 : Number(p);
    const out = [...o];
    out[i] = setPath(o[i], rest, value);
    return out;
  }
  const r = (o ?? {}) as Rec;
  return { ...r, [p]: setPath(r[p], rest, value) };
}

function fillControls(f: EffectFill, allowPattern: boolean, patterns: readonly EffectPattern[]): EffectControl[] {
  const types = allowPattern ? opt(['color', 'Color'], ['gradient', 'Gradient'], ['pattern', 'Pattern']) : opt(['color', 'Color'], ['gradient', 'Gradient']);
  const out: EffectControl[] = [{ key: 'fill.type', label: 'Fill', type: 'select', value: f.type, options: types }];
  if (f.type === 'color') out.push({ key: 'fill.color', label: 'Color', type: 'color', value: f.color });
  else if (f.type === 'gradient') out.push(...gradientControls('fill.gradient', f.gradient));
  else {
    out.push(
      { key: 'fill.patternId', label: 'Pattern', type: 'select', value: f.patternId, options: patternOptions(patterns) },
      { key: 'fill.scale', label: 'Scale', type: 'range', min: 0.01, max: 10, step: 0.01, value: f.scale, percent: true, unit: '%' }
    );
  }
  return out;
}

function gradientControls(prefix: string, g: { stops: Array<{ color: string }>; style: string; angle: number; scale: number; reverse: boolean; align: boolean }): EffectControl[] {
  return [
    { key: `${prefix}.stops.0.color`, label: 'Start colour', type: 'color', value: g.stops[0]?.color ?? '#000000' },
    { key: `${prefix}.stops.last.color`, label: 'End colour', type: 'color', value: g.stops[g.stops.length - 1]?.color ?? '#ffffff' },
    { key: `${prefix}.style`, label: 'Style', type: 'select', value: g.style, options: opt(['linear', 'Linear'], ['radial', 'Radial'], ['angle', 'Angle'], ['reflected', 'Reflected'], ['diamond', 'Diamond']) },
    { key: `${prefix}.angle`, label: 'Angle', type: 'range', min: -180, max: 180, step: 1, value: g.angle, unit: '°' },
    { key: `${prefix}.scale`, label: 'Scale', type: 'range', min: 0.1, max: 1.5, step: 0.01, value: g.scale, percent: true, unit: '%' },
    { key: `${prefix}.reverse`, label: 'Reverse', type: 'checkbox', value: g.reverse },
    { key: `${prefix}.align`, label: 'Align with layer', type: 'checkbox', value: g.align },
  ];
}

const px = (key: string, label: string, value: number, max = 250): EffectControl => ({ key, label, type: 'range', min: 0, max, step: 1, value, unit: 'px' });
const pct = (key: string, label: string, value: number, min = 0, max = 1): EffectControl => ({ key, label, type: 'range', min, max, step: 0.01, value, percent: true, unit: '%' });
const deg = (key: string, label: string, value: number, min = -180, max = 180): EffectControl => ({ key, label, type: 'range', min, max, step: 1, value, unit: '°' });

/**
 * The controls for one effect, in the Layer Style dialog's order. `patterns` are the document's
 * patterns (the built-in ones are always offered).
 */
export function layerEffectControls(e: LayerEffect, patterns: readonly EffectPattern[] = []): EffectControl[] {
  const blended: EffectControl[] =
    e.kind === 'bevel-emboss'
      ? []
      : [
          { key: 'blend', label: 'Blend mode', type: 'select', value: e.blend, options: BLENDS },
          pct('opacity', 'Opacity', e.opacity),
        ];
  switch (e.kind) {
    case 'drop-shadow':
    case 'inner-shadow':
      return [
        ...blended,
        { key: 'color', label: 'Color', type: 'color', value: e.color },
        { key: 'useGlobalLight', label: 'Use global light', type: 'checkbox', value: e.useGlobalLight },
        deg('angle', 'Angle', e.angle),
        px('distance', 'Distance', e.distance, 500),
        e.kind === 'drop-shadow' ? pct('spread', 'Spread', e.spread) : pct('choke', 'Choke', e.choke),
        px('size', 'Size', e.size),
        pct('noise', 'Noise', e.noise),
        ...(e.kind === 'drop-shadow' ? [{ key: 'knocksOut', label: 'Layer knocks out shadow', type: 'checkbox', value: e.knocksOut } as EffectControl] : []),
      ];
    case 'outer-glow':
    case 'inner-glow':
      return [
        ...blended,
        ...fillControls(e.fill, false, patterns),
        { key: 'technique', label: 'Technique', type: 'select', value: e.technique, options: opt(['softer', 'Softer'], ['precise', 'Precise']) },
        ...(e.kind === 'inner-glow' ? [{ key: 'source', label: 'Source', type: 'select', value: e.source, options: opt(['edge', 'Edge'], ['center', 'Center']) } as EffectControl] : []),
        e.kind === 'outer-glow' ? pct('spread', 'Spread', e.spread) : pct('choke', 'Choke', e.choke),
        px('size', 'Size', e.size),
        pct('range', 'Range', e.range, 0.01, 1),
        pct('noise', 'Noise', e.noise),
      ];
    case 'bevel-emboss':
      return [
        { key: 'style', label: 'Style', type: 'select', value: e.style, options: opt(['inner-bevel', 'Inner Bevel'], ['outer-bevel', 'Outer Bevel'], ['emboss', 'Emboss'], ['pillow-emboss', 'Pillow Emboss'], ['stroke-emboss', 'Stroke Emboss']) },
        { key: 'technique', label: 'Technique', type: 'select', value: e.technique, options: opt(['smooth', 'Smooth'], ['chisel-hard', 'Chisel Hard'], ['chisel-soft', 'Chisel Soft']) },
        pct('depth', 'Depth', e.depth, 0, 10),
        { key: 'direction', label: 'Direction', type: 'select', value: e.direction, options: opt(['up', 'Up'], ['down', 'Down']) },
        px('size', 'Size', e.size),
        px('soften', 'Soften', e.soften, 16),
        { key: 'useGlobalLight', label: 'Use global light', type: 'checkbox', value: e.useGlobalLight },
        deg('angle', 'Angle', e.angle),
        deg('altitude', 'Altitude', e.altitude, 0, 90),
        { key: 'highlightColor', label: 'Highlight', type: 'color', value: e.highlightColor },
        { key: 'highlightBlend', label: 'Highlight mode', type: 'select', value: e.highlightBlend, options: BLENDS },
        pct('highlightOpacity', 'Highlight opacity', e.highlightOpacity),
        { key: 'shadowColor', label: 'Shadow', type: 'color', value: e.shadowColor },
        { key: 'shadowBlend', label: 'Shadow mode', type: 'select', value: e.shadowBlend, options: BLENDS },
        pct('shadowOpacity', 'Shadow opacity', e.shadowOpacity),
      ];
    case 'satin':
      return [
        ...blended,
        { key: 'color', label: 'Color', type: 'color', value: e.color },
        deg('angle', 'Angle', e.angle),
        px('distance', 'Distance', e.distance),
        px('size', 'Size', e.size),
        { key: 'invert', label: 'Invert', type: 'checkbox', value: e.invert },
      ];
    case 'color-overlay':
      return [...blended, { key: 'color', label: 'Color', type: 'color', value: e.color }];
    case 'gradient-overlay':
      return [...blended, ...gradientControls('gradient', e.gradient)];
    case 'pattern-overlay':
      return [
        ...blended,
        { key: 'patternId', label: 'Pattern', type: 'select', value: e.patternId, options: patternOptions(patterns) },
        pct('scale', 'Scale', e.scale, 0.01, 10),
        deg('angle', 'Angle', e.angle ?? 0),
        { key: 'link', label: 'Link with layer', type: 'checkbox', value: e.link ?? true },
      ];
    case 'stroke':
      return [
        ...blended,
        px('size', 'Size', e.size),
        { key: 'position', label: 'Position', type: 'select', value: e.position, options: opt(['outside', 'Outside'], ['inside', 'Inside'], ['center', 'Center']) },
        ...fillControls(e.fill, true, patterns),
      ];
  }
}

/** A new fill of `type`, keeping the colour where it can. */
function fillOfType(current: EffectFill, type: string, patterns: readonly EffectPattern[]): EffectFill {
  if (type === 'gradient') return { type: 'gradient', gradient: defaultEffectGradient() };
  if (type === 'pattern') return { type: 'pattern', patternId: patterns[0]?.id ?? 'checker', scale: 1 };
  return { type: 'color', color: current.type === 'color' ? current.color : '#000000' };
}

/**
 * The `updateLayerEffect` settings for setting control `key` of `effect` to `value` (a nested
 * object such as `fill` or `gradient` is replaced whole, with the one field changed). Values are
 * in the effect's own units (fractions for percent controls).
 */
export function effectControlChange(effect: LayerEffect, key: string, value: unknown, patterns: readonly EffectPattern[] = []): Record<string, unknown> {
  const [top, ...rest] = key.split('.');
  if (top === 'fill' && rest[0] === 'type') return { fill: fillOfType((effect as { fill: EffectFill }).fill, String(value), patterns) };
  if (top === 'patternId' && !rest.length) {
    const name = patternOptions(patterns).find((o) => o.value === value)?.label;
    return name ? { patternId: value, name } : { patternId: value };
  }
  if (!rest.length) return { [top]: value };
  // A pattern name follows its id.
  if (top === 'fill' && rest[0] === 'patternId') {
    const name = patternOptions(patterns).find((o) => o.value === value)?.label;
    return { fill: { ...(effect as { fill: Rec }).fill, patternId: value, ...(name ? { name } : {}) } };
  }
  return { [top]: setPath(getPath(effect, top), rest, value) };
}
