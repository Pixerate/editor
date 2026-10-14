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
	createNodeGuideIndex,
	snapNodeDrag,
	type GuideIndex,
	type GuideLine,
	type SnapGuidesOptions,
	type SnapNodeDragResult
} from './guides.js';
import type { CanvasNode, XYPosition } from './types.js';

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
	/** Size resolution for unmeasured nodes. */
	rectOptions?: NodeRectOptions;
	/** Called whenever the guide segments change (set while dragging, cleared on drop). */
	onGuidesChange?: (guides: GuideLine[]) => void;
}

/** A React Flow / SvelteFlow style node change; only `position` changes are inspected. */
export interface PositionChangeLike {
	type: string;
	id: string;
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
			if (result.updates.length > 0) {
				options.setNodes(applyNodeUpdates(options.getNodes(), result.updates));
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
			const dragging = changes.filter((c) => c.type === 'position' && c.position && c.dragging);
			if (dragging.length === 0) {
				if (changes.some((c) => c.type === 'position' && c.dragging === false)) controller.endDrag();
				return changes;
			}
			if (options.snapping === false) return changes;
			const ids = dragging.map((c) => c.id);
			const key = ids.slice().sort().join('\u0000');
			if (!dragIndex || key !== dragKey) controller.beginDrag(ids);
			const proposed = new Map(dragging.map((c) => [c.id, c.position!]));
			const nodes = options.getNodes().map((n) => (proposed.has(n.id) ? { ...n, position: proposed.get(n.id)! } : n));
			const result = snapNodeDrag(nodes, ids, {
				...rect(),
				...options.guides,
				zoom: options.getZoom?.() ?? 1,
				index: dragIndex!
			});
			setGuides(result.guides);
			const { x: dx, y: dy } = result.offset;
			if (dx === 0 && dy === 0) return changes;
			// Children of a dragged parent move with it; only shift top-level dragged nodes.
			const parents = new Map(nodes.map((n) => [n.id, n.parentId]));
			const shift = new Set(ids.filter((id) => !proposed.has(parents.get(id) ?? '')));
			return changes.map((c) =>
				c.type === 'position' && c.position && c.dragging && shift.has(c.id)
					? { ...c, position: { x: c.position.x + dx, y: c.position.y + dy } }
					: c
			);
		},

		/** Clears guides and the cached snap targets. */
		endDrag() {
			dragIndex = null;
			dragKey = '';
			setGuides([]);
		}
	};
	return controller;
}

export type CanvasArrangeController<TNode extends CanvasNode = CanvasNode> = ReturnType<
	typeof createCanvasArrangeController<TNode>
>;
