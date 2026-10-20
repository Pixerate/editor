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
import { decodePng, parseDataUrl } from '../src/raster/png';

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

const blueToYellow = {
	type: 'gradient' as const,
	stops: [
		{ offset: 0, color: '#1d4ed8' },
		{ offset: 1, color: '#facc15' }
	],
	space: 'srgb' as const,
	map: { by: 'distance' as const, length: 140, repeat: 'clamp' as const }
};

/** The mean RGB of the painted pixels of a brushstroke image in a column range (fractions of its width). */
function meanColor(href: string, from: number, to: number): [number, number, number] {
	const png = decodePng(parseDataUrl(href)!.bytes);
	const sum = [0, 0, 0];
	let n = 0;
	for (let y = 0; y < png.height; y++) {
		for (let x = Math.floor(from * png.width); x < Math.ceil(to * png.width); x++) {
			const i = (y * png.width + x) * 4;
			if (png.data[i + 3] < 200) continue;
			for (let c = 0; c < 3; c++) sum[c] += png.data[i + c];
			n++;
		}
	}
	return sum.map((v) => v / Math.max(1, n)) as [number, number, number];
}

describe('gradient paint on brushed strokes', () => {
	const straight: Point[] = Array.from({ length: 16 }, (_, i) => [i * 10, 20] as Point);
	const painted = (paint: unknown, color = '#e11d48') =>
		(strokeToShapeNode({ id: 'g', tool: 'pen', points: straight, style: { color, width: 10, opacity: 1, brush: { hardness: 1 }, paint: paint as any } }).data as any).shape as PathShape;

	it('stores the paint on the brushstroke', () => {
		expect(painted(blueToYellow).brush).toEqual({ brush: { hardness: 1 }, paint: blueToYellow, seed: expect.any(Number) });
	});

	it('a distance gradient paints the start and the end in different colours', async () => {
		const image = await renderShapeBrushstroke(painted(blueToYellow), { scale: 1 });
		const start = meanColor(image!.href, 0, 0.1);
		const end = meanColor(image!.href, 0.9, 1);
		expect(start[2]).toBeGreaterThan(150); // blue
		expect(start[0]).toBeLessThan(80);
		expect(end[0]).toBeGreaterThan(200); // yellow
		expect(end[2]).toBeLessThan(80);
	});

	it('keeps the gradient in place along the path at every zoom', async () => {
		const at1 = meanColor((await renderShapeBrushstroke(painted(blueToYellow), { scale: 1 }))!.href, 0.9, 1);
		const at4 = meanColor((await renderShapeBrushstroke(painted(blueToYellow), { scale: 4 }))!.href, 0.9, 1);
		for (let c = 0; c < 3; c++) expect(Math.abs(at1[c] - at4[c])).toBeLessThan(24);
	});

	it('fills "paint" stops with the stroke colour, and a colour source replaces it', async () => {
		const fromStroke = await renderShapeBrushstroke(painted({ ...blueToYellow, stops: [{ offset: 0, color: 'paint' }, { offset: 1, color: '#facc15' }] }, '#e11d48'), { scale: 1 });
		const start = meanColor(fromStroke!.href, 0, 0.1);
		expect(start[0]).toBeGreaterThan(180);
		expect(start[2]).toBeLessThan(120);
		const solid = meanColor((await renderShapeBrushstroke(painted({ type: 'color', color: '#16a34a' }), { scale: 1 }))!.href, 0, 1);
		expect(solid[1]).toBeGreaterThan(solid[0] + 60);
	});

	it('falls back to the stroke colour for invalid stored paint', async () => {
		const plain = await renderShapeBrushstroke(painted(undefined), { scale: 1 });
		const broken = await renderShapeBrushstroke(painted({ type: 'gradient', stops: [] }), { scale: 1 });
		expect(broken!.href).toBe(plain!.href);
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
		expect(out.brush).toEqual({ brush: 'brush-pen', pressure: [0.1, 1, 0.3], seed: expect.any(Number), size: 10 });
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

	it('draws a stroke with gradient paint and returns the normalised paint', async () => {
		const { registry, nodes, history } = tools();
		const result = await registry.callTool('run_command', {
			id: 'canvas.drawFreehand',
			params: {
				points: [[0, 0], [100, 0], [200, 0]],
				brush: 'marker',
				width: 12,
				paint: { type: 'gradient', stops: [{ offset: 0, color: '#1D4ED8' }, { offset: 1, color: 'paint' }], map: { by: 'distance', length: 200 } }
			}
		});
		expect(result.isError).toBeUndefined();
		const out = (result.structuredContent as any).result;
		expect(out.brush.paint).toEqual({
			type: 'gradient',
			stops: [{ offset: 0, color: '#1d4ed8' }, { offset: 1, color: 'paint' }],
			space: 'pigment',
			map: { by: 'distance', length: 200, repeat: 'mirror', unit: 'px' }
		});
		expect((nodes()[0].data as any).shape.brush.paint).toEqual(out.brush.paint);
		expect(await renderShapeBrushstroke((nodes()[0].data as any).shape)).not.toBeNull();
		history.undo();
		expect(nodes()).toHaveLength(0);
	});

	it('validates paint before changing anything', async () => {
		const { registry, nodes } = tools();
		const call = (params: unknown) => registry.callTool('run_command', { id: 'canvas.drawFreehand', params });
		const points = [[0, 0], [10, 0]];
		const noBrush = await call({ points, paint: blueToYellow });
		expect((noBrush.structuredContent as any).error.message).toMatch(/only colours brushed strokes: pass a brush too/);
		const oneStop = await call({ points, brush: 'ink-pen', paint: { type: 'gradient', stops: [{ offset: 0, color: '#000000' }] } });
		expect((oneStop.structuredContent as any).error.code).toBe('invalid_params');
		const timed = await call({ points, brush: 'ink-pen', paint: { type: 'gradient', stops: blueToYellow.stops, map: { by: 'time' } } });
		expect((timed.structuredContent as any).error.code).toBe('invalid_params');
		const badColor = await call({ points, brush: 'ink-pen', paint: { type: 'color', color: 'red' } });
		expect((badColor.structuredContent as any).error.code).toBe('invalid_params');
		const extra = await call({ points, brush: 'ink-pen', paint: { ...blueToYellow, angle: 90 } });
		expect((extra.structuredContent as any).error.code).toBe('invalid_params');
		const unsorted = await call({ points, brush: 'ink-pen', paint: { type: 'gradient', stops: [{ offset: 1, color: '#000000' }, { offset: 0, color: '#ffffff' }] } });
		expect(unsorted.isError).toBe(true);
		expect((unsorted.structuredContent as any).error.message).toMatch(/sorted by offset/);
		expect(nodes()).toHaveLength(0);
	});

	it('drawStroke refuses paint mappings that need timed samples', async () => {
		const { draw, nodes } = setup();
		await expect(
			draw.drawStroke({ points: [[0, 0], [10, 0]], style: { brush: 'ink-pen', paint: { type: 'gradient', stops: blueToYellow.stops, map: { by: 'velocity' } } as any } })
		).rejects.toThrow(/needs timed samples.*use distance/);
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

describe('brushed stroke character on the canvas', () => {
	const line = 'M0 20 L60 18 L120 24 L180 20';
	const shape = (brush: Record<string, unknown>, extra: Partial<PathShape> = {}): PathShape =>
		({ kind: 'path', d: line, viewBox: [0, 0, 180, 40], stroke: '#222222', strokeWidth: 4, brush, ...extra }) as PathShape;

	it('renders older strokes (no seed) exactly as before: stroke width, plain dabs', async () => {
		const { renderBrushstroke, brushstrokeDataUrl } = await import('../src/paint');
		const { BUILTIN_BRUSHES } = await import('../src/paint-editor/brushes');
		const charcoal = BUILTIN_BRUSHES.find((b) => b.id === 'charcoal-stick')!;
		const old = await renderShapeBrushstroke(shape({ brush: 'charcoal-stick' }), { scale: 1, origin: { x: 50, y: 50 } });
		const expected = renderBrushstroke({ points: pathDataToPolyline(line).map(([x, y]) => ({ x, y })) }, { ...charcoal, tip: { ...charcoal.tip, size: 4 } }, { scale: 1, color: [34, 34, 34, 255] });
		expect(old!.href).toBe(brushstrokeDataUrl(expected));
	});

	it('new strokes get a seed, use the preset size unless one is chosen, and render with character', async () => {
		const node = strokeToShapeNode(stroke({ style: { ...stroke().style, brush: 'charcoal-stick' } }));
		const s = (node.data as any).shape as PathShape;
		expect(s.brush!.seed).toEqual(expect.any(Number));
		expect(s.brush!.size).toBeUndefined();
		const presetSized = await renderShapeBrushstroke(shape({ brush: 'charcoal-stick', seed: 5 }));
		const widthSized = await renderShapeBrushstroke(shape({ brush: 'charcoal-stick' }));
		// Charcoal's own tip is 26 px; the stroke width is 4.
		expect(presetSized!.height).toBeGreaterThan(widthSized!.height + 10);
		const chosen = strokeToShapeNode(stroke({ style: { ...stroke().style, brush: 'charcoal-stick', brushSize: 12 } }));
		expect((chosen.data as any).shape.brush.size).toBe(12);
		expect((chosen.data as any).shape.strokeWidth).toBe(12);
		const twelve = await renderShapeBrushstroke(shape({ brush: 'charcoal-stick', seed: 5, size: 12 }));
		expect(twelve!.height).toBeLessThan(presetSized!.height);
	});

	it('samples the grain where the stroke sits on the canvas, so neighbours share one paper', async () => {
		const brush = { brush: { size: 14, hardness: 0.5 }, seed: 9, paper: { pattern: 'sanded', depth: 1 } };
		// Plain tip settings have no grain response; give the stroke a dry preset with grain instead.
		const grainy = { ...brush, brush: 'soft-pastel' };
		const here = await renderShapeBrushstroke(shape(grainy), { origin: { x: 100, y: 0 } });
		const moved = await renderShapeBrushstroke(shape(grainy, { d: 'M100 20 L160 18 L220 24 L280 20', viewBox: [100, 0, 180, 40] }), { origin: { x: 0, y: 0 } });
		expect(moved!.href).toBe(here!.href);
		const elsewhere = await renderShapeBrushstroke(shape(grainy), { origin: { x: 133, y: 7 } });
		expect(elsewhere!.href).not.toBe(here!.href);
		expect(await renderShapeBrushstroke(shape({ ...grainy, paper: null }))).not.toEqual(here);
	});
});

describe('renderCanvasBrushSwatch', () => {
	it('previews each dry brush differently and refuses wet ones', async () => {
		const { renderCanvasBrushSwatch } = await import('../src/canvas');
		const charcoal = await renderCanvasBrushSwatch('charcoal-stick', { width: 80, height: 24 });
		const airbrush = await renderCanvasBrushSwatch('airbrush', { width: 80, height: 24 });
		expect(charcoal).toMatch(/^data:image\/png;base64,/);
		expect(charcoal).not.toBe(airbrush);
		expect(await renderCanvasBrushSwatch('charcoal-stick', { width: 80, height: 24 })).toBe(charcoal);
		await expect(renderCanvasBrushSwatch('watercolor-round')).rejects.toThrow(/not a dry brush/);
	});
});
