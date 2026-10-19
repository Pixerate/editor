/**
 * Headless controller managing freehand drawing lifecycle, tool selection,
 * real-time pointer capture, ShapeNode creation, and undoable history actions.
 */
import type { ArrangeHistoryTarget } from './arrangeController.js';
import type { CanvasNode, Point } from './types.js';
import { isLocked } from './arrange.js';
import {
	createDefaultStrokeStyle,
	findStrokesAtPoint,
	streamlinePoints,
	strokeToShapeNode,
	type FreehandDrawOptions,
	type FreehandStroke,
	type FreehandStrokeStyle,
	type FreehandTool
} from './freehand.js';

export interface CanvasDrawControllerOptions<TNode extends CanvasNode = CanvasNode> {
	getNodes: () => TNode[];
	setNodes: (nodes: TNode[]) => void;
	history?: ArrangeHistoryTarget;
	tool?: FreehandTool;
	style?: Partial<FreehandStrokeStyle>;
	drawOptions?: FreehandDrawOptions;
	generateNodeId?: () => string;
	onToolChange?: (tool: FreehandTool) => void;
	onStyleChange?: (style: FreehandStrokeStyle) => void;
	onActiveStrokeChange?: (stroke: FreehandStroke | null) => void;
	onStrokeComplete?: (node: TNode) => void;
	onNodesErase?: (erasedNodes: TNode[]) => void;
}

export function createCanvasDrawController<TNode extends CanvasNode = CanvasNode>(
	options: CanvasDrawControllerOptions<TNode>
) {
	let currentTool: FreehandTool = options.tool ?? 'select';
	let currentStyle: FreehandStrokeStyle = {
		...createDefaultStrokeStyle(currentTool),
		...options.style
	};
	let activeStroke: FreehandStroke | null = null;
	const erasedInDrag = new Map<string, { node: TNode; index: number }>();

	let dragStartNodes: TNode[] | null = null;

	function setTool(tool: FreehandTool) {
		if (currentTool === tool) return;
		cancelStroke();
		currentTool = tool;
		// Update default styles when switching between pen and highlighter
		if (tool === 'pen' || tool === 'highlighter') {
			currentStyle = {
				...createDefaultStrokeStyle(tool),
				...options.style
			};
			options.onStyleChange?.(currentStyle);
		}
		options.onToolChange?.(tool);
	}

	function setStyle(style: Partial<FreehandStrokeStyle>) {
		currentStyle = { ...currentStyle, ...style };
		options.onStyleChange?.(currentStyle);
	}

	function startStroke(point: Point) {
		if (currentTool === 'select') return;

		if (currentTool === 'eraser') {
			erasedInDrag.clear();
			dragStartNodes = [...options.getNodes()];
			eraseAt(point);
			return;
		}

		const id =
			options.generateNodeId?.() ??
			`stroke-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

		activeStroke = {
			id,
			tool: currentTool,
			points: [point],
			style: { ...currentStyle },
			startTime: Date.now()
		};

		options.onActiveStrokeChange?.(activeStroke);
	}

	function continueStroke(point: Point) {
		if (currentTool === 'eraser') {
			eraseAt(point);
			return;
		}

		if (!activeStroke) return;

		const points = activeStroke.points;
		const last = points[points.length - 1];
		// Discard identical or micro jitter points (sub-pixel)
		if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 0.25) return;

		points.push(point);
		options.onActiveStrokeChange?.({ ...activeStroke, points: [...points] });
	}

	function endStroke(): TNode | null {
		if (currentTool === 'eraser') {
			const startSnapshot = dragStartNodes;
			dragStartNodes = null;
			if (erasedInDrag.size > 0 && options.history && startSnapshot) {
				const erasedIds = new Set(Array.from(erasedInDrag.keys()));

				options.history.execute({
					name: 'Erase strokes',
					execute: () => {
						const remaining = options.getNodes().filter((n) => !erasedIds.has(n.id));
						options.setNodes(remaining as TNode[]);
					},
					undo: () => {
						options.setNodes(startSnapshot);
					}
				});
			}
			erasedInDrag.clear();
			return null;
		}

		if (!activeStroke) return null;

		const stroke = activeStroke;
		activeStroke = null;
		options.onActiveStrokeChange?.(null);

		if (stroke.points.length === 0) return null;

		const drawOpts = options.drawOptions ?? {};
		const smoothed = streamlinePoints(stroke.points, drawOpts.streamline ?? 0.35);
		const node = strokeToShapeNode(
			{ ...stroke, points: smoothed },
			{
				tolerance: drawOpts.tolerance ?? 1.0,
				cornerAngleDeg: drawOpts.cornerAngleDeg ?? 40
			}
		) as TNode;

		if (options.history) {
			options.history.execute({
				name: `Draw ${stroke.tool}`,
				execute: () => {
					options.setNodes([...options.getNodes(), node]);
				},
				undo: () => {
					options.setNodes(options.getNodes().filter((n) => n.id !== node.id) as TNode[]);
				}
			});
		} else {
			options.setNodes([...options.getNodes(), node]);
		}

		options.onStrokeComplete?.(node);
		return node;
	}

	function cancelStroke() {
		if (activeStroke) {
			activeStroke = null;
			options.onActiveStrokeChange?.(null);
		}
		if (erasedInDrag.size > 0) {
			// Restore nodes erased during this aborted drag if any
			const entries = Array.from(erasedInDrag.values());
			const current = [...options.getNodes()];
			const sorted = [...entries].sort((a, b) => a.index - b.index);
			for (const { node, index } of sorted) {
				const insertAt = Math.min(index, current.length);
				current.splice(insertAt, 0, node);
			}
			options.setNodes(current);
			erasedInDrag.clear();
		}
	}

	function eraseAt(point: Point, radius = 12): TNode[] {
		const nodes = options.getNodes();
		const candidates = findStrokesAtPoint(point, nodes, radius);
		const newlyErased: TNode[] = [];

		for (const candidate of candidates) {
			if (erasedInDrag.has(candidate.id) || isLocked(candidate)) continue;

			const index = nodes.findIndex((n) => n.id === candidate.id);
			if (index !== -1) {
				erasedInDrag.set(candidate.id, { node: candidate as TNode, index });
				newlyErased.push(candidate as TNode);
			}
		}

		if (newlyErased.length > 0) {
			const erasedSet = new Set(newlyErased.map((n) => n.id));
			const nextNodes = nodes.filter((n) => !erasedSet.has(n.id)) as TNode[];
			options.setNodes(nextNodes);
			options.onNodesErase?.(newlyErased);
		}

		return newlyErased;
	}

	return {
		get tool() {
			return currentTool;
		},
		setTool,
		get style() {
			return currentStyle;
		},
		setStyle,
		get activeStroke() {
			return activeStroke;
		},
		get isDrawing() {
			return activeStroke !== null;
		},
		startStroke,
		continueStroke,
		endStroke,
		cancelStroke,
		eraseAt
	};
}

export type CanvasDrawController = ReturnType<typeof createCanvasDrawController>;

/** Modifier options when computing bounds while dragging/drawing. */
export interface CanvasDragBoundsModifiers {
	/** If true (e.g. Shift key held), constrain the bounding box to 1:1 aspect ratio. */
	constrain?: boolean;
	/** If true (e.g. Alt/Option key held), draw/expand outward from the initial start point as center. */
	fromCenter?: boolean;
}

export interface CanvasDragBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Computes bounding rectangle from start and current points, supporting
 * `constrain` (aspect ratio 1:1, Shift key) and `fromCenter` (origin as center, Alt/Option key).
 */
export function computeDragBounds(
	start: { x: number; y: number },
	current: { x: number; y: number },
	modifiers: CanvasDragBoundsModifiers = {}
): CanvasDragBounds {
	let dx = current.x - start.x;
	let dy = current.y - start.y;

	if (modifiers.constrain) {
		const absDx = Math.abs(dx);
		const absDy = Math.abs(dy);
		const maxDim = Math.max(absDx, absDy);
		dx = (dx < 0 ? -1 : 1) * maxDim;
		dy = (dy < 0 ? -1 : 1) * maxDim;
	}

	if (modifiers.fromCenter) {
		const halfW = Math.abs(dx);
		const halfH = Math.abs(dy);
		return {
			x: start.x - halfW,
			y: start.y - halfH,
			width: halfW * 2,
			height: halfH * 2
		};
	}

	return {
		x: Math.min(start.x, start.x + dx),
		y: Math.min(start.y, start.y + dy),
		width: Math.abs(dx),
		height: Math.abs(dy)
	};
}

/**
 * Computes bounding rectangle from start point and raw dimensions (dx, dy).
 */
export function computeDragBoundsFromPoints(
	startX: number,
	startY: number,
	currentX: number,
	currentY: number,
	modifiers: CanvasDragBoundsModifiers = {}
): CanvasDragBounds {
	return computeDragBounds({ x: startX, y: startY }, { x: currentX, y: currentY }, modifiers);
}
