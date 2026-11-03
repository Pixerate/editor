import { describe, expect, it } from 'vitest';
import { PaintEditorController, createPaintChangeFeed, createPaintProposals, type PaintChange, type PaintCommitEvent } from '../src/paint-editor';
import { createOriginMiddleware } from '../src/tools/origin';
import { ToolRegistry } from '../src/tools/registry';

const line = (y: number, n = 20, x0 = 20, x1 = 200) => Array.from({ length: n }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / (n - 1), y, pressure: 0.7 }));
const editor = () => new PaintEditorController({ width: 240, height: 160, paper: 'cold-pressed', wet: { kernel: 'wasm', threads: 0 } });

describe('paint history origin and grouping', () => {
  it('records who made each step and reports commits', () => {
    const c = editor();
    const heard: PaintCommitEvent[] = [];
    c.onCommit((e) => heard.push(e));
    c.paintStroke({ points: line(40), brushId: 'soft-pastel', color: '#c0392b' });
    c.withOrigin('agent:pixie', () => c.paintStroke({ points: line(80), brushId: 'soft-pastel' }));
    c.undo();
    c.redo();
    expect(heard.map((e) => [e.kind, e.label, e.origin])).toEqual([
      ['execute', 'Soft pastel stroke', 'user'],
      ['execute', 'Soft pastel stroke', 'agent:pixie'],
      ['undo', 'Soft pastel stroke', 'user'],
      ['redo', 'Soft pastel stroke', 'user'],
    ]);
    expect(c.getOrigin()).toBe('user');
  });

  it('keeps an origin until a promise settles, and works as the origin middleware target', async () => {
    const c = editor();
    let release!: () => void;
    const done = c.withOrigin('agent:pixie', () => new Promise<void>((r) => (release = r)));
    expect(c.getOrigin()).toBe('agent:pixie');
    release();
    await done;
    expect(c.getOrigin()).toBe('user');
    const registry = new ToolRegistry();
    registry.register({ id: 'paint', tools: [{ name: 'stroke', title: 'Stroke', description: 'Paints.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { title: 'Stroke', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, handler: () => c.paintStroke({ points: line(60), brushId: 'soft-pastel' }) }] });
    registry.use(createOriginMiddleware({ histories: c }));
    const heard: string[] = [];
    c.onCommit((e) => heard.push(e.origin));
    await registry.callTool('paint__stroke', {}, { actor: { id: 'pixie' } } as never);
    expect(heard).toEqual(['agent:pixie']);
  });

  it('groups several changes into one undo step, and puts them back when the group throws', () => {
    const c = editor();
    const heard: PaintCommitEvent[] = [];
    c.onCommit((e) => heard.push(e));
    c.group('Sky', () => {
      const layer = c.addLayer({ name: 'Sky' });
      c.fillLayer({ layerId: layer.id, color: '#88aadd', opacity: 0.4 });
      c.paintStroke({ layerId: layer.id, points: line(30), brushId: 'soft-pastel' });
    });
    expect(c.historyLabels().undo).toEqual(['Sky']);
    expect(heard.map((e) => e.label)).toEqual(['Sky']);
    expect(c.listLayers().map((l) => l.name)).toContain('Sky');
    c.undo();
    expect(c.listLayers().map((l) => l.name)).not.toContain('Sky');
    expect(c.getStrokes()).toEqual([]);
    const before = c.document;
    expect(() =>
      c.group('Broken', () => {
        c.addLayer({ name: 'Half' });
        throw new Error('stop');
      })
    ).toThrow('stop');
    expect(c.document).toBe(before);
    expect(c.historyLabels().undo).toEqual([]);
  });
});

describe('previewPaint', () => {
  it('returns the new paint and the picture with it, and changes nothing', () => {
    const c = editor();
    c.paintStroke({ points: line(40), brushId: 'soft-pastel', color: '#c0392b' });
    const doc = c.document;
    const state = c.getState();
    let emitted = 0;
    c.subscribe(() => emitted++);
    const preview = c.previewPaint((layerId) => c.paintStroke({ layerId, points: line(100), brushId: 'soft-pastel', color: '#1f6feb' }));
    expect(preview.bounds).not.toBeNull();
    expect(preview.bounds!.y).toBeGreaterThan(70);
    expect(preview.pixels.length).toBe(preview.bounds!.width * preview.bounds!.height * 4);
    expect(preview.composite.length).toBe(preview.pixels.length);
    expect(c.document).toBe(doc);
    expect(c.getStrokes()).toHaveLength(1);
    expect(c.historyLabels().undo).toEqual(['Soft pastel stroke']);
    expect(c.getState().document).toBe(state.document);
    expect(emitted).toBe(0);
  });

  it('reports nothing painted, and refuses wet paint', () => {
    const c = editor();
    expect(c.previewPaint(() => {})).toMatchObject({ bounds: null });
    expect(() => c.previewPaint((layerId) => c.paintStroke({ layerId, points: line(60), brushId: 'watercolor-round' }))).toThrow(/Wet paint can't be previewed/);
    expect(c.getStrokes()).toEqual([]);
    expect(c.historyLabels().undo).toEqual([]);
  });
});

describe('createPaintChangeFeed', () => {
  it('reports strokes, fills and layers with who made them, and the start and end of a stroke', () => {
    const c = editor();
    const feed = createPaintChangeFeed(c, { now: () => 7 });
    const heard: PaintChange[] = [];
    feed.subscribe((ch) => heard.push(ch));
    const session = c.beginStroke({ brushId: 'soft-pastel' });
    session.push([{ x: 20, y: 20, pressure: 0.5 }]);
    expect(heard.at(-1)).toMatchObject({ inGesture: true, gestureStarted: true, addedStrokes: [] });
    session.push(line(20).slice(1));
    session.end();
    expect(heard.at(-1)).toMatchObject({ origin: 'user', inGesture: false, gestureEnded: true, commit: { kind: 'execute' } });
    expect(heard.at(-1)!.addedStrokes).toHaveLength(1);
    c.withOrigin('agent:pixie', () => c.fillLayer({ color: '#eeddcc', opacity: 0.3 }));
    expect(heard.at(-1)).toMatchObject({ origin: 'agent:pixie', events: [{ kind: 'fill' }] });
    const layer = c.addLayer({ name: 'Trees' });
    expect(heard.at(-1)!.addedLayers).toEqual([{ id: layer.id, name: 'Trees' }]);
    c.undo();
    expect(heard.at(-1)!.removedLayers).toEqual([{ id: layer.id, name: 'Trees' }]);
    const count = heard.length;
    feed.dispose();
    c.addLayer({ name: 'After' });
    expect(heard).toHaveLength(count);
  });
});

describe('createPaintProposals', () => {
  it('previews a suggestion as a ghost and paints it as one step by the proposer on its own layer', () => {
    const c = editor();
    c.paintStroke({ points: line(40), brushId: 'soft-pastel', color: '#2e7d32' });
    const userLayer = c.getState().document.activeLayerId;
    const stroke = c.getStrokes()[0]!;
    const store = createPaintProposals({ controller: c, origin: 'agent:pixie', idGenerator: () => 'p1' });
    const heard: PaintCommitEvent[] = [];
    c.onCommit((e) => heard.push(e));
    const p = store.propose({ title: 'Echo the grass', rationale: 'Repeats your stroke lower down.', ops: [{ kind: 'echo', strokeIds: [stroke.id], dy: 30, repeat: 2 }] });
    expect(p).toMatchObject({ id: 'p1', origin: 'agent:pixie', anchors: [stroke.id], placement: { place: 'top' } });
    // The echoes start 30 px below the stroke at y 40 (the pastel is wide, so its edge sits higher).
    expect(p.bounds!.y).toBeGreaterThan(40);
    expect(p.ghost.length).toBe(p.bounds!.width * p.bounds!.height * 4);
    expect(heard).toEqual([]);
    expect(c.getStrokes()).toHaveLength(1);
    const feed = createPaintChangeFeed(c);
    const changes: PaintChange[] = [];
    feed.subscribe((ch) => changes.push(ch));
    const result = store.accept('p1');
    // One change, all of it the proposer's: the new layer and both strokes.
    expect(changes.map((ch) => [ch.origin, ch.addedLayers.length, ch.addedStrokes.length])).toEqual([['agent:pixie', 1, 2]]);
    expect(result).toMatchObject({ proposalId: 'p1', label: 'Echo the grass' });
    expect(result.strokeIds).toHaveLength(2);
    expect(heard.map((e) => [e.label, e.origin])).toEqual([['Echo the grass', 'agent:pixie']]);
    expect(c.listLayers().find((l) => l.id === result.layerId)?.name).toBe('Echo the grass');
    expect(c.getState().document.activeLayerId).toBe(userLayer);
    expect(store.getState().proposals).toEqual([]);
    c.undo();
    expect(c.getStrokes()).toHaveLength(1);
  });

  it('puts a wash at the bottom, and paints strokes with a dry brush', () => {
    const c = editor();
    c.paintStroke({ points: line(40), brushId: 'soft-pastel' });
    const store = createPaintProposals({ controller: c });
    const wash = store.propose({ title: 'Warm ground', place: 'bottom', layerName: 'Ground', ops: [{ kind: 'wash', color: '#e8c9a0' }] });
    expect(wash.bounds).toEqual({ x: 0, y: 0, width: 240, height: 160 });
    const { layerId } = store.accept(wash.id);
    expect(c.listLayers().at(-1)).toMatchObject({ id: layerId, name: 'Ground' });
    const stroke = store.propose({ title: 'Horizon', place: 'above', layerId, ops: [{ kind: 'stroke', points: line(120), brushId: 'soft-pastel', color: '#335577', size: 6 }] });
    expect(stroke.origin).toBe('agent:anonymous');
    expect(store.accept(stroke.id).strokeIds).toHaveLength(1);
  });

  it('refuses, changing nothing, what it cannot paint, and says how to fix it', () => {
    const c = editor();
    c.paintStroke({ points: line(40), brushId: 'soft-pastel' });
    const store = createPaintProposals({ controller: c, maxPoints: 30 });
    const fail = (input: Parameters<typeof store.propose>[0]) => {
      try {
        store.propose(input);
      } catch (e) {
        return (e as Error).message;
      }
      return 'no error';
    };
    expect(fail({ title: '', ops: [] })).toBe('A proposal needs a title: what it adds, in a few words.');
    expect(fail({ title: 'x', ops: [] })).toBe('A proposal needs at least one op (stroke, wash or echo).');
    expect(fail({ title: 'x', ops: [{ kind: 'stroke', points: line(80), brushId: 'watercolor-round' }] })).toMatch(/^ops\[0\]: The .* brush \(wet\) can't paint a suggestion/);
    expect(fail({ title: 'x', ops: [{ kind: 'stroke', points: line(80), brushId: 'nope' }] })).toBe('ops[0]: unknown brush "nope". Call list_brush_presets for the ids.');
    expect(fail({ title: 'x', ops: [{ kind: 'echo', strokeIds: ['s-404'] }] })).toBe('ops[0]: unknown stroke "s-404". Call list_strokes for the ids.');
    expect(fail({ title: 'x', ops: [{ kind: 'wash', color: 'blue' }] })).toBe('ops[0]: a wash needs color as #rrggbb.');
    expect(fail({ title: 'x', place: 'above', ops: [{ kind: 'wash', color: '#ffffff' }] })).toMatch(/^place "above" needs layerId/);
    expect(fail({ title: 'x', ops: [{ kind: 'stroke', points: line(80, 40) }] })).toBe('The proposal paints 40 points; the most is 30. Suggest less, or echo fewer strokes.');
    expect(store.getState().proposals).toEqual([]);
    expect(c.getStrokes()).toHaveLength(1);
  });

  it('will not accept an echo of strokes since removed, and clears by origin', () => {
    const c = editor();
    c.paintStroke({ points: line(40), brushId: 'soft-pastel' });
    const store = createPaintProposals({ controller: c, origin: 'agent:pixie' });
    const p = store.propose({ title: 'Echo', ops: [{ kind: 'echo', strokeIds: [c.getStrokes()[0]!.id], dy: 40 }] });
    c.undo();
    expect(store.missing(p.id)).toHaveLength(1);
    expect(() => store.accept(p.id)).toThrow(/echoes strokes that are no longer on the canvas/);
    store.propose({ title: 'Wash', origin: 'agent:other', ops: [{ kind: 'wash', color: '#ffeedd' }] });
    expect(store.clear('agent:pixie')).toEqual([p.id]);
    expect(store.getState().proposals.map((x) => x.origin)).toEqual(['agent:other']);
    expect(() => store.reject('gone')).toThrow('No pending paint proposal "gone". Call list_paint_proposals for the ids.');
  });
});
