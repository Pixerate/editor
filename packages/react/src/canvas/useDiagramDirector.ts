import { useRef, useSyncExternalStore } from 'react';
import { DiagramDirector, PresenceStore, type DiagramController, type DiagramPlacement, type PresenceClock, type PresenceState } from '@pixerate/editor/diagram';

export interface UseDiagramDirectorOptions {
	/** Where nodes are drawn now, e.g. `() => diagram.layout` from `useMermaidDiagram`. */
	placement: () => DiagramPlacement;
	/** 1 = natural speed; 2 = twice as fast. */
	speed?: number;
	clock?: PresenceClock;
	/** Hide a cursor this long after its last call (ms, default 1500). */
	linger?: number;
}

/**
 * A `PresenceStore` and `DiagramDirector` for a diagram, created once: pass `director` to
 * `createDiagramToolProvider` so agent edits are acted out by a cursor, and `presence` to
 * `<DiagramPresenceLayer>` to draw it.
 */
export function useDiagramDirector(controller: DiagramController, options: UseDiagramDirectorOptions) {
	const placement = useRef(options.placement);
	placement.current = options.placement;
	const ref = useRef<{ presence: PresenceStore; director: DiagramDirector } | null>(null);
	if (!ref.current) {
		const presence = new PresenceStore();
		ref.current = {
			presence,
			director: new DiagramDirector(controller, presence, { placement: () => placement.current(), speed: options.speed, clock: options.clock, linger: options.linger })
		};
	}
	return ref.current;
}

/** The presence store's state (re-renders on every cursor move). */
export function usePresenceState(presence: PresenceStore): PresenceState {
	return useSyncExternalStore(presence.subscribe, presence.getState, presence.getState);
}
