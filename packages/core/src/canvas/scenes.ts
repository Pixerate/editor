import { boundsOf } from './layout.js';
import { createNodeLookup, getNodeRect, type NodeRectOptions } from './arrange.js';
import type { CanvasNode, Rect } from './types.js';

/**
 * Viewport transform in xyflow's convention: `screen = flow * zoom + (x, y)`.
 */
export interface CanvasViewport {
	x: number;
	y: number;
	zoom: number;
}

/**
 * A named, saved view of the canvas (Freeform "Scenes").
 */
export interface CanvasScene {
	id: string;
	name: string;
	viewport: CanvasViewport;
	/** Optional nodes the scene is about, e.g. to re-fit the scene after they move. */
	nodeIds?: string[];
	/**
	 * A provider transition effect (see `@pixerate/editor/effects`) played when the canvas moves
	 * to this scene. Kept, and ignored, without an effects provider.
	 */
	transition?: CanvasSceneTransition;
}

/** A transition effect into a scene (see `CanvasScene.transition`). */
export interface CanvasSceneTransition {
	/** The provider's transition effect id. */
	effect: string;
	provider?: string;
	name?: string;
	/** Control values (over the effect's defaults). */
	values: Record<string, number | string | boolean | readonly number[]>;
	/** Length in ms (default 600). */
	duration?: number;
}

export interface CanvasScenesState {
	scenes: readonly CanvasScene[];
	/** Id of the scene last shown, or `null`. */
	currentId: string | null;
	/** Index of the current scene, or `-1`. */
	currentIndex: number;
}

export interface CanvasScenesOptions {
	initialScenes?: CanvasScene[];
	/** Id generator for new scenes (default: `crypto.randomUUID` with a counter fallback). */
	createId?: () => string;
	/** Whether `next` / `previous` wrap around at the ends (default `false`). */
	wrap?: boolean;
	onChange?: (state: CanvasScenesState) => void;
}

export interface SerializedCanvasScenes {
	version: 1;
	scenes: CanvasScene[];
}

let fallbackCounter = 0;
function defaultId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	fallbackCounter += 1;
	return `scene-${Date.now().toString(36)}-${fallbackCounter}`;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/** Validates the shape of a scene. */
export function isValidCanvasScene(value: unknown): value is CanvasScene {
	if (typeof value !== 'object' || value === null) return false;
	const scene = value as Record<string, any>;
	const vp = scene.viewport;
	return (
		typeof scene.id === 'string' &&
		typeof scene.name === 'string' &&
		typeof vp === 'object' &&
		vp !== null &&
		isFiniteNumber(vp.x) &&
		isFiniteNumber(vp.y) &&
		isFiniteNumber(vp.zoom) &&
		vp.zoom > 0 &&
		(scene.nodeIds === undefined ||
			(Array.isArray(scene.nodeIds) && scene.nodeIds.every((id: unknown) => typeof id === 'string')))
	);
}

function cloneScene(scene: CanvasScene): CanvasScene {
	const copy: CanvasScene = {
		id: scene.id,
		name: scene.name,
		viewport: { x: scene.viewport.x, y: scene.viewport.y, zoom: scene.viewport.zoom }
	};
	if (scene.nodeIds) copy.nodeIds = [...scene.nodeIds];
	const t = scene.transition;
	if (t && typeof t.effect === 'string' && t.effect) copy.transition = JSON.parse(JSON.stringify(t)) as CanvasSceneTransition;
	return copy;
}

/**
 * Parses serialized scenes (a JSON string, a `{ version, scenes }` object or a bare array).
 * Invalid entries and duplicate ids are dropped.
 */
export function parseCanvasScenes(input: string | unknown): CanvasScene[] {
	let value: unknown = input;
	if (typeof input === 'string') {
		try {
			value = JSON.parse(input);
		} catch {
			return [];
		}
	}
	const list = Array.isArray(value)
		? value
		: typeof value === 'object' && value !== null && Array.isArray((value as any).scenes)
			? (value as any).scenes
			: [];
	const seen = new Set<string>();
	const scenes: CanvasScene[] = [];
	for (const entry of list) {
		if (!isValidCanvasScene(entry) || seen.has(entry.id)) continue;
		seen.add(entry.id);
		scenes.push(cloneScene(entry));
	}
	return scenes;
}

/**
 * Headless, framework-agnostic store of named viewports. Snapshots returned by `getState()`
 * are cached and only replaced on change, so it can back React's `useSyncExternalStore`.
 */
export class CanvasScenesStore {
	private scenes: CanvasScene[];
	private currentId: string | null = null;
	private cached: CanvasScenesState;
	private listeners = new Set<(state: CanvasScenesState) => void>();
	private readonly createId: () => string;
	private readonly onChange?: (state: CanvasScenesState) => void;
	wrap: boolean;

	constructor(options: CanvasScenesOptions = {}) {
		this.scenes = parseCanvasScenes(options.initialScenes ?? []);
		this.createId = options.createId ?? defaultId;
		this.wrap = options.wrap ?? false;
		this.onChange = options.onChange;
		this.cached = this.snapshot();
	}

	private snapshot(): CanvasScenesState {
		const currentIndex = this.currentId ? this.scenes.findIndex((s) => s.id === this.currentId) : -1;
		return {
			scenes: this.scenes,
			currentId: currentIndex === -1 ? null : this.currentId,
			currentIndex
		};
	}

	private commit(scenes: CanvasScene[] = this.scenes) {
		this.scenes = scenes;
		if (this.currentId && !scenes.some((s) => s.id === this.currentId)) this.currentId = null;
		this.cached = this.snapshot();
		this.onChange?.(this.cached);
		for (const listener of this.listeners) listener(this.cached);
	}

	getState(): CanvasScenesState {
		return this.cached;
	}

	getScene(id: string): CanvasScene | undefined {
		return this.scenes.find((s) => s.id === id);
	}

	subscribe(listener: (state: CanvasScenesState) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** First unused "Scene N" name. */
	nextDefaultName(): string {
		const names = new Set(this.scenes.map((s) => s.name));
		let n = this.scenes.length + 1;
		while (names.has(`Scene ${n}`)) n += 1;
		return `Scene ${n}`;
	}

	/**
	 * Adds a scene (appended, or inserted at `index`) and makes it current.
	 */
	add(input: { viewport: CanvasViewport; name?: string; nodeIds?: string[]; id?: string }, index?: number): CanvasScene {
		const scene = cloneScene({
			id: input.id && !this.getScene(input.id) ? input.id : this.createId(),
			name: input.name?.trim() || this.nextDefaultName(),
			viewport: input.viewport,
			nodeIds: input.nodeIds
		});
		if (!isValidCanvasScene(scene)) throw new Error('[CanvasScenesStore] Invalid scene viewport.');
		const scenes = [...this.scenes];
		const at = index === undefined ? scenes.length : Math.max(0, Math.min(scenes.length, index));
		scenes.splice(at, 0, scene);
		this.currentId = scene.id;
		this.commit(scenes);
		return scene;
	}

	/** Patches a scene's name, viewport or node ids. Returns the updated scene. */
	update(id: string, patch: Partial<Omit<CanvasScene, 'id'>>): CanvasScene | undefined {
		const index = this.scenes.findIndex((s) => s.id === id);
		if (index === -1) return undefined;
		const current = this.scenes[index];
		const next = cloneScene({
			...current,
			...patch,
			name: patch.name !== undefined ? patch.name.trim() || current.name : current.name,
			viewport: patch.viewport ?? current.viewport,
			id
		});
		if (!isValidCanvasScene(next)) throw new Error('[CanvasScenesStore] Invalid scene viewport.');
		const scenes = [...this.scenes];
		scenes[index] = next;
		this.commit(scenes);
		return next;
	}

	rename(id: string, name: string): CanvasScene | undefined {
		return this.update(id, { name });
	}

	/** Moves a scene to `toIndex` (clamped). */
	move(id: string, toIndex: number): void {
		const from = this.scenes.findIndex((s) => s.id === id);
		if (from === -1) return;
		const to = Math.max(0, Math.min(this.scenes.length - 1, Math.trunc(toIndex)));
		if (from === to) return;
		const scenes = [...this.scenes];
		const [scene] = scenes.splice(from, 1);
		scenes.splice(to, 0, scene);
		this.commit(scenes);
	}

	/** Reorders scenes to match `ids`; unknown ids are ignored and missing scenes keep their relative order at the end. */
	reorder(ids: string[]): void {
		const byId = new Map(this.scenes.map((s) => [s.id, s]));
		const ordered: CanvasScene[] = [];
		for (const id of ids) {
			const scene = byId.get(id);
			if (scene) {
				ordered.push(scene);
				byId.delete(id);
			}
		}
		this.commit([...ordered, ...this.scenes.filter((s) => byId.has(s.id))]);
	}

	remove(id: string): void {
		if (!this.getScene(id)) return;
		this.commit(this.scenes.filter((s) => s.id !== id));
	}

	clear(): void {
		this.currentId = null;
		this.commit([]);
	}

	/** Marks a scene as current and returns it. */
	goTo(id: string): CanvasScene | undefined {
		const scene = this.getScene(id);
		if (!scene) return undefined;
		if (this.currentId !== id) {
			this.currentId = id;
			this.commit();
		}
		return scene;
	}

	private step(direction: 1 | -1): CanvasScene | undefined {
		const count = this.scenes.length;
		if (count === 0) return undefined;
		const index = this.cached.currentIndex;
		let next: number;
		if (index === -1) next = direction === 1 ? 0 : count - 1;
		else next = index + direction;
		if (next < 0 || next >= count) {
			if (!this.wrap) return undefined;
			next = (next + count) % count;
		}
		return this.goTo(this.scenes[next].id);
	}

	/** Shows the next scene. Returns `undefined` at the end unless `wrap` is on. */
	next(): CanvasScene | undefined {
		return this.step(1);
	}

	/** Shows the previous scene. Returns `undefined` at the start unless `wrap` is on. */
	previous(): CanvasScene | undefined {
		return this.step(-1);
	}

	toJSON(): SerializedCanvasScenes {
		return { version: 1, scenes: this.scenes.map(cloneScene) };
	}

	serialize(): string {
		return JSON.stringify(this.toJSON());
	}

	/** Replaces all scenes from serialized data (see `parseCanvasScenes`). */
	load(input: string | unknown): void {
		this.currentId = null;
		this.commit(parseCanvasScenes(input));
	}
}

export function createCanvasScenesStore(options?: CanvasScenesOptions): CanvasScenesStore {
	return new CanvasScenesStore(options);
}

export interface FitViewportOptions {
	/** Padding around the content as a fraction of the content size per side (default 0.1, like xyflow). */
	padding?: number;
	minZoom?: number;
	maxZoom?: number;
}

/**
 * Viewport that fits `rect` into a container of `size`, centred (xyflow `fitView` maths).
 */
export function fitViewportToRect(
	rect: Rect,
	size: { width: number; height: number },
	options: FitViewportOptions = {}
): CanvasViewport {
	const { padding = 0.1, minZoom = 0.1, maxZoom = 2 } = options;
	const paddedWidth = Math.max(rect.width * (1 + padding * 2), 1);
	const paddedHeight = Math.max(rect.height * (1 + padding * 2), 1);
	const raw = Math.min(size.width / paddedWidth, size.height / paddedHeight);
	const zoom = Math.min(maxZoom, Math.max(minZoom, raw));
	const cx = rect.x + rect.width / 2;
	const cy = rect.y + rect.height / 2;
	return { x: size.width / 2 - cx * zoom, y: size.height / 2 - cy * zoom, zoom };
}

/**
 * Viewport that fits the given nodes (all nodes when `ids` is omitted), or `null` when none match.
 */
export function fitViewportToNodes(
	nodes: CanvasNode[],
	size: { width: number; height: number },
	ids?: Iterable<string>,
	options: FitViewportOptions & NodeRectOptions = {}
): CanvasViewport | null {
	const lookup = createNodeLookup(nodes);
	const wanted = ids ? new Set(ids) : null;
	const rects = nodes
		.filter((n) => (wanted ? wanted.has(n.id) : true))
		.map((n) => getNodeRect(n, lookup, options));
	const bounds = boundsOf(rects);
	return bounds ? fitViewportToRect(bounds, size, options) : null;
}
