import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { HistoryManager } from '@pixerate/editor/history';
import {
	createCanvasArrange,
	createCanvasArrangeShortcuts
} from '../../src/canvas/createCanvasArrange.svelte.js';
import { createCanvasScenes } from '../../src/canvas/createCanvasScenes.svelte.js';
import CanvasGuidesLayer from '../../src/canvas/CanvasGuidesLayer.svelte';
import { isLocked } from '../../src/canvas/index.js';
import type { CanvasNode } from '../../src/canvas/types.js';

const node = (id: string, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode =>
	({ id, position: { x, y }, data: { label: id }, width: 100, height: 50, ...extra }) as CanvasNode;

function setup(initial: CanvasNode[], history?: HistoryManager) {
	let nodes = initial;
	const arrange = createCanvasArrange({
		getNodes: () => nodes,
		setNodes: (next) => {
			nodes = next;
		},
		history
	});
	return { arrange, get nodes() { return nodes; }, set nodes(n) { nodes = n; } };
}

const find = (nodes: CanvasNode[], id: string) => nodes.find((n) => n.id === id)!;

let cleanup: (() => void) | null = null;
afterEach(() => {
	cleanup?.();
	cleanup = null;
});

describe('createCanvasArrange (Svelte rune)', () => {
	it('aligns, distributes and matches sizes of the selection', () => {
		const ctx = setup([
			node('a', 0, 0, { selected: true }),
			node('b', 130, 40, { selected: true, width: 200 }),
			node('c', 600, 10, { selected: true })
		]);
		ctx.arrange.align('top');
		expect(ctx.nodes.map((n) => n.position.y)).toEqual([0, 0, 0]);
		ctx.arrange.distribute('horizontal');
		// span 0..700, sizes 400 -> gap 150
		expect(find(ctx.nodes, 'b').position.x).toBe(250);
		ctx.arrange.matchSize('width');
		expect(find(ctx.nodes, 'a').width).toBe(200);
	});

	it('locks, unlocks and keeps locked nodes in place', () => {
		const ctx = setup([node('a', 0, 0), node('b', 50, 100)]);
		ctx.arrange.lock(['b']);
		expect(isLocked(find(ctx.nodes, 'b'))).toBe(true);
		expect(find(ctx.nodes, 'b').draggable).toBe(false);
		ctx.arrange.align('left', ['a', 'b']);
		expect(find(ctx.nodes, 'b').position.x).toBe(50);
		expect(find(ctx.nodes, 'a').position.x).toBe(0);
		ctx.arrange.unlock(['b']);
		expect(ctx.arrange.isLocked('b')).toBe(false);
	});

	it('restacks nodes and records undoable steps in a HistoryManager', () => {
		const history = new HistoryManager();
		const ctx = setup([node('a', 0, 0), node('b', 10, 10)], history);
		ctx.arrange.bringToFront(['a']);
		expect(find(ctx.nodes, 'a').zIndex).toBe(1);
		history.undo();
		expect(find(ctx.nodes, 'a').zIndex).toBe(0);
		expect(history.getState().canRedo).toBe(true);
	});

	it('exposes reactive guides while dragging and clears them on drop', () => {
		const ctx = setup([node('a', 0, 0), node('b', 104, 200)]);
		ctx.arrange.beginDrag(['b']);
		ctx.arrange.drag(['b']);
		expect(find(ctx.nodes, 'b').position.x).toBe(100);
		expect(ctx.arrange.guides.length).toBeGreaterThan(0);
		ctx.arrange.endDrag();
		expect(ctx.arrange.guides).toEqual([]);
	});

	it('handles keyboard shortcuts but not while typing', () => {
		const ctx = setup([node('a', 0, 0, { selected: true }), node('b', 50, 100, { selected: true })]);
		const scenes = { next: vi.fn(), previous: vi.fn() };
		const target = document.createElement('div');
		const input = document.createElement('input');
		target.appendChild(input);
		const detach = createCanvasArrangeShortcuts({ arrange: ctx.arrange, scenes, targetElement: target });

		input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', altKey: true, bubbles: true }));
		expect(find(ctx.nodes, 'b').position.x).toBe(50);

		const event = new KeyboardEvent('keydown', { code: 'KeyA', altKey: true, bubbles: true, cancelable: true });
		target.dispatchEvent(event);
		expect(find(ctx.nodes, 'b').position.x).toBe(0);
		expect(event.defaultPrevented).toBe(true);

		target.dispatchEvent(new KeyboardEvent('keydown', { code: 'PageDown', bubbles: true }));
		expect(scenes.next).toHaveBeenCalledTimes(1);

		detach();
		target.dispatchEvent(new KeyboardEvent('keydown', { code: 'PageUp', bubbles: true }));
		expect(scenes.previous).not.toHaveBeenCalled();
	});
});

describe('createCanvasScenes (Svelte rune)', () => {
	it('captures, navigates and persists scenes, moving the viewport', () => {
		let viewport = { x: 0, y: 0, zoom: 1 };
		const setViewport = vi.fn();
		const scenes = createCanvasScenes({ getViewport: () => viewport, setViewport, duration: 0 });
		const first = scenes.capture();
		viewport = { x: 100, y: 50, zoom: 2 };
		const second = scenes.capture('Close-up');
		expect(scenes.scenes.map((s) => s.name)).toEqual(['Scene 1', 'Close-up']);
		expect(scenes.current?.id).toBe(second.id);

		scenes.previous();
		expect(scenes.currentId).toBe(first.id);
		expect(setViewport).toHaveBeenLastCalledWith({ x: 0, y: 0, zoom: 1 }, { duration: 0 });

		scenes.rename(first.id, 'Overview');
		scenes.move(second.id, 0);
		expect(scenes.scenes.map((s) => s.name)).toEqual(['Close-up', 'Overview']);
		expect(scenes.currentIndex).toBe(1);

		viewport = { x: 1, y: 2, zoom: 3 };
		scenes.recapture(first.id);
		expect(scenes.store.getScene(first.id)!.viewport).toEqual(viewport);

		const json = scenes.serialize();
		const restored = createCanvasScenes();
		restored.load(json);
		expect(restored.scenes.map((s) => s.name)).toEqual(['Close-up', 'Overview']);

		scenes.remove(second.id);
		expect(scenes.scenes).toHaveLength(1);
	});

	it('captures a scene framing nodes and requires a viewport source', () => {
		const scenes = createCanvasScenes();
		const scene = scenes.captureNodes([node('a', 0, 0), node('b', 400, 0)], ['a'], { width: 200, height: 100 }, 'A', { padding: 0 });
		expect(scene).toMatchObject({ name: 'A', nodeIds: ['a'], viewport: { zoom: 2 } });
		expect(() => scenes.capture()).toThrow();
	});
});

describe('CanvasGuidesLayer (Svelte component)', () => {
	it('renders guides in screen space and nothing without guides', () => {
		const target = document.createElement('div');
		document.body.appendChild(target);
		const component = mount(CanvasGuidesLayer, {
			target,
			props: {
				guides: [
					{ orientation: 'vertical', kind: 'edge', x1: 100, y1: 0, x2: 100, y2: 50 },
					{ orientation: 'horizontal', kind: 'spacing', x1: 0, y1: 10, x2: 20, y2: 10 }
				],
				viewport: { x: 10, y: 20, zoom: 2 }
			}
		});
		flushSync();
		cleanup = () => {
			unmount(component);
			target.remove();
		};
		const lines = target.querySelectorAll('line');
		expect(lines).toHaveLength(2);
		expect(lines[0].getAttribute('x1')).toBe('210');
		expect(lines[0].getAttribute('y2')).toBe('120');
		expect(lines[1].getAttribute('data-kind')).toBe('spacing');

		const empty = document.createElement('div');
		const none = mount(CanvasGuidesLayer, { target: empty, props: { guides: [] } });
		flushSync();
		expect(empty.querySelector('svg')).toBeNull();
		unmount(none);
	});
});
