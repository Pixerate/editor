// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { FAMILY_TEMPLATES, parseMermaid } from '../src/diagram';
import { DIAGRAM_SCENE_LIGHT_THEME, DIAGRAM_TITLE_TARGET, ensureDiagramLayout, type DiagramMark } from '../src/canvas';
import { quadrantScene } from '../src/canvas/mermaid/families/quadrant';
import { quadrantGeometry } from '../src/diagram/quadrant/geometry';

const SRC = [
	'quadrantChart',
	'  title Reach and engagement',
	'  x-axis Low Reach --> High Reach',
	'  y-axis Low Engagement --> High Engagement',
	'  quadrant-1 Expand',
	'  quadrant-3 Re-evaluate',
	'  Campaign A: [0.3, 0.6]',
	'  Campaign B: [0.45, 0.23] radius: 10'
].join('\n');
const STYLED = [
	'quadrantChart',
	'  A: [0.3, 0.6] radius: 10, color: #ff0000',
	'  B:::cls: [0.1, 0.2]',
	'  C: [0.8, 0.9] stroke-color: #00ff00, stroke-width: 3px',
	'  classDef cls color: #00ff00, radius: 5'
].join('\n');

function scene(src: string) {
	const doc = parseMermaid(src);
	const marks = quadrantScene({
		graph: doc.graph,
		layout: ensureDiagramLayout(doc.graph, doc.meta, { family: doc.family }),
		theme: DIAGRAM_SCENE_LIGHT_THEME,
		selection: new Set()
	});
	return { doc, marks, geo: quadrantGeometry(doc.graph), byKey: new Map(marks.map((m) => [m.key, m])) };
}

function numbers(m: DiagramMark): number[] {
	return Object.values(m).filter((v): v is number => typeof v === 'number');
}

describe('quadrant scene', () => {
	for (const [name, src] of [
		['template', FAMILY_TEMPLATES.quadrant!],
		['campaigns', SRC],
		['styled', STYLED],
		['empty', 'quadrantChart\n  x-axis Left --> Right\n']
	] as const)
		it(`targets every point and quadrant with unique keys and finite numbers (${name})`, () => {
			const { doc, marks } = scene(src);
			expect(new Set(marks.map((m) => m.key)).size).toBe(marks.length);
			const targets = new Set(marks.map((m) => m.target));
			for (const n of doc.graph.nodes) expect(targets.has(n.id)).toBe(true);
			for (const g of doc.graph.groups) expect(targets.has(g.id)).toBe(true);
			for (const m of marks) {
				expect(m.role).toBeTruthy();
				for (const v of numbers(m)) expect(Number.isFinite(v)).toBe(true);
			}
		});

	it('draws points as circles centred on their coordinates, labels below', () => {
		const { marks, geo, byKey } = scene(SRC);
		const points = marks.filter((m) => m.role === 'point');
		expect(points.map((m) => m.target)).toEqual(['Campaign_A', 'Campaign_B']);
		for (const p of geo.points) {
			expect(byKey.get(`point:${p.id}`)).toMatchObject({ kind: 'circle', cx: p.cx, cy: p.cy, r: p.radius, fill: DIAGRAM_SCENE_LIGHT_THEME.palette[0] });
			expect(byKey.get(`point-label:${p.id}`)).toMatchObject({ kind: 'text', x: p.cx, y: p.cy + 5, baseline: 'top', target: p.id, text: p.label });
		}
		expect(byKey.get('point:Campaign_B')).toMatchObject({ r: 10 });
	});

	it('draws the quadrants, borders, axis labels and title', () => {
		const { marks, geo, byKey } = scene(SRC);
		const areas = marks.filter((m) => m.role === 'quadrant');
		expect(areas.map((m) => m.target)).toEqual(['quadrant-1', 'quadrant-2', 'quadrant-3', 'quadrant-4']);
		expect(byKey.get('quadrant:quadrant-2')).toMatchObject({ x: geo.space.left, y: geo.space.top, width: geo.space.width / 2 });
		expect(byKey.get('quadrant-fill:quadrant-1')!.target).toBeUndefined();
		// Named quadrants have labels; placeholders (2 and 4) do not.
		expect(byKey.get('quadrant-label:quadrant-1')).toMatchObject({ text: 'Expand', target: 'quadrant-1', baseline: 'top' });
		expect(byKey.get('quadrant-label:quadrant-3')).toMatchObject({ text: 'Re-evaluate' });
		expect(byKey.has('quadrant-label:quadrant-2')).toBe(false);
		expect(byKey.has('quadrant-label:quadrant-4')).toBe(false);

		const borders = marks.filter((m) => m.role === 'border' || m.role === 'divider');
		expect(borders).toHaveLength(6);
		expect(marks.filter((m) => m.role === 'border').every((m) => m.kind === 'line' && m.strokeWidth === 2)).toBe(true);

		const axes = marks.filter((m) => m.role === 'axis-label');
		expect(axes.map((m) => m.key)).toEqual(['axis:xAxisLeft', 'axis:xAxisRight', 'axis:yAxisBottom', 'axis:yAxisTop']);
		// x labels under the chart, y labels rotated in the strip on the left.
		expect(byKey.get('axis:xAxisLeft')).toMatchObject({ y: geo.space.top + geo.space.height + 10, text: 'Low Reach', anchor: 'middle' });
		expect(byKey.get('axis:yAxisBottom')).toMatchObject({ x: 5, rotate: -90, text: 'Low Engagement' });

		expect(byKey.get('title')).toMatchObject({ kind: 'text', text: 'Reach and engagement', target: DIAGRAM_TITLE_TARGET, x: 250, y: 10 });
	});

	it('puts the x axis on top and centres quadrant labels while the chart has no points', () => {
		const { byKey } = scene('quadrantChart\n  x-axis Left --> Right\n  quadrant-1 One\n');
		expect(byKey.get('axis:xAxisLeft')).toMatchObject({ y: 5 });
		expect(byKey.get('quadrant-label:quadrant-1')).toMatchObject({ baseline: 'middle' });
		expect(byKey.has('title')).toBe(false);
	});

	it('keeps colours and strokes the points set', () => {
		const { byKey } = scene(STYLED);
		expect(byKey.get('point:A')).toMatchObject({ fill: '#ff0000', r: 10 });
		expect(byKey.get('point:A')).not.toHaveProperty('stroke');
		expect(byKey.get('point:B')).toMatchObject({ fill: '#00ff00', r: 5 });
		expect(byKey.get('point:C')).toMatchObject({ fill: DIAGRAM_SCENE_LIGHT_THEME.palette[0], stroke: '#00ff00', strokeWidth: 3 });
	});
});
