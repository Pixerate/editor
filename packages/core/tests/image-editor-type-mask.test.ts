import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, SelectionGesture, createImageEditorToolProvider, createOutlineTextShaper, imagePlaybackPanel, DEFAULT_SELECTION_TOOL_OPTIONS } from '../src/image-editor';
import { boxFont } from './helpers/box-font';

const W = 400;
const H = 300;
const STYLE = { fontFamily: 'Box', fontSize: 100 };

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake, textShaper: createOutlineTextShaper([boxFont('Box')]) });
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

describe('type masks', () => {
  // The box font draws each glyph as a 50 × 70 px box (at 100 px) on a 60 px advance.
  it('selects the glyphs of horizontal text without adding a layer', async () => {
    const { c, call } = setup();
    const layers = c.getLayers().length;
    const sel = await call('select_text_shape', { text: 'AB', x: 10, y: 100, style: STYLE, antiAlias: false });
    expect(sel).toMatchObject({ empty: false, bounds: { x: 15, y: 30, width: 110, height: 70 }, area: 2 * 50 * 70 });
    const data = c.getSelection()!.data;
    expect(data[60 * W + 40]).toBe(255);
    // The gap between the glyphs is not selected.
    expect(data[60 * W + 70]).toBe(0);
    expect(c.getLayers()).toHaveLength(layers);
    c.undo();
    expect(c.getSelection()).toBeNull();
  });

  it('lays vertical text out as vertical type: Latin turned sideways down a column, line breaks as columns', async () => {
    const { call } = setup();
    // Box font: ascent 80, descent 20 at 100 px, so a turned glyph's baseline sits 30 left of the
    // column centre and its 70 px height rises to the right; its 50 px width runs down from y + 5.
    const sel = await call('select_text_shape', { text: 'AB', x: 200, y: 100, style: STYLE, orientation: 'vertical', antiAlias: false });
    expect(sel.bounds).toEqual({ x: 170, y: 105, width: 70, height: 110 });
    expect(sel.area).toBe(2 * 50 * 70);
    // A line break starts the next column, 120 px (auto leading) to the left.
    const two = await call('select_text_shape', { text: 'A\nB', x: 200, y: 100, style: STYLE, orientation: 'vertical', antiAlias: false });
    expect(two.bounds).toEqual({ x: 50, y: 105, width: 190, height: 50 });
    // A box fills from its right edge.
    const boxed = await call('select_text_shape', { text: 'A', x: 100, y: 50, style: STYLE, orientation: 'vertical', box: { width: 200, height: 200 }, antiAlias: false });
    expect(boxed.bounds.x + boxed.bounds.width).toBe(300 - 50 + 40);
  });

  it('combines by mode, feathers, and refuses empty text', async () => {
    const { c, call, fails } = setup();
    await call('select_rect', { x: 0, y: 0, width: 400, height: 300, antiAlias: false });
    const cut = await call('select_text_shape', { text: 'A', x: 10, y: 100, style: STYLE, mode: 'subtract', antiAlias: false });
    expect(cut.area).toBe(W * H - 50 * 70);
    const soft = await call('select_text_shape', { text: 'A', x: 10, y: 100, style: STYLE, feather: 3 });
    expect(soft.bounds.x).toBeLessThan(15);
    // Off the canvas selects nothing.
    expect(await call('select_text_shape', { text: 'A', x: 1000, y: 100, style: STYLE })).toMatchObject({ empty: true });
    expect(c.getSelection()).toBeNull();
    await fails('select_text_shape', { text: '   ', x: 10, y: 100 }, /text is empty/);
    await fails('select_text_shape', { text: 'A', x: 10, y: 100, orientation: 'diagonal' }, /orientation|enum/);
  });

  it('places the text where the Type Mask tools are clicked', async () => {
    const { c } = setup();
    let opts = { ...DEFAULT_SELECTION_TOOL_OPTIONS, tool: 'type' as 'type' | 'type-vertical', typeText: 'A', typeSize: 100, typeFamily: 'Box', antiAlias: false };
    const g = new SelectionGesture(c, () => opts);
    await g.begin({ x: 10, y: 100 });
    expect(g.error).toBeFalsy();
    expect(c.getSelection()!.bounds).toEqual({ x: 15, y: 30, width: 50, height: 70 });
    // Shift-click adds a vertical column.
    opts = { ...opts, tool: 'type-vertical', typeText: 'AB' };
    await g.begin({ x: 200, y: 100 }, { shiftKey: true });
    expect(c.getSelection()!.bounds!.x).toBe(15);
    expect(c.getSelection()!.bounds!.width).toBe(240 - 15);
  });

  it('plays select_text_shape back on the Select panel', () => {
    expect(imagePlaybackPanel('select_text_shape')).toBe('select');
  });
});
