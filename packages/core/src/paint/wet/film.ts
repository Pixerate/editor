/**
 * How wet-layer pigment looks, and how it bakes into 8-bit pixels.
 *
 * A cell carries pigment as Kubelka-Munk absorption `K` per channel (linear R, G, B) and one
 * scattering `S`, in mass units where `PIGMENT_UNIT` of a colour's pigment is a full-strength wash.
 * Over what is below it (`below`, linear), the film reflects
 *
 *     film = hide·R∞ + (1 − hide)·T·below,   T = e^(−2K), hide = 1 − e^(−HIDE·S),
 *     R∞ = 1 + K/S − √((K/S)² + 2·K/S)       (the shipped pigment model's two-flux formula)
 *
 * so transparent washes (S ≈ 0) multiply like glazes and opaque paint (gouache, oil) hides.
 *
 * The bake is a pure function of the f32 state and the 8-bit pixels, computed with deterministic
 * maths only (`dexp`, `dlog`, `sqrt`, + − × ÷ in f64; never `Math.exp` / `Math.pow`, whose last
 * bits differ between JavaScript engines), so "dry on save" gives the same pixels everywhere.
 * The layer pixel is the film expressed as colour plus alpha over the paper colour (exact over the
 * paper, a normal-blend approximation over other layers), with alpha never below the pixel's own.
 */

/** Pigment mass of a full-strength wash of a colour. */
export const PIGMENT_UNIT = 0.25;
/** Hiding per unit of scattering. */
export const HIDE = 1.5;
/** Scattering of fully opaque paint (`body` 1), per `PIGMENT_UNIT` of mass. */
export const BODY_SCATTER = 3;
/** Smallest reflectance a colour maps to (so black has finite K). */
const R_MIN = 1e-3;

// ---------------------------------------------------------------------------
// Deterministic maths
// ---------------------------------------------------------------------------

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const HI = LITTLE ? 1 : 0;
const LN2 = 0.6931471805599453;

/** 2^k for an integer k in −1022..1023, built from its bits. */
function pow2(k: number): number {
  u32[HI] = (k + 1023) << 20;
  u32[1 - HI] = 0;
  return f64[0];
}

/**
 * e^x with + − × ÷ only: x = k·ln2 + r with |r| ≤ ln2/2, then a degree-11 Taylor polynomial
 * (error below 1e-15). The same bits in every JavaScript engine.
 */
export function dexp(x: number): number {
  if (!(x > -700)) return x !== x ? x : 0;
  if (x > 700) return Infinity;
  const k = Math.round(x / LN2);
  const r = x - k * LN2;
  let p = 1 / 39916800;
  p = p * r + 1 / 3628800;
  p = p * r + 1 / 362880;
  p = p * r + 1 / 40320;
  p = p * r + 1 / 5040;
  p = p * r + 1 / 720;
  p = p * r + 1 / 120;
  p = p * r + 1 / 24;
  p = p * r + 1 / 6;
  p = p * r + 0.5;
  p = p * r + 1;
  p = p * r + 1;
  return p * pow2(k);
}

/** ln x for x > 0 with + − × ÷ only: x = m·2^e, ln m by the atanh series. */
export function dlog(x: number): number {
  if (!(x > 0)) return x === 0 ? -Infinity : NaN;
  f64[0] = x;
  let e = ((u32[HI] >>> 20) & 0x7ff) - 1023;
  if (e === -1023) {
    // subnormal: scale up first
    return dlog(x * 18014398509481984) - 54 * LN2;
  }
  u32[HI] = (u32[HI] & 0x800fffff) | (1023 << 20);
  let m = f64[0];
  if (m > 1.4142135623730951) {
    m /= 2;
    e += 1;
  }
  const s = (m - 1) / (m + 1);
  const s2 = s * s;
  let t = s2;
  let sum = 1;
  for (let i = 3; i < 40; i += 2) {
    sum += t / i;
    t *= s2;
  }
  return 2 * s * sum + e * LN2;
}

/** x^y for x ≥ 0, deterministically. */
export function dpow(x: number, y: number): number {
  if (x <= 0) return 0;
  return dexp(y * dlog(x));
}

// ---------------------------------------------------------------------------
// sRGB tables (built with the deterministic maths)
// ---------------------------------------------------------------------------

/** sRGB byte → linear. */
export const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  SRGB_TO_LINEAR[i] = v <= 0.04045 ? v / 12.92 : dpow((v + 0.055) / 1.055, 2.4);
}

/** sRGB value 0..255 (not necessarily whole) → linear, interpolating the byte table. */
export function srgbByteToLinear(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 255) return 1;
  const i = Math.floor(v);
  return SRGB_TO_LINEAR[i] + (SRGB_TO_LINEAR[i + 1] - SRGB_TO_LINEAR[i]) * (v - i);
}

/** Entries of the linear → sRGB byte table. */
const ENC_STEPS = 16384;
const ENCODE = new Uint8Array(ENC_STEPS + 1);
for (let i = 0; i <= ENC_STEPS; i++) {
  const v = i / ENC_STEPS;
  const e = v <= 0.0031308 ? 12.92 * v : 1.055 * dpow(v, 1 / 2.4) - 0.055;
  ENCODE[i] = Math.min(255, Math.max(0, Math.round(e * 255)));
}

/** Linear 0..1 → sRGB byte (16384-step table). */
export function linearToSrgb8(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 255;
  return ENCODE[Math.round(v * ENC_STEPS)];
}

// ---------------------------------------------------------------------------
// Colour ↔ pigment
// ---------------------------------------------------------------------------

/**
 * The pigment (K r, g, b, S per unit of mass) of an sRGB colour (0..1) at `body` 0 (a transparent
 * watercolour: K = −ln R / 2 so a full wash over white shows the colour) .. 1 (opaque paint:
 * `K/S = (1 − R)² / 2R` at `BODY_SCATTER`).
 */
export function pigmentOf(rgb: readonly [number, number, number] | readonly number[], body: number, out: Float64Array | number[] = new Float64Array(4)): Float64Array | number[] {
  const b = Math.min(1, Math.max(0, body));
  const s = (b * BODY_SCATTER) / PIGMENT_UNIT;
  for (let c = 0; c < 3; c++) {
    const v = Math.min(255, Math.max(0, Math.round(rgb[c] * 255)));
    const r = Math.max(R_MIN, SRGB_TO_LINEAR[v]);
    const kt = -dlog(r) / 2 / PIGMENT_UNIT;
    const ko = ((1 - r) * (1 - r)) / (2 * r) * s;
    out[c] = (1 - b) * kt + b * ko;
  }
  out[3] = s;
  return out;
}

/** e^(−x) for x ≥ 0 from a table (1/256 steps, linear interpolation; relative error below 3e-6). */
const EXP_RES = 256;
const EXP_MAX = 24;
const EXP_TABLE = new Float64Array(EXP_MAX * EXP_RES + 2);
for (let i = 0; i < EXP_TABLE.length; i++) EXP_TABLE[i] = dexp(-i / EXP_RES);

/** e^(−x) for x ≥ 0 (deterministic: a table built with `dexp`, interpolated with + − ×). */
export function expNeg(x: number): number {
  if (!(x > 0)) return 1;
  if (x >= EXP_MAX) return 0;
  const t = x * EXP_RES;
  const i = Math.floor(t);
  const fr = t - i;
  return EXP_TABLE[i] + (EXP_TABLE[i + 1] - EXP_TABLE[i]) * fr;
}

/** Linear reflectance of a film of pigment `k` (3) and `s` over `below` (linear) into `out`. */
export function filmReflectance(k0: number, k1: number, k2: number, s: number, b0: number, b1: number, b2: number, out: Float64Array | number[]): void {
  const hide = s > 0 ? 1 - expNeg(HIDE * s) : 0;
  const keep = 1 - hide;
  const inv = s > 1e-9 ? 1 / s : 0;
  out[0] = (hide > 0 ? hide * rinf(k0 * inv) : 0) + keep * expNeg(2 * k0) * b0;
  out[1] = (hide > 0 ? hide * rinf(k1 * inv) : 0) + keep * expNeg(2 * k1) * b1;
  out[2] = (hide > 0 ? hide * rinf(k2 * inv) : 0) + keep * expNeg(2 * k2) * b2;
}

/** Kubelka-Munk reflectance of an infinitely thick layer with absorption over scattering `ks`. */
function rinf(ks: number): number {
  return 1 + ks - Math.sqrt(ks * ks + 2 * ks);
}

/** The sRGB colour (0..1) of pigment `k`, `s` over white: what a brush picking it up sees. */
export function pigmentColor(k0: number, k1: number, k2: number, s: number, out: number[] = [0, 0, 0]): number[] {
  const lin = [0, 0, 0];
  filmReflectance(k0, k1, k2, s, 1, 1, 1, lin);
  for (let c = 0; c < 3; c++) out[c] = linearToSrgb8(lin[c]) / 255;
  return out;
}

const scratch = new Float64Array(3);

/**
 * Bakes one pixel: pigment `k0..k2`, `s` laid over layer pixel `px[i..i+3]` (straight sRGB) on paper
 * `paper` (sRGB bytes). `wet` (0..1) darkens wet paper slightly (display only; 0 for a bake).
 * Writes the new layer pixel into `out[o..o+3]`.
 */
export function filmPixel(
  k0: number,
  k1: number,
  k2: number,
  s: number,
  px: ArrayLike<number>,
  i: number,
  paper: ArrayLike<number>,
  wet: number,
  out: Uint8ClampedArray,
  o: number
): void {
  const pa = px[i + 3];
  if (!(k0 > 1e-7 || k1 > 1e-7 || k2 > 1e-7 || s > 1e-7) && wet <= 0) {
    out[o] = px[i];
    out[o + 1] = px[i + 1];
    out[o + 2] = px[i + 2];
    out[o + 3] = pa;
    return;
  }
  const a = pa / 255;
  const p0 = paper[0];
  const p1 = paper[1];
  const p2 = paper[2];
  // What is below the film: the pixel over the paper as the compositor blends it (encoded), then linear.
  const b0 = srgbByteToLinear(a * px[i] + (1 - a) * p0);
  const b1 = srgbByteToLinear(a * px[i + 1] + (1 - a) * p1);
  const b2 = srgbByteToLinear(a * px[i + 2] + (1 - a) * p2);
  filmReflectance(k0, k1, k2, s, b0, b1, b2, scratch);
  const dark = 1 - 0.07 * wet;
  // The film as an encoded colour, then as colour + alpha over the encoded paper colour.
  const e0 = linearToSrgb8(scratch[0] * dark);
  const e1 = linearToSrgb8(scratch[1] * dark);
  const e2 = linearToSrgb8(scratch[2] * dark);
  let alpha = a;
  alpha = needAlpha(e0, p0, alpha);
  alpha = needAlpha(e1, p1, alpha);
  alpha = needAlpha(e2, p2, alpha);
  if (alpha <= 0) {
    out[o] = px[i];
    out[o + 1] = px[i + 1];
    out[o + 2] = px[i + 2];
    out[o + 3] = 0;
    return;
  }
  const a8 = Math.max(Math.round(Math.min(1, alpha) * 255), pa);
  const al = a8 / 255;
  const inv = 1 / al;
  const k = 1 - al;
  out[o] = Math.round(Math.min(255, Math.max(0, (e0 - k * p0) * inv)));
  out[o + 1] = Math.round(Math.min(255, Math.max(0, (e1 - k * p1) * inv)));
  out[o + 2] = Math.round(Math.min(255, Math.max(0, (e2 - k * p2) * inv)));
  out[o + 3] = a8;
}

/** The alpha an encoded film value `e` needs over paper value `p` (bytes), at least `alpha`. */
function needAlpha(e: number, p: number, alpha: number): number {
  if (e < p) return Math.max(alpha, 1 - e / p);
  if (e > p) return Math.max(alpha, (e - p) / (255 - p));
  return alpha;
}

/**
 * The pigment a layer pixel holds over the paper, as a transparent film (`K = −ln(below/paper)/2`,
 * `S` 0): what re-wetting lifts back into the water. Writes K r, g, b, S into `out`.
 */
export function pixelPigment(px: ArrayLike<number>, i: number, paper: ArrayLike<number>, out: Float64Array | number[]): void {
  const a = px[i + 3] / 255;
  for (let c = 0; c < 3; c++) {
    const p = Math.max(R_MIN, SRGB_TO_LINEAR[paper[c]]);
    const below = Math.max(R_MIN, srgbByteToLinear(a * px[i + c] + (1 - a) * paper[c]));
    out[c] = below < p ? -dlog(below / p) / 2 : 0;
  }
  out[3] = 0;
}

/**
 * `filmPixel` over a whole tile, specialised for speed (same results, pixel for pixel). Reads the
 * slot's planes from `f`: settled pigment at `d` (4 planes, `plane` floats apart), suspended pigment
 * at `p` (or −1 to leave it out), surface and paper water at `rho` / `sw` (or −1: no wet darkening).
 * Cell (x, y) of the tile is at offset `(y + 1)·side + x + 1` of each plane. `src` is the base tile
 * (or `null` for transparent); writes `out` (a copy of `src` where nothing changes). Returns
 * whether any pixel was shaded.
 */
export function shadeTile(
  f: Float32Array,
  plane: number,
  side: number,
  d: number,
  p: number,
  rho: number,
  sw: number,
  src: Uint8ClampedArray | null,
  out: Uint8ClampedArray,
  w: number,
  h: number,
  paper: Uint8Array
): boolean {
  const p0 = paper[0];
  const p1 = paper[1];
  const p2 = paper[2];
  const lp0 = SRGB_TO_LINEAR[p0];
  const lp1 = SRGB_TO_LINEAR[p1];
  const lp2 = SRGB_TO_LINEAR[p2];
  const tab = EXP_TABLE;
  const enc = ENCODE;
  let any = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = (y + 1) * side + x + 1;
      let k0 = f[d + c];
      let k1 = f[d + plane + c];
      let k2 = f[d + 2 * plane + c];
      let s = f[d + 3 * plane + c];
      if (p >= 0) {
        k0 += f[p + c];
        k1 += f[p + plane + c];
        k2 += f[p + 2 * plane + c];
        s += f[p + 3 * plane + c];
      }
      let wet = 0;
      if (rho >= 0) {
        wet = f[rho + c] * 4 + f[sw + c];
        if (wet > 1) wet = 1;
      }
      if (!(k0 > 1e-7 || k1 > 1e-7 || k2 > 1e-7 || s > 1e-7) && wet <= 0) continue;
      any = true;
      const i = (y * 256 + x) * 4;
      const pa = src ? src[i + 3] : 0;
      const a = pa / 255;
      const na = 1 - a;
      const b0 = src ? srgbByteToLinear(a * src[i] + na * p0) : lp0;
      const b1 = src ? srgbByteToLinear(a * src[i + 1] + na * p1) : lp1;
      const b2 = src ? srgbByteToLinear(a * src[i + 2] + na * p2) : lp2;
      // filmReflectance, inlined
      let hide = 0;
      let x0: number;
      if (s > 0) {
        x0 = HIDE * s;
        hide = 1 - (x0 >= EXP_MAX ? 0 : interp(tab, x0 * EXP_RES));
      }
      const keep = 1 - hide;
      const inv = s > 1e-9 ? 1 / s : 0;
      let r0 = keep * expT(tab, 2 * k0) * b0;
      let r1 = keep * expT(tab, 2 * k1) * b1;
      let r2 = keep * expT(tab, 2 * k2) * b2;
      if (hide > 0) {
        r0 += hide * rinf(k0 * inv);
        r1 += hide * rinf(k1 * inv);
        r2 += hide * rinf(k2 * inv);
      }
      const dark = 1 - 0.07 * wet;
      const e0 = encode(enc, r0 * dark);
      const e1 = encode(enc, r1 * dark);
      const e2 = encode(enc, r2 * dark);
      let alpha = a;
      alpha = needAlpha(e0, p0, alpha);
      alpha = needAlpha(e1, p1, alpha);
      alpha = needAlpha(e2, p2, alpha);
      if (alpha <= 0) {
        out[i + 3] = 0;
        continue;
      }
      const a8 = Math.max(Math.round(Math.min(1, alpha) * 255), pa);
      const al = a8 / 255;
      const ia = 1 / al;
      const k = 1 - al;
      out[i] = Math.round(Math.min(255, Math.max(0, (e0 - k * p0) * ia)));
      out[i + 1] = Math.round(Math.min(255, Math.max(0, (e1 - k * p1) * ia)));
      out[i + 2] = Math.round(Math.min(255, Math.max(0, (e2 - k * p2) * ia)));
      out[i + 3] = a8;
    }
  }
  return any;
}

function interp(tab: Float64Array, t: number): number {
  const i = Math.floor(t);
  return tab[i] + (tab[i + 1] - tab[i]) * (t - i);
}

function expT(tab: Float64Array, x: number): number {
  if (!(x > 0)) return 1;
  if (x >= EXP_MAX) return 0;
  return interp(tab, x * EXP_RES);
}

function encode(enc: Uint8Array, v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 255;
  return enc[Math.round(v * ENC_STEPS)];
}
