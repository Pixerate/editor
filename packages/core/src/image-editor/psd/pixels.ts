// Portions ported from photocraft/crates/io/src/pixels.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Planar PSD channels (any colour mode, 1 / 8 / 16 / 32 bits) → 8-bit sRGB RGBA, and back; and
 * at high bit depth, 16-bit sRGB or 32-bit linear RGBA samples (`toRgbaDeep`) and their planes.
 */

import { D50, XYZ_D50_TO_SRGB } from '../adjustment-layers';
import { linearToSrgb, srgbToLinear } from '../color';
import { PsdError } from './binary';

export const MODE_BITMAP = 0;
export const MODE_GRAYSCALE = 1;
export const MODE_INDEXED = 2;
export const MODE_RGB = 3;
export const MODE_CMYK = 4;
export const MODE_MULTICHANNEL = 7;
export const MODE_DUOTONE = 8;
export const MODE_LAB = 9;

/** Colour channels of a mode (alpha and spot channels come after them). */
export function colorChannelCount(mode: number, headerChannels: number): number {
  switch (mode) {
    case MODE_RGB:
    case MODE_LAB:
      return 3;
    case MODE_CMYK:
      return 4;
    case MODE_MULTICHANNEL:
      return Math.min(3, headerChannels);
    default:
      return 1;
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A plane's sample at `i` as 0..1 (`gamma`: 32-bit samples are linear light, so encode them). */
function sampler(plane: Uint8Array | undefined, depth: number, width: number, encode: boolean, fill: number): (i: number) => number {
  if (!plane) return () => fill;
  switch (depth) {
    case 8:
      return (i) => plane[i] / 255;
    case 16:
      return (i) => ((plane[2 * i] << 8) | plane[2 * i + 1]) / 65535;
    case 32: {
      const view = new DataView(plane.buffer, plane.byteOffset, plane.byteLength);
      return (i) => {
        const v = clamp01(view.getFloat32(4 * i, false) || 0);
        return encode ? linearToSrgb(v) : v;
      };
    }
    case 1: {
      const rb = Math.ceil(width / 8);
      // Bitmap: a set bit is black.
      return (i) => {
        const x = i % width;
        const y = (i - x) / width;
        return (plane[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 1;
      };
    }
    default:
      throw new PsdError(`Unsupported bit depth ${depth}.`);
  }
}

function labToSrgb(l: number, a: number, b: number): [number, number, number] {
  const fy = (l + 16) / 116;
  const f = (t: number) => (t > 6 / 29 ? t ** 3 : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  const x = f(fy + a / 500) * D50[0];
  const y = f(fy) * D50[1];
  const z = f(fy - b / 200) * D50[2];
  const m = XYZ_D50_TO_SRGB;
  return [
    linearToSrgb(clamp01(m[0][0] * x + m[0][1] * y + m[0][2] * z)),
    linearToSrgb(clamp01(m[1][0] * x + m[1][1] * y + m[1][2] * z)),
    linearToSrgb(clamp01(m[2][0] * x + m[2][1] * y + m[2][2] * z)),
  ];
}

export interface ChannelSet {
  width: number;
  height: number;
  depth: number;
  mode: number;
  /** Colour planes in mode order (missing planes read as 0, or no ink for CMYK). */
  color: Array<Uint8Array | undefined>;
  /** Missing: opaque. */
  alpha?: Uint8Array;
  /** Indexed: 768-byte palette (all reds, all greens, all blues). */
  palette?: Uint8Array;
  /**
   * CMYK: converts interleaved ink amounts (C, M, Y, K, 0..255 = no ink..full ink, stride 4)
   * to RGB (stride 4, alpha untouched), e.g. through the file's ICC profile. Missing: the
   * plain `rgb = (1 − ink) × (1 − k)` approximation.
   */
  cmykToRgb?: (ink: Uint8Array, out: Uint8ClampedArray) => void;
}

/** Interleaved 8-bit sRGB RGBA. */
export function toRgba8(set: ChannelSet): Uint8ClampedArray {
  const { width, height, depth, mode } = set;
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  const linear = depth === 32;
  const isLab = mode === MODE_LAB;
  const cmyk = mode === MODE_CMYK;
  // CMYK planes store 1 for no ink; a missing plane is no ink too.
  const planes = set.color.map((p) => sampler(p, depth, width, linear && !isLab && !cmyk, cmyk ? 1 : 0));
  const alpha = sampler(set.alpha, depth, width, false, 1);
  const fast8 = depth === 8 && mode === MODE_RGB && set.color.every(Boolean);
  if (fast8) {
    const [r, g, b] = set.color as Uint8Array[];
    const a = set.alpha;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      out[o] = r[i];
      out[o + 1] = g[i];
      out[o + 2] = b[i];
      out[o + 3] = a ? a[i] : 255;
    }
    return out;
  }
  if (mode === MODE_CMYK && set.cmykToRgb) {
    // Through a colour profile: ink amounts in, RGB out.
    const ink = new Uint8Array(n * 4);
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      for (let c = 0; c < 4; c++) ink[o + c] = Math.round((1 - (planes[c] ? planes[c](i) : 1)) * 255);
      out[o + 3] = Math.round(alpha(i) * 255);
    }
    set.cmykToRgb(ink, out);
    return out;
  }
  const palette = set.palette;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    let r: number;
    let g: number;
    let b: number;
    switch (mode) {
      case MODE_RGB:
      case MODE_MULTICHANNEL:
        r = planes[0](i);
        g = planes[1] ? planes[1](i) : r;
        b = planes[2] ? planes[2](i) : r;
        break;
      case MODE_CMYK: {
        const k = planes[3] ? planes[3](i) : 1;
        r = planes[0](i) * k;
        g = planes[1](i) * k;
        b = planes[2](i) * k;
        break;
      }
      case MODE_LAB:
        [r, g, b] = labToSrgb(planes[0](i) * 100, planes[1](i) * 255 - 128, planes[2](i) * 255 - 128);
        break;
      case MODE_INDEXED: {
        const idx = Math.round(planes[0](i) * 255);
        if (palette && palette.length >= 768) {
          out[o] = palette[idx];
          out[o + 1] = palette[256 + idx];
          out[o + 2] = palette[512 + idx];
          out[o + 3] = Math.round(alpha(i) * 255);
          continue;
        }
        r = g = b = idx / 255;
        break;
      }
      default:
        r = g = b = planes[0](i);
    }
    out[o] = Math.round(r * 255);
    out[o + 1] = Math.round(g * 255);
    out[o + 2] = Math.round(b * 255);
    out[o + 3] = Math.round(alpha(i) * 255);
  }
  return out;
}

/**
 * Interleaved RGBA at the file's depth: 16-bit files give 16-bit sRGB samples, 32-bit files
 * 32-bit linear float samples (colour unclamped, as stored). `null` for 1- and 8-bit files and
 * for indexed colour, which have no more than 8 bits to keep.
 */
export function toRgbaDeep(set: ChannelSet): Uint16Array | Float32Array | null {
  const { width, height, depth, mode } = set;
  if ((depth !== 16 && depth !== 32) || mode === MODE_INDEXED || mode === MODE_BITMAP) return null;
  const n = width * height;
  const isLab = mode === MODE_LAB;
  const cmyk = mode === MODE_CMYK;
  // Raw samples: 16-bit as 0..1, 32-bit linear floats unclamped.
  const raw = (plane: Uint8Array | undefined, fill: number): ((i: number) => number) => {
    if (!plane) return () => fill;
    if (depth === 16) return (i) => ((plane[2 * i] << 8) | plane[2 * i + 1]) / 65535;
    const view = new DataView(plane.buffer, plane.byteOffset, plane.byteLength);
    return (i) => view.getFloat32(4 * i, false) || 0;
  };
  const planes = set.color.map((p) => raw(p, cmyk ? 1 : 0));
  const alpha = raw(set.alpha, 1);
  if (depth === 16) {
    const out = new Uint16Array(n * 4);
    const q = (v: number) => Math.round(clamp01(v) * 65535);
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      let r: number;
      let g: number;
      let b: number;
      if (mode === MODE_CMYK) {
        const k = planes[3] ? planes[3](i) : 1;
        r = planes[0](i) * k;
        g = planes[1](i) * k;
        b = planes[2](i) * k;
      } else if (isLab) {
        [r, g, b] = labToSrgb(planes[0](i) * 100, planes[1](i) * 255 - 128, planes[2](i) * 255 - 128);
      } else if (mode === MODE_RGB || mode === MODE_MULTICHANNEL) {
        r = planes[0](i);
        g = planes[1] ? planes[1](i) : r;
        b = planes[2] ? planes[2](i) : r;
      } else r = g = b = planes[0](i);
      out[o] = q(r);
      out[o + 1] = q(g);
      out[o + 2] = q(b);
      out[o + 3] = q(alpha(i));
    }
    return out;
  }
  // 32-bit: RGB and grey are linear already; Lab and CMYK go through sRGB and back to linear.
  const out = new Float32Array(n * 4);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    let r: number;
    let g: number;
    let b: number;
    if (isLab) {
      [r, g, b] = labToSrgb(planes[0](i) * 100, planes[1](i) * 255 - 128, planes[2](i) * 255 - 128).map(srgbToLinear) as [number, number, number];
    } else if (cmyk) {
      const k = planes[3] ? planes[3](i) : 1;
      r = planes[0](i) * k;
      g = planes[1](i) * k;
      b = planes[2](i) * k;
    } else if (mode === MODE_RGB || mode === MODE_MULTICHANNEL) {
      r = planes[0](i);
      g = planes[1] ? planes[1](i) : r;
      b = planes[2] ? planes[2](i) : r;
    } else r = g = b = planes[0](i);
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = clamp01(alpha(i));
  }
  return out;
}

/**
 * Splits interleaved deep RGBA into big-endian planes `[r, g, b, a]` at its depth (2 bytes per
 * sample for 16-bit, IEEE float for 32-bit).
 */
export function deepToPlanes(data: Uint16Array | Float32Array, n: number): [Uint8Array, Uint8Array, Uint8Array, Uint8Array] {
  const bytes = data instanceof Uint16Array ? 2 : 4;
  const planes = [0, 1, 2, 3].map(() => new Uint8Array(n * bytes)) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  if (data instanceof Uint16Array) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 4; c++) {
        const v = data[i * 4 + c];
        planes[c][2 * i] = v >> 8;
        planes[c][2 * i + 1] = v & 255;
      }
    }
  } else {
    const views = planes.map((p) => new DataView(p.buffer));
    for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) views[c].setFloat32(4 * i, data[i * 4 + c], false);
  }
  return planes;
}

/** An 8-bit plane at `depth` (16: × 257; 32: / 255 as float), big-endian. */
export function planeAtDepth(plane: Uint8Array, depth: 8 | 16 | 32): Uint8Array {
  if (depth === 8) return plane;
  if (depth === 16) {
    const out = new Uint8Array(plane.length * 2);
    for (let i = 0; i < plane.length; i++) out[2 * i] = out[2 * i + 1] = plane[i];
    return out;
  }
  const out = new Uint8Array(plane.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < plane.length; i++) view.setFloat32(4 * i, plane[i] / 255, false);
  return out;
}

/** An 8-bit coverage plane (masks) from any depth. */
export function toMask8(plane: Uint8Array, width: number, height: number, depth: number): Uint8ClampedArray {
  if (depth === 8) return new Uint8ClampedArray(plane.buffer, plane.byteOffset, width * height);
  const s = sampler(plane, depth, width, false, 0);
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(s(i) * 255);
  return out;
}

/** Splits interleaved RGBA into planes `[r, g, b, a]` (8-bit). */
export function rgbaToPlanes(data: ArrayLike<number>, n: number): [Uint8Array, Uint8Array, Uint8Array, Uint8Array] {
  const planes: [Uint8Array, Uint8Array, Uint8Array, Uint8Array] = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    planes[0][i] = data[o];
    planes[1][i] = data[o + 1];
    planes[2][i] = data[o + 2];
    planes[3][i] = data[o + 3];
  }
  return planes;
}

/**
 * Photoshop stores a transparent merged image matted over white (colour × alpha + white × (1 −
 * alpha)). `unmatteWhite` recovers the colour in place; `matteWhite` applies the matte.
 */
export function unmatteWhite(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 255 || a === 0) continue;
    const k = 255 - a;
    for (let c = 0; c < 3; c++) data[i + c] = Math.round(((data[i + c] - k) * 255) / a);
  }
}

export function matteWhite(data: ArrayLike<number>): Uint8ClampedArray {
  const out = Uint8ClampedArray.from(data);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3];
    if (a === 255) continue;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round((out[i + c] * a + 255 * (255 - a)) / 255);
  }
  return out;
}

/** `matteWhite` for deep RGBA: 16-bit sRGB samples, or 32-bit linear (white is 1 in both). */
export function matteWhiteDeep(data: Uint16Array | Float32Array): Uint16Array | Float32Array {
  const out = data.slice() as Uint16Array | Float32Array;
  const one = out instanceof Uint16Array ? 65535 : 1;
  for (let i = 0; i < out.length; i += 4) {
    const a = Math.min(1, Math.max(0, out[i + 3] / one));
    if (a >= 1) continue;
    for (let c = 0; c < 3; c++) out[i + c] = out instanceof Uint16Array ? Math.round(out[i + c] * a + one * (1 - a)) : out[i + c] * a + one * (1 - a);
  }
  return out;
}
