import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  ImageEditorController,
  createImageEditorToolProvider,
  createSelectionMask,
  imagePlaybackPanel,
  layerMenu,
  runLayerMenuAction,
  selectionArea,
  selectionToSubpaths,
} from '../src/image-editor';

const W = 120;
const H = 80;

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

/** Pixels where two selections differ by more than half. */
function differing(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 128) n++;
  return n;
}

describe('selection to path', () => {
  it('traces a rectangle into one closed subpath along its edge', () => {
    const d = new Uint8Array(W * H);
    for (let y = 10; y < 40; y++) d.fill(255, y * W + 20, y * W + 70);
    const subpaths = selectionToSubpaths(createSelectionMask(W, H, d), { cornerRoundness: 0 });
    expect(subpaths).toHaveLength(1);
    expect(subpaths[0]!.closed).toBe(true);
    const xs = subpaths[0]!.anchors.map((a) => a.x);
    const ys = subpaths[0]!.anchors.map((a) => a.y);
    expect(Math.min(...xs)).toBeCloseTo(20, 0);
    expect(Math.max(...xs)).toBeCloseTo(70, 0);
    expect(Math.min(...ys)).toBeCloseTo(10, 0);
    expect(Math.max(...ys)).toBeCloseTo(40, 0);
    // Square corners, not the half-pixel diagonals marching squares cuts them with.
    expect(subpaths[0]!.anchors).toHaveLength(4);
    for (const a of subpaths[0]!.anchors) {
      expect([20, 70]).toContainEqual(Math.round(a.x));
      expect(Math.abs(a.x - Math.round(a.x))).toBeLessThan(0.01);
      expect(Math.abs(a.y - Math.round(a.y))).toBeLessThan(0.01);
    }
  });

  it('round-trips an ellipse with a hole through a path within a pixel of its edge', async () => {
    const { c, call } = setup();
    await call('select_ellipse', { x: 10, y: 10, width: 90, height: 60 });
    await call('select_ellipse', { x: 40, y: 30, width: 20, height: 20, mode: 'subtract' });
    const before = c.getSelection()!;
    const path = await call('selection_to_path', { tolerance: 0.5 });
    expect(path).toMatchObject({ fillRule: 'evenodd' });
    expect(path.svg).toMatch(/^M/);
    expect(path.subpaths).toBeUndefined();
    expect(path.bounds.x).toBeCloseTo(10, 0);
    expect(path.bounds.width).toBeCloseTo(90, 0);
    expect((await call('selection_to_path', { anchors: true })).subpaths).toHaveLength(2);
    await call('deselect');
    await call('path_to_selection', { subpaths: path.svg, fillRule: 'evenodd' });
    const after = c.getSelection()!;
    // The hole stays a hole, and only edge pixels differ.
    expect(after.data[40 * W + 50]).toBe(0);
    expect(after.data[40 * W + 20]).toBe(255);
    expect(Math.abs(selectionArea(after) - selectionArea(before)) / selectionArea(before)).toBeLessThan(0.02);
    expect(differing(after.data, before.data)).toBeLessThan(60);
  });

  it('fills a path into the selection by mode, with feather and hard edges', async () => {
    const { c, call, fails } = setup();
    const rect = { kind: 'rect', x: 10, y: 10, width: 40, height: 40 };
    expect(await call('path_to_selection', { shape: rect, antiAlias: false })).toMatchObject({ bounds: { x: 10, y: 10, width: 40, height: 40 }, area: 1600 });
    await call('path_to_selection', { shape: { ...rect, x: 30 }, mode: 'add' });
    expect(c.getSelection()!.bounds).toEqual({ x: 10, y: 10, width: 60, height: 40 });
    const feathered = await call('path_to_selection', { shape: rect, feather: 4 });
    expect(feathered.bounds.x).toBeLessThan(10);
    c.undo();
    expect(c.getSelection()!.bounds).toEqual({ x: 10, y: 10, width: 60, height: 40 });
    // Off the canvas selects nothing.
    expect(await call('path_to_selection', { shape: { ...rect, x: 500 } })).toMatchObject({ empty: true });
    await fails('path_to_selection', {}, /shape .* or subpaths .* is required/);
    await fails('path_to_selection', { shape: rect, feather: -1 }, /feather|minimum/);
  });

  it('makes a vector mask from the selection, from the tool and the layers menu', async () => {
    const { c, call, fails } = setup();
    await fails('selection_to_path', {}, /Nothing is selected/);
    await fails('add_vector_mask', { layerId: 'background', from: 'selection' }, /Nothing is selected/);
    await call('select_ellipse', { x: 10, y: 10, width: 60, height: 40 });
    const vm = (await call('add_vector_mask', { layerId: 'background', from: 'selection', tolerance: 0.5 })).vectorMask;
    expect(vm).toMatchObject({ fillRule: 'evenodd', inverted: false });
    expect(vm.bounds.x).toBeCloseTo(10, 0);
    await fails('add_vector_mask', { layerId: 'background', from: 'hide-all', tolerance: 1 }, /apply only to from selection/);
    c.removeVectorMask('background');
    c.setActiveLayer('background');
    const item = layerMenu(c).find((m) => m.action === 'add-vector-mask-selection')!;
    expect(item.enabled).toBe(true);
    expect(await runLayerMenuAction(c, 'add-vector-mask-selection')).toBeNull();
    expect(c.getVectorMask('background')!.components).toHaveLength(1);
    c.deselect();
    expect(layerMenu(c).find((m) => m.action === 'add-vector-mask-selection')!.enabled).toBe(false);
  });

  it('refuses a selection too faint to trace', async () => {
    const { c, fails } = setup();
    const d = new Uint8Array(W * H).fill(40);
    c.setSelection(createSelectionMask(W, H, d));
    await fails('selection_to_path', {}, /too small or too faint/);
  });

  it('plays path_to_selection back on the Select panel', () => {
    expect(imagePlaybackPanel('path_to_selection')).toBe('select');
  });
});
