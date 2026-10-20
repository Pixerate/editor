// Vector PDF export. After ArtCraft cadcraft `crates/io/src/pdf.rs` (the writer) and pdfcraft
// `crates/content/src/lib.rs` (content operators) (MIT OR Apache-2.0, © ArtCraft Team and
// contributors); test cases our own. See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import { inflate } from '../src/raster/zlib';
import { base64ToBytes } from '../src/raster/png';
import { VectorEditorController, createVectorCommands, createVectorFilter, rectSubpath, vectorDocumentToPdf, type VectorDocument, type VectorGroupNode, type VectorNode, type VectorPathNode } from '../src/vector';

const rect = (id: string, x: number, y: number, w: number, h = w, extra: Partial<VectorPathNode> = {}): VectorPathNode => ({ id, type: 'path', subpaths: [rectSubpath({ x, y, width: w, height: h })], fill: '#ff0000', stroke: null, ...extra });
const doc = (...nodes: VectorNode[]): VectorDocument => ({ width: 200, height: 100, nodes });
const latin = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');

/** The file's objects by number, checked against the cross-reference table. */
function parse(bytes: Uint8Array) {
	const text = latin(bytes);
	expect(text.startsWith('%PDF-1.7')).toBe(true);
	expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
	const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
	expect(text.slice(startxref, startxref + 4)).toBe('xref');
	const count = Number(/xref\n0 (\d+)/.exec(text)![1]);
	const entries = text.slice(startxref).split('\n').slice(3, 2 + count);
	const objects = new Map<number, string>();
	entries.forEach((e, k) => {
		const at = Number(e.slice(0, 10));
		// Every offset points at its object.
		expect(text.slice(at, at + `${k + 1} 0 obj`.length)).toBe(`${k + 1} 0 obj`);
		objects.set(k + 1, text.slice(at, text.indexOf('endobj', at)));
	});
	/** A content stream's text (inflated). */
	const stream = (id: number) => {
		const o = objects.get(id)!;
		const start = o.indexOf('stream\n') + 7;
		const raw = Uint8Array.from(o.slice(start, o.lastIndexOf('\nendstream')), (c) => c.charCodeAt(0));
		return o.includes('/FlateDecode') ? latin(inflate(raw)) : latin(raw);
	};
	const pages = [...objects.entries()].filter(([, o]) => o.includes('/Type /Page ')).map(([, o]) => ({ box: /\/MediaBox \[([^\]]+)\]/.exec(o)![1], content: stream(Number(/\/Contents (\d+) 0 R/.exec(o)![1])), dict: o }));
	return { text, objects, pages };
}

describe('vector PDF export', () => {
	it('writes a valid file with one page of the artboard, flipped to y down', () => {
		const r = vectorDocumentToPdf({ ...doc(rect('a', 10, 20, 30, 40)), background: '#ffffff' }, { title: 'Test' });
		expect(r.pages).toBe(1);
		const { pages, text } = parse(r.bytes);
		expect(pages[0].box).toBe('0 0 200 100');
		expect(text).toContain('/Title (Test)');
		const c = pages[0].content;
		expect(c.startsWith('1 0 0 -1 0 100 cm')).toBe(true);
		// Background, then the red square as a filled path.
		expect(c).toContain('1 1 1 rg\n0 0 200 100 re\nf');
		expect(c).toContain('1 0 0 rg\n10 20 m\n40 20 l\n40 60 l\n10 60 l\nh\nf');
	});

	it('strokes with width, caps, joins and dashes, and uses graphics states for opacity and blend modes', () => {
		const n = rect('a', 0, 0, 10, 10, { fill: null, stroke: '#0000ff', strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'bevel', strokeDasharray: [4, 2], opacity: 0.5, blendMode: 'multiply' });
		const { pages, objects } = parse(vectorDocumentToPdf(doc(n)).bytes);
		const c = pages[0].content;
		expect(c).toMatch(/0 0 1 RG[\s\S]*3 w\n1 J\n2 j\n\[4 2\] 0 d[\s\S]*S/);
		expect(c).toContain('/GS1 gs');
		expect([...objects.values()].some((o) => o.includes('/Type /ExtGState /ca 0.5 /CA 0.5 /BM /Multiply'))).toBe(true);
	});

	it('draws linear and radial gradients as PDF shadings clipped to the shape', () => {
		const linear = rect('a', 0, 0, 100, 50, { fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#ff0000' }, { offset: 0.5, color: '#00ff00' }, { offset: 1, color: '#0000ff' }] } });
		const radial = rect('b', 100, 0, 50, 50, { fill: { type: 'radial', stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] } });
		const { pages, objects } = parse(vectorDocumentToPdf(doc(linear, radial)).bytes);
		expect(pages[0].content).toMatch(/W n[\s\S]*\/Sh1 sh[\s\S]*W n[\s\S]*\/Sh2 sh/);
		const shadings = [...objects.values()].filter((o) => o.includes('/ShadingType'));
		expect(shadings.some((o) => o.includes('/ShadingType 2') && o.includes('/FunctionType 3') && o.includes('/Bounds [0.5]'))).toBe(true);
		expect(shadings.some((o) => o.includes('/ShadingType 3'))).toBe(true);
		expect(pages[0].dict).toContain('/Shading <<');
	});

	it('clips clip-mask contents and notes what it leaves out', () => {
		const clip: VectorGroupNode = { id: 'g', type: 'group', mask: { type: 'clip' }, children: [rect('m', 0, 0, 10, 10), rect('art', 5, 5, 20, 20)] };
		const shadow = rect('s', 50, 0, 10, 10, { filters: [createVectorFilter('dropShadow', 'f')!] });
		const opacityMask: VectorGroupNode = { id: 'o', type: 'group', mask: { type: 'luminance' }, children: [rect('m2', 100, 0, 10, 10, { fill: '#ffffff' }), rect('art2', 100, 0, 10, 10)] };
		const r = vectorDocumentToPdf(doc(clip, shadow, opacityMask));
		expect(parse(r.bytes).pages[0].content).toContain('0 0 m\n10 0 l\n10 10 l\n0 10 l\nh\nW n');
		expect(r.notes).toEqual(expect.arrayContaining(['Filters (shadows, glows, blurs) are left out.', 'Opacity masks are left out (the contents are drawn whole).']));
	});

	it('writes a page per artboard, each its own size', () => {
		const board = (id: string, x: number, w: number): VectorGroupNode => ({ id, type: 'group', name: id, frame: { x: 0, y: 0, width: w, height: 80, fill: '#eeeeee' }, transform: [1, 0, 0, 1, x, 0], children: [rect(`${id}-r`, 10, 10, 20)] });
		const r = vectorDocumentToPdf(doc(board('one', 0, 120), board('two', 300, 90)), { pages: 'artboards' });
		const { pages } = parse(r.bytes);
		expect(pages.map((p) => p.box)).toEqual(['0 0 120 80', '0 0 90 80']);
		expect(vectorDocumentToPdf(doc(rect('a', 0, 0, 5)), { pages: 'artboards' }).notes[0]).toContain('no artboards');
	});

	it('scales document units to points and can leave streams uncompressed', () => {
		const r = vectorDocumentToPdf(doc(rect('a', 0, 0, 10)), { scale: 2, compress: false });
		const { pages, text } = parse(r.bytes);
		expect(pages[0].box).toBe('0 0 400 200');
		expect(text).not.toContain('/FlateDecode');
		expect(pages[0].content.startsWith('2 0 0 -2 0 200 cm')).toBe(true);
	});
});

describe('exportPdf through the tool registry', () => {
	it('returns the PDF as a data URL with its page count and notes', async () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 10)) });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const r = await tools.callTool('run_command', { id: 'vector.exportPdf', params: { title: 'Card' } });
		const out = (r.structuredContent as any).result;
		expect(out.pages).toBe(1);
		expect(out.pdf.startsWith('data:application/pdf;base64,')).toBe(true);
		const bytes = base64ToBytes(out.pdf.slice(out.pdf.indexOf(',') + 1));
		expect(bytes.length).toBe(out.bytes);
		parse(bytes);
		const bad = await tools.callTool('run_command', { id: 'vector.exportPdf', params: { pages: 'spreads' } });
		expect(bad.isError).toBe(true);
	});
});
