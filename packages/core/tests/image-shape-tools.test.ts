import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider } from '../src/image-editor';

const W = 64;
const H = 48;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  return { c, registry };
}

const out = (res: { structuredContent?: unknown }) => res.structuredContent as Record<string, any>;
const errorText = (res: { content?: Array<{ type: string; text?: string }> }) => res.content?.map((p) => p.text ?? '').join(' ') ?? '';
const steps = (c: ImageEditorController) => (c as unknown as { undoStack: unknown[] }).undoStack.length;

describe('shape layer agent tools', () => {
  it('add_shape_layer creates a live shape and returns the layer and its components', async () => {
    const { c, registry } = setup();
    const n = steps(c);
    const res = await registry.callTool('add_shape_layer', {
      shape: { kind: 'rect', x: 10, y: 8, width: 30, height: 20, radius: 4 },
      fill: '#3366ff',
      stroke: { width: 2, paint: '#000000', align: 'inside' },
      name: 'Card',
    });
    expect(res.isError).toBeFalsy();
    const r = out(res);
    expect(r.layer).toMatchObject({ type: 'shape', name: 'Card', active: true, shape: { components: [{ op: 'combine', kind: 'rect' }], fill: 'color', stroke: { width: 2, paint: 'color' } } });
    expect(r.shape.components[0].live).toEqual({ kind: 'rect', x: 10, y: 8, width: 30, height: 20, radii: [4, 4, 4, 4] });
    expect(r.shape.stroke).toEqual({ width: 2, paint: { type: 'color', color: '#000000' }, align: 'inside' });
    expect(r.shape.bounds).toEqual({ x: 10, y: 8, width: 30, height: 20 });
    expect(steps(c)).toBe(n + 1);
  });

  it('builds compound shapes from components and SVG path data', async () => {
    const { registry } = setup();
    const r = out(
      await registry.callTool('add_shape_layer', {
        components: [{ shape: { kind: 'ellipse', x: 0, y: 0, width: 40, height: 40 } }, { subpaths: 'M 10 10 h 20 v 20 h -20 Z', op: 'subtract' }],
        fill: { type: 'gradient', gradient: { stops: [{ position: 0, color: 'red' }, { position: 1, color: 'blue' }], style: 'radial' } },
      })
    );
    expect(r.shape.components.map((x: any) => x.op)).toEqual(['combine', 'subtract']);
    expect(r.shape.components[1].live).toBeNull();
    expect(r.shape.fill).toMatchObject({ type: 'gradient', gradient: { style: 'radial', stops: [{ color: '#ff0000' }, { color: '#0000ff' }], align: true } });
  });

  it('update_shape, set_shape_component, add / remove / merge components: one undo step each, results returned', async () => {
    const { c, registry } = setup();
    const id = out(await registry.callTool('add_shape_layer', { shape: { kind: 'star', x: 4, y: 4, width: 30, height: 30 }, fill: '#ff0000' })).layer.id;
    const n = steps(c);
    let r = out(await registry.callTool('update_shape', { layerId: id, stroke: { width: 3, color: '#00ff00', dashes: [2, 1] }, fillRule: 'evenodd' }));
    expect(r.stroke).toEqual({ width: 3, paint: { type: 'color', color: '#00ff00' }, dashes: [2, 1] });
    expect(r.fillRule).toBe('evenodd');
    r = out(await registry.callTool('set_shape_component', { layerId: id, componentIndex: 0, shape: { points: 8, innerRatio: 0.3 } }));
    expect(r.components[0].live).toMatchObject({ kind: 'star', points: 8, innerRatio: 0.3, x: 4, width: 30 });
    r = out(await registry.callTool('add_shape_component', { layerId: id, shape: { kind: 'ellipse', x: 10, y: 10, width: 10, height: 10 }, op: 'exclude' }));
    expect(r.components).toHaveLength(2);
    r = out(await registry.callTool('set_shape_component', { layerId: id, componentIndex: 1, op: 'intersect' }));
    expect(r.components[1].op).toBe('intersect');
    r = out(await registry.callTool('merge_shape_components', { layerId: id }));
    expect(r.components).toHaveLength(1);
    // The merged outline fills the same under either rule, so the rule goes back to the default.
    expect(r.fillRule).toBe('nonzero');
    r = out(await registry.callTool('add_shape_component', { layerId: id, subpaths: [{ anchors: [{ x: 40, y: 2 }, { x: 60, y: 2 }, { x: 50, y: 20 }] }] }));
    r = out(await registry.callTool('remove_shape_component', { layerId: id, componentIndex: 1 }));
    expect(r.components).toHaveLength(1);
    expect(steps(c)).toBe(n + 7);
    r = out(await registry.callTool('get_shape_layer', { layerId: id }));
    expect(r).toMatchObject({ id, fillRule: 'nonzero', components: [{ index: 0, op: 'combine', live: null }] });
    expect(steps(c)).toBe(n + 7);
  });

  it('rasterize_layer turns a shape into pixels', async () => {
    const { c, registry } = setup();
    const id = out(await registry.callTool('add_shape_layer', { shape: { kind: 'line', x1: 4, y1: 4, x2: 40, y2: 30, weight: 3, endArrow: { width: 10, length: 8 } }, fill: '#000' })).layer.id;
    const before = c.compositePixels().data;
    const r = out(await registry.callTool('rasterize_layer', { layerId: id }));
    expect(r.layer).toMatchObject({ id, type: 'pixel' });
    expect(c.compositePixels().data).toEqual(before);
  });

  it('refuses bad arguments with messages that say what to fix, and changes nothing', async () => {
    const { c, registry } = setup();
    const id = out(await registry.callTool('add_shape_layer', { shape: { kind: 'ellipse', x: 0, y: 0, width: 10, height: 10 } })).layer.id;
    const n = steps(c);
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['add_shape_layer', {}, /shape .* or subpaths .* is required/],
      ['add_shape_layer', { shape: { kind: 'hexagon', x: 0, y: 0, width: 1, height: 1 } }, /kind|anyOf|schema/i],
      ['add_shape_layer', { shape: { kind: 'line', x1: 1, y1: 1, x2: 1, y2: 1 } }, /same point/],
      ['add_shape_layer', { subpaths: 'not a path' }, /SVG path data/],
      ['add_shape_layer', { shape: { kind: 'rect', x: 0, y: 0, width: 2, height: 2 }, fill: null }, /neither fill nor stroke/],
      ['add_shape_layer', { shape: { kind: 'rect', x: 0, y: 0, width: 2, height: 2 }, fill: { type: 'pattern', patternId: '' } }, /patternId/],
      ['update_shape', { layerId: id }, /Give fill, stroke or fillRule/],
      ['update_shape', { layerId: 'background', fill: '#fff' }, /not a shape layer/],
      ['update_shape', { layerId: 'ghost', fill: '#fff' }, /Unknown layer "ghost"/],
      ['set_shape_component', { layerId: id, componentIndex: 5, op: 'subtract' }, /componentIndex must be 0\.\.0/],
      ['set_shape_component', { layerId: id, componentIndex: 0 }, /Give shape, subpaths or op/],
      ['remove_shape_component', { layerId: id, componentIndex: 0 }, /only component/],
      ['merge_shape_components', { layerId: id }, /nothing to merge/],
      ['add_shape_component', { layerId: id, shape: { kind: 'rect', x: 0, y: 0, width: 2, height: 2 }, index: 9 }, /index must be 0\.\.1/],
    ];
    for (const [tool, args, message] of cases) {
      const res = await registry.callTool(tool, args);
      expect(res.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(errorText(res)).toMatch(message);
    }
    expect(steps(c)).toBe(n);
  });
});
