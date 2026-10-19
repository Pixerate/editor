/**
 * Pigment-like colour mixing: blue and yellow make green, red and white make pink, as paint does.
 *
 * Each sRGB colour is lifted to a smooth reflectance spectrum, the spectra are mixed with the
 * Kubelka-Munk two-flux model, and the mixed spectrum is turned back into sRGB. Written from the
 * published literature; no third-party code or data:
 *
 * 1. **Spectral uplift.** A colour's reflectance is a sigmoid of a quadratic in wavelength,
 *    `R(λ) = s(c₀λ² + c₁λ + c₂)` with `s(z) = ½ + z / 2√(1 + z²)` (Jakob & Hanika, "A
 *    Low-Dimensional Function Space for Efficient Spectral Upsampling", Eurographics 2019). The
 *    three coefficients are solved per colour with Newton's method so the spectrum reproduces the
 *    colour. Spectra are precomputed lazily on a 17³ lattice over sRGB and interpolated
 *    trilinearly in *linear* RGB: colour is linear in reflectance, so an interpolated spectrum
 *    still reproduces its colour exactly while staying smooth and inside 0..1.
 * 2. **Mixing.** Each spectrum becomes `K/S = (1 − R)² / 2R` per band. Colours mix with the
 *    two-constant form `K/S = Σ cᵢSᵢ(K/S)ᵢ / Σ cᵢSᵢ`, where `cᵢ` is the weight times the colour's
 *    tinting strength and `Sᵢ` its scattering, taken from its luminance (light paints such as
 *    titanium white scatter strongly, dark ones barely). Back to reflectance with
 *    `R = 1 + K/S − √((K/S)² + 2·K/S)`.
 * 3. **Back to sRGB.** The spectrum is weighted by the CIE 1931 2° colour-matching functions
 *    (the analytic multi-lobe fit of Wyman, Sloan & Shirley, JCGT 2013) under a 6504 K Planckian
 *    illuminant, converted to linear sRGB and normalised so a perfect white reflector is exactly
 *    white. Analytic curves keep the CIE's own (CC BY-SA) tables out of the package.
 *
 * Everything is plain TypeScript on typed arrays with no DOM: it runs in Node and Workers and is
 * deterministic. Colours are straight sRGB triples in 0..1, as in `@pixerate/editor/raster`.
 */

/** An sRGB colour, each channel 0..1 (gamma-encoded, as in CSS). */
export type PigmentRgb = readonly [number, number, number];

/** Number of spectral bands. */
export const PIGMENT_BANDS = 36;
/** First band's wavelength in nm; bands are 10 nm apart (380..730 nm). */
export const PIGMENT_LAMBDA_MIN = 380;
export const PIGMENT_LAMBDA_STEP = 10;

/** Band centre wavelengths in nm. */
export const PIGMENT_WAVELENGTHS: Float32Array = Float32Array.from({ length: PIGMENT_BANDS }, (_, i) => PIGMENT_LAMBDA_MIN + i * PIGMENT_LAMBDA_STEP);

const N = PIGMENT_BANDS;
/** Lattice nodes per axis of the spectrum table. */
const LUT_NODES = 17;
/** Reflectance floor for K/S, so a black's K/S stays finite (≈ 5000). */
const R_MIN = 1e-4;
/** Scattering floor, so a black still counts in a mix. */
const SCATTER_MIN = 0.01;

// ---------------------------------------------------------------------------
// sRGB
// ---------------------------------------------------------------------------

function toLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function toEncoded(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 1;
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

// ---------------------------------------------------------------------------
// Reflectance → linear sRGB weights
// ---------------------------------------------------------------------------

/** Asymmetric Gaussian lobe of the Wyman et al. fit. */
function lobe(l: number, mu: number, s1: number, s2: number): number {
  const t = (l - mu) / (l < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}

/** Relative spectral power of a black body (Planck's law; the constant factor cancels). */
function planck(nm: number, kelvin: number): number {
  const m = nm * 1e-9;
  return 1 / (m ** 5 * (Math.exp(1.438776877e-2 / (m * kelvin)) - 1));
}

let weights: Float64Array | null = null;

/**
 * Row-major 3 × N matrix taking a reflectance spectrum to linear sRGB. Each row sums to 1, so a
 * flat reflectance `r` gives the grey `(r, r, r)`.
 */
function rgbWeights(): Float64Array {
  if (weights) return weights;
  const w = new Float64Array(3 * N);
  // XYZ (D65 white) → linear sRGB, IEC 61966-2-1.
  const m = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252];
  for (let b = 0; b < N; b++) {
    const l = PIGMENT_LAMBDA_MIN + b * PIGMENT_LAMBDA_STEP;
    const e = planck(l, 6504);
    const x = e * (1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2));
    const y = e * (0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1));
    const z = e * (1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8));
    for (let c = 0; c < 3; c++) w[c * N + b] = m[c * 3] * x + m[c * 3 + 1] * y + m[c * 3 + 2] * z;
  }
  for (let c = 0; c < 3; c++) {
    let sum = 0;
    for (let b = 0; b < N; b++) sum += w[c * N + b];
    for (let b = 0; b < N; b++) w[c * N + b] /= sum;
  }
  return (weights = w);
}

// ---------------------------------------------------------------------------
// Sigmoid-polynomial uplift
// ---------------------------------------------------------------------------

/**
 * Solves the sigmoid-polynomial coefficients whose spectrum has the linear sRGB colour
 * `(r, g, b)`, starting from `coeffs` (updated in place). Wavelength is normalised to 0..1 over
 * the bands. Damped Newton: a step is halved until the residual drops.
 */
function fitCoefficients(r: number, g: number, b: number, coeffs: Float64Array): number {
  const w = rgbWeights();
  const target = [r, g, b];
  const res = new Float64Array(3);
  const jac = new Float64Array(9);
  const trial = new Float64Array(3);
  let err = residual(coeffs, target, w, res, jac);
  for (let it = 0; it < 60 && err > 1e-10; it++) {
    const step = solve3(jac, res);
    if (!step) break;
    let scale = 1;
    let next = Infinity;
    for (let k = 0; k < 12; k++) {
      for (let i = 0; i < 3; i++) trial[i] = coeffs[i] - scale * step[i];
      next = residual(trial, target, w, null, null);
      if (next < err) break;
      scale *= 0.5;
    }
    if (!(next < err)) break;
    coeffs.set(trial);
    err = residual(coeffs, target, w, res, jac);
  }
  return err;
}

/** Squared colour error of a coefficient set; fills the residual and Jacobian when asked. */
function residual(c: Float64Array, target: number[], w: Float64Array, res: Float64Array | null, jac: Float64Array | null): number {
  let r0 = -target[0];
  let r1 = -target[1];
  let r2 = -target[2];
  if (jac) jac.fill(0);
  for (let b = 0; b < N; b++) {
    const x = b / (N - 1);
    const z = (c[0] * x + c[1]) * x + c[2];
    const q = 1 + z * z;
    const sq = Math.sqrt(q);
    const s = 0.5 + z / (2 * sq);
    r0 += w[b] * s;
    r1 += w[N + b] * s;
    r2 += w[2 * N + b] * s;
    if (jac) {
      const ds = 1 / (2 * q * sq);
      for (let k = 0; k < 3; k++) {
        const wd = w[k * N + b] * ds;
        jac[k * 3] += wd * x * x;
        jac[k * 3 + 1] += wd * x;
        jac[k * 3 + 2] += wd;
      }
    }
  }
  if (res) {
    res[0] = r0;
    res[1] = r1;
    res[2] = r2;
  }
  return r0 * r0 + r1 * r1 + r2 * r2;
}

/** Solves the 3 × 3 system `a·x = v` (Cramer's rule), or null when singular. */
function solve3(a: Float64Array, v: Float64Array): number[] | null {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a;
  const c0 = a4 * a8 - a5 * a7;
  const c1 = a5 * a6 - a3 * a8;
  const c2 = a3 * a7 - a4 * a6;
  const det = a0 * c0 + a1 * c1 + a2 * c2;
  if (!(Math.abs(det) > 1e-300)) return null;
  const [v0, v1, v2] = v;
  return [
    (v0 * c0 + a1 * (a5 * v2 - v1 * a8) + a2 * (v1 * a7 - a4 * v2)) / det,
    (a0 * (v1 * a8 - a5 * v2) + v0 * c1 + a2 * (a3 * v2 - v1 * a6)) / det,
    (a0 * (a4 * v2 - v1 * a7) + a1 * (v1 * a6 - a3 * v2) + v0 * c2) / det,
  ];
}

const candidate = new Float64Array(3);

/**
 * Fits a lattice node, starting from `coeffs` (its neighbour's solution). Where that stalls, as it
 * can next to very saturated or very dark nodes, it also tries a flat grey start and a dimming
 * continuation (solve the colour brighter, then dim it in small steps, each starting from the last,
 * as Jakob & Hanika do along their brightness axis), and keeps the closest fit.
 */
function fitNode(r: number, g: number, b: number, coeffs: Float64Array): void {
  let best = fitCoefficients(r, g, b, coeffs);
  if (best <= 1e-12) return;
  candidate.fill(0);
  let err = fitCoefficients(r, g, b, candidate);
  if (err < best) {
    best = err;
    coeffs.set(candidate);
  }
  if (best <= 1e-12) return;
  const max = Math.max(r, g, b);
  if (!(max > 0) || max >= 0.5) return;
  candidate.fill(0);
  const steps = 32;
  for (let i = 0; i <= steps; i++) {
    const scale = (0.5 * Math.pow(max / 0.5, i / steps)) / max;
    err = fitCoefficients(r * scale, g * scale, b * scale, candidate);
  }
  if (err < best) coeffs.set(candidate);
}

function sigmoidSpectrum(c: Float64Array, out: Float32Array, offset: number): void {
  for (let b = 0; b < N; b++) {
    const x = b / (N - 1);
    const z = (c[0] * x + c[1]) * x + c[2];
    out[offset + b] = 0.5 + z / (2 * Math.sqrt(1 + z * z));
  }
}

// ---------------------------------------------------------------------------
// Spectrum table
// ---------------------------------------------------------------------------

/** Linear value of each lattice node: evenly spaced in encoded sRGB, so darks get more nodes. */
const NODES: Float64Array = Float64Array.from({ length: LUT_NODES }, (_, i) => toLinear(i / (LUT_NODES - 1)));
let table: Float32Array | null = null;

/**
 * The spectrum of every lattice node, `[(r·n + g)·n + b]·N`, solved on first use (a few tens of
 * milliseconds). Each node starts from its neighbour's solution, so Newton converges in a few
 * steps.
 */
function spectrumTable(): Float32Array {
  if (table) return table;
  const n = LUT_NODES;
  const t = new Float32Array(n * n * n * N);
  const row = new Float64Array(3);
  const coeffs = new Float64Array(3);
  for (let r = 0; r < n; r++) {
    for (let g = 0; g < n; g++) {
      // Warm start each row from the first node of the previous row.
      coeffs.set(row);
      for (let b = 0; b < n; b++) {
        fitNode(NODES[r], NODES[g], NODES[b], coeffs);
        if (b === 0) row.set(coeffs);
        sigmoidSpectrum(coeffs, t, ((r * n + g) * n + b) * N);
      }
    }
  }
  return (table = t);
}

/** Lattice cell, fraction and linear value per channel from the last `locate` calls. */
const cell = new Int32Array(3);
const frac = new Float64Array(3);
const linear = new Float64Array(3);

/** Finds an encoded channel's lattice cell; the fraction is linear in linear RGB. */
function locate(channel: number, encoded: number): void {
  const v = clamp01(encoded);
  const i = Math.min(LUT_NODES - 2, Math.floor(v * (LUT_NODES - 1)));
  const lo = NODES[i];
  const lin = toLinear(v);
  const f = (lin - lo) / (NODES[i + 1] - lo);
  cell[channel] = i;
  frac[channel] = f < 0 ? 0 : f > 1 ? 1 : f;
  linear[channel] = lin;
}

/**
 * The smooth reflectance spectrum (0..1 per band, `PIGMENT_BANDS` bands from 380 nm in 10 nm
 * steps) of an sRGB colour. `reflectanceToRgb` of the result gives the colour back.
 */
export function rgbToReflectance(r: number, g: number, b: number, out: Float32Array = new Float32Array(N)): Float32Array {
  const t = spectrumTable();
  const n = LUT_NODES;
  locate(0, r);
  locate(1, g);
  locate(2, b);
  const [ri, gi, bi] = cell;
  const [rf, gf, bf] = frac;
  out.fill(0);
  for (let corner = 0; corner < 8; corner++) {
    const dr = corner >> 2;
    const dg = (corner >> 1) & 1;
    const db = corner & 1;
    const weight = (dr ? rf : 1 - rf) * (dg ? gf : 1 - gf) * (db ? bf : 1 - bf);
    if (weight === 0) continue;
    const base = (((ri + dr) * n + gi + dg) * n + bi + db) * N;
    for (let k = 0; k < N; k++) out[k] += weight * t[base + k];
  }
  return out;
}

/** The sRGB colour (0..1, clipped to the gamut) of a reflectance spectrum. */
export function reflectanceToRgb(reflectance: ArrayLike<number>, out: number[] = [0, 0, 0]): number[] {
  const w = rgbWeights();
  let r = 0;
  let g = 0;
  let b = 0;
  for (let k = 0; k < N; k++) {
    const v = reflectance[k];
    r += w[k] * v;
    g += w[N + k] * v;
    b += w[2 * N + k] * v;
  }
  out[0] = toEncoded(r);
  out[1] = toEncoded(g);
  out[2] = toEncoded(b);
  return out;
}

// ---------------------------------------------------------------------------
// Pigments and mixing
// ---------------------------------------------------------------------------

/**
 * A colour prepared for mixing: its K/S spectrum and its weight in a mix. Make one per brush or
 * palette colour with `createPigment` and reuse it (`setPigmentColor`) on hot paths.
 */
export interface Pigment {
  /** The sRGB colour it was made from (0..1). */
  readonly rgb: [number, number, number];
  /** Tinting strength (default 1): how strongly it colours a mix, relative to its weight. */
  strength: number;
  /** K/S per band. */
  readonly ks: Float32Array;
  /** Scattering from the colour's luminance (floored), before strength. */
  scatter: number;
}

export interface PigmentOptions {
  /**
   * Tinting strength, > 0 (default 1). A strength of 4 counts each part as four, so a little of
   * a strong dark pigment tints a lot of white. A colour mixed only with itself is unchanged
   * whatever its strength.
   */
  strength?: number;
}

const spectrumScratch = new Float32Array(N);

/** Prepares a colour for mixing. */
export function createPigment(color: PigmentRgb, options: PigmentOptions = {}): Pigment {
  const pigment: Pigment = { rgb: [0, 0, 0], strength: 1, ks: new Float32Array(N), scatter: 1 };
  return setPigmentColor(pigment, color[0], color[1], color[2], options.strength);
}

/** Re-targets a pigment to another colour without allocating (the per-pixel fast path). */
export function setPigmentColor(pigment: Pigment, r: number, g: number, b: number, strength = pigment.strength): Pigment {
  const R = rgbToReflectance(r, g, b, spectrumScratch);
  const ks = pigment.ks;
  for (let k = 0; k < N; k++) {
    const v = R[k] > R_MIN ? R[k] : R_MIN;
    ks[k] = ((1 - v) * (1 - v)) / (2 * v);
  }
  pigment.rgb[0] = clamp01(r);
  pigment.rgb[1] = clamp01(g);
  pigment.rgb[2] = clamp01(b);
  pigment.strength = Number.isFinite(strength) && strength > 0 ? strength : 1;
  // `rgbToReflectance` left each channel's linear value in `linear`.
  const y = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  pigment.scatter = y > SCATTER_MIN ? y : SCATTER_MIN;
  return pigment;
}

/** Mixed K/S → reflectance → sRGB, written to `out[offset..offset + 2]`. */
function ksToRgb(ks: Float32Array | Float64Array, out: { [i: number]: number }, offset: number): void {
  const w = rgbWeights();
  let r = 0;
  let g = 0;
  let b = 0;
  for (let k = 0; k < N; k++) {
    const q = ks[k];
    const v = 1 + q - Math.sqrt(q * q + 2 * q);
    r += w[k] * v;
    g += w[N + k] * v;
    b += w[2 * N + k] * v;
  }
  out[offset] = toEncoded(r);
  out[offset + 1] = toEncoded(g);
  out[offset + 2] = toEncoded(b);
}

const mixScratch = new Float64Array(N);

/**
 * Mixes colours like paint. `weights` are parts by amount (any non-negative scale; at least one
 * positive). Colours may be sRGB triples (0..1) or prepared pigments (which carry a tinting
 * strength). Returns the mixed sRGB colour (0..1).
 */
export function mixPigments(colors: readonly (PigmentRgb | Pigment)[], weights: readonly number[]): [number, number, number] {
  if (colors.length === 0) throw new Error('mixPigments needs at least one colour.');
  if (weights.length !== colors.length) throw new Error(`mixPigments got ${colors.length} colours but ${weights.length} weights; pass one weight per colour.`);
  const pigments = colors.map((c) => ('ks' in c ? c : createPigment(c)));
  let total = 0;
  for (let i = 0; i < pigments.length; i++) {
    const w = weights[i];
    if (!(Number.isFinite(w) && w >= 0)) throw new Error(`Weight ${i} is ${w}; weights must be finite and ≥ 0.`);
    total += w * pigments[i].strength * pigments[i].scatter;
  }
  if (!(total > 0)) throw new Error('mixPigments needs at least one positive weight.');
  mixScratch.fill(0);
  for (let i = 0; i < pigments.length; i++) {
    const p = pigments[i];
    const c = (weights[i] * p.strength * p.scatter) / total;
    if (c === 0) continue;
    for (let k = 0; k < N; k++) mixScratch[k] += c * p.ks[k];
  }
  const out: [number, number, number] = [0, 0, 0];
  ksToRgb(mixScratch, out, 0);
  return out;
}

/** Mixes `a` towards `b` like paint: `t = 0` is `a`, `t = 1` is `b`. */
export function lerpPigment(a: PigmentRgb | Pigment, b: PigmentRgb | Pigment, t: number): [number, number, number] {
  const u = clamp01(t);
  return mixPigments([a, b], [1 - u, u]);
}

/**
 * The per-dab fast path: mixes two prepared pigments (`t` of `b` into `a`) and writes the sRGB
 * result to `out[offset..offset + 2]`, without allocating. Pair it with `setPigmentColor` for the
 * colour under the brush.
 */
export function lerpPigmentInto(a: Pigment, b: Pigment, t: number, out: { [i: number]: number }, offset = 0): void {
  const u = t > 0 ? (t < 1 ? t : 1) : 0;
  const wa = (1 - u) * a.strength * a.scatter;
  const wb = u * b.strength * b.scatter;
  const ca = wa / (wa + wb);
  const cb = 1 - ca;
  const ka = a.ks;
  const kb = b.ks;
  for (let k = 0; k < N; k++) mixScratch[k] = ca * ka[k] + cb * kb[k];
  ksToRgb(mixScratch, out, offset);
}
