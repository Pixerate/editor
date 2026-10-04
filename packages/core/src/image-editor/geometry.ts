import type { CropBox, ImageEditorState, ImagePoint } from './types';

export type CropHandle = 'nw' | 'ne' | 'se' | 'sw' | 'n' | 's' | 'e' | 'w' | 'inside' | null;

export interface ViewportMetrics {
  vpWidth: number;
  vpHeight: number;
  centerX: number;
  centerY: number;
  baseW: number;
  baseH: number;
  fitScale: number;
  renderW: number;
  renderH: number;
  totalScale: number;
  imageRect: { x: number; y: number; width: number; height: number };
  cropRect: { x: number; y: number; width: number; height: number } | null;
}

/**
 * Calculates current viewport projection metrics for canvas <-> image coordinate mapping.
 */
export function getViewportMetrics(
  state: ImageEditorState,
  vpWidth: number,
  vpHeight: number,
  isActivelyCropping = false,
  cropOverride?: CropBox | null
): ViewportMetrics {
  const { imageDimensions, crop: stateCrop, transform, zoom, pan } = state;
  const naturalWidth = imageDimensions.width || 800;
  const naturalHeight = imageDimensions.height || 600;
  const activeCrop =
    (cropOverride !== undefined && cropOverride !== null)
      ? cropOverride
      : (stateCrop ?? (isActivelyCropping ? { x: 0, y: 0, width: naturalWidth, height: naturalHeight } : null));

  const cropW = (!isActivelyCropping && activeCrop) ? activeCrop.width : naturalWidth;
  const cropH = (!isActivelyCropping && activeCrop) ? activeCrop.height : naturalHeight;

  const angle = ((transform.rotate % 360) + 360) % 360;
  const isSwapped = angle === 90 || angle === 270;
  const baseW = isSwapped ? cropH : cropW;
  const baseH = isSwapped ? cropW : cropH;

  const fitScale = Math.min((vpWidth * 0.85) / baseW, (vpHeight * 0.85) / baseH, 1);
  const renderW = baseW * fitScale;
  const renderH = baseH * fitScale;
  const totalScale = zoom * fitScale;

  const centerX = vpWidth / 2 + pan.x;
  const centerY = vpHeight / 2 + pan.y;

  const imageRect = {
    x: centerX - (renderW * zoom) / 2,
    y: centerY - (renderH * zoom) / 2,
    width: renderW * zoom,
    height: renderH * zoom,
  };

  let cropRect: { x: number; y: number; width: number; height: number } | null = null;
  if (activeCrop) {
    const startX = -renderW / 2 + (activeCrop.x / naturalWidth) * renderW;
    const startY = -renderH / 2 + (activeCrop.y / naturalHeight) * renderH;
    const cropBoxW = (activeCrop.width / naturalWidth) * renderW;
    const cropBoxH = (activeCrop.height / naturalHeight) * renderH;

    cropRect = {
      x: centerX + zoom * startX,
      y: centerY + zoom * startY,
      width: zoom * cropBoxW,
      height: zoom * cropBoxH,
    };
  }

  return {
    vpWidth,
    vpHeight,
    centerX,
    centerY,
    baseW,
    baseH,
    fitScale,
    renderW,
    renderH,
    totalScale,
    imageRect,
    cropRect,
  };
}

/**
 * Converts a point on the canvas (in internal canvas pixel space) to image/annotation pixel space.
 */
export function canvasToImagePoint(
  canvasPt: ImagePoint,
  state: ImageEditorState,
  vpWidth: number,
  vpHeight: number,
  isActivelyCropping = false
): ImagePoint {
  const metrics = getViewportMetrics(state, vpWidth, vpHeight, isActivelyCropping);
  const unzoomedX = (canvasPt.x - metrics.centerX) / state.zoom;
  const unzoomedY = (canvasPt.y - metrics.centerY) / state.zoom;

  const x = (unzoomedX + metrics.renderW / 2) / metrics.fitScale;
  const y = (unzoomedY + metrics.renderH / 2) / metrics.fitScale;

  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Converts a point in image/annotation pixel space to internal canvas pixel space.
 */
export function imageToCanvasPoint(
  imgPt: ImagePoint,
  state: ImageEditorState,
  vpWidth: number,
  vpHeight: number,
  isActivelyCropping = false
): ImagePoint {
  const metrics = getViewportMetrics(state, vpWidth, vpHeight, isActivelyCropping);
  const unzoomedX = (imgPt.x - metrics.baseW / 2) * metrics.fitScale;
  const unzoomedY = (imgPt.y - metrics.baseH / 2) * metrics.fitScale;

  const canvasX = metrics.centerX + unzoomedX * state.zoom;
  const canvasY = metrics.centerY + unzoomedY * state.zoom;

  return { x: Math.round(canvasX), y: Math.round(canvasY) };
}

/**
 * Hit-tests the crop box and its corner/edge handles given a canvas point.
 */
export function hitTestCrop(
  canvasPt: ImagePoint,
  state: ImageEditorState,
  vpWidth: number,
  vpHeight: number,
  handleThreshold = 14,
  cropOverride?: CropBox | null
): CropHandle {
  const metrics = getViewportMetrics(state, vpWidth, vpHeight, true, cropOverride);
  if (!metrics.cropRect) return null;

  const { x, y, width: w, height: h } = metrics.cropRect;
  const px = canvasPt.x;
  const py = canvasPt.y;

  // 1. Corners (highest priority)
  const dist = (x1: number, y1: number, x2: number, y2: number) =>
    Math.hypot(x1 - x2, y1 - y2);

  if (dist(px, py, x, y) <= handleThreshold) return 'nw';
  if (dist(px, py, x + w, y) <= handleThreshold) return 'ne';
  if (dist(px, py, x + w, y + h) <= handleThreshold) return 'se';
  if (dist(px, py, x, y + h) <= handleThreshold) return 'sw';

  // 2. Edges
  const nearX = px >= x - handleThreshold && px <= x + w + handleThreshold;
  const nearY = py >= y - handleThreshold && py <= y + h + handleThreshold;

  if (nearX && Math.abs(py - y) <= handleThreshold) return 'n';
  if (nearX && Math.abs(py - (y + h)) <= handleThreshold) return 's';
  if (nearY && Math.abs(px - x) <= handleThreshold) return 'w';
  if (nearY && Math.abs(px - (x + w)) <= handleThreshold) return 'e';

  // 3. Inside crop region
  if (px >= x && px <= x + w && py >= y && py <= y + h) {
    return 'inside';
  }

  return null;
}

/**
 * Returns CSS cursor style corresponding to a crop handle.
 */
export function getCropCursor(handle: CropHandle): string {
  switch (handle) {
    case 'nw':
    case 'se':
      return 'nwse-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    case 'inside':
      return 'move';
    default:
      return 'crosshair';
  }
}

/**
 * Calculates updated crop rectangle given a drag interaction.
 */
export function calculateCropDrag(
  startCrop: CropBox,
  handle: CropHandle,
  startImgPt: ImagePoint,
  currentImgPt: ImagePoint,
  imgWidth: number,
  imgHeight: number,
  aspectRatio?: number | null
): CropBox {
  const dx = currentImgPt.x - startImgPt.x;
  const dy = currentImgPt.y - startImgPt.y;

  // Whole crop box move
  if (handle === 'inside') {
    const maxX = Math.max(0, imgWidth - startCrop.width);
    const maxY = Math.max(0, imgHeight - startCrop.height);
    const newX = Math.max(0, Math.min(maxX, startCrop.x + dx));
    const newY = Math.max(0, Math.min(maxY, startCrop.y + dy));
    return {
      x: Math.round(newX),
      y: Math.round(newY),
      width: startCrop.width,
      height: startCrop.height,
    };
  }

  // Handle resizing
  let left = startCrop.x;
  let top = startCrop.y;
  let right = startCrop.x + startCrop.width;
  let bottom = startCrop.y + startCrop.height;

  const minSize = 20;

  if (handle === 'e' || handle === 'ne' || handle === 'se') {
    right = Math.min(imgWidth, Math.max(left + minSize, startCrop.x + startCrop.width + dx));
  }
  if (handle === 'w' || handle === 'nw' || handle === 'sw') {
    left = Math.max(0, Math.min(right - minSize, startCrop.x + dx));
  }
  if (handle === 's' || handle === 'se' || handle === 'sw') {
    bottom = Math.min(imgHeight, Math.max(top + minSize, startCrop.y + startCrop.height + dy));
  }
  if (handle === 'n' || handle === 'nw' || handle === 'ne') {
    top = Math.max(0, Math.min(bottom - minSize, startCrop.y + dy));
  }

  // Maintain aspect ratio if requested
  if (aspectRatio && aspectRatio > 0) {
    let currentW = right - left;
    let currentH = bottom - top;

    if (handle === 'e' || handle === 'w') {
      currentH = Math.min(imgHeight, currentW / aspectRatio);
      bottom = Math.min(imgHeight, top + currentH);
    } else if (handle === 'n' || handle === 's') {
      currentW = Math.min(imgWidth, currentH * aspectRatio);
      right = Math.min(imgWidth, left + currentW);
    } else {
      // Corner resizing
      const targetH = currentW / aspectRatio;
      if (top + targetH <= imgHeight) {
        bottom = top + targetH;
      } else {
        const targetW = currentH * aspectRatio;
        right = Math.min(imgWidth, left + targetW);
      }
    }
  }

  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(Math.max(minSize, right - left)),
    height: Math.round(Math.max(minSize, bottom - top)),
  };
}

/**
 * Calculates bounding box of an annotation.
 */
export function getAnnotationBounds(ann: import('./types').Annotation): { x: number; y: number; width: number; height: number } {
  switch (ann.type) {
    case 'rect':
      return { x: ann.x, y: ann.y, width: ann.width, height: ann.height };
    case 'circle':
      return {
        x: ann.x - ann.radiusX,
        y: ann.y - ann.radiusY,
        width: ann.radiusX * 2,
        height: ann.radiusY * 2,
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
      let minX = ann.points[0].x;
      let maxX = ann.points[0].x;
      let minY = ann.points[0].y;
      let maxY = ann.points[0].y;
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
        width: ann.text.length * ann.fontSize * 0.6,
        height: ann.fontSize * 1.2,
      };
    case 'image':
      return { x: ann.x, y: ann.y, width: ann.width, height: ann.height };
  }
}

/**
 * Hit tests if a point in image space is within an annotation's bounds.
 */
export function hitTestAnnotation(imgPt: ImagePoint, ann: import('./types').Annotation, padding = 10): boolean {
  const b = getAnnotationBounds(ann);
  return (
    imgPt.x >= b.x - padding &&
    imgPt.x <= b.x + b.width + padding &&
    imgPt.y >= b.y - padding &&
    imgPt.y <= b.y + b.height + padding
  );
}

