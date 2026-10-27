import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync } from 'svelte';
import { ToolRegistry } from '@pixerate/editor/tools';
import {
	calculateDirectionalDisplacement,
	canvasExplosionToolTarget,
	createCanvasExplosion,
	createCanvasExplosionState,
	createCanvasExplosionToolProvider,
	createCanvasGraph,
	explosionEdgeId,
	type CanvasNode
} from '../../src/canvas/index.js';

const node = (id: string, x: number, y: number, w = 100, h = 40, data: Record<string, any> = {}): CanvasNode => ({
	id,
	position: { x, y },
	measured: { width: w, height: h },
	data
});

describe('createCanvasExplosionState (Svelte rune)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('explodes, collapses through a timed collapsing phase, and toggles', () => {
		const onExplode = vi.fn();
		const onCollapse = vi.fn();
		const state = createCanvasExplosionState({ collapseDurationMs: 380, onExplode, onCollapse });
		expect(state.activeId).toBeNull();
		expect(state.isExplodingOrCollapsing).toBe(false);

		state.explode('a');
		expect(state.activeId).toBe('a');
		expect(state.isExploded('a')).toBe(true);
		expect(state.shouldRenderChildren('a')).toBe(true);
		expect(onExplode).toHaveBeenCalledWith('a');

		state.collapse('a');
		expect(state.activeId).toBeNull();
		expect(state.collapsingId).toBe('a');
		expect(state.isCollapsing('a')).toBe(true);
		expect(state.shouldRenderChildren('a')).toBe(true);
		expect(onCollapse).toHaveBeenCalledWith('a');

		vi.advanceTimersByTime(380);
		expect(state.collapsingId).toBeNull();
		expect(state.shouldRenderChildren('a')).toBe(false);

		expect(state.toggle('b')).toBe(true);
		expect(state.toggle('b')).toBe(false);
		expect(state.collapsingId).toBe('b');
		state.destroy();
	});

	it('cancels a pending collapse on rapid re-explode and cleans up on destroy', () => {
		const state = createCanvasExplosionState({ collapseDurationMs: 200 });
		state.explode('a');
		state.collapse();
		state.explode('b');
		expect(state.activeId).toBe('b');
		expect(state.collapsingId).toBeNull();
		state.collapse();
		expect(vi.getTimerCount()).toBe(1);
		state.destroy();
		expect(vi.getTimerCount()).toBe(0);
		expect(state.controller.destroyed).toBe(true);
	});

	it('drives a $derived displacement declaratively', () => {
		const origin = node('o', 0, 120);
		const rows = [origin, node('above', 0, 80), node('below', 0, 160)];
		const children = [node('child', 0, 170, 100, 40)];
		const cleanup = $effect.root(() => {
			const state = createCanvasExplosionState({ collapseDurationMs: 0 });
			const displaced = $derived.by(() => {
				if (!state.activeId) return new Map();
				return calculateDirectionalDisplacement({
					existingNodes: rows,
					originNode: rows.find((n) => n.id === state.activeId)!,
					childNodes: children,
					options: { direction: 'vertical', layoutMode: 'row-lane', rowSpacing: 40, gap: 0, minY: 0 }
				});
			});
			const current = () => displaced;
			expect(current().size).toBe(0);
			state.explode('o');
			flushSync();
			// deltaDown 50 rounds up to two 40px lanes
			expect(current().get('below')).toEqual({ x: 0, y: 240 });
			state.collapse();
			flushSync();
			expect(current().size).toBe(0);
		});
		cleanup();
	});

	it('exposes explode/collapse to agents through the tool provider', async () => {
		const state = createCanvasExplosionState({ collapseDurationMs: 0 });
		const registry = new ToolRegistry();
		registry.register(createCanvasExplosionToolProvider(canvasExplosionToolTarget(state, { getNodes: () => [node('task', 0, 0)] }), { namespace: '' }));
		const result = await registry.callTool('explode_node', { node: 'task' });
		expect(result.structuredContent).toEqual({ node: 'task', changed: true, exploded: ['task'], collapsed: [] });
		expect(state.activeId).toBe('task');
		const bad = await registry.callTool('collapse_node', { node: 'other' });
		expect(bad.isError).toBe(true);
		state.destroy();
	});
});

describe('createCanvasExplosion (imperative coordinator) on the shared layout', () => {
	it('adds copies of the children with deterministic parent edges, leaving the caller objects untouched', () => {
		const graph = createCanvasGraph({ initialNodes: [node('o', 0, 0), node('d', 300, 0)] });
		const explosion = createCanvasExplosion(graph);
		const children = [node('c1', 150, -40, 100, 40, { label: 'one' })];
		const before = JSON.stringify(children);
		explosion.explodeNode('o', { childNodes: children, duration: 0, directionalOptions: { direction: 'right', gap: 20 } });
		expect(JSON.stringify(children)).toBe(before);
		expect(graph.nodes.find((n) => n.id === 'c1')!.position).toEqual({ x: 150, y: -40 });
		expect(graph.edges.map((e) => e.id)).toContain(explosionEdgeId('o', 'c1'));
		expect(graph.nodes.find((n) => n.id === 'd')!.position.x).toBe(420);
		expect(explosion.getSnapshot('o')!.displacedNodes).toEqual([{ id: 'd', originalPosition: { x: 300, y: 0 } }]);
	});

	it('throws when a child id is already on the canvas', () => {
		const graph = createCanvasGraph({ initialNodes: [node('o', 0, 0), node('d', 300, 0)] });
		const explosion = createCanvasExplosion(graph);
		expect(() => explosion.explodeNode('o', { childNodes: [node('d', 0, 0)], duration: 0 })).toThrow(/already on the canvas/);
		expect(explosion.isExploded('o')).toBe(false);
	});

	it('honours minY through the shared displacement', () => {
		const graph = createCanvasGraph({ initialNodes: [node('o', 0, 400), node('top', 0, 100)] });
		const explosion = createCanvasExplosion(graph);
		explosion.explodeNode('o', {
			childNodes: [node('c', 0, 100, 100, 600)],
			duration: 0,
			connectParentToChildren: false,
			directionalOptions: { direction: 'vertical', gap: 0, minY: 60 }
		});
		expect(graph.nodes.find((n) => n.id === 'top')!.position).toEqual({ x: 0, y: 60 });
	});
});
