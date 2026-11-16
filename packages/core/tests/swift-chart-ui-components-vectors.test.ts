// What the Swift chart package's UI components (`chartUiComponents()` in PixerateChart) must match
// (#819): for each Swift-ready chart type, its SVG for a range of data, sizes, themes and role
// colours, and the error message for data or sizes it refuses. The descriptor's contentHash covers
// the example drawn in light and dark, so a Swift render equal to these is described by the same
// hash. Set UPDATE_SWIFT_VECTORS=1 to regenerate the fixture.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chartContracts } from '../src/chart/contract.js';
import { CHART_UI_SWIFT_READY, chartUiExampleSize, uiComponents, type ChartUiComponentId, type ChartUiRenderOptions } from '../src/chart/ui-components.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../swift/Tests/PixerateChartTests/Fixtures/chart-ui-components-vectors.json');

type Case = { name: string; id: ChartUiComponentId; data: unknown; options: ChartUiRenderOptions };

const BRAND = { surface: '#fafaf9', ink: '#1c1917', 'ink-muted': '#78716c', border: '#e7e5e4', accent: '#0f766e' };

function cases(): Case[] {
	const list: Case[] = [];
	for (const c of uiComponents().filter((c) => CHART_UI_SWIFT_READY.includes(c.id))) {
		const size = chartUiExampleSize(c.id);
		for (const theme of ['light', 'dark'] as const) list.push({ name: `${c.id} example ${theme}`, id: c.id, data: c.descriptor.example, options: { ...size, theme } });
		list.push({ name: `${c.id} example brand colours`, id: c.id, data: c.descriptor.example, options: { ...size, colors: BRAND } });
		list.push({ name: `${c.id} example dark, accent only`, id: c.id, data: c.descriptor.example, options: { ...size, theme: 'dark', colors: { accent: ' #f43f5e ', unknown: '#000' } } });
	}
	list.push(
		{ name: 'sparkline no label, negatives', id: 'sparkline', data: { values: [3, -2, 5, 0, -4, 6, 1] }, options: { width: 96, height: 20 } },
		{ name: 'sparkline flat run, wide', id: 'sparkline', data: { values: [7, 7, 7, 7], label: 'Flat & "steady"' }, options: { width: 300, height: 40, theme: 'dark' } },
		{ name: 'bar-chart one series, no unit or title', id: 'bar-chart', data: { categories: ['North', 'South', 'East'], series: [{ name: 'Units', values: [12, 30, 21] }] }, options: { width: 320, height: 200 } },
		{ name: 'bar-chart four series, small', id: 'bar-chart', data: { title: 'Mix', unit: '%', categories: ['A', 'B'], series: [1, 2, 3, 4].map((n) => ({ name: `S${n}`, values: [n * 5, n * 7] })) }, options: { width: 200, height: 150, theme: 'dark' } },
		{ name: 'line-chart three series', id: 'line-chart', data: { title: 'Latency', unit: ' ms', categories: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], series: [{ name: 'p50', values: [120, 118, 131, 125, 119] }, { name: 'p90', values: [210, 205, 240, 228, 214] }, { name: 'p99', values: [480, 455, 610, 520, 498] }] }, options: { width: 560, height: 280, colors: BRAND } },
		{ name: 'line-chart one series, no title', id: 'line-chart', data: { categories: ['1', '2', '3'], series: [{ name: 'Only', values: [0.5, 0.25, 0.75] }] }, options: { width: 240, height: 140 } },
		{ name: 'donut-chart narrow, legend below', id: 'donut-chart', data: { title: 'Plan mix', slices: [{ label: 'Free', value: 60 }, { label: 'Pro', value: 30 }, { label: 'Team', value: 10 }] }, options: { width: 200, height: 260 } },
		{ name: 'donut-chart one slice, no title', id: 'donut-chart', data: { slices: [{ label: 'All', value: 1 }] }, options: { width: 280, height: 200, theme: 'dark' } }
	);
	return list;
}

const errorCases: Case[] = [
	{ name: 'sparkline missing values', id: 'sparkline', data: { label: 'x' }, options: { width: 100, height: 20 } },
	{ name: 'sparkline extra property', id: 'sparkline', data: { values: [1, 2], colour: 'red' }, options: { width: 100, height: 20 } },
	{ name: 'bar-chart value count', id: 'bar-chart', data: { categories: ['A', 'B'], series: [{ name: 'S', values: [1] }] }, options: { width: 300, height: 200 } },
	{ name: 'line-chart value count', id: 'line-chart', data: { categories: ['A', 'B', 'C'], series: [{ name: 'S', values: [1, 2, 3, 4] }] }, options: { width: 300, height: 200 } },
	{ name: 'line-chart one category', id: 'line-chart', data: { categories: ['A'], series: [{ name: 'S', values: [1] }] }, options: { width: 300, height: 200 } },
	{ name: 'donut-chart negative slice', id: 'donut-chart', data: { slices: [{ label: 'A', value: -1 }] }, options: { width: 300, height: 200 } },
	{ name: 'donut-chart width 0', id: 'donut-chart', data: { slices: [{ label: 'A', value: 1 }] }, options: { width: 0, height: 200 } },
	{ name: 'bar-chart height too large', id: 'bar-chart', data: { categories: ['A'], series: [{ name: 'S', values: [1] }] }, options: { width: 300, height: 5000 } }
];

function buildVectors() {
	const byId = new Map(uiComponents().map((c) => [c.id, c]));
	const render = ({ id, data, options }: Case) => byId.get(id)!.render(data, options);
	return {
		renders: cases().map((c) => ({ ...c, svg: render(c) })),
		errors: errorCases.map((c) => {
			try {
				render(c);
			} catch (e) {
				return { ...c, error: (e as Error).message };
			}
			throw new Error(`${c.name}: expected an error`);
		})
	};
}

describe('Swift chart UI component vectors', () => {
	it('exports the Swift-ready chart types as a contract file, descriptors as uiComponents() gives them', () => {
		const file = chartContracts()['ui-components.json'] as { components: { id: string; descriptor: unknown; exampleSize: unknown }[] };
		expect(file.components.map((c) => c.id)).toEqual([...CHART_UI_SWIFT_READY]);
		for (const c of file.components) {
			const full = uiComponents().find((u) => u.id === c.id)!;
			expect(c.descriptor).toEqual(full.descriptor);
			expect(full.descriptor).toMatchObject({ platforms: ['html-page', 'swiftui'], swiftReady: true });
		}
		for (const c of uiComponents().filter((u) => !CHART_UI_SWIFT_READY.includes(u.id))) expect(c.descriptor).toMatchObject({ platforms: ['html-page'], swiftReady: false });
	});

	it('matches the recorded Swift fixture (set UPDATE_SWIFT_VECTORS=1 to regenerate)', () => {
		const serialized = `${JSON.stringify(buildVectors(), null, 2)}\n`;
		if (process.env.UPDATE_SWIFT_VECTORS === '1') {
			mkdirSync(dirname(fixturePath), { recursive: true });
			writeFileSync(fixturePath, serialized, 'utf8');
		}
		expect(existsSync(fixturePath)).toBe(true);
		expect(readFileSync(fixturePath, 'utf8')).toBe(serialized);
	});
});
