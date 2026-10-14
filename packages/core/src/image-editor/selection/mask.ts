// Portions ported from photocraft/crates/algo/src/selection.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import type { CropBox } from '../types';

/**
 * A selection: one 8-bit coverage value per image pixel (0 = not selected, 255 = fully
 * selected), row-major over the whole source image in natural pixels — the same space as the
 * crop box and annotations. Soft values are partial selection (feathered or anti-aliased edges).
 *
 * Treat a mask as immutable: every operation returns a new one, so history entries can share
 * them without copying.
 */
export interface SelectionMask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  /** Bounding box of the non-zero coverage, or `null` when nothing is selected. */
  readonly bounds: CropBox | null;
}

/** How a new selection combines with the current one. */
export type SelectionMode = 'replace' | 'add' | 'subtract' | 'intersect';

export const SELECTION_MODES: readonly SelectionMode[] = ['replace', 'add', 'subtract', 'intersect'];

export function isSelectionMode(value: unknown): value is SelectionMode {
  return typeof value === 'string' && (SELECTION_MODES as readonly string[]).includes(value);
}

/** Parses `replace|add|subtract|intersect`; anything else is `replace`. */
export function parseSelectionMode(value: unknown): SelectionMode {
  return isSelectionMode(value) ? value : 'replace';
}

/** RGBA pixels, 8 bits per channel, straight alpha (an `ImageData` qualifies). */
export interface PixelBuffer {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** Serialized selection: a run-length encoding of the 8-bit coverage. */
export interface SerializedSelection {
  width: number;
  height: number;
  /** `r1:` + base64 of (value byte, LEB128 run length) pairs. */
  rle: string;
}

const MAX_SIDE = 1 << 15;

function checkSize(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) {
    throw new Error(`Invalid selection size ${width}×${height}`);
  }
}

/** Bounding box of non-zero bytes. */
export function computeSelectionBounds(width: number, height: number, data: ArrayLike<number>): CropBox | null {
  let x0 = width;
  let x1 = -1;
  let y0 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let first = -1;
    for (let x = 0; x < width; x++) {
      if (data[row + x] !== 0) {
        first = x;
        break;
      }
    }
    if (first < 0) continue;
    let last = first;
    for (let x = width - 1; x > first; x--) {
      if (data[row + x] !== 0) {
        last = x;
        break;
      }
    }
    if (y0 < 0) y0 = y;
    y1 = y;
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
  }
  if (y0 < 0) return null;
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Wraps coverage bytes (taken over, not copied) as a selection, computing its bounds. */
export function createSelectionMask(width: number, height: number, data?: Uint8Array): SelectionMask {
  checkSize(width, height);
  const bytes = data ?? new Uint8Array(width * height);
  if (bytes.length !== width * height) throw new Error('Selection data does not match its size');
  return { width, height, data: bytes, bounds: data ? computeSelectionBounds(width, height, bytes) : null };
}

/** Select › All. */
export function fullSelection(width: number, height: number): SelectionMask {
  checkSize(width, height);
  return { width, height, data: new Uint8Array(width * height).fill(255), bounds: { x: 0, y: 0, width, height } };
}

export function isSelectionEmpty(mask: SelectionMask | null | undefined): boolean {
  return !mask || mask.bounds === null;
}

/** Coverage at a pixel, 0..1 (0 outside the image). */
export function selectionValueAt(mask: SelectionMask, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= mask.width || yi >= mask.height) return 0;
  return mask.data[yi * mask.width + xi] / 255;
}

/** 8-bit value of a coverage (clamped and rounded; NaN → 0). */
export function coverageToByte(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 255;
  return Math.floor(v * 255 + 0.5);
}

/** A selection from 0..1 coverage. */
export function selectionFromCoverage(width: number, height: number, coverage: ArrayLike<number>): SelectionMask {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = coverageToByte(coverage[i]);
  return createSelectionMask(width, height, out);
}

/** The selection's coverage as 0..1 floats. */
export function selectionToCoverage(mask: SelectionMask): Float32Array {
  const out = new Float32Array(mask.data.length);
  for (let i = 0; i < out.length; i++) out[i] = mask.data[i] / 255;
  return out;
}

/** Number of fully-or-partly selected pixels, weighted by coverage (Σ coverage). */
export function selectionArea(mask: SelectionMask | null | undefined): number {
  if (!mask || !mask.bounds) return 0;
  let sum = 0;
  const { x, y, width, height } = mask.bounds;
  for (let yy = y; yy < y + height; yy++) {
    const row = yy * mask.width;
    for (let xx = x; xx < x + width; xx++) sum += mask.data[row + xx];
  }
  return sum / 255;
}

/**
 * Combines `next` with `prev` by `mode` (8-bit, exact: combining a mask with itself is a no-op).
 * Add is the maximum, Subtract `max(prev − next, 0)`, Intersect the minimum. A missing `prev`
 * reads as nothing selected. Returns `null` when nothing remains selected.
 */
export function combineSelections(
  prev: SelectionMask | null | undefined,
  next: SelectionMask,
  mode: SelectionMode
): SelectionMask | null {
  let result: SelectionMask;
  if (mode === 'replace' || (!prev && mode === 'add')) {
    result = next;
  } else if (!prev) {
    return null;
  } else {
    if (prev.width !== next.width || prev.height !== next.height) throw new Error('Selections differ in size');
    const a = prev.data;
    const b = next.data;
    const out = new Uint8Array(a.length);
    if (mode === 'add') for (let i = 0; i < a.length; i++) out[i] = a[i] > b[i] ? a[i] : b[i];
    else if (mode === 'subtract') for (let i = 0; i < a.length; i++) out[i] = a[i] > b[i] ? a[i] - b[i] : 0;
    else for (let i = 0; i < a.length; i++) out[i] = a[i] < b[i] ? a[i] : b[i];
    result = createSelectionMask(prev.width, prev.height, out);
  }
  return result.bounds ? result : null;
}

/** Select › Inverse. */
export function invertSelection(mask: SelectionMask): SelectionMask {
  const out = new Uint8Array(mask.data.length);
  for (let i = 0; i < out.length; i++) out[i] = 255 - mask.data[i];
  return createSelectionMask(mask.width, mask.height, out);
}

/** Bilinear resample to another size (e.g. an AI mask returned at a different resolution). */
export function resizeSelection(mask: SelectionMask, width: number, height: number): SelectionMask {
  if (mask.width === width && mask.height === height) return mask;
  checkSize(width, height);
  const out = new Uint8Array(width * height);
  const sx = mask.width / width;
  const sy = mask.height / height;
  const src = mask.data;
  const mw = mask.width;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(mask.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(mask.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(mw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(mw - 1, x0 + 1);
      const tx = fx - x0;
      const top = src[y0 * mw + x0] * (1 - tx) + src[y0 * mw + x1] * tx;
      const bot = src[y1 * mw + x0] * (1 - tx) + src[y1 * mw + x1] * tx;
      out[y * width + x] = Math.round(top * (1 - ty) + bot * ty);
    }
  }
  return createSelectionMask(width, height, out);
}

export type SelectionChannel = 'alpha' | 'luminance' | 'red' | 'green' | 'blue';

/**
 * A selection from an image: by default its luminance (white = selected, the usual convention
 * of segmentation masks), or one channel. Partly transparent pixels count as black for
 * luminance, so a mask PNG with transparency works either way.
 */
export function selectionFromPixels(
  pixels: PixelBuffer,
  options: { channel?: SelectionChannel; invert?: boolean; threshold?: number } = {}
): SelectionMask {
  const { width, height, data } = pixels;
  checkSize(width, height);
  if (data.length < width * height * 4) throw new Error('Pixel data is shorter than width × height × 4');
  const channel = options.channel ?? 'luminance';
  const out = new Uint8Array(width * height);
  const threshold = options.threshold;
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    let v: number;
    switch (channel) {
      case 'alpha':
        v = data[p + 3];
        break;
      case 'red':
        v = data[p];
        break;
      case 'green':
        v = data[p + 1];
        break;
      case 'blue':
        v = data[p + 2];
        break;
      default:
        v = Math.round(((0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) * data[p + 3]) / 255);
    }
    if (options.invert) v = 255 - v;
    if (threshold !== undefined) v = v >= threshold ? 255 : 0;
    out[i] = v;
  }
  return createSelectionMask(width, height, out);
}

/** The selection as RGBA pixels: grey (white = selected, opaque) or white with coverage as alpha. */
export function selectionToPixels(mask: SelectionMask, as: 'gray' | 'alpha' = 'gray'): { width: number; height: number; data: Uint8ClampedArray } {
  const out = new Uint8ClampedArray(mask.data.length * 4);
  for (let i = 0, p = 0; i < mask.data.length; i++, p += 4) {
    const v = mask.data[i];
    if (as === 'gray') {
      out[p] = out[p + 1] = out[p + 2] = v;
      out[p + 3] = 255;
    } else {
      out[p] = out[p + 1] = out[p + 2] = 255;
      out[p + 3] = v;
    }
  }
  return { width: mask.width, height: mask.height, data: out };
}

// ---------------------------------------------------------------------------
// Run-length encoding
// ---------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

function toBase64(bytes: Uint8Array, length: number): string {
  const parts: string[] = [];
  let chunk = '';
  for (let i = 0; i < length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < length ? bytes[i + 1] : 0;
    const c = i + 2 < length ? bytes[i + 2] : 0;
    chunk += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    chunk += i + 1 < length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    chunk += i + 2 < length ? B64[c & 63] : '=';
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = '';
    }
  }
  parts.push(chunk);
  return parts.join('');
}

function fromBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw new Error('Invalid base64 length');
  let pad = 0;
  if (text.endsWith('==')) pad = 2;
  else if (text.endsWith('=')) pad = 1;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  const digit = (i: number, k: number): number => {
    const ch = text.charCodeAt(i + k);
    if (ch === 61 /* = */ && i + 4 === text.length && k >= 4 - pad) return 0;
    const idx = ch < 128 ? B64_INDEX[ch] : -1;
    if (idx < 0) throw new Error('Invalid base64 character');
    return idx;
  };
  for (let i = 0; i < text.length; i += 4) {
    const n = (digit(i, 0) << 18) | (digit(i, 1) << 12) | (digit(i, 2) << 6) | digit(i, 3);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** Run-length encodes coverage bytes: `r1:` + base64 of (value, LEB128 run length) pairs. */
export function encodeSelectionRle(data: Uint8Array): string {
  let buf = new Uint8Array(64);
  let len = 0;
  const push = (b: number) => {
    if (len === buf.length) {
      const next = new Uint8Array(buf.length * 2);
      next.set(buf);
      buf = next;
    }
    buf[len++] = b;
  };
  let i = 0;
  while (i < data.length) {
    const v = data[i];
    let j = i + 1;
    while (j < data.length && data[j] === v) j++;
    push(v);
    let run = j - i;
    while (run >= 128) {
      push((run & 127) | 128);
      run = Math.floor(run / 128);
    }
    push(run);
    i = j;
  }
  return 'r1:' + toBase64(buf, len);
}

/** Decodes {@link encodeSelectionRle}; throws unless the runs cover exactly `length` bytes. */
export function decodeSelectionRle(rle: string, length: number): Uint8Array {
  if (typeof rle !== 'string' || !rle.startsWith('r1:')) throw new Error('Unknown selection encoding');
  const bytes = fromBase64(rle.slice(3));
  const out = new Uint8Array(length);
  let o = 0;
  let i = 0;
  while (i < bytes.length) {
    const v = bytes[i++];
    let run = 0;
    let scale = 1;
    for (;;) {
      if (i >= bytes.length) throw new Error('Truncated selection run');
      const b = bytes[i++];
      run += (b & 127) * scale;
      if (b < 128) break;
      scale *= 128;
      if (scale > 2 ** 35) throw new Error('Selection run too long');
    }
    if (run === 0 || o + run > length) throw new Error('Selection runs do not match its size');
    if (v !== 0) out.fill(v, o, o + run);
    o += run;
  }
  if (o !== length) throw new Error('Selection runs do not match its size');
  return out;
}

export function serializeSelection(mask: SelectionMask): SerializedSelection {
  return { width: mask.width, height: mask.height, rle: encodeSelectionRle(mask.data) };
}

/** Restores a {@link SerializedSelection}; throws on damaged data. */
export function deserializeSelection(value: unknown): SelectionMask {
  if (!value || typeof value !== 'object') throw new Error('selection must be an object');
  const v = value as Record<string, unknown>;
  const width = v.width as number;
  const height = v.height as number;
  checkSize(width, height);
  return createSelectionMask(width, height, decodeSelectionRle(v.rle as string, width * height));
}

/** A short, stable hash of a string or bytes (FNV-1a, 32-bit, hex) for cache keys. */
export function hashMaskContent(content: string | Uint8Array): string {
  let h = 0x811c9dc5;
  if (typeof content === 'string') {
    for (let i = 0; i < content.length; i++) {
      h ^= content.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  } else {
    for (let i = 0; i < content.length; i++) {
      h ^= content[i];
      h = Math.imul(h, 0x01000193);
    }
  }
  return `${(h >>> 0).toString(16)}:${content.length}`;
}
