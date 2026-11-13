import { describe, it, expect } from 'vitest';
import { isoBoxProblems, isoFaceColors, isoOrder, isoProjector, isoShade, ToolRegistry } from '../src/tools';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { VectorEditorController, createVectorCommands } from '../src/vector';
import { mermaidToSvg } from '../src/canvas';
import { DiagramController, createDiagramToolProvider, parseMermaid } from '../src/diagram';

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
	expect(a.x).toBeCloseTo(b.x, 6);
	expect(a.y).toBeCloseTo(b.y, 6);
};

describe('isoProjector', () => {
	const iso = isoProjector({ scale: 10, origin: { x: 100, y: 50 } });
	const c = Math.cos(Math.PI / 6) * 10;

	it('maps i down-right, j down-left and k up', () => {
		close(iso.point(0, 0, 0), { x: 100, y: 50 });
		close(iso.point(1, 0, 0), { x: 100 + c, y: 55 });
		close(iso.point(0, 1, 0), { x: 100 - c, y: 55 });
		close(iso.point(0, 0, 1), { x: 100, y: 40 });
	});

	it('gives a box its top, right and left faces and a six-sided outline; a flat tile has only its top', () => {
		const f = iso.box({ i0: 0, i1: 2, j0: 0, j1: 1, k0: 0, k1: 3 });
		expect([f.top.length, f.right.length, f.left.length, f.outline.length]).toEqual([4, 4, 4, 6]);
		close(f.top[0], iso.point(0, 0, 3));
		close(f.right[3], iso.point(2, 0, 0));
		expect(f.d.top.startsWith('M')).toBe(true);
		expect(f.bounds.width).toBeCloseTo(3 * c, 6);
		const tile = iso.box({ i0: 0, i1: 1, j0: 0, j1: 1, k0: 2, k1: 2 });
		expect([tile.right, tile.left, tile.d.right, tile.outline.length]).toEqual([[], [], '', 4]);
		expect(iso.corners({ i0: 0, i1: 1, j0: 0, j1: 1, k0: 0, k1: 1 })).toHaveLength(8);
	});

	it('draws grid lines on whole multiples of the step, so a partial block lines up with whole ones', () => {
		const lines = iso.gridLines({ i0: 0.5, i1: 3, j0: 0, j1: 2, k0: 0, k1: 1 }, 1);
		// Top: i = 1, 2 and j = 1. Right (i = 3): j = 1. Left (j = 2): i = 1, 2.
		expect([lines.top.length, lines.right.length, lines.left.length]).toEqual([3, 1, 2]);
		close(lines.top[0][0], iso.point(1, 0, 1));
		expect(() => iso.gridLines({ i0: 0, i1: 1, j0: 0, j1: 1, k0: 0, k1: 1 }, 0)).toThrow('The grid step must be a positive number of grid units, not 0.');
	});

	it('refuses bad angles, scales and boxes', () => {
		expect(() => isoProjector({ angle: 90 })).toThrow('The isometric angle must be from 1 to 89 degrees, not 90.');
		expect(() => isoProjector({ scale: 0 })).toThrow('The isometric scale must be a positive number of document units per grid unit, not 0.');
		expect(isoBoxProblems({ i0: 1, i1: 0, j0: 0, j1: 1, k0: 0, k1: 0 })).toEqual(['each axis must run from low to high (i0 < i1, j0 < j1, k0 <= k1)']);
		expect(isoBoxProblems({ i0: 0 })[0]).toBe('i1 must be a number');
	});

	it('orders boxes back to front: wholly behind first, then farther, then input order', () => {
		const front = { i0: 2, i1: 3, j0: 2, j1: 3, k0: 0, k1: 1 };
		const back = { i0: 0, i1: 1, j0: 0, j1: 1, k0: 0, k1: 1 };
		const onTop = { i0: 0, i1: 1, j0: 0, j1: 1, k0: 1, k1: 2 };
		const beside = { i0: 1, i1: 2, j0: 0, j1: 1, k0: 0, k1: 1 };
		// onTop sits wholly behind beside along i (onTop.i1 = beside.i0), so it is drawn first.
		expect(isoOrder([front, back, onTop, beside])).toEqual([1, 2, 3, 0]);
		expect(isoOrder([])).toEqual([]);
	});

	it('shades hex fills for the faces and leaves other colours alone', () => {
		expect(isoShade('#ffffff', 0.5)).toBe('#808080');
		expect(isoShade('#fff', 0.15)).toBe('#d9d9d9');
		expect(isoShade('red', 0.5)).toBe('red');
		expect(isoFaceColors('#3b82f6')).toEqual({ top: '#3b82f6', left: '#326fd1', right: '#295bac' });
	});
});

describe('vector.addIsoBoxes', () => {
	const setup = () => {
		const c = new VectorEditorController({ document: { width: 400, height: 300, nodes: [] } });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		return { c, tools, run: (params: unknown) => tools.callTool('run_command', { id: 'vector.addIsoBoxes', params }) };
	};

	it('adds editable blocks back to front in one group, as one undo step, centred on the artboard', async () => {
		const { c, run } = setup();
		const r = await run({ boxes: [{ i0: 2, i1: 4, j0: 0, j1: 1, k0: 0, k1: 1, fill: '#3b82f6', name: 'Front' }, { i0: 0, i1: 1, j0: 0, j1: 1, k0: 0, k1: 2 }, { i0: 0, i1: 3, j0: 1, j1: 2, k0: 0, k1: 0 }], grid: 1 });
		expect(r.isError).toBeFalsy();
		const result = (r.structuredContent as any).result;
		const doc = c.getDocument();
		expect(doc.nodes).toHaveLength(1);
		const group = doc.nodes[0] as any;
		expect(group).toMatchObject({ id: result.id, type: 'group', name: 'Isometric' });
		// Block 2 is behind the floor tile along j; the tile (at height 0) goes under the Front block.
		expect(group.children.map((g: any) => g.name)).toEqual(['Block 2', 'Block 3', 'Front']);
		const front = group.children[2];
		expect(front.children.map((p: any) => [p.name, p.fill])).toEqual([['Left', '#326fd1'], ['Right', '#295bac'], ['Top', '#3b82f6'], ['Grid', null]]);
		expect(result.boxes[0]).toMatchObject({ id: front.id, faces: { top: front.children[2].id } });
		expect(result.boxes[2].faces.left).toBeUndefined(); // a flat tile
		const xs = result.boxes.flatMap((b: any) => b.outline.map((p: any) => p.x));
		const ys = result.boxes.flatMap((b: any) => b.outline.map((p: any) => p.y));
		expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(200, 6);
		expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(150, 6);
		c.undo();
		expect(c.getDocument().nodes).toHaveLength(0);
	});

	it('takes an origin, scale, angle and per-face colours, and refuses bad input', async () => {
		const { c, run } = setup();
		const r = await run({ boxes: [{ i0: 0, i1: 1, j0: 0, j1: 1, k0: 0, k1: 1, fill: { top: '#ffffff', left: '#eeeeee', right: '#dddddd' }, stroke: null }], origin: { x: 10, y: 20 }, scale: 30, angle: 26.565 });
		const top = (r.structuredContent as any).result.boxes[0].outline[0];
		expect(top.x).toBeCloseTo(10, 6);
		expect(top.y).toBeCloseTo(-10, 6);
		const faces = (c.getDocument().nodes[0] as any).children[0].children;
		expect(faces.map((f: any) => [f.fill, f.stroke])).toEqual([['#eeeeee', null], ['#dddddd', null], ['#ffffff', null]]);
		const before = JSON.stringify(c.getDocument());
		for (const [params, message] of [
			[{ boxes: [{ i0: 1, i1: 0, j0: 0, j1: 1, k0: 0, k1: 1 }] }, 'Box 0: each axis must run from low to high (i0 < i1, j0 < j1, k0 <= k1).'],
			[{ boxes: [{ i0: 0, i1: 1, j0: 0, j1: 1, k0: 0, k1: 1 }], angle: 95 }, ''],
			[{ boxes: [] }, '']
		] as const) {
			const bad = await run(params);
			expect(bad.isError).toBe(true);
			if (message) expect((bad.content as { text: string }[])[0].text).toContain(message);
		}
		expect(JSON.stringify(c.getDocument())).toBe(before);
	});
});

describe('isometric diagram export', () => {
	const source = 'flowchart LR\n  subgraph cloud [Cloud]\n    api[API] -->|calls| db[(Database)]\n  end\n  web[Web] --> api';

	it('draws nodes as blocks on group tiles, edges along the floor, and is deterministic', () => {
		const doc = parseMermaid(source);
		const { svg } = mermaidToSvg(doc, { projection: 'isometric' });
		expect(svg).toContain('data-group="cloud"');
		for (const id of ['api', 'db', 'web']) expect(svg).toContain(`data-node="${id}"`);
		expect((svg.match(/<g data-node=/g) ?? []).length).toBe(3);
		expect(svg).toContain('>calls</text>');
		// Edges come before the blocks that stand on them.
		expect(svg.indexOf('data-edge=')).toBeLessThan(svg.indexOf('data-node='));
		expect(mermaidToSvg(doc, { projection: 'isometric' }).svg).toBe(svg);
		expect(mermaidToSvg(doc).svg).not.toBe(svg);
	});

	it('is what render_diagram returns for projection "isometric"', async () => {
		const controller = new DiagramController({ source });
		const registry = new ToolRegistry();
		registry.register(createDiagramToolProvider(controller, { namespace: '', renderSvg: (o) => mermaidToSvg(controller.getDocument(), o) }));
		const result = await registry.callTool('render_diagram', { projection: 'isometric' });
		expect((result.structuredContent as { svg: string }).svg).toBe(mermaidToSvg(controller.getDocument(), { projection: 'isometric' }).svg);
		expect((await registry.callTool('render_diagram', { projection: 'perspective' })).isError).toBe(true);
	});
});

import { sanitizeVectorPerspective, vectorIsometricPerspectivePreset, vectorPerspectiveFlatToPlane, vectorPerspectiveGridLines, vectorPerspectivePlaneMap, vectorPerspectivePlanes } from '../src/vector';

describe('isometric perspective grid (#799)', () => {
	const grid = sanitizeVectorPerspective({ vanishingPoints: [], origin: { x: 200, y: 240 }, isometric: { angle: 30 }, gridSize: 10, extent: 4 })!;

	it('reads an isometric grid with floor, left and right planes, and refuses a bad one', () => {
		expect(grid).toEqual({ vanishingPoints: [], origin: { x: 200, y: 240 }, isometric: { angle: 30 }, gridSize: 10, extent: 4 });
		expect(vectorPerspectivePlanes(grid)).toEqual(['floor', 'left', 'right']);
		expect(sanitizeVectorPerspective({ origin: { x: 0, y: 0 }, isometric: { angle: 30 } })?.vanishingPoints).toEqual([]);
		expect(sanitizeVectorPerspective({ vanishingPoints: [{ x: 1, y: 1 }], origin: { x: 0, y: 0 }, isometric: { angle: 30 } })).toBeNull();
		expect(sanitizeVectorPerspective({ origin: { x: 0, y: 0 }, isometric: { angle: 95 } })).toBeNull();
		expect(vectorIsometricPerspectivePreset(400, 300)).toEqual({ vanishingPoints: [], origin: { x: 200, y: 240 }, isometric: { angle: 30 }, gridSize: 15, extent: 12 });
	});

	it('maps planes in parallel: affine maps, art keeps its size anywhere, grid lines never clip', () => {
		for (const plane of ['floor', 'left', 'right'] as const) {
			const h = vectorPerspectivePlaneMap(grid, plane)!;
			expect([h[6], h[7], h[8]]).toEqual([0, 0, 1]);
			expect(vectorPerspectiveGridLines(grid, plane)).toHaveLength(plane === 'floor' ? 18 : 14);
		}
		const onFloor = vectorPerspectiveFlatToPlane(grid, 'floor')!;
		const c = Math.cos(Math.PI / 6);
		// One unit right of the origin goes back and to the right along the floor.
		close(onFloor({ x: 201, y: 240 })!, { x: 200 + c, y: 239.5 });
		// The same step far away is the same length: nothing recedes.
		const a = onFloor({ x: 300, y: 240 })!;
		const b = onFloor({ x: 301, y: 240 })!;
		expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(1, 9);
		expect(vectorPerspectivePlaneMap(grid, 'side')).toBeNull();
	});

	it('vector.setPerspective takes isometric, and draws shapes on its planes', async () => {
		const c = new VectorEditorController({ document: { width: 400, height: 300, nodes: [] } });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const set = await tools.callTool('run_command', { id: 'vector.setPerspective', params: { origin: { x: 200, y: 240 }, isometric: { angle: 30 } } });
		expect((set.structuredContent as any).result).toMatchObject({ perspective: { isometric: { angle: 30 } }, planes: ['floor', 'left', 'right'] });
		const bad = await tools.callTool('run_command', { id: 'vector.setPerspective', params: { origin: { x: 200, y: 240 } } });
		expect(bad.isError).toBe(true);
		expect((bad.content as { text: string }[])[0].text).toContain('or isometric: { angle } (1 to 89 degrees)');
		expect(c.setPerspectivePlane('left').ok).toBe(true);
	});
});
