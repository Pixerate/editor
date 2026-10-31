/**
 * Compositing at high bit depth: the same layer model as `RasterCompositor` (pixel layers,
 * groups with pass-through, masks, clipping, blend modes, opacity and fill, filter layers) run
 * in float over the layers' deep samples (see `./deep`), for exports, merges and anything else
 * that must keep 16 or 32 bits. It is uncached and meant for one-off renders: the viewport keeps
 * using the 8-bit compositor over each tile's 8-bit rendering.
 *
 * Working space: straight-alpha float RGBA, sRGB-encoded 0..1 at 16 bits and linear light at 32
 * bits (as Photoshop blends in each mode). Results come back in that space.
 *
 * What it delegates to the 8-bit compositor it wraps:
 * - mask coverage (density, feather and parametric masks: deep masks are read at depth);
 * - the effect maps of layers with effects (built from the 8-bit shape); the effects themselves
 *   composite in float over the deep content (`runEffects`), and pixel filters run in float when
 *   the profile gives `pixelFiltersDeep`;
 * - filters it cannot run in float and content layers the editor draws itself (annotations):
 *   each is rendered alone at 8 bits, converted, and blended in float with its blend mode and
 *   opacity.
 */

import { blendRgb, mixPigmentRgb, type BlendMode } from './blend';
import { applyEdgeAmbient, type CompositorLayer, type CompositorProfile, type RasterCompositor, type RasterSources } from './compositor';
import { hasActiveEffects } from './effects/model';
import { compositeLayerEffects } from './effects/render';
import { readDeepRegion, srgbDecode, srgbEncode, to32From8 } from './deep';
import type { RasterRect } from './surface';

/** Float hooks of an editor's own layer kinds (see `CompositorProfile`). */
export interface DeepCompositorProfile<L extends CompositorLayer, S extends RasterSources> {
  /**
   * Applies a run of visible filter layers to float RGBA `acc` over `r` (sRGB-encoded 0..1,
   * straight alpha; values may exceed 1 at 32 bits); `coverage` holds masked ones by id.
   * Missing: filter layers run at 8 bits.
   */
  applyFilterRunDeep?(layers: L[], acc: Float32Array, r: RasterRect, coverage: Map<string, Float32Array> | undefined, sources: S): void;
  /**
   * A pixel layer's filters in float (`null`: none, or none it can run): `apply` filters float
   * RGBA in the working space (`linear` at 32 bits) in place; `reach` is how many pixels each
   * side they read (0 for per-pixel filters). Missing: filtered layers are drawn at 8 bits.
   */
  pixelFiltersDeep?(layer: L): { reach: number; apply(data: Float32Array, width: number, height: number, linear: boolean): void } | null;
}

type Step<L> = { kind: 'content'; layer: L; clipped: L[] } | { kind: 'adjust'; layers: L[] } | { kind: 'group'; layer: L; clipped: L[]; steps: Step<L>[] };

const isGroup = (l: CompositorLayer) => l.type === 'group';

export class DeepCompositor<L extends CompositorLayer, S extends RasterSources> {
  private sources!: S;
  private readonly linear: boolean;

  constructor(
    /** The 8-bit compositor for masks and the layers it renders (see the module comment). */
    private readonly base: RasterCompositor<L, S>,
    private readonly profile: CompositorProfile<L, S>,
    private readonly deep: DeepCompositorProfile<L, S>,
    readonly depth: 16 | 32
  ) {
    this.linear = depth === 32;
  }

  /** The composite of `layers` over `rect` as float RGBA in the working space (`rect.width × rect.height × 4`). */
  composite(layers: readonly L[], rect: RasterRect, sources: S): Float32Array {
    this.sources = sources;
    const acc = new Float32Array(Math.max(0, rect.width * rect.height * 4));
    if (rect.width > 0 && rect.height > 0) this.runSteps(this.buildSteps(layers), acc, true, rect);
    return acc;
  }

  // --- Steps (as RasterCompositor.buildSteps) ------------------------------------

  private isPixel(l: CompositorLayer): boolean {
    return l.type === 'pixel' || (this.profile.isPixelLike?.(l as L) ?? false);
  }

  private isFilter(l: L): boolean {
    return this.profile.isFilterLayer?.(l) ?? false;
  }

  private buildSteps(layers: readonly L[]): Step<L>[] {
    const steps: Step<L>[] = [];
    for (const layer of layers) {
      const last = steps[steps.length - 1];
      if (layer.clipped && last && (last.kind === 'content' || last.kind === 'group')) {
        last.clipped.push(layer);
        continue;
      }
      if (this.isFilter(layer)) {
        if (last && last.kind === 'adjust') last.layers.push(layer);
        else steps.push({ kind: 'adjust', layers: [layer] });
      } else if (isGroup(layer)) steps.push({ kind: 'group', layer, clipped: [], steps: this.buildSteps((layer.children ?? []) as L[]) });
      else steps.push({ kind: 'content', layer, clipped: [] });
    }
    return steps;
  }

  private runSteps(steps: Step<L>[], acc: Float32Array, empty: boolean, r: RasterRect): boolean {
    for (const s of steps) empty = this.runStep(s, acc, empty, r);
    return empty;
  }

  private runStep(step: Step<L>, acc: Float32Array, empty: boolean, r: RasterRect): boolean {
    if (step.kind === 'adjust') {
      if (empty) return true;
      this.applyFilterRun(step.layers, acc, r);
      return false;
    }
    const layer = step.layer;
    if (!layer.visible) return empty;
    const clipped = step.clipped.filter((l) => l.visible);
    if ((step.kind === 'content' || step.kind === 'group') && this.deepEffects(layer)) return this.runEffects(layer, clipped, acc, r, step.kind === 'group' ? step.steps : null) ? false : empty;
    const coverage = this.renderedAlone(layer) ? null : this.base.maskCoverage(layer, r, this.sources);
    if (coverage && coverage.every((v) => v <= 0)) return empty;
    if (step.kind === 'group' && !this.renderedAlone(layer)) {
      if (layer.blend === 'pass-through' && !clipped.length) {
        if (layer.opacity >= 1 && !coverage) return this.runSteps(step.steps, acc, empty, r);
        const before = acc.slice();
        const stillEmpty = this.runSteps(step.steps, acc, empty, r);
        lerp(acc, before, layer.opacity, coverage);
        return empty && stillEmpty;
      }
      const buf = new Float32Array(acc.length);
      if (this.runSteps(step.steps, buf, true, r)) return empty;
      this.applyClipped(clipped, buf, r);
      const mode = (layer.blend === 'pass-through' ? 'normal' : layer.blend) as BlendMode;
      this.blend(acc, buf, mode, layer.opacity, coverage);
      return false;
    }
    const content = this.content(layer, r);
    if (!content) return empty;
    const ambient = layer.edge?.ambient ?? 0;
    if (ambient > 0) {
      // In the working space: a fixed colour is sRGB bytes (decoded at 32 bits).
      const c = layer.edge?.ambientColor;
      const color = c ? (c.map((v) => (this.linear ? srgbDecode(v / 255) : v / 255)) as [number, number, number]) : null;
      if (color || !empty) applyEdgeAmbient(content, acc, coverage, ambient, color, 1);
    }
    const alone = this.renderedAlone(layer);
    // A layer rendered alone already carries its mask, fill and effects.
    const fill = !alone && this.isPixel(layer) ? (layer.fillOpacity ?? 1) : 1;
    const mode = this.blendOf(layer);
    if (!clipped.length) {
      this.blend(acc, content, mode, layer.opacity * fill, coverage);
      return false;
    }
    const buf = new Float32Array(acc.length);
    this.blend(buf, content, 'normal', fill, coverage);
    this.applyClipped(clipped, buf, r);
    this.blend(acc, buf, mode, layer.opacity, null);
    return false;
  }

  /**
   * A pixel layer with effects onto `acc` over `r`: its deep content (filters, mask, clipped
   * layers) and the effects composited in float. Effect maps come from the 8-bit shape. At 32
   * bits the effects composite in sRGB-encoded values (their colours and blends are defined
   * there) and the result is decoded back. Returns whether anything was drawn.
   */
  private runEffects(layer: L, clipped: L[], acc: Float32Array, r: RasterRect, groupSteps: Step<L>[] | null = null): boolean {
    const fx = this.base.effectsInput(layer, r, this.sources);
    if (!fx) return false;
    const a = fx.rect;
    let content: Float32Array;
    if (groupSteps) {
      // A group's content: its children composited alone, in float.
      content = new Float32Array(a.width * a.height * 4);
      this.runSteps(groupSteps, content, true, a);
    } else content = this.content(layer, a) ?? new Float32Array(a.width * a.height * 4);
    const coverage = this.base.maskCoverage(layer, a, this.sources);
    if (coverage) for (let i = 0; i < coverage.length; i++) content[i * 4 + 3] *= coverage[i];
    if (clipped.length) this.applyClipped(clipped, content, a);
    const sub = new Float32Array(a.width * a.height * 4);
    for (let y = 0; y < a.height; y++) {
      const s = ((a.y - r.y + y) * r.width + (a.x - r.x)) * 4;
      sub.set(acc.subarray(s, s + a.width * 4), y * a.width * 4);
    }
    if (this.linear) {
      encodeInPlace(sub);
      encodeInPlace(content);
    }
    compositeLayerEffects({ ...fx, backdrop: sub, content });
    if (this.linear) decodeInPlace(sub);
    for (let y = 0; y < a.height; y++) acc.set(sub.subarray(y * a.width * 4, (y + 1) * a.width * 4), ((a.y - r.y + y) * r.width + (a.x - r.x)) * 4);
    return true;
  }

  private applyClipped(clipped: L[], buf: Float32Array, r: RasterRect): void {
    let run: L[] = [];
    const flush = () => {
      if (run.length) this.applyFilterRun(run, buf, r);
      run = [];
    };
    for (const c of clipped) {
      if (this.isFilter(c)) {
        run.push(c);
        continue;
      }
      flush();
      const alone = this.renderedAlone(c);
      const coverage = alone ? null : this.base.maskCoverage(c, r, this.sources);
      let src: Float32Array | null;
      if (isGroup(c) && !alone) {
        src = new Float32Array(buf.length);
        if (this.runSteps(this.buildSteps((c.children ?? []) as L[]), src, true, r)) continue;
      } else src = this.content(c, r);
      if (!src) continue;
      const fill = !alone && this.isPixel(c) ? (c.fillOpacity ?? 1) : 1;
      // Source-atop: the base's alpha is kept.
      const keep = new Float32Array(buf.length >> 2);
      for (let i = 3, p = 0; i < buf.length; i += 4, p++) keep[p] = buf[i];
      this.blend(buf, src, (c.blend === 'pass-through' ? 'normal' : this.blendOf(c)) as BlendMode, c.opacity * fill, coverage);
      for (let i = 3, p = 0; i < buf.length; i += 4, p++) buf[i] = keep[p];
    }
    flush();
  }

  private applyFilterRun(layers: L[], acc: Float32Array, r: RasterRect): void {
    const visible: L[] = [];
    let masks: Map<string, Float32Array> | undefined;
    for (const node of layers) {
      if (!node.visible) continue;
      const cov = this.base.maskCoverage(node, r, this.sources);
      if (cov) {
        if (cov.every((v) => v <= 0)) continue;
        (masks ??= new Map()).set(node.id, cov);
      }
      visible.push(node);
    }
    if (!visible.length) return;
    if (this.deep.applyFilterRunDeep) {
      // Filter layers work on encoded colour: at 32 bits encode around them.
      if (this.linear) mapColour(acc, srgbEncode);
      this.deep.applyFilterRunDeep(visible, acc, r, masks, this.sources);
      if (this.linear) mapColour(acc, srgbDecode);
      return;
    }
    const bytes = this.to8(acc);
    this.profile.applyFilterRun?.(visible, bytes, r, masks, this.sources);
    acc.set(this.from8(bytes));
  }

  // --- Layer content ---------------------------------------------------------------

  /** Layers drawn by the 8-bit compositor alone (effects, pixel filters, content the editor draws). */
  /** A pixel(-like) layer or a group with effects: composited in float through `compositeLayerEffects`. */
  private deepEffects(layer: L): boolean {
    return hasActiveEffects(layer.effects) && !this.isFilter(layer) && (isGroup(layer) || this.isPixel(layer));
  }

  private renderedAlone(layer: L): boolean {
    if (hasActiveEffects(layer.effects) && !this.isFilter(layer) && !this.deepEffects(layer)) return true;
    if (this.isPixel(layer)) return Boolean(this.profile.pixelFilters?.(layer)) && !this.deep.pixelFiltersDeep?.(layer);
    return !isGroup(layer);
  }

  private blendOf(layer: L): BlendMode {
    return this.profile.contentBlend?.(layer) ?? (layer.blend as BlendMode);
  }

  /** A layer's float RGBA over `r` (straight alpha, working space), or `null` when it has none there. */
  private content(layer: L, r: RasterRect): Float32Array | null {
    if (this.renderedAlone(layer)) {
      // Alone: normal blend at full opacity over transparency (mask, fill and effects applied).
      // Without the live edge cast: it needs what is behind the layer, applied in float (runStep).
      const edge = layer.edge?.ambient ? { ...layer.edge, ambient: 0 } : layer.edge;
      const solo = { ...layer, blend: isGroup(layer) && layer.blend === 'pass-through' ? 'pass-through' : 'normal', opacity: 1, clipped: false, edge } as L;
      const bytes = this.base.composite([solo], r, this.sources);
      return this.from8(bytes);
    }
    const surface = this.sources.surfaceOf ? this.sources.surfaceOf(layer) : layer.surface;
    if (!surface) return null;
    const ox = layer.offset?.x ?? 0;
    const oy = layer.offset?.y ?? 0;
    const filters = this.isPixel(layer) ? (this.deep.pixelFiltersDeep?.(layer) ?? null) : null;
    if (!filters) return this.samples(surface, { x: r.x - ox, y: r.y - oy, width: r.width, height: r.height });
    // Filters in float: read what they reach (clamped at the canvas edge, as the 8-bit path
    // filters over the canvas), filter, and keep `r`.
    const m = filters.reach;
    const W = this.sources.width;
    const H = this.sources.height;
    const x0 = m ? Math.max(0, r.x - m) : r.x;
    const y0 = m ? Math.max(0, r.y - m) : r.y;
    const x1 = m ? Math.min(W, r.x + r.width + m) : r.x + r.width;
    const y1 = m ? Math.min(H, r.y + r.height + m) : r.y + r.height;
    if (x1 <= x0 || y1 <= y0) return new Float32Array(r.width * r.height * 4);
    const big = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    const data = this.samples(surface, { ...big, x: big.x - ox, y: big.y - oy });
    filters.apply(data, big.width, big.height, this.linear);
    if (big.x === r.x && big.y === r.y && big.width === r.width && big.height === r.height) return data;
    const out = new Float32Array(r.width * r.height * 4);
    for (let y = 0; y < r.height; y++) {
      const sy = r.y + y - big.y;
      if (sy < 0 || sy >= big.height) continue;
      for (let x = 0; x < r.width; x++) {
        const sx = r.x + x - big.x;
        if (sx < 0 || sx >= big.width) continue;
        const s = (sy * big.width + sx) * 4;
        const d = (y * r.width + x) * 4;
        out[d] = data[s];
        out[d + 1] = data[s + 1];
        out[d + 2] = data[s + 2];
        out[d + 3] = data[s + 3];
      }
    }
    return out;
  }

  /** A surface's samples over `rect` (layer space) in the working space. */
  private samples(surface: NonNullable<CompositorLayer['surface']>, rect: RasterRect): Float32Array {
    const samples = readDeepRegion(surface, rect, this.depth);
    if (samples instanceof Float32Array) return samples;
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 65535;
    return out;
  }

  /** 8-bit RGBA to the working space. */
  private from8(bytes: Uint8ClampedArray): Float32Array {
    if (this.linear) return to32From8(bytes, 4);
    const out = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] / 255;
    return out;
  }

  /** The working space to 8-bit RGBA. */
  private to8(acc: Float32Array): Uint8ClampedArray {
    const out = new Uint8ClampedArray(acc.length);
    for (let i = 0; i < acc.length; i += 4) {
      for (let c = 0; c < 3; c++) out[i + c] = Math.round((this.linear ? srgbEncode(acc[i + c]) : acc[i + c]) * 255);
      out[i + 3] = Math.round(acc[i + 3] * 255);
    }
    return out;
  }

  // --- Blending --------------------------------------------------------------------

  /** `src` over `dst` with `mode` at `alpha` × coverage (straight alpha, float), as `blendTile`. */
  private blend(dst: Float32Array, src: Float32Array, mode: BlendMode, alpha: number, coverage: Float32Array | null): void {
    if (!(alpha > 0)) return;
    const normal = mode === 'normal';
    const pigment = mode === 'pigment';
    const cb = [0, 0, 0];
    const cs = [0, 0, 0];
    const mix = [0, 0, 0];
    for (let i = 0, p = 0; i < dst.length; i += 4, p++) {
      const sa = src[i + 3];
      if (!(sa > 0)) continue;
      const k = coverage ? alpha * coverage[p] : alpha;
      if (!(k > 0)) continue;
      const as = Math.min(1, sa * k);
      const ab = dst[i + 3];
      const ao = as + ab * (1 - as);
      if (ao <= 0) {
        dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0;
        continue;
      }
      if (normal && as >= 1) {
        dst[i] = src[i];
        dst[i + 1] = src[i + 1];
        dst[i + 2] = src[i + 2];
        dst[i + 3] = 1;
        continue;
      }
      for (let c = 0; c < 3; c++) {
        cb[c] = dst[i + c];
        cs[c] = src[i + c];
      }
      if (pigment) {
        // Paint mixing works on encoded colour.
        if (this.linear) for (let c = 0; c < 3; c++) (cb[c] = srgbEncode(cb[c])), (cs[c] = srgbEncode(cs[c]));
        mixPigmentRgb(cb, cs, as / ao, mix);
        for (let c = 0; c < 3; c++) dst[i + c] = this.linear ? srgbDecode(mix[c]) : mix[c];
        dst[i + 3] = ao;
        continue;
      }
      const m = normal ? cs : blendRgb(mode, cb, cs);
      const wb = (1 - as) * ab;
      const ws = (1 - ab) * as;
      const wm = as * ab;
      for (let c = 0; c < 3; c++) dst[i + c] = (wb * cb[c] + ws * cs[c] + wm * m[c]) / ao;
      dst[i + 3] = ao;
    }
  }
}

/** `dst = lerp(before, dst, alpha · coverage)` (pass-through groups with opacity). */
function lerp(dst: Float32Array, before: Float32Array, alpha: number, coverage: Float32Array | null): void {
  for (let i = 0, p = 0; i < dst.length; i += 4, p++) {
    const k = coverage ? alpha * coverage[p] : alpha;
    if (k >= 1) continue;
    for (let c = 0; c < 4; c++) dst[i + c] = before[i + c] + (dst[i + c] - before[i + c]) * k;
  }
}

/** Applies `f` to the colour channels of float RGBA in place. */
function mapColour(data: Float32Array, f: (v: number) => number): void {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = f(data[i]);
    data[i + 1] = f(data[i + 1]);
    data[i + 2] = f(data[i + 2]);
  }
}

/** Float RGBA in the working space of `depth` as deep samples of that depth (16: encoded codes; 32: as is). */
export function workingToSamples(data: Float32Array, depth: 16 | 32): Uint16Array | Float32Array {
  if (depth === 32) return data;
  const out = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    out[i] = v > 0 ? (v < 1 ? Math.round(v * 65535) : 65535) : 0;
  }
  return out;
}

/** Linear float RGBA to sRGB-encoded in place (colour only; values above 1 extend the curve). */
function encodeInPlace(d: Float32Array): void {
  for (let i = 0; i < d.length; i += 4) {
    d[i] = srgbEncode(d[i]);
    d[i + 1] = srgbEncode(d[i + 1]);
    d[i + 2] = srgbEncode(d[i + 2]);
  }
}

/** sRGB-encoded float RGBA to linear in place (colour only). */
function decodeInPlace(d: Float32Array): void {
  for (let i = 0; i < d.length; i += 4) {
    d[i] = srgbDecode(d[i]);
    d[i + 1] = srgbDecode(d[i + 1]);
    d[i + 2] = srgbDecode(d[i + 2]);
  }
}
