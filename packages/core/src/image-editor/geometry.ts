import type { Annotation, CropBox, ImageEditorState, ImagePoint, ImageTransform } from './types';

/*
 * Coordinate spaces
 * -----------------
 * The crop box and every annotation are stored in ONE canonical space: natural image
 * pixels of the current source image (origin top-left of the un-rotated, un-flipped,
 * un-cropped image). Rotation, flips, crop and the viewport fit/zoom/pan are pure view
 * transforms applied on top of that space by a single forward mapping:
 *
 *   target = origin + scale * R(angle) * F(flipH, flipV) * (image - regionCenter)
 *
 * where `regionCenter` is the centre of the visible region (the crop box, or the whole
 * image while the crop tool is active). `projectImagePoint` / `unprojectCanvasPoint`
 * implement the mapping and its exact inverse, and `applyImageProjectionToContext`
 * applies the very same transform to a 2D context, so rendering, hit-testing, viewport
 * metrics, export and mask generation cannot drift apart.
 */

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
 * A complete description of the natural-image -> target mapping (see module comment).
 */
export interface ImageProjection {
  /** Visible region in natural image pixels (crop box or full image). */
  region: CropBox;
  /** Rotation in degrees, normalised to [0, 360). */
  angle: number;
  flipH: boolean;
  flipV: boolean;
  /** Uniform scale from image pixels to target pixels. */
  scale: number;
  /** Target-space point that the centre of `region` maps to. */
  originX: number;
  originY: number;
}

/** Normalises any rotation in degrees to [0, 360). */
export function normalizeAngle(degrees: number): number {
  const a = ((degrees % 360) + 360) % 360;
  return a === 360 ? 0 : a;
}

function cosSin(angle: number): [number, number] {
  // Exact values for quarter turns so 90deg steps never accumulate float noise.
  switch (angle) {
    case 0:
      return [1, 0];
    case 90:
      return [0, 1];
    case 180:
      return [-1, 0];
    case 270:
      return [0, -1];
    default: {
      const rad = (angle * Math.PI) / 180;
      return [Math.cos(rad), Math.sin(rad)];
    }
  }
}

/** Whether the rotation swaps the displayed width and height. */
export function isQuarterTurnSwapped(transform: Pick<ImageTransform, 'rotate'>): boolean {
  const angle = normalizeAngle(transform.rotate);
  return angle === 90 || angle === 270;
}

/** Size of a region once rotated (bounding box for arbitrary angles). */
export function getRotatedSize(
  width: number,
  height: number,
  transform: Pick<ImageTransform, 'rotate'>
): { width: number; height: number } {
  const [c, s] = cosSin(normalizeAngle(transform.rotate));
  return {
    width: Math.abs(width * c) + Math.abs(height * s),
    height: Math.abs(width * s) + Math.abs(height * c),
  };
}

/** Maps a natural-image point to target space. */
export function projectImagePoint(pt: ImagePoint, p: ImageProjection): ImagePoint {
  const [c, s] = cosSin(p.angle);
  let x = pt.x - (p.region.x + p.region.width / 2);
  let y = pt.y - (p.region.y + p.region.height / 2);
  if (p.flipH) x = -x;
  if (p.flipV) y = -y;
  const rx = x * c - y * s;
  const ry = x * s + y * c;
  return { x: p.originX + rx * p.scale, y: p.originY + ry * p.scale };
}

/** Exact inverse of {@link projectImagePoint}. */
export function unprojectCanvasPoint(pt: ImagePoint, p: ImageProjection): ImagePoint {
  const [c, s] = cosSin(p.angle);
  const rx = (pt.x - p.originX) / p.scale;
  const ry = (pt.y - p.originY) / p.scale;
  let x = rx * c + ry * s;
  let y = -rx * s + ry * c;
  if (p.flipH) x = -x;
  if (p.flipV) y = -y;
  return { x: x + p.region.x + p.region.width / 2, y: y + p.region.y + p.region.height / 2 };
}

/**
 * Applies the projection to a 2D context so that subsequent drawing in natural image
 * pixels lands exactly where {@link projectImagePoint} says it does.
 */
export function applyImageProjectionToContext(
  ctx: Pick<CanvasRenderingContext2D, 'translate' | 'scale' | 'rotate'>,
  p: ImageProjection
): void {
  ctx.translate(p.originX, p.originY);
  ctx.scale(p.scale, p.scale);
  if (p.angle !== 0) ctx.rotate((p.angle * Math.PI) / 180);
  if (p.flipH || p.flipV) ctx.scale(p.flipH ? -1 : 1, p.flipV ? -1 : 1);
  ctx.translate(-(p.region.x + p.region.width / 2), -(p.region.y + p.region.height / 2));
}

/** Projects an image-space rectangle and returns its target-space bounding box. */
export function projectImageRect(
  rect: CropBox,
  p: ImageProjection
): { x: number; y: number; width: number; height: number } {
  const corners = [
    projectImagePoint({ x: rect.x, y: rect.y }, p),
    projectImagePoint({ x: rect.x + rect.width, y: rect.y }, p),
    projectImagePoint({ x: rect.x, y: rect.y + rect.height }, p),
    projectImagePoint({ x: rect.x + rect.width, y: rect.y + rect.height }, p),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** Clamps a crop box to the image bounds. */
export function clampCropToImage(crop: CropBox, width: number, height: number): CropBox {
  const x = Math.max(0, Math.min(width - 1, crop.x));
  const y = Math.max(0, Math.min(height - 1, crop.y));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, crop.width)),
    height: Math.max(1, Math.min(height - y, crop.height)),
  };
}

function resolveViewport(
  state: ImageEditorState,
  vpWidth: number,
  vpHeight: number,
  isActivelyCropping: boolean,
  cropOverride?: CropBox | null
) {
  const { imageDimensions, crop: stateCrop, transform, zoom, pan } = state;
  const naturalWidth = imageDimensions.width || 800;
  const naturalHeight = imageDimensions.height || 600;
  const full: CropBox = { x: 0, y: 0, width: naturalWidth, height: naturalHeight };
  const activeCrop =
    cropOverride !== undefined && cropOverride !== null
      ? cropOverride
      : (stateCrop ?? (isActivelyCropping ? full : null));

  const region =
    !isActivelyCropping && activeCrop ? clampCropToImage(activeCrop, naturalWidth, naturalHeight) : full;
  const { width: baseW, height: baseH } = getRotatedSize(region.width, region.height, transform);

  const fitScale = Math.min((vpWidth * 0.85) / baseW, (vpHeight * 0.85) / baseH, 1);
  const centerX = vpWidth / 2 + pan.x;
  const centerY = vpHeight / 2 + pan.y;

  const projection: ImageProjection = {
    region,
    angle: normalizeAngle(transform.rotate),
    flipH: transform.flipH,
    flipV: transform.flipV,
    scale: zoom * fitScale,
    originX: centerX,
    originY: centerY,
  };

  return { activeCrop, baseW, baseH, fitScale, centerX, centerY, projection };
}

/**
 * Returns the natural-image -> canvas projection used by the interactive viewport.
 */
export function getViewportProjection(
  state: ImageEditorState,
  vpWidth: number,
  vpHeight: number,
  isActivelyCropping = false,
  cropOverride?: CropBox | null
): ImageProjection {
  return resolveViewport(state, vpWidth, vpHeight, isActivelyCropping, cropOverride).projection;
}

/**
 * Calculates current viewport projection metrics for canvas <-> image coordinate mapping.
 * `cropRect` is the on-screen (rotated/flipped) rectangle of the crop box.
 */
export function getViewportMetrics(
  state: ImageEditorState,
  vpWidth: number,
  vpHeight: number,
  isActivelyCropping = false,
  cropOverride?: CropBox | null
): ViewportMetrics {
  const { zoom } = state;
  const { activeCrop, baseW, baseH, fitScale, centerX, centerY, projection } = resolveViewport(
    state,
    vpWidth,
    vpHeight,
    isActivelyCropping,
    cropOverride
  );

  const renderW = baseW * fitScale;
  const renderH = baseH * fitScale;

  const imageRect = {
    x: centerX - (renderW * zoom) / 2,
    y: centerY - (renderH * zoom) / 2,
    width: renderW * zoom,
    height: renderH * zoom,
  };

  const cropRect = activeCrop ? projectImageRect(activeCrop, projection) : null;

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
    totalScale: zoom * fitScale,
    imageRect,
    cropRect,
  };
}

/**
 * Converts a point on the canvas (in internal canvas pixel space) to natural image pixel
 * space, accounting for zoom, pan, fit scale, crop offset, rotation and flips.
 */
export function canvasToImagePoint(
  canvasPt: ImagePoint,
  state: ImageEditorState,
  vpWidth: number,
  vpHeight: number,
  isActivelyCropping = false
): ImagePoint {
  return unprojectCanvasPoint(canvasPt, getViewportProjection(state, vpWidth, vpHeight, isActivelyCropping));
}

/**
 * Converts a point in natural image pixel space to internal canvas pixel space.
 * Exact inverse of {@link canvasToImagePoint}.
 */
export function imageToCanvasPoint(
  imgPt: ImagePoint,
  state: ImageEditorState,
  vpWidth: number,
  vpHeight: number,
  isActivelyCropping = false
): ImagePoint {
  return projectImagePoint(imgPt, getViewportProjection(state, vpWidth, vpHeight, isActivelyCropping));
}

const HANDLE_VECTORS: Record<Exclude<CropHandle, 'inside' | null>, [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

function vectorToHandle(x: number, y: number): CropHandle {
  const vx = Math.abs(x) < 0.38 ? 0 : Math.sign(x);
  const vy = Math.abs(y) < 0.38 ? 0 : Math.sign(y);
  for (const [name, [hx, hy]] of Object.entries(HANDLE_VECTORS)) {
    if (hx === vx && hy === vy) return name as CropHandle;
  }
  return null;
}

/**
 * Converts a crop handle in screen orientation to the equivalent edge/corner of the crop
 * box in natural image space, or the reverse with `toScreen = true`.
 */
export function mapCropHandle(handle: CropHandle, transform: ImageTransform, toScreen = false): CropHandle {
  if (handle === null || handle === 'inside') return handle;
  const [hx, hy] = HANDLE_VECTORS[handle];
  const [c, s] = cosSin(normalizeAngle(transform.rotate));
  const fx = transform.flipH ? -1 : 1;
  const fy = transform.flipV ? -1 : 1;
  if (toScreen) {
    const x = hx * fx;
    const y = hy * fy;
    return vectorToHandle(x * c - y * s, x * s + y * c);
  }
  const x = hx * c + hy * s;
  const y = -hx * s + hy * c;
  return vectorToHandle(x * fx, y * fy);
}

/**
 * Hit-tests the crop box and its corner/edge handles given a canvas point.
 * The returned handle names the edge/corner of the crop box in natural image space
 * (what {@link calculateCropDrag} expects); use `getCropCursor(handle, state.transform)`
 * to obtain the matching on-screen cursor.
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

  const screenHandle = hitTestCropRect(canvasPt, metrics.cropRect, handleThreshold);
  return mapCropHandle(screenHandle, state.transform);
}

function hitTestCropRect(
  canvasPt: ImagePoint,
  rect: { x: number; y: number; width: number; height: number },
  handleThreshold: number
): CropHandle {
  const { x, y, width: w, height: h } = rect;
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
 * Returns CSS cursor style corresponding to a crop handle. Pass the current transform when
 * the handle comes from {@link hitTestCrop} (image space) so the cursor matches the
 * on-screen orientation under rotation/flip.
 */
export function getCropCursor(handle: CropHandle, transform?: ImageTransform): string {
  const screenHandle = transform ? mapCropHandle(handle, transform, true) : handle;
  switch (screenHandle) {
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
  aspectRatio?: number | null,
  transform?: ImageTransform
): CropBox {
  // `aspectRatio` is the on-screen ratio; under a quarter turn it is inverted in image space.
  if (aspectRatio && transform && isQuarterTurnSwapped(transform)) {
    aspectRatio = 1 / aspectRatio;
  }
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
export function getAnnotationBounds(ann: Annotation): { x: number; y: number; width: number; height: number } {
  switch (ann.type) {
    case 'rect':
    case 'image':
      return {
        x: Math.min(ann.x, ann.x + ann.width),
        y: Math.min(ann.y, ann.y + ann.height),
        width: Math.abs(ann.width),
        height: Math.abs(ann.height),
      };
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
  }
}

/**
 * Hit tests if a point in image space is within an annotation's bounds.
 */
export function hitTestAnnotation(imgPt: ImagePoint, ann: Annotation, padding = 10): boolean {
  const b = getAnnotationBounds(ann);
  return (
    imgPt.x >= b.x - padding &&
    imgPt.x <= b.x + b.width + padding &&
    imgPt.y >= b.y - padding &&
    imgPt.y <= b.y + b.height + padding
  );
}

