import { applyNodeUpdates, createNodeLookup, getNodeRect, getNodeSize, invertNodeUpdates, type CanvasNodeUpdate } from './arrange.js';
import type { ArrangeHistoryTarget, PositionChangeLike } from './arrangeController.js';
import {
	applyConstraints,
	getAutoLayoutInsertTarget,
	getLayoutParent,
	isAutoLayoutFrame,
	layoutAll,
	layoutUpMany,
	moveLayoutChild,
	type AutoLayoutInsertTarget,
	type AutoLayoutOptions
} from './autoLayout.js';
import type { GuideLine } from './guides.js';
import type { CanvasNode, XYPosition } from './types.js';

export interface CanvasAutoLayoutControllerOptions<TNode extends CanvasNode = CanvasNode> extends AutoLayoutOptions {
	getNodes: () => TNode[];
	setNodes: (nodes: TNode[]) => void;
	/** When set, controller actions (add / remove / resize / reorder / apply) are one undoable step each. */
	history?: ArrangeHistoryTarget;
	/** Turns automatic relayout off (explicit `applyAutoLayout` still works). Default `true`. */
	enabled?: boolean;
	/** Reorder flow children by dragging them inside their frame (default `true`). */
	dragReorder?: boolean;
	/** Called when the drop marker of a reorder drag changes (empty when none). */
	onGuidesChange?: (guides: GuideLine[]) => void;
}

/**
 * Merges the updates of several layout passes (later ones win per field).
 */
export function mergeNodeUpdates(...lists: CanvasNodeUpdate[][]): CanvasNodeUpdate[] {
	const byId = new Map<string, CanvasNodeUpdate>();
	for (const list of lists) for (const u of list) byId.set(u.id, { ...byId.get(u.id), ...u });
	return [...byId.values()];
}

/**
 * Updates that re-run auto layout around `ids` after a change: each id's own layout (if a
 * frame) and its auto layout ancestors, plus the frames that lost removed children
 * (`parentIds`). Pure helper used by the controllers.
 */
export function relayoutUpdates(nodes: CanvasNode[], ids: Iterable<string>, options: AutoLayoutOptions = {}): CanvasNodeUpdate[] {
	return layoutUpMany(nodes, ids, options);
}

/**
 * Framework-agnostic auto layout controller shared by the React hook and the Svelte rune.
 * Applies auto layout to frames (`data.layout`) after nodes inside them are added, removed,
 * resized or reordered, either through its own (undoable) actions or by watching the flow's
 * node changes (`noteChanges` + `flush`), and reorders flow children dragged within a frame.
 */
export function createCanvasAutoLayoutController<TNode extends CanvasNode = CanvasNode>(
	options: CanvasAutoLayoutControllerOptions<TNode>
) {
	const layoutOptions = (): AutoLayoutOptions => ({ measure: options.measure, rectOptions: options.rectOptions });
	const enabled = () => options.enabled !== false;

	// Changes noted from the flow, applied by `flush`.
	const pendingIds = new Set<string>();
	const pendingResizes = new Map<string, { width: number; height: number }>();
	const resizeStarts = new Map<string, { width: number; height: number }>();
	let pendingAll = false;
	// Reorder drags: start position of each dragged flow child, and drops to commit.
	const dragStarts = new Map<string, XYPosition>();
	const pendingDrops = new Set<string>();
	let guides: GuideLine[] = [];

	const setGuides = (next: GuideLine[]) => {
		if (next.length === 0 && guides.length === 0) return;
		guides = next;
		options.onGuidesChange?.(guides);
	};

	/**
	 * Runs a structural change plus the relayout it causes as one (optionally undoable) step.
	 * `forward` / `backward` change the array; `ids` are relayout around after `forward`.
	 */
	function run(
		name: string,
		forward: (nodes: TNode[]) => TNode[],
		backward: (nodes: TNode[]) => TNode[],
		ids: (after: TNode[]) => Iterable<string>,
		extra: CanvasNodeUpdate[] = [],
		restore?: { id: string; position: XYPosition }
	) {
		const before = options.getNodes();
		const structural = forward(before);
		const withExtra = applyNodeUpdates(structural, extra);
		const layout = enabled() || name === 'Auto Layout' ? relayoutUpdates(withExtra, ids(withExtra), layoutOptions()) : [];
		const updates = mergeNodeUpdates(extra, layout);
		if (structural === before && updates.length === 0) return updates;
		let inverse = invertNodeUpdates(structural, updates);
		if (restore) {
			// Undo puts a dragged node back where the drag began (the flow wrote the drag outside history).
			inverse = mergeNodeUpdates(inverse, [{ id: restore.id, position: { ...restore.position } }]);
		}
		const execute = () => options.setNodes(applyNodeUpdates(forward(options.getNodes()), updates));
		const undo = () => options.setNodes(backward(applyNodeUpdates(options.getNodes(), inverse)));
		if (options.history) options.history.execute({ name, execute, undo });
		else execute();
		return updates;
	}

	const identity = (nodes: TNode[]) => nodes;

	const controller = {
		/** Drop marker of the active reorder drag (flow coordinates); empty otherwise. */
		get guides() {
			return guides;
		},

		/**
		 * Lays out frame `frameId` and its auto layout ancestors (default: every frame) as one
		 * (optionally undoable) step. Returns the updates.
		 */
		applyAutoLayout(frameId?: string): CanvasNodeUpdate[] {
			if (frameId === undefined) {
				const updates = layoutAll(options.getNodes(), layoutOptions());
				return run('Auto Layout', identity, identity, () => [], updates);
			}
			return run('Auto Layout', identity, identity, () => [frameId]);
		},

		/** Updates that relayout around `ids` on the current nodes, without applying them. */
		layoutUpdates(ids: Iterable<string>): CanvasNodeUpdate[] {
			return relayoutUpdates(options.getNodes(), ids, layoutOptions());
		},

		/**
		 * Applies the relayout around `ids` (frames, or nodes inside frames) directly, not
		 * recorded in history: auto layout is derived state, re-run after any change.
		 */
		relayout(ids: Iterable<string>): CanvasNodeUpdate[] {
			const updates = relayoutUpdates(options.getNodes(), ids, layoutOptions());
			if (updates.length > 0) options.setNodes(applyNodeUpdates(options.getNodes(), updates));
			return updates;
		},

		/**
		 * Adds `node` (into the frame named by its `parentId`, at flow `index` when given) and
		 * lays out its frame, as one step.
		 */
		addNode(node: TNode, addOptions: { index?: number } = {}): CanvasNodeUpdate[] {
			const forward = (nodes: TNode[]) => {
				if (nodes.some((n) => n.id === node.id)) return nodes;
				let next = [...nodes, node];
				if (addOptions.index !== undefined && node.parentId) next = moveLayoutChild(next, node.id, addOptions.index);
				return next;
			};
			const backward = (nodes: TNode[]) => nodes.filter((n) => n.id !== node.id);
			return run('Add Node', forward, backward, () => [node.id]);
		},

		/** Removes nodes (and their descendants) and lays out the frames they leave, as one step. */
		removeNodes(ids: Iterable<string>): CanvasNodeUpdate[] {
			const before = options.getNodes();
			const remove = new Set(ids);
			// Descendants go too (xyflow cannot render orphans).
			let grew = true;
			while (grew) {
				grew = false;
				for (const n of before) {
					if (n.parentId && remove.has(n.parentId) && !remove.has(n.id)) {
						remove.add(n.id);
						grew = true;
					}
				}
			}
			const removed = before.map((n, i) => [i, n] as const).filter(([, n]) => remove.has(n.id));
			if (removed.length === 0) return [];
			const parents = [...new Set(removed.map(([, n]) => n.parentId).filter((p): p is string => !!p && !remove.has(p)))];
			const forward = (nodes: TNode[]) => nodes.filter((n) => !remove.has(n.id));
			const backward = (nodes: TNode[]) => {
				const next = [...nodes];
				for (const [i, n] of removed) next.splice(Math.min(i, next.length), 0, n);
				return next;
			};
			return run('Delete', forward, backward, () => parents);
		},

		/**
		 * Resizes node `id` (its children follow their constraints) and lays out around it,
		 * as one step.
		 */
		resizeNode(id: string, size: { width?: number; height?: number }): CanvasNodeUpdate[] {
			const nodes = options.getNodes();
			const node = nodes.find((n) => n.id === id);
			if (!node) return [];
			const old = getNodeSize(node, options.rectOptions);
			const update: CanvasNodeUpdate = { id };
			if (size.width !== undefined) update.width = size.width;
			if (size.height !== undefined) update.height = size.height;
			const resized = applyNodeUpdates(nodes, [update]);
			const constrained = mergeNodeUpdates([update], applyConstraints(resized, id, old, layoutOptions()));
			return run('Resize', identity, identity, () => [id], constrained);
		},

		/** Moves flow child `childId` to flow index `index` in its frame and lays it out, as one step. */
		moveChild(childId: string, index: number): CanvasNodeUpdate[] {
			const before = options.getNodes();
			const order = before.map((n) => n.id);
			const forward = (nodes: TNode[]) => moveLayoutChild(nodes, childId, index);
			const backward = (nodes: TNode[]) => restoreOrder(nodes, order);
			if (forward(before) === before) return [];
			return run('Reorder', forward, backward, () => [childId]);
		},

		/** Where flow child `id` would drop if released at `point` (default: its centre). */
		getInsertTarget(id: string, point?: XYPosition): AutoLayoutInsertTarget | undefined {
			const nodes = options.getNodes();
			const frame = getLayoutParent(nodes, id);
			if (!frame) return undefined;
			const lookup = createNodeLookup(nodes);
			const rect = getNodeRect(lookup.get(id)!, lookup, options.rectOptions);
			const at = point ?? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
			return getAutoLayoutInsertTarget(nodes, frame.id, at, { ...layoutOptions(), excludeId: id });
		},

		/** Records the start position of a reorder drag. Optional: `dragReorder` records it lazily. */
		beginReorderDrag(id: string) {
			const node = options.getNodes().find((n) => n.id === id);
			if (node && getLayoutParent(options.getNodes(), id)) dragStarts.set(id, { ...node.position });
		},

		/**
		 * While flow child `id` is dragged (as currently positioned in `getNodes()`): updates the
		 * drop marker. Returns the insert target.
		 */
		dragReorder(id: string, point?: XYPosition): AutoLayoutInsertTarget | undefined {
			if (options.dragReorder === false) return undefined;
			if (!dragStarts.has(id)) controller.beginReorderDrag(id);
			const target = controller.getInsertTarget(id, point);
			setGuides(target ? [target.guide] : []);
			return target;
		},

		/**
		 * Ends a reorder drag: moves `id` to the slot under `point` (default: its centre) and lays
		 * the frame out, as one undoable step whose undo puts the node back where the drag began.
		 */
		endReorderDrag(id: string, point?: XYPosition): CanvasNodeUpdate[] {
			setGuides([]);
			const start = dragStarts.get(id);
			dragStarts.delete(id);
			if (options.dragReorder === false || !getLayoutParent(options.getNodes(), id)) return [];
			const target = controller.getInsertTarget(id, point);
			if (!target) return [];
			const before = options.getNodes();
			const order = before.map((n) => n.id);
			const forward = (nodes: TNode[]) => moveLayoutChild(nodes, id, target.index);
			const backward = (nodes: TNode[]) => restoreOrder(nodes, order);
			return run('Reorder', forward, backward, () => [id], [], start && { id, position: start });
		},

		/**
		 * Notes a batch of React Flow / SvelteFlow style node changes (before or after they are
		 * applied) so `flush` can relayout: dimension changes (measured sizes, resize ends),
		 * added and removed nodes, and position changes of flow children (reorder drags).
		 * Returns the changes unchanged.
		 */
		noteChanges<TChange extends PositionChangeLike>(changes: TChange[]): TChange[] {
			const nodes = options.getNodes();
			const lookup = createNodeLookup(nodes);
			for (const c of changes) {
				const id = c.id ?? c.item?.id;
				if (c.type === 'add' && c.item) {
					pendingIds.add(c.item.id);
				} else if (c.type === 'remove' && id) {
					const parent = lookup.get(id)?.parentId;
					if (parent) pendingIds.add(parent);
					else pendingAll = true;
				} else if (c.type === 'replace' && id) {
					pendingIds.add(id);
				} else if (c.type === 'dimensions' && id) {
					const node = lookup.get(id);
					if (c.resizing === true) {
						if (node && !resizeStarts.has(id)) resizeStarts.set(id, getNodeSize(node, options.rectOptions));
						continue;
					}
					const start = resizeStarts.get(id);
					resizeStarts.delete(id);
					if (start) pendingResizes.set(id, start);
					pendingIds.add(id);
				} else if (c.type === 'position' && id && options.dragReorder !== false) {
					if (!getLayoutParent(nodes, id)) continue;
					if (c.dragging === true) {
						if (!dragStarts.has(id)) {
							const node = lookup.get(id);
							if (node) dragStarts.set(id, { ...node.position });
						}
					} else if (c.dragging === false || dragStarts.has(id)) {
						pendingDrops.add(id);
					}
				}
			}
			return changes;
		},

		/**
		 * Notes nodes that were already removed (e.g. SvelteFlow's `ondelete`), so `flush`
		 * relayouts the frames they left. The nodes must still carry their `parentId`.
		 */
		noteRemoved(removed: Iterable<{ id: string; parentId?: string }>) {
			const gone = new Set<string>();
			const list = [...removed];
			for (const n of list) gone.add(n.id);
			for (const n of list) if (n.parentId && !gone.has(n.parentId)) pendingIds.add(n.parentId);
		},

		/** Whether `noteChanges` left work for `flush`. */
		get hasPending() {
			return pendingAll || pendingIds.size > 0 || pendingResizes.size > 0 || pendingDrops.size > 0 || dragStarts.size > 0;
		},

		/**
		 * Applies the work noted by `noteChanges` to the current nodes: drop markers while
		 * dragging, committed reorders on drop (undoable), and a relayout (not recorded) for
		 * size, add and remove changes. Call it once the changes are applied.
		 */
		flush(): CanvasNodeUpdate[] {
			let applied: CanvasNodeUpdate[] = [];
			for (const id of pendingDrops) applied = mergeNodeUpdates(applied, controller.endReorderDrag(id));
			pendingDrops.clear();
			for (const id of dragStarts.keys()) controller.dragReorder(id);
			if (!enabled()) {
				pendingIds.clear();
				pendingResizes.clear();
				pendingAll = false;
				return applied;
			}
			let nodes = options.getNodes();
			let updates: CanvasNodeUpdate[] = [];
			for (const [id, previous] of pendingResizes) {
				if (!nodes.some((n) => n.id === id)) continue;
				const constrained = applyConstraints(nodes, id, previous, layoutOptions());
				nodes = applyNodeUpdates(nodes, constrained);
				updates = mergeNodeUpdates(updates, constrained);
			}
			const layout = pendingAll
				? layoutAll(nodes, layoutOptions())
				: relayoutUpdates(nodes, [...pendingIds].filter((id) => nodes.some((n) => n.id === id)), layoutOptions());
			updates = mergeNodeUpdates(updates, layout);
			pendingIds.clear();
			pendingResizes.clear();
			pendingAll = false;
			if (updates.length > 0) options.setNodes(applyNodeUpdates(options.getNodes(), updates));
			return mergeNodeUpdates(applied, updates);
		},

		/** Whether `id` is an auto layout frame. */
		isFrame: (id: string) => isAutoLayoutFrame(options.getNodes().find((n) => n.id === id))
	};

	return controller;
}

/** Reorders `nodes` to follow `order` (ids); ids not in `order` keep their relative place at the end. */
function restoreOrder<TNode extends CanvasNode>(nodes: TNode[], order: string[]): TNode[] {
	const rank = new Map(order.map((id, i) => [id, i]));
	const indexed = nodes.map((n, i) => ({ n, r: rank.get(n.id) ?? order.length + i }));
	indexed.sort((a, b) => a.r - b.r);
	return indexed.every((e, i) => e.n === nodes[i]) ? nodes : indexed.map((e) => e.n);
}

export type CanvasAutoLayoutController<TNode extends CanvasNode = CanvasNode> = ReturnType<
	typeof createCanvasAutoLayoutController<TNode>
>;
