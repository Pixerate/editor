// Portions ported from lightcraft-main/crates/color/src/cct.rs, lightcraft-main/crates/color/src/lib.rs,
// lightcraft-main/crates/pipeline/src/tone.rs, lightcraft-main/crates/pipeline/src/local.rs and
// lightcraft-main/crates/develop/src/settings.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors).
// See THIRD_PARTY_NOTICES.md.

/**
 * Colour science for the image editor's process 2 rendering: sRGB transfer functions,
 * correlated colour temperature / tint (Kim et al. Planckian locus, tint as Duv), Bradford
 * white-balance adaptation relative to "as shot", and the display-referred tone curve.
 */

/** A CIE 1931 chromaticity. */
export interface Chromaticity {
  x: number;
  y: number;
}

/** A row-major 3×3 matrix (`[m00, m01, m02, m10, …, m22]`). */
export type Matrix3 = [number, number, number, number, number, number, number, number, number];

// ---------------------------------------------------------------------------
// Process versions
// ---------------------------------------------------------------------------

/** The rendering of adjustments from before process versions existed. Frozen. */
export const LEGACY_PROCESS_VERSION = 1 as const;
/** The process new edits and Reset get. */
export const LATEST_PROCESS_VERSION = 2 as const;
export type ImageProcessVersion = 1 | 2;

/**
 * Reads a stored process number leniently: a missing or damaged value (not a whole number) is
 * the legacy process, so a saved edit from before process versions renders exactly as it did. A
 * whole number newer than this build knows renders with the latest process.
 */
export function normalizeProcessVersion(value: unknown): ImageProcessVersion {
  if (typeof value !== 'number' || !Number.isInteger(value)) return LEGACY_PROCESS_VERSION;
  return value >= LATEST_PROCESS_VERSION ? LATEST_PROCESS_VERSION : LEGACY_PROCESS_VERSION;
}

// ---------------------------------------------------------------------------
// sRGB transfer
// ---------------------------------------------------------------------------

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Rec.709 / sRGB luminance weights (linear light). */
export const LUMA_709: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

// ---------------------------------------------------------------------------
// 3×3 matrices
// ---------------------------------------------------------------------------

export const IDENTITY_MATRIX3: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mulMatrix3(a: Matrix3, b: Matrix3): Matrix3 {
  const out = new Array(9).fill(0) as Matrix3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

export function applyMatrix3(m: Matrix3, v: readonly [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function invertMatrix3(m: Matrix3): Matrix3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
  ];
}

function diag3(x: number, y: number, z: number): Matrix3 {
  return [x, 0, 0, 0, y, 0, 0, 0, z];
}

// ---------------------------------------------------------------------------
// Chromaticity, sRGB primaries, Bradford adaptation
// ---------------------------------------------------------------------------

export const D65: Chromaticity = { x: 0.3127, y: 0.329 };

function xyToXyz(p: Chromaticity): [number, number, number] {
  return [p.x / p.y, 1, (1 - p.x - p.y) / p.y];
}

function xyzToXy(v: readonly [number, number, number]): Chromaticity {
  const s = v[0] + v[1] + v[2];
  return s <= 0 ? { ...D65 } : { x: v[0] / s, y: v[1] / s };
}

/** Linear sRGB → XYZ (D65 white, Y = 1), derived from the primaries. */
const SRGB_TO_XYZ: Matrix3 = (() => {
  const p = [{ x: 0.64, y: 0.33 }, { x: 0.3, y: 0.6 }, { x: 0.15, y: 0.06 }].map(xyToXyz);
  const m: Matrix3 = [p[0][0], p[1][0], p[2][0], p[0][1], p[1][1], p[2][1], p[0][2], p[1][2], p[2][2]];
  const inv = invertMatrix3(m);
  const s = inv ? applyMatrix3(inv, xyToXyz(D65)) : [1, 1, 1];
  return mulMatrix3(m, diag3(s[0], s[1], s[2]));
})();
const XYZ_TO_SRGB: Matrix3 = invertMatrix3(SRGB_TO_XYZ) ?? IDENTITY_MATRIX3;

/** The Bradford cone-response matrix (XYZ → sharpened cones). */
const BRADFORD: Matrix3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const BRADFORD_INV: Matrix3 = invertMatrix3(BRADFORD) ?? IDENTITY_MATRIX3;

/** Bradford chromatic adaptation (XYZ → XYZ) from white `src` to white `dst`. */
export function bradfordAdaptation(src: Chromaticity, dst: Chromaticity): Matrix3 {
  if (src.x === dst.x && src.y === dst.y) return [...IDENTITY_MATRIX3];
  const s = applyMatrix3(BRADFORD, xyToXyz(src));
  const d = applyMatrix3(BRADFORD, xyToXyz(dst));
  return mulMatrix3(BRADFORD_INV, mulMatrix3(diag3(d[0] / s[0], d[1] / s[1], d[2] / s[2]), BRADFORD));
}

/**
 * Matrix (linear sRGB → linear sRGB) that white-balances a scene lit by `src` so that it
 * renders as if lit by D65.
 */
export function wbMatrix(src: Chromaticity): Matrix3 {
  return mulMatrix3(XYZ_TO_SRGB, mulMatrix3(bradfordAdaptation(src, D65), SRGB_TO_XYZ));
}

/** The chromaticity of a linear sRGB colour. */
export function linearSrgbToXy(rgb: readonly [number, number, number]): Chromaticity {
  return xyzToXy(applyMatrix3(SRGB_TO_XYZ, rgb));
}

// ---------------------------------------------------------------------------
// Correlated colour temperature and tint
// ---------------------------------------------------------------------------

/** Tint units per unit of Duv. */
export const TINT_SCALE = 3000;
export const MIN_KELVIN = 1667;
export const MAX_KELVIN = 25000;

function kimXy(tIn: number): Chromaticity {
  const t = Math.min(MAX_KELVIN, Math.max(MIN_KELVIN, tIn));
  const t2 = t * t;
  const t3 = t2 * t;
  const x =
    t <= 4000
      ? -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.24039;
  const x2 = x * x;
  const x3 = x2 * x;
  const y =
    t <= 2222
      ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
      : t <= 4000
        ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return { x, y };
}

/** CIE 1931 xy → CIE 1960 uv. */
export function xyToUv(p: Chromaticity): [number, number] {
  const d = -2 * p.x + 12 * p.y + 3;
  return [(4 * p.x) / d, (6 * p.y) / d];
}

/** CIE 1960 uv → CIE 1931 xy. */
export function uvToXy(u: number, v: number): Chromaticity {
  const d = 2 * u - 8 * v + 4;
  return { x: (3 * u) / d, y: (2 * v) / d };
}

/** Planckian locus in (u, v), extended linearly in mired space outside the approximation's range. */
function locusUv(tIn: number): [number, number] {
  const t = Math.max(1000, tIn);
  if (t >= MIN_KELVIN && t <= MAX_KELVIN) return xyToUv(kimXy(t));
  const [a, b] = t < MIN_KELVIN ? [MIN_KELVIN, MIN_KELVIN + 50] : [MAX_KELVIN - 500, MAX_KELVIN];
  const [ua, va] = xyToUv(kimXy(a));
  const [ub, vb] = xyToUv(kimXy(b));
  const ma = 1e6 / a;
  const mb = 1e6 / b;
  const s = (1e6 / t - ma) / (mb - ma);
  return [ua + (ub - ua) * s, va + (vb - va) * s];
}

/** Unit normal of the locus at `t`, pointing towards green (increasing v). */
function locusNormal(t: number): [number, number] {
  const m = 1e6 / t;
  const [u0, v0] = locusUv(1e6 / (m + 1));
  const [u1, v1] = locusUv(1e6 / Math.max(m - 1, 1));
  const du = u1 - u0;
  const dv = v1 - v0;
  const l = Math.max(Math.hypot(du, dv), 1e-12);
  const nx = -dv / l;
  const ny = du / l;
  return ny < 0 ? [-nx, -ny] : [nx, ny];
}

/**
 * Source illuminant chromaticity for temperature `kelvin` and correction `tint`.
 * Positive tint means a green source white, whose correction adds magenta to the image.
 */
export function tempTintToXy(kelvin: number, tint: number): Chromaticity {
  const [u, v] = locusUv(kelvin);
  const [nu, nv] = locusNormal(kelvin);
  const duv = tint / TINT_SCALE;
  return uvToXy(u + nu * duv, v + nv * duv);
}

/** Inverse of {@link tempTintToXy}: nearest locus temperature (searched in mired space) and tint. */
export function xyToTempTint(p: Chromaticity): { kelvin: number; tint: number } {
  const [u, v] = xyToUv(p);
  const dist = (m: number) => {
    const [lu, lv] = locusUv(1e6 / m);
    return (u - lu) ** 2 + (v - lv) ** 2;
  };
  // Coarse scan, then golden-section refine over mired 20..1000 (50000 K .. 1000 K).
  let best = 20;
  let bd = Infinity;
  for (let m = 20; m <= 1000; m += 5) {
    const d = dist(m);
    if (d < bd) {
      bd = d;
      best = m;
    }
  }
  let a = Math.max(best - 5, 20);
  let b = Math.min(best + 5, 1000);
  const g = 0.61803398875;
  for (let i = 0; i < 60; i++) {
    const c = b - g * (b - a);
    const d = a + g * (b - a);
    if (dist(c) < dist(d)) b = d;
    else a = c;
  }
  const kelvin = 1e6 / ((a + b) / 2);
  const [lu, lv] = locusUv(kelvin);
  const [nu, nv] = locusNormal(kelvin);
  const duv = (u - lu) * nu + (v - lv) * nv;
  return { kelvin, tint: duv * TINT_SCALE };
}

// ---------------------------------------------------------------------------
// Relative white balance for rendered (JPEG / PNG / WebP) sources
// ---------------------------------------------------------------------------

/** Rendered images carry no as-shot white: "as shot" is 6500 K / tint 0 and maps to the identity. */
export const AS_SHOT_KELVIN = 6500;
/** Mireds per unit of the `temperature` slider (−100…100). */
export const MIRED_PER_TEMPERATURE_UNIT = 1;
const AS_SHOT_MIRED = 1e6 / AS_SHOT_KELVIN;

/**
 * Maps the `temperature` slider (−100 cool … +100 warm) to the Kelvin white-balance setting:
 * one mired per unit around 6500 K, so 0 → 6500 K, +100 → ~18 570 K (a strong warming
 * correction), −100 → ~3 940 K (a strong cooling correction). Mireds are perceptually even,
 * so equal slider steps look like equal changes.
 */
export function temperatureToKelvin(temperature: number): number {
  return 1e6 / (AS_SHOT_MIRED - temperature * MIRED_PER_TEMPERATURE_UNIT);
}

/** Inverse of {@link temperatureToKelvin}. */
export function kelvinToTemperature(kelvin: number): number {
  return (AS_SHOT_MIRED - 1e6 / kelvin) / MIRED_PER_TEMPERATURE_UNIT;
}

const AS_SHOT_WB_INV: Matrix3 = invertMatrix3(wbMatrix(tempTintToXy(AS_SHOT_KELVIN, 0))) ?? IDENTITY_MATRIX3;

/**
 * White-balance matrix (linear sRGB) for the `temperature` / `tint` sliders, relative to
 * "as shot": the identity at 0 / 0. Normalised so neutral luminance is preserved (white
 * balance doesn't change exposure).
 */
export function whiteBalanceMatrix(temperature: number, tint = 0): Matrix3 {
  if (!temperature && !tint) return [...IDENTITY_MATRIX3];
  const set = wbMatrix(tempTintToXy(temperatureToKelvin(temperature), tint));
  const m = mulMatrix3(set, AS_SHOT_WB_INV);
  const g = applyMatrix3(m, [1, 1, 1]);
  const y = g[0] * LUMA_709[0] + g[1] * LUMA_709[1] + g[2] * LUMA_709[2];
  return mulMatrix3(m, diag3(1 / y, 1 / y, 1 / y));
}

/**
 * Neutral-point eyedropper: the `temperature` / `tint` that render the sampled sRGB colour
 * (0–255 per channel, as it appears in the unadjusted image) neutral. Results are clamped to
 * the slider range −100…100.
 */
export function whiteBalanceFromSample(
  rgb: readonly [number, number, number] | { r: number; g: number; b: number }
): { temperature: number; tint: number } {
  const [r, g, b] = Array.isArray(rgb) ? rgb : [(rgb as any).r, (rgb as any).g, (rgb as any).b];
  const lin: [number, number, number] = [r, g, b].map((c) => srgbToLinear(Math.min(255, Math.max(0, c)) / 255)) as [
    number,
    number,
    number,
  ];
  if (lin[0] + lin[1] + lin[2] <= 1e-6) return { temperature: 0, tint: 0 };
  // Under relative WB the matrix is wb(set) · wb(asShot)⁻¹, so the sample is neutral when the
  // chosen source white is the chromaticity of wb(asShot)⁻¹ · sample.
  const src = linearSrgbToXy(applyMatrix3(AS_SHOT_WB_INV, lin));
  const { kelvin, tint } = xyToTempTint(src);
  const clamp = (v: number) => Math.max(-100, Math.min(100, v));
  return { temperature: clamp(kelvinToTemperature(kelvin)), tint: clamp(tint) };
}

// ---------------------------------------------------------------------------
// Tone curve (display-referred, identity at neutral)
// ---------------------------------------------------------------------------

/** Number of intervals in a tone LUT (the table has `TONE_LUT_SIZE + 1` entries). */
export const TONE_LUT_SIZE = 4096;
const GREY = 0.18;
const GREY_P = Math.pow(GREY, 1 / 2.2);
/** Linear value where the highlight shoulder starts when there is headroom above 1. */
const SHOULDER_KNEE = 0.6;

/**
 * The process 2 tone curve for one linear input value in `[0, headroom]`:
 *
 * 1. A highlight shoulder (extended Reinhard with white point `headroom`) above a knee of 0.6
 *    rolls values above 1 (after exposure / white balance) back into range instead of clipping.
 *    With no headroom (`headroom = 1`) it is exactly the identity.
 * 2. In a gamma-2.2 perceptual domain, contrast is an S-curve anchored at 0, middle grey and 1
 *    (as `ToneMap::display`), and brightness a midtone lift anchored at 0 and 1.
 *
 * `contrast` and `brightness` are −100…100; both 0 with `headroom = 1` is the identity.
 */
export function toneCurve(y: number, contrast: number, brightness: number, headroom = 1): number {
  if (!(y > 0)) return 0;
  const h = Math.max(1, headroom);
  let o = Math.min(y, h);
  if (h > 1 && o > SHOULDER_KNEE) {
    const span = 1 - SHOULDER_KNEE;
    const x = (o - SHOULDER_KNEE) / span;
    const X = (h - SHOULDER_KNEE) / span;
    o = SHOULDER_KNEE + span * ((x * (1 + x / (X * X))) / (1 + x));
  }
  if (contrast === 0 && brightness === 0) return Math.min(1, o);
  let p = Math.pow(Math.min(1, o), 1 / 2.2);
  const c = contrast / 100;
  if (c !== 0) {
    p += c * 0.4 * (p - GREY_P) * (1 - (2 * p - 1) ** 2);
  }
  const b = brightness / 100;
  if (b !== 0) {
    // Smooth midtone lift that leaves black and white in place (slope stays positive).
    p += b * 0.8 * p * (1 - p);
  }
  return Math.pow(Math.min(1, Math.max(0, p)), 2.2);
}

/** Tabulates {@link toneCurve} over `[0, headroom]` in {@link TONE_LUT_SIZE} steps. */
export function buildToneLut(contrast: number, brightness: number, headroom = 1): Float32Array {
  const h = Math.max(1, headroom);
  const lut = new Float32Array(TONE_LUT_SIZE + 1);
  for (let i = 0; i <= TONE_LUT_SIZE; i++) {
    lut[i] = toneCurve((h * i) / TONE_LUT_SIZE, contrast, brightness, h);
  }
  return lut;
}

/** Linearly interpolated lookup into a LUT from {@link buildToneLut}. */
export function sampleToneLut(lut: Float32Array, headroom: number, y: number): number {
  if (!(y > 0)) return lut[0];
  const n = lut.length - 1;
  const f = (y * n) / Math.max(1, headroom);
  if (f >= n) return lut[n];
  const i = f | 0;
  return lut[i] + (lut[i + 1] - lut[i]) * (f - i);
}
