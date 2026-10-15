import type { ParameterKeyframe, ParameterKeyframes, ParameterKeyState, ParameterTrack } from './types.js';

/** Keyframes closer than this (ms) to the playhead count as "at" it (default for the controller). */
export const PARAMETER_KEY_TOLERANCE = 0.5;

/** Whether a track has a keyframe within `tolerance` ms of `time`. */
export function findParameterKeyframe(track: ParameterTrack<any> | undefined, time: number, tolerance = PARAMETER_KEY_TOLERANCE): number {
	if (!track) return -1;
	return track.keyframes.findIndex((k) => Math.abs(k.time - time) <= tolerance);
}

/** `keyed` (a key at `time`), `animated` (keys elsewhere) or `none`. */
export function getParameterKeyState(track: ParameterTrack<any> | undefined, time: number, tolerance = PARAMETER_KEY_TOLERANCE): ParameterKeyState {
	if (!track || track.keyframes.length === 0) return 'none';
	return findParameterKeyframe(track, time, tolerance) >= 0 ? 'keyed' : 'animated';
}

const sortKeys = <T>(keys: ParameterKeyframe<T>[]) => keys.sort((a, b) => a.time - b.time);

/** A copy of `track` with a key at `time` holding `value` (replacing one already there). */
export function withParameterKeyframe<T>(track: ParameterTrack<T> | undefined, key: ParameterKeyframe<T>, tolerance = PARAMETER_KEY_TOLERANCE): ParameterTrack<T> {
	const keyframes = [...(track?.keyframes ?? [])];
	const at = findParameterKeyframe(track, key.time, tolerance);
	if (at >= 0) keyframes[at] = { ...keyframes[at], value: key.value, ...(key.easing !== undefined ? { easing: key.easing } : {}) };
	else keyframes.push({ ...key });
	return { ...(track ?? {}), keyframes: sortKeys(keyframes) };
}

/** A copy of `track` without the key at `time`; `undefined` when no keys remain. */
export function withoutParameterKeyframe<T>(track: ParameterTrack<T> | undefined, time: number, tolerance = PARAMETER_KEY_TOLERANCE): ParameterTrack<T> | undefined {
	if (!track) return undefined;
	const keyframes = track.keyframes.filter((k) => Math.abs(k.time - time) > tolerance);
	return keyframes.length ? { ...track, keyframes } : undefined;
}

export interface ParameterKeyframeStore extends ParameterKeyframes {
	/** Every track (id → track). Stable between changes. */
	getTracks(): Readonly<Record<string, ParameterTrack<any>>>;
	/** Replaces every track (no notification when `silent`). */
	setTracks(tracks: Record<string, ParameterTrack<any>>, silent?: boolean): void;
	subscribe(listener: () => void): () => void;
}

/**
 * An in-memory `ParameterKeyframes` adapter for apps that keep tracks next to their values
 * (an effect document can implement the interface over its own storage instead).
 */
export function createParameterKeyframeStore(initial: Record<string, ParameterTrack<any>> = {}): ParameterKeyframeStore {
	let tracks: Record<string, ParameterTrack<any>> = { ...initial };
	const listeners = new Set<() => void>();
	const emit = () => listeners.forEach((l) => l());
	return {
		getTrack: (id) => tracks[id],
		getTracks: () => tracks,
		setTrack(id, track) {
			const next = { ...tracks };
			if (track && track.keyframes.length > 0) next[id] = { ...track, keyframes: sortKeys([...track.keyframes]) };
			else delete next[id];
			tracks = next;
			emit();
		},
		setTracks(next, silent) {
			tracks = { ...next };
			if (!silent) emit();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	};
}
