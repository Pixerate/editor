import { describe, it, expect } from 'vitest';
import { ChartController, chartToOoxml, createChartToolProvider } from '../src/chart';
import { ToolRegistry } from '../src/tools';
import { createChart3dScene } from '../src/three';

const registry = (type = 'bar') => {
	const controller = new ChartController({ spec: { type, categories: ['A', 'B', 'C'], series: [{ id: 's', name: 'S', values: [30, 50, 20] }] } });
	const r = new ToolRegistry();
	r.register(createChartToolProvider(controller, { id: 'chart' }));
	return { r, controller };
};

describe('update_chart view3d particles and relief', () => {
	it('sets them, merges later changes, and turns each off with null', async () => {
		const { r, controller } = registry();
		await r.callTool('chart__update_chart', { view3d: { particles: { unit: 5, order: 'largest-first' }, relief: { amount: 0.05 } } });
		expect(controller.getSpec().view3d).toMatchObject({ particles: { unit: 5, order: 'largest-first' }, relief: { amount: 0.05 } });
		await r.callTool('chart__update_chart', { view3d: { particles: { order: 'smallest-first' } } });
		expect(controller.getSpec().view3d!.particles).toEqual({ unit: 5, order: 'smallest-first' });
		await r.callTool('chart__update_chart', { view3d: { particles: null } });
		expect(controller.getSpec().view3d!.particles).toBeUndefined();
		expect(controller.getSpec().view3d!.relief).toEqual({ amount: 0.05 });
		const json = (await r.callTool('chart__get_chart', {})).structuredContent as { spec: { view3d: unknown } };
		expect(json.spec.view3d).toMatchObject({ relief: { amount: 0.05 } });
	});

	it('refuses values out of range with messages that say what fits, changing nothing', async () => {
		const { r, controller } = registry();
		const before = controller.getSpec();
		const bad = await r.callTool('chart__update_chart', { view3d: { relief: { amount: 0.5 } } });
		expect(bad.isError).toBe(true);
		expect(controller.getSpec()).toEqual(before);
		const loaded = new ChartController({ spec: { type: 'bar', categories: ['A'], series: [{ id: 's', name: 'S', values: [1] }], view3d: { particles: { unit: 0, order: 'up' }, relief: { octaves: 1.5 }, glow: 1 } } });
		expect(loaded.getSpec().view3d).toEqual({ azimuth: 20, elevation: 15, depth: 1, particles: {}, relief: {} });
	});

	it('is what the 3-D scene draws, unless the host passes its own', () => {
		const { controller } = registry('area');
		controller.update({ view3d: { particles: { unit: 10 } } });
		const piled = createChart3dScene(controller.getSpec(), { width: 400, height: 300 });
		expect(piled.particles?.unit).toBe(10);
		controller.update({ view3d: { particles: null, relief: { amount: 0.08 } } });
		const sculpted = createChart3dScene(controller.getSpec(), { width: 400, height: 300 });
		expect(sculpted.particles).toBeUndefined();
		expect(sculpted.relief?.amount).toBe(0.08);
		expect(createChart3dScene(controller.getSpec(), { width: 400, height: 300, relief: { amount: 0.02 } }).relief?.amount).toBe(0.02);
	});

	it('says Office files keep the 3-D view but not particles or relief', () => {
		const { controller } = registry();
		controller.update({ view3d: { particles: { unit: 5 }, relief: { amount: 0.03 } } });
		const out = chartToOoxml(controller.getSpec());
		expect(out.issues).toContain('Office has no particles or relief: the 3-D view is saved without them.');
	});
});
