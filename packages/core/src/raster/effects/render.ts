// Portions ported from photocraft-main/crates/compose/src/effects.rs and fill_layout.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * CPU renderer for layer effects.
 *
 * Render order, bottom to top (Photoshop's layer-style stack read upwards): drop shadows, outer
 * glows, then the layer itself (content at fill opacity) with pattern, gradient and colour
 * overlays, satin, inner glows, inner shadows, the inside part of strokes and inner bevels on
 * top. The outside part of strokes and outer bevels go beneath the layer, onto the backdrop.
 * Exterior effects blend straight into the backdrop with their own modes; the layer blends with
 * its mode and, in a mode other than Normal, is merged into the backdrop before the interior
 * effects paint over it (Photoshop's "Blend Interior Effects as Group" off). Emboss and pillow
 * emboss then shade the composited result. Layer opacity applies to the whole stack; fill
 * opacity only to the layer's own pixels.
 *
 * Every map depends only on the layer's shape (its alpha after the mask), the effect settings
 * and the global light, never on the backdrop. {@link buildEffectMaps} computes them once over the
 * layer's whole region; {@link compositeLayerEffects} paints any part of that region (a tile) from
 * them, pixel by pixel, so a tiled render equals a whole-image render.
 *
 * Distances: a stroke's outer edge uses the 5 × 5 chamfer below 20 px and an exact Euclidean
 * transform from there (the chamfer's octagonal level sets facet wide strokes); inside strokes and
 * spread / choke keep the chamfer; precise glows and chiselled bevels use the exact transform.
 * Soft falloffs are two box blurs (a tent).
 */

import { blendChannel, blendRgb, isSeparableBlendMode, type BlendMode } from '../blend';
import { curveLut } from '../curve';
import {
  effectsScale,
  hasActiveEffects,
  parseEffectColor,
  scaleLayerEffect,
  MAX_EFFECT_REACH,
  type BevelEmbossEffect,
  type EffectContour,
  type EffectFill,
  type EffectGradient,
  type EffectPatternRef,
  type GlobalLight,
  type GradientStyle,
  type InnerGlowEffect,
  type LayerEffect,
  type LayerEffects,
  type OuterGlowEffect,
  type StrokeEffect,
} from './model';
import { hashNoise, PatternPlacement, PatternTile } from './patterns';

export interface EffectRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Alpha above which a pixel belongs to the layer's shape (half an 8-bit step). */
const INSIDE_EPS = 0.5 / 255;
const INF = 1e20;
const FAR = 1e9;
/** Outside stroke width from which the outer edge uses the exact Euclidean transform. */
export const STROKE_CHAMFER_MAX = 20;
/** Height below which an outer bevel pixel is off the bevel. */
const BEVEL_H_EPS = 1e-5;

interface FMap {
  w: number;
  h: number;
  v: Float32Array;
}

const fmap = (w: number, h: number, fill = 0): FMap => {
  const v = new Float32Array(w * h);
  if (fill) v.fill(fill);
  return { w, h, v };
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

function mapGet(m: FMap, x: number, y: number): number {
  return x < 0 || y < 0 || x >= m.w || y >= m.h ? 0 : m.v[y * m.w + x];
}

/** Bilinear shifted copy; reads outside the map give `outside`. */
function shifted(m: FMap, dx: number, dy: number, outside: number): FMap {
  const reach = (d: number) => (Number.isFinite(d) ? clamp(d, -1e9, 1e9) : 0);
  dx = reach(dx);
  dy = reach(dy);
  const fx = Math.floor(dx);
  const fy = Math.floor(dy);
  const ax = dx - fx;
  const ay = dy - fy;
  const { w, h, v } = m;
  const s = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? outside : v[y * w + x]);
  const out = fmap(w, h);
  for (let y = 0; y < h; y++) {
    const sy = y - fy;
    for (let x = 0; x < w; x++) {
      const sx = x - fx;
      const top = s(sx, sy) * (1 - ax) + s(sx - 1, sy) * ax;
      const bot = s(sx, sy - 1) * (1 - ax) + s(sx - 1, sy - 1) * ax;
      out.v[y * w + x] = top * (1 - ay) + bot * ay;
    }
  }
  return out;
}

function mapped(m: FMap, f: (v: number) => number): FMap {
  const out = fmap(m.w, m.h);
  for (let i = 0; i < m.v.length; i++) out.v[i] = f(m.v[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Distance transforms
// ---------------------------------------------------------------------------

/** 1D squared distance transform (Felzenszwalb & Huttenlocher) with the nearest site. */
function dt1(f: Float64Array, n: number, out: Float64Array, near: Int32Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    for (;;) {
      const p = v[k];
      const s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s <= z[k] && k > 0) {
        k--;
        continue;
      }
      if (s <= z[k]) {
        v[0] = q;
        z[0] = -Infinity;
        z[1] = Infinity;
        break;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
      break;
    }
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    const d = q - p;
    out[q] = d * d + f[p];
    near[q] = p;
  }
}

/** Exact Euclidean distance from every pixel to the nearest `inside` pixel, plus that pixel's index. */
function edtNearest(inside: Uint8Array, w: number, h: number): { d: Float32Array; near: Int32Array } {
  const total = w * h;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const o = new Float64Array(n);
  const nr = new Int32Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  // Columns first: gc[x * h + y], nc = nearest row.
  const gc = new Float64Array(total);
  const nc = new Int32Array(total);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = inside[y * w + x] ? 0 : INF;
    dt1(f, h, o, nr, v, z);
    for (let y = 0; y < h; y++) {
      gc[x * h + y] = o[y];
      nc[x * h + y] = nr[y];
    }
  }
  const d = new Float32Array(total);
  const near = new Int32Array(total);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = gc[x * h + y];
    dt1(f, w, o, nr, v, z);
    for (let x = 0; x < w; x++) {
      d[y * w + x] = Math.sqrt(o[x]);
      const px = nr[x];
      near[y * w + x] = nc[px * h + y] * w + px;
    }
  }
  return { d, near };
}

const S2 = Math.SQRT2;
const S5 = 2.236068;
const FWD: ReadonlyArray<readonly [number, number, number]> = [
  [-1, 0, 1],
  [-1, -1, S2],
  [0, -1, 1],
  [1, -1, S2],
  [-1, -2, S5],
  [1, -2, S5],
  [-2, -1, S5],
  [2, -1, S5],
];

/**
 * Chamfer distance with a 5 × 5 mask of exact step lengths (1, √2, √5) from per-pixel start
 * values (`INF` = not a seed): the minimum over seeds of start + path length. Photoshop's effect
 * distances follow this metric.
 */
function chamferFrom(d: Float32Array, w: number, h: number): Float32Array {
  const ox = FWD.map((f) => f[0]);
  const oy = FWD.map((f) => f[1]);
  const wt = FWD.map((f) => f[2]);
  const k = FWD.length;
  for (let pass = 0; pass < 2; pass++) {
    const sign = pass === 0 ? 1 : -1;
    for (let yy = 0; yy < h; yy++) {
      const y = pass === 0 ? yy : h - 1 - yy;
      for (let xx = 0; xx < w; xx++) {
        const x = pass === 0 ? xx : w - 1 - xx;
        const i = y * w + x;
        let best = d[i];
        for (let j = 0; j < k; j++) {
          const nx = x + ox[j] * sign;
          const ny = y + oy[j] * sign;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const c = d[ny * w + nx] + wt[j];
          if (c < best) best = c;
        }
        d[i] = best;
      }
    }
  }
  return d;
}

/**
 * Distance from each pixel centre outside the shape to its edge; the edge inside the nearest
 * covered pixel is placed by its coverage. Inside pixels get -0.5.
 */
function distOutside(s: FMap, chamfer: boolean): Float32Array {
  const { w, h, v } = s;
  const n = v.length;
  const out = new Float32Array(n);
  if (chamfer) {
    const start = new Float32Array(n);
    for (let i = 0; i < n; i++) start[i] = v[i] > INSIDE_EPS ? 1 - Math.min(v[i], 1) : INF;
    const d = chamferFrom(start, w, h);
    for (let i = 0; i < n; i++) out[i] = v[i] > INSIDE_EPS ? -0.5 : d[i] - 0.5;
    return out;
  }
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = v[i] > INSIDE_EPS ? 1 : 0;
  const { d, near } = edtNearest(inside, w, h);
  for (let i = 0; i < n; i++) out[i] = inside[i] ? -0.5 : d[i] - 0.5 + (1 - Math.min(v[near[i]], 1));
  return out;
}

/** Alpha relative to its 3 × 3 neighbourhood maximum (edge coverage apart from the fill's own opacity). */
function localCoverage(s: FMap): FMap {
  const out: FMap = { w: s.w, h: s.h, v: new Float32Array(s.v) };
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const a = s.v[y * s.w + x];
      if (a <= INSIDE_EPS) continue;
      let mx = a;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mx = Math.max(mx, mapGet(s, x + dx, y + dy));
      out.v[y * s.w + x] = Math.min(a / mx, 1);
    }
  }
  return out;
}

/** Distance from each pixel centre inside the shape to its edge (-0.5 outside). */
function distInside(s: FMap, chamfer: boolean): Float32Array {
  const { w, h, v } = s;
  const n = v.length;
  const out = new Float32Array(n);
  if (chamfer) {
    // Partly covered edge pixels are seeds starting at their coverage.
    const cov = localCoverage(s);
    const start = new Float32Array(n);
    for (let i = 0; i < n; i++) start[i] = v[i] <= INSIDE_EPS ? 0 : cov.v[i] < 1 - INSIDE_EPS ? cov.v[i] : INF;
    const d = chamferFrom(start, w, h);
    for (let i = 0; i < n; i++) out[i] = v[i] <= INSIDE_EPS ? -0.5 : d[i] - 0.5;
    return out;
  }
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) outside[i] = v[i] <= INSIDE_EPS ? 1 : 0;
  const { d } = edtNearest(outside, w, h);
  for (let i = 0; i < n; i++) out[i] = outside[i] ? -0.5 : d[i] - 0.5;
  return out;
}

/**
 * Signed distances to the shape's edge for chiselled bevels, measured to the straight edge through
 * the nearest edge pixel: the edge's normal is the coverage gradient there and its position the
 * pixel's coverage. Distances to pixel centres (the plain transforms) band along their Voronoi
 * cells, which a chisel's lighting shows as streaks; the edge line keeps a facet planar along an
 * anti-aliased edge. Beyond `reach` the plain distances are used. `din` is ≤ -0.5 outside the
 * shape, `dout` ≤ -0.5 inside it (with partly covered pixels between).
 */
function edgeDistances(s: FMap, reach: number): { din: Float32Array; dout: Float32Array } {
  const { w, h, v } = s;
  const n = v.length;
  const edge = new Uint8Array(n);
  const inside = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = v[i];
      if (a <= INSIDE_EPS) continue;
      inside[i] = 1;
      if (a < 1 - INSIDE_EPS || mapGet(s, x - 1, y) <= INSIDE_EPS || mapGet(s, x + 1, y) <= INSIDE_EPS || mapGet(s, x, y - 1) <= INSIDE_EPS || mapGet(s, x, y + 1) <= INSIDE_EPS) edge[i] = 1;
    }
  }
  const { d, near } = edtNearest(edge, w, h);
  const din = new Float32Array(n);
  const dout = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const q = near[i];
      let sd: number;
      if (d[i] > reach || d[i] >= INF / 2) {
        // Far from the edge: plain distance to the nearest edge pixel's centre.
        sd = inside[i] ? -(d[i] + 0.5) : d[i] - 0.5;
      } else {
        const qx = q % w;
        const qy = (q - qx) / w;
        // Outward normal: against the coverage gradient (Sobel) at the edge pixel.
        const g = (dx: number, dy: number) => mapGet(s, qx + dx, qy + dy);
        let nx = -(g(1, -1) + 2 * g(1, 0) + g(1, 1) - g(-1, -1) - 2 * g(-1, 0) - g(-1, 1));
        let ny = -(g(-1, 1) + 2 * g(0, 1) + g(1, 1) - g(-1, -1) - 2 * g(0, -1) - g(1, -1));
        const len = Math.hypot(nx, ny);
        if (len > 1e-6) {
          nx /= len;
          ny /= len;
        } else if (d[i] > 0) {
          nx = (x - qx) / d[i];
          ny = (y - qy) / d[i];
        } else {
          nx = 1;
          ny = 0;
        }
        // The edge crosses q at (coverage - ½) along the normal (an axis-aligned edge's offset).
        sd = (x - qx) * nx + (y - qy) * ny - (Math.min(v[q], 1) - 0.5);
      }
      din[i] = inside[i] ? Math.max(-sd, inside[i] && !edge[i] ? 0.5 : -0.5) : -0.5;
      dout[i] = inside[i] && !edge[i] ? -0.5 : Math.max(sd, -0.5);
    }
  }
  return { din, dout };
}

/** Grows the shape by `r` px (anti-aliased, chamfer metric), keeping its soft edge. */
function dilate(s: FMap, r: number): FMap {
  if (!(r > 0)) return s;
  const d = distOutside(s, true);
  const out: FMap = { w: s.w, h: s.h, v: new Float32Array(s.v) };
  for (let i = 0; i < d.length; i++) {
    const o = out.v[i];
    out.v[i] = d[i] < 0 ? Math.min(o + r, 1) : Math.max(o, clamp01(r + 0.5 - d[i]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tent blur (two box passes of a fractional width)
// ---------------------------------------------------------------------------

function boxWidth(w: number): number {
  return Number.isNaN(w) ? 1 : clamp(w, 1, MAX_EFFECT_REACH);
}

/** (r, end-tap weight, 1 / width) of a box of fractional width. */
function boxGeom(bw: number): [number, number, number] {
  bw = boxWidth(bw);
  const half = bw / 2;
  const r = Math.max(0, Math.ceil(half - 0.5));
  const f = clamp01(half - (r - 0.5));
  return [r, f, 1 / bw];
}

/** One box pass over `src` (zero outside it) evaluated at `x0 .. x0 + dst.length`, as a running sum. */
function boxLine(src: Float64Array, x0: number, dst: Float64Array, bw: number): void {
  const n = src.length;
  const [r, f, norm] = boxGeom(bw);
  const at = (i: number) => (i >= 0 && i < n ? src[i] : 0);
  if (r === 0) {
    for (let k = 0; k < dst.length; k++) dst[k] = at(x0 + k);
    return;
  }
  let inner = 0;
  for (let i = x0 - (r - 1); i <= x0 + (r - 1); i++) inner += at(i);
  for (let k = 0; k < dst.length; k++) {
    const x = x0 + k;
    dst[k] = (inner + f * (at(x - r) + at(x + r))) * norm;
    inner += at(x + r) - at(x - r + 1);
  }
}

/** Values a running-sum blur leaves where it should be zero (float residue) are flushed below this. */
const BLUR_EPS = 1e-7;

function tentLine(src: Float64Array, dst: Float64Array, bw: number, mid: Float64Array): void {
  const [r] = boxGeom(bw);
  boxLine(src, -r, mid.subarray(0, src.length + 2 * r), bw);
  boxLine(mid.subarray(0, src.length + 2 * r), r, dst, bw);
  // The running sum is not exactly zero after it passes a shape: flush the residue so it never
  // reads as coverage (noise would speckle it far from the shape).
  for (let i = 0; i < dst.length; i++) if (Math.abs(dst[i]) < BLUR_EPS) dst[i] = 0;
}

/** Two box passes of width `w` along each axis, zero outside the map. */
function tent(m: FMap, w: number): void {
  if (!Number.isFinite(w) || m.v.length === 0) return;
  // A box of radius 0 is the identity.
  if (boxGeom(w)[0] === 0) return;
  const { w: mw, h: mh } = m;
  const r = boxGeom(w)[0];
  const mid = new Float64Array(Math.max(mw, mh) + 2 * r);
  const row = new Float64Array(mw);
  const rowOut = new Float64Array(mw);
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) row[x] = m.v[y * mw + x];
    tentLine(row, rowOut, w, mid);
    for (let x = 0; x < mw; x++) m.v[y * mw + x] = rowOut[x];
  }
  const col = new Float64Array(mh);
  const colOut = new Float64Array(mh);
  for (let x = 0; x < mw; x++) {
    for (let y = 0; y < mh; y++) col[y] = m.v[y * mw + x];
    tentLine(col, colOut, w, mid);
    for (let y = 0; y < mh; y++) m.v[y * mw + x] = colOut[y];
  }
}

function blur(m: FMap, size: number): void {
  if (Number.isFinite(size)) tent(m, size);
}

// ---------------------------------------------------------------------------
// Contours
// ---------------------------------------------------------------------------

const lutCache = new WeakMap<EffectContour, Float32Array | null>();

/** A contour as a 0..1 LUT (corner points split the spline), or `null` for linear. */
export function contourLut(c: EffectContour | undefined): Float32Array | null {
  if (!c) return null;
  const cached = lutCache.get(c);
  if (cached !== undefined) return cached;
  const pts = c.points;
  const linear = pts.length === 2 && pts[0].input === 0 && pts[0].output === 0 && pts[1].input === 1 && pts[1].output === 1;
  let lut: Float32Array | null = null;
  if (pts.length >= 2 && !linear) {
    if (!pts.some((p) => p.corner)) lut = curveLut(pts);
    else {
      const sorted = [...pts].sort((a, b) => a.input - b.input);
      let start = 0;
      for (let i = 1; i < sorted.length; i++) {
        if (!(sorted[i].corner || i === sorted.length - 1)) continue;
        const seg = sorted.slice(start, i + 1);
        const from = seg[0].input;
        const part = curveLut(seg);
        if (!lut) lut = part;
        else for (let k = 0; k < part.length; k++) if (k / (part.length - 1) >= from) lut[k] = part[k];
        start = i;
      }
      lut ??= curveLut(pts);
    }
  }
  lutCache.set(c, lut);
  return lut;
}

function lutAt(l: Float32Array, v: number): number {
  const x = clamp01(v) * (l.length - 1);
  const i = Math.floor(x);
  const j = Math.min(i + 1, l.length - 1);
  return l[i] + (l[j] - l[i]) * (x - i);
}

function applyLut(m: FMap, l: Float32Array | null): FMap {
  return l ? mapped(m, (v) => lutAt(l, v)) : m;
}

/** A contour applied over a Range (`contour(min(v / range, 1))`), `null` for the identity. */
function rangedLut(c: EffectContour | undefined, range: number): Float32Array | null {
  const base = contourLut(c);
  const r = Number.isFinite(range) ? clamp(range, 0.01, 1) : 1;
  if (r >= 0.999) return base;
  const n = 4096;
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const v = Math.min(k / (n - 1) / r, 1);
    out[k] = base ? lutAt(base, v) : v;
  }
  return out;
}

/** Satin's transfer: the contour read from its far end, `|c(1 − v) − c(1)|`. */
function satinLut(c: EffectContour | undefined): Float32Array | null {
  const lut = contourLut(c);
  if (!lut) return null;
  const end = lut[lut.length - 1];
  const out = new Float32Array(lut.length);
  for (let k = 0; k < lut.length; k++) out[k] = Math.abs(lut[lut.length - 1 - k] - end);
  return out;
}

/** Monochrome speckle in the coverage (Noise), hashed from document coordinates. */
function noise(m: FMap, amount: number, x0: number, y0: number): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x;
      if (m.v[i] <= BLUR_EPS) continue;
      m.v[i] = clamp01(m.v[i] + (hashNoise(x0 + x, y0 + y) - 0.5) * 2 * amount);
    }
  }
}

/** Offset of an effect lit from `angle` at `distance` (falls away from the light), in whole pixels. */
function lightOffset(angle: number, distance: number): [number, number] {
  const a = (angle * Math.PI) / 180;
  return [Math.round(-Math.cos(a) * distance), Math.round(Math.sin(a) * distance)];
}

/** (dilation radius, blur width) of a spread / choke. */
function spreadSplit(size: number, spread: number): [number, number] {
  return [Math.round(size * spread), size * (1 - spread)];
}

// ---------------------------------------------------------------------------
// Effect maps
// ---------------------------------------------------------------------------

type ShadowLike = { color: string; angle: number; useGlobalLight: boolean; distance: number; size: number; contour?: EffectContour; noise: number };

function shadowMap(shape: FMap, s: ShadowLike, spread: number, light: GlobalLight, inner: boolean, ox: number, oy: number): FMap {
  const angle = s.useGlobalLight ? light.angle : s.angle;
  const [dx, dy] = lightOffset(angle, s.distance);
  const src = inner ? mapped(shape, (a) => 1 - a) : shape;
  let m = shifted(src, dx, dy, inner ? 1 : 0);
  const [r, bw] = spreadSplit(s.size, spread);
  m = dilate(m, r);
  blur(m, bw);
  m = applyLut(m, contourLut(s.contour));
  noise(m, s.noise, ox, oy);
  if (inner) for (let i = 0; i < m.v.length; i++) m.v[i] *= shape.v[i];
  return m;
}

function glowMap(shape: FMap, g: OuterGlowEffect | InnerGlowEffect, ox: number, oy: number): FMap {
  const inner = g.kind === 'inner-glow';
  const spread = inner ? g.choke : g.spread;
  const src = inner ? mapped(shape, (a) => 1 - a) : shape;
  let m: FMap;
  if (g.technique === 'precise') {
    // Coverage falls linearly from 0.5 at the edge to 0 at `size + 1` px, solid within the spread.
    const d = inner ? distInside(shape, false) : distOutside(src, false);
    const solid = g.size * spread;
    const soft = Math.max(g.size + 1 - solid, 1e-3);
    m = fmap(shape.w, shape.h);
    for (let i = 0; i < d.length; i++) {
      const di = d[i] + 0.5;
      m.v[i] = di <= solid ? 1 : 0.5 * clamp01(1 - (di - solid) / soft);
    }
  } else {
    const [r, bw] = spreadSplit(g.size, spread);
    m = dilate(src, r);
    if (m === src || m === shape) m = { w: m.w, h: m.h, v: new Float32Array(m.v) };
    blur(m, bw);
  }
  m = applyLut(m, rangedLut(g.contour, g.range));
  if (inner && g.source === 'center') m = mapped(m, (v) => 1 - v);
  noise(m, g.noise, ox, oy);
  if (inner) for (let i = 0; i < m.v.length; i++) m.v[i] *= shape.v[i];
  return m;
}

function satinMap(shape: FMap, s: { angle: number; distance: number; size: number; invert: boolean; contour?: EffectContour }): FMap {
  const [dx, dy] = lightOffset(s.angle, Math.max(1, s.distance));
  const a = shifted(shape, dx, dy, 0);
  const b = shifted(shape, -dx, -dy, 0);
  tent(a, s.size);
  tent(b, s.size);
  let m = fmap(shape.w, shape.h);
  for (let i = 0; i < m.v.length; i++) m.v[i] = Math.abs(a.v[i] - b.v[i]);
  if (s.invert) m = mapped(m, (v) => 1 - v);
  m = applyLut(m, satinLut(s.contour));
  for (let i = 0; i < m.v.length; i++) m.v[i] *= shape.v[i];
  return m;
}

/** Where a bevel paints: inside the shape, outside it, or both (emboss styles). */
type BevelPaint = 'inner' | 'outer' | 'both';

interface BevelGeom {
  paint: BevelPaint;
  width: number;
  depth: number;
  pillow: boolean;
  chiselSoft: number;
}

function bevelGeom(b: BevelEmbossEffect): BevelGeom {
  const size = Math.max(b.size, 1);
  const emboss = b.style === 'emboss' || b.style === 'pillow-emboss';
  const paint: BevelPaint = b.style === 'outer-bevel' ? 'outer' : emboss ? 'both' : 'inner';
  // Emboss styles straddle the edge with half the size, rounded up to whole pixels.
  const width = emboss ? Math.ceil(size / 2) : size;
  const smooth = b.technique === 'smooth';
  const sign = b.direction === 'up' ? 1 : -1;
  return {
    paint,
    width,
    depth: b.depth * (smooth ? width : size / 2) * sign,
    pillow: b.style === 'pillow-emboss',
    chiselSoft: b.technique === 'chisel-soft' ? Math.max(size / 4, 1) : 0,
  };
}

/** Chiselled height from the inside / outside distances. */
function bevelChiselH(paint: BevelPaint, size: number, din: number, dout: number, soft: boolean): number {
  const ramp = size + 1;
  if (paint === 'outer' && !soft) {
    const top = (size + 2) / ramp;
    return dout > 0 ? clamp((size + 1.5 - dout) / ramp, 0, top) : top;
  }
  if (paint === 'outer') return dout > 0 ? 1 - clamp01((dout + 0.5) / ramp) : (size + 2) / ramp;
  if (paint === 'both') {
    const half = size / 2 + 0.5;
    return din > 0 ? 0.5 + 0.5 * clamp01(din / half) : 0.5 - 0.5 * clamp01(dout / half);
  }
  if (soft) return din > 0 ? clamp((din + 1.5) / ramp, 0, (size + 2) / ramp) : 0;
  return din > 0 ? clamp01((din + 0.5) / ramp) : 0;
}

export interface EffectContext {
  light: GlobalLight;
  /** A pattern tile by id, or `null` when missing (pattern effects then paint nothing). */
  pattern(id: string): PatternTile | null;
}

function bevelHeight(shape: FMap, b: BevelEmbossEffect, g: BevelGeom, rect: EffectRect, anchor: { x: number; y: number }, ctx: EffectContext): FMap {
  const size = Math.max(b.size, 1);
  let h: FMap;
  if (b.technique === 'smooth') {
    h = { w: shape.w, h: shape.h, v: new Float32Array(shape.v) };
    tent(h, g.width);
  } else {
    const { din, dout } = edgeDistances(shape, size + 2);
    h = fmap(shape.w, shape.h);
    const soft = g.chiselSoft > 0;
    for (let i = 0; i < h.v.length; i++) h.v[i] = bevelChiselH(g.paint, size, din[i], dout[i], soft);
    if (soft && g.paint === 'both') tent(h, g.chiselSoft);
  }
  if (b.contourElement) h = applyLut(h, contourLut(b.contourElement.contour) ?? identityLut());
  const t = b.texture;
  const tile = t ? ctx.pattern(t.patternId) : null;
  if (t && tile) {
    const unit = Math.abs(b.depth) > 1e-6 ? Math.max(Math.abs(g.depth / b.depth), 1e-3) : Math.max(g.width, 1);
    const place = new PatternPlacement(anchor, t.link ?? true, t.phase ?? { x: 0, y: 0 }, t.scale, 0);
    const k = t.depth / unit;
    const uv = [0, 0];
    const p = [0, 0, 0, 0];
    for (let y = 0; y < h.h; y++) {
      for (let x = 0; x < h.w; x++) {
        place.map(rect.x + x + 0.5, rect.y + y + 0.5, uv);
        tile.sample(uv[0], uv[1], p);
        const l = (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) * p[3];
        h.v[y * h.w + x] += k * (t.invert ? 1 - l : l);
      }
    }
  }
  if (b.soften >= 1) tent(h, b.soften);
  return h;
}

let identity: Float32Array | null = null;
function identityLut(): Float32Array {
  if (!identity) {
    identity = new Float32Array(4096);
    for (let k = 0; k < 4096; k++) identity[k] = k / 4095;
  }
  return identity;
}

/** Bevel highlight and shadow maps (`[hi, sh]`) and where they paint. */
function bevelMaps(shape: FMap, b: BevelEmbossEffect, rect: EffectRect, anchor: { x: number; y: number }, ctx: EffectContext): { maps: FMap[]; paint: BevelPaint } {
  const g = bevelGeom(b);
  const hmap = bevelHeight(shape, b, g, rect, anchor, ctx);
  const angle = b.useGlobalLight ? ctx.light.angle : b.angle;
  const altitude = b.useGlobalLight ? ctx.light.altitude : b.altitude;
  const sa = Math.sin((angle * Math.PI) / 180);
  const ca = Math.cos((angle * Math.PI) / 180);
  const se = Math.sin((altitude * Math.PI) / 180);
  const ce = Math.cos((altitude * Math.PI) / 180);
  const lx = ca * ce;
  const ly = -sa * ce;
  const lz = se;
  const reachPast = g.paint === 'both' || (g.paint === 'outer' && b.technique !== 'smooth');
  const onBevel = (x: number, y: number) =>
    mapGet(hmap, x, y) > BEVEL_H_EPS ||
    (reachPast && (mapGet(hmap, x + 1, y) > BEVEL_H_EPS || mapGet(hmap, x - 1, y) > BEVEL_H_EPS || mapGet(hmap, x, y + 1) > BEVEL_H_EPS || mapGet(hmap, x, y - 1) > BEVEL_H_EPS));
  const gloss = contourLut(b.glossContour);
  const shadeInto = (depth: number, outside: boolean): [FMap, FMap] => {
    const hi = fmap(shape.w, shape.h);
    const sh = fmap(shape.w, shape.h);
    for (let y = 0; y < shape.h; y++) {
      for (let x = 0; x < shape.w; x++) {
        const i = y * shape.w + x;
        const gx = (mapGet(hmap, x + 1, y) - mapGet(hmap, x - 1, y)) * 0.5 * depth;
        const gy = (mapGet(hmap, x, y + 1) - mapGet(hmap, x, y - 1)) * 0.5 * depth;
        const len = Math.sqrt(gx * gx + gy * gy + 1);
        const shade = (-gx * lx - gy * ly + lz) / len;
        const region = outside ? (shape.v[i] < 1 - INSIDE_EPS && onBevel(x, y) ? 1 : 0) : shape.v[i];
        const k = shade - se;
        if (k > 0) hi.v[i] = clamp01(k / Math.max(1 - se, 1e-3)) * region;
        else sh.v[i] = clamp01(-k / Math.max(se, 1e-3)) * region;
      }
    }
    return [applyLut(hi, gloss), applyLut(sh, gloss)];
  };
  if (g.paint !== 'both') {
    const [hi, sh] = shadeInto(g.depth, g.paint === 'outer');
    return { maps: [hi, sh], paint: g.paint };
  }
  // One map per colour over the whole bevel: the inside half where the shape is, the outside half
  // (pillow: facing the other way) for the rest of each pixel.
  const [hi, sh] = shadeInto(g.depth, false);
  const [ho, so] = shadeInto(g.pillow ? -g.depth : g.depth, true);
  const mix = (a: FMap, o: FMap): FMap => {
    const out = fmap(a.w, a.h);
    for (let i = 0; i < out.v.length; i++) {
      const s = shape.v[i];
      out.v[i] = (s > INSIDE_EPS ? a.v[i] : 0) + o.v[i] * (1 - Math.min(s, 1));
    }
    return out;
  };
  return { maps: [mix(hi, ho), mix(sh, so)], paint: 'both' };
}

/** (inside width, outside width) of a stroke. */
function strokeWidths(s: StrokeEffect): [number, number] {
  return s.position === 'outside' ? [0, s.size] : s.position === 'inside' ? [s.size, 0] : [s.size / 2, s.size / 2];
}

/** Effect maps of one layer over its region: see {@link buildEffectMaps}. */
export interface EffectMaps {
  /** The region the maps cover (document space). */
  rect: EffectRect;
  /** The enabled effects, Scale Effects applied, in list order. */
  items: LayerEffect[];
  /** Pixel bounds of the shape (alpha above half a step), or `null` when the shape is empty. */
  bounds: EffectRect | null;
  shape: Float32Array;
  /** Per item: the maps it paints through. */
  per: Float32Array[][];
  bevelPaint: (BevelPaint | null)[];
  din: Float32Array | null;
  dout: Float32Array | null;
  doutExact: Float32Array | null;
  /** Frames of gradient strokes by item index. */
  frames: Map<number, EffectRect>;
  /** Approximate size in bytes (cache budgeting). */
  bytes: number;
}

/** The enabled effects of `effects` with Scale Effects applied (empty when the master switch is off). */
export function activeEffectItems(effects: LayerEffects | undefined | null): LayerEffect[] {
  if (!hasActiveEffects(effects)) return [];
  const s = effectsScale(effects);
  return effects.items.filter((e) => e.enabled).map((e) => scaleLayerEffect(e, s));
}

/**
 * Whether every map pixel of `items` depends only on the shape within the effects' margin, so a
 * tile is unchanged while the layer is unchanged within its margin. Not local: anything laid out
 * over the layer's bounds (aligned gradient overlays, gradient strokes, linked patterns) and noise
 * (it speckles any coverage above zero, which picks up the blur's float noise from far away).
 */
export function effectsAreLocal(items: readonly LayerEffect[]): boolean {
  const linked = (p: EffectPatternRef) => p.link !== false;
  return items.every((e) => {
    switch (e.kind) {
      case 'gradient-overlay':
        return !e.gradient.align;
      case 'pattern-overlay':
        return !linked(e);
      case 'stroke':
        return e.fill.type === 'color' || (e.fill.type === 'pattern' && !linked(e.fill));
      case 'drop-shadow':
      case 'inner-shadow':
      case 'outer-glow':
      case 'inner-glow':
        return e.noise <= 0;
      case 'bevel-emboss':
        return !e.texture || !linked(e.texture);
      default:
        return true;
    }
  });
}

/**
 * Builds every map `items` paints through from the layer's alpha `shape` (0..1) over `rect`.
 * `rect` should cover the layer's shape plus the effects' margin.
 */
export function buildEffectMaps(items: LayerEffect[], shape: Float32Array, rect: EffectRect, ctx: EffectContext): EffectMaps {
  const w = rect.width;
  const h = rect.height;
  const s: FMap = { w, h, v: shape };
  // Shape bounds.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (shape[y * w + x] > INSIDE_EPS) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const bounds = x0 === Infinity ? null : { x: rect.x + x0, y: rect.y + y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  const anchor = bounds ? { x: bounds.x, y: bounds.y } : { x: rect.x, y: rect.y };
  const per: Float32Array[][] = [];
  const bevelPaint: (BevelPaint | null)[] = [];
  const frames = new Map<number, EffectRect>();
  let bytes = shape.byteLength;
  items.forEach((e, i) => {
    let maps: FMap[] = [];
    let paint: BevelPaint | null = null;
    switch (e.kind) {
      case 'drop-shadow':
        maps = [shadowMap(s, e, e.spread, ctx.light, false, rect.x, rect.y)];
        break;
      case 'inner-shadow':
        maps = [shadowMap(s, e, e.choke, ctx.light, true, rect.x, rect.y)];
        break;
      case 'outer-glow':
      case 'inner-glow':
        maps = [glowMap(s, e, rect.x, rect.y)];
        break;
      case 'satin':
        maps = [satinMap(s, e)];
        break;
      case 'bevel-emboss': {
        const r = bevelMaps(s, e, rect, anchor, ctx);
        maps = r.maps;
        paint = r.paint;
        break;
      }
      case 'stroke':
        if (e.fill.type === 'gradient' && bounds) {
          const grow = Math.max(0, Math.ceil(Math.min(strokeWidths(e)[1], MAX_EFFECT_REACH)) - 1);
          frames.set(i, { x: bounds.x - grow, y: bounds.y - grow, width: bounds.width + 2 * grow, height: bounds.height + 2 * grow });
        }
        break;
    }
    per.push(maps.map((m) => m.v));
    bevelPaint.push(paint);
    for (const m of maps) bytes += m.v.byteLength;
  });
  const strokes = items.filter((e): e is StrokeEffect => e.kind === 'stroke');
  const outW = strokes.map((st) => strokeWidths(st)[1]).filter((x) => x > 0);
  const din = strokes.length ? distInside(s, true) : null;
  const dout = outW.some((x) => x < STROKE_CHAMFER_MAX) ? distOutside(s, true) : null;
  const doutExact = outW.some((x) => x >= STROKE_CHAMFER_MAX) ? distOutside(s, false) : null;
  for (const d of [din, dout, doutExact]) if (d) bytes += d.byteLength;
  return { rect, items, bounds, shape, per, bevelPaint, din, dout, doutExact, frames, bytes };
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/** Straight-alpha float RGBA over a rectangle. */
type FBuf = Float32Array;

const rgbScratchB = [0, 0, 0];
const rgbScratchS = [0, 0, 0];

/** Composites straight `src` (alpha `sa`) onto `dst[i..i+3]` with `mode` (the formula `blendTile` uses). */
function compositeAt(dst: FBuf, i: number, mode: BlendMode, separable: boolean, sr: number, sg: number, sb: number, sa: number): void {
  if (!(sa > 0)) return;
  const ab = dst[i + 3];
  const ao = sa + ab * (1 - sa);
  if (ao <= 0) {
    dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0;
    return;
  }
  const b0 = dst[i];
  const b1 = dst[i + 1];
  const b2 = dst[i + 2];
  let m0: number;
  let m1: number;
  let m2: number;
  if (mode === 'normal') {
    m0 = sr;
    m1 = sg;
    m2 = sb;
  } else if (separable) {
    m0 = blendChannel(mode, b0, sr);
    m1 = blendChannel(mode, b1, sg);
    m2 = blendChannel(mode, b2, sb);
  } else {
    rgbScratchB[0] = b0;
    rgbScratchB[1] = b1;
    rgbScratchB[2] = b2;
    rgbScratchS[0] = sr;
    rgbScratchS[1] = sg;
    rgbScratchS[2] = sb;
    const m = blendRgb(mode, rgbScratchB, rgbScratchS);
    m0 = m[0];
    m1 = m[1];
    m2 = m[2];
  }
  const wb = (1 - sa) * ab;
  const ws = (1 - ab) * sa;
  const wm = sa * ab;
  dst[i] = (wb * b0 + ws * sr + wm * m0) / ao;
  dst[i + 1] = (wb * b1 + ws * sg + wm * m1) / ao;
  dst[i + 2] = (wb * b2 + ws * sb + wm * m2) / ao;
  dst[i + 3] = ao;
}

/** Composite `color(i) × coverage` into `dst`. `color` fills `c` with straight RGBA. */
function paint(dst: FBuf, m: ArrayLike<number>, color: (i: number, c: number[]) => void, mode: BlendMode, opacity: number): void {
  const sep = mode !== 'normal' && isSeparableBlendMode(mode);
  const c = [0, 0, 0, 1];
  const n = m.length;
  for (let i = 0; i < n; i++) {
    const a = m[i] * opacity;
    if (!(a > 0)) continue;
    color(i, c);
    compositeAt(dst, i * 4, mode, sep, c[0], c[1], c[2], c[3] * Math.min(a, 1));
  }
}

function rgbOf(hex: string): [number, number, number] {
  return parseEffectColor(hex) ?? [0, 0, 0];
}

function paintColor(dst: FBuf, m: ArrayLike<number>, hex: string, mode: BlendMode, opacity: number): void {
  const [r, g, b] = rgbOf(hex);
  paint(
    dst,
    m,
    (_i, c) => {
      c[0] = r;
      c[1] = g;
      c[2] = b;
      c[3] = 1;
    },
    mode,
    opacity
  );
}

/** Gradient colour + opacity stops prepared for sampling. */
class PreparedGradient {
  private readonly color: Array<[number, number, number, number]>;
  private readonly alpha: Array<[number, number]>;
  constructor(g: EffectGradient) {
    this.color = [...g.stops].sort((a, b) => a.position - b.position).map((s) => [s.position, ...rgbOf(s.color)]);
    this.alpha = [...(g.opacityStops ?? [])].sort((a, b) => a.position - b.position).map((s) => [s.position, s.opacity]);
  }
  sample(t: number, out: number[]): void {
    const c = this.color;
    if (!c.length) {
      out[0] = out[1] = out[2] = t;
    } else if (c.length === 1 || t <= c[0][0]) {
      out[0] = c[0][1];
      out[1] = c[0][2];
      out[2] = c[0][3];
    } else {
      let done = false;
      for (let k = 0; k < c.length - 1; k++) {
        const a = c[k];
        const b = c[k + 1];
        if (t <= b[0]) {
          const f = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
          out[0] = a[1] + (b[1] - a[1]) * f;
          out[1] = a[2] + (b[2] - a[2]) * f;
          out[2] = a[3] + (b[3] - a[3]) * f;
          done = true;
          break;
        }
      }
      if (!done) {
        const l = c[c.length - 1];
        out[0] = l[1];
        out[1] = l[2];
        out[2] = l[3];
      }
    }
    const a = this.alpha;
    if (!a.length) out[3] = 1;
    else if (a.length === 1 || t <= a[0][0]) out[3] = a[0][1];
    else {
      out[3] = a[a.length - 1][1];
      for (let k = 0; k < a.length - 1; k++) {
        if (t <= a[k + 1][0]) {
          const f = a[k + 1][0] > a[k][0] ? (t - a[k][0]) / (a[k + 1][0] - a[k][0]) : 0;
          out[3] = a[k][1] + (a[k + 1][1] - a[k][1]) * f;
          break;
        }
      }
    }
  }
}

/** Lengths a 100 % gradient at `angle` spans in a `w × h` frame: the chord and the ellipse-norm length. */
function gradientUnits(angle: number, w: number, h: number): [number, number] {
  const a = (angle * Math.PI) / 180;
  const s = Math.sin(a);
  const c = Math.cos(a);
  const len = Math.max(Math.sqrt((c * w) ** 2 + (s * h) ** 2), 1);
  const chord = Math.max(Math.min(w / Math.max(Math.abs(c), 1e-6), h / Math.max(Math.abs(s), 1e-6)), 1);
  return [chord, len];
}

/** Gradient parameter `t` (0..1) at pixel centre `(x, y)` of a gradient laid out in `frame`. */
export function gradientT(style: GradientStyle, angle: number, scale: number, reverse: boolean, offset: { x: number; y: number }, frame: EffectRect, x: number, y: number): number {
  const w = Math.max(frame.width, 1);
  const h = Math.max(frame.height, 1);
  const cx = frame.x + w / 2 + offset.x * w;
  const cy = frame.y + h / 2 + offset.y * h;
  const a = (angle * Math.PI) / 180;
  const s = Math.sin(a);
  const c = Math.cos(a);
  const dx = x - cx;
  const dy = y - cy;
  const along = dx * c - dy * s;
  const across = dx * s + dy * c;
  let [chord, len] = gradientUnits(angle, w, h);
  chord *= Math.max(scale, 1e-3);
  len *= Math.max(scale, 1e-3);
  const corner = 0.5 * (c - s);
  let t: number;
  switch (style) {
    case 'linear':
      t = (along - corner) / chord + 0.5;
      break;
    case 'reflected':
      t = Math.abs((along - corner) / (chord / 2));
      break;
    case 'radial':
      t = Math.sqrt(dx * dx + dy * dy) / (len / 2);
      break;
    case 'diamond':
      t = (Math.abs(along) + Math.abs(across)) / (len / 2);
      break;
    case 'angle': {
      const turn = (a - Math.atan2(-dy, dx)) / (2 * Math.PI);
      t = turn - Math.floor(turn);
      break;
    }
  }
  t = clamp01(t);
  return reverse ? 1 - t : t;
}

/** Snaps a linear / reflected gradient's end points to the pixel grid, as Photoshop lays effect gradients out. */
function gradientLayout(style: GradientStyle, angle: number, scale: number, offset: { x: number; y: number }, frame: EffectRect): [number, number, { x: number; y: number }] {
  const unchanged: [number, number, { x: number; y: number }] = [angle, scale, offset];
  if ((style !== 'linear' && style !== 'reflected') || ![angle, scale, offset.x, offset.y].every(Number.isFinite)) return unchanged;
  const w = Math.max(frame.width, 1);
  const h = Math.max(frame.height, 1);
  const cx = frame.x + w / 2 + offset.x * w;
  const cy = frame.y + h / 2 + offset.y * h;
  const chordOf = (r: number) => Math.max(Math.min(w / Math.max(Math.abs(Math.cos(r)), 1e-6), h / Math.max(Math.abs(Math.sin(r)), 1e-6)), 1);
  const a = (angle * Math.PI) / 180;
  const half = (chordOf(a) * Math.max(scale, 1e-3)) / 2;
  const dx = Math.cos(a) * half;
  const dy = -Math.sin(a) * half;
  const snap = (v: number) => Math.floor(v + 1e-4);
  const end = [snap(cx + dx), snap(cy + dy)];
  let start: number[];
  let mid: number[];
  if (style === 'reflected') {
    start = [cx, cy];
    mid = [cx, cy];
  } else {
    start = [snap(cx - dx), snap(cy - dy)];
    mid = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  }
  const v = [end[0] - start[0], end[1] - start[1]];
  const len = Math.hypot(v[0], v[1]);
  if (len < 0.5) return unchanged;
  const a2 = Math.atan2(-v[1], v[0]);
  const span = style === 'reflected' ? 2 * len : len;
  return [(a2 * 180) / Math.PI, span / chordOf(a2), { x: offset.x + (mid[0] - cx) / w, y: offset.y + (mid[1] - cy) / h }];
}

interface PaintEnv {
  rect: EffectRect;
  /** Frame gradients align with (the layer's bounds) and the canvas (unaligned gradients). */
  bounds: EffectRect;
  canvas: EffectRect;
  anchor: { x: number; y: number };
  ctx: EffectContext;
}

function paintGradient(dst: FBuf, m: ArrayLike<number>, g: EffectGradient, frame: EffectRect, env: PaintEnv, mode: BlendMode, opacity: number): void {
  const prepared = new PreparedGradient(g);
  const [angle, scale, offset] = gradientLayout(g.style, g.angle, g.scale, g.offset, frame);
  const { x: rx, y: ry, width: w } = env.rect;
  paint(dst, m, (i, c) => prepared.sample(gradientT(g.style, angle, scale, g.reverse, offset, frame, rx + (i % w) + 0.5, ry + Math.floor(i / w) + 0.5), c), mode, opacity);
}

function paintPattern(dst: FBuf, m: ArrayLike<number>, p: EffectPatternRef, env: PaintEnv, mode: BlendMode, opacity: number): void {
  const tile = env.ctx.pattern(p.patternId);
  if (!tile) return;
  const place = new PatternPlacement(env.anchor, p.link ?? true, p.phase ?? { x: 0, y: 0 }, p.scale, p.angle ?? 0);
  const { x: rx, y: ry, width: w } = env.rect;
  const uv = [0, 0];
  paint(
    dst,
    m,
    (i, c) => {
      place.map(rx + (i % w) + 0.5, ry + Math.floor(i / w) + 0.5, uv);
      tile.sample(uv[0], uv[1], c);
    },
    mode,
    opacity
  );
}

function paintFill(dst: FBuf, m: ArrayLike<number>, f: EffectFill, frame: EffectRect, env: PaintEnv, mode: BlendMode, opacity: number): void {
  if (f.type === 'color') paintColor(dst, m, f.color, mode, opacity);
  else if (f.type === 'gradient') paintGradient(dst, m, f.gradient, f.gradient.align ? frame : env.canvas, env, mode, opacity);
  else paintPattern(dst, m, f, env, mode, opacity);
}

/** A glow's paint: a gradient runs along the glow (colour at `1 − v`), opaque from strength `range²`. */
function paintGlow(dst: FBuf, m: ArrayLike<number>, g: OuterGlowEffect | InnerGlowEffect, env: PaintEnv): void {
  if (g.fill.type === 'color') return paintColor(dst, m, g.fill.color, g.blend, g.opacity);
  const prepared = new PreparedGradient(g.fill.gradient);
  const r = Number.isFinite(g.range) ? clamp(g.range, 0.01, 1) : 1;
  const gain = 1 / (r * r);
  const strength = new Float32Array(m.length);
  for (let i = 0; i < m.length; i++) strength[i] = Math.min(m[i] * gain, 1);
  paint(dst, strength, (i, c) => prepared.sample(1 - clamp01(m[i]), c), g.blend, g.opacity);
}

/** Crops `v` (over `from`) to `to`, filling outside with `fill`. */
function crop(v: Float32Array, from: EffectRect, to: EffectRect, fill: number): Float32Array {
  const out = new Float32Array(to.width * to.height);
  if (fill) out.fill(fill);
  const ix0 = Math.max(from.x, to.x);
  const iy0 = Math.max(from.y, to.y);
  const ix1 = Math.min(from.x + from.width, to.x + to.width);
  const iy1 = Math.min(from.y + from.height, to.y + to.height);
  if (ix1 <= ix0 || iy1 <= iy0) return out;
  const n = ix1 - ix0;
  for (let y = iy0; y < iy1; y++) {
    const s = (y - from.y) * from.width + (ix0 - from.x);
    out.set(v.subarray(s, s + n), (y - to.y) * to.width + (ix0 - to.x));
  }
  return out;
}

export interface EffectCompositeInput {
  /** The accumulator (straight RGBA over `rect`); receives the layer and its effects. */
  backdrop: Uint8ClampedArray;
  /** The layer's pixels over `rect` (straight RGBA, mask applied to alpha, clipped layers applied). */
  content: Uint8ClampedArray;
  rect: EffectRect;
  maps: EffectMaps;
  blend: BlendMode;
  /** Layer opacity: the whole stack. */
  opacity: number;
  /** Fill opacity: the layer's own pixels only. */
  fillOpacity: number;
  /** The canvas (unaligned gradients span it). */
  canvas: EffectRect;
  ctx: EffectContext;
}

/** Composites a layer's content and its effects onto `backdrop` in place (see the module comment for the order). */
export function compositeLayerEffects(input: EffectCompositeInput): void {
  const { backdrop, content, rect, maps, ctx } = input;
  const items = maps.items;
  const n = rect.width * rect.height;
  const shape = new Float32Array(n);
  for (let i = 0; i < n; i++) shape[i] = content[i * 4 + 3] / 255;
  const before = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i++) before[i] = backdrop[i] / 255;
  const work = new Float32Array(before);
  const fx = (i: number, k: number) => crop(maps.per[i][k], maps.rect, rect, 0);
  const bounds = maps.bounds ?? rect;
  const env: PaintEnv = { rect, bounds, canvas: input.canvas, anchor: { x: bounds.x, y: bounds.y }, ctx };
  const fill = clamp01(input.fillOpacity);
  const inside = (a: number) => a > INSIDE_EPS;
  // The first listed instance of a kind is on top: paint in reverse.
  const rev: number[] = [];
  for (let i = items.length - 1; i >= 0; i--) rev.push(i);

  const knockOut = (m: Float32Array, fillOpacity: number) => {
    const seeThrough = 1 - clamp01(fillOpacity);
    for (let i = 0; i < n; i++) m[i] *= 1 - shape[i] * seeThrough;
  };
  const normalLike = input.blend === 'normal';
  for (const i of rev) {
    const e = items[i];
    if (e.kind !== 'drop-shadow') continue;
    const m = fx(i, 0);
    // The layer hides the shadow beneath its see-through fill, and wholly in a mode that blends with it.
    if (e.knocksOut) knockOut(m, normalLike ? fill : 0);
    paintColor(work, m, e.color, e.blend, e.opacity);
  }
  for (const i of rev) {
    const e = items[i];
    if (e.kind !== 'outer-glow') continue;
    const m = fx(i, 0);
    knockOut(m, fill);
    paintGlow(work, m, e, env);
  }

  // The layer: content at fill opacity, then the interior effects, relative to the shape.
  const lay = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    lay[i * 4] = content[i * 4] / 255;
    lay[i * 4 + 1] = content[i * 4 + 1] / 255;
    lay[i * 4 + 2] = content[i * 4 + 2] / 255;
    lay[i * 4 + 3] = inside(shape[i]) ? fill : 0;
  }
  const premerge = !normalLike;
  if (premerge) {
    const sep = isSeparableBlendMode(input.blend);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const sr = lay[p];
      const sg = lay[p + 1];
      const sb = lay[p + 2];
      const sa = lay[p + 3];
      lay[p] = work[p];
      lay[p + 1] = work[p + 1];
      lay[p + 2] = work[p + 2];
      lay[p + 3] = work[p + 3];
      compositeAt(lay, p, input.blend, sep, sr, sg, sb, sa);
    }
  }
  const rel = (m: Float32Array) => {
    for (let i = 0; i < n; i++) m[i] = inside(shape[i]) ? Math.min(m[i] / shape[i], 1) : 0;
    return m;
  };
  const full = new Float32Array(n);
  for (let i = 0; i < n; i++) full[i] = inside(shape[i]) ? 1 : 0;
  for (const i of rev) {
    const e = items[i];
    if (e.kind === 'pattern-overlay') paintPattern(lay, full, e, env, e.blend, e.opacity);
  }
  for (const i of rev) {
    const e = items[i];
    if (e.kind === 'gradient-overlay') paintGradient(lay, full, e.gradient, e.gradient.align ? bounds : input.canvas, env, e.blend, e.opacity);
  }
  for (const i of rev) {
    const e = items[i];
    if (e.kind === 'color-overlay') paintColor(lay, full, e.color, e.blend, e.opacity);
  }
  for (const i of rev) {
    const e = items[i];
    if (e.kind === 'satin') paintColor(lay, rel(fx(i, 0)), e.color, e.blend, e.opacity);
  }
  for (const i of rev) {
    const e = items[i];
    if (e.kind === 'inner-glow') paintGlow(lay, rel(fx(i, 0)), e, env);
  }
  for (const i of rev) {
    const e = items[i];
    if (e.kind === 'inner-shadow') paintColor(lay, rel(fx(i, 0)), e.color, e.blend, e.opacity);
  }
  // Strokes: inside parts over the layer (bottom instance first).
  const strokeIdx = items.map((e, i) => (e.kind === 'stroke' ? i : -1)).filter((i) => i >= 0);
  const din = strokeIdx.length && maps.din ? crop(maps.din, maps.rect, rect, 0) : null;
  const frameOf = (i: number) => maps.frames.get(i) ?? bounds;
  for (let k = strokeIdx.length - 1; k >= 0; k--) {
    const st = items[strokeIdx[k]] as StrokeEffect;
    const [inW] = strokeWidths(st);
    if (!(inW > 0) || !din) continue;
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = inside(shape[i]) ? clamp01(inW + 0.5 - din[i]) : 0;
    paintFill(lay, m, st.fill, frameOf(strokeIdx[k]), env, st.blend, st.opacity);
  }
  for (const i of rev) {
    const e = items[i];
    if (e.kind !== 'bevel-emboss' || maps.bevelPaint[i] !== 'inner') continue;
    paintColor(lay, rel(fx(i, 0)), e.highlightColor, e.highlightBlend, e.highlightOpacity);
    paintColor(lay, rel(fx(i, 1)), e.shadowColor, e.shadowBlend, e.shadowOpacity);
  }
  // The shape's own alpha.
  for (let i = 0; i < n; i++) lay[i * 4 + 3] *= Math.min(shape[i], 1);

  // Outside parts of strokes lie beneath the layer; a higher stroke covers the ones below it.
  const outside = strokeIdx.filter((i) => strokeWidths(items[i] as StrokeEffect)[1] > 0);
  if (outside.length) {
    const dout = maps.dout ? crop(maps.dout, maps.rect, rect, FAR) : null;
    const doutExact = maps.doutExact ? crop(maps.doutExact, maps.rect, rect, FAR) : null;
    const base = new Float32Array(work);
    const acc = new Float32Array(n * 4);
    const cover = new Float32Array(n);
    for (const si of outside) {
      const st = items[si] as StrokeEffect;
      const outW = strokeWidths(st)[1];
      const d = (outW >= STROKE_CHAMFER_MAX ? doutExact : dout) ?? new Float32Array(n).fill(FAR);
      const share = new Float32Array(n);
      const ones = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const band = clamp01(outW + 0.5 - d[i]);
        let k: number;
        if (inside(shape[i])) {
          // Beneath the layer the stroke shows only through the part of the pixel the shape leaves.
          const c = clamp01(lay[i * 4 + 3]);
          k = c >= 1 ? 1 : clamp01((1 - clamp01(shape[i])) / (1 - c));
        } else k = band;
        share[i] = k * st.opacity * (1 - cover[i]);
        cover[i] += share[i];
        ones[i] = share[i] > 0 ? 1 : 0;
      }
      const blended = new Float32Array(base);
      paintFill(blended, ones, st.fill, frameOf(si), env, st.blend, 1);
      for (let i = 0; i < n; i++) {
        const s = share[i];
        if (!(s > 0)) continue;
        const p = i * 4;
        const ba = blended[p + 3];
        acc[p] += s * blended[p] * ba;
        acc[p + 1] += s * blended[p + 1] * ba;
        acc[p + 2] += s * blended[p + 2] * ba;
        acc[p + 3] += s * ba;
      }
    }
    for (let i = 0; i < n; i++) {
      const c = cover[i];
      if (c <= 0) continue;
      const p = i * 4;
      const k = 1 - Math.min(c, 1);
      const a = work[p + 3] * k + acc[p + 3];
      if (a > 0) {
        work[p] = (work[p] * work[p + 3] * k + acc[p]) / a;
        work[p + 1] = (work[p + 1] * work[p + 3] * k + acc[p + 1]) / a;
        work[p + 2] = (work[p + 2] * work[p + 3] * k + acc[p + 2]) / a;
        work[p + 3] = Math.min(a, 1);
      }
    }
  }
  for (const i of rev) {
    const e = items[i];
    if (e.kind !== 'bevel-emboss' || maps.bevelPaint[i] !== 'outer') continue;
    paintColor(work, fx(i, 0), e.highlightColor, e.highlightBlend, e.highlightOpacity);
    paintColor(work, fx(i, 1), e.shadowColor, e.shadowBlend, e.shadowOpacity);
  }
  // The layer (with its interior effects) onto the exterior result.
  const mode: BlendMode = premerge ? 'normal' : input.blend;
  const sep = isSeparableBlendMode(mode);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (lay[p + 3] > 0) compositeAt(work, p, mode, sep, lay[p], lay[p + 1], lay[p + 2], lay[p + 3]);
  }
  // Emboss styles shade the composited result.
  for (const i of rev) {
    const e = items[i];
    if (e.kind !== 'bevel-emboss' || maps.bevelPaint[i] !== 'both') continue;
    paintColor(work, fx(i, 0), e.highlightColor, e.highlightBlend, e.highlightOpacity);
    paintColor(work, fx(i, 1), e.shadowColor, e.shadowBlend, e.shadowOpacity);
  }
  // Layer opacity applies to the whole stack (premultiplied mix with what was there).
  const op = clamp01(input.opacity);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const aa = before[p + 3];
    const ba = work[p + 3];
    const alpha = aa + (ba - aa) * op;
    if (alpha <= 0) {
      backdrop[p] = backdrop[p + 1] = backdrop[p + 2] = backdrop[p + 3] = 0;
      continue;
    }
    for (let c = 0; c < 3; c++) backdrop[p + c] = Math.round(((before[p + c] * aa + (work[p + c] * ba - before[p + c] * aa) * op) / alpha) * 255);
    backdrop[p + 3] = Math.round(alpha * 255);
  }
}

/**
 * Renders one layer with its effects over a whole region in one pass (no tiles): the reference
 * the per-tile compositor is checked against, and a convenience for one-off renders.
 */
export function renderLayerEffects(
  effects: LayerEffects,
  layer: { content: Uint8ClampedArray; rect: EffectRect; blend: BlendMode; opacity: number; fillOpacity?: number },
  backdrop: Uint8ClampedArray,
  canvas: EffectRect,
  ctx: EffectContext
): void {
  const items = activeEffectItems(effects);
  const n = layer.rect.width * layer.rect.height;
  const shape = new Float32Array(n);
  for (let i = 0; i < n; i++) shape[i] = layer.content[i * 4 + 3] / 255;
  const maps = buildEffectMaps(items, shape, layer.rect, ctx);
  compositeLayerEffects({
    backdrop,
    content: layer.content,
    rect: layer.rect,
    maps,
    blend: layer.blend,
    opacity: layer.opacity,
    fillOpacity: layer.fillOpacity ?? 1,
    canvas,
    ctx,
  });
}
