import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, imagePlaybackPanel } from '../src/image-editor';

const W = 40;
const H = 20;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(200) });
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await registry.callTool(name, args);
    if (res.isError) throw new Error(String((res.content?.[0] as { text?: string })?.text ?? 'tool error'));
    return res.structuredContent as Record<string, any>;
  };
  const fails = async (name: string, args: Record<string, unknown>, pattern: RegExp) => {
    const res = await registry.callTool(name, args);
    expect(res.isError, `${name} should fail`).toBe(true);
    expect(String((res.content?.[0] as { text?: string })?.text)).toMatch(pattern);
  };
  // A red layer over the whole canvas, on top of the grey Background.
  const red = c.addPixelLayer({ name: 'Red', color: '#ff0000' });
  /** The red channel of the composite at (x, y): 255 where the red layer shows, 200 where the Background does. */
  const at = (x: number, y: number) => c.compositePixels({ x, y, width: 1, height: 1 }).data[1];
  return { c, call, fails, red, at };
}

const RECT = { kind: 'rect', x: 10, y: 0, width: 10, height: 20 };

describe('vector masks', () => {
  it('reveal inside the path, combine with the raster mask, and take one undo step each', async () => {
    const { c, call, fails, red, at } = setup();
    // Green channel: 0 under red, 200 under grey.
    expect([at(5, 5), at(15, 5)]).toEqual([0, 0]);
    const added = await call('add_vector_mask', { layerId: red, shape: RECT });
    expect(added.vectorMask).toMatchObject({ enabled: true, linked: true, inverted: false, bounds: { x: 10, y: 0, width: 10, height: 20 } });
    expect([at(5, 5), at(15, 5), at(25, 5)]).toEqual([200, 0, 200]);
    // A raster mask hiding the top half applies too.
    await call('select_rect', { x: 0, y: 0, width: 40, height: 10, antiAlias: false });
    await call('add_layer_mask', { layerId: red, from: 'hide-selection' });
    await call('deselect');
    expect([at(15, 5), at(15, 15)]).toEqual([200, 0]);
    // Inverted, disabled, density.
    await call('set_vector_mask_properties', { layerId: red, inverted: true });
    expect([at(5, 15), at(15, 15)]).toEqual([0, 200]);
    await call('set_vector_mask_properties', { layerId: red, enabled: false });
    expect([at(5, 15), at(15, 15)]).toEqual([0, 0]);
    await call('set_vector_mask_properties', { layerId: red, enabled: true, inverted: false, density: 0.5 });
    // Half the hidden area shows: the red layer alone is half opaque there.
    expect(c.compositePixels({ x: 5, y: 15, width: 1, height: 1 }, { layerIds: [red] }).data[3]).toBeCloseTo(128, -1);
    c.undo();
    expect([at(5, 15), at(15, 15)]).toEqual([0, 0]);
    // The path can be replaced and read back.
    await call('set_vector_mask_properties', { layerId: red, enabled: true, inverted: false });
    const set = await call('set_vector_mask_path', { layerId: red, subpaths: 'M 0 0 L 5 0 L 5 20 L 0 20 Z' });
    expect(set.vectorMask.components[0].subpaths[0].anchors).toHaveLength(4);
    expect([at(2, 15), at(15, 15)]).toEqual([0, 200]);
    expect((await call('get_vector_mask', { layerId: red })).vectorMask.bounds).toEqual({ x: 0, y: 0, width: 5, height: 20 });
    expect((await call('list_layers')).layers.find((l: any) => l.id === red).vectorMask).toMatchObject({ components: 1 });
    await fails('add_vector_mask', { layerId: 'nope' }, /No layer "nope"/);
    await fails('set_vector_mask_properties', { layerId: red, density: 2 }, /density|maximum/);
    await fails('set_vector_mask_path', { layerId: 'background', shape: RECT }, /no vector mask; add one with add_vector_mask/);
    await fails('add_vector_mask', { layerId: red, from: 'hide-all', shape: RECT }, /starts empty/);
  });

  it('starts empty as reveal-all or hide-all', async () => {
    const { call, red, at } = setup();
    await call('add_vector_mask', { layerId: red });
    expect(at(5, 5)).toBe(0);
    await call('add_vector_mask', { layerId: red, from: 'hide-all' });
    expect(at(5, 5)).toBe(200);
  });

  it('is refused on shape layers', async () => {
    const { c, fails } = setup();
    const shape = c.addShapeLayer({ shape: RECT as never, fill: '#0000ff' });
    await fails('add_vector_mask', { layerId: shape, shape: RECT }, /shape layer, whose path already is its vector mask/);
  });

  it('moves and transforms with a linked layer, and stays when unlinked', async () => {
    const { c, call, red } = setup();
    await call('add_vector_mask', { layerId: red, shape: RECT });
    await call('offset_layer', { layerId: red, dx: 5, dy: 0 });
    expect(c.getVectorMask(red)!.bounds).toEqual({ x: 15, y: 0, width: 10, height: 20 });
    await call('flip_layer', { layerId: red, axis: 'horizontal' });
    const flipped = c.getVectorMask(red)!.bounds!;
    expect(flipped.width).toBeCloseTo(10, 3);
    expect(flipped.x).not.toBeCloseTo(15, 0);
    await call('set_vector_mask_properties', { layerId: red, linked: false });
    const before = c.getVectorMask(red)!.bounds;
    await call('offset_layer', { layerId: red, dx: 3, dy: 0 });
    expect(c.getVectorMask(red)!.bounds).toEqual(before);
  });

  it('loads as a selection, rasterizes into the raster mask, and is removed', async () => {
    const { c, call, red, at } = setup();
    await call('add_vector_mask', { layerId: red, shape: RECT });
    expect(await call('load_selection_from_mask', { layerId: red, source: 'vector' })).toMatchObject({ bounds: { x: 10, y: 0, width: 10, height: 20 } });
    expect(await call('load_selection_from_mask', { layerId: red, source: 'vector', invert: true })).toMatchObject({ area: 600 });
    const r = await call('rasterize_vector_mask', { layerId: red });
    expect(r.mask).toMatchObject({ enabled: true });
    expect(c.getLayer(red)!.vectorMask).toBeUndefined();
    expect([at(5, 5), at(15, 5)]).toEqual([200, 0]);
    c.undo();
    expect(c.getLayer(red)!.vectorMask).toBeDefined();
    expect(c.getLayer(red)!.mask).toBeUndefined();
    await call('remove_vector_mask', { layerId: red });
    expect(at(5, 5)).toBe(0);
  });

  it('round-trips through toJSON and PSD files', async () => {
    const { c, call, red } = setup();
    await call('add_vector_mask', { layerId: red, shape: { kind: 'ellipse', x: 5, y: 2, width: 20, height: 16 } });
    await call('set_vector_mask_properties', { layerId: red, linked: false, feather: 2 });
    const json = JSON.parse(JSON.stringify(c.toJSON()));
    const d = setup().c;
    d.loadJSON(json);
    const back = d.getLayers().find((l) => l.name === 'Red')!;
    expect(back.vectorMask).toMatchObject({ linked: false, feather: 2, components: [{ live: { kind: 'ellipse', x: 5 } }] });

    await call('set_vector_mask_properties', { layerId: red, density: 0.6 });
    const { bytes, warnings } = await c.toPsd();
    expect(warnings.join(' ')).not.toMatch(/density and feather/);
    const e = setup().c;
    e.loadPsd(bytes);
    const fromPsd = e.getLayers().find((l) => l.name === 'Red')!;
    expect(fromPsd.vectorMask).toMatchObject({ linked: false, feather: 2 });
    expect(fromPsd.vectorMask!.density).toBeCloseTo(0.6, 2);
    // Only a vector mask: the mask record carries its parameters, and no raster mask appears.
    expect(fromPsd.mask).toBeUndefined();
    const box = e.getVectorMask(fromPsd.id)!.bounds!;
    expect(box.x).toBeCloseTo(5, 0);
    expect(box.width).toBeCloseTo(20, 0);
  });

  it('plays the vector mask tools back on the Layers panel', () => {
    for (const name of ['add_vector_mask', 'set_vector_mask_path', 'set_vector_mask_properties', 'rasterize_vector_mask', 'remove_vector_mask']) {
      expect(imagePlaybackPanel(name), name).not.toBeNull();
    }
  });
});

describe('vector mask parameters in PSD files', () => {
  it('sit beside a raster mask\'s own density and feather', async () => {
    const fake = { width: 40, height: 20, naturalWidth: 40, naturalHeight: 20, src: 'data:fake' } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    c.setSamplePixels({ width: 40, height: 20, data: new Uint8ClampedArray(40 * 20 * 4).fill(200) });
    const red = c.addPixelLayer({ name: 'Red', color: '#ff0000' });
    c.selectRect({ x: 0, y: 0, width: 20, height: 20 });
    c.addLayerMask(red, 'selection', { density: 0.5, feather: 3 });
    c.addVectorMask(red, 'path', { shape: { kind: 'rect', x: 10, y: 0, width: 10, height: 20 } });
    c.setVectorMaskProps(red, { density: 0.8, feather: 5 });
    const e = new ImageEditorController({ image: fake });
    e.loadPsd((await c.toPsd()).bytes);
    const back = e.getLayers().find((l) => l.name === 'Red')!;
    expect(back.mask!.density).toBeCloseTo(0.5, 2);
    expect(back.mask!.feather).toBe(3);
    expect(back.vectorMask!.density).toBeCloseTo(0.8, 2);
    expect(back.vectorMask!.feather).toBe(5);
    expect(e.getVectorMask(back.id)!.bounds!.x).toBeCloseTo(10, 0);
  });
});
