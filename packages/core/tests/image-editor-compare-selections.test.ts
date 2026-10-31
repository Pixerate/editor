import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, compareSelectionMasks, createImageEditorToolProvider, selectionDiffPixels } from '../src/image-editor';

const W = 100;
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

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, antiAlias: false });

describe('compare_selections', () => {
  it('reports what the last step added, with IoU, and tints it until the selection changes', async () => {
    const { c, call } = setup();
    await call('select_rect', rect(20, 20, 40, 30));
    await call('select_rect', { ...rect(70, 10, 10, 10), mode: 'add' });
    const d = await call('compare_selections');
    expect(d.a.area).toBe(1200);
    expect(d.b.area).toBe(1300);
    expect(d.added).toMatchObject({ area: 100, count: 1, regions: [{ area: 100, bounds: { x: 70, y: 10, width: 10, height: 10 } }] });
    expect(d.removed).toMatchObject({ area: 0, count: 0, regions: [] });
    expect(d.iou).toBeCloseTo(1200 / 1300, 3);
    expect(d.coverageChange).toBe(100);
    expect(d.identical).toBe(false);
    const overlay = c.getState().selectionDiff!;
    expect(overlay.selection).toBe(c.getSelection());
    expect(overlay.added.bounds).toEqual({ x: 70, y: 10, width: 10, height: 10 });
    // Any later change hides it (the overlay is drawn only for the selection it was made for).
    await call('select_rect', rect(0, 0, 5, 5));
    expect(c.getState().selectionDiff!.selection).not.toBe(c.getSelection());
  });

  it('shows removed area from a contract, and an unchanged selection as identical', async () => {
    const { c, call } = setup();
    await call('select_rect', rect(20, 20, 40, 30));
    await call('modify_selection', { op: 'contract', radius: 2 });
    const d = await call('compare_selections', { show: false });
    expect(d.added.area).toBe(0);
    expect(d.removed.area).toBeGreaterThan(0);
    expect(d.removed.regions[0].bounds).toEqual({ x: 20, y: 20, width: 40, height: 30 });
    expect(c.getState().selectionDiff).toBeFalsy();
    const same = await call('compare_selections', { a: { source: 'selection' }, b: { source: 'selection' } });
    expect(same).toMatchObject({ identical: true, iou: 1, coverageChange: 0 });
    expect(c.getState().selectionDiff).toBeNull();
  });

  it('compares channels, layer masks, vector masks and older history steps', async () => {
    const { c, call } = setup();
    await call('select_rect', rect(10, 10, 20, 20));
    const ch = await call('save_selection', { name: 'Box' });
    const channelId = ch.channel?.id ?? ch.id;
    const id = c.getLayers()[0].id;
    await call('add_layer_mask', { layerId: id, from: 'selection' });
    c.addVectorMask(id, 'path', { shape: { kind: 'rect', x: 10, y: 10, width: 20, height: 20 } });
    await call('select_rect', rect(15, 15, 20, 20));
    const vsChannel = await call('compare_selections', { a: { source: 'channel', channelId }, show: false });
    expect(vsChannel.added.area).toBe(400 - 225);
    expect(vsChannel.removed.area).toBe(400 - 225);
    expect((await call('compare_selections', { a: { source: 'layer-mask', layerId: id }, b: { source: 'channel', channelId }, show: false })).identical).toBe(true);
    expect((await call('compare_selections', { a: { source: 'vector-mask', layerId: id }, b: { source: 'channel', channelId }, show: false })).iou).toBeGreaterThan(0.95);
    // Five steps back is before the first rectangle: nothing was selected.
    const back = await call('compare_selections', { a: { source: 'history', steps: 5 }, show: false });
    expect(back.a.area).toBe(0);
  });

  it('fails usefully', async () => {
    const { call, fails } = setup();
    await fails('compare_selections', {}, /undo steps?|steps must be/);
    await call('select_rect', rect(10, 10, 20, 20));
    await fails('compare_selections', { a: { source: 'history', steps: 3 } }, /There is 1 undo step; steps must be 1\.\.1/);
    await fails('compare_selections', { a: { source: 'channel' } }, /needs channelId/);
    await fails('compare_selections', { a: { source: 'channel', channelId: 'nope' } }, /channel/i);
    await fails('compare_selections', { a: { source: 'selection', layerId: 'x' } }, /layerId does not apply to source selection/);
    await fails('compare_selections', { a: { source: 'layer-mask', layerId: 'nope' } }, /no layer "nope"/);
    await fails('compare_selections', { a: { source: 'history', steps: 0 } }, /steps|minimum/);
  });

  it('is a pure function too, with a two-colour overlay', () => {
    expect(compareSelectionMasks(null, null, W, H)).toMatchObject({ iou: 1, identical: true });
    const { c } = setup();
    c.selectRect({ x: 0, y: 0, width: 10, height: 10 }, { antiAlias: false });
    const a = c.getSelection();
    c.selectRect({ x: 5, y: 0, width: 10, height: 10 }, { antiAlias: false });
    const d = compareSelectionMasks(a, c.getSelection(), W, H);
    const px = selectionDiffPixels(d.addedMask, d.removedMask);
    expect(Array.from(px.slice(12 * 4, 12 * 4 + 4))).toEqual([34, 197, 94, 140]);
    expect(Array.from(px.slice(2 * 4, 2 * 4 + 4))).toEqual([239, 68, 68, 140]);
    expect(Array.from(px.slice(7 * 4, 7 * 4 + 4))).toEqual([0, 0, 0, 0]);
  });
});
