/**
 * Magnetic Lasso: an outline that follows the edges of the image (live-wire, Mortensen & Barrett,
 * "Intelligent Scissors", 1995). Each step between neighbouring pixels costs less where it runs
 * along a strong edge (gradient magnitude), on a Laplacian zero-crossing and in the edge's
 * direction; the outline between two points is the cheapest path, found with Dijkstra in a corridor
 * around them. The direction term ignores which side of the edge is darker, so the path holds to an
 * edge whichever way round it is traced.
 */

import type { ImagePoint } from '../types';
import type { PixelBuffer } from './mask';

export interface MagneticEdgeOptions {
  /** Detection width in px: a point snaps to the strongest edge this close to it (default 10). */
  width?: number;
  /** 0..1: edges with less contrast than this are ignored (default 0.1, Photoshop's 10 %). */
  contrast?: number;
}

const BLOCK = 64;
const W_ZERO = 0.3;
const W_GRADIENT = 0.4;
const W_DIRECTION = 0.3;

interface Block {
  /** Edge strength 0..1 (≈ the step in luminance across the edge), 0 below the contrast. */
  strength: Float32Array;
  /** Unit vector along the edge (perpendicular to the gradient), 0 on flat pixels. */
  dirX: Float32Array;
  dirY: Float32Array;
  /** 1 on a Laplacian zero-crossing of an edge above the contrast. */
  zero: Uint8Array;
}

/**
 * The edge features of an image, computed lazily in 64 px blocks as the outline reaches them, so a
 * click on a large image costs one luminance pass, not a full-image edge map.
 */
export class EdgeMap {
  readonly width: number;
  readonly height: number;
  readonly contrast: number;
  private readonly luma: Uint8Array;
  private readonly blocks = new Map<number, Block>();

  constructor(pixels: PixelBuffer, options: Pick<MagneticEdgeOptions, 'contrast'> = {}) {
    const { width, height, data } = pixels;
    if (!(width >= 1 && height >= 1) || data.length < width * height * 4) throw new Error('Invalid pixel buffer for edge detection.');
    this.width = width;
    this.height = height;
    this.contrast = Math.min(1, Math.max(0, options.contrast ?? 0.1));
    const luma = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
      // Rec. 601 luma over white, so transparent pixels read as background.
      const a = data[p + 3] / 255;
      const y = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      luma[i] = Math.round(y * a + 255 * (1 - a));
    }
    this.luma = luma;
  }

  /** Edge strength at (x, y) in whole pixels, 0..1 (0 outside the image or below the contrast). */
  strength(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    const b = this.block(x, y);
    return b.strength[(y % BLOCK) * BLOCK + (x % BLOCK)];
  }

  private block(x: number, y: number): Block {
    const bx = Math.floor(x / BLOCK);
    const by = Math.floor(y / BLOCK);
    const key = by * 65536 + bx;
    let b = this.blocks.get(key);
    if (!b) {
      b = this.computeBlock(bx * BLOCK, by * BLOCK);
      this.blocks.set(key, b);
    }
    return b;
  }

  private computeBlock(x0: number, y0: number): Block {
    const { width: W, height: H, luma } = this;
    // Luminance smoothed by a 3 × 3 binomial kernel, over the block and a 2 px margin.
    const M = 2;
    const S = BLOCK + 2 * M;
    const smooth = new Float32Array(S * S);
    const at = (x: number, y: number) => luma[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
    for (let j = 0; j < S; j++) {
      const y = y0 - M + j;
      for (let i = 0; i < S; i++) {
        const x = x0 - M + i;
        const v =
          at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) +
          2 * at(x - 1, y) + 4 * at(x, y) + 2 * at(x + 1, y) +
          at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
        smooth[j * S + i] = v / (16 * 255);
      }
    }
    const lap = new Float32Array(S * S);
    for (let j = 1; j < S - 1; j++) {
      for (let i = 1; i < S - 1; i++) {
        const k = j * S + i;
        lap[k] = smooth[k - 1] + smooth[k + 1] + smooth[k - S] + smooth[k + S] - 4 * smooth[k];
      }
    }
    const n = BLOCK * BLOCK;
    const strength = new Float32Array(n);
    const dirX = new Float32Array(n);
    const dirY = new Float32Array(n);
    const zero = new Uint8Array(n);
    const c = this.contrast;
    for (let j = 0; j < BLOCK; j++) {
      if (y0 + j >= H) break;
      for (let i = 0; i < BLOCK; i++) {
        if (x0 + i >= W) break;
        const k = (j + M) * S + (i + M);
        const gx = (smooth[k + 1] - smooth[k - 1]) / 2;
        const gy = (smooth[k + S] - smooth[k - S]) / 2;
        const g = Math.hypot(gx, gy);
        // A sharp step of height h has a central difference of about h / 2 after the smoothing.
        const e = Math.min(1, 2 * g);
        if (e < c || g === 0) continue;
        const o = j * BLOCK + i;
        strength[o] = e;
        dirX[o] = gy / g;
        dirY[o] = -gx / g;
        // The zero-crossing is on whichever side of the sign change is nearer zero.
        const l = lap[k];
        for (const d of [1, -1, S, -S]) {
          const m = lap[k + d];
          if ((l > 0 && m < 0) || (l < 0 && m > 0) || l === 0) {
            if (Math.abs(l) <= Math.abs(m)) {
              zero[o] = 1;
              break;
            }
          }
        }
      }
    }
    return { strength, dirX, dirY, zero };
  }

  /** Features of the pixel at (x, y), which must be inside the image. */
  features(x: number, y: number): { strength: number; dirX: number; dirY: number; zero: number } {
    const b = this.block(x, y);
    const o = (y % BLOCK) * BLOCK + (x % BLOCK);
    return { strength: b.strength[o], dirX: b.dirX[o], dirY: b.dirY[o], zero: b.zero[o] };
  }
}

const clampPixel = (v: number, max: number) => Math.min(max - 1, Math.max(0, Math.floor(v)));

/**
 * `point` moved onto the strongest edge within `width` px (the nearest of equal ones); unchanged
 * when there is no edge above the contrast that close. Returns a pixel centre.
 */
export function snapToEdge(map: EdgeMap, point: ImagePoint, width = 10): ImagePoint {
  const cx = clampPixel(point.x, map.width);
  const cy = clampPixel(point.y, map.height);
  const r = Math.max(0, Math.round(width));
  let best = 0;
  let bestD = Infinity;
  let bx = cx;
  let by = cy;
  for (let y = Math.max(0, cy - r); y <= Math.min(map.height - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(map.width - 1, cx + r); x++) {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d > r * r) continue;
      const s = map.strength(x, y);
      // Strength first, by a margin so noise doesn't pull the point; then distance.
      if (s > best + 0.02 || (s > 0 && Math.abs(s - best) <= 0.02 && d < bestD)) {
        if (s > best) best = s;
        bestD = d;
        bx = x;
        by = y;
      }
    }
  }
  return best > 0 ? { x: bx + 0.5, y: by + 0.5 } : point;
}

/** A binary min-heap of node ids keyed by cost, with stale entries skipped on pop. */
class Heap {
  private ids = new Int32Array(256);
  private keys = new Float64Array(256);
  size = 0;

  push(id: number, key: number): void {
    if (this.size === this.ids.length) {
      const ids = new Int32Array(this.size * 2);
      ids.set(this.ids);
      const keys = new Float64Array(this.size * 2);
      keys.set(this.keys);
      this.ids = ids;
      this.keys = keys;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.ids[i] = this.ids[p];
      this.keys[i] = this.keys[p];
      i = p;
    }
    this.ids[i] = id;
    this.keys[i] = key;
  }

  /** Removes the cheapest entry; read it from `topId` / `topKey` first. */
  pop(): void {
    const n = --this.size;
    const id = this.ids[n];
    const key = this.keys[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= key) break;
      this.ids[i] = this.ids[c];
      this.keys[i] = this.keys[c];
      i = c;
    }
    this.ids[i] = id;
    this.keys[i] = key;
  }

  get topId(): number {
    return this.ids[0];
  }

  get topKey(): number {
    return this.keys[0];
  }
}

const NEIGHBOURS: readonly [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * The cheapest path along the edges from `from` to `to` (pixel centres, both included), searched
 * in a corridor around the straight line between them: `band` px either side (default the larger
 * of 16 px and a quarter of the distance). Points inside the image.
 */
export function liveWire(map: EdgeMap, from: ImagePoint, to: ImagePoint, band?: number): ImagePoint[] {
  const ax = clampPixel(from.x, map.width);
  const ay = clampPixel(from.y, map.height);
  const bx = clampPixel(to.x, map.width);
  const by = clampPixel(to.y, map.height);
  if (ax === bx && ay === by) return [{ x: ax + 0.5, y: ay + 0.5 }];
  const len = Math.hypot(bx - ax, by - ay);
  const half = Math.max(2, band ?? Math.max(16, len / 4));
  const rx0 = Math.max(0, Math.floor(Math.min(ax, bx) - half));
  const ry0 = Math.max(0, Math.floor(Math.min(ay, by) - half));
  const rx1 = Math.min(map.width - 1, Math.ceil(Math.max(ax, bx) + half));
  const ry1 = Math.min(map.height - 1, Math.ceil(Math.max(ay, by) + half));
  const w = rx1 - rx0 + 1;
  const h = ry1 - ry0 + 1;
  const n = w * h;
  // Features of the corridor, normalised by its strongest edge so the path takes the best edge here.
  const strength = new Float32Array(n);
  const dirX = new Float32Array(n);
  const dirY = new Float32Array(n);
  const zero = new Uint8Array(n);
  const inside = new Uint8Array(n);
  let maxStrength = 0;
  const ux = (bx - ax) / len;
  const uy = (by - ay) / len;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = rx0 + x - ax;
      const py = ry0 + y - ay;
      const t = Math.min(len, Math.max(0, px * ux + py * uy));
      if (Math.hypot(px - t * ux, py - t * uy) > half) continue;
      const i = y * w + x;
      inside[i] = 1;
      const f = map.features(rx0 + x, ry0 + y);
      strength[i] = f.strength;
      dirX[i] = f.dirX;
      dirY[i] = f.dirY;
      zero[i] = f.zero;
      if (f.strength > maxStrength) maxStrength = f.strength;
    }
  }
  const scale = maxStrength > 0 ? 1 / maxStrength : 0;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const start = (ay - ry0) * w + (ax - rx0);
  const goal = (by - ry0) * w + (bx - rx0);
  dist[start] = 0;
  const heap = new Heap();
  heap.push(start, 0);
  while (heap.size) {
    const p = heap.topId;
    const d = heap.topKey;
    heap.pop();
    if (done[p] || d > dist[p]) continue;
    done[p] = 1;
    if (p === goal) break;
    const x = p % w;
    const y = (p - x) / w;
    for (const [dx, dy] of NEIGHBOURS) {
      const qx = x + dx;
      const qy = y + dy;
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
      const q = qy * w + qx;
      if (!inside[q] || done[q]) continue;
      const step = dx && dy ? Math.SQRT2 : 1;
      const lx = dx / step;
      const ly = dy / step;
      // Polarity-free: |cos| of the angle between the link and each pixel's edge direction.
      const dp = Math.min(1, Math.abs(dirX[p] * lx + dirY[p] * ly));
      const dq = Math.min(1, Math.abs(dirX[q] * lx + dirY[q] * ly));
      const fD = (Math.acos(dp) + Math.acos(dq)) / Math.PI;
      const fG = 1 - strength[q] * scale;
      const fZ = 1 - zero[q];
      const cost = (W_ZERO * fZ + W_GRADIENT * fG + W_DIRECTION * fD + 0.01) * step;
      const nd = d + cost;
      if (nd < dist[q]) {
        dist[q] = nd;
        prev[q] = p;
        heap.push(q, nd);
      }
    }
  }
  if (prev[goal] < 0) return [{ x: ax + 0.5, y: ay + 0.5 }, { x: bx + 0.5, y: by + 0.5 }];
  const path: ImagePoint[] = [];
  for (let p = goal; p >= 0; p = prev[p]) {
    const x = p % w;
    path.push({ x: rx0 + x + 0.5, y: ry0 + (p - x) / w + 0.5 });
  }
  return path.reverse();
}

/** `points` with runs along one straight line reduced to their ends (exact for 8-connected paths). */
export function simplifyPixelPath(points: readonly ImagePoint[]): ImagePoint[] {
  if (points.length < 3) return points.slice();
  const out: ImagePoint[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    const c = points[i + 1];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) > 1e-9) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * The Magnetic Lasso for a given outline (the agent path): each point snaps to the strongest edge
 * within `width` px, and consecutive points are joined by the live-wire path between them (the
 * last back to the first). Points should run along the edge in order, a few dozen px apart.
 */
export function snapPolygonToEdges(pixels: PixelBuffer | EdgeMap, points: readonly ImagePoint[], options: MagneticEdgeOptions = {}): ImagePoint[] {
  const map = pixels instanceof EdgeMap ? pixels : new EdgeMap(pixels, options);
  const width = options.width ?? 10;
  const snapped = points.map((p) => snapToEdge(map, p, width));
  const out: ImagePoint[] = [];
  for (let i = 0; i < snapped.length; i++) {
    const a = snapped[i];
    const b = snapped[(i + 1) % snapped.length];
    const seg = liveWire(map, a, b, Math.max(2 * width, 16, Math.hypot(b.x - a.x, b.y - a.y) / 4));
    // Each segment ends where the next begins.
    out.push(...seg.slice(0, -1));
  }
  return simplifyPixelPath(out);
}

/** Path length in px between auto-placed anchors for a Frequency of 0..100 (Photoshop's default 57). */
export function magneticAnchorSpacing(frequency = 57): number {
  const f = Math.min(100, Math.max(0, frequency));
  return 8 + (100 - f);
}
