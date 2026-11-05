/**
 * Preview colours for brushes: what a preview is drawn on and the colour that reads on it.
 * `brushPreviewColours` picks the background (the renderer's paper, or dark paper for brushes
 * that give off light) and a stroke colour with at least 3:1 contrast against it: the brush's
 * default colour, resolved for that background (a light / dark pair takes its side), else a
 * colour for the medium. Multiply brushes preview on white rather than a dark surface. Previews
 * only: it never sets anyone's paint colour.
 */

import { contrastRatio, relativeLuminance } from '../color/contrast';
import { isDualColor, type ColorScheme, type DualColor } from '../color/dual';
import { oklabToOklch, oklabToRgb, oklchToOklab, rgbToOklab } from '../color/convert';
import { formatHex } from '../color/format';
import { toSrgbGamut } from '../color/gamut';
import { parseColor } from '../color/parse';
import type { Rgba } from '../color/types';
import { brushColourHex } from './colour';
import { PAINT_PROFILE, type BrushHostProfile } from './profiles';
import type { Brush } from './types';

/** The paper behind brushes that give off light, so their glow reads. */
export const BRUSH_PREVIEW_DARK_PAPER = '#141414';

/** The contrast a preview colour keeps against its background (WCAG large-text / graphics). */
export const BRUSH_PREVIEW_MIN_CONTRAST = 3;

/** Preview colours for brushes with no solid default, by medium (`tools` for tool brushes). */
export const BRUSH_PREVIEW_FALLBACKS: Readonly<Record<string, DualColor>> = {
  dry: { light: '#3f3f46', dark: '#e4e4e7' },
  ink: { light: '#1e293b', dark: '#e2e8f0' },
  paint: { light: '#1d4ed8', dark: '#93c5fd' },
  spray: { light: '#0f766e', dark: '#5eead4' },
  other: { light: '#334155', dark: '#cbd5e1' },
  tools: { light: '#475569', dark: '#cbd5e1' },
};

/**
 * Whether a brush that gives off `light` previews on dark paper: light paint glows on dark, but a
 * multiply light brush (a highlighter) is a tint on paper and previews on light paper.
 */
export function brushPreviewsOnDark(brush: { light?: { amount?: number }; tip?: { blend?: string } }): boolean {
  return (brush.light?.amount ?? 0) > 0 && brush.tip?.blend !== 'multiply';
}

export interface BrushPreviewColours {
  /** The colour the preview is drawn on (#rrggbb): the renderer's paper, or dark paper for light paint. */
  background: string;
  /** The stroke colour (#rrggbb), at least `BRUSH_PREVIEW_MIN_CONTRAST` against `background`. */
  color: string;
  /** The background's scheme: which side of a light / dark colour was used. */
  scheme: ColorScheme;
}

export interface BrushPreviewColoursOptions {
  /**
   * What the renderer draws on (#rrggbb, default white): the paper for the paint engine
   * (`DEFAULT_PAPER.color`), or the surface behind a transparent preview (the canvas renderer's).
   */
  paper?: string;
  /** The host (default the paint editor): only a host that renders light previews light brushes on dark paper. */
  profile?: BrushHostProfile;
  /** The preview can't change what is behind it (a swatch in a menu): `paper` is kept, even for multiply brushes. */
  keepPaper?: boolean;
}

const hexOf = (c: string) => brushColourHex(c, 'light') ?? '#ffffff';

/**
 * How much of its colour a brush lays in one pass, roughly: tip opacity, flow (soft brushes build
 * up) and paper grain (dry media skip the paper's dips) all thin it.
 */
export function brushPreviewStrength(brush: Brush): number {
  const opacity = brush.tip.opacity ?? 1;
  const flow = brush.tip.flow ?? 1;
  const grain = brush.behaviour?.grain ?? 0;
  // A little under the estimate: dabs overlap less at the ends of a stroke and on its edges.
  return Math.max(0.25, Math.min(1, 0.85 * opacity * (0.6 + 0.4 * flow) * (1 - 0.3 * grain)));
}

/** `fg` laid at `alpha` over `bg`. */
const over = (fg: Rgba, bg: Rgba, alpha: number): Rgba => ({ r: fg.r * alpha + bg.r * (1 - alpha), g: fg.g * alpha + bg.g * (1 - alpha), b: fg.b * alpha + bg.b * (1 - alpha), a: 1 });

/**
 * The background and stroke colour for a preview of `brush` (see the module comment). A
 * highlighter's own colour (a multiply brush that gives off light) is kept as it is: a tint reads
 * by its colour, not its lightness.
 */
export function brushPreviewColours(brush: Brush, options: BrushPreviewColoursOptions = {}): BrushPreviewColours {
  const profile = options.profile ?? PAINT_PROFILE;
  let background = profile.light === 'full' && brushPreviewsOnDark(brush) ? BRUSH_PREVIEW_DARK_PAPER : hexOf(options.paper ?? '#ffffff');
  // A multiply brush only darkens what is under it: on a dark surface it barely shows, so it
  // previews on white, as it is used on paper.
  if (!options.keepPaper && brush.tip.blend === 'multiply' && relativeLuminance(parseColor(background)!) < 0.18) background = '#ffffff';
  const bg = parseColor(background)!;
  const scheme: ColorScheme = relativeLuminance(bg) < 0.18 ? 'dark' : 'light';
  const own = brush.kind === 'mark' ? brush.colour?.default : undefined;
  const ownHex = typeof own === 'string' || isDualColor(own) ? brushColourHex(own, scheme) : null;
  // A highlighter (a multiply brush that gives off light) is a tint: its colour stays.
  if (ownHex && brush.tip.blend === 'multiply' && (brush.light?.amount ?? 0) > 0 && scheme === 'light') return { background, color: ownHex, scheme };
  const group = brush.kind === 'tool' ? 'tools' : (brush.medium ?? 'other');
  const color = ownHex ?? brushColourHex((BRUSH_PREVIEW_FALLBACKS[group] ?? BRUSH_PREVIEW_FALLBACKS.other)!, scheme)!;
  // Judged as laid down: the colour at the brush's strength over the background.
  const alpha = brushPreviewStrength(brush);
  const reads = (c: Rgba) => contrastRatio(over(c, bg, alpha), bg) >= BRUSH_PREVIEW_MIN_CONTRAST;
  const fg = parseColor(color)!;
  if (reads(fg)) return { background, color, scheme };
  // Shift the lightness away from the background (keeping hue and chroma) until it reads.
  const lch = oklabToOklch(rgbToOklab(fg));
  const step = scheme === 'dark' ? 0.01 : -0.01;
  for (let l = lch.l + step; l >= 0 && l <= 1; l += step) {
    const hex = formatHex(toSrgbGamut(oklabToRgb(oklchToOklab({ ...lch, l }))));
    if (reads(parseColor(hex)!)) return { background, color: hex, scheme };
  }
  return { background, color: scheme === 'dark' ? '#ffffff' : '#000000', scheme };
}
