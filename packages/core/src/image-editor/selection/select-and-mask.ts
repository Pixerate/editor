/**
 * The Select and Mask workspace without a UI: its settings, strokes, preview and view modes, shared
 * by the React and Svelte workspaces. Everything it holds is plain data (the strokes are
 * `RefineEdit`s), and OK runs the same `refineSelectionTo` call an agent makes with `edits`, so
 * the workspace and an agent produce the same result in one undo step.
 *
 * The preview is computed on a copy reduced to {@link PREVIEW_SIZE} px (or at full size with High
 * Quality Preview), in the controller's selection worker when it has one, and drawn as RGBA in
 * the chosen view mode.
 */

import type { ImageEditorController, RefineOutput, RefineOutputResult } from '../controller';
import type { ImagePoint } from '../types';
import { createSelectionMask, resizeSelection, type PixelBuffer, type SelectionMask } from './mask';
import { DEFAULT_REFINE_EDGE_PARAMS, refineSelection, type RefineEdgeParams } from './refine';
import { applyRefineEdits, type RefineEdit } from './refine-edits';
import { serializeMask } from './worker';
import { flattenLayers } from '../layers/model';

export type SelectAndMaskView = 'onion-skin' | 'marching-ants' | 'overlay' | 'on-black' | 'on-white' | 'black-white' | 'on-layers';
export type SelectAndMaskTool = 'quick-select' | 'refine-brush' | 'brush' | 'object' | 'lasso' | 'hand' | 'zoom';

/** The view modes with Photoshop's keys, in menu order. */
export const SELECT_AND_MASK_VIEWS: readonly { id: SelectAndMaskView; label: string; key: string; opacity: number }[] = [
  { id: 'onion-skin', label: 'Onion Skin', key: 'o', opacity: 0.5 },
  { id: 'marching-ants', label: 'Marching Ants', key: 'm', opacity: 1 },
  { id: 'overlay', label: 'Overlay', key: 'v', opacity: 0.5 },
  { id: 'on-black', label: 'On Black', key: 'a', opacity: 1 },
  { id: 'on-white', label: 'On White', key: 't', opacity: 1 },
  { id: 'black-white', label: 'Black & White', key: 'k', opacity: 1 },
  { id: 'on-layers', label: 'On Layers', key: 'y', opacity: 1 },
];

/** The workspace tools with Photoshop's keys. */
export const SELECT_AND_MASK_TOOLS: readonly { id: SelectAndMaskTool; label: string; key: string }[] = [
  { id: 'quick-select', label: 'Quick Selection', key: 'w' },
  { id: 'refine-brush', label: 'Refine Edge Brush', key: 'r' },
  { id: 'brush', label: 'Brush', key: 'b' },
  { id: 'object', label: 'Object Selection', key: 'q' },
  { id: 'lasso', label: 'Lasso', key: 'l' },
  { id: 'hand', label: 'Hand', key: 'h' },
  { id: 'zoom', label: 'Zoom', key: 'z' },
];

export interface SelectAndMaskSettings {
  params: Required<RefineEdgeParams>;
  output: RefineOutput;
  /** Decontaminate Colors amount 0..100 (new-layer outputs). */
  decontaminate: number;
  refineMode: 'color' | 'object';
  view: SelectAndMaskView;
  /** How strongly the view shows what is not selected, 0..1. */
  opacity: number;
  /** Show only the area the refinement changes. */
  showEdge: boolean;
  /** Show the selection as it was, before the workspace. */
  showOriginal: boolean;
  /** Update the preview while painting (otherwise on release). */
  realTime: boolean;
  /** Preview at full size instead of a reduced copy. */
  highQuality: boolean;
  /** Keep these settings for the next time the workspace opens. */
  remember: boolean;
  tool: SelectAndMaskTool;
  /** Brush diameter in natural pixels. */
  brushSize: number;
  brushMode: 'add' | 'subtract';
}

export const DEFAULT_SELECT_AND_MASK_SETTINGS: SelectAndMaskSettings = {
  params: { ...DEFAULT_REFINE_EDGE_PARAMS },
  output: 'selection',
  decontaminate: 0,
  refineMode: 'color',
  view: 'onion-skin',
  opacity: 0.5,
  showEdge: false,
  showOriginal: false,
  realTime: true,
  highQuality: false,
  remember: false,
  tool: 'quick-select',
  brushSize: 30,
  brushMode: 'add',
};

/** Long side of the reduced preview. */
export const PREVIEW_SIZE = 1024;

/** Settings kept by Remember Settings (for this page's lifetime). */
let remembered: SelectAndMaskSettings | null = null;

/** `pixels` box-averaged to `w × h`. */
function scalePixels(pixels: PixelBuffer, w: number, h: number): PixelBuffer {
  if (w === pixels.width && h === pixels.height) return pixels;
  const { width: W, height: H, data } = pixels;
  const sum = new Float64Array(w * h * 4);
  const count = new Float64Array(w * h);
  for (let y = 0; y < H; y++) {
    const row = Math.min(h - 1, Math.floor((y * h) / H)) * w;
    for (let x = 0; x < W; x++) {
      const o = row + Math.min(w - 1, Math.floor((x * w) / W));
      const p = (y * W + x) * 4;
      for (let c = 0; c < 4; c++) sum[o * 4 + c] += data[p + c];
      count[o]++;
    }
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 4; c++) out[i * 4 + c] = sum[i * 4 + c] / (count[i] || 1);
  return { width: w, height: h, data: out };
}

/** `edit` with its coordinates and sizes multiplied by `s`. */
function scaleEdit(edit: RefineEdit, s: number): RefineEdit {
  const pt = (p: ImagePoint) => ({ x: p.x * s, y: p.y * s });
  if (edit.kind === 'object') {
    return { ...edit, rect: edit.rect && { x: edit.rect.x * s, y: edit.rect.y * s, width: edit.rect.width * s, height: edit.rect.height * s }, point: edit.point && pt(edit.point) };
  }
  const scaled = { ...edit, points: edit.points.map(pt) } as RefineEdit & { size?: number };
  if ('size' in edit && edit.size !== undefined) scaled.size = Math.max(1, edit.size * s);
  return scaled;
}

function scaleParams(p: Required<RefineEdgeParams>, s: number): Required<RefineEdgeParams> {
  return { ...p, radius: p.radius * s, feather: p.feather * s };
}

export class SelectAndMaskSession {
  private settingsValue: SelectAndMaskSettings;
  private readonly editsList: RefineEdit[] = [];
  /** The edit being painted, shown in the preview but not yet in `edits`. */
  private live: RefineEdit | null = null;
  private dragStart: ImagePoint | null = null;
  private pixels: PixelBuffer | null = null;
  private previewPixels: PixelBuffer | null = null;
  /** The layers below the active one, composited (On Layers shows them where nothing is selected). */
  private below: PixelBuffer | null = null;
  private belowPreview: PixelBuffer | null = null;
  private base: SelectionMask | null;
  private previewMask: SelectionMask | null = null;
  private baseMask: SelectionMask | null = null;
  private readonly listeners = new Set<() => void>();
  /** Why the preview could not be made (no pixels), for the UI. */
  public error: string | null = null;
  /** A note for the UI, such as object aware refinement applying only on OK. */
  public note: string | null = null;
  /** Bumped each time the preview changes, so a UI can redraw. */
  public revision = 0;
  /** True while the worker computes a preview. */
  public computing = false;
  private dirty = false;

  constructor(readonly controller: ImageEditorController) {
    this.base = controller.getSelection();
    this.settingsValue = remembered ? { ...remembered, params: { ...remembered.params }, showOriginal: false } : { ...DEFAULT_SELECT_AND_MASK_SETTINGS, params: { ...DEFAULT_SELECT_AND_MASK_SETTINGS.params } };
  }

  get settings(): SelectAndMaskSettings {
    return this.settingsValue;
  }

  get edits(): readonly RefineEdit[] {
    return this.editsList;
  }

  /** Reads the image and makes the first preview. Resolves to false when the pixels are unavailable. */
  async open(): Promise<boolean> {
    try {
      this.pixels = await this.controller.getSamplePixels({});
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
    if (!this.pixels) {
      this.error ??= 'The image pixels are not available, so Select and Mask cannot preview.';
      this.emit();
      return false;
    }
    this.below = this.layersBelow();
    this.rescale();
    this.recompute();
    return true;
  }

  /** The visible layers under the active one, composited at full size, or null when there are none. */
  private layersBelow(): PixelBuffer | null {
    const active = this.controller.getState().activeLayerId;
    const flat = flattenLayers(this.controller.getLayers()).filter((l) => l.type !== 'group');
    const at = flat.findIndex((l) => l.id === active);
    const ids = (at > 0 ? flat.slice(0, at) : []).filter((l) => l.visible).map((l) => l.id);
    if (!ids.length) return null;
    try {
      return this.controller.compositePixels(undefined, { layerIds: ids });
    } catch {
      return null;
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.revision++;
    for (const l of this.listeners) l();
  }

  /** Preview size and the scale from natural pixels to it. */
  get previewSize(): { width: number; height: number; scale: number } {
    const p = this.previewPixels;
    if (!p || !this.pixels) return { width: 0, height: 0, scale: 1 };
    return { width: p.width, height: p.height, scale: p.width / this.pixels.width };
  }

  /** Changes settings; the preview follows. Choosing a view also sets its usual opacity. */
  update(changes: Partial<SelectAndMaskSettings>): void {
    const next = { ...this.settingsValue, ...changes, params: { ...this.settingsValue.params, ...(changes.params ?? {}) } };
    if (changes.view && changes.view !== this.settingsValue.view && changes.opacity === undefined) {
      next.opacity = SELECT_AND_MASK_VIEWS.find((v) => v.id === changes.view)!.opacity;
    }
    const rescale = next.highQuality !== this.settingsValue.highQuality;
    this.settingsValue = next;
    if (rescale) this.rescale();
    this.recompute();
  }

  private rescale(): void {
    const px = this.pixels;
    if (!px) return;
    const s = this.settingsValue.highQuality ? 1 : Math.min(1, PREVIEW_SIZE / Math.max(px.width, px.height));
    const w = Math.max(1, Math.round(px.width * s));
    const h = Math.max(1, Math.round(px.height * s));
    this.previewPixels = scalePixels(px, w, h);
    this.belowPreview = this.below ? scalePixels(this.below, w, h) : null;
    this.baseMask = this.base?.bounds ? (s === 1 ? this.base : resizeSelection(this.base, w, h)) : null;
  }

  /**
   * Recomputes the preview mask from the base selection, the strokes and the settings: at once on
   * the page, or in the worker, where one job runs at a time and the newest state follows it.
   */
  recompute(): void {
    const px = this.previewPixels;
    if (!px) return;
    this.note = this.settingsValue.refineMode === 'object' ? 'Object aware refinement asks the segmentation model on OK; the preview refines by colour.' : null;
    if (this.controller.hasSelectionWorker) {
      void this.recomputeInWorker();
      return;
    }
    const { scale } = this.previewSize;
    const edits = [...this.editsList, ...(this.live ? [this.live] : [])].map((e) => scaleEdit(e, scale));
    try {
      const { selection, refineBrush } = applyRefineEdits(px, this.baseMask, edits, px.width, px.height);
      this.previewMask = selection?.bounds ? refineSelection(px, selection, scaleParams(this.settingsValue.params, scale), refineBrush) : null;
      this.error = null;
    } catch (err) {
      this.previewMask = null;
      this.error = err instanceof Error ? err.message : String(err);
    }
    this.emit();
  }

  private async recomputeInWorker(): Promise<void> {
    if (this.computing) {
      this.dirty = true;
      return;
    }
    this.computing = true;
    do {
      this.dirty = false;
      const px = this.previewPixels!;
      const { scale } = this.previewSize;
      const edits = [...this.editsList, ...(this.live ? [this.live] : [])].map((e) => scaleEdit(e, scale));
      try {
        const { mask } = await this.controller.runSelectionJob(
          { op: 'refine-preview', base: this.baseMask ? serializeMask(this.baseMask) : null, edits, params: scaleParams(this.settingsValue.params, scale) },
          px
        );
        this.previewMask = mask.bounds ? mask : null;
        this.error = null;
      } catch (err) {
        this.previewMask = null;
        this.error = err instanceof Error ? err.message : String(err);
      }
      this.emit();
    } while (this.dirty);
    this.computing = false;
    this.emit();
  }

  /** Resolves once no preview is being computed (immediately without a worker). */
  async idle(): Promise<void> {
    while (this.computing) await new Promise((r) => setTimeout(r, 5));
  }

  /** Coverage 0..1 of the preview at (x, y) in preview pixels (for tests and hover readouts). */
  coverageAt(x: number, y: number): number {
    const m = this.settingsValue.showOriginal ? this.baseMask : this.previewMask;
    if (!m) return 0;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= m.width || yi >= m.height) return 0;
    return m.data[yi * m.width + xi] / 255;
  }

  /** The preview drawn in the current view mode: RGBA at {@link previewSize}. */
  render(): Uint8ClampedArray {
    const px = this.previewPixels;
    if (!px) return new Uint8ClampedArray(0);
    const { width: w, height: h } = px;
    const n = w * h;
    const s = this.settingsValue;
    const mask = (s.showOriginal ? this.baseMask : this.previewMask) ?? createSelectionMask(w, h);
    const m = mask.data;
    const out = new Uint8ClampedArray(n * 4);
    const k = Math.min(1, Math.max(0, s.opacity));
    // Show Edge: only the band the refinement works in, the rest dimmed to black.
    let edgeBand: Uint8Array | null = null;
    if (s.showEdge) {
      edgeBand = new Uint8Array(n);
      const r = Math.max(1, Math.round(Math.max(s.params.radius, 2) * this.previewSize.scale));
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = m[y * w + x];
          if (v <= 3 || v >= 252) continue;
          for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) edgeBand.fill(1, j * w + Math.max(0, x - r), j * w + Math.min(w, x + r + 1));
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const a = m[i] / 255;
      const p = i * 4;
      const r = px.data[p];
      const g = px.data[p + 1];
      const b = px.data[p + 2];
      let o: [number, number, number];
      const x = i % w;
      const y = (i - x) / w;
      const checker = ((x >> 3) + (y >> 3)) % 2 ? 204 : 255;
      const hide = (1 - a) * k;
      switch (s.view) {
        case 'black-white':
          o = [m[i], m[i], m[i]];
          break;
        case 'overlay':
          o = [r + (255 - r) * hide, g * (1 - hide), b * (1 - hide)];
          break;
        case 'on-black':
          o = [r * (1 - hide), g * (1 - hide), b * (1 - hide)];
          break;
        case 'on-white':
          o = [r + (255 - r) * hide, g + (255 - g) * hide, b + (255 - b) * hide];
          break;
        case 'marching-ants': {
          o = [r, g, b];
          const inside = m[i] >= 128;
          const edge =
            (x > 0 && m[i - 1] >= 128 !== inside) || (x + 1 < w && m[i + 1] >= 128 !== inside) || (y > 0 && m[i - w] >= 128 !== inside) || (y + 1 < h && m[i + w] >= 128 !== inside);
          if (edge) {
            const v = ((x + y) >> 2) % 2 ? 0 : 255;
            o = [v, v, v];
          }
          break;
        }
        case 'on-layers': {
          // What is not selected shows the layers below (over a checkerboard where they are clear).
          const under = this.belowPreview?.data;
          let ur = checker;
          let ug = checker;
          let ub = checker;
          if (under) {
            const ua = under[p + 3] / 255;
            ur = under[p] * ua + checker * (1 - ua);
            ug = under[p + 1] * ua + checker * (1 - ua);
            ub = under[p + 2] * ua + checker * (1 - ua);
          }
          o = [r + (ur - r) * hide, g + (ug - g) * hide, b + (ub - b) * hide];
          break;
        }
        default:
          // Onion Skin: what is not selected fades to transparency (a checkerboard).
          o = [r + (checker - r) * hide, g + (checker - g) * hide, b + (checker - b) * hide];
      }
      if (edgeBand && !edgeBand[i]) o = [o[0] * 0.15, o[1] * 0.15, o[2] * 0.15];
      out[p] = o[0];
      out[p + 1] = o[1];
      out[p + 2] = o[2];
      out[p + 3] = 255;
    }
    return out;
  }

  /**
   * Pointer down at `point` (natural pixels) with the current tool: starts a stroke (Quick
   * Selection, brushes, lasso) or a box (Object Selection). Alt (or the subtract mode) removes.
   * Hand and Zoom are the UI's own; they return false here.
   */
  begin(point: ImagePoint, modifiers: { altKey?: boolean } = {}): boolean {
    const s = this.settingsValue;
    const mode = modifiers.altKey ? (s.brushMode === 'add' ? 'subtract' : 'add') : s.brushMode;
    this.dragStart = point;
    switch (s.tool) {
      case 'quick-select':
        this.live = { kind: 'quick-select', points: [point], size: s.brushSize, mode };
        break;
      case 'brush':
        this.live = { kind: 'brush', points: [point], size: s.brushSize, mode };
        break;
      case 'refine-brush':
        this.live = { kind: 'refine-brush', points: [point], size: s.brushSize };
        break;
      case 'lasso':
        this.live = { kind: 'lasso', points: [point], mode };
        break;
      case 'object':
        this.live = { kind: 'object', point, mode };
        break;
      default:
        this.dragStart = null;
        return false;
    }
    if (s.realTime && s.tool !== 'lasso' && s.tool !== 'object') this.recompute();
    return true;
  }

  /** Pointer move while a stroke is down. */
  move(point: ImagePoint): void {
    const live = this.live;
    if (!live || !this.dragStart) return;
    if (live.kind === 'object') {
      const a = this.dragStart;
      const rect = { x: Math.min(a.x, point.x), y: Math.min(a.y, point.y), width: Math.abs(point.x - a.x), height: Math.abs(point.y - a.y) };
      this.live = rect.width >= 4 && rect.height >= 4 ? { kind: 'object', rect, mode: live.mode } : { kind: 'object', point: a, mode: live.mode };
      return;
    }
    const last = live.points[live.points.length - 1];
    if (Math.hypot(point.x - last.x, point.y - last.y) < 1) return;
    live.points.push(point);
    if (this.settingsValue.realTime && live.kind !== 'lasso') this.recompute();
  }

  /** Pointer up: the stroke becomes an edit (one step of the workspace's own undo). */
  end(): void {
    const live = this.live;
    this.live = null;
    this.dragStart = null;
    if (!live) return;
    if (live.kind === 'lasso' && live.points.length < 3) return;
    this.editsList.push(live);
    this.recompute();
  }

  /** Removes the last stroke (Ctrl/⌘+Z in the workspace). Returns false when there is none. */
  undoEdit(): boolean {
    if (!this.editsList.length) return false;
    this.editsList.pop();
    this.recompute();
    return true;
  }

  /** Clears the strokes and goes back to the default settings (Reset). */
  reset(): void {
    this.editsList.length = 0;
    this.settingsValue = { ...DEFAULT_SELECT_AND_MASK_SETTINGS, params: { ...DEFAULT_SELECT_AND_MASK_SETTINGS.params }, tool: this.settingsValue.tool };
    this.rescale();
    this.recompute();
  }

  /**
   * Photoshop's keys in the workspace: a view letter, F (next view), X (all views off and on:
   * Show Original), J (Show Edge), P (Show Original), a tool letter, [ and ] (brush size).
   * Returns true when the key was used.
   */
  handleKey(key: string): boolean {
    const k = key.toLowerCase();
    const view = SELECT_AND_MASK_VIEWS.find((v) => v.key === k);
    if (view) {
      this.update({ view: view.id });
      return true;
    }
    const tool = SELECT_AND_MASK_TOOLS.find((t) => t.key === k);
    if (tool) {
      this.update({ tool: tool.id });
      return true;
    }
    if (k === 'f') {
      const i = SELECT_AND_MASK_VIEWS.findIndex((v) => v.id === this.settingsValue.view);
      this.update({ view: SELECT_AND_MASK_VIEWS[(i + 1) % SELECT_AND_MASK_VIEWS.length].id });
      return true;
    }
    if (k === 'p' || k === 'x') {
      this.update({ showOriginal: !this.settingsValue.showOriginal });
      return true;
    }
    if (k === 'j') {
      this.update({ showEdge: !this.settingsValue.showEdge });
      return true;
    }
    if (k === '[' || k === ']') {
      const size = this.settingsValue.brushSize;
      this.settingsValue = { ...this.settingsValue, brushSize: Math.max(1, Math.round(k === ']' ? size * 1.25 : size / 1.25)) };
      this.emit();
      return true;
    }
    return false;
  }

  /**
   * OK: applies the strokes and settings to the image as one undo step (the same call an agent
   * makes) and remembers the settings when asked to.
   */
  async commit(): Promise<RefineOutputResult> {
    const s = this.settingsValue;
    remembered = s.remember ? { ...s, params: { ...s.params } } : null;
    return this.controller.refineSelectionTo(s.params, s.output, {
      edits: [...this.editsList],
      decontaminate: s.output === 'selection' || s.output === 'layer-mask' ? 0 : s.decontaminate,
      refineMode: s.refineMode,
    });
  }
}

/** Forgets the remembered workspace settings. */
export function forgetSelectAndMaskSettings(): void {
  remembered = null;
}
