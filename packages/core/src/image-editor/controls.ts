// Portions ported from lightcraft-main/crates/develop/src/controls.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import type { AdjustmentKind, ImageAdjustments } from './types';

/**
 * Control specs: one table describes every numeric adjustment slider (id, label, section, range,
 * default, step, display precision and track style). The React and Svelte panels render from it,
 * the agent tools expose it as a schema, and values are addressed by id.
 */

export type ControlSection = 'light' | 'color' | 'effects' | 'layer';

/** How a slider track is drawn. */
export type ControlTrack =
  /** Plain track, fill from the minimum. */
  | { kind: 'plain' }
  /** Zero in the middle. */
  | { kind: 'centered' }
  /** Blue → yellow (white-balance temperature). */
  | { kind: 'temp' }
  /** Green → magenta (tint). */
  | { kind: 'tint' }
  /** A two-colour gradient. */
  | { kind: 'gradient'; from: string; to: string }
  /** Full hue rainbow. */
  | { kind: 'rainbow' };

export interface ControlSpec {
  /** Dotted path of the value (`exposure`; inside a layer's params: `midtones.0`, `ranges.4.hue`). */
  id: string;
  label: string;
  section: ControlSection;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Decimal places shown (after `displayScale`). */
  decimals: number;
  track: ControlTrack;
  /** Multiplier for display (opacity 0..1 shows as 0..100 %). */
  displayScale?: number;
  /** Unit suffix for display (`px`, `%`, `°`). */
  unit?: string;
  /** The rendering process the control needs (tint: process 2). */
  requiresProcess?: 1 | 2;
}

const plain: ControlTrack = { kind: 'plain' };
const centered: ControlTrack = { kind: 'centered' };

/** Every numeric base adjustment, in panel order. */
export const IMAGE_ADJUSTMENT_CONTROLS: readonly ControlSpec[] = [
  { id: 'brightness', label: 'Brightness', section: 'light', min: -100, max: 100, step: 1, default: 0, decimals: 0, track: centered },
  { id: 'contrast', label: 'Contrast', section: 'light', min: -100, max: 100, step: 1, default: 0, decimals: 0, track: centered },
  {
    id: 'saturation', label: 'Saturation', section: 'color', min: -100, max: 100, step: 1, default: 0, decimals: 0,
    track: { kind: 'gradient', from: '#7a7a7a', to: '#e04a3a' },
  },
  { id: 'exposure', label: 'Exposure', section: 'light', min: -100, max: 100, step: 1, default: 0, decimals: 0, track: centered },
  { id: 'temperature', label: 'Warmth / Temperature', section: 'color', min: -100, max: 100, step: 1, default: 0, decimals: 0, track: { kind: 'temp' } },
  { id: 'tint', label: 'Tint', section: 'color', min: -100, max: 100, step: 1, default: 0, decimals: 0, track: { kind: 'tint' }, requiresProcess: 2 },
  { id: 'blur', label: 'Blur', section: 'effects', min: 0, max: 30, step: 1, default: 0, decimals: 0, track: plain, unit: 'px' },
  { id: 'opacity', label: 'Opacity', section: 'effects', min: 0, max: 1, step: 0.05, default: 1, decimals: 0, track: plain, displayScale: 100, unit: '%' },
];

const tone = (prefix: string, label: string): ControlSpec[] =>
  [
    ['0', 'Cyan – Red', '#00b7c7', '#e0343a'],
    ['1', 'Magenta – Green', '#d23ad2', '#2fb34a'],
    ['2', 'Yellow – Blue', '#e0c63a', '#3a5be0'],
  ].map(([i, l, from, to]) => ({
    id: `${prefix}.${i}`, label: `${label} ${l}`, section: 'layer', min: -100, max: 100, step: 1, default: 0, decimals: 0,
    track: { kind: 'gradient', from, to },
  }));

const levelsRecord = (ch: string, label: string): ControlSpec[] => [
  { id: `${ch}.inBlack`, label: `${label} input black`, section: 'layer', min: 0, max: 253, step: 1, default: 0, decimals: 0, track: plain },
  { id: `${ch}.gamma`, label: `${label} gamma`, section: 'layer', min: 0.1, max: 9.99, step: 0.01, default: 1, decimals: 2, track: plain },
  { id: `${ch}.inWhite`, label: `${label} input white`, section: 'layer', min: 2, max: 255, step: 1, default: 255, decimals: 0, track: plain },
  { id: `${ch}.outBlack`, label: `${label} output black`, section: 'layer', min: 0, max: 255, step: 1, default: 0, decimals: 0, track: plain },
  { id: `${ch}.outWhite`, label: `${label} output white`, section: 'layer', min: 0, max: 255, step: 1, default: 255, decimals: 0, track: plain },
];

const RANGE_NAMES = ['Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas'];

/**
 * Numeric parameters of each adjustment-layer kind, addressed inside `layer.params`. Curves points
 * and booleans / colours (colorize, preserve luminosity, tint, filter colour) are edited by the
 * dedicated controls, not sliders.
 */
export const ADJUSTMENT_LAYER_CONTROLS: Readonly<Record<AdjustmentKind, readonly ControlSpec[]>> = {
  curves: [],
  levels: [
    ...levelsRecord('master', 'RGB'),
    ...levelsRecord('red', 'Red'),
    ...levelsRecord('green', 'Green'),
    ...levelsRecord('blue', 'Blue'),
  ],
  hueSaturation: [
    { id: 'hue', label: 'Hue', section: 'layer', min: -180, max: 180, step: 1, default: 0, decimals: 0, track: { kind: 'rainbow' }, unit: '°' },
    { id: 'saturation', label: 'Saturation', section: 'layer', min: -100, max: 100, step: 1, default: 0, decimals: 0, track: { kind: 'gradient', from: '#7a7a7a', to: '#e04a3a' } },
    { id: 'lightness', label: 'Lightness', section: 'layer', min: -100, max: 100, step: 1, default: 0, decimals: 0, track: { kind: 'gradient', from: '#000000', to: '#ffffff' } },
    ...RANGE_NAMES.flatMap((name, i): ControlSpec[] => [
      { id: `ranges.${i}.hue`, label: `${name} hue`, section: 'layer', min: -180, max: 180, step: 1, default: 0, decimals: 0, track: { kind: 'rainbow' }, unit: '°' },
      { id: `ranges.${i}.saturation`, label: `${name} saturation`, section: 'layer', min: -100, max: 100, step: 1, default: 0, decimals: 0, track: centered },
      { id: `ranges.${i}.lightness`, label: `${name} lightness`, section: 'layer', min: -100, max: 100, step: 1, default: 0, decimals: 0, track: centered },
    ]),
  ],
  vibrance: [
    { id: 'vibrance', label: 'Vibrance', section: 'layer', min: -100, max: 100, step: 1, default: 0, decimals: 0, track: { kind: 'gradient', from: '#7a7a7a', to: '#d8406a' } },
    { id: 'saturation', label: 'Saturation', section: 'layer', min: -100, max: 100, step: 1, default: 0, decimals: 0, track: { kind: 'gradient', from: '#7a7a7a', to: '#e04a3a' } },
  ],
  colorBalance: [...tone('shadows', 'Shadows'), ...tone('midtones', 'Midtones'), ...tone('highlights', 'Highlights')],
  blackWhite: [
    ['reds', 'Reds', 40, '#e0343a'],
    ['yellows', 'Yellows', 60, '#e0c63a'],
    ['greens', 'Greens', 40, '#2fb34a'],
    ['cyans', 'Cyans', 60, '#00b7c7'],
    ['blues', 'Blues', 20, '#3a5be0'],
    ['magentas', 'Magentas', 80, '#d23ad2'],
  ].map(([id, label, def, to]) => ({
    id: id as string, label: label as string, section: 'layer' as const, min: -200, max: 300, step: 1, default: def as number, decimals: 0,
    track: { kind: 'gradient' as const, from: '#000000', to: to as string }, unit: '%',
  })),
  invert: [],
  posterize: [{ id: 'levels', label: 'Levels', section: 'layer', min: 2, max: 255, step: 1, default: 4, decimals: 0, track: plain }],
  threshold: [{ id: 'level', label: 'Threshold level', section: 'layer', min: 1, max: 255, step: 1, default: 128, decimals: 0, track: { kind: 'gradient', from: '#000000', to: '#ffffff' } }],
  photoFilter: [{ id: 'density', label: 'Density', section: 'layer', min: 0, max: 100, step: 1, default: 25, decimals: 0, track: plain, unit: '%' }],
};

/** Opacity of any adjustment layer (0..1, shown as %). */
export const ADJUSTMENT_LAYER_OPACITY_CONTROL: ControlSpec = {
  id: 'opacity', label: 'Opacity', section: 'layer', min: 0, max: 1, step: 0.01, default: 1, decimals: 0, track: plain, displayScale: 100, unit: '%',
};

const BASE_BY_ID = new Map(IMAGE_ADJUSTMENT_CONTROLS.map((c) => [c.id, c]));

/** The base-adjustment control with this id. */
export function findAdjustmentControl(id: string): ControlSpec | undefined {
  return BASE_BY_ID.get(id);
}

/** The control of a layer parameter (`opacity` included). */
export function findLayerControl(kind: AdjustmentKind, id: string): ControlSpec | undefined {
  if (id === 'opacity') return ADJUSTMENT_LAYER_OPACITY_CONTROL;
  return ADJUSTMENT_LAYER_CONTROLS[kind]?.find((c) => c.id === id);
}

/** `v` clamped to the control's range and snapped to its step; non-finite values give the default. */
export function clampControlValue(spec: ControlSpec, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return spec.default;
  const clamped = Math.min(spec.max, Math.max(spec.min, v));
  const steps = Math.round((clamped - spec.min) / spec.step);
  const snapped = spec.min + steps * spec.step;
  // Trim float noise from the step arithmetic.
  return Math.min(spec.max, Number(snapped.toFixed(6)));
}

/** A value as the slider shows it (`+12`, `35%`, `4px`). */
export function formatControlValue(spec: ControlSpec, v: number): string {
  const shown = (Number.isFinite(v) ? v : spec.default) * (spec.displayScale ?? 1);
  const s = shown.toFixed(spec.decimals);
  return `${s}${spec.unit ?? ''}`;
}

/** Where `v` sits on the track, 0 (left) to 1 (right). */
export function controlPosition(spec: ControlSpec, v: number): number {
  const p = (clampControlValue(spec, v) - spec.min) / (spec.max - spec.min || 1);
  return Math.min(1, Math.max(0, p));
}

/** CSS background for a control's track. */
export function controlTrackBackground(spec: ControlSpec): string | undefined {
  const t = spec.track;
  switch (t.kind) {
    case 'temp':
      return 'linear-gradient(to right, #3a7bd5, #d8d8d8, #f2c94c)';
    case 'tint':
      return 'linear-gradient(to right, #3fbf4f, #d8d8d8, #d23ad2)';
    case 'gradient':
      return `linear-gradient(to right, ${t.from}, ${t.to})`;
    case 'rainbow':
      return 'linear-gradient(to right, #00ffff, #0000ff, #ff00ff, #ff0000, #ffff00, #00ff00, #00ffff)';
    default:
      return undefined;
  }
}

/** Reads a dotted path (`ranges.2.hue`) from an object. */
export function getControlPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** A copy of `obj` with the dotted path set (arrays and objects along the path are cloned). */
export function setControlPath<T>(obj: T, path: string, value: unknown): T {
  const parts = path.split('.');
  const root: any = Array.isArray(obj) ? [...(obj as unknown[])] : { ...(obj as object) };
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    cur[parts[i]] = Array.isArray(next) ? [...next] : next && typeof next === 'object' ? { ...next } : {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return root as T;
}

/** The base adjustment values the control table describes. */
export function readAdjustmentControls(adjustments: ImageAdjustments): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of IMAGE_ADJUSTMENT_CONTROLS) {
    const v = (adjustments as unknown as Record<string, unknown>)[c.id];
    out[c.id] = typeof v === 'number' && Number.isFinite(v) ? v : c.default;
  }
  return out;
}

export interface ImageFilterPreset {
  id: string;
  label: string;
  adjustments: Partial<ImageAdjustments>;
}

/** Built-in colour-grade presets for quick one-click adjustment looks. */
export const IMAGE_FILTER_PRESETS: readonly ImageFilterPreset[] = [
  {
    id: 'none',
    label: 'Original',
    adjustments: {
      brightness: 0,
      contrast: 0,
      saturation: 0,
      exposure: 0,
      temperature: 0,
      tint: 0,
      blur: 0,
      opacity: 1,
    },
  },
  {
    id: 'dramatic',
    label: 'Dramatic',
    adjustments: {
      brightness: -5,
      contrast: 45,
      saturation: 20,
      exposure: 5,
      temperature: -10,
      tint: 0,
    },
  },
  {
    id: 'cyberpunk',
    label: 'Cyberpunk',
    adjustments: {
      brightness: 5,
      contrast: 35,
      saturation: 55,
      exposure: 0,
      temperature: -25,
      tint: 40,
    },
  },
  {
    id: 'vintage',
    label: 'Vintage',
    adjustments: {
      brightness: 8,
      contrast: -15,
      saturation: -35,
      exposure: 5,
      temperature: 35,
      tint: 10,
    },
  },
  {
    id: 'warm',
    label: 'Warm',
    adjustments: {
      brightness: 5,
      contrast: 10,
      saturation: 15,
      exposure: 0,
      temperature: 45,
      tint: 5,
    },
  },
  {
    id: 'cool',
    label: 'Cool',
    adjustments: {
      brightness: 0,
      contrast: 15,
      saturation: 10,
      exposure: 0,
      temperature: -45,
      tint: -10,
    },
  },
  {
    id: 'grayscale',
    label: 'B&W',
    adjustments: {
      brightness: 0,
      contrast: 20,
      saturation: -100,
      exposure: 0,
      temperature: 0,
      tint: 0,
    },
  },
  {
    id: 'noir',
    label: 'Noir',
    adjustments: {
      brightness: -15,
      contrast: 65,
      saturation: -100,
      exposure: -5,
      temperature: 0,
      tint: 0,
    },
  },
  {
    id: 'fade',
    label: 'Fade',
    adjustments: {
      brightness: 15,
      contrast: -25,
      saturation: -20,
      exposure: 10,
      temperature: 10,
      tint: 0,
    },
  },
];

export interface ImageCropPreset {
  id: string;
  label: string;
  aspectRatio: number | null;
}

/** Standard aspect-ratio presets for cropping. */
export const IMAGE_CROP_PRESETS: readonly ImageCropPreset[] = [
  { id: 'free', label: 'Free', aspectRatio: null },
  { id: '1:1', label: '1:1', aspectRatio: 1 },
  { id: '16:9', label: '16:9', aspectRatio: 16 / 9 },
  { id: '4:3', label: '4:3', aspectRatio: 4 / 3 },
  { id: '4:5', label: '4:5', aspectRatio: 4 / 5 },
  { id: '9:16', label: '9:16', aspectRatio: 9 / 16 },
];

export interface CanvasSizePreset {
  id: string;
  label: string;
  width: number;
  height: number;
  aspectRatio?: string;
}

/** Standard composition and canvas size presets. */
export const CANVAS_SIZE_PRESETS: readonly CanvasSizePreset[] = [
  { id: 'square', label: 'Square (1:1)', width: 1080, height: 1080, aspectRatio: '1:1' },
  { id: 'landscape-16-9', label: 'Landscape (16:9)', width: 1920, height: 1080, aspectRatio: '16:9' },
  { id: 'portrait-9-16', label: 'Story / Reel (9:16)', width: 1080, height: 1920, aspectRatio: '9:16' },
  { id: 'social-4-5', label: 'Portrait (4:5)', width: 1080, height: 1350, aspectRatio: '4:5' },
  { id: 'standard-4-3', label: 'Standard (4:3)', width: 1440, height: 1080, aspectRatio: '4:3' },
  { id: 'banner-3-1', label: 'Header / Banner (3:1)', width: 1500, height: 500, aspectRatio: '3:1' },
];

/** Numeric controls for depth-mask near/far threshold range. */
export const DEPTH_MASK_CONTROLS: readonly ControlSpec[] = [
  {
    id: 'near',
    label: 'Near Threshold',
    section: 'effects',
    min: 0,
    max: 255,
    step: 1,
    default: 0,
    decimals: 0,
    track: plain,
  },
  {
    id: 'far',
    label: 'Far Threshold',
    section: 'effects',
    min: 0,
    max: 255,
    step: 1,
    default: 255,
    decimals: 0,
    track: plain,
  },
];

