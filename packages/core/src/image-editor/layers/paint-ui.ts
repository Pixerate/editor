/**
 * The paint tools' view model, shared by the React and Svelte editors: the brush options bar's
 * controls, Photoshop's shortcuts (B, E, V, [ ], Shift+[ ], number keys, D, X) and a pointer
 * gesture that turns pointer events into strokes (Brush, Eraser) or layer moves (Move).
 */

import type { ControlSpec } from '../controls';
import type { ImageEditorController, PaintStrokeSession } from '../controller';
import type { ImagePoint } from '../types';
import { MAX_BRUSH_SIZE, type BrushSettings } from '../../paint';

const plain = { kind: 'plain' } as const;

/** Controls of the brush options bar (`hardness`, `opacity`, `flow`, `smoothing` shown in %). */
export const BRUSH_OPTION_CONTROLS: readonly (ControlSpec & { id: 'size' | 'hardness' | 'opacity' | 'flow' | 'smoothing' })[] = [
  { id: 'size', label: 'Size', section: 'layer', min: 1, max: 500, step: 1, default: 20, decimals: 0, track: plain, unit: 'px' },
  { id: 'hardness', label: 'Hardness', section: 'layer', min: 0, max: 1, step: 0.01, default: 1, decimals: 0, track: plain, displayScale: 100, unit: '%' },
  { id: 'opacity', label: 'Opacity', section: 'layer', min: 0, max: 1, step: 0.01, default: 1, decimals: 0, track: plain, displayScale: 100, unit: '%' },
  { id: 'flow', label: 'Flow', section: 'layer', min: 0, max: 1, step: 0.01, default: 1, decimals: 0, track: plain, displayScale: 100, unit: '%' },
  { id: 'smoothing', label: 'Smoothing', section: 'layer', min: 0, max: 0.95, step: 0.01, default: 0, decimals: 0, track: plain, displayScale: 100, unit: '%' },
];

/** The paint tools in the toolbar. */
export const PAINT_TOOLS = [
  { id: 'move', label: 'Move', shortcut: 'V' },
  { id: 'brush', label: 'Brush', shortcut: 'B' },
  { id: 'eraser', label: 'Eraser', shortcut: 'E' },
] as const;

export type PaintTool = (typeof PAINT_TOOLS)[number]['id'];

export const isPaintTool = (tool: string): tool is PaintTool => tool === 'move' || tool === 'brush' || tool === 'eraser';

/** Photoshop's bracket step for a brush size. */
function sizeStep(size: number): number {
  return size < 10 ? 1 : size < 50 ? 5 : size < 100 ? 10 : size < 200 ? 25 : size < 500 ? 50 : 100;
}

export interface ShortcutEvent {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** The event target: shortcuts are ignored while typing in inputs. */
  target?: unknown;
}

const isTyping = (t: unknown) => {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null;
  return Boolean(el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'));
};

/**
 * Applies a paint shortcut. Returns true when it was one (the caller then prevents the default).
 * B / E / V choose the tool; [ and ] change the size, with Shift the hardness by 25 %; 1..9 set the
 * opacity to 10..90 % and 0 to 100 %; D resets the colours to black and white; X swaps them.
 */
export function handlePaintShortcut(controller: ImageEditorController, e: ShortcutEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return false;
  const brush = controller.getState().paint.brush;
  const set = (b: Partial<BrushSettings>) => controller.setPaintOptions({ brush: b });
  const key = e.key;
  switch (key.toLowerCase()) {
    case 'b':
      controller.setTool('brush');
      return true;
    case 'e':
      controller.setTool('eraser');
      return true;
    case 'v':
      controller.setTool('move');
      return true;
    case 'd':
      controller.resetPaintColors();
      return true;
    case 'x':
      controller.swapPaintColors();
      return true;
  }
  if (key === '[' || key === '{') {
    if (e.shiftKey || key === '{') set({ hardness: Math.max(0, Math.round((brush.hardness - 0.25) * 4) / 4) });
    else set({ size: Math.max(1, brush.size - sizeStep(brush.size - 1)) });
    return true;
  }
  if (key === ']' || key === '}') {
    if (e.shiftKey || key === '}') set({ hardness: Math.min(1, Math.round((brush.hardness + 0.25) * 4) / 4) });
    else set({ size: Math.min(MAX_BRUSH_SIZE, brush.size + sizeStep(brush.size)) });
    return true;
  }
  if (/^[0-9]$/.test(key) && isPaintTool(controller.getState().activeTool)) {
    set({ opacity: key === '0' ? 1 : Number(key) / 10 });
    return true;
  }
  return false;
}

/** One pointer sample in document pixels. */
export interface PaintPointerSample extends ImagePoint {
  /** 0..1; a mouse is 1. */
  pressure: number;
}

/** Pressure of a pointer event: pens report it; mice report 0.5 while pressed, which means "full". */
export function pointerPressure(e: { pointerType?: string; pressure?: number }): number {
  if (e.pointerType === 'pen' && typeof e.pressure === 'number' && e.pressure > 0) return Math.min(1, e.pressure);
  return 1;
}

/**
 * Turns pointer events into strokes (Brush, Eraser on the active layer's target) or layer moves
 * (Move on the active pixel layer). `down` returns an error message when the tool cannot act.
 */
export class PaintGesture {
  private stroke: PaintStrokeSession | null = null;
  private move: { id: string; start: ImagePoint; origin: { x: number; y: number }; moved: boolean } | null = null;
  /** The last refusal (e.g. "layer is locked"), for the editor to show. */
  error: string | null = null;

  constructor(private readonly controller: ImageEditorController) {}

  get active(): boolean {
    return Boolean(this.stroke || this.move);
  }

  down(sample: PaintPointerSample): string | null {
    this.error = null;
    const tool = this.controller.getState().activeTool;
    try {
      if (tool === 'move') {
        const layer = this.controller.getActiveLayer();
        if (!layer) throw new Error('Select a layer to move in the Layers panel.');
        if (layer.type !== 'pixel') throw new Error(`Only pixel layers move; "${layer.name}" is a ${layer.type} layer.`);
        if (layer.locks?.all || layer.locks?.position) throw new Error(`Layer "${layer.name}" has its position locked.`);
        this.move = { id: layer.id, start: { x: sample.x, y: sample.y }, origin: { ...layer.offset }, moved: false };
        return null;
      }
      if (tool === 'brush' || tool === 'eraser') {
        this.stroke = this.controller.beginStroke({ tool });
        this.stroke.push([sample]);
        return null;
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.stroke = null;
      this.move = null;
    }
    return this.error;
  }

  /** Feeds pointer samples (all coalesced events of one move, in order). */
  moveTo(samples: PaintPointerSample[]): void {
    if (!samples.length) return;
    if (this.stroke) {
      this.stroke.push(samples);
      return;
    }
    const m = this.move;
    if (m) {
      const last = samples[samples.length - 1];
      const x = m.origin.x + Math.round(last.x - m.start.x);
      const y = m.origin.y + Math.round(last.y - m.start.y);
      try {
        // The first move of a drag records the undo step; the rest replace it.
        this.controller.offsetLayer(m.id, { x, y }, !m.moved);
        m.moved = true;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
        this.move = null;
      }
    }
  }

  up(): void {
    if (this.stroke) {
      try {
        this.stroke.end();
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      }
    }
    this.stroke = null;
    this.move = null;
  }

  cancel(): void {
    this.stroke?.cancel();
    this.stroke = null;
    this.move = null;
  }
}
