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
import type { BlendMode } from './blend';
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
} from './layers/model';
import {
  BACKGROUND_LAYER_ID,
  BACKGROUND_LAYER_NAME,
  BLUR_FILTER_ID,
  DEVELOP_FILTER_ID,
  adjustmentNodeFromLegacy,
  annotationLayerFor,
  annotationLayerName,
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
  resolveExternalAssets,
  serializeLayers,
  serializeLayersExternal,
  type ImageEditorAssetStore,
  type SerializedLayeredImageEditorState,
} from './layers/serialize';
import { LayerCompositor, type CompositorSources } from './layers/compositor';
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
  tileKey,
} from './layers/surface';
import {
  LayerOperationError,
  addLayerFilter as addLayerFilterOp,
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
import {
  CoverageMap,
  DEFAULT_BRUSH,
  StrokeCoverage,
  applyStrokeToTile,
  normalizeBrush,
  type BrushSettings,
  type StrokeApply,
  type StrokePoint,
} from './layers/paint';
import { base64ToBytes, bytesToBase64, decodePng, isPng, parseDataUrl } from './layers/png';
import { getAnnotationBounds } from './geometry';

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
}

/** A stroke: tool, target (default the active layer and target) and brush / colour overrides. */
export interface StrokeInit {
  tool?: 'brush' | 'eraser';
  layerId?: string;
  channel?: LayerTarget;
  /** Overrides of the paint options' brush. */
  brush?: Partial<BrushSettings>;
  /** Paint colour (default the foreground). Masks take its grey value. */
  color?: string | number[];
  /** Eraser colour on locked transparency / masks (default the background). */
  background?: string | number[];
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
}

/** An opaque pre-stroke history snapshot. */
export type HistoryEntryHandle = { readonly __historyEntry: unique symbol };

/** Composites `coverage` into the tiles of `base` under `rects` (document space), returning the new surface. */
function paintCoverageInto(base: TiledSurface, coverage: CoverageMap, apply: StrokeApply, rects: CropBox[]): TiledSurface {
  const tiles = new Map(base.tiles);
  const done = new Set<TileKey>();
  for (const r of rects) {
    for (const t of tilesInRect({ x: r.x - apply.offset.x, y: r.y - apply.offset.y, width: r.width, height: r.height })) {
      const key = tileKey(t.tx, t.ty);
      if (done.has(key)) continue;
      done.add(key);
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

/**
 * A stroke in progress (see `beginStroke`): `push` input points as they arrive, then `end` (one
 * undo step) or `cancel`.
 */
export class PaintStrokeSession {
  private readonly before: HistoryEntryHandle;
  private readonly base: TiledSurface;
  private readonly live: Map<TileKey, Tile>;
  private readonly touched = new Set<TileKey>();
  private last: StrokePoint | null = null;
  private closed = false;

  constructor(
    private readonly controller: ImageEditorController,
    readonly target: { id: string; channel: LayerTarget; surface: TiledSurface },
    private readonly stroke: StrokeCoverage,
    private readonly apply: StrokeApply
  ) {
    this.before = controller._captureForStroke();
    this.base = target.surface;
    this.live = new Map(this.base.tiles);
  }

  get layerId(): string {
    return this.target.id;
  }

  /** Adds input points (document pixels); the stack shows the stroke so far. */
  push(points: readonly StrokePoint[]): void {
    if (this.closed || !points.length) return;
    this.last = points[points.length - 1];
    this.update(this.stroke.push(points));
  }

  private update(rects: CropBox[]): void {
    if (!rects.length) return;
    const ch = this.base.channels;
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
      const src = this.base.tiles.get(key)?.data ?? defaultTile(this.base);
      const prev = this.touched.has(key) ? this.live.get(key)?.data : undefined;
      this.touched.add(key);
      const data = applyStrokeToTile(this.stroke.coverage, src, ch, tx, ty, this.apply, prev ? { into: prev, region: r } : {});
      this.live.set(key, { data, uniform: null });
    }
    this.controller._strokeUpdate(this.target.id, this.target.channel, new TiledSurfaceClass(ch, new Map(this.live), this.base.defaultValue), rects);
  }

  /** Finishes the stroke (one undo step) and returns what changed. */
  end(): PaintStrokeResult {
    if (this.closed) throw new LayerOperationError('This stroke has already ended.');
    this.update(this.stroke.finish(this.last ?? undefined));
    this.closed = true;
    const ch = this.base.channels;
    const tiles = new Map(this.base.tiles);
    let changed = false;
    for (const key of this.touched) {
      const live = this.live.get(key)!;
      const tile = finishTile(live.data, ch, this.base.defaultValue);
      const prev = this.base.tiles.get(key);
      if (tile) tiles.set(key, tile);
      else tiles.delete(key);
      if (!sameTile(prev, tile)) changed = true;
    }
    const surface = changed ? new TiledSurfaceClass(ch, tiles, this.base.defaultValue) : null;
    this.controller._strokeCommit(this.before, this.target.id, this.target.channel, surface);
    const b = this.stroke.coverage.bounds;
    return { layerId: this.target.id, channel: this.target.channel, bounds: changed ? b : null, dabs: this.stroke.dabCount };
  }

  /** Abandons the stroke and restores the layer. */
  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller._strokeCommit(this.before, this.target.id, this.target.channel, null);
  }
}

function sameTile(a: Tile | undefined, b: Tile | null): boolean {
  if (!a || !b) return !a && !b;
  if (a === b) return true;
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
  selection: SelectionMask | null;
  source: SourceSnapshot;
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

  constructor(options: ImageEditorOptions = {}) {
    this.maxHistoryDepth = options.maxHistoryDepth ?? 50;
    this.maxHistoryBytes = options.maxHistoryBytes ?? 512 * 1024 * 1024;
    this.onStateChange = options.onStateChange;
    this.renderer = new ImageEditorRenderer();
    this.renderer.onPreviewHistogram = (histogram) => {
      this.histogramListeners.forEach((l) => l(histogram));
    };
    this.renderer.layerSources = {
      surfaceOf: (layer) => this.surfaceOf(layer),
      sourceIsOpaque: () => this.sourceIsOpaque(),
      version: () => this.sourceVersion(),
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
      paint: { brush: { ...DEFAULT_BRUSH }, foreground: '#000000', background: '#ffffff' },
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
    const currentState = { ...this.state };
    this.onStateChange?.(currentState);
    this.listeners.forEach((l) => l(currentState));
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
    const t: LayerTarget = target === 'mask' && layer?.mask ? 'mask' : 'pixels';
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
    if (!layer || layer.type !== 'pixel') return null;
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
    if (!layer || layer.type !== 'pixel') return null;
    const surface = this.surfaceOf(layer);
    let b = this.boundsCache.get(surface);
    if (b === undefined) {
      b = contentBounds(surface);
      this.boundsCache.set(surface, b);
    }
    return b ? { x: b.x + layer.offset.x, y: b.y + layer.offset.y, width: b.width, height: b.height } : null;
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
    return { width, height, surfaceOf: (l) => this.surfaceOf(l), version: this.sourceVersion() };
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

  /** The pixels a pixel layer composites (the decoded source for the Background). */
  private surfaceOf(layer: PixelLayer): PixelSurface {
    if (layer.source !== 'document') return layer.surface;
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
    this.state.layers = next;
    extra?.();
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
      if (this.state.selectedAnnotationId && !flattenLayers(next).some((l) => l.type === 'annotation' && l.annotation.id === this.state.selectedAnnotationId)) {
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

  /** Changes any layer mask's density, feather or enabled flag (pixels kept). Returns the mask. */
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

  /** Composites `layers` (in isolation) over `rect` into a surface, loading depth maps first. */
  private async compositeToSurface(layers: ImageLayer[], rect: CropBox): Promise<PixelSurface> {
    const { width, height } = this.naturalSize;
    if (flattenLayers(layers).some((l) => l.type === 'annotation' && l.visible) && !this.renderer.canRasterize()) {
      throw new LayerOperationError('Merging annotation layers needs a canvas (a browser); hide or delete them first, or merge in the browser.');
    }
    await this.renderer.prepareLayerAssets(layers, width, height);
    const data = new LayerCompositor().composite(layers, rect, this.renderer.compositorSources(width, height));
    return surfaceFromPixels({ width: rect.width, height: rect.height, data }, 4, rect.x, rect.y);
  }

  /** Document bounds a layer can paint into (pixel content, annotations, or the canvas for the rest). */
  private paintBounds(layer: ImageLayer): CropBox {
    const { width, height } = this.naturalSize;
    const canvas = { x: 0, y: 0, width, height };
    if (layer.type === 'pixel') return this.getLayerBounds(layer.id) ?? { x: 0, y: 0, width: 0, height: 0 };
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
   * opacity and blend; masks, fill and filters are baked), as one undo step. Returns the merged id.
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
    const rect = unionRect(this.paintBounds(lower), upper.type === 'adjustment' ? null : this.paintBounds(upper)) ?? { x: 0, y: 0, width: 1, height: 1 };
    const base: PixelLayer = { ...lower, blend: 'normal', opacity: 1 };
    delete base.clipped;
    const surface = await this.compositeToSurface([base, upper], rect);
    const merged: PixelLayer = { ...lower, surface, offset: { x: 0, y: 0 } };
    delete merged.mask;
    delete merged.fillOpacity;
    delete merged.filters;
    delete merged.source;
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
    const surface = options.mask ? (layer.mask && !layer.mask.source ? layer.mask.surface : null) : layer.type === 'pixel' ? this.surfaceOf(layer) : null;
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

  // --- Painting ---

  /** Brush settings, colours and tool options of the paint tools (view state, no undo). */
  public setPaintOptions(options: Partial<Omit<PaintOptions, 'brush'>> & { brush?: Partial<BrushSettings> }): PaintOptions {
    const cur = this.state.paint;
    const next: PaintOptions = {
      brush: options.brush ? normalizeBrush({ ...cur.brush, ...options.brush }) : cur.brush,
      foreground: options.foreground !== undefined ? toHex(parseColor(options.foreground)) : cur.foreground,
      background: options.background !== undefined ? toHex(parseColor(options.background)) : cur.background,
    };
    this.state.paint = next;
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
    } else {
      if (layer.type !== 'pixel') throw new LayerOperationError(`Layer "${layer.name || id}" is a ${layer.type} layer; ${action} on a pixel layer, or on this layer's mask (channel mask).`);
      requireUnlocked(layer, 'pixels', action);
    }
    if (!layer.visible) throw new LayerOperationError(`Layer "${layer.name || id}" is hidden; show it before you ${action}.`);
    const offset = layer.type === 'pixel' ? layer.offset : { x: 0, y: 0 };
    const surface = ch === 'mask' ? layer.mask!.surface : this.surfaceOf(layer as PixelLayer);
    const lockTransparency = ch === 'pixels' && Boolean(layer.locks?.transparency);
    return { id, layer, channel: ch, offset, surface, lockTransparency };
  }

  /** The layer with its pixels (or mask) replaced by `surface`. */
  private withSurface(layer: ImageLayer, channel: LayerTarget, surface: TiledSurface): ImageLayer {
    if (channel === 'mask') return { ...layer, mask: { ...layer.mask!, surface } } as ImageLayer;
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
    const target = this.paintTarget(init.layerId, init.channel, tool === 'eraser' ? 'erase' : 'paint');
    const brush = normalizeBrush({ ...this.state.paint.brush, ...(init.brush ?? {}) });
    const color = parseColor(init.color ?? this.state.paint.foreground);
    const background = parseColor(init.background ?? this.state.paint.background);
    const toMaskGrey = (c: [number, number, number, number]) => {
      const g = Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
      return [g, g, g, 255] as [number, number, number, number];
    };
    const apply: StrokeApply = {
      mode: tool === 'eraser' ? 'erase' : 'paint',
      color: target.channel === 'mask' ? toMaskGrey(color) : color,
      background: target.channel === 'mask' ? toMaskGrey(background) : background,
      opacity: brush.opacity,
      blend: target.channel === 'mask' ? 'normal' : brush.blend,
      lockTransparency: target.lockTransparency,
      selection: this.state.selection?.bounds ? this.state.selection : null,
      offset: target.offset,
    };
    return new PaintStrokeSession(this, target, new StrokeCoverage(brush), apply);
  }

  /** @internal Shows a stroke's live surface (no history). */
  public _strokeUpdate(layerId: string, channel: LayerTarget, surface: TiledSurface, rects: CropBox[]): void {
    this.state.layers = mapLayer(this.state.layers, layerId, (l) => this.withSurface(l, channel, surface));
    this.notify(rects);
  }

  /** @internal Commits a finished stroke as one undo step (`before` is the pre-stroke state). */
  public _strokeCommit(before: HistoryEntryHandle, layerId: string, channel: LayerTarget, surface: TiledSurface | null): void {
    if (surface) this.state.layers = mapLayer(this.state.layers, layerId, (l) => this.withSurface(l, channel, surface));
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
   * pressure, through the brush or eraser. One undo step. Returns the layer, channel, the changed
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
      color: target.channel === 'mask' ? grey(color) : color,
      background: target.channel === 'mask' ? grey(background) : background,
      opacity,
      blend: target.channel === 'mask' ? 'normal' : blend,
      lockTransparency: target.lockTransparency,
      selection: null,
      offset: target.offset,
    };
    const surface = paintCoverageInto(target.surface, coverage, apply, [region]);
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
      surfaceOf: (l) => (l.source === 'document' && pixels ? surfaceFromPixels(pixels, 4) : this.surfaceOf(l)),
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

  private annotationLayer(id: string): AnnotationLayer | undefined {
    return flattenLayers(this.state.layers).find(
      (l): l is AnnotationLayer => l.type === 'annotation' && l.annotation.id === id
    );
  }

  /** Adds an annotation as its own layer (top of the stack unless `aboveId` is given). */
  public addAnnotation(annotation: CreateAnnotationPayload, placement: AnnotationPlacement = {}): string {
    this.recordHistory();
    const id = `ann_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const fullAnnotation = { ...annotation, id } as Annotation;
    const layer = annotationLayerFor(fullAnnotation);
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
    if (layer) {
      const annotation = { ...layer.annotation, ...partial, id } as Annotation;
      const name = layer.name === annotationLayerName(layer.annotation) ? annotationLayerName(annotation) : layer.name;
      this.state.layers = mapLayer(this.state.layers, layer.id, () => ({ ...layer, annotation, name }));
    }
    this.notify();
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

  public clearAnnotations(): void {
    this.recordHistory();
    let layers = this.state.layers;
    for (const l of flattenLayers(layers)) if (l.type === 'annotation') layers = mapLayer(layers, l.id, () => null);
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

  // --- Rendering & Export ---

  public async render(targetCanvas: HTMLCanvasElement, options?: RenderOptions): Promise<void> {
    const source = this.imageElement || this.state.sourceUrl;
    if (!source) return;
    this.syncViews();
    const dirty = this.pendingDirty;
    this.pendingDirty = [];
    try {
      await this.renderer.renderToCanvas(targetCanvas, source, this.state, {
        ...options,
        dirty: dirty === 'all' ? undefined : dirty,
        checkpointLayerId: this.state.activeLayerId,
      });
    } catch {
      // In non-DOM or test mock environments without image loading, safely ignore
    }
  }

  public async renderExport(options?: ExportOptions): Promise<HTMLCanvasElement> {
    const source = this.imageElement || this.state.sourceUrl;
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
    const source = this.imageElement || this.state.sourceUrl;
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
    return canvas.toDataURL(format, quality);
  }

  public async toBlob(options: ExportOptions = {}): Promise<Blob> {
    const canvas = await this.renderExport(options);
    const format = options.format || 'image/png';
    const quality = options.quality ?? 0.92;

    return new Promise((resolve, reject) => {
      if (canvas.toBlob) {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
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
          resolve(new Blob([ab], { type: format }));
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
    const target = options.target ?? (this.isMultiLayer ? 'new-layer' : 'replace');
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
    if ((options.target ?? (this.isMultiLayer ? 'new-layer' : 'replace')) === 'replace') {
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
    if ((options.target ?? (this.isMultiLayer ? 'new-layer' : 'replace')) === 'replace') {
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
    } else {
      throw new LayerOperationError(`Only annotation layers and pixel layers with filters rasterize; "${layer.name || id}" is a ${layer.type} layer. Merge it down or flatten instead.`);
    }
    this.commitLayers(mapLayer(this.state.layers, id, () => next));
    return id;
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
      for (const l of flattenLayers(layers)) {
        if (l.type === 'annotation') {
          layers = mapLayer(layers, l.id, () => ({ ...l, annotation: scaleAnnotation(l.annotation, sx, sy) }));
        }
      }
    }
    // The Background now shows the new source.
    const bg = developTarget(layers, null);
    if (bg && bg.source !== 'document') layers = mapLayer(layers, bg.id, () => ({ ...bg, source: 'document' }));

    if (clearAnnotations) {
      for (const l of flattenLayers(layers)) if (l.type === 'annotation') layers = mapLayer(layers, l.id, () => null);
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
    const out = this.serializeState();
    if (this.state.selection?.bounds) out.selection = serializeSelection(this.state.selection);
    if (!options || out.version !== LAYERED_SCHEMA_VERSION) return options ? Promise.resolve(out) : out;
    return serializeLayersExternal(this.state.layers, options.store).then(({ layers, assets }) => ({ ...out, layers, assets }));
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
      s.layers = deserializeLayers(data.layers, { assets: data.assets ?? {}, problems });
      this.lastLoadProblems = problems;
      s.crop = data.crop ? { ...data.crop } : null;
      s.transform = { ...data.transform };
      s.outputOpacity = data.opacity;
      if (typeof data.legacyOutputBlur === 'number' && data.legacyOutputBlur >= 0) s.legacyOutputBlur = data.legacyOutputBlur;
      else delete s.legacyOutputBlur;
      s.activeLayerId = data.activeLayerId && findLayer(s.layers, data.activeLayerId) ? data.activeLayerId : null;
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
    }
    s.activeTarget = 'pixels';
    this.viewKey = [];
    this.syncViews();
    if (s.selectedAnnotationId && !s.annotations.some((a) => a.id === s.selectedAnnotationId)) s.selectedAnnotationId = null;
  }

  private serializeState(): SerializedImageEditorState {
    const { width, height } = this.naturalSize;
    const view = legacyView(this.stack(), width, height, null);
    if (view.exact) {
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
    const { layers, assets } = serializeLayers(this.state.layers);
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
  }
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
    if (l.type === 'annotation') continue;
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
