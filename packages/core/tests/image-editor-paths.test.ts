import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, imagePlaybackPanel, selectionArea } from '../src/image-editor';

const W = 80;
const H = 60;

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
  return { c, call, fails };
}

const RECT = { kind: 'rect', x: 10, y: 10, width: 30, height: 20 };

describe('document paths', () => {
  it('makes a work path from the selection, replaces it, and keeps it once renamed', async () => {
    const { c, call, fails } = setup();
    await fails('make_work_path', {}, /Nothing is selected/);
    await call('select_ellipse', { x: 10, y: 10, width: 40, height: 30 });
    const first = (await call('make_work_path')).path;
    expect(first).toMatchObject({ name: 'Work Path', work: true, fillRule: 'evenodd' });
    expect(first.bounds.x).toBeCloseTo(10, 0);
    await call('select_rect', { x: 5, y: 5, width: 10, height: 10 });
    const second = (await call('make_work_path')).path;
    // The Work Path is replaced, not added to.
    expect(second.id).toBe(first.id);
    expect((await call('list_paths')).paths).toHaveLength(1);
    await call('rename_path', { pathId: second.id, name: 'Square' });
    await call('select_rect', { x: 20, y: 20, width: 10, height: 10 });
    await call('make_work_path');
    const paths = (await call('list_paths')).paths;
    expect(paths.map((p: any) => [p.name, p.work])).toEqual([
      ['Square', false],
      ['Work Path', true],
    ]);
    c.undo();
    expect(c.getPaths()).toHaveLength(1);
  });

  it('adds, reads, edits, duplicates and deletes paths', async () => {
    const { c, call, fails } = setup();
    const added = (await call('add_path', { name: 'Box', shape: RECT })).path;
    expect(added).toMatchObject({ name: 'Box', work: false, anchors: 4, bounds: { x: 10, y: 10, width: 30, height: 20 } });
    const read = (await call('get_path', { pathId: added.id })).path;
    expect(read.svg).toMatch(/^M/);
    expect(read.components[0].subpaths[0].anchors).toHaveLength(4);
    await call('set_path_geometry', { pathId: added.id, subpaths: 'M 0 0 L 20 0 L 20 20 Z' });
    expect((await call('get_path', { pathId: added.id })).path.anchors).toBe(3);
    const copy = (await call('duplicate_path', { pathId: added.id })).path;
    expect(copy.name).toBe('Box copy');
    expect((await call('delete_path', { pathId: copy.id })).paths).toHaveLength(1);
    c.undo();
    expect(c.getPaths()).toHaveLength(2);
    await fails('add_path', {}, /Give the path/);
    await fails('get_path', { pathId: 'nope' }, /No path "nope"/);
    await fails('rename_path', { pathId: added.id, name: '' }, /name|minLength/);
  });

  it('becomes a selection, a vector mask, a fill and a stroke', async () => {
    const { c, call, fails } = setup();
    const box = (await call('add_path', { name: 'Box', shape: RECT })).path;
    const sel = await call('path_to_selection', { pathId: box.id });
    expect(sel.area).toBe(600);
    await fails('path_to_selection', { pathId: box.id, shape: RECT }, /pathId or shape, not both/);
    const red = c.addPixelLayer({ name: 'Layer' });
    const vm = (await call('add_vector_mask', { layerId: red, pathId: box.id })).vectorMask;
    expect(vm.bounds).toEqual({ x: 10, y: 10, width: 30, height: 20 });
    c.deselect();
    await call('fill_path', { pathId: box.id, layerId: red, color: '#ff0000' });
    const inside = c.compositePixels({ x: 20, y: 20, width: 1, height: 1 }, { layerIds: [red] }).data;
    expect(inside[3]).toBe(255);
    // The selection is untouched.
    expect(c.getSelection()).toBeNull();
    const blue = c.addPixelLayer({ name: 'Stroke' });
    await call('stroke_path', { pathId: box.id, layerId: blue, width: 4, color: '#0000ff' });
    const onEdge = c.compositePixels({ x: 10, y: 20, width: 1, height: 1 }, { layerIds: [blue] }).data;
    const middle = c.compositePixels({ x: 25, y: 20, width: 1, height: 1 }, { layerIds: [blue] }).data;
    expect(onEdge[3]).toBeGreaterThan(100);
    expect(middle[3]).toBe(0);
    expect(c.getSelection()).toBeNull();
    // Each is one undo step.
    c.undo();
    expect(c.compositePixels({ x: 10, y: 20, width: 1, height: 1 }, { layerIds: [blue] }).data[3]).toBe(0);
  });

  it('round-trips through toJSON and PSD files', async () => {
    const { c, call } = setup();
    await call('add_path', { name: 'Box', shape: RECT });
    await call('select_ellipse', { x: 40, y: 20, width: 30, height: 30 });
    await call('make_work_path');
    const json = JSON.parse(JSON.stringify(c.toJSON()));
    const d = setup().c;
    d.loadJSON(json);
    expect(d.getPaths().map((p) => [p.name, Boolean(p.work), p.fillRule ?? 'nonzero'])).toEqual([
      ['Box', false, 'nonzero'],
      ['Work Path', true, 'evenodd'],
    ]);
    const { bytes, warnings } = await c.toPsd();
    expect(warnings.join(' ')).toMatch(/nonzero fill rule/);
    const e = setup().c;
    e.loadPsd(bytes);
    const back = e.getPaths();
    expect(back.map((p) => [p.name, Boolean(p.work)])).toEqual([
      ['Box', false],
      ['Work Path', true],
    ]);
    const box = back[0];
    const b = box.components[0].subpaths[0].anchors.map((a) => [Math.round(a.x), Math.round(a.y)]);
    expect(b).toContainEqual([10, 10]);
    expect(b).toContainEqual([40, 30]);
  });

  it('plays the path tools back on the Select panel', () => {
    for (const name of ['make_work_path', 'fill_path', 'stroke_path', 'rename_path']) expect(imagePlaybackPanel(name), name).toBe('select');
    expect(selectionArea(null)).toBe(0);
  });
});
