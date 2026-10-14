import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
	createCanvasAnimationController,
	type AnimatableProperty,
	type AnimationHistoryTarget,
	type AnimationLoopMode,
	type CanvasNode,
	type Clock
} from '@pixerate/editor/canvas';

export interface UseCanvasAnimationOptions<TNode extends CanvasNode = CanvasNode> {
	nodes: TNode[];
	setNodes: (updater: TNode[] | ((prev: TNode[]) => TNode[])) => void;
	/** When set, keyframe edits are undoable steps. */
	history?: AnimationHistoryTarget;
	/** Ids acted on without explicit ids (default: nodes with `selected: true`). */
	getSelectedIds?: () => string[];
	/** Playback time source (default `realClock`); pass a `ManualClock` for tests or rendering. Read once. */
	clock?: Clock;
	/** Fixed timeline length (ms); omitted = the last keyframe, at least `minDuration`. Read once. */
	duration?: number;
	minDuration?: number;
	loop?: AnimationLoopMode;
	playbackRate?: number;
	fps?: number;
	recording?: boolean;
	properties?: readonly AnimatableProperty[];
	onTime?: (time: number) => void;
}

/**
 * React hook for keyframe animation on the canvas: a playhead player (play / pause / seek /
 * scrub, loop, ping-pong, rate), record mode, undoable keyframe edits, multi-keyframe drags
 * with snapping, copy / paste and CSS / Web Animations export.
 *
 * Render `displayNodes` (the nodes evaluated at the playhead) in React Flow and pass its edits
 * back through `applyDisplayChanges`:
 * `onNodesChange={(c) => animation.applyDisplayChanges(applyNodeChanges(c, animation.displayNodes))}`.
 * Animated properties are then keyed at the playhead instead of being overwritten.
 */
export function useCanvasAnimation<TNode extends CanvasNode = CanvasNode>(options: UseCanvasAnimationOptions<TNode>) {
	const nodesRef = useRef(options.nodes);
	nodesRef.current = options.nodes;
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const controller = useMemo(
		() =>
			createCanvasAnimationController<TNode>({
				getNodes: () => nodesRef.current,
				setNodes: (next) => {
					// Keep the ref current so consecutive edits (and undo) see the latest nodes.
					nodesRef.current = next;
					optionsRef.current.setNodes(next);
				},
				get history() {
					return optionsRef.current.history;
				},
				get getSelectedIds() {
					return optionsRef.current.getSelectedIds;
				},
				get properties() {
					return optionsRef.current.properties;
				},
				clock: options.clock,
				duration: options.duration,
				minDuration: options.minDuration,
				loop: options.loop,
				playbackRate: options.playbackRate,
				fps: options.fps,
				recording: options.recording,
				onTime: (time) => optionsRef.current.onTime?.(time)
			}),
		[]
	);

	useEffect(() => () => controller.destroy(), [controller]);

	// Option changes after mount.
	useEffect(() => {
		if (options.loop !== undefined) controller.setLoop(options.loop);
	}, [controller, options.loop]);
	useEffect(() => {
		if (options.playbackRate !== undefined) controller.setPlaybackRate(options.playbackRate);
	}, [controller, options.playbackRate]);
	useEffect(() => {
		if (options.recording !== undefined) controller.setRecording(options.recording);
	}, [controller, options.recording]);

	const state = useSyncExternalStore(
		(listener) => controller.subscribe(listener),
		() => controller.getState(),
		() => controller.getState()
	);

	// The automatic duration follows the nodes.
	useEffect(() => {
		controller.refresh();
	}, [controller, options.nodes]);

	const displayNodes = useMemo(() => controller.display(options.nodes), [controller, options.nodes, state.time]);

	return useMemo(
		() => ({
			...controller,
			state,
			time: state.time,
			playing: state.playing,
			recording: state.recording,
			duration: state.duration,
			selection: state.selection,
			drag: state.drag,
			/** The nodes evaluated at the playhead; render these. */
			displayNodes,
			get clipboard() {
				return controller.clipboard;
			}
		}),
		[controller, state, displayNodes]
	);
}

export type CanvasAnimation<TNode extends CanvasNode = CanvasNode> = ReturnType<typeof useCanvasAnimation<TNode>>;
