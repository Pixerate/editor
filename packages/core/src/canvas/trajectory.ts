import type {
	CanvasNode,
	CanvasNodeStyle,
	FanOutTrajectoryOptions,
	NodeTransition,
	TrajectoryFunction,
	TrajectoryPoint,
	XYPosition
} from './types.js';

/**
 * Standard cubic ease-out function (pure math, framework-agnostic).
 */
export const defaultEasing = (t: number): number => --t * t * t + 1;

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
 * Creates a custom quadratic Bezier trajectory with a specified control point resolver.
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

import { realClock, type Clock } from './clock.js';

/**
 * Returns a copy of `style` with its opacity set to `opacity`.
 *
 * Supports both CSS strings (`"color: red; opacity: 0.5;"`, used by SvelteFlow)
 * and style objects (`{ color: 'red', opacity: 0.5 }`, used by React Flow / xyflow).
 * When `style` is empty, `emptyFormat` decides which representation is produced.
 * Never mutates the input.
 */
export function withStyleOpacity(
	style: CanvasNodeStyle | undefined | null,
	opacity: number,
	emptyFormat: 'string' | 'object' = 'string'
): CanvasNodeStyle {
	if (style !== null && typeof style === 'object') {
		return { ...style, opacity };
	}
	if (typeof style === 'string' && style.trim() !== '') {
		const rest = style
			.replace(/(^|;)\s*opacity\s*:\s*[^;]*;?/gi, '$1')
			.trim()
			.replace(/;+\s*$/, '')
			.trim();
		return `${rest ? rest + '; ' : ''}opacity: ${opacity};`;
	}
	return emptyFormat === 'object' ? { opacity } : `opacity: ${opacity};`;
}

export interface MultiNodeTransitionOptions<TNode extends CanvasNode = CanvasNode> {
	defaultDuration?: number;
	defaultEasing?: (t: number) => number;
	clock?: Clock;
	/**
	 * Style representation to create for nodes that have no `style` yet when an opacity
	 * is applied. Defaults to `'string'` (SvelteFlow); pass `'object'` for React Flow.
	 * Existing styles always keep their representation.
	 */
	styleFormat?: 'string' | 'object';
	/**
	 * Called on every frame with updated copies of the transitioning nodes, in the same
	 * order as the `transitions` array. Input nodes are never mutated.
	 */
	onUpdate?: (nodes: TNode[]) => void;
	/** Called once all transitions finished, with the final node copies. */
	onComplete?: (nodes: TNode[]) => void;
}

/**
 * Coordinates and animates multiple node transitions simultaneously.
 *
 * The input nodes are treated as immutable: every frame produces updated copies
 * (position, `data.scale` / `data.opacity`, and `style` opacity) which are handed to
 * `onUpdate` and finally `onComplete`. Merge them into your node state by `id`.
 */
export function runMultiNodeTransition<TNode extends CanvasNode = CanvasNode>(
	transitions: NodeTransition<TNode>[],
	options: MultiNodeTransitionOptions<TNode> = {}
): () => void {
	if (transitions.length === 0) {
		options.onComplete?.([]);
		return () => {};
	}

	const {
		defaultDuration = 400,
		defaultEasing: easingFunc = defaultEasing,
		clock = realClock,
		styleFormat = 'string',
		onUpdate,
		onComplete
	} = options;

	let isCancelled = false;
	const startTime = clock.now();

	const items = transitions.map((tr, i) => ({
		...tr,
		index: tr.index ?? i,
		total: tr.total ?? transitions.length,
		duration: tr.duration ?? defaultDuration,
		easing: tr.easing ?? easingFunc,
		delay: tr.delay ?? 0,
		trajectory: tr.trajectory ?? linearTrajectory
	}));

	// Latest copy of every node; starts out as the untouched inputs.
	const current: TNode[] = items.map((item) => item.node);

	function frame() {
		if (isCancelled) return;

		const now = clock.now();
		let allCompleted = true;

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const elapsed = now - (startTime + item.delay);

			if (elapsed < 0) {
				allCompleted = false;
				continue;
			}

			// Guard zero duration and division by zero (referenced in GOTCHAS.md)
			const rawProgress = item.duration <= 0 ? 1 : Math.min(elapsed / item.duration, 1);
			const progress = item.duration <= 0 ? 1 : item.easing(rawProgress);

			const point = item.trajectory(item.from, item.to, progress, item.index, item.total);

			const next: TNode = { ...item.node, position: { ...point.position } };

			if (point.scale !== undefined || point.opacity !== undefined) {
				const data: Record<string, any> = { ...(item.node.data ?? {}) };
				if (point.scale !== undefined) {
					data.scale = point.scale;
				}
				if (point.opacity !== undefined) {
					data.opacity = point.opacity;
					(next as CanvasNode).style = withStyleOpacity(item.node.style, point.opacity, styleFormat);
				}
				(next as CanvasNode).data = data;
			}

			current[i] = next;

			if (rawProgress < 1) {
				allCompleted = false;
			}
		}

		onUpdate?.(current.slice());

		if (!allCompleted) {
			clock.frame().then(frame);
		} else {
			onComplete?.(current.slice());
		}
	}

	frame();

	return () => {
		isCancelled = true;
	};
}
