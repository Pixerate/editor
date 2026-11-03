/**
 * Art for stickers from a sticker provider (anything but the editor's own procedural stamps): the
 * spray brush draws while a stroke is in progress, so it can't wait for a provider. Each sticker
 * is loaded once, rasterised to RGBA and kept here; drawing reads it synchronously.
 *
 * PNG art (`data:` URLs) is decoded here, in any environment. SVG and `https:` images need a
 * rasteriser: the browser's (`createImageBitmap` and `OffscreenCanvas`) by default, or the
 * host's (`PaintEditorOptions.rasterizeSticker`).
 */

import { decodePng, parseDataUrl } from '../raster/png';
import { describeStickerRef } from '../stickers/tools';
import { editorStampOf, stickerIdFor } from '../stickers/helpers';
import { StickerError } from '../stickers/errors';
import type { StickerAsset, StickerProvider, StickerRef } from '../stickers/types';

/** Rasterised sticker art (straight RGBA) and whether to recolour it. */
export interface StickerArt {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** Flat art: drawn in the sticker's colour, keeping its alpha. */
  tintable: boolean;
}

/** The art for a ref, when it has loaded. */
export type StickerArtLookup = (ref: StickerRef) => StickerArt | undefined;

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

/** Loaded sticker art by ref, with the state of each load. */
export class StickerArtCache {
  private readonly entries = new Map<StickerRef, Entry>();

  /** The art for `ref` when it has loaded (editor stamps never need any). */
  get: StickerArtLookup = (ref) => {
    const e = this.entries.get(ref);
    return e?.status === 'ready' ? e.art : undefined;
  };

  /** `ready`, `loading`, `failed` (with the reason) or `none` (never asked for). Editor stamps are always `ready`. */
  status(ref: StickerRef): { status: 'ready' | 'loading' | 'failed' | 'none'; error?: string } {
    if (editorStampOf(ref)) return { status: 'ready' };
    const e = this.entries.get(ref);
    if (!e) return { status: 'none' };
    return e.status === 'failed' ? { status: 'failed', error: e.error } : { status: e.status };
  }

  /**
   * Loads and rasterises `ref` from `provider` once (later calls share the load). Unknown refs
   * reject with the closest known ones; failures are kept so they are reported, and retried on
   * the next call.
   */
  ensure(provider: StickerProvider, ref: StickerRef, rasterize: StickerRasterizer): Promise<StickerArt | null> {
    if (editorStampOf(ref)) return Promise.resolve(null);
    const e = this.entries.get(ref);
    if (e?.status === 'ready') return Promise.resolve(e.art);
    if (e?.status === 'loading') return e.promise;
    const promise = (async () => {
      const d = await describeStickerRef(provider, ref);
      const id = stickerIdFor(provider, ref)!;
      const max = provider.capabilities.maxSize ?? STICKER_ART_SIZE;
      const size = Math.min(STICKER_ART_SIZE, max);
      const asset = await provider.load(id, d.formats.includes('png') ? { format: 'png', size } : { format: d.formats[0] ?? 'svg', size });
      const px = await rasterize(asset, size);
      if (!(px.width > 0 && px.height > 0) || px.data.length !== px.width * px.height * 4) throw new StickerError('load_failed', `The art for "${ref}" came back empty or the wrong size.`);
      return { ...px, tintable: d.tintable };
    })();
    this.entries.set(ref, { status: 'loading', promise });
    return promise.then(
      (art) => {
        this.entries.set(ref, { status: 'ready', art });
        return art;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.entries.set(ref, { status: 'failed', error: message });
        throw err;
      }
    );
  }

  /** Forgets every load (a new provider). */
  clear(): void {
    this.entries.clear();
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
