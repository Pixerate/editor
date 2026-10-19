// Portions ported from photocraft/crates/psd/src/compression.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/** Channel and image data compression: raw, RLE (PackBits), ZIP and ZIP with prediction. */

import { ZlibError, deflate, inflate } from '../layers/zlib';
import { PsdError, PsdReader } from './binary';

export type PsdCompression = 0 | 1 | 2 | 3;
export const COMPRESSION_NAMES = ['raw', 'rle', 'zip', 'zip-prediction'] as const;

/** Largest decoded channel set accepted from one file (bytes). */
export const MAX_DECODED_BYTES = 2 ** 31;

export function rowBytes(width: number, depth: number): number {
  return depth === 1 ? Math.ceil(width / 8) : width * Math.max(1, depth >> 3);
}

export interface PlaneLayout {
  planes: number;
  width: number;
  height: number;
  depth: number;
  /** PSB: RLE row counts are 4 bytes. */
  psb: boolean;
}

function decodedLength(l: PlaneLayout): number {
  const total = l.planes * l.height * rowBytes(l.width, l.depth);
  if (total > MAX_DECODED_BYTES) throw new PsdError(`Decoded channel data of ${total} bytes is larger than the ${MAX_DECODED_BYTES}-byte limit.`);
  return total;
}

/** Worst-case PackBits size of `n` bytes. */
export function packbitsBound(n: number): number {
  return n + Math.ceil(n / 128);
}

/** PackBits: writes `src` encoded into `out` at `at` (room for `packbitsBound`); returns the new offset. */
export function packbitsEncode(src: Uint8Array, out: Uint8Array, at: number): number {
  const n = src.length;
  let i = 0;
  while (i < n) {
    let run = 1;
    while (i + run < n && run < 128 && src[i + run] === src[i]) run++;
    if (run >= 2) {
      out[at++] = (257 - run) & 255;
      out[at++] = src[i];
      i += run;
      continue;
    }
    const start = i;
    let len = 0;
    while (i < n && len < 128) {
      if (i + 2 < n && src[i] === src[i + 1] && src[i] === src[i + 2]) break;
      i++;
      len++;
    }
    out[at++] = len - 1;
    out.set(src.subarray(start, start + len), at);
    at += len;
  }
  return at;
}

/** PackBits: decodes exactly `expected` bytes from `src` into `out` at `at`; returns the new offset. */
export function packbitsDecodeInto(src: Uint8Array, expected: number, out: Uint8Array, at: number): number {
  const target = at + expected;
  let i = 0;
  while (at < target) {
    if (i >= src.length) throw new PsdError('PackBits row ended early.');
    const h = src[i++];
    if (h < 128) {
      const len = h + 1;
      if (i + len > src.length) throw new PsdError('PackBits literal is truncated.');
      if (at + len > target) throw new PsdError('PackBits literal overflows its row.');
      out.set(src.subarray(i, i + len), at);
      at += len;
      i += len;
    } else if (h !== 128) {
      const len = 257 - h;
      if (i >= src.length) throw new PsdError('PackBits run is truncated.');
      const b = src[i++];
      if (at + len > target) throw new PsdError('PackBits run overflows its row.');
      out.fill(b, at, at + len);
      at += len;
    }
  }
  return at;
}

function inflateChecked(data: Uint8Array, expected: number): Uint8Array {
  let out: Uint8Array;
  try {
    out = inflate(data, { maxOutput: expected + (1 << 20), sizeHint: expected, verify: false });
  } catch (e) {
    throw new PsdError(`ZIP channel data: ${e instanceof ZlibError || e instanceof Error ? e.message : String(e)}`);
  }
  if (out.length < expected) throw new PsdError(`ZIP stream produced ${out.length} of ${expected} bytes.`);
  return out.length === expected ? out : out.subarray(0, expected);
}

function unpredict(buf: Uint8Array, l: PlaneLayout): void {
  const rb = rowBytes(l.width, l.depth);
  if (rb === 0) return;
  const w = l.width;
  const scratch = l.depth === 32 ? new Uint8Array(rb) : null;
  for (let o = 0; o + rb <= buf.length; o += rb) {
    if (l.depth === 1 || l.depth === 8) {
      for (let i = 1; i < rb; i++) buf[o + i] = (buf[o + i] + buf[o + i - 1]) & 255;
    } else if (l.depth === 16) {
      for (let i = 1; i < w; i++) {
        const a = (buf[o + 2 * i] << 8) | buf[o + 2 * i + 1];
        const b = (buf[o + 2 * i - 2] << 8) | buf[o + 2 * i - 1];
        const v = (a + b) & 0xffff;
        buf[o + 2 * i] = v >> 8;
        buf[o + 2 * i + 1] = v & 255;
      }
    } else if (l.depth === 32) {
      for (let i = 1; i < rb; i++) buf[o + i] = (buf[o + i] + buf[o + i - 1]) & 255;
      scratch!.set(buf.subarray(o, o + rb));
      for (let i = 0; i < w; i++) for (let k = 0; k < 4; k++) buf[o + 4 * i + k] = scratch![k * w + i];
    } else {
      throw new PsdError(`ZIP prediction is not defined for depth ${l.depth}.`);
    }
  }
}

function decodeRle(r: PsdReader, l: PlaneLayout, total: number): Uint8Array {
  const rows = l.planes * l.height;
  const rb = rowBytes(l.width, l.depth);
  r.checkCount(rows, l.psb ? 4 : 2, 'RLE row counts');
  const counts = new Array<number>(rows);
  for (let i = 0; i < rows; i++) counts[i] = l.psb ? r.u32() : r.u16();
  if (total > r.remaining * 130) throw new PsdError('RLE data is too short for its declared size.');
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of counts) at = packbitsDecodeInto(r.bytes(c), rb, out, at);
  return out;
}

/** Decodes planar channel data (`planes` planes of `height` rows each). */
export function decodePlanes(compression: number, data: Uint8Array, l: PlaneLayout): Uint8Array {
  const total = decodedLength(l);
  switch (compression) {
    case 0:
      if (data.length < total) throw new PsdError(`Raw channel data has ${data.length} of ${total} bytes.`);
      return data.slice(0, total);
    case 1:
      return decodeRle(new PsdReader(data), l, total);
    case 2:
      return inflateChecked(data, total).slice();
    case 3: {
      const v = inflateChecked(data, total).slice();
      unpredict(v, l);
      return v;
    }
    default:
      throw new PsdError(`Unsupported compression method ${compression}.`);
  }
}

/** RLE-encodes planar data: row counts (u16, or u32 in PSB), then the packed rows. */
export function encodeRle(decoded: Uint8Array, l: PlaneLayout): Uint8Array {
  const rows = l.planes * l.height;
  const rb = rowBytes(l.width, l.depth);
  const cs = l.psb ? 4 : 2;
  const packed = new Uint8Array(rows * packbitsBound(rb));
  let at = 0;
  const counts = new Uint8Array(rows * cs);
  for (let row = 0; row < rows; row++) {
    const start = at;
    at = packbitsEncode(decoded.subarray(row * rb, (row + 1) * rb), packed, at);
    const n = at - start;
    if (cs === 2) {
      if (n > 0xffff) throw new PsdError('An RLE row is longer than 65535 bytes; write a PSB instead.');
      counts[row * 2] = n >> 8;
      counts[row * 2 + 1] = n & 255;
    } else {
      counts[row * 4] = n >>> 24;
      counts[row * 4 + 1] = (n >>> 16) & 255;
      counts[row * 4 + 2] = (n >>> 8) & 255;
      counts[row * 4 + 3] = n & 255;
    }
  }
  const out = new Uint8Array(counts.length + at);
  out.set(counts);
  out.set(packed.subarray(0, at), counts.length);
  return out;
}

/** ZIP without prediction (used by tests to build fixtures). */
export function encodeZip(decoded: Uint8Array): Uint8Array {
  return deflate(decoded);
}
