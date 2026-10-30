import type { ImagePoint } from '../types';
import type { ImageEditorController } from '../controller';
import { ellipsePoints, normalizeRect } from './shapes';
import { selectionModeFromModifiers, type SelectionToolOptions } from './tool-options';

export interface GestureModifiers {
  shiftKey?: boolean;
  altKey?: boolean;
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
 *
 * Shift adds, Alt subtracts, both intersect (overriding the options bar mode). While dragging,
 * {@link draftPath} is the outline to show (`RenderOptions.draftSelectionPath`).
 */
export class SelectionGesture {
  private start: ImagePoint | null = null;
  private points: ImagePoint[] = [];
  private current: ImagePoint | null = null;
  private modifiers: GestureModifiers = {};
  /** The last error (e.g. pixels unavailable for the wand), for the UI to show. */
  public error: string | null = null;

  constructor(
    readonly controller: ImageEditorController,
    private readonly getOptions: () => SelectionToolOptions
  ) {}

  get active(): boolean {
    return this.start !== null;
  }

  /** The outline of the shape being drawn, or `null`. */
  get draftPath(): ImagePoint[] | null {
    if (!this.start || !this.current) return null;
    const { tool } = this.getOptions();
    if (tool === 'lasso') return this.points.length > 1 ? this.points.slice() : null;
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
    this.modifiers = modifiers;
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
  move(point: ImagePoint): boolean {
    if (!this.start) return false;
    this.current = point;
    if (this.getOptions().tool === 'lasso') {
      const last = this.points[this.points.length - 1];
      if (Math.hypot(point.x - last.x, point.y - last.y) < 0.5) return false;
      this.points.push(point);
    }
    return true;
  }

  /** Pointer up: commits the shape. Returns true when the selection changed. */
  end(point?: ImagePoint, modifiers?: GestureModifiers): boolean {
    if (!this.start) return false;
    if (point) this.move(point);
    const options = this.getOptions();
    const mode = selectionModeFromModifiers(modifiers ?? this.modifiers, options.mode);
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

  /** Abandons a drag without changing the selection. */
  cancel(): void {
    this.start = null;
    this.current = null;
    this.points = [];
  }
}
