import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	calculateDirectionalDisplacement,
	calculateReflowDisplacement,
	canvasExplosionToolTarget,
	computeCanvasExplosionLayout,
	createCanvasExplosionStateController,
	createCanvasExplosionToolProvider,
	explosionEdgeId,
	nodeSizeOf,
	type CanvasEdge,
	type CanvasExplosionToolTarget,
	type CanvasNode
} from '../src/canvas';
import { ToolRegistry } from '../src/tools';

const node = (id: string, x: number, y: number, w = 100, h = 40, data: Record<string, any> = {}): CanvasNode => ({
	id,
	position: { x, y },
	measured: { width: w, height: h },
	data
});

describe('calculateDirectionalDisplacement', () => {
	it('reads sizes from measured, then width/height, then defaults', () => {
		expect(nodeSizeOf(node('a', 0, 0, 10, 20))).toEqual({ width: 10, height: 20 });
		expect(nodeSizeOf({ id: 'b', position: { x: 0, y: 0 }, width: 30, height: 40, data: {} })).toEqual({ width: 30, height: 40 });
		expect(nodeSizeOf({ id: 'c', position: { x: 0, y: 0 }, data: {} })).toEqual({ width: 200, height: 60 });
	});

	it('pushes right-hand nodes by the cluster width plus gap and preserves Y', () => {
		const origin = node('o', 100, 100);
		const displaced = calculateDirectionalDisplacement({
			existingNodes: [origin, node('right', 300, 120), node('left', 0, 100)],
			originNode: origin,
			childNodes: [node('c1', 220, 80, 200, 40), node('c2', 220, 130, 200, 40)],
			options: { direction: 'right', gap: 40 }
		});
		expect(displaced.get('right')).toEqual({ x: 540, y: 120 });
		expect(displaced.has('left')).toBe(false);
	});

	it('pushes left-hand nodes left', () => {
		const origin = node('o', 300, 100);
		const displaced = calculateDirectionalDisplacement({
			existingNodes: [origin, node('left', 100, 100), node('right', 500, 100)],
			originNode: origin,
			childNodes: [node('c', 150, 100, 120, 40)],
			options: { direction: 'left', gap: 10 }
		});
		expect(displaced.get('left')).toEqual({ x: -30, y: 100 });
		expect(displaced.has('right')).toBe(false);
	});

	it('spreads sibling lanes in the origin column when asked', () => {
		const origin = node('o', 100, 100);
		const displaced = calculateDirectionalDisplacement({
			existingNodes: [origin, node('below', 100, 150)],
			originNode: origin,
			childNodes: [node('c', 250, 60, 100, 120)],
			options: { direction: 'right', gap: 20, spreadSiblingLanes: true }
		});
		expect(displaced.get('below')).toEqual({ x: 100, y: 150 + 60 + 20 });
	});

	it('opens a row vertically, keeping X and the origin row in place', () => {
		const origin = node('o', 100, 200);
		const displaced = calculateDirectionalDisplacement({
			existingNodes: [origin, node('above', 140, 100), node('same', 400, 200), node('below', 300, 300)],
			originNode: origin,
			childNodes: [node('c1', 250, 140, 100, 30), node('c2', 250, 280, 100, 30)],
			options: { direction: 'vertical', gap: 20 }
		});
		// deltaUp 80, deltaDown 90 -> both move 90
		expect(displaced.get('above')).toEqual({ x: 140, y: 10 });
		expect(displaced.get('below')).toEqual({ x: 300, y: 390 });
		expect(displaced.has('same')).toBe(false);
	});

	it('keeps rows above the origin at or below minY and stacks them without overlap', () => {
		const origin = node('o', 0, 400);
		const existing = [origin, node('r0', 0, 100), node('r1', 50, 200), node('r1b', 300, 200), node('r2', 0, 300)];
		const displaced = calculateDirectionalDisplacement({
			existingNodes: existing,
			originNode: origin,
			childNodes: [node('c', 0, 100, 100, 600)],
			options: { direction: 'vertical', gap: 20, minY: 48, rowSpacing: 40 }
		});
		// Every row above would move up 320 (to -220, -120, -20); the floor stacks them 40 apart from 48
		expect(displaced.get('r0')).toEqual({ x: 0, y: 48 });
		expect(displaced.get('r1')).toEqual({ x: 50, y: 88 });
		expect(displaced.get('r1b')).toEqual({ x: 300, y: 88 });
		expect(displaced.get('r2')).toEqual({ x: 0, y: 128 });
	});

	it('never moves a row above the origin downward to meet the floor', () => {
		const origin = node('o', 0, 200);
		const displaced = calculateDirectionalDisplacement({
			existingNodes: [origin, node('r0', 0, 40), node('r1', 0, 80), node('r2', 0, 120)],
			originNode: origin,
			childNodes: [node('c', 0, 100, 100, 200)],
			options: { direction: 'vertical', gap: 20, minY: 48, rowSpacing: 40 }
		});
		// Floors 48 / 88 / 128 sit below where the rows started, so they stay put and are not reported
		expect(displaced.size).toBe(0);
	});

	it('distributes rows against minY so they never overlap', () => {
		const origin = node('o', 0, 300);
		const displaced = calculateDirectionalDisplacement({
			existingNodes: [origin, node('a', 0, 100), node('b', 0, 150), node('c', 0, 200)],
			originNode: origin,
			childNodes: [node('child', 0, 0, 100, 600)],
			options: { direction: 'vertical', gap: 0, minY: 50 }
		});
		// Pushed far above the floor: stacked at 50, 90, 130 (tallest row height 40)
		expect(displaced.get('a')!.y).toBe(50);
		expect(displaced.get('b')!.y).toBe(90);
		expect(displaced.get('c')!.y).toBe(130);
		for (const id of ['a', 'b', 'c']) expect(displaced.get(id)!.x).toBe(0);
	});

	it('keeps rows below the origin inside maxY', () => {
		const origin = node('o', 0, 0);
		const displaced = calculateDirectionalDisplacement({
			existingNodes: [origin, node('a', 0, 100), node('b', 0, 200)],
			originNode: origin,
			childNodes: [node('child', 0, 0, 100, 400)],
			options: { direction: 'down', gap: 0, maxY: 500, rowSpacing: 50 }
		});
		// Bottom row clamps to 500 - 40 = 460; the row above it to 410
		expect(displaced.get('b')).toEqual({ x: 0, y: 460 });
		expect(displaced.get('a')).toEqual({ x: 0, y: 410 });
	});

	it('quantizes vertical deltas to whole lanes in row-lane mode', () => {
		const origin = node('o', 0, 120, 100, 40);
		const displaced = calculateDirectionalDisplacement({
			existingNodes: [origin, node('up1', 0, 80), node('up2', 0, 40), node('same', 300, 130), node('down1', 0, 160), node('down2', 0, 200)],
			originNode: origin,
			childNodes: [node('c', 0, 170, 100, 50)],
			options: { direction: 'vertical', layoutMode: 'row-lane', rowSpacing: 40, gap: 8 }
		});
		// deltaDown = 220 - 160 + 8 = 68 -> 2 lanes = 80; deltaUp = 0
		expect(displaced.get('up1')).toEqual({ x: 0, y: 0 });
		expect(displaced.get('up2')).toEqual({ x: 0, y: -40 });
		expect(displaced.get('down1')).toEqual({ x: 0, y: 240 });
		expect(displaced.get('down2')).toEqual({ x: 0, y: 280 });
		// 'same' is 10px off the origin row but in its lane: it stays
		expect(displaced.has('same')).toBe(false);
	});

	it('combines row-lane with a minY floor', () => {
		const origin = node('o', 0, 120);
		const displaced = calculateDirectionalDisplacement({
			existingNodes: [origin, node('row0', 0, 40), node('row1', 0, 80)],
			originNode: origin,
			childNodes: [node('c', 0, 70, 100, 40)],
			options: { direction: 'vertical', layoutMode: 'row-lane', rowSpacing: 40, gap: 0, minY: 40 }
		});
		// deltaUp = 50 -> 80; row0 would go to -40, row1 to 0: floors 40 and 80 keep them put
		expect(displaced.size).toBe(0);
	});

	it('rejects bad options with a clear error', () => {
		const origin = node('o', 0, 0);
		const base = { existingNodes: [origin], originNode: origin, childNodes: [node('c', 0, 0)] };
		expect(() => calculateDirectionalDisplacement({ ...base, options: { rowSpacing: 0 } })).toThrow(/rowSpacing must be greater than 0/);
		expect(() => calculateDirectionalDisplacement({ ...base, options: { minY: 10, maxY: 0 } })).toThrow(/minY \(10\) must not be greater than maxY/);
		expect(() => calculateDirectionalDisplacement({ ...base, options: { gap: Number.NaN } })).toThrow(/gap must be a finite number/);
	});

	it('returns nothing without children', () => {
		const origin = node('o', 0, 0);
		expect(calculateDirectionalDisplacement({ existingNodes: [origin, node('a', 300, 0)], originNode: origin, childNodes: [] }).size).toBe(0);
	});
});

describe('calculateReflowDisplacement', () => {
	it('anchors the origin and pushes downstream nodes', () => {
		const origin = node('o', 100, 100, 120, 60);
		const downstream = node('d', 300, 100, 120, 60);
		const displaced = calculateReflowDisplacement({
			existingNodes: [origin, downstream],
			existingEdges: [{ id: 'e', source: 'o', target: 'd' }],
			originNode: origin,
			childNodes: [node('c1', 0, 0, 120, 60)],
			childEdges: [
				{ id: 'ec1', source: 'o', target: 'c1' },
				{ id: 'ec2', source: 'c1', target: 'd' }
			],
			options: { direction: 'LR', ranksep: 100 }
		});
		expect(displaced.has('o')).toBe(false);
		expect(displaced.get('d')!.x).toBeGreaterThan(300);
	});
});

describe('computeCanvasExplosionLayout', () => {
	const origin = node('o', 100, 100);
	const existing = [origin, node('d', 300, 100)];
	const children = [node('c1', 220, 60, 100, 40), node('c2', 220, 140, 100, 40)];

	it('returns displaced and original positions, copies of children and the edges it adds, without mutating inputs', () => {
		const snapshot = JSON.stringify({ existing, children });
		const layout = computeCanvasExplosionLayout({
			existingNodes: existing,
			originNode: origin,
			childNodes: children,
			options: { direction: 'right', gap: 20 },
			connectParentToChildren: 'all'
		});
		expect(JSON.stringify({ existing, children })).toBe(snapshot);
		expect(layout.displacedPositions.get('d')).toEqual({ x: 420, y: 100 });
		expect(layout.originalPositions.get('d')).toEqual({ x: 300, y: 100 });
		expect(layout.totalDisplacementDelta).toBe(120);
		expect(layout.childNodes).not.toBe(children);
		expect(layout.childNodes[0]).not.toBe(children[0]);
		expect(layout.childNodes.map((n) => n.position)).toEqual([{ x: 220, y: 60 }, { x: 220, y: 140 }]);
		expect(layout.childEdges.map((e) => e.id)).toEqual([explosionEdgeId('o', 'c1'), explosionEdgeId('o', 'c2')]);
		expect(layout.childBounds).toEqual({ x: 220, y: 60, width: 100, height: 120 });
	});

	it('connects only the first child, keeps given edges and does not duplicate them', () => {
		const given: CanvasEdge = { id: 'mine', source: 'o', target: 'c1' };
		const layout = computeCanvasExplosionLayout({ existingNodes: existing, originNode: origin, childNodes: children, childEdges: [given], connectParentToChildren: 'first' });
		expect(layout.childEdges).toEqual([given]);
		const custom = computeCanvasExplosionLayout({
			existingNodes: existing,
			originNode: origin,
			childNodes: children,
			connectParentToChildren: true,
			createEdge: (s, t) => ({ id: `${s}-${t}`, source: s, target: t })
		});
		expect(custom.childEdges.map((e) => e.id)).toEqual(['o-c1', 'o-c2']);
	});

	it('supports the none and dagre strategies', () => {
		expect(computeCanvasExplosionLayout({ existingNodes: existing, originNode: origin, childNodes: children, strategy: 'none' }).displacedPositions.size).toBe(0);
		const dagre = computeCanvasExplosionLayout({
			existingNodes: existing,
			existingEdges: [{ id: 'e', source: 'o', target: 'd' }],
			originNode: origin,
			childNodes: children,
			childEdges: [{ id: 'x', source: 'c1', target: 'd' }],
			connectParentToChildren: 'all',
			strategy: 'dagre'
		});
		// The parent edges count in the ranking: o -> c1 -> d puts d two ranks (and 2 x (100 + 80)) to the right
		expect(dagre.displacedPositions.get('d')!.x).toBeGreaterThanOrEqual(origin.position.x + 360);
	});

	it('fails usefully on a missing origin or clashing child ids', () => {
		expect(() => computeCanvasExplosionLayout({ existingNodes: [node('d', 0, 0)], originNode: origin, childNodes: children })).toThrow(/origin node "o" is not in existingNodes/);
		expect(() => computeCanvasExplosionLayout({ existingNodes: existing, originNode: origin, childNodes: [node('d', 0, 0)] })).toThrow(/"d" is already on the canvas/);
		expect(() => computeCanvasExplosionLayout({ existingNodes: existing, originNode: origin, childNodes: [node('x', 0, 0), node('x', 1, 1)] })).toThrow(/"x" is repeated/);
	});
});

describe('createCanvasExplosionStateController', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('explodes, collapses with a timed collapsing phase, and toggles', () => {
		const onExplode = vi.fn();
		const onCollapse = vi.fn();
		const state = createCanvasExplosionStateController({ collapseDurationMs: 300, onExplode, onCollapse });
		const listener = vi.fn();
		state.subscribe(listener);

		expect(state.explode('a')).toBe(true);
		expect(state.activeId).toBe('a');
		expect(state.isExploded('a')).toBe(true);
		expect(state.shouldRenderChildren('a')).toBe(true);
		expect(state.isExplodingOrCollapsing).toBe(true);
		expect(onExplode).toHaveBeenCalledWith('a');
		expect(state.explode('a')).toBe(false);

		expect(state.collapse('b')).toBe(false);
		expect(state.collapse()).toBe(true);
		expect(state.activeId).toBeNull();
		expect(state.collapsingId).toBe('a');
		expect(state.isCollapsing('a')).toBe(true);
		expect(state.shouldRenderChildren('a')).toBe(true);
		expect(onCollapse).toHaveBeenCalledWith('a');

		vi.advanceTimersByTime(299);
		expect(state.collapsingId).toBe('a');
		vi.advanceTimersByTime(1);
		expect(state.collapsingId).toBeNull();
		expect(state.shouldRenderChildren('a')).toBe(false);
		expect(state.isExplodingOrCollapsing).toBe(false);

		expect(state.toggle('a')).toBe(true);
		expect(state.toggle('a')).toBe(false);
		expect(state.collapsingId).toBe('a');
		expect(listener).toHaveBeenCalledTimes(5);
	});

	it('cancels a pending collapse when a node explodes during it', () => {
		const state = createCanvasExplosionStateController({ collapseDurationMs: 300 });
		state.explode('a');
		state.collapse('a');
		state.explode('a');
		expect(state.activeId).toBe('a');
		expect(state.collapsingId).toBeNull();
		vi.advanceTimersByTime(1000);
		expect(state.activeId).toBe('a');
	});

	it('replaces the exploded node and reports its collapse', () => {
		const onCollapse = vi.fn();
		const state = createCanvasExplosionStateController({ onCollapse });
		state.explode('a');
		state.explode('b');
		expect(state.activeId).toBe('b');
		expect(state.collapsingId).toBeNull();
		expect(onCollapse).toHaveBeenCalledWith('a');
	});

	it('handles rapid toggles without dangling timers', () => {
		const state = createCanvasExplosionStateController({ collapseDurationMs: 100 });
		for (let i = 0; i < 5; i++) state.toggle('a');
		expect(state.activeId).toBe('a');
		expect(vi.getTimerCount()).toBe(0);
		state.toggle('a');
		expect(vi.getTimerCount()).toBe(1);
		state.finishCollapse();
		expect(state.collapsingId).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('ends the collapse at once with a zero duration, and keeps snapshot identity between changes', () => {
		const state = createCanvasExplosionStateController({ collapseDurationMs: 0, initialActiveId: 'x' });
		const first = state.getSnapshot();
		expect(first).toEqual({ activeId: 'x', collapsingId: null });
		expect(state.getSnapshot()).toBe(first);
		state.collapse();
		expect(state.getSnapshot()).toEqual({ activeId: null, collapsingId: null });
		expect(() => createCanvasExplosionStateController({ collapseDurationMs: -1 })).toThrow(/collapseDurationMs/);
		expect(() => state.explode('')).toThrow(/needs a node id/);
	});

	it('destroy clears the timer and stops changes', () => {
		const listener = vi.fn();
		const state = createCanvasExplosionStateController();
		state.subscribe(listener);
		state.explode('a');
		state.collapse();
		expect(vi.getTimerCount()).toBe(1);
		state.destroy();
		expect(vi.getTimerCount()).toBe(0);
		expect(state.destroyed).toBe(true);
		expect(state.explode('b')).toBe(false);
		expect(listener).toHaveBeenCalledTimes(2);
	});
});

describe('canvas explosion agent tools', () => {
	const nodes = [node('task', 0, 0, 100, 40, { label: 'Task' }), node('note', 200, 0, 100, 40, { kind: 'note' })];
	const setup = (target?: Partial<CanvasExplosionToolTarget>, readOnly?: boolean | string) => {
		const state = createCanvasExplosionStateController({ collapseDurationMs: 0 });
		const registry = new ToolRegistry();
		registry.register(
			createCanvasExplosionToolProvider(
				{
					...canvasExplosionToolTarget(state, { getNodes: () => nodes, canExplode: (n) => (n.data.kind === 'note' ? 'Notes have no subtasks.' : true) }),
					...target
				},
				{ namespace: '', readOnly }
			)
		);
		return { state, registry };
	};

	it('lists explodable nodes', async () => {
		const { registry, state } = setup();
		state.explode('task');
		const result = await registry.callTool('list_explodable_nodes', {});
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			nodes: [{ id: 'task', label: 'Task', exploded: true, collapsing: false }],
			exploded: ['task'],
			collapsing: [],
			multiple: false,
			readOnly: null
		});
	});

	it('explodes and collapses a node, returning the new state', async () => {
		const { registry, state } = setup();
		const exploded = await registry.callTool('explode_node', { node: 'task' });
		expect(exploded.structuredContent).toEqual({ node: 'task', changed: true, exploded: ['task'], collapsed: [] });
		expect(state.activeId).toBe('task');
		const again = await registry.callTool('explode_node', { node: 'task' });
		expect(again.structuredContent).toMatchObject({ changed: false });
		const collapsed = await registry.callTool('collapse_node', { node: 'task' });
		expect(collapsed.structuredContent).toEqual({ node: 'task', exploded: [], collapsing: [] });
		expect(state.activeId).toBeNull();
	});

	it('returns useful errors for unknown, unexplodable and not-exploded nodes and bad arguments', async () => {
		const { registry } = setup();
		const unknown = await registry.callTool('explode_node', { node: 'nope' });
		expect(unknown.isError).toBe(true);
		expect(JSON.stringify(unknown.content)).toMatch(/No node \\"nope\\" on the canvas/);
		const note = await registry.callTool('explode_node', { node: 'note' });
		expect(note.isError).toBe(true);
		expect(JSON.stringify(note.content)).toMatch(/Notes have no subtasks/);
		const notExploded = await registry.callTool('collapse_node', { node: 'task' });
		expect(notExploded.isError).toBe(true);
		expect(JSON.stringify(notExploded.content)).toMatch(/is not exploded \(nothing is exploded\)/);
		const missing = await registry.callTool('explode_node', {});
		expect(missing.isError).toBe(true);
		const extra = await registry.callTool('explode_node', { node: 'task', foo: 1 });
		expect(extra.isError).toBe(true);
	});

	it('reports a refusal from the canvas', async () => {
		const { registry } = setup({ explode: () => false });
		const refused = await registry.callTool('explode_node', { node: 'task' });
		expect(refused.isError).toBe(true);
		expect(JSON.stringify(refused.content)).toMatch(/could not explode/);
	});

	it('hides write tools when read-only and says why', async () => {
		const { registry } = setup(undefined, 'Viewing a shared board.');
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['list_explodable_nodes']);
		const list = await registry.callTool('list_explodable_nodes', {});
		expect(list.structuredContent).toMatchObject({ readOnly: 'Viewing a shared board.' });
	});

	it('describes every tool for a model', () => {
		const { registry } = setup();
		for (const tool of registry.listTools().tools) {
			expect(tool.title).toBeTruthy();
			expect(tool.annotations?.title).toBe(tool.title);
			for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
				expect(typeof tool.annotations?.[hint]).toBe('boolean');
			}
		}
	});
});
