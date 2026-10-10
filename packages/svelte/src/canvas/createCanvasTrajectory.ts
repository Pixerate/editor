import { cubicOut } from 'svelte/easing';
import { withStyleOpacity } from '@pixerate/editor/canvas';
import type { XYPosition } from '@xyflow/svelte';
import type {
	CanvasNode,
	FanOutTrajectoryOptions,
	NodeTransition,
	TrajectoryFunction,
	TrajectoryPoint
} from './types.js';

/**
 * Standard linear trajectory: straight line interpolation with linear scale & opacity progression.
 */
export const linearTrajectory: TrajectoryFunction = (
	origin: XYPosition,
	target: XYPosition,
	progress: number
): TrajectoryPoint => {
	return {
		position: {
			x: origin.x + (target.x - origin.x) * progress,
			y: origin.y + (target.y - origin.y) * progress
		},
		scale: progress,
		opacity: Math.min(1, progress * 1.5)
	};
};

/**
 * Linear position trajectory: pure position interpolation without altering scale or opacity.
 * Used for displaced sibling nodes to ensure their visibility remains unaltered.
 */
export const linearPositionTrajectory: TrajectoryFunction = (
	origin: XYPosition,
	target: XYPosition,
	progress: number
): TrajectoryPoint => {
	return {
		position: {
			x: origin.x + (target.x - origin.x) * progress,
			y: origin.y + (target.y - origin.y) * progress
		}
	};
};

/**
 * Creates a fan-out trajectory where nodes arc outward from origin to target.
 * Matches the curved distribution shown in multi-node branching diagrams.
 */
export function createFanOutTrajectory(options: FanOutTrajectoryOptions = {}): TrajectoryFunction {
	const {
		curvature = 0.4,
		startScale = 0,
		endScale = 1,
		startOpacity = 0,
		endOpacity = 1
	} = options;

	return (
		origin: XYPosition,
		target: XYPosition,
		progress: number,
		index: number,
		total: number
	): TrajectoryPoint => {
		const dx = target.x - origin.x;
		const dy = target.y - origin.y;

		// Normalized index from -1 (top) to +1 (bottom)
		const normIndex = total > 1 ? (index - (total - 1) / 2) / ((total - 1) / 2) : 0;

		// Perpendicular control point offset to create smooth fan arc
		const midX = origin.x + dx * 0.4;
		const midY = origin.y + dy * 0.1 - normIndex * Math.abs(dx) * 0.15 * curvature;

		// Quadratic Bezier interpolation: B(t) = (1-t)^2 * P0 + 2(1-t)t * P1 + t^2 * P2
		const t = progress;
		const oneMinusT = 1 - t;

		const x = oneMinusT * oneMinusT * origin.x + 2 * oneMinusT * t * midX + t * t * target.x;
		const y = oneMinusT * oneMinusT * origin.y + 2 * oneMinusT * t * midY + t * t * target.y;

		const scale = startScale + (endScale - startScale) * progress;
		const opacity = startOpacity + (endOpacity - startOpacity) * progress;

		return {
			position: { x, y },
			scale,
			opacity
		};
	};
}

/**
 * Creates a custom quadratic Bezier trajectory with a specified or dynamically calculated control point.
 */
export function createBezierTrajectory(
	getControlPoint: (origin: XYPosition, target: XYPosition) => XYPosition
): TrajectoryFunction {
	return (origin: XYPosition, target: XYPosition, progress: number): TrajectoryPoint => {
		const cp = getControlPoint(origin, target);
		const t = progress;
		const oneMinusT = 1 - t;

		const x = oneMinusT * oneMinusT * origin.x + 2 * oneMinusT * t * cp.x + t * t * target.x;
		const y = oneMinusT * oneMinusT * origin.y + 2 * oneMinusT * t * cp.y + t * t * target.y;

		return {
			position: { x, y },
			scale: progress,
			opacity: progress
		};
	};
}

/**
 * Coordinates and animates multiple node transitions simultaneously.
 *
 * Input nodes are never mutated: every frame produces updated copies (position,
 * `data.scale` / `data.opacity`, `style` opacity) which are passed to `onUpdate`
 * (and finally `onComplete`) in the same order as `transitions`. Both CSS-string and
 * object styles are supported. Merge the copies into your graph state by `id`.
 */
export function runMultiNodeTransition<TNode extends CanvasNode = CanvasNode>(
	transitions: NodeTransition<TNode>[],
	options: {
		defaultDuration?: number;
		defaultEasing?: (t: number) => number;
		onUpdate?: (nodes: TNode[]) => void;
		onComplete?: (nodes: TNode[]) => void;
	} = {}
): () => void {
	if (transitions.length === 0) {
		options.onComplete?.([]);
		return () => {};
	}

	const { defaultDuration = 400, defaultEasing = cubicOut, onUpdate, onComplete } = options;

	let isCancelled = false;
	const startTime = Date.now();

	const items = transitions.map((tr, i) => ({
		...tr,
		index: tr.index ?? i,
		total: tr.total ?? transitions.length,
		duration: tr.duration ?? defaultDuration,
		easing: tr.easing ?? defaultEasing,
		delay: tr.delay ?? 0,
		trajectory: tr.trajectory ?? linearTrajectory
	}));

	// Latest copy of every node; starts out as the untouched inputs.
	const current: TNode[] = items.map((item) => item.node);

	function frame() {
		if (isCancelled) return;

		const now = Date.now();
		let allCompleted = true;

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const elapsed = now - (startTime + item.delay);

			if (elapsed < 0) {
				allCompleted = false;
				continue;
			}

			const rawProgress = item.duration <= 0 ? 1 : Math.min(elapsed / item.duration, 1);
			const progress = item.duration <= 0 ? 1 : item.easing(rawProgress);

			const point = item.trajectory(item.from, item.to, progress, item.index, item.total);

			const next = { ...item.node, position: { ...point.position } } as TNode;

			if (point.scale !== undefined || point.opacity !== undefined) {
				const data: Record<string, any> = { ...(item.node.data ?? {}) };
				if (point.scale !== undefined) {
					data.scale = point.scale;
				}
				if (point.opacity !== undefined) {
					data.opacity = point.opacity;
					(next as any).style = withStyleOpacity((item.node as any).style, point.opacity);
				}
				(next as any).data = data;
			}

			current[i] = next;

			if (rawProgress < 1) {
				allCompleted = false;
			}
		}

		onUpdate?.(current.slice());

		if (!allCompleted) {
			if (typeof requestAnimationFrame !== 'undefined') {
				requestAnimationFrame(frame);
			}
		} else {
			onComplete?.(current.slice());
		}
	}

	frame();

	return () => {
		isCancelled = true;
	};
}
