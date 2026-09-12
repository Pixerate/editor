import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	linearTrajectory,
	linearPositionTrajectory,
	createFanOutTrajectory,
	createBezierTrajectory,
	runMultiNodeTransition
} from '../createCanvasTrajectory.js';
import {
	computeNodesBoundingBox,
	calculateDirectionalDisplacement,
	calculateReflowDisplacement
} from '../createCanvasDisplacement.js';
import { createCanvasExplosion } from '../createCanvasExplosion.svelte.js';
import { createCanvasGraph } from '../createCanvasGraph.svelte.js';
import type { CanvasNode, CanvasEdge } from '../types.js';

describe('Canvas Trajectory Math & Transition Runner', () => {
	it('evaluates linear trajectory at progress intervals', () => {
		const origin = { x: 100, y: 100 };
		const target = { x: 300, y: 200 };

		const start = linearTrajectory(origin, target, 0, 0, 1);
		expect(start.position).toEqual({ x: 100, y: 100 });
		expect(start.scale).toBe(0);

		const mid = linearTrajectory(origin, target, 0.5, 0, 1);
		expect(mid.position).toEqual({ x: 200, y: 150 });
		expect(mid.scale).toBe(0.5);

		const end = linearTrajectory(origin, target, 1, 0, 1);
		expect(end.position).toEqual({ x: 300, y: 200 });
		expect(end.scale).toBe(1);
	});

	it('creates fan-out curved trajectory with scale and opacity', () => {
		const origin = { x: 50, y: 100 };
		const targetTop = { x: 250, y: 50 };
		const targetBottom = { x: 250, y: 150 };

		const trajectory = createFanOutTrajectory({
			curvature: 0.5,
			startScale: 0.2,
			endScale: 1
		});

		const topPoint = trajectory(origin, targetTop, 0.5, 0, 2);
		const bottomPoint = trajectory(origin, targetBottom, 0.5, 1, 2);

		expect(topPoint.scale).toBeCloseTo(0.6);
		expect(bottomPoint.scale).toBeCloseTo(0.6);
		expect(topPoint.opacity).toBeCloseTo(0.5);
		expect(bottomPoint.opacity).toBeCloseTo(0.5);
		// Trajectory arc deflects top and bottom differently based on normalized index
		expect(topPoint.position.y).not.toBe(bottomPoint.position.y);
	});

	it('evaluates linearPositionTrajectory without altering scale or opacity', () => {
		const origin = { x: 10, y: 20 };
		const target = { x: 110, y: 120 };

		const pt = linearPositionTrajectory(origin, target, 0.5, 0, 1);
		expect(pt.position).toEqual({ x: 60, y: 70 });
		expect(pt.scale).toBeUndefined();
		expect(pt.opacity).toBeUndefined();
	});

	it('creates reverse trajectory fading out opacity from 1 to 0', () => {
		const reverseTrajectory = createFanOutTrajectory({
			startOpacity: 1,
			endOpacity: 0,
			startScale: 1,
			endScale: 0
		});

		const pt = reverseTrajectory({ x: 100, y: 100 }, { x: 0, y: 0 }, 0.5, 0, 1);
		expect(pt.opacity).toBeCloseTo(0.5);
		expect(pt.scale).toBeCloseTo(0.5);
	});

	it('creates custom bezier trajectory with control point calculator', () => {
		const trajectory = createBezierTrajectory((orig, tgt) => ({
			x: orig.x,
			y: tgt.y
		}));

		const pt = trajectory({ x: 0, y: 0 }, { x: 100, y: 100 }, 0.5, 0, 1);
		// Quadratic Bezier at t=0.5 with P0=(0,0), P1=(0,100), P2=(100,100)
		// x = 0.25*0 + 0.5*0 + 0.25*100 = 25
		// y = 0.25*0 + 0.5*100 + 0.25*100 = 75
		expect(pt.position.x).toBe(25);
		expect(pt.position.y).toBe(75);
	});

	it('runs multi-node transitions and notifies on completion', () => {
		const node: CanvasNode = {
			id: 'n1',
			position: { x: 0, y: 0 },
			data: {}
		};

		const onComplete = vi.fn();
		const cancel = runMultiNodeTransition(
			[
				{
					node,
					from: { x: 0, y: 0 },
					to: { x: 100, y: 100 },
					duration: 0 // Immediate completion for testing
				}
			],
			{ onComplete }
		);

		expect(node.position).toEqual({ x: 100, y: 100 });
		expect(onComplete).toHaveBeenCalled();
		cancel();
	});

	it('animates opacity and sets style in runMultiNodeTransition', () => {
		const node: CanvasNode = {
			id: 'n1',
			position: { x: 0, y: 0 },
			data: {}
		};

		const trajectory = createFanOutTrajectory({
			startOpacity: 0,
			endOpacity: 1
		});

		const cancel = runMultiNodeTransition(
			[
				{
					node,
					from: { x: 0, y: 0 },
					to: { x: 100, y: 100 },
					trajectory,
					duration: 0
				}
			]
		);

		expect(node.position).toEqual({ x: 100, y: 100 });
		expect((node.data as any).opacity).toBe(1);
		expect(node.style).toContain('opacity: 1');
		cancel();
	});
});

describe('Spatial Displacement Solvers', () => {
	const createNode = (id: string, x: number, y: number, w = 150, h = 50): CanvasNode => ({
		id,
		position: { x, y },
		measured: { width: w, height: h },
		data: {}
	});

	it('computes bounding box for a set of nodes', () => {
		const nodes = [createNode('a', 10, 20, 100, 40), createNode('b', 50, 100, 200, 80)];
		const bbox = computeNodesBoundingBox(nodes);

		expect(bbox.x).toBe(10);
		expect(bbox.y).toBe(20);
		expect(bbox.width).toBe(240); // 50 + 200 - 10 = 240
		expect(bbox.height).toBe(160); // 100 + 80 - 20 = 160
	});

	it('calculates directional displacement shifting downstream nodes to make space', () => {
		const origin = createNode('origin', 100, 100, 100, 50);
		const downstream = createNode('downstream', 300, 100, 100, 50);
		const upstream = createNode('upstream', 0, 100, 100, 50);

		// Child cluster with width=200
		const children = [
			createNode('c1', 150, 80, 200, 40),
			createNode('c2', 150, 120, 200, 40)
		];

		const displaced = calculateDirectionalDisplacement({
			existingNodes: [origin, downstream, upstream],
			originNode: origin,
			childNodes: children,
			options: { direction: 'right', gap: 40 }
		});

		// Child cluster width is 200, gap is 40 -> deltaPrimary = 240
		expect(displaced.has('downstream')).toBe(true);
		expect(displaced.get('downstream')?.x).toBe(300 + 240);
		// Upstream node remains untouched
		expect(displaced.has('upstream')).toBe(false);
	});

	it('calculates vertical directional displacement moving above nodes up and below nodes down equally without shifting x', () => {
		const origin = createNode('origin', 100, 200, 100, 40);
		const above = createNode('above', 100, 100, 100, 40);
		const below = createNode('below', 300, 300, 100, 40);

		// Child cluster extending above and below origin
		const children = [
			createNode('c1', 250, 140, 100, 30),
			createNode('c2', 250, 280, 100, 30) // bottom at 310
		];

		const displaced = calculateDirectionalDisplacement({
			existingNodes: [origin, above, below],
			originNode: origin,
			childNodes: children,
			options: { direction: 'vertical', gap: 20 }
		});

		// deltaUp = (200 - 140) + 20 = 80
		// deltaDown = (310 - (200 + 40)) + 20 = 90
		// equalDelta = max(80, 90) = 90 -> BOTH above and below displace equally by 90!
		expect(displaced.get('above')?.y).toBe(100 - 90);
		expect(displaced.get('above')?.x).toBe(100);

		expect(displaced.get('below')?.y).toBe(300 + 90);
		expect(displaced.get('below')?.x).toBe(300);
	});

	it('displaces both above and below nodes equally when deltaUp is greater than deltaDown', () => {
		const origin = createNode('origin', 100, 200, 100, 40);
		const above = createNode('above', 100, 100, 100, 40);
		const below = createNode('below', 300, 300, 100, 40);

		const children = [
			createNode('c1', 250, 100, 100, 30), // top at 100 -> deltaUp = 200 - 100 + 20 = 120
			createNode('c2', 250, 220, 100, 30)  // bottom at 250 -> deltaDown = 250 - 240 + 20 = 30
		];

		const displaced = calculateDirectionalDisplacement({
			existingNodes: [origin, above, below],
			originNode: origin,
			childNodes: children,
			options: { direction: 'vertical', gap: 20 }
		});

		// equalDelta = max(120, 30) = 120 -> BOTH displace equally by 120
		expect(displaced.get('above')?.y).toBe(100 - 120);
		expect(displaced.get('below')?.y).toBe(300 + 120);
		expect(displaced.get('below')?.x).toBe(300);
	});

	it('calculates Dagre reflow displacement anchoring origin node position', () => {
		const origin = createNode('origin', 100, 100, 120, 60);
		const downstream = createNode('downstream', 300, 100, 120, 60);
		const edges: CanvasEdge[] = [{ id: 'e1', source: 'origin', target: 'downstream' }];

		const children = [createNode('c1', 0, 0, 120, 60), createNode('c2', 0, 0, 120, 60)];
		const childEdges: CanvasEdge[] = [
			{ id: 'ec1', source: 'origin', target: 'c1' },
			{ id: 'ec2', source: 'c1', target: 'downstream' }
		];

		const displaced = calculateReflowDisplacement({
			existingNodes: [origin, downstream],
			existingEdges: edges,
			originNode: origin,
			childNodes: children,
			childEdges,
			options: { direction: 'LR', ranksep: 100 }
		});

		// Downstream node should be pushed further to make space for child rank
		expect(displaced.has('downstream')).toBe(true);
		expect(displaced.get('downstream')!.x).toBeGreaterThan(origin.position.x);
	});
});

describe('createCanvasExplosion Rune Lifecycle & Reversibility', () => {
	const createNode = (id: string, x: number, y: number, w = 150, h = 50): CanvasNode => ({
		id,
		position: { x, y },
		measured: { width: w, height: h },
		data: {}
	});

	it('explodes node, connects children, shifts downstream nodes, and collapses reversibly', () => {
		const origin = createNode('origin', 100, 100);
		const downstream = createNode('downstream', 300, 100);
		const initialEdge: CanvasEdge = { id: 'e1', source: 'origin', target: 'downstream' };

		const graph = createCanvasGraph({
			initialNodes: [origin, downstream],
			initialEdges: [initialEdge]
		});

		const explosion = createCanvasExplosion(graph);

		expect(explosion.isExploded('origin')).toBe(false);

		const child1 = createNode('c1', 250, 70);
		const child2 = createNode('c2', 250, 130);

		// 1. Explode
		const exploded = explosion.explodeNode('origin', {
			childNodes: [child1, child2],
			duration: 0, // instantaneous for sync unit testing
			connectParentToChildren: 'all',
			directionalOptions: { direction: 'right', gap: 50 }
		});

		expect(exploded).toBe(true);
		expect(explosion.isExploded('origin')).toBe(true);

		// Check that children were added
		expect(graph.nodes.some((n) => n.id === 'c1')).toBe(true);
		expect(graph.nodes.some((n) => n.id === 'c2')).toBe(true);

		// Check that parent was connected to children
		expect(graph.edges.some((e) => e.source === 'origin' && e.target === 'c1')).toBe(true);
		expect(graph.edges.some((e) => e.source === 'origin' && e.target === 'c2')).toBe(true);

		// Check that downstream node was displaced rightward
		const displacedDownstream = graph.nodes.find((n) => n.id === 'downstream')!;
		expect(displacedDownstream.position.x).toBeGreaterThan(300);

		// 2. Collapse
		const collapsed = explosion.collapseNode('origin', {
			duration: 0
		});

		expect(collapsed).toBe(true);
		expect(explosion.isExploded('origin')).toBe(false);

		// Check that children were removed from graph
		expect(graph.nodes.some((n) => n.id === 'c1')).toBe(false);
		expect(graph.nodes.some((n) => n.id === 'c2')).toBe(false);

		// Check that child edges were pruned
		expect(graph.edges.some((e) => e.source === 'origin' && e.target === 'c1')).toBe(false);

		// Check that downstream node returned to its exact pre-explosion baseline coordinate
		const restoredDownstream = graph.nodes.find((n) => n.id === 'downstream')!;
		expect(restoredDownstream.position.x).toBe(300);
		expect(restoredDownstream.position.y).toBe(100);
	});

	it('toggles explosion with toggleExplode', () => {
		const origin = createNode('origin', 100, 100);
		const graph = createCanvasGraph({ initialNodes: [origin] });
		const explosion = createCanvasExplosion(graph);

		const child = createNode('c1', 200, 100);

		explosion.toggleExplode('origin', {
			childNodes: [child],
			duration: 0
		});
		expect(explosion.isExploded('origin')).toBe(true);

		explosion.toggleExplode('origin', { childNodes: [child], duration: 0 }, { duration: 0 });
		expect(explosion.isExploded('origin')).toBe(false);
	});

	it('updates node positions and opacity continuously across multiple animation frames without freezing', () => {
		let currentTime = 1000;
		const originalDateNow = Date.now;
		Date.now = () => currentTime;

		let rafCallback: (() => void) | null = null;
		const originalRaf = globalThis.requestAnimationFrame;
		globalThis.requestAnimationFrame = ((cb: () => void) => {
			rafCallback = cb;
			return 1;
		}) as any;

		try {
			const origin = createNode('origin', 0, 0);
			const graph = createCanvasGraph({ initialNodes: [origin] });
			const explosion = createCanvasExplosion(graph);

			const child = createNode('c1', 100, 100);

			explosion.explodeNode('origin', {
				childNodes: [child],
				duration: 200,
				easing: (t) => t,
				trajectory: linearPositionTrajectory
			});

			// Frame 0 ran at t=0 (currentTime = 1000)
			let graphChild = graph.nodes.find((n) => n.id === 'c1')!;
			expect(graphChild).toBeDefined();

			// Advance time by 100ms (progress = 0.5)
			currentTime = 1100;
			expect(rafCallback).not.toBeNull();
			if (rafCallback) {
				const nextCb = rafCallback;
				rafCallback = null;
				nextCb();
			}

			graphChild = graph.nodes.find((n) => n.id === 'c1')!;
			expect(graphChild.position.x).toBeCloseTo(50, 0);
			expect(graphChild.position.y).toBeCloseTo(50, 0);

			// Advance time by another 100ms (progress = 1.0)
			currentTime = 1200;
			expect(rafCallback).not.toBeNull();
			if (rafCallback) {
				const nextCb = rafCallback;
				rafCallback = null;
				nextCb();
			}

			graphChild = graph.nodes.find((n) => n.id === 'c1')!;
			expect(graphChild.position.x).toBeCloseTo(100, 0);
			expect(graphChild.position.y).toBeCloseTo(100, 0);

			// Collapse node over 200ms
			explosion.collapseNode('origin', {
				duration: 200,
				easing: (t) => t,
				trajectory: linearPositionTrajectory
			});

			// Advance time by 100ms into collapse (progress = 0.5)
			currentTime = 1300;
			expect(rafCallback).not.toBeNull();
			if (rafCallback) {
				const nextCb = rafCallback;
				rafCallback = null;
				nextCb();
			}

			graphChild = graph.nodes.find((n) => n.id === 'c1')!;
			expect(graphChild).toBeDefined();
			expect(graphChild.position.x).toBeCloseTo(50, 0);
			expect(graphChild.position.y).toBeCloseTo(50, 0);

			// Advance time by another 100ms (collapse completion)
			currentTime = 1400;
			expect(rafCallback).not.toBeNull();
			if (rafCallback) {
				const nextCb = rafCallback;
				rafCallback = null;
				nextCb();
			}

			expect(graph.nodes.some((n) => n.id === 'c1')).toBe(false);
			expect(explosion.isExploded('origin')).toBe(false);
		} finally {
			Date.now = originalDateNow;
			globalThis.requestAnimationFrame = originalRaf;
		}
	});
});
