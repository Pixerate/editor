import type { XYPosition } from '@xyflow/svelte';
import type { CanvasNode, CanvasDockingCallbacks } from './types.js';

export interface CreateCanvasDockingOptions<TNode extends CanvasNode = CanvasNode>
	extends CanvasDockingCallbacks<TNode> {
	isDockTarget?: (target: TNode) => boolean;
	restorePositionOnDock?: boolean;
	onSave?: () => void;
}

/**
 * Headless Svelte 5 rune managing canvas node dragging, docking intersection, and connection tracking.
 */
export function createCanvasDocking<TNode extends CanvasNode = CanvasNode>(
	options: CreateCanvasDockingOptions<TNode> = {}
) {
	let draggedNode = $state.raw<TNode | null>(null);
	let draggedInitialPosition = $state.raw<XYPosition | null>(null);
	let connectingHandle = $state.raw<string>('');
	let connectingNode = $state.raw<TNode | null>(null);
	let currentHoverTargets = $state.raw<Set<string>>(new Set());

	const isDockTarget = options.isDockTarget ?? ((target: TNode) => (target as any).type === 'boardNode');

	function handleNodeDragStart(params: {
		targetNode: TNode | null;
		event?: MouseEvent | TouchEvent;
	}): void {
		draggedNode = params.targetNode;
		draggedInitialPosition = params.targetNode?.position ? { ...params.targetNode.position } : null;
		currentHoverTargets = new Set();
	}

	function handleNodeDrag(
		params: {
			targetNode: TNode | null;
			event?: MouseEvent | TouchEvent;
		},
		getIntersectingNodes: (node: TNode) => TNode[]
	): void {
		draggedNode = params.targetNode;
		if (!draggedNode) return;

		const intersecting = getIntersectingNodes(draggedNode);
		const currentDockTargets = intersecting.filter(isDockTarget);
		const newHoverSet = new Set(currentDockTargets.map((t) => t.id));

		// Check for left targets
		currentHoverTargets.forEach((targetId) => {
			if (!newHoverSet.has(targetId)) {
				const leftNode = intersecting.find((n) => n.id === targetId) ?? ({ id: targetId } as TNode);
				options.onDockLeave?.(leftNode, draggedNode!);
			}
		});

		// Check for newly entered targets
		currentDockTargets.forEach((target) => {
			if (!currentHoverTargets.has(target.id)) {
				options.onDockHover?.(target, draggedNode!);
			}
		});

		currentHoverTargets = newHoverSet;
	}

	function handleNodeDragStop(
		params: {
			targetNode: TNode | null;
			event?: MouseEvent | TouchEvent;
		},
		getIntersectingNodes: (node: TNode) => TNode[],
		updateNodePosition?: (nodeId: string, position: XYPosition) => void
	): void {
		draggedNode = params.targetNode;

		if (draggedNode) {
			const intersecting = getIntersectingNodes(draggedNode);
			const dockTarget = intersecting.find(isDockTarget);

			if (dockTarget) {
				options.onDockDrop?.(dockTarget, draggedNode);

				if (options.restorePositionOnDock !== false && draggedInitialPosition && updateNodePosition) {
					updateNodePosition(draggedNode.id, draggedInitialPosition);
				}
			}
		}

		// Reset state
		draggedNode = null;
		draggedInitialPosition = null;
		currentHoverTargets = new Set();

		options.onSave?.();
	}

	function handleConnectStart(
		params: {
			nodeId: string | null;
			handleId?: string | null;
			handleType: 'source' | 'target' | null;
		},
		getNode: (id: string) => TNode | undefined
	): void {
		connectingHandle = params.handleType ?? '';
		connectingNode = params.nodeId ? (getNode(params.nodeId) ?? null) : null;
	}

	function handleConnectEnd(): void {
		connectingHandle = '';
		connectingNode = null;
	}

	function reset(): void {
		draggedNode = null;
		draggedInitialPosition = null;
		connectingHandle = '';
		connectingNode = null;
		currentHoverTargets = new Set();
	}

	return {
		get draggedNode() {
			return draggedNode;
		},
		get draggedInitialPosition() {
			return draggedInitialPosition;
		},
		get connectingHandle() {
			return connectingHandle;
		},
		get connectingNode() {
			return connectingNode;
		},
		get isDragging() {
			return draggedNode !== null;
		},
		handleNodeDragStart,
		handleNodeDrag,
		handleNodeDragStop,
		handleConnectStart,
		handleConnectEnd,
		reset
	};
}
