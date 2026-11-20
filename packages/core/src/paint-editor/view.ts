/**
 * The canvas view: zoom, pan, rotation and mirroring. View state only: the pixels never resample,
 * the view maps document pixels to the screen and pointer positions back.
 */

import type { Affine } from './strokes';
import { applyAffine, invertAffine } from './strokes';

export interface PaintView {
  /** Screen pixels per document pixel (0.02..64, default 1). */
  zoom: number;
  /** Offset of the canvas centre from the viewport centre, in screen pixels. */
  pan: { x: number; y: number };
  /** Rotation in degrees clockwise, -180..180 (default 0). */
  rotation: number;
  /** Mirror the view left to right (default false). */
  mirror: boolean;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

export const DEFAULT_VIEW: Readonly<PaintView> = { zoom: 1, pan: { x: 0, y: 0 }, rotation: 0, mirror: false };

/** Degrees into -180..180. */
export function normalizeRotation(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let r = deg % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  return Math.round(r * 1000) / 1000;
}

export function normalizeView(raw: Partial<PaintView>, base: PaintView = DEFAULT_VIEW): PaintView {
  const zoom = typeof raw.zoom === 'number' && Number.isFinite(raw.zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, raw.zoom)) : base.zoom;
  const pan = raw.pan && Number.isFinite(raw.pan.x) && Number.isFinite(raw.pan.y) ? { x: raw.pan.x, y: raw.pan.y } : { ...base.pan };
  return {
    zoom,
    pan,
    rotation: typeof raw.rotation === 'number' ? normalizeRotation(raw.rotation) : base.rotation,
    mirror: typeof raw.mirror === 'boolean' ? raw.mirror : base.mirror,
  };
}

/**
 * Document → screen for a canvas of `canvas` size shown in a viewport of `viewport` size:
 * the canvas centre goes to the viewport centre plus `pan`, then zoom, rotation and mirroring
 * apply about it.
 */
export function viewMatrix(view: PaintView, canvas: { width: number; height: number }, viewport: { width: number; height: number }): Affine {
  const a = (view.rotation * Math.PI) / 180;
  const z = view.zoom;
  const m = view.mirror ? -1 : 1;
  const cos = Math.cos(a) * z;
  const sin = Math.sin(a) * z;
  // Screen = C + R(θ) · M · z · (p − c), with y down (clockwise rotation).
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const sx = viewport.width / 2 + view.pan.x;
  const sy = viewport.height / 2 + view.pan.y;
  const A = cos * m;
  const B = -sin;
  const C = sin * m;
  const D = cos;
  return [A, B, C, D, sx - (A * cx + B * cy), sy - (C * cx + D * cy)];
}

/** Screen position → document position. */
export function screenToDocument(view: PaintView, canvas: { width: number; height: number }, viewport: { width: number; height: number }, x: number, y: number): { x: number; y: number } {
  return applyAffine(invertAffine(viewMatrix(view, canvas, viewport)), x, y);
}

/** Document position → screen position. */
export function documentToScreen(view: PaintView, canvas: { width: number; height: number }, viewport: { width: number; height: number }, x: number, y: number): { x: number; y: number } {
  return applyAffine(viewMatrix(view, canvas, viewport), x, y);
}

/** Document pixels around the view that are composited too, so a small pan shows no stale tiles (#515). */
export const VIEW_MARGIN = 64;

/**
 * The part of the canvas a viewport shows (document pixels, whole pixels, inside the canvas),
 * padded by `margin` document pixels, or `null` when none of it is in view. The four viewport
 * corners mapped into the document bound it, so a rotated view gets the rectangle around what it
 * shows (#515).
 */
export function visibleDocumentRect(view: PaintView, canvas: { width: number; height: number }, viewport: { width: number; height: number }, margin = 0): { x: number; y: number; width: number; height: number } | null {
  if (!(viewport.width > 0) || !(viewport.height > 0)) return null;
  const inv = invertAffine(viewMatrix(view, canvas, viewport));
  const corners = [applyAffine(inv, 0, 0), applyAffine(inv, viewport.width, 0), applyAffine(inv, 0, viewport.height), applyAffine(inv, viewport.width, viewport.height)];
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.x)) - margin));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.y)) - margin));
  const x1 = Math.min(canvas.width, Math.ceil(Math.max(...corners.map((p) => p.x)) + margin));
  const y1 = Math.min(canvas.height, Math.ceil(Math.max(...corners.map((p) => p.y)) + margin));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** A CSS `matrix(...)` for an element of the canvas size placed at the viewport's top-left. */
export function viewCssTransform(view: PaintView, canvas: { width: number; height: number }, viewport: { width: number; height: number }): string {
  const m = viewMatrix(view, canvas, viewport);
  const f = (v: number) => Math.round(v * 10000) / 10000;
  return `matrix(${f(m[0])}, ${f(m[2])}, ${f(m[1])}, ${f(m[3])}, ${f(m[4])}, ${f(m[5])})`;
}

/** The zoom that fits the canvas in the viewport (with `margin` screen pixels around it). */
export function fitZoom(canvas: { width: number; height: number }, viewport: { width: number; height: number }, margin = 24): number {
  const w = Math.max(1, viewport.width - 2 * margin);
  const h = Math.max(1, viewport.height - 2 * margin);
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(w / canvas.width, h / canvas.height)));
}

/**
 * Pen rotation as the document sees it: a rotated or mirrored view turns the pen's azimuth and
 * barrel rotation too, so a tilted pencil shades the same way on screen however the canvas is turned.
 */
export function viewPenToDocument<P extends { azimuth?: number; twist?: number }>(view: PaintView, p: P): P {
  if (!view.rotation && !view.mirror) return p;
  const out = { ...p };
  const r = (view.rotation * Math.PI) / 180;
  if (typeof p.azimuth === 'number') {
    let a = p.azimuth - r;
    if (view.mirror) a = Math.PI - a;
    out.azimuth = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  }
  if (typeof p.twist === 'number') {
    let t = p.twist - view.rotation;
    if (view.mirror) t = -t;
    out.twist = ((t % 360) + 360) % 360;
  }
  return out;
}
