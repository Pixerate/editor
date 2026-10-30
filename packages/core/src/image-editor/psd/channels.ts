/**
 * Alpha channels in PSD / PSB files: extra planes of the merged image after the colour (and
 * transparency) planes, named by image resources 1006 (Pascal) and 1045 (Unicode), with their
 * overlay colour, opacity and what the colour indicates in 1077 (DisplayInfo).
 */
import { PsdReader, PsdWriter, encodeLegacyName } from './binary';
import { rowBytes } from './compression';
import type { PsdResource } from './file';

/** An alpha channel as the PSD code reads and writes it: an 8-bit plane over the canvas. */
export interface PsdAlphaChannel {
  name: string;
  /** `width × height` coverage, 255 = selected. */
  data: Uint8Array;
  /** `#rrggbb` overlay colour. */
  color: string;
  /** 0..1. */
  opacity: number;
  indicates: 'masked' | 'selected';
}

const hexToRgb = (hex: string): [number, number, number] => {
  const v = parseInt(/^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? 'ff0000', 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

const rgbToHex = (r: number, g: number, b: number) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;

/** The image resources that name and describe `channels`. */
export function alphaChannelResources(channels: readonly PsdAlphaChannel[]): PsdResource[] {
  if (!channels.length) return [];
  const names = new PsdWriter();
  for (const c of channels) names.pascal(encodeLegacyName(c.name), 1);
  const unicode = new PsdWriter();
  for (const c of channels) unicode.unicode(c.name);
  const display = new PsdWriter();
  display.u32(1); // version
  for (const c of channels) {
    const [r, g, b] = hexToRgb(c.color);
    display.u16(0); // RGB colour space
    for (const v of [r, g, b, 0]) display.u16(v * 257);
    display.u16(Math.round(Math.min(1, Math.max(0, c.opacity)) * 100));
    display.u8(c.indicates === 'selected' ? 0 : 1); // 0 selected areas, 1 masked areas
    display.u8(0);
  }
  return [
    { id: 1006, name: '', data: names.result() },
    { id: 1045, name: '', data: unicode.result() },
    { id: 1077, name: '', data: display.result() },
  ];
}

/** 8-bit coverage of one merged-image plane at `depth` (16-bit: the high byte; 32-bit: float 0..1). */
function planeTo8(plane: Uint8Array, n: number, depth: number): Uint8Array {
  if (depth === 8) return plane.slice(0, n);
  const out = new Uint8Array(n);
  const view = new DataView(plane.buffer, plane.byteOffset, plane.byteLength);
  for (let i = 0; i < n; i++) {
    if (depth === 16) out[i] = plane[2 * i];
    else out[i] = Math.round(Math.min(1, Math.max(0, view.getFloat32(4 * i, false))) * 255);
  }
  return out;
}

/**
 * The alpha channels of a file: merged planes `first … channels − 1`, named from 1045 (or
 * 1006), described by 1077. Spot colour channels (kind 2) are left out and reported.
 */
export function readAlphaChannels(
  planes: Uint8Array,
  header: { width: number; height: number; depth: number; channels: number },
  first: number,
  resource: (id: number) => Uint8Array | undefined,
  warn: (message: string) => void
): PsdAlphaChannel[] {
  const count = header.channels - first;
  if (count <= 0 || header.depth === 1) return [];
  const size = rowBytes(header.width, header.depth) * header.height;
  const n = header.width * header.height;
  const names: string[] = [];
  const unicode = resource(1045);
  if (unicode) {
    const r = new PsdReader(unicode);
    while (r.remaining >= 4 && names.length < count) names.push(r.unicode().replace(/\0+$/, ''));
  } else {
    const legacy = resource(1006);
    if (legacy) {
      const r = new PsdReader(legacy);
      while (r.remaining >= 1 && names.length < count) names.push(new TextDecoder('latin1').decode(r.pascal(1)));
    }
  }
  const display: { color: string; opacity: number; kind: number }[] = [];
  const info = resource(1077);
  if (info && info.length >= 4) {
    const r = new PsdReader(info);
    r.u32();
    while (r.remaining >= 14 && display.length < count) {
      r.u16();
      const [cr, cg, cb] = [r.u16(), r.u16(), r.u16()];
      r.u16();
      const opacity = r.u16();
      const kind = r.u8();
      r.u8();
      display.push({ color: rgbToHex(cr >> 8, cg >> 8, cb >> 8), opacity: Math.min(100, opacity) / 100, kind });
    }
  }
  const out: PsdAlphaChannel[] = [];
  for (let i = 0; i < count; i++) {
    const start = (first + i) * size;
    if (start + size > planes.length) break;
    const d = display[i];
    const name = names[i] || `Alpha ${i + 1}`;
    if (d?.kind === 2) {
      warn(`Spot colour channel "${name}" is not supported and was left out.`);
      continue;
    }
    out.push({
      name,
      data: planeTo8(planes.subarray(start, start + size), n, header.depth),
      color: d?.color ?? '#ff0000',
      opacity: d?.opacity ?? 0.5,
      indicates: d?.kind === 0 ? 'selected' : 'masked',
    });
  }
  return out;
}
