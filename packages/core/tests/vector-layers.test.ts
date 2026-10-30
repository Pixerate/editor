import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import { createVectorCommands, VectorEditorController, vectorLayerName, vectorLayerRows, vectorWorldMatrix, type VectorDocument, type VectorNode } from '../src/vector';

const rect = (id: string, extra: Partial<VectorNode> = {}): VectorNode =>
	({
		id,
		type: 'path',
		subpaths: [{ closed: true, anchors: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }],
		fill: '#000',
		...extra,
	}) as VectorNode;

const doc = (nodes: VectorNode[]): VectorDocument => ({ width: 100, height: 100, nodes });

describe('vector layer rows', () => {
	const nodes: VectorNode[] = [
		rect('a', { name: 'Bottom' }),
		{ id: 'g', type: 'group', children: [rect('b'), rect('c', { visible: false, locked: true })] } as VectorNode,
	];

	it('lists nodes top first, groups collapsed', () => {
		const rows = vectorLayerRows(nodes);
		expect(rows.map((r) => r.id)).toEqual(['g', 'a']);
		expect(rows[0]).toMatchObject({ kind: 'group', name: 'Group', childCount: 2, expanded: false, depth: 0 });
		expect(rows[1].name).toBe('Bottom');
	});

	it('indents an expanded group’s children', () => {
		const rows = vectorLayerRows(nodes, (id) => id === 'g');
		expect(rows.map((r) => [r.id, r.depth, r.parentId])).toEqual([
			['g', 0, null],
			['c', 1, 'g'],
			['b', 1, 'g'],
			['a', 0, null],
		]);
		expect(rows[1]).toMatchObject({ visible: false, locked: true, name: 'Path' });
	});

	it('leaves out a blend’s generated steps', () => {
		const blend = { id: 'bl', type: 'group', blend: { steps: 1 }, children: [rect('k1'), rect('s', { blendStep: true }), rect('k2')] } as unknown as VectorNode;
		const rows = vectorLayerRows([blend], () => true);
		expect(rows.map((r) => r.id)).toEqual(['bl', 'k2', 'k1']);
		expect(rows[0].childCount).toBe(2);
	});

	it('names text by its words', () => {
		const text = { id: 't', type: 'text', text: '  Hello\n world ', font: {}, frame: {} } as unknown as VectorNode;
		expect(vectorLayerName(text)).toBe('Hello world');
	});
});

describe('VectorEditorController.reorderNode', () => {
	it('moves a node among its siblings as one undo step', () => {
		const c = new VectorEditorController({ document: doc([rect('a'), rect('b'), rect('c')]) });
		expect(c.reorderNode('c', 0).ok).toBe(true);
		expect(c.getDocument().nodes.map((n) => n.id)).toEqual(['c', 'a', 'b']);
		c.undo();
		expect(c.getDocument().nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
	});

	it('moves inside a group and clamps the index', () => {
		const c = new VectorEditorController({ document: doc([{ id: 'g', type: 'group', children: [rect('a'), rect('b')] } as VectorNode]) });
		expect(c.reorderNode('a', 9).ok).toBe(true);
		const g = c.getDocument().nodes[0] as Extract<VectorNode, { type: 'group' }>;
		expect(g.children.map((n) => n.id)).toEqual(['b', 'a']);
	});

	it('refuses unknown nodes', () => {
		const c = new VectorEditorController({ document: doc([rect('a')]) });
		expect(c.reorderNode('zz', 0).ok).toBe(false);
	});
});

type Group = Extract<VectorNode, { type: 'group' }>;
const ids = (nodes: readonly VectorNode[]) => nodes.map((n) => n.id);
const firstAnchor = (c: VectorEditorController, id: string) => {
	const m = vectorWorldMatrix(c.getDocument().nodes, id)!;
	const n = c.getNode(id) as Extract<VectorNode, { type: 'path' }>;
	const a = n.subpaths[0].anchors[1];
	return { x: m[0] * a.x + m[2] * a.y + m[4], y: m[1] * a.x + m[3] * a.y + m[5] };
};

describe('VectorEditorController.moveNode', () => {
	it('moves a node into a group at an index, as one undo step', () => {
		const c = new VectorEditorController({ document: doc([rect('a'), { id: 'g', type: 'group', children: [rect('b'), rect('c')] } as VectorNode]) });
		expect(c.moveNode('a', { parentId: 'g', index: 1 }).ok).toBe(true);
		expect(ids(c.getDocument().nodes)).toEqual(['g']);
		expect(ids((c.getDocument().nodes[0] as Group).children)).toEqual(['b', 'a', 'c']);
		c.undo();
		expect(ids(c.getDocument().nodes)).toEqual(['a', 'g']);
	});

	it('moves a node out to the top level, on top by default', () => {
		const c = new VectorEditorController({ document: doc([{ id: 'g', type: 'group', children: [rect('b'), rect('c')] } as VectorNode, rect('a')]) });
		expect(c.moveNode('b', { parentId: null }).ok).toBe(true);
		expect(ids(c.getDocument().nodes)).toEqual(['g', 'a', 'b']);
		expect(ids((c.getDocument().nodes[0] as Group).children)).toEqual(['c']);
	});

	it('keeps the node where it is on the canvas across group transforms', () => {
		const g = { id: 'g', type: 'group', transform: [2, 0, 0, 2, 30, 10], children: [rect('b')] } as unknown as VectorNode;
		const h = { id: 'h', type: 'group', transform: [1, 0, 0, 1, -5, 7], children: [] } as unknown as VectorNode;
		const c = new VectorEditorController({ document: doc([g, h]) });
		const before = firstAnchor(c, 'b');
		expect(c.moveNode('b', { parentId: 'h' }).ok).toBe(true);
		const after = firstAnchor(c, 'b');
		expect(after.x).toBeCloseTo(before.x);
		expect(after.y).toBeCloseTo(before.y);
	});

	it('moves a node out of a nested group into the group that holds it', () => {
		const inner = { id: 'in', type: 'group', children: [rect('a'), rect('b')] } as VectorNode;
		const c = new VectorEditorController({ document: doc([{ id: 'out', type: 'group', children: [inner] } as VectorNode]) });
		expect(c.moveNode('a', { parentId: 'out', index: 0 }).ok).toBe(true);
		const out = c.getDocument().nodes[0] as Group;
		expect(ids(out.children)).toEqual(['a', 'in']);
		expect(ids((out.children[1] as Group).children)).toEqual(['b']);
	});

	it('refuses moves into itself, into a non-group, or in or out of a clipping group', () => {
		const masked = { id: 'm', type: 'group', mask: { type: 'clip' }, children: [rect('k'), rect('s')] } as unknown as VectorNode;
		const c = new VectorEditorController({ document: doc([{ id: 'g', type: 'group', children: [rect('a')] } as VectorNode, rect('b'), masked]) });
		expect(c.moveNode('g', { parentId: 'g' }).ok).toBe(false);
		expect(c.moveNode('a', { parentId: 'b' }).ok).toBe(false);
		expect(c.moveNode('b', { parentId: 'm' }).ok).toBe(false);
		expect(c.moveNode('k', { parentId: null }).ok).toBe(false);
	});
});

describe('vector.moveLayer command', () => {
	it('moves a layer through the tool registry', async () => {
		const c = new VectorEditorController({ document: doc([rect('a'), { id: 'g', type: 'group', children: [rect('b')] } as VectorNode]) });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const run = (params: unknown) => tools.callTool('run_command', { id: 'vector.moveLayer', params });
		expect((await run({ id: 'a', parentId: 'g', index: 0 })).isError).toBeFalsy();
		expect(ids((c.getDocument().nodes[0] as Group).children)).toEqual(['a', 'b']);
		expect((await run({ id: 'a', parentId: 'zz' })).isError).toBe(true);
	});
});
