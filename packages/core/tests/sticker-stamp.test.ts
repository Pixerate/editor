import { describe, expect, it } from 'vitest';
import { createFakeStickerProvider, editorStickers } from '../src/stickers';
import {
  PaintEditorController,
  renderStickerStamp,
  renderStickerStampFrom,
  StickerArtCache,
  stickerArtFrame,
  tintStickerArt,
  defaultStickerRasterizer,
} from '../src/paint-editor';
import { readRegion } from '../src/raster/surface';
import { syntheticArt } from './helpers/sticker-art';

const fake = createFakeStickerProvider();
const load = (ref: string, dark = false) => new StickerArtCache().ensure(fake, ref, defaultStickerRasterizer, dark).then((a) => a!);

/** The largest channel difference; fully transparent pixels count as equal whatever their colour. */
function maxDelta(a: ArrayLike<number>, b: ArrayLike<number>): number {
  expect(a.length).toBe(b.length);
  let m = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] === 0 && b[i + 3] === 0) continue;
    for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(a[i + k] - b[i + k]));
  }
  return m;
}

describe('renderStickerStamp', () => {
  it('draws a tintable sticker as a flat silhouette in the paint colour, with the art’s alpha', async () => {
    const art = await load('fake:weather-sun');
    const stamp = renderStickerStamp(art, { colour: '#3366CC', size: 40 });
    expect([stamp.width, stamp.height, stamp.data.length]).toEqual([40, 40, 40 * 40 * 4]);
    // The same art untinted lays the same alpha.
    const own = renderStickerStamp({ ...art, tintable: false }, { colour: '#3366cc', size: 40 });
    let painted = 0;
    for (let i = 0; i < stamp.data.length; i += 4) {
      expect(stamp.data[i + 3]).toBe(own.data[i + 3]);
      if (stamp.data[i + 3] === 0) continue;
      painted++;
      expect([stamp.data[i], stamp.data[i + 1], stamp.data[i + 2]]).toEqual([0x33, 0x66, 0xcc]);
    }
    expect(painted).toBeGreaterThan(600);
    // Any other colour changes only the colour.
    const red = renderStickerStamp(art, { colour: '#ff0000', size: 40 });
    for (let i = 0; i < red.data.length; i += 4) expect(red.data[i + 3]).toBe(stamp.data[i + 3]);
  });

  it('keeps a non-tintable sticker’s own pixels, whatever the colour', async () => {
    const art = await load('fake:fruit-apple');
    const a = renderStickerStamp(art, { colour: '#00ff00', size: 32 });
    expect(renderStickerStamp(art, { colour: '#123456', size: 32 }).data).toEqual(a.data);
    // At the art's own size the stamp is the art (pixel centres sample whole pixels).
    const exact = syntheticArt(10, 10, 1, false);
    expect(renderStickerStamp(exact, { colour: '#000000', size: 10 }).data).toEqual(exact.data);
    // The tile's top half is green, bottom red (the fake's design).
    const px = (s: { data: Uint8ClampedArray }, x: number, y: number) => Array.from(s.data.slice((y * 32 + x) * 4, (y * 32 + x) * 4 + 4));
    expect(px(a, 16, 8)).toEqual([0x16, 0x65, 0x34, 255]);
    expect(px(a, 16, 24)).toEqual([0xdc, 0x26, 0x26, 255]);
  });

  it('wraps frames to the art’s frame count, negative frames from the last', async () => {
    const art = await load('fake:weather-wind');
    expect(art.frames).toHaveLength(4);
    const f = (frame: number) => renderStickerStamp(art, { colour: '#14b8a6', size: 36, frame }).data;
    expect(f(1)).not.toEqual(f(0));
    expect(f(4)).toEqual(f(0));
    expect(f(5)).toEqual(f(1));
    expect(f(-1)).toEqual(f(3));
    expect(f(-4)).toEqual(f(0));
    expect(f(2.7)).toEqual(f(2));
    expect(stickerArtFrame(art, -1)).toBe(art.frames![3]);
    expect(stickerArtFrame(art)).toBe(art.data);
    // Static art has one frame.
    const sun = await load('fake:weather-sun');
    expect(renderStickerStamp(sun, { colour: '#14b8a6', size: 36, frame: 3 }).data).toEqual(renderStickerStamp(sun, { colour: '#14b8a6', size: 36 }).data);
  });

  it('turns clockwise about the centre and keeps the size × size box', () => {
    const art = syntheticArt(10, 10, 1, false);
    const half = renderStickerStamp(art, { colour: '#000000', size: 10, rotation: 180 });
    // 180° maps (x, y) to (9 - x, 9 - y).
    const flipped = new Uint8ClampedArray(art.data.length);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) flipped.set(art.data.subarray((y * 10 + x) * 4, (y * 10 + x) * 4 + 4), ((9 - y) * 10 + (9 - x)) * 4);
    expect(maxDelta(half.data, flipped)).toBeLessThanOrEqual(1);
    // 90° clockwise: the art's top row comes out down the right-hand side.
    const quarter = renderStickerStamp(art, { colour: '#000000', size: 10, rotation: 90 });
    const turned = new Uint8ClampedArray(art.data.length);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) turned.set(art.data.subarray((y * 10 + x) * 4, (y * 10 + x) * 4 + 4), (x * 10 + (9 - y)) * 4);
    expect(maxDelta(quarter.data, turned)).toBeLessThanOrEqual(1);
    expect(quarter.width).toBe(10);
    // Non-finite rotation is 0.
    expect(renderStickerStamp(art, { colour: '#000000', size: 10, rotation: Number.NaN }).data).toEqual(art.data);
  });

  it('gives an empty stamp for size 0 or less, rounds sizes down, and draws an invalid colour black', () => {
    const art = syntheticArt(12, 8, 1, true);
    for (const size of [0, -3, Number.NaN]) expect(renderStickerStamp(art, { colour: '#ffffff', size })).toEqual({ width: 0, height: 0, data: new Uint8ClampedArray(0) });
    expect(renderStickerStamp(art, { colour: '#ffffff', size: 9.8 }).width).toBe(9);
    const black = renderStickerStamp(art, { colour: '#000000', size: 16 }).data;
    expect(renderStickerStamp(art, { colour: 'red', size: 16 }).data).toEqual(black);
    expect(renderStickerStamp(art, { colour: '#fff', size: 16 }).data).toEqual(black);
  });

  it('gives the same pixels as the sticker painted on the canvas', async () => {
    const c = new PaintEditorController({ width: 160, height: 80, stickers: fake });
    const refs = ['fake:weather-sun', 'fake:fruit-apple', 'fake:weather-wind'];
    await c.prepareStickers(refs);
    const cases = [
      { ref: refs[0], x: 10, y: 6, size: 40, rotation: 0, color: '#3366cc' },
      { ref: refs[1], x: 60, y: 9, size: 33, rotation: 30, color: '#3366cc' },
      { ref: refs[2], x: 104, y: 20, size: 41, rotation: -45, color: '#e11d48', frame: 2 },
    ];
    c.addStickers(undefined, cases.map(({ x, y, ...s }) => ({ ...s, x: x + s.size / 2, y: y + s.size / 2 })));
    const surface = c.layerSurface(c.getActiveLayer()!.id)!;
    for (const s of cases) {
      const art = (await load(s.ref))!;
      const stamp = renderStickerStamp(art, { colour: s.color, size: s.size, rotation: s.rotation, frame: s.frame });
      expect(stamp.data, s.ref).toEqual(readRegion(surface, { x: s.x, y: s.y, width: s.size, height: s.size }));
    }
  });

  it('shares its tint with the canvas', () => {
    const out = [0, 0, 0];
    tintStickerArt({ tintable: true }, [0.1, 0.2, 0.3, 1], [1, 0.5, 0], out);
    expect(out).toEqual([1, 0.5, 0]);
    tintStickerArt({ tintable: false }, [0.1, 0.2, 0.3, 1], [1, 0.5, 0], out);
    expect(out).toEqual([0.1, 0.2, 0.3]);
  });
});

describe('renderStickerStampFrom', () => {
  it('loads a provider sticker through the art cache and renders it', async () => {
    const cache = new StickerArtCache();
    const stamp = await renderStickerStampFrom(fake, 'fake:fruit-apple', { colour: '#000000', size: 24, cache });
    expect(cache.status('fake:fruit-apple').status).toBe('ready');
    expect(stamp.data).toEqual(renderStickerStamp(cache.get('fake:fruit-apple')!, { colour: '#000000', size: 24 }).data);
    // The dark variant has a pale top half.
    const dark = await renderStickerStampFrom(fake, 'fake:fruit-apple', { colour: '#000000', size: 24, dark: true });
    expect(Array.from(dark.data.slice((6 * 24 + 12) * 4, (6 * 24 + 12) * 4 + 3))).toEqual([0xf8, 0xfa, 0xfc]);
  });

  it('draws an editor stamp as the canvas does, and refuses unknown refs', async () => {
    const c = new PaintEditorController({ width: 64, height: 64 });
    c.addStickers(undefined, [{ ref: 'editor:star', x: 16, y: 16, size: 32, rotation: 15, color: '#e11d48', seed: 0 }]);
    const canvas = readRegion(c.layerSurface(c.getActiveLayer()!.id)!, { x: 0, y: 0, width: 32, height: 32 });
    const stamp = await renderStickerStampFrom(editorStickers(), 'editor:star', { colour: '#e11d48', size: 32, rotation: 15 });
    expect(stamp.data).toEqual(canvas);
    expect((await renderStickerStampFrom(fake, 'star', { colour: '#e11d48', size: 32, rotation: 15 })).data).toEqual(canvas);
    await expect(renderStickerStampFrom(fake, 'fake:nope', { colour: '#000000', size: 8 })).rejects.toThrow(/No sticker "fake:nope"/);
  });
});
