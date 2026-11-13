import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ChartController, createChartToolProvider, normalizeChartSpec, CHART_VIEW3D_DEFAULTS } from '../src/chart';

describe('chart view3d (#795)', () => {
	it('is absent by default, filled with defaults when given, and refused when out of range', () => {
		expect('view3d' in normalizeChartSpec({}).spec).toBe(false);
		expect(normalizeChartSpec({ view3d: null }).spec.view3d).toBeUndefined();
		expect(normalizeChartSpec({ view3d: {} }).spec.view3d).toEqual(CHART_VIEW3D_DEFAULTS);
		expect(normalizeChartSpec({ view3d: { azimuth: 45, depth: '2' } }).spec.view3d).toEqual({ azimuth: 45, elevation: 15, depth: 2 });
		const bad = normalizeChartSpec({ view3d: { azimuth: 400, elevation: -1, depth: 0, tilt: 3 } });
		expect(bad.issues.map((i) => i.message)).toEqual([
			'view3d has no "tilt"; it takes azimuth, elevation and depth.',
			'view3d.azimuth must be a turn from 0 to 360 degrees.',
			'view3d.elevation must be an angle from 0 to 90 degrees.',
			'view3d.depth must be a multiple of the bar width from 0.2 to 20.'
		]);
		expect(normalizeChartSpec({ view3d: 'yes' }).issues[0].message).toBe('view3d must be { azimuth, elevation, depth } or null for a flat chart.');
	});

	it('update_chart sets, merges and clears it as one undo step each, and refuses bad values', async () => {
		const controller = new ChartController({ spec: { type: 'bar', categories: ['a', 'b'], series: [{ name: 'S', values: [1, 2] }] } });
		const registry = new ToolRegistry();
		registry.register(createChartToolProvider(controller, { namespace: '' }));
		const set = await registry.callTool('update_chart', { view3d: { azimuth: 40 } });
		expect((set.structuredContent as any).spec.view3d).toEqual({ azimuth: 40, elevation: 15, depth: 1 });
		await registry.callTool('update_chart', { view3d: { depth: 3 } });
		expect(controller.toJSON().view3d).toEqual({ azimuth: 40, elevation: 15, depth: 3 });
		const bad = await registry.callTool('update_chart', { view3d: { elevation: 120 } });
		expect(bad.isError).toBe(true);
		await registry.callTool('update_chart', { view3d: null });
		expect('view3d' in controller.toJSON()).toBe(false);
		controller.undo();
		expect(controller.toJSON().view3d).toEqual({ azimuth: 40, elevation: 15, depth: 3 });
	});
});
