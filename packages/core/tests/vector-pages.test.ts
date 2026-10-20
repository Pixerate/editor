// Multipage documents with master pages, built on frames (CorelDRAW's pages and master page,
// concept only). Test cases our own.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import {
	VectorEditorController,
	createVectorCommands,
	getVectorSceneRenderData,
	parseVectorSvg,
	rectSubpath,
	resolveVectorMasterPages,
	stripVectorMasterArt,
	vectorDocumentToPdf,
	vectorDocumentToSvg,
	vectorFrameDrawn,
	vectorPages,
	type VectorDocument,
	type VectorFrameGroup,
	type VectorGroupNode,
	type VectorNode,
	type VectorPathNode,
	type VectorTextNode
} from '../src/vector';

const page = (id: string, x: number, extra: Partial<VectorFrameGroup['frame']> = {}, children: VectorNode[] = [], h = 100): VectorFrameGroup => ({ id, type: 'group', name: id, frame: { x, y: 0, width: 80, height: h, fill: '#ffffff', ...extra }, children });
const footer: VectorPathNode = { id: 'bar', type: 'path', subpaths: [rectSubpath({ x: 0, y: 90, width: 80, height: 10 })], fill: '#0000ff', stroke: null, resizing: { vertical: 'bottom' } };
const label: VectorTextNode = { id: 'num', type: 'text', text: 'Page {page} of {pages}', font: { fontFamily: 'sans-serif', fontWeight: 400, fontSize: 6 }, frame: { kind: 'point', x: 4, y: 96 }, fill: '#000000' };
const master = (children: VectorNode[] = [footer, label]) => page('M', 0, { master: true }, children);
const doc = (...nodes: VectorNode[]): VectorDocument => ({ width: 400, height: 300, nodes });
const artOf = (d: VectorDocument, id: string) => (resolveVectorMasterPages(d).nodes.find((n) => n.id === id) as VectorGroupNode).masterArt ?? [];

describe('pages and master pages', () => {
	it('numbers pages in order, leaving master pages out', () => {
		expect(vectorPages(doc(page('a', 100), master(), page('b', 200))).map((p) => p.id)).toEqual(['a', 'b']);
	});

	it('draws the master art on its pages with page numbers, laid out by resizing', () => {
		const d = doc(master(), page('p1', 100, { masterId: 'M' }), page('p2', 200, { masterId: 'M' }, [], 150), page('p3', 300));
		const one = artOf(d, 'p1');
		expect(one.map((n) => n.id)).toEqual(['p1~master~bar', 'p1~master~num']);
		expect((one[1] as VectorTextNode).text).toBe('Page 1 of 3');
		expect(one.every((n) => n.locked)).toBe(true);
		// The footer is moved onto page 1, and pinned to the bottom of the taller page 2.
		expect((one[0] as VectorPathNode).subpaths[0].anchors[0]).toMatchObject({ x: 100, y: 90 });
		const two = artOf(d, 'p2');
		expect((two[0] as VectorPathNode).subpaths[0].anchors.map((a) => a.y).sort((a, b) => a - b)[0]).toBeCloseTo(140);
		expect((two[1] as VectorTextNode).text).toBe('Page 2 of 3');
		expect(artOf(d, 'p3')).toEqual([]);
		// The page draws it between its fill and its own art.
		const p1 = resolveVectorMasterPages(d).nodes[1] as VectorFrameGroup;
		expect(vectorFrameDrawn(p1).children.map((c) => c.id)).toEqual(['p1~frame-clip', 'p1~frame-fill', 'p1~master~bar', 'p1~master~num']);
	});

	it('keeps node objects when nothing changed, and strips the art for saving', () => {
		const d = resolveVectorMasterPages(doc(master(), page('p1', 100, { masterId: 'M' })));
		expect(resolveVectorMasterPages(d)).toBe(d);
		expect(stripVectorMasterArt(d).nodes[1]).not.toHaveProperty('masterArt');
	});

	it('exports pages with their master art: SVG round-trips without it, PDF pages skip masters', () => {
		const d = doc(master(), page('p1', 100, { masterId: 'M' }), page('p2', 200, { masterId: 'M' }));
		const svg = vectorDocumentToSvg(d);
		expect(svg).toContain('data-vector-part="frame-master"');
		const back = parseVectorSvg(svg);
		const p1 = back.nodes.find((n) => n.id === 'p1') as VectorFrameGroup;
		expect(p1.frame.masterId).toBe('M');
		expect(p1.children).toEqual([]);
		expect((back.nodes.find((n) => n.id === 'M') as VectorFrameGroup).frame.master).toBe(true);
		expect(vectorDocumentToPdf(d, { pages: 'artboards' }).pages).toBe(2);
		const scene = getVectorSceneRenderData({ document: d, viewport: { x: 0, y: 0, zoom: 1 } });
		expect(JSON.stringify(scene.nodes[1])).toContain('p1~master~bar');
	});
});

describe('pages in the editor', () => {
	it('adds pages and a master, applies it, reorders and goes to pages, each one undo step', () => {
		const c = new VectorEditorController({ document: doc({ id: 'art', type: 'path', subpaths: [rectSubpath({ x: 10, y: 10, width: 20, height: 20 })], fill: '#f00', stroke: null }) });
		const first = c.addPage();
		expect(first.ok).toBe(true);
		const p1 = (first as { id: string }).id;
		// The first page covers the artboard and takes its art in.
		expect((c.getNode(p1) as VectorFrameGroup).children.map((n) => n.id)).toEqual(['art']);
		const p2 = (c.addPage() as { id: string }).id;
		expect((c.getNode(p2) as VectorFrameGroup).frame.x).toBeGreaterThan(400);
		const m = (c.addMasterPage({ assignTo: 'all' }) as { id: string }).id;
		expect(c.getPages().pages.map((p) => p.masterId)).toEqual([m, m]);
		// A third page takes the last page's master.
		const p3 = (c.addPage({ after: p1 }) as { id: string }).id;
		expect(c.getPages().pages.map((p) => p.id)).toEqual([p1, p3, p2]);
		expect(c.getPages().pages[1].masterId).toBe(m);
		c.addShape({ kind: 'rect', x: 0, y: 0, width: 10, height: 10 }, { parentId: m });
		expect(((c.getNode(p2) as VectorGroupNode).masterArt ?? []).length).toBe(1);
		expect(c.movePage(p2, 0)).toMatchObject({ ok: true, order: [p2, p1, p3] });
		c.undo();
		expect(c.getPages().pages.map((p) => p.id)).toEqual([p1, p3, p2]);
		expect(c.setPageMaster(null, { ids: [p3] }).ok).toBe(true);
		expect(c.getPages().pages[1].masterId).toBeNull();
		expect(c.setPageMaster(m, { ids: [m] })).toMatchObject({ ok: false, message: expect.stringContaining('master page') });
		expect(c.goToPage(p2).ok).toBe(true);
		expect(c.getState().selection).toEqual([p2]);
		expect(c.toJSON().nodes.some((n) => n.type === 'group' && n.masterArt)).toBe(false);
	});
});

describe('page commands through the tool registry', () => {
	it('lists, adds, applies, moves and goes to pages, and refuses bad ids', async () => {
		const c = new VectorEditorController({ document: doc() });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const run = async (id: string, params?: unknown) => {
			const r = await tools.callTool('run_command', { id, ...(params !== undefined ? { params } : {}) });
			return { isError: !!r.isError, text: r.content?.map((x: any) => x.text).join('') ?? '', ...(r.structuredContent as any) };
		};
		expect((await run('vector.listPages')).result).toEqual({ pages: [], masters: [] });
		const a = (await run('vector.addPage', { name: 'Cover' })).result.id;
		const b = (await run('vector.addPage')).result.id;
		const m = await run('vector.addMasterPage', { assignTo: [b] });
		expect(m.result.masters[0].usedBy).toEqual([b]);
		expect((await run('vector.setPageMaster', { ids: [a], masterId: m.result.id })).result.pages[0].masterId).toBe(m.result.id);
		expect((await run('vector.movePage', { id: b, index: 0 })).result.pages.map((p: any) => p.id)).toEqual([b, a]);
		expect((await run('vector.goToPage', { id: a, canvasWidth: 800, canvasHeight: 600 })).result).toEqual({ id: a });
		// Page numbers on the master show on each page (placed inside the master's bounds).
		const mb = m.result.masters[0].bounds;
		await run('vector.addText', { text: '{page}/{pages}', x: mb.x + 4, y: mb.y + 20, parentId: m.result.id });
		const art = (c.getNode(a) as VectorGroupNode).masterArt!;
		expect((art[0] as VectorTextNode).text).toBe('2/2');
		expect((await run('vector.addText', { text: 'x', parentId: 'nope' })).isError).toBe(true);
		expect((await run('vector.addPage', { masterId: 'nope' })).text).toContain('not a master page');
		expect((await run('vector.movePage', { id: a, index: 5 })).text).toContain('index must be');
		expect((await run('vector.goToPage', { id: 'nope' })).isError).toBe(true);
	});
});
