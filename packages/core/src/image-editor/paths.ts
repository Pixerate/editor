/**
 * Document paths (Photoshop's Paths panel): vector outlines kept with the document but on no
 * layer. The Work Path is the scratch path Make Work Path replaces; saved paths stay until
 * deleted. A path can become a selection, a vector mask, a fill or a stroke.
 */

import type { CropBox } from './types';
import type { ShapeComponent, ShapeFillRule } from './layers/model';
import { subpathsToSvgPath } from './selection/path';
import { readShapeComponents } from './layers/serialize';
import { vectorMaskBounds } from './layers/vector-mask';

export interface DocumentPath {
  id: string;
  name: string;
  /** In document pixels, combined by their operations (as a shape layer's). */
  components: ShapeComponent[];
  /** How overlapping subpaths fill (default nonzero; a traced selection's holes need evenodd). */
  fillRule?: ShapeFillRule;
  /** The Work Path: replaced by the next Make Work Path until it is saved (renamed). */
  work?: boolean;
}

/** A path as stored in a document (`toJSON().paths`). */
export interface SerializedDocumentPath {
  id: string;
  name: string;
  /** Components as a vector mask stores them. */
  components: unknown[];
  fillRule?: 'evenodd';
  work?: boolean;
}

export const WORK_PATH_NAME = 'Work Path';

let counter = 0;

/** A new, unique path id. */
export function newPathId(): string {
  counter = (counter + 1) % 1_000_000;
  return `path-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** The path's outline as SVG path data in document pixels (for a thumbnail or `d` attribute). */
export function pathSvgData(path: DocumentPath): string {
  return subpathsToSvgPath(path.components.flatMap((c) => c.subpaths));
}

/** The path's bounds in document pixels (of the curve itself, not its handles), or null when empty. */
export function pathBounds(path: DocumentPath): CropBox | null {
  return vectorMaskBounds({ components: path.components });
}

/** How many anchors the path has. */
export function pathAnchorCount(path: DocumentPath): number {
  return path.components.reduce((n, c) => n + c.subpaths.reduce((m, sp) => m + sp.anchors.length, 0), 0);
}

export function serializePaths(paths: readonly DocumentPath[]): SerializedDocumentPath[] {
  return paths.map((p) => ({
    id: p.id,
    name: p.name,
    components: JSON.parse(JSON.stringify(p.components)),
    ...(p.fillRule === 'evenodd' ? { fillRule: 'evenodd' as const } : {}),
    ...(p.work ? { work: true } : {}),
  }));
}

/**
 * Restores stored paths, skipping damaged ones (listed in `problems`). At most one stays the Work
 * Path; ids are made unique.
 */
export function readPaths(stored: unknown, problems: string[] = []): DocumentPath[] {
  if (!Array.isArray(stored)) return [];
  const out: DocumentPath[] = [];
  const ids = new Set<string>();
  let work = false;
  for (const [i, raw] of stored.entries()) {
    const r = raw as Partial<SerializedDocumentPath> | null;
    const name = typeof r?.name === 'string' && r.name.trim() ? r.name.trim() : `Path ${i + 1}`;
    try {
      const components = readShapeComponents(r?.components);
      let id = typeof r?.id === 'string' && r.id ? r.id : newPathId();
      if (ids.has(id)) id = newPathId();
      ids.add(id);
      const path: DocumentPath = { id, name, components };
      if (r?.fillRule === 'evenodd') path.fillRule = 'evenodd';
      if (r?.work === true && !work) {
        path.work = true;
        work = true;
      }
      out.push(path);
    } catch (err) {
      problems.push(`Path "${name}" could not be read (${err instanceof Error ? err.message : String(err)}) and was left out.`);
    }
  }
  return out;
}
