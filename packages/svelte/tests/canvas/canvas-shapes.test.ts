import { describe, it, expect } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { HistoryManager } from '@pixerate/editor/history';
import { createCanvasArrange } from '../../src/canvas/createCanvasArrange.svelte.js';
import ShapeNode from '../../src/canvas/ShapeNode.svelte';
import { isShapeNode, lockNodes } from '../../src/canvas/index.js';
import type { CanvasNode } from '../../src/canvas/types.js';

const shape = (id: string, x: number, y: number, s: any, extra: Partial<CanvasNode> = {}): CanvasNode =>
	({
		id,
		type: 'shape',
		position: { x, y },
		width: 100,
		height: 100,
		selected: true,
		data: { shape: s },
		...extra
	}) as CanvasNode;

function setup(initial: CanvasNode[], history?: HistoryManager) {
	let nodes = initial;
	const arrange = createCanvasArrange({
		getNodes: () => nodes,
		setNodes: (next) => {
			nodes = next;
		},
		history
	});
	return { arrange, get nodes() { return nodes; } };
}

describe('createCanvasArrange shape operations (Svelte rune)', () => {
	it('unites the selected shapes as one undoable step', () => {
		const history = new HistoryManager();
		const ctx = setup([shape('a', 0, 0, { kind: 'rect', fill: 'red' }), shape('b', 50, 0, { kind: 'ellipse' })], history);
		expect(ctx.arrange.canCombineShapes()).toBe(true);
		const result = ctx.arrange.unite(undefined, { createId: () => 'u' });
		expect(result.ok).toBe(true);
		expect(ctx.nodes.map((n) => n.id)).toEqual(['u']);
		expect(ctx.nodes[0]).toMatchObject({ position: { x: 0, y: 0 }, width: 150, height: 100 });
		expect(ctx.nodes[0].data.shape).toMatchObject({ kind: 'path', fill: 'red' });
		expect(isShapeNode(ctx.nodes[0])).toBe(true);
		history.undo();
		expect(ctx.nodes.map((n) => n.id)).toEqual(['a', 'b']);
		history.redo();
		expect(ctx.nodes.map((n) => n.id)).toEqual(['u']);
	});

	it('runs intersect / subtract / exclude / divide and refuses locked shapes', () => {
		const initial = [shape('a', 0, 0, { kind: 'rect' }), shape('b', 50, 50, { kind: 'rect' })];
		expect(setup(initial).arrange.intersect().ok).toBe(true);
		expect(setup(initial).arrange.subtract().ok).toBe(true);
		expect(setup(initial).arrange.exclude().ok).toBe(true);
		const divided = setup(initial);
		divided.arrange.divide();
		expect(divided.nodes).toHaveLength(3);

		const locked = setup(lockNodes(initial, ['a']) as CanvasNode[]);
		expect(locked.arrange.combineShapes('unite')).toMatchObject({ ok: false, reason: 'locked' });
		expect(locked.nodes.map((n) => n.id)).toEqual(['a', 'b']);
	});
});

describe('ShapeNode (Svelte)', () => {
	it('renders the shape path scaled to the node size with paint', () => {
		const target = document.createElement('div');
		document.body.appendChild(target);
		const component = mount(ShapeNode, {
			target,
			props: {
				data: { shape: { kind: 'rect', fill: 'tomato', stroke: '#000', strokeWidth: 2, opacity: 0.5 } },
				width: 80,
				height: 40,
				selected: true
			}
		});
		flushSync();
		try {
			const wrapper = target.querySelector('.pixerate-shape-node')!;
			expect(wrapper.getAttribute('data-shape-kind')).toBe('rect');
			expect(wrapper.getAttribute('data-selected')).toBe('true');
			const svg = target.querySelector('svg')!;
			expect(svg.getAttribute('viewBox')).toBe('0 0 80 40');
			expect(svg.getAttribute('preserveAspectRatio')).toBe('none');
			const path = target.querySelector('path')!;
			expect(path.getAttribute('d')).toBe('M0 0H80V40H0Z');
			expect(path.getAttribute('fill')).toBe('tomato');
			expect(path.getAttribute('stroke')).toBe('#000');
			expect(path.getAttribute('stroke-width')).toBe('2');
			expect(path.getAttribute('opacity')).toBe('0.5');
			expect(path.getAttribute('vector-effect')).toBe('non-scaling-stroke');
		} finally {
			unmount(component);
			target.remove();
		}
	});

	it('renders path shapes with their view box transform, and nothing without a shape', () => {
		const target = document.createElement('div');
		document.body.appendChild(target);
		const component = mount(ShapeNode, {
			target,
			props: {
				data: { shape: { kind: 'path', d: 'M0 0H10V10Z', viewBox: [0, 0, 10, 10], fillRule: 'evenodd' } },
				width: 20,
				height: 30
			}
		});
		flushSync();
		const path = target.querySelector('path')!;
		expect(path.getAttribute('transform')).toBe('scale(2 3) translate(0 0)');
		expect(path.getAttribute('fill-rule')).toBe('evenodd');
		expect(path.getAttribute('fill')).toBe('currentColor');
		unmount(component);

		const empty = mount(ShapeNode, { target, props: { data: { label: 'none' } } });
		flushSync();
		expect(target.querySelector('svg')).toBeNull();
		unmount(empty);
		target.remove();
	});
});
