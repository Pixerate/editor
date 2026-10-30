/**
 * Select Subject without a segmentation model: the most salient subject, found classically.
 *
 * 1. SLIC superpixels (Achanta et al., 2012) group the reduced image into a few hundred patches of
 *    similar colour.
 * 2. Each patch's saliency is how unlike the image's border it is (the border is mostly
 *    background), times how much it contrasts with the patches around it (region contrast, Cheng
 *    et al., 2015), times a mild preference for the centre.
 * 3. Otsu's threshold splits the patches into a first guess at the subject.
 * 4. GrabCut refines that guess along the image's edges, with the clearly-background border fixed.
 *
 * It cannot tell which object a description names: it selects what stands out.
 */

import type { PixelBuffer, SelectionMask } from '../mask';
import { createSelectionMask } from '../mask';
import { grabCutLabels, keepMainPieces } from './grabcut';
import { upscaleRegion, workImage, type SelectionProgress, type WorkImage } from './work';

/** sRGB (0..255) to CIE L*a*b* (D65). */
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

export interface Superpixels {
  /** Superpixel of each work pixel. */
  label: Int32Array;
  count: number;
  /** Mean L*a*b* per superpixel, 3 values each. */
  lab: Float64Array;
  /** Mean position per superpixel, in work pixels, 2 values each. */
  centre: Float64Array;
  size: Int32Array;
}

/** SLIC superpixels of the work image: about `target` of them, `compactness` 10 (L*a*b* units). */
export function slicSuperpixels(work: WorkImage, target = 400, compactness = 10, rounds = 5): Superpixels {
  const { width: w, height: h, rgb } = work;
  const n = w * h;
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) lab.set(toLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]), i * 3);
  const S = Math.max(2, Math.round(Math.sqrt(n / target)));
  const seeds: number[][] = [];
  for (let y = Math.floor(S / 2); y < h; y += S) {
    for (let x = Math.floor(S / 2); x < w; x += S) {
      const i = y * w + x;
      seeds.push([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2], x, y]);
    }
  }
  const k = seeds.length;
  const label = new Int32Array(n).fill(-1);
  const best = new Float64Array(n);
  const m2 = (compactness / S) ** 2;
  for (let round = 0; round < rounds; round++) {
    best.fill(Infinity);
    for (let c = 0; c < k; c++) {
      const [L, A, B, cx, cy] = seeds[c];
      const x0 = Math.max(0, Math.floor(cx - S));
      const x1 = Math.min(w - 1, Math.ceil(cx + S));
      const y0 = Math.max(0, Math.floor(cy - S));
      const y1 = Math.min(h - 1, Math.ceil(cy + S));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * w + x;
          const d = (lab[i * 3] - L) ** 2 + (lab[i * 3 + 1] - A) ** 2 + (lab[i * 3 + 2] - B) ** 2 + m2 * ((x - cx) ** 2 + (y - cy) ** 2);
          if (d < best[i]) {
            best[i] = d;
            label[i] = c;
          }
        }
      }
    }
    const sum = new Float64Array(k * 6);
    for (let i = 0; i < n; i++) {
      const c = label[i];
      sum[c * 6] += lab[i * 3];
      sum[c * 6 + 1] += lab[i * 3 + 1];
      sum[c * 6 + 2] += lab[i * 3 + 2];
      sum[c * 6 + 3] += i % w;
      sum[c * 6 + 4] += Math.floor(i / w);
      sum[c * 6 + 5]++;
    }
    for (let c = 0; c < k; c++) {
      const s = sum[c * 6 + 5];
      if (s) seeds[c] = [sum[c * 6] / s, sum[c * 6 + 1] / s, sum[c * 6 + 2] / s, sum[c * 6 + 3] / s, sum[c * 6 + 4] / s];
    }
  }
  // Renumber to the superpixels that kept pixels.
  const remap = new Int32Array(k).fill(-1);
  let count = 0;
  for (let i = 0; i < n; i++) if (remap[label[i]] < 0) remap[label[i]] = count++;
  const meanLab = new Float64Array(count * 3);
  const centre = new Float64Array(count * 2);
  const size = new Int32Array(count);
  for (let i = 0; i < n; i++) {
    const c = (label[i] = remap[label[i]]);
    meanLab[c * 3] += lab[i * 3];
    meanLab[c * 3 + 1] += lab[i * 3 + 1];
    meanLab[c * 3 + 2] += lab[i * 3 + 2];
    centre[c * 2] += i % w;
    centre[c * 2 + 1] += Math.floor(i / w);
    size[c]++;
  }
  for (let c = 0; c < count; c++) {
    for (let j = 0; j < 3; j++) meanLab[c * 3 + j] /= size[c];
    centre[c * 2] /= size[c];
    centre[c * 2 + 1] /= size[c];
  }
  return { label, count, lab: meanLab, centre, size };
}

/** Saliency 0..1 of each superpixel (see the module comment). */
export function superpixelSaliency(sp: Superpixels, width: number, height: number): Float64Array {
  const { count, lab, centre, size, label } = sp;
  const dist = (a: number, b: number) => Math.hypot(lab[a * 3] - lab[b * 3], lab[a * 3 + 1] - lab[b * 3 + 1], lab[a * 3 + 2] - lab[b * 3 + 2]);
  // Superpixels on the image's border.
  const onBorder = new Uint8Array(count);
  for (let x = 0; x < width; x++) {
    onBorder[label[x]] = 1;
    onBorder[label[(height - 1) * width + x]] = 1;
  }
  for (let y = 0; y < height; y++) {
    onBorder[label[y * width]] = 1;
    onBorder[label[y * width + width - 1]] = 1;
  }
  const border: number[] = [];
  for (let c = 0; c < count; c++) if (onBorder[c]) border.push(c);
  const diag = Math.hypot(width, height);
  const unlikeBorder = new Float64Array(count);
  const contrast = new Float64Array(count);
  const centreBias = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    // The quarter-quantile distance to the border: low when much of the border looks like it,
    // even if a subject reaches the border somewhere.
    const ds = border.map((j) => dist(i, j)).sort((a, b) => a - b);
    unlikeBorder[i] = ds.length ? ds[Math.floor(ds.length * 0.25)] : 0;
    let s = 0;
    let wsum = 0;
    for (let j = 0; j < count; j++) {
      if (j === i) continue;
      const dx = (centre[i * 2] - centre[j * 2]) / diag;
      const dy = (centre[i * 2 + 1] - centre[j * 2 + 1]) / diag;
      const wgt = size[j] * Math.exp(-(dx * dx + dy * dy) / (2 * 0.25 * 0.25));
      s += wgt * dist(i, j);
      wsum += wgt;
    }
    contrast[i] = wsum ? s / wsum : 0;
    const cx = centre[i * 2] / width - 0.5;
    const cy = centre[i * 2 + 1] / height - 0.5;
    centreBias[i] = 0.4 + 0.6 * Math.exp(-(cx * cx + cy * cy) / (2 * 0.3 * 0.3));
  }
  // Nothing differs from the border by more than a just-noticeable step (ΔE ≈ 6): no subject.
  let farthest = 0;
  for (const v of unlikeBorder) farthest = Math.max(farthest, v);
  if (farthest < 6) return new Float64Array(count);
  const norm = (a: Float64Array) => {
    let max = 0;
    for (const v of a) max = Math.max(max, v);
    if (max > 0) for (let i = 0; i < a.length; i++) a[i] /= max;
  };
  norm(unlikeBorder);
  norm(contrast);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = unlikeBorder[i] * (0.3 + 0.7 * contrast[i]) * centreBias[i];
  norm(out);
  return out;
}

/** Otsu's threshold of `values` (0..1) weighted by `weights`. */
export function otsuThreshold(values: ArrayLike<number>, weights: ArrayLike<number>): number {
  const BINS = 64;
  const hist = new Float64Array(BINS);
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    hist[Math.min(BINS - 1, Math.floor(values[i] * BINS))] += weights[i];
    total += weights[i];
  }
  let sumAll = 0;
  for (let b = 0; b < BINS; b++) sumAll += b * hist[b];
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let bestT = 0.5;
  for (let b = 0; b < BINS - 1; b++) {
    wB += hist[b];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += b * hist[b];
    const between = wB * wF * (sumB / wB - (sumAll - sumB) / wF) ** 2;
    if (between > best) {
      best = between;
      bestT = (b + 1) / BINS;
    }
  }
  return bestT;
}

/** What {@link findSubject} found. */
export interface FoundSubject {
  selection: SelectionMask;
  /** Why nothing was selected, when nothing was. */
  reason?: string;
}

/**
 * The most salient subject of `pixels` as a selection of the whole image (empty, with a reason,
 * when nothing stands out from the background).
 */
export function findSubject(pixels: PixelBuffer, options: { enhanceEdge?: boolean; onProgress?: SelectionProgress } = {}): FoundSubject {
  const report = options.onProgress;
  report?.(0, 'Reducing the image');
  const work = workImage(pixels);
  const { width: w, height: h } = work;
  report?.(0.1, 'Grouping into superpixels');
  const sp = slicSuperpixels(work);
  report?.(0.3, 'Measuring what stands out');
  const sal = superpixelSaliency(sp, w, h);
  report?.(0.4, 'Finding the subject');
  const t = otsuThreshold(sal, sp.size);
  const n = w * h;
  const initial = new Uint8Array(n);
  const hardBg = new Uint8Array(n);
  const hardFg = new Uint8Array(n);
  const strong = t + 0.6 * (1 - t);
  for (let i = 0; i < n; i++) {
    const s = sal[sp.label[i]];
    if (s >= t) initial[i] = 1;
    if (s >= strong) hardFg[i] = 1;
  }
  // The border's least salient patches are background for certain.
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) if (sal[sp.label[y * w + x]] < t * 0.5) hardBg[y * w + x] = 1;
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) if (sal[sp.label[y * w + x]] < t * 0.5) hardBg[y * w + x] = 1;
  }
  const empty = (reason: string): FoundSubject => ({ selection: createSelectionMask(pixels.width, pixels.height), reason });
  let guessed = 0;
  for (let i = 0; i < n; i++) guessed += initial[i];
  if (!guessed || guessed > n * 0.95) return empty('Nothing stands out from the background.');
  const roi = { x: 0, y: 0, width: w, height: h };
  const label = grabCutLabels(work, { roi, initial, hardBg, hardFg }, 5, (f) => report?.(0.4 + 0.5 * f, 'Finding the subject'));
  keepMainPieces(label, w, h, null);
  let kept = 0;
  for (let i = 0; i < n; i++) kept += label[i];
  if (kept < n * 0.002) return empty('Nothing stands out from the background.');
  if (kept > n * 0.97) return empty('The whole image looks like one subject; select it with select_all instead.');
  report?.(0.9, 'Scaling up');
  const selection = upscaleRegion(work, pixels, roi, label, options.enhanceEdge ?? false);
  report?.(1, 'Done');
  return { selection };
}
