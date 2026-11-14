import { describe, expect, it, vi } from 'vitest';
import { PaintEditorController, createPaintEditorToolProvider } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools/registry';

/**
 * Wet paint in a light / dark colour on a pixel layer follows the colour scheme through a replay of
 * the stroke log (#720 part 2): the dark side is painted again from the strokes, so wet mixing
 * mixes the dark sides as the simulation mixed the light ones.
 */

const W = 160;
const H = 120;
const editor = (scheme: 'light' | 'dark' = 'light') => new PaintEditorController({ width: W, height: H, paper: 'cold-pressed', colorScheme: scheme, wet: { kernel: 'wasm', threads: 0 } });
const wave = (y: number, n = 16, x0 = 20, x1 = 140) => Array.from({ length: n }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / (n - 1), y: y + Math.sin(i / 3) * 8, pressure: 0.7 }));
const BLUE = { light: '#1d4ed8', dark: '#93c5fd' };
const RED = { light: '#b91c1c', dark: '#fca5a5' };
const pixels = (c: PaintEditorController) => Buffer.from(c.compositePixels({ wet: 'display' }).data);
const dried = (c: PaintEditorController) => Buffer.from(c.compositePixels({ wet: 'dried' }).data);
const saved = (c: PaintEditorController) => JSON.stringify(c.toJSON());

type Step = { kind: 'stroke'; y: number; color: string | { light: string; dark: string }; seed: number; brushId?: string } | { kind: 'wait'; steps: number } | { kind: 'live'; y: number; color: string | { light: string; dark: string }; seed: number };

/** Paints `steps` (dual colours as given), the same way every time. */
async function paint(c: PaintEditorController, steps: readonly Step[]): Promise<void> {
  for (const s of steps) {
    if (s.kind === 'wait') await c.advanceWet({ steps: s.steps });
    else if (s.kind === 'stroke') {
      await c.wetIdle();
      c.paintStroke({ points: wave(s.y), brushId: s.brushId ?? 'watercolor-round', color: s.color, seed: s.seed });
    } else {
      // A pointer stroke with the simulation running between its points.
      await c.wetIdle();
      const st = c.beginStroke({ brushId: 'watercolor-round', color: s.color, seed: s.seed });
      for (const [i, p] of wave(s.y).entries()) {
        st.push([p]);
        // Not after the last point: a replay ends the stroke there (it records no clock for the end).
        if (i % 4 === 3 && i < 15) await c.advanceWet({ steps: 2 });
      }
      st.end();
      await c.wetIdle();
    }
  }
}

/** `steps` with every dual colour replaced by its `side`. */
const sided = (steps: readonly Step[], side: 'light' | 'dark'): Step[] => steps.map((s) => (s.kind !== 'wait' && typeof s.color === 'object' ? { ...s, color: s.color[side] } : s));

/** The pixels of `steps` painted fresh in `side` (no dual colours at all). */
async function fresh(steps: readonly Step[], side: 'light' | 'dark'): Promise<{ display: Buffer; dried: Buffer }> {
  const d = editor();
  await d.wetReady();
  await paint(d, sided(steps, side));
  const out = { display: pixels(d), dried: dried(d) };
  d.dispose();
  return out;
}

describe('wet dual-colour paint follows the scheme through a replay of the stroke log', () => {
  it('shows the dark side after setColorScheme, and switching back restores the light pixels exactly', async () => {
    const steps: Step[] = [{ kind: 'stroke', y: 40, color: BLUE, seed: 3 }, { kind: 'wait', steps: 12 }];
    const c = editor();
    await c.wetReady();
    await paint(c, steps);
    const light = pixels(c);
    const json = saved(c);
    const undo = c.historyLabels().undo.length;
    const doc = c.document;
    const commits: string[] = [];
    c.onCommit((e) => commits.push(e.kind));
    c.setColorScheme('dark');
    // Until the replay has caught up, the layer shows its own pixels.
    expect(c.colorSchemeView().replay.state).toBe('building');
    expect(pixels(c).equals(light)).toBe(true);
    const view = await c.colorSchemeViewReady();
    expect(view).toMatchObject({ scheme: 'dark', replay: { state: 'ready' }, layers: [{ view: 'replay', state: 'ready' }] });
    const dark = await fresh(steps, 'dark');
    expect(pixels(c).equals(dark.display)).toBe(true);
    expect(dried(c).equals(dark.dried)).toBe(true);
    // View only: the document, history, commits and the saved file don't change.
    expect(c.document).toBe(doc);
    expect(c.historyLabels().undo.length).toBe(undo);
    expect(commits).toEqual([]);
    expect(saved(c)).toBe(json);
    c.setColorScheme('light');
    expect(c.colorSchemeView().replay.state).toBe('none');
    expect(pixels(c).equals(light)).toBe(true);
    c.dispose();
  }, 60000);

  it('mixes two dual colours, and a dual colour with a plain one, as the dark sides would have mixed', async () => {
    const steps: Step[] = [
      { kind: 'stroke', y: 50, color: BLUE, seed: 1 },
      { kind: 'wait', steps: 4 },
      { kind: 'stroke', y: 56, color: RED, seed: 2 },
      { kind: 'wait', steps: 4 },
      { kind: 'stroke', y: 62, color: '#15803d', seed: 4 },
      { kind: 'wait', steps: 20 },
    ];
    const c = editor();
    await c.wetReady();
    await paint(c, steps);
    expect((await fresh(steps, 'light')).display.equals(pixels(c))).toBe(true);
    c.setColorScheme('dark');
    await c.colorSchemeViewReady();
    const dark = await fresh(steps, 'dark');
    expect(pixels(c).equals(dark.display)).toBe(true);
    expect(dried(c).equals(dark.dried)).toBe(true);
    c.dispose();
  }, 60000);

  it('keeps the view current from new strokes, live ones included, without a full replay', async () => {
    const before: Step[] = [{ kind: 'stroke', y: 30, color: BLUE, seed: 1 }, { kind: 'wait', steps: 6 }];
    // Painted in the dark scheme: a dual colour's dark side goes into the document, a plain colour as it is.
    const after: Step[] = [{ kind: 'live', y: 60, color: RED, seed: 2 }, { kind: 'wait', steps: 5 }, { kind: 'stroke', y: 90, color: '#a16207', seed: 5 }, { kind: 'wait', steps: 7 }];
    const c = editor();
    await c.wetReady();
    await paint(c, before);
    c.setColorScheme('dark');
    await c.colorSchemeViewReady();
    const targets = vi.spyOn(c, 'createReplayTarget');
    await paint(c, after);
    const view = await c.colorSchemeViewReady();
    expect(targets).not.toHaveBeenCalled();
    expect(view.replay).toMatchObject({ state: 'ready', items: c.document.strokes.length + (c.document.wetEvents?.length ?? 0) + (c.document.paintEvents?.length ?? 0) });
    // The replay is stepped to the editor's clock.
    await c.advanceWet({ steps: 9 });
    await c.colorSchemeViewReady();
    const all = [...before, ...after, { kind: 'wait', steps: 9 } as Step];
    const dark = await fresh(all, 'dark');
    expect(pixels(c).equals(dark.display)).toBe(true);
    c.dispose();
  }, 60000);

  it('follows a live wet stroke point by point, keeping the other strokes in the scheme while it is painted', async () => {
    const c = editor();
    await c.wetReady();
    await paint(c, [{ kind: 'stroke', y: 30, color: BLUE, seed: 1 }]);
    c.setColorScheme('dark');
    await c.colorSchemeViewReady();
    const px = (img: { width: number; data: Uint8ClampedArray }, p: { x: number; y: number }) => Array.from(img.data.subarray((Math.round(p.y) * img.width + Math.round(p.x)) * 4, (Math.round(p.y) * img.width + Math.round(p.x)) * 4 + 4));
    const old = wave(30)[5];
    const before = c.compositePixels({ wet: 'display' });
    const s = c.beginStroke({ brushId: 'watercolor-round', color: RED, seed: 2 });
    const pts = wave(80);
    for (const p of pts.slice(0, 8)) s.push([p]);
    await c.advanceWet({ steps: 2 });
    await c.colorSchemeViewReady();
    const mid = c.compositePixels({ wet: 'display' });
    // The new stroke shows while it is painted (the replay follows it)…
    expect(px(mid, pts[2])).not.toEqual(px(before, pts[2]));
    // …and the old one is still its dark side, not the document's light pixels.
    const blueDark = [0x93, 0xc5, 0xfd];
    const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(dist(px(mid, old), blueDark)).toBeLessThan(dist(px(mid, old), [0x1d, 0x4e, 0xd8]));
    for (const p of pts.slice(8)) s.push([p]);
    await c.wetIdle();
    s.end();
    await c.wetIdle();
    const targets = vi.spyOn(c, 'createReplayTarget');
    await c.colorSchemeViewReady();
    expect(targets).not.toHaveBeenCalled();
    c.dispose();
  }, 60000);

  it('never shows the other scheme after undo and redo across a switch', async () => {
    const a: Step[] = [{ kind: 'stroke', y: 40, color: BLUE, seed: 1 }, { kind: 'wait', steps: 6 }];
    const b: Step[] = [{ kind: 'stroke', y: 70, color: RED, seed: 2 }];
    const c = editor();
    await c.wetReady();
    await paint(c, [...a, ...b]);
    const json = saved(c);
    c.setColorScheme('dark');
    await c.colorSchemeViewReady();
    const targets = vi.spyOn(c, 'createReplayTarget');
    await c.wetIdle();
    c.undo();
    await c.colorSchemeViewReady();
    // Back to a checkpoint of the replay, not a fresh one; the dark side of what is left.
    expect(targets).not.toHaveBeenCalled();
    const onlyA = await fresh(a, 'dark');
    expect(dried(c).equals(onlyA.dried)).toBe(true);
    c.redo();
    await c.colorSchemeViewReady();
    expect(targets).not.toHaveBeenCalled();
    expect(dried(c).equals((await fresh([...a, ...b], 'dark')).dried)).toBe(true);
    // The document stays as it was painted.
    c.setColorScheme('light');
    expect(saved(c)).toBe(json);
    c.dispose();
  }, 60000);

  it('lets the wet snapshot of a checkpoint over the memory budget go (#855)', async () => {
    const steps: Step[] = [{ kind: 'stroke', y: 40, color: BLUE, seed: 1 }, { kind: 'wait', steps: 6 }, { kind: 'stroke', y: 70, color: RED, seed: 2 }, { kind: 'wait', steps: 4 }];
    type Cp = { cp: { wet: unknown; lost?: boolean } };
    const checkpoints = (c: PaintEditorController): Cp[] => (c as unknown as { schemeReplay: { checkpoints: Cp[] } }).schemeReplay.checkpoints;
    // Enough memory: every checkpoint keeps its snapshot.
    const roomy = editor();
    await roomy.wetReady();
    await paint(roomy, steps);
    roomy.setColorScheme('dark');
    await roomy.colorSchemeViewReady();
    const kept = checkpoints(roomy).filter((x) => x.cp.wet);
    expect(kept.length).toBeGreaterThan(0);
    expect(checkpoints(roomy).some((x) => x.cp.lost)).toBe(false);
    roomy.dispose();
    // No memory: every checkpoint with a snapshot is lost, and holds none.
    const tight = new PaintEditorController({ width: W, height: H, paper: 'cold-pressed', wet: { kernel: 'wasm', threads: 0, undoMemory: 1 } });
    await tight.wetReady();
    await paint(tight, steps);
    tight.setColorScheme('dark');
    await tight.colorSchemeViewReady();
    const lost = checkpoints(tight).filter((x) => x.cp.lost);
    expect(lost.length).toBe(kept.length);
    for (const x of lost) expect(x.cp.wet).toBeNull();
    // The view itself is the same either way.
    expect(dried(tight).equals((await fresh(steps, 'dark')).dried)).toBe(true);
    tight.dispose();
  }, 60000);

  it('works for loaded documents, and saves the same file in either scheme', async () => {
    const steps: Step[] = [{ kind: 'live', y: 40, color: BLUE, seed: 7 }, { kind: 'wait', steps: 5 }, { kind: 'stroke', y: 60, color: RED, seed: 8 }];
    const c = editor();
    await c.wetReady();
    await paint(c, steps);
    const json = c.toJSON();
    const d = editor('dark');
    d.loadJSON(json);
    await d.colorSchemeViewReady();
    expect(d.colorSchemeView().layers).toMatchObject([{ view: 'replay', state: 'ready' }]);
    expect(dried(d).equals((await fresh(steps, 'dark')).dried)).toBe(true);
    expect(saved(d)).toBe(JSON.stringify(json));
    c.dispose();
    d.dispose();
  }, 60000);

  it('keeps a layer with pixels outside the stroke log in its colours, and says why', async () => {
    const c = editor();
    await c.wetReady();
    const under = c.getActiveLayer()!.id;
    c.paintStroke({ points: wave(80), brushId: 'soft-pastel', color: '#ca8a04', seed: 1 });
    const top = c.addLayer({ name: 'Wash' }).id;
    await paint(c, [{ kind: 'stroke', y: 40, color: BLUE, seed: 3 }]);
    await c.wetIdle();
    c.mergeDown(top);
    expect(c.document.unlogged).toEqual({ [under]: expect.any(String) });
    await paint(c, [{ kind: 'stroke', y: 70, color: RED, seed: 4 }]);
    await c.dryPaint();
    const light = pixels(c);
    c.setColorScheme('dark');
    const view = await c.colorSchemeViewReady();
    expect(view.replay.state).toBe('none');
    expect(view.layers).toEqual([{ layerId: under, name: expect.any(String), view: 'kept', reason: expect.stringMatching(/stroke log doesn't have .*keeps the side/) }]);
    expect(pixels(c).equals(light)).toBe(true);
    // Saved with the document (it holds dual-colour strokes), so a loaded copy knows too.
    const d = editor('dark');
    d.loadJSON(c.toJSON());
    expect(d.colorSchemeView().layers[0]).toMatchObject({ view: 'kept' });
    // Clearing the layer makes it replayable again.
    c.clearLayer(under);
    expect(c.document.unlogged).toBeUndefined();
    c.dispose();
    d.dispose();
  }, 60000);

  it('never recolours plain colours', async () => {
    const steps: Step[] = [{ kind: 'stroke', y: 40, color: '#1d4ed8', seed: 3 }];
    const c = editor();
    await c.wetReady();
    await paint(c, steps);
    const light = pixels(c);
    c.setColorScheme('dark');
    const view = await c.colorSchemeViewReady();
    expect(view).toEqual({ scheme: 'dark', replay: { state: 'none', items: 0, total: 0, error: null }, layers: [] });
    expect(pixels(c).equals(light)).toBe(true);
    c.dispose();
  }, 60000);
});

describe('get_color_scheme_view', () => {
  it('reports each layer with dual-colour paint, and waits for the replay', async () => {
    const c = editor();
    await c.wetReady();
    await paint(c, [{ kind: 'stroke', y: 40, color: BLUE, seed: 3 }]);
    c.setColorScheme('dark');
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));
    const call = async (args: unknown) => {
      const r = await reg.callTool('get_color_scheme_view', args as Record<string, unknown>);
      const text = r.content.find((x: { type: string }) => x.type === 'text')!.text!;
      return { isError: r.isError, text, value: r.isError ? null : JSON.parse(text) };
    };
    const first = await call({});
    expect(first.value).toMatchObject({ scheme: 'dark', replay: { state: 'building' }, layers: [{ view: 'replay', state: 'building' }] });
    const r = await call({ wait: true });
    expect(r.isError).toBeFalsy();
    expect(r.value).toMatchObject({ scheme: 'dark', replay: { state: 'ready', error: null }, layers: [{ layerId: c.getActiveLayer()!.id, view: 'replay', state: 'ready' }] });
    expect(r.value.replay.items).toBe(r.value.replay.total);
    expect((await call({})).value.replay.state).toBe('ready');
    const bad = await call({ wait: 'yes' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/wait/);
    const extra = await call({ scheme: 'dark' });
    expect(extra.isError).toBe(true);
    expect(extra.text).toMatch(/scheme/);
    c.dispose();
  }, 60000);
});
