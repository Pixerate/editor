import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HistoryManager } from '@pixerate/editor/history';
import { useCanvasArrange, ShapeNode, isShapeNode, lockNodes, type CanvasNode } from '../src/canvas';

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://example.com/editor' });
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
	(globalThis as any).Node = dom.window.Node;
	(globalThis as any).HTMLElement = dom.window.HTMLElement;
});

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

const shape = (id: string, x: number, y: number, s: any, extra: Partial<CanvasNode> = {}): CanvasNode => ({
	id,
	type: 'shape',
	position: { x, y },
	width: 100,
	height: 100,
	selected: true,
	data: { shape: s },
	...extra
});

function renderArrange(initial: CanvasNode[], history?: HistoryManager) {
	const ref: { arrange: ReturnType<typeof useCanvasArrange> | null; nodes: CanvasNode[] } = { arrange: null, nodes: initial };
	function Test() {
		const [nodes, setNodes] = useState(initial);
		ref.nodes = nodes;
		ref.arrange = useCanvasArrange({ nodes, setNodes, history });
		return null;
	}
	return { ref, Test };
}

describe('useCanvasArrange shape operations', () => {
	it('unites the selected shapes as one undoable step', async () => {
		const history = new HistoryManager();
		const { ref, Test } = renderArrange(
			[shape('a', 0, 0, { kind: 'rect', fill: 'red' }), shape('b', 50, 0, { kind: 'ellipse' })],
			history
		);
		await act(async () => root.render(<Test />));
		expect(ref.arrange!.canCombineShapes()).toBe(true);
		let result: any;
		await act(async () => {
			result = ref.arrange!.unite(undefined, { createId: () => 'u' });
		});
		expect(result.ok).toBe(true);
		expect(ref.nodes.map((n) => n.id)).toEqual(['u']);
		expect(ref.nodes[0]).toMatchObject({ position: { x: 0, y: 0 }, width: 150, height: 100 });
		expect(ref.nodes[0].data.shape).toMatchObject({ kind: 'path', fill: 'red' });
		expect(isShapeNode(ref.nodes[0])).toBe(true);
		await act(async () => history.undo());
		expect(ref.nodes.map((n) => n.id)).toEqual(['a', 'b']);
		await act(async () => history.redo());
		expect(ref.nodes.map((n) => n.id)).toEqual(['u']);
	});

	it('divides into several nodes and refuses locked shapes', async () => {
		const initial = [shape('a', 0, 0, { kind: 'rect' }), shape('b', 50, 50, { kind: 'rect' })];
		const { ref, Test } = renderArrange(initial);
		await act(async () => root.render(<Test />));
		await act(async () => {
			ref.arrange!.divide();
		});
		expect(ref.nodes).toHaveLength(3);

		const locked = renderArrange(lockNodes(initial, ['a']));
		await act(async () => root.render(<locked.Test />));
		let refusal: any;
		await act(async () => {
			refusal = locked.ref.arrange!.combineShapes('subtract');
		});
		expect(refusal).toMatchObject({ ok: false, reason: 'locked' });
		expect(locked.ref.nodes.map((n) => n.id)).toEqual(['a', 'b']);
	});
});

describe('ShapeNode', () => {
	it('renders the shape path scaled to the node size with paint', async () => {
		await act(async () =>
			root.render(
				<ShapeNode
					data={{ shape: { kind: 'rect', fill: 'tomato', stroke: '#000', strokeWidth: 2, opacity: 0.5 } }}
					width={80}
					height={40}
					selected
				>
					<span className="label">Hi</span>
				</ShapeNode>
			)
		);
		const wrapper = container.querySelector('.pixerate-shape-node')!;
		expect(wrapper.getAttribute('data-shape-kind')).toBe('rect');
		expect(wrapper.getAttribute('data-selected')).toBe('true');
		const svg = container.querySelector('svg')!;
		expect(svg.getAttribute('viewBox')).toBe('0 0 80 40');
		expect(svg.getAttribute('preserveAspectRatio')).toBe('none');
		const path = container.querySelector('path')!;
		expect(path.getAttribute('d')).toBe('M0 0H80V40H0Z');
		expect(path.getAttribute('fill')).toBe('tomato');
		expect(path.getAttribute('stroke')).toBe('#000');
		expect(path.getAttribute('stroke-width')).toBe('2');
		expect(path.getAttribute('opacity')).toBe('0.5');
		expect(path.getAttribute('vector-effect')).toBe('non-scaling-stroke');
		expect(container.querySelector('.label')?.textContent).toBe('Hi');
	});

	it('renders path shapes with their view box transform and fill rule, and nothing without a shape', async () => {
		await act(async () =>
			root.render(
				<ShapeNode
					data={{ shape: { kind: 'path', d: 'M0 0H10V10Z', viewBox: [0, 0, 10, 10], fillRule: 'evenodd' } }}
					width={20}
					height={30}
				/>
			)
		);
		const path = container.querySelector('path')!;
		expect(path.getAttribute('transform')).toBe('scale(2 3) translate(0 0)');
		expect(path.getAttribute('fill-rule')).toBe('evenodd');
		expect(path.getAttribute('fill')).toBe('currentColor');
		await act(async () => root.render(<ShapeNode data={{ label: 'no shape' }} />));
		expect(container.innerHTML).toBe('');
	});
});
