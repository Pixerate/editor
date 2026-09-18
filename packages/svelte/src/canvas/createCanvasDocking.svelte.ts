import type { XYPosition } from '@xyflow/svelte';
import type { CanvasNode, CanvasDockingCallbacks, DockStrategy } from './types.js';

export type { DockStrategy };

export interface CreateCanvasDockingOptions<TNode extends CanvasNode = CanvasNode>
	extends CanvasDockingCallbacks<TNode> {
	isDockTarget?: (target: TNode) => boolean;
	restorePositionOnDock?: boolean;
	onSave?: () => void;
	/**
	 * Disambiguation strategy when multiple candidate dock targets intersect the dragged node.
	 * - 'center-point': (Default) Resolves the target enclosing or closest to the dragged node's center.
	 * - 'max-overlap': Resolves the target with the greatest overlapping area.
	 * - 'pointer': Resolves the target enclosing or closest to the mouse/touch cursor.
	 * - 'first': Resolves the first intersecting target (legacy behavior).
	 */
	dockStrategy?: DockStrategy;
	/**
	 * Custom primary dock target resolution callback. If provided and returns a node, takes precedence.
	 */
	resolvePrimaryDockTarget?: (
		targets: TNode[],
		draggedNode: TNode,
		event?: MouseEvent | TouchEvent
	) => TNode | null;
	/**
	 * When true (default), ensures only a single primary dock target is considered hovered at any time.
	 * Transitioning across adjacent dock targets automatically fires onDockLeave on the previous target
	 * and onDockHover on the new target. Set to false to allow concurrent multi-target hover.
	 */
	exclusiveHover?: boolean;
}

interface NodeRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

function getNodeRect(node: CanvasNode): NodeRect {
	const x = node.position?.x ?? 0;
	const y = node.position?.y ?? 0;
	const width =
		(node as any).measured?.width ??
		(node as any).width ??
		(node as any).initialWidth ??
		0;
	const height =
		(node as any).measured?.height ??
		(node as any).height ??
		(node as any).initialHeight ??
		0;
	return { x, y, width, height };
}

function getNodeCenter(node: CanvasNode): { x: number; y: number } {
	const rect = getNodeRect(node);
	return {
		x: rect.x + rect.width / 2,
		y: rect.y + rect.height / 2
	};
}

function getDistanceSq(p1: { x: number; y: number }, p2: { x: number; y: number }): number {
	const dx = p1.x - p2.x;
	const dy = p1.y - p2.y;
	return dx * dx + dy * dy;
}

function getOverlapArea(rectA: NodeRect, rectB: NodeRect): number {
	const xOverlap = Math.max(
		0,
		Math.min(rectA.x + rectA.width, rectB.x + rectB.width) - Math.max(rectA.x, rectB.x)
	);
	const yOverlap = Math.max(
		0,
		Math.min(rectA.y + rectA.height, rectB.y + rectB.height) - Math.max(rectA.y, rectB.y)
	);
	return xOverlap * yOverlap;
}

function resolvePrimaryTarget<TNode extends CanvasNode>(
	targets: TNode[],
	draggedNode: TNode,
	strategy: DockStrategy,
	customResolver?: (
		targets: TNode[],
		draggedNode: TNode,
		event?: MouseEvent | TouchEvent
	) => TNode | null,
	event?: MouseEvent | TouchEvent
): TNode | null {
	if (targets.length === 0) return null;
	if (targets.length === 1) return targets[0];

	if (customResolver) {
		const resolved = customResolver(targets, draggedNode, event);
		if (resolved !== undefined) return resolved;
	}

	if (strategy === 'first') {
		return targets[0];
	}

	if (strategy === 'pointer' && event) {
		const clientX = 'clientX' in event ? event.clientX : event.touches?.[0]?.clientX;
		const clientY = 'clientY' in event ? event.clientY : event.touches?.[0]?.clientY;
		if (typeof clientX === 'number' && typeof clientY === 'number') {
			const pointerInside = targets.filter((target) => {
				const r = getNodeRect(target);
				return (
					r.width > 0 &&
					r.height > 0 &&
					clientX >= r.x &&
					clientX <= r.x + r.width &&
					clientY >= r.y &&
					clientY <= r.y + r.height
				);
			});
			if (pointerInside.length === 1) return pointerInside[0];
			if (pointerInside.length > 1) {
				return pointerInside.reduce((best, cur) => {
					const bestDist = getDistanceSq(getNodeCenter(best), { x: clientX, y: clientY });
					const curDist = getDistanceSq(getNodeCenter(cur), { x: clientX, y: clientY });
					return curDist < bestDist ? cur : best;
				});
			}
		}
	}

	if (strategy === 'max-overlap') {
		const draggedRect = getNodeRect(draggedNode);
		let maxArea = -1;
		let bestTarget = targets[0];
		for (const target of targets) {
			const targetRect = getNodeRect(target);
			const area = getOverlapArea(draggedRect, targetRect);
			if (area > maxArea) {
				maxArea = area;
				bestTarget = target;
			}
		}
		return bestTarget;
	}

	// Strategy: 'center-point' (default)
	const draggedCenter = getNodeCenter(draggedNode);
	const containing = targets.filter((target) => {
		const r = getNodeRect(target);
		if (r.width > 0 && r.height > 0) {
			return (
				draggedCenter.x >= r.x &&
				draggedCenter.x <= r.x + r.width &&
				draggedCenter.y >= r.y &&
				draggedCenter.y <= r.y + r.height
			);
		}
		return false;
	});

	if (containing.length === 1) return containing[0];
	if (containing.length > 1) {
		return containing.reduce((best, cur) => {
			const bestDist = getDistanceSq(getNodeCenter(best), draggedCenter);
			const curDist = getDistanceSq(getNodeCenter(cur), draggedCenter);
			return curDist < bestDist ? cur : best;
		});
	}

	return targets.reduce((best, cur) => {
		const bestDist = getDistanceSq(getNodeCenter(best), draggedCenter);
		const curDist = getDistanceSq(getNodeCenter(cur), draggedCenter);
		return curDist < bestDist ? cur : best;
	});
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
	const dockStrategy = options.dockStrategy ?? 'center-point';
	const exclusiveHover = options.exclusiveHover ?? true;

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

		if (exclusiveHover) {
			const primaryTarget =
				currentDockTargets.length > 0
					? resolvePrimaryTarget(
							currentDockTargets,
							draggedNode,
							dockStrategy,
							options.resolvePrimaryDockTarget,
							params.event
						)
					: null;
			const primaryTargetId = primaryTarget ? primaryTarget.id : null;

			// Fire onDockLeave for previous targets no longer considered primary
			currentHoverTargets.forEach((targetId) => {
				if (targetId !== primaryTargetId) {
					const leftNode = intersecting.find((n) => n.id === targetId) ?? ({ id: targetId } as TNode);
					options.onDockLeave?.(leftNode, draggedNode!);
				}
			});

			// Fire onDockHover if entering a new primary target
			if (primaryTarget && !currentHoverTargets.has(primaryTarget.id)) {
				options.onDockHover?.(primaryTarget, draggedNode);
			}

			currentHoverTargets = primaryTargetId ? new Set([primaryTargetId]) : new Set();
		} else {
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
			const dockTargets = intersecting.filter(isDockTarget);
			const dockTarget =
				dockTargets.length > 0
					? resolvePrimaryTarget(
							dockTargets,
							draggedNode,
							dockStrategy,
							options.resolvePrimaryDockTarget,
							params.event
						)
					: null;

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
