/**
 * Affine matrices in SVG order (`[a, b, c, d, e, f]`), shared by the vector and image editors.
 * Angles are degrees, clockwise on screen (y points down).
 */
import type { AffineMatrix, Vec2 } from './types';

export type { AffineMatrix };

export const IDENTITY_MATRIX: AffineMatrix = [1, 0, 0, 1, 0, 0];

/** `a` then `b` (apply `a` first). */
export function multiplyMatrices(a: AffineMatrix, b: AffineMatrix): AffineMatrix {
  const [a0, a1, a2, a3, a4, a5] = a;
  const [b0, b1, b2, b3, b4, b5] = b;
  return [b0 * a0 + b2 * a1, b1 * a0 + b3 * a1, b0 * a2 + b2 * a3, b1 * a2 + b3 * a3, b0 * a4 + b2 * a5 + b4, b1 * a4 + b3 * a5 + b5];
}

export const translateMatrix = (dx: number, dy: number): AffineMatrix => [1, 0, 0, 1, dx, dy];

export function scaleMatrix(sx: number, sy: number, origin: Vec2 = { x: 0, y: 0 }): AffineMatrix {
  return [sx, 0, 0, sy, origin.x - sx * origin.x, origin.y - sy * origin.y];
}

/** Rotation by `degrees` clockwise (y points down) around `origin`. */
export function rotateMatrix(degrees: number, origin: Vec2 = { x: 0, y: 0 }): AffineMatrix {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [cos, sin, -sin, cos, origin.x - cos * origin.x + sin * origin.y, origin.y - sin * origin.x - cos * origin.y];
}

/** `m` applied about `origin` instead of the coordinate origin. */
export function matrixAbout(m: AffineMatrix, origin: Vec2): AffineMatrix {
  return multiplyMatrices(multiplyMatrices(translateMatrix(-origin.x, -origin.y), m), translateMatrix(origin.x, origin.y));
}

/**
 * A skew by `ax` degrees horizontally (vertical lines lean right for positive angles:
 * x' = x + tan(ax)·y) and `ay` degrees vertically (y' = y + tan(ay)·x), about `origin`.
 */
export function skewMatrix(ax: number, ay: number, origin: Vec2 = { x: 0, y: 0 }): AffineMatrix {
  const tx = Math.tan((ax * Math.PI) / 180);
  const ty = Math.tan((ay * Math.PI) / 180);
  return matrixAbout([1, ty, tx, 1, 0, 0], origin);
}

export function applyMatrix(m: AffineMatrix, p: Vec2): Vec2 {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function isIdentityMatrix(m: AffineMatrix, eps = 1e-12): boolean {
  return Math.abs(m[0] - 1) < eps && Math.abs(m[1]) < eps && Math.abs(m[2]) < eps && Math.abs(m[3] - 1) < eps && Math.abs(m[4]) < eps && Math.abs(m[5]) < eps;
}

/** The inverse matrix (the identity for a singular one). */
export function invertMatrix(m: AffineMatrix): AffineMatrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!det || !Number.isFinite(det)) return IDENTITY_MATRIX;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** Applies only the linear part (for directions and offsets). */
export function applyMatrixLinear(m: AffineMatrix, v: Vec2): Vec2 {
  return { x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y };
}

/**
 * The rotation of a matrix in degrees, clockwise (y down), in (−180, 180]. For a mirrored
 * matrix it is the rotation left after undoing a horizontal flip, so a flipped rotated shape
 * keeps its angle.
 */
export function matrixRotation(m: AffineMatrix): number {
  const [a, b, c, d] = m;
  const mirrored = a * d - b * c < 0;
  const deg = ((mirrored ? Math.atan2(-b - c, d - a) : Math.atan2(b - c, a + d)) * 180) / Math.PI;
  return Math.abs(deg) < 1e-9 ? 0 : deg;
}

/**
 * Splits `m` into `residual` then `rigid` (`m = residual × rigid` in apply order): `rigid` is
 * the nearest rotation plus the translation, `residual` the linear rest (scale, skew,
 * reflection). An unrotated `m` gives an identity `rigid` and everything in `residual`.
 */
export function decomposeRigid(m: AffineMatrix): { rigid: AffineMatrix; residual: AffineMatrix } {
  const [a, b, c, d, e, f] = m;
  const deg = matrixRotation(m);
  if (deg === 0) return { rigid: IDENTITY_MATRIX, residual: m };
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return {
    rigid: [cos, sin, -sin, cos, e, f],
    residual: [cos * a + sin * b, -sin * a + cos * b, cos * c + sin * d, -sin * c + cos * d, 0, 0],
  };
}
