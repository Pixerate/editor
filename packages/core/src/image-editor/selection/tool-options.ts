import type { SelectionMask, SelectionMode } from './mask';
import type { ColorDistance } from './wand';
import type { RefineEdgeParams } from './refine';

/** Selection tools of the image editor UI. */
export type SelectionToolKind = 'wand' | 'rect' | 'ellipse' | 'lasso';

export const SELECTION_TOOLS: readonly { id: SelectionToolKind; label: string }[] = [
  { id: 'wand', label: 'Magic Wand' },
  { id: 'rect', label: 'Rectangle' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'lasso', label: 'Lasso' },
];

export const SELECTION_MODE_LABELS: Record<SelectionMode, string> = {
  replace: 'New',
  add: 'Add',
  subtract: 'Subtract',
  intersect: 'Intersect',
};

/** The options bar of the selection tools (shared by the React and Svelte UIs). */
export interface SelectionToolOptions {
  tool: SelectionToolKind;
  mode: SelectionMode;
  /** Magic wand tolerance, 0..255. */
  tolerance: number;
  contiguous: boolean;
  antiAlias: boolean;
  /** Sample the adjusted image instead of the source. */
  sampleMerged: boolean;
  /** Sample the whole image (`composite`, default) or only the active pixel layer. */
  sample?: 'composite' | 'active-layer';
  distance: ColorDistance;
}

export const DEFAULT_SELECTION_TOOL_OPTIONS: SelectionToolOptions = {
  tool: 'wand',
  mode: 'replace',
  tolerance: 32,
  contiguous: true,
  antiAlias: true,
  sampleMerged: false,
  distance: 'rgb',
};

/**
 * Photoshop's modifier keys: Shift adds, Alt/Option subtracts, both intersect; otherwise the
 * options bar mode.
 */
export function selectionModeFromModifiers(
  modifiers: { shiftKey?: boolean; altKey?: boolean },
  fallback: SelectionMode
): SelectionMode {
  if (modifiers.shiftKey && modifiers.altKey) return 'intersect';
  if (modifiers.shiftKey) return 'add';
  if (modifiers.altKey) return 'subtract';
  return fallback;
}

export interface RefineEdgeControl {
  id: keyof Omit<RefineEdgeParams, 'smartRadius'>;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}

/** Sliders of the Refine Edge panel. */
export const REFINE_EDGE_CONTROLS: readonly RefineEdgeControl[] = [
  { id: 'radius', label: 'Radius', min: 0, max: 64, step: 1, unit: 'px' },
  { id: 'smooth', label: 'Smooth', min: 0, max: 100, step: 1, unit: '' },
  { id: 'feather', label: 'Feather', min: 0, max: 50, step: 0.5, unit: 'px' },
  { id: 'contrast', label: 'Contrast', min: 0, max: 100, step: 1, unit: '%' },
  { id: 'shiftEdge', label: 'Shift Edge', min: -100, max: 100, step: 1, unit: '%' },
];

/** A one-line status: "No selection" or "W × H px selected (n % of the image)". */
export function describeSelection(mask: SelectionMask | null | undefined): string {
  if (!mask || !mask.bounds) return 'No selection';
  let sum = 0;
  for (let i = 0; i < mask.data.length; i++) sum += mask.data[i];
  const pct = (sum / 255 / mask.data.length) * 100;
  const shown = pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return `${mask.bounds.width} × ${mask.bounds.height} px selected (${shown}% of the image)`;
}
