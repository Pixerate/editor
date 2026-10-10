import {
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
}

export const DEFAULT_ADJUSTMENTS: ImageAdjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  exposure: 0,
  temperature: 0,
  blur: 0,
  opacity: 1,
};

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
  private onStateChange?: (state: ImageEditorState) => void;

  // History stacks
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private maxHistoryDepth: number;
  private isApplyingHistory = false;
  private initialSnapshot: HistoryEntry;

  constructor(options: ImageEditorOptions = {}) {
    this.maxHistoryDepth = options.maxHistoryDepth ?? 50;
    this.onStateChange = options.onStateChange;
    this.renderer = new ImageEditorRenderer();

    const initialAdjustments: ImageAdjustments = {
      ...DEFAULT_ADJUSTMENTS,
      ...options.initialState?.adjustments,
    };

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
    };

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
    };
  }

  private restoreHistoryEntry(entry: HistoryEntry): void {
    this.applySerializedState(entry.state);
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
    this.state.adjustments = {
      ...this.state.adjustments,
      ...partial,
    };
    this.notify();
  }

  public resetAdjustments(): void {
    this.recordHistory();
    this.state.adjustments = { ...DEFAULT_ADJUSTMENTS };
    this.notify();
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

  public async renderMask(options?: { useAnnotations?: boolean; useCrop?: boolean }): Promise<HTMLCanvasElement> {
    return this.renderer.renderMask(this.state, options);
  }

  public async toMaskDataURL(options?: { useAnnotations?: boolean; useCrop?: boolean }): Promise<string> {
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

  public toJSON(): SerializedImageEditorState {
    return this.serializeState();
  }

  public loadJSON(data: SerializedImageEditorState): void {
    this.recordHistory();
    this.applySerializedState(data);
    this.notify();
  }

  private serializeState(): SerializedImageEditorState {
    return {
      version: 1,
      crop: this.state.crop ? { ...this.state.crop } : null,
      transform: { ...this.state.transform },
      adjustments: { ...this.state.adjustments },
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
    this.state.adjustments = { ...data.adjustments };
    this.state.depthMask = {
      ...data.depthMask,
      depthRange: [...data.depthMask.depthRange] as [number, number],
    };
    this.state.annotations = JSON.parse(JSON.stringify(data.annotations || []));
  }
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
