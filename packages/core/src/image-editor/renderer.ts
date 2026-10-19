import type {
  Annotation,
  CropBox,
  ImagePoint,
  ExportOptions,
  ImageEditorFit,
  ImageEditorState,
  ImageTransform,
  PenAnnotation,
  RectAnnotation,
  CircleAnnotation,
  ArrowAnnotation,
  LineAnnotation,
  TextAnnotation,
  ImageAnnotation,
} from './types';
import { applyAdjustments, applyDepthMask } from './filters';
import { adjustmentLayersKey } from './adjustment-layers';
import { canvasCompositeOperation, blendImageData, normalizeBlendMode } from './blend';
import { computeHistogram, type ImageHistogram } from './histogram';
import { normalizeProcessVersion } from './color';
import { buildLayerMaskPlanes } from './selection/layer-mask';
import { selectionOutline, quickMaskPixels } from './selection/overlay';
import type { SelectionMask } from './selection/mask';
import { LayerCompositor, type CompositorSources } from './layers/compositor';
import { flattenLayers, type ImageLayer, type PixelLayer } from './layers/model';
import {
  addToHistogram,
  applyOutputStage,
  baseProjection,
  coveringRect,
  emptyHistogram,
  needsLegacyBase,
  splitOverlayAnnotations,
  sumHistograms,
} from './layers/render';
import { TILE, tileKey, type PixelSurface, type TileKey } from '../raster/surface';
import type { GlobalLight } from '../raster/effects/model';
import type { EffectPattern } from '../raster/effects/patterns';
import { isLegacyShape as isLegacyStack } from './layers/migrate';
import {
  applyImageProjectionToContext,
  clampCropToImage,
  getAnnotationBounds,
  getRotatedSize,
  getViewportMetrics,
  getViewportProjection,
  normalizeAngle,
  type ImageProjection,
  type ViewportMetrics,
} from './geometry';

export interface RenderOptions {
  viewportWidth?: number;
  viewportHeight?: number;
  showCropOverlay?: boolean;
  showSelectionOverlay?: boolean;
  interactive?: boolean;
  draftAnnotation?: Annotation | null;
  draftCrop?: CropBox | null;
  /** Viewport fit mode: 'contain' scales to full viewport bounds; 'margin' scales to 85% with 1.0 cap (default). */
  fit?: ImageEditorFit;
  /**
   * How the active selection is shown: marching ants (default when there is a selection),
   * a Quick Mask tint over the unselected area (default when `state.quickMask`), or not at all.
   */
  selectionDisplay?: 'ants' | 'quickMask' | 'none';
  /** Dash offset of the marching ants in screen pixels (animate it to make them march). */
  antsOffset?: number;
  /** A selection being drawn (e.g. a lasso), shown as a dashed outline in natural pixels. */
  draftSelectionPath?: ImagePoint[] | null;
  /** Document rectangles that are the only change since the last render (strokes); recomposites only there. */
  dirty?: CropBox[];
  /** The layer being edited: tiles keep a checkpoint below it so strokes and drags on it start there. */
  checkpointLayerId?: string | null;
  /** The paint tools' cursor: a circle of `diameter` px at (`x`, `y`) in natural pixels. */
  brushCursor?: { x: number; y: number; diameter: number } | null;
}

/**
 * Image Cache to avoid refetching HTMLImageElement objects repeatedly during re-renders.
 */
class ImageCache {
  private cache = new Map<string, HTMLImageElement>();

  public async get(src: string): Promise<HTMLImageElement> {
    const existing = this.cache.get(src);
    if (existing && existing.complete) {
      return existing;
    }

    return new Promise((resolve, reject) => {
      if (typeof window === 'undefined' || typeof Image === 'undefined') {
        reject(new Error('Image loading is only supported in browser/DOM environments'));
        return;
      }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        this.cache.set(src, img);
        resolve(img);
      };
      img.onerror = (e) => reject(new Error(`Failed to load image from: ${src}`));
      img.src = src;

      // In JSDOM or test environments where Image resource loading is inactive, resolve promptly
      if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) {
        setTimeout(() => {
          try {
            Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
            Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true });
            Object.defineProperty(img, 'complete', { value: true, configurable: true });
          } catch {
            // Ignore definition errors in restrictive environments
          }
          this.cache.set(src, img);
          resolve(img);
        }, 10);
      }
    });
  }

  public set(src: string, img: HTMLImageElement): void {
    this.cache.set(src, img);
  }

  /** The loaded image for `src`, or `undefined` while it is not loaded yet. */
  public peek(src: string): HTMLImageElement | undefined {
    const img = this.cache.get(src);
    return img && img.complete ? img : undefined;
  }

  public clear(): void {
    this.cache.clear();
  }
}

export const globalImageCache = new ImageCache();

/**
 * Renders an image with all its transformations, filters, depth masks, and annotations
 * to a target HTMLCanvasElement.
 */
export class ImageEditorRenderer {
  public imageCache = globalImageCache;
  private cachedBaseCanvas: HTMLCanvasElement | null = null;
  private cachedBaseKey = '';
  /**
   * Histogram of the last viewport base render (after adjustments and layers, before
   * annotations); `null` until a render with pixel access has happened.
   */
  public previewHistogram: ImageHistogram | null = null;
  /** Called whenever the viewport base image is re-rendered with the new histogram. */
  public onPreviewHistogram?: (histogram: ImageHistogram | null) => void;
  private sourceIds = new WeakMap<object, number>();
  private nextSourceId = 0;
  /**
   * The viewport's compositor. It only ever composites the viewport's stack, so its tile cache can
   * trust dirty rectangles; exports use `exportCompositor`.
   */
  public compositor = new LayerCompositor();
  private exportCompositor = new LayerCompositor({ maxCacheBytes: 64 * 1024 * 1024 });
  /** How the host resolves layer pixels (set by the controller). */
  public layerSources?: LayerSourcesHost;
  /**
   * Debug / test switch: `'legacy'` forces the old base path for documents that still have the
   * v1 / v2 shape, `'layers'` forces the compositor. Default: chosen per document.
   */
  public baseRoute: 'auto' | 'legacy' | 'layers' = 'auto';
  /** Which path the last base render took. */
  public lastBaseRoute: 'legacy' | 'layers' | null = null;
  private comp: CompositeCanvas | null = null;
  private depthMaps = new Map<string, { width: number; height: number; data: Uint8ClampedArray }>();
  private assetVersion = 0;
  private scratch: HTMLCanvasElement | null = null;
  private cachedPostCanvas: HTMLCanvasElement | null = null;
  private cachedPostKey = '';
  private cachedPostHistogram: ImageHistogram | null = null;

  /**
   * Helper to create a canvas element safely in browser/JSDOM.
   */
  public createCanvas(width: number, height: number): HTMLCanvasElement {
    if (typeof document !== 'undefined' && document.createElement) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(width));
      c.height = Math.max(1, Math.round(height));
      return c;
    }
    // Fallback for non-DOM / headless
    return {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
      getContext: () => null,
      toDataURL: () => '',
      toBlob: () => {},
    } as unknown as HTMLCanvasElement;
  }

  /**
   * Renders the editor state onto a canvas (viewport or preview).
   */
  public async renderToCanvas(
    targetCanvas: HTMLCanvasElement,
    imageSource: CanvasImageSource | string,
    state: ImageEditorState,
    options: RenderOptions = {}
  ): Promise<void> {
    const ctx = targetCanvas.getContext('2d');
    if (!ctx) return;

    let img: CanvasImageSource;
    if (typeof imageSource === 'string') {
      img = await this.imageCache.get(imageSource);
    } else {
      img = imageSource;
    }

    const { width: naturalWidth, height: naturalHeight } = getSourceSize(img);
    const fit = options.fit ?? state.fit ?? 'margin';
    // Geometry helpers read `imageDimensions`; make sure they see the real source size so the
    // viewport drawn here and the hit-testing done by the UI share one projection.
    const geoState: ImageEditorState = {
      ...state,
      fit,
      imageDimensions:
        state.imageDimensions.width === naturalWidth && state.imageDimensions.height === naturalHeight
          ? state.imageDimensions
          : { width: naturalWidth, height: naturalHeight },
    };

    const { crop, transform, adjustments, depthMask, annotations, selectedAnnotationId, zoom, pan, isOriginalCompared } = state;

    // Viewport dimensions
    const vpWidth = options.viewportWidth || targetCanvas.width;
    const vpHeight = options.viewportHeight || targetCanvas.height;

    targetCanvas.width = vpWidth;
    targetCanvas.height = vpHeight;

    ctx.clearRect(0, 0, vpWidth, vpHeight);

    // If in compare mode, render original image directly and exit
    if (isOriginalCompared) {
      this.drawFittedImage(ctx, img, naturalWidth, naturalHeight, vpWidth, vpHeight, zoom, pan, fit);
      return;
    }

    // When actively in crop tool or overlay requested, show full image so user can adjust the crop box
    const isActivelyCropping = Boolean(options.showCropOverlay || state.activeTool === 'crop');
    const projection = getViewportProjection(geoState, vpWidth, vpHeight, isActivelyCropping);
    const { region } = projection;
    const rotated = getRotatedSize(region.width, region.height, transform);

    const route = this.chooseRoute(state, region, naturalWidth, naturalHeight);
    let overlay: Annotation[] = annotations;
    if (route === 'legacy') {
      // 1. Offscreen canvas for Base Image + Transform (Flip/Rotate) + Crop + Adjustments + Depth mask
      const baseKey = [
        this.getSourceId(img),
        state.sourceUrl,
        `${naturalWidth}x${naturalHeight}`,
        `${region.x},${region.y},${region.width},${region.height}`,
        `${projection.angle},${transform.flipH},${transform.flipV}`,
        `${adjustments.brightness},${adjustments.contrast},${adjustments.saturation},${adjustments.exposure},${adjustments.temperature},${adjustments.tint ?? 0},${adjustments.blur},${adjustments.opacity},p${normalizeProcessVersion(adjustments.process)}`,
        adjustmentLayersKey(adjustments.layers),
        `${depthMask.enabled},${depthMask.maskSource},${depthMask.depthRange?.[0]}-${depthMask.depthRange?.[1]},${depthMask.softness},${depthMask.invert},${depthMask.mode}`,
      ].join('|');

      let baseCanvas = this.cachedBaseCanvas;
      if (!baseCanvas || this.cachedBaseKey !== baseKey) {
        let histogram: ImageHistogram | null = null;
        baseCanvas = await this.renderBaseImage(img, naturalWidth, naturalHeight, region, transform, state, (pixels) => {
          histogram = computeHistogram(pixels);
        });
        this.cachedBaseCanvas = baseCanvas;
        this.cachedBaseKey = baseKey;
        this.previewHistogram = histogram;
        this.onPreviewHistogram?.(histogram);
      }

      // 2. Draw the base canvas into the viewport (centred, fitted, zoomed, panned)
      const drawW = rotated.width * projection.scale;
      const drawH = rotated.height * projection.scale;
      ctx.drawImage(baseCanvas, projection.originX - drawW / 2, projection.originY - drawH / 2, drawW, drawH);
    } else {
      // 1–2. The layer stack, composited per tile in document space, drawn through the projection.
      const split = splitOverlayAnnotations(state.layers);
      overlay = split.overlay.map((l) => l.annotation);
      await this.prepareLayerAssets(split.composite, naturalWidth, naturalHeight);
      const comp = this.updateComposite(split.composite, region, naturalWidth, naturalHeight, options);
      const base = this.layeredBase(comp, state, region, transform);
      if (base) {
        // Drawn exactly as the legacy base canvas is, so both paths look the same at any zoom.
        const drawW = rotated.width * projection.scale;
        const drawH = rotated.height * projection.scale;
        ctx.drawImage(base.canvas, projection.originX - drawW / 2, projection.originY - drawH / 2, drawW, drawH);
        this.publishHistogram(base.histogram ?? comp?.histogram() ?? null);
      }
    }

    // 3. Annotations live in natural image space: draw them through the same projection,
    //    clipped to the visible (cropped) region.
    if (overlay.length > 0 || options.draftAnnotation) {
      ctx.save();
      applyImageProjectionToContext(ctx, projection);
      ctx.beginPath();
      ctx.rect(region.x, region.y, region.width, region.height);
      ctx.clip();

      for (const ann of overlay) {
        await this.drawAnnotation(ctx, ann);
        if (options.showSelectionOverlay && ann.id === selectedAnnotationId) {
          this.drawAnnotationSelection(ctx, ann);
        }
      }
      // A selected annotation drawn inside the composite still gets its handles.
      if (options.showSelectionOverlay && selectedAnnotationId && !overlay.some((a) => a.id === selectedAnnotationId)) {
        const sel = annotations.find((a) => a.id === selectedAnnotationId);
        if (sel) this.drawAnnotationSelection(ctx, sel);
      }

      // Render active live draft annotation
      if (options.draftAnnotation) {
        await this.drawAnnotation(ctx, options.draftAnnotation);
      }

      ctx.restore();
    }

    // 4. Selection: marching ants or Quick Mask, through the same projection.
    const display = options.selectionDisplay ?? (state.quickMask ? 'quickMask' : 'ants');
    if ((state.selection?.bounds && display !== 'none') || options.draftSelectionPath?.length) {
      ctx.save();
      try {
        applyImageProjectionToContext(ctx, projection);
        ctx.beginPath();
        ctx.rect(region.x, region.y, region.width, region.height);
        ctx.clip();
        if (state.selection?.bounds && display === 'quickMask') this.drawQuickMask(ctx, state.selection);
        else if (state.selection?.bounds && display === 'ants') this.drawAnts(ctx, state.selection, projection.scale, options.antsOffset ?? 0);
        if (options.draftSelectionPath?.length) this.drawDraftPath(ctx, options.draftSelectionPath, projection.scale);
      } catch {
        // Overlays are best effort (headless / mocked contexts).
      }
      ctx.restore();
    }

    // Brush cursor: the tip outline, one screen pixel wide, white over black.
    if (options.brushCursor) {
      const b = options.brushCursor;
      ctx.save();
      try {
        applyImageProjectionToContext(ctx, projection);
        const px = 1 / (projection.scale || 1);
        ctx.beginPath();
        ctx.arc(b.x, b.y, Math.max(px, b.diameter / 2), 0, Math.PI * 2);
        ctx.lineWidth = 2 * px;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.stroke();
        ctx.lineWidth = px;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      } catch {
        // Best effort (headless / mocked contexts).
      }
      ctx.restore();
    }

    // 5. Draw Crop Grid Overlay if crop overlay is requested
    if (isActivelyCropping) {
      const activeCrop =
        options.draftCrop !== undefined && options.draftCrop !== null
          ? options.draftCrop
          : (crop ?? { x: 0, y: 0, width: naturalWidth, height: naturalHeight });
      this.drawCropOverlay(ctx, getViewportMetrics(geoState, vpWidth, vpHeight, true, activeCrop));
    }
  }

  /**
   * Draws `region` of the source image with rotation/flip applied, then pixel adjustments
   * and the depth mask (which receives the identical transform so it stays aligned).
   */
  private async renderBaseImage(
    img: CanvasImageSource,
    naturalWidth: number,
    naturalHeight: number,
    region: CropBox,
    transform: ImageTransform,
    state: Pick<ImageEditorState, 'adjustments' | 'depthMask'>,
    onPixels?: (pixels: ImageData) => void
  ): Promise<HTMLCanvasElement> {
    const { adjustments, depthMask } = state;
    const rotated = getRotatedSize(region.width, region.height, transform);
    const baseW = Math.max(1, Math.round(rotated.width));
    const baseH = Math.max(1, Math.round(rotated.height));
    const baseCanvas = this.createCanvas(baseW, baseH);
    const baseCtx = baseCanvas.getContext('2d');
    if (!baseCtx) return baseCanvas;

    const projection = getBaseProjection(region, transform, baseW, baseH);

    baseCtx.save();
    applyImageProjectionToContext(baseCtx, projection);
    baseCtx.drawImage(
      img,
      region.x, region.y, region.width, region.height,
      region.x, region.y, region.width, region.height
    );
    baseCtx.restore();

    const imageData = baseCtx.getImageData(0, 0, baseW, baseH);
    if (imageData) {
      // Layer masks live in natural pixels: resample them through the same projection.
      const layerMasks = buildLayerMaskPlanes(adjustments.layers, naturalWidth, naturalHeight, projection, baseW, baseH);
      applyAdjustments(imageData, adjustments, layerMasks ? { layerMasks } : {});

      if (depthMask.enabled && depthMask.maskSource) {
        try {
          const maskImg = await this.imageCache.get(depthMask.maskSource);
          const maskSize = getSourceSize(maskImg, naturalWidth, naturalHeight);
          const sx = maskSize.width / naturalWidth;
          const sy = maskSize.height / naturalHeight;
          const maskCanvas = this.createCanvas(baseW, baseH);
          const maskCtx = maskCanvas.getContext('2d');
          if (maskCtx) {
            // The depth map covers the whole source image; scale it to natural pixels and
            // apply the exact same rotate/flip/crop projection as the image itself.
            maskCtx.save();
            applyImageProjectionToContext(maskCtx, projection);
            maskCtx.drawImage(
              maskImg,
              region.x * sx, region.y * sy, region.width * sx, region.height * sy,
              region.x, region.y, region.width, region.height
            );
            maskCtx.restore();
            const maskData = maskCtx.getImageData(0, 0, baseW, baseH);
            if (maskData) {
              applyDepthMask(imageData, maskData, depthMask);
            }
          }
        } catch {
          // Mask failed to load; continue without crashing
        }
      }

      onPixels?.(imageData);
      baseCtx.putImageData(imageData, 0, 0);
    }

    return baseCanvas;
  }

  // --- Layered documents -------------------------------------------------------

  /** Which base path renders `state` (see `needsLegacyBase`). */
  private chooseRoute(state: ImageEditorState, region: CropBox, naturalWidth: number, naturalHeight: number): 'legacy' | 'layers' {
    let route: 'legacy' | 'layers';
    if (!state.layers?.length) route = 'legacy';
    else if (this.baseRoute === 'layers') route = 'layers';
    else {
      const stack = { layers: state.layers, outputOpacity: state.outputOpacity ?? 1, legacyOutputBlur: state.legacyOutputBlur };
      const shaped = this.baseRoute === 'legacy' && isLegacyStack(stack);
      route =
        shaped ||
        needsLegacyBase({
          stack,
          region,
          canvas: { width: naturalWidth, height: naturalHeight },
          transform: state.transform,
          sourceOpaque: this.layerSources?.sourceIsOpaque() ?? true,
        })
          ? 'legacy'
          : 'layers';
    }
    this.lastBaseRoute = route;
    return route;
  }

  /** Compositor sources for a `width × height` canvas: layer pixels, depth maps and annotation rasterizing. */
  public compositorSources(width: number, height: number): CompositorSources {
    const host = this.layerSources;
    return {
      width,
      height,
      surfaceOf: host ? (l: PixelLayer) => host.surfaceOf(l) : undefined,
      depthMap: (source) => {
        if (!source.enabled || !source.maskSource) return null;
        return this.depthMaps.get(`${source.maskSource}|${width}x${height}`) ?? null;
      },
      rasterizeAnnotation: (annotation, rect) => this.rasterizeAnnotation(annotation, rect),
      version: `${host?.version() ?? ''}:${this.assetVersion}`,
      globalLight: host?.globalLight?.(),
      pattern: host?.pattern ? (id) => host.pattern!(id) : undefined,
    };
  }

  /** Loads what the compositor reads synchronously: depth maps (at canvas size) and annotation images. */
  /** Loads depth maps and annotation images the compositor reads synchronously. */
  public async prepareLayerAssets(layers: readonly ImageLayer[], width: number, height: number): Promise<void> {
    for (const l of flattenLayers(layers)) {
      const source = l.mask?.source;
      if (source?.enabled && source.maskSource) {
        const key = `${source.maskSource}|${width}x${height}`;
        if (this.depthMaps.has(key)) continue;
        try {
          const maskImg = await this.imageCache.get(source.maskSource);
          const canvas = this.createCanvas(width, height);
          const mctx = canvas.getContext('2d');
          const data = mctx ? (mctx.drawImage(maskImg, 0, 0, width, height), mctx.getImageData?.(0, 0, width, height)) : null;
          if (data) {
            this.depthMaps.set(key, { width, height, data: data.data });
            this.assetVersion++;
          }
        } catch {
          // A depth map that fails to load reveals the layer, as before.
        }
      }
      if (l.type === 'annotation' && l.annotation.type === 'image' && !this.imageCache.peek(l.annotation.src)) {
        try {
          await this.imageCache.get(l.annotation.src);
          this.assetVersion++;
        } catch {
          // Skipped, as a watermark that fails to load always was.
        }
      }
    }
  }

  /** Whether annotation layers can be rasterized here (a 2D canvas with pixel access). */
  public canRasterize(): boolean {
    const ctx = this.createCanvas(1, 1).getContext('2d');
    return Boolean(ctx && typeof ctx.getImageData === 'function');
  }

  /** One annotation drawn into a tile-sized RGBA buffer at `rect` (document space), or `null` without a canvas. */
  private rasterizeAnnotation(annotation: Annotation, rect: CropBox): Uint8ClampedArray | null {
    if (!this.scratch) this.scratch = this.createCanvas(rect.width, rect.height);
    const canvas = this.scratch;
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.getImageData !== 'function') return null;
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.setTransform(1, 0, 0, 1, -rect.x, -rect.y);
      const img = annotation.type === 'image' ? this.imageCache.peek(annotation.src) ?? null : null;
      this.drawAnnotationShape(ctx, annotation, img);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return new Uint8ClampedArray(ctx.getImageData(0, 0, rect.width, rect.height).data);
    } catch {
      return null;
    }
  }

  private putTile(ctx: CanvasRenderingContext2D, data: Uint8ClampedArray, tx: number, ty: number, rect: CropBox): void {
    const ox = tx * TILE - rect.x;
    const oy = ty * TILE - rect.y;
    const x0 = Math.max(0, -ox);
    const y0 = Math.max(0, -oy);
    const x1 = Math.min(TILE, rect.width - ox);
    const y1 = Math.min(TILE, rect.height - oy);
    if (x1 <= x0 || y1 <= y0) return;
    const img = ctx.createImageData(TILE, TILE);
    img.data.set(data);
    ctx.putImageData(img, ox, oy, x0, y0, x1 - x0, y1 - y0);
  }

  /**
   * Brings the viewport's composite canvas (document space, covering `region`) up to date,
   * uploading only the tiles that changed since the last render.
   */
  private updateComposite(
    layers: readonly ImageLayer[],
    region: CropBox,
    width: number,
    height: number,
    options: Pick<RenderOptions, 'dirty' | 'checkpointLayerId'> = {}
  ): CompositeCanvas | null {
    const rect = coveringRect(region);
    let comp = this.comp;
    let fresh = false;
    if (!comp || comp.rect.x !== rect.x || comp.rect.y !== rect.y || comp.rect.width !== rect.width || comp.rect.height !== rect.height) {
      const canvas = this.createCanvas(rect.width, rect.height);
      comp = this.comp = new CompositeCanvas(canvas, rect);
      fresh = true;
    }
    const ctx = comp.canvas.getContext('2d');
    if (!ctx || typeof ctx.createImageData !== 'function') return null;
    let changed = false;
    this.compositor.compositeTiles(layers, rect, this.compositorSources(width, height), (tx, ty, data) => {
      const key = tileKey(tx, ty);
      if (comp!.tiles.get(key) === data) return;
      comp!.tiles.set(key, data);
      comp!.histograms.delete(key);
      this.putTile(ctx, data, tx, ty, rect);
      changed = true;
    }, { checkpointLayerId: options.checkpointLayerId, dirty: fresh ? undefined : options.dirty });
    if (changed) comp.version++;
    comp.region = region;
    return comp;
  }

  /**
   * The base canvas of a layered document: the composite drawn through the base projection (crop,
   * rotation, flips at scale 1), then output opacity and the migrated blur, which run in the output
   * frame. Cached until the composite or those settings change.
   */
  private layeredBase(
    comp: CompositeCanvas | null,
    state: ImageEditorState,
    region: CropBox,
    transform: ImageTransform
  ): { canvas: HTMLCanvasElement; histogram: ImageHistogram | null } | null {
    if (!comp) return null;
    const opacity = state.outputOpacity ?? 1;
    const blur = state.legacyOutputBlur ?? 0;
    const rotated = getRotatedSize(region.width, region.height, transform);
    const baseW = Math.max(1, Math.round(rotated.width));
    const baseH = Math.max(1, Math.round(rotated.height));
    const key = `${comp.version}|${region.x},${region.y},${region.width},${region.height}|${normalizeAngle(transform.rotate)},${transform.flipH},${transform.flipV}|${opacity}|${blur}`;
    if (this.cachedPostCanvas && this.cachedPostKey === key) return { canvas: this.cachedPostCanvas, histogram: this.cachedPostHistogram };
    const canvas =
      this.cachedPostCanvas && this.cachedPostCanvas.width === baseW && this.cachedPostCanvas.height === baseH
        ? this.cachedPostCanvas
        : this.createCanvas(baseW, baseH);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, baseW, baseH);
    ctx.save();
    applyImageProjectionToContext(ctx, baseProjection(region, transform, baseW, baseH));
    ctx.beginPath();
    ctx.rect(region.x, region.y, region.width, region.height);
    ctx.clip();
    ctx.drawImage(comp.canvas, comp.rect.x, comp.rect.y);
    ctx.restore();
    const histogram = this.applyPost(ctx, baseW, baseH, state);
    this.cachedPostCanvas = canvas;
    this.cachedPostKey = key;
    this.cachedPostHistogram = histogram;
    return { canvas, histogram };
  }

  /** Output opacity then the migrated blur, in place on a base canvas; returns its histogram. */
  private applyPost(ctx: CanvasRenderingContext2D, w: number, h: number, state: ImageEditorState): ImageHistogram | null {
    const opacity = state.outputOpacity ?? 1;
    const blur = state.legacyOutputBlur ?? 0;
    if (!(opacity < 1) && !(blur > 0)) return null;
    const data = ctx.getImageData?.(0, 0, w, h);
    if (!data) return null;
    applyOutputStage(data, opacity, blur);
    ctx.putImageData(data, 0, 0);
    return computeHistogram(data);
  }

  private publishHistogram(histogram: ImageHistogram | null): void {
    if (histogram === this.previewHistogram) return;
    this.previewHistogram = histogram;
    this.onPreviewHistogram?.(histogram);
  }

  private quickMaskCache = new WeakMap<SelectionMask, HTMLCanvasElement>();
  private outlineCache = new WeakMap<SelectionMask, Float32Array>();

  /** Rubylith over the unselected area, drawn in natural image space. */
  private drawQuickMask(ctx: CanvasRenderingContext2D, selection: SelectionMask): void {
    let canvas = this.quickMaskCache.get(selection);
    if (!canvas) {
      canvas = this.createCanvas(selection.width, selection.height);
      const mctx = canvas.getContext('2d');
      if (!mctx || typeof mctx.createImageData !== 'function') return;
      const img = mctx.createImageData(selection.width, selection.height);
      img.data.set(quickMaskPixels(selection));
      mctx.putImageData(img, 0, 0);
      this.quickMaskCache.set(selection, canvas);
    }
    ctx.drawImage(canvas, 0, 0, selection.width, selection.height);
  }

  /** Marching ants: a white line under a black dashed one, one screen pixel wide. */
  private drawAnts(ctx: CanvasRenderingContext2D, selection: SelectionMask, scale: number, offset: number): void {
    let segs = this.outlineCache.get(selection);
    if (!segs) {
      segs = selectionOutline(selection);
      this.outlineCache.set(selection, segs);
    }
    if (!segs.length) return;
    const px = 1 / (scale || 1);
    ctx.beginPath();
    for (let i = 0; i < segs.length; i += 4) {
      ctx.moveTo(segs[i], segs[i + 1]);
      ctx.lineTo(segs[i + 2], segs[i + 3]);
    }
    ctx.lineWidth = px;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    if (typeof ctx.setLineDash === 'function') {
      ctx.setLineDash([4 * px, 4 * px]);
      ctx.lineDashOffset = -offset * px;
    }
    ctx.strokeStyle = '#000000';
    ctx.stroke();
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
  }

  private drawDraftPath(ctx: CanvasRenderingContext2D, points: ImagePoint[], scale: number): void {
    const px = 1 / (scale || 1);
    ctx.beginPath();
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.lineWidth = px;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([4 * px, 4 * px]);
    ctx.strokeStyle = '#000000';
    ctx.stroke();
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
  }

  private getSourceId(img: CanvasImageSource): number {
    const key = img as unknown as object;
    let id = this.sourceIds.get(key);
    if (id === undefined) {
      id = ++this.nextSourceId;
      this.sourceIds.set(key, id);
    }
    return id;
  }

  /**
   * Draws an individual annotation onto the canvas.
   */
  public async drawAnnotation(ctx: CanvasRenderingContext2D, ann: Annotation): Promise<void> {
    const blend = normalizeBlendMode(ann.blend);
    if (blend === 'normal') {
      await this.drawAnnotationContent(ctx, ann);
      return;
    }
    const op = canvasCompositeOperation(blend);
    if (op) {
      ctx.save();
      ctx.globalCompositeOperation = op;
      await this.drawAnnotationContent(ctx, ann);
      ctx.restore();
      return;
    }
    if (!(await this.drawAnnotationBlended(ctx, ann))) {
      // No pixel access (e.g. a tainted or headless canvas): draw it normally.
      await this.drawAnnotationContent(ctx, ann);
    }
  }

  /**
   * Scalar fallback for blend modes the canvas cannot composite (Photoshop soft light, linear /
   * vivid / pin light, hard mix, subtract, divide, darker / lighter colour, linear burn / dodge):
   * draws the annotation on a same-size layer with the same transform, blends it into a copy of
   * the target's pixels with `blendImageData`, and copies the result back inside the current clip.
   */
  private async drawAnnotationBlended(ctx: CanvasRenderingContext2D, ann: Annotation): Promise<boolean> {
    const canvas = ctx.canvas as HTMLCanvasElement | undefined;
    if (!canvas || typeof ctx.getTransform !== 'function' || typeof ctx.getImageData !== 'function') return false;
    const w = canvas.width;
    const h = canvas.height;
    const layer = this.createCanvas(w, h);
    const lctx = layer.getContext('2d');
    if (!lctx) return false;
    try {
      lctx.setTransform(ctx.getTransform());
      lctx.globalAlpha = ctx.globalAlpha;
      await this.drawAnnotationContent(lctx, ann);
      const backdrop = ctx.getImageData(0, 0, w, h);
      const source = lctx.getImageData(0, 0, w, h);
      if (!backdrop || !source) return false;
      blendImageData(backdrop, source, normalizeBlendMode(ann.blend));
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.putImageData(backdrop, 0, 0);
    } catch {
      return false;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
    return true;
  }

  private async drawAnnotationContent(ctx: CanvasRenderingContext2D, ann: Annotation): Promise<void> {
    let img: CanvasImageSource | null = null;
    if (ann.type === 'image') {
      try {
        img = await this.imageCache.get(ann.src);
      } catch {
        // Skip if watermark image failed to load
      }
    }
    this.drawAnnotationShape(ctx, ann, img);
  }

  /** Draws an annotation synchronously; an image annotation draws `img` (skipped when `null`). */
  public drawAnnotationShape(ctx: CanvasRenderingContext2D, ann: Annotation, img: CanvasImageSource | null): void {
    ctx.save();
    if (ann.opacity !== undefined) {
      ctx.globalAlpha = ann.opacity;
    }

    if (ann.rotation) {
      ctx.translate(ann.x, ann.y);
      ctx.rotate((ann.rotation * Math.PI) / 180);
      ctx.translate(-ann.x, -ann.y);
    }

    switch (ann.type) {
      case 'pen': {
        const pen = ann as PenAnnotation;
        if (pen.points.length > 0) {
          ctx.beginPath();
          ctx.strokeStyle = pen.strokeColor;
          ctx.lineWidth = pen.strokeWidth;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.moveTo(pen.points[0].x, pen.points[0].y);
          for (let i = 1; i < pen.points.length; i++) {
            ctx.lineTo(pen.points[i].x, pen.points[i].y);
          }
          ctx.stroke();
        }
        break;
      }

      case 'rect': {
        const rect = ann as RectAnnotation;
        ctx.strokeStyle = rect.strokeColor;
        ctx.lineWidth = rect.strokeWidth;
        if (rect.fillColor) {
          ctx.fillStyle = rect.fillColor;
          ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        }
        if (rect.strokeWidth > 0) {
          ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        }
        break;
      }

      case 'circle': {
        const circle = ann as CircleAnnotation;
        ctx.beginPath();
        ctx.strokeStyle = circle.strokeColor;
        ctx.lineWidth = circle.strokeWidth;
        ctx.ellipse(circle.x, circle.y, Math.abs(circle.radiusX), Math.abs(circle.radiusY), 0, 0, 2 * Math.PI);
        if (circle.fillColor) {
          ctx.fillStyle = circle.fillColor;
          ctx.fill();
        }
        if (circle.strokeWidth > 0) {
          ctx.stroke();
        }
        break;
      }

      case 'arrow': {
        const arrow = ann as ArrowAnnotation;
        ctx.strokeStyle = arrow.strokeColor;
        ctx.fillStyle = arrow.strokeColor;
        ctx.lineWidth = arrow.strokeWidth;

        // Line body
        ctx.beginPath();
        ctx.moveTo(arrow.x, arrow.y);
        ctx.lineTo(arrow.endX, arrow.endY);
        ctx.stroke();

        // Arrow head
        const angle = Math.atan2(arrow.endY - arrow.y, arrow.endX - arrow.x);
        const headLen = Math.max(12, arrow.strokeWidth * 3);
        ctx.beginPath();
        ctx.moveTo(arrow.endX, arrow.endY);
        ctx.lineTo(
          arrow.endX - headLen * Math.cos(angle - Math.PI / 6),
          arrow.endY - headLen * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
          arrow.endX - headLen * Math.cos(angle + Math.PI / 6),
          arrow.endY - headLen * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fill();
        break;
      }

      case 'line': {
        const line = ann as LineAnnotation;
        ctx.beginPath();
        ctx.strokeStyle = line.strokeColor;
        ctx.lineWidth = line.strokeWidth;
        ctx.moveTo(line.x, line.y);
        ctx.lineTo(line.endX, line.endY);
        ctx.stroke();
        break;
      }

      case 'text': {
        const textAnn = ann as TextAnnotation;
        ctx.font = `${textAnn.fontWeight || 'normal'} ${textAnn.fontSize}px ${textAnn.fontFamily || 'sans-serif'}`;
        ctx.fillStyle = textAnn.color;
        ctx.textBaseline = 'top';
        ctx.fillText(textAnn.text, textAnn.x, textAnn.y);
        break;
      }

      case 'image': {
        const imgAnn = ann as ImageAnnotation;
        if (img) ctx.drawImage(img, imgAnn.x, imgAnn.y, imgAnn.width, imgAnn.height);
        break;
      }
    }

    ctx.restore();
  }

  /**
   * Draws selection box around active annotation.
   */
  private drawAnnotationSelection(ctx: CanvasRenderingContext2D, ann: Annotation): void {
    ctx.save();
    ctx.strokeStyle = '#3b82f6'; // Tailwind blue-500
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);

    const bounds = getAnnotationBounds(ann);
    const pad = 4;
    ctx.strokeRect(bounds.x - pad, bounds.y - pad, bounds.width + pad * 2, bounds.height + pad * 2);

    // Draw handles
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#3b82f6';
    ctx.setLineDash([]);
    const handleSize = 6;
    const corners = [
      { x: bounds.x - pad, y: bounds.y - pad },
      { x: bounds.x + bounds.width + pad, y: bounds.y - pad },
      { x: bounds.x - pad, y: bounds.y + bounds.height + pad },
      { x: bounds.x + bounds.width + pad, y: bounds.y + bounds.height + pad },
    ];
    for (const c of corners) {
      ctx.fillRect(c.x - handleSize / 2, c.y - handleSize / 2, handleSize, handleSize);
      ctx.strokeRect(c.x - handleSize / 2, c.y - handleSize / 2, handleSize, handleSize);
    }

    ctx.restore();
  }

  /** @deprecated Use the standalone `getAnnotationBounds` from the geometry module. */
  public getAnnotationBounds(ann: Annotation): { x: number; y: number; width: number; height: number } {
    return getAnnotationBounds(ann);
  }

  /**
   * Draws a rule-of-thirds crop grid overlay. All rectangles come from
   * `getViewportMetrics`, i.e. the crop box projected through rotation/flip.
   */
  private drawCropOverlay(ctx: CanvasRenderingContext2D, metrics: ViewportMetrics): void {
    const { imageRect, cropRect } = metrics;
    if (!cropRect) return;

    const imgL = imageRect.x;
    const imgT = imageRect.y;
    const imgR = imageRect.x + imageRect.width;
    const imgB = imageRect.y + imageRect.height;
    const startX = cropRect.x;
    const startY = cropRect.y;
    const cropBoxW = cropRect.width;
    const cropBoxH = cropRect.height;

    ctx.save();

    // Dark semi-transparent scrim outside crop box (within the image)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    // Top
    ctx.fillRect(imgL, imgT, imageRect.width, Math.max(0, startY - imgT));
    // Bottom
    ctx.fillRect(imgL, startY + cropBoxH, imageRect.width, Math.max(0, imgB - (startY + cropBoxH)));
    // Left
    ctx.fillRect(imgL, startY, Math.max(0, startX - imgL), cropBoxH);
    // Right
    ctx.fillRect(startX + cropBoxW, startY, Math.max(0, imgR - (startX + cropBoxW)), cropBoxH);

    // Crop border
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(startX, startY, cropBoxW, cropBoxH);

    // Rule of thirds lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // Vertical lines
    ctx.moveTo(startX + cropBoxW / 3, startY);
    ctx.lineTo(startX + cropBoxW / 3, startY + cropBoxH);
    ctx.moveTo(startX + (cropBoxW * 2) / 3, startY);
    ctx.lineTo(startX + (cropBoxW * 2) / 3, startY + cropBoxH);
    // Horizontal lines
    ctx.moveTo(startX, startY + cropBoxH / 3);
    ctx.lineTo(startX + cropBoxW, startY + cropBoxH / 3);
    ctx.moveTo(startX, startY + (cropBoxH * 2) / 3);
    ctx.lineTo(startX + cropBoxW, startY + (cropBoxH * 2) / 3);
    ctx.stroke();

    // Corner and edge handles
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#0284c7';
    ctx.lineWidth = 1.5;
    const handleSize = 10;
    const handles = [
      // Corners
      { x: startX, y: startY },
      { x: startX + cropBoxW, y: startY },
      { x: startX, y: startY + cropBoxH },
      { x: startX + cropBoxW, y: startY + cropBoxH },
      // Edges
      { x: startX + cropBoxW / 2, y: startY },
      { x: startX + cropBoxW / 2, y: startY + cropBoxH },
      { x: startX, y: startY + cropBoxH / 2 },
      { x: startX + cropBoxW, y: startY + cropBoxH / 2 },
    ];
    for (const h of handles) {
      ctx.fillRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
      ctx.strokeRect(h.x - handleSize / 2, h.y - handleSize / 2, handleSize, handleSize);
    }

    ctx.restore();
  }

  private drawFittedImage(
    ctx: CanvasRenderingContext2D,
    img: CanvasImageSource,
    imgW: number,
    imgH: number,
    vpW: number,
    vpH: number,
    zoom: number,
    pan: { x: number; y: number },
    fit: ImageEditorFit = 'margin'
  ): void {
    ctx.save();
    ctx.translate(vpW / 2 + pan.x, vpH / 2 + pan.y);
    ctx.scale(zoom, zoom);
    const fitScale =
      fit === 'contain'
        ? Math.min(vpW / imgW, vpH / imgH)
        : Math.min((vpW * 0.85) / imgW, (vpH * 0.85) / imgH, 1);
    const renderW = imgW * fitScale;
    const renderH = imgH * fitScale;
    ctx.drawImage(img, -renderW / 2, -renderH / 2, renderW, renderH);
    ctx.restore();
  }

  /**
   * Performs an export render at exact pixel dimensions without zoom/pan viewport offsets.
   */
  public async renderExport(
    imageSource: CanvasImageSource | string,
    state: ImageEditorState,
    options: ExportOptions = {}
  ): Promise<HTMLCanvasElement> {
    let img: CanvasImageSource;
    if (typeof imageSource === 'string') {
      img = await this.imageCache.get(imageSource);
    } else {
      img = imageSource;
    }

    const { width: naturalWidth, height: naturalHeight } = getSourceSize(img);
    const { crop, transform, annotations } = state;

    const region = crop
      ? clampCropToImage(crop, naturalWidth, naturalHeight)
      : { x: 0, y: 0, width: naturalWidth, height: naturalHeight };
    const rotated = getRotatedSize(region.width, region.height, transform);
    const baseW = Math.max(1, Math.round(rotated.width));
    const baseH = Math.max(1, Math.round(rotated.height));

    const exportW = options.width || baseW;
    const exportH = options.height || baseH;

    const exportCanvas = this.createCanvas(exportW, exportH);
    const ctx = exportCanvas.getContext('2d');
    if (!ctx) return exportCanvas;

    let overlay: Annotation[] = annotations;
    let baseCanvas: HTMLCanvasElement;
    // A render of chosen layers (`layerIds`) always composites them; the legacy views describe the whole stack.
    if (!options.layerIds && this.chooseRoute(state, region, naturalWidth, naturalHeight) === 'legacy') {
      baseCanvas = await this.renderBaseImage(img, naturalWidth, naturalHeight, region, transform, state);
    } else {
      const layers = options.includeAnnotations === false ? removeAnnotationLayers(state.layers) : state.layers;
      const split = splitOverlayAnnotations(layers);
      overlay = split.overlay.map((l) => l.annotation);
      await this.prepareLayerAssets(split.composite, naturalWidth, naturalHeight);
      const rect = coveringRect(region);
      const comp = this.createCanvas(rect.width, rect.height);
      const cctx = comp.getContext('2d');
      if (cctx && typeof cctx.createImageData === 'function') {
        this.exportCompositor.compositeTiles(split.composite, rect, this.compositorSources(naturalWidth, naturalHeight), (tx, ty, data) => {
          this.putTile(cctx, data, tx, ty, rect);
        });
      }
      baseCanvas = this.createCanvas(baseW, baseH);
      const bctx = baseCanvas.getContext('2d');
      if (bctx) {
        bctx.save();
        applyImageProjectionToContext(bctx, baseProjection(region, transform, baseW, baseH));
        bctx.beginPath();
        bctx.rect(region.x, region.y, region.width, region.height);
        bctx.clip();
        bctx.drawImage(comp, rect.x, rect.y);
        bctx.restore();
        this.applyPost(bctx, baseW, baseH, state);
      }
    }

    // Scale to target export dimensions
    ctx.drawImage(baseCanvas, 0, 0, baseW, baseH, 0, 0, exportW, exportH);

    // Draw annotations (natural image space) through the same rotate/flip/crop projection
    if (options.includeAnnotations !== false && overlay.length > 0) {
      ctx.save();
      ctx.scale(exportW / baseW, exportH / baseH);
      applyImageProjectionToContext(ctx, getBaseProjection(region, transform, baseW, baseH));
      for (const ann of overlay) {
        await this.drawAnnotation(ctx, ann);
      }
      ctx.restore();
    }

    return exportCanvas;
  }

  /**
   * Generates a strictly binary mask canvas (white = area to regenerate, black = keep) in
   * natural image pixel space of the current source image — the same space the crop box
   * and annotations are stored in. Pair it with `toSourceDataURL()` for AI inpainting.
   */
  public async renderMask(
    state: ImageEditorState,
    options?: { useAnnotations?: boolean; useCrop?: boolean; useSelection?: boolean }
  ): Promise<HTMLCanvasElement> {
    const naturalWidth = Math.max(1, Math.round(state.imageDimensions.width));
    const naturalHeight = Math.max(1, Math.round(state.imageDimensions.height));
    const maskCanvas = this.createCanvas(naturalWidth, naturalHeight);
    const ctx = maskCanvas.getContext('2d');
    if (!ctx) return maskCanvas;

    // Background: unmasked (black)
    ctx.fillStyle = MASK_BLACK;
    ctx.fillRect(0, 0, naturalWidth, naturalHeight);

    const useCrop = options?.useCrop ?? true;
    const useAnnotations = options?.useAnnotations ?? true;

    // Crop box mask (if active)
    if (useCrop && state.crop) {
      ctx.fillStyle = MASK_WHITE;
      ctx.fillRect(state.crop.x, state.crop.y, state.crop.width, state.crop.height);
    }

    // Annotation masks (drawn in solid white, never in annotation colours)
    if (useAnnotations && state.annotations.length > 0) {
      for (const ann of state.annotations) {
        this.drawAnnotationMask(ctx, ann);
      }
    }

    // Anti-aliased edges produce grey pixels: threshold to pure black/white.
    const imageData = ctx.getImageData?.(0, 0, naturalWidth, naturalHeight);
    // The active selection (same natural space) is added to the mask.
    const selection =
      (options?.useSelection ?? true) &&
      state.selection?.bounds &&
      state.selection.width === naturalWidth &&
      state.selection.height === naturalHeight
        ? state.selection
        : null;
    if (imageData) {
      const d = imageData.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i] >= 128 || (selection !== null && selection.data[i >> 2] >= 128) ? 255 : 0;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
        d[i + 3] = 255;
      }
      ctx.putImageData(imageData, 0, 0);
    }

    return maskCanvas;
  }

  private drawAnnotationMask(ctx: CanvasRenderingContext2D, ann: Annotation): void {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = MASK_WHITE;
    ctx.strokeStyle = MASK_WHITE;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (ann.rotation) {
      ctx.translate(ann.x, ann.y);
      ctx.rotate((ann.rotation * Math.PI) / 180);
      ctx.translate(-ann.x, -ann.y);
    }

    switch (ann.type) {
      case 'pen': {
        if (ann.points.length > 0) {
          ctx.beginPath();
          ctx.lineWidth = Math.max(ann.strokeWidth || 0, 8);
          ctx.moveTo(ann.points[0].x, ann.points[0].y);
          for (let i = 1; i < ann.points.length; i++) {
            ctx.lineTo(ann.points[i].x, ann.points[i].y);
          }
          ctx.stroke();
        }
        break;
      }
      case 'circle': {
        ctx.beginPath();
        ctx.ellipse(ann.x, ann.y, Math.abs(ann.radiusX), Math.abs(ann.radiusY), 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'arrow':
      case 'line': {
        ctx.beginPath();
        ctx.lineWidth = Math.max(ann.strokeWidth || 0, 8);
        ctx.moveTo(ann.x, ann.y);
        ctx.lineTo(ann.endX, ann.endY);
        ctx.stroke();
        break;
      }
      case 'rect':
      case 'image':
      case 'text': {
        const b = getAnnotationBounds(ann);
        ctx.fillRect(b.x, b.y, b.width, b.height);
        break;
      }
    }
    ctx.restore();
  }
}

const MASK_WHITE = '#ffffff';
const MASK_BLACK = '#000000';

function getSourceSize(img: CanvasImageSource, fallbackW = 800, fallbackH = 600): { width: number; height: number } {
  const anyImg = img as any;
  return {
    width: anyImg.naturalWidth || anyImg.videoWidth || anyImg.width || fallbackW,
    height: anyImg.naturalHeight || anyImg.videoHeight || anyImg.height || fallbackH,
  };
}

function getBaseProjection(region: CropBox, transform: ImageTransform, baseW: number, baseH: number): ImageProjection {
  return {
    region,
    angle: normalizeAngle(transform.rotate),
    flipH: transform.flipH,
    flipV: transform.flipV,
    scale: 1,
    originX: baseW / 2,
    originY: baseH / 2,
  };
}

/** What the renderer asks its host (the controller) about layer pixels. */
export interface LayerSourcesHost {
  surfaceOf(layer: PixelLayer): PixelSurface;
  sourceIsOpaque(): boolean;
  version(): string;
  /** The document's global light for layer effects. */
  globalLight?(): GlobalLight | undefined;
  /** A document pattern for pattern effects (built-in patterns are found without it). */
  pattern?(id: string): EffectPattern | null;
}

/** The viewport's composite canvas and what each of its tiles holds. */
class CompositeCanvas {
  readonly tiles = new Map<TileKey, Uint8ClampedArray>();
  readonly histograms = new Map<TileKey, ImageHistogram>();
  version = 0;
  region: CropBox;
  constructor(readonly canvas: HTMLCanvasElement, readonly rect: CropBox) {
    this.region = rect;
  }

  /** Histogram of the composite over the region (per-tile parts are cached). */
  histogram(): ImageHistogram | null {
    if (!this.tiles.size) return null;
    const r = coveringRect(this.region);
    const parts: ImageHistogram[] = [];
    for (const [key, data] of this.tiles) {
      let h = this.histograms.get(key);
      if (!h) {
        const tx = (key % 65536) - 32768;
        const ty = Math.floor(key / 65536) - 32768;
        const x0 = Math.max(r.x, tx * TILE);
        const y0 = Math.max(r.y, ty * TILE);
        const x1 = Math.min(r.x + r.width, tx * TILE + TILE);
        const y1 = Math.min(r.y + r.height, ty * TILE + TILE);
        h = emptyHistogram();
        if (x1 > x0 && y1 > y0) addToHistogram(h, data, TILE, { x: x0 - tx * TILE, y: y0 - ty * TILE, width: x1 - x0, height: y1 - y0 });
        this.histograms.set(key, h);
      }
      parts.push(h);
    }
    return sumHistograms(parts);
  }
}

function removeAnnotationLayers(layers: readonly ImageLayer[]): ImageLayer[] {
  const out: ImageLayer[] = [];
  for (const l of layers) {
    if (l.type === 'annotation') continue;
    out.push(l.type === 'group' ? { ...l, children: removeAnnotationLayers(l.children) } : l);
  }
  return out;
}
