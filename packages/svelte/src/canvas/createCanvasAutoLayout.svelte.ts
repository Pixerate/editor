import {
	createCanvasAutoLayoutController,
	type CanvasAutoLayoutControllerOptions,
	type GuideLine,
	type PositionChangeLike
} from '@pixerate/editor/canvas';
import type { CanvasNode } from './types.js';

// SvelteFlow's `Node` allows `class` values (arrays / objects) that core's structural
// `CanvasNode` does not, so the core controller is typed loosely and re-typed here.
type CoreOptions = CanvasAutoLayoutControllerOptions<any>;

export interface CreateCanvasAutoLayoutOptions<TNode extends CanvasNode = CanvasNode>
	extends Omit<CoreOptions, 'getNodes' | 'setNodes' | 'onGuidesChange'> {
	getNodes: () => TNode[];
	setNodes: (nodes: TNode[]) => void;
	onGuidesChange?: (guides: GuideLine[]) => void;
}

/**
 * Headless Svelte 5 rune for Figma-style auto layout on SvelteFlow sub-flows. Frames are
 * nodes with `data.layout`; their children (`parentId`) are stacked, wrapped or placed on a
 * grid, with hug / fill / fixed sizing, min / max, padding, alignment and constraints.
 *
 * Its actions (`addNode`, `removeNodes`, `resizeNode`, `moveChild`, `applyAutoLayout`) relayout
 * in the same undoable step when a `HistoryManager` is passed. Wire the flow's own edits with
 * `onnodedrag={({ targetNode }) => autoLayout.dragReorder(targetNode.id)}`,
 * `onnodedragstop={({ targetNode }) => autoLayout.endReorderDrag(targetNode.id)}`,
 * `ondelete={({ nodes }) => autoLayout.nodesDeleted(nodes)}`,
 * `<NodeResizer {...autoLayout.resizerHandlers(id)} />` and call `autoLayout.measured(id)` when
 * a node's content size changes. Render `guides` (the drop marker) with `<CanvasGuidesLayer>`.
 */
export function createCanvasAutoLayout<TNode extends CanvasNode = CanvasNode>(options: CreateCanvasAutoLayoutOptions<TNode>) {
	let guides = $state.raw<GuideLine[]>([]);
	let scheduled = false;

	const controller = createCanvasAutoLayoutController<any>({
		...options,
		onGuidesChange: (next) => {
			guides = next;
			options.onGuidesChange?.(next);
		}
	});

	// SvelteFlow writes its own changes after its callbacks run, so the flush waits a microtask.
	const schedule = () => {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			controller.flush();
		});
	};

	return {
		...controller,
		/** Drop marker of the active reorder drag (flow coordinates); empty otherwise. */
		get guides() {
			return guides;
		},
		get hasPending() {
			return controller.hasPending;
		},
		/** Notes node changes (see the core controller) and flushes them on the next microtask. */
		handleChanges<TChange extends PositionChangeLike>(changes: TChange[]): TChange[] {
			controller.noteChanges(changes);
			schedule();
			return changes;
		},
		/** For SvelteFlow's `ondelete`: relayouts the frames the deleted nodes left. */
		nodesDeleted(removed: Iterable<{ id: string; parentId?: string }>) {
			controller.noteRemoved(removed);
			schedule();
		},
		/** Relayouts around node `id` after its measured (content) size changed. */
		measured(id: string) {
			controller.noteChanges([{ type: 'dimensions', id }]);
			schedule();
		},
		/**
		 * Handlers for SvelteFlow's `<NodeResizer>`: children follow their constraints and the
		 * frames around the node relayout when the resize ends.
		 */
		resizerHandlers(id: string) {
			return {
				onResizeStart: () => {
					controller.noteChanges([{ type: 'dimensions', id, resizing: true }]);
				},
				onResizeEnd: () => {
					queueMicrotask(() => {
						controller.noteChanges([{ type: 'dimensions', id, resizing: false }]);
						controller.flush();
					});
				}
			};
		}
	};
}

export type CanvasAutoLayout<TNode extends CanvasNode = CanvasNode> = ReturnType<typeof createCanvasAutoLayout<TNode>>;
