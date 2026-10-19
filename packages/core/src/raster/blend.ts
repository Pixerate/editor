// Portions ported from photocraft-main/crates/color/src/blend.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Photoshop blend modes on straight (non-premultiplied) 0..1 colours.
 *
 * Formulas follow the W3C Compositing / ISO 32000 definitions, with Photoshop's variants where
 * they differ (Soft Light, Vivid / Linear / Pin Light, Hard Mix, Linear Burn / Dodge, Subtract,
 * Divide, Darker / Lighter Color), and the hardened `ClipColor` for the non-separable modes.
 *
 * Plus `pigment`, which is not a `B(Cb, Cs)` mode: it replaces the alpha interpolation
 * `(1 − α)·Cb + α·B` with a Kubelka-Munk paint mix of the two colours (see `lerpPigment`).
 *
 * Plus four painterly modes of our own design, which are ordinary `B(Cb, Cs)` modes, so every
 * caller of `blendRgb` / `blendChannel` (the compositor, adjustment layers, effects, brushes) gets
 * them for free: `watercolor` (transparent washes, multiplied per wavelength), `tint` (the source's
 * colour on the backdrop's lightness, gently at the extremes), `highlight` (light added with a
 * soft shoulder) and `shadow` (light taken away, with ambient fill). See `painterlyRgb`.
 */

import { createPigment, lerpPigmentInto, reflectanceToRgb, rgbToReflectance, setPigmentColor, type Pigment } from './pigment';

export type BlendMode =
  | 'normal'
  | 'darken'
  | 'multiply'
  | 'color-burn'
  | 'linear-burn'
  | 'darker-color'
  | 'lighten'
  | 'screen'
  | 'color-dodge'
  | 'linear-dodge'
  | 'lighter-color'
  | 'overlay'
  | 'soft-light'
  | 'hard-light'
  | 'vivid-light'
  | 'linear-light'
  | 'pin-light'
  | 'hard-mix'
  | 'difference'
  | 'exclusion'
  | 'subtract'
  | 'divide'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'
  | 'pigment'
  | 'watercolor'
  | 'tint'
  | 'highlight'
  | 'shadow';

export interface BlendModeInfo {
  id: BlendMode;
  label: string;
  /** Canvas `globalCompositeOperation` with the same maths, when there is one. */
  canvas: GlobalCompositeOperation | null;
  /** True for the painterly modes (`watercolor`, `tint`, `highlight`, `shadow`), which no other app has. */
  painterly?: boolean;
  /** The nearest standard (Photoshop) mode, for formats that lack this one (PSD). Missing: it is standard. */
  standard?: BlendMode;
  /** One sentence on what the mode does (painterly and pigment modes). */
  description?: string;
}

/** Every blend mode, in Photoshop's menu order. */
export const BLEND_MODES: readonly BlendModeInfo[] = [
  { id: 'normal', label: 'Normal', canvas: 'source-over' },
  { id: 'darken', label: 'Darken', canvas: 'darken' },
  { id: 'multiply', label: 'Multiply', canvas: 'multiply' },
  { id: 'color-burn', label: 'Color Burn', canvas: 'color-burn' },
  { id: 'linear-burn', label: 'Linear Burn', canvas: null },
  { id: 'darker-color', label: 'Darker Color', canvas: null },
  { id: 'lighten', label: 'Lighten', canvas: 'lighten' },
  { id: 'screen', label: 'Screen', canvas: 'screen' },
  { id: 'color-dodge', label: 'Color Dodge', canvas: 'color-dodge' },
  { id: 'linear-dodge', label: 'Linear Dodge (Add)', canvas: null },
  { id: 'lighter-color', label: 'Lighter Color', canvas: null },
  { id: 'overlay', label: 'Overlay', canvas: 'overlay' },
  // Canvas soft-light is the W3C formula, not Photoshop's: use the scalar path.
  { id: 'soft-light', label: 'Soft Light', canvas: null },
  { id: 'hard-light', label: 'Hard Light', canvas: 'hard-light' },
  { id: 'vivid-light', label: 'Vivid Light', canvas: null },
  { id: 'linear-light', label: 'Linear Light', canvas: null },
  { id: 'pin-light', label: 'Pin Light', canvas: null },
  { id: 'hard-mix', label: 'Hard Mix', canvas: null },
  { id: 'difference', label: 'Difference', canvas: 'difference' },
  { id: 'exclusion', label: 'Exclusion', canvas: 'exclusion' },
  { id: 'subtract', label: 'Subtract', canvas: null },
  { id: 'divide', label: 'Divide', canvas: null },
  { id: 'hue', label: 'Hue', canvas: 'hue' },
  { id: 'saturation', label: 'Saturation', canvas: 'saturation' },
  { id: 'color', label: 'Color', canvas: 'color' },
  { id: 'luminosity', label: 'Luminosity', canvas: 'luminosity' },
  // Not in Photoshop: mixes like paint (blue + yellow = green). No canvas or PSD equivalent.
  {
    id: 'pigment',
    label: 'Pigment',
    canvas: null,
    standard: 'normal',
    description: 'Mixes the layer into what is below like paint, by its opacity: blue and yellow make green.',
  },
  // Painterly modes (ours; see `painterlyRgb`). No canvas equivalent; PSD gets `standard`.
  {
    id: 'watercolor',
    label: 'Watercolor',
    canvas: null,
    painterly: true,
    standard: 'multiply',
    description: 'A transparent wash: the colours filter each other wavelength by wavelength, so layers darken like glazes and blue over yellow gives green. White is clear.',
  },
  {
    id: 'tint',
    label: 'Tint',
    canvas: null,
    painterly: true,
    standard: 'color',
    description: "Tints what is below with the layer's colour and keeps its lightness; mid-tones take the full tint, highlights and darks stay clean.",
  },
  {
    id: 'highlight',
    label: 'Highlight',
    canvas: null,
    painterly: true,
    standard: 'screen',
    description: 'Adds the layer as coloured light that rolls off softly towards white instead of clipping. Black adds nothing.',
  },
  {
    id: 'shadow',
    label: 'Shadow',
    canvas: null,
    painterly: true,
    standard: 'multiply',
    description: "Shades what is below as if the layer blocked the light, coloured by the layer, with ambient light so it never crushes to black. White does nothing.",
  },
];

const BLEND_INFO = new Map<string, BlendModeInfo>(BLEND_MODES.map((m) => [m.id, m]));

export function isBlendMode(value: unknown): value is BlendMode {
  return typeof value === 'string' && BLEND_INFO.has(value);
}

/** The painterly modes, in menu order. */
export const PAINTERLY_BLEND_MODES: readonly BlendMode[] = BLEND_MODES.filter((m) => m.painterly).map((m) => m.id);

/** Whether a mode is one of the painterly modes (`watercolor`, `tint`, `highlight`, `shadow`). */
export function isPainterlyBlendMode(mode: unknown): boolean {
  return typeof mode === 'string' && Boolean(BLEND_INFO.get(mode)?.painterly);
}

/**
 * The nearest standard (Photoshop) mode: the mode itself when it is standard, `normal` for
 * `pigment`, and each painterly mode's closest relative (watercolour and shadow → multiply,
 * tint → color, highlight → screen). For writing formats that lack our modes, such as PSD.
 */
export function standardBlendMode(mode: BlendMode): BlendMode {
  return BLEND_INFO.get(mode)?.standard ?? mode;
}

/** A stored blend mode, or `normal` for a missing / unknown value. */
export function normalizeBlendMode(value: unknown): BlendMode {
  return isBlendMode(value) ? value : 'normal';
}

/**
 * The canvas composite operation that implements `mode` exactly, or `null` when the canvas has
 * none (draw through {@link blendImageData} instead).
 */
export function canvasCompositeOperation(mode: BlendMode | undefined): GlobalCompositeOperation | null {
  return BLEND_INFO.get(mode ?? 'normal')?.canvas ?? null;
}

/**
 * Whether a mode works channel by channel. The non-separable ones work on whole colours (hue,
 * saturation, colour, luminosity, darker / lighter colour, pigment).
 */
export function isSeparableBlendMode(mode: BlendMode): boolean {
  return !(
    mode === 'pigment' ||
    mode === 'watercolor' ||
    mode === 'tint' ||
    mode === 'hue' ||
    mode === 'saturation' ||
    mode === 'color' ||
    mode === 'luminosity' ||
    mode === 'darker-color' ||
    mode === 'lighter-color'
  );
}

function colorBurn(cb: number, cs: number): number {
  if (cb >= 1) return 1;
  if (cs <= 0) return 0;
  return 1 - Math.min(1, (1 - cb) / cs);
}

function colorDodge(cb: number, cs: number): number {
  if (cb <= 0) return 0;
  if (cs >= 1) return 1;
  return Math.min(1, cb / (1 - cs));
}

function hardLight(cb: number, cs: number): number {
  if (cs <= 0.5) return cb * 2 * cs;
  const s = 2 * cs - 1;
  return cb + s - cb * s;
}

/** Photoshop's Soft Light (differs from W3C in the upper half). */
function softLight(cb: number, cs: number): number {
  return cs <= 0.5
    ? 2 * cb * cs + cb * cb * (1 - 2 * cs)
    : 2 * cb * (1 - cs) + Math.sqrt(Math.max(0, cb)) * (2 * cs - 1);
}

function vividLightHardMix(cb: number, cs: number): number {
  const EDGE = 1e-4;
  if (cs <= 0.5) {
    if (cb >= 1 - EDGE) return 1;
    if (cs <= 0) return 0;
    return 1 - Math.min(1, (1 - cb) / (2 * cs));
  }
  if (cb <= EDGE) return 0;
  if (cs >= 1) return 1;
  return Math.min(1, cb / (2 * (1 - cs)));
}

/** Separable blend function `B(cb, cs)` of one channel. Non-separable modes return `cs`. */
export function blendChannel(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case 'normal':
      return cs;
    case 'darken':
      return Math.min(cb, cs);
    case 'multiply':
      return cb * cs;
    case 'color-burn':
      return colorBurn(cb, cs);
    case 'linear-burn':
      return Math.max(0, cb + cs - 1);
    case 'lighten':
      return Math.max(cb, cs);
    case 'screen':
      return cb + cs - cb * cs;
    case 'color-dodge':
      return colorDodge(cb, cs);
    case 'linear-dodge':
      return Math.min(1, cb + cs);
    case 'overlay':
      return hardLight(cs, cb);
    case 'soft-light':
      return softLight(cb, cs);
    case 'hard-light':
      return hardLight(cb, cs);
    case 'vivid-light':
      if (cs <= 0) return 0;
      if (cs >= 1) return 1;
      return cs <= 0.5 ? colorBurn(cb, 2 * cs) : colorDodge(cb, 2 * (cs - 0.5));
    case 'linear-light':
      return Math.min(1, Math.max(0, cb + 2 * cs - 1));
    case 'pin-light':
      return cs <= 0.5 ? Math.min(cb, 2 * cs) : Math.max(cb, 2 * cs - 1);
    case 'hard-mix':
      return vividLightHardMix(cb, cs) >= 0.5 - 1e-6 ? 1 : 0;
    case 'difference':
      return Math.abs(cb - cs);
    case 'exclusion':
      return cb + cs - 2 * cb * cs;
    case 'subtract':
      return Math.max(0, cb - cs);
    case 'divide':
      if (cs <= 0) return cb <= 0 ? 0 : 1;
      return Math.min(1, cb / cs);
    case 'highlight':
      return highlight(cb, cs);
    case 'shadow':
      return shadow(cb, cs);
    default:
      return cs;
  }
}

export type Rgb = [number, number, number];
export type Rgba = [number, number, number, number];

/** Luminosity of the non-separable modes (W3C / ISO 32000 weights). */
export function blendLum(c: readonly number[]): number {
  return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
}

/**
 * ClipColor, hardened: when the luminosity itself is out of range no colour of that luminosity
 * is in gamut, so the result is its grey (the spec formula turned such colours inside out and,
 * for greys, divided by rounding noise).
 */
function clipColor(c: Rgb): Rgb {
  const l = blendLum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let out: Rgb = [c[0], c[1], c[2]];
  if (n < 0) {
    const d = l - n;
    out = out.map((v) => (l > 0 && d > 0 ? l + ((v - l) * l) / d : l)) as Rgb;
  }
  if (x > 1) {
    const d = x - l;
    out = out.map((v) => (l < 1 && d > 0 ? l + ((v - l) * (1 - l)) / d : l)) as Rgb;
  }
  return out;
}

/** `c` with its luminosity moved to `l`, clipped back into gamut towards grey (SetLum + ClipColor). */
export function setLum(c: readonly number[], l: number): Rgb {
  const d = l - blendLum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

function sat(c: readonly number[]): number {
  return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
}

function setSat(c: readonly number[], s: number): Rgb {
  const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const [imin, imid, imax] = idx;
  const out: Rgb = [0, 0, 0];
  if (c[imax] > c[imin]) {
    out[imid] = ((c[imid] - c[imin]) * s) / (c[imax] - c[imin]);
    out[imax] = s;
  }
  out[imin] = 0;
  return out;
}

/**
 * `B(Cb, Cs)` of a whole colour, including the non-separable modes. `pigment` has no `B` and
 * returns `Cs`; composite it with {@link blendPixel} or {@link mixPigmentRgb}.
 */
export function blendRgb(mode: BlendMode, cb: readonly number[], cs: readonly number[]): Rgb {
  switch (mode) {
    case 'hue':
      return setLum(setSat(cs, sat(cb)), blendLum(cb));
    case 'saturation':
      return setLum(setSat(cb, sat(cs)), blendLum(cb));
    case 'color':
      return setLum(cs, blendLum(cb));
    case 'luminosity':
      return setLum(cb, blendLum(cs));
    case 'darker-color':
      return blendLum(cs) < blendLum(cb) ? [cs[0], cs[1], cs[2]] : [cb[0], cb[1], cb[2]];
    case 'lighter-color':
      return blendLum(cs) > blendLum(cb) ? [cs[0], cs[1], cs[2]] : [cb[0], cb[1], cb[2]];
    case 'watercolor':
      return watercolor(cb, cs);
    case 'tint':
      return tint(cb, cs);
    default:
      return [blendChannel(mode, cb[0], cs[0]), blendChannel(mode, cb[1], cs[1]), blendChannel(mode, cb[2], cs[2])];
  }
}

// ---------------------------------------------------------------------------
// Painterly modes
// ---------------------------------------------------------------------------
//
// Our own designs, written from how each effect should look. All four are true `B(Cb, Cs)`
// functions (colours 0..1, gamma-encoded), so the W3C general formula composites them like any
// other mode, opacity and alpha included. Light is added or removed in *linear* light, where it
// adds up physically; `lin` / `enc` are the sRGB transfer functions.
//
// - watercolor: R(λ) = Rb(λ)·Rs(λ) over the pigment model's reflectance spectra (non-separable).
// - tint:       Oklab: L = Lb, ab = ab_s·√(4·Lb·(1 − Lb)), chroma cut to the gamut.
// - highlight:  per channel, x = lb + (1 − lb)·(1 − e^(−ls / (1 − lb))) (separable).
// - shadow:     per channel, x = lb·(A + (1 − A)·ls), with ambient A = 0.2 (separable).

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

function lin(v: number): number {
  const c = clamp01(v);
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function enc(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/**
 * Highlight: the source is coloured light added to the backdrop in linear light. Plain addition
 * (linear dodge) clips to flat white; here the added light `ls` fills the headroom `1 − lb`
 * exponentially, `x = lb + (1 − lb)·(1 − e^(−ls / (1 − lb)))`. A little light adds almost exactly
 * `ls`, a lot approaches white without ever clipping, black adds nothing, and the backdrop's
 * gradations survive inside the highlight.
 */
function highlight(cb: number, cs: number): number {
  const lb = lin(cb);
  const ls = lin(cs);
  if (ls <= 0) return clamp01(cb);
  const room = 1 - lb;
  if (room <= 1e-9) return 1;
  return enc(lb + room * (1 - Math.exp(-ls / room)));
}

/** Shadow's ambient light: the share of light that still reaches a fully shaded area. */
export const SHADOW_AMBIENT = 0.2;

/**
 * Shadow: the source says how much light still reaches each channel (white: all of it, black:
 * none), in linear light, plus ambient light `A` that fills every shadow:
 * `x = lb·(A + (1 − A)·ls)`. A black shadow keeps a fifth of the light, so stacked shading
 * deepens gradually and darks never crush to black; a coloured source tints the shade (a blue
 * one cools it, as painters shade). White changes nothing.
 */
function shadow(cb: number, cs: number): number {
  if (cs >= 1) return clamp01(cb);
  return enc(lin(cb) * (SHADOW_AMBIENT + (1 - SHADOW_AMBIENT) * lin(cs)));
}

/** Reflectance spectra of 8-bit colours (key `r << 16 | g << 8 | b`), for `watercolor`. */
const spectrumCache = new Map<number, Float32Array>();
/** About 2.4 MB of spectra; the cache starts over when it fills. */
const SPECTRUM_CACHE_MAX = 16384;
const washScratch = new Float32Array(64);

function spectrum8(r: number, g: number, b: number): Float32Array {
  const key = (r << 16) | (g << 8) | b;
  let s = spectrumCache.get(key);
  if (!s) {
    if (spectrumCache.size >= SPECTRUM_CACHE_MAX) spectrumCache.clear();
    s = rgbToReflectance(r / 255, g / 255, b / 255);
    spectrumCache.set(key, s);
  }
  return s;
}

/**
 * Watercolor: the source is a transparent wash over the backdrop. A wash absorbs light by
 * wavelength and the paper (or paint) under it reflects what passes, so the reflectances multiply
 * band by band, `R(λ) = Rb(λ)·Rs(λ)` (Beer–Lambert through the wash), using each colour's smooth
 * reflectance spectrum from the pigment model, then back to sRGB. Multiply in RGB treats the three
 * channels as the only wavelengths, so a blue glaze over yellow goes black; spectra overlap in
 * the greens, so here it gives the deep green a real glaze does. White is clear (exactly: it
 * returns the backdrop) and each wash darkens a little more, as glazes do. Colours are quantised
 * to 8 bits and their spectra cached.
 */
function watercolor(cb: readonly number[], cs: readonly number[]): Rgb {
  const q = (v: number) => Math.round(clamp01(v) * 255);
  const b0 = q(cb[0]), b1 = q(cb[1]), b2 = q(cb[2]);
  const s0 = q(cs[0]), s1 = q(cs[1]), s2 = q(cs[2]);
  if (s0 === 255 && s1 === 255 && s2 === 255) return [clamp01(cb[0]), clamp01(cb[1]), clamp01(cb[2])];
  if (b0 === 255 && b1 === 255 && b2 === 255) return [clamp01(cs[0]), clamp01(cs[1]), clamp01(cs[2])];
  if ((b0 | b1 | b2) === 0 || (s0 | s1 | s2) === 0) return [0, 0, 0];
  const rb = spectrum8(b0, b1, b2);
  const rs = spectrum8(s0, s1, s2);
  const n = rb.length;
  for (let k = 0; k < n; k++) washScratch[k] = rb[k] * rs[k];
  const out = reflectanceToRgb(washScratch.subarray(0, n), [0, 0, 0]);
  return [out[0], out[1], out[2]];
}

/** Linear sRGB → Oklab (Björn Ottosson, 2020), written to `out`. */
function toOklab(r: number, g: number, b: number, out: number[]): void {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[0] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

/** Oklab → linear sRGB (unclipped), written to `out`. */
function fromOklab(L: number, a: number, b: number, out: number[]): void {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
}

const labB = [0, 0, 0];
const labS = [0, 0, 0];
const rgbScratch = [0, 0, 0];

const inGamut = (c: number[]) => c[0] >= -1e-6 && c[0] <= 1 + 1e-6 && c[1] >= -1e-6 && c[1] <= 1 + 1e-6 && c[2] >= -1e-6 && c[2] <= 1 + 1e-6;

/**
 * Tint: the backdrop takes the source's colour and keeps its own lightness, in Oklab (a
 * perceptual space, so the lightness really stays put, unlike `color`'s RGB-weighted luminosity):
 * `L = Lb` and `ab = ab_s·w` with `w = √(4·Lb·(1 − Lb))`. Mid-tones take the source's full
 * colour; towards white and black less of it, so a tint over a drawing leaves the paper white
 * and the blacks black. The backdrop's own hue is replaced, not averaged (averaging opposite hues
 * would grey them). Out-of-gamut results lose chroma (bisection at constant L and hue), not
 * lightness. A grey source neutralises.
 */
function tint(cb: readonly number[], cs: readonly number[]): Rgb {
  toOklab(lin(cb[0]), lin(cb[1]), lin(cb[2]), labB);
  toOklab(lin(cs[0]), lin(cs[1]), lin(cs[2]), labS);
  const L = labB[0];
  const w = Math.sqrt(Math.min(1, Math.max(0, 4 * L * (1 - L))));
  const a = labS[1] * w;
  const b = labS[2] * w;
  fromOklab(L, a, b, rgbScratch);
  if (!inGamut(rgbScratch)) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      fromOklab(L, a * mid, b * mid, rgbScratch);
      if (inGamut(rgbScratch)) lo = mid;
      else hi = mid;
    }
    fromOklab(L, a * lo, b * lo, rgbScratch);
  }
  return [enc(rgbScratch[0]), enc(rgbScratch[1]), enc(rgbScratch[2])];
}

// ---------------------------------------------------------------------------
// Pigment
// ---------------------------------------------------------------------------

/** Scratch pigments, made on first use (building one solves the spectrum table). */
let scratch: [Pigment, Pigment] | null = null;

/**
 * The `pigment` mode's colour: `t` of `cs` mixed into `cb` like paint (`lerpPigment`), written to
 * `out[0..2]`. `t ≥ 1` (or equal colours) is `cs` exactly. Colours are 0..1.
 */
export function mixPigmentRgb(cb: readonly number[], cs: readonly number[], t: number, out: number[] = [0, 0, 0]): number[] {
  if (t >= 1 || (cb[0] === cs[0] && cb[1] === cs[1] && cb[2] === cs[2])) {
    out[0] = cs[0];
    out[1] = cs[1];
    out[2] = cs[2];
    return out;
  }
  if (!(t > 0)) {
    out[0] = cb[0];
    out[1] = cb[1];
    out[2] = cb[2];
    return out;
  }
  scratch ??= [createPigment([0, 0, 0]), createPigment([0, 0, 0])];
  const [a, b] = scratch;
  setPigmentColor(a, cb[0], cb[1], cb[2], 1);
  setPigmentColor(b, cs[0], cs[1], cs[2], 1);
  lerpPigmentInto(a, b, t, out, 0);
  return out;
}

/** K/S of 8-bit colours (key `r << 16 | g << 8 | b`), shared by every 8-bit pigment composite. */
const pigmentCache = new Map<number, Pigment>();
/** About 3 MB of spectra; the cache starts over when it fills (a photo can hold millions of colours). */
const PIGMENT_CACHE_MAX = 16384;

function cachedPigment(r: number, g: number, b: number): Pigment {
  const key = (r << 16) | (g << 8) | b;
  let p = pigmentCache.get(key);
  if (!p) {
    if (pigmentCache.size >= PIGMENT_CACHE_MAX) pigmentCache.clear();
    p = createPigment([r / 255, g / 255, b / 255]);
    pigmentCache.set(key, p);
  }
  return p;
}

/**
 * {@link mixPigmentRgb} on 8-bit channels, with each colour's spectrum cached: writes the 0..1
 * result to `out[0..2]`. The compositor's and {@link blendImageData}'s per-pixel path.
 */
export function mixPigment8(b0: number, b1: number, b2: number, s0: number, s1: number, s2: number, t: number, out: number[]): void {
  if (t >= 1 || (b0 === s0 && b1 === s1 && b2 === s2)) {
    out[0] = s0 / 255;
    out[1] = s1 / 255;
    out[2] = s2 / 255;
    return;
  }
  lerpPigmentInto(cachedPigment(b0, b1, b2), cachedPigment(s0, s1, s2), t, out, 0);
}

/**
 * Composites a straight-alpha `source` over a straight-alpha `backdrop` (both RGBA in 0..1) with a
 * blend mode and an extra `alpha` (opacity), using the W3C general formula:
 * `αo = αs + αb(1 − αs)`, `αo·Co = (1 − αs)·αb·Cb + (1 − αb)·αs·Cs + αs·αb·B(Cb, Cs)`.
 *
 * `pigment` mixes the colours like paint instead, by amount: `Co = lerpPigment(Cb, Cs, αs / αo)`
 * (over an opaque backdrop that is `lerpPigment(Cb, Cs, αs)`), with the same `αo`.
 */
export function blendPixel(mode: BlendMode, backdrop: readonly number[], source: readonly number[], alpha = 1): Rgba {
  const ab = backdrop[3] ?? 1;
  const as = (source[3] ?? 1) * alpha;
  if (!(as > 0)) return [backdrop[0], backdrop[1], backdrop[2], ab];
  const ao = as + ab * (1 - as);
  if (ao <= 0) return [0, 0, 0, 0];
  const out: Rgba = [0, 0, 0, ao];
  if (mode === 'pigment') {
    mixPigmentRgb(backdrop, source, as / ao, out);
    return out;
  }
  const b = blendRgb(mode, backdrop, source);
  for (let i = 0; i < 3; i++) {
    out[i] = ((1 - as) * ab * backdrop[i] + (1 - ab) * as * source[i] + as * ab * b[i]) / ao;
  }
  return out;
}

/**
 * Blends `source` into `backdrop` in place (8-bit straight RGBA of the same size) with
 * {@link blendPixel}. The scalar fallback for modes the canvas cannot composite.
 */
export function blendImageData(backdrop: ImageData, source: ImageData, mode: BlendMode, alpha = 1): void {
  const d = backdrop.data;
  const s = source.data;
  const len = Math.min(d.length, s.length);
  const cb = [0, 0, 0, 0];
  const cs = [0, 0, 0, 0];
  const pigment = mode === 'pigment';
  for (let i = 0; i < len; i += 4) {
    if (s[i + 3] === 0) continue;
    if (pigment) {
      const as = (s[i + 3] / 255) * alpha;
      if (!(as > 0)) continue;
      const ao = as + (d[i + 3] / 255) * (1 - as);
      mixPigment8(d[i], d[i + 1], d[i + 2], s[i], s[i + 1], s[i + 2], as / ao, cb);
      d[i] = Math.round(cb[0] * 255);
      d[i + 1] = Math.round(cb[1] * 255);
      d[i + 2] = Math.round(cb[2] * 255);
      d[i + 3] = Math.round(ao * 255);
      continue;
    }
    for (let k = 0; k < 4; k++) {
      cb[k] = d[i + k] / 255;
      cs[k] = s[i + k] / 255;
    }
    const o = blendPixel(mode, cb, cs, alpha);
    d[i] = Math.round(o[0] * 255);
    d[i + 1] = Math.round(o[1] * 255);
    d[i + 2] = Math.round(o[2] * 255);
    d[i + 3] = Math.round(o[3] * 255);
  }
}
