// Portions ported from filmcraft-main/crates/project/src/keyframe.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Keyframe easing: the curve a segment follows from one keyframe to the next.
 *
 * - `hold` keeps the first keyframe's value until the next one (a step).
 * - `linear` and the CSS presets (`ease`, `ease-in`, `ease-out`, `ease-in-out`) are
 *   CSS-compatible `cubic-bezier()` curves; `{ type: 'cubic-bezier', x1, y1, x2, y2 }` is any
 *   such curve (x1 / y1 is the leaving keyframe's out handle, x2 / y2 the next one's in handle).
 * - `spring` is a damped spring settling on the next value (it may overshoot).
 */

/** Named easing presets. */
export type AnimationEasingPreset =
	| 'linear'
	| 'hold'
	| 'ease'
	| 'ease-in'
	| 'ease-out'
	| 'ease-in-out'
	| 'ease-in-back'
	| 'ease-out-back'
	| 'ease-out-elastic'
	| 'ease-in-elastic'
	| 'ease-in-out-elastic'
	| 'elastic'
	| 'spring';

export interface CubicBezierEasing {
	type: 'cubic-bezier';
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface SpringEasing {
	type: 'spring';
	/** Spring stiffness (default 170). */
	stiffness?: number;
	/** Damping (default 26). */
	damping?: number;
	/** Mass (default 1). */
	mass?: number;
	/** Initial velocity in units of the segment's value change per second (default 0). */
	velocity?: number;
}

export interface ElasticEasing {
	type: 'elastic';
	/** Amplitude / overshoot factor (default 1). */
	amplitude?: number;
	/** Period of oscillation as a fraction of duration (default 0.3). */
	period?: number;
	/** Mode of elastic oscillation ('out' | 'in' | 'in-out', default 'out'). */
	mode?: 'out' | 'in' | 'in-out';
}

export type AnimationEasing = AnimationEasingPreset | CubicBezierEasing | SpringEasing | ElasticEasing;

/** Preset names, in picker order. */
export const ANIMATION_EASING_PRESETS: readonly AnimationEasingPreset[] = [
	'linear',
	'ease',
	'ease-in',
	'ease-out',
	'ease-in-out',
	'ease-in-back',
	'ease-out-back',
	'ease-out-elastic',
	'ease-in-elastic',
	'ease-in-out-elastic',
	'elastic',
	'spring',
	'hold'
];

/** Picker labels for the presets. */
export const ANIMATION_EASING_LABELS: Readonly<Record<AnimationEasingPreset, string>> = {
	linear: 'Linear',
	hold: 'Hold',
	ease: 'Ease',
	'ease-in': 'Ease in',
	'ease-out': 'Ease out',
	'ease-in-out': 'Ease in-out',
	'ease-in-back': 'Back in',
	'ease-out-back': 'Back out',
	'ease-out-elastic': 'Elastic out',
	'ease-in-elastic': 'Elastic in',
	'ease-in-out-elastic': 'Elastic in-out',
	elastic: 'Elastic',
	spring: 'Spring'
};

/** The CSS control points of the bezier presets (CSS Easing Functions Level 1 values for the CSS keywords). */
export const CUBIC_BEZIER_PRESETS: Readonly<Record<string, readonly [number, number, number, number]>> = {
	linear: [0, 0, 1, 1],
	ease: [0.25, 0.1, 0.25, 1],
	'ease-in': [0.42, 0, 1, 1],
	'ease-out': [0, 0, 0.58, 1],
	'ease-in-out': [0.42, 0, 0.58, 1],
	'ease-in-back': [0.36, 0, 0.66, -0.56],
	'ease-out-back': [0.34, 1.56, 0.64, 1]
};

const DEFAULT_SPRING = { stiffness: 170, damping: 26, mass: 1, velocity: 0 };
const DEFAULT_ELASTIC = { amplitude: 1, period: 0.3, mode: 'out' as const };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * Normalised position for a parametric elastic oscillation curve (as used in Rive and Penner curves).
 * Amplitude controls the overshoot intensity; period controls the wave frequency across normalized progress `t` (0–1).
 */
export function elasticAt(elastic: Omit<ElasticEasing, 'type'>, t: number): number {
	if (t <= 0) return 0;
	if (t >= 1) return 1;

	const a = Math.max(1e-6, finite(elastic.amplitude, DEFAULT_ELASTIC.amplitude));
	const p = Math.max(1e-6, finite(elastic.period, DEFAULT_ELASTIC.period));
	const mode = elastic.mode ?? 'out';

	const TAU = 2 * Math.PI;

	const solveOut = (u: number, amp: number, per: number) => {
		const s = amp < 1 ? per / 4 : (per / TAU) * Math.asin(1 / amp);
		return amp * Math.pow(2, -10 * u) * Math.sin(((u - s) * TAU) / per) + 1;
	};

	const solveIn = (u: number, amp: number, per: number) => {
		const s = amp < 1 ? per / 4 : (per / TAU) * Math.asin(1 / amp);
		const adjusted = u - 1;
		return -(amp * Math.pow(2, 10 * adjusted) * Math.sin(((adjusted - s) * TAU) / per));
	};

	if (mode === 'in') {
		return solveIn(t, a, p);
	}
	if (mode === 'in-out') {
		if (t < 0.5) {
			return 0.5 * solveIn(t * 2, a, p);
		}
		return 0.5 + 0.5 * solveOut((t - 0.5) * 2, a, p);
	}
	return solveOut(t, a, p);
}

/**
 * Solves a CSS `cubic-bezier(x1, y1, x2, y2)` for y at progress x (Newton steps with a
 * bisection fallback). x1 / x2 are clamped to 0–1 as CSS requires.
 */
export function cubicBezierAt(x1: number, y1: number, x2: number, y2: number, x: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	x1 = clamp(x1, 0, 1);
	x2 = clamp(x2, 0, 1);
	const bx = (s: number) => 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
	const by = (s: number) => 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
	const dbx = (s: number) => 3 * (1 - s) * (1 - s) * x1 + 6 * (1 - s) * s * (x2 - x1) + 3 * s * s * (1 - x2);
	let s = x;
	for (let i = 0; i < 8; i++) {
		const d = dbx(s);
		if (Math.abs(d) < 1e-9) break;
		const next = s - (bx(s) - x) / d;
		if (!(next >= 0 && next <= 1)) break;
		s = next;
	}
	if (Math.abs(bx(s) - x) > 1e-7) {
		let lo = 0;
		let hi = 1;
		for (let i = 0; i < 60; i++) {
			s = (lo + hi) / 2;
			if (bx(s) < x) lo = s;
			else hi = s;
		}
	}
	return by(s);
}

/**
 * Normalised position of a damped spring released from 0 towards 1, `seconds` after release.
 * Closed form for under-, critically and over-damped springs.
 */
export function springAt(spring: Omit<SpringEasing, 'type'>, seconds: number): number {
	const stiffness = Math.max(1e-6, finite(spring.stiffness, DEFAULT_SPRING.stiffness));
	const damping = Math.max(0, finite(spring.damping, DEFAULT_SPRING.damping));
	const mass = Math.max(1e-6, finite(spring.mass, DEFAULT_SPRING.mass));
	const v0 = -finite(spring.velocity, DEFAULT_SPRING.velocity);
	const t = Math.max(0, seconds);
	const w0 = Math.sqrt(stiffness / mass);
	const zeta = damping / (2 * Math.sqrt(stiffness * mass));
	// x(t) is the displacement from the target (starts at 1); progress = 1 - x.
	let x: number;
	if (zeta < 1 - 1e-6) {
		const wd = w0 * Math.sqrt(1 - zeta * zeta);
		x = Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0 + v0) / wd) * Math.sin(wd * t));
	} else if (zeta <= 1 + 1e-6) {
		x = Math.exp(-w0 * t) * (1 + (w0 + v0) * t);
	} else {
		const r = Math.sqrt(zeta * zeta - 1);
		const s1 = -w0 * (zeta - r);
		const s2 = -w0 * (zeta + r);
		const c2 = (v0 - s1) / (s2 - s1);
		const c1 = 1 - c2;
		x = c1 * Math.exp(s1 * t) + c2 * Math.exp(s2 * t);
	}
	return 1 - x;
}

/** Resolves an easing to a cubic-bezier, spring, elastic or hold descriptor (unknown input → linear). */
export function resolveEasing(
	easing: AnimationEasing | string | undefined | null
): CubicBezierEasing | Required<SpringEasing> | Required<ElasticEasing> | 'hold' {
	if (easing === 'hold') return 'hold';
	if (easing === 'spring') return { type: 'spring', ...DEFAULT_SPRING };
	if (easing === 'elastic' || easing === 'ease-out-elastic') {
		return { type: 'elastic', ...DEFAULT_ELASTIC, mode: 'out' };
	}
	if (easing === 'ease-in-elastic') {
		return { type: 'elastic', ...DEFAULT_ELASTIC, mode: 'in' };
	}
	if (easing === 'ease-in-out-elastic') {
		return { type: 'elastic', ...DEFAULT_ELASTIC, mode: 'in-out' };
	}
	if (typeof easing === 'string') {
		const preset = CUBIC_BEZIER_PRESETS[easing];
		if (preset) return { type: 'cubic-bezier', x1: preset[0], y1: preset[1], x2: preset[2], y2: preset[3] };
		const parsed = parseCssEasing(easing);
		return parsed ? resolveEasing(parsed) : { type: 'cubic-bezier', x1: 0, y1: 0, x2: 1, y2: 1 };
	}
	if (easing && typeof easing === 'object') {
		if (easing.type === 'spring') {
			return {
				type: 'spring',
				stiffness: finite(easing.stiffness, DEFAULT_SPRING.stiffness),
				damping: finite(easing.damping, DEFAULT_SPRING.damping),
				mass: finite(easing.mass, DEFAULT_SPRING.mass),
				velocity: finite(easing.velocity, DEFAULT_SPRING.velocity)
			};
		}
		if (easing.type === 'elastic') {
			return {
				type: 'elastic',
				amplitude: finite(easing.amplitude, DEFAULT_ELASTIC.amplitude),
				period: finite(easing.period, DEFAULT_ELASTIC.period),
				mode: easing.mode === 'in' || easing.mode === 'in-out' ? easing.mode : 'out'
			};
		}
		if (easing.type === 'cubic-bezier') {
			return {
				type: 'cubic-bezier',
				x1: clamp(finite(easing.x1, 0), 0, 1),
				y1: finite(easing.y1, 0),
				x2: clamp(finite(easing.x2, 1), 0, 1),
				y2: finite(easing.y2, 1)
			};
		}
	}
	return { type: 'cubic-bezier', x1: 0, y1: 0, x2: 1, y2: 1 };
}

/**
 * Eased progress for linear progress `u` (0–1) through a segment lasting `durationMs`
 * (springs depend on real time; other curves ignore it). `hold` returns 0 until `u` reaches 1.
 */
export function evaluateEasing(easing: AnimationEasing | string | undefined | null, u: number, durationMs = 1000): number {
	if (!(u > 0)) return 0;
	if (u >= 1) return 1;
	const resolved = resolveEasing(easing);
	if (resolved === 'hold') return 0;
	if (resolved.type === 'spring') return springAt(resolved, (u * Math.max(0, durationMs)) / 1000);
	if (resolved.type === 'elastic') return elasticAt(resolved, u);
	const { x1, y1, x2, y2 } = resolved;
	if (x1 === y1 && x2 === y2) return u; // linear
	return cubicBezierAt(x1, y1, x2, y2, u);
}

/**
 * The easing filmcraft (and Premiere) derive from temporal "influence" handles: flat handles of
 * the given influences (0.01–1, default 1/3) on the leaving and arriving keyframe.
 */
export function easingFromInfluence(outInfluence = 1 / 3, inInfluence = 1 / 3): CubicBezierEasing {
	return {
		type: 'cubic-bezier',
		x1: clamp(outInfluence, 0.01, 1),
		y1: 0,
		x2: 1 - clamp(inInfluence, 0.01, 1),
		y2: 1
	};
}

const NUMBER = String.raw`\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*`;
const CUBIC_RE = new RegExp(`^cubic-bezier\\(${NUMBER},${NUMBER},${NUMBER},${NUMBER}\\)$`, 'i');

/**
 * Parses a CSS easing (`linear`, `ease…`, `cubic-bezier(…)`, `steps(1, end)` / `step-end` →
 * hold) or a preset name. Returns `null` for anything else.
 */
export function parseCssEasing(text: string): AnimationEasing | null {
	const value = text.trim().toLowerCase();
	if (value.length > 200) return null;
	if ((ANIMATION_EASING_PRESETS as readonly string[]).includes(value)) return value as AnimationEasingPreset;
	if (value === 'step-end' || /^steps\(\s*1\s*(,\s*(end|jump-end)\s*)?\)$/.test(value)) return 'hold';
	const m = CUBIC_RE.exec(value);
	if (!m) return null;
	const [x1, y1, x2, y2] = m.slice(1).map(Number);
	if (![x1, y1, x2, y2].every(Number.isFinite) || x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return null;
	return { type: 'cubic-bezier', x1, y1, x2, y2 };
}

/** Whether a value is a usable easing (preset name, CSS easing string or descriptor). */
export function isAnimationEasing(value: unknown): value is AnimationEasing {
	if (typeof value === 'string') return parseCssEasing(value) !== null;
	if (typeof value !== 'object' || value === null) return false;
	const e = value as Record<string, unknown>;
	if (e.type === 'spring') return true;
	if (e.type === 'elastic') return true;
	return e.type === 'cubic-bezier' && [e.x1, e.y1, e.x2, e.y2].every((v) => typeof v === 'number' && Number.isFinite(v));
}

const round = (v: number, digits = 4) => {
	const p = 10 ** digits;
	return Math.round(v * p) / p;
};

/**
 * The CSS `animation-timing-function` for an easing: a keyword or `cubic-bezier()`,
 * `steps(1, end)` for hold, and a sampled `linear(…)` for springs over `durationMs`.
 */
export function easingToCss(easing: AnimationEasing | string | undefined | null, durationMs = 1000, samples = 24): string {
	const resolved = resolveEasing(easing);
	if (resolved === 'hold') return 'steps(1, end)';
	if (resolved.type === 'spring') {
		const n = Math.max(2, Math.floor(samples));
		const points: string[] = [];
		for (let i = 0; i <= n; i++) points.push(String(round(i === n ? 1 : springAt(resolved, ((i / n) * durationMs) / 1000))));
		return `linear(${points.join(', ')})`;
	}
	if (resolved.type === 'elastic') {
		const n = Math.max(2, Math.floor(samples));
		const points: string[] = [];
		for (let i = 0; i <= n; i++) points.push(String(round(i === n ? 1 : elasticAt(resolved, i / n))));
		return `linear(${points.join(', ')})`;
	}
	const { x1, y1, x2, y2 } = resolved;
	for (const [name, p] of Object.entries(CUBIC_BEZIER_PRESETS)) {
		if (['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'].includes(name) && p[0] === x1 && p[1] === y1 && p[2] === x2 && p[3] === y2) {
			return name;
		}
	}
	return `cubic-bezier(${round(x1)}, ${round(y1)}, ${round(x2)}, ${round(y2)})`;
}

/** Short label for an easing (a preset's label, or `Custom` / `Spring` / `Elastic`). */
export function easingLabel(easing: AnimationEasing | undefined | null): string {
	if (easing === undefined || easing === null) return ANIMATION_EASING_LABELS.linear;
	if (typeof easing === 'string') return ANIMATION_EASING_LABELS[easing as AnimationEasingPreset] ?? easing;
	if (easing.type === 'spring') return 'Spring';
	if (easing.type === 'elastic') return 'Elastic';
	return 'Custom';
}
