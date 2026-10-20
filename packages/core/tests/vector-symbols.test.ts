import { describe, expect, it } from 'vitest';
import {
	expandVectorAppearance,
	getVectorSceneRenderData,
	hitTestVectorNode,
	parseVectorSvg,
	rectSubpath,
	resolveVectorSymbols,
	transformVectorNode,
	vectorDocumentToSvg,
	vectorNodeBounds,
	VectorEditorController,
	createVectorCommands,
	type VectorDocument,
	type VectorGroupNode,
	type VectorInstanceNode,
	type VectorPathNode
} from '../src/vector';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';

const square = (id: string, x: number, y: number, size = 20, fill = '#ff0000'): VectorPathNode => ({ id, type: 'path', fill, stroke: '#000000', strokeWidth: 2, subpaths: [rectSubpath({ x, y, width: size, height: size })] });

const docWithSymbol = (): VectorDocument => ({
	width: 400,
	height: 300,
	symbols: [{ id: 'sym', name: 'Box', nodes: [square('art', -10, -10)] }],
	nodes: [
		{ id: 'i1', type: 'instance', symbolId: 'sym', transform: [1, 0, 0, 1, 100, 100] },
		{ id: 'i2', type: 'instance', symbolId: 'sym', transform: [2, 0, 0, 3, 200, 100] }
	]
});

describe('symbol instances', () => {
	it('draw their symbol through a transform that may scale, strokes scaling with them', () => {
		const doc = resolveVectorSymbols(docWithSymbol());
		const [i1, i2] = doc.nodes as VectorInstanceNode[];
		expect(i1.art).toBe(doc.symbols![0].nodes);
		expect(vectorNodeBounds(i1)).toEqual({ x: 90, y: 90, width: 20, height: 20 });
		expect(vectorNodeBounds(i2)).toEqual({ x: 180, y: 70, width: 40, height: 60 });
		const drawn = expandVectorAppearance(i2) as VectorGroupNode;
		expect(drawn.type).toBe('group');
		expect(drawn.children[0].id).toBe('i2~art');
		// √(2·3) times the stroke width; transforms stay rigid on drawn nodes.
		expect((drawn.children[0] as VectorPathNode).strokeWidth).toBeCloseTo(2 * Math.sqrt(6));
		expect(drawn.transform).toBeUndefined();
		expect(hitTestVectorNode(i2, { x: 200, y: 100 })).toBe(true);
		expect(hitTestVectorNode(i2, { x: 230, y: 100 })).toBe(false);
		const unscaled = expandVectorAppearance({ ...i2, scaleStrokes: false }) as VectorGroupNode;
		expect((unscaled.children[0] as VectorPathNode).strokeWidth).toBe(2);
	});

	it('keep their whole matrix when transformed, and apply overrides', () => {
		const doc = resolveVectorSymbols(docWithSymbol());
		const i1 = doc.nodes[0] as VectorInstanceNode;
		const moved = transformVectorNode(i1, [1, 0, 0.5, 1, 0, 0]);
		expect(moved.transform).toEqual([1, 0, 0.5, 1, 150, 100]);
		const tinted = expandVectorAppearance({ ...i1, overrides: { fill: '#00ff00' } }) as VectorGroupNode;
		expect((tinted.children[0] as VectorPathNode).fill).toBe('#00ff00');
		const hidden = expandVectorAppearance({ ...i1, overrides: { hidden: ['art'] } }) as VectorGroupNode;
		expect(hidden.children).toHaveLength(0);
	});

	it('draw nothing for a missing symbol or a symbol that contains itself', () => {
		const doc = resolveVectorSymbols({
			width: 100,
			height: 100,
			symbols: [{ id: 'loop', name: 'Loop', nodes: [{ id: 'in', type: 'instance', symbolId: 'loop' }] }],
			nodes: [
				{ id: 'a', type: 'instance', symbolId: 'loop' },
				{ id: 'b', type: 'instance', symbolId: 'missing' }
			]
		});
		expect(vectorNodeBounds(doc.nodes[0])).toBeNull();
		expect(vectorNodeBounds(doc.nodes[1])).toBeNull();
	});

	it('export as <symbol> and <use>, or as drawn art when <use> cannot draw them exactly, and import back', () => {
		const doc = docWithSymbol();
		doc.nodes.push({ id: 'i3', type: 'instance', symbolId: 'sym', transform: [1, 0, 0, 1, 300, 200], overrides: { fill: '#0000ff' } });
		const svg = vectorDocumentToSvg(doc);
		expect(svg).toContain('<symbol id="vg-symbol-sym"');
		expect(svg).toContain('<use id="i1"');
		expect(svg).toContain('data-vector-instance');
		const back = parseVectorSvg(svg);
		expect(back.symbols).toEqual([{ id: 'sym', name: 'Box', nodes: [expect.objectContaining({ id: 'art', type: 'path' })] }]);
		expect(back.nodes.map((n) => [n.id, n.type, (n as VectorInstanceNode).transform])).toEqual([
			['i1', 'instance', [1, 0, 0, 1, 100, 100]],
			['i2', 'instance', [2, 0, 0, 3, 200, 100]],
			['i3', 'instance', [1, 0, 0, 1, 300, 200]]
		]);
		expect((back.nodes[2] as VectorInstanceNode).overrides).toEqual({ fill: '#0000ff' });
		expect(vectorNodeBounds(back.nodes[1])).toEqual({ x: 180, y: 70, width: 40, height: 60 });
	});

	it('import foreign <use> of a <symbol> or of a shape', () => {
		const doc = parseVectorSvg(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">
			<defs><symbol id="dot"><circle cx="0" cy="0" r="5" fill="red"/></symbol></defs>
			<rect id="bar" x="0" y="0" width="10" height="4" fill="blue"/>
			<use href="#dot" x="20" y="30"/>
			<use xlink:href="#bar" transform="translate(50 50) scale(2)"/>
		</svg>`);
		expect(doc.symbols!.map((s) => s.name)).toEqual(['dot', 'bar']);
		expect(doc.nodes.map((n) => n.type)).toEqual(['path', 'instance', 'instance']);
		expect(vectorNodeBounds(doc.nodes[1])).toEqual({ x: 15, y: 25, width: 10, height: 10 });
		expect(vectorNodeBounds(doc.nodes[2])).toEqual({ x: 50, y: 50, width: 20, height: 8 });
	});

	it('render through the scene data as groups', () => {
		const doc = resolveVectorSymbols(docWithSymbol());
		const scene = getVectorSceneRenderData({ document: doc, viewport: { x: 0, y: 0, zoom: 1 } });
		expect(scene.nodes.map((n) => [n.kind, n.id])).toEqual([
			['group', 'i1'],
			['group', 'i2']
		]);
	});
});

describe('VectorEditorController symbols', () => {
	const make = () => {
		let n = 0;
		return new VectorEditorController({ document: { width: 400, height: 300, nodes: [square('a', 0, 0), square('b', 30, 0)] }, createId: () => `n${++n}` });
	};

	it('makes a symbol from the selection, places, replaces and detaches instances, one undo step each', () => {
		const c = make();
		const r = c.makeSymbol({ ids: ['a', 'b'], name: 'Pair' });
		expect(r.ok).toBe(true);
		const sym = c.getSymbols()[0];
		expect(sym).toMatchObject({ id: r.symbolId, name: 'Pair' });
		// Registration point at the centre of the objects: (25, 10).
		expect(vectorNodeBounds(sym.nodes[0])).toEqual({ x: -25, y: -10, width: 20, height: 20 });
		expect(c.getDocument().nodes.map((n) => n.id)).toEqual([r.instanceId]);
		expect(vectorNodeBounds(c.getNode(r.instanceId!)!)).toEqual({ x: 0, y: 0, width: 50, height: 20 });
		const placed = c.placeSymbol(r.symbolId!, { x: 200, y: 200 });
		expect(placed.ok).toBe(true);
		expect(vectorNodeBounds(c.getNode(placed.id!)!)).toEqual({ x: 175, y: 190, width: 50, height: 20 });
		expect(c.scale(2, 2, { ids: [placed.id!], origin: { x: 200, y: 200 } }).ok).toBe(true);
		expect((c.getNode(placed.id!) as VectorInstanceNode).transform).toEqual([2, 0, 0, 2, 200, 200]);
		expect(c.setInstanceOptions({ fill: '#123456', scaleStrokes: false }, { ids: [placed.id!] }).ok).toBe(true);
		expect(c.getNode(placed.id!)).toMatchObject({ overrides: { fill: '#123456' }, scaleStrokes: false });
		const detached = c.detachInstances({ ids: [placed.id!] });
		expect(detached.ok).toBe(true);
		const group = c.getNode(placed.id!) as VectorGroupNode;
		expect(group.type).toBe('group');
		expect(group.children.every((ch) => (ch as VectorPathNode).fill === '#123456')).toBe(true);
		c.undo();
		c.undo();
		c.undo();
		expect((c.getNode(placed.id!) as VectorInstanceNode).transform).toEqual([1, 0, 0, 1, 200, 200]);
		// Storage leaves the resolved art out.
		expect((c.toJSON().nodes[0] as VectorInstanceNode).art).toBeUndefined();
	});

	it('edits a symbol in isolation, updating every instance, and refuses cycles', () => {
		const c = make();
		const { symbolId, instanceId } = c.makeSymbol({ ids: ['a', 'b'] }) as { symbolId: string; instanceId: string };
		const other = c.placeSymbol(symbolId, { x: 300, y: 200 }).id!;
		expect(c.editSymbol(instanceId).ok).toBe(true);
		const state = c.getState();
		expect(state.symbolEdit).toMatchObject({ symbolId, instanceId });
		expect(state.document.nodes).toHaveLength(2);
		// The instance it was entered from lines up with the art: its inverse placement, and the view
		// moves so the art shows where the instance was.
		expect(state.symbolEdit!.hostTransform).toEqual([1, 0, 0, 1, -25, -10]);
		expect(state.viewport).toEqual({ x: 25, y: 10, zoom: 1 });
		c.addShape({ kind: 'rect', x: -5, y: 20, width: 10, height: 10 });
		expect(c.placeSymbol(symbolId).ok).toBe(false);
		c.exitSymbolEdit();
		expect(c.getState().symbolEdit).toBeNull();
		expect(c.getState().viewport).toEqual({ x: 0, y: 0, zoom: 1 });
		expect(vectorNodeBounds(c.getNode(other)!)).toEqual({ x: 275, y: 190, width: 50, height: 40 });
		// Undo steps back into the symbol and out of the edit.
		c.undo();
		expect(c.getState().symbolEdit).toMatchObject({ symbolId });
		expect(c.getState().document.nodes).toHaveLength(2);
	});

	it('deletes symbols only with detach while instances use them', () => {
		const c = make();
		const { symbolId } = c.makeSymbol({ ids: ['a'] }) as { symbolId: string };
		expect(c.deleteSymbol(symbolId)).toEqual({ ok: false, message: expect.stringMatching(/has 1 instance/) });
		expect(c.deleteSymbol(symbolId, { detach: true }).ok).toBe(true);
		expect(c.getSymbols()).toHaveLength(0);
		expect(c.getDocument().nodes.map((n) => n.type)).toEqual(['group', 'path']);
	});
});

describe('symbol commands through the tool registry', () => {
	const setup = () => {
		let n = 0;
		const controller = new VectorEditorController({ document: { width: 400, height: 300, nodes: [square('a', 0, 0), square('b', 30, 0)] }, createId: () => `n${++n}` });
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

	it('makes, lists, places, overrides, edits and detaches through commands', async () => {
		const { controller, run } = setup();
		const made = await run('vector.makeSymbol', { ids: ['a', 'b'], name: 'Pair' });
		expect(made.ok).toBe(true);
		const { symbolId, instanceId } = made.result;
		expect(made.result.symbol).toMatchObject({ name: 'Pair', nodes: [{ id: 'a', type: 'path' }, { id: 'b', type: 'path' }], bounds: { x: -25, y: -10, width: 50, height: 20 }, instances: [instanceId] });
		const listed = await run('vector.listSymbols');
		expect(listed.result).toMatchObject({ symbols: [{ id: symbolId }], editing: null });
		const placed = await run('vector.placeSymbol', { symbolId, transform: [1, 0, 0.5, 1, 100, 100] });
		expect(placed.ok).toBe(true);
		const opts = await run('vector.setInstanceOptions', { ids: [placed.result.id], fill: '#00ff00', hidden: ['b'] });
		expect(opts.result.instances[0]).toMatchObject({ type: 'instance', symbolId, overrides: { fill: '#00ff00', hidden: ['b'] } });
		const edit = await run('vector.editSymbol', { id: instanceId });
		expect(edit.result).toMatchObject({ symbolId, nodes: [{ id: 'a' }, { id: 'b' }] });
		expect((await run('vector.addShape', { kind: 'ellipse', x: -5, y: -5, width: 10, height: 10 })).ok).toBe(true);
		expect((await run('vector.exitSymbolEdit')).result).toEqual({ symbolId });
		expect(controller.getSymbols()[0].nodes).toHaveLength(3);
		expect((await run('vector.renameSymbol', { symbolId, name: 'Trio' })).result).toMatchObject({ name: 'Trio' });
		const detached = await run('vector.detachInstance', { ids: [placed.result.id] });
		expect(detached.result).toEqual({ ids: [placed.result.id] });
		expect(controller.getNode(placed.result.id)?.type).toBe('group');
	});

	it('fails usefully and changes nothing on bad input', async () => {
		const { controller, run } = setup();
		expect(await run('vector.placeSymbol', { symbolId: 'nope' })).toMatchObject({ ok: false, message: expect.stringMatching(/There is no symbol "nope"/) });
		const { symbolId, instanceId } = (await run('vector.makeSymbol', { ids: ['a'] })).result;
		expect(await run('vector.placeSymbol', { symbolId, x: 1, transform: [1, 0, 0, 1, 0, 0] })).toMatchObject({ ok: false, message: expect.stringMatching(/either x \/ y or transform/) });
		expect(await run('vector.setInstanceOptions', { ids: [instanceId] })).toMatchObject({ ok: false, message: expect.stringMatching(/Pass at least one/) });
		expect(await run('vector.setInstanceOptions', { ids: ['b'], fill: '#fff' })).toMatchObject({ ok: false, message: expect.stringMatching(/not a symbol instance/) });
		expect(await run('vector.setInstanceOptions', { ids: [instanceId], hidden: ['ghost'] })).toMatchObject({ ok: false, message: expect.stringMatching(/no nodes "ghost"/) });
		expect(await run('vector.deleteSymbol', { symbolId })).toMatchObject({ ok: false, message: expect.stringMatching(/has 1 instance/) });
		expect(await run('vector.exitSymbolEdit')).toMatchObject({ ok: false });
		await run('vector.editSymbol', { id: symbolId });
		expect(await run('vector.placeSymbol', { symbolId })).toMatchObject({ ok: false, message: expect.stringMatching(/contain itself/) });
		controller.exitSymbolEdit();
		expect(controller.getSymbols()[0].nodes).toHaveLength(1);
	});
});
