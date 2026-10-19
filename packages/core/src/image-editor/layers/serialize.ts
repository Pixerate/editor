/**
 * Schema version 3 of the image editor document: the layer tree, with pixel layers and painted
 * masks stored as PNG assets (cropped to their content and placed by position), plus the
 * document-level crop, transform, output opacity, migrated blur and selection.
 *
 * Encoding is synchronous and exact (see `png.ts`). Each surface's encoding is memoised, so
 * saving an unchanged layer again costs nothing.
 */

import { normalizeAdjustmentLayer } from '../adjustment-layers';
import { isBlendMode, normalizeBlendMode } from '../blend';
import { normalizeProcessVersion } from '../color';
import type { Annotation, CropBox, DepthMaskOptions, ImageTransform } from '../types';
import type { SerializedSelection } from '../selection/mask';
import { DEFAULT_DEPTH_MASK_VALUES } from './defaults';
import {
  newLayerId,
  type AdjustmentLayerNode,
  type GroupLayer,
  type ImageLayer,
  type LayerBase,
  type LayerFilter,
  type LayerLocks,
  type PixelLayer,
  type RasterMask,
} from './model';
import { base64ToBytes, bytesToBase64, decodePng, parseDataUrl, pngDataUrl } from '../../raster/png';
import { normalizeLayerEffects, type GlobalLight, type LayerEffect, type LayerEffects } from '../../raster/effects/model';
import { contentBounds, emptySurface, readRegion, surfaceFromPixels, type TiledSurface } from '../../raster/surface';

export const LAYERED_SCHEMA_VERSION = 3 as const;

/** A stored raster mask. Pixels: `asset` (grey PNG) placed at `x`, `y`; elsewhere `defaultValue`. */
export interface SerializedRasterMask {
  defaultValue: 0 | 255;
  asset?: string;
  x?: number;
  y?: number;
  density?: number;
  feather?: number;
  enabled?: boolean;
  source?: DepthMaskOptions;
}

interface SerializedLayerBase {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blend: string;
  clipped?: boolean;
  mask?: SerializedRasterMask;
  locks?: LayerLocks;
  effects?: SerializedLayerEffects;
}

/** A layer's effects: the effect list as JSON plus the PSD block they came from (base64). */
export interface SerializedLayerEffects {
  enabled: boolean;
  scale?: number;
  items: LayerEffect[];
  psd?: { key: string; data: string };
}

export interface SerializedPixelLayer extends SerializedLayerBase {
  type: 'pixel';
  /** Asset id of the pixels (RGBA PNG) placed at `x`, `y` in layer space; missing when empty. */
  asset?: string;
  x?: number;
  y?: number;
  offset: { x: number; y: number };
  fillOpacity?: number;
  filters?: LayerFilter[];
  /** `'document'`: the pixels are the document's source image (no asset is stored). */
  source?: 'document';
}

export interface SerializedAdjustmentLayer extends SerializedLayerBase {
  type: 'adjustment';
  kind: string;
  params: unknown;
}

export interface SerializedGroupLayer extends SerializedLayerBase {
  type: 'group';
  children: SerializedLayer[];
  collapsed?: boolean;
}

export interface SerializedAnnotationLayer extends SerializedLayerBase {
  type: 'annotation';
  annotation: Annotation;
}

export type SerializedLayer = SerializedPixelLayer | SerializedAdjustmentLayer | SerializedGroupLayer | SerializedAnnotationLayer;

/** A version 3 document (layers). */
export interface SerializedLayeredImageEditorState {
  version: 3;
  /** Canvas size in pixels. */
  width: number;
  height: number;
  /** Bottom to top. */
  layers: SerializedLayer[];
  /** Asset id → PNG data URL (or an external reference, see `ImageEditorAssetStore`). */
  assets: Record<string, string>;
  activeLayerId: string | null;
  crop: CropBox | null;
  transform: ImageTransform;
  /** Export alpha, 0..1. */
  opacity: number;
  /** Blur migrated from a v1 / v2 document with adjustment layers (runs after the layers). */
  legacyOutputBlur?: number;
  selection?: SerializedSelection;
  /** Global light for layer effects (missing = 120°, 30°). */
  globalLight?: GlobalLight;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

interface EncodedSurface {
  url: string;
  x: number;
  y: number;
}

const encodedCache = new WeakMap<TiledSurface, EncodedSurface | null>();

/** The surface's content (non-default pixels) as a PNG data URL and its position, or `null`. */
export function encodeSurface(surface: TiledSurface): EncodedSurface | null {
  if (encodedCache.has(surface)) return encodedCache.get(surface)!;
  const b = contentBounds(surface);
  let out: EncodedSurface | null = null;
  if (b) {
    const data = readRegion(surface, b);
    out = { url: pngDataUrl(b.width, b.height, data, surface.channels), x: b.x, y: b.y };
  }
  encodedCache.set(surface, out);
  return out;
}

export interface SerializeContext {
  /** Adds an asset and returns its id. */
  addAsset(url: string, hint: string): string;
}

function baseFields(layer: ImageLayer, ctx: SerializeContext): SerializedLayerBase {
  const out: SerializedLayerBase = {
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    blend: layer.blend,
  };
  if (layer.clipped) out.clipped = true;
  if (layer.mask) out.mask = serializeMask(layer.mask, `${layer.id}-mask`, ctx);
  if (layer.locks && Object.values(layer.locks).some(Boolean)) out.locks = { ...layer.locks };
  if (layer.effects) out.effects = serializeEffects(layer.effects);
  return out;
}

export function serializeEffects(effects: LayerEffects): SerializedLayerEffects {
  const out: SerializedLayerEffects = { enabled: effects.enabled, items: JSON.parse(JSON.stringify(effects.items)) };
  if (effects.scale !== undefined && effects.scale !== 1) out.scale = effects.scale;
  if (effects.psd) out.psd = { key: effects.psd.key, data: bytesToBase64(effects.psd.data) };
  return out;
}

/** Reads stored effects (leniently: broken effects are dropped), or `undefined`. */
export function deserializeEffects(raw: unknown): LayerEffects | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  let psd: { key: string; data: Uint8Array } | undefined;
  const p = r.psd as Record<string, unknown> | undefined;
  if (p && typeof p.key === 'string' && typeof p.data === 'string') {
    try {
      psd = { key: p.key, data: base64ToBytes(p.data) };
    } catch {
      psd = undefined;
    }
  }
  return normalizeLayerEffects({ ...r, psd });
}

function serializeMask(mask: RasterMask, hint: string, ctx: SerializeContext): SerializedRasterMask {
  const out: SerializedRasterMask = { defaultValue: mask.defaultValue };
  if (!mask.source) {
    const enc = encodeSurface(mask.surface);
    if (enc) {
      out.asset = ctx.addAsset(enc.url, hint);
      out.x = enc.x;
      out.y = enc.y;
    }
  } else {
    out.source = { ...mask.source, depthRange: [...mask.source.depthRange] as [number, number] };
  }
  if (mask.density !== undefined && mask.density !== 1) out.density = mask.density;
  if (mask.feather) out.feather = mask.feather;
  if (mask.enabled === false) out.enabled = false;
  return out;
}

export function serializeLayer(layer: ImageLayer, ctx: SerializeContext): SerializedLayer {
  const base = baseFields(layer, ctx);
  switch (layer.type) {
    case 'pixel': {
      const out: SerializedPixelLayer = { ...base, type: 'pixel', offset: { ...layer.offset } };
      if (layer.source === 'document') out.source = 'document';
      else {
        const enc = encodeSurface(layer.surface);
        if (enc) {
          out.asset = ctx.addAsset(enc.url, layer.id);
          out.x = enc.x;
          out.y = enc.y;
        }
      }
      if (layer.fillOpacity !== undefined && layer.fillOpacity !== 1) out.fillOpacity = layer.fillOpacity;
      if (layer.filters?.length) out.filters = JSON.parse(JSON.stringify(layer.filters));
      return out;
    }
    case 'adjustment':
      return { ...base, type: 'adjustment', kind: layer.kind, params: JSON.parse(JSON.stringify(layer.params)) };
    case 'group': {
      const out: SerializedGroupLayer = { ...base, type: 'group', children: layer.children.map((c) => serializeLayer(c, ctx)) };
      if (layer.collapsed) out.collapsed = true;
      return out;
    }
    case 'annotation':
      return { ...base, type: 'annotation', annotation: JSON.parse(JSON.stringify(layer.annotation)) };
  }
}

/** Serializes a layer tree with inline assets (asset ids are derived from layer ids). */
export function serializeLayers(layers: readonly ImageLayer[]): { layers: SerializedLayer[]; assets: Record<string, string> } {
  const assets: Record<string, string> = {};
  const ctx: SerializeContext = {
    addAsset(url, hint) {
      let id = hint;
      for (let n = 2; id in assets && assets[id] !== url; n++) id = `${hint}-${n}`;
      assets[id] = url;
      return id;
    },
  };
  return { layers: layers.map((l) => serializeLayer(l, ctx)), assets };
}

// ---------------------------------------------------------------------------
// External assets
// ---------------------------------------------------------------------------

/**
 * Where a host keeps layer pixels outside the JSON (`toJSON({ assets: 'external', store })`):
 * `put` stores a PNG and returns a reference (a URL, a key) that `get` resolves later.
 */
export interface ImageEditorAssetStore {
  put(blob: Blob, info: { id: string; width: number; height: number }): Promise<string>;
  get(ref: string): Promise<Blob>;
}

const externalRefs = new WeakMap<ImageEditorAssetStore, Map<string, string>>();

/**
 * Serializes a layer tree with its assets in `store`: each PNG is uploaded once per store (by
 * content), and `assets` maps asset ids to the store's references.
 */
export async function serializeLayersExternal(
  layers: readonly ImageLayer[],
  store: ImageEditorAssetStore
): Promise<{ layers: SerializedLayer[]; assets: Record<string, string> }> {
  const inline = serializeLayers(layers);
  let refs = externalRefs.get(store);
  if (!refs) {
    refs = new Map();
    externalRefs.set(store, refs);
  }
  const assets: Record<string, string> = {};
  for (const [id, url] of Object.entries(inline.assets)) {
    let ref = refs.get(url);
    if (!ref) {
      const parsed = parseDataUrl(url)!;
      const png = decodePngHeader(parsed.bytes);
      ref = await store.put(new Blob([parsed.bytes as BlobPart], { type: 'image/png' }), { id, width: png.width, height: png.height });
      if (typeof ref !== 'string' || !ref) throw new Error(`The asset store returned no reference for "${id}".`);
      refs.set(url, ref);
    }
    assets[id] = ref;
  }
  return { layers: inline.layers, assets };
}

/** Width and height from a PNG's header. */
function decodePngHeader(bytes: Uint8Array): { width: number; height: number } {
  const u32 = (o: number) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  return { width: u32(16), height: u32(20) };
}

/**
 * Turns external asset references back into data URLs through `store.get` (data URLs pass through),
 * so the document loads like an inline one. References that fail are reported and left out.
 */
export async function resolveExternalAssets(
  assets: Record<string, string>,
  store: ImageEditorAssetStore | undefined,
  problems: string[]
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [id, ref] of Object.entries(assets)) {
    if (ref.startsWith('data:')) {
      out[id] = ref;
      continue;
    }
    if (!store) {
      problems.push(`Asset "${id}" is external (${ref}) and no asset store was given.`);
      continue;
    }
    try {
      const blob = await store.get(ref);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      out[id] = `data:image/png;base64,${bytesToBase64(bytes)}`;
    } catch (err) {
      problems.push(`Asset "${id}" (${ref}) could not be fetched: ${(err as Error).message}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface DeserializeContext {
  assets: Record<string, string>;
  /** Decodes an asset (PNG data URL by default). Throw for an unusable asset. */
  decodeAsset?(ref: string, channels: 1 | 4): { width: number; height: number; data: ArrayLike<number> };
  /** Problems found while reading (unknown kinds, broken assets); the rest still loads. */
  problems: string[];
}

/** Decodes a PNG data URL into pixels of `channels` bytes each. */
export function decodePngDataUrl(url: string, channels: 1 | 4): { width: number; height: number; data: Uint8ClampedArray } {
  const parsed = parseDataUrl(url);
  if (!parsed) throw new Error('Asset is not a data URL.');
  const png = decodePng(parsed.bytes, { keepGray: channels === 1 });
  if (png.channels === channels) return png;
  if (channels === 1) {
    // An RGBA PNG used as a mask: take its luminance (alpha-weighted).
    const out = new Uint8ClampedArray(png.width * png.height);
    for (let i = 0, p = 0; p < out.length; i += 4, p++) {
      out[p] = Math.round(((0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]) * png.data[i + 3]) / 255);
    }
    return { width: png.width, height: png.height, data: out };
  }
  const out = new Uint8ClampedArray(png.width * png.height * 4);
  for (let p = 0; p < png.width * png.height; p++) {
    out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = png.data[p];
    out[p * 4 + 3] = 255;
  }
  return { width: png.width, height: png.height, data: out };
}

const num = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

function readSurface(ref: unknown, x: unknown, y: unknown, channels: 1 | 4, defaultValue: number, ctx: DeserializeContext, what: string): TiledSurface {
  if (typeof ref !== 'string' || !ref) return emptySurface(channels, defaultValue);
  const url = ctx.assets[ref];
  if (typeof url !== 'string') {
    ctx.problems.push(`${what}: asset "${ref}" is missing`);
    return emptySurface(channels, defaultValue);
  }
  try {
    const px = (ctx.decodeAsset ?? decodePngDataUrl)(url, channels);
    return surfaceFromPixels(px, channels, Math.round(num(x, -1e7, 1e7, 0)), Math.round(num(y, -1e7, 1e7, 0)), defaultValue);
  } catch (err) {
    ctx.problems.push(`${what}: asset "${ref}" could not be decoded (${(err as Error).message})`);
    return emptySurface(channels, defaultValue);
  }
}

function readMask(raw: unknown, ctx: DeserializeContext, what: string): RasterMask | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const defaultValue: 0 | 255 = r.defaultValue === 255 ? 255 : 0;
  const mask: RasterMask = {
    surface: r.source ? emptySurface(1, 255) : readSurface(r.asset, r.x, r.y, 1, defaultValue, ctx, `${what} mask`),
    defaultValue: r.source ? 255 : defaultValue,
  };
  if (typeof r.density === 'number' && r.density !== 1) mask.density = num(r.density, 0, 1, 1);
  if (typeof r.feather === 'number' && r.feather > 0) mask.feather = num(r.feather, 0, 1000, 0);
  if (r.enabled === false) mask.enabled = false;
  if (r.source && typeof r.source === 'object') {
    const s = { ...DEFAULT_DEPTH_MASK_VALUES, ...(r.source as Partial<DepthMaskOptions>) };
    mask.source = { ...s, depthRange: [...s.depthRange] as [number, number] };
  }
  return mask;
}

function readFilters(raw: unknown): LayerFilter[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: LayerFilter[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const r = f as Record<string, unknown>;
    const id = typeof r.id === 'string' && r.id ? r.id : newLayerId('flt');
    const enabled = r.enabled !== false;
    if (r.kind === 'blur') out.push({ id, kind: 'blur', enabled, radius: num(r.radius, 0, 50, 0) });
    else if (r.kind === 'develop') {
      out.push({
        id,
        kind: 'develop',
        enabled,
        brightness: num(r.brightness, -100, 100, 0),
        contrast: num(r.contrast, -100, 100, 0),
        saturation: num(r.saturation, -100, 100, 0),
        exposure: num(r.exposure, -100, 100, 0),
        temperature: num(r.temperature, -100, 100, 0),
        tint: num(r.tint, -100, 100, 0),
        process: normalizeProcessVersion(r.process),
      });
    }
  }
  return out.length ? out : undefined;
}

export function deserializeLayer(raw: unknown, ctx: DeserializeContext): ImageLayer | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  const id = typeof r.id === 'string' && r.id ? r.id : newLayerId();
  const base: LayerBase = {
    id,
    name: typeof r.name === 'string' ? r.name : '',
    visible: r.visible !== false,
    opacity: num(r.opacity, 0, 1, 1),
    blend: normalizeBlendMode(r.blend),
  };
  if (r.clipped === true) base.clipped = true;
  const mask = readMask(r.mask, ctx, `Layer "${base.name || id}"`);
  if (mask) base.mask = mask;
  if (r.locks && typeof r.locks === 'object') {
    const locks: LayerLocks = {};
    for (const k of ['pixels', 'transparency', 'position', 'all'] as const) if (r.locks[k] === true) locks[k] = true;
    if (Object.keys(locks).length) base.locks = locks;
  }
  const effects = deserializeEffects(r.effects);
  if (effects && r.type !== 'adjustment') base.effects = effects;
  switch (r.type) {
    case 'pixel': {
      const layer: PixelLayer = {
        ...base,
        type: 'pixel',
        surface: r.source === 'document' ? emptySurface(4) : readSurface(r.asset, r.x, r.y, 4, 0, ctx, `Layer "${base.name || id}"`),
        offset: { x: Math.round(num(r.offset?.x, -1e7, 1e7, 0)), y: Math.round(num(r.offset?.y, -1e7, 1e7, 0)) },
      };
      if (r.source === 'document') layer.source = 'document';
      if (typeof r.fillOpacity === 'number' && r.fillOpacity !== 1) layer.fillOpacity = num(r.fillOpacity, 0, 1, 1);
      const filters = readFilters(r.filters);
      if (filters) layer.filters = filters;
      return layer;
    }
    case 'adjustment': {
      const norm = normalizeAdjustmentLayer({ id, kind: r.kind, params: r.params });
      if (!norm) {
        ctx.problems.push(`Layer "${base.name || id}": unknown adjustment kind "${r.kind}"`);
        return null;
      }
      return { ...base, type: 'adjustment', kind: norm.kind, params: norm.params } as AdjustmentLayerNode;
    }
    case 'group': {
      const children = Array.isArray(r.children) ? r.children.map((c: unknown) => deserializeLayer(c, ctx)).filter(Boolean) : [];
      const blend = r.blend === 'pass-through' ? 'pass-through' : isBlendMode(r.blend) ? r.blend : 'pass-through';
      const group: GroupLayer = { ...base, type: 'group', blend, children: children as ImageLayer[] };
      if (r.collapsed === true) group.collapsed = true;
      return group;
    }
    case 'annotation': {
      const a = r.annotation;
      if (!a || typeof a !== 'object' || typeof a.type !== 'string') {
        ctx.problems.push(`Layer "${base.name || id}": annotation is missing`);
        return null;
      }
      return { ...base, type: 'annotation', annotation: JSON.parse(JSON.stringify({ ...a, id: typeof a.id === 'string' ? a.id : id })) };
    }
    default:
      ctx.problems.push(`Layer "${base.name || id}": unknown layer type "${r.type}"`);
      return null;
  }
}

/** Reads a stored layer tree (layers that cannot be read are dropped and reported). */
export function deserializeLayers(raw: unknown, ctx: DeserializeContext): ImageLayer[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const dedupe = (list: ImageLayer[]): ImageLayer[] =>
    list.map((l) => {
      let next = l;
      if (seen.has(l.id)) next = { ...l, id: newLayerId() } as ImageLayer;
      seen.add(next.id);
      if (next.type === 'group') next = { ...next, children: dedupe(next.children) };
      return next;
    });
  return dedupe(raw.map((l) => deserializeLayer(l, ctx)).filter(Boolean) as ImageLayer[]);
}
