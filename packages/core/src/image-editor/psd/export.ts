// Portions ported from photocraft/crates/io/src/psd_export.rs and photocraft/crates/psd/src/builder.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Our layer tree → an RGB PSD at 8, 16 or 32 bits (PSB above 30 000 px) with real layers, groups, adjustment
 * layers and masks, RLE-compressed, plus the merged image the caller rendered.
 *
 * The stack must be *prepared*: annotation layers rasterized, layer filters and parametric masks
 * baked, and no layer reading the document source (see `ImageEditorController.toPsd`).
 */

import { adjustmentKindLabel } from '../adjustment-layers';
import { contentBounds, readRegion, surfaceFromPixels, type TiledSurface } from '../../raster/surface';
import { encodePng } from '../../raster/png';
import { isActiveFilter, type ImageLayer, type PixelLayer, type RasterMask, type SmartContents, type SmartObjectLayer } from '../layers/model';
import { LayerCompositor } from '../layers/compositor';
import { contentsSurface, placementGeometry } from '../layers/smart';
import {
  encodeLinkedFile,
  filterFXDescriptor,
  filterMaskItem,
  filterStackKey,
  parsePlaced,
  placementFromPlaced,
  plldBytes,
  psdUuid,
  writeFilterEffects,
  smartFiltersFromPsd,
  soldBytes,
  type FilterEffectsItem,
} from './smart';
import { descBool } from './descriptor';
import type { CropBox } from '../types';
import { PsdError, PsdWriter, encodeLegacyName } from './binary';
import { writeAdjustmentBlock } from './adjust';
import { encodeRle, encodeZipPredicted } from './compression';
import {
  CHANNEL_ALPHA,
  CHANNEL_USER_MASK,
  LAYER_FLAG_HIDDEN,
  LAYER_FLAG_TRANSPARENCY_PROTECTED,
  MASK_FLAG_DISABLED,
  MASK_FLAG_UNLINKED,
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
import { deepToPlanes, matteWhite, planeAtDepth, rgbaToPlanes } from './pixels';
import { readDeepRegion } from '../../raster/deep';
import { parseLfx2, writeLfx2 } from './effects';
import { writePatternBlock } from './patterns';
import { shapeBlocks } from './shapes';
import { tyShForLayer } from './type';
import { effectsFingerprint, type GlobalLight, type LayerEffect } from '../../raster/effects/model';
import { builtinPattern, type EffectPattern } from '../../raster/effects/patterns';

export interface PsdExportInput {
  width: number;
  height: number;
  /** Prepared stack, bottom to top. */
  layers: readonly ImageLayer[];
  /** The composite, `width × height` RGBA, written as the merged image. */
  merged: ArrayLike<number>;
  /** Pixels per inch (default 72). */
  resolution?: number;
  /** The document's patterns; those the effects use are embedded (built-in ones too). */
  patterns?: readonly EffectPattern[];
  /** Written as image resources 1037 and 1049. */
  globalLight?: GlobalLight;
  /** Bits per channel to write (default 8): 16 and 32 write the layers' deep samples (see `raster/deep`). */
  depth?: 8 | 16 | 32;
}

export interface PsdExportResult {
  bytes: Uint8Array;
  psb: boolean;
  /** Layer records written (group folders and dividers included). */
  records: number;
  /** One sentence per loss, naming the layers. */
  warnings: string[];
}

/** Pattern ids an effect paints with. */
function usedPatterns(e: LayerEffect): string[] {
  if (e.kind === 'pattern-overlay') return [e.patternId];
  if (e.kind === 'stroke' && e.fill.type === 'pattern') return [e.fill.patternId];
  if (e.kind === 'bevel-emboss' && e.texture) return [e.texture.patternId];
  return [];
}

const padEven = (d: Uint8Array) => {
  if (d.length % 2 === 0) return d;
  const out = new Uint8Array(d.length + 1);
  out.set(d);
  return out;
};

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

/** One channel: RLE for 8- and 16-bit planes, ZIP with prediction for 32-bit (as Photoshop writes them). */
function rleChannel(id: number, plane: Uint8Array, width: number, height: number, psb: boolean, depth: 8 | 16 | 32 = 8): PsdChannel {
  const layout = { planes: 1, width, height, depth, psb };
  if (depth === 32) return { id, compression: 3, data: encodeZipPredicted(plane, layout) };
  return { id, compression: 1, data: encodeRle(plane, layout) };
}

/** A surface's `bounds` as planes `[r, g, b, a]` at `depth` (deep samples where the tiles hold them). */
function surfacePlanes(surface: TiledSurface, bounds: CropBox, depth: 8 | 16 | 32): [Uint8Array, Uint8Array, Uint8Array, Uint8Array] {
  const n = bounds.width * bounds.height;
  if (depth === 8) return rgbaToPlanes(readRegion(surface, bounds), n);
  return deepToPlanes(readDeepRegion(surface, bounds, depth), n);
}

const emptyChannel = (id: number): PsdChannel => ({ id, compression: 0, data: new Uint8Array(0) });

function maskChannel(mask: RasterMask, ox: number, oy: number, psb: boolean, depth: 8 | 16 | 32 = 8): { channel: PsdChannel; mask: PsdLayerMask } {
  if (mask.source) throw new PsdError('A parametric mask must be baked before export.');
  const bounds = contentBounds(mask.surface);
  const def = mask.defaultValue;
  const flags = (mask.enabled === false ? MASK_FLAG_DISABLED : 0) | (mask.linked === false ? MASK_FLAG_UNLINKED : 0);
  const m: PsdLayerMask = { rect: EMPTY_RECT, defaultColor: def, flags };
  if ((mask.density ?? 1) < 1) m.userDensity = Math.round(Math.max(0, mask.density ?? 1) * 255);
  if ((mask.feather ?? 0) > 0) m.userFeather = mask.feather;
  if (!bounds) return { channel: emptyChannel(CHANNEL_USER_MASK), mask: m };
  const plane = readRegion(mask.surface, bounds);
  m.rect = toRect({ ...bounds, x: bounds.x + ox, y: bounds.y + oy });
  const bytes = planeAtDepth(new Uint8Array(plane.buffer, plane.byteOffset, plane.length), depth);
  return { channel: rleChannel(CHANNEL_USER_MASK, bytes, bounds.width, bounds.height, psb, depth), mask: m };
}

function lockBits(layer: ImageLayer): number {
  const l = layer.locks;
  if (!l) return 0;
  return (l.all ? 0x80000000 : 0) | (l.transparency ? 1 : 0) | (l.pixels ? 2 : 0) | (l.position ? 4 : 0);
}

/**
 * A nested document's layers as `exportPsd` takes them: annotation layers left out (they need a
 * canvas), pixel-layer filters baked, parametric masks dropped. Smart objects stay smart objects.
 */
export function prepareNestedLayers(layers: readonly ImageLayer[]): ImageLayer[] {
  const out: ImageLayer[] = [];
  for (const l of layers) {
    if (l.type === 'annotation') continue;
    let next: ImageLayer = l;
    if (l.type === 'group') next = { ...l, children: prepareNestedLayers(l.children) };
    else if (l.type === 'pixel' && (l.filters?.length || l.source === 'document')) {
      const p: PixelLayer = { ...l };
      if (l.filters?.some(isActiveFilter)) {
        const b = l.surface.bounds;
        if (b) {
          const r = { x: b.x + l.offset.x - 64, y: b.y + l.offset.y - 64, width: b.width + 128, height: b.height + 128 };
          const plain: PixelLayer = { ...l, visible: true, opacity: 1, blend: 'normal' };
          delete plain.mask;
          delete plain.clipped;
          delete plain.effects;
          delete plain.fillOpacity;
          const data = new LayerCompositor().composite([plain], r, { width: r.x + r.width, height: r.y + r.height });
          p.surface = surfaceFromPixels({ width: r.width, height: r.height, data }, 4, r.x - l.offset.x, r.y - l.offset.y);
        }
      }
      delete p.filters;
      delete p.source;
      next = p;
    }
    if (next.mask?.source) {
      next = { ...next } as ImageLayer;
      delete next.mask;
    }
    out.push(next);
  }
  return out;
}

/** The file a smart object's contents are written as: the file they came from while unedited, else a PNG or a PSD / PSB. */
export function smartContentsFile(c: SmartContents): { name: string; bytes: Uint8Array } {
  const base = c.name.replace(/\.\w+$/, '') || 'Contents';
  if (c.file) return { name: c.name, bytes: c.file.bytes };
  if (c.kind === 'raster') {
    const data = readRegion(contentsSurface(c), { x: 0, y: 0, width: c.width, height: c.height });
    return { name: `${base}.png`, bytes: encodePng(c.width, c.height, data) };
  }
  const doc = c.document!;
  const merged = readRegion(contentsSurface(c), { x: 0, y: 0, width: c.width, height: c.height });
  const res = exportPsd({ width: c.width, height: c.height, layers: prepareNestedLayers(doc.layers), merged, patterns: doc.patterns, globalLight: doc.globalLight });
  return { name: `${base}.${res.psb ? 'psb' : 'psd'}`, bytes: res.bytes };
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * (1 + Math.abs(a));

/** Whether a stored placed block still says what the layer holds (then it is written back unchanged). */
function placedUnchanged(layer: SmartObjectLayer, idnt: string, placedId: string): boolean {
  const raw = layer.psd;
  if (!raw || raw.key === 'PlLd') return false;
  const p = parsePlaced(raw.key, raw.data);
  if (!p || p.idnt !== idnt || p.placed !== placedId) return false;
  const size = p.size ?? { width: layer.contents.width, height: layer.contents.height };
  if (size.width !== layer.contents.width || size.height !== layer.contents.height) return false;
  const was = placementFromPlaced(p, size, []);
  if (!was) return false;
  const now = placementGeometry(layer);
  if (!was.corners.every((c, i) => near(c.x, now.corners[i].x) && near(c.y, now.corners[i].y))) return false;
  const meshKey = (m: typeof now.warp) => (m ? m.points.map((q) => `${q.x.toFixed(5)},${q.y.toFixed(5)}`).join(';') + `|${m.us.length}x${m.vs.length}` : '');
  if (meshKey(was.warp) !== meshKey(now.warp)) return false;
  if ((layer.placement.interpolation ?? 'bicubic') !== 'bicubic') return false;
  const stored = p.filterFX ? smartFiltersFromPsd(p.filterFX, () => '', []) : undefined;
  if (stored && p.filterFX) {
    if (descBool(p.filterFX, 'filterMaskEnable') === false || descBool(p.filterFX, 'filterMaskLinked') === false) {
      stored.mask = { surface: layer.surface, defaultValue: 255, enabled: descBool(p.filterFX, 'filterMaskEnable') !== false, linked: descBool(p.filterFX, 'filterMaskLinked') !== false };
    }
  }
  const current = layer.smartFilters;
  const norm = (st: typeof current) => (st && (st.filters.length || !st.enabled) ? filterStackKey({ ...st, mask: st.mask && (st.mask.enabled === false || st.mask.linked === false) ? st.mask : undefined }) : '');
  return norm(stored) === norm(current);
}

/** Writes the prepared stack as PSD (or PSB) bytes. */
export function exportPsd(input: PsdExportInput): PsdExportResult {
  const { width, height } = input;
  const depth = input.depth ?? 8;
  if (width < 1 || height < 1) throw new PsdError('The document is empty.');
  const psb = width > PSD_MAX_DIMENSION || height > PSD_MAX_DIMENSION;
  const records: PsdLayerRecord[] = [];
  let nextId = 0;
  const notes = new Map<string, string[]>();
  const note = (msg: string, name: string) => notes.set(msg, [...(notes.get(msg) ?? []), name]);
  const patternIds = new Set<string>();
  /** Embedded files by uuid (one per contents, shared by linked instances). */
  const linkedFiles = new Map<string, { name: string; bytes: Uint8Array }>();
  const filterItems: FilterEffectsItem[] = [];
  const placedIds = new Set<string>();

  /**
   * A layer's effects block: the block it was read from while the effects still map to the same
   * values (or could not be read and were not changed), else regenerated.
   */
  const effectsBlock = (layer: ImageLayer): PsdTaggedBlock | null => {
    const fx = layer.effects;
    if (!fx) return null;
    for (const e of fx.items) for (const id of usedPatterns(e)) patternIds.add(id);
    const key = layer.type === 'group' ? 'lfxs' : 'lfx2';
    if (fx.psd) {
      const original = parseLfx2(fx.psd.data);
      if (original ? effectsFingerprint(original.effects) === effectsFingerprint(fx) : !fx.items.length) return { key, data: padEven(fx.psd.data) };
    }
    if (!fx.items.length && fx.enabled && (fx.scale ?? 1) === 1) return null;
    const { data, dropped } = writeLfx2(fx);
    if (dropped) note('Only the first outer glow, inner glow, bevel, satin and pattern overlay of a layer can be written; the others were left out', layer.name);
    return { key, data };
  };

  const common = (layer: ImageLayer, extra: PsdTaggedBlock[] = []): Pick<PsdLayerRecord, 'opacity' | 'clipping' | 'flags' | 'legacyName' | 'blocks'> => {
    const name = layer.name || (layer.type === 'adjustment' ? adjustmentKindLabel(layer.kind) : '');
    const blocks: PsdTaggedBlock[] = [{ key: 'luni', data: unicodeBlock(name) }, { key: 'lyid', data: u32Bytes(++nextId) }, ...extra];
    const fx = effectsBlock(layer);
    if (fx) blocks.push(fx);
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
          const m = maskChannel(layer.mask, 0, 0, psb, depth);
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
          const m = maskChannel(layer.mask, 0, 0, psb, depth);
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
          const [r, g, b, a] = surfacePlanes(layer.surface, bounds, depth);
          rec.rect = toRect({ ...bounds, x: bounds.x + layer.offset.x, y: bounds.y + layer.offset.y });
          rec.channels = [
            rleChannel(CHANNEL_ALPHA, a, bounds.width, bounds.height, psb, depth),
            rleChannel(0, r, bounds.width, bounds.height, psb, depth),
            rleChannel(1, g, bounds.width, bounds.height, psb, depth),
            rleChannel(2, b, bounds.width, bounds.height, psb, depth),
          ];
        } else {
          rec.channels = [CHANNEL_ALPHA, 0, 1, 2].map(emptyChannel);
        }
        if (layer.mask) {
          const m = maskChannel(layer.mask, layer.offset.x, layer.offset.y, psb, depth);
          rec.channels.push(m.channel);
          rec.mask = m.mask;
        }
        records.push(rec);
        return;
      }
      case 'smart': {
        const extra: PsdTaggedBlock[] = [];
        if (layer.fillOpacity !== undefined && layer.fillOpacity < 1) {
          extra.push({ key: 'iOpa', data: Uint8Array.from([Math.round(Math.max(0, layer.fillOpacity) * 255), 0, 0, 0]) });
        }
        const c = layer.contents;
        const idnt = psdUuid(c.id);
        if (!linkedFiles.has(idnt)) {
          if (c.linked) note('Linked smart objects were embedded (their preview is written as the contents)', layer.name);
          linkedFiles.set(idnt, smartContentsFile(c));
        }
        let placedId = layer.psd?.placed ?? psdUuid(`${layer.id}:placed`);
        if (placedIds.has(placedId)) placedId = psdUuid(`${layer.id}:placed:${placedIds.size}`);
        placedIds.add(placedId);
        if (placedUnchanged(layer, idnt, placedId)) {
          extra.push({ key: layer.psd!.key, data: padEven(layer.psd!.data) });
        } else {
          const dropped: string[] = [];
          const filterFX = layer.smartFilters ? filterFXDescriptor(layer.smartFilters, dropped) : undefined;
          if (dropped.length) note('Develop smart filters have no Photoshop filter and were left out of the filter list (the layer’s pixels still show them)', layer.name);
          const raw = layer.psd && layer.psd.key !== 'PlLd' ? parsePlaced(layer.psd.key, layer.psd.data) : null;
          const spec = { idnt, placed: placedId, placement: layer.placement, size: { width: c.width, height: c.height }, filterFX, template: raw?.descriptor };
          const wnotes: string[] = [];
          extra.push({ key: 'PlLd', data: plldBytes(spec) }, { key: 'SoLd', data: soldBytes(spec, wnotes) });
          for (const n of wnotes) note(`A smart object: ${n}`, layer.name);
        }
        const fm = layer.smartFilters?.mask;
        if (fm && !fm.source) filterItems.push(filterMaskItem(placedId, fm, { x: 0, y: 0, width, height }));
        const rec: PsdLayerRecord = { ...common(layer, extra), rect: EMPTY_RECT, channels: [], blendKey: BLEND_TO_PSD[layer.blend] ?? 'norm' };
        const bounds = contentBounds(layer.surface);
        if (bounds) {
          const [r, g, b, a] = surfacePlanes(layer.surface, bounds, depth);
          rec.rect = toRect(bounds);
          rec.channels = [
            rleChannel(CHANNEL_ALPHA, a, bounds.width, bounds.height, psb, depth),
            rleChannel(0, r, bounds.width, bounds.height, psb, depth),
            rleChannel(1, g, bounds.width, bounds.height, psb, depth),
            rleChannel(2, b, bounds.width, bounds.height, psb, depth),
          ];
        } else {
          rec.channels = [CHANNEL_ALPHA, 0, 1, 2].map(emptyChannel);
        }
        if (layer.mask) {
          const m = maskChannel(layer.mask, 0, 0, psb, depth);
          rec.channels.push(m.channel);
          rec.mask = m.mask;
        }
        records.push(rec);
        return;
      }
      case 'shape':
      case 'type': {
        const extra: PsdTaggedBlock[] = [];
        if (layer.fillOpacity !== undefined && layer.fillOpacity < 1) {
          extra.push({ key: 'iOpa', data: Uint8Array.from([Math.round(Math.max(0, layer.fillOpacity) * 255), 0, 0, 0]) });
        }
        if (layer.type === 'shape') {
          const losses = new Set<string>();
          for (const b of shapeBlocks(layer, width, height, input.resolution ?? 72, losses)) extra.push({ key: b.key, data: padEven(b.data) });
          for (const n of losses) note(n, layer.name);
          if (layer.fill?.type === 'pattern') patternIds.add(layer.fill.patternId);
          if (layer.stroke?.paint.type === 'pattern') patternIds.add(layer.stroke.paint.patternId);
        } else {
          extra.push({ key: 'TySh', data: padEven(tyShForLayer(layer)) });
        }
        const rec: PsdLayerRecord = { ...common(layer, extra), rect: EMPTY_RECT, channels: [], blendKey: BLEND_TO_PSD[layer.blend] ?? 'norm' };
        const bounds = contentBounds(layer.surface);
        if (bounds) {
          const [r, g, b, a] = surfacePlanes(layer.surface, bounds, depth);
          rec.rect = toRect(bounds);
          rec.channels = [
            rleChannel(CHANNEL_ALPHA, a, bounds.width, bounds.height, psb, depth),
            rleChannel(0, r, bounds.width, bounds.height, psb, depth),
            rleChannel(1, g, bounds.width, bounds.height, psb, depth),
            rleChannel(2, b, bounds.width, bounds.height, psb, depth),
          ];
        } else {
          rec.channels = [CHANNEL_ALPHA, 0, 1, 2].map(emptyChannel);
        }
        if (layer.mask) {
          const m = maskChannel(layer.mask, 0, 0, psb, depth);
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
  const planes = (transparent ? [r, g, b, a] : [r, g, b]).map((p) => planeAtDepth(p, depth));
  const planeBytes = n * (depth >> 3);
  const merged = new Uint8Array(planeBytes * planes.length);
  planes.forEach((p, i) => merged.set(p, i * planeBytes));

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
  if (input.globalLight) {
    const i32 = (v: number) => {
      const w = new PsdWriter();
      w.i32(Math.round(v));
      return w.result();
    };
    resources.push({ id: 1037, name: '', data: i32(input.globalLight.angle) }, { id: 1049, name: '', data: i32(input.globalLight.altitude) });
  }
  // The patterns the effects use, so Photoshop can draw them.
  const globalBlocks: PsdTaggedBlock[] = [];
  if (patternIds.size) {
    const byId = new Map((input.patterns ?? []).map((p) => [p.id, p]));
    const embed: EffectPattern[] = [];
    for (const id of patternIds) {
      const p = byId.get(id) ?? builtinPattern(id);
      if (p) embed.push(p);
      else note(`Pattern "${id}" is not in the document and was not embedded`, id);
    }
    if (embed.length) globalBlocks.push({ key: 'Patt', data: writePatternBlock(embed) });
  }
  // Smart object contents, each embedded once, and the smart filter masks.
  if (linkedFiles.size) {
    const parts = [...linkedFiles].map(([uuid, f]) => encodeLinkedFile({ uuid, name: f.name, bytes: f.bytes }));
    const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      data.set(p, at);
      at += p.length;
    }
    globalBlocks.push({ key: 'lnk2', data });
  }
  if (filterItems.length) globalBlocks.push({ key: 'FEid', data: writeFilterEffects(filterItems) });

  const bytes = writePsd(
    {
      header: { psb, channels: planes.length, width, height, depth, colorMode: 3 },
      colorModeData: new Uint8Array(0),
      resources,
      layers: records,
      mergedAlpha: transparent && records.length > 0,
      globalBlocks,
      imageCompression: depth === 32 ? 0 : 1,
      imageData: depth === 32 ? merged : encodeRle(merged, { planes: planes.length, width, height, depth, psb }),
    },
    encodeLegacyName
  );
  const warnings = [...notes].map(([msg, names]) => `${msg} (${names.map((n) => `"${n}"`).join(', ')}).`);
  return { bytes, psb, records: records.length, warnings };
}
