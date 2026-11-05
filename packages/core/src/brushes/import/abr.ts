/**
 * A defensive reader for Photoshop brush files (`.abr`): the tips, not the presets around them.
 *
 * - Versions 1 and 2: computed tips (diameter, roundness, angle, hardness, spacing) and sampled
 *   tips (a grey image, raw or PackBits-compressed, 8 or 16 bits).
 * - Versions 6, 7 and 10: the sampled tips of the `samp` section. Preset names and spacing are
 *   read from the `desc` section where they can be found by their keys; everything else in it
 *   (dynamics, textures, dual brushes) is reported, not mapped. Patterns (`patt`) are reported.
 *
 * The format is undocumented, so this follows what GIMP and Krita read. Brush files are untrusted:
 * every read is bounds-checked, sizes are limited, and a tip that can't be read is reported and
 * skipped rather than failing the whole file.
 */

/** A tip read from a brush file. */
export type AbrTip =
  | {
      kind: 'sampled';
      /** The preset's name, when the file has one. */
      name?: string;
      width: number;
      height: number;
      /** One byte per pixel, 255 paints. */
      mask: Uint8Array;
      /** Spacing as a fraction of the diameter, when known. */
      spacing?: number;
    }
  | {
      kind: 'computed';
      name?: string;
      /** px. */
      diameter: number;
      /** 0..1. */
      roundness: number;
      /** Degrees. */
      angle: number;
      /** 0..1. */
      hardness: number;
      spacing: number;
    };

export interface AbrFile {
  version: number;
  tips: AbrTip[];
  /** What the file has that was not read, in words. */
  unsupported: string[];
}

export class AbrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbrError';
  }
}

/** Largest tip image read (pixels); Photoshop's own limit is 5000 × 5000. */
const MAX_TIP_PIXELS = 5000 * 5000;
/** Most tips read from one file. */
const MAX_TIPS = 1000;

class Reader {
  pos = 0;
  constructor(
    readonly bytes: Uint8Array,
    readonly end = bytes.length,
  ) {}
  need(n: number): void {
    if (n < 0 || this.pos + n > this.end) throw new AbrError('The brush file ends early or a size in it is wrong.');
  }
  u8(): number {
    this.need(1);
    return this.bytes[this.pos++];
  }
  u16(): number {
    this.need(2);
    const v = (this.bytes[this.pos] << 8) | this.bytes[this.pos + 1];
    this.pos += 2;
    return v;
  }
  i16(): number {
    const v = this.u16();
    return v & 0x8000 ? v - 0x10000 : v;
  }
  u32(): number {
    this.need(4);
    const b = this.bytes;
    const v = ((b[this.pos] << 24) | (b[this.pos + 1] << 16) | (b[this.pos + 2] << 8) | b[this.pos + 3]) >>> 0;
    this.pos += 4;
    return v;
  }
  i32(): number {
    return this.u32() | 0;
  }
  take(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }
  ascii(n: number): string {
    return String.fromCharCode(...this.take(n));
  }
}

/** PackBits rows: `height` big-endian row lengths, then each row's runs, into `rowBytes` per row. */
function unpackRows(r: Reader, height: number, rowBytes: number): Uint8Array {
  const lengths: number[] = [];
  for (let y = 0; y < height; y++) lengths.push(r.u16());
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const row = new Reader(r.take(lengths[y]));
    let x = 0;
    while (row.pos < row.end && x < rowBytes) {
      const n = row.u8();
      if (n < 128) {
        const run = Math.min(n + 1, rowBytes - x);
        out.set(row.take(run), y * rowBytes + x);
        if (n + 1 > run) row.skip(Math.min(n + 1 - run, row.end - row.pos));
        x += run;
      } else if (n > 128) {
        const v = row.u8();
        const run = Math.min(257 - n, rowBytes - x);
        out.fill(v, y * rowBytes + x, y * rowBytes + x + run);
        x += run;
      }
      // 128 is a no-op.
    }
  }
  return out;
}

/** A tip image (`depth` 8 or 16 bits, raw or PackBits) as one byte per pixel. */
function readImage(r: Reader, width: number, height: number, depth: number, compression: number): Uint8Array {
  if (!(width > 0 && height > 0)) throw new AbrError(`A tip is ${width}×${height} px.`);
  if (width * height > MAX_TIP_PIXELS) throw new AbrError(`A tip is ${width}×${height} px; tips over ${MAX_TIP_PIXELS} pixels are not read.`);
  if (depth !== 8 && depth !== 16) throw new AbrError(`A tip has ${depth}-bit depth; 8 and 16 bits are read.`);
  const bpp = depth / 8;
  const rowBytes = width * bpp;
  const data = compression === 0 ? r.take(rowBytes * height) : compression === 1 ? unpackRows(r, height, rowBytes) : null;
  if (!data) throw new AbrError(`A tip uses compression ${compression}; raw and PackBits are read.`);
  if (bpp === 1) return Uint8Array.from(data);
  const out = new Uint8Array(width * height);
  // 16 bits: the high byte of each big-endian sample.
  for (let i = 0; i < out.length; i++) out[i] = data[i * 2];
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function readV1(r: Reader, version: number, file: AbrFile): void {
  const count = r.u16();
  for (let i = 0; i < count && file.tips.length < MAX_TIPS; i++) {
    const type = r.u16();
    const size = r.u32();
    r.need(size);
    const end = r.pos + size;
    const b = new Reader(r.bytes, end);
    b.pos = r.pos;
    try {
      if (type === 1) {
        b.skip(4);
        const spacing = b.u16();
        const diameter = b.u16();
        const roundness = b.u16();
        const angle = b.i16();
        const hardness = b.u16();
        file.tips.push({ kind: 'computed', diameter: clamp(diameter, 1, 2500), roundness: clamp(roundness / 100, 0.01, 1), angle: clamp(angle, -180, 180), hardness: clamp(hardness / 100, 0, 1), spacing: clamp(spacing / 100, 0.01, 10) });
      } else if (type === 2) {
        b.skip(4);
        const spacing = b.u16();
        let name: string | undefined;
        if (version === 2) {
          const n = b.u32();
          if (n > 1024) throw new AbrError('A tip name is too long.');
          const chars: number[] = [];
          for (let k = 0; k < n; k++) chars.push(b.u16());
          name = String.fromCharCode(...chars).replace(/\0+$/, '').trim() || undefined;
        }
        b.skip(1 + 8);
        const top = b.i32();
        const left = b.i32();
        const bottom = b.i32();
        const right = b.i32();
        const depth = b.u16();
        const compression = b.u8();
        const width = right - left;
        const height = bottom - top;
        file.tips.push({ kind: 'sampled', ...(name ? { name } : {}), width, height, mask: readImage(b, width, height, depth, compression), ...(spacing ? { spacing: clamp(spacing / 100, 0.01, 10) } : {}) });
      } else file.unsupported.push(`Brush ${i + 1} is of type ${type}, which is not read.`);
    } catch (e) {
      file.unsupported.push(`Brush ${i + 1} could not be read: ${(e as Error).message}`);
    }
    r.pos = end;
  }
}

/** Names and spacing of the presets in a `desc` section, by the sampled tip each names (`sampledData`). */
function readDescriptor(bytes: Uint8Array): Map<string, { name?: string; spacing?: number }> {
  const out = new Map<string, { name?: string; spacing?: number }>();
  const find = (pattern: number[], from: number) => {
    outer: for (let p = from; p <= bytes.length - pattern.length; p++) {
      for (let k = 0; k < pattern.length; k++) if (bytes[p + k] !== pattern[k]) continue outer;
      return p;
    }
    return -1;
  };
  const code = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const text = (p: number): string | null => {
    const r = new Reader(bytes);
    r.pos = p;
    try {
      const n = r.u32();
      if (n > 512) return null;
      const chars: number[] = [];
      for (let k = 0; k < n; k++) chars.push(r.u16());
      return String.fromCharCode(...chars).replace(/\0+$/, '');
    } catch {
      return null;
    }
  };
  const NAME = code('Nm  TEXT');
  const SAMPLED = code('sampledDataTEXT');
  const SPACING = code('SpcnUntF#Prc');
  let lastName: string | undefined;
  let lastNameAt = -1;
  for (let p = find(SAMPLED, 0); p >= 0; p = find(SAMPLED, p + SAMPLED.length)) {
    // The preset's name is the last Nm before its sampledData; its spacing the first Spcn after.
    for (let q = find(NAME, lastNameAt + 1); q >= 0 && q < p; q = find(NAME, q + NAME.length)) {
      lastName = text(q + NAME.length) ?? undefined;
      lastNameAt = q;
    }
    const uuid = text(p + SAMPLED.length);
    if (!uuid) continue;
    const s = find(SPACING, p);
    let spacing: number | undefined;
    if (s >= 0 && s + SPACING.length + 8 <= bytes.length) {
      const v = new DataView(bytes.buffer, bytes.byteOffset + s + SPACING.length, 8).getFloat64(0);
      if (Number.isFinite(v) && v > 0) spacing = clamp(v / 100, 0.01, 10);
    }
    if (!out.has(uuid)) out.set(uuid, { ...(lastName ? { name: lastName.trim() } : {}), ...(spacing !== undefined ? { spacing } : {}) });
  }
  return out;
}

function readV6(r: Reader, subversion: number, file: AbrFile): void {
  const samples: Array<{ uuid: string; tip: Extract<AbrTip, { kind: 'sampled' }> }> = [];
  let presets = new Map<string, { name?: string; spacing?: number }>();
  while (r.pos + 12 <= r.end) {
    const sig = r.ascii(4);
    if (sig !== '8BIM' && sig !== '8B64') break;
    const key = r.ascii(4);
    const len = r.u32();
    r.need(len);
    const end = r.pos + len;
    if (key === 'samp') {
      const s = new Reader(r.bytes, end);
      s.pos = r.pos;
      while (s.pos + 4 <= end && samples.length < MAX_TIPS) {
        const size = s.u32();
        const padded = size + ((4 - (size % 4)) % 4);
        const next = s.pos + padded;
        if (s.pos + size > end) break;
        const b = new Reader(r.bytes, s.pos + size);
        b.pos = s.pos;
        try {
          const keyLen = b.u8();
          const uuid = b.ascii(keyLen);
          // GIMP skips the key and what follows it: 47 bytes in all (subversion 1), 301 (subversion 2).
          b.pos = s.pos + (subversion === 1 ? 47 : 301);
          const top = b.i32();
          const left = b.i32();
          const bottom = b.i32();
          const right = b.i32();
          const depth = b.u16();
          const compression = b.u8();
          const width = right - left;
          const height = bottom - top;
          samples.push({ uuid, tip: { kind: 'sampled', width, height, mask: readImage(b, width, height, depth, compression) } });
        } catch (e) {
          file.unsupported.push(`Sampled tip ${samples.length + 1} could not be read: ${(e as Error).message}`);
        }
        s.pos = Math.min(next, end);
      }
    } else if (key === 'desc') presets = readDescriptor(r.bytes.subarray(r.pos, end));
    else if (key === 'patt') file.unsupported.push('Patterns (the brushes\' textures) are not imported; add a pattern image as a grain source with add_brush_source.');
    r.pos = end + (len % 2);
  }
  for (const { uuid, tip } of samples) {
    const p = presets.get(uuid);
    file.tips.push({ ...tip, ...(p?.name ? { name: p.name } : {}), ...(p?.spacing !== undefined ? { spacing: p.spacing } : {}) });
  }
  if (presets.size) file.unsupported.push('Preset dynamics, textures, dual brushes and colour settings are not mapped; each tip imports with its name and spacing.');
}

/** The tips of an `.abr` file (see the module comment). Throws an `AbrError` when the file is not one at all. */
export function readAbr(bytes: Uint8Array): AbrFile {
  const r = new Reader(bytes);
  let version: number;
  try {
    version = r.u16();
  } catch {
    throw new AbrError('Not a brush file: it is empty.');
  }
  const file: AbrFile = { version, tips: [], unsupported: [] };
  try {
    if (version === 1 || version === 2) readV1(r, version, file);
    else if (version === 6 || version === 7 || version === 10) {
      const subversion = r.u16();
      if (subversion !== 1 && subversion !== 2) throw new AbrError(`ABR version ${version}.${subversion} is not supported.`);
      readV6(r, subversion, file);
    } else throw new AbrError(`Not a Photoshop brush file, or ABR version ${version}, which is not supported (1, 2, 6, 7 and 10 are).`);
  } catch (e) {
    if (!file.tips.length) throw e instanceof AbrError ? e : new AbrError((e as Error).message);
    file.unsupported.push(`The rest of the file could not be read: ${(e as Error).message}`);
  }
  return file;
}
