import { useEffect, useMemo, useRef, useState } from 'react';
import {
	createCanvasArrangeController,
	matchArrangeShortcut,
	type ArrangeHistoryTarget,
	type AutoLayoutOptions,
	type ArrangeShortcutBinding,
	type CanvasArrangeAction,
	type CanvasNode,
	type GuideLine,
	type NodeRectOptions,
	type SnapGuidesOptions
} from '@pixerate/editor/canvas';

export interface UseCanvasArrangeOptions<TNode extends CanvasNode = CanvasNode> {
	nodes: TNode[];
	setNodes: (updater: TNode[] | ((prev: TNode[]) => TNode[])) => void;
	/** Ids acted on when a method is called without ids (default: nodes with `selected: true`). */
	getSelectedIds?: () => string[];
	/** When set, every arrange action is recorded as one undoable command. */
	history?: ArrangeHistoryTarget;
	/** Current zoom (e.g. `useViewport().zoom`) for the screen-pixel guide threshold. */
	zoom?: number;
	guides?: Omit<SnapGuidesOptions, 'zoom'>;
	/** Turns drag snapping off (default `true`). */
	snapping?: boolean;
	rectOptions?: NodeRectOptions;
	/** Re-run auto layout around arranged nodes in the same undo step (see `useCanvasAutoLayout`). */
	autoLayout?: boolean | AutoLayoutOptions;
}

/**
 * React hook for Freeform-style arrangement on React Flow: align, distribute, make same size,
 * lock / unlock, layer order and smart guides with snap-to-shape while dragging.
 *
 * Snapping: pass node changes through `snapPositionChanges` in `onNodesChange`
 * (`onNodesChange={(c) => setNodes((n) => applyNodeChanges(arrange.snapPositionChanges(c), n))}`)
 * and render `guides` with `<CanvasGuidesLayer>`.
 */
export function useCanvasArrange<TNode extends CanvasNode = CanvasNode>(options: UseCanvasArrangeOptions<TNode>) {
	const [guides, setGuides] = useState<GuideLine[]>([]);
	const nodesRef = useRef(options.nodes);
	nodesRef.current = options.nodes;
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const controller = useMemo(
		() =>
			createCanvasArrangeController<TNode>({
				getNodes: () => nodesRef.current,
				setNodes: (next) => {
					// Keep the ref current so consecutive actions (and undo) see the latest nodes.
					nodesRef.current = next;
					optionsRef.current.setNodes(next);
				},
				getSelectedIds: () =>
					optionsRef.current.getSelectedIds?.() ??
					nodesRef.current.filter((n) => n.selected).map((n) => n.id),
				get history() {
					return optionsRef.current.history;
				},
				getZoom: () => optionsRef.current.zoom ?? 1,
				get guides() {
					return optionsRef.current.guides;
				},
				get snapping() {
					return optionsRef.current.snapping;
				},
				get rectOptions() {
					return optionsRef.current.rectOptions;
				},
				get autoLayout() {
					return optionsRef.current.autoLayout;
				},
				onGuidesChange: setGuides
			}),
		[]
	);

	return useMemo(() => ({ ...controller, guides }), [controller, guides]);
}

export type CanvasArrange = ReturnType<typeof useCanvasArrange>;

export interface UseCanvasArrangeShortcutsOptions {
	arrange: { runAction: (action: CanvasArrangeAction) => boolean };
	/** Scenes controller for PageDown / PageUp (next / previous scene). */
	scenes?: { next: () => unknown; previous: () => unknown };
	targetElement?: HTMLElement | Window | null;
	enabled?: boolean;
	bindings?: readonly ArrangeShortcutBinding[];
}

/**
 * Registers the arrange keyboard shortcuts (see `DEFAULT_ARRANGE_SHORTCUTS`), ignoring
 * events from inputs, textareas, contenteditable and ProseMirror editors.
 */
export function useCanvasArrangeShortcuts(options: UseCanvasArrangeShortcutsOptions) {
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const { targetElement, enabled = true } = options;

	useEffect(() => {
		if (!enabled) return;
		const target = targetElement ?? (typeof window !== 'undefined' ? window : null);
		if (!target) return;

		function handleKeyDown(event: Event) {
			const { arrange, scenes, bindings } = optionsRef.current;
			const action = matchArrangeShortcut(event as KeyboardEvent, bindings);
			if (!action) return;
			let handled = false;
			if (action === 'nextScene' || action === 'previousScene') {
				if (scenes) {
					scenes[action === 'nextScene' ? 'next' : 'previous']();
					handled = true;
				}
			} else {
				handled = arrange.runAction(action);
			}
			if (handled) event.preventDefault();
		}

		target.addEventListener('keydown', handleKeyDown);
		return () => target.removeEventListener('keydown', handleKeyDown);
	}, [targetElement, enabled]);
}
