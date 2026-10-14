import {
	createCanvasArrangeController,
	matchArrangeShortcut,
	type ArrangeShortcutBinding,
	type CanvasArrangeAction,
	type CanvasArrangeControllerOptions,
	type GuideLine
} from '@pixerate/editor/canvas';
import type { CanvasNode } from './types.js';

// SvelteFlow's `Node` allows `class` values (arrays / objects) that core's structural
// `CanvasNode` does not, so the core controller is typed loosely and re-typed here.
type CoreOptions = CanvasArrangeControllerOptions<any>;

export interface CreateCanvasArrangeOptions<TNode extends CanvasNode = CanvasNode>
	extends Omit<CoreOptions, 'getNodes' | 'setNodes' | 'onGuidesChange'> {
	getNodes: () => TNode[];
	setNodes: (nodes: TNode[]) => void;
	onGuidesChange?: (guides: GuideLine[]) => void;
}

/**
 * Headless Svelte 5 rune for Freeform-style arrangement: align, distribute, make same size,
 * lock / unlock, layer order and smart guides with snap-to-shape while dragging.
 *
 * Actions act on `getSelectedIds()` (default: selected nodes) when called without ids and
 * are recorded as single undoable steps when a `HistoryManager` is passed as `history`.
 *
 * Wire snapping to SvelteFlow with `onnodedragstart={() => arrange.beginDrag()}`,
 * `onnodedrag={({ nodes }) => arrange.drag(nodes.map((n) => n.id))}` and
 * `onnodedragstop={() => arrange.endDrag()}`, and render `arrange.guides` with
 * `<CanvasGuidesLayer>`. Snap resizes with `<NodeResizer {...arrange.resizerHandlers(id)} />`.
 */
export function createCanvasArrange<TNode extends CanvasNode = CanvasNode>(
	options: CreateCanvasArrangeOptions<TNode>
) {
	let guides = $state.raw<GuideLine[]>([]);

	const controller = createCanvasArrangeController<any>({
		...options,
		onGuidesChange: (next) => {
			guides = next;
			options.onGuidesChange?.(next);
		}
	});

	return {
		...controller,
		/** Guide segments (flow coordinates) for the active drag or resize; empty otherwise. */
		get guides() {
			return guides;
		},
		/**
		 * Resize snapping for SvelteFlow's `<NodeResizer>` / `<NodeResizeControl>`:
		 * `<NodeResizer {...arrange.resizerHandlers(id)} />`. The resizer writes the raw size
		 * to the nodes after `onResize`, so snapping runs a microtask later and writes the
		 * snapped box back. Locked nodes snap back to their starting box.
		 */
		resizerHandlers(id: string) {
			return {
				onResizeStart: () => controller.beginResize(id),
				onResize: () => {
					queueMicrotask(() => controller.resize(id));
				},
				onResizeEnd: () => {
					queueMicrotask(() => controller.endResize());
				}
			};
		}
	};
}

export type CanvasArrange<TNode extends CanvasNode = CanvasNode> = ReturnType<typeof createCanvasArrange<TNode>>;

export interface CanvasArrangeShortcutsOptions {
	arrange: { runAction: (action: CanvasArrangeAction) => boolean };
	/** Scenes controller for PageDown / PageUp (next / previous scene). */
	scenes?: { next: () => unknown; previous: () => unknown };
	targetElement?: HTMLElement | Window;
	bindings?: readonly ArrangeShortcutBinding[];
}

/**
 * Attaches the arrange keyboard shortcuts (see `DEFAULT_ARRANGE_SHORTCUTS`). Shortcuts are
 * ignored while typing in inputs, textareas, contenteditable or ProseMirror editors.
 *
 * @returns A cleanup function removing the listener.
 */
export function createCanvasArrangeShortcuts(options: CanvasArrangeShortcutsOptions): () => void {
	const target = options.targetElement ?? (typeof window !== 'undefined' ? window : null);
	if (!target) return () => {};

	function handleKeyDown(event: Event) {
		const action = matchArrangeShortcut(event as KeyboardEvent, options.bindings);
		if (!action) return;
		let handled = false;
		if (action === 'nextScene' || action === 'previousScene') {
			if (options.scenes) {
				options.scenes[action === 'nextScene' ? 'next' : 'previous']();
				handled = true;
			}
		} else {
			handled = options.arrange.runAction(action);
		}
		if (handled) event.preventDefault();
	}

	target.addEventListener('keydown', handleKeyDown);
	return () => target.removeEventListener('keydown', handleKeyDown);
}
