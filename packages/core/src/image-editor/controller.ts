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
import {
  decodeLayerMask,
  layerMaskFromSelection,
  updateLayerMaskProps,
  type LayerMaskProps,
} from './selection/layer-mask';
import type { AdjustmentLayerMask } from './types';

/** Latest serialized schema version (`2`: adjustment layers). */
export const IMAGE_EDITOR_SCHEMA_VERSION = 2 as const;

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

/** Where the selection tools read colours from. */
export interface SampleOptions {
  /** Sample the adjusted image (base adjustments and layers) instead of the source pixels. */
  sampleMerged?: boolean;
  /** Pixels to use instead of reading the source image (natural size, RGBA). */
  pixels?: PixelBuffer;
}

/** A new adjustment layer: its kind plus optional initial values. */
export interface AdjustmentLayerInit<K extends AdjustmentKind = AdjustmentKind> extends AdjustmentLayerUpdate<K> {
  kind: K;
  id?: string;
}

/** The image a history entry was recorded against. */
interface SourceSnapshot {
  sourceUrl: string | null;
  element: CanvasImageSource | null;
  dimensions: ImageDimensions;
}

/**
 * Undo/redo entry: the serializable edit state plus the source image it applies to, so
 * AI edits that replace the image are restorable.
 */
interface HistoryEntry {
  state: SerializedImageEditorState;
  source: SourceSnapshot;
  /** Selections are immutable, so entries share them instead of encoding them. */
  selection: SelectionMask | null;
}

export const DEFAULT_ADJUSTMENTS: ImageAdjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  exposure: 0,
  temperature: 0,
  tint: 0,
  blur: 0,
  opacity: 1,
  process: LATEST_PROCESS_VERSION,
};

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

/**
 * Brings a stored editor state of any schema version to the current shape. Version 1 (and a
 * missing version) has no adjustment layers; everything else is unchanged, so old states load
 * and render exactly as before.
 */
export function migrateSerializedImageEditorState(
  data: Partial<SerializedImageEditorState> & { version?: number }
): SerializedImageEditorState {
  const adjustments = normalizeStoredAdjustments(data.adjustments);
  return {
    version: adjustments.layers?.length ? IMAGE_EDITOR_SCHEMA_VERSION : 1,
    crop: data.crop ? { ...data.crop } : null,
    transform: { ...DEFAULT_TRANSFORM, ...data.transform },
    adjustments: serializeAdjustments(adjustments),
    depthMask: {
      ...DEFAULT_DEPTH_MASK,
      ...data.depthMask,
      depthRange: [...(data.depthMask?.depthRange ?? DEFAULT_DEPTH_MASK.depthRange)] as [number, number],
    },
    annotations: JSON.parse(JSON.stringify(data.annotations ?? [])),
    ...(data.selection ? { selection: { ...data.selection } } : {}),
  };
}

export const DEFAULT_TRANSFORM: ImageTransform = {
  rotate: 0,
  flipH: false,
  flipV: false,
};

export const DEFAULT_DEPTH_MASK: DepthMaskOptions = {
  enabled: false,
  maskSource: null,
  mode: 'threshold',
  depthRange: [0, 255],
  softness: 10,
  invert: false,
};

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
  private isApplyingHistory = false;
  private initialSnapshot: HistoryEntry;
  /** Pixels the selection tools sample (host-provided or read back from the source). */
  private samplePixels: PixelBuffer | null = null;
  private samplePixelsOverride = false;

  constructor(options: ImageEditorOptions = {}) {
    this.maxHistoryDepth = options.maxHistoryDepth ?? 50;
    this.onStateChange = options.onStateChange;
    this.renderer = new ImageEditorRenderer();
    this.renderer.onPreviewHistogram = (histogram) => {
      this.histogramListeners.forEach((l) => l(histogram));
    };

    const initialAdjustments = normalizeStoredAdjustments(options.initialState?.adjustments);

    const initialTransform: ImageTransform = {
      ...DEFAULT_TRANSFORM,
      ...options.initialState?.transform,
    };

    const initialDepthMask: DepthMaskOptions = {
      ...DEFAULT_DEPTH_MASK,
      ...options.initialState?.depthMask,
    };

    this.state = {
      sourceUrl: typeof options.image === 'string' ? options.image : null,
      imageDimensions: { width: 800, height: 600 },
      crop: options.initialState?.crop ?? null,
      transform: initialTransform,
      adjustments: initialAdjustments,
      depthMask: initialDepthMask,
      annotations: options.initialState?.annotations ?? [],
      selectedAnnotationId: null,
      activeTool: 'select',
      zoom: 1,
      pan: { x: 0, y: 0 },
      isOriginalCompared: false,
      selection: null,
      quickMask: false,
    };
    if (options.initialState?.selection) {
      try {
        this.state.selection = normalizeSelection(deserializeSelection(options.initialState.selection));
      } catch {
        // A damaged selection is dropped; the rest of the state still loads.
      }
    }

    if (options.image instanceof Object && 'width' in options.image) {
      this.imageElement = options.image as CanvasImageSource;
      this.state.sourceUrl = (options.image as any).src || null;
      this.state.imageDimensions = {
        width: (options.image as any).naturalWidth || (options.image as any).width || 800,
        height: (options.image as any).naturalHeight || (options.image as any).height || 600,
      };
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
    this.imageElement = source.element;
    this.state.sourceUrl = source.sourceUrl;
    this.state.imageDimensions = source.dimensions;
    this.samplePixels = null;
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
    return this.state;
  }

  public subscribe(listener: (state: ImageEditorState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const currentState = { ...this.state };
    this.onStateChange?.(currentState);
    this.listeners.forEach((l) => l(currentState));
  }

  // --- History (Undo / Redo / Reset) ---

  private captureHistoryEntry(): HistoryEntry {
    return {
      state: this.serializeState(),
      source: {
        sourceUrl: this.state.sourceUrl,
        element: this.imageElement,
        dimensions: { ...this.state.imageDimensions },
      },
      selection: this.state.selection ?? null,
    };
  }

  private restoreHistoryEntry(entry: HistoryEntry): void {
    this.applySerializedState(entry.state);
    this.state.selection = entry.selection;
    if (this.imageElement !== entry.source.element) this.samplePixels = null;
    this.imageElement = entry.source.element;
    this.state.sourceUrl = entry.source.sourceUrl;
    this.state.imageDimensions = { ...entry.source.dimensions };
    if (
      this.state.selectedAnnotationId &&
      !this.state.annotations.some((a) => a.id === this.state.selectedAnnotationId)
    ) {
      this.state.selectedAnnotationId = null;
    }
  }

  private recordHistory(): void {
    if (this.isApplyingHistory) return;
    this.undoStack.push(this.captureHistoryEntry());
    if (this.undoStack.length > this.maxHistoryDepth) {
      this.undoStack.shift();
    }
    this.redoStack = [];
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

  // --- Adjustments ---

  public setAdjustments(partial: Partial<ImageAdjustments>, commitToHistory = true): void {
    if (commitToHistory) {
      this.recordHistory();
    }
    const next: ImageAdjustments = {
      ...this.state.adjustments,
      ...partial,
    };
    if ('layers' in partial) {
      const layers = normalizeAdjustmentLayers(partial.layers);
      if (layers.length) next.layers = layers;
      else delete next.layers;
    }
    this.state.adjustments = next;
    this.notify();
  }

  /** True when the adjustments use an older rendering process than {@link LATEST_PROCESS_VERSION}. */
  public get isProcessOutdated(): boolean {
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
    const layers = this.state.adjustments.layers;
    this.state.adjustments = { ...DEFAULT_ADJUSTMENTS };
    if (layers?.length) this.state.adjustments.layers = layers;
    this.notify();
  }

  // --- Adjustment layers ---

  /** The adjustment layers, bottom (first) to top (last). */
  public getAdjustmentLayers(): AdjustmentLayer[] {
    return this.state.adjustments.layers ?? [];
  }

  public getAdjustmentLayer(id: string): AdjustmentLayer | undefined {
    return this.getAdjustmentLayers().find((l) => l.id === id);
  }

  private setLayers(layers: AdjustmentLayer[]): void {
    const next: ImageAdjustments = { ...this.state.adjustments };
    if (layers.length) next.layers = layers;
    else delete next.layers;
    this.state.adjustments = next;
  }

  /**
   * Adds an adjustment layer on top (or at `index`, 0 = bottom) as one undo step and returns
   * its id. `kind` alone gives neutral parameters.
   */
  public addAdjustmentLayer<K extends AdjustmentKind>(init: K | AdjustmentLayerInit<K>, index?: number): string {
    const spec: AdjustmentLayerInit<K> = typeof init === 'string' ? { kind: init } : init;
    const layers = [...this.getAdjustmentLayers()];
    const layer = createAdjustmentLayer(spec.kind, {
      id: spec.id && !layers.some((l) => l.id === spec.id) ? spec.id : undefined,
      name: spec.name,
      params: spec.params,
      enabled: spec.enabled,
      opacity: spec.opacity,
      blend: spec.blend,
      mask: spec.mask ?? undefined,
    });
    this.recordHistory();
    const at = index === undefined ? layers.length : Math.max(0, Math.min(layers.length, Math.round(index)));
    layers.splice(at, 0, layer);
    this.setLayers(layers);
    this.notify();
    return layer.id;
  }

  /**
   * Updates a layer (`params` merged into the current ones, then normalised). Pass
   * `commitToHistory = false` for the moves of a drag after recording its start once.
   * Returns false for an unknown id.
   */
  public updateAdjustmentLayer(id: string, update: AdjustmentLayerUpdate, commitToHistory = true): boolean {
    const layers = this.getAdjustmentLayers();
    const index = layers.findIndex((l) => l.id === id);
    if (index === -1) return false;
    const current = layers[index];
    const merged = normalizeAdjustmentLayer({
      ...current,
      ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
      ...(update.opacity !== undefined ? { opacity: update.opacity } : {}),
      ...(update.blend !== undefined ? { blend: update.blend } : {}),
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.mask !== undefined ? { mask: update.mask ?? undefined } : {}),
      params: { ...current.params, ...(update.params ?? {}) },
    });
    if (!merged) return false;
    if (commitToHistory) this.recordHistory();
    const next = [...layers];
    next[index] = merged;
    this.setLayers(next);
    this.notify();
    return true;
  }

  /** Removes a layer as one undo step. Returns false for an unknown id. */
  public removeAdjustmentLayer(id: string): boolean {
    const layers = this.getAdjustmentLayers();
    if (!layers.some((l) => l.id === id)) return false;
    this.recordHistory();
    this.setLayers(layers.filter((l) => l.id !== id));
    this.notify();
    return true;
  }

  /** Moves a layer to `toIndex` (0 = bottom) as one undo step. Returns false if nothing moved. */
  public moveAdjustmentLayer(id: string, toIndex: number): boolean {
    const layers = [...this.getAdjustmentLayers()];
    const from = layers.findIndex((l) => l.id === id);
    if (from === -1) return false;
    const to = Math.max(0, Math.min(layers.length - 1, Math.round(toIndex)));
    if (to === from) return false;
    this.recordHistory();
    const [layer] = layers.splice(from, 1);
    layers.splice(to, 0, layer);
    this.setLayers(layers);
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
    if (!this.getAdjustmentLayers().length) return;
    this.recordHistory();
    this.setLayers([]);
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
   * or in a test; `null` goes back to reading the source image. A new source image clears it.
   */
  public setSamplePixels(pixels: PixelBuffer | null): void {
    this.samplePixels = pixels;
    this.samplePixelsOverride = pixels !== null;
  }

  /**
   * The pixels the selection tools sample: the source image at natural size, or with
   * `sampleMerged` the source after the base adjustments and adjustment layers (no crop,
   * rotation or annotations). `null` without pixel access (no DOM, tainted canvas).
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
    if (!options.sampleMerged) return base;
    const copy = { width: base.width, height: base.height, data: new Uint8ClampedArray(base.data as ArrayLike<number>) };
    applyAdjustments(copy as unknown as ImageData, this.state.adjustments);
    return copy;
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

  /**
   * Adds the selection as the layer's mask (Reveal Selection), replacing any mask, as one undo
   * step. Without a selection, returns false.
   */
  public applySelectionAsLayerMask(layerId: string, props: LayerMaskProps = {}): boolean {
    const sel = this.state.selection;
    if (!sel?.bounds || !this.getAdjustmentLayer(layerId)) return false;
    return this.updateAdjustmentLayer(layerId, { mask: layerMaskFromSelection(sel, props) });
  }

  /** Sets (from a selection-shaped mask) or removes (`null`) a layer's mask as one undo step. */
  public setAdjustmentLayerMask(layerId: string, mask: SelectionMask | null, props: LayerMaskProps = {}): boolean {
    return this.updateAdjustmentLayer(layerId, { mask: mask ? layerMaskFromSelection(mask, props) : null });
  }

  /** Changes a layer mask's density (0..1), feather (px) or enabled flag; the mask pixels are kept. */
  public setAdjustmentLayerMaskProps(layerId: string, props: LayerMaskProps, commitToHistory = true): boolean {
    const layer = this.getAdjustmentLayer(layerId);
    if (!layer?.mask) return false;
    return this.updateAdjustmentLayer(layerId, { mask: updateLayerMaskProps(layer.mask, props) }, commitToHistory);
  }

  /** Load Selection from a layer mask (its pixels; density and feather are not applied). */
  public selectionFromLayerMask(layerId: string, mode: SelectionMode = 'replace'): boolean {
    const layer = this.getAdjustmentLayer(layerId);
    const sel = layer?.mask ? decodeLayerMask(layer.mask) : null;
    if (!sel) return false;
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

  public setDepthMask(partial: Partial<DepthMaskOptions>): void {
    this.recordHistory();
    this.state.depthMask = {
      ...this.state.depthMask,
      ...partial,
    };
    this.notify();
  }

  public resetDepthMask(): void {
    this.recordHistory();
    this.state.depthMask = { ...DEFAULT_DEPTH_MASK };
    this.notify();
  }

  // --- Annotations & Layers ---

  public addAnnotation(annotation: CreateAnnotationPayload): string {
    this.recordHistory();
    const id = `ann_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const fullAnnotation = { ...annotation, id } as Annotation;
    this.state.annotations = [...this.state.annotations, fullAnnotation];
    this.state.selectedAnnotationId = id;
    this.notify();
    return id;
  }

  public updateAnnotation(id: string, partial: Partial<Annotation>, commitToHistory = true): void {
    if (commitToHistory) {
      this.recordHistory();
    }
    this.state.annotations = this.state.annotations.map((ann) => {
      if (ann.id === id) {
        return { ...ann, ...partial } as Annotation;
      }
      return ann;
    });
    this.notify();
  }

  public removeAnnotation(id: string): void {
    this.recordHistory();
    this.state.annotations = this.state.annotations.filter((ann) => ann.id !== id);
    if (this.state.selectedAnnotationId === id) {
      this.state.selectedAnnotationId = null;
    }
    this.notify();
  }

  public clearAnnotations(): void {
    this.recordHistory();
    this.state.annotations = [];
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
    try {
      await this.renderer.renderToCanvas(targetCanvas, source, this.state, options);
    } catch {
      // In non-DOM or test mock environments without image loading, safely ignore
    }
  }

  public async renderExport(options?: ExportOptions): Promise<HTMLCanvasElement> {
    const source = this.imageElement || this.state.sourceUrl;
    if (!source) {
      return this.renderer.createCanvas(1, 1);
    }
    return this.renderer.renderExport(source, this.state, options);
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

  public async toSourceDataURL(options: Pick<ExportOptions, 'format' | 'quality'> = {}): Promise<string> {
    const canvas = await this.renderSource();
    return canvas.toDataURL(options.format || 'image/png', options.quality ?? 0.92);
  }

  /**
   * Replaces the source image with an inpainted result (natural image space, see
   * `toSourceDataURL`) and clears the mask annotations, as ONE undoable step.
   */
  public async applyInpaintedImage(newDataUrl: string): Promise<void> {
    await this.replaceSource(newDataUrl, true);
  }

  /**
   * Replaces the source image with a background-removed result as ONE undoable step.
   * Crop and annotations are kept (rescaled if the new image has different dimensions).
   */
  public async applyBackgroundRemovedImage(newDataUrl: string): Promise<void> {
    await this.replaceSource(newDataUrl, false);
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
    this.samplePixels = null;
    if (this.state.selection && (sx !== 1 || sy !== 1)) {
      this.state.selection = normalizeSelection(
        resizeSelection(this.state.selection, Math.round(next.dimensions.width), Math.round(next.dimensions.height))
      );
    }

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
      this.state.annotations = this.state.annotations.map((ann) => scaleAnnotation(ann, sx, sy));
    }

    if (clearAnnotations) {
      this.state.annotations = [];
      this.state.selectedAnnotationId = null;
    }
    this.notify();
  }

  // --- Serialization ---

  /** The serializable state; `selection` is included (run-length encoded) only when something is selected. */
  public toJSON(): SerializedImageEditorState {
    const out = this.serializeState();
    if (this.state.selection?.bounds) out.selection = serializeSelection(this.state.selection);
    return out;
  }

  public loadJSON(data: SerializedImageEditorState): void {
    this.recordHistory();
    this.applySerializedState(migrateSerializedImageEditorState(data));
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

  private serializeState(): SerializedImageEditorState {
    return {
      // States without adjustment layers keep schema 1, so they round-trip unchanged.
      version: this.state.adjustments.layers?.length ? IMAGE_EDITOR_SCHEMA_VERSION : 1,
      crop: this.state.crop ? { ...this.state.crop } : null,
      transform: { ...this.state.transform },
      adjustments: serializeAdjustments(this.state.adjustments),
      depthMask: {
        ...this.state.depthMask,
        depthRange: [...this.state.depthMask.depthRange] as [number, number],
      },
      annotations: JSON.parse(JSON.stringify(this.state.annotations)),
    };
  }

  private applySerializedState(data: SerializedImageEditorState): void {
    this.state.crop = data.crop ? { ...data.crop } : null;
    this.state.transform = { ...data.transform };
    this.state.adjustments = normalizeStoredAdjustments(data.adjustments);
    this.state.depthMask = {
      ...data.depthMask,
      depthRange: [...data.depthMask.depthRange] as [number, number],
    };
    this.state.annotations = JSON.parse(JSON.stringify(data.annotations || []));
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
