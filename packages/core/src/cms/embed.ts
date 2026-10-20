/**
 * Embedded ICC profiles in image files: PNG (`iCCP`), JPEG (APP2 `ICC_PROFILE` segments, split
 * across up to 255 markers) and PSD (image resource 1039). Reading returns the raw ICC bytes
 * (parse them with `parseProfile`); writing returns a copy of the file with the profile in it
 * (replacing any it had).
 */

import { deflate, inflate } from '../raster/zlib';

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const isPngBytes = (b: Uint8Array) => b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v);

/** The ICC profile of a PNG (`iCCP`), or `null`. */
export function readPngIcc(png: Uint8Array): Uint8Array | null {
  if (!isPngBytes(png)) return null;
  let o = 8;
  while (o + 12 <= png.length) {
    const len = u32(png, o);
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    if (type === 'iCCP') {
      const d = png.subarray(o + 8, o + 8 + len);
      const z = d.indexOf(0);
      if (z < 1 || z > 79 || d[z + 1] !== 0) return null;
      try {
        return inflate(d.subarray(z + 2), { maxOutput: 64 * 1024 * 1024 });
      } catch {
        return null;
      }
    }
    if (type === 'IDAT' || type === 'IEND') return null;
    o += 12 + len;
  }
  return null;
}

/** The PNG with `icc` as its `iCCP` chunk (after IHDR; any old `iCCP`, `sRGB` or `gAMA` removed). */
export function writePngIcc(png: Uint8Array, icc: Uint8Array, name = 'ICC profile'): Uint8Array {
  if (!isPngBytes(png)) throw new Error('Not a PNG file.');
  const chunks: Uint8Array[] = [png.subarray(0, 8)];
  let o = 8;
  let inserted = false;
  const label = Array.from(name.slice(0, 79), (c) => c.charCodeAt(0) & 0x7f);
  const body = new Uint8Array([...label, 0, 0, ...deflate(icc)]);
  const chunk = new Uint8Array(12 + body.length);
  chunk.set([body.length >>> 24, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255]);
  chunk.set([105, 67, 67, 80], 4); // iCCP
  chunk.set(body, 8);
  const crc = crc32(chunk.subarray(4, 8 + body.length));
  chunk.set([crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255], 8 + body.length);
  while (o + 12 <= png.length) {
    const len = u32(png, o);
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    const whole = png.subarray(o, o + 12 + len);
    if (type !== 'iCCP' && type !== 'sRGB' && type !== 'gAMA') chunks.push(whole);
    if (type === 'IHDR' && !inserted) {
      chunks.push(chunk);
      inserted = true;
    }
    o += 12 + len;
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const ICC_TAG = 'ICC_PROFILE\0';

/** The ICC profile of a JPEG (its APP2 `ICC_PROFILE` segments, joined in sequence order), or `null`. */
export function readJpegIcc(jpeg: Uint8Array): Uint8Array | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  const parts = new Map<number, Uint8Array>();
  let count = 0;
  let o = 2;
  while (o + 4 <= jpeg.length) {
    if (jpeg[o] !== 0xff) break;
    const marker = jpeg[o + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end
    const len = (jpeg[o + 2] << 8) | jpeg[o + 3];
    if (marker === 0xe2 && len >= 16) {
      const d = jpeg.subarray(o + 4, o + 2 + len);
      if (String.fromCharCode(...d.subarray(0, 12)) === ICC_TAG) {
        parts.set(d[12], d.subarray(14));
        count = d[13];
      }
    }
    o += 2 + len;
  }
  if (!parts.size || !count) return null;
  const ordered: Uint8Array[] = [];
  for (let i = 1; i <= count; i++) {
    const p = parts.get(i);
    if (!p) return null;
    ordered.push(p);
  }
  const out = new Uint8Array(ordered.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of ordered) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The JPEG with `icc` in APP2 segments (after SOI and any APP0 / APP1; old ICC segments removed). */
export function writeJpegIcc(jpeg: Uint8Array, icc: Uint8Array): Uint8Array {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Not a JPEG file.');
  const MAX = 65519;
  const count = Math.max(1, Math.ceil(icc.length / MAX));
  if (count > 255) throw new Error('The ICC profile is too large for a JPEG.');
  const segments: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const part = icc.subarray(i * MAX, Math.min(icc.length, (i + 1) * MAX));
    const len = 2 + 14 + part.length;
    const s = new Uint8Array(2 + len);
    s.set([0xff, 0xe2, len >> 8, len & 255]);
    for (let k = 0; k < 12; k++) s[4 + k] = ICC_TAG.charCodeAt(k);
    s[16] = i + 1;
    s[17] = count;
    s.set(part, 18);
    segments.push(s);
  }
  const keep: Uint8Array[] = [jpeg.subarray(0, 2)];
  let o = 2;
  let inserted = false;
  while (o + 4 <= jpeg.length && jpeg[o] === 0xff) {
    const marker = jpeg[o + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const len = (jpeg[o + 2] << 8) | jpeg[o + 3];
    const seg = jpeg.subarray(o, o + 2 + len);
    const isIcc = marker === 0xe2 && String.fromCharCode(...seg.subarray(4, 16)) === ICC_TAG;
    if (!inserted && marker !== 0xe0 && marker !== 0xe1) {
      keep.push(...segments);
      inserted = true;
    }
    if (!isIcc) keep.push(seg);
    o += 2 + len;
  }
  if (!inserted) keep.push(...segments);
  keep.push(jpeg.subarray(o));
  const out = new Uint8Array(keep.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of keep) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
