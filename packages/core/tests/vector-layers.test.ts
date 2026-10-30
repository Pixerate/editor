import { describe, expect, it } from 'vitest';
import { VectorEditorController, vectorLayerName, vectorLayerRows, type VectorDocument, type VectorNode } from '../src/vector';

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
