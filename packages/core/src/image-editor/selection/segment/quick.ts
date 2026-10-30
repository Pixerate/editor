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
import { selectionValueAt, type PixelBuffer, type SelectionMask } from '../mask';
import { GridGraph } from './maxflow';
import { UNITS, smoothnessWeights, upscaleRegion, workImage, type Rect, type WorkImage } from './work';

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
    const { right, down } = smoothnessWeights(work, roi);
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
        if (x + 1 < rw) graph.setEdge(p, 0, right[p]);
        if (y + 1 < rh) graph.setEdge(p, 1, down[p]);
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
