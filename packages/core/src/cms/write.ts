// Portions ported from photocraft/crates/cms/src/write.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/** Encodes a profile model as ICC v4.3 bytes (matrix/TRC, grey TRC, `mft1` / `mft2` / `mAB ` / `mBA ` LUTs). */

import type { Clut } from './clut';
import { paramCount, sampleCurve, type Curve } from './curve';
import { D50 } from './math';
import type { Stage } from './pipeline';
import { classSig, intentCode, spaceSig, type Profile } from './profile';

class Bytes {
  private buf = new Uint8Array(1024);
  length = 0;
  private grow(n: number) {
    if (this.length + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  u8(...v: number[]) {
    this.grow(v.length);
    for (const x of v) this.buf[this.length++] = x & 255;
  }
  u16(v: number) {
    this.u8(v >> 8, v);
  }
  u32(v: number) {
    this.u8(v >>> 24, v >>> 16, v >>> 8, v);
  }
  ascii(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
  }
  s15(v: number) {
    this.u32(Math.round(v * 65536) | 0);
  }
  bytes(b: Uint8Array) {
    this.grow(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }
  pad4() {
    while (this.length % 4) this.u8(0);
  }
  set32(at: number, v: number) {
    this.buf[at] = v >>> 24;
    this.buf[at + 1] = (v >>> 16) & 255;
    this.buf[at + 2] = (v >>> 8) & 255;
    this.buf[at + 3] = v & 255;
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

const u16q = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 65535);

function xyzType(v: readonly number[]): Uint8Array {
  const o = new Bytes();
  o.ascii('XYZ ');
  o.u32(0);
  for (const c of v) o.s15(c);
  return o.result();
}

function mluc(text: string): Uint8Array {
  const o = new Bytes();
  o.ascii('mluc');
  o.u32(0);
  o.u32(1);
  o.u32(12);
  o.ascii('enUS');
  o.u32(text.length * 2);
  o.u32(28);
  for (let i = 0; i < text.length; i++) o.u16(text.charCodeAt(i));
  return o.result();
}

function curveElem(c: Curve): Uint8Array {
  const o = new Bytes();
  switch (c.type) {
    case 'identity':
      o.ascii('curv');
      o.u32(0);
      o.u32(0);
      break;
    case 'gamma':
      o.ascii('para');
      o.u32(0);
      o.u32(0);
      o.s15(c.gamma);
      break;
    case 'parametric':
      o.ascii('para');
      o.u32(0);
      o.u16(c.kind);
      o.u16(0);
      for (let i = 0; i < paramCount(c.kind); i++) o.s15(c.p[i]);
      break;
    case 'table':
      o.ascii('curv');
      o.u32(0);
      o.u32(c.table.length);
      for (const v of c.table) o.u16(u16q(v));
      break;
  }
  return o.result();
}

function curveTable(c: Curve, n: number): Float32Array {
  return c.type === 'table' && c.table.length === n ? c.table : sampleCurve(c, n);
}

function tableLen(cs: Curve[]): number {
  let n = 2;
  for (const c of cs) n = Math.max(n, c.type === 'table' ? c.table.length : c.type === 'identity' ? 2 : 1024);
  return Math.min(4096, Math.max(2, n));
}

function lutParts(stages: Stage[]): { mat: number[] | null; a: Curve[]; clut: Clut; b: Curve[] } | null {
  let i = 0;
  let mat: number[] | null = null;
  const first = stages[0];
  if (first?.kind === 'matrix' && first.rows === 3 && first.cols === 3) {
    mat = first.m;
    i = 1;
  }
  const [a, c, b] = stages.slice(i);
  if (stages.length - i !== 3 || a?.kind !== 'curves' || c?.kind !== 'clut' || b?.kind !== 'curves') return null;
  return { mat, a: a.curves, clut: c.clut, b: b.curves };
}

function encodeMft(stages: Stage[], wide: boolean): Uint8Array | null {
  const parts = lutParts(stages);
  if (!parts) return null;
  const { mat, a, clut, b } = parts;
  const g = clut.grid[0];
  if (!clut.grid.every((x) => x === g)) return null;
  const o = new Bytes();
  o.ascii(wide ? 'mft2' : 'mft1');
  o.u32(0);
  o.u8(clut.inputs, clut.outputs, g, 0);
  for (const v of mat ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]) o.s15(v);
  const nIn = wide ? tableLen(a) : 256;
  const nOut = wide ? tableLen(b) : 256;
  if (wide) {
    o.u16(nIn);
    o.u16(nOut);
  }
  const put = (v: number) => (wide ? o.u16(u16q(v)) : o.u8(Math.round(Math.min(1, Math.max(0, v)) * 255)));
  for (const c of a) for (const v of curveTable(c, nIn)) put(v);
  for (const v of clut.data) put(v);
  for (const c of b) for (const v of curveTable(c, nOut)) put(v);
  return o.result();
}

function encodeAb(stages: Stage[], a2b: boolean, inputs: number, outputs: number): Uint8Array | null {
  let aCurves: Curve[] | null = null;
  let clut: Clut | null = null;
  let mCurves: Curve[] | null = null;
  let matrix: { m: number[]; offset: number[] } | null = null;
  let bCurves: Curve[] | null = null;
  const v = stages;
  if (a2b) {
    let k = 0;
    if (v[0]?.kind === 'curves' && v[1]?.kind === 'clut') {
      aCurves = v[0].curves;
      clut = v[1].clut;
      k = 2;
    }
    const rest = v.slice(k);
    if (rest.length === 3 && rest[0].kind === 'curves' && rest[1].kind === 'matrix' && rest[2].kind === 'curves') {
      mCurves = rest[0].curves;
      matrix = { m: rest[1].m, offset: rest[1].offset };
      bCurves = rest[2].curves;
    } else if (rest.length === 1 && rest[0].kind === 'curves') bCurves = rest[0].curves;
    else return null;
  } else {
    let k = 0;
    if (v[0]?.kind === 'curves') {
      bCurves = v[0].curves;
      k = 1;
    }
    const m0 = v[k];
    const m1 = v[k + 1];
    if (m0?.kind === 'matrix' && m1?.kind === 'curves') {
      matrix = { m: m0.m, offset: m0.offset };
      mCurves = m1.curves;
      k += 2;
    }
    const c0 = v[k];
    const c1 = v[k + 1];
    if (c0?.kind === 'clut' && c1?.kind === 'curves') {
      clut = c0.clut;
      aCurves = c1.curves;
      k += 2;
    }
    if (k !== v.length) return null;
  }
  if (!bCurves) return null;
  const o = new Bytes();
  o.ascii(a2b ? 'mAB ' : 'mBA ');
  o.u32(0);
  o.u8(inputs, outputs, 0, 0);
  for (let k = 0; k < 5; k++) o.u32(0);
  const offs = [0, 0, 0, 0, 0];
  const curves = (cs: Curve[]) => {
    for (const c of cs) {
      o.bytes(curveElem(c));
      o.pad4();
    }
  };
  offs[0] = o.length;
  curves(bCurves);
  if (matrix) {
    offs[1] = o.length;
    for (const x of matrix.m) o.s15(x);
    for (const x of matrix.offset) o.s15(x);
    offs[2] = o.length;
    if (!mCurves) return null;
    curves(mCurves);
  }
  if (clut) {
    offs[3] = o.length;
    const g = new Array(16).fill(0);
    clut.grid.forEach((n, k) => (g[k] = n));
    o.u8(...g);
    o.u8(2, 0, 0, 0);
    for (const x of clut.data) o.u16(u16q(x));
    o.pad4();
    offs[4] = o.length;
    if (!aCurves) return null;
    curves(aCurves);
  }
  offs.forEach((x, k) => o.set32(12 + k * 4, x));
  return o.result();
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** ICC v4.3 bytes of a profile model. */
export function encodeProfile(p: Profile): Uint8Array {
  const tags: Array<[string, Uint8Array]> = [];
  tags.push(['desc', mluc(p.description)]);
  tags.push(['cprt', mluc(p.copyright)]);
  tags.push(['wtpt', xyzType(p.whitePoint)]);
  if (p.blackPoint) tags.push(['bkpt', xyzType(p.blackPoint)]);
  if (p.chad) {
    const o = new Bytes();
    o.ascii('sf32');
    o.u32(0);
    for (const row of p.chad) for (const v of row) o.s15(v);
    tags.push(['chad', o.result()]);
  }
  if (p.matrix) {
    const m = p.matrix;
    tags.push(['rXYZ', xyzType([m[0][0], m[1][0], m[2][0]])]);
    tags.push(['gXYZ', xyzType([m[0][1], m[1][1], m[2][1]])]);
    tags.push(['bXYZ', xyzType([m[0][2], m[1][2], m[2][2]])]);
  }
  if (p.trc) {
    tags.push(['rTRC', curveElem(p.trc[0])]);
    tags.push(['gTRC', curveElem(p.trc[1])]);
    tags.push(['bTRC', curveElem(p.trc[2])]);
  }
  if (p.grayTrc) tags.push(['kTRC', curveElem(p.grayTrc)]);
  for (const [luts, names, a2b] of [
    [p.a2b, ['A2B0', 'A2B1', 'A2B2'], true],
    [p.b2a, ['B2A0', 'B2A1', 'B2A2'], false],
  ] as const) {
    luts.forEach((l, k) => {
      if (!l) return;
      const data = l.kind === 'lut16' ? encodeMft(l.stages, true) : l.kind === 'lut8' ? encodeMft(l.stages, false) : encodeAb(l.stages, a2b, l.inputs, l.outputs);
      if (data) tags.push([names[k], data]);
    });
  }
  const tableLength = 4 + tags.length * 12;
  const data = new Bytes();
  const entries: Array<[string, number, number]> = [];
  const placed: Array<[Uint8Array, number, number]> = [];
  for (const [sig, d] of tags) {
    // Identical tag data is stored once and shared.
    const same = placed.find(([b]) => sameBytes(b, d));
    if (same) {
      entries.push([sig, same[1], same[2]]);
      continue;
    }
    const off = 128 + tableLength + data.length;
    data.bytes(d);
    data.pad4();
    entries.push([sig, off, d.length]);
    placed.push([d, off, d.length]);
  }
  const size = 128 + tableLength + data.length;
  const o = new Bytes();
  o.u32(size);
  o.u32(0);
  o.u8(4, 0x30, 0, 0);
  o.ascii(classSig(p.profileClass));
  o.ascii(spaceSig(p.colorSpace));
  o.ascii(p.pcs === 'lab' ? 'Lab ' : 'XYZ ');
  for (const v of [2026, 1, 1, 0, 0, 0]) o.u16(v);
  o.ascii('acsp');
  for (let k = 0; k < 6; k++) o.u32(0); // platform, flags, manufacturer, model, attributes
  o.u32(intentCode(p.renderingIntent));
  for (const v of D50) o.s15(v);
  o.u32(0); // creator
  while (o.length < 128) o.u8(0);
  o.u32(entries.length);
  for (const [sig, off, len] of entries) {
    o.ascii(sig);
    o.u32(off);
    o.u32(len);
  }
  o.bytes(data.result());
  return o.result();
}
