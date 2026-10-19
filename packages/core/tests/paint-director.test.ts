import { describe, expect, it } from 'vitest';
import { createInstantPresenceClock } from '../src/animation/presence';
import { ToolRegistry } from '../src/tools';
import {
  PaintDirector,
  PaintEditorController,
  PaintPresence,
  createPaintEditorToolProvider,
  strokeDuration,
  strokeSchedule,
  sweepPath,
  type PenPoint,
} from '../src/paint-editor';

const line = (x0: number, y0: number, x1: number, y1: number, n = 24, extra: Partial<PenPoint> = {}): PenPoint[] =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n, ...extra }));

function setup() {
  const c = new PaintEditorController({ width: 128, height: 96, paper: 'cold-pressed' });
  const presence = new PaintPresence();
  const clock = createInstantPresenceClock();
  const director = new PaintDirector(c, presence, { clock, linger: 0 });
  return { c, presence, clock, director };
}

describe('paint director', () => {
  it('schedules points by time when they have it, else by distance', () => {
    expect(strokeSchedule([{ x: 0, y: 0, t: 0 }, { x: 1, y: 0, t: 30 }, { x: 100, y: 0, t: 40 }])).toEqual([0, 0.75, 1]);
    expect(strokeSchedule([{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 40, y: 0 }])).toEqual([0, 0.75, 1]);
    expect(strokeDuration([{ x: 0, y: 0, t: 0 }, { x: 1, y: 0, t: 600 }])).toBe(600);
    expect(strokeDuration([{ x: 0, y: 0 }, { x: 3, y: 0 }])).toBe(250);
    expect(strokeDuration([{ x: 0, y: 0 }, { x: 30000, y: 0 }], 1000)).toBe(1000);
    const sweep = sweepPath({ x: 0, y: 0, width: 100, height: 100 }, 2);
    expect(sweep).toHaveLength(4);
    expect(sweep[1]!.x).toBeGreaterThan(sweep[0]!.x);
    expect(sweep[3]!.x).toBeLessThan(sweep[2]!.x);
  });

  it('paints a stroke live along its points with the cursor on them, as one undo step', async () => {
    const { c, presence, clock, director } = setup();
    const frames: Array<{ x: number; y: number; pressed: boolean; live: boolean }> = [];
    presence.subscribe((s) => {
      const a = s.actors[0];
      if (a) frames.push({ x: a.x, y: a.y, pressed: a.pressed, live: c.activeStroke !== null });
    });
    const undoBefore = c.historyLabels().undo.length;
    const [r] = await director.perform({ id: 'agent', name: 'Agent' }, [{ kind: 'stroke', stroke: { points: line(10, 20, 110, 70, 30, { pressure: 0.8 }), brushId: 'soft-pastel', color: '#aa3300' } }]);
    expect(r).toMatchObject({ ok: true, result: { strokeId: 's1' } });
    expect(clock.elapsed()).toBeGreaterThan(200);
    // The cursor is pressed while the stroke is live, and walks from the start to the end.
    const pressed = frames.filter((f) => f.pressed);
    expect(pressed.length).toBeGreaterThan(5);
    expect(pressed.every((f) => f.live)).toBe(true);
    expect(pressed[0]!.x).toBeLessThan(30);
    expect(pressed[pressed.length - 1]).toMatchObject({ x: 110, y: 70 });
    expect(c.activeStroke).toBeNull();
    expect(c.getStrokes()[0]!.points).toHaveLength(31);
    expect(c.historyLabels().undo.length).toBe(undoBefore + 1);
    // Same marks as painting the stroke at once with the same seed.
    const d = new PaintEditorController({ width: 128, height: 96, paper: 'cold-pressed' });
    d.paintStroke({ points: line(10, 20, 110, 70, 30, { pressure: 0.8 }), brushId: 'soft-pastel', color: '#aa3300', seed: c.getStrokes()[0]!.seed });
    expect(c.exportPng()).toEqual(d.exportPng());
  });

  it('fails before painting when the layer cannot take the stroke', async () => {
    const { c, presence, director } = setup();
    const moves: number[] = [];
    presence.subscribe((s) => moves.push(s.actors.length));
    const [r] = await director.perform({ id: 'agent' }, [{ kind: 'stroke', stroke: { layerId: 'nope', points: line(0, 0, 50, 50) } }]);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/Unknown layer "nope"/) });
    const [bad] = await director.perform({ id: 'agent' }, [{ kind: 'stroke', stroke: { points: [{ x: Number.NaN, y: 0 }] } }]);
    expect(bad).toMatchObject({ ok: false, message: expect.stringMatching(/points\[0\]/) });
    expect(c.getStrokes()).toHaveLength(0);
    expect(c.activeStroke).toBeNull();
  });

  it('refuses while the user is mid-stroke, and the user can paint after the agent', async () => {
    const { c, director } = setup();
    const user = c.beginStroke();
    const [r] = await director.perform({ id: 'agent' }, [{ kind: 'stroke', stroke: { points: line(0, 0, 50, 50) } }]);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/stroke is in progress/) });
    user.cancel();
    const [again] = await director.perform({ id: 'agent' }, [{ kind: 'stroke', stroke: { points: line(0, 0, 50, 50) } }]);
    expect(again!.ok).toBe(true);
    expect(() => c.beginStroke().cancel()).not.toThrow();
  });

  it('rubs a fill across the sheet and starts a replay from the strokes it copies', async () => {
    const { c, presence, director } = setup();
    const pressedXs: number[] = [];
    presence.subscribe((s) => {
      const a = s.actors[0];
      if (a?.pressed) pressedXs.push(a.x);
    });
    const [fill] = await director.perform({ id: 'agent' }, [{ kind: 'fill', fill: { color: '#336699' }, note: 'Ground colour' }]);
    expect(fill).toMatchObject({ ok: true, result: { bounds: { x: 0, y: 0, width: 128, height: 96 } } });
    expect(Math.max(...pressedXs) - Math.min(...pressedXs)).toBeGreaterThan(80);
    c.paintStroke({ points: line(10, 10, 40, 10) });
    const [replay] = await director.perform({ id: 'agent' }, [{ kind: 'replay', replay: { strokeIds: ['s1'], dy: 40 } }]);
    expect(replay).toMatchObject({ ok: true, result: { strokeIds: ['s2'] } });
    const [unknown] = await director.perform({ id: 'agent' }, [{ kind: 'replay', replay: { strokeIds: ['zz'] } }]);
    expect(unknown!.ok).toBe(false);
  });

  it('hides the cursor after linger', async () => {
    const c = new PaintEditorController({ width: 64, height: 64 });
    const presence = new PaintPresence();
    const director = new PaintDirector(c, presence, { clock: createInstantPresenceClock(), linger: 300 });
    await director.perform({ id: 'agent' }, [{ kind: 'point', at: { x: 10, y: 10 }, note: 'Here' }]);
    expect(presence.getState().actors).toEqual([]);
  });
});

describe('paint tools with a director', () => {
  const setupTools = () => {
    const { c, presence, director } = setup();
    const r = new ToolRegistry();
    r.register(createPaintEditorToolProvider(c, { director, actor: { id: 'bot', name: 'Bot' } }));
    const seen = new Set<string>();
    presence.subscribe((s) => s.actors.forEach((a) => seen.add(a.name)));
    return { c, r, seen };
  };

  it('acts out paint_stroke, fill_layer and replay_strokes with the given actor', async () => {
    const { c, r, seen } = setupTools();
    const fill = await r.callTool('fill_layer', { color: '#ffeecc' });
    expect(fill.isError).toBeFalsy();
    const stroke = await r.callTool('paint_stroke', { points: line(10, 10, 100, 80, 20, { pressure: 0.8 }), brushId: 'soft-pastel', color: '#aa3300' });
    expect(stroke.isError).toBeFalsy();
    expect(stroke.structuredContent).toMatchObject({ strokeId: 's1', layerId: c.document.activeLayerId });
    const replay = await r.callTool('replay_strokes', { strokeIds: ['s1'], dx: 5, repeat: 2 });
    expect(replay.structuredContent).toMatchObject({ strokeIds: ['s2', 's3'] });
    expect(seen.has('Bot')).toBe(true);
    expect(c.historyLabels().undo.slice(-3)).toEqual(['Fill layer', 'Soft pastel stroke', 'Replay strokes']);
  });

  it('turns director failures into tool errors that say what to fix', async () => {
    const { c, r } = setupTools();
    const res = await r.callTool('paint_stroke', { layerId: 'missing', points: [{ x: 1, y: 1 }] });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/Unknown layer "missing". Call list_layers/);
    const replay = await r.callTool('replay_strokes', { strokeIds: ['nope'] });
    expect(replay.isError).toBe(true);
    expect(c.getStrokes()).toHaveLength(0);
  });
});
