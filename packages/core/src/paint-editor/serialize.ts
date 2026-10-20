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
import { normalizeBrushStroke, type RecordedStroke } from './strokes';
import { normalizeCanvas, type PaintDocumentState, type PaintEvent, type PaintLayer } from './document';
import { normalizePaper, type PaperSettings } from './paper';
import type { WetEvent } from './wet';

export const PAINT_FORMAT = 'pixerate-paint' as const;
export const PAINT_SCHEMA_VERSION = 1 as const;

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
  /** Recorded strokes (strokes are data), oldest first; missing when saved without them. */
  strokes?: RecordedStroke[];
  /** Everything else (document-level state of later phases), written back as read. */
  [extension: string]: unknown;
}

const KNOWN = new Set(['format', 'version', 'width', 'height', 'dpi', 'paper', 'layers', 'assets', 'activeLayerId', 'strokes', 'guides', 'swatches', 'mixingPad', 'wet', 'wetEvents', 'paintEvents']);

/** Fields of a saved document this version does not read, kept for writing back. */
export function documentExtensions(raw: Record<string, unknown>): PaintDocumentExtensions {
  const out: PaintDocumentExtensions = {};
  for (const [k, v] of Object.entries(raw)) if (!KNOWN.has(k)) out[k] = v;
  return out;
}

export interface SerializeOptions {
  /** Include the recorded strokes (default true). */
  strokes?: boolean;
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
  if (options.strokes !== false && state.strokes.length) out.strokes = JSON.parse(JSON.stringify(state.strokes));
  if (options.guides !== undefined) out.guides = JSON.parse(JSON.stringify(options.guides));
  if (options.swatches !== undefined) out.swatches = JSON.parse(JSON.stringify(options.swatches));
  if (options.mixingPad !== undefined) (out as Record<string, unknown>).mixingPad = JSON.parse(JSON.stringify(options.mixingPad));
  if (options.wet !== undefined) (out as Record<string, unknown>).wet = JSON.parse(JSON.stringify(options.wet));
  if (state.wetEvents?.length) (out as Record<string, unknown>).wetEvents = JSON.parse(JSON.stringify(state.wetEvents));
  if (state.paintEvents?.length) (out as Record<string, unknown>).paintEvents = JSON.parse(JSON.stringify(state.paintEvents));
  return out;
}

/** The document as JSON with inline PNG data URLs. */
export function serializePaintDocument(state: PaintDocumentState, options: SerializeOptions = {}): SerializedPaintDocument {
  const { layers, assets } = serializeLayers(state.layers as unknown as ImageLayer[]);
  return { ...header(state, options), layers, assets } as SerializedPaintDocument;
}

/** The document as JSON with each PNG uploaded to `store` once (by content). */
export async function serializePaintDocumentExternal(state: PaintDocumentState, store: PaintAssetStore, options: SerializeOptions = {}): Promise<SerializedPaintDocument> {
  const { layers, assets } = await serializeLayersExternal(state.layers as unknown as ImageLayer[], store);
  return { ...header(state, options), layers, assets } as SerializedPaintDocument;
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

function readStrokes(raw: unknown, problems: string[]): RecordedStroke[] {
  if (!Array.isArray(raw)) return [];
  const out: RecordedStroke[] = [];
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
  const canvas = normalizeCanvas({ width: r.width as number, height: r.height as number, dpi: (r.dpi as number | undefined) ?? undefined });
  const paper = normalizePaper((r.paper as Record<string, unknown>) ?? {});
  const assets = r.assets && typeof r.assets === 'object' ? (r.assets as Record<string, string>) : {};
  const layers = paintLayersOnly(deserializeLayers(r.layers, { assets, problems }), problems);
  const wanted = typeof r.activeLayerId === 'string' ? r.activeLayerId : null;
  const activeLayerId = wanted && findLayer(layers, wanted) ? wanted : (flattenLayers(layers).filter((l) => l.type === 'pixel').pop()?.id ?? null);
  const wetEvents = Array.isArray(r.wetEvents) ? (r.wetEvents as WetEvent[]).filter((e) => e && typeof e === 'object' && Number.isInteger(e.clock) && typeof e.kind === 'string') : [];
  const state: PaintDocumentState = { canvas, paper, layers, activeLayerId, strokes: readStrokes(r.strokes, problems) };
  if (wetEvents.length) state.wetEvents = wetEvents;
  const paintEvents = Array.isArray(r.paintEvents) ? (r.paintEvents as PaintEvent[]).filter((e) => e && typeof e === 'object' && Number.isInteger(e.at) && typeof e.layerId === 'string' && ['fill', 'clear', 'flatten', 'stickers'].includes(e.kind)) : [];
  if (paintEvents.length) state.paintEvents = paintEvents;
  return { state, extensions: documentExtensions(r), guides: r.guides, swatches: r.swatches, mixingPad: r.mixingPad, wet: r.wet, problems };
}

/** Reads a saved document whose assets may be external references in `store`. */
export async function deserializePaintDocumentAsync(raw: unknown, store?: PaintAssetStore): Promise<LoadedPaintDocument> {
  if (!raw || typeof raw !== 'object') throw new Error('Not a paint document: expected a JSON object.');
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  const assets = await resolveExternalAssets((r.assets as Record<string, string>) ?? {}, store, problems);
  const loaded = deserializePaintDocument({ ...r, assets });
  return { ...loaded, problems: [...problems, ...loaded.problems] };
}
