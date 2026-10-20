// Rendering performance: render data reused per node object, viewport culling and level of
// detail. The approach follows ArtCraft figcraft `render/retained.rs` (retained per-node render
// state, only changed nodes rebuilt), designcraft `render/damage.rs` (drawing only what the view
// needs) and figcraft `render/lod.rs` (subtrees under 2 px drawn simplified) (MIT OR Apache-2.0,
// © ArtCraft Team and contributors); test cases our own. See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import { VectorEditorController, getVectorSceneRenderData, rectSubpath, type VectorDocument, type VectorGroupNode, type VectorNode, type VectorPathNode, type VectorRenderPath } from '../src/vector';

const rect = (id: string, x: number, y: number, w: number, extra: Partial<VectorPathNode> = {}): VectorPathNode => ({ id, type: 'path', subpaths: [rectSubpath({ x, y, width: w, height: w })], fill: '#ff0000', stroke: null, ...extra });
const doc = (...nodes: VectorNode[]): VectorDocument => ({ width: 1000, height: 1000, nodes });
const view = { x: 0, y: 0, zoom: 1 };

describe('render data reuse', () => {
	it('hands back the same render object for a node an edit did not touch', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 10), rect('b', 50, 0, 10, { fill: { type: 'linear', stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] } })) });
		const first = getVectorSceneRenderData(c.getState());
		c.select(['a']);
		c.translate(5, 0);
		const second = getVectorSceneRenderData(c.getState());
		expect(second.nodes[0]).not.toBe(first.nodes[0]);
		expect(second.nodes[1]).toBe(first.nodes[1]);
		// The untouched node's gradient comes along every time.
		expect(second.defs.map((d) => d.id)).toEqual(first.defs.map((d) => d.id));
	});

	it('keeps editors apart by id prefix', () => {
		const d = doc(rect('a', 0, 0, 10, { fill: { type: 'linear', stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] } }));
		const one = getVectorSceneRenderData({ document: d, viewport: view }, { idPrefix: 'one-' });
		const two = getVectorSceneRenderData({ document: d, viewport: view }, { idPrefix: 'two-' });
		expect(one.defs[0].id.startsWith('one-')).toBe(true);
		expect(two.defs[0].id.startsWith('two-')).toBe(true);
	});
});

describe('viewport culling and level of detail', () => {
	const group = (id: string, x: number, w: number): VectorGroupNode => ({ id, type: 'group', children: [rect(`${id}-1`, x, x, w), rect(`${id}-2`, x + w, x, w, { fill: '#00ff00' })] });

	it('leaves out top-level nodes off screen, only when the canvas size is given', () => {
		const d = doc(rect('in', 10, 10, 10), rect('out', 900, 900, 10), rect('edge', 199, 10, 10));
		const scene = getVectorSceneRenderData({ document: d, viewport: view }, { viewportSize: { width: 200, height: 200 } });
		expect(scene.nodes.map((n) => n.id)).toEqual(['in', 'edge']);
		expect(scene.stats).toEqual({ nodes: 3, culled: 1, collapsed: 0 });
		// Exports (no size) draw everything.
		expect(getVectorSceneRenderData({ document: d, viewport: view }).nodes).toHaveLength(3);
		// Panned so the far one shows.
		const panned = getVectorSceneRenderData({ document: d, viewport: { x: -850, y: -850, zoom: 1 } }, { viewportSize: { width: 200, height: 200 } });
		expect(panned.nodes.map((n) => n.id)).toEqual(['out']);
	});

	it('culls through the spatial index on large documents with the same result', () => {
		const many = Array.from({ length: 600 }, (_, i) => rect(`n${i}`, (i % 30) * 30, Math.floor(i / 30) * 30, 20));
		const scene = getVectorSceneRenderData({ document: doc(...many), viewport: view }, { viewportSize: { width: 300, height: 300 } });
		const expected = many.filter((n) => {
			const [x, y] = [n.subpaths[0].anchors[0].x, n.subpaths[0].anchors[0].y];
			return x <= 302 && y <= 302;
		});
		expect(scene.nodes.map((n) => n.id)).toEqual(expected.map((n) => n.id));
	});

	it('draws a group smaller than 2 screen pixels as one rectangle in its main colour', () => {
		const d = doc(group('tiny', 100, 10), group('big', 300, 100));
		const far = getVectorSceneRenderData({ document: d, viewport: { x: 0, y: 0, zoom: 0.05 } }, { viewportSize: { width: 1000, height: 1000 } });
		const tiny = far.nodes.find((n) => n.id === 'tiny') as VectorRenderPath;
		expect(tiny.kind).toBe('path');
		expect(tiny.fill).toBe('#ff0000');
		expect(tiny.d).toBe('M100 100H120V110H100Z');
		expect(far.nodes.find((n) => n.id === 'big')!.kind).toBe('group');
		expect(far.stats.collapsed).toBe(1);
		// lod 0 turns it off; zoomed in it draws in full.
		expect(getVectorSceneRenderData({ document: d, viewport: { x: 0, y: 0, zoom: 0.05 } }, { viewportSize: { width: 1000, height: 1000 }, lod: 0 }).stats.collapsed).toBe(0);
		expect(getVectorSceneRenderData({ document: d, viewport: view }, { viewportSize: { width: 1000, height: 1000 } }).nodes.find((n) => n.id === 'tiny')!.kind).toBe('group');
	});
});
