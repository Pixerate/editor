// Frames (artboards) and resizing constraints. The constraint rules follow ArtCraft figcraft
// `crates/layout/src/lib.rs` `apply_constraints` (MIT OR Apache-2.0, © ArtCraft Team and
// contributors); test cases re-expressed. See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import {
	VectorEditorController,
	createVectorCommands,
	getVectorFramePanel,
	getVectorOverlayRenderData,
	getVectorSceneRenderData,
	hitTestVectorNodes,
	isVectorFrame,
	parseVectorSvg,
	rectSubpath,
	sanitizeVectorFrame,
	sanitizeVectorResizing,
	transformVectorNode,
	vectorDocumentToSvg,
	vectorFrameChildMatrix,
	vectorFrameDocument,
	vectorNodeBounds,
	findVectorNode,
	type VectorDocument,
	type VectorGroupNode,
	type VectorNode,
	type VectorPathNode,
	type VectorRenderGroup,
	type VectorResizing,
	type VectorTextNode
} from '../src/vector';

const rect = (id: string, x: number, y: number, w: number, h = w, extra: Partial<VectorPathNode> = {}): VectorPathNode => ({
	id,
	type: 'path',
	subpaths: [rectSubpath({ x, y, width: w, height: h })],
	fill: '#ff0000',
	stroke: null,
	...extra
});
const frame = (children: VectorNode[], extra: Partial<VectorGroupNode> = {}): VectorGroupNode => ({
	id: 'f',
	type: 'group',
	name: 'Board',
	frame: { x: 0, y: 0, width: 200, height: 100, fill: '#ffffff' },
	children,
	...extra
});
const doc = (...nodes: VectorNode[]): VectorDocument => ({ width: 800, height: 600, nodes });
const box = (n: VectorNode | null | undefined) => {
	const b = n ? vectorNodeBounds(n) : null;
	return b ? [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 1000) / 1000) : null;
};
/** A child 20 × 10 at (10, 10) in a 200 × 100 frame, with the given constraints. */
const pinned = (resizing?: VectorResizing) => rect('c', 10, 10, 20, 10, resizing ? { resizing } : {});

describe('frame constraint layout', () => {
	const from = { x: 0, y: 0, width: 200, height: 100 };
	const to = { x: 0, y: 0, width: 300, height: 200 };
	const child = { x: 10, y: 10, width: 20, height: 10 };
	const place = (resizing: VectorResizing) => {
		const m = vectorFrameChildMatrix(resizing, child, from, to);
		return [m[0] * child.x + m[4], m[3] * child.y + m[5], m[0] * child.width, m[3] * child.height];
	};

	it('keeps the start margin by default and the end margin when pinned right / bottom', () => {
		expect(place({})).toEqual([10, 10, 20, 10]);
		// The right margin was 170, the bottom 80.
		expect(place({ horizontal: 'right', vertical: 'bottom' })).toEqual([110, 110, 20, 10]);
	});

	it('stretches with both margins, centres and scales', () => {
		expect(place({ horizontal: 'leftRight', vertical: 'topBottom' })).toEqual([10, 10, 120, 110]);
		// The centre was 80 left of the frame's centre horizontally, 35 above it vertically.
		expect(place({ horizontal: 'center', vertical: 'center' })).toEqual([60, 60, 20, 10]);
		expect(place({ horizontal: 'scale', vertical: 'scale' })).toEqual([15, 20, 30, 20]);
	});

	it('keeps a stretched child a sliver when the frame shrinks past its margins', () => {
		const m = vectorFrameChildMatrix({ horizontal: 'leftRight' }, child, from, { x: 0, y: 0, width: 50, height: 100 });
		expect(m[0]).toBeGreaterThan(0);
	});
});

describe('frames', () => {
	it('recognises frames, but not blends, live booleans or mask groups carrying a frame', () => {
		expect(isVectorFrame(frame([]))).toBe(true);
		expect(isVectorFrame(frame([], { mask: { type: 'clip' } }))).toBe(false);
		expect(isVectorFrame(frame([], { liveBoolean: 'union' }))).toBe(false);
		expect(isVectorFrame(rect('a', 0, 0, 1))).toBe(false);
	});

	it('is bounded by its rectangle when it clips, and by its children too when it does not', () => {
		const spill = rect('c', 150, 50, 100, 100);
		expect(box(frame([spill]))).toEqual([0, 0, 200, 100]);
		expect(box(frame([spill], { frame: { x: 0, y: 0, width: 200, height: 100, clip: false } }))).toEqual([0, 0, 250, 150]);
		expect(box(frame([], { transform: [1, 0, 0, 1, 40, 30] }))).toEqual([40, 30, 200, 100]);
	});

	it('is hit anywhere in its rectangle, even unfilled, and not by children it clips away', () => {
		const spill = rect('c', 150, 50, 100, 100);
		const empty = frame([spill], { frame: { x: 0, y: 0, width: 200, height: 100 } });
		expect(hitTestVectorNodes([empty], { x: 5, y: 5 })?.id).toBe('f');
		expect(hitTestVectorNodes([empty], { x: 240, y: 140 })).toBeNull();
		const open = frame([spill], { frame: { x: 0, y: 0, width: 200, height: 100, clip: false } });
		expect(hitTestVectorNodes([open], { x: 240, y: 140 })?.id).toBe('f');
	});

	it('renders as a clip group: the rectangle as the clip, then the fill and the children', () => {
		const scene = getVectorSceneRenderData({ document: doc(frame([rect('c', 10, 10, 20)])), viewport: { x: 0, y: 0, zoom: 1 } });
		const g = scene.nodes[0] as VectorRenderGroup;
		expect(g.id).toBe('f');
		expect(g.mask?.type).toBe('clip');
		expect(g.mask?.clip?.[0].d).toMatch(/^M0 0/);
		expect(g.children.map((c) => c.id)).toEqual(['f~frame-fill', 'c']);
		// Without the clip: a plain group of the fill and children.
		const open = getVectorSceneRenderData({ document: doc(frame([rect('c', 10, 10, 20)], { frame: { x: 0, y: 0, width: 200, height: 100, clip: false } })), viewport: { x: 0, y: 0, zoom: 1 } });
		expect((open.nodes[0] as VectorRenderGroup).mask).toBeUndefined();
		expect((open.nodes[0] as VectorRenderGroup).children.map((c) => c.id)).toEqual(['c']);
	});

	it('lays its children out by their constraints when scaled, instead of scaling them', () => {
		const f = frame([pinned(), rect('r', 160, 70, 30, 20, { resizing: { horizontal: 'right', vertical: 'bottom' } }), rect('s', 0, 40, 200, 20, { resizing: { horizontal: 'leftRight' } })]);
		const big = transformVectorNode(f, [1.5, 0, 0, 2, 0, 0]) as VectorGroupNode;
		expect(big.frame).toMatchObject({ x: 0, y: 0, width: 300, height: 200, fill: '#ffffff' });
		expect(box(big.children[0])).toEqual([10, 10, 20, 10]);
		expect(box(big.children[1])).toEqual([260, 170, 30, 20]);
		expect(box(big.children[2])).toEqual([0, 40, 300, 20]);
	});

	it('moves every child with a translation, and scales them all under a mirror', () => {
		const f = frame([pinned({ horizontal: 'right' })]);
		const moved = transformVectorNode(f, [1, 0, 0, 1, 50, 25]) as VectorGroupNode;
		expect(moved.frame).toMatchObject({ x: 50, y: 25, width: 200, height: 100 });
		expect(box(moved.children[0])).toEqual([60, 35, 20, 10]);
		const flipped = transformVectorNode(f, [-1, 0, 0, 1, 200, 0]) as VectorGroupNode;
		expect(flipped.frame).toMatchObject({ x: 0, y: 0, width: 200, height: 100 });
		expect(box(flipped.children[0])).toEqual([170, 10, 20, 10]);
	});

	it('resizes area text without scaling its font, and moves point text', () => {
		const area: VectorTextNode = { id: 't', type: 'text', text: 'Hello', font: { fontFamily: 'sans-serif', fontSize: 12 }, frame: { kind: 'area', x: 10, y: 10, width: 180, height: 40 }, resizing: { horizontal: 'leftRight' } };
		const point: VectorTextNode = { id: 'p', type: 'text', text: 'Hi', font: { fontFamily: 'sans-serif', fontSize: 12 }, frame: { kind: 'point', x: 150, y: 50 }, resizing: { horizontal: 'right' } };
		const big = transformVectorNode(frame([area, point]), [2, 0, 0, 1, 0, 0]) as VectorGroupNode;
		const [a, p] = big.children as VectorTextNode[];
		expect(a.frame).toEqual({ kind: 'area', x: 10, y: 10, width: 380, height: 40 });
		expect(a.font.fontSize).toBe(12);
		expect(p.frame).toEqual({ kind: 'point', x: 350, y: 50 });
		expect(p.font.fontSize).toBe(12);
	});

	it('lays out nested frames in turn', () => {
		const inner = frame([pinned({ horizontal: 'right' })], { id: 'inner', frame: { x: 0, y: 0, width: 200, height: 100 }, resizing: { horizontal: 'leftRight' } });
		const outer = frame([inner], { id: 'outer', frame: { x: 0, y: 0, width: 200, height: 100 } });
		const big = transformVectorNode(outer, [2, 0, 0, 1, 0, 0]) as VectorGroupNode;
		const nested = big.children[0] as VectorGroupNode;
		expect(nested.frame).toMatchObject({ x: 0, width: 400 });
		expect(box(nested.children[0])).toEqual([210, 10, 20, 10]);
	});

	it('sanitizes frames and constraints from untrusted data', () => {
		expect(sanitizeVectorFrame({ x: 1, y: 2, width: 3, height: 4, clip: false, fill: '#000', extra: 1 })).toEqual({ x: 1, y: 2, width: 3, height: 4, clip: false, fill: '#000' });
		expect(sanitizeVectorFrame({ x: 1, y: 2, width: -3, height: 4 })).toBeNull();
		expect(sanitizeVectorFrame('nope')).toBeNull();
		expect(sanitizeVectorResizing({ horizontal: 'right', vertical: 'sideways' })).toEqual({ horizontal: 'right' });
		expect(sanitizeVectorResizing({ horizontal: 'up' })).toBeNull();
	});

	it('round-trips through SVG export and import, rotation and constraints included', () => {
		const rotated = frame([pinned({ horizontal: 'scale', vertical: 'bottom' })], { transform: [0, 1, -1, 0, 300, 50], frame: { x: 0, y: 0, width: 200, height: 100, fill: '#eeeeee', clip: true } });
		const svg = vectorDocumentToSvg(doc(rotated));
		expect(svg).toContain('data-vector-frame=');
		expect(svg).toContain('<clipPath id="vg-frame-f"><rect x="0" y="0" width="200" height="100"/></clipPath>');
		const back = parseVectorSvg(svg).nodes[0] as VectorGroupNode;
		expect(isVectorFrame(back)).toBe(true);
		expect(back.frame).toEqual({ x: 0, y: 0, width: 200, height: 100, fill: '#eeeeee' });
		expect(back.transform?.map((v) => Math.round(v))).toEqual([0, 1, -1, 0, 300, 50]);
		expect(back.children.map((c) => c.id)).toEqual(['c']);
		expect(back.children[0].resizing).toEqual({ horizontal: 'scale', vertical: 'bottom' });
		expect(box(back)).toEqual(box(rotated));
	});

	it('exports one frame as a document of its own size', () => {
		const d = doc(frame([pinned()], { transform: [1, 0, 0, 1, 100, 100] }), rect('outside', 0, 0, 10));
		const one = vectorFrameDocument(d, 'f', findVectorNode)!;
		expect([one.width, one.height]).toEqual([200, 100]);
		expect(one.nodes.map((n) => n.id)).toEqual(['f']);
		expect(box(one.nodes[0])).toEqual([0, 0, 200, 100]);
		expect(vectorFrameDocument(d, 'outside', findVectorNode)).toBeNull();
	});
});

describe('frames in the editor', () => {
	it('adds a frame, adopting what it encloses, as one undo step', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 20, 20, 10), rect('b', 500, 500, 10)) });
		const r = c.addFrame({ x: 0, y: 0, width: 100, height: 100, adopt: true });
		expect(r.ok).toBe(true);
		const id = (r as { id: string }).id;
		const f = c.getNode(id) as VectorGroupNode;
		expect(f.name).toBe('Frame 1');
		expect(f.frame).toEqual({ x: 0, y: 0, width: 100, height: 100, fill: '#ffffff' });
		expect(f.children.map((n) => n.id)).toEqual(['a']);
		expect(c.getState().selection).toEqual([id]);
		c.undo();
		expect(c.getState().document.nodes.map((n) => n.id)).toEqual(['a', 'b']);
		expect(c.addFrame({ x: 0, y: 0, width: 0, height: 10 })).toEqual({ ok: false, message: 'A frame needs a positive width and height.' });
	});

	it('frames the selection in its place, with padding', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 20, 20, 10), rect('b', 40, 40, 10), rect('top', 0, 0, 5)) });
		const r = c.frameSelection({ ids: ['a', 'b'], padding: 5 }) as { ok: true; id: string };
		expect(c.getState().document.nodes.map((n) => n.id)).toEqual([r.id, 'top']);
		expect((c.getNode(r.id) as VectorGroupNode).frame).toEqual({ x: 15, y: 15, width: 40, height: 40 });
		expect(c.frameSelection({ ids: [] })).toEqual({ ok: false, message: 'Select the objects to frame first.' });
	});

	it('resizes a frame by its options and its children follow their constraints', () => {
		const c = new VectorEditorController({ document: doc(frame([pinned({ horizontal: 'right', vertical: 'center' })])) });
		expect(c.setFrame({ width: 300, height: 200 }, { ids: ['f'] }).ok).toBe(true);
		// The centre stays 35 above the frame's centre.
		expect(box(c.getNode('c'))).toEqual([110, 60, 20, 10]);
		expect(c.setFrame({ fill: null, clip: false }, { ids: ['f'] }).ok).toBe(true);
		expect((c.getNode('f') as VectorGroupNode).frame).toEqual({ x: 0, y: 0, width: 300, height: 200, clip: false });
		c.undo();
		c.undo();
		expect((c.getNode('f') as VectorGroupNode).frame).toEqual({ x: 0, y: 0, width: 200, height: 100, fill: '#ffffff' });
		expect(c.setFrame({ width: 10 }, { ids: ['c'] })).toEqual({ ok: false, message: '"c" is not a frame (use frameSelection or addFrame to make one).' });
	});

	it('resizes a rotated frame in its own space', () => {
		const c = new VectorEditorController({ document: doc(frame([pinned({ horizontal: 'right' })], { transform: [0, 1, -1, 0, 300, 50] })) });
		c.setFrame({ width: 300 }, { ids: ['f'] });
		const f = c.getNode('f') as VectorGroupNode;
		expect(f.frame).toMatchObject({ x: 0, y: 0, width: 300, height: 100 });
		expect(f.transform).toEqual([0, 1, -1, 0, 300, 50]);
		expect(box({ ...f.children[0], transform: undefined })).toEqual([110, 10, 20, 10]);
	});

	it('scales a frame from the selection like a resize', () => {
		const c = new VectorEditorController({ document: doc(frame([pinned({ horizontal: 'right' })])) });
		c.select(['f']);
		c.scale(2, 1, { origin: { x: 0, y: 0 } });
		expect((c.getNode('f') as VectorGroupNode).frame).toMatchObject({ width: 400, height: 100 });
		expect(box(c.getNode('c'))).toEqual([210, 10, 20, 10]);
	});

	it('sets resizing constraints only on a frame\'s children', () => {
		const c = new VectorEditorController({ document: doc(frame([pinned()]), rect('loose', 300, 300, 10)) });
		expect(c.setResizing({ horizontal: 'scale' }, { ids: ['c'] }).ok).toBe(true);
		expect(c.setResizing({ vertical: 'bottom' }, { ids: ['c'] }).ok).toBe(true);
		expect(c.getNode('c')!.resizing).toEqual({ horizontal: 'scale', vertical: 'bottom' });
		expect(c.setResizing({ horizontal: 'left' }, { ids: ['loose'] })).toEqual({ ok: false, message: '"loose" is not directly inside a frame: resizing constraints only apply to a frame\'s children.' });
		expect(c.setResizing({ horizontal: 'up' as never }, { ids: ['c'] }).ok).toBe(false);
	});

	it('draws a frame with the Frame tool around what it encloses', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 20, 20, 10)) });
		c.setTool('frame');
		c.pointerDown({ x: 0, y: 0 });
		c.pointerMove({ x: 100, y: 80 });
		c.pointerUp({ x: 100, y: 80 });
		const [f] = c.getState().document.nodes as VectorGroupNode[];
		expect(isVectorFrame(f)).toBe(true);
		expect(f.frame).toMatchObject({ x: 0, y: 0, width: 100, height: 80, fill: '#ffffff' });
		expect(f.children.map((n) => n.id)).toEqual(['a']);
		expect(c.getState().selection).toEqual([f.id]);
		c.undo();
		expect(c.getState().document.nodes.map((n) => n.id)).toEqual(['a']);
	});

	it('labels artboards in the overlay and describes the selection in the panel', () => {
		const c = new VectorEditorController({ document: doc(frame([pinned({ horizontal: 'right' }), rect('d', 50, 50, 10)], { transform: [1, 0, 0, 1, 40, 30] })) });
		c.select(['f']);
		const overlay = getVectorOverlayRenderData(c.getState());
		expect(overlay.frames).toEqual([{ id: 'f', name: 'Board', x: 40, y: 30, selected: true }]);
		expect(getVectorFramePanel(c.getState()).frame).toEqual({ id: 'f', name: 'Board', artboard: true, frame: { x: 0, y: 0, width: 200, height: 100, fill: '#ffffff' } });
		c.select(['c', 'd']);
		expect(getVectorFramePanel(c.getState())).toEqual({ frame: null, resizing: { ids: ['c', 'd'], horizontal: 'mixed', vertical: 'top' } });
	});

	it('exports a frame as SVG of its own size', () => {
		const c = new VectorEditorController({ document: doc(frame([pinned()], { transform: [1, 0, 0, 1, 100, 100] })) });
		const svg = c.frameToSvg('f')!;
		expect(svg).toMatch(/width="200" height="100"/);
		expect(c.frameToSvg('nope')).toBeNull();
	});
});

describe('frame commands through the tool registry', () => {
	const setup = (d = doc(rect('a', 20, 20, 10), rect('b', 40, 40, 10))) => {
		const c = new VectorEditorController({ document: d });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const run = async (id: string, params?: unknown) => {
			const r = await tools.callTool('run_command', { id, ...(params !== undefined ? { params } : {}) });
			return { isError: !!r.isError, text: r.content?.map((x: any) => x.text).join('') ?? '', ...(r.structuredContent as any) };
		};
		return { c, run };
	};

	it('adds, frames, lists, changes and exports frames, returning what changed', async () => {
		const { c, run } = setup();
		const added = await run('vector.addFrame', { x: 0, y: 0, width: 100, height: 100, name: 'Card', adopt: true });
		expect(added.isError).toBe(false);
		expect(added.result).toMatchObject({ name: 'Card', artboard: true, parentId: null, frame: { x: 0, y: 0, width: 100, height: 100, fill: '#ffffff' } });
		expect(added.result.children.map((x: any) => x.id)).toEqual(['a', 'b']);
		const id = added.result.id;
		const pinnedResult = await run('vector.setResizing', { ids: ['b'], horizontal: 'right', vertical: 'bottom' });
		expect(pinnedResult.result).toEqual({ nodes: [{ id: 'b', horizontal: 'right', vertical: 'bottom' }] });
		const resized = await run('vector.setFrame', { ids: [id], width: 200, height: 150 });
		expect(resized.result.frames[0].frame).toMatchObject({ width: 200, height: 150 });
		expect(box(c.getNode('b'))).toEqual([140, 90, 10, 10]);
		expect(box(c.getNode('a'))).toEqual([20, 20, 10, 10]);
		const listed = await run('vector.listFrames');
		expect(listed.result.frames).toHaveLength(1);
		expect((await run('vector.list')).result.nodes.find((n: any) => n.id === id).frameRect).toMatchObject({ width: 200 });
		const exported = await run('vector.exportFrameSvg', { id });
		expect(exported.result).toMatchObject({ width: 200, height: 150 });
		expect(exported.result.svg).toContain('data-vector-frame');
		c.undo();
		expect((c.getNode(id) as VectorGroupNode).frame).toMatchObject({ width: 100, height: 100 });
	});

	it('frames the selection with padding', async () => {
		const { run } = setup();
		const r = await run('vector.frameSelection', { ids: ['a', 'b'], padding: 10 });
		expect(r.result.frame).toEqual({ x: 10, y: 10, width: 50, height: 50 });
	});

	it('fails usefully on bad input', async () => {
		const { run } = setup(doc(frame([pinned()]), rect('loose', 300, 300, 10)));
		expect((await run('vector.setFrame', { ids: ['f'] })).text).toContain('Pass at least one of x, y, width, height, fill, clip.');
		expect((await run('vector.setFrame', { ids: ['loose'], width: 5 })).text).toContain('"loose" is not a frame');
		expect((await run('vector.setResizing', { ids: ['loose'], horizontal: 'right' })).text).toContain('not directly inside a frame');
		expect((await run('vector.setResizing', { ids: ['c'], horizontal: 'up' })).isError).toBe(true);
		expect((await run('vector.exportFrameSvg', { id: 'loose' })).text).toContain('"loose" is not a frame.');
		expect((await run('vector.addFrame', { x: 0, y: 0, width: 10 })).isError).toBe(true);
	});
});
