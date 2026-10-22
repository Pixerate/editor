// Agent playback: every tool call of a registry acted out by the agent's cursor, after the chart and
// diagram directors (Ursula's remote control: a pure planner turns a call into cursor steps, a
// performer plays them per actor and the call commits as one undo step). Editors attach surfaces
// (a presence store plus a way to find things); without one, calls run instantly. Dependency-free:
// no editor, framework or DOM imports.
import type { AgentToolProvider, ToolMiddleware, ToolMiddlewareCall, ToolRegistry } from './registry.js';
import { PRESENCE_COLORS, realPresenceClock, type PresenceActorInfo, type PresenceClock, type PresenceStore } from './presence.js';

export interface PlaybackPoint {
	x: number;
	y: number;
}

export interface PlaybackRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Something a surface can find: `{ kind: 'node', id }`, `{ kind: 'layer', id }`, a cell range
 * `{ kind: 'cell', id: 'B7:G7' }` or one of the editor's own controls `{ kind: 'control', id: 'title' }`.
 */
export interface PlaybackRef {
	kind: string;
	id: string;
}

/** One thing the cursor does. Points and rectangles are in the surface's own coordinates. */
export type PlaybackStep =
	| { type: 'move'; to: PlaybackPoint; ms?: number }
	/** Glide to whatever the surface locates for `ref`, and ring it. Skipped when nothing is found. */
	| { type: 'target'; ref: PlaybackRef; ms?: number }
	| { type: 'focus'; rect: PlaybackRect | null }
	| { type: 'say'; text: string; ms?: number }
	| { type: 'press' }
	| { type: 'release' }
	/** Move with the button down (the cursor only; the change lands at `commit`). */
	| { type: 'drag'; to: PlaybackPoint; ms?: number }
	| { type: 'type'; text: string; ms?: number }
	| { type: 'wait'; ms: number }
	/**
	 * Bring a part of the editor into view (a panel or tab): glide to what `ref` locates, click it,
	 * and let the surface's `open(ref)` show it. Skipped when the surface has no `open`.
	 */
	| { type: 'open'; ref: PlaybackRef; ms?: number }
	/** The handler runs here, exactly once (appended when a plan leaves it out). */
	| { type: 'commit' };

export interface PlaybackPlanResult {
	steps: PlaybackStep[];
	/** The surface to play on, when it is not the provider's (e.g. commands of one editor). */
	surface?: string;
	/** Treat the call as a read: a glance, no press and no undo gesture. */
	readOnly?: boolean;
}

export type PlaybackPlan = PlaybackStep[] | PlaybackPlanResult | null | undefined;

/** What a planner may read besides the arguments. */
export interface PlaybackPlanState {
	/** The surface the provider plays on, if one is attached. */
	surfaceId: string | null;
	/** Finds a ref on that surface (surface coordinates), or null. */
	locate(ref: PlaybackRef): PlaybackRect | null;
}

/**
 * A pure function from a call's validated arguments (and the state before the call) to the
 * cursor steps that act it out. Ids the call creates do not exist yet: plan toward where the
 * change lands. A throw, `null` or no steps falls back to the ids in the arguments.
 */
export type ToolPlanner = (args: Record<string, any>, state: PlaybackPlanState) => PlaybackPlan;

/** An editor's surface, attached by its React / Svelte component while it is on screen. */
export interface PlaybackSurface {
	/** The cursors on this surface; the editor's presence layer draws it. */
	presence: PresenceStore;
	/** Where `ref` is, in surface coordinates. */
	locate?(ref: PlaybackRef): PlaybackRect | null;
	/** The visible part of the surface (surface coordinates), where a cursor enters. */
	bounds?(): PlaybackRect | null;
	/** Whether the surface is on screen now (default true). Hidden surfaces play instantly. */
	visible?(): boolean;
	/** Surface → viewport (client pixels) and back, so a cursor can move between surfaces. */
	toViewport?(point: PlaybackPoint): PlaybackPoint;
	fromViewport?(point: PlaybackPoint): PlaybackPoint;
	/** Group what a call changes into one undo step (optional; most handlers already do). */
	beginGesture?(key: string): void;
	endGesture?(): void;
	/** Bring the surface on screen (switch to its tab) before playing. */
	reveal?(): void | Promise<void>;
	/** Show a part of the editor (a panel or tab) for an `open` step, e.g. by clicking its tab. */
	open?(ref: PlaybackRef): void | Promise<void>;
	/** The kind of a bare `id` / `ids` argument on this surface (e.g. `node`, `vector`). */
	defaultKind?: string;
}

export type PlaybackReads = 'glance' | 'skip' | 'play';

export interface AgentPlaybackOptions {
	clock?: PresenceClock;
	/** 1 = natural pace, 2 = twice as fast, `Infinity` = no animation (default 1). */
	speed?: number;
	/** Read-only tools: `glance` moves to their target only (default), `skip` doesn't, `play` plays them like writes. */
	reads?: PlaybackReads;
	/** Hide a cursor this long after its actor's last call (ms, default 1500; 0 keeps it). */
	linger?: number;
	/** The actor for calls that name none (default `{ id: 'agent', name: 'Agent' }`). */
	actor?: PresenceActorInfo;
}

/** A step as played, for tests (`playback.record()`). */
export interface PlaybackRecord {
	actor: string;
	surface: string;
	tool: string;
	step: PlaybackStep;
}

const ARG_KINDS: Record<string, string> = {
	nodeId: 'node',
	edgeId: 'edge',
	layerId: 'layer',
	clipId: 'clip',
	trackId: 'track',
	seriesId: 'series',
	parameterId: 'parameter',
	keyframeId: 'keyframe',
	shapeId: 'shape'
};

function pushRef(out: PlaybackRef[], kind: string, id: unknown) {
	if (typeof id !== 'string' || !id) return;
	if (!out.some((r) => r.kind === kind && r.id === id)) out.push({ kind, id });
}

/**
 * The things a call's arguments name, by convention: `id` / `ids` (the surface's default kind),
 * `nodeId(s)`, `layerId(s)`, `clipId(s)`, `trackId(s)`, `seriesId`, `parameterId`, `keyframeId`,
 * `range` / `cell` (A1, kind `cell`), and the same inside a command's `params`.
 */
export function playbackRefsFromArgs(args: unknown, defaultKind = 'item'): PlaybackRef[] {
	const out: PlaybackRef[] = [];
	const visit = (value: unknown, depth: number) => {
		if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 1) return;
		const record = value as Record<string, unknown>;
		pushRef(out, defaultKind, record.id);
		if (Array.isArray(record.ids)) for (const id of record.ids) pushRef(out, defaultKind, id);
		for (const [key, kind] of Object.entries(ARG_KINDS)) {
			pushRef(out, kind, record[key]);
			const many = record[`${key}s`];
			if (Array.isArray(many)) for (const id of many) pushRef(out, kind, id);
		}
		pushRef(out, 'cell', record.range);
		pushRef(out, 'cell', record.cell);
		visit(record.params, depth + 1);
	};
	visit(args, 0);
	return out;
}

/**
 * The things a write's result names: `id`, `ids`, `node.id`, `layerId`, `layer.id`, `created` (a list, or `{ nodes, edges }`),
 * also inside a command result's `result`. Used to point at what a call created.
 */
export function playbackRefsFromResult(value: unknown, defaultKind = 'item'): PlaybackRef[] {
	const out: PlaybackRef[] = [];
	const visit = (v: unknown, depth: number) => {
		if (!v || typeof v !== 'object' || depth > 2) return;
		if (Array.isArray(v)) {
			for (const item of v) if (item && typeof item === 'object') pushRef(out, defaultKind, (item as { id?: unknown }).id);
			return;
		}
		const record = v as Record<string, unknown>;
		if (Array.isArray(record.content) && record.structuredContent) return visit(record.structuredContent, depth);
		pushRef(out, defaultKind, record.id);
		if (Array.isArray(record.ids)) for (const id of record.ids) pushRef(out, defaultKind, id);
		if (record.node && typeof record.node === 'object') pushRef(out, 'node', (record.node as { id?: unknown }).id);
		pushRef(out, 'layer', record.layerId);
		if (record.layer && typeof record.layer === 'object') pushRef(out, 'layer', (record.layer as { id?: unknown }).id);
		const created = record.created;
		if (Array.isArray(created)) visit(created, depth + 1);
		else if (created && typeof created === 'object') {
			const c = created as { nodes?: Array<{ id?: unknown }>; edges?: Array<{ id?: unknown }> };
			for (const n of c.nodes ?? []) pushRef(out, 'node', n?.id);
			for (const e of c.edges ?? []) pushRef(out, 'edge', e?.id);
		}
		if (record.result && typeof record.result === 'object') visit(record.result, depth + 1);
	};
	visit(value, 0);
	return out;
}

/**
 * The default performance: visit what the arguments name (at most 8), press, commit. Bare ids get
 * kind `item` unless `defaultKind` is given; a surface reads `item` as its own `defaultKind`.
 */
export function derivePlaybackSteps(args: unknown, defaultKind?: string): PlaybackStep[] {
	const refs = playbackRefsFromArgs(args, defaultKind).slice(0, 8);
	if (!refs.length) return [{ type: 'commit' }];
	return [...refs.map((ref): PlaybackStep => ({ type: 'target', ref })), { type: 'press' }, { type: 'release' }, { type: 'commit' }];
}

/** Time to read a note: about 15 characters a second, between 0.6 s and 2.2 s. */
export function readingTime(text: string): number {
	return Math.min(2200, Math.max(600, text.length * 65));
}

/** Smallest rectangle around `rects`, or null. */
export function unionRects(rects: readonly (PlaybackRect | null | undefined)[]): PlaybackRect | null {
	const list = rects.filter((r): r is PlaybackRect => !!r);
	if (!list.length) return null;
	const x = Math.min(...list.map((r) => r.x));
	const y = Math.min(...list.map((r) => r.y));
	return { x, y, width: Math.max(...list.map((r) => r.x + r.width)) - x, height: Math.max(...list.map((r) => r.y + r.height)) - y };
}

function normalizePlan(plan: PlaybackPlan): PlaybackPlanResult | null {
	if (!plan) return null;
	if (Array.isArray(plan)) return plan.length ? { steps: plan } : null;
	return plan.steps?.length || plan.surface || plan.readOnly !== undefined ? plan : null;
}

const isErrorResult = (value: unknown): value is { isError: true; content?: Array<{ type: string; text?: string }> } =>
	!!value && typeof value === 'object' && (value as { isError?: unknown }).isError === true;

const center = (r: PlaybackRect): PlaybackPoint => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

const finiteRect = (r: PlaybackRect | null): PlaybackRect | null =>
	r && [r.x, r.y, r.width, r.height].every(Number.isFinite) ? r : null;

const GLANCE_STEPS = new Set<PlaybackStep['type']>(['move', 'target', 'focus', 'say', 'wait', 'commit']);

interface ActorState {
	info: PresenceActorInfo & { color: string };
	queue: Promise<unknown>;
	surface?: string;
	viewport?: PlaybackPoint;
	version: number;
}

/**
 * Acts out tool calls on attached surfaces. Install it on a registry (`registry.use(playback.middleware)`
 * or `playback.install(registry)`); editors attach their surfaces while mounted. Results never change:
 * a call returns the same value or error with or without playback.
 */
export class AgentPlayback {
	/** 1 = natural pace; `Infinity` plays nothing (calls run instantly). Takes effect on the next step. */
	speed: number;
	reads: PlaybackReads;
	readonly clock: PresenceClock;
	private readonly linger: number;
	private readonly defaultActor: PresenceActorInfo;
	private readonly surfaces = new Map<string, PlaybackSurface>();
	private readonly actors = new Map<string, ActorState>();
	private readonly recordings = new Set<PlaybackRecord[]>();
	private readonly installed = new WeakSet<ToolRegistry>();
	private readonly listeners = new Set<() => void>();
	private generation = 0;
	private running = 0;
	private calls = 0;

	constructor(options: AgentPlaybackOptions = {}) {
		this.clock = options.clock ?? realPresenceClock;
		this.speed = options.speed ?? 1;
		this.reads = options.reads ?? 'glance';
		this.linger = options.linger ?? 1500;
		this.defaultActor = options.actor ?? { id: 'agent', name: 'Agent' };
	}

	/** The registry middleware that plays each call. */
	readonly middleware: ToolMiddleware = (call, next) => this.perform(call, next);

	/** Adds the middleware to `registry` once (later calls with the same registry do nothing). */
	install(registry: ToolRegistry): void {
		if (this.installed.has(registry)) return;
		this.installed.add(registry);
		registry.use(this.middleware);
	}

	/** Whether a performance is playing now (e.g. to make the editor read-only meanwhile). */
	get active(): boolean {
		return this.running > 0;
	}

	/** Called when `active` changes. Returns an unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Attaches a surface under a provider id (or the id providers name as `playbackSurface`). */
	attach(id: string, surface: PlaybackSurface): () => void {
		this.surfaces.set(id, surface);
		return () => {
			if (this.surfaces.get(id) !== surface) return;
			this.surfaces.delete(id);
			for (const actor of this.actors.values()) if (actor.surface === id) actor.surface = undefined;
		};
	}

	/** The surface attached under `id`. */
	surface(id: string): PlaybackSurface | undefined {
		return this.surfaces.get(id);
	}

	/** Shows `text` in the actor's bubble on the surface it last worked on (until its next step). */
	say(text: string, options: { actor?: PresenceActorInfo } = {}): void {
		const actor = this.actorState(options.actor);
		const surface = actor.surface ? this.surfaces.get(actor.surface) : undefined;
		if (surface?.presence.get(actor.info.id)) surface.presence.set({ id: actor.info.id, message: text });
	}

	/** Finishes every running performance at once (the calls still run and keep their results). */
	stop(): void {
		this.generation++;
	}

	/** Collects every step played from now on (for tests). */
	record(): PlaybackRecord[] {
		const list: PlaybackRecord[] = [];
		this.recordings.add(list);
		return list;
	}

	private actorState(info?: PresenceActorInfo): ActorState {
		const base = info ?? this.defaultActor;
		let actor = this.actors.get(base.id);
		if (!actor) {
			actor = { info: { ...base, color: base.color ?? PRESENCE_COLORS[this.actors.size % PRESENCE_COLORS.length]! }, queue: Promise.resolve(), version: 0 };
			this.actors.set(base.id, actor);
		} else if (info?.name && info.name !== actor.info.name) actor.info = { ...actor.info, name: info.name };
		return actor;
	}

	private enqueue<T>(actor: ActorState, run: () => Promise<T>): Promise<T> {
		const result = actor.queue.then(run);
		actor.queue = result.catch(() => undefined);
		return result;
	}

	private surfaceFor(provider: AgentToolProvider, hint?: string): [string, PlaybackSurface] | null {
		for (const id of [hint, provider.playbackSurface, provider.id, provider.namespace]) {
			const surface = id ? this.surfaces.get(id) : undefined;
			if (id && surface) return [id, surface];
		}
		return null;
	}

	private async perform(call: ToolMiddlewareCall, next: () => Promise<unknown>): Promise<unknown> {
		const tool = call.tool;
		if (tool.playback === false || !Number.isFinite(this.speed)) return next();
		const actor = this.actorState(call.context.actor);
		// Directors act themselves; queue them so one actor's calls still play in order.
		if (tool.playback === 'self') return this.enqueue(actor, next);

		const fallback = this.surfaceFor(call.provider);
		let planned: PlaybackPlanResult | null = null;
		if (tool.plan) {
			try {
				const state: PlaybackPlanState = {
					surfaceId: fallback?.[0] ?? null,
					locate: (ref) => fallback?.[1].locate?.(ref) ?? null
				};
				planned = normalizePlan(tool.plan(call.args, state));
			} catch {
				planned = null;
			}
		}
		const readOnly = planned?.readOnly ?? tool.annotations?.readOnlyHint === true;
		if (readOnly && this.reads === 'skip') return next();
		const found = this.surfaceFor(call.provider, planned?.surface);
		if (!found) return next();
		const [surfaceId, surface] = found;
		const steps = planned?.steps?.length ? planned.steps : derivePlaybackSteps(call.args, surface.defaultKind);
		const glance = readOnly && this.reads === 'glance';
		const played = glance ? steps.filter((s) => GLANCE_STEPS.has(s.type)) : steps;
		// Nothing to point at: run it without showing a cursor.
		if (!played.some((s) => s.type !== 'commit')) return next();

		return this.enqueue(actor, async () => {
			if (surface.visible && !surface.visible()) {
				await surface.reveal?.();
				if (surface.visible && !surface.visible()) return next();
			}
			return this.play({ call, next, actor, surfaceId, surface, steps: played, readOnly, glance });
		});
	}

	private async play(run: {
		call: ToolMiddlewareCall;
		next: () => Promise<unknown>;
		actor: ActorState;
		surfaceId: string;
		surface: PlaybackSurface;
		steps: PlaybackStep[];
		readOnly: boolean;
		glance: boolean;
	}): Promise<unknown> {
		const { call, next, actor, surfaceId, surface, readOnly } = run;
		const id = actor.info.id;
		const gen = this.generation;
		const instant = () => gen !== this.generation || !Number.isFinite(this.speed);
		const pace = () => Math.max(0.1, this.speed) * (run.glance ? 1.6 : 1);
		const wait = (ms: number) => (instant() || ms <= 0 ? Promise.resolve() : this.clock.wait(ms / pace()));
		const presence = surface.presence;
		// A surface's locate is host code: a rectangle with a NaN or infinite number counts as not found.
		const locate = (ref: PlaybackRef) => finiteRect(surface.locate?.(ref.kind === 'item' ? { kind: surface.defaultKind ?? 'item', id: ref.id } : ref) ?? null);
		const record = (step: PlaybackStep) => {
			for (const list of this.recordings) list.push({ actor: id, surface: surfaceId, tool: call.name, step });
		};

		this.running++;
		if (this.running === 1) this.listeners.forEach((l) => l());
		try {
			// Leave the surface the actor worked on before, entering this one where its cursor was.
			if (actor.surface && actor.surface !== surfaceId) this.surfaces.get(actor.surface)?.presence.remove(id);
			if (!presence.get(id)) {
				const bounds = surface.bounds?.() ?? null;
				let at: PlaybackPoint | null = actor.viewport && surface.fromViewport ? surface.fromViewport(actor.viewport) : null;
				if (at && bounds) at = { x: Math.min(bounds.x + bounds.width, Math.max(bounds.x, at.x)), y: Math.min(bounds.y + bounds.height, Math.max(bounds.y, at.y)) };
				at ??= bounds ? { x: bounds.x + bounds.width - 48, y: bounds.y + 32 } : null;
				if (!at) {
					const first = run.steps.find((s) => s.type === 'move' || s.type === 'target' || s.type === 'drag');
					const rect = first?.type === 'target' ? locate(first.ref) : null;
					at = first && first.type !== 'target' ? first.to : rect ? center(rect) : { x: 0, y: 0 };
				}
				presence.set({ id, name: actor.info.name ?? id, color: actor.info.color, x: at.x, y: at.y, pressed: false });
			} else presence.set({ id, name: actor.info.name ?? id, color: actor.info.color });
			actor.surface = surfaceId;
			actor.version++;

			const argRefs = playbackRefsFromArgs(call.args, surface.defaultKind);
			if (!readOnly) surface.beginGesture?.(`agent:${id}:${++this.calls}`);
			let result: unknown;
			let committed = false;
			try {
				for (const step of run.steps) {
					record(step);
					if (step.type === 'commit') {
						if (committed) continue;
						committed = true;
						result = await next();
						continue;
					}
					if (step.type === 'open') {
						if (!surface.open) continue;
						const rect = locate(step.ref);
						if (rect) {
							await this.glide(presence, id, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, step.ms, instant);
							presence.set({ id, pressed: true });
							await wait(90);
						}
						await surface.open(step.ref);
						presence.set({ id, pressed: false });
						await wait(220);
						continue;
					}
					await this.step(presence, locate, id, step, wait, instant);
				}
				if (!committed) {
					record({ type: 'commit' });
					result = await next();
				}
			} catch (error) {
				presence.set({ id, pressed: false, message: `✗ ${error instanceof Error ? error.message : String(error)}`.slice(0, 140) });
				await wait(900);
				throw error;
			} finally {
				if (!readOnly) surface.endGesture?.();
				presence.set({ id, pressed: false });
			}

			if (isErrorResult(result)) {
				const text = result.content?.find((c) => c.type === 'text')?.text ?? 'The tool failed.';
				presence.set({ id, message: `✗ ${text}`.slice(0, 140) });
				await wait(900);
			} else if (!readOnly) {
				// Point at what the call created or changed that its arguments didn't name.
				const known = new Set(argRefs.map((r) => `${r.kind}:${r.id}`));
				const fresh = playbackRefsFromResult(result, surface.defaultKind).filter((r) => !known.has(`${r.kind}:${r.id}`));
				const rect = unionRects(fresh.slice(0, 16).map(locate));
				if (rect) {
					const step: PlaybackStep = { type: 'focus', rect };
					record(step);
					presence.set({ id, focus: rect });
					await wait(450);
				}
			}
			presence.set({ id, message: undefined, focus: undefined });
			const here = presence.get(id);
			if (here && surface.toViewport) actor.viewport = surface.toViewport({ x: here.x, y: here.y });
			this.scheduleLinger(actor, surface);
			return result;
		} finally {
			this.running--;
			if (this.running === 0) this.listeners.forEach((l) => l());
		}
	}

	private scheduleLinger(actor: ActorState, surface: PlaybackSurface) {
		if (this.linger <= 0) return;
		const version = actor.version;
		void this.clock.wait(this.linger).then(() => {
			if (actor.version !== version) return;
			surface.presence.remove(actor.info.id);
			for (const [sid, s] of this.surfaces) if (s === surface && actor.surface === sid) actor.surface = undefined;
		});
	}

	private async step(
		presence: PresenceStore,
		locate: (ref: PlaybackRef) => PlaybackRect | null,
		id: string,
		step: PlaybackStep,
		wait: (ms: number) => Promise<void>,
		instant: () => boolean
	) {
		switch (step.type) {
			case 'move':
				return this.glide(presence, id, step.to, step.ms, instant);
			case 'drag':
				presence.set({ id, pressed: true });
				return this.glide(presence, id, step.to, step.ms, instant);
			case 'target': {
				const rect = locate(step.ref);
				if (!rect) return;
				await this.glide(presence, id, center(rect), step.ms, instant);
				presence.set({ id, focus: rect });
				return;
			}
			case 'focus':
				presence.set({ id, focus: step.rect ?? undefined });
				return;
			case 'say':
				presence.set({ id, message: step.text });
				return wait(step.ms ?? readingTime(step.text));
			case 'press':
				presence.set({ id, pressed: true });
				return wait(90);
			case 'release':
				presence.set({ id, pressed: false });
				return wait(60);
			case 'type': {
				const total = step.ms ?? Math.min(900, 40 * step.text.length + 150);
				if (instant() || !(total > 0) || !Number.isFinite(total)) {
					presence.set({ id, message: step.text });
					return;
				}
				const start = this.clock.now();
				for (;;) {
					const t = Math.min(1, (this.clock.now() - start) / (total / Math.max(0.1, this.speed)));
					presence.set({ id, message: step.text.slice(0, Math.max(1, Math.round(step.text.length * t))) });
					if (t >= 1 || instant()) break;
					await this.clock.wait(16);
				}
				presence.set({ id, message: step.text });
				return;
			}
			case 'wait':
				return wait(step.ms);
		}
	}

	/** Glides along a slight arc with ease-out, by elapsed time (fewer frames in a throttled tab, never longer). */
	private async glide(presence: PresenceStore, id: string, to: PlaybackPoint, ms: number | undefined, instant: () => boolean) {
		// A plan's point may come from bad arguments: never glide toward (or from) NaN, which would never arrive.
		if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) return;
		const a = presence.get(id);
		const from = a && Number.isFinite(a.x) && Number.isFinite(a.y) ? { x: a.x, y: a.y } : to;
		const dist = Math.hypot(to.x - from.x, to.y - from.y);
		const duration = (ms ?? Math.min(900, 260 + dist * 0.5)) / Math.max(0.1, this.speed);
		if (instant() || dist < 1 || !(duration > 0) || !Number.isFinite(duration)) {
			presence.set({ id, x: to.x, y: to.y });
			return;
		}
		const bend = Math.min(60, dist * 0.12);
		const ctrl = { x: (from.x + to.x) / 2 - ((to.y - from.y) / dist) * bend, y: (from.y + to.y) / 2 + ((to.x - from.x) / dist) * bend };
		const start = this.clock.now();
		for (;;) {
			const t = Math.min(1, (this.clock.now() - start) / duration);
			const e = 1 - Math.pow(1 - t, 3);
			const u = 1 - e;
			presence.set({ id, x: u * u * from.x + 2 * u * e * ctrl.x + e * e * to.x, y: u * u * from.y + 2 * u * e * ctrl.y + e * e * to.y });
			if (t >= 1) break;
			if (instant()) {
				presence.set({ id, x: to.x, y: to.y });
				break;
			}
			await this.clock.wait(16);
		}
	}
}

/** An {@link AgentPlayback}: install it on a registry and attach editor surfaces to see calls played. */
export function createAgentPlayback(options: AgentPlaybackOptions = {}): AgentPlayback {
	return new AgentPlayback(options);
}
