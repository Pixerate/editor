/**
 * Brush sources: the images a brush is made from, as Procreate's Shape and Grain sources. A
 * source is a grey mask (255 paints, or is a grain peak; 0 is empty) kept as a greyscale PNG
 * `data:` URL, so a library file or a saved painting carries its bytes alongside the brushes
 * that name it.
 *
 * - A stamp tip lays a source with the ref `source:<id>` in `tip.stamps`, the same way it lays a
 *   sticker: shaped dabs, sprays and particle dots all take it.
 * - `tip.grain.source` takes `source:<id>` as a grain texture (or one of the built-in grain
 *   patterns).
 *
 * `makeBrushSource` reads an uploaded image (PNG, any size up to `MAX_BRUSH_SOURCE_INPUT_PIXELS`),
 * picks the channel that holds the marks and scales it to fit `MAX_BRUSH_SOURCE_SIZE`.
 */

import { decodePng, parseDataUrl, pngDataUrl } from '../raster/png';
import { BRUSH_ID } from '../paint-editor/brush-model';
import type { Brush } from './types';

/** The ref prefix of a brush source: `source:<id>`. The sticker provider id `source` is reserved for it. */
export const BRUSH_SOURCE_PROVIDER = 'source';
/** Longest side a source is kept at (px); larger images are scaled down when added. */
export const MAX_BRUSH_SOURCE_SIZE = 512;
/** Largest image `makeBrushSource` decodes (pixels). */
export const MAX_BRUSH_SOURCE_INPUT_PIXELS = 4096 * 4096;
/** Most sources one library keeps. */
export const MAX_BRUSH_SOURCES = 500;

/**
 * Which part of an image holds the marks: `alpha` (art on a transparent background), `darkness`
 * (dark marks on white paper, a scan), `lightness` (white marks on black, as Procreate's shape
 * sources) or `auto`: alpha when the image has any transparency, else darkness.
 */
export type BrushSourceChannel = 'auto' | 'alpha' | 'darkness' | 'lightness';
export const BRUSH_SOURCE_CHANNELS: readonly BrushSourceChannel[] = ['auto', 'alpha', 'darkness', 'lightness'];

/** A stored source. */
export interface BrushSource {
  /** Lowercase letters, digits and dashes, up to 64 characters. */
  id: string;
  /** Display name, up to 80 characters. */
  name: string;
  /** Size of the mask in px (each 1..`MAX_BRUSH_SOURCE_SIZE`). */
  width: number;
  height: number;
  /** The mask: a greyscale PNG `data:` URL, 255 paints. */
  image: string;
  /** The licence or terms it came with (a brush pack's notes), kept with the source. */
  licence?: string;
  /** Where it came from: a file or brush pack name. */
  origin?: string;
}

/** What `makeBrushSource` reads. */
export interface BrushSourceInput {
  /** Default: from the name. */
  id?: string;
  name: string;
  /** A PNG as a `data:image/png;base64,…` URL, or its bytes. */
  image: string | Uint8Array;
  /** Default `auto`. */
  channel?: BrushSourceChannel;
  /** Swap painted and empty (default false). */
  invert?: boolean;
  licence?: string;
  origin?: string;
}

/** A source without its image, for lists. */
export type BrushSourceSummary = Omit<BrushSource, 'image'> & { ref: string };

/** A refusal; the message says what to do instead. */
export class BrushSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrushSourceError';
  }
}

/** `source:<id>`. */
export function brushSourceRef(id: string): string {
  return `${BRUSH_SOURCE_PROVIDER}:${id}`;
}

/** Whether a stamp or grain ref names a brush source. */
export function isBrushSourceRef(ref: unknown): ref is string {
  return typeof ref === 'string' && ref.startsWith(`${BRUSH_SOURCE_PROVIDER}:`);
}

/** The source id of a `source:<id>` ref, or `null` for any other ref. */
export function brushSourceIdOf(ref: string): string | null {
  return isBrushSourceRef(ref) ? ref.slice(BRUSH_SOURCE_PROVIDER.length + 1) : null;
}

/** The ids of the sources a brush lays or textures with (its stamp tip and its grain). */
export function brushSourceIds(brush: Pick<Brush, 'tip'>): string[] {
  const refs = [...(brush.tip.stamps ?? []), ...(brush.tip.grain ? [brush.tip.grain.source] : [])];
  return [...new Set(refs.map(brushSourceIdOf).filter((id): id is string => id !== null))];
}

/** The list form of a source. */
export function summarizeBrushSource(s: BrushSource): BrushSourceSummary {
  const { image: _i, ...rest } = s;
  return { ...rest, ref: brushSourceRef(s.id) };
}

/** An id from a name: lowercase words joined by dashes. */
export function brushSourceIdFromName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'source'
  );
}

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Box-filters a grey mask down to fit `max` on its longest side (unchanged when it already fits). */
function fit(width: number, height: number, mask: Uint8Array | Uint8ClampedArray, max: number): { width: number; height: number; mask: Uint8Array } {
  const scale = Math.min(1, max / Math.max(width, height));
  if (scale >= 1) return { width, height, mask: Uint8Array.from(mask) };
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += mask[yy * width + xx];
      out[y * w + x] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
    }
  }
  return { width: w, height: h, mask: out };
}

/**
 * A source from a grey mask (255 paints), scaled to fit `MAX_BRUSH_SOURCE_SIZE`. Importers use it
 * for tips they have decoded themselves. Throws when the mask is empty or the wrong size.
 */
export function brushSourceFromMask(meta: { id: string; name: string; licence?: string; origin?: string }, width: number, height: number, mask: Uint8Array | Uint8ClampedArray): BrushSource {
  if (!BRUSH_ID.test(meta.id)) throw new BrushSourceError(`Source id ${JSON.stringify(meta.id)} is not valid: use lowercase letters, digits and dashes (up to 64).`);
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) || mask.length !== width * height) throw new BrushSourceError('The mask is not width × height bytes.');
  let any = false;
  for (let i = 0; i < mask.length && !any; i++) any = mask[i] > 0;
  if (!any) throw new BrushSourceError(`"${meta.name}" has no marks: every pixel is empty. Pick another channel (alpha, darkness or lightness) or set invert.`);
  const f = fit(width, height, mask, MAX_BRUSH_SOURCE_SIZE);
  const name = text(meta.name, 80) ?? meta.id;
  const licence = text(meta.licence, 2000);
  const origin = text(meta.origin, 200);
  return { id: meta.id, name, width: f.width, height: f.height, image: pngDataUrl(f.width, f.height, f.mask, 1), ...(licence ? { licence } : {}), ...(origin ? { origin } : {}) };
}

/**
 * A source from an uploaded image (see the module comment): its marks read from `channel`,
 * inverted when asked, scaled to fit. Throws (a `BrushSourceError`) when the image is not a PNG,
 * too large, or empty in that channel; `problems` hears what was changed (scaling, the channel
 * `auto` picked).
 */
export function makeBrushSource(input: BrushSourceInput, problems: string[] = []): BrushSource {
  const name = text(input.name, 80);
  if (!name) throw new BrushSourceError('A brush source needs a name.');
  const id = input.id ?? brushSourceIdFromName(name);
  if (!BRUSH_ID.test(id)) throw new BrushSourceError(`Source id ${JSON.stringify(id)} is not valid: use lowercase letters, digits and dashes (up to 64), starting with a letter or digit.`);
  let bytes: Uint8Array;
  if (typeof input.image === 'string') {
    const parsed = parseDataUrl(input.image);
    if (!parsed) throw new BrushSourceError('image must be a data: URL (data:image/png;base64,…) or PNG bytes.');
    bytes = parsed.bytes;
  } else bytes = input.image;
  let png;
  try {
    png = decodePng(bytes, { maxPixels: MAX_BRUSH_SOURCE_INPUT_PIXELS });
  } catch (e) {
    throw new BrushSourceError(`The image can't be read as a PNG (${(e as Error).message}); convert it to PNG, at most ${MAX_BRUSH_SOURCE_INPUT_PIXELS} pixels.`);
  }
  const { width, height, data } = png;
  const n = width * height;
  let channel = input.channel ?? 'auto';
  if (channel === 'auto') {
    let transparent = false;
    for (let i = 0; i < n && !transparent; i++) transparent = data[i * 4 + 3] < 250;
    channel = transparent ? 'alpha' : 'darkness';
    problems.push(`channel auto read the marks from ${channel === 'alpha' ? 'the transparency' : 'the dark parts (dark marks on a light background)'}.`);
  }
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    // Luminance of the colour over white, so transparent pixels read as paper.
    const lum = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) * (a / 255) + 255 * (1 - a / 255);
    const v = channel === 'alpha' ? a : channel === 'darkness' ? 255 - lum : lum;
    mask[i] = Math.round(input.invert ? 255 - v : v);
  }
  const source = brushSourceFromMask({ id, name, licence: input.licence, origin: input.origin }, width, height, mask);
  if (source.width !== width) problems.push(`The image was scaled from ${width}×${height} to ${source.width}×${source.height} (sources are kept at most ${MAX_BRUSH_SOURCE_SIZE} px).`);
  return source;
}

const GREY_PNG = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;

/**
 * A stored source read back (from a library file or a saved painting), or `null` with the reason
 * in `problems`. The image is checked for its form, not decoded (`decodeBrushSource` does that
 * when it is first painted with).
 */
export function readBrushSource(raw: unknown, at: string, problems: string[]): BrushSource | null {
  const r = raw as Partial<BrushSource> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return void problems.push(`${at} is not a brush source; skipped.`), null;
  if (typeof r.id !== 'string' || !BRUSH_ID.test(r.id)) return void problems.push(`${at} has no valid id; skipped.`), null;
  const ok = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_BRUSH_SOURCE_SIZE;
  if (!ok(r.width) || !ok(r.height)) return void problems.push(`${at} ("${r.id}") has no valid width and height (1..${MAX_BRUSH_SOURCE_SIZE}); skipped.`), null;
  if (typeof r.image !== 'string' || !GREY_PNG.test(r.image)) return void problems.push(`${at} ("${r.id}") has no PNG data: URL image; skipped.`), null;
  const name = text(r.name, 80) ?? r.id;
  const licence = text(r.licence, 2000);
  const origin = text(r.origin, 200);
  return { id: r.id, name, width: r.width!, height: r.height!, image: r.image, ...(licence ? { licence } : {}), ...(origin ? { origin } : {}) };
}

/** A decoded source: one byte per pixel, 255 paints. */
export interface DecodedBrushSource {
  width: number;
  height: number;
  mask: Uint8ClampedArray;
}

const decoded = new Map<string, DecodedBrushSource>();

/**
 * The source's mask, decoded once per image (cached by its data, so a painting's copy and the
 * library's share it). Throws when the image is not a valid PNG.
 */
export function decodeBrushSource(source: Pick<BrushSource, 'image'>): DecodedBrushSource {
  const hit = decoded.get(source.image);
  if (hit) return hit;
  const parsed = parseDataUrl(source.image);
  if (!parsed) throw new BrushSourceError('The source image is not a data: URL.');
  const png = decodePng(parsed.bytes, { keepGray: true, maxPixels: MAX_BRUSH_SOURCE_SIZE * MAX_BRUSH_SOURCE_SIZE });
  let mask: Uint8ClampedArray;
  if (png.channels === 1) mask = png.data;
  else {
    // A source written by another tool in RGBA: its red channel, as written by `brushSourceFromMask`'s grey.
    mask = new Uint8ClampedArray(png.width * png.height);
    for (let i = 0; i < mask.length; i++) mask[i] = Math.round((png.data[i * 4] * png.data[i * 4 + 3]) / 255);
  }
  const out = { width: png.width, height: png.height, mask };
  if (decoded.size > 256) decoded.delete(decoded.keys().next().value!);
  decoded.set(source.image, out);
  return out;
}
