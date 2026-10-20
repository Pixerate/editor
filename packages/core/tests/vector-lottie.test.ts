// Lottie export and import for vector documents. Shape item mapping after ArtCraft effectcraft
// `crates/lottie/src/shapes.rs` and `anim.rs` (MIT OR Apache-2.0, © ArtCraft Team and
// contributors); test cases re-expressed. See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import {
	VectorEditorController,
	createVectorCommands,
	createVectorFilter,
	createVectorEffect,
	ellipseSubpath,
	lottieValueAt,
	parseVectorLottie,
	rectSubpath,
	vectorDocumentToLottie,
	vectorNodeBounds,
	type VectorDocument,
	type VectorGroupNode,
	type VectorNode,
	type VectorPathNode
} from '../src/vector';

type Json = Record<string, any>;
const rect = (id: string, x: number, y: number, w: number, h = w, extra: Partial<VectorPathNode> = {}): VectorPathNode => ({ id, type: 'path', subpaths: [rectSubpath({ x, y, width: w, height: h })], fill: '#ff0000', stroke: null, ...extra });
const doc = (...nodes: VectorNode[]): VectorDocument => ({ width: 200, height: 100, nodes });
const st = (k: unknown) => ({ a: 0, k });
const box = (n: VectorNode) => {
	const b = vectorNodeBounds(n)!;
	return [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 100) / 100);
};
/** Every item of a type in a Lottie item tree. */
const find = (items: Json[], ty: string): Json[] => items.flatMap((it) => [...(it.ty === ty ? [it] : []), ...(it.ty === 'gr' ? find(it.it, ty) : [])]);

describe('Lottie export', () => {
	it('writes one shape layer, groups top first, paths with fills, strokes and transforms', () => {
		const d = doc(rect('a', 0, 0, 10, 10, { name: 'Bottom' }), rect('b', 20, 0, 10, 10, { name: 'Top', fill: '#00ff00', stroke: '#0000ff', strokeWidth: 3, strokeDasharray: [4, 2], transform: [0, 1, -1, 0, 50, 50] }));
		const { lottie, notes } = vectorDocumentToLottie(d, { fps: 24 });
		expect(notes).toEqual([]);
		expect([lottie.w, lottie.h, lottie.fr, lottie.ip, lottie.op]).toEqual([200, 100, 24, 0, 1]);
		const groups = (lottie.layers[0] as Json).shapes as Json[];
		expect(groups.map((g) => g.nm)).toEqual(['Top', 'Bottom']);
		const top = groups[0].it as Json[];
		expect(top.map((i) => i.ty)).toEqual(['sh', 'st', 'fl', 'tr']);
		expect(top[1]).toMatchObject({ c: st([0, 0, 1, 1]), w: st(3), d: [{ n: 'd', v: st(4) }, { n: 'g', v: st(2) }] });
		expect(top[2].c).toEqual(st([0, 1, 0, 1]));
		expect(top[3]).toMatchObject({ p: st([50, 50]), r: st(90) });
		expect(top[0].ks.k).toMatchObject({ c: true, v: [[20, 0], [30, 0], [30, 10], [20, 10]] });
	});

	it('keeps path effects live as Lottie modifiers, the repeater after the paint', () => {
		const n = rect('a', 0, 0, 20, 20, {
			effects: [createVectorEffect('trim', 't', { start: 10, end: 60 })!, createVectorEffect('twist', 'w', { angle: 30, center: { x: 5, y: 0 } })!, createVectorEffect('repeater', 'r', { copies: 4, position: { x: 30, y: 0 } })!]
		});
		const items = ((vectorDocumentToLottie(doc(n)).lottie.layers[0] as Json).shapes[0] as Json).it as Json[];
		expect(items.map((i) => i.ty)).toEqual(['sh', 'tm', 'tw', 'fl', 'rp', 'tr']);
		expect(items[1]).toMatchObject({ s: st(10), e: st(60), m: 1 });
		// Twist's centre is absolute in Lottie: the box centre plus our offset.
		expect(items[2].c).toEqual(st([15, 10]));
		expect(items[4]).toMatchObject({ c: st(4), tr: { p: st([30, 0]), a: st([10, 10]) } });
	});

	it('exports gradients as gradient fills with their points and stops', () => {
		const n = rect('a', 0, 0, 100, 50, { fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff', opacity: 0.5 }] } });
		const [gf] = find(((vectorDocumentToLottie(doc(n)).lottie.layers[0] as Json).shapes as Json[]), 'gf');
		expect(gf.t).toBe(1);
		expect(gf.g.p).toBe(2);
		// Colour stops, then alpha stops.
		expect(gf.g.k.k).toEqual([0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0.5]);
		expect(gf.s.k[0]).toBeCloseTo(0);
		expect(gf.e.k[0]).toBeCloseTo(100);
	});

	it('notes what it cannot carry and draws masks clipped', () => {
		const masked: VectorGroupNode = { id: 'm', type: 'group', name: 'Clip', mask: { type: 'clip' }, children: [rect('mask', 0, 0, 10, 10), rect('art', 5, 5, 20, 20)] };
		const shadowed = rect('s', 50, 0, 10, 10, { filters: [createVectorFilter('dropShadow', 'f')!] });
		const { lottie, notes } = vectorDocumentToLottie({ ...doc(masked, shadowed), background: '#ffffff' });
		expect(notes.some((n) => n.includes('filters'))).toBe(true);
		const clip = ((lottie.layers[0] as Json).shapes as Json[]).find((g) => g.nm === 'Clip')!;
		const [sh] = find(clip.it, 'sh');
		// The art clipped to the mask: 5…10 on both axes.
		const xs = sh.ks.k.v.map((p: number[]) => p[0]);
		expect([Math.min(...xs), Math.max(...xs)]).toEqual([5, 10]);
		expect(lottie.layers).toHaveLength(2);
		expect((lottie.layers[1] as Json).nm).toBe('Background');
		// Exporting some nodes leaves the page background out.
		expect(vectorDocumentToLottie({ ...doc(masked), background: '#ffffff' }, { nodes: [masked] }).lottie.layers).toHaveLength(1);
	});
});

describe('Lottie values', () => {
	it('reads static values, linear and eased keyframes, and holds', () => {
		expect(lottieValueAt(st([1, 2]), 5)).toEqual([1, 2]);
		const keys = { a: 1, k: [{ t: 0, s: [0] }, { t: 10, s: [100] }] };
		expect(lottieValueAt(keys, 5)).toEqual([50]);
		expect(lottieValueAt(keys, -3)).toEqual([0]);
		expect(lottieValueAt(keys, 30)).toEqual([100]);
		const eased = { a: 1, k: [{ t: 0, s: [0], o: { x: [0.42], y: [0] }, i: { x: [1], y: [1] } }, { t: 10, s: [100] }] };
		expect(lottieValueAt(eased, 5)[0]).toBeLessThan(50);
		expect(lottieValueAt({ a: 1, k: [{ t: 0, s: [0], h: 1 }, { t: 10, s: [100] }] }, 9)).toEqual([0]);
		// Old files: the end value on the key itself.
		expect(lottieValueAt({ a: 1, k: [{ t: 0, s: [0], e: [10] }, { t: 10 }] }, 5)).toEqual([5]);
	});
});

describe('Lottie import', () => {
	const layer = (shapes: Json[], extra: Json = {}): Json => ({ ty: 4, ind: 1, nm: 'Shapes', ip: 0, op: 60, st: 0, ks: { o: st(100), r: st(0), p: st([0, 0]), a: st([0, 0]), s: st([100, 100]) }, shapes, ...extra });
	const anim = (layers: Json[], extra: Json = {}): Json => ({ v: '5.7.4', fr: 30, ip: 0, op: 60, w: 300, h: 200, layers, ...extra });

	it('reads groups of shapes with their fills, strokes and transforms', () => {
		const lottie = anim([
			layer([
				{
					ty: 'gr',
					nm: 'Card',
					it: [
						{ ty: 'rc', s: st([40, 20]), p: st([0, 0]), r: st(0) },
						{ ty: 'st', c: st([0, 0, 1, 1]), o: st(100), w: st(2), lc: 2, lj: 2 },
						{ ty: 'fl', c: st([1, 0, 0, 1]), o: st(50), r: 1 },
						{ ty: 'tr', a: st([0, 0]), p: st([100, 50]), s: st([200, 100]), r: st(0), o: st(100) }
					]
				}
			])
		]);
		const { document, notes } = parseVectorLottie(lottie);
		expect(notes).toEqual([]);
		expect([document.width, document.height]).toEqual([300, 200]);
		const card = (document.nodes[0] as VectorGroupNode).children[0] as VectorGroupNode;
		expect(card.name).toBe('Card');
		const path = card.children[0] as VectorPathNode;
		expect(box(path)).toEqual([60, 40, 80, 20]);
		expect(path).toMatchObject({ stroke: '#0000ff', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', fill: '#ff0000' });
		expect(path.fills).toEqual([{ paint: '#ff0000', opacity: 0.5 }]);
	});

	it('shares paints between shapes above them as one compound path, even-odd when asked', () => {
		const lottie = anim([layer([{ ty: 'el', s: st([40, 40]), p: st([50, 50]) }, { ty: 'el', s: st([20, 20]), p: st([50, 50]) }, { ty: 'fl', c: st([0, 0, 0, 1]), o: st(100), r: 2 }])]);
		const path = (parseVectorLottie(lottie).document.nodes[0] as VectorGroupNode).children[0] as VectorPathNode;
		expect(path.subpaths).toHaveLength(2);
		expect(path.fillRule).toBe('evenodd');
	});

	it('turns shape modifiers into live effects', () => {
		const lottie = anim([
			layer([
				{ ty: 'sh', ks: st({ c: false, v: [[0, 0], [100, 0]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]] }) },
				{ ty: 'tm', s: st(0), e: st(50), o: st(0), m: 1 },
				{ ty: 'zz', s: st(4), r: st(6), pt: st(2) },
				{ ty: 'st', c: st([0, 0, 0, 1]), o: st(100), w: st(1) }
			])
		]);
		const path = (parseVectorLottie(lottie).document.nodes[0] as VectorGroupNode).children[0] as VectorPathNode;
		expect(path.effects!.map((e) => e.type)).toEqual(['trim', 'zigzag']);
		expect(path.effects![1].params).toMatchObject({ size: 4, ridges: 6, smooth: true });
	});

	it('reads a frame of keyframed transforms, parenting, solids, precomps and masks', () => {
		const moving = layer([{ ty: 'rc', s: st([10, 10]), p: st([0, 0]), r: st(0) }, { ty: 'fl', c: st([0, 0, 0, 1]), o: st(100) }], {
			ind: 2,
			parent: 1,
			ks: { o: st(100), r: st(0), a: st([0, 0]), s: st([100, 100]), p: { a: 1, k: [{ t: 0, s: [0, 0] }, { t: 10, s: [100, 0] }] } }
		});
		const parent = { ty: 3, ind: 1, nm: 'Null', ip: 0, op: 60, ks: { o: st(100), r: st(0), a: st([0, 0]), s: st([100, 100]), p: st([10, 20]) } };
		const solid = { ty: 1, ind: 3, nm: 'Bg', ip: 0, op: 60, sw: 300, sh: 200, sc: '#eeeeee', ks: { o: st(100), r: st(0), a: st([0, 0]), s: st([100, 100]), p: st([0, 0]) } };
		const pre = { ty: 0, ind: 4, refId: 'comp', ip: 0, op: 60, st: 0, ks: { o: st(50), r: st(0), a: st([0, 0]), s: st([100, 100]), p: st([200, 100]) }, masksProperties: [{ mode: 'a', pt: st({ c: true, v: [[0, 0], [5, 0], [5, 5], [0, 5]], i: [[0, 0], [0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0], [0, 0]] }) }] };
		const lottie = anim([moving, parent, pre, solid], { assets: [{ id: 'comp', layers: [layer([{ ty: 'rc', s: st([20, 20]), p: st([0, 0]), r: st(0) }, { ty: 'fl', c: st([0, 1, 0, 1]), o: st(100) }])] }] });
		const { document } = parseVectorLottie(lottie, { frame: 5 });
		// Bottom first: solid, precomp (masked), the moving square.
		expect(document.nodes.map((n) => n.name)).toEqual(['Bg', 'Layer mask', 'Shapes']);
		expect(box(document.nodes[2])).toEqual([55, 15, 10, 10]);
		const masked = document.nodes[1] as VectorGroupNode;
		expect(masked.mask).toEqual({ type: 'clip' });
		expect(masked.opacity).toBe(0.5);
	});

	it('notes what it leaves out and refuses what is not Lottie', () => {
		const { notes } = parseVectorLottie(anim([{ ty: 2, ind: 1, nm: 'Picture', ip: 0, op: 60, ks: {} }]));
		expect(notes[0]).toContain('not supported');
		expect(() => parseVectorLottie({ hello: 1 })).toThrow(/layers/);
	});
});

describe('round trip', () => {
	it('comes back with the same shapes, paints and live effects', () => {
		const art = doc(
			rect('a', 10, 10, 40, 20, { fill: '#123456', stroke: '#abcdef', strokeWidth: 2, effects: [createVectorEffect('roundCorners', 'rc', { radius: 4 })!] }),
			{ id: 'e', type: 'path', subpaths: [ellipseSubpath({ x: 100, y: 20, width: 40, height: 40 })], fill: '#00aa00', stroke: null, transform: [0, 1, -1, 0, 160, 0] }
		);
		const back = parseVectorLottie(vectorDocumentToLottie(art).lottie).document;
		const layer = back.nodes[0] as VectorGroupNode;
		const [a, e] = layer.children as VectorGroupNode[];
		const pa = a.children[0] as VectorPathNode;
		expect(box(pa)).toEqual(box(art.nodes[0]));
		expect(pa).toMatchObject({ fill: '#123456', stroke: '#abcdef', strokeWidth: 2 });
		expect(pa.effects).toEqual([{ id: 'fx1', type: 'roundCorners', params: { radius: 4 } }]);
		expect(box(e)).toEqual(box(art.nodes[1]));
	});
});

describe('Lottie in the editor and through the tool registry', () => {
	const setup = () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 10, 10, { name: 'A' })) });
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

	it('exports and imports through commands, one undo step', async () => {
		const { c, run } = setup();
		const out = await run('vector.exportLottie', { frames: 30 });
		expect(out.result.lottie.op).toBe(30);
		const back = await run('vector.importLottie', { lottie: JSON.stringify(out.result.lottie) });
		expect(back.result.ids).toHaveLength(1);
		expect(c.getState().document.nodes).toHaveLength(2);
		c.undo();
		expect(c.getState().document.nodes).toHaveLength(1);
		const replaced = await run('vector.importLottie', { lottie: { ...out.result.lottie, w: 640, h: 480 }, replace: true });
		expect(replaced.isError).toBe(false);
		expect([c.getState().document.width, c.getState().document.height]).toEqual([640, 480]);
	});

	it('fails usefully on bad input', async () => {
		const { run } = setup();
		expect((await run('vector.importLottie', { lottie: '{ nope' })).text).toContain('Not a Lottie animation');
		expect((await run('vector.importLottie', { lottie: { v: '5', layers: [] } })).text).toContain('nothing to draw');
		expect((await run('vector.exportLottie', { ids: ['zzz'] })).text).toContain('There is no node "zzz".');
	});
});
