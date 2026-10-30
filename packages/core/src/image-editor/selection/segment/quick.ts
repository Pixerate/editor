/**
 * Quick Selection: a brush stroke grows into the region it is painted on, out to that region's
 * edges. Graph cut (Boykov & Jolly, "Interactive Graph Cuts", 2001) on a reduced copy of the
 * image: the pixels under the brush are fixed to the selection, colour models of the stroke and of
 * the surroundings pull every other pixel one way or the other, and cutting between dissimilar
 * neighbours is cheap, so the cut runs along edges. The search starts in a window around the
 * stroke and widens while the region reaches its border. The result is scaled back up and its
 * edge pixels anti-aliased at full size from the colours either side of the edge.
 */

import type { ImagePoint } from '../../types';
import { selectionFromRegion, selectionValueAt, type PixelBuffer, type SelectionMask } from '../mask';
import { GridGraph } from './maxflow';

/** The reduced image the segmentations work on (sRGB, 0..255 per channel). */
export interface WorkImage {
  /** Natural size of the image it was made from. */
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  /** Reduced pixels per natural pixel (≤ 1). */
  scale: number;
  /** RGB, 3 values per pixel. */
  rgb: Float32Array;
}

/** Long side of the work image (the issue's 512²). */
export const WORK_SIZE = 512;

const workCache = new WeakMap<object, { maxSide: number; work: WorkImage }>();

/**
 * `pixels` reduced to at most {@link WORK_SIZE} px on the long side by area averaging (alpha
 * composited over white). Cached per pixel buffer.
 */
export function workImage(pixels: PixelBuffer, maxSide = WORK_SIZE): WorkImage {
  const cached = workCache.get(pixels.data as object);
  if (cached && cached.maxSide === maxSide && cached.work.sourceWidth === pixels.width && cached.work.sourceHeight === pixels.height) return cached.work;
  const { width: W, height: H, data } = pixels;
  const scale = Math.min(1, maxSide / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const sum = new Float64Array(w * h * 3);
  const count = new Float64Array(w * h);
  const xs = new Int32Array(W);
  for (let x = 0; x < W; x++) xs[x] = Math.min(w - 1, Math.floor((x * w) / W));
  for (let y = 0; y < H; y++) {
    const row = Math.min(h - 1, Math.floor((y * h) / H)) * w;
    for (let x = 0, p = y * W * 4; x < W; x++, p += 4) {
      const o = row + xs[x];
      const a = data[p + 3] / 255;
      const k = o * 3;
      sum[k] += data[p] * a + 255 * (1 - a);
      sum[k + 1] += data[p + 1] * a + 255 * (1 - a);
      sum[k + 2] += data[p + 2] * a + 255 * (1 - a);
      count[o]++;
    }
  }
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const c = count[i] || 1;
    rgb[i * 3] = sum[i * 3] / c;
    rgb[i * 3 + 1] = sum[i * 3 + 1] / c;
    rgb[i * 3 + 2] = sum[i * 3 + 2] / c;
  }
  const work: WorkImage = { sourceWidth: W, sourceHeight: H, width: w, height: h, scale: w / W, rgb };
  workCache.set(pixels.data as object, { maxSide, work });
  return work;
}

export interface QuickSelectOptions {
  /** Brush diameter in natural pixels (default 30). */
  size?: number;
  /**
   * The current selection: with `grow` its pixels near the stroke count as part of what is being
   * selected (Add), so the new region joins on to it.
   */
  selection?: SelectionMask | null;
  grow?: boolean;
  /** Smoother, less blocky edges (Photoshop's Auto-Enhance). Default false. */
  enhanceEdge?: boolean;
}

/** 16 levels per channel: a 4096-bin colour histogram. */
const BINS = 16;
const binOf = (rgb: Float32Array, i: number) =>
  (Math.min(BINS - 1, rgb[i * 3] >> 4) * BINS + Math.min(BINS - 1, rgb[i * 3 + 1] >> 4)) * BINS + Math.min(BINS - 1, rgb[i * 3 + 2] >> 4);

/**
 * −ln of a histogram's probabilities, smoothed across neighbouring bins (so noise that straddles
 * a bin boundary still counts) with a small floor for colours never seen.
 */
function costTable(hist: Float64Array, total: number): Float64Array {
  let a = hist;
  // A [1 2 1] blur along each colour axis.
  for (const stride of [1, BINS, BINS * BINS]) {
    const b = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) {
      const pos = Math.floor(i / stride) % BINS;
      const lo = pos > 0 ? a[i - stride] : a[i];
      const hi = pos < BINS - 1 ? a[i + stride] : a[i];
      b[i] = (lo + 2 * a[i] + hi) / 4;
    }
    a = b;
  }
  const out = new Float64Array(a.length);
  const floor = 1e-4;
  const denom = Math.max(1, total) * (1 + floor * a.length);
  for (let i = 0; i < a.length; i++) out[i] = -Math.log((a[i] + floor * Math.max(1, total)) / denom);
  return out;
}

/** Edge weight between neighbours: high for similar colours, low across an edge (GrabCut's γ, β). */
const GAMMA = 50;
/**
 * Capacities are whole multiples of 1 / UNITS: in floating point, residuals that should reach
 * zero are left a hair above it and max-flow then pushes thousands of near-empty paths.
 */
const UNITS = 64;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Work pixels within `r` of the stroke (a polyline in work pixels): a 0/1 mask and the list. */
function strokePixels(points: readonly ImagePoint[], r: number, w: number, h: number): { mask: Uint8Array; list: number[] } {
  const mask = new Uint8Array(w * h);
  const list: number[] = [];
  const add = (g: number) => {
    if (!mask[g]) {
      mask[g] = 1;
      list.push(g);
    }
  };
  const segs = points.length === 1 ? [[points[0], points[0]]] : points.slice(1).map((p, i) => [points[i], p]);
  for (const [a, b] of segs) {
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - r));
    const x1 = Math.min(w - 1, Math.ceil(Math.max(a.x, b.x) + r));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - r));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y) + r));
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - a.x;
        const py = y + 0.5 - a.y;
        const t = len2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / len2)) : 0;
        if ((px - t * dx) ** 2 + (py - t * dy) ** 2 <= r * r) add(y * w + x);
      }
    }
  }
  // A brush smaller than a work pixel still covers the pixel it is in.
  if (!list.length) {
    for (const p of points) add(Math.min(h - 1, Math.max(0, Math.floor(p.y))) * w + Math.min(w - 1, Math.max(0, Math.floor(p.x))));
  }
  return { mask, list };
}

/**
 * The region one stroke selects, in work pixels: 1 inside, 0 outside, over `roi`. The window
 * around the stroke doubles (up to the whole image) while the region touches its border.
 */
function segmentStroke(work: WorkImage, stroke: { mask: Uint8Array; list: number[] }, grown: Uint8Array | null, start: Rect): { roi: Rect; label: Uint8Array } {
  const { width: w, height: h, rgb } = work;
  let roi = start;
  for (;;) {
    const { x: rx, y: ry, width: rw, height: rh } = roi;
    const n = rw * rh;
    const fgHist = new Float64Array(BINS ** 3);
    const bgHist = new Float64Array(BINS ** 3);
    let fgN = 0;
    let bgN = 0;
    const atImageEdge = { l: rx === 0, t: ry === 0, r: rx + rw === w, b: ry + rh === h };
    // The colours of the window as a whole: a colour more common under the stroke than around it
    // leans to the selection, one rarer leans away. (A model of the window's border alone can't
    // tell a stroke on a backdrop from the backdrop, as the border is the backdrop too.)
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const g = (ry + y) * w + (rx + x);
        const bin = binOf(rgb, g);
        bgHist[bin]++;
        bgN++;
        if (stroke.mask[g] || grown?.[g]) {
          fgHist[bin]++;
          fgN++;
        }
      }
    }
    const fgCost = costTable(fgHist, fgN);
    const bgCost = costTable(bgHist, bgN);
    // β from the mean squared colour difference between neighbours in the window.
    let sumSq = 0;
    let pairs = 0;
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const g = ((ry + y) * w + rx + x) * 3;
        if (x + 1 < rw) {
          sumSq += (rgb[g] - rgb[g + 3]) ** 2 + (rgb[g + 1] - rgb[g + 4]) ** 2 + (rgb[g + 2] - rgb[g + 5]) ** 2;
          pairs++;
        }
        if (y + 1 < rh) {
          const k = g + w * 3;
          sumSq += (rgb[g] - rgb[k]) ** 2 + (rgb[g + 1] - rgb[k + 1]) ** 2 + (rgb[g + 2] - rgb[k + 2]) ** 2;
          pairs++;
        }
      }
    }
    const beta = 1 / (2 * Math.max(1e-6, sumSq / Math.max(1, pairs)));
    const graph = new GridGraph(rw, rh);
    const HARD = 1e9;
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const p = y * rw + x;
        const g = (ry + y) * w + rx + x;
        if (stroke.mask[g]) graph.addTerminal(p, HARD, 0);
        else {
          const bin = binOf(rgb, g);
          // Source = selected: the source edge is cut (paid) when p ends up outside.
          graph.addTerminal(p, Math.round(bgCost[bin] * UNITS), Math.round(fgCost[bin] * UNITS));
        }
        const c = g * 3;
        if (x + 1 < rw) {
          const d = (rgb[c] - rgb[c + 3]) ** 2 + (rgb[c + 1] - rgb[c + 4]) ** 2 + (rgb[c + 2] - rgb[c + 5]) ** 2;
          graph.setEdge(p, 0, Math.round(GAMMA * UNITS * Math.exp(-beta * d)));
        }
        if (y + 1 < rh) {
          const k = c + w * 3;
          const d = (rgb[c] - rgb[k]) ** 2 + (rgb[c + 1] - rgb[k + 1]) ** 2 + (rgb[c + 2] - rgb[k + 2]) ** 2;
          graph.setEdge(p, 1, Math.round(GAMMA * UNITS * Math.exp(-beta * d)));
        }
      }
    }
    graph.maxflow();
    // Only what joins on to the stroke: a similar colour elsewhere is a separate area to paint.
    const label = new Uint8Array(n);
    const stack: number[] = [];
    for (const g of stroke.list) {
      const x = (g % w) - rx;
      const y = Math.floor(g / w) - ry;
      if (x < 0 || y < 0 || x >= rw || y >= rh) continue;
      const p = y * rw + x;
      if (!label[p]) {
        label[p] = 1;
        stack.push(p);
      }
    }
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % rw;
      for (const q of [x + 1 < rw ? p + 1 : -1, x > 0 ? p - 1 : -1, p + rw < n ? p + rw : -1, p - rw]) {
        if (q >= 0 && !label[q] && graph.inSource(q)) {
          label[q] = 1;
          stack.push(q);
        }
      }
    }
    let touches = false;
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const p = y * rw + x;
        if (!label[p]) continue;
        if ((!atImageEdge.l && x === 0) || (!atImageEdge.t && y === 0) || (!atImageEdge.r && x === rw - 1) || (!atImageEdge.b && y === rh - 1)) touches = true;
      }
    }
    if (!touches || (atImageEdge.l && atImageEdge.t && atImageEdge.r && atImageEdge.b)) return { roi, label };
    // The region runs on past the window: look again in one twice the size, or in the whole
    // image once that would cover most of it.
    const nx = Math.max(0, rx - Math.ceil(rw / 2));
    const ny = Math.max(0, ry - Math.ceil(rh / 2));
    roi = { x: nx, y: ny, width: Math.min(w, rx + rw + Math.ceil(rw / 2)) - nx, height: Math.min(h, ry + rh + Math.ceil(rh / 2)) - ny };
    if (roi.width * roi.height * 2.5 > w * h) roi = { x: 0, y: 0, width: w, height: h };
  }
}

/** A 3 × 3 box blur of `src` (w × h), `passes` times. */
function boxBlur(src: Float32Array, w: number, h: number, passes: number): Float32Array {
  let a = src;
  for (let k = 0; k < passes; k++) {
    const b = new Float32Array(a.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        let c = 0;
        for (let j = Math.max(0, y - 1); j <= Math.min(h - 1, y + 1); j++) {
          for (let i = Math.max(0, x - 1); i <= Math.min(w - 1, x + 1); i++) {
            s += a[j * w + i];
            c++;
          }
        }
        b[y * w + x] = s / c;
      }
    }
    a = b;
  }
  return a;
}

/**
 * The region of the work-image `label` over `roi` at natural size: inside and outside as they
 * are, and the pixels along the edge anti-aliased by where their colour lies between the region's
 * colour and the surroundings' just either side.
 */
function upscaleRegion(work: WorkImage, pixels: PixelBuffer, roi: Rect, label: Uint8Array, enhance: boolean): SelectionMask {
  const { sourceWidth: W, sourceHeight: H, scale, rgb, width: ww } = work;
  const { x: rx, y: ry, width: rw, height: rh } = roi;
  let soft: Float32Array = Float32Array.from(label);
  if (enhance) {
    // Smooth the blocky outline, then make it hard again where it is clearly in or out.
    soft = boxBlur(soft, rw, rh, 2);
    for (let i = 0; i < soft.length; i++) soft[i] = Math.min(1, Math.max(0, (soft[i] - 0.5) * 3 + 0.5));
  }
  const X0 = Math.max(0, Math.floor(rx / scale));
  const Y0 = Math.max(0, Math.floor(ry / scale));
  const X1 = Math.min(W, Math.ceil((rx + rw) / scale));
  const Y1 = Math.min(H, Math.ceil((ry + rh) / scale));
  const RW = X1 - X0;
  const RH = Y1 - Y0;
  const out = new Uint8Array(RW * RH);
  const at = (x: number, y: number) => soft[Math.min(rh - 1, Math.max(0, y)) * rw + Math.min(rw - 1, Math.max(0, x))];
  const data = pixels.data;
  // Work-pixel column of each output column, and whether each 2 × 2 cell of the reduced region is
  // all in (1), all out (0) or on the edge (2): most of a large region is filled a run at a time.
  const colOf = new Int32Array(RW);
  const fxOf = new Float32Array(RW);
  for (let X = 0; X < RW; X++) {
    const u = (X0 + X + 0.5) * scale - 0.5 - rx;
    colOf[X] = Math.floor(u);
    fxOf[X] = u - colOf[X];
  }
  const cellState = (i: number, j: number) => {
    const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
    if (a === 1 && b === 1 && c === 1 && d === 1) return 1;
    if (a === 0 && b === 0 && c === 0 && d === 0) return 0;
    return 2;
  };
  for (let Y = 0; Y < RH; Y++) {
    const v = (Y0 + Y + 0.5) * scale - 0.5 - ry;
    const j = Math.floor(v);
    const fy = v - j;
    for (let X = 0; X < RW; X++) {
      const i = colOf[X];
      const state = cellState(i, j);
      if (state !== 2) {
        let end = X + 1;
        while (end < RW && colOf[end] === i) end++;
        if (state === 1) out.fill(255, Y * RW + X, Y * RW + end);
        X = end - 1;
        continue;
      }
      const fx = fxOf[X];
      const m = (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy;
      if (m <= 0.001 || m >= 0.999) {
        out[Y * RW + X] = m >= 0.999 ? 255 : 0;
        continue;
      }
      // On the edge: mean colours of the region and of the rest in the 4 × 4 work pixels around.
      let fr = 0, fg = 0, fb = 0, fn = 0, br = 0, bg = 0, bb = 0, bn = 0;
      for (let jj = j - 1; jj <= j + 2; jj++) {
        for (let ii = i - 1; ii <= i + 2; ii++) {
          if (ii < 0 || jj < 0 || ii >= rw || jj >= rh) continue;
          const k = ((ry + jj) * ww + rx + ii) * 3;
          if (soft[jj * rw + ii] >= 0.5) {
            fr += rgb[k]; fg += rgb[k + 1]; fb += rgb[k + 2]; fn++;
          } else {
            br += rgb[k]; bg += rgb[k + 1]; bb += rgb[k + 2]; bn++;
          }
        }
      }
      let alpha = m;
      if (fn && bn) {
        fr /= fn; fg /= fn; fb /= fn; br /= bn; bg /= bn; bb /= bn;
        const dr = fr - br, dg = fg - bg, db = fb - bb;
        const len2 = dr * dr + dg * dg + db * db;
        if (len2 > 400) {
          const p = ((Y0 + Y) * W + X0 + X) * 4;
          const a = data[p + 3] / 255;
          const cr = data[p] * a + 255 * (1 - a) - br;
          const cg = data[p + 1] * a + 255 * (1 - a) - bg;
          const cb = data[p + 2] * a + 255 * (1 - a) - bb;
          // The colour's position between the two, kept near the scaled-up edge.
          const proj = Math.min(1, Math.max(0, (cr * dr + cg * dg + cb * db) / len2));
          alpha = Math.min(1, Math.max(0, proj * 0.75 + m * 0.25));
        } else alpha = Math.min(1, Math.max(0, (m - 0.5) * 2 + 0.5));
      }
      out[Y * RW + X] = Math.round(alpha * 255);
    }
  }
  return selectionFromRegion(W, H, { x: X0, y: Y0, width: RW, height: RH }, out);
}

/**
 * The region one Quick Selection stroke selects over `pixels`, as a selection of the whole image
 * (not yet combined with the current one). `stroke` is the brush's path in natural pixels.
 */
export function quickSelectStroke(pixels: PixelBuffer, stroke: readonly ImagePoint[], options: QuickSelectOptions = {}): SelectionMask {
  if (!stroke.length) throw new Error('A stroke needs at least one point.');
  const work = workImage(pixels);
  const { width: w, height: h, scale } = work;
  const r = Math.max(0.5, ((options.size ?? 30) / 2) * scale);
  const pts = stroke.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  const seeds = strokePixels(pts, r, w, h);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const margin = Math.max(24, 4 * r);
  const rx = Math.max(0, Math.floor(x0 - margin));
  const ry = Math.max(0, Math.floor(y0 - margin));
  const roi = { x: rx, y: ry, width: Math.min(w, Math.ceil(x1 + margin)) - rx, height: Math.min(h, Math.ceil(y1 + margin)) - ry };
  // With Add, what is already selected near the stroke counts as part of the region's colours.
  let grown: Uint8Array | null = null;
  const sel = options.grow ? options.selection : null;
  if (sel?.bounds) {
    grown = new Uint8Array(w * h);
    const b = sel.bounds;
    for (let y = Math.max(0, Math.floor(b.y * scale)); y < Math.min(h, Math.ceil((b.y + b.height) * scale)); y++) {
      for (let x = Math.max(0, Math.floor(b.x * scale)); x < Math.min(w, Math.ceil((b.x + b.width) * scale)); x++) {
        if (selectionValueAt(sel, Math.min(sel.width - 1, Math.floor((x + 0.5) / scale)), Math.min(sel.height - 1, Math.floor((y + 0.5) / scale))) >= 0.5) grown[y * w + x] = 1;
      }
    }
  }
  const { roi: done, label } = segmentStroke(work, seeds, grown, roi);
  return upscaleRegion(work, pixels, done, label, options.enhanceEdge ?? false);
}
