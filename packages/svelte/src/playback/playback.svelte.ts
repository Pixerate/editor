import { getContext, setContext } from 'svelte';
import { PresenceStore, locatePlaybackChrome, type AgentPlayback, type PlaybackChromeOptions, type PlaybackPoint, type PlaybackRef, type PlaybackSurface } from '@pixerate/editor/tools';

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
	options: MaybeGetter<PlaybackSurfaceOptions> = {},
	/** Use this presence store (e.g. a director's, so its cursor and playback's are one) instead of a new one. */
	sharedPresence?: PresenceStore | null
): PresenceStore {
	const ambient = getAgentPlayback();
	const presence = sharedPresence ?? new PresenceStore();
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
			// Only a surface whose options can open things has `open`, so playback skips `open` steps
			// (and their wait) everywhere else. Read per step, like the other options.
			get open() {
				return o().open ? (ref: PlaybackRef) => o().open?.(ref) : undefined;
			},
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

export interface ElementPlaybackSurfaceOptions extends PlaybackChromeOptions {
	/** The kind of a bare `id` / `ids` argument (e.g. `parameter`). */
	defaultKind?: string;
	/**
	 * A CSS selector for each ref kind the surface can find inside the element. Refs they miss go to
	 * `locate`, then `locateElement` (which may return an element outside this one).
	 */
	selectors?: Record<string, (id: string) => string>;
	/** Bring the element on screen (switch to its tab) before the agent acts. */
	reveal?: () => void | Promise<void>;
}

/**
 * A playback surface for a plain DOM component (call during init): coordinates are pixels of the
 * element's box, and refs are found by the CSS selectors given per kind. Draw the cursors with
 * `<PresenceLayer>` inside the element. Parity with React's `useElementPlaybackSurface`.
 */
export function createElementPlaybackSurface(
	playback: MaybeGetter<AgentPlayback | null | undefined>,
	id: MaybeGetter<string | null | undefined>,
	element: () => HTMLElement | null | undefined,
	options: MaybeGetter<ElementPlaybackSurfaceOptions>
): PresenceStore {
	const box = () => element()?.getBoundingClientRect() ?? null;
	const fromViewport = (p: PlaybackPoint) => {
		const r = box();
		return { x: p.x - (r?.left ?? 0), y: p.y - (r?.top ?? 0) };
	};
	return createPlaybackSurface(playback, id, () => {
		const o = read(options);
		return {
			defaultKind: o.defaultKind,
			locate: (ref) => {
				const selector = o.selectors?.[ref.kind]?.(ref.id);
				const b = box();
				const r = selector ? element()?.querySelector(selector)?.getBoundingClientRect() : null;
				if (b && r && r.width > 0) return { x: r.left - b.left, y: r.top - b.top, width: r.width, height: r.height };
				return locatePlaybackChrome(ref, o, fromViewport);
			},
			bounds: () => {
				const r = box();
				return r && r.width > 0 ? { x: 0, y: 0, width: r.width, height: r.height } : null;
			},
			visible: () => {
				const r = box();
				return !!r && r.width > 0 && r.height > 0 && !(typeof document !== 'undefined' && document.visibilityState === 'hidden');
			},
			toViewport: (p) => {
				const r = box();
				return { x: (r?.left ?? 0) + p.x, y: (r?.top ?? 0) + p.y };
			},
			fromViewport,
			reveal: () => o.reveal?.(),
			open: o.open ? (ref) => o.open?.(ref) : undefined
		};
	});
}
