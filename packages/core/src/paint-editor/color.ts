/**
 * Colour for painters: hex / RGB / HSV / HSL conversions, a colour wheel that is either the
 * painter's red-yellow-blue wheel (where red's complement is green) or the RGB wheel (where it is
 * cyan), harmonies on it, and swatches.
 */

import { paintSourceColor, readPaintSource, type PaintGradientSource } from '../paint/gradient-paint';
import {
  wheelToHue,
  hueToWheel,
  colorHarmony as coreColorHarmony,
  type ColorWheel,
  type HarmonyKind,
  type HarmonyColor,
  HARMONY_KINDS
} from '../color/index.js';

export type { ColorWheel, HarmonyKind, HarmonyColor };
export { HARMONY_KINDS, wheelToHue, hueToWheel };

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

/**
 * The colours of a harmony around `base`, the base first. Hue-based harmonies keep the base's
 * saturation and value and turn it around the wheel; `analogous` spreads by `spread` degrees
 * (default 30); `monochromatic` keeps the hue and steps the lightness.
 */
export function colorHarmony(base: string, kind: HarmonyKind, options: { wheel?: ColorWheel; spread?: number } = {}): HarmonyColor[] {
  return coreColorHarmony(base, kind, options);
}

export interface Swatch {
  /** #rrggbb (for a gradient swatch: its first colour, what plain colour slots show). */
  color: string;
  name?: string;
  /** Gradient paint held by the swatch (`setPaint` picks it); missing for a colour swatch. */
  paint?: PaintGradientSource;
}

/** A swatch read from JSON, or `null` when it is not one (a gradient swatch keeps its gradient). */
export function readSwatch(raw: unknown): Swatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const g = readPaintSource(r.paint);
  const color = typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color.toLowerCase() : g?.type === 'gradient' ? paintSourceColor(g) : null;
  if (!color) return null;
  const out: Swatch = { color };
  if (typeof r.name === 'string' && r.name.trim()) out.name = r.name.trim().slice(0, 80);
  if (g?.type === 'gradient') out.paint = g;
  return out;
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
