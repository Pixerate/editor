/**
 * Between the old document-level model (schema v1 / v2: base sliders, adjustment layers, blur,
 * depth mask and annotations) and the layer stack:
 *
 * - `layersFromLegacy` lifts a v1 / v2 state into layers: the source becomes the Background
 *   pixel layer carrying the base sliders as its `develop` filter and the depth mask as its
 *   parametric mask; adjustment layers go above it, annotations on top in their order (pen,
 *   rectangle, ellipse, line and arrow annotations as shape layers that remember them). Blur
 *   becomes a `blur` filter on the Background, or `legacyOutputBlur` when adjustment layers
 *   exist (blur used to run after them).
 * - `legacyView` reads the stack back as `adjustments` / `depthMask` / `annotations` (the
 *   compatibility views on the editor state) and says whether the stack still has exactly the
 *   legacy shape, in which case it serializes as v1 / v2 byte for byte.
 */

import { DEFAULT_ADJUSTMENTS_VALUES, DEFAULT_DEPTH_MASK_VALUES } from './defaults';
import { normalizeAdjustmentLayers } from '../adjustment-layers';
import { normalizeProcessVersion } from '../color';
import { decodeLayerMask, normalizeLayerMask } from '../selection/layer-mask';
import { encodeSelectionRle, resizeSelection } from '../selection/mask';
import type {
  AdjustmentLayer,
  AdjustmentLayerMask,
  Annotation,
  DepthMaskOptions,
  ImageAdjustments,
} from '../types';
import {
  blurFilter,
  developFilter,
  type AdjustmentLayerNode,
  type AnnotationLayer,
  type DevelopFilter,
  type ImageLayer,
  type LayerFilter,
  type PixelLayer,
  type RasterMask,
  type ShapeLayer,
  type TypeLayer,
} from './model';
import { annotationOfShape, createShapeLayer, shapeFromAnnotation } from './shape';
import { annotationOfType, createTypeLayer, typeFromAnnotation, type TextEnv } from './text';
import { emptySurface, readRegion, surfaceFromPixels, type MaskSurface } from '../../raster/surface';

export const BACKGROUND_LAYER_ID = 'background';
export const BACKGROUND_LAYER_NAME = 'Background';
export const DEVELOP_FILTER_ID = 'develop';
export const BLUR_FILTER_ID = 'blur';

/** The old document-level parts of the editor state. */
export interface LegacyParts {
  adjustments: ImageAdjustments;
  depthMask: DepthMaskOptions;
  annotations: Annotation[];
}

/** The stack as stored at document level next to the layers. */
export interface LayerStack {
  layers: ImageLayer[];
  /** Export alpha (the old `adjustments.opacity`), 0..1. */
  outputOpacity: number;
  /** Migrated blur that must run after the adjustment layers (never created by new edits). */
  legacyOutputBlur?: number;
}

// ---------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------

/**
 * Stored `r1:` encodings of masks lifted from v1 / v2, by surface, so an unchanged mask writes
 * back byte for byte (and a mask of another size than the document keeps its size).
 */
const legacyMaskMemo = new WeakMap<MaskSurface, { width: number; height: number; rle: string }>();

/** A raster mask from an old adjustment-layer mask, resampled to the document if needed. */
export function rasterMaskFromLegacy(mask: AdjustmentLayerMask, width: number, height: number): RasterMask | null {
  const sel = decodeLayerMask(mask);
  if (!sel) return null;
  const sized = sel.width === width && sel.height === height ? sel : resizeSelection(sel, width, height);
  const surface = surfaceFromPixels({ width, height, data: sized.data }, 1, 0, 0, 0);
  legacyMaskMemo.set(surface, { width: mask.width, height: mask.height, rle: mask.rle });
  const out: RasterMask = { surface, defaultValue: 0 };
  if (mask.density !== undefined && mask.density !== 1) out.density = mask.density;
  if (mask.feather) out.feather = mask.feather;
  if (mask.enabled === false) out.enabled = false;
  return out;
}

/**
 * True when an adjustment layer's mask came from a v1 / v2 mask of another size than the canvas
 * (the old renderer resampled it per render; the stack holds a canvas-sized copy).
 */
export function hasResampledLegacyMask(layers: readonly ImageLayer[], width: number, height: number): boolean {
  for (const l of layers) {
    if (l.type !== 'adjustment' || !l.mask) continue;
    const memo = legacyMaskMemo.get(l.mask.surface);
    if (memo && (memo.width !== width || memo.height !== height)) return true;
  }
  return false;
}

/** The old mask shape of a raster mask (its pixels over the canvas, run-length encoded). */
export function legacyMaskOf(mask: RasterMask, width: number, height: number): AdjustmentLayerMask {
  let memo = legacyMaskMemo.get(mask.surface);
  if (!memo) {
    const data = readRegion(mask.surface, { x: 0, y: 0, width, height });
    memo = { width, height, rle: encodeSelectionRle(new Uint8Array(data.buffer, data.byteOffset, data.length)) };
    legacyMaskMemo.set(mask.surface, memo);
  }
  return normalizeLayerMask({ ...memo, density: mask.density, feather: mask.feather, enabled: mask.enabled })!;
}

// ---------------------------------------------------------------------------
// Legacy → layers
// ---------------------------------------------------------------------------

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** True when the depth mask settings are the defaults (no mask at all). */
export function isDefaultDepthMask(mask: DepthMaskOptions | undefined): boolean {
  if (!mask) return true;
  return sameJson({ ...DEFAULT_DEPTH_MASK_VALUES, ...mask, depthRange: [...(mask.depthRange ?? [])] }, DEFAULT_DEPTH_MASK_VALUES);
}

export function developFromAdjustments(adjustments: ImageAdjustments): DevelopFilter {
  return {
    id: DEVELOP_FILTER_ID,
    kind: 'develop',
    enabled: true,
    brightness: adjustments.brightness ?? 0,
    contrast: adjustments.contrast ?? 0,
    saturation: adjustments.saturation ?? 0,
    exposure: adjustments.exposure ?? 0,
    temperature: adjustments.temperature ?? 0,
    tint: adjustments.tint ?? 0,
    process: normalizeProcessVersion(adjustments.process),
  };
}

/** The default name of an annotation layer. */
export function annotationLayerName(annotation: Annotation): string {
  switch (annotation.type) {
    case 'pen':
      return 'Pen';
    case 'rect':
      return 'Rectangle';
    case 'circle':
      return 'Ellipse';
    case 'arrow':
      return 'Arrow';
    case 'line':
      return 'Line';
    case 'text':
      return annotation.text ? annotation.text.slice(0, 32) : 'Text';
    case 'image':
      return 'Image';
  }
}

/**
 * The layer an annotation becomes, for a `canvas` of that size: a shape layer (pen, rectangle,
 * ellipse, line, arrow) or a type layer (text; drawn with `canvas.shaper`, or kept undrawn until
 * one can) that remembers it, else an annotation layer (image, or a colour we can't read). Without
 * a canvas nothing is migrated.
 */
export function annotationLayerFor(annotation: Annotation, canvas?: { width: number; height: number } & Partial<TextEnv>): AnnotationLayer | ShapeLayer | TypeLayer {
  const blend = annotation.blend && annotation.blend !== 'normal' ? annotation.blend : 'normal';
  const type = canvas ? typeFromAnnotation(annotation) : null;
  if (type) {
    const layer = createTypeLayer({ ...type, name: annotationLayerName(annotation) }, { shaper: null, ...canvas! }, annotation.id, true);
    return { ...layer, blend, annotation };
  }
  const shape = canvas ? shapeFromAnnotation(annotation) : null;
  if (shape) {
    const layer = createShapeLayer(
      { ...shape, name: annotationLayerName(annotation), blend: annotation.blend && annotation.blend !== 'normal' ? annotation.blend : 'normal' },
      canvas!,
      annotation.id
    );
    return { ...layer, annotation };
  }
  return {
    type: 'annotation',
    id: annotation.id,
    name: annotationLayerName(annotation),
    visible: true,
    opacity: 1,
    blend: 'normal',
    annotation,
  };
}

/** The annotation a layer still is (an annotation layer, or a shape layer migrated from one), or `null`. */
export function annotationOfLayer(layer: ImageLayer): Annotation | null {
  if (layer.type === 'annotation') return layer.annotation;
  if (layer.type === 'shape') return annotationOfShape(layer);
  if (layer.type === 'type') return annotationOfType(layer);
  return null;
}

export function adjustmentNodeFromLegacy(layer: AdjustmentLayer, width: number, height: number): AdjustmentLayerNode {
  const node = {
    type: 'adjustment',
    id: layer.id,
    name: layer.name ?? '',
    visible: layer.enabled !== false,
    opacity: layer.opacity ?? 1,
    blend: layer.blend ?? 'normal',
    kind: layer.kind,
    params: JSON.parse(JSON.stringify(layer.params)),
  } as AdjustmentLayerNode;
  if (layer.mask) {
    const mask = rasterMaskFromLegacy(layer.mask, width, height);
    if (mask) node.mask = mask;
  }
  return node;
}

/** The Background layer of an opened image (its pixels are the document source). */
export function backgroundLayer(filters: LayerFilter[] = [], mask?: RasterMask): PixelLayer {
  const layer: PixelLayer = {
    type: 'pixel',
    id: BACKGROUND_LAYER_ID,
    name: BACKGROUND_LAYER_NAME,
    visible: true,
    opacity: 1,
    blend: 'normal',
    surface: emptySurface(4),
    offset: { x: 0, y: 0 },
    source: 'document',
    filters,
  };
  if (mask) layer.mask = mask;
  return layer;
}

/** A parametric depth mask on a layer. */
export function depthRasterMask(source: DepthMaskOptions): RasterMask {
  const out: RasterMask = {
    surface: emptySurface(1, 255),
    defaultValue: 255,
    source: { ...source, depthRange: [...source.depthRange] as [number, number] },
  };
  if (!source.enabled) out.enabled = false;
  return out;
}

/** Lifts a v1 / v2 state into a layer stack (see the module comment). */
export function layersFromLegacy(parts: Partial<LegacyParts>, width: number, height: number): LayerStack {
  // As `normalizeStoredAdjustments`: stored values without `process` keep the legacy rendering.
  const stored = parts.adjustments;
  const adjustments = (
    stored ? { ...DEFAULT_ADJUSTMENTS_VALUES, ...stored, process: normalizeProcessVersion(stored.process) } : { ...DEFAULT_ADJUSTMENTS_VALUES }
  ) as ImageAdjustments;
  const adjLayers = normalizeAdjustmentLayers(adjustments.layers);
  const filters: LayerFilter[] = [developFromAdjustments(adjustments)];
  const blur = typeof adjustments.blur === 'number' && adjustments.blur > 0 ? adjustments.blur : 0;
  let legacyOutputBlur: number | undefined;
  if (blur > 0) {
    if (adjLayers.length) legacyOutputBlur = blur;
    else filters.push({ id: BLUR_FILTER_ID, kind: 'blur', enabled: true, radius: blur });
  }
  const depth = parts.depthMask;
  const mask = depth && !isDefaultDepthMask(depth) ? depthRasterMask({ ...DEFAULT_DEPTH_MASK_VALUES, ...depth }) : undefined;
  const layers: ImageLayer[] = [backgroundLayer(filters, mask)];
  for (const l of adjLayers) layers.push(adjustmentNodeFromLegacy(l, width, height));
  for (const a of parts.annotations ?? []) layers.push(annotationLayerFor(JSON.parse(JSON.stringify(a)), { width, height }));
  const out: LayerStack = { layers, outputOpacity: typeof adjustments.opacity === 'number' ? adjustments.opacity : 1 };
  if (legacyOutputBlur !== undefined) out.legacyOutputBlur = legacyOutputBlur;
  return out;
}

// ---------------------------------------------------------------------------
// Layers → legacy views
// ---------------------------------------------------------------------------

/** The old `AdjustmentLayer` shape of a node, keys in the order `normalizeAdjustmentLayer` writes. */
export function legacyAdjustmentLayer(node: AdjustmentLayerNode, width: number, height: number): AdjustmentLayer {
  const out: Record<string, unknown> = {
    id: node.id,
    kind: node.kind,
    enabled: node.visible,
    opacity: node.opacity,
    blend: node.blend,
    params: node.params,
  };
  if (node.name) out.name = node.name;
  if (node.mask && !node.mask.source) out.mask = legacyMaskOf(node.mask, width, height);
  return out as unknown as AdjustmentLayer;
}

/** The pixel layer whose develop filter the legacy API edits: the active one, else the Background. */
export function developTarget(layers: readonly ImageLayer[], activeLayerId: string | null): PixelLayer | null {
  const pixels: PixelLayer[] = [];
  const walk = (list: readonly ImageLayer[]) => {
    for (const l of list) {
      if (l.type === 'pixel') pixels.push(l);
      else if (l.type === 'group') walk(l.children);
    }
  };
  walk(layers);
  if (activeLayerId) {
    const active = pixels.find((l) => l.id === activeLayerId);
    if (active) return active;
  }
  return pixels.find((l) => l.source === 'document') ?? pixels.find((l) => l.id === BACKGROUND_LAYER_ID) ?? pixels[0] ?? null;
}

export interface LegacyViewResult extends LegacyParts {
  /**
   * True when the stack has exactly the shape a v1 / v2 document lifts to (an unpainted,
   * unmoved Background with develop / blur filters and an optional depth mask, then adjustment
   * layers, then plain annotation layers), so it can be written as v1 / v2.
   */
  exact: boolean;
}

const isPlain = (l: ImageLayer) =>
  l.visible && l.opacity === 1 && l.blend === 'normal' && !l.clipped && !l.mask && !l.locks && !l.effects;

/** Reads the stack back as the old document-level parts (see `LegacyViewResult`). */
export function legacyView(stack: LayerStack, width: number, height: number, activeLayerId: string | null = null): LegacyViewResult {
  const { layers } = stack;
  const target = developTarget(layers, activeLayerId);
  const develop = target ? developFilter(target) : undefined;
  const blur = stack.legacyOutputBlur ?? (target ? blurFilter(target)?.radius : undefined) ?? 0;
  const adjustments: ImageAdjustments = {
    ...DEFAULT_ADJUSTMENTS_VALUES,
    ...(develop
      ? {
          brightness: develop.brightness,
          contrast: develop.contrast,
          saturation: develop.saturation,
          exposure: develop.exposure,
          temperature: develop.temperature,
          tint: develop.tint ?? 0,
        }
      : {}),
    blur,
    opacity: stack.outputOpacity,
    process: develop ? normalizeProcessVersion(develop.process) : DEFAULT_ADJUSTMENTS_VALUES.process,
  };
  const adjNodes: AdjustmentLayerNode[] = [];
  const annotations: Annotation[] = [];
  const walk = (list: readonly ImageLayer[]) => {
    for (const l of list) {
      if (l.type === 'adjustment') adjNodes.push(l);
      else if (l.type === 'group') walk(l.children);
      else {
        const a = annotationOfLayer(l);
        if (a) annotations.push(a);
      }
    }
  };
  walk(layers);
  if (adjNodes.length) adjustments.layers = adjNodes.map((n) => legacyAdjustmentLayer(n, width, height));
  const depthSource = target?.mask?.source;
  const depthMask: DepthMaskOptions = depthSource
    ? { ...depthSource, depthRange: [...depthSource.depthRange] as [number, number] }
    : { ...DEFAULT_DEPTH_MASK_VALUES, depthRange: [...DEFAULT_DEPTH_MASK_VALUES.depthRange] as [number, number] };
  return { adjustments, depthMask, annotations, exact: isLegacyShape(stack) };
}

/** See `LegacyViewResult.exact`. */
export function isLegacyShape(stack: LayerStack): boolean {
  const { layers } = stack;
  const bg = layers[0];
  if (!bg || bg.type !== 'pixel' || bg.source !== 'document') return false;
  if (bg.id !== BACKGROUND_LAYER_ID || bg.name !== BACKGROUND_LAYER_NAME) return false;
  if (!bg.visible || bg.opacity !== 1 || bg.blend !== 'normal' || bg.clipped || bg.locks || bg.effects) return false;
  if ((bg.fillOpacity ?? 1) !== 1 || bg.offset.x !== 0 || bg.offset.y !== 0) return false;
  const filters = bg.filters ?? [];
  if (filters.length < 1 || filters.length > 2) return false;
  const [develop, blur] = filters;
  if (develop.kind !== 'develop' || !develop.enabled || develop.id !== DEVELOP_FILTER_ID) return false;
  if (blur && (blur.kind !== 'blur' || !blur.enabled || blur.id !== BLUR_FILTER_ID || !(blur.radius > 0))) return false;
  if (bg.mask) {
    const m = bg.mask;
    if (!m.source || m.density !== undefined || m.feather !== undefined) return false;
    if ((m.enabled !== false) !== m.source.enabled) return false;
  }
  let i = 1;
  let adjustments = 0;
  for (; i < layers.length && layers[i].type === 'adjustment'; i++) {
    const l = layers[i] as AdjustmentLayerNode;
    if (l.clipped || l.locks || l.mask?.source || l.effects) return false;
    adjustments++;
  }
  for (; i < layers.length; i++) {
    const l = layers[i];
    if (l.type === 'shape' || l.type === 'type') {
      // A migrated shape or type layer draws with its annotation's blend mode.
      const a = l.annotation;
      if (!a || (a.blend ?? 'normal') !== l.blend || !isPlain({ ...l, blend: 'normal' }) || l.fillOpacity !== undefined) return false;
      if (l.id !== a.id || l.name !== annotationLayerName(a)) return false;
      continue;
    }
    if (l.type !== 'annotation' || !isPlain(l) || l.id !== l.annotation.id || l.name !== annotationLayerName(l.annotation)) return false;
  }
  if (blur && adjustments) return false;
  if (stack.legacyOutputBlur !== undefined && (!adjustments || !(stack.legacyOutputBlur > 0))) return false;
  return true;
}
