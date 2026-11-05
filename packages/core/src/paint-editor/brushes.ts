/**
 * Paint editor brushes: the shared engine's tip settings (`@pixerate/editor/paint`) plus what a
 * natural-media brush adds: paper grain response, pen dynamics (pressure, tilt, barrel rotation,
 * velocity), separate pressure smoothing, a rotation mode, jitter, and Mixer Brush settings for
 * the blending brushes. The engine brush itself is in `./brush-model`; the built-in library is
 * the facet presets (`@pixerate/editor/brushes`) resolved to it, so a preset is written once.
 */

import { BRUSH_PRESETS } from '../brushes/presets';
import { resolveBrush } from '../brushes/resolve';
import { BRUSH_ID, normalizePaintBrush, type PaintBrush, type PaintBrushInput } from './brush-model';
import { MAX_BRUSH_SIZE } from '../paint/brush';

export * from './brush-model';

/** The built-in brush library: the facet presets (`BRUSH_PRESETS`), resolved, in their order. */
export const BUILTIN_BRUSHES: readonly PaintBrush[] = BRUSH_PRESETS.map((spec) => resolveBrush(spec, { builtin: true }));

export const DEFAULT_BRUSH_ID = 'pencil-6b';

export { MAX_BRUSH_SIZE };

/** A brush as plain JSON (for export, agents and saved libraries): no `builtin` flag. */
export function brushToJSON(brush: PaintBrush): Omit<PaintBrush, 'builtin'> {
  const { builtin: _b, ...rest } = brush;
  return JSON.parse(JSON.stringify(rest));
}

/** The JSON file a brush library exports to and imports from. */
export interface BrushLibraryFile {
  format: 'pixerate-brushes';
  version: 1;
  brushes: Array<Omit<PaintBrush, 'builtin'>>;
}

/**
 * Brushes read from a brush library file (or a bare array of brushes). Each is normalised; ones
 * without a valid id or name are reported in `problems` and skipped.
 */
export function parseBrushLibrary(raw: unknown, problems: string[] = []): PaintBrush[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as BrushLibraryFile).brushes) ? (raw as BrushLibraryFile).brushes : null;
  if (!list) throw new Error('Not a brush library: expected {"format":"pixerate-brushes","version":1,"brushes":[...]} or an array of brushes.');
  const out: PaintBrush[] = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      problems.push(`brushes[${i}] is not an object; skipped.`);
      return;
    }
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || !BRUSH_ID.test(r.id)) {
      problems.push(`brushes[${i}] has no valid id (lowercase letters, digits and dashes); skipped.`);
      return;
    }
    if (typeof r.name !== 'string' || !r.name.trim()) {
      problems.push(`brushes[${i}] ("${r.id}") has no name; skipped.`);
      return;
    }
    const { builtin: _b, ...rest } = r;
    out.push(normalizePaintBrush(rest as PaintBrushInput));
  });
  return out;
}
