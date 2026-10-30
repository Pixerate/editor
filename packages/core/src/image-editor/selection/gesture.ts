import type { ImagePoint } from '../types';
import type { ImageEditorController } from '../controller';
import { ellipsePoints, normalizeRect } from './shapes';
import { selectionModeFromModifiers, type SelectionToolOptions } from './tool-options';
import { EdgeMap, liveWire, magneticAnchorSpacing, simplifyPixelPath, snapToEdge } from './magnetic';

interface MagneticDraft {
  /** The fixed outline so far (pixel centres), from the first anchor to the last. */
  fixed: ImagePoint[];
  /** Indices into `fixed` of the anchors, clicked or placed automatically. */
  anchors: number[];
  /** The live path from the last anchor to the pointer. */
  live: ImagePoint[];
  /** `null` until the pixels have been read. */
  edges: EdgeMap | null;
}

export interface GestureModifiers {
  shiftKey?: boolean;
  altKey?: boolean;
  /** The click count of a mouse event (2 on a double-click). */
  detail?: number;
}

/** `point` moved onto the nearest 45° ray from `from` (Shift with the polygonal lasso). */
export function snapTo45(from: ImagePoint, point: ImagePoint): ImagePoint {
  const dx = point.x - from.x;
  const dy = point.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return point;
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len };
}

/**
 * Pointer gestures of the selection tools, shared by the React and Svelte image editors: feed
 * it pointer positions in natural image pixels (`canvasToImagePoint(..., false)`).
 *
 * - Magic wand: selects on `begin` (async, as it may read pixels).
 * - Color Range: on `begin`, samples the colour under the pointer and selects every similar pixel
 *   (with the modifiers, Shift-click adds a colour and Alt-click removes one, as the + and −
 *   eyedroppers).
 * - Rectangle / ellipse: drag a box; a click without a drag deselects (replace mode).
 * - Lasso: drag a free-hand path, closed on `end`.
 * - Polygonal lasso: each click adds a corner (Shift: on a 45° ray from the last one), dragging
 *   adds a free-hand stretch; a double-click, a click on the first corner or Enter (`key`)
 *   closes it, Backspace removes the last corner and Escape cancels. It stays `active` between
 *   clicks, so feed it pointer moves without a button too.
 * - Magnetic lasso: a click sets the first anchor, then the outline follows the edges from the
 *   last anchor to the pointer (snapped to the strongest edge within the width) and places
 *   anchors as it goes (frequency); a click adds one, and closing and the keys are as the
 *   polygonal lasso's. The first click reads the pixels (async).
 * - Quick Selection: drag (or click) a brush stroke; on `end` it grows into the region painted on,
 *   out to its edges (async: await {@link settled}). With the New mode and a selection already
 *   there, strokes add, as in Photoshop; Alt subtracts.
 * - Single row / column: a click selects a 1 px line across the image.
 *
 * Shift adds, Alt subtracts, both intersect (overriding the options bar mode). While dragging,
 * {@link draftPath} is the outline to show (`RenderOptions.draftSelectionPath`).
 */
export class SelectionGesture {
  private start: ImagePoint | null = null;
  private points: ImagePoint[] = [];
  private current: ImagePoint | null = null;
  private modifiers: GestureModifiers = {};
  /** Polygonal lasso corners while one is being drawn. */
  private polygon: ImagePoint[] | null = null;
  private pressedAt: ImagePoint | null = null;
  private freehand = false;
  private magnetic: MagneticDraft | null = null;
  /** A click this close to the first corner (natural pixels) closes a polygonal lasso. */
  public closeRadius = 8;
  /** The last error (e.g. pixels unavailable for the wand), for the UI to show. */
  public error: string | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    readonly controller: ImageEditorController,
    private readonly getOptions: () => SelectionToolOptions
  ) {}

  get active(): boolean {
    return this.start !== null || this.polygon !== null || this.magnetic !== null;
  }

  /** Resolves once a Quick Selection stroke has been applied. */
  get settled(): Promise<void> {
    return this.pending;
  }

  /** The anchors of a Magnetic Lasso being drawn (empty otherwise). */
  get magneticAnchors(): ImagePoint[] {
    const m = this.magnetic;
    return m ? m.anchors.map((i) => m.fixed[i]) : [];
  }

  /** The outline of the shape being drawn, or `null`. */
  get draftPath(): ImagePoint[] | null {
    if (this.magnetic) return [...this.magnetic.fixed, ...this.magnetic.live.slice(1)];
    if (this.polygon) return this.current ? [...this.polygon, this.current] : this.polygon.slice();
    if (!this.start || !this.current) return null;
    const { tool } = this.getOptions();
    if (tool === 'lasso' || tool === 'quick') return this.points.length > 1 ? this.points.slice() : null;
    const rect = normalizeRect({
      x: this.start.x,
      y: this.start.y,
      width: this.current.x - this.start.x,
      height: this.current.y - this.start.y,
    });
    if (rect.width < 1 && rect.height < 1) return null;
    if (tool === 'ellipse') return ellipsePoints(rect);
    return [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.width, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height },
      { x: rect.x, y: rect.y + rect.height },
    ];
  }

  /** Pointer down. Resolves once a wand click has been applied. */
  async begin(point: ImagePoint, modifiers: GestureModifiers = {}): Promise<void> {
    const options = this.getOptions();
    this.error = null;
    if ((this.polygon && options.tool !== 'polygon') || (this.magnetic && options.tool !== 'magnetic')) this.cancel();
    if (options.tool === 'magnetic') return this.magneticClick(point, modifiers, options);
    if (options.tool === 'polygon') {
      this.pressedAt = point;
      this.freehand = false;
      if (!this.polygon) {
        this.modifiers = modifiers;
        this.polygon = [point];
        this.current = point;
        return;
      }
      const last = this.polygon[this.polygon.length - 1];
      const p = modifiers.shiftKey ? snapTo45(last, point) : point;
      const first = this.polygon[0];
      if (this.polygon.length >= 3 && Math.hypot(p.x - first.x, p.y - first.y) <= this.closeRadius) {
        this.close();
        return;
      }
      if (Math.hypot(p.x - last.x, p.y - last.y) >= 0.5) this.polygon.push(p);
      this.current = p;
      if ((modifiers.detail ?? 1) >= 2) this.close();
      return;
    }
    this.modifiers = modifiers;
    if (options.tool === 'row' || options.tool === 'column') {
      this.start = null;
      try {
        this.controller.selectLine(options.tool, options.tool === 'row' ? point.y : point.x, {
          mode: selectionModeFromModifiers(modifiers, options.mode),
          feather: options.feather ?? 0,
        });
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      }
      return;
    }
    if (options.tool === 'type' || options.tool === 'type-vertical') {
      // Type Mask: the click is the text's origin (vertical: the top of the first column's centre line).
      this.start = null;
      try {
        this.controller.selectTextShape({
          text: options.typeText || 'Type',
          x: point.x,
          y: point.y,
          orientation: options.tool === 'type-vertical' ? 'vertical' : 'horizontal',
          style: { fontSize: options.typeSize ?? 72, fontFamily: options.typeFamily || 'sans-serif' },
          mode: selectionModeFromModifiers(modifiers, options.mode),
          feather: options.feather ?? 0,
          antiAlias: options.antiAlias,
        });
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      }
      return;
    }
    if (options.tool === 'wand' || options.tool === 'range') {
      this.start = null;
      const common = {
        sampleMerged: options.sampleMerged,
        sample: options.sample,
        feather: options.feather ?? 0,
        mode: selectionModeFromModifiers(modifiers, options.mode),
      };
      try {
        if (options.tool === 'range') {
          const pixels = await this.controller.getSamplePixels(common);
          if (!pixels) throw new Error('The image pixels are not available to sample.');
          const x = Math.min(pixels.width - 1, Math.max(0, Math.floor(point.x)));
          const y = Math.min(pixels.height - 1, Math.max(0, Math.floor(point.y)));
          const p = (y * pixels.width + x) * 4;
          const color: [number, number, number] = [pixels.data[p], pixels.data[p + 1], pixels.data[p + 2]];
          await this.controller.selectColorRange([{ color, at: point }], {
            ...common,
            fuzziness: options.fuzziness ?? 40,
            localized: options.localized ? options.localized : undefined,
            invert: options.rangeInvert ?? false,
          });
          return;
        }
        await this.controller.magicWand(point, {
          ...common,
          tolerance: options.tolerance,
          contiguous: options.contiguous,
          antiAlias: options.antiAlias,
          distance: options.distance,
        });
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      }
      return;
    }
    this.start = point;
    this.current = point;
    this.points = [point];
  }

  /** Pointer move; returns true when the draft changed (re-render). */
  move(point: ImagePoint, modifiers: GestureModifiers = {}): boolean {
    if (this.magnetic) {
      this.current = point;
      this.followEdges(point);
      return true;
    }
    if (this.polygon) {
      const last = this.polygon[this.polygon.length - 1];
      if (this.pressedAt && (this.freehand || Math.hypot(point.x - this.pressedAt.x, point.y - this.pressedAt.y) >= 3)) {
        // Dragging with the button held draws free-hand, as the lasso does.
        this.freehand = true;
        if (Math.hypot(point.x - last.x, point.y - last.y) >= 0.5) this.polygon.push(point);
        this.current = null;
        return true;
      }
      this.current = modifiers.shiftKey ? snapTo45(last, point) : point;
      return true;
    }
    if (!this.start) return false;
    this.current = point;
    const drawn = this.getOptions().tool;
    if (drawn === 'lasso' || drawn === 'quick') {
      const last = this.points[this.points.length - 1];
      if (Math.hypot(point.x - last.x, point.y - last.y) < 0.5) return false;
      this.points.push(point);
    }
    return true;
  }

  /** Pointer up: commits the shape. Returns true when the selection changed. */
  end(point?: ImagePoint, modifiers?: GestureModifiers): boolean {
    if (this.magnetic) return false;
    if (this.polygon) {
      if (point && this.freehand) this.move(point);
      this.pressedAt = null;
      this.freehand = false;
      return false;
    }
    if (!this.start) return false;
    if (point) this.move(point);
    const options = this.getOptions();
    const mode = selectionModeFromModifiers(modifiers ?? this.modifiers, options.mode);
    if (options.tool === 'quick') {
      const stroke = this.points;
      this.start = null;
      this.current = null;
      this.points = [];
      // With New and a selection already there, the brush adds (Photoshop switches it to Add).
      const strokeMode = mode === 'replace' && this.controller.getSelection() ? 'add' : mode;
      this.pending = this.controller
        .quickSelect([stroke], {
          size: options.quickSize ?? 30,
          mode: strokeMode,
          sampleAllLayers: options.quickSampleAll ?? true,
          enhanceEdge: options.quickEnhance ?? false,
        })
        .then(
          () => undefined,
          (err) => {
            this.error = err instanceof Error ? err.message : String(err);
          }
        );
      return false;
    }
    const path = this.draftPath;
    const rect = normalizeRect({
      x: this.start.x,
      y: this.start.y,
      width: this.current!.x - this.start.x,
      height: this.current!.y - this.start.y,
    });
    this.start = null;
    this.current = null;
    this.points = [];
    if (!path) return mode === 'replace' ? this.controller.deselect() : false;
    const opts = { mode, antiAlias: options.antiAlias, feather: options.feather ?? 0 };
    if (options.tool === 'lasso') return path.length >= 3 ? this.controller.selectPolygon(path, opts) : false;
    return options.tool === 'ellipse' ? this.controller.selectEllipse(rect, opts) : this.controller.selectRect(rect, opts);
  }

  /** Closes a polygonal lasso and selects it. Returns true when the selection changed. */
  close(): boolean {
    let polygon = this.polygon;
    const m = this.magnetic;
    if (m) {
      // The last stretch follows the edges back to the first anchor.
      const tail = m.edges && m.fixed.length > 1 ? liveWire(m.edges, m.fixed[m.fixed.length - 1], m.fixed[0], this.corridor(m.fixed[m.fixed.length - 1], m.fixed[0])) : [];
      polygon = simplifyPixelPath([...m.fixed, ...tail.slice(1, -1)]);
    }
    if (!polygon) return false;
    const options = this.getOptions();
    this.cancel();
    if (polygon.length < 3) return false;
    return this.controller.selectPolygon(polygon, {
      mode: selectionModeFromModifiers(this.modifiers, options.mode),
      antiAlias: options.antiAlias,
      feather: options.feather ?? 0,
    });
  }

  /**
   * Keys for a polygonal lasso being drawn: Enter closes it, Escape cancels, Backspace / Delete
   * removes the last corner. Returns true when the key was used (the host prevents its default).
   */
  key(key: string): boolean {
    if (!this.polygon && !this.magnetic) return false;
    if (key === 'Enter') this.close();
    else if (key === 'Escape') this.cancel();
    else if (key === 'Backspace' || key === 'Delete') {
      const m = this.magnetic;
      if (m) {
        m.anchors.pop();
        if (!m.anchors.length) this.cancel();
        else {
          m.fixed.length = m.anchors[m.anchors.length - 1] + 1;
          m.live = [];
          // No anchors placed until the pointer moves again, or this one would come straight back.
          if (this.current) this.followEdges(this.current, false);
        }
      } else {
        this.polygon!.pop();
        if (!this.polygon!.length) this.cancel();
      }
    } else return false;
    return true;
  }

  /** Corridor half-width for a live-wire between two points. */
  private corridor(a: ImagePoint, b: ImagePoint): number {
    return Math.max(2 * (this.getOptions().magneticWidth ?? 10), 16, Math.hypot(b.x - a.x, b.y - a.y) / 4);
  }

  private async magneticClick(point: ImagePoint, modifiers: GestureModifiers, options: SelectionToolOptions): Promise<void> {
    const m = this.magnetic;
    if (!m) {
      this.modifiers = modifiers;
      const draft: MagneticDraft = { fixed: [point], anchors: [0], live: [], edges: null };
      this.magnetic = draft;
      this.current = point;
      try {
        const pixels = await this.controller.getSamplePixels({ sampleMerged: options.sampleMerged, sample: options.sample });
        if (!pixels) throw new Error('The image pixels are not available to find edges in.');
        if (this.magnetic !== draft) return;
        draft.edges = new EdgeMap(pixels, { contrast: (options.magneticContrast ?? 10) / 100 });
        draft.fixed = [snapToEdge(draft.edges, point, options.magneticWidth ?? 10)];
        if (this.current) this.followEdges(this.current);
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        if (this.magnetic === draft) this.cancel();
      }
      return;
    }
    const first = m.fixed[0];
    if (m.anchors.length >= 2 && Math.hypot(point.x - first.x, point.y - first.y) <= this.closeRadius) {
      this.close();
      return;
    }
    // A click fixes the live path and adds an anchor at its end.
    this.current = point;
    this.followEdges(point);
    if (m.live.length > 1) {
      m.fixed.push(...m.live.slice(1));
      m.anchors.push(m.fixed.length - 1);
      m.live = [];
    }
    if ((modifiers.detail ?? 1) >= 2) this.close();
  }

  /** Updates the live path to `point`, fixing anchors along it every `frequency` px (with `place`). */
  private followEdges(point: ImagePoint, place = true): void {
    const m = this.magnetic!;
    const last = () => m.fixed[m.fixed.length - 1];
    if (!m.edges) {
      m.live = [last(), point];
      return;
    }
    const options = this.getOptions();
    const target = snapToEdge(m.edges, point, options.magneticWidth ?? 10);
    const spacing = magneticAnchorSpacing(options.magneticFrequency ?? 57);
    for (let guard = 0; guard < 64; guard++) {
      const path = liveWire(m.edges, last(), target, this.corridor(last(), target));
      let length = 0;
      let k = 0;
      for (k = 1; k < path.length; k++) {
        length += Math.hypot(path[k].x - path[k - 1].x, path[k].y - path[k - 1].y);
        if (length >= spacing) break;
      }
      if (!place || k >= path.length - 1) {
        m.live = path;
        return;
      }
      m.fixed.push(...path.slice(1, k + 1));
      m.anchors.push(m.fixed.length - 1);
    }
    m.live = [last(), target];
  }

  /** Abandons a drag (or a polygonal lasso) without changing the selection. */
  cancel(): void {
    this.start = null;
    this.current = null;
    this.points = [];
    this.polygon = null;
    this.magnetic = null;
    this.pressedAt = null;
    this.freehand = false;
  }
}

/**
 * Edit shortcuts in select mode, as in Photoshop: Ctrl/⌘+C copies (with Shift, Copy Merged),
 * Ctrl/⌘+X cuts, Ctrl/⌘+V pastes (with Shift, in place; with Alt+Shift, into the selection),
 * Ctrl/⌘+D deselects, Ctrl/⌘+Shift+D reselects and Ctrl/⌘+Shift+I inverts. Returns true when
 * the key was used (the host prevents its default); errors go to `onError`.
 */
export function handleSelectionShortcut(
  controller: ImageEditorController,
  e: { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean },
  onError?: (message: string) => void
): boolean {
  if (!(e.ctrlKey || e.metaKey)) return false;
  const key = e.key.toLowerCase();
  const run = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    }
    return true;
  };
  if (key === 'c') return run(() => controller.copyPixels({ merged: Boolean(e.shiftKey) }));
  if (key === 'x' && !e.shiftKey) return run(() => controller.cutPixels());
  if (key === 'v') return run(() => controller.pastePixels(e.shiftKey && e.altKey ? 'into' : e.shiftKey ? 'in-place' : 'new-layer'));
  if (key === 'd') return run(() => (e.shiftKey ? controller.reselect() : controller.deselect()));
  if (key === 'i' && e.shiftKey) return run(() => controller.invertSelection());
  return false;
}

/**
 * The backslash key (no modifiers) shows or hides the active layer's mask as a red overlay; it
 * does nothing when the layer has no painted mask. Returns true when the key was used.
 */
export function handleMaskViewKey(controller: ImageEditorController, e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key !== '\\') return false;
  const id = controller.getState().activeLayerId;
  const layer = id ? controller.getLayer(id) : null;
  if (!layer?.mask || layer.mask.source) return false;
  const view = controller.getMaskView();
  controller.setMaskView(view?.layerId === layer.id && view.mode === 'overlay' ? 'off' : 'overlay', layer.id);
  return true;
}

/** Q (no modifiers) toggles Quick Mask mode. Returns true when the key was used. */
export function handleQuickMaskKey(controller: ImageEditorController, e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'q') return false;
  controller.setQuickMaskMode(!controller.quickMaskEditing);
  return true;
}
