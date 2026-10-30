import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, createOutlineTextShaper, importPsd, layoutText, type TypeLayer } from '../src/image-editor';
import { parseTySh, tyShForLayer, typeFromTySh } from '../src/image-editor/psd/type';
import { descGet } from '../src/image-editor/psd/descriptor';
import { ePath, eNum, parseEngineData } from '../src/image-editor/psd/engine-data';
import { contentBounds } from '../src/raster/surface';
import { boxFont } from './helpers/box-font';

const W = 160;
const H = 120;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake, textShaper: createOutlineTextShaper([boxFont('Box')]) });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  return { c, registry };
}

const out = (res: { structuredContent?: unknown }) => res.structuredContent as Record<string, any>;
const errorText = (res: { content?: Array<{ type: string; text?: string }> }) => res.content?.map((p) => p.text ?? '').join(' ') ?? '';
const steps = (c: ImageEditorController) => (c as unknown as { undoStack: unknown[] }).undoStack.length;

describe('vertical type layers', () => {
  it('adds vertical type through add_text_layer: a column running down from (x, y), drawn there', async () => {
    const { c, registry } = setup();
    const r = out(await registry.callTool('add_text_layer', { text: '中文字', x: 80, y: 10, orientation: 'vertical', style: { fontFamily: 'Box', fontSize: 20 } }));
    expect(r.text).toMatchObject({ orientation: 'vertical', frame: { kind: 'point' }, rendering: 'live' });
    expect(r.text.lines.map((l: any) => [l.start, l.end])).toEqual([[0, 3]]);
    // Three upright 1 em cells (the box font's ascent + descent) down from y = 10, centred on x = 80.
    const b = contentBounds((c.getLayer(r.layer.id) as TypeLayer).surface)!;
    expect(b.x).toBeGreaterThanOrEqual(70);
    expect(b.x + b.width).toBeLessThanOrEqual(90);
    expect(b.y).toBeGreaterThanOrEqual(10);
    expect(b.height).toBeGreaterThan(50);
    expect(b.y + b.height).toBeLessThanOrEqual(71);
  });

  it('switches orientation with set_text_orientation as one undo step, and back', async () => {
    const { c, registry } = setup();
    const id = out(await registry.callTool('add_text_layer', { text: 'AB\nCD', x: 40, y: 30, style: { fontFamily: 'Box', fontSize: 10 } })).layer.id;
    const n = steps(c);
    let r = out(await registry.callTool('set_text_orientation', { layerId: id, orientation: 'vertical' }));
    expect(steps(c)).toBe(n + 1);
    expect(r.orientation).toBe('vertical');
    expect(c.getLayer(id)).toMatchObject({ orientation: 'vertical' });
    // Latin turns sideways: the second paragraph is a column to the left of the first.
    const layout = c.getTextLayout(id)!;
    const [first, second] = layout.lines.map((l) => l.fragments[0].glyphs![0]);
    expect(first.angle).toBe(90);
    expect(second.x).toBeLessThan(first.x);
    // Same orientation again changes nothing.
    out(await registry.callTool('set_text_orientation', { layerId: id, orientation: 'vertical' }));
    expect(steps(c)).toBe(n + 1);
    r = out(await registry.callTool('set_text_orientation', { layerId: id, orientation: 'horizontal' }));
    expect(r.orientation).toBe('horizontal');
    expect('orientation' in (c.getLayer(id) as TypeLayer)).toBe(false);
    c.undo();
    expect(c.getLayer(id)).toMatchObject({ orientation: 'vertical' });
  });

  it('sets Latin upright with the upright style field', async () => {
    const { c, registry } = setup();
    const id = out(await registry.callTool('add_text_layer', { text: 'AB', x: 40, y: 10, orientation: 'vertical', style: { fontFamily: 'Box', fontSize: 10 } })).layer.id;
    const r = out(await registry.callTool('set_text_style', { layerId: id, upright: true }));
    expect(r.runs[0].style.upright).toBe(true);
    expect(c.getTextLayout(id)!.lines[0].fragments[0].glyphs!.map((g) => g.angle)).toEqual([0, 0]);
  });

  it('refuses a bad orientation with what to pass instead, changing nothing', async () => {
    const { c, registry } = setup();
    const before = c.getLayers().length;
    let res = await registry.callTool('add_text_layer', { text: 'x', x: 0, y: 0, orientation: 'diagonal' });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toMatch(/horizontal|vertical/);
    expect(c.getLayers().length).toBe(before);
    const id = out(await registry.callTool('add_text_layer', { text: 'x', x: 0, y: 0, style: { fontFamily: 'Box' } })).layer.id;
    res = await registry.callTool('set_text_orientation', { layerId: id, orientation: 'sideways' });
    expect(res.isError).toBe(true);
    res = await registry.callTool('set_text_orientation', { layerId: 'nope', orientation: 'vertical' });
    expect(res.isError).toBe(true);
  });

  it('keeps the first column in place between point and paragraph text', () => {
    const { c } = setup();
    const id = c.addTextLayer({ text: '一二三', x: 100, y: 20, orientation: 'vertical', style: { fontFamily: 'Box', fontSize: 10 } });
    const caret0 = c.textCaret(id, 0)!;
    c.setTextFrame(id, { kind: 'box', width: 40, height: 60 });
    const boxCaret = c.textCaret(id, 0)!;
    expect(boxCaret.top.x).toBeCloseTo(caret0.top.x);
    expect(boxCaret.top.y).toBeCloseTo(caret0.top.y);
    // Resizing the box keeps its right edge (where the columns start).
    c.setTextFrame(id, { kind: 'box', width: 60, height: 60 });
    expect(c.textCaret(id, 0)!.top.x).toBeCloseTo(caret0.top.x);
    c.setTextFrame(id, { kind: 'point' });
    expect(c.textCaret(id, 0)!.top.x).toBeCloseTo(caret0.top.x);
    expect(c.textCaret(id, 0)!.top.y).toBeCloseTo(caret0.top.y);
  });

  it('hit-tests and moves the caret down the column', () => {
    const { c } = setup();
    const id = c.addTextLayer({ text: '一二', x: 50, y: 10, orientation: 'vertical', style: { fontFamily: 'Box', fontSize: 10 } });
    expect(c.textIndexAt(id, { x: 50, y: 22 })).toBe(1);
    const caret = c.textCaret(id, 1)!;
    // Horizontal across the column, 10 px down.
    expect(caret.top.y).toBeCloseTo(20);
    expect(caret.bottom.y).toBeCloseTo(20);
    expect(caret.top.x).toBeGreaterThan(caret.bottom.x);
  });

  it('round-trips through JSON', () => {
    const { c } = setup();
    const id = c.addTextLayer({ text: '縦書き', x: 80, y: 10, orientation: 'vertical', style: { fontFamily: 'Box', fontSize: 12, upright: true } });
    const json = c.toJSON();
    const { c: d } = setup();
    d.loadJSON(json);
    expect(d.getTextLayer(id)).toMatchObject({ orientation: 'vertical', text: '縦書き' });
    expect(d.getTextLayer(id).runs[0].style.upright).toBe(true);
    expect(JSON.stringify(d.toJSON())).toBe(JSON.stringify(json));
  });

  it('writes Ornt Vrtc and vertical writing direction to PSD and reads vertical type back', async () => {
    const { c } = setup();
    const id = c.addTextLayer({ text: '一二\nAB', x: 80, y: 10, orientation: 'vertical', style: { fontFamily: 'Box', fontSize: 12 } });
    c.setTextStyle(id, { upright: true }, { start: 3, end: 5 });
    const layer = c.getLayer(id) as TypeLayer;
    const block = tyShForLayer(layer);
    const t = parseTySh(block)!;
    expect(descGet(t.text, 'Ornt')).toMatchObject({ value: 'Vrtc' });
    const ed = descGet(t.text, 'EngineData');
    const engine = parseEngineData((ed as { data: Uint8Array }).data);
    expect(eNum(ePath(engine, ['EngineDict', 'Rendered', 'Shapes', 'WritingDirection']))).toBe(2);
    const notes = new Set<string>();
    const back = typeFromTySh(block, notes)!;
    expect(notes.size).toBe(0);
    expect(back.orientation).toBe('vertical');
    expect(back.runs.map((r) => [r.length, r.style.upright])).toEqual([
      [3, undefined],
      [2, true],
    ]);

    // Through a whole file: still vertical, and it lays out vertically when edited.
    const doc = importPsd((await c.toPsd()).bytes);
    const read = doc.layers.find((l) => l.type === 'type') as TypeLayer;
    expect(read.orientation).toBe('vertical');
    const { c: d } = setup();
    const res = d.loadPsd((await c.toPsd()).bytes);
    const tid = res.layerIds[res.layerIds.length - 1];
    expect(d.getTextLayer(tid).orientation).toBe('vertical');
    d.setText(tid, '三', { start: 0, end: 1 });
    expect(layoutText(d.getLayer(tid) as TypeLayer, d.getTextShaper()!).orientation).toBe('vertical');
  });

  it('writes horizontal type as before (Ornt Hrzn, signature unchanged)', () => {
    const { c } = setup();
    const id = c.addTextLayer({ text: 'Hi', x: 10, y: 20, style: { fontFamily: 'Box', fontSize: 12 } });
    const t = parseTySh(tyShForLayer(c.getLayer(id) as TypeLayer))!;
    expect(descGet(t.text, 'Ornt')).toMatchObject({ value: 'Hrzn' });
    expect(typeFromTySh(tyShForLayer(c.getLayer(id) as TypeLayer), new Set())!.orientation).toBe('horizontal');
  });
});
