// Portions ported from filmcraft-main/crates/engine/src/keyframe_move.rs and crates/project/src/keyframe.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { getNodeSize } from '../arrange.js';
import type { CanvasNode } from '../types.js';
import { normalizeTokenColor } from '../../tokens/color.js';
import { isAnimationEasing, parseCssEasing, type AnimationEasing } from './easing.js';
import { evaluateTrack } from './evaluate.js';
import {
	ANIMATABLE_PROPERTIES,
	ANIMATION_TIME_EPSILON,
	clampAnimationValue,
	getAnimatableProperty,
	getAnimationTrack,
	getNodeAnimation,
	normalizeKeyframes,
	withNodeAnimation,
	type AnimatableProperty,
	type AnimationKeyframe,
	type AnimationPropertyOptions,
	type AnimationTrack,
	type AnimationValue,
	type NodeAnimation
} from './model.js';

/** Identifies one keyframe: node, property and time. */
export interface KeyframeRef {
	nodeId: string;
	property: string;
	time: number;
}

export type AnimationEditErrorCode =
	| 'unknown_node'
	| 'unknown_property'
	| 'unknown_keyframe'
	| 'duplicate_keyframe'
	| 'invalid_time'
	| 'invalid_value'
	| 'invalid_easing'
	| 'invalid_factor'
	| 'too_many_keyframes'
	| 'no_movement_range';

/** Thrown by the editing functions for invalid requests; nothing is changed when it is thrown. */
export class AnimationEditError extends Error {
	readonly code: AnimationEditErrorCode;
	constructor(code: AnimationEditErrorCode, message: string) {
		super(message);
		this.name = 'AnimationEditError';
		this.code = code;
	}
}

/** Most keyframes one move / scale / delete may name (as filmcraft's `effects.moveKeyframes`). */
export const MAX_KEYFRAME_REFS = 4096;

const sameTime = (a: number, b: number) => Math.abs(a - b) <= ANIMATION_TIME_EPSILON;
const refKey = (r: { nodeId: string; property: string }) => `${r.nodeId}\u0000${r.property}`;

/** Snaps a time to the nearest frame at `fps`. */
export function snapTimeToFrame(time: number, fps: number): number {
	if (!(fps > 0)) return time;
	const frame = 1000 / fps;
	// Rounded to a microsecond so frame times compare equal (500, not 500.00000000000006).
	return Math.round(Math.round(time / frame) * frame * 1000) / 1000;
}

function coerceValue(property: AnimatableProperty | undefined, value: unknown): AnimationValue {
	const type = property?.type ?? (typeof value === 'string' && normalizeTokenColor(value) !== null ? 'color' : 'number');
	if (type === 'color') {
		const color = normalizeTokenColor(value);
		if (color === null) throw new AnimationEditError('invalid_value', `"${String(value)}" is not a colour.`);
		return color;
	}
	const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	if (typeof n !== 'number' || !Number.isFinite(n)) throw new AnimationEditError('invalid_value', `"${String(value)}" is not a number.`);
	return clampAnimationValue(property, n);
}

function coerceEasing(easing: unknown): AnimationEasing {
	if (typeof easing === 'string') {
		const parsed = parseCssEasing(easing);
		if (parsed) return parsed;
	} else if (isAnimationEasing(easing)) return easing;
	throw new AnimationEditError('invalid_easing', `Unknown easing ${JSON.stringify(easing)}.`);
}

function coerceTime(time: unknown): number {
	if (typeof time !== 'number' || !Number.isFinite(time)) throw new AnimationEditError('invalid_time', `Invalid time ${String(time)}.`);
	return Math.max(0, time);
}

/**
 * Copy-on-write editing session over a node array: tracks are normalised (sorted, duplicates
 * merged) when first touched and written back by `commit`.
 */
class Draft<TNode extends CanvasNode> {
	private readonly byId: Map<string, TNode>;
	private readonly animations = new Map<string, NodeAnimation>();
	private readonly nodeWrites = new Map<string, TNode>();

	constructor(private readonly nodes: readonly TNode[], readonly options: AnimationPropertyOptions = {}) {
		this.byId = new Map(nodes.map((n) => [n.id, n]));
	}

	node(id: string): TNode {
		const node = this.nodeWrites.get(id) ?? this.byId.get(id);
		if (!node) throw new AnimationEditError('unknown_node', `Node "${id}" does not exist.`);
		return node;
	}

	has(id: string): boolean {
		return this.byId.has(id);
	}

	animation(id: string): NodeAnimation {
		let animation = this.animations.get(id);
		if (!animation) {
			const current = getNodeAnimation(this.node(id));
			const tracks: Record<string, AnimationTrack> = {};
			for (const [key, track] of Object.entries(current?.tracks ?? {})) {
				if (track) tracks[key] = { ...track, keyframes: normalizeKeyframes(track.keyframes) };
			}
			animation = { ...(current ?? {}), tracks };
			this.animations.set(id, animation);
		}
		return animation;
	}

	keys(id: string, property: string): AnimationKeyframe[] {
		return this.animation(id).tracks[property]?.keyframes ?? [];
	}

	track(id: string, property: string): AnimationTrack | undefined {
		return this.animation(id).tracks[property];
	}

	setKeys(id: string, property: string, keyframes: AnimationKeyframe[]) {
		const animation = this.animation(id);
		const sorted = [...keyframes].sort((a, b) => a.time - b.time);
		if (sorted.length === 0) delete animation.tracks[property];
		else animation.tracks[property] = { ...(animation.tracks[property] ?? {}), keyframes: sorted };
	}

	setMotionPath(id: string, motionPath: NodeAnimation['motionPath'] | undefined) {
		const animation = this.animation(id);
		if (motionPath) animation.motionPath = { ...motionPath };
		else delete animation.motionPath;
	}

	writeNode(id: string, fn: (node: TNode) => TNode) {
		this.nodeWrites.set(id, fn(this.node(id)));
	}

	find(ref: KeyframeRef): number {
		const keys = this.keys(ref.nodeId, ref.property);
		return keys.findIndex((k) => sameTime(k.time, ref.time));
	}

	property(key: string): AnimatableProperty | undefined {
		return getAnimatableProperty(key, this.options);
	}

	commit(): TNode[] {
		if (this.animations.size === 0 && this.nodeWrites.size === 0) return this.nodes as TNode[];
		return this.nodes.map((node) => {
			const written = this.nodeWrites.get(node.id);
			const animation = this.animations.get(node.id);
			if (!written && !animation) return node;
			const base = written ?? node;
			return animation ? withNodeAnimation(base, animation) : base;
		});
	}
}

function validateRefs(draft: Draft<CanvasNode>, refs: readonly KeyframeRef[], allowEmpty = false) {
	if (!Array.isArray(refs) || (!allowEmpty && refs.length === 0)) throw new AnimationEditError('unknown_keyframe', 'Name at least one keyframe.');
	if (refs.length > MAX_KEYFRAME_REFS) throw new AnimationEditError('too_many_keyframes', `At most ${MAX_KEYFRAME_REFS} keyframes per edit.`);
	const seen = new Map<string, number[]>();
	for (const ref of refs) {
		if (!ref || typeof ref.nodeId !== 'string' || typeof ref.property !== 'string' || typeof ref.time !== 'number' || !Number.isFinite(ref.time)) {
			throw new AnimationEditError('unknown_keyframe', 'Invalid keyframe reference.');
		}
		draft.node(ref.nodeId);
		if (draft.find(ref) === -1) throw new AnimationEditError('unknown_keyframe', `No ${ref.property} keyframe at ${ref.time}ms on "${ref.nodeId}".`);
		const times = seen.get(refKey(ref)) ?? [];
		if (times.some((t) => sameTime(t, ref.time))) throw new AnimationEditError('duplicate_keyframe', 'A keyframe is named twice.');
		times.push(ref.time);
		seen.set(refKey(ref), times);
	}
}

/** Static value of a property, for keying (sizes fall back to the measured size). */
export function readAnimatableValue(node: CanvasNode, property: AnimatableProperty): AnimationValue | undefined {
	const value = property.read(node);
	if (value !== undefined) return value;
	if (property.key === 'width' || property.key === 'height') return getNodeSize(node)[property.key];
	return undefined;
}

/** The value a property shows at `time`: its track's value when animated, else its static value. */
export function getAnimatedValue(node: CanvasNode, propertyKey: string, time: number, options: AnimationPropertyOptions = {}): AnimationValue | undefined {
	const property = getAnimatableProperty(propertyKey, options);
	const track = getAnimationTrack(node, propertyKey);
	if (track && track.enabled !== false) return evaluateTrack(track, time, property?.type ?? 'number');
	return property ? readAnimatableValue(node, property) : undefined;
}

export interface SetKeyframeOptions extends AnimationPropertyOptions {
	/** Easing of the segment leaving the keyframe (default: kept, or the previous keyframe's). */
	easing?: AnimationEasing | string;
}

function putKey(draft: Draft<any>, nodeId: string, property: string, time: number, value: AnimationValue, easing?: AnimationEasing, inherit = true) {
	const keys = [...draft.keys(nodeId, property)];
	const at = keys.findIndex((k) => sameTime(k.time, time));
	if (at >= 0) {
		keys[at] = { ...keys[at], value, ...(easing !== undefined ? { easing } : {}) };
	} else {
		// New keys take the easing of the keyframe before them (filmcraft `Param::set_at`).
		const before = [...keys].reverse().find((k) => k.time < time);
		const inherited = easing ?? (inherit ? before?.easing : undefined);
		keys.push({ time, value, ...(inherited !== undefined ? { easing: inherited } : {}) });
	}
	draft.setKeys(nodeId, property, keys);
}

/** Adds a keyframe, or replaces the value (and easing, when given) of the one at `time`. */
export function setKeyframe<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	nodeId: string,
	property: string,
	time: number,
	value: AnimationValue,
	options: SetKeyframeOptions = {}
): TNode[] {
	const draft = new Draft(nodes, options);
	draft.node(nodeId);
	const p = draft.property(property);
	if (!p) throw new AnimationEditError('unknown_property', `"${property}" cannot be animated.`);
	putKey(draft, nodeId, property, coerceTime(time), coerceValue(p, value), options.easing === undefined ? undefined : coerceEasing(options.easing));
	return draft.commit();
}

/**
 * Keys the given properties of the nodes at `time` with the values they show there (the
 * "add keyframe at playhead" action). Without `properties`, keys every animated property, or
 * `x` and `y` for nodes that have none. Returns the new nodes and the keyed refs.
 */
export function addKeyframesAtTime<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	ids: Iterable<string>,
	time: number,
	options: AnimationPropertyOptions & { properties?: readonly AnimatableProperty[]; keys?: readonly string[] } = {}
): { nodes: TNode[]; refs: KeyframeRef[] } {
	const draft = new Draft(nodes, options);
	const t = coerceTime(time);
	const refs: KeyframeRef[] = [];
	for (const id of ids) {
		const node = draft.node(id);
		const animated = Object.keys(draft.animation(id).tracks);
		const keys = options.keys ?? (animated.length > 0 ? animated : ['x', 'y']);
		for (const key of keys) {
			const p = draft.property(key);
			if (!p) throw new AnimationEditError('unknown_property', `"${key}" cannot be animated.`);
			const value = getAnimatedValue(node, key, t, options);
			if (value === undefined) continue;
			putKey(draft, id, key, t, value);
			refs.push({ nodeId: id, property: key, time: t });
		}
	}
	return { nodes: draft.commit(), refs };
}

export interface KeyframePatch {
	time?: number;
	value?: AnimationValue;
	easing?: AnimationEasing | string | null;
}

/** Changes one keyframe's time, value or easing (`easing: null` resets it to linear). */
export function updateKeyframe<TNode extends CanvasNode>(nodes: readonly TNode[], ref: KeyframeRef, patch: KeyframePatch, options: AnimationPropertyOptions = {}): TNode[] {
	const draft = new Draft(nodes, options);
	validateRefs(draft, [ref]);
	const keys = [...draft.keys(ref.nodeId, ref.property)];
	const i = keys.findIndex((k) => sameTime(k.time, ref.time));
	const next: AnimationKeyframe = { ...keys[i] };
	if (patch.value !== undefined) next.value = coerceValue(draft.property(ref.property), patch.value);
	if (patch.easing === null) delete next.easing;
	else if (patch.easing !== undefined) next.easing = coerceEasing(patch.easing);
	if (patch.time !== undefined) next.time = coerceTime(patch.time);
	keys.splice(i, 1);
	// Moving onto another keyframe replaces it.
	const rest = keys.filter((k) => !sameTime(k.time, next.time));
	draft.setKeys(ref.nodeId, ref.property, [...rest, next]);
	return draft.commit();
}

/** Sets the easing of the segments leaving the keyframes. */
export function setKeyframeEasing<TNode extends CanvasNode>(nodes: readonly TNode[], refs: readonly KeyframeRef[], easing: AnimationEasing | string | null, options: AnimationPropertyOptions = {}): TNode[] {
	const draft = new Draft(nodes, options);
	validateRefs(draft, refs);
	const value = easing === null ? null : coerceEasing(easing);
	for (const ref of refs) {
		const keys = draft.keys(ref.nodeId, ref.property).map((k) => {
			if (!sameTime(k.time, ref.time)) return k;
			const { easing: _old, ...rest } = k;
			return value === null ? rest : { ...rest, easing: value };
		});
		draft.setKeys(ref.nodeId, ref.property, keys);
	}
	return draft.commit();
}

/**
 * Deletes keyframes. When a track loses its last keyframe the node keeps that keyframe's
 * value as its static value, so it does not jump (filmcraft `remove_keyframe_at`).
 */
export function deleteKeyframes<TNode extends CanvasNode>(nodes: readonly TNode[], refs: readonly KeyframeRef[], options: AnimationPropertyOptions = {}): TNode[] {
	const draft = new Draft(nodes, options);
	validateRefs(draft, refs);
	const lanes = new Map<string, KeyframeRef[]>();
	for (const ref of refs) lanes.set(refKey(ref), [...(lanes.get(refKey(ref)) ?? []), ref]);
	for (const lane of lanes.values()) {
		const { nodeId, property } = lane[0];
		const keys = draft.keys(nodeId, property);
		const left = keys.filter((k) => !lane.some((r) => sameTime(r.time, k.time)));
		if (left.length === 0) {
			const p = draft.property(property);
			const last = keys.find((k) => sameTime(k.time, lane[lane.length - 1].time)) ?? keys[keys.length - 1];
			if (p && property !== 'motionPath') draft.writeNode(nodeId, (n) => p.write(n, last.value) as typeof n);
		}
		draft.setKeys(nodeId, property, left);
	}
	return draft.commit();
}

/** Turns a track on or off (disabled tracks keep their keyframes but do not animate). */
export function setTrackEnabled<TNode extends CanvasNode>(nodes: readonly TNode[], nodeId: string, property: string, enabled: boolean): TNode[] {
	const draft = new Draft(nodes);
	if (!draft.track(nodeId, property)) throw new AnimationEditError('unknown_property', `"${nodeId}" has no ${property} track.`);
	const { enabled: _was, ...track } = draft.track(nodeId, property)!;
	draft.animation(nodeId).tracks[property] = enabled ? track : { ...track, enabled: false };
	return draft.commit();
}

/**
 * Removes a track. With `keepValueAt`, the node keeps the value the track had at that time
 * (filmcraft's stopwatch toggle).
 */
export function removeTrack<TNode extends CanvasNode>(nodes: readonly TNode[], nodeId: string, property: string, options: AnimationPropertyOptions & { keepValueAt?: number } = {}): TNode[] {
	const draft = new Draft(nodes, options);
	const track = draft.track(nodeId, property);
	if (!track) return nodes as TNode[];
	const p = draft.property(property);
	if (options.keepValueAt !== undefined && p && property !== 'motionPath') {
		const value = evaluateTrack(track, options.keepValueAt, p.type);
		if (value !== undefined) draft.writeNode(nodeId, (n) => p.write(n, value) as typeof n);
	}
	draft.setKeys(nodeId, property, []);
	if (property === 'motionPath') draft.setMotionPath(nodeId, undefined);
	return draft.commit();
}

/** Sets (or with `null` removes) the path the `motionPath` track moves the node along. */
export function setMotionPath<TNode extends CanvasNode>(nodes: readonly TNode[], nodeId: string, motionPath: { d: string; autoRotate?: boolean } | null): TNode[] {
	const draft = new Draft(nodes);
	draft.node(nodeId);
	if (motionPath && (typeof motionPath.d !== 'string' || motionPath.d.trim() === '')) {
		throw new AnimationEditError('invalid_value', 'A motion path needs SVG path data.');
	}
	draft.setMotionPath(nodeId, motionPath ?? undefined);
	return draft.commit();
}

export interface KeyframeRangeOptions {
	/** Earliest allowed time (default 0). */
	min?: number;
	/** Latest allowed time (default unbounded). */
	max?: number;
}

export interface MoveKeyframesResult<TNode extends CanvasNode = CanvasNode> {
	nodes: TNode[];
	/** The delta applied (the request clamped so the whole group stays in range). */
	delta: number;
	/** The moved keyframes at their new times, in request order. */
	refs: KeyframeRef[];
}

/**
 * Moves keyframes (across nodes and properties) by one common `delta`, so their relative timing
 * is kept. The delta is clamped so every key stays inside `[min, max]`; a clamped-to-zero move
 * returns the input nodes. Moved keys replace unselected keys at their destination, but never
 * each other: all originals are removed before any is re-inserted. Invalid or duplicate
 * references throw without changing anything.
 */
export function moveKeyframes<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	refs: readonly KeyframeRef[],
	delta: number,
	options: KeyframeRangeOptions = {}
): MoveKeyframesResult<TNode> {
	if (typeof delta !== 'number' || Number.isNaN(delta)) throw new AnimationEditError('invalid_time', 'The delta must be a number.');
	const draft = new Draft(nodes);
	validateRefs(draft, refs);
	const min = options.min ?? 0;
	const max = options.max ?? Infinity;
	let low = -Infinity;
	let high = Infinity;
	for (const ref of refs) {
		const time = draft.keys(ref.nodeId, ref.property)[draft.find(ref)].time;
		low = Math.max(low, min - time);
		high = Math.min(high, max - time);
	}
	if (low > high + ANIMATION_TIME_EPSILON) throw new AnimationEditError('no_movement_range', 'The keyframes have no common movement range.');
	const applied = Math.min(high, Math.max(low, delta));
	const moved = refs.map((ref) => ({ ...ref, time: draft.keys(ref.nodeId, ref.property)[draft.find(ref)].time + applied }));
	if (Math.abs(applied) <= ANIMATION_TIME_EPSILON) return { nodes: nodes as TNode[], delta: 0, refs: refs.map((r) => ({ ...r })) };
	retime(draft, refs, (time) => time + applied);
	return { nodes: draft.commit(), delta: applied, refs: moved };
}

/** Re-times the referenced keys of each lane: originals out first, then destinations replace. */
function retime(draft: Draft<any>, refs: readonly KeyframeRef[], map: (time: number) => number) {
	const lanes = new Map<string, KeyframeRef[]>();
	for (const ref of refs) lanes.set(refKey(ref), [...(lanes.get(refKey(ref)) ?? []), ref]);
	for (const lane of lanes.values()) {
		const { nodeId, property } = lane[0];
		const keys = draft.keys(nodeId, property);
		const picked = keys.filter((k) => lane.some((r) => sameTime(r.time, k.time)));
		const movedKeys = picked.map((k) => ({ ...k, time: map(k.time) }));
		const rest = keys.filter((k) => !picked.includes(k) && !movedKeys.some((m) => sameTime(m.time, k.time)));
		draft.setKeys(nodeId, property, [...rest, ...movedKeys]);
	}
}

export interface ScaleKeyframesOptions extends KeyframeRangeOptions {
	/** Time that stays fixed (default: the earliest selected keyframe). */
	pivot?: number;
}

/**
 * Scales the spacing of keyframes in time around `pivot` (factor 2 = twice as slow). The factor
 * is reduced so every key stays inside `[min, max]`. Returns the factor applied.
 */
export function scaleKeyframes<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	refs: readonly KeyframeRef[],
	factor: number,
	options: ScaleKeyframesOptions = {}
): { nodes: TNode[]; factor: number; refs: KeyframeRef[] } {
	if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) throw new AnimationEditError('invalid_factor', 'The scale factor must be a positive number.');
	const draft = new Draft(nodes);
	validateRefs(draft, refs);
	const times = refs.map((ref) => draft.keys(ref.nodeId, ref.property)[draft.find(ref)].time);
	const pivot = options.pivot ?? Math.min(...times);
	const min = options.min ?? 0;
	const max = options.max ?? Infinity;
	let applied = factor;
	for (const t of times) {
		if (t > pivot && Number.isFinite(max)) applied = Math.min(applied, (max - pivot) / (t - pivot));
		if (t < pivot) applied = Math.min(applied, (pivot - min) / (pivot - t));
	}
	applied = Math.max(applied, Number.EPSILON);
	const map = (t: number) => pivot + (t - pivot) * applied;
	if (Math.abs(applied - 1) <= 1e-12) return { nodes: nodes as TNode[], factor: 1, refs: refs.map((r) => ({ ...r })) };
	retime(draft, refs, map);
	return { nodes: draft.commit(), factor: applied, refs: refs.map((r, i) => ({ ...r, time: map(times[i]) })) };
}

/** Keyframe times on the nodes (all when `ids` is omitted), sorted and unique, minus `exclude`. */
export function getKeyframeTimes(nodes: readonly CanvasNode[], options: { ids?: Iterable<string>; exclude?: readonly KeyframeRef[] } = {}): number[] {
	const only = options.ids ? new Set(options.ids) : null;
	const excluded = new Map<string, number[]>();
	for (const ref of options.exclude ?? []) excluded.set(refKey(ref), [...(excluded.get(refKey(ref)) ?? []), ref.time]);
	const times: number[] = [];
	for (const node of nodes) {
		if (only && !only.has(node.id)) continue;
		const animation = getNodeAnimation(node);
		if (!animation) continue;
		for (const [property, track] of Object.entries(animation.tracks)) {
			const skip = excluded.get(refKey({ nodeId: node.id, property })) ?? [];
			for (const k of normalizeKeyframes(track?.keyframes)) if (!skip.some((t) => sameTime(t, k.time))) times.push(k.time);
		}
	}
	times.sort((a, b) => a - b);
	return times.filter((t, i) => i === 0 || !sameTime(t, times[i - 1]));
}

export interface KeyframeSnap {
	/** The delta after snapping. */
	delta: number;
	/** The time snapped to, or `null` when nothing was within the threshold. */
	target: number | null;
}

/**
 * Snaps a group move: the selected key (at `times + delta`) nearest to any target pulls the
 * whole group onto it when within `threshold` ms (convert the timeline's screen threshold,
 * e.g. 8px, with its scale). The group's spacing is kept.
 */
export function snapKeyframeDelta(times: readonly number[], delta: number, targets: readonly number[], threshold: number): KeyframeSnap {
	const sorted = [...targets].filter(Number.isFinite).sort((a, b) => a - b);
	let best: { distance: number; target: number; delta: number } | null = null;
	for (const time of times) {
		const at = time + delta;
		let lo = 0;
		let hi = sorted.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (sorted[mid] < at) lo = mid + 1;
			else hi = mid;
		}
		for (const i of [lo - 1, lo]) {
			const target = sorted[i];
			if (target === undefined) continue;
			const distance = Math.abs(target - at);
			if (distance <= threshold && (!best || distance < best.distance)) best = { distance, target, delta: delta + (target - at) };
		}
	}
	return best ? { delta: best.delta, target: best.target } : { delta, target: null };
}

// -------------------------------------------------------------------------------------------
// Copy / paste

/** Clipboard payload for keyframes; times are offsets from the earliest copied keyframe. */
export interface AnimationKeyframeClipboard {
	type: 'pixerate/keyframes';
	version: 1;
	keyframes: { nodeId: string; property: string; offset: number; value: AnimationValue; easing?: AnimationEasing }[];
}

/** Copies keyframes into a clipboard payload. */
export function copyKeyframes(nodes: readonly CanvasNode[], refs: readonly KeyframeRef[]): AnimationKeyframeClipboard {
	const draft = new Draft(nodes);
	validateRefs(draft, refs);
	const found = refs.map((ref) => ({ ref, key: draft.keys(ref.nodeId, ref.property)[draft.find(ref)] }));
	const start = Math.min(...found.map((f) => f.key.time));
	return {
		type: 'pixerate/keyframes',
		version: 1,
		keyframes: found.map(({ ref, key }) => ({
			nodeId: ref.nodeId,
			property: ref.property,
			offset: key.time - start,
			value: key.value,
			...(key.easing !== undefined ? { easing: key.easing } : {})
		}))
	};
}

/** Reads a keyframe clipboard payload (object or JSON text), or `null`. */
export function parseKeyframeClipboard(input: unknown): AnimationKeyframeClipboard | null {
	let value = input;
	if (typeof input === 'string') {
		if (input.length > 5_000_000) return null;
		try {
			value = JSON.parse(input);
		} catch {
			return null;
		}
	}
	if (typeof value !== 'object' || value === null) return null;
	const clip = value as Record<string, any>;
	if (clip.type !== 'pixerate/keyframes' || clip.version !== 1 || !Array.isArray(clip.keyframes)) return null;
	const keyframes = clip.keyframes.filter(
		(k: any) =>
			k &&
			typeof k.nodeId === 'string' &&
			typeof k.property === 'string' &&
			typeof k.offset === 'number' &&
			Number.isFinite(k.offset) &&
			((typeof k.value === 'number' && Number.isFinite(k.value)) || typeof k.value === 'string') &&
			(k.easing === undefined || isAnimationEasing(k.easing))
	);
	return keyframes.length > 0 ? { type: 'pixerate/keyframes', version: 1, keyframes } : null;
}

/**
 * Pastes keyframes with their first key at `time`, replacing keys at the same times. Targets:
 * `nodeIds` (every target gets a single-node clip; several source nodes map onto the targets
 * in order), or the original nodes when omitted. Keys for missing nodes or unknown properties
 * are skipped. Returns the pasted refs.
 */
export function pasteKeyframes<TNode extends CanvasNode>(
	nodes: readonly TNode[],
	clipboard: AnimationKeyframeClipboard,
	time: number,
	options: AnimationPropertyOptions & { nodeIds?: readonly string[] } = {}
): { nodes: TNode[]; refs: KeyframeRef[] } {
	const draft = new Draft(nodes, options);
	const t = coerceTime(time);
	const sources = [...new Set(clipboard.keyframes.map((k) => k.nodeId))];
	const targetsOf = (source: string): string[] => {
		if (!options.nodeIds || options.nodeIds.length === 0) return [source];
		if (sources.length === 1) return [...options.nodeIds];
		const i = sources.indexOf(source);
		return i < options.nodeIds.length ? [options.nodeIds[i]] : [];
	};
	const refs: KeyframeRef[] = [];
	for (const k of clipboard.keyframes) {
		const p = draft.property(k.property);
		if (!p) continue;
		for (const target of targetsOf(k.nodeId)) {
			if (!draft.has(target)) continue;
			let value: AnimationValue;
			try {
				value = coerceValue(p, k.value);
			} catch {
				continue;
			}
			const at = t + Math.max(0, k.offset);
			putKey(draft, target, k.property, at, value, k.easing, false);
			refs.push({ nodeId: target, property: k.property, time: at });
		}
	}
	return { nodes: draft.commit(), refs };
}

// -------------------------------------------------------------------------------------------
// Recording

const sameValue = (a: AnimationValue | undefined, b: AnimationValue | undefined) =>
	typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-9 : a === b;

export interface RecordAnimationOptions extends AnimationPropertyOptions {
	/**
	 * Record mode: changing a property that is not animated yet keys it too (otherwise only
	 * properties that already have keyframes are keyed and other changes are static edits).
	 */
	recording?: boolean;
}

/**
 * Turns edits made on the *displayed* (evaluated) nodes into edits of the stored nodes.
 *
 * - `base`: the stored nodes; `before`: what was displayed (`applyAnimation(base, time)`);
 *   `after`: the displayed nodes after the edit (e.g. React Flow changes applied to `before`).
 * - A changed property with an enabled track is keyed at `time` and keeps its stored value.
 * - In record mode a changed property without a track gets one: a key at 0 with the previous
 *   value (when `time` > 0) and a key at `time`, so it animates from where it was. The stored
 *   value stays the previous one.
 * - Everything else (other fields, unanimated properties outside record mode) passes through.
 *
 * Unchanged nodes keep their stored identity; returns the new stored nodes and the keyed refs.
 */
export function recordAnimationChanges<TNode extends CanvasNode>(
	base: readonly TNode[],
	before: readonly TNode[],
	after: readonly TNode[],
	time: number,
	options: RecordAnimationOptions = {}
): { nodes: TNode[]; keyed: KeyframeRef[] } {
	const properties = (options.properties ?? ANIMATABLE_PROPERTIES).filter((p) => p.key !== 'motionPath');
	const baseById = new Map(base.map((n) => [n.id, n]));
	const beforeById = new Map(before.map((n) => [n.id, n]));
	const t = coerceTime(time);
	const keyed: KeyframeRef[] = [];
	const out = after.map((next) => {
		const stored = baseById.get(next.id);
		const shown = beforeById.get(next.id);
		if (!stored) return next;
		if (shown === next) return stored;
		const animation = getNodeAnimation(stored);
		let result: CanvasNode = next;
		let tracks: Record<string, AnimationTrack> | null = null;
		const tracksOf = () => (tracks ??= { ...(animation?.tracks ?? {}) });
		for (const p of properties) {
			const track = getAnimationTrack(stored, p.key);
			const animated = !!track && track.enabled !== false;
			const now = p.read(next);
			const was = shown ? p.read(shown) : undefined;
			const changed = !!shown && now !== undefined && !sameValue(now, was);
			const restore = () => {
				const value = p.read(stored);
				if (value !== undefined) result = p.write(result, value);
			};
			if (animated) {
				if (changed) {
					const keys = normalizeKeyframes(track!.keyframes).filter((k) => !sameTime(k.time, t));
					const before = [...keys].reverse().find((k) => k.time < t);
					keys.push({ time: t, value: now!, ...(before?.easing !== undefined ? { easing: before.easing } : {}) });
					tracksOf()[p.key] = { ...track!, keyframes: keys.sort((a, b) => a.time - b.time) };
					keyed.push({ nodeId: next.id, property: p.key, time: t });
				}
				restore();
			} else if (changed && options.recording && !track) {
				const keys: AnimationKeyframe[] = [];
				if (t > ANIMATION_TIME_EPSILON && was !== undefined) keys.push({ time: 0, value: was });
				keys.push({ time: t, value: now! });
				tracksOf()[p.key] = { keyframes: keys };
				keyed.push({ nodeId: next.id, property: p.key, time: t });
				restore();
			}
		}
		if (tracks) result = withNodeAnimation(result, { ...(animation ?? {}), tracks });
		return result as TNode;
	});
	return { nodes: out, keyed };
}

// -------------------------------------------------------------------------------------------
// One-shot animations (agents, scripts)

export interface AnimateNodeOptions extends AnimationPropertyOptions {
	/** Values at the end (property → value). */
	to: Record<string, AnimationValue>;
	/** Values at the start (default: what the node shows at `delay`). */
	from?: Record<string, AnimationValue>;
	/** Duration in ms (default 1000). */
	duration?: number;
	/** Start time in ms (default 0). */
	delay?: number;
	easing?: AnimationEasing | string;
}

/**
 * Animates a node from `from` (or its current values) to `to` over `duration` ms starting at
 * `delay`: two keyframes per property, replacing keys at those times.
 */
export function animateNode<TNode extends CanvasNode>(nodes: readonly TNode[], nodeId: string, options: AnimateNodeOptions): { nodes: TNode[]; refs: KeyframeRef[] } {
	const draft = new Draft(nodes, options);
	const node = draft.node(nodeId);
	const start = coerceTime(options.delay ?? 0);
	const duration = options.duration ?? 1000;
	if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) throw new AnimationEditError('invalid_time', 'The duration must be positive.');
	const easing = options.easing === undefined ? undefined : coerceEasing(options.easing);
	const entries = Object.entries(options.to ?? {});
	if (entries.length === 0) throw new AnimationEditError('invalid_value', 'Name at least one property to animate.');
	const refs: KeyframeRef[] = [];
	const writes: [string, AnimationValue, AnimationValue][] = [];
	for (const [key, target] of entries) {
		const p = draft.property(key);
		if (!p || (key === 'motionPath' && !getNodeAnimation(node)?.motionPath)) {
			throw new AnimationEditError('unknown_property', `"${key}" cannot be animated${p ? ' without a motion path' : ''}.`);
		}
		const from = options.from?.[key] ?? (key === 'motionPath' ? 0 : getAnimatedValue(node, key, start, options));
		if (from === undefined) throw new AnimationEditError('invalid_value', `"${nodeId}" has no ${key} to animate from; pass "from".`);
		writes.push([key, coerceValue(p, from), coerceValue(p, target)]);
	}
	for (const [key, from, to] of writes) {
		putKey(draft, nodeId, key, start, from, easing);
		putKey(draft, nodeId, key, start + duration, to, undefined, false);
		refs.push({ nodeId, property: key, time: start }, { nodeId, property: key, time: start + duration });
	}
	return { nodes: draft.commit(), refs };
}
