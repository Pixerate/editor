// Masks and clipping. The mask model follows ArtCraft figcraft `crates/doc/src/node.rs` and
// `geometry.rs`, the inverted clip pdfcraft `crates/redact/src/interp.rs` (`clip_out`), clipping
// by layer designcraft `crates/render/src/fx.rs` (MIT OR Apache-2.0, © ArtCraft Team and
// contributors); test cases re-expressed. See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import {
	VectorEditorController,
	VectorSnapTargets,
	createVectorCommands,
	createVectorEffect,
	ellipseSubpath,
	getVectorOverlayRenderData,
	getVectorSceneRenderData,
	hitTestVectorNode,
	hitTestVectorNodes,
	isVectorMaskActive,
	isVectorMaskGroup,
	lineSubpath,
	parseVectorSvg,
	rectSubpath,
	sanitizeVectorMask,
	vectorAppearanceOutline,
	vectorDocumentToSvg,
	vectorMaskContains,
	vectorMaskOwner,
	vectorMaskSummary,
	vectorNodeBounds,
	type VectorDocument,
	type VectorGroupNode,
	type VectorNode,
	type VectorPathNode,
	type VectorRenderGroup
} from '../src/vector';

const rect = (id: string, x: number, y: number, w: number, h = w, extra: Partial<VectorPathNode> = {}): VectorPathNode => ({
	id,
	type: 'path',
	subpaths: [rectSubpath({ x, y, width: w, height: h })],
	fill: '#ff0000',
	stroke: null,
	...extra
});
const circle = (id: string, cx: number, cy: number, r: number, extra: Partial<VectorPathNode> = {}): VectorPathNode => ({
	id,
	type: 'path',
	subpaths: [ellipseSubpath({ x: cx - r, y: cy - r, width: 2 * r, height: 2 * r })],
	fill: '#ffffff',
	stroke: null,
	...extra
});
const masked = (type: 'clip' | 'alpha' | 'luminance', children: VectorNode[], extra: Partial<VectorGroupNode> = {}): VectorGroupNode => ({
	id: 'g',
	type: 'group',
	mask: { type },
	children,
	...extra
});
const doc = (...nodes: VectorNode[]): VectorDocument => ({ width: 400, height: 300, nodes });
const near = (b: { x: number; y: number; width: number; height: number } | null, x: number, y: number, w: number, h: number) => {
	expect(b).not.toBeNull();
	expect(b!.x).toBeCloseTo(x, 1);
	expect(b!.y).toBeCloseTo(y, 1);
	expect(b!.width).toBeCloseTo(w, 1);
	expect(b!.height).toBeCloseTo(h, 1);
};

describe('mask model', () => {
	it('reads mask settings from untrusted data', () => {
		expect(sanitizeVectorMask({ type: 'clip' })).toEqual({ type: 'clip' });
		expect(sanitizeVectorMask({ type: 'alpha', invert: true, extra: 1 })).toEqual({ type: 'alpha', invert: true });
		expect(sanitizeVectorMask({ type: 'vector' })).toBeNull();
		expect(sanitizeVectorMask('clip')).toBeNull();
	});

	it('takes the first child as the mask, and is off while it is hidden or on a blend / live boolean', () => {
		const g = masked('clip', [circle('m', 50, 50, 20), rect('a', 0, 0, 100)]);
		expect(isVectorMaskGroup(g)).toBe(true);
		expect(vectorMaskSummary(g)).toEqual({ type: 'clip', invert: false, maskId: 'm', contents: ['a'], enabled: true });
		expect(isVectorMaskActive({ ...g, children: [{ ...g.children[0], visible: false }, g.children[1]] })).toBe(false);
		expect(isVectorMaskGroup({ ...g, liveBoolean: 'union' })).toBe(false);
		expect(isVectorMaskGroup({ ...g, children: [] })).toBe(false);
		expect(vectorMaskOwner([{ id: 'outer', type: 'group', children: [g] }], 'm')?.id).toBe('g');
	});
});

describe('clipping: hit-testing and bounds', () => {
	const g = masked('clip', [circle('m', 50, 50, 20), rect('a', 0, 0, 100)]);

	it('hits the contents only inside the clip', () => {
		expect(hitTestVectorNode(g, { x: 50, y: 50 })).toBe(true);
		expect(hitTestVectorNode(g, { x: 5, y: 5 })).toBe(false);
		// The clip's own paint is not drawn: outside the contents, inside the clip, nothing is hit.
		const small = masked('clip', [circle('m', 50, 50, 40), rect('a', 40, 40, 20)]);
		expect(hitTestVectorNode(small, { x: 20, y: 50 })).toBe(false);
	});

	it('hits the other way round when inverted, and whole while the mask is hidden', () => {
		const inv = { ...g, mask: { type: 'clip' as const, invert: true } };
		expect(hitTestVectorNode(inv, { x: 50, y: 50 })).toBe(false);
		expect(hitTestVectorNode(inv, { x: 5, y: 5 })).toBe(true);
		const off = { ...g, children: [{ ...g.children[0], visible: false }, g.children[1]] };
		expect(hitTestVectorNode(off, { x: 5, y: 5 })).toBe(true);
	});

	it('hits through a rotated group in its own space', () => {
		const turned: VectorGroupNode = { ...g, transform: [0, 1, -1, 0, 300, 0] };
		// (50, 50) maps to (250, 50).
		expect(hitTestVectorNode(turned, { x: 250, y: 50 })).toBe(true);
		expect(hitTestVectorNode(turned, { x: 295, y: 5 })).toBe(false);
	});

	it('bounds the masked result, inverted or not', () => {
		near(vectorNodeBounds(g), 30, 30, 40, 40);
		const wide = masked('clip', [rect('m', 50, -20, 200, 40), rect('a', 0, 0, 100)]);
		near(vectorNodeBounds(wide), 50, 0, 50, 20);
		const inv = masked('clip', [rect('m', 50, -20, 200, 40), rect('a', 0, 0, 100)], { mask: { type: 'clip', invert: true } });
		near(vectorNodeBounds(inv), 0, 0, 100, 100);
	});

	it('cuts open paths where they cross the clip', () => {
		const line: VectorPathNode = { id: 'l', type: 'path', subpaths: [lineSubpath({ x: 0, y: 50 }, { x: 100, y: 50 })], fill: null, stroke: '#000', strokeWidth: 2 };
		const g2 = masked('clip', [rect('m', 20, 0, 30, 100), line]);
		near(vectorNodeBounds(g2), 20, 50, 30, 0);
		expect(hitTestVectorNode(g2, { x: 30, y: 50 }, 1)).toBe(true);
		expect(hitTestVectorNode(g2, { x: 80, y: 50 }, 1)).toBe(false);
	});

	it('clips by every path of a group mask, each by its fill rule', () => {
		const ring: VectorPathNode = {
			id: 'ring',
			type: 'path',
			fillRule: 'evenodd',
			fill: null,
			stroke: null,
			subpaths: [ellipseSubpath({ x: 0, y: 0, width: 100, height: 100 }), ellipseSubpath({ x: 30, y: 30, width: 40, height: 40 })]
		};
		const g2 = masked('clip', [{ id: 'mg', type: 'group', children: [ring, rect('dot', 90, 90, 10)] }, rect('a', 0, 0, 100)]);
		expect(hitTestVectorNode(g2, { x: 50, y: 50 })).toBe(false);
		expect(hitTestVectorNode(g2, { x: 50, y: 10 })).toBe(true);
		expect(hitTestVectorNode(g2, { x: 95, y: 95 })).toBe(true);
	});

	it('gives the clipped outline to booleans and the overlay', () => {
		const outline = vectorAppearanceOutline(g);
		const c = new VectorEditorController({ document: doc(g, rect('b', 60, 0, 100)) });
		c.select(['g']);
		const overlay = getVectorOverlayRenderData(c.getState());
		expect(overlay.masks).toEqual([expect.objectContaining({ id: 'g', maskId: 'm', type: 'clip', invert: false, enabled: true, editing: false })]);
		expect(outline.length).toBeGreaterThan(0);
		const id = c.booleanOp('union', { ids: ['g', 'b'] });
		const result = c.getNode(id!)!;
		// The union of the 40 × 40 clipped circle and the square beside it, not of the whole 100 × 100 square.
		near(vectorNodeBounds(result), 30, 0, 130, 100);
	});
});

describe('opacity masks: hit-testing', () => {
	it('hits where the mask paints, its stroke included', () => {
		const ringMask = circle('m', 50, 50, 30, { fill: null, stroke: '#fff', strokeWidth: 10 });
		const g = masked('luminance', [ringMask, rect('a', 0, 0, 100)]);
		expect(hitTestVectorNode(g, { x: 80, y: 50 })).toBe(true);
		expect(hitTestVectorNode(g, { x: 50, y: 50 })).toBe(false);
		const inv = { ...g, mask: { type: 'luminance' as const, invert: true } };
		expect(hitTestVectorNode(inv, { x: 50, y: 50 })).toBe(true);
		expect(vectorMaskContains(inv, { x: 80, y: 50 })).toBe(false);
	});
});

describe('controller: make, release, options', () => {
	const setup = () => new VectorEditorController({ document: doc(rect('a', 0, 0, 100), rect('b', 200, 0, 50), circle('c', 50, 50, 20)) });

	it('makes a clipping mask from the topmost object as one undo step', () => {
		const c = setup();
		c.select(['a', 'c']);
		const r = c.makeMask('clip');
		expect(r.ok).toBe(true);
		const g = c.getNode((r as { id: string }).id) as VectorGroupNode;
		expect(g.mask).toEqual({ type: 'clip' });
		expect(g.children.map((n) => n.id)).toEqual(['c', 'a']);
		expect(c.getState().document.nodes.map((n) => n.id)).toEqual(['b', g.id]);
		expect(c.getState().selection).toEqual([g.id]);
		c.undo();
		expect(c.getState().document.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
	});

	it('takes maskId and invert, and makes opacity masks', () => {
		const c = setup();
		const r = c.makeMask('luminance', { ids: ['a', 'c'], maskId: 'a', invert: true });
		const g = c.getNode((r as { id: string }).id) as VectorGroupNode;
		expect(g.mask).toEqual({ type: 'luminance', invert: true });
		expect(g.children.map((n) => n.id)).toEqual(['a', 'c']);
	});

	it('refuses fewer than two objects, locked ones and mixed parents, changing nothing', () => {
		const c = setup();
		const before = c.getState().document;
		expect(c.makeMask('clip', { ids: ['a'] })).toMatchObject({ ok: false, message: expect.stringMatching(/at least two/) });
		c.setLocked('b', true);
		expect(c.makeMask('clip', { ids: ['a', 'b'] })).toMatchObject({ ok: false, message: expect.stringMatching(/"b" is locked/) });
		const nested = new VectorEditorController({ document: doc({ id: 'grp', type: 'group', children: [rect('x', 0, 0, 10)] }, rect('y', 0, 0, 10)) });
		expect(nested.makeMask('clip', { ids: ['x', 'y'] })).toMatchObject({ ok: false, message: expect.stringMatching(/share a parent/) });
		expect(c.makeMask('clip', { ids: ['a', 'c'], maskId: 'b' })).toMatchObject({ ok: false });
		expect(c.makeMask('oops' as any, { ids: ['a', 'c'] })).toMatchObject({ ok: false });
		expect(c.getState().document.nodes).toEqual(before.nodes.map((n) => (n.id === 'b' ? { ...n, locked: true } : n)));
	});

	it('releases: the mask goes back on top and the group goes, unless it has appearance of its own', () => {
		const c = setup();
		const { id } = c.makeMask('clip', { ids: ['a', 'c'] }) as { id: string };
		expect(c.releaseMask({ ids: [id] })).toEqual(['a', 'c']);
		expect(c.getState().document.nodes.map((n) => n.id)).toEqual(['b', 'a', 'c']);
		expect(c.getNode(id)).toBeUndefined();
		const again = c.makeMask('clip', { ids: ['a', 'c'] }) as { id: string };
		c.setBlendMode('multiply', { ids: [again.id] });
		c.releaseMask({ ids: [again.id] });
		const kept = c.getNode(again.id) as VectorGroupNode;
		expect(kept.mask).toBeUndefined();
		expect(kept.children.map((n) => n.id)).toEqual(['a', 'c']);
	});

	it('changes the type and inversion, and edits the mask or the contents', () => {
		const c = setup();
		const { id } = c.makeMask('clip', { ids: ['a', 'c'] }) as { id: string };
		expect(c.setMaskOptions({ type: 'alpha', invert: true }, { ids: [id] }).ok).toBe(true);
		expect((c.getNode(id) as VectorGroupNode).mask).toEqual({ type: 'alpha', invert: true });
		expect(c.setMaskOptions({ type: 'nope' as any }, { ids: [id] }).ok).toBe(false);
		expect(c.setMaskOptions({ invert: false }, { ids: ['b'] }).ok).toBe(false);
		expect(c.editMask({ id })).toBe('c');
		expect(c.getState().tool).toBe('direct');
		// With the mask selected, the group's other actions still find it.
		expect(c.editMaskContents()).toEqual(['a']);
	});

	it('deleting the mask releases the group instead of promoting the next child', () => {
		const c = setup();
		const { id } = c.makeMask('clip', { ids: ['a', 'c'] }) as { id: string };
		c.removeNodes(['c']);
		const g = c.getNode(id) as VectorGroupNode;
		expect(g.mask).toBeNull();
		expect(g.children.map((n) => n.id)).toEqual(['a']);
	});

	it('picks through the clip: a click where the contents are clipped away misses', () => {
		const c = new VectorEditorController({ document: doc(masked('clip', [circle('m', 50, 50, 20), rect('a', 0, 0, 100)])) });
		c.setViewport({ x: 0, y: 0, zoom: 1 });
		c.pointerDown({ x: 5, y: 5 });
		c.pointerUp({ x: 5, y: 5 });
		expect(c.getState().selection).toEqual([]);
		c.pointerDown({ x: 50, y: 50 });
		c.pointerUp({ x: 50, y: 50 });
		expect(c.getState().selection).toEqual(['g']);
		expect(hitTestVectorNodes(c.getState().document.nodes, { x: 5, y: 5 })).toBeNull();
	});

	it('snaps to the masked result, not the clipped-away contents', () => {
		const d = doc(masked('clip', [rect('m', 20, 20, 30), rect('a', 0, 0, 100)]), rect('moving', 300, 200, 10));
		const targets = VectorSnapTargets.forMove(d, ['moving']) as unknown as { xs: { v: number }[] };
		const xs = targets.xs.map((t) => t.v);
		expect(xs).toContain(20);
		expect(xs).toContain(50);
		expect(xs).not.toContain(100);
	});
});

describe('render data', () => {
	it('draws the contents under a clipPath and keeps the group appearance outside it', () => {
		const shadow = { id: 's', type: 'dropShadow' as const, params: { color: '#000', opacity: 0.5, offsetX: 2, offsetY: 2, blur: 4, spread: 0 } };
		const g = masked('clip', [circle('m', 50, 50, 20), rect('a', 0, 0, 100)], { filters: [shadow], blendMode: 'multiply', opacity: 0.8 });
		const scene = getVectorSceneRenderData({ document: doc(g), viewport: { x: 0, y: 0, zoom: 1 } });
		const node = scene.nodes[0] as VectorRenderGroup;
		expect(node.children.map((n) => n.id)).toEqual(['a']);
		expect(node.mask).toMatchObject({ type: 'clip', invert: false, id: 've-mask-g' });
		expect(node.mask!.clip).toHaveLength(1);
		expect(node.filter).toBe('url(#ve-filter-g)');
		expect(node.blendMode).toBe('multiply');
		expect(node.opacity).toBe(0.8);
	});

	it('cuts an inverted clip out of a rectangle, even-odd', () => {
		const g = masked('clip', [circle('m', 50, 50, 20), rect('a', 0, 0, 100)], { mask: { type: 'clip', invert: true } });
		const node = getVectorSceneRenderData({ document: doc(g), viewport: { x: 0, y: 0, zoom: 1 } }).nodes[0] as VectorRenderGroup;
		expect(node.mask!.clip).toEqual([{ d: expect.stringMatching(/^M/), clipRule: 'evenodd' }]);
		expect(node.mask!.clip![0].d.match(/M/g)!.length).toBe(2);
	});

	it('draws opacity masks as nodes, inverted ones through a filter', () => {
		const grad = { type: 'linear' as const, angle: 90, stops: [{ offset: 0, color: '#fff' }, { offset: 1, color: '#000' }] };
		const g = masked('luminance', [rect('m', 0, 0, 100, 100, { fill: grad }), rect('a', 0, 0, 100)], { mask: { type: 'luminance', invert: true } });
		const scene = getVectorSceneRenderData({ document: doc(g), viewport: { x: 0, y: 0, zoom: 1 } });
		const node = scene.nodes[0] as VectorRenderGroup;
		expect(node.mask!.nodes!.map((n) => n.id)).toEqual(['m']);
		expect(node.mask!.bounds).toBeTruthy();
		expect(node.mask!.filter).toBe('url(#ve-mask-filter-g)');
		expect(scene.filters.map((f) => f.id)).toContain('ve-mask-filter-g');
		expect(scene.defs.length).toBeGreaterThan(0);
		// A hidden mask: no mask data, contents whole, the mask not drawn.
		const off = { ...g, children: [{ ...g.children[0], visible: false }, g.children[1]] };
		const plain = getVectorSceneRenderData({ document: doc(off), viewport: { x: 0, y: 0, zoom: 1 } }).nodes[0] as VectorRenderGroup;
		expect(plain.mask).toBeUndefined();
		expect(plain.children.map((n) => n.id)).toEqual(['a']);
	});

	it('applies a mask group\'s path effects to the contents only', () => {
		const g = masked('clip', [rect('m', -20, -20, 90, 140), rect('a', 0, 0, 100)], { effects: [createVectorEffect('offset', 'fx', { amount: 10 })!] });
		const scene = getVectorSceneRenderData({ document: doc(g), viewport: { x: 0, y: 0, zoom: 1 } });
		const node = scene.nodes[0] as VectorRenderGroup;
		expect(node.mask).toBeTruthy();
		expect(node.children.map((n) => n.id)).toEqual(['g~content']);
		// The contents grew by 10 (-10…110), the clip did not (-20…70 across).
		near(vectorNodeBounds(g), -10, -10, 80, 120);
	});
});

describe('SVG export and import', () => {
	const roundTrip = (d: VectorDocument) => parseVectorSvg(vectorDocumentToSvg(d));

	it('writes a clipPath and reads the mask group back', () => {
		const shadow = { id: 's', type: 'dropShadow' as const, params: { color: '#000000', opacity: 0.5, offsetX: 2, offsetY: 2, blur: 4, spread: 0 } };
		const g = masked('clip', [circle('m', 50, 50, 20, { fill: '#00ff00' }), rect('a', 0, 0, 100)], { filters: [shadow], opacity: 0.5 });
		const svg = vectorDocumentToSvg(doc(g));
		expect(svg).toMatch(/<clipPath id="vg-mask-g"><path d="[^"]+" clip-rule="nonzero"\/><\/clipPath>/);
		expect(svg).toMatch(/<g id="g" opacity="0.5" filter="url\(#vg-filter-g\)" data-vector-mask="\{&quot;type&quot;:&quot;clip&quot;\}">/);
		expect(svg).toMatch(/<g data-vector-part="masked" clip-path="url\(#vg-mask-g\)">/);
		const back = parseVectorSvg(svg).nodes[0] as VectorGroupNode;
		expect(back).toMatchObject({ id: 'g', type: 'group', mask: { type: 'clip' }, opacity: 0.5, filters: [shadow] });
		expect(back.children.map((n) => n.id)).toEqual(['m', 'a']);
		expect((back.children[0] as VectorPathNode).fill).toBe('#00ff00');
		near(vectorNodeBounds(back), 30, 30, 40, 40);
	});

	it('round-trips inverted, opacity, hidden and effected masks', () => {
		const grad = { type: 'linear' as const, angle: 90, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] };
		const cases: VectorGroupNode[] = [
			masked('clip', [circle('m', 50, 50, 20), rect('a', 0, 0, 100)], { mask: { type: 'clip', invert: true } }),
			masked('luminance', [rect('m', 0, 0, 100, 100, { fill: grad }), rect('a', 0, 0, 100)]),
			masked('alpha', [circle('m', 50, 50, 30, { opacity: 0.5 }), rect('a', 0, 0, 100)], { mask: { type: 'alpha', invert: true } }),
			masked('clip', [circle('m', 50, 50, 20, { visible: false }), rect('a', 0, 0, 100)]),
			masked('clip', [rect('m', 0, 0, 50, 100), rect('a', 0, 0, 100)], { effects: [createVectorEffect('offset', 'fx', { amount: 10 })!] })
		];
		for (const g of cases) {
			const back = roundTrip(doc(g)).nodes[0] as VectorGroupNode;
			expect(back.mask).toEqual(g.mask);
			expect(back.children.map((n) => n.id)).toEqual(['m', 'a']);
			expect(back.children[0].visible ?? true).toBe(g.children[0].visible ?? true);
			expect(back.effects?.map((e) => e.type)).toEqual(g.effects?.map((e) => e.type));
			near(vectorNodeBounds(back), ...(Object.values(vectorNodeBounds(g)!) as [number, number, number, number]));
		}
	});

	it('writes opacity masks as <mask> elements, alpha with mask-type and inverted ones through a filter', () => {
		const svg = vectorDocumentToSvg(doc(masked('alpha', [circle('m', 50, 50, 30), rect('a', 0, 0, 100)], { mask: { type: 'alpha', invert: true } })));
		expect(svg).toMatch(/<mask id="vg-mask-g" data-vector-part="mask-source" maskUnits="userSpaceOnUse" x="[-\d.]+" y="[-\d.]+" width="[\d.]+" height="[\d.]+" mask-type="alpha"><g data-vector-part="mask-invert" filter="url\(#vg-mask-filter-g\)"><path id="m"/);
		expect(svg).toMatch(/<filter id="vg-mask-filter-g" filterUnits="userSpaceOnUse"[^>]*><feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1 1"\/><\/filter>/);
		expect(svg).toMatch(/<g data-vector-part="masked" mask="url\(#vg-mask-g\)">/);
	});

	it('reads foreign clip-path and mask references as mask groups', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
			<defs>
				<clipPath id="c"><circle cx="50" cy="50" r="20" fill="red" clip-rule="evenodd"/></clipPath>
				<clipPath id="bb" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="0.5" height="1"/></clipPath>
				<mask id="mk" style="mask-type: alpha"><rect x="0" y="0" width="50" height="50" fill="#fff"/></mask>
				<mask id="lum"><rect x="100" y="100" width="20" height="20" fill="#fff"/></mask>
			</defs>
			<g clip-path="url(#c)"><rect width="100" height="100" fill="blue"/></g>
			<rect id="half" x="100" y="0" width="80" height="40" clip-path="url(#bb)" fill="green"/>
			<rect id="soft" x="0" y="0" width="100" height="100" mask="url(#mk)" style="clip-path: url('#c')"/>
			<rect id="both" x="100" y="100" width="50" height="50" mask="url(#lum)" transform="translate(10 0)"/>
			<rect id="dangling" x="0" y="0" width="5" height="5" clip-path="url(#missing)"/>
		</svg>`;
		const nodes = parseVectorSvg(svg).nodes;
		expect(nodes).toHaveLength(5);
		const [clip, half, soft, both, dangling] = nodes as VectorGroupNode[];
		expect(clip.mask).toEqual({ type: 'clip' });
		expect(clip.children[0]).toMatchObject({ type: 'path', fill: null, stroke: null, fillRule: 'evenodd' });
		near(vectorNodeBounds(clip), 30, 30, 40, 40);
		expect(half.mask).toEqual({ type: 'clip' });
		near(vectorNodeBounds(half), 100, 0, 40, 40);
		// Clip inside, mask outside, as SVG applies them.
		expect(soft.mask).toEqual({ type: 'alpha' });
		expect((soft.children[1] as VectorGroupNode).mask).toEqual({ type: 'clip' });
		expect(both.mask).toEqual({ type: 'luminance' });
		// The mask content sits in the element's user space (its transform included).
		near(vectorNodeBounds(both.children[0]), 110, 100, 20, 20);
		expect(dangling.type).toBe('path');
	});
});

describe('mask commands through the tool registry', () => {
	const setup = () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 100), rect('b', 200, 0, 50), circle('c', 50, 50, 20)) });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const run = async (id: string, params?: unknown) => {
			const r = await tools.callTool('run_command', { id, ...(params !== undefined ? { params } : {}) });
			return { isError: !!r.isError, ...(r.structuredContent as any) };
		};
		return { c, run };
	};

	it('makes, edits and releases masks, returning the group id and mask summary', async () => {
		const { c, run } = setup();
		const made = await run('vector.makeClippingMask', { ids: ['a', 'c'] });
		expect(made.isError).toBe(false);
		const id = made.result.id;
		expect(made.result.mask).toEqual({ type: 'clip', invert: false, maskId: 'c', contents: ['a'], enabled: true });
		const listed = await run('vector.list');
		expect(listed.result.nodes.find((n: any) => n.id === id).mask).toEqual(made.result.mask);
		const set = await run('vector.setMaskOptions', { ids: [id], type: 'luminance', invert: true });
		expect(set.result).toEqual({ groups: [{ id, mask: { type: 'luminance', invert: true, maskId: 'c', contents: ['a'], enabled: true } }] });
		const off = await run('vector.setMaskOptions', { ids: [id], enabled: false });
		expect(off.result.groups[0].mask.enabled).toBe(false);
		expect(c.getNode('c')!.visible).toBe(false);
		expect((await run('vector.setMaskOptions', { ids: [id], enabled: true })).result.groups[0].mask.enabled).toBe(true);
		expect(c.getNode('c')!.visible).toBeUndefined();
		const released = await run('vector.releaseMask', { ids: [id] });
		expect(released.result).toEqual({ ids: ['a', 'c'] });
		const opacity = await run('vector.makeOpacityMask', { ids: ['a', 'c'], maskId: 'a', type: 'alpha' });
		expect(opacity.result.mask).toMatchObject({ type: 'alpha', maskId: 'a', contents: ['c'] });
		// Each write is one undo step.
		c.undo();
		expect(c.getNode(opacity.result.id)).toBeUndefined();
	});

	it('refuses bad input with messages that say what to do', async () => {
		const { c, run } = setup();
		expect((await run('vector.makeClippingMask', { ids: ['a'] })).error.message).toMatch(/at least two objects/);
		c.setLocked('b', true);
		expect((await run('vector.makeClippingMask', { ids: ['a', 'b'] })).error.message).toMatch(/"b" is locked/);
		expect((await run('vector.makeClippingMask', { ids: ['a', 'zz'] })).error.message).toMatch(/There is no node "zz"/);
		expect((await run('vector.makeClippingMask', { ids: ['a', 'c'], maskId: 'b' })).error.message).toMatch(/maskId "b" must be one of ids/);
		expect((await run('vector.makeOpacityMask', { ids: ['a', 'c'], type: 'clip' })).error.code).toBe('invalid_params');
		expect((await run('vector.makeClippingMask', { ids: ['a', 'c'], extra: 1 })).error.code).toBe('invalid_params');
		expect((await run('vector.setMaskOptions', { ids: ['a'] })).error.message).toMatch(/Pass at least one of type, invert, enabled/);
		expect((await run('vector.setMaskOptions', { ids: ['a'], invert: true })).error.message).toMatch(/is a mask group/);
		expect((await run('vector.releaseMask', { ids: ['a'] })).error.message).toMatch(/make one with vector.makeClippingMask/);
		expect(c.getState().document.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
	});
});
