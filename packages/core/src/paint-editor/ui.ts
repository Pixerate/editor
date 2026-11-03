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

import type { MixerLoad } from '../paint/exchange';
import { BLEND_MODES, type BlendModeInfo } from '../raster/blend';
import type { ImpastoTool, PaintBrush, PaintBrushInput, WetMediumKind, WetTool } from './brushes';
import { TILE, type RasterRect } from '../raster/surface';
import type { PaintEditorController } from './controller';
import type { PenPoint } from './engine';
import { perspectiveGuideLines, symmetryAxisSegments, type Point2 } from './guides';
import { stencilOutline, type StencilInput } from './stencils';
import { MAX_DOT_TEXTURES, type DotRotation, type DotTextureOrder, type ParticleKind, type ParticleRender, type RibbonPairs } from './procedural';
import { MAX_STICKER_STAMPS, type StampKind } from './stickers';
import type { StickerRef } from '../stickers/types';
import type { WetEngineInfo, WetGpuMode } from './wet';
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

export type PaintTool = 'brush' | 'eyedropper' | 'pan' | 'rotate' | 'sticker' | 'stroke';

export const PAINT_TOOLS: ReadonlyArray<{ id: PaintTool; label: string; key: string }> = [
  { id: 'brush', label: 'Brush', key: 'b' },
  { id: 'eyedropper', label: 'Eyedropper', key: 'i' },
  { id: 'sticker', label: 'Stickers', key: 's' },
  { id: 'stroke', label: 'Select stroke', key: 'v' },
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

type Mode =
  | { kind: 'stroke'; pointerId: number }
  /** Dragging a stroke of a stroke layer: where the pointer went down and where it is now. */
  | { kind: 'move-stroke'; pointerId: number; id: string; from: Point2; to: Point2 }
  /** Dragging a sticker: (dx, dy) from the pointer to its centre, and where it was last shown. */
  | { kind: 'sticker'; pointerId: number; id: string; dx: number; dy: number; at: Point2 | null }
  | { kind: 'pan'; pointerId: number; x: number; y: number; pan: Point2 } | { kind: 'rotate'; pointerId: number; angle: number; rotation: number } | null;

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
    if (tool === 'stroke') return this.strokeDown(e);
    if (tool === 'eyedropper' || e.altKey) {
      this.pick(e);
      return false;
    }
    if (tool === 'sticker') return this.stickerDown(e);
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

  /**
   * The Select stroke tool, on a stroke layer: pressing a stroke picks it and dragging moves it
   * (one undo step at the drop); pressing where no stroke painted clears the pick.
   */
  private strokeDown(e: PaintPointerEvent): boolean {
    const p = this.doc(e);
    const s = this.controller.getState();
    const layerId = s.document.activeLayerId;
    if (!layerId || !s.document.liveStrokes?.[layerId]) {
      this.error = 'Pick a stroke layer in the Layers panel (or add one) to select its strokes.';
      return false;
    }
    try {
      const hit = this.controller.liveStrokeAt(layerId, p.x, p.y);
      this.controller.selectStroke(hit?.id ?? null);
      if (!hit) return false;
      this.mode = { kind: 'move-stroke', pointerId: e.pointerId, id: hit.id, from: p, to: p };
      return true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** While a stroke is dragged: how far it has moved (document pixels), to draw its outline there. */
  get strokeDrag(): { id: string; dx: number; dy: number } | null {
    const m = this.mode;
    return m?.kind === 'move-stroke' ? { id: m.id, dx: m.to.x - m.from.x, dy: m.to.y - m.from.y } : null;
  }

  /**
   * The Stickers tool: pressing a sticker picks it and dragging moves it (one undo step at the
   * drop); pressing anywhere else places the active brush's first stamp there, at its tip size and
   * the paint colour, and picks it.
   */
  private stickerDown(e: PaintPointerEvent): boolean {
    const p = this.doc(e);
    try {
      const hit = this.controller.stickerAt(undefined, p.x, p.y);
      if (hit) {
        this.controller.selectSticker(hit.id);
        this.mode = { kind: 'sticker', pointerId: e.pointerId, id: hit.id, dx: hit.x - p.x, dy: hit.y - p.y, at: null };
        return true;
      }
      const brush = this.controller.getState().brush;
      const size = Math.min(2048, Math.max(2, Math.round(brush.tip.size)));
      const [added] = this.controller.addStickers(undefined, [{ ref: brush.sticker.stamps[0] ?? 'editor:star', x: round2(p.x), y: round2(p.y), size }]);
      this.controller.selectSticker(added.id);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
    return false;
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
    if (m.kind === 'move-stroke') {
      m.to = this.doc(e);
      return;
    }
    if (m.kind === 'sticker') {
      const p = this.doc(e);
      m.at = { x: round2(p.x + m.dx), y: round2(p.y + m.dy) };
      try {
        this.controller.previewSticker(undefined, m.id, m.at);
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      }
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
    if (m.kind === 'move-stroke') {
      const dx = Math.round((this.doc(e).x - m.from.x) * 100) / 100;
      const dy = Math.round((this.doc(e).y - m.from.y) * 100) / 100;
      if (dx || dy) {
        try {
          this.controller.editStrokePoints(m.id, { transform: { dx, dy } });
        } catch (err) {
          this.error = err instanceof Error ? err.message : String(err);
        }
      }
    }
    if (m.kind === 'sticker' && m.at) {
      try {
        this.controller.updateSticker(undefined, m.id, m.at);
      } catch (err) {
        this.controller.cancelStickerPreview();
        this.error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  cancel(): void {
    this.penDown = false;
    this.predicted = [];
    if (this.mode?.kind === 'stroke') this.controller.activeStroke?.cancel();
    if (this.mode?.kind === 'sticker') this.controller.cancelStickerPreview();
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

const round2 = (v: number) => Math.round(v * 100) / 100;

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

export type GuideOverlayKind = 'symmetry' | 'perspective' | 'snap' | 'stencil' | 'sticker' | 'stroke';

/**
 * Lines to draw over the canvas for the guides, the picked sticker and the picked stroke of a stroke layer (moved by
 * `drag` while it is dragged), in document pixels, with a style key.
 */
export function guideOverlay(controller: PaintEditorController, drag?: { id: string; dx: number; dy: number } | null): Array<{ from: Point2; to: Point2; kind: GuideOverlayKind }> {
  const s = controller.getState();
  const size = s.document.canvas;
  const out: Array<{ from: Point2; to: Point2; kind: GuideOverlayKind }> = [];
  const layerId = s.document.activeLayerId;
  const strokePicked = layerId && s.selectedStroke ? s.document.liveStrokes?.[layerId]?.some((x) => x.id === s.selectedStroke) : false;
  const area = strokePicked ? controller.liveStrokeArea(s.selectedStroke!) : null;
  if (area) {
    const dx = drag && drag.id === s.selectedStroke ? drag.dx : 0;
    const dy = drag && drag.id === s.selectedStroke ? drag.dy : 0;
    const box = [
      { x: area.x + dx, y: area.y + dy },
      { x: area.x + area.width + dx, y: area.y + dy },
      { x: area.x + area.width + dx, y: area.y + area.height + dy },
      { x: area.x + dx, y: area.y + area.height + dy },
    ];
    for (let i = 0; i < 4; i++) out.push({ from: box[i], to: box[(i + 1) % 4], kind: 'stroke' });
  }
  const picked = layerId && s.selectedSticker ? s.document.stickers?.[layerId]?.find((x) => x.id === s.selectedSticker) : undefined;
  if (picked) {
    // Its box, turned with it.
    const r = picked.size / 2 + 2;
    const a = (picked.rotation * Math.PI) / 180;
    const corner = (u: number, v: number) => ({ x: picked.x + (u * Math.cos(a) - v * Math.sin(a)) * r, y: picked.y + (u * Math.sin(a) + v * Math.cos(a)) * r });
    const box = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    for (let i = 0; i < 4; i++) out.push({ from: box[i], to: box[(i + 1) % 4], kind: 'sticker' });
  }
  for (const st of s.guides.stencils) {
    if (!st.enabled) continue;
    const line = stencilOutline(st);
    for (let i = 0; i + 1 < line.length; i++) out.push({ from: line[i], to: line[i + 1], kind: 'stencil' });
  }
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
  { path: 'metallic', label: 'Metallic', min: 0, max: 1, step: 0.01 },
  { path: 'backlight', label: 'Backlight', min: 0, max: 1, step: 0.01 },
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

/** The engine-specific part of the brush panel: which sliders and toggles the active brush has. */
export interface BrushEngineControls {
  /** Section heading. */
  title: string;
  sliders: readonly SliderControl[];
  /** Where the RGB / pigment choice is stored, or `null` when the engine has none. */
  mixingPath: 'behavior.mixing' | 'blender.mixing' | 'smudge.mixing' | null;
  /** The dirty-brush toggle (`behavior.dirty`). */
  dirty: boolean;
  /** The multi-colour controls (`behavior.multicolor`; the panels show the brush gradient, `brush.paint`, instead). */
  multicolor: boolean;
  /** Load / Clean buttons and a swatch of what the brush carries. */
  load: boolean;
  /** The wet tool menu (`wet.tool`, `WET_TOOLS`) and medium menu (`wet.medium`, `WET_MEDIA`). */
  wetTool?: boolean;
  /** The impasto tool menu (`impasto.tool`, `IMPASTO_TOOLS`). */
  impastoTool?: boolean;
  /**
   * The particle menus: kind and render (`particle.kind`, `particle.render`), ribbon pairs
   * (`particle.ribbonPairs`), and the textured-dot stamps, order and rotation
   * (`particle.dotTextures` up to `MAX_DOT_TEXTURES` of `STAMP_KINDS`, `dotTextureOrder`, `dotRotation`).
   */
  particleMenus?: boolean;
  /** The sticker picker for the brush's stickers (`sticker.stamps`, refs from the sticker library; `toggleStickerRef`). */
  stickerStamps?: boolean;
  /** Light paint: the "light follows pressure" toggle (`light.pressure`); the Light slider is in `sliders`. */
  light?: boolean;
}

/** The light paint slider (every engine that lays colour but sticker brushes; wet brushes when they paint). */
const LIGHT_SLIDER: SliderControl = { path: 'light.amount', label: 'Light', min: 0, max: 1, step: 0.01 };

const PICKUP_SLIDERS: readonly SliderControl[] = [
  { path: 'behavior.pickup', label: 'Pick-up', min: 0, max: 1, step: 0.01 },
  { path: 'behavior.mix', label: 'Mix', min: 0, max: 1, step: 0.01 },
];

/**
 * The controls the active brush's engine adds to the brush panel (`null` for the eraser):
 * blender strength and blend distance; smudge strength and length; the Mixer Brush's pick-up,
 * mix and load; a dab brush's pick-up and mix ratios. Every engine but the eraser has an RGB /
 * pigment choice; dab and mixer brushes also have the dirty and multi-colour controls. Pick-up
 * and mix always go through `behavior`, which keeps a Mixer Brush's `mixer` block in sync.
 */
export function brushEngineControls(brush: Pick<PaintBrush, 'engine'> & { wet?: PaintBrush['wet'] }): BrushEngineControls | null {
  const c = engineControls(brush);
  const wetPaint = brush.engine === 'wet' && brush.wet?.tool === 'paint';
  if (!c || !(wetPaint || ['dab', 'mixer', 'particle', 'bristle', 'impasto'].includes(brush.engine))) return c;
  // Light paint: how much light the brush lays (and, for impasto, rim and clarity).
  const extra: SliderControl[] = brush.engine === 'impasto' ? [{ path: 'impasto.rim', label: 'Rim', min: 0, max: 1, step: 0.01 }, { path: 'impasto.clarity', label: 'Clarity', min: 0, max: 1, step: 0.01 }] : [];
  return { ...c, sliders: [...c.sliders, LIGHT_SLIDER, ...extra], light: true };
}

function engineControls(brush: Pick<PaintBrush, 'engine'> & { wet?: PaintBrush['wet'] }): BrushEngineControls | null {
  switch (brush.engine) {
    case 'particle':
      return {
        title: 'Particles',
        sliders: [
          { path: 'particle.count', label: 'Particles', min: 1, max: 64, step: 1 },
          { path: 'particle.size', label: 'Mark size', min: 0, max: 1, step: 0.01 },
          { path: 'particle.spread', label: 'Spread', min: 0, max: 1, step: 0.01 },
          { path: 'particle.stiffness', label: 'Stiffness', min: 0, max: 1, step: 0.01 },
          { path: 'particle.damping', label: 'Damping', min: 0, max: 1, step: 0.01 },
          { path: 'particle.speed', label: 'Speed', min: 0, max: 1, step: 0.01 },
          { path: 'particle.gravity', label: 'Gravity', min: -1, max: 1, step: 0.01 },
          { path: 'particle.life', label: 'Life', min: 0, max: 1, step: 0.01 },
          { path: 'particle.interval', label: 'Bead spacing', min: 0, max: 1, step: 0.01 },
          { path: 'particle.ribbonFill', label: 'Ribbon fill', min: 0, max: 1, step: 0.01 },
          { path: 'particle.waveAmplitude', label: 'Wave', min: 0, max: 1, step: 0.01 },
          { path: 'particle.waveLength', label: 'Wavelength', min: 4, max: 400, step: 1 },
          { path: 'particle.waveSpeed', label: 'Wave speed', min: 0, max: 1, step: 0.01 },
          { path: 'particle.wavePhaseJitter', label: 'Wave scatter', min: 0, max: 1, step: 0.01 },
        ],
        mixingPath: null,
        dirty: false,
        multicolor: false,
        load: false,
        particleMenus: true,
      };
    case 'bristle':
      return {
        title: 'Bristles',
        sliders: [
          { path: 'bristle.count', label: 'Bristles', min: 3, max: 128, step: 1 },
          { path: 'bristle.stiffness', label: 'Stiffness', min: 0, max: 1, step: 0.01 },
          { path: 'bristle.splay', label: 'Splay', min: 0, max: 1, step: 0.01 },
          { path: 'bristle.thickness', label: 'Bristle width', min: 0, max: 1, step: 0.01 },
          { path: 'bristle.load', label: 'Load', min: 0, max: 1, step: 0.01 },
          { path: 'bristle.jitter', label: 'Variation', min: 0, max: 1, step: 0.01 },
        ],
        mixingPath: null,
        dirty: false,
        multicolor: false,
        load: false,
      };
    case 'sticker':
      return {
        title: 'Stickers',
        sliders: [
          { path: 'sticker.density', label: 'Density', min: 0, max: 1, step: 0.01 },
          { path: 'sticker.sizeJitter', label: 'Size jitter', min: 0, max: 1, step: 0.01 },
          { path: 'sticker.rotationJitter', label: 'Turn jitter', min: 0, max: 1, step: 0.01 },
          { path: 'sticker.scatter', label: 'Scatter', min: 0, max: 2, step: 0.01 },
          { path: 'sticker.colorJitter', label: 'Colour jitter', min: 0, max: 1, step: 0.01 },
        ],
        mixingPath: null,
        dirty: false,
        multicolor: false,
        load: false,
        stickerStamps: true,
      };
    case 'impasto':
      return {
        title: 'Thick paint',
        sliders: [
          { path: 'impasto.thickness', label: 'Thickness', min: 0, max: 1, step: 0.01 },
          { path: 'impasto.gloss', label: 'Gloss', min: 0, max: 1, step: 0.01 },
          { path: 'impasto.metallic', label: 'Metallic', min: 0, max: 1, step: 0.01 },
          { path: 'impasto.load', label: 'Load', min: 0, max: 1, step: 0.01 },
          { path: 'impasto.thinner', label: 'Thinner', min: 0, max: 1, step: 0.01 },
          { path: 'impasto.drag', label: 'Drag', min: 0, max: 1, step: 0.01 },
          ...PICKUP_SLIDERS,
        ],
        mixingPath: 'behavior.mixing',
        dirty: true,
        multicolor: false,
        load: true,
        impastoTool: true,
      };
    case 'wet': {
      const tool = brush.wet?.tool ?? 'paint';
      const sliders: SliderControl[] =
        tool === 'paint'
          ? [
              { path: 'wet.water', label: 'Water', min: 0, max: 1, step: 0.01 },
              { path: 'wet.pigment', label: 'Pigment', min: 0, max: 1, step: 0.01 },
              { path: 'wet.body', label: 'Body (opacity)', min: 0, max: 1, step: 0.01 },
              { path: 'wet.rewet', label: 'Re-wet', min: 0, max: 1, step: 0.01 },
              { path: 'wet.load', label: 'Load', min: 0, max: 1, step: 0.01 },
              { path: 'wet.thinner', label: 'Thinner', min: 0, max: 1, step: 0.01 },
              ...PICKUP_SLIDERS,
            ]
          : tool === 'water'
            ? [
                { path: 'wet.water', label: 'Water', min: 0, max: 1, step: 0.01 },
                { path: 'wet.rewet', label: 'Re-wet', min: 0, max: 1, step: 0.01 },
              ]
            : [{ path: 'wet.strength', label: 'Strength', min: 0, max: 1, step: 0.01 }];
      return { title: 'Wet brush', sliders, mixingPath: tool === 'paint' ? 'behavior.mixing' : null, dirty: tool === 'paint', multicolor: false, load: tool === 'paint', wetTool: true };
    }
    case 'blender':
      return {
        title: 'Blender',
        sliders: [
          { path: 'blender.strength', label: 'Strength', min: 0, max: 1, step: 0.01 },
          { path: 'blender.distance', label: 'Blend distance', min: 0, max: 1, step: 0.01 },
        ],
        mixingPath: 'blender.mixing',
        dirty: false,
        multicolor: false,
        load: false,
      };
    case 'smudge':
      return {
        title: 'Smudge',
        sliders: [
          { path: 'smudge.strength', label: 'Strength', min: 0, max: 1, step: 0.01 },
          { path: 'smudge.length', label: 'Length', min: 0, max: 1, step: 0.01 },
        ],
        mixingPath: 'smudge.mixing',
        dirty: false,
        multicolor: false,
        load: false,
      };
    case 'mixer':
      return { title: 'Mixer Brush', sliders: [...PICKUP_SLIDERS, { path: 'mixer.load', label: 'Load', min: 0, max: 1, step: 0.01 }], mixingPath: 'behavior.mixing', dirty: true, multicolor: true, load: true };
    case 'dab':
      return { title: 'Paint behaviour', sliders: PICKUP_SLIDERS, mixingPath: 'behavior.mixing', dirty: true, multicolor: true, load: true };
    default:
      return null;
  }
}

/** The multi-colour sliders for a mode: softness, and dabs per colour in `dab` mode. */
export function multiColorSliders(mode: string): readonly SliderControl[] {
  if (mode === 'off') return [];
  const soft: SliderControl = { path: 'behavior.multicolor.softness', label: 'Colour softness', min: 0, max: 1, step: 0.01 };
  return mode === 'dab' ? [soft, { path: 'behavior.multicolor.length', label: 'Dabs per colour', min: 1, max: 100, step: 1 }] : [soft];
}

/** A brush change setting `path` (e.g. `smudge.mixing`, `behavior.dirty`) to any value, keeping the rest of its block. */
export function patchBrushValue(brush: PaintBrush, path: string, value: unknown): PaintBrushInput {
  const set = (obj: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
    const [head, ...rest] = keys;
    if (!rest.length) return { ...obj, [head]: value };
    return { ...obj, [head]: set((obj[head] as Record<string, unknown>) ?? {}, rest) };
  };
  const [head, ...rest] = path.split('.');
  if (!rest.length) return { [head]: value } as PaintBrushInput;
  return { [head]: set({ ...((brush as unknown as Record<string, Record<string, unknown>>)[head] ?? {}) }, rest) } as PaintBrushInput;
}

/** What the brush carries (picked-up paint, else loaded paint) as #rrggbb, or `null` when it is clean and empty. */
export function brushLoadColor(load: MixerLoad): string | null {
  const c = load.pickup ?? load.reservoir;
  return c ? rgbToHexColor(Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)) : null;
}

/** Sample sizes (square, in pad pixels) for picking from the mixing pad. */
export const PAD_SAMPLE_SIZES: readonly number[] = [1, 3, 5, 9, 15];

/** The averaging radius `mixingPadPick` takes for a sample size: 1 → 0, 3 → 1, 5 → 2 … */
export function padSampleRadius(size: number): number {
  return Math.max(0, Math.floor((size - 1) / 2));
}

// ---------------------------------------------------------------------------
// Wet media
// ---------------------------------------------------------------------------

/** Labels of the wet tools, for the wet brush's tool menu. */
export const WET_TOOL_LABELS: Readonly<Record<WetTool, string>> = {
  paint: 'Paint',
  water: 'Add water',
  dry: 'Dry',
  blow: 'Blow',
  blend: 'Blend',
  smudge: 'Smudge',
  blot: 'Blot (erase wet)',
};

/** The wet panel's sliders for a layer's wet settings (paths into `WetParams`). */
export const WET_PARAM_SLIDERS: readonly SliderControl[] = [
  { path: 'viscosity', label: 'Viscosity', min: 0, max: 1, step: 0.01 },
  { path: 'evaporation', label: 'Evaporation', min: 0, max: 1, step: 0.01 },
  { path: 'edgeDarkening', label: 'Edge darkening', min: 0, max: 1, step: 0.01 },
  { path: 'granulation', label: 'Granulation', min: 0, max: 1, step: 0.01 },
  { path: 'bloom', label: 'Blooms', min: 0, max: 1, step: 0.01 },
  { path: 'bleed', label: 'Colour bleed', min: 0, max: 1, step: 0.01 },
  { path: 'pigmentWeight', label: 'Pigment weight', min: 0, max: 1, step: 0.01 },
  { path: 'pickup', label: 'Lifting', min: 0, max: 1, step: 0.01 },
  { path: 'fixture', label: 'Staining', min: 0, max: 1, step: 0.01 },
];

/** The canvas tilt sliders. */
export const WET_TILT_SLIDERS: readonly SliderControl[] = [
  { path: 'angle', label: 'Tilt', min: 0, max: 90, step: 1 },
  { path: 'direction', label: 'Downhill', min: 0, max: 359, step: 1 },
];

/** The speed slider (steps per second). */
export const WET_SPEED_SLIDER: SliderControl = { path: 'speed', label: 'Speed', min: 15, max: 480, step: 15 };

/** The wet-engine choices a panel offers (Engine B, the WebGPU accelerator). */
export const WET_GPU_OPTIONS: readonly { value: WetGpuMode; label: string }[] = [
  { value: 'auto', label: 'GPU for large washes' },
  { value: 'off', label: 'CPU only' },
];

/** One line saying what runs the wet paint (for panels). */
export function wetEngineSummary(e: WetEngineInfo): string {
  const gpu = e.adapter ? `GPU (${e.adapter})` : 'GPU';
  switch (e.state) {
    case 'off':
      return 'CPU only (GPU off).';
    case 'not-started':
      return 'The GPU starts with the first wet stroke.';
    case 'starting':
      return 'Starting the GPU…';
    case 'active':
      return `${gpu} shading ${e.activeTiles} wet tiles; the CPU keeps the result.`;
    case 'standby':
      return `${gpu} ready; it takes over at ${e.minTiles} wet tiles (${e.activeTiles} now).`;
    default:
      return e.reason ?? 'The GPU is not in use.';
  }
}

/**
 * Runs the wet paint's clock with the display: `controller.tickWet(now)` every animation frame
 * (it does nothing while nothing is wet or time is paused). Returns a function that stops it.
 * Bindings call it once per mounted canvas.
 */
export function startWetClock(controller: PaintEditorController, frame?: (cb: (t: number) => void) => number, cancel?: (id: number) => void): () => void {
  const g = globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number; cancelAnimationFrame?: (id: number) => void };
  const raf = frame ?? g.requestAnimationFrame;
  const caf = cancel ?? g.cancelAnimationFrame;
  if (!raf) return () => {};
  let stopped = false;
  let id = 0;
  const loop = (t: number) => {
    if (stopped) return;
    controller.tickWet(t).catch(() => {});
    id = raf(loop);
  };
  id = raf(loop);
  return () => {
    stopped = true;
    caf?.(id);
  };
}

/**
 * Draws the water overlay (blue where the surface is wet, faint where the paper is damp) into a
 * document-sized 2D context, clearing it first. Draws nothing when the overlay is off.
 */
export function drawWaterOverlay(controller: PaintEditorController, ctx: Paint2DContext & { clearRect(x: number, y: number, w: number, h: number): void }): number {
  const { width, height } = controller.document.canvas;
  ctx.clearRect(0, 0, width, height);
  if (!controller.getState().wet.overlay) return 0;
  const tiles = controller.waterOverlayTiles({ x: 0, y: 0, width, height });
  if (!tiles.length) return 0;
  const img = ctx.createImageData(TILE, TILE);
  for (const t of tiles) {
    img.data.set(t.data);
    ctx.putImageData(img as never, t.tx * TILE, t.ty * TILE, 0, 0, Math.min(TILE, width - t.tx * TILE), Math.min(TILE, height - t.ty * TILE));
  }
  return tiles.length;
}

/** Labels of the wet media, for the wet brush's medium menu. */
export const WET_MEDIUM_LABELS: Readonly<Record<WetMediumKind, string>> = { watercolor: 'Watercolour', gouache: 'Gouache', oil: 'Oil' };

/** Labels of the impasto tools. */
export const IMPASTO_TOOL_LABELS: Readonly<Record<ImpastoTool, string>> = { brush: 'Brush', tube: 'Paint tube', knife: 'Palette knife', roller: 'Roller', gloop: 'Gloop pen' };

/** The light sliders (thick paint and metallic paper). */
export const LIGHT_SLIDERS: readonly SliderControl[] = [
  { path: 'azimuth', label: 'Light direction', min: 0, max: 359, step: 1 },
  { path: 'elevation', label: 'Light height', min: 5, max: 90, step: 1 },
  { path: 'relief', label: 'Relief', min: 0, max: 1, step: 0.01 },
];

/** Labels of the particle kinds and renders. */
export const PARTICLE_KIND_LABELS: Readonly<Record<ParticleKind, string>> = { string: 'Strings', spring: 'Springs', orbit: 'Orbits', flow: 'Flow', elastic: 'Elastic', fuzzy: 'Fuzzy' };
export const PARTICLE_RENDER_LABELS: Readonly<Record<ParticleRender, string>> = { dot: 'Dots', line: 'Lines', sequence: 'Beads', ribbon: 'Ribbon' };
/** Labels of the ribbon pairings, textured-dot orders and textured-dot rotations. */
export const RIBBON_PAIR_LABELS: Readonly<Record<RibbonPairs, string>> = { adjacent: 'Neighbours', 'first-last': 'Outermost' };
export const DOT_TEXTURE_ORDER_LABELS: Readonly<Record<DotTextureOrder, string>> = { sequence: 'In turn', random: 'Random' };
export const DOT_ROTATION_LABELS: Readonly<Record<DotRotation, string>> = { follow: 'Follow motion', random: 'Random', fixed: 'Tip angle' };

/** Labels of the sticker stamps. */
export const STAMP_LABELS: Readonly<Record<StampKind, string>> = { dot: 'Dot', star: 'Star', heart: 'Heart', leaf: 'Leaf', flower: 'Flower', confetti: 'Confetti', splat: 'Splat', sparkle: 'Sparkle', ring: 'Ring' };

/** Toggles one stamp in a sticker brush's set (never leaving it empty). */
/**
 * Toggles a sticker ref in a sticker brush's list (`sticker.stamps`): removes it when present (a
 * brush keeps at least one), else adds it while there are fewer than `MAX_STICKER_STAMPS`.
 */
export function toggleStickerRef(refs: readonly StickerRef[], ref: StickerRef): StickerRef[] {
  if (refs.includes(ref)) return refs.length > 1 ? refs.filter((r) => r !== ref) : [...refs];
  return refs.length < MAX_STICKER_STAMPS ? [...refs, ref] : [...refs];
}

/** A short label for a sticker ref: the editor stamp's name, else the id after the provider. */
export function stickerRefLabel(ref: StickerRef): string {
  const stamp = ref.startsWith('editor:') ? (ref.slice(7) as StampKind) : null;
  if (stamp && STAMP_LABELS[stamp]) return STAMP_LABELS[stamp];
  return ref.slice(ref.indexOf(':') + 1);
}

export function toggleStamp(stamps: readonly StampKind[], stamp: StampKind): StampKind[] {
  const next = stamps.includes(stamp) ? stamps.filter((s) => s !== stamp) : [...stamps, stamp];
  return next.length ? next : [stamp];
}

/**
 * Toggles a textured-dot stamp (`particle.dotTextures`): removes it (every copy) when present,
 * else adds it while there are fewer than `MAX_DOT_TEXTURES`. Empty means round dots.
 */
export function toggleDotTexture(textures: readonly StampKind[], stamp: StampKind): StampKind[] {
  if (textures.includes(stamp)) return textures.filter((s) => s !== stamp);
  return textures.length < MAX_DOT_TEXTURES ? [...textures, stamp] : [...textures];
}

/** The sticker panel's sliders for the selected sticker. */
/** The brush sliders of a picked stroke on a stroke layer (paths into its brush; see `updateStroke`). */
export const STROKE_SLIDERS: readonly SliderControl[] = [
  { path: 'tip.size', label: 'Size', min: 1, max: 400, step: 1 },
  { path: 'tip.opacity', label: 'Opacity', min: 0, max: 1, step: 0.01 },
  { path: 'tip.flow', label: 'Flow', min: 0, max: 1, step: 0.01 },
];

export const STICKER_SLIDERS: readonly SliderControl[] = [
  { path: 'size', label: 'Size', min: 2, max: 400, step: 1 },
  { path: 'rotation', label: 'Rotation', min: -180, max: 180, step: 1 },
  { path: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01 },
];

/** Stencils a toolbar can lay with one click, centred on the canvas. */
export function quickStencil(kind: 'ruler' | 'circle' | 'ellipse-mask' | 'edge-mask', canvas: { width: number; height: number }): StencilInput {
  const { width: w, height: h } = canvas;
  switch (kind) {
    case 'ruler':
      return { kind: 'ruler', from: { x: w * 0.1, y: h / 2 }, to: { x: w * 0.9, y: h / 2 } };
    case 'circle':
      return { kind: 'arc', center: { x: w / 2, y: h / 2 }, radius: Math.min(w, h) * 0.3 };
    case 'ellipse-mask':
      return { kind: 'shape', shape: 'ellipse', rect: { x: w * 0.2, y: h * 0.2, width: w * 0.6, height: h * 0.6 } };
    case 'edge-mask':
      return { kind: 'line', from: { x: w / 2, y: 0 }, to: { x: w / 2, y: h } };
  }
}
