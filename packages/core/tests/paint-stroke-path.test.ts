import { describe, expect, it } from 'vitest';
import { PaintEditorController, createPaintEditorToolProvider, samplePath } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools';

const tools = (c: PaintEditorController, options: Parameters<typeof createPaintEditorToolProvider>[1] = {}) => {
  const registry = new ToolRegistry();
  registry.register(createPaintEditorToolProvider(c, options));
  return async (name: string, args: Record<string, unknown>) => {
    const r = await registry.callTool(name, args);
    return { isError: !!r.isError, text: r.content?.map((x: any) => x.text).join('') ?? '', result: r.structuredContent as any };
  };
};

describe('samplePath', () => {
  it('samples each subpath evenly, closes closed ones and spreads a pressure profile', () => {
    const [line, square] = samplePath('M 0 0 L 100 0 M 10 10 h 20 v 20 h -20 Z', { spacing: 10, pressure: [0, 1] });
    expect(line.length).toBe(11);
    expect(line[5]).toEqual({ x: 50, y: 0, pressure: 0.5 });
    expect(line.at(-1)).toEqual({ x: 100, y: 0, pressure: 1 });
    expect(square[0]).toMatchObject({ x: 10, y: 10 });
    expect(square.at(-1)).toMatchObject({ x: 10, y: 10 });
    expect(square.length).toBe(9);
    const curve = samplePath('M 0 0 C 0 100 100 100 100 0')[0];
    expect(Math.max(...curve.map((p) => p.y))).toBeCloseTo(75, 0);
    expect(curve.every((p) => p.pressure === undefined)).toBe(true);
    const timed = samplePath('M 0 0 L 100 0', { spacing: 25, speed: 2 })[0];
    expect(timed.map((p) => p.t)).toEqual([0, 12.5, 25, 37.5, 50]);
  });

  it('refuses paths with nothing to brush and bad options, saying what to give', () => {
    expect(() => samplePath('M 10 10')).toThrow(/no segments to brush/);
    expect(() => samplePath('M 0 0 L 10 0', { spacing: 0 })).toThrow(/spacing 0 is out of range/);
    expect(() => samplePath('M 0 0 L 10 0', { pressure: [2] })).toThrow(/pressure needs/);
    expect(() => samplePath('M 0 0 L 10 0', { speed: 0 })).toThrow(/speed 0 is out of range/);
    expect(() => samplePath('M 0 0 L 100000 0', { spacing: 1 })).toThrow(/too many samples/);
  });
});

describe('stroke_path', () => {
  it('brushes every subpath with the active brush as recorded strokes, in one undo step', async () => {
    const c = new PaintEditorController({ width: 200, height: 120 });
    const call = tools(c);
    expect((await call('set_brush', { id: 'ink-pen' })).isError).toBe(false);
    const r = await call('stroke_path', { path: 'M 20 20 C 60 0 140 0 180 20 M 20 90 L 180 90', pressure: [0.2, 1, 0.2], color: '#1d4ed8', seed: 5 });
    expect(r.isError, r.text).toBe(false);
    expect(r.result).toMatchObject({ layerId: c.getState().document.activeLayerId, dabs: expect.any(Number), strokeIds: [expect.any(String), expect.any(String)] });
    expect(r.result.bounds.width).toBeGreaterThan(150);
    const strokes = c.getStrokes();
    expect(strokes.map((s) => s.brush.id)).toEqual(['ink-pen', 'ink-pen']);
    expect(strokes.map((s) => s.seed)).toEqual([5, 6]);
    expect(strokes[1].color).toBe('#1d4ed8');
    expect(strokes[1].points[0].pressure).toBeCloseTo(0.2, 2);
    expect(strokes[1].points[Math.floor(strokes[1].points.length / 2)].pressure).toBeGreaterThan(0.9);
    expect(c.pickColor(100, 90, { paper: false } as never)?.color).toBe('#1d4ed8');
    expect(c.getState().undoLabel).toMatch(/path stroke/);
    c.undo();
    expect(c.getStrokes().length).toBe(0);
    expect(c.pickColor(100, 90, { paper: false } as never)?.color ?? null).not.toBe('#1d4ed8');
  });

  it('paints the same marks for the same seed and path, and with another brush when asked', async () => {
    const a = new PaintEditorController({ width: 120, height: 60 });
    const b = new PaintEditorController({ width: 120, height: 60 });
    for (const c of [a, b]) await tools(c)('stroke_path', { path: 'M 10 30 Q 60 0 110 30', brushId: 'soft-pastel', seed: 3 });
    expect(a.getStrokes()[0].points).toEqual(b.getStrokes()[0].points);
    expect(a.getStrokes()[0].brush.id).toBe('soft-pastel');
    expect(a.getState().brush.id).not.toBe('soft-pastel');
  });

  it('refuses bad input with useful errors and paints nothing', async () => {
    const c = new PaintEditorController({ width: 64, height: 64 });
    const call = tools(c);
    expect((await call('stroke_path', { path: 'M 5 5' })).text).toContain('no segments to brush');
    expect((await call('stroke_path', { path: 'M 0 0 L 10 10', layerId: 'nope' })).isError).toBe(true);
    expect((await call('stroke_path', { path: 'M 0 0 L 10 10', spacing: 0 })).isError).toBe(true);
    expect((await call('stroke_path', { path: 'M 0 0 L 10 10', pressure: [1.5] })).isError).toBe(true);
    expect((await call('stroke_path', { path: 'M 0 0 L 10 10', brushId: 'no-such-brush' })).isError).toBe(true);
    expect((await call('stroke_path', { points: [] })).isError).toBe(true);
    expect(c.getStrokes().length).toBe(0);
    expect(c.getState().canUndo).toBe(false);
  });

  it('takes canvas coordinates on a hosted layer and returns them', async () => {
    const c = new PaintEditorController({ width: 100, height: 100 });
    const r = await tools(c, { origin: { x: 300, y: 200 } })('stroke_path', { path: 'M 310 250 L 390 250', brushId: 'ink-pen' });
    expect(r.isError, r.text).toBe(false);
    expect(c.getStrokes()[0].points[0]).toMatchObject({ x: 10, y: 50 });
    expect(r.result.bounds.x).toBeGreaterThan(300);
  });

  it('sends one strokes command to the director in document pixels and undoes as one step', async () => {
    const c = new PaintEditorController({ width: 100, height: 100 });
    const commands: any[] = [];
    const director = {
      perform: async (_actor: unknown, cmds: readonly any[]) => {
        commands.push(...cmds);
        return cmds.map((command) => {
          if (command.kind !== 'strokes') return { ok: true as const, command, result: undefined };
          const results = c.group(command.label ?? 'Path stroke', () => command.strokes.map((s: any) => c.paintStroke(s)));
          return {
            ok: true as const,
            command,
            result: { layerId: results[0].layerId, dabs: 4, bounds: results[0].bounds, strokeIds: results.map((r: any) => r.strokeId) },
          };
        });
      },
    } as any;
    const r = await tools(c, { origin: { x: 300, y: 200 }, director })('stroke_path', {
      path: 'M 310 220 L 390 220 M 310 260 L 390 260',
      brushId: 'ink-pen',
      speed: 2,
      seed: 7,
    });
    expect(r.isError, r.text).toBe(false);
    expect(commands).toHaveLength(1);
    expect(commands[0].kind).toBe('strokes');
    expect(commands[0].strokes).toHaveLength(2);
    expect(commands[0].strokes[0].points[0]).toMatchObject({ x: 10, y: 20, t: 0 });
    expect(commands[0].strokes.map((s: any) => s.seed)).toEqual([7, 8]);
    expect(r.result.bounds.x).toBeGreaterThan(300);
    c.undo();
    expect(c.getStrokes()).toHaveLength(0);
  });
});
