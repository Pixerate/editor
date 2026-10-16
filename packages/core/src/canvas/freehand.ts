/**
 * Freehand drawing utilities: stroke smoothing, cubic Bézier conversion,
 * ShapeNode generation, and spatial eraser hit-testing within the xyflow framework.
 */
import type { CanvasNode, Point, Rect } from './types.js';
import { fitFreehandPath, type FitPathDataOptions } from './curveFit.js';
import { distanceToBezierPath } from './pathops/bezier.js';
import { getNodeShape } from './shapeNodes.js';
import { getNodeRect } from './arrange.js';

export type FreehandTool = 'select' | 'pen' | 'highlighter' | 'eraser';

export interface FreehandStrokeStyle {
	/** Stroke color (any CSS color string). */
	color: string;
	/** Stroke width in flow canvas units. */
	width: number;
	/** Stroke opacity (0 to 1). */
	opacity: number;
	/** SVG stroke-linecap: 'round', 'butt', or 'square'. */
	cap?: 'round' | 'butt' | 'square';
	/** SVG stroke-linejoin: 'round', 'bevel', or 'miter'. */
	join?: 'round' | 'bevel' | 'miter';
}

export interface FreehandDrawOptions {
	/** Cubic curve fitting tolerance (default: 1.0). Lower is tighter to points. */
	tolerance?: number;
	/** Corner angle threshold in degrees for sharp corners (default: 40). */
	cornerAngleDeg?: number;
	/** Real-time point streamlining / smoothing factor in [0, 1] (default: 0.35). 0 disables smoothing. */
	streamline?: number;
}

export interface FreehandStroke {
	id: string;
	tool: FreehandTool;
	points: Point[];
	style: FreehandStrokeStyle;
	startTime?: number;
}

/**
 * Returns default stroke styles tailored for specific drawing tools.
 */
export function createDefaultStrokeStyle(tool: FreehandTool): FreehandStrokeStyle {
	if (tool === 'highlighter') {
		return {
			color: '#facc15',
			width: 24,
			opacity: 0.35,
			cap: 'round',
			join: 'round'
		};
	}
	return {
		color: '#3b82f6',
		width: 3,
		opacity: 1.0,
		cap: 'round',
		join: 'round'
	};
}

/**
 * Smooths jittery pointer samples using an exponential moving average.
 * The first and last points are anchored to guarantee stroke start and end precision.
 */
export function streamlinePoints(points: readonly Point[], factor = 0.35): Point[] {
	if (points.length < 3 || factor <= 0) return [...points];
	const clampedFactor = Math.min(Math.max(factor, 0), 0.95);
	const smoothed: Point[] = [points[0]];

	for (let i = 1; i < points.length - 1; i++) {
		const prev = smoothed[i - 1];
		const curr = points[i];
		const x = prev[0] * clampedFactor + curr[0] * (1 - clampedFactor);
		const y = prev[1] * clampedFactor + curr[1] * (1 - clampedFactor);
		smoothed.push([x, y]);
	}

	smoothed.push(points[points.length - 1]);
	return smoothed;
}

/**
 * Computes the tight axis-aligned bounding box of a sequence of points,
 * optionally expanded by a margin (such as strokeWidth / 2).
 */
export function strokeBoundingBox(points: readonly Point[], margin = 0): Rect {
	if (points.length === 0) {
		return { x: 0, y: 0, width: 0, height: 0 };
	}
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const [x, y] of points) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}

	const w = Math.max(maxX - minX, 0);
	const h = Math.max(maxY - minY, 0);

	return {
		x: minX - margin,
		y: minY - margin,
		width: Math.max(w + margin * 2, 1),
		height: Math.max(h + margin * 2, 1)
	};
}

/**
 * Converts a sequence of points into an SVG path `d` string.
 * Gracefully handles single points (dots) and two-point line segments.
 */
export function strokePointsToPathData(
	points: readonly Point[],
	options: Omit<FitPathDataOptions, 'closed'> = {}
): string {
	if (points.length === 0) return '';
	if (points.length === 1) {
		const [x, y] = points[0];
		// Small delta with round cap renders as a circular dot
		return `M ${x} ${y} L ${x + 0.01} ${y}`;
	}
	if (points.length === 2) {
		const [p0, p1] = points;
		return `M ${p0[0]} ${p0[1]} L ${p1[0]} ${p1[1]}`;
	}
	const fitted = fitFreehandPath(points, options);
	return fitted.length > 0 ? fitted : `M ${points[0][0]} ${points[0][1]}`;
}

export interface StrokeToShapeNodeOptions {
	id?: string;
	tolerance?: number;
	cornerAngleDeg?: number;
}

/**
 * Converts a completed freehand stroke into a native xyflow `ShapeNode`.
 * The geometry is normalized to node-local space with `viewBox`, ensuring crisp
 * scaling, non-scaling strokes, and full compatibility with existing shape ops.
 */
export function strokeToShapeNode(
	stroke: FreehandStroke,
	options: StrokeToShapeNodeOptions = {}
): CanvasNode {
	const points = stroke.points;
	const strokeWidth = stroke.style.width || 3;
	const bounds = strokeBoundingBox(points, 0);

	// Normalize points to node-local origin (0, 0)
	const localPoints = points.map(
		([x, y]) => [x - bounds.x, y - bounds.y] as Point
	);

	const d = strokePointsToPathData(localPoints, {
		tolerance: options.tolerance ?? 1.0,
		cornerAngleDeg: options.cornerAngleDeg ?? 40
	});

	const width = Math.max(bounds.width, 1);
	const height = Math.max(bounds.height, 1);

	return {
		id: options.id ?? stroke.id,
		type: 'shape',
		position: { x: bounds.x, y: bounds.y },
		width,
		height,
		style: {
			width,
			height
		},
		data: {
			shape: {
				kind: 'path',
				d,
				viewBox: [0, 0, width, height],
				stroke: stroke.style.color,
				strokeWidth,
				opacity: stroke.style.opacity,
				fill: 'none'
			},
			tool: stroke.tool
		}
	};
}

/**
 * Finds all stroke shape nodes intersecting a given point within a hit radius.
 * Ideal for object eraser interactions.
 */
export function findStrokesAtPoint(
	point: Point,
	nodes: readonly CanvasNode[],
	radius = 12
): CanvasNode[] {
	const matches: CanvasNode[] = [];

	for (const node of nodes) {
		const shape = getNodeShape(node);
		if (!shape || shape.kind !== 'path') continue;

		const rect = getNodeRect(node);
		const strokeWidth = shape.strokeWidth ?? 2;
		const effectiveRadius = radius + strokeWidth / 2;

		// Fast AABB rejection test
		if (
			point[0] < rect.x - effectiveRadius ||
			point[0] > rect.x + rect.width + effectiveRadius ||
			point[1] < rect.y - effectiveRadius ||
			point[1] > rect.y + rect.height + effectiveRadius
		) {
			continue;
		}

		// Local coordinates relative to node origin
		const localPoint: Point = [point[0] - rect.x, point[1] - rect.y];

		// Exact distance check to path contours
		try {
			const dist = distanceToBezierPath(shape.d, localPoint);
			if (dist <= effectiveRadius) {
				matches.push(node);
			}
		} catch {
			// If path is malformed, fall back to AABB inside check
			if (
				point[0] >= rect.x &&
				point[0] <= rect.x + rect.width &&
				point[1] >= rect.y &&
				point[1] <= rect.y + rect.height
			) {
				matches.push(node);
			}
		}
	}

	return matches;
}
