import { boundsOf, estimateNodeSize } from './layout.js';
import type { CanvasNode, CanvasNodeStyle, Rect, XYPosition } from './types.js';

/**
 * Edge (or centre line) used by `alignNodes`.
 * `center` aligns horizontal centres (a vertical line); `middle` aligns vertical centres.
 */
export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

/** Axis used by `distributeNodes`. `both` distributes horizontally and vertically. */
export type DistributeAxis = 'horizontal' | 'vertical' | 'both';

/**
 * `gaps` leaves equal space between neighbouring nodes, `centres` spaces their centres equally.
 */
export type DistributeMode = 'gaps' | 'centres';

/** Dimension(s) copied by `matchSize`. */
export type SizeDimension = 'width' | 'height' | 'both';

/**
 * Partial node change produced by the arrange helpers. `position` is in the node's own
 * coordinate space (relative to its `parentId` parent when it has one).
 */
export interface CanvasNodeUpdate {
	id: string;
	position?: XYPosition;
	width?: number;
	height?: number;
	zIndex?: number;
}

export interface NodeRectOptions {
	/** Width used when a node has no measured, explicit or style size and estimation is off. */
	defaultWidth?: number;
	/** Height used when a node has no measured, explicit or style size and estimation is off. */
	defaultHeight?: number;
	/** Estimate unmeasured node sizes from their label via `estimateNodeSize` (default `true`). */
	estimate?: boolean;
}

/** Data key marking a node as locked. See `lockNodes`. */
export const LOCKED_DATA_KEY = 'locked';
/** Data key holding the interaction flags a node had before it was locked. */
export const LOCKED_PREVIOUS_FLAGS_KEY = 'lockedPrevious';

function parsePx(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const match = /^\s*(-?\d+(?:\.\d+)?)(px)?\s*$/i.exec(value);
		if (match) return Number(match[1]);
	}
	return undefined;
}

/**
 * Reads a pixel `width` / `height` from a node style, which may be a CSS string (SvelteFlow)
 * or a style object (React Flow). Non-pixel values (`%`, `auto`, ...) are ignored.
 */
export function readStyleSize(style: CanvasNodeStyle | undefined | null): {
	width?: number;
	height?: number;
} {
	if (!style) return {};
	if (typeof style === 'object') {
		return { width: parsePx(style.width), height: parsePx(style.height) };
	}
	const read = (prop: string) => {
		const match = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(style);
		return match ? parsePx(match[1]) : undefined;
	};
	return { width: read('width'), height: read('height') };
}

/**
 * Returns `style` with its pixel `width` / `height` replaced, keeping its representation
 * (string or object). Only dimensions already present in the style are rewritten, because
 * xyflow applies the node's own `width` / `height` props otherwise.
 */
export function withStyleSize(
	style: CanvasNodeStyle | undefined | null,
	size: { width?: number; height?: number }
): CanvasNodeStyle | undefined {
	if (!style) return style ?? undefined;
	if (typeof style === 'object') {
		const next: Record<string, any> = { ...style };
		if (size.width !== undefined && 'width' in next) next.width = size.width;
		if (size.height !== undefined && 'height' in next) next.height = size.height;
		return next;
	}
	let next = style;
	for (const prop of ['width', 'height'] as const) {
		const value = size[prop];
		if (value === undefined) continue;
		next = next.replace(
			new RegExp(`((?:^|;)\\s*${prop}\\s*:\\s*)[^;]+`, 'i'),
			`$1${value}px`
		);
	}
	return next;
}

/**
 * Resolves a node's size: measured DOM size, then explicit `width` / `height`, then a pixel
 * size in `style`, then a label-based estimate (or the defaults when `estimate` is `false`).
 */
export function getNodeSize(
	node: CanvasNode,
	options: NodeRectOptions = {}
): { width: number; height: number } {
	const styleSize = readStyleSize(node.style);
	let width = node.measured?.width ?? node.width ?? styleSize.width;
	let height = node.measured?.height ?? node.height ?? styleSize.height;
	if (width === undefined || height === undefined) {
		const fallback =
			options.estimate === false
				? { width: options.defaultWidth ?? 200, height: options.defaultHeight ?? 60 }
				: estimateNodeSize(node, options.defaultWidth, options.defaultHeight);
		width ??= fallback.width;
		height ??= fallback.height;
	}
	return { width, height };
}

/**
 * Absolute (flow-space) position of a node, following its `parentId` chain.
 * Cycles and missing parents are tolerated.
 */
export function getAbsolutePosition(
	node: CanvasNode,
	lookup: ReadonlyMap<string, CanvasNode>
): XYPosition {
	let x = node.position.x;
	let y = node.position.y;
	const seen = new Set<string>([node.id]);
	let parentId = node.parentId;
	while (parentId && !seen.has(parentId)) {
		const parent = lookup.get(parentId);
		if (!parent) break;
		seen.add(parentId);
		x += parent.position.x;
		y += parent.position.y;
		parentId = parent.parentId;
	}
	return { x, y };
}

/** Builds an id lookup for a node array. */
export function createNodeLookup<TNode extends CanvasNode>(nodes: TNode[]): Map<string, TNode> {
	return new Map(nodes.map((n) => [n.id, n]));
}

/** Absolute flow-space rectangle of a node. */
export function getNodeRect(
	node: CanvasNode,
	lookup?: ReadonlyMap<string, CanvasNode>,
	options?: NodeRectOptions
): Rect {
	const { x, y } = node.parentId && lookup ? getAbsolutePosition(node, lookup) : node.position;
	return { x, y, ...getNodeSize(node, options) };
}

/**
 * Whether a node has been locked with `lockNodes`.
 */
export function isLocked(node: CanvasNode | undefined | null): boolean {
	return node?.data?.[LOCKED_DATA_KEY] === true;
}

/**
 * Locks nodes: marks `data.locked = true` and sets `draggable: false` and `deletable: false`
 * so both SvelteFlow and React Flow stop dragging and deleting them. Nodes stay `selectable`
 * so they can be unlocked again. The previous flags are kept in `data.lockedPrevious` and
 * restored by `unlockNodes`. Returns a new array; untouched nodes keep their identity.
 */
export function lockNodes<TNode extends CanvasNode>(nodes: TNode[], ids: Iterable<string>): TNode[] {
	const idSet = new Set(ids);
	return nodes.map((node) => {
		if (!idSet.has(node.id) || isLocked(node)) return node;
		const previous: Record<string, boolean> = {};
		if (node.draggable !== undefined) previous.draggable = node.draggable;
		if (node.deletable !== undefined) previous.deletable = node.deletable;
		return {
			...node,
			draggable: false,
			deletable: false,
			data: { ...node.data, [LOCKED_DATA_KEY]: true, [LOCKED_PREVIOUS_FLAGS_KEY]: previous }
		};
	});
}

/**
 * Reverses `lockNodes`, restoring the `draggable` / `deletable` flags the node had before.
 */
export function unlockNodes<TNode extends CanvasNode>(nodes: TNode[], ids: Iterable<string>): TNode[] {
	const idSet = new Set(ids);
	return nodes.map((node) => {
		if (!idSet.has(node.id) || !isLocked(node)) return node;
		const {
			[LOCKED_DATA_KEY]: _locked,
			[LOCKED_PREVIOUS_FLAGS_KEY]: previous = {},
			...data
		} = node.data as Record<string, any>;
		const next = { ...node, data } as TNode;
		delete next.draggable;
		delete next.deletable;
		if (previous.draggable !== undefined) next.draggable = previous.draggable;
		if (previous.deletable !== undefined) next.deletable = previous.deletable;
		return next;
	});
}

/** Locks the given nodes if any of them is unlocked, otherwise unlocks them all. */
export function toggleLockNodes<TNode extends CanvasNode>(nodes: TNode[], ids: Iterable<string>): TNode[] {
	const idSet = new Set(ids);
	const anyUnlocked = nodes.some((n) => idSet.has(n.id) && !isLocked(n));
	return anyUnlocked ? lockNodes(nodes, idSet) : unlockNodes(nodes, idSet);
}

interface Item {
	node: CanvasNode;
	rect: Rect;
	locked: boolean;
}

function collect(nodes: CanvasNode[], ids: Iterable<string>, options?: NodeRectOptions) {
	const lookup = createNodeLookup(nodes);
	const items: Item[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		const node = lookup.get(id);
		if (!node || seen.has(id)) continue;
		seen.add(id);
		items.push({ node, rect: getNodeRect(node, lookup, options), locked: isLocked(node) });
	}
	return { lookup, items };
}

/**
 * Converts absolute target positions into node-relative `position` updates. When a parent
 * moves in the same operation, children are made relative to the parent's new position.
 */
function toPositionUpdates(
	lookup: Map<string, CanvasNode>,
	targets: Map<string, XYPosition>
): CanvasNodeUpdate[] {
	const updates: CanvasNodeUpdate[] = [];
	for (const [id, abs] of targets) {
		const node = lookup.get(id)!;
		let position = abs;
		if (node.parentId && lookup.has(node.parentId)) {
			const parent = lookup.get(node.parentId)!;
			const parentAbs = targets.get(parent.id) ?? getAbsolutePosition(parent, lookup);
			position = { x: abs.x - parentAbs.x, y: abs.y - parentAbs.y };
		}
		if (position.x !== node.position.x || position.y !== node.position.y) {
			updates.push({ id, position });
		}
	}
	return updates;
}

export interface AlignNodesOptions extends NodeRectOptions {
	/**
	 * What to align to: the selection bounding box (default) or a fixed rectangle.
	 * Locked nodes never move but still count towards the selection bounds, so they act as anchors.
	 */
	to?: 'selection' | Rect;
}

/**
 * Aligns nodes to a shared edge or centre line of their bounding box (Freeform's
 * Align Left / Center / Right / Top / Middle / Bottom). Needs at least two nodes unless
 * `options.to` is a rectangle. Locked nodes are not moved.
 */
export function alignNodes(
	nodes: CanvasNode[],
	ids: Iterable<string>,
	edge: AlignEdge,
	options: AlignNodesOptions = {}
): CanvasNodeUpdate[] {
	const { lookup, items } = collect(nodes, ids, options);
	const fixed = typeof options.to === 'object' ? options.to : null;
	if (items.length === 0 || (!fixed && items.length < 2)) return [];
	const bounds = fixed ?? boundsOf(items.map((i) => i.rect))!;

	const targets = new Map<string, XYPosition>();
	for (const { node, rect, locked } of items) {
		if (locked) continue;
		let { x, y } = rect;
		switch (edge) {
			case 'left':
				x = bounds.x;
				break;
			case 'center':
				x = bounds.x + bounds.width / 2 - rect.width / 2;
				break;
			case 'right':
				x = bounds.x + bounds.width - rect.width;
				break;
			case 'top':
				y = bounds.y;
				break;
			case 'middle':
				y = bounds.y + bounds.height / 2 - rect.height / 2;
				break;
			case 'bottom':
				y = bounds.y + bounds.height - rect.height;
				break;
		}
		targets.set(node.id, { x, y });
	}
	return toPositionUpdates(lookup, targets);
}

export interface DistributeNodesOptions extends NodeRectOptions {
	/** Explicit gap between neighbours for `gaps` mode. Default: spread evenly between the outer nodes. */
	gap?: number;
}

function distributeAxis(
	items: Item[],
	horizontal: boolean,
	mode: DistributeMode,
	gapOverride: number | undefined,
	targets: Map<string, XYPosition>
) {
	const start = (r: Rect) => (horizontal ? r.x : r.y);
	const size = (r: Rect) => (horizontal ? r.width : r.height);
	const sorted = [...items].sort(
		(a, b) => start(a.rect) + size(a.rect) / 2 - (start(b.rect) + size(b.rect) / 2)
	);
	const first = sorted[0].rect;
	const last = sorted[sorted.length - 1].rect;
	const n = sorted.length;
	const set = (item: Item, value: number) => {
		if (item.locked) return;
		const current = targets.get(item.node.id) ?? { x: item.rect.x, y: item.rect.y };
		targets.set(item.node.id, horizontal ? { ...current, x: value } : { ...current, y: value });
	};

	if (mode === 'centres') {
		const c0 = start(first) + size(first) / 2;
		const c1 = start(last) + size(last) / 2;
		const step = (c1 - c0) / (n - 1);
		sorted.forEach((item, i) => set(item, c0 + step * i - size(item.rect) / 2));
		return;
	}

	const span = start(last) + size(last) - start(first);
	const total = sorted.reduce((sum, item) => sum + size(item.rect), 0);
	const gap = gapOverride ?? (span - total) / (n - 1);
	let cursor = start(first);
	for (const item of sorted) {
		set(item, cursor);
		cursor += size(item.rect) + gap;
	}
}

/**
 * Distributes nodes along an axis (Freeform's Distribute Horizontally / Vertically / Evenly).
 * The outermost nodes stay put and the others are spaced with equal gaps (`gaps`, default)
 * or equally spaced centres (`centres`). Needs at least three nodes (two with an explicit
 * `gap`). Locked nodes keep their place in the order but are not moved.
 */
export function distributeNodes(
	nodes: CanvasNode[],
	ids: Iterable<string>,
	axis: DistributeAxis,
	mode: DistributeMode = 'gaps',
	options: DistributeNodesOptions = {}
): CanvasNodeUpdate[] {
	const { lookup, items } = collect(nodes, ids, options);
	const minimum = options.gap !== undefined && mode === 'gaps' ? 2 : 3;
	if (items.length < minimum) return [];
	const targets = new Map<string, XYPosition>();
	if (axis !== 'vertical') distributeAxis(items, true, mode, options.gap, targets);
	if (axis !== 'horizontal') distributeAxis(items, false, mode, options.gap, targets);
	return toPositionUpdates(lookup, targets);
}

export interface MatchSizeOptions extends NodeRectOptions {
	/**
	 * Size source: the `largest` (default) or `smallest` node, the `first` id given,
	 * or a specific node id.
	 */
	reference?: 'largest' | 'smallest' | 'first' | { id: string };
	/** Keep each node's centre in place instead of its top-left corner (default `false`). */
	keepCentre?: boolean;
}

/**
 * Makes nodes the same width, height or both (Freeform's Make Same Size). Returns size
 * updates (plus position updates with `keepCentre`). Locked nodes are not resized but can
 * be the reference.
 */
export function matchSize(
	nodes: CanvasNode[],
	ids: Iterable<string>,
	dimension: SizeDimension,
	options: MatchSizeOptions = {}
): CanvasNodeUpdate[] {
	const { items } = collect(nodes, ids, options);
	if (items.length < 2) return [];
	const reference = options.reference ?? 'largest';

	const pick = (dim: 'width' | 'height'): number => {
		if (typeof reference === 'object') {
			const item = items.find((i) => i.node.id === reference.id);
			if (item) return item.rect[dim];
		}
		if (reference === 'first') return items[0].rect[dim];
		const values = items.map((i) => i.rect[dim]);
		return reference === 'smallest' ? Math.min(...values) : Math.max(...values);
	};
	const width = dimension !== 'height' ? pick('width') : undefined;
	const height = dimension !== 'width' ? pick('height') : undefined;

	const updates: CanvasNodeUpdate[] = [];
	for (const { node, rect, locked } of items) {
		if (locked) continue;
		const update: CanvasNodeUpdate = { id: node.id };
		if (width !== undefined && width !== rect.width) update.width = width;
		if (height !== undefined && height !== rect.height) update.height = height;
		if (update.width === undefined && update.height === undefined) continue;
		if (options.keepCentre) {
			update.position = {
				x: node.position.x - ((update.width ?? rect.width) - rect.width) / 2,
				y: node.position.y - ((update.height ?? rect.height) - rect.height) / 2
			};
		}
		updates.push(update);
	}
	return updates;
}

/** Z-order operation. */
export type ZOrderOperation = 'bringForward' | 'sendBackward' | 'bringToFront' | 'sendToBack';

/**
 * Restacks nodes (Bring Forward / Send Backward / Bring to Front / Send to Back).
 *
 * Both SvelteFlow and React Flow stack nodes by `zIndex` (missing = 0) and, for equal
 * `zIndex`, by array order. This computes that effective order for the siblings that share
 * the targets' parent, applies the operation, and returns `zIndex` updates assigning each
 * sibling its new rank. The array order is left alone, because xyflow requires parents to
 * precede their children. Locked nodes are not restacked. "Forward" moves past the next
 * sibling the node overlaps, falling back to the next sibling when nothing overlaps.
 */
export function reorderNodes(
	nodes: CanvasNode[],
	ids: Iterable<string>,
	operation: ZOrderOperation,
	options: NodeRectOptions = {}
): CanvasNodeUpdate[] {
	const lookup = createNodeLookup(nodes);
	const targetIds = new Set(
		[...ids].filter((id) => lookup.has(id) && !isLocked(lookup.get(id)))
	);
	if (targetIds.size === 0) return [];

	// Restack each sibling group (nodes sharing a parent) independently.
	const groups = new Map<string, CanvasNode[]>();
	for (const node of nodes) {
		const key = node.parentId ?? '';
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(node);
	}

	const updates: CanvasNodeUpdate[] = [];
	for (const siblings of groups.values()) {
		if (!siblings.some((n) => targetIds.has(n.id))) continue;
		const order = siblings
			.map((node, index) => ({ node, index, z: typeof node.zIndex === 'number' ? node.zIndex : 0 }))
			.sort((a, b) => a.z - b.z || a.index - b.index)
			.map((entry) => entry.node);
		const isTarget = (n: CanvasNode) => targetIds.has(n.id);
		let next: CanvasNode[];

		if (operation === 'bringToFront') {
			next = [...order.filter((n) => !isTarget(n)), ...order.filter(isTarget)];
		} else if (operation === 'sendToBack') {
			next = [...order.filter(isTarget), ...order.filter((n) => !isTarget(n))];
		} else {
			next = [...order];
			const forward = operation === 'bringForward';
			const rects = new Map(next.map((n) => [n.id, getNodeRect(n, lookup, options)]));
			const intersects = (a: Rect, b: Rect) =>
				a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
			// Walk from the end we are moving towards so adjacent targets keep their relative order.
			const indices = next.map((_, i) => i);
			if (forward) indices.reverse();
			for (const i of indices) {
				const node = next[i];
				if (!isTarget(node)) continue;
				const step = forward ? 1 : -1;
				let j = i + step;
				let swapWith = -1;
				let firstNonTarget = -1;
				while (j >= 0 && j < next.length) {
					if (!isTarget(next[j])) {
						if (firstNonTarget === -1) firstNonTarget = j;
						if (intersects(rects.get(node.id)!, rects.get(next[j].id)!)) {
							swapWith = j;
							break;
						}
					}
					j += step;
				}
				if (swapWith === -1) swapWith = firstNonTarget;
				if (swapWith === -1) continue;
				next.splice(i, 1);
				next.splice(swapWith, 0, node);
			}
		}

		if (next.every((node, i) => node === order[i])) continue;
		next.forEach((node, rank) => {
			const current = typeof node.zIndex === 'number' ? node.zIndex : 0;
			if (current !== rank) updates.push({ id: node.id, zIndex: rank });
		});
	}
	return updates;
}

/**
 * Applies `CanvasNodeUpdate`s to a node array, returning a new array. Unchanged nodes keep
 * their identity. Size updates set `width` / `height` and rewrite pixel sizes already present
 * in `style` (string or object). An existing `measured` size is updated too, so geometry
 * helpers see the new size before xyflow re-measures the node.
 */
export function applyNodeUpdates<TNode extends CanvasNode>(
	nodes: TNode[],
	updates: CanvasNodeUpdate[]
): TNode[] {
	if (updates.length === 0) return nodes;
	const byId = new Map<string, CanvasNodeUpdate>();
	for (const update of updates) {
		byId.set(update.id, { ...byId.get(update.id), ...update });
	}
	return nodes.map((node) => {
		const update = byId.get(node.id);
		if (!update) return node;
		const next = { ...node } as TNode;
		if (update.position) next.position = { ...update.position };
		if (update.zIndex !== undefined) (next as CanvasNode).zIndex = update.zIndex;
		if (update.width !== undefined || update.height !== undefined) {
			if (update.width !== undefined) next.width = update.width;
			if (update.height !== undefined) next.height = update.height;
			if (node.style) next.style = withStyleSize(node.style, update);
			if (node.measured) {
				next.measured = {
					...node.measured,
					...(update.width !== undefined ? { width: update.width } : {}),
					...(update.height !== undefined ? { height: update.height } : {})
				};
			}
		}
		return next;
	});
}

/**
 * Inverse of a set of updates against the current nodes, for undo. Restores the previous
 * position / size / zIndex of every node an update touches.
 */
export function invertNodeUpdates(
	nodes: CanvasNode[],
	updates: CanvasNodeUpdate[]
): CanvasNodeUpdate[] {
	const lookup = createNodeLookup(nodes);
	const inverse: CanvasNodeUpdate[] = [];
	for (const update of updates) {
		const node = lookup.get(update.id);
		if (!node) continue;
		const back: CanvasNodeUpdate = { id: node.id };
		if (update.position) back.position = { ...node.position };
		if (update.zIndex !== undefined) back.zIndex = typeof node.zIndex === 'number' ? node.zIndex : 0;
		if (update.width !== undefined || update.height !== undefined) {
			const size = getNodeSize(node);
			if (update.width !== undefined) back.width = size.width;
			if (update.height !== undefined) back.height = size.height;
		}
		inverse.push(back);
	}
	return inverse;
}
