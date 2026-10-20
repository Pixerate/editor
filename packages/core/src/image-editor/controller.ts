import {
  AdjustmentKind,
  AdjustmentLayer,
  AdjustmentParamsMap,
  Annotation,
  CreateAnnotationPayload,
  AspectRatio,
  CropBox,
  DepthMaskOptions,
  ExportOptions,
  ImageAdjustments,
  ImageDimensions,
  ImageEditorFit,
  ImageEditorOptions,
  ImageEditorState,
  ImageEditorTool,
  ImageTransform,
  ImagePoint,
  LegacySerializedImageEditorState,
  SerializedImageEditorState,
} from './types';
import { ImageEditorRenderer, RenderOptions } from './renderer';
import { clampCropToImage, isQuarterTurnSwapped } from './geometry';
import { LATEST_PROCESS_VERSION, LEGACY_PROCESS_VERSION, normalizeProcessVersion } from './color';
import { createAdjustmentLayer, normalizeAdjustmentLayer, normalizeAdjustmentLayers } from './adjustment-layers';
import { isBlendMode, type BlendMode } from './blend';
import type { ImageHistogram } from './histogram';
import { applyAdjustments } from './filters';
import {
  combineSelections,
  createSelectionMask,
  deserializeSelection,
  fullSelection,
  invertSelection as invertSelectionMask,
  resizeSelection,
  selectionFromPixels,
  serializeSelection,
  type PixelBuffer,
  type SelectionChannel,
  type SelectionMask,
  type SelectionMode,
} from './selection/mask';
import { ellipseSelection, polygonSelection, rectSelection, type ShapeSelectionOptions } from './selection/shapes';
import { colorRange, magicWand, type ColorRangeOptions, type ColorRangeSample, type MagicWandOptions } from './selection/wand';
import { modifySelection as modifySelectionMask, type SelectionModifyOp } from './selection/modify';
import { refineSelection as refineSelectionMask, type RefineEdgeParams } from './selection/refine';
import type { LayerMaskProps } from './selection/layer-mask';
import type { AdjustmentLayerMask } from './types';
import { DEFAULT_ADJUSTMENTS_VALUES, DEFAULT_DEPTH_MASK_VALUES, DEFAULT_TRANSFORM_VALUES } from './layers/defaults';
import {
  findLayer,
  flattenLayers,
  insertLayer,
  isActiveFilter,
  mapLayer,
  newLayerId,
  type AdjustmentLayerNode,
  type AnnotationLayer,
  type DevelopFilter,
  type GroupLayer,
  type LayerBlendMode,
  type ImageLayer,
  type LayerFilter,
  type LayerTarget,
  type PixelLayer,
  type RasterMask,
  type SmartContents,
  type SmartFilter,
  type SmartObjectLayer,
  type SmartPlacement,
  type LiveShape,
  type ShapeComponent,
  type ShapeFillRule,
  type ShapeOperation,
  type ShapeLayer,
  type ShapePaint,
  type ShapeStroke,
  type ParagraphStyle,
  type TextStyle,
  type TypeLayer,
  hasSurface,
} from './layers/model';
import {
  annotationOfShape,
  createShapeLayer,
  liveComponent,
  mergeShapeComponents as mergeShapeComponentsOp,
  normalizeLiveShape,
  normalizeShapePaint,
  normalizeShapeStroke,
  normalizeSubpaths,
  offsetShape,
  requireOperation,
  requireShapeLayer,
  rerenderShape,
  shapeAsPixelLayer,
  shapeFromAnnotation,
  shapeGeometryBounds,
  transformShapeComponents,
  updateShapeLayer,
  type ShapeEnv,
} from './layers/shape';
import { bezierToSubpaths, roundSubpaths } from '../vector/geometry';
import {
  DEFAULT_TEXT_STYLE,
  annotationOfType,
  caretAt,
  createTypeLayer,
  layoutText,
  normalizeText,
  patchParagraphStyle,
  patchTextStyle,
  replaceTextRange,
  requireTypeLayer,
  rerenderText,
  restyleRange,
  styleAt,
  textIndexAt,
  textOutlines,
  textMatrix,
  textRange,
  toTextSpace,
  transformTypeLayer,
  typeAsPixelLayer,
  typeLayerName,
  updateTypeLayer,
  type TextEnv,
  type TextLayout,
  type TextShaper,
} from './layers/text';
import { createCanvasTextShaper } from './layers/text-shapers';
import type { VectorSubpath } from '../vector/types';
import {
  addSmartFilter as addSmartFilterOp,
  contentsSurface,
  convertToSmartObject as convertToSmartObjectOp,
  copySmartObject as copySmartObjectOp,
  documentContents,
  instancesOf,
  isContentsDecoded,
  moveSmartFilter as moveSmartFilterOp,
  normalizeSmartFilter,
  offsetSmartObject,
  placementGeometry,
  rasterContents,
  rasterizeSmartObject as rasterizeSmartObjectOp,
  removeSmartFilter as removeSmartFilterOp,
  replaceContents as replaceContentsOp,
  requireSmartObject,
  setSmartFilterMask as setSmartFilterMaskOp,
  setSmartFiltersEnabled as setSmartFiltersEnabledOp,
  setSmartPlacement,
  updateSmartFilter as updateSmartFilterOp,
  withFilterMaskSurface,
  activeEffectSmartFilters,
  isSmartSurfaceIncomplete,
  rerender as rerenderSmartObject,
} from './layers/smart';
import { EffectsSlot, resolveEffectValues } from '../effects/helpers';
import type { EffectDescription, EffectProvider, EffectValue } from '../effects/types';
import { ImageEffectsEngine, checkImageEffectPlace, effectPixelsToSurface, type ImageEffectPlace } from './effects';
import {
  BACKGROUND_LAYER_ID,
  BACKGROUND_LAYER_NAME,
  BLUR_FILTER_ID,
  DEVELOP_FILTER_ID,
  adjustmentNodeFromLegacy,
  annotationLayerFor,
  annotationLayerName,
  annotationOfLayer,
  depthRasterMask,
  developTarget,
  isDefaultDepthMask,
  layersFromLegacy,
  legacyMaskOf,
  legacyView,
  rasterMaskFromLegacy,
  type LayerStack,
} from './layers/migrate';
import {
  LAYERED_SCHEMA_VERSION,
  deserializeLayers,
  deserializePatterns,
  encodeSurface,
  serializePatterns,
  resolveExternalAssets,
  serializeLayers,
  serializeLayersExternal,
  type ImageEditorAssetStore,
  type SerializedLayeredImageEditorState,
} from './layers/serialize';
import { LayerCompositor, compositeDeep, type CompositorSources } from './layers/compositor';
import {
  SurfaceDraft,
  TILE,
  collectTiles,
  contentBounds,
  emptySurface,
  packRgba,
  readPixel,
  readRegion,
  solidSurface,
  surfaceFromPixels,
  tilesInRect,
  translateSurface,
  writeRegion,
  type PixelSurface,
  type Tile,
  type TiledSurface,
  type TileKey,
  TiledSurface as TiledSurfaceClass,
  finishTile,
  tileCoord,
  tileKey,
} from '../raster/surface';
import { convertSurfaceDepth, deepTile, isBitDepth, keepDeepSamples, proxyOf, readDeepRegion, srgbDecode, srgbEncode, surfaceFromDeepPixels, tileSamples, to16From8, type BitDepth, type DeepSamples } from '../raster/deep';
import { workingToSamples } from '../raster/deep-compositor';
import {
  LayerOperationError,
  addLayerEffect as addLayerEffectOp,
  addLayerFilter as addLayerFilterOp,
  layerEffectsOf,
  removeLayerEffect as removeLayerEffectOp,
  setLayerEffects as setLayerEffectsOp,
  setLayerEffectsEnabled as setLayerEffectsEnabledOp,
  updateLayerEffect as updateLayerEffectOp,
  duplicateLayer as duplicateLayerOp,
  groupLayers as groupLayersOp,
  moveLayer as moveLayerOp,
  normalizeFilter,
  offsetLayer as offsetLayerOp,
  parseBlend,
  placeLayer,
  removeLayer as removeLayerOp,
  removeLayerFilter as removeLayerFilterOp,
  requireLayer,
  requireUnlocked,
  setLayerMask as setLayerMaskOp,
  setLayerProperties as setLayerPropertiesOp,
  ungroupLayer as ungroupLayerOp,
  unionRect,
  updateLayerFilter as updateLayerFilterOp,
  type LayerPlacement,
  type LayerProperties,
} from './layers/ops';
import { coveringRect } from './layers/render';
import { parsePaintSource, PaintSourceError, resolvePaintGradient, type PaintSource } from '../paint/gradient-paint';
import {
  CoverageMap,
  DEFAULT_BRUSH,
  DEFAULT_MIXER,
  EMPTY_MIXER_LOAD,
  DEFAULT_RETOUCH,
  MixerStroke,
  RegionPixelSource,
  TransformedPixelSource,
  cloneSamplePoint,
  isIdentityCloneTransform,
  IDENTITY_CLONE_TRANSFORM,
  type CloneTransform,
  retouchFilter,
  RetouchDabStroke,
  StrokeCoverage,
  TilePixelSource,
  applyRetouchToTile,
  applyToneToDeepTile,
  applyStrokeToDeepTile,
  applyStrokeToTile,
  cleanMixer,
  healPixels,
  loadMixer,
  normalizeBrush,
  normalizeMixer,
  normalizeRetouch,
  readSourceRegion,
  rgbaViewOfGrey,
  smudgeEffect,
  spongeEffect,
  spotHealPixels,
  spotHealWindow,
  toneOf,
  type BrushSettings,
  type MixerLoad,
  type MixerSettings,
  type MixerTarget,
  type PaintTileTarget,
  type PixelSource,
  type RetouchApply,
  type RetouchPaint,
  type RetouchSettings,
  type StrokeApply,
  type StrokePoint,
} from '../paint';
import { base64ToBytes, bytesToBase64, decodePng, encodePng, isPng, parseDataUrl, pngDataUrl } from '../raster/png';
import type { Interpolation } from '../raster/transform';
import { getAnnotationBounds } from './geometry';
import { importPsd, type PsdImportResult } from './psd/import';
import { exportPsd, prepareNestedLayers, smartContentsFile } from './psd/export';
import { BROWSER_IMAGE_TYPES } from './psd/smart';
import { FreeTransformSession, type FreeTransformHost, type FreeTransformInit, type FreeTransformResult } from './free-transform';
import {
  anchorPoint,
  applyParams,
  cornersFromMatrix,
  describeTransform,
  flipCorners,
  identityTransform,
  matrixFromParams,
  transformedBox,
  isValidWarp,
  presetWarp,
  type AffineMatrix,
  type Quad,
  type TransformParams,
  type WarpMesh,
  type WarpPreset,
} from './transform';
import { WARP_STYLES } from '../geom/warp';
import { INTENTS, Transform, builtinProfile, canBeDestination, writeJpegIcc, writePngIcc, type BuiltinProfileId, type ColorSpace, type Intent, type Profile } from '../cms';
import {
  DEFAULT_PROOF,
  colorModePlanes,
  colorModePlanes16,
  convertColorFields,
  convertSurfaceColors,
  deserializeColorMode,
  effectiveProof,
  serializeColorMode,
  type DocumentColorMode,
  deserializeColorProfile,
  displayTransform,
  documentProfile,
  isSrgb,
  profileBytes,
  resolveProfile,
  serializeColorProfile,
  type DocumentColorProfile,
  type ProofSetup,
} from './color-management';
import { applyMatrix, multiplyMatrices, rotateMatrix, translateMatrix } from '../geom/affine';
import type { EffectPattern } from '../raster/effects/patterns';
import { DEFAULT_GLOBAL_LIGHT, effectsMargin, type GlobalLight, type LayerEffect, type LayerEffectKind, type LayerEffects } from '../raster/effects/model';

/** What `getSmartObject` reports. */
export interface SmartObjectInfo {
  layerId: string;
  contents: {
    /** Shared by linked instances. */
    id: string;
    name: string;
    kind: 'raster' | 'document';
    /** Pixel size of the contents. */
    width: number;
    height: number;
    /** False for a file that could not be decoded here (the layer shows its stored pixels). */
    decoded: boolean;
    /** The type of the file the contents came from (`psb`, `png`, `jpg`, …), or `null`. */
    fileType: string | null;
    /** The external file of linked contents, or `null` for embedded ones. */
    linkedPath: string | null;
    /** Every smart object placed from these contents (this one included), bottom first. */
    instances: string[];
    /** Layers in a nested document (0 for raster contents). */
    layerCount: number;
  };
  placement: {
    /** Where the contents' corners land: top-left, top-right, bottom-right, bottom-left (document pixels). */
    corners: Quad;
    /** The warp mesh in contents pixels, or `null`. */
    warp: WarpMesh | null;
    interpolation: Interpolation;
    /** False for distort, perspective and warp (then only corners and bounds describe it). */
    affine: boolean;
    /** Percent of the contents' own size. */
    scaleX: number;
    scaleY: number;
    rotate: number;
    skewX: number;
    /** Where the contents' centre is (document pixels). */
    center: { x: number; y: number };
    /** Bounds of the placed outline. */
    bounds: CropBox | null;
  };
  smartFilters: {
    enabled: boolean;
    /** Bottom (applied first) to top. Photoshop filters we keep but do not draw have kind `psd`. */
    filters: Array<Record<string, unknown>>;
    mask: { enabled: boolean; linked: boolean; density: number; feather: number; bounds: CropBox | null; defaultValue: number } | null;
  };
  /** Document bounds of the rendered pixels. */
  bounds: CropBox | null;
}

/** The document set aside while smart object contents are open. */
interface SavedDocument {
  state: ImageEditorState;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  initial: HistoryEntry;
  element: CanvasImageSource | null;
  samplePixels: PixelBuffer | null;
  samplePixelsOverride: boolean;
  psdResolution: number | undefined;
}

/** Latest serialized schema version (`3`: layers). Documents with the old shape still write 1 or 2. */
export const IMAGE_EDITOR_SCHEMA_VERSION = LAYERED_SCHEMA_VERSION;

/** Changes to an adjustment layer; `params` is merged into the current parameters. */
export interface AdjustmentLayerUpdate<K extends AdjustmentKind = AdjustmentKind> {
  params?: Partial<AdjustmentParamsMap[K]>;
  enabled?: boolean;
  opacity?: number;
  blend?: BlendMode;
  name?: string;
  /** A layer mask, or `null` to remove it. */
  mask?: AdjustmentLayerMask | null;
}

/** Options shared by the selection commands. */
export interface SelectionCommandOptions {
  /** How the result combines with the current selection (default `replace`). */
  mode?: SelectionMode;
  /** Feather the new shape by this many pixels before combining (default 0). */
  feather?: number;
}

/** Where an AI result goes (see `applyInpaintedImage`, `applyBackgroundRemovedImage`). */
export interface AIResultOptions {
  /** `new-layer`: a new layer (inpainting) or a mask (background removal); `replace`: the Background's pixels. Default: by `isMultiLayer`. */
  target?: 'new-layer' | 'replace';
}

/** Where the selection tools read colours from. */
export interface SampleOptions {
  /**
   * `composite` (default): the image, as before (with several layers: the composite of the pixel
   * layers, or with `sampleMerged` of every layer); `active-layer`: only the active pixel layer.
   */
  sample?: 'composite' | 'active-layer';
  /** Sample the adjusted image (base adjustments and layers) instead of the source pixels. */
  sampleMerged?: boolean;
  /** Pixels to use instead of reading the source image (natural size, RGBA). */
  pixels?: PixelBuffer;
}

/** A new adjustment layer: its kind plus optional initial values and position. */
export interface AdjustmentLayerInit<K extends AdjustmentKind = AdjustmentKind> extends AdjustmentLayerUpdate<K> {
  kind: K;
  id?: string;
  /** Put the new layer directly above this layer (in its group). */
  aboveId?: string;
  /** Put the new layer at the top of this group. */
  parentId?: string;
}

/** A new pixel layer: empty, a solid colour over the canvas, or given pixels, plus its properties and position. */
export interface PixelLayerInit extends LayerPlacement {
  id?: string;
  name?: string;
  /** Fill the canvas with this colour (`#rgb`, `#rrggbb`, `#rrggbbaa` or `[r, g, b, a?]` 0..255). */
  color?: string | number[];
  /** RGBA pixels placed at `x`, `y` (document pixels). */
  pixels?: PixelBuffer;
  x?: number;
  y?: number;
  visible?: boolean;
  /** 0..1 (default 1). */
  opacity?: number;
  fillOpacity?: number;
  blend?: BlendMode;
}

/** The paint tools' options (view state). */
export interface PaintOptions {
  brush: BrushSettings;
  /** `#rrggbb`: what the brush and Fill paint. */
  foreground: string;
  /** `#rrggbb`: what the eraser paints on transparency-locked layers and masks. */
  background: string;
  /**
   * What the brush paints: the foreground colour (`{ type: 'color' }`), or gradient paint that
   * changes colour as the stroke goes (`@pixerate/editor/paint` `PaintSource`; its `paint` /
   * `secondary` stops are the foreground and background colours). Setting `foreground` goes back
   * to one colour.
   */
  paint: PaintSource;
  /** Mixer Brush options (wet, load, mix, load / clean each stroke, RGB or pigment mixing). */
  mixer: MixerSettings;
  /** What the Mixer Brush carries now: its reservoir, how much is left and the picked-up colour. */
  mixerLoad: MixerLoad;
  /** The retouching tools' options (aligned, sample, spot healing type, tone range, exposure, sponge mode, smudge strength). */
  retouch: RetouchSettings;
  /** The Clone Stamp and Healing Brush source point (Alt-click), or `null` when none is set. */
  cloneSource: CloneSource | null;
  /** Clone Source panel: how cloned pixels are scaled, flipped and rotated (identity by default). */
  cloneTransform: CloneTransform;
}

/** Where the Clone Stamp and Healing Brush sample from. */
export interface CloneSource {
  /** The source point, document pixels. */
  x: number;
  y: number;
  /** With Aligned on: the offset (source − stroke start) the first stroke fixed, kept for the next strokes; `null` until a stroke has used the point. */
  offset: { x: number; y: number } | null;
}

/**
 * The geometry of one shape component: a live shape (`{ kind: 'rect' | 'ellipse' | 'polygon' |
 * 'star' | 'line', … }`, see `LiveShape`) or subpaths (`[{ anchors: [{ x, y, in?, out? }],
 * closed }]` or SVG path data), and how it combines with the components below it.
 */
export interface ShapeGeometryInput {
  shape?: LiveShape | Record<string, unknown>;
  subpaths?: VectorSubpath[] | string;
  /** Default `combine`. */
  op?: ShapeOperation;
}

/** A stroke as tools and UIs give it: any `ShapeStroke` fields, the paint as a colour string or a paint (or `color`). */
export type ShapeStrokeInput = Omit<Partial<ShapeStroke>, 'paint'> & { paint?: ShapePaint | string; color?: string };

/** A new shape layer: its geometry (one component, or `components`), fill and stroke. */
export interface ShapeLayerInit extends ShapeGeometryInput, LayerPlacement {
  /** Several components instead of `shape` / `subpaths`, bottom first. */
  components?: ShapeGeometryInput[];
  name?: string;
  /** A colour string or a paint; `null` for none. Default the foreground colour (none for a stroke-only open path). */
  fill?: ShapePaint | string | null;
  /** `{ width, paint, align?, cap?, join?, miterLimit?, dashes?, dashOffset? }`, or `null` / missing for none. */
  stroke?: ShapeStrokeInput | null;
  fillRule?: ShapeFillRule;
  opacity?: number;
  blend?: BlendMode;
}

/** A shape layer as tools and panels read it. */
export interface ShapeLayerInfo {
  id: string;
  name: string;
  /** Bottom to top; `index` is what component edits take. */
  components: Array<{ index: number; op: ShapeOperation; live: LiveShape | null; subpaths: VectorSubpath[]; bounds: CropBox | null }>;
  fillRule: ShapeFillRule;
  fill: ShapePaint | null;
  stroke: ShapeStroke | null;
  /** Bounds of the paths (document pixels, not rounded), or `null` when empty. */
  geometryBounds: CropBox | null;
  /** Bounds of the rendered pixels (stroke and antialiasing included). */
  bounds: CropBox | null;
  /** The annotation id while the layer is still the annotation it was migrated from. */
  annotationId?: string;
}

/** A new type layer: its text, where it goes, and its character and paragraph style. */
export interface TextLayerInit extends LayerPlacement {
  text: string;
  /**
   * Document x, y of the text's origin: point text's first baseline at its alignment edge (left
   * edge for left-aligned, centre for centred, right edge for right-aligned); a paragraph box's
   * top-left.
   */
  x: number;
  y: number;
  /** Paragraph (area) text: wrap inside a `width × height` box (pixels). Missing: point text. */
  box?: { width: number; height: number };
  /** Character style of the whole text (default 24 px sans-serif, the foreground colour). */
  style?: Partial<TextStyle>;
  paragraph?: ParagraphStyle;
  /** Degrees clockwise about the origin. */
  rotation?: number;
  name?: string;
  opacity?: number;
  blend?: BlendMode;
}

/** A type layer as tools and panels read it. Ranges are UTF-16 code units, `end` exclusive. */
export interface TypeLayerInfo {
  id: string;
  name: string;
  text: string;
  runs: Array<{ start: number; end: number; style: TextStyle }>;
  paragraphs: Array<{ start: number; end: number; style: ParagraphStyle }>;
  frame: TypeLayer['frame'];
  /** Text space → document. */
  transform: AffineMatrix;
  /** Laid-out lines: text range, baseline (text space) and width; empty without a shaper. */
  lines: Array<{ start: number; end: number; baseline: number; width: number }>;
  /** Rendered bounds in the document. */
  bounds: CropBox | null;
  /** Families drawn with a fallback because they are missing here. */
  missingFonts: string[];
  /** `live`: drawn here from the text; `stored`: pixels kept from a file until the next edit. */
  rendering: 'live' | 'stored';
  annotationId?: string;
}

/** The retouching tools (see `@pixerate/editor/paint`'s retouch module). */
export type RetouchTool = 'clone' | 'heal' | 'spot-heal' | 'smudge' | 'dodge' | 'burn' | 'sponge' | 'blur' | 'sharpen' | 'history';

export const RETOUCH_TOOLS: readonly RetouchTool[] = ['clone', 'heal', 'spot-heal', 'smudge', 'dodge', 'burn', 'sponge', 'blur', 'sharpen', 'history'];

export const isRetouchTool = (tool: unknown): tool is RetouchTool => RETOUCH_TOOLS.includes(tool as RetouchTool);

/** Paint tools a stroke can use. */
export type StrokeTool = 'brush' | 'eraser' | 'mixer' | RetouchTool;

const STROKE_TOOLS: readonly StrokeTool[] = ['brush', 'eraser', 'mixer', ...RETOUCH_TOOLS];

/** A stroke: tool, target (default the active layer and target) and brush / colour overrides. */
export interface StrokeInit {
  tool?: StrokeTool;
  layerId?: string;
  channel?: LayerTarget;
  /** Overrides of the paint options' brush. */
  brush?: Partial<BrushSettings>;
  /**
   * Paint colour (default the foreground). Masks take its grey value. For the mixer, the colour
   * the reservoir is loaded with: given, it loads the brush whatever `loadEachStroke` says.
   */
  color?: string | number[];
  /**
   * Brush only: what this stroke paints with instead of the paint options' paint: a colour, or
   * gradient paint (`@pixerate/editor/paint` `PaintSource`). A colour here is the same as `color`.
   */
  paint?: PaintSource | string;
  /** Overrides of the paint options' Mixer Brush settings (tool `mixer`). */
  mixer?: Partial<MixerSettings>;
  /** Eraser colour on locked transparency / masks (default the background). */
  background?: string | number[];
  /** Overrides of the paint options' retouch settings (the retouching tools). */
  retouch?: Partial<RetouchSettings>;
  /**
   * Clone Stamp / Healing Brush: the source point for this stroke (document pixels). Given, it
   * becomes the clone source (as an Alt-click), so the stroke starts its offset afresh.
   */
  source?: { x: number; y: number };
  /** Kept with the stroke for replays (v1 brushes have no jitter). */
  seed?: number;
}

export interface FillOptions {
  layerId?: string;
  channel?: LayerTarget;
  /** Default the foreground colour. */
  color?: string | number[];
  /** 0..1 (default 1). */
  opacity?: number;
  blend?: BlendMode;
  /** Limit to the selection when there is one (default true). */
  useSelection?: boolean;
}

/** What a stroke, fill or clear changed. */
export interface PaintStrokeResult {
  layerId: string;
  channel: LayerTarget;
  /** Document rectangle that changed (null when nothing did). */
  bounds: CropBox | null;
  dabs: number;
  /** The Mixer Brush's load after the stroke (tool `mixer` only). */
  mixerLoad?: MixerLoad;
  /**
   * Clone Stamp / Healing Brush: the offset used (source − first stroke point, whole pixels) and
   * where the stroke's first point sampled.
   */
  clone?: { offset: { x: number; y: number }; source: { x: number; y: number }; aligned: boolean };
  /** Spot Healing: the offset of the patch it copied, or `null` when it filled smoothly. */
  spotHeal?: { offset: { x: number; y: number } | null };
}

/** An opaque pre-stroke history snapshot. */
export type HistoryEntryHandle = { readonly __historyEntry: unique symbol };

/** Composites `coverage` into the tiles of `base` under `rects` (document space), returning the new surface. */
function paintCoverageInto(base: TiledSurface, coverage: CoverageMap, apply: StrokeApply, rects: CropBox[], depth: 16 | 32 | null = null): TiledSurface {
  const tiles = new Map(base.tiles);
  const done = new Set<TileKey>();
  for (const r of rects) {
    for (const t of tilesInRect({ x: r.x - apply.offset.x, y: r.y - apply.offset.y, width: r.width, height: r.height })) {
      const key = tileKey(t.tx, t.ty);
      if (done.has(key)) continue;
      done.add(key);
      if (depth) {
        const ch = base.channels;
        const d = applyStrokeToDeepTile(coverage, tileSamples(base.tiles.get(key), ch, depth, base.defaultValue), t.tx, t.ty, apply, { channels: ch });
        const tile = deepTile(d, ch, base.defaultValue);
        if (tile) tiles.set(key, tile);
        else tiles.delete(key);
        continue;
      }
      const src = base.tiles.get(key)?.data ?? defaultTile(base);
      const data = applyStrokeToTile(coverage, src, base.channels, t.tx, t.ty, apply);
      const tile = finishTile(data, base.channels, base.defaultValue);
      if (tile) tiles.set(key, tile);
      else tiles.delete(key);
    }
  }
  return new TiledSurfaceClass(base.channels, tiles, base.defaultValue);
}

function defaultTile(s: TiledSurface): Uint8ClampedArray {
  const d = new Uint8ClampedArray(TILE * TILE * s.channels);
  if (s.defaultValue) d.fill(s.defaultValue);
  return d;
}

/** How a Mixer Brush stroke starts (see `PaintStrokeSession`). */
export interface MixerStrokeInit {
  /** Makes the stroke over the session's live pixels. */
  create(pixels: MixerTarget): MixerStroke;
  /** Stores the brush load when the stroke ends and returns it (after any clean). */
  end(load: MixerLoad): MixerLoad;
}

/** A stroke that paints dab by dab into live pixels (Mixer Brush, Smudge, Sponge). */
interface LiveDabStroke {
  push(points: readonly StrokePoint[]): CropBox[];
  finish(last?: StrokePoint): CropBox[];
  readonly bounds: CropBox | null;
  readonly dabCount: number;
}

/**
 * How a retouching stroke starts (see `PaintStrokeSession`): either coverage-based (Clone Stamp,
 * Healing Brush, Spot Healing, Dodge, Burn: `coverage` composited with `paint()` over the
 * pre-stroke pixels, optionally replaced by `finalPaint` when the stroke ends) or sequential
 * (`create`: dabs over live pixels, Smudge and Sponge).
 */
export type RetouchStrokeInit =
  | {
      kind: 'coverage';
      coverage: StrokeCoverage;
      apply: RetouchApply;
      /** Called with the first point before any dab is shown (the clone offset is fixed here). */
      start(first: StrokePoint): void;
      /** What the coverage lays while the stroke is drawn. */
      paint(): RetouchPaint;
      /** What it lays once the stroke ends, from the whole coverage (healing); `null` keeps `paint()`. */
      finalPaint?(coverage: CoverageMap): RetouchPaint | null;
      /** Extra result fields. */
      result?(): Partial<PaintStrokeResult>;
    }
  | {
      kind: 'dabs';
      /** Makes the stroke over the session's live pixels (RGBA, or an RGBA view of a mask). */
      create(pixels: PaintTileTarget): LiveDabStroke;
      result?(): Partial<PaintStrokeResult>;
    };

/**
 * A stroke in progress (see `beginStroke`): `push` input points as they arrive, then `end` (one
 * undo step) or `cancel`. Brush and eraser strokes build up a coverage map composited over the
 * pre-stroke pixels; Mixer Brush strokes paint dab by dab into the live pixels, so each dab picks
 * up what the dabs before it laid down. Retouching strokes take one of the two shapes.
 */
export class PaintStrokeSession {
  private readonly before: HistoryEntryHandle;
  private readonly base: TiledSurface;
  private readonly live: Map<TileKey, Tile>;
  private readonly touched = new Set<TileKey>();
  private readonly stroke: StrokeCoverage | null;
  private readonly mixer: LiveDabStroke | null;
  private readonly mixerInit: MixerStrokeInit | null = null;
  private readonly retouch: RetouchStrokeInit | null = null;
  /** Writes a mask's RGBA view back (sequential retouching on a mask). */
  private readonly flushView: (() => void) | null = null;
  private started = false;
  /** Mixer tiles written since the last update: they get new tile objects so the compositor sees them change. */
  private readonly fresh = new Set<TileKey>();
  private last: StrokePoint | null = null;
  private closed = false;
  /** Brush and eraser strokes on a 16- or 32-bit document: the deep samples of each touched tile. */
  private readonly deep: 16 | 32 | null;
  private readonly liveDeep = new Map<TileKey, DeepSamples>();
  /**
   * Mixer Brush, Smudge and Sponge on a 16- or 32-bit layer: they read and write float working
   * tiles on the 8-bit 0..255 sRGB-encoded scale, which keep the fractions bytes would round away.
   */
  private readonly dabDeep: 16 | 32 | null;
  private readonly work = new Map<TileKey, Float32Array>();
  private readonly workRead = new Map<TileKey, Float32Array | null>();

  constructor(
    private readonly controller: ImageEditorController,
    readonly target: { id: string; channel: LayerTarget; surface: TiledSurface },
    stroke: StrokeCoverage | MixerStrokeInit | RetouchStrokeInit,
    private readonly apply: StrokeApply,
    /** Composite brush / eraser strokes at this bit depth (layers only); `null` for 8 bits. */
    depth: 16 | 32 | null = null
  ) {
    const coverage = stroke instanceof StrokeCoverage || ('kind' in stroke && stroke.kind === 'coverage');
    // Masks paint at depth with the brush and eraser (retouching on a mask stays 8-bit).
    this.deep = depth && coverage && (target.surface.channels === 4 || stroke instanceof StrokeCoverage) ? depth : null;
    this.dabDeep = depth && !coverage && target.surface.channels === 4 ? depth : null;
    this.before = controller._captureForStroke();
    this.base = target.surface;
    this.live = new Map(this.base.tiles);
    if (stroke instanceof StrokeCoverage) {
      this.stroke = stroke;
      this.mixer = null;
    } else if ('kind' in stroke && stroke.kind === 'coverage') {
      this.stroke = stroke.coverage;
      this.mixer = null;
      this.retouch = stroke;
    } else if ('kind' in stroke) {
      this.stroke = null;
      this.retouch = stroke;
      if (this.base.channels === 1) {
        const view = rgbaViewOfGrey(this.mixerPixels());
        this.mixer = stroke.create(view.target);
        this.flushView = view.flush;
      } else this.mixer = stroke.create(this.mixerPixels());
    } else {
      this.stroke = null;
      this.mixer = stroke.create(this.mixerPixels());
      this.mixerInit = stroke;
    }
  }

  /** The pre-stroke tile as a float working tile (cached; `null`: transparent). */
  private readWork(key: TileKey): Float32Array | null {
    if (!this.workRead.has(key)) this.workRead.set(key, workTileOf(this.base.tiles.get(key)));
    return this.workRead.get(key)!;
  }

  /** Clone, healing and the spot-heal trail at depth: `paint` through the coverage on the float working tile. */
  private retouchDeepTile(key: TileKey, tx: number, ty: number, paint: RetouchPaint, options: { into?: Float32Array; region?: CropBox }): DeepSamples {
    const r = this.retouch as Extract<RetouchStrokeInit, { kind: 'coverage' }>;
    const read = this.readWork(key);
    const out = applyRetouchToTile(this.stroke!.coverage, read ?? new Float32Array(TILE * TILE * 4), 4, tx, ty, paint, r.apply, options);
    this.work.set(key, out);
    const d = deepOfWorkTile(out, this.deep!, read, this.base.tiles.get(key));
    this.liveDeep.set(key, d);
    this.live.set(key, { data: proxyOf(d, 4), uniform: null, deep: d });
    return d;
  }

  /** The new tile of a coverage stroke over the pre-stroke tile `src`. */
  private compositeTile(src: Uint8ClampedArray, tx: number, ty: number, options: { into?: Uint8ClampedArray; region?: CropBox } = {}, paint?: RetouchPaint): Uint8ClampedArray {
    const r = this.retouch;
    if (r && r.kind === 'coverage') return applyRetouchToTile(this.stroke!.coverage, src, this.base.channels, tx, ty, paint ?? r.paint(), r.apply, options);
    return applyStrokeToTile(this.stroke!.coverage, src, this.base.channels, tx, ty, this.apply, options);
  }

  /** The live pixels a mixer stroke reads and writes; base tiles are copied on first write. */
  private mixerPixels(): MixerTarget {
    const a = this.apply;
    const depth = this.dabDeep;
    if (depth) {
      const read = (key: TileKey) => this.readWork(key);
      return {
        offset: a.offset,
        lockTransparency: a.lockTransparency,
        selection: a.selection,
        readTile: (tx, ty) => {
          const key = tileKey(tx, ty);
          return this.work.get(key) ?? read(key);
        },
        writeTile: (tx, ty) => {
          const key = tileKey(tx, ty);
          if (!this.touched.has(key)) {
            this.work.set(key, read(key)?.slice() ?? new Float32Array(TILE * TILE * 4));
            this.touched.add(key);
          }
          this.fresh.add(key);
          return this.work.get(key)!;
        },
      };
    }
    return {
      offset: a.offset,
      lockTransparency: a.lockTransparency,
      selection: a.selection,
      readTile: (tx, ty) => this.live.get(tileKey(tx, ty))?.data ?? (this.base.defaultValue ? defaultTile(this.base) : null),
      writeTile: (tx, ty) => {
        const key = tileKey(tx, ty);
        if (!this.touched.has(key)) {
          const src = this.base.tiles.get(key)?.data ?? defaultTile(this.base);
          this.live.set(key, { data: new Uint8ClampedArray(src), uniform: null });
          this.touched.add(key);
        }
        this.fresh.add(key);
        return this.live.get(key)!.data;
      },
    };
  }

  get layerId(): string {
    return this.target.id;
  }

  /** Adds input points (document pixels); the stack shows the stroke so far. */
  push(points: readonly StrokePoint[]): void {
    if (this.closed || !points.length) return;
    if (!this.started) {
      this.started = true;
      if (this.retouch?.kind === 'coverage') this.retouch.start(points[0]);
    }
    this.last = points[points.length - 1];
    const rects = this.mixer ? this.mixer.push(points) : this.stroke!.push(points);
    this.flushView?.();
    this.update(rects);
  }

  private update(rects: CropBox[]): void {
    if (!rects.length) return;
    const ch = this.base.channels;
    if (this.mixer) {
      if (this.dabDeep) {
        // Show the working tiles as deep tiles (their 8-bit rendering on screen).
        for (const key of this.fresh) {
          const d = deepOfWorkTile(this.work.get(key)!, this.dabDeep, this.workRead.get(key) ?? null, this.base.tiles.get(key));
          this.liveDeep.set(key, d);
          this.live.set(key, { data: proxyOf(d, 4), uniform: null, deep: d });
        }
      } else for (const key of this.fresh) this.live.set(key, { data: this.live.get(key)!.data, uniform: null });
      this.fresh.clear();
      this.controller._strokeUpdate(this.target.id, this.target.channel, new TiledSurfaceClass(ch, new Map(this.live), this.base.defaultValue), rects);
      return;
    }
    const stroke = this.stroke!;
    // Per target tile, the union of the new dabs inside it: only that part is recomputed.
    const regions = new Map<TileKey, { tx: number; ty: number; r: CropBox }>();
    for (const r of rects) {
      for (const t of tilesInRect({ x: r.x - this.apply.offset.x, y: r.y - this.apply.offset.y, width: r.width, height: r.height })) {
        const key = tileKey(t.tx, t.ty);
        const cur = regions.get(key);
        regions.set(key, { tx: t.tx, ty: t.ty, r: cur ? unionRect(cur.r, r)! : r });
      }
    }
    for (const [key, { tx, ty, r }] of regions) {
      if (this.deep) {
        // At 16 or 32 bits: composite the deep samples and show their 8-bit rendering.
        const rt = this.retouch;
        const paint = rt?.kind === 'coverage' ? rt.paint() : null;
        if (paint && paint.kind !== 'tone') {
          const prevWork = this.touched.has(key) ? this.work.get(key) : undefined;
          this.touched.add(key);
          this.retouchDeepTile(key, tx, ty, paint, prevWork ? { into: prevWork, region: r } : {});
          continue;
        }
        const src = tileSamples(this.base.tiles.get(key), ch, this.deep, this.base.defaultValue);
        const prev = this.touched.has(key) ? this.liveDeep.get(key) : undefined;
        this.touched.add(key);
        const opts = prev ? { into: prev, region: r, channels: ch } : { channels: ch };
        const d =
          rt?.kind === 'coverage' && paint?.kind === 'tone'
            ? applyToneToDeepTile(stroke.coverage, src, tx, ty, paint.tone, rt.apply, opts)
            : applyStrokeToDeepTile(stroke.coverage, src, tx, ty, this.apply, opts);
        this.liveDeep.set(key, d);
        this.live.set(key, { data: proxyOf(d, ch), uniform: null, deep: d });
        continue;
      }
      const src = this.base.tiles.get(key)?.data ?? defaultTile(this.base);
      const prev = this.touched.has(key) ? this.live.get(key)?.data : undefined;
      this.touched.add(key);
      const data = this.compositeTile(src, tx, ty, prev ? { into: prev, region: r } : {});
      this.live.set(key, { data, uniform: null });
    }
    this.controller._strokeUpdate(this.target.id, this.target.channel, new TiledSurfaceClass(ch, new Map(this.live), this.base.defaultValue), rects);
  }

  /** Finishes the stroke (one undo step) and returns what changed. */
  end(): PaintStrokeResult {
    if (this.closed) throw new LayerOperationError('This stroke has already ended.');
    const last = this.last ?? undefined;
    const rects = this.mixer ? this.mixer.finish(last) : this.stroke!.finish(last);
    this.flushView?.();
    this.update(rects);
    this.closed = true;
    const ch = this.base.channels;
    const r = this.retouch;
    if (r?.kind === 'coverage' && r.finalPaint) {
      // Healing: redo every touched tile from the pre-stroke pixels with the final paint.
      const final = r.finalPaint(this.stroke!.coverage);
      if (final) {
        for (const key of this.touched) {
          const { tx, ty } = tileCoord(key);
          if (this.deep) {
            this.retouchDeepTile(key, tx, ty, final, {});
            continue;
          }
          const src = this.base.tiles.get(key)?.data ?? defaultTile(this.base);
          this.live.set(key, { data: this.compositeTile(src, tx, ty, {}, final), uniform: null });
        }
      }
    }
    const tiles = new Map(this.base.tiles);
    let changed = false;
    for (const key of this.touched) {
      const live = this.live.get(key)!;
      const deep = this.liveDeep.get(key);
      const tile = deep ? deepTile(deep, ch, this.base.defaultValue) : finishTile(live.data, ch, this.base.defaultValue);
      const prev = this.base.tiles.get(key);
      if (tile) tiles.set(key, tile);
      else tiles.delete(key);
      if (!sameTile(prev, tile)) changed = true;
    }
    const surface = changed ? new TiledSurfaceClass(ch, tiles, this.base.defaultValue) : null;
    const mixerLoad = this.mixerInit ? this.mixerInit.end((this.mixer as MixerStroke).load) : undefined;
    this.controller._strokeCommit(this.before, this.target.id, this.target.channel, surface);
    const b = this.mixer ? this.mixer.bounds : this.stroke!.coverage.bounds;
    const result: PaintStrokeResult = { layerId: this.target.id, channel: this.target.channel, bounds: changed ? b : null, dabs: (this.mixer ?? this.stroke!).dabCount };
    if (mixerLoad) result.mixerLoad = mixerLoad;
    if (r?.result) Object.assign(result, r.result());
    return result;
  }

  /** Abandons the stroke and restores the layer. */
  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller._strokeCommit(this.before, this.target.id, this.target.channel, null);
  }
}

/**
 * A region of a surface as floats on the working tiles' 0..255 scale (RGBA sRGB-encoded, or one
 * coverage value per pixel): deep samples at `depth`, else the 8-bit values.
 */
function workRegionOf(surface: TiledSurface, rect: CropBox, depth: 16 | 32 | null): Float32Array {
  if (!depth) return Float32Array.from(readRegion(surface, rect));
  const d = readDeepRegion(surface, rect, depth);
  const out = new Float32Array(d.length);
  if (d instanceof Uint16Array) {
    for (let i = 0; i < d.length; i++) out[i] = d[i] / 257;
    return out;
  }
  const ch = surface.channels;
  for (let i = 0; i < d.length; i++) out[i] = (ch === 4 && (i & 3) !== 3 ? srgbEncode(d[i]) : d[i]) * 255;
  return out;
}

/** A layer tile as a float working tile on the 0..255 sRGB-encoded scale (`null`: transparent). */
function workTileOf(tile: Tile | undefined): Float32Array | null {
  if (!tile) return null;
  const d = tile.deep;
  const out = new Float32Array(TILE * TILE * 4);
  if (d instanceof Uint16Array) for (let i = 0; i < d.length; i++) out[i] = d[i] / 257;
  else if (d instanceof Float32Array) {
    for (let i = 0; i < d.length; i += 4) {
      out[i] = srgbEncode(d[i]) * 255;
      out[i + 1] = srgbEncode(d[i + 1]) * 255;
      out[i + 2] = srgbEncode(d[i + 2]) * 255;
      out[i + 3] = d[i + 3] * 255;
    }
  } else out.set(tile.data);
  return out;
}

/**
 * A float working tile back to deep samples at `depth` (16-bit clamps; 32-bit keeps colour above
 * 1). Pixels still equal to `read` (the tile as the stroke first read it) take `base`'s exact
 * samples, so the float round trip never touches pixels the tool left alone.
 */
function deepOfWorkTile(w: Float32Array, depth: 16 | 32, read: Float32Array | null, base: Tile | undefined): DeepSamples {
  const orig = read && base ? tileSamples(base, 4, depth, 0) : null;
  const out = depth === 16 ? new Uint16Array(w.length) : new Float32Array(w.length);
  for (let i = 0; i < w.length; i += 4) {
    if (orig && w[i] === read![i] && w[i + 1] === read![i + 1] && w[i + 2] === read![i + 2] && w[i + 3] === read![i + 3]) {
      out[i] = orig[i];
      out[i + 1] = orig[i + 1];
      out[i + 2] = orig[i + 2];
      out[i + 3] = orig[i + 3];
      continue;
    }
    if (depth === 16) {
      for (let c = 0; c < 4; c++) {
        const v = Math.round(w[i + c] * 257);
        out[i + c] = v <= 0 ? 0 : v >= 65535 ? 65535 : v;
      }
      continue;
    }
    out[i] = srgbDecode(w[i] / 255);
    out[i + 1] = srgbDecode(w[i + 1] / 255);
    out[i + 2] = srgbDecode(w[i + 2] / 255);
    const al = w[i + 3] / 255;
    out[i + 3] = al <= 0 ? 0 : al >= 1 ? 1 : al;
  }
  return out;
}

/**
 * `next` with deep samples kept on pixel layers (and their masks) an 8-bit operation rewrote from
 * `prev`: see `keepDeepSamples`. Layers whose surfaces did not change are returned as they are.
 */
function keepDeepLayers(prev: readonly ImageLayer[], next: ImageLayer[]): ImageLayer[] {
  const before = new Map<string, ImageLayer>();
  for (const l of flattenLayers(prev)) before.set(l.id, l);
  let out = next;
  for (const l of flattenLayers(next)) {
    const p = before.get(l.id);
    if (!p || p === l) continue;
    let layer: ImageLayer = l;
    if (l.type === 'pixel' && p.type === 'pixel' && l.surface !== p.surface) {
      const surface = keepDeepSamples(p.surface, l.surface);
      if (surface !== l.surface) layer = { ...l, surface };
    }
    const m = layer.mask;
    const pm = p.mask;
    if (m && pm && m.surface !== pm.surface) {
      const surface = keepDeepSamples(pm.surface, m.surface);
      if (surface !== m.surface) layer = { ...layer, mask: { ...m, surface } } as ImageLayer;
    }
    if (layer !== l) out = mapLayer(out, l.id, () => layer);
  }
  return out;
}

function sameTile(a: Tile | undefined, b: Tile | null): boolean {
  if (!a || !b) return !a && !b;
  if (a === b) return true;
  if (a.deep || b.deep) {
    if (!a.deep || !b.deep || a.deep.constructor !== b.deep.constructor || a.deep.length !== b.deep.length) return false;
    for (let i = 0; i < a.deep.length; i++) if (a.deep[i] !== b.deep[i]) return false;
    return true;
  }
  if (a.uniform !== null || b.uniform !== null) return a.uniform === b.uniform;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/** Where a new annotation goes. */
export interface AnnotationPlacement {
  /** Put the annotation layer directly above this layer (default: the top of the stack). */
  aboveId?: string;
}

/** The image a history entry was recorded against. */
interface SourceSnapshot {
  sourceUrl: string | null;
  element: CanvasImageSource | null;
  dimensions: ImageDimensions;
}

/**
 * Undo/redo entry: the document as immutable objects. Layers, surfaces, tiles and selections are
 * shared with the other entries and the current state, so an entry costs about the tiles it changed.
 */
interface HistoryEntry {
  layers: ImageLayer[];
  activeLayerId: string | null;
  activeTarget: LayerTarget;
  crop: CropBox | null;
  transform: ImageTransform;
  outputOpacity: number;
  legacyOutputBlur?: number;
  globalLight?: GlobalLight;
  patterns?: EffectPattern[];
  selection: SelectionMask | null;
  source: SourceSnapshot;
  bitDepth?: BitDepth;
  colorProfile?: DocumentColorProfile;
  colorMode?: DocumentColorMode;
}

export const DEFAULT_ADJUSTMENTS: ImageAdjustments = DEFAULT_ADJUSTMENTS_VALUES;

/**
 * Fills in defaults for stored adjustments. A stored object without `process` was saved before
 * process versions existed and keeps the legacy rendering.
 */
export function normalizeStoredAdjustments(stored: Partial<ImageAdjustments> | undefined | null): ImageAdjustments {
  if (!stored) return { ...DEFAULT_ADJUSTMENTS };
  const out: ImageAdjustments = {
    ...DEFAULT_ADJUSTMENTS,
    ...stored,
    process: normalizeProcessVersion(stored.process),
  };
  // Layers are deep-copied and cleaned; an empty or missing list is left out entirely.
  const layers = normalizeAdjustmentLayers(stored.layers);
  if (layers.length) out.layers = layers;
  else delete out.layers;
  return out;
}

const isLayered = (data: { version?: unknown } | null | undefined): data is SerializedLayeredImageEditorState =>
  Boolean(data && data.version === LAYERED_SCHEMA_VERSION && Array.isArray((data as { layers?: unknown }).layers));

/**
 * Brings a stored editor state of any schema version to a clean state of the same family:
 * version 1 (and a missing version) has no adjustment layers, version 2 has them, and both stay
 * in the document-level schema so old states load and render exactly as before. Version 3
 * (layers) is returned with its document fields cleaned. To lift a v1 / v2 state into layers,
 * use {@link migrateToLayeredState}.
 */
export function migrateSerializedImageEditorState(
  data: Partial<SerializedImageEditorState> & { version?: number }
): SerializedImageEditorState {
  if (isLayered(data)) {
    const out: SerializedLayeredImageEditorState = {
      ...data,
      crop: data.crop ? { ...data.crop } : null,
      transform: { ...DEFAULT_TRANSFORM, ...data.transform },
      opacity: typeof data.opacity === 'number' ? Math.min(1, Math.max(0, data.opacity)) : 1,
      assets: { ...(data.assets ?? {}) },
      activeLayerId: typeof data.activeLayerId === 'string' ? data.activeLayerId : null,
    };
    return out;
  }
  const legacy = data as Partial<LegacySerializedImageEditorState>;
  const adjustments = normalizeStoredAdjustments(legacy.adjustments);
  return {
    version: adjustments.layers?.length ? 2 : 1,
    crop: legacy.crop ? { ...legacy.crop } : null,
    transform: { ...DEFAULT_TRANSFORM, ...legacy.transform },
    adjustments: serializeAdjustments(adjustments),
    depthMask: {
      ...DEFAULT_DEPTH_MASK,
      ...legacy.depthMask,
      depthRange: [...(legacy.depthMask?.depthRange ?? DEFAULT_DEPTH_MASK.depthRange)] as [number, number],
    },
    annotations: JSON.parse(JSON.stringify(legacy.annotations ?? [])),
    ...(legacy.selection ? { selection: { ...legacy.selection } } : {}),
  };
}

/**
 * Lifts a stored state of any version into the layered schema (v3) for a canvas of
 * `width × height`: the source becomes the Background layer with the base sliders as its
 * `develop` filter and the depth mask as its parametric mask, adjustment layers go above it and
 * annotations on top (see `layersFromLegacy`).
 */
export function migrateToLayeredState(
  data: Partial<SerializedImageEditorState> & { version?: number },
  size: ImageDimensions
): SerializedLayeredImageEditorState {
  const clean = migrateSerializedImageEditorState(data);
  if (isLayered(clean)) return clean;
  const stack = layersFromLegacy(clean, Math.round(size.width), Math.round(size.height));
  const { layers, assets } = serializeLayers(stack.layers);
  const out: SerializedLayeredImageEditorState = {
    version: LAYERED_SCHEMA_VERSION,
    width: Math.round(size.width),
    height: Math.round(size.height),
    layers,
    assets,
    activeLayerId: null,
    crop: clean.crop,
    transform: clean.transform,
    opacity: stack.outputOpacity,
  };
  if (stack.legacyOutputBlur !== undefined) out.legacyOutputBlur = stack.legacyOutputBlur;
  if (clean.selection) out.selection = clean.selection;
  return out;
}

export const DEFAULT_TRANSFORM: ImageTransform = DEFAULT_TRANSFORM_VALUES;

export const DEFAULT_DEPTH_MASK: DepthMaskOptions = DEFAULT_DEPTH_MASK_VALUES;

const DEVELOP_KEYS = ['brightness', 'contrast', 'saturation', 'exposure', 'temperature', 'tint'] as const;

/**
 * ImageEditorController manages the complete lifecycle, canvas rendering pipeline,
 * tool interaction states, undo/redo history, serialization, and image export.
 */
export class ImageEditorController {
  private state: ImageEditorState;
  private renderer: ImageEditorRenderer;
  private imageElement: CanvasImageSource | null = null;
  private listeners = new Set<(state: ImageEditorState) => void>();
  private histogramListeners = new Set<(histogram: ImageHistogram | null) => void>();
  private onStateChange?: (state: ImageEditorState) => void;

  // History stacks
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private maxHistoryDepth: number;
  private maxHistoryBytes: number;
  private isApplyingHistory = false;
  private initialSnapshot: HistoryEntry;
  /** Pixels the selection tools sample (host-provided or read back from the source). */
  private samplePixels: PixelBuffer | null = null;
  private samplePixelsOverride = false;
  /** Decoded source pixels (the Background's surface), by the buffer or element they came from. */
  private sourceSurfaces = new WeakMap<object, PixelSurface>();
  private viewKey: unknown[] = [];
  /** For `compositePixels` and mask evaluation (the renderer keeps its own for the viewport). */
  private compositor = new LayerCompositor();
  /** The effects provider slot (see `setEffectsProvider`). */
  public readonly effects = new EffectsSlot();
  /** Renders provider effects: effect smart filter results and effect layers. */
  public readonly effectsEngine: ImageEffectsEngine = new ImageEffectsEngine({ slot: this.effects });
  private effectRefresh: 'none' | 'incomplete' | 'all' = 'none';

  constructor(options: ImageEditorOptions = {}) {
    // A new provider redraws every effect filter (after construction, for one given here); a
    // finished render redraws the surfaces waiting for it.
    this.effects.subscribe(() => this.queueEffectRefresh('all'));
    this.effectsEngine.subscribe(() => this.queueEffectRefresh('incomplete'));
    if (options.effects) this.effects.set(options.effects);
    this.maxHistoryDepth = options.maxHistoryDepth ?? 50;
    if (options.textShaper !== undefined) this.textShaperValue = options.textShaper;
    this.maxHistoryBytes = options.maxHistoryBytes ?? 512 * 1024 * 1024;
    this.onStateChange = options.onStateChange;
    this.renderer = new ImageEditorRenderer();
    this.renderer.onPreviewHistogram = (histogram) => {
      this.histogramListeners.forEach((l) => l(histogram));
    };
    this.renderer.layerSources = {
      surfaceOf: (layer) => this.surfaceOf(layer),
      sourceIsOpaque: () => this.sourceIsOpaque(),
      version: () => `${this.sourceVersion()}:${this.patternsVersion()}`,
      globalLight: () => this.state.globalLight,
      pattern: (id) => this.state.patterns?.find((p) => p.id === id) ?? null,
    };

    this.state = {
      sourceUrl: typeof options.image === 'string' ? options.image : null,
      imageDimensions: { width: 800, height: 600 },
      crop: null,
      transform: { ...DEFAULT_TRANSFORM },
      adjustments: { ...DEFAULT_ADJUSTMENTS },
      depthMask: { ...DEFAULT_DEPTH_MASK },
      annotations: [],
      selectedAnnotationId: null,
      activeTool: 'select',
      zoom: 1,
      pan: { x: 0, y: 0 },
      isOriginalCompared: false,
      selection: null,
      quickMask: false,
      layers: [],
      activeLayerId: null,
      activeTarget: 'pixels',
      outputOpacity: 1,
      paint: { brush: { ...DEFAULT_BRUSH }, foreground: '#000000', background: '#ffffff', paint: { type: 'color', color: '#000000' }, mixer: { ...DEFAULT_MIXER }, mixerLoad: EMPTY_MIXER_LOAD, retouch: { ...DEFAULT_RETOUCH }, cloneSource: null, cloneTransform: { ...IDENTITY_CLONE_TRANSFORM } },
      fit: options.fit ?? 'margin',
    };

    if (options.image instanceof Object && 'width' in options.image) {
      this.imageElement = options.image as CanvasImageSource;
      this.state.sourceUrl = (options.image as any).src || null;
      this.state.imageDimensions = {
        width: (options.image as any).naturalWidth || (options.image as any).width || 800,
        height: (options.image as any).naturalHeight || (options.image as any).height || 600,
      };
    }

    this.applyStored(options.initialState ?? {});
    if (options.initialState?.selection) {
      try {
        this.state.selection = normalizeSelection(deserializeSelection(options.initialState.selection));
      } catch {
        // A damaged selection is dropped; the rest of the state still loads.
      }
    }

    this.initialSnapshot = this.captureHistoryEntry();

    if (typeof options.image === 'string') {
      this.loadImage(options.image);
    }
  }

  // --- Image Loading ---

  /**
   * Loads a new source image and makes it the baseline that `reset()` returns to.
   * Does not record history; use `applyInpaintedImage` / `applyBackgroundRemovedImage`
   * for undoable source replacement.
   */
  public async loadImage(src: string | HTMLImageElement): Promise<void> {
    // Keep the URL visible synchronously (UI bindings compare against it while loading).
    this.abandonContents();
    if (typeof src === 'string') this.state.sourceUrl = src;
    const source = await this.resolveSource(src);
    const prev = this.state.imageDimensions;
    this.imageElement = source.element;
    this.state.sourceUrl = source.sourceUrl;
    this.state.imageDimensions = source.dimensions;
    if (!this.samplePixelsOverride) this.samplePixels = null;
    if (prev.width !== source.dimensions.width || prev.height !== source.dimensions.height) {
      // Masks lifted from v1 / v2 documents follow the image, as they did when they were resampled at render.
      this.state.layers = resizeLegacyMasks(this.state.layers, prev, source.dimensions);
    }
    this.dropMismatchedSelection();

    this.initialSnapshot = this.captureHistoryEntry();
    this.notify();
  }

  private async resolveSource(src: string | HTMLImageElement): Promise<SourceSnapshot> {
    if (typeof src === 'string') {
      try {
        const img = await this.renderer.imageCache.get(src);
        return {
          sourceUrl: src,
          element: img,
          dimensions: {
            width: img.naturalWidth || img.width || 800,
            height: img.naturalHeight || img.height || 600,
          },
        };
      } catch {
        // In SSR / non-DOM environments, retain current dimensions
        return { sourceUrl: src, element: null, dimensions: { ...this.state.imageDimensions } };
      }
    }
    return {
      sourceUrl: (src as any).src || null,
      element: src,
      dimensions: {
        width: src.naturalWidth || src.width || 800,
        height: src.naturalHeight || src.height || 600,
      },
    };
  }

  public getImageElement(): CanvasImageSource | null {
    return this.imageElement;
  }

  // --- State & Subscription ---

  public getState(): ImageEditorState {
    this.syncViews();
    return this.state;
  }

  public subscribe(listener: (state: ImageEditorState) => void): () => void {
    this.syncViews();
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Where layer pixels changed since the last viewport render, when only strokes changed them
   * (the renderer then recomposites just those rectangles); `'all'` after any other change.
   */
  private pendingDirty: CropBox[] | 'all' = 'all';

  private notify(strokeRects?: CropBox[]): void {
    if (strokeRects && this.pendingDirty !== 'all') this.pendingDirty.push(...strokeRects);
    else if (!strokeRects) this.pendingDirty = 'all';
    this.syncViews();
    this.syncDisplay();
    const currentState = { ...this.state };
    this.onStateChange?.(currentState);
    this.listeners.forEach((l) => l(currentState));
    // An undo or redo can bring back a smart object drawn while its effects were rendering.
    if (this.effects.provider) this.queueEffectRefresh('incomplete');
  }

  // --- Provider effects ---

  private queueEffectRefresh(kind: 'incomplete' | 'all'): void {
    const queued = this.effectRefresh !== 'none';
    if (kind === 'all' || this.effectRefresh === 'none') this.effectRefresh = kind;
    if (queued) return;
    queueMicrotask(() => {
      const all = this.effectRefresh === 'all';
      this.effectRefresh = 'none';
      this.refreshEffectSurfaces(all);
    });
  }

  /**
   * Renders smart objects with effect filters again: every one (`all`, after the provider changed)
   * or those drawn while a result was rendering, once it is in. A cache refresh: no undo step.
   */
  private refreshEffectSurfaces(all: boolean): void {
    let changed = false;
    const canvas = this.canvasSize;
    const walk = (layers: readonly ImageLayer[]): readonly ImageLayer[] => {
      let out: ImageLayer[] | null = null;
      layers.forEach((l, i) => {
        let next: ImageLayer = l;
        if (l.type === 'group') {
          const children = walk(l.children);
          if (children !== l.children) next = { ...l, children: children as ImageLayer[] };
        } else if (l.type === 'smart' && l.smartFilters?.filters.some((f) => f.kind === 'effect') && (all || isSmartSurfaceIncomplete(l.surface))) {
          try {
            const r = rerenderSmartObject(l, canvas);
            // While results are still rendering, keep the surface: the next refresh replaces it.
            if (all || !isSmartSurfaceIncomplete(r.surface)) next = r;
          } catch {
            // Contents that cannot be rendered here keep their stored pixels.
          }
        }
        if (next !== l) {
          out ??= [...layers];
          out[i] = next;
          changed = true;
        }
      });
      return out ?? layers;
    };
    const next = walk(this.state.layers);
    if (!changed) return;
    this.state.layers = next as ImageLayer[];
    this.notify();
  }

  /** The registered effects provider, or `null`. */
  public get effectsProvider(): EffectProvider | null {
    return this.effects.provider;
  }

  /** Registers (or with `null` removes) the effects provider. Not an edit: no undo step. */
  public setEffectsProvider(provider: EffectProvider | null): void {
    this.effects.set(provider);
  }

  /** Registers `provider` and returns a function that removes it again (if it is still the one set). */
  public useEffects(provider: EffectProvider): () => void {
    return this.effects.use(provider);
  }

  /** The provider's description of an effect, checked for `place` (rejects without a provider or for an unknown id). */
  public async describeEffect(effect: string, place?: ImageEffectPlace): Promise<EffectDescription> {
    const provider = this.effects.require();
    const d = await this.effectsEngine.describe(provider, effect);
    if (place) checkImageEffectPlace(d, place);
    return d;
  }

  /** Resolves when every effect render has landed and the surfaces waiting for them are drawn. */
  public async effectsIdle(): Promise<void> {
    const tick = () => new Promise<void>((r) => queueMicrotask(r));
    // Effect filters stacked on each other render one after another: wait out each round.
    for (let round = 0; round < 32; round++) {
      await this.effectsEngine.idle();
      await tick();
      await tick();
      if (!this.effectsEngine.busy && this.effectRefresh === 'none') return;
    }
  }

  /**
   * Applies a provider filter effect as a smart filter (at `index`, default the top), one undo
   * step. A pixel, shape or type layer (or a group) is first converted to a smart object in the
   * same step (Filter › Convert for Smart Filters), keeping its id when it is one layer. `values`
   * are checked against the effect's controls and stored over its defaults.
   */
  public async applyEffectFilter(
    layerId: string,
    effect: string,
    options: { values?: Record<string, EffectValue>; index?: number; enabled?: boolean; blend?: string; opacity?: number } = {}
  ): Promise<{ layerId: string; filter: SmartFilter; converted: boolean }> {
    const d = await this.describeEffect(effect, 'filter');
    const values = resolveEffectValues(d, options.values);
    const found = findLayer(this.state.layers, layerId);
    if (!found) throw new LayerOperationError(`There is no layer "${layerId}"; call list_layers for the layer ids.`);
    let layers = this.state.layers;
    let id = layerId;
    let converted = false;
    if (found.layer.type !== 'smart') {
      if (found.layer.type === 'adjustment' || found.layer.type === 'annotation') throw new LayerOperationError(`Layer "${found.layer.name || layerId}" is ${found.layer.type === 'adjustment' ? 'an adjustment layer' : 'an annotation'}, which has no pixels to filter; apply the effect to a pixel layer or smart object.`);
      const res = convertToSmartObjectOp(layers, [layerId], this.canvasSize, { surfaceOf: (l) => this.surfaceOf(l) });
      layers = res.layers;
      id = res.layer.id;
      converted = true;
    }
    const filter = normalizeSmartFilter({ kind: 'effect', effect: d.id, provider: this.effects.require().id, name: d.name, values, enabled: options.enabled !== false, blend: options.blend, opacity: options.opacity });
    const res = addSmartFilterOp(layers, id, filter, this.canvasSize, options.index);
    this.commitLayers(res.layers);
    return { layerId: id, filter: res.filter, converted };
  }

  /**
   * Changes an effect smart filter: `values` merged over its own (`null` resets a control to the
   * effect's default), `enabled`, `blend`, `opacity` or its place in the stack (`index`). Values
   * are checked against the provider's controls. One undo step (none with `commitToHistory`
   * false, during a drag).
   */
  public async updateEffectFilter(
    layerId: string,
    filterId: string,
    changes: { values?: Record<string, EffectValue | null>; enabled?: boolean; blend?: string; opacity?: number; index?: number },
    commitToHistory = true
  ): Promise<SmartFilter> {
    const layer = requireSmartObject(this.state.layers, layerId);
    const was = layer.smartFilters?.filters.find((f) => f.id === filterId);
    if (!was || was.kind !== 'effect') throw new LayerOperationError(`Smart object "${layer.name || layerId}" has no effect filter "${filterId}"; its filters are ${(layer.smartFilters?.filters ?? []).map((f) => `${f.id} (${f.kind === 'effect' ? f.name ?? f.effect : f.kind})`).join(', ') || 'none'}.`);
    const update: Record<string, unknown> = {};
    if (changes.values) {
      const d = await this.describeEffect(was.effect);
      const given: Record<string, EffectValue> = {};
      const base = { ...was.values };
      for (const [k, v] of Object.entries(changes.values)) {
        if (v !== null) given[k] = v;
        else if (k in d.controls.properties) base[k] = d.defaults[k];
        else throw new LayerOperationError(`"${k}" is not a control of "${d.id}"; its controls are ${Object.keys(d.controls.properties).join(', ')}.`);
      }
      update.values = { ...base, ...resolveEffectValues({ ...d, defaults: base }, given) };
    }
    for (const k of ['enabled', 'blend', 'opacity'] as const) if (changes[k] !== undefined) update[k] = changes[k];
    let res = updateSmartFilterOp(this.state.layers, layerId, filterId, update, this.canvasSize);
    if (changes.index !== undefined) res = { ...res, layers: moveSmartFilterOp(res.layers, layerId, filterId, changes.index, this.canvasSize).layers };
    this.commitLayers(res.layers, undefined, commitToHistory);
    return requireSmartObject(this.state.layers, layerId).smartFilters!.filters.find((f) => f.id === filterId)!;
  }

  /**
   * Adds an effect layer: a pixel layer drawn by a provider generator, overlay or title effect at
   * the document's size and bit depth (at `time` ms, default 0), placed like `addPixelLayer`. One
   * undo step. Masks, blend and opacity apply as to any layer. Returns its id.
   */
  public async addEffectLayer(
    effect: string,
    options: LayerPlacement & { values?: Record<string, EffectValue>; name?: string; time?: number; opacity?: number; blend?: string; id?: string } = {}
  ): Promise<string> {
    const d = await this.describeEffect(effect, 'layer');
    const values = resolveEffectValues(d, options.values);
    const { width, height } = this.naturalSize;
    const pixels = await this.effectsEngine.renderLayer(d.id, values, { width, height, depth: this.bitDepth, time: options.time });
    const blend = parseBlend(options.blend) as BlendMode | undefined;
    if (options.opacity !== undefined && !(options.opacity >= 0 && options.opacity <= 1)) throw new LayerOperationError('opacity must be from 0 to 1.');
    const ids = new Set(flattenLayers(this.state.layers).map((l) => l.id));
    const layer: PixelLayer = {
      type: 'pixel',
      id: options.id && !ids.has(options.id) ? options.id : newLayerId(),
      name: options.name?.trim() || d.name,
      visible: true,
      opacity: options.opacity ?? 1,
      blend: blend ?? 'normal',
      surface: effectPixelsToSurface(pixels, this.bitDepth),
      offset: { x: 0, y: 0 },
      generator: { effect: d.id, provider: this.effects.require().id, name: d.name, values, ...(options.time ? { time: options.time } : {}) },
    };
    const next = placeLayer(this.state.layers, layer, this.newLayerPlacement(options));
    this.commitLayers(next, () => {
      this.state.activeLayerId = layer.id;
      this.state.activeTarget = 'pixels';
    });
    return layer.id;
  }

  /**
   * Draws an effect layer again with new `values` (merged over its own; `null` resets a control)
   * or `time`, at the document's size and depth, replacing its pixels (painting on it is lost).
   * One undo step (none with `commitToHistory` false). Returns its effect settings.
   */
  public async updateEffectLayer(layerId: string, changes: { values?: Record<string, EffectValue | null>; time?: number }, commitToHistory = true): Promise<NonNullable<PixelLayer['generator']>> {
    const found = findLayer(this.state.layers, layerId);
    const layer = found?.layer;
    if (!layer || layer.type !== 'pixel' || !layer.generator) throw new LayerOperationError(`"${layerId}" is not an effect layer; add one with add_effect_layer.`);
    requireUnlocked(layer, 'pixels', 'draw its effect again');
    const g = layer.generator;
    const d = await this.describeEffect(g.effect);
    const base = { ...g.values };
    const given: Record<string, EffectValue> = {};
    for (const [k, v] of Object.entries(changes.values ?? {})) {
      if (v !== null) given[k] = v;
      else if (k in d.controls.properties) base[k] = d.defaults[k];
      else throw new LayerOperationError(`"${k}" is not a control of "${d.id}"; its controls are ${Object.keys(d.controls.properties).join(', ')}.`);
    }
    const values = { ...base, ...resolveEffectValues({ ...d, defaults: base }, given) };
    const time = changes.time ?? g.time ?? 0;
    const { width, height } = this.naturalSize;
    const pixels = await this.effectsEngine.renderLayer(d.id, values, { width, height, depth: this.bitDepth, time });
    const generator = { ...g, values, provider: this.effects.require().id, ...(time ? { time } : {}) };
    if (!time) delete generator.time;
    const next = mapLayer(this.state.layers, layerId, (l) => ({ ...(l as PixelLayer), surface: effectPixelsToSurface(pixels, this.bitDepth), offset: { x: 0, y: 0 }, generator }));
    this.commitLayers(next, undefined, commitToHistory);
    return generator;
  }

  /** Turns an effect layer into a plain pixel layer keeping its pixels (one undo step). */
  public rasterizeEffectLayer(layerId: string): void {
    const found = findLayer(this.state.layers, layerId);
    if (!found || found.layer.type !== 'pixel' || !found.layer.generator) throw new LayerOperationError(`"${layerId}" is not an effect layer.`);
    this.commitLayers(
      mapLayer(this.state.layers, layerId, (l) => {
        const { generator: _g, ...rest } = l as PixelLayer;
        return rest as PixelLayer;
      })
    );
  }

  private displayFor: [DocumentColorProfile | undefined, ProofSetup | null | undefined, DocumentColorMode | undefined] | null = null;

  /** Keeps the renderer's display transform in step with the document profile, mode and Proof Setup. */
  private syncDisplay(): void {
    const s = this.state;
    const d = this.displayFor;
    if (d && d[0] === s.colorProfile && d[1] === s.proofSetup && d[2] === s.colorMode) return;
    this.displayFor = [s.colorProfile, s.proofSetup, s.colorMode];
    try {
      this.renderer.setDisplayTransform(displayTransform(s.colorProfile, effectiveProof(s.proofSetup, s.colorMode)));
    } catch {
      this.renderer.setDisplayTransform(null);
    }
  }

  /** Recomputes the compatibility views (`adjustments`, `depthMask`, `annotations`) when the stack changed. */
  private syncViews(): void {
    const s = this.state;
    const key = [s.layers, s.outputOpacity, s.legacyOutputBlur, s.activeLayerId, s.imageDimensions.width, s.imageDimensions.height];
    if (key.length === this.viewKey.length && key.every((v, i) => v === this.viewKey[i])) return;
    this.viewKey = key;
    const { width, height } = this.naturalSize;
    const view = legacyView(this.stack(), width, height, s.activeLayerId);
    s.adjustments = view.adjustments;
    s.depthMask = view.depthMask;
    s.annotations = view.annotations;
  }

  private stack(): LayerStack {
    const out: LayerStack = { layers: this.state.layers, outputOpacity: this.state.outputOpacity };
    if (this.state.legacyOutputBlur !== undefined) out.legacyOutputBlur = this.state.legacyOutputBlur;
    return out;
  }

  // --- History (Undo / Redo / Reset) ---

  private captureHistoryEntry(): HistoryEntry {
    const s = this.state;
    const entry: HistoryEntry = {
      layers: s.layers,
      activeLayerId: s.activeLayerId,
      activeTarget: s.activeTarget,
      crop: s.crop ? { ...s.crop } : null,
      transform: { ...s.transform },
      outputOpacity: s.outputOpacity,
      selection: s.selection ?? null,
      source: {
        sourceUrl: s.sourceUrl,
        element: this.imageElement,
        dimensions: { ...s.imageDimensions },
      },
    };
    if (s.legacyOutputBlur !== undefined) entry.legacyOutputBlur = s.legacyOutputBlur;
    if (s.globalLight) entry.globalLight = { ...s.globalLight };
    if (s.patterns) entry.patterns = s.patterns;
    if (s.colorProfile) entry.colorProfile = s.colorProfile;
    if (s.colorMode) entry.colorMode = s.colorMode;
    if (s.bitDepth && s.bitDepth !== 8) entry.bitDepth = s.bitDepth;
    return entry;
  }

  private restoreHistoryEntry(entry: HistoryEntry): void {
    const s = this.state;
    s.layers = entry.layers;
    s.activeLayerId = entry.activeLayerId;
    s.activeTarget = entry.activeTarget;
    s.crop = entry.crop ? { ...entry.crop } : null;
    s.transform = { ...entry.transform };
    s.outputOpacity = entry.outputOpacity;
    if (entry.legacyOutputBlur !== undefined) s.legacyOutputBlur = entry.legacyOutputBlur;
    else delete s.legacyOutputBlur;
    if (entry.globalLight) s.globalLight = { ...entry.globalLight };
    else delete s.globalLight;
    if (entry.patterns) s.patterns = entry.patterns;
    else delete s.patterns;
    if (entry.bitDepth) s.bitDepth = entry.bitDepth;
    else delete s.bitDepth;
    if (entry.colorProfile) s.colorProfile = entry.colorProfile;
    else delete s.colorProfile;
    if (entry.colorMode) s.colorMode = entry.colorMode;
    else delete s.colorMode;
    s.selection = entry.selection;
    if (this.imageElement !== entry.source.element && !this.samplePixelsOverride) this.samplePixels = null;
    this.imageElement = entry.source.element;
    s.sourceUrl = entry.source.sourceUrl;
    s.imageDimensions = { ...entry.source.dimensions };
    this.syncViews();
    if (s.selectedAnnotationId && !s.annotations.some((a) => a.id === s.selectedAnnotationId)) {
      s.selectedAnnotationId = null;
    }
  }

  private recordHistory(): void {
    if (this.isApplyingHistory) return;
    this.undoStack.push(this.captureHistoryEntry());
    if (this.undoStack.length > this.maxHistoryDepth) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.trimHistoryBytes();
  }

  /**
   * Bytes of pixel tiles held only by undo / redo steps (not by the current state). The oldest
   * undo steps are dropped while it exceeds `maxHistoryBytes`.
   */
  public get historyBytes(): number {
    const live = new Set<Tile>();
    collectStateTiles(this.state.layers, live);
    const held = new Set<Tile>();
    for (const e of [...this.undoStack, ...this.redoStack]) collectStateTiles(e.layers, held);
    let n = 0;
    for (const t of held) if (!live.has(t)) n += t.data.byteLength;
    return n;
  }

  private trimHistoryBytes(): void {
    if (!(this.maxHistoryBytes > 0) || this.undoStack.length <= 1) return;
    while (this.undoStack.length > 1 && this.historyBytes > this.maxHistoryBytes) this.undoStack.shift();
  }

  public get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public undo(): boolean {
    if (!this.canUndo) return false;
    this.isApplyingHistory = true;
    this.redoStack.push(this.captureHistoryEntry());

    const prev = this.undoStack.pop()!;
    this.restoreHistoryEntry(prev);
    this.isApplyingHistory = false;
    this.notify();
    return true;
  }

  public redo(): boolean {
    if (!this.canRedo) return false;
    this.isApplyingHistory = true;
    this.undoStack.push(this.captureHistoryEntry());

    const next = this.redoStack.pop()!;
    this.restoreHistoryEntry(next);
    this.isApplyingHistory = false;
    this.notify();
    return true;
  }

  public reset(): void {
    this.recordHistory();
    this.restoreHistoryEntry(this.initialSnapshot);
    this.state.zoom = 1;
    this.state.pan = { x: 0, y: 0 };
    this.state.activeTool = 'select';
    this.state.selectedAnnotationId = null;
    this.notify();
  }

  // --- Active Tool ---

  public setTool(tool: ImageEditorTool): void {
    if (this.state.activeTool === tool) return;
    this.state.activeTool = tool;
    if (tool !== 'select') {
      this.state.selectedAnnotationId = null;
    }
    // If switching to crop tool and no crop is defined, initialize crop to full image
    if (tool === 'crop' && !this.state.crop) {
      this.state.crop = {
        x: 0,
        y: 0,
        width: this.state.imageDimensions.width,
        height: this.state.imageDimensions.height,
      };
    }
    this.notify();
  }

  // --- Crop ---

  public setCrop(crop: CropBox | null, addToHistory = true): void {
    if (addToHistory) {
      this.recordHistory();
    }
    this.state.crop = crop;
    this.notify();
  }

  public applyCropPreset(ratio: AspectRatio): void {
    this.recordHistory();
    const { width, height } = this.state.imageDimensions;
    // `ratio` is the on-screen aspect; the crop box lives in natural image space.
    if (ratio && isQuarterTurnSwapped(this.state.transform)) {
      ratio = 1 / ratio;
    }
    if (!ratio) {
      // Freeform: full image
      this.state.crop = { x: 0, y: 0, width, height };
    } else {
      let targetW = width;
      let targetH = targetW / ratio;

      if (targetH > height) {
        targetH = height;
        targetW = targetH * ratio;
      }

      const x = Math.max(0, Math.round((width - targetW) / 2));
      const y = Math.max(0, Math.round((height - targetH) / 2));
      this.state.crop = {
        x,
        y,
        width: Math.round(targetW),
        height: Math.round(targetH),
      };
    }
    this.notify();
  }

  public resetCrop(): void {
    this.recordHistory();
    this.state.crop = null;
    this.notify();
  }

  // --- Transformations (Rotate / Flip) ---

  public rotate(degrees: number): void {
    this.recordHistory();
    const current = this.state.transform.rotate;
    this.state.transform = { ...this.state.transform, rotate: (current + degrees) % 360 };
    this.notify();
  }

  public setRotation(degrees: number): void {
    this.recordHistory();
    this.state.transform = { ...this.state.transform, rotate: degrees % 360 };
    this.notify();
  }

  public flipHorizontal(): void {
    this.recordHistory();
    this.state.transform = { ...this.state.transform, flipH: !this.state.transform.flipH };
    this.notify();
  }

  public flipVertical(): void {
    this.recordHistory();
    this.state.transform = { ...this.state.transform, flipV: !this.state.transform.flipV };
    this.notify();
  }

  // --- Layers (read) ---

  /** The layer stack, bottom to top (immutable objects). */
  public getLayers(): ImageLayer[] {
    return this.state.layers;
  }

  public getLayer(id: string): ImageLayer | undefined {
    return findLayer(this.state.layers, id)?.layer;
  }

  /** The active layer, or `undefined`. */
  public getActiveLayer(): ImageLayer | undefined {
    return this.state.activeLayerId ? this.getLayer(this.state.activeLayerId) : undefined;
  }

  /**
   * Makes a layer the active one (or none) and chooses whether painting targets its pixels or
   * its mask. View state: no undo step. Returns false for an unknown id.
   */
  public setActiveLayer(id: string | null, target: LayerTarget = 'pixels'): boolean {
    if (id !== null && !this.getLayer(id)) return false;
    const layer = id ? this.getLayer(id) : undefined;
    const t: LayerTarget = target === 'mask' && layer?.mask ? 'mask' : target === 'filter-mask' && layer?.type === 'smart' && layer.smartFilters?.mask ? 'filter-mask' : 'pixels';
    if (this.state.activeLayerId === id && this.state.activeTarget === t) return true;
    this.state.activeLayerId = id;
    this.state.activeTarget = t;
    this.notify();
    return true;
  }

  /**
   * The pixels of a pixel layer, in document space (`x`, `y` is the top-left of the returned
   * buffer), or `null` for an unknown or empty layer. Resolves the Background's source pixels.
   */
  public getLayerPixels(id: string): (PixelBuffer & { x: number; y: number }) | null {
    const layer = this.getLayer(id);
    if (!layer || !hasSurface(layer)) return null;
    const surface = this.surfaceOf(layer);
    const b = contentBounds(surface);
    if (!b) return null;
    return { x: b.x + layer.offset.x, y: b.y + layer.offset.y, width: b.width, height: b.height, data: readRegion(surface, b) };
  }

  private boundsCache = new WeakMap<object, CropBox | null>();

  /**
   * Document bounds of a layer's non-transparent pixels (pixel layers; the Background's source
   * included), or `null` for an empty or non-pixel layer.
   */
  public getLayerBounds(id: string): CropBox | null {
    const layer = this.getLayer(id);
    if (!layer || !hasSurface(layer)) return null;
    const surface = this.surfaceOf(layer);
    let b = this.boundsCache.get(surface);
    if (b === undefined) {
      b = contentBounds(surface);
      this.boundsCache.set(surface, b);
    }
    return b ? { x: b.x + layer.offset.x, y: b.y + layer.offset.y, width: b.width, height: b.height } : null;
  }

  /**
   * A tight base64 PNG data URL of a pixel or smart layer's content, or `null` for an unknown or
   * non-pixel layer, or when the layer is completely transparent.
   */
  public getLayerDataURL(id: string): string | null {
    const layer = this.getLayer(id);
    if (!layer || !hasSurface(layer)) return null;
    const surface = this.surfaceOf(layer);
    const enc = encodeSurface(surface);
    return enc ? enc.url : null;
  }

  /**
   * Composites the layer stack in document space without a canvas (annotation layers need one
   * and are left out): `rect` (default: the canvas) as RGBA, straight alpha. Crop, rotation and
   * output opacity are not applied. With `layerIds`, only those layers are composited.
   */
  public compositePixels(rect?: CropBox, options: { layerIds?: string[] } = {}): PixelBuffer {
    const { width, height } = this.naturalSize;
    const r = rect ?? { x: 0, y: 0, width, height };
    let layers = this.state.layers;
    if (options.layerIds) {
      const keep = new Set(options.layerIds);
      layers = flattenLayers(layers).filter((l) => keep.has(l.id) && l.type !== 'group');
    }
    const data = this.compositor.composite(layers, r, this.compositorSources());
    return { width: r.width, height: r.height, data };
  }

  private compositorSources(): CompositorSources {
    const { width, height } = this.naturalSize;
    return {
      width,
      height,
      surfaceOf: (l) => this.surfaceOf(l),
      version: `${this.sourceVersion()}:${this.patternsVersion()}`,
      globalLight: this.state.globalLight,
      pattern: (id) => this.state.patterns?.find((p) => p.id === id) ?? null,
    };
  }

  private sourceIds = new WeakMap<object, number>();
  private nextSourceId = 1;

  /** Changes whenever the Background's source pixels can have changed. */
  private sourceVersion(): string {
    const key = (this.samplePixelsOverride ? this.samplePixels : this.imageElement ?? this.samplePixels) as object | null;
    if (!key) return '0';
    let id = this.sourceIds.get(key);
    if (!id) {
      id = this.nextSourceId++;
      this.sourceIds.set(key, id);
    }
    return String(id);
  }

  /** The pixels a pixel layer, smart object or shape composites (the decoded source for the Background). */
  private surfaceOf(layer: PixelLayer | SmartObjectLayer | ShapeLayer | TypeLayer): PixelSurface {
    if (layer.type !== 'pixel' || layer.source !== 'document') return layer.surface;
    return this.sourceSurface() ?? layer.surface;
  }

  /**
   * The source image as a surface (cached): host-supplied sample pixels first, then the decoded
   * element, then pixels read back for the selection tools.
   */
  private sourceSurface(): PixelSurface | null {
    const { width, height } = this.naturalSize;
    const fromPixels = (px: PixelBuffer) => {
      let s = this.sourceSurfaces.get(px as object);
      if (!s) {
        s = surfaceFromPixels(px, 4);
        this.sourceSurfaces.set(px as object, s);
      }
      return s;
    };
    const px = this.samplePixels;
    const fits = Boolean(px && px.width === width && px.height === height);
    if (this.samplePixelsOverride && fits) return fromPixels(px!);
    const el = this.imageElement as unknown as object | null;
    if (el) {
      const cached = this.sourceSurfaces.get(el);
      if (cached) return cached;
      const decoded = this.decodeSource();
      if (decoded) {
        if (!this.samplePixelsOverride) this.samplePixels = decoded;
        const s = surfaceFromPixels(decoded, 4);
        this.sourceSurfaces.set(el, s);
        this.sourceSurfaces.set(decoded as object, s);
        return s;
      }
    }
    return fits ? fromPixels(px!) : null;
  }

  private opaqueCache = new WeakMap<object, boolean>();

  /** Whether every source pixel is opaque (some legacy renders depend on it). */
  private sourceIsOpaque(): boolean {
    const s = this.sourceSurface();
    if (!s) return true;
    let v = this.opaqueCache.get(s);
    if (v === undefined) {
      const { width, height } = this.naturalSize;
      v = isOpaqueInside(s, width, height);
      this.opaqueCache.set(s, v);
    }
    return v;
  }

  /** Synchronously reads the source element's pixels through a canvas, or `null`. */
  private decodeSource(): PixelBuffer | null {
    const el = this.imageElement;
    if (!el) return null;
    const { width, height } = this.naturalSize;
    try {
      const canvas = this.renderer.createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx || typeof ctx.getImageData !== 'function') return null;
      ctx.drawImage(el, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height);
      if (!data?.data || data.data.length < width * height * 4) return null;
      return { width, height, data: data.data };
    } catch {
      return null;
    }
  }

  // --- Layer operations ---

  /** Records one undo step and applies a new stack (and any other state change in `extra`). */
  private commitLayers(next: ImageLayer[], extra?: () => void, commitToHistory = true): void {
    if (commitToHistory) this.recordHistory();
    const prev = this.state.layers;
    const depth = this.bitDepth;
    this.state.layers = next;
    extra?.();
    if (depth !== 8 && this.bitDepth === depth) this.state.layers = keepDeepLayers(prev, this.state.layers);
    if (this.state.activeLayerId && !findLayer(next, this.state.activeLayerId)) {
      this.state.activeLayerId = null;
      this.state.activeTarget = 'pixels';
    }
    this.notify();
  }

  /** The default position of a new layer: above the active layer, else the top of the stack. */
  private newLayerPlacement(placement: LayerPlacement): LayerPlacement {
    if (placement.aboveId || placement.belowId || placement.parentId || placement.index !== undefined) return placement;
    const active = this.state.activeLayerId ? findLayer(this.state.layers, this.state.activeLayerId) : null;
    return active ? { aboveId: active.layer.id } : {};
  }

  /**
   * Adds a pixel layer (one undo step) and makes it active: empty, filled with `color` over the
   * canvas, or holding `pixels` placed at `x`, `y`. Goes above the active layer unless placed.
   * Returns its id.
   */
  public addPixelLayer(init: PixelLayerInit = {}): string {
    const { width, height } = this.naturalSize;
    let surface = emptySurface(4);
    if (init.pixels) {
      const px = init.pixels;
      if (!(px.width > 0 && px.height > 0) || px.data.length < px.width * px.height * 4) {
        throw new LayerOperationError('pixels must be RGBA with width × height × 4 bytes.');
      }
      surface = surfaceFromPixels(px, 4);
    } else if (init.color !== undefined) {
      const c = parseColor(init.color);
      surface = solidSurface(4, { x: 0, y: 0, width, height }, packRgba(c[0], c[1], c[2], c[3]));
    }
    const blend = parseBlend(init.blend) as BlendMode | undefined;
    if (init.opacity !== undefined && !(init.opacity >= 0 && init.opacity <= 1)) throw new LayerOperationError('opacity must be from 0 to 1.');
    const ids = new Set(flattenLayers(this.state.layers).map((l) => l.id));
    const layer: PixelLayer = {
      type: 'pixel',
      id: init.id && !ids.has(init.id) ? init.id : newLayerId(),
      name: init.name?.trim() || this.nextLayerName(),
      visible: init.visible ?? true,
      opacity: init.opacity ?? 1,
      blend: blend ?? 'normal',
      surface,
      offset: { x: Math.round(init.x ?? 0), y: Math.round(init.y ?? 0) },
    };
    if (init.fillOpacity !== undefined && init.fillOpacity !== 1) layer.fillOpacity = init.fillOpacity;
    const next = placeLayer(this.state.layers, layer, this.newLayerPlacement(init));
    this.commitLayers(next, () => {
      this.state.activeLayerId = layer.id;
      this.state.activeTarget = 'pixels';
    });
    return layer.id;
  }

  /**
   * `addPixelLayer` from an image: a PNG data URL or base64 PNG is decoded without a canvas;
   * other formats and URLs need a browser. Returns the new layer id.
   */
  public async addPixelLayerFromImage(image: string, init: Omit<PixelLayerInit, 'pixels' | 'color'> = {}): Promise<string> {
    const pixels = await this.decodeImage(image);
    return this.addPixelLayer({ ...init, pixels });
  }

  /** RGBA pixels of an image given as a data URL, base64 PNG or URL. */
  public async decodeImage(image: string): Promise<PixelBuffer> {
    const trimmed = image.trim();
    let png: Uint8Array | null = null;
    if (/^data:image\/png/i.test(trimmed)) png = parseDataUrl(trimmed)?.bytes ?? null;
    else if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length > 16) {
      try {
        const bytes = base64ToBytes(trimmed);
        if (isPng(bytes)) png = bytes;
      } catch {
        png = null;
      }
    }
    if (png) {
      try {
        const d = decodePng(png);
        return { width: d.width, height: d.height, data: d.data };
      } catch {
        // Fall back to the browser decoder below (interlaced PNGs).
      }
    }
    const src = png ? `data:image/png;base64,${bytesToBase64(png)}` : trimmed;
    let img: HTMLImageElement;
    try {
      img = await this.renderer.imageCache.get(src);
    } catch {
      throw new LayerOperationError('The image could not be decoded here. Pass a PNG (data URL or base64), or run in a browser for other formats and URLs.');
    }
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const ctx = this.renderer.createCanvas(w, h).getContext('2d');
    if (!ctx || typeof ctx.getImageData !== 'function') throw new LayerOperationError('Decoding this image needs a canvas; pass a PNG instead.');
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    return { width: w, height: h, data: data.data };
  }

  private nextLayerName(): string {
    const names = new Set(flattenLayers(this.state.layers).map((l) => l.name));
    let n = 1;
    while (names.has(`Layer ${n}`)) n++;
    return `Layer ${n}`;
  }

  /** Duplicates a layer (with its children) directly above it, as one undo step. Returns the copy's id. */
  public duplicateLayer(id: string, name?: string): string {
    const res = duplicateLayerOp(this.state.layers, id, name);
    this.commitLayers(res.layers, () => {
      this.state.activeLayerId = res.id;
    });
    return res.id;
  }

  /** Deletes a layer (refused when locked), as one undo step. */
  public removeLayer(id: string): void {
    const next = removeLayerOp(this.state.layers, id);
    this.commitLayers(next, () => {
      if (this.state.selectedAnnotationId && !flattenLayers(next).some((l) => annotationOfLayer(l)?.id === this.state.selectedAnnotationId)) {
        this.state.selectedAnnotationId = null;
      }
    });
  }

  /** Moves a layer above / below another, or into a group, as one undo step. Returns its new parent and index. */
  public moveLayer(id: string, placement: LayerPlacement): { parentId: string | null; index: number } {
    const next = moveLayerOp(this.state.layers, id, placement);
    const loc = findLayer(next, id)!;
    if (next === this.state.layers) return { parentId: loc.parent?.id ?? null, index: loc.index };
    this.commitLayers(next);
    return { parentId: loc.parent?.id ?? null, index: loc.index };
  }

  /**
   * Changes name, visibility, opacity, fill, blend, clipping, locks or (groups) collapsed state, as
   * one undo step (`commitToHistory = false` for the moves of a slider drag). Returns the layer.
   */
  public setLayerProperties(id: string, props: LayerProperties, commitToHistory = true): ImageLayer {
    const next = setLayerPropertiesOp(this.state.layers, id, props);
    this.commitLayers(next, undefined, commitToHistory);
    return findLayer(next, id)!.layer;
  }

  /** Adds an empty pass-through group above the active layer (or at `placement`) and makes it active. Returns its id. */
  public addGroup(init: LayerPlacement & { name?: string; blend?: LayerBlendMode } = {}): string {
    const blend = init.blend === undefined ? 'pass-through' : (parseBlend(init.blend, true) as LayerBlendMode);
    const group: GroupLayer = {
      type: 'group',
      id: newLayerId('group'),
      name: init.name?.trim() || 'Group',
      visible: true,
      opacity: 1,
      blend,
      children: [],
    };
    const next = placeLayer(this.state.layers, group, this.newLayerPlacement(init));
    this.commitLayers(next, () => {
      this.state.activeLayerId = group.id;
      this.state.activeTarget = 'pixels';
    });
    return group.id;
  }

  /** Puts sibling layers into a new group (one undo step). Returns the group id. */
  public groupLayers(ids: string[], name?: string): string {
    const res = groupLayersOp(this.state.layers, ids, name);
    this.commitLayers(res.layers, () => {
      this.state.activeLayerId = res.id;
    });
    return res.id;
  }

  /** Replaces a group by its children (one undo step). Returns the child ids, bottom to top. */
  public ungroupLayer(id: string): string[] {
    const res = ungroupLayerOp(this.state.layers, id);
    this.commitLayers(res.layers);
    return res.ids;
  }

  /**
   * Moves a pixel layer to an absolute offset (`x`, `y`) or by `dx`, `dy`, as one undo step
   * (`commitToHistory = false` for the moves of a drag). Returns the offset and document bounds.
   */
  public offsetLayer(id: string, move: { x?: number; y?: number; dx?: number; dy?: number }, commitToHistory = true): { offset: { x: number; y: number }; bounds: CropBox | null } {
    const layer = requireLayer(this.state.layers, id).layer;
    if (layer.type === 'smart') {
      // A smart object moves through its placement: x, y is where its top-left corner goes.
      const tl = layer.placement.corners[0];
      const dx = move.x !== undefined ? move.x - tl.x : (move.dx ?? 0);
      const dy = move.y !== undefined ? move.y - tl.y : (move.dy ?? 0);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new LayerOperationError('x and y must be numbers.');
      this.commitLayers(offsetSmartObject(this.state.layers, id, dx, dy, this.canvasSize), undefined, commitToHistory);
      const moved = findLayer(this.state.layers, id)!.layer as SmartObjectLayer;
      return { offset: { x: Math.round(moved.placement.corners[0].x), y: Math.round(moved.placement.corners[0].y) }, bounds: this.getLayerBounds(id) };
    }
    if (layer.type === 'shape') {
      // A shape moves its paths: x, y is where the top-left of its geometry goes.
      const g = shapeGeometryBounds(layer) ?? { x: 0, y: 0 };
      const dx = move.x !== undefined ? move.x - g.x : (move.dx ?? 0);
      const dy = move.y !== undefined ? move.y - g.y : (move.dy ?? 0);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new LayerOperationError('x and y must be numbers.');
      requireUnlocked(layer, 'position', 'move it');
      let moved = offsetShape(layer, dx, dy, this.shapeEnv());
      const mask = layer.mask;
      if (mask && mask.linked !== false && !mask.source && (Math.round(dx) || Math.round(dy))) moved = { ...moved, mask: { ...mask, surface: translateSurface(mask.surface, Math.round(dx), Math.round(dy)) } };
      this.commitLayers(mapLayer(this.state.layers, id, () => moved), undefined, commitToHistory);
      const b = shapeGeometryBounds(moved) ?? { x: 0, y: 0 };
      return { offset: { x: Math.round(b.x), y: Math.round(b.y) }, bounds: this.getLayerBounds(id) };
    }
    if (layer.type === 'type') {
      // A type layer moves through its transform: x, y is where its text-space origin goes.
      const m = layer.transform ?? [1, 0, 0, 1, 0, 0];
      const dx = move.x !== undefined ? move.x - m[4] : (move.dx ?? 0);
      const dy = move.y !== undefined ? move.y - m[5] : (move.dy ?? 0);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new LayerOperationError('x and y must be numbers.');
      requireUnlocked(layer, 'position', 'move it');
      const mx = Math.round(dx);
      const my = Math.round(dy);
      let moved: TypeLayer = { ...transformTypeLayer(layer, [1, 0, 0, 1, mx, my]), surface: translateSurface(layer.surface, mx, my) };
      const mask = layer.mask;
      if (mask && mask.linked !== false && !mask.source && (mx || my)) moved = { ...moved, mask: { ...mask, surface: translateSurface(mask.surface, mx, my) } };
      this.commitLayers(mapLayer(this.state.layers, id, () => moved), undefined, commitToHistory);
      const t = moved.transform ?? [1, 0, 0, 1, 0, 0];
      return { offset: { x: Math.round(t[4]), y: Math.round(t[5]) }, bounds: this.getLayerBounds(id) };
    }
    const current = layer.type === 'pixel' ? layer.offset : { x: 0, y: 0 };
    const x = move.x ?? current.x + (move.dx ?? 0);
    const y = move.y ?? current.y + (move.dy ?? 0);
    const next = offsetLayerOp(this.state.layers, id, { x, y });
    this.commitLayers(next, undefined, commitToHistory);
    return { offset: { x: Math.round(x), y: Math.round(y) }, bounds: this.getLayerBounds(id) };
  }

  /**
   * Adds a mask to a layer (one undo step): `reveal-all` (white), `hide-all` (black) or
   * `selection` (the selection's coverage). Replaces an existing mask. Makes the mask the paint
   * target when the layer is active.
   */
  public addLayerMask(id: string, from: 'reveal-all' | 'hide-all' | 'selection' = 'reveal-all', props: LayerMaskProps = {}): RasterMask {
    const layer = requireLayer(this.state.layers, id).layer;
    let mask: RasterMask;
    if (from === 'selection') {
      const sel = this.state.selection;
      if (!sel?.bounds) throw new LayerOperationError('Nothing is selected; select first, or use reveal-all / hide-all.');
      mask = this.maskFromSelection(sel, props);
      if (layer.type === 'pixel' && (layer.offset.x || layer.offset.y)) {
        // Masks live in the layer's space (they move with it).
        mask = { ...mask, surface: translateSurface(mask.surface, -layer.offset.x, -layer.offset.y) };
      }
    } else {
      const v = from === 'reveal-all' ? 255 : 0;
      mask = withMaskProps({ surface: emptySurface(1, v), defaultValue: v }, props);
    }
    const next = setLayerMaskOp(this.state.layers, id, mask);
    this.commitLayers(next, () => {
      if (this.state.activeLayerId === id) this.state.activeTarget = 'mask';
    });
    return mask;
  }

  /** Removes a layer's mask (one undo step). */
  public removeLayerMask(id: string): void {
    const layer = requireLayer(this.state.layers, id).layer;
    if (!layer.mask) throw new LayerOperationError(`Layer "${layer.name || id}" has no mask.`);
    this.commitLayers(setLayerMaskOp(this.state.layers, id, null), () => {
      if (this.state.activeLayerId === id) this.state.activeTarget = 'pixels';
    });
  }

  /** Changes any layer mask's density, feather, enabled or linked flag (pixels kept). Returns the mask. */
  public setLayerMaskProps(id: string, props: LayerMaskProps, commitToHistory = true): RasterMask {
    const layer = requireLayer(this.state.layers, id).layer;
    if (!layer.mask) throw new LayerOperationError(`Layer "${layer.name || id}" has no mask; add one with add_layer_mask.`);
    const mask = withMaskProps(layer.mask, props);
    this.commitLayers(setLayerMaskOp(this.state.layers, id, mask), undefined, commitToHistory);
    return mask;
  }

  /**
   * Bakes a pixel layer's mask into its pixels (alpha × coverage, including density, feather or
   * the depth map) and removes the mask, as one undo step.
   */
  public async applyLayerMask(id: string): Promise<void> {
    const loc = requireLayer(this.state.layers, id);
    const layer = loc.layer;
    if (layer.type !== 'pixel') throw new LayerOperationError(`Only a pixel layer's mask can be applied to its pixels; "${id}" is a ${layer.type} layer. Remove the mask or keep it.`);
    if (!layer.mask) throw new LayerOperationError(`Layer "${layer.name || id}" has no mask.`);
    requireUnlocked(layer, 'pixels', 'apply its mask');
    const { width, height } = this.naturalSize;
    await this.renderer.prepareLayerAssets([layer], width, height);
    const sources = this.renderer.compositorSources(width, height);
    const surface = this.surfaceOf(layer);
    let out = surface;
    const b = surface.bounds;
    if (b) {
      const draft = new SurfaceDraft(surface);
      for (const t of tilesInRect(b)) {
        const data = draft.peek(t.tx, t.ty);
        if (!data) continue;
        const r = { x: t.tx * TILE + layer.offset.x, y: t.ty * TILE + layer.offset.y, width: TILE, height: TILE };
        const cov = this.compositor.maskCoverage(layer, r, sources);
        if (!cov) continue;
        const d = draft.tile(t.tx, t.ty);
        for (let p = 0, i = 3; p < cov.length; p++, i += 4) d[i] = Math.round(d[i] * cov[p]);
      }
      out = draft.commit();
    }
    const next: PixelLayer = { ...layer, surface: out };
    delete next.mask;
    delete next.source;
    this.commitLayers(mapLayer(this.state.layers, id, () => next), () => {
      if (this.state.activeLayerId === id) this.state.activeTarget = 'pixels';
    });
  }

  /**
   * Layer via Copy (or via Cut): a new pixel layer with the selected pixels of a pixel layer (the
   * active one by default), directly above it, as one undo step. Returns the new id.
   */
  public layerViaCopy(options: { layerId?: string; cut?: boolean; name?: string } = {}): string {
    const id = options.layerId ?? this.state.activeLayerId;
    if (!id) throw new LayerOperationError('No layer given and none is active; pass layerId (see list_layers).');
    const loc = requireLayer(this.state.layers, id);
    const layer = loc.layer;
    if (layer.type !== 'pixel') throw new LayerOperationError(`Layer via copy needs a pixel layer; "${id}" is a ${layer.type} layer.`);
    const sel = this.state.selection;
    if (!sel?.bounds) throw new LayerOperationError('Nothing is selected; select the pixels to copy first.');
    if (options.cut) requireUnlocked(layer, 'pixels', 'cut from it');
    const surface = this.surfaceOf(layer);
    const sb = sel.bounds;
    const src = { x: sb.x - layer.offset.x, y: sb.y - layer.offset.y, width: sb.width, height: sb.height };
    const px = readRegion(surface, src);
    const kept = options.cut ? new Uint8ClampedArray(px) : null;
    for (let y = 0; y < sb.height; y++) {
      for (let x = 0; x < sb.width; x++) {
        const c = sel.data[(sb.y + y) * sel.width + sb.x + x];
        const i = (y * sb.width + x) * 4 + 3;
        if (kept) kept[i] = Math.round(kept[i] * (1 - c / 255));
        px[i] = Math.round(px[i] * (c / 255));
      }
    }
    const copy: PixelLayer = {
      type: 'pixel',
      id: newLayerId(),
      name: options.name?.trim() || `${layer.name || 'Layer'} ${options.cut ? 'cut' : 'copy'}`,
      visible: true,
      opacity: 1,
      blend: 'normal',
      surface: surfaceFromPixels({ width: src.width, height: src.height, data: px }, 4, src.x, src.y),
      offset: { ...layer.offset },
    };
    let next = insertLayer(this.state.layers, copy, loc.parent?.id ?? null, loc.index + 1);
    if (kept) {
      const cutLayer: PixelLayer = { ...layer, surface: writeRegion(surface, src, kept) };
      delete cutLayer.source;
      next = mapLayer(next, id, () => cutLayer);
    }
    this.commitLayers(next, () => {
      this.state.activeLayerId = copy.id;
      this.state.activeTarget = 'pixels';
    });
    return copy.id;
  }

  // --- Free Transform ---

  private openTransform: FreeTransformSession | null = null;

  /** The Free Transform in progress (see `beginFreeTransform`), or `null`. */
  public getFreeTransform(): FreeTransformSession | null {
    if (this.openTransform && !this.openTransform.isOpen) this.openTransform = null;
    return this.openTransform;
  }

  private transformHost(): FreeTransformHost {
    return {
      layers: () => this.state.layers,
      activeLayerId: () => this.state.activeLayerId,
      activeTarget: () => this.state.activeTarget,
      selection: () => (this.state.selection?.bounds ? this.state.selection : null),
      canvas: () => this.naturalSize,
      pixelsOf: (layer) => this.surfaceOf(layer),
      shapeEnv: () => this.shapeEnv(),
      textEnv: () => this.textEnv(),
      capture: () => this.captureHistoryEntry(),
      show: (layers, selection, active) => {
        this.state.layers = layers;
        this.state.selection = selection;
        if (active !== this.state.activeLayerId) {
          this.state.activeLayerId = active;
          this.state.activeTarget = 'pixels';
        }
        this.notify();
      },
      record: (before) => {
        if (this.isApplyingHistory) return;
        this.undoStack.push(before as HistoryEntry);
        if (this.undoStack.length > this.maxHistoryDepth) this.undoStack.shift();
        this.redoStack = [];
        this.trimHistoryBytes();
        this.notify();
      },
      restore: (before) => {
        const e = before as HistoryEntry;
        this.state.layers = e.layers;
        this.state.selection = e.selection;
        this.state.activeLayerId = e.activeLayerId;
        this.state.activeTarget = e.activeTarget;
        this.notify();
      },
    };
  }

  /**
   * Starts a Free Transform (Edit › Free Transform, Transform Selection, or a transform of a Layer
   * via Copy): of the layer's pixels with its linked mask, an unlinked mask alone, the selected
   * pixels or just the selection outline (see `FreeTransformInit`). Change the geometry with
   * `session.update` (live preview, no history), then `commit()` (one undo step) or `cancel()`.
   * Refused while another transform is open.
   */
  public beginFreeTransform(init: FreeTransformInit = {}): FreeTransformSession {
    if (this.getFreeTransform()) throw new LayerOperationError('A Free Transform is already open; commit or cancel it first.');
    const session = new FreeTransformSession(this.transformHost(), init);
    this.openTransform = session;
    this.notify();
    return session;
  }

  /**
   * Transforms in one step (agents, scripts): begins a Free Transform for `spec`, sets its corners
   * from exactly one of `matrix` (document-space affine), `corners` (where the frame's corners go:
   * distort / perspective) or `params` (scale, rotate, skew and move about a reference point), and
   * commits it as one undo step. Returns what changed and the new bounds.
   */
  public transformLayer(spec: FreeTransformInit & { matrix?: AffineMatrix; corners?: Quad; params?: TransformParams; warp?: WarpMesh | WarpPreset | null }): FreeTransformResult {
    const given = [spec.matrix, spec.corners, spec.params].filter((v) => v !== undefined).length;
    if (given > 1) throw new LayerOperationError('Give only one of matrix, corners and params.');
    if (!given && spec.warp === undefined) throw new LayerOperationError('Give matrix, corners or params (or a warp).');
    if (spec.matrix && !(Array.isArray(spec.matrix) && spec.matrix.length === 6 && spec.matrix.every(Number.isFinite))) {
      throw new LayerOperationError('matrix must be six finite numbers [a, b, c, d, e, f] (x\' = a·x + c·y + e, y\' = b·x + d·y + f).');
    }
    if (spec.matrix) {
      const [a, b, c, d] = spec.matrix;
      if (Math.abs(a * d - b * c) < 1e-9) throw new LayerOperationError('matrix is singular (it collapses the layer to a line); its determinant a·d − b·c must not be 0.');
    }
    const session = this.beginFreeTransform(spec);
    try {
      // Relative to where the content is now (a smart object's current placement).
      const g = session.startGeometry;
      const corners = spec.matrix ? (g.corners.map((p) => applyMatrix(spec.matrix!, p)) as unknown as Quad) : spec.corners ? spec.corners : spec.params ? applyParams(g, spec.params) : g.corners;
      let warp: WarpMesh | null = spec.warp === undefined ? (g.warp ?? null) : null;
      if (spec.warp) {
        if ('style' in spec.warp) {
          if (!WARP_STYLES.includes(spec.warp.style)) throw new LayerOperationError(`Unknown warp style "${String(spec.warp.style)}". Styles: ${WARP_STYLES.join(', ')}.`);
          warp = presetWarp(session.box, spec.warp);
        } else {
          if (!isValidWarp(spec.warp)) throw new LayerOperationError('mesh must have us and vs (knots from 0 to 1, increasing) and (3·columns + 1) × (3·rows + 1) finite points, row by row.');
          warp = spec.warp;
        }
      }
      session.update({ corners, warp }, false);
      return session.commit();
    } catch (e) {
      session.cancel();
      throw e;
    }
  }

  /** Flips the layer (or its selected pixels, or the outline) about the frame's centre, exactly (one undo step). */
  public flipLayer(axis: 'horizontal' | 'vertical', init: FreeTransformInit = {}): FreeTransformResult {
    if (axis !== 'horizontal' && axis !== 'vertical') throw new LayerOperationError(`axis must be horizontal or vertical, got "${String(axis)}".`);
    const session = this.beginFreeTransform({ interpolation: 'nearest', ...init });
    try {
      session.update({ corners: flipCorners(session.startGeometry, axis) }, false);
      return session.commit();
    } catch (e) {
      session.cancel();
      throw e;
    }
  }

  /**
   * Rotates by a quarter turn (90 clockwise, −90 counter-clockwise) or 180 about the frame's
   * centre, snapped so pixels land on whole pixels: exact, no resampling (one undo step).
   */
  public rotateLayer90(turn: 90 | -90 | 180, init: FreeTransformInit = {}): FreeTransformResult {
    if (turn !== 90 && turn !== -90 && turn !== 180) throw new LayerOperationError(`turn must be 90, -90 or 180, got ${String(turn)}.`);
    const session = this.beginFreeTransform({ interpolation: 'nearest', ...init });
    try {
      // The frame in the document (a smart object's placed outline).
      const b = session.smartObject || session.typeLayer ? (transformedBox(session.startGeometry) ?? session.box) : session.box;
      // About the centre, rounded so an odd-by-even box still lands on the pixel grid.
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const ox = turn === 180 ? 0 : Math.round(cx - b.height / 2) - (cx - b.height / 2);
      const oy = turn === 180 ? 0 : Math.round(cy - b.width / 2) - (cy - b.width / 2);
      const m: AffineMatrix =
        turn === 90 ? [0, 1, -1, 0, cx + cy + ox, cy - cx + oy] : turn === -90 ? [0, -1, 1, 0, cx - cy + ox, cy + cx + oy] : [-1, 0, 0, -1, 2 * cx, 2 * cy];
      session.update({ corners: session.startGeometry.corners.map((p) => applyMatrix(m, p)) as unknown as Quad }, false);
      return session.commit();
    } catch (e) {
      session.cancel();
      throw e;
    }
  }

  /** Adds a `develop` or `blur` filter to a pixel layer (one undo step). Returns the layer's filters. */
  public addLayerFilter(id: string, filter: Partial<LayerFilter> & { kind: LayerFilter['kind'] }): LayerFilter[] {
    const f = normalizeFilter(filter);
    const next = addLayerFilterOp(this.state.layers, id, f);
    this.commitLayers(next);
    return (findLayer(next, id)!.layer as PixelLayer).filters ?? [];
  }

  /** Changes one filter (one undo step, or none with `commitToHistory = false` during a drag). Returns the filters. */
  public updateLayerFilter(id: string, filterId: string, changes: Record<string, unknown>, commitToHistory = true): LayerFilter[] {
    const next = updateLayerFilterOp(this.state.layers, id, filterId, changes);
    this.commitLayers(next, undefined, commitToHistory);
    return (findLayer(next, id)!.layer as PixelLayer).filters ?? [];
  }

  /** Removes one filter (one undo step). Returns the remaining filters. */
  public removeLayerFilter(id: string, filterId: string): LayerFilter[] {
    const next = removeLayerFilterOp(this.state.layers, id, filterId);
    this.commitLayers(next);
    return (findLayer(next, id)!.layer as PixelLayer).filters ?? [];
  }

  // --- Smart objects ---

  private get canvasSize(): { width: number; height: number; effects: ImageEffectsEngine } {
    return { ...this.naturalSize, effects: this.effectsEngine };
  }

  /**
   * Layer › Smart Objects › Convert to Smart Object (one undo step): sibling layers (default the
   * active one) become one smart object at the topmost one's position. A single pixel layer keeps
   * its id and properties and its filters become smart filters (it renders exactly as before);
   * anything else nests as a layer document. Returns the smart object's id.
   */
  public convertToSmartObject(ids?: string[], options: { name?: string } = {}): string {
    const list = ids?.length ? ids : this.state.activeLayerId ? [this.state.activeLayerId] : [];
    if (!list.length) throw new LayerOperationError('No layers given and none is active; pass layerIds (see list_layers).');
    const res = convertToSmartObjectOp(this.state.layers, list, this.canvasSize, { surfaceOf: (l) => this.surfaceOf(l), name: options.name });
    this.commitLayers(res.layers, () => {
      this.state.activeLayerId = res.layer.id;
      this.state.activeTarget = 'pixels';
    });
    return res.layer.id;
  }

  /** Layer › Smart Objects › Rasterize (one undo step): the smart object becomes a pixel layer holding what it renders. */
  public rasterizeSmartObject(id: string): string {
    const res = rasterizeSmartObjectOp(this.state.layers, id);
    this.commitLayers(res.layers, () => {
      if (this.state.activeLayerId === id && this.state.activeTarget === 'filter-mask') this.state.activeTarget = 'pixels';
    });
    return id;
  }

  /** A smart object's contents, placement and smart filters as plain data (see `SmartObjectInfo`). */
  public getSmartObject(id: string): SmartObjectInfo {
    const layer = requireSmartObject(this.state.layers, id);
    const c = layer.contents;
    const g = placementGeometry(layer);
    const readout = describeTransform(g);
    const stack = layer.smartFilters;
    return {
      layerId: layer.id,
      contents: {
        id: c.id,
        name: c.name,
        kind: c.kind,
        width: c.width,
        height: c.height,
        decoded: isContentsDecoded(c),
        fileType: c.file?.type ?? null,
        linkedPath: c.linked?.path ?? null,
        instances: instancesOf(this.state.layers, c.id),
        layerCount: c.document ? flattenLayers(c.document.layers).length : 0,
      },
      placement: {
        corners: g.corners.map((p) => ({ x: p.x, y: p.y })) as unknown as Quad,
        warp: layer.placement.warp ?? null,
        interpolation: layer.placement.interpolation ?? 'bicubic',
        affine: readout.affine,
        scaleX: readout.scaleX,
        scaleY: readout.scaleY,
        rotate: readout.rotate,
        skewX: readout.skewX,
        center: anchorPoint(g, 'center'),
        bounds: transformedBox(g),
      },
      smartFilters: {
        enabled: stack?.enabled ?? true,
        filters: (stack?.filters ?? []).map((f) => (f.kind === 'psd' ? { id: f.id, kind: 'psd', name: f.name, enabled: f.enabled, blend: f.blend, opacity: f.opacity } : { ...f })),
        mask: stack?.mask
          ? { enabled: stack.mask.enabled !== false, linked: stack.mask.linked !== false, density: stack.mask.density ?? 1, feather: stack.mask.feather ?? 0, bounds: contentBounds(stack.mask.surface), defaultValue: stack.mask.defaultValue }
          : null,
      },
      bounds: this.getLayerBounds(id),
    };
  }

  /**
   * Sets a smart object's placement (one undo step, or none with `commitToHistory = false` during a
   * drag): where the contents' corners land, an optional warp in contents pixels and the
   * interpolation. The contents render again from the source; a linked mask follows a warp-free
   * change. Returns the new placement summary.
   */
  public setSmartObjectPlacement(id: string, placement: SmartPlacement, commitToHistory = true): SmartObjectInfo['placement'] & { masksMoved: boolean } {
    const res = setSmartPlacement(this.state.layers, id, placement, this.canvasSize);
    this.commitLayers(res.layers, undefined, commitToHistory);
    return { ...this.getSmartObject(id).placement, masksMoved: res.masksMoved };
  }

  /**
   * Sets a smart object's transform absolutely (one undo step): exactly one of `corners` (where the
   * contents' corners land), `matrix` (contents pixels → document) or the numbers (`scaleX`,
   * `scaleY` in percent of the contents' own size, `rotate`, `skewX`, `skewY`, and `x`, `y` where
   * the contents' centre goes, default where it is now); plus, optionally, a warp (a preset, a mesh
   * in contents pixels, or `null` to remove it) and the interpolation. Unlike `transformLayer`,
   * nothing is relative to the current transform.
   */
  public setSmartObjectTransform(
    id: string,
    spec: {
      corners?: Quad;
      matrix?: AffineMatrix;
      scaleX?: number;
      scaleY?: number;
      rotate?: number;
      skewX?: number;
      skewY?: number;
      x?: number;
      y?: number;
      warp?: WarpMesh | WarpPreset | null;
      interpolation?: Interpolation;
    }
  ): SmartObjectInfo['placement'] & { masksMoved: boolean } {
    const layer = requireSmartObject(this.state.layers, id);
    const g = placementGeometry(layer);
    const numeric = (['scaleX', 'scaleY', 'rotate', 'skewX', 'skewY', 'x', 'y'] as const).filter((k) => spec[k] !== undefined);
    const ways = [spec.corners !== undefined, spec.matrix !== undefined, numeric.length > 0].filter(Boolean).length;
    if (ways > 1) throw new LayerOperationError('Give the transform only one way: corners, matrix, or the numbers (scaleX, scaleY, rotate, skewX, skewY, x, y).');
    let corners: Quad = g.corners;
    if (spec.corners) corners = spec.corners;
    else if (spec.matrix) {
      if (!(Array.isArray(spec.matrix) && spec.matrix.length === 6 && spec.matrix.every(Number.isFinite))) throw new LayerOperationError("matrix must be six finite numbers [a, b, c, d, e, f] (x' = a·x + c·y + e, y' = b·x + d·y + f).");
      const [a, b, c, d] = spec.matrix;
      if (Math.abs(a * d - b * c) < 1e-9) throw new LayerOperationError('matrix is singular (it collapses the contents to a line); a·d − b·c must not be 0.');
      corners = cornersFromMatrix(g.box, spec.matrix);
    } else if (numeric.length) {
      if (spec.scaleX === 0 || spec.scaleY === 0) throw new LayerOperationError('scaleX and scaleY must not be 0 (that collapses the contents to a line).');
      for (const k of numeric) if (!Number.isFinite(spec[k] as number)) throw new LayerOperationError(`${k} must be a finite number.`);
      const now = describeTransform(g);
      const centre = anchorPoint(g, 'center');
      const params = {
        scaleX: spec.scaleX ?? (now.affine ? now.scaleX : 100),
        scaleY: spec.scaleY ?? (now.affine ? now.scaleY : 100),
        rotate: spec.rotate ?? (now.affine ? now.rotate : 0),
        skewX: spec.skewX ?? (now.affine ? now.skewX : 0),
        skewY: spec.skewY ?? 0,
      };
      const m = matrixFromParams(g.box, { ...params, reference: 'center' });
      const cx = g.box.width / 2;
      const cy = g.box.height / 2;
      const to = { x: spec.x ?? centre.x, y: spec.y ?? centre.y };
      corners = cornersFromMatrix(g.box, multiplyMatrices(m, translateMatrix(to.x - cx, to.y - cy)));
    }
    let warp: WarpMesh | null | undefined = layer.placement.warp ?? null;
    if (spec.warp === null) warp = null;
    else if (spec.warp) {
      if ('style' in spec.warp) {
        if (!WARP_STYLES.includes(spec.warp.style)) throw new LayerOperationError(`Unknown warp style "${String(spec.warp.style)}". Styles: ${WARP_STYLES.join(', ')}.`);
        warp = presetWarp(g.box, spec.warp);
      } else {
        if (!isValidWarp(spec.warp)) throw new LayerOperationError('mesh must have us and vs (knots from 0 to 1, increasing) and (3·columns + 1) × (3·rows + 1) finite points in contents pixels, row by row.');
        warp = spec.warp;
      }
    }
    const next: SmartPlacement = { corners, warp, interpolation: spec.interpolation ?? layer.placement.interpolation };
    return this.setSmartObjectPlacement(id, next);
  }

  /**
   * Layer › Smart Objects › Replace Contents (one undo step): new contents for the smart object and
   * every instance linked to it, from RGBA pixels, PSD bytes (a layer document) or contents. Each
   * instance keeps its scale and rotation about the contents' centre. Returns the contents id and
   * the layers that changed.
   */
  public replaceSmartObjectContents(
    id: string,
    source: { pixels: PixelBuffer; name?: string } | { psd: Uint8Array; name?: string } | { contents: SmartContents }
  ): { contentsId: string; width: number; height: number; layerIds: string[] } {
    const layer = requireSmartObject(this.state.layers, id);
    let contents: SmartContents;
    if ('contents' in source) contents = source.contents;
    else if ('pixels' in source) contents = rasterContents(source.pixels, source.name ?? layer.contents.name.replace(/\.\w+$/, '.png'));
    else {
      const psd = importPsd(source.psd, { newId: () => newLayerId() });
      contents = documentContents({ layers: psd.layers, globalLight: psd.globalLight, patterns: psd.patterns.length ? psd.patterns : undefined }, psd.width, psd.height, source.name ?? `${layer.name || 'Contents'}.psb`);
      contents.file = { bytes: source.psd.slice(), type: psd.info.psb ? 'psb' : 'psd' };
    }
    const res = replaceContentsOp(this.state.layers, layer.contents.id, contents, this.canvasSize);
    this.commitLayers(res.layers);
    return { contentsId: layer.contents.id, width: contents.width, height: contents.height, layerIds: res.ids };
  }

  /** `replaceSmartObjectContents` from an image (PNG data URL or base64 decodes anywhere; other formats need a browser). */
  public async replaceSmartObjectContentsFromImage(id: string, image: string, name?: string): Promise<{ contentsId: string; width: number; height: number; layerIds: string[] }> {
    const pixels = await this.decodeImage(image);
    return this.replaceSmartObjectContents(id, { pixels, name });
  }

  /**
   * Layer › Smart Objects › Export Contents: the file the contents came from while unedited, else a
   * PNG (raster contents) or a PSD / PSB of the nested document. Returns the file name, MIME type
   * and bytes.
   */
  public exportSmartObjectContents(id: string): { name: string; mimeType: string; bytes: Uint8Array } {
    const layer = requireSmartObject(this.state.layers, id);
    const c = layer.contents;
    const base = c.name.replace(/\.\w+$/, '') || 'Contents';
    if (c.file) {
      const mime: Record<string, string> = { psd: 'image/vnd.adobe.photoshop', psb: 'image/vnd.adobe.photoshop', pdf: 'application/pdf', ...BROWSER_IMAGE_TYPES };
      const ext = c.file.type.toLowerCase();
      return { name: /\.\w+$/.test(c.name) ? c.name : `${base}.${ext}`, mimeType: mime[ext] ?? 'application/octet-stream', bytes: c.file.bytes };
    }
    if (!isContentsDecoded(c)) throw new LayerOperationError(`The contents of "${layer.name || id}" are not available here.`);
    const f = smartContentsFile(c);
    return { name: f.name, mimeType: f.name.endsWith('.png') ? 'image/png' : 'image/vnd.adobe.photoshop', bytes: f.bytes };
  }

  /**
   * Layer › Smart Objects › New Smart Object via Copy (`linked: false`: independent contents) or a
   * linked duplicate (`linked: true`: edits to the contents show in both), directly above, as one
   * undo step. Returns the copy's id.
   */
  public copySmartObject(id: string, linked = false, name?: string): string {
    const res = copySmartObjectOp(this.state.layers, id, linked, name);
    this.commitLayers(res.layers, () => {
      this.state.activeLayerId = res.layer.id;
      this.state.activeTarget = 'pixels';
    });
    return res.layer.id;
  }

  /** Adds a smart filter (`develop` or `blur`, with `blend` and `opacity`) at `index` (default the top), as one undo step. */
  public addSmartFilter(id: string, filter: Record<string, unknown> & { kind: string }, index?: number): SmartFilter {
    const res = addSmartFilterOp(this.state.layers, id, normalizeSmartFilter(filter), this.canvasSize, index);
    this.commitLayers(res.layers);
    return res.filter;
  }

  /** Changes one smart filter (one undo step, or none with `commitToHistory = false` during a drag). */
  public updateSmartFilter(id: string, filterId: string, changes: Record<string, unknown>, commitToHistory = true): SmartFilter {
    const res = updateSmartFilterOp(this.state.layers, id, filterId, changes, this.canvasSize);
    this.commitLayers(res.layers, undefined, commitToHistory);
    return res.filter;
  }

  /** Removes one smart filter (one undo step). Returns the remaining filters. */
  public removeSmartFilter(id: string, filterId: string): SmartFilter[] {
    const res = removeSmartFilterOp(this.state.layers, id, filterId, this.canvasSize);
    this.commitLayers(res.layers);
    return res.layer.smartFilters?.filters ?? [];
  }

  /** Moves one smart filter to `index` (0 = bottom, applied first), as one undo step. Returns the filters. */
  public moveSmartFilter(id: string, filterId: string, index: number): SmartFilter[] {
    const res = moveSmartFilterOp(this.state.layers, id, filterId, index, this.canvasSize);
    this.commitLayers(res.layers);
    return res.layer.smartFilters?.filters ?? [];
  }

  /** Turns a smart object's whole filter stack on or off (one undo step). */
  public setSmartFiltersEnabled(id: string, enabled: boolean): boolean {
    const res = setSmartFiltersEnabledOp(this.state.layers, id, enabled, this.canvasSize);
    this.commitLayers(res.layers);
    return res.layer.smartFilters?.enabled ?? true;
  }

  /**
   * Sets the smart filter mask (one undo step): `reveal-all`, `hide-all`, `selection` (the
   * selection's coverage), or `none` to remove it; `props` sets density, feather, enabled and linked.
   * Painting it targets channel `filter-mask`. Returns the mask, or `null` when removed.
   */
  public setSmartFilterMask(id: string, from: 'reveal-all' | 'hide-all' | 'selection' | 'none' | 'keep', props: LayerMaskProps = {}, commitToHistory = true): RasterMask | null {
    const layer = requireSmartObject(this.state.layers, id);
    let mask: RasterMask | null;
    if (from === 'none') mask = null;
    else if (from === 'keep') {
      if (!layer.smartFilters?.mask) throw new LayerOperationError(`Smart object "${layer.name || id}" has no filter mask; add one with from reveal-all, hide-all or selection.`);
      mask = withMaskProps(layer.smartFilters.mask, props);
    } else if (from === 'selection') {
      const sel = this.state.selection;
      if (!sel?.bounds) throw new LayerOperationError('Nothing is selected; select first, or use reveal-all / hide-all.');
      mask = this.maskFromSelection(sel, props);
    } else {
      const v = from === 'reveal-all' ? 255 : 0;
      mask = withMaskProps({ surface: emptySurface(1, v), defaultValue: v }, props);
    }
    const res = setSmartFilterMaskOp(this.state.layers, id, mask, this.canvasSize);
    this.commitLayers(res.layers, () => {
      if (this.state.activeLayerId !== id) return;
      if (mask && from !== 'keep') this.state.activeTarget = 'filter-mask';
      else if (!mask && this.state.activeTarget === 'filter-mask') this.state.activeTarget = 'pixels';
    }, commitToHistory);
    return res.layer.smartFilters?.mask ?? null;
  }

  /**
   * Decodes smart object contents that came as files the synchronous decoders cannot read (a JPEG
   * or TIFF embedded in a PSD), through the browser's image decoder. No undo step: the pixels on
   * screen do not change. Returns the contents ids still undecoded.
   */
  public async prepareSmartObjects(): Promise<string[]> {
    const pending = new Map<string, SmartContents>();
    for (const l of flattenLayers(this.state.layers)) {
      if (l.type === 'smart' && !isContentsDecoded(l.contents) && l.contents.file && BROWSER_IMAGE_TYPES[l.contents.file.type]) pending.set(l.contents.id, l.contents);
    }
    const left: string[] = [];
    for (const [cid, c] of pending) {
      try {
        const url = `data:${BROWSER_IMAGE_TYPES[c.file!.type]};base64,${bytesToBase64(c.file!.bytes)}`;
        const px = await this.decodeImage(url);
        const decoded: SmartContents = { ...c, kind: 'raster', raster: rasterContents(px, c.name, cid).raster, width: px.width, height: px.height };
        const swap = (layers: ImageLayer[]) => {
          let out = layers;
          for (const l of flattenLayers(layers)) if (l.type === 'smart' && l.contents.id === cid) out = mapLayer(out, l.id, (x) => ({ ...(x as SmartObjectLayer), contents: decoded }));
          return out;
        };
        this.state.layers = swap(this.state.layers);
        for (const e of [...this.undoStack, ...this.redoStack]) e.layers = swap(e.layers);
      } catch {
        left.push(cid);
      }
    }
    if (pending.size) this.notify();
    return left;
  }

  // --- Smart object contents (Edit Contents) ---

  private contentsStack: Array<{ layerId: string; contentsId: string; name: string; saved: SavedDocument }> = [];

  /** The smart objects whose contents are open (outermost first); empty when the document itself is shown. */
  public getEditingContents(): Array<{ layerId: string; name: string }> {
    return this.contentsStack.map((e) => ({ layerId: e.layerId, name: e.name }));
  }

  /**
   * Layer › Smart Objects › Edit Contents: shows the smart object's contents as a document of their
   * own (a layer document, or raster contents as one pixel layer), with their own undo history.
   * Every editor operation and tool then works on the contents until `closeSmartObjectContents`.
   * Contents can nest. Returns the contents' size and layer ids.
   */
  public editSmartObjectContents(id: string): { layerId: string; depth: number; width: number; height: number; layerIds: string[] } {
    if (this.getFreeTransform()) throw new LayerOperationError('A Free Transform is open; commit or cancel it first.');
    const layer = requireSmartObject(this.state.layers, id);
    const c = layer.contents;
    if (!isContentsDecoded(c)) throw new LayerOperationError(`The contents of "${layer.name || id}" are a ${c.file?.type ?? 'file'} that could not be decoded here; run prepareSmartObjects() in a browser first.`);
    const saved: SavedDocument = {
      state: { ...this.state },
      undo: this.undoStack,
      redo: this.redoStack,
      initial: this.initialSnapshot,
      element: this.imageElement,
      samplePixels: this.samplePixels,
      samplePixelsOverride: this.samplePixelsOverride,
      psdResolution: this.psdResolution,
    };
    const layers: ImageLayer[] =
      c.kind === 'document'
        ? c.document!.layers
        : [{ type: 'pixel', id: newLayerId(), name: 'Layer 0', visible: true, opacity: 1, blend: 'normal', surface: c.raster!, offset: { x: 0, y: 0 } }];
    this.contentsStack.push({ layerId: layer.id, contentsId: c.id, name: layer.name || c.name, saved });
    const s = this.state;
    this.state = {
      ...s,
      sourceUrl: null,
      imageDimensions: { width: c.width, height: c.height },
      crop: null,
      transform: { ...DEFAULT_TRANSFORM_VALUES },
      layers,
      activeLayerId: layers.length ? layers[layers.length - 1].id : null,
      activeTarget: 'pixels',
      selection: null,
      selectedAnnotationId: null,
      outputOpacity: 1,
      zoom: 1,
      pan: { x: 0, y: 0 },
      editingContents: this.getEditingContents(),
    };
    delete this.state.legacyOutputBlur;
    if (c.document?.globalLight) this.state.globalLight = c.document.globalLight;
    else delete this.state.globalLight;
    if (c.document?.patterns?.length) this.state.patterns = c.document.patterns;
    else delete this.state.patterns;
    this.imageElement = null;
    this.samplePixels = null;
    this.samplePixelsOverride = false;
    this.undoStack = [];
    this.redoStack = [];
    this.viewKey = [];
    this.initialSnapshot = this.captureHistoryEntry();
    this.notify();
    return { layerId: layer.id, depth: this.contentsStack.length, width: c.width, height: c.height, layerIds: flattenLayers(layers).map((l) => l.id) };
  }

  /**
   * Closes the innermost open contents: with `save` (default) the edited layers become the smart
   * object's contents, and it and every linked instance render again (one undo step in the
   * document); without, the edits are dropped. Returns the smart object and the layers that changed.
   */
  public closeSmartObjectContents(save = true): { layerId: string; changed: boolean; layerIds: string[] } {
    const top = this.contentsStack.pop();
    if (!top) throw new LayerOperationError('No smart object contents are open; open them with edit_smart_object_contents.');
    if (this.openTransform?.isOpen) this.openTransform.cancel();
    this.openTransform = null;
    const edited = this.state;
    const changed = save && this.undoStack.length > 0;
    let next: SmartContents | null = null;
    if (changed) {
      const layer = findLayer(top.saved.state.layers, top.layerId)?.layer as SmartObjectLayer | undefined;
      const old = layer?.contents;
      const { width, height } = edited.imageDimensions;
      const only = edited.layers.length === 1 ? edited.layers[0] : null;
      const plain =
        only?.type === 'pixel' && only.visible && only.opacity === 1 && only.blend === 'normal' && !only.mask && !only.effects && !only.filters?.length && !only.clipped && (only.fillOpacity ?? 1) === 1 && only.source !== 'document';
      if (old?.kind === 'raster' && plain) {
        const px = readRegion(only.surface, { x: -only.offset.x, y: -only.offset.y, width, height });
        next = rasterContents({ width, height, data: px }, old.name, old.id);
      } else {
        const doc = { layers: edited.layers, globalLight: edited.globalLight, patterns: edited.patterns };
        next = documentContents(doc, width, height, old?.kind === 'document' ? old.name : `${(old?.name ?? 'Contents').replace(/\.\w+$/, '')}.psb`, top.contentsId);
      }
    }
    const saved = top.saved;
    this.state = saved.state;
    this.undoStack = saved.undo;
    this.redoStack = saved.redo;
    this.initialSnapshot = saved.initial;
    this.imageElement = saved.element;
    this.samplePixels = saved.samplePixels;
    this.samplePixelsOverride = saved.samplePixelsOverride;
    this.psdResolution = saved.psdResolution;
    this.viewKey = [];
    if (this.contentsStack.length) this.state.editingContents = this.getEditingContents();
    else delete this.state.editingContents;
    if (!next) {
      this.notify();
      return { layerId: top.layerId, changed: false, layerIds: [] };
    }
    const res = replaceContentsOp(this.state.layers, top.contentsId, next, this.canvasSize);
    this.commitLayers(res.layers);
    return { layerId: top.layerId, changed: true, layerIds: res.ids };
  }

  /** The document's own layers (not the contents open for editing). */
  private rootLayers(): ImageLayer[] {
    return this.contentsStack[0]?.saved.state.layers ?? this.state.layers;
  }

  /** Drops every open contents edit (loading another document). */
  private abandonContents(): void {
    while (this.contentsStack.length) this.closeSmartObjectContents(false);
  }

  // --- Layer effects ---

  /** A layer's effects (an empty, enabled list when it has none). */
  public getLayerEffects(id: string): LayerEffects {
    return layerEffectsOf(requireLayer(this.state.layers, id).layer);
  }

  /**
   * Adds an effect of `kind` with Photoshop's defaults and `params` applied (one undo step), at
   * `index` in the layer's effect list (default the end). Returns the new effect and the effects.
   */
  public addLayerEffect(id: string, kind: LayerEffectKind, params: Record<string, unknown> = {}, index?: number): { effect: LayerEffect; effects: LayerEffects } {
    const res = addLayerEffectOp(this.state.layers, id, kind, params, index);
    this.commitLayers(res.layers);
    return { effect: res.effect, effects: this.getLayerEffects(id) };
  }

  /** Changes one effect (one undo step, or none with `commitToHistory = false` during a drag). Returns the effects. */
  public updateLayerEffect(id: string, effectId: string, changes: Record<string, unknown>, commitToHistory = true): LayerEffects {
    this.commitLayers(updateLayerEffectOp(this.state.layers, id, effectId, changes), undefined, commitToHistory);
    return this.getLayerEffects(id);
  }

  /** Removes one effect (one undo step). Returns the remaining effects. */
  public removeLayerEffect(id: string, effectId: string): LayerEffects {
    this.commitLayers(removeLayerEffectOp(this.state.layers, id, effectId));
    return this.getLayerEffects(id);
  }

  /** Turns a layer's effects on or off as a whole and, when given, sets Scale Effects (one undo step). */
  public setLayerEffectsEnabled(id: string, enabled: boolean, scale?: number, commitToHistory = true): LayerEffects {
    this.commitLayers(setLayerEffectsEnabledOp(this.state.layers, id, enabled, scale), undefined, commitToHistory);
    return this.getLayerEffects(id);
  }

  /** Replaces a layer's effects (one undo step; `null` removes them). Returns the effects. */
  public setLayerEffects(id: string, effects: LayerEffects | null, commitToHistory = true): LayerEffects {
    this.commitLayers(setLayerEffectsOp(this.state.layers, id, effects), undefined, commitToHistory);
    return this.getLayerEffects(id);
  }

  private patternIds = new WeakMap<object, number>();

  /** Changes whenever the document's pattern list is replaced (the compositor then drops its caches). */
  private patternsVersion(): number {
    const list = this.state.patterns;
    if (!list) return 0;
    let id = this.patternIds.get(list);
    if (id === undefined) {
      id = this.nextSourceId++;
      this.patternIds.set(list, id);
    }
    return id;
  }

  /** The document's patterns (from an opened PSD), besides the built-in ones. */
  public getDocumentPatterns(): EffectPattern[] {
    return this.state.patterns ?? [];
  }

  /** The light effects with "use global light" follow. */
  public getGlobalLight(): GlobalLight {
    return { ...(this.state.globalLight ?? DEFAULT_GLOBAL_LIGHT) };
  }

  /** Sets the global light (one undo step). `angle` -360..360°, `altitude` 0..90°. Returns it. */
  public setGlobalLight(light: Partial<GlobalLight>, commitToHistory = true): GlobalLight {
    const next = { ...this.getGlobalLight(), ...light };
    if (!(Number.isFinite(next.angle) && next.angle >= -360 && next.angle <= 360)) throw new LayerOperationError(`angle must be from -360 to 360 degrees, got ${next.angle}.`);
    if (!(Number.isFinite(next.altitude) && next.altitude >= 0 && next.altitude <= 90)) throw new LayerOperationError(`altitude must be from 0 to 90 degrees, got ${next.altitude}.`);
    if (commitToHistory) this.recordHistory();
    if (next.angle === DEFAULT_GLOBAL_LIGHT.angle && next.altitude === DEFAULT_GLOBAL_LIGHT.altitude) delete this.state.globalLight;
    else this.state.globalLight = next;
    this.notify();
    return this.getGlobalLight();
  }

  /** Composites `layers` (in isolation) over `rect` into a surface, loading depth maps first. */
  private async compositeToSurface(layers: ImageLayer[], rect: CropBox): Promise<PixelSurface> {
    const { width, height } = this.naturalSize;
    if (flattenLayers(layers).some((l) => l.type === 'annotation' && l.visible) && !this.renderer.canRasterize()) {
      throw new LayerOperationError('Merging annotation layers needs a canvas (a browser); hide or delete them first, or merge in the browser.');
    }
    await this.renderer.prepareLayerAssets(layers, width, height);
    const sources = this.renderer.compositorSources(width, height);
    const depth = this.bitDepth;
    if (depth !== 8) {
      // Merges keep the document's depth.
      const samples = workingToSamples(compositeDeep(layers, rect, sources, depth), depth);
      return surfaceFromDeepPixels({ width: rect.width, height: rect.height, data: samples }, 4, rect.x, rect.y);
    }
    const data = new LayerCompositor().composite(layers, rect, sources);
    return surfaceFromPixels({ width: rect.width, height: rect.height, data }, 4, rect.x, rect.y);
  }

  /**
   * The composite of the layer stack at the document's bit depth (as `compositePixels`, no
   * canvas): 16-bit sRGB samples, or 32-bit linear float, over `rect` (default the canvas). At 8
   * bits, the 8-bit composite widened to 16 bits.
   */
  public compositeDeepPixels(rect?: CropBox): { width: number; height: number; depth: 16 | 32; data: Uint16Array | Float32Array } {
    const { width, height } = this.naturalSize;
    const r = rect ?? { x: 0, y: 0, width, height };
    const depth = this.bitDepth;
    if (depth === 8) return { width: r.width, height: r.height, depth: 16, data: to16From8(this.compositePixels(r).data as Uint8ClampedArray) };
    const data = workingToSamples(compositeDeep(this.state.layers, r, this.compositorSources(), depth), depth);
    return { width: r.width, height: r.height, depth, data };
  }

  /** Document bounds a layer can paint into (pixel content, annotations, or the canvas for the rest). */
  private paintBounds(layer: ImageLayer): CropBox {
    const { width, height } = this.naturalSize;
    const canvas = { x: 0, y: 0, width, height };
    if (hasSurface(layer)) return this.getLayerBounds(layer.id) ?? { x: 0, y: 0, width: 0, height: 0 };
    if (layer.type === 'annotation') {
      const b = getAnnotationBounds(layer.annotation);
      const pad = 4 + ('strokeWidth' in layer.annotation ? (layer.annotation as { strokeWidth: number }).strokeWidth : 0);
      return coveringRect({ x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad });
    }
    if (layer.type === 'group') {
      let r: CropBox | null = null;
      for (const c of layer.children) r = unionRect(r, this.paintBounds(c));
      return r ?? canvas;
    }
    return canvas;
  }

  /**
   * Merge Down: composites a layer onto the pixel layer directly below it (which keeps its name,
   * opacity and blend; masks, fill, filters and both layers' effects are baked), as one undo step.
   * Returns the merged id.
   */
  public async mergeDown(id: string): Promise<string> {
    const loc = requireLayer(this.state.layers, id);
    const upper = loc.layer;
    const siblings = loc.parent ? loc.parent.children : this.state.layers;
    const lower = siblings[loc.index - 1];
    if (!lower) throw new LayerOperationError(`Layer "${upper.name || id}" is the bottom of its group; there is nothing below to merge into.`);
    if (lower.type !== 'pixel') throw new LayerOperationError(`Merge Down needs a pixel layer below; "${lower.name || lower.id}" is a ${lower.type} layer. Move the layer or merge into another one.`);
    if (!upper.visible) throw new LayerOperationError(`Layer "${upper.name || id}" is hidden; show it or delete it instead of merging.`);
    requireUnlocked(upper, 'all', 'merge it');
    requireUnlocked(lower, 'pixels', 'merge into it');
    let rect = unionRect(this.paintBounds(lower), upper.type === 'adjustment' ? null : this.paintBounds(upper)) ?? { x: 0, y: 0, width: 1, height: 1 };
    // Effects paint beyond the layers' pixels: merge as far as they reach.
    const reach = Math.max(effectsMargin(lower.effects), upper.type === 'adjustment' ? 0 : effectsMargin(upper.effects));
    if (reach) rect = { x: rect.x - reach, y: rect.y - reach, width: rect.width + 2 * reach, height: rect.height + 2 * reach };
    const base: PixelLayer = { ...lower, blend: 'normal', opacity: 1 };
    delete base.clipped;
    const surface = await this.compositeToSurface([base, upper], rect);
    const merged: PixelLayer = { ...lower, surface, offset: { x: 0, y: 0 } };
    delete merged.mask;
    delete merged.fillOpacity;
    delete merged.filters;
    delete merged.source;
    delete merged.effects;
    let next = mapLayer(this.state.layers, id, () => null);
    next = mapLayer(next, lower.id, () => merged);
    this.commitLayers(next, () => {
      this.state.activeLayerId = merged.id;
      this.state.activeTarget = 'pixels';
    });
    return merged.id;
  }

  /**
   * Merge Visible: the visible top-level layers become one normal pixel layer (at the position of
   * the lowest of them); hidden layers stay. One undo step. Returns the merged id.
   */
  public async mergeVisible(): Promise<string> {
    const visible = this.state.layers.filter((l) => l.visible);
    if (!visible.length) throw new LayerOperationError('No layer is visible.');
    const { width, height } = this.naturalSize;
    const surface = await this.compositeToSurface(visible, { x: 0, y: 0, width, height });
    const merged: PixelLayer = {
      type: 'pixel',
      id: newLayerId(),
      name: 'Merged',
      visible: true,
      opacity: 1,
      blend: 'normal',
      surface,
      offset: { x: 0, y: 0 },
    };
    const at = this.state.layers.indexOf(visible[0]);
    const next = this.state.layers.filter((l) => !l.visible);
    next.splice(this.state.layers.slice(0, at).filter((l) => !l.visible).length, 0, merged);
    this.commitLayers(next, () => {
      this.state.activeLayerId = merged.id;
      this.state.activeTarget = 'pixels';
      this.state.selectedAnnotationId = null;
    });
    return merged.id;
  }

  /** Flatten Image: every visible layer composited into one Background layer; hidden layers are discarded. One undo step. */
  public async flattenImage(): Promise<string> {
    const { width, height } = this.naturalSize;
    const surface = await this.compositeToSurface(this.state.layers, { x: 0, y: 0, width, height });
    const bg: PixelLayer = {
      type: 'pixel',
      id: BACKGROUND_LAYER_ID,
      name: BACKGROUND_LAYER_NAME,
      visible: true,
      opacity: 1,
      blend: 'normal',
      surface,
      offset: { x: 0, y: 0 },
    };
    this.commitLayers([bg], () => {
      this.state.activeLayerId = bg.id;
      this.state.activeTarget = 'pixels';
      this.state.selectedAnnotationId = null;
    });
    return bg.id;
  }

  private thumbCache = new WeakMap<object, Map<string, PixelBuffer>>();

  /**
   * A small RGBA preview of a pixel layer over the canvas (or of its mask with `mask: true`),
   * longest side `maxSide` px, point-sampled; `null` for layers without pixels.
   */
  public getLayerThumbnail(id: string, options: { maxSide?: number; mask?: boolean } = {}): PixelBuffer | null {
    const layer = this.getLayer(id);
    if (!layer) return null;
    const { width, height } = this.naturalSize;
    const side = Math.max(4, Math.min(256, Math.round(options.maxSide ?? 48)));
    const k = Math.min(1, side / Math.max(width, height));
    const tw = Math.max(1, Math.round(width * k));
    const th = Math.max(1, Math.round(height * k));
    const surface = options.mask ? (layer.mask && !layer.mask.source ? layer.mask.surface : null) : hasSurface(layer) ? this.surfaceOf(layer) : null;
    if (!surface) return null;
    const ox = layer.type === 'pixel' ? layer.offset.x : 0;
    const oy = layer.type === 'pixel' ? layer.offset.y : 0;
    const key = `${tw}x${th}:${ox},${oy}`;
    let byKey = this.thumbCache.get(surface);
    const hit = byKey?.get(key);
    if (hit) return hit;
    const out = new Uint8ClampedArray(tw * th * 4);
    for (let y = 0; y < th; y++) {
      const dy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / th)) - oy;
      for (let x = 0; x < tw; x++) {
        const dx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / tw)) - ox;
        const v = readPixel(surface, dx, dy);
        const i = (y * tw + x) * 4;
        if (surface.channels === 1) {
          out[i] = out[i + 1] = out[i + 2] = v[0];
          out[i + 3] = 255;
        } else out.set(v, i);
      }
    }
    const thumb = { width: tw, height: th, data: out };
    if (!byKey) {
      byKey = new Map();
      this.thumbCache.set(surface, byKey);
    }
    byKey.set(key, thumb);
    return thumb;
  }

  /**
   * A small PNG data URL preview of a pixel or smart layer over the canvas (or of its mask with `mask: true`),
   * longest side `maxSide` px; `null` for layers without pixels.
   */
  public getLayerThumbnailDataURL(id: string, options: { maxSide?: number; mask?: boolean } = {}): string | null {
    const thumb = this.getLayerThumbnail(id, options);
    if (!thumb) return null;
    return pngDataUrl(thumb.width, thumb.height, thumb.data, 4);
  }

  // --- Painting ---

  /** Brush settings, colours and tool options of the paint tools (view state, no undo). */
  public setPaintOptions(
    options: Partial<Omit<PaintOptions, 'brush' | 'mixer' | 'mixerLoad' | 'retouch' | 'cloneSource' | 'cloneTransform'>> & {
      brush?: Partial<BrushSettings>;
      mixer?: Partial<MixerSettings>;
      retouch?: Partial<RetouchSettings>;
    }
  ): PaintOptions {
    const cur = this.state.paint;
    const retouch = options.retouch ? normalizeRetouch(options.retouch, cur.retouch) : cur.retouch;
    // Turning Aligned off (or on) starts the offset afresh at the next stroke.
    const cloneSource = cur.cloneSource && retouch.aligned !== cur.retouch.aligned ? { ...cur.cloneSource, offset: null } : cur.cloneSource;
    let source = cur.paint;
    let foreground = options.foreground !== undefined ? toHex(parseColor(options.foreground)) : cur.foreground;
    if (options.paint !== undefined) {
      const p = readImagePaint(options.paint);
      if (p.type === 'color') foreground = p.color;
      source = p;
    }
    if (source.type === 'color' || options.foreground !== undefined) source = { type: 'color', color: foreground };
    const next: PaintOptions = {
      brush: options.brush ? normalizeBrush({ ...cur.brush, ...options.brush }) : cur.brush,
      foreground,
      background: options.background !== undefined ? toHex(parseColor(options.background)) : cur.background,
      paint: source,
      mixer: options.mixer ? normalizeMixer({ ...cur.mixer, ...options.mixer }) : cur.mixer,
      mixerLoad: cur.mixerLoad,
      retouch,
      cloneSource,
      cloneTransform: cur.cloneTransform,
    };
    this.state.paint = next;
    this.notify();
    return next;
  }

  /**
   * Loads the Mixer Brush's reservoir full with `color` (default the foreground); the picked-up
   * colour is kept. View state, no undo. Returns the brush load.
   */
  public loadMixerBrush(color?: string | number[]): MixerLoad {
    const c = parseColor(color ?? this.state.paint.foreground);
    const load = loadMixer(this.state.paint.mixerLoad, [c[0] / 255, c[1] / 255, c[2] / 255]);
    this.state.paint = { ...this.state.paint, mixerLoad: load };
    this.notify();
    return load;
  }

  /** Cleans the Mixer Brush: empties the pickup well (the reservoir is kept). Returns the brush load. */
  public cleanMixerBrush(): MixerLoad {
    const load = cleanMixer(this.state.paint.mixerLoad);
    this.state.paint = { ...this.state.paint, mixerLoad: load };
    this.notify();
    return load;
  }

  /** Empties the Mixer Brush entirely (no reservoir, nothing picked up). Returns the brush load. */
  public emptyMixerBrush(): MixerLoad {
    this.state.paint = { ...this.state.paint, mixerLoad: EMPTY_MIXER_LOAD };
    this.notify();
    return EMPTY_MIXER_LOAD;
  }

  /**
   * Sets (Alt-click) or clears the Clone Stamp and Healing Brush source point, in document
   * pixels. The next stroke fixes the offset from its first point. View state, no undo.
   */
  public setCloneSource(point: { x: number; y: number } | null): CloneSource | null {
    if (point && (!Number.isFinite(point.x) || !Number.isFinite(point.y))) throw new LayerOperationError('The clone source needs finite x and y (document pixels).');
    const source = point ? { x: Math.round(point.x), y: Math.round(point.y), offset: null } : null;
    this.state.paint = { ...this.state.paint, cloneSource: source };
    this.notify();
    return source;
  }

  /**
   * The Clone Source panel's transform for the Clone Stamp and Healing Brush: `scaleX` / `scaleY`
   * (factors, 0.01..10 in size; negative flips) and `rotate` (degrees, clockwise), merged into the
   * current one; `null` resets it. View state, no undo. Returns the transform.
   */
  public setCloneTransform(t: Partial<CloneTransform> | null): CloneTransform {
    const cur = this.state.paint.cloneTransform;
    const next: CloneTransform = t ? { ...cur, ...t } : { ...IDENTITY_CLONE_TRANSFORM };
    for (const k of ['scaleX', 'scaleY'] as const) {
      const v = next[k];
      if (!Number.isFinite(v) || Math.abs(v) < 0.01 || Math.abs(v) > 10) throw new LayerOperationError(`${k} must be a scale factor between 0.01 and 10 in size (negative flips), not ${String(v)}.`);
    }
    if (!Number.isFinite(next.rotate)) throw new LayerOperationError('rotate must be a number of degrees.');
    next.rotate = ((((next.rotate + 180) % 360) + 360) % 360) - 180;
    this.state.paint = { ...this.state.paint, cloneTransform: next };
    this.notify();
    return next;
  }

  /** D: black foreground, white background. */
  public resetPaintColors(): void {
    this.setPaintOptions({ foreground: '#000000', background: '#ffffff' });
  }

  /** X: swaps the foreground and background colours. */
  public swapPaintColors(): void {
    const { foreground, background } = this.state.paint;
    this.setPaintOptions({ foreground: background, background: foreground });
  }

  /** Resolves and validates what a stroke, fill or clear paints into. */
  private paintTarget(layerId: string | undefined, channel: LayerTarget | undefined, action: string) {
    const id = layerId ?? this.state.activeLayerId;
    if (!id) throw new LayerOperationError(`No layer given and none is active; pass layerId (see list_layers) to ${action}.`);
    const layer = requireLayer(this.state.layers, id).layer;
    const ch: LayerTarget = channel ?? (id === this.state.activeLayerId ? this.state.activeTarget : 'pixels');
    if (ch === 'mask') {
      if (!layer.mask) throw new LayerOperationError(`Layer "${layer.name || id}" has no mask to ${action}; add one with add_layer_mask, or target pixels.`);
      if (layer.mask.source) throw new LayerOperationError(`Layer "${layer.name || id}" has a depth mask, which is generated, not painted.`);
      requireUnlocked(layer, 'all', action);
    } else if (ch === 'filter-mask') {
      if (layer.type !== 'smart' || !layer.smartFilters?.mask) {
        throw new LayerOperationError(`Layer "${layer.name || id}" has no smart filter mask to ${action}; add one with set_smart_filter_mask, or target pixels or mask.`);
      }
      if (!isContentsDecoded(layer.contents)) throw new LayerOperationError(`The contents of "${layer.name || id}" are not decoded here, so its filter mask cannot be painted; run prepareSmartObjects() first.`);
      requireUnlocked(layer, 'all', action);
    } else {
      if (layer.type === 'smart') throw new LayerOperationError(`Layer "${layer.name || id}" is a smart object; its pixels come from its contents. Rasterize it (rasterize_smart_object), edit its contents (edit_smart_object_contents), or ${action} on its mask or filter mask.`);
      if (layer.type === 'shape') throw new LayerOperationError(`Layer "${layer.name || id}" is a shape layer; its pixels are drawn from its paths. Rasterize it first (rasterize_layer), or ${action} on its mask (channel mask).`);
      if (layer.type === 'type') throw new LayerOperationError(`Layer "${layer.name || id}" is a type layer; its pixels are drawn from its text. Rasterize it first (rasterize_layer), or ${action} on its mask (channel mask).`);
      if (layer.type !== 'pixel') throw new LayerOperationError(`Layer "${layer.name || id}" is a ${layer.type} layer; ${action} on a pixel layer, or on this layer's mask (channel mask).`);
      requireUnlocked(layer, 'pixels', action);
    }
    if (!layer.visible) throw new LayerOperationError(`Layer "${layer.name || id}" is hidden; show it before you ${action}.`);
    const offset = layer.type === 'pixel' ? layer.offset : { x: 0, y: 0 };
    const surface = ch === 'mask' ? layer.mask!.surface : ch === 'filter-mask' ? (layer as SmartObjectLayer).smartFilters!.mask!.surface : this.surfaceOf(layer as PixelLayer);
    const lockTransparency = ch === 'pixels' && Boolean(layer.locks?.transparency);
    return { id, layer, channel: ch, offset, surface, lockTransparency };
  }

  /** The layer with its pixels (or mask) replaced by `surface`. */
  private withSurface(layer: ImageLayer, channel: LayerTarget, surface: TiledSurface): ImageLayer {
    if (channel === 'mask') return { ...layer, mask: { ...layer.mask!, surface } } as ImageLayer;
    if (channel === 'filter-mask') return withFilterMaskSurface(layer as SmartObjectLayer, surface, this.canvasSize);
    const next = { ...(layer as PixelLayer), surface };
    delete next.source;
    return next;
  }

  /**
   * Starts a brush or eraser stroke on a layer's pixels or mask (default: the active layer and
   * target, the paint options' brush and colours). Feed points with `push`, finish with `end()`
   * (one undo step for the whole stroke) or `cancel()`. While it runs, the stack shows the stroke
   * without recording history.
   */
  public beginStroke(init: StrokeInit = {}): PaintStrokeSession {
    const tool = init.tool ?? 'brush';
    if (!STROKE_TOOLS.includes(tool)) throw new LayerOperationError(`Unknown paint tool "${String(tool)}"; use one of ${STROKE_TOOLS.join(', ')}.`);
    const target = this.paintTarget(init.layerId, init.channel, tool === 'eraser' ? 'erase' : isRetouchTool(tool) ? 'retouch' : 'paint');
    if (tool === 'mixer' && target.channel !== 'pixels') {
      throw new LayerOperationError('The Mixer Brush paints colour on pixels, not on masks; target pixels (channel pixels), or paint the mask with the brush.');
    }
    const brush = normalizeBrush({ ...this.state.paint.brush, ...(init.brush ?? {}) });
    // Gradient paint (the brush only): the stroke's own paint, else the paint options' unless a colour is given.
    let strokePaint: PaintSource | null = null;
    if (init.paint !== undefined) {
      strokePaint = readImagePaint(init.paint);
      if (strokePaint.type === 'color') init = { ...init, color: strokePaint.color };
    } else if (init.color === undefined) strokePaint = this.state.paint.paint;
    const color = parseColor(init.color ?? this.state.paint.foreground);
    const background = parseColor(init.background ?? this.state.paint.background);
    const toMaskGrey = (c: [number, number, number, number]) => {
      const g = Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
      return [g, g, g, 255] as [number, number, number, number];
    };
    const apply: StrokeApply = {
      mode: tool === 'eraser' ? 'erase' : 'paint',
      color: target.channel !== 'pixels' ? toMaskGrey(color) : color,
      background: target.channel !== 'pixels' ? toMaskGrey(background) : background,
      opacity: brush.opacity,
      blend: target.channel !== 'pixels' ? 'normal' : brush.blend,
      lockTransparency: target.lockTransparency,
      selection: this.state.selection?.bounds ? this.state.selection : null,
      offset: target.offset,
    };
    const depth = target.channel !== 'filter-mask' && this.bitDepth !== 8 ? this.bitDepth : null;
    if (tool === 'mixer') return new PaintStrokeSession(this, target, this.mixerStroke(init, brush), apply, depth);
    // The retouching tools work on the deep samples too (sources read at depth).
    if (isRetouchTool(tool)) return new PaintStrokeSession(this, target, this.retouchStroke(tool, init, brush, target, apply), apply, depth);
    const gradient = tool === 'brush' && strokePaint?.type === 'gradient' ? resolvePaintGradient(strokePaint, { paint: toHex(color), secondary: toHex(background) }) : null;
    return new PaintStrokeSession(this, target, new StrokeCoverage(brush, gradient, init.seed ?? 0), apply, depth);
  }

  /** A retouching stroke's start: its settings, what it samples and how it composites. */
  private retouchStroke(tool: RetouchTool, init: StrokeInit, brush: BrushSettings, target: ReturnType<ImageEditorController['paintTarget']>, apply: StrokeApply): RetouchStrokeInit {
    const settings = normalizeRetouch(init.retouch ?? {}, this.state.paint.retouch);
    const mask = target.channel !== 'pixels';
    if (tool === 'sponge' && mask) throw new LayerOperationError('The Sponge changes saturation, and a mask has none; target pixels (channel pixels), or use dodge or burn on the mask.');
    if (tool === 'smudge') return { kind: 'dabs', create: (pixels) => new RetouchDabStroke(brush, pixels, smudgeEffect(brush, settings.strength)) };
    if (tool === 'sponge') return { kind: 'dabs', create: (pixels) => new RetouchDabStroke(brush, pixels, spongeEffect(brush, settings.spongeMode === 'saturate', settings.vibrance)) };
    const retouchApply: RetouchApply = {
      opacity: tool === 'clone' || tool === 'heal' || tool === 'history' ? brush.opacity : tool === 'blur' || tool === 'sharpen' ? brush.opacity * settings.strength : 1,
      blend: tool === 'clone' && !mask ? brush.blend : 'normal',
      lockTransparency: target.lockTransparency,
      selection: apply.selection,
      offset: target.offset,
    };
    const coverage = new StrokeCoverage(brush);
    if (tool === 'dodge' || tool === 'burn') {
      const paint: RetouchPaint = { kind: 'tone', tone: toneOf(tool, settings) };
      return { kind: 'coverage', coverage, apply: retouchApply, start: () => {}, paint: () => paint };
    }
    if (tool === 'blur' || tool === 'sharpen') {
      // The layer filtered tile by tile (read with a margin), laid through the coverage at `strength`.
      const n = target.surface.channels;
      const depth = !mask && this.bitDepth !== 8 ? this.bitDepth : null;
      const m = 6;
      const filtered = new TilePixelSource(
        (tx, ty) => {
          const r = { x: tx * TILE - m, y: ty * TILE - m, width: TILE + 2 * m, height: TILE + 2 * m };
          const d = workRegionOf(target.surface, r, depth);
          retouchFilter(d, r.width, r.height, n, tool, 2, 1.2);
          const out = new Float32Array(TILE * TILE * n);
          for (let y = 0; y < TILE; y++) out.set(d.subarray(((y + m) * r.width + m) * n, ((y + m) * r.width + m + TILE) * n), y * TILE * n);
          return out;
        },
        n,
        target.offset
      );
      const paint: RetouchPaint = { kind: 'source', source: filtered, dx: 0, dy: 0 };
      return { kind: 'coverage', coverage, apply: retouchApply, start: () => {}, paint: () => paint };
    }
    if (tool === 'history') {
      const steps = settings.historySteps;
      const entry = steps > 0 ? this.undoStack[this.undoStack.length - steps] ?? this.undoStack[0] : this.undoStack[0];
      if (!entry) throw new LayerOperationError('There is no earlier state to paint from yet: the History Brush paints a layer as it was some undo steps back. Make a change first.');
      const then = findLayer(entry.layers, target.id)?.layer;
      if (!then) throw new LayerOperationError(`Layer "${target.id}" did not exist ${steps > 0 ? `${steps} steps back` : 'in the oldest state'}; choose fewer history steps (historySteps).`);
      const surface = target.channel === 'mask' ? then.mask?.surface : then.type === 'pixel' ? then.surface : undefined;
      if (!surface) throw new LayerOperationError(`Layer "${target.id}" had no ${target.channel === 'mask' ? 'mask' : 'pixels'} in that state.`);
      const offset = then.type === 'pixel' ? then.offset : { x: 0, y: 0 };
      const depth = !mask && this.bitDepth !== 8 ? this.bitDepth : null;
      const source = depth ? new TilePixelSource((tx, ty) => workTileOf(surface.tiles.get(tileKey(tx, ty))), 4, offset) : this.surfaceSource(surface, offset);
      const paint: RetouchPaint = { kind: 'source', source, dx: 0, dy: 0 };
      return { kind: 'coverage', coverage, apply: retouchApply, start: () => {}, paint: () => paint };
    }
    // Masks sample only themselves; pixels sample the layer or the composite.
    const sample = mask ? 'current' : settings.sample;
    // At 16 or 32 bits the source reads deep samples, on the working tiles' 0..255 encoded scale.
    const deep = !mask && this.bitDepth !== 8 ? this.bitDepth : null;
    const own = deep ? new TilePixelSource((tx, ty) => workTileOf(target.surface.tiles.get(tileKey(tx, ty))), 4, target.offset) : this.surfaceSource(target.surface, target.offset);
    const source = sample === 'current' ? own : this.compositeSource(sample === 'all' ? null : target.id, deep);
    const pad = (r: CropBox, m: number): CropBox => ({ x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m });
    const covered = (cov: CoverageMap, r: CropBox) => {
      const m = new Uint8Array(r.width * r.height);
      for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) m[y * r.width + x] = cov.get(r.x + x, r.y + y) > 0 ? 1 : 0;
      return m;
    };
    if (tool === 'spot-heal') {
      const { width, height } = this.naturalSize;
      let patch: { x: number; y: number } | null = null;
      const trail: RetouchPaint = { kind: 'color', color: [0, 0, 0, 96] };
      return {
        kind: 'coverage',
        coverage,
        apply: retouchApply,
        start: () => {},
        paint: () => trail,
        finalPaint: (cov) => {
          if (!cov.bounds) return null;
          const win = spotHealWindow(cov.bounds, { width, height });
          if (win.width <= 0 || win.height <= 0) return null;
          const img = readSourceRegion(source, win);
          const hole = covered(cov, win);
          const healed = spotHealPixels(win.width, win.height, img, hole, brush.size, settings.spotType, (off) => {
            patch = off ? { x: off[0], y: off[1] } : null;
          });
          return { kind: 'source', source: new RegionPixelSource(win, healed), dx: 0, dy: 0 };
        },
        result: () => ({ spotHeal: { offset: patch } }),
      };
    }
    // Clone Stamp and Healing Brush: the offset from the source point.
    if (init.source) this.setCloneSource(init.source);
    const cs = this.state.paint.cloneSource;
    if (!cs) throw new LayerOperationError(`The ${tool === 'clone' ? 'Clone Stamp' : 'Healing Brush'} needs a source point; Alt-click the canvas, call set_clone_source, or pass source { x, y }.`);
    let offset = { x: 0, y: 0 };
    let first = { x: 0, y: 0 };
    // A Clone Source transform samples around the source point through its inverse (bilinear).
    const xf = this.state.paint.cloneTransform;
    // The target point that maps onto the source point is the source minus the offset.
    const transformed = isIdentityCloneTransform(xf)
      ? null
      : new TransformedPixelSource(source, (x, y) => cloneSamplePoint(xf, cs, { x: cs.x - offset.x, y: cs.y - offset.y }, x, y));
    const paint = (): RetouchPaint => (transformed ? { kind: 'source', source: transformed, dx: 0, dy: 0 } : { kind: 'source', source, dx: offset.x, dy: offset.y });
    return {
      kind: 'coverage',
      coverage,
      apply: retouchApply,
      start: (p) => {
        first = { x: Math.round(p.x), y: Math.round(p.y) };
        offset = settings.aligned && cs.offset ? { ...cs.offset } : { x: cs.x - first.x, y: cs.y - first.y };
        if (settings.aligned) this.state.paint = { ...this.state.paint, cloneSource: { x: cs.x, y: cs.y, offset: { ...offset } } };
      },
      paint,
      finalPaint:
        tool === 'heal'
          ? (cov) => {
              if (!cov.bounds) return null;
              const g = pad(cov.bounds, 2);
              const src = transformed ? readSourceRegion(transformed, g) : readSourceRegion(source, g, offset.x, offset.y);
              // The texture is fitted to what is seen: the layer, or the composite when sampling several layers.
              const dst = readSourceRegion(source, g);
              return { kind: 'source', source: new RegionPixelSource(g, healPixels(g.width, g.height, src, dst, covered(cov, g))), dx: 0, dy: 0 };
            }
          : undefined,
      result: () => ({ clone: { offset: { ...offset }, source: { x: first.x + offset.x, y: first.y + offset.y }, aligned: settings.aligned } }),
    };
  }

  /** A pixel source over a surface (layer pixels or a mask) in layer space at `offset`. */
  private surfaceSource(surface: TiledSurface, offset: { x: number; y: number }): PixelSource {
    return new TilePixelSource((tx, ty) => surface.tiles.get(tileKey(tx, ty))?.data ?? (surface.defaultValue ? defaultTile(surface) : null), surface.channels, offset);
  }

  /** A pixel source over the composite of the current layers (through `throughId` and below, or all of them), as it is now. */
  private compositeSource(throughId: string | null, depth: 16 | 32 | null = null): PixelSource {
    const stack = withoutAnnotations(this.state.layers);
    const layers = throughId ? layersThrough(stack, throughId) : stack;
    const sources = this.compositorSources();
    if (depth) {
      // The float composite, as a working tile (sRGB-encoded 0..255, straight alpha).
      return new TilePixelSource((tx, ty) => {
        const w = compositeDeep(layers, { x: tx * TILE, y: ty * TILE, width: TILE, height: TILE }, sources, depth);
        for (let i = 0; i < w.length; i += 4) {
          if (depth === 32) for (let c = 0; c < 3; c++) w[i + c] = srgbEncode(w[i + c]);
          for (let c = 0; c < 4; c++) w[i + c] *= 255;
        }
        return w;
      }, 4);
    }
    const compositor = new LayerCompositor();
    return new TilePixelSource((tx, ty) => compositor.tile(layers, tx, ty, sources), 4);
  }

  /** A Mixer Brush stroke's start: the settings, and the load (refilled when asked or set to). */
  private mixerStroke(init: StrokeInit, brush: BrushSettings): MixerStrokeInit {
    const settings = normalizeMixer({ ...this.state.paint.mixer, ...(init.mixer ?? {}) });
    let load = this.state.paint.mixerLoad;
    if (init.color !== undefined || settings.loadEachStroke) {
      const c = parseColor(init.color ?? this.state.paint.foreground);
      load = loadMixer(load, [c[0] / 255, c[1] / 255, c[2] / 255]);
    }
    return {
      create: (pixels) => new MixerStroke(brush, settings, load, pixels),
      end: (after) => {
        const next = settings.cleanEachStroke ? cleanMixer(after) : after;
        this.state.paint = { ...this.state.paint, mixerLoad: next };
        return next;
      },
    };
  }

  /** @internal Shows a stroke's live surface (no history). */
  public _strokeUpdate(layerId: string, channel: LayerTarget, surface: TiledSurface, rects: CropBox[]): void {
    this.state.layers = mapLayer(this.state.layers, layerId, (l) => this.withSurface(l, channel, surface));
    // A filter mask re-renders the smart object (and feathering spreads the change): redraw it all.
    this.notify(channel === 'filter-mask' ? undefined : rects);
  }

  /** @internal Commits a finished stroke as one undo step (`before` is the pre-stroke state). */
  public _strokeCommit(before: HistoryEntryHandle, layerId: string, channel: LayerTarget, surface: TiledSurface | null): void {
    if (surface) {
      const prev = (before as unknown as HistoryEntry).layers;
      this.state.layers = mapLayer(this.state.layers, layerId, (l) => this.withSurface(l, channel, surface));
      if (this.bitDepth !== 8) this.state.layers = keepDeepLayers(prev, this.state.layers);
    }
    else this.state.layers = (before as unknown as HistoryEntry).layers;
    if (surface && !this.isApplyingHistory) {
      this.undoStack.push(before as unknown as HistoryEntry);
      if (this.undoStack.length > this.maxHistoryDepth) this.undoStack.shift();
      this.redoStack = [];
      this.trimHistoryBytes();
    }
    this.notify();
  }

  /** @internal The pre-stroke snapshot. */
  public _captureForStroke(): HistoryEntryHandle {
    return this.captureHistoryEntry() as unknown as HistoryEntryHandle;
  }

  /**
   * Paints a whole stroke in one call (agents, replays): `points` in document pixels with optional
   * pressure, through the brush, eraser or Mixer Brush. One undo step. Returns the layer, channel, the changed
   * document bounds and the number of dabs.
   */
  public paintStroke(init: StrokeInit & { points: StrokePoint[] }): PaintStrokeResult {
    if (!Array.isArray(init.points) || !init.points.length) throw new LayerOperationError('points must hold at least one { x, y } point.');
    for (const p of init.points) {
      if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) throw new LayerOperationError('Every point needs finite x and y (document pixels).');
    }
    const session = this.beginStroke(init);
    session.push(init.points);
    return session.end();
  }

  /**
   * Edit › Fill: fills the selection (or, without one or with `useSelection: false`, the whole
   * canvas) on a layer's pixels or mask with a colour (default the foreground), at `opacity` with
   * `blend`. One undo step. Returns the changed bounds.
   */
  public fillPixels(options: FillOptions = {}): PaintStrokeResult {
    return this.fillOrClear(options, 'paint');
  }

  /**
   * Edit › Clear: removes the selected pixels (alpha to 0; on a transparency-locked layer or a mask
   * it fills with the background colour). Without a selection (or with `useSelection: false`) the
   * whole canvas. One undo step. Returns the changed bounds.
   */
  public clearPixels(options: Omit<FillOptions, 'color' | 'blend'> = {}): PaintStrokeResult {
    return this.fillOrClear(options, 'erase');
  }

  private fillOrClear(options: FillOptions, mode: 'paint' | 'erase'): PaintStrokeResult {
    const target = this.paintTarget(options.layerId, options.channel, mode === 'paint' ? 'fill' : 'clear');
    const { width, height } = this.naturalSize;
    const opacity = options.opacity ?? 1;
    if (!(opacity >= 0 && opacity <= 1)) throw new LayerOperationError('opacity must be from 0 to 1.');
    const blend = (parseBlend(options.blend) as BlendMode | undefined) ?? 'normal';
    const sel = options.useSelection !== false && this.state.selection?.bounds ? this.state.selection : null;
    const region = sel?.bounds ?? { x: 0, y: 0, width, height };
    const coverage = new CoverageMap();
    const ones = new Float32Array(region.width * region.height);
    if (sel) {
      for (let y = 0; y < region.height; y++) {
        for (let x = 0; x < region.width; x++) ones[y * region.width + x] = sel.data[(region.y + y) * sel.width + region.x + x] / 255;
      }
    } else ones.fill(1);
    coverage.accumulate(region, ones, 1);
    const color = parseColor(options.color ?? this.state.paint.foreground);
    const background = parseColor(this.state.paint.background);
    const grey = (c: [number, number, number, number]) => {
      const g = Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
      return [g, g, g, 255] as [number, number, number, number];
    };
    const apply: StrokeApply = {
      mode,
      color: target.channel !== 'pixels' ? grey(color) : color,
      background: target.channel !== 'pixels' ? grey(background) : background,
      opacity,
      blend: target.channel !== 'pixels' ? 'normal' : blend,
      lockTransparency: target.lockTransparency,
      selection: null,
      offset: target.offset,
    };
    const depth = target.channel !== 'filter-mask' && this.bitDepth !== 8 ? this.bitDepth : null;
    const surface = paintCoverageInto(target.surface, coverage, apply, [region], depth);
    const next = mapLayer(this.state.layers, target.id, (l) => this.withSurface(l, target.channel, surface));
    this.commitLayers(next);
    return { layerId: target.id, channel: target.channel, bounds: region, dabs: 0 };
  }

  // --- Adjustments ---

  /** The pixel layer the base sliders edit: the active pixel layer, else the Background. */
  private developLayer(): PixelLayer | null {
    return developTarget(this.state.layers, this.state.activeLayerId);
  }

  /**
   * Sets base adjustment values as one undo step (unless `commitToHistory` is false). The base
   * sliders edit the `develop` filter of the active pixel layer (or the Background), `blur` its
   * blur filter (or `legacyOutputBlur` in migrated documents), `opacity` the output opacity, and
   * `layers` replaces the adjustment layers.
   */
  public setAdjustments(partial: Partial<ImageAdjustments>, commitToHistory = true): void {
    if (commitToHistory) {
      this.recordHistory();
    }
    const target = this.developLayer();
    let layers = this.state.layers;
    if (target && (DEVELOP_KEYS.some((k) => k in partial) || 'process' in partial)) {
      layers = mapLayer(layers, target.id, (l) => withDevelop(l as PixelLayer, partial));
    }
    if ('blur' in partial && typeof partial.blur === 'number') {
      const blur = Math.max(0, partial.blur);
      if (this.state.legacyOutputBlur !== undefined) this.state.legacyOutputBlur = blur;
      else if (target) layers = mapLayer(layers, target.id, (l) => withBlur(l as PixelLayer, blur));
    }
    if ('opacity' in partial && typeof partial.opacity === 'number') {
      this.state.outputOpacity = Math.min(1, Math.max(0, partial.opacity));
    }
    if ('layers' in partial) {
      layers = this.replaceAdjustmentNodes(layers, normalizeAdjustmentLayers(partial.layers));
    }
    this.state.layers = layers;
    this.notify();
  }

  /** True when the adjustments use an older rendering process than {@link LATEST_PROCESS_VERSION}. */
  public get isProcessOutdated(): boolean {
    this.syncViews();
    return normalizeProcessVersion(this.state.adjustments.process) < LATEST_PROCESS_VERSION;
  }

  /**
   * Update to Current Process: re-interprets the current adjustment values with the latest
   * rendering process (one undo step). Returns false when already current.
   */
  public upgradeProcess(): boolean {
    if (!this.isProcessOutdated) return false;
    this.setAdjustments({ process: LATEST_PROCESS_VERSION });
    return true;
  }

  /** Resets the base sliders (latest process). Adjustment layers are kept; see `clearAdjustmentLayers`. */
  public resetAdjustments(): void {
    this.recordHistory();
    const target = this.developLayer();
    if (target) {
      this.state.layers = mapLayer(this.state.layers, target.id, (l) =>
        withBlur(withDevelop(l as PixelLayer, { ...DEFAULT_ADJUSTMENTS, process: LATEST_PROCESS_VERSION }), 0)
      );
    }
    delete this.state.legacyOutputBlur;
    this.state.outputOpacity = 1;
    this.notify();
  }

  // --- Adjustment layers ---

  /** The adjustment layers in stack order, bottom (first) to top (last). */
  public getAdjustmentLayers(): AdjustmentLayer[] {
    this.syncViews();
    return this.state.adjustments.layers ?? [];
  }

  public getAdjustmentLayer(id: string): AdjustmentLayer | undefined {
    return this.getAdjustmentLayers().find((l) => l.id === id);
  }

  private adjustmentNodes(layers: readonly ImageLayer[] = this.state.layers): AdjustmentLayerNode[] {
    return flattenLayers(layers).filter((l): l is AdjustmentLayerNode => l.type === 'adjustment');
  }

  /**
   * Where a new layer goes when no position is given: directly above the topmost layer that is
   * not an annotation, so it adjusts what adjustment layers always adjusted (annotations stay on top).
   */
  private defaultInsertIndex(layers: readonly ImageLayer[] = this.state.layers): number {
    let i = layers.length;
    while (i > 0 && layers[i - 1].type === 'annotation') i--;
    return i;
  }

  /** Inserts `node` by `aboveId` / `parentId` / adjustment index / default position. */
  private placeLayer(
    layers: ImageLayer[],
    node: ImageLayer,
    where: { aboveId?: string; parentId?: string; adjustmentIndex?: number }
  ): ImageLayer[] {
    if (where.aboveId) {
      const loc = findLayer(layers, where.aboveId);
      if (loc) return insertLayer(layers, node, loc.parent?.id ?? null, loc.index + 1);
    }
    if (where.parentId) {
      const loc = findLayer(layers, where.parentId);
      if (loc && loc.layer.type === 'group') return insertLayer(layers, node, loc.layer.id);
    }
    if (where.adjustmentIndex !== undefined) {
      const nodes = this.adjustmentNodes(layers);
      const at = Math.max(0, Math.min(nodes.length, Math.round(where.adjustmentIndex)));
      if (at < nodes.length) {
        const loc = findLayer(layers, nodes[at].id)!;
        return insertLayer(layers, node, loc.parent?.id ?? null, loc.index);
      }
      if (nodes.length) {
        const loc = findLayer(layers, nodes[nodes.length - 1].id)!;
        return insertLayer(layers, node, loc.parent?.id ?? null, loc.index + 1);
      }
    }
    return insertLayer(layers, node, null, this.defaultInsertIndex(layers));
  }

  /** `setAdjustments({ layers })`: updates nodes by id in place, removes missing ones, adds new ones. */
  private replaceAdjustmentNodes(layers: ImageLayer[], next: AdjustmentLayer[]): ImageLayer[] {
    const { width, height } = this.naturalSize;
    const byId = new Map(next.map((l) => [l.id, l]));
    let out = layers;
    for (const node of this.adjustmentNodes(layers)) {
      const update = byId.get(node.id);
      out = mapLayer(out, node.id, () => (update ? mergeAdjustmentNode(node, update, width, height) : null));
    }
    const existing = new Set(this.adjustmentNodes(out).map((n) => n.id));
    for (const l of next) {
      if (existing.has(l.id)) continue;
      out = this.placeLayer(out, adjustmentNodeFromLegacy(l, width, height), { adjustmentIndex: Infinity });
    }
    // Keep the given order among the adjustment layers.
    const order = next.map((l) => l.id);
    for (let to = 0; to < order.length; to++) out = this.moveAdjustmentNode(out, order[to], to);
    return out;
  }

  /**
   * Adds an adjustment layer and returns its id, as one undo step. With no position it goes
   * above the other adjustment layers (or, without any, above the topmost non-annotation layer,
   * so annotations stay on top); `index` counts adjustment layers (0 = below the others);
   * `aboveId` / `parentId` place it anywhere in the stack. `kind` alone gives neutral parameters.
   */
  public addAdjustmentLayer<K extends AdjustmentKind>(init: K | AdjustmentLayerInit<K>, index?: number): string {
    const spec: AdjustmentLayerInit<K> = typeof init === 'string' ? { kind: init } : init;
    const ids = new Set(flattenLayers(this.state.layers).map((l) => l.id));
    const layer = createAdjustmentLayer(spec.kind, {
      id: spec.id && !ids.has(spec.id) ? spec.id : undefined,
      name: spec.name,
      params: spec.params,
      enabled: spec.enabled,
      opacity: spec.opacity,
      blend: spec.blend,
      mask: spec.mask ?? undefined,
    });
    while (ids.has(layer.id)) layer.id = newLayerId('adj');
    const { width, height } = this.naturalSize;
    this.recordHistory();
    const node = adjustmentNodeFromLegacy(layer, width, height);
    const positioned = Boolean(spec.aboveId || spec.parentId);
    this.state.layers = this.placeLayer(this.state.layers, node, {
      aboveId: spec.aboveId,
      parentId: spec.parentId,
      adjustmentIndex: index !== undefined ? index : positioned ? undefined : Infinity,
    });
    this.notify();
    return layer.id;
  }

  /**
   * Updates a layer (`params` merged into the current ones, then normalised). Pass
   * `commitToHistory = false` for the moves of a drag after recording its start once.
   * Returns false for an unknown id.
   */
  public updateAdjustmentLayer(id: string, update: AdjustmentLayerUpdate, commitToHistory = true): boolean {
    const loc = findLayer(this.state.layers, id);
    if (!loc || loc.layer.type !== 'adjustment') return false;
    const { width, height } = this.naturalSize;
    const node = loc.layer;
    const merged = normalizeAdjustmentLayer({
      id: node.id,
      kind: node.kind,
      enabled: update.enabled ?? node.visible,
      opacity: update.opacity ?? node.opacity,
      blend: update.blend ?? node.blend,
      name: update.name ?? node.name,
      params: { ...node.params, ...(update.params ?? {}) },
    });
    if (!merged) return false;
    if (commitToHistory) this.recordHistory();
    const next = {
      ...node,
      visible: merged.enabled,
      opacity: merged.opacity,
      blend: merged.blend,
      name: merged.name ?? '',
      params: merged.params,
    } as AdjustmentLayerNode;
    if (update.mask !== undefined) {
      const mask = update.mask ? rasterMaskFromLegacy(update.mask, width, height) : null;
      if (mask) next.mask = mask;
      else delete next.mask;
    }
    this.state.layers = mapLayer(this.state.layers, id, () => next);
    this.notify();
    return true;
  }

  /** Removes a layer as one undo step. Returns false for an unknown id. */
  public removeAdjustmentLayer(id: string): boolean {
    const loc = findLayer(this.state.layers, id);
    if (!loc || loc.layer.type !== 'adjustment') return false;
    this.recordHistory();
    this.state.layers = mapLayer(this.state.layers, id, () => null);
    if (this.state.activeLayerId === id) this.state.activeLayerId = null;
    this.notify();
    return true;
  }

  private moveAdjustmentNode(layers: ImageLayer[], id: string, toIndex: number): ImageLayer[] {
    const nodes = this.adjustmentNodes(layers);
    const from = nodes.findIndex((n) => n.id === id);
    if (from === -1) return layers;
    const to = Math.max(0, Math.min(nodes.length - 1, Math.round(toIndex)));
    if (to === from) return layers;
    const node = nodes[from];
    const anchor = nodes[to];
    const without = mapLayer(layers, id, () => null);
    const loc = findLayer(without, anchor.id)!;
    return insertLayer(without, node, loc.parent?.id ?? null, to > from ? loc.index + 1 : loc.index);
  }

  /** Moves a layer to `toIndex` among the adjustment layers (0 = bottom) as one undo step. Returns false if nothing moved. */
  public moveAdjustmentLayer(id: string, toIndex: number): boolean {
    const next = this.moveAdjustmentNode(this.state.layers, id, toIndex);
    if (next === this.state.layers) return false;
    this.recordHistory();
    this.state.layers = next;
    this.notify();
    return true;
  }

  /** Shows or hides a layer (flips it without `enabled`) as one undo step. */
  public toggleAdjustmentLayer(id: string, enabled?: boolean): boolean {
    const layer = this.getAdjustmentLayer(id);
    if (!layer) return false;
    const next = enabled ?? !layer.enabled;
    if (next === layer.enabled) return false;
    return this.updateAdjustmentLayer(id, { enabled: next });
  }

  /** Removes every adjustment layer as one undo step. */
  public clearAdjustmentLayers(): void {
    const nodes = this.adjustmentNodes();
    if (!nodes.length) return;
    this.recordHistory();
    let layers = this.state.layers;
    for (const n of nodes) layers = mapLayer(layers, n.id, () => null);
    this.state.layers = layers;
    if (nodes.some((n) => n.id === this.state.activeLayerId)) this.state.activeLayerId = null;
    this.notify();
  }

  // --- Selection ---

  /** The active selection, or `null`. */
  public getSelection(): SelectionMask | null {
    return this.state.selection ?? null;
  }

  public get hasSelection(): boolean {
    return Boolean(this.state.selection?.bounds);
  }

  private get naturalSize(): { width: number; height: number } {
    return {
      width: Math.max(1, Math.round(this.state.imageDimensions.width)),
      height: Math.max(1, Math.round(this.state.imageDimensions.height)),
    };
  }

  private dropMismatchedSelection(): void {
    const sel = this.state.selection;
    if (!sel) return;
    const { width, height } = this.naturalSize;
    if (sel.width !== width || sel.height !== height) this.state.selection = null;
  }

  /**
   * Replaces the selection, or combines `mask` with it by `mode`, as one undo step. A mask of a
   * different size (e.g. an AI segmentation at another resolution) is resampled to the image.
   * Returns false when nothing changed.
   */
  public setSelection(mask: SelectionMask | null, mode: SelectionMode = 'replace'): boolean {
    const { width, height } = this.naturalSize;
    let next: SelectionMask | null = null;
    if (mask) {
      const sized = mask.width === width && mask.height === height ? mask : resizeSelection(mask, width, height);
      next = combineSelections(this.state.selection, sized, mode);
    } else if (mode !== 'replace') {
      return false;
    }
    const prev = normalizeSelection(this.state.selection ?? null);
    if (prev === next || (prev && next && sameSelection(prev, next))) return false;
    this.recordHistory();
    this.state.selection = next;
    this.notify();
    return true;
  }

  /** Select › All. */
  public selectAll(): boolean {
    const { width, height } = this.naturalSize;
    return this.setSelection(fullSelection(width, height));
  }

  /** Select › Deselect. */
  public deselect(): boolean {
    return this.setSelection(null);
  }

  /** Select › Inverse (with nothing selected, selects everything). */
  public invertSelection(): boolean {
    const { width, height } = this.naturalSize;
    const current = this.state.selection ?? createSelectionMask(width, height);
    return this.setSelection(invertSelectionMask(current));
  }

  private shapeCommand(mask: SelectionMask, options: SelectionCommandOptions): boolean {
    const shaped = options.feather && options.feather > 0 ? modifySelectionMask(mask, 'feather', options.feather) : mask;
    return this.setSelection(shaped, options.mode ?? 'replace');
  }

  /** Rectangular marquee in natural image pixels. */
  public selectRect(rect: CropBox, options: SelectionCommandOptions & ShapeSelectionOptions = {}): boolean {
    const { width, height } = this.naturalSize;
    return this.shapeCommand(rectSelection(width, height, rect, options), options);
  }

  /** Elliptical marquee inscribed in `rect`. */
  public selectEllipse(rect: CropBox, options: SelectionCommandOptions & ShapeSelectionOptions = {}): boolean {
    const { width, height } = this.naturalSize;
    return this.shapeCommand(ellipseSelection(width, height, rect, options), options);
  }

  /** Lasso / polygonal lasso. */
  public selectPolygon(points: ImagePoint[], options: SelectionCommandOptions & ShapeSelectionOptions = {}): boolean {
    const { width, height } = this.naturalSize;
    return this.shapeCommand(polygonSelection(width, height, points, options), options);
  }

  /**
   * Supplies the pixels the selection tools sample (natural size RGBA), e.g. decoded in a worker
   * or in a test; `null` goes back to reading the source image. Without a canvas (Node, workers)
   * these are also the Background layer's pixels.
   */
  public setSamplePixels(pixels: PixelBuffer | null): void {
    this.samplePixels = pixels;
    this.samplePixelsOverride = pixels !== null;
  }

  /**
   * The pixels the selection tools sample: the source image at natural size, or with
   * `sampleMerged` the composite of the layers (no crop, rotation or annotations). `null`
   * without pixel access (no DOM, tainted canvas).
   */
  public async getSamplePixels(options: SampleOptions = {}): Promise<PixelBuffer | null> {
    const { width, height } = this.naturalSize;
    let base = options.pixels ?? this.samplePixels;
    if (!base) {
      try {
        const canvas = await this.renderSource();
        const ctx = canvas.getContext('2d');
        const data = ctx?.getImageData?.(0, 0, width, height);
        if (data && data.data && data.data.length >= width * height * 4) {
          base = { width, height, data: data.data };
          this.samplePixels = base;
          this.samplePixelsOverride = false;
        }
      } catch {
        base = null;
      }
    }
    if (!base) return null;
    if (base.width !== width || base.height !== height) {
      if (!this.samplePixelsOverride && !options.pixels) this.samplePixels = null;
      return null;
    }
    const legacy = legacyView(this.stack(), width, height, null).exact;
    if (options.sample === 'active-layer') {
      const layer = this.getActiveLayer();
      if (!layer || layer.type !== 'pixel') {
        throw new LayerOperationError('Sampling the active layer needs an active pixel layer; select one, or sample the composite.');
      }
      const surface = layer.source === 'document' && options.pixels ? surfaceFromPixels(options.pixels, 4) : this.surfaceOf(layer);
      return { width, height, data: readRegion(surface, { x: -layer.offset.x, y: -layer.offset.y, width, height }) };
    }
    if (legacy && !options.sampleMerged) return base;
    this.syncViews();
    if (legacy && !options.pixels) {
      // The old shape: the source through the base adjustments and adjustment layers.
      const copy = { width: base.width, height: base.height, data: new Uint8ClampedArray(base.data as ArrayLike<number>) };
      applyAdjustments(copy as unknown as ImageData, legacyView(this.stack(), width, height, null).adjustments);
      return copy;
    }
    const pixels = options.pixels;
    const sources: CompositorSources = {
      width,
      height,
      surfaceOf: (l) => (l.type === 'pixel' && l.source === 'document' && pixels ? surfaceFromPixels(pixels, 4) : this.surfaceOf(l)),
      version: pixels ? 'pixels' : this.sourceVersion(),
    };
    // Without `sampleMerged`, the pixels as painted: adjustment layers and filters left out.
    const stack = withoutAnnotations(this.state.layers);
    const layers = options.sampleMerged ? stack : pixelsOnly(stack);
    const data = new LayerCompositor().composite(layers, { x: 0, y: 0, width, height }, sources);
    return { width, height, data };
  }

  private async requirePixels(options: SampleOptions): Promise<PixelBuffer> {
    const pixels = await this.getSamplePixels(options);
    if (!pixels) throw new Error('The image pixels are not available (no canvas access); pass `pixels`.');
    return pixels;
  }

  /**
   * Magic wand at `point` (natural image pixels). Resolves to the resulting selection (null when
   * nothing is selected).
   */
  public async magicWand(
    point: ImagePoint,
    options: MagicWandOptions & SelectionCommandOptions & SampleOptions = {}
  ): Promise<SelectionMask | null> {
    const pixels = await this.requirePixels(options);
    this.shapeCommand(magicWand(pixels, point, options), options);
    return this.getSelection();
  }

  /** Select › Color Range with colour samples (`#rrggbb` or `[r, g, b]`, optionally where they were picked). */
  public async selectColorRange(
    samples: ColorRangeSample[],
    options: ColorRangeOptions & SelectionCommandOptions & SampleOptions = {}
  ): Promise<SelectionMask | null> {
    const pixels = await this.requirePixels(options);
    this.shapeCommand(colorRange(pixels, samples, options), options);
    return this.getSelection();
  }

  /** Select › Modify: grow, shrink, feather, border or smooth by `radius` pixels (one undo step). */
  public modifySelection(op: SelectionModifyOp, radius: number): boolean {
    const sel = this.state.selection;
    if (!sel?.bounds) return false;
    return this.setSelection(modifySelectionMask(sel, op, radius));
  }

  /**
   * Refine Edge: snaps the selection (e.g. a coarse AI mask loaded with `loadSelectionFromImage`)
   * to the image's edges with a guided filter, then smooth / feather / contrast / shift edge.
   */
  public async refineSelection(params: RefineEdgeParams, options: SampleOptions = {}): Promise<boolean> {
    const sel = this.state.selection;
    if (!sel?.bounds) return false;
    const pixels = (params.radius ?? 0) > 0 ? await this.requirePixels(options) : null;
    return this.setSelection(refineSelectionMask(pixels, sel, params));
  }

  /**
   * Loads a selection from a mask image (an AI segmentation, a saved mask): a data URL / URL or
   * RGBA pixels, by luminance (white = selected) or a channel. Any size; it is resampled.
   */
  public async loadSelectionFromImage(
    source: string | PixelBuffer,
    options: { channel?: SelectionChannel; invert?: boolean; threshold?: number; mode?: SelectionMode } = {}
  ): Promise<SelectionMask | null> {
    let pixels: PixelBuffer;
    if (typeof source === 'string') {
      const img = await this.renderer.imageCache.get(source);
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const canvas = this.renderer.createCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(img, 0, 0, w, h);
      const data = ctx?.getImageData?.(0, 0, w, h);
      if (!data) throw new Error('The mask image pixels are not available (no canvas access); pass pixels.');
      pixels = { width: w, height: h, data: data.data };
    } else {
      pixels = source;
    }
    this.setSelection(selectionFromPixels(pixels, options), options.mode ?? 'replace');
    return this.getSelection();
  }

  /** Quick Mask view (tints the unselected area). View state: no undo step. */
  public setQuickMask(on: boolean): void {
    if (Boolean(this.state.quickMask) === on) return;
    this.state.quickMask = on;
    this.notify();
  }

  // --- Layer masks ---

  private maskFromSelection(sel: SelectionMask, props: LayerMaskProps = {}): RasterMask {
    const { width, height } = this.naturalSize;
    const sized = sel.width === width && sel.height === height ? sel : resizeSelection(sel, width, height);
    const mask: RasterMask = { surface: surfaceFromPixels({ width, height, data: sized.data }, 1, 0, 0, 0), defaultValue: 0 };
    return withMaskProps(mask, props);
  }

  /**
   * Adds the selection as the layer's mask (Reveal Selection), replacing any mask, as one undo
   * step. Without a selection, returns false.
   */
  public applySelectionAsLayerMask(layerId: string, props: LayerMaskProps = {}): boolean {
    const sel = this.state.selection;
    if (!sel?.bounds || !this.getAdjustmentLayer(layerId)) return false;
    return this.setLayerMask(layerId, this.maskFromSelection(sel, props));
  }

  private setLayerMask(layerId: string, mask: RasterMask | null, commitToHistory = true): boolean {
    const loc = findLayer(this.state.layers, layerId);
    if (!loc) return false;
    if (commitToHistory) this.recordHistory();
    this.state.layers = mapLayer(this.state.layers, layerId, (l) => {
      const next = { ...l } as ImageLayer;
      if (mask) next.mask = mask;
      else delete next.mask;
      return next;
    });
    if (!mask && this.state.activeLayerId === layerId) this.state.activeTarget = 'pixels';
    this.notify();
    return true;
  }

  /** Sets (from a selection-shaped mask) or removes (`null`) a layer's mask as one undo step. */
  public setAdjustmentLayerMask(layerId: string, mask: SelectionMask | null, props: LayerMaskProps = {}): boolean {
    if (!this.getAdjustmentLayer(layerId)) return false;
    return this.setLayerMask(layerId, mask ? this.maskFromSelection(mask, props) : null);
  }

  /** Changes a layer mask's density (0..1), feather (px) or enabled flag; the mask pixels are kept. */
  public setAdjustmentLayerMaskProps(layerId: string, props: LayerMaskProps, commitToHistory = true): boolean {
    const layer = this.getLayer(layerId);
    if (!layer || layer.type !== 'adjustment' || !layer.mask) return false;
    return this.setLayerMask(layerId, withMaskProps(layer.mask, props), commitToHistory);
  }

  /** Load Selection from a layer mask (its pixels; density and feather are not applied). */
  public selectionFromLayerMask(layerId: string, mode: SelectionMode = 'replace'): boolean {
    const layer = this.getLayer(layerId);
    if (!layer?.mask || layer.mask.source) return false;
    const { width, height } = this.naturalSize;
    const ox = layer.type === 'pixel' ? layer.offset.x : 0;
    const oy = layer.type === 'pixel' ? layer.offset.y : 0;
    const data = readRegion(layer.mask.surface, { x: -ox, y: -oy, width, height });
    const sel = createSelectionMask(width, height, new Uint8Array(data.buffer, data.byteOffset, data.length));
    return this.setSelection(sel, mode);
  }

  // --- Histogram ---

  /**
   * Histogram of the last rendered preview (after adjustments and layers, before annotations),
   * or `null` before the first render or without canvas pixel access.
   */
  public getHistogram(): ImageHistogram | null {
    return this.renderer.previewHistogram;
  }

  /** Calls `listener` now and whenever a render produces a new preview histogram. */
  public subscribeHistogram(listener: (histogram: ImageHistogram | null) => void): () => void {
    this.histogramListeners.add(listener);
    listener(this.renderer.previewHistogram);
    return () => {
      this.histogramListeners.delete(listener);
    };
  }

  // --- Depth Masking (Gleamforge) ---

  /** Sets the depth mask (a parametric mask on the active pixel layer, or the Background) as one undo step. */
  public setDepthMask(partial: Partial<DepthMaskOptions>): void {
    this.recordHistory();
    this.syncViews();
    const target = this.developLayer();
    if (target) {
      const merged: DepthMaskOptions = { ...this.state.depthMask, ...partial };
      merged.depthRange = [...merged.depthRange] as [number, number];
      this.state.layers = mapLayer(this.state.layers, target.id, (l) => {
        const next = { ...l } as PixelLayer;
        if (isDefaultDepthMask(merged)) {
          if (next.mask?.source) delete next.mask;
        } else next.mask = depthRasterMask(merged);
        return next;
      });
    }
    this.notify();
  }

  public resetDepthMask(): void {
    this.recordHistory();
    const target = this.developLayer();
    if (target?.mask?.source) {
      this.state.layers = mapLayer(this.state.layers, target.id, (l) => {
        const next = { ...l } as PixelLayer;
        delete next.mask;
        return next;
      });
    }
    this.notify();
  }

  // --- Annotations & Layers ---

  /** The layer showing annotation `id`: an annotation layer, or a shape layer migrated from it. */
  private annotationLayer(id: string): AnnotationLayer | ShapeLayer | TypeLayer | undefined {
    return flattenLayers(this.state.layers).find((l): l is AnnotationLayer | ShapeLayer | TypeLayer => (l.type === 'annotation' || l.type === 'shape' || l.type === 'type') && annotationOfLayer(l)?.id === id);
  }

  /** What migrating an annotation needs: the canvas size, patterns and the text shaper. */
  private annotationEnv(): ShapeEnv & TextEnv {
    return { ...this.shapeEnv(), ...this.textEnv() };
  }

  /**
   * Adds an annotation as its own layer (top of the stack unless `aboveId` is given). Pen,
   * rectangle, ellipse, line and arrow annotations become shape layers that remember the
   * annotation (so `annotations` and `updateAnnotation` keep working); text and images stay
   * annotation layers.
   */
  public addAnnotation(annotation: CreateAnnotationPayload, placement: AnnotationPlacement = {}): string {
    this.recordHistory();
    const id = `ann_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const fullAnnotation = { ...annotation, id } as Annotation;
    const layer = annotationLayerFor(fullAnnotation, this.annotationEnv());
    const loc = placement.aboveId ? findLayer(this.state.layers, placement.aboveId) : null;
    this.state.layers = loc
      ? insertLayer(this.state.layers, layer, loc.parent?.id ?? null, loc.index + 1)
      : insertLayer(this.state.layers, layer, null);
    this.state.selectedAnnotationId = id;
    this.notify();
    return id;
  }

  public updateAnnotation(id: string, partial: Partial<Annotation>, commitToHistory = true): void {
    if (commitToHistory) {
      this.recordHistory();
    }
    const layer = this.annotationLayer(id);
    const current = layer ? annotationOfLayer(layer) : null;
    if (layer && current) {
      const annotation = { ...current, ...partial, id } as Annotation;
      const name = layer.name === annotationLayerName(current) ? annotationLayerName(annotation) : layer.name;
      this.state.layers = mapLayer(this.state.layers, layer.id, () => this.layerForAnnotation(layer, annotation, name));
    }
    this.notify();
  }

  /** `layer` (an annotation, or a shape or type layer migrated from one) showing `annotation` instead, keeping its other properties. */
  private layerForAnnotation(layer: AnnotationLayer | ShapeLayer | TypeLayer, annotation: Annotation, name: string): ImageLayer {
    const fresh = annotationLayerFor(annotation, this.annotationEnv());
    const keep: Partial<ImageLayer> = { id: layer.id, visible: layer.visible, opacity: layer.opacity };
    for (const k of ['clipped', 'mask', 'locks', 'effects'] as const) if (layer[k] !== undefined) (keep as Record<string, unknown>)[k] = layer[k];
    if (fresh.type !== 'annotation' && layer.type !== 'annotation' && layer.fillOpacity !== undefined) (keep as { fillOpacity?: number }).fillOpacity = layer.fillOpacity;
    // An annotation layer's own blend (set on the layer) wins over the annotation's.
    const blend = fresh.type === 'annotation' ? (layer.type === 'annotation' ? layer.blend : 'normal') : layer.type === 'annotation' && layer.blend !== 'normal' ? layer.blend : fresh.blend;
    return { ...fresh, ...keep, name, blend } as ImageLayer;
  }

  public removeAnnotation(id: string): void {
    this.recordHistory();
    const layer = this.annotationLayer(id);
    if (layer) this.state.layers = mapLayer(this.state.layers, layer.id, () => null);
    if (this.state.selectedAnnotationId === id) {
      this.state.selectedAnnotationId = null;
    }
    this.notify();
  }

  /** Deletes every annotation layer and every shape layer that still is the annotation it was migrated from. */
  public clearAnnotations(): void {
    this.recordHistory();
    let layers = this.state.layers;
    for (const l of flattenLayers(layers)) if (l.type === 'annotation' || ((l.type === 'shape' || l.type === 'type') && l.annotation)) layers = mapLayer(layers, l.id, () => null);
    this.state.layers = layers;
    this.state.selectedAnnotationId = null;
    this.notify();
  }

  public selectAnnotation(id: string | null): void {
    this.state.selectedAnnotationId = id;
    this.notify();
  }

  // --- Zoom & Pan ---

  public setZoom(zoom: number): void {
    this.state.zoom = Math.max(0.1, Math.min(10, zoom));
    this.notify();
  }

  public zoomIn(factor = 1.2): void {
    this.setZoom(this.state.zoom * factor);
  }

  public zoomOut(factor = 1.2): void {
    this.setZoom(this.state.zoom / factor);
  }

  public resetZoom(): void {
    this.state.zoom = 1;
    this.state.pan = { x: 0, y: 0 };
    this.notify();
  }

  public setPan(pan: ImagePoint): void {
    this.state.pan = pan;
    this.notify();
  }

  public setComparing(comparing: boolean): void {
    if (this.state.isOriginalCompared === comparing) return;
    this.state.isOriginalCompared = comparing;
    this.notify();
  }

  public setFit(fit: ImageEditorFit): void {
    if (this.state.fit === fit) return;
    this.state.fit = fit;
    this.notify();
  }

  // --- Rendering & Export ---

  private blankSource: HTMLCanvasElement | null = null;

  /**
   * What the renderer draws from: the source image, or, for a document without one (an opened
   * PSD, a v3 document loaded on its own), a transparent canvas of the document size, since every
   * pixel then comes from the layers. `null` when there is nothing to draw.
   */
  private drawSource(): CanvasImageSource | string | null {
    const source = this.imageElement || this.state.sourceUrl;
    if (source) return source;
    if (!this.isSourceless()) return null;
    const { width, height } = this.naturalSize;
    if (!this.blankSource || this.blankSource.width !== width || this.blankSource.height !== height) {
      this.blankSource = this.renderer.createCanvas(width, height);
    }
    return this.blankSource;
  }

  /**
   * Where the Clone Stamp or Healing Brush samples for a brush at `cursor` (document pixels), or
   * `null` when neither tool is active or no source is set: the cursor plus the aligned offset
   * once a stroke has fixed it, else the source point itself (where the next stroke starts
   * sampling). The editors draw it as the clone source marker.
   */
  public cloneSourceMarker(cursor: { x: number; y: number } | null = null): { x: number; y: number } | null {
    const s = this.state;
    if (s.activeTool !== 'clone' && s.activeTool !== 'heal') return null;
    const cs = s.paint.cloneSource;
    if (!cs) return null;
    if (cursor && cs.offset && s.paint.retouch.aligned) {
      const [x, y] = cloneSamplePoint(s.paint.cloneTransform, cs, { x: cs.x - cs.offset.x, y: cs.y - cs.offset.y }, cursor.x, cursor.y);
      return { x, y };
    }
    return { x: cs.x, y: cs.y };
  }

  public async render(targetCanvas: HTMLCanvasElement, options?: RenderOptions): Promise<void> {
    const source = this.drawSource();
    if (!source) return;
    this.syncViews();
    const dirty = this.pendingDirty;
    this.pendingDirty = [];
    try {
      await this.renderer.renderToCanvas(targetCanvas, source, this.state, {
        ...options,
        // The clone source follows the brush cursor (both editors pass it).
        cloneSourceMarker: options?.cloneSourceMarker !== undefined ? options.cloneSourceMarker : options?.brushCursor ? this.cloneSourceMarker(options.brushCursor) : null,
        dirty: dirty === 'all' ? undefined : dirty,
        checkpointLayerId: this.state.activeLayerId,
      });
    } catch {
      // In non-DOM or test mock environments without image loading, safely ignore
    }
  }

  public async renderExport(options?: ExportOptions): Promise<HTMLCanvasElement> {
    const source = this.drawSource();
    if (!source) {
      return this.renderer.createCanvas(1, 1);
    }
    this.syncViews();
    if (options?.layerIds) {
      const keep = new Set(options.layerIds);
      const layers = flattenLayers(this.state.layers).filter((l) => keep.has(l.id));
      return this.renderer.renderExport(source, { ...this.state, layers }, options);
    }
    return this.renderer.renderExport(source, this.state, options);
  }

  /**
   * Renders the edited image (adjustments, layers and, by default, annotations) in the
   * source image's own orientation and frame, ignoring crop, rotation and flips, so it lines
   * up with natural-pixel coordinates (selections, `select_region`). `scale` ≤ 1 shrinks it.
   * Returns `null` when no image is loaded.
   */
  public async renderSourceView(options: { scale?: number; includeAnnotations?: boolean } = {}): Promise<HTMLCanvasElement | null> {
    const source = this.drawSource();
    if (!source) return null;
    this.syncViews();
    const { width, height } = this.state.imageDimensions;
    const k = Math.min(1, Math.max(0, options.scale ?? 1));
    return this.renderer.renderExport(
      source,
      { ...this.state, crop: null, transform: { rotate: 0, flipH: false, flipV: false } },
      {
        width: Math.max(1, Math.round(width * k)),
        height: Math.max(1, Math.round(height * k)),
        includeAnnotations: options.includeAnnotations,
      }
    );
  }

  public async toDataURL(options: ExportOptions = {}): Promise<string> {
    const canvas = await this.renderExport(options);
    const format = options.format || 'image/png';
    const quality = options.quality ?? 0.92;
    const url = canvas.toDataURL(format, quality);
    if (!this.state.colorProfile) return url;
    // A document in another colour space carries its profile in the file.
    const parsed = parseDataUrl(url);
    if (!parsed) return url;
    const bytes = this.withEmbeddedProfile(parsed.bytes, parsed.mime);
    return bytes === parsed.bytes ? url : `data:${parsed.mime};base64,${bytesToBase64(bytes)}`;
  }

  /** PNG or JPEG bytes with the document's ICC profile embedded (other formats unchanged). */
  private withEmbeddedProfile(bytes: Uint8Array, mime: string): Uint8Array {
    const icc = profileBytes(this.state.colorProfile);
    try {
      if (mime === 'image/png') return writePngIcc(bytes, icc, this.getColorProfile().name);
      if (mime === 'image/jpeg') return writeJpegIcc(bytes, icc);
    } catch {
      // Not the expected container (a mocked canvas): leave it.
    }
    return bytes;
  }

  public async toBlob(options: ExportOptions = {}): Promise<Blob> {
    const canvas = await this.renderExport(options);
    const format = options.format || 'image/png';
    const quality = options.quality ?? 0.92;

    const tag = async (blob: Blob): Promise<Blob> => {
      if (!this.state.colorProfile || typeof blob.arrayBuffer !== 'function') return blob;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const out = this.withEmbeddedProfile(bytes, blob.type || format);
      return out === bytes ? blob : new Blob([out as BlobPart], { type: blob.type || format });
    };
    return new Promise((resolve, reject) => {
      if (canvas.toBlob) {
        canvas.toBlob((blob) => {
          if (blob) tag(blob).then(resolve, reject);
          else reject(new Error('Failed to create Blob from canvas'));
        }, format, quality);
      } else {
        // Fallback for environments lacking canvas.toBlob
        try {
          const dataUrl = canvas.toDataURL(format, quality);
          const parts = dataUrl.split(',');
          const byteStr = atob(parts[1]);
          const ab = new ArrayBuffer(byteStr.length);
          const ia = new Uint8Array(ab);
          for (let i = 0; i < byteStr.length; i++) {
            ia[i] = byteStr.charCodeAt(i);
          }
          tag(new Blob([ab], { type: format })).then(resolve, reject);
        } catch (err) {
          reject(err);
        }
      }
    });
  }

  // --- AI Masking & Transformation Helpers ---

  public async renderMask(options?: { useAnnotations?: boolean; useCrop?: boolean; useSelection?: boolean }): Promise<HTMLCanvasElement> {
    this.syncViews();
    return this.renderer.renderMask(this.state, options);
  }

  public async toMaskDataURL(options?: { useAnnotations?: boolean; useCrop?: boolean; useSelection?: boolean }): Promise<string> {
    const canvas = await this.renderMask(options);
    return canvas.toDataURL('image/png');
  }

  /**
   * Renders the current source image at natural size with no crop, rotation, flip,
   * adjustments or annotations. This is the image that `toMaskDataURL()` is aligned with
   * and the space that `applyInpaintedImage` / `applyBackgroundRemovedImage` expect back.
   */
  public async renderSource(): Promise<HTMLCanvasElement> {
    const { width, height } = this.state.imageDimensions;
    const canvas = this.renderer.createCanvas(width, height);
    const source = this.imageElement || this.state.sourceUrl;
    const ctx = canvas.getContext('2d');
    if (!ctx || !source) return canvas;
    const img = typeof source === 'string' ? await this.renderer.imageCache.get(source) : source;
    ctx.drawImage(img, 0, 0, width, height);
    return canvas;
  }

  /**
   * The image an AI hook should edit: the source (`toSourceDataURL`) when results replace the
   * Background, or the composite of the layers without annotations, in the source frame, when
   * they go to a new layer or mask (see `applyInpaintedImage`).
   */
  public async toAIInputDataURL(options: AIResultOptions = {}): Promise<string> {
    const target = options.target ?? this.defaultAITarget();
    if (target === 'replace') return this.toSourceDataURL();
    const canvas = await this.renderSourceView({ includeAnnotations: false });
    return canvas ? canvas.toDataURL('image/png') : this.toSourceDataURL();
  }

  public async toSourceDataURL(options: Pick<ExportOptions, 'format' | 'quality'> = {}): Promise<string> {
    const canvas = await this.renderSource();
    return canvas.toDataURL(options.format || 'image/png', options.quality ?? 0.92);
  }

  /**
   * Whether AI results go to layers: the document has more than one pixel layer or group (adjustment
   * and annotation layers are edits of the image, not images of their own).
   */
  /** `new-layer` in multi-layer documents and documents without a source image, else `replace`. */
  private defaultAITarget(): 'new-layer' | 'replace' {
    return this.isMultiLayer || this.isSourceless() ? 'new-layer' : 'replace';
  }

  /** No source image, and no layer reading one (an opened PSD): the layers are the whole document. */
  private isSourceless(): boolean {
    if (this.imageElement || this.state.sourceUrl || !this.state.layers.length) return false;
    return !flattenLayers(this.state.layers).some((l) => l.type === 'pixel' && l.source === 'document');
  }

  public get isMultiLayer(): boolean {
    return flattenLayers(this.state.layers).filter((l) => l.type === 'pixel' || l.type === 'group').length > 1;
  }

  /**
   * Applies an inpainted result (natural image space, see `toSourceDataURL`) as ONE undoable step.
   * In a document with several layers (see `isMultiLayer`), or with `target: 'new-layer'`, the
   * result goes to a new pixel layer above the active layer, limited to the selection. Otherwise
   * (`target: 'replace'`, the single-layer default) it replaces the Background's pixels and clears
   * the mask annotations, as before. Resolves to the new layer's id in new-layer mode.
   */
  public async applyInpaintedImage(newDataUrl: string, options: AIResultOptions = {}): Promise<string | void> {
    if ((options.target ?? this.defaultAITarget()) === 'replace') {
      await this.replaceSource(newDataUrl, true);
      return;
    }
    const { width, height } = this.naturalSize;
    let px = await this.decodeImage(newDataUrl);
    if (px.width !== width || px.height !== height) px = resizePixels(px, width, height);
    const data = new Uint8ClampedArray(px.data as ArrayLike<number>);
    const sel = this.state.selection?.bounds ? this.state.selection : null;
    if (sel) for (let p = 0, i = 3; p < width * height; p++, i += 4) data[i] = Math.round((data[i] * sel.data[p]) / 255);
    return this.addPixelLayer({ name: 'Inpaint', pixels: { width, height, data } });
  }

  /**
   * Applies a background-removed result as ONE undoable step. In a document with several layers
   * (or with `target: 'new-layer'`) the result's alpha becomes the mask of the active pixel layer
   * (or the Background), replacing its mask. Otherwise (`target: 'replace'`, the single-layer
   * default) it replaces the Background's pixels; crop and annotations are kept (rescaled if the
   * new image has different dimensions). Resolves to the masked layer's id in mask mode.
   */
  public async applyBackgroundRemovedImage(newDataUrl: string, options: AIResultOptions = {}): Promise<string | void> {
    if ((options.target ?? this.defaultAITarget()) === 'replace') {
      await this.replaceSource(newDataUrl, false);
      return;
    }
    const target = this.developLayer();
    if (!target) throw new LayerOperationError('There is no pixel layer to mask.');
    requireUnlocked(target, 'all', 'mask it');
    const { width, height } = this.naturalSize;
    let px = await this.decodeImage(newDataUrl);
    if (px.width !== width || px.height !== height) px = resizePixels(px, width, height);
    const alpha = new Uint8ClampedArray(width * height);
    for (let p = 0; p < alpha.length; p++) alpha[p] = (px.data as ArrayLike<number>)[p * 4 + 3];
    let surface = surfaceFromPixels({ width, height, data: alpha }, 1, 0, 0, 0);
    if (target.offset.x || target.offset.y) surface = translateSurface(surface, -target.offset.x, -target.offset.y);
    this.commitLayers(setLayerMaskOp(this.state.layers, target.id, { surface, defaultValue: 0 }));
    return target.id;
  }

  // --- Type layers ---

  private textShaperValue: TextShaper | null | undefined;

  /** The shaper that lays out and draws type layers (`null` when there is none here). */
  public getTextShaper(): TextShaper | null {
    if (this.textShaperValue === undefined) this.textShaperValue = createCanvasTextShaper({ createCanvas: (w, h) => this.renderer.createCanvas(w, h) });
    return this.textShaperValue;
  }

  /** Sets the text shaper (fonts) type layers lay out and draw with; existing layers redraw on their next edit. */
  public setTextShaper(shaper: TextShaper | null): void {
    this.textShaperValue = shaper;
    this.notify();
  }

  /** What type layers lay out and draw with. */
  private textEnv(): TextEnv {
    return { ...this.naturalSize, shaper: this.getTextShaper(), createCanvas: (w, h) => this.renderer.createCanvas(w, h) };
  }

  /** Font families the shaper offers (generic families at least). */
  public listFonts(): string[] {
    return this.getTextShaper()?.families?.() ?? ['sans-serif', 'serif', 'monospace'];
  }

  private typeInfo(id: string): TypeLayerInfo {
    const layer = requireTypeLayer(this.state.layers, id);
    const ranges = <S>(runs: ReadonlyArray<{ length: number; style: S }>) => {
      let at = 0;
      return runs.map((r) => {
        const out = { start: at, end: at + r.length, style: JSON.parse(JSON.stringify(r.style)) as S };
        at += r.length;
        return out;
      });
    };
    const shaper = this.getTextShaper();
    let lines: TypeLayerInfo['lines'] = [];
    let missing = layer.missingFonts ?? [];
    if (shaper) {
      const layout = layoutText(layer, shaper);
      const r = (n: number) => Math.round(n * 1000) / 1000;
      lines = layout.lines.map((l) => ({ start: l.start, end: l.end, baseline: r(l.baseline), width: r(l.width) }));
      if (layer.rendering === 'stored') missing = layout.missingFonts;
    }
    const info: TypeLayerInfo = {
      id: layer.id,
      name: layer.name,
      text: layer.text,
      runs: ranges(layer.runs),
      paragraphs: ranges(layer.paragraphs),
      frame: { ...layer.frame },
      transform: [...(layer.transform ?? [1, 0, 0, 1, 0, 0])] as unknown as AffineMatrix,
      lines,
      bounds: this.getLayerBounds(id),
      missingFonts: [...missing],
      rendering: layer.rendering === 'stored' ? 'stored' : 'live',
    };
    if (layer.annotation) info.annotationId = layer.annotation.id;
    return info;
  }

  /** A type layer's text, runs, paragraphs, frame, lines and bounds. */
  public getTextLayer(id: string): TypeLayerInfo {
    return this.typeInfo(id);
  }

  /**
   * Adds a type layer (one undo step) and makes it active: point text at `x`, `y`, or paragraph
   * text wrapped in `box`. Refused without a text shaper. Returns its id.
   */
  public addTextLayer(init: TextLayerInit): string {
    const text = normalizeText(init.text);
    if (!Number.isFinite(init.x) || !Number.isFinite(init.y)) throw new LayerOperationError('x and y must be numbers (document pixels).');
    const style = patchTextStyle({ ...DEFAULT_TEXT_STYLE, color: this.state.paint.foreground }, (init.style ?? {}) as Record<string, unknown>);
    const paragraph = patchParagraphStyle({}, (init.paragraph ?? {}) as Record<string, unknown>);
    let frame: TypeLayer['frame'] = { kind: 'point' };
    if (init.box) {
      const { width, height } = init.box;
      if (!(Number.isFinite(width) && width >= 1 && Number.isFinite(height) && height >= 1)) throw new LayerOperationError('box.width and box.height must be at least 1 pixel.');
      frame = { kind: 'box', width, height };
    }
    if (init.rotation !== undefined && !Number.isFinite(init.rotation)) throw new LayerOperationError('rotation must be a number of degrees.');
    if (init.opacity !== undefined && !(Number.isFinite(init.opacity) && init.opacity >= 0 && init.opacity <= 1)) throw new LayerOperationError('opacity must be between 0 and 1.');
    if (init.blend !== undefined && !isBlendMode(init.blend)) throw new LayerOperationError(`Unknown blend mode "${String(init.blend)}".`);
    const t: AffineMatrix = [1, 0, 0, 1, init.x, init.y];
    const transform = init.rotation ? multiplyMatrices(t, rotateMatrix(init.rotation, { x: init.x, y: init.y })) : t;
    const layer = createTypeLayer({ text, runs: [{ length: text.length, style }], paragraphs: [{ length: text.length, style: paragraph }], frame, transform, name: init.name ?? typeLayerName(text) }, this.textEnv());
    if (init.opacity !== undefined) layer.opacity = init.opacity;
    if (init.blend !== undefined) layer.blend = init.blend;
    const next = placeLayer(this.state.layers, layer, this.newLayerPlacement(init));
    this.commitLayers(next, () => {
      this.state.activeLayerId = layer.id;
      this.state.activeTarget = 'pixels';
    });
    return layer.id;
  }

  /**
   * Replaces text [start, end) (default all of it) with `text`; inserted text takes the style at
   * `start`. One undo step unless `commitToHistory` is false (typing). Returns the layer.
   */
  public setText(id: string, text: string, range: { start?: number; end?: number } = {}, commitToHistory = true): TypeLayerInfo {
    const layer = requireTypeLayer(this.state.layers, id);
    const insert = normalizeText(text);
    const [start, end] = textRange(layer.text, range.start, range.end);
    const { layers } = updateTypeLayer(this.state.layers, id, (l) => replaceTextRange(l, start, end, insert), this.textEnv(), 'edit its text');
    this.commitLayers(layers, undefined, commitToHistory);
    return this.typeInfo(id);
  }

  /** Sets character style fields over [start, end) (default all), one undo step. Returns the layer. */
  public setTextStyle(id: string, style: Partial<TextStyle> & Record<string, unknown>, range: { start?: number; end?: number } = {}, commitToHistory = true): TypeLayerInfo {
    const layer = requireTypeLayer(this.state.layers, id);
    const [start, end] = textRange(layer.text, range.start, range.end);
    if (!Object.keys(style).length) throw new LayerOperationError('Give at least one style field to set.');
    // Validate once before touching the runs.
    patchTextStyle(DEFAULT_TEXT_STYLE, style);
    const { layers } = updateTypeLayer(
      this.state.layers,
      id,
      (l) => {
        if (start === end) {
          // An empty range styles the whole of an empty text (the caret's style).
          if (l.text.length) throw new LayerOperationError('The range is empty; give start < end (or leave both out for the whole text).');
          return { runs: [{ length: 0, style: patchTextStyle(styleAt(l.runs, 0, DEFAULT_TEXT_STYLE), style) }] };
        }
        return { runs: restyleRange(l.runs, start, end, (s) => patchTextStyle(s, style)) as TypeLayer['runs'] };
      },
      this.textEnv(),
      'restyle its text'
    );
    this.commitLayers(layers, undefined, commitToHistory);
    return this.typeInfo(id);
  }

  /** Sets paragraph style fields on every paragraph that [start, end) touches (default all), one undo step. */
  public setParagraphStyle(id: string, style: ParagraphStyle & Record<string, unknown>, range: { start?: number; end?: number } = {}, commitToHistory = true): TypeLayerInfo {
    const layer = requireTypeLayer(this.state.layers, id);
    const [start, end] = textRange(layer.text, range.start, range.end);
    if (!Object.keys(style).length) throw new LayerOperationError('Give at least one paragraph field to set.');
    patchParagraphStyle({}, style);
    const { layers } = updateTypeLayer(
      this.state.layers,
      id,
      (l) => {
        let at = 0;
        const paragraphs = l.paragraphs.map((p) => {
          const a = at;
          at += p.length;
          const touches = (a < end && at > start) || (start === end && start >= a && (start < at || at === l.text.length));
          return touches || !l.text.length ? { length: p.length, style: patchParagraphStyle(p.style, style) } : p;
        });
        return { paragraphs };
      },
      this.textEnv(),
      'restyle its paragraphs'
    );
    this.commitLayers(layers, undefined, commitToHistory);
    return this.typeInfo(id);
  }

  /**
   * Point text ↔ paragraph text: `{ kind: 'box', width, height }` wraps the text in a box (its
   * top-left where the first line's top-left is now), `{ kind: 'point' }` sets it on one line per
   * paragraph. Also resizes a box. One undo step.
   */
  public setTextFrame(id: string, frame: { kind: 'point' } | { kind: 'box'; width: number; height: number }, commitToHistory = true): TypeLayerInfo {
    const layer = requireTypeLayer(this.state.layers, id);
    if (frame.kind === 'box' && !(Number.isFinite(frame.width) && frame.width >= 1 && Number.isFinite(frame.height) && frame.height >= 1)) throw new LayerOperationError('width and height must be at least 1 pixel.');
    if (frame.kind !== 'box' && frame.kind !== 'point') throw new LayerOperationError('kind must be point or box.');
    const shaper = this.getTextShaper();
    const { layers } = updateTypeLayer(
      this.state.layers,
      id,
      (l) => {
        if (frame.kind === 'box' && l.frame.kind === 'box') return { frame: { kind: 'box', width: frame.width, height: frame.height } };
        if (!shaper) throw new LayerOperationError('Changing between point and paragraph text needs a text shaper to measure the text.');
        const lines = layoutText(l, shaper).lines;
        const first = lines[0];
        // Keep the first line where it is: shift the text-space origin.
        const dx = frame.kind === 'box' ? (first ? first.x : 0) : 0;
        const dy = frame.kind === 'box' ? (first ? first.baseline - first.ascent : 0) : first ? first.baseline : 0;
        const m = textMatrix(l);
        const shifted: AffineMatrix = [m[0], m[1], m[2], m[3], m[0] * dx + m[2] * dy + m[4], m[1] * dx + m[3] * dy + m[5]];
        const nextFrame: TypeLayer['frame'] = frame.kind === 'box' ? { kind: 'box', width: frame.width, height: frame.height } : { kind: 'point' };
        return { frame: nextFrame, transform: shifted };
      },
      this.textEnv(),
      'change its frame'
    );
    this.commitLayers(layers, undefined, commitToHistory);
    return this.typeInfo(id);
  }

  /**
   * Convert to Shape: the text's glyph outlines become a shape layer with the same id, name and
   * layer properties (needs a shaper that gives outlines). The fill is the first run's colour;
   * `warnings` says when other colours were dropped. One undo step.
   */
  public convertTextToShape(id: string): { layerId: string; warnings: string[] } {
    const layer = requireTypeLayer(this.state.layers, id);
    requireUnlocked(layer, 'all', 'convert it');
    const shaper = this.getTextShaper();
    if (!shaper) throw new LayerOperationError('Convert to Shape needs a text shaper that gives glyph outlines; none is set here.');
    const parts = textOutlines(layer, shaper);
    const subpaths = parts.flatMap((p) => bezierToSubpaths(p.path));
    if (!subpaths.length) throw new LayerOperationError('The text draws nothing (it is empty or only spaces), so there is no shape to make.');
    const warnings: string[] = [];
    const colors = new Set(layer.runs.filter((r) => r.length > 0).map((r) => `${r.style.color}/${r.style.opacity ?? 1}`));
    if (colors.size > 1) warnings.push('The text had several colours; the shape takes the first one.');
    const missing = layoutText(layer, shaper).missingFonts;
    if (missing.length) warnings.push(`Missing fonts were drawn with a fallback: ${missing.join(', ')}.`);
    const first = layer.runs.find((r) => r.length > 0)?.style ?? DEFAULT_TEXT_STYLE;
    const fill: ShapePaint = first.opacity !== undefined && first.opacity !== 1 ? { type: 'color', color: first.color, opacity: first.opacity } : { type: 'color', color: first.color };
    const shape = createShapeLayer({ components: [{ op: 'combine', subpaths }], fill, stroke: null, name: layer.name }, this.shapeEnv(), layer.id);
    const keep: Partial<ShapeLayer> = { visible: layer.visible, opacity: layer.opacity, blend: layer.blend };
    for (const k of ['clipped', 'mask', 'locks', 'effects', 'fillOpacity'] as const) if (layer[k] !== undefined) (keep as Record<string, unknown>)[k] = layer[k];
    this.commitLayers(mapLayer(this.state.layers, id, () => ({ ...shape, ...keep }) as ShapeLayer));
    return { layerId: id, warnings };
  }

  /** The layout of a type layer (lines, characters, bounds in text space), or `null` without a shaper. */
  public getTextLayout(id: string): TextLayout | null {
    const layer = requireTypeLayer(this.state.layers, id);
    const shaper = this.getTextShaper();
    return shaper ? layoutText(layer, shaper) : null;
  }

  /** The text index nearest a document point (for clicks on a type layer). */
  public textIndexAt(id: string, point: ImagePoint): number {
    const layer = requireTypeLayer(this.state.layers, id);
    const layout = this.getTextLayout(id);
    return layout ? textIndexAt(layout, toTextSpace(layer, point)) : layer.text.length;
  }

  /** The caret at text index `index` as a document-space segment (top to bottom), for drawing it. */
  public textCaret(id: string, index: number): { top: ImagePoint; bottom: ImagePoint; line: number } | null {
    const layer = requireTypeLayer(this.state.layers, id);
    const layout = this.getTextLayout(id);
    if (!layout) return null;
    const c = caretAt(layout, Math.max(0, Math.min(layer.text.length, index)));
    const m = textMatrix(layer);
    const at = (x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
    return { top: at(c.x, c.top), bottom: at(c.x, c.bottom), line: c.line };
  }

  // --- Shape layers ---

  /** What shape rendering needs: the canvas size and the document's patterns. */
  private shapeEnv(): ShapeEnv {
    return { ...this.naturalSize, pattern: (id) => this.state.patterns?.find((p) => p.id === id) ?? null };
  }

  /** One component from tool or UI input (validated). */
  private componentFrom(spec: ShapeGeometryInput, path: string): ShapeComponent {
    const op = requireOperation(spec.op, `${path}op`);
    if (spec.shape !== undefined && spec.subpaths !== undefined) throw new LayerOperationError(`Give ${path}shape or ${path}subpaths, not both.`);
    if (spec.shape !== undefined) return liveComponent(normalizeLiveShape(spec.shape, `${path}shape`), op);
    if (spec.subpaths !== undefined) return { op, subpaths: normalizeSubpaths(spec.subpaths, `${path}subpaths`) };
    throw new LayerOperationError(`${path}shape (a live shape: { kind: rect | ellipse | polygon | star | line, … }) or ${path}subpaths (anchors or SVG path data) is required.`);
  }

  private shapeInfo(id: string): ShapeLayerInfo {
    const layer = requireShapeLayer(this.state.layers, id);
    const r = (n: number) => Math.round(n * 1000) / 1000;
    const box = (b: CropBox | null) => (b ? { x: r(b.x), y: r(b.y), width: r(b.width), height: r(b.height) } : null);
    const info: ShapeLayerInfo = {
      id: layer.id,
      name: layer.name,
      components: layer.components.map((c, index) => ({
        index,
        op: c.op,
        live: c.live ? JSON.parse(JSON.stringify(c.live)) : null,
        subpaths: roundSubpaths(c.subpaths),
        bounds: box(shapeGeometryBounds({ components: [c] })),
      })),
      fillRule: layer.fillRule ?? 'nonzero',
      fill: layer.fill ? JSON.parse(JSON.stringify(layer.fill)) : null,
      stroke: layer.stroke ? JSON.parse(JSON.stringify(layer.stroke)) : null,
      geometryBounds: box(shapeGeometryBounds(layer)),
      bounds: this.getLayerBounds(id),
    };
    if (layer.annotation) info.annotationId = layer.annotation.id;
    return info;
  }

  /** A shape layer's components, fill, stroke and bounds. */
  public getShapeLayer(id: string): ShapeLayerInfo {
    return this.shapeInfo(id);
  }

  /**
   * Adds a shape layer (one undo step) and makes it active: a live shape or subpaths (or several
   * `components`), filled with `fill` (default the foreground colour, except for a stroke-only
   * open path) and stroked with `stroke`. Goes above the active layer unless placed. Returns its id.
   */
  public addShapeLayer(init: ShapeLayerInit): string {
    const specs: ShapeGeometryInput[] = init.components?.length ? init.components : [init];
    if (init.components?.length && (init.shape !== undefined || init.subpaths !== undefined)) throw new LayerOperationError('Give components, or shape / subpaths, not both.');
    const components = specs.map((c, i) => this.componentFrom(c, init.components?.length ? `components[${i}].` : ''));
    const stroke = init.stroke ? normalizeShapeStroke(init.stroke, 'stroke') : null;
    const openOnly = components.every((c) => !c.live && c.subpaths.every((sp) => !sp.closed));
    const fill = init.fill === undefined ? (stroke && openOnly ? null : normalizeShapePaint(this.state.paint.foreground, 'fill')) : init.fill === null ? null : normalizeShapePaint(init.fill, 'fill');
    if (!fill && !stroke) throw new LayerOperationError('A shape with neither fill nor stroke draws nothing; give fill or stroke.');
    if (init.fillRule !== undefined && init.fillRule !== 'nonzero' && init.fillRule !== 'evenodd') throw new LayerOperationError('fillRule must be nonzero or evenodd.');
    if (init.opacity !== undefined && !(Number.isFinite(init.opacity) && init.opacity >= 0 && init.opacity <= 1)) throw new LayerOperationError('opacity must be between 0 and 1.');
    if (init.blend !== undefined && !isBlendMode(init.blend)) throw new LayerOperationError(`Unknown blend mode "${String(init.blend)}".`);
    const layer = createShapeLayer({ components, fill, stroke, fillRule: init.fillRule, name: init.name, opacity: init.opacity, blend: init.blend }, this.shapeEnv());
    const next = placeLayer(this.state.layers, layer, this.newLayerPlacement(init));
    this.commitLayers(next, () => {
      this.state.activeLayerId = layer.id;
      this.state.activeTarget = 'pixels';
    });
    return layer.id;
  }

  /**
   * Sets a shape's fill, stroke or fill rule (one undo step unless `commitToHistory` is false):
   * `fill` / `stroke` replace them (`null` removes); `stroke` given as a partial object changes
   * only those settings of the current stroke. Returns the shape.
   */
  public setShapeStyle(
    id: string,
    changes: { fill?: ShapePaint | string | null; stroke?: ShapeStrokeInput | null; fillRule?: ShapeFillRule },
    commitToHistory = true
  ): ShapeLayerInfo {
    const layer = requireShapeLayer(this.state.layers, id);
    const fill = changes.fill === undefined ? layer.fill : changes.fill === null ? null : normalizeShapePaint(changes.fill, 'fill');
    const stroke = changes.stroke === undefined ? layer.stroke : changes.stroke === null ? null : normalizeShapeStroke(changes.stroke, 'stroke', layer.stroke);
    if (changes.fillRule !== undefined && changes.fillRule !== 'nonzero' && changes.fillRule !== 'evenodd') throw new LayerOperationError('fillRule must be nonzero or evenodd.');
    const fillRule = changes.fillRule ?? layer.fillRule ?? 'nonzero';
    const { layers } = updateShapeLayer(this.state.layers, id, () => ({ fill, stroke, fillRule: fillRule === 'nonzero' ? undefined : fillRule }), this.shapeEnv(), 'restyle it');
    this.commitLayers(layers, undefined, commitToHistory);
    return this.shapeInfo(id);
  }

  private componentIndex(layer: ShapeLayer, index: unknown): number {
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= layer.components.length) {
      throw new LayerOperationError(`componentIndex must be 0..${layer.components.length - 1} (get_shape_layer lists the components), got ${String(index)}.`);
    }
    return index as number;
  }

  /**
   * Changes one component (one undo step unless `commitToHistory` is false): its live shape
   * (fields not given keep their values when the kind stays the same), its subpaths (which drops
   * the live shape) or its operation. Returns the shape.
   */
  public setShapeComponent(id: string, index: number, change: ShapeGeometryInput, commitToHistory = true): ShapeLayerInfo {
    const layer = requireShapeLayer(this.state.layers, id);
    const i = this.componentIndex(layer, index);
    const current = layer.components[i];
    let shape = change.shape;
    if (shape && current.live && (shape as { kind?: unknown }).kind === undefined) shape = { ...current.live, ...shape } as LiveShape;
    else if (shape && current.live && (shape as { kind?: unknown }).kind === current.live.kind) shape = { ...current.live, ...shape } as LiveShape;
    const next = shape !== undefined || change.subpaths !== undefined ? this.componentFrom({ ...change, shape, op: change.op ?? current.op }, '') : { ...current, op: requireOperation(change.op) };
    const components = layer.components.map((c, k) => (k === i ? next : c));
    const { layers } = updateShapeLayer(this.state.layers, id, () => ({ components }), this.shapeEnv(), 'edit its path');
    this.commitLayers(layers, undefined, commitToHistory);
    return this.shapeInfo(id);
  }

  /** Adds a component to a shape (path operations), on top unless `index` is given (one undo step). Returns the shape. */
  public addShapeComponent(id: string, spec: ShapeGeometryInput, index?: number): ShapeLayerInfo {
    const layer = requireShapeLayer(this.state.layers, id);
    const c = this.componentFrom(spec, '');
    const at = index === undefined ? layer.components.length : index;
    if (!Number.isInteger(at) || at < 0 || at > layer.components.length) throw new LayerOperationError(`index must be 0..${layer.components.length}, got ${String(index)}.`);
    const components = [...layer.components.slice(0, at), c, ...layer.components.slice(at)];
    const { layers } = updateShapeLayer(this.state.layers, id, () => ({ components }), this.shapeEnv(), 'edit its path');
    this.commitLayers(layers);
    return this.shapeInfo(id);
  }

  /** Removes one component of a shape (one undo step); the last one cannot go (delete the layer instead). Returns the shape. */
  public removeShapeComponent(id: string, index: number): ShapeLayerInfo {
    const layer = requireShapeLayer(this.state.layers, id);
    const i = this.componentIndex(layer, index);
    if (layer.components.length === 1) throw new LayerOperationError('This is the shape\'s only component; delete the layer instead (delete_layer).');
    const components = layer.components.filter((_, k) => k !== i);
    const { layers } = updateShapeLayer(this.state.layers, id, () => ({ components }), this.shapeEnv(), 'edit its path');
    this.commitLayers(layers);
    return this.shapeInfo(id);
  }

  /**
   * Merge Shape Components: the area the components combine to becomes one plain component (live
   * shapes become paths), as one undo step. Returns the shape.
   */
  public mergeShapeComponents(id: string): ShapeLayerInfo {
    const layer = requireShapeLayer(this.state.layers, id);
    if (layer.components.length < 2) throw new LayerOperationError('The shape has one component; there is nothing to merge.');
    const components = mergeShapeComponentsOp(layer.components, layer.fillRule);
    const { layers } = updateShapeLayer(this.state.layers, id, () => ({ components, fillRule: undefined }), this.shapeEnv(), 'edit its path');
    this.commitLayers(layers);
    return this.shapeInfo(id);
  }

  /**
   * Rasterize Layer: an annotation layer becomes a pixel layer with the same id, name and
   * properties (needs a canvas), and a pixel layer's filters are baked into its pixels. One undo
   * step. Returns the layer id.
   */
  public async rasterizeLayer(id: string): Promise<string> {
    const layer = requireLayer(this.state.layers, id).layer;
    requireUnlocked(layer, 'all', 'rasterize it');
    const { width, height } = this.naturalSize;
    const canvas = { x: 0, y: 0, width, height };
    let next: PixelLayer;
    if (layer.type === 'annotation') {
      const blend = layer.blend === 'normal' && layer.annotation.blend ? layer.annotation.blend : layer.blend;
      const content = { ...layer, visible: true, opacity: 1, blend: 'normal', annotation: { ...layer.annotation, blend: undefined } } as AnnotationLayer;
      delete content.mask;
      delete content.clipped;
      const surface = await this.compositeToSurface([content], this.paintBounds(layer));
      next = { type: 'pixel', id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, blend, surface, offset: { x: 0, y: 0 } };
      if (layer.clipped) next.clipped = true;
      if (layer.mask) next.mask = layer.mask;
      if (layer.locks) next.locks = layer.locks;
      if (this.state.selectedAnnotationId === layer.annotation.id) this.state.selectedAnnotationId = null;
    } else if (layer.type === 'pixel') {
      if (!layer.filters?.length) throw new LayerOperationError(`Layer "${layer.name || id}" is already pixels with no filters to bake.`);
      requireUnlocked(layer, 'pixels', 'rasterize it');
      const spatial = layer.filters.some((f) => f.enabled && f.kind === 'blur');
      const content: PixelLayer = { ...layer, visible: true, opacity: 1, blend: 'normal' };
      delete content.mask;
      delete content.clipped;
      delete content.fillOpacity;
      const rect = spatial ? canvas : this.getLayerBounds(id) ?? canvas;
      const surface = await this.compositeToSurface([content], rect);
      next = { ...layer, surface, offset: { x: 0, y: 0 } };
      delete next.filters;
      delete next.source;
      if (layer.mask && (layer.offset.x || layer.offset.y)) {
        // The mask lives in layer space: keep it where it was in the document.
        next.mask = { ...layer.mask, surface: translateSurface(layer.mask.surface, layer.offset.x, layer.offset.y) };
      }
    } else if (layer.type === 'smart') {
      return this.rasterizeSmartObject(id);
    } else if (layer.type === 'shape' || layer.type === 'type') {
      next = layer.type === 'shape' ? shapeAsPixelLayer(layer) : typeAsPixelLayer(layer);
      if (this.state.selectedAnnotationId && this.state.selectedAnnotationId === layer.annotation?.id) this.state.selectedAnnotationId = null;
    } else {
      throw new LayerOperationError(`Only shape, type and annotation layers, smart objects and pixel layers with filters rasterize; "${layer.name || id}" is a ${layer.type} layer. Merge it down or flatten instead.`);
    }
    this.commitLayers(mapLayer(this.state.layers, id, () => next));
    return id;
  }

  // --- PSD ---

  // --- Colour management ---

  /** The document's colour profile: its name, built-in id (or `null` for an embedded profile), colour space, and Image › Mode. */
  public getColorProfile(): {
    name: string;
    builtin: BuiltinProfileId | null;
    colorSpace: ColorSpace;
    srgb: boolean;
    mode: 'rgb' | 'cmyk' | 'lab';
    cmykProfile?: { name: string; builtin: BuiltinProfileId | null; intent: Intent };
  } {
    const doc = this.state.colorProfile;
    const p = resolveProfile(doc);
    const m = this.state.colorMode;
    const out: ReturnType<ImageEditorController['getColorProfile']> = { name: doc?.name ?? p.description, builtin: doc ? (doc.builtin ?? null) : 'srgb', colorSpace: p.colorSpace, srgb: isSrgb(doc), mode: m?.mode ?? 'rgb' };
    if (m?.mode === 'cmyk') out.cmykProfile = { name: m.profile.name, builtin: m.profile.builtin ?? null, intent: m.intent };
    return out;
  }

  /**
   * Image › Mode (one undo step): `rgb`, `cmyk` (with a CMYK `profile`, default the coated
   * CMYK, and the `intent` RGB is separated with) or `lab`. The pixels stay RGB in the working
   * space; a CMYK document is soft-proofed through its profile in the viewport, and PSD export
   * writes CMYK or Lab channels. Returns the profile summary.
   */
  public setColorMode(mode: 'rgb' | 'cmyk' | 'lab', options: { profile?: string | Uint8Array; intent?: Intent } = {}): ReturnType<ImageEditorController['getColorProfile']> {
    let next: DocumentColorMode | null;
    if (mode === 'rgb') {
      if (options.profile !== undefined) throw new LayerOperationError('An RGB document takes no CMYK profile; use assign_profile for its working space.');
      next = null;
    } else if (mode === 'lab') next = { mode: 'lab' };
    else if (mode === 'cmyk') {
      let doc: DocumentColorProfile;
      try {
        doc = documentProfile(options.profile ?? 'coated-cmyk');
      } catch (e) {
        throw new LayerOperationError(e instanceof Error ? e.message : String(e));
      }
      const cs = resolveProfile(doc).colorSpace;
      if (cs !== 'cmyk') throw new LayerOperationError(`CMYK mode needs a CMYK profile; "${doc.name}" is ${cs.toUpperCase()}.`);
      const intent = options.intent ?? 'relative';
      if (!INTENTS.includes(intent)) throw new LayerOperationError(`Unknown rendering intent "${String(intent)}"; use ${INTENTS.join(', ')}.`);
      next = { mode: 'cmyk', profile: doc, intent };
    } else throw new LayerOperationError(`Unknown colour mode "${String(mode)}"; use rgb, cmyk or lab.`);
    this.recordHistory();
    if (next) this.state.colorMode = next;
    else delete this.state.colorMode;
    this.notify();
    return this.getColorProfile();
  }

  /** Resolves a profile argument (built-in id or alias, or ICC bytes) as an RGB document profile. */
  private rgbProfileArg(profile: string | Uint8Array, action: string): DocumentColorProfile {
    let doc: DocumentColorProfile;
    try {
      doc = documentProfile(profile);
    } catch (e) {
      throw new LayerOperationError(e instanceof Error ? e.message : String(e));
    }
    const cs = resolveProfile(doc).colorSpace;
    if (cs !== 'rgb') throw new LayerOperationError(`${action} needs an RGB profile; "${doc.name}" is ${cs.toUpperCase()}. The document is RGB: soft-proof CMYK with set_proof_setup, or export to it.`);
    return doc;
  }

  /**
   * Edit › Assign Profile (one undo step): the document's numbers now mean colours in
   * `profile` (a built-in id such as `display-p3`, or ICC bytes); no pixel changes, so colours
   * look different unless the profiles match. Returns the new profile.
   */
  public assignProfile(profile: string | Uint8Array): ReturnType<ImageEditorController['getColorProfile']> {
    const doc = this.rgbProfileArg(profile, 'Assign Profile');
    this.recordHistory();
    if (doc.builtin === 'srgb') delete this.state.colorProfile;
    else this.state.colorProfile = doc;
    this.notify();
    return this.getColorProfile();
  }

  /**
   * Edit › Convert to Profile (one undo step): every pixel layer's numbers are converted so its
   * colours stay the same in `profile` (with `intent` and black point compensation), and
   * `profile` becomes the document's. Shape and type layers, layer effects and adjustment layers
   * keep their numbers (they are listed in `unconvertedLayerIds`). Returns the profile and the
   * layers changed.
   */
  public convertToProfile(
    profile: string | Uint8Array,
    options: { intent?: Intent; bpc?: boolean } = {}
  ): { profile: ReturnType<ImageEditorController['getColorProfile']>; convertedLayerIds: string[]; unconvertedLayerIds: string[] } {
    const doc = this.rgbProfileArg(profile, 'Convert to Profile');
    const intent = options.intent ?? 'relative';
    if (!INTENTS.includes(intent)) throw new LayerOperationError(`Unknown rendering intent "${String(intent)}"; use ${INTENTS.join(', ')}.`);
    const t = Transform.create(resolveProfile(this.state.colorProfile), resolveProfile(doc), { intent, bpc: options.bpc ?? true });
    const converted: string[] = [];
    const unconverted: string[] = [];
    // Colour settings (effects, shape paint, text, annotations) convert through the same transform.
    const memo = new Map<string, string>();
    const px = new Float32Array(4);
    const hex = (h: string): string => {
      let out = memo.get(h.toLowerCase());
      if (out === undefined) {
        const n = parseInt(h.slice(1), 16);
        t.eval([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255], px);
        const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
        out = `#${c(px[0])}${c(px[1])}${c(px[2])}`;
        memo.set(h.toLowerCase(), out);
      }
      return out;
    };
    const shapeEnv = this.shapeEnv();
    const textEnv = this.textEnv();
    const walk = (layers: readonly ImageLayer[]): ImageLayer[] =>
      layers.map((l) => {
        let next: ImageLayer = l;
        if (l.effects?.items.length) next = { ...next, effects: convertColorFields(l.effects, hex) };
        if (l.type === 'group') {
          if (next !== l) converted.push(l.id);
          return { ...(next as typeof l), children: walk(l.children) };
        }
        if (l.type === 'pixel' && l.source !== 'document') next = { ...(next as typeof l), surface: convertSurfaceColors(l.surface, t) };
        else if (l.type === 'pixel') next = { ...(next as typeof l), surface: convertSurfaceColors(this.surfaceOf(l), t), source: undefined } as ImageLayer;
        else if (l.type === 'shape') {
          const s = next as typeof l;
          next = rerenderShape({ ...s, fill: convertColorFields(s.fill, hex), stroke: convertColorFields(s.stroke, hex), ...(s.annotation ? { annotation: convertColorFields(s.annotation, hex) } : {}) }, shapeEnv);
        } else if (l.type === 'type') {
          const recoloured = { ...(next as typeof l), runs: convertColorFields(l.runs, hex) };
          try {
            next = rerenderText(recoloured, textEnv);
          } catch {
            // No text shaper here (Node without fonts): keep the drawn pixels, converted.
            next = { ...recoloured, surface: convertSurfaceColors(l.surface, t) };
          }
        }
        else if (l.type === 'annotation') next = { ...(next as typeof l), annotation: convertColorFields(l.annotation, hex) };
        // A smart object's contents keep their own colours (convert inside them).
        if (l.type === 'smart') unconverted.push(l.id);
        else if (next !== l) converted.push(l.id);
        return next;
      });
    const next = walk(this.state.layers);
    this.commitLayers(next, () => {
      if (doc.builtin === 'srgb') delete this.state.colorProfile;
      else this.state.colorProfile = doc;
    });
    return { profile: this.getColorProfile(), convertedLayerIds: converted, unconvertedLayerIds: unconverted };
  }

  /**
   * View › Proof Setup (view state, not an undo step): shows the document as `profile` would
   * reproduce it, or turns proofing off with `null`. Returns the setup.
   */
  public setProofSetup(setup: (Partial<Omit<ProofSetup, 'profile'>> & { profile: string | Uint8Array }) | null): ProofSetup | null {
    if (!setup) {
      this.state.proofSetup = null;
      this.notify();
      return null;
    }
    let doc: DocumentColorProfile;
    try {
      doc = documentProfile(setup.profile);
    } catch (e) {
      throw new LayerOperationError(e instanceof Error ? e.message : String(e));
    }
    const intent = setup.intent ?? DEFAULT_PROOF.intent;
    if (!INTENTS.includes(intent)) throw new LayerOperationError(`Unknown rendering intent "${String(intent)}"; use ${INTENTS.join(', ')}.`);
    const next: ProofSetup = { ...DEFAULT_PROOF, ...setup, intent, profile: doc };
    if (!canBeDestination(resolveProfile(doc))) throw new LayerOperationError(`"${doc.name}" describes a source only, so colours cannot be proofed through it.`);
    this.state.proofSetup = next;
    this.notify();
    return next;
  }

  /**
   * Converts colours (`#rrggbb`) from one profile to another (default from the document's), with
   * `intent`. For RGB targets returns hex; for others the channel values 0..1 (CMYK, grey, Lab
   * encoded as L/100, (a+128)/255, (b+128)/255) and, for Lab, L*a*b*.
   */
  public convertColors(colors: string[], to: string | Uint8Array, options: { from?: string | Uint8Array; intent?: Intent; bpc?: boolean } = {}): Array<{ input: string; values: number[]; hex?: string; lab: [number, number, number] }> {
    let src: Profile;
    let dst: Profile;
    try {
      src = options.from !== undefined ? resolveProfile(documentProfile(options.from)) : resolveProfile(this.state.colorProfile);
      dst = resolveProfile(documentProfile(to));
    } catch (e) {
      throw new LayerOperationError(e instanceof Error ? e.message : String(e));
    }
    if (src.colorSpace !== 'rgb') throw new LayerOperationError('Colours are given as #rrggbb, so the source profile must be RGB.');
    const t = Transform.create(src, dst, { intent: options.intent ?? 'relative', bpc: options.bpc ?? true });
    const toLab = Transform.create(src, builtinProfile('lab-d50'), { intent: 'relative', bpc: false });
    return colors.map((input) => {
      const m = /^#?([0-9a-f]{6})$/i.exec(input.trim());
      if (!m) throw new LayerOperationError(`Invalid colour "${input}"; use #rrggbb.`);
      const n = parseInt(m[1], 16);
      const rgb = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
      const out = new Float32Array(16);
      t.eval(rgb, out);
      const values = Array.from(out.subarray(0, t.outputs), (v) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000);
      const l = new Float32Array(3);
      toLab.eval(rgb, l);
      const lab: [number, number, number] = [Math.round(l[0] * 10000) / 100, Math.round((l[1] * 255 - 128) * 100) / 100, Math.round((l[2] * 255 - 128) * 100) / 100];
      const res: { input: string; values: number[]; hex?: string; lab: [number, number, number] } = { input, values, lab };
      if (dst.colorSpace === 'rgb') res.hex = `#${values.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
      return res;
    });
  }


  /** The document's bits per channel (8 unless set to 16 or 32). */
  public get bitDepth(): BitDepth {
    return this.state.bitDepth ?? 8;
  }

  /**
   * Image › Mode › 8 / 16 / 32 Bits/Channel (one undo step). Going up costs nothing: layers keep
   * their pixels and read them at the new depth, and edits that understand depth keep the extra
   * precision from then on. Going down rounds every pixel layer's deep samples to the new depth
   * (8 bits: their 8-bit rendering; 32 → 16: colour above 1 is clipped). Returns the depth and
   * the ids of the layers whose pixels changed.
   */
  public setBitDepth(depth: BitDepth): { bitDepth: BitDepth; changedLayerIds: string[] } {
    if (!isBitDepth(depth)) throw new LayerOperationError(`Bit depth must be 8, 16 or 32, not ${String(depth)}.`);
    const changed: string[] = [];
    // Masks convert with the layers (a 16- or 32-bit mask keeps smooth coverage).
    const withMask = (l: ImageLayer): ImageLayer => {
      const m = l.mask;
      if (!m) return l;
      const surface = convertSurfaceDepth(m.surface, depth);
      return surface === m.surface ? l : ({ ...l, mask: { ...m, surface } } as ImageLayer);
    };
    const convert = (layers: readonly ImageLayer[]): ImageLayer[] =>
      layers.map((l) => {
        let next: ImageLayer = l;
        if (l.type === 'group') {
          const children = convert(l.children);
          if (children.some((c, i) => c !== l.children[i])) next = { ...l, children };
        } else if (l.type === 'pixel') {
          const surface = convertSurfaceDepth(l.surface, depth);
          if (surface !== l.surface) next = { ...l, surface };
        }
        next = withMask(next);
        if (next !== l && (l.type !== 'group' || next.mask !== l.mask)) changed.push(l.id);
        return next;
      });
    if (depth === this.bitDepth) return { bitDepth: depth, changedLayerIds: [] };
    const next = convert(this.state.layers);
    this.commitLayers(next, () => {
      if (depth === 8) delete this.state.bitDepth;
      else this.state.bitDepth = depth;
    });
    return { bitDepth: depth, changedLayerIds: changed };
  }

  /** How `toPsd` writes colour: RGB with the working space, or CMYK / Lab channels for those modes. */
  private psdColorOptions(warnings: string[]): {
    iccProfile?: Uint8Array;
    colorMode?: 'rgb' | 'cmyk' | 'lab';
    colorPlanes?: (rgba: Uint8ClampedArray, n: number) => Uint8Array[];
    colorPlanes16?: (rgba: Uint16Array, n: number) => Uint16Array[];
  } {
    const m = this.state.colorMode;
    if (!m) return { iccProfile: profileBytes(this.state.colorProfile) };
    if (flattenLayers(this.state.layers).some((l) => l.type === 'adjustment' && l.visible)) {
      warnings.push(`Adjustment layers were written with their RGB settings; in a ${m.mode.toUpperCase()} file Photoshop applies them to its own channels, so they may look different there.`);
    }
    const planes = colorModePlanes(this.state.colorProfile, m);
    const planes16 = this.bitDepth === 8 ? undefined : colorModePlanes16(this.state.colorProfile, m);
    return m.mode === 'cmyk'
      ? { colorMode: 'cmyk', colorPlanes: planes, colorPlanes16: planes16, iccProfile: profileBytes(m.profile) }
      : { colorMode: 'lab', colorPlanes: planes, colorPlanes16: planes16 };
  }

  /** Pixels per inch of the last opened PSD (written back by `toPsd`). */
  private psdResolution: number | undefined;

  /**
   * Opens PSD / PSB bytes as the document (one undo step): the layers replace the stack and the
   * document has no source image afterwards (every pixel comes from the layers). What the model
   * cannot hold is approximated or left out; `warnings` says what, naming the layers.
   * Throws `PsdError` for files that cannot be read at all.
   */
  public loadPsd(bytes: Uint8Array): { layerIds: string[]; warnings: string[]; width: number; height: number; summary: PsdImportResult['summary'] } {
    const result = importPsd(bytes, { newId: () => newLayerId() });
    this.abandonContents();
    this.recordHistory();
    const s = this.state;
    this.imageElement = null;
    s.sourceUrl = null;
    s.imageDimensions = { width: result.width, height: result.height };
    if (!this.samplePixelsOverride) this.samplePixels = null;
    s.layers = this.checkPsdFonts(result);
    s.crop = null;
    s.transform = { ...DEFAULT_TRANSFORM_VALUES };
    s.outputOpacity = 1;
    delete s.legacyOutputBlur;
    s.selection = null;
    s.selectedAnnotationId = null;
    const pixels = flattenLayers(result.layers).filter((l) => l.type === 'pixel');
    s.activeLayerId = pixels.length ? pixels[pixels.length - 1].id : null;
    s.activeTarget = 'pixels';
    this.psdResolution = result.resolution;
    if (result.patterns.length) s.patterns = result.patterns;
    else delete s.patterns;
    if (result.globalLight) s.globalLight = result.globalLight;
    else delete s.globalLight;
    if (result.bitDepth !== 8) s.bitDepth = result.bitDepth;
    else delete s.bitDepth;
    delete s.colorProfile;
    delete s.colorMode;
    if (result.sourceMode?.mode === 'cmyk') s.colorMode = { mode: 'cmyk', profile: result.sourceMode.profile, intent: 'relative' };
    else if (result.sourceMode?.mode === 'lab') s.colorMode = { mode: 'lab' };
    else if (result.iccProfile) {
      try {
        const doc = documentProfile(result.iccProfile);
        const cs = resolveProfile(doc).colorSpace;
        if (cs === 'rgb') {
          if (!isSrgb(doc)) s.colorProfile = doc;
        } else result.warnings.push(`The file's ${cs.toUpperCase()} profile "${doc.name}" was not used; its colours were read as sRGB.`);
      } catch (e) {
        result.warnings.push(`The embedded ICC profile could not be read (${e instanceof Error ? e.message : String(e)}); colours are read as sRGB.`);
      }
    }
    this.lastLoadProblems = result.warnings;
    this.notify();
    return {
      layerIds: flattenLayers(result.layers).map((l) => l.id),
      warnings: result.warnings,
      width: result.width,
      height: result.height,
      summary: result.summary,
    };
  }

  /**
   * Type layers whose fonts the shaper lacks: they keep Photoshop's pixels, are marked with their
   * `missingFonts`, and a warning names them (an edit draws them with a fallback).
   */
  private checkPsdFonts(result: PsdImportResult): ImageLayer[] {
    const shaper = this.getTextShaper();
    const types = flattenLayers(result.layers).filter((l): l is TypeLayer => l.type === 'type');
    if (!types.length) return result.layers;
    let layers = result.layers;
    const missing = new Map<string, string[]>();
    for (const l of types) {
      const fonts = shaper ? layoutText(l, shaper).missingFonts : [...new Set(l.runs.map((r) => r.style.fontFamily))];
      if (!fonts.length) continue;
      layers = mapLayer(layers, l.id, () => ({ ...l, missingFonts: fonts }));
      for (const f of fonts) missing.set(f, [...(missing.get(f) ?? []), l.name]);
    }
    for (const [font, names] of missing) {
      result.warnings.push(
        shaper
          ? `The font "${font}" is missing here: the type shows Photoshop's pixels until it is edited, then a fallback font (${names.length === 1 ? 'layer' : 'layers'} ${names.map((n) => `"${n}"`).join(', ')}).`
          : `Type layers show Photoshop's pixels; nothing here can draw text, so they cannot be edited (${names.length === 1 ? 'layer' : 'layers'} ${names.map((n) => `"${n}"`).join(', ')}).`
      );
      if (!shaper) break;
    }
    return layers;
  }

  /**
   * The document as an RGB PSD at its bit depth (8, 16 or 32) (PSB above 30 000 px) with real layers, groups, adjustment
   * layers and masks, in the source frame. Layer filters and parametric (depth) masks are baked
   * into pixels and masks, annotation layers are rasterized (in a browser; elsewhere they are left
   * out), and the merged image is our composite. `warnings` lists every such change.
   */
  public async toPsd(): Promise<{ bytes: Uint8Array; warnings: string[]; psb: boolean; width: number; height: number }> {
    const { width, height } = this.naturalSize;
    const canvas = { x: 0, y: 0, width, height };
    const warnings: string[] = [];
    const note = new Map<string, string[]>();
    const add = (msg: string, name: string) => note.set(msg, [...(note.get(msg) ?? []), name]);
    const canRasterize = this.renderer.canRasterize();
    await this.renderer.prepareLayerAssets(this.state.layers, width, height);
    const sources = this.renderer.compositorSources(width, height);
    const compositor = new LayerCompositor();

    const bakeMask = (layer: ImageLayer): RasterMask | undefined => {
      const mask = layer.mask;
      if (!mask?.source) return mask;
      add('Parametric (depth) masks were baked into pixel masks', layer.name);
      const plain = { ...layer, mask: { ...mask, density: 1, feather: 0, enabled: true } } as ImageLayer;
      const ox = layer.type === 'pixel' ? layer.offset.x : 0;
      const oy = layer.type === 'pixel' ? layer.offset.y : 0;
      const coverage = compositor.maskCoverage(plain, canvas, sources);
      const bytes = new Uint8ClampedArray(width * height);
      if (coverage) for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(coverage[i] * 255);
      else bytes.fill(255);
      const baked: RasterMask = { surface: surfaceFromPixels({ width, height, data: bytes }, 1, -ox, -oy), defaultValue: 0 };
      if (mask.density !== undefined && mask.density < 1) baked.density = mask.density;
      if (mask.feather) baked.feather = mask.feather;
      if (mask.enabled === false) baked.enabled = false;
      return baked;
    };

    const prepare = async (layer: ImageLayer): Promise<ImageLayer | null> => {
      const p = await prepareLayer(layer);
      // `exportPsd` writes it as Normal; the merged image keeps the paint mix.
      if (p?.blend === 'pigment') add('The Pigment blend mode has no PSD equivalent and was written as Normal', layer.name);
      return p;
    };

    const prepareLayer = async (layer: ImageLayer): Promise<ImageLayer | null> => {
      if (layer.type === 'group') {
        const children: ImageLayer[] = [];
        for (const c of layer.children) {
          const p = await prepare(c);
          if (p) children.push(p);
        }
        return { ...layer, children, mask: bakeMask(layer) } as ImageLayer;
      }
      if (layer.type === 'adjustment') return { ...layer, mask: bakeMask(layer) } as ImageLayer;
      if (layer.type === 'annotation') {
        if (!canRasterize) {
          add('Annotation layers need a canvas (a browser) to rasterize and were left out', layer.name);
          return null;
        }
        add('Annotation layers were written as pixel layers', layer.name);
        const blend = layer.blend === 'normal' && layer.annotation.blend ? layer.annotation.blend : layer.blend;
        const content = { ...layer, visible: true, opacity: 1, blend: 'normal', annotation: { ...layer.annotation, blend: undefined } } as AnnotationLayer;
        delete content.mask;
        delete content.clipped;
        delete content.effects;
        const data = compositor.composite([content], canvas, sources);
        const out: PixelLayer = {
          type: 'pixel',
          id: layer.id,
          name: layer.name,
          visible: layer.visible,
          opacity: layer.opacity,
          blend,
          surface: surfaceFromPixels({ width, height, data }, 4),
          offset: { x: 0, y: 0 },
        };
        if (layer.clipped) out.clipped = true;
        if (layer.locks) out.locks = layer.locks;
        if (layer.effects) out.effects = layer.effects;
        const mask = bakeMask(layer);
        if (mask) out.mask = mask;
        return out;
      }
      if (layer.type === 'shape' || layer.type === 'type') {
        // Written as Photoshop shape and type layers (with their pixels for viewers that need them).
        if (layer.type === 'type' && layer.missingFonts?.length) add(`Type layers drawn with a fallback for missing fonts (${layer.missingFonts.join(', ')}) keep the font names, so Photoshop may draw them differently`, layer.name);
        const out = { ...layer };
        const mask = bakeMask(layer);
        if (mask) out.mask = mask;
        else delete out.mask;
        return out;
      }
      if (layer.type === 'smart') {
        const out = { ...layer };
        const mask = bakeMask(layer);
        if (mask) out.mask = mask;
        else delete out.mask;
        return out;
      }
      let out: PixelLayer = { ...layer };
      if (layer.source === 'document') {
        out.surface = this.surfaceOf(layer);
        delete out.source;
      }
      const active = layer.filters?.filter(isActiveFilter) ?? [];
      if (active.length) {
        add('Layer filters (develop, blur) were baked into the pixels', layer.name);
        const content: PixelLayer = { ...out, visible: true, opacity: 1, blend: 'normal' };
        delete content.mask;
        delete content.clipped;
        delete content.fillOpacity;
        delete content.effects;
        const data = compositor.composite([content], canvas, sources);
        out = { ...out, surface: surfaceFromPixels({ width, height, data }, 4, -layer.offset.x, -layer.offset.y) };
      }
      if (layer.filters?.some((f) => !f.enabled)) add('Disabled layer filters were left out', layer.name);
      delete out.filters;
      const mask = bakeMask(layer);
      if (mask) out.mask = mask;
      else delete out.mask;
      return out;
    };

    const prepared: ImageLayer[] = [];
    for (const l of this.state.layers) {
      const p = await prepare(l);
      if (p) prepared.push(p);
    }
    const s = this.state;
    if (s.crop) warnings.push('The crop is not applied; the PSD is the uncropped document.');
    if (s.transform.rotate || s.transform.flipH || s.transform.flipV) warnings.push('Rotation and flips are not applied; the PSD is in the source orientation.');
    if (s.outputOpacity < 1) warnings.push('The document opacity is not written; layers keep their own opacity.');
    if (s.legacyOutputBlur) warnings.push('The document-level blur of an old document is not written.');
    for (const [msg, names] of note) warnings.push(`${msg} (${names.length === 1 ? 'layer' : 'layers'} ${names.map((n) => `"${n}"`).join(', ')}).`);

    const merged = compositor.composite(prepared, canvas, { ...sources, version: `psd:${Date.now()}` });
    const color = this.psdColorOptions(warnings);
    // CMYK and Lab files are written at 8 or 16 bits (Photoshop has no 32-bit CMYK or Lab).
    if (color.colorMode && this.bitDepth === 32) warnings.push(`${color.colorMode.toUpperCase()} files are written at 16 bits per channel at most; the 32-bit samples were converted (colour above 1 clipped).`);
    const depth = color.colorMode && this.bitDepth === 32 ? 16 : this.bitDepth;
    // At 16 or 32 bits the merged image is composited at that depth too.
    const mergedDeep = depth === 8 ? undefined : workingToSamples(compositeDeep(prepared, canvas, sources, depth), depth);
    const result = exportPsd({ width, height, layers: prepared, merged, mergedDeep, resolution: this.psdResolution, patterns: this.state.patterns, globalLight: this.state.globalLight, depth, ...color });
    warnings.push(...result.warnings);
    return { bytes: result.bytes, warnings, psb: result.psb, width, height };
  }

  private async replaceSource(src: string, clearAnnotations: boolean): Promise<void> {
    const next = await this.resolveSource(src);
    this.recordHistory();

    const prev = this.state.imageDimensions;
    const sx = next.dimensions.width / (prev.width || next.dimensions.width);
    const sy = next.dimensions.height / (prev.height || next.dimensions.height);

    this.imageElement = next.element;
    this.state.sourceUrl = next.sourceUrl;
    this.state.imageDimensions = next.dimensions;
    if (!this.samplePixelsOverride) this.samplePixels = null;
    if (this.state.selection && (sx !== 1 || sy !== 1)) {
      this.state.selection = normalizeSelection(
        resizeSelection(this.state.selection, Math.round(next.dimensions.width), Math.round(next.dimensions.height))
      );
    }

    let layers = this.state.layers;
    if (sx !== 1 || sy !== 1) {
      if (this.state.crop) {
        this.state.crop = clampCropToImage(
          {
            x: Math.round(this.state.crop.x * sx),
            y: Math.round(this.state.crop.y * sy),
            width: Math.round(this.state.crop.width * sx),
            height: Math.round(this.state.crop.height * sy),
          },
          next.dimensions.width,
          next.dimensions.height
        );
      }
      layers = resizeLegacyMasks(layers, prev, next.dimensions);
      const env: ShapeEnv = { ...next.dimensions, pattern: (pid) => this.state.patterns?.find((p) => p.id === pid) ?? null };
      for (const l of flattenLayers(layers)) {
        if (l.type === 'annotation') {
          layers = mapLayer(layers, l.id, () => ({ ...l, annotation: scaleAnnotation(l.annotation, sx, sy) }));
        } else if (l.type === 'shape') {
          const a = l.annotation;
          const scaled = a ? scaleAnnotation(a, sx, sy) : null;
          const fromAnnotation = scaled ? shapeFromAnnotation(scaled) : null;
          const m: AffineMatrix = [sx, 0, 0, sy, 0, 0];
          const components = fromAnnotation?.components ?? transformShapeComponents(l.components, (p) => ({ x: p.x * sx, y: p.y * sy }), m);
          const moved: ShapeLayer = { ...l, components, ...(fromAnnotation ? { fill: fromAnnotation.fill, stroke: fromAnnotation.stroke } : {}) };
          if (scaled && fromAnnotation) moved.annotation = scaled;
          else delete moved.annotation;
          layers = mapLayer(layers, l.id, () => rerenderShape(moved, env));
        }
      }
    }
    // The Background now shows the new source.
    const bg = developTarget(layers, null);
    if (bg && bg.source !== 'document') layers = mapLayer(layers, bg.id, () => ({ ...bg, source: 'document' }));

    if (clearAnnotations) {
      for (const l of flattenLayers(layers)) if (l.type === 'annotation' || ((l.type === 'shape' || l.type === 'type') && l.annotation)) layers = mapLayer(layers, l.id, () => null);
      this.state.selectedAnnotationId = null;
    }
    this.state.layers = layers;
    this.notify();
  }

  // --- Serialization ---

  /**
   * The serializable state. A document whose layers still have the v1 / v2 shape (the
   * Background with its sliders and depth mask, adjustment layers, annotations) is written as
   * v1 / v2 exactly as before; anything else is written as v3 with the layer pixels as PNG
   * assets. `selection` is included (run-length encoded) only when something is selected.
   */
  public toJSON(): SerializedImageEditorState;
  /**
   * With `assets: 'external'`, layer pixels go to `store` (each PNG uploaded once per store) and
   * the v3 document holds the store's references. Old-shape documents have no assets either way.
   */
  public toJSON(options: { assets: 'external'; store: ImageEditorAssetStore }): Promise<SerializedImageEditorState>;
  public toJSON(options?: { assets: 'external'; store: ImageEditorAssetStore }): SerializedImageEditorState | Promise<SerializedImageEditorState> {
    // While contents are open, the document is the one set aside (without the open edits).
    const root = this.contentsStack[0]?.saved;
    const current = this.state;
    const element = this.imageElement;
    if (root) {
      this.state = root.state;
      this.imageElement = root.element;
      this.viewKey = [];
    }
    let out: SerializedImageEditorState;
    try {
      out = this.serializeState();
      if (this.state.selection?.bounds) out.selection = serializeSelection(this.state.selection);
    } finally {
      if (root) {
        this.state = current;
        this.imageElement = element;
        this.viewKey = [];
      }
    }
    if (!options || out.version !== LAYERED_SCHEMA_VERSION) return options ? Promise.resolve(out) : out;
    return serializeLayersExternal(this.rootLayers(), options.store).then(({ layers, assets, smartContents }) => (smartContents ? { ...out, layers, assets, smartContents } : { ...out, layers, assets }));
  }

  /**
   * Loads a stored state whose v3 assets may live in an asset store (references other than data
   * URLs are fetched with `store.get`), as one undo step. Assets that cannot be fetched are left
   * out and listed in `lastLoadProblems`.
   */
  public async loadJSONAsync(data: SerializedImageEditorState, options: { store?: ImageEditorAssetStore } = {}): Promise<void> {
    if (data.version !== LAYERED_SCHEMA_VERSION || !data.assets) {
      this.loadJSON(data);
      return;
    }
    const problems: string[] = [];
    const assets = await resolveExternalAssets(data.assets, options.store, problems);
    this.loadJSON({ ...data, assets });
    this.lastLoadProblems = [...problems, ...this.lastLoadProblems];
  }

  /** Loads a stored state of any version (one undo step). */
  public loadJSON(data: SerializedImageEditorState): void {
    this.abandonContents();
    this.recordHistory();
    this.applyStored(data);
    let selection: SelectionMask | null = null;
    if (data.selection) {
      try {
        selection = normalizeSelection(deserializeSelection(data.selection));
      } catch {
        selection = null;
      }
    }
    this.state.selection = selection;
    this.dropMismatchedSelection();
    this.notify();
  }

  /** Problems found by the last `loadJSON` / `initialState` of a v3 document (unreadable layers or assets). */
  public lastLoadProblems: string[] = [];

  private applyStored(raw: Partial<SerializedImageEditorState>): void {
    const s = this.state;
    const data = migrateSerializedImageEditorState(raw as SerializedImageEditorState);
    this.lastLoadProblems = [];
    if (isLayered(data)) {
      const problems: string[] = [];
      const canvas = typeof data.width === 'number' && data.width > 0 && typeof data.height === 'number' && data.height > 0 ? { width: data.width, height: data.height } : this.naturalSize;
      const storedPatterns = deserializePatterns(data.patterns, []);
      s.layers = deserializeLayers(data.layers, {
        assets: data.assets ?? {},
        problems,
        smartContents: Array.isArray(data.smartContents) ? data.smartContents : [],
        canvas,
        pattern: (pid) => storedPatterns.find((p) => p.id === pid) ?? null,
        text: this.textEnv(),
      });
      this.lastLoadProblems = problems;
      s.crop = data.crop ? { ...data.crop } : null;
      s.transform = { ...data.transform };
      s.outputOpacity = data.opacity;
      if (typeof data.legacyOutputBlur === 'number' && data.legacyOutputBlur >= 0) s.legacyOutputBlur = data.legacyOutputBlur;
      else delete s.legacyOutputBlur;
      s.activeLayerId = data.activeLayerId && findLayer(s.layers, data.activeLayerId) ? data.activeLayerId : null;
      const light = data.globalLight;
      if (light && Number.isFinite(light.angle) && Number.isFinite(light.altitude)) s.globalLight = { angle: light.angle, altitude: Math.min(90, Math.max(0, light.altitude)) };
      else delete s.globalLight;
      const patterns = deserializePatterns(data.patterns, problems);
      if (patterns.length) s.patterns = patterns;
      else delete s.patterns;
      if (data.bitDepth === 16 || data.bitDepth === 32) s.bitDepth = data.bitDepth;
      else delete s.bitDepth;
      const profile = data.colorProfile ? deserializeColorProfile(data.colorProfile, problems) : null;
      if (profile) s.colorProfile = profile;
      else delete s.colorProfile;
      const cmode = data.colorMode ? deserializeColorMode(data.colorMode, problems) : null;
      if (cmode) s.colorMode = cmode;
      else delete s.colorMode;
      if (!this.imageElement && typeof data.width === 'number' && typeof data.height === 'number' && data.width > 0 && data.height > 0) {
        s.imageDimensions = { width: data.width, height: data.height };
      }
    } else {
      const { width, height } = this.naturalSize;
      const stack = layersFromLegacy(data, width, height);
      s.layers = stack.layers;
      s.outputOpacity = stack.outputOpacity;
      if (stack.legacyOutputBlur !== undefined) s.legacyOutputBlur = stack.legacyOutputBlur;
      else delete s.legacyOutputBlur;
      s.crop = data.crop ? { ...data.crop } : null;
      s.transform = { ...data.transform };
      s.activeLayerId = null;
      delete s.globalLight;
      delete s.patterns;
      delete s.bitDepth;
      delete s.colorProfile;
      delete s.colorMode;
    }
    s.activeTarget = 'pixels';
    this.viewKey = [];
    this.syncViews();
    if (s.selectedAnnotationId && !s.annotations.some((a) => a.id === s.selectedAnnotationId)) s.selectedAnnotationId = null;
  }

  private serializeState(): SerializedImageEditorState {
    const { width, height } = this.naturalSize;
    const view = legacyView(this.stack(), width, height, null);
    // A global light and a bit depth are only stored in the layered schema.
    if (view.exact && !this.state.globalLight && !this.state.patterns?.length && this.bitDepth === 8 && !this.state.colorProfile && !this.state.colorMode) {
      return {
        // States without adjustment layers keep schema 1, so they round-trip unchanged.
        version: view.adjustments.layers?.length ? 2 : 1,
        crop: this.state.crop ? { ...this.state.crop } : null,
        transform: { ...this.state.transform },
        adjustments: serializeAdjustments(view.adjustments),
        depthMask: {
          ...view.depthMask,
          depthRange: [...view.depthMask.depthRange] as [number, number],
        },
        annotations: JSON.parse(JSON.stringify(view.annotations)),
      };
    }
    const { layers, assets, smartContents } = serializeLayers(this.state.layers);
    const out: SerializedLayeredImageEditorState = {
      version: LAYERED_SCHEMA_VERSION,
      width,
      height,
      layers,
      assets,
      activeLayerId: this.state.activeLayerId,
      crop: this.state.crop ? { ...this.state.crop } : null,
      transform: { ...this.state.transform },
      opacity: this.state.outputOpacity,
    };
    if (this.state.legacyOutputBlur !== undefined) out.legacyOutputBlur = this.state.legacyOutputBlur;
    if (this.state.globalLight) out.globalLight = { ...this.state.globalLight };
    if (this.state.patterns?.length) out.patterns = serializePatterns(this.state.patterns);
    if (smartContents) out.smartContents = smartContents;
    if (this.state.bitDepth === 16 || this.state.bitDepth === 32) out.bitDepth = this.state.bitDepth;
    if (this.state.colorProfile) out.colorProfile = serializeColorProfile(this.state.colorProfile);
    if (this.state.colorMode) out.colorMode = serializeColorMode(this.state.colorMode);
    return out;
  }
}

/**
 * Legacy-process adjustments are saved without `process` (and without an unused zero `tint`), so
 * they serialize exactly as they did before process versions existed.
 */
function serializeAdjustments(adjustments: ImageAdjustments): ImageAdjustments {
  const out: ImageAdjustments = { ...adjustments };
  if (out.layers?.length) out.layers = JSON.parse(JSON.stringify(out.layers));
  else delete out.layers;
  if (normalizeProcessVersion(out.process) === LEGACY_PROCESS_VERSION) {
    delete out.process;
    if (!out.tint) delete out.tint;
  }
  return out;
}

/** A pixel layer with its develop filter updated from base-slider values (created if missing). */
function withDevelop(layer: PixelLayer, partial: Partial<ImageAdjustments>): PixelLayer {
  const filters = [...(layer.filters ?? [])];
  let i = filters.findIndex((f) => f.kind === 'develop');
  if (i === -1) {
    filters.unshift({
      id: layer.source === 'document' ? DEVELOP_FILTER_ID : newLayerId('flt'),
      kind: 'develop',
      enabled: true,
      brightness: 0,
      contrast: 0,
      saturation: 0,
      exposure: 0,
      temperature: 0,
      tint: 0,
      process: LATEST_PROCESS_VERSION,
    });
    i = 0;
  }
  const next = { ...(filters[i] as DevelopFilter) };
  for (const k of DEVELOP_KEYS) {
    const v = partial[k];
    if (typeof v === 'number' && Number.isFinite(v)) next[k] = v;
  }
  if ('process' in partial) next.process = normalizeProcessVersion(partial.process);
  filters[i] = next;
  return { ...layer, filters };
}

/** A pixel layer with its blur filter set to `radius` (removed at 0). */
function withBlur(layer: PixelLayer, radius: number): PixelLayer {
  const existing = layer.filters?.find((f) => f.kind === 'blur');
  const filters: LayerFilter[] = (layer.filters ?? []).filter((f) => f.kind !== 'blur');
  if (radius > 0) {
    filters.push({
      id: existing?.id ?? (layer.source === 'document' ? BLUR_FILTER_ID : newLayerId('flt')),
      kind: 'blur',
      enabled: true,
      radius,
    });
  }
  const next = { ...layer };
  if (filters.length) next.filters = filters;
  else delete next.filters;
  return next;
}

/** Updates a node from an old-shape layer (`setAdjustments({ layers })`), keeping a raster mask whose pixels did not change. */
function mergeAdjustmentNode(node: AdjustmentLayerNode, update: AdjustmentLayer, width: number, height: number): AdjustmentLayerNode {
  const next = {
    ...node,
    kind: update.kind,
    params: JSON.parse(JSON.stringify(update.params)),
    visible: update.enabled !== false,
    opacity: update.opacity,
    blend: update.blend,
    name: update.name ?? '',
  } as AdjustmentLayerNode;
  if (!update.mask) delete next.mask;
  else {
    const current = node.mask && !node.mask.source ? node.mask : null;
    const memo = current ? legacyMaskOf(current, width, height) : null;
    if (current && memo && memo.width === update.mask.width && memo.height === update.mask.height && memo.rle === update.mask.rle) {
      next.mask = withMaskProps(current, {
        density: update.mask.density ?? 1,
        feather: update.mask.feather ?? 0,
        enabled: update.mask.enabled !== false,
      });
    } else {
      const m = rasterMaskFromLegacy(update.mask, width, height);
      if (m) next.mask = m;
      else delete next.mask;
    }
  }
  return next;
}

/** Applies mask property changes; `undefined` fields keep their value, defaults are left out. */
function withMaskProps(mask: RasterMask, props: LayerMaskProps): RasterMask {
  const next: RasterMask = { ...mask };
  if (props.density !== undefined) {
    const d = Math.min(1, Math.max(0, props.density));
    if (d !== 1) next.density = d;
    else delete next.density;
  }
  if (props.feather !== undefined) {
    const f = Math.min(1000, Math.max(0, props.feather));
    if (f) next.feather = f;
    else delete next.feather;
  }
  if (props.enabled !== undefined) {
    if (props.enabled) delete next.enabled;
    else next.enabled = false;
  }
  if (props.linked !== undefined) {
    if (props.linked) delete next.linked;
    else next.linked = false;
  }
  return next;
}

/** Rescales adjustment-layer masks (canvas-sized) when the canvas size changes. */
function resizeLegacyMasks(layers: ImageLayer[], from: ImageDimensions, to: ImageDimensions): ImageLayer[] {
  const fw = Math.max(1, Math.round(from.width));
  const fh = Math.max(1, Math.round(from.height));
  const tw = Math.max(1, Math.round(to.width));
  const th = Math.max(1, Math.round(to.height));
  if (fw === tw && fh === th) return layers;
  let out = layers;
  for (const l of flattenLayers(layers)) {
    if (l.type !== 'adjustment' || !l.mask || l.mask.source) continue;
    const old = l.mask;
    const mask = rasterMaskFromLegacy(legacyMaskOf(old, fw, fh), tw, th);
    if (!mask) continue;
    out = mapLayer(out, l.id, (n) => ({ ...n, mask: { ...mask, density: old.density, feather: old.feather, enabled: old.enabled } }));
  }
  return out;
}

/** Whether every pixel of `surface` inside the canvas is opaque. */
function isOpaqueInside(surface: PixelSurface, width: number, height: number): boolean {
  const row = new Uint8ClampedArray(width * 4);
  for (let y = 0; y < height; y++) {
    readRegion(surface, { x: 0, y, width, height: 1 }, row);
    for (let i = 3; i < row.length; i += 4) if (row[i] !== 255) return false;
  }
  return true;
}

function collectStateTiles(layers: readonly ImageLayer[], into: Set<Tile>): void {
  for (const l of flattenLayers(layers)) {
    if (l.type === 'pixel' && l.source !== 'document') collectTiles(l.surface, into);
    if (l.mask && !l.mask.source) collectTiles(l.mask.surface, into);
    if (l.type === 'shape' || l.type === 'type') collectTiles(l.surface, into);
    if (l.type === 'smart') {
      collectTiles(l.surface, into);
      if (l.smartFilters?.mask) collectTiles(l.smartFilters.mask.surface, into);
      if (l.contents.raster) collectTiles(l.contents.raster, into);
      if (l.contents.document) collectStateTiles(l.contents.document.layers, into);
    }
  }
}

/** The stack with every layer above `id` left out (Sample: Current & Below). */
function layersThrough(layers: readonly ImageLayer[], id: string): ImageLayer[] {
  const walk = (list: readonly ImageLayer[]): { out: ImageLayer[]; found: boolean } => {
    const out: ImageLayer[] = [];
    for (const l of list) {
      if (l.id === id) {
        out.push(l);
        return { out, found: true };
      }
      if (l.type === 'group') {
        const sub = walk(l.children);
        if (sub.found) {
          out.push({ ...l, children: sub.out });
          return { out, found: true };
        }
      }
      out.push(l);
    }
    return { out, found: false };
  };
  return walk(layers).out;
}

/** The stack without adjustment layers and layer filters (the pixels as painted). */
function pixelsOnly(layers: readonly ImageLayer[]): ImageLayer[] {
  const out: ImageLayer[] = [];
  for (const l of layers) {
    if (l.type === 'adjustment') continue;
    if (l.type === 'group') out.push({ ...l, children: pixelsOnly(l.children) });
    else if (l.type === 'pixel' && l.filters?.length) {
      const p = { ...l };
      delete p.filters;
      out.push(p);
    } else out.push(l);
  }
  return out;
}

/** Bilinear resample of RGBA pixels to `width × height`. */
export function resizePixels(px: PixelBuffer, width: number, height: number): PixelBuffer {
  const src = px.data as ArrayLike<number>;
  const out = new Uint8ClampedArray(width * height * 4);
  const kx = px.width / width;
  const ky = px.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(px.height - 1, Math.max(0, (y + 0.5) * ky - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(px.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(px.width - 1, Math.max(0, (x + 0.5) * kx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(px.width - 1, x0 + 1);
      const tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = src[(y0 * px.width + x0) * 4 + c] * (1 - tx) + src[(y0 * px.width + x1) * 4 + c] * tx;
        const b = src[(y1 * px.width + x0) * 4 + c] * (1 - tx) + src[(y1 * px.width + x1) * 4 + c] * tx;
        out[(y * width + x) * 4 + c] = a * (1 - ty) + b * ty;
      }
    }
  }
  return { width, height, data: out };
}

function withoutAnnotations(layers: readonly ImageLayer[]): ImageLayer[] {
  const out: ImageLayer[] = [];
  for (const l of layers) {
    if (l.type === 'annotation' || ((l.type === 'shape' || l.type === 'type') && l.annotation)) continue;
    out.push(l.type === 'group' ? { ...l, children: withoutAnnotations(l.children) } : l);
  }
  return out;
}

/** A colour as RGBA bytes: `#rgb`, `#rrggbb`, `#rrggbbaa` or `[r, g, b, a?]` (0..255). */
export function parseColor(value: string | number[]): [number, number, number, number] {
  if (Array.isArray(value)) {
    if (value.length < 3 || value.length > 4 || !value.every((v) => typeof v === 'number' && v >= 0 && v <= 255)) {
      throw new LayerOperationError('A colour array is [r, g, b] or [r, g, b, a] with values 0..255.');
    }
    return [Math.round(value[0]), Math.round(value[1]), Math.round(value[2]), Math.round(value[3] ?? 255)];
  }
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(value).trim());
  if (!m) throw new LayerOperationError(`Invalid colour "${value}"; use #rrggbb or #rrggbbaa.`);
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), hex.length === 8 ? n(6) : 255];
}

/** `#rrggbb` of RGBA bytes (alpha dropped). */
/** A paint source read strictly, its problems as `LayerOperationError`s. */
function readImagePaint(raw: unknown): PaintSource {
  try {
    return parsePaintSource(raw);
  } catch (e) {
    if (e instanceof PaintSourceError) throw new LayerOperationError(e.message);
    throw e;
  }
}

export function toHex(c: readonly number[]): string {
  return '#' + [c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

/** `null` for an empty selection, so "nothing selected" has one representation. */
function normalizeSelection(mask: SelectionMask | null): SelectionMask | null {
  return mask?.bounds ? mask : null;
}

function sameSelection(a: SelectionMask, b: SelectionMask): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const x = a.data;
  const y = b.data;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Scales an annotation's geometry from one image size to another. */
function scaleAnnotation(ann: Annotation, sx: number, sy: number): Annotation {
  const k = Math.sqrt(Math.abs(sx * sy));
  const base = { ...ann, x: ann.x * sx, y: ann.y * sy } as Annotation;
  switch (base.type) {
    case 'pen':
      return { ...base, points: base.points.map((p) => ({ x: p.x * sx, y: p.y * sy })), strokeWidth: base.strokeWidth * k };
    case 'rect':
      return { ...base, width: base.width * sx, height: base.height * sy, strokeWidth: base.strokeWidth * k };
    case 'image':
      return { ...base, width: base.width * sx, height: base.height * sy };
    case 'circle':
      return { ...base, radiusX: base.radiusX * sx, radiusY: base.radiusY * sy, strokeWidth: base.strokeWidth * k };
    case 'arrow':
    case 'line':
      return { ...base, endX: base.endX * sx, endY: base.endY * sy, strokeWidth: base.strokeWidth * k };
    case 'text':
      return { ...base, fontSize: base.fontSize * k };
  }
}
