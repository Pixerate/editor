// Portions ported from photocraft-main/crates/psd/src/patterns.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Patterns: the global `Patt` / `Pat2` / `Pat3` tagged blocks (8 / 16 / 32-bit documents), which
 * pattern overlays, pattern strokes and bevel textures refer to by id.
 *
 * ```text
 * pattern  := version u32 (1), image mode u32, height u16, width u16,
 *             name (Unicode string), unique id (Pascal string, unpadded),
 *             [indexed: 768-byte palette], virtual memory array list
 * VMA list := version u32 (3), length u32, rect (top, left, bottom, right i32),
 *             channel count u32, then count + 2 arrays (user mask, sheet mask)
 * array    := written u32 (0 = absent), length u32 (0 = absent), depth u32, rect,
 *             depth u16, compression u8 (0 raw, 1 PackBits), data
 * ```
 *
 * Each pattern in a block is prefixed by its u32 length and padded to 4 bytes. Photoshop writes
 * the channel count as 24 and marks only the real channels as written; the first written arrays
 * are the colour channels and the next one is transparency.
 */

import type { EffectPattern } from '../../raster/effects/patterns';
import { PsdError, PsdReader, PsdWriter } from './binary';
import { decodePlanes, encodeRle } from './compression';
import { MODE_CMYK, MODE_INDEXED, MODE_LAB, MODE_RGB, toRgba8 } from './pixels';

const MAX_EDGE = 30000;
/** Pattern block keys, by document depth. */
export const PATTERN_BLOCK_KEYS = ['Patt', 'Pat2', 'Pat3'];

/** One pattern tile as stored: planar samples. */
export interface PsdPattern {
  mode: number;
  width: number;
  height: number;
  name: string;
  id: string;
  palette?: Uint8Array;
  depth: number;
  channels: Uint8Array[];
  alpha?: Uint8Array;
}

/** Colour channels of a PSD colour mode. */
function modeChannels(mode: number): number {
  return mode === MODE_RGB || mode === MODE_LAB ? 3 : mode === MODE_CMYK ? 4 : 1;
}

const rowBytes = (width: number, depth: number) => (depth === 1 ? Math.ceil(width / 8) : width * (depth / 8));

function readPattern(r: PsdReader): PsdPattern {
  const version = r.u32();
  if (version !== 1) throw new PsdError(`Pattern version ${version}, expected 1.`);
  const mode = r.u32();
  r.u16();
  r.u16();
  const name = r.unicode();
  const idLength = r.u8();
  const id = new TextDecoder().decode(r.bytes(idLength));
  let palette: Uint8Array | undefined;
  if (mode === MODE_INDEXED) {
    palette = r.bytes(768).slice();
    // Some writers follow the palette with 4 more bytes.
    const next = r.peek(4);
    if (next.length === 4 && !(next[0] === 0 && next[1] === 0 && next[2] === 0 && next[3] === 3)) r.skip(4);
  }
  const vmaVersion = r.u32();
  if (vmaVersion !== 3) throw new PsdError(`Pattern virtual memory array list version ${vmaVersion}, expected 3.`);
  const length = r.u32();
  const body = new PsdReader(r.bytes(length));
  const [top, left, bottom, right] = [body.i32(), body.i32(), body.i32(), body.i32()];
  const width = right - left;
  const height = bottom - top;
  if (!(width > 0 && height > 0 && width <= MAX_EDGE && height <= MAX_EDGE)) throw new PsdError(`Pattern "${name}" has an invalid size ${width} × ${height}.`);
  const count = body.u32();
  if (count > 64) throw new PsdError(`Pattern "${name}" has ${count} channels.`);
  const planes: Uint8Array[] = [];
  let depth = 8;
  for (let i = 0; i < count + 2 && body.remaining > 0; i++) {
    if (body.u32() === 0) continue;
    const arrayLength = body.u32();
    if (arrayLength === 0) continue;
    if (arrayLength < 23) throw new PsdError(`Pattern "${name}" has a short channel.`);
    const d32 = body.u32();
    const [ct, cl, cb, cr] = [body.i32(), body.i32(), body.i32(), body.i32()];
    const d16 = body.u16();
    const compression = body.u8();
    const data = body.bytes(arrayLength - 23);
    const d = [1, 8, 16, 32].includes(d16) ? d16 : d32;
    if (![1, 8, 16, 32].includes(d)) throw new PsdError(`Pattern "${name}" has depth ${d}.`);
    if (ct < top || cl < left || cb > bottom || cr > right || cb < ct || cr < cl) throw new PsdError(`Pattern "${name}" has a channel outside its rectangle.`);
    if (compression > 1) throw new PsdError(`Pattern "${name}" uses compression ${compression}.`);
    depth = d;
    const cw = cr - cl;
    const ch = cb - ct;
    const plane = decodePlanes(compression, data, { planes: 1, width: cw, height: ch, depth: d, psb: false });
    if (cw === width && ch === height) {
      planes.push(plane);
      continue;
    }
    // A smaller channel rectangle is padding: place it in a full plane.
    if (d === 1) throw new PsdError(`Pattern "${name}" has a cropped bitmap channel.`);
    const bps = d / 8;
    const out = new Uint8Array(rowBytes(width, d) * height);
    for (let y = 0; y < ch; y++) {
      out.set(plane.subarray(y * cw * bps, (y + 1) * cw * bps), ((ct - top + y) * width + (cl - left)) * bps);
    }
    planes.push(out);
  }
  const nc = modeChannels(mode);
  if (planes.length < nc) throw new PsdError(`Pattern "${name}" has fewer channels than its colour mode.`);
  return { mode, width, height, name, id, palette, depth, channels: planes.slice(0, nc), alpha: planes[nc] };
}

/** The patterns of a `Patt` / `Pat2` / `Pat3` block. Throws `PsdError` on malformed data. */
export function parsePatternBlock(data: Uint8Array): PsdPattern[] {
  const r = new PsdReader(data);
  const out: PsdPattern[] = [];
  while (r.remaining >= 4) {
    const length = r.u32();
    if (length === 0) break;
    out.push(readPattern(new PsdReader(r.bytes(length))));
    r.skip(Math.min((4 - (length % 4)) % 4, r.remaining));
  }
  return out;
}

/** A stored pattern as straight 8-bit sRGB RGBA, for rendering. */
export function psdPatternToEffectPattern(p: PsdPattern): EffectPattern {
  const data = toRgba8({ width: p.width, height: p.height, depth: p.depth, mode: p.mode, color: p.channels, alpha: p.alpha, palette: p.palette });
  return { id: p.id, name: p.name, width: p.width, height: p.height, data };
}

/** Writes 8-bit RGB(A) patterns as `Patt` block data (PackBits channels, transparency in the user mask slot). */
export function writePatternBlock(patterns: readonly EffectPattern[]): Uint8Array {
  const out = new PsdWriter();
  for (const p of patterns) {
    if (!(p.width > 0 && p.height > 0) || p.width > 32767 || p.height > 32767) throw new PsdError(`Pattern "${p.name}" is ${p.width} × ${p.height}; patterns are 1 to 32767 px.`);
    const one = new PsdWriter();
    one.u32(1);
    one.u32(MODE_RGB);
    one.u16(p.height);
    one.u16(p.width);
    one.unicode(p.name, true);
    const id = new TextEncoder().encode(p.id).subarray(0, 255);
    one.u8(id.length);
    one.bytes(id);
    const n = p.width * p.height;
    const plane = (c: number) => {
      const v = new Uint8Array(n);
      for (let i = 0; i < n; i++) v[i] = p.data[i * 4 + c];
      return v;
    };
    const alpha = plane(3);
    const opaque = alpha.every((v) => v === 255);
    const body = new PsdWriter();
    for (const v of [0, 0, p.height, p.width]) body.i32(v);
    body.u32(24);
    const array = (v: Uint8Array) => {
      const data = encodeRle(v, { planes: 1, width: p.width, height: p.height, depth: 8, psb: false });
      body.u32(1);
      body.u32(23 + data.length);
      body.u32(8);
      for (const x of [0, 0, p.height, p.width]) body.i32(x);
      body.u16(8);
      body.u8(1);
      body.bytes(data);
    };
    for (let c = 0; c < 3; c++) array(plane(c));
    for (let c = 3; c < 24; c++) body.u32(0);
    if (opaque) body.u32(0);
    else array(alpha);
    body.u32(0);
    const b = body.result();
    one.u32(3);
    one.u32(b.length);
    one.bytes(b);
    const bytes = one.result();
    out.u32(bytes.length);
    out.bytes(bytes);
    for (let k = 0; k < (4 - (bytes.length % 4)) % 4; k++) out.u8(0);
  }
  return out.result();
}
