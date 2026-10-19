/**
 * Plain geometry types shared by the vector and image editors. No DOM, no editor types.
 */

/** A point (or a vector) in some 2D space. */
export interface Vec2 {
  x: number;
  y: number;
}

/** An axis-aligned box: top-left corner, width and height. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An affine matrix `[a, b, c, d, e, f]`: `x' = a·x + c·y + e`, `y' = b·x + d·y + f` (SVG order). */
export type AffineMatrix = readonly [number, number, number, number, number, number];

/**
 * A 3×3 projective map, row-major: `[x', y', w'] = H · [x, y, 1]`, so `x' = (h0 x + h1 y + h2) / w'`
 * and `y' = (h3 x + h4 y + h5) / w'` with `w' = h6 x + h7 y + h8`.
 */
export type Homography = readonly [number, number, number, number, number, number, number, number, number];

/** A quadrilateral's corners clockwise on screen (y down) from the top left: TL, TR, BR, BL. */
export type Quad = readonly [Vec2, Vec2, Vec2, Vec2];

/** Warp presets (Photoshop's fifteen, in menu order). */
export type WarpStyle =
  | 'arc'
  | 'arcLower'
  | 'arcUpper'
  | 'arch'
  | 'bulge'
  | 'shellLower'
  | 'shellUpper'
  | 'flag'
  | 'wave'
  | 'fish'
  | 'rise'
  | 'fisheye'
  | 'inflate'
  | 'squeeze'
  | 'twist';

/**
 * A grid of bicubic Bézier patches mapping a source box onto the plane. `us` / `vs` are the patch
 * boundaries as fractions of the box (increasing, first 0, last 1); `points` is the
 * `(3·(us.length − 1) + 1) × (3·(vs.length − 1) + 1)` control grid, row by row, in the output
 * space. Neighbouring patches share their edge row: anchors sit where both indices are multiples
 * of 3, handles where one is.
 */
export interface WarpMesh {
  us: number[];
  vs: number[];
  points: Vec2[];
}
