// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
	createChartSpec,
	layoutChart,
	normalizeChartSpec,
	summarizeChart,
	chartTooltipAt,
	type ChartMark,
	type ChartScene,
	type ChartSpec
} from '../src/chart';

const SIZE = { width: 640, height: 400 };
const scene = (spec: Partial<ChartSpec>) => layoutChart(createChartSpec(spec), SIZE);
const role = (s: ChartScene, r: ChartMark['role']) => s.marks.filter((m) => m.role === r);

const streamData: Partial<ChartSpec> = {
	type: 'streamgraph',
	categories: ['Jan', 'Feb', 'Mar', 'Apr', 'May'],
	series: [
		{ id: 'dev', name: 'Development', values: [30, 45, 60, 40, 50] },
		{ id: 'des', name: 'Design', values: [20, 25, 30, 35, 25] },
		{ id: 'qa', name: 'QA', values: [10, 15, 20, 25, 30] }
	]
};

describe('streamgraph', () => {
	it('normalizes streamgraph spec and properties', () => {
		const { spec } = normalizeChartSpec({ type: 'streamgraph' });
		expect(spec.type).toBe('streamgraph');
	});

	it('lays out streamgraph with area ribbons, boundary lines, center baseline rule and point targets', () => {
		const s = scene(streamData);
		expect(s.warnings).toEqual([]);

		// Check area ribbons
		const areas = role(s, 'area');
		expect(areas.length).toBe(3);
		expect(areas.every((m) => m.kind === 'path')).toBe(true);

		// Check boundary lines (1 bottom base + 3 layer tops = 4)
		const lines = role(s, 'line');
		expect(lines.length).toBe(4);

		// Check center zero rule (grid mark)
		const rules = s.marks.filter((m) => m.key === 'rule-zero');
		expect(rules.length).toBe(1);
		expect(rules[0].role).toBe('grid');

		// Check point markers for interaction / hit testing (3 series * 5 categories = 15)
		const points = role(s, 'point');
		expect(points.length).toBe(15);
	});

	it('centers the silhouette symmetrically around zero', () => {
		const s = scene(streamData);
		expect(s.valueScale).toBeDefined();
		const [min, max] = s.valueScale!.domain;
		// Must be symmetric: min should be -max
		expect(min).toBeCloseTo(-max, 1);
		expect(max).toBeGreaterThan(0);
	});

	it('generates agent summary for streamgraph', () => {
		const spec = createChartSpec(streamData);
		const summary = summarizeChart(spec, SIZE);
		expect(summary.type).toBe('streamgraph');
		expect(summary.description).toContain('stacked symmetrically around a center baseline');
		expect(summary.description).toContain('peak volume');
	});

	it('supports category and point tooltips', () => {
		const spec = createChartSpec(streamData);
		const s = layoutChart(spec, SIZE);
		const plot = s.plot;
		// Hover over the middle category (Mar, category index 2)
		const midX = plot.x + plot.width / 2;
		const midY = plot.y + plot.height / 2;

		const tt = chartTooltipAt(spec, s, { x: midX, y: midY }, { mode: 'category' });
		expect(tt).not.toBeNull();
		expect(tt?.title).toBe('Mar');
		expect(tt?.items.length).toBe(3);
		expect(tt?.items.map((i) => i.name)).toEqual(['Development', 'Design', 'QA']);
	});

	it('renders empty message when no series or categories are present', () => {
		const s = scene({ type: 'streamgraph', categories: [], series: [] });
		const empties = role(s, 'empty');
		expect(empties.length).toBe(1);
		expect(empties[0].kind).toBe('text');
	});
});
