/**
 * A small OpenType reader: enough of a font file to set Latin, Cyrillic, Greek and CJK text as
 * outlines without a third-party library. It reads TrueType (`glyf`) and CFF (`CFF `, CID-keyed
 * included) outlines, `cmap` (formats 4 and 12), horizontal metrics, `kern` (format 0) and `GPOS`
 * pair kerning (lookup type 2, formats 1 and 2, the `kern` feature), vertical metrics (`vhea`,
 * `vmtx`, `VORG`) and vertical alternates (`GSUB` single substitutions of the `vert` feature), and
 * the family, PostScript name, weight and style. It applies no other `GSUB` (ligatures, contextual
 * forms) or complex-script shaping, so Arabic, Indic and similar scripts set as isolated glyphs.
 *
 * The result has the shape of opentype.js's `Font` that `createOutlineTextShaper` takes, so hosts
 * can pass either. Written from the OpenType specification (TrueType glyph outlines, the CFF
 * specification and the Type 2 charstring format), not ported.
 */

import type { OutlineFontFace, OutlinePathCommand } from './shapers';

/** A parsed font, usable as an `OutlineFontFace`. */
export interface OpenTypeFont extends OutlineFontFace {
  /** The family name (typographic family when the font has one). */
  readonly family: string;
  /** The subfamily ("Bold Italic"). */
  readonly style: string;
  readonly postScriptName: string;
  readonly weight: number;
  readonly italic: boolean;
  readonly numGlyphs: number;
  /** `glyf` (TrueType quadratic outlines) or `cff` (cubic). */
  readonly outlines: 'glyf' | 'cff';
  /** The glyph for a code point (0, `.notdef`, when the font lacks it). */
  glyphIndex(codePoint: number): number;
  /** A glyph's advance in font units. */
  advance(glyph: number): number;
  /** Kerning between two glyphs in font units (negative pulls them together). */
  kerning(left: number, right: number): number;
  /** A glyph's outline in font units, y up, origin on the baseline. */
  glyphPath(glyph: number): OutlinePathCommand[];
  /** Whether the font has vertical metrics (`vhea` and `vmtx`). */
  readonly hasVerticalMetrics: boolean;
  /** A glyph's vertical alternate (the `vert` feature), or the glyph itself when it has none. */
  verticalGlyph(glyph: number): number;
  getVerticalMetrics(char: string): { advance: number; originY: number; alternate: boolean };
}

const fail = (message: string): never => {
  throw new Error(message);
};

class Reader {
  constructor(
    readonly view: DataView,
    public pos = 0
  ) {}
  u8(): number {
    return this.view.getUint8(this.pos++);
  }
  i8(): number {
    return this.view.getInt8(this.pos++);
  }
  u16(): number {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }
  i16(): number {
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }
  tag(): string {
    let s = '';
    for (let i = 0; i < 4; i++) s += String.fromCharCode(this.u8());
    return s;
  }
}

interface Table {
  offset: number;
  length: number;
}

function tableDirectory(view: DataView, at: number): Map<string, Table> {
  const r = new Reader(view, at);
  const version = r.tag();
  if (version !== '\0\x01\0\0' && version !== 'OTTO' && version !== 'true') fail('This is not a TrueType or OpenType font (WOFF2 is not supported; convert it to TTF or OTF).');
  const count = r.u16();
  r.pos += 6;
  const tables = new Map<string, Table>();
  for (let i = 0; i < count; i++) {
    const tag = r.tag();
    r.u32();
    const offset = r.u32();
    const length = r.u32();
    if (offset + length > view.byteLength) fail(`The font's "${tag}" table runs past the end of the file.`);
    tables.set(tag, { offset, length });
  }
  return tables;
}

// ---------------------------------------------------------------------------
// cmap
// ---------------------------------------------------------------------------

function readCmap(view: DataView, t: Table): (cp: number) => number {
  const r = new Reader(view, t.offset);
  r.u16();
  const n = r.u16();
  const subtables: Array<{ platform: number; encoding: number; offset: number; format: number }> = [];
  for (let i = 0; i < n; i++) {
    const platform = r.u16();
    const encoding = r.u16();
    const offset = t.offset + r.u32();
    subtables.push({ platform, encoding, offset, format: view.getUint16(offset) });
  }
  const rank = (s: (typeof subtables)[number]) =>
    s.format === 12 && ((s.platform === 3 && s.encoding === 10) || s.platform === 0) ? 0 : s.format === 4 && ((s.platform === 3 && (s.encoding === 1 || s.encoding === 0)) || s.platform === 0) ? 1 : s.format === 12 || s.format === 4 ? 2 : 9;
  const best = subtables.filter((s) => rank(s) < 9).sort((a, b) => rank(a) - rank(b))[0];
  if (!best) return () => 0;
  const map = new Map<number, number>();
  const at = best.offset;
  if (best.format === 4) {
    const segX2 = view.getUint16(at + 6);
    const segs = segX2 / 2;
    const ends = at + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    return (cp) => {
      if (cp > 0xffff) return 0;
      let lo = 0;
      let hi = segs - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (view.getUint16(ends + mid * 2) < cp) lo = mid + 1;
        else hi = mid;
      }
      const start = view.getUint16(starts + lo * 2);
      if (cp < start || cp > view.getUint16(ends + lo * 2)) return 0;
      const delta = view.getInt16(deltas + lo * 2);
      const rangeAt = ranges + lo * 2;
      const range = view.getUint16(rangeAt);
      if (range === 0) return (cp + delta) & 0xffff;
      const g = view.getUint16(rangeAt + range + (cp - start) * 2);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    };
  }
  // Format 12: sequential map groups.
  const groups = view.getUint32(at + 12);
  for (let i = 0; i < groups && i < 200000; i++) {
    const g = at + 16 + i * 12;
    const start = view.getUint32(g);
    const end = view.getUint32(g + 4);
    const glyph = view.getUint32(g + 8);
    if (end - start > 0x10ffff) continue;
    map.set(start, glyph);
    for (let c = start + 1; c <= end; c++) map.set(c, glyph + c - start);
  }
  return (cp) => map.get(cp) ?? 0;
}

// ---------------------------------------------------------------------------
// name
// ---------------------------------------------------------------------------

function readNames(view: DataView, t: Table | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!t) return out;
  const r = new Reader(view, t.offset);
  r.u16();
  const count = r.u16();
  const strings = t.offset + r.u16();
  const ranked = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const platform = r.u16();
    const encoding = r.u16();
    const language = r.u16();
    const id = r.u16();
    const length = r.u16();
    const offset = r.u16();
    let rank: number;
    let text = '';
    if (platform === 3 && (encoding === 1 || encoding === 10)) {
      rank = language === 0x409 ? 0 : 2;
      for (let k = 0; k + 1 < length; k += 2) text += String.fromCharCode(view.getUint16(strings + offset + k));
    } else if (platform === 1 && encoding === 0) {
      rank = language === 0 ? 1 : 3;
      for (let k = 0; k < length; k++) text += String.fromCharCode(view.getUint8(strings + offset + k));
    } else if (platform === 0) {
      rank = 2;
      for (let k = 0; k + 1 < length; k += 2) text += String.fromCharCode(view.getUint16(strings + offset + k));
    } else continue;
    if (!text || (ranked.get(id) ?? 9) <= rank) continue;
    ranked.set(id, rank);
    out.set(id, text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// glyf
// ---------------------------------------------------------------------------

type Pt = { x: number; y: number; on: boolean };

function glyfOutlines(view: DataView, glyf: Table, loca: Table, longLoca: boolean, numGlyphs: number): (g: number) => OutlinePathCommand[] {
  const offsetOf = (g: number) => (longLoca ? view.getUint32(loca.offset + g * 4) : view.getUint16(loca.offset + g * 2) * 2);
  const contoursOf = (g: number, depth: number): Pt[][] => {
    if (g < 0 || g >= numGlyphs || depth > 8) return [];
    const start = offsetOf(g);
    const end = offsetOf(g + 1);
    if (end <= start) return [];
    const r = new Reader(view, glyf.offset + start);
    const n = r.i16();
    r.pos += 8;
    if (n >= 0) {
      const ends: number[] = [];
      for (let i = 0; i < n; i++) ends.push(r.u16());
      const count = n ? ends[n - 1] + 1 : 0;
      const instructions = r.u16();
      r.pos += instructions;
      const flags: number[] = [];
      while (flags.length < count) {
        const f = r.u8();
        flags.push(f);
        if (f & 8) for (let k = r.u8(); k > 0; k--) flags.push(f);
      }
      const xs: number[] = [];
      let v = 0;
      for (const f of flags) {
        if (f & 2) v += f & 16 ? r.u8() : -r.u8();
        else if (!(f & 16)) v += r.i16();
        xs.push(v);
      }
      const ys: number[] = [];
      v = 0;
      for (const f of flags) {
        if (f & 4) v += f & 32 ? r.u8() : -r.u8();
        else if (!(f & 32)) v += r.i16();
        ys.push(v);
      }
      const out: Pt[][] = [];
      let s = 0;
      for (const e of ends) {
        const c: Pt[] = [];
        for (let i = s; i <= e && i < count; i++) c.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
        out.push(c);
        s = e + 1;
      }
      return out;
    }
    // Composite: components placed by offsets (point matching is not supported) and scaled.
    const out: Pt[][] = [];
    for (;;) {
      const flags = r.u16();
      const glyph = r.u16();
      let dx: number;
      let dy: number;
      if (flags & 1) {
        dx = flags & 2 ? r.i16() : r.u16();
        dy = flags & 2 ? r.i16() : r.u16();
      } else {
        dx = flags & 2 ? r.i8() : r.u8();
        dy = flags & 2 ? r.i8() : r.u8();
      }
      if (!(flags & 2)) dx = dy = 0;
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      const f2 = () => r.i16() / 16384;
      if (flags & 8) a = d = f2();
      else if (flags & 0x40) {
        a = f2();
        d = f2();
      } else if (flags & 0x80) {
        a = f2();
        b = f2();
        c = f2();
        d = f2();
      }
      for (const contour of contoursOf(glyph, depth + 1)) out.push(contour.map((p) => ({ x: a * p.x + c * p.y + dx, y: b * p.x + d * p.y + dy, on: p.on })));
      if (!(flags & 0x20)) break;
    }
    return out;
  };
  return (g) => {
    const cmds: OutlinePathCommand[] = [];
    for (const c of contoursOf(g, 0)) {
      if (!c.length) continue;
      // Start on an on-curve point (or the midpoint of the first two off-curve points).
      let first = c.findIndex((p) => p.on);
      let pts = c;
      if (first < 0) {
        const m = { x: (c[0].x + c[1 % c.length].x) / 2, y: (c[0].y + c[1 % c.length].y) / 2, on: true };
        pts = [m, ...c.slice(1), c[0]];
        first = 0;
      } else pts = [...c.slice(first), ...c.slice(0, first)];
      const start = pts[0];
      cmds.push({ type: 'M', x: start.x, y: start.y });
      let ctrl: Pt | null = null;
      for (let i = 1; i <= pts.length; i++) {
        const p = i === pts.length ? start : pts[i];
        if (p.on) {
          if (ctrl) cmds.push({ type: 'Q', x1: ctrl.x, y1: ctrl.y, x: p.x, y: p.y });
          else if (i < pts.length) cmds.push({ type: 'L', x: p.x, y: p.y });
          ctrl = null;
        } else {
          if (ctrl) cmds.push({ type: 'Q', x1: ctrl.x, y1: ctrl.y, x: (ctrl.x + p.x) / 2, y: (ctrl.y + p.y) / 2 });
          ctrl = p;
        }
      }
      cmds.push({ type: 'Z' });
    }
    return cmds;
  };
}

// ---------------------------------------------------------------------------
// CFF
// ---------------------------------------------------------------------------

/** Offsets of an INDEX's items and where it ends. */
function cffIndex(view: DataView, at: number): { items: Array<[number, number]>; end: number } {
  const count = view.getUint16(at);
  if (count === 0) return { items: [], end: at + 2 };
  const size = view.getUint8(at + 2);
  const read = (i: number) => {
    let v = 0;
    for (let k = 0; k < size; k++) v = v * 256 + view.getUint8(at + 3 + i * size + k);
    return v;
  };
  const base = at + 2 + (count + 1) * size;
  const items: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) items.push([base + read(i), base + read(i + 1)]);
  return { items, end: base + read(count) };
}

/** A DICT's operators with their operands (two-byte operators as 1200 + b). */
function cffDict(view: DataView, start: number, end: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let ops: number[] = [];
  let p = start;
  while (p < end) {
    const b = view.getUint8(p++);
    if (b <= 21) {
      const op = b === 12 ? 1200 + view.getUint8(p++) : b;
      out.set(op, ops);
      ops = [];
    } else if (b === 28) {
      ops.push(view.getInt16(p));
      p += 2;
    } else if (b === 29) {
      ops.push(view.getInt32(p));
      p += 4;
    } else if (b === 30) {
      let s = '';
      const nib = '0123456789.EE?-';
      for (;;) {
        const v = view.getUint8(p++);
        const hi = v >> 4;
        const lo = v & 15;
        if (hi === 15) break;
        s += hi === 12 ? 'E-' : nib[hi];
        if (lo === 15) break;
        s += lo === 12 ? 'E-' : nib[lo];
      }
      ops.push(parseFloat(s));
    } else if (b >= 32 && b <= 246) ops.push(b - 139);
    else if (b >= 247 && b <= 250) ops.push((b - 247) * 256 + view.getUint8(p++) + 108);
    else if (b >= 251 && b <= 254) ops.push(-(b - 251) * 256 - view.getUint8(p++) - 108);
    else break;
  }
  return out;
}

const subrBias = (n: number) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

interface CffPrivate {
  subrs: Array<[number, number]>;
  defaultWidth: number;
  nominalWidth: number;
}

function cffOutlines(view: DataView, t: Table, numGlyphs: number): { path: (g: number) => OutlinePathCommand[]; width: (g: number) => number | null } {
  const base = t.offset;
  const hdrSize = view.getUint8(base + 2);
  const names = cffIndex(view, base + hdrSize);
  const tops = cffIndex(view, names.end);
  const strings = cffIndex(view, tops.end);
  const gsubrs = cffIndex(view, strings.end).items;
  if (!tops.items.length) fail('The font\'s CFF table has no Top DICT.');
  const top = cffDict(view, tops.items[0][0], tops.items[0][1]);
  const charStrings = cffIndex(view, base + (top.get(17)?.[0] ?? fail('The font\'s CFF table has no CharStrings.'))).items;
  const privateOf = (dict: Map<number, number[]>): CffPrivate => {
    const pv = dict.get(18);
    if (!pv || pv.length < 2) return { subrs: [], defaultWidth: 0, nominalWidth: 0 };
    const [size, off] = pv;
    const priv = cffDict(view, base + off, base + off + size);
    const subrsOff = priv.get(19)?.[0];
    return {
      subrs: subrsOff !== undefined ? cffIndex(view, base + off + subrsOff).items : [],
      defaultWidth: priv.get(20)?.[0] ?? 0,
      nominalWidth: priv.get(21)?.[0] ?? 0,
    };
  };
  // CID-keyed fonts pick a private dict per glyph through FDSelect.
  let fdFor: (g: number) => CffPrivate;
  const fdArrayOff = top.get(1236)?.[0];
  const fdSelectOff = top.get(1237)?.[0];
  if (fdArrayOff !== undefined && fdSelectOff !== undefined) {
    const fds = cffIndex(view, base + fdArrayOff).items.map(([a, b]) => privateOf(cffDict(view, a, b)));
    const sel = base + fdSelectOff;
    const format = view.getUint8(sel);
    if (format === 0) fdFor = (g) => fds[view.getUint8(sel + 1 + g)] ?? fds[0];
    else {
      const ranges = view.getUint16(sel + 1);
      fdFor = (g) => {
        for (let i = 0; i < ranges; i++) {
          const first = view.getUint16(sel + 3 + i * 3);
          const next = view.getUint16(sel + 3 + (i + 1) * 3);
          if (g >= first && g < next) return fds[view.getUint8(sel + 5 + i * 3)] ?? fds[0];
        }
        return fds[0];
      };
    }
  } else {
    const p = privateOf(top);
    fdFor = () => p;
  }
  const widths = new Map<number, number | null>();
  const run = (g: number): OutlinePathCommand[] => {
    const priv = fdFor(g);
    const cmds: OutlinePathCommand[] = [];
    const stack: number[] = [];
    let x = 0;
    let y = 0;
    let stems = 0;
    let open = false;
    let width: number | null = null;
    let haveWidth = false;
    let done = false;
    const moveTo = (nx: number, ny: number) => {
      if (open) cmds.push({ type: 'Z' });
      x = nx;
      y = ny;
      cmds.push({ type: 'M', x, y });
      open = true;
    };
    const lineTo = (nx: number, ny: number) => {
      x = nx;
      y = ny;
      cmds.push({ type: 'L', x, y });
    };
    const curveTo = (x1: number, y1: number, x2: number, y2: number, nx: number, ny: number) => {
      x = nx;
      y = ny;
      cmds.push({ type: 'C', x1, y1, x2, y2, x, y });
    };
    // The first stack-clearing operator may carry the advance first: stem hints, rmoveto and
    // endchar take an even number of arguments, so an odd count means a width.
    const takeWidth = () => {
      if (haveWidth) return;
      haveWidth = true;
      if (stack.length % 2 === 1) width = priv.nominalWidth + (stack.shift() as number);
    };
    const exec = (start: number, end: number, depth: number) => {
      let p = start;
      while (p < end && !done) {
        const b = view.getUint8(p++);
        if (b >= 32 || b === 28) {
          if (b === 28) {
            stack.push(view.getInt16(p));
            p += 2;
          } else if (b <= 246) stack.push(b - 139);
          else if (b <= 250) stack.push((b - 247) * 256 + view.getUint8(p++) + 108);
          else if (b <= 254) stack.push(-(b - 251) * 256 - view.getUint8(p++) - 108);
          else {
            stack.push(view.getInt32(p) / 65536);
            p += 4;
          }
          continue;
        }
        switch (b) {
          case 1:
          case 3:
          case 18:
          case 23:
            takeWidth();
            stems += stack.length >> 1;
            stack.length = 0;
            break;
          case 19:
          case 20:
            takeWidth();
            stems += stack.length >> 1;
            stack.length = 0;
            p += (stems + 7) >> 3;
            break;
          case 21:
            takeWidth();
            moveTo(x + stack[0], y + stack[1]);
            stack.length = 0;
            break;
          case 22:
            if (!haveWidth) {
              haveWidth = true;
              if (stack.length > 1) width = priv.nominalWidth + (stack.shift() as number);
            }
            moveTo(x + stack[0], y);
            stack.length = 0;
            break;
          case 4:
            if (!haveWidth) {
              haveWidth = true;
              if (stack.length > 1) width = priv.nominalWidth + (stack.shift() as number);
            }
            moveTo(x, y + stack[0]);
            stack.length = 0;
            break;
          case 5:
            for (let i = 0; i + 1 < stack.length; i += 2) lineTo(x + stack[i], y + stack[i + 1]);
            stack.length = 0;
            break;
          case 6:
          case 7: {
            let horizontal = b === 6;
            for (const v of stack) {
              if (horizontal) lineTo(x + v, y);
              else lineTo(x, y + v);
              horizontal = !horizontal;
            }
            stack.length = 0;
            break;
          }
          case 8:
            for (let i = 0; i + 5 < stack.length; i += 6) curveTo(x + stack[i], y + stack[i + 1], x + stack[i] + stack[i + 2], y + stack[i + 1] + stack[i + 3], x + stack[i] + stack[i + 2] + stack[i + 4], y + stack[i + 1] + stack[i + 3] + stack[i + 5]);
            stack.length = 0;
            break;
          case 24: {
            let i = 0;
            for (; i + 7 < stack.length; i += 6) curveTo(x + stack[i], y + stack[i + 1], x + stack[i] + stack[i + 2], y + stack[i + 1] + stack[i + 3], x + stack[i] + stack[i + 2] + stack[i + 4], y + stack[i + 1] + stack[i + 3] + stack[i + 5]);
            lineTo(x + stack[i], y + stack[i + 1]);
            stack.length = 0;
            break;
          }
          case 25: {
            let i = 0;
            for (; i + 7 < stack.length; i += 2) lineTo(x + stack[i], y + stack[i + 1]);
            curveTo(x + stack[i], y + stack[i + 1], x + stack[i] + stack[i + 2], y + stack[i + 1] + stack[i + 3], x + stack[i] + stack[i + 2] + stack[i + 4], y + stack[i + 1] + stack[i + 3] + stack[i + 5]);
            stack.length = 0;
            break;
          }
          case 26: {
            let i = 0;
            let dx = 0;
            if (stack.length % 2) dx = stack[i++];
            for (; i + 3 < stack.length; i += 4) {
              const x1 = x + dx;
              const y1 = y + stack[i];
              curveTo(x1, y1, x1 + stack[i + 1], y1 + stack[i + 2], x1 + stack[i + 1], y1 + stack[i + 2] + stack[i + 3]);
              dx = 0;
            }
            stack.length = 0;
            break;
          }
          case 27: {
            let i = 0;
            let dy = 0;
            if (stack.length % 2) dy = stack[i++];
            for (; i + 3 < stack.length; i += 4) {
              const x1 = x + stack[i];
              const y1 = y + dy;
              curveTo(x1, y1, x1 + stack[i + 1], y1 + stack[i + 2], x1 + stack[i + 1] + stack[i + 3], y1 + stack[i + 2]);
              dy = 0;
            }
            stack.length = 0;
            break;
          }
          case 30:
          case 31: {
            let horizontal = b === 31;
            let i = 0;
            while (i + 3 < stack.length) {
              const last = stack.length - i === 5;
              if (horizontal) {
                const x1 = x + stack[i];
                const y1 = y;
                const x2 = x1 + stack[i + 1];
                const y2 = y1 + stack[i + 2];
                const y3 = y2 + stack[i + 3];
                curveTo(x1, y1, x2, y2, last ? x2 + stack[i + 4] : x2, y3);
              } else {
                const x1 = x;
                const y1 = y + stack[i];
                const x2 = x1 + stack[i + 1];
                const y2 = y1 + stack[i + 2];
                const x3 = x2 + stack[i + 3];
                curveTo(x1, y1, x2, y2, x3, last ? y2 + stack[i + 4] : y2);
              }
              i += last ? 5 : 4;
              horizontal = !horizontal;
            }
            stack.length = 0;
            break;
          }
          case 10:
          case 29: {
            const list = b === 10 ? priv.subrs : gsubrs;
            const idx = (stack.pop() as number) + subrBias(list.length);
            const sub = list[idx];
            if (sub && depth < 10) exec(sub[0], sub[1], depth + 1);
            break;
          }
          case 11:
            return;
          case 14:
            takeWidth();
            if (open) cmds.push({ type: 'Z' });
            open = false;
            done = true;
            stack.length = 0;
            return;
          case 12: {
            const op = view.getUint8(p++);
            const s = stack;
            if (op === 35 && s.length >= 13) {
              curveTo(x + s[0], y + s[1], x + s[0] + s[2], y + s[1] + s[3], x + s[0] + s[2] + s[4], y + s[1] + s[3] + s[5]);
              curveTo(x + s[6], y + s[7], x + s[6] + s[8], y + s[7] + s[9], x + s[6] + s[8] + s[10], y + s[7] + s[9] + s[11]);
            } else if (op === 34 && s.length >= 7) {
              const y0 = y;
              curveTo(x + s[0], y, x + s[0] + s[1], y + s[2], x + s[0] + s[1] + s[3], y + s[2]);
              curveTo(x + s[4], y, x + s[4] + s[5], y0, x + s[4] + s[5] + s[6], y0);
            } else if (op === 36 && s.length >= 9) {
              const y0 = y;
              curveTo(x + s[0], y + s[1], x + s[0] + s[2], y + s[1] + s[3], x + s[0] + s[2] + s[4], y + s[1] + s[3]);
              curveTo(x + s[5], y, x + s[5] + s[6], y + s[7], x + s[5] + s[6] + s[8], y0);
            } else if (op === 37 && s.length >= 11) {
              const x0 = x;
              const y0 = y;
              const x1 = x + s[0];
              const y1 = y + s[1];
              const x2 = x1 + s[2];
              const y2 = y1 + s[3];
              const x3 = x2 + s[4];
              const y3 = y2 + s[5];
              const x4 = x3 + s[6];
              const y4 = y3 + s[7];
              const x5 = x4 + s[8];
              const y5 = y4 + s[9];
              curveTo(x1, y1, x2, y2, x3, y3);
              if (Math.abs(x5 - x0) > Math.abs(y5 - y0)) curveTo(x4, y4, x5, y5, x5 + s[10], y0);
              else curveTo(x4, y4, x5, y5, x0, y5 + s[10]);
            }
            stack.length = 0;
            break;
          }
          default:
            stack.length = 0;
        }
      }
    };
    const cs = charStrings[g];
    if (cs) exec(cs[0], cs[1], 0);
    if (open) cmds.push({ type: 'Z' });
    widths.set(g, width ?? (haveWidth ? priv.defaultWidth : null));
    return cmds;
  };
  return {
    path: (g) => (g >= 0 && g < numGlyphs ? run(g) : []),
    width: (g) => {
      if (!widths.has(g)) run(g);
      return widths.get(g) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Kerning
// ---------------------------------------------------------------------------

function readKern(view: DataView, t: Table | undefined): Map<number, number> {
  const out = new Map<number, number>();
  if (!t) return out;
  const r = new Reader(view, t.offset);
  const version = r.u16();
  if (version !== 0) return out;
  const n = r.u16();
  for (let i = 0; i < n; i++) {
    const start = r.pos;
    r.u16();
    const length = r.u16();
    const coverage = r.u16();
    if (coverage >> 8 === 0 && (coverage & 1) === 1) {
      const pairs = r.u16();
      r.pos += 6;
      for (let k = 0; k < pairs; k++) {
        const left = r.u16();
        const right = r.u16();
        out.set(left * 65536 + right, r.i16());
      }
    }
    r.pos = start + length;
  }
  return out;
}

function coverageIndex(view: DataView, at: number, g: number): number {
  const format = view.getUint16(at);
  const n = view.getUint16(at + 2);
  if (format === 1) {
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = view.getUint16(at + 4 + mid * 2);
      if (v === g) return mid;
      if (v < g) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
  for (let i = 0; i < n; i++) {
    const r = at + 4 + i * 6;
    const s = view.getUint16(r);
    const e = view.getUint16(r + 2);
    if (g >= s && g <= e) return view.getUint16(r + 4) + g - s;
  }
  return -1;
}

function classOf(view: DataView, at: number, g: number): number {
  const format = view.getUint16(at);
  if (format === 1) {
    const start = view.getUint16(at + 2);
    const n = view.getUint16(at + 4);
    return g >= start && g < start + n ? view.getUint16(at + 6 + (g - start) * 2) : 0;
  }
  const n = view.getUint16(at + 2);
  for (let i = 0; i < n; i++) {
    const r = at + 4 + i * 6;
    if (g >= view.getUint16(r) && g <= view.getUint16(r + 2)) return view.getUint16(r + 4);
  }
  return 0;
}

const valueSize = (format: number) => {
  let n = 0;
  for (let f = format; f; f >>= 1) n += f & 1;
  return n * 2;
};

/** X advance adjustment of the first value record of a pair (`valueFormat` bit 4 is XAdvance). */
function xAdvance(view: DataView, at: number, format: number): number {
  if (!(format & 4)) return 0;
  let skip = 0;
  if (format & 1) skip += 2;
  if (format & 2) skip += 2;
  return view.getInt16(at + skip);
}

function gposKerning(view: DataView, t: Table | undefined): ((a: number, b: number) => number) | null {
  if (!t) return null;
  const base = t.offset;
  const scripts = base + view.getUint16(base + 4);
  const features = base + view.getUint16(base + 6);
  const lookups = base + view.getUint16(base + 8);
  void scripts;
  const lookupIds = new Set<number>();
  const nf = view.getUint16(features);
  for (let i = 0; i < nf; i++) {
    const rec = features + 2 + i * 6;
    let tag = '';
    for (let k = 0; k < 4; k++) tag += String.fromCharCode(view.getUint8(rec + k));
    if (tag !== 'kern') continue;
    const f = features + view.getUint16(rec + 4);
    const n = view.getUint16(f + 2);
    for (let k = 0; k < n; k++) lookupIds.add(view.getUint16(f + 4 + k * 2));
  }
  const subtables: number[] = [];
  const nl = view.getUint16(lookups);
  for (const id of [...lookupIds].sort((a, b) => a - b)) {
    if (id >= nl) continue;
    const l = lookups + view.getUint16(lookups + 2 + id * 2);
    let type = view.getUint16(l);
    const n = view.getUint16(l + 4);
    for (let k = 0; k < n; k++) {
      let st = l + view.getUint16(l + 6 + k * 2);
      if (type === 9) {
        type = view.getUint16(st + 2);
        st = st + view.getUint32(st + 4);
      }
      if (type === 2) subtables.push(st);
      type = view.getUint16(l);
    }
  }
  if (!subtables.length) return null;
  return (a, b) => {
    for (const st of subtables) {
      const format = view.getUint16(st);
      const ci = coverageIndex(view, st + view.getUint16(st + 2), a);
      if (ci < 0) continue;
      const vf1 = view.getUint16(st + 4);
      const vf2 = view.getUint16(st + 6);
      const recSize = valueSize(vf1) + valueSize(vf2);
      if (format === 1) {
        const set = st + view.getUint16(st + 10 + ci * 2);
        const n = view.getUint16(set);
        let lo = 0;
        let hi = n - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const rec = set + 2 + mid * (2 + recSize);
          const g = view.getUint16(rec);
          if (g === b) return xAdvance(view, rec + 2, vf1);
          if (g < b) lo = mid + 1;
          else hi = mid - 1;
        }
      } else if (format === 2) {
        const c1 = classOf(view, st + view.getUint16(st + 8), a);
        const c2 = classOf(view, st + view.getUint16(st + 10), b);
        const n2 = view.getUint16(st + 14);
        const rec = st + 16 + (c1 * n2 + c2) * recSize;
        const v = xAdvance(view, rec, vf1);
        if (v) return v;
      }
    }
    return 0;
  };
}

/** Every glyph a coverage table lists, in coverage order. */
function coverageGlyphs(view: DataView, at: number): number[] {
  const format = view.getUint16(at);
  const n = view.getUint16(at + 2);
  const out: number[] = [];
  if (format === 1) for (let i = 0; i < n; i++) out.push(view.getUint16(at + 4 + i * 2));
  else if (format === 2)
    for (let i = 0; i < n; i++) {
      const r = at + 4 + i * 6;
      for (let g = view.getUint16(r); g <= view.getUint16(r + 2); g++) out.push(g);
    }
  return out;
}

/** Vertical alternates: the single substitutions (lookup type 1) of `GSUB`'s `vert` feature. */
function gsubVertical(view: DataView, t: Table | undefined): Map<number, number> {
  const out = new Map<number, number>();
  if (!t || t.length < 10) return out;
  const base = t.offset;
  const features = base + view.getUint16(base + 6);
  const lookups = base + view.getUint16(base + 8);
  const ids = new Set<number>();
  const nf = view.getUint16(features);
  for (let i = 0; i < nf; i++) {
    const rec = features + 2 + i * 6;
    let tag = '';
    for (let k = 0; k < 4; k++) tag += String.fromCharCode(view.getUint8(rec + k));
    if (tag !== 'vert') continue;
    const f = features + view.getUint16(rec + 4);
    const n = view.getUint16(f + 2);
    for (let k = 0; k < n; k++) ids.add(view.getUint16(f + 4 + k * 2));
  }
  const nl = view.getUint16(lookups);
  for (const id of [...ids].sort((a, b) => a - b)) {
    if (id >= nl) continue;
    const l = lookups + view.getUint16(lookups + 2 + id * 2);
    const n = view.getUint16(l + 4);
    for (let k = 0; k < n; k++) {
      let type = view.getUint16(l);
      let st = l + view.getUint16(l + 6 + k * 2);
      if (type === 7) {
        type = view.getUint16(st + 2);
        st = st + view.getUint32(st + 4);
      }
      if (type !== 1) continue;
      const format = view.getUint16(st);
      const glyphs = coverageGlyphs(view, st + view.getUint16(st + 2));
      glyphs.forEach((g, i) => {
        if (out.has(g)) return;
        if (format === 1) out.set(g, (g + view.getInt16(st + 4) + 65536) % 65536);
        else if (format === 2 && i < view.getUint16(st + 4)) out.set(g, view.getUint16(st + 6 + i * 2));
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Font
// ---------------------------------------------------------------------------

const toView = (data: ArrayBuffer | ArrayBufferView): DataView =>
  data instanceof ArrayBuffer ? new DataView(data) : new DataView(data.buffer, data.byteOffset, data.byteLength);

/**
 * Reads a TrueType or OpenType font (`.ttf`, `.otf`, or face `index` of a `.ttc` collection).
 * Throws with the reason when the file is not one, or lacks the tables layout needs. For WOFF files
 * use `loadOpenTypeFont`.
 */
export function parseOpenTypeFont(data: ArrayBuffer | ArrayBufferView, options: { index?: number } = {}): OpenTypeFont {
  const view = toView(data);
  if (view.byteLength < 12) fail('The font file is too short.');
  let at = 0;
  if (view.getUint32(0) === 0x74746366) {
    const n = view.getUint32(8);
    const index = options.index ?? 0;
    if (index < 0 || index >= n) fail(`The collection has ${n} faces; index ${index} is out of range.`);
    at = view.getUint32(12 + index * 4);
  }
  const tables = tableDirectory(view, at);
  const need = (tag: string) => tables.get(tag) ?? fail(`The font has no "${tag}" table.`);
  const head = need('head');
  const unitsPerEm = view.getUint16(head.offset + 18) || 1000;
  const longLoca = view.getInt16(head.offset + 50) === 1;
  const macStyle = view.getUint16(head.offset + 44);
  const hhea = need('hhea');
  let ascender = view.getInt16(hhea.offset + 4);
  let descender = view.getInt16(hhea.offset + 6);
  const numHMetrics = view.getUint16(hhea.offset + 34);
  const numGlyphs = view.getUint16(need('maxp').offset + 4);
  const hmtx = need('hmtx');
  const os2 = tables.get('OS/2');
  let weight = macStyle & 1 ? 700 : 400;
  let fsSelection = macStyle & 2 ? 1 : 0;
  if (os2 && os2.length >= 78) {
    weight = view.getUint16(os2.offset + 4) || weight;
    fsSelection = view.getUint16(os2.offset + 62);
    // USE_TYPO_METRICS: the typographic ascender and descender are the ones to use.
    if (fsSelection & 128) {
      ascender = view.getInt16(os2.offset + 68);
      descender = view.getInt16(os2.offset + 70);
    }
  }
  if (!ascender && !descender) {
    ascender = Math.round(unitsPerEm * 0.8);
    descender = -Math.round(unitsPerEm * 0.2);
  }
  const names = readNames(view, tables.get('name'));
  const family = names.get(16) ?? names.get(1) ?? 'Font';
  const style = names.get(17) ?? names.get(2) ?? 'Regular';
  const postScriptName = names.get(6) ?? family.replace(/\s+/g, '');
  const italic = Boolean(fsSelection & 1) || /italic|oblique/i.test(style);
  const cmap = readCmap(view, need('cmap'));
  const glyf = tables.get('glyf');
  const cff = tables.get('CFF ');
  let pathOf: (g: number) => OutlinePathCommand[];
  let cffWidth: ((g: number) => number | null) | null = null;
  let outlines: 'glyf' | 'cff';
  if (glyf) {
    pathOf = glyfOutlines(view, glyf, need('loca'), longLoca, numGlyphs);
    outlines = 'glyf';
  } else if (cff) {
    const c = cffOutlines(view, cff, numGlyphs);
    pathOf = c.path;
    cffWidth = c.width;
    outlines = 'cff';
  } else return fail('The font has neither TrueType ("glyf") nor CFF outlines (CFF2 and bitmap fonts are not supported).');
  const advance = (g: number) => {
    if (g < 0 || g >= numGlyphs) return 0;
    const i = Math.min(g, numHMetrics - 1);
    if (i >= 0 && hmtx.offset + i * 4 + 2 <= hmtx.offset + hmtx.length) return view.getUint16(hmtx.offset + i * 4);
    return cffWidth?.(g) ?? 0;
  };
  const vhea = tables.get('vhea');
  const vmtx = tables.get('vmtx');
  const numVMetrics = vhea && vhea.length >= 36 ? view.getUint16(vhea.offset + 34) : 0;
  const hasVerticalMetrics = Boolean(vmtx && numVMetrics > 0);
  const vorg = tables.get('VORG');
  const vertSub = gsubVertical(view, tables.get('GSUB'));
  const kernPairs = readKern(view, tables.get('kern'));
  const gpos = gposKerning(view, tables.get('GPOS'));
  const kerning = (a: number, b: number) => (gpos ? gpos(a, b) : 0) || kernPairs.get(a * 65536 + b) || 0;
  const glyphIndex = (cp: number) => cmap(cp);
  const pathCache = new Map<number, OutlinePathCommand[]>();
  const glyphPath = (g: number) => {
    let p = pathCache.get(g);
    if (!p) {
      p = pathOf(g);
      if (pathCache.size > 4096) pathCache.clear();
      pathCache.set(g, p);
    }
    return p;
  };
  const verticalGlyph = (g: number) => vertSub.get(g) ?? g;
  // Vertical metrics (OpenType's vertical origin): `vmtx` gives the advance and top side bearing,
  // the origin is the glyph's top plus that bearing (`VORG` gives it directly for CFF fonts);
  // without them, the advance is ascender − descender and the origin the ascender.
  const vertOrigin = (g: number): number => {
    if (vorg && vorg.length >= 8) {
      const n = view.getUint16(vorg.offset + 6);
      let lo = 0;
      let hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const at = vorg.offset + 8 + mid * 4;
        const v = view.getUint16(at);
        if (v === g) return view.getInt16(at + 2);
        if (v < g) lo = mid + 1;
        else hi = mid - 1;
      }
      return view.getInt16(vorg.offset + 4);
    }
    if (!hasVerticalMetrics) return ascender;
    const tsb = g < numVMetrics ? view.getInt16(vmtx!.offset + g * 4 + 2) : view.getInt16(vmtx!.offset + numVMetrics * 4 + (g - numVMetrics) * 2);
    let top = -Infinity;
    for (const c of glyphPath(g)) for (const v of [c.y, c.y1, c.y2]) if (v !== undefined && v > top) top = v;
    return Number.isFinite(top) ? top + tsb : ascender;
  };
  const verticalAdvance = (g: number): number => {
    if (!hasVerticalMetrics || g < 0 || g >= numGlyphs) return ascender - descender;
    return view.getUint16(vmtx!.offset + Math.min(g, numVMetrics - 1) * 4);
  };
  const glyphs = (text: string, vertical = false) => {
    const out: number[] = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      // Lone surrogates (a caret inside a pair) and line breaks draw nothing.
      if ((cp >= 0xd800 && cp <= 0xdfff) || cp === 10 || cp === 13) continue;
      out.push(vertical ? verticalGlyph(glyphIndex(cp)) : glyphIndex(cp));
    }
    return out;
  };
  const layout = (text: string, kern: boolean, vertical = false) => {
    const gs = glyphs(text, vertical);
    const xs: number[] = [];
    let x = 0;
    for (let i = 0; i < gs.length; i++) {
      if (i > 0 && kern) x += kerning(gs[i - 1], gs[i]);
      xs.push(x);
      x += advance(gs[i]);
    }
    return { gs, xs, width: x };
  };
  return {
    family,
    style,
    postScriptName,
    weight,
    italic,
    numGlyphs,
    outlines,
    unitsPerEm,
    ascender,
    descender,
    names: { fontFamily: { en: family }, postScriptName: { en: postScriptName } },
    tables: { os2: { usWeightClass: weight, fsSelection: italic ? fsSelection | 1 : fsSelection } },
    glyphIndex,
    advance,
    kerning,
    glyphPath,
    hasVerticalMetrics,
    verticalGlyph,
    getVerticalMetrics(char) {
      const g = glyphIndex(char.codePointAt(0) ?? 0);
      const v = verticalGlyph(g);
      return { advance: verticalAdvance(v), originY: vertOrigin(v), alternate: v !== g };
    },
    getAdvanceWidth(text, fontSize, opts) {
      return (layout(text, opts?.kerning !== false).width * fontSize) / unitsPerEm;
    },
    getPath(text, x, y, fontSize, opts) {
      const k = fontSize / unitsPerEm;
      const { gs, xs } = layout(text, opts?.kerning !== false, Boolean(opts?.vertical));
      const commands: OutlinePathCommand[] = [];
      gs.forEach((g, i) => {
        const ox = x + xs[i] * k;
        for (const c of glyphPath(g)) {
          if (c.type === 'Z') commands.push({ type: 'Z' });
          else {
            const m: OutlinePathCommand = { type: c.type, x: ox + c.x! * k, y: y - c.y! * k };
            if (c.x1 !== undefined) {
              m.x1 = ox + c.x1 * k;
              m.y1 = y - c.y1! * k;
            }
            if (c.x2 !== undefined) {
              m.x2 = ox + c.x2 * k;
              m.y2 = y - c.y2! * k;
            }
            commands.push(m);
          }
        }
      });
      return { commands };
    },
  };
}

/**
 * Reads a font file: TrueType, OpenType, a collection (`index`) or WOFF 1.0 (decompressed with the
 * platform's `DecompressionStream`). WOFF2 needs Brotli, which browsers do not expose, so it is
 * refused with a hint.
 */
export async function loadOpenTypeFont(data: ArrayBuffer | ArrayBufferView | Blob, options: { index?: number } = {}): Promise<OpenTypeFont> {
  const buffer = typeof Blob !== 'undefined' && data instanceof Blob ? await data.arrayBuffer() : (data as ArrayBuffer | ArrayBufferView);
  const view = toView(buffer);
  const sig = view.byteLength >= 4 ? view.getUint32(0) : 0;
  if (sig === 0x774f4632) fail('WOFF2 fonts are not supported (they need Brotli); use the TTF, OTF or WOFF file.');
  if (sig !== 0x774f4646) return parseOpenTypeFont(view, options);
  return parseOpenTypeFont(await unwoff(view), options);
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') fail('Reading WOFF fonts needs DecompressionStream, which this platform lacks; use the TTF or OTF file.');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A WOFF 1.0 file rebuilt as an SFNT. */
async function unwoff(view: DataView): Promise<DataView> {
  const r = new Reader(view, 4);
  const flavor = r.u32();
  r.u32();
  const n = r.u16();
  r.u16();
  const total = r.u32();
  const out = new Uint8Array(total);
  const o = new DataView(out.buffer);
  o.setUint32(0, flavor);
  o.setUint16(4, n);
  let pos = 12 + n * 16;
  for (let i = 0; i < n; i++) {
    const e = 44 + i * 20;
    const tag = view.getUint32(e);
    const offset = view.getUint32(e + 4);
    const comp = view.getUint32(e + 8);
    const orig = view.getUint32(e + 12);
    const checksum = view.getUint32(e + 16);
    const raw = new Uint8Array(view.buffer, view.byteOffset + offset, comp);
    const bytes = comp < orig ? await inflate(raw) : raw;
    out.set(bytes.subarray(0, orig), pos);
    const d = 12 + i * 16;
    o.setUint32(d, tag);
    o.setUint32(d + 4, checksum);
    o.setUint32(d + 8, pos);
    o.setUint32(d + 12, orig);
    pos += (orig + 3) & ~3;
  }
  return o;
}
