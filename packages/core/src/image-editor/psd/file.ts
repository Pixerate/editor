// Portions ported from photocraft/crates/psd/src/{header,file,layer,tagged,tree,resources,image_data}.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * The PSD / PSB container: header, colour mode data, image resources, layer and mask info
 * (records, channel data, tagged blocks) and the merged image. Channel data stays encoded
 * until a caller decodes it, so inspecting a file is cheap.
 */

import { PsdError, PsdReader, PsdWriter, decodeLegacyName } from './binary';
import { decodePlanes, rowBytes } from './compression';

export const PSD_MAX_DIMENSION = 30_000;
export const PSB_MAX_DIMENSION = 300_000;
const MAX_CHANNELS = 56;
const MAX_LAYER_CHANNELS = 64;

export const COLOR_MODES: Record<number, string> = {
  0: 'bitmap',
  1: 'grayscale',
  2: 'indexed',
  3: 'rgb',
  4: 'cmyk',
  7: 'multichannel',
  8: 'duotone',
  9: 'lab',
};

/** Tagged block keys whose length is 8 bytes in a PSB. */
const PSB_LONG_KEYS = new Set([
  'LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD',
  'lnk3', 'lnkE', 'pths', 'extd', 'extn', 'FELS', 'cinf', 'artd',
]);

export const CHANNEL_ALPHA = -1;
export const CHANNEL_USER_MASK = -2;
export const CHANNEL_REAL_USER_MASK = -3;

export const LAYER_FLAG_TRANSPARENCY_PROTECTED = 1;
export const LAYER_FLAG_HIDDEN = 2;
/** Mask flag bit 0, "position relative to layer": Photoshop sets it when the mask is unlinked (photocraft reads it so). */
export const MASK_FLAG_UNLINKED = 1;
export const MASK_FLAG_DISABLED = 2;
export const MASK_FLAG_PARAMETERS = 16;

/** Section divider (`lsct`) kinds. */
export const SECTION_OTHER = 0;
export const SECTION_OPEN = 1;
export const SECTION_CLOSED = 2;
export const SECTION_DIVIDER = 3;

export interface PsdHeader {
  psb: boolean;
  channels: number;
  height: number;
  width: number;
  depth: number;
  colorMode: number;
}

export interface PsdRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface PsdChannel {
  id: number;
  /** `null` for a zero-length channel. */
  compression: number | null;
  /** Encoded bytes, without the compression field. */
  data: Uint8Array;
}

export interface PsdLayerMask {
  rect: PsdRect;
  defaultColor: number;
  flags: number;
  userDensity?: number;
  userFeather?: number;
  vectorDensity?: number;
  vectorFeather?: number;
  /** The real (vector-combined) user mask, when present. */
  real?: { flags: number; background: number; rect: PsdRect };
}

export interface PsdTaggedBlock {
  key: string;
  data: Uint8Array;
}

export interface PsdLayerRecord {
  rect: PsdRect;
  channels: PsdChannel[];
  blendKey: string;
  opacity: number;
  clipping: number;
  flags: number;
  mask?: PsdLayerMask;
  /** The legacy (Pascal) name; `layerName` prefers `luni`. */
  legacyName: string;
  blocks: PsdTaggedBlock[];
}

export interface PsdResource {
  id: number;
  name: string;
  data: Uint8Array;
}

export interface PsdFile {
  header: PsdHeader;
  colorModeData: Uint8Array;
  resources: PsdResource[];
  /** Bottom-most first, as stored. */
  layers: PsdLayerRecord[];
  /** The layer count was negative: the merged image's first extra channel is its alpha. */
  mergedAlpha: boolean;
  globalBlocks: PsdTaggedBlock[];
  imageCompression: number;
  imageData: Uint8Array;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function readRect(r: PsdReader): PsdRect {
  return { top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32() };
}

export function rectSize(rect: PsdRect): { width: number; height: number } {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  if (width < 0 || height < 0) throw new PsdError('A layer rectangle has a negative size.');
  if (width > PSB_MAX_DIMENSION || height > PSB_MAX_DIMENSION) throw new PsdError('A layer is larger than 300000 pixels.');
  return { width, height };
}

function readHeader(r: PsdReader): PsdHeader {
  if (r.ascii(4) !== '8BPS') throw new PsdError('Not a PSD file: the signature is not "8BPS".');
  const version = r.u16();
  if (version !== 1 && version !== 2) throw new PsdError(`Unsupported PSD version ${version} (1 is PSD, 2 is PSB).`);
  r.skip(6);
  const h: PsdHeader = { psb: version === 2, channels: r.u16(), height: r.u32(), width: r.u32(), depth: r.u16(), colorMode: r.u16() };
  if (h.channels < 1 || h.channels > MAX_CHANNELS) throw new PsdError(`Channel count ${h.channels} is outside 1 to ${MAX_CHANNELS}.`);
  if (h.width < 1 || h.height < 1) throw new PsdError(`Image size ${h.width} × ${h.height} must be at least 1 × 1.`);
  const max = h.psb ? PSB_MAX_DIMENSION : PSD_MAX_DIMENSION;
  if (h.width > max || h.height > max) throw new PsdError(`Image size ${h.width} × ${h.height} exceeds ${max} pixels.`);
  if (![1, 8, 16, 32].includes(h.depth)) throw new PsdError(`Unsupported bit depth ${h.depth}.`);
  return h;
}

function readResources(r: PsdReader): PsdResource[] {
  const s = r.sub(r.u32());
  const out: PsdResource[] = [];
  while (s.remaining >= 12) {
    s.ascii(4); // 8BIM, or another vendor signature
    const id = s.u16();
    const name = decodeLegacyName(s.pascal(2));
    const len = s.u32();
    const data = s.bytes(len);
    if (len % 2 && s.remaining) s.skip(1);
    out.push({ id, name, data });
  }
  return out;
}

const isSig = (r: PsdReader, at = 0) => {
  const b = r.data.subarray(r.pos + at, r.pos + at + 4);
  if (b.length < 4) return false;
  const s = String.fromCharCode(b[0], b[1], b[2], b[3]);
  return s === '8BIM' || s === '8B64';
};

/** Tagged blocks until the end of `r` (or something that is not a block). */
function readBlocks(r: PsdReader, psb: boolean, alignment: number): PsdTaggedBlock[] {
  const out: PsdTaggedBlock[] = [];
  while (r.remaining >= 12 && isSig(r)) {
    r.skip(4);
    const key = r.ascii(4);
    const len = r.len(psb && PSB_LONG_KEYS.has(key));
    const data = r.bytes(len);
    // Writers disagree on padding: take the gap up to the next signature, else the default.
    let pad = -1;
    for (let k = 0; k <= 3; k++) {
      if (k === r.remaining || (k < r.remaining && isSig(r, k))) {
        pad = k;
        break;
      }
    }
    if (pad < 0) {
      const def = (alignment - (len % alignment)) % alignment;
      pad = r.peek(def).every((b) => b === 0) && r.remaining >= def ? def : 0;
    }
    r.skip(pad);
    out.push({ key, data });
  }
  return out;
}

function maskParameterBytes(pf: number): number {
  return (pf & 1 ? 1 : 0) + (pf & 2 ? 8 : 0) + (pf & 4 ? 1 : 0) + (pf & 8 ? 8 : 0);
}

/** Photoshop writes the real mask before the parameters; the spec says after. Guess which. */
function realBeforeParameters(d: Uint8Array): boolean {
  const fits = (at: number) => {
    if (at >= d.length) return false;
    const end = at + 1 + maskParameterBytes(d[at]);
    return d.length >= end && d.length <= end + 3;
  };
  if (fits(18)) return false;
  if (!fits(36)) return false;
  const known = (pf: number) => (pf & 0xf0) === 0;
  const bgOk = (at: number) => at + 1 < d.length && (d[at + 1] === 0 || d[at + 1] === 255);
  const photoshop = bgOk(18) && known(d[36]);
  const realAt = 19 + maskParameterBytes(d[18]);
  const spec = known(d[18]) && d.length >= realAt + 18 && d.length <= realAt + 21 && bgOk(realAt);
  return photoshop || !spec;
}

function parseMask(d: Uint8Array): PsdLayerMask | undefined {
  try {
    const r = new PsdReader(d);
    const m: PsdLayerMask = { rect: readRect(r), defaultColor: r.u8(), flags: r.u8() };
    const readReal = () => (r.remaining >= 18 ? { flags: r.u8(), background: r.u8(), rect: readRect(r) } : undefined);
    const params = (m.flags & MASK_FLAG_PARAMETERS) !== 0;
    const realFirst = params && realBeforeParameters(d);
    if (realFirst) m.real = readReal();
    if (params) {
      const pf = r.u8();
      if (pf & 1) m.userDensity = r.u8();
      if (pf & 2) m.userFeather = r.f64();
      if (pf & 4) m.vectorDensity = r.u8();
      if (pf & 8) m.vectorFeather = r.f64();
    }
    if (!realFirst) m.real = readReal();
    return m;
  } catch {
    return undefined;
  }
}

function readLayerRecord(r: PsdReader, psb: boolean): { record: PsdLayerRecord; lengths: number[] } {
  const rect = readRect(r);
  const n = r.u16();
  if (n > MAX_LAYER_CHANNELS) throw new PsdError(`A layer has ${n} channels (at most ${MAX_LAYER_CHANNELS}).`);
  const channels: PsdChannel[] = [];
  const lengths: number[] = [];
  for (let i = 0; i < n; i++) {
    channels.push({ id: r.i16(), compression: null, data: new Uint8Array(0) });
    lengths.push(r.len(psb));
  }
  if (r.ascii(4) !== '8BIM') throw new PsdError('A layer record has no "8BIM" blend-mode signature.');
  const blendKey = r.ascii(4);
  const opacity = r.u8();
  const clipping = r.u8();
  const flags = r.u8();
  r.u8();
  const x = r.sub(r.u32());
  const maskBytes = x.bytes(x.u32());
  const mask = maskBytes.length ? parseMask(maskBytes) : undefined;
  x.skip(x.u32()); // blending ranges
  const legacyName = decodeLegacyName(x.pascal(4));
  const blocks = readBlocks(x, psb, 2);
  return { record: { rect, channels, blendKey, opacity, clipping, flags, mask, legacyName, blocks }, lengths };
}

function readLayerInfo(data: Uint8Array, psb: boolean): { layers: PsdLayerRecord[]; mergedAlpha: boolean } {
  const r = new PsdReader(data);
  const count = r.i16();
  const n = Math.abs(count);
  r.checkCount(n, 34, 'Layer records');
  const read = [];
  for (let i = 0; i < n; i++) read.push(readLayerRecord(r, psb));
  for (const { record, lengths } of read) {
    record.channels.forEach((ch, i) => {
      const len = lengths[i];
      if (len === 0) return;
      if (len === 1) throw new PsdError('A channel has a data length of 1.');
      ch.compression = r.u16();
      ch.data = r.bytes(len - 2);
    });
  }
  return { layers: read.map((x) => x.record), mergedAlpha: count < 0 };
}

/** Parses a PSD or PSB. Throws `PsdError` with what was wrong. */
export function readPsd(bytes: Uint8Array): PsdFile {
  const r = new PsdReader(bytes);
  const header = readHeader(r);
  const { psb } = header;
  const colorModeData = r.bytes(r.u32());
  const resources = readResources(r);
  const s = r.sub(r.len(psb));
  let layers: PsdLayerRecord[] = [];
  let mergedAlpha = false;
  let globalBlocks: PsdTaggedBlock[] = [];
  if (s.remaining) {
    const liLen = s.len(psb);
    if (liLen > 0) ({ layers, mergedAlpha } = readLayerInfo(s.bytes(liLen), psb));
    if (s.remaining >= 4) {
      s.skip(s.u32()); // global layer mask
      globalBlocks = readBlocks(s, psb, 4);
      // 16- and 32-bit files keep their layers in an Lr16 / Lr32 block.
      const key = header.depth === 16 ? 'Lr16' : header.depth === 32 ? 'Lr32' : null;
      const block = globalBlocks.find((b) => (key ? b.key === key : !layers.length && ['Layr', 'Lr16', 'Lr32'].includes(b.key)));
      if (block) {
        ({ layers, mergedAlpha } = readLayerInfo(block.data, psb));
        globalBlocks = globalBlocks.filter((b) => b !== block);
      }
    }
  }
  const imageCompression = r.remaining >= 2 ? r.u16() : 0;
  return { header, colorModeData, resources, layers, mergedAlpha, globalBlocks, imageCompression, imageData: r.rest() };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function layerBlock(rec: PsdLayerRecord, key: string): Uint8Array | undefined {
  return rec.blocks.find((b) => b.key === key)?.data;
}

export function layerName(rec: PsdLayerRecord): string {
  const luni = layerBlock(rec, 'luni');
  if (luni) {
    try {
      return new PsdReader(luni).unicode();
    } catch {
      // fall back to the legacy name
    }
  }
  return rec.legacyName;
}

export interface SectionDivider {
  kind: number;
  blendKey?: string;
}

export function sectionDivider(rec: PsdLayerRecord): SectionDivider | undefined {
  const d = layerBlock(rec, 'lsct') ?? layerBlock(rec, 'lsdk');
  if (!d || d.length < 4) return undefined;
  const r = new PsdReader(d);
  const kind = r.u32();
  if (r.remaining >= 8 && r.ascii(4) === '8BIM') return { kind, blendKey: r.ascii(4) };
  return { kind };
}

export function u32Block(rec: PsdLayerRecord, key: string): number | undefined {
  const d = layerBlock(rec, key);
  return d && d.length >= 4 ? new PsdReader(d).u32() : undefined;
}

export function u8Block(rec: PsdLayerRecord, key: string): number | undefined {
  const d = layerBlock(rec, key);
  return d && d.length >= 1 ? d[0] : undefined;
}

export interface PsdTreeNode {
  /** Index into `PsdFile.layers` (the folder record for a group). */
  index: number;
  children?: PsdTreeNode[];
}

/** The layer tree, bottom-most first (the stored order, as in our model), from the `lsct` dividers. */
export function layerTree(file: PsdFile): PsdTreeNode[] {
  const stack: PsdTreeNode[][] = [[]];
  file.layers.forEach((rec, index) => {
    const kind = sectionDivider(rec)?.kind ?? SECTION_OTHER;
    if (kind === SECTION_DIVIDER) {
      stack.push([]);
    } else if (kind === SECTION_OPEN || kind === SECTION_CLOSED) {
      const children = stack.length > 1 ? stack.pop()! : [];
      stack[stack.length - 1].push({ index, children });
    } else {
      stack[stack.length - 1].push({ index });
    }
  });
  while (stack.length > 1) {
    const children = stack.pop()!;
    stack[stack.length - 1].push(...children);
  }
  return stack[0];
}

export function channelRect(rec: PsdLayerRecord, id: number): PsdRect {
  if (id === CHANNEL_USER_MASK && rec.mask) return rec.mask.rect;
  if (id === CHANNEL_REAL_USER_MASK && rec.mask) return rec.mask.real?.rect ?? rec.mask.rect;
  return rec.rect;
}

/** One layer channel decoded to `depth`-bit planar bytes, or `undefined` if the layer has none. */
export function decodeLayerChannel(file: PsdFile, rec: PsdLayerRecord, id: number): Uint8Array | undefined {
  const ch = rec.channels.find((c) => c.id === id);
  if (!ch) return undefined;
  const { width, height } = rectSize(channelRect(rec, id));
  if (ch.compression === null) {
    if (width * height === 0) return new Uint8Array(0);
    throw new PsdError(`Channel ${id} of layer "${layerName(rec)}" has no data.`);
  }
  return decodePlanes(ch.compression, ch.data, { planes: 1, width, height, depth: file.header.depth, psb: file.header.psb });
}

/** The merged image's channels decoded, planar. */
export function decodeMergedImage(file: PsdFile): Uint8Array {
  const { channels, width, height, depth, psb } = file.header;
  return decodePlanes(file.imageCompression, file.imageData, { planes: channels, width, height, depth, psb });
}

export function resource(file: PsdFile, id: number): Uint8Array | undefined {
  return file.resources.find((r) => r.id === id)?.data;
}

/** Resolution (1005) in pixels per inch, or `undefined`. */
export function resolution(file: PsdFile): number | undefined {
  const d = resource(file, 1005);
  if (!d || d.length < 4) return undefined;
  return new PsdReader(d).u32() / 65536;
}

export { rowBytes };

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function writeRect(w: PsdWriter, r: PsdRect): void {
  w.i32(r.top);
  w.i32(r.left);
  w.i32(r.bottom);
  w.i32(r.right);
}

function writeBlocks(w: PsdWriter, blocks: PsdTaggedBlock[], psb: boolean, alignment: number): void {
  for (const b of blocks) {
    const long = psb && PSB_LONG_KEYS.has(b.key);
    w.ascii(long ? '8B64' : '8BIM');
    w.ascii(b.key);
    // Pad inside the declared length, as Photoshop does, so readers that skip by length stay aligned.
    const pad = (alignment - (b.data.length % alignment)) % alignment;
    if (long) w.u64(b.data.length + pad);
    else w.u32(b.data.length + pad);
    w.bytes(b.data);
    w.zeros(pad);
  }
}

function writeMask(w: PsdWriter, m: PsdLayerMask): void {
  writeRect(w, m.rect);
  w.u8(m.defaultColor);
  const pf =
    (m.userDensity !== undefined ? 1 : 0) | (m.userFeather !== undefined ? 2 : 0) | (m.vectorDensity !== undefined ? 4 : 0) | (m.vectorFeather !== undefined ? 8 : 0);
  w.u8(pf ? m.flags | MASK_FLAG_PARAMETERS : m.flags & ~MASK_FLAG_PARAMETERS);
  if (pf) {
    w.u8(pf);
    if (m.userDensity !== undefined) w.u8(m.userDensity);
    if (m.userFeather !== undefined) w.f64(m.userFeather);
    if (m.vectorDensity !== undefined) w.u8(m.vectorDensity);
    if (m.vectorFeather !== undefined) w.f64(m.vectorFeather);
  }
  // Pad to the 20-byte minimum the spec asks for.
  const len = 18 + (pf ? 1 + maskParameterBytes(pf) : 0);
  w.zeros(Math.max(0, 20 - len) + ((4 - (Math.max(20, len) % 4)) % 4));
}

function writeLayerRecord(w: PsdWriter, rec: PsdLayerRecord, psb: boolean, nameBytes: Uint8Array): void {
  writeRect(w, rec.rect);
  w.u16(rec.channels.length);
  for (const c of rec.channels) {
    w.i16(c.id);
    const len = c.compression === null ? 0 : 2 + c.data.length;
    if (psb) w.u64(len);
    else w.u32(len);
  }
  if (rec.blendKey.length !== 4) throw new PsdError(`Blend key "${rec.blendKey}" must be 4 characters.`);
  w.ascii('8BIM');
  w.ascii(rec.blendKey);
  w.u8(rec.opacity);
  w.u8(rec.clipping);
  w.u8(rec.flags);
  w.u8(0);
  const extra = w.beginLen(false);
  const mask = w.beginLen(false);
  if (rec.mask) writeMask(w, rec.mask);
  w.endLen(mask);
  // Blending ranges: composite gray plus one per colour channel, all full.
  w.u32(40);
  for (let i = 0; i < 5; i++) w.bytes([0, 0, 255, 255, 0, 0, 255, 255]);
  w.pascal(nameBytes, 4);
  writeBlocks(w, rec.blocks, psb, 2);
  w.endLen(extra);
}

/** Serializes a file. Channel data must already be encoded; `encodeName` writes legacy (Pascal) names. */
export function writePsd(file: PsdFile, encodeName: (s: string) => Uint8Array): Uint8Array {
  const { header } = file;
  const { psb } = header;
  const w = new PsdWriter();
  w.ascii('8BPS');
  w.u16(psb ? 2 : 1);
  w.zeros(6);
  w.u16(header.channels);
  w.u32(header.height);
  w.u32(header.width);
  w.u16(header.depth);
  w.u16(header.colorMode);
  w.u32(file.colorModeData.length);
  w.bytes(file.colorModeData);
  const res = w.beginLen(false);
  for (const r of file.resources) {
    w.ascii('8BIM');
    w.u16(r.id);
    w.pascal(encodeName(r.name), 2);
    w.u32(r.data.length);
    w.bytes(r.data);
    if (r.data.length % 2) w.u8(0);
  }
  w.endLen(res);
  const lm = w.beginLen(psb);
  if (file.layers.length || file.globalBlocks.length) {
    const writeLayerInfo = (out: PsdWriter) => {
      const start = out.length;
      out.i16(file.mergedAlpha ? -file.layers.length : file.layers.length);
      for (const rec of file.layers) writeLayerRecord(out, rec, psb, encodeName(rec.legacyName));
      for (const rec of file.layers) {
        for (const c of rec.channels) {
          if (c.compression === null) continue;
          out.u16(c.compression);
          out.bytes(c.data);
        }
      }
      if ((out.length - start) % 2) out.u8(0);
    };
    // 16- and 32-bit files keep their layers in an Lr16 / Lr32 block, as Photoshop writes them.
    const deepKey = header.depth === 16 ? 'Lr16' : header.depth === 32 ? 'Lr32' : null;
    let blocks = file.globalBlocks;
    const li = w.beginLen(psb);
    if (file.layers.length && !deepKey) writeLayerInfo(w);
    w.endLen(li);
    if (file.layers.length && deepKey) {
      const lw = new PsdWriter();
      writeLayerInfo(lw);
      blocks = [{ key: deepKey, data: lw.result() }, ...blocks];
    }
    w.u32(0); // no global layer mask
    writeBlocks(w, blocks, psb, 4);
  }
  w.endLen(lm);
  w.u16(file.imageCompression);
  w.bytes(file.imageData);
  return w.result();
}
