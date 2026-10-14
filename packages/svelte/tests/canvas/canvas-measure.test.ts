import { describe, it, expect, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { createCanvasMeasure } from '../../src/canvas/createCanvasMeasure.svelte.js';
import { createCanvasArrange } from '../../src/canvas/createCanvasArrange.svelte.js';
import CanvasGuidesLayer from '../../src/canvas/CanvasGuidesLayer.svelte';
import { lockNodes, measureBetween } from '../../src/canvas/index.js';
import type { CanvasNode } from '../../src/canvas/types.js';

const node = (id: string, x: number, y: number, w: number, h: number, extra: Partial<CanvasNode> = {}): CanvasNode =>
	({ id, position: { x, y }, data: { label: id }, width: w, height: h, ...extra }) as CanvasNode;

let cleanup: (() => void) | null = null;
afterEach(() => {
	cleanup?.();
	cleanup = null;
});

describe('CanvasGuidesLayer measuring (Svelte component)', () => {
	it('renders measure lines with labels and dashed extension lines', () => {
		const target = document.createElement('div');
		document.body.appendChild(target);
		const guides = measureBetween({ x: 0, y: 0, width: 50, height: 50 }, { x: 100, y: 120, width: 50, height: 30 });
		const component = mount(CanvasGuidesLayer, { target, props: { guides, viewport: { x: 0, y: 0, zoom: 2 } } });
		flushSync();
		cleanup = () => {
			unmount(component);
			target.remove();
		};
		const lines = [...target.querySelectorAll('line')];
		expect(lines.map((l) => l.getAttribute('data-kind'))).toEqual(['measure', 'extension', 'measure', 'extension']);
		expect(lines[0].getAttribute('stroke')).toBe('#ef4444');
		expect(lines[1].getAttribute('stroke-dasharray')).toBe('3 3');
		expect(lines[0].getAttribute('x1')).toBe('100');
		const labels = [...target.querySelectorAll('.pixerate-canvas-guides__label')];
		expect(labels.map((l) => l.textContent)).toEqual(['50', '70']);
	});
});

describe('createCanvasMeasure (Svelte rune)', () => {
	it('measures from the selection to the hovered node while Alt is held', () => {
		const nodes = [node('a', 0, 0, 50, 50, { selected: true }), node('b', 100, 0, 50, 50)];
		const measure = createCanvasMeasure({ getNodes: () => nodes });
		const stop = measure.listen(window);
		cleanup = stop;
		measure.onnodepointerenter({ node: { id: 'b' } });
		expect(measure.guides).toEqual([]);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true }));
		expect(measure.active).toBe(true);
		expect(measure.guides.map((g) => g.label)).toEqual(['50']);
		expect(measure.target).toEqual({ x: 100, y: 0, width: 50, height: 50 });
		window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', altKey: false }));
		expect(measure.guides).toEqual([]);
		measure.onnodepointerenter({ node: { id: 'b' }, event: { altKey: true } });
		expect(measure.guides).toHaveLength(1);
		measure.onnodepointerleave({ node: { id: 'b' } });
		expect(measure.hoveredId).toBeNull();
		expect(measure.guides).toEqual([]);
		window.dispatchEvent(new Event('blur'));
		expect(measure.active).toBe(false);
	});

	it('measures to the parent and can run without the modifier', () => {
		const nodes = [node('f', 0, 0, 200, 100), node('r', 20, 30, 40, 20, { parentId: 'f', selected: true })];
		const measure = createCanvasMeasure({ getNodes: () => nodes, requireModifier: false });
		expect(measure.guides.map((g) => g.label).sort()).toEqual(['140', '20', '30', '50']);
		const off = createCanvasMeasure({ getNodes: () => nodes, requireModifier: false, enabled: false });
		expect(off.guides).toEqual([]);
	});
});

describe('createCanvasArrange resize snapping (Svelte rune)', () => {
	const setup = (initial: CanvasNode[]) => {
		let nodes = initial;
		const arrange = createCanvasArrange({ getNodes: () => nodes, setNodes: (next) => (nodes = next) });
		return {
			arrange,
			get nodes() {
				return nodes;
			},
			resizeTo: (id: string, patch: Partial<CanvasNode>) => {
				nodes = nodes.map((n) => (n.id === id ? { ...n, ...patch } : n));
			}
		};
	};

	it('snaps after NodeResizer writes the raw size and keeps the snap on resize end', async () => {
		const ctx = setup([node('a', 0, 0, 50, 50), node('b', 100, 0, 50, 80)]);
		const handlers = ctx.arrange.resizerHandlers('a');
		handlers.onResizeStart();
		// SvelteFlow calls onResize, then writes the raw size to the nodes.
		handlers.onResize();
		ctx.resizeTo('a', { height: 77 });
		await Promise.resolve();
		expect(ctx.nodes[0].height).toBe(80);
		expect(ctx.arrange.guides).toHaveLength(1);
		handlers.onResizeEnd();
		await Promise.resolve();
		expect(ctx.arrange.guides).toEqual([]);
		expect(ctx.nodes[0].height).toBe(80);
	});

	it('keeps locked nodes at their starting size', async () => {
		const ctx = setup(lockNodes([node('a', 0, 0, 50, 50), node('b', 100, 0, 50, 80)], ['a']));
		const handlers = ctx.arrange.resizerHandlers('a');
		handlers.onResizeStart();
		handlers.onResize();
		ctx.resizeTo('a', { width: 90 });
		await Promise.resolve();
		expect(ctx.nodes[0].width).toBe(50);
	});
});
