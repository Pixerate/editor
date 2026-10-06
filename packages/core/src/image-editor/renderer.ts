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

    const naturalWidth = (img as any).naturalWidth || (img as any).videoWidth || (img as any).width || 800;
    const naturalHeight = (img as any).naturalHeight || (img as any).videoHeight || (img as any).height || 600;

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

    // Determine working base dimensions based on crop or natural
    // When actively in crop tool or overlay requested, show full image so user can adjust the crop box
    const isActivelyCropping = Boolean(options.showCropOverlay || state.activeTool === 'crop');
    const cropX = (!isActivelyCropping && crop) ? Math.max(0, crop.x) : 0;
    const cropY = (!isActivelyCropping && crop) ? Math.max(0, crop.y) : 0;
    const cropW = (!isActivelyCropping && crop) ? Math.min(naturalWidth - cropX, crop.width) : naturalWidth;
    const cropH = (!isActivelyCropping && crop) ? Math.min(naturalHeight - cropY, crop.height) : naturalHeight;

    const angle = ((transform.rotate % 360) + 360) % 360;
    const isSwapped = angle === 90 || angle === 270;
    const baseW = isSwapped ? cropH : cropW;
    const baseH = isSwapped ? cropW : cropH;

    // 1. Offscreen canvas for Base Image + Transform (Flip/Rotate) + Crop + Adjustments
    const baseKey = `${state.sourceUrl}-${naturalWidth}x${naturalHeight}-${cropX},${cropY},${cropW},${cropH}-${angle},${transform.flipH},${transform.flipV}-${adjustments.brightness},${adjustments.contrast},${adjustments.saturation},${adjustments.exposure},${adjustments.temperature},${adjustments.blur},${adjustments.opacity}-${depthMask.enabled},${depthMask.depthRange?.[0]}-${depthMask.depthRange?.[1]},${depthMask.softness},${depthMask.invert},${depthMask.mode}`;

    let baseCanvas = this.cachedBaseCanvas;
    if (!baseCanvas || this.cachedBaseKey !== baseKey) {
      baseCanvas = this.createCanvas(baseW, baseH);
      const baseCtx = baseCanvas.getContext('2d');

      if (baseCtx) {
        baseCtx.save();

        // Handle Flip & Rotate
        const rad = (angle * Math.PI) / 180;
        baseCtx.translate(baseW / 2, baseH / 2);
        baseCtx.rotate(rad);
        baseCtx.scale(transform.flipH ? -1 : 1, transform.flipV ? -1 : 1);

        // Draw the cropped portion centered
        baseCtx.drawImage(
          img,
          cropX, cropY, cropW, cropH,
          -cropW / 2, -cropH / 2, cropW, cropH
        );

        baseCtx.restore();

        // 2. Pixel adjustments & Depth Masking
        const imageData = baseCtx.getImageData(0, 0, baseW, baseH);
        if (imageData) {
          applyAdjustments(imageData, adjustments);

          if (depthMask.enabled && depthMask.maskSource) {
            try {
              const maskImg = await this.imageCache.get(depthMask.maskSource);
              const maskCanvas = this.createCanvas(baseW, baseH);
              const maskCtx = maskCanvas.getContext('2d');
              if (maskCtx) {
                maskCtx.drawImage(maskImg, cropX, cropY, cropW, cropH, 0, 0, baseW, baseH);
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
      }
      this.cachedBaseCanvas = baseCanvas;
      this.cachedBaseKey = baseKey;
    }

    // 3. Render base canvas onto target canvas with viewport zoom & pan
    ctx.save();
    // Center of canvas
    ctx.translate(vpWidth / 2 + pan.x, vpHeight / 2 + pan.y);
    ctx.scale(zoom, zoom);

    // Calculate fitted dimensions
    const fitScale = Math.min((vpWidth * 0.85) / baseW, (vpHeight * 0.85) / baseH, 1);
    const renderW = baseW * fitScale;
    const renderH = baseH * fitScale;

    // Draw base image
    ctx.drawImage(baseCanvas, -renderW / 2, -renderH / 2, renderW, renderH);

    // 4. Render Annotations scaled to fit image space
    const scaleFactor = fitScale;
    ctx.save();
    ctx.translate(-renderW / 2, -renderH / 2);
    ctx.scale(scaleFactor, scaleFactor);

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

    ctx.restore();

    // 5. Draw Crop Grid Overlay if crop overlay is requested
    const isCroppingActive = Boolean(options.showCropOverlay || state.activeTool === 'crop');
    const activeCrop =
      (options.draftCrop !== undefined && options.draftCrop !== null)
        ? options.draftCrop
        : (crop ?? (isCroppingActive ? {
            x: 0,
            y: 0,
            width: naturalWidth,
            height: naturalHeight,
          } : null));

    if (isCroppingActive && activeCrop) {
      this.drawCropOverlay(ctx, state, vpWidth, vpHeight, naturalWidth, naturalHeight, activeCrop);
    }
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

    const bounds = this.getAnnotationBounds(ann);
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

  public getAnnotationBounds(ann: Annotation): { x: number; y: number; width: number; height: number } {
    switch (ann.type) {
      case 'rect':
        return { x: ann.x, y: ann.y, width: ann.width, height: ann.height };
      case 'circle':
        return {
          x: ann.x - Math.abs(ann.radiusX),
          y: ann.y - Math.abs(ann.radiusY),
          width: Math.abs(ann.radiusX) * 2,
          height: Math.abs(ann.radiusY) * 2,
        };
      case 'arrow':
      case 'line': {
        const minX = Math.min(ann.x, ann.endX);
        const minY = Math.min(ann.y, ann.endY);
        return {
          x: minX,
          y: minY,
          width: Math.max(Math.abs(ann.endX - ann.x), 10),
          height: Math.max(Math.abs(ann.endY - ann.y), 10),
        };
      }
      case 'pen': {
        if (!ann.points.length) return { x: ann.x, y: ann.y, width: 0, height: 0 };
        let minX = ann.points[0].x, maxX = ann.points[0].x;
        let minY = ann.points[0].y, maxY = ann.points[0].y;
        for (const pt of ann.points) {
          if (pt.x < minX) minX = pt.x;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.y > maxY) maxY = pt.y;
        }
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      }
      case 'text':
        return {
          x: ann.x,
          y: ann.y,
          width: (ann.text.length * ann.fontSize * 0.6),
          height: ann.fontSize * 1.2,
        };
      case 'image':
        return { x: ann.x, y: ann.y, width: ann.width, height: ann.height };
    }
  }

  /**
   * Draws a rule-of-thirds crop grid overlay.
   */
  private drawCropOverlay(
    ctx: CanvasRenderingContext2D,
    state: ImageEditorState,
    vpWidth: number,
    vpHeight: number,
    imgWidth: number,
    imgHeight: number,
    cropOverride?: CropBox | null
  ): void {
    const crop =
      (cropOverride !== undefined && cropOverride !== null)
        ? cropOverride
        : (state.crop ?? {
            x: 0,
            y: 0,
            width: imgWidth,
            height: imgHeight,
          });
    if (!crop) return;

    const { transform, pan, zoom } = state;
    const angle = ((transform.rotate % 360) + 360) % 360;
    const isSwapped = angle === 90 || angle === 270;
    const baseW = isSwapped ? imgHeight : imgWidth;
    const baseH = isSwapped ? imgWidth : imgHeight;

    ctx.save();
    ctx.translate(vpWidth / 2 + pan.x, vpHeight / 2 + pan.y);
    ctx.scale(zoom, zoom);

    const fitScale = Math.min((vpWidth * 0.85) / baseW, (vpHeight * 0.85) / baseH, 1);
    const renderW = baseW * fitScale;
    const renderH = baseH * fitScale;

    const startX = -renderW / 2 + (crop.x / imgWidth) * renderW;
    const startY = -renderH / 2 + (crop.y / imgHeight) * renderH;
    const cropBoxW = (crop.width / imgWidth) * renderW;
    const cropBoxH = (crop.height / imgHeight) * renderH;

    // Dark semi-transparent scrim outside crop box
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    // Top
    ctx.fillRect(-renderW / 2, -renderH / 2, renderW, startY - (-renderH / 2));
    // Bottom
    ctx.fillRect(-renderW / 2, startY + cropBoxH, renderW, renderH / 2 - (startY + cropBoxH));
    // Left
    ctx.fillRect(-renderW / 2, startY, startX - (-renderW / 2), cropBoxH);
    // Right
    ctx.fillRect(startX + cropBoxW, startY, renderW / 2 - (startX + cropBoxW), cropBoxH);

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

    const naturalWidth = (img as any).naturalWidth || (img as any).videoWidth || (img as any).width || 800;
    const naturalHeight = (img as any).naturalHeight || (img as any).videoHeight || (img as any).height || 600;

    const { crop, transform, adjustments, depthMask, annotations } = state;

    const cropX = crop ? Math.max(0, crop.x) : 0;
    const cropY = crop ? Math.max(0, crop.y) : 0;
    const cropW = crop ? Math.min(naturalWidth - cropX, crop.width) : naturalWidth;
    const cropH = crop ? Math.min(naturalHeight - cropY, crop.height) : naturalHeight;

    const angle = ((transform.rotate % 360) + 360) % 360;
    const isSwapped = angle === 90 || angle === 270;
    const baseW = isSwapped ? cropH : cropW;
    const baseH = isSwapped ? cropW : cropH;

    const exportW = options.width || baseW;
    const exportH = options.height || baseH;

    const exportCanvas = this.createCanvas(exportW, exportH);
    const ctx = exportCanvas.getContext('2d');
    if (!ctx) return exportCanvas;

    // Draw transformed base image
    const intermediateCanvas = this.createCanvas(baseW, baseH);
    const interCtx = intermediateCanvas.getContext('2d');
    if (interCtx) {
      interCtx.save();
      const rad = (angle * Math.PI) / 180;
      interCtx.translate(baseW / 2, baseH / 2);
      interCtx.rotate(rad);
      interCtx.scale(transform.flipH ? -1 : 1, transform.flipV ? -1 : 1);
      interCtx.drawImage(img, cropX, cropY, cropW, cropH, -cropW / 2, -cropH / 2, cropW, cropH);
      interCtx.restore();

      // Apply adjustments
      const imageData = interCtx.getImageData(0, 0, baseW, baseH);
      if (imageData) {
        applyAdjustments(imageData, adjustments);

        if (depthMask.enabled && depthMask.maskSource) {
          try {
            const maskImg = await this.imageCache.get(depthMask.maskSource);
            const maskCanvas = this.createCanvas(baseW, baseH);
            const maskCtx = maskCanvas.getContext('2d');
            if (maskCtx) {
              maskCtx.drawImage(maskImg, cropX, cropY, cropW, cropH, 0, 0, baseW, baseH);
              const maskData = maskCtx.getImageData(0, 0, baseW, baseH);
              if (maskData) {
                applyDepthMask(imageData, maskData, depthMask);
              }
            }
          } catch {
            // Mask skip
          }
        }

        interCtx.putImageData(imageData, 0, 0);
      }
    }

    // Scale to target export dimensions
    ctx.drawImage(intermediateCanvas, 0, 0, baseW, baseH, 0, 0, exportW, exportH);

    // Draw annotations if included
    if (options.includeAnnotations !== false && annotations.length > 0) {
      const annScaleX = exportW / baseW;
      const annScaleY = exportH / baseH;
      ctx.save();
      ctx.scale(annScaleX, annScaleY);
      for (const ann of annotations) {
        await this.drawAnnotation(ctx, ann);
      }
      ctx.restore();
    }

    return exportCanvas;
  }

  /**
   * Generates a binary mask canvas (white for mask/selected area, black for unmasked).
   * Useful for AI inpainting and selective generative fill.
   */
  public async renderMask(
    state: ImageEditorState,
    options?: { useAnnotations?: boolean; useCrop?: boolean }
  ): Promise<HTMLCanvasElement> {
    const naturalWidth = state.imageDimensions.width;
    const naturalHeight = state.imageDimensions.height;
    const maskCanvas = this.createCanvas(naturalWidth, naturalHeight);
    const ctx = maskCanvas.getContext('2d');
    if (!ctx) return maskCanvas;

    // Background: unmasked (black)
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, naturalWidth, naturalHeight);

    const useCrop = options?.useCrop ?? true;
    const useAnnotations = options?.useAnnotations ?? true;

    // Crop box mask (if active)
    if (useCrop && state.crop) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(state.crop.x, state.crop.y, state.crop.width, state.crop.height);
    }

    // Annotation masks (drawn in solid white)
    if (useAnnotations && state.annotations.length > 0) {
      for (const ann of state.annotations) {
        ctx.save();
        if (ann.rotation) {
          ctx.translate(ann.x, ann.y);
          ctx.rotate((ann.rotation * Math.PI) / 180);
          ctx.translate(-ann.x, -ann.y);
        }

        if (ann.type === 'pen') {
          const pen = ann as PenAnnotation;
          if (pen.points.length > 0) {
            ctx.beginPath();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = Math.max(pen.strokeWidth, 8);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.moveTo(pen.points[0].x, pen.points[0].y);
            for (let i = 1; i < pen.points.length; i++) {
              ctx.lineTo(pen.points[i].x, pen.points[i].y);
            }
            ctx.stroke();
          }
        } else if (ann.type === 'rect') {
          const rect = ann as RectAnnotation;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        } else if (ann.type === 'circle') {
          const circ = ann as CircleAnnotation;
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.ellipse(circ.x, circ.y, circ.radiusX, circ.radiusY, 0, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.strokeStyle = '#ffffff';
          ctx.fillStyle = '#ffffff';
          await this.drawAnnotation(ctx, ann);
        }
        ctx.restore();
      }
    }

    return maskCanvas;
  }
}

