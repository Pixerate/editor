// Live symmetry groups. Mirror modes after ArtCraft photocraft `crates/paint/src/symmetry.rs`
// (MIT OR Apache-2.0, © ArtCraft Team and contributors); test cases re-expressed. See
// THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import {
	VectorEditorController,
	applyMatrix,
	createVectorCommands,
	getVectorOverlayRenderData,
	getVectorSceneRenderData,
	hitTestVectorNodes,
	isVectorSymmetryGroup,
	parseVectorSvg,
	rectSubpath,
	sanitizeVectorSymmetry,
	transformVectorNode,
	vectorDocumentToSvg,
	vectorNodeBounds,
	vectorSymmetryAxes,
	vectorSymmetryDrawn,
	vectorSymmetryMatrices,
	type VectorDocument,
	type VectorGroupNode,
	type VectorNode,
	type VectorPathNode,
	type VectorSymmetry
} from '../src/vector';

const rect = (id: string, x: number, y: number, w: number, extra: Partial<VectorPathNode> = {}): VectorPathNode => ({ id, type: 'path', subpaths: [rectSubpath({ x, y, width: w, height: w })], fill: '#ff0000', stroke: null, ...extra });
const doc = (...nodes: VectorNode[]): VectorDocument => ({ width: 400, height: 300, nodes });
const sym = (symmetry: VectorSymmetry, children: VectorNode[] = [rect('a', 0, 0, 10)]): VectorGroupNode => ({ id: 'g', type: 'group', symmetry, children });
const round = (p: { x: number; y: number }) => [Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6];
const box = (n: VectorNode) => {
	const b = vectorNodeBounds(n)!;
	return [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 1000) / 1000);
};

describe('symmetry matrices', () => {
	// A point (12, 25) about the centre (20, 30), as photocraft's tests reflect it.
	const p = { x: 12, y: 25 };
	const c = { x: 20, y: 30 };
	it('mirrors across vertical, horizontal and diagonal axes', () => {
		expect(round(applyMatrix(vectorSymmetryMatrices({ mode: 'vertical', center: c })[0], p))).toEqual([28, 25]);
		expect(round(applyMatrix(vectorSymmetryMatrices({ mode: 'horizontal', center: c })[0], p))).toEqual([12, 35]);
		expect(round(applyMatrix(vectorSymmetryMatrices({ mode: 'diagonal', center: c })[0], p))).toEqual([15, 22]);
	});

	it('makes four quarters for dual and turns radial copies', () => {
		expect(vectorSymmetryMatrices({ mode: 'dual', center: c }).map((m) => round(applyMatrix(m, p)))).toEqual([
			[28, 25],
			[12, 35],
			[28, 35]
		]);
		const radial = vectorSymmetryMatrices({ mode: 'radial', center: { x: 0, y: 0 }, copies: 4 });
		expect(radial.map((m) => round(applyMatrix(m, { x: 10, y: 0 })))).toEqual([
			[0, 10],
			[-10, 0],
			[0, -10]
		]);
		expect(vectorSymmetryMatrices({ mode: 'radial', center: { x: 0, y: 0 }, copies: 4, mirror: true })).toHaveLength(7);
	});

	it('turns the axis with the rotation', () => {
		// Vertical turned 90° is a horizontal mirror.
		expect(round(applyMatrix(vectorSymmetryMatrices({ mode: 'vertical', center: c, rotation: 90 })[0], p))).toEqual([12, 35]);
	});

	it('clips axes to a box, and draws radial spokes from the centre', () => {
		const [[a, b]] = vectorSymmetryAxes({ mode: 'vertical', center: { x: 50, y: 50 } }, { x: 0, y: 0, width: 100, height: 100 });
		expect([round(a), round(b)]).toEqual([
			[50, 0],
			[50, 100]
		]);
		expect(vectorSymmetryAxes({ mode: 'dual', center: { x: 50, y: 50 } }, { x: 0, y: 0, width: 100, height: 100 })).toHaveLength(2);
		const spokes = vectorSymmetryAxes({ mode: 'radial', center: { x: 50, y: 50 }, copies: 3 }, { x: 0, y: 0, width: 100, height: 100 });
		expect(spokes).toHaveLength(3);
		expect(spokes.every(([s]) => round(s).join() === '50,50')).toBe(true);
	});

	it('sanitizes untrusted settings', () => {
		expect(sanitizeVectorSymmetry({ mode: 'radial', center: { x: 1, y: 2 }, copies: 99, mirror: true, rotation: 450 })).toEqual({ mode: 'radial', center: { x: 1, y: 2 }, copies: 64, mirror: true, rotation: 90 });
		expect(sanitizeVectorSymmetry({ mode: 'spiral', center: { x: 0, y: 0 } })).toBeNull();
		expect(sanitizeVectorSymmetry({ mode: 'vertical' })).toBeNull();
	});
});

describe('symmetry groups', () => {
	it('draws the children with their copies, which hit-test and bound with the group', () => {
		const g = sym({ mode: 'vertical', center: { x: 50, y: 0 } });
		expect(isVectorSymmetryGroup(g)).toBe(true);
		const drawn = vectorSymmetryDrawn(g);
		expect(drawn.children.map((c) => c.id)).toEqual(['a', 'a~sym1']);
		expect(box(drawn.children[1])).toEqual([90, 0, 10, 10]);
		expect(box(g)).toEqual([0, 0, 100, 10]);
		expect(hitTestVectorNodes([g], { x: 95, y: 5 })?.id).toBe('g');
		const scene = getVectorSceneRenderData({ document: doc(g), viewport: { x: 0, y: 0, zoom: 1 } });
		expect((scene.nodes[0] as { children: unknown[] }).children).toHaveLength(2);
	});

	it('moves its centre and turns its axes with the group', () => {
		const g = sym({ mode: 'vertical', center: { x: 50, y: 0 } });
		const moved = transformVectorNode(g, [1, 0, 0, 1, 10, 20]) as VectorGroupNode;
		expect(moved.symmetry!.center).toEqual({ x: 60, y: 20 });
		// Scaled 2× along x: the copy stays mirrored about the moved centre.
		const scaled = transformVectorNode(g, [2, 0, 0, 1, 0, 0]) as VectorGroupNode;
		expect(box(scaled)).toEqual([0, 0, 200, 10]);
	});

	it('round-trips through SVG', () => {
		const g = sym({ mode: 'radial', center: { x: 50, y: 50 }, copies: 5, mirror: true });
		const svg = vectorDocumentToSvg(doc(g));
		const back = parseVectorSvg(svg).nodes[0] as VectorGroupNode;
		expect(back.symmetry).toEqual({ mode: 'radial', center: { x: 50, y: 50 }, copies: 5, mirror: true });
		expect(back.children.map((c) => c.id)).toEqual(['a']);
	});
});

describe('symmetry in the editor', () => {
	it('makes a symmetry group from the selection about its centre, in one undo step', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 10), rect('b', 30, 0, 10)) });
		const r = c.makeSymmetry({ mode: 'vertical' }, { ids: ['a', 'b'] });
		expect(r.ok).toBe(true);
		const g = c.getNode((r as { id: string }).id) as VectorGroupNode;
		expect(g.symmetry).toEqual({ mode: 'vertical', center: { x: 20, y: 5 } });
		expect(g.children.map((n) => n.id)).toEqual(['a', 'b']);
		c.undo();
		expect(c.getState().document.nodes.map((n) => n.id)).toEqual(['a', 'b']);
		expect(c.makeSymmetry({ mode: 'spiral' as never }).ok).toBe(false);
	});

	it('draws new shapes into an entered symmetry group, mirrored as they are drawn', () => {
		const c = new VectorEditorController({ document: doc() });
		const r = c.makeSymmetry({ mode: 'vertical' }, { ids: [] });
		const id = (r as { id: string }).id;
		// An empty group starts entered, its axis down the artboard's middle.
		expect(c.getState().symmetryTarget).toBe(id);
		c.setTool('rect');
		c.pointerDown({ x: 20, y: 20 });
		c.pointerMove({ x: 60, y: 60 });
		c.pointerUp({ x: 60, y: 60 });
		const g = c.getNode(id) as VectorGroupNode;
		expect(g.children).toHaveLength(1);
		expect(box(g)).toEqual([20, 20, 360, 40]);
		const overlay = getVectorOverlayRenderData(c.getState());
		expect(overlay.symmetry[0]).toMatchObject({ nodeId: id, drawing: true });
		expect(overlay.symmetry[0].lines[0].x1).toBe(200);
		expect(c.keyDown({ key: 'Escape' })).toBe(true);
		expect(c.getState().symmetryTarget).toBeNull();
	});

	it('changes options and releases, keeping the copies when expanding', () => {
		const c = new VectorEditorController({ document: doc(sym({ mode: 'vertical', center: { x: 50, y: 0 } })) });
		expect(c.setSymmetry({ mode: 'radial', copies: 3 }, { ids: ['g'] }).ok).toBe(true);
		expect((c.getNode('g') as VectorGroupNode).symmetry).toMatchObject({ mode: 'radial', copies: 3 });
		const r = c.releaseSymmetry({ ids: ['g'], expand: true });
		expect(r.ids).toHaveLength(2);
		const g = c.getNode('g') as VectorGroupNode;
		expect(g.symmetry).toBeUndefined();
		expect(g.children).toHaveLength(3);
		c.undo();
		expect(c.releaseSymmetry({ ids: ['g'] }).ok).toBe(true);
		expect((c.getNode('g') as VectorGroupNode).children).toHaveLength(1);
		expect(c.setSymmetry({ copies: 3 }, { ids: ['a'] }).ok).toBe(false);
	});
});

describe('symmetry commands through the tool registry', () => {
	it('makes, changes, enters and releases symmetry groups', async () => {
		const c = new VectorEditorController({ document: doc(rect('a', 0, 0, 10)) });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const run = async (id: string, params?: unknown) => {
			const r = await tools.callTool('run_command', { id, ...(params !== undefined ? { params } : {}) });
			return { isError: !!r.isError, text: r.content?.map((x: any) => x.text).join('') ?? '', ...(r.structuredContent as any) };
		};
		const made = await run('vector.makeSymmetry', { ids: ['a'], mode: 'radial', center: { x: 50, y: 50 }, copies: 6 });
		expect(made.result).toMatchObject({ symmetry: { mode: 'radial', copies: 6, center: { x: 50, y: 50 } }, children: ['a'] });
		const id = made.result.id;
		// Agents add art into the group by parentId.
		await run('vector.addShape', { kind: 'ellipse', x: 60, y: 0, width: 10, height: 10, parentId: id });
		expect((c.getNode(id) as VectorGroupNode).children).toHaveLength(2);
		expect((await run('vector.setSymmetry', { ids: [id], mirror: true })).result.groups[0].symmetry.mirror).toBe(true);
		expect((await run('vector.list')).result.nodes.find((n: any) => n.id === id).symmetry.mode).toBe('radial');
		expect((await run('vector.enterSymmetry', { id })).result).toEqual({ id });
		expect(c.getState().symmetryTarget).toBe(id);
		await run('vector.exitSymmetry');
		expect(c.getState().symmetryTarget).toBeNull();
		expect((await run('vector.releaseSymmetry', { ids: [id], expand: true })).result.ids.length).toBeGreaterThan(10);
		expect((await run('vector.setSymmetry', { ids: [id] })).text).toContain('Pass at least one of');
		expect((await run('vector.makeSymmetry', { mode: 'spiral' })).isError).toBe(true);
	});
});
