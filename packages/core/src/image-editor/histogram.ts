// Portions ported from photocraft-main/crates/algo/src/histogram.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/** Display bins of a histogram. */
export const HISTOGRAM_BINS = 256;

export interface ImageHistogram {
  /** 256-bin counts per channel. */
  red: Uint32Array;
  green: Uint32Array;
  blue: Uint32Array;
  /** 256-bin counts of Rec.709 luma `round(0.2126 R + 0.7152 G + 0.0722 B)` of the encoded values. */
  luminance: Uint32Array;
  /** Visible pixels counted (alpha > 0). Each counts once, partially transparent ones included. */
  samples: number;
  /** Fully transparent pixels, excluded from every bin. */
  transparent: number;
  /** Per channel (R, G, B): visible pixels at exactly 0. */
  shadows: [number, number, number];
  /** Per channel (R, G, B): visible pixels at exactly 255. */
  highlights: [number, number, number];
  /** Largest bin count over R, G, B and luminance (for scaling a plot). */
  max: number;
}

interface PixelSource {
  data: ArrayLike<number>;
  width?: number;
  height?: number;
}

/**
 * Per-channel and luminance histograms of straight 8-bit RGBA pixels (an `ImageData` or anything
 * with `data`), with clipping counts at the exact endpoints. Transparent pixels cannot add
 * phantom peaks: they are counted separately and excluded.
 */
export function computeHistogram(imageData: PixelSource): ImageHistogram {
  const red = new Uint32Array(HISTOGRAM_BINS);
  const green = new Uint32Array(HISTOGRAM_BINS);
  const blue = new Uint32Array(HISTOGRAM_BINS);
  const luminance = new Uint32Array(HISTOGRAM_BINS);
  const shadows: [number, number, number] = [0, 0, 0];
  const highlights: [number, number, number] = [0, 0, 0];
  let samples = 0;
  let transparent = 0;
  const data = imageData.data;
  const len = data.length - (data.length % 4);
  for (let i = 0; i < len; i += 4) {
    if (!(data[i + 3] > 0)) {
      transparent++;
      continue;
    }
    samples++;
    const r = clampByte(data[i]);
    const g = clampByte(data[i + 1]);
    const b = clampByte(data[i + 2]);
    red[r]++;
    green[g]++;
    blue[b]++;
    luminance[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
    if (r === 0) shadows[0]++;
    if (g === 0) shadows[1]++;
    if (b === 0) shadows[2]++;
    if (r === 255) highlights[0]++;
    if (g === 255) highlights[1]++;
    if (b === 255) highlights[2]++;
  }
  let max = 0;
  for (const bins of [red, green, blue, luminance]) {
    for (let k = 0; k < HISTOGRAM_BINS; k++) if (bins[k] > max) max = bins[k];
  }
  return { red, green, blue, luminance, samples, transparent, shadows, highlights, max };
}

function clampByte(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

export type HistogramChannel = 'red' | 'green' | 'blue' | 'luminance';

/**
 * An SVG path (`M … Z`) of one channel scaled into a `width` × `height` box, bins left to right,
 * counts up from the bottom. `scale: 'sqrt'` (default) keeps small populations visible.
 */
export function histogramPath(
  histogram: ImageHistogram,
  channel: HistogramChannel,
  width: number,
  height: number,
  options: { scale?: 'linear' | 'sqrt'; max?: number } = {}
): string {
  const bins = histogram[channel];
  const sqrt = (options.scale ?? 'sqrt') === 'sqrt';
  const f = (v: number) => (sqrt ? Math.sqrt(v) : v);
  const top = f(options.max ?? histogram.max) || 1;
  const dx = width / (HISTOGRAM_BINS - 1);
  let d = `M0 ${height}`;
  for (let k = 0; k < HISTOGRAM_BINS; k++) {
    const y = height - (f(bins[k]) / top) * height;
    d += ` L${round2(k * dx)} ${round2(y)}`;
  }
  return `${d} L${round2(width)} ${height} Z`;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
