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
import type { ImpastoTool, PaintBrush, PaintBrushInput, WetMediumKind, WetTool, LivePatternKind } from './brushes';
import { TILE, type RasterRect } from '../raster/surface';
import type { FillRegionOptions, PaintEditorController } from './controller';
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

export type PaintTool = 'brush' | 'fill' | 'eyedropper' | 'pan' | 'rotate' | 'sticker' | 'stroke';

export const PAINT_TOOLS: ReadonlyArray<{ id: PaintTool; label: string; key: string }> = [
  { id: 'brush', label: 'Brush', key: 'b' },
  { id: 'fill', label: 'Fill', key: 'g' },
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
  /** Filling a region: dragging horizontally adjusts the tolerance live (one undo step). */
  /** `committed`: the last fill made an undo step (an empty or refused fill makes none, so there is nothing to undo). */
  | { kind: 'fill'; pointerId: number; startX: number; p: Point2; baseTolerance: number; lastTolerance: number; committed: boolean }
  /** Dragging a stroke of a stroke layer: where the pointer went down and where it is now. */
  | { kind: 'move-stroke'; pointerId: number; id: string; from: Point2; to: Point2 }
  /** Dragging a sticker: (dx, dy) from the pointer to its centre, and where it was last shown. */
  | { kind: 'sticker'; pointerId: number; id: string; dx: number; dy: number; at: Point2 | null }
  | { kind: 'pan'; pointerId: number; x: number; y: number; pan: Point2 } | { kind: 'rotate'; pointerId: number; angle: number; rotation: number } | null;

export class PaintGesture {
  tool: PaintTool = 'brush';
  /** Options the Fill tool (`tool === 'fill'`) passes to `fillRegion` (click to fill; drag horizontally to adjust tolerance). */
  fillOptions: Omit<FillRegionOptions, 'x' | 'y' | 'points'> = { reference: 'all', tolerance: 32, closeGap: 4, expand: 1, antialias: true };
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
    if (tool === 'fill') return this.fillDown(e);
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

  private fillDown(e: PaintPointerEvent): boolean {
    const p = this.doc(e);
    const baseTolerance = this.fillOptions.tolerance ?? 32;
    try {
      const filled = this.controller.fillRegion({ ...this.fillOptions, tolerance: baseTolerance, x: p.x, y: p.y });
      this.mode = { kind: 'fill', pointerId: e.pointerId, startX: e.clientX, p, baseTolerance, lastTolerance: baseTolerance, committed: filled.bounds !== null };
      return true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return false;
    }
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
    if (m.kind === 'fill') {
      const dx = e.clientX - m.startX;
      if (Math.abs(dx) < 4) return;
      const nextTol = Math.max(0, Math.min(255, Math.round(m.baseTolerance + dx * 0.5)));
      if (nextTol === m.lastTolerance) return;
      m.lastTolerance = nextTol;
      try {
        // Only take back this gesture's own fill: an empty fill made no undo step.
        if (m.committed) this.controller.undo();
        m.committed = false;
        m.committed = this.controller.fillRegion({ ...this.fillOptions, tolerance: nextTol, x: m.p.x, y: m.p.y }).bounds !== null;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      }
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
    if (m.kind === 'stroke') {
      this.controller.activeStroke?.end();
      this.controller.strokeRendering?.catch((err) => {
        this.error = err instanceof Error ? err.message : String(err);
      });
    }
    if (m.kind === 'move-stroke') {
      const dx = Math.round((this.doc(e).x - m.from.x) * 100) / 100;
      const dy = Math.round((this.doc(e).y - m.from.y) * 100) / 100;
      if (dx || dy) {
        const edit = { transform: { dx, dy } };
        const failed = (err: unknown) => {
          this.error = err instanceof Error ? err.message : String(err);
        };
        // A path-mapped stroke has to render its moved path first.
        if (this.controller.strokeEditNeedsRender(m.id, edit)) {
          this.controller.prepareStrokeEdit(m.id, edit).then(() => this.controller.editStrokePoints(m.id, edit)).catch(failed);
        } else {
          try {
            this.controller.editStrokePoints(m.id, edit);
          } catch (err) {
            failed(err);
          }
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
    if (this.mode?.kind === 'fill' && this.mode.committed) this.controller.undo();
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

/** A keyboard command of the paint editor (`PAINT_SHORTCUTS`). */
export interface PaintShortcut {
  /** Stable id, e.g. `undo` or `tool.brush`. */
  id: string;
  label: string;
  group: 'edit' | 'tools' | 'brush' | 'colour' | 'view';
  /** Keys that run it: `Mod` is Ctrl or Cmd; letters are matched case-insensitively. */
  keys: readonly string[];
  /** The agent tool that does the same, when there is one. */
  tool?: string;
}

/** The keyboard commands both editors handle (`handlePaintShortcut`), in the order it checks them. */
export const PAINT_SHORTCUTS: readonly PaintShortcut[] = [
  { id: 'undo', label: 'Undo', group: 'edit', keys: ['Mod+Z'], tool: 'undo_paint' },
  { id: 'redo', label: 'Redo', group: 'edit', keys: ['Mod+Shift+Z', 'Mod+Y'], tool: 'redo_paint' },
  ...PAINT_TOOLS.map((t) => ({ id: `tool.${t.id}`, label: t.label, group: 'tools' as const, keys: [t.key.toUpperCase()] })),
  { id: 'brush.smaller', label: 'Smaller brush', group: 'brush', keys: ['['], tool: 'set_brush' },
  { id: 'brush.larger', label: 'Larger brush', group: 'brush', keys: [']'], tool: 'set_brush' },
  { id: 'colour.swap', label: 'Swap colours', group: 'colour', keys: ['X'] },
  { id: 'view.mirror', label: 'Mirror the view', group: 'view', keys: ['M'], tool: 'set_view' },
  { id: 'view.reset', label: 'Reset the view', group: 'view', keys: ['Escape'], tool: 'set_view' },
];

/** The shortcut `e` presses, if any. */
export function paintShortcutFor(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): PaintShortcut | null {
  if (!e.key) return null;
  const parts = [...(e.ctrlKey || e.metaKey ? ['Mod'] : []), ...(e.shiftKey && (e.ctrlKey || e.metaKey) ? ['Shift'] : [])];
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key[0].toUpperCase() + e.key.slice(1).toLowerCase();
  const combo = [...parts, key].join('+');
  return PAINT_SHORTCUTS.find((s) => s.keys.includes(combo)) ?? null;
}

/** Keyboard shortcuts shared by both editors (`PAINT_SHORTCUTS`); returns true when it handled the key. */
export function handlePaintShortcut(
  controller: PaintEditorController,
  gesture: PaintGesture,
  e: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; target?: unknown }
): boolean {
  const shortcut = paintShortcutFor(e);
  if (!shortcut) return false;
  const id = shortcut.id;
  if (id === 'undo' || id === 'redo') {
    if (controller.getState().stroking && !(id === 'redo' && e.key.toLowerCase() === 'y')) return true;
    if (id === 'undo') controller.undo();
    else controller.redo();
    return true;
  }
  if (id.startsWith('tool.')) {
    gesture.tool = id.slice(5) as PaintTool;
    return true;
  }
  if (id === 'brush.smaller' || id === 'brush.larger') {
    const brush = controller.getState().brush;
    const step = Math.max(1, Math.round(brush.tip.size * 0.15));
    controller.setBrush({ tip: { size: Math.max(1, brush.tip.size + (id === 'brush.larger' ? step : -step)) } });
    return true;
  }
  if (id === 'colour.swap') controller.swapColors();
  else if (id === 'view.mirror') controller.setView({ mirror: !controller.getState().view.mirror });
  else if (id === 'view.reset') controller.resetView();
  return true;
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

export { BRUSH_SLIDERS, brushEngineControls, GHOST_SLIDERS, IRIDESCENCE_SLIDERS, multiColorSliders, MUTATION_SLIDERS, patchBrushValue, type BrushEngineControls, type SliderControl } from './brush-controls';
import type { SliderControl } from './brush-controls';

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

/** Labels of the Gray-Scott live pattern kinds. */
export const LIVE_PATTERN_LABELS: Readonly<Record<LivePatternKind, string>> = {
  spots: 'Spots',
  stripes: 'Stripes',
  coral: 'Coral',
  maze: 'Maze',
  worms: 'Worms',
};

/** The wet panel's sliders for a layer's live patterns. */
export const LIVE_PATTERN_SLIDERS: readonly SliderControl[] = [
  { path: 'scale', label: 'Scale', min: 0.25, max: 4, step: 0.05 },
  { path: 'contrast', label: 'Contrast', min: 0, max: 2, step: 0.05 },
  { path: 'relief', label: 'Relief', min: 0, max: 1, step: 0.01 },
];

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

/** The UV blacklight sliders. */
export const UV_LIGHT_SLIDERS: readonly SliderControl[] = [
  { path: 'strength', label: 'UV strength', min: 0, max: 2, step: 0.05 },
  { path: 'ambient', label: 'Ambient light', min: 0, max: 1, step: 0.01 },
];

/** The view tilt sliders (thin-film iridescence and specular highlights). */
export const VIEW_TILT_SLIDERS: readonly SliderControl[] = [
  { path: 'x', label: 'View tilt X', min: -1, max: 1, step: 0.01 },
  { path: 'y', label: 'View tilt Y', min: -1, max: 1, step: 0.01 },
];

/**
 * Maps `DeviceOrientationEvent` angles (`beta` front-to-back in degrees, `gamma` left-to-right in
 * degrees) relative to `rest` (default `{ beta: 45, gamma: 0 }`, a tablet held in hand) into a
 * `viewTilt` in `-1..1` (35° reaches full tilt), rounded to 0.01.
 */
export function deviceOrientationToViewTilt(
  betaOrEvent: number | { beta?: number | null; gamma?: number | null } | null | undefined,
  gammaOrRest?: number | { beta: number; gamma: number } | null | undefined,
  rest: { beta: number; gamma: number } = { beta: 45, gamma: 0 }
): { x: number; y: number } {
  const isObj = typeof betaOrEvent === 'object' && betaOrEvent !== null;
  const r = isObj && typeof gammaOrRest === 'object' && gammaOrRest !== null ? gammaOrRest : rest;
  const rawBeta = isObj ? betaOrEvent.beta : betaOrEvent;
  const rawGamma = isObj ? betaOrEvent.gamma : typeof gammaOrRest === 'number' ? gammaOrRest : undefined;
  const b = typeof rawBeta === 'number' && Number.isFinite(rawBeta) ? rawBeta : r.beta;
  const g = typeof rawGamma === 'number' && Number.isFinite(rawGamma) ? rawGamma : r.gamma;
  const clamp = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 100) / 100;
  return { x: clamp((g - r.gamma) / 35), y: clamp((b - r.beta) / 35) };
}

/**
 * Asks iOS Safari for `DeviceOrientationEvent` permission when `requestPermission` is present
 * (must be called from a user gesture on iOS 13+). Resolves to `'granted'` on browsers that do not
 * gate `deviceorientation` behind a permission prompt, or `'unsupported'` without `DeviceOrientationEvent`.
 */
export async function requestDeviceTiltPermission(): Promise<'granted' | 'denied' | 'unsupported'> {
  const g = globalThis as {
    DeviceOrientationEvent?: {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
  };
  if (!g.DeviceOrientationEvent) return 'unsupported';
  if (typeof g.DeviceOrientationEvent.requestPermission === 'function') {
    try {
      return (await g.DeviceOrientationEvent.requestPermission()) === 'granted' ? 'granted' : 'denied';
    } catch {
      return 'denied';
    }
  }
  return 'granted';
}

/**
 * Listens to `deviceorientation` events on `globalThis` and updates `controller.setViewTilt` relative
 * to the first reading's orientation. Returns a cleanup function.
 */
export function startDeviceTilt(controller: PaintEditorController): () => void {
  const g = globalThis as {
    addEventListener?: (type: string, listener: (e: { beta?: number | null; gamma?: number | null }) => void) => void;
    removeEventListener?: (type: string, listener: (e: { beta?: number | null; gamma?: number | null }) => void) => void;
  };
  if (typeof g.addEventListener !== 'function') return () => {};
  let rest: { beta: number; gamma: number } | null = null;
  const onOrientation = (e: { beta?: number | null; gamma?: number | null }) => {
    if (typeof e.beta !== 'number' || typeof e.gamma !== 'number') return;
    if (!rest) rest = { beta: e.beta, gamma: e.gamma };
    const next = deviceOrientationToViewTilt(e.beta, e.gamma, rest);
    const cur = controller.getViewTilt();
    if (next.x !== cur.x || next.y !== cur.y) controller.setViewTilt(next);
  };
  g.addEventListener('deviceorientation', onOrientation);
  return () => {
    g.removeEventListener?.('deviceorientation', onOrientation);
  };
}

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

/** Pressure profiles the "Brush a path" panel offers for `strokePath` (`pressure` undefined: even). */
export const PATH_STROKE_TAPERS: ReadonlyArray<{ id: string; label: string; pressure?: readonly number[] }> = [
  { id: 'even', label: 'Even' },
  { id: 'both', label: 'Taper both ends', pressure: [0.2, 1, 0.2] },
  { id: 'in', label: 'Fade in', pressure: [0.2, 1] },
  { id: 'out', label: 'Fade out', pressure: [1, 0.2] },
];

/** The brush sliders of a picked stroke on a stroke layer (paths into its brush; see `updateStroke`). */
export const STROKE_SLIDERS: readonly SliderControl[] = [
  { path: 'tip.size', label: 'Size', min: 1, max: 400, step: 1 },
  { path: 'tip.opacity', label: 'Opacity', min: 0, max: 1, step: 0.01 },
  { path: 'tip.flow', label: 'Flow', min: 0, max: 1, step: 0.01 },
];

/** The sticker panel's sliders for the selected sticker. */
export const STICKER_SLIDERS: readonly SliderControl[] = [
  { path: 'size', label: 'Size', min: 2, max: 400, step: 1 },
  { path: 'rotation', label: 'Rotation', min: -180, max: 180, step: 1 },
  { path: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01 },
];

/** The evolution panel's mutation sliders (`0..1`). */
export const EVOLUTION_SLIDERS: readonly SliderControl[] = [
  { path: 'geometry', label: 'Geometry', min: 0, max: 1, step: 0.05 },
  { path: 'color', label: 'Colour', min: 0, max: 1, step: 0.05 },
  { path: 'brush', label: 'Brush', min: 0, max: 1, step: 0.05 },
  { path: 'seed', label: 'Seed', min: 0, max: 1, step: 0.05 },
];

/** The ferrofluid panel's sliders for a magnet (`strength` and `radius`). */
export const MAGNET_SLIDERS: readonly SliderControl[] = [
  { path: 'strength', label: 'Strength', min: -1, max: 1, step: 0.05 },
  { path: 'radius', label: 'Radius', min: 4, max: 512, step: 1 },
];

/** The time machine panel's sliders for ageing (`years`, `varnish`, `cracks`, `fading`, `dust`). */
export const AGE_SLIDERS: readonly SliderControl[] = [
  { path: 'years', label: 'Years', min: 0, max: 500, step: 5 },
  { path: 'varnish', label: 'Varnish yellowing', min: 0, max: 1, step: 0.01 },
  { path: 'cracks', label: 'Cracks (craquelure)', min: 0, max: 1, step: 0.01 },
  { path: 'fading', label: 'Pigment fading', min: 0, max: 1, step: 0.01 },
  { path: 'dust', label: 'Dust & patina', min: 0, max: 1, step: 0.01 },
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
