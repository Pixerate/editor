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
	getShapeSvg,
	isShapeDescription,
	polygonToSvgPath,
	shapeToPolygon,
	type PathShape,
	type ShapeDescription,
	type ShapeSize
} from './shapeGeometry.js';
import {
	bezierPathBounds,
	bezierPathToSvg,
	toBezierPath,
	transformBezierPath,
	type AffineMatrix,
	type BezierPath
} from './pathops/bezier.js';
import { dividePaths, pathBoolean, type PathOpsReport } from './pathops/boolean.js';
import { offsetPath, outlineStroke, type StrokeCap, type StrokeJoin } from './pathops/stroke.js';
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

/**
 * A shape as an exact Bézier path in node-local pixels (rotation and path view boxes
 * applied; arcs become cubics), with the fill rule it is read with.
 */
export function shapeToBezierPath(
	shape: ShapeDescription,
	size: ShapeSize
): { path: BezierPath; fillRule: PolygonFillRule } {
	const { width: w, height: h } = size;
	if (!(w > 0) || !(h > 0)) return { path: [], fillRule: 'nonzero' };
	const svg = getShapeSvg({ ...shape, rotation: 0 }, size);
	let path = toBezierPath(svg.d);
	if (shape.kind === 'path' && shape.viewBox) {
		const vb = shape.viewBox;
		if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
			const sx = w / vb[2];
			const sy = h / vb[3];
			path = transformBezierPath(path, [sx, 0, 0, sy, -vb[0] * sx, -vb[1] * sy]);
		}
	}
	const deg = shape.rotation ?? 0;
	if (deg && Number.isFinite(deg)) {
		const rad = (deg * Math.PI) / 180;
		const cos = Math.cos(rad);
		const sin = Math.sin(rad);
		const cx = w / 2;
		const cy = h / 2;
		const m: AffineMatrix = [cos, sin, -sin, cos, cx - cx * cos + cy * sin, cy - cx * sin - cy * cos];
		path = transformBezierPath(path, m);
	}
	return { path, fillRule: svg.fillRule };
}

/**
 * A shape node's outline as an exact Bézier path in absolute flow coordinates (parent
 * offsets, size and rotation applied), or `null` for non-shape nodes.
 */
export function shapeNodeToBezierPath(
	node: CanvasNode,
	lookup?: ReadonlyMap<string, CanvasNode>,
	options: NodeRectOptions = {}
): { path: BezierPath; fillRule: PolygonFillRule } | null {
	const shape = getNodeShape(node);
	if (!shape) return null;
	const size = getNodeSize(node, options);
	const origin = node.parentId && lookup ? getAbsolutePosition(node, lookup) : node.position;
	const { path, fillRule } = shapeToBezierPath(shape, size);
	return { path: transformBezierPath(path, [1, 0, 0, 1, origin.x, origin.y]), fillRule };
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
	 * Geometry engine. `'curve'` (default) computes the operation on the exact Bézier
	 * outlines and keeps the inputs' curves (circles stay cubic arcs, rectangles stay four
	 * lines); it falls back to `'polygon'` when it cannot resolve the input (reported as
	 * `engine` / `fallbackReason` on the result). `'polygon'` flattens the shapes and uses
	 * `polygonBoolean` (the behaviour before curve booleans). `curves: 'lines'` implies
	 * `'polygon'` unless an engine is named.
	 */
	engine?: 'curve' | 'polygon';
	/** Called with the reason when the curve engine falls back to polygons. */
	onFallback?: (reason: string) => void;
	/**
	 * Polygon engine only: how the result's outline is written: `'fit'` (default) fits
	 * smooth cubic curves to the flattened result (sharp corners and straight edges are
	 * kept); `'lines'` writes the polygon as straight segments.
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
			/** Engine that produced the geometry (`polygon` after a fallback). */
			engine: 'curve' | 'polygon';
			/** Why the curve engine fell back to polygons. */
			fallbackReason?: string;
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
	const buildOptions: BuildPathNodeOptions = {
		precision: options.precision,
		nodeType: options.nodeType,
		select: options.select,
		parentOrigin,
		sharedParent
	};
	const engine = options.engine ?? (options.curves === 'lines' ? 'polygon' : 'curve');

	const created: TNode[] = [];
	let report: PathOpsReport = { engine: 'curve' };
	if (engine === 'curve') {
		const operands = ordered.map((node) => shapeNodeToBezierPath(node, lookup, options)!);
		const pathOptions = { epsilon: options.epsilon, onFallback: options.onFallback, fallbackTolerance: options.tolerance };
		if (operation === 'divide') {
			const result = dividePaths(operands, pathOptions);
			report = result;
			for (const piece of result.pieces) {
				const source = ordered[piece.operands[piece.operands.length - 1]];
				const node = buildPathNode(piece.path, source, createId(created.length), buildOptions);
				if (node) created.push(node);
			}
		} else {
			const result = pathBoolean(BOOLEAN_FOR[operation], operands, pathOptions);
			report = result;
			const node = buildPathNode(result.path, pickSource(), createId(0), buildOptions);
			if (node) created.push(node);
		}
	} else {
		report = { engine: 'polygon' };
		const operands = ordered.map((node) => shapeNodeToPolygon(node, lookup, options)!);
		const write = (polygon: MultiPolygon): BezierPath =>
			toBezierPath(
				polygonToSvgPath(polygon, {
					precision: 9,
					simplify: options.simplify,
					curves: options.curves ?? 'fit',
					curveTolerance: options.curveTolerance ?? options.tolerance ?? 0.25,
					cornerAngleDeg: options.cornerAngleDeg
				})
			);
		if (operation === 'divide') {
			for (const piece of dividePolygons(operands, { epsilon: options.epsilon })) {
				const source = ordered[piece.operands[piece.operands.length - 1]];
				const node = buildPathNode(write([piece.polygon]), source, createId(created.length), buildOptions);
				if (node) created.push(node);
			}
		} else {
			const result = polygonBoolean(BOOLEAN_FOR[operation], operands, { epsilon: options.epsilon });
			const node = buildPathNode(write(result), pickSource(), createId(0), buildOptions);
			if (node) created.push(node);
		}
	}
	if (created.length === 0) return { ok: false, operation, reason: 'empty' };
	const done: CombineShapeNodesResult<TNode> = {
		ok: true,
		operation,
		removeIds: ordered.map((n) => n.id),
		nodes: created,
		engine: report.engine
	};
	if (report.fallbackReason) done.fallbackReason = report.fallbackReason;
	return done;
}

interface BuildPathNodeOptions {
	precision?: number;
	nodeType?: string;
	select?: boolean;
	parentOrigin: { x: number; y: number };
	sharedParent?: string;
	/** Paint overrides; `null` removes the key (e.g. an outlined stroke has no stroke). */
	paint?: Partial<Record<'fill' | 'stroke' | 'strokeWidth' | 'opacity', string | number | null>>;
}

/**
 * A new `path` shape node for an absolute path: positioned at the path's bounding box with
 * node-local path data and `viewBox = [0, 0, width, height]`; node fields, data and paint
 * come from `source`. `null` when the path is empty or flat.
 */
function buildPathNode<TNode extends CanvasNode>(
	path: BezierPath,
	source: TNode,
	id: string,
	options: BuildPathNodeOptions
): TNode | null {
	const bounds = bezierPathBounds(path);
	if (!bounds) return null;
	const width = bounds.maxX - bounds.minX;
	const height = bounds.maxY - bounds.minY;
	if (!(width > 0) || !(height > 0)) return null;
	const d = bezierPathToSvg(path, { precision: options.precision ?? 3, offset: { x: -bounds.minX, y: -bounds.minY } });
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
	for (const [key, value] of Object.entries(options.paint ?? {})) {
		if (value === null) delete (shape as any)[key];
		else if (value !== undefined) (shape as any)[key] = value;
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
		id,
		position: { x: bounds.minX - options.parentOrigin.x, y: bounds.minY - options.parentOrigin.y },
		width,
		height,
		data: { ...data, [SHAPE_DATA_KEY]: shape }
	};
	if (options.sharedParent) node.parentId = options.sharedParent;
	if (options.nodeType !== undefined) node.type = options.nodeType;
	if (source.style) node.style = withStyleSize(source.style, { width, height });
	if (options.select !== false) node.selected = true;
	return node as TNode;
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

// ---------------------------------------------------------------------------
// Offset Path and Outline Stroke on shape nodes
// ---------------------------------------------------------------------------

/** Per-node path edits: `offset` (Offset Path) and `outlineStroke` (Outline Stroke). */
export type ShapePathEditOperation = 'offset' | 'outlineStroke';

/** Why `offsetShapeNodes` / `outlineShapeNodeStrokes` refused. */
export type ShapePathEditRefusal =
	/** A selected shape is locked. */
	| 'locked'
	/** No shape node was selected. */
	| 'no-shapes'
	/** Outline Stroke: no selected shape has a visible stroke. */
	| 'no-stroke'
	/** Every result is empty (e.g. an inset larger than the shapes). */
	| 'empty'
	/** The offset distance or stroke width is not a finite number. */
	| 'invalid';

export type ShapePathEditResult<TNode extends CanvasNode = CanvasNode> =
	| {
			ok: true;
			operation: ShapePathEditOperation;
			/** Ids of the replaced nodes. */
			removeIds: string[];
			/** All new nodes (a replaced node may come back with the same id). */
			nodes: TNode[];
			/** Each replaced node with the nodes that take its place, in stacking order. */
			replacements: { id: string; nodes: TNode[] }[];
	  }
	| { ok: false; operation: ShapePathEditOperation; reason: ShapePathEditRefusal };

interface ShapePathEditBaseOptions extends NodeRectOptions {
	/** Id factory for new nodes (default `crypto.randomUUID`, with a counter fallback). */
	createId?: (index: number) => string;
	/** Node `type` for the new nodes (default: the source node's type). */
	nodeType?: string;
	/** Decimal places in the path data (default 3). */
	precision?: number;
	/** Select the new nodes (default `true`). */
	select?: boolean;
	/** Maximum error of the approximated offset curves in flow units (default 0.01). */
	tolerance?: number;
	/** Point-merge tolerance passed to the boolean engine. */
	epsilon?: number;
	/** Called with the reason when the curve engine falls back to polygons. */
	onFallback?: (reason: string) => void;
}

export interface OffsetShapeNodesOptions extends ShapePathEditBaseOptions {
	/** Corner style of the offset outline (default `miter`). */
	join?: StrokeJoin;
	/** Miter limit (default 4). */
	miterLimit?: number;
	/** Keep the original shape above the offset one (Illustrator style; default `false`: replace it). */
	keepOriginal?: boolean;
}

export interface OutlineShapeStrokesOptions extends ShapePathEditBaseOptions {
	/** Stroke width in flow units (default: the shape's `strokeWidth`, 1 when unset). */
	width?: number;
	/** Default `miter`, as SVG. */
	join?: StrokeJoin;
	/** Default `butt`, as SVG. */
	cap?: StrokeCap;
	/** Default 4, as SVG. */
	miterLimit?: number;
	/** Dash pattern (as `stroke-dasharray`). */
	dash?: readonly number[];
	dashOffset?: number;
	/**
	 * Keep the shape's fill as the original node with its stroke removed, below the outlined
	 * stroke (default `true`). With `false`, or when the shape has no visible fill, the node is
	 * replaced by the outlined stroke alone.
	 */
	keepFill?: boolean;
}

const INVISIBLE_PAINT = new Set(['none', 'transparent']);

/** Whether a shape draws a stroke (a stroke colour other than `none` and a positive width). */
export function hasVisibleStroke(shape: ShapeDescription | null): boolean {
	if (!shape || typeof shape.stroke !== 'string' || INVISIBLE_PAINT.has(shape.stroke.trim().toLowerCase())) return false;
	const width = shape.strokeWidth ?? 1;
	return Number.isFinite(width) && width > 0;
}

function hasVisibleFill(shape: ShapeDescription): boolean {
	return shape.fill === undefined || !INVISIBLE_PAINT.has(String(shape.fill).trim().toLowerCase());
}

function shapeTargets(nodes: CanvasNode[], ids: Iterable<string>) {
	const idSet = new Set(ids);
	return nodes.filter((n) => idSet.has(n.id) && isShapeNode(n));
}

/** Checks whether `offsetShapeNodes` can run (it cannot predict an `empty` result). */
export function canOffsetShapeNodes(
	nodes: CanvasNode[],
	ids: Iterable<string>
): { ok: true; shapeIds: string[] } | { ok: false; reason: 'locked' | 'no-shapes' } {
	const shapes = shapeTargets(nodes, ids);
	if (shapes.some((n) => isLocked(n))) return { ok: false, reason: 'locked' };
	if (shapes.length === 0) return { ok: false, reason: 'no-shapes' };
	return { ok: true, shapeIds: shapes.map((n) => n.id) };
}

/** Checks whether `outlineShapeNodeStrokes` can run. */
export function canOutlineShapeNodeStrokes(
	nodes: CanvasNode[],
	ids: Iterable<string>
): { ok: true; shapeIds: string[] } | { ok: false; reason: 'locked' | 'no-shapes' | 'no-stroke' } {
	const shapes = shapeTargets(nodes, ids);
	if (shapes.some((n) => isLocked(n))) return { ok: false, reason: 'locked' };
	if (shapes.length === 0) return { ok: false, reason: 'no-shapes' };
	const stroked = shapes.filter((n) => hasVisibleStroke(getNodeShape(n)));
	if (stroked.length === 0) return { ok: false, reason: 'no-stroke' };
	return { ok: true, shapeIds: stroked.map((n) => n.id) };
}

function editPlacement(node: CanvasNode, lookup: Map<string, CanvasNode>) {
	const parent = node.parentId ? lookup.get(node.parentId) : undefined;
	return {
		parentOrigin: parent ? getAbsolutePosition(parent, lookup) : { x: 0, y: 0 },
		sharedParent: parent ? node.parentId : undefined
	};
}

function finishEdit<TNode extends CanvasNode>(
	operation: ShapePathEditOperation,
	replacements: { id: string; nodes: TNode[] }[]
): ShapePathEditResult<TNode> {
	if (replacements.length === 0) return { ok: false, operation, reason: 'empty' };
	return {
		ok: true,
		operation,
		removeIds: replacements.map((r) => r.id),
		nodes: replacements.flatMap((r) => r.nodes),
		replacements
	};
}

/**
 * Offset Path on shape nodes: each selected shape grows (`distance > 0`) or shrinks
 * (`distance < 0`) by `distance` flow units, keeping curves. The result replaces the shape
 * (or sits below it with `keepOriginal`) as a `path` shape node with the same paint. Shapes
 * whose offset is empty are left unchanged; refuses when every result is empty, a selected
 * shape is locked or no shape is selected. Pure: apply with `applyShapeReplacement`.
 */
export function offsetShapeNodes<TNode extends CanvasNode>(
	nodes: TNode[],
	ids: Iterable<string>,
	distance: number,
	options: OffsetShapeNodesOptions = {}
): ShapePathEditResult<TNode> {
	const operation = 'offset';
	if (!Number.isFinite(distance)) return { ok: false, operation, reason: 'invalid' };
	const check = canOffsetShapeNodes(nodes, ids);
	if (!check.ok) return { ok: false, operation, reason: check.reason };
	const lookup = createNodeLookup(nodes);
	const createId = options.createId ?? defaultId;
	let index = 0;
	const replacements: { id: string; nodes: TNode[] }[] = [];
	for (const id of check.shapeIds) {
		const node = lookup.get(id) as TNode;
		const outline = shapeNodeToBezierPath(node, lookup, options)!;
		const path = offsetPath(outline.path, distance, {
			join: options.join,
			miterLimit: options.miterLimit,
			fillRule: outline.fillRule,
			tolerance: options.tolerance,
			epsilon: options.epsilon,
			onFallback: options.onFallback
		});
		const created = buildPathNode(path, node, createId(index), {
			...editPlacement(node, lookup),
			precision: options.precision,
			nodeType: options.nodeType,
			select: options.select
		});
		if (!created) continue;
		index++;
		const original = { ...node, selected: false } as TNode;
		replacements.push({ id, nodes: options.keepOriginal ? [created, original] : [created] });
	}
	return finishEdit(operation, replacements);
}

/**
 * Outline Stroke on shape nodes: each selected shape with a visible stroke gets its stroke
 * converted to a filled `path` shape node (filled with the stroke colour, no stroke), using
 * the stroke width in flow units (strokes do not scale with the node) and SVG's default
 * miter join, miter limit 4 and butt caps unless overridden. The shape's fill stays as the
 * original node without its stroke, below the outline (`keepFill`). Pure: apply with
 * `applyShapeReplacement`.
 */
export function outlineShapeNodeStrokes<TNode extends CanvasNode>(
	nodes: TNode[],
	ids: Iterable<string>,
	options: OutlineShapeStrokesOptions = {}
): ShapePathEditResult<TNode> {
	const operation = 'outlineStroke';
	if (options.width !== undefined && !(Number.isFinite(options.width) && options.width > 0)) {
		return { ok: false, operation, reason: 'invalid' };
	}
	const check = canOutlineShapeNodeStrokes(nodes, ids);
	if (!check.ok) return { ok: false, operation, reason: check.reason };
	const lookup = createNodeLookup(nodes);
	const createId = options.createId ?? defaultId;
	let index = 0;
	const replacements: { id: string; nodes: TNode[] }[] = [];
	for (const id of check.shapeIds) {
		const node = lookup.get(id) as TNode;
		const shape = getNodeShape(node)!;
		const outline = shapeNodeToBezierPath(node, lookup, options)!;
		const path = outlineStroke(outline.path, {
			width: options.width ?? shape.strokeWidth ?? 1,
			join: options.join,
			cap: options.cap,
			miterLimit: options.miterLimit,
			dash: options.dash,
			dashOffset: options.dashOffset,
			tolerance: options.tolerance,
			epsilon: options.epsilon,
			onFallback: options.onFallback
		});
		const created = buildPathNode(path, node, createId(index), {
			...editPlacement(node, lookup),
			precision: options.precision,
			nodeType: options.nodeType,
			select: options.select,
			paint: { fill: shape.stroke as string, stroke: null, strokeWidth: null }
		});
		if (!created) continue;
		index++;
		const replacement: TNode[] = [];
		if (options.keepFill !== false && hasVisibleFill(shape)) {
			const { stroke: _stroke, strokeWidth: _width, ...rest } = shape;
			replacement.push({
				...node,
				selected: options.select === false ? node.selected : false,
				data: { ...node.data, [SHAPE_DATA_KEY]: rest }
			} as TNode);
		}
		replacement.push(created);
		replacements.push({ id, nodes: replacement });
	}
	return finishEdit(operation, replacements);
}

/**
 * Applies a successful `offsetShapeNodes` / `outlineShapeNodeStrokes` result: each replaced
 * node is swapped in place for its replacement nodes, so the stacking order of everything
 * else is kept. With `deselect` (default `true`) other nodes are deselected when the
 * result is selected. Undo with `revertShapeCombination(nodes, result, previous)`.
 */
export function applyShapeReplacement<TNode extends CanvasNode>(
	nodes: TNode[],
	change: { replacements: { id: string; nodes: TNode[] }[] },
	options: { deselect?: boolean } = {}
): TNode[] {
	const byId = new Map(change.replacements.map((r) => [r.id, r.nodes]));
	const created = new Set(change.replacements.flatMap((r) => r.nodes.map((n) => n.id)));
	const deselect = options.deselect !== false && change.replacements.some((r) => r.nodes.some((n) => n.selected));
	const out: TNode[] = [];
	for (const node of nodes) {
		const replacement = byId.get(node.id);
		if (replacement) {
			out.push(...replacement);
			continue;
		}
		if (created.has(node.id)) continue;
		out.push(deselect && node.selected ? ({ ...node, selected: false } as TNode) : node);
	}
	return out;
}
