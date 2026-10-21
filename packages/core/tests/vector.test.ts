import { describe, expect, it } from 'vitest';
import { HistoryManager } from '../src/history/HistoryManager.js';
import {
	bezierToSubpaths,
	convertAnchor,
	createVectorCommands,
	ellipseSubpath,
	getVectorOverlayRenderData,
	getVectorSceneRenderData,
	hitTestVectorNode,
	inferAnchorType,
	insertAnchor,
	moveAnchorHandle,
	nearestSegment,
	parseSvgTransform,
	parseVectorSvg,
	rectSubpath,
	rotateMatrix,
	scaleFor,
	starSubpath,
	subpathsToBezier,
	transformVectorNode,
	vectorDocumentToSvg,
	vectorNodeBounds,
	vectorPathData,
	VectorEditorController,
	decomposeRigid,
	multiplyMatrices,
	matrixRotation,
	scaleMatrix,
	translateMatrix,
	vectorNodeRotation,
	getAnchorWorld,
	type VectorGroupNode,
	type VectorDocument,
	type VectorPathNode
} from '../src/vector/index.js';
import { CommandRegistry } from '../src/commands/index.js';

const rectNode = (id: string, x: number, y: number, w = 100, h = 100, extra: Partial<VectorPathNode> = {}): VectorPathNode => ({
	id,
	type: 'path',
	subpaths: [rectSubpath({ x, y, width: w, height: h })],
	fill: '#f00',
	stroke: null,
	...extra
});

const doc = (...nodes: VectorPathNode[]): VectorDocument => ({ width: 400, height: 300, nodes });

let n = 0;
const ids = () => `id${++n}`;
const make = (document?: VectorDocument) => new VectorEditorController({ document, createId: ids });

describe('vector geometry', () => {
	it('round-trips SVG path data through editable anchors', () => {
		const sp = bezierToSubpaths('M0 0 C 10 0 20 10 20 20 L 0 20 Z');
		expect(sp).toHaveLength(1);
		expect(sp[0].closed).toBe(true);
		expect(sp[0].anchors).toHaveLength(3);
		expect(sp[0].anchors[0].out).toEqual({ x: 10, y: 0 });
		expect(sp[0].anchors[1].in).toEqual({ x: 20, y: 10 });
		expect(vectorPathData(sp)).toBe('M0 0C10 0 20 10 20 20L0 20Z');
	});

	it('merges a closing anchor that repeats the first one', () => {
		const sp = bezierToSubpaths('M0 0 L10 0 C 10 10 5 5 0 0 Z');
		expect(sp[0].anchors).toHaveLength(2);
		expect(sp[0].anchors[0].in).toEqual({ x: 5, y: 5 });
		expect(subpathsToBezier(sp).at(-2)).toEqual({ type: 'C', x1: 10, y1: 10, x2: 5, y2: 5, x: 0, y: 0 });
	});

	it('converts quadratics and arcs to cubics', () => {
		const q = bezierToSubpaths('M0 0 Q 10 10 20 0');
		expect(q[0].anchors[0].out!.x).toBeCloseTo(20 / 3);
		expect(q[0].anchors[1].in!.x).toBeCloseTo(40 / 3);
		const arc = bezierToSubpaths('M0 0 A 10 10 0 0 1 20 0');
		expect(arc[0].anchors.length).toBeGreaterThan(2);
	});

	it('infers anchor types', () => {
		expect(inferAnchorType({ x: 0, y: 0 })).toBe('corner');
		expect(inferAnchorType({ x: 0, y: 0, in: { x: -5, y: 0 }, out: { x: 5, y: 0 } })).toBe('symmetric');
		expect(inferAnchorType({ x: 0, y: 0, in: { x: -5, y: 0 }, out: { x: 10, y: 0 } })).toBe('smooth');
		expect(inferAnchorType({ x: 0, y: 0, in: { x: -5, y: 0 }, out: { x: 0, y: 10 } })).toBe('corner');
	});

	it('computes bounds of curves, not just anchors', () => {
		const node: VectorPathNode = { id: 'e', type: 'path', subpaths: [ellipseSubpath({ x: 10, y: 20, width: 100, height: 50 })] };
		const b = vectorNodeBounds(node)!;
		expect(b.x).toBeCloseTo(10);
		expect(b.y).toBeCloseTo(20);
		expect(b.width).toBeCloseTo(100);
		expect(b.height).toBeCloseTo(50);
	});

	it('hit-tests fills and strokes', () => {
		const filled = rectNode('a', 0, 0);
		expect(hitTestVectorNode(filled, { x: 50, y: 50 })).toBe(true);
		expect(hitTestVectorNode(filled, { x: 150, y: 50 })).toBe(false);
		const outline = rectNode('b', 0, 0, 100, 100, { fill: null, stroke: '#000', strokeWidth: 4 });
		expect(hitTestVectorNode(outline, { x: 50, y: 50 })).toBe(false);
		expect(hitTestVectorNode(outline, { x: 101, y: 50 })).toBe(true);
		expect(hitTestVectorNode(outline, { x: 105, y: 50 }, 2)).toBe(false);
		expect(hitTestVectorNode({ ...filled, visible: false }, { x: 50, y: 50 })).toBe(false);
	});

	it('inserts an anchor without changing the curve', () => {
		const [sp] = bezierToSubpaths('M0 0 C 0 50 100 50 100 0');
		const before = nearestSegment({ id: 'p', type: 'path', subpaths: [sp] }, { x: 50, y: 30 })!;
		const { subpath, index } = insertAnchor(sp, 0, 0.5);
		expect(index).toBe(1);
		expect(subpath.anchors).toHaveLength(3);
		expect(subpath.anchors[1].x).toBeCloseTo(50);
		expect(subpath.anchors[1].y).toBeCloseTo(37.5);
		const after = nearestSegment({ id: 'p', type: 'path', subpaths: [subpath] }, { x: 50, y: 30 })!;
		expect(after.distance).toBeCloseTo(before.distance, 6);
	});

	it('moves handles according to the anchor type', () => {
		const a = { x: 0, y: 0, in: { x: -10, y: 0 }, out: { x: 20, y: 0 }, type: 'smooth' as const };
		const smooth = moveAnchorHandle(a, 'out', { x: 0, y: 5 });
		expect(smooth.in!.x).toBeCloseTo(0);
		expect(smooth.in!.y).toBeCloseTo(-10);
		const sym = moveAnchorHandle({ ...a, type: 'symmetric' }, 'out', { x: 0, y: 5 });
		expect(sym.in!.x).toBeCloseTo(0);
		expect(sym.in!.y).toBe(-5);
		const broken = moveAnchorHandle(a, 'out', { x: 0, y: 5 }, true);
		expect(broken.in).toEqual({ x: -10, y: 0 });
		expect(broken.type).toBeUndefined();
	});

	it('converts anchors between corner and smooth', () => {
		const sp = { anchors: [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }], closed: false };
		const smooth = convertAnchor(sp, 1, 'smooth');
		expect(smooth.anchors[1].type).toBe('smooth');
		expect(smooth.anchors[1].in!.y).toBeCloseTo(50);
		expect(smooth.anchors[1].out!.x).toBeGreaterThan(50);
		const corner = convertAnchor(smooth, 1, 'corner');
		expect(corner.anchors[1].in).toBeUndefined();
		expect(corner.anchors[1].out).toBeUndefined();
	});

	it('builds stars and rounded rects', () => {
		expect(starSubpath({ x: 0, y: 0, width: 100, height: 100 }, 5).anchors).toHaveLength(10);
		const rr = rectSubpath({ x: 0, y: 0, width: 100, height: 40 }, 50);
		// Live corners: four sharp anchors carrying the radius; drawn, it is clamped to half the height.
		expect(rr.anchors).toHaveLength(4);
		expect(rr.anchors.every((a) => a.corner?.radius === 50)).toBe(true);
		const drawn = bezierToSubpaths(vectorPathData([rr]))[0];
		expect(drawn.anchors).toHaveLength(8);
		expect(drawn.anchors[0].x).toBeCloseTo(20, 9);
	});

	it('transforms nodes with matrices', () => {
		const rotated = transformVectorNode(rectNode('a', 0, 0, 100, 50), rotateMatrix(90, { x: 0, y: 0 }));
		const b = vectorNodeBounds(rotated)!;
		expect(b.x).toBeCloseTo(-50);
		expect(b.width).toBeCloseTo(50);
		expect(b.height).toBeCloseTo(100);
	});

	it('computes scale factors for selection handles', () => {
		const b = { x: 0, y: 0, width: 100, height: 50 };
		expect(scaleFor('se', b, { x: 200, y: 100 })).toEqual({ sx: 2, sy: 2, origin: { x: 0, y: 0 } });
		expect(scaleFor('e', b, { x: 50, y: 999 })).toMatchObject({ sx: 0.5, sy: 1 });
		expect(scaleFor('se', b, { x: 300, y: 60 }, { shift: true })).toMatchObject({ sx: 3, sy: 3 });
		expect(scaleFor('se', b, { x: 100, y: 50 }, { alt: true })).toMatchObject({ sx: 1, sy: 1, origin: { x: 50, y: 25 } });
	});
});

describe('vector svg', () => {
	it('exports a standalone SVG with gradients', () => {
		const d = doc(rectNode('a', 0, 0, 10, 10, { fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] }, stroke: '#00f', strokeWidth: 2 }));
		d.background = '#eee';
		const svg = vectorDocumentToSvg(d);
		expect(svg).toContain('viewBox="0 0 400 300"');
		expect(svg).toContain('<linearGradient id="vg-fill-a"');
		expect(svg).toContain('fill="url(#vg-fill-a)"');
		expect(svg).toContain('stroke="#00f" stroke-width="2"');
		expect(svg).toContain('<rect width="400" height="300" fill="#eee"/>');
	});

	it('escapes attribute values', () => {
		const svg = vectorDocumentToSvg(doc(rectNode('a"><script>', 0, 0, 10, 10)));
		expect(svg).not.toContain('<script>');
		expect(svg).toContain('&quot;&gt;&lt;script&gt;');
	});

	it('imports shapes, groups, styles and transforms', () => {
		const parsed = parseVectorSvg(`<?xml version="1.0"?>
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 10 200 100" width="400" height="200">
				<!-- comment <rect/> -->
				<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000"/><stop offset="100%" style="stop-color:#fff;stop-opacity:0.5"/></linearGradient></defs>
				<g id="grp" fill="#0f0" transform="translate(5 0)" opacity="0.5">
					<rect id="r" x="10" y="10" width="20" height="10"/>
					<circle cx="50" cy="50" r="10" style="fill:none;stroke:#123;stroke-width:3"/>
				</g>
				<path d="M10 10 L 20 20" stroke="red" fill="url(#g)"/>
				<line x1="0" y1="0" x2="10" y2="0" stroke="black"/>
				<polygon points="0,0 10,0 5,10" fill-rule="evenodd"/>
				<text x="4" y="90" font-size="12">imported</text>
			</svg>`);
		expect(parsed.width).toBe(200);
		expect(parsed.height).toBe(100);
		const [group, path, line, poly] = parsed.nodes;
		expect(group.type).toBe('group');
		expect(group.opacity).toBe(0.5);
		if (group.type !== 'group') throw new Error();
		const rect = group.children[0] as VectorPathNode;
		expect(rect.id).toBe('r');
		expect(rect.fill).toBe('#0f0');
		expect(vectorNodeBounds(rect)).toEqual({ x: 5, y: 0, width: 20, height: 10 });
		const circle = group.children[1] as VectorPathNode;
		expect(circle.fill).toBeNull();
		expect(circle.stroke).toBe('#123');
		expect(circle.strokeWidth).toBe(3);
		expect((path as VectorPathNode).fill).toEqual({ type: 'linear', angle: 180, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff', opacity: 0.5 }] });
		expect((line as VectorPathNode).fill).toBeNull();
		expect((poly as VectorPathNode).fillRule).toBe('evenodd');
		expect((poly as VectorPathNode).subpaths[0].closed).toBe(true);
		// Foreign text comes in as point text.
		expect(parsed.nodes).toHaveLength(5);
		expect(parsed.nodes[4]).toMatchObject({ type: 'text', text: 'imported', frame: { kind: 'point', x: -6, y: 80 }, font: { fontSize: 12 } });
	});

	it('parses transform lists right to left', () => {
		const m = parseSvgTransform('translate(10 0) scale(2)');
		expect(m[0]).toBe(2);
		expect(m[4]).toBe(10);
		expect(parseSvgTransform('rotate(90)')[1]).toBeCloseTo(1);
	});

	it('round-trips export → import', () => {
		const original = doc(rectNode('a', 10, 10, 30, 20), { id: 'b', type: 'path', subpaths: [ellipseSubpath({ x: 50, y: 50, width: 40, height: 40 })], fill: '#00f' });
		const back = parseVectorSvg(vectorDocumentToSvg(original));
		expect(back.nodes.map((n) => n.id)).toEqual(['a', 'b']);
		expect(vectorNodeBounds(back.nodes[1])!.width).toBeCloseTo(40);
	});

	it('throws without an <svg> element', () => {
		expect(() => parseVectorSvg('<div/>')).toThrow(/no <svg>/);
	});

	it('parses CSS stylesheet <style> rules with classes and handles precedence', () => {
		const parsed = parseVectorSvg(`
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
				<style>
					.gold { fill: #c5a059; stroke: #333333; stroke-width: 2; }
					.outline-only { fill: none; stroke: #ff00ff; }
					#specific { fill: #00ffff; }
				</style>
				<rect class="gold" x="0" y="0" width="10" height="10" />
				<!-- inline style overrides class rule -->
				<rect class="gold" style="fill: #ff0000" x="20" y="0" width="10" height="10" />
				<!-- presentation attribute overrides inherited, but class rule overrides presentation attribute -->
				<rect class="gold" fill="#000000" x="40" y="0" width="10" height="10" />
				<circle class="outline-only" cx="60" cy="50" r="5" />
				<rect id="specific" class="gold" x="80" y="0" width="10" height="10" />
			</svg>
		`);
		expect(parsed.nodes).toHaveLength(5);
		const [goldRect, inlineOverrideRect, classOverAttrRect, outlineCircle, specificRect] = parsed.nodes as VectorPathNode[];

		// .gold class applied
		expect(goldRect.fill).toBe('#c5a059');
		expect(goldRect.stroke).toBe('#333333');
		expect(goldRect.strokeWidth).toBe(2);

		// inline style takes precedence over class
		expect(inlineOverrideRect.fill).toBe('#ff0000');
		expect(inlineOverrideRect.stroke).toBe('#333333');

		// class rule takes precedence over presentation attribute
		expect(classOverAttrRect.fill).toBe('#c5a059');

		// .outline-only class applied
		expect(outlineCircle.fill).toBeNull();
		expect(outlineCircle.stroke).toBe('#ff00ff');

		// id selector overrides class selector
		expect(specificRect.fill).toBe('#00ffff');
	});
});

describe('VectorEditorController', () => {
	it('reconnects to the history when subscribed again after destroy (React StrictMode)', () => {
		const history = new HistoryManager();
		const c = new VectorEditorController({ document: doc(rectNode('a', 0, 0)), history, createId: ids });
		c.addShape({ kind: 'rect', x: 0, y: 0, width: 5, height: 5 });
		c.destroy();
		history.clear();
		expect(c.getState().canUndo).toBe(true);
		const seen: boolean[] = [];
		c.subscribe((s) => seen.push(s.canUndo));
		expect(c.getState().canUndo).toBe(false);
		c.addShape({ kind: 'rect', x: 0, y: 0, width: 5, height: 5 });
		history.clear();
		expect(seen.at(-1)).toBe(false);
		expect(c.getState().canUndo).toBe(false);
	});

	it('returns a stable state snapshot until something changes', () => {
		const c = make(doc(rectNode('a', 0, 0)));
		const s = c.getState();
		expect(c.getState()).toBe(s);
		c.select(['a']);
		expect(c.getState()).not.toBe(s);
		expect(c.getState().selection).toEqual(['a']);
		expect(c.getState().selectionBounds).toEqual({ x: 0, y: 0, width: 100, height: 100 });
	});

	it('moves the selection by dragging, as one undo step', () => {
		const c = make(doc(rectNode('a', 0, 0)));
		c.pointerDown({ x: 50, y: 50 });
		expect(c.getState().selection).toEqual(['a']);
		c.pointerMove({ x: 60, y: 55 });
		c.pointerMove({ x: 70, y: 60 });
		expect(c.getState().interaction).toEqual({ type: 'move', dx: 20, dy: 10 });
		c.pointerUp({ x: 70, y: 60 });
		expect(vectorNodeBounds(c.getNode('a')!)).toMatchObject({ x: 20, y: 10 });
		expect(c.getState().undoLabel).toBe('Move');
		c.undo();
		expect(vectorNodeBounds(c.getNode('a')!)).toMatchObject({ x: 0, y: 0 });
		c.redo();
		expect(vectorNodeBounds(c.getNode('a')!)).toMatchObject({ x: 20, y: 10 });
	});

	it('alt-drag duplicates', () => {
		const c = make(doc(rectNode('a', 0, 0)));
		c.pointerDown({ x: 50, y: 50 });
		c.pointerMove({ x: 150, y: 50 }, { alt: true });
		c.pointerUp({ x: 150, y: 50 }, { alt: true });
		const nodes = c.getState().document.nodes;
		expect(nodes).toHaveLength(2);
		expect(vectorNodeBounds(nodes[0])).toMatchObject({ x: 0 });
		expect(vectorNodeBounds(nodes[1])).toMatchObject({ x: 100 });
		expect(c.getState().selection).toEqual([nodes[1].id]);
		expect(c.getState().undoLabel).toBe('Duplicate');
	});

	it('snaps moves to the grid', () => {
		const c = make(doc(rectNode('a', 0, 0)));
		c.setSnap({ grid: 10 });
		c.pointerDown({ x: 50, y: 50 });
		c.pointerUp({ x: 63, y: 57 });
		expect(vectorNodeBounds(c.getNode('a')!)).toMatchObject({ x: 10, y: 10 });
	});

	it('marquee-selects and shift-click toggles', () => {
		const c = make(doc(rectNode('a', 0, 0, 50, 50), rectNode('b', 100, 0, 50, 50), rectNode('c', 300, 200, 50, 50)));
		c.pointerDown({ x: -10, y: -10 });
		c.pointerMove({ x: 120, y: 20 });
		expect(c.getState().interaction?.type).toBe('marquee');
		c.pointerUp({ x: 120, y: 20 });
		expect(c.getState().selection).toEqual(['a', 'b']);
		c.pointerDown({ x: 110, y: 10 }, { shift: true });
		c.pointerUp({ x: 110, y: 10 }, { shift: true });
		expect(c.getState().selection).toEqual(['a']);
		c.pointerDown({ x: 390, y: 290 });
		c.pointerUp({ x: 390, y: 290 });
		expect(c.getState().selection).toEqual([]);
	});

	it('scales with the selection handles', () => {
		const c = make(doc(rectNode('a', 0, 0)));
		c.select(['a']);
		c.pointerMove({ x: 100, y: 100 });
		expect(c.getState().hover?.transformHandle).toBe('se');
		expect(c.getState().cursor).toBe('nwse-resize');
		c.pointerDown({ x: 100, y: 100 });
		c.pointerUp({ x: 200, y: 150 });
		expect(vectorNodeBounds(c.getNode('a')!)).toEqual({ x: 0, y: 0, width: 200, height: 150 });
		expect(c.getState().undoLabel).toBe('Scale');
	});

	it('rotates with the rotation handle (shift snaps to 15°)', () => {
		const c = make(doc(rectNode('a', 0, 0)));
		c.select(['a']);
		c.pointerDown({ x: 50, y: -24 });
		expect(c.getState().interaction).toEqual({ type: 'rotate', angle: 0 });
		c.pointerMove({ x: 150, y: 52 }, { shift: true });
		expect(c.getState().interaction).toEqual({ type: 'rotate', angle: 90 });
		c.pointerUp(undefined);
		const b = vectorNodeBounds(c.getNode('a')!)!;
		expect(b.width).toBeCloseTo(100);
		expect(c.getState().undoLabel).toBe('Rotate');
	});

	it('draws shapes with the shape tools, then returns to select', () => {
		const c = make();
		c.setTool('rect');
		c.pointerDown({ x: 10, y: 10 });
		c.pointerMove({ x: 60, y: 30 }, { shift: true });
		expect(c.getState().interaction?.type).toBe('draw');
		c.pointerUp({ x: 60, y: 30 }, { shift: true });
		const [node] = c.getState().document.nodes;
		expect(vectorNodeBounds(node)).toEqual({ x: 10, y: 10, width: 50, height: 50 });
		expect(c.getState().tool).toBe('select');
		expect(c.getState().selection).toEqual([node.id]);
		expect(c.getState().undoLabel).toBe('Draw Rectangle');

		c.setTool('ellipse');
		c.pointerDown({ x: 200, y: 200 });
		c.pointerUp({ x: 201, y: 200 });
		expect(c.getState().document.nodes).toHaveLength(1); // too small: discarded

		c.setTool('star');
		c.pointerDown({ x: 200, y: 200 });
		c.pointerUp({ x: 250, y: 250 }, { alt: true });
		expect(vectorNodeBounds(c.getState().document.nodes[1])!.width).toBeGreaterThan(50);
	});

	it('draws a path with the pen: clicks make corners, drags make curves, clicking the start closes', () => {
		const c = make();
		c.setTool('pen');
		c.pointerDown({ x: 0, y: 0 });
		c.pointerUp({ x: 0, y: 0 });
		const id = c.getState().pen!.nodeId;
		c.pointerDown({ x: 100, y: 0 });
		c.pointerMove({ x: 150, y: 50 });
		c.pointerUp({ x: 150, y: 50 });
		let node = c.getNode(id) as VectorPathNode;
		expect(node.subpaths[0].anchors[1]).toMatchObject({ x: 100, y: 0, out: { x: 150, y: 50 }, in: { x: 50, y: -50 }, type: 'symmetric' });
		c.pointerMove({ x: 50, y: 100 });
		expect(getVectorOverlayRenderData(c.getState()).penPreview).toMatch(/^M100 0Q150 50 50 100$/);
		c.pointerDown({ x: 50, y: 100 });
		c.pointerUp({ x: 50, y: 100 });
		c.pointerMove({ x: 2, y: 1 });
		expect(getVectorOverlayRenderData(c.getState()).anchors[0].closes).toBe(true);
		c.pointerDown({ x: 2, y: 1 });
		c.pointerUp({ x: 2, y: 1 });
		node = c.getNode(id) as VectorPathNode;
		expect(node.subpaths[0].closed).toBe(true);
		expect(node.subpaths[0].anchors).toHaveLength(3);
		expect(c.getState().pen).toBeNull();
		expect(c.getState().undoLabel).toBe('Close Path');
		c.undo();
		expect((c.getNode(id) as VectorPathNode).subpaths[0].closed).toBe(false);
	});

	it('finishes a pen path with Escape and drops a lone anchor', () => {
		const c = make();
		c.setTool('pen');
		c.pointerDown({ x: 0, y: 0 });
		c.pointerUp({ x: 0, y: 0 });
		expect(c.getState().document.nodes).toHaveLength(1);
		expect(c.keyDown({ key: 'Escape' })).toBe(true);
		expect(c.getState().document.nodes).toHaveLength(0);
		expect(c.getState().pen).toBeNull();
	});

	it('resumes an open path from its first endpoint', () => {
		const c = make(doc({ id: 'p', type: 'path', subpaths: [{ anchors: [{ x: 0, y: 0 }, { x: 100, y: 0 }], closed: false }], stroke: '#000' }));
		c.setTool('pen');
		c.pointerDown({ x: 0, y: 0 });
		c.pointerUp({ x: 0, y: 0 });
		expect(c.getState().pen).toEqual({ nodeId: 'p', subpath: 0 });
		c.pointerDown({ x: 0, y: 100 });
		c.pointerUp({ x: 0, y: 100 });
		const sp = (c.getNode('p') as VectorPathNode).subpaths[0];
		expect(sp.anchors.map((a) => [a.x, a.y])).toEqual([
			[100, 0],
			[0, 0],
			[0, 100]
		]);
	});

	it('draws freehand paths with the pencil and fits curves', () => {
		const c = make();
		c.setTool('pencil');
		c.pointerDown({ x: 0, y: 0 });
		for (let i = 1; i <= 40; i++) c.pointerMove({ x: i * 5, y: Math.sin(i / 5) * 40 });
		c.pointerUp();
		const node = c.getState().document.nodes[0] as VectorPathNode;
		expect(node.subpaths[0].anchors.length).toBeLessThan(20);
		expect(node.subpaths[0].anchors.some((a) => a.out)).toBe(true);
		expect(node.fill).toBeNull();
		expect(c.getState().undoLabel).toBe('Draw');
	});

	it('edits anchors and handles with the direct tool', () => {
		const c = make(doc(rectNode('a', 0, 0)));
		c.setTool('direct');
		c.pointerDown({ x: 50, y: 50 }); // body: selects the path and all its anchors
		c.pointerUp({ x: 50, y: 50 });
		expect(c.getState().editingId).toBe('a');
		expect(c.getState().selectedAnchors).toHaveLength(4);
		c.pointerDown({ x: 100, y: 100 }); // the corner anchor
		c.pointerUp({ x: 100, y: 100 });
		expect(c.getState().selectedAnchors).toEqual([{ nodeId: 'a', subpath: 0, index: 2 }]);
		c.pointerDown({ x: 100, y: 100 });
		c.pointerMove({ x: 120, y: 130 });
		c.pointerUp({ x: 120, y: 130 });
		expect((c.getNode('a') as VectorPathNode).subpaths[0].anchors[2]).toMatchObject({ x: 120, y: 130 });
		expect(c.getState().undoLabel).toBe('Move Points');
		// Alt-drag pulls out handles.
		c.pointerDown({ x: 120, y: 130 }, { alt: true });
		c.pointerMove({ x: 140, y: 130 }, { alt: true });
		c.pointerUp({ x: 140, y: 130 }, { alt: true });
		const a = (c.getNode('a') as VectorPathNode).subpaths[0].anchors[2];
		expect(a.out).toEqual({ x: 140, y: 130 });
		expect(a.in).toEqual({ x: 100, y: 130 });
		expect(getVectorOverlayRenderData(c.getState()).handles.map((h) => h.ref.handle).sort()).toEqual(['in', 'out']);
		// Drag the out handle with alt to break the pair.
		c.pointerDown({ x: 140, y: 130 });
		expect(c.getState().interaction).toMatchObject({ type: 'handle' });
		c.pointerUp({ x: 140, y: 160 }, { alt: true });
		const b = (c.getNode('a') as VectorPathNode).subpaths[0].anchors[2];
		expect(b.out).toEqual({ x: 140, y: 160 });
		expect(b.in).toEqual({ x: 100, y: 130 });
	});

	it('alt-click on a segment inserts an anchor; Delete removes selected anchors', () => {
		const c = make(doc(rectNode('a', 0, 0)));
		c.setTool('direct');
		c.select(['a']);
		c.pointerDown({ x: 50, y: 0 }, { alt: true });
		c.pointerUp({ x: 50, y: 0 }, { alt: true });
		const node = () => c.getNode('a') as VectorPathNode;
		expect(node().subpaths[0].anchors).toHaveLength(5);
		expect(c.getState().selectedAnchors).toEqual([{ nodeId: 'a', subpath: 0, index: 1 }]);
		expect(c.getState().undoLabel).toBe('Add Point');
		expect(c.keyDown({ key: 'Backspace' })).toBe(true);
		expect(node().subpaths[0].anchors).toHaveLength(4);
	});

	it('nudges with arrow keys and switches tools with letters', () => {
		const c = make(doc(rectNode('a', 0, 0)));
		c.select(['a']);
		c.keyDown({ key: 'ArrowRight', shift: true });
		c.keyDown({ key: 'ArrowDown' });
		expect(vectorNodeBounds(c.getNode('a')!)).toMatchObject({ x: 10, y: 1 });
		expect(c.keyDown({ key: 'p' })).toBe(true);
		expect(c.getState().tool).toBe('pen');
		expect(c.keyDown({ key: 'Escape' })).toBe(true);
		expect(c.getState().tool).toBe('select');
		expect(c.keyDown({ key: 'i' })).toBe(false);
	});

	it('groups, ungroups, arranges and duplicates', () => {
		const c = make(doc(rectNode('a', 0, 0), rectNode('b', 50, 50), rectNode('c', 200, 0)));
		c.select(['a', 'b']);
		const g = c.group()!;
		expect(c.getState().document.nodes.map((n) => n.id)).toEqual([g, 'c']);
		c.pointerDown({ x: 10, y: 10 });
		c.pointerUp({ x: 10, y: 10 });
		expect(c.getState().selection).toEqual([g]); // clicking a member selects the group
		c.arrange('front');
		expect(c.getState().document.nodes.map((n) => n.id)).toEqual(['c', g]);
		c.ungroup();
		expect(c.getState().document.nodes.map((n) => n.id)).toEqual(['c', 'a', 'b']);
		expect(c.getState().selection).toEqual(['a', 'b']);
		const copies = c.duplicate();
		expect(copies).toHaveLength(2);
		expect(c.getState().document.nodes.map((n) => n.id)).toEqual(['c', 'a', copies[0], 'b', copies[1]]);
		c.undo();
		c.undo();
		c.undo();
		c.undo();
		expect(c.getState().document.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
	});

	it('aligns and distributes', () => {
		const c = make(doc(rectNode('a', 0, 0, 10, 10), rectNode('b', 30, 40, 20, 10), rectNode('c', 100, 5, 10, 10)));
		c.select(['a', 'b', 'c']);
		c.align('top');
		expect(c.getState().document.nodes.map((n) => vectorNodeBounds(n)!.y)).toEqual([0, 0, 0]);
		c.distribute('horizontal');
		const xs = c.getState().document.nodes.map((n) => vectorNodeBounds(n)!.x);
		expect(xs[0]).toBe(0);
		expect(xs[1]).toBeCloseTo(45);
		expect(xs[2]).toBe(100);
		c.select(['a']);
		c.align('right');
		expect(vectorNodeBounds(c.getNode('a')!)!.x).toBe(390);
	});

	it('runs boolean operations', () => {
		const c = make(doc(rectNode('a', 0, 0), rectNode('b', 50, 0)));
		c.select(['a', 'b']);
		const id = c.booleanOp('union')!;
		expect(c.getState().document.nodes.map((n) => n.id)).toEqual([id]);
		expect(vectorNodeBounds(c.getNode(id)!)).toEqual({ x: 0, y: 0, width: 150, height: 100 });
		expect(c.getState().undoLabel).toBe('Union');
		c.undo();
		c.select(['a', 'b']);
		const sub = c.booleanOp('subtract')!;
		expect(vectorNodeBounds(c.getNode(sub)!)).toEqual({ x: 0, y: 0, width: 50, height: 100 });
		c.undo();
		const far = make(doc(rectNode('a', 0, 0, 10, 10), rectNode('b', 50, 0, 10, 10)));
		far.select(['a', 'b']);
		expect(far.booleanOp('intersect')).toBeNull();
		expect(far.getState().document.nodes).toHaveLength(2);
	});

	it('copies and pastes through text', () => {
		const c = make(doc(rectNode('a', 0, 0)));
		c.select(['a']);
		const text = c.copy()!;
		expect(JSON.parse(text).type).toBe('pixerate/vector');
		const pasted = c.paste(text);
		expect(pasted).toHaveLength(1);
		expect(vectorNodeBounds(c.getNode(pasted[0])!)).toMatchObject({ x: 10, y: 10 });
		expect(c.paste('<svg><rect width="5" height="5"/></svg>')).toHaveLength(1);
		expect(c.paste('not a clipboard payload')).toEqual([]);
	});

	it('converts between screen and document space and zooms around a point', () => {
		const c = make(doc(rectNode('a', 0, 0)));
		c.zoomAt({ x: 100, y: 100 }, 2);
		expect(c.getState().viewport).toEqual({ x: -100, y: -100, zoom: 2 });
		expect(c.screenToDocument({ x: 100, y: 100 })).toEqual({ x: 100, y: 100 });
		c.zoomToFit({ width: 480, height: 380 }, { padding: 40 });
		expect(c.getState().viewport.zoom).toBe(1);
		expect(c.documentToScreen({ x: 0, y: 0 })).toEqual({ x: 40, y: 40 });
		c.setViewport({ zoom: 1000 });
		expect(c.getState().viewport.zoom).toBe(64);
	});

	it('pans with space-drag and the middle button', () => {
		const c = make();
		c.keyDown({ key: ' ' });
		expect(c.getState().cursor).toBe('grab');
		c.pointerDown({ x: 0, y: 0 });
		c.pointerMove({ x: 30, y: 20 });
		c.pointerUp();
		c.keyUp({ key: ' ' });
		expect(c.getState().viewport).toMatchObject({ x: 30, y: 20 });
		c.pointerDown({ x: 0, y: 0 }, { button: 1 });
		c.pointerMove({ x: -10, y: 0 });
		c.pointerUp();
		expect(c.getState().viewport).toMatchObject({ x: 20, y: 20 });
		expect(c.history.getState().canUndo).toBe(false);
	});

	it('skips locked and hidden nodes when picking', () => {
		const c = make(doc(rectNode('a', 0, 0), rectNode('b', 0, 0, 100, 100, { locked: true })));
		c.pointerDown({ x: 50, y: 50 });
		c.pointerUp({ x: 50, y: 50 });
		expect(c.getState().selection).toEqual(['a']);
		c.setVisible('a', false);
		c.clearSelection();
		c.pointerDown({ x: 50, y: 50 });
		c.pointerUp({ x: 50, y: 50 });
		expect(c.getState().selection).toEqual([]);
	});

	it('cancels a drag back to where it started', () => {
		const c = make(doc(rectNode('a', 0, 0)));
		c.pointerDown({ x: 50, y: 50 });
		c.pointerMove({ x: 90, y: 90 });
		c.keyDown({ key: 'Escape' });
		expect(vectorNodeBounds(c.getNode('a')!)).toMatchObject({ x: 0, y: 0 });
		expect(c.history.getState().canUndo).toBe(false);
	});

	it('reports document changes through onChange', () => {
		const changes: number[] = [];
		const c = new VectorEditorController({ document: doc(rectNode('a', 0, 0)), onChange: (d) => changes.push(d.nodes.length), createId: ids });
		c.addShape({ kind: 'ellipse', x: 0, y: 0, width: 10, height: 10 });
		c.undo();
		c.select([]);
		expect(changes).toEqual([2, 1]);
	});

	it('loads and exports SVG', () => {
		const c = make();
		expect(c.loadSvg('<svg width="50" height="40"><rect id="r" width="10" height="10" fill="blue"/></svg>')).toEqual({ ok: true });
		expect(c.getState().document.width).toBe(50);
		expect(c.toSvg()).toContain('id="r"');
		expect(c.loadSvg('nope').ok).toBe(false);
	});
});

describe('vector render data', () => {
	it('builds the scene with gradient defs and the overlay in screen space', () => {
		const c = make(doc(rectNode('a', 0, 0, 100, 100, { fill: { type: 'radial', stops: [{ offset: 0, color: '#fff' }] }, stroke: '#000', strokeDasharray: [4, 2] })));
		c.setViewport({ x: 10, y: 20, zoom: 2 });
		c.select(['a']);
		const scene = getVectorSceneRenderData(c.getState());
		expect(scene.transform).toBe('translate(10 20) scale(2)');
		expect(scene.defs[0]).toMatchObject({ id: 've-fill-a', type: 'radial' });
		expect(scene.nodes[0]).toMatchObject({ kind: 'path', fill: 'url(#ve-fill-a)', stroke: '#000', strokeDasharray: '4 2' });
		const overlay = getVectorOverlayRenderData(c.getState());
		expect(overlay.selectionBox).toMatchObject({ x: 10, y: 20, width: 200, height: 200 });
		expect(overlay.selectionBox!.handles.find((h) => h.handle === 'rotate')).toEqual({ handle: 'rotate', x: 110, y: -4, screen: { x: 110, y: -4 } });
		expect(overlay.outlines[0].d.startsWith('M10 20')).toBe(true);
		expect(overlay.artboard).toEqual({ x: 10, y: 20, width: 800, height: 600 });
	});
});

describe('vector commands', () => {
	it('exposes editor actions as palette / agent commands', () => {
		const c = make(doc(rectNode('a', 0, 0)));
		const registry = new CommandRegistry({ history: c.history });
		registry.register(createVectorCommands(c));
		const added = registry.execute('vector.addShape', { kind: 'ellipse', x: 200, y: 0, width: 50, height: 50, fill: '#0f0' });
		expect(added.ok).toBe(true);
		const id = (added as any).result.id;
		expect((c.getNode(id) as VectorPathNode).fill).toBe('#0f0');
		const list = (registry.execute('vector.list')) as any;
		expect(list.result.nodes.map((n: any) => n.id)).toEqual(['a', id]);
		expect((registry.execute('vector.transform', { ids: ['a'], dx: 5 })).ok).toBe(true);
		expect(vectorNodeBounds(c.getNode('a')!)!.x).toBe(5);
		const bad = registry.execute('vector.setStyle', { ids: ['nope'], fill: '#000' });
		expect(bad).toMatchObject({ ok: false, code: 'failed' });
		const svg = (registry.execute('vector.exportSvg')) as any;
		expect(svg.result.svg).toContain('<svg');
		expect((registry.execute('vector.addPath', { d: 'M0 0 L 10 10', stroke: '#000' })).ok).toBe(true);
	});
});

describe('per-node transforms', () => {
	const close = (m: readonly number[], n: readonly number[]) => m.forEach((v, i) => expect(v).toBeCloseTo(n[i], 9));

	it('keeps rotation in a rigid transform and bakes scale into the anchors', () => {
		const rotated = transformVectorNode(rectNode('a', 0, 0, 100, 50), rotateMatrix(30));
		expect(vectorNodeRotation(rotated)).toBeCloseTo(30);
		expect(rotated.subpaths).toEqual(rectNode('a', 0, 0, 100, 50).subpaths); // geometry untouched
		const scaled = transformVectorNode(rotated, multiplyMatrices(multiplyMatrices(rotateMatrix(-30), scaleMatrix(2, 1)), rotateMatrix(30)));
		expect(vectorNodeRotation(scaled)).toBeCloseTo(30);
		const local = vectorNodeBounds({ ...scaled, transform: undefined })!;
		expect(local.width).toBeCloseTo(200);
		expect(local.height).toBeCloseTo(50);
		const moved = transformVectorNode(rectNode('b', 0, 0), translateMatrix(5, 5));
		expect(moved.transform).toBeUndefined(); // unrotated nodes store positions directly
		expect(vectorNodeBounds(moved)).toMatchObject({ x: 5, y: 5 });
	});

	it('splits any matrix into residual × rigid', () => {
		const m = multiplyMatrices(multiplyMatrices([1, 0.3, 0, 1, 0, 0], scaleMatrix(2, 3)), multiplyMatrices(rotateMatrix(40), translateMatrix(7, -2)));
		const { rigid, residual } = decomposeRigid(m);
		close(multiplyMatrices(residual, rigid), m);
		expect(rigid[0] * rigid[3] - rigid[1] * rigid[2]).toBeCloseTo(1);
		expect(matrixRotation(scaleMatrix(-1, 1))).toBe(0);
		expect(matrixRotation(multiplyMatrices(scaleMatrix(-1, 1), rotateMatrix(30)))).toBeCloseTo(30);
	});

	it('keeps the selection box rotated through rotate, resize and flip', () => {
		const c = make(doc(rectNode('a', 100, 100, 100, 50, { stroke: '#000', strokeWidth: 4 })));
		c.select(['a']);
		c.rotate(30);
		const f = c.getState().selectionFrame!;
		expect(f.angle).toBeCloseTo(30);
		expect(f.width).toBeCloseTo(100);
		expect(f.height).toBeCloseTo(50);
		c.scale(2, 1);
		const g = c.getState().selectionFrame!;
		expect(g.angle).toBeCloseTo(30);
		expect(g.width).toBeCloseTo(200);
		expect(g.height).toBeCloseTo(50);
		expect((c.getNode('a') as VectorPathNode).strokeWidth).toBe(4);
		c.flip('horizontal');
		expect(c.getState().selectionFrame!.angle).toBeCloseTo(30);
		expect(c.getState().selectionFrame!.width).toBeCloseTo(200);
		c.setRotation(0);
		expect(c.getNode('a')!.transform).toBeUndefined();
		expect(c.getState().selectionFrame!.angle).toBe(0);
		expect(c.getState().selectionFrame!.width).toBeCloseTo(200);
	});

	it('resizes a rotated node with the handles along its own axes', () => {
		const c = make(doc(rectNode('a', 0, 0, 100, 100)));
		c.select(['a']);
		c.rotate(90, { origin: { x: 50, y: 50 } });
		const before = c.getState().selectionFrame!;
		expect(before.angle).toBeCloseTo(90);
		const handle = getVectorOverlayRenderData(c.getState()).selectionBox!.handles.find((h) => h.handle === 'e')!;
		c.pointerMove(handle.screen);
		expect(c.getState().cursor).toBe('ns-resize'); // the "e" handle points down after 90°
		c.pointerDown(handle.screen);
		c.pointerUp({ x: handle.screen.x, y: handle.screen.y + 100 });
		const after = c.getState().selectionFrame!;
		expect(after.angle).toBeCloseTo(90);
		expect(after.width).toBeCloseTo(200);
		expect(after.height).toBeCloseTo(100);
	});

	it('hit-tests the rotated shape, not its axis-aligned box', () => {
		const c = make(doc(rectNode('a', 0, 45, 100, 10)));
		c.rotate(45, { ids: ['a'], origin: { x: 50, y: 50 } });
		expect(hitTestVectorNode(c.getNode('a')!, { x: 50, y: 50 })).toBe(true);
		expect(hitTestVectorNode(c.getNode('a')!, { x: 85, y: 85 })).toBe(true);
		expect(hitTestVectorNode(c.getNode('a')!, { x: 85, y: 15 })).toBe(false);
	});

	it('edits anchors of a rotated path in document space', () => {
		const c = make(doc(rectNode('a', 0, 0, 100, 100)));
		c.rotate(90, { ids: ['a'], origin: { x: 0, y: 0 } });
		const ref = { nodeId: 'a', subpath: 0, index: 1 }; // local (100, 0) → document (0, 100)
		const w = getAnchorWorld(c.getState().document, ref)!;
		expect(w.x).toBeCloseTo(0);
		expect(w.y).toBeCloseTo(100);
		c.setTool('direct');
		c.select(['a']);
		c.pointerDown({ x: 0, y: 100 });
		c.pointerUp({ x: 0, y: 100 });
		expect(c.getState().selectedAnchors).toEqual([ref]);
		c.keyDown({ key: 'ArrowRight', shift: true }); // +10 in document x
		const moved = getAnchorWorld(c.getState().document, ref)!;
		expect(moved.x).toBeCloseTo(10);
		expect(moved.y).toBeCloseTo(100);
	});

	it('composes group transforms into children on ungroup', () => {
		const c = make(doc(rectNode('a', 0, 0, 10, 10), rectNode('b', 20, 0, 10, 10)));
		c.select(['a', 'b']);
		const g = c.group()!;
		c.rotate(60);
		expect(vectorNodeRotation(c.getNode(g)!)).toBeCloseTo(60);
		expect(c.getNode('a')!.transform).toBeUndefined();
		const before = vectorNodeBounds(c.getNode(g)!)!;
		c.ungroup();
		expect(vectorNodeRotation(c.getNode('a')!)).toBeCloseTo(60);
		const after = unionBoundsOf(c, ['a', 'b']);
		expect(after.x).toBeCloseTo(before.x);
		expect(after.width).toBeCloseTo(before.width);
	});

	it('runs booleans on rotated shapes in document space', () => {
		const c = make(doc(rectNode('a', 0, 0, 100, 100), rectNode('b', 50, 0, 100, 100)));
		c.rotate(90, { ids: ['b'] });
		c.select(['a', 'b']);
		const id = c.booleanOp('union')!;
		expect(c.getNode(id)!.transform).toBeUndefined();
		expect(vectorNodeBounds(c.getNode(id)!)).toEqual({ x: 0, y: 0, width: 150, height: 100 });
	});

	it('writes and reads rotations as SVG matrices', () => {
		const c = make(doc(rectNode('a', 0, 0, 100, 50)));
		c.rotate(30, { ids: ['a'] });
		const svg = c.toSvg();
		expect(svg).toMatch(/<path id="a" transform="matrix\(0\.866025 0\.5 -0\.5 0\.866025 /);
		const back = parseVectorSvg(svg).nodes[0];
		expect(vectorNodeRotation(back)).toBeCloseTo(30);
		const imported = parseVectorSvg('<svg width="10" height="10"><g transform="rotate(45)"><rect width="4" height="2" transform="scale(2)"/></g></svg>');
		const rect = (imported.nodes[0] as VectorGroupNode).children[0];
		expect(vectorNodeRotation(rect)).toBeCloseTo(45);
		expect(vectorNodeBounds({ ...rect, transform: undefined })).toEqual({ x: 0, y: 0, width: 8, height: 4 });
	});
});

function unionBoundsOf(c: VectorEditorController, ids: string[]) {
	const bs = ids.map((id) => vectorNodeBounds(c.getNode(id)!)!);
	const x = Math.min(...bs.map((b) => b.x));
	const r = Math.max(...bs.map((b) => b.x + b.width));
	return { x, width: r - x };
}
