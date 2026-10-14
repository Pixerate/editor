// Portions ported from figcraft/crates/layout/src/lib.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { createNodeLookup, getAbsolutePosition, getNodeSize, type CanvasNodeUpdate, type NodeRectOptions } from './arrange.js';
import type { GuideLine } from './guides.js';
import type { CanvasNode, XYPosition } from './types.js';

/**
 * Figma-style auto layout for xyflow sub-flows.
 *
 * A *frame* is any node with `data.layout` (an {@link AutoLayout}); its children are the nodes
 * whose `parentId` is the frame, in node-array order. Children may carry `data.childLayout`
 * (an {@link AutoLayoutChild}) for their own sizing, min / max, absolute positioning,
 * constraints and grid cell. The functions here are pure: they return `CanvasNodeUpdate`s
 * (positions relative to the parent, sizes) for `applyNodeUpdates`.
 */

/** Data key holding a frame's {@link AutoLayout}. */
export const AUTO_LAYOUT_DATA_KEY = 'layout';
/** Data key holding a child's {@link AutoLayoutChild}. */
export const CHILD_LAYOUT_DATA_KEY = 'childLayout';

export type AutoLayoutMode = 'horizontal' | 'vertical' | 'grid';
/** `fixed` keeps the size, `hug` fits the content (frames and text), `fill` shares the parent's free space. */
export type AutoLayoutSizing = 'fixed' | 'hug' | 'fill';
export type AutoLayoutAlignMain = 'start' | 'center' | 'end' | 'space-between' | 'space-around' | 'space-evenly';
export type AutoLayoutAlignCross = 'start' | 'center' | 'end' | 'stretch' | 'baseline';
/** How wrapped lines share the free cross space: packed by `alignCross` (`auto`) or spread (`space-between`). */
export type AutoLayoutAlignContent = 'auto' | 'space-between';
/** `number` (all sides), `[vertical, horizontal]`, `[top, right, bottom, left]` or per side. */
export type AutoLayoutPadding =
	| number
	| [number, number]
	| [number, number, number, number]
	| { top?: number; right?: number; bottom?: number; left?: number };

export interface AutoLayoutSize {
	width?: number;
	height?: number;
}

export interface AutoLayoutSizingPair {
	width?: AutoLayoutSizing;
	height?: AutoLayoutSizing;
}

/** A grid track: pixels, `'hug'` (fits its content), `'2fr'` or `{ fr: 2 }` (shares the rest like CSS `fr`). */
export type AutoLayoutGridTrack = number | 'hug' | `${number}fr` | { fr: number };

export interface AutoLayoutGrid {
	/** Column count (all `1fr`) or the column tracks (default 2 columns). */
	columns?: number | AutoLayoutGridTrack[];
	/** Minimum row count or the row tracks (default 1); rows are added to fit the children. Missing tracks are `1fr`. */
	rows?: number | AutoLayoutGridTrack[];
}

/** A frame's auto layout (`node.data.layout`). */
export interface AutoLayout {
	mode: AutoLayoutMode;
	/** Main-axis gap (grid: column gap). Negative gaps overlap. Default 0. */
	gap?: number;
	/** Gap between wrapped lines (grid: row gap). Default: `gap`. */
	rowGap?: number;
	/** Default 0. */
	padding?: AutoLayoutPadding;
	/** Horizontal / vertical: wrap into lines when the main axis runs out (ignored while hugging it). */
	wrap?: boolean;
	/** Default `start`. Grid: the cell alignment along x (`start`, `center`, `end`). */
	alignMain?: AutoLayoutAlignMain;
	/** Default `start`. `baseline` applies to horizontal layouts. Grid: the cell alignment along y. */
	alignCross?: AutoLayoutAlignCross;
	alignContent?: AutoLayoutAlignContent;
	/** The frame's own sizing (`childLayout.sizing` wins when both are set). Default `fixed`. */
	sizing?: AutoLayoutSizingPair;
	/** The frame's own limits (`childLayout.min` / `max` win when set). */
	min?: AutoLayoutSize;
	max?: AutoLayoutSize;
	grid?: AutoLayoutGrid;
}

export type AutoLayoutHorizontalConstraint = 'left' | 'right' | 'leftRight' | 'center' | 'scale';
export type AutoLayoutVerticalConstraint = 'top' | 'bottom' | 'topBottom' | 'center' | 'scale';

export interface AutoLayoutConstraints {
	horizontal?: AutoLayoutHorizontalConstraint;
	vertical?: AutoLayoutVerticalConstraint;
}

export type AutoLayoutCellAlign = 'start' | 'center' | 'end';

/** A grid child's cell. Column / row are 0-based anchors; unanchored children flow in reading order. */
export interface AutoLayoutGridArea {
	column?: number;
	row?: number;
	columnSpan?: number;
	rowSpan?: number;
	/** The child's own alignment in its cell (wins over the frame's). */
	alignX?: AutoLayoutCellAlign;
	alignY?: AutoLayoutCellAlign;
}

/** A child's layout properties (`node.data.childLayout`). */
export interface AutoLayoutChild {
	sizing?: AutoLayoutSizingPair;
	min?: AutoLayoutSize;
	max?: AutoLayoutSize;
	/** Ignore auto layout: keep its place and follow `constraints` when the frame resizes. */
	absolute?: boolean;
	/** How the child follows its parent's resizes (default left / top). */
	constraints?: AutoLayoutConstraints;
	gridArea?: AutoLayoutGridArea;
}

/**
 * Measuring hooks. `size` defaults to `getNodeSize` (xyflow `measured` size, then `width` /
 * `height`, then style). Nodes for which `textSize` returns a size are *text-like*: they can
 * hug, and wrap (`textHeight`) when their width is set by the layout.
 */
export interface AutoLayoutMeasure {
	size?: (node: CanvasNode) => { width: number; height: number } | undefined;
	/** Natural (unwrapped) size of a text-like node. */
	textSize?: (node: CanvasNode) => { width: number; height: number } | undefined;
	/** Height of a text-like node wrapped at `width`. */
	textHeight?: (node: CanvasNode, width: number) => number | undefined;
	/** Distance from the node's top to its first text baseline (for `alignCross: 'baseline'`). */
	textBaseline?: (node: CanvasNode) => number | undefined;
}

export interface AutoLayoutOptions {
	measure?: AutoLayoutMeasure;
	/** Size resolution for unmeasured nodes when `measure.size` is not given. */
	rectOptions?: NodeRectOptions;
}

type Axis = 'width' | 'height';

const MODES = new Set(['horizontal', 'vertical', 'grid']);
const EPS = 1e-6;
const MAX_TRACKS = 1000;
const MAX_GRID_CELLS = 1_000_000;

/** Clamps a size to `[min, max]`; non-finite or negative sizes become 0 and min wins over a smaller max. */
export function clampLayoutSize(value: number, min?: number, max?: number): number {
	let v = Number.isFinite(value) ? Math.max(value, 0) : 0;
	if (typeof max === 'number' && Number.isFinite(max)) v = Math.min(v, max);
	if (typeof min === 'number' && Number.isFinite(min)) v = Math.max(v, min);
	return v;
}

const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The node's auto layout, or `undefined` when it is not an auto layout frame. */
export function getAutoLayout(node: CanvasNode | undefined | null): AutoLayout | undefined {
	const layout = node?.data?.[AUTO_LAYOUT_DATA_KEY];
	return layout && typeof layout === 'object' && MODES.has(layout.mode) ? (layout as AutoLayout) : undefined;
}

/** Whether the node is an auto layout frame. */
export function isAutoLayoutFrame(node: CanvasNode | undefined | null): boolean {
	return getAutoLayout(node) !== undefined;
}

/** The node's child layout properties (empty when unset). */
export function getChildLayout(node: CanvasNode | undefined | null): AutoLayoutChild {
	const child = node?.data?.[CHILD_LAYOUT_DATA_KEY];
	return child && typeof child === 'object' ? (child as AutoLayoutChild) : {};
}

/** Effective sizing of a node on one axis: `childLayout.sizing`, then `layout.sizing`, then `fixed`. */
export function getLayoutSizing(node: CanvasNode, axis: Axis): AutoLayoutSizing {
	const value = getChildLayout(node).sizing?.[axis] ?? getAutoLayout(node)?.sizing?.[axis];
	return value === 'hug' || value === 'fill' ? value : 'fixed';
}

function limitsOf(node: CanvasNode) {
	const child = getChildLayout(node);
	const layout = getAutoLayout(node);
	const min = child.min ?? layout?.min ?? {};
	const max = child.max ?? layout?.max ?? {};
	return { minW: min.width, maxW: max.width, minH: min.height, maxH: max.height };
}

/** Padding as `[top, right, bottom, left]`, sanitised (non-finite and negative values become 0). */
export function resolvePadding(padding: AutoLayoutPadding | undefined): [number, number, number, number] {
	let sides: [unknown, unknown, unknown, unknown];
	if (typeof padding === 'number') sides = [padding, padding, padding, padding];
	else if (Array.isArray(padding)) {
		sides = padding.length === 2 ? [padding[0], padding[1], padding[0], padding[1]] : [padding[0], padding[1], padding[2], padding[3]];
	} else if (padding && typeof padding === 'object') sides = [padding.top, padding.right, padding.bottom, padding.left];
	else sides = [0, 0, 0, 0];
	return sides.map((p) => Math.max(finite(p), 0)) as [number, number, number, number];
}

interface Box {
	id: string;
	node: CanvasNode;
	parent?: string;
	x: number;
	y: number;
	w: number;
	h: number;
	kids: string[];
}

/** Working copy of the node geometry the layout passes mutate. */
class LayoutState {
	readonly boxes = new Map<string, Box>();
	readonly measure: AutoLayoutMeasure;
	private readonly visiting = new Set<string>();
	private readonly original = new Map<string, { x: number; y: number; w: number; h: number }>();

	constructor(nodes: CanvasNode[], options: AutoLayoutOptions = {}) {
		this.measure = options.measure ?? {};
		for (const node of nodes) {
			const size = this.measure.size?.(node) ?? getNodeSize(node, options.rectOptions);
			const box: Box = {
				id: node.id,
				node,
				parent: node.parentId,
				x: finite(node.position?.x),
				y: finite(node.position?.y),
				w: finite(size.width),
				h: finite(size.height),
				kids: []
			};
			this.boxes.set(node.id, box);
			this.original.set(node.id, { x: box.x, y: box.y, w: box.w, h: box.h });
		}
		for (const node of nodes) {
			if (node.parentId && node.parentId !== node.id) this.boxes.get(node.parentId)?.kids.push(node.id);
		}
	}

	updates(): CanvasNodeUpdate[] {
		const out: CanvasNodeUpdate[] = [];
		for (const [id, box] of this.boxes) {
			const o = this.original.get(id)!;
			const update: CanvasNodeUpdate = { id };
			if (Math.abs(box.x - o.x) > EPS || Math.abs(box.y - o.y) > EPS) update.position = { x: box.x, y: box.y };
			if (Math.abs(box.w - o.w) > EPS) update.width = box.w;
			if (Math.abs(box.h - o.h) > EPS) update.height = box.h;
			if (update.position || update.width !== undefined || update.height !== undefined) out.push(update);
		}
		return out;
	}

	/** Runs `fn` for `id` unless it is already on the stack (guards `parentId` cycles). */
	guard(id: string, fn: () => void) {
		if (this.visiting.has(id)) return;
		this.visiting.add(id);
		try {
			fn();
		} finally {
			this.visiting.delete(id);
		}
	}

	ancestors(id: string): string[] {
		const out: string[] = [];
		const seen = new Set([id]);
		let parent = this.boxes.get(id)?.parent;
		while (parent && !seen.has(parent) && this.boxes.has(parent)) {
			out.push(parent);
			seen.add(parent);
			parent = this.boxes.get(parent)!.parent;
		}
		return out;
	}
}

function setSize(s: LayoutState, id: string, w: number, h: number) {
	const b = s.boxes.get(id);
	if (!b) return;
	b.w = Number.isFinite(w) ? Math.max(w, 0) : b.w;
	b.h = Number.isFinite(h) ? Math.max(h, 0) : b.h;
}

function place(s: LayoutState, id: string, x: number, y: number) {
	const b = s.boxes.get(id);
	if (!b) return;
	b.x = x;
	b.y = y;
}

const isText = (s: LayoutState, b: Box) => !!s.measure.textSize && s.measure.textSize(b.node) !== undefined;

/** The children an auto layout frame places: visible and not absolute. */
function flowChildren(s: LayoutState, frame: string): string[] {
	const f = s.boxes.get(frame);
	if (!f) return [];
	return f.kids.filter((k) => {
		const n = s.boxes.get(k)!.node;
		return n.hidden !== true && !getChildLayout(n).absolute;
	});
}

/** Text that hugs its width refreshes its natural size (wrapping at its max width); a hug-height text gets its wrapped height. */
function fitHugText(s: LayoutState, id: string) {
	const b = s.boxes.get(id);
	if (!b || !isText(s, b)) return;
	const natural = s.measure.textSize!(b.node)!;
	const { minW, maxW } = limitsOf(b.node);
	if (getLayoutSizing(b.node, 'width') === 'hug') {
		const w = clampLayoutSize(natural.width, minW, maxW);
		const limited = Math.abs(w - natural.width) > EPS;
		const h = limited ? s.measure.textHeight?.(b.node, w) ?? natural.height : natural.height;
		setSize(s, id, w, h);
	} else if (getLayoutSizing(b.node, 'height') === 'hug') {
		setSize(s, id, b.w, s.measure.textHeight?.(b.node, b.w) ?? b.h);
	}
}

/** Clamps an in-flow child's own size to its min / max. */
function enforceLimits(s: LayoutState, id: string) {
	const b = s.boxes.get(id);
	if (!b) return;
	const { minW, maxW, minH, maxH } = limitsOf(b.node);
	if (minW === undefined && maxW === undefined && minH === undefined && maxH === undefined) return;
	const nw = clampLayoutSize(b.w, minW, maxW);
	const nh = clampLayoutSize(b.h, minH, maxH);
	if (Math.abs(nw - b.w) < 1e-9 && Math.abs(nh - b.h) < 1e-9) return;
	if (isText(s, b)) setSize(s, id, nw, nh);
	else resizeChild(s, id, nw, nh);
}

function itemBaseline(s: LayoutState, id: string, depth: number): number | undefined {
	const b = s.boxes.get(id);
	if (!b) return undefined;
	if (isText(s, b)) {
		const v = s.measure.textBaseline?.(b.node);
		return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
	}
	const layout = getAutoLayout(b.node);
	if (!layout || layout.mode === 'grid' || depth >= 32) return undefined;
	for (const k of flowChildren(s, id)) {
		const base = itemBaseline(s, k, depth + 1);
		if (base !== undefined) return s.boxes.get(k)!.y + base;
	}
	return undefined;
}

/** Resizes a child; text with hugging height re-wraps, frames apply constraints and re-run their layout. */
function resizeChild(s: LayoutState, id: string, w: number, h: number) {
	const b = s.boxes.get(id);
	if (!b) return;
	if (isText(s, b) && getLayoutSizing(b.node, 'height') === 'hug') {
		setSize(s, id, w, s.measure.textHeight?.(b.node, w) ?? h);
		return;
	}
	const ow = b.w;
	const oh = b.h;
	setSize(s, id, w, h);
	if (b.kids.length > 0) constrain(s, id, ow, oh);
	if (getAutoLayout(b.node)) layout(s, id);
}

interface Item {
	id: string;
	main: number;
	cross: number;
	fillMain: boolean;
	fillCross: boolean;
	minMain?: number;
	maxMain?: number;
	minCross?: number;
	maxCross?: number;
	baseline?: number;
	baseOff: number;
}

/** Where the first child starts and the step between children along the main axis. */
function mainOffsets(align: AutoLayoutAlignMain, inner: number, total: number, n: number, gap: number): [number, number] {
	const gaps = gap * Math.max(n - 1, 0);
	const free = inner - total;
	const k = Math.max(n, 1);
	switch (align) {
		case 'center':
			return [(free - gaps) / 2, gap];
		case 'end':
			return [free - gaps, gap];
		case 'space-between':
			return [0, n > 1 ? Math.max(free / (n - 1), 0) : 0];
		case 'space-around': {
			const g = Math.max(free / k, 0);
			return [g / 2, g];
		}
		case 'space-evenly': {
			const g = Math.max(free / (k + 1), 0);
			return [g, g];
		}
		default:
			return [0, gap];
	}
}

/**
 * Shares `free` main-axis space among the fill items like CSS flexbox: equal shares within
 * min / max; when clamping adds more than it removes, the items held at their min keep it
 * (otherwise those held at their max do) and the rest share what is left again.
 */
function distribute(items: Item[], open: number[], free: number) {
	free = Math.max(free, 0);
	while (open.length > 0) {
		const share = free / open.length;
		const sized = open.map((i) => [i, clampLayoutSize(share, items[i].minMain, items[i].maxMain)] as const);
		const violation = sized.reduce((sum, [, v]) => sum + (v - share), 0);
		const frozen = (v: number) =>
			Math.abs(violation) < 1e-9 || (violation > 0 && v > share + 1e-9) || (violation < 0 && v < share - 1e-9);
		for (const [i, v] of sized) {
			if (frozen(v)) {
				items[i].main = v;
				free -= v;
			}
		}
		free = Math.max(free, 0);
		open = sized.filter(([, v]) => !frozen(v)).map(([i]) => i);
	}
}

function layout(s: LayoutState, frame: string) {
	s.guard(frame, () => layoutFrameInner(s, frame));
}

function layoutFrameInner(s: LayoutState, frame: string) {
	const f = s.boxes.get(frame);
	const al = f && getAutoLayout(f.node);
	if (!f || !al) return;
	const horizontal = al.mode !== 'vertical';
	const hugW = getLayoutSizing(f.node, 'width') === 'hug';
	const hugH = getLayoutSizing(f.node, 'height') === 'hug';
	const ow = f.w;
	const oh = f.h;
	const fl = limitsOf(f.node);
	const [pt, pr, pb, pl] = resolvePadding(al.padding);
	const fw = Math.max(clampLayoutSize(ow, fl.minW, fl.maxW), pl + pr);
	const fh = Math.max(clampLayoutSize(oh, fl.minH, fl.maxH), pt + pb);
	const kids = flowChildren(s, frame);

	for (const c of kids) {
		fitHugText(s, c);
		enforceLimits(s, c);
	}

	if (al.mode === 'grid') {
		layoutGrid(s, frame, al);
		return;
	}

	const innerMainFixed = horizontal ? fw - pl - pr : fh - pt - pb;
	const innerCrossFixed = horizontal ? fh - pt - pb : fw - pl - pr;
	const hugMain = horizontal ? hugW : hugH;
	const hugCross = horizontal ? hugH : hugW;
	const alignCross = al.alignCross ?? 'start';
	const baseline = horizontal && alignCross === 'baseline';
	const stretch = alignCross === 'stretch';

	const items: Item[] = [];
	for (const c of kids) {
		const b = s.boxes.get(c)!;
		const lim = limitsOf(b.node);
		const sm = getLayoutSizing(b.node, horizontal ? 'width' : 'height');
		const sc = getLayoutSizing(b.node, horizontal ? 'height' : 'width');
		items.push({
			id: c,
			main: horizontal ? b.w : b.h,
			cross: horizontal ? b.h : b.w,
			// Fill needs room to fill: on an axis the frame hugs it reads as fixed.
			fillMain: sm === 'fill' && !hugMain,
			fillCross: (sc === 'fill' || (stretch && sc !== 'hug')) && !hugCross,
			minMain: horizontal ? lim.minW : lim.minH,
			maxMain: horizontal ? lim.maxW : lim.maxH,
			minCross: horizontal ? lim.minH : lim.minW,
			maxCross: horizontal ? lim.maxH : lim.maxW,
			baseOff: 0
		});
	}

	const gap = finite(al.gap);
	const alignMain = al.alignMain ?? 'start';
	const autoGap = alignMain === 'space-between' || alignMain === 'space-around' || alignMain === 'space-evenly';
	const wraps = !!al.wrap && !hugMain;
	const sizeOf = (id: string) => {
		const b = s.boxes.get(id)!;
		return horizontal ? [b.w, b.h] : [b.h, b.w];
	};
	const resize = (it: Item, main: number, cross: number) =>
		resizeChild(s, it.id, horizontal ? main : cross, horizontal ? cross : main);

	// Fill across a single line: resize those children first so their main size is final.
	if (!wraps) {
		for (const it of items) {
			if (!it.fillCross || it.fillMain) continue;
			resize(it, it.main, clampLayoutSize(innerCrossFixed, it.minCross, it.maxCross));
			it.main = sizeOf(it.id)[0];
		}
	}

	// Split into lines along the main axis.
	const lines: number[][] = [];
	if (wraps) {
		let cur: number[] = [];
		let used = 0;
		items.forEach((it, i) => {
			const sz = it.fillMain ? it.minMain ?? 0 : it.main;
			const add = cur.length === 0 ? sz : Math.max(gap, 0) + sz;
			if (cur.length > 0 && used + add > innerMainFixed + 1e-6) {
				lines.push(cur);
				cur = [];
				used = sz;
			} else {
				used += add;
			}
			cur.push(i);
		});
		if (cur.length > 0) lines.push(cur);
	} else {
		lines.push(items.map((_, i) => i));
	}

	// Share each line's free space among its fill children.
	for (const line of lines) {
		const fixed = line.filter((i) => !items[i].fillMain).reduce((sum, i) => sum + items[i].main, 0);
		const gaps = gap * Math.max(line.length - 1, 0);
		const fills = line.filter((i) => items[i].fillMain);
		if (fills.length > 0) distribute(items, fills, innerMainFixed - fixed - (autoGap ? 0 : gaps));
	}
	for (const it of items) {
		if (!it.fillMain) continue;
		const cross = it.fillCross && !wraps ? clampLayoutSize(innerCrossFixed, it.minCross, it.maxCross) : it.cross;
		resize(it, it.main, cross);
		it.cross = sizeOf(it.id)[1];
	}
	if (baseline) {
		for (const it of items) if (!it.fillCross) it.baseline = itemBaseline(s, it.id, 0);
	}

	// Line extents: [main used, cross size].
	const extents: [number, number][] = [];
	for (const line of lines) {
		const gaps = gap * Math.max(line.length - 1, 0);
		const lineBase = line.reduce((m, i) => Math.max(m, items[i].baseline ?? 0), 0);
		for (const i of line) items[i].baseOff = items[i].baseline !== undefined ? lineBase - items[i].baseline! : 0;
		const inLine = line.map((i) => items[i]);
		const mainUsed = inLine.reduce((sum, it) => sum + it.main, 0) + gaps;
		// A line of nothing but fill-across children keeps their own size.
		const allFill = inLine.every((it) => it.fillCross);
		const cross = inLine.filter((it) => allFill || !it.fillCross).reduce((m, it) => Math.max(m, it.baseOff + it.cross), 0);
		extents.push([mainUsed, cross]);
	}

	// Container size.
	const contentMain = extents.reduce((m, l) => Math.max(m, l[0]), 0);
	let crossGap = al.rowGap !== undefined ? finite(al.rowGap) : gap;
	const contentCross = extents.reduce((sum, l) => sum + l[1], 0) + crossGap * Math.max(lines.length - 1, 0);
	let nw = fw;
	let nh = fh;
	if (hugMain) {
		const v = contentMain + (horizontal ? pl + pr : pt + pb);
		if (horizontal) nw = v;
		else nh = v;
	}
	if (hugCross) {
		const v = contentCross + (horizontal ? pt + pb : pl + pr);
		if (horizontal) nh = v;
		else nw = v;
	}
	nw = Math.max(clampLayoutSize(nw, fl.minW, fl.maxW), pl + pr);
	nh = Math.max(clampLayoutSize(nh, fl.minH, fl.maxH), pt + pb);
	setSize(s, frame, nw, nh);
	constrain(s, frame, ow, oh);
	const innerMain = horizontal ? nw - pl - pr : nh - pt - pb;
	const innerCross = horizontal ? nh - pt - pb : nw - pl - pr;

	// Position. Several lines share the free space across the flow.
	let crossPos = horizontal ? pt : pl;
	const single = lines.length === 1;
	if (lines.length > 1) {
		const linesCross = extents.reduce((sum, l) => sum + l[1], 0);
		const between = lines.length - 1;
		const spread = (innerCross - linesCross) / between;
		const spaceBetween = al.alignContent === 'space-between';
		if (spaceBetween && spread > 0) {
			crossGap = spread;
		} else {
			if (spaceBetween) crossGap = 0;
			const free = innerCross - linesCross - crossGap * between;
			if (free > 0 && items.every((it) => it.fillCross)) {
				const extra = free / lines.length;
				for (const l of extents) l[1] += extra;
			} else if (Number.isFinite(free)) {
				crossPos += alignCross === 'center' ? free / 2 : alignCross === 'end' ? free : 0;
			}
		}
	}
	lines.forEach((line, li) => {
		const [used, ownCross] = extents[li];
		const lineCross = single ? innerCross : ownCross;
		const total = used - gap * Math.max(line.length - 1, 0);
		let [pos, step] = mainOffsets(alignMain, innerMain, total, line.length, gap);
		pos += horizontal ? pl : pt;
		for (const i of line) {
			const it = items[i];
			const crossSize = it.fillCross ? clampLayoutSize(lineCross, it.minCross, it.maxCross) : it.cross;
			let off = 0;
			if (alignCross === 'baseline') off = it.baseOff;
			else if (alignCross === 'center') off = (lineCross - crossSize) / 2;
			else if (alignCross === 'end') off = lineCross - crossSize;
			// Fill across a wrapped line: its size is known only now.
			if (it.fillCross && wraps) resize(it, it.main, crossSize);
			const x = horizontal ? pos : crossPos + off;
			const y = horizontal ? crossPos + off : pos;
			place(s, it.id, finite(x), finite(y));
			pos += it.main + step;
		}
		crossPos += lineCross + crossGap;
	});
}

// ---------------------------------------------------------------------------------------------
// Grid

interface TrackSpec {
	sizing: AutoLayoutSizing;
	value: number;
}

function parseTrack(track: AutoLayoutGridTrack | undefined): TrackSpec {
	if (typeof track === 'number') return { sizing: 'fixed', value: track };
	if (track === 'hug') return { sizing: 'hug', value: 0 };
	if (typeof track === 'string') {
		const match = /^\s*(-?\d*\.?\d+)\s*fr\s*$/i.exec(track);
		if (match) return { sizing: 'fill', value: Number(match[1]) };
	}
	if (track && typeof track === 'object' && 'fr' in track) return { sizing: 'fill', value: track.fr };
	return { sizing: 'fill', value: 1 };
}

function trackList(spec: number | AutoLayoutGridTrack[] | undefined, fallback: number): { count: number; tracks: TrackSpec[] } {
	if (Array.isArray(spec)) return { count: Math.min(Math.max(spec.length, 1), MAX_TRACKS), tracks: spec.map(parseTrack) };
	const n = typeof spec === 'number' && Number.isFinite(spec) ? Math.floor(spec) : fallback;
	return { count: Math.min(Math.max(n, 1), MAX_TRACKS), tracks: [] };
}

function trackSpec(tracks: TrackSpec[], i: number): TrackSpec {
	const t = tracks[i] ?? { sizing: 'fill', value: 1 };
	const value = Number.isFinite(t.value) ? Math.min(Math.max(t.value, 0), 1e6) : 0;
	return { sizing: t.sizing, value };
}

/** A grid child's cell (0-based column / row and spans). */
export interface AutoLayoutGridCell {
	id: string;
	column: number;
	row: number;
	columnSpan: number;
	rowSpan: number;
}

/** A grid frame's resolved geometry (frame-local): column x ranges, row y ranges, cells and the size it wants. */
export interface AutoLayoutGridGeometry {
	columns: [number, number][];
	rows: [number, number][];
	cells: AutoLayoutGridCell[];
	width: number;
	height: number;
}

function cellRect(g: AutoLayoutGridGeometry, c: AutoLayoutGridCell) {
	const x0 = g.columns[c.column]?.[0] ?? 0;
	const x1 = g.columns[c.column + c.columnSpan - 1]?.[1] ?? x0;
	const y0 = g.rows[c.row]?.[0] ?? 0;
	const y1 = g.rows[c.row + c.rowSpan - 1]?.[1] ?? y0;
	return { x: x0, y: y0, width: Math.max(x1, x0) - x0, height: Math.max(y1, y0) - y0 };
}

const toIndex = (v: unknown): number | undefined =>
	typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;

/** Places grid children: anchored ones first, then the rest in reading order into the next free cells. */
function gridPlace(s: LayoutState, al: AutoLayout, kids: string[]): { cells: AutoLayoutGridCell[]; rows: number } {
	const cols = trackList(al.grid?.columns, 2).count;
	const minRows = trackList(al.grid?.rows, 1).count;
	const maxRows = Math.min(Math.max(Math.floor(MAX_GRID_CELLS / cols), 1), MAX_TRACKS);
	const occ: boolean[][] = [];
	const free = (c: number, r: number, cs: number, rs: number) => {
		for (let ri = r; ri < r + rs; ri++) {
			const row = occ[ri];
			if (!row) continue;
			for (let ci = c; ci < c + cs; ci++) if (row[ci]) return false;
		}
		return true;
	};
	const mark = (c: number, r: number, cs: number, rs: number) => {
		while (occ.length < r + rs) occ.push(new Array(cols).fill(false));
		for (let ri = r; ri < r + rs; ri++) for (let ci = c; ci < c + cs; ci++) occ[ri][ci] = true;
	};
	const spans = (id: string) => {
		const area = getChildLayout(s.boxes.get(id)!.node).gridArea ?? {};
		const cs = Math.min(Math.max(toIndex(area.columnSpan) ?? 1, 1), cols);
		const rs = Math.min(Math.max(toIndex(area.rowSpan) ?? 1, 1), maxRows);
		const col = toIndex(area.column);
		const row = toIndex(area.row);
		return {
			col: col === undefined ? undefined : Math.min(col, cols - cs),
			row: row === undefined ? undefined : Math.min(row, maxRows - rs),
			cs,
			rs
		};
	};
	const placed: (AutoLayoutGridCell | undefined)[] = new Array(kids.length).fill(undefined);
	kids.forEach((id, i) => {
		const { col, row, cs, rs } = spans(id);
		if (col !== undefined && row !== undefined) {
			mark(col, row, cs, rs);
			placed[i] = { id, column: col, row, columnSpan: cs, rowSpan: rs };
		}
	});
	let cursor: [number, number] = [0, 0]; // [row, column]
	kids.forEach((id, i) => {
		if (placed[i]) return;
		const { col, row, cs, rs } = spans(id);
		const lastRow = maxRows - rs;
		let c = 0;
		let r = 0;
		if (col !== undefined) {
			r = lastRow;
			for (let ri = 0; ri <= lastRow; ri++) if (free(col, ri, cs, rs)) { r = ri; break; }
			c = col;
		} else if (row !== undefined) {
			r = row;
			for (let ci = 0; ci <= cols - cs; ci++) if (free(ci, row, cs, rs)) { c = ci; break; }
		} else {
			let [rr, cc] = cursor;
			let found: [number, number] | undefined;
			while (rr <= lastRow) {
				if (cc + cs <= cols && free(cc, rr, cs, rs)) {
					found = [cc, rr];
					break;
				}
				cc += 1;
				if (cc + cs > cols) {
					cc = 0;
					rr += 1;
				}
			}
			[c, r] = found ?? [0, lastRow];
			cursor = [r, c + cs];
		}
		mark(c, r, cs, rs);
		placed[i] = { id, column: c, row: r, columnSpan: cs, rowSpan: rs };
	});
	const cells = placed.filter((c): c is AutoLayoutGridCell => !!c);
	const rows = Math.max(cells.reduce((m, c) => Math.max(m, c.row + c.rowSpan), 0), minRows);
	return { cells, rows: Math.min(rows, MAX_TRACKS) };
}

/**
 * Resolves track sizes: fixed tracks keep their size, hug tracks fit their content, fill tracks
 * share what is left by their `fr` like CSS (a track never gets less than its content).
 * `avail` is undefined when the frame hugs that axis.
 */
function resolveTracks(tracks: TrackSpec[], content: number[], avail: number | undefined): number[] {
	const out = content.map((c, i) => {
		const t = trackSpec(tracks, i);
		return t.sizing === 'fixed' ? t.value : c;
	});
	if (avail === undefined) return out;
	const fr = (i: number) => trackSpec(tracks, i).value;
	let flex = out.map((_, i) => i).filter((i) => trackSpec(tracks, i).sizing === 'fill');
	let used = out.reduce((sum, v, i) => (trackSpec(tracks, i).sizing === 'fill' ? sum : sum + v), 0);
	while (flex.length > 0) {
		const total = flex.reduce((sum, i) => sum + fr(i), 0);
		const unit = total > 1e-12 ? Math.max(avail - used, 0) / total : 0;
		const open = flex.filter((i) => unit * fr(i) >= out[i]);
		const frozen = flex.filter((i) => unit * fr(i) < out[i]);
		if (frozen.length === 0) {
			for (const i of open) out[i] = unit * fr(i);
			break;
		}
		used += frozen.reduce((sum, i) => sum + out[i], 0);
		flex = open;
	}
	return out;
}

/** Content size per track: the largest single-span child; spanning children grow the content-sized tracks they span. */
function trackContent(
	cells: AutoLayoutGridCell[],
	sizes: number[],
	tracks: TrackSpec[],
	n: number,
	gap: number,
	columns: boolean,
	hug: boolean
): number[] {
	const byContent = (i: number) => trackSpec(tracks, i).sizing !== 'fixed';
	const content = Array.from({ length: n }, (_, i) => {
		const t = trackSpec(tracks, i);
		return t.sizing === 'fixed' ? t.value : 0;
	});
	const span = (c: AutoLayoutGridCell): [number, number] => (columns ? [c.column, c.columnSpan] : [c.row, c.rowSpan]);
	cells.forEach((c, k) => {
		const [start, len] = span(c);
		if (len === 1 && byContent(start) && start < n) content[start] = Math.max(content[start], sizes[k]);
	});
	cells.forEach((c, k) => {
		const [start, len] = span(c);
		if (len < 2) return;
		const range = Array.from({ length: len }, (_, j) => start + j).filter((i) => i < n);
		if (!hug && range.some((i) => trackSpec(tracks, i).sizing === 'fill')) return;
		const have = range.reduce((sum, i) => sum + content[i], 0) + gap * (len - 1);
		const grow = range.filter(byContent);
		if (sizes[k] > have && grow.length > 0) {
			const extra = (sizes[k] - have) / grow.length;
			for (const i of grow) content[i] += extra;
		}
	});
	return content;
}

function trackRanges(start: number, sizes: number[], gap: number): [number, number][] {
	let x = start;
	return sizes.map((size) => {
		const r: [number, number] = [x, x + size];
		x += size + gap;
		return r;
	});
}

function gridGeometryOf(s: LayoutState, frame: string): AutoLayoutGridGeometry | undefined {
	const f = s.boxes.get(frame);
	const al = f && getAutoLayout(f.node);
	if (!f || !al || al.mode !== 'grid') return undefined;
	const [pt, pr, pb, pl] = resolvePadding(al.padding);
	const kids = flowChildren(s, frame);
	const { cells, rows } = gridPlace(s, al, kids);
	const colSpec = trackList(al.grid?.columns, 2);
	const rowSpec = trackList(al.grid?.rows, 1);
	const cols = colSpec.count;
	const gx = Math.max(finite(al.gap), 0);
	const gy = Math.max(al.rowGap !== undefined ? finite(al.rowGap) : gx, 0);
	const hugW = getLayoutSizing(f.node, 'width') === 'hug';
	const hugH = getLayoutSizing(f.node, 'height') === 'hug';
	const ws: number[] = [];
	const hs: number[] = [];
	for (const c of cells) {
		const b = s.boxes.get(c.id)!;
		const lim = limitsOf(b.node);
		ws.push(getLayoutSizing(b.node, 'width') === 'fill' && !hugW ? lim.minW ?? 0 : b.w);
		hs.push(getLayoutSizing(b.node, 'height') === 'fill' && !hugH ? lim.minH ?? 0 : b.h);
	}
	const colContent = trackContent(cells, ws, colSpec.tracks, cols, gx, true, hugW);
	const rowContent = trackContent(cells, hs, rowSpec.tracks, rows, gy, false, hugH);
	const gapsW = gx * Math.max(cols - 1, 0);
	const gapsH = gy * Math.max(rows - 1, 0);
	const colW = resolveTracks(colSpec.tracks, colContent, hugW ? undefined : finite(f.w) - pl - pr - gapsW);
	const rowH = resolveTracks(rowSpec.tracks, rowContent, hugH ? undefined : finite(f.h) - pt - pb - gapsH);
	const lim = limitsOf(f.node);
	const width = hugW ? colW.reduce((a, b) => a + b, 0) + gapsW + pl + pr : finite(f.w);
	const height = hugH ? rowH.reduce((a, b) => a + b, 0) + gapsH + pt + pb : finite(f.h);
	return {
		columns: trackRanges(pl, colW, gx),
		rows: trackRanges(pt, rowH, gy),
		cells,
		width: Math.max(clampLayoutSize(width, lim.minW, lim.maxW), pl + pr),
		height: Math.max(clampLayoutSize(height, lim.minH, lim.maxH), pt + pb)
	};
}

function layoutGrid(s: LayoutState, frame: string, al: AutoLayout) {
	const f = s.boxes.get(frame)!;
	const fw = f.w;
	const fh = f.h;
	const hugW = getLayoutSizing(f.node, 'width') === 'hug';
	const hugH = getLayoutSizing(f.node, 'height') === 'hug';
	const lim = limitsOf(f.node);
	const [pt, pr, pb, pl] = resolvePadding(al.padding);
	setSize(
		s,
		frame,
		hugW ? fw : Math.max(clampLayoutSize(fw, lim.minW, lim.maxW), pl + pr),
		hugH ? fh : Math.max(clampLayoutSize(fh, lim.minH, lim.maxH), pt + pb)
	);
	let g = gridGeometryOf(s, frame);
	if (!g) return;
	// Fill-width children take their column width first, so wrapping text sizes its row.
	let widened = false;
	for (const c of g.cells) {
		const b = s.boxes.get(c.id)!;
		if (getLayoutSizing(b.node, 'width') === 'fill' && !hugW) {
			const l = limitsOf(b.node);
			resizeChild(s, c.id, clampLayoutSize(cellRect(g, c).width, l.minW, l.maxW), b.h);
			widened = true;
		}
	}
	if (widened) g = gridGeometryOf(s, frame) ?? g;
	setSize(s, frame, g.width, g.height);
	constrain(s, frame, fw, fh);
	const frameX: AutoLayoutCellAlign = al.alignMain === 'center' ? 'center' : al.alignMain === 'end' ? 'end' : 'start';
	const frameY: AutoLayoutCellAlign = al.alignCross === 'center' ? 'center' : al.alignCross === 'end' ? 'end' : 'start';
	const offset = (a: AutoLayoutCellAlign, free: number) => (a === 'center' ? free / 2 : a === 'end' ? free : 0);
	for (const c of g.cells) {
		const cell = cellRect(g, c);
		const b = s.boxes.get(c.id)!;
		const l = limitsOf(b.node);
		const area = getChildLayout(b.node).gridArea ?? {};
		const fillW = getLayoutSizing(b.node, 'width') === 'fill' && !hugW;
		const fillH = getLayoutSizing(b.node, 'height') === 'fill' && !hugH;
		if (fillW || fillH) {
			resizeChild(
				s,
				c.id,
				fillW ? clampLayoutSize(cell.width, l.minW, l.maxW) : b.w,
				fillH ? clampLayoutSize(cell.height, l.minH, l.maxH) : b.h
			);
		}
		const ox = offset(area.alignX ?? frameX, cell.width - b.w);
		const oy = offset(area.alignY ?? frameY, cell.height - b.h);
		place(s, c.id, finite(cell.x + ox), finite(cell.y + oy));
	}
}

// ---------------------------------------------------------------------------------------------
// Constraints

/**
 * After `id` changed size from `ow × oh`, moves / resizes its children by their constraints
 * (recursively). In an auto layout frame only absolute children follow constraints.
 */
function constrain(s: LayoutState, id: string, ow: number, oh: number) {
	const f = s.boxes.get(id);
	if (!f) return;
	const nw = f.w;
	const nh = f.h;
	if (Math.abs(nw - ow) < 1e-9 && Math.abs(nh - oh) < 1e-9) return;
	const absoluteOnly = !!getAutoLayout(f.node);
	const sx = ow > 1e-9 ? nw / ow : 1;
	const sy = oh > 1e-9 ? nh / oh : 1;
	s.guard(`constrain:${id}`, () => {
		for (const k of f.kids) {
			const c = s.boxes.get(k)!;
			const child = getChildLayout(c.node);
			if (absoluteOnly && !child.absolute) continue;
			let x0 = c.x;
			let x1 = c.x + c.w;
			let y0 = c.y;
			let y1 = c.y + c.h;
			const dx = nw - ow;
			const dy = nh - oh;
			switch (child.constraints?.horizontal ?? 'left') {
				case 'right':
					x0 += dx;
					x1 += dx;
					break;
				case 'leftRight':
					x1 += dx;
					break;
				case 'center':
					x0 += dx / 2;
					x1 += dx / 2;
					break;
				case 'scale':
					x0 *= sx;
					x1 *= sx;
					break;
			}
			switch (child.constraints?.vertical ?? 'top') {
				case 'bottom':
					y0 += dy;
					y1 += dy;
					break;
				case 'topBottom':
					y1 += dy;
					break;
				case 'center':
					y0 += dy / 2;
					y1 += dy / 2;
					break;
				case 'scale':
					y0 *= sy;
					y1 *= sy;
					break;
			}
			const cw = c.w;
			const ch = c.h;
			const resized = Math.abs(x1 - x0 - cw) > 1e-9 || Math.abs(y1 - y0 - ch) > 1e-9;
			place(s, k, finite(x0), finite(y0));
			if (resized) {
				setSize(s, k, x1 - x0, y1 - y0);
				if (c.kids.length > 0) constrain(s, k, cw, ch);
				if (getAutoLayout(c.node)) layout(s, k);
			}
		}
	});
}

// ---------------------------------------------------------------------------------------------
// Public API

/**
 * Lays out one auto layout frame's children and sizes the frame when it hugs (nested frames
 * that are resized by the layout are laid out again). Returns the position / size updates.
 */
export function layoutFrame(nodes: CanvasNode[], frameId: string, options: AutoLayoutOptions = {}): CanvasNodeUpdate[] {
	const s = new LayoutState(nodes, options);
	layout(s, frameId);
	return s.updates();
}

function postOrder(s: LayoutState, nodes: CanvasNode[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const visit = (id: string) => {
		if (seen.has(id)) return;
		seen.add(id);
		for (const k of s.boxes.get(id)?.kids ?? []) visit(k);
		out.push(id);
	};
	const roots = nodes.filter((n) => !n.parentId || !s.boxes.has(n.parentId));
	for (const r of roots) visit(r.id);
	for (const n of nodes) visit(n.id); // nodes in parent cycles
	return out;
}

/** Lays out every auto layout frame, children before parents, so nested hugging settles in one pass. */
export function layoutAll(nodes: CanvasNode[], options: AutoLayoutOptions = {}): CanvasNodeUpdate[] {
	const s = new LayoutState(nodes, options);
	for (const id of postOrder(s, nodes)) if (getAutoLayout(s.boxes.get(id)!.node)) layout(s, id);
	return s.updates();
}

/**
 * Lays out `changedId` (when it is a frame) and then each of its auto layout ancestors,
 * innermost first. Use it after a node inside a frame was added, removed, resized or moved.
 */
export function layoutUp(nodes: CanvasNode[], changedId: string, options: AutoLayoutOptions = {}): CanvasNodeUpdate[] {
	return layoutUpMany(nodes, [changedId], options);
}

/** {@link layoutUp} for several changed nodes at once (each chain once, innermost frames first). */
export function layoutUpMany(nodes: CanvasNode[], changedIds: Iterable<string>, options: AutoLayoutOptions = {}): CanvasNodeUpdate[] {
	const s = new LayoutState(nodes, options);
	const chains = [...new Set(changedIds)].filter((id) => s.boxes.has(id)).map((id) => [id, ...s.ancestors(id)]);
	// Deeper frames first so a parent sees its children's final sizes.
	const depth = new Map<string, number>();
	for (const chain of chains) chain.forEach((id, i) => depth.set(id, Math.max(depth.get(id) ?? 0, chain.length - 1 - i)));
	const order = [...depth.keys()].sort((a, b) => depth.get(b)! - depth.get(a)!);
	for (const id of order) if (getAutoLayout(s.boxes.get(id)!.node)) layout(s, id);
	return s.updates();
}

/**
 * Children of `parentId` follow their constraints after the parent was resized from
 * `previousSize` to its current size. In an auto layout frame only absolute children move
 * (the layout places the others). Returns the updates.
 */
export function applyConstraints(
	nodes: CanvasNode[],
	parentId: string,
	previousSize: { width: number; height: number },
	options: AutoLayoutOptions = {}
): CanvasNodeUpdate[] {
	const s = new LayoutState(nodes, options);
	constrain(s, parentId, previousSize.width, previousSize.height);
	return s.updates();
}

/** The resolved grid of a grid frame (frame-local), from its children's current sizes. */
export function getAutoLayoutGrid(
	nodes: CanvasNode[],
	frameId: string,
	options: AutoLayoutOptions = {}
): AutoLayoutGridGeometry | undefined {
	return gridGeometryOf(new LayoutState(nodes, options), frameId);
}

/** Ids of the children a frame places (visible, not absolute), in order. */
export function getFlowChildren(nodes: CanvasNode[], frameId: string): string[] {
	return nodes
		.filter((n) => n.parentId === frameId && n.id !== frameId && n.hidden !== true && !getChildLayout(n).absolute)
		.map((n) => n.id);
}

/** The nearest auto layout frame that places `id` (its parent, when `id` is a flow child). */
export function getLayoutParent(nodes: CanvasNode[], id: string): CanvasNode | undefined {
	const lookup = createNodeLookup(nodes);
	const node = lookup.get(id);
	if (!node?.parentId || getChildLayout(node).absolute) return undefined;
	const parent = lookup.get(node.parentId);
	return isAutoLayoutFrame(parent) ? parent : undefined;
}

/**
 * Makes a node's sizing coherent with where it sits, and that of its children: `fill` needs an
 * auto layout parent that does not hug that axis (and a flow child), `hug` needs an auto layout
 * frame or a text-like node (see `measure.textSize`); otherwise the axis becomes `fixed`.
 * Writes `data.childLayout.sizing`. Returns a new array (unchanged nodes keep their identity).
 */
export function makeSizingCoherent<TNode extends CanvasNode>(
	nodes: TNode[],
	id: string,
	options: AutoLayoutOptions = {}
): TNode[] {
	const lookup = createNodeLookup(nodes);
	const targets = new Set([id, ...nodes.filter((n) => n.parentId === id).map((n) => n.id)]);
	if (!lookup.has(id)) return nodes;
	let changed = false;
	const next = nodes.map((node) => {
		if (!targets.has(node.id)) return node;
		const parent = node.parentId ? lookup.get(node.parentId) : undefined;
		const flowParent = parent && isAutoLayoutFrame(parent) && !getChildLayout(node).absolute ? parent : undefined;
		const canHug = isAutoLayoutFrame(node) || options.measure?.textSize?.(node) !== undefined;
		const coherent = (axis: Axis): AutoLayoutSizing => {
			const sizing = getLayoutSizing(node, axis);
			if (sizing === 'fill' && (!flowParent || getLayoutSizing(flowParent, axis) === 'hug')) return 'fixed';
			if (sizing === 'hug' && !canHug) return 'fixed';
			return sizing;
		};
		const width = coherent('width');
		const height = coherent('height');
		if (width === getLayoutSizing(node, 'width') && height === getLayoutSizing(node, 'height')) return node;
		changed = true;
		const child = getChildLayout(node);
		return {
			...node,
			data: { ...node.data, [CHILD_LAYOUT_DATA_KEY]: { ...child, sizing: { ...child.sizing, width, height } } }
		};
	});
	return changed ? next : nodes;
}

// ---------------------------------------------------------------------------------------------
// Reordering

export interface AutoLayoutInsertTarget {
	frameId: string;
	/** Index among the frame's flow children, not counting the dragged node. */
	index: number;
	/** Insertion marker (absolute flow coordinates) for `<CanvasGuidesLayer>`. */
	guide: GuideLine;
}

/**
 * Where a node dropped at `point` (absolute flow coordinates) goes among the flow children of
 * auto layout frame `frameId`: the reading-order index of the slot under the point. `excludeId`
 * (the dragged node) is left out of the siblings.
 */
export function getAutoLayoutInsertTarget(
	nodes: CanvasNode[],
	frameId: string,
	point: XYPosition,
	options: AutoLayoutOptions & { excludeId?: string } = {}
): AutoLayoutInsertTarget | undefined {
	const lookup = createNodeLookup(nodes);
	const frame = lookup.get(frameId);
	const al = getAutoLayout(frame);
	if (!frame || !al) return undefined;
	const s = new LayoutState(nodes, options);
	const origin = getAbsolutePosition(frame, lookup);
	const px = point.x - origin.x;
	const py = point.y - origin.y;
	const siblings = flowChildren(s, frameId)
		.filter((id) => id !== options.excludeId)
		.map((id) => s.boxes.get(id)!);
	// Grid and wrapped layouts read in rows (vertical wrap: columns); plain stacks along their axis.
	const horizontal = al.mode !== 'vertical';
	const main = (b: { x: number; y: number }) => (horizontal ? b.x : b.y);
	const mainSize = (b: Box) => (horizontal ? b.w : b.h);
	const cross = (b: { x: number; y: number }) => (horizontal ? b.y : b.x);
	const crossSize = (b: Box) => (horizontal ? b.h : b.w);
	const p = { x: px, y: py };
	const multiLine = al.mode === 'grid' || !!al.wrap;
	let index = 0;
	for (const b of siblings) {
		const before = multiLine
			? cross(b) + crossSize(b) <= cross(p) ||
				(cross(b) <= cross(p) && main(b) + mainSize(b) / 2 < main(p))
			: main(b) + mainSize(b) / 2 < main(p);
		if (before) index += 1;
	}
	const [pt, pr, pb, pl] = resolvePadding(al.padding);
	const prev = siblings[index - 1];
	const next = siblings[index];
	const f = s.boxes.get(frameId)!;
	let guide: GuideLine;
	if (horizontal) {
		const x = prev && next && Math.abs(cross(prev) - cross(next)) < 1e-6
			? (prev.x + prev.w + next.x) / 2
			: prev
				? prev.x + prev.w
				: next
					? next.x
					: pl;
		const ref = next ?? prev;
		const y1 = ref ? ref.y : pt;
		const y2 = ref ? ref.y + ref.h : f.h - pb;
		guide = { orientation: 'vertical', kind: 'edge', x1: origin.x + x, y1: origin.y + y1, x2: origin.x + x, y2: origin.y + y2 };
	} else {
		const y = prev && next && Math.abs(cross(prev) - cross(next)) < 1e-6
			? (prev.y + prev.h + next.y) / 2
			: prev
				? prev.y + prev.h
				: next
					? next.y
					: pt;
		const ref = next ?? prev;
		const x1 = ref ? ref.x : pl;
		const x2 = ref ? ref.x + ref.w : f.w - pr;
		guide = { orientation: 'horizontal', kind: 'edge', x1: origin.x + x1, y1: origin.y + y, x2: origin.x + x2, y2: origin.y + y };
	}
	return { frameId, index, guide };
}

/**
 * Moves child `childId` of an auto layout frame to flow index `index` (among its flow siblings)
 * by reordering the node array; parents still precede their children. Returns a new array
 * (the same array when nothing moves).
 */
export function moveLayoutChild<TNode extends CanvasNode>(nodes: TNode[], childId: string, index: number): TNode[] {
	const child = nodes.find((n) => n.id === childId);
	if (!child?.parentId) return nodes;
	const siblings = nodes.filter((n) => n.parentId === child.parentId && n.id !== child.parentId);
	const flow = siblings.filter((n) => n.hidden !== true && !getChildLayout(n).absolute && n.id !== childId);
	const clamped = Math.min(Math.max(Math.floor(Number.isFinite(index) ? index : 0), 0), flow.length);
	// Insert before the flow sibling now at `clamped` (or after the last one).
	const order = siblings.filter((n) => n.id !== childId);
	const anchor = flow[clamped];
	const at = anchor ? order.indexOf(anchor) : flow.length > 0 ? order.indexOf(flow[flow.length - 1]) + 1 : order.length;
	order.splice(at, 0, child);
	if (order.every((n, i) => n === siblings[i])) return nodes;
	// Put the siblings back into the slots they occupied, in their new order.
	let k = 0;
	const parentId = child.parentId;
	const placed = nodes.map((n) => (n.parentId === parentId && n.id !== parentId ? order[k++] : n));
	return parentsFirst(placed);
}

/** Stable reorder so every node comes after its parent (xyflow requires it). */
function parentsFirst<TNode extends CanvasNode>(nodes: TNode[]): TNode[] {
	const ids = new Set(nodes.map((n) => n.id));
	const pending = new Map<string, TNode[]>();
	const done = new Set<string>();
	const out: TNode[] = [];
	const emit = (n: TNode) => {
		out.push(n);
		done.add(n.id);
		const waiting = pending.get(n.id);
		if (waiting) {
			pending.delete(n.id);
			for (const w of waiting) emit(w);
		}
	};
	for (const n of nodes) {
		if (n.parentId && ids.has(n.parentId) && !done.has(n.parentId) && n.parentId !== n.id) {
			if (!pending.has(n.parentId)) pending.set(n.parentId, []);
			pending.get(n.parentId)!.push(n);
		} else emit(n);
	}
	for (const waiting of pending.values()) for (const n of waiting) if (!done.has(n.id)) emit(n); // cycles
	return out;
}
