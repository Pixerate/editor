// The Bevel effect (CorelDRAW's Bevel, concept only): a shaded chiselled edge inside a shape with
// a flat middle. Test cases our own.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import { bezierPathBounds } from '../src/canvas/pathops';
import {
	VectorEditorController,
	createVectorCommands,
	createVectorEffect,
	rectSubpath,
	subpathsToBezier,
	vectorAppearanceShapes,
	vectorBevelFaces,
	vectorDocumentToLottie,
	vectorNodeBounds,
	type VectorPathNode
} from '../src/vector';

const square = (extra: Partial<VectorPathNode> = {}): VectorPathNode => ({ id: 'a', type: 'path', subpaths: [rectSubpath({ x: 0, y: 0, width: 100, height: 100 })], fill: '#808080', stroke: null, ...extra });
const sq = subpathsToBezier([rectSubpath({ x: 0, y: 0, width: 100, height: 100 })]);
const box = (b: { minX: number; minY: number; maxX: number; maxY: number } | null) => (b ? [b.minX, b.minY, b.maxX, b.maxY].map((v) => Math.round(v * 100) / 100) : null);
const bottomFirst = (n: VectorPathNode) =>
	vectorAppearanceShapes(n)
		.slice()
		.sort((a, b) => {
			for (let i = 0; i < Math.min(a.order.length, b.order.length); i++) if (a.order[i] !== b.order[i]) return a.order[i] - b.order[i];
			return a.order.length - b.order.length;
		});

describe('bevel faces', () => {
	it('makes one face per edge from the outline in to the inset corners', () => {
		const faces = vectorBevelFaces(sq, { width: 10, lightAngle: -90, shading: 100 });
		expect(faces).toHaveLength(4);
		const boxes = faces.map((f) => box(bezierPathBounds(f.path))!.join());
		expect(boxes).toContain('0,0,100,10');
		expect(boxes).toContain('90,0,100,100');
	});

	it('lights faces that slope toward the light and darkens the others', () => {
		// Light from above: the top face is lit, the bottom face dark, the sides neutral.
		const faces = vectorBevelFaces(sq, { width: 10, lightAngle: -90, shading: 100 });
		const at = (b: string) => faces.find((f) => box(bezierPathBounds(f.path))!.join() === b)!.shade;
		expect(at('0,0,100,10')).toBeCloseTo(1);
		expect(at('0,90,100,100')).toBeCloseTo(-1);
		expect(at('0,0,10,100')).toBeCloseTo(0);
	});

	it('keeps the faces inside where the shape is thinner than the bevel, and inside holes', () => {
		const thin = subpathsToBezier([rectSubpath({ x: 0, y: 0, width: 100, height: 10 })]);
		const faces = vectorBevelFaces(thin, { width: 20, lightAngle: 0, shading: 50 });
		for (const f of faces) {
			const b = bezierPathBounds(f.path)!;
			expect(b.minY).toBeGreaterThanOrEqual(-1e-9);
			expect(b.maxY).toBeLessThanOrEqual(10 + 1e-9);
		}
		// A frame: the hole's faces lie in the ring between 20 and 80, not inside the hole.
		const frame = subpathsToBezier([rectSubpath({ x: 0, y: 0, width: 100, height: 100 }), rectSubpath({ x: 20, y: 20, width: 60, height: 60 })]);
		const ring = vectorBevelFaces(frame, { width: 5, lightAngle: 0, shading: 50 }, 'evenodd');
		expect(ring).toHaveLength(8);
		const holeTop = ring.map((f) => bezierPathBounds(f.path)!).find((b) => b.maxY === 20 && b.minX >= 15);
		expect(holeTop?.minY).toBeCloseTo(15);
		expect(vectorBevelFaces(sq, { width: 0, lightAngle: 0, shading: 50 })).toEqual([]);
	});
});

describe('bevel effect', () => {
	it('draws fill, faces, the flat middle in the own paint, then the stroke, keeping the bounds', () => {
		const n = square({ stroke: '#000000', strokeWidth: 2, effects: [createVectorEffect('bevel', 'b', { width: 10 })!] });
		const shapes = bottomFirst(n);
		expect(shapes).toHaveLength(1 + 4 + 1 + 1);
		expect(shapes[0].source.stroke).toBeNull();
		expect(box(bezierPathBounds(shapes[5].path))).toEqual([10, 10, 90, 90]);
		expect(shapes[5].source.fill).toBe('#808080');
		expect(shapes[6].source.fill).toBeNull();
		expect(shapes[6].source.stroke).toBe('#000000');
		const b = vectorNodeBounds(square({ effects: [createVectorEffect('bevel', 'b', {})!] }))!;
		expect([b.x, b.y, b.width, b.height].map(Math.round)).toEqual([0, 0, 100, 100]);
		const red = bottomFirst(square({ effects: [createVectorEffect('bevel', 'b', { color: '#ff0000', shading: 0 })!] }));
		expect(red.slice(1, 5).every((s) => s.source.fill === '#ff0000')).toBe(true);
	});

	it('sanitizes its parameters and is exported to Lottie as drawn', () => {
		const e = createVectorEffect('bevel', 'b', { width: -3, shading: 300, color: 'nope' })!;
		expect(e.params).toMatchObject({ width: 0, shading: 100, color: null, lightAngle: -135 });
		const { notes } = vectorDocumentToLottie({ width: 100, height: 100, nodes: [square({ effects: [createVectorEffect('bevel', 'b', {})!] })] });
		expect(notes.some((n) => n.includes('bevel'))).toBe(true);
	});
});

describe('bevel through the tool registry', () => {
	it('is added like any effect, as one undo step, and rejects bad input', async () => {
		const c = new VectorEditorController({ document: { width: 200, height: 200, nodes: [square()] } });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const r = await tools.callTool('run_command', { id: 'vector.addEffect', params: { ids: ['a'], type: 'bevel', params: { width: 6, lightAngle: -90 } } });
		expect(r.isError).toBeFalsy();
		expect((r.structuredContent as any).result.effects[0]).toMatchObject({ nodeId: 'a' });
		expect((c.getNode('a') as VectorPathNode).effects![0]).toMatchObject({ type: 'bevel', params: { width: 6, lightAngle: -90 } });
		c.undo();
		expect((c.getNode('a') as VectorPathNode).effects ?? []).toHaveLength(0);
		expect((await tools.callTool('run_command', { id: 'vector.addEffect', params: { ids: ['nope'], type: 'bevel' } })).isError).toBe(true);
	});
});
