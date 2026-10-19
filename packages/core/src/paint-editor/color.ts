/**
 * Colour for painters: hex / RGB / HSV / HSL conversions, a colour wheel that is either the
 * painter's red-yellow-blue wheel (where red's complement is green) or the RGB wheel (where it is
 * cyan), harmonies on it, and swatches.
 */

export type Rgb255 = [number, number, number];

const HEX = /^#?([0-9a-f]{6})$/i;

export function parseHexColor(value: unknown, what = 'color'): Rgb255 {
  const m = typeof value === 'string' ? HEX.exec(value.trim()) : null;
  if (!m) throw new Error(`${what} is ${JSON.stringify(value)}; use #rrggbb, e.g. "#2a4b8d".`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHexColor(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}

/** RGB 0..255 → HSV with h in degrees 0..360, s and v 0..1. */
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === R) h = 60 * (((G - B) / d) % 6);
    else if (max === G) h = 60 * ((B - R) / d + 2);
    else h = 60 * ((R - G) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb(h: number, s: number, v: number): Rgb255 {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** RGB 0..255 → HSL with h in degrees, s and l 0..1. */
export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const { h } = rgbToHsv(r, g, b);
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  return { h, s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l };
}

export function hslToRgb(h: number, s: number, l: number): Rgb255 {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const v = l + c / 2;
  return hsvToRgb(h, v === 0 ? 0 : c / v, v);
}

/** Which wheel hues live on: `ryb` (painter's: red ↔ green complements) or `rgb` (red ↔ cyan). */
export type ColorWheel = 'ryb' | 'rgb';

// RYB wheel angle → RGB hue (a piecewise-linear map through red, orange, yellow, green, blue, violet).
const RYB_STOPS: ReadonlyArray<[number, number]> = [
  [0, 0],
  [60, 30],
  [120, 60],
  [180, 120],
  [240, 240],
  [300, 280],
  [360, 360],
];

function piecewise(v: number, from: 0 | 1): number {
  const x = ((v % 360) + 360) % 360;
  const to = from === 0 ? 1 : 0;
  for (let i = 1; i < RYB_STOPS.length; i++) {
    const a = RYB_STOPS[i - 1];
    const b = RYB_STOPS[i];
    if (x <= b[from]) return a[to] + ((x - a[from]) / (b[from] - a[from])) * (b[to] - a[to]);
  }
  return x;
}

/** A wheel angle (degrees) → an RGB hue. */
export function wheelToHue(angle: number, wheel: ColorWheel): number {
  return wheel === 'rgb' ? ((angle % 360) + 360) % 360 : piecewise(angle, 0);
}

/** An RGB hue → its wheel angle (degrees). */
export function hueToWheel(hue: number, wheel: ColorWheel): number {
  return wheel === 'rgb' ? ((hue % 360) + 360) % 360 : piecewise(hue, 1);
}

export type HarmonyKind = 'complementary' | 'split-complementary' | 'analogous' | 'triadic' | 'tetradic' | 'square' | 'monochromatic';

export const HARMONY_KINDS: readonly HarmonyKind[] = ['complementary', 'split-complementary', 'analogous', 'triadic', 'tetradic', 'square', 'monochromatic'];

export interface HarmonyColor {
  color: string;
  /** Position on the wheel, degrees. */
  angle: number;
}

/**
 * The colours of a harmony around `base`, the base first. Hue-based harmonies keep the base's
 * saturation and value and turn it around the wheel; `analogous` spreads by `spread` degrees
 * (default 30); `monochromatic` keeps the hue and steps the lightness.
 */
export function colorHarmony(base: string, kind: HarmonyKind, options: { wheel?: ColorWheel; spread?: number } = {}): HarmonyColor[] {
  const wheel = options.wheel ?? 'ryb';
  const [r, g, b] = parseHexColor(base, 'base');
  const hsv = rgbToHsv(r, g, b);
  const start = hueToWheel(hsv.h, wheel);
  const at = (angle: number): HarmonyColor => {
    const a = ((angle % 360) + 360) % 360;
    const [rr, gg, bb] = hsvToRgb(wheelToHue(a, wheel), hsv.s, hsv.v);
    return { color: rgbToHexColor(rr, gg, bb), angle: Math.round(a * 10) / 10 };
  };
  const spread = options.spread ?? 30;
  const offsets: Record<Exclude<HarmonyKind, 'monochromatic'>, number[]> = {
    complementary: [0, 180],
    'split-complementary': [0, 180 - spread, 180 + spread],
    analogous: [0, -spread, spread],
    triadic: [0, 120, 240],
    tetradic: [0, 60, 180, 240],
    square: [0, 90, 180, 270],
  };
  if (kind === 'monochromatic') {
    const hsl = rgbToHsl(r, g, b);
    const steps = [0, -0.3, -0.15, 0.15, 0.3];
    return steps.map((d) => {
      const [rr, gg, bb] = d === 0 ? [r, g, b] : hslToRgb(hsl.h, hsl.s, Math.min(0.97, Math.max(0.03, hsl.l + d)));
      return { color: rgbToHexColor(rr, gg, bb), angle: Math.round(start * 10) / 10 };
    });
  }
  return offsets[kind].map((o, i) => (i === 0 ? { color: rgbToHexColor(r, g, b), angle: Math.round(start * 10) / 10 } : at(start + o)));
}

export interface Swatch {
  color: string;
  name?: string;
}

/** A starting palette of our own generic paint colours. */
export const DEFAULT_SWATCHES: readonly Swatch[] = [
  { color: '#f7f5ee', name: 'Warm white' },
  { color: '#f3d23a', name: 'Lemon yellow' },
  { color: '#c8912f', name: 'Yellow ochre' },
  { color: '#d23a2a', name: 'Warm red' },
  { color: '#9e1f3d', name: 'Crimson' },
  { color: '#8a4a2b', name: 'Burnt earth' },
  { color: '#2f3f9e', name: 'Deep blue' },
  { color: '#1d6f8f', name: 'Cool blue' },
  { color: '#4f6e2c', name: 'Leaf green' },
  { color: '#25221f', name: 'Warm black' },
];
