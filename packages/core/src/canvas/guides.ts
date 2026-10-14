import { boundsOf } from './layout.js';
import { createNodeLookup, getNodeRect, type CanvasNodeUpdate, type NodeRectOptions } from './arrange.js';
import type { CanvasNode, Rect, XYPosition } from './types.js';

/**
 * A guide line to render while dragging, in flow coordinates.
 * `edge` and `centre` guides are alignment lines; `spacing` guides mark equal gaps.
 * `measure` lines (with a distance `label`) and dashed `extension` lines come from the
 * distance measuring helpers (`measureBetween`, `measureSelection`).
 */
export interface GuideLine {
	orientation: 'vertical' | 'horizontal';
	kind: 'edge' | 'centre' | 'spacing' | 'measure' | 'extension';
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	/** Text drawn at the middle of the line (measuring distances). */
	label?: string;
}

/**
 * Snaps `value` to a grid with the given `spacing` and `origin`. A spacing of 0 or less
 * (or a non-finite one) leaves the value unchanged.
 *
 * Ported from vectorcraft-main/crates/geom/src/snap.rs (MIT OR Apache-2.0, © ArtCraft Team
 * and contributors). See THIRD_PARTY_NOTICES.md.
 */
export function snapToGrid(value: number, spacing: number, origin = 0): number {
	if (!(spacing > 0) || !Number.isFinite(spacing)) return value;
	return Math.round((value - origin) / spacing) * spacing + origin;
}

export interface SnapGuidesOptions {
	/** Current viewport zoom; the threshold is in screen pixels and divided by it (default 1). */
	zoom?: number;
	/** Snap distance in screen pixels (default 6). */
	threshold?: number;
	/** Snap edges to other shapes' edges (default `true`). */
	edges?: boolean;
	/** Snap centres to other shapes' centres (default `true`). */
	centres?: boolean;
	/** Snap to equal spacing between neighbouring shapes in the same row / column (default `true`). */
	spacing?: boolean;
	/**
	 * Grid spacing in flow units (default 0, off). An axis that does not snap to a shape snaps
	 * its top-left (drag) or moving edge (resize) to the grid; grid snaps draw no guides.
	 */
	gridSize?: number;
	/** Grid origin in flow units (default `{ x: 0, y: 0 }`). */
	gridOrigin?: XYPosition;
}

export interface SnapResult {
	/** Snapped top-left of the moving rectangle. */
	position: XYPosition;
	/** Offset applied to the input rectangle (`position - rect`). */
	offset: XYPosition;
	/** Guide segments to draw for the snap that was applied. */
	guides: GuideLine[];
	/** Whether x snapped to a shape (grid snaps do not count). */
	snappedX: boolean;
	snappedY: boolean;
}

interface AxisEntries {
	values: Float64Array;
	rects: Rect[];
}

function buildAxis(entries: { value: number; rect: Rect }[]): AxisEntries {
	entries.sort((a, b) => a.value - b.value);
	return {
		values: Float64Array.from(entries.map((e) => e.value)),
		rects: entries.map((e) => e.rect)
	};
}

/** First index whose value is >= `v`. */
function lowerBound(values: Float64Array, v: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] < v) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * Pre-sorted snap targets for a set of static rectangles. Build it once when a drag starts
 * and reuse it on every pointer move; each query is a binary search, so snapping stays
 * cheap with hundreds or thousands of shapes.
 */
export interface GuideIndex {
	rects: Rect[];
	edgeX: AxisEntries;
	centreX: AxisEntries;
	edgeY: AxisEntries;
	centreY: AxisEntries;
}

/** Builds a `GuideIndex` from the rectangles the moving shape may snap to. */
export function createGuideIndex(rects: Rect[]): GuideIndex {
	const edgeX: { value: number; rect: Rect }[] = [];
	const centreX: { value: number; rect: Rect }[] = [];
	const edgeY: { value: number; rect: Rect }[] = [];
	const centreY: { value: number; rect: Rect }[] = [];
	for (const rect of rects) {
		edgeX.push({ value: rect.x, rect }, { value: rect.x + rect.width, rect });
		centreX.push({ value: rect.x + rect.width / 2, rect });
		edgeY.push({ value: rect.y, rect }, { value: rect.y + rect.height, rect });
		centreY.push({ value: rect.y + rect.height / 2, rect });
	}
	return {
		rects,
		edgeX: buildAxis(edgeX),
		centreX: buildAxis(centreX),
		edgeY: buildAxis(edgeY),
		centreY: buildAxis(centreY)
	};
}

/** Nearest indexed value within `tolerance` of `v`, as a signed delta, or `null`. */
function nearest(axis: AxisEntries, v: number, tolerance: number): number | null {
	const { values } = axis;
	let best: number | null = null;
	for (let i = lowerBound(values, v - tolerance); i < values.length && values[i] <= v + tolerance; i++) {
		const delta = values[i] - v;
		if (best === null || Math.abs(delta) < Math.abs(best)) best = delta;
	}
	return best;
}

/** Rectangles whose indexed value equals `v` (within `eps`). */
function matches(axis: AxisEntries, v: number, eps: number): Rect[] {
	const { values, rects } = axis;
	const out: Rect[] = [];
	for (let i = lowerBound(values, v - eps); i < values.length && values[i] <= v + eps; i++) {
		out.push(rects[i]);
	}
	return out;
}

interface SpacingCandidate {
	delta: number;
	guides: GuideLine[];
}

/**
 * Equal-spacing candidates along one axis. Looks at shapes in the same row (horizontal) or
 * column (vertical) as the moving rectangle and proposes: centring between the nearest
 * neighbours, or repeating the gap a neighbour has to its own neighbour.
 */
function spacingCandidate(
	rects: Rect[],
	moving: Rect,
	horizontal: boolean,
	tolerance: number
): SpacingCandidate | null {
	const start = (r: Rect) => (horizontal ? r.x : r.y);
	const end = (r: Rect) => (horizontal ? r.x + r.width : r.y + r.height);
	const crossStart = (r: Rect) => (horizontal ? r.y : r.x);
	const crossEnd = (r: Rect) => (horizontal ? r.y + r.height : r.x + r.width);
	const size = end(moving) - start(moving);
	const inLane = (r: Rect, lane: Rect) => crossStart(r) < crossEnd(lane) && crossEnd(r) > crossStart(lane);

	const lane = rects.filter((r) => inLane(r, moving));
	if (lane.length === 0) return null;

	let before: Rect | null = null;
	let after: Rect | null = null;
	for (const r of lane) {
		if (end(r) <= start(moving) + tolerance && (!before || end(r) > end(before))) before = r;
		if (start(r) >= end(moving) - tolerance && (!after || start(r) < start(after))) after = r;
	}

	const neighbourOf = (r: Rect, forward: boolean): Rect | null => {
		let best: Rect | null = null;
		for (const other of lane) {
			if (other === r || !inLane(other, r)) continue;
			if (forward ? start(other) >= end(r) : end(other) <= start(r)) {
				if (!best || (forward ? start(other) < start(best) : end(other) > end(best))) best = other;
			}
		}
		return best;
	};

	const crossMid = (a: Rect, b: Rect) =>
		(Math.max(crossStart(a), crossStart(b)) + Math.min(crossEnd(a), crossEnd(b))) / 2;
	const segment = (from: number, to: number, cross: number): GuideLine =>
		horizontal
			? { orientation: 'horizontal', kind: 'spacing', x1: from, y1: cross, x2: to, y2: cross }
			: { orientation: 'vertical', kind: 'spacing', x1: cross, y1: from, x2: cross, y2: to };

	const candidates: { pos: number; guides: (pos: number) => GuideLine[] }[] = [];
	if (before && after) {
		const b = before;
		const a = after;
		const pos = (end(b) + start(a) - size) / 2;
		if (pos >= end(b)) {
			candidates.push({
				pos,
				guides: (p) => [
					segment(end(b), p, crossMid(b, moving)),
					segment(p + size, start(a), crossMid(a, moving))
				]
			});
		}
	}
	if (before) {
		const b = before;
		const prev = neighbourOf(b, false);
		if (prev) {
			const gap = start(b) - end(prev);
			candidates.push({
				pos: end(b) + gap,
				guides: (p) => [segment(end(prev), start(b), crossMid(prev, b)), segment(end(b), p, crossMid(b, moving))]
			});
		}
	}
	if (after) {
		const a = after;
		const next = neighbourOf(a, true);
		if (next) {
			const gap = start(next) - end(a);
			candidates.push({
				pos: start(a) - gap - size,
				guides: (p) => [segment(p + size, start(a), crossMid(a, moving)), segment(end(a), start(next), crossMid(a, next))]
			});
		}
	}

	let best: SpacingCandidate | null = null;
	for (const c of candidates) {
		const delta = c.pos - start(moving);
		if (Math.abs(delta) <= tolerance && (!best || Math.abs(delta) < Math.abs(best.delta))) {
			best = { delta, guides: c.guides(c.pos) };
		}
	}
	return best;
}

/**
 * Computes smart-guide snapping for a moving rectangle (a dragged node or a selection's
 * bounding box) against other shapes. Edges snap to edges and centres to centres within
 * `threshold` screen pixels (converted to flow units via `zoom`). Each axis snaps
 * independently to its nearest candidate. Returns the snapped position and the guides to draw.
 */
export function computeSnapGuides(
	moving: Rect,
	targets: Rect[] | GuideIndex,
	options: SnapGuidesOptions = {}
): SnapResult {
	const index = Array.isArray(targets) ? createGuideIndex(targets) : targets;
	const zoom = options.zoom && options.zoom > 0 ? options.zoom : 1;
	const tolerance = (options.threshold ?? 6) / zoom;
	const useEdges = options.edges !== false;
	const useCentres = options.centres !== false;
	const useSpacing = options.spacing !== false;
	const eps = 0.5 / zoom;

	const snapAxis = (horizontal: boolean) => {
		const start = horizontal ? moving.x : moving.y;
		const size = horizontal ? moving.width : moving.height;
		const edgeAxis = horizontal ? index.edgeX : index.edgeY;
		const centreAxis = horizontal ? index.centreX : index.centreY;
		let delta: number | null = null;
		const consider = (d: number | null) => {
			if (d !== null && (delta === null || Math.abs(d) < Math.abs(delta))) delta = d;
		};
		if (useEdges) {
			consider(nearest(edgeAxis, start, tolerance));
			consider(nearest(edgeAxis, start + size, tolerance));
		}
		if (useCentres) consider(nearest(centreAxis, start + size / 2, tolerance));
		const spacing = useSpacing ? spacingCandidate(index.rects, moving, horizontal, tolerance) : null;
		if (spacing && (delta === null || Math.abs(spacing.delta) < Math.abs(delta) - eps)) {
			return { delta: spacing.delta, spacing };
		}
		return { delta: delta as number | null, spacing: null };
	};

	const sx = snapAxis(true);
	const sy = snapAxis(false);
	const grid = options.gridSize ?? 0;
	const gridDelta = (v: number, origin: number) => snapToGrid(v, grid, origin) - v;
	const dx = sx.delta ?? (grid > 0 ? gridDelta(moving.x, options.gridOrigin?.x ?? 0) : 0);
	const dy = sy.delta ?? (grid > 0 ? gridDelta(moving.y, options.gridOrigin?.y ?? 0) : 0);
	const snapped: Rect = { x: moving.x + dx, y: moving.y + dy, width: moving.width, height: moving.height };
	const guides: GuideLine[] = [];

	const alignmentGuides = (horizontal: boolean) => {
		const start = horizontal ? snapped.x : snapped.y;
		const size = horizontal ? snapped.width : snapped.height;
		const lines: { value: number; kind: 'edge' | 'centre'; axis: AxisEntries }[] = [];
		if (useEdges) {
			const axis = horizontal ? index.edgeX : index.edgeY;
			lines.push({ value: start, kind: 'edge', axis }, { value: start + size, kind: 'edge', axis });
		}
		if (useCentres) {
			lines.push({ value: start + size / 2, kind: 'centre', axis: horizontal ? index.centreX : index.centreY });
		}
		for (const line of lines) {
			const aligned = matches(line.axis, line.value, eps);
			if (aligned.length === 0) continue;
			const span = boundsOf([snapped, ...aligned])!;
			guides.push(
				horizontal
					? { orientation: 'vertical', kind: line.kind, x1: line.value, y1: span.y, x2: line.value, y2: span.y + span.height }
					: { orientation: 'horizontal', kind: line.kind, x1: span.x, y1: line.value, x2: span.x + span.width, y2: line.value }
			);
		}
	};

	if (sx.delta !== null) {
		if (sx.spacing) guides.push(...shiftGuides(sx.spacing.guides, 0, dy));
		else alignmentGuides(true);
	}
	if (sy.delta !== null) {
		if (sy.spacing) guides.push(...shiftGuides(sy.spacing.guides, dx, 0));
		else alignmentGuides(false);
	}

	return {
		position: { x: snapped.x, y: snapped.y },
		offset: { x: dx, y: dy },
		guides,
		snappedX: sx.delta !== null,
		snappedY: sy.delta !== null
	};
}

/** Spacing guides are computed before the other axis snaps; shift their cross coordinate to match. */
function shiftGuides(guides: GuideLine[], dx: number, dy: number): GuideLine[] {
	return guides.map((g) =>
		g.orientation === 'horizontal'
			? { ...g, y1: g.y1 + dy, y2: g.y2 + dy }
			: { ...g, x1: g.x1 + dx, x2: g.x2 + dx }
	);
}

/** Ids of the given nodes plus every descendant (children move with their parent). */
export function collectDescendantIds(nodes: CanvasNode[], ids: Iterable<string>): Set<string> {
	const result = new Set(ids);
	let grew = true;
	while (grew) {
		grew = false;
		for (const node of nodes) {
			if (node.parentId && result.has(node.parentId) && !result.has(node.id)) {
				result.add(node.id);
				grew = true;
			}
		}
	}
	return result;
}

/**
 * Builds a `GuideIndex` of every node except the dragged ones and their descendants.
 * Call once at drag start and pass it to `snapNodeDrag` on every move.
 */
export function createNodeGuideIndex(
	nodes: CanvasNode[],
	draggingIds: Iterable<string>,
	options: NodeRectOptions & { filter?: (node: CanvasNode) => boolean } = {}
): GuideIndex {
	const exclude = collectDescendantIds(nodes, draggingIds);
	const lookup = createNodeLookup(nodes);
	const rects: Rect[] = [];
	for (const node of nodes) {
		if (exclude.has(node.id) || node.hidden === true) continue;
		if (options.filter && !options.filter(node)) continue;
		rects.push(getNodeRect(node, lookup, options));
	}
	return createGuideIndex(rects);
}

export interface SnapNodeDragOptions extends SnapGuidesOptions, NodeRectOptions {
	/** Index from `createNodeGuideIndex`, reused across drag frames. Built on demand when omitted. */
	index?: GuideIndex;
}

export interface SnapNodeDragResult extends SnapResult {
	/** Position updates moving every dragged node by `offset` (node-relative coordinates). */
	updates: CanvasNodeUpdate[];
}

/**
 * Snaps a drag of one or more nodes. The dragged nodes' bounding box is snapped against all
 * other nodes; the resulting offset is applied to each dragged node. Dragged nodes whose
 * parent is also dragged are skipped, because they move with the parent.
 */
export function snapNodeDrag(
	nodes: CanvasNode[],
	draggingIds: Iterable<string>,
	options: SnapNodeDragOptions = {}
): SnapNodeDragResult {
	const ids = new Set(draggingIds);
	const lookup = createNodeLookup(nodes);
	const dragged = [...ids].map((id) => lookup.get(id)).filter((n): n is CanvasNode => !!n);
	const empty: SnapNodeDragResult = {
		position: { x: 0, y: 0 },
		offset: { x: 0, y: 0 },
		guides: [],
		snappedX: false,
		snappedY: false,
		updates: []
	};
	if (dragged.length === 0) return empty;

	const bounds = boundsOf(dragged.map((n) => getNodeRect(n, lookup, options)))!;
	const index = options.index ?? createNodeGuideIndex(nodes, ids, options);
	const result = computeSnapGuides(bounds, index, options);
	const { x: dx, y: dy } = result.offset;
	const updates: CanvasNodeUpdate[] = [];
	if (dx !== 0 || dy !== 0) {
		for (const node of dragged) {
			if (node.parentId && ids.has(node.parentId)) continue;
			updates.push({ id: node.id, position: { x: node.position.x + dx, y: node.position.y + dy } });
		}
	}
	return { ...result, updates };
}
