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
 *
 * - `pushStreamUpdate` is a true throttle (leading + trailing edge): the first update
 *   lays out immediately, further updates within `throttleMs` are coalesced and the
 *   latest one is laid out when the window closes. Layouts therefore keep running at
 *   most once per `throttleMs` while a stream is active, instead of being postponed
 *   until the stream goes quiet.
 * - Every layout is computed from the graph (respecting `layoutOptions.storedPositions`
 *   as pinned/manual coordinates) and each known node glides from its *current*
 *   position (the `currentPositions` argument) to its newly computed position.
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

	private pendingTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingArgs: [TNode[], TEdge[], Map<string, XYPosition>] | null = null;
	private activeTransitionCancel: (() => void) | null = null;
	private targetPositions = new Map<string, XYPosition>();
	private livePositions = new Map<string, XYPosition>();

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
	 * Throttles rapid streaming bursts (leading + trailing edge) and triggers smooth layout gliding.
	 */
	public pushStreamUpdate(
		nodes: TNode[],
		edges: TEdge[],
		currentPositions: Map<string, XYPosition>
	): void {
		if (this.pendingTimer !== null) {
			// Inside the throttle window: remember the latest update for the trailing edge.
			this.pendingArgs = [nodes, edges, currentPositions];
			return;
		}

		// Leading edge: lay out immediately and open a throttle window.
		this.recalculateAndGlide(nodes, edges, currentPositions);
		this.startWindow();
	}

	private startWindow(): void {
		this.pendingTimer = setTimeout(() => {
			this.pendingTimer = null;
			const args = this.pendingArgs;
			this.pendingArgs = null;
			if (args) {
				// Trailing edge: lay out the latest coalesced update and keep throttling.
				this.recalculateAndGlide(...args);
				this.startWindow();
			}
		}, Math.max(0, this.throttleMs));
	}

	/**
	 * Forces immediate calculation and cancels pending throttled timers.
	 */
	public flush(
		nodes: TNode[],
		edges: TEdge[],
		currentPositions: Map<string, XYPosition>
	): void {
		this.clearPending();
		this.recalculateAndGlide(nodes, edges, currentPositions);
	}

	/**
	 * Latest computed layout targets (the positions nodes are gliding towards).
	 */
	public getTargetPositions(): Map<string, XYPosition> {
		return new Map(this.targetPositions);
	}

	private clearPending(): void {
		if (this.pendingTimer !== null) {
			clearTimeout(this.pendingTimer);
			this.pendingTimer = null;
		}
		this.pendingArgs = null;
	}

	private recalculateAndGlide(
		nodes: TNode[],
		edges: TEdge[],
		currentPositions: Map<string, XYPosition>
	): void {
		const targetNodes = this.connectedOnly ? connectedOnly(nodes, edges) : nodes;
		if (targetNodes.length === 0) return;

		// Where nodes are right now: the caller's view, overridden by any glide still in
		// flight (the caller may not have applied the latest animated frame yet).
		const startPositions = new Map<string, XYPosition>(currentPositions);
		if (this.activeTransitionCancel) {
			for (const [id, pos] of this.livePositions) {
				startPositions.set(id, pos);
			}
			this.activeTransitionCancel();
			this.activeTransitionCancel = null;
		}

		// Compute fresh layout targets. Only explicitly stored (pinned/manual) positions
		// are preserved; current positions are the glide *origin*, not the destination.
		const layouted = ensureLayout(targetNodes, edges, this.layoutOptions);

		const nextPositions = new Map<string, XYPosition>();
		const transitions: NodeTransition<TNode>[] = [];

		for (const node of layouted) {
			const target = { ...node.position };
			nextPositions.set(node.id, target);

			const current = startPositions.get(node.id);
			if (!current) continue; // brand-new node: appears directly at its target

			const distance = Math.hypot(target.x - current.x, target.y - current.y);
			if (distance > 2) {
				transitions.push({
					node: { ...node, position: { ...current } },
					from: current,
					to: target,
					trajectory: linearPositionTrajectory,
					duration: this.glideDurationMs
				});
			}
		}

		this.targetPositions = nextPositions;

		if (transitions.length === 0) {
			this.livePositions = new Map(nextPositions);
			this.onLayoutUpdated?.(nextPositions);
			return;
		}

		const live = new Map<string, XYPosition>(nextPositions);
		for (const trans of transitions) {
			live.set(trans.node.id, { ...trans.from });
		}
		this.livePositions = live;

		let finished = false;
		const cancel = runMultiNodeTransition(transitions, {
			clock: this.clock,
			onUpdate: (updated) => {
				const frame = new Map<string, XYPosition>(this.livePositions);
				for (const node of updated) {
					frame.set(node.id, { ...node.position });
				}
				this.livePositions = frame;
				this.onLayoutUpdated?.(frame);
			},
			onComplete: () => {
				finished = true;
				this.activeTransitionCancel = null;
				this.livePositions = new Map(nextPositions);
				this.onLayoutUpdated?.(nextPositions);
			}
		});
		// A zero-duration glide completes synchronously; don't keep a stale canceller.
		this.activeTransitionCancel = finished ? null : cancel;
	}

	public destroy(): void {
		this.clearPending();
		if (this.activeTransitionCancel) {
			this.activeTransitionCancel();
			this.activeTransitionCancel = null;
		}
	}
}
