/**
 * Brush colours for hosts: a brush's solid or light / dark colour as the #rrggbb a host paints
 * with, resolved for its colour scheme when the brush is chosen or a stroke starts (and recorded
 * then, so replays stay exact).
 */

import { isDualColor, resolveColor, type ColorScheme } from '../color/dual';
import { parseCssColor } from '../image-editor/layers/css-color';

/**
 * A brush colour as #rrggbb for `scheme`: a solid colour (hex, `#rrggbbaa`, `rgba()`; alpha is
 * the brush's opacity's business) or a light / dark pair; `null` for gradients and effect paint.
 */
export function brushColourHex(value: unknown, scheme: ColorScheme): string | null {
  const css = typeof value === 'string' || isDualColor(value) ? resolveColor(value, scheme) : null;
  return css ? (parseCssColor(css)?.hex.toLowerCase() ?? null) : null;
}
