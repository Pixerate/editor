/**
 * Framework-free UI logic shared by the React and Svelte paint editors, so both behave the same:
 *
 * - `PaintGesture` turns pointer events (structurally typed, no DOM import) into strokes (with
 *   coalesced samples and a predicted tail), colour picks, pans, view rotation and zoom, with palm
 *   rejection while a pen is down.
 * - `PaintCanvasPresenter` keeps a document-sized 2D canvas up to date from the compositor,
 *   uploading only the tiles that changed.
 * - Guide overlays as line segments, and the slider tables of the brush and paper panels.
 */

import { BLEND_MODES, type BlendModeInfo } from '../raster/blend';
import { TILE, type RasterRect } from '../raster/surface';
import type { PaintEditorController } from './controller';
import type { PenPoint } from './engine';
import { perspectiveGuideLines, symmetryAxisSegments, type Point2 } from './guides';
import { isPalmTouch, pointerToPenPoint, type PointerSample } from './input';
import { MAX_ZOOM, MIN_ZOOM, screenToDocument } from './view';
import { hsvToRgb, parseHexColor, rgbToHexColor, rgbToHsv, wheelToHue, type ColorWheel } from './color';

/** The Pointer Event fields the gesture reads. */
export interface PaintPointerEvent extends PointerSample {
  pointerId: number;
  clientX: number;
  clientY: number;
  button?: number;
  buttons?: number;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  getCoalescedEvents?(): PaintPointerEvent[];
  getPredictedEvents?(): PaintPointerEvent[];
}

export type PaintTool = 'brush' | 'eyedropper' | 'pan' | 'rotate';

export const PAINT_TOOLS: ReadonlyArray<{ id: PaintTool; label: string; key: string }> = [
  { id: 'brush', label: 'Brush', key: 'b' },
  { id: 'eyedropper', label: 'Eyedropper', key: 'i' },
  { id: 'pan', label: 'Pan', key: 'h' },
  { id: 'rotate', label: 'Rotate view', key: 'r' },
];

/** Where the viewport element is on screen and how big it is (CSS pixels). */
export interface ViewportBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

type Mode = { kind: 'stroke'; pointerId: number } | { kind: 'pan'; pointerId: number; x: number; y: number; pan: Point2 } | { kind: 'rotate'; pointerId: number; angle: number; rotation: number } | null;

export class PaintGesture {
  tool: PaintTool = 'brush';
  /** The last refusal (a hidden or locked layer), for the editor to show. */
  error: string | null = null;
  /** The predicted tail of the current stroke in document pixels (draw it as a thin preview). */
  predicted: PenPoint[] = [];
  private mode: Mode = null;
  private penAt: Point2 | null = null;
  private penDown = false;

  constructor(
    private readonly controller: PaintEditorController,
    private readonly box: () => ViewportBox
  ) {}

  private doc(e: { clientX: number; clientY: number }): Point2 {
    const b = this.box();
    const s = this.controller.getState();
    return screenToDocument(s.view, s.document.canvas, b, e.clientX - b.left, e.clientY - b.top);
  }

  private pen(e: PaintPointerEvent): PenPoint {
    const p = this.doc(e);
    return pointerToPenPoint(e, p.x, p.y, this.controller.getState().view);
  }

  /** Pointer down; returns true when the gesture took the pointer (capture it). */
  down(e: PaintPointerEvent): boolean {
    this.error = null;
    if (this.mode) return false;
    if (e.pointerType === 'pen') {
      this.penDown = true;
      this.penAt = { x: e.clientX, y: e.clientY };
    } else if (e.pointerType === 'touch' && (this.penDown || isPalmTouch({ x: e.clientX, y: e.clientY }, this.penAt, this.controller.getState().hand))) {
      return false;
    }
    const middle = e.button === 1;
    const tool = middle ? 'pan' : this.tool;
    if (tool === 'pan') {
      this.mode = { kind: 'pan', pointerId: e.pointerId, x: e.clientX, y: e.clientY, pan: { ...this.controller.getState().view.pan } };
      return true;
    }
    if (tool === 'rotate') {
      const b = this.box();
      this.mode = { kind: 'rotate', pointerId: e.pointerId, angle: Math.atan2(e.clientY - b.top - b.height / 2, e.clientX - b.left - b.width / 2), rotation: this.controller.getState().view.rotation };
      return true;
    }
    if (tool === 'eyedropper' || e.altKey) {
      this.pick(e);
      return false;
    }
    try {
      const p = this.pen(e);
      const session = this.controller.beginStroke({ start: p });
      session.push([p]);
      this.mode = { kind: 'stroke', pointerId: e.pointerId };
      return true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  private pick(e: PaintPointerEvent): void {
    const p = this.doc(e);
    const { width, height } = this.controller.document.canvas;
    if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) return;
    this.controller.setColor(this.controller.pickColor(p.x, p.y).color);
  }

  move(e: PaintPointerEvent): void {
    if (e.pointerType === 'pen') this.penAt = { x: e.clientX, y: e.clientY };
    const m = this.mode;
    if (!m || m.pointerId !== e.pointerId) return;
    if (m.kind === 'pan') {
      this.controller.setView({ pan: { x: m.pan.x + e.clientX - m.x, y: m.pan.y + e.clientY - m.y } });
      return;
    }
    if (m.kind === 'rotate') {
      const b = this.box();
      const a = Math.atan2(e.clientY - b.top - b.height / 2, e.clientX - b.left - b.width / 2);
      let r = m.rotation + ((a - m.angle) * 180) / Math.PI;
      if (e.shiftKey) r = Math.round(r / 15) * 15;
      this.controller.setView({ rotation: r });
      return;
    }
    const session = this.controller.activeStroke;
    if (!session) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    session.push((events.length ? events : [e]).map((ev) => this.pen(ev)));
    const predicted = typeof e.getPredictedEvents === 'function' ? e.getPredictedEvents() : [];
    this.predicted = predicted.map((ev) => this.pen(ev));
  }

  up(e: PaintPointerEvent): void {
    if (e.pointerType === 'pen') this.penDown = false;
    const m = this.mode;
    if (!m || m.pointerId !== e.pointerId) return;
    this.mode = null;
    this.predicted = [];
    if (m.kind === 'stroke') this.controller.activeStroke?.end();
  }

  cancel(): void {
    this.penDown = false;
    this.predicted = [];
    if (this.mode?.kind === 'stroke') this.controller.activeStroke?.cancel();
    this.mode = null;
  }

  get active(): boolean {
    return this.mode !== null;
  }

  /** Wheel: zoom about the pointer (Ctrl / pinch or plain wheel), Shift+wheel rotates the view. */
  wheel(e: { clientX: number; clientY: number; deltaY: number; shiftKey?: boolean }): void {
    const s = this.controller.getState();
    if (e.shiftKey) {
      this.controller.setView({ rotation: s.view.rotation + (e.deltaY > 0 ? 5 : -5) });
      return;
    }
    const b = this.box();
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s.view.zoom * Math.exp(-e.deltaY * 0.0015)));
    const k = zoom / s.view.zoom;
    // Keep the point under the pointer still: the pan scales about it.
    const px = e.clientX - b.left - b.width / 2;
    const py = e.clientY - b.top - b.height / 2;
    this.controller.setView({ zoom, pan: { x: px - (px - s.view.pan.x) * k, y: py - (py - s.view.pan.y) * k } });
  }
}

/** Keyboard shortcuts shared by both editors; returns true when it handled the key. */
export function handlePaintShortcut(
  controller: PaintEditorController,
  gesture: PaintGesture,
  e: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; target?: unknown }
): boolean {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') {
    if (controller.getState().stroking) return true;
    if (e.shiftKey) controller.redo();
    else controller.undo();
    return true;
  }
  if (mod && key === 'y') {
    controller.redo();
    return true;
  }
  if (mod) return false;
  const tool = PAINT_TOOLS.find((t) => t.key === key);
  if (tool) {
    gesture.tool = tool.id;
    return true;
  }
  const brush = controller.getState().brush;
  if (key === '[' || key === ']') {
    const step = Math.max(1, Math.round(brush.tip.size * 0.15));
    controller.setBrush({ tip: { size: Math.max(1, brush.tip.size + (key === ']' ? step : -step)) } });
    return true;
  }
  if (key === 'x') {
    controller.swapColors();
    return true;
  }
  if (key === 'm') {
    controller.setView({ mirror: !controller.getState().view.mirror });
    return true;
  }
  if (key === 'escape') {
    controller.resetView();
    return true;
  }
  return false;
}

/** The 2D context methods the presenter uses (a `CanvasRenderingContext2D`). */
export interface Paint2DContext {
  createImageData(width: number, height: number): { data: Uint8ClampedArray };
  putImageData(image: never, dx: number, dy: number, sx?: number, sy?: number, sw?: number, sh?: number): void;
}

/** Keeps a document-sized canvas in step with the controller, tile by tile. */
export class PaintCanvasPresenter {
  private readonly uploaded = new Map<string, Uint8ClampedArray>();
  private scratch: { data: Uint8ClampedArray } | null = null;
  private size = '';

  constructor(private readonly controller: PaintEditorController) {}

  /** Draws what changed into `ctx` (a canvas the size of the document); returns the tiles drawn. */
  render(ctx: Paint2DContext): number {
    const { width, height } = this.controller.document.canvas;
    const size = `${width}x${height}`;
    let dirty = this.controller.takeDirty();
    if (size !== this.size) {
      this.size = size;
      this.uploaded.clear();
      dirty = 'all';
    }
    let drawn = 0;
    const rect: RasterRect = { x: 0, y: 0, width, height };
    this.controller.compositeTiles(rect, (tx, ty, data) => {
      const key = `${tx},${ty}`;
      if (this.uploaded.get(key) === data) return;
      this.uploaded.set(key, data);
      if (!this.scratch) this.scratch = ctx.createImageData(TILE, TILE);
      this.scratch.data.set(data);
      const ox = tx * TILE;
      const oy = ty * TILE;
      ctx.putImageData(this.scratch as never, ox, oy, 0, 0, Math.min(TILE, width - ox), Math.min(TILE, height - oy));
      drawn++;
    }, { dirty });
    return drawn;
  }
}

/** Lines to draw over the canvas for the guides, in document pixels, with a style key. */
export function guideOverlay(controller: PaintEditorController): Array<{ from: Point2; to: Point2; kind: 'symmetry' | 'perspective' | 'snap' }> {
  const s = controller.getState();
  const size = s.document.canvas;
  const out: Array<{ from: Point2; to: Point2; kind: 'symmetry' | 'perspective' | 'snap' }> = [];
  for (const [from, to] of symmetryAxisSegments(s.guides.symmetry, size)) out.push({ from, to, kind: 'symmetry' });
  if (s.guides.perspective.enabled) for (const [from, to] of perspectiveGuideLines(s.guides.perspective, size, 16)) out.push({ from, to, kind: 'perspective' });
  return out;
}

/** One slider of a panel: a path into the brush (or paper) settings. */
export interface SliderControl {
  path: string;
  label: string;
  min: number;
  max: number;
  step: number;
}

export const BRUSH_SLIDERS: readonly SliderControl[] = [
  { path: 'tip.size', label: 'Size', min: 1, max: 400, step: 1 },
  { path: 'tip.opacity', label: 'Opacity', min: 0, max: 1, step: 0.01 },
  { path: 'tip.flow', label: 'Flow', min: 0, max: 1, step: 0.01 },
  { path: 'tip.hardness', label: 'Hardness', min: 0, max: 1, step: 0.01 },
  { path: 'tip.spacing', label: 'Spacing', min: 0.01, max: 1, step: 0.01 },
  { path: 'tip.roundness', label: 'Roundness', min: 0.05, max: 1, step: 0.01 },
  { path: 'tip.angle', label: 'Angle', min: -180, max: 180, step: 1 },
  { path: 'grain', label: 'Grain', min: 0, max: 1, step: 0.01 },
  { path: 'tip.smoothing', label: 'Smoothing', min: 0, max: 0.95, step: 0.01 },
  { path: 'pressureSmoothing', label: 'Pressure smoothing', min: 0, max: 0.95, step: 0.01 },
  { path: 'dynamics.minSize', label: 'Min size', min: 0, max: 1, step: 0.01 },
  { path: 'dynamics.tiltSize', label: 'Tilt size', min: 0, max: 1, step: 0.01 },
  { path: 'dynamics.velocitySize', label: 'Speed size', min: -1, max: 1, step: 0.01 },
];

export const PAPER_SLIDERS: readonly SliderControl[] = [
  { path: 'depth', label: 'Grain depth', min: 0, max: 1, step: 0.01 },
  { path: 'scale', label: 'Grain scale', min: 0.25, max: 8, step: 0.05 },
  { path: 'shading', label: 'Shading', min: 0, max: 1, step: 0.01 },
  { path: 'dry.contrast', label: 'Contrast', min: 0, max: 3, step: 0.05 },
  { path: 'absorption', label: 'Absorption', min: 0, max: 1, step: 0.01 },
  { path: 'permeability', label: 'Permeability', min: 0, max: 1, step: 0.01 },
  { path: 'roughness', label: 'Roughness', min: 0, max: 1, step: 0.01 },
];

/** Reads `a.b` from an object. */
export function readPath(obj: unknown, path: string): number {
  let v: unknown = obj;
  for (const k of path.split('.')) v = (v as Record<string, unknown>)?.[k];
  return typeof v === 'number' ? v : 0;
}

/** `{a: {b: value}}` for `a.b`, keeping the rest of `obj`'s `a`. */
export function patchPath(obj: Record<string, unknown>, path: string, value: number): Record<string, unknown> {
  const [head, ...rest] = path.split('.');
  if (!rest.length) return { [head]: value };
  return { [head]: { ...(obj[head] as Record<string, unknown>), ...patchPath((obj[head] as Record<string, unknown>) ?? {}, rest.join('.'), value) } };
}

/** The point on a colour wheel of `radius` (centre 0, 0) for a wheel angle in degrees, red at the top. */
export function wheelPoint(angle: number, radius: number): Point2 {
  const a = ((angle - 90) * Math.PI) / 180;
  return { x: Math.cos(a) * radius, y: Math.sin(a) * radius };
}

/** The wheel angle (degrees, red at the top, clockwise) of a point relative to the wheel centre. */
export function wheelAngle(x: number, y: number): number {
  return ((Math.atan2(y, x) * 180) / Math.PI + 90 + 360) % 360;
}

/**
 * A hue ring for a colour wheel, `size × size` RGBA: hues at full saturation and value between
 * `inner` and 1 of the radius, red at the top, laid out on the RYB or RGB wheel.
 */
export function renderColorWheel(size: number, wheel: ColorWheel, inner = 0.64): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(size * size * 4);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - r;
      const dy = y + 0.5 - r;
      const d = Math.hypot(dx, dy) / r;
      if (d > 1 || d < inner) continue;
      const [cr, cg, cb] = hsvToRgb(wheelToHue(wheelAngle(dx, dy), wheel), 1, 1);
      const i = (y * size + x) * 4;
      // Anti-aliased edges.
      const edge = Math.min(1, (1 - d) * r, (d - inner) * r);
      data[i] = cr;
      data[i + 1] = cg;
      data[i + 2] = cb;
      data[i + 3] = Math.round(255 * Math.max(0, edge));
    }
  }
  return { width: size, height: size, data };
}

/** The colour for a click on the wheel ring at (dx, dy) from its centre, keeping `color`'s saturation and value. */
export function wheelPick(dx: number, dy: number, wheel: ColorWheel, color: string): string {
  const [r, g, b] = parseHexColor(color);
  const { s, v } = rgbToHsv(r, g, b);
  const [nr, ng, nb] = hsvToRgb(wheelToHue(wheelAngle(dx, dy), wheel), s || 1, v || 1);
  return rgbToHexColor(nr, ng, nb);
}

/** A group of the blend menu: the Photoshop modes, then pigment and the painterly modes. */
export interface BlendMenuGroup {
  label: string;
  modes: readonly BlendModeInfo[];
}

/**
 * The layer and brush blend menus as groups: the 26 standard modes, then the paint modes
 * (`pigment` and the painterly `watercolor`, `tint`, `highlight`, `shadow`), each with its
 * description as a tooltip. Both bindings render this as `<optgroup>`s.
 */
export const BLEND_MENU_GROUPS: readonly BlendMenuGroup[] = [
  { label: 'Standard', modes: BLEND_MODES.filter((m) => !m.painterly && m.id !== 'pigment') },
  { label: 'Paint', modes: BLEND_MODES.filter((m) => m.painterly || m.id === 'pigment') },
];
