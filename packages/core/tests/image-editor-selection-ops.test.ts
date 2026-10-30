import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, rectSelection, selectionRing } from '../src/image-editor';

const W = 40;
const H = 30;

/** A grey canvas with a red 6×6 square at (10, 10). */
function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) data.set(x >= 10 && x < 16 && y >= 10 && y < 16 ? [220, 20, 20, 255] : [120, 120, 120, 255], (y * W + x) * 4);
  }
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
  const at = (x: number, y: number) => Array.from(c.compositePixels({ x, y, width: 1, height: 1 }).data);
  return { c, call, fails, at };
}

const sum = (data: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += data[i] / 255;
  return s;
};

describe('stroke_selection', () => {
  it('builds inside, outside and centre bands that match a distance oracle', () => {
    const sel = rectSelection(W, H, { x: 10, y: 10, width: 10, height: 10 }, { antiAlias: false });
    // Inside: the 10×10 square minus the 6×6 square 2 px in.
    expect(Math.round(sum(selectionRing(sel, 2, 'inside').data))).toBe(100 - 36);
    // Outside: pixels within 2 px (Euclidean) of the square, outside it.
    let oracle = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = Math.max(10 - (x + 0.5), 0, x + 0.5 - 20);
        const dy = Math.max(10 - (y + 0.5), 0, y + 0.5 - 20);
        const d = Math.hypot(dx, dy);
        if (d > 0 && d <= 2) oracle++;
      }
    }
    const outside = sum(selectionRing(sel, 2, 'outside').data);
    expect(Math.abs(outside - oracle) / oracle).toBeLessThan(0.08);
    const center = selectionRing(sel, 2, 'center');
    expect(center.data[15 * W + 10]).toBeGreaterThan(0);
    expect(center.data[15 * W + 9]).toBeGreaterThan(0);
    expect(center.data[15 * W + 15]).toBe(0);
  });

  it('paints the band in one undo step and checks its arguments', async () => {
    const { c, call, fails, at } = setup();
    await fails('stroke_selection', { width: 2 }, /Nothing is selected/);
    await call('select_rect', { x: 10, y: 10, width: 6, height: 6, antiAlias: false });
    const res = await call('stroke_selection', { width: 2, location: 'outside', color: '#00ff00', layerId: 'background' });
    expect(res.bounds).toMatchObject({ x: 8, y: 8, width: 10, height: 10 });
    expect(at(9, 12)).toEqual([0, 255, 0, 255]);
    expect(at(12, 12)).toEqual([220, 20, 20, 255]);
    c.undo();
    expect(at(9, 12)).toEqual([120, 120, 120, 255]);
    await fails('stroke_selection', { width: 0 }, /width|exclusiveMinimum/);
    await fails('stroke_selection', { width: 2, location: 'around' }, /location|enum/i);
    await fails('stroke_selection', { width: 2, layerId: 'nope' }, /No layer "nope"/);
  });
});

describe('crop_to_selection', () => {
  it('crops to the selection bounds', async () => {
    const { c, call, fails } = setup();
    await fails('crop_to_selection', {}, /Nothing is selected/);
    await call('select_ellipse', { x: 5, y: 4, width: 20, height: 10 });
    const { crop } = await call('crop_to_selection');
    expect(crop).toEqual(c.getSelection()!.bounds);
    expect(c.getState().crop).toEqual(crop);
    c.undo();
    expect(c.getState().crop).toBeFalsy();
  });
});

describe('content_aware_fill', () => {
  it('removes the selected object, deterministically for a seed', async () => {
    const { c, call, fails, at } = setup();
    await fails('content_aware_fill', {}, /Nothing is selected/);
    await call('select_rect', { x: 8, y: 8, width: 10, height: 10, antiAlias: false });
    const res = await call('content_aware_fill', { layerId: 'background', seed: 3 });
    expect(res).toMatchObject({ layerId: 'background', output: 'current', bounds: { x: 8, y: 8, width: 10, height: 10 } });
    const filled = at(12, 12);
    expect(filled.slice(0, 3).every((v) => Math.abs(v - 120) <= 6)).toBe(true);
    const snapshot = Array.from(c.compositePixels({ x: 8, y: 8, width: 10, height: 10 }).data);
    c.undo();
    expect(at(12, 12)).toEqual([220, 20, 20, 255]);
    await call('content_aware_fill', { layerId: 'background', seed: 3 });
    expect(Array.from(c.compositePixels({ x: 8, y: 8, width: 10, height: 10 }).data)).toEqual(snapshot);
  });

  it('can put the fill on a new layer', async () => {
    const { c, call } = setup();
    await call('select_rect', { x: 8, y: 8, width: 10, height: 10, antiAlias: false });
    const res = await call('content_aware_fill', { layerId: 'background', output: 'new-layer' });
    expect(res.layerId).not.toBe('background');
    expect(c.getLayerBounds(res.layerId)).toEqual({ x: 8, y: 8, width: 10, height: 10 });
    c.undo();
    expect(c.getLayer(res.layerId)).toBeFalsy();
  });
});

describe('copy, cut and paste pixels', () => {
  it('copies the selection with its soft edge and pastes it in place, into and outside', async () => {
    const { c, call, fails } = setup();
    await fails('paste_pixels', {}, /clipboard is empty/);
    await call('select_rect', { x: 10, y: 10, width: 6, height: 6, antiAlias: false });
    expect(await call('copy_pixels', { layerId: 'background' })).toEqual({ width: 6, height: 6, x: 10, y: 10 });
    const inPlace = await call('paste_pixels', { mode: 'in-place' });
    expect(inPlace).toMatchObject({ bounds: { x: 10, y: 10, width: 6, height: 6 }, masked: false });
    expect(c.getLayerBounds(inPlace.layerId)).toEqual({ x: 10, y: 10, width: 6, height: 6 });
    await call('select_rect', { x: 20, y: 5, width: 10, height: 10, antiAlias: false });
    const into = await call('paste_pixels', { mode: 'into' });
    expect(into).toMatchObject({ bounds: { x: 22, y: 7, width: 6, height: 6 }, masked: true });
    expect(c.getLayer(into.layerId)!.mask).toBeDefined();
    // One undo step removes the layer and its mask together.
    c.undo();
    expect(c.getLayer(into.layerId)).toBeFalsy();
    await call('deselect');
    await fails('paste_pixels', { mode: 'outside' }, /needs a selection/);
    expect((await call('copy_pixels', { merged: true })).width).toBe(W);
  });

  it('cut clears the source in the same undo step', async () => {
    const { c, call, fails, at } = setup();
    await fails('cut_pixels', {}, /Nothing is selected/);
    await call('select_rect', { x: 10, y: 10, width: 6, height: 6, antiAlias: false });
    await call('cut_pixels', { layerId: 'background' });
    expect(at(12, 12)[3]).toBe(0);
    c.undo();
    expect(at(12, 12)).toEqual([220, 20, 20, 255]);
    expect(c.getSelection()!.bounds).toEqual({ x: 10, y: 10, width: 6, height: 6 });
    const pasted = await call('paste_pixels');
    expect(pasted.bounds).toEqual({ x: 10, y: 10, width: 6, height: 6 });
  });
});

describe('selection-aware layers and filters', () => {
  it('add_adjustment_layer masks with the selection unless useSelection is false', async () => {
    const { call } = setup();
    expect((await call('add_adjustment_layer', { kind: 'invert' })).masked).toBe(false);
    await call('select_rect', { x: 0, y: 0, width: 10, height: 10 });
    expect((await call('add_adjustment_layer', { kind: 'invert' })).masked).toBe(true);
    expect((await call('add_adjustment_layer', { kind: 'invert', useSelection: false })).masked).toBe(false);
  });

  it('add_smart_filter sets the filter mask from the selection in the same step', async () => {
    const { c, call } = setup();
    const smart = await call('convert_to_smart_object', { layerIds: ['background'] });
    const id = smart.layer?.id ?? smart.layerId;
    await call('select_rect', { x: 0, y: 0, width: 10, height: 10 });
    const count = (c.getLayer(id) as any).smartFilters?.filters?.length ?? 0;
    const res = await call('add_smart_filter', { layerId: id, kind: 'blur', radius: 2 });
    expect(res.masked).toBe(true);
    expect((c.getLayer(id) as any).smartFilters.mask).toBeDefined();
    c.undo();
    expect((c.getLayer(id) as any).smartFilters?.filters?.length ?? 0).toBe(count);
    expect((c.getLayer(id) as any).smartFilters?.mask).toBeFalsy();
  });
});

describe('selection edit shortcuts', () => {
  it('maps Ctrl/⌘ keys to copy, cut, paste, deselect, reselect and inverse', async () => {
    const { c } = setup();
    const { handleSelectionShortcut } = await import('../src/image-editor');
    const errors: string[] = [];
    const key = (k: string, mods: Record<string, boolean> = {}) => handleSelectionShortcut(c, { key: k, ctrlKey: true, ...mods }, (m) => errors.push(m));
    expect(handleSelectionShortcut(c, { key: 'c' })).toBe(false);
    c.selectRect({ x: 10, y: 10, width: 6, height: 6 }, { antiAlias: false });
    c.setActiveLayer('background');
    expect(key('c')).toBe(true);
    expect(c.getClipboard()!.width).toBe(6);
    const n = c.getLayers().length;
    key('v', { shiftKey: true });
    expect(c.getLayers().length).toBe(n + 1);
    key('d');
    expect(c.getSelection()).toBeNull();
    key('D', { shiftKey: true });
    expect(c.getSelection()).not.toBeNull();
    key('i', { shiftKey: true });
    expect(c.getSelection()!.bounds!.width).toBe(40);
    key('d');
    key('v', { shiftKey: true, altKey: true });
    expect(errors.at(-1)).toMatch(/needs a selection/);
    expect(key('q')).toBe(false);
  });
});

describe('gradient paint and the selection', () => {
  it('a gradient brush stroke stays inside the selection', async () => {
    const { call, at } = setup();
    await call('select_rect', { x: 0, y: 0, width: 20, height: 30, antiAlias: false });
    await call('paint_stroke', {
      layerId: 'background',
      points: [{ x: 2, y: 25 }, { x: 38, y: 25 }],
      brush: { size: 6, hardness: 1 },
      paint: { type: 'gradient', stops: [{ offset: 0, color: '#0000ff' }, { offset: 1, color: '#00ff00' }], map: { by: 'distance', length: 40 } },
    });
    expect(at(10, 25)).not.toEqual([120, 120, 120, 255]);
    expect(at(30, 25)).toEqual([120, 120, 120, 255]);
  });
});
