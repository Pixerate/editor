/**
 * A defensive reader for binary property lists (`bplist00`), enough for Procreate's
 * `Brush.archive` (an `NSKeyedArchiver` archive): integers, reals, booleans, strings, data, UIDs,
 * arrays and dictionaries. Every offset is checked, the object graph is read without following
 * cycles, and its depth and size are limited, because brush packs are untrusted files.
 */

/** A value read from a property list. UIDs (`NSKeyedArchiver` references) are `{ uid }`. */
export type PlistValue = null | boolean | number | string | Uint8Array | { uid: number } | PlistValue[] | { [key: string]: PlistValue };

export class PlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlistError';
  }
}

const MAX_OBJECTS = 200_000;
const MAX_DEPTH = 64;

/** Whether the bytes are a binary property list. */
export function isBinaryPlist(bytes: Uint8Array): boolean {
  return bytes.length >= 40 && String.fromCharCode(...bytes.subarray(0, 8)) === 'bplist00';
}

/** The root object of a binary property list. Throws a `PlistError` when it is malformed. */
export function readBinaryPlist(bytes: Uint8Array): PlistValue {
  if (!isBinaryPlist(bytes)) throw new PlistError('Not a binary property list.');
  const t = bytes.length - 32;
  const offsetSize = bytes[t + 6];
  const refSize = bytes[t + 7];
  const uint = (p: number, n: number) => {
    if (p < 0 || p + n > bytes.length) throw new PlistError('A property list offset is out of bounds.');
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + bytes[p + i];
    return v;
  };
  const count = uint(t + 8, 8);
  const top = uint(t + 16, 8);
  const tableAt = uint(t + 24, 8);
  if (![1, 2, 4, 8].includes(offsetSize) || ![1, 2, 4, 8].includes(refSize)) throw new PlistError('The property list trailer is malformed.');
  if (count > MAX_OBJECTS || top >= count || tableAt + count * offsetSize > t) throw new PlistError('The property list is malformed or too large.');
  const offsetOf = (i: number) => {
    if (i >= count) throw new PlistError('A property list reference is out of range.');
    const o = uint(tableAt + i * offsetSize, offsetSize);
    if (o >= tableAt) throw new PlistError('A property list object is out of bounds.');
    return o;
  };
  const reading = new Set<number>();

  const read = (index: number, depth: number): PlistValue => {
    if (depth > MAX_DEPTH) throw new PlistError('The property list is nested too deeply.');
    if (reading.has(index)) throw new PlistError('The property list refers to itself.');
    let p = offsetOf(index);
    const marker = bytes[p];
    const kind = marker >> 4;
    let info = marker & 0xf;
    p++;
    // Lengths of 15 and more follow as an int object.
    const length = (): number => {
      if (info !== 0xf) return info;
      const m = bytes[p];
      if (m >> 4 !== 1) throw new PlistError('A property list length is malformed.');
      const n = 1 << (m & 0xf);
      const v = uint(p + 1, n);
      p += 1 + n;
      return v;
    };
    switch (kind) {
      case 0x0:
        return info === 8 ? false : info === 9 ? true : null;
      case 0x1: {
        const n = 1 << info;
        if (n === 8) {
          const v = new DataView(bytes.buffer, bytes.byteOffset + p, 8).getBigInt64(0);
          return Number(v);
        }
        return uint(p, n);
      }
      case 0x2: {
        const n = 1 << info;
        if (p + n > bytes.length) throw new PlistError('A property list number is out of bounds.');
        const view = new DataView(bytes.buffer, bytes.byteOffset + p, n);
        return n === 4 ? view.getFloat32(0) : n === 8 ? view.getFloat64(0) : 0;
      }
      case 0x3:
        return p + 8 <= bytes.length ? new DataView(bytes.buffer, bytes.byteOffset + p, 8).getFloat64(0) : 0;
      case 0x4: {
        const n = length();
        if (p + n > bytes.length) throw new PlistError('Property list data is out of bounds.');
        return bytes.slice(p, p + n);
      }
      case 0x5: {
        const n = length();
        if (p + n > bytes.length) throw new PlistError('A property list string is out of bounds.');
        return String.fromCharCode(...bytes.subarray(p, p + n));
      }
      case 0x6: {
        const n = length();
        if (p + n * 2 > bytes.length) throw new PlistError('A property list string is out of bounds.');
        let s = '';
        for (let i = 0; i < n; i++) s += String.fromCharCode((bytes[p + i * 2] << 8) | bytes[p + i * 2 + 1]);
        return s;
      }
      case 0x8:
        return { uid: uint(p, info + 1) };
      case 0xa:
      case 0xc: {
        const n = length();
        reading.add(index);
        const out: PlistValue[] = [];
        for (let i = 0; i < n; i++) out.push(read(uint(p + i * refSize, refSize), depth + 1));
        reading.delete(index);
        return out;
      }
      case 0xd: {
        const n = length();
        reading.add(index);
        const out: { [key: string]: PlistValue } = {};
        for (let i = 0; i < n; i++) {
          const key = read(uint(p + i * refSize, refSize), depth + 1);
          if (typeof key !== 'string') throw new PlistError('A property list key is not a string.');
          out[key] = read(uint(p + (n + i) * refSize, refSize), depth + 1);
        }
        reading.delete(index);
        return out;
      }
      default:
        throw new PlistError(`Property list object type ${kind.toString(16)} is not supported.`);
    }
  };
  return read(top, 0);
}

/**
 * The root object of an `NSKeyedArchiver` archive with its UIDs resolved one level: each key of
 * the root maps to the archived value (strings and numbers as they are; `$null` as null).
 */
export function keyedArchiveRoot(plist: PlistValue): Record<string, PlistValue> | null {
  const top = plist as { $objects?: PlistValue[]; $top?: { root?: { uid: number } } } | null;
  const objects = Array.isArray(top?.$objects) ? top!.$objects! : null;
  const root = top?.$top?.root;
  if (!objects || !root || typeof root !== 'object' || !('uid' in root)) return null;
  const at = (v: PlistValue): PlistValue => (v && typeof v === 'object' && 'uid' in v && typeof v.uid === 'number' ? (objects[v.uid] ?? null) : v);
  const obj = at(root);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj instanceof Uint8Array) return null;
  const out: Record<string, PlistValue> = {};
  for (const [k, v] of Object.entries(obj as Record<string, PlistValue>)) {
    const value = at(v);
    out[k] = value === '$null' ? null : value;
  }
  return out;
}
