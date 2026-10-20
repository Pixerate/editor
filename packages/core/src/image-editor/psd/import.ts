// Portions ported from photocraft/crates/io/src/psd_import.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * PSD / PSB → our layer tree. Everything the model holds maps directly (smart objects with their
 * embedded contents, placement, warp, smart filters and filter mask; shape layers with their
 * paths, fill, stroke and live shapes; type layers with their text, styles and Photoshop's pixels
 * until edited); everything else comes in as close as it can (fill layers as their stored pixels)
 * with a warning naming the layers.
 */

import type { BlendMode } from '../blend';
import { emptySurface, surfaceFromPixels, translateSurface } from '../../raster/surface';
import { decodePng } from '../../raster/png';
import type { GroupLayer, ImageLayer, LayerBlendMode, LayerLocks, PixelLayer, RasterMask, ShapeLayer, SmartContents, SmartObjectLayer, SmartPlacement, TypeLayer } from '../layers/model';
import { renderShape } from '../layers/shape';
import { SHAPE_PSD_KEYS, shapeFromBlocks, shapeSignature } from './shapes';
import { typeFromTySh, typeSignature } from './type';
import { mapWarpMeshPoints } from '../../geom/warp';
import { boxQuad } from '../../geom/homography';
import {
  FILTER_EFFECTS_KEYS,
  LINKED_FILE_KEYS,
  PLACED_KEYS,
  fileTypeOf,
  filterMaskFromItem,
  parseFilterEffects,
  parseLinkedFiles,
  parsePlaced,
  placementFromPlaced,
  smartFiltersFromPsd,
  BROWSER_IMAGE_TYPES,
  type FilterEffectsItem,
  type PsdLinkedFile,
  type PsdPlaced,
} from './smart';
import { descBool } from './descriptor';
import { ADJUSTMENT_KEYS, adjustmentLabel, parseAdjustmentBlock } from './adjust';
import { PsdError } from './binary';
import {
  CHANNEL_ALPHA,
  CHANNEL_REAL_USER_MASK,
  CHANNEL_USER_MASK,
  COLOR_MODES,
  LAYER_FLAG_HIDDEN,
  MASK_FLAG_DISABLED,
  MASK_FLAG_UNLINKED,
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
import { MODE_BITMAP, MODE_CMYK, MODE_INDEXED, MODE_LAB, colorChannelCount, toMask8, toRgba8, toRgbaDeep, unmatteWhite } from './pixels';
import { Transform, builtinProfile, parseProfile, srgbProfile, type Profile } from '../../cms';
import type { DocumentColorProfile } from '../color-management';
import { surfaceFromDeepPixels } from '../../raster/deep';
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

const FILL_KEYS = ['SoCo', 'GdFl', 'PtFl', 'vscg'];
const TYPE_KEYS = ['TySh', 'tySh'];
const SMART_KEYS = ['SoLd', 'SoLE', 'PlLd'];
const VECTOR_KEYS = ['vmsk', 'vsms'];

/** What happened to one PSD layer on import. */
export interface PsdLayerSummary {
  name: string;
  /** Our layer type, or `null` when the layer was dropped. */
  type: 'pixel' | 'adjustment' | 'group' | 'smart' | 'shape' | 'type' | null;
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
  /** The embedded ICC profile (image resource 1039), raw bytes, when the file has one. */
  iccProfile?: Uint8Array;
  /** CMYK and Lab files: the mode (and CMYK profile) their pixels were converted from, to write them back. */
  sourceMode?: { mode: 'cmyk'; profile: DocumentColorProfile } | { mode: 'lab' };
  /** The bits per channel the layers keep: 16 or 32 for such files (not indexed or bitmap), else 8. */
  bitDepth: 8 | 16 | 32;
}

export interface PsdImportOptions {
  /** Makes layer ids (defaults to `psd-<n>`). */
  newId?: (hint: string) => string;
  /** Skip decoding pixels (inspection only). */
  skipPixels?: boolean;
  /** @internal How deep inside smart object contents this file is (nested PSB files). */
  depth?: number;
}

/** Smart object contents nest at most this deep (a PSB inside a PSB inside …). */
const MAX_CONTENTS_DEPTH = 6;

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
  /** Embedded and linked files by uuid (`lnk2` / `lnk3` / `lnkD`). */
  linked: Map<string, PsdLinkedFile>;
  /** Filter-effects items (smart filter masks) by instance id. */
  filterItems: Map<string, FilterEffectsItem>;
  /** Contents read so far by uuid (`null`: could not be read). */
  contents: Map<string, SmartContents | null>;
  depth: number;
  /** Pixels per inch (for lengths stored in points). */
  dpi: number;
  /** CMYK files: ink → sRGB through the file's (or the default) CMYK profile. */
  cmykToRgb?: (ink: Uint8Array, out: Uint8ClampedArray) => void;
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
  const set = {
    width,
    height,
    depth: ctx.file.header.depth,
    mode: ctx.file.header.colorMode,
    color: planes.slice(0, ctx.colorCount) as Array<Uint8Array | undefined>,
    alpha: planes[ctx.colorCount] as Uint8Array | undefined,
    palette: ctx.palette,
    cmykToRgb: ctx.cmykToRgb,
  };
  // 16- and 32-bit files keep their depth (see `raster/deep`).
  // CMYK goes through its colour profile at 8 bits (deep CMYK is not kept yet).
  const deep = set.cmykToRgb ? null : toRgbaDeep(set);
  if (deep) return surfaceFromDeepPixels({ width, height, data: deep }, 4, rec.rect.left, rec.rect.top);
  return surfaceFromPixels({ width, height, data: toRgba8(set) }, 4, rec.rect.left, rec.rect.top);
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
  if (flags & MASK_FLAG_UNLINKED) mask.linked = false;
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
  if (kind === 'smart-object' && ctx.skipPixels) {
    // Inspection: say what it would become without reading the contents.
    const block = PLACED_KEYS.map((k) => rec.blocks.find((b) => b.key === k)).find(Boolean);
    const placed = block ? parsePlaced(block.key, block.data) : null;
    if (placed) {
      const file = ctx.linked.get(placed.idnt);
      if (!file || file.kind !== 'liFD') notes.push('linked contents come in as the stored pixels');
      entry.type = 'smart';
      entry.status = notes.length ? 'approximated' : 'mapped';
      return { type: 'pixel', id: ctx.newId(name), ...props, surface: emptySurface(4), offset: { x: 0, y: 0 } };
    }
  }
  if (kind === 'smart-object' && !ctx.skipPixels) {
    const smart = importSmart(ctx, rec, name, notes, props);
    if (smart) {
      entry.type = 'smart';
      entry.id = smart.id;
      entry.status = notes.length ? 'approximated' : 'mapped';
      return smart;
    }
  }
  if (kind === 'shape') {
    const shape = importShape(ctx, rec, name, notes, props);
    if (shape) {
      entry.type = 'shape';
      entry.id = shape.id;
      entry.status = notes.length ? 'approximated' : 'mapped';
      return shape;
    }
  }
  if (kind === 'type') {
    const type = importType(ctx, rec, name, notes, props);
    if (type) {
      entry.type = 'type';
      entry.id = type.id;
      entry.status = notes.length ? 'approximated' : 'mapped';
      return type;
    }
  }
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

/** A shape layer from its vector blocks, drawn from the paths (`null`: no readable path; it comes in as pixels). */
function importShape(ctx: Ctx, rec: PsdLayerRecord, name: string, notes: string[], props: ReturnType<typeof baseProps>): ShapeLayer | null {
  const approx = new Set<string>();
  const { width, height } = ctx.file.header;
  const data = shapeFromBlocks(rec.blocks, width, height, ctx.dpi, approx);
  if (!data) return null;
  for (const n of approx) {
    ctx.warn.add(`A shape layer was approximated: ${n}`, name);
    notes.push(n);
  }
  const layer: ShapeLayer = {
    type: 'shape',
    id: ctx.newId(name),
    ...props,
    components: data.components,
    fill: data.fill,
    stroke: data.stroke,
    surface: emptySurface(4),
    offset: { x: 0, y: 0 },
  };
  if (data.inverted) layer.inverted = true;
  if (!ctx.skipPixels) layer.surface = renderShape(layer, { width, height, pattern: (id) => ctx.patterns.get(id) ?? null });
  layer.psd = { blocks: rec.blocks.filter((b) => SHAPE_PSD_KEYS.includes(b.key)).map((b) => ({ key: b.key, data: b.data.slice() })), signature: shapeSignature(layer) };
  const fill = u8Block(rec, 'iOpa');
  if (fill !== undefined && fill < 255) layer.fillOpacity = percent(fill);
  const effects = recordEffects(ctx, rec, name, notes, false);
  if (effects) layer.effects = effects;
  const mask = recordMask(ctx, rec, name);
  if (mask) layer.mask = mask;
  return layer;
}

/**
 * A type layer from its `TySh` block, showing Photoshop's pixels until it is edited (then our
 * shaper draws it, with any missing fonts replaced). `null`: the block can't be read.
 */
function importType(ctx: Ctx, rec: PsdLayerRecord, name: string, notes: string[], props: ReturnType<typeof baseProps>): TypeLayer | null {
  const block = rec.blocks.find((b) => b.key === 'TySh' || b.key === 'tySh');
  if (!block || block.key !== 'TySh') return null;
  const approx = new Set<string>();
  const data = typeFromTySh(block.data, approx);
  if (!data) return null;
  for (const n of approx) {
    ctx.warn.add(`A type layer was approximated: ${n}`, name);
    notes.push(n);
  }
  const layer: TypeLayer = {
    type: 'type',
    id: ctx.newId(name),
    ...props,
    text: data.text,
    runs: data.runs,
    paragraphs: data.paragraphs,
    frame: data.frame,
    transform: data.transform,
    surface: recordPixels(ctx, rec, name),
    offset: { x: 0, y: 0 },
    rendering: 'stored',
  };
  if (!data.antiAlias) layer.antiAlias = false;
  // The pixels are in layer space: `recordPixels` placed them at the record's rectangle already.
  layer.psd = { tySh: block.data.slice(), signature: typeSignature(layer) };
  const fill = u8Block(rec, 'iOpa');
  if (fill !== undefined && fill < 255) layer.fillOpacity = percent(fill);
  const effects = recordEffects(ctx, rec, name, notes, false);
  if (effects) layer.effects = effects;
  const mask = recordMask(ctx, rec, name);
  if (mask) layer.mask = mask;
  return layer;
}

/** The contents a placed layer points at (memoised by uuid), or `null` when they are not embedded or cannot be read. */
function contentsFor(ctx: Ctx, placed: PsdPlaced, name: string, notes: string[]): SmartContents | null {
  const memo = ctx.contents.get(placed.idnt);
  if (memo !== undefined) return memo;
  const file = ctx.linked.get(placed.idnt);
  let out: SmartContents | null = null;
  if (file && file.kind === 'liFD' && file.bytes.length) {
    const t = fileTypeOf(file.bytes);
    const base = { id: placed.idnt, name: file.name || `${name}.${t.ext}`, file: { bytes: file.bytes.slice(), type: t.ext } };
    try {
      if (t.ext === 'psd' || t.ext === 'psb') {
        if (ctx.depth + 1 > MAX_CONTENTS_DEPTH) throw new PsdError('the contents nest too deep');
        const nested = psdToLayers(readPsd(file.bytes), { newId: ctx.newId, depth: ctx.depth + 1 });
        for (const w of nested.warnings) ctx.warn.add(`In its contents: ${w.replace(/\.$/, '')}`, name);
        out = {
          ...base,
          kind: 'document',
          width: nested.width,
          height: nested.height,
          document: { layers: nested.layers, globalLight: nested.globalLight, patterns: nested.patterns.length ? nested.patterns : undefined },
        };
      } else if (t.ext === 'png') {
        const png = decodePng(file.bytes);
        out = { ...base, kind: 'raster', width: png.width, height: png.height, raster: surfaceFromPixels(png, 4, 0, 0) };
      } else {
        const size = placed.size ?? { width: 0, height: 0 };
        if (!(size.width > 0 && size.height > 0)) throw new PsdError('the contents have no stored size');
        out = { ...base, kind: 'raster', width: Math.round(size.width), height: Math.round(size.height) };
        if (BROWSER_IMAGE_TYPES[t.ext]) {
          ctx.warn.add(`Smart object contents in ${t.ext.toUpperCase()} format are decoded only in a browser (prepareSmartObjects); until then the layer shows its stored pixels and cannot be re-rendered`, name);
        } else {
          ctx.warn.add(`Smart object contents of an unsupported type (${t.ext === 'bin' ? 'unknown' : t.ext.toUpperCase()}) are kept for export, but the layer shows its stored pixels and cannot be re-rendered`, name);
        }
        notes.push(`${t.ext} contents not decoded here`);
      }
    } catch (e) {
      ctx.warn.add(`Smart object contents could not be read (${e instanceof Error ? e.message : String(e)}); the layer came in as its stored pixels`, name);
      notes.push('contents could not be read');
      out = null;
    }
  }
  ctx.contents.set(placed.idnt, out);
  return out;
}

/**
 * A placed layer (`SoLd` / `SoLE` / `PlLd`) as a smart object: its embedded contents, placement,
 * smart filters and filter mask, with the layer's stored pixels as the rendered result (exactly
 * what Photoshop drew). Linked (external) contents come in as the stored pixels, placed 1:1.
 * Returns `null` when the block cannot be read (the layer then comes in as pixels).
 */
function importSmart(ctx: Ctx, rec: PsdLayerRecord, name: string, notes: string[], props: ReturnType<typeof baseProps>): SmartObjectLayer | null {
  const block = PLACED_KEYS.map((k) => rec.blocks.find((b) => b.key === k)).find(Boolean);
  if (!block) return null;
  const placed = parsePlaced(block.key, block.data);
  if (!placed) return null;
  const surface = recordPixels(ctx, rec, name);
  let contents = placed.idnt ? contentsFor(ctx, placed, name, notes) : null;
  let placement: SmartPlacement | null = null;
  let preview = false;
  if (contents) {
    const size = placed.size ?? { width: contents.width, height: contents.height };
    const pnotes: string[] = [];
    placement = placementFromPlaced(placed, size, pnotes);
    for (const n of pnotes) {
      ctx.warn.add(`A smart object's placement was approximated: ${n}`, name);
      notes.push(n);
    }
    if (placement && (size.width !== contents.width || size.height !== contents.height)) {
      // The stored size is in the document's units; the warp is in them too.
      const kx = contents.width / size.width;
      const ky = contents.height / size.height;
      if (placement.warp) placement = { ...placement, warp: mapWarpMeshPoints(placement.warp, (p) => ({ x: p.x * kx, y: p.y * ky })) };
    }
  }
  if (!contents || !placement) {
    // Linked to an external file, or contents we cannot read: the stored pixels, placed 1:1.
    const b = surface.bounds;
    const { width, height } = rectSize(rec.rect);
    if (!b || !(width > 0 && height > 0)) return null;
    const file = ctx.linked.get(placed.idnt);
    contents = {
      id: placed.idnt || ctx.newId(`${name}-contents`),
      name: file?.name || `${name}.png`,
      width,
      height,
      kind: 'raster',
      raster: translateSurface(surface, -rec.rect.left, -rec.rect.top),
    };
    if (file && file.kind !== 'liFD') {
      contents.linked = { path: file.path ?? file.name };
      ctx.warn.add(`Linked smart objects came in as their embedded preview; the linked file is not read`, name);
      notes.push(`linked to "${file.path ?? file.name}"`);
    } else if (!notes.includes('contents could not be read')) {
      ctx.warn.add('A smart object without readable contents came in with its stored pixels as contents', name);
      notes.push('contents missing');
    }
    placement = { corners: boxQuad({ x: rec.rect.left, y: rec.rect.top, width, height }) };
    preview = true;
  }
  const layer: SmartObjectLayer = { type: 'smart', id: ctx.newId(name), ...props, contents, placement, surface, offset: { x: 0, y: 0 } };
  const fill = u8Block(rec, 'iOpa');
  if (fill !== undefined && fill < 255) layer.fillOpacity = percent(fill);
  const effects = recordEffects(ctx, rec, name, notes, false);
  if (effects) layer.effects = effects;
  const mask = recordMask(ctx, rec, name);
  if (mask) layer.mask = mask;
  if (placed.filterFX) {
    const fnotes: string[] = [];
    let n = 0;
    const stack = smartFiltersFromPsd(placed.filterFX, () => `${layer.id}-flt-${++n}`, fnotes);
    if (preview) {
      // The stored pixels already show the filters: keep them listed, never applied twice.
      stack.filters = stack.filters.map((f) => (f.kind === 'psd' ? f : { ...f, enabled: false }));
    }
    for (const note of fnotes) {
      ctx.warn.add(`Smart filters were approximated: ${note}`, name);
      notes.push(note);
    }
    const item = ctx.filterItems.get(placed.placed);
    const fm = item ? filterMaskFromItem(item) : null;
    if (fm) {
      if (descBool(placed.filterFX, 'filterMaskEnable') === false) fm.enabled = false;
      if (descBool(placed.filterFX, 'filterMaskLinked') === false) fm.linked = false;
      stack.mask = fm;
    }
    if (stack.filters.length || stack.mask || !stack.enabled) layer.smartFilters = stack;
  }
  layer.psd = { key: block.key, data: block.data.slice(), placed: placed.placed || undefined };
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
  const set = {
    width,
    height,
    depth: header.depth,
    mode: header.colorMode,
    color: Array.from({ length: cc }, (_, i) => plane(i)),
    alpha: hasAlpha ? plane(cc) : undefined,
    palette: ctx.palette,
    cmykToRgb: ctx.cmykToRgb,
  };
  const deep = hasAlpha || set.cmykToRgb ? null : toRgbaDeep(set);
  let surface: PixelLayer['surface'];
  if (deep) surface = surfaceFromDeepPixels({ width, height, data: deep }, 4);
  else {
    const data = toRgba8(set);
    if (hasAlpha) unmatteWhite(data);
    surface = surfaceFromPixels({ width, height, data }, 4);
  }
  return {
    type: 'pixel',
    id: ctx.newId('Background'),
    name: 'Background',
    visible: true,
    opacity: 1,
    blend: 'normal',
    surface,
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
    linked: new Map(),
    filterItems: new Map(),
    contents: new Map(),
    depth: options.depth ?? 0,
    dpi: resolution(file) ?? 72,
  };
  // CMYK through a colour profile: the file's own, else the default coated CMYK.
  let cmykProfile: DocumentColorProfile | null = null;
  if (header.colorMode === MODE_CMYK && !ctx.skipPixels) {
    const icc = resource(file, 1039);
    let src: Profile | null = null;
    if (icc) {
      try {
        const p = parseProfile(icc);
        if (p.colorSpace === 'cmyk') {
          src = p;
          cmykProfile = { name: p.description || 'Embedded CMYK profile', icc: icc.slice() };
        } else warn.extra.push(`The CMYK file embeds a ${p.colorSpace.toUpperCase()} profile; the default coated CMYK profile was used.`);
      } catch (e) {
        warn.extra.push(`The CMYK profile could not be read (${e instanceof Error ? e.message : String(e)}); the default coated CMYK profile was used.`);
      }
    }
    if (!src) {
      src = builtinProfile('coated-cmyk');
      cmykProfile = { builtin: 'coated-cmyk', name: src.description };
    }
    const t = Transform.create(src, srgbProfile(), { intent: 'relative', bpc: true });
    ctx.cmykToRgb = (ink, out) => t.convert8(ink, 4, out, 4, false);
  }
  for (const block of file.globalBlocks) {
    if (LINKED_FILE_KEYS.includes(block.key)) for (const f of parseLinkedFiles(block.data)) if (!ctx.linked.has(f.uuid)) ctx.linked.set(f.uuid, f);
    if (FILTER_EFFECTS_KEYS.includes(block.key)) {
      try {
        for (const it of parseFilterEffects(block.data).items) ctx.filterItems.set(it.id, it);
      } catch (e) {
        warn.extra.push(`The smart filter masks could not be read (${e instanceof Error ? e.message : String(e)}); they reveal everything.`);
      }
    }
  }
  for (const block of file.globalBlocks) {
    if (!PATTERN_BLOCK_KEYS.includes(block.key)) continue;
    try {
      for (const p of parsePatternBlock(block.data)) ctx.patterns.set(p.id, psdPatternToEffectPattern(p));
    } catch (e) {
      warn.extra.push(`The file's patterns could not be read (${e instanceof Error ? e.message : String(e)}); pattern effects paint nothing.`);
    }
  }
  const mode = COLOR_MODES[header.colorMode] ?? `mode ${header.colorMode}`;
  if (mode !== 'rgb' && header.depth > 8 && header.colorMode !== MODE_INDEXED && header.colorMode !== MODE_BITMAP) {
    warn.extra.push(`The file is ${header.depth}-bit ${mode}; it was converted to ${header.depth}-bit RGB.`);
  } else if (mode !== 'rgb' || (header.depth !== 8 && header.depth !== 16 && header.depth !== 32)) {
    const how = header.colorMode === MODE_CMYK ? ` through ${cmykProfile?.name ?? 'its profile'}` : '';
    warn.extra.push(`The file is ${header.depth}-bit ${mode}; it was converted to 8-bit RGB${how}.`);
  }

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
    ...(cmykProfile ? { sourceMode: { mode: 'cmyk' as const, profile: cmykProfile } } : header.colorMode === MODE_LAB ? { sourceMode: { mode: 'lab' as const } } : {}),
    ...(resource(file, 1039) ? { iccProfile: resource(file, 1039)!.slice() } : {}),
    bitDepth: (header.depth === 16 || header.depth === 32) && header.colorMode !== MODE_INDEXED && header.colorMode !== MODE_BITMAP ? header.depth : 8,
  };
}

/** Parses and maps PSD / PSB bytes. Throws `PsdError` for files that cannot be read at all. */
export function importPsd(bytes: Uint8Array, options: PsdImportOptions = {}): PsdImportResult {
  if (bytes.length < 26) throw new PsdError('Not a PSD file: it is shorter than a PSD header.');
  return psdToLayers(readPsd(bytes), options);
}
