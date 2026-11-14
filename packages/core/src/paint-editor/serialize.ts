/**
 * Saved paint documents: JSON plus PNG assets. Layers go through the image editor's layer
 * serializer (`serializeLayers` / `deserializeLayers`), so pixel layers and groups are stored the
 * same way in both editors, including external asset stores. The paper is plain settings: it is
 * regenerated on load, never stored as pixels.
 *
 * Forward compatibility: readers keep fields they do not know at the top level (`extensions`) and
 * write them back, so a later version can add per-layer wet state, height or material channels
 * as new assets keyed by layer id without breaking older readers (see `PaintDocumentExtensions`).
 */

import {
  deserializeLayers,
  resolveExternalAssets,
  serializeLayers,
  serializeLayersExternal,
  type ImageEditorAssetStore,
  type SerializedLayer,
} from '../image-editor/layers/serialize';
import type { ImageLayer } from '../image-editor/layers/model';
import { findLayer, flattenLayers } from '../raster/layers';
import { culturesExtensionFromJSON, culturesExtensionToJSON } from '../paint/culture';
import { parseDataUrl } from '../raster/png';
import { normalizeBrushStroke, strokeToJSON } from './strokes';
import { normalizeCanvas, type PaintDocumentState, type PaintEvent, type PaintLayer } from './document';
import { normalizePaper, type PaperSettings } from './paper';
import type { WetEvent } from './wet';

export const PAINT_FORMAT = 'pixerate-paint' as const;
/** 2: recorded strokes keep facet brushes (version 1 documents, with flat engine brushes, still load). */
export const PAINT_SCHEMA_VERSION = 2 as const;

/** A recorded stroke as a document stores it (`strokeToJSON`). */
export type SerializedStroke = ReturnType<typeof strokeToJSON>;

/** Where a host keeps layer PNGs outside the JSON (the image editor's asset store contract). */
export type PaintAssetStore = ImageEditorAssetStore;

/**
 * Fields a later version adds. Phase 1 writes none of them and keeps any it reads. Planned:
 * `layerChannels: { [layerId]: { height?: asset, material?: asset } }` for impasto and
 * metallic paint. Wet paint itself is never saved (saving dries it); its settings are (`wet`).
 */
export type PaintDocumentExtensions = Record<string, unknown>;

export interface SerializedPaintDocument {
  format: typeof PAINT_FORMAT;
  version: typeof PAINT_SCHEMA_VERSION;
  width: number;
  height: number;
  dpi: number;
  paper: PaperSettings;
  /** Bottom to top: pixel layers and groups, as the image editor stores them. */
  layers: SerializedLayer[];
  /** Asset id → PNG data URL (or an external reference). */
  assets: Record<string, string>;
  activeLayerId: string | null;
  /**
   * Recorded strokes (strokes are data), oldest first, each brush a facet `Brush`; missing when
   * saved without them. Saved with `strokes: 'replay'`, a stroke kept on a stroke layer is a
   * `StrokeLogReference`; saved with an asset store, the list is a `ChunkedList` (as are
   * `wetEvents`, `paintEvents` and each `liveStrokes` list). The loaders read every form.
   */
  strokes?: SerializedStroke[];
  /** Everything else (document-level state of later phases), written back as read. */
  [extension: string]: unknown;
}

const KNOWN = new Set(['format', 'version', 'width', 'height', 'dpi', 'paper', 'layers', 'assets', 'activeLayerId', 'strokes', 'guides', 'swatches', 'mixingPad', 'wet', 'wetEvents', 'paintEvents', 'origin']);

/** Fields of a saved document this version does not read, kept for writing back. */
export function documentExtensions(raw: Record<string, unknown>): PaintDocumentExtensions {
  const out: PaintDocumentExtensions = {};
  for (const [k, v] of Object.entries(raw)) if (!KNOWN.has(k)) out[k] = v;
  return out;
}

/**
 * Which recorded strokes a save writes: `true` (default) the whole stroke log, `false` none, or
 * `'replay'` only what the colour-scheme replay needs: the log when a pixel layer (not a stroke
 * layer) holds a light / dark stroke, else none (as `false`). In it a stroke that is also on a
 * stroke layer, unchanged, is written as a reference to it (`{ liveStroke: id, layerId }`), so
 * stroke layers' strokes are not saved twice; loading puts the stroke back.
 */
export type StrokeLogOption = boolean | 'replay';

export interface SerializeOptions {
  /** Which recorded strokes to include (default true, see `StrokeLogOption`). */
  strokes?: StrokeLogOption;
  /** Later-phase fields to write as they were read. */
  extensions?: PaintDocumentExtensions;
  /** Painting guides (symmetry, perspective, tracing and reference images as PNG data URLs). */
  guides?: unknown;
  swatches?: unknown;
  /** The mixing pad: `{ current?: png data URL, saved: [{ id, name, png }] }`. */
  mixingPad?: unknown;
  /** Wet media settings: `{ tilt, layers: { [layerId]: { params, flow } } }`. */
  wet?: unknown;
}

function header(state: PaintDocumentState, options: SerializeOptions): Omit<SerializedPaintDocument, 'layers' | 'assets'> {
  const out: Omit<SerializedPaintDocument, 'layers' | 'assets'> = {
    ...(options.extensions ?? {}),
    format: PAINT_FORMAT,
    version: PAINT_SCHEMA_VERSION,
    width: state.canvas.width,
    height: state.canvas.height,
    dpi: state.canvas.dpi,
    paper: { ...state.paper, dry: { ...state.paper.dry }, wet: { ...state.paper.wet } },
    activeLayerId: state.activeLayerId,
  };
  const log = savedStrokeLog(state, options);
  if (log) out.strokes = log as SerializedStroke[];
  if (options.guides !== undefined) out.guides = JSON.parse(JSON.stringify(options.guides));
  if (options.swatches !== undefined) out.swatches = JSON.parse(JSON.stringify(options.swatches));
  if (options.mixingPad !== undefined) (out as Record<string, unknown>).mixingPad = JSON.parse(JSON.stringify(options.mixingPad));
  if (options.wet !== undefined) (out as Record<string, unknown>).wet = JSON.parse(JSON.stringify(options.wet));
  if (state.wetEvents?.length) (out as Record<string, unknown>).wetEvents = JSON.parse(JSON.stringify(state.wetEvents));
  if (state.paintEvents?.length) (out as Record<string, unknown>).paintEvents = JSON.parse(JSON.stringify(state.paintEvents));
  if (state.origin && (state.origin.x || state.origin.y)) (out as Record<string, unknown>).origin = { ...state.origin };
  if ((out as Record<string, unknown>).cultures === undefined) {
    const cultures = culturesExtensionToJSON(state);
    if (cultures) (out as Record<string, unknown>).cultures = cultures;
  }
  return out;
}

/** How a stroke log saved with `strokes: 'replay'` refers to a stroke kept on a stroke layer. */
export interface StrokeLogReference {
  liveStroke: string;
  layerId: string;
}

/**
 * Whether a save with `options` keeps the stroke log (the whole log, even an empty one): `true`
 * does, `false` doesn't, `'replay'` only when a pixel layer holds a light / dark stroke. Marks of
 * pixels the log doesn't have (`unlogged`) are only complete next to the log they describe.
 */
export function savesStrokeLog(state: PaintDocumentState, options: SerializeOptions): boolean {
  const mode = options.strokes ?? true;
  if (mode !== 'replay') return mode;
  return savedStrokeLog(state, options) !== null;
}

/** The stroke log as `options.strokes` saves it, or `null` for none. */
function savedStrokeLog(state: PaintDocumentState, options: SerializeOptions): Array<SerializedStroke | StrokeLogReference> | null {
  const mode = options.strokes ?? true;
  if (mode === false || !state.strokes.length) return null;
  if (mode !== 'replay') return state.strokes.map(strokeToJSON);
  // The stroke layers' strokes as this save writes them (`liveStrokes`, from the controller).
  const raw = options.extensions?.liveStrokes;
  const live = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const isLive = (layerId: string) => Array.isArray(live[layerId]);
  // A replay rebuilds pixel layers only: without a light / dark stroke on one, no replay needs the log.
  const needed = state.strokes.some((st) => st.dualColor && !isLive(st.layerId) && findLayer(state.layers, st.layerId)?.layer.type === 'pixel');
  if (!needed) return null;
  const byLayer = new Map<string, Map<string, string>>();
  const savedLive = (layerId: string): Map<string, string> => {
    let m = byLayer.get(layerId);
    if (!m) {
      m = new Map();
      for (const x of live[layerId] as unknown[]) {
        const id = (x as { id?: unknown } | null)?.id;
        if (typeof id === 'string' && !m.has(id)) m.set(id, JSON.stringify(x));
      }
      byLayer.set(layerId, m);
    }
    return m;
  };
  return state.strokes.map((st) => {
    const json = strokeToJSON(st);
    if (isLive(st.layerId) && savedLive(st.layerId).get(st.id) === JSON.stringify(json)) return { liveStroke: st.id, layerId: st.layerId };
    return json;
  });
}

function isStrokeLogReference(s: unknown): s is StrokeLogReference {
  return Boolean(s) && typeof s === 'object' && typeof (s as StrokeLogReference).liveStroke === 'string' && typeof (s as StrokeLogReference).layerId === 'string' && !('points' in (s as object));
}

/**
 * `strokes` with each `{ liveStroke, layerId }` replaced by that stroke from `liveStrokes` (the
 * saved stroke layers); one that is not there is reported and left out.
 */
function resolveStrokeLog(strokes: unknown, liveStrokes: unknown, problems: string[]): unknown {
  if (!Array.isArray(strokes) || !strokes.some(isStrokeLogReference)) return strokes;
  const live = liveStrokes && typeof liveStrokes === 'object' ? (liveStrokes as Record<string, unknown>) : {};
  const out: unknown[] = [];
  strokes.forEach((s, i) => {
    if (!isStrokeLogReference(s)) {
      out.push(s);
      return;
    }
    const list = live[s.layerId];
    const found = Array.isArray(list) ? list.find((x) => (x as { id?: unknown } | null)?.id === s.liveStroke) : undefined;
    if (found) out.push(found);
    else problems.push(`strokes[${i}] refers to stroke "${s.liveStroke}" of stroke layer "${s.layerId}", which the document does not have; skipped.`);
  });
  return out;
}

/** The document as JSON with inline PNG data URLs. */
export function serializePaintDocument(state: PaintDocumentState, options: SerializeOptions = {}): SerializedPaintDocument {
  const { layers, assets } = serializeLayers(state.layers as unknown as ImageLayer[]);
  return { ...header(state, options), layers, assets } as SerializedPaintDocument;
}

/**
 * Top-level fields with no PNGs of their own in them (or, for strokes and events, stored as they
 * are, in runs of JSON: `ChunkedList`), so the PNG pass of the external writer leaves them. Every other field (the light, thick paint,
 * fluorescence, thermochromic, ferrofluid and heat channels, the mixing pad, brush source art,
 * guides and any later extension) has its PNG data URLs stored as assets.
 */
const NO_EXTENSION_PNGS = new Set(['format', 'version', 'width', 'height', 'dpi', 'paper', 'layers', 'assets', 'activeLayerId', 'strokes', 'wetEvents', 'paintEvents', 'origin']);

/** How an extension field refers to a PNG in `assets`: `asset:<asset id>`. */
export const EXTENSION_ASSET_REF = 'asset:';

const PNG_DATA_URL = 'data:image/png;base64,';

/** The PNGs already stored, by store: data URL → the store's reference. */
const storedPngs = new WeakMap<PaintAssetStore, Map<string, string>>();

/** FNV-1a of a string, as 8 hex digits (an extension PNG's asset id, so equal PNGs share one). */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** `value` with each PNG data URL in it put in `store` and replaced by `asset:<id>` (the id added to `assets`). */
async function externalizePngs(value: unknown, assets: Record<string, string>, store: PaintAssetStore): Promise<unknown> {
  if (typeof value === 'string') {
    if (!value.startsWith(PNG_DATA_URL)) return value;
    const id = `ext-${fnv1a(value)}-${value.length.toString(36)}`;
    if (!assets[id]) {
      let refs = storedPngs.get(store);
      if (!refs) storedPngs.set(store, (refs = new Map()));
      let ref = refs.get(value);
      if (!ref) {
        const parsed = parseDataUrl(value);
        if (!parsed) return value;
        const b = parsed.bytes;
        const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
        ref = await store.put(new Blob([b as BlobPart], { type: 'image/png' }), { id, width: b.length >= 24 ? u32(16) : 0, height: b.length >= 24 ? u32(20) : 0 });
        if (typeof ref !== 'string' || !ref) throw new Error(`The asset store returned no reference for "${id}".`);
        refs.set(value, ref);
      }
      assets[id] = ref;
    }
    return `${EXTENSION_ASSET_REF}${id}`;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const v of value) out.push(await externalizePngs(v, assets, store));
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await externalizePngs(v, assets, store);
    return out;
  }
  return value;
}

/**
 * `value` with each `asset:<id>` replaced by that asset's PNG data URL from `assets`; an id that
 * is missing (or not a data URL) is reported once in `problems` and left as it is.
 */
function inlinePngs(value: unknown, assets: Record<string, string>, problems: string[], field: string, used: Set<string>): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith(EXTENSION_ASSET_REF)) return value;
    const id = value.slice(EXTENSION_ASSET_REF.length);
    const url = assets[id];
    if (typeof url === 'string' && url.startsWith('data:')) {
      used.add(id);
      return url;
    }
    const msg = `"${field}" refers to asset "${id}", which could not be read; that part loads empty.`;
    if (!problems.includes(msg)) problems.push(msg);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => inlinePngs(v, assets, problems, field, used));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = inlinePngs(v, assets, problems, field, used);
    return out;
  }
  return value;
}

// --- Stroke data in the asset store --------------------------------------------------------

/**
 * Lists a save with an asset store keeps in the store as JSON, not in the document: the stroke
 * log and the wet and paint events (and each stroke layer's strokes, `liveStrokes.<layer id>`).
 */
const STROKE_DATA_FIELDS = ['strokes', 'wetEvents', 'paintEvents'] as const;

/** A list kept in the asset store: the ids (in `assets`) of its runs, in order, each a JSON array. */
export interface ChunkedList {
  chunks: string[];
}

/** The most items in one run of a chunked list. */
export const STROKE_CHUNK_SIZE = 16;

/** Prefix of a stroke data asset id: `json-<53-bit hash, 14 hex digits>-<text length in base 36>`. */
export const STROKE_CHUNK_PREFIX = 'json-';

/**
 * The run lengths a list of `n` items is cut into: as many full runs of `STROKE_CHUNK_SIZE` as fit,
 * then the rest as powers of two, largest first (37 → 16, 16, 4, 1). Adding one item at the end
 * changes only the last run (38 → 16, 16, 4, 2), so an append-only edit stores one new run and the
 * others keep their ids.
 */
export function strokeChunkRuns(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.floor(n / STROKE_CHUNK_SIZE); i++) out.push(STROKE_CHUNK_SIZE);
  const rest = n % STROKE_CHUNK_SIZE;
  for (let bit = STROKE_CHUNK_SIZE >> 1; bit >= 1; bit >>= 1) if (rest & bit) out.push(bit);
  return out;
}

/** cyrb53 of a string's UTF-16 code units, as 14 hex digits. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** The asset id of a run's JSON text (its content address). */
export function strokeChunkId(text: string): string {
  return `${STROKE_CHUNK_PREFIX}${hash53(text)}-${text.length.toString(36)}`;
}

/**
 * `JSON.stringify` with each object's keys sorted (by UTF-16 code units), so the same items give
 * the same text, and the same id, however their keys were ordered (a reopened document reorders
 * some).
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined || typeof v === 'function' || typeof v === 'symbol' ? 'null' : canonicalJSON(v))).join(',')}]`;
  const parts: string[] = [];
  for (const k of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
    parts.push(`${JSON.stringify(k)}:${canonicalJSON(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/** The runs already stored, by store: run id → the store's reference. */
const storedChunks = new WeakMap<PaintAssetStore, Map<string, string>>();

/** `list` cut into runs (`strokeChunkRuns`), each put in `store` once as JSON (by content). */
async function externalizeList(list: readonly unknown[], assets: Record<string, string>, store: PaintAssetStore): Promise<ChunkedList> {
  let refs = storedChunks.get(store);
  if (!refs) storedChunks.set(store, (refs = new Map()));
  const chunks: string[] = [];
  let at = 0;
  for (const n of strokeChunkRuns(list.length)) {
    const text = canonicalJSON(list.slice(at, at + n));
    at += n;
    const id = strokeChunkId(text);
    chunks.push(id);
    if (assets[id]) continue;
    let ref = refs.get(id);
    if (!ref) {
      ref = await store.put(new Blob([new TextEncoder().encode(text) as BlobPart], { type: 'application/json' }), { id, width: 0, height: 0 });
      if (typeof ref !== 'string' || !ref) throw new Error(`The asset store returned no reference for "${id}".`);
      refs.set(id, ref);
    }
    assets[id] = ref;
  }
  return { chunks };
}

/** The stroke log, events and stroke layers' strokes of `out` put in `store` as chunked lists. */
async function externalizeStrokeData(out: Record<string, unknown>, assets: Record<string, string>, store: PaintAssetStore): Promise<void> {
  for (const key of STROKE_DATA_FIELDS) {
    const list = out[key];
    if (Array.isArray(list) && list.length) out[key] = await externalizeList(list, assets, store);
  }
  const live = out.liveStrokes;
  if (live && typeof live === 'object' && !Array.isArray(live)) {
    const next: Record<string, unknown> = {};
    for (const [id, list] of Object.entries(live)) next[id] = Array.isArray(list) && list.length ? await externalizeList(list, assets, store) : list;
    out.liveStrokes = next;
  }
}

function isChunkedList(value: unknown): value is ChunkedList {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as ChunkedList).chunks);
}

/** The text of an asset's data URL (whatever media type it was labelled with), or `null`. */
function chunkText(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null;
  const parsed = parseDataUrl(url);
  if (!parsed) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(parsed.bytes);
  } catch {
    return null;
  }
}

/**
 * The items of a chunked list, its runs read from `assets` in order. A run that is missing or not
 * a JSON array is reported once in `problems`, and its items are left out.
 */
function inlineList(value: ChunkedList, assets: Record<string, string>, problems: string[], field: string, used: Set<string>): unknown[] {
  const out: unknown[] = [];
  for (const id of value.chunks) {
    let items: unknown = null;
    const text = typeof id === 'string' ? chunkText(assets[id]) : null;
    if (text !== null) {
      try {
        items = JSON.parse(text);
      } catch {
        items = null;
      }
    }
    if (Array.isArray(items)) {
      used.add(id);
      out.push(...items);
      continue;
    }
    const msg = `"${field}" refers to stroke data asset "${String(id)}", which could not be read; what it holds is left out.`;
    if (!problems.includes(msg)) problems.push(msg);
  }
  return out;
}

/** `r` with its chunked lists (the stroke log, events, stroke layers' strokes) read back from `assets`. */
function inlineStrokeData(r: Record<string, unknown>, assets: Record<string, string>, problems: string[], used: Set<string>): Record<string, unknown> {
  const out = { ...r };
  for (const key of STROKE_DATA_FIELDS) {
    const list = out[key];
    if (isChunkedList(list)) out[key] = inlineList(list, assets, problems, key, used);
  }
  const live = out.liveStrokes;
  if (live && typeof live === 'object' && !Array.isArray(live) && Object.values(live).some(isChunkedList)) {
    const next: Record<string, unknown> = {};
    for (const [id, list] of Object.entries(live)) next[id] = isChunkedList(list) ? inlineList(list, assets, problems, `liveStrokes.${id}`, used) : list;
    out.liveStrokes = next;
  }
  return out;
}

/**
 * Records the stroke data runs read from `store` as stored (run id → reference) when their text
 * still has the id it was saved under, so the next save to the same store object uploads only
 * runs that changed, not every run of a reopened document.
 */
function rememberStrokeChunks(refs: Record<string, string>, assets: Record<string, string>, store: PaintAssetStore): void {
  let known = storedChunks.get(store);
  for (const [id, ref] of Object.entries(refs)) {
    if (!id.startsWith(STROKE_CHUNK_PREFIX) || typeof ref !== 'string' || ref.startsWith('data:')) continue;
    const text = chunkText(assets[id]);
    if (text === null || strokeChunkId(text) !== id) continue;
    if (!known) storedChunks.set(store, (known = new Map()));
    known.set(id, ref);
  }
}

/**
 * The document as JSON with each PNG (layers and extension fields alike) uploaded to `store` once
 * (by content), and its stroke data (the stroke log, wet and paint events, stroke layers' strokes)
 * stored as runs of JSON (`ChunkedList`, cut by `strokeChunkRuns`), so the document itself stays
 * small and a save after one more stroke stores one new run.
 */
export async function serializePaintDocumentExternal(state: PaintDocumentState, store: PaintAssetStore, options: SerializeOptions = {}): Promise<SerializedPaintDocument> {
  const { layers, assets } = await serializeLayersExternal(state.layers as unknown as ImageLayer[], store);
  const out = { ...header(state, options), layers, assets } as SerializedPaintDocument;
  for (const key of Object.keys(out)) if (!NO_EXTENSION_PNGS.has(key)) out[key] = await externalizePngs(out[key], assets, store);
  await externalizeStrokeData(out, assets, store);
  return out;
}

export interface LoadedPaintDocument {
  state: PaintDocumentState;
  extensions: PaintDocumentExtensions;
  /** The saved guides and swatches, as stored (the controller validates them). */
  guides?: unknown;
  swatches?: unknown;
  /** The saved mixing pad, as stored (the controller validates it). */
  mixingPad?: unknown;
  /** The saved wet settings, as stored (the controller validates them). */
  wet?: unknown;
  /** What could not be read (the rest still loads). */
  problems: string[];
}

/** Keeps pixel layers and groups (the paint editor's kinds); reports and drops the rest. */
function paintLayersOnly(layers: ImageLayer[], problems: string[]): PaintLayer[] {
  const out: PaintLayer[] = [];
  for (const l of layers) {
    if (l.type === 'pixel') {
      const { filters, source, ...rest } = l;
      if (filters?.length) problems.push(`Layer "${l.name}": its filters are an image editor feature and were dropped.`);
      if (source) problems.push(`Layer "${l.name}" refers to an image editor source image; it loads empty.`);
      out.push(rest as PaintLayer);
    } else if (l.type === 'group') out.push({ ...l, children: paintLayersOnly(l.children, problems) } as PaintLayer);
    else problems.push(`Layer "${l.name}" is an image editor ${l.type} layer, which the paint editor does not have; it was left out.`);
  }
  return out;
}

function readStrokes(raw: unknown, problems: string[]): PaintDocumentState['strokes'] {
  if (!Array.isArray(raw)) return [];
  const out: PaintDocumentState['strokes'][number][] = [];
  raw.forEach((s, i) => {
    const stroke = normalizeBrushStroke(s);
    if (stroke) out.push(stroke);
    else problems.push(`strokes[${i}] is not a recorded stroke; skipped.`);
  });
  return out;
}

/** Reads a saved document with inline assets. Throws when it is not a paint document at all. */
export function deserializePaintDocument(raw: unknown): LoadedPaintDocument {
  if (!raw || typeof raw !== 'object') throw new Error('Not a paint document: expected a JSON object.');
  const r = raw as Record<string, unknown>;
  if (r.format !== PAINT_FORMAT) throw new Error(`Not a paint document: format is ${JSON.stringify(r.format)}, expected "${PAINT_FORMAT}".`);
  if (typeof r.version !== 'number' || r.version > PAINT_SCHEMA_VERSION) {
    throw new Error(`Paint document version ${JSON.stringify(r.version)} is newer than this editor reads (${PAINT_SCHEMA_VERSION}); update @pixerate/editor.`);
  }
  const problems: string[] = [];
  const rawAssets = r.assets && typeof r.assets === 'object' ? (r.assets as Record<string, string>) : {};
  const used = new Set<string>();
  // Stroke data saved with an asset store is in runs of JSON (`ChunkedList`): the lists come back first.
  const unchunked = inlineStrokeData(r, rawAssets, problems, used);
  // Extension fields saved externally refer to their PNGs as `asset:<id>`: put the data URLs back.
  const inlined: Record<string, unknown> = { ...unchunked };
  for (const key of Object.keys(unchunked)) if (!NO_EXTENSION_PNGS.has(key)) inlined[key] = inlinePngs(unchunked[key], rawAssets, problems, key, used);
  // A log saved with `strokes: 'replay'` refers to strokes kept on stroke layers.
  if (inlined.strokes !== undefined) inlined.strokes = resolveStrokeLog(inlined.strokes, inlined.liveStrokes, problems);
  return readDocument(inlined, Object.fromEntries(Object.entries(rawAssets).filter(([id]) => !used.has(id))), problems);
}

function readDocument(r: Record<string, unknown>, assets: Record<string, string>, problems: string[]): LoadedPaintDocument {
  const canvas = normalizeCanvas({ width: r.width as number, height: r.height as number, dpi: (r.dpi as number | undefined) ?? undefined });
  const paper = normalizePaper((r.paper as Record<string, unknown>) ?? {});
  const layers = paintLayersOnly(deserializeLayers(r.layers, { assets, problems }), problems);
  const wanted = typeof r.activeLayerId === 'string' ? r.activeLayerId : null;
  const activeLayerId = wanted && findLayer(layers, wanted) ? wanted : (flattenLayers(layers).filter((l) => l.type === 'pixel').pop()?.id ?? null);
  const wetEvents = Array.isArray(r.wetEvents) ? (r.wetEvents as WetEvent[]).filter((e) => e && typeof e === 'object' && Number.isInteger(e.clock) && typeof e.kind === 'string') : [];
  const state: PaintDocumentState = { canvas, paper, layers, activeLayerId, strokes: readStrokes(r.strokes, problems) };
  if (wetEvents.length) state.wetEvents = wetEvents;
  const paintEvents = Array.isArray(r.paintEvents) ? (r.paintEvents as PaintEvent[]).filter((e) => e && typeof e === 'object' && Number.isInteger(e.at) && typeof e.layerId === 'string' && ['fill', 'fill-region', 'clear', 'flatten', 'stickers', 'live-strokes', 'magnets', 'cure-ferrofluid', 'culture-grow'].includes(e.kind)) : [];
  if (paintEvents.length) state.paintEvents = paintEvents;
  if (r.cultures !== undefined) {
    const pixelIds = new Set(flattenLayers(layers).filter((l) => l.type === 'pixel').map((l) => l.id));
    const parsedCultures = culturesExtensionFromJSON(r.cultures, pixelIds, problems);
    if (parsedCultures.cultures) state.cultures = parsedCultures.cultures;
    if (parsedCultures.growWhileClosed !== undefined) state.growWhileClosed = parsedCultures.growWhileClosed;
    if (parsedCultures.lastGrownAt !== undefined) state.lastGrownAt = parsedCultures.lastGrownAt;
  }
  const o = r.origin as { x?: unknown; y?: unknown } | undefined;
  if (o && typeof o === 'object' && Number.isFinite(o.x) && Number.isFinite(o.y) && (o.x || o.y)) state.origin = { x: Math.round(o.x as number), y: Math.round(o.y as number) };
  return { state, extensions: documentExtensions(r), guides: r.guides, swatches: r.swatches, mixingPad: r.mixingPad, wet: r.wet, problems };
}

/** Reads a saved document whose assets may be external references in `store`. */
export async function deserializePaintDocumentAsync(raw: unknown, store?: PaintAssetStore): Promise<LoadedPaintDocument> {
  if (!raw || typeof raw !== 'object') throw new Error('Not a paint document: expected a JSON object.');
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  const refs = (r.assets as Record<string, string>) ?? {};
  const assets = await resolveExternalAssets(refs, store, problems);
  if (store) rememberStrokeChunks(refs, assets, store);
  const loaded = deserializePaintDocument({ ...r, assets });
  return { ...loaded, problems: [...problems, ...loaded.problems] };
}
