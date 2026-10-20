// The Contour effect (CorelDRAW's Contour, concept only): offset steps blending toward end
// colours. Test cases our own.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import {
	VectorEditorController,
	createVectorCommands,
	createVectorEffect,
	rectSubpath,
	vectorAppearanceShapes,
	vectorDocumentToLottie,
	vectorNodeBounds,
	expandVectorAppearance,
	type VectorPathNode
} from '../src/vector';

const square = (extra: Partial<VectorPathNode> = {}): VectorPathNode => ({ id: 'a', type: 'path', subpaths: [rectSubpath({ x: 0, y: 0, width: 100, height: 100 })], fill: '#000000', stroke: null, ...extra });
const contour = (params: Record<string, unknown>) => [createVectorEffect('contour', 'c', params)!];
const sorted = (n: VectorPathNode) => {
	const shapes = vectorAppearanceShapes(n);
	return shapes.slice().sort((a, b) => {
		for (let i = 0; i < Math.min(a.order.length, b.order.length); i++) if (a.order[i] !== b.order[i]) return a.order[i] - b.order[i];
		return a.order.length - b.order.length;
	});
};

describe('contour effect', () => {
	it('adds steps inside, each smaller and lighter, drawn over the shape', () => {
		const shapes = sorted(square({ effects: contour({ direction: 'inside', steps: 4, offset: 10, fillColor: '#ffffff' }) }));
		expect(shapes).toHaveLength(5);
		expect(shapes.map((s) => s.source.fill)).toEqual(['#000000', '#404040', '#808080', '#bfbfbf', '#ffffff']);
		// The last step is 40 in from each side.
		const last = expandVectorAppearance(square({ effects: contour({ direction: 'inside', steps: 4, offset: 10 }) }));
		expect(last.type).toBe('group');
	});

	it('adds steps outside drawn under the shape, and grows the bounds', () => {
		const n = square({ effects: contour({ direction: 'outside', steps: 2, offset: 5, join: 'miter' }) });
		const shapes = sorted(n);
		// Bottom first: the largest step, then the smaller, then the shape.
		expect(shapes[shapes.length - 1].source.fill).toBe('#000000');
		const b = vectorNodeBounds(n)!;
		expect([b.x, b.y, b.width, b.height].map(Math.round)).toEqual([-10, -10, 120, 120]);
	});

	it('steps to the centre until the shape is used up', () => {
		// 50 in from each side the square is gone: the shape and 4 steps.
		expect(vectorAppearanceShapes(square({ effects: contour({ direction: 'center', offset: 10 }) }))).toHaveLength(1 + 4);
	});

	it('keeps colours with no end colour and bunches the change with acceleration', () => {
		const kept = sorted(square({ fill: '#ff0000', effects: contour({ steps: 2, offset: 5, fillColor: null }) }));
		expect(kept.every((s) => s.source.fill === '#ff0000')).toBe(true);
		const plain = sorted(square({ effects: contour({ steps: 4, offset: 5, fillColor: '#ffffff', acceleration: 0 }) }))[1].source.fill;
		const fast = sorted(square({ effects: contour({ steps: 4, offset: 5, fillColor: '#ffffff', acceleration: -100 }) }))[1].source.fill;
		expect(parseInt(String(fast).slice(1, 3), 16)).toBeGreaterThan(parseInt(String(plain).slice(1, 3), 16));
	});

	it('sanitizes its parameters and is exported to Lottie as drawn', () => {
		const e = createVectorEffect('contour', 'c', { steps: 999, offset: -5, fillColor: 'nope', direction: 'sideways' })!;
		expect(e.params).toMatchObject({ steps: 200, offset: 0.1, fillColor: '#ffffff', direction: 'inside' });
		const { notes } = vectorDocumentToLottie({ width: 100, height: 100, nodes: [square({ effects: contour({ steps: 2 }) })] });
		expect(notes.some((n) => n.includes('contour'))).toBe(true);
	});
});

describe('contour through the tool registry', () => {
	it('is added like any effect, as one undo step', async () => {
		const c = new VectorEditorController({ document: { width: 200, height: 200, nodes: [square()] } });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const r = await tools.callTool('run_command', { id: 'vector.addEffect', params: { ids: ['a'], type: 'contour', params: { steps: 3, offset: 8, fillColor: '#ffcc00' } } });
		expect(r.isError).toBeFalsy();
		expect((c.getNode('a') as VectorPathNode).effects![0]).toMatchObject({ type: 'contour', params: { steps: 3, offset: 8, fillColor: '#ffcc00' } });
		c.undo();
		expect((c.getNode('a') as VectorPathNode).effects ?? []).toHaveLength(0);
	});
});
