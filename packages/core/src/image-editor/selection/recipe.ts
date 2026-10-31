/**
 * Live selections: a selection kept as the steps that made it (its recipe) beside its bitmap, so a
 * step can be edited, inserted or removed afterwards and the selection replayed. The bitmap stays
 * what everything else uses; a change no step can describe drops the recipe (the selection is then
 * frozen). Steps are plain JSON: the arguments the selection commands took.
 */

import type { CropBox, ImagePoint } from '../types';
import { combineSelections, fullSelection, invertSelection, type PixelBuffer, type SelectionMask, type SelectionMode } from './mask';
import { ellipseSelection, polygonSelection, rectSelection } from './shapes';
import { colorRange, colorRangePreset, isColorRangePreset, magicWand, type ColorRangeSample } from './wand';
import { modifySelection, SELECTION_MODIFY_OPS, type SelectionModifyOp } from './modify';
import { refineSelection, type RefineEdgeParams } from './refine';

/** Where pixel steps sample (as the selection commands' `SampleOptions`). */
export interface RecipeSampling {
  sample?: 'composite' | 'active-layer';
  sampleMerged?: boolean;
}

/** How a new shape combines with what the earlier steps selected. */
export interface RecipeCombine {
  mode?: SelectionMode;
  /** Feather the new shape by this many pixels before combining. */
  feather?: number;
  /** Invert the new shape before combining. */
  invert?: boolean;
}

/** One step of a selection's recipe. */
export type SelectionRecipeStep =
  | ({ op: 'rect' | 'ellipse'; rect: CropBox; antiAlias?: boolean } & RecipeCombine)
  | ({ op: 'polygon'; points: ImagePoint[]; antiAlias?: boolean } & RecipeCombine)
  | ({ op: 'magic-wand'; point: ImagePoint; options?: Record<string, unknown> } & RecipeCombine & RecipeSampling)
  | ({ op: 'color-range'; samples: ColorRangeSample[]; options?: Record<string, unknown> } & RecipeCombine & RecipeSampling)
  | ({ op: 'color-range-preset'; preset: string; falloff?: number } & RecipeCombine & RecipeSampling)
  | { op: 'all' }
  | { op: 'invert' }
  | { op: 'modify'; modify: SelectionModifyOp; radius: number }
  | ({ op: 'refine'; params: RefineEdgeParams } & RecipeSampling);

export type SelectionRecipeOp = SelectionRecipeStep['op'];

export const SELECTION_RECIPE_OPS: readonly SelectionRecipeOp[] = ['rect', 'ellipse', 'polygon', 'magic-wand', 'color-range', 'color-range-preset', 'all', 'invert', 'modify', 'refine'];

/** Steps that make a new shape (combined by `mode`); the rest change what is already selected. */
export function isShapeStep(step: SelectionRecipeStep): boolean {
  return step.op !== 'all' && step.op !== 'invert' && step.op !== 'modify' && step.op !== 'refine';
}

/** Whether a step reads the image's pixels. */
export function stepNeedsPixels(step: SelectionRecipeStep): boolean {
  return step.op === 'magic-wand' || step.op === 'color-range' || step.op === 'color-range-preset' || (step.op === 'refine' && (step.params.radius ?? 8) > 0);
}

/** A key for a pixel step's sampling (steps with the same key read the same pixels). */
export function samplingKey(step: SelectionRecipeStep): string {
  const s = step as RecipeSampling;
  return `${s.sample ?? 'composite'}:${s.sampleMerged === true}`;
}

const fail = (msg: string): never => {
  throw new Error(msg);
};
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const point = (v: unknown, at: string): ImagePoint => {
  const p = v as { x?: unknown; y?: unknown };
  if (!p || !finite(p.x) || !finite(p.y)) fail(`${at} must be { x, y } in natural image pixels.`);
  return { x: p.x as number, y: p.y as number };
};
const rect = (v: unknown, at: string): CropBox => {
  const r = v as Record<string, unknown>;
  if (!r || !finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height) || (r.width as number) <= 0 || (r.height as number) <= 0) fail(`${at} must be { x, y, width, height } with a positive size.`);
  return { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number };
};

/** Checks and copies one step (as JSON from an agent or a document); throws a useful error. */
export function readRecipeStep(raw: unknown, at = 'step'): SelectionRecipeStep {
  const s = raw as Record<string, unknown>;
  if (!s || typeof s !== 'object') return fail(`${at} must be an object with an op.`);
  const combine = (): RecipeCombine => {
    const out: RecipeCombine = {};
    if (s.mode !== undefined) {
      if (s.mode !== 'replace' && s.mode !== 'add' && s.mode !== 'subtract' && s.mode !== 'intersect') fail(`${at}.mode must be replace, add, subtract or intersect.`);
      out.mode = s.mode as SelectionMode;
    }
    if (s.feather !== undefined) {
      if (!finite(s.feather) || (s.feather as number) < 0 || (s.feather as number) > 1000) fail(`${at}.feather must be 0 to 1000 px.`);
      if ((s.feather as number) > 0) out.feather = s.feather as number;
    }
    if (s.invert === true) out.invert = true;
    return out;
  };
  const sampling = (): RecipeSampling => {
    const out: RecipeSampling = {};
    if (s.sample !== undefined) {
      if (s.sample !== 'composite' && s.sample !== 'active-layer') fail(`${at}.sample must be composite or active-layer.`);
      out.sample = s.sample as 'composite' | 'active-layer';
    }
    if (s.sampleMerged === true) out.sampleMerged = true;
    return out;
  };
  const options = () => (s.options && typeof s.options === 'object' ? { options: JSON.parse(JSON.stringify(s.options)) as Record<string, unknown> } : {});
  switch (s.op) {
    case 'rect':
    case 'ellipse':
      return { op: s.op, rect: rect(s.rect, `${at}.rect`), ...(s.antiAlias === false ? { antiAlias: false } : {}), ...combine() };
    case 'polygon': {
      if (!Array.isArray(s.points) || s.points.length < 3) fail(`${at}.points must be at least 3 { x, y } points.`);
      return { op: 'polygon', points: (s.points as unknown[]).map((p, i) => point(p, `${at}.points[${i}]`)), ...(s.antiAlias === false ? { antiAlias: false } : {}), ...combine() };
    }
    case 'magic-wand':
      return { op: 'magic-wand', point: point(s.point, `${at}.point`), ...options(), ...combine(), ...sampling() };
    case 'color-range':
      if (!Array.isArray(s.samples) || !s.samples.length) fail(`${at}.samples must be a non-empty list of colour samples.`);
      return { op: 'color-range', samples: JSON.parse(JSON.stringify(s.samples)), ...options(), ...combine(), ...sampling() };
    case 'color-range-preset':
      if (typeof s.preset !== 'string' || !isColorRangePreset(s.preset)) fail(`${at}.preset is not a Color Range preset.`);
      return { op: 'color-range-preset', preset: s.preset as string, ...(finite(s.falloff) ? { falloff: s.falloff as number } : {}), ...combine(), ...sampling() };
    case 'all':
      return { op: 'all' };
    case 'invert':
      return { op: 'invert' };
    case 'modify':
      if (!SELECTION_MODIFY_OPS.includes(s.modify as SelectionModifyOp)) fail(`${at}.modify must be one of ${SELECTION_MODIFY_OPS.join(', ')}.`);
      if (!finite(s.radius) || (s.radius as number) < 0 || (s.radius as number) > 500) fail(`${at}.radius must be 0 to 500 px.`);
      return { op: 'modify', modify: s.modify as SelectionModifyOp, radius: s.radius as number };
    case 'refine':
      if (!s.params || typeof s.params !== 'object') fail(`${at}.params must be the refine settings (radius, smooth, feather, contrast, shiftEdge).`);
      return { op: 'refine', params: JSON.parse(JSON.stringify(s.params)) as RefineEdgeParams, ...sampling() };
    default:
      return fail(`${at}.op "${String(s.op)}" is not a recipe step; use ${SELECTION_RECIPE_OPS.join(', ')}.`);
  }
}

/**
 * The selection `steps` make on a `width × height` canvas, from nothing (null when nothing ends
 * up selected). `pixelsFor` gives a pixel step its image (see `samplingKey`).
 */
export function replaySelectionRecipe(steps: readonly SelectionRecipeStep[], width: number, height: number, pixelsFor: (step: SelectionRecipeStep) => PixelBuffer): SelectionMask | null {
  let sel: SelectionMask | null = null;
  steps.forEach((step, i) => {
    const shape = (mask: SelectionMask) => {
      const st = step as RecipeCombine;
      let m = st.feather && st.feather > 0 ? modifySelection(mask, 'feather', st.feather) : mask;
      if (st.invert) m = invertSelection(m);
      return combineSelections(sel, m, st.mode ?? 'replace');
    };
    let next: SelectionMask | null;
    switch (step.op) {
      case 'rect':
        next = shape(rectSelection(width, height, step.rect, { antiAlias: step.antiAlias }));
        break;
      case 'ellipse':
        next = shape(ellipseSelection(width, height, step.rect, { antiAlias: step.antiAlias }));
        break;
      case 'polygon':
        next = shape(polygonSelection(width, height, step.points, { antiAlias: step.antiAlias }));
        break;
      case 'magic-wand':
        next = shape(magicWand(pixelsFor(step), step.point, step.options ?? {}));
        break;
      case 'color-range':
        next = shape(colorRange(pixelsFor(step), step.samples, step.options ?? {}));
        break;
      case 'color-range-preset':
        next = shape(colorRangePreset(pixelsFor(step), step.preset as Parameters<typeof colorRangePreset>[1], step.falloff !== undefined ? { falloff: step.falloff } : {}));
        break;
      case 'all':
        next = fullSelection(width, height);
        break;
      case 'invert':
        // With nothing selected, Inverse selects everything (as Select › Inverse does).
        next = sel ? invertSelection(sel) : fullSelection(width, height);
        break;
      case 'modify':
        if (!sel?.bounds) throw new Error(`Step ${i} (modify) has nothing selected to ${step.modify}; an earlier step must select something.`);
        next = modifySelection(sel, step.modify, step.radius);
        break;
      case 'refine':
        if (!sel?.bounds) throw new Error(`Step ${i} (refine) has nothing selected to refine; an earlier step must select something.`);
        next = refineSelection(stepNeedsPixels(step) ? pixelsFor(step) : null, sel, step.params);
        break;
    }
    sel = next?.bounds ? next : null;
  });
  return sel;
}

/** A recipe as an agent reads it: each step with its index. */
export function describeRecipe(steps: readonly SelectionRecipeStep[]): Array<{ index: number } & SelectionRecipeStep> {
  return steps.map((s, index) => ({ index, ...JSON.parse(JSON.stringify(s)) }));
}

const SHAPE_LABELS: Record<string, string> = { rect: 'Rectangle', ellipse: 'Ellipse' };
const MODIFY_LABELS: Record<string, string> = { expand: 'Expand', grow: 'Expand', contract: 'Contract', shrink: 'Contract', feather: 'Feather', border: 'Border', smooth: 'Smooth' };

/** A step in a few words, for a recipe list ("Rectangle 30 × 20 at 10, 10", "Smooth 2 px"). */
export function describeRecipeStep(step: SelectionRecipeStep): string {
  const r = (n: number) => Math.round(n);
  switch (step.op) {
    case 'rect':
    case 'ellipse':
      return `${SHAPE_LABELS[step.op]} ${r(step.rect.width)} × ${r(step.rect.height)} at ${r(step.rect.x)}, ${r(step.rect.y)}`;
    case 'polygon':
      return `Polygon, ${step.points.length} points`;
    case 'magic-wand':
      return `Magic Wand at ${r(step.point.x)}, ${r(step.point.y)}`;
    case 'color-range':
      return `Color Range, ${step.samples.length} sample${step.samples.length === 1 ? '' : 's'}`;
    case 'color-range-preset':
      return `Color Range: ${step.preset}`;
    case 'all':
      return 'Select All';
    case 'invert':
      return 'Inverse';
    case 'modify':
      return `${MODIFY_LABELS[step.modify] ?? step.modify} ${step.radius} px`;
    case 'refine':
      return 'Refine Edge';
  }
}

/**
 * A step's main setting for a recipe list (feather, tolerance, fuzziness, falloff or radius) and
 * the change that sets it, or null for steps with none.
 */
export function recipeStepSetting(step: SelectionRecipeStep): { label: string; value: number; min: number; max: number; change: (v: number) => Record<string, unknown> } | null {
  switch (step.op) {
    case 'rect':
    case 'ellipse':
    case 'polygon':
      return { label: 'feather', value: step.feather ?? 0, min: 0, max: 1000, change: (v) => ({ feather: v }) };
    case 'magic-wand': {
      const options = step.options ?? {};
      return { label: 'tolerance', value: Number(options.tolerance ?? 32), min: 0, max: 255, change: (v) => ({ options: { ...options, tolerance: v } }) };
    }
    case 'color-range': {
      const options = step.options ?? {};
      return { label: 'fuzziness', value: Number(options.fuzziness ?? 40), min: 0, max: 200, change: (v) => ({ options: { ...options, fuzziness: v } }) };
    }
    case 'color-range-preset':
      return step.preset === 'highlights' || step.preset === 'midtones' || step.preset === 'shadows' ? { label: 'falloff', value: step.falloff ?? 20, min: 0, max: 255, change: (v) => ({ falloff: v }) } : null;
    case 'modify':
      return { label: 'radius', value: step.radius, min: 0, max: 500, change: (v) => ({ radius: v }) };
    case 'refine':
      return { label: 'radius', value: step.params.radius ?? 8, min: 0, max: 64, change: (v) => ({ params: { ...step.params, radius: v } }) };
    default:
      return null;
  }
}
