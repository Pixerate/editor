import { selectionArea, type SelectionMask, type SelectionMode } from './mask';
import type { ColorDistance, ColorRangePreset } from './wand';
import type { RefineEdgeParams } from './refine';

/** Selection tools of the image editor UI. */
export type SelectionToolKind = 'wand' | 'rect' | 'ellipse' | 'row' | 'column' | 'lasso' | 'polygon' | 'range' | 'type' | 'type-vertical';

export const SELECTION_TOOLS: readonly { id: SelectionToolKind; label: string }[] = [
  { id: 'wand', label: 'Magic Wand' },
  { id: 'rect', label: 'Rectangle' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'row', label: 'Single Row' },
  { id: 'column', label: 'Single Column' },
  { id: 'lasso', label: 'Lasso' },
  { id: 'polygon', label: 'Polygonal Lasso' },
  { id: 'range', label: 'Color Range' },
  { id: 'type', label: 'Type Mask' },
  { id: 'type-vertical', label: 'Vertical Type Mask' },
];

/** Labels of the Color Range presets, in menu order. */
export const COLOR_RANGE_PRESET_LABELS: Record<ColorRangePreset, string> = {
  reds: 'Reds',
  yellows: 'Yellows',
  greens: 'Greens',
  cyans: 'Cyans',
  blues: 'Blues',
  magentas: 'Magentas',
  highlights: 'Highlights',
  midtones: 'Midtones',
  shadows: 'Shadows',
  skinTones: 'Skin Tones',
};

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
  /** Feather new marquee, lasso, wand and Color Range selections by this many pixels (default 0). */
  feather?: number;
  /** Color Range: levels over which a sampled colour's coverage fades out (0..200, default 40). */
  fuzziness?: number;
  /** Color Range: limit each click to this radius in pixels (Localized Color Clusters; 0 = off). */
  localized?: number;
  /** Color Range: select everything except the sampled colours. */
  rangeInvert?: boolean;
  /** Type Mask: the text to select (default "Type"). A click places its first baseline. */
  typeText?: string;
  /** Type Mask: font size in px (default 72). */
  typeSize?: number;
  /** Type Mask: font family (default sans-serif). */
  typeFamily?: string;
}

export const DEFAULT_SELECTION_TOOL_OPTIONS: SelectionToolOptions = {
  tool: 'wand',
  mode: 'replace',
  tolerance: 32,
  contiguous: true,
  antiAlias: true,
  sampleMerged: false,
  distance: 'rgb',
  feather: 0,
  fuzziness: 40,
  localized: 0,
  rangeInvert: false,
  typeText: 'Type',
  typeSize: 72,
  typeFamily: 'sans-serif',
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
  const pct = (selectionArea(mask) / (mask.width * mask.height)) * 100;
  const shown = pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return `${mask.bounds.width} × ${mask.bounds.height} px selected (${shown}% of the image)`;
}
