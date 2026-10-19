import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RasterCompositor,
  emptySurface,
  findLayer,
  flattenLayers,
  insertLayer,
  mapLayer,
  readPixel,
  solidSurface,
  surfaceFromPixels,
  type CompositorProfile,
  type RasterLayer,
  type RasterSources,
} from '../src/raster';

const W = 8;
const H = 4;
const sources: RasterSources = { width: W, height: H };
const at = (data: Uint8ClampedArray, x: number, y: number) => Array.from(data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));

function pixel(id: string, rgba: number, extra: Partial<RasterLayer> = {}): RasterLayer {
  return { type: 'pixel', id, name: id, visible: true, opacity: 1, blend: 'normal', surface: solidSurface(4, { x: 0, y: 0, width: W, height: H }, rgba), offset: { x: 0, y: 0 }, ...extra } as RasterLayer;
}

describe('raster module', () => {
  it('composites a plain stack: pixel layers, groups, masks and blend modes, without any editor', () => {
    const half = new Uint8ClampedArray(W * H).map((_, i) => (i % W < W / 2 ? 255 : 0));
    const layers: RasterLayer[] = [
      pixel('bg', 0x808080ff),
      {
        type: 'group',
        id: 'g',
        name: 'g',
        visible: true,
        opacity: 1,
        blend: 'pass-through',
        children: [pixel('red', 0xff0000ff, { mask: { surface: surfaceFromPixels({ width: W, height: H, data: half }, 1), defaultValue: 0 } })],
      },
      pixel('mul', 0x0000ffff, { blend: 'multiply', opacity: 0.5 }),
    ];
    const out = new RasterCompositor().composite(layers, { x: 0, y: 0, width: W, height: H }, sources);
    // Left half: red, then multiply by blue at half strength (red × blue is black).
    expect(at(out, 0, 0)).toEqual([128, 0, 0, 255]);
    // Right half: the mask hides red, so grey under the multiply.
    expect(at(out, W - 1, 0)).toEqual([64, 64, 128, 255]);
  });

  it('lets an editor plug in its own layer kinds through a profile', () => {
    type Invert = { type: 'invert'; id: string; name: string; visible: boolean; opacity: number; blend: 'normal' };
    type L = RasterLayer | Invert;
    const profile: CompositorProfile<L, RasterSources> = {
      isFilterLayer: (l) => l.type === 'invert',
      applyFilterRun: (_layers, acc) => {
        for (let i = 0; i < acc.length; i += 4) for (let c = 0; c < 3; c++) acc[i + c] = 255 - acc[i + c];
      },
    };
    const layers: L[] = [pixel('bg', 0x204060ff), { type: 'invert', id: 'inv', name: 'inv', visible: true, opacity: 1, blend: 'normal' }];
    const out = new RasterCompositor<L>(profile).composite(layers, { x: 0, y: 0, width: W, height: H }, sources);
    expect(at(out, 1, 1)).toEqual([0xdf, 0xbf, 0x9f, 255]);
  });

  it('tree helpers work on any stack', () => {
    let layers: RasterLayer[] = [pixel('a', 0xff)];
    layers = insertLayer(layers, { type: 'group', id: 'g', name: 'g', visible: true, opacity: 1, blend: 'normal', children: [] }, null);
    layers = insertLayer(layers, pixel('b', 0xff), 'g');
    expect(flattenLayers(layers).map((l) => l.id)).toEqual(['a', 'g', 'b']);
    expect(findLayer(layers, 'b')?.parent?.id).toBe('g');
    layers = mapLayer(layers, 'b', (l) => ({ ...l, surface: emptySurface(4) }) as RasterLayer);
    expect(readPixel((findLayer(layers, 'b')!.layer as Extract<RasterLayer, { type: 'pixel' }>).surface, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('imports nothing from the editors, the DOM or a framework', () => {
    const dir = join(__dirname, '../src/raster');
    const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
    expect(files).toContain(join('effects', 'render.ts'));
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      // Relative imports that stay inside the raster module only.
      const outside = imports.filter((i) => !i.startsWith('.') || !resolve(dirname(join(dir, f)), i).startsWith(dir));
      expect(outside, f).toEqual([]);
      expect(/\b(document|window|HTMLCanvasElement|OffscreenCanvas)\b/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), f).toBe(false);
    }
  });
});

describe('paint module', () => {
  it('walks and renders dabs with nothing but raster types', async () => {
    const paint = await import('../src/paint');
    const brush = paint.normalizeBrush({ ...paint.DEFAULT_BRUSH, size: 10, spacing: 0.25 });
    const dabs = paint.walkDabs([{ x: 0, y: 0 }, { x: 20, y: 0 }], brush);
    // One dab at the start, then one every spacing × diameter (2.5 px) along 20 px.
    expect(dabs.length).toBe(9);
  });

  it('imports only from itself, the raster module and the dependency-free tool types', () => {
    const dir = join(__dirname, '../src/paint');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8');
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      // `../tools/registry` is dependency-free (entry-isolation enforces it); the agent tools use its types.
      expect(imports.filter((i) => !i.startsWith('./') && !i.startsWith('../raster/') && i !== '../tools/registry.js'), f).toEqual([]);
    }
  });
});
