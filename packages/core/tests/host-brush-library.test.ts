import { describe, expect, it } from 'vitest';
import { BRUSH_PRESETS, CANVAS_PROFILE, createBrushLibrary, createBrushLibraryToolProvider, IMAGE_PROFILE, VECTOR_PROFILE, type Brush } from '../src/brushes';
import { listCanvasBrushes, renderCanvasBrushPreview, renderShapeBrushstroke, resolveCanvasBrushSpec } from '../src/canvas/brushstroke';
import { createCanvasDrawController } from '../src/canvas/drawController';
import { CommandRegistry, createCommandToolProvider, createDrawCommands } from '../src/commands';
import { HistoryManager } from '../src/history';
import { createImageEditorToolProvider, ImageEditorController } from '../src/image-editor';
import { PaintEditorController } from '../src/paint-editor';
import { base64ToBytes, decodePng } from '../src/raster/png';
import { ToolRegistry } from '../src/tools';
import { VectorEditorController, type VectorPathNode } from '../src/vector';
import { createVectorCommands } from '../src/vector/commands';

const preset = (id: string) => BRUSH_PRESETS.find((b) => b.id === id)!;
/** A saved brush: the HB pencil, thicker and in its own colour. */
const myPencil: Brush = { ...preset('pencil-hb'), id: 'my-pencil', name: 'My pencil', tip: { ...preset('pencil-hb').tip, size: 9 } };
const myWash: Brush = { ...preset('watercolor-wash'), id: 'my-wash', name: 'My wash' };

const canvas = (library?: ReturnType<typeof createBrushLibrary>) => {
	let nodes: unknown[] = [];
	const draw = createCanvasDrawController({ getNodes: () => nodes as never, setNodes: (next) => void (nodes = next), history: new HistoryManager({ maxDepth: 20 }), generateNodeId: () => `n${nodes.length + 1}`, ...(library ? { brushLibrary: library } : {}) });
	return { draw, nodes: () => nodes as Array<{ id: string; data: { shape: Parameters<typeof renderShapeBrushstroke>[0] } }> };
};

describe('canvas strokes on a brush library', () => {
	it('lists the presets the canvas profile admits, then the saved brushes it admits', async () => {
		const library = createBrushLibrary();
		await library.save(myPencil);
		await library.save(myWash);
		const list = await listCanvasBrushes(library);
		expect(list.at(-1)).toMatchObject({ id: 'my-pencil', name: 'My pencil', category: 'pencil', size: 9, builtin: false, spec: { id: 'my-pencil' } });
		expect(list.map((b) => b.id)).not.toContain('my-wash');
		expect(list.filter((b) => b.builtin).map((b) => b.id)).toEqual((await listCanvasBrushes()).map((b) => b.id));
	});

	it('draws with a saved brush and embeds it, so the stroke renders without the library', async () => {
		const library = createBrushLibrary();
		await library.save(myPencil);
		const { draw, nodes } = canvas(library);
		const r = await draw.drawStroke({ points: [[0, 0], [40, 10], [80, 0]], style: { brush: 'my-pencil' } });
		expect(r.brush).toMatchObject({ brush: 'my-pencil', spec: { id: 'my-pencil', tip: { size: 9 } } });
		const shape = JSON.parse(JSON.stringify(nodes()[0].data.shape));
		await library.remove('my-pencil');
		expect(await renderShapeBrushstroke(shape)).toMatchObject({ href: expect.stringMatching(/^data:image\/png/) });
		// Presets are not embedded.
		const p = await draw.drawStroke({ points: [[0, 0], [40, 10]], style: { brush: 'ink-pen' } });
		expect((p.brush as { spec?: unknown }).spec).toBeUndefined();
	});

	it('refuses brushes the canvas profile refuses, saying why and what to use', async () => {
		const library = createBrushLibrary();
		await library.save(myWash);
		const { draw } = canvas(library);
		await expect(draw.drawStroke({ points: [[0, 0], [9, 9]], style: { brush: 'my-wash' } })).rejects.toThrow(/Brush 'my-wash' \(My wash\) can't brush a canvas stroke: .*wet/);
		await expect(draw.drawStroke({ points: [[0, 0], [9, 9]], style: { brush: 'watercolor-wash' } })).rejects.toThrow(/can't brush a canvas stroke: .* Use one of: pencil-hb, /);
		await expect(draw.drawStroke({ points: [[0, 0], [9, 9]], style: { brush: 'neon-marker' } })).rejects.toThrow(/Neon marker.*light/i);
		await expect(draw.drawStroke({ points: [[0, 0], [9, 9]], style: { brush: 'pencil-h' } })).rejects.toThrow(/Unknown brush 'pencil-h'\. Closest: pencil-hb/);
		expect(await resolveCanvasBrushSpec('ink-pen', library)).toBeUndefined();
	});

	it('takes saved brushes in canvas.drawFreehand and lists them in canvas.listBrushes', async () => {
		const library = createBrushLibrary();
		await library.save(myPencil);
		const { draw } = canvas(library);
		const commands = new CommandRegistry();
		commands.register(createDrawCommands(draw));
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const listed = await tools.callTool('run_command', { id: 'canvas.listBrushes', params: {} });
		expect(JSON.stringify(listed.structuredContent)).toContain('"id":"my-pencil"');
		const drawn = await tools.callTool('run_command', { id: 'canvas.drawFreehand', params: { points: [[0, 0], [30, 20]], brush: 'my-pencil' } });
		expect(drawn.isError).toBeFalsy();
		const refused = await tools.callTool('run_command', { id: 'canvas.drawFreehand', params: { points: [[0, 0], [30, 20]], brush: 'smudge' } });
		expect(refused.isError).toBe(true);
		expect((refused.content[0] as { text: string }).text).toMatch(/can't brush a canvas stroke/);
	});

	it('previews brushes for the library tools as a canvas stroke paints them', async () => {
		const tools = new ToolRegistry();
		tools.register(createBrushLibraryToolProvider(createBrushLibrary(), { profile: CANVAS_PROFILE, renderPreview: renderCanvasBrushPreview, id: 'canvasbrushes' }));
		const r = await tools.callTool('canvasbrushes__preview_brush', { id: 'charcoal-stick', width: 120, height: 40 });
		const image = r.content[0] as { type: string; data: string };
		expect(image.type).toBe('image');
		// The PNG holds the stroke itself (its bounds), not padding to the swatch.
		expect(decodePng(base64ToBytes(image.data)).width).toBeGreaterThan(60);
		const listed = await tools.callTool('canvasbrushes__list_brush_presets', {});
		expect((listed.structuredContent as { host: string }).host).toBe('canvas');
	});
});

describe('one library shared by the paint editor and canvas', () => {
	it('draws in canvas with a brush saved in the paint editor', async () => {
		const library = createBrushLibrary();
		const paint = new PaintEditorController({ width: 64, height: 32, brushLibrary: library });
		paint.setBrushFacets({ tip: { size: 14 }, behaviour: { grain: 0.9 } }, 'charcoal-stick');
		await paint.saveBrush({ id: 'my-charcoal', name: 'My charcoal' });
		const { draw } = canvas(library);
		expect((await draw.listBrushes()).map((b) => b.id)).toContain('my-charcoal');
		const r = await draw.drawStroke({ points: [[0, 0], [50, 20]], style: { brush: 'my-charcoal' } });
		expect(r.brush).toMatchObject({ spec: { id: 'my-charcoal', name: 'My charcoal', behaviour: { grain: 0.9 } } });
		paint.dispose();
	});
});

describe('vector brushstrokes on a brush library', () => {
	const line = (): VectorPathNode => ({ id: 'a', type: 'path', subpaths: [{ closed: false, anchors: [{ x: 10, y: 50 }, { x: 190, y: 50 }] }], fill: null, stroke: '#1d4ed8', strokeWidth: 2 }) as unknown as VectorPathNode;

	it('paints with a saved brush, embeds it, and keeps it through save and load', async () => {
		const library = createBrushLibrary();
		await library.save(myPencil);
		const c = new VectorEditorController({ document: { width: 200, height: 100, nodes: [line()] }, brushLibrary: library });
		await c.whenBrushesLoaded();
		expect(c.listBrushstrokeBrushes().map((b) => b.id)).toContain('my-pencil');
		expect(c.addBrushstroke({ brushId: 'my-pencil' }, { ids: ['a'] }).ok).toBe(true);
		const layer = (c.getNode('a') as VectorPathNode).strokes!.at(-1)!;
		expect(layer.brush).toMatchObject({ brushId: 'my-pencil', spec: { id: 'my-pencil', tip: { size: 9 } } });
		// A document opened without the library still has the brush.
		const d = new VectorEditorController({ document: JSON.parse(JSON.stringify(c.getDocument())) });
		expect((d.getNode('a') as VectorPathNode).strokes!.at(-1)!.brush).toMatchObject({ brushId: 'my-pencil', spec: { id: 'my-pencil' } });
		// Another brush drops the embedded one.
		const index = (c.getNode('a') as VectorPathNode).strokes!.length - 1;
		expect(c.setBrushstroke(index, { brushId: 'marker' }, { ids: ['a'] }).ok).toBe(true);
		expect((c.getNode('a') as VectorPathNode).strokes![index].brush).toEqual({ brushId: 'marker' });
	});

	it('refuses saved brushes the vector profile refuses, and lists the vector ones through vector.listBrushes', async () => {
		const library = createBrushLibrary();
		await library.save(myWash);
		await library.save(myPencil);
		const c = new VectorEditorController({ document: { width: 200, height: 100, nodes: [line()] }, brushLibrary: library });
		await c.whenBrushesLoaded();
		expect(c.addBrushstroke({ brushId: 'my-wash' }, { ids: ['a'] })).toMatchObject({ ok: false, message: expect.stringMatching(/^Brush "my-wash" \(My wash\) can't paint a brushstroke: .*wet/) });
		const registry = new CommandRegistry();
		registry.register(createVectorCommands(c));
		const listed = (registry.execute('vector.listBrushes', {}) as { result: { brushes: Array<{ id: string; builtin: boolean }> } }).result;
		expect(listed.brushes.at(-1)).toMatchObject({ id: 'my-pencil', builtin: false });
		expect(listed.brushes.map((b) => b.id)).not.toContain('my-wash');
		expect(VECTOR_PROFILE.id).toBe('vector');
	});
});

describe('image editor brush presets', () => {
	const setup = async () => {
		const library = createBrushLibrary();
		await library.save(myPencil);
		await library.save(myWash);
		const c = new ImageEditorController({ brushLibrary: library });
		const r = new ToolRegistry();
		r.register(createImageEditorToolProvider(c));
		r.register(createBrushLibraryToolProvider(library, { profile: IMAGE_PROFILE, id: 'imagebrushes' }));
		const call = async (name: string, args: Record<string, unknown>) => {
			const res = await r.callTool(name, args);
			return { error: res.isError ? (res.content[0] as { text: string }).text : null, data: res.structuredContent as any };
		};
		return { c, call };
	};
	const toolName = async (c: ImageEditorController) => c.getState().activeTool;

	it('sets the tool, brush, mixer and paint of a preset or saved brush', async () => {
		const { c, call } = await setup();
		let r = await call('image-editor__set_brush_preset', { id: 'my-pencil' });
		expect(r.error).toBeNull();
		expect(r.data).toMatchObject({ id: 'my-pencil', tool: 'brush', brush: { size: 9 } });
		expect(r.data.warnings.join(' ')).toMatch(/grain/);
		expect(c.getState().paint).toMatchObject({ brushPreset: 'my-pencil', brush: { size: 9 } });
		expect(await toolName(c)).toBe('brush');
		r = await call('image-editor__set_brush_preset', { id: 'mixer-brush' });
		expect(r.data.tool).toBe('mixer');
		expect(c.getState().paint.mixer).toEqual(r.data.mixer);
		expect(await toolName(c)).toBe('mixer');
		r = await call('image-editor__set_brush_preset', { id: 'eraser-soft' });
		expect(await toolName(c)).toBe('eraser');
		r = await call('image-editor__set_brush_preset', { id: 'gradient-round' });
		expect(c.getState().paint.paint.type).toBe('gradient');
		// Changing the brush by hand leaves the preset.
		c.setPaintOptions({ brush: { size: 30 } });
		expect(c.getState().paint.brushPreset).toBeNull();
		expect((await call('image-editor__get_paint', {})).data.brushPreset).toBeNull();
	});

	it('refuses brushes the image editor cannot paint, and unknown ids, saying why', async () => {
		const { c, call } = await setup();
		const before = c.getState().paint;
		expect((await call('image-editor__set_brush_preset', { id: 'my-wash' })).error).toMatch(/Brush "my-wash" \(My wash\) can't paint in the image editor: .*wet/);
		expect((await call('image-editor__set_brush_preset', { id: 'hair-strands' })).error).toMatch(/particle/i);
		expect((await call('image-editor__set_brush_preset', { id: 'pencil-h' })).error).toMatch(/Unknown brush "pencil-h"\. Closest: pencil-hb/);
		expect((await call('image-editor__set_brush_preset', {})).error).toMatch(/id/);
		expect(c.getState().paint).toBe(before);
		const listed = (await call('imagebrushes__list_brush_presets', {})).data.brushes.map((b: { id: string }) => b.id);
		expect(listed).toContain('my-pencil');
		expect(listed).not.toContain('my-wash');
		expect((await c.listBrushPresets()).map((e) => e.brush.id)).toEqual(listed);
	});
});

describe('default colours in canvas and vector', () => {
	it('lists default colours, takes them when a brush is picked or drawn with, follows the colour scheme, and honours keepColour and colorLocked', async () => {
		const { draw } = canvas();
		const list = await listCanvasBrushes();
		expect(list.find((b) => b.id === 'ballpoint')!.defaultColor).toEqual({ light: '#1e3a8a', dark: '#93c5fd' });
		expect(list.find((b) => b.id === 'chalk')!.defaultColor).toEqual({ light: '#475569', dark: '#f8fafc' });
		expect(list.find((b) => b.id === 'pencil-hb')!.defaultColor).toBeUndefined();
		expect(await draw.selectBrush('ballpoint')).toMatchObject({ id: 'ballpoint' });
		expect(draw.style).toMatchObject({ brush: 'ballpoint', brushSize: 3, color: '#1e3a8a' });
		// Switching the colour scheme re-resolves a colour that came from a brush's light / dark default.
		draw.setColorScheme('dark');
		expect(draw.style.color).toBe('#93c5fd');
		await draw.selectBrush('chalk');
		expect(draw.style.color).toBe('#f8fafc');
		draw.setColorScheme('light');
		expect(draw.style.color).toBe('#475569');
		draw.setColorScheme('dark');
		expect(draw.style.color).toBe('#f8fafc');
		// Once the user picks a colour, scheme flips no longer touch it.
		draw.setStyle({ color: '#ff0000' });
		draw.setColorScheme('light');
		expect(draw.style.color).toBe('#ff0000');
		draw.setColorScheme('dark');
		await draw.selectBrush('crayon', { keepColour: true });
		expect(draw.style).toMatchObject({ brush: 'crayon', color: '#ff0000' });
		// Standing colour lock keeps the colour across brush picks and drawStroke, unless keepColour: false.
		draw.setColorLocked(true);
		expect(draw.colorLocked).toBe(true);
		await draw.selectBrush('ballpoint');
		expect(draw.style).toMatchObject({ brush: 'ballpoint', color: '#ff0000' });
		const lockedStroke = await draw.drawStroke({ points: [[0, 0], [30, 5]], style: { brush: 'gel-pen' } });
		expect((lockedStroke.node.data as { shape: { stroke: string } }).shape.stroke).toBe('#ff0000');
		await draw.selectBrush('ballpoint', { keepColour: false });
		expect(draw.style.color).toBe('#93c5fd');
		draw.setColorLocked(false);
		await draw.selectBrush('pencil-hb');
		expect(draw.style.color).toBe('#93c5fd');
		await draw.selectBrush(null);
		expect(draw.style.brush).toBeUndefined();
		await expect(draw.selectBrush('watercolor-wash')).rejects.toThrow(/can't brush a canvas stroke/);
		// Agents: a brush's default colour when no colour is given; theirs when it is.
		const r = await draw.drawStroke({ points: [[0, 0], [30, 5]], style: { brush: 'gel-pen' } });
		// The draw controller is in the dark scheme here: the gel pen's near-white side.
		expect((r.node.data as { shape: { stroke: string } }).shape.stroke).toBe('#f3f4f6');
		const own = await draw.drawStroke({ points: [[0, 0], [30, 5]], style: { brush: 'gel-pen', color: '#16a34a' } });
		expect((own.node.data as { shape: { stroke: string } }).shape.stroke).toBe('#16a34a');
	});

	it('gives a vector brushstroke its brush\'s default colour, unless one is given, kept, or locked', () => {
		const path = { id: 'a', type: 'path', subpaths: [{ closed: false, anchors: [{ x: 10, y: 50 }, { x: 190, y: 50 }] }], fill: null, stroke: '#1d4ed8', strokeWidth: 2 } as unknown as VectorPathNode;
		const c = new VectorEditorController({ document: { width: 200, height: 100, nodes: [path] }, colorScheme: 'dark' });
		const top = () => (c.getNode('a') as VectorPathNode).strokes!.at(-1)!;
		expect(c.addBrushstroke({ brushId: 'ballpoint' }, { ids: ['a'] }).ok).toBe(true);
		// The dark side of the ballpoint's light / dark default, for the dark scheme.
		expect(top().paint).toBe('#93c5fd');
		const index = (c.getNode('a') as VectorPathNode).strokes!.length - 1;
		expect(c.setBrushstroke(index, { brushId: 'chalk' }, { ids: ['a'] }).ok).toBe(true);
		expect(top().paint).toBe('#f8fafc');
		expect(c.setBrushstroke(index, { brushId: 'crayon', keepColour: true }, { ids: ['a'] }).ok).toBe(true);
		expect(top().paint).toBe('#f8fafc');
		expect(c.setBrushstroke(index, { brushId: 'pencil-hb' }, { ids: ['a'] }).ok).toBe(true);
		expect(top().paint).toBe('#f8fafc');
		expect(c.addBrushstroke({ brushId: 'fineliner' }, { ids: ['a'], keepColour: true }).ok).toBe(true);
		expect(top().paint).toBe('#1d4ed8');
		// Standing colour lock on VectorEditorController keeps the colour when adding or changing a brushstroke.
		c.setColorLocked(true);
		expect(c.getState().colorLocked).toBe(true);
		const topIdx = (c.getNode('a') as VectorPathNode).strokes!.length - 1;
		expect(c.setBrushstroke(topIdx, { brushId: 'ballpoint' }, { ids: ['a'] }).ok).toBe(true);
		expect(top().paint).toBe('#1d4ed8');
		expect(c.addBrushstroke({ brushId: 'chalk' }, { ids: ['a'] }).ok).toBe(true);
		expect(top().paint).toBe('#1d4ed8');
		expect(c.addBrushstroke({ brushId: 'chalk' }, { ids: ['a'], keepColour: false }).ok).toBe(true);
		expect(top().paint).toBe('#f8fafc');
	});

	it('lets agents lock the colour with canvas.setColorLocked and vector.setColorLocked, and pass keepColour per stroke', async () => {
		const { draw, nodes } = canvas();
		const commands = new CommandRegistry();
		commands.register(createDrawCommands(draw));
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const colourOf = async (params: Record<string, unknown>) => {
			const r = await tools.callTool('run_command', { id: 'canvas.drawFreehand', params: { points: [[0, 0], [30, 5]], ...params } });
			expect(r.isError).toBeFalsy();
			return (nodes().at(-1)!.data.shape as unknown as { stroke: string }).stroke;
		};
		draw.setStyle({ color: '#ff0000' });
		expect(await colourOf({ brush: 'ballpoint' })).toBe('#1e3a8a');
		// keepColour per stroke: the current colour instead of the ballpoint's blue.
		expect(await colourOf({ brush: 'ballpoint', keepColour: true })).toBe('#ff0000');
		const locked = await tools.callTool('run_command', { id: 'canvas.setColorLocked', params: { locked: true } });
		expect(locked.isError).toBeFalsy();
		expect(JSON.stringify(locked.structuredContent)).toContain('"colorLocked":true');
		expect(draw.colorLocked).toBe(true);
		await draw.selectBrush('ballpoint');
		expect(draw.style.color).toBe('#ff0000');
		expect(await colourOf({ brush: 'ballpoint' })).toBe('#ff0000');
		expect(await colourOf({ brush: 'ballpoint', keepColour: false })).toBe('#1e3a8a');
		// A highlighter stroke while the pen is out keeps the highlighter's own default, not the pen's colour.
		const hl = await draw.drawStroke({ points: [[0, 0], [30, 5]], tool: 'highlighter', style: { brush: 'ballpoint' } });
		expect((hl.node.data as { shape: { stroke: string } }).shape.stroke).toBe('#facc15');
		const bad = await tools.callTool('run_command', { id: 'canvas.setColorLocked', params: {} });
		expect(bad.isError).toBe(true);
		expect((bad.content[0] as { text: string }).text).toMatch(/locked/);
		await tools.callTool('run_command', { id: 'canvas.setColorLocked', params: { locked: false } });
		expect(draw.colorLocked).toBe(false);
		// Without setColorLocked on the target, the command is not offered.
		expect(createDrawCommands({ drawStroke: draw.drawStroke, listBrushes: draw.listBrushes }).some((c) => c.id === 'canvas.setColorLocked')).toBe(false);

		const path = { id: 'a', type: 'path', subpaths: [{ closed: false, anchors: [{ x: 10, y: 50 }, { x: 190, y: 50 }] }], fill: null, stroke: '#1d4ed8', strokeWidth: 2 } as unknown as VectorPathNode;
		const c = new VectorEditorController({ document: { width: 200, height: 100, nodes: [path] } });
		const vectorCommands = new CommandRegistry();
		vectorCommands.register(createVectorCommands(c));
		const vectorTools = new ToolRegistry();
		vectorTools.register(createCommandToolProvider(vectorCommands));
		const top = () => (c.getNode('a') as VectorPathNode).strokes!.at(-1)!;
		const set = await vectorTools.callTool('run_command', { id: 'vector.setColorLocked', params: { locked: true } });
		expect(set.isError).toBeFalsy();
		expect(JSON.stringify(set.structuredContent)).toContain('"colorLocked":true');
		expect(c.getState().colorLocked).toBe(true);
		expect((await vectorTools.callTool('run_command', { id: 'vector.addBrushstroke', params: { ids: ['a'], brushId: 'ballpoint' } })).isError).toBeFalsy();
		expect(top().paint).toBe('#1d4ed8');
		expect((await vectorTools.callTool('run_command', { id: 'vector.addBrushstroke', params: { ids: ['a'], brushId: 'ballpoint', keepColour: false } })).isError).toBeFalsy();
		expect(top().paint).toBe('#1e3a8a');
		const wrong = await vectorTools.callTool('run_command', { id: 'vector.setColorLocked', params: { locked: 'yes' } });
		expect(wrong.isError).toBe(true);
		await vectorTools.callTool('run_command', { id: 'vector.setColorLocked', params: { locked: false } });
		expect(c.getState().colorLocked).toBe(false);
		// The lock is editor state, not an undo step.
		expect(c.getState().undoLabel).not.toMatch(/lock/i);
	});
});
