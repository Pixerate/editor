/**
 * Brush presets for the image editor's brush tools: a brush from the shared brush library
 * (`@pixerate/editor/brushes`), checked against `IMAGE_PROFILE` and turned into the paint tool it
 * needs (brush, Mixer Brush or eraser), its `BrushSettings`, its Mixer Brush settings and, for a
 * brush with its own gradient, its paint.
 */

import { closest } from '../brushes/library';
import { checkBrush, IMAGE_PROFILE } from '../brushes/profiles';
import { resolveBrush } from '../brushes/resolve';
import type { Brush } from '../brushes/types';
import { brushColourHex } from '../brushes/colour';
import type { ColorScheme } from '../color/dual';
import type { BrushSettings, MixerSettings, PaintSource } from '../paint';

/** What choosing a brush preset sets in the image editor. */
export interface ImageBrushPreset {
  id: string;
  name: string;
  /** The paint tool it paints with. */
  tool: 'brush' | 'mixer' | 'eraser';
  brush: BrushSettings;
  /** Mixer Brush settings (tool `mixer`). */
  mixer?: MixerSettings;
  /** The brush's own gradient paint, when it has one. */
  paint?: PaintSource;
  /** Its solid or light / dark default colour as #rrggbb for the colour scheme: the foreground it sets. */
  color?: string;
  /** Settings the image editor paints without (grain, velocity…), with what they would need. */
  warnings: string[];
}

/** Thrown for a brush the image editor can't paint, saying why and what to use instead. */
export class ImageBrushPresetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageBrushPresetError';
  }
}

/**
 * The image editor's settings for a brush, or an `ImageBrushPresetError` naming the facets
 * `IMAGE_PROFILE` refuses (wet or thick paint, particles, stickers, light…) and their fixes.
 * `ids` are the brushes on offer, for the error's suggestions.
 */
export function imageBrushPreset(brush: Brush, ids: readonly string[] = [], scheme: ColorScheme = 'light'): ImageBrushPreset {
  const check = checkBrush(brush, IMAGE_PROFILE);
  if (!check.ok) {
    const why = check.issues
      .filter((i) => i.severity === 'error')
      .map((i) => `${i.reason} ${i.fix}`)
      .join(' ');
    throw new ImageBrushPresetError(`Brush "${brush.id}" (${brush.name}) can't paint in the image editor: ${why}${ids.length ? ` ${closest(brush.id, ids)}list_brush_presets lists the ones it can.` : ''}`);
  }
  const resolved = resolveBrush(brush);
  const tool = resolved.engine === 'eraser' ? 'eraser' : resolved.engine === 'mixer' ? 'mixer' : 'brush';
  return {
    id: brush.id,
    name: brush.name,
    tool,
    brush: { ...resolved.tip },
    ...(tool === 'mixer' ? { mixer: { ...resolved.mixer } } : {}),
    ...(resolved.paint && tool === 'brush' ? { paint: resolved.paint } : {}),
    ...(tool !== 'eraser' && brush.colour?.default !== undefined && brushColourHex(brush.colour.default, scheme) ? { color: brushColourHex(brush.colour.default, scheme)! } : {}),
    warnings: check.issues.filter((i) => i.severity === 'warning').map((i) => i.reason),
  };
}
