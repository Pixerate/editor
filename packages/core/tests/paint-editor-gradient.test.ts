import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PaintEditorController, createPaintEditorToolProvider } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools/registry';
import type { PaintGradientSource } from '../src/paint';

const BLUE_YELLOW: PaintGradientSource = { type: 'gradient', stops: [{ offset: 0, color: '#1d4ed8' }, { offset: 1, color: '#facc15' }], space: 'pigment', map: { by: 'distance', length: 300, repeat: 'mirror', unit: 'px' } };
const line = (y: number, x0 = 20, x1 = 620, n = 80, pressure = (i: number) => 0.8 + 0 * i) => Array.from({ length: n }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / (n - 1), y, pressure: pressure(i), t: i * 16 }));
const editor = (w = 640, h = 320) => new PaintEditorController({ width: w, height: h, paper: 'smooth', wet: { kernel: 'wasm', threads: 0 } });
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const at = (c: PaintEditorController, x: number, y: number, layerId = c.document.activeLayerId!) => rgb(c.pickColor(x, y, { layerId }).color);
const isBlue = (p: number[]) => p[2] > p[0] + 60 && p[2] > p[1];
const isYellow = (p: number[]) => p[0] > 180 && p[1] > 150 && p[2] < 110;
const isGreen = (p: number[]) => p[1] > p[0] + 20 && p[1] > p[2];
const hash = (c: PaintEditorController) => createHash('sha256').update(c.compositePixels({ wet: 'dried' }).data).digest('hex');

describe('gradient paint in the paint editor', () => {
  it('changes colour as the stroke is dragged out (through green in pigment), and records it', () => {
    const c = editor();
    expect(c.setPaint(BLUE_YELLOW)).toMatchObject({ type: 'gradient', map: { by: 'distance', length: 300 } });
    expect(c.getState().paint.type).toBe('gradient');
    const r = c.paintStroke({ points: line(160), brushId: 'ink-pen', brush: { tip: { size: 16 } } });
    expect(isBlue(at(c, 24, 160))).toBe(true);
    expect(isGreen(at(c, 170, 160))).toBe(true);
    expect(isYellow(at(c, 330, 160))).toBe(true);
    expect(isBlue(at(c, 618, 160))).toBe(true);
    const stroke = c.getStrokes().find((s) => s.id === r.strokeId)!;
    expect(stroke.paint).toEqual(BLUE_YELLOW);
    // The eyedropper still picks one colour; set_color goes back to one colour.
    c.setColor(c.pickColor(170, 160).color);
    expect(c.getState().paint.type).toBe('color');
  });

  it('replays and re-renders byte for byte, and survives save and load', async () => {
    const c = editor();
    c.setPaint({ ...BLUE_YELLOW, map: { by: 'random', every: 2 } });
    c.paintStroke({ points: line(80), brushId: 'brush-pen', seed: 9 });
    c.setPaint({ ...BLUE_YELLOW, map: { by: 'pressure' } });
    c.paintStroke({ points: line(200, 20, 620, 80, (i) => i / 79), brushId: 'soft-pastel' });
    const t = c.createReplayTarget(1);
    const { replayPainting } = await import('../src/paint-editor/replay');
    await replayPainting(c.document, t);
    expect(hash(t)).toBe(hash(c));
    t.dispose();
    const d = editor();
    expect(d.loadJSON(JSON.parse(JSON.stringify(c.toJSON())))).toEqual([]);
    expect(d.getStrokes().map((s) => s.paint?.map.by)).toEqual(['random', 'pressure']);
    expect(hash(d)).toBe(hash(c));
  });

  it('maps pressure, and a stroke override wins over the editor paint; erasers and blenders ignore it', () => {
    const c = editor();
    c.setPaint(BLUE_YELLOW);
    c.paintStroke({ points: line(100, 20, 620, 80, (i) => i / 79), brushId: 'ink-pen', paint: { ...BLUE_YELLOW, map: { by: 'pressure' } } });
    expect(isBlue(at(c, 30, 100))).toBe(true);
    expect(isYellow(at(c, 610, 100))).toBe(true);
    // A plain colour for one stroke.
    c.paintStroke({ points: line(220), brushId: 'ink-pen', color: '#c0392b' });
    const red = at(c, 330, 220);
    expect(red[0]).toBeGreaterThan(150);
    expect(red[2]).toBeLessThan(100);
    c.paintStroke({ points: line(220), brushId: 'eraser-hard' });
    expect(c.pickColor(330, 220, { layerId: c.document.activeLayerId! }).alpha).toBe(0);
  });

  it('presets resolve paint and secondary to the two colours', () => {
    const c = editor();
    c.setColor('#1d4ed8');
    c.setSecondaryColor('#facc15');
    const r = c.paintStroke({ points: line(160), brushId: 'gradient-round' });
    expect(c.getStrokes().find((s) => s.id === r.strokeId)!.paint!.stops.map((s) => s.color)).toEqual(['#1d4ed8', '#facc15']);
    expect(isBlue(at(c, 24, 160))).toBe(true);
    expect(isYellow(at(c, 340, 160))).toBe(true);
  });

  it('wet media: each deposit carries its sampled pigment into the wet layer', async () => {
    const c = editor();
    c.setColor('#1d4ed8');
    c.setSecondaryColor('#facc15');
    c.paintStroke({ points: line(160, 20, 620, 60), brushId: 'gradient-wash', seed: 3 });
    await c.wetReady();
    await c.advanceWet({ steps: 20 });
    c.dryPaint({});
    const p0 = at(c, 30, 160);
    const p1 = at(c, 300, 160);
    expect(p0[2]).toBeGreaterThan(p0[0]);
    expect(p1[0]).toBeGreaterThan(p1[2]);
    c.dispose();
  });

  it('thick paint: the colour varies along the impasto, with its relief', () => {
    const c = editor();
    c.setPaint(BLUE_YELLOW);
    c.paintStroke({ points: line(160), brushId: 'impasto-brush' });
    // The impasto brush picks up and drags its own wet paint, so the blue start turns teal.
    const start = at(c, 40, 160);
    expect(start[2]).toBeGreaterThan(start[0] + 60);
    expect(isYellow(at(c, 330, 160))).toBe(true);
    expect(c.getState().document.thick?.[c.document.activeLayerId!]).toBeTruthy();
  });

  it('particle, bristle and sticker brushes take the gradient too', () => {
    const c = editor();
    c.setPaint({ ...BLUE_YELLOW, map: { by: 'distance', length: 600, repeat: 'clamp' } });
    c.addLayer({ name: 'stickers' });
    c.paintStroke({ points: line(160), brushId: 'sticker-confetti', seed: 1 });
    const stickers = c.listStickers();
    expect(stickers.length).toBeGreaterThan(4);
    const first = rgb(stickers[0].color);
    const last = rgb(stickers[stickers.length - 1].color);
    expect(first[2]).toBeGreaterThan(first[0]);
    expect(last[0]).toBeGreaterThan(last[2]);
    c.addLayer({ name: 'bristles' });
    c.paintStroke({ points: line(160), brushId: 'bead-trail', seed: 2 });
    const layer = c.document.activeLayerId!;
    let blue = 0;
    let yellow = 0;
    for (let x = 20; x < 620; x += 4)
      for (let y = 120; y < 200; y += 4) {
        const p = c.pickColor(x, y, { layerId: layer });
        if (p.alpha < 0.5) continue;
        if (isBlue(rgb(p.color))) blue++;
        if (isYellow(rgb(p.color))) yellow++;
      }
    expect(blue).toBeGreaterThan(0);
    expect(yellow).toBeGreaterThan(0);
  });
});

describe('gradient paint agent tools', () => {
  const setup = () => {
    const c = editor();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));
    const call = (name: string, args: Record<string, unknown> = {}) => reg.callTool(name, args);
    const parse = (r: { content: Array<{ text?: string }>; structuredContent?: unknown }) => (r.structuredContent ?? JSON.parse(r.content[0].text!)) as Record<string, any>;
    return { c, call, parse };
  };

  it('set_paint, paint_stroke paint and get_brush strokePaint close the loop', async () => {
    const { c, call, parse } = setup();
    let r = await call('set_paint', { paint: BLUE_YELLOW });
    expect(r.isError).toBeFalsy();
    expect(parse(r).paint).toEqual(BLUE_YELLOW);
    r = await call('get_brush', {});
    expect(parse(r).strokePaint).toEqual(BLUE_YELLOW);
    expect(parse(r).paint).toBeNull();
    r = await call('get_brush', { id: 'gradient-round' });
    expect(parse(r).paint.map).toEqual({ by: 'distance', length: 300, repeat: 'mirror', unit: 'px' });
    r = await call('paint_stroke', { points: line(160), brushId: 'ink-pen', paint: { type: 'gradient', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], map: { by: 'across-tip' } } });
    expect(r.isError).toBeFalsy();
    expect(c.getStrokes().at(-1)!.paint!.map.by).toBe('across-tip');
    r = await call('set_paint', { paint: { type: 'color', color: '#c0392b' } });
    expect(parse(r)).toMatchObject({ paint: { type: 'color', color: '#c0392b' }, color: '#c0392b' });
    r = await call('list_brushes', {});
    expect(parse(r).brushes.find((b: { id: string }) => b.id === 'rainbow-marker').gradient).toBe(true);
  });

  it('refuses bad gradients with what is wrong', async () => {
    const { call } = setup();
    const unsorted = { type: 'gradient', stops: [{ offset: 0.8, color: '#000000' }, { offset: 0.2, color: '#ffffff' }] };
    let r = await call('set_paint', { paint: unsorted });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/sorted by offset/);
    r = await call('set_paint', { paint: { type: 'gradient', stops: [{ offset: 0, color: '#000000' }] } });
    expect(r.isError).toBe(true);
    r = await call('set_paint', { paint: { type: 'gradient', stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }], map: { by: 'speed' } } });
    expect(r.isError).toBe(true);
    r = await call('set_brush', { paint: unsorted });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/sorted by offset/);
    r = await call('paint_stroke', { points: line(100), paint: unsorted });
    expect(r.isError).toBe(true);
    r = await call('set_paint', {});
    expect(r.isError).toBe(true);
  });

  it('set_brush gives a brush its own gradient; add_swatch keeps a gradient', async () => {
    const { c, call, parse } = setup();
    let r = await call('set_brush', { id: 'ink-pen', paint: { ...BLUE_YELLOW, map: { by: 'velocity' } } });
    expect(parse(r).paint.map).toEqual({ by: 'velocity' });
    r = await call('set_brush', { paint: null });
    expect(parse(r).paint).toBeNull();
    r = await call('add_swatch', { paint: BLUE_YELLOW, name: 'Sky' });
    const sw = parse(r).swatches.at(-1);
    expect(sw).toMatchObject({ name: 'Sky', color: '#1d4ed8', paint: BLUE_YELLOW });
    r = await call('add_swatch', { color: '#ff0000', paint: BLUE_YELLOW });
    expect(r.isError).toBe(true);
    const d = editor();
    d.loadJSON(JSON.parse(JSON.stringify(c.toJSON())));
    expect(d.getState().swatches.at(-1)).toMatchObject({ name: 'Sky', paint: BLUE_YELLOW });
  });
});
