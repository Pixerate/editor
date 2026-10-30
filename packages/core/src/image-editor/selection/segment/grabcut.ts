/**
 * Object Selection: GrabCut (Rother, Kolmogorov & Blake, 2004) from a box drawn around an object
 * or a click on it. Two colour models, mixtures of five Gaussians each, are fitted to what is
 * currently inside and outside the object; a graph cut relabels every pixel by them and by the
 * edges between neighbours; the two steps repeat until the labels settle. It runs on the reduced
 * copy of the image and is scaled back up with an anti-aliased edge, as Quick Selection is.
 */

import type { CropBox, ImagePoint } from '../../types';
import { createSelectionMask, type PixelBuffer, type SelectionMask } from '../mask';
import { GridGraph } from './maxflow';
import { UNITS, smoothnessWeights, upscaleRegion, workImage, type Rect, type WorkImage } from './work';

const K = 5;

/** A mixture of {@link K} full-covariance Gaussians over RGB. */
export class ColorGmm {
  private readonly logWeight = new Float64Array(K);
  private readonly mean = new Float64Array(K * 3);
  /** Inverse covariances, row-major 3 × 3. */
  private readonly inv = new Float64Array(K * 9);
  /** ln(weight) − ½ ln((2π)³ |Σ|) per component; −∞ for an empty one. */
  private readonly logNorm = new Float64Array(K).fill(-Infinity);

  /** Fits the components to the pixels `ids` of `rgb`, each in component `comp[id]`. */
  fit(rgb: Float32Array, ids: ArrayLike<number>, comp: Uint8Array): void {
    const n = new Float64Array(K);
    const sum = new Float64Array(K * 3);
    const prod = new Float64Array(K * 9);
    for (let t = 0; t < ids.length; t++) {
      const i = ids[t];
      const k = comp[i];
      const c = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
      n[k]++;
      for (let a = 0; a < 3; a++) {
        sum[k * 3 + a] += c[a];
        for (let b = 0; b < 3; b++) prod[k * 9 + a * 3 + b] += c[a] * c[b];
      }
    }
    const total = ids.length || 1;
    for (let k = 0; k < K; k++) {
      if (!n[k]) {
        this.logNorm[k] = -Infinity;
        continue;
      }
      const m = [sum[k * 3] / n[k], sum[k * 3 + 1] / n[k], sum[k * 3 + 2] / n[k]];
      const cov = new Float64Array(9);
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) cov[a * 3 + b] = prod[k * 9 + a * 3 + b] / n[k] - m[a] * m[b];
        // A floor on the variance, so a flat colour doesn't become an infinitely narrow peak.
        cov[a * 4] += 4;
      }
      const det =
        cov[0] * (cov[4] * cov[8] - cov[5] * cov[7]) - cov[1] * (cov[3] * cov[8] - cov[5] * cov[6]) + cov[2] * (cov[3] * cov[7] - cov[4] * cov[6]);
      const d = Math.max(det, 1e-6);
      const inv = [
        (cov[4] * cov[8] - cov[5] * cov[7]) / d,
        (cov[2] * cov[7] - cov[1] * cov[8]) / d,
        (cov[1] * cov[5] - cov[2] * cov[4]) / d,
        (cov[5] * cov[6] - cov[3] * cov[8]) / d,
        (cov[0] * cov[8] - cov[2] * cov[6]) / d,
        (cov[2] * cov[3] - cov[0] * cov[5]) / d,
        (cov[3] * cov[7] - cov[4] * cov[6]) / d,
        (cov[1] * cov[6] - cov[0] * cov[7]) / d,
        (cov[0] * cov[4] - cov[1] * cov[3]) / d,
      ];
      this.mean.set(m, k * 3);
      this.inv.set(inv, k * 9);
      this.logWeight[k] = Math.log(n[k] / total);
      this.logNorm[k] = this.logWeight[k] - 0.5 * Math.log(Math.pow(2 * Math.PI, 3) * d);
    }
  }

  /** ln p(colour | component k), up to the shared constant. */
  private componentLog(k: number, r: number, g: number, b: number): number {
    const ln = this.logNorm[k];
    if (ln === -Infinity) return -Infinity;
    const dr = r - this.mean[k * 3];
    const dg = g - this.mean[k * 3 + 1];
    const db = b - this.mean[k * 3 + 2];
    const v = this.inv;
    const o = k * 9;
    const q = dr * (v[o] * dr + v[o + 1] * dg + v[o + 2] * db) + dg * (v[o + 3] * dr + v[o + 4] * dg + v[o + 5] * db) + db * (v[o + 6] * dr + v[o + 7] * dg + v[o + 8] * db);
    return ln - 0.5 * q;
  }

  /** −ln p(colour) under the mixture (large for colours the model hasn't seen). */
  cost(r: number, g: number, b: number): number {
    let best = -Infinity;
    const logs = new Array<number>(K);
    for (let k = 0; k < K; k++) {
      logs[k] = this.componentLog(k, r, g, b);
      if (logs[k] > best) best = logs[k];
    }
    if (best === -Infinity) return 50;
    let s = 0;
    for (let k = 0; k < K; k++) if (logs[k] > -Infinity) s += Math.exp(logs[k] - best);
    return Math.min(50, -(best + Math.log(s)));
  }

  /** The component most likely to have produced the colour. */
  nearest(r: number, g: number, b: number): number {
    let best = 0;
    let bestLog = -Infinity;
    for (let k = 0; k < K; k++) {
      const l = this.componentLog(k, r, g, b);
      if (l > bestLog) {
        bestLog = l;
        best = k;
      }
    }
    return best;
  }
}

/** Starting components for `ids`: k-means (from spread-out seeds) on up to 6000 of them. */
function initialComponents(rgb: Float32Array, ids: number[], comp: Uint8Array): void {
  if (!ids.length) return;
  const step = Math.max(1, Math.floor(ids.length / 6000));
  const sample: number[] = [];
  for (let t = 0; t < ids.length; t += step) sample.push(ids[t]);
  const centres: number[][] = [];
  const dist2 = (i: number, c: number[]) => (rgb[i * 3] - c[0]) ** 2 + (rgb[i * 3 + 1] - c[1]) ** 2 + (rgb[i * 3 + 2] - c[2]) ** 2;
  // Farthest-point seeds: deterministic, and they cover every distinct colour in the sample.
  centres.push([rgb[sample[0] * 3], rgb[sample[0] * 3 + 1], rgb[sample[0] * 3 + 2]]);
  const near = sample.map((i) => dist2(i, centres[0]));
  while (centres.length < K) {
    let far = 0;
    for (let t = 1; t < sample.length; t++) if (near[t] > near[far]) far = t;
    const i = sample[far];
    const c = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
    centres.push(c);
    for (let t = 0; t < sample.length; t++) near[t] = Math.min(near[t], dist2(sample[t], c));
  }
  const closest = (i: number) => {
    let best = 0;
    for (let k = 1; k < K; k++) if (dist2(i, centres[k]) < dist2(i, centres[best])) best = k;
    return best;
  };
  for (let round = 0; round < 6; round++) {
    const sum = Array.from({ length: K }, () => [0, 0, 0, 0]);
    for (const i of sample) {
      const s = sum[closest(i)];
      s[0] += rgb[i * 3];
      s[1] += rgb[i * 3 + 1];
      s[2] += rgb[i * 3 + 2];
      s[3]++;
    }
    for (let k = 0; k < K; k++) if (sum[k][3]) centres[k] = [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]];
  }
  for (const i of ids) comp[i] = closest(i);
}

/** Pixels fixed to one side, and a starting guess, over a window of the work image. */
export interface GrabCutSetup {
  roi: Rect;
  /** Per window pixel: 1 = starts inside the object. */
  initial: Uint8Array;
  /** Per window pixel: 1 = fixed outside. */
  hardBg: Uint8Array;
  /** Per window pixel: 1 = fixed inside. */
  hardFg: Uint8Array | null;
}

/** GrabCut over the setup's window; returns 1 for the object per window pixel. */
export function grabCutLabels(work: WorkImage, setup: GrabCutSetup, iterations: number): Uint8Array {
  const { width: w, rgb } = work;
  const { roi, hardBg, hardFg } = setup;
  const { x: rx, y: ry, width: rw, height: rh } = roi;
  const n = rw * rh;
  const label = setup.initial.slice();
  const global = new Int32Array(n);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) global[y * rw + x] = (ry + y) * w + rx + x;
  const comp = new Uint8Array(w * work.height);
  const fg = new ColorGmm();
  const bg = new ColorGmm();
  const { right, down } = smoothnessWeights(work, roi);
  const HARD = 1e9;
  for (let iter = 0; iter < iterations; iter++) {
    const fgIds: number[] = [];
    const bgIds: number[] = [];
    for (let p = 0; p < n; p++) (label[p] ? fgIds : bgIds).push(global[p]);
    if (!fgIds.length) return label;
    if (iter === 0) {
      initialComponents(rgb, fgIds, comp);
      initialComponents(rgb, bgIds, comp);
    } else {
      for (const i of fgIds) comp[i] = fg.nearest(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
      for (const i of bgIds) comp[i] = bg.nearest(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    }
    fg.fit(rgb, fgIds, comp);
    bg.fit(rgb, bgIds, comp);
    const graph = new GridGraph(rw, rh);
    for (let p = 0; p < n; p++) {
      if (hardBg[p]) graph.addTerminal(p, 0, HARD);
      else if (hardFg?.[p]) graph.addTerminal(p, HARD, 0);
      else {
        const i = global[p] * 3;
        // Source = the object: its edge is cut (paid) when p ends up outside.
        graph.addTerminal(p, Math.round(bg.cost(rgb[i], rgb[i + 1], rgb[i + 2]) * UNITS), Math.round(fg.cost(rgb[i], rgb[i + 1], rgb[i + 2]) * UNITS));
      }
      if ((p % rw) + 1 < rw) graph.setEdge(p, 0, right[p]);
      if (p + rw < n) graph.setEdge(p, 1, down[p]);
    }
    graph.maxflow();
    let changed = 0;
    for (let p = 0; p < n; p++) {
      const v = graph.inSource(p) ? 1 : 0;
      if (v !== label[p]) changed++;
      label[p] = v;
    }
    if (changed <= n * 0.001) break;
  }
  return label;
}

/**
 * Keeps the object's main parts: the pieces (4-connected) holding `seed` (window index), or
 * without one, every piece at least a fifth the size of the largest.
 */
export function keepMainPieces(label: Uint8Array, rw: number, rh: number, seed: number | null): void {
  const n = rw * rh;
  const piece = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (!label[s] || piece[s] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    piece[s] = id;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % rw;
      for (const q of [x + 1 < rw ? p + 1 : -1, x > 0 ? p - 1 : -1, p + rw < n ? p + rw : -1, p - rw]) {
        if (q >= 0 && label[q] && piece[q] < 0) {
          piece[q] = id;
          stack.push(q);
        }
      }
    }
    sizes.push(size);
  }
  if (!sizes.length) return;
  const largest = Math.max(...sizes);
  const keep = (id: number) => (seed !== null && piece[seed] >= 0 ? id === piece[seed] : sizes[id] * 5 >= largest);
  for (let p = 0; p < n; p++) if (label[p] && !keep(piece[p])) label[p] = 0;
}

export interface ObjectSelectionOptions {
  /** Smoother, less blocky edges (Auto-Enhance). Default false. */
  enhanceEdge?: boolean;
  /** Most rounds of fitting and cutting (default 5; it stops early once the labels settle). */
  iterations?: number;
}

/** What to select: a box around the object, or a point on it (natural pixels). */
export type ObjectTarget = { rect: CropBox } | { point: ImagePoint };

/**
 * Object Selection over `pixels`: the object in `target.rect` (everything outside the box is
 * background), or the object under `target.point` (searched for in a window around it that grows
 * while the object reaches its border). Returns a selection of the whole image, empty when
 * nothing stands out.
 */
export function selectObjectIn(pixels: PixelBuffer, target: ObjectTarget, options: ObjectSelectionOptions = {}): SelectionMask {
  const work = workImage(pixels);
  const { width: w, height: h, scale } = work;
  const iterations = Math.max(1, Math.round(options.iterations ?? 5));
  const enhance = options.enhanceEdge ?? false;
  if ('rect' in target) {
    const r = target.rect;
    const bx0 = Math.max(0, Math.floor(r.x * scale));
    const by0 = Math.max(0, Math.floor(r.y * scale));
    const bx1 = Math.min(w, Math.ceil((r.x + r.width) * scale));
    const by1 = Math.min(h, Math.ceil((r.y + r.height) * scale));
    if (bx1 - bx0 < 2 || by1 - by0 < 2) return createSelectionMask(pixels.width, pixels.height);
    // The box plus a band of background around it to learn the background's colours from.
    const m = Math.max(8, Math.round(0.25 * Math.max(bx1 - bx0, by1 - by0)));
    const rx = Math.max(0, bx0 - m);
    const ry = Math.max(0, by0 - m);
    const roi = { x: rx, y: ry, width: Math.min(w, bx1 + m) - rx, height: Math.min(h, by1 + m) - ry };
    const n = roi.width * roi.height;
    const initial = new Uint8Array(n);
    const hardBg = new Uint8Array(n);
    for (let y = 0; y < roi.height; y++) {
      for (let x = 0; x < roi.width; x++) {
        const gx = rx + x;
        const gy = ry + y;
        const inside = gx >= bx0 && gx < bx1 && gy >= by0 && gy < by1;
        initial[y * roi.width + x] = inside ? 1 : 0;
        hardBg[y * roi.width + x] = inside ? 0 : 1;
      }
    }
    const label = grabCutLabels(work, { roi, initial, hardBg, hardFg: null }, iterations);
    keepMainPieces(label, roi.width, roi.height, null);
    return upscaleRegion(work, pixels, roi, label, enhance);
  }
  const px = Math.min(w - 1, Math.max(0, Math.floor(target.point.x * scale)));
  const py = Math.min(h - 1, Math.max(0, Math.floor(target.point.y * scale)));
  // A box around the click with a band of background inside its edge: GrabCut as from a box,
  // with the clicked pixels fixed to the object and only the piece holding them kept.
  let half = Math.max(24, Math.round(0.3 * Math.max(w, h)));
  for (;;) {
    const rx = Math.max(0, px - half);
    const ry = Math.max(0, py - half);
    const roi = { x: rx, y: ry, width: Math.min(w, px + half + 1) - rx, height: Math.min(h, py + half + 1) - ry };
    const whole = roi.width === w && roi.height === h;
    const band = Math.max(4, Math.round(0.15 * half));
    const n = roi.width * roi.height;
    const initial = new Uint8Array(n);
    const hardBg = new Uint8Array(n);
    const hardFg = new Uint8Array(n);
    // The band runs along the window's sides inside the image; at the image's own edge there is none.
    const inBand = (x: number, y: number) =>
      (rx > 0 && x < band) || (ry > 0 && y < band) || (rx + roi.width < w && x >= roi.width - band) || (ry + roi.height < h && y >= roi.height - band);
    for (let y = 0; y < roi.height; y++) {
      for (let x = 0; x < roi.width; x++) {
        const p = y * roi.width + x;
        if (inBand(x, y)) hardBg[p] = 1;
        else initial[p] = 1;
        if (Math.hypot(rx + x - px, ry + y - py) <= 1.5) hardFg[p] = 1;
      }
    }
    const label = grabCutLabels(work, { roi, initial, hardBg, hardFg }, iterations);
    keepMainPieces(label, roi.width, roi.height, (py - ry) * roi.width + (px - rx));
    // Reaching the band means the object may run on past the window: look again in a larger one.
    let touches = false;
    for (let y = 0; y < roi.height && !touches; y++) {
      for (let x = 0; x < roi.width; x++) {
        if (label[y * roi.width + x] && (inBand(x - 1, y) || inBand(x + 1, y) || inBand(x, y - 1) || inBand(x, y + 1))) {
          touches = true;
          break;
        }
      }
    }
    if (!touches || whole) return upscaleRegion(work, pixels, roi, label, enhance);
    half = Math.round(half * 1.6);
  }
}
