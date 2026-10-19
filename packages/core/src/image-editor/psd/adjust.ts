// Portions ported from photocraft/crates/io/src/adjust_map.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * PSD adjustment-layer blocks ↔ our ten adjustment kinds. Parameters use our units (levels
 * 0..255, degrees, percent), which are also Photoshop's, so most fields copy straight across.
 */

import { D50, XYZ_D50_TO_SRGB, defaultAdjustmentParams, hexToRgb, neutralHueRange } from '../adjustment-layers';
import { linearToSrgb } from '../color';
import type {
  AdjustmentKind,
  AdjustmentParamsMap,
  BlackWhiteParams,
  CurvePoint,
  CurvesParams,
  HueRange,
  LevelsChannel,
} from '../types';
import { PsdReader, PsdWriter } from './binary';
import {
  type Descriptor,
  type DescValue,
  descBool,
  descNumber,
  descObject,
  descriptor,
  parseVersionedDescriptor,
  versionedDescriptorBytes,
} from './descriptor';

/** Every adjustment block key Photoshop writes. */
export const ADJUSTMENT_KEYS = ['levl', 'curv', 'hue2', 'brit', 'nvrt', 'thrs', 'post', 'expA', 'vibA', 'blnc', 'mixr', 'grdm', 'phfl', 'selc', 'blwh', 'clrL'];

/** Keys we read and write. */
export const SUPPORTED_ADJUSTMENT_KEYS: Record<string, AdjustmentKind> = {
  levl: 'levels',
  curv: 'curves',
  hue2: 'hueSaturation',
  vibA: 'vibrance',
  blnc: 'colorBalance',
  blwh: 'blackWhite',
  nvrt: 'invert',
  post: 'posterize',
  thrs: 'threshold',
  phfl: 'photoFilter',
};

const LABELS: Record<string, string> = {
  levl: 'Levels',
  curv: 'Curves',
  hue2: 'Hue/Saturation',
  brit: 'Brightness/Contrast',
  nvrt: 'Invert',
  thrs: 'Threshold',
  post: 'Posterize',
  expA: 'Exposure',
  vibA: 'Vibrance',
  blnc: 'Color Balance',
  mixr: 'Channel Mixer',
  grdm: 'Gradient Map',
  phfl: 'Photo Filter',
  selc: 'Selective Color',
  blwh: 'Black & White',
  clrL: 'Color Lookup',
};

export function adjustmentLabel(key: string): string {
  return LABELS[key] ?? 'adjustment';
}

export type ParsedAdjustment = {
  [K in AdjustmentKind]: { kind: K; params: AdjustmentParamsMap[K]; approximated?: string };
}[AdjustmentKind];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const toHex = (rgb: readonly number[]) =>
  '#' + rgb.map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');

/** The canonical form of four range sliders: increasing, within one turn, centre in -30..330. */
export function canonicalBounds(b: readonly number[]): [number, number, number, number] {
  if (b.some((v) => !Number.isFinite(v))) return [-45, -15, 15, 45];
  const rem = (v: number) => ((v % 360) + 360) % 360;
  const out = [b[0], b[0], b[0], b[0]];
  for (let k = 1; k < 4; k++) out[k] = Math.min(out[k - 1] + rem(b[k] - out[k - 1]), out[0] + 359);
  const centre = (out[1] + out[2]) / 2;
  const shift = rem(centre + 30) - 30 - centre;
  return out.map((v) => v + shift) as [number, number, number, number];
}

function levelsRecord(r: PsdReader): LevelsChannel {
  const inBlack = r.u16();
  const inWhite = r.u16();
  const outBlack = r.u16();
  const outWhite = r.u16();
  const gamma = r.u16() / 100;
  return {
    inBlack: clamp(inBlack, 0, 255),
    inWhite: clamp(inWhite, 0, 255),
    gamma: clamp(gamma || 1, 0.1, 9.99),
    outBlack: clamp(outBlack, 0, 255),
    outWhite: clamp(outWhite, 0, 255),
  };
}

/** A pencil (256-entry map) curve as points every 15 levels. */
function curveFromMap(map: Uint8Array): CurvePoint[] {
  const pts: CurvePoint[] = [];
  for (let i = 0; i <= 255; i += 15) pts.push({ input: i, output: map[i] });
  return pts;
}

function parseCurves(d: Uint8Array): ParsedAdjustment | null {
  const r = new PsdReader(d);
  const pencil = r.u8() !== 0;
  const version = r.u16();
  if (version !== 1 && version !== 4) return null;
  const bits = r.u32();
  const params = defaultAdjustmentParams('curves');
  const order: Array<keyof CurvesParams> = ['master', 'red', 'green', 'blue'];
  for (let bit = 0; bit < 32; bit++) {
    if (!(bits & (1 << bit))) continue;
    let pts: CurvePoint[];
    if (pencil) {
      pts = curveFromMap(r.bytes(256));
    } else {
      const n = r.u16();
      r.checkCount(n, 4, 'Curve points');
      pts = [];
      for (let i = 0; i < n; i++) {
        const output = r.u16();
        const input = r.u16();
        pts.push({ input: clamp(input, 0, 255), output: clamp(output, 0, 255) });
      }
      pts.sort((a, b) => a.input - b.input);
    }
    if (bit < 4 && pts.length >= 2) params[order[bit]] = pts;
  }
  return { kind: 'curves', params, approximated: pencil ? 'its pencil curve is approximated by points' : undefined };
}

function parseHueSaturation(d: Uint8Array): ParsedAdjustment {
  const r = new PsdReader(d);
  r.u16();
  const colorize = r.u8() !== 0;
  r.u8();
  const triple = () => [r.i16(), r.i16(), r.i16()];
  const col = triple();
  const master = triple();
  const ranges: HueRange[] = [];
  for (let i = 0; i < 6; i++) {
    if (r.remaining < 14) {
      ranges.push(neutralHueRange(i));
      continue;
    }
    const b = [r.u16(), r.u16(), r.u16(), r.u16()];
    const [hue, saturation, lightness] = triple();
    ranges.push({ hue, saturation, lightness, bounds: canonicalBounds(b) });
  }
  const [hue, saturation, lightness] = colorize ? col : master;
  return { kind: 'hueSaturation', params: { hue, saturation, lightness, colorize, ranges } };
}

const BW_KEYS: Array<[keyof Omit<BlackWhiteParams, 'tint'>, string]> = [
  ['reds', 'Rd  '],
  ['yellows', 'Yllw'],
  ['greens', 'Grn '],
  ['cyans', 'Cyn '],
  ['blues', 'Bl  '],
  ['magentas', 'Mgnt'],
];
const BW_TINT = [225 / 255, 211 / 255, 179 / 255];

function descRgb(d: Descriptor | undefined): number[] | null {
  if (!d) return null;
  if (descNumber(d, 'redFloat') !== undefined) {
    return [descNumber(d, 'redFloat')!, descNumber(d, 'greenFloat') ?? 0, descNumber(d, 'blueFloat') ?? 0].map((v) => clamp(v, 0, 1));
  }
  const r = descNumber(d, 'Rd  ');
  const g = descNumber(d, 'Grn ');
  const b = descNumber(d, 'Bl  ');
  if (r === undefined || g === undefined || b === undefined) return null;
  return [r, g, b].map((v) => clamp(v / 255, 0, 1));
}

function parseBlackWhite(d: Uint8Array): ParsedAdjustment {
  const desc = parseVersionedDescriptor(d);
  const params = defaultAdjustmentParams('blackWhite');
  for (const [field, key] of BW_KEYS) {
    const v = descNumber(desc, key);
    if (v !== undefined) params[field] = clamp(v, -200, 300);
  }
  params.tint = descBool(desc, 'useTint') ? toHex(descRgb(descObject(desc, 'tintColor')) ?? BW_TINT) : null;
  return { kind: 'blackWhite', params };
}

function labToRgb(l: number, a: number, b: number): number[] {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const f = (t: number) => (t > 6 / 29 ? t ** 3 : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  const xyz = [f(fx) * D50[0], f(fy) * D50[1], f(fz) * D50[2]];
  return XYZ_D50_TO_SRGB.map((row) => linearToSrgb(clamp(row[0] * xyz[0] + row[1] * xyz[1] + row[2] * xyz[2], 0, 1)));
}

/** A PSD colour structure (space id + four u16) as 0..1 RGB, or `null` for spaces we cannot read. */
export function decodePsdColor(space: number, c: readonly number[]): number[] | null {
  const n = (v: number) => v / 65535;
  switch (space) {
    case 0:
      return [n(c[0]), n(c[1]), n(c[2])];
    case 1: {
      const h = n(c[0]) * 360;
      const s = n(c[1]);
      const v = n(c[2]);
      const k = (m: number) => (m + h / 60) % 6;
      const f = (m: number) => v - v * s * Math.max(0, Math.min(k(m), 4 - k(m), 1));
      return [f(5), f(3), f(1)];
    }
    case 2: {
      // Stored inverted: 65535 is no ink. A naive conversion; CMYK profiles are not read.
      const [cy, m, y, k] = c.map(n);
      return [cy * k, m * k, y * k];
    }
    case 7: {
      const signed = (v: number) => (v << 16) >> 16;
      return labToRgb(Math.min(c[0], 10000) / 100, signed(c[1]) / 100, signed(c[2]) / 100);
    }
    case 8: {
      const v = 1 - Math.min(c[0], 10000) / 10000;
      return [v, v, v];
    }
    default:
      return null;
  }
}

function parsePhotoFilter(d: Uint8Array): ParsedAdjustment | null {
  const r = new PsdReader(d);
  const version = r.u16();
  let rgb: number[] | null;
  if (version === 2) {
    const space = r.u16();
    const c = [r.u16(), r.u16(), r.u16(), r.u16()];
    rgb = [0, 2, 7, 8].includes(space) ? decodePsdColor(space, c) : null;
  } else if (version === 3) {
    const rel = [r.u32(), r.u32(), r.u32()].map((v) => v / 32768);
    if (rel.some((v) => v > 2)) return null;
    const xyz = [rel[0] * D50[0], rel[1], rel[2] * D50[2]];
    rgb = XYZ_D50_TO_SRGB.map((row) => linearToSrgb(clamp(row[0] * xyz[0] + row[1] * xyz[1] + row[2] * xyz[2], 0, 1)));
  } else {
    return null;
  }
  if (!rgb) return null;
  const density = clamp(r.u32(), 0, 100);
  const preserveLuminosity = r.u8() !== 0;
  return { kind: 'photoFilter', params: { color: toHex(rgb), density, preserveLuminosity } };
}

/**
 * Our parameters for an adjustment block, or `null` when the key is not one of our kinds or the
 * block cannot be read.
 */
export function parseAdjustmentBlock(key: string, data: Uint8Array): ParsedAdjustment | null {
  try {
    const r = new PsdReader(data);
    switch (key) {
      case 'nvrt':
        return { kind: 'invert', params: {} as Record<string, never> };
      case 'thrs':
        return { kind: 'threshold', params: { level: clamp(r.u16(), 1, 255) } };
      case 'post':
        return { kind: 'posterize', params: { levels: clamp(r.u16(), 2, 255) } };
      case 'levl': {
        r.u16();
        const master = levelsRecord(r);
        const red = levelsRecord(r);
        const green = levelsRecord(r);
        const blue = levelsRecord(r);
        return { kind: 'levels', params: { master, red, green, blue } };
      }
      case 'curv':
        return parseCurves(data);
      case 'hue2':
        return parseHueSaturation(data);
      case 'vibA': {
        const desc = parseVersionedDescriptor(data);
        const get = (k: string) => clamp(descNumber(desc, k) ?? 0, -100, 100);
        return { kind: 'vibrance', params: { vibrance: get('vibrance'), saturation: get('Strt') } };
      }
      case 'blnc': {
        const tone = () => [r.i16(), r.i16(), r.i16()].map((v) => clamp(v, -100, 100)) as [number, number, number];
        const shadows = tone();
        const midtones = tone();
        const highlights = tone();
        return { kind: 'colorBalance', params: { shadows, midtones, highlights, preserveLuminosity: r.u8() !== 0 } };
      }
      case 'blwh':
        return parseBlackWhite(data);
      case 'phfl':
        return parsePhotoFilter(data);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

const q = (v: number) => Math.round(clamp(v, 0, 255));
const i16 = (v: number) => Math.round(clamp(v, -32768, 32767));

function writeLevels(w: PsdWriter, c: LevelsChannel): void {
  w.u16(q(c.inBlack));
  w.u16(q(c.inWhite));
  w.u16(q(c.outBlack));
  w.u16(q(c.outWhite));
  w.u16(Math.round(clamp(c.gamma * 100, 1, 999)));
}

const long = (value: number): DescValue => ({ type: 'long', value: i16(value) });

/** The PSD block (key and data) for one of our adjustment layers. */
export function writeAdjustmentBlock<K extends AdjustmentKind>(kind: K, params: AdjustmentParamsMap[K]): { key: string; data: Uint8Array } {
  const w = new PsdWriter();
  switch (kind) {
    case 'invert':
      return { key: 'nvrt', data: new Uint8Array(0) };
    case 'threshold': {
      const p = params as AdjustmentParamsMap['threshold'];
      w.u16(Math.max(1, q(p.level)));
      w.u16(0);
      return { key: 'thrs', data: w.result() };
    }
    case 'posterize': {
      const p = params as AdjustmentParamsMap['posterize'];
      w.u16(Math.round(clamp(p.levels, 2, 255)));
      w.u16(0);
      return { key: 'post', data: w.result() };
    }
    case 'levels': {
      const p = params as AdjustmentParamsMap['levels'];
      w.u16(2);
      for (const c of [p.master, p.red, p.green, p.blue]) writeLevels(w, c);
      const ident: LevelsChannel = { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };
      for (let i = 4; i < 29; i++) writeLevels(w, ident);
      return { key: 'levl', data: w.result() };
    }
    case 'curves': {
      const p = params as AdjustmentParamsMap['curves'];
      w.u8(0);
      w.u16(1);
      w.u32(0b1111);
      for (const c of [p.master, p.red, p.green, p.blue]) {
        const pts = c.slice(0, 19);
        w.u16(pts.length);
        for (const pt of pts) {
          w.u16(q(pt.output));
          w.u16(q(pt.input));
        }
      }
      return { key: 'curv', data: w.result() };
    }
    case 'hueSaturation': {
      const p = params as AdjustmentParamsMap['hueSaturation'];
      w.u16(2);
      w.u8(p.colorize ? 1 : 0);
      w.u8(0);
      for (let k = 0; k < 2; k++) for (const x of [p.hue, p.saturation, p.lightness]) w.i16(i16(x));
      for (let i = 0; i < 6; i++) {
        const r = p.ranges[i] ?? neutralHueRange(i);
        for (const b of r.bounds) w.u16(Math.round(((b % 360) + 360) % 360) % 360);
        for (const x of [r.hue, r.saturation, r.lightness]) w.i16(i16(x));
      }
      return { key: 'hue2', data: w.result() };
    }
    case 'vibrance': {
      const p = params as AdjustmentParamsMap['vibrance'];
      const d = descriptor('null', [
        ['vibrance', long(clamp(p.vibrance, -100, 100))],
        ['Strt', long(clamp(p.saturation, -100, 100))],
      ]);
      return { key: 'vibA', data: versionedDescriptorBytes(d) };
    }
    case 'colorBalance': {
      const p = params as AdjustmentParamsMap['colorBalance'];
      for (const x of [...p.shadows, ...p.midtones, ...p.highlights]) w.i16(i16(clamp(x, -100, 100)));
      w.u8(p.preserveLuminosity ? 1 : 0);
      w.u8(0);
      return { key: 'blnc', data: w.result() };
    }
    case 'blackWhite': {
      const p = params as AdjustmentParamsMap['blackWhite'];
      const tint = p.tint ? hexToRgb(p.tint) : BW_TINT;
      const dbl = (v: number): DescValue => ({ type: 'doub', value: clamp(v, 0, 1) * 255 });
      const items: Array<[string, DescValue]> = BW_KEYS.map(([field, key]) => [key, long(clamp(p[field], -200, 300))]);
      items.push(
        ['useTint', { type: 'bool', value: p.tint !== null }],
        ['tintColor', { type: 'Objc', value: descriptor('RGBC', [['Rd  ', dbl(tint[0])], ['Grn ', dbl(tint[1])], ['Bl  ', dbl(tint[2])]]) }],
        ['bwPresetKind', { type: 'long', value: 1 }],
        ['blackAndWhitePresetFileName', { type: 'TEXT', value: '' }]
      );
      return { key: 'blwh', data: versionedDescriptorBytes(descriptor('null', items)) };
    }
    case 'photoFilter': {
      const p = params as AdjustmentParamsMap['photoFilter'];
      const rgb = hexToRgb(p.color);
      w.u16(2);
      w.u16(0);
      for (const x of rgb) w.u16(Math.round(clamp(x, 0, 1) * 65535));
      w.u16(0);
      w.u32(Math.round(clamp(p.density, 0, 100)));
      w.u8(p.preserveLuminosity ? 1 : 0);
      w.zeros(3);
      return { key: 'phfl', data: w.result() };
    }
  }
  throw new Error(`Unknown adjustment kind "${kind}".`);
}
