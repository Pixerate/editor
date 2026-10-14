import type { Command } from '../history/types.js';
import {
	alignNodes,
	applyNodeUpdates,
	distributeNodes,
	invertNodeUpdates,
	isLocked,
	lockNodes,
	matchSize,
	reorderNodes,
	unlockNodes,
	type AlignEdge,
	type AlignNodesOptions,
	type CanvasNodeUpdate,
	type DistributeAxis,
	type DistributeMode,
	type DistributeNodesOptions,
	type MatchSizeOptions,
	type NodeRectOptions,
	type SizeDimension,
	type ZOrderOperation
} from './arrange.js';
import type { CanvasArrangeAction } from './arrangeShortcuts.js';
import {
	applyShapeCombination,
	canCombineShapeNodes,
	combineShapeNodes,
	revertShapeCombination,
	type CombineShapeNodesOptions,
	type CombineShapeNodesResult,
	type ShapeOperation
} from './shapeNodes.js';
import {
	createNodeGuideIndex,
	snapNodeDrag,
	type GuideIndex,
	type GuideLine,
	type SnapGuidesOptions,
	type SnapNodeDragResult
} from './guides.js';
import {
	getResizingNodeRect,
	inferResizeHandle,
	snapNodeResize,
	type ResizeHandle,
	type SnapNodeResizeResult
} from './resizeSnap.js';
import { createNodeLookup } from './arrange.js';
import type { CanvasNode, Rect, XYPosition } from './types.js';

/** Minimal history surface (`HistoryManager` satisfies it). */
export interface ArrangeHistoryTarget {
	execute(command: Command): void;
}

export interface CanvasArrangeControllerOptions<TNode extends CanvasNode = CanvasNode> {
	getNodes: () => TNode[];
	setNodes: (nodes: TNode[]) => void;
	/** Ids acted on when a method is called without ids (default: nodes with `selected: true`). */
	getSelectedIds?: () => string[];
	/** When set, every arrange action is recorded as one undoable command. */
	history?: ArrangeHistoryTarget;
	/** Current zoom, used to convert the guide threshold from screen pixels (default 1). */
	getZoom?: () => number;
	/** Smart-guide options (threshold in screen px, edges / centres / spacing toggles). */
	guides?: Omit<SnapGuidesOptions, 'zoom'>;
	/** Turns drag snapping off while keeping the arrange actions (default `true`). */
	snapping?: boolean;
	/** Turns resize snapping off (default: follows `snapping`). */
	resizeSnapping?: boolean;
	/** Resize options passed to `snapResize` (`keepAspectRatio`, `minWidth`, `minHeight`). */
	resize?: { keepAspectRatio?: boolean; minWidth?: number; minHeight?: number };
	/** Size resolution for unmeasured nodes. */
	rectOptions?: NodeRectOptions;
	/** Called whenever the guide segments change (set while dragging, cleared on drop). */
	onGuidesChange?: (guides: GuideLine[]) => void;
}

/**
 * A React Flow / SvelteFlow style node change; only `position` changes are inspected.
 * `id` is optional because a batch can contain changes without one (React Flow's
 * `add` change carries an `item` instead), so `NodeChange[]` must be accepted as is.
 */
export interface PositionChangeLike {
	type: string;
	id?: string;
	position?: XYPosition;
	dragging?: boolean;
	[key: string]: any;
}

/**
 * Framework-agnostic arrange controller shared by the Svelte rune and the React hook:
 * align / distribute / match size / lock / z-order actions on the selection (optionally
 * undoable through a `HistoryManager`) and smart-guide snapping during drags.
 */
export function createCanvasArrangeController<TNode extends CanvasNode = CanvasNode>(
	options: CanvasArrangeControllerOptions<TNode>
) {
	let guides: GuideLine[] = [];
	let dragIndex: GuideIndex | null = null;
	let dragKey = '';
	// Snapped positions from the last dragging batch, re-applied to the drag-stop change.
	let lastSnapped = new Map<string, XYPosition>();
	// Resize snapping: the node, its box when the resize started, cached targets and the
	// last snapped box (absolute) re-applied when the flow writes the raw end size.
	let resizeId: string | null = null;
	let resizeStart: Rect | null = null;
	let resizeIndex: GuideIndex | null = null;
	let lastResized: SnapNodeResizeResult | null = null;

	const selectedIds = (ids?: Iterable<string>) =>
		ids ? [...ids] : options.getSelectedIds?.() ?? options.getNodes().filter((n) => n.selected).map((n) => n.id);

	const setGuides = (next: GuideLine[]) => {
		if (next.length === 0 && guides.length === 0) return;
		guides = next;
		options.onGuidesChange?.(guides);
	};

	/** Applies updates as one (optionally undoable) step. Returns the updates. */
	function apply(name: string, updates: CanvasNodeUpdate[]): CanvasNodeUpdate[] {
		if (updates.length === 0) return updates;
		const inverse = invertNodeUpdates(options.getNodes(), updates);
		const run = (u: CanvasNodeUpdate[]) => options.setNodes(applyNodeUpdates(options.getNodes(), u));
		if (options.history) {
			options.history.execute({ name, execute: () => run(updates), undo: () => run(inverse) });
		} else {
			run(updates);
		}
		return updates;
	}

	function setLocked(name: string, ids: string[], locked: boolean): string[] {
		const nodes = options.getNodes();
		const set = new Set(ids);
		const changed = nodes.filter((n) => set.has(n.id) && isLocked(n) !== locked).map((n) => n.id);
		if (changed.length === 0) return changed;
		const lock = () => options.setNodes(lockNodes(options.getNodes(), changed));
		const unlock = () => options.setNodes(unlockNodes(options.getNodes(), changed));
		if (options.history) {
			options.history.execute({ name, execute: locked ? lock : unlock, undo: locked ? unlock : lock });
		} else if (locked) lock();
		else unlock();
		return changed;
	}

	const rect = () => options.rectOptions ?? {};

	const controller = {
		get guides() {
			return guides;
		},
		apply,
		align(edge: AlignEdge, ids?: Iterable<string>, alignOptions: AlignNodesOptions = {}) {
			return apply(`Align ${edge}`, alignNodes(options.getNodes(), selectedIds(ids), edge, { ...rect(), ...alignOptions }));
		},
		distribute(
			axis: DistributeAxis,
			mode: DistributeMode = 'gaps',
			ids?: Iterable<string>,
			distributeOptions: DistributeNodesOptions = {}
		) {
			return apply(
				`Distribute ${axis}`,
				distributeNodes(options.getNodes(), selectedIds(ids), axis, mode, { ...rect(), ...distributeOptions })
			);
		},
		matchSize(dimension: SizeDimension, ids?: Iterable<string>, sizeOptions: MatchSizeOptions = {}) {
			return apply(
				'Make Same Size',
				matchSize(options.getNodes(), selectedIds(ids), dimension, { ...rect(), ...sizeOptions })
			);
		},
		reorder(operation: ZOrderOperation, ids?: Iterable<string>) {
			return apply(operation, reorderNodes(options.getNodes(), selectedIds(ids), operation, rect()));
		},
		bringForward: (ids?: Iterable<string>) => controller.reorder('bringForward', ids),
		sendBackward: (ids?: Iterable<string>) => controller.reorder('sendBackward', ids),
		bringToFront: (ids?: Iterable<string>) => controller.reorder('bringToFront', ids),
		sendToBack: (ids?: Iterable<string>) => controller.reorder('sendToBack', ids),
		lock: (ids?: Iterable<string>) => setLocked('Lock', selectedIds(ids), true),
		unlock: (ids?: Iterable<string>) => setLocked('Unlock', selectedIds(ids), false),
		toggleLock(ids?: Iterable<string>) {
			const list = selectedIds(ids);
			const set = new Set(list);
			const anyUnlocked = options.getNodes().some((n) => set.has(n.id) && !isLocked(n));
			return anyUnlocked ? controller.lock(list) : controller.unlock(list);
		},
		isLocked: (id: string) => isLocked(options.getNodes().find((n) => n.id === id)),

		/**
		 * Freeform shape operation (Unite / Intersect / Subtract / Exclude / Divide) on the
		 * shape nodes among `ids` (default: the selection). Replaces them with the result as
		 * one undoable step. Refuses without changing anything when a selected shape is
		 * locked, fewer than two shapes are selected, or the result is empty.
		 */
		combineShapes(
			operation: ShapeOperation,
			ids?: Iterable<string>,
			combineOptions: CombineShapeNodesOptions = {}
		): CombineShapeNodesResult<TNode> {
			const before = options.getNodes();
			const result = combineShapeNodes(before, selectedIds(ids), operation, { ...rect(), ...combineOptions });
			if (!result.ok) return result;
			const name = `${operation[0].toUpperCase()}${operation.slice(1)} Shapes`;
			const run = () => options.setNodes(applyShapeCombination(options.getNodes(), result));
			const undo = () => options.setNodes(revertShapeCombination(options.getNodes(), result, before));
			if (options.history) options.history.execute({ name, execute: run, undo });
			else run();
			return result;
		},
		unite: (ids?: Iterable<string>, o?: CombineShapeNodesOptions) => controller.combineShapes('unite', ids, o),
		intersect: (ids?: Iterable<string>, o?: CombineShapeNodesOptions) => controller.combineShapes('intersect', ids, o),
		subtract: (ids?: Iterable<string>, o?: CombineShapeNodesOptions) => controller.combineShapes('subtract', ids, o),
		exclude: (ids?: Iterable<string>, o?: CombineShapeNodesOptions) => controller.combineShapes('exclude', ids, o),
		divide: (ids?: Iterable<string>, o?: CombineShapeNodesOptions) => controller.combineShapes('divide', ids, o),
		/** Whether the shape operations can run on `ids` (default: the selection). */
		canCombineShapes: (ids?: Iterable<string>) => canCombineShapeNodes(options.getNodes(), selectedIds(ids)).ok,

		/**
		 * Runs a shortcut action. Scene actions are not handled here (see the scenes store);
		 * returns `false` for them and for unknown actions.
		 */
		runAction(action: CanvasArrangeAction): boolean {
			switch (action) {
				case 'alignLeft': controller.align('left'); return true;
				case 'alignCenter': controller.align('center'); return true;
				case 'alignRight': controller.align('right'); return true;
				case 'alignTop': controller.align('top'); return true;
				case 'alignMiddle': controller.align('middle'); return true;
				case 'alignBottom': controller.align('bottom'); return true;
				case 'distributeHorizontal': controller.distribute('horizontal'); return true;
				case 'distributeVertical': controller.distribute('vertical'); return true;
				case 'lock': controller.lock(); return true;
				case 'unlock': controller.unlock(); return true;
				case 'bringForward': controller.bringForward(); return true;
				case 'sendBackward': controller.sendBackward(); return true;
				case 'bringToFront': controller.bringToFront(); return true;
				case 'sendToBack': controller.sendToBack(); return true;
				default: return false;
			}
		},

		/** Caches the snap targets for a drag. Optional: `drag` builds them lazily. */
		beginDrag(ids?: Iterable<string>) {
			const list = selectedIds(ids);
			dragKey = list.slice().sort().join('\u0000');
			dragIndex = createNodeGuideIndex(options.getNodes(), list, rect());
		},

		/**
		 * Snaps the dragged nodes (as currently positioned in `getNodes()`) to the other
		 * nodes, writes the snapped positions back through `setNodes` (not recorded in
		 * history) and updates `guides`.
		 */
		drag(ids?: Iterable<string>): SnapNodeDragResult | null {
			if (options.snapping === false) return null;
			const list = selectedIds(ids);
			const key = list.slice().sort().join('\u0000');
			if (!dragIndex || key !== dragKey) controller.beginDrag(list);
			const result = snapNodeDrag(options.getNodes(), list, {
				...rect(),
				...options.guides,
				zoom: options.getZoom?.() ?? 1,
				index: dragIndex!
			});
			lastSnapped = new Map();
			if (result.updates.length > 0) {
				options.setNodes(applyNodeUpdates(options.getNodes(), result.updates));
				for (const u of result.updates) if (u.position) lastSnapped.set(u.id, u.position);
			}
			setGuides(result.guides);
			return result;
		},

		/**
		 * React Flow style: adjusts dragging `position` changes in an `onNodesChange` batch so
		 * the dragged nodes snap, and updates `guides`. Returns the (possibly new) changes array.
		 * A batch without a dragging position change ends the drag and clears the guides.
		 */
		snapPositionChanges<TChange extends PositionChangeLike>(changes: TChange[]): TChange[] {
			const dragging = changes.filter(
				(c): c is TChange & { id: string; position: XYPosition } =>
					c.type === 'position' && typeof c.id === 'string' && !!c.position && !!c.dragging
			);
			if (dragging.length === 0) {
				if (!changes.some((c) => c.type === 'position' && c.dragging === false)) return changes;
				// React Flow's drag-stop change carries the raw pointer position, which would
				// undo the snap of the last frame; keep the snapped position instead.
				const snapped = lastSnapped;
				lastSnapped = new Map(); // applied to the changes below, not by endDrag
				controller.endDrag();
				const keep = (c: TChange) =>
					c.type === 'position' && c.dragging === false && !!c.position && c.id !== undefined && snapped.has(c.id);
				if (!changes.some(keep)) return changes;
				return changes.map((c) => (keep(c) ? { ...c, position: snapped.get(c.id!)! } : c));
			}
			if (options.snapping === false) return changes;
			const ids = dragging.map((c) => c.id);
			const key = ids.slice().sort().join('\u0000');
			if (!dragIndex || key !== dragKey) controller.beginDrag(ids);
			const proposed = new Map(dragging.map((c) => [c.id, c.position]));
			const nodes = options.getNodes().map((n) => (proposed.has(n.id) ? { ...n, position: proposed.get(n.id)! } : n));
			const result = snapNodeDrag(nodes, ids, {
				...rect(),
				...options.guides,
				zoom: options.getZoom?.() ?? 1,
				index: dragIndex!
			});
			setGuides(result.guides);
			const { x: dx, y: dy } = result.offset;
			lastSnapped = new Map();
			if (dx === 0 && dy === 0) return changes;
			// Children of a dragged parent move with it; only shift top-level dragged nodes.
			const parents = new Map(nodes.map((n) => [n.id, n.parentId]));
			const shift = new Set(ids.filter((id) => !proposed.has(parents.get(id) ?? '')));
			return changes.map((c) => {
				if (!(c.type === 'position' && c.position && c.dragging && c.id !== undefined && shift.has(c.id))) return c;
				const position = { x: c.position.x + dx, y: c.position.y + dy };
				lastSnapped.set(c.id, position);
				return { ...c, position };
			});
		},

		/**
		 * Starts resize snapping for node `id`: records its box (to tell which handle is
		 * dragged) and caches the snap targets. Optional: `resize` starts lazily.
		 */
		beginResize(id: string) {
			const nodes = options.getNodes();
			const lookup = createNodeLookup(nodes);
			const node = lookup.get(id);
			resizeId = id;
			resizeStart = node ? getResizingNodeRect(node, lookup, rect()) : null;
			resizeIndex = createNodeGuideIndex(nodes, [id], rect());
			lastResized = null;
		},

		/**
		 * Snaps node `id` as currently sized in `getNodes()` (call it after the flow wrote the
		 * new size, e.g. SvelteFlow's `NodeResizer` `onResize`, deferred by a microtask) and
		 * writes the snapped box back through `setNodes` (not recorded in history). `handle`
		 * defaults to the one inferred from the edges that moved since `beginResize`. A locked
		 * node is restored to its starting box.
		 */
		resize(id: string, handle?: ResizeHandle): SnapNodeResizeResult | null {
			if (resizeId !== id) controller.beginResize(id);
			const nodes = options.getNodes();
			const lookup = createNodeLookup(nodes);
			const node = lookup.get(id);
			if (!node || !resizeStart) return null;
			const proposed = getResizingNodeRect(node, lookup, rect());
			if (isLocked(node)) {
				const start = resizeStart;
				const parent = node.parentId ? lookup.get(node.parentId) : undefined;
				const origin = parent ? getResizingNodeRect(parent, lookup, rect()) : { x: 0, y: 0 };
				if (proposed.x !== start.x || proposed.y !== start.y || proposed.width !== start.width || proposed.height !== start.height) {
					options.setNodes(
						applyNodeUpdates(nodes, [
							{ id, position: { x: start.x - origin.x, y: start.y - origin.y }, width: start.width, height: start.height }
						])
					);
				}
				return null;
			}
			if ((options.resizeSnapping ?? options.snapping) === false) return null;
			const h = handle ?? inferResizeHandle(resizeStart, proposed);
			if (!h) {
				setGuides([]);
				return null;
			}
			const result = snapNodeResize(nodes, id, proposed, h, {
				...rect(),
				...options.guides,
				...options.resize,
				zoom: options.getZoom?.() ?? 1,
				index: resizeIndex!
			});
			lastResized = result.updates.length > 0 ? result : null;
			if (result.updates.length > 0) options.setNodes(applyNodeUpdates(nodes, result.updates));
			setGuides(result.guides);
			return result;
		},

		/**
		 * Ends resize snapping: clears guides and re-applies the last snapped box if the flow
		 * wrote the raw pointer size afterwards.
		 */
		endResize() {
			const last = lastResized;
			resizeId = null;
			resizeStart = null;
			resizeIndex = null;
			lastResized = null;
			setGuides([]);
			const update = last?.updates[0];
			if (!update) return;
			const node = options.getNodes().find((n) => n.id === update.id);
			if (!node) return;
			const drift =
				node.position.x !== update.position!.x ||
				node.position.y !== update.position!.y ||
				node.width !== update.width ||
				node.height !== update.height;
			if (drift) options.setNodes(applyNodeUpdates(options.getNodes(), [update]));
		},

		/**
		 * React Flow style: snaps the `dimensions` (and matching `position`) changes a
		 * `NodeResizer` emits in an `onNodesChange` batch and updates `guides`. The resize-end
		 * change (`resizing: false`) carries the raw pointer size, so the last snapped size is
		 * kept. Resize changes of locked nodes are dropped. Returns the (possibly new) changes.
		 */
		snapResizeChanges<TChange extends PositionChangeLike>(changes: TChange[]): TChange[] {
			const dims = changes.find(
				(c) => c.type === 'dimensions' && typeof c.id === 'string' && !!c.dimensions && typeof c.resizing === 'boolean'
			);
			if (!dims) return changes;
			const id = dims.id as string;
			const nodes = options.getNodes();
			const lookup = createNodeLookup(nodes);
			const node = lookup.get(id);
			const isResizeChange = (c: TChange) => c.id === id && (c.type === 'dimensions' || c.type === 'position');
			if (node && isLocked(node)) {
				if (dims.resizing === false) controller.endResize();
				return changes.filter((c) => !isResizeChange(c));
			}
			if (dims.resizing === false) {
				const last = lastResized?.updates[0];
				lastResized = null; // applied to the change below, not by endResize
				controller.endResize();
				if (!last || last.id !== id) return changes;
				return changes.map((c) =>
					c === dims ? { ...c, dimensions: { width: last.width!, height: last.height! } } : c
				);
			}
			if (!node || (options.resizeSnapping ?? options.snapping) === false) return changes;
			if (resizeId !== id) controller.beginResize(id);
			if (!resizeStart) return changes;
			const posChange = changes.find((c) => c.id === id && c.type === 'position' && !!c.position);
			const parent = node.parentId ? lookup.get(node.parentId) : undefined;
			const origin = parent ? getResizingNodeRect(parent, lookup, rect()) : { x: 0, y: 0 };
			const position = posChange?.position ?? node.position;
			const proposed: Rect = {
				x: position.x + origin.x,
				y: position.y + origin.y,
				width: dims.dimensions.width,
				height: dims.dimensions.height
			};
			const handle = inferResizeHandle(resizeStart, proposed);
			if (!handle) {
				setGuides([]);
				return changes;
			}
			const result = snapNodeResize(nodes, id, proposed, handle, {
				...rect(),
				...options.guides,
				...options.resize,
				zoom: options.getZoom?.() ?? 1,
				index: resizeIndex!
			});
			setGuides(result.guides);
			const update = result.updates[0];
			lastResized = update ? result : null;
			if (!update) return changes;
			const next = changes.map((c) => {
				if (c === dims) return { ...c, dimensions: { width: update.width!, height: update.height! } };
				if (c === posChange) return { ...c, position: update.position! };
				return c;
			});
			if (!posChange && (update.position!.x !== node.position.x || update.position!.y !== node.position.y)) {
				next.push({ id, type: 'position', position: update.position! } as unknown as TChange);
			}
			return next;
		},

		/**
		 * Clears guides and the cached snap targets. Call it from the flow's drag-stop
		 * handler: flow libraries write the raw pointer position when a drag ends, so the
		 * last snapped positions from `drag` are written back here.
		 */
		endDrag() {
			const snapped = lastSnapped;
			dragIndex = null;
			dragKey = '';
			lastSnapped = new Map();
			setGuides([]);
			if (snapped.size === 0) return;
			const nodes = options.getNodes();
			const drift = nodes.some((n) => {
				const p = snapped.get(n.id);
				return !!p && (n.position.x !== p.x || n.position.y !== p.y);
			});
			if (drift) {
				options.setNodes(applyNodeUpdates(nodes, [...snapped].map(([id, position]) => ({ id, position }))));
			}
		}
	};
	return controller;
}

export type CanvasArrangeController<TNode extends CanvasNode = CanvasNode> = ReturnType<
	typeof createCanvasArrangeController<TNode>
>;
