import type { Node, Edge, XYPosition, Rect, ColorMode, Position } from '@xyflow/svelte';

/**
 * Generic node interface representing an element on the canvas.
 */
export type CanvasNode<
	TData extends Record<string, any> = Record<string, any>,
	TType extends string | undefined = string | undefined
> = Node<TData, TType>;

/**
 * Generic edge interface representing a connection on the canvas.
 */
export type CanvasEdge<
	TData extends Record<string, any> = Record<string, any>,
	TType extends string | undefined = string | undefined
> = Edge<TData, TType>;

/**
 * Differences computed between two graph states.
 */
export interface GraphDifferences<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
> {
	changedNodes: TNode[];
	changedEdges: TEdge[];
	removedNodes: TNode[];
	removedEdges: TEdge[];
}

/**
 * Standard serialized clipboard payload for nodes and optional edges.
 */
export interface CanvasClipboardPayload<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
> {
	version?: number;
	nodes: TNode[];
	edges?: TEdge[];
}

/**
 * Options for Dagre graph layout.
 */
export interface CanvasLayoutOptions {
	direction?: 'LR' | 'TB' | 'RL' | 'BT';
	ranksep?: number;
	nodesep?: number;
	defaultNodeWidth?: number;
	defaultNodeHeight?: number;
}

/**
 * Options for keyboard shortcuts.
 */
export interface CanvasShortcutsOptions<TNode extends CanvasNode = CanvasNode> {
	targetElement?: HTMLElement | Window;
	onCopy?: () => void;
	onCut?: () => void;
	onPaste?: (event: ClipboardEvent) => void;
	onDelete?: (selectedNodes: TNode[]) => void;
	onDuplicate?: (selectedNodes: TNode[]) => void;
	onSelectAll?: () => void;
	onGroup?: (selectedNodes: TNode[]) => void;
	onUngroup?: (selectedNodes: TNode[]) => void;
	onZoomIn?: () => void;
	onZoomOut?: () => void;
	onFitView?: () => void;
	onSearch?: () => void;
	getSelectedNodes?: () => TNode[];
}

/**
 * Docking and intersection callbacks.
 */
export interface CanvasDockingCallbacks<TNode extends CanvasNode = CanvasNode> {
	onDockHover?: (dockTarget: TNode, draggedNode: TNode) => void;
	onDockLeave?: (dockTarget: TNode, draggedNode: TNode) => void;
	onDockDrop?: (dockTarget: TNode, draggedNode: TNode) => void;
}

/**
 * Configuration options for SvelteFlow presets.
 */
export interface CanvasInteractionPresetConfig {
	snapGrid?: [number, number];
	panOnDrag?: number[] | boolean;
	panOnScroll?: boolean;
	selectionOnDrag?: boolean;
	colorMode?: ColorMode;
	multiSelectionKey?: string[];
	minZoom?: number;
	maxZoom?: number;
}
