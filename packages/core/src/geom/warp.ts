/**
 * Warp geometry shared by the vector editor's envelopes and the image editor's Free Transform
 * warp: preset warp styles and editable Bézier meshes, both forward maps from a source box onto
 * the plane.
 *
 * - **Presets** (`WarpStyle`, Photoshop's fifteen with bend and horizontal / vertical distortion
 *   in percent): each is one bicubic Bézier patch whose 4 × 4 control grid follows the bend
 *   (`warpPresetGrid`). Every preset is the identity at bend 0 and continuous in it.
 * - **Meshes** (`WarpMesh`): a grid of bicubic patches. Splitting a mesh (`splitWarpMeshU` / `V`)
 *   is an exact de Casteljau subdivision, so it never changes the shape, and a preset turns into
 *   an editable mesh of any size exactly.
 *
 * Ported from ArtCraft (MIT OR Apache-2.0, © ArtCraft Team and contributors; see
 * THIRD_PARTY_NOTICES.md): photocraft `crates/geom/src/warp.rs` (`WarpStyle`, `StyleWarp`,
 * `rest_grid`, `edge_arc`, `arc_grid`, `blend_rows`, `preset_grid`, `bernstein`, `split_cubic`,
 * `BERN_INV`, and `BezierMesh`: `identity`, `fit`, `eval`, `split_u`, `split_v`, `remove_split_u`,
 * `transpose`, `map_points`, `param_at`, `pull`, `smooth_lines`, `drag_point`, `control_bounds`;
 * `Warp::map` and `Warp::to_mesh`).
 */
import type { Box, Vec2, WarpMesh, WarpStyle } from './types';

export type { WarpMesh, WarpStyle };

type P = [number, number];
/** A single patch's control grid, `[row][column]`, in box units (0–1, y down). */
type Grid = P[][];

/** The fifteen presets in Photoshop's menu order. */
export const WARP_STYLES: readonly WarpStyle[] = [
  'arc',
  'arcLower',
  'arcUpper',
  'arch',
  'bulge',
  'shellLower',
  'shellUpper',
  'flag',
  'wave',
  'fish',
  'rise',
  'fisheye',
  'inflate',
  'squeeze',
  'twist'
];

export const WARP_STYLE_LABELS: Readonly<Record<WarpStyle, string>> = {
  arc: 'Arc',
  arcLower: 'Arc Lower',
  arcUpper: 'Arc Upper',
  arch: 'Arch',
  bulge: 'Bulge',
  shellLower: 'Shell Lower',
  shellUpper: 'Shell Upper',
  flag: 'Flag',
  wave: 'Wave',
  fish: 'Fish',
  rise: 'Rise',
  fisheye: 'Fisheye',
  inflate: 'Inflate',
  squeeze: 'Squeeze',
  twist: 'Twist'
};

/** The rest grid (no warp). */
function restGrid(): Grid {
  return [0, 1, 2, 3].map((j) => [0, 1, 2, 3].map((i): P => [i / 3, j / 3]));
}

/**
 * A horizontal edge at height `y` (box units, 0–1 across) bent into a circular arc of `|b|·π`
 * that keeps its chord, bowing up when `up === (b > 0)`. `h` is the box's height over its width,
 * so the arc is circular in pixels.
 */
function edgeArc(y: number, b: number, up: boolean, h: number): P[] {
  if (Math.abs(b) < 1e-9) return [0, 1, 2, 3].map((i): P => [i / 3, y]);
  const th = Math.abs(b) * Math.PI;
  const k = (((4 / 3) * Math.tan(th / 4)) * 0.5) / Math.sin(th / 2);
  const s = b > 0 === up ? -1 : 1;
  const c = Math.cos(th / 2);
  const n = Math.sin(th / 2);
  const dy = (s * k * n) / h;
  return [
    [0, y],
    [k * c, y + dy],
    [1 - k * c, y + dy],
    [1, y]
  ];
}

/**
 * Arc: every row is a circular arc of `|b|·π` around one centre; the edge on the inside of the
 * bend keeps its chord and the rows' radii grow by the box height towards the other edge. Worked
 * in units of the box width (`h` = height / width) so the arcs are circular in pixels.
 */
function arcGrid(b: number, h: number): Grid {
  if (Math.abs(b) < 1e-9) return restGrid();
  const up = b > 0;
  const th = Math.abs(b) * Math.PI;
  const r = 0.5 / Math.sin(th / 2);
  const k = (4 / 3) * Math.tan(th / 4);
  const s = up ? -1 : 1;
  const cy = up ? h + r * Math.cos(th / 2) : -r * Math.cos(th / 2);
  return [0, 1, 2, 3].map((j) => {
    const v = j / 3;
    const big = r + h * (up ? 1 - v : v);
    const at = (a: number): P => [0.5 + big * Math.sin(a), cy + s * big * Math.cos(a)];
    const tangent = (a: number): P => [Math.cos(a), -s * Math.sin(a)];
    const p0 = at(-th / 2);
    const p3 = at(th / 2);
    const t0 = tangent(-th / 2);
    const t1 = tangent(th / 2);
    const l = k * big;
    const pts: P[] = [p0, [p0[0] + l * t0[0], p0[1] + l * t0[1]], [p3[0] - l * t1[0], p3[1] - l * t1[1]], p3];
    return pts.map((p): P => [p[0], p[1] / h]);
  });
}

/** Rows blended from `top` to `bottom`. */
function blendRows(top: P[], bottom: P[]): Grid {
  return [0, 1, 2, 3].map((j) => {
    const t = j / 3;
    return [0, 1, 2, 3].map((i): P => [top[i][0] + (bottom[i][0] - top[i][0]) * t, top[i][1] + (bottom[i][1] - top[i][1]) * t]);
  });
}

const INNER: [number, number, number, number][] = [
  [1, 1, -1, -1],
  [1, 2, 1, -1],
  [2, 1, -1, 1],
  [2, 2, 1, 1]
];

/**
 * A preset as a Bézier control grid (rows of `[x, y]` in box units, y down). `b`, `hd`, `vd` are
 * the bend and the horizontal / vertical distortion as fractions (−1…1); `aspect` is the box's
 * height over its width. The arc family stays circular in pixels, the other offsets scale with the
 * box, and a vertical warp is the horizontal one with the axes (and distortions) swapped.
 */
export function warpPresetGrid(style: WarpStyle, b: number, hd: number, vd: number, vertical: boolean, aspect: number): [number, number][][] {
  // Height over width of the box the bend runs along (the transposed box when vertical); in that
  // frame the two distortions trade places too.
  const h = vertical ? 1 / aspect : aspect;
  if (vertical) [hd, vd] = [vd, hd];
  let g = restGrid();
  switch (style) {
    case 'arc':
      g = arcGrid(b, h);
      break;
    case 'arch':
      g = [0, 1, 2, 3].map((j) => edgeArc(j / 3, b, true, h));
      break;
    case 'bulge':
      g = blendRows(edgeArc(0, b, true, h), edgeArc(1, b, false, h));
      break;
    case 'arcLower':
      g = blendRows(g[0], edgeArc(1, b, false, h));
      break;
    case 'arcUpper':
      g = blendRows(edgeArc(0, b, true, h), g[3]);
      break;
    // The bulging edge and the outer points of the row next to it come from Arc (bent the other
    // way for Shell Lower); the rest stays put.
    case 'shellLower': {
      const a = arcGrid(-b, h);
      g[3] = a[3];
      g[2][0] = a[2][0];
      g[2][3] = a[2][3];
      break;
    }
    case 'shellUpper': {
      const a = arcGrid(b, h);
      g[0] = a[0];
      g[1][0] = a[1][0];
      g[1][3] = a[1][3];
      break;
    }
    case 'flag':
      for (const row of g) {
        row[1][1] -= 2 * b;
        row[2][1] += 2 * b;
      }
      break;
    case 'wave':
      for (const row of g.slice(1, 3)) {
        row[1][1] += (4 / 3) * b;
        row[2][1] -= (4 / 3) * b;
      }
      break;
    case 'fish':
      [-2, -2 / 3, 2 / 3, 2].forEach((f, j) => {
        g[j][1][1] += f * b;
        g[j][2][1] -= f * b;
      });
      break;
    case 'rise':
      for (const row of g) {
        row[0][1] += 2 * b;
        row[1][1] += 2 * b;
      }
      break;
    case 'fisheye':
      for (const [j, i, dx, dy] of INNER) {
        g[j][i][0] += (dx * 2 * b) / 3;
        g[j][i][1] += (dy * 2 * b) / 3;
      }
      break;
    // Edge midpoints move out (Inflate) or the sides in (Squeeze) by b/3, the inner points by b/9.
    case 'inflate':
    case 'squeeze': {
      const s = style === 'inflate' ? 1 : -1;
      for (const p of g[0].slice(1, 3)) p[1] -= b / 3;
      for (const p of g[3].slice(1, 3)) p[1] += b / 3;
      for (const row of g.slice(1, 3)) {
        row[0][0] -= (s * b) / 3;
        row[3][0] += (s * b) / 3;
      }
      for (const [j, i, dx, dy] of INNER) {
        g[j][i][0] += (s * dx * b) / 9;
        g[j][i][1] += (dy * b) / 9;
      }
      break;
    }
    // The inner points turn round the centre (the other way for a negative bend).
    case 'twist': {
      const a = Math.abs(b);
      if (b >= 0) {
        g[1][1][0] += a;
        g[1][2][1] += a;
        g[2][1][1] -= a;
        g[2][2][0] -= a;
      } else {
        g[1][1][1] += a;
        g[1][2][0] -= a;
        g[2][1][0] += a;
        g[2][2][1] -= a;
      }
      break;
    }
  }
  // Vertical distortion: the top and bottom rows scale about their end points' midpoint (by
  // 1 ∓ vd) and the middle rows follow by the blend of those two moves.
  if (vd !== 0) {
    const moved = (row: P[], s: number): P[] => {
      const m: P = [(row[0][0] + row[3][0]) / 2, (row[0][1] + row[3][1]) / 2];
      return row.map((p): P => [m[0] + (p[0] - m[0]) * s - p[0], m[1] + (p[1] - m[1]) * s - p[1]]);
    };
    const d0 = moved(g[0], 1 - vd);
    const d3 = moved(g[3], 1 + vd);
    g.forEach((row, j) => {
      const t = j / 3;
      row.forEach((p, i) => {
        p[0] += d0[i][0] + (d3[i][0] - d0[i][0]) * t;
        p[1] += d0[i][1] + (d3[i][1] - d0[i][1]) * t;
      });
    });
  }
  // Horizontal distortion: each column scales about its end points' midpoint by 1 + hd·(2i/3 − 1).
  if (hd !== 0) {
    for (let i = 0; i < 4; i++) {
      const s = 1 + hd * ((2 * i) / 3 - 1);
      const m: P = [(g[0][i][0] + g[3][i][0]) / 2, (g[0][i][1] + g[3][i][1]) / 2];
      for (const row of g) row[i] = [m[0] + (row[i][0] - m[0]) * s, m[1] + (row[i][1] - m[1]) * s];
    }
  }
  // Vertical orientation: the same grid with the axes swapped.
  if (vertical) g = [0, 1, 2, 3].map((j) => [0, 1, 2, 3].map((i): P => [g[i][j][1], g[i][j][0]]));
  return g;
}

function bernstein(t: number): [number, number, number, number] {
  const s = 1 - t;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
}

export const lerpVec2 = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** De Casteljau split of a cubic at `t`: 7 points (left 0..3, right 3..6). */
function splitCubic(p: readonly Vec2[], t: number): Vec2[] {
  const a = lerpVec2(p[0], p[1], t);
  const b = lerpVec2(p[1], p[2], t);
  const c = lerpVec2(p[2], p[3], t);
  const d = lerpVec2(a, b, t);
  const e = lerpVec2(b, c, t);
  return [p[0], a, d, lerpVec2(d, e, t), e, c, p[3]];
}

/** Inverse of the Bernstein interpolation matrix at t = 0, ⅓, ⅔, 1 (rows: control point, columns: sample). */
const BERN_INV = [
  [1, 0, 0, 0],
  [-5 / 6, 3, -1.5, 1 / 3],
  [1 / 3, -1.5, 3, -5 / 6],
  [0, 0, 0, 1]
];

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/** A preset warp's settings (bend and distortions in percent, −100…100). */
export interface WarpPreset {
  style: WarpStyle;
  bend: number;
  horizontal?: number;
  vertical?: number;
  /** Bend along the vertical axis. */
  orientation?: 'horizontal' | 'vertical';
}

const pct = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(-1, v / 100)) : 0);

/**
 * A preset as one Bézier patch over `bounds` (points in the bounds' space), or null when it
 * changes nothing (an unknown style, all-zero amounts, or an empty box).
 */
export function warpPresetMesh(preset: WarpPreset, bounds: Box): WarpMesh | null {
  if (!WARP_STYLES.includes(preset.style)) return null;
  const { x, y, width: w, height: h } = bounds;
  if (!(w > 0 && h > 0)) return null;
  const b = pct(preset.bend);
  const hd = pct(preset.horizontal);
  const vd = pct(preset.vertical);
  if (b === 0 && hd === 0 && vd === 0) return null;
  const grid = warpPresetGrid(preset.style, b, hd, vd, preset.orientation === 'vertical', h / w);
  return { us: [0, 1], vs: [0, 1], points: grid.flat().map((p) => ({ x: x + p[0] * w, y: y + p[1] * h })) };
}

// ---------------------------------------------------------------------------
// Meshes
// ---------------------------------------------------------------------------

/** Control points per row. */
export const warpMeshColumns = (m: WarpMesh) => 3 * (m.us.length - 1) + 1;
/** Control point rows. */
export const warpMeshRows = (m: WarpMesh) => 3 * (m.vs.length - 1) + 1;

/** Whether a mesh is well formed: knots from 0 to 1 increasing, the right number of finite points. */
export function isValidWarpMesh(m: unknown): m is WarpMesh {
  if (!m || typeof m !== 'object') return false;
  const { us, vs, points } = m as WarpMesh;
  const knots = (k: unknown): k is number[] =>
    Array.isArray(k) && k.length >= 2 && k.length <= 65 && k[0] === 0 && k[k.length - 1] === 1 && k.every((v, i) => typeof v === 'number' && (i === 0 || v > k[i - 1]));
  if (!knots(us) || !knots(vs) || !Array.isArray(points)) return false;
  return points.length === (3 * (us.length - 1) + 1) * (3 * (vs.length - 1) + 1) && points.every((p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y));
}

/** Fits a mesh with patch boundaries `us` / `vs` to the map `f` (box fractions → output) by interpolating it at each patch's thirds. Exact for bicubic maps (affine maps included). */
export function fitWarpMesh(f: (s: number, t: number) => Vec2, us: readonly number[], vs: readonly number[]): WarpMesh {
  const pc = us.length - 1;
  const pr = vs.length - 1;
  const nx = 3 * pc + 1;
  const points: Vec2[] = new Array((3 * pr + 1) * nx);
  for (let pj = 0; pj < pr; pj++) {
    for (let pi = 0; pi < pc; pi++) {
      const s: Vec2[][] = [0, 1, 2, 3].map((j) =>
        [0, 1, 2, 3].map((i) => f(us[pi] + ((us[pi + 1] - us[pi]) * i) / 3, vs[pj] + ((vs[pj + 1] - vs[pj]) * j) / 3))
      );
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          let x = 0;
          let y = 0;
          for (let a = 0; a < 4; a++) {
            for (let b = 0; b < 4; b++) {
              const k = BERN_INV[j][a] * BERN_INV[i][b];
              x += k * s[a][b].x;
              y += k * s[a][b].y;
            }
          }
          points[(3 * pj + j) * nx + 3 * pi + i] = { x, y };
        }
      }
    }
  }
  return { us: us.slice(), vs: vs.slice(), points };
}

/** `n + 1` evenly spaced knots from 0 to 1. */
export const evenKnots = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);
/** A patch count rounded and clamped to 1–64. */
export const clampMeshCount = (n: number) => Math.min(64, Math.max(1, Math.round(Number.isFinite(n) ? n : 1)));

/** The identity mesh over `bounds` with `columns × rows` patches. */
export function identityWarpMesh(bounds: Box, columns = 1, rows = 1): WarpMesh {
  return fitWarpMesh((s, t) => ({ x: bounds.x + s * bounds.width, y: bounds.y + t * bounds.height }), evenKnots(clampMeshCount(columns)), evenKnots(clampMeshCount(rows)));
}

/**
 * The patch holding box fraction `s` and the parameter inside it. Outside 0–1 the end patches
 * extrapolate (their polynomials continue), so handles past the box map smoothly.
 */
function locate(knots: readonly number[], s: number): [number, number] {
  const n = knots.length - 1;
  let i = 0;
  while (i + 1 < n && s > knots[i + 1]) i++;
  const w = knots[i + 1] - knots[i];
  return [i, w > 0 ? (s - knots[i]) / w : 0];
}

/** The surface at box fractions `(s, t)`. */
export function evalWarpMesh(m: WarpMesh, s: number, t: number): Vec2 {
  const [pi, a] = locate(m.us, s);
  const [pj, b] = locate(m.vs, t);
  const ba = bernstein(a);
  const bb = bernstein(b);
  const nx = warpMeshColumns(m);
  let x = 0;
  let y = 0;
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const p = m.points[(3 * pj + j) * nx + 3 * pi + i];
      const k = ba[i] * bb[j];
      x += p.x * k;
      y += p.y * k;
    }
  }
  return { x, y };
}

function transposeMesh(m: WarpMesh): WarpMesh {
  const nx = warpMeshColumns(m);
  const ny = warpMeshRows(m);
  const points: Vec2[] = new Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) points[i * ny + j] = m.points[j * nx + i];
  return { us: m.vs.slice(), vs: m.us.slice(), points };
}

/** The mesh with the patch column holding `s` split at `s` (exact). Null when `s` is on or too close to a boundary. */
export function splitWarpMeshU(m: WarpMesh, s: number): WarpMesh | null {
  const [pi, a] = locate(m.us, s);
  if (!(a >= 0.01 && a <= 0.99)) return null;
  const nx = warpMeshColumns(m);
  const ny = warpMeshRows(m);
  const points: Vec2[] = [];
  for (let j = 0; j < ny; j++) {
    const row = m.points.slice(j * nx, (j + 1) * nx);
    points.push(...row.slice(0, 3 * pi), ...splitCubic(row.slice(3 * pi, 3 * pi + 4), a), ...row.slice(3 * pi + 4));
  }
  const us = m.us.slice();
  us.splice(pi + 1, 0, Math.min(1, Math.max(0, s)));
  return { us, vs: m.vs.slice(), points };
}

/** The mesh with the patch row holding `t` split at `t` (exact). */
export function splitWarpMeshV(m: WarpMesh, t: number): WarpMesh | null {
  const out = splitWarpMeshU(transposeMesh(m), t);
  return out && transposeMesh(out);
}

/**
 * The mesh without interior vertical boundary `k` (1 … us.length − 2), its two patch columns
 * merged: exact when they came from an unedited split; otherwise the outer control points stay and
 * the inner handles are extrapolated.
 */
export function removeWarpMeshSplitU(m: WarpMesh, k: number): WarpMesh | null {
  if (k <= 0 || k + 1 >= m.us.length) return null;
  const a = (m.us[k] - m.us[k - 1]) / (m.us[k + 1] - m.us[k - 1]);
  const nx = warpMeshColumns(m);
  const ny = warpMeshRows(m);
  const c0 = 3 * (k - 1);
  const points: Vec2[] = [];
  for (let j = 0; j < ny; j++) {
    const row = m.points.slice(j * nx, (j + 1) * nx);
    const [p0, q1, r2, p3] = [row[c0], row[c0 + 1], row[c0 + 5], row[c0 + 6]];
    // De Casteljau inverse: q1 = lerpVec2(p0, p1, a), r2 = lerpVec2(p2, p3, a).
    const p1 = { x: (q1.x - (1 - a) * p0.x) / a, y: (q1.y - (1 - a) * p0.y) / a };
    const p2 = { x: (r2.x - a * p3.x) / (1 - a), y: (r2.y - a * p3.y) / (1 - a) };
    points.push(...row.slice(0, c0), p0, p1, p2, p3, ...row.slice(c0 + 7));
  }
  const us = m.us.slice();
  us.splice(k, 1);
  return { us, vs: m.vs.slice(), points };
}

/** Removes interior horizontal boundary `k`. */
export function removeWarpMeshSplitV(m: WarpMesh, k: number): WarpMesh | null {
  const out = removeWarpMeshSplitU(transposeMesh(m), k);
  return out && transposeMesh(out);
}

/** Every control point through `f` (exact for affine maps). */
export function mapWarpMeshPoints(m: WarpMesh, f: (p: Vec2) => Vec2): WarpMesh {
  return { us: m.us.slice(), vs: m.vs.slice(), points: m.points.map((p) => f(p)) };
}

/**
 * The mesh with `columns × rows` patches over the same surface: split exactly when its knots are
 * a subset of the new even ones (a one-patch mesh always is), otherwise refitted.
 */
export function resizeWarpMesh(m: WarpMesh, columns: number, rows: number): WarpMesh {
  const cols = clampMeshCount(columns);
  const rws = clampMeshCount(rows);
  if (m.us.length - 1 === cols && m.vs.length - 1 === rws) return m;
  const us = evenKnots(cols);
  const vs = evenKnots(rws);
  const has = (list: number[], v: number) => list.some((k) => Math.abs(k - v) < 1e-12);
  if (m.us.every((u) => has(us, u)) && m.vs.every((v) => has(vs, v))) {
    let out: WarpMesh | null = m;
    for (const u of us) if (!has(out.us, u)) out = splitWarpMeshU(out, u) ?? out;
    for (const v of vs) if (!has(out.vs, v)) out = splitWarpMeshV(out, v) ?? out;
    return out;
  }
  return fitWarpMesh((s, t) => evalWarpMesh(m, s, t), us, vs);
}

/** Bounding box of the control points (the surface lies inside it). */
export function warpMeshControlBounds(m: WarpMesh): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of m.points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Box fractions `(s, t)` whose surface point is nearest `p` (a coarse search, then Newton steps). */
export function warpMeshParamAt(m: WarpMesh, p: Vec2): { s: number; t: number; distance: number } {
  const n = 48;
  let best = { s: 0.5, t: 0.5, d: Infinity };
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const q = evalWarpMesh(m, i / n, j / n);
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d < best.d) best = { s: i / n, t: j / n, d };
    }
  }
  let { s, t } = best;
  for (let k = 0; k < 12; k++) {
    const h = 1e-5;
    const q = evalWarpMesh(m, s, t);
    const qs = evalWarpMesh(m, s + h, t);
    const qt = evalWarpMesh(m, s, t + h);
    const a = (qs.x - q.x) / h;
    const b = (qt.x - q.x) / h;
    const c = (qs.y - q.y) / h;
    const d = (qt.y - q.y) / h;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) break;
    const ex = p.x - q.x;
    const ey = p.y - q.y;
    s = Math.min(1, Math.max(0, s + (d * ex - b * ey) / det));
    t = Math.min(1, Math.max(0, t + (a * ey - c * ex) / det));
  }
  const q = evalWarpMesh(m, s, t);
  return { s, t, distance: Math.hypot(q.x - p.x, q.y - p.y) };
}

/**
 * Makes the tangent equal on both sides of every interior grid line for the control points in
 * columns `i0..i1` and rows `j0..j1` (exclusive ends): each pair of handles takes the average of
 * the two tangents it had. In place.
 */
function smoothLines(m: WarpMesh, i0: number, i1: number, j0: number, j1: number) {
  const nx = warpMeshColumns(m);
  i1 = Math.min(i1, nx);
  j1 = Math.min(j1, warpMeshRows(m));
  const triples: [number, number, number, number, number][] = [];
  for (let a = 1; a < m.us.length - 1; a++) {
    if (3 * a >= i0 && 3 * a < i1)
      for (let j = j0; j < j1; j++) triples.push([j * nx + 3 * a - 1, j * nx + 3 * a, j * nx + 3 * a + 1, m.us[a] - m.us[a - 1], m.us[a + 1] - m.us[a]]);
  }
  for (let b = 1; b < m.vs.length - 1; b++) {
    if (3 * b >= j0 && 3 * b < j1)
      for (let i = i0; i < i1; i++) triples.push([(3 * b - 1) * nx + i, 3 * b * nx + i, (3 * b + 1) * nx + i, m.vs[b] - m.vs[b - 1], m.vs[b + 1] - m.vs[b]]);
  }
  for (const [l, c, r, hl, hr] of triples) {
    const pl = m.points[l];
    const pc = m.points[c];
    const pr = m.points[r];
    const tx = ((pc.x - pl.x) / hl + (pr.x - pc.x) / hr) / 2;
    const ty = ((pc.y - pl.y) / hl + (pr.y - pc.y) / hr) / 2;
    m.points[l] = { x: pc.x - tx * hl, y: pc.y - ty * hl };
    m.points[r] = { x: pc.x + tx * hr, y: pc.y + ty * hr };
  }
}

/**
 * `base` with control point `index` dragged by `d`, keeping the surface smooth across the grid
 * lines: an anchor moves with the eight points around it as one block; a handle moves with the two
 * points beside it across its line, and the handle opposite it on the same anchor turns the other
 * way (with its two neighbours), so the line keeps passing straight through the anchor. An inner
 * point of a patch moves alone.
 */
export function dragWarpMeshPoint(base: WarpMesh, index: number, d: Vec2): WarpMesh {
  if (index < 0 || index >= base.points.length || !Number.isFinite(d.x) || !Number.isFinite(d.y)) return base;
  const out: WarpMesh = { us: base.us.slice(), vs: base.vs.slice(), points: base.points.slice() };
  const nx = warpMeshColumns(base);
  const ny = warpMeshRows(base);
  const i = index % nx;
  const j = Math.floor(index / nx);
  const shift = (ii: number, jj: number, v: Vec2) => {
    if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) return;
    const p = out.points[jj * nx + ii];
    out.points[jj * nx + ii] = { x: p.x + v.x, y: p.y + v.y };
  };
  // Spans either side of interior knot `k`.
  const span = (knots: number[], k: number): [number, number] | null => (k > 0 && k + 1 < knots.length ? [knots[k] - knots[k - 1], knots[k + 1] - knots[k]] : null);
  const ri = i % 3;
  const rj = j % 3;
  if (ri === 0 && rj === 0) {
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) shift(i + di, j + dj, d);
  } else if (ri === 0) {
    // A handle along a vertical line: it takes the two points beside it across the line.
    for (let di = -1; di <= 1; di++) shift(i + di, j, d);
    // The opposite handle of the same anchor turns the other way.
    const sp = span(base.vs, Math.floor(j / 3) + (rj === 2 ? 1 : 0));
    if (sp) {
      const [other, k] = rj === 1 ? [j - 2, sp[0] / sp[1]] : [j + 2, sp[1] / sp[0]];
      for (let di = -1; di <= 1; di++) shift(i + di, other, { x: -d.x * k, y: -d.y * k });
    }
  } else if (rj === 0) {
    // A handle along a horizontal line, likewise.
    for (let dj = -1; dj <= 1; dj++) shift(i, j + dj, d);
    const sp = span(base.us, Math.floor(i / 3) + (ri === 2 ? 1 : 0));
    if (sp) {
      const [other, k] = ri === 1 ? [i - 2, sp[0] / sp[1]] : [i + 2, sp[1] / sp[0]];
      for (let dj = -1; dj <= 1; dj++) shift(other, j + dj, { x: -d.x * k, y: -d.y * k });
    }
  } else shift(i, j, d);
  return out;
}

/**
 * `base` with its surface point at box fractions `(s, t)` pulled by `d`, the way dragging inside a
 * patch works: interior anchors within about two cells follow by a share of `d` that fades with
 * distance (each with its block of handles, so grid lines stay smooth); the outer border stays
 * pinned unless the grab is near it, and then it bows; the four corners never move. The grabbed
 * patch's inner points (and, near the border, the border's handles) make up the rest, so the
 * grabbed point lands exactly at its start + `d`.
 */
export function pullWarpMesh(base: WarpMesh, s: number, t: number, d: Vec2): WarpMesh {
  /** Within this distance of the border (box fractions) a grab starts to drag the border with it. */
  const BORDER_ZONE = 0.12;
  /** Falloff radius, in the grabbed patch's size. */
  const REACH = 1.8;
  if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) return base;
  const m: WarpMesh = { us: base.us.slice(), vs: base.vs.slice(), points: base.points.slice() };
  const cols = m.us.length - 1;
  const rows = m.vs.length - 1;
  const [pi, a] = locate(m.us, s);
  const [pj, b] = locate(m.vs, t);
  const ba = bernstein(a);
  const bb = bernstein(b);
  const nx = warpMeshColumns(m);
  const ny = warpMeshRows(m);
  const anchor = (ai: number, aj: number) => base.points[3 * aj * nx + 3 * ai] ?? { x: 0, y: 0 };
  const at0 = evalWarpMesh(base, s, t);
  const target = { x: at0.x + d.x, y: at0.y + d.y };
  // The grabbed patch's size and how far inside it the grab is (1 in the middle, 0 on its edges).
  let size = 1;
  for (const k of ['x', 'y'] as const) {
    const vals = [anchor(pi, pj)[k], anchor(pi + 1, pj)[k], anchor(pi, pj + 1)[k], anchor(pi + 1, pj + 1)[k]];
    size = Math.max(size, Math.max(...vals) - Math.min(...vals));
  }
  const radius = REACH * size;
  const innerW = (ba[1] + ba[2]) * (bb[1] + bb[2]);
  const interior = Math.min(1, Math.max(0, innerW / 0.5625));
  const toBorder = Math.min(s, 1 - s, t, 1 - t);
  const nearBorder = Math.min(1, Math.max(0, 1 - toBorder / BORDER_ZONE));
  const meshCorner = (ai: number, aj: number) => (ai === 0 || ai === cols) && (aj === 0 || aj === rows);
  const onBorder = (ai: number, aj: number) => ai === 0 || ai === cols || aj === 0 || aj === rows;
  const reach = (ai: number, aj: number, wa: number, wb: number) => (meshCorner(ai, aj) ? 0 : wa * wb * (onBorder(ai, aj) ? nearBorder : 1));
  const corner: [number, number, number][] = [
    [pi, pj, reach(pi, pj, ba[0] + ba[1], bb[0] + bb[1])],
    [pi + 1, pj, reach(pi + 1, pj, ba[2] + ba[3], bb[0] + bb[1])],
    [pi, pj + 1, reach(pi, pj + 1, ba[0] + ba[1], bb[2] + bb[3])],
    [pi + 1, pj + 1, reach(pi + 1, pj + 1, ba[2] + ba[3], bb[2] + bb[3])]
  ];
  // Share of `d` for each anchor.
  const share = new Array((cols + 1) * (rows + 1)).fill(0);
  for (let aj = 0; aj <= rows; aj++) {
    for (let ai = 0; ai <= cols; ai++) {
      const p = anchor(ai, aj);
      const x = Math.min(1, Math.max(0, Math.hypot(p.x - at0.x, p.y - at0.y) / radius));
      const fall = 0.5 * (1 + Math.cos(Math.PI * x));
      const edge = meshCorner(ai, aj) ? 0 : onBorder(ai, aj) ? nearBorder : 1;
      share[aj * (cols + 1) + ai] = fall * edge;
    }
  }
  // The grabbed patch's own corners: near one, that corner follows the pointer.
  for (const [ai, aj, w] of corner) share[aj * (cols + 1) + ai] = Math.max(share[aj * (cols + 1) + ai], (1 - interior) * w);
  const move = (idx: number, k: number, v: Vec2) => {
    const p = m.points[idx];
    m.points[idx] = { x: p.x + v.x * k, y: p.y + v.y * k };
  };
  // Every control point moves with the anchor it is closest to.
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const ai = Math.min(cols, Math.floor((i + 1) / 3));
      const aj = Math.min(rows, Math.floor((j + 1) / 3));
      move(j * nx + i, share[aj * (cols + 1) + ai], d);
    }
  }
  // Close the gap exactly with three groups that share the work: the grabbed patch's four inner
  // points, the corner blocks, and (near the border) the border's own handles. Closing nudges the
  // tangents across the grid lines, so they are evened out again and the gap re-closed.
  let norm = 0;
  for (const j of [1, 2]) for (const i of [1, 2]) norm += (ba[i] * bb[j]) ** 2;
  const cornerNorm = corner.reduce((acc, c) => acc + c[2] * c[2], 0);
  // With no free corner to help (a one-patch grid grabbed away from its border) the inner points do all of it.
  const innerPart = cornerNorm > 1e-12 ? Math.min(1, innerW / 0.15) : 1;
  const edgeHandles: [number, number][] = [];
  for (const k of [1, 2]) {
    if (pi === 0) edgeHandles.push([(3 * pj + k) * nx + 3 * pi, ba[0] * bb[k]]);
    if (pi + 1 === cols) edgeHandles.push([(3 * pj + k) * nx + 3 * pi + 3, ba[3] * bb[k]]);
    if (pj === 0) edgeHandles.push([3 * pj * nx + 3 * pi + k, ba[k] * bb[0]]);
    if (pj + 1 === rows) edgeHandles.push([(3 * pj + 3) * nx + 3 * pi + k, ba[k] * bb[3]]);
  }
  const edgeNorm = edgeHandles.reduce((acc, e) => acc + e[1] * e[1], 0);
  const edgePart = edgeNorm > 1e-12 ? nearBorder : 0;
  const innerShare = (1 - edgePart) * innerPart;
  const cornerShare = (1 - edgePart) * (1 - innerPart);
  for (let iter = 0; iter < 60; iter++) {
    const now = evalWarpMesh(m, s, t);
    const rem = { x: target.x - now.x, y: target.y - now.y };
    if (Math.hypot(rem.x, rem.y) < 1e-9) break;
    if (innerShare > 0 && norm > 0) for (const j of [1, 2]) for (const i of [1, 2]) move((3 * pj + j) * nx + 3 * pi + i, ((ba[i] * bb[j]) / norm) * innerShare, rem);
    if (edgePart > 0) for (const [idx, w] of edgeHandles) move(idx, (w / edgeNorm) * edgePart, rem);
    if (cornerShare > 0 && cornerNorm > 0) {
      for (const [ai, aj, w] of corner) {
        const k = (w / cornerNorm) * cornerShare;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const i = 3 * ai + di;
            const j = 3 * aj + dj;
            if (i >= 0 && j >= 0 && i < nx && j < ny) move(j * nx + i, k, rem);
          }
        }
      }
    }
    for (let k = 0; k < 3; k++) smoothLines(m, Math.max(0, 3 * pi - 3), 3 * pi + 7, Math.max(0, 3 * pj - 3), 3 * pj + 7);
  }
  return m;
}

/**
 * The control points an editor shows: the anchors (where grid lines cross) and the handles along
 * the grid lines, each with the anchor it belongs to. Points inside a patch are left out (drag
 * inside a patch to pull the surface instead).
 */
export function warpMeshEditPoints(m: WarpMesh): { anchors: number[]; handles: { index: number; anchor: number }[] } {
  const nx = warpMeshColumns(m);
  const ny = warpMeshRows(m);
  const anchors: number[] = [];
  const handles: { index: number; anchor: number }[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const ri = i % 3;
      const rj = j % 3;
      if (ri === 0 && rj === 0) anchors.push(j * nx + i);
      else if (ri === 0) handles.push({ index: j * nx + i, anchor: (rj === 1 ? j - 1 : j + 1) * nx + i });
      else if (rj === 0) handles.push({ index: j * nx + i, anchor: j * nx + (ri === 1 ? i - 1 : i + 1) });
    }
  }
  return { anchors, handles };
}

/** The mesh's grid lines (patch borders) as cubics `[p0, p1, p2, p3]`. */
export function warpMeshGridCurves(m: WarpMesh): Vec2[][] {
  const nx = warpMeshColumns(m);
  const ny = warpMeshRows(m);
  const pt = (i: number, j: number) => m.points[j * nx + i];
  const out: Vec2[][] = [];
  for (let j = 0; j < ny; j += 3) for (let i = 0; i + 3 < nx; i += 3) out.push([pt(i, j), pt(i + 1, j), pt(i + 2, j), pt(i + 3, j)]);
  for (let i = 0; i < nx; i += 3) for (let j = 0; j + 3 < ny; j += 3) out.push([pt(i, j), pt(i, j + 1), pt(i, j + 2), pt(i, j + 3)]);
  return out;
}
