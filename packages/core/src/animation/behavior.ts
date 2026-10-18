/**
 * Behaviours: how a change gets from `from` to `to` other than straight along its ease (a
 * pulse there and back, an oscillation, a seeded wriggle, a springy overshoot). Ported from
 * `@pixerate/flair` (MIT): `SvgBehavior` and `behaviorProgress` in `vector/motion.ts`, the
 * oscillate and overshoot evaluators in `scene/behavior.ts` and the noise in `time/noise.ts`.
 * The numbers must stay identical to Flair's, so a behaviour exported to Flair plays the same
 * frames there as here (the animation editor writes them as Flair `behavior`s, Flair ≥ 0.38).
 */

/**
 * A behaviour: its progress `u` at each moment, where 0 is `from`, 1 is `to`, and numbers go
 * past either. `t` is the change's time, 0–1, through its ease (linear unless given).
 *
 * - `pulse`: there and back `count` times (default 1): u = sin²(π·count·t).
 * - `oscillate`: swings round `from`, out to `to` and as far the other way, `count` times
 *   (default 1), dying away by (1 − t)^`decay` (default 0, no decay).
 * - `wriggle`: wanders round `from` by up to about `to − from`, as seeded smooth fractal noise
 *   at `frequency` Hz (default 2) with `octaves` layers (default 2); each number in a value
 *   wanders on its own channel. It eases out of and back to rest over the first and last 15%
 *   of its time. The same `seed` (default 42) gives the same wander.
 * - `overshoot`: goes to `to`, past it and back, settling like a spring:
 *   u = 1 − e^(−damping·t)·cos(cycles·π·t) (default 3 cycles, damping 4).
 */
export type MotionBehavior =
	| { type: 'pulse'; count?: number }
	| { type: 'oscillate'; count?: number; decay?: number; wave?: 'sine' | 'triangle' | 'square' | 'sawtooth' }
	| { type: 'wriggle'; frequency?: number; octaves?: number; seed?: number }
	| { type: 'overshoot'; cycles?: number; damping?: number };

/** Every `MotionBehavior` type. */
export const MOTION_BEHAVIORS = ['pulse', 'oscillate', 'wriggle', 'overshoot'] as const;

/** Share of a wriggle's time spent easing out of and back to rest, at each end. */
const WRIGGLE_EDGE = 0.15;

function wave(kind: 'sine' | 'triangle' | 'square' | 'sawtooth' | undefined, angle: number): number {
	switch (kind) {
		case 'square':
			return Math.sin(angle) >= 0 ? 1 : -1;
		case 'triangle':
			return (2 / Math.PI) * Math.asin(Math.sin(angle));
		case 'sawtooth': {
			const norm = (angle / (2 * Math.PI)) % 1;
			return 2 * (norm < 0 ? norm + 1 : norm) - 1;
		}
		default:
			return Math.sin(angle);
	}
}

/**
 * A behaviour's progress at `t` (0–1, eased) of a change lasting `ms`, for the `index`-th number
 * in a value (only a wriggle tells numbers apart).
 */
export function behaviorProgress(behavior: MotionBehavior, t: number, index = 0, ms = 800): number {
	const time = Math.max(0, t);
	switch (behavior.type) {
		case 'pulse':
			// sin²(πct) = (1 − cos 2πct) / 2: written as Flair writes it, so the numbers match.
			return 0.5 + 0.5 * Math.sin(2 * Math.PI * (behavior.count ?? 1) * time - Math.PI / 2);
		case 'oscillate': {
			const w = wave(behavior.wave, 2 * Math.PI * (behavior.count ?? 1) * time);
			const decay = behavior.decay ?? 0;
			return decay > 0 ? w * Math.max(0, 1 - t) ** decay : w;
		}
		case 'wriggle': {
			const edge = quinticFade(Math.min(1, Math.max(0, Math.min(t, 1 - t) / WRIGGLE_EDGE)));
			if (edge === 0) return 0;
			return edge * fractalWiggle(behavior.frequency ?? 2, 1, behavior.octaves ?? 2, 0.5, (t * ms) / 1000, behavior.seed ?? 42, index);
		}
		case 'overshoot': {
			const p = Math.min(1, time);
			if (p >= 1) return 1;
			return 1 - Math.exp(-(behavior.damping ?? 4) * p) * Math.cos((behavior.cycles ?? 3) * Math.PI * p);
		}
	}
}

/** Whether `value` is a well-formed `MotionBehavior`. */
export function isMotionBehavior(value: unknown): value is MotionBehavior {
	if (typeof value !== 'object' || value === null) return false;
	const b = value as Record<string, unknown>;
	const positive = (k: string) => b[k] === undefined || (typeof b[k] === 'number' && Number.isFinite(b[k]) && (b[k] as number) > 0);
	const atLeastZero = (k: string) => b[k] === undefined || (typeof b[k] === 'number' && Number.isFinite(b[k]) && (b[k] as number) >= 0);
	switch (b.type) {
		case 'pulse':
			return positive('count');
		case 'oscillate':
			return positive('count') && atLeastZero('decay') && (b.wave === undefined || ['sine', 'triangle', 'square', 'sawtooth'].includes(b.wave as string));
		case 'wriggle':
			return positive('frequency') && positive('octaves') && (b.seed === undefined || Number.isInteger(b.seed));
		case 'overshoot':
			return positive('cycles') && atLeastZero('damping');
		default:
			return false;
	}
}

/** A seed from an id (FNV-1a), so each element wriggles its own way: Flair's `seedOf`. */
export function motionSeedFromId(id: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
	return (h >>> 0) % 2147483647 || 1;
}

// ── Noise (SplitMix64 hashing, quintic value noise), as Flair's `time/noise.ts` ─────────────

const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;
const MULT1 = 0xbf58476d1ce4e5b9n;
const MULT2 = 0x94d049bb133111ebn;
const MASK64 = 0xffffffffffffffffn;
const BASE_MIX = 0x2545f4914f6cdd1dn;
const POW2_53 = 9007199254740992;

function hash64(x: bigint): bigint {
	let v = (x + GOLDEN_GAMMA) & MASK64;
	v = ((v ^ (v >> 30n)) * MULT1) & MASK64;
	v = ((v ^ (v >> 27n)) * MULT2) & MASK64;
	return (v ^ (v >> 31n)) & MASK64;
}

function mixSeeds(parts: (bigint | number)[]): bigint {
	let h = BASE_MIX;
	for (const p of parts) {
		const val = typeof p === 'bigint' ? p : BigInt(Math.floor(p));
		h = hash64(h ^ hash64(val & MASK64));
	}
	return h;
}

function unitFloat(seed: bigint): number {
	return Number(hash64(seed) >> 11n) / POW2_53;
}

/** 6t⁵ − 15t⁴ + 10t³: zero slope and curvature at 0 and 1. */
export function quinticFade(t: number): number {
	return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

function noise1d(seed: bigint, x: number): number {
	if (!Number.isFinite(x)) return 0;
	const floorX = Math.floor(x);
	const u = quinticFade(x - floorX);
	const i = BigInt(floorX);
	const a = unitFloat(seed ^ hash64(i & MASK64)) * 2 - 1;
	const b = unitFloat(seed ^ hash64((i + 1n) & MASK64)) * 2 - 1;
	return a + (b - a) * u;
}

/**
 * Multi-octave smooth noise (After Effects' `wiggle`): the sum over `octaves` of
 * amp·ampMult^k · noise(freq·2^k·t), each octave and `dimension` seeded apart. `t` in seconds.
 */
export function fractalWiggle(freq: number, amp: number, octaves = 3, ampMult = 0.5, t = 0, seed = 42, dimension = 0): number {
	const oct = Math.max(1, Math.min(16, Math.floor(octaves)));
	let currentAmp = amp;
	let currentFreq = freq;
	let sum = 0;
	const baseSeed = BigInt(Math.floor(seed));
	for (let k = 0; k < oct; k++) {
		const s = mixSeeds([baseSeed, BigInt(dimension), BigInt(k)]);
		const phaseOffset = unitFloat(s) * 1000.0;
		sum += currentAmp * noise1d(s, currentFreq * t + phaseOffset);
		currentAmp *= ampMult;
		currentFreq *= 2.0;
	}
	return sum;
}
