import { getContext, setContext } from 'svelte';
import { PresenceStore, type AgentPlayback, type PlaybackSurface } from '@pixerate/editor/tools';

const KEY = Symbol.for('pixerate.agentPlayback');

type MaybeGetter<T> = T | (() => T);
const read = <T>(value: MaybeGetter<T>): T => (typeof value === 'function' ? (value as () => T)() : value);

/** Makes `playback` the default for every editor surface in this component's subtree (call during init). */
export function setAgentPlayback(playback: AgentPlayback | null | undefined): void {
	setContext(KEY, playback ?? null);
}

/** The nearest `setAgentPlayback` playback, or `null` (call during init). */
export function getAgentPlayback(): AgentPlayback | null {
	return getContext<AgentPlayback | null | undefined>(KEY) ?? null;
}

/** A surface's behaviour; every function is read fresh on each call. */
export type PlaybackSurfaceOptions = Omit<PlaybackSurface, 'presence'>;

/**
 * Attaches a playback surface under `id` (the tool provider's id, or its `playbackSurface`) for the
 * calling component's lifetime (call during init), and returns its cursors to draw with
 * `<PresenceLayer>`. `playback` defaults to `getAgentPlayback()`; with none, nothing is attached and
 * calls run instantly. Parity with React's `usePlaybackSurface`.
 */
export function createPlaybackSurface(
	playback: MaybeGetter<AgentPlayback | null | undefined>,
	id: MaybeGetter<string | null | undefined>,
	options: MaybeGetter<PlaybackSurfaceOptions> = {}
): PresenceStore {
	const ambient = getAgentPlayback();
	const presence = new PresenceStore();
	const o = () => read(options);
	$effect(() => {
		const explicit = read(playback);
		const target = explicit === undefined ? ambient : explicit;
		const currentId = read(id);
		if (!target || !currentId) return;
		const surface: PlaybackSurface = {
			presence,
			locate: (ref) => o().locate?.(ref) ?? null,
			bounds: () => o().bounds?.() ?? null,
			visible: () => o().visible?.() ?? true,
			toViewport: (p) => o().toViewport?.(p) ?? p,
			fromViewport: (p) => o().fromViewport?.(p) ?? p,
			beginGesture: (key) => o().beginGesture?.(key),
			endGesture: () => o().endGesture?.(),
			reveal: () => o().reveal?.(),
			get defaultKind() {
				return o().defaultKind;
			}
		};
		const detach = target.attach(currentId, surface);
		return () => {
			detach();
			for (const a of presence.getState().actors) presence.remove(a.id);
		};
	});
	return presence;
}
