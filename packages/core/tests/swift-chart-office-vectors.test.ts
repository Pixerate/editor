/**
 * Test vectors for the Swift port of `import/zip.ts` and the chart's Office readers
 * (`readZip`, `extractOfficeCharts`, `chartFromOoxml`, `chartToOoxml`), including malformed
 * archives. The archives are built byte by byte here (stored blocks and fixed deflate streams
 * written out in hex), so the fixture does not depend on the zlib that Node ships.
 *
 * `UPDATE_SWIFT_VECTORS=1` rewrites `packages/swift/Tests/PixerateChartTests/Fixtures/chart-office-vectors.json`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chartFallbackDomParser } from "../src/chart/contract.js";
import { extractOfficeCharts, extractPptxCharts, extractXlsxCharts, type OfficeChartsReadOptions } from "../src/chart/office-files.js";
import { chartFromMermaid } from "../src/chart/mermaid.js";
import { chartFromOoxml, chartToOoxml } from "../src/chart/ooxml.js";
import { parseSankey } from "../src/diagram/sankey/index.js";
import { parseTreemap } from "../src/diagram/treemap/index.js";
import { createChartSpec } from "../src/chart/spec.js";
import { readZip, ZipError, zipCrc32, type ZipReadOptions } from "../src/import/zip.js";
import { conformanceValuesMatch } from "../src/tools/conformance.js";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(here, "../../swift/Tests/PixerateChartTests/Fixtures/chart-office-vectors.json");

const enc = new TextEncoder();
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const bytesOf = (d: string | Uint8Array) => (typeof d === "string" ? enc.encode(d) : d);

/** `zlib.deflateRawSync` output, written out so Node's zlib version cannot change the fixture. */
const FIXED_HELLO = { data: "Hello, Hello, Hello, fixed Huffman!\n", body: hex("f348cdc9c9d751f040a1d2322b5253143c4ad3d27213f314b900") };
const FIXED_CHARTSPACE = { data: "<c:chartSpace>".repeat(3), body: hex("b349b64ace482c2a092e484c4eb5b3c1c30300") };

/** One final stored deflate block. */
function storedDeflate(data: Uint8Array): Uint8Array {
  const n = data.length;
  return Uint8Array.from([0x01, n & 0xff, n >> 8, ~n & 0xff, (~n >> 8) & 0xff, ...data]);
}

class Bytes {
  parts: number[] = [];
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
  bytes(b: Uint8Array | number[]) {
    for (const x of b) this.parts.push(x);
    return this;
  }
  done() {
    return Uint8Array.from(this.parts);
  }
}

interface Entry {
  name: string;
  /** Name bytes as written (default: UTF-8 of `name`). */
  rawName?: Uint8Array;
  data?: string | Uint8Array;
  /** 0 = stored (default), 8 = deflate (a stored block unless `body` is given), anything else as is. */
  method?: number;
  /** The compressed bytes as written. */
  body?: Uint8Array;
  /** General-purpose flags (default 0x0800, UTF-8, unless `rawName` is given). */
  flags?: number;
  /** Directory overrides. */
  size?: number;
  csize?: number;
  crc?: number;
  offset?: number;
  extra?: Uint8Array;
  /** Write a broken local header signature. */
  badLocal?: boolean;
}

interface ZipOpts {
  zip64?: boolean;
  /** Leave the ZIP64 extra fields out (the directory still says 0xffffffff). */
  zip64NoExtra?: boolean;
  /** Leave the ZIP64 locator out. */
  zip64NoLocator?: boolean;
  /** Point the ZIP64 locator past the end. */
  zip64BadRecord?: boolean;
  /** Write a huge (unsafe) ZIP64 record offset. */
  zip64Huge?: boolean;
  comment?: string;
  /** Declared comment length (default: the comment's). */
  commentLength?: number;
  disk?: number;
  /** Declared entry count. */
  count?: number;
  /** Added to the directory offset. */
  cdOffsetDelta?: number;
  /** Bytes after the end record. */
  trailer?: Uint8Array;
  /** Keep only the first n bytes. */
  truncate?: number;
}

function zip(entries: Entry[], o: ZipOpts = {}): Uint8Array {
  const out = new Bytes();
  const central = new Bytes();
  for (const e of entries) {
    const raw = bytesOf(e.data ?? "");
    const method = e.method ?? 0;
    const body = e.body ?? (method === 8 ? storedDeflate(raw) : raw);
    const name = e.rawName ?? enc.encode(e.name);
    const flags = e.flags ?? (e.rawName ? 0 : 0x0800);
    const crc = e.crc ?? zipCrc32(raw);
    const size = e.size ?? raw.length;
    const csize = e.csize ?? body.length;
    const offset = out.length;
    out.u32(e.badLocal ? 0x04034b51 : 0x04034b50).u16(20).u16(flags).u16(method).u16(0).u16(0).u32(crc);
    out.u32(body.length).u32(raw.length).u16(name.length).u16(0).bytes(name).bytes(body);
    const extra = new Bytes();
    if (o.zip64 && !o.zip64NoExtra) extra.u16(0x0001).u16(24).u64(size).u64(csize).u64(e.offset ?? offset);
    if (e.extra) extra.bytes(e.extra);
    central.u32(0x02014b50).u16(45).u16(45).u16(flags).u16(method).u16(0).u16(0).u32(crc);
    central.u32(o.zip64 ? 0xffffffff : csize).u32(o.zip64 ? 0xffffffff : size);
    central.u16(name.length).u16(extra.length).u16(0).u16(0).u16(0).u32(0);
    central.u32(o.zip64 ? 0xffffffff : (e.offset ?? offset)).bytes(name).bytes(extra.done());
  }
  const cdOffset = out.length + (o.cdOffsetDelta ?? 0);
  const cd = central.done();
  out.bytes(cd);
  const count = o.count ?? entries.length;
  if (o.zip64) {
    const recordOffset = out.length;
    out.u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0);
    out.u64(count).u64(count).u64(cd.length).u64(cdOffset);
    if (!o.zip64NoLocator) {
      out.u32(0x07064b50).u32(0);
      if (o.zip64Huge) out.u32(0).u32(0x00400000);
      else out.u64(o.zip64BadRecord ? out.length + 1000 : recordOffset);
      out.u32(1);
    }
  }
  const comment = enc.encode(o.comment ?? "");
  out.u32(0x06054b50).u16(o.disk ?? 0).u16(0);
  out.u16(o.zip64 ? 0xffff : count).u16(o.zip64 ? 0xffff : count);
  out.u32(o.zip64 ? 0xffffffff : cd.length).u32(o.zip64 ? 0xffffffff : cdOffset);
  out.u16(o.commentLength ?? comment.length).bytes(comment);
  if (o.trailer) out.bytes(o.trailer);
  const all = out.done();
  return o.truncate !== undefined ? all.slice(0, o.truncate) : all;
}

const errorJson = (error: unknown) =>
  error instanceof ZipError
    ? { error: error.message, code: error.code, ...(error.entryName !== undefined ? { entryName: error.entryName } : {}) }
    : { error: (error as Error).message };

async function attempt<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof errorJson>> {
  try {
    return await fn();
  } catch (error) {
    return errorJson(error);
  }
}

interface ZipCase {
  name: string;
  bytes: Uint8Array;
  options?: ZipReadOptions;
  /** Names looked up with `get` and read by name, after every entry is read in order. */
  lookups?: string[];
}

const NFC = "\u00e9.txt";
const NFD = "e\u0301.txt";

function zipCases(): ZipCase[] {
  const big = { name: "media/video.mp4", data: "tiny", size: 300 * 1024 * 1024 };
  return [
    {
      name: "mixed entries",
      bytes: zip([
        { name: "a.txt", data: "first" },
        { name: "dir/", data: "" },
        { name: "dir/b.xml", data: "<b>stored block</b>", method: 8 },
        { name: "c.txt", data: FIXED_HELLO.data, method: 8, body: FIXED_HELLO.body },
        { name: "win\\path.txt", data: "backslash" },
        { name: "", rawName: Uint8Array.from([0x80, 0x81, 0x78, 0xff]), data: "cp437" },
        { name: "", rawName: Uint8Array.from([0xef, 0xbb, 0xbf, 0x6e]), flags: 0x0800, data: "bom name" },
        { name: "", rawName: Uint8Array.from([0x62, 0xc3, 0x28]), flags: 0x0800, data: "bad utf-8" },
        { name: "a.txt", data: "second (ignored by get)" },
        { name: NFC, data: "nfc" },
        { name: NFD, data: "nfd" },
        { name: "boms.txt", data: Uint8Array.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x41]) },
        { name: "secret.txt", data: "pw", flags: 0x0801 },
        { name: "bzip.bin", data: "x", method: 12 },
        { name: "crc.txt", data: "checksum", crc: 1234 },
        { name: "sizes.txt", data: "stored", size: 3 },
        { name: "bomb.txt", data: "0123456789", method: 8, size: 5 },
        { name: "short.txt", data: "0123456789", method: 8, size: 20 },
        { name: "broken.txt", data: "xx", method: 8, body: Uint8Array.from([0x07, 0x00]) },
        { name: "nolocal.txt", data: "local", badLocal: true },
        { name: "past-end.txt", data: "far", offset: 1_000_000 },
        { name: "long.txt", data: "csize", csize: 1_000_000 },
        big,
        { name: "./dot.txt", data: "dot" },
        { name: "ctl\u0001name.txt", data: "control" },
        { name: "...", data: "dots" },
        { name: "a/..\u0301/b", data: "combining" },
        { name: "chart.xml", data: FIXED_CHARTSPACE.data, method: 8, body: FIXED_CHARTSPACE.body },
      ]),
      lookups: ["a.txt", "/a.txt", "//a.txt", "missing.txt", "dir/", NFC, NFD, "win/path.txt", "win\\path.txt", "\u00c7\u00fcx\u00a0", "n", "./dot.txt", "dot.txt", "A.TXT"],
    },
    {
      name: "size limit counts bytes read",
      bytes: zip([big, { name: "one.txt", data: "123456" }, { name: "crc.txt", data: "abcd", crc: 7 }, { name: "two.txt", data: "123456" }, { name: "three.txt", data: "12" }]),
      options: { maxTotalSize: 14 },
      lookups: ["one.txt", "three.txt"],
    },
    { name: "zero size limit", bytes: zip([{ name: "empty.txt", data: "" }, { name: "one.txt", data: "1" }]), options: { maxTotalSize: 0 } },
    { name: "unsafe parent", bytes: zip([{ name: "ok.txt", data: "ok" }, { name: "../evil.txt", data: "x" }]) },
    { name: "unsafe directory", bytes: zip([{ name: "../x/", data: "" }]) },
    { name: "unsafe absolute", bytes: zip([{ name: "/etc/passwd", data: "x" }]) },
    { name: "unsafe backslash", bytes: zip([{ name: "a\\..\\b.txt", data: "x" }]) },
    { name: "unsafe drive", bytes: zip([{ name: "C:x.txt", data: "x" }]) },
    { name: "unsafe nul", bytes: zip([{ name: "a\u0000b", data: "x" }]) },
    { name: "unsafe empty", bytes: zip([{ name: "", data: "x" }]) },
    {
      name: "unsafe skipped",
      bytes: zip([
        { name: "../evil.txt", data: "x" },
        { name: "keep.txt", data: "keep" },
        { name: "/abs", data: "x" },
        { name: "d:/x", data: "x" },
        { name: "x/../y/", data: "" },
        { name: "", data: "x" },
        { name: "1:x", data: "fine" },
      ]),
      options: { unsafePaths: "skip" },
    },
    { name: "empty bytes", bytes: new Uint8Array(0) },
    { name: "not a zip", bytes: enc.encode("hello, this is not a ZIP archive at all") },
    { name: "empty archive", bytes: zip([]) },
    { name: "comment", bytes: zip([{ name: "a.txt", data: "a" }], { comment: "a comment PK\u0005\u0006" }) },
    { name: "comment past end", bytes: zip([{ name: "a.txt", data: "a" }], { commentLength: 10 }) },
    { name: "trailing bytes", bytes: zip([{ name: "a.txt", data: "a" }], { trailer: enc.encode("junk") }) },
    { name: "multi-disk", bytes: zip([{ name: "a.txt", data: "a" }], { disk: 1 }) },
    { name: "too many entries", bytes: zip([{ name: "a.txt" }, { name: "b.txt" }]), options: { maxEntries: 1 } },
    { name: "directory outside file", bytes: zip([{ name: "a.txt", data: "a" }], { cdOffsetDelta: 100 }) },
    { name: "directory signature", bytes: zip([{ name: "a.txt", data: "a" }], { cdOffsetDelta: -1 }) },
    { name: "count beyond directory", bytes: zip([{ name: "a.txt", data: "a" }], { count: 2 }) },
    { name: "truncated", bytes: zip([{ name: "a.txt", data: "a" }], { truncate: 50 }) },
    {
      name: "directory entry truncated",
      bytes: zip([{ name: "a.txt", data: "a", extra: Uint8Array.from([0x34, 0x12, 0xff, 0xff]) }]),
    },
    {
      name: "zip64",
      bytes: zip(
        [
          { name: "a.txt", data: "zip64 entry" },
          { name: "b.txt", data: FIXED_HELLO.data, method: 8, body: FIXED_HELLO.body },
        ],
        { zip64: true },
      ),
    },
    { name: "zip64 missing locator", bytes: zip([{ name: "a.txt", data: "a" }], { zip64: true, zip64NoLocator: true }) },
    { name: "zip64 record not found", bytes: zip([{ name: "a.txt", data: "a" }], { zip64: true, zip64BadRecord: true }) },
    { name: "zip64 value out of range", bytes: zip([{ name: "a.txt", data: "a" }], { zip64: true, zip64Huge: true }) },
    { name: "zip64 missing extra field", bytes: zip([{ name: "a.txt", data: "a" }], { zip64: true, zip64NoExtra: true }) },
    {
      name: "zip64 extra field skipped",
      bytes: zip([{ name: "a.txt", data: "abc", extra: Uint8Array.from([0x99, 0x99, 0x02, 0x00, 0x01, 0x02, 0x01, 0x00, 0x08, 0x00, 7, 0, 0, 0, 0, 0, 0, 0]) }]),
    },
    {
      name: "zip64 extra field unsafe",
      bytes: zip([{ name: "a.txt", data: "abc", size: 0xffffffff, extra: Uint8Array.from([0x01, 0x00, 0x08, 0x00, 0, 0, 0, 0, 0, 0, 0x40, 0]) }]),
    },
  ];
}

async function zipVector(c: ZipCase) {
  const out: Record<string, unknown> = { fn: "readZip", name: c.name, bytes: b64(c.bytes), ...(c.options ? { options: c.options } : {}), ...(c.lookups ? { lookups: c.lookups } : {}) };
  let archive;
  try {
    archive = await readZip(c.bytes, c.options);
  } catch (error) {
    out.expected = errorJson(error);
    return out;
  }
  const entries = archive.entries.map((e) => ({ ...e }));
  const reads = [];
  for (const entry of archive.entries) {
    reads.push(await attempt(async () => ({ data: b64(await archive.read(entry)) })));
  }
  const gets = (c.lookups ?? []).map((name) => {
    const entry = archive.get(name);
    return entry ? archive.entries.indexOf(entry) : -1;
  });
  const named = [];
  for (const name of c.lookups ?? []) named.push(await attempt(async () => ({ text: await archive.readText(name) })));
  out.expected = { entries, reads, gets, named, extractedSize: archive.extractedSize };
  return out;
}

// ---------------------------------------------------------------------------
// Office files
// ---------------------------------------------------------------------------

const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const CX = "http://schemas.microsoft.com/office/drawing/2014/chartex";
const REL_CHART = `${R}/chart`;
const REL_CHARTEX = "http://schemas.microsoft.com/office/2014/relationships/chartEx";
const BOM = "\ufeff";

const rels = (items: [id: string, type: string, target: string, mode?: string][]) =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(([id, type, target, mode]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ""}/>`)
    .join("")}</Relationships>`;
const rootRels = (target: string) => rels([["rId1", `${R}/officeDocument`, target]]);

const barXml = chartToOoxml(createChartSpec({ type: "bar", title: "Revenue", categories: ["Q1", "Q2"], series: [{ name: "North", values: [3, 5] }] })).xml;
const lineXml = chartToOoxml(createChartSpec({ type: "line", title: "Trend", categories: ["a", "b", "c"], series: [{ name: "S", values: [1, 2, 3] }] })).xml;
const pieXml = chartToOoxml(createChartSpec({ type: "pie", title: "Share & <more>", categories: ["x", "y"], series: [{ name: "P", values: [1, 3] }] })).xml;
const waterfallXml = `<cx:chartSpace xmlns:cx="${CX}"><cx:chartData><cx:data id="0"><cx:strDim type="cat"><cx:lvl ptCount="2"><cx:pt idx="0">Start</cx:pt><cx:pt idx="1">Up</cx:pt></cx:lvl></cx:strDim><cx:numDim type="val"><cx:lvl ptCount="2"><cx:pt idx="0">10</cx:pt><cx:pt idx="1">5</cx:pt></cx:lvl></cx:numDim></cx:data></cx:chartData><cx:chart><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="waterfall"><cx:tx><cx:txData><cx:v>Cash</cx:v></cx:txData></cx:tx><cx:dataId val="0"/></cx:series></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>`;

const graphicFrame = (name: string, ref: string) =>
  `<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="${name}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><a:graphic><a:graphicData uri="${C}">${ref}</a:graphicData></a:graphic></xdr:graphicFrame>`;

function xlsxEntries(): Entry[] {
  const drawing1 = `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}" xmlns:c="${C}" xmlns:cx="${CX}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
    <xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>17</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>${graphicFrame("Chart 1", `<c:chart r:id="rId1"/>`)}<xdr:clientData/></xdr:twoCellAnchor>
    <mc:AlternateContent><mc:Choice Requires="cx1"><xdr:oneCellAnchor><xdr:from><xdr:col>27</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="1" cy="1"/>${graphicFrame("Waterfall", `<cx:chart r:id="rId2"/>`)}<xdr:clientData/></xdr:oneCellAnchor></mc:Choice><mc:Fallback/></mc:AlternateContent>
    <xdr:twoCellAnchor><xdr:from><xdr:col>x</xdr:col><xdr:row>2</xdr:row></xdr:from><xdr:to><xdr:col>800</xdr:col><xdr:row>1048575</xdr:row></xdr:to>${graphicFrame("", `<c:chart r:id="rId3"/>`)}</xdr:twoCellAnchor>
    <xdr:twoCellAnchor><xdr:from><xdr:col>16383</xdr:col><xdr:row></xdr:row></xdr:from><xdr:to><xdr:col>1.5</xdr:col><xdr:row>2</xdr:row></xdr:to>${graphicFrame("Edge", `<c:chart r:id="rId4"/><c:chart r:id="rId1"/><c:chart r:id="rIdMissing"/><c:chart r:id="rIdExt"/><other:chart xmlns:other="urn:x" r:id="rId5"/>`)}</xdr:twoCellAnchor>
  </xdr:wsDr>`;
  const drawing2 = `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}" xmlns:c="${C}"><xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="1" cy="1"/>${graphicFrame("Chart 9", `<c:chart r:id="rId1"/>`)}<xdr:clientData/></xdr:absoluteAnchor></xdr:wsDr>`;
  return [
    { name: "_rels/.rels", data: BOM + rootRels("xl/workbook.xml") },
    {
      name: "xl/workbook.xml",
      data: `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Sales &amp; chart" sheetId="2" r:id="rId2"/><sheet name="Empty" sheetId="3" r:id="rId3"/><sheet sheetId="4" r:id="rId4"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: rels([
        ["rId1", `${R}/worksheet`, "worksheets/sheet1.xml"],
        ["rId2", `${R}/chartsheet`, "chartsheets/sheet1.xml"],
        ["rId3", `${R}/worksheet`, "worksheets/sheet2.xml"],
        ["rId4", `${R}/worksheet`, "./worksheets/../worksheets/SHEET3.XML"],
      ]),
    },
    { name: "xl/worksheets/sheet1.xml", data: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><sheetData/><drawing r:id="rId1"/></worksheet>` },
    { name: "xl/worksheets/_rels/sheet1.xml.rels", data: rels([["rId1", `${R}/drawing`, "../drawings/drawing1.xml"]]) },
    { name: "xl/worksheets/sheet2.xml", data: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>` },
    { name: "xl/worksheets/sheet3.xml", data: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><drawing r:id="rId1"/></worksheet>` },
    { name: "xl/worksheets/_rels/sheet3.xml.rels", data: rels([["rId1", `${R}/drawing`, "../drawings/drawing2.xml"]]) },
    { name: "xl/chartsheets/sheet1.xml", data: `<chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><drawing r:id="rId1"/></chartsheet>` },
    { name: "xl/chartsheets/_rels/sheet1.xml.rels", data: rels([["rId1", `${R}/drawing`, "../drawings/drawing2.xml"]]) },
    { name: "xl/drawings/drawing1.xml", data: drawing1 },
    {
      name: "xl/drawings/_rels/drawing1.xml.rels",
      data: rels([
        ["rId1", REL_CHART, "../charts/chart1.xml"],
        ["rId2", REL_CHARTEX, "../charts/chartEx1.xml"],
        ["rId3", REL_CHART, "../charts/chart3.xml"],
        ["rId4", REL_CHART, "../charts/chart4.xml"],
        ["rIdExt", REL_CHART, "https://example.com/chart.xml", "External"],
        ["rId5", REL_CHART, "../charts/chart3.xml"],
        ["rId4", REL_CHART, "../charts/chart5.xml"],
      ]),
    },
    { name: "xl/drawings/drawing2.xml", data: drawing2 },
    { name: "xl/drawings/_rels/drawing2.xml.rels", data: rels([["rId1", REL_CHART, "/xl/charts/chart2.xml"]]) },
    { name: "xl/charts/chart1.xml", data: barXml, method: 8 },
    { name: "xl/charts/chart2.xml", data: BOM + lineXml },
    { name: "xl/charts/chartEx1.xml", data: waterfallXml },
    { name: "xl/charts/chart3.xml", data: pieXml },
    { name: "xl/charts/chart4.xml", data: "<notAChart/>" },
    { name: "xl/charts/chart5.xml", data: `<c:chartSpace xmlns:c="${C}"><c:chart><c:title><c:tx><c:rich><a:p xmlns:a="x"><a:r><a:t>Bad &#x110000; ref</a:t></a:r></a:p></c:rich></c:tx></c:title></c:chart></c:chartSpace>` },
  ];
}

function pptxEntries(extra: Entry[] = []): Entry[] {
  const slide = (frames: string) =>
    `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}" xmlns:c="${C}"><p:cSld><p:spTree>${frames}</p:spTree></p:cSld></p:sld>`;
  const frame = (name: string, rid: string) =>
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></p:xfrm><a:graphic><a:graphicData uri="${C}"><c:chart r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`;
  return [
    { name: "_rels/.rels", data: rels([["rId0", `${R}/officeDocument`, "https://example.com/x", "External"], ["rId1", `${R}/officeDocument`, "ppt/presentation.xml"]]) },
    {
      name: "ppt/presentation.xml",
      data: `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId4"/><p:sldId id="259" r:id="rIdNfd\u0065\u0301"/></p:sldIdLst></p:presentation>`,
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      data: rels([
        ["rId2", `${R}/slide`, "slides/slide1.xml"],
        ["rId3", `${R}/slide`, "slides/slide2.xml"],
        ["rId4", `${R}/slide`, "slides/slide3.xml"],
        ["rIdNfd\u00e9", `${R}/slide`, "slides/slide3.xml"],
      ]),
    },
    { name: "ppt/slides/slide2.xml", data: slide("") },
    { name: "ppt/slides/slide1.xml", data: slide(frame("Revenue chart", "rId5") + frame("Missing", "rId9")) },
    { name: "ppt/slides/_rels/slide1.xml.rels", data: rels([["rId5", REL_CHART, "../charts/chart7.xml"]]) },
    { name: "ppt/slides/slide3.xml", data: slide(frame("Line", "rId1")) },
    { name: "ppt/slides/_rels/slide3.xml.rels", data: rels([["rId1", REL_CHART, "../charts/chart8.xml"]]) },
    { name: "ppt/charts/chart7.xml", data: barXml, method: 8 },
    { name: "ppt/charts/chart8.xml", data: lineXml },
    { name: "ppt/charts/chart8.xml", data: pieXml },
    ...extra,
  ];
}

function docxEntries(): Entry[] {
  const body = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" xmlns:r="${R}" r:id="rIdChart"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  return [
    { name: "[Content_Types].xml", data: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    { name: "_rels/.rels", data: rootRels("/word/document.xml") },
    { name: "word/document.xml", data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>` },
    { name: "word/_rels/document.xml.rels", data: rels([["rIdChart", REL_CHART, "charts/chart1.xml"]]) },
    { name: "word/charts/chart1.xml", data: lineXml },
  ];
}

interface OfficeCase {
  name: string;
  fn?: "extractOfficeCharts" | "extractXlsxCharts" | "extractPptxCharts";
  bytes: Uint8Array;
  options?: Omit<OfficeChartsReadOptions, "DOMParser">;
}

function officeCases(): OfficeCase[] {
  const video = { name: "ppt/media/video.mp4", data: "not really a video", size: 300 * 1024 * 1024 };
  return [
    { name: "xlsx", bytes: zip(xlsxEntries().filter((e) => e.name !== "xl/charts/chart5.xml")) },
    { name: "xlsx bad character reference", bytes: zip(xlsxEntries()) },
    { name: "xlsx maxCharts", bytes: zip(xlsxEntries()), options: { maxCharts: 2 } },
    { name: "pptx", bytes: zip(pptxEntries()) },
    { name: "pptx as xlsx", fn: "extractXlsxCharts", bytes: zip(pptxEntries()) },
    { name: "pptx as pptx", fn: "extractPptxCharts", bytes: zip(pptxEntries()) },
    { name: "pptx with a large video", bytes: zip(pptxEntries([video])), options: { maxTotalSize: 64 * 1024 } },
    { name: "pptx over the size limit", bytes: zip(pptxEntries()), options: { maxTotalSize: 1500 } },
    {
      name: "pptx bad character reference in a slide",
      bytes: zip(pptxEntries().map((e) => (e.name === "ppt/slides/slide1.xml" ? { ...e, data: String(e.data).replace('name="Missing"', 'name="&#1114112;"') } : e))),
    },
    { name: "pptx unsafe entry", bytes: zip(pptxEntries([{ name: "../evil.xml", data: "x" }])) },
    { name: "pptx unsafe entry skipped", bytes: zip(pptxEntries([{ name: "../evil.xml", data: "x" }])), options: { unsafePaths: "skip" } },
    { name: "pptx too many entries", bytes: zip(pptxEntries()), options: { maxEntries: 3 } },
    { name: "docx", bytes: zip(docxEntries()) },
    { name: "zip64 docx", bytes: zip(docxEntries(), { zip64: true }) },
    { name: "not a zip", bytes: enc.encode("hello") },
    { name: "no main part", bytes: zip([{ name: "a.txt", data: "x" }]) },
    { name: "main part not xml", bytes: zip([{ name: "_rels/.rels", data: rootRels("main.xml") }, { name: "main.xml", data: "<a><b></a>" }]) },
    { name: "main part of another kind", bytes: zip([{ name: "_rels/.rels", data: rootRels("main.xml") }, { name: "main.xml", data: `<x:drawing xmlns:x="urn:x"/>` }]) },
    { name: "main part found by case", bytes: zip([{ name: "_rels/.rels", data: rootRels("Word/Document.XML") }, { name: "word/document.xml", data: `<document/>` }]) },
    { name: "corrupt part", bytes: zip([{ name: "_rels/.rels", data: rootRels("main.xml"), crc: 1 }]) },
  ];
}

async function officeVector(c: OfficeCase) {
  const fn = c.fn ?? "extractOfficeCharts";
  const options = { ...c.options, DOMParser: chartFallbackDomParser };
  const run = fn === "extractXlsxCharts" ? extractXlsxCharts : fn === "extractPptxCharts" ? extractPptxCharts : extractOfficeCharts;
  const expected = await attempt(async () => JSON.parse(JSON.stringify(await run(c.bytes, options))));
  return { fn, name: c.name, bytes: b64(c.bytes), ...(c.options ? { options: c.options } : {}), expected };
}

// ---------------------------------------------------------------------------
// chartToOoxml / chartFromOoxml
// ---------------------------------------------------------------------------

const SPECS: unknown[] = [
  { type: "bar", title: "Revenue", categories: ["Q1", "Q2"], series: [{ name: "North", values: [3, 5] }] },
  { type: "bar", title: "3-D", categories: ["Q1", "Q2"], series: [{ name: "North", values: [3, 5] }], view3d: { azimuth: 30, elevation: 20, depth: 2 } },
  { type: "line", categories: ["a", "b", "c"], series: [{ name: "S", values: [1, 3, 2] }], view3d: { azimuth: 359.6, elevation: 40.5, depth: 0.3 } },
  { type: "area", stacking: "percent", categories: ["a", "b"], series: [{ name: "S", values: [1, 3] }, { name: "T", values: [2, 2] }], view3d: { depth: 25 } },
  { type: "bar", categories: ["a"], series: [{ name: "A", values: [1] }, { name: "B", type: "line", values: [2] }], view3d: {} },
  {
    type: "bar",
    title: "R&\u0301D <costs> \"quoted\"",
    subtitle: "ignored",
    categories: ["Q1", "Q2", "Q3"],
    series: [
      { id: "rev", name: "Revenue", values: [120, null, 160], color: "#1f77b4", dataLabels: true, trendlines: [{ type: "linear" }] },
      { id: "margin", name: "Margin", type: "line", axis: "secondary", values: [0.22, 0.25, 0.24], marker: "diamond" },
    ],
    yAxis: { title: "USD", min: 0, max: 200, format: { style: "currency", currency: "USD", decimals: 0 } },
    yAxis2: { show: true, title: "Margin %", format: { style: "percent", decimals: 1 } },
    legend: { show: true, position: "bottom" },
    stacking: "none",
  },
  { type: "line", categories: ["a", "b", "c"], series: [{ name: "S", values: [1.5, -2, 1e21], errorBars: { type: "percent", value: 5 } }], curve: "monotone" },
  { type: "area", stacking: "percent", categories: ["x", "y"], series: [{ name: "A", values: [1, 2] }, { name: "B", values: [3, 4] }] },
  { type: "column", stacking: "stacked", horizontal: true, categories: ["x", "y"], series: [{ name: "A", values: [1, 2] }] },
  { type: "pie", title: "Share", categories: ["x", "y", "z"], series: [{ name: "P", values: [1, 3, 0.5] }] },
  { type: "doughnut", categories: ["x", "y"], series: [{ name: "D", values: [2, 3] }] },
  { type: "scatter", series: [{ name: "XY", values: [1, 4, 9], x: [1, 2, 3], errorBars: { type: "custom", plus: [1, 2, 3] } }] },
  { type: "bubble", series: [{ name: "B", values: [1, 2], x: [3, 4], sizes: [5, 6] }] },
  { type: "radar", categories: ["a", "b", "c"], series: [{ name: "R", values: [1, 2, 3] }] },
  { type: "waterfall", categories: ["Start", "Up", "Down"], series: [{ name: "W", values: [10, 5, -3] }] },
  { type: "histogram", series: [{ name: "H", values: [1, 2, 2, 3, 3, 3] }] },
  { type: "sankey", links: [{ source: "a", target: "b", value: 1 }] },
  { type: "bar", categories: ["\ud83d\ude00 emoji", "e\u0301"], series: [{ name: "Name with ]]> and <![CDATA[", values: [1, 2] }] },
];

const XMLS: { name: string; xml: string }[] = [
  { name: "waterfall chartex", xml: waterfallXml },
  { name: "bom and declaration", xml: `${BOM}<?xml version="1.0"?><!-- c --><!DOCTYPE x><c:chartSpace xmlns:c="${C}"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:ser><c:tx><c:v>S</c:v></c:tx><c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>x</c:v></c:pt></c:numLit></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>` },
  { name: "malformed", xml: `<c:chartSpace xmlns:c="${C}"><c:chart></c:chartSpace>` },
  // 3-D charts (#795): bar, line and area keep their view; pie is drawn flat; below the floor is noted.
  { name: "3-D bar default view", xml: `<c:chartSpace xmlns:c="${C}"><c:chart><c:plotArea><c:bar3DChart><c:barDir val="bar"/><c:ser><c:tx><c:v>S</c:v></c:tx><c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>3</c:v></c:pt></c:numLit></c:val></c:ser></c:bar3DChart></c:plotArea></c:chart></c:chartSpace>` },
  { name: "3-D line turned", xml: `<c:chartSpace xmlns:c="${C}"><c:chart><c:view3D><c:rotX val="30"/><c:rotY val="-40"/><c:depthPercent val="250"/></c:view3D><c:plotArea><c:line3DChart><c:ser><c:tx><c:v>S</c:v></c:tx><c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>3</c:v></c:pt></c:numLit></c:val></c:ser></c:line3DChart></c:plotArea></c:chart></c:chartSpace>` },
  { name: "3-D area below the floor", xml: `<c:chartSpace xmlns:c="${C}"><c:chart><c:view3D><c:rotX val="-20"/><c:rotY val="725"/><c:depthPercent val="5"/></c:view3D><c:plotArea><c:area3DChart><c:ser><c:tx><c:v>S</c:v></c:tx><c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>3</c:v></c:pt></c:numLit></c:val></c:ser></c:area3DChart></c:plotArea></c:chart></c:chartSpace>` },
  { name: "3-D pie", xml: `<c:chartSpace xmlns:c="${C}"><c:chart><c:plotArea><c:pie3DChart><c:ser><c:tx><c:v>S</c:v></c:tx><c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>3</c:v></c:pt></c:numLit></c:val></c:ser></c:pie3DChart></c:plotArea></c:chart></c:chartSpace>` },
  { name: "not a chart", xml: `<worksheet/>` },
  { name: "empty", xml: "" },
  { name: "text only", xml: "just text" },
  { name: "two roots", xml: `<c:chartSpace xmlns:c="${C}"/><c:chartSpace xmlns:c="${C}"/>` },
  { name: "code point too large", xml: `<c:chartSpace xmlns:c="${C}"><c:chart><c:title><c:tx><c:v>&#x110000;</c:v></c:tx></c:title></c:chart></c:chartSpace>` },
  { name: "huge code point", xml: `<c:chartSpace xmlns:c="${C}" a="&#xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;"/>` },
  { name: "infinite code point", xml: `<c:chartSpace xmlns:c="${C}" a="&#${"9".repeat(400)};"/>` },
  {
    name: "entities",
    xml: `<c:chartSpace xmlns:c="${C}"><c:chart><c:title><c:tx><c:rich><a:p xmlns:a="urn:a"><a:r><a:t>&lt;&gt;&amp;&quot;&apos;&#65;&#x42;&#X43;&nbsp;&toString;&constructor;&valueOf;&#0128512;&#x1F600;&#xd83d;</a:t></a:r></a:p></c:rich></c:tx></c:title><c:autoTitleDeleted val="0"/></c:chart></c:chartSpace>`,
  },
  { name: "cdata title", xml: `<c:chartSpace xmlns:c="${C}"><c:chart><c:title><c:tx><c:v><![CDATA[A <b> & c]]></c:v></c:tx></c:title></c:chart></c:chartSpace>` },
];

function ooxmlVectors() {
  const out: unknown[] = [];
  for (const input of SPECS) {
    const spec = createChartSpec(input as never);
    const written = chartToOoxml(spec);
    out.push({ fn: "chartToOoxml", input, expected: JSON.parse(JSON.stringify(written)) });
    out.push({ fn: "chartFromOoxml", name: `round trip ${(input as { type: string }).type}`, xml: written.xml, expected: JSON.parse(JSON.stringify(chartFromOoxml(written.xml, { DOMParser: chartFallbackDomParser }))) });
  }
  for (const { name, xml } of XMLS) {
    out.push({ fn: "chartFromOoxml", name, xml, expected: JSON.parse(JSON.stringify(chartFromOoxml(xml, { DOMParser: chartFallbackDomParser }))) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text parsers that index JS strings by code unit or code point (a quote, comma or `%` followed by
// a combining mark is one Swift Character, but still a quote, comma or `%` in JS).
// ---------------------------------------------------------------------------

const ACUTE = "́";

const MERMAID_TEXTS = [
  `xychart-beta\n    title "Sales${ACUTE}" extra\n    x-axis "Q${ACUTE}" ["a\"${ACUTE}b", "c,${ACUTE}d", e]\n    y-axis "Revenue" 0 --> 100\n    bar [1, 2, 3]`,
  `xychart-beta\n    title "R&D \u{1F600}"\n    x-axis [ "x#quot;${ACUTE}", "\"${ACUTE}y\"" ]\n    line [4, 5]`,
  `xychart-beta\n    title "unterminated\n    bar [1]`,
  `pie title "Pie ${ACUTE}"\n    "A${ACUTE}" : 1\n    "B" : 2`,
];

const SANKEY_TEXTS = [
  `sankey-beta\n"a,${ACUTE}b",c,1\n"q""${ACUTE}",d,2\ne${ACUTE},"f",3`,
  `sankey-beta\n"multi\nline${ACUTE}",x,4\nx,y,2`,
  `sankey-beta\na,b"${ACUTE},1`,
  `sankey-beta\n"a"${ACUTE},b,1`,
];

const TREEMAP_TEXTS = [
  `treemap-beta\n"A%${ACUTE}%" %% not a comment inside quotes\n    "x${ACUTE}": 4 %% comment\n    'y"%%z': 5\n"B"\n    "\u{1F600}": 1`,
];

function parserVectors() {
  return [
    ...MERMAID_TEXTS.map((text) => ({ fn: "chartFromMermaid", name: text.split("\n")[1] ?? text, text, expected: JSON.parse(JSON.stringify(chartFromMermaid(text))) })),
    ...SANKEY_TEXTS.map((text) => ({ fn: "parseSankey", name: text.split("\n")[1] ?? text, text, expected: JSON.parse(JSON.stringify(parseSankey(text))) })),
    ...TREEMAP_TEXTS.map((text) => ({ fn: "parseTreemap", name: "treemap", text, expected: JSON.parse(JSON.stringify(parseTreemap(text))) })),
  ];
}

async function vectors() {
  const entries: unknown[] = [];
  entries.push(...parserVectors());
  for (const c of zipCases()) entries.push(await zipVector(c));
  for (const c of officeCases()) entries.push(await officeVector(c));
  entries.push(...ooxmlVectors());
  return { version: 1, entries };
}

describe("Swift chart Office and ZIP test vectors", () => {
  it("match the committed fixture (the Swift tests read it)", async () => {
    const now = await vectors();
    if (process.env.UPDATE_SWIFT_VECTORS) {
      mkdirSync(dirname(FILE), { recursive: true });
      writeFileSync(FILE, JSON.stringify(now) + "\n");
    }
    const committed = JSON.parse(readFileSync(FILE, "utf8"));
    if (!conformanceValuesMatch(now, committed)) expect(now).toEqual(committed);
  });
});
