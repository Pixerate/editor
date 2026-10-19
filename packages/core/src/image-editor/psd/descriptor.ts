// Portions ported from photocraft/crates/psd/src/descriptor.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Photoshop ActionDescriptors (the structured values inside `vibA`, `blwh` and other blocks):
 * read and write. Keys and class ids are 4-character codes, or longer strings.
 */

import { PsdError, PsdReader, PsdWriter } from './binary';

const MAX_DEPTH = 64;
/** Ids that are 4 characters long but stored as strings, never codes. */
const STRING_IDS = new Set(['warp', 'list', 'time']);

export interface DescClass {
  name: string;
  classId: string;
}

export type ReferenceItem =
  | { type: 'prop'; class: DescClass; key: string }
  | { type: 'Clss'; class: DescClass }
  | { type: 'Enmr'; class: DescClass; typeId: string; value: string }
  | { type: 'rele'; class: DescClass; offset: number }
  | { type: 'Idnt'; class: DescClass; id: number }
  | { type: 'indx'; class: DescClass; index: number }
  | { type: 'name'; class: DescClass; name: string };

export type DescValue =
  | { type: 'obj '; items: ReferenceItem[] }
  | { type: 'Objc' | 'GlbO'; value: Descriptor }
  | { type: 'VlLs'; items: DescValue[] }
  | { type: 'doub'; value: number }
  | { type: 'UntF'; unit: string; value: number }
  | { type: 'UnFl'; unit: string; values: number[] }
  | { type: 'TEXT'; value: string }
  | { type: 'enum'; typeId: string; value: string }
  | { type: 'long'; value: number }
  | { type: 'comp'; value: number }
  | { type: 'bool'; value: boolean }
  | { type: 'type' | 'GlbC'; class: DescClass }
  | { type: 'alis' | 'Pth ' | 'tdta'; data: Uint8Array }
  | { type: 'ObAr'; prefix: number; body: Descriptor };

export interface Descriptor {
  name: string;
  classId: string;
  items: Array<[string, DescValue]>;
}

export function descriptor(classId: string, items: Array<[string, DescValue]> = []): Descriptor {
  return { name: '', classId, items };
}

export function descGet(d: Descriptor, key: string): DescValue | undefined {
  return d.items.find(([k]) => k === key)?.[1];
}

/** A number value (long, double or unit float), or `undefined`. */
export function descNumber(d: Descriptor, key: string): number | undefined {
  const v = descGet(d, key);
  if (!v) return undefined;
  if (v.type === 'long' || v.type === 'doub' || v.type === 'UntF' || v.type === 'comp') return v.value;
  return undefined;
}

export function descBool(d: Descriptor, key: string): boolean | undefined {
  const v = descGet(d, key);
  return v?.type === 'bool' ? v.value : undefined;
}

export function descObject(d: Descriptor, key: string): Descriptor | undefined {
  const v = descGet(d, key);
  return v && (v.type === 'Objc' || v.type === 'GlbO') ? v.value : undefined;
}

function readId(r: PsdReader): string {
  const n = r.u32();
  return n === 0 ? r.ascii(4) : r.ascii(n);
}

function writeId(w: PsdWriter, id: string): void {
  if (id.length === 4 && !STRING_IDS.has(id)) {
    w.u32(0);
    w.ascii(id);
  } else {
    w.u32(id.length);
    w.ascii(id);
  }
}

function readClass(r: PsdReader): DescClass {
  return { name: r.unicode(), classId: readId(r) };
}

function writeClass(w: PsdWriter, c: DescClass): void {
  w.unicode(c.name);
  writeId(w, c.classId);
}

function readReferenceItem(r: PsdReader): ReferenceItem {
  const type = r.ascii(4);
  switch (type) {
    case 'prop':
      return { type, class: readClass(r), key: readId(r) };
    case 'Clss':
      return { type, class: readClass(r) };
    case 'Enmr':
      return { type, class: readClass(r), typeId: readId(r), value: readId(r) };
    case 'rele':
      return { type, class: readClass(r), offset: r.i32() };
    case 'Idnt':
      return { type, class: readClass(r), id: r.u32() };
    case 'indx':
      return { type, class: readClass(r), index: r.u32() };
    case 'name':
      return { type, class: readClass(r), name: r.unicode() };
    default:
      throw new PsdError(`Unsupported descriptor reference item "${type}".`);
  }
}

function writeReferenceItem(w: PsdWriter, it: ReferenceItem): void {
  w.ascii(it.type);
  writeClass(w, it.class);
  switch (it.type) {
    case 'prop':
      writeId(w, it.key);
      break;
    case 'Enmr':
      writeId(w, it.typeId);
      writeId(w, it.value);
      break;
    case 'rele':
      w.i32(it.offset);
      break;
    case 'Idnt':
      w.u32(it.id);
      break;
    case 'indx':
      w.u32(it.index);
      break;
    case 'name':
      w.unicode(it.name);
      break;
  }
}

function readValue(r: PsdReader, depth: number): DescValue {
  if (depth > MAX_DEPTH) throw new PsdError('Descriptor nesting is too deep.');
  const type = r.ascii(4);
  switch (type) {
    case 'obj ': {
      const n = r.u32();
      r.checkCount(n, 8, 'Descriptor reference');
      const items: ReferenceItem[] = [];
      for (let i = 0; i < n; i++) items.push(readReferenceItem(r));
      return { type, items };
    }
    case 'Objc':
    case 'GlbO':
      return { type, value: readDescriptorBody(r, depth + 1) };
    case 'VlLs': {
      const n = r.u32();
      r.checkCount(n, 4, 'Descriptor list');
      const items: DescValue[] = [];
      for (let i = 0; i < n; i++) items.push(readValue(r, depth + 1));
      return { type, items };
    }
    case 'doub':
      return { type, value: r.f64() };
    case 'UntF':
      return { type, unit: r.ascii(4), value: r.f64() };
    case 'UnFl': {
      const unit = r.ascii(4);
      const n = r.u32();
      r.checkCount(n, 8, 'Unit float list');
      const values: number[] = [];
      for (let i = 0; i < n; i++) values.push(r.f64());
      return { type, unit, values };
    }
    case 'TEXT':
      return { type, value: r.unicode() };
    case 'enum':
      return { type, typeId: readId(r), value: readId(r) };
    case 'long':
      return { type, value: r.i32() };
    case 'comp':
      return { type, value: r.i64() };
    case 'bool':
      return { type, value: r.u8() !== 0 };
    case 'type':
    case 'GlbC':
      return { type, class: readClass(r) };
    case 'alis':
    case 'Pth ':
    case 'tdta':
      return { type, data: r.bytes(r.u32()) };
    case 'ObAr':
      return { type, prefix: r.u32(), body: readDescriptorBody(r, depth + 1) };
    default:
      throw new PsdError(`Unsupported descriptor value type "${type}".`);
  }
}

function writeValue(w: PsdWriter, v: DescValue): void {
  w.ascii(v.type);
  switch (v.type) {
    case 'obj ':
      w.u32(v.items.length);
      for (const it of v.items) writeReferenceItem(w, it);
      break;
    case 'Objc':
    case 'GlbO':
      writeDescriptorBody(w, v.value);
      break;
    case 'VlLs':
      w.u32(v.items.length);
      for (const it of v.items) writeValue(w, it);
      break;
    case 'doub':
      w.f64(v.value);
      break;
    case 'UntF':
      w.ascii(v.unit);
      w.f64(v.value);
      break;
    case 'UnFl':
      w.ascii(v.unit);
      w.u32(v.values.length);
      for (const x of v.values) w.f64(x);
      break;
    case 'TEXT':
      w.unicode(v.value, true);
      break;
    case 'enum':
      writeId(w, v.typeId);
      writeId(w, v.value);
      break;
    case 'long':
      w.i32(v.value);
      break;
    case 'comp':
      w.u32(Math.floor(v.value / 2 ** 32) >>> 0);
      w.u32(v.value >>> 0);
      break;
    case 'bool':
      w.u8(v.value ? 1 : 0);
      break;
    case 'type':
    case 'GlbC':
      writeClass(w, v.class);
      break;
    case 'alis':
    case 'Pth ':
    case 'tdta':
      w.u32(v.data.length);
      w.bytes(v.data);
      break;
    case 'ObAr':
      w.u32(v.prefix);
      writeDescriptorBody(w, v.body);
      break;
  }
}

function readDescriptorBody(r: PsdReader, depth: number): Descriptor {
  if (depth > MAX_DEPTH) throw new PsdError('Descriptor nesting is too deep.');
  const name = r.unicode();
  const classId = readId(r);
  const n = r.u32();
  r.checkCount(n, 10, 'Descriptor items');
  const items: Array<[string, DescValue]> = [];
  for (let i = 0; i < n; i++) {
    const key = readId(r);
    items.push([key, readValue(r, depth + 1)]);
  }
  return { name, classId, items };
}

function writeDescriptorBody(w: PsdWriter, d: Descriptor): void {
  w.unicode(d.name, true);
  writeId(w, d.classId);
  w.u32(d.items.length);
  for (const [k, v] of d.items) {
    writeId(w, k);
    writeValue(w, v);
  }
}

/** A versioned descriptor (u32 version 16, then the descriptor) at the reader's position. */
export function readVersionedDescriptor(r: PsdReader): Descriptor {
  const version = r.u32();
  if (version !== 16) throw new PsdError(`Descriptor version ${version}, expected 16.`);
  return readDescriptorBody(r, 0);
}

export function writeVersionedDescriptor(w: PsdWriter, d: Descriptor): void {
  w.u32(16);
  writeDescriptorBody(w, d);
}

/** A versioned descriptor from the start of `bytes` (trailing bytes are ignored). */
export function parseVersionedDescriptor(bytes: Uint8Array): Descriptor {
  return readVersionedDescriptor(new PsdReader(bytes));
}

export function versionedDescriptorBytes(d: Descriptor): Uint8Array {
  const w = new PsdWriter();
  writeVersionedDescriptor(w, d);
  return w.result();
}
