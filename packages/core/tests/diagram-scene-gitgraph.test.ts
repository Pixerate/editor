// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { FAMILY_TEMPLATES, parseMermaid } from '../src/diagram';
import { DIAGRAM_SCENE_LIGHT_THEME, DIAGRAM_TITLE_TARGET, ensureDiagramLayout, sceneColor, type DiagramMark } from '../src/canvas';
import { gitGraphScene } from '../src/canvas/mermaid/families/gitgraph';
import { gitGraphGeometry } from '../src/diagram/gitgraph/geometry';

const SRC = [
	'gitGraph',
	'  commit id: "init"',
	'  branch develop',
	'  checkout develop',
	'  commit id: "feat" tag: "v0.1"',
	'  checkout main',
	'  merge develop',
	'  commit type: HIGHLIGHT'
].join('\n');

const SOURCES = {
	template: FAMILY_TEMPLATES.gitGraph!,
	basic: SRC,
	types: 'gitGraph\n  commit id: "a"\n  branch dev\n  commit id: "b"\n  checkout main\n  commit id: "c" type: HIGHLIGHT\n  checkout dev\n  commit id: "d" type: REVERSE\n  merge main\n',
	cherryTB: 'gitGraph TB:\n  commit\n  commit type: HIGHLIGHT msg: "second" tag: "t"\n  branch hotfix order: 1\n  commit id: "fix"\n  checkout main\n  cherry-pick id: "fix" tag: "picked"\n',
	lanesBT: 'gitGraph BT:\n  commit id: "a"\n  branch late order: 3\n  commit id: "b"\n  checkout main\n  branch early\n  commit id: "c"\n  cherry-pick id: "b"\n'
};

function scene(src: string) {
	const doc = parseMermaid(src);
	const marks = gitGraphScene({
		graph: doc.graph,
		layout: ensureDiagramLayout(doc.graph, doc.meta, { family: doc.family }),
		theme: DIAGRAM_SCENE_LIGHT_THEME,
		selection: new Set()
	});
	return { doc, marks };
}

function numbers(mark: DiagramMark): number[] {
	const out: number[] = [];
	for (const v of Object.values(mark)) {
		if (typeof v === 'number') out.push(v);
		else if (v && typeof v === 'object') out.push(...Object.values(v).filter((x): x is number => typeof x === 'number'));
	}
	return out;
}

describe('gitGraph scene', () => {
	for (const [name, src] of Object.entries(SOURCES)) {
		it(`draws every commit, branch and link (${name})`, () => {
			const { doc, marks } = scene(src);
			expect(doc.family).toBe('gitGraph');
			const targets = new Set(marks.map((m) => m.target));
			for (const n of doc.graph.nodes) expect(targets.has(n.id), n.id).toBe(true);
			for (const g of doc.graph.groups) expect(targets.has(g.id), g.id).toBe(true);
			for (const e of doc.graph.edges) expect(targets.has(e.id), e.id).toBe(true);
			const keys = marks.map((m) => m.key);
			expect(new Set(keys).size).toBe(keys.length);
			expect(marks.every((m) => m.role && !m.selected)).toBe(true);
			expect(marks.some((m) => m.target === DIAGRAM_TITLE_TARGET)).toBe(false);
			for (const m of marks) for (const v of numbers(m)) expect(Number.isFinite(v), m.key).toBe(true);
			for (const m of marks) if (m.kind === 'path' && /[aA]/.test(m.d)) expect(m.box, m.key).toBeDefined();
			for (const m of marks) if (m.kind === 'text') expect(m.text.length).toBeGreaterThan(0);
		});
	}

	it("draws lanes, branch pills, commit bullets and Mermaid's links", () => {
		const { doc, marks } = scene(SRC);
		const geo = gitGraphGeometry(doc.graph);
		const byKey = new Map(marks.map((m) => [m.key, m]));
		// One dashed, decorative lane per branch.
		const lanes = marks.filter((m) => m.role === 'lane');
		expect(lanes.map((m) => m.key)).toEqual(['lane:main', 'lane:develop']);
		expect(lanes.every((m) => m.target === undefined && m.kind === 'line' && m.dash)).toBe(true);
		// Branch pills select their branch.
		const pills = marks.filter((m) => m.role === 'branch');
		expect(pills.map((m) => [m.target, m.kind])).toEqual([
			['main', 'rect'],
			['develop', 'rect']
		]);
		expect(marks.filter((m) => m.role === 'branch-label').map((m) => m.kind === 'text' && m.text)).toEqual(['main', 'develop']);
		const pill = byKey.get('branch:develop')!;
		expect(pill).toMatchObject({ ...geo.lanes[1]!.label, fill: sceneColor(DIAGRAM_SCENE_LIGHT_THEME, 1) });

		// Commits on Mermaid's positions.
		const bullets = marks.filter((m) => m.role === 'commit');
		expect(bullets.map((m) => m.target)).toEqual(['init', 'feat', 'c3', 'c4']);
		expect(bullets.slice(0, 3).map((m) => m.kind === 'circle' && [m.cx, m.cy])).toEqual([
			[10, -2],
			[60, 88],
			[110, -2]
		]);
		// The merge has an inner dot; the highlight is a square with an inner square.
		expect(byKey.get('commit-inner:c3')).toMatchObject({ kind: 'circle', cx: 110, cy: -2, r: 6 });
		expect(byKey.get('commit:c4')).toMatchObject({ kind: 'rect', x: 150, y: -12, width: 20, height: 20 });
		expect(byKey.get('commit-inner:c4')).toMatchObject({ kind: 'rect', x: 154, y: -8 });
		// Labels: explicit ids and the highlight's generated one, not the auto merge.
		const labels = marks.filter((m) => m.role === 'commit-label');
		expect(labels.map((m) => m.kind === 'text' && [m.target, m.text, m.rotate])).toEqual([
			['init', 'init', -45],
			['feat', 'feat', -45],
			['c4', 'c4', -45]
		]);
		// The tag on feat.
		expect(byKey.get('tag-label:feat:0')).toMatchObject({ kind: 'text', text: 'v0.1', x: 60 });
		expect(byKey.get('tag:feat:0')).toMatchObject({ kind: 'path', target: 'feat' });

		// Mermaid's links: thick, in the merged branch's colour, with its arc.
		const merge = doc.graph.edges.find((e) => e.source === 'feat' && e.target === 'c3')!;
		const link = byKey.get(`arrow:${merge.id}`)!;
		expect(link).toMatchObject({
			kind: 'path',
			target: merge.id,
			d: 'M 60 88 L 90 88 A 20 20, 0, 0, 0, 110 68 L 110 -2',
			stroke: sceneColor(DIAGRAM_SCENE_LIGHT_THEME, 1),
			strokeWidth: 8,
			box: { x: 60, y: -2, width: 50, height: 90 }
		});
		expect(marks.filter((m) => m.role === 'parent-link')).toHaveLength(4);
		// Lanes under links under pills under commits.
		const first = (role: string) => marks.findIndex((m) => m.role === role);
		expect(first('lane')).toBeLessThan(first('parent-link'));
		expect(first('parent-link')).toBeLessThan(first('branch'));
		expect(first('branch')).toBeLessThan(first('commit'));
	});

	it('draws reverse and cherry-pick symbols and vertical tags', () => {
		const types = scene(SOURCES.types);
		expect(types.marks.find((m) => m.key === 'commit-reverse:d')).toMatchObject({ kind: 'path', target: 'd', strokeWidth: 3 });
		const tb = scene(SOURCES.cherryTB);
		const geo = gitGraphGeometry(tb.doc.graph);
		expect(geo.direction).toBe('TB');
		const pick = [...geo.commits.values()].find((c) => c.symbol === 'CHERRY_PICK')!;
		const cherry = tb.marks.filter((m) => m.target === pick.id);
		expect(cherry.map((m) => m.role)).toEqual(expect.arrayContaining(['commit', 'cherry', 'cherry-stem', 'tag', 'tag-label']));
		// Cherry-picks print no commit label; their tag is the user's tag.
		expect(cherry.some((m) => m.role === 'commit-label')).toBe(false);
		expect(cherry.find((m) => m.role === 'tag-label')).toMatchObject({ text: 'picked', rotate: 45 });
		// Vertical lanes run along y at each branch's x.
		for (const lane of geo.lanes) {
			const m = tb.marks.find((x) => x.key === `lane:${lane.branch}`)!;
			expect(m).toMatchObject({ x1: lane.line.x1, x2: lane.line.x1, y1: lane.line.y1, y2: lane.line.y2 });
		}
		const bt = scene(SOURCES.lanesBT);
		const btGeo = gitGraphGeometry(bt.doc.graph);
		expect(bt.marks.filter((m) => m.role === 'branch').map((m) => m.target)).toEqual(btGeo.lanes.map((l) => l.branch));
		expect(bt.marks.find((m) => m.role === 'tag-label' && m.target === [...btGeo.commits.values()].find((c) => c.symbol === 'CHERRY_PICK')!.id)).toMatchObject({ text: 'cherry-pick:b' });
	});
});
