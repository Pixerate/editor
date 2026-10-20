/**
 * Builds tiny but valid font files for tests: a TrueType (`glyf`) font and a CFF (`OTTO`) font with
 * the same three glyphs: `.notdef`, `A` (a 500 × 700 box, advance 600) and `V` (a triangle,
 * advance 600), units per em 1000, ascender 800, descender −200, and `AV` kerned by −100 (through
 * `kern` in the TrueType font and `GPOS` in the CFF font).
 */

class Writer {
  bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 255);
    return this;
  }
  u16(v: number) {
    return this.u8(v >> 8).u8(v);
  }
  i16(v: number) {
    return this.u16(v < 0 ? v + 65536 : v);
  }
  u32(v: number) {
    return this.u16(Math.floor(v / 65536)).u16(v % 65536);
  }
  tag(t: string) {
    for (const c of t) this.u8(c.charCodeAt(0));
    return this;
  }
  raw(b: number[]) {
    this.bytes.push(...b);
    return this;
  }
}

function sfnt(flavor: number | string, tables: Record<string, number[]>): Uint8Array {
  const tags = Object.keys(tables).sort();
  const w = new Writer();
  if (typeof flavor === 'string') w.tag(flavor);
  else w.u32(flavor);
  w.u16(tags.length).u16(0).u16(0).u16(0);
  let offset = 12 + tags.length * 16;
  const body: number[] = [];
  for (const t of tags) {
    const data = tables[t];
    w.tag(t.padEnd(4, ' ')).u32(0).u32(offset).u32(data.length);
    body.push(...data);
    while (body.length % 4) body.push(0);
    offset = 12 + tags.length * 16 + body.length;
  }
  return new Uint8Array([...w.bytes, ...body]);
}

function head(longLoca: boolean) {
  const w = new Writer();
  w.u32(0x10000).u32(0x10000).u32(0).u32(0x5f0f3cf5).u16(0).u16(1000);
  w.u32(0).u32(0).u32(0).u32(0); // created, modified
  w.i16(0).i16(-200).i16(600).i16(800); // bbox
  w.u16(0).u16(8).i16(2).i16(longLoca ? 1 : 0).i16(0);
  return w.bytes;
}

function hhea() {
  return new Writer().u32(0x10000).i16(800).i16(-200).i16(0).u16(600).i16(0).i16(0).i16(600).i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(3).bytes;
}

function maxp(cff: boolean) {
  return cff ? new Writer().u32(0x5000).u16(3).bytes : new Writer().u32(0x10000).u16(3).raw(new Array(26).fill(0)).bytes;
}

function hmtx() {
  return new Writer().u16(500).i16(0).u16(600).i16(50).u16(600).i16(0).bytes;
}

function cmap() {
  // Format 4: 'A' (65) → 1, 'V' (86) → 2, then the 0xFFFF end segment.
  const ends = [65, 86, 0xffff];
  const starts = [65, 86, 0xffff];
  const deltas = [1 - 65, 2 - 86, 1];
  const seg = ends.length;
  const sub = new Writer().u16(4).u16(16 + seg * 8).u16(0).u16(seg * 2).u16(4).u16(1).u16(seg * 2 - 4);
  ends.forEach((e) => sub.u16(e));
  sub.u16(0);
  starts.forEach((s) => sub.u16(s));
  deltas.forEach((d) => sub.i16(d));
  ends.forEach(() => sub.u16(0));
  return new Writer().u16(0).u16(1).u16(3).u16(1).u32(12).raw(sub.bytes).bytes;
}

function nameTable(family: string, sub: string) {
  const records: Array<[number, string]> = [
    [1, family],
    [2, sub],
    [6, `${family.replace(/\s/g, '')}-${sub}`],
  ];
  const w = new Writer().u16(0).u16(records.length).u16(6 + records.length * 12);
  const strings: number[] = [];
  for (const [id, text] of records) {
    const bytes: number[] = [];
    for (const c of text) bytes.push(0, c.charCodeAt(0));
    w.u16(3).u16(1).u16(0x409).u16(id).u16(bytes.length).u16(strings.length);
    strings.push(...bytes);
  }
  return [...w.bytes, ...strings];
}

function os2(weight: number) {
  const w = new Writer().u16(4).i16(500).u16(weight).u16(5).u16(0);
  w.raw(new Array(62 - 10).fill(0));
  w.u16(0x40); // fsSelection: regular
  w.u16(65).u16(86).i16(800).i16(-200).i16(0).u16(800).u16(200);
  w.raw(new Array(96 - 78).fill(0));
  return w.bytes;
}

function glyf(): { glyf: number[]; loca: number[] } {
  const simple = (pts: Array<[number, number]>) => {
    const w = new Writer().i16(1);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    w.i16(Math.min(...xs)).i16(Math.min(...ys)).i16(Math.max(...xs)).i16(Math.max(...ys));
    w.u16(pts.length - 1).u16(0);
    pts.forEach(() => w.u8(1)); // on curve, two-byte deltas
    let px = 0;
    for (const [x] of pts) {
      w.i16(x - px);
      px = x;
    }
    let py = 0;
    for (const [, y] of pts) {
      w.i16(y - py);
      py = y;
    }
    while (w.bytes.length % 2) w.u8(0);
    return w.bytes;
  };
  const box = simple([
    [50, 0],
    [50, 700],
    [550, 700],
    [550, 0],
  ]);
  const tri = simple([
    [0, 700],
    [300, 0],
    [600, 700],
  ]);
  const data = [...box, ...tri];
  const loca = new Writer().u16(0).u16(0).u16(box.length / 2).u16(data.length / 2).bytes;
  return { glyf: data, loca };
}

function kern() {
  return new Writer().u16(0).u16(1).u16(0).u16(14 + 6).u16(1).u16(1).u16(6).u16(0).u16(0).u16(1).u16(2).i16(-100).bytes;
}

/** A TrueType font (see the module comment). */
export function trueTypeFont(family = 'Test Sans', weight = 400): Uint8Array {
  const { glyf: g, loca } = glyf();
  return sfnt(0x10000, { head: head(false), hhea: hhea(), maxp: maxp(false), hmtx: hmtx(), cmap: cmap(), name: nameTable(family, weight >= 700 ? 'Bold' : 'Regular'), 'OS/2': os2(weight), glyf: g, loca, kern: kern() });
}

// --- CFF ---------------------------------------------------------------------

const cffInt = (v: number): number[] => {
  if (v >= -107 && v <= 107) return [v + 139];
  if (v >= 108 && v <= 1131) {
    const x = v - 108;
    return [(x >> 8) + 247, x & 255];
  }
  if (v >= -1131 && v <= -108) {
    const x = -v - 108;
    return [(x >> 8) + 251, x & 255];
  }
  return [28, (v >> 8) & 255, v & 255];
};
const dictInt = (v: number): number[] => [29, (v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];

function index(items: number[][]): number[] {
  if (!items.length) return [0, 0];
  const w = new Writer().u16(items.length).u8(2);
  let off = 1;
  w.u16(off);
  for (const it of items) {
    off += it.length;
    w.u16(off);
  }
  return [...w.bytes, ...items.flat()];
}

function cff(): number[] {
  // Charstrings: width first (nominal width 0), then the outline. A: rmoveto 50 0, vlineto 700,
  // hlineto 500, vlineto -700, endchar. V: rmoveto 0 700, rlineto 300 -700 300 700, endchar.
  const notdef = [...cffInt(500), 14];
  const a = [...cffInt(600), ...cffInt(50), ...cffInt(0), 21, ...cffInt(700), 7, ...cffInt(500), 6, ...cffInt(-700), 7, 14];
  // V uses a local subr for its rlineto (bias 107: index 0 is called as -107).
  const subr = [...cffInt(300), ...cffInt(-700), ...cffInt(300), ...cffInt(700), 5, 11];
  const v = [...cffInt(600), ...cffInt(0), ...cffInt(700), 21, ...cffInt(-107), 10, 14];
  const header = [1, 0, 4, 1];
  const names = index([[...'Test'].map((c) => c.charCodeAt(0))]);
  const strings = index([]);
  const gsubrs = index([]);
  const charStrings = index([notdef, a, v]);
  const subrs = index([subr]);
  // Private dict: Subrs offset (19) relative to the private dict; set after its size is known.
  const privateDict = (subrsOffset: number) => [...dictInt(subrsOffset), 19];
  const privSize = privateDict(0).length;
  // Top dict with fixed-size operands so offsets can be computed in one pass.
  const topDict = (cs: number, priv: number) => [...dictInt(cs), 17, ...dictInt(privSize), ...dictInt(priv), 18];
  const topIndex = (cs: number, priv: number) => index([topDict(cs, priv)]);
  const before = header.length + names.length + topIndex(0, 0).length + strings.length + gsubrs.length;
  const csOffset = before;
  const privOffset = csOffset + charStrings.length;
  return [...header, ...names, ...topIndex(csOffset, privOffset), ...strings, ...gsubrs, ...charStrings, ...privateDict(privSize), ...subrs];
}

function gpos(): number[] {
  // One PairPos format 1 lookup under the 'kern' feature: A (1) followed by V (2) → XAdvance −100.
  const coverage = new Writer().u16(1).u16(1).u16(1).bytes;
  const pairSet = new Writer().u16(1).u16(2).i16(-100).bytes;
  const sub = new Writer().u16(1).u16(12).u16(4).u16(0).u16(1).u16(12 + coverage.length);
  const subtable = [...sub.bytes, ...coverage, ...pairSet];
  const lookup = new Writer().u16(2).u16(0).u16(1).u16(8).bytes;
  const lookupList = [...new Writer().u16(1).u16(4).bytes, ...lookup, ...subtable];
  const feature = new Writer().u16(0).u16(1).u16(0).bytes;
  const featureList = [...new Writer().u16(1).tag('kern').u16(8).bytes, ...feature];
  const scriptList = new Writer().u16(0).bytes;
  const headerSize = 10;
  const w = new Writer().u32(0x10000).u16(headerSize).u16(headerSize + scriptList.length).u16(headerSize + scriptList.length + featureList.length);
  return [...w.bytes, ...scriptList, ...featureList, ...lookupList];
}

/** A CFF-flavoured OpenType font (see the module comment). */
export function cffFont(family = 'Test Serif', weight = 400): Uint8Array {
  return sfnt('OTTO', { head: head(false), hhea: hhea(), maxp: maxp(true), hmtx: hmtx(), cmap: cmap(), name: nameTable(family, 'Regular'), 'OS/2': os2(weight), 'CFF ': cff(), GPOS: gpos() });
}
