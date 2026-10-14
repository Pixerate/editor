import type { CanvasNode } from '../types.js';
import { easingToCss } from './easing.js';
import { evaluateAnimation, evaluateTrack, getAnimationDuration, type AnimationDocument, type AnimationLoopMode, type AnimationOverrides, type EvaluateAnimationOptions } from './evaluate.js';
import { ANIMATABLE_PROPERTIES, getNodeAnimation, normalizeKeyframes, type AnimationKeyframe, type AnimationValue } from './model.js';

const nodesOf = (doc: AnimationDocument): readonly CanvasNode[] => (Array.isArray(doc) ? doc : (doc as { nodes: readonly CanvasNode[] }).nodes);

export interface SampleAnimationOptions extends EvaluateAnimationOptions {
	/** Frames per second (default 30). */
	fps?: number;
	/** Length in ms (default: the last keyframe time). */
	duration?: number;
	/** First time sampled (default 0). */
	start?: number;
	/** Refuses to produce more frames than this (default 100 000). */
	maxFrames?: number;
}

export interface AnimationFrame {
	index: number;
	/** Time in ms. */
	time: number;
	overrides: AnimationOverrides;
}

/**
 * Samples the animation at a fixed frame rate from `start` through `start + duration`
 * (both included), e.g. to render video frames. Apply a frame with `applyAnimationOverrides`.
 */
export function sampleAnimationFrames(doc: AnimationDocument, options: SampleAnimationOptions = {}): AnimationFrame[] {
	const fps = options.fps ?? 30;
	if (!(fps > 0) || !Number.isFinite(fps)) throw new RangeError('fps must be a positive number.');
	const start = options.start ?? 0;
	const duration = Math.max(0, options.duration ?? getAnimationDuration(doc) - start);
	const step = 1000 / fps;
	const count = Math.floor(duration / step + 1e-9) + 1;
	if (count > (options.maxFrames ?? 100_000)) throw new RangeError(`Sampling would produce ${count} frames.`);
	const frames: AnimationFrame[] = [];
	for (let i = 0; i < count; i++) {
		const time = start + i * step;
		frames.push({ index: i, time, overrides: evaluateAnimation(doc, time, options) });
	}
	return frames;
}

// -------------------------------------------------------------------------------------------
// CSS / Web Animations

/** CSS property each animatable property maps to (camelCase for the Web Animations API). */
export const CSS_ANIMATION_PROPERTIES: Readonly<Record<string, { css: string; camel: string }>> = {
	x: { css: 'translate', camel: 'translate' },
	y: { css: 'translate', camel: 'translate' },
	motionPath: { css: 'translate', camel: 'translate' },
	rotation: { css: 'rotate', camel: 'rotate' },
	scale: { css: 'scale', camel: 'scale' },
	opacity: { css: 'opacity', camel: 'opacity' },
	fill: { css: 'background-color', camel: 'backgroundColor' },
	stroke: { css: 'border-color', camel: 'borderColor' },
	strokeWidth: { css: 'border-width', camel: 'borderWidth' },
	cornerRadius: { css: 'border-radius', camel: 'borderRadius' },
	width: { css: 'width', camel: 'width' },
	height: { css: 'height', camel: 'height' }
};

export interface AnimationStop {
	/** 0–1 */
	offset: number;
	value: string;
	/** Timing function of the segment starting here. */
	easing?: string;
}

export interface CssPropertyAnimation {
	/** CSS property, e.g. `translate`. */
	property: string;
	/** camelCase name for `element.animate`. */
	camel: string;
	/** Animatable properties driving it, e.g. `['x', 'y']`. */
	sources: string[];
	stops: AnimationStop[];
	/** False when the stops are sampled (colours mixed in OKLab, x / y with different timing, motion paths). */
	exact: boolean;
}

export interface CssExportOptions {
	/** Timeline length in ms (default: the document's last keyframe time). */
	duration?: number;
	loop?: AnimationLoopMode;
	playbackRate?: number;
	/** Sampling rate for tracks CSS cannot express exactly (default 30 per second). */
	sampleFps?: number;
	/** Map properties to other CSS properties (e.g. `{ fill: { css: 'fill', camel: 'fill' } }` for SVG). */
	cssProperties?: Record<string, { css: string; camel: string }>;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

function cssValue(source: string, value: AnimationValue, node: CanvasNode, partner?: AnimationValue, partnerSource?: string): string {
	if (source === 'x' || source === 'y') {
		const dx = source === 'x' ? (value as number) - node.position.x : partner !== undefined ? (partner as number) - node.position.x : 0;
		const dy = source === 'y' ? (value as number) - node.position.y : partner !== undefined && partnerSource === 'y' ? (partner as number) - node.position.y : 0;
		return `${round(dx)}px ${round(dy)}px`;
	}
	if (typeof value === 'string') return value;
	switch (source) {
		case 'rotation':
			return `${round(value)}deg`;
		case 'scale':
		case 'opacity':
			return String(round(value));
		default:
			return `${round(value)}px`;
	}
}

const sameTimes = (a: AnimationKeyframe[], b: AnimationKeyframe[]) =>
	a.length === b.length && a.every((k, i) => Math.abs(k.time - b[i].time) < 1e-6 && JSON.stringify(k.easing ?? 'linear') === JSON.stringify(b[i].easing ?? 'linear'));

function needsOklab(keys: AnimationKeyframe[]): boolean {
	for (let i = 0; i + 1 < keys.length; i++) {
		if (keys[i].easing !== 'hold' && keys[i].value !== keys[i + 1].value) return true;
	}
	return false;
}

function exactStops(keys: AnimationKeyframe[], duration: number, format: (k: AnimationKeyframe, i: number) => string): AnimationStop[] {
	const stops: AnimationStop[] = [];
	if (keys[0].time > 0) stops.push({ offset: 0, value: format(keys[0], 0), easing: 'linear' });
	keys.forEach((k, i) => {
		const next = keys[i + 1];
		stops.push({
			offset: Math.min(1, Math.max(0, k.time / duration)),
			value: format(k, i),
			...(next ? { easing: easingToCss(k.easing, next.time - k.time) } : {})
		});
	});
	const last = keys[keys.length - 1];
	if (last.time < duration) stops.push({ offset: 1, value: format(last, keys.length - 1) });
	return stops;
}

function sampledStops(duration: number, fps: number, keyTimes: number[], valueAt: (time: number) => string): AnimationStop[] {
	const times = new Set<number>([0, duration, ...keyTimes.filter((t) => t >= 0 && t <= duration)]);
	const step = 1000 / Math.max(1, fps);
	for (let t = step; t < duration; t += step) times.add(t);
	return [...times]
		.sort((a, b) => a - b)
		.map((t) => ({ offset: Math.min(1, t / duration), value: valueAt(t), easing: 'linear' }));
}

/**
 * The node's enabled tracks as per-CSS-property keyframe stops: rotation / scale use the
 * individual transform properties, x / y become `translate` relative to the node's position.
 * Tracks CSS cannot reproduce exactly are sampled (`exact: false`).
 */
export function getCssPropertyAnimations(nodes: readonly CanvasNode[], nodeId: string, options: CssExportOptions = {}): CssPropertyAnimation[] {
	const node = nodes.find((n) => n.id === nodeId);
	const animation = getNodeAnimation(node);
	if (!node || !animation) return [];
	const duration = options.duration ?? getAnimationDuration([node]);
	if (!(duration > 0)) return [];
	const fps = options.sampleFps ?? 30;
	const map = { ...CSS_ANIMATION_PROPERTIES, ...(options.cssProperties ?? {}) };
	const tracks = new Map<string, AnimationKeyframe[]>();
	for (const [key, track] of Object.entries(animation.tracks)) {
		if (!track || track.enabled === false || !map[key]) continue;
		const keys = normalizeKeyframes(track.keyframes);
		if (keys.length > 0) tracks.set(key, keys);
	}
	const typeOf = (key: string) => ANIMATABLE_PROPERTIES.find((p) => p.key === key)?.type ?? 'number';
	const groups = new Map<string, string[]>();
	for (const key of tracks.keys()) {
		const css = map[key].css;
		groups.set(css, [...(groups.get(css) ?? []), key]);
	}
	const out: CssPropertyAnimation[] = [];
	for (const [css, sources] of groups) {
		const camel = map[sources[0]].camel;
		const keysOf = (k: string) => tracks.get(k)!;
		const evalAt = (k: string, t: number) => evaluateTrack(keysOf(k), t, typeOf(k))!;
		const allTimes = sources.flatMap((k) => keysOf(k).map((x) => x.time));
		if (sources.includes('motionPath')) {
			// The motion path track drives the translate; sample its positions.
			const position = (t: number) => {
				const moved = ANIMATABLE_PROPERTIES.find((p) => p.key === 'motionPath')!.write(node, evalAt('motionPath', t));
				return `${round(moved.position.x - node.position.x)}px ${round(moved.position.y - node.position.y)}px`;
			};
			out.push({ property: css, camel, sources, stops: sampledStops(duration, fps, allTimes, position), exact: false });
			continue;
		}
		if (sources.length === 2 && css === 'translate') {
			const [a, b] = sources[0] === 'x' ? sources : [sources[1], sources[0]];
			if (sameTimes(keysOf(a), keysOf(b))) {
				const bKeys = keysOf(b);
				out.push({ property: css, camel, sources, stops: exactStops(keysOf(a), duration, (k, i) => cssValue(a, k.value, node, bKeys[i].value, b)), exact: true });
			} else {
				out.push({
					property: css,
					camel,
					sources,
					stops: sampledStops(duration, fps, allTimes, (t) => cssValue(a, evalAt(a, t), node, evalAt(b, t), b)),
					exact: false
				});
			}
			continue;
		}
		const key = sources[sources.length - 1];
		const keys = keysOf(key);
		if (typeOf(key) === 'color' && needsOklab(keys)) {
			out.push({ property: css, camel, sources: [key], stops: sampledStops(duration, fps, allTimes, (t) => cssValue(key, evalAt(key, t), node)), exact: false });
		} else {
			out.push({ property: css, camel, sources: [key], stops: exactStops(keys, duration, (k) => cssValue(key, k.value, node)), exact: true });
		}
	}
	return out;
}

function timing(options: CssExportOptions, duration: number) {
	const rate = options.playbackRate && Number.isFinite(options.playbackRate) && options.playbackRate !== 0 ? options.playbackRate : 1;
	const loop = options.loop ?? 'none';
	return {
		duration: round(duration / Math.abs(rate)),
		iterations: loop === 'none' ? 1 : Infinity,
		direction: (loop === 'ping-pong' ? (rate < 0 ? 'alternate-reverse' : 'alternate') : rate < 0 ? 'reverse' : 'normal') as PlaybackDirectionLike
	};
}

type PlaybackDirectionLike = 'normal' | 'reverse' | 'alternate' | 'alternate-reverse';

export interface CssAnimationExport {
	/** `@keyframes` blocks plus a rule applying them to `selector`. */
	css: string;
	/** Value for the `animation` property (comma-separated, one per CSS property). */
	animation: string;
	animations: { name: string; property: string; exact: boolean }[];
	/** Whether every property is reproduced exactly. */
	exact: boolean;
}

const cssIdent = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^(\d)/, '_$1');

/**
 * Exports a node's animation as CSS `@keyframes` (one per CSS property, so different tracks
 * keep their own easing) and an `animation` declaration for `selector`.
 */
export function exportCssAnimation(
	nodes: readonly CanvasNode[],
	nodeId: string,
	options: CssExportOptions & { name?: string; selector?: string } = {}
): CssAnimationExport {
	const duration = options.duration ?? getAnimationDuration(nodes.filter((n) => n.id === nodeId));
	const props = getCssPropertyAnimations(nodes, nodeId, { ...options, duration });
	const base = cssIdent(options.name ?? `anim-${nodeId}`);
	const t = timing(options, duration);
	const blocks: string[] = [];
	const parts: string[] = [];
	const animations: CssAnimationExport['animations'] = [];
	for (const prop of props) {
		const name = `${base}-${cssIdent(prop.property)}`;
		const lines = prop.stops.map((s) => {
			const pct = `${round(s.offset * 100)}%`;
			const easing = s.easing ? ` animation-timing-function: ${s.easing};` : '';
			return `  ${pct} { ${prop.property}: ${s.value};${easing} }`;
		});
		blocks.push(`@keyframes ${name} {\n${lines.join('\n')}\n}`);
		parts.push(`${name} ${t.duration}ms linear 0ms ${t.iterations === Infinity ? 'infinite' : 1} ${t.direction} both`);
		animations.push({ name, property: prop.property, exact: prop.exact });
	}
	const animation = parts.join(', ');
	const selector = options.selector ?? `[data-id="${nodeId.replace(/["\\]/g, '\\$&')}"]`;
	const css = blocks.length ? `${blocks.join('\n\n')}\n\n${selector} {\n  animation: ${animation};\n}\n` : '';
	return { css, animation, animations, exact: props.every((p) => p.exact) };
}

/** One `element.animate(keyframes, options)` call. */
export interface WebAnimationSpec {
	property: string;
	keyframes: { offset: number; easing?: string; [property: string]: string | number | undefined }[];
	options: { duration: number; iterations: number; direction: PlaybackDirectionLike; fill: 'both'; easing: 'linear' };
	exact: boolean;
}

/** The node's animation as Web Animations API keyframes (one animation per CSS property). */
export function toWebAnimations(nodes: readonly CanvasNode[], nodeId: string, options: CssExportOptions = {}): WebAnimationSpec[] {
	const duration = options.duration ?? getAnimationDuration(nodes.filter((n) => n.id === nodeId));
	const t = timing(options, duration);
	return getCssPropertyAnimations(nodes, nodeId, { ...options, duration }).map((prop) => ({
		property: prop.property,
		keyframes: prop.stops.map((s) => ({ offset: s.offset, [prop.camel]: s.value, ...(s.easing ? { easing: s.easing } : {}) })),
		options: { duration: t.duration, iterations: t.iterations, direction: t.direction, fill: 'both', easing: 'linear' },
		exact: prop.exact
	}));
}

/** Plays Web Animations specs on an element (anything with `animate`), returning the animations. */
export function playWebAnimations<TAnimation>(
	element: { animate(keyframes: any, options: any): TAnimation },
	specs: readonly WebAnimationSpec[]
): TAnimation[] {
	return specs.map((spec) => element.animate(spec.keyframes, spec.options));
}

/** Whether every enabled track of the node can be exported without sampling. */
export function isCssExportExact(nodes: readonly CanvasNode[], nodeId: string): boolean {
	return getCssPropertyAnimations(nodes, nodeId).every((p) => p.exact);
}

