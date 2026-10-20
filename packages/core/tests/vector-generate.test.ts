// Generative prompts in the vector editor through @pixerate/editor/generation. Test cases our own.
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { pngDataUrl } from '../src/raster/png';
import type { ModelCapabilities } from '../src/generation';
import {
	VectorEditorController,
	createVectorGenerationToolProvider,
	generateVectorArt,
	parseVectorSvg,
	regenerateVectorArt,
	vectorArtModels,
	vectorDocumentToSvg,
	vectorNodeBounds,
	type VectorArtGenerator,
	type VectorGroupNode
} from '../src/vector';

const svgModel: ModelCapabilities = { id: 'svg-writer', media: 'text', name: 'SVG writer', seed: true };
const imageModel: ModelCapabilities = { id: 'pictures', media: 'image', aspectRatios: { options: ['1:1', '16:9'] }, seed: true };
const videoModel: ModelCapabilities = { id: 'clips', media: 'video' };
const models = [videoModel, svgModel, imageModel];

/** Red left half, blue right half. */
const halves = () => {
	const w = 20;
	const h = 10;
	const data = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(x < 10 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * w + x) * 4);
	return { width: w, height: h, data };
};

/** A fake host: SVG for text models (a circle per word), pixels for image models. */
const generator = (): VectorArtGenerator & { calls: { model: string; prompt?: string; seed?: number; aspectRatio?: string }[] } => {
	const calls: { model: string; prompt?: string; seed?: number; aspectRatio?: string }[] = [];
	const fn = ((request, { model }) => {
		calls.push({ model: model.id, prompt: request.prompt, seed: request.seed, aspectRatio: request.aspectRatio });
		if (model.media === 'text') {
			const words = (request.prompt ?? '').split(/\s+/).filter(Boolean);
			return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50">${words.map((_, i) => `<circle cx="${10 + i * 20}" cy="25" r="8" fill="#f97316"/>`).join('')}</svg>` };
		}
		return { png: pngDataUrl(20, 10, halves().data) };
	}) as VectorArtGenerator & { calls: typeof calls };
	fn.calls = calls;
	return fn;
};
const doc = () => ({ document: { width: 400, height: 300, nodes: [] } });

describe('vector art models', () => {
	it('are image models and text models that write SVG', () => {
		expect(vectorArtModels(models).map((m) => m.id)).toEqual(['svg-writer', 'pictures']);
	});
});

describe('generating vector art', () => {
	it('reads SVG from a text model and fits it into the box as one group with provenance', async () => {
		const c = new VectorEditorController(doc());
		const generate = generator();
		const r = await generateVectorArt(c, { prompt: 'three orange dots', x: 50, y: 50, width: 200, height: 200, idempotencyKey: 'k1' }, { models, generate });
		expect(r).toMatchObject({ ok: true, model: 'svg-writer' });
		const g = c.getNode(r.id!) as VectorGroupNode;
		expect(g.children).toHaveLength(3);
		expect(g.generation).toMatchObject({ rawPrompt: 'three orange dots', modelId: 'svg-writer' });
		// The 100 × 50 SVG fills the box's width, centred vertically.
		const b = vectorNodeBounds(g)!;
		expect(b.x).toBeGreaterThanOrEqual(50);
		expect(b.x + b.width).toBeLessThanOrEqual(250.001);
		expect(b.y).toBeGreaterThan(100);
		expect(c.getState().undoLabel).toBe('Generate Art');
		// The SVG writer takes no aspect ratio: the planner drops it.
		expect(generate.calls[0].aspectRatio).toBeUndefined();
	});

	it('traces or stylises pixels from an image model', async () => {
		const c = new VectorEditorController(doc());
		const gen = generator();
		const traced = await generateVectorArt(c, { prompt: 'flag', model: 'pictures', as: 'color', colors: 2, width: 320, height: 180, idempotencyKey: 'a' }, { models, generate: gen });
		// The box's 16:9 goes to the image model.
		expect(gen.calls[0].aspectRatio).toBe('16:9');
		expect((c.getNode(traced.id!) as VectorGroupNode).children.map((n) => (n as { fill?: unknown }).fill).sort()).toEqual(['#0000ff', '#ff0000']);
		const mosaic = await generateVectorArt(c, { prompt: 'flag', model: 'pictures', as: 'mosaic', idempotencyKey: 'b' }, { models, generate: generator() });
		expect(mosaic.ok).toBe(true);
	});

	it('returns the first result for a repeated key, and refuses the key with other input', async () => {
		const c = new VectorEditorController(doc());
		const generate = generator();
		const a = await generateVectorArt(c, { prompt: 'dot', idempotencyKey: 'same' }, { models, generate });
		const b = await generateVectorArt(c, { prompt: 'dot', idempotencyKey: 'same' }, { models, generate });
		expect(b).toEqual(a);
		expect(generate.calls).toHaveLength(1);
		const other = await generateVectorArt(c, { prompt: 'two dots', idempotencyKey: 'same' }, { models, generate });
		expect(other).toMatchObject({ ok: false, message: expect.stringContaining('already used') });
	});

	it('fails usefully, changing nothing, and forgets failed keys', async () => {
		const c = new VectorEditorController(doc());
		const broken = vi.fn(() => {
			throw new Error('quota exceeded');
		});
		expect(await generateVectorArt(c, { prompt: 'x', idempotencyKey: 'k' }, { models, generate: broken })).toMatchObject({ ok: false, message: expect.stringContaining('quota exceeded') });
		expect(await generateVectorArt(c, { prompt: 'x', model: 'clips', idempotencyKey: 'k2' }, { models, generate: generator() })).toMatchObject({ ok: false, message: expect.stringContaining('Unknown model') });
		expect(await generateVectorArt(c, { prompt: ' ', idempotencyKey: 'k3' }, { models, generate: generator() })).toMatchObject({ ok: false });
		expect(await generateVectorArt(c, { prompt: 'x', idempotencyKey: 'k4' }, { models: [], generate: generator() })).toMatchObject({ ok: false, message: expect.stringContaining('No model') });
		expect(await generateVectorArt(c, { prompt: 'x', idempotencyKey: 'k5' }, { models, generate: () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }) })).toMatchObject({ ok: false, message: expect.stringContaining('no shapes') });
		expect(c.getState().document.nodes).toHaveLength(0);
		// The failed key can be used again.
		expect((await generateVectorArt(c, { prompt: 'x', idempotencyKey: 'k' }, { models, generate: generator() })).ok).toBe(true);
	});

	it('regenerates in place with a new seed or prompt, one undo step, and round-trips provenance in SVG', async () => {
		const c = new VectorEditorController(doc());
		const generate = generator();
		const r = await generateVectorArt(c, { prompt: 'one', x: 0, y: 0, width: 100, height: 100, idempotencyKey: 'g' }, { models, generate });
		const again = await regenerateVectorArt(c, { id: r.id!, prompt: 'one two three', seed: 7, idempotencyKey: 'r' }, { models, generate });
		expect(again.ok).toBe(true);
		const g = c.getNode(r.id!) as VectorGroupNode;
		expect(g.children).toHaveLength(3);
		expect(g.generation!.rawPrompt).toBe('one two three');
		expect(generate.calls[1]).toMatchObject({ seed: 7, prompt: 'one two three' });
		c.undo();
		expect((c.getNode(r.id!) as VectorGroupNode).children).toHaveLength(1);
		expect(await regenerateVectorArt(c, { id: 'nope', idempotencyKey: 'r2' }, { models, generate })).toMatchObject({ ok: false, message: expect.stringContaining('not generated art') });
		const back = parseVectorSvg(vectorDocumentToSvg(c.toJSON())).nodes[0] as VectorGroupNode;
		expect(back.generation?.rawPrompt).toBe('one');
	});
});

describe('vector generation tools', () => {
	it('lists models, generates and regenerates through the registry, and hides writes when read-only', async () => {
		const c = new VectorEditorController(doc());
		const tools = new ToolRegistry();
		let readOnly: boolean | string = false;
		tools.register(createVectorGenerationToolProvider(c, { models, generate: generator(), readOnly: () => readOnly }));
		const list = await tools.callTool('list_vector_art_models', {});
		expect((list.structuredContent as any).models.map((m: any) => m.id)).toEqual(['svg-writer', 'pictures']);
		const made = await tools.callTool('generate_vector_art', { prompt: 'a b', idempotencyKey: 'x' });
		expect(made.isError).toBeFalsy();
		const id = (made.structuredContent as any).id;
		expect((made.structuredContent as any).ids).toHaveLength(2);
		const re = await tools.callTool('regenerate_vector_art', { id, seed: 3, idempotencyKey: 'y' });
		expect(re.isError).toBeFalsy();
		expect((await tools.callTool('generate_vector_art', { prompt: 'a' })).isError).toBe(true);
		const bad = await tools.callTool('generate_vector_art', { prompt: 'a', model: 'clips', idempotencyKey: 'z' });
		expect(bad.isError).toBe(true);
		expect(bad.content[0]).toMatchObject({ text: expect.stringContaining('Unknown model') });
		readOnly = 'The document is locked.';
		expect(tools.listTools().tools.map((t) => t.name)).toEqual(['list_vector_art_models']);
	});
});
