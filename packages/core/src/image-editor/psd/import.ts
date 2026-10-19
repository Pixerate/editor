// Portions ported from photocraft/crates/io/src/psd_import.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * PSD / PSB → our layer tree. Everything the model holds maps directly; everything else comes in
 * as close as it can (type, smart-object, fill and shape layers as their stored pixels) with a
 * warning naming the layers.
 */

import type { BlendMode } from '../blend';
import { emptySurface, surfaceFromPixels } from '../../raster/surface';
import type { GroupLayer, ImageLayer, LayerBlendMode, LayerLocks, PixelLayer, RasterMask } from '../layers/model';
import { ADJUSTMENT_KEYS, adjustmentLabel, parseAdjustmentBlock } from './adjust';
import { PsdError } from './binary';
import {
  CHANNEL_ALPHA,
  CHANNEL_REAL_USER_MASK,
  CHANNEL_USER_MASK,
  COLOR_MODES,
  LAYER_FLAG_HIDDEN,
  MASK_FLAG_DISABLED,
  SECTION_CLOSED,
  type PsdFile,
  type PsdLayerRecord,
  type PsdRect,
  type PsdTreeNode,
  decodeLayerChannel,
  decodeMergedImage,
  layerBlock,
  layerName,
  layerTree,
  readPsd,
  rectSize,
  resolution,
  resource,
  rowBytes,
  sectionDivider,
  u32Block,
  u8Block,
} from './file';
import { MODE_INDEXED, colorChannelCount, toMask8, toRgba8, unmatteWhite } from './pixels';
import { parseLfx2, parseLrfx } from './effects';
import { PATTERN_BLOCK_KEYS, parsePatternBlock, psdPatternToEffectPattern } from './patterns';
import { builtinPattern, type EffectPattern } from '../../raster/effects/patterns';
import type { GlobalLight, LayerEffect, LayerEffects } from '../../raster/effects/model';

/** PSD blend keys → our blend modes (`diss` is the one we lack). */
export const PSD_BLEND_KEYS: Record<string, LayerBlendMode> = {
  pass: 'pass-through',
  norm: 'normal',
  dark: 'darken',
  'mul ': 'multiply',
  idiv: 'color-burn',
  lbrn: 'linear-burn',
  dkCl: 'darker-color',
  lite: 'lighten',
  scrn: 'screen',
  'div ': 'color-dodge',
  lddg: 'linear-dodge',
  lgCl: 'lighter-color',
  over: 'overlay',
  sLit: 'soft-light',
  hLit: 'hard-light',
  vLit: 'vivid-light',
  lLit: 'linear-light',
  pLit: 'pin-light',
  hMix: 'hard-mix',
  diff: 'difference',
  smud: 'exclusion',
  fsub: 'subtract',
  fdiv: 'divide',
  'hue ': 'hue',
  'sat ': 'saturation',
  colr: 'color',
  'lum ': 'luminosity',
};

/** Our blend modes → PSD keys. `pigment` has none (export writes `norm`, see `toPsd`). */
export const BLEND_TO_PSD: Partial<Record<LayerBlendMode, string>> = Object.fromEntries(
  Object.entries(PSD_BLEND_KEYS).map(([k, v]) => [v, k])
) as Partial<Record<LayerBlendMode, string>>;

const FILL_KEYS = ['SoCo', 'GdFl', 'PtFl'];
const TYPE_KEYS = ['TySh', 'tySh'];
const SMART_KEYS = ['SoLd', 'SoLE', 'PlLd'];
const VECTOR_KEYS = ['vmsk', 'vsms'];

/** What happened to one PSD layer on import. */
export interface PsdLayerSummary {
  name: string;
  /** Our layer type, or `null` when the layer was dropped. */
  type: 'pixel' | 'adjustment' | 'group' | null;
  /** `mapped`: held exactly; `approximated`: imported with losses; `dropped`: left out. */
  status: 'mapped' | 'approximated' | 'dropped';
  /** What Photoshop calls it (`pixel`, `type`, `smart-object`, `fill`, `shape`, `Levels` …). */
  psdKind: string;
  /** Why it is not `mapped`. */
  notes: string[];
  /** Our layer id (when imported). */
  id?: string;
  depth: number;
}

export interface PsdImportResult {
  width: number;
  height: number;
  /** Bottom to top, as in our model. */
  layers: ImageLayer[];
  /** One sentence per problem, naming the affected layers. */
  warnings: string[];
  /** Every PSD layer, bottom first, a group before its children. */
  summary: PsdLayerSummary[];
  /** Pixels per inch, when the file says. */
  resolution?: number;
  /** The patterns embedded in the file (`Patt` / `Pat2` / `Pat3`), which pattern effects use. */
  patterns: EffectPattern[];
  /** The global light (image resources 1037 and 1049), when the file has one. */
  globalLight?: GlobalLight;
  info: { psb: boolean; depth: number; colorMode: string; channels: number };
}

export interface PsdImportOptions {
  /** Makes layer ids (defaults to `psd-<n>`). */
  newId?: (hint: string) => string;
  /** Skip decoding pixels (inspection only). */
  skipPixels?: boolean;
}

/** A PSD byte (0..255) as the whole percent Photoshop shows, 0..1. */
const percent = (v: number) => Math.round((v / 255) * 100) / 100;

class Warnings {
  private groups = new Map<string, string[]>();
  readonly extra: string[] = [];

  add(message: string, layer: string): void {
    const list = this.groups.get(message) ?? [];
    if (!list.includes(layer)) list.push(layer);
    this.groups.set(message, list);
  }

  list(): string[] {
    const out = [...this.extra];
    for (const [message, layers] of this.groups) {
      const names = layers.map((n) => `"${n}"`);
      const shown = names.length > 6 ? `${names.slice(0, 6).join(', ')} and ${names.length - 6} more` : names.join(', ');
      out.push(`${message} (${layers.length === 1 ? 'layer' : 'layers'} ${shown}).`);
    }
    return out;
  }
}

function psdKind(rec: PsdLayerRecord): string {
  if (rec.blocks.some((b) => TYPE_KEYS.includes(b.key))) return 'type';
  if (rec.blocks.some((b) => SMART_KEYS.includes(b.key))) return 'smart-object';
  const fill = rec.blocks.some((b) => FILL_KEYS.includes(b.key));
  const vector = rec.blocks.some((b) => VECTOR_KEYS.includes(b.key) || b.key === 'vstk');
  if (fill && vector) return 'shape';
  if (fill) return 'fill';
  const adj = rec.blocks.find((b) => ADJUSTMENT_KEYS.includes(b.key));
  if (adj) return adjustmentLabel(adj.key);
  return 'pixel';
}

function locksOf(rec: PsdLayerRecord): LayerLocks | undefined {
  const v = u32Block(rec, 'lspf');
  if (!v) return undefined;
  const locks: LayerLocks = {};
  if (v & 0x80000000) locks.all = true;
  if (v & 1) locks.transparency = true;
  if (v & 2) locks.pixels = true;
  if (v & 4) locks.position = true;
  return Object.keys(locks).length ? locks : undefined;
}

interface Ctx {
  file: PsdFile;
  warn: Warnings;
  newId: (hint: string) => string;
  skipPixels: boolean;
  /** Every PSD layer, bottom first, a group before its children. */
  summary: PsdLayerSummary[];
  colorCount: number;
  palette?: Uint8Array;
  patterns: Map<string, EffectPattern>;
}

function decodeOr(ctx: Ctx, rec: PsdLayerRecord, id: number, name: string): Uint8Array | undefined {
  try {
    return decodeLayerChannel(ctx.file, rec, id);
  } catch (e) {
    ctx.warn.add(`A channel could not be decoded (${e instanceof Error ? e.message : String(e)}) and the layer is treated as empty`, name);
    return undefined;
  }
}

/** A rectangle's size, or 0 × 0 (with a warning) for a malformed one. */
function safeSize(ctx: Ctx, rect: PsdRect, name: string): { width: number; height: number } {
  try {
    return rectSize(rect);
  } catch (e) {
    ctx.warn.add(`A malformed rectangle (${e instanceof Error ? e.message : String(e)}) left the layer or its mask empty`, name);
    return { width: 0, height: 0 };
  }
}

function recordPixels(ctx: Ctx, rec: PsdLayerRecord, name: string): PixelLayer['surface'] {
  const { width, height } = safeSize(ctx, rec.rect, name);
  if (!width || !height || ctx.skipPixels) return emptySurface(4);
  const ids = [...Array.from({ length: ctx.colorCount }, (_, i) => i), CHANNEL_ALPHA];
  const planes = ids.map((id) => (rec.channels.some((c) => c.id === id) ? decodeOr(ctx, rec, id, name) ?? null : undefined));
  // A channel that is in the file but unreadable leaves the layer empty (as the warning says).
  if (planes.some((p) => p === null)) return emptySurface(4);
  if (planes.every((p) => p === undefined)) return emptySurface(4);
  const data = toRgba8({
    width,
    height,
    depth: ctx.file.header.depth,
    mode: ctx.file.header.colorMode,
    color: planes.slice(0, ctx.colorCount) as Array<Uint8Array | undefined>,
    alpha: planes[ctx.colorCount] as Uint8Array | undefined,
    palette: ctx.palette,
  });
  return surfaceFromPixels({ width, height, data }, 4, rec.rect.left, rec.rect.top);
}

function recordMask(ctx: Ctx, rec: PsdLayerRecord, name: string): RasterMask | undefined {
  const m = rec.mask;
  if (!m) return undefined;
  const useReal = rec.channels.some((c) => c.id === CHANNEL_REAL_USER_MASK) && m.real;
  const id = useReal ? CHANNEL_REAL_USER_MASK : CHANNEL_USER_MASK;
  if (!rec.channels.some((c) => c.id === id)) return undefined;
  const rect = useReal ? m.real!.rect : m.rect;
  const def: 0 | 255 = (useReal ? m.real!.background : m.defaultColor) >= 128 ? 255 : 0;
  const flags = useReal ? m.real!.flags : m.flags;
  let surface = emptySurface(1, def);
  const { width, height } = safeSize(ctx, rect, name);
  if (width && height && !ctx.skipPixels) {
    const plane = decodeOr(ctx, rec, id, name);
    if (plane) surface = surfaceFromPixels({ width, height, data: toMask8(plane, width, height, ctx.file.header.depth) }, 1, rect.left, rect.top, def);
  }
  const mask: RasterMask = { surface, defaultValue: def };
  if (m.userDensity !== undefined && m.userDensity < 255) mask.density = percent(m.userDensity);
  if (m.userFeather !== undefined && m.userFeather > 0) mask.feather = Math.min(1000, m.userFeather);
  if (flags & MASK_FLAG_DISABLED) mask.enabled = false;
  return mask;
}

function baseProps(ctx: Ctx, rec: PsdLayerRecord, name: string, notes: string[]) {
  let blend = PSD_BLEND_KEYS[rec.blendKey];
  if (rec.blendKey === 'diss') {
    ctx.warn.add('Dissolve is not supported and became Normal', name);
    notes.push('Dissolve became Normal');
  } else if (!blend) {
    ctx.warn.add(`An unknown blend mode became Normal`, name);
    notes.push(`unknown blend mode "${rec.blendKey}"`);
  }
  if (!blend || blend === 'pass-through') blend = 'normal';
  const props = {
    name,
    visible: (rec.flags & LAYER_FLAG_HIDDEN) === 0,
    opacity: percent(rec.opacity),
    blend: blend as BlendMode,
  } as { name: string; visible: boolean; opacity: number; blend: BlendMode; clipped?: boolean; locks?: LayerLocks };
  if (rec.clipping) props.clipped = true;
  const locks = locksOf(rec);
  if (locks) props.locks = locks;
  if (rec.blocks.some((b) => b.key === 'artb' || b.key === 'artd' || b.key === 'abdd')) {
    ctx.warn.add('Artboards are not supported; they came in as plain groups, without their background colour and clipping', name);
    notes.push('artboard imported as a group');
  }
  if (rec.blocks.some((b) => VECTOR_KEYS.includes(b.key)) && psdKind(rec) === 'pixel') {
    ctx.warn.add('Vector masks are not supported and were ignored', name);
    notes.push('vector mask ignored');
  }
  return props;
}

/** Pattern ids an effect paints with. */
function patternIds(e: LayerEffect): string[] {
  if (e.kind === 'pattern-overlay') return [e.patternId];
  if (e.kind === 'stroke' && e.fill.type === 'pattern') return [e.fill.patternId];
  if (e.kind === 'bevel-emboss' && e.texture) return [e.texture.patternId];
  return [];
}

/**
 * A layer's effects: `lmfx` (several instances per kind) over `lfx2` (`lfxs` on groups), else
 * the legacy `lrFX`. The block read is kept so export writes it back while the effects are
 * unchanged; warnings name only what is not drawn exactly.
 */
function recordEffects(ctx: Ctx, rec: PsdLayerRecord, name: string, notes: string[], group: boolean): LayerEffects | undefined {
  const key = ['lmfx', 'lfx2', 'lfxs'].find((k) => layerBlock(rec, k));
  if (key) {
    const data = layerBlock(rec, key)!;
    const parsed = parseLfx2(data);
    if (!parsed) {
      ctx.warn.add('Layer effects could not be read; they are kept for export but not drawn', name);
      notes.push('layer effects could not be read');
      return { enabled: true, items: [], psd: { key, data: data.slice() } };
    }
    for (const n of parsed.notes) {
      ctx.warn.add(`Layer effects were approximated: ${n}`, name);
      notes.push(`effects: ${n}`);
    }
    for (const e of parsed.effects.items) {
      for (const id of patternIds(e)) {
        if (ctx.patterns.has(id) || builtinPattern(id)) continue;
        ctx.warn.add('A pattern effect uses a pattern the file does not contain, and paints nothing', name);
        notes.push(`pattern "${id}" is not in the file`);
      }
    }
    return { ...parsed.effects, psd: { key, data: data.slice() } };
  }
  const legacy = layerBlock(rec, 'lrFX');
  if (legacy && !group) {
    // Photoshop ignores legacy effects on groups.
    const parsed = parseLrfx(legacy);
    if (!parsed) return undefined;
    for (const n of parsed.notes) {
      ctx.warn.add(`Layer effects were approximated: ${n}`, name);
      notes.push(`effects: ${n}`);
    }
    return parsed.effects.items.length ? parsed.effects : undefined;
  }
  return undefined;
}

function importNode(ctx: Ctx, node: PsdTreeNode, depth: number): ImageLayer | null {
  const rec = ctx.file.layers[node.index];
  const name = layerName(rec);
  const notes: string[] = [];
  const kind = psdKind(rec);
  const entry: PsdLayerSummary = { name, type: null, status: 'mapped', psdKind: node.children ? 'group' : kind, notes, depth };
  ctx.summary.push(entry);

  if (node.children) {
    const props = baseProps(ctx, rec, name, notes);
    const divider = sectionDivider(rec);
    const key = divider?.blendKey ?? rec.blendKey;
    const groupBlend: LayerBlendMode = key === 'pass' ? 'pass-through' : (PSD_BLEND_KEYS[key] ?? 'normal');
    const children: ImageLayer[] = [];
    for (const child of node.children) {
      const layer = importNode(ctx, child, depth + 1);
      if (layer) children.push(layer);
    }
    const group: GroupLayer = { type: 'group', id: ctx.newId(name), ...props, blend: groupBlend, children };
    const effects = recordEffects(ctx, rec, name, notes, true);
    if (effects) group.effects = effects;
    if (divider?.kind === SECTION_CLOSED) group.collapsed = true;
    const mask = recordMask(ctx, rec, name);
    if (mask) group.mask = mask;
    entry.type = 'group';
    entry.id = group.id;
    entry.status = notes.length ? 'approximated' : 'mapped';
    return group;
  }

  const adjBlock = rec.blocks.find((b) => ADJUSTMENT_KEYS.includes(b.key));
  if (adjBlock) {
    const parsed = parseAdjustmentBlock(adjBlock.key, adjBlock.data);
    if (!parsed) {
      const label = adjustmentLabel(adjBlock.key);
      ctx.warn.add(`${label} adjustment layers are not supported and were left out`, name);
      notes.push(`${label} is not supported`);
      entry.status = 'dropped';
      return null;
    }
    const props = baseProps(ctx, rec, name, notes);
    if (parsed.approximated) {
      ctx.warn.add(`A ${adjustmentLabel(adjBlock.key)} layer was approximated: ${parsed.approximated}`, name);
      notes.push(parsed.approximated);
    }
    const layer = { type: 'adjustment', id: ctx.newId(name), ...props, kind: parsed.kind, params: parsed.params } as ImageLayer;
    const mask = recordMask(ctx, rec, name);
    if (mask) layer.mask = mask;
    entry.type = 'adjustment';
    entry.id = layer.id;
    entry.status = notes.length ? 'approximated' : 'mapped';
    return layer;
  }

  const props = baseProps(ctx, rec, name, notes);
  if (kind !== 'pixel') {
    const what = kind === 'smart-object' ? 'Smart objects' : kind === 'type' ? 'Type layers' : kind === 'shape' ? 'Shape layers' : 'Fill layers';
    ctx.warn.add(`${what} came in as pixel layers (their stored pixels)`, name);
    notes.push(`${kind} layer imported as pixels`);
  }
  const layer: PixelLayer = { type: 'pixel', id: ctx.newId(name), ...props, surface: recordPixels(ctx, rec, name), offset: { x: 0, y: 0 } };
  const fill = u8Block(rec, 'iOpa');
  if (fill !== undefined && fill < 255) layer.fillOpacity = percent(fill);
  const effects = recordEffects(ctx, rec, name, notes, false);
  if (effects) layer.effects = effects;
  const mask = recordMask(ctx, rec, name);
  if (mask) layer.mask = mask;
  entry.type = 'pixel';
  entry.id = layer.id;
  entry.status = notes.length ? 'approximated' : 'mapped';
  return layer;
}

function mergedLayer(ctx: Ctx): PixelLayer | null {
  const { header } = ctx.file;
  const { width, height } = header;
  let planes: Uint8Array;
  try {
    planes = decodeMergedImage(ctx.file);
  } catch (e) {
    ctx.warn.extra.push(`The merged image could not be decoded (${e instanceof Error ? e.message : String(e)}).`);
    return null;
  }
  const size = rowBytes(width, header.depth) * height;
  const plane = (i: number) => (i < header.channels ? planes.subarray(i * size, (i + 1) * size) : undefined);
  const cc = ctx.colorCount;
  const hasAlpha = header.channels > cc && (ctx.file.layers.length === 0 || ctx.file.mergedAlpha);
  const data = toRgba8({
    width,
    height,
    depth: header.depth,
    mode: header.colorMode,
    color: Array.from({ length: cc }, (_, i) => plane(i)),
    alpha: hasAlpha ? plane(cc) : undefined,
    palette: ctx.palette,
  });
  if (hasAlpha) unmatteWhite(data);
  return {
    type: 'pixel',
    id: ctx.newId('Background'),
    name: 'Background',
    visible: true,
    opacity: 1,
    blend: 'normal',
    surface: surfaceFromPixels({ width, height, data }, 4),
    offset: { x: 0, y: 0 },
  };
}

/** Maps a parsed PSD to our layers. */
export function psdToLayers(file: PsdFile, options: PsdImportOptions = {}): PsdImportResult {
  const { header } = file;
  const warn = new Warnings();
  let n = 0;
  const ctx: Ctx = {
    file,
    warn,
    newId: options.newId ?? (() => `psd-${++n}`),
    skipPixels: options.skipPixels ?? false,
    summary: [],
    colorCount: colorChannelCount(header.colorMode, header.channels),
    palette: header.colorMode === MODE_INDEXED ? file.colorModeData : undefined,
    patterns: new Map(),
  };
  for (const block of file.globalBlocks) {
    if (!PATTERN_BLOCK_KEYS.includes(block.key)) continue;
    try {
      for (const p of parsePatternBlock(block.data)) ctx.patterns.set(p.id, psdPatternToEffectPattern(p));
    } catch (e) {
      warn.extra.push(`The file's patterns could not be read (${e instanceof Error ? e.message : String(e)}); pattern effects paint nothing.`);
    }
  }
  const mode = COLOR_MODES[header.colorMode] ?? `mode ${header.colorMode}`;
  if (mode !== 'rgb' || header.depth !== 8) {
    warn.extra.push(`The file is ${header.depth}-bit ${mode}; it was converted to 8-bit RGB.`);
  }
  if (resource(file, 1039)) warn.extra.push('The embedded ICC profile is ignored; colours are read as sRGB.');

  let layers: ImageLayer[] = [];
  if (file.layers.length) {
    const tree = layerTree(file);
    const built: ImageLayer[] = [];
    for (const node of tree) {
      const layer = importNode(ctx, node, 0);
      if (layer) built.push(layer);
    }
    layers = built;
    if (!layers.length && !ctx.skipPixels) {
      // Every layer was left out: the merged image is still the best picture of the file.
      const bg = mergedLayer(ctx);
      if (bg) {
        layers = [bg];
        warn.extra.push('No layer could be imported, so the merged image was opened as the Background.');
      }
    }
  } else if (!ctx.skipPixels) {
    const bg = mergedLayer(ctx);
    if (bg) layers = [bg];
  }
  const i32 = (b: Uint8Array | undefined) => (b && b.length >= 4 ? new DataView(b.buffer, b.byteOffset, 4).getInt32(0) : undefined);
  const angle = i32(resource(file, 1037));
  const altitude = i32(resource(file, 1049));
  return {
    width: header.width,
    height: header.height,
    layers,
    warnings: warn.list(),
    summary: ctx.summary,
    resolution: resolution(file),
    patterns: [...ctx.patterns.values()],
    ...(angle !== undefined || altitude !== undefined
      ? { globalLight: { angle: Math.max(-360, Math.min(360, angle ?? 120)), altitude: Math.max(0, Math.min(90, altitude ?? 30)) } }
      : {}),
    info: { psb: header.psb, depth: header.depth, colorMode: mode, channels: header.channels },
  };
}

/** Parses and maps PSD / PSB bytes. Throws `PsdError` for files that cannot be read at all. */
export function importPsd(bytes: Uint8Array, options: PsdImportOptions = {}): PsdImportResult {
  if (bytes.length < 26) throw new PsdError('Not a PSD file: it is shorter than a PSD header.');
  return psdToLayers(readPsd(bytes), options);
}
