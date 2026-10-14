/**
 * Minimal, dependency-free ZIP reader used by the DOCX and zipped-export
 * import adapters.
 *
 * - Reads the central directory (including ZIP64 end records and extra
 *   fields), so sizes come from the authoritative directory rather than local
 *   headers or data descriptors.
 * - Supports stored (method 0) and deflate (method 8) entries; deflate is
 *   inflated with the platform `DecompressionStream("deflate-raw")` (modern
 *   browsers, Node ≥ 18).
 * - Guards against zip bombs (entry-count and total-uncompressed-size caps,
 *   enforced on the bytes actually inflated, not only the declared sizes),
 *   path traversal in entry names and encrypted entries.
 * - Verifies CRC-32 checksums of extracted entries.
 */

export type ZipErrorCode =
  /** Not a ZIP archive, or its directory is truncated / inconsistent. */
  | "invalid_archive"
  /** Compression method other than stored/deflate, multi-disk archives, … */
  | "unsupported_feature"
  /** The entry is encrypted (general-purpose flag bit 0). */
  | "encrypted"
  /** An entry name is absolute or contains `..` segments. */
  | "unsafe_path"
  /** More entries than `maxEntries`. */
  | "too_many_entries"
  /** Extracting would exceed `maxTotalSize` uncompressed bytes. */
  | "too_large"
  /** The entry data is corrupt (bad header, size or CRC mismatch, bad deflate stream). */
  | "corrupt_entry"
  /** No entry with the requested name. */
  | "entry_not_found"
  /** `DecompressionStream` is unavailable in this environment. */
  | "unsupported_environment";

export class ZipError extends Error {
  readonly code: ZipErrorCode;
  readonly entryName?: string;

  constructor(code: ZipErrorCode, message: string, details: { entryName?: string; cause?: unknown } = {}) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "ZipError";
    this.code = code;
    this.entryName = details.entryName;
  }
}

export interface ZipEntry {
  /** Entry path with `/` separators (backslashes are normalized). */
  name: string;
  /** Whether the entry is a directory (name ends with `/`). */
  isDirectory: boolean;
  /** Whether the entry is encrypted; reading it throws `ZipError("encrypted")`. */
  encrypted: boolean;
  /** Compression method (0 = stored, 8 = deflate). */
  method: number;
  /** Declared compressed size in bytes. */
  compressedSize: number;
  /** Declared uncompressed size in bytes. */
  size: number;
  /** CRC-32 of the uncompressed data. */
  crc32: number;
  /** Offset of the entry's local file header. */
  localHeaderOffset: number;
}

export interface ZipReadOptions {
  /** Maximum number of entries in the central directory (default 10 000). */
  maxEntries?: number;
  /**
   * Maximum number of uncompressed bytes extracted from the archive, summed
   * over every `read` call (default 256 MiB). Enforced while inflating.
   */
  maxTotalSize?: number;
  /**
   * What to do with entries whose names are absolute or contain `..`
   * segments: `"error"` (default) rejects the archive, `"skip"` leaves them
   * out of `entries`.
   */
  unsafePaths?: "error" | "skip";
}

export const DEFAULT_ZIP_MAX_ENTRIES = 10_000;
export const DEFAULT_ZIP_MAX_TOTAL_SIZE = 256 * 1024 * 1024;

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;

let crcTable: Uint32Array | null = null;

/** CRC-32 (IEEE 802.3), as used by ZIP. */
export function zipCrc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  // Duck-typed so ArrayBuffers from other realms (iframes, jsdom) work too.
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data as ArrayBuffer);
}

/** Whether `name` is absolute, has a drive letter, or contains `..` / NUL. */
export function isUnsafeZipPath(name: string): boolean {
  if (!name || name.includes("\0")) return true;
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return true;
  return normalized.split("/").some((segment) => segment === "..");
}

const utf8 = new TextDecoder("utf-8");

/** CP437 high half, used for names without the UTF-8 flag. */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

function decodeName(bytes: Uint8Array, isUtf8: boolean): string {
  if (isUtf8 || bytes.every((b) => b < 0x80)) return utf8.decode(bytes);
  let out = "";
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return out;
}

/**
 * A parsed ZIP archive. Entry data is extracted lazily with {@link read}.
 * Create it with {@link readZip}.
 */
export class ZipArchive {
  /** Entries in central-directory order. */
  readonly entries: readonly ZipEntry[];
  private readonly byName = new Map<string, ZipEntry>();
  private extracted = 0;

  constructor(
    private readonly bytes: Uint8Array,
    entries: ZipEntry[],
    private readonly maxTotalSize: number,
  ) {
    this.entries = entries;
    entries.forEach((entry) => {
      if (!this.byName.has(entry.name)) this.byName.set(entry.name, entry);
    });
  }

  /** Looks up an entry by exact name (a leading `/` is ignored). */
  get(name: string): ZipEntry | undefined {
    return this.byName.get(name.replace(/^\/+/, ""));
  }

  has(name: string): boolean {
    return !!this.get(name);
  }

  /** Uncompressed bytes extracted so far (counted against `maxTotalSize`). */
  get extractedSize(): number {
    return this.extracted;
  }

  /** Extracts an entry's data, verifying its size and CRC-32. */
  async read(entryOrName: ZipEntry | string): Promise<Uint8Array> {
    const entry = typeof entryOrName === "string" ? this.get(entryOrName) : entryOrName;
    if (!entry) {
      throw new ZipError("entry_not_found", `ZIP entry "${String(entryOrName)}" not found.`, {
        entryName: String(entryOrName),
      });
    }
    const name = entry.name;
    if (entry.encrypted) {
      throw new ZipError("encrypted", `ZIP entry "${name}" is encrypted; encrypted archives are not supported.`, {
        entryName: name,
      });
    }
    if (entry.isDirectory) return new Uint8Array(0);
    const remaining = this.maxTotalSize - this.extracted;
    if (entry.size > remaining) {
      throw new ZipError(
        "too_large",
        `Extracting "${name}" (${entry.size} bytes) would exceed the ${this.maxTotalSize}-byte limit.`,
        { entryName: name },
      );
    }

    const { bytes } = this;
    const offset = entry.localHeaderOffset;
    if (offset + 30 > bytes.length || readU32(bytes, offset) !== SIG_LOCAL) {
      throw new ZipError("corrupt_entry", `ZIP entry "${name}" has no valid local header.`, { entryName: name });
    }
    const dataStart = offset + 30 + readU16(bytes, offset + 26) + readU16(bytes, offset + 28);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > bytes.length) {
      throw new ZipError("corrupt_entry", `ZIP entry "${name}" is truncated.`, { entryName: name });
    }
    const raw = bytes.subarray(dataStart, dataEnd);

    let data: Uint8Array;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.size) {
        throw new ZipError("corrupt_entry", `Stored ZIP entry "${name}" has inconsistent sizes.`, { entryName: name });
      }
      data = raw.slice();
    } else if (entry.method === 8) {
      // Cap at the declared size: more output means a lying header (or a bomb).
      data = await inflateRaw(raw, entry.size, name);
    } else {
      throw new ZipError(
        "unsupported_feature",
        `ZIP entry "${name}" uses unsupported compression method ${entry.method}; only stored and deflate are supported.`,
        { entryName: name },
      );
    }
    if (data.length !== entry.size) {
      throw new ZipError("corrupt_entry", `ZIP entry "${name}" size does not match the directory.`, { entryName: name });
    }
    this.extracted += data.length;
    if (zipCrc32(data) !== entry.crc32) {
      throw new ZipError("corrupt_entry", `ZIP entry "${name}" failed its CRC-32 check.`, { entryName: name });
    }
    return data;
  }

  /** Extracts an entry and decodes it as UTF-8 (a leading BOM is removed). */
  async readText(entryOrName: ZipEntry | string): Promise<string> {
    const text = utf8.decode(await this.read(entryOrName));
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readU64(bytes: Uint8Array, offset: number): number {
  const value = readU32(bytes, offset) + readU32(bytes, offset + 4) * 0x100000000;
  if (!Number.isSafeInteger(value)) {
    throw new ZipError("unsupported_feature", "ZIP64 value exceeds the supported range.");
  }
  return value;
}

/** Inflates a raw deflate stream, failing as soon as output exceeds `limit` bytes. */
async function inflateRaw(raw: Uint8Array, limit: number, entryName: string): Promise<Uint8Array> {
  const Stream: typeof DecompressionStream | undefined = (globalThis as any).DecompressionStream;
  if (typeof Stream !== "function") {
    throw new ZipError(
      "unsupported_environment",
      "Inflating ZIP entries needs DecompressionStream (modern browsers, Node 18+).",
      { entryName },
    );
  }
  const stream = new Stream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  // Feed the input in slices so output is pulled (and checked) incrementally.
  const CHUNK = 64 * 1024;
  const feeding = (async () => {
    for (let i = 0; i < raw.length; i += CHUNK) await writer.write(raw.subarray(i, i + CHUNK) as unknown as BufferSource);
    await writer.close();
  })();
  feeding.catch(() => {});

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        throw new ZipError(
          "corrupt_entry",
          `ZIP entry "${entryName}" inflates beyond its declared size of ${limit} bytes.`,
          { entryName },
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    writer.abort().catch(() => {});
    if (error instanceof ZipError) throw error;
    throw new ZipError("corrupt_entry", `ZIP entry "${entryName}" has an invalid deflate stream.`, {
      entryName,
      cause: error,
    });
  }
  await feeding.catch(() => {});
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const min = Math.max(0, bytes.length - EOCD_SIZE - MAX_COMMENT);
  for (let i = bytes.length - EOCD_SIZE; i >= min; i--) {
    if (readU32(bytes, i) === SIG_EOCD && i + EOCD_SIZE + readU16(bytes, i + 20) <= bytes.length) return i;
  }
  return -1;
}

/**
 * Parses a ZIP archive's central directory. Entry data is not extracted until
 * {@link ZipArchive.read} is called. Throws {@link ZipError}.
 */
export async function readZip(data: ArrayBuffer | ArrayBufferView, options: ZipReadOptions = {}): Promise<ZipArchive> {
  const bytes = toBytes(data);
  const maxEntries = options.maxEntries ?? DEFAULT_ZIP_MAX_ENTRIES;
  const maxTotalSize = options.maxTotalSize ?? DEFAULT_ZIP_MAX_TOTAL_SIZE;

  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) throw new ZipError("invalid_archive", "Not a ZIP archive (no end of central directory record).");

  let diskNumber = readU16(bytes, eocd + 4);
  let cdDisk = readU16(bytes, eocd + 6);
  let count = readU16(bytes, eocd + 10);
  let cdSize = readU32(bytes, eocd + 12);
  let cdOffset = readU32(bytes, eocd + 16);

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || readU32(bytes, locator) !== SIG_ZIP64_LOCATOR) {
      throw new ZipError("invalid_archive", "ZIP64 archive is missing its end of central directory locator.");
    }
    const record = readU64(bytes, locator + 8);
    if (record + 56 > bytes.length || readU32(bytes, record) !== SIG_ZIP64_EOCD) {
      throw new ZipError("invalid_archive", "ZIP64 end of central directory record not found.");
    }
    diskNumber = readU32(bytes, record + 16);
    cdDisk = readU32(bytes, record + 20);
    count = readU64(bytes, record + 32);
    cdSize = readU64(bytes, record + 40);
    cdOffset = readU64(bytes, record + 48);
  }
  if (diskNumber !== 0 || cdDisk !== 0) {
    throw new ZipError("unsupported_feature", "Multi-disk (spanned) ZIP archives are not supported.");
  }
  if (count > maxEntries) {
    throw new ZipError("too_many_entries", `ZIP archive has ${count} entries; the limit is ${maxEntries}.`);
  }
  if (cdOffset + cdSize > bytes.length) {
    throw new ZipError("invalid_archive", "ZIP central directory lies outside the file.");
  }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || readU32(bytes, p) !== SIG_CENTRAL) {
      throw new ZipError("invalid_archive", "ZIP central directory is corrupt.");
    }
    const flags = readU16(bytes, p + 8);
    const method = readU16(bytes, p + 10);
    const crc32 = readU32(bytes, p + 16);
    let compressedSize = readU32(bytes, p + 20);
    let size = readU32(bytes, p + 24);
    const nameLength = readU16(bytes, p + 28);
    const extraLength = readU16(bytes, p + 30);
    const commentLength = readU16(bytes, p + 32);
    let localHeaderOffset = readU32(bytes, p + 42);
    const nameStart = p + 46;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > bytes.length) throw new ZipError("invalid_archive", "ZIP central directory is truncated.");

    // ZIP64 extended information: only the fields that overflowed are present, in order.
    for (let e = extraStart; e + 4 <= extraStart + extraLength; ) {
      const id = readU16(bytes, e);
      const len = readU16(bytes, e + 2);
      if (id === 0x0001) {
        let f = e + 4;
        const end = f + len;
        if (size === 0xffffffff && f + 8 <= end) {
          size = readU64(bytes, f);
          f += 8;
        }
        if (compressedSize === 0xffffffff && f + 8 <= end) {
          compressedSize = readU64(bytes, f);
          f += 8;
        }
        if (localHeaderOffset === 0xffffffff && f + 8 <= end) localHeaderOffset = readU64(bytes, f);
      }
      e += 4 + len;
    }

    const rawName = decodeName(bytes.subarray(nameStart, extraStart), (flags & 0x0800) !== 0);
    const name = rawName.replace(/\\/g, "/");
    p = next;
    if (isUnsafeZipPath(rawName)) {
      if (options.unsafePaths === "skip") continue;
      throw new ZipError("unsafe_path", `ZIP entry name "${rawName}" is absolute or escapes the archive root.`, {
        entryName: rawName,
      });
    }
    entries.push({
      name,
      isDirectory: name.endsWith("/"),
      encrypted: (flags & 0x0001) !== 0,
      method,
      compressedSize,
      size,
      crc32,
      localHeaderOffset,
    });
  }
  return new ZipArchive(bytes, entries, maxTotalSize);
}
