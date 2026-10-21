/**
 * Generative prompts in the vector editor, through `@pixerate/editor/generation`: a prompt is
 * planned against a model's capabilities (`planGenerationRequest`), sent to the host's generator,
 * and what comes back becomes editable vector art in one group:
 *
 * - SVG markup (from a text model that writes SVG, or an image model with vector output) is read
 *   with the SVG importer;
 * - pixels or a PNG (an image model) are traced (`color` or `threshold`, Image Trace) or stylised
 *   (`mosaic`, `halftone`, `lowPoly`, `hatch`).
 *
 * The art is fitted into a box on the artboard and the group keeps the generation's provenance
 * (`createProvenance`: prompt, model, planned request and adjustments), so it can be regenerated
 * with a new seed or prompt in place. Requests cost money: every call takes an idempotency key,
 * and a retry with the same key and input returns the first result instead of generating again.
 */
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { GenerationRequest, ModelCapabilities } from '../generation/capabilities.js';
import { planGenerationRequest, type GenerationPlan } from '../generation/plan.js';
import { createProvenance, type GenerationProvenance } from '../generation/provenance.js';
import { stableStringify } from '../generation/hash.js';
import { decodePng, isPng, parseDataUrl } from '../raster/png.js';
import type { VectorEditorController } from './controller.js';
import { transformVectorNode, unionBounds, vectorNodeBounds } from './geometry.js';
import { stylizeVectorImage, VECTOR_STYLIZE_STYLES, type VectorStylizeStyle } from './stylize.js';
import { parseVectorSvg } from './svg.js';
import { traceVectorImage, VECTOR_TRACE_MAX_PIXELS, type VectorTracePixels } from './trace.js';
import type { VectorBounds, VectorGroupNode, VectorNode } from './types.js';

/** A generative model's capabilities (`@pixerate/editor/generation`), re-exported for the bindings. */
export type VectorArtModel = ModelCapabilities;

/** What a generator returns: SVG markup, RGBA pixels, or a PNG data URL. */
export type VectorGeneratedArt = { svg: string } | { image: VectorTracePixels } | { png: string };

/** The host's generator: sends a planned request to its model and returns the art. */
export type VectorArtGenerator = (
	request: GenerationRequest,
	context: { model: ModelCapabilities; plan: GenerationPlan; idempotencyKey: string; signal?: AbortSignal }
) => VectorGeneratedArt | Promise<VectorGeneratedArt>;

/** How pixels become vectors: traced in colour or one colour, or stylised. */
export type VectorGeneratedImageAs = 'color' | 'threshold' | VectorStylizeStyle;
export const VECTOR_GENERATED_IMAGE_AS: readonly VectorGeneratedImageAs[] = ['color', 'threshold', ...VECTOR_STYLIZE_STYLES];

/** Models that can make vector art: image models (traced or stylised) and text models that write SVG. */
export function vectorArtModels(models: readonly ModelCapabilities[]): ModelCapabilities[] {
	return models.filter((m) => m.media === 'image' || m.media === 'text');
}

export interface VectorGenerateInput {
	prompt: string;
	/** Model id (default: the first vector-capable model). */
	model?: string;
	negativePrompt?: string;
	seed?: number;
	/** E.g. "1:1" (default: from the box, snapped to what the model offers). */
	aspectRatio?: string;
	/** The box the art is fitted into (document units; default: a square in the artboard's middle). */
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	/** How pixels become vectors (default `color`). */
	as?: VectorGeneratedImageAs;
	/** Palette size for traced or stylised colour (default 8). */
	colors?: number;
	name?: string;
	/** Required: a retry with the same key and input returns the first result without generating again. */
	idempotencyKey: string;
	signal?: AbortSignal;
}

export interface VectorGenerateResult {
	ok: boolean;
	message?: string;
	/** The group holding the art. */
	id?: string;
	/** Its children. */
	ids?: string[];
	/** What the planner changed to fit the model (snapped or dropped values). */
	adjustments?: GenerationPlan['adjustments'];
	model?: string;
}

export interface VectorGenerationOptions {
	/** Models, or a function returning the current models. */
	models: readonly ModelCapabilities[] | (() => readonly ModelCapabilities[]);
	generate: VectorArtGenerator;
}

const listModels = (o: VectorGenerationOptions) => vectorArtModels(typeof o.models === 'function' ? o.models() : o.models);

/** The art as nodes in its own units with its natural box, or an error. */
function artNodes(art: VectorGeneratedArt, as: VectorGeneratedImageAs, colors: number): { nodes: VectorNode[]; box: VectorBounds } | string {
	if (!art || typeof art !== 'object') return 'The generator returned nothing usable (expected { svg }, { image } or { png }).';
	if ('svg' in art && typeof art.svg === 'string') {
		let doc;
		try {
			doc = parseVectorSvg(art.svg);
		} catch (e) {
			return `The generated SVG could not be read: ${(e as Error).message}`;
		}
		if (!doc.nodes.length) return 'The generated SVG has no shapes the editor can read.';
		const drawn = unionBounds(doc.nodes.map((n) => vectorNodeBounds(n)));
		const box = doc.width > 0 && doc.height > 0 ? { x: 0, y: 0, width: doc.width, height: doc.height } : drawn;
		return box ? { nodes: doc.nodes, box } : 'The generated SVG is empty.';
	}
	let pixels: VectorTracePixels | null = null;
	if ('image' in art) pixels = art.image;
	else if ('png' in art && typeof art.png === 'string') {
		const parsed = parseDataUrl(art.png);
		if (!parsed || !isPng(parsed.bytes)) return 'The generated image is not a PNG data URL.';
		try {
			pixels = decodePng(parsed.bytes, { maxPixels: VECTOR_TRACE_MAX_PIXELS });
		} catch (e) {
			return `The generated PNG could not be read: ${(e as Error).message}`;
		}
	}
	if (!pixels) return 'The generator returned nothing usable (expected { svg }, { image } or { png }).';
	let nodes: VectorNode[];
	try {
		nodes = as === 'color' || as === 'threshold' ? traceVectorImage(pixels, { mode: as, colors }) : stylizeVectorImage(pixels, as, { colors });
	} catch (e) {
		return (e as Error).message;
	}
	if (!nodes.length) return 'The generated image had nothing to trace (try another `as`).';
	return { nodes, box: { x: 0, y: 0, width: pixels.width, height: pixels.height } };
}

/** `nodes` in a box of their own units scaled to fit `target`, centred. */
function fitted(nodes: VectorNode[], box: VectorBounds, target: VectorBounds): VectorNode[] {
	const k = Math.min(target.width / (box.width || 1), target.height / (box.height || 1));
	const dx = target.x + (target.width - box.width * k) / 2 - box.x * k;
	const dy = target.y + (target.height - box.height * k) / 2 - box.y * k;
	return nodes.map((n) => transformVectorNode(n, [k, 0, 0, k, dx, dy]));
}

/** "w:h" reduced, for a box. */
function ratioOf(w: number, h: number): string {
	const g = (a: number, b: number): number => (b < 1 ? a : g(b, a % b));
	const a = Math.max(1, Math.round(w));
	const b = Math.max(1, Math.round(h));
	const d = g(a, b);
	return `${a / d}:${b / d}`;
}

/** Plans and sends one request; the art as fitted nodes, or an error. */
async function produce(
	request: GenerationRequest,
	model: ModelCapabilities,
	target: VectorBounds,
	as: VectorGeneratedImageAs,
	colors: number,
	options: VectorGenerationOptions,
	idempotencyKey: string,
	signal?: AbortSignal
): Promise<{ nodes: VectorNode[]; plan: GenerationPlan } | string> {
	const plan = planGenerationRequest(request, model, { strategy: 'nearest' });
	if (!plan.ok) return `The request cannot be sent to "${model.id}": ${plan.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`;
	let art: VectorGeneratedArt;
	try {
		art = await options.generate(plan.request, { model, plan, idempotencyKey, signal });
	} catch (e) {
		return `The generator failed: ${(e as Error).message}`;
	}
	const made = artNodes(art, as, colors);
	if (typeof made === 'string') return made;
	return { nodes: fitted(made.nodes, made.box, target), plan };
}

const inFlight = new WeakMap<VectorEditorController, Map<string, { args: string; result: Promise<VectorGenerateResult> }>>();

/** Runs `fn` once per idempotency key and input; a different input under a used key is refused. */
function once(controller: VectorEditorController, key: string, args: unknown, fn: () => Promise<VectorGenerateResult>): Promise<VectorGenerateResult> {
	let map = inFlight.get(controller);
	if (!map) inFlight.set(controller, (map = new Map()));
	const sig = stableStringify(args);
	const hit = map.get(key);
	if (hit) return hit.args === sig ? hit.result : Promise.resolve({ ok: false, message: `idempotencyKey "${key}" was already used with different input: pass a new key for a new request.` });
	const result = fn().then((r) => {
		// Failures forget their key so they can be retried.
		if (!r.ok) map!.delete(key);
		return r;
	});
	map.set(key, { args: sig, result });
	if (map.size > 500) map.delete(map.keys().next().value!);
	return result;
}

/**
 * Generates vector art from a prompt and adds it as one group (one undo step), fitted into the
 * box (default: a square in the artboard's middle), holding the generation's provenance.
 */
export function generateVectorArt(controller: VectorEditorController, input: VectorGenerateInput, options: VectorGenerationOptions): Promise<VectorGenerateResult> {
	const { signal, ...args } = input;
	return once(controller, input.idempotencyKey, args, async () => {
		if (typeof input.prompt !== 'string' || !input.prompt.trim()) return { ok: false, message: 'prompt must be some text describing the art.' };
		if (!input.idempotencyKey) return { ok: false, message: 'idempotencyKey is required (any unique string per request).' };
		const models = listModels(options);
		if (!models.length) return { ok: false, message: 'No model can make vector art (an image model, or a text model that writes SVG).' };
		const model = input.model ? models.find((m) => m.id === input.model) : models[0];
		if (!model) return { ok: false, message: `Unknown model "${input.model}": use one of ${models.map((m) => m.id).join(', ')}.` };
		const as = input.as ?? 'color';
		if (!VECTOR_GENERATED_IMAGE_AS.includes(as)) return { ok: false, message: `as must be one of ${VECTOR_GENERATED_IMAGE_AS.join(', ')}.` };
		const doc = controller.getState().document;
		const side = Math.min(doc.width, doc.height) * 0.6;
		const target: VectorBounds = {
			x: input.x ?? (doc.width - (input.width ?? side)) / 2,
			y: input.y ?? (doc.height - (input.height ?? side)) / 2,
			width: input.width ?? side,
			height: input.height ?? input.width ?? side
		};
		if (!(target.width > 0 && target.height > 0)) return { ok: false, message: 'width and height must be above 0.' };
		const request: GenerationRequest = {
			prompt: input.prompt,
			mode: 'generate',
			aspectRatio: input.aspectRatio ?? ratioOf(target.width, target.height),
			...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
			...(input.seed !== undefined ? { seed: input.seed } : {})
		};
		const made = await produce(request, model, target, as, input.colors ?? 8, options, input.idempotencyKey, signal);
		if (typeof made === 'string') return { ok: false, message: made };
		const provenance = createProvenance({ rawPrompt: input.prompt, model, plan: made.plan, meta: { as, colors: input.colors ?? 8, box: target } });
		const group: VectorGroupNode = { id: 'generated', type: 'group', name: input.name ?? input.prompt.slice(0, 40), generation: provenance, children: made.nodes };
		const id = controller.addNode(group, { label: 'Generate Art' });
		const added = controller.getNode(id) as VectorGroupNode;
		return { ok: true, id, ids: added.children.map((c) => c.id), adjustments: made.plan.adjustments, model: model.id };
	});
}

/**
 * Generates a group's art again from its provenance, with a new `seed` (default: a random one)
 * and optionally a new `prompt`, replacing its children in place (one undo step).
 */
export function regenerateVectorArt(
	controller: VectorEditorController,
	input: { id: string; prompt?: string; seed?: number; idempotencyKey: string; signal?: AbortSignal },
	options: VectorGenerationOptions
): Promise<VectorGenerateResult> {
	const { signal, ...args } = input;
	return once(controller, input.idempotencyKey, args, async () => {
		const node = controller.getNode(input.id);
		const prov = node?.type === 'group' ? (node.generation as GenerationProvenance | undefined) : undefined;
		if (!node || node.type !== 'group' || !prov) return { ok: false, message: `"${input.id}" is not generated art (generate some with generate_vector_art).` };
		if (node.locked) return { ok: false, message: `"${input.id}" is locked; unlock it first.` };
		const models = listModels(options);
		const model = models.find((m) => m.id === prov.modelId);
		if (!model) return { ok: false, message: `The model "${prov.modelId}" it was made with is not available.` };
		const meta = (prov.meta ?? {}) as { as?: VectorGeneratedImageAs; colors?: number; box?: VectorBounds };
		const box = vectorNodeBounds(node) ?? meta.box ?? { x: 0, y: 0, width: 100, height: 100 };
		const prompt = input.prompt ?? prov.rawPrompt;
		const request: GenerationRequest = { ...prov.request, prompt, seed: input.seed ?? Math.floor(Math.random() * 2 ** 31) };
		const made = await produce(request, model, box, meta.as ?? 'color', meta.colors ?? 8, options, input.idempotencyKey, signal);
		if (typeof made === 'string') return { ok: false, message: made };
		const provenance = createProvenance({ rawPrompt: prompt, model, plan: made.plan, meta: { ...meta, box } });
		const r = controller.replaceGeneratedArt(input.id, made.nodes, provenance);
		if (!r.ok) return { ok: false, message: r.message };
		const now = controller.getNode(input.id) as VectorGroupNode;
		return { ok: true, id: input.id, ids: now.children.map((c) => c.id), adjustments: made.plan.adjustments, model: model.id };
	});
}

export interface VectorGenerationToolProviderOptions extends VectorGenerationOptions {
	/** Provider id (default `vector-generation`). */
	id?: string;
	namespace?: string;
	/** The document cannot be edited: write tools are hidden. A string is the reason. */
	readOnly?: boolean | string | (() => boolean | string);
}

const IMAGE_AS_DESCRIPTION = 'How an image result becomes vectors: color (traced, a path per colour; default), threshold (one colour), or stylised as mosaic, halftone, lowPoly or hatch. Ignored for SVG results.';

/**
 * Agent tools for generative prompts in the vector editor: `list_vector_art_models` (read-only),
 * `generate_vector_art` and `regenerate_vector_art` (both cost money: an idempotency key is
 * required; hidden while the document is read-only).
 */
export function createVectorGenerationToolProvider(controller: VectorEditorController, options: VectorGenerationToolProviderOptions): AgentToolProvider {
	const readOnly = () => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		return r ?? false;
	};
	const result = (r: VectorGenerateResult) => {
		if (!r.ok) return { isError: true, content: [{ type: 'text', text: r.message ?? 'Generation failed.' }] };
		return { id: r.id, ids: r.ids, model: r.model, adjustments: r.adjustments };
	};
	const list: AgentTool = {
		name: 'list_vector_art_models',
		title: 'List vector art models',
		description: 'Lists the models generate_vector_art can use: { models: [{ id, name, media, aspectRatios, seed }] }. Image models give pictures that are traced or stylised; text models write SVG.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'List vector art models', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: () => ({
			models: listModels(options).map((m) => ({ id: m.id, name: m.name ?? m.id, media: m.media, ...(m.aspectRatios ? { aspectRatios: m.aspectRatios } : {}), seed: !!m.seed }))
		})
	};
	const generate: AgentTool = {
		name: 'generate_vector_art',
		title: 'Generate vector art',
		description:
			'Generates vector art from a text prompt with a model (list_vector_art_models) and adds it as one editable group fitted into a box on the artboard (one undo step). The request is adjusted to what the model supports. Costs money: pass a unique idempotencyKey; a retry with the same key and arguments returns the first result. Returns { id (the group), ids (its paths), model, adjustments }.',
		inputSchema: {
			type: 'object',
			properties: {
				prompt: { type: 'string', minLength: 1, description: 'What to draw, e.g. "a flat-style rocket, three colours".' },
				model: { type: 'string', description: 'Model id from list_vector_art_models (default: the first).' },
				negativePrompt: { type: 'string', description: 'What to avoid, for models that support it.' },
				seed: { type: 'integer', description: 'Seed for repeatable results, for models that support it.' },
				x: { type: 'number', description: 'Left of the box, document units (default: centred).' },
				y: { type: 'number', description: 'Top of the box, document units (default: centred).' },
				width: { type: 'number', exclusiveMinimum: 0, description: 'Box width, document units (default 60% of the artboard\'s smaller side).' },
				height: { type: 'number', exclusiveMinimum: 0, description: 'Box height, document units (default: the width). The art keeps its proportions inside.' },
				as: { type: 'string', enum: [...VECTOR_GENERATED_IMAGE_AS], description: IMAGE_AS_DESCRIPTION },
				colors: { type: 'integer', minimum: 2, maximum: 32, description: 'Palette size when tracing or stylising in colour (default 8).' },
				name: { type: 'string', description: 'Group name (default: the start of the prompt).' },
				idempotencyKey: { type: 'string', minLength: 1, description: 'A unique string per request; reuse it only to retry the same request.' }
			},
			required: ['prompt', 'idempotencyKey'],
			additionalProperties: false
		},
		annotations: { title: 'Generate vector art', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		handler: async (args, ctx) => result(await generateVectorArt(controller, { ...(args as VectorGenerateInput), signal: ctx.signal }, options))
	};
	const regenerate: AgentTool = {
		name: 'regenerate_vector_art',
		title: 'Regenerate vector art',
		description:
			'Generates a generated group\'s art again (same model and settings, from its provenance) with a new seed (default random) and optionally a new prompt, replacing its paths in place (one undo step). Costs money: pass a unique idempotencyKey. Returns { id, ids, model, adjustments }.',
		inputSchema: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'A group generate_vector_art made.' },
				prompt: { type: 'string', minLength: 1, description: 'A new prompt (default: the one it was made with).' },
				seed: { type: 'integer', description: 'Seed (default: a random one).' },
				idempotencyKey: { type: 'string', minLength: 1, description: 'A unique string per request; reuse it only to retry the same request.' }
			},
			required: ['id', 'idempotencyKey'],
			additionalProperties: false
		},
		annotations: { title: 'Regenerate vector art', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		handler: async (args, ctx) => result(await regenerateVectorArt(controller, { ...(args as { id: string; idempotencyKey: string }), signal: ctx.signal }, options))
	};
	return {
		id: options.id ?? 'vector-generation',
		...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
		title: 'Vector generation',
		description: 'Generate vector art from a prompt with a configured model, and regenerate it.',
		skill: 'pixerate-vector',
		tools: () => (readOnly() ? [list] : [list, generate, regenerate]),
		// The write tools come and go with a read-only state that can change.
		...(typeof options.readOnly === 'function' ? { subscribe: (notify: () => void) => controller.subscribe(() => notify()) } : {})
	};
}
