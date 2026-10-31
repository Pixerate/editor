/**
 * Schema version 3 of the image editor document: the layer tree, with pixel layers and painted
 * masks stored as PNG assets (cropped to their content and placed by position), plus the
 * document-level crop, transform, output opacity, migrated blur and selection.
 *
 * Encoding is synchronous and exact (see `png.ts`). Each surface's encoding is memoised, so
 * saving an unchanged layer again costs nothing.
 */

import type { LayerEdgeColor } from '../../raster/layers';
import { validVectorMaskEdges } from './hybrid-mask';
import type { SerializedDocumentPath } from '../paths';
import { normalizeAdjustmentLayer } from '../adjustment-layers';
import { isBlendMode, normalizeBlendMode } from '../blend';
import { normalizeProcessVersion } from '../color';
import type { Annotation, CropBox, DepthMaskOptions, ImageTransform } from '../types';
import type { EffectValue } from '../../effects/types';
import type { SerializedSelection } from '../selection/mask';
import type { SerializedAlphaChannel } from '../selection/channels';
import { DEFAULT_DEPTH_MASK_VALUES } from './defaults';
import type { SerializedColorMode, SerializedColorProfile } from '../color-management';
import {
  MAX_EFFECT_ANIMATION_MS,
  newLayerId,
  type PsdSmartFilter,
  type EffectSmartFilter,
  type ImageEffectGenerator,
  type SmartContents,
  type SmartFilter,
  type SmartFilterStack,
  type SmartObjectLayer,
  type SmartPlacement,
  type AdjustmentLayerNode,
  type GroupLayer,
  type ImageLayer,
  type LayerBase,
  type LayerFilter,
  type LayerLocks,
  type PixelLayer,
  type RasterMask,
  type ShapeComponent,
  type VectorMask,
  type VectorMaskEdge,
  type ShapeLayer,
  type ShapePaint,
  type ShapeStroke,
  type ParagraphRun,
  type TextRun,
  type TypeLayer,
} from './model';
import { base64ToBytes, bytesToBase64, decodePng, parseDataUrl, pngDataUrl } from '../../raster/png';
import { normalizeLayerEffects, type GlobalLight, type LayerEffect, type LayerEffects } from '../../raster/effects/model';
import type { EffectPattern } from '../../raster/effects/patterns';
import { contentBounds, emptySurface, readRegion, surfaceFromPixels, type TiledSurface } from '../../raster/surface';
import { readDeepRegion, surfaceDepth, writeDeepRegion } from '../../raster/deep';
import { deflate, inflate } from '../../raster/zlib';
import { isInterpolation } from '../../raster/transform';
import { isValidWarpMesh } from '../../geom/warp';
import type { Quad, WarpMesh } from '../../geom/types';
import { normalizePlacement, renderSmartObject } from './smart';
import { annotationLayerFor } from './migrate';
import { DEFAULT_TEXT_STYLE, createTypeLayer, fitParagraphRuns, fitRuns, normalizeText, patchParagraphStyle, patchTextStyle, rerenderText, type TextEnv } from './text';
import { createShapeLayer, liveShapeSubpaths, normalizeLiveShape, normalizeShapePaint, normalizeShapeStroke, normalizeSubpaths, requireOperation, shapeFromAnnotation } from './shape';

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
  /** `false`: unlinked from the layer's pixels. */
  linked?: boolean;
  source?: DepthMaskOptions;
  /** 16- or 32-bit coverage (one sample per pixel; the PNG asset is its 8-bit rendering). */
  deep?: SerializedDeepPixels;
}

interface SerializedLayerBase {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blend: string;
  clipped?: boolean;
  mask?: SerializedRasterMask;
  vectorMask?: SerializedVectorMask;
  locks?: LayerLocks;
  effects?: SerializedLayerEffects;
  /** Edge colour amounts 0..1 and the cast colour (see `LayerEdgeColor`). */
  edge?: LayerEdgeColor;
}

/** A stored vector mask: its components as JSON (document pixels) and its properties. */
export interface SerializedVectorMask {
  components: unknown[];
  fillRule?: 'evenodd';
  inverted?: true;
  enabled?: false;
  linked?: false;
  density?: number;
  feather?: number;
  /** Hybrid mask: soft edge modes per segment. */
  edges?: unknown[];
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
  /** An effect layer's provider effect (its pixels are stored as usual). */
  generator?: ImageEffectGenerator;
  /** 16- or 32-bit samples of the pixels (the PNG asset is their 8-bit rendering), see `raster/deep`. */
  deep?: SerializedDeepPixels;
}

/**
 * High bit depth pixels: `width × height` interleaved RGBA samples at (`x`, `y`) in layer space
 * (one coverage sample per pixel for a mask), little-endian (`Uint16` for 16-bit, `Float32`
 * linear light for 32-bit; coverage 0..1 for a mask), deflated and base64.
 */
export interface SerializedDeepPixels {
  depth: 16 | 32;
  x: number;
  y: number;
  width: number;
  height: number;
  data: string;
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

/** A smart filter as stored (a Photoshop filter keeps its descriptor as base64). */
export type SerializedSmartFilter = (LayerFilter | EffectSmartFilter | (Omit<PsdSmartFilter, 'data'> & { data: string })) & { blend: string; opacity: number };

export interface SerializedSmartObjectLayer extends SerializedLayerBase {
  type: 'smart';
  /** Id of its entry in the document's `smartContents` (shared by linked instances). */
  contents: string;
  placement: { corners: Array<{ x: number; y: number }>; warp?: WarpMesh; interpolation?: string };
  smartFilters?: { enabled: boolean; filters: SerializedSmartFilter[]; mask?: SerializedRasterMask };
  /** The rendered pixels (RGBA PNG) at `x`, `y` in document space, so a load does not re-render. */
  asset?: string;
  x?: number;
  y?: number;
  fillOpacity?: number;
  /** The PSD placed-layer block kept for round trips (base64). */
  psd?: { key: string; data: string; placed?: string };
}

/** Smart object contents as stored once per document, referenced by id from every instance. */
export interface SerializedSmartContents {
  id: string;
  name: string;
  width: number;
  height: number;
  kind: 'raster' | 'document';
  /** Raster contents: RGBA PNG asset at (0, 0). */
  asset?: string;
  /** Document contents: the nested layers (their assets are in the document's `assets`). */
  layers?: SerializedLayer[];
  globalLight?: GlobalLight;
  patterns?: SerializedPattern[];
  /** The file the contents came from (base64), written back while unedited. */
  file?: { type: string; data: string };
  linked?: { path: string };
}

/** A shape layer: its vector data (the pixels are rendered again on load). */
export interface SerializedShapeLayer extends SerializedLayerBase {
  type: 'shape';
  components: ShapeComponent[];
  fillRule?: 'evenodd';
  inverted?: true;
  fill: ShapePaint | null;
  stroke: ShapeStroke | null;
  fillOpacity?: number;
  /** The annotation the layer was migrated from, while it still is that annotation. */
  annotation?: Annotation;
  /** PSD blocks kept for round trips (base64). */
  psd?: { blocks: Array<{ key: string; data: string }>; signature?: string };
}

/** A type layer: its text and styles, plus the pixels it showed (PNG) for loads without its fonts. */
export interface SerializedTypeLayer extends SerializedLayerBase {
  type: 'type';
  text: string;
  runs: TextRun[];
  paragraphs: ParagraphRun[];
  frame: TypeLayer['frame'];
  /** Missing: horizontal. */
  orientation?: 'vertical';
  transform?: number[];
  antiAlias?: false;
  fillOpacity?: number;
  /** The rendered pixels (RGBA PNG) at `x`, `y` in document space. */
  asset?: string;
  x?: number;
  y?: number;
  missingFonts?: string[];
  /** The text annotation the layer was migrated from, while it still is that annotation. */
  annotation?: Annotation;
  /** PSD blocks kept for round trips (base64). */
  psd?: { tySh?: string; blocks?: Array<{ key: string; data: string }>; signature?: string };
}

export type SerializedLayer = SerializedPixelLayer | SerializedAdjustmentLayer | SerializedGroupLayer | SerializedAnnotationLayer | SerializedSmartObjectLayer | SerializedShapeLayer | SerializedTypeLayer;

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
  /** The selection's recipe (live selections): the steps that made it, as JSON. */
  selectionRecipe?: unknown[];
  /** Alpha channels (saved selections), run-length encoded. */
  channels?: SerializedAlphaChannel[];
  /** Document paths (the Paths panel). */
  paths?: SerializedDocumentPath[];
  /** Global light for layer effects (missing = 120°, 30°). */
  globalLight?: GlobalLight;
  /** The document's patterns for pattern effects, each an RGBA PNG data URL. */
  patterns?: SerializedPattern[];
  /** Contents of the smart objects (nested ones included), each stored once. */
  smartContents?: SerializedSmartContents[];
  /** The document's colour profile (missing = sRGB). */
  colorProfile?: SerializedColorProfile;
  /** Image › Mode CMYK or Lab (missing = RGB). */
  colorMode?: SerializedColorMode;
  /** Bits per channel (missing = 8). */
  bitDepth?: 16 | 32;
}

export interface SerializedPattern {
  id: string;
  name: string;
  png: string;
}

export function serializePatterns(patterns: readonly EffectPattern[]): SerializedPattern[] {
  return patterns.map((p) => ({ id: p.id, name: p.name, png: pngDataUrl(p.width, p.height, p.data) }));
}

/** Reads stored patterns, skipping (and reporting in `problems`) any that cannot be decoded. */
export function deserializePatterns(raw: unknown, problems: string[] = []): EffectPattern[] {
  if (!Array.isArray(raw)) return [];
  const out: EffectPattern[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.png !== 'string') continue;
    try {
      const png = decodePngDataUrl(p.png, 4);
      out.push({ id: p.id, name: typeof p.name === 'string' ? p.name : p.id, width: png.width, height: png.height, data: png.data });
    } catch (e) {
      problems.push(`Pattern "${p.name ?? p.id}" could not be decoded (${e instanceof Error ? e.message : String(e)}).`);
    }
  }
  return out;
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

const deepCache = new WeakMap<TiledSurface, SerializedDeepPixels | null>();

/** A surface's deep samples over its content, or `null` when it holds only 8-bit tiles. */
export function encodeDeepSurface(surface: TiledSurface): SerializedDeepPixels | null {
  if (deepCache.has(surface)) return deepCache.get(surface)!;
  let out: SerializedDeepPixels | null = null;
  const depth = surfaceDepth(surface);
  const b = depth === 8 ? null : contentBounds(surface);
  if (depth !== 8 && b) {
    const samples = readDeepRegion(surface, b, depth);
    const bytes = new Uint8Array(samples.byteLength);
    const view = new DataView(bytes.buffer);
    if (samples instanceof Uint16Array) for (let i = 0; i < samples.length; i++) view.setUint16(2 * i, samples[i], true);
    else for (let i = 0; i < samples.length; i++) view.setFloat32(4 * i, samples[i], true);
    out = { depth, x: b.x, y: b.y, width: b.width, height: b.height, data: bytesToBase64(deflate(bytes)) };
  }
  deepCache.set(surface, out);
  return out;
}

/** Puts serialized deep samples into `surface` (the 8-bit rendering read from the PNG); unreadable data leaves it 8-bit. */
export function decodeDeepSurface(surface: TiledSurface, raw: unknown, problems: string[], label: string): TiledSurface {
  const d = raw as SerializedDeepPixels;
  if (!d || typeof d !== 'object') return surface;
  try {
    if ((d.depth !== 16 && d.depth !== 32) || !(d.width > 0 && d.height > 0) || !Number.isInteger(d.x) || !Number.isInteger(d.y) || typeof d.data !== 'string') throw new Error('malformed');
    const n = d.width * d.height * surface.channels;
    const size = d.depth === 16 ? 2 : 4;
    const bytes = inflate(base64ToBytes(d.data), { maxOutput: n * size });
    if (bytes.length !== n * size) throw new Error('wrong length');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = d.depth === 16 ? new Uint16Array(n) : new Float32Array(n);
    if (samples instanceof Uint16Array) for (let i = 0; i < n; i++) samples[i] = view.getUint16(2 * i, true);
    else for (let i = 0; i < n; i++) samples[i] = view.getFloat32(4 * i, true);
    return writeDeepRegion(surface, { x: d.x, y: d.y, width: d.width, height: d.height }, samples);
  } catch {
    problems.push(`${label}: its ${d.depth}-bit samples could not be read, so it was opened at 8 bits`);
    return surface;
  }
}

export interface SerializeContext {
  /** Adds an asset and returns its id. */
  addAsset(url: string, hint: string): string;
  /** Stores a smart object's contents (once per id). Without it, smart objects cannot be written. */
  addContents?(contents: SmartContents): void;
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
  if (layer.vectorMask) out.vectorMask = serializeVectorMask(layer.vectorMask);
  if (layer.locks && Object.values(layer.locks).some(Boolean)) out.locks = { ...layer.locks };
  if (layer.effects) out.effects = serializeEffects(layer.effects);
  if (layer.edge) out.edge = { ...layer.edge, ...(layer.edge.ambientColor ? { ambientColor: [...layer.edge.ambientColor] as [number, number, number] } : {}) };
  return out;
}

/** Stored edge colour, with amounts clamped to 0..1 (none when nothing is on). */
export function readEdgeColor(raw: unknown): LayerEdgeColor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: LayerEdgeColor = {};
  for (const k of ['decontaminate', 'despill', 'ambient'] as const) {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = Math.min(1, v);
  }
  const c = r.ambientColor;
  if (Array.isArray(c) && c.length === 3 && c.every((v) => typeof v === 'number' && Number.isFinite(v))) out.ambientColor = c.map((v) => Math.min(255, Math.max(0, Math.round(v)))) as [number, number, number];
  return out.decontaminate || out.despill || out.ambient || out.ambientColor ? out : undefined;
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

function serializeVectorMask(vm: VectorMask): SerializedVectorMask {
  const out: SerializedVectorMask = { components: JSON.parse(JSON.stringify(vm.components)) };
  if (vm.fillRule === 'evenodd') out.fillRule = 'evenodd';
  if (vm.inverted) out.inverted = true;
  if (vm.enabled === false) out.enabled = false;
  if (vm.linked === false) out.linked = false;
  if (vm.density !== undefined && vm.density !== 1) out.density = vm.density;
  if (vm.feather) out.feather = vm.feather;
  if (vm.edges?.length) out.edges = vm.edges.map((e) => ({ ...e }));
  return out;
}

/** Restores stored shape components (a vector mask's or a document path's); throws on damaged ones. */
export function readShapeComponents(stored: unknown): ShapeComponent[] {
  if (!Array.isArray(stored)) throw new Error('its components are missing');
  return stored.map((raw, i) => {
    const c = raw as Record<string, unknown>;
    const op = requireOperation(c?.op, `components[${i}].op`);
    if (c?.live) {
      const live = normalizeLiveShape(c.live, `components[${i}].live`);
      return { op, subpaths: liveShapeSubpaths(live), live };
    }
    return { op, subpaths: Array.isArray(c?.subpaths) && !c.subpaths.length ? [] : normalizeSubpaths(c?.subpaths, `components[${i}].subpaths`) };
  });
}

/** Restores a stored vector mask; throws on damaged components. */
function readVectorMask(r: SerializedVectorMask): VectorMask {
  const vm: VectorMask = { components: readShapeComponents(r.components) };
  if (r.fillRule === 'evenodd') vm.fillRule = 'evenodd';
  if (r.inverted === true) vm.inverted = true;
  if (r.enabled === false) vm.enabled = false;
  if (r.linked === false) vm.linked = false;
  if (typeof r.density === 'number' && r.density !== 1) vm.density = num(r.density, 0, 1, 1);
  if (typeof r.feather === 'number' && r.feather > 0) vm.feather = num(r.feather, 0, 1000, 0);
  // Hybrid edges: well-formed soft ones on segments the path has (others are dropped).
  if (Array.isArray(r.edges)) {
    const edges: VectorMaskEdge[] = [];
    for (const raw of r.edges) {
      const e = raw as Record<string, unknown>;
      const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : -1);
      const at = { component: int(e?.component), subpath: int(e?.subpath), segment: int(e?.segment) };
      if (at.component < 0 || at.subpath < 0 || at.segment < 0) continue;
      if (e.mode === 'feather') edges.push({ ...at, mode: 'feather', radius: num(e.radius, 0.5, 250, 4) });
      else if (e.mode === 'matte') edges.push({ ...at, mode: 'matte', inner: num(e.inner, 0.5, 200, 4), outer: num(e.outer, 0.5, 200, 8) });
    }
    const valid = validVectorMaskEdges(edges, vm.components);
    if (valid.length) vm.edges = valid;
  }
  return vm;
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
    const deep = encodeDeepSurface(mask.surface);
    if (deep) out.deep = deep;
  } else {
    out.source = { ...mask.source, depthRange: [...mask.source.depthRange] as [number, number] };
  }
  if (mask.density !== undefined && mask.density !== 1) out.density = mask.density;
  if (mask.feather) out.feather = mask.feather;
  if (mask.enabled === false) out.enabled = false;
  if (mask.linked === false) out.linked = false;
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
      if (layer.generator) out.generator = JSON.parse(JSON.stringify(layer.generator));
      if (layer.source !== 'document') {
        const deep = encodeDeepSurface(layer.surface);
        if (deep) out.deep = deep;
      }
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
    case 'smart':
      return serializeSmartObject(layer, base, ctx);
    case 'shape':
      return serializeShape(layer, base);
    case 'type':
      return serializeType(layer, base, ctx);
  }
}

function serializeType(layer: TypeLayer, base: SerializedLayerBase, ctx: SerializeContext): SerializedTypeLayer {
  const out: SerializedTypeLayer = {
    ...base,
    type: 'type',
    text: layer.text,
    runs: JSON.parse(JSON.stringify(layer.runs)),
    paragraphs: JSON.parse(JSON.stringify(layer.paragraphs)),
    frame: { ...layer.frame },
  };
  if (layer.orientation === 'vertical') out.orientation = 'vertical';
  if (layer.transform) out.transform = [...layer.transform];
  if (layer.antiAlias === false) out.antiAlias = false;
  if (layer.fillOpacity !== undefined && layer.fillOpacity !== 1) out.fillOpacity = layer.fillOpacity;
  const enc = encodeSurface(layer.surface);
  if (enc) {
    out.asset = ctx.addAsset(enc.url, layer.id);
    out.x = enc.x;
    out.y = enc.y;
  }
  if (layer.missingFonts?.length) out.missingFonts = [...layer.missingFonts];
  if (layer.annotation) out.annotation = JSON.parse(JSON.stringify(layer.annotation));
  if (layer.psd?.tySh || layer.psd?.blocks?.length) {
    out.psd = {};
    if (layer.psd.tySh) out.psd.tySh = bytesToBase64(layer.psd.tySh);
    if (layer.psd.blocks?.length) out.psd.blocks = layer.psd.blocks.map((b) => ({ key: b.key, data: bytesToBase64(b.data) }));
    if (layer.psd.signature) out.psd.signature = layer.psd.signature;
  }
  return out;
}

/** Reads a stored type layer: its stored pixels when there are any, else drawn with the shaper (if any). */
function readType(r: Record<string, any>, base: LayerBase, ctx: DeserializeContext): ImageLayer | null {
  const label = `Layer "${base.name || base.id}"`;
  try {
    const text = normalizeText(r.text ?? '');
    const runs: TextRun[] = (Array.isArray(r.runs) ? r.runs : []).map((run: any, i: number) => ({
      length: Math.max(0, Math.floor(num(run?.length, 0, 1e9, 0))),
      style: patchTextStyle(DEFAULT_TEXT_STYLE, run?.style && typeof run.style === 'object' ? run.style : {}, `runs[${i}].style`),
    }));
    const paragraphs: ParagraphRun[] = (Array.isArray(r.paragraphs) ? r.paragraphs : []).map((p: any, i: number) => ({
      length: Math.max(0, Math.floor(num(p?.length, 0, 1e9, 0))),
      style: patchParagraphStyle({}, p?.style && typeof p.style === 'object' ? p.style : {}, `paragraphs[${i}].style`),
    }));
    const f = r.frame;
    const frame: TypeLayer['frame'] =
      f?.kind === 'box'
        ? { kind: 'box', width: num(f.width, 1, 1e6, 100), height: num(f.height, 1, 1e6, 100) }
        : f?.origin === 'top'
          ? { kind: 'point', origin: 'top' }
          : { kind: 'point' };
    const m = Array.isArray(r.transform) && r.transform.length === 6 && r.transform.every((v: unknown) => typeof v === 'number' && Number.isFinite(v)) ? (r.transform as unknown as TypeLayer['transform']) : undefined;
    const layer: TypeLayer = {
      ...base,
      type: 'type',
      text,
      runs: fitRuns(runs, text.length, DEFAULT_TEXT_STYLE),
      paragraphs: fitParagraphRuns(paragraphs.length ? paragraphs : [{ length: text.length, style: {} }], text),
      frame,
      surface: emptySurface(4),
      offset: { x: 0, y: 0 },
    };
    if (!layer.runs.length) layer.runs = [{ length: 0, style: runs[0]?.style ?? DEFAULT_TEXT_STYLE }];
    if (m) layer.transform = m;
    if (r.orientation === 'vertical') layer.orientation = 'vertical';
    if (r.antiAlias === false) layer.antiAlias = false;
    if (typeof r.fillOpacity === 'number' && r.fillOpacity !== 1) layer.fillOpacity = num(r.fillOpacity, 0, 1, 1);
    if (Array.isArray(r.missingFonts)) layer.missingFonts = r.missingFonts.filter((x: unknown) => typeof x === 'string');
    if (r.annotation && typeof r.annotation === 'object' && r.annotation.type === 'text') layer.annotation = JSON.parse(JSON.stringify({ ...r.annotation, id: r.annotation.id ?? base.id }));
    if (r.psd && typeof r.psd === 'object') {
      const psd: NonNullable<TypeLayer['psd']> = {};
      if (typeof r.psd.tySh === 'string') psd.tySh = base64ToBytes(r.psd.tySh);
      if (Array.isArray(r.psd.blocks)) psd.blocks = r.psd.blocks.filter((b: any) => b && typeof b.key === 'string' && typeof b.data === 'string').map((b: any) => ({ key: b.key, data: base64ToBytes(b.data) }));
      if (typeof r.psd.signature === 'string') psd.signature = r.psd.signature;
      if (psd.tySh || psd.blocks?.length) layer.psd = psd;
    }
    if (typeof r.asset === 'string') return { ...layer, surface: readSurface(r.asset, r.x, r.y, 4, 0, ctx, label), rendering: 'stored' };
    const env: TextEnv = { ...(ctx.canvas ?? { width: 1, height: 1 }), shaper: ctx.text?.shaper ?? null, createCanvas: ctx.text?.createCanvas };
    try {
      return rerenderText(layer, env);
    } catch {
      return { ...layer, rendering: 'stored' };
    }
  } catch (e) {
    ctx.problems.push(`${label}: the text could not be read (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

function serializeShape(layer: ShapeLayer, base: SerializedLayerBase): SerializedShapeLayer {
  const out: SerializedShapeLayer = {
    ...base,
    type: 'shape',
    components: JSON.parse(JSON.stringify(layer.components)),
    fill: layer.fill ? JSON.parse(JSON.stringify(layer.fill)) : null,
    stroke: layer.stroke ? JSON.parse(JSON.stringify(layer.stroke)) : null,
  };
  if (layer.fillRule === 'evenodd') out.fillRule = 'evenodd';
  if (layer.inverted) out.inverted = true;
  if (layer.fillOpacity !== undefined && layer.fillOpacity !== 1) out.fillOpacity = layer.fillOpacity;
  if (layer.annotation) out.annotation = JSON.parse(JSON.stringify(layer.annotation));
  if (layer.psd?.blocks?.length) out.psd = { blocks: layer.psd.blocks.map((b) => ({ key: b.key, data: bytesToBase64(b.data) })), ...(layer.psd.signature ? { signature: layer.psd.signature } : {}) };
  return out;
}

/** Reads a stored shape layer, validating every part (a broken shape is dropped and reported). */
function readShape(r: Record<string, any>, base: LayerBase, ctx: DeserializeContext): ImageLayer | null {
  const label = `Layer "${base.name || base.id}"`;
  const canvas = ctx.canvas ?? { width: 1, height: 1 };
  const env = { ...canvas, pattern: ctx.pattern };
  try {
    let data: Pick<ShapeLayer, 'components' | 'fill' | 'stroke'> | null = null;
    const a = r.annotation && typeof r.annotation === 'object' && typeof r.annotation.type === 'string' ? (JSON.parse(JSON.stringify({ ...r.annotation, id: r.annotation.id ?? base.id })) as Annotation) : undefined;
    if (a) data = shapeFromAnnotation(a);
    if (!data) {
      if (!Array.isArray(r.components) || !r.components.length) throw new Error('it has no components');
      const components: ShapeComponent[] = r.components.map((c: Record<string, unknown>, i: number) => {
        const op = requireOperation(c?.op, `components[${i}].op`);
        if (c?.live) {
          const live = normalizeLiveShape(c.live, `components[${i}].live`);
          return { op, subpaths: liveShapeSubpaths(live), live };
        }
        return { op, subpaths: Array.isArray(c?.subpaths) && !c.subpaths.length ? [] : normalizeSubpaths(c?.subpaths, `components[${i}].subpaths`) };
      });
      data = {
        components,
        fill: r.fill === null || r.fill === undefined ? null : normalizeShapePaint(r.fill, 'fill'),
        stroke: r.stroke === null || r.stroke === undefined ? null : normalizeShapeStroke(r.stroke, 'stroke'),
      };
    }
    const layer = createShapeLayer({ ...data, fillRule: r.fillRule === 'evenodd' ? 'evenodd' : 'nonzero', inverted: r.inverted === true && !a }, env, base.id);
    const out: ShapeLayer = { ...layer, ...base, type: 'shape', components: layer.components, fill: layer.fill, stroke: layer.stroke, surface: layer.surface, offset: { x: 0, y: 0 } };
    if (typeof r.fillOpacity === 'number' && r.fillOpacity !== 1) out.fillOpacity = num(r.fillOpacity, 0, 1, 1);
    if (a && shapeFromAnnotation(a)) out.annotation = a;
    if (r.psd && Array.isArray(r.psd.blocks)) {
      const blocks = r.psd.blocks.filter((b: any) => b && typeof b.key === 'string' && typeof b.data === 'string').map((b: any) => ({ key: b.key, data: base64ToBytes(b.data) }));
      if (blocks.length) out.psd = { blocks };
      if (out.psd && typeof r.psd.signature === 'string') out.psd.signature = r.psd.signature;
    }
    return out;
  } catch (e) {
    ctx.problems.push(`${label}: the shape could not be read (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
}

function serializeSmartFilters(stack: SmartFilterStack, layerId: string, ctx: SerializeContext): NonNullable<SerializedSmartObjectLayer['smartFilters']> {
  const out: NonNullable<SerializedSmartObjectLayer['smartFilters']> = {
    enabled: stack.enabled,
    filters: stack.filters.map((f) => (f.kind === 'psd' ? { ...f, data: bytesToBase64(f.data) } : JSON.parse(JSON.stringify(f)))),
  };
  if (stack.mask) out.mask = serializeMask(stack.mask, `${layerId}-filter-mask`, ctx);
  return out;
}

function serializeSmartObject(layer: SmartObjectLayer, base: SerializedLayerBase, ctx: SerializeContext): SerializedSmartObjectLayer {
  if (!ctx.addContents) throw new Error('Smart objects need a contents table to be written.');
  ctx.addContents(layer.contents);
  const p = layer.placement;
  const out: SerializedSmartObjectLayer = {
    ...base,
    type: 'smart',
    contents: layer.contents.id,
    placement: { corners: p.corners.map((c) => ({ x: c.x, y: c.y })) },
  };
  if (p.warp) out.placement.warp = JSON.parse(JSON.stringify(p.warp));
  if (p.interpolation && p.interpolation !== 'bicubic') out.placement.interpolation = p.interpolation;
  if (layer.smartFilters) out.smartFilters = serializeSmartFilters(layer.smartFilters, layer.id, ctx);
  const enc = encodeSurface(layer.surface);
  if (enc) {
    out.asset = ctx.addAsset(enc.url, layer.id);
    out.x = enc.x;
    out.y = enc.y;
  }
  if (layer.fillOpacity !== undefined && layer.fillOpacity !== 1) out.fillOpacity = layer.fillOpacity;
  if (layer.psd) {
    out.psd = { key: layer.psd.key, data: bytesToBase64(layer.psd.data) };
    if (layer.psd.placed) out.psd.placed = layer.psd.placed;
  }
  return out;
}

/** Writes one contents entry (nested layers add their own assets and contents to `ctx`). */
export function serializeContents(c: SmartContents, ctx: SerializeContext): SerializedSmartContents {
  const out: SerializedSmartContents = { id: c.id, name: c.name, width: c.width, height: c.height, kind: c.kind };
  if (c.kind === 'raster' && c.raster) {
    const enc = encodeSurface(c.raster);
    if (enc) {
      if (enc.x !== 0 || enc.y !== 0) {
        // Contents always start at (0, 0): store the full rectangle.
        const data = readRegion(c.raster, { x: 0, y: 0, width: c.width, height: c.height });
        out.asset = ctx.addAsset(pngDataUrl(c.width, c.height, data, 4), `contents-${c.id}`);
      } else out.asset = ctx.addAsset(enc.url, `contents-${c.id}`);
    }
  }
  if (c.kind === 'document' && c.document) {
    out.layers = c.document.layers.map((l) => serializeLayer(l, ctx));
    if (c.document.globalLight) out.globalLight = { ...c.document.globalLight };
    if (c.document.patterns?.length) out.patterns = serializePatterns(c.document.patterns);
  }
  if (c.file) out.file = { type: c.file.type, data: bytesToBase64(c.file.bytes) };
  if (c.linked) out.linked = { path: c.linked.path };
  return out;
}

/**
 * Serializes a layer tree with inline assets (asset ids are derived from layer ids). Smart object
 * contents go to `smartContents`, once each (present only when there are smart objects).
 */
export function serializeLayers(layers: readonly ImageLayer[]): { layers: SerializedLayer[]; assets: Record<string, string>; smartContents?: SerializedSmartContents[] } {
  const assets: Record<string, string> = {};
  const contents = new Map<string, SerializedSmartContents | null>();
  const ctx: SerializeContext = {
    addAsset(url, hint) {
      let id = hint;
      for (let n = 2; id in assets && assets[id] !== url; n++) id = `${hint}-${n}`;
      assets[id] = url;
      return id;
    },
    addContents(c) {
      if (contents.has(c.id)) return;
      // Reserve the id first: contents can hold instances of themselves only through a cycle, which is cut.
      contents.set(c.id, null);
      contents.set(c.id, serializeContents(c, ctx));
    },
  };
  const out = layers.map((l) => serializeLayer(l, ctx));
  const list = [...contents.values()].filter(Boolean) as SerializedSmartContents[];
  return list.length ? { layers: out, assets, smartContents: list } : { layers: out, assets };
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
): Promise<{ layers: SerializedLayer[]; assets: Record<string, string>; smartContents?: SerializedSmartContents[] }> {
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
  return inline.smartContents ? { layers: inline.layers, assets, smartContents: inline.smartContents } : { layers: inline.layers, assets };
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
  /** The stored `smartContents` table (smart objects reference it by id). */
  smartContents?: unknown[];
  /** Canvas size, for re-rendering a smart object stored without its pixels (default 1 × 1). */
  canvas?: { width: number; height: number };
  /** @internal Contents read so far by id (`null` while being read). */
  contentsMemo?: Map<string, SmartContents | null>;
  /** Decodes an asset (PNG data URL by default). Throw for an unusable asset. */
  decodeAsset?(ref: string, channels: 1 | 4): { width: number; height: number; data: ArrayLike<number> };
  /** Problems found while reading (unknown kinds, broken assets); the rest still loads. */
  problems: string[];
  /** The document's patterns by id, for shapes painted with one. */
  pattern?(id: string): EffectPattern | null;
  /** What draws type layers stored without pixels (and migrated text annotations). */
  text?: Pick<TextEnv, 'shaper' | 'createCanvas'>;
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
  if (r.linked === false) mask.linked = false;
  if (r.deep && !r.source) mask.surface = decodeDeepSurface(mask.surface, r.deep, ctx.problems, `${what} mask`);
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
  const edge = readEdgeColor(r.edge);
  if (edge) base.edge = edge;
  const mask = readMask(r.mask, ctx, `Layer "${base.name || id}"`);
  if (mask) base.mask = mask;
  if (r.vectorMask && typeof r.vectorMask === 'object' && r.type !== 'shape') {
    try {
      base.vectorMask = readVectorMask(r.vectorMask);
    } catch (err) {
      ctx.problems.push(`The vector mask of layer "${base.name || id}" could not be read (${err instanceof Error ? err.message : String(err)}); it was left out.`);
    }
  }
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
      else if (r.deep) layer.surface = decodeDeepSurface(layer.surface, r.deep, ctx.problems, `Layer "${base.name || id}"`);
      if (typeof r.fillOpacity === 'number' && r.fillOpacity !== 1) layer.fillOpacity = num(r.fillOpacity, 0, 1, 1);
      const filters = readFilters(r.filters);
      if (filters) layer.filters = filters;
      const generator = readEffectRef(r.generator);
      if (generator) {
        const duration = r.generator.animate?.duration;
        layer.generator = {
          ...generator,
          ...(typeof r.generator.time === 'number' && r.generator.time > 0 ? { time: r.generator.time } : {}),
          ...(typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? { animate: { duration: Math.min(duration, MAX_EFFECT_ANIMATION_MS) } } : {}),
        };
      }
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
      const annotation = JSON.parse(JSON.stringify({ ...a, id: typeof a.id === 'string' ? a.id : id })) as Annotation;
      // Pen, rectangle, ellipse, line, arrow and text annotations load as shape and type layers that remember them.
      const migrated = annotationLayerFor(annotation, { ...(ctx.canvas ?? { width: 1, height: 1 }), shaper: ctx.text?.shaper ?? null, createCanvas: ctx.text?.createCanvas });
      if (migrated.type === 'shape' || migrated.type === 'type') {
        const blend = base.blend === 'normal' ? migrated.blend : base.blend;
        return { ...migrated, ...base, blend, id, name: base.name } as ShapeLayer | TypeLayer;
      }
      return { ...base, type: 'annotation', annotation };
    }
    case 'shape':
      return readShape(r, base, ctx);
    case 'type':
      return readType(r, base, ctx);
    case 'smart':
      return readSmartObject(r, base, ctx);
    default:
      ctx.problems.push(`Layer "${base.name || id}": unknown layer type "${r.type}"`);
      return null;
  }
}

/** Reads contents `id` from the table (memoised; a contents that contains itself is refused). */
function readContents(id: string, ctx: DeserializeContext): SmartContents | null {
  const memo = (ctx.contentsMemo ??= new Map());
  if (memo.has(id)) {
    const c = memo.get(id);
    if (c === null) ctx.problems.push(`Smart object contents "${id}" contain themselves; the inner instance was dropped`);
    return c ?? null;
  }
  const raw = (ctx.smartContents ?? []).find((c) => c && typeof c === 'object' && (c as { id?: unknown }).id === id) as Record<string, any> | undefined;
  if (!raw) {
    ctx.problems.push(`Smart object contents "${id}" are missing`);
    return null;
  }
  const width = Math.round(num(raw.width, 0, 300000, 0));
  const height = Math.round(num(raw.height, 0, 300000, 0));
  if (!(width > 0 && height > 0)) {
    ctx.problems.push(`Smart object contents "${id}" have no size`);
    return null;
  }
  memo.set(id, null);
  const c: SmartContents = { id, name: typeof raw.name === 'string' ? raw.name : 'Contents', width, height, kind: raw.kind === 'document' ? 'document' : 'raster' };
  if (raw.file && typeof raw.file.type === 'string' && typeof raw.file.data === 'string') {
    try {
      c.file = { type: raw.file.type, bytes: base64ToBytes(raw.file.data) };
    } catch {
      ctx.problems.push(`Smart object contents "${c.name}": the embedded file could not be read`);
    }
  }
  if (raw.linked && typeof raw.linked.path === 'string') c.linked = { path: raw.linked.path };
  if (c.kind === 'raster') {
    if (typeof raw.asset === 'string') c.raster = readSurface(raw.asset, 0, 0, 4, 0, ctx, `Smart object contents "${c.name}"`);
    else if (!c.file) c.raster = emptySurface(4);
  } else {
    const outer = ctx.canvas;
    ctx.canvas = { width, height };
    const layers = deserializeLayers(raw.layers, ctx);
    ctx.canvas = outer;
    c.document = { layers };
    if (raw.globalLight && typeof raw.globalLight === 'object') c.document.globalLight = { angle: num(raw.globalLight.angle, -360, 360, 120), altitude: num(raw.globalLight.altitude, 0, 90, 30) };
    const patterns = deserializePatterns(raw.patterns, ctx.problems);
    if (patterns.length) c.document.patterns = patterns;
  }
  memo.set(id, c);
  return c;
}

const isEffectValue = (x: unknown) =>
  typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)) || (Array.isArray(x) && x.every((n) => typeof n === 'number' && Number.isFinite(n)));

/** `{ effect, provider, name, values }` of an effect smart filter or effect layer, or `undefined`. */
function readEffectRef(raw: any): { effect: string; provider?: string; name?: string; values: Record<string, EffectValue> } | undefined {
  if (!raw || typeof raw !== 'object' || typeof raw.effect !== 'string' || !raw.effect) return undefined;
  const values: Record<string, EffectValue> = {};
  if (raw.values && typeof raw.values === 'object') for (const [k, v] of Object.entries(raw.values)) if (isEffectValue(v)) values[k] = Array.isArray(v) ? [...v] : (v as EffectValue);
  return { effect: raw.effect, ...(typeof raw.provider === 'string' ? { provider: raw.provider } : {}), ...(typeof raw.name === 'string' ? { name: raw.name } : {}), values };
}

function readSmartFilters(raw: unknown, ctx: DeserializeContext, what: string): SmartFilterStack | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, any>;
  const filters: SmartFilter[] = [];
  const list = Array.isArray(r.filters) ? r.filters : [];
  const plain = readFilters(list.filter((f: any) => f && f.kind !== 'psd')) ?? [];
  let k = 0;
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const blend = isBlendMode(f.blend) && f.blend !== 'pigment' ? f.blend : 'normal';
    const opacity = num(f.opacity, 0, 1, 1);
    if (f.kind === 'psd') {
      try {
        filters.push({ id: typeof f.id === 'string' ? f.id : newLayerId('flt'), kind: 'psd', enabled: f.enabled !== false, name: typeof f.name === 'string' ? f.name : 'Filter', data: base64ToBytes(String(f.data ?? '')), blend, opacity });
      } catch {
        ctx.problems.push(`${what}: a Photoshop smart filter could not be read`);
      }
    } else if (f.kind === 'develop' || f.kind === 'blur') {
      const base = plain[k++];
      if (base) filters.push({ ...base, blend, opacity });
    } else if (f.kind === 'effect') {
      const ref = readEffectRef(f);
      if (ref) filters.push({ id: typeof f.id === 'string' ? f.id : newLayerId('flt'), kind: 'effect', enabled: f.enabled !== false, ...ref, blend, opacity });
      else ctx.problems.push(`${what}: an effect smart filter without an effect id was left out`);
    }
  }
  const stack: SmartFilterStack = { enabled: r.enabled !== false, filters };
  const mask = readMask(r.mask, ctx, `${what} filter`);
  if (mask) stack.mask = mask;
  return stack;
}

function readSmartObject(r: Record<string, any>, base: LayerBase, ctx: DeserializeContext): SmartObjectLayer | null {
  const what = `Layer "${base.name || base.id}"`;
  const contents = typeof r.contents === 'string' ? readContents(r.contents, ctx) : null;
  if (!contents) {
    ctx.problems.push(`${what}: its smart object contents are missing; the layer was dropped`);
    return null;
  }
  const p = r.placement ?? {};
  let placement: SmartPlacement;
  try {
    const raw: SmartPlacement = { corners: p.corners as Quad };
    if (p.warp && isValidWarpMesh(p.warp)) raw.warp = p.warp;
    if (isInterpolation(p.interpolation)) raw.interpolation = p.interpolation;
    placement = normalizePlacement(raw, contents);
  } catch (e) {
    ctx.problems.push(`${what}: its placement is invalid (${e instanceof Error ? e.message : String(e)}); it was placed at the top left`);
    placement = { corners: [{ x: 0, y: 0 }, { x: contents.width, y: 0 }, { x: contents.width, y: contents.height }, { x: 0, y: contents.height }] };
  }
  const layer: SmartObjectLayer = { ...base, type: 'smart', contents, placement, surface: emptySurface(4), offset: { x: 0, y: 0 } };
  const filters = readSmartFilters(r.smartFilters, ctx, what);
  if (filters) layer.smartFilters = filters;
  if (typeof r.fillOpacity === 'number' && r.fillOpacity !== 1) layer.fillOpacity = num(r.fillOpacity, 0, 1, 1);
  if (r.psd && typeof r.psd.key === 'string' && typeof r.psd.data === 'string') {
    try {
      layer.psd = { key: r.psd.key, data: base64ToBytes(r.psd.data) };
      if (typeof r.psd.placed === 'string') layer.psd.placed = r.psd.placed;
    } catch {
      // A damaged PSD block is regenerated on export.
    }
  }
  if (typeof r.asset === 'string') layer.surface = readSurface(r.asset, r.x, r.y, 4, 0, ctx, what);
  else if (contents.raster || contents.document) layer.surface = renderSmartObject(layer, ctx.canvas ?? { width: 1, height: 1 });
  return layer;
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
