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

describe('Phase 2 selection tools', () => {
  // A gradient red square (x 2..5, shades 200..255) on white, and a separate red square at x 12..15.
  const shades = (x: number): RGBA => (x >= 2 && x < 6 ? [200 + (x - 2) * 15, 0, 0, 255] : x >= 12 && x < 16 ? [215, 0, 0, 255] : [255, 255, 255, 255]);

  it('grow_selection follows colour and stays connected; select_similar does not', async () => {
    const { call, fails } = setup(shades);
    await fails('grow_selection', {}, /Nothing is selected/);
    await call('magic_wand', { x: 2, y: 3, tolerance: 0, antiAlias: false });
    expect((await call('get_selection')).area).toBe(10);
    expect((await call('grow_selection', { tolerance: 50 })).bounds).toEqual({ x: 2, y: 0, width: 4, height: 10 });
    expect((await call('select_similar', { tolerance: 50 })).area).toBe(80);
    await fails('select_similar', { tolerance: 500 }, /tolerance|maximum/);
  });

  it('modify_selection takes expand and contract (grow and shrink stay as aliases)', async () => {
    const { call } = setup();
    await call('select_rect', { x: 5, y: 3, width: 4, height: 4, antiAlias: false });
    const expanded = await call('modify_selection', { op: 'expand', radius: 1 });
    expect(expanded.bounds).toEqual({ x: 4, y: 2, width: 6, height: 6 });
    expect((await call('modify_selection', { op: 'contract', radius: 1 })).bounds).toEqual({ x: 5, y: 3, width: 4, height: 4 });
    expect((await call('modify_selection', { op: 'grow', radius: 1 })).bounds).toEqual(expanded.bounds);
  });

  it('select_line selects a 1 px row or column and checks the position', async () => {
    const { call, fails } = setup();
    expect(await call('select_line', { orientation: 'row', position: 4.7 })).toMatchObject({ area: 20, bounds: { x: 0, y: 4, width: 20, height: 1 } });
    expect(await call('select_line', { orientation: 'column', position: 3, mode: 'add' })).toMatchObject({ area: 29 });
    await fails('select_line', { orientation: 'row', position: 10 }, /outside the image \(0\.\.9\)/);
    await fails('select_line', { orientation: 'diagonal', position: 1 }, /orientation|enum/i);
  });

  it('reselect brings back what deselect cleared', async () => {
    const { c, call, fails } = setup();
    await fails('reselect', {}, /no cleared selection/);
    await call('select_rect', { x: 1, y: 1, width: 3, height: 3, antiAlias: false });
    await call('deselect');
    expect(await call('reselect')).toMatchObject({ area: 9 });
    c.undo();
    expect(c.getSelection()).toBeNull();
  });

  it('select_layer_transparency selects a layer’s pixels, and masks come from transparency or hide the selection', async () => {
    const { c, call, fails } = setup();
    const dot = new Uint8ClampedArray(3 * 2 * 4).fill(255);
    const id = c.addPixelLayer({ name: 'Dot', pixels: { width: 3, height: 2, data: dot }, x: 4, y: 5 });
    await fails('select_layer_transparency', { layerId: 'nope' }, /No layer "nope"/);
    expect(await call('select_layer_transparency', { layerId: id })).toMatchObject({ area: 6, bounds: { x: 4, y: 5, width: 3, height: 2 } });
    const empty = c.addPixelLayer({ name: 'Empty' });
    expect((await call('select_layer_transparency', { layerId: empty })).empty).toBe(true);
    const group = c.addGroup?.({ name: 'G' });
    if (typeof group === 'string') await fails('select_layer_transparency', { layerId: group }, /no pixels of its own/);
    expect((await call('select_layer_transparency', { layerId: 'background' })).percent).toBe(100);
    await call('select_rect', { x: 0, y: 0, width: 5, height: 10, antiAlias: false });
    const hidden = await call('add_layer_mask', { layerId: 'background', from: 'hide-selection' });
    expect(hidden.mask).toBeDefined();
    await call('load_selection_from_mask', { layerId: 'background' });
    expect((await call('get_selection')).bounds).toEqual({ x: 5, y: 0, width: 15, height: 10 });
    await call('add_layer_mask', { layerId: 'background', from: 'transparency' });
    expect((await call('load_selection_from_mask', { layerId: 'background' })).percent).toBe(100);
  });

  it('plays the Phase 2 tools back on the Select panel', () => {
    for (const name of ['select_line', 'grow_selection', 'select_similar', 'reselect', 'select_layer_transparency']) {
      expect(imagePlaybackPanel(name), name).toBe('select');
    }
  });
});

describe('polygonal lasso and line gestures', () => {
  async function gesture(tool: 'polygon' | 'row' | 'column') {
    const { c } = setup();
    const { SelectionGesture, DEFAULT_SELECTION_TOOL_OPTIONS } = await import('../src/image-editor');
    return { c, g: new SelectionGesture(c, () => ({ ...DEFAULT_SELECTION_TOOL_OPTIONS, tool, antiAlias: false })) };
  }

  it('clicks add corners and a double-click closes', async () => {
    const { c, g } = await gesture('polygon');
    await g.begin({ x: 2, y: 2 });
    g.end({ x: 2, y: 2 });
    expect(g.active).toBe(true);
    await g.begin({ x: 12, y: 2 });
    g.end();
    g.move({ x: 12, y: 8 });
    expect(g.draftPath).toEqual([{ x: 2, y: 2 }, { x: 12, y: 2 }, { x: 12, y: 8 }]);
    await g.begin({ x: 12, y: 8 });
    g.end();
    await g.begin({ x: 12, y: 8 }, { detail: 2 });
    expect(g.active).toBe(false);
    const b = c.getSelection()!.bounds!;
    expect(b.y).toBe(2);
    expect(b.x + b.width).toBe(12);
  });

  it('Enter closes, Backspace removes a corner, Escape cancels, Shift snaps to 45°', async () => {
    const { c, g } = await gesture('polygon');
    expect(g.key('Enter')).toBe(false);
    await g.begin({ x: 1, y: 1 });
    g.end();
    await g.begin({ x: 9, y: 2 }, { shiftKey: true });
    g.end();
    expect(g.draftPath![1]!.y).toBeCloseTo(1, 5);
    await g.begin({ x: 9, y: 9 });
    g.end();
    const before = g.draftPath!.length;
    expect(g.key('Backspace')).toBe(true);
    expect(g.draftPath!.length).toBe(before - 1);
    expect(g.key('Escape')).toBe(true);
    expect(g.active).toBe(false);
    expect(c.getSelection()).toBeNull();
    for (const p of [{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 9, y: 9 }]) {
      await g.begin(p);
      g.end();
    }
    expect(g.key('Enter')).toBe(true);
    expect(c.getSelection()).not.toBeNull();
  });

  it('a click on the first corner closes; a drag adds a free-hand stretch', async () => {
    const { c, g } = await gesture('polygon');
    await g.begin({ x: 1, y: 1 });
    g.move({ x: 6, y: 1 });
    g.move({ x: 9, y: 3 });
    g.end({ x: 9, y: 5 });
    expect(g.draftPath!.length).toBeGreaterThanOrEqual(4);
    await g.begin({ x: 1.5, y: 1.5 });
    expect(g.active).toBe(false);
    expect(c.getSelection()).not.toBeNull();
  });

  it('single row and column tools select a line on click', async () => {
    const row = await gesture('row');
    await row.g.begin({ x: 3, y: 4 });
    expect(row.c.getSelection()!.bounds).toEqual({ x: 0, y: 4, width: 20, height: 1 });
    const col = await gesture('column');
    await col.g.begin({ x: 3, y: 4 });
    expect(col.c.getSelection()!.bounds).toEqual({ x: 3, y: 0, width: 1, height: 10 });
  });
});
