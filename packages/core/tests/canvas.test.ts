import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	getCenteredNodePosition,
	centerNodes,
	getLayoutedNodes,
	ensureLayout,
	placeBeside,
	estimateNodeSize,
	computeNodesBoundingBox,
	calculateDirectionalDisplacement,
	linearTrajectory,
	createFanOutTrajectory,
	runMultiNodeTransition,
	serializeCanvasNodes,
	parseCanvasClipboardData,
	remapPastedNodes,
	isValidCanvasNode,
	withStyleOpacity,
	StreamingLayoutManager,
	ManualClock,
	layoutBounds,
	canvasHeight,
	estimateCanvasHeight,
	blendLayout,
	connectedOnly,
	type CanvasNode,
	type CanvasEdge,
	type Rect,
	type XYPosition
} from '../src/canvas';

describe('Canvas Core - Layout & Centering', () => {
	it('calculates centered node position correctly', () => {
		const screenToFlow = vi.fn((pos) => pos);
		const pos = getCenteredNodePosition(200, 100, screenToFlow, { width: 1000, height: 800 });
		expect(pos).toEqual({ x: 400, y: 350 });
	});

	it('centers a collection of nodes in the viewport', () => {
		const nodes: CanvasNode[] = [
			{ id: '1', position: { x: 0, y: 0 }, data: {} },
			{ id: '2', position: { x: 100, y: 100 }, data: {} }
		];
		const getBounds = (): Rect => ({ x: 0, y: 0, width: 200, height: 200 });
		const screenToFlow = (pos: { x: number; y: number }) => pos;

		const centered = centerNodes(nodes, screenToFlow, getBounds, { width: 1000, height: 800 });
		// Centered pos for 200x200 in 1000x800 is x: 400, y: 300. Delta = +400, +300.
		expect(centered[0].position).toEqual({ x: 400, y: 300 });
		expect(centered[1].position).toEqual({ x: 500, y: 400 });
	});

	it('computes hierarchical Dagre layout for nodes and edges', () => {
		const nodes: CanvasNode[] = [
			{ id: 'a', position: { x: 0, y: 0 }, data: { label: 'Node A' } },
			{ id: 'b', position: { x: 0, y: 0 }, data: { label: 'Node B' } }
		];
		const edges: CanvasEdge[] = [{ id: 'e1', source: 'a', target: 'b' }];

		const layouted = getLayoutedNodes(nodes, edges, undefined, { direction: 'LR' });
		expect(layouted).toHaveLength(2);
		// In LR layout, target node b should have a greater x than source node a
		const nodeA = layouted.find((n) => n.id === 'a')!;
		const nodeB = layouted.find((n) => n.id === 'b')!;
		expect(nodeB.position.x).toBeGreaterThan(nodeA.position.x);
	});

	it('incremental layout (ensureLayout) preserves user-positioned nodes and aligns new nodes', () => {
		const nodes: CanvasNode[] = [
			{ id: 'a', position: { x: 500, y: 300 }, data: { label: 'A' } },
			{ id: 'b', position: { x: 800, y: 300 }, data: { label: 'B' } },
			{ id: 'c', position: { x: 0, y: 0 }, data: { label: 'C' } } // New node without stored position
		];
		const edges: CanvasEdge[] = [
			{ id: 'e1', source: 'a', target: 'b' },
			{ id: 'e2', source: 'b', target: 'c' }
		];

		const storedPositions = {
			a: { x: 500, y: 300 },
			b: { x: 800, y: 300 }
		};

		const result = ensureLayout(nodes, edges, {
			direction: 'LR',
			storedPositions
		});

		// Stored positions must be 100% preserved
		const resA = result.find((n) => n.id === 'a')!;
		const resB = result.find((n) => n.id === 'b')!;
		const resC = result.find((n) => n.id === 'c')!;

		expect(resA.position).toEqual({ x: 500, y: 300 });
		expect(resB.position).toEqual({ x: 800, y: 300 });
		// Node C should be placed downstream of B
		expect(resC.position.x).toBeGreaterThan(resB.position.x);
	});

	it('placeBeside finds free placement avoiding overlapping obstacles', () => {
		const rects: Record<string, Rect> = {
			node1: { x: 100, y: 100, width: 200, height: 60 },
			node2: { x: 348, y: 100, width: 200, height: 60 } // Direct right obstacle
		};

		const size = { width: 200, height: 60 };
		// Try placing to the right of node1
		const pos = placeBeside(rects, size, 'right', 'node1');

		// Since (348, 100) is occupied by node2, placeBeside should have shifted vertically
		expect(pos.y).not.toEqual(100);
	});

	it('estimates node sizes based on text content lines', () => {
		const node: CanvasNode = {
			id: 'test',
			position: { x: 0, y: 0 },
			data: { label: 'Line 1\nLine 2\nLine 3' }
		};
		const size = estimateNodeSize(node);
		expect(size.height).toBeGreaterThan(60);
	});
});

describe('Canvas Core - Displacement & Trajectory', () => {
	it('calculates bounding box for a set of nodes', () => {
		const nodes: CanvasNode[] = [
			{ id: '1', position: { x: 10, y: 20 }, width: 100, height: 50, data: {} },
			{ id: '2', position: { x: 200, y: 300 }, width: 80, height: 40, data: {} }
		];
		const bounds = computeNodesBoundingBox(nodes);
		expect(bounds).toEqual({
			x: 10,
			y: 20,
			width: 270, // 280 - 10
			height: 320 // 340 - 20
		});
	});

	it('calculates directional displacement to push downstream nodes', () => {
		const originNode: CanvasNode = {
			id: 'origin',
			position: { x: 100, y: 100 },
			width: 100,
			height: 50,
			data: {}
		};
		const downstreamNode: CanvasNode = {
			id: 'downstream',
			position: { x: 300, y: 100 },
			width: 100,
			height: 50,
			data: {}
		};
		const upstreamNode: CanvasNode = {
			id: 'upstream',
			position: { x: 50, y: 100 },
			width: 100,
			height: 50,
			data: {}
		};
		const childNodes: CanvasNode[] = [
			{ id: 'c1', position: { x: 0, y: 0 }, width: 120, height: 50, data: {} }
		];

		const displaced = calculateDirectionalDisplacement({
			existingNodes: [originNode, downstreamNode, upstreamNode],
			originNode,
			childNodes,
			options: { direction: 'right', gap: 20 }
		});

		// Only downstreamNode (x > originNode.x) should be displaced
		expect(displaced.has('downstream')).toBe(true);
		expect(displaced.has('upstream')).toBe(false);
		expect(displaced.get('downstream')!.x).toBeGreaterThan(300);
	});

	it('computes linear and fan-out trajectories', () => {
		const linear = linearTrajectory({ x: 0, y: 0 }, { x: 100, y: 200 }, 0.5);
		expect(linear.position).toEqual({ x: 50, y: 100 });
		expect(linear.scale).toBe(0.5);

		const fanOut = createFanOutTrajectory()({ x: 0, y: 0 }, { x: 100, y: 200 }, 0.5, 0, 3);
		expect(fanOut.position.x).toBeDefined();
		expect(fanOut.position.y).toBeDefined();
	});

	it('runs multi-node transitions with instantaneous duration without division by zero', () => {
		const node: CanvasNode = { id: '1', position: { x: 0, y: 0 }, data: {} };
		const onComplete = vi.fn();

		const cancel = runMultiNodeTransition(
			[{ node, from: { x: 0, y: 0 }, to: { x: 150, y: 250 }, duration: 0 }],
			{ onComplete }
		);

		// Emitted copy should have snapped to destination
		expect(onComplete).toHaveBeenCalled();
		expect(onComplete.mock.calls[0][0][0].position).toEqual({ x: 150, y: 250 });
		cancel();
	});
});

describe('Canvas Core - Clipboard & Serialization', () => {
	it('serializes and parses canvas nodes accurately', () => {
		const nodes: CanvasNode[] = [{ id: 'n1', position: { x: 20, y: 40 }, data: { foo: 'bar' } }];
		const edges: CanvasEdge[] = [{ id: 'e1', source: 'n1', target: 'n2' }];

		const serialized = serializeCanvasNodes(nodes, edges);
		const parsed = parseCanvasClipboardData(serialized);

		expect(parsed).not.toBeNull();
		expect(parsed?.nodes).toHaveLength(1);
		expect(parsed?.nodes[0].data.foo).toBe('bar');
		expect(parsed?.edges).toHaveLength(1);
	});

	it('remaps node IDs and updates edge references when pasting', () => {
		const nodes: CanvasNode[] = [
			{ id: 'orig-1', position: { x: 10, y: 10 }, data: {} },
			{ id: 'orig-2', position: { x: 100, y: 10 }, data: {} }
		];
		const edges: CanvasEdge[] = [{ id: 'e1', source: 'orig-1', target: 'orig-2' }];

		const { nodes: remappedNodes, edges: remappedEdges } = remapPastedNodes(
			nodes,
			edges,
			{ x: 50, y: 50 },
			() => `new-${Math.random().toString(36).substring(2, 6)}`
		);

		expect(remappedNodes[0].id).not.toBe('orig-1');
		expect(remappedNodes[1].id).not.toBe('orig-2');
		expect(remappedNodes[0].position).toEqual({ x: 60, y: 60 });
		expect(remappedNodes[1].position).toEqual({ x: 150, y: 60 });

		expect(remappedEdges[0].source).toBe(remappedNodes[0].id);
		expect(remappedEdges[0].target).toBe(remappedNodes[1].id);
	});
});

describe('Canvas - Clock & Deterministic Animation', () => {
	it('ManualClock advances time and resolves sleep timers in order', async () => {
		const clock = new ManualClock(100);
		expect(clock.now()).toBe(100);

		let resolvedA = false;
		let resolvedB = false;

		clock.sleep(50).then(() => {
			resolvedA = true;
		});
		clock.sleep(100).then(() => {
			resolvedB = true;
		});

		expect(clock.pending).toBe(true);

		// Advance 30ms -> none resolved
		await clock.advance(30);
		expect(clock.now()).toBe(130);
		expect(resolvedA).toBe(false);
		expect(resolvedB).toBe(false);

		// Advance 30ms (total 60ms) -> A resolved
		await clock.advance(30);
		expect(clock.now()).toBe(160);
		expect(resolvedA).toBe(true);
		expect(resolvedB).toBe(false);

		// Advance 50ms (total 110ms) -> B resolved
		await clock.advance(50);
		expect(clock.now()).toBe(210);
		expect(resolvedB).toBe(true);
		expect(clock.pending).toBe(false);
	});

	it('runMultiNodeTransition animates deterministically via ManualClock', async () => {
		const clock = new ManualClock(0);
		const input: CanvasNode = { id: 'n1', position: { x: 0, y: 0 }, data: {} };
		let node = input;

		let completed = false;
		runMultiNodeTransition(
			[
				{
					node: input,
					from: { x: 0, y: 0 },
					to: { x: 100, y: 200 },
					duration: 100
				}
			],
			{
				clock,
				onUpdate: ([updated]) => {
					node = updated;
				},
				onComplete: () => {
					completed = true;
				}
			}
		);

		// At start
		expect(node.position).toEqual({ x: 0, y: 0 });
		expect(completed).toBe(false);

		// Tick halfway (50ms)
		await clock.advance(50);
		expect(node.position.x).toBeGreaterThan(0);
		expect(node.position.x).toBeLessThan(100);
		expect(completed).toBe(false);

		// Tick to completion (100ms)
		await clock.advance(60);
		expect(node.position).toEqual({ x: 100, y: 200 });
		expect(completed).toBe(true);
		// The caller's node is never mutated
		expect(input.position).toEqual({ x: 0, y: 0 });
	});
});

describe('Canvas - View & Streaming Stabilization', () => {
	it('layoutBounds calculates bounding box of all nodes', () => {
		const nodes: CanvasNode[] = [
			{ id: '1', position: { x: 10, y: 20 }, width: 100, height: 50, data: {} },
			{ id: '2', position: { x: 200, y: 150 }, width: 80, height: 40, data: {} }
		];

		const bounds = layoutBounds(nodes);
		expect(bounds).toEqual({
			x: 10,
			y: 20,
			width: 270, // 200 + 80 - 10 = 270
			height: 170 // 150 + 40 - 20 = 170
		});
	});

	it('canvasHeight clamps height within min and max options', () => {
		const nodes: CanvasNode[] = [
			{ id: '1', position: { x: 0, y: 0 }, width: 100, height: 50, data: {} }
		];

		// content = 50, padding = 48 -> 98, clamped to min 320
		const h = canvasHeight(nodes, { min: 320, max: 600 });
		expect(h).toBe(320);
	});

	it('estimateCanvasHeight reserves container height based on node count', () => {
		const nodes: CanvasNode[] = Array.from({ length: 4 }, (_, i) => ({
			id: `n-${i}`,
			position: { x: 0, y: 0 },
			data: {}
		}));
		const edges: CanvasEdge[] = [];

		const estimated = estimateCanvasHeight(nodes, edges, { min: 300, max: 800 });
		expect(estimated).toBeGreaterThanOrEqual(300);
		expect(estimated).toBeLessThanOrEqual(800);
	});

	it('blendLayout interpolates node positions between two layouts', () => {
		const from: CanvasNode[] = [
			{ id: '1', position: { x: 0, y: 0 }, width: 100, height: 50, data: {} }
		];
		const to: CanvasNode[] = [
			{ id: '1', position: { x: 100, y: 200 }, width: 120, height: 60, data: {} },
			{ id: '2', position: { x: 50, y: 50 }, width: 100, height: 50, data: {} }
		];

		const blended = blendLayout(from, to, 0.5);
		const node1 = blended.find((n) => n.id === '1')!;
		const node2 = blended.find((n) => n.id === '2')!;

		expect(node1.position).toEqual({ x: 50, y: 100 });
		expect(node1.width).toBe(110);
		// New node snaps directly to target
		expect(node2.position).toEqual({ x: 50, y: 50 });
	});

	it('connectedOnly filters out orphan nodes that have no edges', () => {
		const nodes: CanvasNode[] = [
			{ id: 'connected-1', position: { x: 0, y: 0 }, data: {} },
			{ id: 'connected-2', position: { x: 0, y: 0 }, data: {} },
			{ id: 'orphan-3', position: { x: 0, y: 0 }, data: {} }
		];
		const edges: CanvasEdge[] = [
			{ id: 'e1', source: 'connected-1', target: 'connected-2' }
		];

		const filtered = connectedOnly(nodes, edges);
		expect(filtered).toHaveLength(2);
		expect(filtered.map((n) => n.id)).toEqual(['connected-1', 'connected-2']);
	});
});


describe('Canvas - runMultiNodeTransition styles & immutability', () => {
	it('handles object styles (React Flow) without throwing', () => {
		const node = {
			id: 'n1',
			position: { x: 0, y: 0 },
			data: { label: 'A' },
			style: { background: 'red', opacity: 0.1 }
		} as CanvasNode;

		let result: CanvasNode | undefined;
		expect(() =>
			runMultiNodeTransition(
				[{ node, from: { x: 0, y: 0 }, to: { x: 10, y: 20 }, trajectory: linearTrajectory, duration: 0 }],
				{ onComplete: ([n]) => (result = n) }
			)
		).not.toThrow();

		expect(result!.style).toEqual({ background: 'red', opacity: 1 });
		expect(result!.data).toEqual({ label: 'A', scale: 1, opacity: 1 });
		expect(result!.position).toEqual({ x: 10, y: 20 });
	});

	it('does not mutate input nodes and emits copies in transition order', async () => {
		const clock = new ManualClock(0);
		const a: CanvasNode = { id: 'a', position: { x: 0, y: 0 }, data: {}, style: 'color: red;' };
		const b: CanvasNode = { id: 'b', position: { x: 5, y: 5 }, data: {} };
		const frames: CanvasNode[][] = [];

		runMultiNodeTransition(
			[
				{ node: a, from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, trajectory: linearTrajectory, duration: 100 },
				{ node: b, from: { x: 5, y: 5 }, to: { x: 5, y: 105 }, duration: 100 }
			],
			{ clock, onUpdate: (nodes) => frames.push(nodes) }
		);
		await clock.advance(50);
		await clock.advance(60);

		const last = frames[frames.length - 1];
		expect(last.map((n) => n.id)).toEqual(['a', 'b']);
		expect(last[0].position).toEqual({ x: 100, y: 0 });
		expect(last[0].style).toBe('color: red; opacity: 1;');
		expect(last[1].position).toEqual({ x: 5, y: 105 });
		expect(last[0]).not.toBe(a);

		expect(a).toEqual({ id: 'a', position: { x: 0, y: 0 }, data: {}, style: 'color: red;' });
		expect(b).toEqual({ id: 'b', position: { x: 5, y: 5 }, data: {} });
	});

	it('withStyleOpacity supports strings, objects and empty styles', () => {
		expect(withStyleOpacity('opacity: 0; color: red', 0.5)).toBe('color: red; opacity: 0.5;');
		expect(withStyleOpacity('color: red; opacity: 0.2;', 1)).toBe('color: red; opacity: 1;');
		expect(withStyleOpacity({ color: 'red' }, 0.3)).toEqual({ color: 'red', opacity: 0.3 });
		expect(withStyleOpacity(undefined, 0.3)).toBe('opacity: 0.3;');
		expect(withStyleOpacity(undefined, 0.3, 'object')).toEqual({ opacity: 0.3 });
	});
});

describe('Canvas - StreamingLayoutManager', () => {
	const chain = (count: number) => {
		const nodes: CanvasNode[] = [];
		const edges: CanvasEdge[] = [];
		for (let i = 0; i < count; i++) {
			nodes.push({ id: `n${i}`, position: { x: 0, y: 0 }, data: {} });
			if (i > 0) edges.push({ id: `e${i}`, source: `n${i - 1}`, target: `n${i}` });
		}
		return { nodes, edges };
	};

	afterEach(() => {
		vi.useRealTimers();
	});

	it('throttles (leading + trailing) instead of debouncing continuous updates', () => {
		vi.useFakeTimers();
		// A ManualClock that is never advanced keeps glides parked on their first frame,
		// so every layout produces exactly one synchronous onLayoutUpdated call.
		const layouts: Map<string, XYPosition>[] = [];
		const manager = new StreamingLayoutManager({
			throttleMs: 50,
			clock: new ManualClock(0),
			onLayoutUpdated: (positions) => layouts.push(positions)
		});

		// Updates every 20ms for 500ms
		let count = 0;
		for (let t = 0; t < 500; t += 20) {
			count++;
			const { nodes, edges } = chain(count);
			manager.pushStreamUpdate(nodes, edges, new Map());
			if (t === 0) {
				// Leading edge runs synchronously
				expect(layouts).toHaveLength(1);
			}
			vi.advanceTimersByTime(20);
		}

		// ~one layout per 50ms window while the stream is active
		expect(layouts.length).toBeGreaterThanOrEqual(8);
		expect(layouts.length).toBeLessThanOrEqual(12);

		// Trailing edge lays out the latest update
		vi.advanceTimersByTime(100);
		const last = layouts[layouts.length - 1];
		expect(last.has(`n${count - 1}`)).toBe(true);
		manager.destroy();
	});

	it('destroy cancels a pending trailing layout', () => {
		vi.useFakeTimers();
		const onLayoutUpdated = vi.fn();
		const manager = new StreamingLayoutManager({ throttleMs: 50, onLayoutUpdated });
		const { nodes, edges } = chain(2);
		manager.pushStreamUpdate(nodes, edges, new Map());
		manager.pushStreamUpdate(chain(3).nodes, chain(3).edges, new Map());
		expect(onLayoutUpdated).toHaveBeenCalledTimes(1);
		manager.destroy();
		vi.advanceTimersByTime(200);
		expect(onLayoutUpdated).toHaveBeenCalledTimes(1);
	});

	it('glides known nodes from their current position to the newly computed layout', async () => {
		const clock = new ManualClock(0);
		const updates: Map<string, XYPosition>[] = [];
		const manager = new StreamingLayoutManager({
			glideDurationMs: 100,
			clock,
			onLayoutUpdated: (positions) => updates.push(positions)
		});
		const { nodes, edges } = chain(2);
		const current = new Map<string, XYPosition>([
			['n0', { x: 1000, y: 1000 }],
			['n1', { x: 2000, y: 1000 }]
		]);

		manager.flush(nodes, edges, current);
		const target = manager.getTargetPositions();
		const targetN0 = target.get('n0')!;
		expect(targetN0).not.toEqual({ x: 1000, y: 1000 });

		// First frame starts at the current position
		expect(updates[0].get('n0')).toEqual({ x: 1000, y: 1000 });

		await clock.advance(50);
		const mid = updates[updates.length - 1].get('n0')!;
		expect(mid.x).toBeLessThan(1000);
		expect(mid.x).toBeGreaterThan(targetN0.x);

		await clock.advance(60);
		const final = updates[updates.length - 1];
		expect(final.get('n0')).toEqual(targetN0);
		expect(final.get('n1')).toEqual(target.get('n1'));
		// Caller's map is untouched
		expect(current.get('n0')).toEqual({ x: 1000, y: 1000 });
		manager.destroy();
	});

	it('places brand-new nodes directly at their target and respects stored positions', () => {
		const updates: Map<string, XYPosition>[] = [];
		const manager = new StreamingLayoutManager({
			clock: new ManualClock(0),
			layoutOptions: { direction: 'LR', storedPositions: { n0: { x: 500, y: 500 } } },
			onLayoutUpdated: (positions) => updates.push(positions)
		});
		const { nodes, edges } = chain(2);
		manager.flush(nodes, edges, new Map([['n0', { x: 500, y: 500 }]]));
		expect(updates).toHaveLength(1);
		expect(updates[0].get('n0')).toEqual({ x: 500, y: 500 });
		expect(updates[0].get('n1')!.x).toBeGreaterThan(500);
		manager.destroy();
	});
});

describe('Canvas - Clipboard validation & remapping', () => {
	it('does not crash on a non-array edges payload', () => {
		const raw = JSON.stringify({
			version: 1,
			nodes: [{ id: 'a', position: { x: 0, y: 0 }, data: {} }],
			edges: 'not-an-array'
		});
		const parsed = parseCanvasClipboardData(raw);
		expect(parsed).not.toBeNull();
		expect(() => remapPastedNodes(parsed!.nodes, parsed!.edges)).not.toThrow();
		expect(() => remapPastedNodes(parsed!.nodes, 'oops' as any)).not.toThrow();
		expect(() => remapPastedNodes(parsed!.nodes, { length: 1 } as any)).not.toThrow();
	});

	it('rejects non-finite / non-numeric positions', () => {
		expect(isValidCanvasNode({ id: 'a', position: { x: '1e3', y: 0 } })).toBe(false);
		expect(isValidCanvasNode({ id: 'a', position: { x: NaN, y: 0 } })).toBe(false);
		expect(isValidCanvasNode({ id: 'a', position: { x: 1, y: null } })).toBe(false);
		expect(isValidCanvasNode({ id: 'a', position: { x: 1, y: 2 } })).toBe(true);

		const raw = JSON.stringify({ version: 1, nodes: [{ id: 'a', position: { x: '1e3', y: 0 }, data: {} }] });
		expect(parseCanvasClipboardData(raw)).toBeNull();

		const { nodes } = remapPastedNodes([{ id: 'a', position: { x: '1e3', y: 0 }, data: {} } as any]);
		expect(nodes).toHaveLength(0);
	});

	it('remaps parentId to the pasted parent and keeps relative child positions', () => {
		let i = 0;
		const nodes: CanvasNode[] = [
			{ id: 'group', position: { x: 100, y: 100 }, data: {} },
			{ id: 'child', parentId: 'group', position: { x: 10, y: 10 }, data: {} },
			{ id: 'orphan', parentId: 'elsewhere', position: { x: 5, y: 5 }, data: {} }
		];
		const { nodes: pasted } = remapPastedNodes(nodes, [], { x: 30, y: 30 }, () => `new-${i++}`);

		expect(pasted[0].id).toBe('new-0');
		expect(pasted[0].position).toEqual({ x: 130, y: 130 });
		expect(pasted[1].parentId).toBe('new-0');
		expect(pasted[1].position).toEqual({ x: 10, y: 10 });
		// Parent outside the paste is left untouched
		expect(pasted[2].parentId).toBe('elsewhere');
		expect(pasted[2].position).toEqual({ x: 35, y: 35 });
	});
});
