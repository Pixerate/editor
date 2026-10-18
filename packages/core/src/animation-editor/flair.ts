import type { MotionBehavior } from '../animation/behavior.js';
import { evaluateEasing, resolveEasing, reverseCubicBezier, type AnimationEasing } from '../animation/easing.js';
import { bezierPathToSvg, transformBezierPath } from '../canvas/pathops/bezier.js';
import { normalizeTokenColor } from '../tokens/color.js';
import { expandVectorAppearance, expandVectorAppearances } from '../vector/appearance.js';
import { IDENTITY_MATRIX, collectPathNodes, invertMatrix, nodeMatrix, vectorPathWorldBezier } from '../vector/geometry.js';
import { vectorDocumentToSvg, type VectorSvgWrapper } from '../vector/svg.js';
import type { VectorNode, VectorPathNode } from '../vector/types.js';
import { compileMotionScene, indexMotionNodes, motionAddTrackKey, motionTrackKey, segmentValue, trackValue, type MotionProperty, type MotionSegment } from './compile.js';
import { motionClipAttrs, motionFollowRoute, motionFrameAt, motionNodeClips, motionNodeOffset } from './evaluate.js';
import type { MotionScene } from './types.js';

/**
 * Export to Flair (`@pixerate/flair`): a scene becomes an `SvgMotion` (one SVG plus a list of
 * from → to changes on its elements), a catalog `VectorEffect`, or an `EffectDocument` for
 * Flair's effect editor. The types are mirrored here so this package does not depend on Flair.
 *
 * Changes are exact where Flair can express them: a change with a linear, cubic-out or
 * cubic-in-out curve (the editor's defaults) is one change, and so (Flair 0.36 and later) is
 * one with any cubic-bezier curve, written as `[x1, y1, x2, y2]`. Anything else (springs,
 * elastic, `hold`, morphs and live-effect tweens) is sampled at the
 * scene's `fps` into short linear changes, which Flair plays the same way. Pulses, shakes,
 * teeters, waves, wiggles and colour pulses are one change with a `behavior` (Flair 0.38).
 *
 * Reveals (`wipe`, `iris`, `split`) wrap their node in a group clipped through a rect or circle
 * in the group's own box units (`clipPathUnits="objectBoundingBox"`), as Flair's
 * `entrance.wipe` does, and animate the shape's attributes. A follow wraps its node in a group
 * that Flair's `along` carries along a copy of the path in the node's parent's units (written
 * in `<defs>`, so the path may be hidden or anywhere), turning with it for `orient`, as
 * Flair's `path.follow` does.
 */

/** Flair's easing names. */
export type FlairEaseName = 'linear' | 'in-out' | 'out';

/** Flair's spring ease (Flair 0.39 and later): the editor's spring, number for number. */
export interface FlairSpringEase {
	spring: { mass?: number; stiffness?: number; damping?: number; velocity?: number };
}

/** A Flair easing: a name, (Flair 0.36 and later) a CSS cubic-bezier `[x1, y1, x2, y2]`, or (0.39) a spring. */
export type FlairEase = FlairEaseName | readonly [number, number, number, number] | FlairSpringEase;

/** Flair's curves, for matching. */
export const FLAIR_EASES: Readonly<Record<FlairEaseName, (t: number) => number>> = {
	linear: (t) => t,
	'in-out': (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
	out: (t) => 1 - (1 - t) ** 3
};

/** One change of a Flair `SvgMotion` (mirrors `SvgAnimation` in `@pixerate/flair/vector`). */
export interface FlairSvgAnimation {
	id?: string;
	step?: number;
	delay?: number;
	ms?: number;
	ease?: FlairEase;
	attrs?: Record<string, readonly [string | number, string | number]>;
	draw?: boolean | readonly [number, number];
	/** Moves the element along a path (by id), from and to the fractions of its length in `at`. */
	along?: string;
	at?: readonly [number, number];
	/** With `along`: turns the element with the path's direction. */
	orient?: boolean;
	/** Flair 0.38 and later: how the change swings from → to (see `MotionBehavior`). */
	behavior?: MotionBehavior;
	/** Flair 0.39 and later: stepped time, held on a grid of this many frames per second. */
	strobe?: number;
	/** Flair 0.39 and later: whole cycles to play (default 1); with `alternate`, every other one backwards. */
	repeat?: number;
	alternate?: boolean;
	/** Flair features scenes do not have (imports skip them with a note). */
	count?: readonly [number, number];
	write?: string;
	scramble?: string;
	solo?: number;
	view?: readonly [number, number, number, number] | string;
}

/** Mirrors `SvgMotion` in `@pixerate/flair/vector`. */
export interface FlairSvgMotion {
	svg: string;
	animate?: FlairSvgAnimation[];
}

/** Mirrors Flair's catalog `VectorEffect` (`@pixerate/flair/catalog`). */
export interface FlairVectorEffect {
	kind: 'vector';
	id: string;
	name: string;
	description: string;
	category: string;
	tags: string[];
	motion: FlairSvgMotion;
	/** Values are `#rrggbb` strings, or `[r, g, b]` channels from 0 to 1 (Flair's catalog writes both); imports turn them into hex. */
	presets?: { name: string; values: Record<string, string | readonly number[]> }[];
	/** Ms on the last frame before looping. */
	hold?: number;
	trigger?: 'hover' | 'press' | 'click' | 'scroll';
}

/** Mirrors Flair's `EffectDocument` (`@pixerate/flair/editor`) for a vector effect. */
export interface FlairEffectDocument {
	version: 1;
	name: string;
	effect: { kind: 'vector'; motion: FlairSvgMotion; hold?: number };
	values: Record<string, string>;
	tracks: Record<string, never>;
	duration: number;
	loop: boolean;
	presets: { name: string; values: Record<string, string> }[];
}

export interface FlairMotionExport {
	motion: FlairSvgMotion;
	/** The scene's length (ms). */
	duration: number;
	/** Ms after the last change (Flair's `hold`). */
	hold: number;
	/** Changes sampled into linear steps. */
	sampled: number;
	/** What could not be carried over, in sentences. */
	notes: string[];
}

export interface FlairExportOptions {
	/** Sampling rate for changes Flair cannot express exactly (default: the scene's `fps`, else 30). */
	fps?: number;
	/** Decimal places (default 3). */
	precision?: number;
	/**
	 * Write cubic-bezier easings (the `ease`, `ease-in`, `ease-out`, `ease-in-out`, `ease-in-back`
	 * and `ease-out-back` presets, and `{ type: 'cubic-bezier' }` curves) as one change with
	 * `ease: [x1, y1, x2, y2]` (default true). Needs Flair 0.36 or later; set false for older
	 * Flair, and they are sampled into linear steps.
	 */
	curves?: boolean;
	/**
	 * Write pulses, shakes, teeters, waves, wiggles and colour pulses as one change with a Flair
	 * `behavior` (default true), so they play exactly. Needs Flair 0.38 or later; set false for
	 * older Flair, and they are sampled into linear steps.
	 */
	behaviors?: boolean;
	/**
	 * The Flair version the export is for (default `0.39`): it decides what is written exactly
	 * and what is sampled. 0.36 adds cubic-bezier curves, 0.38 behaviours, 0.39 springs and
	 * stepped time (`strobe`). `curves` and `behaviors` override it.
	 */
	flair?: string;
}

/** The Flair version exports target by default. */
export const FLAIR_EXPORT_VERSION = '0.39';

/** Whether Flair `version` is at least `min` (dotted numbers). */
export function flairAtLeast(version: string, min: string): boolean {
	const a = version.split('.').map((n) => parseInt(n, 10) || 0);
	const b = min.split('.').map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
	return true;
}

/** The Flair easing that matches `ease` (within 1% everywhere), if any. */
export function flairEaseFor(ease: AnimationEasing): FlairEaseName | undefined {
	for (const name of ['linear', 'out', 'in-out'] as const) {
		let worst = 0;
		for (let i = 1; i < 40; i++) {
			const t = i / 40;
			worst = Math.max(worst, Math.abs(evaluateEasing(ease, t, 1000) - FLAIR_EASES[name](t)));
		}
		if (worst < 0.01) return name;
	}
	return undefined;
}

/**
 * The Flair easing for `ease`: a Flair name when one matches within 1%, else (with `curves`,
 * the default) the curve's `[x1, y1, x2, y2]` when it is a cubic-bezier. Undefined for curves
 * Flair cannot play (springs, elastic, `hold`), which are sampled.
 */
export function flairCurveFor(ease: AnimationEasing, curves = true): FlairEase | undefined {
	const name = flairEaseFor(ease);
	if (name || !curves) return name;
	const resolved = resolveEasing(ease);
	if (resolved === 'hold' || resolved.type !== 'cubic-bezier') return undefined;
	return [resolved.x1, resolved.y1, resolved.x2, resolved.y2];
}

/** Whether a curve leaves 0–1 (a back ease or a spring), so its values pass `from` or `to`. */
const overshoots = (ease: FlairEase) => typeof ease !== 'string' && ('spring' in ease || ease[1] < 0 || ease[1] > 1 || ease[3] < 0 || ease[3] > 1);

type ChannelValue = number | string | readonly number[];

interface Channel {
	id: string;
	/** `attrs`: several number attributes changing together (`attrs` names them, `value` gives them in order). */
	kind: 'attr' | 'attrs' | 'draw' | 'view';
	attr?: string;
	attrs?: readonly string[];
	segments: MotionSegment[];
	exact: (segment: MotionSegment) => boolean;
	/**
	 * Whether a value past `from` → `to` plays the same in Flair as in the editor. Transforms and
	 * the camera extrapolate; colours would leave 0–255 and opacity and draw-on are clamped here.
	 */
	overshoot?: boolean;
	value: (time: number) => ChannelValue;
	/** The value with behaviours ignored: what a behaviour swings towards (default `value`). */
	raw?: (time: number) => ChannelValue;
}

const TRANSFORM_PROPS: MotionProperty[] = ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'follow'];
const LINEAR_TRANSFORM = new Set<MotionProperty>(['x', 'y', 'rotation', 'scaleX', 'scaleY']);

function hex6(color: unknown): string {
	const hex = normalizeTokenColor(color);
	return hex ? hex.slice(0, 7) : '#000000';
}

/** A scene as a Flair `SvgMotion`. */
export function toFlairSvgMotion(scene: MotionScene, options: FlairExportOptions = {}): FlairMotionExport {
	const fps = options.fps ?? scene.fps ?? 30;
	const precision = options.precision ?? 3;
	const flair = options.flair ?? FLAIR_EXPORT_VERSION;
	const curves = options.curves ?? flairAtLeast(flair, '0.36');
	const behaviors = options.behaviors ?? flairAtLeast(flair, '0.38');
	const springs = flairAtLeast(flair, '0.39');
	const strobes = flairAtLeast(flair, '0.39');
	const writeEase = (ease: FlairEase): FlairEase => (typeof ease === 'string' || 'spring' in ease ? ease : (ease.map(round) as unknown as FlairEase));
	// The ease Flair is given for a segment: its curve (run backwards for a mirrored repeat) or its spring, if Flair can take it.
	const easeOf = (segment: MotionSegment): FlairEase | undefined => {
		const resolved = resolveEasing(segment.ease);
		if (resolved !== 'hold' && resolved.type === 'spring') {
			if (!springs || segment.reverse) return undefined;
			const { mass, stiffness, damping, velocity } = resolved;
			return { spring: { mass, stiffness, damping, velocity } };
		}
		if (!segment.reverse) return flairCurveFor(segment.ease, curves);
		const back = reverseCubicBezier(segment.ease);
		return back && curves ? flairCurveFor(back, curves) : undefined;
	};
	// A segment with a behaviour plays exactly when Flair can be given the behaviour.
	const plays = (s: MotionSegment) => (!s.behavior || behaviors) && (!s.steps || strobes) && !s.geometric;
	const round = (n: number) => Math.round(n * 10 ** precision) / 10 ** precision;
	const f = (n: number) => String(round(n));
	const timeline = compileMotionScene(scene);
	const nodes = indexMotionNodes(scene.artwork.nodes);
	const notes: string[] = [];
	const channels: Channel[] = [];
	const track = (id: string, p: MotionProperty) => timeline.tracks.get(motionTrackKey(id, p)) ?? [];

	// The outermost node (of a path and its groups) whose track sets `p` for that path.
	const owner = (path: VectorPathNode, p: MotionProperty): string | undefined => {
		const entry = nodes.get(path.id);
		if (!entry) return undefined;
		return [...entry.ancestors, path.id].find((id) => timeline.tracks.has(motionTrackKey(id, p)));
	};

	const animatedNodes = new Set(timeline.segments.map((s) => s.node).filter(Boolean));
	const pathsSeen = new Set<string>();
	// Groups written round nodes (outermost first), routes for `along`, and the ids they take.
	const wrap: Record<string, VectorSvgWrapper[]> = {};
	const routes: string[] = [];
	const follows: { id: string; wrapper: string; routes: Map<string, string>; segments: MotionSegment[] }[] = [];
	const usedIds = new Set(nodes.keys());
	const freshId = (base: string) => {
		let id = base;
		for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
		usedIds.add(id);
		return id;
	};
	for (const id of animatedNodes) {
		const entry = nodes.get(id)!;
		const node = entry.node;
		// Wrappers only go round nodes that are drawn (a hidden node is left out of the SVG).
		const drawn = [...entry.ancestors.map((a) => nodes.get(a)!.node), node].every((n) => n.visible !== false);

		// Reveal clips: a group clipped through a shape whose attributes change (outermost: it clips what the follow carries).
		for (const [p, name] of [['clipRect', 'reveal'], ['clipCircle', 'iris']] as const) {
			if (!drawn || !timeline.tracks.has(motionTrackKey(id, p))) continue;
			const wrapper = freshId(`${id}--${name}`);
			const clipId = freshId(`${wrapper}-clip`);
			const shapeId = freshId(`${wrapper}-clip-shape`);
			const clipAt = (t: number) => motionNodeClips(id, timeline, t).find((c) => c.shape === (p === 'clipRect' ? 'rect' : 'circle'))!;
			const rest = clipAt(0);
			(wrap[id] ??= []).push({ id: wrapper, clip: { id: clipId, shapeId, shape: rest.shape, attrs: motionClipAttrs(rest) } });
			channels.push({ id: shapeId, kind: 'attrs', attrs: Object.keys(motionClipAttrs(rest)), segments: [...track(id, p)], exact: () => true, value: (t) => Object.values(motionClipAttrs(clipAt(t))).map((v) => Math.round(v * 1e4) / 1e4) });
		}

		// A follow: Flair's `along` carries a wrapper, and an inner one puts the node's centre on it.
		const followSegments = track(id, 'follow');
		if (drawn && followSegments.length) {
			const ids = new Map<string, string>();
			for (const seg of followSegments) {
				if (!seg.path || ids.has(seg.path)) continue;
				const route = motionFollowRoute(entry, nodes.get(seg.path));
				if (!route) continue;
				const routeId = freshId(`${id}--follow-route`);
				ids.set(seg.path, routeId);
				routes.push(`<path id="${routeId}" d="${bezierPathToSvg(route, { precision })}" fill="none"/>`);
			}
			if (ids.size) {
				const wrapper = freshId(`${id}--follow`);
				const centre = freshId(`${id}--follow-centre`);
				const c = entry.center;
				// Where the follow puts it at the start, for players that draw a still frame without `along`.
				const at = motionNodeOffset(entry, timeline, 0, nodes)?.follow;
				const placed = at ? `translate(${f(at.x)} ${f(at.y)})${at.angle ? ` rotate(${f(at.angle)})` : ''}` : undefined;
				(wrap[id] ??= []).push({ id: wrapper, ...(placed ? { transform: placed } : {}) }, { id: centre, transform: `translate(${f(-c.x)} ${f(-c.y)})` });
				follows.push({ id, wrapper, routes: ids, segments: followSegments.filter((seg) => seg.path && ids.has(seg.path)) });
			}
		}

		if (timeline.tracks.has(motionTrackKey(id, 'opacity')))
			channels.push({ id, kind: 'attr', attr: 'opacity', segments: [...track(id, 'opacity')], exact: plays, value: (t) => round(Math.min(1, Math.max(0, Number(trackValue(track(id, 'opacity'), t))))) });

		// The node's own moves, turns and scales (a follow is carried by its wrappers).
		const followed = follows.some((x) => x.id === id);
		// Additive layers share the transform: alone in a stretch they are one change, overlapping the pose they are sampled.
		const transformSegments = TRANSFORM_PROPS.flatMap((p) => (followed && p === 'follow' ? [] : [...track(id, p), ...(timeline.tracks.get(motionAddTrackKey(id, p)) ?? [])]));
		if (transformSegments.length) {
			const base = node.transform ? ` matrix(${node.transform.map(f).join(' ')})` : '';
			const c = entry.center;
			const transformAt = (t: number, raw: boolean) => {
				const o = motionNodeOffset(entry, timeline, t, nodes, raw, !followed)!;
				return `translate(${f(o.dx)} ${f(o.dy)}) rotate(${f(o.rotation)} ${f(c.x)} ${f(c.y)}) translate(${f(c.x)} ${f(c.y)}) scale(${f(o.scaleX)} ${f(o.scaleY)}) translate(${f(-c.x)} ${f(-c.y)})${base}`;
			};
			channels.push({
				id,
				kind: 'attr',
				attr: 'transform',
				segments: transformSegments,
				exact: (s) => LINEAR_TRANSFORM.has(s.property) && plays(s),
				overshoot: true,
				// x, y and the angle are the transform's numbers 0, 1 and 2 (`MotionSegment.index`).
				value: (t) => transformAt(t, false),
				raw: (t) => transformAt(t, true)
			});
		}

		// Paint, width, fill fade and draw-on live on paths: a group's change goes to each path in it.
		const paths = node.type === 'path' ? [node] : collectPathNodes(node);
		for (const path of paths) {
			if (pathsSeen.has(path.id)) continue;
			pathsSeen.add(path.id);
			const paint = (p: 'fill' | 'stroke', attr: string) => {
				const from = owner(path, p);
				if (from) channels.push({ id: path.id, kind: 'attr', attr, segments: [...track(from, p)], exact: plays, value: (t) => hex6(trackValue(track(from, p), t)), raw: (t) => hex6(trackValue(track(from, p), t, true)) });
			};
			paint('fill', 'fill');
			paint('stroke', 'stroke');
			const width = owner(path, 'strokeWidth');
			if (width) channels.push({ id: path.id, kind: 'attr', attr: 'stroke-width', segments: [...track(width, 'strokeWidth')], exact: () => true, value: (t) => round(Number(trackValue(track(width, 'strokeWidth'), t))) });
			const fade = owner(path, 'fillOpacity');
			if (fade) channels.push({ id: path.id, kind: 'attr', attr: 'fill-opacity', segments: [...track(fade, 'fillOpacity')], exact: () => true, value: (t) => round(Number(trackValue(track(fade, 'fillOpacity'), t))) });
			const draw = owner(path, 'drawEnd');
			if (draw) channels.push({ id: path.id, kind: 'draw', segments: [...track(draw, 'drawEnd')], exact: () => true, value: (t) => round(Math.min(1, Math.max(0, Number(trackValue(track(draw, 'drawEnd'), t))))) });
			if (owner(path, 'drawStart')) notes.push(`"${path.id}": drawing from a start other than 0 is not exported; Flair draws from the start of the path.`);
		}

		// Shape changes (morphs, live effect tweens) are sampled as the path's `d`.
		const shapeSegments = [...timeline.tracks.entries()].filter(([k]) => k.startsWith(`${id}\u0000`) && (k.endsWith('\u0000shape') || k.includes('\u0000effect:'))).flatMap(([, v]) => v);
		if (shapeSegments.length) {
			if (node.type !== 'path') notes.push(`"${id}" is a group: its morph or effect animation is not exported (Flair tweens one path's "d").`);
			else {
				const inverse = invertMatrix(nodeMatrix(node));
				channels.push({
					id,
					kind: 'attr',
					attr: 'd',
					segments: shapeSegments,
					exact: () => false,
					value: (t) => {
						const frame = motionFrameAt(scene, t, { draw: false, offsets: false });
						const now = expandVectorAppearance(indexMotionNodes(frame.document.nodes).get(id)?.node as VectorNode);
						if (!now || now.type !== 'path') return '';
						const bezier = transformBezierPath(vectorPathWorldBezier(now, IDENTITY_MATRIX, { effects: false }), inverse);
						return bezierPathToSvg(bezier, { precision: Math.min(precision, 2) });
					}
				});
			}
		}
	}

	const camera = track('', 'camera');
	if (camera.length) channels.push({ id: '', kind: 'view', segments: [...camera], exact: () => true, overshoot: true, value: (t) => (trackValue(camera, t) as number[]).map(round) });

	const animate: FlairSvgAnimation[] = [];
	let sampled = 0;
	const same = (a: ChannelValue, b: ChannelValue) => JSON.stringify(a) === JSON.stringify(b);
	const emit = (channel: Channel, delay: number, ms: number, from: ChannelValue, to: ChannelValue, ease: FlairEase, segment?: MotionSegment) => {
		const written = writeEase(ease);
		const base = {
			...(channel.id ? { id: channel.id } : {}),
			...(delay > 0 ? { delay: round(delay) } : {}),
			ms: round(ms),
			ease: written,
			...(segment?.behavior ? { behavior: segment.behavior } : {}),
			...(segment?.steps ? { strobe: segment.steps } : {})
		};
		if (channel.kind === 'view') animate.push({ ...base, view: to as unknown as [number, number, number, number] });
		else if (channel.kind === 'draw') animate.push({ ...base, draw: [from as number, to as number] });
		else if (channel.kind === 'attrs') {
			// Only the numbers that change (as Flair's clip reveals write them).
			const [a, b] = [from as readonly number[], to as readonly number[]];
			const attrs = Object.fromEntries(channel.attrs!.flatMap((name, k) => (a[k] !== b[k] ? [[name, [a[k], b[k]] as const]] : [])));
			animate.push({ ...base, attrs });
		}
		else animate.push({ ...base, attrs: { [channel.attr!]: [from as string | number, to as string | number] } });
	};

	for (const channel of channels) {
		const cuts = channel.segments.filter((s) => s.end <= s.start);
		for (const cut of cuts) {
			const [from, to] = [channel.value(Math.max(0, cut.start - 1e-3)), channel.value(cut.start)];
			// A cut to where the value already is changes nothing (at 0 it sets the start, so it stays).
			if (cut.start <= 0 || !same(from, to) || channel.kind === 'view') emit(channel, cut.start, 0, from, to, 'linear');
		}
		const times = [...new Set(channel.segments.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
		for (let i = 0; i + 1 < times.length; i++) {
			const a = times[i];
			const b = times[i + 1];
			const active = channel.segments.filter((s) => s.start < b && s.end > a);
			if (!active.length) continue;
			// One change when every active segment spans exactly this interval with one exact curve (a move's x and y, say).
			const first = active[0];
			// A behaviour (pulse, shake, wriggle…) is one change toward the value it swings round, when every active segment shares it.
			const key = (x: MotionSegment) => JSON.stringify([x.ease, x.behavior, x.reverse ?? false, x.steps ?? 0]);
			const together = active.every((x) => x.start === a && x.end === b && channel.exact(x) && key(x) === key(first));
			const curve = together ? easeOf(first) : undefined;
			const ease = curve && (!overshoots(curve) || channel.overshoot) ? curve : undefined;
			if (ease) {
				const from = channel.value(a);
				const to = first.behavior ? (channel.raw ?? channel.value)(b) : channel.value(b);
				if (!same(from, to) || channel.kind === 'view') emit(channel, a, b - a, from, to, ease, first);
				continue;
			}
			const n = Math.max(1, Math.ceil(((b - a) * fps) / 1000));
			let prev = channel.value(a);
			for (let k = 1; k <= n; k++) {
				const t0 = a + ((b - a) * (k - 1)) / n;
				const t1 = a + ((b - a) * k) / n;
				const next = channel.value(t1);
				if (!same(prev, next)) {
					emit(channel, t0, t1 - t0, prev, next, 'linear');
					sampled++;
				}
				prev = next;
			}
		}
	}

	// Follows: one `along` per follow, sampled into linear steps only for curves Flair cannot play.
	for (const follow of follows) {
		const starts = follow.segments.map((seg) => seg.start);
		for (const seg of follow.segments) {
			const along = { id: follow.wrapper, along: follow.routes.get(seg.path!)!, ...(seg.rotate ? { orient: true } : {}) };
			const progress = (t: number) => round(Math.min(1, Math.max(0, Number(segmentValue(seg, t)))));
			const curve = seg.end > seg.start ? (plays(seg) ? easeOf(seg) : undefined) : 'linear';
			// Past the ends, Flair stops turning (its direction is measured either side of the point), so overshoots are sampled.
			if (curve && !(overshoots(curve) && seg.rotate)) {
				const ends = seg.reverse ? [Number(seg.to), Number(seg.from)] : [Number(seg.from), Number(seg.to)];
				animate.push({ ...along, ...(seg.start > 0 ? { delay: round(seg.start) } : {}), ms: round(seg.end - seg.start), ease: writeEase(curve), ...(seg.steps ? { strobe: seg.steps } : {}), at: [round(ends[0]), round(ends[1])] });
				continue;
			}
			// Sampled up to the next follow's start, which takes over there.
			const until = Math.min(seg.end, ...starts.filter((t) => t > seg.start));
			const n = Math.max(1, Math.ceil(((until - seg.start) * fps) / 1000));
			for (let k = 1; k <= n; k++) {
				const t0 = seg.start + ((until - seg.start) * (k - 1)) / n;
				const t1 = seg.start + ((until - seg.start) * k) / n;
				animate.push({ ...along, ...(t0 > 0 ? { delay: round(t0) } : {}), ms: round(t1 - t0), ease: 'linear', at: [progress(t0), progress(t1)] });
				sampled++;
			}
		}
	}
	animate.sort((x, y) => (x.delay ?? 0) - (y.delay ?? 0));

	// The SVG: the artwork at rest, live effects drawn as plain paths so shapes can be tweened,
	// with the wrappers that reveals and follows animate, and the routes follows take.
	let svg = vectorDocumentToSvg({ ...scene.artwork, nodes: expandVectorAppearances(scene.artwork.nodes) }, { pretty: false, precision, wrap });
	if (routes.length) svg = svg.replace(/^(<svg[^>]*>)/, `$1<defs>${routes.join('')}</defs>`);
	const lastChange = animate.reduce((m, a) => Math.max(m, (a.delay ?? 0) + (a.ms ?? 0)), 0);

	// Controls: each stands for its default colour wherever it appears.
	let motion: FlairSvgMotion = { svg, animate };
	if (scene.controls?.length) {
		const declarations = scene.controls.map((c) => `{{${c.name}: color default=${c.default.toUpperCase()}${c.label ? ` label='${c.label.replace(/'/g, '’')}'` : ''}}}`).join(' ');
		const swap = (text: string) => scene.controls!.reduce((s, c) => s.replace(new RegExp(`${c.default}(?![0-9a-fA-F])`, 'gi'), `{{${c.name}}}`), text);
		svg = svg.replace(/^(<svg[^>]*>)/, `$1<!-- ${declarations} -->`);
		const header = svg.indexOf('-->') + 3;
		svg = svg.slice(0, header) + swap(svg.slice(header));
		motion = { svg, animate: animate.map((a) => (a.attrs ? { ...a, attrs: Object.fromEntries(Object.entries(a.attrs).map(([k, [x, y]]) => [k, [typeof x === 'string' ? swap(x) : x, typeof y === 'string' ? swap(y) : y] as const])) } : a)) };
	}
	return { motion, duration: timeline.duration, hold: Math.max(0, round(timeline.duration - lastChange)), sampled, notes: [...new Set(notes)] };
}

export interface FlairEffectOptions extends FlairExportOptions {
	/** Kebab-case id (default: the scene's name). */
	id?: string;
	name?: string;
	description?: string;
	/** Flair catalog category (default `icon`). */
	category?: string;
	tags?: string[];
	trigger?: FlairVectorEffect['trigger'];
}

const kebab = (text: string) =>
	text
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
		.replace(/[^A-Za-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase() || 'animation';

/** A scene as a Flair catalog vector effect, with its colour controls and presets. */
export function toFlairVectorEffect(scene: MotionScene, options: FlairEffectOptions = {}): FlairVectorEffect {
	const out = toFlairSvgMotion(scene, options);
	return {
		kind: 'vector',
		id: options.id ?? kebab(scene.name),
		name: options.name ?? scene.name,
		description: options.description ?? scene.description ?? '',
		category: options.category ?? 'icon',
		tags: options.tags ?? [],
		motion: out.motion,
		hold: out.hold,
		...(scene.presets?.length ? { presets: scene.presets } : {}),
		...(options.trigger ? { trigger: options.trigger } : {})
	};
}

/** A scene as a document for Flair's `EffectEditor` (`replaceDocument`). */
export function toFlairEffectDocument(scene: MotionScene, options: FlairExportOptions = {}): FlairEffectDocument {
	const out = toFlairSvgMotion(scene, options);
	return {
		version: 1,
		name: scene.name,
		effect: { kind: 'vector', motion: out.motion, hold: out.hold },
		values: Object.fromEntries((scene.controls ?? []).map((c) => [c.name, c.default])),
		tracks: {},
		duration: out.duration,
		loop: (scene.loop ?? 'none') !== 'none',
		presets: scene.presets ?? []
	};
}
