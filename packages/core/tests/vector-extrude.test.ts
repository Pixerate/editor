// The Extrude effect (CorelDRAW's Extrude, concept only): shaded side faces drawing a shape as a
// solid, parallel or toward a vanishing point. Test cases our own.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import { bezierPathBounds } from '../src/canvas/pathops';
import {
	VectorEditorController,
	createVectorCommands,
	createVectorEffect,
	rectSubpath,
	shadeVectorColor,
	vectorPaintSolid,
	subpathsToBezier,
	vectorAppearanceShapes,
	vectorDocumentToLottie,
	vectorExtrudeFaces,
	vectorNodeBounds,
	VECTOR_EFFECT_DEFAULTS,
	type VectorPathNode
} from '../src/vector';

const square = (extra: Partial<VectorPathNode> = {}): VectorPathNode => ({ id: 'a', type: 'path', subpaths: [rectSubpath({ x: 0, y: 0, width: 100, height: 100 })], fill: '#808080', stroke: null, ...extra });
const params = (p: Partial<(typeof VECTOR_EFFECT_DEFAULTS)['extrude']> = {}) => ({ ...VECTOR_EFFECT_DEFAULTS.extrude, ...p });
const box = (b: { minX: number; minY: number; maxX: number; maxY: number } | null) => (b ? [b.minX, b.minY, b.maxX, b.maxY].map((v) => Math.round(v * 100) / 100) : null);
const sq = subpathsToBezier([rectSubpath({ x: 0, y: 0, width: 100, height: 100 })]);
const bottomFirst = (n: VectorPathNode) =>
	vectorAppearanceShapes(n)
		.slice()
		.sort((a, b) => {
			for (let i = 0; i < Math.min(a.order.length, b.order.length); i++) if (a.order[i] !== b.order[i]) return a.order[i] - b.order[i];
			return a.order.length - b.order.length;
		});

describe('extrude faces', () => {
	it('makes one face per edge, moved along the angle, the far-side faces drawn last', () => {
		const faces = vectorExtrudeFaces(sq, params({ angle: 0, depth: 50 }));
		expect(faces).toHaveLength(2 + 2);
		// The right edge's face is the nearest to the viewer: drawn last.
		expect(box(bezierPathBounds(faces[faces.length - 1].path))).toEqual([100, 0, 150, 100]);
		expect(faces.every((f) => box(bezierPathBounds(f.path))![2] <= 150)).toBe(true);
	});

	it('shades faces by the light, lit from the right brightening the right face', () => {
		const faces = vectorExtrudeFaces(sq, params({ angle: 0, depth: 50, lightAngle: 0, shading: 100 }));
		const right = faces.find((f) => box(bezierPathBounds(f.path))!.join() === '100,0,150,100')!;
		expect(right.shade).toBeCloseTo(1);
		const top = faces.find((f) => box(bezierPathBounds(f.path))!.join() === '0,0,150,0');
		expect(top?.shade ?? 0).toBeCloseTo(0);
		expect(vectorExtrudeFaces(sq, params({ angle: 0, depth: 50, lightAngle: 0, shading: 0 })).every((f) => f.shade === 0)).toBe(true);
	});

	it('pulls the back toward a vanishing point in perspective', () => {
		// The vanishing point 200 above the middle; halfway there.
		const faces = vectorExtrudeFaces(sq, params({ mode: 'perspective', vanishingPoint: { x: 0, y: -200 }, toward: 50 }));
		const all = faces.map((f) => bezierPathBounds(f.path)!);
		expect(Math.min(...all.map((b) => b.minY))).toBeCloseTo(-75);
		expect(vectorExtrudeFaces(sq, params({ mode: 'perspective', toward: 0 }))).toEqual([]);
		expect(vectorExtrudeFaces(sq, params({ depth: 0 }))).toEqual([]);
	});

	it('orders the faces of a concave outline back to front', () => {
		// An L: the inner vertical edge's face is covered by the bottom arm's right edge face.
		const L = subpathsToBezier([{ closed: true, anchors: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 80 }, { x: 100, y: 80 }, { x: 100, y: 100 }, { x: 0, y: 100 }] }]);
		const faces = vectorExtrudeFaces(L, params({ angle: 0, depth: 50 }));
		const at = (x: number) => faces.findIndex((f) => { const b = bezierPathBounds(f.path)!; return b.minX === x && b.maxX === x + 50; });
		expect(at(20)).toBeLessThan(at(100));
	});

	it('shades colours toward white and black', () => {
		expect(shadeVectorColor('#808080', 1)).toBe('#ffffff');
		expect(shadeVectorColor('#808080', -1)).toBe('#000000');
		expect(shadeVectorColor('#808080', 0)).toBe('#808080');
	});

	it('takes a solid colour from any paint for the faces', () => {
		expect(vectorPaintSolid('#123456')).toBe('#123456');
		expect(vectorPaintSolid({ type: 'linear', stops: [{ offset: 0, color: '#000000' }, { offset: 0.4, color: '#ff0000' }, { offset: 1, color: '#ffffff' }] })).toBe('#ff0000');
		expect(vectorPaintSolid({ type: 'freeform', points: [{ x: 0, y: 0, color: '#00ff00' }] } as never)).toBe('#00ff00');
		expect(vectorPaintSolid(null)).toBeNull();
		expect(vectorPaintSolid('none')).toBeNull();
	});
});

describe('extrude effect', () => {
	it('draws the faces under the shape, in the shape colour shaded, and grows the bounds', () => {
		const shapes = bottomFirst(square({ effects: [createVectorEffect('extrude', 'x', { angle: 90, depth: 30, color: null })!] }));
		expect(shapes[shapes.length - 1].source.fill).toBe('#808080');
		expect(shapes.length).toBe(5);
		const b = vectorNodeBounds(square({ effects: [createVectorEffect('extrude', 'x', { angle: 90, depth: 30 })!] }))!;
		expect([b.x, b.y, b.width, b.height].map(Math.round)).toEqual([0, 0, 100, 130]);
		const coloured = bottomFirst(square({ effects: [createVectorEffect('extrude', 'x', { color: '#ff0000', shading: 0 })!] }));
		expect(coloured.slice(0, -1).every((s) => s.source.fill === '#ff0000')).toBe(true);
	});

	it('sanitizes its parameters and is exported to Lottie as drawn', () => {
		const e = createVectorEffect('extrude', 'x', { mode: 'sideways', depth: -5, toward: 400, color: 'nope', vanishingPoint: 3 })!;
		expect(e.params).toMatchObject({ mode: 'parallel', depth: 0, toward: 100, color: null, vanishingPoint: { x: 0, y: -300 } });
		const { notes } = vectorDocumentToLottie({ width: 100, height: 100, nodes: [square({ effects: [createVectorEffect('extrude', 'x', {})!] })] });
		expect(notes.some((n) => n.includes('extrude'))).toBe(true);
	});
});

describe('extrude through the tool registry', () => {
	it('is added like any effect, as one undo step, and rejects bad input', async () => {
		const c = new VectorEditorController({ document: { width: 200, height: 200, nodes: [square()] } });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const r = await tools.callTool('run_command', { id: 'vector.addEffect', params: { ids: ['a'], type: 'extrude', params: { mode: 'perspective', vanishingPoint: { x: 100, y: -150 }, toward: 40, lightAngle: -90 } } });
		expect(r.isError).toBeFalsy();
		expect((r.structuredContent as any).result.effects[0]).toMatchObject({ nodeId: 'a' });
		expect((c.getNode('a') as VectorPathNode).effects![0]).toMatchObject({ type: 'extrude', params: { mode: 'perspective', vanishingPoint: { x: 100, y: -150 }, toward: 40 } });
		c.undo();
		expect((c.getNode('a') as VectorPathNode).effects ?? []).toHaveLength(0);
		const bad = await tools.callTool('run_command', { id: 'vector.addEffect', params: { ids: ['nope'], type: 'extrude' } });
		expect(bad.isError).toBe(true);
	});
});
