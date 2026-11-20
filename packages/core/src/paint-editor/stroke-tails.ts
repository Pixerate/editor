/**
 * Editable strokes on pixel layers (#902). A pixel layer keeps the strokes painted on it since its
 * last flattening point as a `StrokeTail`: the pixels and light under them (`base`, `baseLight`)
 * and the ids of those strokes in the stroke log. Only strokes a stroke layer could redraw exactly
 * join a tail (`liveStrokeRefusal`, see the controller's `tailEligible`); any other stroke or
 * change to the layer replaces its surface, which ends the tail, and the strokes after it start a
 * new one over the pixels as they are then.
 *
 * Editing a tail's stroke changes the log itself (the stroke is replaced, reordered or removed in
 * `PaintDocumentState.strokes`), so the colour-scheme replay, `renderHighRes` and the time-lapse
 * paint the edited strokes too. Removing a logged stroke moves the events after it (`at`) down by
 * one, so they keep their place between the strokes.
 */

import { decodePng, parseDataUrl, pngDataUrl } from '../raster/png';
import { emptySurface, readRegion, surfaceFromSavedPixels, type RasterRect, type TiledSurface } from '../raster/surface';
import type { PaintDocumentState, StrokeTail } from './document';
import { lightFromJSON, lightToJSON, type SavedLight } from './light';
import type { RecordedStroke } from './strokes';

/** A stroke tail as saved: the ids, and the base pixels (`null`: empty) and light as PNGs. */
export interface SavedStrokeTail {
  ids: string[];
  base: { rect: RasterRect; pixels: string } | null;
  baseLight?: SavedLight;
}

export function strokeTailToJSON(tail: StrokeTail): SavedStrokeTail {
  const b = tail.base.bounds;
  return {
    ids: [...tail.ids],
    base: b ? { rect: { ...b }, pixels: pngDataUrl(b.width, b.height, readRegion(tail.base, b), 4) } : null,
    ...(tail.baseLight ? (() => {
      const l = lightToJSON(tail.baseLight);
      return l ? { baseLight: l } : {};
    })() : {}),
  };
}

/**
 * Saved form → the tail's base, base light and ids (its `top` is the layer as opened); throws a
 * sentence when it cannot be read.
 */
export function strokeTailFromJSON(raw: unknown): { base: TiledSurface; baseLight: TiledSurface | null; ids: string[] } {
  const r = raw as Partial<SavedStrokeTail>;
  if (!r || typeof r !== 'object' || !Array.isArray(r.ids) || !r.ids.every((x) => typeof x === 'string')) throw new Error('it has no list of stroke ids');
  let base = emptySurface(4);
  if (r.base) {
    if (typeof r.base !== 'object' || !r.base.rect || typeof r.base.pixels !== 'string') throw new Error('its base pixels are not a rect and a PNG');
    const parsed = parseDataUrl(r.base.pixels);
    if (!parsed) throw new Error('its base pixels are not a PNG data URL');
    const img = decodePng(parsed.bytes);
    if (img.width !== r.base.rect.width || img.height !== r.base.rect.height) throw new Error('its base PNG is not the size of its rect');
    base = surfaceFromSavedPixels({ width: img.width, height: img.height, data: img.data }, 4, r.base.rect.x, r.base.rect.y);
  }
  const baseLight = r.baseLight ? lightFromJSON(r.baseLight) : null;
  return { base, baseLight, ids: [...r.ids] };
}

/**
 * The log with a tail's strokes replaced by `list` (the tail after an edit, bottom first): the
 * strokes still there take the tail's places in the log in their new order, and the places of the
 * removed ones go, moving later events (`at`) down. Every stroke of `list` must have an id among
 * `ids`.
 */
export function withTailLog(doc: PaintDocumentState, ids: readonly string[], list: readonly RecordedStroke[]): Pick<PaintDocumentState, 'strokes' | 'wetEvents' | 'paintEvents'> {
  const keep = new Set(list.map((s) => s.id));
  const places: number[] = [];
  const removed: number[] = [];
  const wanted = new Set(ids);
  doc.strokes.forEach((s, i) => {
    if (!wanted.has(s.id)) return;
    if (keep.has(s.id)) places.push(i);
    else removed.push(i);
  });
  const strokes = [...doc.strokes];
  places.forEach((at, i) => {
    strokes[at] = list[i];
  });
  if (!removed.length) return { strokes, wetEvents: doc.wetEvents, paintEvents: doc.paintEvents };
  const gone = new Set(removed);
  // An event at `at` comes after `at` strokes: it moves down by the removed strokes before it.
  const shift = (at: number) => at - removed.filter((k) => k < at).length;
  return {
    strokes: strokes.filter((_, i) => !gone.has(i)),
    ...(doc.wetEvents ? { wetEvents: doc.wetEvents.map((e) => (e.at !== undefined && shift(e.at) !== e.at ? { ...e, at: shift(e.at) } : e)) } : {}),
    ...(doc.paintEvents ? { paintEvents: doc.paintEvents.map((e) => (shift(e.at) !== e.at ? { ...e, at: shift(e.at) } : e)) } : {}),
  };
}

/** The sentence `list_strokes` gives for a logged stroke on a pixel layer that can't be edited. */
export const BAKED_STROKE_REASON =
  'Painted before its layer was last flattened (by a stroke or change that can’t be redrawn exactly: wet paint, a smudge, blender or pick-up, a fill, a filter, a transform, an import), so its pixels are baked. Strokes painted after that stay editable.';
