/**
 * Facet patches: a partial brush laid over another (`mergeBrushPatch`), the schema of one for
 * tools (`BRUSH_PATCH_PROPERTIES`), and the leaf paths two brushes differ in (`changedBrushPaths`).
 * The library tools and the paint editor's `set_brush` / `paint_stroke` share them, so a patch
 * means the same everywhere.
 */

import type { JsonSchema } from '../tools/schema';
import { BRUSH_FACET_SCHEMAS, BRUSH_JSON_SCHEMA } from './schema';
import type { Brush, BrushFerro } from './types';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A brush's facets, any of them, as a patch takes them (the tip's `shape` may be left out, and `ferro` accepts a `0..1` amount shorthand). */
export type BrushPatch = {
  [K in Exclude<keyof Brush, 'id'>]?: K extends 'tip'
    ? Partial<Brush['tip']>
    : K extends 'ferro'
      ? number | BrushFerro
      : K extends 'culture'
        ? Brush['culture'] | null
        : Brush[K];
};

const FACETS = BRUSH_JSON_SCHEMA.properties!;

/** The schema of every facet except `id` and `name`, as tool arguments (a patch may leave out `tip.shape`). */
export const BRUSH_PATCH_PROPERTIES: Readonly<Record<string, JsonSchema>> = (() => {
  const { id: _id, name: _name, ...rest } = FACETS as Record<string, JsonSchema>;
  const { required: _r, ...tip } = rest.tip!;
  const ferro: JsonSchema = {
    description: 'Liquid ferrofluid paint: 0..1 (amount), or { amount, wavelength, threshold }. Rises into glossy Rosensweig spikes near magnets until cured.',
    anyOf: [
      { type: 'number', minimum: 0, maximum: 1, description: 'How much liquid ferrofluid the brush lays per dab (0..1).' },
      BRUSH_FACET_SCHEMAS.ferro,
    ],
  };
  const culture: JsonSchema = {
    description: `${BRUSH_FACET_SCHEMAS.culture.description ?? 'Biopaint mycelial ink.'} Pass null to remove the culture facet.`,
    anyOf: [
      BRUSH_FACET_SCHEMAS.culture,
      { type: 'null', description: 'Remove the culture facet.' },
    ],
  };
  return { ...rest, tip: { ...tip, description: `${tip.description} In a patch, shape may be left out to keep it.` }, ferro, culture };
})();

/** The facets a patch can remove (`unset`), back to the engine's defaults. */
export const UNSETTABLE_BRUSH_FACETS = ['description', 'tags', 'medium', 'variety', 'marks', 'dynamics', 'behaviour', 'light', 'fluorescence', 'thermochromic', 'iridescence', 'ghost', 'mutation', 'ferro', 'motion', 'livePatterns', 'culture', 'colour'] as const;
export type UnsettableBrushFacet = (typeof UNSETTABLE_BRUSH_FACETS)[number];

/** The `unset` argument of tools that take a patch. */
export const BRUSH_UNSET_PROPERTY: JsonSchema = {
  type: 'array',
  minItems: 1,
  uniqueItems: true,
  items: { type: 'string', enum: [...UNSETTABLE_BRUSH_FACETS], description: 'A facet to remove.' },
  description: 'Facets to remove, back to their defaults (applied before the facets given).',
};

/** `base` with `patch` laid over it: objects merge, everything else (lists included) is replaced. Marks of another kind replace the marks. */
export function mergeBrushPatch<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>, path = ''): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, rawV] of Object.entries(patch)) {
    if (rawV === undefined) continue;
    if (path === '' && k === 'culture' && rawV === null) {
      delete out[k];
      continue;
    }
    const v = path === '' && k === 'ferro' && typeof rawV === 'number' ? { amount: rawV } : rawV;
    const rawOld = out[k];
    const old = path === '' && k === 'ferro' && typeof rawOld === 'number' ? { amount: rawOld } : rawOld;
    const replaceMarks = path === '' && k === 'marks' && isObject(old) && isObject(v) && old.kind !== v.kind;
    out[k] = isObject(v) && isObject(old) && !replaceMarks ? mergeBrushPatch(old, v, `${path}${k}.`) : copy(v);
  }
  return out as T;
}

/** Leaf paths whose values differ between two brushes (dot paths; lists compare whole). */
export function changedBrushPaths(a: unknown, b: unknown, path = ''): string[] {
  if (isObject(a) && isObject(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => changedBrushPaths(a[k], b[k], path ? `${path}.${k}` : k));
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [path];
}
