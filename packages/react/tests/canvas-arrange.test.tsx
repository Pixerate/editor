import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HistoryManager } from '@pixerate/editor/history';
import {
	useCanvasArrange,
	useCanvasArrangeShortcuts,
	useCanvasScenes,
	CanvasGuidesLayer,
	isLocked,
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

const node = (id: string, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({
	id,
	position: { x, y },
	data: { label: id },
	width: 100,
	height: 50,
	...extra
});

function renderArrange(initial: CanvasNode[], extra: { history?: HistoryManager; zoom?: number } = {}) {
	const ref: { arrange: ReturnType<typeof useCanvasArrange> | null; nodes: CanvasNode[] } = { arrange: null, nodes: initial };
	function Test() {
		const [nodes, setNodes] = useState(initial);
		ref.nodes = nodes;
		ref.arrange = useCanvasArrange({ nodes, setNodes, ...extra });
		return null;
	}
	return { ref, Test };
}

const find = (nodes: CanvasNode[], id: string) => nodes.find((n) => n.id === id)!;

describe('React Canvas - useCanvasArrange', () => {
	it('aligns, distributes, sizes and restacks the selection', async () => {
		const { ref, Test } = renderArrange([
			node('a', 0, 0, { selected: true }),
			node('b', 130, 40, { selected: true, width: 200 }),
			node('c', 600, 10, { selected: true })
		]);
		await act(async () => root.render(<Test />));
		await act(async () => {
			ref.arrange!.align('top');
		});
		expect(ref.nodes.map((n) => n.position.y)).toEqual([0, 0, 0]);
		await act(async () => {
			// Consecutive actions in one tick see each other's results.
			ref.arrange!.distribute('horizontal');
			ref.arrange!.matchSize('width');
		});
		expect(find(ref.nodes, 'b').position.x).toBe(250);
		expect(find(ref.nodes, 'a').width).toBe(200);
		await act(async () => {
			ref.arrange!.sendToBack(['c']);
		});
		expect(find(ref.nodes, 'c').zIndex ?? 0).toBe(0);
		expect(find(ref.nodes, 'a').zIndex).toBe(1);
	});

	it('locks nodes and integrates with HistoryManager undo', async () => {
		const history = new HistoryManager();
		const { ref, Test } = renderArrange([node('a', 0, 0), node('b', 50, 100)], { history });
		await act(async () => root.render(<Test />));
		await act(async () => {
			ref.arrange!.lock(['b']);
		});
		expect(isLocked(find(ref.nodes, 'b'))).toBe(true);
		await act(async () => {
			ref.arrange!.align('left', ['a', 'b']);
		});
		expect(find(ref.nodes, 'b').position.x).toBe(50);
		await act(async () => {
			history.undo();
		});
		expect(isLocked(find(ref.nodes, 'b'))).toBe(false);
	});

	it('snaps React Flow position changes and exposes guides', async () => {
		const { ref, Test } = renderArrange([node('a', 0, 0), node('b', 300, 300)], { zoom: 2 });
		await act(async () => root.render(<Test />));
		let changes: any[] = [];
		await act(async () => {
			changes = ref.arrange!.snapPositionChanges([{ type: 'position', id: 'b', position: { x: 102, y: 200 }, dragging: true }]);
		});
		expect(changes[0].position).toEqual({ x: 100, y: 200 });
		expect(ref.arrange!.guides.length).toBeGreaterThan(0);
		// 4 flow units is beyond the 3-unit threshold at zoom 2.
		await act(async () => {
			changes = ref.arrange!.snapPositionChanges([{ type: 'position', id: 'b', position: { x: 104, y: 200 }, dragging: true }]);
		});
		expect(changes[0].position).toEqual({ x: 104, y: 200 });
		await act(async () => {
			ref.arrange!.snapPositionChanges([{ type: 'position', id: 'b', dragging: false }]);
		});
		expect(ref.arrange!.guides).toEqual([]);
	});
});

describe('React Canvas - useCanvasArrangeShortcuts', () => {
	it('runs actions from keys but not while typing', async () => {
		const ref: { arrange: ReturnType<typeof useCanvasArrange> | null; nodes: CanvasNode[] } = {
			arrange: null,
			nodes: [node('a', 0, 0, { selected: true }), node('b', 50, 100, { selected: true })]
		};
		const target = document.createElement('div');
		const input = document.createElement('input');
		target.appendChild(input);
		const scenes = { next: vi.fn(), previous: vi.fn() };
		function Host() {
			const [nodes, setNodes] = useState(ref.nodes);
			ref.nodes = nodes;
			ref.arrange = useCanvasArrange({ nodes, setNodes });
			useCanvasArrangeShortcuts({ arrange: ref.arrange, scenes, targetElement: target });
			return null;
		}
		await act(async () => root.render(<Host />));

		await act(async () => {
			input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', altKey: true, bubbles: true }));
		});
		expect(find(ref.nodes, 'b').position.x).toBe(50);

		const event = new KeyboardEvent('keydown', { code: 'KeyA', altKey: true, bubbles: true, cancelable: true });
		await act(async () => {
			target.dispatchEvent(event);
		});
		expect(find(ref.nodes, 'b').position.x).toBe(0);
		expect(event.defaultPrevented).toBe(true);

		await act(async () => {
			target.dispatchEvent(new KeyboardEvent('keydown', { code: 'PageUp', bubbles: true }));
		});
		expect(scenes.previous).toHaveBeenCalledTimes(1);
	});
});

describe('React Canvas - useCanvasScenes', () => {
	it('captures, navigates, reorders and persists scenes', async () => {
		let viewport = { x: 0, y: 0, zoom: 1 };
		const setViewport = vi.fn();
		let scenes: ReturnType<typeof useCanvasScenes> | null = null;
		function Test() {
			scenes = useCanvasScenes({ getViewport: () => viewport, setViewport, duration: 0 });
			return null;
		}
		await act(async () => root.render(<Test />));

		let firstId = '';
		await act(async () => {
			firstId = scenes!.capture().id;
			viewport = { x: 10, y: 20, zoom: 2 };
			scenes!.capture('Detail');
		});
		expect(scenes!.scenes.map((s) => s.name)).toEqual(['Scene 1', 'Detail']);
		expect(scenes!.currentIndex).toBe(1);

		await act(async () => {
			scenes!.previous();
		});
		expect(scenes!.currentId).toBe(firstId);
		expect(setViewport).toHaveBeenLastCalledWith({ x: 0, y: 0, zoom: 1 }, { duration: 0 });

		await act(async () => {
			scenes!.rename(firstId, 'Overview');
			scenes!.move(firstId, 1);
		});
		expect(scenes!.scenes.map((s) => s.name)).toEqual(['Detail', 'Overview']);
		expect(scenes!.current?.name).toBe('Overview');

		const json = scenes!.serialize();
		await act(async () => {
			scenes!.clear();
		});
		expect(scenes!.scenes).toHaveLength(0);
		await act(async () => {
			scenes!.load(json);
		});
		expect(scenes!.scenes.map((s) => s.name)).toEqual(['Detail', 'Overview']);
	});
});

describe('React Canvas - CanvasGuidesLayer', () => {
	it('renders guides transformed by the viewport', async () => {
		await act(async () =>
			root.render(
				<CanvasGuidesLayer
					guides={[{ orientation: 'vertical', kind: 'centre', x1: 100, y1: 0, x2: 100, y2: 50 }]}
					viewport={{ x: 10, y: 20, zoom: 2 }}
				/>
			)
		);
		const line = container.querySelector('line')!;
		expect(line.getAttribute('x1')).toBe('210');
		expect(line.getAttribute('y2')).toBe('120');
		expect(line.getAttribute('stroke-dasharray')).toBe('4 3');
		await act(async () => root.render(<CanvasGuidesLayer guides={[]} />));
		expect(container.querySelector('svg')).toBeNull();
	});
});
