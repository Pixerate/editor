/**
 * Provider effects in the image editor (see `@pixerate/editor/effects`): `effect` smart filters on
 * smart objects, and effect layers (pixel layers drawn from a generator or overlay effect at the
 * document's size and depth).
 *
 * Smart filters render synchronously (`applySmartFilters`). An effect filter asks this engine for
 * its result: a cached one is used at once; a missing one is rendered in the background while the
 * filter passes its pixels through and the surface is marked incomplete. When the render lands,
 * the controller renders the smart object again (a cache refresh, not an undo step).
 */

import { EffectsSlot, createEffectPixels, linearToSrgb } from '../effects/helpers.js';
import { EffectUnsupportedError } from '../effects/errors.js';
import { EffectRendererPool } from '../effects/pool.js';
import type { EffectDescription, EffectPixels, EffectProvider, EffectRenderRequest, EffectUse, EffectValue } from '../effects/types.js';
import { surfaceFromPixels, type PixelSurface } from '../raster/surface.js';
import { surfaceFromDeepPixels } from '../raster/deep.js';
import type { EffectSmartFilter } from './layers/model.js';
import type { SmartEffectResolver } from './layers/smart.js';

/** Which uses each place in the image editor takes. */
export const IMAGE_EFFECT_PLACES = {
  /** A smart filter: the effect changes the pixels below it. */
  filter: ['filter'],
  /** An effect layer: drawn at the document's size. */
  layer: ['generator', 'overlay', 'title']
} as const satisfies Record<string, readonly EffectUse[]>;

export type ImageEffectPlace = keyof typeof IMAGE_EFFECT_PLACES;

/** Refuses an effect that cannot go in `place`, saying what to use instead. */
export function checkImageEffectPlace(d: EffectDescription, place: ImageEffectPlace): void {
  const allowed: readonly EffectUse[] = IMAGE_EFFECT_PLACES[place];
  if (d.kind === 'motion' || !d.uses.some((u) => allowed.includes(u))) {
    const instead = place === 'filter' && d.uses.some((u) => (IMAGE_EFFECT_PLACES.layer as readonly string[]).includes(u)) ? '; add it as an effect layer with add_effect_layer instead' : place === 'layer' && d.uses.includes('filter') ? '; apply it to a layer as a smart filter with apply_effect instead' : '';
    throw new EffectUnsupportedError(
      `"${d.id}" (${d.name}) is a ${d.uses.join(' / ')} effect, and ${place === 'filter' ? 'a smart filter takes filter effects' : 'an effect layer takes generator, overlay or title effects'}${instead}.`,
      d.id
    );
  }
}

/** Over-composites `top` on `base` (straight alpha). */
function over(base: Uint8ClampedArray, top: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(base.length);
  for (let i = 0; i < out.length; i += 4) {
    const ta = top[i + 3] / 255;
    const ba = base[i + 3] / 255;
    const a = ta + ba * (1 - ta);
    out[i + 3] = Math.round(a * 255);
    if (a > 0) for (let c = 0; c < 3; c++) out[i + c] = (top[i + c] * ta + base[i + c] * ba * (1 - ta)) / a;
  }
  return out;
}

/**
 * Pixels from a provider as a layer surface at `depth`: 8-bit data, or deep samples from the
 * provider's linear float (16-bit as encoded codes, 32-bit as linear light).
 */
export function effectPixelsToSurface(p: EffectPixels, depth: 8 | 16 | 32): PixelSurface {
  if (depth === 8 || !p.float) return surfaceFromPixels({ width: p.width, height: p.height, data: p.data }, 4);
  if (depth === 32) return surfaceFromDeepPixels({ width: p.width, height: p.height, data: p.float }, 4);
  const f = p.float;
  const d = new Uint16Array(f.length);
  const code = (v: number) => (v > 0 ? (v < 1 ? Math.round(v * 65535) : 65535) : 0);
  for (let i = 0; i < f.length; i += 4) {
    d[i] = code(linearToSrgb(f[i]));
    d[i + 1] = code(linearToSrgb(f[i + 1]));
    d[i + 2] = code(linearToSrgb(f[i + 2]));
    d[i + 3] = code(f[i + 3]);
  }
  return surfaceFromDeepPixels({ width: p.width, height: p.height, data: d }, 4);
}

export interface ImageEffectsEngineOptions {
  /** The provider slot to follow (a controller passes its own). Default: a new one. */
  slot?: EffectsSlot;
  /** Smart filter results kept (default 24). */
  maxEntries?: number;
  /** Live renderers kept (default 4): GPU providers hold a graphics context each (see `EffectRendererPool`). */
  maxRenderers?: number;
}

/**
 * Renders provider effects for one image editor and keeps smart filter results. Follows the
 * provider slot: with no provider effect filters pass pixels through, and a new provider clears
 * the results and disposes the old renderers.
 */
export class ImageEffectsEngine implements SmartEffectResolver {
  readonly slot: EffectsSlot;
  private readonly cache = new Map<string, Uint8ClampedArray>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, Error>();
  private readonly pool: EffectRendererPool;
  private readonly descriptions = new Map<string, Promise<EffectDescription>>();
  private readonly listeners = new Set<() => void>();
  private readonly maxEntries: number;
  private generation = 0;
  private readonly detach: () => void;

  constructor(options: ImageEffectsEngineOptions = {}) {
    this.slot = options.slot ?? new EffectsSlot();
    this.maxEntries = options.maxEntries ?? 24;
    this.pool = new EffectRendererPool({ maxRenderers: options.maxRenderers });
    this.detach = this.slot.subscribe(() => {
      this.reset();
      this.notify();
    });
  }

  get provider(): EffectProvider | null {
    return this.slot.provider;
  }

  /** See `SmartEffectResolver.token`: bumped when the provider changes. */
  get token(): number {
    return this.generation;
  }

  /** True while a render is under way. */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  /** See `SmartEffectResolver`. */
  resolve(filter: EffectSmartFilter, input: Uint8ClampedArray, width: number, height: number, key: string): { result: Uint8ClampedArray | null; pending: boolean } {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return { result: hit, pending: false };
    }
    if (this.pending.has(key)) return { result: null, pending: true };
    const provider = this.slot.provider;
    if (!provider || this.failures.has(key)) return { result: null, pending: false };
    const generation = this.generation;
    const source: EffectPixels = { width, height, data: new Uint8ClampedArray(input) };
    const run = this.filter(provider, filter.effect, filter.values, source)
      .then((out) => {
        if (generation !== this.generation) return;
        this.cache.set(key, out);
        while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
      })
      .catch((error: unknown) => {
        if (generation === this.generation) this.failures.set(key, error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        if (this.pending.get(key) === run) this.pending.delete(key);
        if (generation === this.generation) this.notify();
      });
    this.pending.set(key, run);
    return { result: null, pending: true };
  }

  /** A filter effect over `source`: its result, or (for an overlay) the effect drawn over it. */
  private async filter(provider: EffectProvider, effect: string, values: Record<string, EffectValue>, source: EffectPixels): Promise<Uint8ClampedArray> {
    const d = await this.describe(provider, effect);
    const takesSource = d.inputs.some((i) => i.name === 'source');
    const out = await this.render(provider, effect, source.width, source.height, 8, { time: 0, values, ...(takesSource ? { inputs: { source } } : {}) });
    return takesSource ? out.data : over(source.data, out.data);
  }

  /**
   * Renders a generator or overlay effect at a size and depth (an effect layer's pixels). Rejects
   * with the provider's error, or without a provider.
   */
  async renderLayer(effect: string, values: Record<string, EffectValue>, size: { width: number; height: number; depth?: 8 | 16 | 32; time?: number }): Promise<EffectPixels> {
    const provider = this.slot.require();
    const depth = size.depth ?? 8;
    const out = await this.render(provider, effect, size.width, size.height, depth, { time: size.time ?? 0, values });
    return out.width === size.width && out.height === size.height ? out : createEffectPixels(size.width, size.height);
  }

  /** Why the result for `key` failed, if it did. */
  failure(key: string): Error | undefined {
    return this.failures.get(key);
  }

  /** Every failure so far. */
  failuresList(): { key: string; error: Error }[] {
    return [...this.failures].map(([key, error]) => ({ key, error }));
  }

  /** Resolves when nothing is rendering. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending.values()]);
  }

  /** The provider's description of an effect, fetched once per provider. */
  describe(provider: EffectProvider, id: string): Promise<EffectDescription> {
    let d = this.descriptions.get(id);
    if (!d) {
      d = Promise.resolve().then(() => provider.describe(id));
      d.catch(() => this.descriptions.delete(id));
      this.descriptions.set(id, d);
    }
    return d;
  }

  private render(provider: EffectProvider, id: string, width: number, height: number, depth: 8 | 16 | 32, request: EffectRenderRequest): Promise<EffectPixels> {
    return this.pool.render(provider, id, { width, height, depth }, request);
  }

  /** Forgets every result and failure and disposes the renderers. */
  reset(): void {
    this.generation++;
    this.cache.clear();
    this.pending.clear();
    this.failures.clear();
    this.descriptions.clear();
    this.pool.clear();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const l of [...this.listeners]) l();
  }

  destroy(): void {
    this.reset();
    this.detach();
    this.listeners.clear();
  }
}
