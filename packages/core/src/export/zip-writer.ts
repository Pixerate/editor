import { zipCrc32 } from "../import/zip";

/**
 * Minimal, dependency-free ZIP writer (the counterpart of `readZip`), used by
 * the DOCX export. Entries are deflated with the platform
 * `CompressionStream("deflate-raw")` when it exists (modern browsers,
 * Node ≥ 18) and stored otherwise, or when deflating does not make them
 * smaller. Names are written as UTF-8 (flag bit 11). No ZIP64: archives are
 * limited to 65 535 entries and 4 GiB.
 */

export interface ZipWriteEntry {
  /** Entry path with `/` separators; must be relative and free of `..`. */
  name: string;
  /** Strings are encoded as UTF-8. */
  data: Uint8Array | string;
}

export interface ZipWriteOptions {
  /**
   * `"auto"` (default) deflates when `CompressionStream` is available,
   * `"store"` never compresses.
   */
  compression?: "auto" | "store";
  /**
   * Modification time written for every entry (default 1980-01-01, the DOS
   * epoch, so the output is deterministic).
   */
  modified?: Date;
}

const encoder = new TextEncoder();
const MAX_SIZE = 0xffffffff;

async function readAll(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }
  const out = new Uint8Array(length);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

/** Raw deflate with `CompressionStream`, or `null` when it is unavailable. */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  const Stream = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (typeof Stream !== "function") return null;
  let stream: CompressionStream;
  try {
    stream = new Stream("deflate-raw" as CompressionFormat);
  } catch {
    return null;
  }
  // Plain stream APIs only: jsdom's Blob has no `stream()` (see GOTCHAS).
  const writer = stream.writable.getWriter();
  const written = writer
    .write(data as unknown as BufferSource)
    .then(() => writer.close())
    .catch(() => {});
  const out = await readAll(stream.readable as ReadableStream<Uint8Array>);
  await written;
  return out;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

class ByteSink {
  private chunks: Uint8Array[] = [];
  length = 0;

  bytes(data: Uint8Array): void {
    this.chunks.push(data);
    this.length += data.length;
  }

  header(fields: [number, 2 | 4][]): void {
    const size = fields.reduce((n, [, width]) => n + width, 0);
    const buffer = new Uint8Array(size);
    const view = new DataView(buffer.buffer);
    let pos = 0;
    for (const [value, width] of fields) {
      if (width === 2) view.setUint16(pos, value, true);
      else view.setUint32(pos, value >>> 0, true);
      pos += width;
    }
    this.bytes(buffer);
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.length);
    let pos = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    return out;
  }
}

/** Writes a ZIP archive. Throws on unsafe or duplicate names and oversized archives. */
export async function writeZip(entries: readonly ZipWriteEntry[], options: ZipWriteOptions = {}): Promise<Uint8Array> {
  if (entries.length > 0xffff) throw new RangeError("Too many ZIP entries (no ZIP64 support).");
  const { time, date } = dosDateTime(options.modified ?? new Date(Date.UTC(1980, 0, 1)));
  const out = new ByteSink();
  const central = new ByteSink();
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = entry.name;
    if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..") || name.includes("\0")) {
      throw new Error(`Unsafe ZIP entry name: ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) throw new Error(`Duplicate ZIP entry name: ${JSON.stringify(name)}`);
    seen.add(name);
    const raw = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const deflated = options.compression === "store" || raw.length === 0 ? null : await deflateRaw(raw);
    const useDeflate = !!deflated && deflated.length < raw.length;
    const body = useDeflate ? deflated! : raw;
    const method = useDeflate ? 8 : 0;
    const nameBytes = encoder.encode(name);
    const crc = zipCrc32(raw);
    const offset = out.length;
    if (body.length > MAX_SIZE || raw.length > MAX_SIZE || offset > MAX_SIZE) {
      throw new RangeError("ZIP archive too large (no ZIP64 support).");
    }
    const flags = 0x0800;
    out.header([
      [0x04034b50, 4], [20, 2], [flags, 2], [method, 2], [time, 2], [date, 2],
      [crc, 4], [body.length, 4], [raw.length, 4], [nameBytes.length, 2], [0, 2],
    ]);
    out.bytes(nameBytes);
    out.bytes(body);
    central.header([
      [0x02014b50, 4], [20, 2], [20, 2], [flags, 2], [method, 2], [time, 2], [date, 2],
      [crc, 4], [body.length, 4], [raw.length, 4], [nameBytes.length, 2], [0, 2], [0, 2],
      [0, 2], [0, 2], [0, 4], [offset, 4],
    ]);
    central.bytes(nameBytes);
  }
  const cdOffset = out.length;
  const cd = central.toUint8Array();
  out.bytes(cd);
  out.header([
    [0x06054b50, 4], [0, 2], [0, 2], [entries.length, 2], [entries.length, 2],
    [cd.length, 4], [cdOffset, 4], [0, 2],
  ]);
  return out.toUint8Array();
}
