/**
 * Perspective (projective) maps between quadrilaterals: Free Distort and Perspective in both the
 * vector and the image editor. Pure maths; degenerate or non-finite input gives `null` instead of
 * NaNs.
 *
 * Ported from ArtCraft (MIT OR Apache-2.0, © ArtCraft Team and contributors; see
 * THIRD_PARTY_NOTICES.md): pdfcraft `crates/geom/src/perspective.rs` (`Homography::from_points`,
 * `Homography::apply`, `solve8`, `order_quad`) and photocraft `crates/algo/src/transform.rs`
 * (`Homography::square_to_quad`, `rect_to_quad`, `inverse`, `mul`, `local_scale`, `front_side`,
 * `warp_output_bounds`, `convex_quad`).
 */
import type { AffineMatrix, Box, Homography, Quad, Vec2 } from './types';

export type { Homography };

export const IDENTITY_HOMOGRAPHY: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Gaussian elimination with partial pivoting on an 8×8 system (the 9th column of each row is the
 * right-hand side). Null when the system is singular.
 */
export function solve8(rows: readonly (readonly number[])[]): number[] | null {
  const m = rows.map((r) => r.slice());
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (!(Math.abs(m[pivot][col]) >= 1e-12)) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const p = m[col];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = m[r][col] / p[col];
      if (f !== 0) for (let k = 0; k < 9; k++) m[r][k] -= f * p[k];
    }
  }
  const out: number[] = [];
  for (let i = 0; i < 8; i++) {
    const v = m[i][8] / m[i][i];
    if (!Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

/** The image of `p`, or null where the map sends it to infinity. */
export function applyHomography(h: Homography, p: Vec2): Vec2 | null {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return null;
  const x = (h[0] * p.x + h[1] * p.y + h[2]) / w;
  const y = (h[3] * p.x + h[4] * p.y + h[5]) / w;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** The homogeneous `w` of `p`: its sign is the side of the horizon `p` maps to (0 on it). */
export function homographyW(h: Homography, p: Vec2): number {
  return h[6] * p.x + h[7] * p.y + h[8];
}

const finite = (p: Vec2) => Number.isFinite(p.x) && Number.isFinite(p.y);

/**
 * The projective map that takes each of `from` to the point at the same index of `to`. Null when
 * three of either set are collinear or a coordinate is not finite.
 */
export function homographyFromPoints(from: readonly Vec2[], to: readonly Vec2[]): Homography | null {
  if (from.length !== 4 || to.length !== 4 || ![...from, ...to].every(finite)) return null;
  // x' = (h0 x + h1 y + h2) / (h6 x + h7 y + 1), y' likewise with h3..h5: eight unknowns, two
  // equations per point pair.
  const rows: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const h = solve8(rows);
  if (!h) return null;
  const out: Homography = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  // Collinear points can leave a solvable but singular system: check the map really takes the
  // four points where they should go.
  for (let i = 0; i < 4; i++) {
    const r = applyHomography(out, from[i]);
    const q = to[i];
    const scale = 1 + Math.max(Math.abs(q.x), Math.abs(q.y));
    if (!r || Math.abs(r.x - q.x) > 1e-6 * scale || Math.abs(r.y - q.y) > 1e-6 * scale) return null;
  }
  return out;
}

/**
 * Whether `h` maps the whole convex quad `quad` without sending any of it through infinity (the
 * denominator keeps one sign over it): what a usable distortion needs.
 */
export function homographyKeepsQuad(h: Homography, quad: readonly Vec2[]): boolean {
  const ws = quad.map((p) => h[6] * p.x + h[7] * p.y + h[8]);
  return ws.every((w) => w > 1e-9) || ws.every((w) => w < -1e-9);
}

/**
 * The four corners in reading order for a y-down space: top-left, top-right, bottom-right,
 * bottom-left, whatever order they come in. Null unless they form a convex quadrilateral with a
 * non-negligible area.
 */
export function orderQuad(points: readonly Vec2[]): Vec2[] | null {
  if (points.length !== 4 || !points.every(finite)) return null;
  const cx = points.reduce((s, p) => s + p.x, 0) / 4;
  const cy = points.reduce((s, p) => s + p.y, 0) / 4;
  // Ascending angle about the centre is clockwise on screen (y down).
  const q = points.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let first = 0;
  for (let i = 1; i < 4; i++) if (q[i].x + q[i].y < q[first].x + q[first].y) first = i;
  const ordered = [...q.slice(first), ...q.slice(0, first)];
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const turns = ordered.map((_, i) => cross(ordered[i], ordered[(i + 1) % 4], ordered[(i + 2) % 4]));
  const area = turns.reduce((s, t) => s + t, 0) / 2;
  const xs = ordered.map((p) => p.x);
  const ys = ordered.map((p) => p.y);
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const convex = turns.every((t) => t > 1e-9 * size * size);
  return convex && area > 1e-6 * size * size ? ordered : null;
}

/** `a` then `b` (apply `a` first). */
export function multiplyHomographies(a: Homography, b: Homography): Homography {
  // Row-major column-vector maps: (b ∘ a) = B · A.
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = b[i * 3] * a[j] + b[i * 3 + 1] * a[3 + j] + b[i * 3 + 2] * a[6 + j];
  return r as unknown as Homography;
}

/** The inverse map, or null for a singular one. */
export function invertHomography(m: Homography): Homography | null {
  const c = [
    m[4] * m[8] - m[5] * m[7],
    m[2] * m[7] - m[1] * m[8],
    m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8],
    m[0] * m[8] - m[2] * m[6],
    m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6],
    m[1] * m[6] - m[0] * m[7],
    m[0] * m[4] - m[1] * m[3],
  ];
  const det = m[0] * c[0] + m[1] * c[3] + m[2] * c[6];
  if (!(Math.abs(det) >= 1e-12) || !Number.isFinite(det)) return null;
  return c.map((v) => v / det) as unknown as Homography;
}

/** An affine matrix (SVG order) as a homography. */
export function homographyFromAffine(m: AffineMatrix): Homography {
  return [m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1];
}

/** The affine matrix of `h` when it is affine (no perspective part), else null. */
export function affineFromHomography(h: Homography, eps = 1e-12): AffineMatrix | null {
  if (Math.abs(h[6]) > eps * Math.abs(h[8]) || Math.abs(h[7]) > eps * Math.abs(h[8]) || !h[8]) return null;
  const w = h[8];
  return [h[0] / w, h[3] / w, h[1] / w, h[4] / w, h[2] / w, h[5] / w];
}

export function isIdentityHomography(h: Homography, eps = 1e-9): boolean {
  const w = h[8];
  if (Math.abs(w) < 1e-12) return false;
  const id = IDENTITY_HOMOGRAPHY;
  for (let i = 0; i < 8; i++) if (Math.abs(h[i] / w - id[i]) > eps) return false;
  return true;
}

/** Unit square → quad (corners (0,0), (1,0), (1,1), (0,1) to TL, TR, BR, BL); null when degenerate. */
function squareToQuad(q: readonly Vec2[]): Homography | null {
  const [p0, p1, p2, p3] = q;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) {
    return [p1.x - p0.x, p3.x - p0.x, p0.x, p1.y - p0.y, p3.y - p0.y, p0.y, 0, 0, 1];
  }
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-12) return null;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y, g, h, 1];
}

/**
 * The map taking box `r`'s corners onto `quad` (TL, TR, BR, BL), exact for parallelograms (then
 * affine). Null for an empty box, a non-finite or degenerate quad, or a singular result.
 */
export function rectToQuad(r: Box, quad: readonly Vec2[]): Homography | null {
  if (!(r.width > 0 && r.height > 0) || quad.length !== 4 || !quad.every(finite)) return null;
  const toUnit: Homography = [1 / r.width, 0, -r.x / r.width, 0, 1 / r.height, -r.y / r.height, 0, 0, 1];
  const sq = squareToQuad(quad);
  if (!sq) return null;
  const h = multiplyHomographies(toUnit, sq);
  return invertHomography(h) ? h : null;
}

/** Box `r`'s corners as a quad (TL, TR, BR, BL). */
export function boxQuad(r: Box): Quad {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
}

/** Approximate linear scale of the map near `p` (square root of the Jacobian determinant). */
export function homographyLocalScale(h: Homography, p: Vec2): number {
  const e = 0.5;
  const a = applyHomography(h, { x: p.x - e, y: p.y });
  const b = applyHomography(h, { x: p.x + e, y: p.y });
  const c = applyHomography(h, { x: p.x, y: p.y - e });
  const d = applyHomography(h, { x: p.x, y: p.y + e });
  if (!a || !b || !c || !d) return 0;
  const jx = { x: b.x - a.x, y: b.y - a.y };
  const jy = { x: d.x - c.x, y: d.y - c.y };
  return Math.sqrt(Math.abs(jx.x * jy.y - jx.y * jy.x));
}

/**
 * The side of the horizon (+1 or −1) most of box `r`'s corners map to (the centre's on a tie). A
 * Distort dragged past the horizon maps the rest of the source to the far side, where it would
 * show as a mirrored copy wrapped round infinity; resampling keeps to this side, as Photoshop does.
 */
export function homographyFrontSide(h: Homography, r: Box): 1 | -1 {
  const ahead = boxQuad(r).filter((p) => homographyW(h, p) > 0).length;
  if (ahead >= 3) return 1;
  if (ahead <= 1) return -1;
  return homographyW(h, { x: r.x + r.width / 2, y: r.y + r.height / 2 }) >= 0 ? 1 : -1;
}

/** Most pixels a side of a warped result may span (±2²⁰), as photocraft clamps. */
const OUTPUT_LIMIT = 1 << 20;

/**
 * The integer box a warp of box `r` through `h` fills: the warped corners plus a pixel for filter
 * support, each side clamped to ±2²⁰. Null when a corner maps to infinity or `h` is singular.
 */
export function warpOutputBounds(r: Box, h: Homography): Box | null {
  if (!(r.width > 0 && r.height > 0) || !invertHomography(h)) return null;
  const corners = boxQuad(r).map((p) => applyHomography(h, p));
  if (corners.some((c) => !c)) return null;
  return cornerBounds(corners as Vec2[]);
}

/** The integer box around `corners`, grown by a pixel and clamped to ±2²⁰. */
export function cornerBounds(corners: readonly Vec2[]): Box {
  const lim = OUTPUT_LIMIT;
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x0 = Math.floor(Math.max(-lim, Math.min(...xs))) - 1;
  const y0 = Math.floor(Math.max(-lim, Math.min(...ys))) - 1;
  const x1 = Math.ceil(Math.min(lim, Math.max(...xs))) + 1;
  const y1 = Math.ceil(Math.min(lim, Math.max(...ys))) + 1;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Whether `q` (TL, TR, BR, BL) is strictly convex with every corner turn above ~0.06°, wound
 * clockwise on screen (y down), finite and at least 1 px² in area.
 */
export function isConvexQuad(q: readonly Vec2[]): boolean {
  if (q.length !== 4 || !q.every(finite)) return false;
  let area2 = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const e1 = { x: b.x - a.x, y: b.y - a.y };
    const e2 = { x: c.x - b.x, y: c.y - b.y };
    const cross = e1.x * e2.y - e1.y * e2.x;
    if (!(cross > 1e-3 * Math.hypot(e1.x, e1.y) * Math.hypot(e2.x, e2.y))) return false;
    area2 += a.x * b.y - b.x * a.y;
  }
  return Number.isFinite(area2) && area2 >= 2;
}
