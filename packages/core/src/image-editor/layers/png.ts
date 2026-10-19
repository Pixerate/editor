/**
 * Dependency-free, synchronous PNG encode / decode for layer pixels and masks, plus base64 and
 * data-URL helpers. Canvas `toDataURL` is lossy for partly transparent pixels (it goes through
 * premultiplied alpha), so layer assets use this codec and round-trip exactly.
 *
 * Encodes 8-bit greyscale (masks) or RGBA (layers). Decodes non-interlaced 1/2/4/8/16-bit
 * greyscale, RGB, palette, grey + alpha and RGBA, always to 8-bit RGBA or grey.
 */

import { deflate, inflate } from './zlib';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface DecodedPng {
  width: number;
  height: number;
  /** 4 for RGBA output, 1 for greyscale without alpha when `keepGray` was asked for. */
  channels: 1 | 4;
  data: Uint8ClampedArray;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** PNG bytes for `width × height` pixels of 1 (grey) or 4 (RGBA) bytes each. */
export function encodePng(width: number, height: number, data: ArrayLike<number>, channels: 1 | 4 = 4): Uint8Array {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  const bpp = channels;
  const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prevRow = (y - 1) * stride;
    // Try each filter and keep the one with the smallest sum of signed residues.
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = cand[f];
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const v = data[row + x];
        const a = x >= bpp ? data[row + x - bpp] : 0;
        const b = y > 0 ? data[prevRow + x] : 0;
        const c = x >= bpp && y > 0 ? data[prevRow + x - bpp] : 0;
        let r: number;
        switch (f) {
          case 0: r = v; break;
          case 1: r = v - a; break;
          case 2: r = v - b; break;
          case 3: r = v - ((a + b) >> 1); break;
          default: r = v - paeth(a, b, c);
        }
        r &= 255;
        out[x] = r;
        score += r < 128 ? r : 256 - r;
        if (score >= bestScore) break;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    const o = y * (stride + 1);
    raw[o] = best;
    // Only a filter whose scoring loop ran to the end can win, so its row is complete.
    raw.set(cand[best], o + 1);
  }
  const idat = deflate(raw);
  const chunks: Array<[string, Uint8Array]> = [];
  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 6;
  chunks.push(['IHDR', ihdr], ['IDAT', idat], ['IEND', new Uint8Array(0)]);
  let size = 8;
  for (const [, d] of chunks) size += 12 + d.length;
  const out = new Uint8Array(size);
  out.set(SIGNATURE, 0);
  let p = 8;
  for (const [type, d] of chunks) {
    writeU32(out, p, d.length);
    for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
    out.set(d, p + 8);
    writeU32(out, p + 8 + d.length, crc32(out, p + 4, p + 8 + d.length));
    p += 12 + d.length;
  }
  return out;
}

function writeU32(b: Uint8Array, o: number, v: number): void {
  b[o] = v >>> 24;
  b[o + 1] = (v >>> 16) & 255;
  b[o + 2] = (v >>> 8) & 255;
  b[o + 3] = v & 255;
}

function readU32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && SIGNATURE.every((v, i) => bytes[i] === v);
}

/**
 * Decodes a PNG. Output is RGBA (4 channels) unless `keepGray` is set and the image is
 * greyscale without alpha, in which case it is one byte per pixel.
 */
export function decodePng(bytes: Uint8Array, options: { keepGray?: boolean; maxPixels?: number } = {}): DecodedPng {
  if (!isPng(bytes)) throw new Error('Not a PNG image.');
  let p = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (p + 8 <= bytes.length) {
    const len = readU32(bytes, p);
    const t = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const body = bytes.subarray(p + 8, p + 8 + len);
    if (p + 12 + len > bytes.length) throw new Error('Truncated PNG.');
    if (t === 'IHDR') {
      width = readU32(body, 0);
      height = readU32(body, 4);
      depth = body[8];
      type = body[9];
      interlace = body[12];
    } else if (t === 'PLTE') palette = body;
    else if (t === 'tRNS') trns = body;
    else if (t === 'IDAT') idat.push(body);
    else if (t === 'IEND') break;
    p += 12 + len;
  }
  if (!width || !height) throw new Error('PNG has no image header.');
  if (interlace) throw new Error('Interlaced PNGs are not supported here; decode them with a canvas.');
  const maxPixels = options.maxPixels ?? 1 << 28;
  if (width * height > maxPixels) throw new Error(`PNG is too large (${width}×${height}).`);
  const samples = type === 0 ? 1 : type === 2 ? 3 : type === 3 ? 1 : type === 4 ? 2 : type === 6 ? 4 : 0;
  if (!samples || ![1, 2, 4, 8, 16].includes(depth)) throw new Error(`Unsupported PNG format (type ${type}, depth ${depth}).`);
  let total = 0;
  for (const c of idat) total += c.length;
  const z = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    z.set(c, o);
    o += c.length;
  }
  const bitsPerPixel = samples * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const raw = inflate(z, { maxOutput: (stride + 1) * height, sizeHint: (stride + 1) * height });
  if (raw.length < (stride + 1) * height) throw new Error('PNG image data is truncated.');
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const lines = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? lines[dst + x - bpp] : 0;
      const b = y > 0 ? lines[up + x] : 0;
      const c = x >= bpp && y > 0 ? lines[up + x - bpp] : 0;
      let r: number;
      switch (f) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: r = v + paeth(a, b, c); break;
        default: throw new Error(`Invalid PNG filter ${f}.`);
      }
      lines[dst + x] = r & 255;
    }
  }
  const sample = (y: number, i: number): number => {
    // The i-th sample of row y, scaled to 8 bits.
    const row = y * stride;
    if (depth === 8) return lines[row + i];
    if (depth === 16) return lines[row + i * 2];
    const perByte = 8 / depth;
    const byte = lines[row + Math.floor(i / perByte)];
    const shift = 8 - depth * ((i % perByte) + 1);
    const v = (byte >> shift) & ((1 << depth) - 1);
    return type === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  const gray = options.keepGray && type === 0 && !trns;
  const channels: 1 | 4 = gray ? 1 : 4;
  const out = new Uint8ClampedArray(width * height * channels);
  const trnsGray = trns && type === 0 ? (depth === 16 ? trns[0] : sample16(trns, 0, depth)) : -1;
  const trnsRgb = trns && type === 2 ? [0, 1, 2].map((k) => (depth === 16 ? trns![k * 2] : sample16(trns!, k, depth))) : null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * channels;
      if (type === 0) {
        const v = sample(y, x);
        if (gray) out[d] = v;
        else {
          out[d] = out[d + 1] = out[d + 2] = v;
          out[d + 3] = v === trnsGray && trns ? 0 : 255;
        }
      } else if (type === 2) {
        const r = sample(y, x * 3);
        const g = sample(y, x * 3 + 1);
        const b = sample(y, x * 3 + 2);
        out[d] = r;
        out[d + 1] = g;
        out[d + 2] = b;
        out[d + 3] = trnsRgb && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2] ? 0 : 255;
      } else if (type === 3) {
        const i = sample(y, x);
        if (!palette || i * 3 + 2 >= palette.length) throw new Error('PNG palette index out of range.');
        out[d] = palette[i * 3];
        out[d + 1] = palette[i * 3 + 1];
        out[d + 2] = palette[i * 3 + 2];
        out[d + 3] = trns && i < trns.length ? trns[i] : 255;
      } else if (type === 4) {
        const v = sample(y, x * 2);
        out[d] = out[d + 1] = out[d + 2] = v;
        out[d + 3] = sample(y, x * 2 + 1);
      } else {
        out[d] = sample(y, x * 4);
        out[d + 1] = sample(y, x * 4 + 1);
        out[d + 2] = sample(y, x * 4 + 2);
        out[d + 3] = sample(y, x * 4 + 3);
      }
    }
  }
  return { width, height, channels, data: out };
}

/** A tRNS sample (stored as 16-bit big endian) scaled like the image samples. */
function sample16(trns: Uint8Array, k: number, depth: number): number {
  const v = (trns[k * 2] << 8) | trns[k * 2 + 1];
  if (depth === 8) return v & 255;
  return Math.round(((v & ((1 << depth) - 1)) * 255) / ((1 << depth) - 1));
}

// ---------------------------------------------------------------------------
// Base64 / data URLs
// ---------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
let B64_INV: Int16Array | null = null;

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const CHUNK = 3 * 4096;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(bytes.length, start + CHUNK);
    let s = '';
    let i = start;
    for (; i + 2 < end; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      s += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    if (i < end) {
      const n = (bytes[i] << 16) | (i + 1 < end ? bytes[i + 1] << 8 : 0);
      s += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < end ? B64[(n >> 6) & 63] : '=') + '=';
    }
    parts.push(s);
  }
  return parts.join('');
}

export function base64ToBytes(text: string): Uint8Array {
  if (!B64_INV) {
    B64_INV = new Int16Array(128).fill(-1);
    for (let i = 0; i < 64; i++) B64_INV[B64.charCodeAt(i)] = i;
    B64_INV['-'.charCodeAt(0)] = 62;
    B64_INV['_'.charCodeAt(0)] = 63;
  }
  const inv = B64_INV;
  const clean = text.replace(/[\s=]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? inv[c] : -1;
    if (v < 0) throw new Error('Invalid base64 data.');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out.subarray(0, o);
}

/** The bytes and MIME type of a `data:` URL (base64 or percent-encoded). */
export function parseDataUrl(url: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*?),/i.exec(url);
  if (!m) return null;
  const body = url.slice(m[0].length);
  const isBase64 = /;base64/i.test(m[2]);
  if (isBase64) return { mime: m[1] || 'text/plain', bytes: base64ToBytes(body) };
  const text = decodeURIComponent(body);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 255;
  return { mime: m[1] || 'text/plain', bytes };
}

export function pngDataUrl(width: number, height: number, data: ArrayLike<number>, channels: 1 | 4 = 4): string {
  return `data:image/png;base64,${bytesToBase64(encodePng(width, height, data, channels))}`;
}
