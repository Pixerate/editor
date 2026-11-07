// Contiguous region flood fill with gap closing, area expansion/contraction, and enclosed region detection.
// Pure pixel math (zero DOM or third-party dependencies), shared by raster and paint-editor.

import type { RasterRect } from './surface';

export interface FillRegionPoint {
  x: number;
  y: number;
}

export interface FillRegionSummary {
  point: { x: number; y: number };
  bounds: RasterRect | null;
  pixelCount: number;
  leaked: boolean;
}

export interface FillRegionMaskOptions {
  /** Seed points in pixel coordinates. */
  points: ReadonlyArray<FillRegionPoint>;
  /** Per-channel RGBA tolerance 0..255 (default 32). */
  tolerance?: number;
  /** Close gaps in line art up to this width in pixels, 0..32 (default 0). */
  closeGap?: number;
  /** Expand (> 0, bleed under lines) or contract (< 0) the filled region in pixels, -16..16 (default 0). */
  expand?: number;
  /** Soften 1 px boundary edges (default true). */
  antialias?: boolean;
}

export interface FillRegionMaskResult {
  /** Per-pixel coverage 0..1 (`width * height`). */
  mask: Float32Array;
  /** Bounding box of all filled pixels, or null if nothing was filled. */
  bounds: RasterRect | null;
  /** Total number of filled pixels (`mask[i] > 0`). */
  pixelCount: number;
  /** True when the filled region touches the canvas edge (`x === 0`, `y === 0`, `x === width - 1`, or `y === height - 1`). */
  leaked: boolean;
  /** Per-seed summary in the order `points` were given. */
  regions: FillRegionSummary[];
}

export interface UnfilledRegion {
  /** Interior seed point guaranteed to lie inside the region (deepest interior point / pole of inaccessibility). */
  point: { x: number; y: number };
  /** Area-weighted centroid rounded to integer pixel coordinates. */
  centroid: { x: number; y: number };
  /** Tight bounding box of the region. */
  bounds: RasterRect;
  /** Area of the region in pixels. */
  pixelCount: number;
  /** True when the region touches the canvas edge. */
  touchesEdge: boolean;
}

export interface FindUnfilledRegionsMaskOptions {
  /** Optional target layer RGBA (`width * height * 4`). Pixels already painted on the target layer count as filled. */
  target?: Uint8ClampedArray | Uint8Array;
  /** Alpha/colour threshold 0..255 above which a reference pixel is treated as a barrier (default 32). */
  tolerance?: number;
  /** Close gaps in line art up to this width in pixels, 0..32 (default 0). */
  closeGap?: number;
  /** Ignore regions smaller than this many pixels (default 16). */
  minArea?: number;
  /** Include regions that touch the canvas border (default false: only enclosed shapes). */
  includeEdge?: boolean;
  /** Maximum number of regions to return, sorted largest first (default 100). */
  maxRegions?: number;
}

const INF = 1e12;

/**
 * Exact 2D squared Euclidean distance transform (Felzenszwalb & Huttenlocher, O(w * h)).
 * Returns for each pixel the squared distance `(dx^2 + dy^2)` to the nearest `0` in `binary`.
 */
export function squaredDistanceTransform(binary: Uint8Array, w: number, h: number): Float64Array {
  const n = w * h;
  const dist = new Float64Array(n);
  let hasZero = false;
  for (let i = 0; i < n; i++) {
    if (binary[i] === 0) {
      dist[i] = 0;
      hasZero = true;
    } else {
      dist[i] = INF;
    }
  }
  if (!hasZero) return dist;

  const maxDim = Math.max(w, h);
  const f = new Float64Array(maxDim);
  const d = new Float64Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = dist[y * w + x]!;
    edt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) dist[y * w + x] = d[y]!;
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = dist[row + x]!;
    edt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) dist[row + x] = d[x]!;
  }
  return dist;
}

function edt1d(f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array, n: number): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    const fq = f[q]! + q * q;
    let s = (fq - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (fq - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dx = q - v[k]!;
    d[q] = dx * dx + f[v[k]!]!;
  }
}

function pixelMatches(
  data: Uint8ClampedArray | Uint8Array,
  p: number,
  sr: number,
  sg: number,
  sb: number,
  sa: number,
  tol: number
): boolean {
  const a = data[p + 3]!;
  if (sa === 0 && a === 0) return true;
  return (
    Math.abs(data[p]! - sr) <= tol &&
    Math.abs(data[p + 1]! - sg) <= tol &&
    Math.abs(data[p + 2]! - sb) <= tol &&
    Math.abs(a - sa) <= tol
  );
}

function floodOneSeed(
  reference: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  sx: number,
  sy: number,
  tol: number,
  closeGap: number,
  expand: number,
  queue: Int32Array
): Uint8Array {
  const n = w * h;
  const marks = new Uint8Array(n);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return marks;

  const sp = (sy * w + sx) * 4;
  const sr = reference[sp]!;
  const sg = reference[sp + 1]!;
  const sb = reference[sp + 2]!;
  const sa = reference[sp + 3]!;

  // `open[i] = 1` when pixel `i` matches the seed colour; `0` when it is a barrier.
  const open = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (pixelMatches(reference, i * 4, sr, sg, sb, sa, tol)) open[i] = 1;
  }
  const start = sy * w + sx;
  open[start] = 1;

  if (closeGap <= 0) {
    let head = 0;
    let tail = 0;
    marks[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const cur = queue[head++]!;
      const cx = cur % w;
      const cy = (cur - cx) / w;
      if (cx > 0) {
        const nb = cur - 1;
        if (open[nb] === 1 && marks[nb] === 0) {
          marks[nb] = 1;
          queue[tail++] = nb;
        }
      }
      if (cx + 1 < w) {
        const nb = cur + 1;
        if (open[nb] === 1 && marks[nb] === 0) {
          marks[nb] = 1;
          queue[tail++] = nb;
        }
      }
      if (cy > 0) {
        const nb = cur - w;
        if (open[nb] === 1 && marks[nb] === 0) {
          marks[nb] = 1;
          queue[tail++] = nb;
        }
      }
      if (cy + 1 < h) {
        const nb = cur + w;
        if (open[nb] === 1 && marks[nb] === 0) {
          marks[nb] = 1;
          queue[tail++] = nb;
        }
      }
    }
  } else {
    // Squared distance from each pixel to the nearest barrier (`open === 0`).
    const distSq = squaredDistanceTransform(open, w, h);
    const r = (closeGap + 1) * 0.5;
    const rSq = r * r;
    const maxClimb = Math.ceil(r) + 2;

    // If the seed was clicked near a barrier (`distSq <= rSq`), climb steepest-ascent toward the interior core.
    let coreSeed = start;
    let head = 0;
    let tail = 0;
    marks[start] = 1;
    queue[tail++] = start;

    for (let step = 0; step < maxClimb && distSq[coreSeed]! <= rSq; step++) {
      const cx = coreSeed % w;
      const cy = (coreSeed - cx) / w;
      let best = coreSeed;
      let bestD = distSq[coreSeed]!;
      if (cx > 0 && open[coreSeed - 1] === 1 && distSq[coreSeed - 1]! > bestD) {
        best = coreSeed - 1;
        bestD = distSq[best]!;
      }
      if (cx + 1 < w && open[coreSeed + 1] === 1 && distSq[coreSeed + 1]! > bestD) {
        best = coreSeed + 1;
        bestD = distSq[best]!;
      }
      if (cy > 0 && open[coreSeed - w] === 1 && distSq[coreSeed - w]! > bestD) {
        best = coreSeed - w;
        bestD = distSq[best]!;
      }
      if (cy + 1 < h && open[coreSeed + w] === 1 && distSq[coreSeed + w]! > bestD) {
        best = coreSeed + w;
        bestD = distSq[best]!;
      }
      if (best === coreSeed) break;
      coreSeed = best;
      if (marks[coreSeed] === 0) {
        marks[coreSeed] = 1;
        queue[tail++] = coreSeed;
      }
    }

    if (distSq[coreSeed]! > rSq) {
      // 1. Flood the safe interior core (`distSq > rSq`), which cannot cross any gap `<= closeGap`.
      let scan = 0;
      while (scan < tail) {
        const cur = queue[scan++]!;
        if (distSq[cur]! <= rSq) continue;
        const cx = cur % w;
        const cy = (cur - cx) / w;
        if (cx > 0) {
          const nb = cur - 1;
          if (open[nb] === 1 && marks[nb] === 0 && distSq[nb]! > rSq) {
            marks[nb] = 1;
            queue[tail++] = nb;
          }
        }
        if (cx + 1 < w) {
          const nb = cur + 1;
          if (open[nb] === 1 && marks[nb] === 0 && distSq[nb]! > rSq) {
            marks[nb] = 1;
            queue[tail++] = nb;
          }
        }
        if (cy > 0) {
          const nb = cur - w;
          if (open[nb] === 1 && marks[nb] === 0 && distSq[nb]! > rSq) {
            marks[nb] = 1;
            queue[tail++] = nb;
          }
        }
        if (cy + 1 < h) {
          const nb = cur + w;
          if (open[nb] === 1 && marks[nb] === 0 && distSq[nb]! > rSq) {
            marks[nb] = 1;
            queue[tail++] = nb;
          }
        }
      }
      // 2. Grow from the core down into the wall-adjacent band (`distSq <= rSq` with non-increasing `distSq`).
      // Because `distSq` strictly increases when stepping past a gap saddle into the exterior, this fills
      // flush against every barrier and corner while stopping at the gap line.
      while (head < tail) {
        const cur = queue[head++]!;
        const curD = distSq[cur]!;
        const cx = cur % w;
        const cy = (cur - cx) / w;
        if (cx > 0) {
          const nb = cur - 1;
          if (open[nb] === 1 && marks[nb] === 0 && distSq[nb]! <= rSq && distSq[nb]! <= curD) {
            marks[nb] = 1;
            queue[tail++] = nb;
          }
        }
        if (cx + 1 < w) {
          const nb = cur + 1;
          if (open[nb] === 1 && marks[nb] === 0 && distSq[nb]! <= rSq && distSq[nb]! <= curD) {
            marks[nb] = 1;
            queue[tail++] = nb;
          }
        }
        if (cy > 0) {
          const nb = cur - w;
          if (open[nb] === 1 && marks[nb] === 0 && distSq[nb]! <= rSq && distSq[nb]! <= curD) {
            marks[nb] = 1;
            queue[tail++] = nb;
          }
        }
        if (cy + 1 < h) {
          const nb = cur + w;
          if (open[nb] === 1 && marks[nb] === 0 && distSq[nb]! <= rSq && distSq[nb]! <= curD) {
            marks[nb] = 1;
            queue[tail++] = nb;
          }
        }
      }
    } else {
      // The entire enclosed shape around the seed is narrower than `closeGap`: flood locally within `distSq <= rSq`.
      const maxLocal = Math.max(64, closeGap * closeGap * 8);
      while (head < tail && tail < maxLocal) {
        const cur = queue[head++]!;
        const cx = cur % w;
        const cy = (cur - cx) / w;
        if (cx > 0) {
          const nb = cur - 1;
          if (open[nb] === 1 && marks[nb] === 0 && distSq[nb]! <= rSq) {
            marks[nb] = 1;
            queue[tail++] = nb;
          }
        }
        if (cx + 1 < w) {
          const nb = cur + 1;
          if (open[nb] === 1 && marks[nb] === 0 && distSq[nb]! <= rSq) {
            marks[nb] = 1;
            queue[tail++] = nb;
          }
        }
        if (cy > 0) {
          const nb = cur - w;
          if (open[nb] === 1 && marks[nb] === 0 && distSq[nb]! <= rSq) {
            marks[nb] = 1;
            queue[tail++] = nb;
          }
        }
        if (cy + 1 < h) {
          const nb = cur + w;
          if (open[nb] === 1 && marks[nb] === 0 && distSq[nb]! <= rSq) {
            marks[nb] = 1;
            queue[tail++] = nb;
          }
        }
      }
    }
  }

  if (expand !== 0) {
    let any = false;
    for (let i = 0; i < n; i++) {
      if (marks[i] === 1) {
        any = true;
        break;
      }
    }
    if (any) {
      const expSq = expand * expand;
      if (expand > 0) {
        const inv = new Uint8Array(n);
        for (let i = 0; i < n; i++) inv[i] = marks[i] === 1 ? 0 : 1;
        const dSq = squaredDistanceTransform(inv, w, h);
        for (let i = 0; i < n; i++) marks[i] = dSq[i]! <= expSq ? 1 : 0;
      } else {
        const dSq = squaredDistanceTransform(marks, w, h);
        for (let i = 0; i < n; i++) marks[i] = dSq[i]! > expSq ? 1 : 0;
      }
    }
  }

  return marks;
}

function summarizeMarks(marks: Uint8Array, w: number, h: number): { bounds: RasterRect | null; pixelCount: number; leaked: boolean } {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let pixelCount = 0;
  let leaked = false;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (marks[row + x] === 1) {
        pixelCount++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) leaked = true;
      }
    }
  }

  const bounds = pixelCount > 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
  return { bounds, pixelCount, leaked };
}

/**
 * Flood-fills one or more seed points against a reference RGBA buffer (`width * height * 4`),
 * closing line-art gaps up to `closeGap` px and expanding/contracting the filled mask by `expand` px.
 */
export function fillRegionMask(
  reference: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options: FillRegionMaskOptions
): FillRegionMaskResult {
  const n = width * height;
  const tol = Math.max(0, Math.min(255, options.tolerance ?? 32));
  const closeGap = Math.max(0, Math.min(32, options.closeGap ?? 0));
  const expand = Math.max(-16, Math.min(16, options.expand ?? 0));
  const antialias = options.antialias ?? true;

  const combined = new Uint8Array(n);
  const queue = new Int32Array(n);
  const regions: FillRegionSummary[] = [];

  for (const pt of options.points) {
    const sx = Math.floor(pt.x);
    const sy = Math.floor(pt.y);
    const seedMarks = floodOneSeed(reference, width, height, sx, sy, tol, closeGap, expand, queue);
    const summary = summarizeMarks(seedMarks, width, height);
    regions.push({
      point: { x: pt.x, y: pt.y },
      bounds: summary.bounds,
      pixelCount: summary.pixelCount,
      leaked: summary.leaked,
    });
    for (let i = 0; i < n; i++) {
      if (seedMarks[i] === 1) combined[i] = 1;
    }
  }

  const total = summarizeMarks(combined, width, height);
  const mask = new Float32Array(n);
  if (total.bounds) {
    const x0 = total.bounds.x;
    const y0 = total.bounds.y;
    const x1 = x0 + total.bounds.width;
    const y1 = y0 + total.bounds.height;
    for (let y = y0; y < y1; y++) {
      const row = y * width;
      for (let x = x0; x < x1; x++) {
        const idx = row + x;
        if (combined[idx] !== 1) continue;
        if (!antialias) {
          mask[idx] = 1;
          continue;
        }
        let sum = 0;
        let edge = false;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const v = nx < 0 || ny < 0 || nx >= width || ny >= height ? 1 : combined[ny * width + nx]!;
            if (v === 0) edge = true;
            sum += v;
          }
        }
        mask[idx] = edge ? 0.5 + 0.5 * (sum / 9) : 1;
      }
    }
  }

  return {
    mask,
    bounds: total.bounds,
    pixelCount: total.pixelCount,
    leaked: total.leaked,
    regions,
  };
}

/**
 * Finds enclosed unfilled regions in a reference RGBA buffer (`width * height * 4`),
 * closing gaps up to `closeGap` px and excluding areas already painted on `options.target`.
 */
export function findUnfilledRegionsMask(
  reference: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options: FindUnfilledRegionsMaskOptions = {}
): UnfilledRegion[] {
  const n = width * height;
  if (n <= 0) return [];
  const tol = Math.max(0, Math.min(255, options.tolerance ?? 32));
  const closeGap = Math.max(0, Math.min(32, options.closeGap ?? 0));
  const minArea = Math.max(1, Math.floor(options.minArea ?? 16));
  const includeEdge = options.includeEdge ?? false;
  const maxRegions = Math.max(1, Math.floor(options.maxRegions ?? 100));
  const target = options.target;

  // Determine whether the reference has transparent unpainted pixels (`alpha <= tol`).
  // If fully opaque (e.g. dark ink on an opaque white ground), treat the corner colour as the open background.
  let hasTransparent = false;
  for (let i = 0; i < n; i++) {
    if (reference[i * 4 + 3]! <= tol) {
      hasTransparent = true;
      break;
    }
  }
  const br = reference[0]!;
  const bg = reference[1]!;
  const bb = reference[2]!;
  const ba = reference[3]!;

  // `openRef[i] = 1` when reference pixel `i` is not line art; `0` when it is a line-art barrier.
  const openRef = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const isRefOpen = hasTransparent ? reference[p + 3]! <= tol : pixelMatches(reference, p, br, bg, bb, ba, tol);
    if (isRefOpen) openRef[i] = 1;
  }

  // `unfilled[i] = 1` when open on reference AND not already painted on `target`.
  const unfilled = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (openRef[i] === 1 && (!target || target[i * 4 + 3]! <= tol)) {
      unfilled[i] = 1;
    }
  }

  const distSq = squaredDistanceTransform(openRef, width, height);
  const r = closeGap > 0 ? (closeGap + 1) * 0.5 : 0;
  const rSq = r * r;

  const labels = new Int32Array(n);
  const queue = new Int32Array(n);
  let nextLabel = 0;
  let coreTail = 0;

  // 1. Label 4-connected components in the core (`unfilled === 1 && distSq > rSq`).
  for (let i = 0; i < n; i++) {
    if (unfilled[i] !== 1 || labels[i] !== 0 || distSq[i]! <= rSq) continue;
    const label = ++nextLabel;
    labels[i] = label;
    let head = coreTail;
    queue[coreTail++] = i;
    while (head < coreTail) {
      const cur = queue[head++]!;
      const cx = cur % width;
      const cy = (cur - cx) / width;
      if (cx > 0) {
        const nb = cur - 1;
        if (unfilled[nb] === 1 && labels[nb] === 0 && distSq[nb]! > rSq) {
          labels[nb] = label;
          queue[coreTail++] = nb;
        }
      }
      if (cx + 1 < width) {
        const nb = cur + 1;
        if (unfilled[nb] === 1 && labels[nb] === 0 && distSq[nb]! > rSq) {
          labels[nb] = label;
          queue[coreTail++] = nb;
        }
      }
      if (cy > 0) {
        const nb = cur - width;
        if (unfilled[nb] === 1 && labels[nb] === 0 && distSq[nb]! > rSq) {
          labels[nb] = label;
          queue[coreTail++] = nb;
        }
      }
      if (cy + 1 < height) {
        const nb = cur + width;
        if (unfilled[nb] === 1 && labels[nb] === 0 && distSq[nb]! > rSq) {
          labels[nb] = label;
          queue[coreTail++] = nb;
        }
      }
    }
  }

  // 2. When `closeGap > 0`, grow all component labels downhill into the wall-adjacent band (`distSq <= rSq`).
  if (closeGap > 0 && nextLabel > 0) {
    let head = 0;
    let tail = coreTail;
    while (head < tail) {
      const cur = queue[head++]!;
      const label = labels[cur]!;
      const curD = distSq[cur]!;
      const cx = cur % width;
      const cy = (cur - cx) / width;
      if (cx > 0) {
        const nb = cur - 1;
        if (unfilled[nb] === 1 && labels[nb] === 0 && distSq[nb]! <= rSq && distSq[nb]! <= curD) {
          labels[nb] = label;
          queue[tail++] = nb;
        }
      }
      if (cx + 1 < width) {
        const nb = cur + 1;
        if (unfilled[nb] === 1 && labels[nb] === 0 && distSq[nb]! <= rSq && distSq[nb]! <= curD) {
          labels[nb] = label;
          queue[tail++] = nb;
        }
      }
      if (cy > 0) {
        const nb = cur - width;
        if (unfilled[nb] === 1 && labels[nb] === 0 && distSq[nb]! <= rSq && distSq[nb]! <= curD) {
          labels[nb] = label;
          queue[tail++] = nb;
        }
      }
      if (cy + 1 < height) {
        const nb = cur + width;
        if (unfilled[nb] === 1 && labels[nb] === 0 && distSq[nb]! <= rSq && distSq[nb]! <= curD) {
          labels[nb] = label;
          queue[tail++] = nb;
        }
      }
    }
  }

  if (nextLabel === 0) return [];

  const counts = new Int32Array(nextLabel + 1);
  const sumX = new Float64Array(nextLabel + 1);
  const sumY = new Float64Array(nextLabel + 1);
  const minX = new Int32Array(nextLabel + 1).fill(width);
  const minY = new Int32Array(nextLabel + 1).fill(height);
  const maxX = new Int32Array(nextLabel + 1).fill(-1);
  const maxY = new Int32Array(nextLabel + 1).fill(-1);
  const edge = new Uint8Array(nextLabel + 1);
  const bestIdx = new Int32Array(nextLabel + 1).fill(-1);
  const bestDist = new Float64Array(nextLabel + 1).fill(-1);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      const l = labels[idx]!;
      if (l === 0) continue;
      counts[l]++;
      sumX[l] += x;
      sumY[l] += y;
      if (x < minX[l]!) minX[l] = x;
      if (y < minY[l]!) minY[l] = y;
      if (x > maxX[l]!) maxX[l] = x;
      if (y > maxY[l]!) maxY[l] = y;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edge[l] = 1;
      const d = distSq[idx]!;
      if (d > bestDist[l]!) {
        bestDist[l] = d;
        bestIdx[l] = idx;
      }
    }
  }

  const out: UnfilledRegion[] = [];
  for (let l = 1; l <= nextLabel; l++) {
    const count = counts[l]!;
    if (count < minArea) continue;
    const touchesEdge = edge[l] === 1;
    if (!includeEdge && touchesEdge) continue;
    const cx = Math.round(sumX[l]! / count);
    const cy = Math.round(sumY[l]! / count);
    const cIdx = cy * width + cx;
    // Use the centroid when it lies safely inside the component's core; otherwise use the deepest interior pixel.
    let px = cx;
    let py = cy;
    if (cx < 0 || cy < 0 || cx >= width || cy >= height || labels[cIdx] !== l || distSq[cIdx]! <= rSq) {
      const bi = bestIdx[l]!;
      px = bi % width;
      py = (bi - px) / width;
    }
    out.push({
      point: { x: px, y: py },
      centroid: { x: cx, y: cy },
      bounds: {
        x: minX[l]!,
        y: minY[l]!,
        width: maxX[l]! - minX[l]! + 1,
        height: maxY[l]! - minY[l]! + 1,
      },
      pixelCount: count,
      touchesEdge,
    });
  }

  out.sort((a, b) => b.pixelCount - a.pixelCount || a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
  return out.slice(0, maxRegions);
}
