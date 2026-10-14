// Portions ported from filmcraft-main/crates/engine/src/keyframe_move.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import type { Command, MergedExecutionOptions } from '../../history/types.js';
import type { Clock } from '../clock.js';
import type { CanvasNode } from '../types.js';
import type { AnimationEasing } from './easing.js';
import {
	addKeyframesAtTime,
	animateNode,
	copyKeyframes,
	deleteKeyframes,
	getKeyframeTimes,
	moveKeyframes,
	pasteKeyframes,
	recordAnimationChanges,
	removeTrack,
	scaleKeyframes,
	setKeyframe,
	setKeyframeEasing,
	setMotionPath,
	setTrackEnabled,
	snapKeyframeDelta,
	snapTimeToFrame,
	updateKeyframe,
	type AnimateNodeOptions,
	type AnimationKeyframeClipboard,
	type KeyframePatch,
	type KeyframeRef
} from './edit.js';
import { applyAnimation, getAnimationDuration, type AnimationLoopMode } from './evaluate.js';
import { exportCssAnimation, sampleAnimationFrames, toWebAnimations, type CssExportOptions, type SampleAnimationOptions } from './export.js';
import { ANIMATION_DATA_KEY, ANIMATION_TIME_EPSILON, getNodeAnimation, normalizeKeyframes, type AnimatableProperty, type AnimationValue } from './model.js';
import { AnimationPlayer, type AnimationPlayerState } from './player.js';
import { getTimelineRows, isKeyframeSelected, type TimelineRow, type TimelineRowsOptions } from './timeline.js';

/** History surface (`HistoryManager` satisfies it). */
export interface AnimationHistoryTarget {
	execute(command: Command): void;
	executeMerged?(command: Command, options?: MergedExecutionOptions): void;
}

export interface KeyframeDragState {
	refs: KeyframeRef[];
	/** Offset previewed (after clamping and snapping). */
	delta: number;
	/** Time snapped to, for a snap guide. */
	target: number | null;
}

export interface CanvasAnimationState extends AnimationPlayerState {
	/** Record mode: changing an unanimated property at the playhead keys it. */
	recording: boolean;
	/** Frame rate used for frame snapping and export (default 30). */
	fps: number;
	selection: readonly KeyframeRef[];
	drag: KeyframeDragState | null;
	/** Whether the duration follows the last keyframe (`setDuration(null)`). */
	autoDuration: boolean;
}

export interface CanvasAnimationControllerOptions<TNode extends CanvasNode = CanvasNode> {
	getNodes: () => TNode[];
	setNodes: (nodes: TNode[]) => void;
	/** When set, keyframe edits are undoable steps (recording merges a drag into one step). */
	history?: AnimationHistoryTarget;
	/** Ids acted on without explicit ids (default: nodes with `selected: true`). */
	getSelectedIds?: () => string[];
	/** Time source for playback (default `realClock`). */
	clock?: Clock;
	/** Fixed timeline length in ms; omitted = the last keyframe time, at least `minDuration`. */
	duration?: number;
	/** Shortest automatic duration (default 1000 ms). */
	minDuration?: number;
	loop?: AnimationLoopMode;
	playbackRate?: number;
	fps?: number;
	recording?: boolean;
	properties?: readonly AnimatableProperty[];
	/** Called when the playhead moves. */
	onTime?: (time: number) => void;
	onChange?: (state: CanvasAnimationState) => void;
}

const uniq = <T>(items: Iterable<T>) => [...new Set(items)];

/**
 * Framework-agnostic animation controller shared by the React hook and the Svelte rune:
 * playback (on an injected clock), record mode, keyframe editing with undo, multi-keyframe
 * drag with snapping, copy / paste and export.
 *
 * Render `display()` (the nodes evaluated at the playhead) and route edits made on the
 * displayed nodes through `applyDisplayChanges`, so animated properties are keyed instead of
 * being overwritten by the next frame.
 */
export function createCanvasAnimationController<TNode extends CanvasNode = CanvasNode>(options: CanvasAnimationControllerOptions<TNode>) {
	let fixedDuration: number | null = options.duration !== undefined && options.duration > 0 ? options.duration : null;
	let recording = options.recording ?? false;
	let fps = options.fps && options.fps > 0 ? options.fps : 30;
	let selection: KeyframeRef[] = [];
	let drag: KeyframeDragState | null = null;
	let clipboard: AnimationKeyframeClipboard | null = null;
	const listeners = new Set<(state: CanvasAnimationState) => void>();
	const propertyOptions = () => (options.properties ? { properties: options.properties } : {});

	const durationOf = (nodes: readonly CanvasNode[]) =>
		fixedDuration ?? Math.max(options.minDuration ?? 1000, getAnimationDuration(nodes));

	let durationNodes: readonly CanvasNode[] | null = null;
	let durationValue = 0;
	const duration = () => {
		const nodes = options.getNodes();
		if (nodes !== durationNodes) {
			durationNodes = nodes;
			durationValue = durationOf(nodes);
		}
		return fixedDuration ?? durationValue;
	};

	const player = new AnimationPlayer({
		clock: options.clock,
		duration,
		loop: options.loop,
		playbackRate: options.playbackRate,
		onTime: (time) => options.onTime?.(time)
	});

	let cached: CanvasAnimationState | null = null;
	const snapshot = (): CanvasAnimationState => ({
		...player.getState(),
		duration: duration(),
		recording,
		fps,
		selection,
		drag,
		autoDuration: fixedDuration === null
	});
	const getState = (): CanvasAnimationState => {
		const next = snapshot();
		if (
			cached &&
			cached.time === next.time &&
			cached.playing === next.playing &&
			cached.scrubbing === next.scrubbing &&
			cached.loop === next.loop &&
			cached.playbackRate === next.playbackRate &&
			cached.duration === next.duration &&
			cached.recording === next.recording &&
			cached.fps === next.fps &&
			cached.selection === next.selection &&
			cached.drag === next.drag &&
			cached.autoDuration === next.autoDuration
		) {
			return cached;
		}
		cached = next;
		return cached;
	};
	const notify = () => {
		const state = getState();
		options.onChange?.(state);
		for (const listener of listeners) listener(state);
	};
	player.subscribe(notify);

	const selectedIds = () => options.getSelectedIds?.() ?? options.getNodes().filter((n) => n.selected).map((n) => n.id);

	// ----- applying edits -----------------------------------------------------------------

	const KEEP_FIELDS = ['selected', 'dragging', 'measured'] as const;
	const replaceNodes = (nodes: TNode[], replacements: Map<string, TNode>, animationOnly = false): TNode[] =>
		nodes.map((node) => {
			const replacement = replacements.get(node.id);
			if (!replacement) return node;
			if (animationOnly) {
				const data: Record<string, any> = { ...(node.data ?? {}) };
				const value = replacement.data?.[ANIMATION_DATA_KEY];
				if (value === undefined) delete data[ANIMATION_DATA_KEY];
				else data[ANIMATION_DATA_KEY] = value;
				return { ...node, data } as TNode;
			}
			const next: Record<string, any> = { ...replacement };
			for (const field of KEEP_FIELDS) {
				if (field in node) next[field] = node[field];
				else delete next[field];
			}
			return next as TNode;
		});

	/** Runs a pure edit as one (optionally undoable) step; returns whether anything changed. */
	function commit(name: string, edit: (nodes: TNode[]) => TNode[], merge?: { tag: string; windowMs?: number; animationOnly?: boolean }): boolean {
		const before = options.getNodes();
		const after = edit(before);
		if (after === before) return false;
		const beforeById = new Map(before.map((n) => [n.id, n]));
		const undoMap = new Map<string, TNode>();
		const redoMap = new Map<string, TNode>();
		for (const node of after) {
			const old = beforeById.get(node.id);
			if (old && old !== node) {
				undoMap.set(node.id, old);
				redoMap.set(node.id, node);
			}
		}
		if (redoMap.size === 0) return false;
		const scope = merge?.animationOnly ?? false;
		const execute = () => options.setNodes(replaceNodes(options.getNodes(), redoMap, scope));
		const undo = () => options.setNodes(replaceNodes(options.getNodes(), undoMap, scope));
		const command: Command = { name, execute, undo, ...(merge ? { tag: merge.tag } : {}) };
		if (!options.history) execute();
		else if (merge && options.history.executeMerged) options.history.executeMerged(command, { windowMs: merge.windowMs ?? 1000 });
		else options.history.execute(command);
		return true;
	}

	/** Drops selected refs that no longer exist. */
	function pruneSelection() {
		if (selection.length === 0) return;
		const byId = new Map(options.getNodes().map((n) => [n.id, n]));
		const kept = selection.filter((ref) => {
			const track = getNodeAnimation(byId.get(ref.nodeId))?.tracks[ref.property];
			return !!track && normalizeKeyframes(track.keyframes).some((k) => Math.abs(k.time - ref.time) <= ANIMATION_TIME_EPSILON);
		});
		if (kept.length !== selection.length) selection = kept;
	}

	const setSelection = (refs: KeyframeRef[]) => {
		selection = refs.map((r) => ({ nodeId: r.nodeId, property: r.property, time: r.time }));
	};

	let displayCache: { nodes: readonly TNode[]; time: number; out: TNode[] } | null = null;
	function display(nodes: readonly TNode[] = options.getNodes()): TNode[] {
		const time = player.currentTime;
		if (displayCache && displayCache.nodes === nodes && displayCache.time === time) return displayCache.out;
		const out = applyAnimation(nodes, time, propertyOptions());
		displayCache = { nodes, time, out };
		return out;
	}

	const controller = {
		player,
		getState,
		subscribe(listener: (state: CanvasAnimationState) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/** Re-reads node-derived state (the automatic duration) and notifies when it changed. */
		refresh() {
			const prev = cached;
			if (getState() !== prev) notify();
		},

		// ----- playback ---------------------------------------------------------------------
		get time() {
			return player.currentTime;
		},
		get playing() {
			return player.isPlaying;
		},
		get duration() {
			return duration();
		},
		play: () => player.play(),
		pause: () => player.pause(),
		toggle: () => player.toggle(),
		stop: () => player.stop(),
		seek: (time: number) => player.seek(time),
		scrub: (time: number) => player.scrub(time),
		endScrub: () => player.endScrub(),
		setLoop: (loop: AnimationLoopMode) => player.setLoop(loop),
		setPlaybackRate: (rate: number) => player.setPlaybackRate(rate),
		/** Fixed duration in ms, or `null` to follow the last keyframe. */
		setDuration(ms: number | null) {
			fixedDuration = ms !== null && Number.isFinite(ms) && ms > 0 ? ms : null;
			durationNodes = null;
			player.setDuration(duration);
			notify();
		},
		setFps(value: number) {
			if (!(value > 0) || value === fps) return;
			fps = value;
			notify();
		},
		setRecording(on: boolean) {
			if (recording === on) return;
			recording = on;
			notify();
		},
		toggleRecording() {
			controller.setRecording(!recording);
		},
		/** Seeks to the next keyframe (of the selected nodes, or all) after the playhead. */
		nextKeyframe(ids: Iterable<string> = selectedIds()): number | null {
			const list = [...ids];
			const times = getKeyframeTimes(options.getNodes(), list.length ? { ids: list } : {});
			const next = times.find((t) => t > player.currentTime + ANIMATION_TIME_EPSILON);
			if (next === undefined) return null;
			player.seek(next);
			return next;
		},
		previousKeyframe(ids: Iterable<string> = selectedIds()): number | null {
			const list = [...ids];
			const times = getKeyframeTimes(options.getNodes(), list.length ? { ids: list } : {});
			const prev = [...times].reverse().find((t) => t < player.currentTime - ANIMATION_TIME_EPSILON);
			if (prev === undefined) return null;
			player.seek(prev);
			return prev;
		},

		// ----- display ----------------------------------------------------------------------
		/** The nodes evaluated at the playhead (same array when nothing is animated). */
		display,
		/**
		 * Applies edits made on the displayed nodes: animated properties (and, in record mode,
		 * any property) are keyed at the playhead; other changes go to the stored nodes.
		 * Keying is one undo step per node set, merged while a drag continues.
		 */
		applyDisplayChanges(next: TNode[]): KeyframeRef[] {
			const base = options.getNodes();
			const shown = display(base);
			const time = player.currentTime;
			const { nodes, keyed } = recordAnimationChanges(base, shown, next, time, { recording, ...propertyOptions() });
			if (keyed.length === 0) {
				if (nodes !== base) options.setNodes(nodes);
				return [];
			}
			// Static edits apply directly; the keyframes are the undoable part.
			const ids = new Set(keyed.map((k) => k.nodeId));
			const baseById = new Map(base.map((n) => [n.id, n]));
			const staticNodes = nodes.map((n) => {
				if (!ids.has(n.id)) return n;
				const old = baseById.get(n.id)?.data?.[ANIMATION_DATA_KEY];
				const data: Record<string, any> = { ...(n.data ?? {}) };
				if (old === undefined) delete data[ANIMATION_DATA_KEY];
				else data[ANIMATION_DATA_KEY] = old;
				return { ...n, data } as TNode;
			});
			const animationOf = new Map(nodes.filter((n) => ids.has(n.id)).map((n) => [n.id, n.data?.[ANIMATION_DATA_KEY]]));
			options.setNodes(staticNodes);
			const tag = `animation.record:${[...ids].sort().join(',')}`;
			commit(
				'Record Keyframe',
				(current) =>
					current.map((n) => {
						if (!animationOf.has(n.id)) return n;
						const data: Record<string, any> = { ...(n.data ?? {}) };
						const value = animationOf.get(n.id);
						if (value === undefined) delete data[ANIMATION_DATA_KEY];
						else data[ANIMATION_DATA_KEY] = value;
						return { ...n, data } as TNode;
					}),
				{ tag, animationOnly: true }
			);
			return keyed;
		},

		// ----- editing ----------------------------------------------------------------------
		/** Keys the nodes (default: selected) at the playhead; see `addKeyframesAtTime`. */
		addKeyframe(ids?: Iterable<string>, keys?: readonly string[], time = player.currentTime): KeyframeRef[] {
			let refs: KeyframeRef[] = [];
			commit('Add Keyframe', (nodes) => {
				const result = addKeyframesAtTime(nodes, ids ?? selectedIds(), time, { ...propertyOptions(), ...(keys ? { keys } : {}) });
				refs = result.refs;
				return result.nodes;
			});
			if (refs.length) setSelection(refs);
			notify();
			return refs;
		},
		setKeyframe(nodeId: string, property: string, value: AnimationValue, time = player.currentTime, easing?: AnimationEasing | string) {
			commit('Set Keyframe', (nodes) => setKeyframe(nodes, nodeId, property, time, value, { ...propertyOptions(), ...(easing !== undefined ? { easing } : {}) }));
		},
		updateKeyframe(ref: KeyframeRef, patch: KeyframePatch) {
			commit('Edit Keyframe', (nodes) => updateKeyframe(nodes, ref, patch, propertyOptions()));
			if (patch.time !== undefined && isKeyframeSelected(selection, ref)) {
				setSelection(selection.map((s) => (isKeyframeSelected([ref], s) ? { ...s, time: Math.max(0, patch.time!) } : s)));
			}
			pruneSelection();
			notify();
		},
		deleteKeyframes(refs: readonly KeyframeRef[] = selection): boolean {
			if (refs.length === 0) return false;
			const changed = commit(refs.length === 1 ? 'Delete Keyframe' : 'Delete Keyframes', (nodes) => deleteKeyframes(nodes, refs, propertyOptions()));
			pruneSelection();
			notify();
			return changed;
		},
		setEasing(easing: AnimationEasing | string | null, refs: readonly KeyframeRef[] = selection): boolean {
			if (refs.length === 0) return false;
			return commit('Set Easing', (nodes) => setKeyframeEasing(nodes, refs, easing, propertyOptions()));
		},
		setTrackEnabled(nodeId: string, property: string, enabled: boolean) {
			commit(enabled ? 'Enable Track' : 'Disable Track', (nodes) => setTrackEnabled(nodes, nodeId, property, enabled));
		},
		removeTrack(nodeId: string, property: string) {
			commit('Remove Track', (nodes) => removeTrack(nodes, nodeId, property, { ...propertyOptions(), keepValueAt: player.currentTime }));
			pruneSelection();
			notify();
		},
		setMotionPath(nodeId: string, motionPath: { d: string; autoRotate?: boolean } | null) {
			commit('Set Motion Path', (nodes) => setMotionPath(nodes, nodeId, motionPath));
		},
		/** Animates a node to `to` (from its current values) over `duration`; see `animateNode`. */
		animateNode(nodeId: string, opts: Omit<AnimateNodeOptions, 'properties'>): KeyframeRef[] {
			let refs: KeyframeRef[] = [];
			commit('Animate', (nodes) => {
				const result = animateNode(nodes, nodeId, { ...opts, ...propertyOptions() });
				refs = result.refs;
				return result.nodes;
			});
			return refs;
		},
		/** Moves keyframes (default: selected) by `delta` ms as one step; returns the delta applied. */
		moveKeyframes(delta: number, refs: readonly KeyframeRef[] = selection): number {
			if (refs.length === 0) return 0;
			let applied = 0;
			let moved: KeyframeRef[] = [];
			commit(refs.length === 1 ? 'Move Keyframe' : 'Move Keyframes', (nodes) => {
				const result = moveKeyframes(nodes, refs, delta);
				applied = result.delta;
				moved = result.refs;
				return result.nodes;
			});
			if (applied !== 0 && refs === selection) setSelection(moved);
			notify();
			return applied;
		},
		/** Scales keyframe spacing (default: selected) around `pivot`; returns the factor applied. */
		scaleKeyframes(factor: number, refs: readonly KeyframeRef[] = selection, pivot?: number): number {
			if (refs.length === 0) return 1;
			let applied = 1;
			let scaled: KeyframeRef[] = [];
			commit('Scale Keyframes', (nodes) => {
				const result = scaleKeyframes(nodes, refs, factor, pivot === undefined ? {} : { pivot });
				applied = result.factor;
				scaled = result.refs;
				return result.nodes;
			});
			if (applied !== 1 && refs === selection) setSelection(scaled);
			notify();
			return applied;
		},
		copyKeyframes(refs: readonly KeyframeRef[] = selection): AnimationKeyframeClipboard | null {
			if (refs.length === 0) return null;
			clipboard = copyKeyframes(options.getNodes(), refs);
			return clipboard;
		},
		/** Pastes at the playhead onto the selected nodes (or the copied ones). */
		pasteKeyframes(data: AnimationKeyframeClipboard | null = clipboard, nodeIds: readonly string[] = selectedIds(), time = player.currentTime): KeyframeRef[] {
			if (!data) return [];
			let refs: KeyframeRef[] = [];
			commit('Paste Keyframes', (nodes) => {
				const result = pasteKeyframes(nodes, data, time, { ...propertyOptions(), nodeIds });
				refs = result.refs;
				return result.nodes;
			});
			if (refs.length) setSelection(refs);
			notify();
			return refs;
		},
		get clipboard() {
			return clipboard;
		},

		// ----- selection & drag -------------------------------------------------------------
		get selection() {
			return selection as readonly KeyframeRef[];
		},
		selectKeyframes(refs: readonly KeyframeRef[], mode: 'replace' | 'add' | 'toggle' = 'replace') {
			if (mode === 'replace') setSelection([...refs]);
			else if (mode === 'add') setSelection([...selection, ...refs.filter((r) => !isKeyframeSelected(selection, r))]);
			else {
				const removed = selection.filter((s) => !isKeyframeSelected(refs, s));
				setSelection([...removed, ...refs.filter((r) => !isKeyframeSelected(selection, r))]);
			}
			notify();
		},
		clearSelection() {
			if (selection.length === 0) return;
			selection = [];
			notify();
		},
		/** Starts dragging keyframes (default: the selection; refs not selected become the selection). */
		beginKeyframeDrag(refs?: readonly KeyframeRef[]) {
			if (refs && !refs.every((r) => isKeyframeSelected(selection, r))) setSelection([...refs]);
			if (selection.length === 0) return;
			drag = { refs: selection.map((r) => ({ ...r })), delta: 0, target: null };
			notify();
		},
		/**
		 * Previews the drag at `delta` ms. With `snap` (default on) the group snaps to other
		 * keyframes, the playhead, 0 and the end within `thresholdMs`, else to whole frames.
		 */
		updateKeyframeDrag(delta: number, opts: { snap?: boolean; thresholdMs?: number } = {}): KeyframeDragState | null {
			if (!drag) return null;
			const nodes = options.getNodes();
			const times = drag.refs.map((r) => r.time);
			const minTime = Math.min(...times);
			let d = Math.max(-minTime, Number.isFinite(delta) ? delta : 0);
			let target: number | null = null;
			if (opts.snap !== false) {
				const targets = uniq([...getKeyframeTimes(nodes, { exclude: drag.refs }), player.currentTime, 0, duration()]);
				const snapped = snapKeyframeDelta(times, d, targets, opts.thresholdMs ?? 1000 / fps / 2);
				target = snapped.target;
				d = snapped.delta;
				if (target === null) d = snapTimeToFrame(minTime + d, fps) - minTime;
			}
			d = Math.max(-minTime, d);
			if (d !== drag.delta || target !== drag.target) {
				drag = { ...drag, delta: d, target };
				notify();
			}
			return drag;
		},
		/** Commits the drag as one undo step. */
		endKeyframeDrag(): number {
			if (!drag) return 0;
			const { refs, delta } = drag;
			drag = null;
			let applied = 0;
			if (delta !== 0) {
				let moved: KeyframeRef[] = [];
				commit(refs.length === 1 ? 'Move Keyframe' : 'Move Keyframes', (nodes) => {
					const result = moveKeyframes(nodes, refs, delta);
					applied = result.delta;
					moved = result.refs;
					return result.nodes;
				});
				if (applied !== 0) setSelection(moved);
			}
			notify();
			return applied;
		},
		/** Cancels the drag preview (Escape); nothing is edited. */
		cancelKeyframeDrag() {
			if (!drag) return;
			drag = null;
			notify();
		},

		// ----- views & export ---------------------------------------------------------------
		/** Timeline rows for `ids` (default: selected nodes), including the drag preview. */
		timelineRows(ids: Iterable<string> = selectedIds(), opts: Omit<TimelineRowsOptions, 'selection' | 'dragDelta'> = {}): TimelineRow[] {
			return getTimelineRows(options.getNodes(), ids, { ...propertyOptions(), ...opts, selection, dragDelta: drag?.delta ?? 0 });
		},
		sampleFrames(opts: SampleAnimationOptions = {}) {
			return sampleAnimationFrames(options.getNodes(), { fps, duration: duration(), ...propertyOptions(), ...opts });
		},
		exportCss(nodeId: string, opts: CssExportOptions & { name?: string; selector?: string } = {}) {
			const state = player.getState();
			return exportCssAnimation(options.getNodes(), nodeId, { duration: duration(), loop: state.loop, playbackRate: state.playbackRate, ...opts });
		},
		toWebAnimations(nodeId: string, opts: CssExportOptions = {}) {
			const state = player.getState();
			return toWebAnimations(options.getNodes(), nodeId, { duration: duration(), loop: state.loop, playbackRate: state.playbackRate, ...opts });
		},
		destroy() {
			player.destroy();
			listeners.clear();
		}
	};
	return controller;
}

export type CanvasAnimationController<TNode extends CanvasNode = CanvasNode> = ReturnType<typeof createCanvasAnimationController<TNode>>;
