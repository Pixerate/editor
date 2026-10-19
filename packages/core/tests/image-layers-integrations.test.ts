import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  ImageEditorController,
  createImageEditorToolProvider,
  pngDataUrl,
  readPixel,
  type ImageEditorAssetStore,
  type PixelLayer,
  type SerializedLayeredImageEditorState,
} from '../src/image-editor';

const W = 40;
const H = 20;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) data.set([200, 100, 50, 255], i);
  c.setSamplePixels({ width: W, height: H, data });
  return c;
}

/** A W × H PNG data URL: solid colour, alpha 0 left of `cut`. */
function result(color: [number, number, number], cut = 0) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let p = 0; p < W * H; p++) data.set([...color, p % W < cut ? 0 : 255], p * 4);
  return pngDataUrl(W, H, data);
}

const at = (c: ImageEditorController, x: number, y: number) => Array.from(c.compositePixels({ x, y, width: 1, height: 1 }).data);

describe('AI results and layers', () => {
  it('single-layer documents keep replacing the Background (no DOM: the target can be forced)', () => {
    const c = setup();
    expect(c.isMultiLayer).toBe(false);
    c.addAdjustmentLayer('invert');
    c.addAnnotation({ type: 'line', x: 0, y: 0, endX: 3, endY: 3, strokeColor: '#f00', strokeWidth: 1 });
    // Adjustment and annotation layers are edits, not images.
    expect(c.isMultiLayer).toBe(false);
    c.addPixelLayer();
    expect(c.isMultiLayer).toBe(true);
  });

  it('inpainting in a multi-layer document adds a layer above the active one, limited to the selection', async () => {
    const c = setup();
    const top = c.addPixelLayer({ name: 'Top' });
    c.setActiveLayer('background');
    c.selectRect({ x: 0, y: 0, width: 10, height: H });
    const id = (await c.applyInpaintedImage(result([0, 0, 255])))!;
    expect(c.getLayers().map((l) => l.id)).toEqual(['background', id, top]);
    expect(c.getLayer(id)!.name).toBe('Inpaint');
    expect(at(c, 5, 5)).toEqual([0, 0, 255, 255]);
    expect(at(c, 20, 5)).toEqual([200, 100, 50, 255]);
    c.undo();
    expect(c.getLayers().map((l) => l.id)).toEqual(['background', top]);
  });

  it('background removal in a multi-layer document masks the target layer with the result alpha', async () => {
    const c = setup();
    const top = c.addPixelLayer({ color: '#00ff00' });
    const id = await c.applyBackgroundRemovedImage(result([0, 0, 0], 15));
    expect(id).toBe(top);
    const mask = (c.getLayer(top) as PixelLayer).mask!;
    expect(readPixel(mask.surface, 5, 5)).toEqual([0]);
    expect(readPixel(mask.surface, 30, 5)).toEqual([255]);
    expect(at(c, 5, 5)).toEqual([200, 100, 50, 255]);
    expect(at(c, 30, 5)).toEqual([0, 255, 0, 255]);
  });

  it('target: new-layer works in single-layer documents too', async () => {
    const c = setup();
    const id = (await c.applyInpaintedImage(result([1, 2, 3]), { target: 'new-layer' }))!;
    expect(c.getLayers()).toHaveLength(2);
    expect(at(c, 30, 10)).toEqual([1, 2, 3, 255]);
    expect(id).toBe(c.getLayers()[1].id);
  });
});

describe('rasterize layer', () => {
  it('bakes a pixel layer’s filters and refuses layers it cannot rasterize', async () => {
    const c = setup();
    const id = c.addPixelLayer({ color: '#808080' });
    c.addLayerFilter(id, { kind: 'develop', exposure: 40 });
    const before = at(c, 5, 5);
    await c.rasterizeLayer(id);
    const layer = c.getLayer(id) as PixelLayer;
    expect(layer.filters).toBeUndefined();
    expect(at(c, 5, 5)).toEqual(before);
    await expect(c.rasterizeLayer(id)).rejects.toThrow(/no filters to bake/);
    const adj = c.addAdjustmentLayer('invert');
    await expect(c.rasterizeLayer(adj)).rejects.toThrow(/Merge it down or flatten/);
    // A rectangle annotation is a shape layer now and rasterizes anywhere.
    const rect = c.addAnnotation({ type: 'rect', x: 1, y: 1, width: 5, height: 5, strokeColor: '#000', strokeWidth: 1 });
    await c.rasterizeLayer(rect);
    expect(c.getLayer(rect)!.type).toBe('pixel');
    // Image annotations still need a canvas, and say so outside a browser.
    const img = c.addAnnotation({ type: 'image', x: 1, y: 1, width: 5, height: 5, src: 'data:image/png;base64,' });
    await expect(c.rasterizeLayer(img)).rejects.toThrow(/needs a canvas/);
  });

  it('is an agent tool', async () => {
    const c = setup();
    const id = c.addPixelLayer({ color: '#808080' });
    c.addLayerFilter(id, { kind: 'blur', radius: 2 });
    const registry = new ToolRegistry();
    registry.register(createImageEditorToolProvider(c));
    const res = await registry.callTool('rasterize_layer', { layerId: id });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { layer: { filters: unknown[] } }).layer.filters).toEqual([]);
    expect((await registry.callTool('rasterize_layer', { layerId: 'nope' })).isError).toBe(true);
  });
});

describe('selection sampling', () => {
  it('samples the composite (default) or only the active layer', async () => {
    const c = setup();
    const id = c.addPixelLayer();
    c.selectRect({ x: 0, y: 0, width: 10, height: H });
    c.fillPixels({ color: '#0000ff' });
    c.deselect();
    // Composite: the blue strip and the orange Background are different regions.
    await c.magicWand({ x: 30, y: 5 }, { tolerance: 10, antiAlias: false });
    expect(c.getSelection()?.bounds).toEqual({ x: 10, y: 0, width: 30, height: H });
    // Active layer: only the blue strip has pixels; the rest is transparent.
    c.setActiveLayer(id);
    await c.magicWand({ x: 5, y: 5 }, { tolerance: 10, antiAlias: false, sample: 'active-layer' });
    expect(c.getSelection()?.bounds).toEqual({ x: 0, y: 0, width: 10, height: H });
    c.setActiveLayer(null);
    await expect(c.magicWand({ x: 5, y: 5 }, { sample: 'active-layer' })).rejects.toThrow(/active pixel layer/);
  });

  it('select_by_color takes sample', async () => {
    const c = setup();
    const id = c.addPixelLayer();
    c.selectRect({ x: 0, y: 0, width: 10, height: H });
    c.fillPixels({ color: '#0000ff' });
    c.setActiveLayer(id);
    const registry = new ToolRegistry();
    registry.register(createImageEditorToolProvider(c));
    const res = await registry.callTool('select_by_color', { x: 5, y: 5, tolerance: 10, sample: 'active-layer' });
    expect(res.isError).toBeFalsy();
    expect((await registry.callTool('select_by_color', { x: 5, y: 5, sample: 'everything' })).isError).toBe(true);
  });
});

describe('external asset store', () => {
  function memoryStore() {
    const blobs = new Map<string, Blob>();
    let puts = 0;
    const store: ImageEditorAssetStore = {
      async put(blob, info) {
        puts++;
        const ref = `mem://${info.id}/${puts}`;
        blobs.set(ref, blob);
        return ref;
      },
      async get(ref) {
        const b = blobs.get(ref);
        if (!b) throw new Error('not found');
        return b;
      },
    };
    return { store, blobs, puts: () => puts };
  }

  it('keeps pixels out of the JSON and loads them back through the store', async () => {
    const c = setup();
    const id = c.addPixelLayer({ color: '#123456' });
    const { store, puts } = memoryStore();
    const json = (await c.toJSON({ assets: 'external', store })) as SerializedLayeredImageEditorState;
    expect(json.version).toBe(3);
    expect(Object.values(json.assets).every((r) => r.startsWith('mem://'))).toBe(true);
    expect(JSON.stringify(json).length).toBeLessThan(2000);
    // Saving again uploads nothing new.
    await c.toJSON({ assets: 'external', store });
    expect(puts()).toBe(1);
    const d = setup();
    await d.loadJSONAsync(json, { store });
    expect(d.lastLoadProblems).toEqual([]);
    expect(readPixel((d.getLayer(id) as PixelLayer).surface, 3, 3)).toEqual([0x12, 0x34, 0x56, 255]);
  });

  it('reports references it cannot fetch and still loads the rest', async () => {
    const c = setup();
    c.addPixelLayer({ color: '#123456' });
    const { store } = memoryStore();
    const json = (await c.toJSON({ assets: 'external', store })) as SerializedLayeredImageEditorState;
    const d = setup();
    await d.loadJSONAsync(json);
    expect(d.lastLoadProblems.join(' ')).toMatch(/no asset store was given/);
    expect(d.getLayers()).toHaveLength(2);
    const broken = { ...json, assets: Object.fromEntries(Object.keys(json.assets).map((k) => [k, 'mem://missing'])) };
    await d.loadJSONAsync(broken, { store });
    expect(d.lastLoadProblems.join(' ')).toMatch(/could not be fetched/);
  });

  it('old-shape documents stay inline (they have no assets)', async () => {
    const c = setup();
    const { store, puts } = memoryStore();
    expect((await c.toJSON({ assets: 'external', store })).version).toBe(1);
    expect(puts()).toBe(0);
  });
});
