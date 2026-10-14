// Portions ported from photocraft/crates/algo/src/selection.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import type { ImagePoint } from '../types';
import { createSelectionMask, coverageToByte, type PixelBuffer, type SelectionMask } from './mask';

/** How the magic wand measures colour difference. */
export type ColorDistance = 'rgb' | 'perceptual';

export interface MagicWandOptions {
  /**
   * 0..255. `rgb`: the largest per-channel difference in levels (alpha included), as
   * Photoshop's wand. `perceptual`: CIE76 ΔE*ab, with 255 ≙ ΔE 100. Default 32.
   */
  tolerance?: number;
  /** Only the 4-connected region around the seed (default true); otherwise every similar pixel. */
  contiguous?: boolean;
  /** Soft one-pixel fringe on the edge (default true). */
  antiAlias?: boolean;
  /** Default `rgb`. */
  distance?: ColorDistance;
}

function checkPixels(p: PixelBuffer): number {
  const n = p.width * p.height;
  if (!Number.isInteger(p.width) || !Number.isInteger(p.height) || p.width < 1 || p.height < 1) {
    throw new Error('Invalid pixel buffer size');
  }
  if (p.data.length < n * 4) throw new Error('Pixel data is shorter than width × height × 4');
  return n;
}

const SRGB_TO_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    t[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return t;
})();

const labF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);

/** CIE Lab (D65) of an 8-bit sRGB colour. */
export function srgb8ToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = SRGB_TO_LINEAR[r & 255];
  const gl = SRGB_TO_LINEAR[g & 255];
  const bl = SRGB_TO_LINEAR[b & 255];
  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
  const y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl;
  const z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / 1.08883;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** `similar(i)` for the wand: does pixel `i` match the seed colour within the tolerance? */
function similarity(pixels: PixelBuffer, seed: number, tolerance: number, distance: ColorDistance): (i: number) => boolean {
  const d = pixels.data;
  const tr = d[seed * 4];
  const tg = d[seed * 4 + 1];
  const tb = d[seed * 4 + 2];
  const ta = d[seed * 4 + 3];
  const tol = Math.max(0, Math.floor(tolerance + 1e-3));
  if (distance === 'perceptual') {
    const [tl, taa, tbb] = srgb8ToLab(tr, tg, tb);
    const de = (Math.max(0, tolerance) * 100) / 255;
    const de2 = de * de + 1e-6;
    return (i) => {
      const p = i * 4;
      const a = d[p + 3];
      // Copying a selection can leave RGB under zero alpha; hidden colours must not split a
      // transparent region.
      if (ta === 0 && a === 0) return true;
      if (Math.abs(a - ta) > tol) return false;
      const [l, aa, bb] = srgb8ToLab(d[p], d[p + 1], d[p + 2]);
      return (l - tl) ** 2 + (aa - taa) ** 2 + (bb - tbb) ** 2 <= de2;
    };
  }
  return (i) => {
    const p = i * 4;
    const a = d[p + 3];
    if (ta === 0 && a === 0) return true;
    return (
      Math.abs(d[p] - tr) <= tol &&
      Math.abs(d[p + 1] - tg) <= tol &&
      Math.abs(d[p + 2] - tb) <= tol &&
      Math.abs(a - ta) <= tol
    );
  };
}

/**
 * Softens hard edges: an edge pixel (one whose 3×3 neighbourhood differs from it) becomes
 * `½ + ½·avg` if selected, `½·avg` if not (neighbours outside the image count as the pixel).
 * Only the box `x0..x1 × y0..y1` (exclusive ends) is visited.
 */
function antialiasMarks(marks: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const out = marks.slice();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      const v = marks[i];
      let sum = 0;
      let edge = false;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const n = nx < 0 || ny < 0 || nx >= w || ny >= h ? v : marks[ny * w + nx];
          if (n !== v) edge = true;
          sum += n;
        }
      }
      if (edge) {
        const avg = sum / (9 * 255);
        out[i] = Math.round((v > 127 ? 0.5 + 0.5 * avg : 0.5 * avg) * 255);
      }
    }
  }
  return out;
}

/**
 * Magic wand: pixels similar to the seed pixel. Contiguous mode is a scanline span fill with an
 * explicit stack (fill a run, then scan the rows above and below it for new runs), so it is
 * linear in the pixels visited and never recurses. An empty selection when the seed is outside.
 */
export function magicWand(pixels: PixelBuffer, seed: ImagePoint, options: MagicWandOptions = {}): SelectionMask {
  const n = checkPixels(pixels);
  const { width: w, height: h } = pixels;
  const sx = Math.floor(seed.x);
  const sy = Math.floor(seed.y);
  if (!(sx >= 0 && sy >= 0 && sx < w && sy < h)) return createSelectionMask(w, h);
  const similar = similarity(pixels, sy * w + sx, options.tolerance ?? 32, options.distance ?? 'rgb');
  const marks = new Uint8Array(n);
  let bx0 = w;
  let by0 = h;
  let bx1 = -1;
  let by1 = -1;
  if (options.contiguous ?? true) {
    // Span fill. Each stack entry is a seed pixel index.
    const stack: number[] = [sy * w + sx];
    while (stack.length) {
      const idx = stack.pop()!;
      if (marks[idx]) continue;
      const y = (idx / w) | 0;
      const row = y * w;
      let l = idx - row;
      let r = l;
      while (l > 0 && !marks[row + l - 1] && similar(row + l - 1)) l--;
      while (r + 1 < w && !marks[row + r + 1] && similar(row + r + 1)) r++;
      marks.fill(255, row + l, row + r + 1);
      if (l < bx0) bx0 = l;
      if (r > bx1) bx1 = r;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= h) continue;
        const nrow = ny * w;
        let inRun = false;
        for (let nx = l; nx <= r; nx++) {
          const ok = !marks[nrow + nx] && similar(nrow + nx);
          if (ok && !inRun) stack.push(nrow + nx);
          inRun = ok;
        }
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (similar(row + x)) {
          marks[row + x] = 255;
          if (x < bx0) bx0 = x;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          if (y > by1) by1 = y;
        }
      }
    }
  }
  if (bx1 < 0) return createSelectionMask(w, h);
  if (!(options.antiAlias ?? true)) return createSelectionMask(w, h, marks);
  return createSelectionMask(
    w,
    h,
    antialiasMarks(marks, w, h, Math.max(0, bx0 - 1), Math.max(0, by0 - 1), Math.min(w, bx1 + 2), Math.min(h, by1 + 2))
  );
}

/** One Color Range sample: a colour (0..255 levels or `#rrggbb`) and, optionally, where it was picked. */
export interface ColorRangeSample {
  color: readonly [number, number, number] | string;
  at?: ImagePoint;
}

export interface ColorRangeOptions {
  /** 0..200 levels (default 40): coverage falls off linearly to 0 at `fuzziness + 1` levels. */
  fuzziness?: number;
  /**
   * Localized Color Clusters: a sample with a position also fades with distance from it,
   * reaching 0 at this many pixels.
   */
  localized?: number;
}

function sampleColor(c: ColorRangeSample['color']): [number, number, number] {
  if (typeof c === 'string') {
    const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
    if (!m) throw new Error(`Invalid colour "${c}"`);
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  return [c[0], c[1], c[2]];
}

/**
 * Select › Color Range › Sampled Colors: each pixel takes its best match over the samples; a
 * match falls off linearly with the largest per-channel difference, `1 − d / (fuzziness + 1)`.
 * Transparent pixels are never selected.
 */
export function colorRange(pixels: PixelBuffer, samples: readonly ColorRangeSample[], options: ColorRangeOptions = {}): SelectionMask {
  const n = checkPixels(pixels);
  const { width: w, height: h, data } = pixels;
  const f = Math.max(0, options.fuzziness ?? 40) + 1;
  const parsed = samples.map((s) => ({ c: sampleColor(s.color), at: s.at }));
  const radius = options.localized !== undefined ? Math.max(1, options.localized) : undefined;
  const out = new Uint8Array(n);
  if (!parsed.length) return createSelectionMask(w, h, out);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (data[p + 3] <= 0) continue;
    const x = i % w;
    const y = (i - x) / w;
    let best = 0;
    for (const s of parsed) {
      const d = Math.max(Math.abs(data[p] - s.c[0]), Math.abs(data[p + 1] - s.c[1]), Math.abs(data[p + 2] - s.c[2]));
      let k = Math.min(1, Math.max(0, 1 - d / f));
      if (k > 0 && radius !== undefined && s.at) {
        const dist = Math.hypot(x - s.at.x, y - s.at.y);
        k *= Math.min(1, Math.max(0, 1 - dist / radius));
      }
      if (k > best) best = k;
    }
    out[i] = coverageToByte(best);
  }
  return createSelectionMask(w, h, out);
}

export type ToneRangePreset = 'shadows' | 'midtones' | 'highlights';

/** Luma bounds (0..255, Rec. 601) of the tonal presets. */
export const TONE_RANGE_PRESETS: Record<ToneRangePreset, [number, number]> = {
  shadows: [0, 65],
  midtones: [105, 150],
  highlights: [190, 255],
};

/**
 * Select › Color Range › Shadows / Midtones / Highlights: pixels whose luma lies in `lo..hi` are
 * selected; outside, selection falls off linearly to 0 over `falloff` levels.
 */
export function toneRange(
  pixels: PixelBuffer,
  range: ToneRangePreset | readonly [number, number],
  falloff = 20
): SelectionMask {
  const n = checkPixels(pixels);
  const [lo, hi] = typeof range === 'string' ? TONE_RANGE_PRESETS[range] : range;
  const ramp = Math.max(1e-3, falloff);
  const out = new Uint8Array(n);
  const d = pixels.data;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (d[p + 3] <= 0) continue;
    const l = Math.min(255, Math.max(0, 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]));
    const outside = l < lo ? lo - l : l > hi ? l - hi : 0;
    out[i] = coverageToByte(1 - outside / ramp);
  }
  return createSelectionMask(pixels.width, pixels.height, out);
}

/**
 * Select › Color Range › Reds … Magentas (`center` 0, 60, …, 300°): closeness of hue (full at
 * the centre, none 60° away) × chroma × (2 − max), so neutrals are never selected.
 */
export function hueRange(pixels: PixelBuffer, center: number): SelectionMask {
  const n = checkPixels(pixels);
  const out = new Uint8Array(n);
  const d = pixels.data;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (d[p + 3] <= 0) continue;
    const r = d[p] / 255;
    const g = d[p + 1] / 255;
    const b = d[p + 2] / 255;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const chroma = mx - mn;
    if (chroma <= 0) continue;
    let hue: number;
    if (mx === r) hue = (((g - b) / chroma) % 6 + 6) % 6;
    else if (mx === g) hue = (b - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
    hue *= 60;
    let dh = (((hue - center) % 360) + 360) % 360;
    dh = Math.min(dh, 360 - dh);
    out[i] = coverageToByte(Math.min(1, Math.max(0, 1 - dh / 60)) * chroma * (2 - mx));
  }
  return createSelectionMask(pixels.width, pixels.height, out);
}
