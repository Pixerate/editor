import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createChartSpec, layoutChartParticles, settleFrame, settleParticles } from '../src/chart';
import { createChart3dScene } from '../src/three';

const pile = (extra: Partial<Parameters<typeof settleParticles>[0]> = {}) =>
	settleParticles({ container: { width: 4, depth: 2 }, layers: [{ count: 300, label: 'A' }, { count: 450, label: 'B' }, { count: 120, label: 'C' }], size: 0.18, ...extra });

describe('settleParticles', () => {
	it('packs every particle inside the container with no two overlapping', () => {
		const s = pile();
		expect(s.count).toBe(870);
		const r = s.size / 2;
		for (let i = 0; i < s.count; i++) {
			const [x, y, z] = [s.positions[i * 3]!, s.positions[i * 3 + 1]!, s.positions[i * 3 + 2]!];
			expect(x - r).toBeGreaterThanOrEqual(-1e-9);
			expect(x + r).toBeLessThanOrEqual(4 + 1e-9);
			expect(z - r).toBeGreaterThanOrEqual(-1e-9);
			expect(z + r).toBeLessThanOrEqual(2 + 1e-9);
			expect(y - r).toBeGreaterThanOrEqual(-1e-9);
		}
		let closest = Infinity;
		for (let i = 0; i < s.count; i++)
			for (let j = i + 1; j < s.count; j++) {
				const dx = s.positions[i * 3]! - s.positions[j * 3]!;
				const dy = s.positions[i * 3 + 1]! - s.positions[j * 3 + 1]!;
				const dz = s.positions[i * 3 + 2]! - s.positions[j * 3 + 2]!;
				closest = Math.min(closest, Math.hypot(dx, dy, dz));
			}
		expect(closest).toBeGreaterThanOrEqual(s.size - 1e-9);
	});

	it('settles the same way for the same seed, and differently for another', () => {
		expect([...pile().positions]).toEqual([...pile().positions]);
		expect([...pile({ seed: 2 }).positions]).not.toEqual([...pile().positions]);
		// A neat grid with no wander.
		const neat = pile({ jitter: 0 });
		expect(neat.positions[1]).toBeCloseTo(neat.cell / 2, 12);
	});

	it('stacks layers in order and reports each one’s band, thickness and fill', () => {
		const s = pile();
		expect(s.perLevel).toBe(Math.floor(4 / s.cell) * Math.floor(2 / s.cell));
		expect(s.layers.map((l) => [l.label, l.start, l.count])).toEqual([['A', 0, 300], ['B', 300, 450], ['C', 750, 120]]);
		for (let k = 1; k < s.layers.length; k++) expect(s.layers[k]!.bottom).toBeGreaterThanOrEqual(s.layers[k - 1]!.bottom);
		for (const l of s.layers) {
			expect(l.thickness).toBeCloseTo(l.top - l.bottom, 12);
			expect(l.fill).toBeGreaterThan(0);
			expect(l.fill).toBeLessThanOrEqual(1);
		}
		expect(s.levels).toBe(Math.ceil(870 / s.perLevel));
		expect([...s.layerOf.slice(298, 302)]).toEqual([0, 0, 1, 1]);
	});

	it('counts what does not fit under the height, and refuses a container too small', () => {
		const s = settleParticles({ container: { width: 1, depth: 1, height: 0.5 }, layers: [{ count: 1000 }], size: 0.2 });
		expect(s.count).toBe(s.perLevel * 2);
		expect(s.overflow).toBe(1000 - s.count);
		expect(() => settleParticles({ container: { width: 0.1, depth: 1 }, layers: [{ count: 1 }], size: 0.2 })).toThrow(/too small for particles of size 0\.2/);
		expect(() => settleParticles({ container: { width: 1, depth: 1 }, layers: [], size: 0 })).toThrow('size must be a positive length (got 0).');
	});

	it('settles 50,000 particles and frames them within the budget', () => {
		const t0 = performance.now();
		const s = settleParticles({ container: { width: 10, depth: 6 }, layers: [{ count: 20000 }, { count: 30000 }], size: 0.05 });
		const t1 = performance.now();
		const out = new Float32Array(s.count * 3);
		settleFrame(s, 0.5, { out });
		const t2 = performance.now();
		expect(s.count).toBe(50000);
		expect(t1 - t0).toBeLessThan(400);
		expect(t2 - t1).toBeLessThan(60);
	});
});

describe('settleFrame', () => {
	it('is exactly the rest at p = 1, empty at p = 0, and depends on p alone', () => {
		const s = pile();
		const rest = settleFrame(s, 1);
		expect([...rest.positions]).toEqual([...Float32Array.from(s.positions)]);
		expect(rest.visible.every((v) => v === 1)).toBe(true);
		expect(settleFrame(s, 0).visible.every((v) => v === 0)).toBe(true);
		const a = settleFrame(s, 0.4);
		expect([...settleFrame(s, 0.4).positions]).toEqual([...a.positions]);
		expect([...settleFrame(s, 1.5).positions]).toEqual([...rest.positions]);
	});

	it('drops particles in order, each from above its rest, and the last still falls near the end', () => {
		const s = pile();
		const mid = settleFrame(s, 0.4);
		const shown = [...mid.visible].lastIndexOf(1);
		expect(shown).toBeGreaterThan(0);
		expect(shown).toBeLessThan(s.count - 1);
		expect([...mid.visible.slice(0, shown)].every((v) => v === 1)).toBe(true);
		for (let i = 0; i < s.count; i++) expect(mid.positions[i * 3 + 1]!).toBeGreaterThanOrEqual(Math.fround(s.positions[i * 3 + 1]!) - 1e-6);
		const late = settleFrame(s, 0.97);
		const last = s.count - 1;
		expect(late.positions[last * 3 + 1]!).toBeGreaterThan(s.positions[last * 3 + 1]! + 0.01);
	});
});

describe('layoutChartParticles', () => {
	const spec = createChartSpec({ type: 'bar', title: 'Traffic', categories: ['Search', 'Direct', 'Social', 'Email'], series: [{ id: 's', name: 'Visits', values: [4600, 2700, 1700, 1000] }] } as never);

	it('turns each category into a layer, one grain per unit, rounded', () => {
		const p = layoutChartParticles(spec, { unit: 50 });
		expect(p.settled.layers.map((l) => [l.label, l.count])).toEqual([['Search', 92], ['Direct', 54], ['Social', 34], ['Email', 20]]);
		expect(p.labels[0]).toBe('Search · 4,600 (92 grains)');
		expect(p.notes[0]).toBe('One grain is 50 of Visits; values are rounded to whole grains.');
		expect(p.categories).toEqual([0, 1, 2, 3]);
	});

	it('picks a round unit for about 600 grains by default, and orders layers as asked', () => {
		const p = layoutChartParticles(spec);
		expect(p.unit).toBe(20);
		expect(layoutChartParticles(spec, { unit: 100, order: 'smallest-first' }).categories).toEqual([3, 2, 1, 0]);
		expect(layoutChartParticles(spec, { unit: 100, order: 'largest-first' }).categories).toEqual([0, 1, 2, 3]);
		expect(() => layoutChartParticles(spec, { unit: 0 })).toThrow('unit must be a positive number (got 0).');
	});
});

describe('particles in a 3-D chart', () => {
	const spec = createChartSpec({ type: 'bar', categories: ['A', 'B', 'C'], series: [{ id: 's', name: 'S', values: [30, 50, 20] }], view3d: { azimuth: 20, elevation: 25, depth: 1 } } as never);
	const view = () => createChart3dScene(spec, { width: 640, height: 400, particles: { unit: 1 } });
	const grains = (v: ReturnType<typeof view>) => v.scene.getObjectByName('particles') as THREE.InstancedMesh;

	it('draws one instanced mesh with a colour per layer, an outline, and a label beside each layer', () => {
		const v = view();
		const g = grains(v);
		expect(g.count).toBe(100);
		expect(v.scene.getObjectByName('outline')).toBeTruthy();
		expect(v.scene.getObjectByName('chart')!.children.some((c) => c.name.startsWith('bar-'))).toBe(false);
		const a = new THREE.Color();
		const b = new THREE.Color();
		g.getColorAt(0, a);
		g.getColorAt(99, b);
		expect(a.getHexString()).not.toBe(b.getHexString());
		expect(v.labels().filter((l) => l.kind === 'category').map((l) => [l.text, l.index])).toEqual([['A · 30 (30 grains)', 0], ['B · 50 (50 grains)', 1], ['C · 20 (20 grains)', 2]]);
		v.dispose();
	});

	it('drops the grains in with setProgress: hidden at 0, at rest at 1', () => {
		const v = view();
		const g = grains(v);
		const m = new THREE.Matrix4();
		v.setProgress(0);
		g.getMatrixAt(50, m);
		expect(new THREE.Vector3().setFromMatrixScale(m).x).toBe(0);
		v.setProgress(1);
		g.getMatrixAt(50, m);
		const at = new THREE.Vector3().setFromMatrixPosition(m);
		const s = v.particles!.settled;
		expect([at.x, at.y, at.z]).toEqual([Math.fround(s.positions[150]!), Math.fround(s.positions[151]!), Math.fround(s.positions[152]!)].map((n) => expect.closeTo(n, 5)));
		v.dispose();
	});

	it('picks the grain under the pointer as a point in its category, with the instance', () => {
		const v = view();
		for (const index of [0, 1, 2]) {
			const at = v.anchor({ kind: 'point', seriesId: 's', index })!;
			const hit = v.pick(at.x, at.y);
			expect(hit, `layer ${index}`).toMatchObject({ kind: 'point', seriesId: 's', index });
			expect(typeof hit!.instance).toBe('number');
			const layer = v.particles!.settled.layerOf[hit!.instance!]!;
			expect(v.particles!.categories[layer]).toBe(index);
		}
		v.dispose();
	});

	it('focuses a layer: its grains keep their colours, the others fade', () => {
		const v = view();
		const g = grains(v);
		const before = [0, 50, 99].map((i) => {
			const c = new THREE.Color();
			g.getColorAt(i, c);
			return c.getHexString();
		});
		v.focus({ kind: 'point', seriesId: 's', index: 1 });
		const after = [0, 50, 99].map((i) => {
			const c = new THREE.Color();
			g.getColorAt(i, c);
			return c.getHexString();
		});
		expect(after[1]).toBe(before[1]);
		expect(after[0]).not.toBe(before[0]);
		expect(after[2]).not.toBe(before[2]);
		expect(v.labels().find((l) => l.focused)?.index).toBe(1);
		v.dispose();
	});
});
