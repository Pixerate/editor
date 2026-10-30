import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, decontaminateColors } from '../src/image-editor';

const W = 60;
const H = 40;

/** A red square (x 20..40, y 10..30) on green, with a 4 px band mixing the two (a soft edge). */
function scene() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.max(Math.max(20 - x, x - 39), Math.max(10 - y, y - 29));
      const a = Math.min(1, Math.max(0, 0.5 - d / 4));
      const p = (y * W + x) * 4;
      data[p] = Math.round(220 * a + 30 * (1 - a));
      data[p + 1] = Math.round(30 * a + 200 * (1 - a));
      data[p + 2] = 40;
      data[p + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels(scene());
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

describe('decontaminate colors', () => {
  it('moves an edge pixel towards the subject colour, more with a larger amount', () => {
    // 1 × 9: subject red, a half-covered pixel mixing red and green, background green.
    const rgba = [220, 30, 40, 255, 220, 30, 40, 255, 220, 30, 40, 255, 220, 30, 40, 255, 160, 100, 40, 255, 30, 200, 40, 255, 30, 200, 40, 255, 30, 200, 40, 255, 30, 200, 40, 255];
    const cov = [255, 255, 255, 255, 180, 0, 0, 0, 0];
    const half = decontaminateColors(rgba, cov, 9, 1, 0.5, 2);
    const full = decontaminateColors(rgba, cov, 9, 1, 1, 2);
    expect(full[4 * 4 + 1]).toBeLessThan(half[4 * 4 + 1]);
    expect(half[4 * 4 + 1]).toBeLessThan(100);
    expect(full[4 * 4]).toBeGreaterThan(160);
    // Fully in and out pixels, and alpha, are kept.
    expect(Array.from(full.slice(0, 4))).toEqual([220, 30, 40, 255]);
    expect(Array.from(full.slice(32, 36))).toEqual([30, 200, 40, 255]);
  });
});

describe('refine_selection outputs', () => {
  it('refines into the selection by default', async () => {
    const { call } = setup();
    await call('select_rect', { x: 18, y: 8, width: 24, height: 24 });
    const out = await call('refine_selection', { radius: 4 });
    expect(out).toMatchObject({ output: 'selection', empty: false });
  });

  it('outputs a layer mask and deselects, as one undo step', async () => {
    const { c, call } = setup();
    await call('select_rect', { x: 20, y: 10, width: 20, height: 20 });
    const out = await call('refine_selection', { radius: 0, output: 'layer-mask' });
    expect(out).toMatchObject({ output: 'layer-mask', layerId: 'background', empty: true });
    expect(c.getLayer('background')!.mask).toBeDefined();
    c.undo();
    expect(c.getLayer('background')!.mask).toBeUndefined();
    expect(c.getSelection()!.bounds).toEqual({ x: 20, y: 10, width: 20, height: 20 });
  });

  it('outputs a new layer, decontaminated, and hides the source', async () => {
    const { c, call } = setup();
    await call('select_rect', { x: 20, y: 10, width: 20, height: 20 });
    // A soft edge, so there is something to decontaminate.
    const out = await call('refine_selection', { radius: 0, feather: 2, output: 'new-layer', decontaminate: 100 });
    expect(out.output).toBe('new-layer');
    expect(c.getLayer(out.newLayerId)).toBeDefined();
    expect(c.getLayer('background')!.visible).toBe(false);
    // The copy's edge is redder (less green) than the original there.
    const before = scene().data.slice((20 * W + 20) * 4, (20 * W + 20) * 4 + 4);
    const after = c.compositePixels({ x: 20, y: 20, width: 1, height: 1 }, { layerIds: [out.newLayerId] }).data;
    expect(after[1]).toBeLessThan(before[1]);
    c.undo();
    expect(c.getLayer(out.newLayerId)).toBeUndefined();
    expect(c.getLayer('background')!.visible).toBe(true);
  });

  it('outputs a masked copy', async () => {
    const { c, call } = setup();
    await call('select_rect', { x: 20, y: 10, width: 20, height: 20 });
    const out = await call('refine_selection', { radius: 0, output: 'new-layer-with-mask' });
    const layer = c.getLayer(out.newLayerId)!;
    expect(layer.mask).toBeDefined();
    expect(c.getLayers()).toHaveLength(2);
  });

  it('refuses decontamination without a new layer, and missing selections', async () => {
    const { call, fails } = setup();
    await fails('refine_selection', {}, /Nothing is selected/);
    await call('select_rect', { x: 20, y: 10, width: 20, height: 20 });
    await fails('refine_selection', { output: 'layer-mask', decontaminate: 50 }, /new-layer or new-layer-with-mask/);
    await fails('refine_selection', { output: 'new-layer', layerId: 'nope' }, /nope/);
    await fails('refine_selection', { output: 'new-document' }, /output|enum/);
  });
});
