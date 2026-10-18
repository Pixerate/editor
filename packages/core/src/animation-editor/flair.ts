import { evaluateEasing, resolveEasing, type AnimationEasing } from '../animation/easing.js';
import { bezierPathToSvg, transformBezierPath } from '../canvas/pathops/bezier.js';
import { normalizeTokenColor } from '../tokens/color.js';
import { expandVectorAppearance, expandVectorAppearances } from '../vector/appearance.js';
import { IDENTITY_MATRIX, collectPathNodes, invertMatrix, nodeMatrix, vectorPathWorldBezier } from '../vector/geometry.js';
import { vectorDocumentToSvg } from '../vector/svg.js';
import type { VectorNode, VectorPathNode } from '../vector/types.js';
import { compileMotionScene, indexMotionNodes, motionTrackKey, trackValue, type MotionProperty, type MotionSegment } from './compile.js';
import { motionFrameAt, motionNodeOffset } from './evaluate.js';
import type { MotionScene } from './types.js';

/**
 * Export to Flair (`@pixerate/flair`): a scene becomes an `SvgMotion` (one SVG plus a list of
 * from → to changes on its elements), a catalog `VectorEffect`, or an `EffectDocument` for
 * Flair's effect editor. The types are mirrored here so this package does not depend on Flair.
 *
 * Changes are exact where Flair can express them: a change with a linear, cubic-out or
 * cubic-in-out curve (the editor's defaults) is one change, and so (Flair 0.36 and later) is
 * one with any cubic-bezier curve, written as `[x1, y1, x2, y2]`. Anything else (springs,
 * elastic, `hold`, pulses and shakes, follows, morphs and live-effect tweens) is sampled at the
 * scene's `fps` into short linear changes, which Flair plays the same way.
 */

/** Flair's easing names. */
export type FlairEaseName = 'linear' | 'in-out' | 'out';

/** A Flair easing: a name, or (Flair 0.36 and later) a CSS cubic-bezier `[x1, y1, x2, y2]`. */
export type FlairEase = FlairEaseName | readonly [number, number, number, number];

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
	presets?: { name: string; values: Record<string, string> }[];
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

/** Whether a curve leaves 0–1 (a back ease), so its values pass `from` or `to`. */
const overshoots = (ease: FlairEase) => typeof ease !== 'string' && (ease[1] < 0 || ease[1] > 1 || ease[3] < 0 || ease[3] > 1);

type ChannelValue = number | string | readonly number[];

interface Channel {
	id: string;
	kind: 'attr' | 'draw' | 'view';
	attr?: string;
	segments: MotionSegment[];
	exact: (segment: MotionSegment) => boolean;
	/**
	 * Whether a value past `from` → `to` plays the same in Flair as in the editor. Transforms and
	 * the camera extrapolate; colours would leave 0–255 and opacity and draw-on are clamped here.
	 */
	overshoot?: boolean;
	value: (time: number) => ChannelValue;
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
	const curves = options.curves ?? true;
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
	for (const id of animatedNodes) {
		const entry = nodes.get(id)!;
		const node = entry.node;

		if (timeline.tracks.has(motionTrackKey(id, 'opacity')))
			channels.push({ id, kind: 'attr', attr: 'opacity', segments: [...track(id, 'opacity')], exact: (s) => !s.wave, value: (t) => round(Math.min(1, Math.max(0, Number(trackValue(track(id, 'opacity'), t))))) });

		const transformSegments = TRANSFORM_PROPS.flatMap((p) => track(id, p));
		if (transformSegments.length) {
			const base = node.transform ? ` matrix(${node.transform.map(f).join(' ')})` : '';
			const c = entry.center;
			channels.push({
				id,
				kind: 'attr',
				attr: 'transform',
				segments: transformSegments,
				exact: (s) => LINEAR_TRANSFORM.has(s.property) && !s.wave,
				overshoot: true,
				value: (t) => {
					const o = motionNodeOffset(entry, timeline, t, nodes)!;
					return `translate(${f(o.dx)} ${f(o.dy)}) rotate(${f(o.rotation)} ${f(c.x)} ${f(c.y)}) translate(${f(c.x)} ${f(c.y)}) scale(${f(o.scaleX)} ${f(o.scaleY)}) translate(${f(-c.x)} ${f(-c.y)})${base}`;
				}
			});
		}

		// Paint, width, fill fade and draw-on live on paths: a group's change goes to each path in it.
		const paths = node.type === 'path' ? [node] : collectPathNodes(node);
		for (const path of paths) {
			if (pathsSeen.has(path.id)) continue;
			pathsSeen.add(path.id);
			const paint = (p: 'fill' | 'stroke', attr: string) => {
				const from = owner(path, p);
				if (from) channels.push({ id: path.id, kind: 'attr', attr, segments: [...track(from, p)], exact: () => true, value: (t) => hex6(trackValue(track(from, p), t)) });
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
	const emit = (channel: Channel, delay: number, ms: number, from: ChannelValue, to: ChannelValue, ease: FlairEase) => {
		const base = { ...(channel.id ? { id: channel.id } : {}), ...(delay > 0 ? { delay: round(delay) } : {}), ms: round(ms), ease: typeof ease === 'string' ? ease : (ease.map(round) as unknown as FlairEase) };
		if (channel.kind === 'view') animate.push({ ...base, view: to as unknown as [number, number, number, number] });
		else if (channel.kind === 'draw') animate.push({ ...base, draw: [from as number, to as number] });
		else animate.push({ ...base, attrs: { [channel.attr!]: [from as string | number, to as string | number] } });
	};

	for (const channel of channels) {
		const cuts = channel.segments.filter((s) => s.end <= s.start);
		for (const cut of cuts) emit(channel, cut.start, 0, channel.value(Math.max(0, cut.start - 1e-3)), channel.value(cut.start), 'linear');
		const times = [...new Set(channel.segments.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
		for (let i = 0; i + 1 < times.length; i++) {
			const a = times[i];
			const b = times[i + 1];
			const active = channel.segments.filter((s) => s.start < b && s.end > a);
			if (!active.length) continue;
			// One change when every active segment spans exactly this interval with one exact curve (a move's x and y, say).
			const first = active[0];
			const together = active.every((x) => x.start === a && x.end === b && channel.exact(x) && JSON.stringify(x.ease) === JSON.stringify(first.ease));
			const curve = together ? flairCurveFor(first.ease, curves) : undefined;
			const ease = curve && (!overshoots(curve) || channel.overshoot) ? curve : undefined;
			if (ease) {
				const from = channel.value(a);
				const to = channel.value(b);
				if (!same(from, to) || channel.kind === 'view') emit(channel, a, b - a, from, to, ease);
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
	animate.sort((x, y) => (x.delay ?? 0) - (y.delay ?? 0));

	// The SVG: the artwork at rest, live effects drawn as plain paths so shapes can be tweened.
	let svg = vectorDocumentToSvg({ ...scene.artwork, nodes: expandVectorAppearances(scene.artwork.nodes) }, { pretty: false, precision });
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
