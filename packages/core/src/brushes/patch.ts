/**
 * Facet patches: a partial brush laid over another (`mergeBrushPatch`), the schema of one for
 * tools (`BRUSH_PATCH_PROPERTIES`), and the leaf paths two brushes differ in (`changedBrushPaths`).
 * The library tools and the paint editor's `set_brush` / `paint_stroke` share them, so a patch
 * means the same everywhere.
 */

import type { JsonSchema } from '../tools/schema';
import { BRUSH_JSON_SCHEMA } from './schema';
import type { Brush } from './types';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A brush's facets, any of them, as a patch takes them (the tip's `shape` may be left out). */
export type BrushPatch = { [K in Exclude<keyof Brush, 'id'>]?: K extends 'tip' ? Partial<Brush['tip']> : Brush[K] };

const FACETS = BRUSH_JSON_SCHEMA.properties!;

/** The schema of every facet except `id` and `name`, as tool arguments (a patch may leave out `tip.shape`). */
export const BRUSH_PATCH_PROPERTIES: Readonly<Record<string, JsonSchema>> = (() => {
  const { id: _id, name: _name, ...rest } = FACETS as Record<string, JsonSchema>;
  const { required: _r, ...tip } = rest.tip!;
  return { ...rest, tip: { ...tip, description: `${tip.description} In a patch, shape may be left out to keep it.` } };
})();

/** The facets a patch can remove (`unset`), back to the engine's defaults. */
export const UNSETTABLE_BRUSH_FACETS = ['description', 'tags', 'medium', 'variety', 'marks', 'dynamics', 'behaviour', 'light', 'motion', 'livePatterns', 'colour'] as const;
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
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const old = out[k];
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
