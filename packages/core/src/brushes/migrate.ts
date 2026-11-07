/**
 * Version 1 brushes (`PaintBrush`, the flat engine form) to facet brushes. Files, documents and
 * recorded strokes written before the facet model still load: each v1 brush becomes the sparse
 * facet brush that resolves back to it.
 *
 * What the engine reads survives exactly. Settings of engine blocks the brush's engine never
 * reads (a dab brush's mixer settings) are dropped, and the category is derived again
 * (`resolveCategory`), so a v1 brush filed under a category its settings do not match moves.
 */

import { normalizePaintBrush, type PaintBrushInput } from '../paint-editor/brushes';
import { BRUSH_FIELDS, getPath, resolveBrush, setPath, WET_TOOL_OF } from './resolve';
import type { Brush, BrushMedium, BrushTipShape, BrushTool, ResolvedBrush } from './types';

const equal = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const copy = <T>(v: T): T => (v !== null && typeof v === 'object' ? (JSON.parse(JSON.stringify(v)) as T) : v);

/** What a v1 category says about a dab brush's medium and variety. */
const CATEGORY_MEDIUM: Readonly<Record<string, [BrushMedium, string?]>> = {
  pencil: ['dry', 'pencil'],
  pastel: ['dry', 'pastel'],
  charcoal: ['dry', 'charcoal'],
  airbrush: ['spray', 'airbrush'],
  marker: ['ink', 'marker'],
  ink: ['ink'],
  paint: ['paint'],
};

function tipShape(b: ResolvedBrush): BrushTipShape {
  if (b.engine === 'bristle') return 'bristle';
  if (b.engine === 'sticker' || (b.engine === 'particle' && b.particle.dotTextures.length > 0) || (b.engine === 'dab' && b.stamp)) return 'stamp';
  if (b.tip.roundness >= 1) return 'round';
  return Math.abs(Math.abs(b.tip.angle % 180) - 45) < 1e-9 || Math.abs(Math.abs(b.tip.angle % 180) - 135) < 1e-9 ? 'chisel' : 'flat';
}

/** The facet brush's identity and the facets that pick its engine, with nothing else set. */
function skeleton(b: ResolvedBrush): Brush {
  const irid = b.iridescence ? { iridescence: {} } : {};
  const brush: Brush = { id: b.id, name: b.name, kind: 'mark', tip: { shape: tipShape(b) }, ...irid };
  if (b.engine === 'eraser' || b.engine === 'blender' || b.engine === 'smudge') return { id: b.id, name: b.name, kind: 'tool', tool: b.engine, tip: { shape: tipShape(b) } };
  if (b.engine === 'wet' && b.wet.tool !== 'paint') {
    const tool = (Object.keys(WET_TOOL_OF) as BrushTool[]).find((t) => WET_TOOL_OF[t] === b.wet.tool)!;
    return { id: b.id, name: b.name, kind: 'tool', tool, tip: { shape: tipShape(b) } };
  }
  const mut = b.mutation ? { mutation: {} } : {};
  switch (b.engine) {
    case 'wet':
      return { ...brush, medium: 'paint', variety: b.wet.medium, behaviour: { surface: 'wet' }, ...(b.ghost && !b.mutation ? { ghost: {} } : {}), ...mut };
    case 'impasto':
      return { ...brush, medium: 'paint', behaviour: { surface: 'thick' }, ...mut };
    case 'mixer':
      return { ...brush, medium: 'paint', variety: 'mixer', behaviour: { exchange: { reservoir: {} } }, ...mut };
    case 'bristle':
      return { ...brush, medium: 'paint', ...mut };
    case 'particle':
      return { ...brush, marks: { kind: 'particles' }, ...mut };
    case 'sticker':
      return { id: b.id, name: b.name, kind: 'mark', tip: { shape: tipShape(b) }, marks: { kind: 'objects' }, ...mut };
    default: {
      const [medium, variety] = CATEGORY_MEDIUM[b.category] ?? [];
      return { ...brush, ...(medium ? { medium } : {}), ...(variety ? { variety } : {}), ...(b.engine === 'dab' && b.spray ? { marks: { kind: 'scatter' } } : {}), ...mut };
    }
  }
}

/** Key order of a hand-written brush. */
const ORDER = ['id', 'name', 'description', 'tags', 'kind', 'medium', 'variety', 'tool', 'tip', 'marks', 'dynamics', 'behaviour', 'light', 'iridescence', 'ghost', 'mutation', 'motion', 'colour'];

/**
 * The facet brush a v1 brush (any `PaintBrush`, or the JSON of one) amounts to: its engine's
 * settings, stored only where they differ from that engine's defaults.
 * `resolveBrush(migrateBrushV1(b))` paints exactly as `b` does.
 */
export function migrateBrushV1(raw: PaintBrushInput): Brush {
  const b = normalizePaintBrush(raw);
  const brush = skeleton(b) as unknown as Record<string, unknown>;
  const defaults = resolveBrush(brush as unknown as Brush);
  for (const field of BRUSH_FIELDS) {
    if (!field.engines.includes(b.engine) || (field.shapes && !field.shapes.includes((brush.tip as Brush['tip']).shape)) || (field.marks && !field.marks.includes((brush.marks as Brush['marks'])?.kind ?? 'continuous'))) continue;
    const v = getPath(b, field.engine);
    if (!equal(v, getPath(defaults, field.engine))) setPath(brush, field.facet, field.map ? field.map.toFacet(v) : copy(v));
  }
  if (b.paint) setPath(brush, 'colour.default', copy(b.paint));
  return Object.fromEntries(ORDER.filter((k) => brush[k] !== undefined).map((k) => [k, brush[k]])) as unknown as Brush;
}
