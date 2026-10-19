/**
 * Paint editor brushes: the shared engine's tip settings (`@pixerate/editor/paint`) plus what a
 * natural-media brush adds: paper grain response, pen dynamics (pressure, tilt, barrel rotation,
 * velocity), separate pressure smoothing, a rotation mode, jitter, and Mixer Brush settings for
 * the blending brushes. The built-in presets are our own settings; none come from another product.
 */

import { DEFAULT_BRUSH, MAX_BRUSH_SIZE, normalizeBrush, type BrushSettings } from '../paint/brush';
import { DEFAULT_MIXER, normalizeMixer, type MixerSettings } from '../paint/mixer';

/** How a brush makes marks: dabs into a stroke buffer, removing alpha, or the Mixer Brush engine. */
export type PaintBrushEngine = 'dab' | 'eraser' | 'mixer';

export const PAINT_BRUSH_ENGINES: readonly PaintBrushEngine[] = ['dab', 'eraser', 'mixer'];

export type PaintBrushCategory = 'pencil' | 'pastel' | 'charcoal' | 'airbrush' | 'marker' | 'ink' | 'eraser' | 'blender' | 'smudge' | 'mixer' | 'custom';

export const PAINT_BRUSH_CATEGORIES: readonly PaintBrushCategory[] = ['pencil', 'pastel', 'charcoal', 'airbrush', 'marker', 'ink', 'eraser', 'blender', 'smudge', 'mixer', 'custom'];

/** What turns the tip: a fixed angle, the direction of the stroke, or the pen's barrel rotation. */
export type BrushRotation = 'fixed' | 'stroke' | 'barrel';

export const BRUSH_ROTATIONS: readonly BrushRotation[] = ['fixed', 'stroke', 'barrel'];

/** Pen dynamics and jitter. Every amount is 0 (off) .. 1 unless noted. */
export interface BrushDynamics {
  /** Size at zero pressure as a fraction of the full size, when pressure controls size (default 0). */
  minSize: number;
  /** How much pressure scales flow (default 0). */
  pressureFlow: number;
  /** Laying the pen down widens the tip, up to 2.5× (default 0). */
  tiltSize: number;
  /** Laying the pen down flattens the tip along the tilt direction (default 0). */
  tiltRoundness: number;
  /** Laying the pen down lightens the mark, as when shading with the side of a pencil (default 0). */
  tiltOpacity: number;
  /** -1..1: positive grows the tip when the pen moves fast, negative thins it (default 0). */
  velocitySize: number;
  /** -1..1: positive darkens fast marks, negative lightens them (default 0). */
  velocityOpacity: number;
  /** Random size change per dab (default 0). */
  sizeJitter: number;
  /** Random angle per dab, as a fraction of ±180° (default 0). */
  angleJitter: number;
  /** Random opacity drop per dab (default 0). */
  opacityJitter: number;
  /** Random offset across the stroke in diameters, 0..4 (default 0). */
  scatter: number;
}

export const DEFAULT_DYNAMICS: Readonly<BrushDynamics> = {
  minSize: 0,
  pressureFlow: 0,
  tiltSize: 0,
  tiltRoundness: 0,
  tiltOpacity: 0,
  velocitySize: 0,
  velocityOpacity: 0,
  sizeJitter: 0,
  angleJitter: 0,
  opacityJitter: 0,
  scatter: 0,
};

export interface PaintBrush {
  /** Library id (lowercase letters, digits and dashes). */
  id: string;
  name: string;
  category: PaintBrushCategory;
  engine: PaintBrushEngine;
  /** The shared engine's tip: size, hardness, spacing, angle, roundness, opacity, flow, position smoothing, pressure to size / opacity, blend. */
  tip: BrushSettings;
  /** How strongly the mark follows the paper grain, 0 (ignores it) .. 1 (catches only the peaks at light pressure). */
  grain: number;
  /** Pressure smoothing 0..0.95, separate from the tip's position smoothing (default 0). */
  pressureSmoothing: number;
  rotation: BrushRotation;
  dynamics: BrushDynamics;
  /** Mixer engine only: the Mixer Brush settings. */
  mixer: MixerSettings;
  /** Mixer engine only: load the current colour each stroke (false: a smudge or blender that only moves paint). */
  loadsColor: boolean;
  /** True for the built-in presets (they cannot be removed or overwritten). */
  builtin?: boolean;
}

const unit = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
const range = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function normalizeDynamics(raw: Partial<BrushDynamics> = {}, base: BrushDynamics = DEFAULT_DYNAMICS): BrushDynamics {
  return {
    minSize: unit(raw.minSize, base.minSize),
    pressureFlow: unit(raw.pressureFlow, base.pressureFlow),
    tiltSize: unit(raw.tiltSize, base.tiltSize),
    tiltRoundness: unit(raw.tiltRoundness, base.tiltRoundness),
    tiltOpacity: unit(raw.tiltOpacity, base.tiltOpacity),
    velocitySize: range(raw.velocitySize, -1, 1, base.velocitySize),
    velocityOpacity: range(raw.velocityOpacity, -1, 1, base.velocityOpacity),
    sizeJitter: unit(raw.sizeJitter, base.sizeJitter),
    angleJitter: unit(raw.angleJitter, base.angleJitter),
    opacityJitter: unit(raw.opacityJitter, base.opacityJitter),
    scatter: range(raw.scatter, 0, 4, base.scatter),
  };
}

export const BRUSH_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A brush with every field in range; missing fields come from `base` (default: a plain round dab brush). */
export function normalizePaintBrush(raw: Partial<Omit<PaintBrush, 'tip' | 'dynamics' | 'mixer'>> & { tip?: Partial<BrushSettings>; dynamics?: Partial<BrushDynamics>; mixer?: Partial<MixerSettings> } = {}, base?: PaintBrush): PaintBrush {
  const b = base ?? BASE_BRUSH;
  const id = typeof raw.id === 'string' && BRUSH_ID.test(raw.id) ? raw.id : b.id;
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : b.name,
    category: PAINT_BRUSH_CATEGORIES.includes(raw.category as PaintBrushCategory) ? (raw.category as PaintBrushCategory) : b.category,
    engine: PAINT_BRUSH_ENGINES.includes(raw.engine as PaintBrushEngine) ? (raw.engine as PaintBrushEngine) : b.engine,
    tip: normalizeBrush({ ...b.tip, ...(raw.tip ?? {}) }),
    grain: unit(raw.grain, b.grain),
    pressureSmoothing: range(raw.pressureSmoothing, 0, 0.95, b.pressureSmoothing),
    rotation: BRUSH_ROTATIONS.includes(raw.rotation as BrushRotation) ? (raw.rotation as BrushRotation) : b.rotation,
    dynamics: normalizeDynamics(raw.dynamics ?? {}, b.dynamics),
    mixer: normalizeMixer({ ...b.mixer, ...(raw.mixer ?? {}) }),
    loadsColor: typeof raw.loadsColor === 'boolean' ? raw.loadsColor : b.loadsColor,
    ...(raw.builtin ? { builtin: true } : {}),
  };
}

const BASE_BRUSH: PaintBrush = {
  id: 'round',
  name: 'Round',
  category: 'custom',
  engine: 'dab',
  tip: { ...DEFAULT_BRUSH },
  grain: 0,
  pressureSmoothing: 0,
  rotation: 'fixed',
  dynamics: { ...DEFAULT_DYNAMICS },
  mixer: { ...DEFAULT_MIXER },
  loadsColor: true,
};

type BrushInit = Parameters<typeof normalizePaintBrush>[0] & { id: string; name: string; category: PaintBrushCategory };

const builtin = (init: BrushInit): PaintBrush => ({ ...normalizePaintBrush(init), builtin: true });

/** The built-in brush library. */
export const BUILTIN_BRUSHES: readonly PaintBrush[] = [
  builtin({
    id: 'pencil-hb', name: 'HB pencil', category: 'pencil',
    tip: { size: 4, hardness: 0.7, spacing: 0.08, opacity: 0.85, flow: 0.55, smoothing: 0.25, pressureSize: true, pressureOpacity: true },
    grain: 0.85, pressureSmoothing: 0.3,
    dynamics: { minSize: 0.55, tiltSize: 0.9, tiltRoundness: 0.7, tiltOpacity: 0.5 },
  }),
  builtin({
    id: 'pencil-6b', name: '6B pencil', category: 'pencil',
    tip: { size: 7, hardness: 0.55, spacing: 0.07, opacity: 1, flow: 0.75, smoothing: 0.2, pressureSize: true, pressureOpacity: true },
    grain: 0.7, pressureSmoothing: 0.3,
    dynamics: { minSize: 0.5, tiltSize: 1, tiltRoundness: 0.75, tiltOpacity: 0.35 },
  }),
  builtin({
    id: 'soft-pastel', name: 'Soft pastel', category: 'pastel', rotation: 'stroke',
    tip: { size: 32, hardness: 0.55, spacing: 0.05, angle: 90, roundness: 0.55, opacity: 1, flow: 0.7, smoothing: 0.15, pressureSize: false, pressureOpacity: true },
    grain: 1, pressureSmoothing: 0.25,
    dynamics: { sizeJitter: 0.06, angleJitter: 0.02 },
  }),
  builtin({
    id: 'oil-pastel', name: 'Oil pastel', category: 'pastel', rotation: 'stroke',
    tip: { size: 26, hardness: 0.8, spacing: 0.05, angle: 90, roundness: 0.7, opacity: 1, flow: 0.9, smoothing: 0.15, pressureSize: true, pressureOpacity: false, blend: 'pigment' },
    grain: 0.5, pressureSmoothing: 0.25,
    dynamics: { minSize: 0.6 },
  }),
  builtin({
    id: 'charcoal-stick', name: 'Charcoal stick', category: 'charcoal', rotation: 'stroke',
    tip: { size: 26, hardness: 0.4, spacing: 0.05, angle: 90, roundness: 0.35, opacity: 0.95, flow: 0.5, smoothing: 0.15, pressureSize: false, pressureOpacity: true },
    grain: 0.95, pressureSmoothing: 0.2,
    dynamics: { sizeJitter: 0.1, angleJitter: 0.03, tiltSize: 0.6 },
  }),
  builtin({
    id: 'vine-charcoal', name: 'Vine charcoal', category: 'charcoal',
    tip: { size: 10, hardness: 0.3, spacing: 0.06, opacity: 0.75, flow: 0.45, smoothing: 0.2, pressureSize: true, pressureOpacity: true },
    grain: 0.9, pressureSmoothing: 0.2,
    dynamics: { minSize: 0.4, tiltSize: 0.8, tiltRoundness: 0.5, tiltOpacity: 0.3, sizeJitter: 0.08 },
  }),
  builtin({
    id: 'airbrush', name: 'Airbrush', category: 'airbrush',
    tip: { size: 90, hardness: 0, spacing: 0.04, opacity: 1, flow: 0.06, smoothing: 0.3, pressureSize: false, pressureOpacity: false },
    grain: 0, pressureSmoothing: 0.3,
    dynamics: { pressureFlow: 1, tiltSize: 0.5, tiltRoundness: 0.6 },
  }),
  builtin({
    id: 'marker', name: 'Chisel marker', category: 'marker',
    tip: { size: 24, hardness: 0.85, spacing: 0.04, angle: 45, roundness: 0.35, opacity: 0.6, flow: 1, smoothing: 0.3, pressureSize: false, pressureOpacity: false, blend: 'multiply' },
    grain: 0.1,
  }),
  builtin({
    id: 'ink-pen', name: 'Ink pen', category: 'ink',
    tip: { size: 4, hardness: 1, spacing: 0.05, opacity: 1, flow: 1, smoothing: 0.5, pressureSize: true, pressureOpacity: false },
    pressureSmoothing: 0.4,
    dynamics: { minSize: 0.25, velocitySize: -0.45 },
  }),
  builtin({
    id: 'brush-pen', name: 'Brush pen', category: 'ink', rotation: 'stroke',
    tip: { size: 14, hardness: 0.9, spacing: 0.04, roundness: 0.8, opacity: 1, flow: 1, smoothing: 0.5, pressureSize: true, pressureOpacity: false },
    pressureSmoothing: 0.45,
    dynamics: { minSize: 0.05, velocitySize: -0.3 },
  }),
  builtin({
    id: 'eraser-soft', name: 'Soft eraser', category: 'eraser', engine: 'eraser',
    tip: { size: 40, hardness: 0.2, spacing: 0.08, opacity: 1, flow: 0.6, pressureSize: false, pressureOpacity: true },
  }),
  builtin({
    id: 'eraser-hard', name: 'Hard eraser', category: 'eraser', engine: 'eraser',
    tip: { size: 16, hardness: 0.9, spacing: 0.06, opacity: 1, flow: 1, pressureSize: true, pressureOpacity: false },
    grain: 0.3,
    dynamics: { minSize: 0.5 },
  }),
  builtin({
    id: 'blender', name: 'Blender', category: 'blender', engine: 'mixer', loadsColor: false,
    tip: { size: 34, hardness: 0.4, spacing: 0.08, opacity: 1, flow: 0.35, smoothing: 0.2, pressureSize: false, pressureOpacity: true },
    mixer: { wet: 0.7, load: 0, mix: 1, loadEachStroke: false, cleanEachStroke: true, mixing: 'pigment' },
  }),
  builtin({
    id: 'smudge', name: 'Smudge', category: 'smudge', engine: 'mixer', loadsColor: false,
    tip: { size: 26, hardness: 0.6, spacing: 0.06, opacity: 1, flow: 0.8, smoothing: 0.2, pressureSize: false, pressureOpacity: true },
    mixer: { wet: 1, load: 0, mix: 1, loadEachStroke: false, cleanEachStroke: true, mixing: 'rgb' },
  }),
  builtin({
    id: 'mixer-brush', name: 'Mixer Brush', category: 'mixer', engine: 'mixer',
    tip: { size: 30, hardness: 0.7, spacing: 0.1, opacity: 1, flow: 0.5, smoothing: 0.2, pressureSize: true, pressureOpacity: false },
    mixer: { wet: 0.5, load: 0.95, mix: 0.5, loadEachStroke: true, cleanEachStroke: true, mixing: 'pigment' },
    dynamics: { minSize: 0.5 },
  }),
];

export const DEFAULT_BRUSH_ID = 'pencil-6b';

export { MAX_BRUSH_SIZE };

/** A brush as plain JSON (for export, agents and saved libraries): no `builtin` flag. */
export function brushToJSON(brush: PaintBrush): Omit<PaintBrush, 'builtin'> {
  const { builtin: _b, ...rest } = brush;
  return JSON.parse(JSON.stringify(rest));
}

/** The JSON file a brush library exports to and imports from. */
export interface BrushLibraryFile {
  format: 'pixerate-brushes';
  version: 1;
  brushes: Array<Omit<PaintBrush, 'builtin'>>;
}

/**
 * Brushes read from a brush library file (or a bare array of brushes). Each is normalised; ones
 * without a valid id or name are reported in `problems` and skipped.
 */
export function parseBrushLibrary(raw: unknown, problems: string[] = []): PaintBrush[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as BrushLibraryFile).brushes) ? (raw as BrushLibraryFile).brushes : null;
  if (!list) throw new Error('Not a brush library: expected {"format":"pixerate-brushes","version":1,"brushes":[...]} or an array of brushes.');
  const out: PaintBrush[] = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      problems.push(`brushes[${i}] is not an object; skipped.`);
      return;
    }
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || !BRUSH_ID.test(r.id)) {
      problems.push(`brushes[${i}] has no valid id (lowercase letters, digits and dashes); skipped.`);
      return;
    }
    if (typeof r.name !== 'string' || !r.name.trim()) {
      problems.push(`brushes[${i}] ("${r.id}") has no name; skipped.`);
      return;
    }
    const { builtin: _b, ...rest } = r;
    out.push(normalizePaintBrush(rest as Parameters<typeof normalizePaintBrush>[0]));
  });
  return out;
}
