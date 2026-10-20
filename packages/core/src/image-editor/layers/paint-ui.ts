/**
 * The paint tools' view model, shared by the React and Svelte editors: the brush options bar's
 * controls, Photoshop's shortcuts (B, Shift+B, E, V, S, J, Shift+J, O, Shift+O, [ ], Shift+[ ],
 * number keys, D, X) and a pointer gesture that turns pointer events into strokes (Brush, Mixer
 * Brush, Eraser and the retouching tools; Alt-click sets the clone source) or layer moves (Move).
 */

import type { ControlSpec } from '../controls';
import type { ImageEditorController, PaintStrokeSession } from '../controller';
import type { ImagePoint } from '../types';
import { shapeGeometryBounds } from './shape';
import { MAX_BRUSH_SIZE, type BrushSettings, type MixerSettings, type RetouchSettings } from '../../paint';

const plain = { kind: 'plain' } as const;

/** Controls of the brush options bar (`hardness`, `opacity`, `flow`, `smoothing` shown in %). */
export const BRUSH_OPTION_CONTROLS: readonly (ControlSpec & { id: 'size' | 'hardness' | 'opacity' | 'flow' | 'smoothing' })[] = [
  { id: 'size', label: 'Size', section: 'layer', min: 1, max: 500, step: 1, default: 20, decimals: 0, track: plain, unit: 'px' },
  { id: 'hardness', label: 'Hardness', section: 'layer', min: 0, max: 1, step: 0.01, default: 1, decimals: 0, track: plain, displayScale: 100, unit: '%' },
  { id: 'opacity', label: 'Opacity', section: 'layer', min: 0, max: 1, step: 0.01, default: 1, decimals: 0, track: plain, displayScale: 100, unit: '%' },
  { id: 'flow', label: 'Flow', section: 'layer', min: 0, max: 1, step: 0.01, default: 1, decimals: 0, track: plain, displayScale: 100, unit: '%' },
  { id: 'smoothing', label: 'Smoothing', section: 'layer', min: 0, max: 0.95, step: 0.01, default: 0, decimals: 0, track: plain, displayScale: 100, unit: '%' },
];

/** Controls of the Mixer Brush (shown in %, with the brush controls, while the mixer is active). */
export const MIXER_OPTION_CONTROLS: readonly (ControlSpec & { id: 'wet' | 'load' | 'mix' })[] = [
  { id: 'wet', label: 'Wet', section: 'layer', min: 0, max: 1, step: 0.01, default: 0.5, decimals: 0, track: plain, displayScale: 100, unit: '%' },
  { id: 'load', label: 'Load', section: 'layer', min: 0, max: 1, step: 0.01, default: 0.5, decimals: 0, track: plain, displayScale: 100, unit: '%' },
  { id: 'mix', label: 'Mix', section: 'layer', min: 0, max: 1, step: 0.01, default: 0.5, decimals: 0, track: plain, displayScale: 100, unit: '%' },
];

/** The Mixer Brush's mixing models, for its RGB / Pigment toggle. */
export const MIXER_MIXING_OPTIONS: readonly { id: MixerSettings['mixing']; label: string; title: string }[] = [
  { id: 'rgb', label: 'RGB', title: 'Mix colours as RGB averages' },
  { id: 'pigment', label: 'Pigment', title: 'Mix colours like paint: blue and yellow make green' },
];

/** The paint tools in the toolbar. */
export const PAINT_TOOLS = [
  { id: 'move', label: 'Move', shortcut: 'V' },
  { id: 'brush', label: 'Brush', shortcut: 'B' },
  { id: 'mixer', label: 'Mixer', shortcut: 'Shift+B' },
  { id: 'eraser', label: 'Eraser', shortcut: 'E' },
  { id: 'clone', label: 'Clone', shortcut: 'S' },
  { id: 'heal', label: 'Heal', shortcut: 'Shift+J' },
  { id: 'spot-heal', label: 'Spot Heal', shortcut: 'J' },
  { id: 'smudge', label: 'Smudge', shortcut: '' },
  { id: 'dodge', label: 'Dodge', shortcut: 'O' },
  { id: 'burn', label: 'Burn', shortcut: 'Shift+O' },
  { id: 'sponge', label: 'Sponge', shortcut: 'Shift+O' },
  { id: 'blur', label: 'Blur', shortcut: '' },
  { id: 'sharpen', label: 'Sharpen', shortcut: '' },
  { id: 'history', label: 'History', shortcut: 'Y' },
] as const;

export type PaintTool = (typeof PAINT_TOOLS)[number]['id'];

export const isPaintTool = (tool: string): tool is PaintTool => PAINT_TOOLS.some((t) => t.id === tool);

/** The paint tools that retouch (their options show instead of the brush colours). */
export const isRetouchPaintTool = (tool: string): boolean =>
  tool === 'clone' || tool === 'heal' || tool === 'spot-heal' || tool === 'smudge' || tool === 'dodge' || tool === 'burn' || tool === 'sponge' || tool === 'blur' || tool === 'sharpen' || tool === 'history';

/** Retouch sliders: dodge / burn exposure and smudge strength (shown in %). */
export const RETOUCH_OPTION_CONTROLS: readonly (ControlSpec & { id: 'exposure' | 'strength' | 'historySteps'; tools: readonly PaintTool[] })[] = [
  { id: 'exposure', label: 'Exposure', section: 'layer', min: 0, max: 1, step: 0.01, default: 0.5, decimals: 0, track: plain, displayScale: 100, unit: '%', tools: ['dodge', 'burn'] },
  { id: 'strength', label: 'Strength', section: 'layer', min: 0, max: 1, step: 0.01, default: 0.5, decimals: 0, track: plain, displayScale: 100, unit: '%', tools: ['smudge', 'blur', 'sharpen'] },
  { id: 'historySteps', label: 'Steps back', section: 'layer', min: 0, max: 50, step: 1, default: 0, decimals: 0, track: plain, unit: '', tools: ['history'] },
];

/** Retouch choices, each a row of toggle buttons, with the tools that show it. */
export const RETOUCH_CHOICES: readonly {
  id: 'sample' | 'spotType' | 'range' | 'spongeMode';
  label: string;
  tools: readonly PaintTool[];
  options: readonly { id: string; label: string; title: string }[];
}[] = [
  {
    id: 'sample',
    label: 'Sample',
    tools: ['clone', 'heal', 'spot-heal'],
    options: [
      { id: 'current', label: 'Current', title: 'Sample the layer being retouched' },
      { id: 'current-below', label: 'Current & Below', title: 'Sample this layer and the layers under it' },
      { id: 'all', label: 'All', title: 'Sample every layer (retouch onto an empty layer)' },
    ],
  },
  {
    id: 'spotType',
    label: 'Type',
    tools: ['spot-heal'],
    options: [
      { id: 'proximity-match', label: 'Proximity Match', title: 'Copy the best matching patch nearby' },
      { id: 'content-aware', label: 'Content-Aware', title: 'Synthesise texture and edges from patches around the spot' },
      { id: 'smooth', label: 'Smooth', title: 'Fill smoothly from the edges' },
    ],
  },
  {
    id: 'range',
    label: 'Range',
    tools: ['dodge', 'burn'],
    options: [
      { id: 'shadows', label: 'Shadows', title: 'Change the dark tones most' },
      { id: 'midtones', label: 'Midtones', title: 'Change the middle tones most' },
      { id: 'highlights', label: 'Highlights', title: 'Change the light tones most' },
    ],
  },
  {
    id: 'spongeMode',
    label: 'Mode',
    tools: ['sponge'],
    options: [
      { id: 'desaturate', label: 'Desaturate', title: 'Take colour out' },
      { id: 'saturate', label: 'Saturate', title: 'Add colour' },
    ],
  },
];

/** Retouch on / off options, with the tools that show each. */
export const RETOUCH_TOGGLES: readonly { id: 'aligned' | 'protectTones' | 'vibrance'; label: string; tools: readonly PaintTool[] }[] = [
  { id: 'aligned', label: 'Aligned', tools: ['clone', 'heal'] },
  { id: 'protectTones', label: 'Protect tones', tools: ['dodge', 'burn'] },
  { id: 'vibrance', label: 'Vibrance', tools: ['sponge'] },
];

/** Sets one retouch choice from the options bar. */
export function setRetouchChoice(controller: ImageEditorController, id: (typeof RETOUCH_CHOICES)[number]['id'], value: string): void {
  controller.setPaintOptions({ retouch: { [id]: value } as Partial<RetouchSettings> });
}

/** What the options bar says about the clone source. */
export function cloneSourceLabel(controller: ImageEditorController): string {
  const cs = controller.getState().paint.cloneSource;
  return cs ? `Source ${cs.x}, ${cs.y}${cs.offset ? ` (offset ${cs.offset.x}, ${cs.offset.y})` : ''}` : 'Alt-click to set the source';
}

/** `#rrggbb` of an sRGB triple (0..1), e.g. the Mixer Brush's reservoir. */
export function rgbUnitToHex(c: readonly [number, number, number]): string {
  return `#${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

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
 * B / Shift+B (Mixer Brush) / E / V choose the tool; [ and ] change the size, with Shift the hardness by 25 %; 1..9 set the
 * opacity to 10..90 % and 0 to 100 %; D resets the colours to black and white; X swaps them.
 */
export function handlePaintShortcut(controller: ImageEditorController, e: ShortcutEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return false;
  const brush = controller.getState().paint.brush;
  const set = (b: Partial<BrushSettings>) => controller.setPaintOptions({ brush: b });
  const key = e.key;
  switch (key.toLowerCase()) {
    case 'b':
      controller.setTool(e.shiftKey || key === 'B' ? 'mixer' : 'brush');
      return true;
    case 'e':
      controller.setTool('eraser');
      return true;
    case 'v':
      controller.setTool('move');
      return true;
    case 's':
      controller.setTool('clone');
      return true;
    case 'j':
      controller.setTool(e.shiftKey || key === 'J' ? (controller.getState().activeTool === 'heal' ? 'spot-heal' : 'heal') : 'spot-heal');
      return true;
    case 'o': {
      // O: Dodge; Shift+O cycles Dodge → Burn → Sponge.
      const cur = controller.getState().activeTool;
      const next = e.shiftKey || key === 'O' ? (cur === 'dodge' ? 'burn' : cur === 'burn' ? 'sponge' : 'dodge') : 'dodge';
      controller.setTool(next);
      return true;
    }
    case 'y':
      controller.setTool('history');
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
  /** Alt (Option) held on the press: with the Clone Stamp or Healing Brush it sets the source. */
  altKey?: boolean;
}

/** Pressure of a pointer event: pens report it; mice report 0.5 while pressed, which means "full". */
export { pointerPressure } from '../../paint/pointer';

/**
 * Turns pointer events into strokes (Brush, Mixer Brush, Eraser on the active layer's target) or layer moves
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
        if (layer.type !== 'pixel' && layer.type !== 'shape' && layer.type !== 'smart') throw new Error(`Only pixel, shape and smart object layers move; "${layer.name}" is a ${layer.type} layer.`);
        if (layer.locks?.all || layer.locks?.position) throw new Error(`Layer "${layer.name}" has its position locked.`);
        // Where `offsetLayer` measures the position: the offset, a shape's top-left, a smart object's first corner.
        const origin = layer.type === 'pixel' ? { ...layer.offset } : layer.type === 'smart' ? { ...layer.placement.corners[0] } : (() => {
          const b = shapeGeometryBounds(layer);
          return b ? { x: b.x, y: b.y } : { x: 0, y: 0 };
        })();
        this.move = { id: layer.id, start: { x: sample.x, y: sample.y }, origin, moved: false };
        return null;
      }
      if ((tool === 'clone' || tool === 'heal') && sample.altKey) {
        this.controller.setCloneSource({ x: sample.x, y: sample.y });
        return null;
      }
      if (isPaintTool(tool)) {
        this.stroke = this.controller.beginStroke({ tool });
        this.stroke.push([{ x: sample.x, y: sample.y, pressure: sample.pressure }]);
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
