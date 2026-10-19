// Portions ported from photocraft/crates/engine/src/transform_cmds.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Free Transform sessions: what a transform moves (a layer's pixels with its linked mask, a lone
 * unlinked mask, the selected pixels as a floating piece, a copy of them on a new layer, or just
 * the selection outline), a live preview while the geometry changes, and one undo step when it is
 * committed with full-quality resampling.
 */

import {
  TiledSurface,
  contentBounds,
  readRegion,
  surfaceFromPixels,
  writeRegion,
  type RasterRect,
} from '../raster/surface';
import {
  compositeSurfaceOver,
  reduceSurface,
  transformSurface,
  TransformTooLargeError,
  warpSurface,
  isInterpolation,
  type Interpolation,
  type ResampleOptions,
} from '../raster/transform';
import { multiplyHomographies, type Homography } from '../geom/homography';
import { findLayer, insertLayer, mapLayer, newLayerId, type ImageLayer, type LayerTarget, type PixelLayer, type RasterMask } from './layers/model';
import { LayerOperationError, requireLayer, requireUnlocked } from './layers/ops';
import { createSelectionMask, type SelectionMask } from './selection/mask';
import {
  geometryHomography,
  hasWarp,
  identityTransform,
  isIdentityTransform,
  transformMap,
  type FreeTransformGeometry,
} from './transform';
import type { CropBox } from './types';

/**
 * What a Free Transform moves:
 * - `layer`: the layer's pixels with its linked mask (or, with `channel: 'mask'` on an unlinked
 *   mask, the mask alone);
 * - `selection`: the selected pixels (and the same part of a linked mask), lifted and committed
 *   back into the layer; the selection outline moves with them;
 * - `selection-copy`: Layer via Copy, then the copy is transformed on a new layer above;
 * - `selection-outline`: Transform Selection, only the outline;
 * - `auto` (default): `selection` when something is selected, else `layer`.
 */
export type FreeTransformContent = 'auto' | 'layer' | 'selection' | 'selection-copy' | 'selection-outline';

export const FREE_TRANSFORM_CONTENTS: readonly FreeTransformContent[] = ['auto', 'layer', 'selection', 'selection-copy', 'selection-outline'];

export interface FreeTransformInit {
  /** The layer (default the active one); not needed for `selection-outline`. */
  layerId?: string;
  content?: FreeTransformContent;
  /**
   * `pixels` (default) moves the pixels with a linked mask; `mask` moves an unlinked mask alone (a
   * linked one moves with its pixels). Defaults to the active target on the active layer.
   */
  channel?: LayerTarget;
  /** Resampling of the committed result (default bicubic). */
  interpolation?: Interpolation;
}

/** How a live preview is drawn (the UI knows these, the controller doesn't). */
export interface FreeTransformPreview {
  /** Screen pixels per document pixel: below 1 the preview samples a reduced copy in blocks. */
  scale?: number;
  /** Only this part of the document (the visible area) is resampled. */
  clip?: CropBox;
}

/** What a committed transform changed. */
export interface FreeTransformResult {
  /** The layer that holds the result (the new layer for `selection-copy`; `null` for `selection-outline`). */
  layerId: string | null;
  content: Exclude<FreeTransformContent, 'auto'>;
  /** What moved. */
  moved: Array<'pixels' | 'mask' | 'selection'>;
  /** The frame the transform started from (document pixels). */
  box: CropBox;
  /** Where the frame's corners went. */
  corners: FreeTransformGeometry['corners'];
  /** Document bounds of the moved content after the transform (pixels, or the mask or the outline). */
  bounds: CropBox | null;
  /** False when the geometry was the identity and nothing was recorded. */
  changed: boolean;
}

/** @internal What the session needs from the controller. */
export interface FreeTransformHost {
  layers(): ImageLayer[];
  activeLayerId(): string | null;
  activeTarget(): LayerTarget;
  selection(): SelectionMask | null;
  canvas(): { width: number; height: number };
  /** The pixels a pixel layer composites (the decoded source for the Background). */
  pixelsOf(layer: PixelLayer): TiledSurface;
  /** Opaque pre-transform snapshot. */
  capture(): unknown;
  /** Shows a live state (no history). */
  show(layers: ImageLayer[], selection: SelectionMask | null, activeLayerId: string | null): void;
  /** Records `before` as the undo step of the state now shown. */
  record(before: unknown): void;
  /** Puts `before` back (no history). */
  restore(before: unknown): void;
}

/** A surface that moves: in layer space (`offset` to document), composited back or replacing. */
interface Part {
  what: 'pixels' | 'mask' | 'selection';
  offset: { x: number; y: number };
  /** RGBA (pixels, or a mask part as grey + alpha) or one channel (a whole mask, the outline). */
  moving: TiledSurface;
  /** What stays: composited under the moved part (`null`: the moved part replaces the surface). */
  base: TiledSurface | null;
  /** Reduced copies for previews, by factor. */
  reduced: Map<number, TiledSurface>;
}

const fail = (message: string): never => {
  throw new LayerOperationError(message);
};

const T = (x: number, y: number): Homography => [1, 0, x, 0, 1, y, 0, 0, 1];

/** Preview block size for a screen scale: 1 at 100 % and above, then powers of two up to 8. */
export function previewStep(scale: number | undefined): number {
  if (!scale || !(scale > 0) || scale >= 1) return 1;
  return Math.min(8, 2 ** Math.floor(Math.log2(1 / scale)));
}

function toDoc(r: RasterRect | null, o: { x: number; y: number }): CropBox | null {
  return r ? { x: r.x + o.x, y: r.y + o.y, width: r.width, height: r.height } : null;
}

function selectionSurface(sel: SelectionMask): TiledSurface {
  return surfaceFromPixels({ width: sel.width, height: sel.height, data: sel.data }, 1, 0, 0, 0);
}

/**
 * Lifts the selected part of an RGBA surface (layer space): the lifted pixels (alpha × coverage)
 * and the rest (alpha × (1 − coverage); fully lifted pixels become transparent black).
 */
function liftPixels(surface: TiledSurface, sel: SelectionMask, o: { x: number; y: number }): { lifted: TiledSurface; rest: TiledSurface } {
  const sb = sel.bounds!;
  const area = { x: sb.x - o.x, y: sb.y - o.y, width: sb.width, height: sb.height };
  const px = readRegion(surface, area);
  const kept = new Uint8ClampedArray(px);
  for (let y = 0; y < area.height; y++) {
    for (let x = 0; x < area.width; x++) {
      const k = sel.data[(sb.y + y) * sel.width + sb.x + x] / 255;
      const i = (y * area.width + x) * 4;
      if (k <= 0) {
        px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0;
        continue;
      }
      px[i + 3] = px[i + 3] * k;
      if (!px[i + 3]) px[i] = px[i + 1] = px[i + 2] = 0;
      kept[i + 3] = kept[i + 3] * (1 - k);
      if (!kept[i + 3]) kept[i] = kept[i + 1] = kept[i + 2] = 0;
    }
  }
  return { lifted: surfaceFromPixels({ width: area.width, height: area.height, data: px }, 4, area.x, area.y), rest: writeRegion(surface, area, kept) };
}

/**
 * Lifts the selected part of a mask (layer space): the values as grey + alpha (alpha = coverage)
 * and the rest (the selected values replaced by the default). Everything selected moves,
 * default-valued parts included, so the mask stays aligned with the moved pixels.
 */
function liftMask(mask: TiledSurface, sel: SelectionMask, o: { x: number; y: number }): { lifted: TiledSurface; rest: TiledSurface } {
  const sb = sel.bounds!;
  const area = { x: sb.x - o.x, y: sb.y - o.y, width: sb.width, height: sb.height };
  const v = readRegion(mask, area);
  const def = mask.defaultValue;
  const lifted = new Uint8ClampedArray(area.width * area.height * 4);
  const rest = new Uint8ClampedArray(v.length);
  for (let y = 0; y < area.height; y++) {
    for (let x = 0; x < area.width; x++) {
      const i = y * area.width + x;
      const k = sel.data[(sb.y + y) * sel.width + sb.x + x] / 255;
      const g = v[i];
      if (k > 0) {
        lifted[i * 4] = lifted[i * 4 + 1] = lifted[i * 4 + 2] = g;
        lifted[i * 4 + 3] = k * 255;
      }
      rest[i] = g * (1 - k) + def * k;
    }
  }
  return { lifted: surfaceFromPixels({ width: area.width, height: area.height, data: lifted }, 4, area.x, area.y), rest: writeRegion(mask, area, rest) };
}

/**
 * A Free Transform in progress (see `ImageEditorController.beginFreeTransform`). Change the
 * geometry with `update` (each change shows a live preview without history), then `commit()`
 * (one undo step, resampled at full quality) or `cancel()` (everything back as it was).
 */
export class FreeTransformSession {
  readonly content: Exclude<FreeTransformContent, 'auto'>;
  /** The layer being transformed (`null` for `selection-outline`). */
  readonly layerId: string | null;
  /** The new layer of a `selection-copy`. */
  readonly copyId: string | null = null;
  /** The frame (document pixels). */
  readonly box: CropBox;
  /** What moves. */
  readonly moves: ReadonlyArray<'pixels' | 'mask' | 'selection'>;
  private geometryValue: FreeTransformGeometry;
  private interp: Interpolation;
  private readonly parts: Part[] = [];
  private readonly before: unknown;
  private readonly startLayers: ImageLayer[];
  private readonly startSelection: SelectionMask | null;
  private readonly startActive: string | null;
  /** The stack this session last showed: anything else means the document changed under it. */
  private shown: ImageLayer[];
  private closed = false;

  constructor(
    private readonly host: FreeTransformHost,
    init: FreeTransformInit = {}
  ) {
    if (init.interpolation !== undefined && !isInterpolation(init.interpolation)) fail(`Unknown interpolation "${String(init.interpolation)}"; use nearest, bilinear or bicubic.`);
    this.interp = init.interpolation ?? 'bicubic';
    const sel = host.selection();
    const selected = Boolean(sel?.bounds);
    let content = init.content ?? 'auto';
    if (!(['auto', 'layer', 'selection', 'selection-copy', 'selection-outline'] as const).includes(content)) {
      fail(`Unknown content "${String(content)}"; use auto, layer, selection, selection-copy or selection-outline.`);
    }
    if (content === 'auto') content = selected ? 'selection' : 'layer';
    this.content = content;
    if (content !== 'layer' && !selected) fail(`Nothing is selected; ${content} needs a selection. Select first, or use content layer.`);
    const layers = host.layers();
    this.startLayers = layers;
    this.startSelection = sel;
    this.startActive = host.activeLayerId();
    this.before = host.capture();
    const moves: Array<'pixels' | 'mask' | 'selection'> = [];
    let box: CropBox | null = null;

    if (content === 'selection-outline') {
      this.layerId = null;
      this.parts.push({ what: 'selection', offset: { x: 0, y: 0 }, moving: selectionSurface(sel!), base: null, reduced: new Map() });
      moves.push('selection');
      box = { ...sel!.bounds! };
    } else {
      const id = init.layerId ?? host.activeLayerId();
      if (!id) fail('No layer given and none is active; pass layerId (see list_layers).');
      const layer = requireLayer(layers, id!).layer;
      this.layerId = layer.id;
      const mask = layer.mask && !layer.mask.source ? layer.mask : undefined;
      const channel: LayerTarget = init.channel ?? (layer.id === host.activeLayerId() ? host.activeTarget() : 'pixels');
      if (channel !== 'pixels' && channel !== 'mask') fail(`Unknown channel "${String(channel)}"; use pixels or mask.`);
      const linked = mask?.linked !== false;
      const maskAlone = channel === 'mask' && (!linked || layer.type !== 'pixel');
      if (channel === 'mask' && !mask) fail(layer.mask?.source ? `Layer "${layer.name || id}" has a depth mask, which is generated, not transformed.` : `Layer "${layer.name || id}" has no mask to transform; add one with add_layer_mask, or transform its pixels.`);
      if (!maskAlone && layer.type !== 'pixel') fail(`Layer "${layer.name || id}" is a ${layer.type} layer; Free Transform works on pixel layers, layer masks (channel mask) and selections.`);
      if (!layer.visible && content !== 'selection-copy') fail(`Layer "${layer.name || id}" is hidden; show it before you transform it.`);
      if (content !== 'selection-copy') {
        requireUnlocked(layer, 'position', 'transform it');
        if (!maskAlone) requireUnlocked(layer, 'pixels', 'transform it');
      }
      const o = layer.type === 'pixel' ? layer.offset : { x: 0, y: 0 };
      const pixels = layer.type === 'pixel' ? host.pixelsOf(layer) : null;
      if (maskAlone) {
        if (content === 'selection-copy') fail('Layer via Copy copies pixels; transform a mask with content layer or selection.');
        if (content === 'selection') {
          const { lifted, rest } = liftMask(mask!.surface, sel!, o);
          this.parts.push({ what: 'mask', offset: o, moving: lifted, base: rest, reduced: new Map() });
          box = toDoc(contentBounds(lifted), o);
        } else {
          this.parts.push({ what: 'mask', offset: o, moving: mask!.surface, base: null, reduced: new Map() });
          box = toDoc(contentBounds(mask!.surface), o);
        }
        moves.push('mask');
      } else if (content === 'layer') {
        this.parts.push({ what: 'pixels', offset: o, moving: pixels!, base: null, reduced: new Map() });
        moves.push('pixels');
        box = toDoc(contentBounds(pixels!), o);
        if (mask && linked) {
          this.parts.push({ what: 'mask', offset: o, moving: mask.surface, base: null, reduced: new Map() });
          moves.push('mask');
          if (!box) box = toDoc(contentBounds(mask.surface), o);
        }
      } else if (content === 'selection') {
        const { lifted, rest } = liftPixels(pixels!, sel!, o);
        this.parts.push({ what: 'pixels', offset: o, moving: lifted, base: rest, reduced: new Map() });
        moves.push('pixels');
        box = toDoc(contentBounds(lifted), o);
        if (mask && linked) {
          const m = liftMask(mask.surface, sel!, o);
          this.parts.push({ what: 'mask', offset: o, moving: m.lifted, base: m.rest, reduced: new Map() });
          moves.push('mask');
        }
      } else {
        // selection-copy: the copy goes on a new layer above, with the source layer's offset.
        const { lifted } = liftPixels(pixels!, sel!, o);
        box = toDoc(contentBounds(lifted), o);
        if (box) {
          const copy: PixelLayer = {
            type: 'pixel',
            id: newLayerId(),
            name: `${layer.name || 'Layer'} copy`,
            visible: true,
            opacity: 1,
            blend: 'normal',
            surface: lifted,
            offset: { ...o },
          };
          (this as { copyId: string | null }).copyId = copy.id;
          const loc = findLayer(layers, layer.id)!;
          this.startLayers = insertLayer(layers, copy, loc.parent?.id ?? null, loc.index + 1);
          this.parts.push({ what: 'pixels', offset: o, moving: lifted, base: null, reduced: new Map() });
          moves.push('pixels');
        }
      }
      if (content !== 'layer') {
        this.parts.push({ what: 'selection', offset: { x: 0, y: 0 }, moving: selectionSurface(sel!), base: null, reduced: new Map() });
        moves.push('selection');
      }
    }
    if (!box && moves[0] === 'mask') fail('The mask holds nothing but its default value, so there is nothing to transform; paint it first, or transform the pixels (channel pixels).');
    if (!box) fail(content === 'layer' ? 'The layer has no pixels to transform.' : 'The selection holds no pixels of this layer; select some, or transform the outline (content selection-outline).');
    this.box = box!;
    this.moves = moves;
    this.geometryValue = identityTransform(box!);
    this.shown = this.startLayers;
    if (this.copyId) host.show(this.startLayers, sel, this.copyId);
    this.shown = host.layers();
  }

  /** The current geometry. */
  get geometry(): FreeTransformGeometry {
    return this.geometryValue;
  }

  get interpolation(): Interpolation {
    return this.interp;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  private check(): void {
    if (this.closed) fail('This transform has already been committed or cancelled; begin a new one.');
    if (this.host.layers() !== this.shown) {
      this.closed = true;
      fail('The document changed while the transform was open, so it was abandoned; begin a new one.');
    }
  }

  /**
   * Changes the geometry (`corners`, `warp`) or the interpolation and, unless `preview` is `false`,
   * shows the result live (no history). Returns the geometry.
   */
  update(changes: { corners?: FreeTransformGeometry['corners']; warp?: FreeTransformGeometry['warp']; interpolation?: Interpolation }, preview: FreeTransformPreview | false = {}): FreeTransformGeometry {
    this.check();
    if (changes.interpolation !== undefined) {
      if (!isInterpolation(changes.interpolation)) fail(`Unknown interpolation "${String(changes.interpolation)}"; use nearest, bilinear or bicubic.`);
      this.interp = changes.interpolation;
    }
    const next: FreeTransformGeometry = {
      box: this.box,
      corners: (changes.corners ?? this.geometryValue.corners).map((p) => ({ x: p.x, y: p.y })) as unknown as FreeTransformGeometry['corners'],
      warp: changes.warp === undefined ? this.geometryValue.warp ?? null : changes.warp,
    };
    if (next.corners.length !== 4 || !next.corners.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) fail('corners must be four finite points: top-left, top-right, bottom-right, bottom-left.');
    if (!transformMap(next)) fail('These corners fold the frame over itself or through the horizon; keep the quad convex.');
    this.geometryValue = next;
    if (preview !== false) this.render(preview);
    return next;
  }

  /** Resamples every part for the current geometry and shows it (or returns it, for commit). */
  private resample(final: boolean, preview: FreeTransformPreview = {}): { layers: ImageLayer[]; selection: SelectionMask | null } {
    const g = this.geometryValue;
    const identity = isIdentityTransform(g);
    const warp = hasWarp(g);
    const h = warp ? null : geometryHomography(g);
    const f = warp ? transformMap(g) : null;
    const step = final ? 1 : previewStep(preview.scale);
    const interpolation: Interpolation = final ? this.interp : this.interp === 'nearest' ? 'nearest' : 'bilinear';
    let layers = this.startLayers;
    let selection = this.startSelection;
    const targetId = this.copyId ?? this.layerId;
    for (const part of this.parts) {
      const o = part.offset;
      let moved: TiledSurface;
      if (identity) moved = part.moving;
      else {
        let src = part.moving;
        let k = 1;
        if (step > 1) {
          k = step;
          let r = part.reduced.get(k);
          if (!r) {
            r = reduceSurface(part.moving, k);
            part.reduced.set(k, r);
          }
          src = r;
        }
        const opts: ResampleOptions = { interpolation, step: step > 1 ? step : undefined };
        if (preview.clip && !final) opts.clip = { x: Math.floor(preview.clip.x - o.x), y: Math.floor(preview.clip.y - o.y), width: Math.ceil(preview.clip.width) + 1, height: Math.ceil(preview.clip.height) + 1 };
        try {
          if (f) {
            moved = warpSurface(src, (p) => {
              const q = f({ x: p.x * k + o.x, y: p.y * k + o.y });
              return q && { x: q.x - o.x, y: q.y - o.y };
            }, opts);
          } else {
            // Layer space → document → transform → layer space, from the reduced copy's pixels.
            const hl = multiplyHomographies(multiplyHomographies(multiplyHomographies([k, 0, 0, 0, k, 0, 0, 0, 1], T(o.x, o.y)), h!), T(-o.x, -o.y));
            moved = transformSurface(src, hl, opts);
          }
        } catch (e) {
          if (e instanceof TransformTooLargeError) fail(e.message);
          throw e;
        }
      }
      const result = part.base ? compositeSurfaceOver(part.base, moved) : moved;
      if (part.what === 'selection') {
        const { width, height } = this.host.canvas();
        const data = new Uint8Array(readRegion(result, { x: 0, y: 0, width, height }).buffer);
        const next = createSelectionMask(width, height, data);
        selection = next.bounds ? next : null;
      } else if (part.what === 'pixels') {
        layers = mapLayer(layers, targetId!, (l) => {
          const next = { ...(l as PixelLayer), surface: result };
          delete next.source;
          return next;
        });
      } else {
        layers = mapLayer(layers, targetId!, (l) => ({ ...l, mask: { ...(l.mask as RasterMask), surface: result } }) as ImageLayer);
      }
    }
    return { layers, selection };
  }

  private render(preview: FreeTransformPreview): void {
    const { layers, selection } = this.resample(false, preview);
    this.host.show(layers, selection, this.copyId ?? this.startActive);
    this.shown = this.host.layers();
  }

  /** Finishes the transform with full-quality resampling, as one undo step. */
  commit(): FreeTransformResult {
    this.check();
    const g = this.geometryValue;
    const changed = !isIdentityTransform(g) || Boolean(this.copyId);
    if (!changed) {
      this.closed = true;
      this.host.restore(this.before);
      return this.result(false, this.startLayers, this.startSelection);
    }
    const { layers, selection } = this.resample(true);
    this.closed = true;
    this.host.show(layers, selection, this.copyId ?? this.startActive);
    this.host.record(this.before);
    return this.result(true, layers, selection);
  }

  /** Abandons the transform and puts everything back (no history). */
  cancel(): void {
    if (this.closed) return;
    this.closed = true;
    this.host.restore(this.before);
  }

  private result(changed: boolean, layers: ImageLayer[], selection: SelectionMask | null): FreeTransformResult {
    let bounds: CropBox | null = null;
    const id = this.copyId ?? this.layerId;
    const layer = id ? findLayer(layers, id)?.layer : undefined;
    if (this.moves.includes('pixels') && layer?.type === 'pixel') bounds = toDoc(contentBounds(this.host.pixelsOf(layer)), layer.offset);
    else if (this.moves.includes('mask') && layer?.mask) bounds = toDoc(contentBounds(layer.mask.surface), layer.type === 'pixel' ? layer.offset : { x: 0, y: 0 });
    else if (this.moves.includes('selection')) bounds = selection?.bounds ? { ...selection.bounds } : null;
    return {
      layerId: this.copyId ?? this.layerId,
      content: this.content,
      moved: [...this.moves],
      box: { ...this.box },
      corners: this.geometryValue.corners,
      bounds,
      changed,
    };
  }
}
