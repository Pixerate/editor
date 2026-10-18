import { mixColorsOklab } from '../animation/color.js';
import { evaluateEasing, type AnimationEasing } from '../animation/easing.js';
import { bezierPathLength } from '../canvas/pathops/bezier.js';
import {
	IDENTITY_MATRIX,
	applyMatrix,
	collectPathNodes,
	invertMatrix,
	multiplyMatrices,
	nodeMatrix,
	vectorNodeBounds,
	vectorPathWorldBezier,
	type AffineMatrix
} from '../vector/geometry.js';
import type { VectorBounds, VectorNode, VectorPaint } from '../vector/types.js';
import {
	MOTION_CAMERA_MS,
	MOTION_DEFAULT_DURATIONS,
	MOTION_DEFAULT_HOLD,
	MOTION_DRAW_MS_PER_UNIT,
	MOTION_DRAW_RANGE,
	type MotionCamera,
	type MotionCommand,
	type MotionDirection,
	type MotionRect,
	type MotionScene
} from './types.js';

/**
 * Compiling a scene: shots and commands become timed segments, one per (node, property)
 * change. A property's value at a time is that of the latest segment to have started (its
 * `from` before the first one), so a node that enters later is hidden until then. This is
 * also how Flair's vector motion combines changes, which keeps the Flair export exact.
 */

/**
 * Properties a segment can change. Offsets (`x`, `y`, `rotation`) are relative to the rest
 * pose, scales multiply it, and turns and scales are about the node's centre at rest.
 * `effect:<effectId>:<param>` tweens a live path effect's parameter. `camera` (node `""`) is
 * the view box `[x, y, width, height]`.
 */
export type MotionProperty =
	| 'opacity'
	| 'x'
	| 'y'
	| 'rotation'
	| 'scaleX'
	| 'scaleY'
	| 'fill'
	| 'stroke'
	| 'strokeWidth'
	| 'fillOpacity'
	| 'drawStart'
	| 'drawEnd'
	| 'shape'
	| 'follow'
	| 'camera'
	| `effect:${string}:${string}`;

export type MotionValue = number | string | readonly number[];

/** An oscillation laid over a segment (`pulse`: scale up and back; `shake`: side to side, settling). */
export interface MotionWave {
	kind: 'pulse' | 'shake';
	amount: number;
	count: number;
}

export interface MotionSegment {
	/** Node id (`""` for the camera). */
	node: string;
	property: MotionProperty;
	start: number;
	end: number;
	from: MotionValue;
	to: MotionValue;
	ease: AnimationEasing;
	/** The shot and command (index in `run`) it comes from. */
	shot: string;
	command: number;
	wave?: MotionWave;
	/** For `follow`: the path node id, and whether to turn with it. */
	path?: string;
	rotate?: boolean;
}

export interface MotionShotTiming {
	id: string;
	index: number;
	label?: string;
	start: number;
	/** When the camera move ends and the commands begin. */
	commandsStart: number;
	/** When the last command ends (the hold follows). */
	commandsEnd: number;
	end: number;
}

export interface MotionCommandTiming {
	shot: string;
	shotIndex: number;
	command: number;
	type: MotionCommand['type'];
	start: number;
	end: number;
	/** Length per target (ms). */
	duration: number;
}

export interface MotionTimeline {
	/** Total length in ms. */
	duration: number;
	shots: MotionShotTiming[];
	commands: MotionCommandTiming[];
	segments: MotionSegment[];
	/** Segments per `node\u0000property`, in start order. */
	tracks: ReadonlyMap<string, readonly MotionSegment[]>;
}

/** Where a node sits in the artwork. */
export interface MotionNodeEntry {
	node: VectorNode;
	/** Ids from the root down to the node's parent. */
	ancestors: string[];
	/** Parent space → document space. */
	parentWorld: AffineMatrix;
	/** Centre of the node's bounds at rest, in its parent's space. */
	center: { x: number; y: number };
	/** Bounds at rest in document space. */
	bounds: VectorBounds | null;
}

const indexCache = new WeakMap<object, Map<string, MotionNodeEntry>>();

/** Every node of the artwork by id (cached per node list). */
export function indexMotionNodes(nodes: readonly VectorNode[]): Map<string, MotionNodeEntry> {
	const hit = indexCache.get(nodes);
	if (hit) return hit;
	const out = new Map<string, MotionNodeEntry>();
	const walk = (list: readonly VectorNode[], parentWorld: AffineMatrix, ancestors: string[]) => {
		for (const node of list) {
			const local = vectorNodeBounds(node);
			const bounds = vectorNodeBounds(node, parentWorld);
			const center = local ? { x: local.x + local.width / 2, y: local.y + local.height / 2 } : { x: 0, y: 0 };
			if (!out.has(node.id)) out.set(node.id, { node, ancestors, parentWorld, center, bounds });
			if (node.type === 'group') walk(node.children, multiplyMatrices(nodeMatrix(node), parentWorld), [...ancestors, node.id]);
		}
	};
	walk(nodes, IDENTITY_MATRIX, []);
	indexCache.set(nodes, out);
	return out;
}

const solid = (paint: VectorPaint | undefined): string | undefined => (typeof paint === 'string' && paint !== 'none' ? paint : undefined);

/** The first solid paint of a node (a group's first path with one). */
function firstPaint(node: VectorNode, key: 'fill' | 'stroke'): string | undefined {
	if (node.type === 'path') return solid(node[key]);
	for (const p of collectPathNodes(node)) {
		const s = solid(p[key]);
		if (s) return s;
	}
	return undefined;
}

/** A property's value with no animation. */
export function motionRestValue(entry: MotionNodeEntry | undefined, property: MotionProperty, artwork: { width: number; height: number }): MotionValue {
	const node = entry?.node;
	switch (property) {
		case 'opacity':
			return node?.opacity ?? 1;
		case 'x':
		case 'y':
		case 'rotation':
			return 0;
		case 'scaleX':
		case 'scaleY':
		case 'fillOpacity':
		case 'drawEnd':
			return 1;
		case 'drawStart':
			return 0;
		case 'follow':
			return -1;
		case 'fill':
		case 'stroke':
			return (node && firstPaint(node, property)) ?? 'transparent';
		case 'strokeWidth': {
			const path = node?.type === 'path' ? node : node ? collectPathNodes(node)[0] : undefined;
			return path?.strokeWidth ?? 1;
		}
		case 'shape':
			return node?.id ?? '';
		case 'camera':
			return [0, 0, artwork.width, artwork.height];
	}
	const [, effectId, param] = property.split(':');
	const effect = node?.effects?.find((e) => e.id === effectId);
	const v = effect ? (effect.params as unknown as Record<string, unknown>)[param] : undefined;
	return typeof v === 'number' ? v : 0;
}

/** `from` → `to` at eased progress `u` (numbers extrapolate, colours mix in OKLab, others switch at the end). */
export function interpolateMotionValue(from: MotionValue, to: MotionValue, u: number): MotionValue {
	if (typeof from === 'number' && typeof to === 'number') return from + (to - from) * u;
	if (Array.isArray(from) && Array.isArray(to) && from.length === to.length) return from.map((f, i) => f + ((to[i] as number) - f) * u);
	if (u <= 0) return from;
	if (u >= 1) return to;
	if (typeof from === 'string' && typeof to === 'string') {
		const mixed = mixColorsOklab(from, to, u);
		if (mixed !== null) return mixed;
	}
	return u < 1 ? from : to;
}

/** Progress (0–1, unclamped by the easing) of a segment at `time`. */
export function segmentProgress(segment: MotionSegment, time: number): { u: number; eased: number } {
	const span = segment.end - segment.start;
	const u = span <= 0 ? 1 : Math.min(1, Math.max(0, (time - segment.start) / span));
	return { u, eased: segment.wave ? u : evaluateEasing(segment.ease, u, span) };
}

/** A segment's value at `time`. */
export function segmentValue(segment: MotionSegment, time: number): MotionValue {
	const { u, eased } = segmentProgress(segment, time);
	const v = interpolateMotionValue(segment.from, segment.to, eased);
	if (!segment.wave || typeof v !== 'number') return v;
	const { kind, amount, count } = segment.wave;
	if (kind === 'pulse') return v * (1 + amount * Math.sin(Math.PI * u * count) ** 2);
	return v + amount * Math.sin(2 * Math.PI * u * count) * (1 - u);
}

/** The segment in effect at `time` (the latest to have started), if any. */
export function activeSegment(track: readonly MotionSegment[] | undefined, time: number): MotionSegment | undefined {
	if (!track?.length) return undefined;
	let found: MotionSegment | undefined;
	for (const s of track) if (s.start <= time && (!found || s.start >= found.start)) found = s;
	return found;
}

/** A track's value at `time`, or `undefined` when nothing animates it. */
export function trackValue(track: readonly MotionSegment[] | undefined, time: number): MotionValue | undefined {
	if (!track?.length) return undefined;
	const s = activeSegment(track, time);
	if (s) return segmentValue(s, time);
	let first = track[0];
	for (const t of track) if (t.start < first.start) first = t;
	return first.from;
}

export const motionTrackKey = (node: string, property: MotionProperty) => `${node}\u0000${property}`;

/** Grows a rectangle to the artwork's aspect ratio (about its centre). */
export function fitMotionRect(rect: MotionRect, aspect: number): MotionRect {
	const cx = rect.x + rect.width / 2;
	const cy = rect.y + rect.height / 2;
	let { width, height } = rect;
	if (width / height < aspect) width = height * aspect;
	else height = width / aspect;
	return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/** The rectangle a camera looks at, or `null` when it frames an unknown node. */
export function resolveMotionCamera(camera: MotionCamera, scene: MotionScene): MotionRect | null {
	if ('frame' in camera && typeof camera.frame === 'string') {
		const entry = indexMotionNodes(scene.artwork.nodes).get(camera.frame);
		if (!entry?.bounds) return null;
		const pad = camera.padding ?? 24;
		const b = entry.bounds;
		const rect = { x: b.x - pad, y: b.y - pad, width: Math.max(1, b.width + pad * 2), height: Math.max(1, b.height + pad * 2) };
		return fitMotionRect(rect, scene.artwork.width / scene.artwork.height);
	}
	const r = camera as MotionRect;
	return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** Length of a node's outline (its longest path for a group), in document units. */
export function motionPathLength(node: VectorNode, parentWorld: AffineMatrix = IDENTITY_MATRIX): number {
	let longest = 0;
	const paths = node.type === 'path' ? [node] : collectPathNodes(node);
	for (const p of paths) {
		try {
			longest = Math.max(longest, bezierPathLength(vectorPathWorldBezier(p, parentWorld, { effects: false })));
		} catch {
			/* unmeasurable: keep the default */
		}
	}
	return longest;
}

/** How long one target of a command takes (ms). */
export function motionCommandDuration(command: MotionCommand, scene: MotionScene, target?: string): number {
	if (command.type === 'wait') return command.duration;
	if (command.duration !== undefined) return command.duration;
	if (command.type === 'draw' || (command.type === 'enter' && command.style === 'draw') || (command.type === 'exit' && command.style === 'undraw')) {
		const entry = target ? indexMotionNodes(scene.artwork.nodes).get(target) : undefined;
		const length = entry ? motionPathLength(entry.node) : 0;
		const ms = length * MOTION_DRAW_MS_PER_UNIT;
		return Math.round(Math.min(MOTION_DRAW_RANGE[1], Math.max(MOTION_DRAW_RANGE[0], ms)));
	}
	return MOTION_DEFAULT_DURATIONS[command.type];
}

/** Cubic ease-out, `1 − (1 − t)³` exactly (Flair's `out`): the default for things arriving. */
export const MOTION_EASE_OUT: AnimationEasing = { type: 'cubic-bezier', x1: 1 / 3, y1: 1, x2: 2 / 3, y2: 1 };
/** Cubic ease-in-out (close to Flair's `in-out`): the default for moves. */
export const MOTION_EASE_IN_OUT: AnimationEasing = { type: 'cubic-bezier', x1: 0.65, y1: 0, x2: 0.35, y2: 1 };

const DIRECTION: Record<MotionDirection, { x: number; y: number }> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

const timelineCache = new WeakMap<MotionScene, MotionTimeline>();

/**
 * Times every shot and command and turns them into segments. Pure and cached per scene object
 * (treat scenes as immutable). Commands naming unknown nodes are timed but change nothing;
 * `checkMotionScene` reports them.
 */
export function compileMotionScene(scene: MotionScene): MotionTimeline {
	const hit = timelineCache.get(scene);
	if (hit) return hit;
	const nodes = indexMotionNodes(scene.artwork.nodes);
	const artwork = scene.artwork;

	// Pass 1: timing.
	const shots: MotionShotTiming[] = [];
	const commands: MotionCommandTiming[] = [];
	const cameraMoves: { shot: string; start: number; end: number; to: MotionRect; ease: AnimationEasing }[] = [];
	let t = 0;
	scene.shots.forEach((shot, index) => {
		const start = t;
		let cursor = start;
		if (shot.camera) {
			const rect = resolveMotionCamera(shot.camera, scene);
			if (rect && rect.width > 0 && rect.height > 0) {
				const ms = index === 0 ? 0 : (shot.camera.ms ?? MOTION_CAMERA_MS);
				cameraMoves.push({ shot: shot.id, start, end: start + ms, to: rect, ease: shot.camera.ease ?? MOTION_EASE_IN_OUT });
				cursor = start + ms;
			}
		}
		const commandsStart = cursor;
		let runEnd = cursor;
		let prevStart = cursor;
		shot.run.forEach((command, i) => {
			const base = command.with === 'previous' && i > 0 ? prevStart : runEnd;
			const begin = base + (command.type === 'wait' ? 0 : (command.delay ?? 0));
			const targets = command.type === 'wait' ? [] : command.targets;
			const durations = command.type === 'wait' ? [command.duration] : targets.map((id) => motionCommandDuration(command, scene, id));
			const stagger = command.type === 'wait' ? 0 : (command.stagger ?? 0);
			const end = durations.reduce((m, d, k) => Math.max(m, begin + k * stagger + d), begin);
			commands.push({ shot: shot.id, shotIndex: index, command: i, type: command.type, start: begin, end, duration: durations[0] ?? 0 });
			prevStart = begin;
			runEnd = Math.max(runEnd, end);
		});
		const end = runEnd + (shot.hold ?? MOTION_DEFAULT_HOLD);
		shots.push({ id: shot.id, index, ...(shot.label ? { label: shot.label } : {}), start, commandsStart, commandsEnd: runEnd, end });
		t = end;
	});

	// Pass 2: segments, in start order so each `from` is the value its segment starts at.
	const tracks = new Map<string, MotionSegment[]>();
	const segments: MotionSegment[] = [];
	const valueAt = (node: string, property: MotionProperty, time: number): MotionValue => {
		const v = trackValue(tracks.get(motionTrackKey(node, property)), time);
		return v ?? motionRestValue(nodes.get(node), property, artwork);
	};
	const push = (segment: MotionSegment) => {
		const key = motionTrackKey(segment.node, segment.property);
		let track = tracks.get(key);
		if (!track) tracks.set(key, (track = []));
		track.push(segment);
		segments.push(segment);
	};

	type Job = { start: number; order: number; run: () => void };
	const jobs: Job[] = [];
	let order = 0;
	for (const move of cameraMoves) {
		jobs.push({
			start: move.start,
			order: order++,
			run: () => push({ node: '', property: 'camera', start: move.start, end: move.end, from: valueAt('', 'camera', move.start), to: [move.to.x, move.to.y, move.to.width, move.to.height], ease: move.ease, shot: move.shot, command: -1 })
		});
	}
	for (const timing of commands) {
		const shot = scene.shots[timing.shotIndex];
		const command = shot.run[timing.command];
		if (command.type === 'wait') continue;
		command.targets.forEach((target, k) => {
			const entry = nodes.get(target);
			if (!entry) return;
			const start = timing.start + k * (command.stagger ?? 0);
			const duration = motionCommandDuration(command, scene, target);
			jobs.push({ start, order: order++, run: () => compileCommand(command, target, entry, start, duration, timing) });
		});
	}
	jobs.sort((a, b) => a.start - b.start || a.order - b.order).forEach((job) => job.run());

	function compileCommand(command: Exclude<MotionCommand, { type: 'wait' }>, node: string, entry: MotionNodeEntry, start: number, duration: number, timing: MotionCommandTiming) {
		const end = start + duration;
		const where = { shot: timing.shot, command: timing.command };
		const seg = (property: MotionProperty, to: MotionValue, ease: AnimationEasing, s = start, e = end, extra: Partial<MotionSegment> = {}) =>
			push({ node, property, start: s, end: e, from: extra.from ?? valueAt(node, property, s), to, ease, ...where, ...extra });
		const rest = (p: MotionProperty) => motionRestValue(entry, p, artwork);
		const num = (p: MotionProperty, time = start) => {
			const v = valueAt(node, p, time);
			return typeof v === 'number' ? v : 0;
		};
		const ease = command.ease;
		switch (command.type) {
			case 'enter': {
				const style = command.style ?? 'fade';
				const opacity = rest('opacity');
				if (style === 'draw') {
					seg('drawEnd', 1, ease ?? MOTION_EASE_IN_OUT, start, start + duration * 0.75, { from: 0 });
					seg('fillOpacity', 1, MOTION_EASE_OUT, start + duration * 0.6, end, { from: 0 });
					break;
				}
				if (style === 'pop') {
					seg('opacity', opacity, MOTION_EASE_OUT, start, start + duration * 0.4, { from: 0 });
					seg('scaleX', 1, ease ?? 'ease-out-back', start, end, { from: 0.5 });
					seg('scaleY', 1, ease ?? 'ease-out-back', start, end, { from: 0.5 });
				} else if (style === 'grow') {
					seg('opacity', opacity, MOTION_EASE_OUT, start, start + duration * 0.3, { from: 0 });
					seg('scaleX', 1, ease ?? MOTION_EASE_OUT, start, end, { from: 0 });
					seg('scaleY', 1, ease ?? MOTION_EASE_OUT, start, end, { from: 0 });
				} else if (style === 'slide') {
					const dir = DIRECTION[command.direction ?? 'up'];
					const distance = command.distance ?? 40;
					const x = num('x');
					const y = num('y');
					seg('opacity', opacity, MOTION_EASE_OUT, start, end, { from: 0 });
					seg('x', x, ease ?? MOTION_EASE_OUT, start, end, { from: x - dir.x * distance });
					seg('y', y, ease ?? MOTION_EASE_OUT, start, end, { from: y - dir.y * distance });
				} else seg('opacity', opacity, ease ?? MOTION_EASE_OUT, start, end, { from: 0 });
				break;
			}
			case 'exit': {
				const style = command.style ?? 'fade';
				if (style === 'undraw') {
					seg('fillOpacity', 0, 'ease-in', start, start + duration * 0.4);
					seg('drawEnd', 0, ease ?? MOTION_EASE_IN_OUT);
				} else if (style === 'shrink') {
					seg('scaleX', 0, ease ?? 'ease-in');
					seg('scaleY', 0, ease ?? 'ease-in');
					seg('opacity', 0, 'ease-in', start + duration * 0.6, end);
				} else if (style === 'slide') {
					const dir = DIRECTION[command.direction ?? 'down'];
					const distance = command.distance ?? 40;
					seg('x', num('x') + dir.x * distance, ease ?? 'ease-in');
					seg('y', num('y') + dir.y * distance, ease ?? 'ease-in');
					seg('opacity', 0, ease ?? 'ease-in');
				} else seg('opacity', 0, ease ?? 'ease-in');
				break;
			}
			case 'draw': {
				// A stroke not drawn before draws on from nothing (and is hidden until then).
				const drawn = tracks.has(motionTrackKey(node, 'drawEnd'));
				seg('drawEnd', command.to ?? 1, ease ?? MOTION_EASE_IN_OUT, start, end, command.from !== undefined ? { from: command.from } : drawn ? {} : { from: 0 });
				break;
			}
				break;
			case 'move': {
				const e = ease ?? MOTION_EASE_IN_OUT;
				let dx = command.by?.x ?? 0;
				let dy = command.by?.y ?? 0;
				if (command.to) {
					// The centre lands on `to` (document space): convert the remaining offset to the parent's space.
					const inv = invertMatrix(entry.parentWorld);
					const target = applyMatrix(inv, command.to);
					dx = target.x - (entry.center.x + num('x'));
					dy = target.y - (entry.center.y + num('y'));
				}
				seg('x', num('x') + dx, e);
				seg('y', num('y') + dy, e);
				break;
			}
			case 'rotate':
				seg('rotation', command.to ?? num('rotation') + (command.by ?? 0), ease ?? MOTION_EASE_IN_OUT);
				break;
			case 'scale': {
				const to = typeof command.to === 'number' ? { x: command.to, y: command.to } : command.to;
				seg('scaleX', to.x, ease ?? MOTION_EASE_IN_OUT);
				seg('scaleY', to.y, ease ?? MOTION_EASE_IN_OUT);
				break;
			}
			case 'fade':
				seg('opacity', command.to, ease ?? MOTION_EASE_IN_OUT);
				break;
			case 'style':
				if (command.fill !== undefined) seg('fill', command.fill, ease ?? MOTION_EASE_IN_OUT);
				if (command.stroke !== undefined) seg('stroke', command.stroke, ease ?? MOTION_EASE_IN_OUT);
				if (command.strokeWidth !== undefined) seg('strokeWidth', command.strokeWidth, ease ?? MOTION_EASE_IN_OUT);
				break;
			case 'morph':
				seg('shape', command.into, ease ?? MOTION_EASE_IN_OUT);
				break;
			case 'follow':
				seg('follow', command.to ?? 1, ease ?? MOTION_EASE_IN_OUT, start, end, { from: command.from ?? 0, path: command.path, rotate: command.rotate ?? false });
				break;
			case 'pulse': {
				const wave: MotionWave = { kind: 'pulse', amount: command.amount ?? 0.15, count: command.count ?? 1 };
				seg('scaleX', num('scaleX'), 'linear', start, end, { wave });
				seg('scaleY', num('scaleY'), 'linear', start, end, { wave });
				break;
			}
			case 'shake':
				seg('x', num('x'), 'linear', start, end, { wave: { kind: 'shake', amount: command.amount ?? 8, count: command.count ?? 3 } });
				break;
			case 'effect':
				seg(`effect:${command.effect}:${command.param}`, command.to, ease ?? MOTION_EASE_IN_OUT);
				break;
		}
	}

	for (const track of tracks.values()) track.sort((a, b) => a.start - b.start);
	segments.sort((a, b) => a.start - b.start);
	const duration = shots.length ? shots[shots.length - 1].end : 0;
	const timeline: MotionTimeline = { duration, shots, commands, segments, tracks };
	timelineCache.set(scene, timeline);
	return timeline;
}

/** The shot playing at `time` (the last one at the end). */
export function motionShotAt(timeline: MotionTimeline, time: number): MotionShotTiming | undefined {
	return timeline.shots.find((s) => time < s.end) ?? timeline.shots[timeline.shots.length - 1];
}
