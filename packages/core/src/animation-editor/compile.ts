import { mixColorsOklab } from '../animation/color.js';
import { matchMotionNodes } from './match.js';
import { smoothMotionLegs, smoothMotionTimes } from './smooth.js';
import { motionCommandSlots } from './text.js';
import { behaviorProgress, motionSeedFromId, type MotionBehavior } from '../animation/behavior.js';
import { evaluateEasing, resolveEasing, springSettleMs, type AnimationEasing } from '../animation/easing.js';
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
	MOTION_CLIP_TARGET,
	motionCameraFramed,
	type MotionBeatGrid,
	type MotionCamera,
	type MotionCommand,
	type MotionCue,
	type MotionDirection,
	type MotionDriver,
	type MotionDrivenProperty,
	type MotionDrawOrder,
	type MotionIrisShape,
	type MotionRect,
	type MotionSplitOrientation,
	type MotionScene,
	type MotionShot
} from './types.js';
import { cameraMoveParts } from '../effects/helpers.js';

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
 * the view box `[x, y, width, height]`. `clipRect` (`[x, y, width, height]`) and `clipCircle`
 * (`[cx, cy, r]`) are the reveal clips of `wipe`, `iris` and `split`, in the units of the
 * node's own box (0–1 across it, SVG's `objectBoundingBox`), as Flair's clip reveals are.
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
	| 'clipRect'
	| 'clipCircle'
	| 'camera'
	| `effect:${string}:${string}`;

export type MotionValue = number | string | readonly number[];

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
	/**
	 * How the change gets from `from` to `to` when not straight along its ease (a pulse there and
	 * back, a settling oscillation, a wriggle): Flair's `behavior`, exported as is.
	 */
	behavior?: MotionBehavior;
	/**
	 * Which number of the node's exported value this is (x 0, y 1, rotation 2, matching the
	 * transform Flair is given), so a wriggle wanders each on the channel Flair uses. Default 0.
	 */
	index?: number;
	/** Played backwards in time (a mirrored repeat): progress runs 1 → 0 through the ease. */
	reverse?: boolean;
	/** Stepped time: progress holds on a grid of this many frames per second from the start. */
	steps?: number;
	/** Numbers change by a steady factor (`from·(to/from)^u`); a camera zooms at a steady rate. */
	geometric?: boolean;
	/**
	 * `add`: the segment is a layer over the node's pose rather than a change to it. It lives on
	 * its own track (`motionAddTrackKey`), runs from 0 (offsets, turns) or 1 (scales), and what
	 * it adds stays once it ends, on top of whatever the pose does.
	 */
	blend?: 'add';
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
	/** The time the shot is cued to start (`at`), when it has a cue that resolves. */
	cue?: number;
	/** How late the shot starts after its cue (ms), when the shot before ran past it. */
	missedBy?: number;
	/** The provider camera move it gets in with (`camera.in`), and when it plays (`start` to `commandsStart`). */
	cameraIn?: string;
	/** The provider camera move it plays while it holds (`camera.during`), from `commandsEnd` to `end`. */
	cameraDuring?: string;
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
	/** The scene's drivers (properties that follow other properties). */
	drivers?: readonly MotionDriver[];
	/** Rest opacity per node, for drivers that read opacity. */
	restOpacity?: ReadonlyMap<string, number>;
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
	/** Bounds at rest in its parent's space (what a reveal clip's box is). */
	box: VectorBounds | null;
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
			if (!out.has(node.id)) out.set(node.id, { node, ancestors, parentWorld, center, bounds, box: local });
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

/** How far a stroke reaches past the outline: half its width (all of it outside, none inside). */
function strokeReach(node: VectorNode): number {
	let reach = 0;
	for (const p of node.type === 'path' ? [node] : collectPathNodes(node)) {
		if (p.stroke == null || p.stroke === 'none') continue;
		const width = p.strokeWidth ?? 1;
		reach = Math.max(reach, p.strokeAlign === 'outside' ? width : p.strokeAlign === 'inside' ? 0 : width / 2);
	}
	return reach;
}

/**
 * How far past its box (as a share of its width and height) a reveal clip reaches, so it shows
 * the whole stroke: the stroke's reach over the box plus 0.02, at most 1 (Flair's padding). Null
 * when the box has no width or height (a lone straight line), which a clip cannot reveal.
 */
export function motionRevealPadding(entry: MotionNodeEntry): readonly [number, number] | null {
	const box = entry.box;
	if (!box || !(box.width > 0) || !(box.height > 0)) return null;
	const s = strokeReach(entry.node);
	return [Math.min(1, s / box.width + 0.02), Math.min(1, s / box.height + 0.02)];
}

/** Clip numbers as Flair writes them (4 decimals). */
const clipRound = (n: number) => Math.round(n * 1e4) / 1e4 || 0;

/** A reveal clip that shows the whole node (padded past its box), in its box's units. */
function revealFull(property: 'clipRect' | 'clipCircle', [px, py]: readonly [number, number]): number[] {
	return (property === 'clipRect' ? [-px, -py, 1 + 2 * px, 1 + 2 * py] : [0.5, 0.5, Math.hypot(0.5 + px, 0.5 + py)]).map(clipRound);
}

const OPPOSITE: Record<MotionDirection, MotionDirection> = { up: 'down', down: 'up', left: 'right', right: 'left' };

/** What a reveal clip animates: a wipe (in, or out with `hide`), an iris or a split. */
export type MotionReveal = { style: 'wipe'; direction?: MotionDirection; hide?: boolean } | { style: 'iris'; shape?: MotionIrisShape } | { style: 'split'; orientation?: MotionSplitOrientation };

/**
 * The reveal clip a `wipe`, `iris` or `split` animates, from and to (Flair's `entrance.wipe`,
 * `entrance.iris`, `entrance.split` and `exit.wipe`), or null when the node's box has no width
 * or height. An exit wipe is the enter wipe the other way, reversed in time.
 */
export function motionRevealClip(entry: MotionNodeEntry, reveal: MotionReveal): { property: 'clipRect' | 'clipCircle'; from: number[]; to: number[] } | null {
	const pad = motionRevealPadding(entry);
	if (!pad) return null;
	const [px, py] = pad;
	const [w, h] = [1 + 2 * px, 1 + 2 * py];
	const rect = (from: number[], to: number[]) => ({ property: 'clipRect' as const, from: from.map(clipRound), to: to.map(clipRound) });
	if (reveal.style === 'iris') {
		if (reveal.shape === 'box') return rect([0.5, 0.5, 0, 0], [-px, -py, w, h]);
		return { property: 'clipCircle', from: [0.5, 0.5, 0], to: revealFull('clipCircle', pad) };
	}
	if (reveal.style === 'split') {
		if (reveal.orientation === 'vertical') return rect([0.5, -py, 0, h], [-px, -py, w, h]);
		return rect([-px, 0.5, w, 0], [-px, -py, w, h]);
	}
	const direction = reveal.direction ?? 'right';
	if (reveal.hide) {
		const shown = motionRevealClip(entry, { style: 'wipe', direction: OPPOSITE[direction] })!;
		return { ...shown, from: shown.to, to: shown.from };
	}
	switch (direction) {
		case 'right':
			return rect([-px, -py, 0, h], [-px, -py, w, h]);
		case 'left':
			return rect([1 + px, -py, 0, h], [-px, -py, w, h]);
		case 'down':
			return rect([-px, -py, w, 0], [-px, -py, w, h]);
		case 'up':
			return rect([-px, 1 + py, w, 0], [-px, -py, w, h]);
	}
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
		case 'clipRect':
		case 'clipCircle': {
			const pad = entry && motionRevealPadding(entry);
			return pad ? revealFull(property, pad) : [];
		}
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

/** Progress (0–1, unclamped by the easing) of a segment at `time`: stepped, reversed and eased as the segment says. */
export function segmentProgress(segment: MotionSegment, time: number): { u: number; eased: number } {
	const span = segment.end - segment.start;
	let elapsed = time - segment.start;
	if (segment.steps && segment.steps > 0 && elapsed < span) elapsed = (Math.floor((elapsed * segment.steps) / 1000 + 1e-9) / segment.steps) * 1000;
	const u = span <= 0 ? 1 : Math.min(1, Math.max(0, elapsed / span));
	// A reversed segment plays its forward run backwards: at u it shows what it showed at 1 − u.
	return { u, eased: evaluateEasing(segment.ease, segment.reverse ? 1 - u : u, span) };
}

/** `from` → `to` by a steady factor: numbers above 0 grow geometrically; a camera box zooms at a steady rate, its centre keeping pace. */
function geometricValue(from: MotionValue, to: MotionValue, e: number): MotionValue | undefined {
	const grow = (a: number, b: number) => (a > 0 && b > 0 ? a * (b / a) ** e : undefined);
	if (typeof from === 'number' && typeof to === 'number') return grow(from, to);
	if (Array.isArray(from) && Array.isArray(to) && from.length === 4 && to.length === 4) {
		const [x0, y0, w0, h0] = from as number[];
		const [x1, y1, w1, h1] = to as number[];
		const w = grow(w0, w1);
		const h = grow(h0, h1);
		if (w === undefined || h === undefined) return undefined;
		// The centre moves the same share of the way as the size has changed.
		const f = Math.abs(w1 - w0) > 1e-9 ? (w - w0) / (w1 - w0) : e;
		const cx = x0 + w0 / 2 + (x1 + w1 / 2 - x0 - w0 / 2) * f;
		const cy = y0 + h0 / 2 + (y1 + h1 / 2 - y0 - h0 / 2) * f;
		return [cx - w / 2, cy - h / 2, w, h];
	}
	return undefined;
}

/**
 * A segment's value at `time`: along its ease, through its behaviour when it has one. `raw`
 * ignores the behaviour (the value it swings towards), as Flair is given it.
 */
export function segmentValue(segment: MotionSegment, time: number, raw = false): MotionValue {
	const { eased } = segmentProgress(segment, time);
	if (segment.geometric && !segment.behavior) {
		const g = geometricValue(segment.from, segment.to, eased);
		if (g !== undefined) return g;
	}
	if (!segment.behavior || raw) return interpolateMotionValue(segment.from, segment.to, eased);
	const p = behaviorProgress(segment.behavior, eased, segment.index ?? 0, segment.end - segment.start);
	// Colours (a colour pulse) mix only between their ends; numbers swing past them.
	return typeof segment.from === 'string' ? interpolateMotionValue(segment.from, segment.to, Math.min(1, Math.max(0, p))) : interpolateMotionValue(segment.from, segment.to, p);
}

/** The segment in effect at `time` (the latest to have started), if any. */
export function activeSegment(track: readonly MotionSegment[] | undefined, time: number): MotionSegment | undefined {
	if (!track?.length) return undefined;
	let found: MotionSegment | undefined;
	for (const s of track) if (s.start <= time && (!found || s.start >= found.start)) found = s;
	return found;
}

/** A track's value at `time`, or `undefined` when nothing animates it. `raw` ignores behaviours (see `segmentValue`). */
export function trackValue(track: readonly MotionSegment[] | undefined, time: number, raw = false): MotionValue | undefined {
	if (!track?.length) return undefined;
	const s = activeSegment(track, time);
	if (s) return segmentValue(s, time, raw);
	let first = track[0];
	for (const t of track) if (t.start < first.start) first = t;
	return first.from;
}

export const motionTrackKey = (node: string, property: MotionProperty) => `${node}\u0000${property}`;

/** The track of a node property's additive layers (segments with `blend: 'add'`). */
export const motionAddTrackKey = (node: string, property: MotionProperty) => `${node}\u0000${property}\u0000add`;

/** Properties that take additive layers: offsets and turns add, scales multiply. */
export const MOTION_ADDITIVE_PROPERTIES: readonly MotionProperty[] = ['x', 'y', 'rotation', 'scaleX', 'scaleY'];

/**
 * A property's value with its additive layers on top of `base` (its pose): every layer that has
 * started adds its value (offsets, turns) or multiplies by it (scales). `raw` ignores behaviours.
 */
export function withMotionLayers(timeline: Pick<MotionTimeline, 'tracks'>, node: string, property: MotionProperty, base: number, time: number, raw = false): number {
	const layers = timeline.tracks.get(motionAddTrackKey(node, property));
	if (!layers) return base;
	const scale = property === 'scaleX' || property === 'scaleY';
	let v = base;
	for (const layer of layers) {
		if (layer.start > time) continue;
		const x = Number(segmentValue(layer, time, raw));
		if (Number.isFinite(x)) v = scale ? v * x : v + x;
	}
	return v;
}

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

/** How much a shot's `speed` stretches its time (1 / speed; 1 when unset or not above 0). */
export function motionShotTimeScale(shot: MotionShot): number {
	return typeof shot.speed === 'number' && shot.speed > 0 && Number.isFinite(shot.speed) ? 1 / shot.speed : 1;
}

// Beat grid adapted from soundcraft-main/crates/time/src/{tempo,grid}.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors).
/** When beat `beat` falls on a grid, ms: `offset + beat · 60000 / bpm`. */
export function motionBeatTime(grid: MotionBeatGrid, beat: number): number {
	return (grid.offset ?? 0) + (beat * 60000) / grid.bpm;
}

/** The beat (fractional) at `ms` on a grid, and its bar and beat in the bar (both from 1). */
export function motionBeatAt(grid: MotionBeatGrid, ms: number): { beat: number; bar: number; beatInBar: number } {
	const beat = ((ms - (grid.offset ?? 0)) * grid.bpm) / 60000;
	const meter = Math.max(1, Math.round(grid.meter ?? 4));
	const whole = Math.floor(beat + 1e-9);
	return { beat, bar: Math.floor(whole / meter) + 1, beatInBar: (((whole % meter) + meter) % meter) + 1 };
}

/** The time a cue names, ms, or undefined when it names a beat with no grid or a word the narration lacks. */
export function motionCueTime(scene: Pick<MotionScene, 'beat' | 'narration'>, cue: MotionCue): number | undefined {
	if (typeof cue.ms === 'number') return Math.max(0, cue.ms);
	if (typeof cue.beat === 'number') return scene.beat && scene.beat.bpm > 0 ? Math.max(0, motionBeatTime(scene.beat, cue.beat)) : undefined;
	if (typeof cue.word === 'number') return scene.narration?.words[cue.word]?.start;
	return undefined;
}

const SCALE_LIKE = new Set<MotionProperty>(['scaleX', 'scaleY', 'opacity']);

/**
 * A node property's value at `time` with its commands, additive layers and drivers: offsets and
 * turns from 0, scales from 1, opacity from the node's own. `raw` ignores behaviours.
 */
export function motionPropertyValue(timeline: MotionTimeline, node: string, property: MotionDrivenProperty, time: number, raw = false, depth = 0): number {
	const rest = property === 'opacity' ? (timeline.restOpacity?.get(node) ?? 1) : SCALE_LIKE.has(property) ? 1 : 0;
	const v = trackValue(timeline.tracks.get(motionTrackKey(node, property)), time, raw);
	const base = property === 'opacity' ? (typeof v === 'number' ? v : rest) : withMotionLayers(timeline, node, property, typeof v === 'number' ? v : rest, time, raw);
	return applyMotionDrivers(timeline, node, property, base, time, raw, depth);
}

/** `value` with the drivers of `node`'s `property` applied (a no-op without drivers). Chains of drivers are followed up to 8 deep; `check` reports cycles. */
export function applyMotionDrivers(timeline: MotionTimeline, node: string, property: MotionDrivenProperty, value: number, time: number, raw = false, depth = 0): number {
	if (!timeline.drivers || depth > 8) return value;
	let v = value;
	for (const d of timeline.drivers) {
		if (d.target !== node || d.property !== property) continue;
		const src = motionPropertyValue(timeline, d.source.node, d.source.property, time, raw, depth + 1);
		const srcRest = d.source.property === 'opacity' ? (timeline.restOpacity?.get(d.source.node) ?? 1) : SCALE_LIKE.has(d.source.property) ? 1 : 0;
		let change = (src - srcRest) * (d.factor ?? 1) + (d.offset ?? 0);
		if (d.clamp) change = Math.min(d.clamp[1], Math.max(d.clamp[0], change));
		v = SCALE_LIKE.has(property) ? v * (1 + change) : v + change;
	}
	return property === 'opacity' ? Math.min(1, Math.max(0, v)) : v;
}

/** Nodes driven by a driver (directly). */
export function motionDrivenNodes(timeline: MotionTimeline): Set<string> {
	return new Set((timeline.drivers ?? []).map((d) => d.target));
}

/**
 * The segments a node's drivers depend on (its sources', followed down chains), for exporters that
 * must sample a driven property wherever its sources change.
 */
export function motionDriverSources(timeline: MotionTimeline, node: string, properties: readonly MotionDrivenProperty[], seen = new Set<string>()): MotionSegment[] {
	const out: MotionSegment[] = [];
	for (const d of timeline.drivers ?? []) {
		if (d.target !== node || !properties.includes(d.property)) continue;
		const key = `${d.source.node}\u0000${d.source.property}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(...(timeline.tracks.get(motionTrackKey(d.source.node, d.source.property)) ?? []), ...(timeline.tracks.get(`${motionTrackKey(d.source.node, d.source.property)}\u0000add`) ?? []));
		out.push(...motionDriverSources(timeline, d.source.node, [d.source.property], seen));
	}
	return out;
}

/** How many times a command plays (1 for `enter`, `exit` and `wait`, which do not repeat). */
export function motionCommandRepeat(command: MotionCommand): number {
	if (command.type === 'wait' || command.type === 'enter' || command.type === 'exit') return 1;
	const n = command.repeat ?? 1;
	return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** How long one target of a command takes (ms), every repeat included. */
export function motionCommandDuration(command: MotionCommand, scene: MotionScene, target?: string): number {
	return motionCycleDuration(command, scene, target) * motionCommandRepeat(command);
}

/** One command of a clip played on a target: when it starts (ms from the play's start), its target and one cycle's length. */
export interface MotionClipItem {
	command: Exclude<MotionCommand, { type: 'wait' }>;
	target: string;
	start: number;
	cycle: number;
}

/** A clip's commands for `target` (`"$"` replaced), timed as in a shot from 0 at `speed`; unknown clips give nothing. */
export function motionClipLayout(scene: MotionScene, clip: string, target: string, speed = 1): { items: MotionClipItem[]; length: number } {
	const run = scene.clips?.[clip]?.run;
	if (!run) return { items: [], length: 0 };
	const f = speed > 0 && Number.isFinite(speed) ? 1 / speed : 1;
	const items: MotionClipItem[] = [];
	let runEnd = 0;
	let prevStart = 0;
	run.forEach((raw, i) => {
		const base = raw.with === 'previous' && i > 0 ? prevStart : runEnd;
		if (raw.type === 'wait') {
			prevStart = base;
			runEnd = Math.max(runEnd, base + raw.duration * f);
			return;
		}
		if (raw.type === 'play') return;
		const command = { ...raw, targets: raw.targets.map((t) => (t === MOTION_CLIP_TARGET ? target : t)) } as Exclude<MotionCommand, { type: 'wait' }>;
		const begin = base + (command.delay ?? 0) * f;
		let end = begin;
		command.targets.forEach((t, k) => {
			const cycle = motionCycleDuration(command, scene, t) * f;
			const s = begin + k * (command.stagger ?? 0) * f;
			items.push({ command, target: t, start: s, cycle });
			end = Math.max(end, s + cycle * motionCommandRepeat(command));
		});
		prevStart = begin;
		runEnd = Math.max(runEnd, end);
	});
	return { items, length: runEnd };
}

/** How long one cycle of a command takes for one target (ms): its `duration`, a spring's settle time, the line's length for a draw, or the type's default. */
export function motionCycleDuration(command: MotionCommand, scene: MotionScene, target?: string): number {
	if (command.type === 'wait') return command.duration;
	if (command.type === 'play') return motionClipLayout(scene, command.clip, target ?? MOTION_CLIP_TARGET, command.speed).length;
	if (command.duration !== undefined) return command.duration;
	if (command.ease !== undefined) {
		const ease = resolveEasing(command.ease);
		if (ease !== 'hold' && ease.type === 'spring') return springSettleMs(ease);
	}
	if (command.type === 'draw' || (command.type === 'enter' && command.style === 'draw') || (command.type === 'exit' && command.style === 'undraw')) {
		const entry = target ? indexMotionNodes(scene.artwork.nodes).get(target) : undefined;
		const length = entry ? motionPathLength(entry.node) : 0;
		const ms = length * MOTION_DRAW_MS_PER_UNIT;
		return Math.round(Math.min(MOTION_DRAW_RANGE[1], Math.max(MOTION_DRAW_RANGE[0], ms)));
	}
	// A move through waypoints takes longer the more stretches it has.
	if (command.type === 'move' && command.via?.length) return MOTION_DEFAULT_DURATIONS.move + 400 * command.via.length;
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
	const cameraMoves: { shot: string; start: number; end: number; to: MotionRect | null; ease: AnimationEasing; geometric: boolean }[] = [];
	let t = 0;
	scene.shots.forEach((shot, index) => {
		// A cue holds the shot before until it comes (or, for the first shot, waits from 0).
		const cue = shot.at ? motionCueTime(scene, shot.at) : undefined;
		if (cue !== undefined && cue > t) {
			if (shots.length) shots[shots.length - 1].end = cue;
			t = cue;
		}
		const missedBy = cue !== undefined && t - cue > 0.5 ? t - cue : undefined;
		const start = t;
		let cursor = start;
		// A shot's speed scales all of its time: camera move, delays, durations, staggers and hold.
		const f = motionShotTimeScale(shot);
		const moveIn = shot.camera ? cameraMoveParts(shot.camera.in) : undefined;
		const moveDuring = shot.camera ? cameraMoveParts(shot.camera.during) : undefined;
		let playsIn = false;
		if (shot.camera) {
			// A camera with no framing keeps the one it has (it names only a move).
			const framed = motionCameraFramed(shot.camera);
			const rect = framed ? resolveMotionCamera(shot.camera, scene) : null;
			if ((rect && rect.width > 0 && rect.height > 0) || (!framed && moveIn)) {
				// The first shot cuts to its framing: there is no framing before it to move from.
				const ms = index === 0 ? 0 : (moveIn?.ms ?? shot.camera.ms ?? MOTION_CAMERA_MS) * f;
				cameraMoves.push({ shot: shot.id, start, end: start + ms, to: rect, ease: shot.camera.ease ?? MOTION_EASE_IN_OUT, geometric: shot.camera.geometric === true });
				cursor = start + ms;
				playsIn = !!moveIn && index > 0;
			}
		}
		const commandsStart = cursor;
		let runEnd = cursor;
		let prevStart = cursor;
		shot.run.forEach((command, i) => {
			const base = command.with === 'previous' && i > 0 ? prevStart : runEnd;
			const begin = base + (command.type === 'wait' ? 0 : (command.delay ?? 0) * f);
			// What it animates, each in a stagger slot (with `split`, the letters of outlined text by letter, word or line).
			const split = command.type === 'wait' ? null : motionCommandSlots(nodes, command);
			const slots = split?.slots ?? [];
			const durations = command.type === 'wait' ? [command.duration * f] : slots.map((s) => motionCommandDuration(command, scene, s.id) * f);
			const stagger = (split?.stagger ?? 0) * f;
			const end = durations.reduce((m, d, k) => Math.max(m, begin + (slots[k]?.slot ?? k) * stagger + d), begin);
			commands.push({ shot: shot.id, shotIndex: index, command: i, type: command.type, start: begin, end, duration: durations[0] ?? 0 });
			prevStart = begin;
			runEnd = Math.max(runEnd, end);
		});
		const end = runEnd + (shot.hold ?? MOTION_DEFAULT_HOLD) * f;
		shots.push({
			id: shot.id,
			index,
			...(shot.label ? { label: shot.label } : {}),
			start,
			commandsStart,
			commandsEnd: runEnd,
			end,
			...(cue !== undefined ? { cue } : {}),
			...(missedBy !== undefined ? { missedBy } : {}),
			...(playsIn ? { cameraIn: moveIn!.move } : {}),
			...(moveDuring ? { cameraDuring: moveDuring.move } : {})
		});
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
		const key = segment.blend === 'add' ? motionAddTrackKey(segment.node, segment.property) : motionTrackKey(segment.node, segment.property);
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
			run: () => {
				const from = valueAt('', 'camera', move.start);
				const to = move.to ? [move.to.x, move.to.y, move.to.width, move.to.height] : from;
				push({ node: '', property: 'camera', start: move.start, end: move.end, from, to, ease: move.ease, shot: move.shot, command: -1, ...(move.geometric ? { geometric: true } : {}) });
			}
		});
	}
	for (const timing of commands) {
		const shot = scene.shots[timing.shotIndex];
		const command = shot.run[timing.command];
		if (command.type === 'wait') continue;
		if (command.type === 'play') {
			// A clip: each of its commands becomes its own job, at its time in the clip.
			const f = motionShotTimeScale(shot);
			command.targets.forEach((target, k) => {
				if (!nodes.has(target)) return;
				const at = timing.start + k * (command.stagger ?? 0) * f;
				for (const item of motionClipLayout(scene, command.clip, target, (command.speed ?? 1) / f).items) {
					const entry = nodes.get(item.target);
					if (!entry) continue;
					jobs.push({ start: at + item.start, order: order++, run: () => compileRepeated(item.command, item.target, entry, at + item.start, item.cycle, timing) });
				}
			});
			continue;
		}
		const split = motionCommandSlots(nodes, command);
		for (const { id: target, slot } of split.slots) {
			const entry = nodes.get(target);
			if (!entry) continue;
			const f = motionShotTimeScale(shot);
			const start = timing.start + slot * split.stagger * f;
			const cycle = motionCycleDuration(command, scene, target) * f;
			jobs.push({ start, order: order++, run: () => compileRepeated(command, target, entry, start, cycle, timing) });
		}
	}
	jobs.sort((a, b) => a.start - b.start || a.order - b.order).forEach((job) => job.run());

	/**
	 * Compiles one cycle, then lays further cycles after it: `loop` restarts each from the first
	 * cycle's start, `mirror` plays every other one backwards, `offset` carries numbers on from
	 * where the last ended. Stepped time goes on every segment the command makes.
	 */
	function compileRepeated(command: Exclude<MotionCommand, { type: 'wait' }>, node: string, entry: MotionNodeEntry, start: number, cycle: number, timing: MotionCommandTiming) {
		const first = segments.length;
		compileCommand(command, node, entry, start, cycle, timing);
		const made = segments.slice(first);
		const steps = command.steps ?? scene.steps;
		if (steps && steps > 0) for (const s of made) s.steps = steps;
		const n = motionCommandRepeat(command);
		const mode = command.repeatMode ?? 'loop';
		const shift = (v: MotionValue, by: MotionValue, k: number): MotionValue => {
			if (typeof v === 'number' && typeof by === 'number') return v + by * k;
			if (Array.isArray(v) && Array.isArray(by) && v.length === by.length) return v.map((x, i) => x + (by[i] as number) * k);
			return v;
		};
		for (let k = 1; k < n; k++) {
			const at = start + k * cycle;
			for (const s of made) {
				if (mode === 'mirror' && k % 2 === 1) {
					push({ ...s, start: at + (start + cycle - s.end), end: at + (start + cycle - s.start), reverse: !s.reverse });
					continue;
				}
				const delta: MotionValue = typeof s.from === 'number' && typeof s.to === 'number' ? s.to - s.from : Array.isArray(s.from) && Array.isArray(s.to) && s.from.length === s.to.length ? s.to.map((x, i) => (x as number) - (s.from as number[])[i]) : 0;
				const by = mode === 'offset' ? delta : 0;
				push({ ...s, start: at + (s.start - start), end: at + (s.end - start), from: shift(s.from, by, k), to: shift(s.to, by, k) });
			}
		}
	}

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
		/**
		 * When each stroke of the target draws, for an order other than all at once over the whole
		 * time (null then): one after another by length, or all at one speed.
		 */
		const drawWindows = (s: number, e: number, o: MotionDrawOrder): { id: string; start: number; end: number }[] | null => {
			const order = o.order ?? 'together';
			const pace = o.pace ?? 'time';
			if (order === 'together' && pace === 'time') return null;
			const paths = entry.node.type === 'path' ? [entry.node] : collectPathNodes(entry.node);
			let list = paths.map((p) => {
				const at = nodes.get(p.id);
				let first = { x: 0, y: 0 };
				try {
					const m = vectorPathWorldBezier(p, at?.parentWorld ?? IDENTITY_MATRIX, { effects: false })[0];
					if (m && m.type === 'M') first = { x: m.x, y: m.y };
				} catch {
					/* unmeasurable: sorts first */
				}
				return { id: p.id, len: Math.max(1e-6, motionPathLength(p, at?.parentWorld)), first };
			});
			if (!list.length) return null;
			const span = Math.max(0, e - s);
			if (order === 'sequence') {
				if (o.sortBy === 'distance') {
					const b = entry.bounds;
					const origin = o.origin ?? (b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : { x: 0, y: 0 });
					list = [...list].sort((a, c) => Math.hypot(a.first.x - origin.x, a.first.y - origin.y) - Math.hypot(c.first.x - origin.x, c.first.y - origin.y));
				}
				const total = list.reduce((sum, p) => sum + p.len, 0);
				let at = s;
				return list.map((p) => {
					const w = { id: p.id, start: at, end: at + (span * p.len) / total };
					at = w.end;
					return w;
				});
			}
			const longest = Math.max(...list.map((p) => p.len));
			return list.map((p) => {
				const d = (span * p.len) / longest;
				return o.align === 'end' ? { id: p.id, start: e - d, end: e } : { id: p.id, start: s, end: s + d };
			});
		};
		switch (command.type) {
			case 'enter': {
				const style = command.style ?? 'fade';
				const opacity = rest('opacity');
				const reveal =
					style === 'wipe' ? motionRevealClip(entry, { style, direction: command.direction }) : style === 'iris' ? motionRevealClip(entry, { style, shape: command.shape }) : style === 'split' ? motionRevealClip(entry, { style, orientation: command.orientation }) : null;
				// An earlier reveal or wipe out leaves its clip; entering opens it again, at once.
				for (const p of ['clipRect', 'clipCircle'] as const) if (p !== reveal?.property && tracks.has(motionTrackKey(node, p))) seg(p, rest(p), 'linear', start, start);
				if (reveal) {
					// The clip reveals. Opacity is set at once too, so a node faded out before shows again,
					// and a later fade in (whose start would hold back to time 0) leaves this one alone.
					seg('opacity', opacity, 'linear', start, start);
					seg(reveal.property, reveal.to, ease ?? MOTION_EASE_OUT, start, end, { from: reveal.from });
					break;
				}
				if (style === 'draw') {
					const windows = drawWindows(start, start + duration * 0.75, command);
					if (windows) for (const w of windows) push({ node: w.id, property: 'drawEnd', start: w.start, end: w.end, from: 0, to: 1, ease: ease ?? MOTION_EASE_IN_OUT, ...where });
					else seg('drawEnd', 1, ease ?? MOTION_EASE_IN_OUT, start, start + duration * 0.75, { from: 0 });
					seg('fillOpacity', 1, MOTION_EASE_OUT, start + duration * 0.6, end, { from: 0 });
					break;
				}
				if (style === 'pop' || style === 'zoom') {
					const from = command.scale ?? (style === 'pop' ? 0.5 : 1.6);
					seg('opacity', opacity, MOTION_EASE_OUT, start, start + duration * (style === 'pop' ? 0.4 : 0.5), { from: 0 });
					seg('scaleX', 1, ease ?? (style === 'pop' ? 'ease-out-back' : MOTION_EASE_OUT), start, end, { from });
					seg('scaleY', 1, ease ?? (style === 'pop' ? 'ease-out-back' : MOTION_EASE_OUT), start, end, { from });
				} else if (style === 'rise') {
					const y = num('y');
					seg('opacity', opacity, MOTION_EASE_OUT, start, start + duration * 0.5, { from: 0 });
					seg('y', y, ease ?? 'ease-out-back', start, end, { from: y + (command.distance ?? 20) });
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
				} else seg('opacity', opacity, ease ?? MOTION_EASE_OUT, start, end, { from: 0 }); // fade, and a reveal of a node with no box
				break;
			}
			case 'exit': {
				const style = command.style ?? 'fade';
				const wipe = style === 'wipe' ? motionRevealClip(entry, { style, direction: command.direction, hide: true }) : null;
				if (wipe) seg(wipe.property, wipe.to, ease ?? 'ease-in', start, end, { from: wipe.from });
				else if (style === 'undraw') {
					seg('fillOpacity', 0, 'ease-in', start, start + duration * 0.4);
					const windows = drawWindows(start, end, command);
					if (windows) for (const w of windows) push({ node: w.id, property: 'drawEnd', start: w.start, end: w.end, from: valueAt(w.id, 'drawEnd', w.start), to: 0, ease: ease ?? MOTION_EASE_IN_OUT, ...where });
					else seg('drawEnd', 0, ease ?? MOTION_EASE_IN_OUT);
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
				} else seg('opacity', 0, ease ?? 'ease-in'); // fade, and a wipe of a node with no box
				break;
			}
			case 'draw': {
				// A stroke not drawn before draws on from nothing (and is hidden until then).
				const e = ease ?? MOTION_EASE_IN_OUT;
				const comet = command.comet !== undefined ? Math.min(1, Math.max(0, command.comet)) : undefined;
				const windows = drawWindows(start, end, command) ?? [{ id: node, start, end }];
				for (const w of windows) {
					if (comet !== undefined) {
						// A travelling stroke: the head runs 0 → 1 + comet and the tail comet behind it, both clamped, so it leaves the path empty.
						push({ node: w.id, property: 'drawEnd', start: w.start, end: w.end, from: 0, to: 1 + comet, ease: e, ...where });
						push({ node: w.id, property: 'drawStart', start: w.start, end: w.end, from: -comet, to: 1, ease: e, ...where });
						continue;
					}
					const drawn = tracks.has(motionTrackKey(w.id, 'drawEnd'));
					push({ node: w.id, property: 'drawEnd', start: w.start, end: w.end, from: command.from ?? (drawn ? valueAt(w.id, 'drawEnd', w.start) : 0), to: command.to ?? 1, ease: e, ...where });
				}
				break;
			}
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
				if (command.via?.length) {
					// Through waypoints: offsets per axis as monotone cubics, one eased leg per stretch.
					const inv = invertMatrix(entry.parentWorld);
					const x0 = num('x');
					const y0 = num('y');
					const add = command.blend === 'add';
					const offsets = [{ x: 0, y: 0 }, ...command.via.map((p) => applyMatrix(inv, p)).map((p) => ({ x: p.x - entry.center.x - x0, y: p.y - entry.center.y - y0 })), { x: dx, y: dy }];
					const times = command.times?.length === command.via.length ? [start, ...command.times.map((f) => start + f * (end - start)), end] : smoothMotionTimes(offsets, start, end - start, command.pacing ?? 'even');
					for (const axis of ['x', 'y'] as const) {
						const base = add ? 0 : axis === 'x' ? x0 : y0;
						for (const leg of smoothMotionLegs(times, offsets.map((o) => o[axis])))
							seg(axis, base + leg.to, leg.ease, leg.start, leg.end, { from: base + leg.from, ...(add ? { blend: 'add' as const } : {}) });
					}
					break;
				}
				if (command.blend === 'add') {
					seg('x', dx, e, start, end, { from: 0, blend: 'add' });
					seg('y', dy, e, start, end, { from: 0, blend: 'add' });
				} else {
					seg('x', num('x') + dx, e);
					seg('y', num('y') + dy, e);
				}
				break;
			}
			case 'rotate': {
				const e = ease ?? MOTION_EASE_IN_OUT;
				if (command.blend === 'add') seg('rotation', command.to !== undefined ? command.to - num('rotation') : (command.by ?? 0), e, start, end, { from: 0, blend: 'add' });
				else seg('rotation', command.to ?? num('rotation') + (command.by ?? 0), e);
				break;
			}
			case 'scale': {
				const to = typeof command.to === 'number' ? { x: command.to, y: command.to } : command.to;
				const extra = { ...(command.geometric ? { geometric: true } : {}), ...(command.blend === 'add' ? { from: 1, blend: 'add' as const } : {}) };
				seg('scaleX', to.x, ease ?? MOTION_EASE_IN_OUT, start, end, extra);
				seg('scaleY', to.y, ease ?? MOTION_EASE_IN_OUT, start, end, extra);
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
			case 'match': {
				// Smart Animate: each part morphs into its partner in `into`; parts with no partner fade out.
				const into = nodes.get(command.into);
				if (!into || command.into === node) break;
				const match = matchMotionNodes(entry.node, into.node);
				const e = ease ?? MOTION_EASE_IN_OUT;
				for (const [a, b] of match.pairs) push({ node: a, property: 'shape', start, end, from: valueAt(a, 'shape', start), to: b, ease: e, ...where });
				for (const a of match.unpairedFrom) push({ node: a, property: 'opacity', start, end, from: valueAt(a, 'opacity', start), to: 0, ease: e, ...where });
				break;
			}
			case 'follow':
				seg('follow', command.to ?? 1, ease ?? MOTION_EASE_IN_OUT, start, end, { from: command.from ?? 0, path: command.path, rotate: command.rotate ?? false });
				break;
			// Emphasis: a change toward a peak that a behaviour swings round (as Flair's primitives do).
			case 'pulse':
			case 'shake':
			case 'teeter':
			case 'wave':
			case 'wiggle': {
				// Emphasis is a layer over the pose by default (blend "add"), so it rides on a move or turn under way.
				const add = (command.blend ?? 'add') === 'add';
				// A change of `by` (offsets, turns) or by a factor (scales), as a layer or on the pose.
				const swing = (p: MotionProperty, by: number, extra: Partial<MotionSegment>) => {
					const scale = p === 'scaleX' || p === 'scaleY';
					if (add) seg(p, by, ease ?? 'linear', start, end, { from: scale ? 1 : 0, blend: 'add', ...extra });
					else seg(p, scale ? num(p) * by : num(p) + by, ease ?? 'linear', start, end, extra);
				};
				if (command.type === 'pulse') {
					const behavior: MotionBehavior = { type: 'pulse', count: command.count ?? 1 };
					swing('scaleX', 1 + (command.amount ?? 0.15), { behavior });
					swing('scaleY', 1 + (command.amount ?? 0.15), { behavior });
				} else if (command.type === 'shake') swing(command.axis === 'vertical' ? 'y' : 'x', command.amount ?? 8, { behavior: { type: 'oscillate', count: command.count ?? 3, decay: 1 } });
				else if (command.type === 'teeter') swing('rotation', command.angle ?? 8, { behavior: { type: 'oscillate', count: command.count ?? 3, decay: 1 } });
				else if (command.type === 'wave') swing('y', -(command.amount ?? 6), { behavior: { type: 'oscillate', count: command.count ?? 2 } });
				else {
					const behavior: MotionBehavior = { type: 'wriggle', frequency: command.frequency ?? 3, octaves: command.octaves ?? 2, seed: command.seed || motionSeedFromId(node) };
					const amount = command.amount ?? 6;
					swing('x', amount, { behavior, index: 0 });
					swing('y', amount, { behavior, index: 1 });
					if (command.rotate) swing('rotation', command.rotate, { behavior, index: 2 });
				}
				break;
			}
			case 'color-pulse':
				seg(command.paint ?? 'fill', command.color ?? '#f59e0b', ease ?? 'linear', start, end, { behavior: { type: 'pulse', count: command.count ?? 1 } });
				break;
			case 'effect':
				seg(`effect:${command.effect}:${command.param}`, command.to, ease ?? MOTION_EASE_IN_OUT);
				break;
		}
	}

	for (const track of tracks.values()) track.sort((a, b) => a.start - b.start);
	segments.sort((a, b) => a.start - b.start);
	const duration = shots.length ? shots[shots.length - 1].end : 0;
	const timeline: MotionTimeline = { duration, shots, commands, segments, tracks, ...(scene.drivers?.length ? { drivers: scene.drivers, restOpacity: new Map([...nodes].map(([id, e]) => [id, e.node.opacity ?? 1])) } : {}) };
	timelineCache.set(scene, timeline);
	return timeline;
}

/** The shot playing at `time` (the last one at the end). */
export function motionShotAt(timeline: MotionTimeline, time: number): MotionShotTiming | undefined {
	return timeline.shots.find((s) => time < s.end) ?? timeline.shots[timeline.shots.length - 1];
}
