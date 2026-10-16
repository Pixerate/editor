/**
 * Pathfinder operations, the Shape Builder tool and the paint bucket in the vector editor.
 *
 * Shape Builder cases re-expressed from vectorcraft-main/crates/engine/src/tests_build.rs and
 * figcraft-main/crates/engine/src/shapebuilder.rs tests (MIT OR Apache-2.0, © ArtCraft Team and
 * contributors). See THIRD_PARTY_NOTICES.md.
 */
import { describe, expect, it } from 'vitest';
import {
	createVectorCommands,
	getVectorOverlayRenderData,
	rectSubpath,
	rotateMatrix,
	VectorEditorController,
	type VectorDocument,
	type VectorGroupNode,
	type VectorNode,
	type VectorPathNode,
	type VectorSubpath
} from '../src/vector/index.js';
import { CommandRegistry } from '../src/commands/index.js';
import { bezierPathArea, pointInBezierPath } from '../src/canvas/pathops/index.js';
import { subpathsToBezier, vectorPathWorldBezier, vectorParentMatrix, IDENTITY_MATRIX } from '../src/vector/geometry.js';

const pathNode = (id: string, subpaths: VectorSubpath[], extra: Partial<VectorPathNode> = {}): VectorPathNode => ({ id, type: 'path', subpaths, fill: '#ff0000', stroke: null, ...extra });
const rectNode = (id: string, x: number, y: number, w = 100, h = 100, extra: Partial<VectorPathNode> = {}) => pathNode(id, [rectSubpath({ x, y, width: w, height: h })], extra);
const lineNode = (id: string, pts: [number, number][], extra: Partial<VectorPathNode> = {}) =>
	pathNode(id, [{ anchors: pts.map(([x, y]) => ({ x, y })), closed: false }], { fill: null, stroke: '#000000', ...extra });
const doc = (...nodes: VectorNode[]): VectorDocument => ({ width: 400, height: 300, nodes });

let n = 0;
const make = (document?: VectorDocument, extra: ConstructorParameters<typeof VectorEditorController>[0] = {}) =>
	new VectorEditorController({ document, createId: () => `id${++n}`, ...extra });
const path = (c: VectorEditorController, id: string) => c.getNode(id) as VectorPathNode;
/** A path's filled area in document space. */
const worldPath = (c: VectorEditorController, id: string) => vectorPathWorldBezier(path(c, id), vectorParentMatrix(c.getDocument().nodes, id) ?? IDENTITY_MATRIX);
const area = (c: VectorEditorController, id: string) => bezierPathArea(worldPath(c, id));
const covers = (c: VectorEditorController, id: string, x: number, y: number) => pointInBezierPath(worldPath(c, id), [x, y]);
const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);
const pathsIn = (nodes: readonly VectorNode[]): VectorPathNode[] => nodes.flatMap((node) => (node.type === 'path' ? [node] : pathsIn(node.children)));

describe('pathfinder', () => {
	it('divide splits overlapping shapes into faces painted like their top-most shape, grouped in place', () => {
		const c = make(doc(rectNode('a', 0, 0), rectNode('b', 50, 50, 100, 100, { fill: '#0000ff' }), rectNode('c', 300, 0, 10, 10)));
		c.select(['a', 'b']);
		const ids = c.pathfinder('divide');
		expect(ids).toHaveLength(3);
		const nodes = c.getDocument().nodes;
		expect(nodes).toHaveLength(2);
		expect(nodes[0].type).toBe('group');
		expect((nodes[0] as VectorGroupNode).name).toBe('Divide');
		expect(nodes[1].id).toBe('c');
		const overlap = ids.find((id) => covers(c, id, 75, 75))!;
		expect(path(c, overlap).fill).toBe('#0000ff');
		near(area(c, overlap), 2500);
		expect(path(c, ids.find((id) => covers(c, id, 10, 10))!).fill).toBe('#ff0000');
		expect(c.getState().selection).toEqual([nodes[0].id]);
		expect(c.getState().undoLabel).toBe('Divide');
		c.undo();
		expect(c.getDocument().nodes.map((x) => x.id)).toEqual(['a', 'b', 'c']);
	});

	it('works on rotated operands in document space, and keeps holes', () => {
		// A ring, and a 40 × 40 square rotated 45° about its centre (100, 50), over the ring's right side.
		const ring = pathNode('ring', [rectSubpath({ x: 0, y: 0, width: 100, height: 100 }), { ...rectSubpath({ x: 30, y: 30, width: 40, height: 40 }), anchors: [...rectSubpath({ x: 30, y: 30, width: 40, height: 40 }).anchors].reverse() }]);
		const diamond = rectNode('d', -20, -20, 40, 40, { fill: '#00ff00', transform: [...rotateMatrix(45)].map((v, i) => (i === 4 ? 100 : i === 5 ? 50 : v)) as unknown as VectorPathNode['transform'] });
		const c = make(doc(ring, diamond));
		c.select(['ring', 'd']);
		const ids = c.pathfinder('trim');
		expect(ids).toHaveLength(2);
		const [ringPart, diamondPart] = ids;
		// The diamond's left half (a triangle of area 800) is cut out of the ring.
		near(area(c, ringPart), 10000 - 1600 - 800, 1e-3);
		near(area(c, diamondPart), 1600, 1e-3);
		expect(covers(c, ringPart, 50, 50)).toBe(false);
		expect(covers(c, ringPart, 95, 50)).toBe(false);
		expect(covers(c, diamondPart, 120, 50)).toBe(true);
		expect(path(c, diamondPart).fill).toBe('#00ff00');
	});

	it('maps results into the parent space of a rotated group', () => {
		const group: VectorGroupNode = { id: 'g', type: 'group', transform: rotateMatrix(30), children: [rectNode('a', 0, 0), rectNode('b', 50, 0)] };
		const c = make(doc(group));
		const before = bezierPathArea(vectorPathWorldBezier(rectNode('x', 0, 0, 150, 100), rotateMatrix(30)));
		const ids = c.pathfinder('merge', { ids: ['a', 'b'] });
		expect(ids).toHaveLength(1);
		const g = c.getNode('g') as VectorGroupNode;
		expect(g.children.map((x) => x.id)).toEqual(ids);
		near(area(c, ids[0]), before, 1e-6);
	});

	it('trim, merge, crop, outline and minus back', () => {
		const shapes = () => doc(rectNode('a', 0, 0), rectNode('b', 50, 50), rectNode('c', 200, 0, 100, 100, { fill: '#00ff00' }));
		let c = make(shapes());
		expect(c.pathfinder('merge', { ids: ['a', 'b', 'c'] })).toHaveLength(2);
		near(pathsIn(c.getDocument().nodes).reduce((s, p) => s + area(c, p.id), 0), 17500 + 10000);

		c = make(shapes());
		const cropped = c.pathfinder('crop', { ids: ['a', 'b'] });
		expect(cropped).toHaveLength(1);
		near(area(c, cropped[0]), 2500);

		c = make(shapes());
		const minus = c.pathfinder('minusBack', { ids: ['a', 'b'] });
		expect(minus).toHaveLength(1);
		near(area(c, minus[0]), 7500);

		c = make(shapes());
		const edges = c.pathfinder('outline', { ids: ['a', 'b'] });
		expect(edges).toHaveLength(4);
		for (const id of edges) {
			const p = path(c, id);
			expect(p.fill).toBeNull();
			expect(p.stroke).toBe('#ff0000');
			expect(p.subpaths.every((s) => !s.closed)).toBe(true);
		}
	});

	it('expands live corners first, and takes a stroke-only shape as its stroke area', () => {
		const rounded = pathNode('r', [rectSubpath({ x: 0, y: 0, width: 100, height: 100 }, 20)]);
		const ring = pathNode('s', [rectSubpath({ x: 40, y: 40, width: 100, height: 100 })], { fill: null, stroke: '#0000ff', strokeWidth: 10, strokeAlign: 'inside' });
		const c = make(doc(rounded, ring));
		const ids = c.pathfinder('divide', { ids: ['r', 's'] });
		const pieces = ids.map((id) => path(c, id));
		const total = ids.reduce((s, id) => s + area(c, id), 0);
		const roundedArea = bezierPathArea(subpathsToBezier(rounded.subpaths));
		expect(roundedArea).toBeLessThan(10000 - 300);
		// The inside stroke paints a 10-wide band inside the square: 100² − 80².
		const band = 10000 - 6400;
		const overlap = 60 * 60 - 50 * 50; // the band's corner inside the rounded square (its rounded corner lies inside the band's hole)
		near(total, roundedArea + band - overlap, 1e-3);
		const bandPiece = ids.find((id) => covers(c, id, 135, 135))!;
		expect(path(c, bandPiece).fill).toBe('#0000ff');
		expect(path(c, bandPiece).stroke).toBeNull();
		expect(pieces.some((p) => p.fill === '#ff0000')).toBe(true);
	});

	it('divide cuts with open unfilled paths', () => {
		const c = make(doc(rectNode('a', 0, 0), lineNode('l', [[-10, 50], [110, 50]])));
		const ids = c.pathfinder('divide', { ids: ['a', 'l'] });
		expect(ids).toHaveLength(2);
		ids.forEach((id) => near(area(c, id), 5000));
	});

	it('is available as an agent command', async () => {
		const c = make(doc(rectNode('a', 0, 0), rectNode('b', 50, 50)));
		const registry = new CommandRegistry();
		for (const spec of createVectorCommands(c)) registry.register(spec);
		const result = await registry.execute('vector.pathfinder', { operation: 'divide', ids: ['a', 'b'] });
		expect(result.ok).toBe(true);
		expect(pathsIn(c.getDocument().nodes)).toHaveLength(3);
		const bad = await registry.execute('vector.pathfinder', { operation: 'trim', ids: ['a'] });
		expect(bad.ok).toBe(false);
	});
});

describe('Shape Builder', () => {
	const two = () => doc(rectNode('a', 0, 0), rectNode('b', 50, 50, 100, 100, { fill: '#0000ff' }));

	it('offers the faces of the selection with the shapes covering them', () => {
		const c = make(two());
		const faces = c.getShapeBuilderFaces({ ids: ['a', 'b'] });
		expect(faces).toHaveLength(3);
		expect(faces.map((f) => f.sources).sort()).toEqual([['a'], ['a', 'b'], ['b']]);
		expect(faces.every((f) => f.point)).toBe(true);
	});

	it('a drag across faces merges them into one shape as one undo step', () => {
		const c = make(two());
		c.select(['a', 'b']);
		c.setTool('shapeBuilder');
		// Drag from a's own face through the overlap.
		c.pointerDown({ x: 20, y: 20 });
		c.pointerMove({ x: 75, y: 75 });
		expect(c.getState().builder?.faces).toHaveLength(2);
		c.pointerUp({ x: 75, y: 75 });
		const nodes = pathsIn(c.getDocument().nodes);
		const merged = nodes.find((p) => p.name === 'Shape')!;
		// Styled like the top-most shape over the first face (a).
		expect(merged.fill).toBe('#ff0000');
		near(area(c, merged.id), 10000);
		// b lost the overlap; a lost everything and is gone.
		expect(c.getNode('a')).toBeUndefined();
		near(area(c, 'b'), 7500);
		expect(covers(c, 'b', 75, 75)).toBe(false);
		expect(c.getState().undoLabel).toBe('Shape Builder');
		expect(c.getState().selection).toEqual(expect.arrayContaining(['b', merged.id]));
		c.undo();
		expect(c.getDocument().nodes.map((x) => x.id)).toEqual(['a', 'b']);
	});

	it('Alt-click removes faces from every shape covering them', () => {
		const c = make(two());
		c.select(['a', 'b']);
		c.setTool('shapeBuilder');
		c.pointerMove({ x: 75, y: 75 }, { alt: true });
		expect(c.getState().builder?.mode).toBe('erase');
		c.pointerDown({ x: 75, y: 75 }, { alt: true });
		c.pointerUp({ x: 75, y: 75 }, { alt: true });
		near(area(c, 'a'), 7500);
		near(area(c, 'b'), 7500);
		expect(pathsIn(c.getDocument().nodes)).toHaveLength(2);
		expect(c.getState().undoLabel).toBe('Shape Builder Delete');
	});

	it('merges faces of rotated shapes and keeps their transforms', () => {
		const t = [...rotateMatrix(30)] as unknown as VectorPathNode['transform'];
		const c = make(doc(rectNode('a', 0, 0, 100, 100, { transform: t }), rectNode('b', 50, 0, 100, 100, { transform: t, fill: '#0000ff' })));
		const faces = c.getShapeBuilderFaces({ ids: ['a', 'b'] });
		const overlap = faces.find((f) => f.sources.length === 2)!;
		const result = c.shapeBuilder([overlap.point!], { ids: ['a', 'b'] });
		expect(result.ok).toBe(true);
		const merged = path(c, result.merged!);
		expect(merged.transform).toEqual(t);
		expect(merged.fill).toBe('#0000ff');
		near(area(c, merged.id), 5000, 1e-6);
		near(area(c, 'a'), 5000, 1e-6);
	});

	it('open unfilled lines cut faces, and the pieces between merged faces go', () => {
		const c = make(doc(rectNode('a', 0, 0), lineNode('l', [[50, -20], [50, 120]])));
		expect(c.getShapeBuilderFaces({ ids: ['a', 'l'] })).toHaveLength(2);
		const result = c.shapeBuilder([{ x: 25, y: 50 }, { x: 75, y: 50 }], { ids: ['a', 'l'] });
		expect(result.ok).toBe(true);
		near(area(c, result.merged!), 10000);
		// The line keeps its two loose ends; the piece across the merged faces is gone.
		const lineParts = pathsIn(c.getDocument().nodes).filter((p) => p.stroke === '#000000');
		expect(lineParts).toHaveLength(2);
	});

	it('an area only outlines enclose is a face, merged with the current fill', () => {
		const c = make(
			doc(lineNode('1', [[0, 0], [100, 100]]), lineNode('2', [[100, 0], [0, 100]]), lineNode('3', [[-10, 80], [110, 80]])),
			{ defaults: { fill: '#123456' } }
		);
		const faces = c.getShapeBuilderFaces({ ids: ['1', '2', '3'] });
		expect(faces).toHaveLength(1);
		expect(faces[0].sources).toEqual([]);
		const result = c.shapeBuilder([faces[0].point!], { ids: ['1', '2', '3'] });
		expect(path(c, result.merged!).fill).toBe('#123456');
		near(area(c, result.merged!), 900);
	});

	it('Alt erases a line piece within tolerance', () => {
		const c = make(doc(rectNode('a', 0, 0), lineNode('l', [[50, -20], [50, 120]])));
		const result = c.shapeBuilder([{ x: 50, y: -10 }], { ids: ['a', 'l'], erase: true, tolerance: 2 });
		expect(result.ok).toBe(true);
		expect(result.lines).toBe(1);
		// The piece above the rectangle went; the pieces across it and below it stay.
		const lineParts = pathsIn(c.getDocument().nodes).filter((p) => p.stroke === '#000000');
		expect(lineParts).toHaveLength(2);
		expect(lineParts.every((p) => p.subpaths[0].anchors.every((a) => a.y >= -1e-9))).toBe(true);
		expect(path(c, 'a')).toBeDefined();
	});

	it('shows the hovered face in the overlay and says when nothing is under the pointer', () => {
		const c = make(two());
		c.select(['a', 'b']);
		c.setTool('shapeBuilder');
		c.pointerMove({ x: 75, y: 75 });
		const overlay = getVectorOverlayRenderData(c.getState());
		expect(overlay.builder?.mode).toBe('merge');
		expect(overlay.builder?.faces).toHaveLength(1);
		expect(overlay.builder?.faces[0]).toMatch(/^M/);
		c.pointerMove({ x: 390, y: 290 });
		expect(c.getState().builder).toBeNull();
		expect(c.shapeBuilder([{ x: 390, y: 290 }], { ids: ['a', 'b'] }).ok).toBe(false);
	});

	it('runs from the agent command', async () => {
		const c = make(two());
		const registry = new CommandRegistry();
		for (const spec of createVectorCommands(c)) registry.register(spec);
		const faces = await registry.execute('vector.shapeBuilderFaces', { ids: ['a', 'b'] });
		expect(faces.ok).toBe(true);
		const result = await registry.execute('vector.shapeBuilder', { ids: ['a', 'b'], points: [[75, 75]], erase: true });
		expect(result.ok).toBe(true);
		near(area(c, 'a'), 7500);
	});
});

describe('paint bucket', () => {
	it('fills the region around a click, with islands as holes, on top when nothing is selected', () => {
		const c = make(doc(rectNode('outer', 0, 0, 200, 200, { fill: null, stroke: '#000000' }), rectNode('island', 50, 50, 40, 40, { fill: null, stroke: '#000000' })), {
			defaults: { fill: '#00ff00' }
		});
		c.setTool('paintBucket');
		c.pointerMove({ x: 10, y: 10 });
		expect(c.getState().builder?.mode).toBe('fill');
		expect(getVectorOverlayRenderData(c.getState()).builder?.faces).toHaveLength(1);
		c.pointerDown({ x: 10, y: 10 });
		c.pointerUp({ x: 10, y: 10 });
		const nodes = c.getDocument().nodes;
		expect(nodes).toHaveLength(3);
		const fill = nodes[2] as VectorPathNode;
		expect(fill.fill).toBe('#00ff00');
		expect(fill.stroke).toBeNull();
		near(bezierPathArea(subpathsToBezier(fill.subpaths)), 40000 - 1600);
		expect(c.getState().undoLabel).toBe('Fill Region');
	});

	it('goes below the selection, and splits crossing outlines', () => {
		const c = make(doc(lineNode('1', [[0, 0], [100, 100]]), lineNode('2', [[100, 0], [0, 100]]), lineNode('3', [[-10, 80], [110, 80]])));
		c.select(['2']);
		const id = c.fillRegion({ x: 50, y: 70 })!;
		expect(c.getDocument().nodes.map((x) => x.id)).toEqual(['1', id, '2', '3']);
		near(bezierPathArea(subpathsToBezier(path(c, id).subpaths)), 900);
		expect(c.fillRegion({ x: 300, y: 250 })).toBeNull();
	});

	it('closes small gaps when asked', () => {
		const c = make(doc(pathNode('u', [{ anchors: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 5 }], closed: false }], { fill: null, stroke: '#000000' })));
		expect(c.fillRegion({ x: 50, y: 50 })).toBeNull();
		c.setEditing({ fillGap: 6 });
		const id = c.fillRegion({ x: 50, y: 50 });
		expect(id).not.toBeNull();
		near(bezierPathArea(subpathsToBezier(path(c, id!).subpaths)), 10000);
	});

	it('runs from the agent command', async () => {
		const c = make(doc(rectNode('a', 0, 0, 100, 100, { fill: null, stroke: '#000000' })));
		const registry = new CommandRegistry();
		for (const spec of createVectorCommands(c)) registry.register(spec);
		const result = await registry.execute('vector.fillRegion', { point: [50, 50] });
		expect(result.ok).toBe(true);
		const missed = await registry.execute('vector.fillRegion', { point: [300, 50] });
		expect(missed.ok).toBe(false);
	});
});
