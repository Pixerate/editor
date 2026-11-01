/**
 * Headless controller managing freehand drawing lifecycle, tool selection,
 * real-time pointer capture, ShapeNode creation, and undoable history actions.
 */
import type { ArrangeHistoryTarget } from './arrangeController.js';
import type { CanvasNode, Point } from './types.js';
import { createNodeLookup, getNodeRect, isLocked } from './arrange.js';
import {
	createDefaultStrokeStyle,
	findStrokesAtPoint,
	streamlinePoints,
	strokeToShapeNode,
	type FreehandDrawOptions,
	type FreehandPenSample,
	type FreehandStroke,
	type FreehandStrokeStyle,
	type FreehandTool
} from './freehand.js';
import { listCanvasBrushes, loadCanvasBrushstrokeRenderer, validateCanvasBrush, type CanvasBrush, type CanvasBrushPaint } from './brushstroke.js';

/** A stroke drawn by code or an agent (`drawStroke`). */
export interface DrawStrokeInput {
	/** Points in canvas (flow) coordinates, at least one. */
	points: readonly Point[];
	/** `pen` (default) or `highlighter`: picks the default style. */
	tool?: 'pen' | 'highlighter';
	/** Style over the tool's defaults (colour, width, opacity, cap, join, brush, paint). */
	style?: Partial<FreehandStrokeStyle>;
	/** Pressure 0..1 spread evenly along the stroke (one value is constant). Brushed strokes only. */
	pressure?: readonly number[];
	/** Pen tilt in degrees (−90..90) spread evenly along the stroke. Brushed strokes only. */
	tiltX?: readonly number[];
	tiltY?: readonly number[];
	/** Smooth the points before fitting (default false: agent points are taken as given). */
	streamline?: boolean;
}

export interface DrawStrokeResult<TNode extends CanvasNode = CanvasNode> {
	id: string;
	node: TNode;
	/** The new node's box in canvas coordinates. */
	bounds: { x: number; y: number; width: number; height: number };
	/** The brush of a brushed stroke, with the profiles it stored. */
	brush?: unknown;
}

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

	function startStroke(point: Point, pen?: FreehandPenSample) {
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
			...(pen ? { samples: [{ ...pen }] } : {}),
			style: { ...currentStyle },
			startTime: Date.now()
		};

		options.onActiveStrokeChange?.(activeStroke);
	}

	function continueStroke(point: Point, pen?: FreehandPenSample) {
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
		if (pen && !activeStroke.samples) activeStroke.samples = points.slice(0, -1).map(() => ({}));
		activeStroke.samples?.push(pen ? { ...pen } : {});
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

		addStrokeNode(node, `Draw ${stroke.tool}`);
		options.onStrokeComplete?.(node);
		return node;
	}

	function addStrokeNode(node: TNode, name: string) {
		if (options.history) {
			options.history.execute({
				name,
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
	}

	/**
	 * Draws a whole stroke at once (for agents and code): validates the points, the brush and its
	 * paint (an unknown or wet brush, or bad gradient paint, is refused before anything changes),
	 * adds the stroke node as one undo step and returns its id and bounds. Brushed strokes load the paint engine first, so this is
	 * async.
	 */
	async function drawStroke(input: DrawStrokeInput): Promise<DrawStrokeResult<TNode>> {
		const points = input.points;
		if (!Array.isArray(points) || points.length === 0) throw new Error('drawStroke needs at least one point ([x, y] in canvas coordinates).');
		for (const p of points) {
			if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
				throw new Error('Every point must be [x, y] with finite numbers (canvas coordinates).');
			}
		}
		const tool = input.tool ?? 'pen';
		if (tool !== 'pen' && tool !== 'highlighter') throw new Error(`Unknown tool '${String(tool)}': use 'pen' or 'highlighter'.`);
		const style: FreehandStrokeStyle = { ...createDefaultStrokeStyle(tool), ...input.style };
		if (!(style.width > 0)) throw new Error('width must be a positive number of canvas units.');
		const profiles = { pressure: input.pressure, tiltX: input.tiltX, tiltY: input.tiltY };
		for (const [key, values] of Object.entries(profiles)) {
			if (values === undefined) continue;
			const [lo, hi] = key === 'pressure' ? [0, 1] : [-90, 90];
			if (!Array.isArray(values) || values.length === 0 || values.some((v) => !Number.isFinite(v) || v < lo || v > hi)) {
				throw new Error(`${key} must be a non-empty list of numbers in ${lo}..${hi}.`);
			}
		}
		if ((input.pressure || input.tiltX || input.tiltY) && style.brush === undefined) {
			throw new Error('pressure and tilt profiles only shape brushed strokes: pass a brush too (see canvas.listBrushes).');
		}
		if (style.paint !== undefined && style.brush === undefined) {
			throw new Error('paint (gradient paint) only colours brushed strokes: pass a brush too (see canvas.listBrushes), or use color for a plain stroke.');
		}
		if (style.brush !== undefined) await validateCanvasBrush(style.brush as CanvasBrush);
		// Store the paint normalised (lowercase #rrggbb, defaults filled in) so the result shows what renders.
		if (style.paint !== undefined) style.paint = (await loadCanvasBrushstrokeRenderer()).resolveCanvasPaint(style.paint) as CanvasBrushPaint;

		const id = options.generateNodeId?.() ?? `stroke-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		const smoothed = input.streamline ? streamlinePoints(points, options.drawOptions?.streamline ?? 0.35) : [...points];
		const node = strokeToShapeNode(
			{ id, tool, points: smoothed, style },
			{ tolerance: options.drawOptions?.tolerance ?? 1.0, cornerAngleDeg: options.drawOptions?.cornerAngleDeg ?? 40 }
		) as TNode;
		const shape = (node.data as { shape: { brush?: Record<string, unknown> } }).shape;
		if (shape.brush) {
			for (const [key, values] of Object.entries(profiles)) if (values) shape.brush[key] = [...values];
		}
		addStrokeNode(node, `Draw ${tool}`);
		options.onStrokeComplete?.(node);
		const pos = node.position ?? { x: 0, y: 0 };
		return {
			id: node.id,
			node,
			bounds: { x: pos.x, y: pos.y, width: Number(node.width ?? 0), height: Number(node.height ?? 0) },
			...(shape.brush ? { brush: shape.brush } : {})
		};
	}

	/** A node's box in canvas coordinates (following its parents), or `undefined` for an unknown id. Gesture commands use it to resolve `{ nodeId }`. */
	function nodeBounds(id: string): { x: number; y: number; width: number; height: number } | undefined {
		const nodes = options.getNodes();
		const node = nodes.find((n) => n.id === id);
		return node ? getNodeRect(node, createNodeLookup(nodes)) : undefined;
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
		eraseAt,
		drawStroke,
		nodeBounds,
		/** The dry paint presets a stroke can be brushed with (loads the paint engine). */
		listBrushes: listCanvasBrushes
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
