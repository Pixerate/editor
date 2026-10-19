// Portions ported from photocraft-main/crates/color/src/blend.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Photoshop blend modes on straight (non-premultiplied) 0..1 colours.
 *
 * Formulas follow the W3C Compositing / ISO 32000 definitions, with Photoshop's variants where
 * they differ (Soft Light, Vivid / Linear / Pin Light, Hard Mix, Linear Burn / Dodge, Subtract,
 * Divide, Darker / Lighter Color), and the hardened `ClipColor` for the non-separable modes.
 */

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
  | 'luminosity';

export interface BlendModeInfo {
  id: BlendMode;
  label: string;
  /** Canvas `globalCompositeOperation` with the same maths, when there is one. */
  canvas: GlobalCompositeOperation | null;
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
];

const BLEND_INFO = new Map<string, BlendModeInfo>(BLEND_MODES.map((m) => [m.id, m]));

export function isBlendMode(value: unknown): value is BlendMode {
  return typeof value === 'string' && BLEND_INFO.has(value);
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

/** Whether a mode works on whole colours (hue, saturation, colour, luminosity, darker / lighter colour). */
export function isSeparableBlendMode(mode: BlendMode): boolean {
  return !(
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

/** `B(Cb, Cs)` of a whole colour, including the non-separable modes. */
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
    default:
      return [blendChannel(mode, cb[0], cs[0]), blendChannel(mode, cb[1], cs[1]), blendChannel(mode, cb[2], cs[2])];
  }
}

/**
 * Composites a straight-alpha `source` over a straight-alpha `backdrop` (both RGBA in 0..1) with a
 * blend mode and an extra `alpha` (opacity), using the W3C general formula:
 * `αo = αs + αb(1 − αs)`, `αo·Co = (1 − αs)·αb·Cb + (1 − αb)·αs·Cs + αs·αb·B(Cb, Cs)`.
 */
export function blendPixel(mode: BlendMode, backdrop: readonly number[], source: readonly number[], alpha = 1): Rgba {
  const ab = backdrop[3] ?? 1;
  const as = (source[3] ?? 1) * alpha;
  if (!(as > 0)) return [backdrop[0], backdrop[1], backdrop[2], ab];
  const b = blendRgb(mode, backdrop, source);
  const ao = as + ab * (1 - as);
  if (ao <= 0) return [0, 0, 0, 0];
  const out: Rgba = [0, 0, 0, ao];
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
  for (let i = 0; i < len; i += 4) {
    if (s[i + 3] === 0) continue;
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
