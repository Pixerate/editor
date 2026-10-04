import { realClock, type Clock } from './clock.js';
import { ensureLayout } from './layout.js';
import { linearPositionTrajectory, runMultiNodeTransition } from './trajectory.js';
import type { CanvasEdge, CanvasNode, IncrementalLayoutOptions, NodeTransition, XYPosition } from './types.js';
import { connectedOnly } from './view.js';

export interface StreamingLayoutManagerOptions {
	throttleMs?: number;
	glideDurationMs?: number;
	connectedOnly?: boolean;
	clock?: Clock;
	layoutOptions?: IncrementalLayoutOptions;
	onLayoutUpdated?: (positions: Map<string, XYPosition>) => void;
}

/**
 * Manages throttled incremental layout recalculation and smooth tweened node gliding
 * during active streaming (e.g. LLM streaming or graph generation).
 */
export class StreamingLayoutManager<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
> {
	private throttleMs: number;
	private glideDurationMs: number;
	private connectedOnly: boolean;
	private clock: Clock;
	private layoutOptions: IncrementalLayoutOptions;
	private onLayoutUpdated?: (positions: Map<string, XYPosition>) => void;

	private pendingTimer: any = null;
	private activeTransitionCancel: (() => void) | null = null;
	private targetPositions = new Map<string, XYPosition>();

	constructor(options: StreamingLayoutManagerOptions = {}) {
		this.throttleMs = options.throttleMs ?? 200;
		this.glideDurationMs = options.glideDurationMs ?? 300;
		this.connectedOnly = options.connectedOnly ?? false;
		this.clock = options.clock ?? realClock;
		this.layoutOptions = options.layoutOptions ?? { direction: 'LR' };
		this.onLayoutUpdated = options.onLayoutUpdated;
	}

	/**
	 * Feed incoming nodes and edges into the streaming manager.
	 * Coalesces rapid streaming bursts and triggers smooth layout gliding.
	 */
	public pushStreamUpdate(
		nodes: TNode[],
		edges: TEdge[],
		currentPositions: Map<string, XYPosition>
	): void {
		if (this.pendingTimer) {
			clearTimeout(this.pendingTimer);
		}

		this.pendingTimer = setTimeout(() => {
			this.pendingTimer = null;
			this.recalculateAndGlide(nodes, edges, currentPositions);
		}, this.throttleMs);
	}

	/**
	 * Forces immediate calculation and cancels pending throttled timers.
	 */
	public flush(
		nodes: TNode[],
		edges: TEdge[],
		currentPositions: Map<string, XYPosition>
	): void {
		if (this.pendingTimer) {
			clearTimeout(this.pendingTimer);
			this.pendingTimer = null;
		}
		this.recalculateAndGlide(nodes, edges, currentPositions);
	}

	private recalculateAndGlide(
		nodes: TNode[],
		edges: TEdge[],
		currentPositions: Map<string, XYPosition>
	): void {
		const targetNodes = this.connectedOnly ? connectedOnly(nodes, edges) : nodes;
		if (targetNodes.length === 0) return;

		// Cancel any currently running RAF glide
		if (this.activeTransitionCancel) {
			this.activeTransitionCancel();
			this.activeTransitionCancel = null;
		}

		// Incremental layout preserves existing nodes and aligns new nodes
		const stored: Record<string, XYPosition> = {};
		for (const [id, pos] of currentPositions.entries()) {
			stored[id] = pos;
		}

		const layouted = ensureLayout(targetNodes, edges, {
			...this.layoutOptions,
			storedPositions: stored
		});

		const nextPositions = new Map<string, XYPosition>();
		const transitions: NodeTransition<TNode>[] = [];

		for (const node of layouted) {
			const target = node.position;
			nextPositions.set(node.id, target);

			const current = currentPositions.get(node.id) ?? target;
			const distance = Math.hypot(target.x - current.x, target.y - current.y);

			if (distance > 2) {
				transitions.push({
					node,
					from: current,
					to: target,
					trajectory: linearPositionTrajectory,
					duration: this.glideDurationMs
				});
			}
		}

		this.targetPositions = nextPositions;

		if (transitions.length > 0) {
			this.activeTransitionCancel = runMultiNodeTransition(transitions, {
				clock: this.clock,
				onUpdate: () => {
					// Broadcast updated positions during RAF
					const liveMap = new Map<string, XYPosition>(currentPositions);
					for (const trans of transitions) {
						liveMap.set(trans.node.id, { ...trans.node.position });
					}
					this.onLayoutUpdated?.(liveMap);
				},
				onComplete: () => {
					this.activeTransitionCancel = null;
					this.onLayoutUpdated?.(nextPositions);
				}
			});
		} else {
			this.onLayoutUpdated?.(nextPositions);
		}
	}

	public destroy(): void {
		if (this.pendingTimer) {
			clearTimeout(this.pendingTimer);
			this.pendingTimer = null;
		}
		if (this.activeTransitionCancel) {
			this.activeTransitionCancel();
			this.activeTransitionCancel = null;
		}
	}
}
