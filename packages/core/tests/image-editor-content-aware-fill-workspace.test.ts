import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ContentAwareFillSession, ImageEditorController, createImageEditorToolProvider } from '../src/image-editor';

const W = 120;
const H = 80;

/** Red and blue stripes on the left (x < 70), plain green on the right. */
function scene() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = x >= 70 ? [40, 200, 60] : Math.floor(x / 4) % 2 ? [210, 40, 40] : [40, 40, 210];
      data.set([...c, 255], (y * W + x) * 4);
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

/** Pixels in the box (x 50..66, y 30..46) that came out green. */
function greenIn(c: ImageEditorController, layerIds?: string[]) {
  const px = c.compositePixels({ x: 50, y: 30, width: 16, height: 16 }, layerIds ? { layerIds } : {}).data;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i + 1] > 150 && px[i] < 100) n++;
  return n;
}

describe('content_aware_fill sampling area', () => {
  it('never copies from excluded rectangles, and samples only the given ones', async () => {
    const { c, call, fails } = setup();
    await call('select_rect', { x: 50, y: 30, width: 16, height: 16 });
    const out = await call('content_aware_fill', { output: 'new-layer', excludeRects: [{ x: 70, y: 0, width: 50, height: 80 }] });
    expect(greenIn(c, [out.layerId])).toBe(0);
    c.undo();
    const only = await call('content_aware_fill', { output: 'new-layer', sampleRects: [{ x: 0, y: 0, width: 45, height: 80 }] });
    expect(greenIn(c, [only.layerId])).toBe(0);
    c.undo();
    // Only green to sample from: the fill is green.
    const green = await call('content_aware_fill', { output: 'new-layer', sampleRects: [{ x: 75, y: 0, width: 45, height: 80 }] });
    expect(greenIn(c, [green.layerId])).toBeGreaterThan(200);
    await fails('content_aware_fill', { sampleRects: [] }, /sampleRects|minItems/);
    await fails('content_aware_fill', { samplingChannelId: 'nope' }, /no alpha channel "nope"/);
  });

  it('samples where a saved channel is selected', async () => {
    const { c, call } = setup();
    await call('select_rect', { x: 0, y: 0, width: 45, height: 80 });
    const channel = c.saveSelection({ name: 'stripes' });
    await call('select_rect', { x: 50, y: 30, width: 16, height: 16 });
    const out = await call('content_aware_fill', { output: 'new-layer', samplingChannelId: channel.id });
    expect(greenIn(c, [out.layerId])).toBe(0);
  });
});

describe('Content-Aware Fill workspace session', () => {
  it('previews, paints the sampling area, and fills with OK as one undo step', async () => {
    const { c } = setup();
    c.selectRect({ x: 50, y: 30, width: 16, height: 16 });
    const s = new ContentAwareFillSession(c);
    expect(await s.open()).toBe(true);
    expect(s.window).toBeDefined();
    // Auto samples next to the selection, not inside it or far from it.
    expect(s.samplesAt(45, 38)).toBe(true);
    expect(s.samplesAt(55, 38)).toBe(false);
    expect(s.renderSource().length).toBe(s.window!.width * s.window!.height * 4);
    await s.idle();
    // Paint the green out of the sampling area.
    s.update({ brushMode: 'subtract', brushSize: 60 });
    s.begin({ x: 100, y: 0 });
    s.move({ x: 100, y: 80 });
    s.end();
    expect(s.settings.sampling).toBe('custom');
    expect(s.samplesAt(80, 40)).toBe(false);
    expect(s.samplesAt(40, 40)).toBe(true);
    await s.idle();
    expect(s.renderPreview().length).toBe(s.renderSource().length);
    const layers = c.getLayers().length;
    const out = await s.commit();
    expect(out.output).toBe('new-layer');
    expect(c.getLayers()).toHaveLength(layers + 1);
    expect(greenIn(c, [out.layerId])).toBe(0);
    c.undo();
    expect(c.getLayers()).toHaveLength(layers);
  });

  it('switches presets, answers keys, and reports an empty area or no selection', async () => {
    const { c } = setup();
    const none = new ContentAwareFillSession(c);
    expect(await none.open()).toBe(false);
    expect(none.error).toMatch(/Nothing is selected/);
    c.selectRect({ x: 50, y: 30, width: 16, height: 16 });
    const s = new ContentAwareFillSession(c);
    await s.open();
    s.update({ sampling: 'rectangular', livePreview: false });
    const win = s.window!;
    expect(s.samplesAt(win.x + 1, win.y + 1)).toBe(true);
    expect(s.handleKey('h')).toBe(true);
    expect(s.settings.tool).toBe('hand');
    expect(s.begin({ x: 10, y: 10 })).toBe(false);
    s.handleKey('b');
    s.update({ brushMode: 'subtract', brushSize: 1000 });
    s.begin({ x: 60, y: 40 });
    s.end();
    await expect(s.commit()).rejects.toThrow(/sampling area is empty/);
  });
});
