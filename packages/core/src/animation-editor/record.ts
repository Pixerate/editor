// Timed-sample simplification after Ramer–Douglas–Peucker, measured against time (ideas only).
import { normalizeTokenColor } from '../tokens/color.js';
import type { AnimationEasing } from '../animation/easing.js';
import { applyMatrix } from '../vector/geometry.js';
import { compileMotionScene, indexMotionNodes, motionPropertyValue, motionRestValue, motionTrackKey, trackValue } from './compile.js';
import { freshShotId } from './edit.js';
import { motionFrameAt } from './evaluate.js';
import { namedWithSuggestion } from './issues.js';
import { smoothMotionLegs } from './smooth.js';
import type { MotionCommand, MotionScene, MotionShot } from './types.js';
import type { VectorBounds } from '../vector/types.js';

/**
 * Recording a take: the person (or an agent) performs changes live, dragging, resizing, turning
 * and recolouring nodes while time runs, and the take becomes a shot of ordinary commands that
 * play the performance back. Samples are values at times; the recorder keeps the few that matter
 * (within a tolerance of the performance) and turns them into smooth commands, so a recorded
 * shot reads and edits like a written one.
 */

/** A node's pose at one moment of a take. Give any of the values; `x` and `y` go together. */
export interface MotionTakeSample {
	/** Node id from the artwork. */
	node: string;
	/** Time from the start of the take, ms. */
	t: number;
	/** Where the node's centre is, document units. */
	x?: number;
	y?: number;
	/** Scale from rest (1 = rest size). */
	scaleX?: number;
	scaleY?: number;
	/** Turn from rest, degrees clockwise. */
	rotation?: number;
	/** Opacity, 0–1. */
	opacity?: number;
	/** Solid paints, e.g. `#0ea5e9`. */
	fill?: string;
	stroke?: string;
	strokeWidth?: number;
}

/** A performance: samples in any order, and how long the take ran. */
export interface MotionTake {
	samples: readonly MotionTakeSample[];
	/** Length of the take, ms (default: the last sample). The shot holds after its last change until then. */
	length?: number;
}

export interface MotionTakeOptions {
	/** The new shot's id (default `take`, `take-2`…). */
	id?: string;
	/** Its label (default `Recorded take`). */
	label?: string;
	/** Where the shot goes among the shots (default: the end). */
	at?: number;
	/**
	 * How closely commands follow the performance, as a multiple of the default tolerances (1:
	 * 1 document unit, 0.01 of scale or opacity, 0.5°, 0.25 of stroke width). Lower keeps more points.
	 */
	tolerance?: number;
}

export interface MotionTakeResult {
	/** The shot that plays the take back. */
	shot: MotionShot;
	/** The shot's position among the shots. */
	at: number;
	/** When the shot starts in the scene, ms. */
	start: number;
	/** Samples given and samples kept as points of commands. */
	samples: { given: number; kept: number };
}

/** Where a node is and how it looks at a time, in the terms a take records. */
export interface MotionNodePose {
	/** Centre, document units. */
	x: number;
	y: number;
	scaleX: number;
	scaleY: number;
	rotation: number;
	opacity: number;
	fill?: string;
	stroke?: string;
	strokeWidth?: number;
	/** Bounds as drawn at that time, document units (null for an empty group). */
	bounds: VectorBounds | null;
}

const TOLERANCE = { move: 1, scale: 0.01, rotation: 0.5, opacity: 0.01, strokeWidth: 0.25 };
/** Colour samples closer together than this (ms) are thinned out. */
const COLOR_GAP = 80;
const MAX_VIA = 64;

/** The pose of `id` at `time` (ms) in `scene`. */
export function motionNodePose(scene: MotionScene, id: string, time: number): MotionNodePose {
	const entry = indexMotionNodes(scene.artwork.nodes).get(id);
	if (!entry) throw new Error(`There is no element ${namedWithSuggestion(id, [...indexMotionNodes(scene.artwork.nodes).keys()])} in the artwork.`);
	const timeline = compileMotionScene(scene);
	const drawn = indexMotionNodes(motionFrameAt(scene, time).document.nodes).get(id);
	const centre = applyMatrix(entry.parentWorld, { x: entry.center.x + motionPropertyValue(timeline, id, 'x', time), y: entry.center.y + motionPropertyValue(timeline, id, 'y', time) });
	const paint = (property: 'fill' | 'stroke' | 'strokeWidth') => trackValue(timeline.tracks.get(motionTrackKey(id, property)), time) ?? motionRestValue(entry, property, scene.artwork);
	const fill = paint('fill');
	const stroke = paint('stroke');
	const width = paint('strokeWidth');
	return {
		x: centre.x,
		y: centre.y,
		scaleX: motionPropertyValue(timeline, id, 'scaleX', time),
		scaleY: motionPropertyValue(timeline, id, 'scaleY', time),
		rotation: motionPropertyValue(timeline, id, 'rotation', time),
		opacity: motionPropertyValue(timeline, id, 'opacity', time),
		...(typeof fill === 'string' && fill !== 'transparent' ? { fill } : {}),
		...(typeof stroke === 'string' && stroke !== 'transparent' ? { stroke } : {}),
		...(typeof width === 'number' ? { strokeWidth: width } : {}),
		bounds: drawn?.bounds ?? null
	};
}

/**
 * Indexes of the points to keep so that straight lines between them (in time) stay within `tol`
 * of every point: Ramer–Douglas–Peucker, with the error measured at each point's own time.
 */
export function simplifyTimedSamples(times: readonly number[], values: readonly (readonly number[])[], tol: number): number[] {
	const n = times.length;
	if (n <= 2) return [...Array(n).keys()];
	const keep = new Uint8Array(n);
	keep[0] = keep[n - 1] = 1;
	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		let worst = -1;
		let at = -1;
		const span = times[b] - times[a];
		for (let i = a + 1; i < b; i++) {
			const u = span > 0 ? (times[i] - times[a]) / span : 0;
			let e = 0;
			for (let d = 0; d < values[i].length; d++) {
				const v = values[a][d] + (values[b][d] - values[a][d]) * u;
				e += (values[i][d] - v) ** 2;
			}
			if (e > worst) {
				worst = e;
				at = i;
			}
		}
		if (at >= 0 && Math.sqrt(worst) > tol) {
			keep[at] = 1;
			stack.push([a, at], [at, b]);
		}
	}
	const out: number[] = [];
	keep.forEach((k, i) => k && out.push(i));
	return out;
}

type Channel = 'move' | 'scale' | 'rotation' | 'opacity' | 'strokeWidth' | 'fill' | 'stroke';
interface Timed<T> {
	t: number;
	v: T;
}
/** A command with its start in the take (ms), before the run is chained. */
interface Placed {
	start: number;
	command: MotionCommand;
}

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places || 0;
const ms = (n: number) => Math.max(0, Math.round(n));

/** Problems with a take's samples against the scene, or none. */
export function motionTakeProblems(scene: MotionScene, take: MotionTake): string[] {
	const problems: string[] = [];
	const nodes = indexMotionNodes(scene.artwork.nodes);
	if (!Array.isArray(take.samples) || !take.samples.length) return ['Give at least one sample.'];
	const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
	take.samples.forEach((s, i) => {
		const where = `Sample ${i + 1}`;
		if (!s || typeof s !== 'object') return problems.push(`${where} must be an object.`);
		if (typeof s.node !== 'string' || !nodes.has(s.node)) problems.push(`${where}: the artwork has no element ${namedWithSuggestion(String(s.node), [...nodes.keys()])}; get_animation lists the element ids.`);
		if (!num(s.t) || s.t < 0) problems.push(`${where}: "t" must be ms from the start of the take, ≥ 0.`);
		if ((s.x === undefined) !== (s.y === undefined)) problems.push(`${where}: give "x" and "y" together (the centre, document units).`);
		for (const k of ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity', 'strokeWidth'] as const) if (s[k] !== undefined && !num(s[k])) problems.push(`${where}: "${k}" must be a number.`);
		if (s.opacity !== undefined && num(s.opacity) && (s.opacity < 0 || s.opacity > 1)) problems.push(`${where}: "opacity" must be from 0 to 1.`);
		if (s.strokeWidth !== undefined && num(s.strokeWidth) && s.strokeWidth < 0) problems.push(`${where}: "strokeWidth" must be ≥ 0.`);
		for (const k of ['fill', 'stroke'] as const) if (s[k] !== undefined && (typeof s[k] !== 'string' || normalizeTokenColor(s[k]!) === null)) problems.push(`${where}: "${k}" must be a colour such as "#0ea5e9".`);
		if (['x', 'scaleX', 'scaleY', 'rotation', 'opacity', 'fill', 'stroke', 'strokeWidth'].every((k) => s[k as keyof MotionTakeSample] === undefined)) problems.push(`${where} records nothing; give at least one of x and y, scaleX, scaleY, rotation, opacity, fill, stroke, strokeWidth.`);
	});
	if (take.length !== undefined && !(num(take.length) && take.length >= 0)) problems.push('"length" must be ms ≥ 0.');
	return problems;
}

/** A channel's samples, in time order, the last value kept where two share a time. */
function channelSamples<T>(samples: readonly MotionTakeSample[], pick: (s: MotionTakeSample) => T | undefined): Timed<T>[] {
	const out: Timed<T>[] = [];
	for (const s of samples) {
		const v = pick(s);
		if (v === undefined) continue;
		if (out.length && Math.abs(out[out.length - 1].t - s.t) < 0.5) out[out.length - 1] = { t: s.t, v };
		else out.push({ t: s.t, v });
	}
	return out;
}

/** The commands that play one node's channel of the take. */
function channelCommands(node: string, channel: Channel, pose: MotionNodePose, samples: readonly MotionTakeSample[], tol: number, kept: { n: number }): Placed[] {
	const targets = [node];
	const out: Placed[] = [];
	if (channel === 'fill' || channel === 'stroke') {
		const list = channelSamples(samples, (s) => (s[channel] !== undefined ? normalizeTokenColor(s[channel]!) ?? undefined : undefined));
		let last = pose[channel] ? normalizeTokenColor(pose[channel]!) : null;
		let lastT = -Infinity;
		list.forEach((s, i) => {
			const final = i === list.length - 1;
			if (s.v === last || (!final && s.t - lastT < COLOR_GAP)) return;
			// The first change is instant (a click on a swatch); later ones tween from the one before.
			const duration = lastT === -Infinity ? 0 : s.t - lastT;
			out.push({ start: s.t - duration, command: { type: 'style', targets, [channel]: s.v, duration: ms(duration), ease: 'linear' } as MotionCommand });
			kept.n++;
			last = s.v;
			lastT = s.t;
		});
		return out;
	}
	const pick: (s: MotionTakeSample) => number[] | undefined =
		channel === 'move'
			? (s) => (s.x !== undefined && s.y !== undefined ? [s.x, s.y] : undefined)
			: channel === 'scale'
				? (s) => (s.scaleX !== undefined || s.scaleY !== undefined ? [s.scaleX ?? s.scaleY!, s.scaleY ?? s.scaleX!] : undefined)
				: (s) => (s[channel] !== undefined ? [s[channel]!] : undefined);
	const list = channelSamples(samples, pick);
	if (!list.length) return out;
	const rest = channel === 'move' ? [pose.x, pose.y] : channel === 'scale' ? [pose.scaleX, pose.scaleY] : [(pose[channel] as number | undefined) ?? (channel === 'strokeWidth' ? 1 : 0)];
	const limit = TOLERANCE[channel] * tol;
	const differs = (a: readonly number[], b: readonly number[]) => Math.hypot(...a.map((v, d) => v - b[d])) > limit;
	const make = (to: readonly number[], duration: number, ease: AnimationEasing, extra: Record<string, unknown> = {}): MotionCommand => {
		const base = { targets, duration: ms(duration), ease, ...extra };
		switch (channel) {
			case 'move':
				return { type: 'move', ...base, to: { x: round(to[0]), y: round(to[1]) } } as MotionCommand;
			case 'scale':
				return { type: 'scale', ...base, to: Math.abs(to[0] - to[1]) < 1e-4 ? round(to[0], 4) : { x: round(to[0], 4), y: round(to[1], 4) } } as MotionCommand;
			case 'rotation':
				return { type: 'rotate', ...base, to: round(to[0]) } as MotionCommand;
			case 'opacity':
				return { type: 'fade', ...base, to: round(to[0], 4) } as MotionCommand;
			default:
				return { type: 'style', ...base, strokeWidth: round(to[0]) } as MotionCommand;
		}
	};
	// Into the first sample: instant, when it is not where the node already is.
	if (differs(list[0].v, rest)) {
		out.push({ start: list[0].t, command: make(list[0].v, 0, 'linear') });
		kept.n++;
	}
	if (list.length < 2) return out;
	const times = list.map((s) => s.t);
	const values = list.map((s) => s.v);
	let factor = 1;
	let keep = simplifyTimedSamples(times, values, limit);
	if (channel === 'move') {
		// One move through its waypoints, with the times the performance reached each.
		while (keep.length - 2 > MAX_VIA) keep = simplifyTimedSamples(times, values, limit * (factor *= 1.5));
		const first = list[keep[0]];
		const end = list[keep[keep.length - 1]];
		if (!keep.some((k) => differs(values[k], first.v))) return out;
		const span = end.t - first.t;
		// Fractions must rise strictly inside (0, 1): a point that rounds onto its neighbour is dropped.
		const via: { s: Timed<number[]>; f: number }[] = [];
		for (const k of keep.slice(1, -1)) {
			const f = round((list[k].t - first.t) / span, 6);
			if (f > (via.at(-1)?.f ?? 0) && f < 1) via.push({ s: list[k], f });
		}
		const extra = via.length ? { via: via.map(({ s }) => ({ x: round(s.v[0]), y: round(s.v[1]) })), times: via.map(({ f }) => f) } : {};
		out.push({ start: first.t, command: make(end.v, span, 'linear', extra) });
		kept.n += via.length + 2;
		return out;
	}
	// Other channels: one command per stretch, eased so the speed carries across.
	const kt = keep.map((k) => times[k]);
	const legs = values[0].map((_, d) => smoothMotionLegs(kt, keep.map((k) => values[k][d])));
	for (let i = 0; i + 1 < keep.length; i++) {
		const a = values[keep[i]];
		const b = values[keep[i + 1]];
		if (!differs(a, b)) continue;
		// Each axis has its own ease; the one that changes more leads.
		const lead = a.length > 1 && Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]) ? 1 : 0;
		const leg = legs[lead][i];
		out.push({ start: leg.start, command: make(b, leg.end - leg.start, leg.ease) });
		kept.n++;
	}
	return out;
}

/**
 * Turns a take into a shot that plays it back: a node's path becomes one `move` through
 * waypoints reached at the recorded times; scales, turns, fades and stroke widths become a few
 * eased commands; paints change as they were picked. Commands are chained with `with:
 * "previous"` and `delay`, so each starts when it did in the take, and the shot holds until the
 * take's `length`. Before its first sample a property keeps its pose; the change into the first
 * sample is instant (start a drag at the node's pose so it travels from there). Throws, saying
 * why, on unknown nodes or malformed samples.
 */
export function motionTakeShot(scene: MotionScene, take: MotionTake, options: MotionTakeOptions = {}): MotionTakeResult {
	const problems = motionTakeProblems(scene, take);
	if (problems.length) throw new Error(problems.join(' '));
	const tol = options.tolerance !== undefined && options.tolerance > 0 ? options.tolerance : 1;
	const at = options.at ?? scene.shots.length;
	if (!Number.isInteger(at) || at < 0 || at > scene.shots.length) throw new Error(`"at" must be a whole number from 0 to ${scene.shots.length} (got ${at}).`);
	const timeline = compileMotionScene(scene);
	const start = at < timeline.shots.length ? timeline.shots[at].start : timeline.duration;
	const samples = [...take.samples].sort((a, b) => a.t - b.t);
	const placed: Placed[] = [];
	const kept = { n: 0 };
	const byNode = new Map<string, MotionTakeSample[]>();
	for (const s of samples) byNode.set(s.node, [...(byNode.get(s.node) ?? []), s]);
	for (const [node, list] of byNode) {
		const pose = motionNodePose(scene, node, start);
		for (const channel of ['move', 'scale', 'rotation', 'opacity', 'strokeWidth', 'fill', 'stroke'] as const) placed.push(...channelCommands(node, channel, pose, list, tol, kept));
	}
	placed.sort((a, b) => a.start - b.start);
	// Chain them: each starts its delay after the one before, so starts are the take's own.
	const run: MotionCommand[] = [];
	let prev = 0;
	let end = 0;
	placed.forEach((p, i) => {
		const s = ms(p.start);
		const delay = i === 0 ? s : s - prev;
		run.push({ ...p.command, ...(i > 0 ? { with: 'previous' as const } : {}), ...(delay > 0 ? { delay } : {}) } as MotionCommand);
		prev = s;
		end = Math.max(end, s + ((p.command as { duration?: number }).duration ?? 0));
	});
	const length = take.length ?? samples[samples.length - 1].t;
	const shot: MotionShot = { id: options.id ?? freshShotId(scene, 'take'), label: options.label ?? 'Recorded take', run, hold: ms(Math.max(0, length - end)) };
	// A take that changed nothing still lasts as long as it ran.
	if (!run.length) Object.assign(shot, { run: [{ type: 'wait', duration: ms(Math.max(1, length)) }], hold: 0 });
	return { shot, at, start, samples: { given: take.samples.length, kept: kept.n } };
}


/**
 * A point on the stage (client pixels, e.g. a pointer event) in document units: the stage draws
 * `camera` scaled to fit `box` and centred (SVG's default `xMidYMid meet`).
 */
export function motionClientToDocument(camera: { x: number; y: number; width: number; height: number }, box: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): { x: number; y: number } {
	const k = Math.min(box.width / camera.width, box.height / camera.height) || 1;
	const ox = box.left + (box.width - camera.width * k) / 2;
	const oy = box.top + (box.height - camera.height * k) / 2;
	return { x: camera.x + (clientX - ox) / k, y: camera.y + (clientY - oy) / k };
}
