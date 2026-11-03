import { describe, expect, it } from 'vitest';
import { BRUSH_PRESETS, CANVAS_PROFILE, IMAGE_PROFILE, VECTOR_PROFILE, brushColourHex, createBrushLibrary, listPresets, resolveBrush, type Brush } from '../src/brushes';
import { combineStickerProviders, createFakeStickerProvider, editorStickers } from '../src/stickers';
import { createPaintBrushLibraryToolProvider, createPaintEditorToolProvider, DEFAULT_PAPER, PaintEditorController, renderBrushThumbnail, replayPainting } from '../src/paint-editor';
import { ImageEditorController } from '../src/image-editor';
import { ToolRegistry } from '../src/tools';

const preset = (id: string) => BRUSH_PRESETS.find((b) => b.id === id)!;
const ids = (list: readonly Brush[]) => list.map((b) => b.id);
const NEW = ['ballpoint', 'gel-pen', 'fineliner', 'crayon', 'chalk', 'spray-can'];
const line = (n = 24, y = 40) => Array.from({ length: n }, (_, i) => ({ x: 10 + i * 8, y: y + Math.sin(i / 3) * 6, pressure: 0.5 + (i % 4) * 0.12, t: i * 16 }));
const painted = (c: PaintEditorController) => {
  const px = c.compositePixels({ paper: false } as never).data;
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
  return n;
};
const editor = (options: ConstructorParameters<typeof PaintEditorController>[0] = {}) =>
  new PaintEditorController({ width: 220, height: 80, paper: 'smooth', stickers: combineStickerProviders([editorStickers(), createFakeStickerProvider()]), ...options });

describe('the new presets', () => {
  it.each(NEW)('%s has a variety and a thumbnail that paints', (id) => {
    const p = preset(id);
    expect(p.variety).toBeTruthy();
    const t = renderBrushThumbnail(resolveBrush(p), { paper: DEFAULT_PAPER, color: '#1f2937' });
    const paper = renderBrushThumbnail(resolveBrush({ ...p, tip: { ...p.tip, opacity: 0 } }), { paper: DEFAULT_PAPER, color: '#1f2937' });
    expect(Buffer.from(t.data).equals(Buffer.from(paper.data)), id).toBe(false);
  });

  it('lists the new dry and ink presets in canvas, vector and the image editor, and the spray can in paint only', () => {
    const dryInk = ['ballpoint', 'gel-pen', 'fineliner', 'crayon', 'chalk'];
    for (const profile of [CANVAS_PROFILE, VECTOR_PROFILE, IMAGE_PROFILE]) {
      expect(ids(listPresets(profile)), profile.id).toEqual(expect.arrayContaining(dryInk));
      expect(ids(listPresets(profile)), profile.id).not.toContain('spray-can');
    }
  });

  it('files the highlighter as fluorescent ink: yellow, with pink, green and orange, and no light spill', () => {
    expect(preset('highlighter')).toMatchObject({ medium: 'ink', variety: 'highlighter', tip: { shape: 'chisel', blend: 'multiply' }, light: { amount: 0.5, spill: { radius: 0 } }, colour: { default: '#fff200', palette: ['#fff200', '#ff6ec7', '#7cff4f', '#ffa630'] } });
    expect(preset('neon-marker').colour?.palette?.length).toBeGreaterThan(2);
  });

  it('sprays droplets across the tip with the spray can, the same on a replay', async () => {
    const c = editor();
    const r = c.paintStroke({ brushId: 'spray-can', points: line(), seed: 5 });
    // Each dab lays 1 + 0.7 × 31 ≈ 23 droplets.
    expect(r.dabs).toBeGreaterThan(line().length * 10);
    const pixels = Buffer.from(c.compositePixels().data);
    const t = c.createReplayTarget(1);
    await replayPainting(c.document, t);
    expect(Buffer.from(t.compositePixels().data).equals(pixels)).toBe(true);
    t.dispose();
  });
});

describe('stamp tips', () => {
  it('paints every dab as an editor stamp, unlike the round tip', () => {
    const round = editor();
    round.setBrushFacets({ tip: { shape: 'round', size: 24, spacing: 0.6 } }, 'ink-pen');
    round.paintStroke({ points: line(12), color: '#111111', seed: 1 });
    const star = editor();
    star.setBrushFacets({ tip: { shape: 'stamp', size: 24, spacing: 0.6, stamps: ['editor:star'] } }, 'ink-pen');
    expect(star.getState().brush).toMatchObject({ engine: 'dab', stamp: 'editor:star' });
    star.paintStroke({ points: line(12), color: '#111111', seed: 1 });
    expect(painted(star)).toBeGreaterThan(0);
    expect(painted(star)).toBeLessThan(painted(round));
  });

  it('paints a sticker from the sticker library as the tip once its art is loaded, in the paint colour', async () => {
    const c = editor();
    const registry = new ToolRegistry();
    registry.register(createPaintEditorToolProvider(c));
    const r = await registry.callTool('set_brush', { id: 'ink-pen', tip: { shape: 'stamp', size: 30, spacing: 0.5, stamps: ['fake:badge-new'] } });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const stroke = await registry.callTool('paint_stroke', { points: line(10), color: '#dc2626', seed: 2 });
    expect(stroke.isError).toBeFalsy();
    expect(painted(c)).toBeGreaterThan(50);
    expect(c.pickColor(c.getStrokes()[0].points[3].x, c.getStrokes()[0].points[3].y, { paper: false } as never)?.color).toMatch(/^#[c-f][0-9a-f]/);
  });

  it('draws textured particle dots from library stickers', async () => {
    const c = editor();
    await c.prepareStickers(['fake:badge-new']);
    c.setBrushFacets({ tip: { shape: 'stamp', stamps: ['fake:badge-new'] }, marks: { kind: 'particles', render: 'dot', count: 6 } }, 'spring-ink');
    expect(c.getState().brush.particle.dotTextures).toEqual(['fake:badge-new']);
    c.paintStroke({ points: line(), color: '#2563eb', seed: 3 });
    expect(painted(c)).toBeGreaterThan(0);
  });

  it('refuses a sticker the host cannot load, naming why, in the library tools', async () => {
    const c = editor();
    const registry = new ToolRegistry();
    registry.register(createPaintBrushLibraryToolProvider(c));
    const bad = await registry.callTool('brushes__create_brush', { id: 'cats', name: 'Cats', kind: 'mark', tip: { shape: 'stamp', stamps: ['fake:weather-snu'] } });
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toMatch(/can't load sticker "fake:weather-snu".*Closest: .*fake:weather-sun/);
    const good = await registry.callTool('brushes__create_brush', { id: 'suns', name: 'Suns', kind: 'mark', tip: { shape: 'stamp', size: 30, stamps: ['fake:weather-sun'] } });
    expect(good.isError, JSON.stringify(good.content)).toBeFalsy();
    const checked = await registry.callTool('brushes__check_brush', { brush: { id: 'x', name: 'X', kind: 'mark', tip: { shape: 'stamp', stamps: ['acme:logo'] } } });
    expect((checked.structuredContent as { ok: boolean }).ok).toBe(false);
  });
});

describe('default colours', () => {
  it('resolves solid, rgba and light / dark colours to #rrggbb for the scheme', () => {
    expect(brushColourHex('#FFF200', 'light')).toBe('#fff200');
    expect(brushColourHex('rgba(255, 0, 0, 0.5)', 'dark')).toBe('#ff0000');
    expect(brushColourHex({ light: '#475569', dark: '#f8fafc' }, 'light')).toBe('#475569');
    expect(brushColourHex({ light: '#475569', dark: '#f8fafc' }, 'dark')).toBe('#f8fafc');
    expect(brushColourHex({ type: 'gradient', stops: [] }, 'light')).toBeNull();
  });

  it('takes the default colour of a chosen brush, keeps a locked colour, and follows the scheme', () => {
    const c = editor({ color: '#123456' });
    c.setBrush({ id: 'highlighter' });
    expect(c.getState().color).toBe('#fff200');
    c.setColorScheme('dark');
    expect(c.getState().color).toBe('#fff200');
    c.setBrush({ id: 'chalk' });
    expect(c.getState().color).toBe('#f8fafc');
    c.setColorScheme('light');
    expect(c.getState().color).toBe('#475569');
    // A colour the user picks stays through scheme changes.
    c.setColor('#ff0000');
    c.setColorScheme('dark');
    expect(c.getState().color).toBe('#ff0000');
    c.setColorLocked(true);
    c.setBrush({ id: 'highlighter' });
    expect(c.getState()).toMatchObject({ color: '#ff0000', colorLocked: true });
    // Brushes without a default colour leave it.
    c.setColorLocked(false);
    c.setBrush({ id: 'pencil-hb' });
    expect(c.getState().color).toBe('#ff0000');
  });

  it('paints a colour.own brush in its own colour, resolved when the stroke starts and recorded', async () => {
    const c = editor({ colorScheme: 'dark' });
    c.setBrushFacets({ colour: { default: { light: '#111111', dark: '#eeeeee' }, own: true } }, 'ink-pen');
    c.setColor('#ff0000');
    c.paintStroke({ points: line(), seed: 1 });
    expect(c.getStrokes()[0].color).toBe('#eeeeee');
    const pixels = Buffer.from(c.compositePixels().data);
    c.setColorScheme('light');
    const t = c.createReplayTarget(1);
    await replayPainting(c.document, t);
    expect(Buffer.from(t.compositePixels().data).equals(pixels)).toBe(true);
    t.dispose();
  });

  it('takes and returns colours through the tools, strictly', async () => {
    const c = editor();
    const registry = new ToolRegistry();
    registry.register(createPaintEditorToolProvider(c, { id: 'paint', namespace: 'paint' }));
    registry.register(createPaintBrushLibraryToolProvider(c));
    let r = await registry.callTool('brushes__create_brush', { id: 'night-chalk', name: 'Night chalk', basedOn: 'chalk', colour: { default: { light: '#1e293b', dark: '#e0f2fe' }, palette: ['#fca5a5', { light: '#0f172a', dark: '#f1f5f9' }] } });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    r = await registry.callTool('brushes__describe_brush', { id: 'night-chalk' });
    expect((r.structuredContent as { brush: Brush }).brush.colour).toEqual({ default: { light: '#1e293b', dark: '#e0f2fe' }, palette: ['#fca5a5', { light: '#0f172a', dark: '#f1f5f9' }] });
    r = await registry.callTool('brushes__update_brush', { id: 'night-chalk', colour: { palette: ['#22c55e'] } });
    expect((r.structuredContent as { changed: string[] }).changed).toEqual(['colour.palette']);
    for (const colour of [{ default: 'not a colour' }, { palette: new Array(17).fill('#000000') }, { own: 'yes' }, { default: { light: '#000000' } }]) {
      const bad = await registry.callTool('brushes__update_brush', { id: 'night-chalk', colour });
      expect(bad.isError, JSON.stringify(colour)).toBe(true);
    }
    await c.whenBrushesLoaded();
    expect((await registry.callTool('paint__set_brush', { id: 'night-chalk' })).isError).toBeFalsy();
    expect(c.getState().color).toBe('#1e293b');
    r = await registry.callTool('paint__set_color', { locked: true });
    expect(r.structuredContent).toMatchObject({ locked: true });
    await registry.callTool('paint__set_brush', { id: 'highlighter' });
    expect(c.getState().color).toBe('#1e293b');
    expect((await registry.callTool('paint__set_color', {})).isError).toBe(true);
  });

  it('sets the image editor foreground from a preset, unless asked to keep it', async () => {
    const c = new ImageEditorController({ brushLibrary: createBrushLibrary() });
    c.setPaintOptions({ foreground: '#123456' });
    expect((await c.setBrushPreset('ballpoint')).color).toBe('#1e3a8a');
    expect(c.getState().paint.foreground).toBe('#1e3a8a');
    await c.setBrushPreset('chalk', { colorScheme: 'dark' });
    expect(c.getState().paint.foreground).toBe('#f8fafc');
    c.setPaintOptions({ foreground: '#123456' });
    await c.setBrushPreset('crayon', { keepColour: true });
    expect(c.getState().paint.foreground).toBe('#123456');
  });
});
