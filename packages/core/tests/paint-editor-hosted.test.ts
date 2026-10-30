// The paint tool provider driving a document hosted as a layer on a larger canvas: a lazy
// controller, an origin that maps every position in and out, excluded tools and onChange.
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { readPixel } from '../src/raster/surface';
import { PaintEditorController, createPaintEditorToolProvider, type PaintAgentCommand, type PaintDirector, type PaintPixelLayer } from '../src/paint-editor';
import { fromDocument, toDocument } from '../src/paint-editor/hosted';

const ok = (res: { isError?: boolean; structuredContent?: unknown; content: unknown[] }) => {
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as any;
};
const origin = { x: -2000, y: -2000 };
const hosted = (options: Parameters<typeof createPaintEditorToolProvider>[1] = {}) => {
  const c = new PaintEditorController({ width: 4000, height: 4000 });
  const r = new ToolRegistry();
  r.register(createPaintEditorToolProvider(c, { origin, ...options }));
  return { c, r };
};
const dot = (x: number, y: number) => [{ x: x - 4, y }, { x, y }, { x: x + 4, y }];

describe('hosted paint layer tools', () => {
  it('creates the controller only when a tool first runs', async () => {
    let calls = 0;
    let c: PaintEditorController | undefined;
    const r = new ToolRegistry();
    r.register(createPaintEditorToolProvider(() => (calls++, (c ??= new PaintEditorController({ width: 64, height: 64 })))));
    expect(r.listTools().tools.length).toBeGreaterThan(10);
    expect(calls).toBe(0);
    const info = ok(await r.callTool('get_canvas_info', {}));
    expect(info.width).toBe(64);
    expect(calls).toBeGreaterThan(0);
  });

  it('paints at host coordinates and answers in them', async () => {
    const { c, r } = hosted();
    const stroke = ok(await r.callTool('paint_stroke', { points: dot(0, 0), brushId: 'airbrush', color: '#ff0000', brush: { tip: { size: 20, hardness: 1 } } }));
    // Host (0, 0) is document (2000, 2000).
    expect(c.getStrokes()[0].points[1]).toMatchObject({ x: 2000, y: 2000 });
    const layer = c.getLayer(stroke.layerId) as PaintPixelLayer;
    expect(readPixel(layer.surface, 2000, 2000)[3]).toBeGreaterThan(0);
    expect(readPixel(layer.surface, 0, 0)[3]).toBe(0);
    // The bounds come back around host (0, 0).
    expect(stroke.bounds.x).toBeLessThanOrEqual(0);
    expect(stroke.bounds.y).toBeLessThanOrEqual(0);
    expect(stroke.bounds.x + stroke.bounds.width).toBeGreaterThan(0);
    expect(stroke.bounds.x).toBeGreaterThan(-40);

    const listed = ok(await r.callTool('list_strokes', { ids: [stroke.strokeId] }));
    expect(listed.strokes[0].points[1]).toMatchObject({ x: 0, y: 0 });
    expect(listed.strokes[0].bounds.x).toBeLessThan(0);
    const layers = ok(await r.callTool('list_layers', {}));
    const painted = layers.layers.find((l: any) => l.id === stroke.layerId).bounds;
    expect(painted.x).toBeLessThan(0);
    expect(painted.x + painted.width).toBeGreaterThan(0);

    const info = ok(await r.callTool('get_canvas_info', {}));
    expect(info.bounds).toEqual({ x: -2000, y: -2000, width: 4000, height: 4000 });
    expect(ok(await r.callTool('pick_color', { x: 0, y: 0, layerId: stroke.layerId })).alpha).toBeGreaterThan(0);
  });

  it('maps guides and stencils both ways without touching editor state', async () => {
    const { c, r } = hosted();
    const sym = ok(await r.callTool('set_symmetry', { mode: 'vertical', center: { x: 10, y: 20 } }));
    expect(sym.center).toEqual({ x: 10, y: 20 });
    expect(c.getState().guides.symmetry.center).toEqual({ x: 2010, y: 2020 });
    const stencil = ok(await r.callTool('add_stencil', { kind: 'ruler', from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }));
    expect(stencil.from).toEqual({ x: 0, y: 0 });
    expect(c.getState().guides.stencils[0].from).toEqual({ x: 2000, y: 2000 });
    const guides = ok(await r.callTool('get_guides', {}));
    expect(guides.symmetry.center).toEqual({ x: 10, y: 20 });
    expect(guides.stencils[0].to).toEqual({ x: 100, y: 0 });
  });

  it('says canvas coordinates in its descriptions', () => {
    const { r } = hosted();
    const tools = r.listTools().tools;
    const stroke = tools.find((t) => t.name.endsWith('paint_stroke'))!;
    expect(stroke.description).toContain('canvas coordinates');
    expect(JSON.stringify(stroke.inputSchema)).not.toMatch(/document pixels|Document x/);
    expect(JSON.stringify(stroke.inputSchema)).toContain('Canvas x');
  });

  it('hands the director document pixels', async () => {
    const commands: PaintAgentCommand[] = [];
    const c = new PaintEditorController({ width: 4000, height: 4000 });
    const director = {
      perform: async (_actor: unknown, cmds: readonly PaintAgentCommand[]) => {
        commands.push(...cmds);
        return cmds.map((command) => ({ ok: true as const, command, result: command.kind === 'stroke' ? c.paintStroke(command.stroke) : undefined }));
      },
    } as unknown as PaintDirector;
    const r = new ToolRegistry();
    r.register(createPaintEditorToolProvider(c, { origin, director }));
    const res = ok(await r.callTool('paint_stroke', { points: dot(5, 5) }));
    const sent = commands[0] as Extract<PaintAgentCommand, { kind: 'stroke' }>;
    expect(sent.stroke.points[1]).toMatchObject({ x: 2005, y: 2005 });
    expect(res.bounds.x).toBeLessThan(5);
  });

  it('leaves excluded tools out', () => {
    const { r } = hosted({ exclude: ['new_canvas', 'export_psd', 'set_view'] });
    const names = r.listTools().tools.map((t) => t.name.split('__').pop());
    expect(names).not.toContain('new_canvas');
    expect(names).not.toContain('export_psd');
    expect(names).not.toContain('set_view');
    expect(names).toContain('paint_stroke');
  });

  it('calls onChange after each successful write only', async () => {
    const changes: string[] = [];
    const { r } = hosted({ onChange: ({ tool }) => changes.push(tool) });
    ok(await r.callTool('get_canvas_info', {}));
    ok(await r.callTool('paint_stroke', { points: dot(0, 0) }));
    ok(await r.callTool('set_color', { color: '#336699' }));
    expect((await r.callTool('remove_layer', { layerId: 'nope' })).isError).toBe(true);
    expect(changes).toEqual(['paint_stroke', 'set_color']);
  });

  it('round-trips positions through the mapping', () => {
    const args = { points: [{ x: 1, y: 2, pressure: 0.5 }], rect: null, other: { x: 9 } };
    const doc = toDocument(args, ['points[]', 'rect', 'missing.x'], origin);
    expect(doc.points[0]).toEqual({ x: 2001, y: 2002, pressure: 0.5 });
    expect(args.points[0].x).toBe(1);
    expect(fromDocument(doc, ['points[]'], origin)).toEqual(args);
  });
});
