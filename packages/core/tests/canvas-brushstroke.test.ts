import { describe, it, expect } from 'vitest';
import {
	brushstrokeScaleBucket,
	createCanvasDrawController,
	findStrokesAtPoint,
	freehandBrushstroke,
	getBrushedShapeSvg,
	isBrushedShape,
	listCanvasBrushes,
	pathDataToPolyline,
	profileAlongPolyline,
	renderShapeBrushstroke,
	strokeToShapeNode,
	type CanvasNode,
	type FreehandStroke,
	type PathShape,
	type Point
} from '../src/canvas';
import { CommandRegistry, createCommandToolProvider, createDrawCommands } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import { HistoryManager } from '../src/history';

const wave: Point[] = Array.from({ length: 20 }, (_, i) => [10 + i * 8, 40 + Math.sin(i / 3) * 15] as Point);
const pen = (i: number) => ({ pressure: 0.2 + (0.8 * i) / 19, tiltX: 20, tiltY: 0 });
const stroke = (extra: Partial<FreehandStroke> = {}): FreehandStroke => ({
	id: 's1',
	tool: 'pen',
	points: wave,
	style: { color: '#e11d48', width: 6, opacity: 0.9, cap: 'round', join: 'round' },
	...extra
});

function setup() {
	let nodes: CanvasNode[] = [];
	const history = new HistoryManager({ maxDepth: 50 });
	let n = 0;
	const draw = createCanvasDrawController({
		getNodes: () => nodes,
		setNodes: (next) => {
			nodes = next;
		},
		history,
		generateNodeId: () => `n${++n}`
	});
	return { draw, history, nodes: () => nodes };
}

describe('brushed freehand strokes: no brush, no change', () => {
	it('pen samples without a brush leave the vector node exactly as before', () => {
		const plain = strokeToShapeNode(stroke());
		const withPen = strokeToShapeNode(stroke({ samples: wave.map((_, i) => pen(i)) }));
		expect(withPen).toEqual(plain);
		expect('brush' in (plain.data as any).shape).toBe(false);
	});

	it('the controller draws the same node whether or not pen data is passed', () => {
		const a = setup();
		const b = setup();
		a.draw.setTool('pen');
		b.draw.setTool('pen');
		a.draw.startStroke(wave[0]);
		b.draw.startStroke(wave[0], pen(0));
		for (let i = 1; i < wave.length; i++) {
			a.draw.continueStroke(wave[i]);
			b.draw.continueStroke(wave[i], pen(i));
		}
		expect(b.draw.activeStroke?.samples).toHaveLength(wave.length);
		expect(b.draw.endStroke()).toEqual(a.draw.endStroke());
	});
});

describe('brushed freehand strokes', () => {
	it('stores the brush and pen profiles along the path on the shape', () => {
		const node = strokeToShapeNode(stroke({ style: { ...stroke().style, brush: 'ink-pen' }, samples: wave.map((_, i) => pen(i)) }));
		const shape = (node.data as any).shape as PathShape;
		expect(isBrushedShape(shape)).toBe(true);
		expect(shape.kind).toBe('path');
		expect(shape.brush!.brush).toBe('ink-pen');
		expect(shape.brush!.pressure![0]).toBeCloseTo(0.2, 2);
		expect(shape.brush!.pressure!.at(-1)).toBeCloseTo(1, 2);
		expect(shape.brush!.tiltX!.every((t) => t === 20)).toBe(true);
		expect(shape.brush!.tiltY).toBeUndefined();
		// Still a path: the eraser finds it.
		expect(findStrokesAtPoint([wave[5][0], wave[5][1]], [node], 4)).toHaveLength(1);
	});

	it('leaves out profiles that carry nothing', () => {
		expect(freehandBrushstroke('pencil-hb', wave, wave.map(() => ({ pressure: 1 })))).toEqual({ brush: 'pencil-hb' });
		expect(freehandBrushstroke('pencil-hb', wave, undefined)).toEqual({ brush: 'pencil-hb' });
		expect(profileAlongPolyline([[0, 0], [10, 0], [40, 0]], [0, 0.25, 1], 5)).toEqual([0, 0.5, 1]);
	});

	it('flattens the first subpath of path data into a polyline', () => {
		expect(pathDataToPolyline('M0 0 L10 0 L10 10')).toEqual([[0, 0], [10, 0], [10, 10]]);
		const curve = pathDataToPolyline('M0 0 C10 0 20 10 30 10 M100 100 L200 200', 2);
		expect(curve.length).toBeGreaterThan(5);
		expect(curve.at(-1)).toEqual([30, 10]);
	});

	it('renders a cached image placed in path coordinates, re-rendered per zoom bucket and per path', async () => {
		const node = strokeToShapeNode(stroke({ style: { ...stroke().style, brush: 'ink-pen' } }));
		const shape = (node.data as any).shape as PathShape;
		const a = await renderShapeBrushstroke(shape, { scale: brushstrokeScaleBucket(1) });
		expect(a!.href).toMatch(/^data:image\/png;base64,/);
		expect(a!.width).toBeGreaterThan(100);
		expect(await renderShapeBrushstroke(shape, { scale: brushstrokeScaleBucket(1) })).toEqual(a);
		const zoomed = await renderShapeBrushstroke(shape, { scale: brushstrokeScaleBucket(3) });
		expect(zoomed!.scale).toBe(4);
		expect(zoomed!.href).not.toBe(a!.href);
		const edited = await renderShapeBrushstroke({ ...shape, d: 'M0 0 L50 50' }, { scale: 1 });
		expect(edited!.href).not.toBe(a!.href);
		expect(await renderShapeBrushstroke({ ...shape, brush: undefined })).toBeNull();
	});

	it('exports SVG with the image embedded', async () => {
		const node = strokeToShapeNode(stroke({ style: { ...stroke().style, brush: { hardness: 0.4 } } }));
		const svg = await getBrushedShapeSvg((node.data as any).shape, { width: node.width!, height: node.height! });
		expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
		expect(svg).toMatch(/<image href="data:image\/png;base64,[^"]+" x="[-\d.]+"/);
		expect(svg).toContain('opacity="0.9"');
	});

	it('lists dry presets only and refuses wet or unknown brushes', async () => {
		const brushes = await listCanvasBrushes();
		expect(brushes.map((b) => b.id)).toEqual(expect.arrayContaining(['ink-pen', 'pencil-hb']));
		expect(brushes.some((b) => b.id.startsWith('watercolor'))).toBe(false);
		const wet = { ...((strokeToShapeNode(stroke()).data as any).shape as PathShape), brush: { brush: 'watercolor-round' } };
		await expect(renderShapeBrushstroke(wet)).rejects.toThrow(/not a dry brush.*wet paint needs an area to flow in/);
		await expect(renderShapeBrushstroke({ ...wet, brush: { brush: 'nope' } })).rejects.toThrow(/Unknown brush 'nope'.*ink-pen/);
	});
});

describe('drawStroke and the canvas.drawFreehand command', () => {
	function tools() {
		const env = setup();
		const commands = new CommandRegistry();
		commands.register(createDrawCommands(env.draw));
		const registry = new ToolRegistry();
		registry.register(createCommandToolProvider(commands));
		return { ...env, registry };
	}

	it('draws a brushed stroke with a pressure profile in one undo step', async () => {
		const { registry, nodes, history } = tools();
		const result = await registry.callTool('run_command', {
			id: 'canvas.drawFreehand',
			params: { points: wave.map(([x, y]) => [x, y]), brush: 'brush-pen', width: 10, color: '#111', pressure: [0.1, 1, 0.3] }
		});
		expect(result.isError).toBeUndefined();
		const out = (result.structuredContent as any).result;
		expect(out.id).toBe('n1');
		expect(out.bounds).toMatchObject({ x: 10, width: 152 });
		expect(out.brush).toEqual({ brush: 'brush-pen', pressure: [0.1, 1, 0.3] });
		expect(nodes()).toHaveLength(1);
		history.undo();
		expect(nodes()).toHaveLength(0);
	});

	it('draws a plain vector stroke without a brush', async () => {
		const { registry, nodes } = tools();
		const result = await registry.callTool('run_command', { id: 'canvas.drawFreehand', params: { points: [[0, 0], [20, 5], [40, 0]], tool: 'highlighter' } });
		expect((result.structuredContent as any).result.brush).toBeUndefined();
		expect((nodes()[0].data as any).shape).toMatchObject({ stroke: '#facc15', strokeWidth: 24, opacity: 0.35 });
	});

	it('refuses bad input before changing anything', async () => {
		const { registry, nodes } = tools();
		const call = (params: unknown) => registry.callTool('run_command', { id: 'canvas.drawFreehand', params });
		const wet = await call({ points: [[0, 0], [10, 0]], brush: 'watercolor-round' });
		expect(wet.isError).toBe(true);
		expect((wet.structuredContent as any).error.message).toMatch(/not a dry brush/);
		const noBrush = await call({ points: [[0, 0], [10, 0]], pressure: [0.5] });
		expect((noBrush.structuredContent as any).error.message).toMatch(/pass a brush too/);
		const badProfile = await call({ points: [[0, 0]], brush: 'ink-pen', pressure: [2] });
		expect((badProfile.structuredContent as any).error.code).toBe('invalid_params');
		const extra = await call({ points: [[0, 0]], colour: 'red' });
		expect((extra.structuredContent as any).error.code).toBe('invalid_params');
		const empty = await call({ points: [] });
		expect(empty.isError).toBe(true);
		expect(nodes()).toHaveLength(0);
	});

	it('lists the brushes it accepts', async () => {
		const { registry } = tools();
		const result = await registry.callTool('run_command', { id: 'canvas.listBrushes', params: {} });
		expect((result.structuredContent as any).result.brushes[0]).toMatchObject({ id: expect.any(String), name: expect.any(String), size: expect.any(Number) });
	});

	it('refuses drawing on a read-only canvas, but still lists brushes', async () => {
		const env = setup();
		const commands = new CommandRegistry();
		commands.register(createDrawCommands(env.draw, { readOnlyReason: () => 'The canvas is read-only.' }));
		const list = commands.list({ includeHidden: true } as any);
		expect(list.find((c) => c.id === 'canvas.drawFreehand')).toMatchObject({ enabled: false, disabledReason: 'The canvas is read-only.' });
		expect(list.find((c) => c.id === 'canvas.listBrushes')).toMatchObject({ enabled: true, readOnly: true });
	});
});

describe('pointerPenSample', () => {
	it('reads pressure and tilt from pens only', async () => {
		const { pointerPenSample } = await import('../src/canvas');
		expect(pointerPenSample({ pointerType: 'mouse', pressure: 0.5 })).toBeUndefined();
		expect(pointerPenSample({ pointerType: 'touch', pressure: 1 })).toBeUndefined();
		expect(pointerPenSample({ pointerType: 'pen', pressure: 0.4, tiltX: 30, tiltY: 0 })).toEqual({ pressure: 0.4, tiltX: 30 });
		expect(pointerPenSample({ pointerType: 'pen', pressure: 0 })).toEqual({});
	});
});
