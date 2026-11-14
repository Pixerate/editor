import { describe, expect, it } from 'vitest';
import { PaintEditorController, createPaintEditorToolProvider, replayItems } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools/registry';
import { advanceReplayClock } from '../src/paint-editor/replay';

const wave = (y: number, n = 30, x0 = 30, x1 = 290) => Array.from({ length: n }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / (n - 1), y: y + Math.sin(i / 4) * 12, pressure: 0.6 + 0.4 * Math.sin(i / 7) }));
const editor = () => new PaintEditorController({ width: 320, height: 240, paper: 'cold-pressed', wet: { kernel: 'wasm', threads: 0 } });
const same = (a: Uint8ClampedArray, b: Uint8ClampedArray) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

describe('replay', () => {
  it('repaints dry strokes, fills, clears and relief exactly', async () => {
    const c = editor();
    c.fillLayer({ color: '#f3e0b5', grain: 0.6 });
    c.paintStroke({ points: wave(60), brushId: 'soft-pastel', color: '#c0392b' });
    c.addLayer({ name: 'Ink' });
    c.paintStroke({ points: wave(120), brushId: 'ink-pen', color: '#111111' });
    c.paintStroke({ points: wave(160), brushId: 'mixer-brush', color: '#2980b9' });
    c.addLayer({ name: 'Thick' });
    c.paintStroke({ points: wave(200), brushId: 'impasto-brush', color: '#f1c40f' });
    c.clearLayer(c.listLayers().find((l) => l.name === 'Ink')!.id);
    c.paintStroke({ points: wave(100), brushId: 'charcoal-stick', layerId: c.listLayers().find((l) => l.name === 'Ink')!.id });
    expect(replayItems(c.document).map((i) => i.kind)).toEqual(['paint', 'stroke', 'stroke', 'stroke', 'stroke', 'paint', 'stroke']);
    const t = c.createReplayTarget(1);
    const { replayPainting } = await import('../src/paint-editor/replay');
    await replayPainting(c.document, t);
    expect(same(t.compositePixels().data, c.compositePixels().data)).toBe(true);
    t.dispose();
  });

  it('repaints wet strokes with the paint flowing between points as it did', async () => {
    const c = editor();
    c.setCanvasTilt({ angle: 20 });
    c.wetPaper({ rect: { x: 0, y: 0, width: 320, height: 120 } });
    await c.wetReady();
    // A live stroke with time passing between its points.
    const s = c.beginStroke({ brushId: 'watercolor-round', color: '#1d4ed8', seed: 4 });
    for (const [i, p] of wave(60).entries()) {
      s.push([p]);
      if (i % 5 === 0) await c.advanceWet({ steps: 3 });
    }
    s.end();
    await c.advanceWet({ steps: 30 });
    c.paintStroke({ points: wave(100), brushId: 'gouache', color: '#e67e22', seed: 5 });
    await c.advanceWet({ steps: 20 });
    c.dryPaint({ rect: { x: 0, y: 0, width: 160, height: 240 } });
    await c.advanceWet({ steps: 11 });
    const t = c.createReplayTarget(1);
    const { replayPainting } = await import('../src/paint-editor/replay');
    await replayPainting(c.document, t);
    await t.advanceWet({ steps: c.getState().wet.clock - t.getState().wet.clock });
    expect(t.getState().wet.clock).toBe(c.getState().wet.clock);
    expect(same(t.compositePixels({ wet: 'dried' }).data, c.compositePixels({ wet: 'dried' }).data)).toBe(true);
    t.dispose();
    c.dispose();
  }, 60000);

  it('makes a time-lapse with a video project and an ffmpeg command', async () => {
    const c = editor();
    for (let i = 0; i < 6; i++) c.paintStroke({ points: wave(30 + i * 30), brushId: i % 2 ? 'soft-pastel' : 'watercolor-round', color: i % 2 ? '#8e44ad' : '#16a085' });
    const tl = await c.timeLapse({ frames: 3, maxSide: 160, wetStepsPerFrame: 0, fps: 10, holdMs: 1000 });
    expect(tl.frames.length).toBe(4);
    expect(tl.width).toBe(160);
    expect(tl.video.assets).toHaveLength(4);
    expect(tl.video.assets[0].src).toBe('frame-0001.png');
    expect(tl.durationMs).toBeCloseTo(1400, 0);
    expect(tl.ffmpeg.command).toContain('timelapse.mp4');
    expect(tl.ffmpeg.command).toContain('frame-0004.png');
    c.dispose();
  }, 60000);

  it('re-renders at a larger size from the strokes instead of upscaling', async () => {
    const c = editor();
    c.paintStroke({ points: wave(120), brushId: 'pencil-hb', color: '#222222' });
    const big = await c.renderHighRes({ scale: 2 });
    expect(big.width).toBe(640);
    expect(big.height).toBe(480);
    // A pencil line painted at twice the size has more distinct grey levels than a 2× upscale of the small one.
    const levels = (img: { data: Uint8ClampedArray }) => new Set(Array.from({ length: img.data.length / 4 }, (_, i) => img.data[i * 4])).size;
    expect(levels(big)).toBeGreaterThan(levels(c.compositePixels()));
    await expect(c.renderHighRes({ scale: 60 })).rejects.toThrow(/1\.\.8/);
    c.dispose();
  });
});

describe('replay agent tools', () => {
  it('export_time_lapse and export_high_res', async () => {
    const c = editor();
    c.paintStroke({ points: wave(120), brushId: 'soft-pastel', color: '#c0392b' });
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));
    let r = await reg.callTool('export_time_lapse', { frames: 2, maxSide: 120 });
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.content.find((x: { type: string }) => x.type === 'text')!.text!);
    expect(parsed.frames).toBeGreaterThan(1);
    expect(parsed.ffmpeg).toContain('ffmpeg');
    expect(r.content.some((x: { type: string }) => x.type === 'image')).toBe(true);
    r = await reg.callTool('export_high_res', { scale: 2 });
    const hi = JSON.parse(r.content.find((x: { type: string }) => x.type === 'text')!.text!);
    expect(hi).toMatchObject({ width: 640, height: 480, mimeType: 'image/png' });
    r = await reg.callTool('export_high_res', { scale: 9 });
    expect(r.isError).toBe(true);
    c.dispose();
  }, 60000);
});

describe('advanceReplayClock (#855)', () => {
  /** A target whose wet clock moves by the steps asked for, counting the calls. */
  const fake = (limit = Infinity) => {
    let clock = 0;
    const calls: number[] = [];
    const target = {
      getState: () => ({ wet: { clock } }),
      advanceWet: async ({ steps }: { steps: number }) => {
        const ran = Math.max(0, Math.min(steps, limit - clock));
        calls.push(steps);
        clock += ran;
        return { steps: ran };
      },
    };
    return { target: target as unknown as PaintEditorController, calls };
  };

  it('steps all at once without a wetChunk', async () => {
    const { target, calls } = fake();
    expect(await advanceReplayClock(target, 50)).toBe(50);
    expect(calls).toEqual([50]);
    const zero = fake();
    expect(await advanceReplayClock(zero.target, 50, { wetChunk: 0 })).toBe(50);
    expect(zero.calls).toEqual([50]);
  });

  it('steps in chunks of wetChunk, calling onWetSteps after each', async () => {
    const { target, calls } = fake();
    const seen: number[] = [];
    expect(await advanceReplayClock(target, 7, { wetChunk: 3, onWetSteps: (c) => void seen.push(c) })).toBe(7);
    expect(calls).toEqual([3, 3, 1]);
    expect(seen).toEqual([3, 6, 7]);
  });

  it('stops when the clock cannot move', async () => {
    const { target, calls } = fake(4);
    expect(await advanceReplayClock(target, 10)).toBe(4);
    expect(calls).toEqual([10, 6]);
  });
});
