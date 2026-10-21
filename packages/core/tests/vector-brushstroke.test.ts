// Brushstrokes on vector paths, on the shared brushstroke renderer (src/paint/brushstroke.ts).
// Test cases our own.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import { brushstrokeDataUrl, renderBrushstroke } from '../src/paint/brushstroke';
import {
	VECTOR_BRUSHSTROKE_SCALE,
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

describe('brush character (seed and paper)', () => {
	const href = (layer: VectorStrokeLayer) => {
		const n = line({ strokes: [layer] });
		return vectorBrushstrokeImages(n, n.strokes![0])[0].href;
	};
	const charcoal = (patch: Partial<VectorStrokeLayer['brush'] & object> = {}): VectorStrokeLayer => ({ kind: 'brushstroke', paint: '#000000', brush: { brushId: 'charcoal-stick', size: 10, ...patch } });

	it('leaves a layer without a seed exactly as it rendered before (plain dabs, paper ignored)', () => {
		// The pre-character render: the shared renderer without a `character` option.
		const preset = vectorBrushstrokeBrushes().find((b) => b.id === 'charcoal-stick')!;
		const plain = renderBrushstroke({ points: [{ x: 10, y: 50 }, { x: 110, y: 50 }] }, { ...preset, tip: { ...preset.tip, size: 10 } }, { scale: VECTOR_BRUSHSTROKE_SCALE, color: [0, 0, 0, 255], maxPixels: 2048 * 2048 });
		expect(href(charcoal())).toBe(brushstrokeDataUrl(plain));
		expect(href(charcoal({ paper: { pattern: 'rough', depth: 1 } }))).toBe(brushstrokeDataUrl(plain));
		expect(href(charcoal({ paper: null }))).toBe(brushstrokeDataUrl(plain));
	});

	it('renders a seeded layer with character, the same for the same seed', () => {
		const a = href(charcoal({ seed: 7 }));
		expect(a).not.toBe(href(charcoal()));
		expect(href(charcoal({ seed: 7 }))).toBe(a);
		// Direct from the shared renderer with the same character: the bytes match.
		const preset = vectorBrushstrokeBrushes().find((b) => b.id === 'charcoal-stick')!;
		const direct = renderBrushstroke({ points: [{ x: 10, y: 50 }, { x: 110, y: 50 }] }, { ...preset, tip: { ...preset.tip, size: 10 } }, { scale: VECTOR_BRUSHSTROKE_SCALE, color: [0, 0, 0, 255], maxPixels: 2048 * 2048, character: { seed: 7, origin: { x: 0, y: 0 }, unit: 1 } });
		expect(a).toBe(brushstrokeDataUrl(direct));
		expect(href(charcoal({ seed: 8 }))).not.toBe(a);
	});

	it('turns the grain off with paper: null and changes it with the paper settings', () => {
		const grained = href(charcoal({ seed: 7 }));
		const bare = href(charcoal({ seed: 7, paper: null }));
		expect(bare).not.toBe(grained);
		expect(href(charcoal({ seed: 7, paper: { pattern: 'canvas', scale: 2 } }))).not.toBe(grained);
	});

	it('sanitizes the seed and paper, and round-trips them through SVG', () => {
		const [layer] = sanitizeVectorStrokes([{ kind: 'brushstroke', paint: '#000', brush: { brushId: 'marker', seed: 4.6, paper: { pattern: 'nope', seed: -3, scale: 99, depth: 2, extra: 1 } } }]);
		expect(layer.brush).toEqual({ brushId: 'marker', seed: 5, paper: { seed: 0, scale: 8, depth: 1 } });
		expect(sanitizeVectorStrokes([{ kind: 'brushstroke', paint: '#000', brush: { brushId: 'marker', seed: 1, paper: null } }])[0].brush).toEqual({ brushId: 'marker', seed: 1, paper: null });
		expect(sanitizeVectorStrokes([{ kind: 'brushstroke', paint: '#000', brush: { brushId: 'marker', seed: 1, paper: {} } }])[0].brush).toEqual({ brushId: 'marker', seed: 1 });
		const strokes = [charcoal({ seed: 3, paper: { pattern: 'laid', depth: 0.8 } }), charcoal({ seed: 4, paper: null })];
		const back = parseVectorSvg(vectorDocumentToSvg({ width: 200, height: 100, nodes: [line({ strokes })] })).nodes[0] as VectorPathNode;
		expect(back.strokes).toEqual(strokes);
	});

	it('adds and edits the seed and paper in the controller, shows grain in the panel, and refuses bad values', () => {
		const c = new VectorEditorController({ document: { width: 200, height: 100, nodes: [line()] } });
		expect(c.addBrushstroke({ brushId: 'charcoal-stick', seed: 11 }, { ids: ['a'] }).ok).toBe(true);
		const index = (c.getNode('a') as VectorPathNode).strokes!.length - 1;
		const brushOf = () => (c.getNode('a') as VectorPathNode).strokes![index].brush;
		c.select(['a']);
		const grain = () => getVectorAppearancePanel(c.getState())!.strokes.find((l) => l.index === index)!.brushstroke!;
		expect(grain()).toMatchObject({ seed: 11, grain: true });
		expect(c.setBrushstroke(index, { paper: null }, { ids: ['a'] }).ok).toBe(true);
		expect(brushOf()).toEqual({ brushId: 'charcoal-stick', seed: 11, paper: null });
		expect(grain().grain).toBe(false);
		expect(c.setBrushstroke(index, { paper: {} }, { ids: ['a'] }).ok).toBe(true);
		expect(brushOf()).toEqual({ brushId: 'charcoal-stick', seed: 11 });
		expect(c.setBrushstroke(index, { seed: null }, { ids: ['a'] }).ok).toBe(true);
		expect(brushOf()).toEqual({ brushId: 'charcoal-stick' });
		expect(grain()).toMatchObject({ grain: false });
		expect(grain().seed).toBeUndefined();
		expect(c.setBrushstroke(index, { seed: 1.5 }, { ids: ['a'] })).toMatchObject({ ok: false, message: expect.stringContaining('seed must be an integer') });
		expect(c.addBrushstroke({ brushId: 'marker', seed: 1, paper: { pattern: 'tissue' as never } }, { ids: ['a'] })).toMatchObject({ ok: false, message: expect.stringContaining('Unknown paper pattern') });
		expect(c.addBrushstroke({ brushId: 'marker', seed: 1, paper: { depth: 3 } }, { ids: ['a'] })).toMatchObject({ ok: false, message: expect.stringContaining('paper.depth') });
		expect(brushOf()).toEqual({ brushId: 'charcoal-stick' });
	});

	it('takes the seed and paper through vector.addBrushstroke and vector.setBrushstroke', async () => {
		const c = new VectorEditorController({ document: { width: 200, height: 100, nodes: [line()] } });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const run = async (id: string, params?: unknown) => {
			const r = await tools.callTool('run_command', { id, ...(params !== undefined ? { params } : {}) });
			return { isError: !!r.isError, text: r.content?.map((x: any) => x.text).join('') ?? '', ...(r.structuredContent as any) };
		};
		const added = await run('vector.addBrushstroke', { ids: ['a'], brushId: 'charcoal-stick', seed: 42, paper: { pattern: 'rough', scale: 1.5, depth: 0.7 } });
		expect(added.isError).toBe(false);
		const index = added.result.paths[0].strokes.length - 1;
		expect(added.result.paths[0].strokes[index].brush).toEqual({ brushId: 'charcoal-stick', seed: 42, paper: { pattern: 'rough', scale: 1.5, depth: 0.7 } });
		expect((await run('vector.setBrushstroke', { id: 'a', index, paper: null })).result.strokes[index].brush).toEqual({ brushId: 'charcoal-stick', seed: 42, paper: null });
		expect((await run('vector.setBrushstroke', { id: 'a', index, seed: 43, paper: { pattern: 'linen' } })).result.strokes[index].brush).toEqual({ brushId: 'charcoal-stick', seed: 43, paper: { pattern: 'linen' } });
		expect((await run('vector.setBrushstroke', { id: 'a', index, seed: null })).result.strokes[index].brush).toEqual({ brushId: 'charcoal-stick', paper: { pattern: 'linen' } });
		const badSeed = await run('vector.addBrushstroke', { ids: ['a'], brushId: 'marker', seed: -1 });
		expect(badSeed.isError).toBe(true);
		expect(badSeed.text).toContain('seed');
		const badPaper = await run('vector.setBrushstroke', { id: 'a', index, paper: { pattern: 'tissue' } });
		expect(badPaper.isError).toBe(true);
		expect(badPaper.text).toContain('pattern');
		expect((await run('vector.setBrushstroke', { id: 'a', index, paper: { grit: 2 } })).isError).toBe(true);
		expect((c.getNode('a') as VectorPathNode).strokes![index].brush).toEqual({ brushId: 'charcoal-stick', paper: { pattern: 'linen' } });
	});
});
