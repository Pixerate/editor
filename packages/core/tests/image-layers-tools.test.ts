import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, surfaceFromPixels, type ImageLayer, type PixelLayer } from '../src/image-editor';

const W = 40;
const H = 30;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(200) });
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  return { c, registry };
}

describe('list_layers', () => {
  it('describes the stack: Background, adjustment layers, groups and annotations', async () => {
    const { c, registry } = setup();
    c.setAdjustments({ exposure: 12 });
    const adj = c.addAdjustmentLayer({ kind: 'curves', name: 'Contrast' });
    c.addAnnotation({ type: 'line', x: 0, y: 0, endX: 5, endY: 5, strokeColor: '#f00', strokeWidth: 2 });
    const paint: PixelLayer = {
      type: 'pixel', id: 'p', name: 'Paint', visible: true, opacity: 0.5, blend: 'multiply',
      surface: surfaceFromPixels({ width: 3, height: 2, data: new Uint8ClampedArray(24).fill(255) }, 4, 4, 5), offset: { x: 1, y: 1 },
    };
    const group: ImageLayer = { type: 'group', id: 'g', name: 'G', visible: true, opacity: 1, blend: 'pass-through', children: [paint] };
    (c.getState() as { layers: ImageLayer[] }).layers = [...c.getLayers(), group];
    c.setActiveLayer('p');
    const res = await registry.callTool('list_layers', {});
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as { canvas: unknown; activeLayerId: string; layers: Array<Record<string, any>> };
    expect(out.canvas).toEqual({ width: W, height: H });
    expect(out.activeLayerId).toBe('p');
    expect(out.layers.map((l) => l.type)).toEqual(['pixel', 'adjustment', 'shape', 'group']);
    expect(out.layers[2]).toMatchObject({ name: 'Line', shape: { components: [{ op: 'combine', kind: 'line' }], fill: 'color', stroke: null }, annotation: { type: 'line' } });
    expect(out.layers[0]).toMatchObject({ id: 'background', name: 'Background', source: 'document', bounds: { x: 0, y: 0, width: W, height: H } });
    expect(out.layers[0].filters[0]).toMatchObject({ kind: 'develop', exposure: 12 });
    expect(out.layers[1]).toMatchObject({ id: adj, name: 'Contrast', kind: 'curves', mask: null });
    expect(out.layers[3].children[0]).toMatchObject({ id: 'p', active: true, blend: 'multiply', bounds: { x: 5, y: 6, width: 3, height: 2 } });
  });

  it('rejects arguments', async () => {
    const { registry } = setup();
    const res = await registry.callTool('list_layers', { depth: 2 });
    expect(res.isError).toBe(true);
  });
});
