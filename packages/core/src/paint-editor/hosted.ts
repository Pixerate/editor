// A paint document hosted as a layer on a larger canvas (see `PaintEditorToolProviderOptions.origin`).
// Tools declare which of their argument and result fields are positions (`coordinates`); the provider
// shifts those by the origin in one place, so a tool only has to name its fields to work hosted.
import type { AgentTool } from '../tools/registry.js';
import type { PaintEditorController } from './controller';

/**
 * Position fields of a paint tool, as paths: keys joined by `.`, a key ending in `[]` maps over
 * that array, `''` is the value itself. Each path names an object whose numeric `x` / `y` are a
 * position (a point, or the top-left of a rect); missing or `null` values are skipped.
 */
export interface PaintToolCoordinates {
  /** Argument fields, given in host coordinates and moved into document pixels. */
  in?: readonly string[];
  /** Result fields, in document pixels and moved out into host coordinates. */
  out?: readonly string[];
}

/** A paint tool with its position fields. */
export type PaintAgentTool = AgentTool & { coordinates?: PaintToolCoordinates };

export interface PaintOrigin {
  x: number;
  y: number;
}

/** A copy of `value` with the `x` / `y` at `path` moved by (dx, dy); `value` is left untouched. */
function shiftAt(value: unknown, keys: readonly string[], dx: number, dy: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (keys.length === 0) {
    if (Array.isArray(value)) return value;
    const o: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    if (typeof o.x === 'number') o.x += dx;
    if (typeof o.y === 'number') o.y += dy;
    return o;
  }
  const [head, ...rest] = keys;
  const each = head.endsWith('[]');
  const key = each ? head.slice(0, -2) : head;
  const inner = key === '' ? value : (value as Record<string, unknown>)[key];
  if (inner === undefined) return value;
  const next = each ? (Array.isArray(inner) ? inner.map((v) => shiftAt(v, rest, dx, dy)) : inner) : shiftAt(inner, rest, dx, dy);
  if (key === '') return next;
  return Array.isArray(value) ? value : { ...(value as Record<string, unknown>), [key]: next };
}

const shiftAll = (value: unknown, paths: readonly string[], dx: number, dy: number) =>
  paths.reduce((v, p) => shiftAt(v, p === '' ? [] : p.split('.'), dx, dy), value);

/** Host coordinates → document pixels, at the given position fields. */
export const toDocument = <T>(value: T, paths: readonly string[], origin: PaintOrigin): T => shiftAll(value, paths, -origin.x, -origin.y) as T;

/** Document pixels → host coordinates, at the given position fields. */
export const fromDocument = <T>(value: T, paths: readonly string[], origin: PaintOrigin): T => shiftAll(value, paths, origin.x, origin.y) as T;

/** Tool prose in host terms: positions are canvas coordinates, not document pixels. */
export function hostedText(text: string): string {
  return text
    .replace(/\ba document pixel\b/g, 'a canvas point')
    .replace(/\bdocument pixels\b/g, 'canvas coordinates')
    .replace(/\bDocument ([xy])\b/g, 'Canvas $1')
    .replace(/\bdocument ([xy])\b/g, 'canvas $1');
}

/** `hostedText` over every `description` in a JSON schema. */
export function hostedSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(hostedSchema) as T;
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) out[k] = k === 'description' && typeof v === 'string' ? hostedText(v) : hostedSchema(v);
  return out as T;
}

/**
 * A controller that resolves `get` on every property access, so tools built over it never touch
 * the document until a handler runs (a host can create the document lazily).
 */
export function lazyController(get: () => PaintEditorController): PaintEditorController {
  return new Proxy({} as PaintEditorController, {
    get(_, key) {
      const target = get();
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has: (_, key) => Reflect.has(get(), key),
  });
}
