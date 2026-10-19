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

/**
 * Decodes an image file (PNG, JPEG, WebP, … whatever the browser reads) into RGBA pixels through
 * `createImageBitmap` and an `OffscreenCanvas`. Browser and Worker only.
 */
export async function decodeImageBlob(blob: Blob): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const g = globalThis as unknown as {
    createImageBitmap?: (b: Blob) => Promise<{ width: number; height: number; close?(): void }>;
    OffscreenCanvas?: new (w: number, h: number) => { getContext(type: '2d'): { drawImage(img: unknown, x: number, y: number): void; getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } | null };
  };
  if (typeof g.createImageBitmap !== 'function' || typeof g.OffscreenCanvas !== 'function') throw new Error('Decoding images needs a browser (createImageBitmap and OffscreenCanvas).');
  const bitmap = await g.createImageBitmap(blob);
  const canvas = new g.OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D context to decode with.');
  ctx.drawImage(bitmap, 0, 0);
  const data = new Uint8ClampedArray(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data);
  bitmap.close?.();
  return { width: bitmap.width, height: bitmap.height, data };
}

/** Saves bytes as a file through a temporary link. Browser only. */
export function downloadBytes(bytes: Uint8Array | string, fileName: string, mimeType: string): void {
  const g = globalThis as unknown as {
    document?: { createElement(tag: 'a'): { href: string; download: string; click(): void } };
    URL?: { createObjectURL(b: Blob): string; revokeObjectURL(u: string): void };
    Blob?: new (parts: unknown[], options: { type: string }) => Blob;
  };
  if (!g.document || !g.URL || !g.Blob) throw new Error('Downloading needs a browser.');
  const url = g.URL.createObjectURL(new g.Blob([bytes], { type: mimeType }));
  const a = g.document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => g.URL!.revokeObjectURL(url), 1000);
}
