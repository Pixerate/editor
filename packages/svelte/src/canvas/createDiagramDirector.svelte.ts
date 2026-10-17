import { DiagramDirector, PresenceStore, type DiagramController, type DiagramPlacement, type PresenceClock, type PresenceState } from '@pixerate/editor/diagram';

export interface CreateDiagramDirectorOptions {
	/** Where nodes are drawn now, e.g. `() => diagram.layout` from `createMermaidDiagram`. */
	placement: () => DiagramPlacement;
	/** 1 = natural speed; 2 = twice as fast. */
	speed?: number;
	clock?: PresenceClock;
	/** Hide a cursor this long after its last call (ms, default 1500). */
	linger?: number;
}

export interface SvelteDiagramDirector {
	readonly presence: PresenceStore;
	readonly director: DiagramDirector;
	/** The cursors (reactive). */
	readonly state: PresenceState;
	destroy(): void;
}

/**
 * Svelte 5 rune: a `PresenceStore` and `DiagramDirector` for a diagram. Pass `director` to
 * `createDiagramToolProvider` so agent edits are acted out by a cursor, and `presence` to
 * `<DiagramPresenceLayer>`. Parity with React's `useDiagramDirector`.
 */
export function createDiagramDirector(controller: DiagramController, options: CreateDiagramDirectorOptions): SvelteDiagramDirector {
	const presence = new PresenceStore();
	const director = new DiagramDirector(controller, presence, { placement: options.placement, speed: options.speed, clock: options.clock, linger: options.linger });
	let state = $state.raw(presence.getState());
	const destroy = presence.subscribe((next) => {
		state = next;
	});
	return {
		presence,
		director,
		get state() {
			return state;
		},
		destroy
	};
}
