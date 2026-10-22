import { describe, expect, it } from 'vitest';
import { PresenceStore, ToolRegistry, createAgentPlayback, createInstantPresenceClock } from '../src/tools';
import { ChartController, ChartDirector, ChartPresence, chartPointRef, createChartToolProvider, layoutChart, locateChartPoint, planChartToolPlayback, type ChartSpec } from '../src/chart';

const spec: Partial<ChartSpec> = {
	type: 'bar',
	categories: ['Q1', 'Q2'],
	series: [{ id: 'na', name: 'North America', values: [10, 20] }]
};

describe('planChartToolPlayback', () => {
	it('clicks the inspector options a change sets', () => {
		expect(planChartToolPlayback('update_chart', { type: 'line', title: 'Revenue' })).toEqual([
			{ type: 'target', ref: { kind: 'chart-type', id: 'line' } },
			{ type: 'press' },
			{ type: 'release' },
			{ type: 'target', ref: { kind: 'control', id: 'title' } },
			{ type: 'press' },
			{ type: 'release' }
		]);
		expect(planChartToolPlayback('apply_chart_preset', { colors: 'okabe-ito' })![0]).toEqual({ type: 'target', ref: { kind: 'control', id: 'preset.colors' } });
		expect(planChartToolPlayback('add_chart_series', { name: 'EU' })).toEqual([{ type: 'target', ref: { kind: 'grid', id: 'data' } }]);
		expect(planChartToolPlayback('render_chart', { format: 'png' })).toEqual([{ type: 'target', ref: { kind: 'action', id: 'download-png' } }]);
		expect(planChartToolPlayback('get_chart', {})).toBeNull();
	});

	it('finds a point by series name and category label', () => {
		const c = new ChartController({ spec });
		const scene = layoutChart(c.getSpec(), { width: 400, height: 300 });
		const box = locateChartPoint(c.getSpec(), scene, chartPointRef('North America', 'Q2'));
		expect(box).toBeTruthy();
		expect(locateChartPoint(c.getSpec(), scene, chartPointRef('na', 1))).toEqual(box);
		expect(locateChartPoint(c.getSpec(), scene, chartPointRef('nope', 0))).toBeNull();
	});
});

describe('chart tools through playback', () => {
	it('plays non-director calls on the chart surface and leaves value drags to the director', async () => {
		const controller = new ChartController({ spec });
		const presence = new ChartPresence();
		const director = new ChartDirector(controller, presence, { scene: () => layoutChart(controller.getSpec(), { width: 400, height: 300 }), clock: createInstantPresenceClock(), linger: 0 });
		const provider = createChartToolProvider(controller, { id: 'chart', namespace: 'chart', director });
		expect(provider.playbackSurface).toBe('chart');
		const tools = typeof provider.tools === 'function' ? provider.tools() : provider.tools;
		expect(tools.find((t) => t.name === 'set_chart_values')!.playback).toBe('self');
		const registry = new ToolRegistry();
		registry.register(provider);
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		playback.install(registry);
		// The surface shares the director's presence store: one cursor.
		playback.attach('chart', { presence: presence as PresenceStore, locate: (ref) => (ref.kind === 'control' ? { x: 500, y: 20, width: 100, height: 20 } : null) });
		const steps = playback.record();
		await registry.callTool('chart__update_chart', { title: 'Revenue' });
		expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'release', 'commit']);
		steps.length = 0;
		const res = await registry.callTool('chart__set_chart_values', { cells: [{ series: 'na', category: 0, value: 15 }] });
		expect(res.isError).toBeFalsy();
		expect(steps).toEqual([]);
		expect(controller.getSpec().series[0]!.values[0]).toBe(15);
	});

	it('plans value changes itself without a director', () => {
		const provider = createChartToolProvider(new ChartController({ spec }));
		const tools = typeof provider.tools === 'function' ? provider.tools() : provider.tools;
		const set = tools.find((t) => t.name === 'set_chart_values')!;
		expect(set.playback).toBeUndefined();
		expect(set.plan!({ cells: [{ series: 'na', category: 'Q1', value: 1 }] }, { surfaceId: null, locate: () => null })).toEqual([
			{ type: 'target', ref: chartPointRef('na', 'Q1') },
			{ type: 'press' },
			{ type: 'release' }
		]);
	});
});
