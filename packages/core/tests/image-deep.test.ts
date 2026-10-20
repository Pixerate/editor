import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  ImageEditorController,
  createImageEditorToolProvider,
  readDeepRegion,
  readRegion,
  surfaceDepth,
  surfaceFromDeepPixels,
  type PixelLayer,
} from '../src/image-editor';
import { exportPsd } from '../src/image-editor/psd/export';
import { importPsd } from '../src/image-editor/psd/import';
import { readPsd } from '../src/image-editor/psd/file';

const W = 300;
const H = 20;

/** A smooth 16-bit gradient 8 bits would band (every column a distinct sample). */
function gradient16(): Uint16Array {
  const out = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      out[i] = 20000 + x * 3;
      out[i + 1] = 20000 + x * 5 + y;
      out[i + 2] = 40000 - x * 2;
      out[i + 3] = x < 10 ? 30000 + x : 65535;
    }
  }
  return out;
}

function hdr32(): Float32Array {
  const out = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i++) out.set([(i % W) / 100, 0.25, 0.001 * (i % 7), 1], i * 4);
  return out;
}

const deepLayer = (data: Uint16Array | Float32Array, name = 'Deep'): PixelLayer => ({
  type: 'pixel',
  id: name,
  name,
  visible: true,
  opacity: 1,
  blend: 'normal',
  surface: surfaceFromDeepPixels({ width: W, height: H, data }, 4),
  offset: { x: 0, y: 0 },
});

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  return { c, registry };
}

function psdOf(layer: PixelLayer, depth: 16 | 32): Uint8Array {
  const merged = readRegion(layer.surface, { x: 0, y: 0, width: W, height: H });
  return exportPsd({ width: W, height: H, layers: [layer], merged, depth }).bytes;
}

describe('16- and 32-bit PSD', () => {
  it('a 16-bit file keeps every sample, and its layers live in an Lr16 block', () => {
    const src = gradient16();
    const bytes = psdOf(deepLayer(src), 16);
    const file = readPsd(bytes);
    expect(file.header.depth).toBe(16);
    expect(file.layers).toHaveLength(1);
    const result = importPsd(bytes);
    expect(result.bitDepth).toBe(16);
    expect(result.warnings.join(' ')).not.toMatch(/converted/);
    const layer = result.layers[0] as PixelLayer;
    expect(surfaceDepth(layer.surface)).toBe(16);
    expect(readDeepRegion(layer.surface, { x: 0, y: 0, width: W, height: H }, 16)).toEqual(src);
  });

  it('a 32-bit file keeps linear float values above 1', () => {
    const src = hdr32();
    const result = importPsd(psdOf(deepLayer(src), 32));
    expect(result.bitDepth).toBe(32);
    const back = readDeepRegion((result.layers[0] as PixelLayer).surface, { x: 0, y: 0, width: W, height: H }, 32);
    expect(back).toEqual(src);
    expect(Math.max(...back)).toBeGreaterThan(2);
  });

  it('the editor opens a 16-bit file at 16 bits and saves it back unchanged', async () => {
    const { c } = setup();
    const src = gradient16();
    c.loadPsd(psdOf(deepLayer(src), 16));
    expect(c.bitDepth).toBe(16);
    const saved = await c.toPsd();
    const again = importPsd(saved.bytes);
    expect(readPsd(saved.bytes).header.depth).toBe(16);
    expect(readDeepRegion((again.layers[0] as PixelLayer).surface, { x: 0, y: 0, width: W, height: H }, 16)).toEqual(src);
  });
});

describe('document bit depth', () => {
  it('set_bit_depth converts as one undo step; going down rounds the deep samples', async () => {
    const { c, registry } = setup();
    c.loadPsd(psdOf(deepLayer(gradient16()), 16));
    const id = c.getLayers()[0].id;
    const info = await registry.callTool('get_image_info', {});
    expect(info.structuredContent).toMatchObject({ bitDepth: 16 });
    const to32 = await registry.callTool('set_bit_depth', { depth: 32 });
    expect(to32.structuredContent).toMatchObject({ bitDepth: 32, changedLayerIds: [id], canUndo: true });
    expect(surfaceDepth((c.getLayer(id) as PixelLayer).surface)).toBe(32);
    const to8 = await registry.callTool('set_bit_depth', { depth: 8 });
    expect(to8.structuredContent).toMatchObject({ bitDepth: 8, changedLayerIds: [id] });
    expect(surfaceDepth((c.getLayer(id) as PixelLayer).surface)).toBe(8);
    c.undo();
    expect(c.bitDepth).toBe(32);
    c.undo();
    expect(c.bitDepth).toBe(16);
    expect(readDeepRegion((c.getLayer(id) as PixelLayer).surface, { x: 0, y: 0, width: W, height: H }, 16)).toEqual(gradient16());
    // Going up from 8 bits changes no pixels.
    const { c: c8 } = setup();
    c8.addPixelLayer({ color: '#336699' });
    expect(c8.setBitDepth(16)).toEqual({ bitDepth: 16, changedLayerIds: [] });
    for (const [args, pattern] of [
      [{ depth: 12 }, /Invalid arguments|enum/],
      [{}, /Invalid arguments|required/],
    ] as const) {
      const res = await registry.callTool('set_bit_depth', args as never);
      expect(res.isError).toBe(true);
      expect(String((res.content?.[0] as { text?: string }).text)).toMatch(pattern);
    }
  });

  it('JSON keeps the depth and the deep samples', () => {
    const { c } = setup();
    c.loadPsd(psdOf(deepLayer(hdr32()), 32));
    const json = c.toJSON();
    expect(json).toMatchObject({ bitDepth: 32 });
    const { c: d } = setup();
    d.loadJSON(json);
    expect(d.bitDepth).toBe(32);
    expect(d.lastLoadProblems).toEqual([]);
    const layer = d.getLayers()[0] as PixelLayer;
    expect(readDeepRegion(layer.surface, { x: 0, y: 0, width: W, height: H }, 32)).toEqual(hdr32());
  });

  it('8-bit edits keep the deep samples of the tiles they do not touch', () => {
    const { c } = setup();
    c.loadPsd(psdOf(deepLayer(gradient16()), 16));
    const id = c.getLayers()[0].id;
    // Tile 0 is x 0..255, tile 1 is x 256..299: paint in tile 1 only.
    c.paintStroke({ layerId: id, points: [{ x: 280, y: 10 }], brush: { size: 4, pressureSize: false }, color: '#000000' });
    const s = (c.getLayer(id) as PixelLayer).surface;
    expect(s.getTile(0, 0)!.deep).toBeInstanceOf(Uint16Array);
    expect(readDeepRegion(s, { x: 0, y: 0, width: 256, height: H }, 16)).toEqual(
      (() => {
        const src = gradient16();
        const out = new Uint16Array(256 * H * 4);
        for (let y = 0; y < H; y++) out.set(src.subarray(y * W * 4, (y * W + 256) * 4), y * 256 * 4);
        return out;
      })()
    );
  });
});
