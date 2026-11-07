import { describe, expect, it, vi } from 'vitest';
import { createFakeEffectProvider, type EffectProvider, type EffectRendererOptions, type EffectRenderRequest } from '../src/effects';
import { PaintEditorController, createPaintEditorToolProvider, createPaintEffectsToolProvider, MAX_EFFECT_PATH_POINTS, replayPainting, sampleEffectAt, type EffectPaintPixels, type PaintPixelLayer } from '../src/paint-editor';
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

  it('lays the effect along the stroke for impasto and wet brushes too', async () => {
    for (const brushId of ['impasto-brush', 'watercolor-round']) {
      const c = editor();
      await c.setEffectPaint({ effect: 'fake.gradient', values: RED_TO_BLUE, map: { by: 'stroke', length: 96, repeat: 'clamp' } });
      c.paintStroke({ brushId, brush: { tip: { size: 12 } }, points: DOWN, seed: 1 });
      if (brushId === 'watercolor-round') c.dryPaint();
      expect(redness(px(c, 20, 10)), brushId).toBeGreaterThan(redness(px(c, 20, 54)));
    }
  });

  it('works for particle, bristle and mixer brushes too, and refuses bad maps with the fix', async () => {
    const c = editor();
    await c.setEffectPaint({ effect: 'fake.gradient', values: RED_TO_BLUE, map: { by: 'stroke', length: 60 } });
    for (const brushId of ['spring-ink', 'bristle-round', 'mixer-brush']) {
      c.addLayer();
      expect(c.paintStroke({ brushId, points: ACROSS }).bounds, brushId).not.toBeNull();
    }
    await expect(c.setEffectPaint({ effect: 'fake.gradient', map: { by: 'stroke', length: 4 } })).rejects.toThrow(/map.length 4 is out of range; use 16..4096/);
    await expect(c.setEffectPaint({ effect: 'fake.gradient', map: { by: 'spiral' } })).rejects.toThrow(/use "canvas" .* "stroke" .* or "path"/);
    await expect(c.setEffectPaint({ effect: 'fake.gradient', map: { by: 'path' } })).rejects.toThrow(/has no path control.*by: "stroke".*by: "canvas"/);
    await expect(c.setEffectPaint({ effect: 'fake.gradient', map: { by: 'stroke', repeat: 'wrap' } })).rejects.toThrow(/repeat, mirror, clamp/);
  });

  it('passes each stroke centreline in canvas pixels to an effect path control (map: { by: "path" }) and simplifies long strokes', async () => {
    const renderedPaths: unknown[] = [];
    const c = new PaintEditorController({ width: W, height: H, paper: 'smooth' });
    c.setEffectsProvider(
      createFakeEffectProvider({
        onRender: (id, req) => {
          if (id === 'fake.trail') renderedPaths.push(req.values?.path);
        },
      })
    );
    const p = await c.setEffectPaint({ effect: 'fake.trail', values: { color: '#ff0000', width: 12 }, map: { by: 'path' } });
    expect(p.map).toEqual({ by: 'path' });

    c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: DOWN });
    expect(renderedPaths.at(-1)).toEqual([20, 4, 20, 60]);
    expect(c.getStrokes()[0].paint).toMatchObject({
      type: 'effect',
      effect: 'fake.trail',
      map: { by: 'path' },
      values: { path: [20, 4, 20, 60], color: '#ff0000', width: 12 },
    });
    // The trail draws along x = 20, y = 4..60 in red, and leaves pixels off the stroke untouched.
    // Away from y = 32: with no path, fake.trail draws a line across the middle.
    expect(px(c, 20, 10)[0]).toBeGreaterThan(200);
    expect(px(c, 20, 10)[3]).toBe(255);
    expect(px(c, 70, 32)[3]).toBe(0);

    // Replaying moved by dx = 40 moves the path control points too.
    c.replayStrokes({ strokeIds: [c.getStrokes()[0].id], dx: 40 });
    expect(renderedPaths.at(-1)).toEqual([60, 4, 60, 60]);
    expect(px(c, 60, 10)[0]).toBeGreaterThan(200);

    // Very long strokes (> MAX_EFFECT_PATH_POINTS) are simplified rather than refused.
    const longPoints = Array.from({ length: MAX_EFFECT_PATH_POINTS + 120 }, (_, i) => ({
      x: 4 + (i * 88) / (MAX_EFFECT_PATH_POINTS + 119),
      y: 16,
    }));
    c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: longPoints });
    const simplified = renderedPaths.at(-1) as number[];
    expect(Array.isArray(simplified)).toBe(true);
    expect(simplified.length).toBe(MAX_EFFECT_PATH_POINTS * 2);
    expect(simplified.slice(0, 2)).toEqual([4, 16]);
    expect(simplified.slice(-2)).toEqual([92, 16]);
  });
});

describe('path-mapped effect paint on a provider that only renders asynchronously', () => {
  /** Renders like a GPU provider: results only ever arrive later, and there is no `renderSync`. */
  function gpuLike(fail: () => boolean = () => false): EffectProvider {
    const fake = createFakeEffectProvider();
    return Object.assign(Object.create(fake), {
      async createRenderer(id: string, options: EffectRendererOptions) {
        const r = await fake.createRenderer(id, options);
        return {
          effectId: r.effectId,
          width: r.width,
          height: r.height,
          depth: r.depth,
          dispose: () => r.dispose(),
          render: async (request: EffectRenderRequest) => {
            await new Promise((done) => setTimeout(done, 1));
            if (fail()) throw new Error('the GPU went away');
            return r.render(request);
          },
        };
      },
    });
  }
  const TRAIL = { effect: 'fake.trail', values: { color: '#ff0000', width: 12 }, map: { by: 'path' } };
  const pointer = (c: PaintEditorController) => {
    const s = c.beginStroke({ brushId: 'ink-pen', brush: HARD, start: DOWN[0] });
    s.push(DOWN);
    return s.end();
  };
  /** On the path, off the no-path picture (the line across the middle at y = 32); and the other way round. */
  const followsPath = (c: PaintEditorController, x = 20) => {
    expect(px(c, x, 10)[3]).toBe(255);
    expect(px(c, x + 10, 32)[3]).toBe(0);
  };

  it('paints a hand-painted stroke along its path, in one undo step, on either kind of provider', async () => {
    for (const provider of [createFakeEffectProvider(), gpuLike()]) {
      const c = new PaintEditorController({ width: W, height: H, paper: 'smooth' });
      c.setEffectsProvider(provider);
      await c.setEffectPaint(TRAIL);
      expect(c.getState().canUndo).toBe(false);
      const result = pointer(c);
      await c.strokeRendering;
      expect(c.strokeRendering).toBeNull();
      followsPath(c);
      expect(c.getStrokes()).toHaveLength(1);
      expect(result.strokeId).toBe(c.getStrokes()[0].id);
      expect(c.getStrokes()[0].paint).toMatchObject({ values: { path: [20, 4, 20, 60] } });
      c.undo();
      expect(c.getStrokes()).toHaveLength(0);
      expect(px(c, 20, 10)[3]).toBe(0);
      expect(c.getState().canUndo).toBe(false);
    }
  });

  it('keeps a stroke whose preview laid nothing (an effect that is empty without a path)', async () => {
    const c = new PaintEditorController({ width: W, height: H, paper: 'smooth' });
    c.setEffectsProvider(gpuLike());
    await c.setEffectPaint(TRAIL);
    // Only y = 10 is painted, which the no-path line misses: the preview changes no pixel.
    const s = c.beginStroke({ brushId: 'ink-pen', brush: { tip: { size: 8, hardness: 1 } } as never, start: { x: 10, y: 10, pressure: 1 } });
    s.push([{ x: 10, y: 10, pressure: 1 }, { x: 80, y: 10, pressure: 1 }]);
    s.end();
    await c.strokeRendering;
    expect(c.getStrokes()).toHaveLength(1);
    expect(px(c, 40, 10)[3]).toBe(255);
  });

  it('is busy until the path render lands, reports it as rendering, and drops the stroke when it fails', async () => {
    let fail = false;
    const c = new PaintEditorController({ width: W, height: H, paper: 'smooth' });
    c.setEffectsProvider(gpuLike(() => fail));
    await c.setEffectPaint(TRAIL);
    pointer(c);
    expect(c.getState().effectPaintRendering).toBe(true);
    expect(() => c.beginStroke({ start: DOWN[0] })).toThrow(/still rendering the effect "fake.trail" along its path; wait for it/);
    expect(() => c.undo()).toThrow(/still rendering/);
    await c.strokeRendering;
    expect(c.getState().effectPaintRendering).toBe(false);

    fail = true;
    const s = c.beginStroke({ brushId: 'ink-pen', brush: HARD, start: ACROSS[0] });
    s.push(ACROSS);
    s.end();
    await expect(c.strokeRendering).rejects.toThrow(/the GPU went away/);
    expect(c.strokeRendering).toBeNull();
    expect(c.getStrokes()).toHaveLength(1);
    fail = false;
    expect(() => c.beginStroke({ start: DOWN[0] }).cancel()).not.toThrow();
  });

  it('refuses a stroke it has no render for instead of painting the wrong picture', async () => {
    const c = new PaintEditorController({ width: W, height: H, paper: 'smooth' });
    c.setEffectsProvider(gpuLike());
    await c.setEffectPaint(TRAIL);
    expect(() => c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: DOWN })).toThrow(/not rendered at this canvas size; call prepareStrokePathEffect/);
    expect(c.getStrokes()).toHaveLength(0);
    await c.prepareStrokePathEffect({ brushId: 'ink-pen', brush: HARD }, [DOWN]);
    c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: DOWN });
    followsPath(c);
  });

  it('refuses wet brushes by hand, whose stroke cannot be painted again, and says what to do', async () => {
    const c = new PaintEditorController({ width: W, height: H, paper: 'smooth' });
    c.setEffectsProvider(createFakeEffectProvider());
    await c.setEffectPaint(TRAIL);
    expect(() => c.beginStroke({ brushId: 'watercolor-round', start: DOWN[0] })).toThrow(/wet media.*dry brush.*by: "stroke".*paint_stroke/);
  });

  it('renders what paint_stroke, edit_stroke_points and a new effect paint on a stroke need', async () => {
    const c = new PaintEditorController({ width: W, height: H, paper: 'smooth' });
    c.setEffectsProvider(gpuLike());
    const tools = new ToolRegistry();
    tools.register(createPaintEditorToolProvider(c));
    tools.register(createPaintEffectsToolProvider(c));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await tools.callTool(name, args);
      expect(r.isError, JSON.stringify(r)).toBeFalsy();
      return r.structuredContent as Record<string, never>;
    };
    await call('set_effect_paint', TRAIL);
    await call('add_layer', { type: 'strokes' });
    const brush = { tip: { size: 24, hardness: 1 } };
    const { strokeId } = await call('paint_stroke', { brushId: 'ink-pen', brush, points: DOWN });
    followsPath(c);

    await call('edit_stroke_points', { id: strokeId, transform: { dx: 40 } });
    followsPath(c, 60);
    expect(px(c, 20, 10)[3]).toBe(0);
    await call('edit_stroke_points', { id: strokeId, points: DOWN });
    followsPath(c);
    expect(c.document.liveStrokes![c.getActiveLayer()!.id][0].paint).toMatchObject({ values: { path: [20, 4, 20, 60] } });

    const bad = await tools.callTool('edit_stroke_points', { id: strokeId, transform: { scale: 99 } });
    expect(bad.isError).toBe(true);

    const blue = { ...c.getEffectPaint()!, values: { color: '#0000ff', width: 12 } };
    expect(c.strokeEditNeedsRender(strokeId, { paint: blue })).toBe(true);
    expect(() => c.updateStroke(strokeId, { paint: blue })).toThrow(/not rendered yet/);
    await c.prepareStrokeEdit(strokeId, { paint: blue });
    c.updateStroke(strokeId, { paint: blue });
    expect(px(c, 20, 10)[2]).toBeGreaterThan(200);
    followsPath(c);
  });

  it('replays hand-painted strokes as they were painted, more of them than the render cache holds', async () => {
    const c = new PaintEditorController({ width: W, height: H, paper: 'smooth' });
    c.setEffectsProvider(gpuLike());
    await c.setEffectPaint(TRAIL);
    for (let i = 0; i < 10; i++) {
      const points = [{ x: 8 + i * 8, y: 4 + i, pressure: 1 }, { x: 8 + i * 8, y: 60 - i, pressure: 1 }];
      const s = c.beginStroke({ brushId: 'ink-pen', brush: HARD, start: points[0] });
      s.push(points);
      s.end();
      await c.strokeRendering;
    }
    const target = c.createReplayTarget(1);
    await replayPainting(c.document, target);
    expect(target.getStrokes()).toHaveLength(10);
    expect(composite(target).equals(composite(c))).toBe(true);
    target.dispose();

    // replay_strokes needs them all at once, repeats included.
    const ids = c.getStrokes().map((s) => s.id);
    await c.prepareStrokeEffects(ids, { strokeIds: ids, dx: 1, repeat: 2 });
    expect(c.replayStrokes({ strokeIds: ids, dx: 1, repeat: 2 }).strokeIds).toHaveLength(20);
  });

  it('keeps the render of every path stroke on a stroke layer, which are redrawn synchronously', async () => {
    const renders: unknown[] = [];
    const c = new PaintEditorController({ width: W, height: H, paper: 'smooth' });
    c.setEffectsProvider(createFakeEffectProvider({ onRender: (_id, r) => renders.push(r) }));
    await c.setEffectPaint(TRAIL);
    c.addLayer({ type: 'strokes' });
    const strokes = Array.from({ length: 10 }, (_, i) => [{ x: 8 + i * 8, y: 4, pressure: 1 }, { x: 8 + i * 8, y: 60, pressure: 1 }]);
    for (const points of strokes) c.paintStroke({ brushId: 'ink-pen', brush: HARD, points });
    const painted = renders.length;
    const first = c.document.liveStrokes![c.getActiveLayer()!.id][0];
    c.updateStroke(first.id, { seed: 7 });
    expect(renders.length).toBe(painted);
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
    r = await call('set_effect_paint', { effect: 'fake.gradient', map: { by: 'path' } });
    expect(r.error).toMatch(/has no path control.*by: "stroke".*by: "canvas"/);
    r = await call('set_effect_paint', { effect: 'fake.trail', values: { color: '#22d3ee', width: 10 }, map: { by: 'path' }, live: true });
    expect(r.error).toBeNull();
    expect(r.data.effectPaint).toMatchObject({ effect: 'fake.trail', map: { by: 'path' }, live: true });
    r = await call('set_effect_paint', { effect: 'fake.gradient', values: { ...RED_TO_BLUE, spin: 180 }, live: true, map: { by: 'stroke', length: 80, repeat: 'mirror' } });
    expect(r.error).toBeNull();
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
