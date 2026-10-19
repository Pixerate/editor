import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, readPixel, type PixelLayer } from '../src/image-editor';

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

describe('get_transform_frame', () => {
  it('returns the frame, its corners and an identity mesh, and changes nothing', async () => {
    const { c, registry, id } = setup();
    const before = c.getState().layers;
    const res = await registry.callTool('get_transform_frame', { layerId: id, meshColumns: 2, meshRows: 1 });
    expect(res.isError).toBeFalsy();
    expect(out(res)).toMatchObject({
      layerId: id,
      content: 'layer',
      moved: ['pixels'],
      frame: { x: 10, y: 10, width: 10, height: 8 },
      corners: [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 18 }, { x: 10, y: 18 }],
      center: { x: 15, y: 14 },
    });
    expect(out(res).mesh.points).toHaveLength(7 * 4);
    expect(c.getState().layers).toBe(before);
    expect(c.getFreeTransform()).toBeNull();
  });

  it('frames a selection copy without adding a layer', async () => {
    const { c, registry, id } = setup();
    c.selectRect({ x: 12, y: 12, width: 4, height: 4 });
    const count = c.getLayers().length;
    const res = await registry.callTool('get_transform_frame', { layerId: id, content: 'selection-copy' });
    expect(out(res)).toMatchObject({ content: 'selection-copy', frame: { x: 12, y: 12, width: 4, height: 4 } });
    expect(c.getLayers().length).toBe(count);
  });
});

describe('transform_layer', () => {
  it('scales about a reference point as one undo step and returns the new bounds', async () => {
    const { c, registry, id } = setup();
    const n = steps(c);
    const res = await registry.callTool('transform_layer', { layerId: id, scaleX: 200, scaleY: 50, reference: 'top-left', interpolation: 'nearest' });
    expect(res.isError).toBeFalsy();
    expect(out(res)).toMatchObject({ layerId: id, content: 'layer', moved: ['pixels'], changed: true, bounds: { x: 10, y: 10, width: 20, height: 4 } });
    expect(steps(c)).toBe(n + 1);
  });

  it('takes a matrix or corners (distort / perspective)', async () => {
    const { registry, id } = setup();
    const m = await registry.callTool('transform_layer', { layerId: id, matrix: [1, 0, 0, 1, 5, 6], interpolation: 'nearest' });
    expect(out(m).bounds).toEqual({ x: 15, y: 16, width: 10, height: 8 });
    const q = await registry.callTool('transform_layer', {
      layerId: id,
      corners: [{ x: 15, y: 16 }, { x: 45, y: 16 }, { x: 40, y: 36 }, { x: 20, y: 36 }],
    });
    expect(q.isError).toBeFalsy();
    const b = out(q).bounds;
    expect(b.x).toBeGreaterThanOrEqual(14);
    expect(b.x + b.width).toBeLessThanOrEqual(46);
    expect(b.y + b.height).toBeLessThanOrEqual(37);
  });

  it('fails usefully and changes nothing', async () => {
    const { c, registry, id } = setup();
    const before = c.getState().layers;
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ layerId: id }, /one way/],
      [{ layerId: id, rotate: 10, matrix: [1, 0, 0, 1, 0, 0] }, /only one way/],
      [{ layerId: id, scaleX: 0 }, /must not be 0/],
      [{ layerId: 'nope', rotate: 10 }, /Unknown layer "nope"/],
      [{ layerId: id, corners: [{ x: 10, y: 10 }, { x: 20, y: 18 }, { x: 20, y: 10 }, { x: 10, y: 18 }] }, /convex/],
      [{ layerId: id, content: 'selection', rotate: 10 }, /Nothing is selected/],
      [{ layerId: id, channel: 'mask', rotate: 10 }, /no mask/],
    ];
    for (const [args, message] of cases) {
      const res = await registry.callTool('transform_layer', args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(errorText(res)).toMatch(message);
    }
    const bad = await registry.callTool('transform_layer', { layerId: id, matrix: [1, 2, 3] });
    expect(bad.isError).toBe(true);
    const extra = await registry.callTool('transform_layer', { layerId: id, rotate: 10, mode: 'scale' });
    expect(extra.isError).toBe(true);
    expect(c.getState().layers).toBe(before);
    expect(c.getFreeTransform()).toBeNull();
  });

  it('transforms the selected pixels or a copy of them', async () => {
    const { c, registry, id } = setup();
    c.selectRect({ x: 10, y: 10, width: 5, height: 8 });
    const res = await registry.callTool('transform_layer', { layerId: id, content: 'selection-copy', dx: 30 });
    expect(out(res)).toMatchObject({ content: 'selection-copy', moved: ['pixels', 'selection'], bounds: { x: 40, y: 10, width: 5, height: 8 } });
    expect(out(res).layerId).not.toBe(id);
    expect(c.getState().activeLayerId).toBe(out(res).layerId);
  });
});

describe('warp_layer', () => {
  it('bends through a preset', async () => {
    const { registry, id } = setup();
    const res = await registry.callTool('warp_layer', { layerId: id, style: 'arc', bend: 50 });
    expect(res.isError).toBeFalsy();
    expect(out(res).bounds.y).toBeLessThan(10);
  });

  it('bends through a mesh from get_transform_frame', async () => {
    const { registry, id } = setup();
    const frame = out(await registry.callTool('get_transform_frame', { layerId: id, meshColumns: 1 }));
    const points = frame.mesh.points.map((p: { x: number; y: number }, i: number) => (i === 0 ? { x: p.x - 6, y: p.y - 6 } : p));
    const res = await registry.callTool('warp_layer', { layerId: id, mesh: { columns: 1, rows: 1, points } });
    expect(res.isError).toBeFalsy();
    expect(out(res).bounds).toMatchObject({ x: 4, y: 4 });
  });

  it('refuses a preset and a mesh together, unknown styles and wrong point counts', async () => {
    const { registry, id } = setup();
    expect(errorText(await registry.callTool('warp_layer', { layerId: id }))).toMatch(/preset style or a mesh/);
    expect(errorText(await registry.callTool('warp_layer', { layerId: id, bend: 20 }))).toMatch(/style is required/);
    expect((await registry.callTool('warp_layer', { layerId: id, style: 'swirl' })).isError).toBe(true);
    const pts = Array.from({ length: 16 }, () => ({ x: 0, y: 0 }));
    expect(errorText(await registry.callTool('warp_layer', { layerId: id, style: 'arc', mesh: { columns: 1, rows: 1, points: pts } }))).toMatch(/not both/);
    expect(errorText(await registry.callTool('warp_layer', { layerId: id, mesh: { columns: 2, rows: 1, points: pts } }))).toMatch(/needs .* = 28 points, got 16/);
  });
});

describe('transform_selection, flip_layer and rotate_layer_90', () => {
  it('moves only the outline', async () => {
    const { c, registry, id } = setup();
    const pixels = (c.getLayer(id) as PixelLayer).surface;
    c.selectRect({ x: 10, y: 10, width: 10, height: 10 });
    const res = await registry.callTool('transform_selection', { dx: 7, dy: 2, interpolation: 'nearest' });
    expect(out(res)).toMatchObject({ changed: true, bounds: { x: 17, y: 12, width: 10, height: 10 } });
    expect((c.getLayer(id) as PixelLayer).surface).toBe(pixels);
    c.deselect();
    expect(errorText(await registry.callTool('transform_selection', { dx: 1 }))).toMatch(/Nothing is selected/);
  });

  it('flips and turns exactly', async () => {
    const { c, registry, id } = setup();
    const flip = await registry.callTool('flip_layer', { layerId: id, axis: 'vertical' });
    expect(out(flip).bounds).toEqual({ x: 10, y: 10, width: 10, height: 8 });
    const turn = await registry.callTool('rotate_layer_90', { layerId: id, turn: -90 });
    expect(out(turn).bounds).toEqual({ x: 11, y: 9, width: 8, height: 10 });
    const l = c.getLayer(id) as PixelLayer;
    expect(readPixel(l.surface, 12 - l.offset.x, 12 - l.offset.y)).toEqual([255, 0, 0, 255]);
    expect((await registry.callTool('rotate_layer_90', { layerId: id, turn: 45 })).isError).toBe(true);
    expect((await registry.callTool('flip_layer', { layerId: id })).isError).toBe(true);
  });
});
