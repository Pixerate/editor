// Lens objects (CorelDRAW's Lens, concept only): a closed path that shows what is below it
// changed. Test cases our own.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import { bezierPathBounds } from '../src/canvas/pathops';
import {
	VectorEditorController,
	createVectorCommands,
	ellipseSubpath,
	expandVectorAppearance,
	getVectorSceneRenderData,
	hitTestVectorNodes,
	isVectorLens,
	mapVectorPaintColors,
	parseVectorSvg,
	rectSubpath,
	resolveVectorLenses,
	sanitizeVectorLens,
	stripVectorLensViews,
	subpathsToBezier,
	vectorDocumentToLottie,
	vectorDocumentToPdf,
	vectorDocumentToSvg,
	vectorLensColorMap,
	vectorLensDrawn,
	vectorNodeBounds,
	type VectorDocument,
	type VectorGroupNode,
	type VectorLens,
	type VectorNode,
	type VectorPathNode
} from '../src/vector';

const rect = (id: string, x: number, y: number, w: number, h: number, extra: Partial<VectorPathNode> = {}): VectorPathNode => ({ id, type: 'path', subpaths: [rectSubpath({ x, y, width: w, height: h })], fill: '#ff0000', stroke: null, ...extra });
const lensAt = (lens: VectorLens, extra: Partial<VectorPathNode> = {}): VectorPathNode => ({ id: 'L', type: 'path', subpaths: [ellipseSubpath({ x: 0, y: 0, width: 100, height: 100 })], fill: '#ffffff', stroke: '#000000', strokeWidth: 1, lens, ...extra });
const doc = (...nodes: VectorNode[]): VectorDocument => ({ width: 200, height: 200, nodes });
const resolved = (d: VectorDocument) => resolveVectorLenses(d).nodes.find((n) => n.id === 'L') as VectorPathNode & { lens: VectorLens };
const contents = (lens: VectorPathNode & { lens: VectorLens }) => {
	const view = vectorLensDrawn(lens).children.find((c) => c.id === 'L~lens-view') as VectorGroupNode | undefined;
	return (view?.children.slice(1) ?? []) as VectorPathNode[];
};
const box = (n: VectorPathNode) => {
	const b = bezierPathBounds(subpathsToBezier(n.subpaths))!;
	return [b.minX, b.minY, b.maxX, b.maxY].map((v) => Math.round(v * 100) / 100);
};

describe('lens settings', () => {
	it('sanitizes types, amounts and colours', () => {
		expect(sanitizeVectorLens({ type: 'magnify', amount: 99 })).toEqual({ type: 'magnify', amount: 20 });
		expect(sanitizeVectorLens({ type: 'tintedGrayscale' })).toEqual({ type: 'tintedGrayscale', amount: 100, color: '#b45309' });
		expect(sanitizeVectorLens({ type: 'colorAdd', color: 'nope' })!.color).toBe('#ff0000');
		expect(sanitizeVectorLens({ type: 'blur' })).toBeNull();
	});

	it('recolours solids and gradient stops', () => {
		const invert = vectorLensColorMap({ type: 'invert', amount: 100 })!;
		expect(mapVectorPaintColors('#ff0000', invert)).toBe('#00ffff');
		const g = mapVectorPaintColors({ type: 'linear', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] }, invert) as { stops: { color: string }[] };
		expect(g.stops.map((s) => s.color)).toEqual(['#ffffff', '#000000']);
		expect(mapVectorPaintColors('#808080', vectorLensColorMap({ type: 'brighten', amount: 100 })!)).toBe('#ffffff');
		expect(mapVectorPaintColors('#ffffff', vectorLensColorMap({ type: 'colorLimit', amount: 100, color: '#00ff00' })!)).toBe('#00ff00');
		expect(vectorLensColorMap({ type: 'magnify', amount: 2 })).toBeNull();
	});
});

describe('lens backdrops', () => {
	it('sees what is drawn before it, and keeps node objects when nothing below changes', () => {
		const a = rect('a', 40, 40, 20, 20);
		const d = doc(a, lensAt({ type: 'invert', amount: 100 }), rect('top', 0, 0, 10, 10));
		const L = resolved(d);
		expect(L.lensView!.map((n) => n.id)).toEqual(['a']);
		const once = resolveVectorLenses(d);
		expect(resolveVectorLenses(once)).toBe(once);
		expect(L.lensView![0]).toBe(a);
		expect(stripVectorLensViews(resolveVectorLenses(d)).nodes.find((n) => n.id === 'L')).not.toHaveProperty('lensView');
	});

	it('sees outer art through the inverse of its group transform', () => {
		const d = doc(rect('a', 40, 40, 20, 20), { id: 'g', type: 'group', transform: [1, 0, 0, 1, 10, 0], children: [lensAt({ type: 'invert', amount: 100 })] });
		const g = resolveVectorLenses(d).nodes[1] as VectorGroupNode;
		const L = g.children[0] as VectorPathNode & { lens: VectorLens };
		const [shape] = contents(L);
		// The square at 40 in the document is at 30 inside the group.
		expect(box(shape)).toEqual([30, 40, 50, 60]);
	});
});

describe('lens drawing', () => {
	it('magnifies about its centre, clipped by its outline, keeping its own bounds and hits', () => {
		const d = doc(rect('a', 45, 45, 10, 10), lensAt({ type: 'magnify', amount: 3 }));
		const L = resolved(d);
		expect(box(contents(L)[0])).toEqual([35, 35, 65, 65]);
		const view = vectorLensDrawn(L).children[0] as VectorGroupNode;
		expect(view.mask).toEqual({ type: 'clip' });
		const b = vectorNodeBounds(L)!;
		expect([b.x, b.y, b.width, b.height].map(Math.round)).toEqual([0, 0, 100, 100]);
		expect(hitTestVectorNodes([L], { x: 20, y: 50 })?.id).toBe('L');
	});

	it('bulges with fisheye, leaving the edge in place', () => {
		const d = doc(rect('a', 50, 50, 20, 20, { fill: '#00ff00' }), lensAt({ type: 'fisheye', amount: 100 }));
		const [shape] = contents(resolved(d));
		const b = box(shape);
		// The square's near corner stays at the centre; its far corner moves out.
		expect(b[0]).toBeCloseTo(50, 0);
		expect(b[2]).toBeGreaterThan(70);
	});

	it('recolours and wireframes the backdrop, and leaves out what it cannot show', () => {
		const d = (lens: VectorLens) => doc(rect('a', 40, 40, 20, 20), rect('far', 150, 150, 10, 10), lensAt(lens));
		const inv = contents(resolved(d({ type: 'invert', amount: 100 })));
		expect(inv).toHaveLength(1);
		expect(inv[0].fill).toBe('#00ffff');
		const wire = contents(resolved(d({ type: 'wireframe', amount: 100, color: '#0000ff' })))[0];
		expect(wire.fill).toBeNull();
		expect(wire.stroke).toBe('#0000ff');
	});

	it('draws a transparency lens as its own see-through fill', () => {
		const drawn = vectorLensDrawn(resolved(doc(rect('a', 40, 40, 20, 20), lensAt({ type: 'transparency', amount: 75 }))));
		expect(drawn.children.map((c) => c.id)).toEqual(['L~lens-fill', 'L~lens-stroke']);
		expect(drawn.children[0].opacity).toBeCloseTo(0.25);
	});

	it('renders, exports to SVG and PDF with what is below, and round-trips its settings', () => {
		const d = doc(rect('a', 40, 40, 20, 20), lensAt({ type: 'invert', amount: 100 }));
		const scene = getVectorSceneRenderData({ document: d, viewport: { x: 0, y: 0, zoom: 1 } });
		const json = JSON.stringify(scene.nodes[1]);
		expect(json).toContain('#00ffff');
		expect(json).toContain('"mask"');
		const svg = vectorDocumentToSvg(d);
		expect(svg).toContain('data-vector-lens');
		expect(svg).toContain('#00ffff');
		const back = parseVectorSvg(svg).nodes.find((n) => n.id === 'L') as VectorPathNode;
		expect(back.lens).toEqual({ type: 'invert', amount: 100 });
		expect(isVectorLens(back)).toBe(true);
		expect(vectorDocumentToPdf(d).bytes.length).toBeGreaterThan(0);
		expect(vectorDocumentToLottie(d).notes.some((n) => n.includes('lens'))).toBe(true);
		expect(expandVectorAppearance(resolved(d)).type).toBe('group');
	});
});

describe('lenses in the editor', () => {
	it('follows edits below it, in one undo step, and is not saved with its backdrop (toJSON)', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 40, 40, 20, 20), lensAt({ type: 'invert', amount: 100 }, { lens: undefined })) });
		const r = c.setLens({ type: 'magnify', amount: 2 }, { ids: ['L'] });
		expect(r).toMatchObject({ ok: true, lenses: [{ id: 'L', lens: { type: 'magnify', amount: 2 } }] });
		expect((c.getNode('L') as VectorPathNode).lensView!.map((n) => n.id)).toEqual(['a']);
		c.translate(5, 0, { ids: ['a'] });
		const L = c.getNode('L') as VectorPathNode & { lens: VectorLens };
		expect(box(contents(L)[0])).toEqual([40, 30, 80, 70]);
		expect(c.toJSON().nodes.find((n) => n.id === 'L')).not.toHaveProperty('lensView');
		c.undo();
		c.undo();
		expect((c.getNode('L') as VectorPathNode).lens).toBeUndefined();
		expect(c.setLens({ type: 'magnify', amount: 50 }, { ids: ['L'] }).ok).toBe(false);
		expect(c.setLens({ amount: 2 }, { ids: ['L'] })).toMatchObject({ ok: false, message: expect.stringContaining('pass a type') });
	});
});

describe('lens commands through the tool registry', () => {
	it('sets, changes, lists and removes lenses, and refuses what cannot be one', async () => {
		const c = new VectorEditorController({ document: doc(rect('a', 40, 40, 20, 20), lensAt({ type: 'invert', amount: 100 }, { lens: undefined }), { id: 'open', type: 'path', subpaths: [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }], fill: null, stroke: '#000' }) });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const run = async (id: string, params?: unknown) => {
			const r = await tools.callTool('run_command', { id, ...(params !== undefined ? { params } : {}) });
			return { isError: !!r.isError, text: r.content?.map((x: any) => x.text).join('') ?? '', ...(r.structuredContent as any) };
		};
		expect((await run('vector.setLens', { ids: ['L'], type: 'heatMap' })).result).toEqual({ lenses: [{ id: 'L', lens: { type: 'heatMap', amount: 0 } }] });
		expect((await run('vector.setLens', { ids: ['L'], amount: 30 })).result.lenses[0].lens.amount).toBe(30);
		expect((await run('vector.list')).result.nodes.find((n: any) => n.id === 'L').lens.type).toBe('heatMap');
		expect((await run('vector.setLens', { ids: ['open'], type: 'invert' })).text).toContain('not a closed path');
		expect((await run('vector.setLens', { ids: ['L'], type: 'blur' })).isError).toBe(true);
		expect((await run('vector.setLens', { ids: ['L'] })).text).toContain('Pass at least one of');
		expect((await run('vector.removeLens', { ids: ['L', 'a'] })).result).toEqual({ ids: ['L'] });
		expect((c.getNode('L') as VectorPathNode).lens).toBeUndefined();
	});
});
