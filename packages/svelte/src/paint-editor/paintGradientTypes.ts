/**
 * Gradient paint types for `PaintGradientEditorView`, written out here so the view imports nothing
 * from a core entry: it is shared by the paint editor and image editor entries, each of which may
 * import only its own (`tests/entry-isolation.test.ts`; Svelte ships its components as source).
 * They copy `@pixerate/editor/paint`'s shapes; the wrappers pass core-typed values in, so
 * svelte-check fails if the two drift apart.
 */

export interface GradientStop {
  offset: number;
  color: string;
  opacity?: number;
  midpoint?: number;
}
export type GradientRepeat = 'clamp' | 'repeat' | 'mirror';
export type GradientSpace = 'pigment' | 'oklab' | 'srgb';
export type GradientMapping =
  | { by: 'distance'; length: number; repeat: GradientRepeat; unit?: 'px' | 'dabs' }
  | { by: 'pressure' }
  | { by: 'tilt' }
  | { by: 'velocity' }
  | { by: 'direction' }
  | { by: 'time'; duration: number; repeat?: GradientRepeat }
  | { by: 'across-tip' }
  | { by: 'random'; every?: number };
export type GradientMappingKind = GradientMapping['by'];
export interface Gradient {
  type: 'gradient';
  stops: GradientStop[];
  space: GradientSpace;
  map: GradientMapping;
  softness?: number;
}
export type GradientColors = { paint: string; secondary: string };

/** The `PAINT_GRADIENT_KIT` the view uses. */
export interface GradientKit {
  readonly PAINT_GRADIENT_MAPPINGS: readonly GradientMappingKind[];
  readonly PAINT_GRADIENT_MAPPING_LABELS: Readonly<Record<GradientMappingKind, string>>;
  readonly PAINT_GRADIENT_PRESETS: readonly { name: string; paint: Gradient }[];
  readonly PAINT_GRADIENT_REPEATS: readonly GradientRepeat[];
  readonly PAINT_GRADIENT_REPEAT_LABELS: Readonly<Record<GradientRepeat, string>>;
  readonly PAINT_GRADIENT_SPACES: readonly GradientSpace[];
  readonly PAINT_GRADIENT_SPACE_LABELS: Readonly<Record<GradientSpace, string>>;
  addPaintGradientStop(g: Gradient, offset: number, colors?: GradientColors): { paint: Gradient; index: number };
  paintGradientMappingFor(by: GradientMappingKind, current: GradientMapping): GradientMapping;
  paintSourceCss(s: Gradient, colors?: GradientColors): string;
  removePaintGradientStop(g: Gradient, index: number): Gradient;
  reversePaintGradient(g: Gradient): Gradient;
  updatePaintGradientStop(g: Gradient, index: number, patch: Partial<GradientStop>): { paint: Gradient; index: number };
}
