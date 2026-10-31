/**
 * The Content-Aware Fill workspace without a UI, shared by the React and Svelte workspaces: the
 * sampling area (where the fill may copy from) as a paintable mask over a window around the
 * selection, its presets (Auto, Rectangular, Custom), a live preview of the fill, and OK, which
 * applies it as one undo step through `contentAwareFillAsync` (the same fill the
 * `content_aware_fill` tool makes, with a sampling area).
 */

import type { ContentAwareFillOutput, ContentAwareFillPlan, ImageEditorController } from './controller';
import type { CropBox, ImagePoint } from './types';
import { selectionFromRegion, type SelectionMask } from './selection/mask';
import { distanceTransform } from './selection/modify';

export type ContentAwareFillSampling = 'auto' | 'rectangular' | 'custom';
export type ContentAwareFillTool = 'sampling-brush' | 'hand' | 'zoom';

export const CONTENT_AWARE_FILL_TOOLS: readonly { id: ContentAwareFillTool; label: string; key: string }[] = [
  { id: 'sampling-brush', label: 'Sampling Brush', key: 'b' },
  { id: 'hand', label: 'Hand', key: 'h' },
  { id: 'zoom', label: 'Zoom', key: 'z' },
];

export const CONTENT_AWARE_FILL_SAMPLING: readonly { id: ContentAwareFillSampling; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'rectangular', label: 'Rectangular' },
  { id: 'custom', label: 'Custom' },
];

export interface ContentAwareFillSettings {
  sampling: ContentAwareFillSampling;
  /** Show the sampling area as a green overlay on the source view. */
  showSampling: boolean;
  /** The overlay's opacity, 0..1. */
  opacity: number;
  tool: ContentAwareFillTool;
  /** Sampling Brush diameter in natural pixels. */
  brushSize: number;
  /** The Sampling Brush adds to the area or takes away from it. */
  brushMode: 'add' | 'subtract';
  /** The fill's random seed; another gives another fill to choose from. */
  seed: number;
  output: ContentAwareFillOutput;
  /** Update the preview as the area changes (otherwise with Preview). */
  livePreview: boolean;
}

export const DEFAULT_CONTENT_AWARE_FILL_SETTINGS: ContentAwareFillSettings = {
  sampling: 'auto',
  showSampling: true,
  opacity: 0.5,
  tool: 'sampling-brush',
  brushSize: 40,
  brushMode: 'add',
  seed: 0,
  output: 'new-layer',
  livePreview: true,
};

export class ContentAwareFillSession {
  private settingsValue: ContentAwareFillSettings = { ...DEFAULT_CONTENT_AWARE_FILL_SETTINGS };
  private plan: ContentAwareFillPlan | null = null;
  /** The source view's window (document pixels): the selection with room around it to sample. */
  private win: CropBox | null = null;
  private before: Uint8ClampedArray | null = null;
  private hole: Uint8Array | null = null;
  /** 1 where the fill may copy from, per window pixel. */
  private area: Uint8Array | null = null;
  private after: Uint8ClampedArray | null = null;
  private lastPoint: ImagePoint | null = null;
  private readonly listeners = new Set<() => void>();
  private dirty = false;
  /** Why the workspace can't fill (nothing selected, not a pixel layer), for the UI. */
  public error: string | null = null;
  public computing = false;
  public revision = 0;

  constructor(readonly controller: ImageEditorController) {}

  get settings(): ContentAwareFillSettings {
    return this.settingsValue;
  }

  /** The source view's window in document pixels (`null` until opened). */
  get window(): CropBox | null {
    return this.win;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.revision++;
    for (const l of this.listeners) l();
  }

  /** Images up to this many pixels show (and can be sampled) whole in the workspace. */
  static readonly WHOLE_IMAGE_PIXELS = 4_000_000;
  /** Room around the selection the window holds, in px each way. */
  private margin = 0;

  /**
   * Reads the layer and makes the first preview. The window is the whole image up to
   * {@link WHOLE_IMAGE_PIXELS}; on a larger one it holds the selection and room around it (twice
   * its larger side, at least 256 px, each way), and {@link expandView} widens it.
   */
  async open(): Promise<boolean> {
    try {
      const { width, height } = this.controller.getState().imageDimensions;
      const b = this.controller.getSelection()?.bounds;
      this.margin = width * height <= ContentAwareFillSession.WHOLE_IMAGE_PIXELS ? Math.max(width, height) : Math.max(256, 2 * Math.max(b?.width ?? 0, b?.height ?? 0));
      this.plan = this.controller.prepareContentAwareFill({ sampleRadius: this.margin });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.emit();
      return false;
    }
    this.win = this.plan.window;
    this.before = this.plan.before;
    this.hole = this.plan.hole;
    this.applySampling('auto');
    this.emit();
    await this.refresh();
    return true;
  }

  /** Whether the window shows the whole image (else {@link expandView} can widen it). */
  get showsWholeImage(): boolean {
    const { width, height } = this.controller.getState().imageDimensions;
    const w = this.win;
    return !w || (w.x === 0 && w.y === 0 && w.width >= width && w.height >= height);
  }

  /**
   * Doubles the room around the selection (up to the whole image), keeping what was painted; a
   * preset fills the new room as it would. Returns false when the whole image already shows.
   */
  expandView(): boolean {
    if (!this.win || this.showsWholeImage) return false;
    const { width, height } = this.controller.getState().imageDimensions;
    const old = { win: this.win, area: this.area! };
    this.margin = Math.min(Math.max(width, height), this.margin * 2);
    const plan = this.controller.prepareContentAwareFill({ layerId: this.plan!.layerId, sampleRadius: this.margin });
    this.plan = plan;
    this.win = plan.window;
    this.before = plan.before;
    this.hole = plan.hole;
    const mode = this.settingsValue.sampling;
    this.area = null;
    this.applySampling(mode === 'custom' ? 'auto' : mode);
    if (mode === 'custom') {
      // The painted area where it was; the new room starts unpainted.
      const area = new Uint8Array(plan.window.width * plan.window.height);
      for (let y = 0; y < old.win.height; y++) {
        const src = y * old.win.width;
        const dst = (old.win.y - plan.window.y + y) * plan.window.width + (old.win.x - plan.window.x);
        area.set(old.area.subarray(src, src + old.win.width), dst);
      }
      this.area = area;
    }
    this.emit();
    if (this.settingsValue.livePreview) void this.refresh();
    return true;
  }

  /** Sets the area to a preset: Auto (a band around the selection), Rectangular (the whole window). */
  private applySampling(mode: ContentAwareFillSampling): void {
    const win = this.win!;
    const hole = this.hole!;
    const n = win.width * win.height;
    const area = this.area && mode === 'custom' ? this.area : new Uint8Array(n);
    if (mode === 'rectangular') {
      for (let i = 0; i < n; i++) area[i] = hole[i] ? 0 : 1;
    } else if (mode === 'auto') {
      // Within half the selection's larger side (at least 24 px) of it.
      const b = this.plan!.bounds;
      const reach = Math.max(24, Math.max(b.width, b.height) / 2);
      const d = distanceTransform(hole, win.width, win.height);
      for (let i = 0; i < n; i++) area[i] = !hole[i] && d[i] <= reach ? 1 : 0;
    }
    this.area = area;
  }

  /** Changes settings; a sampling preset replaces the area, and the preview follows when live. */
  update(changes: Partial<ContentAwareFillSettings>): void {
    const prev = this.settingsValue;
    this.settingsValue = { ...prev, ...changes };
    if (!this.win) {
      this.emit();
      return;
    }
    if (changes.sampling && changes.sampling !== prev.sampling && changes.sampling !== 'custom') this.applySampling(changes.sampling);
    this.emit();
    const fillChanged = changes.sampling !== undefined || changes.seed !== undefined;
    if (fillChanged && this.settingsValue.livePreview) void this.refresh();
  }

  /** The sampling area as a selection of the whole image (what OK samples from). */
  samplingMask(): SelectionMask | null {
    if (!this.win || !this.area) return null;
    const { width, height } = this.controller.getState().imageDimensions;
    const bytes = new Uint8Array(this.area.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = this.area[i] ? 255 : 0;
    return selectionFromRegion(width, height, this.win, bytes);
  }

  /** Whether (x, y) in document pixels is in the sampling area. */
  samplesAt(x: number, y: number): boolean {
    const win = this.win;
    if (!win || !this.area) return false;
    const xi = Math.floor(x - win.x);
    const yi = Math.floor(y - win.y);
    if (xi < 0 || yi < 0 || xi >= win.width || yi >= win.height) return false;
    return this.area[yi * win.width + xi] === 1;
  }

  /** Paints the sampling area with the brush along a stroke segment (document pixels). */
  private paint(from: ImagePoint, to: ImagePoint, add: boolean): void {
    const win = this.win!;
    const area = this.area!;
    const hole = this.hole!;
    const r = Math.max(0.5, this.settingsValue.brushSize / 2);
    const x0 = Math.max(0, Math.floor(Math.min(from.x, to.x) - r - win.x));
    const y0 = Math.max(0, Math.floor(Math.min(from.y, to.y) - r - win.y));
    const x1 = Math.min(win.width - 1, Math.ceil(Math.max(from.x, to.x) + r - win.x));
    const y1 = Math.min(win.height - 1, Math.ceil(Math.max(from.y, to.y) + r - win.y));
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len2 = dx * dx + dy * dy;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = win.x + x + 0.5 - from.x;
        const py = win.y + y + 0.5 - from.y;
        const t = len2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / len2)) : 0;
        if ((px - t * dx) ** 2 + (py - t * dy) ** 2 > r * r) continue;
        const i = y * win.width + x;
        // The selection itself is never a source.
        area[i] = add && !hole[i] ? 1 : 0;
      }
    }
  }

  /** Pointer down with the Sampling Brush (Alt flips add and subtract). Returns false for other tools. */
  begin(point: ImagePoint, modifiers: { altKey?: boolean } = {}): boolean {
    if (this.settingsValue.tool !== 'sampling-brush' || !this.win) return false;
    const add = (this.settingsValue.brushMode === 'add') !== Boolean(modifiers.altKey);
    this.settingsValue = { ...this.settingsValue, sampling: 'custom' };
    this.lastPoint = point;
    this.strokeAdds = add;
    this.paint(point, point, add);
    this.emit();
    return true;
  }

  private strokeAdds = true;

  move(point: ImagePoint): void {
    if (!this.lastPoint) return;
    this.paint(this.lastPoint, point, this.strokeAdds);
    this.lastPoint = point;
    this.emit();
  }

  /** Pointer up: the preview follows the new area when live. */
  end(): void {
    if (!this.lastPoint) return;
    this.lastPoint = null;
    if (this.settingsValue.livePreview) void this.refresh();
  }

  /** Recomputes the preview: one at a time, the newest area following when one is running. */
  async refresh(): Promise<void> {
    if (!this.win) return;
    if (this.computing) {
      this.dirty = true;
      return;
    }
    this.computing = true;
    this.emit();
    do {
      this.dirty = false;
      try {
        const area = this.samplingMask();
        if (!area?.bounds) throw new Error('The sampling area is empty; paint where the fill may copy from.');
        const { plan, after } = await this.controller.previewContentAwareFill({ layerId: this.plan!.layerId, samplingArea: area, seed: this.settingsValue.seed });
        // The preview's window lies inside this one: put its pixels in place.
        const win = this.win;
        const out = Uint8ClampedArray.from(this.before!);
        const pw = plan.window;
        for (let y = 0; y < pw.height; y++) {
          out.set(after.subarray(y * pw.width * 4, (y + 1) * pw.width * 4), ((pw.y - win.y + y) * win.width + (pw.x - win.x)) * 4);
        }
        this.after = out;
        this.error = null;
      } catch (err) {
        this.after = null;
        this.error = err instanceof Error ? err.message : String(err);
      }
      this.emit();
    } while (this.dirty);
    this.computing = false;
    this.emit();
  }

  /** Resolves once no preview is being computed. */
  async idle(): Promise<void> {
    while (this.computing) await new Promise((r) => setTimeout(r, 5));
  }

  /** The source view: the layer's pixels, the selection tinted red, the sampling area green. RGBA at the window's size. */
  renderSource(): Uint8ClampedArray {
    if (!this.before || !this.area || !this.hole) return new Uint8ClampedArray(0);
    const out = Uint8ClampedArray.from(this.before);
    const k = this.settingsValue.showSampling ? Math.min(1, Math.max(0, this.settingsValue.opacity)) : 0;
    for (let i = 0; i < this.area.length; i++) {
      const p = i * 4;
      if (this.hole[i]) {
        out[p] = out[p] + (220 - out[p]) * 0.5;
        out[p + 1] *= 0.5;
        out[p + 2] *= 0.5;
      } else if (this.area[i] && k) {
        out[p] *= 1 - k;
        out[p + 1] = out[p + 1] + (200 - out[p + 1]) * k;
        out[p + 2] *= 1 - k;
      }
      out[p + 3] = 255;
    }
    return out;
  }

  /** The preview: the window with the fill in place (the source until the first preview). */
  renderPreview(): Uint8ClampedArray {
    const src = this.after ?? this.before;
    if (!src) return new Uint8ClampedArray(0);
    const out = Uint8ClampedArray.from(src);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    return out;
  }

  /** Clears painting and goes back to Auto. */
  reset(): void {
    if (!this.win) return;
    this.settingsValue = { ...DEFAULT_CONTENT_AWARE_FILL_SETTINGS, tool: this.settingsValue.tool };
    this.applySampling('auto');
    this.emit();
    if (this.settingsValue.livePreview) void this.refresh();
  }

  /**
   * Keys: B, H, Z for the tools, [ and ] for the brush size. Returns true when the key was used.
   */
  handleKey(key: string): boolean {
    const k = key.toLowerCase();
    const tool = CONTENT_AWARE_FILL_TOOLS.find((t) => t.key === k);
    if (tool) {
      this.update({ tool: tool.id });
      return true;
    }
    if (k === '[' || k === ']') {
      const size = this.settingsValue.brushSize;
      this.update({ brushSize: Math.max(1, Math.round(k === ']' ? size * 1.25 : size / 1.25)) });
      return true;
    }
    return false;
  }

  /** OK: fills with this sampling area, seed and output as one undo step. */
  async commit(options: { signal?: AbortSignal } = {}): Promise<{ layerId: string; bounds: CropBox; output: ContentAwareFillOutput }> {
    const area = this.samplingMask();
    if (!this.plan || !area?.bounds) throw new Error(this.error ?? 'The sampling area is empty; paint where the fill may copy from.');
    return this.controller.contentAwareFillAsync({ layerId: this.plan.layerId, samplingArea: area, seed: this.settingsValue.seed, output: this.settingsValue.output, signal: options.signal });
  }
}
