// Portions ported from photocraft/crates/algo/src/transform.rs and crates/algo/src/warp.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Resampling tiled surfaces through geometric maps: Free Transform (scale, rotate, skew, distort,
 * perspective: one projective map) and Warp (any forward map, such as a Bézier mesh).
 *
 * - Inverse mapping per destination tile: each destination tile reads only the source window its
 *   pixels map into, so memory stays bounded by one tile's footprint, and the result is a new
 *   copy-on-write surface (an identity or a whole-pixel move returns the source, or shares its
 *   tiles).
 * - Nearest, bilinear and Photoshop's Bicubic (the Keys cubic at a = −0.75). Colour is sampled
 *   premultiplied by alpha, so partially transparent edges don't pick up the colour of the
 *   transparent pixels around them; outside the source everything is transparent.
 * - Large reductions with Bicubic are pre-filtered: the source is box-averaged by whole factors
 *   first and the cubic widened by the rest, so shrinking a layer doesn't alias. Bilinear and
 *   nearest sample the source directly, as Photoshop's do.
 * - Masks (one channel) are warped as "value + inside": outside the source and outside the warped
 *   area they read as the surface's default value, so a reveal-all mask stays white around a
 *   transformed hole.
 * - A Distort dragged past the horizon draws only the side of the horizon most of the source maps
 *   to (no mirrored copy wrapped round infinity).
 *
 * No DOM: runs in Node, tests and workers.
 */

import {
  TILE,
  TiledSurface,
  contentBounds,
  emptySurface,
  finishTile,
  readRegion,
  tileKey,
  tilesInRect,
  translateSurface,
  writeRegion,
  type RasterRect,
  type Tile,
  type TileKey,
} from './surface';
import {
  applyHomography,
  cornerBounds,
  homographyFrontSide,
  homographyW,
  invertHomography,
  isIdentityHomography,
  multiplyHomographies,
  boxQuad,
} from '../geom/homography';
import type { Homography, Vec2 } from '../geom/types';

/** Resampling of a transform (Photoshop's interpolation menu). */
export type Interpolation = 'nearest' | 'bilinear' | 'bicubic';

export const INTERPOLATIONS: readonly Interpolation[] = ['nearest', 'bilinear', 'bicubic'];

export function isInterpolation(value: unknown): value is Interpolation {
  return typeof value === 'string' && (INTERPOLATIONS as readonly string[]).includes(value);
}

/**
 * The largest result (pixels) one resample may build: about 11 600 × 11 600. Only the size of the
 * result counts, not where it lands. A scale past it is refused rather than clipped.
 */
export const MAX_TRANSFORM_PIXELS = 1 << 27;

/** A transform whose result would be too large; the message gives the size and the limit. */
export class TransformTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransformTooLargeError';
  }
}

export interface ResampleOptions {
  /** Default `bicubic`. */
  interpolation?: Interpolation;
  /** The source region to transform (default: the surface's content bounds). Pixels outside it are not moved. */
  source?: RasterRect;
  /** Keep only destination pixels inside this rectangle (a preview of the visible area). */
  clip?: RasterRect;
  /**
   * Preview speed-up: sample once per `step × step` block of destination pixels and fill the
   * block (a power of two, 1..64; default 1, every pixel).
   */
  step?: number;
}

// ---------------------------------------------------------------------------
// Kernels
// ---------------------------------------------------------------------------

const KEYS_A = -0.75;

/**
 * Photoshop's Bicubic: the Keys cubic at a = −0.75 (Catmull-Rom is −0.5). Measured on Photoshop
 * 27.11's Free Transform by photocraft: a 200 % step edge matches within 0.5 levels.
 */
export function keysWeight(x: number): number {
  x = Math.abs(x);
  if (x < 1) return ((KEYS_A + 2) * x - (KEYS_A + 3)) * x * x + 1;
  if (x < 2) return KEYS_A * (((x - 5) * x + 8) * x - 4);
  return 0;
}

/** Snaps a sample position within float noise of the pixel grid onto it, so an identity is exact. */
const snap = (t: number) => (Math.abs(t - Math.round(t)) < 1e-7 ? Math.round(t) : t);

/** Most taps of a widened cubic along one axis (the residual widening is below 4 after pre-reduction). */
const MAX_TAPS = 20;

/** First tap index and tap count of the last `cubicTaps` call (module state, so sampling allocates nothing). */
let tapI0 = 0;
let tapN = 0;

/** Taps of the cubic at `u` (pixel-index units), widened by `s` ≥ 1: sets `tapI0` / `tapN` and fills `w` with normalised weights. */
function cubicTaps(u: number, s: number, w: Float64Array): void {
  if (s <= 1.0001) {
    const f = Math.floor(u);
    const t = u - f;
    w[0] = keysWeight(1 + t);
    w[1] = keysWeight(t);
    w[2] = keysWeight(1 - t);
    w[3] = keysWeight(2 - t);
    tapI0 = f - 1;
    tapN = 4;
    return;
  }
  const r = 2 * s;
  const i0 = Math.ceil(u - r);
  const n = Math.min(MAX_TAPS, Math.floor(u + r) - i0 + 1);
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const v = keysWeight((i0 + k - u) / s);
    w[k] = v;
    sum += v;
  }
  if (sum !== 0) for (let k = 0; k < n; k++) w[k] /= sum;
  tapI0 = i0;
  tapN = n;
}

// ---------------------------------------------------------------------------
// Source windows
// ---------------------------------------------------------------------------

/**
 * A float copy of part of a source: premultiplied RGBA (colour 0..255 × alpha, alpha 0..1) for
 * layers, `[value, inside]` for one-channel masks (inside is 1 within the source region). Zero
 * outside the source region.
 */
interface Window {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Values per pixel: 4 (RGBA) or 2 (mask value, inside). */
  n: 2 | 4;
  data: Float32Array;
}

function intersect(a: RasterRect, b: RasterRect): RasterRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x && y1 > y ? { x, y, width: x1 - x, height: y1 - y } : null;
}

function hasTilesIn(src: TiledSurface, r: RasterRect): boolean {
  for (const { tx, ty } of tilesInRect(r)) if (src.getTile(tx, ty)) return true;
  return false;
}

function readWindow(src: TiledSurface, srcRect: RasterRect, rect: RasterRect): Window {
  const n: 2 | 4 = src.channels === 4 ? 4 : 2;
  const data = new Float32Array(rect.width * rect.height * n);
  const win: Window = { x: rect.x, y: rect.y, w: rect.width, h: rect.height, n, data };
  const r = intersect(rect, srcRect);
  if (!r) return win;
  const px = readRegion(src, r);
  for (let y = 0; y < r.height; y++) {
    let s = y * r.width * src.channels;
    let d = ((r.y - rect.y + y) * rect.width + (r.x - rect.x)) * n;
    if (n === 4) {
      for (let x = 0; x < r.width; x++, s += 4, d += 4) {
        const a = px[s + 3] / 255;
        data[d] = px[s] * a;
        data[d + 1] = px[s + 1] * a;
        data[d + 2] = px[s + 2] * a;
        data[d + 3] = a;
      }
    } else {
      for (let x = 0; x < r.width; x++, s++, d += 2) {
        data[d] = px[s];
        data[d + 1] = 1;
      }
    }
  }
  return win;
}

/** One stored pixel, for packing samples before they are copied over a preview block. */
const scratch = new Uint8ClampedArray(4);
const scratchWord = new Uint32Array(scratch.buffer);

const wx = new Float64Array(MAX_TAPS);
const wy = new Float64Array(MAX_TAPS);

/**
 * One sample of the window at pixel-index position (`u`, `v`) (pixel centres at integers) into
 * `acc` (premultiplied). `su`, `sv`: widening of the cubic along each source axis (≥ 1).
 */
function sample(win: Window, interp: Interpolation, u: number, v: number, su: number, sv: number, acc: Float64Array): void {
  const n = win.n;
  const d = win.data;
  for (let c = 0; c < n; c++) acc[c] = 0;
  if (interp === 'nearest') {
    const ix = Math.floor(u + 0.5) - win.x;
    const iy = Math.floor(v + 0.5) - win.y;
    if (ix < 0 || iy < 0 || ix >= win.w || iy >= win.h) return;
    const o = (iy * win.w + ix) * n;
    for (let c = 0; c < n; c++) acc[c] = d[o + c];
    return;
  }
  if (interp === 'bilinear') {
    const fx = Math.floor(u);
    const fy = Math.floor(v);
    const tx = u - fx;
    const ty = v - fy;
    for (let j = 0; j < 2; j++) {
      const iy = fy + j - win.y;
      if (iy < 0 || iy >= win.h) continue;
      const kyw = j ? ty : 1 - ty;
      if (!kyw) continue;
      for (let i = 0; i < 2; i++) {
        const ix = fx + i - win.x;
        if (ix < 0 || ix >= win.w) continue;
        const k = (i ? tx : 1 - tx) * kyw;
        if (!k) continue;
        const o = (iy * win.w + ix) * n;
        for (let c = 0; c < n; c++) acc[c] += d[o + c] * k;
      }
    }
    return;
  }
  u = snap(u);
  v = snap(v);
  cubicTaps(u, su, wx);
  const x0 = tapI0 - win.x;
  const nu = tapN;
  cubicTaps(v, sv, wy);
  const y0 = tapI0 - win.y;
  const nv = tapN;
  const W = win.w;
  if (n === 4 && nu === 4 && nv === 4 && x0 >= 0 && y0 >= 0 && x0 + 4 <= W && y0 + 4 <= win.h) {
    // The common case: a plain 4 × 4 cubic fully inside the window.
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    const w0 = wx[0];
    const w1 = wx[1];
    const w2 = wx[2];
    const w3 = wx[3];
    for (let j = 0; j < 4; j++) {
      const kyw = wy[j];
      if (kyw === 0) continue;
      let o = ((y0 + j) * W + x0) * 4;
      const r0 = d[o] * w0 + d[o + 4] * w1 + d[o + 8] * w2 + d[o + 12] * w3;
      const g0 = d[o + 1] * w0 + d[o + 5] * w1 + d[o + 9] * w2 + d[o + 13] * w3;
      const b0 = d[o + 2] * w0 + d[o + 6] * w1 + d[o + 10] * w2 + d[o + 14] * w3;
      const a0 = d[o + 3] * w0 + d[o + 7] * w1 + d[o + 11] * w2 + d[o + 15] * w3;
      r += r0 * kyw;
      g += g0 * kyw;
      b += b0 * kyw;
      a += a0 * kyw;
    }
    acc[0] = r;
    acc[1] = g;
    acc[2] = b;
    acc[3] = a;
    return;
  }
  for (let j = 0; j < nv; j++) {
    const kyw = wy[j];
    if (kyw === 0) continue;
    const iy = y0 + j;
    if (iy < 0 || iy >= win.h) continue;
    const row = iy * W;
    for (let i = 0; i < nu; i++) {
      const k = wx[i] * kyw;
      if (k === 0) continue;
      const ix = x0 + i;
      if (ix < 0 || ix >= W) continue;
      const o = (row + ix) * n;
      if (n === 4) {
        acc[0] += d[o] * k;
        acc[1] += d[o + 1] * k;
        acc[2] += d[o + 2] * k;
        acc[3] += d[o + 3] * k;
      } else {
        acc[0] += d[o] * k;
        acc[1] += d[o + 1] * k;
      }
    }
  }
}

/**
 * Writes one premultiplied sample into a tile buffer at byte offset `o`: straight RGBA for layers,
 * the value flattened onto the default for masks. False when it adds nothing.
 */
function store(out: Uint8ClampedArray, o: number, acc: Float64Array, ch: 1 | 4, def: number): boolean {
  if (ch === 4) {
    const al = acc[3] > 1 ? 1 : acc[3];
    if (!(al > 1e-6)) return false;
    out[o] = acc[0] / al;
    out[o + 1] = acc[1] / al;
    out[o + 2] = acc[2] / al;
    out[o + 3] = al * 255;
    return true;
  }
  const inside = acc[1] > 1 ? 1 : acc[1];
  if (!(inside > 1e-6)) return false;
  out[o] = acc[0] + def * (1 - inside);
  return true;
}

// ---------------------------------------------------------------------------
// Pre-reduction (Bicubic shrinking)
// ---------------------------------------------------------------------------

/**
 * The source box-averaged by `kx × ky` blocks aligned to multiples of the factors (premultiplied
 * for RGBA), so reduced pixel (i, j) covers source pixels [i·kx, (i+1)·kx) × [j·ky, (j+1)·ky).
 * Returns the reduced surface and the reduced source rectangle. Works in strips of about one tile
 * row, so memory stays bounded.
 */
function boxReduce(src: TiledSurface, srcRect: RasterRect, kx: number, ky: number): { surface: TiledSurface; rect: RasterRect } {
  const ch = src.channels;
  const rx0 = Math.floor(srcRect.x / kx);
  const ry0 = Math.floor(srcRect.y / ky);
  const rx1 = Math.ceil((srcRect.x + srcRect.width) / kx);
  const ry1 = Math.ceil((srcRect.y + srcRect.height) / ky);
  const rw = rx1 - rx0;
  const rect = { x: rx0, y: ry0, width: rw, height: ry1 - ry0 };
  let out = emptySurface(ch, src.defaultValue);
  const rowsPer = Math.max(1, Math.floor(TILE / ky));
  const area = kx * ky;
  for (let ry = ry0; ry < ry1; ry += rowsPer) {
    const rows = Math.min(rowsPer, ry1 - ry);
    const strip = { x: rx0 * kx, y: ry * ky, width: rw * kx, height: rows * ky };
    const px = readRegion(src, strip);
    const red = new Uint8ClampedArray(rw * rows * ch);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < rw; i++) {
        if (ch === 4) {
          let a = 0;
          let r = 0;
          let g = 0;
          let b = 0;
          for (let y = 0; y < ky; y++) {
            let s = ((j * ky + y) * strip.width + i * kx) * 4;
            for (let x = 0; x < kx; x++, s += 4) {
              const al = px[s + 3];
              a += al;
              r += px[s] * al;
              g += px[s + 1] * al;
              b += px[s + 2] * al;
            }
          }
          const o = (j * rw + i) * 4;
          if (a > 0) {
            red[o] = r / a;
            red[o + 1] = g / a;
            red[o + 2] = b / a;
            red[o + 3] = a / area;
          }
        } else {
          let v = 0;
          for (let y = 0; y < ky; y++) {
            const s = (j * ky + y) * strip.width + i * kx;
            for (let x = 0; x < kx; x++) v += px[s + x];
          }
          red[j * rw + i] = v / area;
        }
      }
    }
    out = writeRegion(out, { x: rx0, y: ry, width: rw, height: rows }, red);
  }
  return { surface: out, rect };
}

/**
 * The surface box-averaged by `factor` (a whole number ≥ 1) in both directions: reduced pixel
 * (i, j) covers pixels [i·factor, (i+1)·factor) of each axis. For previews: transform the reduced
 * surface through the map composed with a scale by `factor`, so a preview at a low zoom reads a
 * fraction of the pixels.
 */
export function reduceSurface(src: TiledSurface, factor: number): TiledSurface {
  const k = Math.max(1, Math.floor(factor));
  const b = contentBounds(src);
  if (k === 1 || !b) return src;
  return boxReduce(src, b, k, k).surface;
}

/** Source pixels per destination pixel along each source axis at destination point (X, Y), for `inv` (destination → source). */
function inverseStretch(inv: Homography, X: number, Y: number): [number, number] {
  const w = inv[6] * X + inv[7] * Y + inv[8];
  if (!(Math.abs(w) > 1e-12)) return [1, 1];
  const U = (inv[0] * X + inv[1] * Y + inv[2]) / w;
  const V = (inv[3] * X + inv[4] * Y + inv[5]) / w;
  const ux = (inv[0] - U * inv[6]) / w;
  const uy = (inv[1] - U * inv[7]) / w;
  const vx = (inv[3] - V * inv[6]) / w;
  const vy = (inv[4] - V * inv[7]) / w;
  return [Math.hypot(ux, uy), Math.hypot(vx, vy)];
}

/** Whole reduction factor for a stretch: the largest power of two ≤ `s` (1..64). */
const reduction = (s: number) => (s >= 2 && Number.isFinite(s) ? Math.min(64, 2 ** Math.floor(Math.log2(s))) : 1);

// ---------------------------------------------------------------------------
// Projective transforms
// ---------------------------------------------------------------------------

function normalizeStep(step: number | undefined): number {
  if (!step || !(step > 1)) return 1;
  return Math.min(64, 2 ** Math.floor(Math.log2(step)));
}

function checkBudget(dst: RasterRect, what = 'result'): void {
  if (dst.width * dst.height > MAX_TRANSFORM_PIXELS) {
    throw new TransformTooLargeError(
      `The transformed ${what} would be ${dst.width} × ${dst.height} px, more than the ${MAX_TRANSFORM_PIXELS} px limit; use a smaller scale.`
    );
  }
}

/** The new surface from `tiles` written over an empty one (default value kept). */
function assemble(src: TiledSurface, tiles: Map<TileKey, Tile>): TiledSurface {
  return new TiledSurface(src.channels, tiles, src.defaultValue);
}

/** The destination rectangle `transformSurface` fills for `source` under `h`, or `null` when it is empty or unbounded. */
export function transformedBounds(source: RasterRect, h: Homography): RasterRect | null {
  if (!(source.width > 0 && source.height > 0) || !invertHomography(h)) return null;
  const pts = boxQuad(source).map((p) => applyHomography(h, p));
  if (pts.some((p) => !p)) return null;
  return cornerBounds(pts as Vec2[]);
}

/**
 * The surface's content inside `options.source` (default: all of it) warped by `h` (source →
 * destination, both in the surface's pixel space). Pixels outside the warped area are the default
 * (transparent for layers). Throws `TransformTooLargeError` past `MAX_TRANSFORM_PIXELS`.
 */
export function transformSurface(src: TiledSurface, h: Homography, options: ResampleOptions = {}): TiledSurface {
  const interp = options.interpolation ?? 'bicubic';
  const ch = src.channels;
  const def = src.defaultValue;
  const empty = emptySurface(ch, def);
  const given = options.source;
  const step = normalizeStep(options.step);
  if (isIdentityHomography(h, 1e-12) && !given && !options.clip) return src;
  // A whole-pixel move is exact and shares tiles when it is a multiple of the tile size.
  const dx = h[2] / h[8];
  const dy = h[5] / h[8];
  if (!given && !options.clip && isIdentityHomography([h[0], h[1], 0, h[3], h[4], 0, h[6], h[7], h[8]], 1e-12) && Math.abs(dx - Math.round(dx)) < 1e-9 && Math.abs(dy - Math.round(dy)) < 1e-9) {
    return translateSurface(src, Math.round(dx), Math.round(dy));
  }
  let srcRect = given ? intersect(given, given) : contentBounds(src);
  if (!srcRect) return empty;
  let H = h;
  let S = src;
  // Pre-reduce for large downscales (bicubic alone aliases below ~50 %): box-average by whole
  // factors so the cubic, widened by the rest, samples at most about 2:1.
  if (interp === 'bicubic') {
    const inv0 = invertHomography(H);
    const c = applyHomography(H, { x: srcRect.x + srcRect.width / 2, y: srcRect.y + srcRect.height / 2 });
    if (inv0 && c) {
      const [su, sv] = inverseStretch(inv0, c.x, c.y);
      const kx = reduction(su);
      const ky = reduction(sv);
      if (kx > 1 || ky > 1) {
        const red = boxReduce(src, srcRect, kx, ky);
        S = red.surface;
        srcRect = red.rect;
        H = multiplyHomographies([kx, 0, 0, 0, ky, 0, 0, 0, 1], H);
      }
    }
  }
  const inv = invertHomography(H);
  if (!inv) return empty;
  const sr = srcRect;
  // While the forward w keeps one sign over the source (plus the margin the sampler reads), every
  // sampled pixel lies at least `wLo` from the inverse horizon, so clipping a tile there keeps its
  // footprint exact and bounded even when a steep Distort brings that horizon into the tile.
  const fwd = [
    { x: sr.x - 1, y: sr.y - 1 },
    { x: sr.x + sr.width + 1, y: sr.y - 1 },
    { x: sr.x + sr.width + 1, y: sr.y + sr.height + 1 },
    { x: sr.x - 1, y: sr.y + sr.height + 1 },
  ].map((p) => homographyW(H, p));
  const side = fwd.every((w) => w > 0) ? 1 : fwd.every((w) => w < 0) ? -1 : 0;
  const wLo = 1 / fwd.reduce((m, w) => Math.max(m, Math.abs(w)), 0);
  // A source straddling the horizon draws only its front side.
  const front = side === 0 ? homographyFrontSide(H, sr) : 0;
  const corners = boxQuad(sr).map((p) => applyHomography(H, p));
  const bounds = corners.every(Boolean) ? cornerBounds(corners as Vec2[]) : null;
  let dst: RasterRect | null;
  if (options.clip && bounds && side !== 0) dst = intersect(bounds, options.clip);
  else dst = options.clip ?? bounds;
  if (!dst) return empty;
  if (!options.clip) checkBudget(dst);
  const affine = Math.abs(inv[6]) < 1e-15 && Math.abs(inv[7]) < 1e-15;
  const [su0, sv0] = inverseStretch(inv, dst.x + dst.width / 2, dst.y + dst.height / 2);
  const widen = (s: number) => (interp === 'bicubic' ? Math.min(4, Math.max(1, s)) : 1);
  const maxWiden = interp === 'bicubic' ? 4 : 1;
  const pad = 3 + Math.ceil(2 * maxWiden);
  const margin = interp === 'bicubic' ? Math.max(1, widen(su0), widen(sv0)) : 1;
  const tiles = new Map<TileKey, Tile>();
  const acc = new Float64Array(4);
  const sx0 = sr.x;
  const sy0 = sr.y;
  const sx1 = sr.x + sr.width - 1;
  const sy1 = sr.y + sr.height - 1;
  for (const { tx, ty } of tilesInRect(dst)) {
    const t = intersect({ x: tx * TILE, y: ty * TILE, width: TILE, height: TILE }, dst);
    if (!t) continue;
    // Source footprint of this tile (inverse-mapped corners of its sampled part), padded for the filter.
    const tc: Vec2[] = [
      { x: t.x, y: t.y },
      { x: t.x + t.width, y: t.y },
      { x: t.x + t.width, y: t.y + t.height },
      { x: t.x, y: t.y + t.height },
    ];
    const wc = tc.map((p) => homographyW(inv, p));
    let poly: Vec2[] = tc;
    if (side !== 0) {
      // Sutherland-Hodgman against side · w ≥ wLo.
      const dd = wc.map((w) => side * w - wLo);
      poly = [];
      for (let i = 0; i < 4; i++) {
        const p = tc[i];
        const q = tc[(i + 1) % 4];
        const dp = dd[i];
        const dq = dd[(i + 1) % 4];
        if (dp >= 0) poly.push(p);
        if (dp >= 0 !== dq >= 0) {
          const k = dp / (dp - dq);
          poly.push({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
        }
      }
    }
    if (!poly.length) continue;
    const straddles = side === 0 && wc.some((w) => w <= 0) && wc.some((w) => w >= 0);
    let foot: RasterRect | null;
    if (straddles) foot = sr;
    else {
      const fp = poly.map((p) => applyHomography(inv, p));
      if (fp.some((p) => !p)) foot = sr;
      else {
        const xs = (fp as Vec2[]).map((p) => p.x);
        const ys = (fp as Vec2[]).map((p) => p.y);
        const fx0 = Math.floor(Math.min(...xs)) - pad;
        const fy0 = Math.floor(Math.min(...ys)) - pad;
        const fx1 = Math.ceil(Math.max(...xs)) + pad;
        const fy1 = Math.ceil(Math.max(...ys)) + pad;
        foot = intersect({ x: fx0, y: fy0, width: fx1 - fx0, height: fy1 - fy0 }, { x: sr.x - pad, y: sr.y - pad, width: sr.width + 2 * pad, height: sr.height + 2 * pad });
      }
    }
    if (!foot) continue;
    const readable = intersect(foot, sr);
    if (!readable || !hasTilesIn(S, readable)) continue;
    const win = readWindow(S, sr, foot);
    const out = new Uint8ClampedArray(TILE * TILE * ch);
    if (def) out.fill(def);
    let any = false;
    const ox = tx * TILE;
    const oy = ty * TILE;
    let su = widen(su0);
    let sv = widen(sv0);
    const ystart = t.y - ((((t.y - oy) % step) + step) % step);
    const xstart = t.x - ((((t.x - ox) % step) + step) % step);
    const blocks = Math.ceil((t.x + t.width - xstart) / step);
    // One block row of samples (as packed pixels), then copied down the rows of the block.
    const words = ch === 4 ? new Uint32Array(out.buffer) : null;
    const rowVals = new Float64Array(blocks);
    const rowSet = new Uint8Array(blocks);
    for (let y = ystart; y < t.y + t.height; y += step) {
      const Y = y + step / 2;
      let anyInRow = false;
      for (let bi = 0, x = xstart; bi < blocks; bi++, x += step) {
        rowSet[bi] = 0;
        const X = x + step / 2;
        const w = inv[6] * X + inv[7] * Y + inv[8];
        if (front !== 0 && front * w <= 0) continue;
        const u = (inv[0] * X + inv[1] * Y + inv[2]) / w - 0.5;
        const v = (inv[3] * X + inv[4] * Y + inv[5]) / w - 0.5;
        if (!(u >= sx0 - margin && v >= sy0 - margin && u <= sx1 + margin && v <= sy1 + margin)) continue;
        if (!affine && interp === 'bicubic') {
          const s = inverseStretch(inv, X, Y);
          su = widen(s[0]);
          sv = widen(s[1]);
        }
        sample(win, interp, u, v, su, sv, acc);
        if (!store(scratch, 0, acc, ch, def)) continue;
        rowSet[bi] = 1;
        rowVals[bi] = ch === 4 ? scratchWord[0] : scratch[0];
        anyInRow = true;
      }
      if (!anyInRow) continue;
      any = true;
      const y0 = Math.max(y, t.y);
      const y1 = Math.min(y + step, t.y + t.height);
      for (let yy = y0; yy < y1; yy++) {
        const row = (yy - oy) * TILE - ox;
        for (let bi = 0, x = xstart; bi < blocks; bi++, x += step) {
          if (!rowSet[bi]) continue;
          const x0 = Math.max(x, t.x);
          const x1 = Math.min(x + step, t.x + t.width);
          const val = rowVals[bi];
          if (words) for (let xx = x0; xx < x1; xx++) words[row + xx] = val;
          else for (let xx = x0; xx < x1; xx++) out[row + xx] = val;
        }
      }
    }
    if (!any) continue;
    const tile = finishTile(out, ch, def);
    if (tile) tiles.set(tileKey(tx, ty), tile);
  }
  return assemble(src, tiles);
}

// ---------------------------------------------------------------------------
// Mesh warps (any forward map)
// ---------------------------------------------------------------------------

/** Grid cell size (source px) used to approximate the map. */
const CELL = 4;
/** Most cells along one axis (bounds memory and time on huge layers). */
const MAX_CELLS = 512;
/** Most subsamples per axis when a warp shrinks the source. */
const MAX_SS = 8;

/**
 * The surface's content inside `options.source` (default: all of it) warped through the forward
 * map `f` (source → destination pixel space; `null` where it is undefined).
 *
 * The source rectangle is subdivided into a fine grid whose vertices are mapped forward; each
 * cell's two triangles are rasterized in destination space with the source position interpolated
 * barycentrically, then the source is sampled there. Cells are a few source pixels across, so the
 * piecewise-affine inverse is within a small fraction of a pixel of the true one; affine maps (the
 * identity included) are reproduced exactly. Where the warp shrinks the source, each pixel instead
 * averages a grid of bilinear subsamples over its source footprint, so thin lines don't alias.
 * Where the warp folds over itself the later (lower-right) cell wins.
 */
export function warpSurface(src: TiledSurface, f: (p: Vec2) => Vec2 | null, options: ResampleOptions = {}): TiledSurface {
  const interp = options.interpolation ?? 'bicubic';
  const ch = src.channels;
  const def = src.defaultValue;
  const empty = emptySurface(ch, def);
  const sr = options.source ? intersect(options.source, options.source) : contentBounds(src);
  if (!sr) return empty;
  const step = normalizeStep(options.step);
  const nx = Math.min(MAX_CELLS, Math.max(1, Math.ceil(sr.width / CELL)));
  const ny = Math.min(MAX_CELLS, Math.max(1, Math.ceil(sr.height / CELL)));
  const w1 = nx + 1;
  // Forward-mapped vertices: destination x, y and source x, y.
  const dvx = new Float64Array(w1 * (ny + 1));
  const dvy = new Float64Array(w1 * (ny + 1));
  const svx = new Float64Array(w1 * (ny + 1));
  const svy = new Float64Array(w1 * (ny + 1));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const k = j * w1 + i;
      const sx = sr.x + (sr.width * i) / nx;
      const sy = sr.y + (sr.height * j) / ny;
      const d = f({ x: sx, y: sy });
      if (!d || !Number.isFinite(d.x) || !Number.isFinite(d.y)) return empty;
      dvx[k] = d.x;
      dvy[k] = d.y;
      svx[k] = sx;
      svy[k] = sy;
      if (d.x < x0) x0 = d.x;
      if (d.y < y0) y0 = d.y;
      if (d.x > x1) x1 = d.x;
      if (d.y > y1) y1 = d.y;
    }
  }
  const lim = 1 << 20;
  const bx0 = Math.floor(Math.max(-lim, x0)) - 1;
  const by0 = Math.floor(Math.max(-lim, y0)) - 1;
  const full = { x: bx0, y: by0, width: Math.ceil(Math.min(lim, x1)) + 1 - bx0, height: Math.ceil(Math.min(lim, y1)) + 1 - by0 };
  const dst = options.clip ? intersect(full, options.clip) : full;
  if (!dst) return empty;
  if (!options.clip) checkBudget(dst);
  // Triangles (vertex indices, in draw order), binned per destination tile.
  const triCount = nx * ny * 2;
  const tris = new Int32Array(triCount * 3);
  for (let j = 0, t = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * w1 + i;
      tris[t++] = a;
      tris[t++] = a + 1;
      tris[t++] = a + w1 + 1;
      tris[t++] = a;
      tris[t++] = a + w1 + 1;
      tris[t++] = a + w1;
    }
  }
  const tx0 = Math.floor(dst.x / TILE);
  const ty0 = Math.floor(dst.y / TILE);
  const cols = Math.floor((dst.x + dst.width - 1) / TILE) - tx0 + 1;
  const rows = Math.floor((dst.y + dst.height - 1) / TILE) - ty0 + 1;
  const bins: number[][] = Array.from({ length: cols * rows }, () => []);
  for (let k = 0; k < triCount; k++) {
    const a = tris[3 * k];
    const b = tris[3 * k + 1];
    const c = tris[3 * k + 2];
    const tminx = Math.floor(Math.min(dvx[a], dvx[b], dvx[c]));
    const tminy = Math.floor(Math.min(dvy[a], dvy[b], dvy[c]));
    const tmaxx = Math.ceil(Math.max(dvx[a], dvx[b], dvx[c]));
    const tmaxy = Math.ceil(Math.max(dvy[a], dvy[b], dvy[c]));
    const cx0 = Math.max(0, Math.floor(Math.max(tminx, dst.x) / TILE) - tx0);
    const cy0 = Math.max(0, Math.floor(Math.max(tminy, dst.y) / TILE) - ty0);
    const cx1 = Math.min(cols - 1, Math.floor(Math.min(tmaxx, dst.x + dst.width - 1) / TILE) - tx0);
    const cy1 = Math.min(rows - 1, Math.floor(Math.min(tmaxy, dst.y + dst.height - 1) / TILE) - ty0);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) bins[cy * cols + cx].push(k);
  }
  const tiles = new Map<TileKey, Tile>();
  const acc = new Float64Array(4);
  const one = new Float64Array(4);
  const n = ch === 4 ? 4 : 2;
  const count = (jx: number, jy: number) => (interp === 'nearest' ? 1 : Math.min(MAX_SS, Math.max(1, Math.round(Math.hypot(jx, jy)))));
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const list = bins[cy * cols + cx];
      if (!list.length) continue;
      const ttx = tx0 + cx;
      const tty = ty0 + cy;
      const t = intersect({ x: ttx * TILE, y: tty * TILE, width: TILE, height: TILE }, dst);
      if (!t) continue;
      const tw = t.width;
      const th = t.height;
      // Source position per destination pixel (NaN = not covered) and the triangle it came from.
      const us = new Float64Array(tw * th).fill(NaN);
      const vs = new Float64Array(tw * th);
      const owner = new Int32Array(tw * th);
      // Per triangle: the inverse map's Jacobian (source step per destination pixel along x and y) and subsample counts.
      const jac = new Float64Array(list.length * 4);
      const ssx = new Int32Array(list.length);
      const ssy = new Int32Array(list.length);
      for (let li = 0; li < list.length; li++) {
        const k = list[li];
        const a = tris[3 * k];
        const b = tris[3 * k + 1];
        const c = tris[3 * k + 2];
        const p0x = dvx[a];
        const p0y = dvy[a];
        const p1x = dvx[b];
        const p1y = dvy[b];
        const p2x = dvx[c];
        const p2y = dvy[c];
        const det = (p1x - p0x) * (p2y - p0y) - (p2x - p0x) * (p1y - p0y);
        ssx[li] = 1;
        ssy[li] = 1;
        if (Math.abs(det) < 1e-12) continue;
        const d1x = svx[b] - svx[a];
        const d1y = svy[b] - svy[a];
        const d2x = svx[c] - svx[a];
        const d2y = svy[c] - svy[a];
        const l1x = (p2y - p0y) / det;
        const l1y = (p0x - p2x) / det;
        const l2x = (p0y - p1y) / det;
        const l2y = (p1x - p0x) / det;
        // Capped, so a sliver triangle can't ask for an unbounded footprint.
        const cap = (vx: number, vy: number): [number, number] => {
          const l = Math.hypot(vx, vy);
          return l > MAX_SS ? [(vx * MAX_SS) / l, (vy * MAX_SS) / l] : [vx, vy];
        };
        const jx = cap(l1x * d1x + l2x * d2x, l1x * d1y + l2x * d2y);
        const jy = cap(l1y * d1x + l2y * d2x, l1y * d1y + l2y * d2y);
        const cnx = count(jx[0], jx[1]);
        const cny = count(jy[0], jy[1]);
        if (cnx * cny > 1) {
          jac[li * 4] = jx[0];
          jac[li * 4 + 1] = jx[1];
          jac[li * 4 + 2] = jy[0];
          jac[li * 4 + 3] = jy[1];
          ssx[li] = cnx;
          ssy[li] = cny;
        }
        const rx0 = Math.max(t.x, Math.floor(Math.min(p0x, p1x, p2x) - 0.5));
        const ry0 = Math.max(t.y, Math.floor(Math.min(p0y, p1y, p2y) - 0.5));
        const rx1 = Math.min(t.x + tw, Math.ceil(Math.max(p0x, p1x, p2x) + 0.5));
        const ry1 = Math.min(t.y + th, Math.ceil(Math.max(p0y, p1y, p2y) + 0.5));
        const eps = -1e-9;
        // A preview rasterizes only each block's first pixel (blocks are aligned to the tile).
        const ay0 = step === 1 ? ry0 : ry0 + ((((t.y - ry0) % step) + step) % step);
        const ax0 = step === 1 ? rx0 : rx0 + ((((t.x - rx0) % step) + step) % step);
        for (let y = ay0; y < ry1; y += step) {
          const py = y + 0.5;
          for (let x = ax0; x < rx1; x += step) {
            const px = x + 0.5;
            const l1 = ((px - p0x) * (p2y - p0y) - (p2x - p0x) * (py - p0y)) / det;
            const l2 = ((p1x - p0x) * (py - p0y) - (px - p0x) * (p1y - p0y)) / det;
            const l0 = 1 - l1 - l2;
            if (l0 < eps || l1 < eps || l2 < eps) continue;
            const o = (y - t.y) * tw + (x - t.x);
            us[o] = l0 * svx[a] + l1 * svx[b] + l2 * svx[c];
            vs[o] = l0 * svy[a] + l1 * svy[b] + l2 * svy[c];
            owner[o] = li;
          }
        }
      }
      // Source footprint of the covered pixels, including the spread of their subsamples.
      let fx0 = Infinity;
      let fy0 = Infinity;
      let fx1 = -Infinity;
      let fy1 = -Infinity;
      for (let o = 0; o < us.length; o++) {
        const u = us[o];
        if (Number.isNaN(u)) continue;
        const li = owner[o];
        const ex = 0.5 * (Math.abs(jac[li * 4]) + Math.abs(jac[li * 4 + 2]));
        const ey = 0.5 * (Math.abs(jac[li * 4 + 1]) + Math.abs(jac[li * 4 + 3]));
        if (u - ex < fx0) fx0 = u - ex;
        if (vs[o] - ey < fy0) fy0 = vs[o] - ey;
        if (u + ex > fx1) fx1 = u + ex;
        if (vs[o] + ey > fy1) fy1 = vs[o] + ey;
      }
      if (fx0 > fx1) continue;
      const foot = intersect({ x: Math.floor(fx0) - 3, y: Math.floor(fy0) - 3, width: Math.ceil(fx1) - Math.floor(fx0) + 6, height: Math.ceil(fy1) - Math.floor(fy0) + 6 }, sr);
      if (!foot || !hasTilesIn(src, foot)) continue;
      const win = readWindow(src, sr, foot);
      const out = new Uint8ClampedArray(TILE * TILE * ch);
      if (def) out.fill(def);
      let any = false;
      const ox = ttx * TILE;
      const oy = tty * TILE;
      const pointAt = (o: number, into: Float64Array) => {
        const li = owner[o];
        const cnx = ssx[li];
        const cny = ssy[li];
        if (cnx * cny === 1) {
          sample(win, interp, us[o] - 0.5, vs[o] - 0.5, 1, 1, into);
          return;
        }
        for (let c = 0; c < n; c++) into[c] = 0;
        const j0 = jac[li * 4];
        const j1 = jac[li * 4 + 1];
        const j2 = jac[li * 4 + 2];
        const j3 = jac[li * 4 + 3];
        for (let sy = 0; sy < cny; sy++) {
          const tt = (sy + 0.5) / cny - 0.5;
          for (let sx = 0; sx < cnx; sx++) {
            const s = (sx + 0.5) / cnx - 0.5;
            sample(win, 'bilinear', us[o] + s * j0 + tt * j2 - 0.5, vs[o] + s * j1 + tt * j3 - 0.5, 1, 1, one);
            for (let c = 0; c < n; c++) into[c] += one[c];
          }
        }
        const k = 1 / (cnx * cny);
        for (let c = 0; c < n; c++) into[c] *= k;
      };
      if (step === 1) {
        for (let o = 0; o < us.length; o++) {
          if (Number.isNaN(us[o])) continue;
          pointAt(o, acc);
          const x = t.x + (o % tw);
          const y = t.y + Math.floor(o / tw);
          if (store(out, ((y - oy) * TILE + (x - ox)) * ch, acc, ch, def)) any = true;
        }
      } else {
        // Preview: the sample at each block's first pixel fills the block.
        for (let by = 0; by < th; by += step) {
          for (let bx = 0; bx < tw; bx += step) {
            const o = by * tw + bx;
            if (Number.isNaN(us[o])) continue;
            pointAt(o, acc);
            const first = ((t.y + by - oy) * TILE + (t.x + bx - ox)) * ch;
            if (!store(out, first, acc, ch, def)) continue;
            any = true;
            for (let yy = by; yy < Math.min(th, by + step); yy++) {
              const row = ((t.y + yy - oy) * TILE + (t.x - ox)) * ch;
              for (let xx = bx; xx < Math.min(tw, bx + step); xx++) for (let c = 0; c < ch; c++) out[row + xx * ch + c] = out[first + c];
            }
          }
        }
      }
      if (!any) continue;
      const tile = finishTile(out, ch, def);
      if (tile) tiles.set(tileKey(ttx, tty), tile);
    }
  }
  return assemble(src, tiles);
}

// ---------------------------------------------------------------------------
// Compositing a moved region back
// ---------------------------------------------------------------------------

/**
 * `top` (RGBA, straight alpha) composited over `base` with the Normal blend. A one-channel `base`
 * (a mask) takes `top`'s red channel as the value, weighted by its alpha: that is how a moved part
 * of a mask travels (value and coverage) and lands. Only tiles `top` stores are touched, so every
 * other tile of `base` stays shared.
 */
export function compositeSurfaceOver(base: TiledSurface, top: TiledSurface): TiledSurface {
  if (top.channels !== 4) throw new Error('compositeSurfaceOver: top must be RGBA');
  if (!top.tiles.size) return base;
  const ch = base.channels;
  const tiles = new Map(base.tiles);
  for (const [key, t] of top.tiles) {
    const under = base.tiles.get(key);
    if (!under && ch === 4) {
      tiles.set(key, t);
      continue;
    }
    const d = new Uint8ClampedArray(TILE * TILE * ch);
    if (under) d.set(under.data);
    else if (base.defaultValue) d.fill(base.defaultValue);
    const s = t.data;
    if (ch === 4) {
      for (let i = 0; i < d.length; i += 4) {
        const ta = s[i + 3] / 255;
        if (ta <= 0) continue;
        if (ta >= 1) {
          d[i] = s[i];
          d[i + 1] = s[i + 1];
          d[i + 2] = s[i + 2];
          d[i + 3] = 255;
          continue;
        }
        const da = d[i + 3] / 255;
        const oa = ta + da * (1 - ta);
        for (let c = 0; c < 3; c++) d[i + c] = (s[i + c] * ta + d[i + c] * da * (1 - ta)) / oa;
        d[i + 3] = oa * 255;
      }
    } else {
      for (let p = 0, i = 0; p < d.length; p++, i += 4) {
        const ta = s[i + 3] / 255;
        if (ta > 0) d[p] = s[i] * ta + d[p] * (1 - ta);
      }
    }
    const tile = finishTile(d, ch, base.defaultValue);
    if (tile) tiles.set(key, tile);
    else tiles.delete(key);
  }
  return new TiledSurface(ch, tiles, base.defaultValue);
}
