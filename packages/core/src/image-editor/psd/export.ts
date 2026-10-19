// Portions ported from photocraft/crates/io/src/psd_export.rs and photocraft/crates/psd/src/builder.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Our layer tree → an 8-bit RGB PSD (PSB above 30 000 px) with real layers, groups, adjustment
 * layers and masks, RLE-compressed, plus the merged image the caller rendered.
 *
 * The stack must be *prepared*: annotation layers rasterized, layer filters and parametric masks
 * baked, and no layer reading the document source (see `ImageEditorController.toPsd`).
 */

import { adjustmentKindLabel } from '../adjustment-layers';
import { contentBounds, readRegion } from '../layers/surface';
import { isActiveFilter, type ImageLayer, type RasterMask } from '../layers/model';
import type { CropBox } from '../types';
import { PsdError, PsdWriter, encodeLegacyName } from './binary';
import { writeAdjustmentBlock } from './adjust';
import { encodeRle } from './compression';
import {
  CHANNEL_ALPHA,
  CHANNEL_USER_MASK,
  LAYER_FLAG_HIDDEN,
  LAYER_FLAG_TRANSPARENCY_PROTECTED,
  MASK_FLAG_DISABLED,
  PSD_MAX_DIMENSION,
  SECTION_CLOSED,
  SECTION_DIVIDER,
  SECTION_OPEN,
  type PsdChannel,
  type PsdLayerMask,
  type PsdLayerRecord,
  type PsdRect,
  type PsdResource,
  type PsdTaggedBlock,
  writePsd,
} from './file';
import { BLEND_TO_PSD } from './import';
import { matteWhite, rgbaToPlanes } from './pixels';

export interface PsdExportInput {
  width: number;
  height: number;
  /** Prepared stack, bottom to top. */
  layers: readonly ImageLayer[];
  /** The composite, `width × height` RGBA, written as the merged image. */
  merged: ArrayLike<number>;
  /** Pixels per inch (default 72). */
  resolution?: number;
}

export interface PsdExportResult {
  bytes: Uint8Array;
  psb: boolean;
  /** Layer records written (group folders and dividers included). */
  records: number;
}

/** Layer flag bits 3 and 4: "bit 4 is useful" and "pixel data irrelevant" (group records). */
const FLAG_PIXELS_IRRELEVANT = 8 | 16;
const EMPTY_RECT: PsdRect = { top: 0, left: 0, bottom: 0, right: 0 };

function unicodeBlock(s: string): Uint8Array {
  const w = new PsdWriter();
  w.unicode(s);
  return w.result();
}

function u32Bytes(v: number): Uint8Array {
  const w = new PsdWriter();
  w.u32(v);
  return w.result();
}

function sectionBlock(kind: number, blendKey?: string): Uint8Array {
  const w = new PsdWriter();
  w.u32(kind);
  if (blendKey) {
    w.ascii('8BIM');
    w.ascii(blendKey);
  }
  return w.result();
}

const toRect = (r: CropBox): PsdRect => ({ top: r.y, left: r.x, bottom: r.y + r.height, right: r.x + r.width });

function rleChannel(id: number, plane: Uint8Array, width: number, height: number, psb: boolean): PsdChannel {
  return { id, compression: 1, data: encodeRle(plane, { planes: 1, width, height, depth: 8, psb }) };
}

const emptyChannel = (id: number): PsdChannel => ({ id, compression: 0, data: new Uint8Array(0) });

function maskChannel(mask: RasterMask, ox: number, oy: number, psb: boolean): { channel: PsdChannel; mask: PsdLayerMask } {
  if (mask.source) throw new PsdError('A parametric mask must be baked before export.');
  const bounds = contentBounds(mask.surface);
  const def = mask.defaultValue;
  const m: PsdLayerMask = { rect: EMPTY_RECT, defaultColor: def, flags: mask.enabled === false ? MASK_FLAG_DISABLED : 0 };
  if ((mask.density ?? 1) < 1) m.userDensity = Math.round(Math.max(0, mask.density ?? 1) * 255);
  if ((mask.feather ?? 0) > 0) m.userFeather = mask.feather;
  if (!bounds) return { channel: emptyChannel(CHANNEL_USER_MASK), mask: m };
  const plane = readRegion(mask.surface, bounds);
  m.rect = toRect({ ...bounds, x: bounds.x + ox, y: bounds.y + oy });
  return { channel: rleChannel(CHANNEL_USER_MASK, new Uint8Array(plane.buffer, plane.byteOffset, plane.length), bounds.width, bounds.height, psb), mask: m };
}

function lockBits(layer: ImageLayer): number {
  const l = layer.locks;
  if (!l) return 0;
  return (l.all ? 0x80000000 : 0) | (l.transparency ? 1 : 0) | (l.pixels ? 2 : 0) | (l.position ? 4 : 0);
}

/** Writes the prepared stack as PSD (or PSB) bytes. */
export function exportPsd(input: PsdExportInput): PsdExportResult {
  const { width, height } = input;
  if (width < 1 || height < 1) throw new PsdError('The document is empty.');
  const psb = width > PSD_MAX_DIMENSION || height > PSD_MAX_DIMENSION;
  const records: PsdLayerRecord[] = [];
  let nextId = 0;

  const common = (layer: ImageLayer, extra: PsdTaggedBlock[] = []): Pick<PsdLayerRecord, 'opacity' | 'clipping' | 'flags' | 'legacyName' | 'blocks'> => {
    const name = layer.name || (layer.type === 'adjustment' ? adjustmentKindLabel(layer.kind) : '');
    const blocks: PsdTaggedBlock[] = [{ key: 'luni', data: unicodeBlock(name) }, { key: 'lyid', data: u32Bytes(++nextId) }, ...extra];
    const locks = lockBits(layer);
    if (locks) blocks.push({ key: 'lspf', data: u32Bytes(locks >>> 0) });
    return {
      opacity: Math.round(Math.min(1, Math.max(0, layer.opacity)) * 255),
      clipping: layer.clipped ? 1 : 0,
      flags: (layer.visible ? 0 : LAYER_FLAG_HIDDEN) | (layer.locks?.transparency ? LAYER_FLAG_TRANSPARENCY_PROTECTED : 0),
      legacyName: name,
      blocks,
    };
  };

  const write = (layer: ImageLayer): void => {
    switch (layer.type) {
      case 'group': {
        records.push({
          rect: EMPTY_RECT,
          channels: [CHANNEL_ALPHA, 0, 1, 2].map(emptyChannel),
          blendKey: 'norm',
          opacity: 255,
          clipping: 0,
          flags: FLAG_PIXELS_IRRELEVANT | (layer.visible ? 0 : LAYER_FLAG_HIDDEN),
          legacyName: '</Layer group>',
          blocks: [
            { key: 'luni', data: unicodeBlock('</Layer group>') },
            { key: 'lsct', data: sectionBlock(SECTION_DIVIDER) },
          ],
        });
        for (const child of layer.children) write(child);
        const blendKey = BLEND_TO_PSD[layer.blend] ?? 'norm';
        const base = common(layer, [{ key: 'lsct', data: sectionBlock(layer.collapsed ? SECTION_CLOSED : SECTION_OPEN, blendKey) }]);
        const rec: PsdLayerRecord = {
          ...base,
          rect: EMPTY_RECT,
          channels: [CHANNEL_ALPHA, 0, 1, 2].map(emptyChannel),
          blendKey,
          flags: base.flags | FLAG_PIXELS_IRRELEVANT,
        };
        if (layer.mask) {
          const m = maskChannel(layer.mask, 0, 0, psb);
          rec.channels.push(m.channel);
          rec.mask = m.mask;
        }
        records.push(rec);
        return;
      }
      case 'adjustment': {
        const block = writeAdjustmentBlock(layer.kind, layer.params);
        const rec: PsdLayerRecord = {
          ...common(layer, [{ key: block.key, data: block.data }]),
          rect: EMPTY_RECT,
          channels: [CHANNEL_ALPHA, 0, 1, 2].map(emptyChannel),
          blendKey: BLEND_TO_PSD[layer.blend] ?? 'norm',
        };
        if (layer.mask) {
          const m = maskChannel(layer.mask, 0, 0, psb);
          rec.channels.push(m.channel);
          rec.mask = m.mask;
        }
        records.push(rec);
        return;
      }
      case 'pixel': {
        if (layer.source === 'document') throw new PsdError(`Layer "${layer.name}" reads the document image; resolve its pixels before export.`);
        if (layer.filters?.some(isActiveFilter)) throw new PsdError(`Layer "${layer.name}" has live filters; bake them before export.`);
        const extra: PsdTaggedBlock[] = [];
        if (layer.fillOpacity !== undefined && layer.fillOpacity < 1) {
          extra.push({ key: 'iOpa', data: Uint8Array.from([Math.round(Math.max(0, layer.fillOpacity) * 255), 0, 0, 0]) });
        }
        const rec: PsdLayerRecord = { ...common(layer, extra), rect: EMPTY_RECT, channels: [], blendKey: BLEND_TO_PSD[layer.blend] ?? 'norm' };
        const bounds = contentBounds(layer.surface);
        if (bounds) {
          const n = bounds.width * bounds.height;
          const [r, g, b, a] = rgbaToPlanes(readRegion(layer.surface, bounds), n);
          rec.rect = toRect({ ...bounds, x: bounds.x + layer.offset.x, y: bounds.y + layer.offset.y });
          rec.channels = [
            rleChannel(CHANNEL_ALPHA, a, bounds.width, bounds.height, psb),
            rleChannel(0, r, bounds.width, bounds.height, psb),
            rleChannel(1, g, bounds.width, bounds.height, psb),
            rleChannel(2, b, bounds.width, bounds.height, psb),
          ];
        } else {
          rec.channels = [CHANNEL_ALPHA, 0, 1, 2].map(emptyChannel);
        }
        if (layer.mask) {
          const m = maskChannel(layer.mask, layer.offset.x, layer.offset.y, psb);
          rec.channels.push(m.channel);
          rec.mask = m.mask;
        }
        records.push(rec);
        return;
      }
      case 'annotation':
        throw new PsdError(`Annotation layer "${layer.name}" must be rasterized before export.`);
    }
  };
  for (const layer of input.layers) write(layer);
  if (records.length > 32767) throw new PsdError('A PSD holds at most 32767 layer records.');

  // Merged image: RGB, plus alpha when anything is transparent.
  const n = width * height;
  if (input.merged.length < n * 4) throw new PsdError(`The merged image has ${input.merged.length} bytes, expected ${n * 4}.`);
  // Photoshop's merged image is matted over white where it is transparent.
  const [r, g, b, a] = rgbaToPlanes(matteWhite(input.merged), n);
  const transparent = a.some((v) => v !== 255);
  const planes = transparent ? [r, g, b, a] : [r, g, b];
  const merged = new Uint8Array(n * planes.length);
  planes.forEach((p, i) => merged.set(p, i * n));

  const res = Math.max(1, input.resolution ?? 72);
  const rw = new PsdWriter();
  for (let k = 0; k < 2; k++) {
    rw.u32(Math.round(res * 65536));
    rw.u16(1); // pixels per inch
    rw.u16(1); // inches
  }
  const version = new PsdWriter();
  version.u32(1);
  version.u8(1); // the merged image is real
  version.unicode('Pixerate Editor');
  version.unicode('Pixerate Editor');
  version.u32(1);
  const resources: PsdResource[] = [
    { id: 1005, name: '', data: rw.result() },
    { id: 1057, name: '', data: version.result() },
  ];

  const bytes = writePsd(
    {
      header: { psb, channels: planes.length, width, height, depth: 8, colorMode: 3 },
      colorModeData: new Uint8Array(0),
      resources,
      layers: records,
      mergedAlpha: transparent && records.length > 0,
      globalBlocks: [],
      imageCompression: 1,
      imageData: encodeRle(merged, { planes: planes.length, width, height, depth: 8, psb }),
    },
    encodeLegacyName
  );
  return { bytes, psb, records: records.length };
}
