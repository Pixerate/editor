/**
 * The image editor's layer stack: pixel, adjustment, group, shape, smart object and annotation
 * layers in one ordered
 * tree (bottom to top), all in document space (natural pixels of the document).
 *
 * Layer objects are immutable. Every change builds new objects along the path from the root to
 * the changed layer and shares everything else, so undo history, the compositor's caches and
 * serialization can compare layers by identity.
 */

import type {
  AdjustmentKind,
  AdjustmentParamsMap,
  Annotation,
  CropBox,
  DepthMaskOptions,
} from '../types';
import type { PixelSurface } from '../../raster/surface';
import type { EffectValue } from '../../effects/types';
import type { BlendMode } from '../../raster/blend';
import type { Interpolation } from '../../raster/transform';
import type { EffectFill, GlobalLight } from '../../raster/effects/model';
import type { EffectPattern } from '../../raster/effects/patterns';
import type { AffineMatrix, Quad, WarpMesh } from '../../geom/types';
import type { VectorSubpath } from '../../vector/types';
import type { TextRun, ParagraphRun } from '../../text/types';
import {
  findLayer,
  flattenLayers,
  insertLayer,
  isLayerLocked,
  mapLayer,
  type GroupBlendMode,
  type LayerLocation as RasterLayerLocation,
  type LayerLocks,
  type RasterLayerBase,
  type RasterMask as BaseRasterMask,
  type RasterPixelLayer,
} from '../../raster/layers';

/** Blend modes of a layer; groups also accept `pass-through`. */
export type LayerBlendMode = GroupBlendMode;

export type { LayerLocks };

/**
 * A layer mask (see the raster module's `RasterMask`) whose parametric `source` is a depth map:
 * a depth mask is generated from it instead of painted, and its surface is unused.
 */
export type RasterMask = BaseRasterMask<DepthMaskOptions>;

export interface LayerBase extends RasterLayerBase {
  mask?: RasterMask;
  /** A vector mask (Photoshop's): a path that reveals the layer, on top of `mask`. Not on shape layers. */
  vectorMask?: VectorMask;
}

/**
 * A vector mask: shape components in document pixels (the same paths shape layers use) that
 * reveal the layer inside them (outside with `inverted`). It stays sharp at any size; the
 * compositor multiplies it with the layer's raster mask. No components hides everything
 * (reveals everything when inverted).
 */
export interface VectorMask {
  components: ShapeComponent[];
  /** How overlapping subpaths fill (default nonzero). */
  fillRule?: ShapeFillRule;
  /** Reveal outside the path instead (default false). */
  inverted?: boolean;
  /** Disabled masks are kept but ignored (default true). */
  enabled?: boolean;
  /** `false`: the path stays put when the layer moves or transforms (default true). */
  linked?: boolean;
  /** 0..1 (default 1): at 0.5 the hidden area still shows half. */
  density?: number;
  /** Gaussian feather σ in px (default 0). */
  feather?: number;
}

/** The base sliders of the old document-level adjustments, as a filter on one layer. */
export interface DevelopSettings {
  brightness: number;
  contrast: number;
  saturation: number;
  exposure: number;
  temperature: number;
  tint?: number;
  /** Rendering process (see `ImageAdjustments.process`). */
  process?: 1 | 2;
}

export type DevelopFilter = { id: string; kind: 'develop'; enabled: boolean } & DevelopSettings;
/** Box blur of `radius` pixels (the old `adjustments.blur`), clamped at the canvas edges. */
export interface BlurFilter {
  id: string;
  kind: 'blur';
  enabled: boolean;
  radius: number;
}
export type LayerFilter = DevelopFilter | BlurFilter;
export type LayerFilterKind = LayerFilter['kind'];

/**
 * A provider effect (see `@pixerate/editor/effects`) an effect layer is drawn from: generator or
 * overlay effects rendered at the document's size and depth. Kept, with the layer's last rendered
 * pixels, when no provider is registered.
 */
export interface ImageEffectGenerator {
  /** The provider's effect id. */
  effect: string;
  /** The provider it was rendered with (its `id`). */
  provider?: string;
  /** The effect's name when it was applied. */
  name?: string;
  /** Control values (over the effect's defaults). */
  values: Record<string, EffectValue>;
  /**
   * The moment of the effect drawn (ms, default 0): the still frame, and where an animation
   * starts.
   */
  time?: number;
  /**
   * The layer plays when the document is output as an animation (`renderAnimationFrame`),
   * for `duration` ms from `time`. Absent: the layer is the still frame at `time`.
   */
  animate?: ImageEffectAnimation;
}

/** The longest an effect layer animates (ms): a minute. */
export const MAX_EFFECT_ANIMATION_MS = 60_000;

/** How an animated effect layer plays: for `duration` ms (more than 0, at most `MAX_EFFECT_ANIMATION_MS`). */
export interface ImageEffectAnimation {
  duration: number;
}

export interface PixelLayer extends LayerBase, Omit<RasterPixelLayer, keyof RasterLayerBase> {
  /**
   * An effect layer: the pixels are rendered from a provider effect at the document's size and bit
   * depth, and rendered again when its values change (painting on it is kept until then).
   */
  generator?: ImageEffectGenerator;
  /** Live filters, applied bottom (first) to top before the mask and blend. */
  filters?: LayerFilter[];
  /**
   * `'document'`: the pixels are the document's source image, unmodified (the Background of an
   * opened image). Such a layer's `surface` is a placeholder; read its pixels through the
   * controller. Painting it drops the flag.
   */
  source?: 'document';
}

export type AdjustmentLayerNode<K extends AdjustmentKind = AdjustmentKind> = {
  [P in K]: LayerBase & { type: 'adjustment'; kind: P; params: AdjustmentParamsMap[P] };
}[K];

export interface GroupLayer extends Omit<LayerBase, 'blend'> {
  type: 'group';
  blend: LayerBlendMode;
  /** Bottom to top. */
  children: ImageLayer[];
  /** UI only. */
  collapsed?: boolean;
}

/** One annotation (pen, shape, arrow, text, image) as a layer, drawn by the annotation renderer. */
export interface AnnotationLayer extends LayerBase {
  type: 'annotation';
  annotation: Annotation;
}

// ---------------------------------------------------------------------------
// Shape layers
// ---------------------------------------------------------------------------

/**
 * How a shape component combines with the result of the components below it (Photoshop's path
 * operations): `combine` (union), `subtract` (front minus), `intersect` and `exclude` (xor). The
 * first component always combines, whatever it says.
 */
export type ShapeOperation = 'combine' | 'subtract' | 'intersect' | 'exclude';
export const SHAPE_OPERATIONS: readonly ShapeOperation[] = ['combine', 'subtract', 'intersect', 'exclude'];

/** Winding rule a component's subpaths are filled with. */
export type ShapeFillRule = 'nonzero' | 'evenodd';

/**
 * What a shape's fill or stroke paints with: a solid colour, a gradient or a pattern (the fills of
 * layer effects; gradients aligned with the layer use the shape's bounds), at `opacity` (0..1,
 * missing = 1).
 */
export type ShapePaint = EffectFill & { opacity?: number };

export type ShapeStrokeAlign = 'inside' | 'center' | 'outside';
export type ShapeLineCap = 'butt' | 'round' | 'square';
export type ShapeLineJoin = 'miter' | 'round' | 'bevel';

/** A shape's stroke (Photoshop's shape Stroke options, not the layer-style stroke). */
export interface ShapeStroke {
  /** Width in document pixels. */
  width: number;
  paint: ShapePaint;
  /** Where the stroke sits on the outline (default `center`; open paths always stroke centred). */
  align?: ShapeStrokeAlign;
  /** Default `butt`. */
  cap?: ShapeLineCap;
  /** Default `miter`. */
  join?: ShapeLineJoin;
  /** Miter length over width above which a miter is bevelled (default 100, as Photoshop). */
  miterLimit?: number;
  /** Dash and gap lengths in multiples of the width (Photoshop's convention); missing or empty = solid. */
  dashes?: number[];
  /** Distance into the dash pattern at the start, in multiples of the width. */
  dashOffset?: number;
}

/** An arrowhead of a live line: a triangle (notched by `concavity`) whose tip is the line's end. */
export interface ShapeArrowhead {
  /** Width across the base, document pixels. */
  width: number;
  /** Length from the base to the tip, document pixels. */
  length: number;
  /** Notch of the base towards the tip as a fraction of `length` (-0.5..0.5, default 0). */
  concavity?: number;
}

interface LiveShapeBase {
  /**
   * Where the shape's own frame lands in the document (an affine map, missing = identity): live
   * shapes keep their parameters through moves, rotations and scales.
   */
  transform?: AffineMatrix;
}

/**
 * A parametric ("live") shape a component was drawn as, kept so it stays editable as that shape
 * (Photoshop's live shape properties). The component's subpaths are always the shape it
 * describes; editing the subpaths directly drops it.
 */
export type LiveShape =
  | (LiveShapeBase & {
      kind: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
      /** Corner radii in pixels: top-left, top-right, bottom-right, bottom-left (missing = square). */
      radii?: [number, number, number, number];
    })
  | (LiveShapeBase & { kind: 'ellipse'; x: number; y: number; width: number; height: number })
  | (LiveShapeBase & { kind: 'polygon'; x: number; y: number; width: number; height: number; sides: number })
  | (LiveShapeBase & {
      kind: 'star';
      x: number;
      y: number;
      width: number;
      height: number;
      points: number;
      /** Inner radius over outer radius, 0..1. */
      innerRatio: number;
    })
  | (LiveShapeBase & {
      kind: 'line';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      /** Thickness of the bar in pixels (a line shape is a filled bar, as in Photoshop). */
      weight: number;
      startArrow?: ShapeArrowhead | null;
      endArrow?: ShapeArrowhead | null;
    });
export type LiveShapeKind = LiveShape['kind'];
export const LIVE_SHAPE_KINDS: readonly LiveShapeKind[] = ['rect', 'ellipse', 'polygon', 'star', 'line'];

/** One shape component: subpaths filled together (with the layer's fill rule), combined by `op`. */
export interface ShapeComponent {
  op: ShapeOperation;
  /** Document pixels; handles are absolute positions (the vector editor's anchors). */
  subpaths: VectorSubpath[];
  live?: LiveShape;
}

/** PSD data of a shape layer kept for round trips (see the PSD module). */
export interface ShapePsdData {
  /** The vector blocks as read (`vsms` / `vmsk`, `vscg`, `vstk`, `vogk`, fill blocks), by key. */
  blocks?: Array<{ key: string; data: Uint8Array }>;
  /** The shape as it was read (`shapeSignature`): while unchanged, export writes `blocks` back as they were. */
  signature?: string;
}

/**
 * A shape layer: vector components with a fill and a stroke. `surface` is the rendered result in
 * document space (offset 0), rebuilt from the components by every change, so it never degrades
 * however often the shape is moved or transformed; the compositor draws it like a pixel layer's
 * pixels, and masks, effects, clipping and blend apply on top. Never paint into it: rasterize the
 * layer first.
 */
export interface ShapeLayer extends LayerBase {
  type: 'shape';
  /** Bottom (first) to top. */
  components: ShapeComponent[];
  /** Default `nonzero`. */
  fillRule?: ShapeFillRule;
  /** The fill covers everything except the combined area (Photoshop shapes whose first component subtracts). */
  inverted?: boolean;
  /** `null`: no fill. */
  fill: ShapePaint | null;
  /** `null`: no stroke. */
  stroke: ShapeStroke | null;
  /** The rendered pixels (a cache of the components, fill and stroke), document space. */
  surface: PixelSurface;
  /** Always (0, 0): a shape moves through its geometry. */
  offset: { x: number; y: number };
  /** 0..1, PSD "Fill" (missing = 1). */
  fillOpacity?: number;
  /**
   * The annotation this layer was migrated from (pen, rectangle, ellipse, line, arrow), while the
   * shape is still exactly that annotation: the `annotations` compatibility view and
   * `updateAnnotation` read and edit it. Shape edits drop it.
   */
  annotation?: Annotation;
  psd?: ShapePsdData;
}

// ---------------------------------------------------------------------------
// Type layers
// ---------------------------------------------------------------------------

export type { TextStyle, TextRun, TextAlign, ParagraphStyle, ParagraphRun } from '../../text/types';
export { TEXT_ALIGNS } from '../../text/types';

/** PSD data of a type layer kept for round trips (see the PSD module). */
export interface TypePsdData {
  /** The `TySh` block as read: written back while the layer is unchanged, else patched. */
  tySh?: Uint8Array;
  /** The layer's text, styles, frame and transform as read (`typeSignature`). */
  signature?: string;
  /** Additional-info blocks we do not model, by key. */
  blocks?: Array<{ key: string; data: Uint8Array }>;
}

/**
 * A type layer: styled text laid out as point text (one line per paragraph, growing from its
 * origin) or paragraph text (wrapped in a box), placed in the document by `transform`. `surface` is
 * the rendered text in document space (offset 0), drawn by the editor's text shaper on every change;
 * the compositor draws it like a pixel layer's pixels. Never paint into it: rasterize the layer.
 */
export interface TypeLayer extends LayerBase {
  type: 'type';
  text: string;
  /** Character runs covering the text in order (lengths add up to `text.length`). */
  runs: TextRun[];
  /** Paragraph runs covering the text in order. */
  paragraphs: ParagraphRun[];
  /**
   * `point`: text space (0, 0) is the first line's baseline at its alignment edge (`origin: 'top'`:
   * the top of the first line instead, as text annotations were drawn). `box`: text wraps inside
   * `width × height` with its top-left at (0, 0).
   */
  frame: { kind: 'point'; origin?: 'baseline' | 'top' } | { kind: 'box'; width: number; height: number };
  /** Text space → document (missing = identity). */
  transform?: AffineMatrix;
  /** Default true. */
  antiAlias?: boolean;
  /** The rendered pixels, document space. */
  surface: PixelSurface;
  /** Always (0, 0): a type layer moves through its transform. */
  offset: { x: number; y: number };
  /** 0..1, PSD "Fill" (missing = 1). */
  fillOpacity?: number;
  /**
   * How `surface` was made: missing when the shaper laid it out; `'stored'` for pixels kept from a
   * PSD or a save made where no shaper could draw it (the first edit draws it again).
   */
  rendering?: 'stored';
  /** Families the last render had to replace with a fallback. */
  missingFonts?: string[];
  /** The text annotation this layer was migrated from, while it still is that annotation. */
  annotation?: Annotation;
  psd?: TypePsdData;
}

// ---------------------------------------------------------------------------
// Smart objects
// ---------------------------------------------------------------------------

/** A nested layer document: the contents of a smart object made from layers (or an embedded PSD). */
export interface SmartDocument {
  /** Bottom to top, on a canvas of the contents' `width × height`. */
  layers: ImageLayer[];
  globalLight?: GlobalLight;
  patterns?: EffectPattern[];
}

/**
 * What a smart object places: raster pixels or a nested layer document, at their own pixel size.
 * Immutable and shared: every instance placed from the same contents (duplicates, linked
 * instances) holds the same `id`, and replacing or editing the contents updates them all.
 */
export interface SmartContents {
  /** Shared by linked instances; independent copies get a fresh one. */
  id: string;
  /** File name shown in the UI and written to PSD (`Layer 1.psb`, `photo.png`). */
  name: string;
  /** Pixel size of the contents (the placement maps `0..width × 0..height` into the document). */
  width: number;
  height: number;
  /** `raster`: `raster` holds the pixels at (0, 0); `document`: `document` holds the layers. */
  kind: 'raster' | 'document';
  raster?: PixelSurface;
  document?: SmartDocument;
  /**
   * The file the contents came from (a PSD's embedded file), written back by Export Contents and
   * PSD export while the contents are unedited. Without `raster` / `document` the file could not
   * be decoded here (a JPEG outside a browser): the layer keeps its rendered pixels, and changes
   * that re-render it are refused until `prepareSmartObjects` decodes it.
   */
  file?: { bytes: Uint8Array; type: string };
  /** Linked to an external file (Photoshop `liFE`): only the embedded preview is held. */
  linked?: { path: string };
}

/**
 * Where a smart object's contents land, non-destructively: a warp in the contents' own pixels
 * (optional) and then the map of the contents' rectangle onto `corners`. Every change re-renders
 * from the contents, so repeated transforms never degrade.
 */
export interface SmartPlacement {
  /** Where the contents' corners land (top-left, top-right, bottom-right, bottom-left), document pixels. */
  corners: Quad;
  /** A Bézier warp over the contents' rectangle, control points in contents pixels (missing = none). */
  warp?: WarpMesh | null;
  /** Resampling (default bicubic). */
  interpolation?: Interpolation;
}

/**
 * A Photoshop smart filter we do not model (Gaussian Blur, Camera Raw, …), kept from a PSD so it
 * is listed, can be hidden, reordered or deleted, and is written back unchanged. It draws nothing.
 */
export interface PsdSmartFilter {
  id: string;
  kind: 'psd';
  enabled: boolean;
  /** Photoshop's menu name (`Gaussian Blur...`). */
  name: string;
  /** The filter's `filterFX` item descriptor (versioned descriptor bytes), as read. */
  data: Uint8Array;
}

/**
 * A provider effect (see `@pixerate/editor/effects`) as a smart filter: a filter effect run on the
 * result below it. Without a provider (or while it renders) it passes the pixels through; it keeps
 * its effect id and values either way.
 */
export interface EffectSmartFilter {
  id: string;
  kind: 'effect';
  enabled: boolean;
  /** The provider's effect id. */
  effect: string;
  provider?: string;
  /** The effect's name when it was applied. */
  name?: string;
  /** Control values (over the effect's defaults). */
  values: Record<string, EffectValue>;
}

/** One smart filter: a layer filter, a provider effect or a kept PSD filter, with its own blending over the result below it. */
export type SmartFilter = (LayerFilter | PsdSmartFilter | EffectSmartFilter) & {
  /** How the filter's result blends with the result below it (Photoshop's Blending Options). */
  blend: BlendMode;
  /** 0..1 */
  opacity: number;
};
export type SmartFilterKind = SmartFilter['kind'];

/** The smart filter stack of a smart object. */
export interface SmartFilterStack {
  /** Layer › Smart Filter › Disable Smart Filters (each filter keeps its own `enabled`). */
  enabled: boolean;
  /** Bottom (applied first) to top. */
  filters: SmartFilter[];
  /**
   * The one filter mask (document space): where the filtered result shows over the unfiltered
   * contents. Missing reveals everywhere.
   */
  mask?: RasterMask;
}

/** PSD data of a smart object kept for round trips (see the PSD module). */
export interface SmartPsdData {
  /** The placed-layer block as read (`SoLd`, `SoLE` or `PlLd`) and its key. */
  key: string;
  data: Uint8Array;
  /** The instance id (`placed`), which keys the filter-effects cache. */
  placed?: string;
}

/**
 * A smart object: `contents` placed through `placement`, then the smart filters. `surface` is the
 * rendered result in document space (offset 0), rebuilt by every change to the contents,
 * placement or filters; the compositor draws it like a pixel layer's pixels, and masks, effects,
 * clipping and blend apply on top. Never paint into it: rasterize the layer first.
 */
export interface SmartObjectLayer extends LayerBase {
  type: 'smart';
  contents: SmartContents;
  placement: SmartPlacement;
  smartFilters?: SmartFilterStack;
  /** The rendered pixels (a cache of contents → placement → filters), document space. */
  surface: PixelSurface;
  /** Always (0, 0): a smart object moves through its placement. */
  offset: { x: number; y: number };
  /** 0..1, PSD "Fill" (missing = 1). */
  fillOpacity?: number;
  psd?: SmartPsdData;
}

export type ImageLayer = PixelLayer | AdjustmentLayerNode | GroupLayer | AnnotationLayer | SmartObjectLayer | ShapeLayer | TypeLayer;
export type ImageLayerType = ImageLayer['type'];

/** Which part of the active layer painting targets (`filter-mask`: a smart object's filter mask). */
/**
 * What a paint, fill or retouch writes: a layer's pixels, its mask, a smart object's filter mask,
 * or (in Quick Mask mode) the selection itself (`quick-mask`, not a layer).
 */
export type LayerTarget = 'pixels' | 'mask' | 'filter-mask' | 'quick-mask';

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

let idCounter = 0;

/** A fresh id with `prefix` (`layer`, `flt`, …). */
export function newLayerId(prefix = 'layer'): string {
  return `${prefix}_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Tree helpers (pure)
// ---------------------------------------------------------------------------

export type LayerLocation = RasterLayerLocation<ImageLayer>;

export { flattenLayers, findLayer, mapLayer, insertLayer, isLayerLocked };

/** The top-level and nested pixel layers. */
export function pixelLayers(layers: readonly ImageLayer[]): PixelLayer[] {
  return flattenLayers(layers).filter((l): l is PixelLayer => l.type === 'pixel');
}

/** The develop filter of a pixel layer, if any. */
export function developFilter(layer: PixelLayer): DevelopFilter | undefined {
  return layer.filters?.find((f): f is DevelopFilter => f.kind === 'develop');
}

export function blurFilter(layer: PixelLayer): BlurFilter | undefined {
  return layer.filters?.find((f): f is BlurFilter => f.kind === 'blur');
}

/** True for filters that change pixels (enabled, non-neutral). */
export function isActiveFilter(f: LayerFilter): boolean {
  if (!f.enabled) return false;
  if (f.kind === 'blur') return Math.min(Math.round(f.radius), 40) >= 1;
  return Boolean(f.brightness || f.contrast || f.saturation || f.exposure || f.temperature || f.tint);
}

/** True when a filter needs neighbouring pixels (it can't run tile by tile). */
export function isSpatialFilter(f: LayerFilter): boolean {
  return f.kind === 'blur';
}

/** Document-space bounds of a pixel layer's stored tiles, or `null`. */
export function pixelLayerBounds(layer: PixelLayer, surface: PixelSurface = layer.surface): CropBox | null {
  const b = surface.bounds;
  if (!b) return null;
  return { x: b.x + layer.offset.x, y: b.y + layer.offset.y, width: b.width, height: b.height };
}

/** Human label of a layer kind. */
export function layerTypeLabel(type: ImageLayerType): string {
  return type === 'pixel'
    ? 'Pixel layer'
    : type === 'adjustment'
      ? 'Adjustment layer'
      : type === 'group'
        ? 'Group'
        : type === 'smart'
          ? 'Smart object'
          : type === 'shape'
            ? 'Shape layer'
            : type === 'type'
              ? 'Type layer'
              : 'Annotation';
}

/** Layers whose pixels are a surface the compositor draws (pixel layers, smart objects, shapes, type). */
export function hasSurface(layer: ImageLayer): layer is PixelLayer | SmartObjectLayer | ShapeLayer | TypeLayer {
  return layer.type === 'pixel' || layer.type === 'smart' || layer.type === 'shape' || layer.type === 'type';
}

/** Layers whose `surface` is a render cache of their own data (smart objects, shapes, type): never paint into it. */
export function isRenderedLayer(layer: ImageLayer): layer is SmartObjectLayer | ShapeLayer | TypeLayer {
  return layer.type === 'smart' || layer.type === 'shape' || layer.type === 'type';
}

/** Every shape layer in the stack. */
export function shapeLayers(layers: readonly ImageLayer[]): ShapeLayer[] {
  return flattenLayers(layers).filter((l): l is ShapeLayer => l.type === 'shape');
}

/** Every smart object in the stack (nested contents not included). */
export function smartObjectLayers(layers: readonly ImageLayer[]): SmartObjectLayer[] {
  return flattenLayers(layers).filter((l): l is SmartObjectLayer => l.type === 'smart');
}
