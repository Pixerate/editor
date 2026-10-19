import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, encodePng, bytesToBase64, type SmartObjectLayer } from '../src/image-editor';

const W = 64;
const H = 48;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(200) });
  const data = new Uint8ClampedArray(10 * 8 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
  const id = c.addPixelLayer({ name: 'Block', pixels: { width: 10, height: 8, data }, x: 10, y: 10 });
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  return { c, registry, id };
}

const out = (res: { structuredContent?: unknown }) => res.structuredContent as Record<string, any>;
const errorText = (res: { content?: Array<{ type: string; text?: string }> }) => res.content?.map((p) => p.text ?? '').join(' ') ?? '';
const steps = (c: ImageEditorController) => (c as unknown as { undoStack: unknown[] }).undoStack.length;

async function converted() {
  const s = setup();
  const res = await s.registry.callTool('convert_to_smart_object', { layerIds: [s.id] });
  expect(res.isError).toBeFalsy();
  return s;
}

describe('convert_to_smart_object / get_smart_object / rasterize_smart_object', () => {
  it('converts, reads and rasterizes, one undo step each', async () => {
    const { c, registry, id } = setup();
    const n = steps(c);
    const res = await registry.callTool('convert_to_smart_object', { layerIds: [id], name: 'Logo' });
    expect(out(res).layer).toMatchObject({ id, type: 'smart', name: 'Logo', contents: { kind: 'raster', width: 10, height: 8 } });
    expect(out(res).smartObject.placement.corners[0]).toEqual({ x: 10, y: 10 });
    expect(steps(c)).toBe(n + 1);
    const info = out(await registry.callTool('get_smart_object', { layerId: id }));
    expect(info).toMatchObject({ layerId: id, contents: { kind: 'raster', instances: [id], decoded: true }, placement: { scaleX: 100, scaleY: 100, rotate: 0, affine: true }, smartFilters: { enabled: true, filters: [], mask: null } });
    const r = await registry.callTool('rasterize_smart_object', { layerId: id });
    expect(out(r).layer).toMatchObject({ id, type: 'pixel' });
    expect(steps(c)).toBe(n + 2);
  });

  it('defaults to the active layer and refuses bad input with a useful error', async () => {
    const { registry, id } = setup();
    expect(out(await registry.callTool('convert_to_smart_object', {})).layer.id).toBe(id);
    let res = await registry.callTool('convert_to_smart_object', { layerIds: ['ghost'] });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toMatch(/Unknown layer "ghost"/);
    res = await registry.callTool('convert_to_smart_object', { layerIds: [id], extra: 1 });
    expect(res.isError).toBe(true);
    const bg = (await registry.callTool('list_layers', {})).structuredContent as { layers: Array<{ id: string }> };
    res = await registry.callTool('get_smart_object', { layerId: bg.layers[0].id });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toMatch(/not a smart object; convert it with convert_to_smart_object/);
    res = await registry.callTool('rasterize_smart_object', {});
    expect(res.isError).toBe(true);
  });
});

describe('set_smart_object_transform', () => {
  it('sets scale, rotation and centre absolutely and keeps a warp until removed', async () => {
    const { c, registry, id } = await converted();
    let res = await registry.callTool('set_smart_object_transform', { layerId: id, scaleX: 200, scaleY: 200, x: 32, y: 24 });
    expect(res.isError).toBeFalsy();
    expect(out(res).placement).toMatchObject({ scaleX: 200, scaleY: 200, center: { x: 32, y: 24 } });
    expect(out(res).placement.bounds).toEqual({ x: 22, y: 16, width: 20, height: 16 });
    // Bicubic softens the source edge over about a pixel.
    expect(out(res).bounds).toEqual({ x: 21, y: 15, width: 22, height: 18 });
    res = await registry.callTool('set_smart_object_transform', { layerId: id, warp: { style: 'bulge', bend: 30 } });
    expect(out(res).placement.warp).toBeTruthy();
    expect(out(res).placement.scaleX).toBe(100);
    res = await registry.callTool('set_smart_object_transform', { layerId: id, warp: null });
    expect(out(res).placement.warp).toBeNull();
    expect((c.getLayer(id) as SmartObjectLayer).placement.corners[0]).toEqual({ x: 22, y: 16 });
  });

  it('takes corners or a matrix, and refuses mixes, folds and nothing to set', async () => {
    const { registry, id } = await converted();
    let res = await registry.callTool('set_smart_object_transform', { layerId: id, corners: [{ x: 0, y: 0 }, { x: 20, y: 2 }, { x: 18, y: 16 }, { x: 2, y: 14 }] });
    expect(out(res).placement.affine).toBe(false);
    res = await registry.callTool('set_smart_object_transform', { layerId: id, matrix: [2, 0, 0, 2, 5, 5] });
    expect(out(res).placement.corners).toEqual([{ x: 5, y: 5 }, { x: 25, y: 5 }, { x: 25, y: 21 }, { x: 5, y: 21 }]);
    res = await registry.callTool('set_smart_object_transform', { layerId: id, matrix: [1, 0, 0, 1, 0, 0], rotate: 5 });
    expect(errorText(res)).toMatch(/only one way/);
    res = await registry.callTool('set_smart_object_transform', { layerId: id, corners: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }] });
    expect(errorText(res)).toMatch(/convex/);
    res = await registry.callTool('set_smart_object_transform', { layerId: id });
    expect(errorText(res)).toMatch(/Give something to set/);
    res = await registry.callTool('set_smart_object_transform', { layerId: id, warp: { columns: 1, rows: 1, points: Array(15).fill({ x: 0, y: 0 }) } });
    expect(res.isError).toBe(true);
  });

  it('transform_layer works relative to the current placement on a smart object', async () => {
    const { registry, id } = await converted();
    await registry.callTool('set_smart_object_transform', { layerId: id, scaleX: 50, scaleY: 50 });
    const res = await registry.callTool('transform_layer', { layerId: id, scaleX: 400, scaleY: 400 });
    expect(res.isError).toBeFalsy();
    const info = out(await registry.callTool('get_smart_object', { layerId: id }));
    expect(info.placement.scaleX).toBeCloseTo(200, 3);
    const frame = out(await registry.callTool('get_transform_frame', { layerId: id }));
    expect(frame).toMatchObject({ smartObject: true, frame: { x: 0, y: 0, width: 10, height: 8 } });
  });
});

describe('smart filter tools', () => {
  it('adds, updates, moves, disables and removes filters, returning the stack', async () => {
    const { c, registry, id } = await converted();
    const n = steps(c);
    const a = out(await registry.callTool('add_smart_filter', { layerId: id, kind: 'develop', exposure: 40, blend: 'screen', opacity: 0.5 }));
    expect(a.filter).toMatchObject({ kind: 'develop', exposure: 40, blend: 'screen', opacity: 0.5, enabled: true });
    const b = out(await registry.callTool('add_smart_filter', { layerId: id, kind: 'blur', radius: 2, index: 0 }));
    expect(b.smartFilters.filters.map((f: { kind: string }) => f.kind)).toEqual(['blur', 'develop']);
    const u = out(await registry.callTool('update_smart_filter', { layerId: id, filterId: a.filter.id, enabled: false }));
    expect(u.filter.enabled).toBe(false);
    const m = out(await registry.callTool('move_smart_filter', { layerId: id, filterId: a.filter.id, index: 0 }));
    expect(m.smartFilters.filters.map((f: { id: string }) => f.id)).toEqual([a.filter.id, b.filter.id]);
    const d = out(await registry.callTool('set_smart_filters_enabled', { layerId: id, enabled: false }));
    expect(d.smartFilters.enabled).toBe(false);
    const r = out(await registry.callTool('remove_smart_filter', { layerId: id, filterId: b.filter.id }));
    expect(r.smartFilters.filters).toHaveLength(1);
    expect(steps(c)).toBe(n + 6);
  });

  it('refuses unknown filters, kinds and values before changing anything', async () => {
    const { c, registry, id } = await converted();
    const before = c.getLayers();
    let res = await registry.callTool('add_smart_filter', { layerId: id, kind: 'sharpen' });
    expect(res.isError).toBe(true);
    res = await registry.callTool('add_smart_filter', { layerId: id, kind: 'develop', exposure: 500 });
    expect(res.isError).toBe(true);
    res = await registry.callTool('update_smart_filter', { layerId: id, filterId: 'nope', exposure: 5 });
    expect(errorText(res)).toMatch(/no smart filter "nope"/);
    res = await registry.callTool('move_smart_filter', { layerId: id, filterId: 'nope', index: 0 });
    expect(res.isError).toBe(true);
    expect(c.getLayers()).toBe(before);
  });

  it('sets the filter mask and paints it through channel filter-mask', async () => {
    const { c, registry, id } = await converted();
    await registry.callTool('add_smart_filter', { layerId: id, kind: 'develop', exposure: 60 });
    const res = await registry.callTool('set_smart_filter_mask', { layerId: id, from: 'hide-all', feather: 2 });
    expect(out(res).filterMask).toMatchObject({ kind: 'raster', enabled: true, feather: 2, defaultValue: 0 });
    const paint = await registry.callTool('fill_pixels', { layerId: id, channel: 'filter-mask', color: '#ffffff', useSelection: false });
    expect(paint.isError).toBeFalsy();
    const gone = await registry.callTool('set_smart_filter_mask', { layerId: id, from: 'none' });
    expect(out(gone).filterMask).toBeNull();
    const bad = await registry.callTool('fill_pixels', { layerId: id, channel: 'filter-mask', color: '#ffffff' });
    expect(errorText(bad)).toMatch(/no smart filter mask/);
    expect(c.getSmartObject(id).smartFilters.mask).toBeNull();
    const pixels = await registry.callTool('fill_pixels', { layerId: id, color: '#ffffff' });
    expect(errorText(pixels)).toMatch(/smart object; its pixels come from its contents/);
  });
});

describe('contents tools', () => {
  it('copies linked and unlinked, replaces contents in every linked instance and exports them', async () => {
    const { registry, id } = await converted();
    const linked = out(await registry.callTool('copy_smart_object', { layerId: id, linked: true }));
    const own = out(await registry.callTool('copy_smart_object', { layerId: id }));
    expect(linked.contentsId).not.toBe(own.contentsId);
    const px = new Uint8ClampedArray(4 * 4 * 4).fill(255);
    const png = `data:image/png;base64,${bytesToBase64(encodePng(4, 4, px))}`;
    const res = out(await registry.callTool('replace_smart_object_contents', { layerId: id, image: png, name: 'white.png' }));
    expect(res).toMatchObject({ width: 4, height: 4, layerIds: [id, linked.layer.id] });
    const file = out(await registry.callTool('export_smart_object_contents', { layerId: id }));
    expect(file).toMatchObject({ name: 'white.png', mimeType: 'image/png' });
    expect(file.byteLength).toBeGreaterThan(8);
    const bad = await registry.callTool('replace_smart_object_contents', { layerId: id, image: '' });
    expect(bad.isError).toBe(true);
  });

  it('edits contents with the other tools and closes them, saving or not', async () => {
    const { c, registry, id } = await converted();
    const open = out(await registry.callTool('edit_smart_object_contents', { layerId: id }));
    expect(open).toMatchObject({ width: 10, height: 8, depth: 1, editing: [{ layerId: id }] });
    expect(open.layers).toHaveLength(1);
    const listed = out(await registry.callTool('list_layers', {}));
    expect(listed.layers[0].name).toBe('Layer 0');
    await registry.callTool('fill_pixels', { color: '#00ff00', useSelection: false });
    const closed = out(await registry.callTool('close_smart_object_contents', {}));
    expect(closed).toMatchObject({ layerId: id, changed: true, layerIds: [id], editing: [] });
    const p = c.compositePixels({ x: 12, y: 12, width: 1, height: 1 }).data;
    expect(Array.from(p)).toEqual([0, 255, 0, 255]);
    await registry.callTool('edit_smart_object_contents', { layerId: id });
    await registry.callTool('fill_pixels', { color: '#0000ff', useSelection: false });
    expect(out(await registry.callTool('close_smart_object_contents', { save: false })).changed).toBe(false);
    expect(Array.from(c.compositePixels({ x: 12, y: 12, width: 1, height: 1 }).data)).toEqual([0, 255, 0, 255]);
    const none = await registry.callTool('close_smart_object_contents', {});
    expect(errorText(none)).toMatch(/No smart object contents are open/);
  });
});
