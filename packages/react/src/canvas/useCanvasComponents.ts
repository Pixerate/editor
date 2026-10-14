import { useLayoutEffect, useMemo, useRef } from 'react';
import {
	createCanvasComponentsController,
	type ArrangeHistoryTarget,
	type CanvasComponentSyncOptions,
	type CanvasNode
} from '@pixerate/editor/canvas';

export interface UseCanvasComponentsOptions<TNode extends CanvasNode = CanvasNode> extends CanvasComponentSyncOptions {
	nodes: TNode[];
	setNodes: (updater: TNode[] | ((prev: TNode[]) => TNode[])) => void;
	/** When set, every component action is one undoable step. */
	history?: ArrangeHistoryTarget;
	/** The selection (default: nodes with `selected`). */
	getSelectedIds?: () => string[];
	/** Called by `goToMainComponent` with the main (e.g. to pan the viewport to it). */
	onReveal?: (node: TNode) => void;
	/** Sync instances with their mains after every node change (default `true`). */
	autoSync?: boolean;
}

/**
 * React hook for Figma-style components and instances on a React Flow canvas. After every
 * node change it records edits inside instances as overrides and rebuilds the instances of
 * edited main components (keeping overrides). Its actions (`createComponent`,
 * `createInstance`, `combineAsVariants`, `detachInstance`, `resetOverrides`, `pushOverrides`,
 * `swapInstance`, `setInstanceProperties`, `restoreMainComponent`, …) are undoable steps
 * with a `history`, and each has a `can…` check returning `true` or the reason it can't run.
 */
export function useCanvasComponents<TNode extends CanvasNode = CanvasNode>(options: UseCanvasComponentsOptions<TNode>) {
	const nodesRef = useRef(options.nodes);
	nodesRef.current = options.nodes;
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const controller = useMemo(
		() =>
			createCanvasComponentsController<TNode>({
				getNodes: () => nodesRef.current,
				setNodes: (next) => {
					// Keep the ref current so consecutive actions (and undo) see the latest nodes.
					nodesRef.current = next;
					optionsRef.current.setNodes(next);
				},
				get history() {
					return optionsRef.current.history;
				},
				get getSelectedIds() {
					return optionsRef.current.getSelectedIds;
				},
				onReveal: (node) => optionsRef.current.onReveal?.(node),
				get idGenerator() {
					return optionsRef.current.idGenerator;
				},
				get textTypes() {
					return optionsRef.current.textTypes;
				},
				get layout() {
					return optionsRef.current.layout;
				},
				get tokens() {
					return optionsRef.current.tokens;
				}
			}),
		[]
	);

	// Edits are synced once React has committed the new nodes.
	useLayoutEffect(() => {
		if (optionsRef.current.autoSync !== false) controller.sync();
	}, [options.nodes, controller]);

	return controller;
}

export type CanvasComponents<TNode extends CanvasNode = CanvasNode> = ReturnType<typeof useCanvasComponents<TNode>>;
