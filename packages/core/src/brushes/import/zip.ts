/**
 * A small, defensive ZIP reader for brush packs (`.brush`, `.brushset`): the central directory,
 * stored and deflated entries, and nothing else (no encryption, no ZIP64, no multi-disk). Brush
 * packs are untrusted files, so every offset and size is checked against the buffer and against
 * limits before anything is read or inflated.
 */

import { inflateRaw } from '../../raster/zlib';

/** One file in the archive. */
export interface ZipEntry {
  /** Its path in the archive (`/`-separated). */
  name: string;
  /** Uncompressed size, as the directory says. */
  size: number;
  /** The file's bytes (inflated on first read). */
  read(): Uint8Array;
}

/** Limits for an untrusted archive. */
export interface ZipLimits {
  /** Most entries (default 4096). */
  maxEntries?: number;
  /** Largest uncompressed entry, bytes (default 64 MB). */
  maxEntrySize?: number;
  /** Largest total uncompressed size, bytes (default 512 MB). */
  maxTotalSize?: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const u16 = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8);
const u32 = (b: Uint8Array, p: number) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

/** Whether the bytes start like a ZIP archive. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 22 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5) && (bytes[3] === 4 || bytes[3] === 6);
}

/** The entries of a ZIP archive (directories left out). Throws a `ZipError` on anything malformed or over the limits. */
export function readZip(bytes: Uint8Array, limits: ZipLimits = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? 4096;
  const maxEntry = limits.maxEntrySize ?? 64 * 1024 * 1024;
  const maxTotal = limits.maxTotalSize ?? 512 * 1024 * 1024;
  // The end of central directory record: within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 22 - 0xffff); p--) {
    if (u32(bytes, p) === 0x06054b50) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('Not a ZIP archive: no end of central directory.');
  const count = u16(bytes, eocd + 10);
  const dirSize = u32(bytes, eocd + 12);
  const dirOffset = u32(bytes, eocd + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.');
  if (count > maxEntries) throw new ZipError(`The archive has ${count} entries; at most ${maxEntries} are read.`);
  if (dirOffset + dirSize > eocd) throw new ZipError('The ZIP central directory is out of bounds.');
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const entries: ZipEntry[] = [];
  let total = 0;
  let p = dirOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || u32(bytes, p) !== 0x02014b50) throw new ZipError(`ZIP directory entry ${i} is malformed.`);
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const csize = u32(bytes, p + 20);
    const size = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const local = u32(bytes, p + 42);
    if (p + 46 + nameLen > eocd) throw new ZipError(`ZIP directory entry ${i} is malformed.`);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new ZipError(`"${name}" is encrypted; encrypted archives are not supported.`);
    if (method !== 0 && method !== 8) throw new ZipError(`"${name}" uses compression method ${method}; only stored and deflated files are read.`);
    if (size > maxEntry) throw new ZipError(`"${name}" is ${size} bytes; files over ${maxEntry} bytes are not read.`);
    total += size;
    if (total > maxTotal) throw new ZipError(`The archive unpacks to more than ${maxTotal} bytes.`);
    if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) throw new ZipError(`"${name}" has no local header.`);
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    if (start + csize > bytes.length) throw new ZipError(`"${name}" runs past the end of the archive.`);
    let cached: Uint8Array | null = null;
    entries.push({
      name,
      size,
      read() {
        if (cached) return cached;
        const raw = bytes.subarray(start, start + csize);
        const out = method === 0 ? raw : inflateRaw(raw, { maxOutput: Math.max(size, 1), sizeHint: size });
        if (out.length !== size) throw new ZipError(`"${name}" unpacked to ${out.length} bytes, not the ${size} its directory says.`);
        cached = out;
        return out;
      },
    });
  }
  return entries;
}
