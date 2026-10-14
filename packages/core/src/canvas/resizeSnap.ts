/**
 * Resize snapping: the moving edges of a box being resized land on other shapes' edges and
 * centres (or on a grid) while the opposite edge / corner stays put.
 *
 * Portions ported from vectorcraft-main/crates/tools/src/guides.rs (`snap_scale`) and
 * vectorcraft-main/crates/geom/src/snap.rs (MIT OR Apache-2.0, © ArtCraft Team and
 * contributors). See THIRD_PARTY_NOTICES.md.
 */
import { boundsOf } from './layout.js';
import {
	createNodeLookup,
	getAbsolutePosition,
	getNodeSize,
	isLocked,
	type CanvasNodeUpdate,
	type NodeRectOptions
} from './arrange.js';
import {
	createGuideIndex,
	createNodeGuideIndex,
	snapToGrid,
	type GuideIndex,
	type GuideLine,
	type SnapGuidesOptions
} from './guides.js';
import type { CanvasNode, Rect } from './types.js';

/** A resize handle, named like xyflow's `ControlPosition`. */
export type ResizeHandle =
	| 'top-left'
	| 'top'
	| 'top-right'
	| 'right'
	| 'bottom-right'
	| 'bottom'
	| 'bottom-left'
	| 'left';

export const RESIZE_HANDLES: readonly ResizeHandle[] = [
	'top-left',
	'top',
	'top-right',
	'right',
	'bottom-right',
	'bottom',
	'bottom-left',
	'left'
];

/** Which edge of each axis a handle moves: -1 the start (left / top), 1 the end, 0 none. */
export function resizeHandleAxes(handle: ResizeHandle): { x: -1 | 0 | 1; y: -1 | 0 | 1 } {
	const x = handle.includes('left') ? -1 : handle.includes('right') ? 1 : 0;
	const y = handle.includes('top') ? -1 : handle.includes('bottom') ? 1 : 0;
	return { x, y };
}

/**
 * The handle a resize from `start` to `next` was made with, from the edges that moved, or
 * `null` when no edge moved.
 */
export function inferResizeHandle(start: Rect, next: Rect, eps = 1e-6): ResizeHandle | null {
	const moved = (a: number, b: number) => Math.abs(a - b) > eps;
	const left = moved(start.x, next.x);
	const right = moved(start.x + start.width, next.x + next.width);
	const top = moved(start.y, next.y);
	const bottom = moved(start.y + start.height, next.y + next.height);
	const h = left ? 'left' : right ? 'right' : '';
	const v = top ? 'top' : bottom ? 'bottom' : '';
	if (h && v) return `${v}-${h}` as ResizeHandle;
	return (h || v || null) as ResizeHandle | null;
}

export interface SnapResizeOptions extends Omit<SnapGuidesOptions, 'spacing'> {
	/**
	 * Keep the input box's aspect ratio. A corner snaps whichever axis is closer to a target
	 * and the other follows; a side scales the other axis about its centre.
	 */
	keepAspectRatio?: boolean;
	/** Smallest width a snap may leave (default: anything above 0). */
	minWidth?: number;
	/** Smallest height a snap may leave (default: anything above 0). */
	minHeight?: number;
}

export interface SnapResizeResult {
	/** The snapped box. */
	rect: Rect;
	/** Guide segments for the shape snaps that were applied (grid snaps draw none). */
	guides: GuideLine[];
	/** Whether the moving x edge snapped to a shape. */
	snappedX: boolean;
	/** Whether the moving y edge snapped to a shape. */
	snappedY: boolean;
	/** Whether `rect` differs from the input. */
	changed: boolean;
}

interface Hit {
	value: number;
	kind: 'edge' | 'centre' | 'grid';
}

type Axis = GuideIndex['edgeX'];

function within(axis: Axis, v: number, tolerance: number): number[] {
	const { values } = axis;
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] < v - tolerance) lo = mid + 1;
		else hi = mid;
	}
	const out: number[] = [];
	for (let i = lo; i < values.length && values[i] <= v + tolerance; i++) out.push(values[i]);
	return out;
}

function matching(axis: Axis, v: number, eps: number): Rect[] {
	const { values, rects } = axis;
	const out: Rect[] = [];
	for (let i = 0; i < values.length; i++) if (Math.abs(values[i] - v) <= eps) out.push(rects[i]);
	return out;
}

/**
 * Snaps a resize of the axis-aligned box `rect` made with `handle` against `targets`. The
 * opposite edge (side handles) or corner (corner handles) stays fixed:
 *
 * - A **side** handle snaps its one moving edge to the nearest target edge or centre within
 *   `threshold` screen pixels.
 * - A **corner** handle snaps x and y independently (unless `keepAspectRatio`).
 * - A snap that would collapse or flip the box (or go below `minWidth` / `minHeight`) is
 *   rejected; the next nearest target is tried, else the edge stays where it was dragged.
 * - With `gridSize`, an axis without a shape snap snaps its moving edge to the grid.
 *
 * Returns the snapped box and the guides to draw (same shape as drag snapping).
 */
export function snapResize(
	rect: Rect,
	handle: ResizeHandle,
	targets: Rect[] | GuideIndex,
	options: SnapResizeOptions = {}
): SnapResizeResult {
	const index = Array.isArray(targets) ? createGuideIndex(targets) : targets;
	const zoom = options.zoom && options.zoom > 0 ? options.zoom : 1;
	const tolerance = (options.threshold ?? 6) / zoom;
	const eps = 0.5 / zoom;
	const useEdges = options.edges !== false;
	const useCentres = options.centres !== false;
	const grid = options.gridSize ?? 0;
	const axes = resizeHandleAxes(handle);
	const unchanged: SnapResizeResult = { rect: { ...rect }, guides: [], snappedX: false, snappedY: false, changed: false };
	if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return unchanged;

	const x0 = rect.x;
	const x1 = rect.x + rect.width;
	const y0 = rect.y;
	const y1 = rect.y + rect.height;

	/** Best valid target for one moving edge, or `null`. */
	const bestHit = (horizontal: boolean): Hit | null => {
		const dir = horizontal ? axes.x : axes.y;
		if (dir === 0) return null;
		const moving = horizontal ? (dir < 0 ? x0 : x1) : dir < 0 ? y0 : y1;
		const fixed = horizontal ? (dir < 0 ? x1 : x0) : dir < 0 ? y1 : y0;
		const min = (horizontal ? options.minWidth : options.minHeight) ?? 0;
		const valid = (t: number) => {
			const size = dir < 0 ? fixed - t : t - fixed;
			return Number.isFinite(size) && size > 1e-9 && size >= min;
		};
		let best: Hit | null = null;
		const consider = (values: number[], kind: Hit['kind']) => {
			for (const t of values) {
				if (!valid(t)) continue;
				if (!best || Math.abs(t - moving) < Math.abs(best.value - moving)) best = { value: t, kind };
			}
		};
		if (useEdges) consider(within(horizontal ? index.edgeX : index.edgeY, moving, tolerance), 'edge');
		if (useCentres) consider(within(horizontal ? index.centreX : index.centreY, moving, tolerance), 'centre');
		if (!best && grid > 0) {
			const origin = horizontal ? options.gridOrigin?.x ?? 0 : options.gridOrigin?.y ?? 0;
			consider([snapToGrid(moving, grid, origin)], 'grid');
		}
		return best;
	};

	let nx0 = x0;
	let nx1 = x1;
	let ny0 = y0;
	let ny1 = y1;
	const setEdge = (horizontal: boolean, value: number) => {
		const dir = horizontal ? axes.x : axes.y;
		if (horizontal) {
			if (dir < 0) nx0 = value;
			else nx1 = value;
		} else if (dir < 0) ny0 = value;
		else ny1 = value;
	};

	let hitX = bestHit(true);
	let hitY = bestHit(false);
	const ratio = rect.height > 0 ? rect.width / rect.height : 0;

	if (options.keepAspectRatio && ratio > 0 && (hitX || hitY)) {
		if (axes.x !== 0 && axes.y !== 0) {
			// Corner: the closer snap wins; the other axis follows from the fixed corner.
			const dist = (h: Hit | null, horizontal: boolean) =>
				h ? Math.abs(h.value - (horizontal ? (axes.x < 0 ? x0 : x1) : axes.y < 0 ? y0 : y1)) : Infinity;
			const useX = dist(hitX, true) <= dist(hitY, false);
			if (useX && hitX) {
				setEdge(true, hitX.value);
				const height = (nx1 - nx0) / ratio;
				if (axes.y < 0) ny0 = ny1 - height;
				else ny1 = ny0 + height;
				hitY = null;
			} else if (hitY) {
				setEdge(false, hitY.value);
				const width = (ny1 - ny0) * ratio;
				if (axes.x < 0) nx0 = nx1 - width;
				else nx1 = nx0 + width;
				hitX = null;
			}
			const min = (v: number | undefined) => v ?? 0;
			if (nx1 - nx0 < min(options.minWidth) || ny1 - ny0 < min(options.minHeight) || !(nx1 > nx0 && ny1 > ny0)) {
				return unchanged;
			}
		} else if (axes.x !== 0 && hitX) {
			setEdge(true, hitX.value);
			const height = (nx1 - nx0) / ratio;
			const cy = (y0 + y1) / 2;
			ny0 = cy - height / 2;
			ny1 = cy + height / 2;
		} else if (axes.y !== 0 && hitY) {
			setEdge(false, hitY.value);
			const width = (ny1 - ny0) * ratio;
			const cx = (x0 + x1) / 2;
			nx0 = cx - width / 2;
			nx1 = cx + width / 2;
		}
	} else {
		if (hitX) setEdge(true, hitX.value);
		if (hitY) setEdge(false, hitY.value);
	}

	const out: Rect = { x: nx0, y: ny0, width: nx1 - nx0, height: ny1 - ny0 };
	const guides: GuideLine[] = [];
	const guideFor = (horizontal: boolean, hit: Hit | null) => {
		if (!hit || hit.kind === 'grid') return;
		const axis =
			hit.kind === 'edge' ? (horizontal ? index.edgeX : index.edgeY) : horizontal ? index.centreX : index.centreY;
		const aligned = matching(axis, hit.value, eps);
		const span = boundsOf([out, ...aligned])!;
		guides.push(
			horizontal
				? { orientation: 'vertical', kind: hit.kind, x1: hit.value, y1: span.y, x2: hit.value, y2: span.y + span.height }
				: { orientation: 'horizontal', kind: hit.kind, x1: span.x, y1: hit.value, x2: span.x + span.width, y2: hit.value }
		);
	};
	guideFor(true, hitX);
	guideFor(false, hitY);
	const changed = out.x !== rect.x || out.y !== rect.y || out.width !== rect.width || out.height !== rect.height;
	return {
		rect: out,
		guides,
		snappedX: !!hitX && hitX.kind !== 'grid',
		snappedY: !!hitY && hitY.kind !== 'grid',
		changed
	};
}

export interface SnapNodeResizeOptions extends SnapResizeOptions, NodeRectOptions {
	/** Index from `createNodeGuideIndex(nodes, [id])`, reused across resize frames. */
	index?: GuideIndex;
}

export interface SnapNodeResizeResult extends SnapResizeResult {
	/** Position / size update for the node (parent-relative position), or none. */
	updates: CanvasNodeUpdate[];
}

/**
 * Snaps a node that is being resized. `rect` is the node's proposed absolute box (e.g. from
 * a resize event) and `handle` the handle being dragged. Locked nodes are never snapped.
 * The node itself and its descendants are not snap targets.
 */
export function snapNodeResize(
	nodes: CanvasNode[],
	id: string,
	rect: Rect,
	handle: ResizeHandle,
	options: SnapNodeResizeOptions = {}
): SnapNodeResizeResult {
	const lookup = createNodeLookup(nodes);
	const node = lookup.get(id);
	if (!node || isLocked(node)) {
		return { rect: { ...rect }, guides: [], snappedX: false, snappedY: false, changed: false, updates: [] };
	}
	const index = options.index ?? createNodeGuideIndex(nodes, [id], options);
	const result = snapResize(rect, handle, index, options);
	if (!result.changed) return { ...result, updates: [] };
	const parent = node.parentId ? lookup.get(node.parentId) : undefined;
	const origin = parent ? getAbsolutePosition(parent, lookup) : { x: 0, y: 0 };
	return {
		...result,
		updates: [
			{
				id,
				position: { x: result.rect.x - origin.x, y: result.rect.y - origin.y },
				width: result.rect.width,
				height: result.rect.height
			}
		]
	};
}

/**
 * Absolute box of a node while it is being resized: flow libraries write the new size to
 * `width` / `height` before the DOM is re-measured, so those win over `measured` here.
 */
export function getResizingNodeRect(
	node: CanvasNode,
	lookup: ReadonlyMap<string, CanvasNode>,
	options: NodeRectOptions = {}
): Rect {
	const { x, y } = node.parentId ? getAbsolutePosition(node, lookup) : node.position;
	const size = getNodeSize(node, options);
	return { x, y, width: node.width ?? size.width, height: node.height ?? size.height };
}
