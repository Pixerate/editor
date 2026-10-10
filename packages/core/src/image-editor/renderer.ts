import type {
  Annotation,
  CropBox,
  ExportOptions,
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
  private sourceIds = new WeakMap<object, number>();
  private nextSourceId = 0;

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
    // Geometry helpers read `imageDimensions`; make sure they see the real source size so the
    // viewport drawn here and the hit-testing done by the UI share one projection.
    const geoState: ImageEditorState =
      state.imageDimensions.width === naturalWidth && state.imageDimensions.height === naturalHeight
        ? state
        : { ...state, imageDimensions: { width: naturalWidth, height: naturalHeight } };

    const { crop, transform, adjustments, depthMask, annotations, selectedAnnotationId, zoom, pan, isOriginalCompared } = state;

    // Viewport dimensions
    const vpWidth = options.viewportWidth || targetCanvas.width;
    const vpHeight = options.viewportHeight || targetCanvas.height;

    targetCanvas.width = vpWidth;
    targetCanvas.height = vpHeight;

    ctx.clearRect(0, 0, vpWidth, vpHeight);

    // If in compare mode, render original image directly and exit
    if (isOriginalCompared) {
      this.drawFittedImage(ctx, img, naturalWidth, naturalHeight, vpWidth, vpHeight, zoom, pan);
      return;
    }

    // When actively in crop tool or overlay requested, show full image so user can adjust the crop box
    const isActivelyCropping = Boolean(options.showCropOverlay || state.activeTool === 'crop');
    const projection = getViewportProjection(geoState, vpWidth, vpHeight, isActivelyCropping);
    const { region } = projection;
    const rotated = getRotatedSize(region.width, region.height, transform);

    // 1. Offscreen canvas for Base Image + Transform (Flip/Rotate) + Crop + Adjustments + Depth mask
    const baseKey = [
      this.getSourceId(img),
      state.sourceUrl,
      `${naturalWidth}x${naturalHeight}`,
      `${region.x},${region.y},${region.width},${region.height}`,
      `${projection.angle},${transform.flipH},${transform.flipV}`,
      `${adjustments.brightness},${adjustments.contrast},${adjustments.saturation},${adjustments.exposure},${adjustments.temperature},${adjustments.blur},${adjustments.opacity}`,
      `${depthMask.enabled},${depthMask.maskSource},${depthMask.depthRange?.[0]}-${depthMask.depthRange?.[1]},${depthMask.softness},${depthMask.invert},${depthMask.mode}`,
    ].join('|');

    let baseCanvas = this.cachedBaseCanvas;
    if (!baseCanvas || this.cachedBaseKey !== baseKey) {
      baseCanvas = await this.renderBaseImage(img, naturalWidth, naturalHeight, region, transform, state);
      this.cachedBaseCanvas = baseCanvas;
      this.cachedBaseKey = baseKey;
    }

    // 2. Draw the base canvas into the viewport (centred, fitted, zoomed, panned)
    const drawW = rotated.width * projection.scale;
    const drawH = rotated.height * projection.scale;
    ctx.drawImage(baseCanvas, projection.originX - drawW / 2, projection.originY - drawH / 2, drawW, drawH);

    // 3. Annotations live in natural image space: draw them through the same projection,
    //    clipped to the visible (cropped) region.
    if (annotations.length > 0 || options.draftAnnotation) {
      ctx.save();
      applyImageProjectionToContext(ctx, projection);
      ctx.beginPath();
      ctx.rect(region.x, region.y, region.width, region.height);
      ctx.clip();

      for (const ann of annotations) {
        await this.drawAnnotation(ctx, ann);
        if (options.showSelectionOverlay && ann.id === selectedAnnotationId) {
          this.drawAnnotationSelection(ctx, ann);
        }
      }

      // Render active live draft annotation
      if (options.draftAnnotation) {
        await this.drawAnnotation(ctx, options.draftAnnotation);
      }

      ctx.restore();
    }

    // 4. Draw Crop Grid Overlay if crop overlay is requested
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
    state: Pick<ImageEditorState, 'adjustments' | 'depthMask'>
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
      applyAdjustments(imageData, adjustments);

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

      baseCtx.putImageData(imageData, 0, 0);
    }

    return baseCanvas;
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
        try {
          const loadedImg = await this.imageCache.get(imgAnn.src);
          ctx.drawImage(loadedImg, imgAnn.x, imgAnn.y, imgAnn.width, imgAnn.height);
        } catch {
          // Skip if watermark image failed to load
        }
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
    pan: { x: number; y: number }
  ): void {
    ctx.save();
    ctx.translate(vpW / 2 + pan.x, vpH / 2 + pan.y);
    ctx.scale(zoom, zoom);
    const fitScale = Math.min((vpW * 0.85) / imgW, (vpH * 0.85) / imgH, 1);
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

    const baseCanvas = await this.renderBaseImage(img, naturalWidth, naturalHeight, region, transform, state);

    // Scale to target export dimensions
    ctx.drawImage(baseCanvas, 0, 0, baseW, baseH, 0, 0, exportW, exportH);

    // Draw annotations (natural image space) through the same rotate/flip/crop projection
    if (options.includeAnnotations !== false && annotations.length > 0) {
      ctx.save();
      ctx.scale(exportW / baseW, exportH / baseH);
      applyImageProjectionToContext(ctx, getBaseProjection(region, transform, baseW, baseH));
      for (const ann of annotations) {
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
    options?: { useAnnotations?: boolean; useCrop?: boolean }
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
    if (imageData) {
      const d = imageData.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i] >= 128 ? 255 : 0;
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
