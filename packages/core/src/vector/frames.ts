/**
 * Frames (artboards) and their children's resizing constraints.
 *
 * A frame is a group with `frame` set: a rectangle in the group's own space, a fill drawn below the
 * children and (by default) a clip. It draws, hit-tests and bounds through `vectorFrameDrawn`, an
 * equivalent clip group (or plain group without the clip), so rendering, masks, snapping and SVG
 * export reuse the mask group machinery. Resizing a frame lays out its children by their
 * `resizing` constraints (`vectorFrameChildMatrix`) instead of scaling them.
 *
 * The constraint rules follow figcraft's `crates/layout/src/lib.rs` `apply_constraints` (MIT OR
 * Apache-2.0, © ArtCraft Team and contributors; see THIRD_PARTY_NOTICES.md), as already ported for
 * the canvas package (`canvas/autoLayout.ts`): left / right / left and right / centre / scale
 * horizontally, top / bottom / top and bottom / centre / scale vertically.
 */

import type {
	VectorBounds,
	VectorDocument,
	VectorFrame,
	VectorGroupNode,
	VectorHorizontalResizing,
	VectorNode,
	VectorPathNode,
	VectorResizing,
	VectorVerticalResizing
} from './types.js';
import { VECTOR_HORIZONTAL_RESIZING, VECTOR_VERTICAL_RESIZING } from './types.js';
import type { AffineMatrix } from '../geom/types.js';

/** A frame group (its `frame` set, and not a blend, live boolean or mask group). */
export type VectorFrameGroup = VectorGroupNode & { frame: VectorFrame };

/** Whether the node is a frame. */
export function isVectorFrame(node: VectorNode | null | undefined): node is VectorFrameGroup {
	return node?.type === 'group' && !!node.frame && !node.blend && !node.liveBoolean && !node.mask;
}

/** The frame's rectangle as a closed four-anchor path (in the frame's own space). */
export function vectorFrameRectPath(frame: VectorFrame): VectorPathNode['subpaths'] {
	const { x, y, width: w, height: h } = frame;
	return [{ closed: true, anchors: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] }];
}

const drawnCache = new WeakMap<VectorFrameGroup, VectorGroupNode>();

/**
 * The frame as an equivalent plain group: a clip group (`mask: clip`) whose mask is the frame's
 * rectangle (`<id>~frame-clip`), then its fill (`<id>~frame-fill`) and its children; without the
 * clip, a group of the fill and the children. Same id, transform and appearance. Cached per node.
 */
export function vectorFrameDrawn(node: VectorFrameGroup): VectorGroupNode {
	let hit = drawnCache.get(node);
	if (hit) return hit;
	const { frame, ...group } = node;
	const rect = vectorFrameRectPath(frame);
	const fill = frame.fill !== undefined && frame.fill !== null && frame.fill !== 'none' ? [{ id: `${node.id}~frame-fill`, type: 'path' as const, fill: frame.fill, stroke: null, subpaths: rect }] : [];
	hit =
		frame.clip === false
			? { ...group, children: [...fill, ...node.children] }
			: { ...group, mask: { type: 'clip' }, children: [{ id: `${node.id}~frame-clip`, type: 'path', fill: '#000000', stroke: null, subpaths: rect }, ...fill, ...node.children] };
	drawnCache.set(node, hit);
	return hit;
}

/** Whether `p` (in the frame's own space) lies in its rectangle, within `tolerance`. */
export function vectorFrameContains(frame: VectorFrame, p: { x: number; y: number }, tolerance = 0): boolean {
	return p.x >= frame.x - tolerance && p.x <= frame.x + frame.width + tolerance && p.y >= frame.y - tolerance && p.y <= frame.y + frame.height + tolerance;
}

type Axis = 'start' | 'end' | 'both' | 'center' | 'scale';
const H: Record<VectorHorizontalResizing, Axis> = { left: 'start', right: 'end', leftRight: 'both', center: 'center', scale: 'scale' };
const V: Record<VectorVerticalResizing, Axis> = { top: 'start', bottom: 'end', topBottom: 'both', center: 'center', scale: 'scale' };

/** Where a child's span [a0, a1] goes when its frame's span [f0, f1] becomes [g0, g1]. */
function placeSpan(rule: Axis, a0: number, a1: number, f0: number, f1: number, g0: number, g1: number): [number, number] {
	const size = a1 - a0;
	switch (rule) {
		case 'start':
			return [g0 + (a0 - f0), g0 + (a1 - f0)];
		case 'end':
			return [g1 - (f1 - a0), g1 - (f1 - a1)];
		case 'both': {
			const b0 = g0 + (a0 - f0);
			// Never narrower than nothing (a frame shrunk past the margins keeps the child a sliver).
			return [b0, Math.max(b0 + Math.min(size, 1e-3), g1 - (f1 - a1))];
		}
		case 'center': {
			const c = (g0 + g1) / 2 + ((a0 + a1) / 2 - (f0 + f1) / 2);
			return [c - size / 2, c + size / 2];
		}
		case 'scale': {
			const k = f1 - f0 > 1e-9 ? (g1 - g0) / (f1 - f0) : 1;
			return [g0 + (a0 - f0) * k, g0 + (a1 - f0) * k];
		}
	}
}

/**
 * The matrix (in the frame's own space) that takes a child with bounds `box` from frame rectangle
 * `from` to `to` by the child's `resizing` constraints: a scale and translation per axis.
 */
export function vectorFrameChildMatrix(resizing: VectorResizing | null | undefined, box: VectorBounds, from: VectorFrame, to: VectorFrame): AffineMatrix {
	const [x0, x1] = placeSpan(H[resizing?.horizontal ?? 'left'] ?? 'start', box.x, box.x + box.width, from.x, from.x + from.width, to.x, to.x + to.width);
	const [y0, y1] = placeSpan(V[resizing?.vertical ?? 'top'] ?? 'start', box.y, box.y + box.height, from.y, from.y + from.height, to.y, to.y + to.height);
	const sx = box.width > 1e-9 ? (x1 - x0) / box.width : 1;
	const sy = box.height > 1e-9 ? (y1 - y0) / box.height : 1;
	return [sx, 0, 0, sy, x0 - sx * box.x, y0 - sy * box.y];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Reads a frame from untrusted data (JSON, agent input, SVG import), or null. */
export function sanitizeVectorFrame(value: unknown): VectorFrame | null {
	if (!value || typeof value !== 'object') return null;
	const r = value as Record<string, unknown>;
	if (!finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height) || r.width < 0 || r.height < 0) return null;
	const out: VectorFrame = { x: r.x, y: r.y, width: r.width, height: r.height };
	if (typeof r.fill === 'string' || (r.fill && typeof r.fill === 'object')) out.fill = r.fill as VectorFrame['fill'];
	if (r.clip === false) out.clip = false;
	return out;
}

/** Reads resizing constraints from untrusted data, or null (unknown values dropped). */
export function sanitizeVectorResizing(value: unknown): VectorResizing | null {
	if (!value || typeof value !== 'object') return null;
	const r = value as Record<string, unknown>;
	const out: VectorResizing = {};
	if (VECTOR_HORIZONTAL_RESIZING.includes(r.horizontal as VectorHorizontalResizing)) out.horizontal = r.horizontal as VectorHorizontalResizing;
	if (VECTOR_VERTICAL_RESIZING.includes(r.vertical as VectorVerticalResizing)) out.vertical = r.vertical as VectorVerticalResizing;
	return out.horizontal || out.vertical ? out : null;
}

/** Labels for the resizing constraint pickers. */
export const VECTOR_HORIZONTAL_RESIZING_LABELS: Readonly<Record<VectorHorizontalResizing, string>> = {
	left: 'Left',
	right: 'Right',
	leftRight: 'Left & right',
	center: 'Centre',
	scale: 'Scale'
};
export const VECTOR_VERTICAL_RESIZING_LABELS: Readonly<Record<VectorVerticalResizing, string>> = {
	top: 'Top',
	bottom: 'Bottom',
	topBottom: 'Top & bottom',
	center: 'Centre',
	scale: 'Scale'
};

/** Whether `inner` lies wholly in `outer` (false for a missing box). */
export function vectorBoundsInside(inner: VectorBounds | null, outer: VectorBounds): boolean {
	return !!inner && inner.x >= outer.x - 1e-9 && inner.y >= outer.y - 1e-9 && inner.x + inner.width <= outer.x + outer.width + 1e-9 && inner.y + inner.height <= outer.y + outer.height + 1e-9;
}

/** Top-level frames of a document (its artboards), bottom to top. */
export function vectorArtboards(doc: Pick<VectorDocument, 'nodes'>): VectorFrameGroup[] {
	return doc.nodes.filter(isVectorFrame);
}

/**
 * A document of one frame on its own, sized to the frame with the frame's corner at the origin
 * (the frame's rotation undone), for exporting an artboard. Symbols, constraints' parameters and the
 * page background are carried over. Null when `id` is not a frame.
 */
export function vectorFrameDocument(doc: VectorDocument, id: string, find: (nodes: readonly VectorNode[], id: string) => VectorNode | null | undefined): VectorDocument | null {
	const node = find(doc.nodes, id);
	if (!isVectorFrame(node)) return null;
	const { transform: _t, ...rest } = node;
	const { x, y, width, height } = node.frame;
	const placed: VectorFrameGroup = x || y ? { ...rest, transform: [1, 0, 0, 1, -x, -y] } : rest;
	return {
		width,
		height,
		...(doc.background ? { background: doc.background } : {}),
		nodes: [placed],
		...(doc.symbols?.length ? { symbols: doc.symbols } : {})
	};
}

/** What the frame panel shows for the selection. */
export interface VectorFramePanel {
	/** The selected frame (the first, when several are), or null. */
	frame: { id: string; name: string; artboard: boolean; frame: VectorFrame } | null;
	/**
	 * The resizing constraints of the selected objects that sit directly in a frame (null when none
	 * does): each axis' value, or `mixed` when they differ.
	 */
	resizing: { ids: string[]; horizontal: VectorHorizontalResizing | 'mixed'; vertical: VectorVerticalResizing | 'mixed' } | null;
}

/** The frame panel's data for a selection. */
export function getVectorFramePanel(state: { document: Pick<VectorDocument, 'nodes'>; selection: readonly string[] }): VectorFramePanel {
	const parents = new Map<string, VectorNode | null>();
	const nodes = new Map<string, VectorNode>();
	const walk = (list: readonly VectorNode[], parent: VectorNode | null) => {
		for (const n of list) {
			parents.set(n.id, parent);
			nodes.set(n.id, n);
			if (n.type === 'group') walk(n.children, n);
		}
	};
	walk(state.document.nodes, null);
	const selected = state.selection.map((id) => nodes.get(id)).filter((n): n is VectorNode => !!n);
	const f = selected.find(isVectorFrame);
	const children = selected.filter((n) => isVectorFrame(parents.get(n.id)));
	const one = <T>(values: T[]): T | 'mixed' => (values.every((v) => v === values[0]) ? values[0] : 'mixed');
	return {
		frame: f ? { id: f.id, name: f.name ?? 'Frame', artboard: parents.get(f.id) === null, frame: f.frame } : null,
		resizing: children.length
			? { ids: children.map((c) => c.id), horizontal: one(children.map((c) => c.resizing?.horizontal ?? 'left')), vertical: one(children.map((c) => c.resizing?.vertical ?? 'top')) }
			: null
	};
}
