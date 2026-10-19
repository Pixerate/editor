// Fill and stroke stacks, blend modes and visual filters. The paint model follows ArtCraft
// figcraft `crates/color/src/lib.rs` and vectorcraft `crates/doc/src/appearance.rs`, the filter
// construction designcraft `crates/render/src/fx.rs` (MIT OR Apache-2.0, © ArtCraft Team and
// contributors); test cases re-expressed. See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import {
	VectorEditorController,
	activeVectorFilters,
	createVectorCommands,
	createVectorFilter,
	getVectorSceneRenderData,
	hitTestVectorNode,
	hitTestVectorPaintLayer,
	normalizeVectorPaintStacks,
	parseVectorSvg,
	rectSubpath,
	sanitizeVectorStrokes,
	subpathsToBezier,
	transformVectorNode,
	vectorBlendModeCss,
	vectorBlendModeFromCss,
	vectorDocumentToSvg,
	vectorFills,
	vectorFilterReach,
	vectorFilterSvg,
	vectorStrokes,
	withVectorFills,
	withVectorStrokes,
	VECTOR_BLEND_MODES,
	type VectorDocument,
	type VectorPathNode,
	type VectorRenderPath
} from '../src/vector';

const rect = (id: string, x: number, y: number, size: number, extra: Partial<VectorPathNode> = {}): VectorPathNode => ({
	id,
	type: 'path',
	subpaths: [rectSubpath({ x, y, width: size, height: size })],
	fill: '#ff0000',
	stroke: null,
	...extra
});

const doc = (...nodes: VectorPathNode[]): VectorDocument => ({ width: 400, height: 300, nodes });

describe('paint stacks: model', () => {
	it('reads the shorthand as a one-layer stack', () => {
		const n = rect('a', 0, 0, 10, { stroke: '#000', strokeWidth: 3, strokeAlign: 'inside' });
		expect(vectorFills(n)).toEqual([{ paint: '#ff0000' }]);
		expect(vectorStrokes(n)).toEqual([{ paint: '#000', strokeWidth: 3, strokeAlign: 'inside' }]);
		expect(vectorFills(rect('b', 0, 0, 10, { fill: 'none' }))).toEqual([]);
	});

	it('stores one plain layer as the shorthand and mirrors the top layer otherwise', () => {
		const one = withVectorFills(rect('a', 0, 0, 10), [{ paint: '#00f' }]);
		expect(one.fills).toBeUndefined();
		expect(one.fill).toBe('#00f');
		const two = withVectorFills(rect('a', 0, 0, 10), [{ paint: '#00f' }, { paint: '#0f0', opacity: 0.5 }]);
		expect(two.fill).toBe('#0f0');
		expect(two.fills).toHaveLength(2);
		// A single layer with its own opacity needs the stack.
		expect(withVectorFills(rect('a', 0, 0, 10), [{ paint: '#00f', blendMode: 'multiply' }]).fills).toHaveLength(1);
		const strokes = withVectorStrokes(rect('a', 0, 0, 10, { strokeAlign: 'outside' }), [
			{ paint: '#111', strokeWidth: 8 },
			{ paint: '#222', strokeWidth: 2, strokeAlign: 'inside' }
		]);
		expect(strokes).toMatchObject({ stroke: '#222', strokeWidth: 2, strokeAlign: 'inside' });
		const flipped = withVectorStrokes(strokes, [strokes.strokes![1], strokes.strokes![0]]);
		// The mirror drops settings the new top layer doesn't have.
		expect(flipped.strokeAlign).toBeUndefined();
		expect(flipped.strokeWidth).toBe(8);
	});

	it('reads a shorthand that disagrees with the stack as an edit of its top layer', () => {
		const stacked = withVectorFills(rect('a', 0, 0, 10), [{ paint: '#00f' }, { paint: '#0f0', opacity: 0.5 }]);
		const edited = normalizeVectorPaintStacks({ ...stacked, fill: '#fff' });
		expect(edited.fills).toEqual([{ paint: '#00f' }, { paint: '#fff', opacity: 0.5 }]);
		// null clears the stack.
		const cleared = normalizeVectorPaintStacks({ ...stacked, fill: null });
		expect(cleared.fills).toBeUndefined();
		expect(cleared.fill).toBeNull();
		// Loading prefers the stack.
		expect(normalizeVectorPaintStacks({ ...stacked, fill: '#fff' }, 'stack').fill).toBe('#0f0');
		// Already canonical: the same object.
		expect(normalizeVectorPaintStacks(stacked)).toBe(stacked);
	});

	it('edits the top stroke through the stroke settings', () => {
		const stacked = withVectorStrokes(rect('a', 0, 0, 10), [
			{ paint: '#111', strokeWidth: 8, strokeAlign: 'outside' },
			{ paint: '#222', strokeWidth: 2, startArrow: 'triangle' }
		]);
		const { startArrow: _s, ...rest } = stacked;
		const edited = normalizeVectorPaintStacks({ ...rest, strokeWidth: 4 } as VectorPathNode);
		expect(edited.strokes).toEqual([
			{ paint: '#111', strokeWidth: 8, strokeAlign: 'outside' },
			{ paint: '#222', strokeWidth: 4 }
		]);
		expect(normalizeVectorPaintStacks({ ...stacked, stroke: 'none' }).strokes).toBeUndefined();
	});

	it('keeps stroke layers of unknown kinds through sanitizing (the brushstroke extension point)', () => {
		const layers = sanitizeVectorStrokes([{ kind: 'brush', paint: '#000', brush: { preset: 'ink' } }, { paint: '#123', strokeWidth: -1, blendMode: 'bogus', opacity: 2 }]);
		expect(layers[0]).toEqual({ kind: 'brush', paint: '#000', brush: { preset: 'ink' } });
		expect(layers[1]).toEqual({ paint: '#123' });
		const node = withVectorStrokes(rect('a', 0, 0, 10), layers);
		// Not drawn or hit, but kept.
		expect(getVectorSceneRenderData({ document: doc(node), viewport: { x: 0, y: 0, zoom: 1 } }).nodes[0]).toMatchObject({ layers: [{ kind: 'fill' }, { kind: 'stroke', index: 1 }] });
	});

	it('maps blend modes to CSS and back', () => {
		expect(VECTOR_BLEND_MODES).toContain('multiply');
		expect(VECTOR_BLEND_MODES).not.toContain('pigment');
		expect(vectorBlendModeCss('normal')).toBeUndefined();
		expect(vectorBlendModeCss('linear-dodge')).toBe('plus-lighter');
		expect(vectorBlendModeFromCss('plus-lighter')).toBe('linear-dodge');
		expect(vectorBlendModeFromCss('screen')).toBe('screen');
		expect(vectorBlendModeFromCss('plus-darker')).toBeNull();
	});

	it('moves layer gradients and mirrors layer profiles with baked transforms', () => {
		const n = withVectorStrokes(
			withVectorFills(rect('a', 0, 0, 10), [
				{ paint: '#000' },
				{ paint: { type: 'linear', units: 'userSpaceOnUse', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] }, opacity: 0.5 }
			]),
			[
				{ paint: '#000', strokeWidthProfile: [{ t: 0, left: 1, right: 0 }, { t: 1, left: 1, right: 0 }] },
				{ paint: '#f00' }
			]
		);
		const moved = transformVectorNode(n, [-2, 0, 0, 2, 0, 0]);
		expect((moved.fills![1].paint as any).end).toEqual({ x: -20, y: 0 });
		expect(moved.strokes![0].strokeWidthProfile![0]).toMatchObject({ left: 0, right: 1 });
	});
});

describe('paint stacks: controller', () => {
	const twoFills = () => withVectorFills(rect('a', 0, 0, 100), [{ paint: '#00f' }, { paint: '#0f0', opacity: 0.5 }]);

	it('adds, edits, reorders and removes layers, one undo step each', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 100)) });
		expect(c.addPaintLayer('fill', { paint: '#0f0', blendMode: 'multiply' }, { ids: ['a'] })).toEqual({ ok: true });
		const path = () => c.getNode('a') as VectorPathNode;
		expect(vectorFills(path())).toEqual([{ paint: '#ff0000' }, { paint: '#0f0', blendMode: 'multiply' }]);
		expect(path().fill).toBe('#0f0');
		c.updatePaintLayer('fill', 0, { opacity: 0.25, visible: false }, { ids: ['a'] });
		expect(vectorFills(path())[0]).toEqual({ paint: '#ff0000', opacity: 0.25, visible: false });
		c.movePaintLayer('fill', 0, 1, { ids: ['a'] });
		expect(vectorFills(path()).map((l) => l.paint)).toEqual(['#0f0', '#ff0000']);
		c.removePaintLayer('fill', 1, { ids: ['a'] });
		// One layer left, but with its own blend mode: still a stack.
		expect(path().fills).toEqual([{ paint: '#0f0', blendMode: 'multiply' }]);
		expect(path().fill).toBe('#0f0');
		c.undo();
		expect(vectorFills(path())).toHaveLength(2);
		c.undo();
		c.undo();
		c.undo();
		expect(path()).toEqual(rect('a', 0, 0, 100));
	});

	it('gives a new stroke the top stroke settings', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 100, { stroke: '#000', strokeWidth: 6, strokeLinejoin: 'round' })) });
		c.addPaintLayer('stroke', { paint: '#fff', strokeAlign: 'inside' }, { ids: ['a'] });
		expect(vectorStrokes(c.getNode('a') as VectorPathNode)).toEqual([
			{ paint: '#000', strokeWidth: 6, strokeLinejoin: 'round' },
			{ paint: '#fff', strokeWidth: 6, strokeLinejoin: 'round', strokeAlign: 'inside' }
		]);
	});

	it('fails without changing anything on a bad index or value', () => {
		const c = new VectorEditorController({ document: doc(twoFills(), rect('b', 200, 0, 50)) });
		const before = c.getState().document;
		expect(c.updatePaintLayer('fill', 1, { opacity: 0.1 }, { ids: ['a', 'b'] })).toMatchObject({ ok: false, message: expect.stringContaining('has no fill 1') });
		expect(c.updatePaintLayer('fill', 0, { blendMode: 'pigment' }, { ids: ['a'] })).toMatchObject({ ok: false, message: expect.stringContaining('Unknown blend mode') });
		expect(c.addPaintLayer('stroke', { strokeWidth: -2 }, { ids: ['a'] })).toMatchObject({ ok: false, message: expect.stringContaining('strokeWidth') });
		expect(c.getState().document).toBe(before);
	});

	it('keeps setStyle and the gradient tool working on the top layer', () => {
		const c = new VectorEditorController({ document: doc(twoFills()) });
		c.setStyle({ fill: '#fff' }, ['a']);
		expect(vectorFills(c.getNode('a') as VectorPathNode)).toEqual([{ paint: '#00f' }, { paint: '#fff', opacity: 0.5 }]);
		c.setGradient({ type: 'radial' }, { ids: ['a'], target: 'fill', layer: 0 });
		const fills = vectorFills(c.getNode('a') as VectorPathNode);
		expect((fills[0].paint as any).type).toBe('radial');
		expect(fills[1].paint).toBe('#fff');
		c.setStyle({ fill: null }, ['a']);
		expect(vectorFills(c.getNode('a') as VectorPathNode)).toEqual([]);
	});

	it('loads old documents unchanged and stale shorthands from the stacks', () => {
		const old = doc(rect('a', 0, 0, 10, { stroke: '#000', strokeWidth: 2 }));
		expect(new VectorEditorController({ document: old }).getState().document).toEqual(old);
		const stale = { ...twoFills(), fill: '#123456' };
		expect((new VectorEditorController({ document: doc(stale) }).getNode('a') as VectorPathNode).fill).toBe('#0f0');
	});

	it('applies stacks given to new shapes and the defaults', () => {
		const c = new VectorEditorController({ document: doc(), defaults: { fills: [{ paint: '#111' }, { paint: '#222', blendMode: 'screen' }] } });
		const id = c.addShape({ kind: 'rect', x: 0, y: 0, width: 10, height: 10 });
		expect(vectorFills(c.getNode(id) as VectorPathNode)).toEqual([{ paint: '#111' }, { paint: '#222', blendMode: 'screen' }]);
		const line = c.addShape({ kind: 'line', x: 0, y: 0, width: 10, height: 0 });
		expect(vectorFills(c.getNode(line) as VectorPathNode)).toEqual([]);
	});

	it('sets node blend modes and filters, one undo step each', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 100)) });
		expect(c.setBlendMode('multiply', { ids: ['a'] }).ok).toBe(true);
		expect(c.getNode('a')!.blendMode).toBe('multiply');
		expect(c.setBlendMode('normal', { ids: ['a'] }).ok).toBe(true);
		expect(c.getNode('a')!.blendMode).toBeUndefined();
		const [id] = c.addFilter('dropShadow', { ids: ['a'], params: { blur: 12, color: 'red' } });
		expect(c.getNode('a')!.filters).toEqual([{ id, type: 'dropShadow', params: { color: 'red', opacity: 0.25, offsetX: 0, offsetY: 4, blur: 12, spread: 0 } }]);
		c.updateFilter('a', id, { params: { opacity: 2 }, enabled: false });
		expect(c.getNode('a')!.filters![0]).toMatchObject({ enabled: false, params: { opacity: 1 } });
		const [blur] = c.addFilter('layerBlur', { ids: ['a'] });
		c.moveFilter('a', blur, 0);
		expect(c.getNode('a')!.filters!.map((f) => f.type)).toEqual(['layerBlur', 'dropShadow']);
		c.removeFilter('a', blur);
		c.removeFilter('a', id);
		expect(c.getNode('a')!.filters).toBeUndefined();
		expect(c.removeFilter('a', id).ok).toBe(false);
	});

	it('outlines each stroke layer into its own filled path', () => {
		const node = withVectorStrokes(rect('a', 0, 0, 100), [
			{ paint: '#111', strokeWidth: 10, strokeAlign: 'outside' },
			{ paint: '#222', strokeWidth: 2, opacity: 0.5, blendMode: 'screen' }
		]);
		const c = new VectorEditorController({ document: doc(node) });
		const ids = c.outlineStroke({ ids: ['a'] });
		expect(ids).toHaveLength(2);
		const nodes = c.getState().document.nodes as VectorPathNode[];
		expect(nodes.map((n) => n.id)).toEqual(['a', ...ids]);
		expect(vectorStrokes(nodes[0])).toEqual([]);
		expect(vectorFills(nodes[2])).toEqual([{ paint: '#222', opacity: 0.5, blendMode: 'screen' }]);
	});
});

describe('paint stacks: rendering and hit-testing', () => {
	it('renders the drawn layers, bottom to top, with their opacity and blend mode', () => {
		const node = withVectorStrokes(
			withVectorFills(rect('a', 0, 0, 100, { blendMode: 'multiply' }), [{ paint: '#00f' }, { paint: '#0f0', opacity: 0.5, blendMode: 'screen' }, { paint: '#f00', visible: false }]),
			[
				{ paint: '#111', strokeWidth: 10, strokeAlign: 'outside' },
				{ paint: '#222', strokeWidth: 2 }
			]
		);
		const scene = getVectorSceneRenderData({ document: doc(node), viewport: { x: 0, y: 0, zoom: 1 } });
		const p = scene.nodes[0] as VectorRenderPath;
		expect(p.blendMode).toBe('multiply');
		expect(p.layers!.map((l) => [l.kind, l.index])).toEqual([
			['fill', 0],
			['fill', 1],
			['stroke', 0],
			['stroke', 1]
		]);
		expect(p.layers![1]).toMatchObject({ fill: '#0f0', stroke: 'none', opacity: 0.5, blendMode: 'screen' });
		expect(p.layers![2].strokeParts?.clip?.kind).toBe('mask');
		expect(p.layers![3]).toMatchObject({ stroke: '#222', strokeWidth: 2 });
		expect(p.layers![3].strokeParts).toBeUndefined();
		// Clip ids are unique per layer.
		expect(p.layers![2].strokeParts!.clip!.id).toBe('ve-clip-a-0');
		// The top-level fields describe the top drawn layers.
		expect(p).toMatchObject({ fill: '#0f0', stroke: '#222' });
	});

	it('keeps single-paint nodes as they were', () => {
		const p = getVectorSceneRenderData({ document: doc(rect('a', 0, 0, 10, { stroke: '#000' })), viewport: { x: 0, y: 0, zoom: 1 } }).nodes[0] as VectorRenderPath;
		expect(p.layers).toBeUndefined();
		expect(p.blendMode).toBeUndefined();
		expect(p).toMatchObject({ fill: '#ff0000', stroke: '#000' });
	});

	it('hit-tests the topmost drawn layer', () => {
		const node = withVectorStrokes(withVectorFills(rect('a', 0, 0, 100), [{ paint: '#00f' }, { paint: '#0f0', visible: false }]), [{ paint: '#111', strokeWidth: 10, strokeAlign: 'outside' }]);
		const path = subpathsToBezier(node.subpaths);
		expect(hitTestVectorPaintLayer(node, path, { x: 50, y: 50 })).toEqual({ kind: 'fill', index: 0 });
		expect(hitTestVectorPaintLayer(node, path, { x: -5, y: 50 })).toEqual({ kind: 'stroke', index: 0 });
		expect(hitTestVectorNode(node, { x: -5, y: 50 })).toBe(true);
		expect(hitTestVectorNode(node, { x: -15, y: 50 })).toBe(false);
		// Only a hidden fill: the inside is not hit.
		const hidden = withVectorFills(rect('b', 0, 0, 100), [{ paint: '#00f', visible: false }]);
		expect(hitTestVectorNode(hidden, { x: 50, y: 50 })).toBe(false);
		// A fill at zero opacity paints nothing.
		expect(hitTestVectorNode(withVectorFills(rect('c', 0, 0, 100), [{ paint: '#00f', opacity: 0 }]), { x: 50, y: 50 })).toBe(false);
	});
});

describe('filters', () => {
	it('builds shadows under, inner effects over and blurs on top', () => {
		const filters = [
			createVectorFilter('layerBlur', 'f1', { radius: 4 })!,
			createVectorFilter('dropShadow', 'f2', { offsetX: 3, offsetY: 5, blur: 6, spread: 2 })!,
			createVectorFilter('innerShadow', 'f3')!,
			createVectorFilter('feather', 'f4', { radius: 8 })!
		];
		const svg = vectorFilterSvg(filters, 'fx', { x: 0, y: 0, width: 100, height: 50 })!;
		const tags = svg.primitives.map((p) => p.tag);
		expect(tags[0]).toBe('feComponentTransfer');
		expect(tags.indexOf('feMorphology')).toBeGreaterThan(0);
		const merge = svg.primitives.find((p) => p.tag === 'feMerge')!;
		// The shadow first, the body (inner shadow, then feather) on top.
		expect(merge.children!.map((c) => c.attrs.in)).toEqual(['shadow3', 'body2']);
		const last = svg.primitives[svg.primitives.length - 1];
		expect(last).toMatchObject({ tag: 'feGaussianBlur', attrs: { stdDeviation: 2 } });
		// Region: reach (shadow 5 + 9 + 2, then the blur's 6) plus a margin, on every side.
		expect(vectorFilterReach(filters)).toBe(22);
		expect(svg).toMatchObject({ x: -24, y: -24, width: 148, height: 98 });
	});

	it('leaves out disabled and empty filters', () => {
		const off = { ...createVectorFilter('dropShadow', 'a')!, enabled: false };
		const empty = createVectorFilter('layerBlur', 'b', { radius: 0 })!;
		expect(activeVectorFilters({ filters: [off, empty] })).toEqual([]);
		expect(vectorFilterSvg([off, empty], 'x', { x: 0, y: 0, width: 1, height: 1 })).toBeNull();
	});

	it('renders node filters in the scene, groups included', () => {
		const group = { id: 'g', type: 'group' as const, children: [rect('a', 0, 0, 10)], filters: [createVectorFilter('outerGlow', 'f1')!], blendMode: 'screen' as const };
		const scene = getVectorSceneRenderData({ document: { width: 100, height: 100, nodes: [group] }, viewport: { x: 0, y: 0, zoom: 1 } }, { idPrefix: 'p-' });
		expect(scene.filters.map((f) => f.id)).toEqual(['p-filter-g']);
		expect(scene.nodes[0]).toMatchObject({ kind: 'group', filter: 'url(#p-filter-g)', blendMode: 'screen' });
	});
});

describe('paint stacks: SVG', () => {
	const stacked = () => {
		let n = rect('a', 10, 10, 100, { blendMode: 'multiply', filters: [createVectorFilter('dropShadow', 'f1', { blur: 6 })!] });
		n = withVectorFills(n, [{ paint: '#00f' }, { paint: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] }, opacity: 0.5, blendMode: 'overlay' }]);
		return withVectorStrokes(n, [
			{ paint: '#111', strokeWidth: 10, strokeAlign: 'outside' },
			{ paint: '#222', strokeWidth: 2, visible: false },
			{ paint: '#333', strokeWidth: 1, strokeDasharray: [4, 2] }
		]);
	};

	it('exports the layers, blend modes and filters, and imports them back', () => {
		const svg = vectorDocumentToSvg(doc(stacked()));
		expect(svg).toContain('style="mix-blend-mode:multiply"');
		expect(svg).toContain('style="mix-blend-mode:overlay"');
		expect(svg).toContain('<filter id="vg-filter-a"');
		expect(svg).toContain('filter="url(#vg-filter-a)"');
		expect(svg).toContain('data-vector-fills=');
		// The hidden stroke is not drawn (but kept in the data).
		expect(svg).not.toContain('stroke="#222"');
		const back = parseVectorSvg(svg).nodes[0] as VectorPathNode;
		const orig = stacked();
		expect(vectorFills(back)).toEqual(vectorFills(orig));
		expect(vectorStrokes(back)).toEqual(vectorStrokes(orig));
		expect(back.blendMode).toBe('multiply');
		expect(back.filters).toEqual(orig.filters);
		expect(back.subpaths).toEqual(orig.subpaths);
	});

	it('scales stroke layers with an imported transform', () => {
		const svg = vectorDocumentToSvg(doc(stacked())).replace('<g id="a"', '<g transform="scale(2)"><g id="a"').replace('</svg>', '</g></svg>');
		const group = parseVectorSvg(svg).nodes[0] as any;
		expect(vectorStrokes(group.children[0]).map((l) => l.strokeWidth)).toEqual([20, 4, 2]);
	});

	it('reads foreign opacities, blend modes, drop shadows and blurs', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
			<defs>
				<filter id="s"><feDropShadow dx="1" dy="3" stdDeviation="2" flood-color="#123" flood-opacity="0.4"/></filter>
				<filter id="b"><feGaussianBlur stdDeviation="5"/></filter>
				<filter id="x"><feTurbulence/></filter>
			</defs>
			<rect id="r" width="10" height="10" fill="red" fill-opacity="0.5" stroke="blue" style="stroke-opacity: 0.25; mix-blend-mode: screen" filter="url(#s)"/>
			<rect id="q" width="10" height="10" filter="url(#b)"/>
			<rect id="t" width="10" height="10" filter="url(#x)"/>
		</svg>`;
		const [r, q, t] = parseVectorSvg(svg).nodes as VectorPathNode[];
		expect(vectorFills(r)).toEqual([{ paint: 'red', opacity: 0.5 }]);
		expect(vectorStrokes(r)).toEqual([{ paint: 'blue', opacity: 0.25 }]);
		expect(r.blendMode).toBe('screen');
		expect(r.filters).toEqual([{ id: 'filter1', type: 'dropShadow', params: { color: '#123', opacity: 0.4, offsetX: 1, offsetY: 3, blur: 4, spread: 0 } }]);
		expect(q.filters).toEqual([{ id: 'filter1', type: 'layerBlur', params: { radius: 10 } }]);
		expect(t.filters).toBeUndefined();
	});

	it('merges neighbouring shapes with one outline into a stack when asked', () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
			<rect width="10" height="10" fill="red"/>
			<rect width="10" height="10" fill="blue" fill-opacity="0.5"/>
			<rect width="10" height="10" fill="none" stroke="black"/>
			<rect width="10" height="10" fill="green"/>
			<rect x="20" width="10" height="10" fill="green"/>
		</svg>`;
		expect(parseVectorSvg(svg).nodes).toHaveLength(5);
		const nodes = parseVectorSvg(svg, { mergeStackedShapes: true }).nodes as VectorPathNode[];
		// The green fill would land under the black stroke, so it stays apart; so does the moved one.
		expect(nodes).toHaveLength(3);
		expect(vectorFills(nodes[0])).toEqual([{ paint: 'red' }, { paint: 'blue', opacity: 0.5 }]);
		expect(vectorStrokes(nodes[0])).toEqual([{ paint: 'black' }]);
	});
});

describe('appearance commands through the tool registry', () => {
	const setup = () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 100), rect('b', 200, 0, 50)) });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const run = async (id: string, params?: unknown) => {
			const r = await tools.callTool('run_command', { id, ...(params !== undefined ? { params } : {}) });
			return { isError: !!r.isError, ...(r.structuredContent as any) };
		};
		return { c, commands, run };
	};

	it('adds, edits, reorders and removes fills and strokes, returning the stacks', async () => {
		const { c, run } = setup();
		const added = await run('vector.addFill', { ids: ['a'], paint: '#0f0', opacity: 0.5, blendMode: 'multiply' });
		expect(added.result).toEqual({ nodes: [{ id: 'a', fills: [{ paint: '#ff0000' }, { paint: '#0f0', opacity: 0.5, blendMode: 'multiply' }] }] });
		const updated = await run('vector.updateFill', { nodeId: 'a', index: 0, visible: false });
		expect(updated.result.fills[0]).toEqual({ paint: '#ff0000', visible: false });
		const moved = await run('vector.moveFill', { nodeId: 'a', index: 0, to: 1 });
		expect(moved.result.fills.map((l: any) => l.paint)).toEqual(['#0f0', '#ff0000']);
		const stroke = await run('vector.addStroke', { ids: ['a'], paint: '#000', strokeWidth: 4, strokeAlign: 'inside' });
		expect(stroke.result.nodes[0].strokes).toEqual([{ paint: '#000', strokeWidth: 4, strokeAlign: 'inside' }]);
		await run('vector.addStroke', { ids: ['a'], paint: '#fff', strokeWidth: 1, startArrow: 'triangle' });
		const cleared = await run('vector.updateStroke', { nodeId: 'a', index: 1, startArrow: null, strokeDasharray: [2, 2] });
		expect(cleared.result.strokes[1]).toEqual({ paint: '#fff', strokeWidth: 1, strokeAlign: 'inside', strokeDasharray: [2, 2] });
		const removed = await run('vector.removeStroke', { nodeId: 'a', index: 0 });
		expect(removed.result.strokes).toHaveLength(1);
		const read = await run('vector.getAppearance', { id: 'a' });
		expect(read.result).toMatchObject({ id: 'a', type: 'path', blendMode: 'normal', opacity: 1, filters: [], fillRule: 'nonzero' });
		expect(read.result.fills).toHaveLength(2);
		// Each write was one undo step.
		for (let i = 0; i < 7; i++) c.undo();
		expect(c.getNode('a')).toEqual(rect('a', 0, 0, 100));
	});

	it('fails usefully', async () => {
		const { run } = setup();
		const out = await run('vector.updateFill', { nodeId: 'a', index: 3, opacity: 0.5 });
		expect(out.isError).toBe(true);
		expect(out.error.message).toMatch(/index 3 is out of range: "a" has 1 fill \(0 is the bottom\)/);
		expect((await run('vector.updateFill', { nodeId: 'a', index: 0 })).error.message).toMatch(/Pass at least one of/);
		expect((await run('vector.updateFill', { nodeId: 'a', index: 0, width: 3 })).error.code).toBe('invalid_params');
		expect((await run('vector.addFill', { ids: ['zz'] })).error.message).toMatch(/There is no node "zz"/);
		expect((await run('vector.addFill', { ids: ['a'], blendMode: 'pigment' })).error.code).toBe('invalid_params');
		expect((await run('vector.addFill', { ids: ['a'], paint: { type: 'linear', stops: [] } })).isError).toBe(true);
		expect((await run('vector.addFilter', { ids: ['a'], type: 'dropShadow', params: { radius: 3 } })).error.message).toMatch(/dropShadow has no parameter "radius"/);
		expect((await run('vector.updateFilter', { nodeId: 'a', filterId: 'nope', enabled: false })).error.message).toMatch(/has no filter "nope"; it has none/);
	});

	it('sets blend modes and filters, returning the new state', async () => {
		const { run } = setup();
		expect((await run('vector.setBlendMode', { ids: ['a', 'b'], blendMode: 'screen' })).result).toEqual({
			nodes: [
				{ id: 'a', blendMode: 'screen' },
				{ id: 'b', blendMode: 'screen' }
			]
		});
		const added = await run('vector.addFilter', { ids: ['a'], type: 'innerGlow', params: { blur: 3 } });
		const filterId = added.result.nodes[0].filterId;
		expect(added.result.nodes[0].filters[0]).toMatchObject({ id: filterId, type: 'innerGlow', params: { blur: 3 } });
		const updated = await run('vector.updateFilter', { nodeId: 'a', filterId, params: { spread: 2 } });
		expect(updated.result.filters[0].params).toMatchObject({ blur: 3, spread: 2 });
		await run('vector.addFilter', { ids: ['a'], type: 'feather' });
		const moved = await run('vector.moveFilter', { nodeId: 'a', filterId, index: 1 });
		expect(moved.result.filters.map((f: any) => f.type)).toEqual(['feather', 'innerGlow']);
		expect((await run('vector.removeFilter', { nodeId: 'a', filterId })).result.filters).toHaveLength(1);
		const listed = await run('vector.list');
		expect(listed.result.nodes[0]).toMatchObject({ blendMode: 'screen', filters: [{ type: 'feather' }] });
	});

	it('accepts stacks in setStyle and addShape', async () => {
		const { c, run } = setup();
		const shape = await run('vector.addShape', { kind: 'rect', x: 0, y: 0, width: 10, height: 10, fills: [{ paint: '#111' }, { paint: '#222', opacity: 0.5 }], strokes: [{ paint: '#000', strokeWidth: 3 }] });
		const node = c.getNode(shape.result.id) as VectorPathNode;
		expect(vectorFills(node)).toEqual([{ paint: '#111' }, { paint: '#222', opacity: 0.5 }]);
		expect(vectorStrokes(node)).toEqual([{ paint: '#000', strokeWidth: 3 }]);
		await run('vector.setStyle', { ids: ['b'], strokes: [{ paint: '#000', strokeWidth: 8 }, { paint: '#fff', strokeWidth: 2 }] });
		expect(vectorStrokes(c.getNode('b') as VectorPathNode)).toHaveLength(2);
		expect((await run('vector.setStyle', { ids: ['b'], fills: [{ paint: '#000', blendMode: 'nope' }] })).isError).toBe(true);
	});

	it('describes every argument and rejects unknown ones', () => {
		const { commands } = setup();
		const ids = ['getAppearance', 'addFill', 'updateFill', 'removeFill', 'moveFill', 'addStroke', 'updateStroke', 'removeStroke', 'moveStroke', 'setBlendMode', 'addFilter', 'updateFilter', 'removeFilter', 'moveFilter'];
		for (const id of ids) {
			const entry = commands.list().find((e) => e.id === `vector.${id}`)!;
			expect(entry, id).toBeTruthy();
			expect(entry.description, id).toBeTruthy();
			expect((entry.params as any).additionalProperties, id).toBe(false);
			for (const [key, prop] of Object.entries((entry.params as any).properties)) expect((prop as any).description, `${id}.${key}`).toBeTruthy();
		}
	});
});
