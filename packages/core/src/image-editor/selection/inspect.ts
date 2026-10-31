/**
 * A measured report on a mask's edge (`inspect_mask_edge`), so an agent can check a selection or
 * a mask without looking at it: halo (old background left just inside the edge), how much of the
 * edge sits on the image's own edges, how jagged the outline is, how soft it is, holes and stray
 * islands, and the worst places to look at. Read-only; works in the mask's bounds.
 */

import type { CropBox } from '../types';
import type { PixelBuffer, SelectionMask } from './mask';

export interface InspectMaskEdgeOptions {
  /** Holes and islands smaller than this many pixels are left out (default 16). */
  minArea?: number;
}

/** A hole or island: its area in pixels and bounds. */
export interface MaskRegion {
  area: number;
  bounds: CropBox;
}

export interface MaskEdgeReport {
  /** Pixels at least half covered. */
  area: number;
  bounds: CropBox;
  /** Pixels along the edge (inside, at least half covered, beside one less than half). */
  edgeLength: number;
  /**
   * 0–1: how close the colour just inside the edge is to the colour just outside it, relative to
   * the colour further in (0: the edge ring looks like the subject; 1: it looks like the
   * background). Measured only where the inside and outside differ.
   */
  haloScore: number;
  /** 0–1: the share of the edge within 2 px of a strong image edge. */
  edgeAlignment: number;
  /** Turning of the outline beyond what closing it needs, in radians per 100 px of outline (0: smooth). */
  jaggedness: number;
  /** 0–1: the share of edge pixels that are partly covered (0 < α < 1). */
  softFraction: number;
  /** Unselected areas enclosed by the selection, largest first (at most 10 listed). */
  holes: { count: number; totalArea: number; largest: MaskRegion[] };
  /** Selected pieces apart from the largest one, largest first (at most 10 listed). */
  islands: { count: number; totalArea: number; largest: MaskRegion[] };
  /** Up to 5 places to look at first (for `capture_view`), worst first. */
  worst: Array<{ bounds: CropBox; reason: string }>;
  /** Plain-language findings with a suggested fix, empty when the edge looks clean. */
  issues: string[];
}

/** Report thresholds (also in the masking skill). */
export const MASK_EDGE_THRESHOLDS = { halo: 0.35, alignment: 0.5, jaggedness: 15, soft: 0.9 } as const;

/** Sobel magnitude (0–1 of a full step) above which an image edge counts as strong. */
const STRONG_EDGE = 0.1;

function toLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (v: number) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Inspects `mask`'s edge against `image` (RGBA, straight alpha, covering document pixels from
 * `image.x`, `image.y`; outside it counts as transparent). Throws for an empty mask.
 */
export function inspectMaskEdge(mask: SelectionMask, image: PixelBuffer & { x: number; y: number }, options: InspectMaskEdgeOptions = {}): MaskEdgeReport {
  const b = mask.bounds;
  if (!b) throw new Error('The mask is empty: there is no edge to inspect.');
  const minArea = Math.max(1, options.minArea ?? 16);
  const W = mask.width;
  const H = mask.height;
  const a = mask.data;
  const alpha = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : a[y * W + x]);
  const img = image.data;

  /** Straight RGB times alpha at a document pixel, or null where the image is transparent or missing. */
  const rgb = (x: number, y: number): [number, number, number] | null => {
    const ix = x - image.x;
    const iy = y - image.y;
    if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height) return null;
    const i = (iy * image.width + ix) * 4;
    if (img[i + 3] < 128) return null;
    return [img[i], img[i + 1], img[i + 2]];
  };
  const premul = (x: number, y: number, c: number) => {
    const ix = Math.min(image.width - 1, Math.max(0, x - image.x));
    const iy = Math.min(image.height - 1, Math.max(0, y - image.y));
    const i = (iy * image.width + ix) * 4;
    return (img[i + c] * img[i + 3]) / 255;
  };
  const gradCache = new Map<number, number>();
  /** The image's Sobel magnitude at a pixel, the largest over R, G and B (0–1 of a full step). */
  const gradient = (x: number, y: number): number => {
    const k = y * W + x;
    const hit = gradCache.get(k);
    if (hit !== undefined) return hit;
    let best = 0;
    for (let c = 0; c < 3; c++) {
      const p = (dx: number, dy: number) => premul(x + dx, y + dy, c);
      const gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
      const gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
      best = Math.max(best, Math.hypot(gx, gy) / 1020);
    }
    gradCache.set(k, best);
    return best;
  };

  // The worst-region grid: blocks a twelfth of the image's longer side (24–256 px).
  const B = Math.min(256, Math.max(24, Math.round(Math.max(W, H) / 12)));
  const BW = Math.ceil(W / B);
  type Block = { edge: number; aligned: number; halo: number; haloN: number; turn: number; len: number; x0: number; y0: number; x1: number; y1: number };
  const blocks = new Map<number, Block>();
  const block = (x: number, y: number): Block => {
    const k = Math.floor(y / B) * BW + Math.floor(x / B);
    let blk = blocks.get(k);
    if (!blk) blocks.set(k, (blk = { edge: 0, aligned: 0, halo: 0, haloN: 0, turn: 0, len: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }));
    return blk;
  };
  const grow = (blk: Block, x: number, y: number) => {
    blk.x0 = Math.min(blk.x0, x);
    blk.y0 = Math.min(blk.y0, y);
    blk.x1 = Math.max(blk.x1, x);
    blk.y1 = Math.max(blk.y1, y);
  };

  // Edge pixels, halo, alignment and softness, in the bounds plus one pixel.
  const x0 = Math.max(0, b.x - 1);
  const y0 = Math.max(0, b.y - 1);
  const x1 = Math.min(W, b.x + b.width + 1);
  const y1 = Math.min(H, b.y + b.height + 1);
  let area = 0;
  let edgeLength = 0;
  let aligned = 0;
  let haloSum = 0;
  let haloN = 0;
  let band = 0;
  let soft = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = a[y * W + x];
      if (v >= 128) area++;
      let lo = false;
      let hi = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (a[ny * W + nx] >= 128) hi = true;
          else lo = true;
        }
      }
      const partial = v > 0 && v < 255;
      if ((hi && lo) || partial) {
        band++;
        if (partial) soft++;
      }
      if (v < 128) continue;
      const inCanvasLow = (nx: number, ny: number) => nx >= 0 && ny >= 0 && nx < W && ny < H && a[ny * W + nx] < 128;
      if (!(inCanvasLow(x - 1, y) || inCanvasLow(x + 1, y) || inCanvasLow(x, y - 1) || inCanvasLow(x, y + 1))) continue;
      edgeLength++;
      const blk = block(x, y);
      blk.edge++;
      grow(blk, x, y);
      // On a strong image edge within 2 px?
      let strong = false;
      for (let dy = -2; dy <= 2 && !strong; dy++) {
        for (let dx = -2; dx <= 2 && !strong; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && gradient(nx, ny) >= STRONG_EDGE) strong = true;
        }
      }
      if (strong) {
        aligned++;
        blk.aligned++;
      }
      // Halo: along the mask's normal, the ring just inside against further in and just outside.
      const s = (dx: number, dy: number) => alpha(Math.min(W - 1, Math.max(0, x + dx)), Math.min(H - 1, Math.max(0, y + dy)));
      const gx = s(1, -1) + 2 * s(1, 0) + s(1, 1) - s(-1, -1) - 2 * s(-1, 0) - s(-1, 1);
      const gy = s(-1, 1) + 2 * s(0, 1) + s(1, 1) - s(-1, -1) - 2 * s(0, -1) - s(1, -1);
      const len = Math.hypot(gx, gy);
      if (len < 1e-6) continue;
      const ux = gx / len;
      const uy = gy / len;
      const at = (d: number) => rgb(Math.round(x + ux * d), Math.round(y + uy * d));
      const ring = at(1.5);
      const deep = at(5);
      const out = at(-3);
      if (!ring || !deep || !out) continue;
      const labOut = toLab(...out);
      const span = dist(toLab(...deep), labOut);
      if (span < 10) continue;
      const h = Math.min(1, Math.max(0, 1 - dist(toLab(...ring), labOut) / span));
      haloSum += h;
      haloN++;
      blk.halo += h;
      blk.haloN++;
    }
  }

  // Jaggedness: marching squares at half coverage, resampled every 2 px, turning beyond closure.
  let turnExcess = 0;
  let outline = 0;
  for (const loop of traceLoops(a, W, H, x0 - 1, y0 - 1, x1 + 1, y1 + 1)) {
    const pts = resample(loop, 2);
    const n = pts.length;
    if (n < 6) continue;
    const L = n * 2;
    let total = 0;
    let net = 0;
    const turns: number[] = [];
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i + n - 1) % n];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % n];
      let d = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) - Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d <= -Math.PI) d += 2 * Math.PI;
      turns.push(d);
      total += Math.abs(d);
      net += d;
    }
    const closure = Math.abs(net);
    turnExcess += Math.max(0, total - closure);
    outline += L;
    for (let i = 0; i < n; i++) {
      const [px, py] = pts[i];
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const blk = block(Math.floor(px), Math.floor(py));
      blk.turn += Math.abs(turns[i]) - closure / n;
      blk.len += 2;
    }
  }
  const jaggedness = outline ? (100 * turnExcess) / outline : 0;

  // Holes and islands, in the bounds plus one pixel of background.
  const { holes, islands } = regions(a, W, H, b, minArea);

  const haloScore = haloN ? haloSum / haloN : 0;
  const edgeAlignment = edgeLength ? aligned / edgeLength : 0;
  const softFraction = band ? soft / band : 0;
  const T = MASK_EDGE_THRESHOLDS;

  // The worst places: blocks by their strongest problem, then holes and islands.
  const candidates: Array<{ severity: number; bounds: CropBox; reason: string }> = [];
  const pad = (r: CropBox): CropBox => {
    const px0 = Math.max(0, r.x - 8);
    const py0 = Math.max(0, r.y - 8);
    return { x: px0, y: py0, width: Math.min(W, r.x + r.width + 8) - px0, height: Math.min(H, r.y + r.height + 8) - py0 };
  };
  for (const blk of blocks.values()) {
    if (blk.edge < 8) continue;
    const bounds = pad({ x: blk.x0, y: blk.y0, width: blk.x1 - blk.x0 + 1, height: blk.y1 - blk.y0 + 1 });
    const opts: Array<{ severity: number; reason: string }> = [];
    if (blk.haloN >= 8) {
      const h = blk.halo / blk.haloN;
      if (h >= T.halo) opts.push({ severity: h, reason: `halo ${r3(h)}: the colour just inside the edge matches the background` });
    }
    const al = blk.aligned / blk.edge;
    if (al < T.alignment) opts.push({ severity: (1 - al) * 0.9, reason: `alignment ${r3(al)}: the edge is off the image's edges` });
    if (blk.len >= 16) {
      const j = (100 * Math.max(0, blk.turn)) / blk.len;
      if (j >= T.jaggedness) opts.push({ severity: Math.min(1, j / (4 * T.jaggedness)), reason: `jaggedness ${r3(j)}: the outline zigzags` });
    }
    const top = opts.sort((p, q) => q.severity - p.severity)[0];
    if (top) candidates.push({ ...top, bounds });
  }
  const imageArea = W * H;
  for (const r of holes.largest) candidates.push({ severity: Math.min(0.95, 0.5 + r.area / (0.01 * imageArea)), bounds: pad(r.bounds), reason: `hole of ${r.area} px inside the selection` });
  for (const r of islands.largest) candidates.push({ severity: Math.min(0.95, 0.5 + r.area / (0.01 * imageArea)), bounds: pad(r.bounds), reason: `island of ${r.area} px apart from the main selection` });
  const worst = candidates
    .sort((p, q) => q.severity - p.severity)
    .slice(0, 5)
    .map(({ bounds, reason }) => ({ bounds, reason }));

  const issues: string[] = [];
  if (haloScore >= T.halo)
    issues.push(`Halo (haloScore ${r3(haloScore)} ≥ ${T.halo}): background colour is left inside the edge. Contract the edge (modify_selection contract 1–2 px, or refine_selection shiftEdge -20 to -40), or decontaminate on a new-layer output.`);
  if (edgeLength >= 16 && edgeAlignment < T.alignment)
    issues.push(`Off the image's edges (edgeAlignment ${r3(edgeAlignment)} < ${T.alignment}): much of the edge does not follow edges in the image. Rebuild it with select_subject, select_object or quick_select, or refine_selection with a larger radius.`);
  if (jaggedness >= T.jaggedness) issues.push(`Jagged (jaggedness ${r3(jaggedness)} ≥ ${T.jaggedness}): the outline zigzags. Smooth it (refine_selection smooth 20–40, or modify_selection smooth).`);
  if (softFraction >= T.soft && edgeAlignment >= T.alignment)
    issues.push(`Very soft (softFraction ${r3(softFraction)} ≥ ${T.soft}): almost the whole edge is partly selected. If the subject has hard edges, raise refine_selection contrast or lower feather.`);
  if (holes.count) issues.push(`${holes.count} hole(s) (${holes.totalArea} px) inside the selection. If they belong to the subject, fill them (quick_select or select_polygon with mode add).`);
  if (islands.count) issues.push(`${islands.count} island(s) (${islands.totalArea} px) apart from the main selection. If they are stray, remove them (select_polygon or quick_select with mode subtract).`);

  return {
    area,
    bounds: { ...b },
    edgeLength,
    haloScore: r3(haloScore),
    edgeAlignment: r3(edgeAlignment),
    jaggedness: r3(jaggedness),
    softFraction: r3(softFraction),
    holes,
    islands,
    worst,
    issues,
  };
}

/** Closed outlines at coverage 128 over pixel centres in [rx0, rx1) × [ry0, ry1) (outside the canvas counts as 0). */
function traceLoops(a: Uint8Array, W: number, H: number, rx0: number, ry0: number, rx1: number, ry1: number): Array<Array<[number, number]>> {
  const w = rx1 - rx0;
  const h = ry1 - ry0;
  const f = (i: number, j: number) => {
    const x = rx0 + i;
    const y = ry0 + j;
    return x < 0 || y < 0 || x >= W || y >= H ? 0 : a[y * W + x];
  };
  const on = (i: number, j: number) => f(i, j) >= 128;
  const V = w * h;
  // Edge ids: horizontal (i,j)-(i+1,j) is j*w+i; vertical (i,j)-(i,j+1) is V + j*w+i.
  const point = (id: number): [number, number] => {
    const vertical = id >= V;
    const k = vertical ? id - V : id;
    const i = k % w;
    const j = (k - i) / w;
    const p = f(i, j);
    const q = vertical ? f(i, j + 1) : f(i + 1, j);
    const t = q === p ? 0.5 : Math.min(1, Math.max(0, (127.5 - p) / (q - p)));
    return vertical ? [rx0 + i, ry0 + j + t] : [rx0 + i + t, ry0 + j];
  };
  const segs: number[] = [];
  const touch = new Map<number, number[]>();
  const add = (e1: number, e2: number) => {
    const s = segs.length / 2;
    segs.push(e1, e2);
    for (const e of [e1, e2]) {
      const list = touch.get(e);
      if (list) list.push(s);
      else touch.set(e, [s]);
    }
  };
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const c = (on(i, j) ? 1 : 0) | (on(i + 1, j) ? 2 : 0) | (on(i + 1, j + 1) ? 4 : 0) | (on(i, j + 1) ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const top = j * w + i;
      const bottom = (j + 1) * w + i;
      const left = V + j * w + i;
      const right = V + j * w + i + 1;
      const centre = (f(i, j) + f(i + 1, j) + f(i + 1, j + 1) + f(i, j + 1)) / 4 >= 128;
      switch (c) {
        case 1: case 14: add(left, top); break;
        case 2: case 13: add(top, right); break;
        case 3: case 12: add(left, right); break;
        case 4: case 11: add(right, bottom); break;
        case 6: case 9: add(top, bottom); break;
        case 7: case 8: add(left, bottom); break;
        case 5:
          if (centre) { add(top, right); add(left, bottom); } else { add(left, top); add(right, bottom); }
          break;
        case 10:
          if (centre) { add(left, top); add(right, bottom); } else { add(top, right); add(left, bottom); }
          break;
      }
    }
  }
  const used = new Uint8Array(segs.length / 2);
  const loops: Array<Array<[number, number]>> = [];
  for (let s0 = 0; s0 < used.length; s0++) {
    if (used[s0]) continue;
    const loop: Array<[number, number]> = [];
    let s = s0;
    let from = segs[s * 2];
    while (!used[s]) {
      used[s] = 1;
      loop.push(point(from));
      const to = segs[s * 2] === from ? segs[s * 2 + 1] : segs[s * 2];
      const next = touch.get(to)!.find((t) => !used[t]);
      from = to;
      if (next === undefined) break;
      s = next;
    }
    loops.push(loop);
  }
  return loops;
}

/** A closed polyline resampled every `step` px of arc length. */
function resample(loop: ReadonlyArray<[number, number]>, step: number): Array<[number, number]> {
  const n = loop.length;
  if (n < 2) return [];
  const out: Array<[number, number]> = [loop[0]];
  let carry = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = loop[i];
    const [bx, by] = loop[(i + 1) % n];
    const seg = Math.hypot(bx - ax, by - ay);
    let t = step - carry;
    while (t <= seg) {
      out.push([ax + ((bx - ax) * t) / seg, ay + ((by - ay) * t) / seg]);
      t += step;
    }
    carry = seg - (t - step);
  }
  if (out.length > 1 && Math.hypot(out[out.length - 1][0] - out[0][0], out[out.length - 1][1] - out[0][1]) < step / 2) out.pop();
  return out;
}

/** Holes (4-connected unselected areas not reaching the outside) and islands (8-connected selected pieces but the largest). */
function regions(a: Uint8Array, W: number, H: number, b: CropBox, minArea: number): Pick<MaskEdgeReport, 'holes' | 'islands'> {
  const x0 = b.x - 1;
  const y0 = b.y - 1;
  const w = b.width + 2;
  const h = b.height + 2;
  const on = (i: number, j: number) => {
    const x = x0 + i;
    const y = y0 + j;
    return x >= 0 && y >= 0 && x < W && y < H && a[y * W + x] >= 128;
  };
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const found: Array<{ fg: boolean; area: number; bx0: number; by0: number; bx1: number; by1: number; outer: boolean }> = [];
  const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const N8 = [...N4, [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let start = 0; start < w * h; start++) {
    if (label[start]) continue;
    const si = start % w;
    const sj = (start - si) / w;
    const fg = on(si, sj);
    const id = found.length + 1;
    const r = { fg, area: 0, bx0: si, by0: sj, bx1: si, by1: sj, outer: false };
    let top = 0;
    stack[top++] = start;
    label[start] = id;
    while (top) {
      const k = stack[--top];
      const i = k % w;
      const j = (k - i) / w;
      r.area++;
      if (i < r.bx0) r.bx0 = i;
      if (i > r.bx1) r.bx1 = i;
      if (j < r.by0) r.by0 = j;
      if (j > r.by1) r.by1 = j;
      if (i === 0 || j === 0 || i === w - 1 || j === h - 1) r.outer = true;
      for (const [dx, dy] of fg ? N8 : N4) {
        const ni = i + dx;
        const nj = j + dy;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const nk = nj * w + ni;
        if (label[nk] || on(ni, nj) !== fg) continue;
        label[nk] = id;
        stack[top++] = nk;
      }
    }
    found.push(r);
  }
  const box = (r: (typeof found)[number]): CropBox => ({ x: x0 + r.bx0, y: y0 + r.by0, width: r.bx1 - r.bx0 + 1, height: r.by1 - r.by0 + 1 });
  const summarize = (list: typeof found) => {
    const kept = list.filter((r) => r.area >= minArea).sort((p, q) => q.area - p.area);
    return { count: kept.length, totalArea: kept.reduce((s, r) => s + r.area, 0), largest: kept.slice(0, 10).map((r) => ({ area: r.area, bounds: box(r) })) };
  };
  const pieces = found.filter((r) => r.fg).sort((p, q) => q.area - p.area);
  return {
    holes: summarize(found.filter((r) => !r.fg && !r.outer)),
    islands: summarize(pieces.slice(1)),
  };
}
