// The Block Shadow effect (CorelDRAW's Block Shadow, concept only): the shape swept along a
// direction, drawn under it; a long shadow when it fades. Test cases our own.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import { bezierPathArea, bezierPathBounds } from '../src/canvas/pathops';
import {
	VectorEditorController,
	createVectorCommands,
	createVectorEffect,
	ellipseSubpath,
	rectSubpath,
	subpathsToBezier,
	sweepPath,
	vectorAppearanceShapes,
	vectorDocumentToLottie,
	vectorDocumentToSvg,
	vectorNodeBounds,
	type VectorGradient,
	type VectorPathNode
} from '../src/vector';

const square = (extra: Partial<VectorPathNode> = {}): VectorPathNode => ({ id: 'a', type: 'path', subpaths: [rectSubpath({ x: 0, y: 0, width: 100, height: 100 })], fill: '#ff0000', stroke: null, ...extra });
const shadow = (params: Record<string, unknown>) => [createVectorEffect('blockShadow', 's', params)!];
const box = (b: { minX: number; minY: number; maxX: number; maxY: number } | null) => (b ? [b.minX, b.minY, b.maxX, b.maxY].map((v) => Math.round(v * 100) / 100) : null);
const bottomFirst = (n: VectorPathNode) =>
	vectorAppearanceShapes(n)
		.slice()
		.sort((a, b) => {
			for (let i = 0; i < Math.min(a.order.length, b.order.length); i++) if (a.order[i] !== b.order[i]) return a.order[i] - b.order[i];
			return a.order.length - b.order.length;
		});

describe('sweepPath', () => {
	it('sweeps a square diagonally into a hexagon', () => {
		const path = subpathsToBezier([rectSubpath({ x: 0, y: 0, width: 10, height: 10 })]);
		const swept = sweepPath(path, 5, 5);
		expect(box(bezierPathBounds(swept))).toEqual([0, 0, 15, 15]);
		// 15² minus the two 5×5 corner triangles left out.
		expect(bezierPathArea(swept)).toBeCloseTo(225 - 25, 3);
	});

	it('sweeps a circle into a capsule, and leaves a path alone for no move', () => {
		const path = subpathsToBezier([ellipseSubpath({ x: 0, y: 0, width: 20, height: 20 })]);
		const swept = sweepPath(path, 30, 0);
		expect(box(bezierPathBounds(swept))).toEqual([0, 0, 50, 20]);
		// A circle of radius 10 and a 30 × 20 band.
		expect(bezierPathArea(swept)).toBeCloseTo(Math.PI * 100 + 600, 0);
		expect(sweepPath(path, 0, 0)).toEqual(path);
		expect(sweepPath([], 5, 5)).toEqual([]);
	});
});

describe('block shadow effect', () => {
	it('draws one shadow shape under the shape, in the shadow colour', () => {
		const shapes = bottomFirst(square({ effects: shadow({ angle: 0, distance: 50, color: '#000000' }) }));
		expect(shapes).toHaveLength(2);
		expect(shapes[0].source.fill).toBe('#000000');
		expect(shapes[0].source.stroke).toBeNull();
		expect(box(bezierPathBounds(shapes[0].path))).toEqual([0, 0, 150, 100]);
		expect(shapes[1].source.fill).toBe('#ff0000');
		const b = vectorNodeBounds(square({ effects: shadow({ angle: 90, distance: 30 }) }))!;
		expect([b.x, b.y, b.width, b.height].map(Math.round)).toEqual([0, 0, 100, 130]);
	});

	it("uses the shape's own colour with no colour, and fades into a long shadow", () => {
		expect(bottomFirst(square({ effects: shadow({ color: null }) }))[0].source.fill).toBe('#ff0000');
		const [long] = bottomFirst(square({ effects: shadow({ angle: 45, distance: 200, opacity: 80, endOpacity: 0 }) }));
		const g = long.source.fill as VectorGradient;
		expect(g.type).toBe('linear');
		expect(g.units).toBe('userSpaceOnUse');
		expect(g.stops.map((s) => s.opacity)).toEqual([1, 0]);
		expect(long.opacity).toBeCloseTo(0.8);
		// From the near corner to the far end of the shadow.
		expect([g.start!.x, g.start!.y].map((v) => Math.round(v) + 0)).toEqual([0, 0]);
		expect(g.end!.x).toBeCloseTo(100 + 200 / Math.SQRT2, 3);
		expect(vectorDocumentToSvg({ width: 400, height: 400, nodes: [square({ effects: shadow({ distance: 100, endOpacity: 0 }) })] })).toContain('linearGradient');
	});

	it('sanitizes its parameters and is exported to Lottie as drawn', () => {
		const e = createVectorEffect('blockShadow', 's', { distance: -5, opacity: 400, color: 'nope', angle: 'x' })!;
		expect(e.params).toMatchObject({ distance: 0, opacity: 100, color: '#1e293b', angle: 45, endOpacity: 100 });
		const { notes } = vectorDocumentToLottie({ width: 100, height: 100, nodes: [square({ effects: shadow({}) })] });
		expect(notes.some((n) => n.includes('block shadow'))).toBe(true);
	});
});

describe('block shadow through the tool registry', () => {
	it('is added like any effect, as one undo step, and rejects bad input', async () => {
		const c = new VectorEditorController({ document: { width: 200, height: 200, nodes: [square()] } });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const r = await tools.callTool('run_command', { id: 'vector.addEffect', params: { ids: ['a'], type: 'blockShadow', params: { angle: 135, distance: 40, color: '#334155', endOpacity: 0 } } });
		expect(r.isError).toBeFalsy();
		expect((r.structuredContent as any).result.effects[0]).toMatchObject({ nodeId: 'a' });
		expect((c.getNode('a') as VectorPathNode).effects![0]).toMatchObject({ type: 'blockShadow', params: { angle: 135, distance: 40, color: '#334155', endOpacity: 0 } });
		c.undo();
		expect((c.getNode('a') as VectorPathNode).effects ?? []).toHaveLength(0);
		const bad = await tools.callTool('run_command', { id: 'vector.addEffect', params: { ids: ['nope'], type: 'blockShadow' } });
		expect(bad.isError).toBe(true);
	});
});
