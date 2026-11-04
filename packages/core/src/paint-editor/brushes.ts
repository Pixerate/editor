/**
 * Paint editor brushes: re-exports the brush model (`./brush-model`) and derives the built-in
 * engine brush library (`BUILTIN_BRUSHES`) from `BRUSH_PRESETS` (`@pixerate/editor/brushes`).
 */

import { BRUSH_PRESETS } from '../brushes/presets';
import { resolveBrush } from '../brushes/resolve';
import type { PaintBrush } from './brush-model';

export * from './brush-model';

/** The built-in brush library, derived from `BRUSH_PRESETS` (`@pixerate/editor/brushes`). */
export const BUILTIN_BRUSHES: readonly PaintBrush[] = BRUSH_PRESETS.map((b) => resolveBrush(b, { builtin: true }));
