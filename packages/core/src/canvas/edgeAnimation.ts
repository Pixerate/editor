/**
 * Animated canvas edges: dots travelling along an edge, marching dashes, beams of light and a
 * pulsing glow. An edge's animation is data (`edge.data.animation`, a {@link CanvasEdgeAnimation}),
 * so it saves, undoes and copies with the edge. {@link getCanvasEdgeAnimationRender} turns it into a
 * framework-neutral list of SVG elements with SMIL timing, which `<AnimatedEdge>` /
 * `<EdgeAnimation>` (React and Svelte) render; {@link sampleCanvasEdgeAnimation} gives the same
 * picture at a moment in time without a browser (thumbnails, exports, tests, reduced motion).
 */

import type { CanvasConnectionLineType } from './connectors.js';
import { measureSvgPath, type MeasuredSvgPath, type SvgPathPoint } from './edgePaths.js';

/** What travels along the edge. */
export type CanvasEdgeAnimationKind = 'dots' | 'dash' | 'beam' | 'pulse';

/** Which way the animation runs: source → target, target → source, or back and forth. */
export type CanvasEdgeAnimationDirection = 'forward' | 'reverse' | 'alternate';

/** An edge's animation, stored at `edge.data.animation`. Every field but `kind` is optional. */
export interface CanvasEdgeAnimation {
	kind: CanvasEdgeAnimationKind;
	/** Travel speed in canvas units per second (`dots`, `dash`, `beam`). Defaults per kind. */
	speed?: number;
	/** Length of one cycle in ms; overrides `speed` (and is the only timing for `pulse`). */
	duration?: number;
	/** Default `forward` (source → target). */
	direction?: CanvasEdgeAnimationDirection;
	/** CSS colour. Default: the edge's stroke. */
	color?: string;
	/** Dot radius, or the stroke width of dashes, beams and the pulse, in canvas units. Defaults per kind. */
	size?: number;
	/** Number of dots or beams on the edge at once. Defaults per kind. */
	count?: number;
	/** Dash or beam length, in canvas units. Defaults per kind. */
	length?: number;
	/** Gap between dashes, in canvas units (`dash`). Default 6. */
	gap?: number;
	/** Glow radius (a blur behind the moving part), in canvas units. 0 is none. Defaults per kind. */
	glow?: number;
	/** Opacity of the edge's own stroke under the animation, 0–1. Default 1. */
	trackOpacity?: number;
	/** Held still at its first frame. Default false. */
	paused?: boolean;
}

export interface CanvasEdgeAnimationKindInfo {
	kind: CanvasEdgeAnimationKind;
	title: string;
	description: string;
	/** The values used for fields an animation leaves out. */
	defaults: Required<Omit<CanvasEdgeAnimation, 'kind' | 'color' | 'duration' | 'paused'>> & { duration?: number };
}

/** The animation kinds, with what they look like and their defaults. */
export const CANVAS_EDGE_ANIMATION_KINDS: readonly CanvasEdgeAnimationKindInfo[] = [
	{
		kind: 'dots',
		title: 'Travelling dots',
		description: 'Dots that travel along the edge, evenly spaced. Good for data or messages flowing between nodes.',
		defaults: { speed: 80, direction: 'forward', size: 3, count: 3, length: 0, gap: 0, glow: 0, trackOpacity: 1 }
	},
	{
		kind: 'dash',
		title: 'Marching dashes',
		description: 'The edge drawn as dashes that march along it. A quiet "this is live" signal.',
		defaults: { speed: 40, direction: 'forward', size: 2, count: 0, length: 8, gap: 6, glow: 0, trackOpacity: 0 }
	},
	{
		kind: 'beam',
		title: 'Beam',
		description: 'A short glowing streak that shoots along the edge and leaves it before the next one starts. Good for a request or a trigger.',
		defaults: { speed: 200, direction: 'forward', size: 3, count: 1, length: 40, gap: 0, glow: 4, trackOpacity: 0.35 }
	},
	{
		kind: 'pulse',
		title: 'Pulse',
		description: 'The whole edge glows brighter and fades again. Good for an active or highlighted connection.',
		defaults: { speed: 0, direction: 'forward', size: 4, count: 0, length: 0, gap: 0, glow: 3, trackOpacity: 1, duration: 1600 }
	}
];

const KINDS = CANVAS_EDGE_ANIMATION_KINDS.map((k) => k.kind);
const DIRECTIONS: readonly CanvasEdgeAnimationDirection[] = ['forward', 'reverse', 'alternate'];
const kindInfo = (kind: CanvasEdgeAnimationKind) => CANVAS_EDGE_ANIMATION_KINDS.find((k) => k.kind === kind)!;

const FIELDS: Record<string, { min: number; max: number; int?: boolean; description: string }> = {
	speed: { min: 1, max: 10000, description: 'canvas units per second' },
	duration: { min: 100, max: 600000, description: 'ms' },
	size: { min: 0.5, max: 100, description: 'canvas units' },
	count: { min: 1, max: 50, int: true, description: 'dots or beams' },
	length: { min: 1, max: 10000, description: 'canvas units' },
	gap: { min: 0, max: 10000, description: 'canvas units' },
	glow: { min: 0, max: 50, description: 'canvas units' },
	trackOpacity: { min: 0, max: 1, description: '0–1' }
};

/**
 * Checks an animation and returns a clean copy (unknown fields dropped). Throws an error that says
 * which field is wrong and what it accepts.
 */
export function normalizeCanvasEdgeAnimation(input: unknown): CanvasEdgeAnimation {
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('An edge animation is an object with a "kind" (dots, dash, beam or pulse).');
	const raw = input as Record<string, unknown>;
	if (!KINDS.includes(raw.kind as CanvasEdgeAnimationKind)) {
		throw new Error(`Unknown edge animation kind ${JSON.stringify(raw.kind)}. Use one of: ${KINDS.join(', ')}.`);
	}
	const out: CanvasEdgeAnimation = { kind: raw.kind as CanvasEdgeAnimationKind };
	for (const [key, spec] of Object.entries(FIELDS)) {
		const value = raw[key];
		if (value === undefined || value === null) continue;
		if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max || (spec.int && !Number.isInteger(value))) {
			throw new Error(`Edge animation "${key}" must be ${spec.int ? 'a whole number' : 'a number'} from ${spec.min} to ${spec.max} (${spec.description}); got ${JSON.stringify(value)}.`);
		}
		(out as any)[key] = value;
	}
	if (raw.direction !== undefined && raw.direction !== null) {
		if (!DIRECTIONS.includes(raw.direction as CanvasEdgeAnimationDirection)) {
			throw new Error(`Edge animation "direction" must be one of: ${DIRECTIONS.join(', ')}; got ${JSON.stringify(raw.direction)}.`);
		}
		out.direction = raw.direction as CanvasEdgeAnimationDirection;
	}
	if (raw.color !== undefined && raw.color !== null) {
		if (typeof raw.color !== 'string' || raw.color.trim() === '' || /[;{}<>]/.test(raw.color)) {
			throw new Error(`Edge animation "color" must be a CSS colour such as "#38bdf8" or "rgb(56 189 248)"; got ${JSON.stringify(raw.color)}.`);
		}
		out.color = raw.color.trim();
	}
	if (raw.paused !== undefined && raw.paused !== null) {
		if (typeof raw.paused !== 'boolean') throw new Error(`Edge animation "paused" must be true or false; got ${JSON.stringify(raw.paused)}.`);
		out.paused = raw.paused;
	}
	return out;
}

/** The edge's animation, or null when it has none or it is not valid. */
export function getCanvasEdgeAnimation(edge: { data?: Record<string, any> } | null | undefined): CanvasEdgeAnimation | null {
	const value = edge?.data?.animation;
	if (value === undefined || value === null) return null;
	try {
		return normalizeCanvasEdgeAnimation(value);
	} catch {
		return null;
	}
}

/** A copy of the edge with its animation set (checked first), or removed when `animation` is null. */
export function setCanvasEdgeAnimation<TEdge extends { data?: Record<string, any> }>(edge: TEdge, animation: CanvasEdgeAnimation | null): TEdge {
	const { animation: _old, ...rest } = (edge.data ?? {}) as Record<string, any>;
	if (animation === null) return { ...edge, data: rest } as TEdge;
	return { ...edge, data: { ...rest, animation: normalizeCanvasEdgeAnimation(animation) } } as TEdge;
}

/** The animation with every default filled in, as it will play. */
export function resolveCanvasEdgeAnimation(animation: CanvasEdgeAnimation): Required<Omit<CanvasEdgeAnimation, 'color' | 'duration'>> & Pick<CanvasEdgeAnimation, 'color' | 'duration'> {
	const d = kindInfo(animation.kind).defaults;
	return {
		kind: animation.kind,
		speed: animation.speed ?? d.speed,
		direction: animation.direction ?? d.direction,
		size: animation.size ?? d.size,
		count: animation.count ?? d.count,
		length: animation.length ?? d.length,
		gap: animation.gap ?? d.gap,
		glow: animation.glow ?? d.glow,
		trackOpacity: animation.trackOpacity ?? d.trackOpacity,
		paused: animation.paused ?? false,
		...(animation.color !== undefined ? { color: animation.color } : {}),
		...(animation.duration !== undefined ? { duration: animation.duration } : d.duration !== undefined ? { duration: d.duration } : {})
	};
}

/** SMIL timing for an element: rendered as `<animate>` / `<animateMotion>` children. */
export interface CanvasEdgeAnimationTiming {
	/** Seconds per cycle (SMIL `dur`). */
	dur: number;
	/** Start offset in seconds; negative starts part-way through (SMIL `begin`). */
	begin: number;
}

/** One SVG element of an animated edge. Coordinates are canvas units. */
export type CanvasEdgeAnimationElement =
	| {
			type: 'dot';
			key: string;
			r: number;
			fill: string;
			filter?: string;
			/** Where the dot is at the first frame (used when paused or with reduced motion). */
			at: SvgPathPoint;
			/** Travel along the path: `keyPoints` / `keyTimes` for `<animateMotion>`. */
			motion: CanvasEdgeAnimationTiming & { keyPoints: string; keyTimes: string };
	  }
	| {
			type: 'stroke';
			key: string;
			stroke: string;
			strokeWidth: number;
			strokeLinecap: 'round' | 'butt';
			strokeDasharray?: string;
			strokeDashoffset?: number;
			opacity?: number;
			filter?: string;
			/** `<animate>`s to add: attribute, values (`;`-separated, SMIL), timing. */
			animate: Array<CanvasEdgeAnimationTiming & { attributeName: 'stroke-dashoffset' | 'stroke-opacity' | 'stroke-width'; values: string }>;
	  };

export interface CanvasEdgeAnimationRender {
	kind: CanvasEdgeAnimationKind;
	/** Path length in canvas units. */
	length: number;
	/** Opacity for the edge's own stroke. */
	trackOpacity: number;
	/** Whether the elements should move (false when paused, reduced motion or a zero-length path). */
	moving: boolean;
	/**
	 * A blur filter to define in `<defs>` when anything glows. Its region is in user space (canvas
	 * units, `filterUnits="userSpaceOnUse"`): a straight edge has a zero-height box, and a filter
	 * sized to the box would hide it.
	 */
	glowFilter?: { id: string; stdDeviation: number; x: number; y: number; width: number; height: number };
	elements: CanvasEdgeAnimationElement[];
}

export interface CanvasEdgeAnimationRenderOptions {
	/** SVG path data of the edge (`getCanvasEdgePath(...).path` or the path your edge draws). */
	path: string;
	/** A unique id for this edge's defs (the edge id). */
	id: string;
	/** Colour used when the animation has none (the edge's stroke). Default `currentColor`. */
	stroke?: string;
	/** Draw the first frame without movement (honour `prefers-reduced-motion`). Default false. */
	reducedMotion?: boolean;
	/** A measured path to reuse, when you already have one for `path`. */
	measured?: MeasuredSvgPath;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const idSafe = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_');

function cycleSeconds(anim: ReturnType<typeof resolveCanvasEdgeAnimation>, distance: number): number {
	if (anim.duration !== undefined) return anim.duration / 1000;
	return Math.max(distance / anim.speed, 0.05);
}

/**
 * How to draw an animated edge: SVG elements and SMIL timing, computed from the path. Dots use
 * `<animateMotion>` along the path, dashes and beams animate `stroke-dashoffset`, the pulse animates
 * opacity and width. Nothing here needs a DOM; the React and Svelte `<EdgeAnimation>` render it.
 */
export function getCanvasEdgeAnimationRender(animation: CanvasEdgeAnimation, options: CanvasEdgeAnimationRenderOptions): CanvasEdgeAnimationRender {
	const anim = resolveCanvasEdgeAnimation(normalizeCanvasEdgeAnimation(animation));
	const measured = options.measured ?? measureSvgPath(options.path);
	const length = measured.length;
	const color = anim.color ?? options.stroke ?? 'currentColor';
	const moving = !anim.paused && !options.reducedMotion && length > 0;
	const margin = anim.size * 2 + anim.glow * 3 + 2;
	const b = measured.bounds;
	const glowFilter =
		anim.glow > 0
			? {
					id: `pixerate-edge-glow-${idSafe(options.id)}`,
					stdDeviation: round(anim.glow / 2),
					x: round(b.x - margin),
					y: round(b.y - margin),
					width: round(b.width + margin * 2),
					height: round(b.height + margin * 2)
				}
			: undefined;
	const filter = glowFilter ? `url(#${glowFilter.id})` : undefined;
	const alternate = anim.direction === 'alternate';
	const reverse = anim.direction === 'reverse';
	const elements: CanvasEdgeAnimationElement[] = [];

	if (anim.kind === 'dots') {
		const oneWay = cycleSeconds(anim, length);
		const dur = alternate ? oneWay * 2 : oneWay;
		const keyPoints = alternate ? '0;1;0' : reverse ? '1;0' : '0;1';
		const keyTimes = alternate ? '0;0.5;1' : '0;1';
		for (let i = 0; i < anim.count; i++) {
			const phase = i / anim.count;
			const s = alternate ? (phase < 0.5 ? phase * 2 : 2 - phase * 2) : reverse ? 1 - phase : phase;
			elements.push({
				type: 'dot',
				key: `dot-${i}`,
				r: anim.size,
				fill: color,
				filter,
				at: measured.pointAt(s * length),
				motion: { dur: round(dur), begin: round(-phase * dur), keyPoints, keyTimes }
			});
		}
	} else if (anim.kind === 'dash') {
		const period = anim.length + anim.gap;
		const dur = cycleSeconds(anim, period);
		const to = reverse ? period : -period;
		elements.push({
			type: 'stroke',
			key: 'dash',
			stroke: color,
			strokeWidth: anim.size,
			strokeLinecap: 'butt',
			strokeDasharray: `${round(anim.length)} ${round(anim.gap)}`,
			strokeDashoffset: 0,
			filter,
			animate: [{ attributeName: 'stroke-dashoffset', values: alternate ? `0;${round(-period)};0` : `0;${round(to)}`, dur: round(alternate ? dur * 2 : dur), begin: 0 }]
		});
	} else if (anim.kind === 'beam') {
		// Each beam is a dash of `length` in a pattern of `period`; offsets run from "just before the
		// start" to "just past the end" so a beam leaves the edge as the next one arrives.
		const period = (length + anim.length) / anim.count;
		const beam = Math.min(anim.length, period * 0.9);
		const oneWay = cycleSeconds(anim, period);
		const from = beam;
		const to = beam - period;
		const values = alternate
			? `${round(from)};${round(to)};${round(from)}`
			: reverse
				? `${round(to)};${round(from)}`
				: `${round(from)};${round(to)}`;
		elements.push({
			type: 'stroke',
			key: 'beam',
			stroke: color,
			strokeWidth: anim.size,
			strokeLinecap: 'round',
			strokeDasharray: `${round(beam)} ${round(Math.max(period - beam, 0.001))}`,
			// Held still, the beam sits in the middle of the edge rather than off its start.
			strokeDashoffset: round(moving ? (reverse ? to : from) : beam / 2 - length / 2),
			filter,
			animate: [{ attributeName: 'stroke-dashoffset', values, dur: round(alternate ? oneWay * 2 : oneWay), begin: 0 }]
		});
	} else {
		const dur = (anim.duration ?? 1600) / 1000;
		elements.push({
			type: 'stroke',
			key: 'pulse',
			stroke: color,
			strokeWidth: anim.size,
			strokeLinecap: 'round',
			opacity: 0.2,
			filter,
			animate: [
				{ attributeName: 'stroke-opacity', values: '0.2;1;0.2', dur: round(dur), begin: 0 },
				{ attributeName: 'stroke-width', values: `${round(anim.size)};${round(anim.size * 1.75)};${round(anim.size)}`, dur: round(dur), begin: 0 }
			]
		});
	}
	return { kind: anim.kind, length: round(length), trackOpacity: anim.trackOpacity, moving, glowFilter, elements };
}

/** The animated part of an edge at one moment. */
export interface CanvasEdgeAnimationFrame {
	kind: CanvasEdgeAnimationKind;
	length: number;
	/** Dot positions (`dots`). */
	dots: SvgPathPoint[];
	/** Visible stretches of the path as [from, to] distances (`dash`, `beam`), clipped to the path. */
	segments: Array<[number, number]>;
	/** Stroke opacity and width (`pulse`). */
	opacity: number;
	strokeWidth: number;
}

/** Linear interpolation over SMIL-style `values` at progress t in [0, 1]. */
function valuesAt(values: number[], t: number): number {
	if (values.length === 1) return values[0];
	const f = Math.min(Math.max(t, 0), 1) * (values.length - 1);
	const i = Math.min(Math.floor(f), values.length - 2);
	return values[i] + (values[i + 1] - values[i]) * (f - i);
}

/**
 * Where everything is `timeMs` into the animation: the same picture the SVG shows at that time,
 * computed without a browser (for thumbnails, exports, canvas renderers and tests). A paused
 * animation always returns its first frame.
 */
export function sampleCanvasEdgeAnimation(animation: CanvasEdgeAnimation, path: string | MeasuredSvgPath, timeMs: number): CanvasEdgeAnimationFrame {
	const measured = typeof path === 'string' ? measureSvgPath(path) : path;
	const render = getCanvasEdgeAnimationRender(animation, { path: '', id: 'sample', measured });
	const anim = resolveCanvasEdgeAnimation(normalizeCanvasEdgeAnimation(animation));
	const seconds = anim.paused ? 0 : timeMs / 1000;
	const progress = (t: CanvasEdgeAnimationTiming) => {
		const p = (seconds - t.begin) / t.dur;
		return p - Math.floor(p);
	};
	const frame: CanvasEdgeAnimationFrame = { kind: anim.kind, length: render.length, dots: [], segments: [], opacity: 1, strokeWidth: anim.size };
	for (const el of render.elements) {
		if (el.type === 'dot') {
			const points = el.motion.keyPoints.split(';').map(Number);
			frame.dots.push(measured.pointAt(valuesAt(points, progress(el.motion)) * measured.length));
			continue;
		}
		for (const a of el.animate) {
			const value = anim.paused && a.attributeName === 'stroke-dashoffset' ? el.strokeDashoffset ?? 0 : valuesAt(a.values.split(';').map(Number), progress(a));
			if (a.attributeName === 'stroke-opacity') frame.opacity = value;
			else if (a.attributeName === 'stroke-width') frame.strokeWidth = value;
			else if (el.strokeDasharray) {
				const [on, off] = el.strokeDasharray.split(' ').map(Number);
				const period = on + off;
				// Pattern position p shows at path distance s = p - offset; dashes cover p in [k·period, k·period + on).
				const start = Math.floor((0 + value) / period) - 1;
				for (let k = start; (k * period - value) < measured.length; k++) {
					const from = k * period - value;
					const to = from + on;
					const a0 = Math.max(from, 0);
					const b0 = Math.min(to, measured.length);
					if (b0 > a0) frame.segments.push([round(a0), round(b0)]);
				}
			}
		}
		if (anim.kind === 'pulse' && frame.segments.length === 0) frame.segments.push([0, render.length]);
	}
	return frame;
}

/** Edge path styles `<AnimatedEdge>` can draw (read from `edge.data.pathType`). */
export type CanvasAnimatedEdgePathType = CanvasConnectionLineType;
