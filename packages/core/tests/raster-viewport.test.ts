import { describe, expect, it } from 'vitest';
import {
  SurfaceViewportRenderer,
  drawSurfaceToViewport,
  emptySurface,
  fillRect,
  screenToWorld,
  surfaceMipLevel,
  surfaceResolutionForZoom,
  surfaceToWorld,
  visibleSurfaceRect,
  worldRectToSurface,
  worldToSurface,
  writeRegion,
  type TiledSurface,
} from '../src/raster';

/** A fake canvas that keeps its pixels, and a context that records draws. */
function fakeCanvas() {
  const made: { w: number; h: number; data: Uint8ClampedArray | null }[] = [];
  const createCanvas = (w: number, h: number) => {
    const c = { w, h, data: null as Uint8ClampedArray | null };
    made.push(c);
    return {
      c,
      getContext: () => ({
        createImageData: (iw: number, ih: number) => ({ data: new Uint8ClampedArray(iw * ih * 4) }),
        putImageData: (img: { data: Uint8ClampedArray }) => {
          c.data = img.data;
        },
      }),
    };
  };
  const draws: { c: { data: Uint8ClampedArray | null }; x: number; y: number; w: number; h: number }[] = [];
  const ctx = { imageSmoothingEnabled: true, drawImage: (img: any, x: number, y: number, w: number, h: number) => draws.push({ c: img.c, x, y, w, h }) };
  return { createCanvas, made, draws, ctx };
}

const paint = (s: TiledSurface, x: number, y: number, w: number, h: number, rgba: [number, number, number, number]) => fillRect(s, { x, y, width: w, height: h }, rgba);

describe('world ↔ surface mapping', () => {
  it('maps points and rectangles both ways', () => {
    const m = { origin: { x: -100, y: 50 }, pixelsPerUnit: 2 };
    expect(worldToSurface(m, -100, 50)).toEqual({ x: 0, y: 0 });
    expect(worldToSurface(m, 0, 60)).toEqual({ x: 200, y: 20 });
    expect(surfaceToWorld(m, 200, 20)).toEqual({ x: 0, y: 60 });
    expect(worldRectToSurface(m, { x: -99.7, y: 50.2, width: 1, height: 1 })).toEqual({ x: 0, y: 0, width: 3, height: 3 });
    expect(screenToWorld({ x: 10, y: 20, zoom: 2 }, 30, 40)).toEqual({ x: 10, y: 10 });
    expect(visibleSurfaceRect({}, { x: -100, y: 0, zoom: 0.5 }, 200, 100)).toEqual({ x: 200, y: 0, width: 400, height: 200 });
  });

  it('picks a power-of-two density for a zoom, clamped', () => {
    expect(surfaceResolutionForZoom(1)).toBe(1);
    expect(surfaceResolutionForZoom(1.2)).toBe(2);
    expect(surfaceResolutionForZoom(1, { devicePixelRatio: 2 })).toBe(2);
    expect(surfaceResolutionForZoom(0.3)).toBe(0.5);
    expect(surfaceResolutionForZoom(0.01)).toBe(0.25);
    expect(surfaceResolutionForZoom(100, { max: 4 })).toBe(4);
    expect(surfaceMipLevel(1)).toBe(0);
    expect(surfaceMipLevel(0.5)).toBe(0);
    expect(surfaceMipLevel(0.4)).toBe(1);
    expect(surfaceMipLevel(0.1)).toBe(3);
    expect(surfaceMipLevel(0.001)).toBe(4);
  });
});

describe('drawSurfaceToViewport', () => {
  it('draws only the visible tiles, at whole pixels, and caches tile images by tile', () => {
    let s = emptySurface(4);
    s = paint(s, 0, 0, 10, 10, [255, 0, 0, 255]); // tile (0, 0)
    s = paint(s, 600, 0, 10, 10, [0, 255, 0, 255]); // tile (2, 0)
    s = paint(s, -300, -300, 10, 10, [0, 0, 255, 255]); // tile (−2, −2)
    const f = fakeCanvas();
    const renderer = new SurfaceViewportRenderer(f.createCanvas);
    const view = { x: 0.4, y: 0, zoom: 1 };
    const stats = drawSurfaceToViewport(f.ctx, s, {}, view, { width: 300, height: 200, renderer });
    expect(stats).toEqual({ level: 0, drawn: 1, built: 1 });
    expect(f.draws[0]).toMatchObject({ x: 0, y: 0, w: 256, h: 256 });
    // Same tiles: nothing rebuilt. Edit tile (0, 0): only it is rebuilt.
    expect(renderer.draw(f.ctx, s, {}, view, { width: 300, height: 200 }).built).toBe(0);
    s = paint(s, 20, 20, 4, 4, [9, 9, 9, 255]);
    expect(renderer.draw(f.ctx, s, {}, view, { width: 300, height: 200 }).built).toBe(1);
    // A view over the left-hand tile finds it at negative tile coordinates.
    f.draws.length = 0;
    renderer.draw(f.ctx, s, { pixelsPerUnit: 2 }, { x: 300, y: 300, zoom: 2 }, { width: 100, height: 100 });
    expect(f.draws).toHaveLength(1);
    expect(f.draws[0]).toMatchObject({ x: -212, y: -212, w: 256, h: 256 });
  });

  it('places neighbouring tiles edge to edge at fractional zooms', () => {
    let s = emptySurface(4);
    for (let i = 0; i < 4; i++) s = paint(s, i * 256, 0, 256, 4, [10, 20, 30, 255]);
    const f = fakeCanvas();
    new SurfaceViewportRenderer(f.createCanvas).draw(f.ctx, s, { origin: { x: 0.3, y: 0 } }, { x: 0.37, y: 0, zoom: 0.913 }, { width: 2000, height: 100 });
    f.draws.sort((a, b) => a.x - b.x);
    for (let i = 1; i < f.draws.length; i++) expect(f.draws[i].x).toBe(f.draws[i - 1].x + f.draws[i - 1].w);
  });

  it('draws mip levels when zoomed out, averaging premultiplied colour', () => {
    let s = emptySurface(4);
    // Tile (0, 0) half opaque red, half transparent; tile (1, 0) opaque blue.
    s = paint(s, 0, 0, 128, 256, [255, 0, 0, 255]);
    s = paint(s, 256, 0, 256, 256, [0, 0, 255, 255]);
    const f = fakeCanvas();
    const renderer = new SurfaceViewportRenderer(f.createCanvas);
    const stats = renderer.draw(f.ctx, s, {}, { x: 0, y: 0, zoom: 0.25 }, { width: 400, height: 400 });
    expect(stats.level).toBe(2);
    expect(f.draws).toHaveLength(1);
    expect(f.draws[0]).toMatchObject({ x: 0, y: 0, w: 256, h: 256 });
    const data = f.draws[0].c.data!;
    const px = (x: number, y: number) => [...data.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)];
    // Level 2: tile (0, 0) fills x 0..63, tile (1, 0) x 64..127, 4×4 blocks.
    expect(px(10, 10)).toEqual([255, 0, 0, 255]);
    expect(px(32, 10)).toEqual([0, 0, 0, 0]);
    expect(px(80, 10)).toEqual([0, 0, 255, 255]);
    // An edge block half covered keeps its colour at half alpha (no dark fringe).
    let edge = emptySurface(4);
    edge = writeRegion(edge, { x: 0, y: 0, width: 2, height: 2 }, [255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0]);
    const g = fakeCanvas();
    new SurfaceViewportRenderer(g.createCanvas).draw(g.ctx, edge, {}, { x: 0, y: 0, zoom: 0.4 }, { width: 100, height: 100 });
    expect([...g.draws[0].c.data!.subarray(0, 4)]).toEqual([255, 0, 0, 128]);
    // Unchanged tiles: the mip is reused.
    expect(renderer.draw(f.ctx, s, {}, { x: 0, y: 0, zoom: 0.25 }, { width: 400, height: 400 }).built).toBe(0);
  });

  it('refuses one-channel surfaces', () => {
    const f = fakeCanvas();
    expect(() => new SurfaceViewportRenderer(f.createCanvas).draw(f.ctx, emptySurface(1), {}, { x: 0, y: 0, zoom: 1 }, { width: 10, height: 10 })).toThrow(/RGBA/);
  });
});
