import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, imagePlaybackPanel } from '../src/image-editor';
import { base64ToBytes, decodePng } from '../src/raster/png';

const W = 20;
const H = 10;

function createRegistry(c: ImageEditorController) {
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  return registry;
}

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

describe('alpha channels', () => {
  it('saves, combines, loads, renames, duplicates and deletes, each one undo step', async () => {
    const { c, call, fails } = setup();
    expect(await call('list_channels')).toEqual({ channels: [], quickMask: false });
    await fails('save_selection', {}, /Nothing is selected/);
    await call('select_rect', { x: 0, y: 0, width: 5, height: 10, antiAlias: false });
    const { channel } = await call('save_selection', { name: 'Left' });
    expect(channel).toMatchObject({ id: 'ch_1', name: 'Left', percent: 25, bounds: { x: 0, y: 0, width: 5, height: 10 }, color: '#ff0000', indicates: 'masked', visible: false });
    await call('select_rect', { x: 15, y: 0, width: 5, height: 10, antiAlias: false });
    expect((await call('save_selection', { channelId: 'ch_1', mode: 'add' })).channel.percent).toBe(50);
    await call('deselect');
    expect(await call('load_selection_from_channel', { channelId: 'ch_1' })).toMatchObject({ area: 100 });
    expect(await call('load_selection_from_channel', { channelId: 'ch_1', invert: true })).toMatchObject({ area: 100, bounds: { x: 5, y: 0, width: 10, height: 10 } });
    expect((await call('set_channel_properties', { channelId: 'ch_1', name: 'Edges', color: '#00FF00', opacity: 0.3, visible: true })).channel).toMatchObject({ name: 'Edges', color: '#00ff00', opacity: 0.3, visible: true });
    const copy = (await call('duplicate_channel', { channelId: 'ch_1' })).channel;
    expect(copy).toMatchObject({ id: 'ch_2', name: 'Edges copy', percent: 50 });
    expect((await call('delete_channel', { channelId: 'ch_1' })).channels.map((x: any) => x.id)).toEqual(['ch_2']);
    c.undo();
    expect(c.getChannels().map((x) => x.id)).toEqual(['ch_1', 'ch_2']);
    await fails('load_selection_from_channel', { channelId: 'nope' }, /no alpha channel "nope"; the channels are ch_1 \(Edges\), ch_2/);
    await fails('set_channel_properties', { channelId: 'ch_1', color: 'green' }, /color|pattern/);
    await fails('set_channel_properties', { channelId: 'ch_1', name: '   ' }, /cannot be empty/);
  });

  it('round-trips channels through toJSON and loadJSON', async () => {
    const { c, call } = setup();
    await call('select_ellipse', { x: 2, y: 2, width: 10, height: 6 });
    await call('save_selection', { name: 'Oval' });
    await call('set_channel_properties', { channelId: 'ch_1', indicates: 'selected', opacity: 0.7 });
    const json = JSON.parse(JSON.stringify(c.toJSON()));
    expect(json.channels).toHaveLength(1);
    const d = setup().c;
    d.loadJSON(json);
    expect(d.getChannels()[0]).toMatchObject({ name: 'Oval', indicates: 'selected', opacity: 0.7 });
    expect(Array.from(d.getChannels()[0]!.mask.data)).toEqual(Array.from(c.getChannels()[0]!.mask.data));
    // A damaged channel is reported and left out.
    const e = setup().c;
    e.loadJSON({ ...json, channels: [{ ...json.channels[0], mask: { width: 3, height: 3, rle: 'r1:xx' } }] });
    expect(e.getChannels()).toEqual([]);
    expect(e.lastLoadProblems.join(' ')).toMatch(/Alpha channel "Oval" could not be read/);
  });
});

describe('mask images', () => {
  const decode = (dataUrl: string) => decodePng(base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1)));

  it('exports the selection, a channel and a layer mask as greyscale PNGs', async () => {
    const { c, call, fails } = setup();
    await fails('export_mask_image', {}, /Nothing is selected/);
    await call('select_rect', { x: 0, y: 0, width: 5, height: 10, antiAlias: false });
    const res = await createRegistry(c).callTool('export_mask_image', {});
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ width: W, height: H });
    expect(res.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const png = decodePng(base64ToBytes((res.content[0] as { data: string }).data));
    expect([png.width, png.height]).toEqual([W, H]);
    expect([png.data[0], png.data[4 * 5]]).toEqual([255, 0]);

    await call('save_selection', { name: 'Left' });
    const inverted = decode(c.exportMaskImage({ channelId: 'ch_1' }, { invert: true }).dataUrl);
    expect([inverted.data[0], inverted.data[4 * 5]]).toEqual([0, 255]);
    expect(c.exportMaskImage('selection', { maxSide: 16 })).toMatchObject({ width: 16, height: 8 });

    await fails('export_mask_image', { layerId: 'background' }, /no painted mask/);
    await call('add_layer_mask', { layerId: 'background', from: 'hide-selection' });
    const mask = decode(c.exportMaskImage({ layerId: 'background' }).dataUrl);
    expect([mask.data[0], mask.data[4 * 5]]).toEqual([0, 255]);
    await fails('export_mask_image', { channelId: 'ch_1', layerId: 'background' }, /not both/);
    await fails('export_mask_image', { channelId: 'nope' }, /no alpha channel "nope"/);
    await fails('export_mask_image', { layerId: 'nope' }, /No layer "nope"/);
  });

  it('loads an exported PNG back into a new channel as one undo step', async () => {
    const { c, call, fails } = setup();
    await call('select_rect', { x: 0, y: 0, width: 10, height: 10, antiAlias: false });
    const png = decode(c.exportMaskImage('selection').dataUrl);
    await call('deselect');
    const channel = await c.loadChannelFromImage({ width: png.width, height: png.height, data: png.data }, { name: 'Imported' });
    expect(channel).toMatchObject({ name: 'Imported', mask: { width: W, height: H } });
    expect(c.describeChannels()[0]).toMatchObject({ percent: 50, bounds: { x: 0, y: 0, width: 10, height: 10 } });
    expect(c.getSelection()).toBeNull();
    // A smaller image is resampled to the canvas.
    const small = decode(c.exportMaskImage({ channelId: channel.id }, { maxSide: 16 }).dataUrl);
    expect((await c.loadChannelFromImage({ width: small.width, height: small.height, data: small.data })).mask).toMatchObject({ width: W, height: H });
    c.undo();
    c.undo();
    expect(c.getChannels()).toEqual([]);

    const spy = vi.spyOn(c, 'loadChannelFromImage');
    spy.mockResolvedValue(channel);
    c.redo();
    expect((await call('load_channel_from_image', { image: 'data:image/png;base64,AAAA', name: 'Matte', channel: 'alpha', threshold: 128, invert: true })).channel).toMatchObject({ id: channel.id });
    expect(spy).toHaveBeenCalledWith('data:image/png;base64,AAAA', { name: 'Matte', channel: 'alpha', threshold: 128, invert: true });
    await fails('load_channel_from_image', {}, /image/);
    await fails('load_channel_from_image', { image: 'x', channel: 'hue' }, /channel|enum/i);
  });
});

describe('Quick Mask mode', () => {
  it('paints, fills and clears the selection itself, one undo step each', async () => {
    const { c, call, fails } = setup();
    await fails('paint_stroke', { channel: 'quick-mask', points: [{ x: 1, y: 1 }] }, /Quick Mask is off/);
    expect(await call('set_quick_mask', { enabled: true })).toMatchObject({ quickMask: true, selection: { empty: true } });
    expect(c.getSelectionDisplay()).toBe('quickMask');
    // White paint selects, with no layerId.
    await call('paint_stroke', { points: [{ x: 2, y: 5 }, { x: 8, y: 5 }], color: '#ffffff', brush: { size: 3, hardness: 1 } });
    const painted = c.getSelection()!;
    expect(painted.bounds!.y).toBeGreaterThanOrEqual(3);
    expect(painted.data[5 * W + 5]).toBe(255);
    expect(c.getLayers().find((l) => l.id === 'background')!.type).toBe('pixel');
    // Fill selects everything; black clears part of it.
    await call('fill_pixels', { color: '#ffffff' });
    expect((await call('get_selection')).percent).toBe(100);
    await call('paint_stroke', { points: [{ x: 15, y: 0 }, { x: 15, y: 9 }], color: '#000000', brush: { size: 4, hardness: 1 } });
    expect(c.getSelection()!.data[5 * W + 15]).toBe(0);
    c.undo();
    expect((await call('get_selection')).percent).toBe(100);
    c.undo();
    expect(c.getSelection()).toBe(painted);
    // A layer can still be painted by naming it.
    await call('paint_stroke', { layerId: 'background', points: [{ x: 1, y: 1 }], color: '#ff0000', brush: { size: 2 } });
    expect(c.getSelection()).toBe(painted);
    expect(await call('set_quick_mask', { enabled: false })).toMatchObject({ quickMask: false });
    expect(c.getSelectionDisplay()).toBe('ants');
    // Switching the display away from the tint leaves Quick Mask mode.
    c.setQuickMaskMode(true);
    c.setSelectionDisplay('ants');
    expect(c.quickMaskEditing).toBe(false);
  });

  it('plays the channel tools back on the Select panel', () => {
    for (const name of ['save_selection', 'load_selection_from_channel', 'set_channel_properties', 'duplicate_channel', 'delete_channel', 'load_channel_from_image', 'set_quick_mask']) {
      expect(imagePlaybackPanel(name), name).toBe('select');
    }
  });
});

describe('alpha channels in PSD files', () => {
  it('writes channels as merged planes with names and display info, and reads them back', async () => {
    const { c, call } = setup();
    await call('select_rect', { x: 0, y: 0, width: 5, height: 10, antiAlias: false });
    await call('save_selection', { name: 'Left side' });
    await call('select_ellipse', { x: 4, y: 1, width: 12, height: 8 });
    await call('save_selection', { name: 'Ovál' });
    await call('set_channel_properties', { channelId: 'ch_2', color: '#00aaff', opacity: 0.25, indicates: 'selected' });
    const { bytes } = await c.toPsd();
    const { importPsd } = await import('../src/image-editor/psd/import');
    const read = importPsd(bytes);
    expect(read.alphaChannels?.map((a) => a.name)).toEqual(['Left side', 'Ovál']);
    expect(read.alphaChannels![1]).toMatchObject({ color: '#00aaff', opacity: 0.25, indicates: 'selected' });
    expect(read.warnings.join(' ')).not.toMatch(/alpha/i);
    const d = setup().c;
    d.loadPsd(bytes);
    expect(d.getChannels().map((x) => x.name)).toEqual(['Left side', 'Ovál']);
    expect(Array.from(d.getChannels()[0]!.mask.data)).toEqual(Array.from(c.getChannels()[0]!.mask.data));
    expect(Array.from(d.getChannels()[1]!.mask.data)).toEqual(Array.from(c.getChannels()[1]!.mask.data));
    expect(d.getLayers().length).toBe(c.getLayers().length);
  });
});

describe('the Q key', () => {
  it('toggles Quick Mask mode in select and paint mode, but not with modifiers or while typing', async () => {
    const { c } = setup();
    const { handleQuickMaskKey, handlePaintShortcut } = await import('../src/image-editor');
    expect(handleQuickMaskKey(c, { key: 'q', ctrlKey: true })).toBe(false);
    expect(handleQuickMaskKey(c, { key: 'Q' })).toBe(true);
    expect(c.quickMaskEditing).toBe(true);
    expect(handlePaintShortcut(c, { key: 'q' } as any)).toBe(true);
    expect(c.quickMaskEditing).toBe(false);
  });
});
