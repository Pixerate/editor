/**
 * Seeded, portable noise (#807): value and gradient noise in 2-D and 3-D and fractal sums (fbm),
 * for surfaces that carry texture or relief without carrying data. Only integer hashing and plain
 * arithmetic (no trig, no tables built at load), so the Swift port (`PixerateGeometry/Noise.swift`)
 * gives the same numbers bit for bit; shared fixtures pin it. Every result is within [-1, 1].
 */

export type NoiseKind = 'gradient' | 'value';

export interface NoiseOptions {
	/** Any integer; the same seed gives the same field (default 0). */
	seed?: number;
	/** `gradient` (smooth, Perlin-like, default) or `value` (softer, blotchier). */
	kind?: NoiseKind;
}

export interface FbmOptions extends NoiseOptions {
	/** Layers of noise added together (1–12, default 4). */
	octaves?: number;
	/** Frequency multiplier from one octave to the next (default 2). */
	lacunarity?: number;
	/** Amplitude multiplier from one octave to the next (default 0.5). */
	gain?: number;
}

/** A 32-bit hash of integer lattice coordinates and a seed (avalanche from murmur3's finaliser). */
function hash(x: number, y: number, z: number, seed: number): number {
	let h = (seed | 0) ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x1b873593);
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

/** The lattice cell below `v` as a 32-bit integer (wrapping far from the origin). */
const cellOf = (v: number) => Math.floor(v) | 0;

/** Smootherstep: 6t⁵ − 15t⁴ + 10t³, so the field is smooth across cells. */
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp1 = (v: number) => (v > 1 ? 1 : v < -1 ? -1 : v);

/** A lattice value in [-1, 1]. */
const latticeValue = (h: number) => (h / 4294967295) * 2 - 1;

/** 2-D gradients: the eight directions to the corners and edges of a square. */
function grad2(h: number, x: number, y: number): number {
	switch (h & 7) {
		case 0:
			return x + y;
		case 1:
			return -x + y;
		case 2:
			return x - y;
		case 3:
			return -x - y;
		case 4:
			return x;
		case 5:
			return -x;
		case 6:
			return y;
		default:
			return -y;
	}
}

/** 3-D gradients: the twelve directions to a cube's edges (Perlin's), four repeated to make sixteen. */
function grad3(h: number, x: number, y: number, z: number): number {
	switch (h & 15) {
		case 0:
		case 12:
			return x + y;
		case 1:
		case 13:
			return -x + y;
		case 2:
			return x - y;
		case 3:
			return -x - y;
		case 4:
			return x + z;
		case 5:
			return -x + z;
		case 6:
			return x - z;
		case 7:
			return -x - z;
		case 8:
			return y + z;
		case 9:
		case 14:
			return -y + z;
		case 10:
			return y - z;
		default:
			return -y - z;
	}
}

/** Noise at (x, y), in [-1, 1]. */
export function noise2(x: number, y: number, options: NoiseOptions = {}): number {
	const seed = options.seed ?? 0;
	const xi = cellOf(x);
	const yi = cellOf(y);
	const xf = x - Math.floor(x);
	const yf = y - Math.floor(y);
	const u = fade(xf);
	const v = fade(yf);
	if (options.kind === 'value') {
		const a = latticeValue(hash(xi, yi, 0, seed));
		const b = latticeValue(hash(xi + 1, yi, 0, seed));
		const c = latticeValue(hash(xi, yi + 1, 0, seed));
		const d = latticeValue(hash(xi + 1, yi + 1, 0, seed));
		return clamp1(lerp(lerp(a, b, u), lerp(c, d, u), v));
	}
	const a = grad2(hash(xi, yi, 0, seed), xf, yf);
	const b = grad2(hash(xi + 1, yi, 0, seed), xf - 1, yf);
	const c = grad2(hash(xi, yi + 1, 0, seed), xf, yf - 1);
	const d = grad2(hash(xi + 1, yi + 1, 0, seed), xf - 1, yf - 1);
	return clamp1(lerp(lerp(a, b, u), lerp(c, d, u), v));
}

/** Noise at (x, y, z), in [-1, 1]. */
export function noise3(x: number, y: number, z: number, options: NoiseOptions = {}): number {
	const seed = options.seed ?? 0;
	const xi = cellOf(x);
	const yi = cellOf(y);
	const zi = cellOf(z);
	const xf = x - Math.floor(x);
	const yf = y - Math.floor(y);
	const zf = z - Math.floor(z);
	const u = fade(xf);
	const v = fade(yf);
	const w = fade(zf);
	const corner = (dx: number, dy: number, dz: number) => {
		const h = hash(xi + dx, yi + dy, zi + dz, seed);
		return options.kind === 'value' ? latticeValue(h) : grad3(h, xf - dx, yf - dy, zf - dz);
	};
	const x00 = lerp(corner(0, 0, 0), corner(1, 0, 0), u);
	const x10 = lerp(corner(0, 1, 0), corner(1, 1, 0), u);
	const x01 = lerp(corner(0, 0, 1), corner(1, 0, 1), u);
	const x11 = lerp(corner(0, 1, 1), corner(1, 1, 1), u);
	return clamp1(lerp(lerp(x00, x10, v), lerp(x01, x11, v), w));
}

function fbmSum(octaves: number, lacunarity: number, gain: number, sample: (frequency: number, octave: number) => number): number {
	let sum = 0;
	let norm = 0;
	let amplitude = 1;
	let frequency = 1;
	for (let o = 0; o < octaves; o++) {
		sum += amplitude * sample(frequency, o);
		norm += amplitude;
		amplitude *= gain;
		frequency *= lacunarity;
	}
	return norm > 0 ? clamp1(sum / norm) : 0;
}

const octavesOf = (o: FbmOptions) => Math.min(12, Math.max(1, Math.floor(o.octaves ?? 4)));

/**
 * Fractal noise at (x, y): `octaves` layers of noise, each at `lacunarity` times the frequency
 * and `gain` times the amplitude of the one before (each octave with its own seed), normalised so
 * the result stays within [-1, 1].
 */
export function fbm2(x: number, y: number, options: FbmOptions = {}): number {
	const seed = options.seed ?? 0;
	return fbmSum(octavesOf(options), options.lacunarity ?? 2, options.gain ?? 0.5, (f, o) => noise2(x * f, y * f, { seed: seed + o * 1013, kind: options.kind }));
}

/** Fractal noise at (x, y, z), as `fbm2`. */
export function fbm3(x: number, y: number, z: number, options: FbmOptions = {}): number {
	const seed = options.seed ?? 0;
	return fbmSum(octavesOf(options), options.lacunarity ?? 2, options.gain ?? 0.5, (f, o) => noise3(x * f, y * f, z * f, { seed: seed + o * 1013, kind: options.kind }));
}
