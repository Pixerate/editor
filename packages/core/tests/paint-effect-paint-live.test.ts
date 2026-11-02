import { describe, expect, it, vi } from 'vitest';
import { createFakeEffectProvider } from '../src/effects';
import { PaintEditorController, createPaintEditorToolProvider, createPaintEffectsToolProvider, replayPainting, sampleEffectAt, type EffectPaintPixels, type PaintPixelLayer } from '../src/paint-editor';
import { readPixel } from '../src/raster/surface';
import { ToolRegistry } from '../src/tools/registry';

const W = 96;
const H = 64;
/** Red on the left to blue on the right (the fake gradient's angle 0). */
const RED_TO_BLUE = { from: '#ff0000', to: '#0000ff', angle: 0 };
const HARD = { tip: { size: 10, hardness: 1, opacity: 1, flow: 1, spacing: 0.05, pressureOpacity: false, pressureSize: false, smoothing: 0 }, grain: 0 };
const ACROSS = [
  { x: 4, y: 32 },
  { x: 92, y: 32 },
];
const DOWN = [
  { x: 20, y: 4 },
  { x: 20, y: 60 },
];

function editor() {
  const c = new PaintEditorController({ width: W, height: H, paper: 'smooth' });
  c.setEffectsProvider(createFakeEffectProvider());
  return c;
}
const px = (c: PaintEditorController, x: number, y: number) => readPixel((c.getActiveLayer() as PaintPixelLayer).surface, x, y);
const redness = (p: number[]) => p[0] - p[2];
const composite = (c: PaintEditorController) => Buffer.from(c.compositePixels().data);

describe('effect paint along the stroke', () => {
  it('samples a strip by distance along the stroke and position across the tip, with repeat, mirror and clamp', () => {
    // A 16 × 2 strip: x = 0..15 as red, top row and bottom row differ in green.
    const data = new Uint8ClampedArray(16 * 2 * 4);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 16; x++) data.set([x * 16, y * 255, 0, 255], (y * 16 + x) * 4);
    const strip = (repeat: 'repeat' | 'mirror' | 'clamp'): EffectPaintPixels => ({ width: 16, height: 2, data, map: { by: 'stroke', length: 16, repeat } });
    const out: [number, number, number] = [0, 0, 0];
    // A dab heading right (direction 0) at travel t; sample at the dab's centre.
    // Just above the path: the strip's top row.
    const at = (img: EffectPaintPixels, travel: number, across = -3) => {
      sampleEffectAt(img, 50, 50 + across, out, { x: 50, y: 50, direction: 0, radius: 4, travel });
      return [Math.round(out[0] * 255), Math.round(out[1] * 255)];
    };
    expect(at(strip('repeat'), 4)).toEqual([64, 0]);
    expect(at(strip('repeat'), 20)).toEqual([64, 0]);
    expect(at(strip('mirror'), 20)).toEqual([192, 0]);
    expect(at(strip('clamp'), 40)).toEqual([240, 0]);
    // Across the tip: below the path (y down) is the strip's bottom row.
    expect(at(strip('repeat'), 4, 3)[1]).toBe(255);
  });

  it('lays the effect along each stroke, whatever its direction, and replays exactly', async () => {
    const c = editor();
    await c.setEffectPaint({ effect: 'fake.gradient', values: RED_TO_BLUE, map: { by: 'stroke', length: 96, repeat: 'clamp' } });
    expect(c.getEffectPaint()?.map).toEqual({ by: 'stroke', length: 96, repeat: 'clamp' });
    c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: DOWN });
    // Down the stroke: red at its start, bluer at its end (fixed to the canvas it would be one colour).
    expect(redness(px(c, 20, 8))).toBeGreaterThan(redness(px(c, 20, 56)));
    expect(c.getStrokes()[0].paint).toMatchObject({ type: 'effect', map: { by: 'stroke', length: 96 } });
    const t = c.createReplayTarget(1);
    await replayPainting(c.document, t);
    expect(Buffer.from(t.compositePixels().data).equals(composite(c))).toBe(true);
    t.dispose();
    // Canvas mapping: the vertical stroke sits at one x, so one colour from top to bottom.
    const d = editor();
    await d.setEffectPaint({ effect: 'fake.gradient', values: RED_TO_BLUE });
    d.paintStroke({ brushId: 'ink-pen', brush: HARD, points: DOWN });
    expect(Math.abs(redness(px(d, 20, 8)) - redness(px(d, 20, 56)))).toBeLessThan(6);
  });

  it('works for particle, bristle and mixer brushes too, and refuses bad maps with the fix', async () => {
    const c = editor();
    await c.setEffectPaint({ effect: 'fake.gradient', values: RED_TO_BLUE, map: { by: 'stroke', length: 60 } });
    for (const brushId of ['spring-ink', 'bristle-round', 'mixer-brush']) {
      c.addLayer();
      expect(c.paintStroke({ brushId, points: ACROSS }).bounds, brushId).not.toBeNull();
    }
    await expect(c.setEffectPaint({ effect: 'fake.gradient', map: { by: 'stroke', length: 4 } })).rejects.toThrow(/map.length 4 is out of range; use 16..4096/);
    await expect(c.setEffectPaint({ effect: 'fake.gradient', map: { by: 'path' } })).rejects.toThrow(/use "canvas" .* or "stroke"/);
    await expect(c.setEffectPaint({ effect: 'fake.gradient', map: { by: 'stroke', repeat: 'wrap' } })).rejects.toThrow(/repeat, mirror, clamp/);
  });
});

describe('live effect paint', () => {
  async function live() {
    const c = editor();
    c.addLayer({ type: 'strokes' });
    await c.setEffectPaint({ effect: 'fake.gradient', values: { ...RED_TO_BLUE, spin: 180 }, live: true });
    c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: ACROSS });
    return c;
  }

  it('plays the effect in strokes on a stroke layer without changing the document', async () => {
    const c = await live();
    expect(c.getAnimation()).toMatchObject({ strokes: 1, sources: 1 });
    const doc = c.document;
    const at0 = composite(c);
    expect(await c.showEffectTime(1000)).toBe(true);
    const at1000 = composite(c);
    expect(at1000.equals(at0)).toBe(false);
    expect(c.getState().effectPlayback.time).toBe(1000);
    // The document is untouched: exports without a time, saves and undo see frame 0.
    expect(c.document).toBe(doc);
    expect(c.getState().canUndo).toBe(true);
    // A frame rendered off-screen matches the view at that time.
    expect(Buffer.from((await c.renderAnimationFrame(1000)).data).equals(at1000)).toBe(true);
    expect(Buffer.from((await c.renderAnimationFrame(0)).data).equals(at0)).toBe(true);
    await c.showEffectTime(0);
    expect(composite(c).equals(at0)).toBe(true);
  });

  it('redraws only where live strokes paint', async () => {
    const c = await live();
    c.setColor('#16a34a');
    c.setPaint({ type: 'color', color: '#16a34a' });
    c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: [{ x: 4, y: 6 }, { x: 92, y: 6 }] });
    const draw = vi.spyOn(c as unknown as { drawLiveStroke: () => unknown }, 'drawLiveStroke');
    await c.showEffectTime(500);
    // The live stroke only: the plain stroke far above it is kept.
    expect(draw).toHaveBeenCalledTimes(1);
    draw.mockRestore();
    expect(px(c, 40, 6)).toEqual(readPixel((c.getActiveLayer() as PaintPixelLayer).surface, 40, 6));
  });

  it('plays on an injected clock at most fps a second, and stops when paused or stopped', async () => {
    const c = await live();
    let now = 0;
    const frames: Array<() => void> = [];
    const clock = { now: () => now, frame: (cb: () => void) => (frames.push(cb), () => {}) };
    const show = vi.spyOn(c, 'showEffectTime');
    const player = c.playEffects(clock);
    const step = async (ms: number) => {
      now += ms;
      frames.splice(0).forEach((f) => f());
      await new Promise((r) => setTimeout(r, 0));
    };
    await step(16);
    await step(16);
    c.setEffectPlayback({ fps: 10 });
    await step(16);
    await step(16);
    const atTen = show.mock.calls.length;
    await step(120);
    expect(show.mock.calls.length).toBe(atTen + 1);
    c.setEffectPlayback({ playing: false });
    await step(200);
    await step(200);
    expect(show.mock.calls.length).toBe(atTen + 1);
    player.stop();
    c.setEffectPlayback({ playing: true });
    await step(200);
    expect(frames).toHaveLength(0);
    expect(() => c.setEffectPlayback({ fps: 0 })).toThrow(/fps 0 is out of range/);
  });

  it('bakes on a pixel layer, saves its source, and caps the number of live effects', async () => {
    const c = editor();
    await c.setEffectPaint({ effect: 'fake.gradient', values: { ...RED_TO_BLUE, spin: 180 }, live: true });
    c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: ACROSS });
    expect(c.getAnimation()).toBeNull();
    const d = editor();
    d.loadJSON(JSON.parse(JSON.stringify(c.toJSON())));
    expect(d.getStrokes()[0].paint).toMatchObject({ type: 'effect', live: true });
    const e = editor();
    e.addLayer({ type: 'strokes' });
    for (let i = 0; i < 8; i++) {
      await e.setEffectPaint({ effect: 'fake.gradient', values: { spin: i + 1 }, live: true });
      e.paintStroke({ brushId: 'ink-pen', brush: HARD, points: ACROSS });
    }
    await e.setEffectPaint({ effect: 'fake.gradient', values: { spin: 99 }, live: true });
    expect(() => e.paintStroke({ brushId: 'ink-pen', brush: HARD, points: ACROSS })).toThrow(/already plays 8 live effects/);
  });

  it('agent tools: live and map on set_effect_paint, set_effect_playback, and export at a time', async () => {
    const c = editor();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));
    reg.register(createPaintEffectsToolProvider(c, { id: 'fx', namespace: '' }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await reg.callTool(name, args);
      return { error: r.isError ? (r.content[0] as { text: string }).text : null, data: (r.structuredContent ?? (r.isError ? null : JSON.parse((r.content[0] as { text: string }).text))) as Record<string, any> };
    };
    await call('add_layer', { type: 'strokes' });
    let r = await call('set_effect_paint', { effect: 'fake.gradient', values: { ...RED_TO_BLUE, spin: 180 }, live: true, map: { by: 'stroke', length: 80, repeat: 'mirror' } });
    expect(r.error).toBeNull();
    expect(r.data.effectPaint).toMatchObject({ live: true, map: { by: 'stroke', length: 80, repeat: 'mirror' } });
    r = await call('set_effect_paint', { effect: 'fake.gradient', map: { by: 'stroke', length: 2 } });
    expect(r.error).toMatch(/length/);
    await call('paint_stroke', { brushId: 'ink-pen', points: ACROSS });
    r = await call('list_applied_effects', { target: 'paint' });
    expect(JSON.stringify(r.data)).toMatch(/"live":true/);
    r = await call('set_effect_playback', { playing: false, fps: 24 });
    expect(r.data).toMatchObject({ playing: false, fps: 24, animation: { strokes: 1 } });
    r = await call('set_effect_playback', { fps: 100 });
    expect(r.error).toMatch(/fps/);
    const a = await call('export_image', { format: 'image/png' });
    const b = await call('export_image', { format: 'image/png', time: 1000 });
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(JSON.stringify(a.data)).not.toEqual(JSON.stringify(b.data));
    r = await call('export_psd', { time: 1000 });
    expect(r.error).toBeNull();
  });
});
