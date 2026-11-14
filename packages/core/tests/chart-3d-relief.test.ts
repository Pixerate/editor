import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createChartSpec } from '../src/chart';
import { createChart3dScene } from '../src/three';

const spec = () =>
	createChartSpec({
		type: 'area',
		categories: ['Jan', 'Feb', 'Mar', 'Apr', 'May'],
		series: [
			{ id: 'a', name: 'A', values: [20, 35, 30, 45, 40] },
			{ id: 'b', name: 'B', values: [10, 12, 18, 15, 22] }
		],
		view3d: { azimuth: 25, elevation: 25, depth: 1.5 }
	} as never);

const tops = (view: ReturnType<typeof createChart3dScene>, name: string) => {
	const g = (view.scene.getObjectByName(name) as THREE.Mesh).geometry;
	return Array.from((g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array);
};

describe('relief on 3-D areas', () => {
	it('sculpts area tops as watertight heightfields, and states and measures the thickness error', () => {
		const plain = createChart3dScene(spec(), { width: 640, height: 400 });
		const view = createChart3dScene(spec(), { width: 640, height: 400, relief: { amount: 0.05, seed: 7 } });
		expect((view.scene.getObjectByName('area-a') as THREE.Mesh).geometry.index).not.toBeNull();
		expect((plain.scene.getObjectByName('area-a') as THREE.Mesh).geometry.type).toBe('ExtrudeGeometry');
		expect(view.relief!.amount).toBe(0.05);
		expect(view.relief!.error).toBeGreaterThan(0.01);
		expect(view.relief!.error).toBeLessThanOrEqual(0.05 + 1e-12);
		expect(plain.relief).toBeUndefined();
		plain.dispose();
		view.dispose();
	});

	it('caps the amount at a quarter, and is the same for the same seed', () => {
		const big = createChart3dScene(spec(), { width: 640, height: 400, relief: { amount: 3 } });
		expect(big.relief!.amount).toBe(0.25);
		expect(big.relief!.error).toBeLessThanOrEqual(0.25 + 1e-12);
		const a = createChart3dScene(spec(), { width: 640, height: 400, relief: { seed: 2 } });
		const b = createChart3dScene(spec(), { width: 640, height: 400, relief: { seed: 2 } });
		expect(tops(a, 'area-a')).toEqual(tops(b, 'area-a'));
		const c = createChart3dScene(spec(), { width: 640, height: 400, relief: { seed: 3 } });
		expect(tops(c, 'area-a')).not.toEqual(tops(a, 'area-a'));
	});

	it('grows the relief in with setProgress: flat at 0, sculpted at 1, depending on p alone', () => {
		const view = createChart3dScene(spec(), { width: 640, height: 400, relief: { amount: 0.08 } });
		const sculpted = tops(view, 'area-a');
		view.setProgress(0);
		const flat = tops(view, 'area-a');
		expect(flat).not.toEqual(sculpted);
		view.setProgress(0.5);
		const half = tops(view, 'area-a');
		view.setProgress(0.5);
		expect(tops(view, 'area-a')).toEqual(half);
		view.setProgress(1);
		expect(tops(view, 'area-a')).toEqual(sculpted);
		view.dispose();
	});

	it('still picks and focuses a sculpted area', () => {
		const view = createChart3dScene(spec(), { width: 640, height: 400, relief: {} });
		const at = view.anchor({ kind: 'point', seriesId: 'a', index: 2 })!;
		expect(view.pick(at.x, at.y + 4)).toMatchObject({ kind: 'point', seriesId: 'a', index: 2 });
		view.dispose();
	});
});
