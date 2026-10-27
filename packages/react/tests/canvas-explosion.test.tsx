import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import React, { act, StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ToolRegistry } from '@pixerate/editor/tools';
import {
	calculateDirectionalDisplacement,
	canvasExplosionToolTarget,
	createCanvasExplosionToolProvider,
	explosionEdgeId,
	useCanvasExplosion,
	useCanvasExplosionState,
	type CanvasEdge,
	type CanvasExplosionStateHandle,
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
	vi.useRealTimers();
});

const node = (id: string, x: number, y: number, w = 100, h = 40, data: Record<string, any> = {}): CanvasNode => ({
	id,
	position: { x, y },
	measured: { width: w, height: h },
	data
});

describe('useCanvasExplosionState', () => {
	it('mirrors the Svelte rune: explode, timed collapse, toggle, and cleanup on unmount', async () => {
		vi.useFakeTimers();
		const onExplode = vi.fn();
		let api!: CanvasExplosionStateHandle;
		let renders = 0;
		function Probe() {
			api = useCanvasExplosionState({ collapseDurationMs: 300, onExplode });
			renders++;
			return <span>{api.activeId ?? '-'}|{api.collapsingId ?? '-'}</span>;
		}
		await act(async () => root.render(<StrictMode><Probe /></StrictMode>));
		expect(container.textContent).toBe('-|-');

		await act(async () => void api.explode('a'));
		expect(container.textContent).toBe('a|-');
		expect(api.isExploded('a')).toBe(true);
		expect(api.shouldRenderChildren('a')).toBe(true);
		expect(onExplode).toHaveBeenCalledWith('a');

		await act(async () => void api.collapse());
		expect(container.textContent).toBe('-|a');
		expect(api.isCollapsing('a')).toBe(true);
		expect(api.shouldRenderChildren('a')).toBe(true);

		await act(async () => void vi.advanceTimersByTime(300));
		expect(container.textContent).toBe('-|-');
		expect(api.isExplodingOrCollapsing).toBe(false);

		await act(async () => void api.toggle('b'));
		await act(async () => void api.toggle('b'));
		expect(container.textContent).toBe('-|b');
		// Rapid re-explode cancels the pending collapse
		await act(async () => void api.explode('b'));
		expect(container.textContent).toBe('b|-');
		await act(async () => void api.collapse('b'));
		expect(vi.getTimerCount()).toBe(1);
		await act(async () => root.unmount());
		expect(vi.getTimerCount()).toBe(0);
		root = createRoot(container);
		expect(renders).toBeGreaterThan(0);
	});

	it('drives a declarative layout with useMemo', async () => {
		const rows = [node('o', 0, 120), node('above', 0, 80), node('below', 0, 160)];
		let api!: CanvasExplosionStateHandle;
		function Gantt() {
			api = useCanvasExplosionState({ collapseDurationMs: 0 });
			const displaced = useMemo(() => {
				const origin = rows.find((n) => n.id === api.activeId);
				if (!origin) return new Map();
				return calculateDirectionalDisplacement({
					existingNodes: rows,
					originNode: origin,
					childNodes: [node('child', 0, 170, 100, 40)],
					options: { direction: 'vertical', layoutMode: 'row-lane', rowSpacing: 40, gap: 0 }
				});
			}, [api.activeId]);
			return <span>{displaced.get('below')?.y ?? 'none'}</span>;
		}
		await act(async () => root.render(<Gantt />));
		expect(container.textContent).toBe('none');
		await act(async () => void api.explode('o'));
		expect(container.textContent).toBe('240');
		await act(async () => void api.collapse());
		expect(container.textContent).toBe('none');
	});

	it('reaches agents through the explosion tool provider', async () => {
		let api!: CanvasExplosionStateHandle;
		function Probe() {
			api = useCanvasExplosionState({ collapseDurationMs: 0 });
			return <span>{api.activeId ?? '-'}</span>;
		}
		await act(async () => root.render(<Probe />));
		const registry = new ToolRegistry();
		registry.register(createCanvasExplosionToolProvider(canvasExplosionToolTarget(api.controller, { getNodes: () => [node('task', 0, 0)] }), { namespace: '' }));
		let result: any;
		await act(async () => {
			result = await registry.callTool('explode_node', { node: 'task' });
		});
		expect(result.structuredContent).toEqual({ node: 'task', changed: true, exploded: ['task'], collapsed: [] });
		expect(container.textContent).toBe('task');
		const unknown = await registry.callTool('explode_node', { node: 'nope' });
		expect(unknown.isError).toBe(true);
	});
});

describe('useCanvasExplosion (imperative coordinator)', () => {
	it('explodes with parent edges and displacement, then collapses back exactly', async () => {
		let explosion!: ReturnType<typeof useCanvasExplosion>;
		let nodesNow: CanvasNode[] = [];
		let edgesNow: CanvasEdge[] = [];
		function Graph() {
			const [nodes, setNodes] = useState<CanvasNode[]>([node('o', 100, 100), node('d', 300, 100)]);
			const [edges, setEdges] = useState<CanvasEdge[]>([]);
			nodesNow = nodes;
			edgesNow = edges;
			explosion = useCanvasExplosion({ nodes, edges, setNodes, setEdges });
			return <span>{explosion.explodedNodeIds.join(',')}</span>;
		}
		await act(async () => root.render(<Graph />));

		const children = [node('c1', 220, 60, 100, 40), node('c2', 220, 140, 100, 40)];
		const before = JSON.stringify(children);
		let ok = false;
		await act(async () => {
			ok = explosion.explodeNode('o', { childNodes: children, duration: 0, directionalOptions: { direction: 'right', gap: 20 } });
		});
		expect(ok).toBe(true);
		expect(JSON.stringify(children)).toBe(before);
		expect(container.textContent).toBe('o');
		expect(explosion.isExploded('o')).toBe(true);
		expect(nodesNow.find((n) => n.id === 'c2')!.position).toEqual({ x: 220, y: 140 });
		expect(nodesNow.find((n) => n.id === 'd')!.position).toEqual({ x: 420, y: 100 });
		expect(edgesNow.map((e) => e.id)).toEqual([explosionEdgeId('o', 'c1'), explosionEdgeId('o', 'c2')]);

		await act(async () => {
			explosion.toggleExplode('o', { childNodes: children }, { duration: 0 });
		});
		expect(container.textContent).toBe('');
		expect(nodesNow.map((n) => n.id)).toEqual(['o', 'd']);
		expect(nodesNow.find((n) => n.id === 'd')!.position).toEqual({ x: 300, y: 100 });
		expect(edgesNow).toEqual([]);
	});

	it('supports dagre and none strategies and refuses bad input', async () => {
		let explosion!: ReturnType<typeof useCanvasExplosion>;
		let nodesNow: CanvasNode[] = [];
		function Graph() {
			const [nodes, setNodes] = useState<CanvasNode[]>([node('o', 0, 0), node('d', 300, 0)]);
			const [edges, setEdges] = useState<CanvasEdge[]>([{ id: 'e', source: 'o', target: 'd' }]);
			nodesNow = nodes;
			explosion = useCanvasExplosion({ nodes, edges, setNodes, setEdges });
			return null;
		}
		await act(async () => root.render(<Graph />));
		expect(explosion.explodeNode('missing', { childNodes: [node('x', 0, 0)] })).toBe(false);
		expect(() => explosion.explodeNode('o', { childNodes: [node('d', 0, 0)] })).toThrow(/already on the canvas/);
		await act(async () => {
			explosion.explodeNode('o', { childNodes: [node('c', 0, 0)], displacementStrategy: 'none', duration: 0 });
		});
		expect(nodesNow.find((n) => n.id === 'd')!.position).toEqual({ x: 300, y: 0 });
		expect(explosion.explodeNode('o', { childNodes: [node('c9', 0, 0)] })).toBe(false);
		await act(async () => void explosion.collapseNode('o', { duration: 0 }));
		await act(async () => {
			explosion.explodeNode('o', {
				childNodes: [node('c', 0, 0)],
				childEdges: [{ id: 'cd', source: 'c', target: 'd' }],
				displacementStrategy: 'dagre',
				duration: 0
			});
		});
		expect(nodesNow.find((n) => n.id === 'd')!.position.x).toBeGreaterThan(300);
	});
});
