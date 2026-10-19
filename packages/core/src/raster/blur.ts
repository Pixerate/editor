// Portions ported from photocraft/crates/algo/src/selection_blur.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/** Separable Gaussian blur of single-channel float planes (mask feather, selection feather). */

/** Normalised Gaussian kernel of σ, truncated at ⌈3σ⌉. */
function gaussianKernel(sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    s += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

/** Above this σ a Gaussian is approximated by three box passes (cost independent of σ). */
export const DIRECT_GAUSSIAN_MAX_SIGMA = 8;

/** Box sizes of three passes whose combined variance matches σ² (Kovesi). */
function boxRadii(sigma: number): [number, number, number] {
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = [0, 1, 2].map((i) => (i < m ? wl : wu));
  return sizes.map((s) => (s - 1) / 2) as [number, number, number];
}

/** How a blur treats pixels beyond the image: `zero`, or `clamp` (replicate the border). */
export type BlurEdge = 'zero' | 'clamp';
type Edge = BlurEdge;

function convolveLine(src: Float32Array, off: number, stride: number, len: number, k: Float32Array, edge: Edge, dst: Float32Array) {
  const r = (k.length - 1) / 2;
  for (let i = 0; i < len; i++) {
    let a = 0;
    const lo = i - r;
    for (let j = 0; j < k.length; j++) {
      let x = lo + j;
      if (x < 0 || x >= len) {
        if (edge === 'zero') continue;
        x = x < 0 ? 0 : len - 1;
      }
      a += src[off + x * stride] * k[j];
    }
    dst[i] = a;
  }
}

/**
 * Three box passes along one line, run on the line padded by the passes' total reach (zeros or
 * replicated ends), so the result equals one convolution with the combined kernel over the
 * same outside values — clipping between passes would lose the mass that spilled out.
 */
function boxesLine(
  src: Float32Array,
  off: number,
  stride: number,
  len: number,
  radii: readonly number[],
  edge: Edge,
  a: Float32Array,
  b: Float32Array,
  dst: Float32Array
) {
  const pad = radii.reduce((s, r) => s + r, 0);
  const plen = len + 2 * pad;
  for (let i = 0; i < plen; i++) {
    const j = i - pad;
    a[i] = j < 0 ? (edge === 'zero' ? 0 : src[off]) : j >= len ? (edge === 'zero' ? 0 : src[off + (len - 1) * stride]) : src[off + j * stride];
  }
  let from = a;
  let to = b;
  for (const r of radii) {
    // Window clipped to the padded line; the padding is wide enough that the clip never
    // reaches the part that is kept.
    let sum = 0;
    for (let i = 0; i <= Math.min(r, plen - 1); i++) sum += from[i];
    const k = 2 * r + 1;
    for (let i = 0; i < plen; i++) {
      to[i] = sum / k;
      const add = i + r + 1;
      const drop = i - r;
      if (add < plen) sum += from[add];
      if (drop >= 0) sum -= from[drop];
    }
    const t = from;
    from = to;
    to = t;
  }
  for (let i = 0; i < len; i++) dst[i] = from[i + pad];
}

/**
 * Separable Gaussian blur of a single-channel float image. `edge` `zero` treats pixels beyond
 * the image as 0 (selection feather), `clamp` replicates the border (mask refinement). σ up to
 * {@link DIRECT_GAUSSIAN_MAX_SIGMA} is convolved directly; wider blurs use three box passes, so
 * the cost per pixel never grows with σ.
 */
export function gaussianBlur(src: ArrayLike<number>, w: number, h: number, sigma: number, edge: Edge = 'zero'): Float32Array {
  const out = Float32Array.from(src);
  if (!(sigma >= 0.1) || w <= 0 || h <= 0) return out;
  // Far beyond the image a wider blur changes nothing but cost.
  const s = Math.min(sigma, 4 * Math.max(w, h));
  const line = new Float32Array(Math.max(w, h));
  const passes: Array<(buf: Float32Array, off: number, stride: number, len: number) => void> = [];
  if (s <= DIRECT_GAUSSIAN_MAX_SIGMA) {
    const k = gaussianKernel(s);
    passes.push((buf, off, stride, len) => convolveLine(buf, off, stride, len, k, edge, line));
  } else {
    const radii = boxRadii(s);
    const plen = Math.max(w, h) + 2 * radii.reduce((a, r) => a + r, 0);
    const a = new Float32Array(plen);
    const b = new Float32Array(plen);
    passes.push((buf, off, stride, len) => boxesLine(buf, off, stride, len, radii, edge, a, b, line));
  }
  for (const pass of passes) {
    for (let y = 0; y < h; y++) {
      pass(out, y * w, 1, w);
      out.set(line.subarray(0, w), y * w);
    }
  }
  for (const pass of passes) {
    for (let x = 0; x < w; x++) {
      pass(out, x, w, h);
      for (let y = 0; y < h; y++) out[y * w + x] = line[y];
    }
  }
  return out;
}
