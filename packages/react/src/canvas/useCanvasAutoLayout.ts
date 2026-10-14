import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
	createCanvasAutoLayoutController,
	type ArrangeHistoryTarget,
	type AutoLayoutMeasure,
	type CanvasNode,
	type GuideLine,
	type NodeRectOptions
} from '@pixerate/editor/canvas';

export interface UseCanvasAutoLayoutOptions<TNode extends CanvasNode = CanvasNode> {
	nodes: TNode[];
	setNodes: (updater: TNode[] | ((prev: TNode[]) => TNode[])) => void;
	/** When set, the hook's actions (add / remove / resize / reorder / apply) are undoable steps. */
	history?: ArrangeHistoryTarget;
	/** Turns automatic relayout off (`applyAutoLayout` still works). Default `true`. */
	enabled?: boolean;
	/** Reorder flow children by dragging them within their frame (default `true`). */
	dragReorder?: boolean;
	/** Text measuring and size hooks (default: xyflow `measured` sizes). */
	measure?: AutoLayoutMeasure;
	rectOptions?: NodeRectOptions;
}

/**
 * React hook for Figma-style auto layout on React Flow sub-flows. Frames are nodes with
 * `data.layout`; their children (`parentId`) are stacked, wrapped or placed on a grid, with
 * hug / fill / fixed sizing, min / max, padding, alignment and constraints.
 *
 * Pass every `onNodesChange` batch through `noteChanges` before applying it
 * (`onNodesChange={(c) => setNodes((n) => applyNodeChanges(autoLayout.noteChanges(c), n))}`):
 * after the nodes update the hook relayouts frames whose children were measured, resized,
 * added or removed, and turns drags of a flow child inside its frame into a reorder (one
 * undoable step). Render `guides` (the drop marker) with `<CanvasGuidesLayer>`.
 */
export function useCanvasAutoLayout<TNode extends CanvasNode = CanvasNode>(options: UseCanvasAutoLayoutOptions<TNode>) {
	const [guides, setGuides] = useState<GuideLine[]>([]);
	const nodesRef = useRef(options.nodes);
	nodesRef.current = options.nodes;
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const controller = useMemo(
		() =>
			createCanvasAutoLayoutController<TNode>({
				getNodes: () => nodesRef.current,
				setNodes: (next) => {
					// Keep the ref current so consecutive actions (and undo) see the latest nodes.
					nodesRef.current = next;
					optionsRef.current.setNodes(next);
				},
				get history() {
					return optionsRef.current.history;
				},
				get enabled() {
					return optionsRef.current.enabled;
				},
				get dragReorder() {
					return optionsRef.current.dragReorder;
				},
				get measure() {
					return optionsRef.current.measure;
				},
				get rectOptions() {
					return optionsRef.current.rectOptions;
				},
				onGuidesChange: setGuides
			}),
		[]
	);

	// Noted changes are applied once React has committed the new nodes.
	useLayoutEffect(() => {
		if (controller.hasPending) controller.flush();
	}, [options.nodes, controller]);

	return useMemo(
		() => ({
			...controller,
			/** Drop marker of the active reorder drag (flow coordinates). */
			guides,
			get hasPending() {
				return controller.hasPending;
			}
		}),
		[controller, guides]
	);
}

export type CanvasAutoLayout = ReturnType<typeof useCanvasAutoLayout>;
