import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	createVectorCommands,
	expandVectorAppearance,
	getVectorOverlayRenderData,
	getVectorSceneRenderData,
	hitTestVectorNode,
	layoutVectorText,
	parseVectorSvg,
	setVectorTextShaper,
	transformVectorNode,
	vectorDocumentToSvg,
	vectorNodeBounds,
	vectorTextCaret,
	vectorTextIndexAt,
	vectorTextPaths,
	vectorTextSelectionQuads,
	VectorEditorController,
	type VectorGroupNode,
	type VectorPathNode,
	type VectorRenderText,
	type VectorTextNode
} from '../src/vector';
import { createMetricTextShaper, createOutlineTextShaper } from '../src/text';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import { boxFont } from './helpers/box-font';

/** Box font: 1000 units per em, every character 600 wide (space 300), ascender 800, descender 200. */
const outline = () => createOutlineTextShaper([boxFont('Box')]);
const text = (patch: Partial<VectorTextNode> = {}): VectorTextNode => ({
	id: 't',
	type: 'text',
	text: 'AB',
	font: { fontFamily: 'Box', fontWeight: 400, fontSize: 10 },
	frame: { kind: 'point', x: 0, y: 0 },
	fill: '#000000',
	...patch
});

beforeEach(() => setVectorTextShaper(outline()));
afterEach(() => setVectorTextShaper(null));

describe('vector text layout', () => {
	it('sets point text from its baseline origin, a line per paragraph', () => {
		const layout = layoutVectorText(text({ text: 'AB\nC', frame: { kind: 'point', x: 10, y: 50 } }));
		expect(layout.glyphs.map((g) => [g.char, g.x, g.y])).toEqual([
			['A', 10, 50],
			['B', 16, 50],
			['C', 10, 62]
		]);
		expect(layout.bounds).toEqual({ x: 10, y: 42, width: 12, height: 22 });
		expect(layout.overflow).toBe(false);
	});

	it('wraps area text in its box, aligns it, and hides lines that do not fit', () => {
		const node = text({ text: 'AA AA AA', frame: { kind: 'area', x: 0, y: 0, width: 30, height: 20 }, paragraph: { align: 'right' } });
		const layout = layoutVectorText(node);
		expect(layout.lines).toHaveLength(1);
		expect(layout.overflow).toBe(true);
		// Two words fit a line (27 of 30), right-aligned; the second line would end below the box.
		expect(layout.glyphs[0].x).toBeCloseTo(3);
		expect(layout.bounds).toEqual({ x: 0, y: 0, width: 30, height: 20 });
		const tall = layoutVectorText({ ...node, frame: { kind: 'area', x: 0, y: 0, width: 30, height: 100 } });
		expect(tall.lines).toHaveLength(2);
		expect(tall.overflow).toBe(false);
	});

	it('sets text along a path by arc length, turned with it, margins and flip respected', () => {
		const path = { closed: false, anchors: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };
		const node = text({ text: 'AB', frame: { kind: 'path', path, start: 10 } });
		const g = layoutVectorText(node).glyphs;
		expect(g.map((x) => [x.x, x.y, x.angle])).toEqual([
			[10, 0, 0],
			[16, 0, 0]
		]);
		// Down a vertical path the glyphs turn 90° and stack along it.
		const down = layoutVectorText(text({ text: 'AB', frame: { kind: 'path', path: { closed: false, anchors: [{ x: 0, y: 0 }, { x: 0, y: 100 }] } } })).glyphs;
		expect(down[0].angle).toBeCloseTo(90);
		expect(down[1].y).toBeCloseTo(6);
		// Flipped, the text runs from the other end, upside down.
		const flipped = layoutVectorText({ ...node, frame: { kind: 'path', path, flip: true } }).glyphs;
		expect(flipped[0].x).toBeCloseTo(100);
		expect(Math.abs(flipped[0].angle)).toBeCloseTo(180);
		// Centred, and on its ascender (hanging below the path).
		const centred = layoutVectorText({ ...node, paragraph: { align: 'center' }, frame: { kind: 'path', path, baseline: 'ascender' } }).glyphs;
		expect(centred[0].x).toBeCloseTo(44);
		expect(centred[0].y).toBeCloseTo(8);
		// Past the end of an open path: hidden and reported.
		const long = layoutVectorText(text({ text: 'AAAAAAAAAAAAAAAAAAAA', frame: { kind: 'path', path } }));
		expect(long.overflow).toBe(true);
		expect(long.glyphs.length).toBeLessThan(20);
	});

	it('maps carets and clicks both ways, and covers selections with quads', () => {
		const node = text({ text: 'AB\nCD', frame: { kind: 'point', x: 0, y: 20 } });
		const c = vectorTextCaret(node, 1);
		expect(c.top).toEqual({ x: 6, y: 12 });
		expect(c.bottom).toEqual({ x: 6, y: 22 });
		expect(vectorTextCaret(node, 4).line).toBe(1);
		expect(vectorTextIndexAt(node, { x: 7, y: 18 })).toBe(1);
		expect(vectorTextIndexAt(node, { x: 11, y: 31 })).toBe(5);
		expect(vectorTextSelectionQuads(node, 0, 5)).toHaveLength(2);
	});
});

describe('vector text geometry and drawing', () => {
	it('draws as glyph outlines with an outline shaper: path effects, bounds and hit testing work on them', () => {
		const node = text({ text: 'A', frame: { kind: 'point', x: 0, y: 10 } });
		const paths = vectorTextPaths(node);
		expect(paths.outlines).toBe(true);
		const drawn = expandVectorAppearance(node) as VectorPathNode;
		expect(drawn.type).toBe('path');
		expect(drawn.id).toBe('t');
		expect(vectorNodeBounds(node)).toEqual({ x: 0.5, y: 3, width: 5, height: 7 });
		expect(hitTestVectorNode(node, { x: 3, y: 6 })).toBe(true);
		expect(hitTestVectorNode(node, { x: 3, y: 12 })).toBe(false);
		const scene = getVectorSceneRenderData({ document: { width: 100, height: 100, nodes: [node] }, viewport: { x: 0, y: 0, zoom: 1 } });
		expect(scene.nodes[0].kind).toBe('path');
	});

	it('draws as SVG text without outlines, placed character by character', () => {
		setVectorTextShaper(createMetricTextShaper());
		const node = text({ text: 'Hi', frame: { kind: 'point', x: 5, y: 20 }, font: { fontFamily: 'Inter', fontWeight: 700, fontSize: 10, italic: true, underline: true } });
		expect(vectorTextPaths(node).outlines).toBe(false);
		const scene = getVectorSceneRenderData({ document: { width: 100, height: 100, nodes: [node] }, viewport: { x: 0, y: 0, zoom: 1 } });
		const t = scene.nodes[0] as VectorRenderText;
		expect(t.kind).toBe('text');
		expect(t.layers).toEqual([{ kind: 'fill', fill: '#000000', stroke: 'none', strokeWidth: 0, opacity: 1, runFills: true }]);
		expect(t.spans[0]).toMatchObject({ text: 'Hi', y: '20', fontFamily: 'Inter', fontSize: 10, fontWeight: 700, fontStyle: 'italic', textDecoration: 'underline' });
		expect(t.spans[0].x.split(' ').map(Number)[0]).toBe(5);
		// Effects need outlines: without them the text draws (and hits) unaffected.
		const wiggly = { ...node, effects: [{ id: 'e', type: 'puckerBloat' as const, params: { amount: 50 } }] };
		expect(vectorNodeBounds(wiggly)).toEqual(vectorNodeBounds(node));
	});

	it('runs with their own fill draw as their own shapes', () => {
		const node = text({ text: 'AB', runs: [{ length: 1, style: { fill: '#ff0000' } }, { length: 1, style: {} }] });
		const parts = vectorTextPaths(node).parts;
		expect(parts.map((p) => p.fill)).toEqual(['#ff0000', undefined]);
		const drawn = expandVectorAppearance(node) as VectorGroupNode;
		expect(drawn.type).toBe('group');
		expect(drawn.children.map((c) => (c as VectorPathNode).fill)).toEqual(['#ff0000', '#000000']);
	});

	it('bakes scale into font sizes and the frame, keeping the rotation rigid', () => {
		const node = text({ frame: { kind: 'area', x: 10, y: 10, width: 40, height: 20 } });
		const scaled = transformVectorNode(node, [2, 0, 0, 3, 0, 0]);
		expect(scaled.font.fontSize).toBeCloseTo(10 * Math.sqrt(6));
		expect(scaled.frame).toEqual({ kind: 'area', x: 20, y: 30, width: 80, height: 60 });
		expect(scaled.transform).toBeUndefined();
		const turned = transformVectorNode(node, [0, 1, -1, 0, 0, 0]);
		expect(turned.font.fontSize).toBeCloseTo(10);
		expect(turned.transform).toBeDefined();
	});

	it('exports SVG text with its data and imports it back as the same text', () => {
		setVectorTextShaper(createMetricTextShaper());
		const node = text({ text: 'A & <B>', runs: [{ length: 1, style: { fill: '#ff0000', fontWeight: 700 } }], paragraph: { align: 'center' }, stroke: '#00f', strokeWidth: 2, transform: [0, 1, -1, 0, 5, 5] });
		const svg = vectorDocumentToSvg({ width: 100, height: 100, nodes: [node] });
		expect(svg).toContain('<text');
		expect(svg).toContain('&amp; &lt;B&gt;');
		const back = parseVectorSvg(svg).nodes[0] as VectorTextNode;
		expect(back).toMatchObject({ type: 'text', text: 'A & <B>', runs: [...node.runs!, { length: 6, style: {} }], paragraph: node.paragraph, frame: node.frame, fill: '#000000', stroke: '#00f', strokeWidth: 2 });
		back.transform!.forEach((v, i) => expect(v).toBeCloseTo(node.transform![i]));
	});

	it('exports text with effects as its outlines when it has them, keeping the text for import', () => {
		const node = text({ text: 'AB', effects: [{ id: 'e', type: 'twist', params: { angle: 20, center: { x: 0, y: 0 } } }] });
		const svg = vectorDocumentToSvg({ width: 100, height: 100, nodes: [node] });
		expect(svg).toContain('data-vector-live');
		expect(svg).not.toMatch(/<text [^>]*fill="#000000"[^>]*>(?!<tspan)/);
		const back = parseVectorSvg(svg).nodes[0] as VectorTextNode;
		expect(back).toMatchObject({ id: 't', type: 'text', text: 'AB', effects: node.effects });
		expect(vectorDocumentToSvg({ width: 100, height: 100, nodes: [text()] }, { text: 'outlines' })).toContain('data-vector-live');
	});
});

describe('VectorEditorController text', () => {
	it('adds, edits and styles text, one undo step each', () => {
		const c = new VectorEditorController();
		const id = c.addText({ text: 'Hello', x: 10, y: 40, font: { fontFamily: 'Box', fontSize: 20 } });
		const node = () => c.getNode(id) as VectorTextNode;
		expect(node()).toMatchObject({ type: 'text', text: 'Hello', name: 'Hello', fill: '#000000', frame: { kind: 'point', x: 10, y: 40 } });
		expect(c.setText(id, 'J', { start: 0, end: 1 }).ok).toBe(true);
		expect(node().text).toBe('Jello');
		expect(node().name).toBe('Jello');
		expect(c.setTextStyle(id, { fontWeight: 700, fill: '#f00' }, { start: 1, end: 3 }).ok).toBe(true);
		expect(node().runs).toEqual([
			{ length: 1, style: {} },
			{ length: 2, style: { fontWeight: 700, fill: '#f00' } },
			{ length: 2, style: {} }
		]);
		expect(c.setTextStyle(id, { fontSize: 30 }).ok).toBe(true);
		expect(node().font.fontSize).toBe(30);
		expect(c.setParagraphStyle(id, { align: 'center' }).ok).toBe(true);
		expect(node().paragraph).toEqual({ align: 'center' });
		expect(c.setTextStyle(id, { fontSize: -2 })).toEqual({ ok: false, message: expect.stringMatching(/fontSize must be a number/) });
		expect(c.setText(id, 'x', { start: 4, end: 99 })).toEqual({ ok: false, message: expect.stringMatching(/0 ≤ start ≤ end ≤ 5/) });
		c.undo();
		expect(node().paragraph).toBeUndefined();
		c.undo();
		c.undo();
		expect(node().runs).toBeUndefined();
	});

	it('types into new text with the Type tool as one undo step, and drops it when left empty', () => {
		const c = new VectorEditorController();
		c.setTool('type');
		c.pointerDown({ x: 20, y: 30 });
		c.pointerUp({ x: 20, y: 30 });
		const id = c.getState().textEdit!.nodeId;
		expect(c.getNode(id)?.type).toBe('text');
		expect(c.getState().canUndo).toBe(false);
		c.textInput('Hi');
		c.textInput(' there');
		expect((c.getNode(id) as VectorTextNode).text).toBe('Hi there');
		expect(c.keyDown({ key: 'Backspace' })).toBe(true);
		expect(c.keyDown({ key: 'ArrowLeft', shift: true })).toBe(true);
		expect(c.getState().textEdit).toMatchObject({ anchor: 7, focus: 6 });
		expect(c.keyDown({ key: 'Escape' })).toBe(true);
		expect(c.getState().textEdit).toBeNull();
		expect((c.getNode(id) as VectorTextNode).text).toBe('Hi ther');
		c.undo();
		expect(c.getNode(id)).toBeUndefined();
		// A click that types nothing leaves nothing behind.
		c.pointerDown({ x: 50, y: 50 });
		c.pointerUp({ x: 50, y: 50 });
		c.endTextEdit();
		expect(c.getDocument().nodes).toHaveLength(0);
		// A drag makes area text.
		c.pointerDown({ x: 10, y: 10 });
		c.pointerMove({ x: 110, y: 60 });
		c.pointerUp({ x: 110, y: 60 });
		const area = c.getNode(c.getState().textEdit!.nodeId) as VectorTextNode;
		expect(area.frame).toEqual({ kind: 'area', x: 10, y: 10, width: 100, height: 50 });
	});

	it('shows the caret and selection in the overlay while editing', () => {
		const c = new VectorEditorController();
		const id = c.addText({ text: 'AB', x: 0, y: 20, font: { fontFamily: 'Box', fontSize: 10 } });
		c.setTool('type');
		c.editText(id, { index: 1 });
		let o = getVectorOverlayRenderData(c.getState()).text!;
		expect(o.caret).toEqual({ x1: 6, y1: 12, x2: 6, y2: 22 });
		c.selectText(0, 2);
		o = getVectorOverlayRenderData(c.getState()).text!;
		expect(o.caret).toBeNull();
		expect(o.selection).toHaveLength(1);
	});

	it('sets text on a path, switches frames and creates outlines', () => {
		const c = new VectorEditorController();
		const path = c.addPath('M0 50 L200 50');
		const r = c.typeOnPath(path, { text: 'AB', font: { fontFamily: 'Box', fontSize: 10 } });
		expect(r.ok).toBe(true);
		const id = r.id!;
		expect(c.getNode(path)).toBeUndefined();
		expect((c.getNode(id) as VectorTextNode).frame.kind).toBe('path');
		expect(c.setTextFrame(id, { start: 20, baseline: 'center' }).ok).toBe(true);
		expect((c.getNode(id) as VectorTextNode).frame).toMatchObject({ kind: 'path', start: 20, baseline: 'center' });
		expect(c.setTextFrame(id, { kind: 'area', width: 50 }).ok).toBe(true);
		expect((c.getNode(id) as VectorTextNode).frame).toMatchObject({ kind: 'area', width: 50 });
		expect(c.setTextFrame(id, { kind: 'path' })).toEqual({ ok: false, message: expect.stringMatching(/Pass path/) });
		const out = c.createOutlines({ ids: [id] });
		expect(out).toEqual({ ok: true, ids: [id] });
		const outlined = c.getNode(id) as VectorPathNode;
		expect(outlined.type).toBe('path');
		expect(outlined.subpaths.length).toBe(2);
		setVectorTextShaper(createMetricTextShaper());
		const t2 = c.addText({ text: 'x' });
		expect(c.createOutlines({ ids: [t2] })).toEqual({ ok: false, message: expect.stringMatching(/no glyph outlines/) });
	});

	it('styles text with setStyle and the fill stack commands', () => {
		const c = new VectorEditorController();
		const id = c.addText({ text: 'AB' });
		expect(c.setStyle({ fill: '#123456', stroke: '#fff', strokeWidth: 2 }, [id]).ok).toBe(true);
		expect(c.getNode(id)).toMatchObject({ fill: '#123456', stroke: '#fff', strokeWidth: 2 });
		expect(c.addPaintLayer('fill', { paint: '#00ff00', opacity: 0.5 }, { ids: [id] }).ok).toBe(true);
		expect((c.getNode(id) as VectorTextNode).fills).toHaveLength(2);
	});

	it('lists text to agents', () => {
		const c = new VectorEditorController();
		c.addText({ text: 'Hi', x: 1, y: 2 });
		const list = createVectorCommands(c).find((x) => x.id === 'vector.list')!.run(undefined, undefined) as { nodes: Array<Record<string, unknown>> };
		expect(list.nodes[0]).toMatchObject({ type: 'text', text: 'Hi', frame: 'point' });
	});
});

describe('vector text commands through the tool registry', () => {
	const setup = () => {
		const controller = new VectorEditorController();
		const commands = new CommandRegistry({ context: undefined });
		commands.register(createVectorCommands(controller));
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const run = async (id: string, params: Record<string, unknown> = {}) => {
			const r = await tools.callTool('run_command', { id, params });
			const sc = r.structuredContent as { result?: any; error?: { message: string } };
			return { ok: !r.isError, result: sc.result, message: sc.error?.message };
		};
		return { controller, run };
	};

	it('adds, reads, edits and styles text, returning what changed', async () => {
		const { controller, run } = setup();
		const added = await run('vector.addText', { text: 'Hello world', x: 10, y: 50, font: { fontFamily: 'Box', fontSize: 10 }, fill: '#ff0000' });
		expect(added.ok).toBe(true);
		const id = added.result.id;
		expect(added.result).toMatchObject({ text: 'Hello world', fill: '#ff0000', frame: { kind: 'point', x: 10, y: 50 }, overflow: false, outlines: true, lines: [{ start: 0, end: 11, text: 'Hello world' }] });
		const styled = await run('vector.setTextStyle', { id, start: 0, end: 5, fontWeight: 700, fill: '#00f' });
		expect(styled.result.runs).toEqual([{ start: 0, end: 5, style: { fontWeight: 700, fill: '#00f' } }]);
		const edited = await run('vector.setText', { id, text: 'there', start: 6, end: 11 });
		expect(edited.result.text).toBe('Hello there');
		const para = await run('vector.setParagraphStyle', { id, align: 'center' });
		expect(para.result.paragraph).toEqual({ align: 'center' });
		const area = await run('vector.setTextFrame', { id, kind: 'area', width: 30, height: 12 });
		expect(area.result.frame).toMatchObject({ kind: 'area', width: 30, height: 12 });
		expect(area.result.overflow).toBe(true);
		const read = await run('vector.getText', { id });
		expect(read.result.lines.length).toBeGreaterThan(0);
		// Each write is one undo step.
		controller.undo();
		expect((controller.getNode(id) as VectorTextNode).frame.kind).toBe('point');
	});

	it('sets text on a path, lists fonts and creates outlines', async () => {
		const { controller, run } = setup();
		const path = controller.addPath('M0 0 C50 -50 150 -50 200 0');
		const onPath = await run('vector.typeOnPath', { pathId: path, text: 'ARC', paragraph: { align: 'center' }, baseline: 'descender' });
		expect(onPath.ok).toBe(true);
		expect(onPath.result.frame).toMatchObject({ kind: 'path', baseline: 'descender' });
		const fonts = await run('vector.listFonts');
		expect(fonts.result).toEqual({ shaper: expect.stringMatching(/^outline:/), outlines: true, families: ['Box'] });
		const outlines = await run('vector.createOutlines', { ids: [onPath.result.id] });
		expect(outlines.result).toEqual({ ids: [onPath.result.id] });
		expect(controller.getNode(onPath.result.id)?.type).toBe('path');
	});

	it('fails usefully and changes nothing on bad input', async () => {
		const { controller, run } = setup();
		const path = controller.addPath('M0 0 L10 10');
		expect(await run('vector.addText', { text: 'x', width: 10 })).toMatchObject({ ok: false, message: expect.stringMatching(/both width and height/) });
		expect(await run('vector.addText', { text: 'x', start: 5 })).toMatchObject({ ok: false, message: expect.stringMatching(/only apply to text on a path/) });
		expect(await run('vector.addText', { text: 'x', font: { fontSize: 0 } })).toMatchObject({ ok: false });
		expect(await run('vector.getText', { id: path })).toMatchObject({ ok: false, message: expect.stringMatching(/is a path, not text/) });
		expect(await run('vector.setTextStyle', { id: path, fontSize: 4 })).toMatchObject({ ok: false });
		const id = (await run('vector.addText', { text: 'abc' })).result.id;
		expect(await run('vector.setTextStyle', { id })).toMatchObject({ ok: false, message: expect.stringMatching(/Pass at least one/) });
		expect(await run('vector.setText', { id, text: 'x', start: 2, end: 9 })).toMatchObject({ ok: false, message: expect.stringMatching(/≤ 3/) });
		expect(await run('vector.typeOnPath', { pathId: id })).toMatchObject({ ok: false, message: expect.stringMatching(/not a path/) });
		setVectorTextShaper(createMetricTextShaper());
		expect(await run('vector.createOutlines', { ids: [id] })).toMatchObject({ ok: false, message: expect.stringMatching(/no glyph outlines/) });
		expect((controller.getNode(id) as VectorTextNode).text).toBe('abc');
	});
});
