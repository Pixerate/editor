// @vitest-environment jsdom
// Ported in intent from Ursula (src/react/canvases/architecture.test.ts): what the architecture canvas draws.
import { describe, expect, it } from 'vitest';
import { FAMILY_TEMPLATES, parseMermaid } from '../src/diagram';
import { ARCH_METRICS, architectureArrow } from '../src/diagram/architecture/geometry';
import { DIAGRAM_SCENE_LIGHT_THEME, DIAGRAM_TITLE_TARGET, ensureDiagramLayout, type DiagramMark } from '../src/canvas';
import { architectureScene } from '../src/canvas/mermaid/families/architecture';

const SRC = [
	'architecture-beta',
	'  title Platform',
	'  group api(cloud)[API tier]',
	'  service db(database)[Postgres] in api',
	'  service server(server)[App server] in api',
	'  service fn(logos:aws-lambda)[Lambda]',
	'  service gateway(internet)[Gateway]',
	'  junction hub',
	'  gateway:R --> L:server',
	'  server:B <--> T:db',
	'  server:R -- L:hub',
	'  hub:B -[calls]- T:fn'
].join('\n');

const NESTED = `architecture-beta
  group outer(cloud)[Outer]
  group inner[Inner] in outer
  service disk1(disk)[Disk] in inner
  service blank1[Blank] in outer
  service plain
  disk1:R --> L:blank1
  blank1{group}:B --> T:plain
`;

function scene(src: string) {
	const doc = parseMermaid(src);
	const layout = ensureDiagramLayout(doc.graph, doc.meta, { family: doc.family });
	const marks = architectureScene({ graph: doc.graph, layout, theme: DIAGRAM_SCENE_LIGHT_THEME, selection: new Set() });
	return { doc, layout, marks };
}

function numbers(m: DiagramMark): number[] {
	const out: number[] = [];
	for (const v of Object.values(m)) {
		if (typeof v === 'number') out.push(v);
		else if (v && typeof v === 'object') out.push(...Object.values(v).filter((x): x is number => typeof x === 'number'));
	}
	if (m.kind === 'path') out.push(...(m.d.match(/-?\d*\.?\d+(?:e-?\d+)?|NaN/gi) ?? []).map(Number));
	return out;
}

const texts = (marks: DiagramMark[], target?: string) =>
	marks.filter((m): m is Extract<DiagramMark, { kind: 'text' }> => m.kind === 'text' && (target === undefined || m.target === target)).map((m) => m.text);

describe('architectureScene', () => {
	for (const [name, src] of [['template', FAMILY_TEMPLATES.architecture!], ['ursula', SRC], ['nested', NESTED]] as const) {
		it(`draws every service, junction, group and edge (${name})`, () => {
			const { doc, layout, marks } = scene(src);
			expect(doc.family).toBe('architecture');
			const targets = new Set(marks.map((m) => m.target));
			for (const n of doc.graph.nodes) expect(targets.has(n.id), n.id).toBe(true);
			for (const g of doc.graph.groups) expect(targets.has(g.id), g.id).toBe(true);
			for (const e of doc.graph.edges) expect(targets.has(e.id), e.id).toBe(true);
			const keys = marks.map((m) => m.key);
			expect(new Set(keys).size).toBe(keys.length);
			for (const m of marks) {
				expect(m.role).toBeTruthy();
				expect(m.selected).toBeUndefined();
				for (const v of numbers(m)) expect(Number.isFinite(v), m.key).toBe(true);
				// Paths are absolute (M/L/C/Q/Z) so their bounds can be read from `d`.
				if (m.kind === 'path' && !m.box) expect(m.d).toMatch(/^[MLCQZ\d\s.,-]+$/);
			}
			if (doc.graph.title) expect(marks.find((m) => m.role === 'title')?.target).toBe(DIAGRAM_TITLE_TARGET);
			for (const n of doc.graph.nodes) {
				const [x, y] = layout.positions[n.id]!;
				const first = marks.find((m) => m.target === n.id)!;
				if (first.kind === 'rect' || first.kind === 'path') {
					const at = first.kind === 'rect' ? [first.x, first.y] : first.d.match(/^M([\d.-]+),([\d.-]+)/)!.slice(1).map(Number);
					expect(at[0]).toBeCloseTo(x, 1);
					if (first.kind === 'rect') expect(at[1]).toBeCloseTo(y, 1);
				} else if (first.kind === 'circle') {
					expect(first.cx).toBeCloseTo(x + layout.sizes[n.id]!.width / 2, 5);
					expect(first.cy).toBeCloseTo(y + layout.sizes[n.id]!.height / 2, 5);
				}
			}
			for (const g of doc.graph.groups)
				expect(marks.find((m) => m.key === `group:${g.id}`)).toMatchObject({ kind: 'rect', x: layout.positions[g.id]![0], y: layout.positions[g.id]![1], width: layout.sizes[g.id]!.width, height: layout.sizes[g.id]!.height, dash: '8' });
		});
	}

	it('draws icons, labels, junctions, titles and heads like the canvas', () => {
		const { doc, layout, marks } = scene(SRC);
		// Built-in icons: the blue square with the glyph.
		expect(marks.find((m) => m.key === 'icon:service:db')).toMatchObject({ kind: 'rect', width: 80, height: 80, fill: '#087ebf' });
		expect(marks.filter((m) => m.target === 'db' && m.role === 'icon-glyph').length).toBeGreaterThan(3);
		// An icon from an icon pack shows its name on the square.
		expect(texts(marks, 'fn').join('')).toContain('logos:aws-lambda');
		expect(texts(marks, 'fn')).toContain('Lambda');
		expect(texts(marks, 'db')).toEqual(['Postgres']);
		// Groups: icon and label at the top-left.
		expect(texts(marks, 'api')).toEqual(['API tier']);
		expect(marks.find((m) => m.key === 'icon:group:api')).toMatchObject({ width: ARCH_METRICS.groupIconSize, x: layout.positions.api![0] + 1 });
		expect(marks.find((m) => m.key === 'group-label:api')).toMatchObject({ x: layout.positions.api![0] + ARCH_METRICS.groupIconSize + 4 });
		// The junction is a point.
		const dot = marks.find((m) => m.key === 'junction-dot:hub') as Extract<DiagramMark, { kind: 'circle' }>;
		expect(dot.r).toBeLessThan(10);
		// Heads: `-->` at the end, `<-->` both, `--` none.
		const [toServer, toDb, toHub, toFn] = doc.graph.edges;
		const heads = (id: string) => marks.filter((m) => m.target === id && m.role === 'arrow').map((m) => m.key.split(':')[0]);
		expect(heads(toServer!.id)).toEqual(['arrow-end']);
		expect(heads(toDb!.id)).toEqual(['arrow-start', 'arrow-end']);
		expect(heads(toHub!.id)).toEqual([]);
		expect(heads(toFn!.id)).toEqual([]);
		// The server's left port: the arrowhead tip sits at the icon's left side.
		const [sx, sy] = layout.positions.server!;
		expect((marks.find((m) => m.key === `arrow-end:${toServer!.id}`) as { d: string }).d).toBe(`M${architectureArrow({ x: sx, y: sy + 40 }, 'L').split(' ').join(' L')} Z`);
		// Edge titles run along vertical lines.
		expect(marks.find((m) => m.key === `edge-label:${toFn!.id}`)).toMatchObject({ text: 'calls', rotate: -90 });
		expect(texts(marks, DIAGRAM_TITLE_TARGET)).toEqual(['Platform']);
	});

	it('draws a dashed outline for services without an icon and skips untitled labels', () => {
		const { marks } = scene(NESTED);
		expect(marks.find((m) => m.key === 'icon:service:blank1')).toMatchObject({ kind: 'path', fill: 'none', dash: '8' });
		expect(marks.find((m) => m.key === 'icon:service:plain')).toMatchObject({ kind: 'path' });
		expect(texts(marks, 'plain')).toEqual([]);
		expect(texts(marks, 'inner')).toEqual(['Inner']);
		// Outer groups are drawn before the groups inside them.
		expect(marks.findIndex((m) => m.key === 'group:outer')).toBeLessThan(marks.findIndex((m) => m.key === 'group:inner'));
	});
});
