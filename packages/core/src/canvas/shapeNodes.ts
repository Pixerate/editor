/**
 * Shape nodes and Freeform-style shape boolean operations (Unite / Intersect / Subtract /
 * Exclude / Divide) on canvas nodes.
 *
 * A shape node is any node whose `data.shape` is a `ShapeDescription`. Its geometry is
 * relative to the node box, so moving or resizing the node moves / resizes the shape.
 */
import {
	createNodeLookup,
	getAbsolutePosition,
	getNodeSize,
	isLocked,
	withStyleSize,
	LOCKED_DATA_KEY,
	LOCKED_PREVIOUS_FLAGS_KEY,
	type NodeRectOptions
} from './arrange.js';
import {
	dividePolygons,
	multiPolygonBounds,
	polygonBoolean,
	type MultiPolygon,
	type PolygonBooleanOperation,
	type PolygonFillRule,
	type PolygonRing
} from './polygonBoolean.js';
import {
	isShapeDescription,
	polygonToSvgPath,
	shapeToPolygon,
	type PathShape,
	type ShapeDescription
} from './shapeGeometry.js';
import type { CanvasNode, Point } from './types.js';

/** Data key holding a node's shape description. */
export const SHAPE_DATA_KEY = 'shape';

/** Node type suggested for shape nodes (register `ShapeNode` under it). */
export const SHAPE_NODE_TYPE = 'shape';

/** Freeform's shape operations. `exclude` is xor; `divide` splits into every region. */
export type ShapeOperation = 'unite' | 'intersect' | 'subtract' | 'exclude' | 'divide';

export const SHAPE_OPERATIONS: readonly ShapeOperation[] = ['unite', 'intersect', 'subtract', 'exclude', 'divide'];

const BOOLEAN_FOR: Record<Exclude<ShapeOperation, 'divide'>, PolygonBooleanOperation> = {
	unite: 'union',
	intersect: 'intersection',
	subtract: 'difference',
	exclude: 'xor'
};

/** Whether a node carries a supported `data.shape`. */
export function isShapeNode(node: CanvasNode | undefined | null): boolean {
	return !!node && isShapeDescription(node.data?.[SHAPE_DATA_KEY]);
}

/** The node's shape description, or `null`. */
export function getNodeShape(node: CanvasNode | undefined | null): ShapeDescription | null {
	const shape = node?.data?.[SHAPE_DATA_KEY];
	return isShapeDescription(shape) ? shape : null;
}

export interface ShapeNodePolygonOptions extends NodeRectOptions {
	/** Curve flattening tolerance in flow units (default 0.25). */
	tolerance?: number;
}

/**
 * A shape node's outline in absolute flow coordinates (parent offsets, size and rotation
 * applied), or `null` for non-shape nodes.
 */
export function shapeNodeToPolygon(
	node: CanvasNode,
	lookup?: ReadonlyMap<string, CanvasNode>,
	options: ShapeNodePolygonOptions = {}
): { rings: PolygonRing[]; fillRule: PolygonFillRule } | null {
	const shape = getNodeShape(node);
	if (!shape) return null;
	const size = getNodeSize(node, options);
	const origin = node.parentId && lookup ? getAbsolutePosition(node, lookup) : node.position;
	const { rings, fillRule } = shapeToPolygon(shape, size, { tolerance: options.tolerance });
	return {
		rings: rings.map((ring) => ring.map(([x, y]) => [x + origin.x, y + origin.y] as Point)),
		fillRule
	};
}

/** Why `combineShapeNodes` refused. */
export type CombineShapeNodesRefusal =
	/** A selected shape is locked; locked shapes are never consumed. */
	| 'locked'
	/** Fewer than two shape nodes were selected. */
	| 'too-few'
	/** The operation leaves nothing (e.g. intersecting shapes that do not overlap). */
	| 'empty';

export interface CombineShapeNodesOptions extends ShapeNodePolygonOptions {
	/**
	 * Which shape's node style and data the result inherits: `bottom` (default, like
	 * Freeform: the back-most shape), `top`, `first` (first id passed), or a node id.
	 * Divide pieces always take the style of the top-most shape covering them.
	 */
	styleFrom?: 'bottom' | 'top' | 'first' | { id: string };
	/** Id factory for new nodes (default `crypto.randomUUID`, with a counter fallback). */
	createId?: (index: number) => string;
	/** Node `type` for the new nodes (default: the style source's type). */
	nodeType?: string;
	/** Decimal places in the path data (default 3). */
	precision?: number;
	/** Ramer–Douglas–Peucker simplification tolerance for the result (default 0, off). */
	simplify?: number;
	/**
	 * How the result's outline is written: `'fit'` (default) fits smooth cubic curves to the
	 * flattened result, so booleans of curved shapes stay curved (sharp corners and straight
	 * edges are kept); `'lines'` writes the polygon as straight segments.
	 */
	curves?: 'lines' | 'fit';
	/** Curve-fitting tolerance in flow units for `curves: 'fit'` (default: `tolerance`, 0.25). */
	curveTolerance?: number;
	/** Corner threshold in degrees for `curves: 'fit'` (default 30). */
	cornerAngleDeg?: number;
	/** Point-merge tolerance passed to the boolean engine. */
	epsilon?: number;
	/** Select the new nodes (default `true`). */
	select?: boolean;
}

export type CombineShapeNodesResult<TNode extends CanvasNode = CanvasNode> =
	| {
			ok: true;
			operation: ShapeOperation;
			/** Ids of the shape nodes consumed by the operation. */
			removeIds: string[];
			/** New path shape node(s): one, or one per region for `divide`. */
			nodes: TNode[];
	  }
	| { ok: false; operation: ShapeOperation; reason: CombineShapeNodesRefusal };

let idCounter = 0;
function defaultId(index: number): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	idCounter += 1;
	return `shape-${Date.now().toString(36)}-${idCounter}-${index}`;
}

/** Back-to-front order: `zIndex` (missing = 0), then array order, as xyflow stacks nodes. */
function stackOrder<TNode extends CanvasNode>(nodes: TNode[], ids: Set<string>): TNode[] {
	return nodes
		.map((node, index) => ({ node, index, z: typeof node.zIndex === 'number' ? node.zIndex : 0 }))
		.filter((entry) => ids.has(entry.node.id))
		.sort((a, b) => a.z - b.z || a.index - b.index)
		.map((entry) => entry.node);
}

/**
 * Checks whether `combineShapeNodes` can run, without computing geometry (it cannot
 * predict an `empty` result). Use it to enable menu items.
 */
export function canCombineShapeNodes(
	nodes: CanvasNode[],
	ids: Iterable<string>
): { ok: true; shapeIds: string[] } | { ok: false; reason: Exclude<CombineShapeNodesRefusal, 'empty'> } {
	const idSet = new Set(ids);
	const shapes = nodes.filter((n) => idSet.has(n.id) && isShapeNode(n));
	if (shapes.some((n) => isLocked(n))) return { ok: false, reason: 'locked' };
	if (shapes.length < 2) return { ok: false, reason: 'too-few' };
	return { ok: true, shapeIds: shapes.map((n) => n.id) };
}

/**
 * Freeform-style shape operations on canvas nodes.
 *
 * - Only shape nodes (`data.shape`) among `ids` take part; other selected nodes are ignored.
 * - Refuses (`ok: false`) when a selected shape is locked, when fewer than two shapes are
 *   selected, or when the result is empty. Nothing should be changed on refusal.
 * - `subtract` removes every other shape from the back-most one; the other operations are
 *   symmetric. `divide` returns one node per distinct region of the overlay.
 * - Each new node is a `path` shape: its position / size is the result's bounding box and
 *   its path data is node-local with `viewBox = [0, 0, width, height]`, so it scales with
 *   the node. Rotation is baked into the path. Node fields and `data` (other than the
 *   shape geometry, lock state and size) come from the style source.
 * - When all shapes share a parent, the new nodes keep it; otherwise they are top-level.
 *
 * Pure: returns the change; apply it with `applyShapeCombination` (or the arrange
 * controller's `combineShapes`, which also records one undo step).
 */
export function combineShapeNodes<TNode extends CanvasNode>(
	nodes: TNode[],
	ids: Iterable<string>,
	operation: ShapeOperation,
	options: CombineShapeNodesOptions = {}
): CombineShapeNodesResult<TNode> {
	const idList = [...ids];
	const check = canCombineShapeNodes(nodes, idList);
	if (!check.ok) return { ok: false, operation, reason: check.reason };

	const lookup = createNodeLookup(nodes);
	const shapeIds = new Set(check.shapeIds);
	const ordered = stackOrder(nodes, shapeIds);
	const operands = ordered.map((node) => shapeNodeToPolygon(node, lookup, options)!);

	const parentIds = new Set(ordered.map((n) => n.parentId ?? ''));
	const sharedParent = parentIds.size === 1 ? ordered[0].parentId : undefined;
	const parentOrigin =
		sharedParent && lookup.get(sharedParent)
			? getAbsolutePosition(lookup.get(sharedParent)!, lookup)
			: { x: 0, y: 0 };

	const pickSource = (): TNode => {
		const style = options.styleFrom ?? 'bottom';
		if (style === 'top') return ordered[ordered.length - 1];
		if (style === 'first') {
			const first = idList.find((id) => shapeIds.has(id));
			return (first && lookup.get(first)) || ordered[0];
		}
		if (typeof style === 'object') return (shapeIds.has(style.id) && lookup.get(style.id)) || ordered[0];
		return ordered[0];
	};

	const createId = options.createId ?? defaultId;
	const build = (polygon: MultiPolygon, source: TNode, index: number): TNode | null => {
		const bounds = multiPolygonBounds(polygon);
		if (!bounds) return null;
		const width = bounds.maxX - bounds.minX;
		const height = bounds.maxY - bounds.minY;
		if (!(width > 0) || !(height > 0)) return null;
		const d = polygonToSvgPath(polygon, {
			precision: options.precision,
			simplify: options.simplify,
			offset: { x: -bounds.minX, y: -bounds.minY },
			curves: options.curves ?? 'fit',
			curveTolerance: options.curveTolerance ?? options.tolerance ?? 0.25,
			cornerAngleDeg: options.cornerAngleDeg
		});
		if (!d) return null;
		const sourceShape = getNodeShape(source)!;
		const shape: PathShape = {
			kind: 'path',
			d,
			viewBox: [0, 0, roundSize(width), roundSize(height)],
			fillRule: 'nonzero'
		};
		for (const key of ['fill', 'stroke', 'strokeWidth', 'opacity'] as const) {
			if (sourceShape[key] !== undefined) (shape as any)[key] = sourceShape[key];
		}
		const {
			[LOCKED_DATA_KEY]: _locked,
			[LOCKED_PREVIOUS_FLAGS_KEY]: _previous,
			...data
		} = source.data ?? {};
		const {
			measured: _measured,
			selected: _selected,
			dragging: _dragging,
			positionAbsolute: _positionAbsolute,
			internals: _internals,
			parentId: _parentId,
			...rest
		} = source as CanvasNode;
		const node: CanvasNode = {
			...rest,
			id: createId(index),
			position: { x: bounds.minX - parentOrigin.x, y: bounds.minY - parentOrigin.y },
			width,
			height,
			data: { ...data, [SHAPE_DATA_KEY]: shape }
		};
		if (sharedParent) node.parentId = sharedParent;
		if (options.nodeType !== undefined) node.type = options.nodeType;
		if (source.style) node.style = withStyleSize(source.style, { width, height });
		if (options.select !== false) node.selected = true;
		return node as TNode;
	};

	const created: TNode[] = [];
	if (operation === 'divide') {
		const pieces = dividePolygons(operands, { epsilon: options.epsilon });
		pieces.forEach((piece) => {
			const source = ordered[piece.operands[piece.operands.length - 1]];
			const node = build([piece.polygon], source, created.length);
			if (node) created.push(node);
		});
	} else {
		const result = polygonBoolean(BOOLEAN_FOR[operation], operands, { epsilon: options.epsilon });
		const node = build(result, pickSource(), 0);
		if (node) created.push(node);
	}
	if (created.length === 0) return { ok: false, operation, reason: 'empty' };
	return { ok: true, operation, removeIds: ordered.map((n) => n.id), nodes: created };
}

function roundSize(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/**
 * Applies a successful `combineShapeNodes` result: removes the consumed nodes and inserts
 * the new ones at the array index of the first consumed node.
 * With `deselect` (default `true`) other nodes are deselected when the result is selected.
 */
export function applyShapeCombination<TNode extends CanvasNode>(
	nodes: TNode[],
	change: { removeIds: Iterable<string>; nodes: TNode[] },
	options: { deselect?: boolean } = {}
): TNode[] {
	const remove = new Set(change.removeIds);
	const insertAt = nodes.findIndex((n) => remove.has(n.id));
	const deselect = options.deselect !== false && change.nodes.some((n) => n.selected);
	const out: TNode[] = [];
	nodes.forEach((node, index) => {
		if (index === insertAt) out.push(...change.nodes);
		if (remove.has(node.id)) return;
		out.push(deselect && node.selected ? ({ ...node, selected: false } as TNode) : node);
	});
	if (insertAt === -1) out.push(...change.nodes);
	return out;
}

/**
 * Reverses `applyShapeCombination`: removes the created nodes and puts the consumed nodes
 * back at their original array indices (`previous` is the node array before the change).
 */
export function revertShapeCombination<TNode extends CanvasNode>(
	nodes: TNode[],
	change: { removeIds: Iterable<string>; nodes: TNode[] },
	previous: TNode[]
): TNode[] {
	const created = new Set(change.nodes.map((n) => n.id));
	const removed = new Set(change.removeIds);
	const out = nodes.filter((n) => !created.has(n.id));
	previous.forEach((node, index) => {
		if (!removed.has(node.id) || out.some((n) => n.id === node.id)) return;
		out.splice(Math.min(index, out.length), 0, node);
	});
	return out;
}
