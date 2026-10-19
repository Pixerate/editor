import { describe, it, expect } from 'vitest';
import {
	createDefaultStrokeStyle,
	streamlinePoints,
	strokeBoundingBox,
	strokePointsToPathData,
	strokeToShapeNode,
	findStrokesAtPoint,
	createCanvasDrawController,
	computeDragBounds,
	computeDragBoundsFromPoints,
	type CanvasNode,
	type FreehandStroke,
	type Point
} from '../src/canvas';
import { HistoryManager } from '../src/history';

describe('canvas freehand drawing (core)', () => {
	it('creates default styles for pen and highlighter', () => {
		const penStyle = createDefaultStrokeStyle('pen');
		expect(penStyle.color).toBe('#3b82f6');
		expect(penStyle.width).toBe(3);
		expect(penStyle.opacity).toBe(1.0);
		expect(penStyle.cap).toBe('round');

		const hlStyle = createDefaultStrokeStyle('highlighter');
		expect(hlStyle.color).toBe('#facc15');
		expect(hlStyle.width).toBe(24);
		expect(hlStyle.opacity).toBe(0.35);
	});

	it('streamlines points smoothly while anchoring endpoints', () => {
		const raw: Point[] = [
			[0, 0],
			[10, 15],
			[20, 5],
			[30, 20],
			[40, 0]
		];

		const smoothed = streamlinePoints(raw, 0.5);
		expect(smoothed.length).toBe(raw.length);
		// Start and end points must match raw input
		expect(smoothed[0]).toEqual(raw[0]);
		expect(smoothed[smoothed.length - 1]).toEqual(raw[raw.length - 1]);

		// Intermediate points are smoothed
		expect(smoothed[1][0]).toBeCloseTo(5);
		expect(smoothed[1][1]).toBeCloseTo(7.5);
	});

	it('computes tight stroke bounding boxes with margins', () => {
		const points: Point[] = [
			[10, 20],
			[50, 80],
			[30, 40]
		];

		const tight = strokeBoundingBox(points, 0);
		expect(tight.x).toBe(10);
		expect(tight.y).toBe(20);
		expect(tight.width).toBe(40);
		expect(tight.height).toBe(60);

		const withMargin = strokeBoundingBox(points, 5);
		expect(withMargin.x).toBe(5);
		expect(withMargin.y).toBe(15);
		expect(withMargin.width).toBe(50);
		expect(withMargin.height).toBe(70);
	});

	it('generates path data for single dots, lines, and curves', () => {
		// Single point
		const dotPath = strokePointsToPathData([[15, 25]]);
		expect(dotPath).toContain('M 15 25');
		expect(dotPath).toContain('L 15.01 25');

		// Two points
		const linePath = strokePointsToPathData([[0, 0], [100, 50]]);
		expect(linePath).toBe('M 0 0 L 100 50');

		// Multi points curve
		const arcPoints: Point[] = Array.from({ length: 16 }, (_, i) => {
			const rad = (i / 15) * Math.PI;
			return [Math.round(50 + 40 * Math.cos(rad)), Math.round(50 + 40 * Math.sin(rad))];
		});
		const curvePath = strokePointsToPathData(arcPoints);
		expect(curvePath.startsWith('M')).toBe(true);
		expect(curvePath.includes('C') || curvePath.includes('L')).toBe(true);
	});

	it('converts a FreehandStroke to a native ShapeNode with normalized viewBox', () => {
		const stroke: FreehandStroke = {
			id: 'stroke-1',
			tool: 'pen',
			points: [
				[100, 200],
				[150, 250],
				[200, 220]
			],
			style: {
				color: '#ec4899',
				width: 4,
				opacity: 0.9,
				cap: 'round',
				join: 'round'
			}
		};

		const node = strokeToShapeNode(stroke);
		expect(node.id).toBe('stroke-1');
		expect(node.type).toBe('shape');
		expect(node.position.x).toBe(100);
		expect(node.position.y).toBe(200);
		expect(node.width).toBe(100);
		expect(node.height).toBe(50);

		const shape = node.data.shape;
		expect(shape.kind).toBe('path');
		expect(shape.viewBox).toEqual([0, 0, 100, 50]);
		expect(shape.stroke).toBe('#ec4899');
		expect(shape.strokeWidth).toBe(4);
		expect(shape.strokeLinecap).toBe('round');
		expect(shape.strokeLinejoin).toBe('round');
		expect(shape.opacity).toBe(0.9);
		expect(shape.fill).toBe('none');
	});

	it('converts a gradient FreehandStroke preserving gradient definitions and endcaps', () => {
		const gradientStroke: FreehandStroke = {
			id: 'stroke-grad',
			tool: 'pen',
			points: [
				[10, 10],
				[50, 50]
			],
			style: {
				color: {
					type: 'linear',
					angle: 45,
					stops: [
						{ offset: 0, color: '#f97316' },
						{ offset: 1, color: '#ec4899' }
					]
				},
				width: 6,
				cap: 'round',
				join: 'round'
			}
		};

		const node = strokeToShapeNode(gradientStroke);
		expect(node.data.shape.strokeLinecap).toBe('round');
		expect(node.data.shape.strokeLinejoin).toBe('round');
		expect(node.data.shape.strokeGradient).toEqual(gradientStroke.style.color);
	});

	it('finds stroke nodes intersecting an eraser point', () => {
		const stroke: FreehandStroke = {
			id: 'stroke-test',
			tool: 'pen',
			points: [
				[50, 50],
				[100, 50],
				[150, 50]
			],
			style: createDefaultStrokeStyle('pen')
		};
		const strokeNode = strokeToShapeNode(stroke);
		const nodes: CanvasNode[] = [strokeNode];

		// Point directly on stroke line
		const hit1 = findStrokesAtPoint([100, 50], nodes, 5);
		expect(hit1.length).toBe(1);
		expect(hit1[0].id).toBe('stroke-test');

		// Point 6px away with radius 10px (should hit)
		const hit2 = findStrokesAtPoint([100, 56], nodes, 10);
		expect(hit2.length).toBe(1);

		// Point far away (should miss)
		const miss = findStrokesAtPoint([100, 120], nodes, 10);
		expect(miss.length).toBe(0);
	});
});

describe('createCanvasDrawController', () => {
	it('switches tools and updates style defaults', () => {
		let nodes: CanvasNode[] = [];
		const controller = createCanvasDrawController({
			getNodes: () => nodes,
			setNodes: (n) => {
				nodes = n;
			}
		});

		expect(controller.tool).toBe('select');
		controller.setTool('pen');
		expect(controller.tool).toBe('pen');
		expect(controller.style.width).toBe(3);

		controller.setTool('highlighter');
		expect(controller.tool).toBe('highlighter');
		expect(controller.style.width).toBe(24);
		expect(controller.style.opacity).toBe(0.35);

		controller.setStyle({ color: '#ff0000', width: 8 });
		expect(controller.style.color).toBe('#ff0000');
		expect(controller.style.width).toBe(8);
	});

	it('draws a complete stroke and records an undoable command', () => {
		let nodes: CanvasNode[] = [];
		const history = new HistoryManager({ maxDepth: 50 });

		const controller = createCanvasDrawController({
			getNodes: () => nodes,
			setNodes: (n) => {
				nodes = n;
			},
			history,
			tool: 'pen'
		});

		controller.startStroke([10, 10]);
		expect(controller.isDrawing).toBe(true);
		expect(controller.activeStroke?.points).toEqual([[10, 10]]);

		controller.continueStroke([30, 40]);
		controller.continueStroke([60, 80]);
		expect(controller.activeStroke?.points.length).toBe(3);

		const created = controller.endStroke();
		expect(controller.isDrawing).toBe(false);
		expect(created).not.toBeNull();
		expect(nodes.length).toBe(1);
		expect(nodes[0].id).toBe(created!.id);
		expect(nodes[0].type).toBe('shape');

		// Undo removes the stroke
		expect(history.getState().canUndo).toBe(true);
		history.undo();
		expect(nodes.length).toBe(0);

		// Redo restores the stroke
		expect(history.getState().canRedo).toBe(true);
		history.redo();
		expect(nodes.length).toBe(1);
		expect(nodes[0].id).toBe(created!.id);
	});

	it('erases strokes in batch with undo and redo support', () => {
		const s1 = strokeToShapeNode({
			id: 's1',
			tool: 'pen',
			points: [[10, 10], [50, 10]],
			style: createDefaultStrokeStyle('pen')
		});
		const s2 = strokeToShapeNode({
			id: 's2',
			tool: 'pen',
			points: [[10, 30], [50, 30]],
			style: createDefaultStrokeStyle('pen')
		});

		let nodes: CanvasNode[] = [s1, s2];
		const history = new HistoryManager({ maxDepth: 50 });

		const controller = createCanvasDrawController({
			getNodes: () => nodes,
			setNodes: (n) => {
				nodes = n;
			},
			history,
			tool: 'eraser'
		});

		// Drag eraser across s1 and s2
		controller.startStroke([25, 10]);
		expect(nodes.map((n) => n.id)).toEqual(['s2']);

		controller.continueStroke([25, 30]);
		expect(nodes.length).toBe(0);

		controller.endStroke();

		// Undo restores both erased strokes
		expect(history.getState().canUndo).toBe(true);
		history.undo();
		expect(nodes.length).toBe(2);
		expect(nodes.map((n) => n.id)).toEqual(['s1', 's2']);

		// Redo removes both strokes again
		expect(history.getState().canRedo).toBe(true);
		history.redo();
		expect(nodes.length).toBe(0);
	});

	describe('computeDragBounds modifier keys', () => {
		it('computes standard bounding box correctly in all 4 quadrants', () => {
			// Bottom-right drag
			expect(computeDragBounds({ x: 10, y: 20 }, { x: 50, y: 80 })).toEqual({
				x: 10,
				y: 20,
				width: 40,
				height: 60
			});

			// Top-left drag
			expect(computeDragBounds({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({
				x: 10,
				y: 20,
				width: 40,
				height: 60
			});
		});

		it('constrains aspect ratio to 1:1 when constrain is true (Shift key)', () => {
			// dx = 40, dy = 60 -> max is 60 -> width: 60, height: 60
			const bounds = computeDragBounds({ x: 100, y: 100 }, { x: 140, y: 160 }, { constrain: true });
			expect(bounds).toEqual({
				x: 100,
				y: 100,
				width: 60,
				height: 60
			});

			// Negative quadrant
			const boundsNeg = computeDragBounds({ x: 100, y: 100 }, { x: 70, y: 50 }, { constrain: true });
			// dx = -30, dy = -50 -> max is 50 -> dx = -50, dy = -50 -> min is 50, min y is 50
			expect(boundsNeg).toEqual({
				x: 50,
				y: 50,
				width: 50,
				height: 50
			});
		});

		it('draws from center when fromCenter is true (Alt/Option key)', () => {
			const bounds = computeDragBounds({ x: 100, y: 100 }, { x: 150, y: 130 }, { fromCenter: true });
			expect(bounds).toEqual({
				x: 50,
				y: 70,
				width: 100,
				height: 60
			});
		});

		it('combines constrain and fromCenter (Shift + Alt)', () => {
			const bounds = computeDragBounds(
				{ x: 100, y: 100 },
				{ x: 140, y: 180 },
				{ constrain: true, fromCenter: true }
			);
			// max(|dx|, |dy|) = max(40, 80) = 80
			// halfW = 80, halfH = 80 -> x = 100 - 80 = 20, y = 100 - 80 = 20, width = 160, height = 160
			expect(bounds).toEqual({
				x: 20,
				y: 20,
				width: 160,
				height: 160
			});
		});

		it('supports computeDragBoundsFromPoints helper', () => {
			const bounds = computeDragBoundsFromPoints(50, 50, 70, 70);
			expect(bounds).toEqual({
				x: 50,
				y: 50,
				width: 20,
				height: 20
			});
		});
	});
});
