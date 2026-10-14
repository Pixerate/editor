import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
	CanvasGuidesLayer,
	measureBetween,
	useCanvasArrange,
	useCanvasMeasure,
	type CanvasNode
} from '../src/canvas';

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://example.com/editor' });
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
	(globalThis as any).Node = dom.window.Node;
	(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
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

const node = (id: string, x: number, y: number, w: number, h: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({
	id,
	position: { x, y },
	data: { label: id },
	width: w,
	height: h,
	...extra
});

describe('React Canvas - CanvasGuidesLayer measuring', () => {
	it('renders measure lines with labels and dashed extension lines', async () => {
		const guides = measureBetween({ x: 0, y: 0, width: 50, height: 50 }, { x: 100, y: 120, width: 50, height: 30 });
		await act(async () => root.render(<CanvasGuidesLayer guides={guides} viewport={{ x: 0, y: 0, zoom: 2 }} />));
		const lines = [...container.querySelectorAll('line')];
		expect(lines.map((l) => l.getAttribute('data-kind'))).toEqual(['measure', 'extension', 'measure', 'extension']);
		expect(lines[0].getAttribute('stroke')).toBe('#ef4444');
		expect(lines[1].getAttribute('stroke-dasharray')).toBe('3 3');
		expect(lines[0].getAttribute('x1')).toBe('100');
		const labels = [...container.querySelectorAll('.pixerate-canvas-guides__label')];
		expect(labels.map((l) => l.textContent)).toEqual(['50', '70']);
	});
});

describe('React Canvas - useCanvasMeasure', () => {
	it('measures from the selection to the hovered node while Alt is held', async () => {
		const ref: { measure: ReturnType<typeof useCanvasMeasure> | null } = { measure: null };
		const nodes = [node('a', 0, 0, 50, 50, { selected: true }), node('b', 100, 0, 50, 50)];
		function Test() {
			ref.measure = useCanvasMeasure({ nodes });
			return <CanvasGuidesLayer guides={ref.measure.guides} />;
		}
		await act(async () => root.render(<Test />));
		await act(async () => ref.measure!.onNodeMouseEnter(null, { id: 'b' }));
		expect(ref.measure!.guides).toEqual([]);
		await act(async () => {
			window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Alt', altKey: true }));
		});
		expect(ref.measure!.active).toBe(true);
		expect(ref.measure!.guides.map((g) => g.label)).toEqual(['50']);
		expect(ref.measure!.target).toEqual({ x: 100, y: 0, width: 50, height: 50 });
		expect(container.querySelector('.pixerate-canvas-guides__label')!.textContent).toBe('50');
		await act(async () => {
			window.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Alt', altKey: false }));
		});
		expect(ref.measure!.guides).toEqual([]);
		expect(container.querySelector('svg')).toBeNull();
		// A pointer event with altKey turns it on too; leaving the node clears the hover.
		await act(async () => ref.measure!.onNodeMouseEnter({ altKey: true }, { id: 'b' }));
		expect(ref.measure!.guides).toHaveLength(1);
		await act(async () => ref.measure!.onNodeMouseLeave(null, { id: 'b' }));
		expect(ref.measure!.hoveredId).toBeNull();
		expect(ref.measure!.guides).toEqual([]);
	});

	it('measures to the parent and can run without the modifier', async () => {
		const ref: { measure: ReturnType<typeof useCanvasMeasure> | null } = { measure: null };
		const nodes = [node('f', 0, 0, 200, 100), node('r', 20, 30, 40, 20, { parentId: 'f', selected: true })];
		function Test() {
			ref.measure = useCanvasMeasure({ nodes, requireModifier: false });
			return null;
		}
		await act(async () => root.render(<Test />));
		expect(ref.measure!.guides.map((g) => g.label).sort()).toEqual(['140', '20', '30', '50']);
	});
});

describe('React Canvas - useCanvasArrange resize snapping', () => {
	it('snaps NodeResizer dimension changes to other nodes', async () => {
		const ref: { arrange: ReturnType<typeof useCanvasArrange> | null } = { arrange: null };
		function Test() {
			const [nodes, setNodes] = useState([node('a', 0, 0, 50, 50), node('b', 100, 0, 50, 80)]);
			ref.arrange = useCanvasArrange({ nodes, setNodes, guides: { gridSize: 10 } });
			return <CanvasGuidesLayer guides={ref.arrange.guides} />;
		}
		await act(async () => root.render(<Test />));
		let out: any[] = [];
		await act(async () => {
			out = ref.arrange!.snapResizeChanges([
				{ id: 'a', type: 'dimensions', resizing: true, dimensions: { width: 50, height: 77 } }
			]);
		});
		expect(out[0].dimensions).toEqual({ width: 50, height: 80 });
		expect(container.querySelectorAll('line')).toHaveLength(1);
		// Out of reach of the other node: the grid takes over.
		await act(async () => {
			out = ref.arrange!.snapResizeChanges([
				{ id: 'a', type: 'dimensions', resizing: true, dimensions: { width: 50, height: 63 } }
			]);
		});
		expect(out[0].dimensions).toEqual({ width: 50, height: 60 });
		await act(async () => {
			out = ref.arrange!.snapResizeChanges([{ id: 'a', type: 'dimensions', resizing: false, dimensions: { width: 50, height: 63 } }]);
		});
		expect(out[0].dimensions).toEqual({ width: 50, height: 60 });
		expect(container.querySelector('svg')).toBeNull();
	});
});
