import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  ImageEditorController,
  LayerOperationError,
  createImageEditorToolProvider,
  encodePng,
  bytesToBase64,
  readPixel,
  type GroupLayer,
  type PixelLayer,
} from '../src/image-editor';

const W = 40;
const H = 30;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) data.set([100, 150, 200, 255], i);
  c.setSamplePixels({ width: W, height: H, data });
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
  return { c, call, fails };
}

const at = (c: ImageEditorController, x: number, y: number) => Array.from(c.compositePixels({ x, y, width: 1, height: 1 }).data);

describe('layer operations', () => {
  it('adds pixel layers above the active layer, filled, empty or from a PNG', async () => {
    const { c, call } = setup();
    const red = c.addPixelLayer({ color: '#ff0000', name: 'Red', opacity: 0.5 });
    expect(c.getState().activeLayerId).toBe(red);
    expect(at(c, 3, 3)).toEqual([178, 75, 100, 255]);
    const empty = c.addPixelLayer();
    expect(c.getLayers().map((l) => l.id)).toEqual(['background', red, empty]);
    expect(c.getLayer(empty)!.name).toBe('Layer 1');
    c.setActiveLayer(red);
    const png = bytesToBase64(encodePng(2, 2, new Uint8ClampedArray(16).fill(255), 4));
    const out = await call('add_pixel_layer', { image: png, x: 5, y: 6, name: 'Patch' });
    expect(out.layer).toMatchObject({ name: 'Patch', bounds: { x: 5, y: 6, width: 2, height: 2 }, active: true, index: 2 });
    expect(c.getLayers().map((l) => l.name)).toEqual(['Background', 'Red', 'Patch', 'Layer 1']);
    // Undo takes each back in one step.
    c.undo();
    expect(c.getLayers()).toHaveLength(3);
  });

  it('duplicates, moves, groups, ungroups and removes', () => {
    const { c } = setup();
    const a = c.addPixelLayer({ color: '#00ff00' });
    const b = c.duplicateLayer(a);
    expect(c.getLayer(b)!.name).toBe('Layer 1 copy');
    const g = c.groupLayers([a, b], 'Pair');
    const group = c.getLayer(g) as GroupLayer;
    expect(group.children.map((l) => l.id)).toEqual([a, b]);
    expect(c.moveLayer(a, { aboveId: b })).toEqual({ parentId: g, index: 1 });
    expect(c.moveLayer(b, { index: 0 })).toEqual({ parentId: null, index: 0 });
    expect(() => c.moveLayer(g, { parentId: g })).toThrow(LayerOperationError);
    expect(c.ungroupLayer(g)).toEqual([a]);
    c.removeLayer(a);
    expect(c.getLayers().map((l) => l.id)).toEqual([b, 'background']);
    expect(() => c.removeLayer('nope')).toThrow(/Unknown layer "nope"/);
  });

  it('sets properties with validation and respects locks', () => {
    const { c } = setup();
    const a = c.addPixelLayer({ color: '#ffffff' });
    c.setLayerProperties(a, { blend: 'multiply', opacity: 0.5, fillOpacity: 0.5, name: 'Mult' });
    expect(c.getLayer(a)).toMatchObject({ blend: 'multiply', opacity: 0.5, fillOpacity: 0.5, name: 'Mult' });
    expect(() => c.setLayerProperties(a, { opacity: 2 })).toThrow(/opacity/);
    expect(() => c.setLayerProperties(a, { blend: 'pass-through' })).toThrow(/groups/);
    expect(() => c.setLayerProperties('background', { clipped: true })).toThrow(/nothing below/);
    c.setLayerProperties(a, { locks: { all: true } });
    expect(() => c.setLayerProperties(a, { opacity: 1 })).toThrow(/locked/);
    expect(() => c.removeLayer(a)).toThrow(/locked/);
    c.setLayerProperties(a, { visible: false }); // visibility still toggles
    c.setLayerProperties(a, { locks: {} });
    c.setLayerProperties(a, { locks: { position: true } });
    expect(() => c.offsetLayer(a, { dx: 1 })).toThrow(/position locked/);
  });

  it('offsets layers and their masks together', () => {
    const { c } = setup();
    const a = c.addPixelLayer({ color: '#000000' });
    c.selectRect({ x: 0, y: 0, width: 10, height: 10 });
    c.addLayerMask(a, 'selection');
    expect(at(c, 5, 5)).toEqual([0, 0, 0, 255]);
    expect(at(c, 15, 5)).toEqual([100, 150, 200, 255]);
    const res = c.offsetLayer(a, { dx: 10 });
    expect(res.offset).toEqual({ x: 10, y: 0 });
    expect(at(c, 15, 5)).toEqual([0, 0, 0, 255]);
    expect(at(c, 5, 5)).toEqual([100, 150, 200, 255]);
  });

  it('adds, applies and removes masks', async () => {
    const { c } = setup();
    const a = c.addPixelLayer({ color: '#ff0000' });
    c.addLayerMask(a, 'hide-all');
    expect(c.getState().activeTarget).toBe('mask');
    expect(at(c, 1, 1)).toEqual([100, 150, 200, 255]);
    c.setLayerMaskProps(a, { density: 0.5 });
    expect(at(c, 1, 1)[0]).toBeGreaterThan(150);
    await c.applyLayerMask(a);
    const layer = c.getLayer(a) as PixelLayer;
    expect(layer.mask).toBeUndefined();
    expect(readPixel(layer.surface, 1, 1)).toEqual([255, 0, 0, 128]);
    expect(() => c.removeLayerMask(a)).toThrow(/no mask/);
    expect(() => c.addLayerMask(a, 'selection')).toThrow(/Nothing is selected/);
  });

  it('layer via copy and via cut use the selection coverage', () => {
    const { c } = setup();
    c.selectRect({ x: 2, y: 2, width: 4, height: 3 });
    expect(() => c.layerViaCopy()).toThrow(/none is active/);
    const copy = c.layerViaCopy({ layerId: 'background' });
    expect(c.getLayerBounds(copy)).toEqual({ x: 2, y: 2, width: 4, height: 3 });
    c.setActiveLayer('background');
    const cut = c.layerViaCopy({ cut: true });
    expect(c.getLayerBounds(cut)).toEqual({ x: 2, y: 2, width: 4, height: 3 });
    const bg = c.getLayer('background') as PixelLayer;
    expect(bg.source).toBeUndefined();
    expect(readPixel(bg.surface, 3, 3)[3]).toBe(0);
    expect(readPixel(bg.surface, 10, 10)).toEqual([100, 150, 200, 255]);
  });

  it('merges down, merges visible and flattens, baking masks, fill and filters', async () => {
    const { c } = setup();
    // With the lower layer opaque at 100 % the merge looks the same (as in Photoshop; a faded lower
    // layer would fade the merged upper layer too).
    const lower = c.addPixelLayer({ color: '#ff0000', name: 'Lower' });
    c.selectRect({ x: 0, y: 0, width: 20, height: 30 });
    c.addLayerMask(lower, 'selection');
    c.deselect();
    const upper = c.addPixelLayer({ color: '#0000ff' });
    c.setLayerProperties(upper, { blend: 'screen' });
    const before = at(c, 4, 4);
    const merged = await c.mergeDown(upper);
    expect(merged).toBe(lower);
    expect(c.getLayers().map((l) => l.id)).toEqual(['background', lower]);
    expect(c.getLayer(lower)).toMatchObject({ name: 'Lower', opacity: 1 });
    expect(c.getLayer(lower)!.mask).toBeUndefined();
    expect(at(c, 4, 4)).toEqual(before);
    // Where the lower layer was masked out, the screened blue no longer sees the background.
    expect(at(c, 30, 4)).toEqual([0, 0, 255, 255]);
    const adj = c.addAdjustmentLayer('invert');
    const onAdj = c.addPixelLayer({ aboveId: adj });
    await expect(c.mergeDown(onAdj)).rejects.toThrow(/needs a pixel layer below/);
    c.removeLayer(onAdj);
    const pre = at(c, 4, 4);
    await c.mergeVisible();
    expect(c.getLayers()).toHaveLength(1);
    expect(at(c, 4, 4)).toEqual(pre);
    c.undo();
    expect(c.getLayer(adj)).toBeDefined();
    await c.flattenImage();
    expect(c.getLayers()).toHaveLength(1);
    expect(c.getLayers()[0]).toMatchObject({ id: 'background', name: 'Background' });
    expect((c.getLayers()[0] as PixelLayer).source).toBeUndefined();
    expect(at(c, 4, 4)).toEqual(pre);
    expect(c.toJSON().version).toBe(3);
  });

  it('adds, updates and removes layer filters', () => {
    const { c } = setup();
    const a = c.addPixelLayer({ color: '#808080' });
    const filters = c.addLayerFilter(a, { kind: 'develop', exposure: 30 });
    expect(filters).toHaveLength(1);
    expect(() => c.addLayerFilter(a, { kind: 'develop' })).toThrow(/already has a develop filter/);
    const id = filters[0].id;
    expect(c.updateLayerFilter(a, id, { exposure: 10 })[0]).toMatchObject({ exposure: 10 });
    expect(() => c.updateLayerFilter(a, id, { exposure: 500 })).toThrow(/-100 to 100/);
    expect(c.removeLayerFilter(a, id)).toEqual([]);
    // The base sliders follow the active pixel layer.
    c.setAdjustments({ contrast: 20 });
    expect((c.getLayer(a) as PixelLayer).filters?.[0]).toMatchObject({ kind: 'develop', contrast: 20 });
    expect((c.getLayer('background') as PixelLayer).filters?.[0]).toMatchObject({ contrast: 0 });
  });

  it('thumbnails sample the layer over the canvas', () => {
    const { c } = setup();
    const t = c.getLayerThumbnail('background', { maxSide: 8 })!;
    expect([t.width, t.height]).toEqual([8, 6]);
    expect(Array.from(t.data.slice(0, 4))).toEqual([100, 150, 200, 255]);
    expect(c.getLayerThumbnail('background', { maxSide: 8 })).toBe(t);

    const thumbUrl = c.getLayerThumbnailDataURL('background', { maxSide: 8 });
    expect(thumbUrl).toMatch(/^data:image\/png;base64,/);

    const fullUrl = c.getLayerDataURL('background');
    expect(fullUrl).toMatch(/^data:image\/png;base64,/);

    const grp = c.addGroup({ name: 'Folder' });
    expect(c.getLayerThumbnailDataURL(grp)).toBeNull();
    expect(c.getLayerDataURL(grp)).toBeNull();

    expect(c.getLayerThumbnailDataURL('non-existent')).toBeNull();
    expect(c.getLayerDataURL('non-existent')).toBeNull();
  });
});

describe('layer agent tools', () => {
  it('round-trips a small workflow and returns what changed', async () => {
    const { c, call } = setup();
    const added = await call('add_pixel_layer', { color: '#ff000080', name: 'Wash', blend: 'multiply' });
    const id = added.layer.id;
    expect(added.layer).toMatchObject({ type: 'pixel', name: 'Wash', blend: 'multiply', bounds: { x: 0, y: 0, width: W, height: H } });
    expect((await call('set_layer_properties', { layerId: id, opacity: 0.4 })).layer.opacity).toBe(0.4);
    const dup = (await call('duplicate_layer', { layerId: id })).layer.id;
    const grp = await call('group_layers', { layerIds: [id, dup], name: 'Washes' });
    expect(grp.group.children.map((l: { id: string }) => l.id)).toEqual([id, dup]);
    expect(await call('move_layer', { layerId: dup, belowId: id })).toMatchObject({ parentId: grp.group.id, index: 0 });
    expect((await call('ungroup_layer', { layerId: grp.group.id })).childIds).toEqual([dup, id]);
    const empty = await call('add_group', { name: 'Empty', parentId: undefined });
    expect(empty.group).toMatchObject({ type: 'group', name: 'Empty', blend: 'pass-through', children: [] });
    expect((await call('remove_layer', { layerId: empty.group.id })).removed).toBe(empty.group.id);
    expect((await call('offset_layer', { layerId: id, dx: 3, dy: -2 })).offset).toEqual({ x: 3, y: -2 });
    expect((await call('add_layer_mask', { layerId: id, from: 'hide-all', feather: 2 })).mask).toMatchObject({ kind: 'raster', defaultValue: 0, feather: 2 });
    expect((await call('set_layer_mask_properties', { layerId: id, enabled: false })).mask.enabled).toBe(false);
    expect((await call('remove_layer_mask', { layerId: id })).layer.mask).toBeNull();
    const f = await call('add_layer_filter', { layerId: id, kind: 'blur', radius: 3 });
    expect(f.filters[0]).toMatchObject({ kind: 'blur', radius: 3 });
    expect((await call('update_layer_filter', { layerId: id, filterId: f.filters[0].id, radius: 5 })).filters[0].radius).toBe(5);
    expect((await call('remove_layer_filter', { layerId: id, filterId: f.filters[0].id })).filters).toEqual([]);
    await call('select_region', { shape: 'rect', x: 0, y: 0, width: 5, height: 5 });
    const copy = await call('layer_via_copy', { layerId: id });
    expect(copy.layer.bounds).toEqual({ x: 3, y: 0, width: 2, height: 5 });
    expect((await call('merge_down', { layerId: copy.layer.id })).layer.id).toBe(id);
    expect((await call('set_active_layer', { layerId: 'background' })).layer.active).toBe(true);
    const adj = await call('add_adjustment_layer', { kind: 'invert', aboveId: 'background' });
    expect(c.getLayers()[1].id).toBe(adj.layer.id);
    expect((await call('merge_visible')).layer.type).toBe('pixel');
    expect((await call('flatten_image')).layer.id).toBe('background');
    expect((await call('remove_layer', { layerId: 'background' })).layers).toEqual([]);
  });

  it('refuses bad arguments with reasons and changes nothing', async () => {
    const { c, fails } = setup();
    const id = c.addPixelLayer();
    const before = c.getLayers();
    await fails('set_layer_properties', { layerId: 'zzz', opacity: 1 }, /Unknown layer "zzz"/);
    await fails('set_layer_properties', { layerId: id }, /at least one property/);
    await fails('set_layer_properties', { layerId: id, opacity: 3 }, /maximum|opacity/);
    await fails('add_pixel_layer', { color: '#f00', image: 'x' }, /not both/);
    await fails('add_pixel_layer', { color: 'red' }, /Invalid colour/);
    await fails('move_layer', { layerId: id }, /aboveId, belowId, parentId or index/);
    await fails('move_layer', { layerId: id, aboveId: id }, /itself/);
    await fails('group_layers', { layerIds: [] }, /fewer than 1|at least/);
    await fails('ungroup_layer', { layerId: id }, /not a group/);
    await fails('merge_down', { layerId: 'background' }, /bottom/);
    await fails('offset_layer', { layerId: id }, /x and y, or dx and dy/);
    await fails('offset_layer', { layerId: id, x: 1, dx: 1 }, /not both/);
    await fails('apply_layer_mask', { layerId: id }, /no mask/);
    await fails('layer_via_copy', { layerId: id }, /Nothing is selected/);
    await fails('add_layer_filter', { layerId: id, kind: 'sharpen' }, /Invalid arguments|Unknown filter/);
    await fails('update_layer_filter', { layerId: id, filterId: 'f', radius: 2 }, /no filter "f"/);
    await fails('set_active_layer', { layerId: id, target: 'mask' }, /no mask/);
    await fails('render_preview', { layerId: 'zzz' }, /Unknown layer/);
    await fails('add_adjustment_layer', { kind: 'invert', parentId: id }, /not a group/);
    await fails('list_layers', { x: 1 }, /additional|not allowed|unknown/i);
    expect(c.getLayers()).toBe(before);
  });
});
