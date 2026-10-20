// Portions ported from photocraft/crates/cms/src/math.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Small colour-science helpers: 3×3 matrices, CIE XYZ ↔ L*a*b*, chromatic adaptation. All from
 * public standards: CIE 15 (L*a*b*), ICC.1:2010 Annex A (PCS, D50) and the Bradford matrix
 * (Lam 1985).
 */

/** The ICC PCS illuminant (D50) as the header stores it: X 0.9642, Y 1, Z 0.8249. */
export const D50: readonly [number, number, number] = [0.9642, 1.0, 0.8249];

/** CIE D65 chromaticity (sRGB, Display P3, Adobe RGB). */
export const D65_XY: readonly [number, number] = [0.3127, 0.329];

/** Row-major 3×3 matrix. */
export type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];
export type Vec3 = [number, number, number];

export const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export function mul(a: Mat3, b: Mat3): Mat3 {
  const o: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  return o;
}

export function apply(m: Mat3, v: readonly number[]): Vec3 {
  return [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];
}

export function det(m: Mat3): number {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

/** Inverse, or `null` when (nearly) singular. */
export function invert(m: Mat3): Mat3 | null {
  const d = det(m);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null;
  const k = 1 / d;
  return [
    [(m[1][1] * m[2][2] - m[1][2] * m[2][1]) * k, (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * k, (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * k],
    [(m[1][2] * m[2][0] - m[1][0] * m[2][2]) * k, (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * k, (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * k],
    [(m[1][0] * m[2][1] - m[1][1] * m[2][0]) * k, (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * k, (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * k],
  ];
}

/** XYZ (Y = 1) of a chromaticity. */
export function xyToXyz(xy: readonly number[]): Vec3 {
  const [x, y] = xy;
  return [x / y, 1, (1 - x - y) / y];
}

const BRADFORD: Mat3 = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];

/** Bradford chromatic adaptation from white `src` to white `dst` (XYZ). */
export function bradford(src: readonly number[], dst: readonly number[]): Mat3 {
  const inv = invert(BRADFORD)!;
  const s = apply(BRADFORD, src);
  const d = apply(BRADFORD, dst);
  const scale: Mat3 = [
    [d[0] / s[0], 0, 0],
    [0, d[1] / s[1], 0],
    [0, 0, d[2] / s[2]],
  ];
  return mul(inv, mul(scale, BRADFORD));
}

/** RGB → XYZ matrix (relative to `white`) from primaries' chromaticities, or `null` when they are dependent. */
export function rgbToXyzMatrix(r: readonly number[], g: readonly number[], b: readonly number[], white: readonly number[]): Mat3 | null {
  const xr = xyToXyz(r);
  const xg = xyToXyz(g);
  const xb = xyToXyz(b);
  const m: Mat3 = [
    [xr[0], xg[0], xb[0]],
    [xr[1], xg[1], xb[1]],
    [xr[2], xg[2], xb[2]],
  ];
  const inv = invert(m);
  if (!inv) return null;
  const s = apply(inv, white);
  return [
    [m[0][0] * s[0], m[0][1] * s[1], m[0][2] * s[2]],
    [m[1][0] * s[0], m[1][1] * s[1], m[1][2] * s[2]],
    [m[2][0] * s[0], m[2][1] * s[1], m[2][2] * s[2]],
  ];
}

const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

const labF = (t: number) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
const labFinv = (f: number) => {
  const f3 = f * f * f;
  return f3 > EPS ? f3 : (116 * f - 16) / KAPPA;
};

/** CIE XYZ → L*a*b* relative to `white` (CIE 15). */
export function xyzToLab(xyz: readonly number[], white: readonly number[] = D50): Vec3 {
  const fx = labF(xyz[0] / white[0]);
  const fy = labF(xyz[1] / white[1]);
  const fz = labF(xyz[2] / white[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE L*a*b* → XYZ relative to `white`. */
export function labToXyz(lab: readonly number[], white: readonly number[] = D50): Vec3 {
  const fy = (lab[0] + 16) / 116;
  const fx = fy + lab[1] / 500;
  const fz = fy - lab[2] / 200;
  return [labFinv(fx) * white[0], labFinv(fy) * white[1], labFinv(fz) * white[2]];
}

/** CIE 1976 colour difference. */
export function deltaE76(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Rounds to ICC s15Fixed16 (what a profile can store). */
export const s15f16Round = (v: number) => Math.round(v * 65536) / 65536;

/** D50 exactly as an ICC header stores it. */
export const d50Quantized = (): Vec3 => [s15f16Round(D50[0]), s15f16Round(D50[1]), s15f16Round(D50[2])];
