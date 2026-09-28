import type { XYPosition } from '@xyflow/svelte';
import type { CanvasNode } from './types.js';

export interface MultiDragFollowerOffset {
	deltaX: number;
	deltaY: number;
	originalPosition: XYPosition;
	stackOffsetX: number;
	stackOffsetY: number;
	rotationDeg: number;
}

export interface MultiDragState {
	leadId: string;
	offsets: Record<string, MultiDragFollowerOffset>;
	count: number;
}

export interface CreateCanvasMultiDragOptions {
	/**
	 * Base horizontal fan-out offset per stacked follower card (default: 4px).
	 */
	stackOffsetStepX?: number;
	/**
	 * Base vertical fan-out offset per stacked follower card (default: 4px).
	 */
	stackOffsetStepY?: number;
	/**
	 * Alternating angular tilt in degrees for follower cards (default: [-2, 2.5, -3, 3]).
	 */
	rotationAngles?: number[];
	/**
	 * Base z-index for stacked cards during active dragging (default: 50).
	 */
	baseZIndex?: number;
}

export interface FollowerTransform {
	isFollower: boolean;
	stackOffsetX: number;
	stackOffsetY: number;
	rotationDeg: number;
	zIndex: number;
}

/**
 * Headless Svelte 5 rune orchestrating multi-node drag operations with stacked visual fanning,
 * dynamic z-index layering, and position restoration.
 */
export function createCanvasMultiDrag(options: CreateCanvasMultiDragOptions = {}) {
	const stepX = options.stackOffsetStepX ?? 4;
	const stepY = options.stackOffsetStepY ?? 4;
	const angles = options.rotationAngles ?? [-2, 2.5, -3, 3];
	const baseZIndex = options.baseZIndex ?? 50;

	let dragState = $state<MultiDragState | null>(null);

	function startMultiDrag(
		leadNodeId: string,
		selectedNodeIds: string[] | Set<string>,
		nodes: CanvasNode[] | Map<string, CanvasNode>
	): MultiDragState | null {
		const selectedSet =
			selectedNodeIds instanceof Set ? selectedNodeIds : new Set(selectedNodeIds);

		if (selectedSet.size <= 1 || !selectedSet.has(leadNodeId)) {
			dragState = null;
			return null;
		}

		const nodeMap =
			nodes instanceof Map ? nodes : new Map(nodes.map((n) => [n.id, n]));

		const leadNode = nodeMap.get(leadNodeId);
		if (!leadNode) {
			dragState = null;
			return null;
		}

		const leadPos = leadNode.position ?? { x: 0, y: 0 };
		const offsets: Record<string, MultiDragFollowerOffset> = {};
		let followerIndex = 0;

		for (const id of selectedSet) {
			if (id === leadNodeId) continue;
			const follower = nodeMap.get(id);
			const fPos = follower?.position ?? { x: 0, y: 0 };

			const angle = angles[followerIndex % angles.length];
			offsets[id] = {
				deltaX: fPos.x - leadPos.x,
				deltaY: fPos.y - leadPos.y,
				originalPosition: { ...fPos },
				stackOffsetX: (followerIndex + 1) * stepX,
				stackOffsetY: (followerIndex + 1) * stepY,
				rotationDeg: angle
			};
			followerIndex++;
		}

		const state: MultiDragState = {
			leadId: leadNodeId,
			offsets,
			count: selectedSet.size
		};

		dragState = state;
		return state;
	}

	function getFollowerTransform(nodeId: string): FollowerTransform {
		if (!dragState || !(nodeId in dragState.offsets)) {
			return {
				isFollower: false,
				stackOffsetX: 0,
				stackOffsetY: 0,
				rotationDeg: 0,
				zIndex: 0
			};
		}

		const offset = dragState.offsets[nodeId];
		const followerKeys = Object.keys(dragState.offsets);
		const index = followerKeys.indexOf(nodeId);

		return {
			isFollower: true,
			stackOffsetX: offset.stackOffsetX,
			stackOffsetY: offset.stackOffsetY,
			rotationDeg: offset.rotationDeg,
			zIndex: baseZIndex - (index + 1)
		};
	}

	function cancelMultiDrag(
		applyRestore?: (restores: { id: string; originalPosition: XYPosition }[]) => void
	): { id: string; originalPosition: XYPosition }[] {
		if (!dragState) return [];

		const restores = Object.entries(dragState.offsets).map(([id, offset]) => ({
			id,
			originalPosition: { ...offset.originalPosition }
		}));

		if (applyRestore) {
			applyRestore(restores);
		}

		dragState = null;
		return restores;
	}

	function commitMultiDrag(): void {
		dragState = null;
	}

	return {
		get dragState() {
			return dragState;
		},
		get isMultiDrag() {
			return Boolean(dragState && dragState.count > 1);
		},
		get count() {
			return dragState ? dragState.count : 0;
		},
		get leadId() {
			return dragState?.leadId ?? null;
		},
		startMultiDrag,
		getFollowerTransform,
		cancelMultiDrag,
		commitMultiDrag
	};
}
