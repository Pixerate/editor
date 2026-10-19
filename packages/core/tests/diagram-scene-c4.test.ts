// @vitest-environment jsdom
// Ported in intent from Ursula (src/react/canvases/c4.test.ts): what the C4 canvas draws.
import { describe, expect, it } from 'vitest';
import { FAMILY_TEMPLATES, parseMermaid } from '../src/diagram';
import { DIAGRAM_SCENE_LIGHT_THEME, DIAGRAM_TITLE_TARGET, ensureDiagramLayout, type DiagramMark } from '../src/canvas';
import { c4Scene } from '../src/canvas/mermaid/families/c4';

const DYNAMIC = [
	'C4Dynamic',
	'  title Portal',
	'  Person(user, "User", "Uses the portal")',
	'  System_Boundary(sb, "Portal") {',
	'    Container(web, "Web app", "React", "The UI")',
	'    ContainerDb(db, "Database", "Postgres")',
	'  }',
	'  System_Ext(idp, "IdP")',
	'  Rel(user, web, "Uses", "HTTPS")',
	'  BiRel(web, db, "Reads")'
].join('\n');

const CONTAINERS = `C4Container
  title Containers
  Person(user, "User")
  System_Boundary(sb, "Portal") {
    Container(web, "Web app", "React", "The UI")
    ContainerDb(db, "Database", "Postgres", "Stores diagrams")
    ContainerQueue(q, "Queue", "SQS")
  }
  System_Ext(idp, "IdP")
  Rel(user, web, "Uses", "HTTPS")
  Rel(web, db, "Reads/writes")
  BiRel(web, idp, "Authenticates")
  Rel_Back(db, web, "Notifies")
  UpdateRelStyle(user, web, $textColor="blue", $offsetY="-10")
  UpdateElementStyle(idp, $bgColor="red")
`;

const DEPLOYMENT = `C4Deployment
  title Deployment
  Deployment_Node(d, "D", "k8s", "Cluster") {
    Container(api, "API", "Go")
  }
`;

function scene(src: string) {
	const doc = parseMermaid(src);
	const layout = ensureDiagramLayout(doc.graph, doc.meta, { family: doc.family });
	const marks = c4Scene({ graph: doc.graph, layout, theme: DIAGRAM_SCENE_LIGHT_THEME, selection: new Set() });
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

describe('c4Scene', () => {
	for (const [name, src] of [['template', FAMILY_TEMPLATES.c4!], ['dynamic', DYNAMIC], ['containers', CONTAINERS], ['deployment', DEPLOYMENT]] as const) {
		it(`draws every element, boundary and relation (${name})`, () => {
			const { doc, layout, marks } = scene(src);
			expect(doc.family).toBe('c4');
			const targets = new Set(marks.map((m) => m.target));
			for (const n of doc.graph.nodes) expect(targets.has(n.id), n.id).toBe(true);
			for (const g of doc.graph.groups) expect(targets.has(g.id), g.id).toBe(true);
			for (const e of doc.graph.edges) expect(targets.has(e.id), e.id).toBe(true);
			const keys = marks.map((m) => m.key);
			expect(new Set(keys).size).toBe(keys.length);
			for (const m of marks) {
				expect(m.role).toBeTruthy();
				expect(m.selected).toBeUndefined();
				for (const v of numbers(m)) expect(Number.isFinite(v), `${m.key}`).toBe(true);
			}
			const title = marks.find((m) => m.role === 'title');
			expect(title?.target).toBe(DIAGRAM_TITLE_TARGET);
			// Boxes sit at the layout's positions.
			for (const n of doc.graph.nodes) {
				const [x, y] = layout.positions[n.id]!;
				const shape = marks.find((m) => m.key === `element:${n.id}`)!;
				if (shape.kind === 'rect' && n.shape !== 'c4-person') expect([shape.x, shape.y]).toEqual([x, y]);
				if (shape.kind === 'path') expect(shape.box).toMatchObject({ x, y, width: layout.sizes[n.id]!.width, height: layout.sizes[n.id]!.height });
			}
			for (const g of doc.graph.groups) {
				const frame = marks.find((m) => m.key === `boundary:${g.id}`)!;
				expect(frame).toMatchObject({ kind: 'rect', x: layout.positions[g.id]![0], y: layout.positions[g.id]![1], width: layout.sizes[g.id]!.width });
			}
		});
	}

	it("draws Mermaid's shapes, text parts and boundary labels", () => {
		const { marks, layout } = scene(DYNAMIC);
		// Person: head over a rounded body; DB: cylinder; container: rounded rectangle.
		expect(marks.filter((m) => m.target === 'user' && m.role === 'element').map((m) => m.kind)).toEqual(['rect', 'circle']);
		const db = marks.find((m) => m.key === 'element:db')!;
		expect(db.kind).toBe('path');
		expect(marks.find((m) => m.key === 'element:web')).toMatchObject({ kind: 'rect', radius: 12, fill: '#438dd5', width: 216 });
		expect(texts(marks, 'web')).toEqual(['Web app', '[Container: React]', 'The UI']);
		expect(marks.find((m) => m.key === 'element-label:web:0')).toMatchObject({ weight: 700 });
		// External elements are grey.
		expect(marks.find((m) => m.key === 'element:idp')).toMatchObject({ fill: '#999999' });
		expect(texts(marks, 'sb')).toEqual(['Portal', '[SYSTEM]']);
		expect(marks.find((m) => m.key === 'boundary:sb')).toMatchObject({ dash: '7 7', height: layout.sizes.sb!.height });
		expect(texts(marks, DIAGRAM_TITLE_TARGET)).toEqual(['Portal']);
	});

	it('numbers C4Dynamic relations, draws the first straight and the others curved', () => {
		const { doc, marks } = scene(DYNAMIC);
		const [first, second] = doc.graph.edges;
		expect(texts(marks, first!.id)).toEqual(['1: Uses', '[HTTPS]']);
		expect(texts(marks, second!.id)).toEqual(['2: Reads']);
		const line = (id: string) => marks.find((m) => m.key === `relation:${id}`) as Extract<DiagramMark, { kind: 'path' }>;
		expect(line(first!.id).d).toMatch(/^M[\d.,-]+ L/);
		expect(line(second!.id).d).toMatch(/ Q/);
		// BiRel: heads at both ends; Rel only at the end.
		expect(marks.filter((m) => m.target === second!.id && m.role === 'arrow')).toHaveLength(2);
		expect(marks.filter((m) => m.target === first!.id && m.role === 'arrow').map((m) => m.key)).toEqual([`arrow-end:${first!.id}`]);
		const context = scene(DYNAMIC.replace('C4Dynamic', 'C4Container'));
		expect(texts(context.marks, first!.id)).toEqual(['Uses', '[HTTPS]']);
	});

	it('applies UpdateElementStyle / UpdateRelStyle and draws queues and solid deployment nodes', () => {
		const { doc, marks } = scene(CONTAINERS);
		expect(marks.find((m) => m.key === 'element:idp')).toMatchObject({ fill: 'red' });
		const uses = doc.graph.edges.find((e) => e.source === 'user')!;
		expect(marks.find((m) => m.key === `relation-label:${uses.id}`)).toMatchObject({ fill: 'blue' });
		const back = doc.graph.edges.find((e) => e.data?.kind === 'Rel_Back')!;
		expect(marks.filter((m) => m.target === back.id && m.role === 'arrow').map((m) => m.key)).toEqual([`arrow-start:${back.id}`]);
		expect(marks.find((m) => m.key === 'element:q')).toMatchObject({ kind: 'path' });
		// Relation labels are drawn over the elements.
		const lastElement = Math.max(...marks.map((m, i) => (m.role.startsWith('element') ? i : -1)));
		expect(marks.findIndex((m) => m.role === 'relation-label')).toBeGreaterThan(lastElement);

		const deploy = scene(DEPLOYMENT).marks;
		expect(deploy.find((m) => m.key === 'boundary:d')).toMatchObject({ dash: undefined });
		expect(texts(deploy, 'd')).toEqual(['D', '[k8s]', 'Cluster']);
	});

	it('draws no title when there is none', () => {
		const { marks } = scene('C4Context\n  Person(a, "A")\n');
		expect(marks.some((m) => m.target === DIAGRAM_TITLE_TARGET)).toBe(false);
		expect(marks.some((m) => m.target === 'a')).toBe(true);
	});
});
