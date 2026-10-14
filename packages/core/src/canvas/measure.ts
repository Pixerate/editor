/**
 * Distance measuring between bounding boxes (Alt-hover red lines with value labels).
 *
 * Portions ported from figcraft-main/crates/engine/src/distance.rs (MIT OR Apache-2.0,
 * © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
 */
import { boundsOf } from './layout.js';
import { createNodeLookup, getNodeRect, type NodeRectOptions } from './arrange.js';
import type { GuideLine } from './guides.js';
import type { CanvasNode, Rect } from './types.js';

/** Lines shorter than this (flow units) are not drawn. */
const EPS = 1e-6;

/**
 * A measuring line in flow coordinates. `measure` lines carry a `label` (the distance);
 * `extension` lines are dashed, unlabelled lines that carry a gap over to the measured box
 * when the gap line passes beside it.
 */
export interface MeasureGuide extends GuideLine {
	kind: 'measure' | 'extension';
	/** The distance as shown on the label (`measure` lines only). */
	label?: string;
}

/** A distance as shown on a label: absolute value, up to two decimals, no trailing zeros. */
export function measureLabel(distance: number): string {
	const v = Math.round(Math.abs(distance) * 100) / 100;
	return Object.is(v, -0) ? '0' : String(v);
}

interface Box {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

const toBox = (r: Rect): Box => ({ x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height });
const finiteBox = (b: Box) => [b.x0, b.y0, b.x1, b.y1].every(Number.isFinite);

function line(kind: 'measure' | 'extension', x1: number, y1: number, x2: number, y2: number): MeasureGuide {
	return { orientation: x1 === x2 ? 'vertical' : 'horizontal', kind, x1, y1, x2, y2 };
}

/** A labelled distance line, unless it has no length. */
function measured(out: MeasureGuide[], x1: number, y1: number, x2: number, y2: number) {
	const d = Math.hypot(x2 - x1, y2 - y1);
	if (d > EPS && Number.isFinite(d)) out.push({ ...line('measure', x1, y1, x2, y2), label: measureLabel(d) });
}

/** A dashed extension line (no label), unless it has no length. */
function extension(out: MeasureGuide[], x1: number, y1: number, x2: number, y2: number) {
	if (Math.hypot(x2 - x1, y2 - y1) > EPS) out.push(line('extension', x1, y1, x2, y2));
}

function contains(outer: Box, inner: Box): boolean {
	return outer.x0 <= inner.x0 + EPS && outer.y0 <= inner.y0 + EPS && outer.x1 >= inner.x1 - EPS && outer.y1 >= inner.y1 - EPS;
}

/** The middle of the overlap of two spans, or `null` when they do not overlap. */
function overlapMid(a0: number, a1: number, b0: number, b1: number): number | null {
	const lo = Math.max(a0, b0);
	const hi = Math.min(a1, b1);
	return lo <= hi ? (lo + hi) / 2 : null;
}

/** From `inner` to each edge of `outer`, along `inner`'s centre lines. */
function inside(out: MeasureGuide[], inner: Box, outer: Box) {
	const cx = (inner.x0 + inner.x1) / 2;
	const cy = (inner.y0 + inner.y1) / 2;
	measured(out, outer.x0, cy, inner.x0, cy);
	measured(out, inner.x1, cy, outer.x1, cy);
	measured(out, cx, outer.y0, cx, inner.y0);
	measured(out, cx, inner.y1, cx, outer.y1);
}

/**
 * Distance lines from box `a` (the selection) to box `b` (the hovered shape):
 *
 * - **One inside the other**: from the inner box to each edge of the outer one, along the
 *   inner box's centre lines (the same lines either way round).
 * - **Overlapping**: between the matching edges (left to left, right to right, ...).
 * - **Apart**: the horizontal and/or vertical gap, across the shared rows / columns, or from
 *   the middle of `a` with a dashed `extension` line to `b` when the gap line passes beside it.
 *   Touching boxes have no gap to draw.
 */
export function measureBetween(a: Rect, b: Rect): MeasureGuide[] {
	const out: MeasureGuide[] = [];
	const A = toBox(a);
	const B = toBox(b);
	if (!finiteBox(A) || !finiteBox(B)) return out;
	if (contains(B, A)) {
		inside(out, A, B);
		return out;
	}
	if (contains(A, B)) {
		inside(out, B, A);
		return out;
	}
	const ox = overlapMid(A.x0, A.x1, B.x0, B.x1);
	const oy = overlapMid(A.y0, A.y1, B.y0, B.y1);
	const overlapping = A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 && B.y0 < A.y1;
	if (overlapping && ox !== null && oy !== null) {
		measured(out, A.x0, oy, B.x0, oy);
		measured(out, A.x1, oy, B.x1, oy);
		measured(out, ox, A.y0, ox, B.y0);
		measured(out, ox, A.y1, ox, B.y1);
		return out;
	}
	const cx = (A.x0 + A.x1) / 2;
	const cy = (A.y0 + A.y1) / 2;
	const gapX = B.x0 >= A.x1 ? [A.x1, B.x0] : B.x1 <= A.x0 ? [A.x0, B.x1] : null;
	if (gapX) {
		const [from, to] = gapX;
		const y = oy ?? cy;
		measured(out, from, y, to, y);
		if (oy === null) extension(out, to, y, to, y < B.y0 ? B.y0 : B.y1);
	}
	const gapY = B.y0 >= A.y1 ? [A.y1, B.y0] : B.y1 <= A.y0 ? [A.y0, B.y1] : null;
	if (gapY) {
		const [from, to] = gapY;
		const x = ox ?? cx;
		measured(out, x, from, x, to);
		if (ox === null) extension(out, x, to, x < B.x0 ? B.x0 : B.x1, to);
	}
	return out;
}

/**
 * Distance lines from box `a` to an infinite guide line (`vertical` at x = `at`, otherwise
 * horizontal at y = `at`): to the nearer side, or to both sides when the line crosses the box.
 */
export function measureToLine(a: Rect, orientation: 'vertical' | 'horizontal', at: number): MeasureGuide[] {
	const out: MeasureGuide[] = [];
	const A = toBox(a);
	if (!finiteBox(A) || !Number.isFinite(at)) return out;
	const vertical = orientation === 'vertical';
	const cx = (A.x0 + A.x1) / 2;
	const cy = (A.y0 + A.y1) / 2;
	const [lo, hi] = vertical ? [A.x0, A.x1] : [A.y0, A.y1];
	const seg = (from: number, to: number) =>
		vertical ? measured(out, from, cy, to, cy) : measured(out, cx, from, cx, to);
	if (at >= hi) seg(hi, at);
	else if (at <= lo) seg(at, lo);
	else {
		seg(lo, at);
		seg(at, hi);
	}
	return out;
}

export interface MeasureSelectionResult {
	/** Measuring lines in flow coordinates. */
	guides: MeasureGuide[];
	/** The box measured to (to outline), or `null` when nothing is measured. */
	target: Rect | null;
	/** The selection's bounding box, or `null` without a selection. */
	selection: Rect | null;
}

export interface MeasureSelectionOptions extends NodeRectOptions {}

/**
 * Alt-hover measuring on canvas nodes: from the bounding box of `selectedIds` (absolute,
 * union of several nodes) to the hovered node. Hovering the selection itself, or nothing
 * (`hoveredId` null), measures to the selection's parent (`parentId`) when it has one;
 * a top-level selection then measures nothing. Hidden nodes are ignored.
 */
export function measureSelection(
	nodes: CanvasNode[],
	selectedIds: Iterable<string>,
	hoveredId: string | null | undefined,
	options: MeasureSelectionOptions = {}
): MeasureSelectionResult {
	const none = (selection: Rect | null = null): MeasureSelectionResult => ({ guides: [], target: null, selection });
	const lookup = createNodeLookup(nodes);
	const selected = [...new Set(selectedIds)]
		.map((id) => lookup.get(id))
		.filter((n): n is CanvasNode => !!n && n.hidden !== true);
	if (selected.length === 0) return none();
	const selection = boundsOf(selected.map((n) => getNodeRect(n, lookup, options)));
	if (!selection) return none();
	const selectedSet = new Set(selected.map((n) => n.id));

	let targetId = hoveredId ?? null;
	if (targetId === null || selectedSet.has(targetId)) {
		const parentId = selected[0].parentId;
		const sameParent = selected.every((n) => n.parentId === parentId);
		targetId = parentId && sameParent && !selectedSet.has(parentId) ? parentId : null;
	}
	const target = targetId !== null ? lookup.get(targetId) : undefined;
	if (!target || target.hidden === true) return none(selection);
	const rect = getNodeRect(target, lookup, options);
	return { guides: measureBetween(selection, rect), target: rect, selection };
}

/**
 * Whether the measuring modifier (Alt / Option) is held after a keyboard or pointer event.
 * `keyup` of Alt releases it; `keydown` of Alt or any event with `altKey` holds it.
 */
export function isMeasureModifierHeld(
	event: { type?: string; key?: string; altKey?: boolean } | null | undefined
): boolean {
	if (!event) return false;
	if (event.type === 'keyup' && event.key === 'Alt') return false;
	return event.altKey === true || (event.type === 'keydown' && event.key === 'Alt');
}
