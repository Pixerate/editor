// Agent "performances" follow Ursula's remote control (src/remote/commands.ts `planCommand`, src/react/remote/director.ts,
// presence.ts, clock.ts): a pure planner turns a command into cursor steps, a director acts them out per actor and
// commits each command as one undo step, and the clock is injectable so performances are repeatable in tests.
import type { ChartController, ChartSpecPatch } from './controller.js';
import { linearMap } from './scale.js';
import type { ChartScene, ChartSelection, ChartSpec } from './types.js';

export interface ChartPresenceActor {
	id: string;
	name: string;
	color: string;
	/** Cursor position in scene coordinates. */
	x: number;
	y: number;
	/** The button is down (dragging). */
	pressed: boolean;
	/** A short note shown next to the cursor (what the agent is doing). */
	message?: string;
}

export interface ChartPresenceState {
	actors: readonly ChartPresenceActor[];
}

/** Cursor positions and notes of agents acting on a chart, for an overlay. */
export class ChartPresence {
	private state: ChartPresenceState = { actors: [] };
	private readonly listeners = new Set<(state: ChartPresenceState) => void>();

	getState = (): ChartPresenceState => this.state;

	subscribe = (listener: (state: ChartPresenceState) => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	/** Adds or changes an actor. */
	set(actor: Pick<ChartPresenceActor, 'id'> & Partial<ChartPresenceActor>): void {
		const current = this.state.actors.find((a) => a.id === actor.id);
		const next: ChartPresenceActor = { name: actor.id, color: CHART_PRESENCE_COLORS[this.state.actors.length % CHART_PRESENCE_COLORS.length], x: 0, y: 0, pressed: false, ...current, ...actor };
		this.state = { actors: current ? this.state.actors.map((a) => (a.id === actor.id ? next : a)) : [...this.state.actors, next] };
		this.listeners.forEach((l) => l(this.state));
	}

	remove(id: string): void {
		if (!this.state.actors.some((a) => a.id === id)) return;
		this.state = { actors: this.state.actors.filter((a) => a.id !== id) };
		this.listeners.forEach((l) => l(this.state));
	}
}

export const CHART_PRESENCE_COLORS: readonly string[] = ['#7c3aed', '#db2777', '#0891b2', '#ea580c', '#16a34a'];

/** Time for performances: real timers, or an instant clock for tests and recordings. */
export interface ChartClock {
	now(): number;
	wait(ms: number): Promise<void>;
}

export const realChartClock: ChartClock = {
	now: () => Date.now(),
	wait: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
};

/** A clock whose waits finish at once while its time still advances (repeatable performances). */
export function createInstantChartClock(start = 0): ChartClock & { elapsed(): number } {
	let t = start;
	return {
		now: () => t,
		wait: async (ms) => {
			t += Math.max(0, ms);
		},
		elapsed: () => t - start
	};
}

/** What an agent asks for. Each command commits as one undo step. */
export type ChartAgentCommand =
	| { kind: 'setValue'; seriesId: string; index: number; value: number; note?: string }
	| { kind: 'select'; selection: ChartSelection | null; note?: string }
	| { kind: 'update'; patch: ChartSpecPatch; label?: string; note?: string }
	| { kind: 'say'; text: string };

export type ChartPerformanceStep =
	| { type: 'move'; to: { x: number; y: number }; ms: number }
	| { type: 'say'; text: string; ms: number }
	| { type: 'press' }
	| { type: 'drag'; to: { x: number; y: number }; ms: number; from: number; value: number }
	| { type: 'release' }
	| { type: 'commit' };

/** Where a point or bar sits in the scene (its top for bars), or null when it is not drawn. */
export function chartPointAnchor(scene: ChartScene, seriesId: string, index: number): { x: number; y: number } | null {
	const mark = scene.marks.find((m) => (m.role === 'bar' || m.role === 'point') && m.target?.kind === 'point' && m.target.seriesId === seriesId && m.target.index === index);
	if (!mark) return null;
	if (mark.kind === 'rect') return { x: mark.x + mark.width / 2, y: mark.y };
	if (mark.kind === 'circle') return { x: mark.cx, y: mark.cy };
	return null;
}

const anchorFor = (scene: ChartScene, role: string) => {
	const m = scene.marks.find((x) => x.role === role);
	if (!m) return null;
	if (m.kind === 'text') return { x: m.x, y: m.y };
	if (m.kind === 'rect') return { x: m.x + m.width / 2, y: m.y + m.height / 2 };
	if (m.kind === 'line') return { x: (m.x1 + m.x2) / 2, y: (m.y1 + m.y2) / 2 };
	return null;
};

/**
 * Plans how an agent acts out a command on the chart: cursor moves, a drag along the value
 * axis for a value change (its end at the new value), a note, then a commit. Pure: the same
 * scene and command give the same steps.
 */
export function planChartCommand(spec: ChartSpec, scene: ChartScene, command: ChartAgentCommand, speed = 1): ChartPerformanceStep[] {
	const ms = (n: number) => Math.round(n / Math.max(0.1, speed));
	const steps: ChartPerformanceStep[] = [];
	const note = 'note' in command && command.note ? command.note : undefined;
	if (note) steps.push({ type: 'say', text: note, ms: ms(500) });
	switch (command.kind) {
		case 'say':
			steps.push({ type: 'say', text: command.text, ms: ms(900) });
			return steps;
		case 'setValue': {
			const at = chartPointAnchor(scene, command.seriesId, command.index);
			const series = spec.series.find((s) => s.id === command.seriesId);
			const from = series?.values[command.index] ?? 0;
			const scale = series?.axis === 'secondary' ? (scene.valueScale2 ?? scene.valueScale) : scene.valueScale;
			if (at && scale) {
				const px = linearMap(command.value, scale.domain, scale.range);
				const to = scale.axis === 'y' ? { x: at.x, y: px } : { x: px, y: at.y };
				steps.push({ type: 'move', to: at, ms: ms(380) }, { type: 'press' }, { type: 'drag', to, ms: ms(520), from, value: command.value }, { type: 'release' });
			} else steps.push({ type: 'drag', to: { x: scene.plot.x + scene.plot.width / 2, y: scene.plot.y + scene.plot.height / 2 }, ms: ms(200), from, value: command.value });
			steps.push({ type: 'commit' });
			return steps;
		}
		case 'select': {
			const sel = command.selection;
			let to: { x: number; y: number } | null = null;
			if (sel?.kind === 'point') to = chartPointAnchor(scene, sel.seriesId, sel.index);
			else if (sel) {
				const m = scene.marks.find((x) => x.target && JSON.stringify(x.target) === JSON.stringify(sel));
				if (m?.kind === 'text') to = { x: m.x, y: m.y };
				else if (m?.kind === 'rect') to = { x: m.x + m.width / 2, y: m.y + m.height / 2 };
				else if (m?.kind === 'circle') to = { x: m.cx, y: m.cy };
			}
			if (to) steps.push({ type: 'move', to, ms: ms(380) }, { type: 'press' }, { type: 'release' });
			steps.push({ type: 'commit' });
			return steps;
		}
		case 'update': {
			const keys = Object.keys(command.patch);
			const role = keys.includes('title') ? 'title' : keys.includes('legend') ? 'legend-label' : keys.some((k) => k === 'xAxis') ? 'axis' : keys.some((k) => k === 'yAxis' || k === 'yAxis2') ? 'tick-label' : null;
			const to = (role && anchorFor(scene, role)) || { x: scene.plot.x + scene.plot.width / 2, y: scene.plot.y + 12 };
			steps.push({ type: 'move', to, ms: ms(380) }, { type: 'press' }, { type: 'release' }, { type: 'commit' });
			return steps;
		}
	}
}

export interface ChartDirectorOptions {
	/** The scene as currently drawn (for cursor targets), e.g. the canvas' last layout. */
	scene: () => ChartScene;
	clock?: ChartClock;
	/** 1 = natural speed; 2 = twice as fast. */
	speed?: number;
	/** Hide each actor's cursor this long after its last command (ms, default 1500; 0 keeps it). */
	linger?: number;
}

export interface ChartDirectorActor {
	id: string;
	name?: string;
	color?: string;
}

export type ChartPerformanceResult = { ok: true; command: ChartAgentCommand } | { ok: false; command: ChartAgentCommand; message: string };

/**
 * Acts out agent commands on a chart: each actor's cursor moves to the target, drags values
 * into place (the chart updates live) and the command commits as one undo step, while the
 * user keeps editing. Commands queue per actor; a command whose target was deleted meanwhile
 * fails with a sentence instead of editing something else.
 */
export class ChartDirector {
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly clock: ChartClock;
	private calls = 0;

	constructor(
		private readonly controller: ChartController,
		readonly presence: ChartPresence,
		private readonly options: ChartDirectorOptions
	) {
		this.clock = options.clock ?? realChartClock;
	}

	/** Acts out `commands` in order for `actor`. Resolves with one result per command. */
	perform(actor: ChartDirectorActor, commands: readonly ChartAgentCommand[]): Promise<ChartPerformanceResult[]> {
		const prev = this.queues.get(actor.id) ?? Promise.resolve();
		const run = prev.then(async () => {
			const results: ChartPerformanceResult[] = [];
			this.presence.set({ id: actor.id, ...(actor.name ? { name: actor.name } : {}), ...(actor.color ? { color: actor.color } : {}) });
			// Everything one call changes is one undo step.
			this.controller.beginGesture(`agent:${actor.id}:${++this.calls}`);
			try {
				for (const command of commands) results.push(await this.performOne(actor.id, command));
			} finally {
				this.controller.endGesture();
				this.presence.set({ id: actor.id, message: undefined, pressed: false });
			}
			const linger = this.options.linger ?? 1500;
			if (linger > 0) {
				await this.clock.wait(linger);
				if (this.queues.get(actor.id) === run) this.presence.remove(actor.id);
			}
			return results;
		});
		this.queues.set(actor.id, run.catch(() => undefined));
		return run;
	}

	private stale(command: ChartAgentCommand): string | null {
		const spec = this.controller.getSpec();
		if (command.kind === 'setValue') {
			const s = spec.series.find((x) => x.id === command.seriesId);
			if (!s) return `The series "${command.seriesId}" no longer exists.`;
			if (command.index < 0 || command.index >= spec.categories.length) return `Category ${command.index} no longer exists.`;
			if (!Number.isFinite(command.value)) return 'The value must be a finite number.';
		}
		return null;
	}

	private async move(id: string, from: { x: number; y: number }, to: { x: number; y: number }, ms: number, each?: (t: number) => void) {
		const frames = Math.max(1, Math.round(ms / 16));
		for (let f = 1; f <= frames; f++) {
			const t = f / frames;
			const e = 1 - Math.pow(1 - t, 3);
			this.presence.set({ id, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
			each?.(e);
			await this.clock.wait(ms / frames);
		}
	}

	private async performOne(id: string, command: ChartAgentCommand): Promise<ChartPerformanceResult> {
		const stale = this.stale(command);
		if (stale) return { ok: false, command, message: stale };
		const steps = planChartCommand(this.controller.getSpec(), this.options.scene(), command, this.options.speed);
		const where = () => {
			const a = this.presence.getState().actors.find((x) => x.id === id)!;
			return { x: a.x, y: a.y };
		};
		{
			for (const step of steps) {
				switch (step.type) {
					case 'say':
						this.presence.set({ id, message: step.text });
						await this.clock.wait(step.ms);
						break;
					case 'move':
						await this.move(id, where(), step.to, step.ms);
						break;
					case 'press':
						this.presence.set({ id, pressed: true });
						break;
					case 'release':
						this.presence.set({ id, pressed: false });
						break;
					case 'drag': {
						if (command.kind !== 'setValue') break;
						// The value follows the cursor; the whole drag is one undo step.
						const stale2 = this.stale(command);
						if (stale2) return { ok: false, command, message: stale2 };
						const label = `${this.presence.getState().actors.find((a) => a.id === id)?.name ?? 'Agent'}: edit value`;
						await this.move(id, where(), step.to, step.ms, (e) => {
							const v = step.from + (step.value - step.from) * e;
							this.controller.setValue(command.seriesId, command.index, Number(v.toPrecision(12)), { label });
						});
						this.controller.setValue(command.seriesId, command.index, step.value, { label });
						break;
					}
					case 'commit': {
						if (command.kind === 'select') this.controller.select(command.selection);
						else if (command.kind === 'update') {
							const result = this.controller.update(command.patch, command.label ? { label: command.label } : {});
							if (!result.ok) return { ok: false, command, message: result.message };
						}
						break;
					}
				}
			}
			return { ok: true, command };
		}
	}
}
