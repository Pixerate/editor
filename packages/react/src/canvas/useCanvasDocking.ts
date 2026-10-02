import { useCallback, useRef } from 'react';
import type {
	CanvasDockingCallbacks,
	CanvasNode,
	DockStrategy,
	Rect,
	XYPosition
} from '@pixerate/editor/canvas';

export interface UseCanvasDockingOptions<TNode extends CanvasNode = CanvasNode>
	extends CanvasDockingCallbacks<TNode> {
	strategy?: DockStrategy;
	dockableTypes?: string[];
	targetTypes?: string[];
}

/**
 * React hook resolving docking targets and intersections when dragging nodes across the canvas.
 */
export function useCanvasDocking<TNode extends CanvasNode = CanvasNode>(
	options: UseCanvasDockingOptions<TNode> = {}
) {
	const {
		strategy = 'center-point',
		dockableTypes,
		targetTypes,
		onDockHover,
		onDockLeave,
		onDockDrop
	} = options;

	const activeDockTargetRef = useRef<TNode | null>(null);

	const isDockable = useCallback(
		(node: TNode): boolean => {
			if (!dockableTypes || dockableTypes.length === 0) return true;
			return !!node.type && dockableTypes.includes(node.type);
		},
		[dockableTypes]
	);

	const isTarget = useCallback(
		(node: TNode): boolean => {
			if (!targetTypes || targetTypes.length === 0) return true;
			return !!node.type && targetTypes.includes(node.type);
		},
		[targetTypes]
	);

	const findDockTarget = useCallback(
		(
			draggedNode: TNode,
			candidates: TNode[],
			cursorPos?: XYPosition
		): TNode | null => {
			if (!isDockable(draggedNode)) return null;

			const draggedWidth = draggedNode.measured?.width ?? (draggedNode as any).width ?? 200;
			const draggedHeight = draggedNode.measured?.height ?? (draggedNode as any).height ?? 60;
			const draggedCenter: XYPosition = {
				x: draggedNode.position.x + draggedWidth / 2,
				y: draggedNode.position.y + draggedHeight / 2
			};

			const validCandidates = candidates.filter(
				(c) => c.id !== draggedNode.id && isTarget(c)
			);

			let bestTarget: TNode | null = null;
			let maxIntersectionArea = 0;
			let minDistance = Infinity;

			for (const candidate of validCandidates) {
				const candWidth = candidate.measured?.width ?? (candidate as any).width ?? 200;
				const candHeight = candidate.measured?.height ?? (candidate as any).height ?? 60;

				const candRect: Rect = {
					x: candidate.position.x,
					y: candidate.position.y,
					width: candWidth,
					height: candHeight
				};

				// Overlap bounds
				const overlapX = Math.max(
					0,
					Math.min(draggedNode.position.x + draggedWidth, candRect.x + candRect.width) -
						Math.max(draggedNode.position.x, candRect.x)
				);
				const overlapY = Math.max(
					0,
					Math.min(draggedNode.position.y + draggedHeight, candRect.y + candRect.height) -
						Math.max(draggedNode.position.y, candRect.y)
				);
				const overlapArea = overlapX * overlapY;

				if (strategy === 'max-overlap') {
					if (overlapArea > maxIntersectionArea) {
						maxIntersectionArea = overlapArea;
						bestTarget = candidate;
					}
				} else if (strategy === 'center-point') {
					const candCenter: XYPosition = {
						x: candRect.x + candRect.width / 2,
						y: candRect.y + candRect.height / 2
					};
					const dist = Math.hypot(
						draggedCenter.x - candCenter.x,
						draggedCenter.y - candCenter.y
					);
					if (overlapArea > 0 && dist < minDistance) {
						minDistance = dist;
						bestTarget = candidate;
					}
				} else if (strategy === 'first') {
					if (overlapArea > 0) return candidate;
				}
			}

			return bestTarget;
		},
		[isDockable, isTarget, strategy]
	);

	const updateDragOver = useCallback(
		(draggedNode: TNode, candidates: TNode[], cursorPos?: XYPosition) => {
			const target = findDockTarget(draggedNode, candidates, cursorPos);

			if (target?.id !== activeDockTargetRef.current?.id) {
				if (activeDockTargetRef.current) {
					onDockLeave?.(activeDockTargetRef.current, draggedNode);
				}
				activeDockTargetRef.current = target;
				if (target) {
					onDockHover?.(target, draggedNode);
				}
			}
		},
		[findDockTarget, onDockHover, onDockLeave]
	);

	const finalizeDock = useCallback(
		(draggedNode: TNode) => {
			if (activeDockTargetRef.current) {
				onDockDrop?.(activeDockTargetRef.current, draggedNode);
				activeDockTargetRef.current = null;
			}
		},
		[onDockDrop]
	);

	return {
		findDockTarget,
		updateDragOver,
		finalizeDock,
		getActiveDockTarget: () => activeDockTargetRef.current
	};
}
