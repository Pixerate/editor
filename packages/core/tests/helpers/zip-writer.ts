/**
 * Test-only ZIP writer used to build fixtures in memory (so no binary
 * fixtures are committed). Supports stored and deflate entries, ZIP64
 * records and deliberately malformed headers for malicious-archive tests.
 */
import { zipCrc32 } from "../../src/import/zip";

export interface TestZipEntry {
  name: string;
  data?: string | Uint8Array;
  /** 0 = stored, 8 = deflate (default). */
  method?: number;
  /** General-purpose flags (bit 0 = encrypted, bit 11 = UTF-8 name). */
  flags?: number;
  /** Override the uncompressed size written to the central directory. */
  declaredSize?: number;
  /** Override the CRC-32 written to the central directory. */
  crc?: number;
  /** Write the name as raw bytes (e.g. CP437) instead of UTF-8. */
  rawName?: Uint8Array;
}

export interface TestZipOptions {
  /** Write ZIP64 end records and extra fields. */
  zip64?: boolean;
  comment?: string;
}

const encoder = new TextEncoder();

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // Plain stream APIs only: jsdom's Blob has no `stream()`.
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  void writer.write(data as unknown as BufferSource).then(() => writer.close());
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

class Bytes {
  private parts: number[] = [];
  get length() {
    return this.parts.length;
  }
  u16(v: number) {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  u32(v: number) {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  u64(v: number) {
    this.u32(v % 0x100000000);
    return this.u32(Math.floor(v / 0x100000000));
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.parts.push(x);
    return this;
  }
  toUint8Array() {
    return Uint8Array.from(this.parts);
  }
}

export async function buildZip(entries: TestZipEntry[], options: TestZipOptions = {}): Promise<Uint8Array> {
  const out = new Bytes();
  const central = new Bytes();
  for (const entry of entries) {
    const raw = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data ?? new Uint8Array(0);
    const method = entry.method ?? 8;
    const body = method === 8 ? await deflateRaw(raw) : raw;
    const name = entry.rawName ?? encoder.encode(entry.name);
    const flags = entry.flags ?? (entry.rawName ? 0 : 0x0800);
    const crc = entry.crc ?? zipCrc32(raw);
    const size = entry.declaredSize ?? raw.length;
    const offset = out.length;

    out.u32(0x04034b50).u16(20).u16(flags).u16(method).u16(0).u16(0).u32(crc);
    out.u32(body.length).u32(raw.length).u16(name.length).u16(0).bytes(name).bytes(body);

    const extra = new Bytes();
    if (options.zip64) extra.u16(0x0001).u16(24).u64(size).u64(body.length).u64(offset);
    central.u32(0x02014b50).u16(45).u16(45).u16(flags).u16(method).u16(0).u16(0).u32(crc);
    central.u32(options.zip64 ? 0xffffffff : body.length).u32(options.zip64 ? 0xffffffff : size);
    central.u16(name.length).u16(extra.length).u16(0).u16(0).u16(0).u32(0);
    central.u32(options.zip64 ? 0xffffffff : offset).bytes(name).bytes(extra.toUint8Array());
  }
  const cdOffset = out.length;
  const cd = central.toUint8Array();
  out.bytes(cd);
  if (options.zip64) {
    const recordOffset = out.length;
    out.u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0);
    out.u64(entries.length).u64(entries.length).u64(cd.length).u64(cdOffset);
    out.u32(0x07064b50).u32(0).u64(recordOffset).u32(1);
  }
  const comment = encoder.encode(options.comment ?? "");
  out.u32(0x06054b50).u16(0).u16(0);
  out.u16(options.zip64 ? 0xffff : entries.length).u16(options.zip64 ? 0xffff : entries.length);
  out.u32(options.zip64 ? 0xffffffff : cd.length).u32(options.zip64 ? 0xffffffff : cdOffset);
  out.u16(comment.length).bytes(comment);
  return out.toUint8Array();
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DRAWING_NS =
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

export interface TestDocxParts {
  /** Inner XML of `<w:body>`. */
  body: string;
  /** Inner XML of `<w:styles>`. */
  styles?: string;
  /** Inner XML of `<w:numbering>`. */
  numbering?: string;
  /** Inner XML of `<w:footnotes>`. */
  footnotes?: string;
  /** Extra `<Relationship>` elements for `word/_rels/document.xml.rels`. */
  rels?: string;
  /** Extra files, e.g. `{ "word/media/image1.png": bytes }`. */
  files?: Record<string, string | Uint8Array>;
  /** Main part path (default `word/document.xml`). */
  mainPath?: string;
}

export async function buildDocx(parts: TestDocxParts): Promise<Uint8Array> {
  const mainPath = parts.mainPath ?? "word/document.xml";
  const dir = mainPath.slice(0, mainPath.lastIndexOf("/") + 1);
  const file = mainPath.slice(dir.length);
  const xml = (s: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${s}`;
  const relsNs = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
  const entries: TestZipEntry[] = [
    { name: "[Content_Types].xml", data: xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
    {
      name: "_rels/.rels",
      data: xml(
        `<Relationships ${relsNs}><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${mainPath}"/></Relationships>`,
      ),
    },
    {
      name: mainPath,
      data: xml(`<w:document ${W} ${R} ${DRAWING_NS}><w:body>${parts.body}<w:sectPr/></w:body></w:document>`),
    },
    { name: `${dir}_rels/${file}.rels`, data: xml(`<Relationships ${relsNs}>${parts.rels ?? ""}</Relationships>`) },
  ];
  if (parts.styles !== undefined) entries.push({ name: `${dir}styles.xml`, data: xml(`<w:styles ${W}>${parts.styles}</w:styles>`) });
  if (parts.numbering !== undefined) {
    entries.push({ name: `${dir}numbering.xml`, data: xml(`<w:numbering ${W}>${parts.numbering}</w:numbering>`) });
  }
  if (parts.footnotes !== undefined) {
    entries.push({ name: `${dir}footnotes.xml`, data: xml(`<w:footnotes ${W} ${R}>${parts.footnotes}</w:footnotes>`) });
  }
  for (const [name, data] of Object.entries(parts.files ?? {})) entries.push({ name, data, method: 0 });
  return buildZip(entries);
}

/** `<w:p>` with optional paragraph properties and runs. */
export const p = (runs: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs}</w:p>`;
/** `<w:r>` with text and optional run properties. */
export const r = (text: string, rPr = "") =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
