/**
 * A spatial index for hit-testing, marquee selection and snapping in large documents.
 *
 * After cadcraft's `crates/engine/src/spatial.rs` (MIT OR Apache-2.0, © ArtCraft Team and
 * contributors; see THIRD_PARTY_NOTICES.md): an R-tree over object bounds, built only above a
 * size where scanning costs more, reused while the content is the same (here: the same node array),
 * and rebuilt cheaply after an edit because each node's bounds are cached by node object, so only
 * the nodes an edit replaced are measured again (structural sharing). Queries return candidates in
 * draw order; callers then run exactly the same tests as a scan, so results are identical. The
 * tree itself is ours (sort-tile-recursive packing) since cadcraft uses the `rstar` crate.
 */

import type { VectorBounds, VectorNode } from './types.js';
import { vectorNodeLocalPaintBounds } from './svg.js';
import { applyMatrix } from '../geom/affine.js';
import type { AffineMatrix } from '../geom/types.js';

/** Node lists shorter than this are scanned directly (building an index costs more). */
export const VECTOR_SPATIAL_MIN = 256;
const FANOUT = 16;

interface Box {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

interface TreeNode extends Box {
	/** Leaves hold item indices, inner nodes children. */
	items?: number[];
	children?: TreeNode[];
}

const overlaps = (a: Box, b: Box) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

function enclose(list: readonly Box[]): Box {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const b of list) {
		minX = Math.min(minX, b.minX);
		minY = Math.min(minY, b.minY);
		maxX = Math.max(maxX, b.maxX);
		maxY = Math.max(maxY, b.maxY);
	}
	return { minX, minY, maxX, maxY };
}

/** A static R-tree over boxes, packed sort-tile-recursive (items with no box are always candidates). */
export class VectorRTree {
	private readonly root: TreeNode | null;
	private readonly always: number[];
	private readonly boxes: ReadonlyArray<Box | null>;

	constructor(boxes: ReadonlyArray<Box | null>) {
		this.boxes = boxes;
		const items: Array<Box & { i: number }> = [];
		this.always = [];
		boxes.forEach((b, i) => {
			if (!b) this.always.push(i);
			else items.push({ ...b, i });
		});
		this.root = items.length ? VectorRTree.pack(items) : null;
	}

	private static pack(items: Array<Box & { i: number }>): TreeNode {
		let level: TreeNode[] = [];
		const leaves = Math.ceil(items.length / FANOUT);
		const slices = Math.ceil(Math.sqrt(leaves));
		items.sort((a, b) => a.minX + a.maxX - (b.minX + b.maxX));
		const perSlice = Math.ceil(items.length / slices);
		for (let s = 0; s < items.length; s += perSlice) {
			const slice = items.slice(s, s + perSlice).sort((a, b) => a.minY + a.maxY - (b.minY + b.maxY));
			for (let k = 0; k < slice.length; k += FANOUT) {
				const chunk = slice.slice(k, k + FANOUT);
				level.push({ ...enclose(chunk), items: chunk.map((c) => c.i) });
			}
		}
		while (level.length > 1) {
			const next: TreeNode[] = [];
			level.sort((a, b) => a.minX + a.maxX - (b.minX + b.maxX));
			const n = Math.ceil(level.length / FANOUT);
			const sl = Math.ceil(Math.sqrt(n));
			const per = Math.ceil(level.length / sl);
			for (let s = 0; s < level.length; s += per) {
				const slice = level.slice(s, s + per).sort((a, b) => a.minY + a.maxY - (b.minY + b.maxY));
				for (let k = 0; k < slice.length; k += FANOUT) {
					const chunk = slice.slice(k, k + FANOUT);
					next.push({ ...enclose(chunk), children: chunk });
				}
			}
			level = next;
		}
		return level[0];
	}

	/** Indices of the items whose box meets `box` (and the unbounded ones), ascending. */
	search(box: Box): number[] {
		const out = [...this.always];
		const stack = this.root ? [this.root] : [];
		while (stack.length) {
			const n = stack.pop()!;
			if (!overlaps(n, box)) continue;
			if (n.items) {
				for (const i of n.items) if (overlaps(this.boxes[i]!, box)) out.push(i);
			} else stack.push(...n.children!);
		}
		return out.sort((a, b) => a - b);
	}
}

const boundsCache = new WeakMap<VectorNode, Box | null>();

/** A top-level node's paint box in its parent's space (strokes and filters' reach included), cached per node object. */
export function vectorNodePaintBox(node: VectorNode): Box | null {
	if (boundsCache.has(node)) return boundsCache.get(node)!;
	const local = vectorNodeLocalPaintBounds(node);
	let box: Box | null = null;
	if (local) {
		const m = (node.transform ?? [1, 0, 0, 1, 0, 0]) as AffineMatrix;
		const pts = [
			{ x: local.x, y: local.y },
			{ x: local.x + local.width, y: local.y },
			{ x: local.x, y: local.y + local.height },
			{ x: local.x + local.width, y: local.y + local.height }
		].map((p) => applyMatrix(m, p));
		box = { minX: Math.min(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxX: Math.max(...pts.map((p) => p.x)), maxY: Math.max(...pts.map((p) => p.y)) };
	}
	boundsCache.set(node, box);
	return box;
}

const indexCache = new WeakMap<readonly VectorNode[], VectorRTree>();

/**
 * The index over a node list (cached per array; null below `VECTOR_SPATIAL_MIN` nodes). Nodes
 * without bounds (empty groups, unresolved instances) are always candidates.
 */
export function vectorSpatialIndex(nodes: readonly VectorNode[]): VectorRTree | null {
	if (nodes.length < VECTOR_SPATIAL_MIN) return null;
	let hit = indexCache.get(nodes);
	if (!hit) {
		hit = new VectorRTree(nodes.map(vectorNodePaintBox));
		indexCache.set(nodes, hit);
	}
	return hit;
}

/**
 * Indices (ascending, draw order) of the nodes of `nodes` that may meet `rect` padded by `pad`
 * (document units): every index when the list is small enough to scan.
 */
export function vectorNodesNear(nodes: readonly VectorNode[], rect: VectorBounds, pad = 0): number[] {
	const index = vectorSpatialIndex(nodes);
	if (!index) return nodes.map((_, i) => i);
	return index.search({ minX: rect.x - pad, minY: rect.y - pad, maxX: rect.x + rect.width + pad, maxY: rect.y + rect.height + pad });
}
