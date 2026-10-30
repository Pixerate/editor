import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	createVectorCommands,
	layoutVectorText,
	parseVectorSvg,
	setVectorTextShaper,
	vectorDocumentToSvg,
	vectorTextCaret,
	vectorTextIndexAt,
	vectorTextPaths,
	vectorTextSelectionQuads,
	vectorTextSpans,
	VectorEditorController,
	type VectorTextNode
} from '../src/vector';
import { createMetricTextShaper, createOutlineTextShaper } from '../src/text';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import { boxFont } from './helpers/box-font';

/** Box font: 1000 units per em, every character 600 wide, ascender 800, descender 200. */
const text = (patch: Partial<VectorTextNode> = {}): VectorTextNode => ({
	id: 't',
	type: 'text',
	text: '一二',
	font: { fontFamily: 'Box', fontWeight: 400, fontSize: 10 },
	frame: { kind: 'point', x: 50, y: 20 },
	orientation: 'vertical',
	fill: '#000000',
	...patch
});

beforeEach(() => setVectorTextShaper(createOutlineTextShaper([boxFont('Box')])));
afterEach(() => setVectorTextShaper(null));

describe('vertical vector text', () => {
	it('sets point text in a column down from its origin, upright CJK centred and Latin turned', () => {
		const layout = layoutVectorText(text({ text: '一A' }));
		// 一: 6 wide, centred on x = 50, its 10 px cell from y = 20 (baseline 8 down).
		expect(layout.glyphs.map((g) => [g.char, g.angle])).toEqual([
			['一', 0],
			['A', 90]
		]);
		expect(layout.glyphs[0].x).toBeCloseTo(47);
		expect(layout.glyphs[0].y).toBeCloseTo(28);
		expect(layout.glyphs[1].y).toBeCloseTo(30);
		// SVG text: the turned glyph carries a 90° rotate.
		expect(vectorTextSpans(text({ text: '一A' })).map((s) => s.rotate ?? null)).toEqual([null, [90]]);
	});

	it('fills area text from the right edge, wrapping at the height, and flags columns past the left edge', () => {
		const layout = layoutVectorText(text({ text: '一二三四五', frame: { kind: 'area', x: 0, y: 0, width: 30, height: 25 } }));
		expect(layout.lines.map((l) => [l.start, l.end])).toEqual([
			[0, 2],
			[2, 4]
		]);
		// The first column's centre 5 in from the right edge (x 25), the next 12 to its left; the third (centre 1) does not fit.
		expect(layout.glyphs[0].x).toBeCloseTo(25 - 3);
		expect(layout.glyphs[2].x).toBeCloseTo(13 - 3);
		expect(layout.overflow).toBe(true);
	});

	it('draws glyph outlines in the column (upright boxes one under the other)', () => {
		const paths = vectorTextPaths(text());
		const pts = paths.parts[0].path.filter((c) => c.type !== 'Z') as Array<{ x: number; y: number }>;
		expect(Math.min(...pts.map((p) => p.x))).toBeCloseTo(47.5);
		expect(Math.max(...pts.map((p) => p.x))).toBeCloseTo(52.5);
		expect(Math.min(...pts.map((p) => p.y))).toBeCloseTo(21);
		expect(Math.max(...pts.map((p) => p.y))).toBeCloseTo(38);
	});

	it('draws glyph boxes per character without an outline shaper', () => {
		setVectorTextShaper(createMetricTextShaper());
		const paths = vectorTextPaths(text());
		expect(paths.outlines).toBe(false);
		expect(paths.parts[0].path.filter((c) => c.type === 'M')).toHaveLength(2);
	});

	it('places the caret across the column, hit-tests and selects down it', () => {
		const node = text({ text: '一二\n三' });
		const c = vectorTextCaret(node, 1);
		expect(c.top.y).toBeCloseTo(30);
		expect(c.bottom.y).toBeCloseTo(30);
		expect(c.top.x).toBeCloseTo(55);
		expect(c.bottom.x).toBeCloseTo(45);
		expect(vectorTextIndexAt(node, { x: 50, y: 32 })).toBe(1);
		expect(vectorTextIndexAt(node, { x: 38, y: 21 })).toBe(3);
		const quads = vectorTextSelectionQuads(node, 0, 4);
		expect(quads).toHaveLength(2);
		expect(quads[0][0]).toEqual({ x: 55, y: 20 });
	});

	it('moves the caret with ↑ ↓ along the column and ← → between columns while editing', () => {
		const c = new VectorEditorController();
		const id = c.addText({ text: '一二\n三四', x: 50, y: 20, font: { fontFamily: 'Box', fontSize: 10 }, orientation: 'vertical' });
		expect(c.editText(id, { index: 0 }).ok).toBe(true);
		c.keyDown({ key: 'ArrowDown' });
		expect(c.getState().textEdit).toMatchObject({ focus: 1 });
		c.keyDown({ key: 'ArrowLeft' });
		expect(c.getState().textEdit).toMatchObject({ focus: 4 });
		c.keyDown({ key: 'ArrowUp' });
		expect(c.getState().textEdit).toMatchObject({ focus: 3 });
		c.keyDown({ key: 'ArrowRight' });
		expect(c.getState().textEdit).toMatchObject({ focus: 0 });
	});

	it('round-trips through SVG export and JSON', () => {
		const c = new VectorEditorController();
		const id = c.addText({ text: '縦A', x: 50, y: 20, font: { fontFamily: 'Box', fontSize: 10, upright: true }, orientation: 'vertical' });
		const svg = vectorDocumentToSvg(c.getDocument());
		const back = parseVectorSvg(svg).nodes.find((n) => n.type === 'text') as VectorTextNode;
		expect(back.orientation).toBe('vertical');
		expect(back.font.upright).toBe(true);
		const json = JSON.parse(JSON.stringify(c.getDocument()));
		const d = new VectorEditorController();
		d.setDocument(json);
		expect((d.getNode(id) as VectorTextNode).orientation).toBe('vertical');
	});
});

describe('vertical vector text through the tool registry', () => {
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

	it('adds vertical text with textOrientation and reads its orientation back', async () => {
		const { run } = setup();
		const added = await run('vector.addText', { text: '縦書き', x: 50, y: 10, textOrientation: 'vertical', font: { fontFamily: 'Box', fontSize: 10 } });
		expect(added.ok).toBe(true);
		expect(added.result).toMatchObject({ orientation: 'vertical', lines: [{ start: 0, end: 3, text: '縦書き' }] });
		expect((await run('vector.getText', { id: added.result.id })).result.orientation).toBe('vertical');
	});

	it('switches orientation with vector.setTextOrientation as one undo step', async () => {
		const { controller, run } = setup();
		const id = (await run('vector.addText', { text: 'AB', x: 10, y: 50, font: { fontFamily: 'Box', fontSize: 10 } })).result.id;
		const r = await run('vector.setTextOrientation', { id, orientation: 'vertical' });
		expect(r).toMatchObject({ ok: true, result: { orientation: 'vertical' } });
		expect(layoutVectorText(controller.getNode(id) as VectorTextNode).glyphs.map((g) => g.angle)).toEqual([90, 90]);
		controller.undo();
		expect((controller.getNode(id) as VectorTextNode).orientation).toBeUndefined();
	});

	it('refuses vertical text on a path and bad orientations, saying why', async () => {
		const { controller, run } = setup();
		const onPath = await run('vector.addText', { text: 'x', path: 'M0 0 L100 0', textOrientation: 'vertical' });
		expect(onPath).toMatchObject({ ok: false, message: expect.stringMatching(/path cannot be vertical/) });
		expect(controller.getDocument().nodes).toHaveLength(0);
		const id = (await run('vector.addText', { text: 'x', path: 'M0 0 L100 0' })).result.id;
		expect(await run('vector.setTextOrientation', { id, orientation: 'vertical' })).toMatchObject({ ok: false, message: expect.stringMatching(/path cannot be vertical/) });
		expect((await run('vector.setTextOrientation', { id, orientation: 'slanted' })).ok).toBe(false);
		expect((await run('vector.setTextOrientation', { id: 'nope', orientation: 'vertical' })).ok).toBe(false);
	});

	it('sets the upright character style field', async () => {
		const { run } = setup();
		const id = (await run('vector.addText', { text: 'AB', textOrientation: 'vertical', font: { fontFamily: 'Box', fontSize: 10 } })).result.id;
		const r = await run('vector.setTextStyle', { id, upright: true });
		expect(r.result.font.upright).toBe(true);
	});
});
