import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  ImageEditorController,
  createImageEditorToolProvider,
  handleMaskViewKey,
  handlePaintShortcut,
  layerMaskSelection,
  maskThumbnailClick,
} from '../src/image-editor';

const W = 20;
const H = 10;

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

/** Masks the Background with its left quarter. */
async function masked(c: ImageEditorController, call: (name: string, args?: Record<string, unknown>) => Promise<Record<string, any>>) {
  await call('select_rect', { x: 0, y: 0, width: 5, height: 10, antiAlias: false });
  await call('add_layer_mask', { layerId: 'background', from: 'selection' });
  await call('deselect');
  c.setActiveLayer('background', 'pixels');
}

describe('mask views', () => {
  it('shows a layer mask in grey or as an overlay without an undo step', async () => {
    const { c, call, fails } = setup();
    await fails('set_mask_view', { view: 'gray', layerId: 'background' }, /has no mask to show; add one with add_layer_mask/);
    await masked(c, call);
    const undoable = c.canUndo;
    expect(await call('set_mask_view', { view: 'gray' })).toEqual({ view: 'gray', layerId: 'background' });
    expect(c.getMaskView()).toEqual({ layerId: 'background', mode: 'gray' });
    expect(await call('set_mask_view', { view: 'overlay', layerId: 'background' })).toEqual({ view: 'overlay', layerId: 'background' });
    expect(JSON.stringify(c.toJSON())).not.toContain('maskView');
    expect(c.canUndo).toBe(undoable);
    expect(await call('set_mask_view', { view: 'off' })).toEqual({ view: 'off', layerId: null });
    expect(c.getMaskView()).toBeNull();
    await fails('set_mask_view', { view: 'pink' }, /view|enum/i);
    await fails('set_mask_view', { view: 'gray', layerId: 'nope' }, /nope/);
  });

  it('ends when the mask goes away', async () => {
    const { c, call } = setup();
    await masked(c, call);
    c.setMaskView('gray', 'background');
    await call('remove_layer_mask', { layerId: 'background' });
    expect(c.getMaskView()).toBeNull();
  });

  it('reads the mask over the canvas, white where it reveals', async () => {
    const { c, call } = setup();
    await masked(c, call);
    const mask = layerMaskSelection(c.getLayer('background')!, W, H)!;
    expect(mask.bounds).toEqual({ x: 0, y: 0, width: 5, height: 10 });
    expect([mask.data[0], mask.data[5]]).toEqual([255, 0]);
  });

  it('toggles with Alt-click on the mask thumbnail and with the backslash key', async () => {
    const { c, call } = setup();
    expect(handleMaskViewKey(c, { key: '\\' })).toBe(false);
    await masked(c, call);
    const layer = () => c.getLayer('background')!;
    maskThumbnailClick(c, layer(), { altKey: true });
    expect(c.getMaskView()).toEqual({ layerId: 'background', mode: 'gray' });
    maskThumbnailClick(c, layer(), { altKey: true, shiftKey: true });
    expect(c.getMaskView()?.mode).toBe('overlay');
    maskThumbnailClick(c, layer(), { altKey: true, shiftKey: true });
    expect(c.getMaskView()).toBeNull();
    // Alt-click no longer makes the mask the paint target.
    expect(c.getState().activeTarget).toBe('pixels');
    expect(handleMaskViewKey(c, { key: '\\' })).toBe(true);
    expect(c.getMaskView()?.mode).toBe('overlay');
    expect(handlePaintShortcut(c, { key: '\\' } as KeyboardEvent)).toBe(true);
    expect(c.getMaskView()).toBeNull();
    expect(handleMaskViewKey(c, { key: '\\', ctrlKey: true })).toBe(false);
  });
});
