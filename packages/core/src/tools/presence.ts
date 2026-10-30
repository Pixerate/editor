// Agent "performances" follow Ursula's remote control (src/remote/commands.ts `planCommand`,
// src/react/remote/director.ts, presence.ts, clock.ts): a pure planner turns a command into
// cursor steps, a director acts them out per actor and commits each call as one undo step,
// and the clock is injectable so performances are repeatable in tests. This module holds the
// parts every director shares (charts, Mermaid diagrams): the cursor store, the clock, the
// cursor tween and the per-actor queue.

export interface PresenceActor {
	id: string;
	name: string;
	color: string;
	/** Cursor position in the surface's own coordinates (scene / canvas). */
	x: number;
	y: number;
	/** The button is down (dragging). */
	pressed: boolean;
	/** What a drag traces while `pressed`: `path` for a freehand outline (a lasso), else a box from the press. */
	gesture?: 'path';
	/** A short note shown next to the cursor (what the agent is doing). */
	message?: string;
	/** A rectangle (surface coordinates) the agent is working on, drawn as a highlight ring. */
	focus?: { x: number; y: number; width: number; height: number };
}

export interface PresenceState {
	actors: readonly PresenceActor[];
}

export const PRESENCE_COLORS: readonly string[] = ['#7c3aed', '#db2777', '#0891b2', '#ea580c', '#16a34a'];

/** Cursor positions and notes of agents acting on a surface, for an overlay. */
export class PresenceStore {
	private state: PresenceState = { actors: [] };
	private readonly listeners = new Set<(state: PresenceState) => void>();

	getState = (): PresenceState => this.state;

	subscribe = (listener: (state: PresenceState) => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	/** The actor with `id`, if it is on the surface. */
	get(id: string): PresenceActor | undefined {
		return this.state.actors.find((a) => a.id === id);
	}

	/** Adds or changes an actor. */
	set(actor: Pick<PresenceActor, 'id'> & Partial<PresenceActor>): void {
		const current = this.get(actor.id);
		const next: PresenceActor = { name: actor.id, color: PRESENCE_COLORS[this.state.actors.length % PRESENCE_COLORS.length]!, x: 0, y: 0, pressed: false, ...current, ...actor };
		this.state = { actors: current ? this.state.actors.map((a) => (a.id === actor.id ? next : a)) : [...this.state.actors, next] };
		this.listeners.forEach((l) => l(this.state));
	}

	remove(id: string): void {
		if (!this.get(id)) return;
		this.state = { actors: this.state.actors.filter((a) => a.id !== id) };
		this.listeners.forEach((l) => l(this.state));
	}
}

/** Time for performances: real timers, or an instant clock for tests and recordings. */
export interface PresenceClock {
	now(): number;
	wait(ms: number): Promise<void>;
}

export const realPresenceClock: PresenceClock = {
	now: () => Date.now(),
	wait: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
};

/** A clock whose waits finish at once while its time still advances (repeatable performances). */
export function createInstantPresenceClock(start = 0): PresenceClock & { elapsed(): number } {
	let t = start;
	return {
		now: () => t,
		wait: async (ms) => {
			t += Math.max(0, ms);
		},
		elapsed: () => t - start
	};
}

/**
 * Glides an actor's cursor from `from` to `to` over `ms` (ease-out cubic, ~60 frames a second),
 * calling `each` with the eased progress after every frame (e.g. to drag a value along).
 */
export async function tweenPresenceCursor(
	presence: PresenceStore,
	clock: PresenceClock,
	id: string,
	from: { x: number; y: number },
	to: { x: number; y: number },
	ms: number,
	each?: (t: number) => void
): Promise<void> {
	const frames = Math.max(1, Math.round(ms / 16));
	for (let f = 1; f <= frames; f++) {
		const t = f / frames;
		const e = 1 - Math.pow(1 - t, 3);
		presence.set({ id, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
		each?.(e);
		await clock.wait(ms / frames);
	}
}

export interface PresenceActorInfo {
	id: string;
	name?: string;
	color?: string;
}

export interface PerformanceQueueOptions {
	clock: PresenceClock;
	/** Hide each actor's cursor this long after its last call (ms, default 1500; 0 keeps it). */
	linger?: number;
	/** Called around each call so everything it changes is one undo step. */
	beginGesture?: (key: string) => void;
	endGesture?: () => void;
}

/**
 * Runs performances one after another per actor (different actors run side by side). Each
 * call shows the actor's cursor, wraps the call in one gesture (one undo step), clears the
 * note when it ends, and hides the cursor after `linger` unless another call followed.
 */
export class PerformanceQueue {
	private readonly queues = new Map<string, Promise<unknown>>();
	private calls = 0;

	constructor(
		readonly presence: PresenceStore,
		private readonly options: PerformanceQueueOptions
	) {}

	run<T>(actor: PresenceActorInfo, perform: () => Promise<T>): Promise<T> {
		const prev = this.queues.get(actor.id) ?? Promise.resolve();
		const run = prev.then(async () => {
			this.presence.set({ id: actor.id, ...(actor.name ? { name: actor.name } : {}), ...(actor.color ? { color: actor.color } : {}) });
			this.options.beginGesture?.(`agent:${actor.id}:${++this.calls}`);
			let result: T;
			try {
				result = await perform();
			} finally {
				this.options.endGesture?.();
				this.presence.set({ id: actor.id, message: undefined, pressed: false });
			}
			const linger = this.options.linger ?? 1500;
			if (linger > 0) {
				await this.options.clock.wait(linger);
				if (this.queues.get(actor.id) === guarded) this.presence.remove(actor.id);
			}
			return result;
		});
		const guarded = run.catch(() => undefined);
		this.queues.set(actor.id, guarded);
		return run;
	}
}

/** A box from where an agent's button went down to its cursor, in surface coordinates. */
export interface PresenceDragBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** An agent's drag so far: the box from the press to the cursor, and the points it passed through. */
export interface PresenceDrag extends PresenceDragBox {
	/** The cursor positions since the press, in order (the press first). */
	path: readonly { x: number; y: number }[];
	/** `path` when the agent traces an outline (see `PresenceActor.gesture`); a box drag otherwise. */
	gesture?: 'path';
}

/**
 * Follows a presence store for an agent's drag (press, move, release) and reports the box from
 * the press to the cursor and the path it took, so a surface can draw its own drag feedback (a crop
 * box, a marquee being pulled out or a lasso being traced) under the agent's cursor. `onEnd` runs on release, or when the cursor leaves
 * the surface mid-drag. Pass the result to `PresenceStore.subscribe`.
 */
export function trackPresenceDrag(handlers: {
	onDrag: (drag: PresenceDrag) => void;
	onEnd: () => void;
}): (state: PresenceState) => void {
	let start: { id: string; x: number; y: number } | null = null;
	let path: { x: number; y: number }[] = [];
	return (state) => {
		const actor = start ? state.actors.find((a) => a.id === start!.id) : state.actors.find((a) => a.pressed);
		if (!start) {
			if (!actor) return;
			start = { id: actor.id, x: actor.x, y: actor.y };
			path = [{ x: actor.x, y: actor.y }];
		}
		if (!actor || !actor.pressed) {
			start = null;
			path = [];
			handlers.onEnd();
			return;
		}
		const last = path[path.length - 1]!;
		if (last.x !== actor.x || last.y !== actor.y) path.push({ x: actor.x, y: actor.y });
		handlers.onDrag({
			x: Math.min(start.x, actor.x),
			y: Math.min(start.y, actor.y),
			width: Math.abs(actor.x - start.x),
			height: Math.abs(actor.y - start.y),
			path: path.slice(),
			...(actor.gesture ? { gesture: actor.gesture } : {}),
		});
	};
}
