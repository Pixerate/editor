// Portions ported from photocraft/crates/io/src/smart_map.rs, photocraft/crates/io/src/linked.rs, photocraft/crates/io/src/blocks.rs (placed-layer parsing) and photocraft/crates/psd/src/filter_effects.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Smart objects in PSD: the placed-layer blocks (`SoLd` / `SoLE` with their `soLD` descriptor,
 * and the older `PlLd` record), the embedded and linked files (`lnk2` / `lnk3` / `lnkD`), the
 * smart filter stack (`filterFX` inside `soLD`) and the filter-effects block (`FEid` / `FXid`)
 * that holds the filter mask.
 *
 * A placement is stored as the quad (`Trnf`, or `nonAffineTransform` for distort and perspective)
 * that a source-space frame maps onto, plus a warp in source pixels: the frame is the bounding box
 * of a single-patch custom warp's control points (which may spill past the source), else the
 * source rectangle. Our placement holds where the contents' own rectangle lands, so both
 * directions go through the projective map of that frame.
 */

import { PsdError, PsdReader, PsdWriter } from './binary';
import { decodePlanes, encodeRle } from './compression';
import { descBool, descGet, descNumber, descObject, descriptor, parseVersionedDescriptor, readVersionedDescriptor, versionedDescriptorBytes, writeVersionedDescriptor, type DescValue, type Descriptor } from './descriptor';
import { blendFromPsdId, psdBlendId } from './effects';
import { applyHomography, boxQuad, rectToQuad } from '../../geom/homography';
import { evalWarpMesh, fitWarpMesh, warpPresetMesh, WARP_STYLES } from '../../geom/warp';
import type { Quad, Vec2, WarpMesh, WarpStyle } from '../../geom/types';
import type { BlendMode } from '../../raster/blend';
import { contentBounds, readRegion, surfaceFromPixels, emptySurface } from '../../raster/surface';
import type { RasterMask, SmartFilter, SmartFilterStack, SmartPlacement } from '../layers/model';

// ---------------------------------------------------------------------------
// Descriptor helpers
// ---------------------------------------------------------------------------

const dbl = (value: number): DescValue => ({ type: 'doub', value });
const unit = (u: string, value: number): DescValue => ({ type: 'UntF', unit: u, value });
const long = (value: number): DescValue => ({ type: 'long', value: Math.round(value) });
const boolV = (value: boolean): DescValue => ({ type: 'bool', value });
const enumV = (typeId: string, value: string): DescValue => ({ type: 'enum', typeId, value });
const textV = (value: string): DescValue => ({ type: 'TEXT', value });
const obj = (d: Descriptor): DescValue => ({ type: 'Objc', value: d });

const text = (d: Descriptor, key: string): string | undefined => {
  const v = descGet(d, key);
  return v?.type === 'TEXT' ? v.value : undefined;
};
const enumOf = (d: Descriptor, key: string): string | undefined => {
  const v = descGet(d, key);
  return v?.type === 'enum' ? v.value : undefined;
};
const numbers = (d: Descriptor, key: string): number[] | null => {
  const v = descGet(d, key);
  if (v?.type !== 'VlLs') return null;
  const out: number[] = [];
  for (const it of v.items) {
    if (it.type === 'doub' || it.type === 'UntF' || it.type === 'long') out.push(it.value);
    else return null;
  }
  return out;
};

function setItem(d: Descriptor, key: string, v: DescValue): void {
  const i = d.items.findIndex(([k]) => k === key);
  if (i >= 0) d.items[i] = [key, v];
  else d.items.push([key, v]);
}

function cloneDescriptor(d: Descriptor): Descriptor {
  return parseVersionedDescriptor(versionedDescriptorBytes(d));
}

/** A stable uuid-shaped id for `seed` (Photoshop keys contents and instances by uuids). */
export function psdUuid(seed: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seed)) return seed;
  // Four FNV-1a passes with different offsets give 128 bits.
  let hex = '';
  for (let k = 0; k < 4; k++) {
    let h = (0x811c9dc5 ^ (k * 0x9e3779b9)) >>> 0;
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    hex += h.toString(16).padStart(8, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Linked files (lnk2 / lnk3 / lnkD)
// ---------------------------------------------------------------------------

export const LINKED_FILE_KEYS = ['lnk2', 'lnk3', 'lnkD', 'lnkE'];

export interface PsdLinkedFile {
  /** `liFD` embedded, `liFE` external, `liFA` alias. */
  kind: string;
  uuid: string;
  name: string;
  /** The four-character file type (`8BPB`, `PNGf`, `JPEG`, …). */
  fileType: string;
  /** The embedded file (empty for external ones). */
  bytes: Uint8Array;
  /** An external file's path, when the item says. */
  path?: string;
}

function readLinkedItem(item: Uint8Array): PsdLinkedFile | null {
  const r = new PsdReader(item);
  const kind = r.ascii(4);
  const version = r.u32();
  const n = r.u8();
  const uuid = new TextDecoder().decode(r.bytes(n));
  const name = r.unicode();
  const fileType = r.ascii(4);
  r.skip(4); // creator
  const len = r.u64();
  if (r.u8() !== 0) readVersionedDescriptor(r); // open parameters
  if (kind === 'liFD') return { kind, uuid, name, fileType, bytes: r.bytes(Math.min(len, r.remaining)) };
  let path: string | undefined;
  if (kind === 'liFE') {
    try {
      const d = readVersionedDescriptor(r);
      path = text(d, 'fullPath') ?? text(d, 'originalPath') ?? text(d, 'relPath');
    } catch {
      path = undefined;
    }
    void version;
  }
  return { kind, uuid, name, fileType, bytes: new Uint8Array(0), path: path ?? name };
}

/** Every item of a linked-files block (items that cannot be read are skipped). */
export function parseLinkedFiles(data: Uint8Array): PsdLinkedFile[] {
  const out: PsdLinkedFile[] = [];
  let at = 0;
  while (at + 8 <= data.length) {
    const r = new PsdReader(data, at);
    const len = r.u64();
    if (!(len > 0) || at + 8 + len > data.length) break;
    try {
      const item = readLinkedItem(data.subarray(at + 8, at + 8 + len));
      if (item) out.push(item);
    } catch {
      // A damaged item: the layers using it keep their stored pixels.
    }
    at = (at + 8 + len + 3) & ~3;
  }
  return out;
}

/** The four-character type of a file by its first bytes. */
export function fileTypeOf(bytes: Uint8Array): { code: string; ext: string } {
  const b = bytes;
  if (b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53) return b[5] === 2 ? { code: '8BPB', ext: 'psb' } : { code: '8BPS', ext: 'psd' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { code: 'PNGf', ext: 'png' };
  if (b[0] === 0xff && b[1] === 0xd8) return { code: 'JPEG', ext: 'jpg' };
  if ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d)) return { code: 'TIFF', ext: 'tif' };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { code: 'GIFf', ext: 'gif' };
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return { code: 'PDF ', ext: 'pdf' };
  const head = new TextDecoder().decode(b.subarray(0, 256)).trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return { code: 'SVG ', ext: 'svg' };
  return { code: '    ', ext: 'bin' };
}

/** One embedded (`liFD`, version 7) linked-file item, length-prefixed and padded to 4 bytes. */
export function encodeLinkedFile(f: { uuid: string; name: string; bytes: Uint8Array }): Uint8Array {
  const w = new PsdWriter();
  w.ascii('liFD');
  w.u32(7);
  const id = new TextEncoder().encode(f.uuid).subarray(0, 255);
  w.u8(id.length);
  w.bytes(id);
  w.unicode(f.name, true);
  w.ascii(fileTypeOf(f.bytes).code);
  w.ascii('8BIM');
  w.u64(f.bytes.length);
  w.u8(0);
  w.bytes(f.bytes);
  w.u32(0); // child document id (version 5)
  w.f64(0); // asset modification time (version 6)
  w.u8(0); // asset locked (version 7)
  const item = w.result();
  const out = new PsdWriter();
  out.u64(item.length);
  out.bytes(item);
  out.zeros((4 - (out.length % 4)) % 4);
  return out.result();
}

// ---------------------------------------------------------------------------
// Filter effects (FEid / FXid): the smart filter mask
// ---------------------------------------------------------------------------

export const FILTER_EFFECTS_KEYS = ['FEid', 'FXid'];

interface Plane {
  compression: number;
  data: Uint8Array;
}

export interface FilterEffectsItem {
  id: string;
  version: number;
  rect: { top: number; left: number; bottom: number; right: number };
  depth: number;
  maxChannels: number;
  slots: Array<Plane | null>;
  mask: { rect: { top: number; left: number; bottom: number; right: number }; plane: Plane } | null;
}

const readRect = (r: PsdReader) => ({ top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32() });

function readPlane(r: PsdReader): Plane {
  const len = r.u64();
  if (len < 2) throw new PsdError('Filter effects: a plane is shorter than its compression field.');
  const s = r.sub(len);
  return { compression: s.u16(), data: s.rest() };
}

/** Reads a filter-effects block (`FEid` / `FXid`); throws `PsdError` when it is malformed. */
export function parseFilterEffects(data: Uint8Array): { version: number; items: FilterEffectsItem[] } {
  const r = new PsdReader(data);
  const version = r.u32();
  if (version < 1 || version > 3) throw new PsdError(`Filter effects version ${version}.`);
  const items: FilterEffectsItem[] = [];
  while (r.remaining >= 8) {
    const len = r.u64();
    const body = r.sub(len);
    while (body.remaining > 0) {
      const id = new TextDecoder().decode(body.pascal(1));
      const itemVersion = body.u32();
      const it = body.sub(body.u64());
      const rect = readRect(it);
      const depth = it.u32();
      const maxChannels = it.u32();
      if (maxChannels > 64) throw new PsdError('Filter effects: too many channels.');
      const slots: Array<Plane | null> = [];
      for (let i = 0; i < maxChannels + 2; i++) slots.push(it.u32() !== 0 ? readPlane(it) : null);
      let mask: FilterEffectsItem['mask'] = null;
      if (body.remaining > 0 && body.u8() !== 0) mask = { rect: readRect(body), plane: readPlane(body) };
      items.push({ id, version: itemVersion, rect, depth, maxChannels, slots, mask });
    }
    const pad = (4 - (len % 4)) % 4;
    r.skip(Math.min(pad, r.remaining));
    if (r.remaining < 8) break;
  }
  return { version, items };
}

/** Writes a filter-effects block. */
export function writeFilterEffects(items: FilterEffectsItem[], version = 3): Uint8Array {
  const w = new PsdWriter();
  w.u32(version);
  const plane = (b: PsdWriter, p: Plane) => {
    b.u64(p.data.length + 2);
    b.u16(p.compression);
    b.bytes(p.data);
  };
  const rect = (b: PsdWriter, r: FilterEffectsItem['rect']) => {
    b.i32(r.top);
    b.i32(r.left);
    b.i32(r.bottom);
    b.i32(r.right);
  };
  for (const it of items) {
    const b = new PsdWriter();
    b.pascal(new TextEncoder().encode(it.id), 1);
    b.u32(it.version);
    const mark = b.beginLen(true);
    rect(b, it.rect);
    b.u32(it.depth);
    b.u32(it.maxChannels);
    for (let i = 0; i < it.maxChannels + 2; i++) {
      const p = it.slots[i];
      if (p) {
        b.u32(1);
        plane(b, p);
      } else b.u32(0);
    }
    b.endLen(mark);
    if (it.mask) {
      b.u8(1);
      rect(b, it.mask.rect);
      plane(b, it.mask.plane);
    } else b.u8(0);
    const body = b.result();
    w.u64(body.length);
    w.bytes(body);
    w.zeros((4 - (w.length % 4)) % 4);
  }
  if (!items.length) w.u64(0);
  return w.result();
}

/** The filter mask of a filter-effects item as a document-space mask (8-bit only), or `null`. */
export function filterMaskFromItem(item: FilterEffectsItem): RasterMask | null {
  if (!item.mask || item.depth !== 8) return null;
  const { rect, plane } = item.mask;
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  if (!(width > 0 && height > 0) || width * height > 1 << 28) return null;
  const bytes = decodePlanes(plane.compression, plane.data, { planes: 1, width, height, depth: 8, psb: true });
  const surface = surfaceFromPixels({ width, height, data: bytes }, 1, rect.left, rect.top, 255);
  return { surface, defaultValue: 255 };
}

/**
 * A filter-effects item holding only a filter mask for instance `placed`. Photoshop extends the
 * stored rectangle with white, so a mask whose default hides is written over `area` (the canvas).
 */
export function filterMaskItem(placed: string, mask: RasterMask, area?: { x: number; y: number; width: number; height: number }): FilterEffectsItem {
  const painted = contentBounds(mask.surface);
  let b = painted ?? { x: 0, y: 0, width: 1, height: 1 };
  if (mask.defaultValue !== 255 && area) {
    const x0 = Math.min(area.x, painted?.x ?? area.x);
    const y0 = Math.min(area.y, painted?.y ?? area.y);
    const x1 = Math.max(area.x + area.width, painted ? painted.x + painted.width : 0);
    const y1 = Math.max(area.y + area.height, painted ? painted.y + painted.height : 0);
    b = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
  const rect = { top: b.y, left: b.x, bottom: b.y + b.height, right: b.x + b.width };
  const values = readRegion(mask.surface, b);
  const plane = new Uint8Array(values.buffer, values.byteOffset, values.length);
  return {
    id: placed,
    version: 1,
    rect,
    depth: 8,
    maxChannels: 24,
    slots: Array.from({ length: 26 }, () => null),
    mask: { rect, plane: { compression: 1, data: encodeRle(plane, { planes: 1, width: b.width, height: b.height, depth: 8, psb: true }) } },
  };
}

// ---------------------------------------------------------------------------
// Warps
// ---------------------------------------------------------------------------

const psdWarpName = (s: WarpStyle) => `warp${s[0].toUpperCase()}${s.slice(1)}`;
const warpStyleOf = (name: string): WarpStyle | null => {
  if (!name.startsWith('warp')) return null;
  const s = name[4]?.toLowerCase() + name.slice(5);
  return WARP_STYLES.includes(s as WarpStyle) ? (s as WarpStyle) : null;
};

/** A box as a frame rectangle. */
interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A `warp` descriptor as a mesh over the contents' rectangle (contents pixels) and the frame its
 * quad maps: `null` mesh for no warp; `undefined` when it cannot be read.
 */
export function warpFromDescriptor(w: Descriptor, contents: { width: number; height: number }): { mesh: WarpMesh | null; frame: Frame } | undefined {
  const full = { x: 0, y: 0, width: contents.width, height: contents.height };
  const styleName = enumOf(w, 'warpStyle');
  if (!styleName) return undefined;
  if (styleName === 'warpNone') return { mesh: null, frame: full };
  const bd = descObject(w, 'bounds');
  if (!bd) return undefined;
  const left = descNumber(bd, 'Left') ?? 0;
  const top = descNumber(bd, 'Top ') ?? 0;
  const bounds = { x: left, y: top, width: (descNumber(bd, 'Rght') ?? 0) - left, height: (descNumber(bd, 'Btom') ?? 0) - top };
  if (!(bounds.width > 0 && bounds.height > 0)) return undefined;
  let mesh: WarpMesh | null;
  let frame: Frame = full;
  if (styleName === 'warpCustom') {
    const env = descObject(w, 'customEnvelopeWarp');
    const arr = env ? descGet(env, 'meshPoints') : undefined;
    if (!arr || arr.type !== 'ObAr') return undefined;
    const xs = descGet(arr.body, 'Hrzn');
    const ys = descGet(arr.body, 'Vrtc');
    if (xs?.type !== 'UnFl' || ys?.type !== 'UnFl' || xs.values.length !== 16 || ys.values.length !== 16) return undefined;
    mesh = { us: [0, 1], vs: [0, 1], points: xs.values.map((x, i) => ({ x, y: ys.values[i] })) };
    const px = mesh.points.map((p) => p.x);
    const py = mesh.points.map((p) => p.y);
    const f = { x: Math.min(...px), y: Math.min(...py), width: Math.max(...px) - Math.min(...px), height: Math.max(...py) - Math.min(...py) };
    if (f.width > 1e-9 && f.height > 1e-9 && [f.x, f.y, f.width, f.height].every(Number.isFinite)) frame = f;
  } else {
    const style = warpStyleOf(styleName);
    if (!style) return undefined;
    mesh = warpPresetMesh(
      {
        style,
        bend: descNumber(w, 'warpValue') ?? 0,
        horizontal: descNumber(w, 'warpPerspective') ?? 0,
        vertical: descNumber(w, 'warpPerspectiveOther') ?? 0,
        orientation: enumOf(w, 'warpRotate') === 'Vrtc' ? 'vertical' : 'horizontal',
      },
      bounds
    );
    if (!mesh) return { mesh: null, frame: full };
  }
  // Our meshes are parameterised over the contents' rectangle: refit when the warp's bounds differ (exact, an affine reparameterisation).
  const same = Math.abs(bounds.x) < 1e-6 && Math.abs(bounds.y) < 1e-6 && Math.abs(bounds.width - contents.width) < 1e-6 && Math.abs(bounds.height - contents.height) < 1e-6;
  if (!same) {
    const m = mesh;
    mesh = fitWarpMesh((s, t) => evalWarpMesh(m, (s * contents.width - bounds.x) / bounds.width, (t * contents.height - bounds.y) / bounds.height), [0, 1], [0, 1]);
  }
  return { mesh, frame };
}

/** Our warp as a `warp` descriptor over the contents' rectangle, and the frame its quad maps. A mesh of several patches cannot be written. */
export function warpDescriptor(mesh: WarpMesh | null | undefined, contents: { width: number; height: number }): { warp: Descriptor; frame: Frame; dropped: boolean } {
  const full = { x: 0, y: 0, width: contents.width, height: contents.height };
  const single = mesh && mesh.us.length === 2 && mesh.vs.length === 2 && mesh.points.length === 16;
  const bounds = descriptor('classFloatRect', [
    ['Top ', dbl(0)],
    ['Left', dbl(0)],
    ['Btom', dbl(contents.height)],
    ['Rght', dbl(contents.width)],
  ]);
  const items: Array<[string, DescValue]> = [
    ['warpStyle', enumV('warpStyle', single ? 'warpCustom' : 'warpNone')],
    ['warpValue', dbl(0)],
    ['warpPerspective', dbl(0)],
    ['warpPerspectiveOther', dbl(0)],
    ['warpRotate', enumV('Ornt', 'Hrzn')],
    ['bounds', obj(bounds)],
    ['uOrder', long(4)],
    ['vOrder', long(4)],
  ];
  let frame: Frame = full;
  if (single) {
    const body = descriptor('rationalPoint', [
      ['Hrzn', { type: 'UnFl', unit: '#Pxl', values: mesh!.points.map((p) => p.x) }],
      ['Vrtc', { type: 'UnFl', unit: '#Pxl', values: mesh!.points.map((p) => p.y) }],
    ]);
    items.push(['customEnvelopeWarp', obj(descriptor('customEnvelopeWarp', [['meshPoints', { type: 'ObAr', prefix: 16, body }]]))]);
    const px = mesh!.points.map((p) => p.x);
    const py = mesh!.points.map((p) => p.y);
    frame = { x: Math.min(...px), y: Math.min(...py), width: Math.max(...px) - Math.min(...px), height: Math.max(...py) - Math.min(...py) };
  }
  return { warp: descriptor('warp', items), frame, dropped: Boolean(mesh && !single) };
}

// ---------------------------------------------------------------------------
// Quads
// ---------------------------------------------------------------------------

const isParallelogram = (q: readonly Vec2[]) => {
  const tol = 1e-6 * (1 + Math.max(...q.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)])));
  return Math.abs(q[0].x + q[2].x - q[1].x - q[3].x) <= tol && Math.abs(q[0].y + q[2].y - q[1].y - q[3].y) <= tol;
};

const toQuad = (p: number[]): Quad => [
  { x: p[0], y: p[1] },
  { x: p[2], y: p[3] },
  { x: p[4], y: p[5] },
  { x: p[6], y: p[7] },
];

/** Where the contents' rectangle lands, from the stored quad over `frame`; `null` when degenerate. */
export function cornersFromQuad(quad: number[], frame: Frame, contents: { width: number; height: number }): Quad | null {
  if (quad.length !== 8 || !quad.every(Number.isFinite)) return null;
  const q = toQuad(quad);
  const h = rectToQuad(frame, q);
  if (!h) return null;
  const out = boxQuad({ x: 0, y: 0, width: contents.width, height: contents.height }).map((p) => applyHomography(h, p));
  return out.every(Boolean) ? (out as unknown as Quad) : null;
}

/** The quad `frame` maps onto under the placement (inverse of `cornersFromQuad`). */
export function quadFromCorners(corners: Quad, frame: Frame, contents: { width: number; height: number }): number[] {
  const h = rectToQuad({ x: 0, y: 0, width: contents.width, height: contents.height }, corners);
  const pts = boxQuad(frame).map((p) => (h ? applyHomography(h, p) : p) ?? p);
  return pts.flatMap((p) => [p.x, p.y]);
}

// ---------------------------------------------------------------------------
// Placed-layer blocks
// ---------------------------------------------------------------------------

export const PLACED_KEYS = ['SoLd', 'SoLE', 'PlLd'];

/** What a placed-layer block says. */
export interface PsdPlaced {
  key: string;
  /** The `soLD` descriptor (`SoLd` / `SoLE`). */
  descriptor?: Descriptor;
  /** Uuid of the linked file (`Idnt`, the `lnk2` item). */
  idnt: string;
  /** Id of this instance (`placed`, keys `FEid`). */
  placed: string;
  /** The stored quad (8 numbers, top-left first). */
  quad: number[];
  /** `Sz  `: the source size, when stored. */
  size?: { width: number; height: number };
  warp?: Descriptor;
  filterFX?: Descriptor;
}

/** Parses `SoLd` / `SoLE` / `PlLd` block data (`null` when it is not one). */
export function parsePlaced(key: string, data: Uint8Array): PsdPlaced | null {
  try {
    if (key === 'SoLd' || key === 'SoLE') {
      const r = new PsdReader(data);
      if (r.ascii(4) !== 'soLD') return null;
      r.u32();
      const d = readVersionedDescriptor(r);
      const quad = numbers(d, 'nonAffineTransform') ?? numbers(d, 'Trnf') ?? [];
      const affine = numbers(d, 'Trnf');
      const sz = descObject(d, 'Sz  ');
      const size = sz ? { width: descNumber(sz, 'Wdth') ?? 0, height: descNumber(sz, 'Hght') ?? 0 } : undefined;
      // An affine Trnf with a perspective nonAffineTransform: the latter is the shape.
      const use = affine && affine.length === 8 && isParallelogram(toQuad(affine)) && quad.length === 8 && !isParallelogram(toQuad(quad)) ? quad : (affine ?? quad);
      return {
        key,
        descriptor: d,
        idnt: text(d, 'Idnt') ?? '',
        placed: text(d, 'placed') ?? '',
        quad: use,
        size: size && size.width > 0 && size.height > 0 ? size : undefined,
        warp: descObject(d, 'warp'),
        filterFX: descObject(d, 'filterFX'),
      };
    }
    if (key === 'PlLd') {
      const r = new PsdReader(data);
      if (r.ascii(4) !== 'plcL') return null;
      r.u32();
      const n = r.u8();
      const idnt = new TextDecoder().decode(r.bytes(n));
      r.skip(16);
      const quad: number[] = [];
      for (let i = 0; i < 8; i++) quad.push(r.f64());
      let warp: Descriptor | undefined;
      if (r.remaining > 8 && r.peek(r.remaining).some((b) => b !== 0)) {
        r.u32();
        try {
          warp = readVersionedDescriptor(r);
        } catch {
          warp = undefined;
        }
      }
      return { key, idnt, placed: idnt, quad, warp };
    }
  } catch {
    return null;
  }
  return null;
}

/** Placement of contents of `size` from a placed block; `notes` gets what could not be read. */
export function placementFromPlaced(p: PsdPlaced, size: { width: number; height: number }, notes: string[]): SmartPlacement | null {
  let mesh: WarpMesh | null = null;
  let frame: Frame = { x: 0, y: 0, width: size.width, height: size.height };
  if (p.warp) {
    const w = warpFromDescriptor(p.warp, size);
    if (!w) notes.push('its warp could not be read and was left out');
    else {
      mesh = w.mesh;
      if (p.quad.length === 8 && isParallelogram(toQuad(p.quad))) frame = w.frame;
    }
  }
  const corners = cornersFromQuad(p.quad, frame, size);
  if (!corners) return null;
  const out: SmartPlacement = { corners };
  if (mesh) out.warp = mesh;
  return out;
}

// ---------------------------------------------------------------------------
// Smart filters (filterFX)
// ---------------------------------------------------------------------------

/** Photoshop's Box Blur, the one filter that maps onto ours. */
const BOX_BLUR = { classId: 'boxblur', id: 840, name: 'Box Blur...' };

function blendOptionsOf(item: Descriptor): { blend: BlendMode; opacity: number } {
  const o = descObject(item, 'blendOptions');
  const opacity = o ? Math.min(1, Math.max(0, (descNumber(o, 'Opct') ?? 100) / 100)) : 1;
  const id = o ? enumOf(o, 'Md  ') : undefined;
  return { blend: (id && blendFromPsdId(id)) || 'normal', opacity };
}

function blendOptions(f: { blend: BlendMode; opacity: number }): DescValue {
  return obj(
    descriptor('blendOptions', [
      ['Opct', unit('#Prc', Math.min(1, Math.max(0, f.opacity)) * 100)],
      ['Md  ', enumV('BlnM', psdBlendId(f.blend))],
    ])
  );
}

/** A `filterFX` object as a smart filter stack; `notes` gets the filters that are kept but not drawn. */
export function smartFiltersFromPsd(fx: Descriptor, newId: () => string, notes: string[]): SmartFilterStack {
  const filters: SmartFilter[] = [];
  const list = descGet(fx, 'filterFXList');
  for (const v of list?.type === 'VlLs' ? list.items : []) {
    if (v.type !== 'Objc' && v.type !== 'GlbO') continue;
    const item = v.value;
    const { blend, opacity } = blendOptionsOf(item);
    const enabled = descBool(item, 'enab') !== false;
    const fltr = descObject(item, 'Fltr');
    const radius = fltr?.classId === BOX_BLUR.classId ? descNumber(fltr, 'Rds ') : undefined;
    if (radius !== undefined && radius >= 0 && radius <= 50) {
      filters.push({ id: newId(), kind: 'blur', enabled, radius, blend, opacity });
      continue;
    }
    const name = (text(item, 'Nm  ') ?? 'Filter').replace(/&/g, '');
    // Kept with neutral blending: the model's own fields replace them on export.
    const neutral = cloneDescriptor(item);
    setItem(neutral, 'blendOptions', blendOptions({ blend: 'normal', opacity: 1 }));
    setItem(neutral, 'enab', boolV(true));
    filters.push({ id: newId(), kind: 'psd', enabled, name, data: versionedDescriptorBytes(neutral), blend, opacity });
    notes.push(`the ${name.replace(/\.\.\.$/, '')} smart filter is kept but not drawn`);
  }
  return { enabled: descBool(fx, 'enab') !== false, filters };
}

/** Our smart filter stack as a `filterFX` object; filters without a Photoshop equivalent are named in `dropped`. */
export function filterFXDescriptor(stack: SmartFilterStack, dropped: string[]): Descriptor {
  const list: DescValue[] = [];
  for (const f of stack.filters) {
    if (f.kind === 'psd') {
      const d = parseVersionedDescriptor(f.data);
      setItem(d, 'blendOptions', blendOptions(f));
      setItem(d, 'enab', boolV(f.enabled));
      list.push(obj(d));
    } else if (f.kind === 'blur') {
      const rgb = (v: number) => obj(descriptor('RGBC', [['Rd  ', dbl(v)], ['Grn ', dbl(v)], ['Bl  ', dbl(v)]]));
      list.push(
        obj(
          descriptor('filterFX', [
            ['Nm  ', textV(BOX_BLUR.name)],
            ['blendOptions', blendOptions(f)],
            ['enab', boolV(f.enabled)],
            ['hasoptions', boolV(true)],
            ['FrgC', rgb(0)],
            ['BckC', rgb(255)],
            ['Fltr', obj(descriptor(BOX_BLUR.classId, [['Rds ', unit('#Pxl', f.radius)]]))],
            ['filterID', long(BOX_BLUR.id)],
          ])
        )
      );
    } else dropped.push(f.kind);
  }
  return descriptor('filterFXStyle', [
    ['enab', boolV(stack.enabled)],
    ['validAtPosition', boolV(true)],
    ['filterMaskEnable', boolV(stack.mask ? stack.mask.enabled !== false : true)],
    ['filterMaskLinked', boolV(stack.mask ? stack.mask.linked !== false : false)],
    ['filterMaskExtendWithWhite', boolV(true)],
    ['filterFXList', { type: 'VlLs', items: list }],
  ]);
}

/** What a stack looks like to Photoshop (ids left out), to tell whether a stored `filterFX` still matches. */
export function filterStackKey(stack: SmartFilterStack | undefined): string {
  if (!stack) return '';
  return JSON.stringify([
    stack.enabled,
    stack.filters.map((f) => (f.kind === 'psd' ? ['psd', f.enabled, f.blend, f.opacity, Array.from(f.data)] : { ...f, id: undefined })),
    stack.mask ? [stack.mask.enabled !== false, stack.mask.linked !== false] : null,
  ]);
}

// ---------------------------------------------------------------------------
// Writing placed blocks
// ---------------------------------------------------------------------------

export interface PlacedSpec {
  idnt: string;
  placed: string;
  placement: SmartPlacement;
  size: { width: number; height: number };
  filterFX?: Descriptor;
  /** The descriptor read from the file, to keep keys we do not model. */
  template?: Descriptor;
}

/** `SoLd` block data; `notes` gets what could not be written. */
export function soldBytes(s: PlacedSpec, notes: string[]): Uint8Array {
  const { warp, frame, dropped } = warpDescriptor(s.placement.warp, s.size);
  if (dropped) notes.push('a warp of several patches was written without its warp (the layer’s pixels still show it)');
  const quad: DescValue = { type: 'VlLs', items: quadFromCorners(s.placement.corners, frame, s.size).map(dbl) };
  let d: Descriptor;
  if (s.template) {
    d = cloneDescriptor(s.template);
    setItem(d, 'Idnt', textV(s.idnt));
    setItem(d, 'placed', textV(s.placed));
    setItem(d, 'Trnf', quad);
    setItem(d, 'nonAffineTransform', quad);
    setItem(d, 'warp', obj(warp));
    setItem(d, 'Sz  ', obj(descriptor('Pnt ', [['Wdth', dbl(s.size.width)], ['Hght', dbl(s.size.height)]])));
    if (s.filterFX) setItem(d, 'filterFX', obj(s.filterFX));
    else d.items = d.items.filter(([k]) => k !== 'filterFX');
  } else {
    const ratio = (n: number, den: number) => obj(descriptor('null', [['numerator', long(n)], ['denominator', long(den)]]));
    const items: Array<[string, DescValue]> = [
      ['Idnt', textV(s.idnt)],
      ['placed', textV(s.placed)],
      ['PgNm', long(1)],
      ['totalPages', long(1)],
      ['Crop', long(1)],
      ['frameStep', ratio(0, 600)],
      ['duration', ratio(0, 600)],
      ['frameCount', long(1)],
      ['Annt', long(16)],
      ['Type', long(2)],
      ['Trnf', quad],
      ['nonAffineTransform', quad],
      ['warp', obj(warp)],
      ['Sz  ', obj(descriptor('Pnt ', [['Wdth', dbl(s.size.width)], ['Hght', dbl(s.size.height)]]))],
      ['Rslt', unit('#Rsl', 72)],
    ];
    if (s.filterFX) items.push(['filterFX', obj(s.filterFX)]);
    items.push(['comp', long(-1)], ['compInfo', obj(descriptor('null', [['compID', long(-1)], ['originalCompID', long(-1)]]))]);
    d = descriptor('null', items);
  }
  const w = new PsdWriter();
  w.ascii('soLD');
  w.u32(4);
  writeVersionedDescriptor(w, d);
  w.zeros((4 - (w.length % 4)) % 4);
  return w.result();
}

/** `PlLd` block data (the record older readers use), padded to 4 bytes. */
export function plldBytes(s: PlacedSpec): Uint8Array {
  const { warp, frame } = warpDescriptor(s.placement.warp, s.size);
  const w = new PsdWriter();
  w.ascii('plcL');
  w.u32(3);
  const id = new TextEncoder().encode(s.idnt).subarray(0, 255);
  w.u8(id.length);
  w.bytes(id);
  for (const v of [1, 1, 16, 2]) w.u32(v);
  for (const v of quadFromCorners(s.placement.corners, frame, s.size)) w.f64(v);
  w.u32(0);
  writeVersionedDescriptor(w, warp);
  w.zeros((4 - (w.length % 4)) % 4);
  return w.result();
}

/** An empty mask surface for a stack without a stored filter mask (Photoshop's default reveals all). */
export const revealAllMask = (): RasterMask => ({ surface: emptySurface(1, 255), defaultValue: 255 });

/** File types a browser's image decoder reads (`prepareSmartObjects`), by extension. */
export const BROWSER_IMAGE_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
};
