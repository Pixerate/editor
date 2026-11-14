import { describe, it, expect } from 'vitest';
import { fbm2, fbm3, heightfield, noise2, noise3 } from '../src/geom';

const grid = (n: number) => Array.from({ length: n }, (_, i) => (i - n / 2) * 0.173 + 0.011);

describe('noise', () => {
	it('stays within [-1, 1], is zero on lattice points (gradient), and is the same for the same seed', () => {
		let lo = Infinity, hi = -Infinity;
		for (const x of grid(60)) for (const y of grid(60)) {
			for (const v of [noise2(x, y), noise2(x, y, { kind: 'value' }), noise3(x, y, x - y), noise3(x, y, 0.5, { kind: 'value' })]) {
				lo = Math.min(lo, v);
				hi = Math.max(hi, v);
			}
		}
		expect(lo).toBeGreaterThanOrEqual(-1);
		expect(hi).toBeLessThanOrEqual(1);
		// It uses the range, not a sliver of it.
		expect(hi - lo).toBeGreaterThan(1);
		expect(noise2(3, -7)).toBe(0);
		expect(noise3(1, 2, 3)).toBe(0);
		expect(noise2(0.3, 0.7, { seed: 9 })).toBe(noise2(0.3, 0.7, { seed: 9 }));
		expect(noise2(0.3, 0.7, { seed: 9 })).not.toBe(noise2(0.3, 0.7, { seed: 10 }));
	});

	it('is continuous: nearby points give nearby values', () => {
		for (const x of grid(30)) for (const y of grid(30)) {
			expect(Math.abs(noise2(x, y) - noise2(x + 1e-4, y))).toBeLessThan(1e-3);
			expect(Math.abs(noise3(x, y, 0.4, { kind: 'value' }) - noise3(x, y + 1e-4, 0.4, { kind: 'value' }))).toBeLessThan(1e-3);
		}
	});

	it('handles negative and very large coordinates', () => {
		for (const v of [noise2(-1e6 - 0.5, 3.25), noise2(1e9 + 0.25, -1e9 + 0.75), noise3(-123456.5, 0.5, 98765.25)]) {
			expect(Number.isFinite(v)).toBe(true);
			expect(Math.abs(v)).toBeLessThanOrEqual(1);
		}
	});

	it('sums octaves into fbm that stays within its bounds', () => {
		for (const x of grid(40)) for (const y of grid(40)) {
			for (const v of [fbm2(x, y), fbm2(x, y, { octaves: 8, gain: 0.7, lacunarity: 2.3, kind: 'value' }), fbm3(x, y, 0.2, { octaves: 6 })]) {
				expect(v).toBeGreaterThanOrEqual(-1);
				expect(v).toBeLessThanOrEqual(1);
			}
		}
		// One octave is plain noise.
		expect(fbm2(0.3, 0.6, { octaves: 1, seed: 4 })).toBe(noise2(0.3, 0.6, { seed: 4 }));
	});
});

describe('heightfield', () => {
	const solid = () => heightfield((x, z) => 1 + 0.3 * fbm2(x * 2, z * 2, { seed: 3 }), { x0: 0, x1: 4, z0: 0, z1: 1, resolution: [20, 5] });

	it('is watertight: every edge is shared by exactly two triangles, once each way', () => {
		const f = solid();
		const directed = new Map<string, number>();
		for (let t = 0; t < f.indices.length; t += 3) {
			const tri = [f.indices[t]!, f.indices[t + 1]!, f.indices[t + 2]!];
			for (let e = 0; e < 3; e++) {
				const key = `${tri[e]}>${tri[(e + 1) % 3]}`;
				directed.set(key, (directed.get(key) ?? 0) + 1);
			}
		}
		for (const [key, n] of directed) {
			expect(n, key).toBe(1);
			const [a, b] = key.split('>');
			expect(directed.get(`${b}>${a}`), `${key} has no twin`).toBe(1);
		}
		expect(f.columns * f.rows * 2 * 3).toBe(f.positions.length);
	});

	it('faces out: the top normals point up, the floor down, and the volume is positive', () => {
		const f = solid();
		const top = f.columns * f.rows;
		for (let v = 0; v < top; v++) if (v % f.columns > 0 && v % f.columns < f.columns - 1 && Math.floor(v / f.columns) > 0 && Math.floor(v / f.columns) < f.rows - 1) expect(f.normals[v * 3 + 1]!).toBeGreaterThan(0.5);
		expect(f.normals[(top + 2 * f.columns + 10) * 3 + 1]!).toBeLessThan(-0.5);
		// Signed volume from the divergence theorem: positive when every face faces out.
		let volume = 0;
		for (let t = 0; t < f.indices.length; t += 3) {
			const [a, b, c] = [f.indices[t]! * 3, f.indices[t + 1]! * 3, f.indices[t + 2]! * 3];
			const p = f.positions;
			volume += (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6;
		}
		expect(volume).toBeGreaterThan(3);
		expect(volume).toBeLessThan(5.3);
	});

	it('raises heights below the floor to it, and keeps the heights it drew', () => {
		const f = heightfield((x) => x - 1, { x0: 0, x1: 2, z0: 0, z1: 1, resolution: [2, 1], base: 0 });
		expect([...f.heights]).toEqual([0, 0, 1, 0, 0, 1]);
	});
});
