/**
 * Art for stickers from a sticker provider (anything but the editor's own procedural stamps): the
 * spray brush draws while a stroke is in progress, so it can't wait for a provider. Each sticker
 * is loaded once, rasterised to RGBA and kept here; drawing reads it synchronously.
 *
 * PNG art (`data:` URLs) is decoded here, in any environment. SVG and `https:` images need a
 * rasteriser: the browser's (`createImageBitmap` and `OffscreenCanvas`) by default, or the
 * host's (`PaintEditorOptions.rasterizeSticker`).
 *
 * A sticker with a dark variant is kept in each variant asked for: `ensure(…, dark)` loads the dark
 * art when the sticker has it, and sprayed stickers record the variant they were drawn in.
 */

import { decodePng, parseDataUrl } from '../raster/png';
import { describeStickerRef } from '../stickers/tools';
import { editorStampOf, stickerIdFor, stickerVariantFor } from '../stickers/helpers';
import { StickerError } from '../stickers/errors';
import type { StickerAsset, StickerDescription, StickerProvider, StickerRef, StickerVariant } from '../stickers/types';

/** Rasterised sticker art (straight RGBA) and whether to recolour it. */
export interface StickerArt {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** Flat art: drawn in the sticker's colour, keeping its alpha. */
  tintable: boolean;
}

/** The art for a ref in a variant (default `light`), when it has loaded. */
export type StickerArtLookup = (ref: StickerRef, variant?: StickerVariant) => StickerArt | undefined;

/** Turns a sticker asset into RGBA at about `size` px on its longest side. */
export type StickerRasterizer = (asset: StickerAsset, size: number) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>;

/** Longest side sticker art is kept at (px); larger stickers are drawn from it, smoothly scaled. */
export const STICKER_ART_SIZE = 256;

type Entry = { status: 'loading'; promise: Promise<StickerArt> } | { status: 'ready'; art: StickerArt } | { status: 'failed'; error: string };

/**
 * Decodes PNG data URLs anywhere; draws SVG and other images with the browser's
 * `createImageBitmap` and `OffscreenCanvas` when present, and otherwise refuses, naming the option
 * that adds a rasteriser.
 */
export const defaultStickerRasterizer: StickerRasterizer = async (asset, size) => {
  if (asset.kind === 'image') {
    const parsed = parseDataUrl(asset.url);
    if (parsed && parsed.mime === 'image/png') {
      const png = decodePng(parsed.bytes);
      return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
    }
  }
  const g = globalThis as { createImageBitmap?: (b: Blob) => Promise<ImageBitmap>; OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvas; fetch?: typeof fetch };
  if (!g.createImageBitmap || !g.OffscreenCanvas) {
    throw new StickerError('unsupported_format', `This environment can't draw ${asset.kind === 'svg' ? 'SVG' : 'non-PNG'} sticker art; pass rasterizeSticker in the paint editor's options (or use a provider that offers png).`);
  }
  const blob = asset.kind === 'svg' ? new Blob([asset.svg], { type: 'image/svg+xml' }) : await (await g.fetch!(asset.url)).blob();
  const bitmap = await g.createImageBitmap(blob);
  const scale = size / Math.max(bitmap.width, bitmap.height, 1);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new g.OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: img.data };
};

/** Loaded sticker art by ref and variant, with the state of each load. */
export class StickerArtCache {
  private readonly entries = new Map<string, Entry>();
  /** Descriptions by ref (their variants pick the art), shared by the loads that need them. */
  private readonly descriptions = new Map<StickerRef, Promise<StickerDescription>>();
  private readonly variants = new Map<StickerRef, readonly StickerVariant[]>();

  private static key(ref: StickerRef, variant: StickerVariant = 'light'): string {
    return variant === 'dark' ? `${ref}#dark` : ref;
  }

  /** The art for `ref` in `variant` (default `light`) when it has loaded (editor stamps never need any). */
  get: StickerArtLookup = (ref, variant) => {
    const e = this.entries.get(StickerArtCache.key(ref, variant));
    return e?.status === 'ready' ? e.art : undefined;
  };

  /** The variant to draw `ref` in on a dark or light background: `dark` once the sticker is known to have it. */
  variantFor(ref: StickerRef, dark: boolean): StickerVariant {
    return dark && this.variants.get(ref)?.includes('dark') ? 'dark' : 'light';
  }

  /** `ready`, `loading`, `failed` (with the reason) or `none` (never asked for). Editor stamps are always `ready`. */
  status(ref: StickerRef, variant?: StickerVariant): { status: 'ready' | 'loading' | 'failed' | 'none'; error?: string } {
    if (editorStampOf(ref)) return { status: 'ready' };
    const e = this.entries.get(StickerArtCache.key(ref, variant));
    if (!e) return this.descriptions.has(ref) && !this.variants.has(ref) ? { status: 'loading' } : { status: 'none' };
    return e.status === 'failed' ? { status: 'failed', error: e.error } : { status: e.status };
  }

  /**
   * Loads and rasterises `ref` from `provider` once per variant (later calls share the load): the
   * dark variant when `dark` and the sticker has one, else the light. Unknown refs reject with the
   * closest known ones; failures are kept so they are reported, and retried on the next call.
   */
  async ensure(provider: StickerProvider, ref: StickerRef, rasterize: StickerRasterizer, dark = false): Promise<StickerArt | null> {
    if (editorStampOf(ref)) return null;
    let described = this.descriptions.get(ref);
    if (!described) {
      described = describeStickerRef(provider, ref);
      this.descriptions.set(ref, described);
    }
    let d: StickerDescription;
    try {
      d = await described;
    } catch (err) {
      this.descriptions.delete(ref);
      this.entries.set(StickerArtCache.key(ref), { status: 'failed', error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    this.variants.set(ref, d.variants ?? ['light']);
    return this.load(provider, ref, d, stickerVariantFor(d, dark), rasterize);
  }

  private load(provider: StickerProvider, ref: StickerRef, d: StickerDescription, variant: StickerVariant, rasterize: StickerRasterizer): Promise<StickerArt> {
    const key = StickerArtCache.key(ref, variant);
    const e = this.entries.get(key);
    if (e?.status === 'ready') return Promise.resolve(e.art);
    if (e?.status === 'loading') return e.promise;
    const promise = (async () => {
      const id = stickerIdFor(provider, ref)!;
      const max = provider.capabilities.maxSize ?? STICKER_ART_SIZE;
      const size = Math.min(STICKER_ART_SIZE, max);
      const v = variant === 'dark' ? { variant } : {};
      const asset = await provider.load(id, d.formats.includes('png') ? { format: 'png', size, ...v } : { format: d.formats[0] ?? 'svg', size, ...v });
      const px = await rasterize(asset, size);
      if (!(px.width > 0 && px.height > 0) || px.data.length !== px.width * px.height * 4) throw new StickerError('load_failed', `The art for "${ref}" came back empty or the wrong size.`);
      return { ...px, tintable: d.tintable };
    })();
    this.entries.set(key, { status: 'loading', promise });
    return promise.then(
      (art) => {
        this.entries.set(key, { status: 'ready', art });
        return art;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.entries.set(key, { status: 'failed', error: message });
        throw err;
      }
    );
  }

  /** Forgets every load (a new provider). */
  clear(): void {
    this.entries.clear();
    this.descriptions.clear();
    this.variants.clear();
  }
}

/** Bilinear RGBA sample of `art` at (x, y) in its pixels (straight alpha, colour weighted by alpha). */
export function sampleArt(art: StickerArt, x: number, y: number, out: number[]): number[] {
  const { width: w, height: h, data } = art;
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let k = 0; k < 4; k++) {
    const xx = x0 + (k & 1);
    const yy = y0 + (k >> 1);
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const wgt = (k & 1 ? tx : 1 - tx) * (k >> 1 ? ty : 1 - ty);
    const i = (yy * w + xx) * 4;
    const al = data[i + 3] * wgt;
    r += data[i] * al;
    g += data[i + 1] * al;
    b += data[i + 2] * al;
    a += al;
  }
  out[0] = a > 0 ? r / a / 255 : 0;
  out[1] = a > 0 ? g / a / 255 : 0;
  out[2] = a > 0 ? b / a / 255 : 0;
  out[3] = a / 255;
  return out;
}
