import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  COLOR_RANGE_PRESETS,
  ImageEditorController,
  colorRangePreset,
  createImageEditorToolProvider,
  imagePlaybackPanel,
  skinToneRange,
  type PixelBuffer,
} from '../src/image-editor';

type RGBA = [number, number, number, number];

function img(w: number, h: number, f: (x: number, y: number) => RGBA): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

// 20×10: a red square (x 2..5), a blue square (x 12..15), white elsewhere.
const scene = (x: number): RGBA => (x >= 2 && x < 6 ? [255, 0, 0, 255] : x >= 12 && x < 16 ? [0, 0, 255, 255] : [255, 255, 255, 255]);

function setup(f: (x: number, y: number) => RGBA = scene, w = 20, h = 10) {
  const image = { width: w, height: h, naturalWidth: w, naturalHeight: h, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image });
  c.setSamplePixels(img(w, h, f));
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

describe('single-purpose selection tools', () => {
  it('select_all, deselect and invert_selection are one undo step each', async () => {
    const { c, call } = setup();
    expect(await call('select_all')).toMatchObject({ empty: false, percent: 100 });
    expect(await call('invert_selection')).toMatchObject({ empty: true });
    expect(await call('invert_selection')).toMatchObject({ percent: 100 });
    expect(await call('deselect')).toMatchObject({ empty: true, area: 0 });
    c.undo();
    expect(c.getSelection()?.bounds).toEqual({ x: 0, y: 0, width: 20, height: 10 });
  });

  it('select_rect and select_ellipse take a box, mode and feather', async () => {
    const { call, fails } = setup();
    expect(await call('select_rect', { x: 0, y: 0, width: 10, height: 5, antiAlias: false })).toMatchObject({ area: 50 });
    expect(await call('select_rect', { x: 5, y: 0, width: 10, height: 5, mode: 'intersect', antiAlias: false })).toMatchObject({ area: 25 });
    const ellipse = await call('select_ellipse', { x: 0, y: 0, width: 10, height: 10 });
    expect(ellipse.area).toBeGreaterThan(70);
    expect(ellipse.area).toBeLessThan(85);
    const feathered = await call('select_rect', { x: 5, y: 2, width: 10, height: 6, feather: 2 });
    expect(feathered.bounds.width).toBeGreaterThan(10);
    await fails('select_rect', { x: 0, y: 0, width: 0, height: 5 }, /width|greater than 0|exclusiveMinimum|minimum/i);
    await fails('select_rect', { x: 0, y: 0, width: 4 }, /height/);
    await fails('select_rect', { x: 0, y: 0, width: 4, height: 4, shape: 'rect' }, /shape|additional/i);
  });

  it('select_polygon is the lasso', async () => {
    const { call, fails } = setup();
    const lasso = await call('select_polygon', { points: [{ x: 2, y: 0 }, { x: 6, y: 0 }, { x: 2, y: 10 }] });
    expect(lasso.bounds).toMatchObject({ x: 2, y: 0 });
    expect(lasso.area).toBeGreaterThan(15);
    expect(lasso.area).toBeLessThan(25);
    await fails('select_polygon', { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, /3|minItems|at least/i);
  });

  it('magic_wand takes distance, sample and feather and checks the seed', async () => {
    const { c, call, fails } = setup();
    const wand = await call('magic_wand', { x: 3, y: 3, tolerance: 10, antiAlias: false });
    expect(wand.bounds).toEqual({ x: 2, y: 0, width: 4, height: 10 });
    const global = await call('magic_wand', { x: 3, y: 3, tolerance: 10, contiguous: false, distance: 'perceptual', antiAlias: false });
    expect(global.area).toBe(40);
    const spy = vi.spyOn(c, 'magicWand');
    await call('magic_wand', { x: 13, y: 3, feather: 2, mode: 'add' });
    expect(spy.mock.calls[0]![1]).toMatchObject({ feather: 2, mode: 'add', distance: 'rgb', tolerance: 32, contiguous: true, sample: 'composite' });
    await fails('magic_wand', { x: 30, y: 3 }, /outside the image/);
    await fails('magic_wand', { x: 3 }, /y/);
    await fails('magic_wand', { x: 3, y: 3, distance: 'lab' }, /distance|enum/i);
    await fails('magic_wand', { x: 3, y: 3, sample: 'everything' }, /sample|enum/i);
  });

  it('select_color_range takes samples or a preset, localized and invert', async () => {
    const { call, fails } = setup();
    expect(await call('select_color_range', { samples: [{ color: '#ff0000' }], fuzziness: 0 })).toMatchObject({ area: 40 });
    expect(await call('select_color_range', { samples: [{ color: '#ff0000' }, { color: '#0000ff' }], fuzziness: 0 })).toMatchObject({ area: 80 });
    // Localized: only the part of the red square within 2 px of where it was picked.
    const local = await call('select_color_range', { samples: [{ color: '#ff0000', x: 3, y: 0 }], fuzziness: 0, localized: 2 });
    expect(local.area).toBeGreaterThan(0);
    expect(local.area).toBeLessThan(10);
    expect(await call('select_color_range', { samples: [{ color: '#ff0000' }], fuzziness: 0, invert: true })).toMatchObject({ area: 160 });
    expect((await call('select_color_range', { preset: 'blues' })).bounds).toEqual({ x: 12, y: 0, width: 4, height: 10 });
    expect((await call('select_color_range', { preset: 'highlights' })).area).toBe(120);
    await fails('select_color_range', {}, /samples .* or preset/);
    await fails('select_color_range', { samples: [{ color: '#ff0000' }], preset: 'reds' }, /not both/);
    await fails('select_color_range', { preset: 'purples' }, /preset|enum/i);
    await fails('select_color_range', { samples: [{ color: 'red' }] }, /color|pattern/i);
  });

  it('load_selection_from_mask loads (and inverts) a layer mask', async () => {
    const { c, call, fails } = setup();
    await call('select_rect', { x: 0, y: 0, width: 10, height: 10, antiAlias: false });
    await call('add_layer_mask', { layerId: 'background', from: 'selection' });
    await call('deselect');
    expect(await call('load_selection_from_mask', { layerId: 'background' })).toMatchObject({ area: 100, bounds: { x: 0, y: 0, width: 10, height: 10 } });
    expect(await call('load_selection_from_mask', { layerId: 'background', invert: true })).toMatchObject({ area: 100, bounds: { x: 10, y: 0, width: 10, height: 10 } });
    c.undo();
    expect(c.getSelection()!.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    await fails('load_selection_from_mask', { layerId: 'nope' }, /No layer "nope"/);
    await call('remove_layer_mask', { layerId: 'background' });
    await fails('load_selection_from_mask', { layerId: 'background' }, /has no mask/);
  });

  it('load_selection_from_image passes channel, threshold, invert and mode', async () => {
    const { c, call, fails } = setup();
    const spy = vi.spyOn(c, 'loadSelectionFromImage').mockResolvedValue(null);
    await call('load_selection_from_image', { image: 'data:image/png;base64,AAAA', channel: 'alpha', threshold: 128, invert: true, mode: 'add' });
    expect(spy).toHaveBeenCalledWith('data:image/png;base64,AAAA', { channel: 'alpha', threshold: 128, invert: true, mode: 'add' });
    await fails('load_selection_from_image', {}, /image/);
    await fails('load_selection_from_image', { image: 'x', channel: 'hue' }, /channel|enum/i);
  });

  it('set_selection_display switches ants, Quick Mask and hidden without an undo step', async () => {
    const { c, call, fails } = setup();
    await call('select_all');
    expect(await call('set_selection_display', { display: 'quickMask' })).toMatchObject({ display: 'quickMask' });
    expect(c.getState().quickMask).toBe(true);
    expect(await call('set_selection_display', { display: 'none' })).toMatchObject({ display: 'none' });
    expect(c.getState().quickMask).toBe(false);
    c.setQuickMask(true);
    expect(c.getSelectionDisplay()).toBe('quickMask');
    c.setQuickMask(false);
    expect(c.getSelectionDisplay()).toBe('ants');
    // The display changes are not undo steps: undo reverts select_all.
    c.undo();
    expect(c.getSelection()).toBeNull();
    await fails('set_selection_display', { display: 'outline' }, /display|enum/i);
  });

  it('keeps select_region and select_by_color as deprecated aliases', () => {
    const { c } = setup();
    const tools = createImageEditorToolProvider(c).tools as { name: string; description: string }[];
    for (const name of ['select_region', 'select_by_color']) {
      expect(tools.find((t) => t.name === name)!.description).toMatch(/^Deprecated: use /);
    }
  });

  it('plays the new tools back on the Select panel', () => {
    for (const name of ['select_all', 'deselect', 'invert_selection', 'select_rect', 'select_ellipse', 'select_polygon', 'magic_wand', 'select_color_range', 'load_selection_from_image', 'load_selection_from_mask', 'set_selection_display']) {
      expect(imagePlaybackPanel(name), name).toBe('select');
    }
  });
});

describe('Color Range presets', () => {
  it('skin tones cover light and dark skin but not neutrals or saturated colours', () => {
    const swatches: RGBA[] = [
      [234, 192, 168, 255], // light skin
      [141, 85, 36, 255], // dark skin
      [128, 128, 128, 255], // grey
      [0, 0, 255, 255], // blue
      [0, 200, 0, 255], // green
    ];
    const mask = skinToneRange(img(swatches.length, 1, (x) => swatches[x]!));
    expect(mask.data[0]).toBeGreaterThan(200);
    expect(mask.data[1]).toBeGreaterThan(200);
    expect(Array.from(mask.data.slice(2))).toEqual([0, 0, 0]);
  });

  it('every preset runs and transparent pixels are never selected', () => {
    const pixels = img(4, 1, (x) => [[255, 0, 0, 0], [255, 0, 0, 255], [20, 20, 20, 255], [240, 240, 240, 255]][x] as RGBA);
    for (const preset of COLOR_RANGE_PRESETS) expect(colorRangePreset(pixels, preset).data[0], preset).toBe(0);
    expect(colorRangePreset(pixels, 'reds').data[1]).toBe(255);
    expect(colorRangePreset(pixels, 'shadows').data[2]).toBe(255);
    expect(colorRangePreset(pixels, 'highlights').data[3]).toBe(255);
    expect(() => colorRangePreset(pixels, 'purples' as never)).toThrow(/Unknown Color Range preset/);
  });
});

describe('Color Range tool and feather in the selection gesture', () => {
  it('a click samples a colour; Shift adds, Alt removes', async () => {
    const { c } = setup();
    const { SelectionGesture, DEFAULT_SELECTION_TOOL_OPTIONS } = await import('../src/image-editor');
    let options = { ...DEFAULT_SELECTION_TOOL_OPTIONS, tool: 'range' as const, fuzziness: 0 };
    const g = new SelectionGesture(c, () => options);
    await g.begin({ x: 3, y: 3 });
    expect(c.getSelection()!.bounds).toEqual({ x: 2, y: 0, width: 4, height: 10 });
    await g.begin({ x: 13, y: 3 }, { shiftKey: true });
    expect(c.getSelection()!.bounds).toEqual({ x: 2, y: 0, width: 14, height: 10 });
    await g.begin({ x: 3, y: 3 }, { altKey: true });
    expect(c.getSelection()!.bounds).toEqual({ x: 12, y: 0, width: 4, height: 10 });
    options = { ...options, rangeInvert: true };
    await g.begin({ x: 0, y: 0 });
    expect(c.getSelection()!.bounds).toEqual({ x: 2, y: 0, width: 14, height: 10 });
    expect(g.error).toBeNull();
  });

  it('feathers marquee selections from the options', async () => {
    const { c } = setup();
    const { SelectionGesture, DEFAULT_SELECTION_TOOL_OPTIONS } = await import('../src/image-editor');
    const g = new SelectionGesture(c, () => ({ ...DEFAULT_SELECTION_TOOL_OPTIONS, tool: 'rect', feather: 2 }));
    await g.begin({ x: 6, y: 3 });
    g.move({ x: 12, y: 7 });
    g.end();
    expect(c.getSelection()!.bounds!.width).toBeGreaterThan(6);
  });
});
