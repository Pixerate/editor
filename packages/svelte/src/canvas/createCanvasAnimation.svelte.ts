import {
	createCanvasAnimationController,
	type AnimatableProperty,
	type AnimationHistoryTarget,
	type AnimationLoopMode,
	type CanvasAnimationState,
	type Clock
} from '@pixerate/editor/canvas';
import type { CanvasNode } from './types.js';

export interface CreateCanvasAnimationOptions<TNode extends CanvasNode = CanvasNode> {
	getNodes: () => TNode[];
	setNodes: (nodes: TNode[]) => void;
	/** When set, keyframe edits are undoable steps. */
	history?: AnimationHistoryTarget;
	/** Ids acted on without explicit ids (default: nodes with `selected: true`). */
	getSelectedIds?: () => string[];
	/** Playback time source (default `realClock`); pass a `ManualClock` for tests or rendering. */
	clock?: Clock;
	/** Fixed timeline length (ms); omitted = the last keyframe, at least `minDuration`. */
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
 * Headless Svelte 5 rune for keyframe animation on the canvas (the Svelte twin of
 * `useCanvasAnimation`): playback on an injectable clock, record mode, undoable keyframe
 * edits, multi-keyframe drags with snapping, copy / paste and CSS / Web Animations export.
 *
 * Render `displayNodes` (the nodes evaluated at the playhead) and route edits made on them
 * through `applyDisplayChanges`, so animated properties are keyed at the playhead. Call
 * `refresh()` after changing the nodes yourself so the automatic duration follows them.
 */
export function createCanvasAnimation<TNode extends CanvasNode = CanvasNode>(options: CreateCanvasAnimationOptions<TNode>) {
	const controller = createCanvasAnimationController<any>({
		getNodes: () => options.getNodes() as any[],
		setNodes: (next) => {
			options.setNodes(next as TNode[]);
			// Edits, undo and redo re-render views even when the nodes are not `$state`.
			revision++;
			controller.refresh();
		},
		history: options.history,
		getSelectedIds: options.getSelectedIds,
		clock: options.clock,
		duration: options.duration,
		minDuration: options.minDuration,
		loop: options.loop,
		playbackRate: options.playbackRate,
		fps: options.fps,
		recording: options.recording,
		properties: options.properties,
		onTime: (time) => options.onTime?.(time)
	});
	let state = $state.raw<CanvasAnimationState>(controller.getState());
	let revision = $state(0);
	const unsubscribe = controller.subscribe((next) => {
		state = next;
	});

	return {
		...controller,
		/** Playback, selection and drag state (reactive). */
		get state() {
			return state;
		},
		get time() {
			return state.time;
		},
		get playing() {
			return state.playing;
		},
		get recording() {
			return state.recording;
		},
		get duration() {
			return state.duration;
		},
		get selection() {
			return state.selection;
		},
		get drag() {
			return state.drag;
		},
		/** Bumped whenever the rune writes the nodes (edits, undo, redo). */
		get revision() {
			return revision;
		},
		get clipboard() {
			return controller.clipboard;
		},
		/** The nodes evaluated at the playhead (re-read when the time or the nodes change). */
		get displayNodes(): TNode[] {
			void state.time;
			void revision;
			return controller.display(options.getNodes() as any[]) as TNode[];
		},
		destroy() {
			unsubscribe();
			controller.destroy();
		}
	};
}

export type SvelteCanvasAnimation<TNode extends CanvasNode = CanvasNode> = ReturnType<typeof createCanvasAnimation<TNode>>;
