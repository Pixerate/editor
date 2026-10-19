// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { FAMILY_TEMPLATES, parseMermaid } from '../src/diagram';
import { DIAGRAM_SCENE_LIGHT_THEME, DIAGRAM_TITLE_TARGET, ensureDiagramLayout, sceneColor, type DiagramMark } from '../src/canvas';
import { mindmapScene } from '../src/canvas/mermaid/families/mindmap';
import { mindmapGeometry } from '../src/diagram/mindmap/geometry';

const SRC = ['mindmap', '  root((Hub))', '    A[Square]', '      A1', '        A1a', '    B', '      ::icon(fa fa-book)', '    {{C}}'].join('\n');

const SOURCES = {
	template: FAMILY_TEMPLATES.mindmap!,
	basic: SRC,
	forms: 'mindmap\n  root((Hub))\n    A[Square]\n      ::icon(fa fa-book)\n    b))Bang((\n      :::urgent big\n    )Cloud(\n    {{Hex}}\n    (Rounded)\n    q["Quoted (label)"]\n',
	large:
		'mindmap\n  root((Generative Diagrams))\n    Authoring\n      Canvas editing\n      Source editing\n      Templates\n    Rendering\n      Thumbnails\n      Live preview\n      Export to SVG/PNG\n    Portability\n      Mermaid round-trip\n      Layout metadata\n    Audiences\n      Product teams\n      Architects\n      Analysts\n'
};

function scene(src: string) {
	const doc = parseMermaid(src);
	const marks = mindmapScene({
		graph: doc.graph,
		layout: ensureDiagramLayout(doc.graph, doc.meta, { family: doc.family }),
		theme: DIAGRAM_SCENE_LIGHT_THEME,
		selection: new Set()
	});
	return { doc, marks, geo: mindmapGeometry(doc.graph) };
}

function numbers(mark: DiagramMark): number[] {
	const out: number[] = [];
	for (const v of Object.values(mark)) {
		if (typeof v === 'number') out.push(v);
		else if (v && typeof v === 'object') out.push(...Object.values(v).filter((x): x is number => typeof x === 'number'));
	}
	return out;
}

const topicMark = (marks: DiagramMark[], id: string) => marks.find((m) => m.key === `topic:${id}`)!;

describe('mindmap scene', () => {
	for (const [name, src] of Object.entries(SOURCES)) {
		it(`draws every topic and branch (${name})`, () => {
			const { doc, marks, geo } = scene(src);
			expect(doc.family).toBe('mindmap');
			const targets = new Set(marks.map((m) => m.target));
			for (const n of doc.graph.nodes) expect(targets.has(n.id), n.id).toBe(true);
			// Branches are decoration (a branch cannot be deleted on its own; re-parent the topic instead).
			for (const e of doc.graph.edges) expect(targets.has(e.id), e.id).toBe(false);
			const keys = marks.map((m) => m.key);
			expect(new Set(keys).size).toBe(keys.length);
			expect(marks.every((m) => m.role && !m.selected)).toBe(true);
			// Mermaid prints no title on mind maps.
			expect(marks.some((m) => m.target === DIAGRAM_TITLE_TARGET)).toBe(false);
			for (const m of marks) for (const v of numbers(m)) expect(Number.isFinite(v), m.key).toBe(true);
			for (const m of marks) if (m.kind === 'path' && /[aA]/.test(m.d)) expect(m.box, m.key).toBeDefined();
			// Every topic's shape sits on its geometry.
			for (const t of geo.topics.values()) {
				const m = topicMark(marks, t.id);
				if (m.kind === 'rect') expect([m.x + m.width / 2, m.y + m.height / 2, m.width, m.height]).toEqual([t.x, t.y, t.width, t.height]);
				if (m.kind === 'circle') expect([m.cx, m.cy, m.r]).toEqual([t.x, t.y, t.width / 2]);
			}
			// Branches are drawn under the topics.
			const lastBranch = marks.map((m) => m.role).lastIndexOf('branch');
			const firstTopic = marks.findIndex((m) => m.role === 'topic');
			expect(lastBranch).toBeLessThan(firstTopic);
		});
	}

	it('draws the root in the centre, sections, shapes and depth-scaled branches', () => {
		const { doc, marks, geo } = scene(SRC);
		const theme = DIAGRAM_SCENE_LIGHT_THEME;
		const root = topicMark(marks, 'root');
		expect(root).toMatchObject({ kind: 'circle', cx: 0, cy: 0, fill: theme.nodeStroke });
		// Each top-level branch is a section; its subtree shares the colour.
		for (const id of ['A', 'A1', 'A1a']) expect(topicMark(marks, id)).toMatchObject({ fill: sceneColor(theme, 0) });
		expect(topicMark(marks, 'B')).toMatchObject({ fill: sceneColor(theme, 1) });
		expect(topicMark(marks, 'C')).toMatchObject({ kind: 'path', fill: sceneColor(theme, 2) });
		// Square is a plain rect, default has the underline, hexagon a six-point polygon.
		expect(topicMark(marks, 'A')).toMatchObject({ kind: 'rect' });
		expect((topicMark(marks, 'A') as { radius?: number }).radius).toBeUndefined();
		expect(topicMark(marks, 'B')).toMatchObject({ kind: 'rect', radius: 5 });
		const b = geo.topics.get('B')!;
		expect(marks.find((m) => m.key === 'underline:B')).toMatchObject({ kind: 'line', y1: b.y + b.height / 2, strokeWidth: 3 });
		const hex = topicMark(marks, 'C');
		expect(hex.kind === 'path' && hex.d.split('L').length).toBe(6);

		// Mermaid's `.edge-depth-<n>` widths: 11px from the root, then 8, 5…, in the section colour.
		const branch = (target: string) => {
			const e = doc.graph.edges.find((x) => x.target === target)!;
			return marks.find((m) => m.key === `branch:${e.id}`)!;
		};
		expect(['A', 'A1', 'A1a'].map((t) => (branch(t) as { strokeWidth: number }).strokeWidth)).toEqual([11, 8, 5]);
		expect(branch('A1a')).toMatchObject({ stroke: sceneColor(theme, 0) });
		// Straight between the topic centres.
		const a = geo.topics.get('A')!;
		const a1 = geo.topics.get('A1')!;
		expect(branch('A1')).toMatchObject({ kind: 'line', x1: a.x, y1: a.y, x2: a1.x, y2: a1.y });

		// Labels sit on their topics; the icon badge on B's top-left corner.
		expect(marks.find((m) => m.key === 'label:A:0')).toMatchObject({ kind: 'text', text: 'Square', x: a.x, y: a.y, target: 'A' });
		expect(marks.find((m) => m.key === 'icon:B')).toMatchObject({ kind: 'circle', cx: b.x - b.width / 2, cy: b.y - b.height / 2, target: 'B' });
		expect(marks.find((m) => m.key === 'icon-glyph:B')).toMatchObject({ text: 'B' });
	});

	it('draws clouds and bangs as arc outlines with bounds around the shape', () => {
		const { marks, geo } = scene(SOURCES.forms);
		const forms = new Map([...geo.topics.values()].map((t) => [t.form, t]));
		for (const form of ['cloud', 'bang'] as const) {
			const t = forms.get(form)!;
			const m = topicMark(marks, t.id);
			expect(m.kind).toBe('path');
			if (m.kind !== 'path') continue;
			expect(m.d.startsWith(`M${t.x - t.width / 2},${t.y - t.height / 2} a`)).toBe(true);
			// The bounds contain the shape's box (the bulges go past it).
			expect(m.box!.x).toBeLessThanOrEqual(t.x - t.width / 2);
			expect(m.box!.y).toBeLessThan(t.y - t.height / 2);
			expect(m.box!.x + m.box!.width).toBeGreaterThanOrEqual(t.x + t.width / 2);
			expect(m.box!.y + m.box!.height).toBeGreaterThanOrEqual(t.y + t.height / 2);
			expect(m.box!.width).toBeLessThan(t.width * 2);
		}
		const quoted = marks.find((m) => m.kind === 'text' && m.text === 'Quoted (label)');
		expect(quoted).toBeDefined();
		expect(marks.filter((m) => m.role === 'topic' && m.kind === 'rect' && m.radius === 5).length).toBeGreaterThanOrEqual(1);
	});
});
