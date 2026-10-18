// @vitest-environment jsdom
// Intent ported from Ursula (src/react/canvases/gantt.test.ts).
import { describe, expect, it } from 'vitest';
import { FAMILY_TEMPLATES, parseMermaid } from '../src/diagram';
import { ganttGeometry, GANTT_METRICS } from '../src/diagram/gantt/geometry.js';
import { DIAGRAM_SCENE_LIGHT_THEME, DIAGRAM_TITLE_TARGET, ensureDiagramLayout, type DiagramMark } from '../src/canvas';
import { ganttScene } from '../src/canvas/mermaid/families/gantt.js';

const SRC = [
	'gantt',
	'  title Plan',
	'  dateFormat YYYY-MM-DD',
	'  axisFormat %b %d',
	'  Kick-off :milestone, k, 2026-01-05, 0d',
	'  section Build',
	'    Core :done, core, 2026-01-05, 10d',
	'    UI :active, ui, after core, 7d',
	'  section Ship',
	'    Release :crit, rel, after ui, 3d'
].join('\n');

const ROADMAP = `gantt
  title Q4 delivery roadmap
  dateFormat YYYY-MM-DD
  axisFormat %b %d
  section Platform
    Design system v9 rollout     :done,    ds, 2026-10-01, 14d
    Diagram editor beta          :active,  de, 2026-10-08, 21d
    Observability upgrade        :         ob, after de, 14d
  section Product
    Onboarding redesign          :         on, 2026-10-15, 28d
    Billing self-serve           :crit,    bi, after on, 21d
`;

function draw(src: string, selection: string[] = []) {
	const doc = parseMermaid(src);
	const marks = ganttScene({
		graph: doc.graph,
		layout: ensureDiagramLayout(doc.graph, doc.meta, { family: doc.family }),
		theme: DIAGRAM_SCENE_LIGHT_THEME,
		selection: new Set(selection)
	});
	return { doc, marks };
}

function numbersOf(mark: DiagramMark): number[] {
	const out: number[] = [];
	for (const v of Object.values(mark)) if (typeof v === 'number') out.push(v);
	if (mark.kind === 'path') out.push(...(mark.d.match(/-?\d*\.?\d+(?:e-?\d+)?|NaN|Infinity/gi) ?? []).map(Number));
	return out;
}

describe('gantt scene', () => {
	for (const [name, src] of [
		['template', FAMILY_TEMPLATES.gantt!],
		['milestones', SRC],
		['roadmap', ROADMAP]
	] as const) {
		it(`draws every task and section of the ${name} with unique keys and finite numbers`, () => {
			const { doc, marks } = draw(src, doc0Edges(src));
			const targets = new Set(marks.map((m) => m.target));
			for (const n of doc.graph.nodes) expect(targets, n.id).toContain(n.id);
			for (const g of doc.graph.groups) expect(targets, g.id).toContain(g.id);
			for (const e of doc.graph.edges) expect(targets, e.id).toContain(e.id);
			const keys = marks.map((m) => m.key);
			expect(new Set(keys).size).toBe(keys.length);
			for (const m of marks) for (const v of numbersOf(m)) expect(Number.isFinite(v), `${m.key}`).toBe(true);
			const title = marks.find((m) => m.role === 'title');
			expect(title?.target).toBe(DIAGRAM_TITLE_TARGET);
			expect(marks.every((m) => m.selected === undefined)).toBe(true);
		});
	}

	it('places bars, milestones, bands and ticks from the geometry', () => {
		const { doc, marks } = draw(SRC);
		const geo = ganttGeometry(doc.graph);
		const byKey = new Map(marks.map((m) => [m.key, m]));
		for (const id of ['core', 'ui', 'rel']) {
			const row = geo.rowById.get(id)!;
			expect(byKey.get(`bar:${id}`)).toMatchObject({ kind: 'rect', x: row.x, y: row.y, width: row.width, height: row.height });
		}
		// The milestone is a diamond centred on its row box, with an italic label to its right.
		const k = geo.rowById.get('k')!;
		expect(byKey.get('milestone:k')?.kind).toBe('path');
		expect(byKey.get('bar:k')).toBeUndefined();
		expect(byKey.get('label:k')).toMatchObject({ italic: true, anchor: 'start', x: k.x + k.width + 6 });
		// Two named sections plus Mermaid's implicit band for the task before the first section.
		expect(marks.filter((m) => m.role === 'section').map((m) => m.key)).toEqual(['band:::loose', 'band:Build', 'band:Ship']);
		const build = geo.bands.find((b) => b.id === 'Build')!;
		expect(byKey.get('band:Build')).toMatchObject({ x: geo.chartX - GANTT_METRICS.labelWidth, y: build.y, height: build.height, opacity: 0.2, target: 'Build' });
		expect(byKey.get('section:Build')).toMatchObject({ kind: 'text', text: 'Build', target: 'Build' });
		// Ticks use the axis format and are decorations.
		const ticks = marks.filter((m) => m.role === 'axis');
		expect(ticks.length).toBe(geo.ticks.length);
		expect((ticks[0] as { text: string }).text).toMatch(/^Jan \d{2}$/);
		expect(marks.filter((m) => m.role === 'grid' || m.role === 'axis').every((m) => m.target === undefined)).toBe(true);
		expect(byKey.get('title')).toMatchObject({ text: 'Plan', target: DIAGRAM_TITLE_TARGET });
	});

	it('colours bars by status', () => {
		const { marks } = draw(SRC);
		const fill = (id: string) => (marks.find((m) => m.key === `bar:${id}`) as { fill: string }).fill;
		const t = DIAGRAM_SCENE_LIGHT_THEME;
		expect(fill('core')).toBe(t.grid); // done
		expect(fill('ui')).toBe(t.background); // active
		expect(fill('rel')).toBe(t.palette[3]); // crit
	});

	it('draws dependencies only for the selection, from bar end to bar start', () => {
		expect(draw(SRC).marks.some((m) => m.role === 'dependency')).toBe(false);
		const { doc, marks } = draw(SRC, ['ui']);
		const deps = marks.filter((m) => m.role === 'dependency');
		// UI's incoming (core → ui) and outgoing (ui → rel) dependencies.
		expect(deps.map((m) => m.target)).toEqual(doc.graph.edges.map((e) => e.id));
		const geo = ganttGeometry(doc.graph);
		const core = geo.rowById.get('core')!;
		const first = deps[0]!;
		expect(first.kind === 'path' && first.d.startsWith(`M ${core.x + core.width} ${core.y + core.height / 2}`)).toBe(true);
		expect(first).toMatchObject({ markerEnd: 'arrowclosed' });
	});
});

/** Selects every edge so the dependency marks are drawn. */
function doc0Edges(src: string): string[] {
	return parseMermaid(src).graph.edges.map((e) => e.id);
}
