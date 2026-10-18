// @vitest-environment jsdom
// Intent ported from Ursula (src/react/canvases/timeline.test.ts).
import { describe, expect, it } from 'vitest';
import { FAMILY_TEMPLATES, parseMermaid } from '../src/diagram';
import { TIMELINE_METRICS, timelineGeometry } from '../src/diagram/timeline/geometry.js';
import { DIAGRAM_SCENE_LIGHT_THEME, DIAGRAM_TITLE_TARGET, ensureDiagramLayout, type DiagramMark } from '../src/canvas';
import { timelineScene } from '../src/canvas/mermaid/families/timeline.js';

const SRC = [
	'timeline',
	'  title Platform milestones',
	'  section Now',
	'    2024 : Unified portal launched',
	'         : Design system v1',
	'    2025 : AI chat assistant',
	'  section Later',
	'    2026 : Generative diagrams'
].join('\n');

const LOOSE = 'timeline\n  2024 : A\n  2025 : B\n  2026';

function draw(src: string) {
	const doc = parseMermaid(src);
	const marks = timelineScene({
		graph: doc.graph,
		layout: ensureDiagramLayout(doc.graph, doc.meta, { family: doc.family }),
		theme: DIAGRAM_SCENE_LIGHT_THEME,
		selection: new Set()
	});
	return { doc, marks };
}

function numbersOf(mark: DiagramMark): number[] {
	const out: number[] = [];
	for (const v of Object.values(mark)) if (typeof v === 'number') out.push(v);
	if (mark.kind === 'path') out.push(...(mark.d.match(/-?\d*\.?\d+(?:e-?\d+)?|NaN|Infinity/gi) ?? []).map(Number));
	return out;
}

describe('timeline scene', () => {
	for (const [name, src] of [
		['template', FAMILY_TEMPLATES.timeline!],
		['sections', SRC],
		['loose periods', LOOSE]
	] as const) {
		it(`draws every period and section of the ${name} with unique keys and finite numbers`, () => {
			const { doc, marks } = draw(src);
			const targets = new Set(marks.map((m) => m.target));
			for (const n of doc.graph.nodes) expect(targets, n.id).toContain(n.id);
			for (const g of doc.graph.groups) expect(targets, g.id).toContain(g.id);
			// Mermaid draws no arrows between periods.
			for (const e of doc.graph.edges) expect(targets.has(e.id)).toBe(false);
			const keys = marks.map((m) => m.key);
			expect(new Set(keys).size).toBe(keys.length);
			for (const m of marks) for (const v of numbersOf(m)) expect(Number.isFinite(v), `${m.key}`).toBe(true);
			const title = marks.find((m) => m.role === 'title');
			if (doc.graph.title) expect(title?.target).toBe(DIAGRAM_TITLE_TARGET);
			else expect(title).toBeUndefined();
		});
	}

	it('places periods, sections, events, lines and the axis from the geometry', () => {
		const { doc, marks } = draw(SRC);
		const geo = timelineGeometry(doc.graph);
		const byKey = new Map(marks.map((m) => [m.key, m]));
		const textOf = (key: string) => (byKey.get(key) as { text: string } | undefined)?.text;
		// Periods in one row, 200px apart, under the section bands.
		const p2024 = geo.periods.get('2024')!;
		expect(geo.periods.get('2025')!.x - p2024.x).toBe(200);
		const period = byKey.get('period:2024');
		expect(period).toMatchObject({ kind: 'path', target: '2024', fill: DIAGRAM_SCENE_LIGHT_THEME.palette[0] });
		expect(period?.kind === 'path' && period.d.startsWith(`M ${p2024.x} ${p2024.y + 5}`)).toBe(true);
		expect(textOf('period:2024:text:0')).toBe('2024');
		// One colour per section.
		expect(byKey.get('period:2026')).toMatchObject({ fill: DIAGRAM_SCENE_LIGHT_THEME.palette[1] });
		const now = geo.sections.get('Now')!;
		expect([now.x, now.y, now.width]).toEqual([0, 0, 390]);
		expect(byKey.get('section:Now')).toMatchObject({ target: 'Now' });
		expect(textOf('section:Now:text:0')).toBe('Now');
		// Events in order under their period, selecting it.
		const events = marks.filter((m) => m.role === 'event' && m.kind === 'path' && !m.key.endsWith(':wash'));
		expect(events.map((m) => m.target)).toEqual(['2024', '2024', '2025', '2026']);
		expect(marks.filter((m) => m.role === 'event-label').map((m) => (m as { text: string }).text).join(' ')).toBe(
			'Unified portal launched Design system v1 AI chat assistant Generative diagrams'
		);
		expect(geo.events[0]!.y).toBe(p2024.y + 200);
		// Dashed event lines and the thick axis, with arrowheads, as decorations.
		const eventLines = marks.filter((m) => m.role === 'event-line' && m.kind === 'line');
		expect(eventLines).toHaveLength(3);
		expect(eventLines.every((m) => m.kind === 'line' && m.dash === '5,5' && m.strokeWidth === TIMELINE_METRICS.eventLineWidth)).toBe(true);
		expect(byKey.get('axis')).toMatchObject({ kind: 'line', x1: geo.axis.x1, x2: geo.axis.x2, y1: geo.axis.y, strokeWidth: 4 });
		expect(byKey.get('axis:head')?.kind).toBe('path');
		expect(marks.filter((m) => m.role === 'axis' || m.role === 'event-line').every((m) => m.target === undefined)).toBe(true);
		expect(byKey.get('title')).toMatchObject({ text: 'Platform milestones', x: geo.title.x, anchor: 'start' });
	});

	it('wraps long period text over several lines', () => {
		const { marks } = draw('timeline\n  A very long period name that will certainly wrap : Event');
		expect(marks.filter((m) => m.role === 'period-label').length).toBeGreaterThan(1);
	});

	it('colours periods one by one without sections', () => {
		const { marks } = draw(LOOSE);
		const fills = ['2024', '2025', '2026'].map((id) => (marks.find((m) => m.key === `period:${id}`) as { fill: string }).fill);
		expect(fills).toEqual(DIAGRAM_SCENE_LIGHT_THEME.palette.slice(0, 3));
		expect(marks.some((m) => m.role === 'title')).toBe(false);
	});
});
