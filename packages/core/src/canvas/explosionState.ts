/**
 * Headless, framework-free state machine for canvas node explosion: which node is exploded,
 * which is collapsing (children still mounted while a collapse animation plays), and the timer
 * that ends the collapse. It never touches a graph or the DOM, so a declarative canvas can derive
 * its nodes from it. The Svelte rune `createCanvasExplosionState` and the React hook
 * `useCanvasExplosionState` wrap it.
 */

export interface CanvasExplosionStateOptions {
	/** How long children stay rendered after a collapse starts, in ms. Default 380. `0` ends the collapse at once. */
	collapseDurationMs?: number;
	/** The node exploded at creation. Default none. */
	initialActiveId?: string | null;
	/** Called after a node explodes. */
	onExplode?: (nodeId: string) => void;
	/** Called when a node starts collapsing (including when exploding another node replaces it). */
	onCollapse?: (nodeId: string) => void;
}

/** The state at one moment. A new object each time it changes, so it can be compared by identity. */
export interface CanvasExplosionStateSnapshot {
	/** The exploded node, or null. */
	readonly activeId: string | null;
	/** The node whose collapse animation is playing, or null. */
	readonly collapsingId: string | null;
}

export interface CanvasExplosionState extends CanvasExplosionStateSnapshot {
	/** True while a node is exploded or collapsing (children are on screen). */
	readonly isExplodingOrCollapsing: boolean;
	isExploded: (nodeId: string) => boolean;
	isCollapsing: (nodeId: string) => boolean;
	/** True when the node's children should be rendered: it is exploded or still collapsing. */
	shouldRenderChildren: (nodeId: string) => boolean;
	/** Explodes a node, replacing (collapsing) any other exploded node. Returns false when it already was. */
	explode: (nodeId: string) => boolean;
	/** Collapses the exploded node (only if it is `nodeId`, when given). Returns false when nothing collapsed. */
	collapse: (nodeId?: string) => boolean;
	/** Collapses the node when it is exploded, otherwise explodes it. Returns true when it is now exploded. */
	toggle: (nodeId: string) => boolean;
	/** Ends a running collapse now (e.g. from an `animationend` handler) instead of waiting for the timer. */
	finishCollapse: () => void;
	/** Clears the collapse timer and listeners; later calls do nothing. */
	destroy: () => void;
}

export interface CanvasExplosionStateController extends CanvasExplosionState {
	/** The current state; the same object until something changes. */
	getSnapshot: () => CanvasExplosionStateSnapshot;
	/** Calls `listener` after every change; returns an unsubscribe function. */
	subscribe: (listener: () => void) => () => void;
	/** True after `destroy()`. */
	readonly destroyed: boolean;
}

/** Creates the headless explosion state machine (see the module comment). */
export function createCanvasExplosionStateController(options: CanvasExplosionStateOptions = {}): CanvasExplosionStateController {
	const duration = options.collapseDurationMs ?? 380;
	if (!Number.isFinite(duration) || duration < 0) {
		throw new RangeError(`collapseDurationMs must be a finite number >= 0 (got ${duration}).`);
	}

	let snapshot: CanvasExplosionStateSnapshot = { activeId: options.initialActiveId ?? null, collapsingId: null };
	let timer: ReturnType<typeof setTimeout> | null = null;
	let destroyed = false;
	const listeners = new Set<() => void>();

	const clearTimer = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
	const set = (next: CanvasExplosionStateSnapshot) => {
		if (next.activeId === snapshot.activeId && next.collapsingId === snapshot.collapsingId) return;
		snapshot = next;
		for (const listener of [...listeners]) listener();
	};
	const finishCollapse = () => {
		clearTimer();
		if (snapshot.collapsingId !== null) set({ activeId: snapshot.activeId, collapsingId: null });
	};

	const explode = (nodeId: string): boolean => {
		if (destroyed) return false;
		if (typeof nodeId !== 'string' || nodeId === '') throw new TypeError('explode needs a node id.');
		if (snapshot.activeId === nodeId) return false;
		// A new explosion cancels any pending collapse: its children unmount now.
		clearTimer();
		const previous = snapshot.activeId;
		set({ activeId: nodeId, collapsingId: null });
		if (previous !== null) options.onCollapse?.(previous);
		options.onExplode?.(nodeId);
		return true;
	};

	const collapse = (nodeId?: string): boolean => {
		if (destroyed) return false;
		const active = snapshot.activeId;
		if (active === null || (nodeId !== undefined && nodeId !== active)) return false;
		clearTimer();
		set({ activeId: null, collapsingId: active });
		options.onCollapse?.(active);
		if (duration === 0) finishCollapse();
		else timer = setTimeout(() => {
			timer = null;
			finishCollapse();
		}, duration);
		return true;
	};

	return {
		get activeId() {
			return snapshot.activeId;
		},
		get collapsingId() {
			return snapshot.collapsingId;
		},
		get isExplodingOrCollapsing() {
			return snapshot.activeId !== null || snapshot.collapsingId !== null;
		},
		get destroyed() {
			return destroyed;
		},
		getSnapshot: () => snapshot,
		subscribe(listener) {
			if (destroyed) return () => {};
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		isExploded: (nodeId) => snapshot.activeId === nodeId,
		isCollapsing: (nodeId) => snapshot.collapsingId === nodeId,
		shouldRenderChildren: (nodeId) => snapshot.activeId === nodeId || snapshot.collapsingId === nodeId,
		explode,
		collapse,
		toggle: (nodeId) => (snapshot.activeId === nodeId ? (collapse(nodeId), false) : explode(nodeId)),
		finishCollapse: () => {
			if (!destroyed) finishCollapse();
		},
		destroy() {
			clearTimer();
			destroyed = true;
			listeners.clear();
		}
	};
}
