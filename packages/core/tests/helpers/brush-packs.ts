/**
 * Builders for small brush packs made for the tests (no third-party packs are committed):
 * Photoshop `.abr` version 2 and 6 files, and Procreate `.brush` / `.brushset` ZIP archives with a
 * binary-plist `Brush.archive`. `scripts/brush-pack-fixtures.ts` writes the committed fixtures
 * in `tests/fixtures/brush-packs` with them.
 */

import { deflateRaw } from '../../src/raster/zlib';
import { pngDataUrl, parseDataUrl } from '../../src/raster/png';

class Writer {
  bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 255);
    return this;
  }
  u16(v: number) {
    return this.u8(v >> 8).u8(v);
  }
  u32(v: number) {
    return this.u16(v >>> 16).u16(v & 0xffff);
  }
  raw(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.bytes.push(b[i] & 255);
    return this;
  }
  ascii(s: string) {
    return this.raw([...s].map((c) => c.charCodeAt(0)));
  }
  utf16(s: string) {
    this.u32(s.length);
    for (const c of s) this.u16(c.charCodeAt(0));
    return this;
  }
  out() {
    return Uint8Array.from(this.bytes);
  }
}

/** A grey tip mask: a disc with a notch on its right, so its orientation can be told. */
export function tipMask(w: number, h: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - (w - 1) / 2, y - (h - 1) / 2) / (Math.min(w, h) / 2);
      m[y * w + x] = d < 0.9 && !(x > w * 0.7 && Math.abs(y - h / 2) < h * 0.15) ? 255 : 0;
    }
  return m;
}

/** PackBits rows of an 8-bit image: row lengths, then the runs (literal runs only). */
function packRows(mask: Uint8Array, w: number, h: number): Uint8Array {
  const rows: number[][] = [];
  for (let y = 0; y < h; y++) {
    const row: number[] = [];
    for (let x = 0; x < w; ) {
      // A repeat run when the next three bytes match, else a literal run.
      const v = mask[y * w + x];
      let n = 1;
      while (x + n < w && n < 128 && mask[y * w + x + n] === v) n++;
      if (n >= 3) {
        row.push(257 - n, v);
        x += n;
        continue;
      }
      const start = x;
      while (x < w && x - start < 128 && !(x + 2 < w && mask[y * w + x] === mask[y * w + x + 1] && mask[y * w + x] === mask[y * w + x + 2])) x++;
      row.push(x - start - 1, ...mask.subarray(y * w + start, y * w + x));
    }
    rows.push(row);
  }
  const w2 = new Writer();
  for (const r of rows) w2.u16(r.length);
  for (const r of rows) w2.raw(r);
  return w2.out();
}

export interface AbrTipSpec {
  name: string;
  width: number;
  height: number;
  spacing: number;
  /** PackBits (default) or raw. */
  compression?: 0 | 1;
}

/** An ABR version 2 file: the sampled tips given, then one computed tip. */
export function abrV2(tips: AbrTipSpec[], computed = { diameter: 30, roundness: 60, angle: 45, hardness: 80, spacing: 15 }): Uint8Array {
  const w = new Writer().u16(2).u16(tips.length + 1);
  for (const t of tips) {
    const mask = tipMask(t.width, t.height);
    const body = new Writer().u32(0).u16(t.spacing).utf16(`${t.name}\0`).u8(1);
    body.u16(0).u16(0).u16(t.height).u16(t.width);
    body.u32(0).u32(0).u32(t.height).u32(t.width).u16(8).u8(t.compression ?? 1);
    body.raw(t.compression === 0 ? mask : packRows(mask, t.width, t.height));
    const b = body.out();
    w.u16(2).u32(b.length).raw(b);
  }
  const c = new Writer().u32(0).u16(computed.spacing).u16(computed.diameter).u16(computed.roundness).u16(computed.angle).u16(computed.hardness).out();
  w.u16(1).u32(c.length).raw(c);
  return w.out();
}

/** An ABR version 6.2 file: a `samp` section with the tips and a `desc` naming them, plus an empty `patt`. */
export function abrV6(tips: AbrTipSpec[]): Uint8Array {
  const uuids = tips.map((_, i) => `$${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`);
  const samp = new Writer();
  tips.forEach((t, i) => {
    const mask = tipMask(t.width, t.height);
    const body = new Writer().u8(uuids[i].length).ascii(uuids[i]);
    while (body.bytes.length < 301) body.u8(0);
    body.u32(0).u32(0).u32(t.height).u32(t.width).u16(8).u8(t.compression ?? 1);
    body.raw(t.compression === 0 ? mask : packRows(mask, t.width, t.height));
    const b = body.out();
    samp.u32(b.length).raw(b);
    while (samp.bytes.length % 4) samp.u8(0);
  });
  // The descriptor, reduced to the keys the reader looks for: a name, then sampledData and spacing.
  const desc = new Writer();
  tips.forEach((t, i) => {
    desc.u32(0).ascii('Nm  TEXT').utf16(`${t.name}\0`);
    desc.u32(11).ascii('sampledDataTEXT').utf16(`${uuids[i]}\0`);
    desc.ascii('SpcnUntF#Prc');
    const f = new DataView(new ArrayBuffer(8));
    f.setFloat64(0, t.spacing);
    desc.raw(new Uint8Array(f.buffer));
  });
  const w = new Writer().u16(6).u16(2);
  const section = (key: string, data: Uint8Array) => {
    w.ascii('8BIM').ascii(key).u32(data.length).raw(data);
    if (data.length % 2) w.u8(0);
  };
  section('samp', samp.out());
  section('patt', new Uint8Array(0));
  section('desc', desc.out());
  return w.out();
}

// --- ZIP ---------------------------------------------------------------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const v of b) c = CRC[(c ^ v) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A ZIP archive of the files given (deflated). */
export function zip(files: Record<string, Uint8Array>): Uint8Array {
  const le = (n: number, size: number) => Array.from({ length: size }, (_, i) => (n >>> (i * 8)) & 255);
  const out: number[] = [];
  const dir: number[] = [];
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = [...new TextEncoder().encode(name)];
    const packed = deflateRaw(data, 1);
    const offset = out.length;
    const common = [...le(20, 2), ...le(0, 2), ...le(8, 2), ...le(0, 4), ...le(crc32(data), 4), ...le(packed.length, 4), ...le(data.length, 4), ...le(nameBytes.length, 2), ...le(0, 2)];
    out.push(...le(0x04034b50, 4), ...common, ...nameBytes, ...packed);
    dir.push(...le(0x02014b50, 4), ...le(20, 2), ...common, ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 4), ...le(offset, 4), ...nameBytes);
  }
  const at = out.length;
  out.push(...dir, ...le(0x06054b50, 4), ...le(0, 4), ...le(Object.keys(files).length, 2), ...le(Object.keys(files).length, 2), ...le(dir.length, 4), ...le(at, 4), ...le(0, 2));
  return Uint8Array.from(out);
}

// --- Binary plist --------------------------------------------------------------------------------

type P = string | number | { uid: number } | P[] | { [k: string]: P };

/** A binary property list of `root` (ASCII strings, integers, reals, UIDs, arrays and dictionaries). */
export function bplist(root: P): Uint8Array {
  const objects: number[][] = [];
  const add = (v: P): number => {
    const i = objects.length;
    objects.push([]);
    const len = (kind: number, n: number) => (n < 15 ? [(kind << 4) | n] : [(kind << 4) | 15, 0x11, n >> 8, n & 255]);
    if (typeof v === 'string') objects[i] = [...len(5, v.length), ...[...v].map((c) => c.charCodeAt(0))];
    else if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 65536) objects[i] = [0x11, v >> 8, v & 255];
    else if (typeof v === 'number') {
      const f = new DataView(new ArrayBuffer(8));
      f.setFloat64(0, v);
      objects[i] = [0x23, ...new Uint8Array(f.buffer)];
    } else if (Array.isArray(v)) {
      const refs = v.map(add);
      objects[i] = [...len(0xa, refs.length), ...refs];
    } else if ('uid' in v && typeof v.uid === 'number') objects[i] = [0x80, v.uid];
    else {
      const keys = Object.keys(v).map(add);
      const vals = Object.values(v).map(add);
      objects[i] = [...len(0xd, keys.length), ...keys, ...vals];
    }
    return i;
  };
  add(root);
  if (objects.length > 255) throw new Error('bplist helper: too many objects');
  const body: number[] = [...'bplist00'].map((c) => c.charCodeAt(0));
  const offsets: number[] = [];
  for (const o of objects) {
    offsets.push(body.length);
    body.push(...o);
  }
  const table = body.length;
  for (const o of offsets) body.push(o >> 8, o & 255);
  const be8 = (n: number) => [0, 0, 0, 0, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  body.push(0, 0, 0, 0, 0, 0, 2, 1, ...be8(objects.length), ...be8(0), ...be8(table));
  return Uint8Array.from(body);
}

/** A Procreate `Brush.archive` naming the brush, with its plot spacing. */
export function brushArchive(name: string, plotSpacing: number): Uint8Array {
  return bplist({ $archiver: 'NSKeyedArchiver', $version: 100000, $top: { root: { uid: 1 } }, $objects: ['$null', { name: { uid: 2 }, plotSpacing }, name] });
}

/** A Procreate source PNG: white marks on black. */
export function procreatePng(w: number, h: number, mask = tipMask(w, h)): Uint8Array {
  return parseDataUrl(pngDataUrl(w, h, mask, 1))!.bytes;
}

/** A Procreate `.brushset`: two brushes (the first with a grain) and a licence file. */
export function brushset(): Uint8Array {
  return zip({
    'brushset.plist': bplist({ brushes: ['A1', 'B2'], name: 'Test set' }),
    'A1/Brush.archive': brushArchive('Dry ink', 0.15),
    'A1/Shape.png': procreatePng(24, 24),
    'A1/Grain.png': procreatePng(16, 16, Uint8Array.from({ length: 256 }, (_, i) => (i % 16 < 8 ? 255 : 40))),
    'B2/Brush.archive': brushArchive('Soft round', 0.05),
    'B2/Shape.png': procreatePng(20, 20),
    'LICENSE.txt': new TextEncoder().encode('Made for the Pixerate tests. CC0: no rights reserved.'),
  });
}

/** A single Procreate `.brush`. */
export function singleBrush(): Uint8Array {
  return zip({ 'Brush.archive': brushArchive('Leafy', 0.4), 'Shape.png': procreatePng(32, 20), 'QuickLook/Thumbnail.png': procreatePng(8, 8) });
}
