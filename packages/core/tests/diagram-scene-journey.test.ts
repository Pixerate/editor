// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { FAMILY_TEMPLATES, parseMermaid } from '../src/diagram';
import { DIAGRAM_SCENE_LIGHT_THEME, DIAGRAM_TITLE_TARGET, ensureDiagramLayout, type DiagramMark } from '../src/canvas';
import { journeyScene } from '../src/canvas/mermaid/families/journey';
import { JOURNEY_METRICS, journeyGeometry } from '../src/diagram/journey/geometry';

const SRC = [
	'journey',
	'  title Requesting a new laptop',
	'  section Discover',
	'    Find IT portal: 3: Employee',
	'    Read policy: 1: Employee, IT',
	'  section Receive',
	'    Device set up: 5: IT'
].join('\n');
const EMPTY_SECTION = 'journey\n  Loose: 2\n  section Empty\n  section Full\n    Task: 4: Me\n';

function scene(src: string) {
	const doc = parseMermaid(src);
	const marks = journeyScene({
		graph: doc.graph,
		layout: ensureDiagramLayout(doc.graph, doc.meta, { family: doc.family }),
		theme: DIAGRAM_SCENE_LIGHT_THEME,
		selection: new Set()
	});
	return { doc, marks, byKey: new Map(marks.map((m) => [m.key, m])) };
}

function numbers(m: DiagramMark): number[] {
	const out: number[] = [];
	for (const v of Object.values(m)) {
		if (typeof v === 'number') out.push(v);
		else if (v && typeof v === 'object') out.push(...Object.values(v).filter((x): x is number => typeof x === 'number'));
	}
	return out;
}

describe('journey scene', () => {
	for (const [name, src] of [
		['template', FAMILY_TEMPLATES.journey!],
		['laptop', SRC],
		['empty section', EMPTY_SECTION]
	] as const)
		it(`draws every task and section with unique keys and finite numbers (${name})`, () => {
			const { doc, marks } = scene(src);
			expect(new Set(marks.map((m) => m.key)).size).toBe(marks.length);
			const targets = new Set(marks.map((m) => m.target));
			for (const n of doc.graph.nodes) expect(targets.has(n.id)).toBe(true);
			for (const g of doc.graph.groups) expect(targets.has(g.id)).toBe(true);
			for (const m of marks) {
				expect(m.role).toBeTruthy();
				for (const v of numbers(m)) expect(Number.isFinite(v)).toBe(true);
				if (m.kind === 'path' && /[aA]/.test(m.d)) expect(m.box).toBeDefined();
			}
			// No arrows between tasks (Mermaid has none).
			for (const e of doc.graph.edges) expect(targets.has(e.id)).toBe(false);
		});

	it('draws section bars, tasks, dashed lines to faces, the axis, legend and title', () => {
		const { doc, byKey, marks } = scene(SRC);
		const geo = journeyGeometry(doc.graph);
		const task = byKey.get('task:Read_policy')!;
		expect(task).toMatchObject({ kind: 'rect', x: 350, y: 110, width: 150, height: 50, target: 'Read_policy' });
		expect(task).toMatchObject({ fill: DIAGRAM_SCENE_LIGHT_THEME.palette[0] });
		// Actor dots on the top edge, coloured by the sorted actor list.
		expect(byKey.get('actor:Read_policy:Employee')).toMatchObject({ kind: 'circle', cx: 364, cy: 110, target: 'Read_policy' });
		expect(byKey.get('actor:Read_policy:IT')).toMatchObject({ cx: 374 });
		expect((byKey.get('actor:Read_policy:Employee') as { fill: string }).fill).not.toBe((byKey.get('actor:Read_policy:IT') as { fill: string }).fill);

		const section = byKey.get('section:Receive')!;
		expect(section).toMatchObject({ kind: 'rect', x: 550, y: 50, width: 150, target: 'Receive', fill: DIAGRAM_SCENE_LIGHT_THEME.palette[1] });
		expect(byKey.get('section:Discover')).toMatchObject({ x: 150, width: 350 });

		// Faces: centred under the task, 30px lower per point below 5.
		expect(byKey.get('face:Read_policy')).toMatchObject({ kind: 'circle', cx: 425, cy: 420, r: 15, target: 'Read_policy' });
		expect(byKey.get('face:Device_set_up')).toMatchObject({ cy: 300 });
		// Mouth by score: sad (arc), neutral (line), happy (arc).
		expect(byKey.get('mouth:Read_policy')).toMatchObject({ kind: 'path' });
		expect(byKey.get('mouth:Find_IT_portal')).toMatchObject({ kind: 'line' });
		expect(byKey.get('mouth:Device_set_up')).toMatchObject({ kind: 'path' });

		expect(byKey.get('task-line:Read_policy')).toMatchObject({ kind: 'line', x1: 425, y1: 110, x2: 425, y2: JOURNEY_METRICS.lineBottom, dash: '4 2' });
		expect(byKey.get('task-line:Read_policy')!.target).toBeUndefined();
		expect(byKey.get('axis')).toMatchObject({ kind: 'line', x1: geo.axis.x1, x2: geo.axis.x2, y1: 200, strokeWidth: 4, markerEnd: 'arrowclosed' });

		const legend = marks.filter((m) => m.role === 'legend' && m.kind === 'text').map((m) => (m as { text: string }).text);
		expect(legend).toEqual(['Employee', 'IT']);
		expect(marks.filter((m) => m.role === 'legend').every((m) => m.target === undefined)).toBe(true);

		const title = byKey.get('title')!;
		expect(title).toMatchObject({ kind: 'text', x: 150, text: 'Requesting a new laptop', target: DIAGRAM_TITLE_TARGET, anchor: 'start' });
		const labels = marks.filter((m) => m.key.startsWith('task-label:Read_policy')).map((m) => (m as { text: string }).text);
		expect(labels.join(' ')).toBe('Read policy');
	});

	it('parks empty sections after the tasks (faded) and gives loose tasks slot 0', () => {
		const { byKey } = scene(EMPTY_SECTION);
		expect(byKey.get('task:Loose')).toMatchObject({ x: 150, fill: DIAGRAM_SCENE_LIGHT_THEME.palette[0] });
		expect(byKey.get('task:Task')).toMatchObject({ x: 350 });
		expect(byKey.get('section:Full')).toMatchObject({ fill: DIAGRAM_SCENE_LIGHT_THEME.palette[0] });
		expect(byKey.get('section:Empty')).toMatchObject({ x: 550, opacity: 0.6, dash: '4 3' });
		expect(byKey.has('title')).toBe(false);
	});

	it('wraps long task names inside the box', () => {
		const { marks } = scene('journey\n  section S\n    A very long task name that cannot fit on one line: 3: Me\n');
		const lines = marks.filter((m) => m.role === 'task-label');
		expect(lines.length).toBeGreaterThan(1);
		for (const l of lines) if (l.kind === 'text') expect(l.y).toBeGreaterThan(110), expect(l.y).toBeLessThan(160);
	});
});
