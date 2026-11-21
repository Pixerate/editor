import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  ImageEditorController,
  createImageEditorToolProvider,
  decodePng,
  parseDataUrl,
  pngDataUrl,
  type GenerativeFillProvider,
  type GenerativeFillRequest,
} from '../src/image-editor';

const fakeImage = (w: number, h: number) =>
  ({ width: w, height: h, naturalWidth: w, naturalHeight: h, src: '' }) as unknown as HTMLImageElement;

/** A solid opaque RGBA image as a PNG data URL. */
const solid = (w: number, h: number, rgb: [number, number, number]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
  return pngDataUrl(w, h, data, 4);
};

/** A controller whose AI input export is stubbed (no canvas in Node). */
function controllerWith(provider: GenerativeFillProvider | null, w = 20, h = 10) {
  const controller = new ImageEditorController({ image: fakeImage(w, h), generativeFill: provider });
  vi.spyOn(controller, 'toAIInputDataURL').mockResolvedValue('data:image/png;base64,AAAA');
  return controller;
}

const layerPixels = (c: ImageEditorController, id: string) => c.compositePixels(undefined, { layerIds: [id] });

describe('ImageEditorController.generativeFill', () => {
  it('sends the composite, the selection as a mask and the prompt, and adds the result clipped to the selection', async () => {
    const requests: GenerativeFillRequest[] = [];
    const provider: GenerativeFillProvider = {
      name: 'Test model',
      fill: async (req) => {
        requests.push(req);
        return solid(40, 20, [255, 0, 0]); // another size: resampled to the image
      },
    };
    const c = controllerWith(provider);
    c.selectRect({ x: 2, y: 2, width: 4, height: 4 }, { antiAlias: false });
    const layersBefore = c.getLayers().length;

    const res = await c.generativeFill('  a red kite ');
    expect(res).toMatchObject({ bounds: { x: 2, y: 2, width: 4, height: 4 }, provider: 'Test model' });
    expect(requests[0]).toMatchObject({ prompt: 'a red kite', image: 'data:image/png;base64,AAAA', width: 20, height: 10, bounds: { x: 2, y: 2, width: 4, height: 4 } });
    const mask = decodePng(parseDataUrl(requests[0].mask)!.bytes);
    expect([mask.width, mask.height]).toEqual([20, 10]);

    expect(c.getLayers().length).toBe(layersBefore + 1);
    const layer = c.getLayers().find((l) => l.id === res.layerId)!;
    expect(layer.name).toBe('a red kite');
    const px = layerPixels(c, res.layerId);
    const alphaAt = (x: number, y: number) => px.data[(y * 20 + x) * 4 + 3];
    expect(alphaAt(3, 3)).toBe(255);
    expect(px.data[(3 * 20 + 3) * 4]).toBe(255);
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(10, 5)).toBe(0);

    c.undo();
    expect(c.getLayers().length).toBe(layersBefore);
  });

  it('keeps to the selection the call began with', async () => {
    let release!: (url: string) => void;
    const c = controllerWith({ fill: () => new Promise<string>((r) => (release = r)) });
    c.selectRect({ x: 0, y: 0, width: 2, height: 2 }, { antiAlias: false });
    const pending = c.generativeFill('grass');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    c.selectRect({ x: 10, y: 5, width: 4, height: 4 }, { antiAlias: false });
    release(solid(20, 10, [0, 255, 0]));
    const { layerId, bounds } = await pending;
    expect(bounds).toEqual({ x: 0, y: 0, width: 2, height: 2 });
    const px = layerPixels(c, layerId);
    expect(px.data[3]).toBe(255);
    expect(px.data[(6 * 20 + 11) * 4 + 3]).toBe(0);
  });

  it('refuses without a provider, a selection or a prompt, changing nothing', async () => {
    const none = controllerWith(null);
    none.selectRect({ x: 0, y: 0, width: 2, height: 2 });
    await expect(none.generativeFill('sky')).rejects.toThrow(/needs a generative fill model.*Content-Aware Fill/);

    const fill = vi.fn(async () => solid(20, 10, [0, 0, 0]));
    const c = controllerWith({ fill });
    await expect(c.generativeFill('sky')).rejects.toThrow(/Nothing is selected/);
    c.selectRect({ x: 0, y: 0, width: 2, height: 2 });
    await expect(c.generativeFill('   ')).rejects.toThrow(/prompt is empty/);
    expect(fill).not.toHaveBeenCalled();
  });

  it('adds nothing when cancelled or when the model returns no image', async () => {
    const abort = new AbortController();
    const c = controllerWith({
      fill: async () => {
        abort.abort();
        return solid(20, 10, [0, 0, 0]);
      },
    });
    c.selectRect({ x: 0, y: 0, width: 2, height: 2 });
    const before = c.getLayers().length;
    await expect(c.generativeFill('sky', { signal: abort.signal })).rejects.toThrow();
    expect(c.getLayers().length).toBe(before);

    const empty = controllerWith({ name: 'Blank', fill: async () => '' });
    empty.selectRect({ x: 0, y: 0, width: 2, height: 2 });
    await expect(empty.generativeFill('sky')).rejects.toThrow(/Blank returned no image/);
  });

  it('notifies when the provider is set or removed', () => {
    const c = controllerWith(null);
    const seen = vi.fn();
    c.subscribe(seen);
    seen.mockClear(); // subscribe may call back at once
    const provider = { fill: async () => '' };
    c.setGenerativeFillProvider(provider);
    expect(c.generativeFillProvider).toBe(provider);
    c.setGenerativeFillProvider(provider);
    c.setGenerativeFillProvider(null);
    expect(c.generativeFillProvider).toBeNull();
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe('generative_fill tool', () => {
  const setup = (provider: GenerativeFillProvider | null) => {
    const controller = controllerWith(provider);
    const registry = new ToolRegistry();
    registry.register(createImageEditorToolProvider(controller));
    const name = registry.listTools().tools.find((t) => t.name.endsWith('generative_fill'))!.name;
    return { controller, registry, name };
  };

  it('fills the selection through the registry and returns the new layer', async () => {
    const { controller, registry, name } = setup({ name: 'Test model', fill: async () => solid(20, 10, [0, 0, 255]) });
    controller.selectRect({ x: 4, y: 2, width: 6, height: 4 }, { antiAlias: false });
    const res = await registry.callTool(name, { prompt: 'a blue door' });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as { layerId: string; bounds: unknown; provider: string };
    expect(out).toMatchObject({ bounds: { x: 4, y: 2, width: 6, height: 4 }, provider: 'Test model' });
    expect(controller.getLayers().some((l) => l.id === out.layerId)).toBe(true);
  });

  it('rejects bad arguments and explains a missing model', async () => {
    const { controller, registry, name } = setup(null);
    controller.selectRect({ x: 0, y: 0, width: 2, height: 2 });
    expect((await registry.callTool(name, {})).isError).toBe(true);
    expect((await registry.callTool(name, { prompt: 'x', extra: 1 })).isError).toBe(true);
    const res = await registry.callTool(name, { prompt: 'a cat' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/content_aware_fill|Content-Aware Fill/);
  });
});
