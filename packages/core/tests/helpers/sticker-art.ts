import type { StickerArt } from '../../src/paint-editor';

/** Deterministic art (non-square, `frames` frames, some transparent pixels); the Swift `StickerStampTests` build the same. */
export function syntheticArt(width: number, height: number, frames: number, tintable: boolean): StickerArt {
  const all = Array.from({ length: frames }, (_, f) => {
    const d = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        d[i] = (x * 20 + f * 40) % 256;
        d[i + 1] = (y * 30 + f * 7) % 256;
        d[i + 2] = (x * y * 7 + f * 50) % 256;
        d[i + 3] = (x + y + f) % 4 === 0 ? 0 : (x * 37 + y * 11 + f * 53) % 256;
        if (d[i + 3] === 0) d[i] = d[i + 1] = d[i + 2] = 0;
      }
    return d;
  });
  return { width, height, data: all[0], tintable, ...(frames > 1 ? { frames: all, frameDelay: 100 } : {}) };
}
