/**
 * JPEG and WebP encoding. PNG is encoded in pure TypeScript (`encodePng`); the lossy formats need
 * the platform's codecs, so they go through an `OffscreenCanvas` (browsers and Workers) or a host
 * encoder. Nothing is imported: the globals are looked up at call time.
 */

export type ImageFormat = 'image/png' | 'image/jpeg' | 'image/webp';

/** Encodes straight-alpha RGBA as `format` at `quality` (0..1). */
export type ImageEncoder = (image: { width: number; height: number; data: Uint8ClampedArray }, format: 'image/jpeg' | 'image/webp', quality: number) => Promise<Uint8Array>;

interface CanvasLike {
  getContext(type: '2d'): { putImageData(data: unknown, x: number, y: number): void } | null;
  convertToBlob(options: { type: string; quality: number }): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; type: string }>;
}

/** An encoder through `OffscreenCanvas`, or `null` where there is none (Node, tests). */
export function defaultImageEncoder(): ImageEncoder | null {
  const g = globalThis as unknown as {
    OffscreenCanvas?: new (w: number, h: number) => CanvasLike;
    ImageData?: new (data: Uint8ClampedArray, w: number, h: number) => unknown;
  };
  if (typeof g.OffscreenCanvas !== 'function' || typeof g.ImageData !== 'function') return null;
  const Canvas = g.OffscreenCanvas;
  const Data = g.ImageData;
  return async (image, format, quality) => {
    const canvas = new Canvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D context to encode with.');
    ctx.putImageData(new Data(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    const blob = await canvas.convertToBlob({ type: format, quality });
    if (blob.type !== format) throw new Error(`This browser cannot encode ${format} (it produced ${blob.type || 'nothing'}); export PNG instead.`);
    return new Uint8Array(await blob.arrayBuffer());
  };
}
