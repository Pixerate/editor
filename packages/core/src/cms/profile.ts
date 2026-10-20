// Portions ported from photocraft/crates/cms/src/profile.rs and lib.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * ICC profiles: the parsed model, the reader (ICC.1:2001-04 v2 and ICC.1:2010 v4: matrix/TRC
 * RGB, grey TRC, `mft1` / `mft2` / `mAB ` / `mBA ` LUTs, `curv` / `para` curves) and the
 * connection of a profile to the PCS as evaluation stages.
 */

import { Clut } from './clut';
import { gammaCurve, IDENTITY_CURVE, paramCount, type Curve } from './curve';
import { D50, invert, type Mat3, type Vec3 } from './math';
import { matrix3, type Stage } from './pipeline';

/** ICC rendering intent. */
export type Intent = 'perceptual' | 'relative' | 'saturation' | 'absolute';

export const INTENTS: readonly Intent[] = ['perceptual', 'relative', 'saturation', 'absolute'];

const INTENT_CODES: Record<Intent, number> = { perceptual: 0, relative: 1, saturation: 2, absolute: 3 };

export const intentCode = (i: Intent) => INTENT_CODES[i];
export const intentFromCode = (n: number): Intent | null => INTENTS[n] ?? null;

/** Errors from parsing profiles or building transforms. */
export class CmsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CmsError';
  }
}

export type ProfileClass = 'input' | 'display' | 'output' | 'link' | 'colorspace' | 'abstract' | 'named' | 'unknown';

const CLASS_SIGS: Record<string, ProfileClass> = { scnr: 'input', mntr: 'display', prtr: 'output', link: 'link', spac: 'colorspace', abst: 'abstract', nmcl: 'named' };

export const classSig = (c: ProfileClass): string => Object.entries(CLASS_SIGS).find(([, v]) => v === c)?.[0] ?? 'mntr';

/** Data colour space. */
export type ColorSpace = 'xyz' | 'lab' | 'luv' | 'ycbcr' | 'yxy' | 'rgb' | 'gray' | 'hsv' | 'hls' | 'cmyk' | 'cmy' | `${number}clr` | 'unknown';

const SPACE_SIGS: Record<string, ColorSpace> = {
  'XYZ ': 'xyz',
  'Lab ': 'lab',
  'Luv ': 'luv',
  YCbr: 'ycbcr',
  'Yxy ': 'yxy',
  'RGB ': 'rgb',
  GRAY: 'gray',
  'HSV ': 'hsv',
  'HLS ': 'hls',
  CMYK: 'cmyk',
  'CMY ': 'cmy',
};

function spaceFromSig(s: string): ColorSpace {
  if (SPACE_SIGS[s]) return SPACE_SIGS[s];
  const m = /^([2-9A-F])CLR$/.exec(s);
  if (m) return `${parseInt(m[1], 16)}clr` as ColorSpace;
  return 'unknown';
}

export function spaceSig(c: ColorSpace): string {
  const hit = Object.entries(SPACE_SIGS).find(([, v]) => v === c);
  if (hit) return hit[0];
  const m = /^(\d+)clr$/.exec(c);
  if (m) return `${Number(m[1]).toString(16).toUpperCase()}CLR`;
  return 'RGB ';
}

/** Channels of a colour space. */
export function spaceChannels(c: ColorSpace): number {
  if (c === 'gray') return 1;
  if (c === 'cmyk') return 4;
  if (c === 'unknown') return 0;
  const m = /^(\d+)clr$/.exec(c);
  return m ? Number(m[1]) : 3;
}

/** The PCS a stage list ends in (XYZ with Y = 1 for the white, or Lab with L 0–100). */
export type Pcs = 'xyz' | 'lab';

/** Encoding family of a LUT tag, which fixes how its PCS side is encoded. */
export type LutKind = 'lut8' | 'lut16' | 'ab';

/** A parsed `AToB` / `BToA` tag: device and PCS values normalised to 0..1. */
export interface Lut {
  kind: LutKind;
  inputs: number;
  outputs: number;
  stages: Stage[];
}

/** A parsed ICC profile. */
export interface Profile {
  /** Major version and minor.bugfix byte (`[4, 0x30]` for 4.3). */
  version: [number, number];
  profileClass: ProfileClass;
  colorSpace: ColorSpace;
  pcs: Pcs;
  renderingIntent: Intent;
  description: string;
  copyright: string;
  /** `wtpt` (D50 when absent). */
  whitePoint: Vec3;
  blackPoint: Vec3 | null;
  /** `chad` chromatic adaptation. */
  chad: Mat3 | null;
  /** Colorant matrix (columns rXYZ, gXYZ, bXYZ), D50-adapted. */
  matrix: Mat3 | null;
  trc: [Curve, Curve, Curve] | null;
  grayTrc: Curve | null;
  /** AToB0/1/2 (perceptual, colorimetric, saturation). */
  a2b: [Lut | null, Lut | null, Lut | null];
  b2a: [Lut | null, Lut | null, Lut | null];
  /** The bytes it was parsed from (or encoded to), for byte-exact embedding. */
  bytes: Uint8Array | null;
}

export function profileChannels(p: Profile): number {
  return spaceChannels(p.colorSpace);
}

/** Largest ΔE*ab at which `sameColors` treats two profiles as one colour space. */
export const SAME_COLORS_MAX_DELTA_E = 0.5;

/**
 * Media white for ICC-absolute colorimetry: `wtpt`, except for v2 display profiles, whose
 * `wtpt` records the unadapted display white; those count as D50.
 */
export function mediaWhite(p: Profile): Vec3 {
  if (p.version[0] < 4 && p.profileClass === 'display') return [D50[0], D50[1], D50[2]];
  return p.whitePoint;
}

/** True for matrix/TRC RGB or grey TRC profiles without LUTs. */
export function isMatrixShaper(p: Profile): boolean {
  return p.a2b.every((l) => !l) && ((p.matrix !== null && p.trc !== null) || p.grayTrc !== null);
}

const lutIndex = (intent: Intent) => (intent === 'perceptual' ? 0 : intent === 'saturation' ? 2 : 1);

function lutFor(luts: Profile['a2b'], intent: Intent): Lut | null {
  return luts[lutIndex(intent)] ?? luts[0];
}

/** Whether the profile has its own table for `intent` (matrix profiles serve every intent). */
export function supportsIntent(p: Profile, intent: Intent, input: boolean): boolean {
  const luts = input ? p.a2b : p.b2a;
  return Boolean(luts[lutIndex(intent)]) || luts.every((l) => !l);
}

function decodePcs(pcs: Pcs, kind: LutKind): Stage {
  if (pcs === 'xyz') return { kind: 'decode-xyz' };
  return kind === 'lut16' ? { kind: 'decode-lab-v2' } : { kind: 'decode-lab-v4' };
}

function encodePcs(pcs: Pcs, kind: LutKind): Stage {
  if (pcs === 'xyz') return { kind: 'encode-xyz' };
  return kind === 'lut16' ? { kind: 'encode-lab-v2' } : { kind: 'encode-lab-v4' };
}

/** Stages mapping normalised device values to the float PCS. */
export function deviceToPcs(p: Profile, intent: Intent): { stages: Stage[]; pcs: Pcs } {
  const l = lutFor(p.a2b, intent);
  if (l) return { stages: [...l.stages, decodePcs(p.pcs, l.kind)], pcs: p.pcs };
  switch (p.colorSpace) {
    case 'rgb':
      if (!p.matrix || !p.trc) throw new CmsError('RGB profile without matrix/TRC or AToB tags');
      return { stages: [{ kind: 'curves', curves: [...p.trc] }, matrix3(p.matrix)], pcs: 'xyz' };
    case 'gray': {
      if (!p.grayTrc) throw new CmsError('gray profile without kTRC');
      if (p.pcs === 'lab') return { stages: [{ kind: 'curves', curves: [p.grayTrc] }, { kind: 'matrix', rows: 3, cols: 1, m: [100, 0, 0], offset: [0, 0, 0] }], pcs: 'lab' };
      return { stages: [{ kind: 'curves', curves: [p.grayTrc] }, { kind: 'matrix', rows: 3, cols: 1, m: [D50[0], D50[1], D50[2]], offset: [0, 0, 0] }], pcs: 'xyz' };
    }
    case 'lab':
      return { stages: [{ kind: 'decode-lab-v4' }], pcs: 'lab' };
    case 'xyz':
      return { stages: [{ kind: 'decode-xyz' }], pcs: 'xyz' };
    default:
      throw new CmsError(`${p.colorSpace} profile without AToB tags`);
  }
}

/** Stages mapping the float PCS (of the returned kind) to normalised device values. */
export function pcsToDevice(p: Profile, intent: Intent): { stages: Stage[]; pcs: Pcs } {
  const l = lutFor(p.b2a, intent);
  if (l) return { stages: [encodePcs(p.pcs, l.kind), ...l.stages], pcs: p.pcs };
  switch (p.colorSpace) {
    case 'rgb': {
      if (!p.matrix || !p.trc) throw new CmsError('RGB profile without matrix/TRC or BToA tags');
      const inv = invert(p.matrix);
      if (!inv) throw new CmsError('singular colorant matrix');
      return { stages: [matrix3(inv), { kind: 'inv-curves', curves: [...p.trc] }], pcs: 'xyz' };
    }
    case 'gray': {
      if (!p.grayTrc) throw new CmsError('gray profile without kTRC');
      if (p.pcs === 'lab') return { stages: [{ kind: 'matrix', rows: 1, cols: 3, m: [0.01, 0, 0], offset: [0] }, { kind: 'inv-curves', curves: [p.grayTrc] }], pcs: 'lab' };
      return { stages: [{ kind: 'matrix', rows: 1, cols: 3, m: [0, 1, 0], offset: [0] }, { kind: 'inv-curves', curves: [p.grayTrc] }], pcs: 'xyz' };
    }
    case 'lab':
      return { stages: [{ kind: 'encode-lab-v4' }], pcs: 'lab' };
    case 'xyz':
      return { stages: [{ kind: 'encode-xyz' }], pcs: 'xyz' };
    default:
      throw new CmsError(`${p.colorSpace} profile without BToA tags`);
  }
}

/** Whether colours can be converted into this profile for every intent (input-only profiles cannot). */
export function canBeDestination(p: Profile): boolean {
  try {
    for (const i of ['perceptual', 'relative', 'saturation'] as const) pcsToDevice(p, i);
    return true;
  } catch {
    return false;
  }
}

/**
 * An RGB view of a grey TRC profile: R, G and B each carry the grey curve and a third of the
 * white, so (v, v, v) has exactly the colour of grey v.
 */
export function grayAsRgb(p: Profile): Profile | null {
  if (!p.grayTrc || p.pcs !== 'xyz') return null;
  const w = D50;
  const c = p.grayTrc;
  return {
    ...p,
    colorSpace: 'rgb',
    description: `${p.description} (as RGB)`,
    matrix: [
      [w[0] / 3, w[0] / 3, w[0] / 3],
      [w[1] / 3, w[1] / 3, w[1] / 3],
      [w[2] / 3, w[2] / 3, w[2] / 3],
    ],
    trc: [c, c, c],
    grayTrc: null,
    a2b: [null, null, null],
    b2a: [null, null, null],
    bytes: null,
  };
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

class Reader {
  constructor(readonly b: Uint8Array) {}
  check(off: number, len: number): void {
    if (off < 0 || len < 0 || off + len > this.b.length) throw new CmsError('ICC profile is truncated');
  }
  slice(off: number, len: number): Uint8Array {
    this.check(off, len);
    return this.b.subarray(off, off + len);
  }
  u8(off: number): number {
    this.check(off, 1);
    return this.b[off];
  }
  u16(off: number): number {
    this.check(off, 2);
    return (this.b[off] << 8) | this.b[off + 1];
  }
  u32(off: number): number {
    this.check(off, 4);
    return ((this.b[off] << 24) | (this.b[off + 1] << 16) | (this.b[off + 2] << 8) | this.b[off + 3]) >>> 0;
  }
  s15f16(off: number): number {
    return (this.u32(off) | 0) / 65536;
  }
  xyz(off: number): Vec3 {
    return [this.s15f16(off), this.s15f16(off + 4), this.s15f16(off + 8)];
  }
  ascii(off: number, len: number): string {
    return String.fromCharCode(...this.slice(off, len));
  }
}

/** Upper bound on CLUT nodes × outputs, to refuse hostile files. */
const MAX_CLUT_VALUES = 16 * 1024 * 1024;

/** Parses ICC profile bytes. Throws `CmsError` for anything that is not a usable profile. */
export function parseProfile(bytes: Uint8Array): Profile {
  if (bytes.length < 132) throw new CmsError('ICC profile is truncated');
  const head = new Reader(bytes);
  if (head.ascii(36, 4) !== 'acsp') throw new CmsError("not an ICC profile (missing 'acsp' signature)");
  const declared = head.u32(0);
  // Some writers pad or truncate: trust the smaller of the two.
  const end = declared >= 132 && declared <= bytes.length ? declared : bytes.length;
  const r = new Reader(bytes.subarray(0, end));
  const version: [number, number] = [r.u8(8), r.u8(9)];
  const profileClass = CLASS_SIGS[r.ascii(12, 4)] ?? 'unknown';
  const colorSpace = spaceFromSig(r.ascii(16, 4));
  const pcsSig = r.ascii(20, 4);
  const pcs: Pcs = pcsSig === 'Lab ' ? 'lab' : 'xyz';
  const renderingIntent = intentFromCode(r.u32(64) & 0xffff) ?? 'perceptual';
  const count = r.u32(128);
  if (count > 1024) throw new CmsError(`invalid ICC profile: ${count} tags`);
  const tags = new Map<string, [number, number]>();
  for (let i = 0; i < count; i++) {
    const o = 132 + i * 12;
    const sig = r.ascii(o, 4);
    if (!tags.has(sig)) tags.set(sig, [r.u32(o + 4), r.u32(o + 8)]);
  }
  const tagData = (sig: string): Uint8Array | null => {
    const t = tags.get(sig);
    return t ? r.slice(t[0], t[1]) : null;
  };
  const xyzTag = (sig: string): Vec3 | null => {
    const d = tagData(sig);
    if (!d) return null;
    const dr = new Reader(d);
    if (d.length < 20 || dr.ascii(0, 4) !== 'XYZ ') throw new CmsError(`invalid ICC profile: tag ${sig} is not XYZType`);
    return dr.xyz(8);
  };
  const curveTag = (sig: string): Curve | null => {
    const d = tagData(sig);
    return d ? parseCurve(d)[0] : null;
  };
  const whitePoint = xyzTag('wtpt') ?? [D50[0], D50[1], D50[2]];
  let blackPoint: Vec3 | null = null;
  try {
    blackPoint = xyzTag('bkpt');
  } catch {
    blackPoint = null;
  }
  let chad: Mat3 | null = null;
  const cd = tagData('chad');
  if (cd && cd.length >= 44 && new Reader(cd).ascii(0, 4) === 'sf32') {
    const rd = new Reader(cd);
    chad = [
      [rd.s15f16(8), rd.s15f16(12), rd.s15f16(16)],
      [rd.s15f16(20), rd.s15f16(24), rd.s15f16(28)],
      [rd.s15f16(32), rd.s15f16(36), rd.s15f16(40)],
    ];
  }
  const rr = xyzTag('rXYZ');
  const gg = xyzTag('gXYZ');
  const bb = xyzTag('bXYZ');
  const matrix: Mat3 | null =
    rr && gg && bb
      ? [
          [rr[0], gg[0], bb[0]],
          [rr[1], gg[1], bb[1]],
          [rr[2], gg[2], bb[2]],
        ]
      : null;
  const tr = curveTag('rTRC');
  const tg = curveTag('gTRC');
  const tb = curveTag('bTRC');
  const trc: [Curve, Curve, Curve] | null = tr && tg && tb ? [tr, tg, tb] : null;
  const grayTrc = curveTag('kTRC');
  const lut = (sig: string, a2b: boolean): Lut | null => {
    const d = tagData(sig);
    return d ? parseLut(d, a2b) : null;
  };
  const a2b: Profile['a2b'] = [lut('A2B0', true), lut('A2B1', true), lut('A2B2', true)];
  const b2a: Profile['b2a'] = [lut('B2A0', false), lut('B2A1', false), lut('B2A2', false)];
  const desc = tagData('desc');
  const cprt = tagData('cprt');
  const p: Profile = {
    version,
    profileClass,
    colorSpace,
    pcs,
    renderingIntent,
    description: desc ? parseText(desc) : '',
    copyright: cprt ? parseText(cprt) : '',
    whitePoint,
    blackPoint,
    chad,
    matrix,
    trc,
    grayTrc,
    a2b,
    b2a,
    bytes: bytes.slice(),
  };
  // LUT channel counts must match the header. A DeviceLink's PCS field holds its output space.
  const dev = spaceChannels(colorSpace);
  const conn = profileClass === 'link' ? spaceChannels(spaceFromSig(pcsSig)) : 3;
  for (const l of a2b) if (l && ((dev !== 0 && l.inputs !== dev) || (conn !== 0 && l.outputs !== conn))) throw new CmsError(`invalid ICC profile: AToB tag has ${l.inputs}→${l.outputs} channels for a ${colorSpace} profile`);
  for (const l of b2a) if (l && ((conn !== 0 && l.inputs !== conn) || (dev !== 0 && l.outputs !== dev))) throw new CmsError(`invalid ICC profile: BToA tag has ${l.inputs}→${l.outputs} channels for a ${colorSpace} profile`);
  return p;
}

/** A `curv` or `para` element: the curve and its unpadded byte length. */
function parseCurve(d: Uint8Array): [Curve, number] {
  const r = new Reader(d);
  const type = r.ascii(0, 4);
  if (type === 'curv') {
    const n = r.u32(8);
    const len = 12 + n * 2;
    if (n === 0) return [IDENTITY_CURVE, len];
    if (n === 1) return [gammaCurve(r.u16(12) / 256), len];
    if (n > 1 << 20) throw new CmsError('invalid ICC profile: curve too long');
    r.check(12, n * 2);
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++) t[i] = r.u16(12 + i * 2) / 65535;
    return [{ type: 'table', table: t }, len];
  }
  if (type === 'para') {
    const kind = r.u16(8);
    if (kind > 4) throw new CmsError(`unsupported ICC feature: parametric curve type ${kind}`);
    const n = paramCount(kind);
    const p = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < n; i++) p[i] = r.s15f16(12 + i * 4);
    return [kind === 0 ? gammaCurve(p[0]) : { type: 'parametric', kind, p }, 12 + n * 4];
  }
  throw new CmsError(`unsupported ICC feature: curve type "${type}"`);
}

function parseCurvesAt(d: Uint8Array, off: number, n: number): Curve[] {
  const out: Curve[] = [];
  let o = off;
  for (let k = 0; k < n; k++) {
    if (o >= d.length) throw new CmsError('ICC profile is truncated');
    const [c, len] = parseCurve(d.subarray(o));
    out.push(c);
    o += (len + 3) & ~3;
  }
  return out;
}

function parseLut(d: Uint8Array, a2b: boolean): Lut {
  const r = new Reader(d);
  const ty = r.ascii(0, 4);
  if (ty === 'mft1' || ty === 'mft2') {
    const wide = ty === 'mft2';
    const i = r.u8(8);
    const o = r.u8(9);
    const g = r.u8(10);
    if (i < 1 || i > 15 || o < 1 || o > 15 || g === 0) throw new CmsError('invalid ICC profile: bad lut dimensions');
    const m: Mat3 = [
      [r.s15f16(12), r.s15f16(16), r.s15f16(20)],
      [r.s15f16(24), r.s15f16(28), r.s15f16(32)],
      [r.s15f16(36), r.s15f16(40), r.s15f16(44)],
    ];
    const nIn = wide ? r.u16(48) : 256;
    const nOut = wide ? r.u16(50) : 256;
    let off = wide ? 52 : 48;
    if (wide && (nIn < 2 || nIn > 4096 || nOut < 2 || nOut > 4096)) throw new CmsError('invalid ICC profile: bad lut16 table size');
    const bps = wide ? 2 : 1;
    const values = (at: number, count: number): Float32Array => {
      r.check(at, count * bps);
      const out = new Float32Array(count);
      if (wide) for (let k = 0; k < count; k++) out[k] = r.u16(at + 2 * k) / 65535;
      else for (let k = 0; k < count; k++) out[k] = d[at + k] / 255;
      return out;
    };
    const tables = (count: number, len: number): Curve[] => {
      const v: Curve[] = [];
      for (let k = 0; k < count; k++) {
        v.push({ type: 'table', table: values(off, len) });
        off += len * bps;
      }
      return v;
    };
    const inCurves = tables(i, nIn);
    const nodes = Math.pow(g, i);
    if (nodes * o > MAX_CLUT_VALUES) throw new CmsError('invalid ICC profile: CLUT too large');
    const data = values(off, nodes * o);
    off += nodes * o * bps;
    const outCurves = tables(o, nOut);
    const stages: Stage[] = [];
    const ident = m.every((row, a) => row.every((v, b) => Math.abs(v - (a === b ? 1 : 0)) < 1e-6));
    // The matrix only applies to an XYZ PCS input (BToA); Lab writers must store the identity.
    if (!a2b && i === 3 && !ident) stages.push(matrix3(m));
    stages.push({ kind: 'curves', curves: inCurves });
    stages.push({ kind: 'clut', clut: new Clut(new Array(i).fill(g), o, data) });
    stages.push({ kind: 'curves', curves: outCurves });
    return { kind: wide ? 'lut16' : 'lut8', inputs: i, outputs: o, stages };
  }
  if (ty === 'mAB ' || ty === 'mBA ') {
    const i = r.u8(8);
    const o = r.u8(9);
    if (i < 1 || i > 15 || o < 1 || o > 15) throw new CmsError('invalid ICC profile: bad lutAB dimensions');
    const ob = r.u32(12);
    const om = r.u32(16);
    const omc = r.u32(20);
    const oc = r.u32(24);
    const oa = r.u32(28);
    const matrix = (at: number): Stage => {
      const m: number[] = [];
      for (let k = 0; k < 9; k++) m.push(r.s15f16(at + k * 4));
      return { kind: 'matrix', rows: 3, cols: 3, m, offset: [r.s15f16(at + 36), r.s15f16(at + 40), r.s15f16(at + 44)] };
    };
    const clut = (at: number, cin: number, cout: number): Stage => {
      const grid: number[] = [];
      for (let k = 0; k < cin; k++) {
        const gp = r.u8(at + k);
        if (gp < 1) throw new CmsError('invalid ICC profile: zero grid points');
        grid.push(gp);
      }
      const prec = r.u8(at + 16);
      const nodes = grid.reduce((a, b) => a * b, 1);
      if (nodes * cout > MAX_CLUT_VALUES) throw new CmsError('invalid ICC profile: CLUT too large');
      const total = nodes * cout;
      const data = new Float32Array(total);
      if (prec === 1) {
        r.check(at + 20, total);
        for (let k = 0; k < total; k++) data[k] = d[at + 20 + k] / 255;
      } else if (prec === 2) {
        r.check(at + 20, total * 2);
        for (let k = 0; k < total; k++) data[k] = r.u16(at + 20 + 2 * k) / 65535;
      } else throw new CmsError(`invalid ICC profile: CLUT precision ${prec}`);
      return { kind: 'clut', clut: new Clut(grid, cout, data) };
    };
    const stages: Stage[] = [];
    if (ty === 'mAB ') {
      // A curves → CLUT → M curves → matrix → B curves.
      if (oc !== 0) {
        if (oa === 0) throw new CmsError('invalid ICC profile: lutAtoB with CLUT but no A curves');
        stages.push({ kind: 'curves', curves: parseCurvesAt(d, oa, i) });
        stages.push(clut(oc, i, o));
      } else if (i !== o) throw new CmsError('invalid ICC profile: lutAtoB without CLUT changes channel count');
      if (om !== 0) {
        stages.push({ kind: 'curves', curves: parseCurvesAt(d, omc, o) });
        stages.push(matrix(om));
      }
      if (ob === 0) throw new CmsError('invalid ICC profile: lutAtoB without B curves');
      stages.push({ kind: 'curves', curves: parseCurvesAt(d, ob, o) });
    } else {
      // B curves → matrix → M curves → CLUT → A curves.
      if (ob === 0) throw new CmsError('invalid ICC profile: lutBtoA without B curves');
      stages.push({ kind: 'curves', curves: parseCurvesAt(d, ob, i) });
      if (om !== 0) {
        stages.push(matrix(om));
        stages.push({ kind: 'curves', curves: parseCurvesAt(d, omc, i) });
      }
      if (oc !== 0) {
        if (oa === 0) throw new CmsError('invalid ICC profile: lutBtoA with CLUT but no A curves');
        stages.push(clut(oc, i, o));
        stages.push({ kind: 'curves', curves: parseCurvesAt(d, oa, o) });
      } else if (i !== o) throw new CmsError('invalid ICC profile: lutBtoA without CLUT changes channel count');
    }
    return { kind: 'ab', inputs: i, outputs: o, stages };
  }
  throw new CmsError(`unsupported ICC feature: LUT type "${ty}"`);
}

/** Text from `desc`, `mluc` (English, else the first record) or `text`. */
function parseText(d: Uint8Array): string {
  try {
    const r = new Reader(d);
    const ty = r.ascii(0, 4);
    const ascii = (s: Uint8Array) => {
      const z = s.indexOf(0);
      return String.fromCharCode(...(z >= 0 ? s.subarray(0, z) : s)).trim();
    };
    if (ty === 'desc') return ascii(r.slice(12, Math.min(r.u32(8), d.length - 12)));
    if (ty === 'text') return ascii(d.subarray(8));
    if (ty === 'mluc') {
      const n = r.u32(8);
      const size = r.u32(12);
      let best: [number, number] | null = null;
      for (let k = 0; k < Math.min(n, 256); k++) {
        const o = 16 + k * size;
        const lang = r.ascii(o, 2);
        const len = r.u32(o + 4);
        const off = r.u32(o + 8);
        if (!best || lang === 'en') {
          best = [off, len];
          if (lang === 'en') break;
        }
      }
      if (!best) return '';
      const s = r.slice(best[0], best[1]);
      let out = '';
      for (let k = 0; k + 1 < s.length; k += 2) out += String.fromCharCode((s[k] << 8) | s[k + 1]);
      return out.replace(/\0+$/, '').trim();
    }
  } catch {
    return '';
  }
  return '';
}
