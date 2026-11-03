/**
 * The paint editor's side of the shared brush library (`@pixerate/editor/brushes`): the
 * controller's synchronous copy of the library (each brush as stored, as facets, and as the
 * engine paints it), and facet brushes for engine brushes edited by their settings.
 */

import type { StorageAdapter } from '../persistence/storage.js';
import { migrateBrushV1 } from '../brushes/migrate';
import { normalizeBrushSpec } from '../brushes/normalize';
import { BRUSH_PRESETS } from '../brushes/presets';
import { resolveBrush } from '../brushes/resolve';
import type { Brush } from '../brushes/types';
import { brushToJSON, BUILTIN_BRUSHES, normalizePaintBrush, type PaintBrush } from './brushes';

/** A library brush as the paint editor keeps it: its facets and the engine form it paints with. */
export interface LibraryBrush {
  spec: Brush;
  brush: PaintBrush;
  builtin: boolean;
}

export const copyJSON = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function libraryBrush(spec: Brush, builtin: boolean, resolved?: PaintBrush): LibraryBrush {
  const brush = resolved ? normalizePaintBrush(resolved, resolved) : resolveBrush(spec);
  if (builtin) brush.builtin = true;
  else delete brush.builtin;
  return { spec, brush, builtin };
}

let builtins: readonly LibraryBrush[] | null = null;

/** The built-in presets, paired with the engine brushes they resolve to (`BUILTIN_BRUSHES`, in the same order). */
export function builtinLibraryBrushes(): readonly LibraryBrush[] {
  return (builtins ??= BRUSH_PRESETS.map((spec) => {
    const resolved = BUILTIN_BRUSHES.find((b) => b.id === spec.id);
    return libraryBrush(spec, true, resolved);
  }));
}

/** Storage that starts with these brushes (a version 1 file) and keeps the rest in memory; none without brushes. */
export function seededStorage(brushes: readonly PaintBrush[]): Pick<StorageAdapter, 'get' | 'set'> | undefined {
  if (!brushes.length) return undefined;
  let stored: string | null = JSON.stringify({ format: 'pixerate-brushes', version: 1, brushes: brushes.map(brushToJSON) });
  return {
    get: async () => stored,
    set: async (_key, value) => {
      stored = value;
    },
  };
}

/** The engine brush without what doesn't change how it paints (the library category, built-in). */
const paints = (b: PaintBrush) => {
  const { category: _c, builtin: _b, ...rest } = b;
  return JSON.stringify(rest);
};

/**
 * The facet brush an engine brush edited by its settings amounts to (`migrateBrushV1`), keeping
 * what the engine doesn't read from the brush it was edited from: description, tags, medium and
 * variety, suggested colours, light spill and glow, and motion hints. Hints that would change how
 * it paints are left out.
 */
export function brushSpecOf(next: PaintBrush, from: Brush): Brush {
  const plain = migrateBrushV1(next);
  const out = copyJSON(plain) as Brush & Record<string, unknown>;
  if (from.description) out.description = from.description;
  if (from.tags?.length) out.tags = [...from.tags];
  if (out.kind === 'mark' && from.kind === 'mark') {
    if (from.medium) out.medium = from.medium;
    if (from.variety) out.variety = from.variety;
  }
  const colour = { ...(from.colour ?? {}) };
  if (plain.colour?.default !== undefined) colour.default = plain.colour.default;
  else if (isObject(colour.default) && (colour.default as { type?: string }).type === 'gradient') delete colour.default;
  if (Object.keys(colour).length) out.colour = copyJSON(colour);
  else delete out.colour;
  if ((out.light?.amount ?? 0) > 0 && (from.light?.spill || from.light?.glow !== undefined)) {
    out.light = { ...out.light, ...(from.light.spill ? { spill: { ...from.light.spill } } : {}), ...(from.light.glow !== undefined ? { glow: from.light.glow } : {}) };
  }
  if (from.motion?.live !== undefined || from.motion?.fps !== undefined) {
    out.motion = { ...(out.motion ?? {}), ...(from.motion.live !== undefined ? { live: from.motion.live } : {}), ...(from.motion.fps !== undefined ? { fps: from.motion.fps } : {}) };
  }
  try {
    const hinted = normalizeBrushSpec(out, []);
    if (paints(resolveBrush(hinted)) === paints(resolveBrush(plain))) return hinted;
  } catch {
    // A hint the brush can't carry: keep the plain brush.
  }
  return plain;
}

/** The engine settings `next` changes on `base`, as `normalizePaintBrush(changes, base)` takes them (lists whole). */
export function engineChanges(base: PaintBrush, next: PaintBrush): Omit<Partial<PaintBrush>, 'id'> {
  const diff = (a: unknown, b: unknown): unknown => {
    if (isObject(a) && isObject(b)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(b)) {
        const d = diff(a[k], b[k]);
        if (d !== undefined) out[k] = d;
      }
      return Object.keys(out).length ? out : undefined;
    }
    return JSON.stringify(a) === JSON.stringify(b) ? undefined : copyJSON(b);
  };
  const { id: _i, builtin: _b, ...rest } = (diff(base, next) as Record<string, unknown> | undefined) ?? {};
  return rest as Omit<Partial<PaintBrush>, 'id'>;
}
