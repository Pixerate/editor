// Brushstrokes on vector paths, on the shared brushstroke renderer (src/paint/brushstroke.ts).
// Test cases our own.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import {
	VectorEditorController,
	createVectorCommands,
	getVectorAppearancePanel,
	getVectorSceneRenderData,
	isVectorBrushstrokeLayer,
	parseVectorSvg,
	sanitizeVectorStrokes,
	vectorBrushstrokeBrushes,
	vectorBrushstrokeImages,
	vectorDocumentToLottie,
	vectorDocumentToPdf,
	vectorDocumentToSvg,
	vectorNodePaintBox,
	type VectorPathNode,
	type VectorRenderPath,
	type VectorStrokeLayer
} from '../src/vector';

const line = (extra: Partial<VectorPathNode> = {}): VectorPathNode => ({
	id: 'a',
	type: 'path',
	subpaths: [{ closed: false, anchors: [{ x: 10, y: 50 }, { x: 110, y: 50 }] }],
	fill: null,
	stroke: '#1d4ed8',
	strokeWidth: 2,
	...extra
});
const brush = (patch: Partial<VectorStrokeLayer['brush'] & object> = {}): VectorStrokeLayer => ({ kind: 'brushstroke', paint: '#ff0000', brush: { brushId: 'marker', size: 8, ...patch } });

describe('brushstroke brushes', () => {
	it('are the dry brushes of the paint editor library', () => {
		const ids = vectorBrushstrokeBrushes().map((b) => b.id);
		expect(ids).toContain('pencil-hb');
		expect(ids).toContain('marker');
		expect(ids.some((id) => /wet|water|smudge|blender|mixer/.test(id))).toBe(false);
	});

	it('sanitize brushstroke layers and keep unknown kinds as they are', () => {
		const [ok, bad, future] = sanitizeVectorStrokes([
			{ kind: 'brushstroke', paint: '#000', brush: { brushId: 'marker', size: 9999, pressure: [2, -1, 0.5] } },
			{ kind: 'brushstroke', paint: '#000', brush: { brushId: 'nope' } },
			{ kind: 'hologram', paint: '#000' }
		]);
		expect(ok).toMatchObject({ kind: 'brushstroke', brush: { brushId: 'marker', size: 500, pressure: [1, 0, 0.5] } });
		expect(isVectorBrushstrokeLayer(bad)).toBe(false);
		expect(future.kind).toBe('hologram');
	});
});

describe('drawing brushstrokes', () => {
	it('renders an image over each subpath in the layer colour, and widens the bounds', () => {
		const n = line({ strokes: [brush()] });
		const [im] = vectorBrushstrokeImages(n, n.strokes![0]);
		expect(im.href.startsWith('data:image/png;base64,')).toBe(true);
		expect(im.x).toBeLessThan(10);
		expect(im.x + im.width).toBeGreaterThan(110);
		// Cached per path and layer.
		expect(vectorBrushstrokeImages(n, n.strokes![0])[0]).toBe(im);
		// The painted box reaches half the brush size past the line (culling uses it).
		const b = vectorNodePaintBox(n)!;
		expect(b.maxY - b.minY).toBeGreaterThanOrEqual(8 - 1e-9);
	});

	it('draws through the scene render data as a brushstroke layer', () => {
		const n = line({ strokes: [{ paint: '#000000', strokeWidth: 1 }, brush()] });
		const scene = getVectorSceneRenderData({ document: { width: 200, height: 100, nodes: [n] }, viewport: { x: 0, y: 0, zoom: 1 } });
		const p = scene.nodes[0] as VectorRenderPath;
		expect(p.layers!.map((l) => l.kind)).toEqual(['stroke', 'brushstroke']);
		expect(p.layers![1].images).toHaveLength(1);
	});

	it('exports to SVG as images that round-trip as data, to PDF as images, and leaves Lottie a note', () => {
		const doc = { width: 200, height: 100, nodes: [line({ strokes: [brush({ pressure: [0.2, 1] })] })] };
		const svg = vectorDocumentToSvg(doc);
		expect(svg).toContain('data-vector-part="brushstroke"');
		expect(svg).toContain('<image href="data:image/png;base64,');
		const back = parseVectorSvg(svg).nodes[0] as VectorPathNode;
		expect(back.strokes).toEqual([{ kind: 'brushstroke', paint: '#ff0000', brush: { brushId: 'marker', size: 8, pressure: [0.2, 1] } }]);
		const pdf = new TextDecoder('latin1').decode(vectorDocumentToPdf(doc, { compress: false }).bytes);
		expect(pdf).toContain('/Subtype /Image');
		expect(pdf).toContain('/SMask');
		expect(vectorDocumentToLottie(doc).notes.some((m) => m.includes('brushstroke'))).toBe(true);
	});
});

describe('brushstrokes in the editor', () => {
	it('adds and edits brushstrokes in one undo step each, and shows them in the appearance panel', () => {
		const c = new VectorEditorController({ document: { width: 200, height: 100, nodes: [line()] } });
		expect(c.addBrushstroke({ brushId: 'pencil-hb', size: 3 }, { ids: ['a'] }).ok).toBe(true);
		const layer = (c.getNode('a') as VectorPathNode).strokes!.at(-1)!;
		// The colour comes from the path's stroke.
		expect(layer).toMatchObject({ kind: 'brushstroke', paint: '#1d4ed8', brush: { brushId: 'pencil-hb', size: 3 } });
		c.select(['a']);
		const panel = getVectorAppearancePanel(c.getState())!;
		expect(panel.strokes.at(-1)!.brushstroke).toMatchObject({ brushId: 'pencil-hb', name: 'HB pencil', size: 3 });
		const index = (c.getNode('a') as VectorPathNode).strokes!.length - 1;
		expect(c.setBrushstroke(index, { brushId: 'charcoal-stick', size: null, pressure: [0, 1, 0] }, { ids: ['a'] }).ok).toBe(true);
		expect((c.getNode('a') as VectorPathNode).strokes![index].brush).toEqual({ brushId: 'charcoal-stick', pressure: [0, 1, 0] });
		c.undo();
		expect((c.getNode('a') as VectorPathNode).strokes![index].brush!.brushId).toBe('pencil-hb');
		expect(c.setBrushstroke(0, { size: 4 }, { ids: ['a'] })).toMatchObject({ ok: false, message: expect.stringContaining('no brushstroke') });
		expect(c.addBrushstroke({ brushId: 'watercolor-wash' }, { ids: ['a'] })).toMatchObject({ ok: false, message: expect.stringContaining('Unknown brush') });
	});
});

describe('brushstroke commands through the tool registry', () => {
	it('lists brushes, adds and edits a brushstroke, and refuses bad input', async () => {
		const c = new VectorEditorController({ document: { width: 200, height: 100, nodes: [line()] } });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const run = async (id: string, params?: unknown) => {
			const r = await tools.callTool('run_command', { id, ...(params !== undefined ? { params } : {}) });
			return { isError: !!r.isError, text: r.content?.map((x: any) => x.text).join('') ?? '', ...(r.structuredContent as any) };
		};
		const brushes = (await run('vector.listBrushes')).result.brushes;
		expect(brushes.find((b: any) => b.id === 'marker')).toMatchObject({ name: expect.any(String), category: expect.any(String), size: expect.any(Number) });
		const added = await run('vector.addBrushstroke', { ids: ['a'], brushId: 'ink-pen', size: 4, pressure: [0.1, 1, 0.1], color: '#000000' });
		expect(added.result.paths[0].strokes.at(-1)).toMatchObject({ kind: 'brushstroke', paint: '#000000', brush: { brushId: 'ink-pen', size: 4 } });
		const index = added.result.paths[0].strokes.length - 1;
		expect((await run('vector.setBrushstroke', { id: 'a', index, opacity: 0.5 })).result.strokes[index].opacity).toBe(0.5);
		expect((await run('vector.setBrushstroke', { id: 'a', index })).text).toContain('Pass at least one of');
		expect((await run('vector.setBrushstroke', { id: 'a', index: 9, size: 2 })).text).toContain('out of range');
		expect((await run('vector.addBrushstroke', { ids: ['a'], brushId: 'nope' })).text).toContain('Unknown brush');
	});
});
