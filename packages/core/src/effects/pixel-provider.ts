/**
 * `createPixelEffectProvider`: effects written in pixel expressions (`pixel-language.ts`). Its
 * catalog is a few starting points (`pixel.blank`, `pixel.rings`, `pixel.clouds`); any of them
 * opens for authoring with source editing, and a document saved from a session renders anywhere,
 * with no provider of the author's, because the source travels with it (`pixelDocumentRenderer`).
 */

import { HistoryManager } from '../history/HistoryManager.js';
import { createEffectAuthoringSession, type AuthoringSourceBackend, type GenericAuthoringOptions } from './authoring-session.js';
import type { EffectAuthoringDocument, EffectAuthoringIssue, EffectAuthoringSource } from './authoring.js';
import { EffectDisposedError, UnknownEffectError } from './errors.js';
import { createEffectPixels, resolveEffectValues, searchEffectSummaries } from './helpers.js';
import { compilePixelSource, createPixelEvaluator, PIXEL_DEFAULT_LIMITS, PIXEL_LANGUAGE, pixelControlSchema, type PixelLimits, type PixelProgram } from './pixel-language.js';
import type { EffectDescription, EffectPixels, EffectProvider, EffectProviderCapabilities, EffectRenderer, EffectRendererOptions, EffectRenderRequest, EffectSearchOptions, EffectSummary, EffectValues } from './types.js';

export const PIXEL_PROVIDER_ID = 'pixel';

/** The starting points: id → name, what it is, and its source. */
export const PIXEL_TEMPLATES: readonly { id: string; name: string; description: string; loop: boolean; duration?: number; source: string }[] = [
	{
		id: 'pixel.blank',
		name: 'Blank',
		description: 'A starting point: a soft gradient between two colours, top to bottom.',
		loop: false,
		source: ['control top: color = #1d2b53 // Colour at the top.', 'control bottom: color = #ff77a8 // Colour at the bottom.', 'out = mix(top, bottom, uv.y)', ''].join('\n')
	},
	{
		id: 'pixel.rings',
		name: 'Rings',
		description: 'Rings that spread from a point, over a transparent background.',
		loop: true,
		duration: 2000,
		source: [
			'control ink: color = #1d2b53 // Colour of the rings.',
			'control count: number = 12 range 1 64 // How many rings across the picture.',
			'control center: vec2 = vec2(0.5, 0.5) range 0 1 // Where they spread from (0..1).',
			'let d = distance(uv, center)',
			'let wave = 0.5 + 0.5 * sin((d * count - time / 2) * TAU)',
			'out = vec4(ink, smoothstep(0.4, 0.6, wave))',
			''
		].join('\n')
	},
	{
		id: 'pixel.clouds',
		name: 'Clouds',
		description: 'Soft value-noise clouds drifting sideways.',
		loop: false,
		duration: 4000,
		source: [
			'control sky: color = #3a6ea5 // Colour behind the clouds.',
			'control cloud: color = #f4f4f4 // Colour of the clouds.',
			'control scale: number = 6 range 1 32 // Cloud size: cells across the picture.',
			'control drift: number = 0.25 range 0 4 // Cells a second they move.',
			'let p = uv * scale + vec2(time * drift, 0)',
			'let n = noise(p) * 0.6 + noise(p * 2.1) * 0.3 + noise(p * 4.3) * 0.1',
			'out = mix(sky, cloud, smoothstep(0.45, 0.75, n))',
			''
		].join('\n')
	}
];

const CAPABILITIES: EffectProviderCapabilities = {
	supportsWorker: false,
	supportsFloat: false,
	supportsMask: false,
	supportsHostImages: false,
	supportsVector: false,
	supportsAuthoring: true,
	maxSize: 8192
};

/** The issues of a source as one sentence (errors only), e.g. for a thrown error. */
export function pixelIssueText(issues: readonly EffectAuthoringIssue[]): string {
	return issues
		.filter((i) => i.severity === 'error')
		.map((i) => (i.line ? `line ${i.line}: ${i.message}` : i.message))
		.join('; ');
}

/** The description of a compiled program. */
export function pixelDescription(program: PixelProgram, meta: { id: string; name: string; description?: string; loop?: boolean; duration?: number }): EffectDescription {
	const properties: Record<string, Record<string, unknown>> = {};
	const defaults: Record<string, EffectValues[string]> = {};
	for (const c of program.controls) {
		properties[c.name] = pixelControlSchema(c);
		defaults[c.name] = Array.isArray(c.default) ? [...c.default] : c.default;
	}
	return {
		id: meta.id,
		name: meta.name,
		kind: 'shader',
		category: 'authored',
		uses: ['generator'],
		description: meta.description ?? 'An effect written in pixel expressions.',
		tags: ['authored', 'pixel'],
		transparent: program.out.size === 4,
		loop: meta.loop ?? false,
		...(meta.duration ? { duration: meta.duration } : {}),
		controls: { type: 'object', properties, additionalProperties: false } as EffectDescription['controls'],
		defaults,
		presets: [],
		inputs: []
	};
}

/** A CPU renderer for a compiled program (it has `renderSync`). */
export function createPixelRenderer(program: PixelProgram, description: EffectDescription, options: EffectRendererOptions): EffectRenderer {
	const evaluator = createPixelEvaluator(program);
	const { width, height } = options;
	let disposed = false;
	const renderSync = (req: EffectRenderRequest): EffectPixels => {
		if (disposed) throw new EffectDisposedError(description.id);
		const values = resolveEffectValues(description, req.values ?? {});
		const out = createEffectPixels(width, height);
		evaluator.render(width, height, req.time ?? 0, values, out.data);
		return out;
	};
	return {
		effectId: description.id,
		width,
		height,
		depth: 8,
		render: async (req) => renderSync(req),
		renderSync,
		dispose: () => {
			disposed = true;
		}
	};
}

/** Compiles a pixel source into a description (null with issues when it doesn't compile). */
export function describePixelSource(source: string, meta: { id: string; name: string; description?: string; loop?: boolean; duration?: number }, limits?: PixelLimits): { description: EffectDescription | null; program: PixelProgram | null; issues: readonly EffectAuthoringIssue[] } {
	const r = compilePixelSource(source, limits);
	if (!r.ok) return { description: null, program: null, issues: r.issues };
	return { description: pixelDescription(r.program, meta), program: r.program, issues: r.issues };
}

/** True for a saved authoring document written in pixel expressions. */
export function isPixelDocument(doc: unknown): doc is EffectAuthoringDocument & { source: string } {
	const d = doc as Partial<EffectAuthoringDocument> | null;
	return !!d && typeof d === 'object' && d.version === 1 && d.sourceLanguage === PIXEL_LANGUAGE && typeof d.source === 'string';
}

export interface PixelEffectProviderOptions {
	limits?: PixelLimits;
	/** Passed on to the sessions `openAuthoring` makes (e.g. a manual `schedule` in tests). */
	session?: Omit<GenericAuthoringOptions, 'provider' | 'source'>;
}

/** The provider of pixel expression effects. */
export function createPixelEffectProvider(options: PixelEffectProviderOptions = {}): EffectProvider {
	const limits = { ...PIXEL_DEFAULT_LIMITS, ...options.limits };
	const templates = new Map(PIXEL_TEMPLATES.map((t) => [t.id, t]));
	const describeTemplate = (id: string): { description: EffectDescription; program: PixelProgram } => {
		const t = templates.get(id);
		if (!t) throw new UnknownEffectError(id, 'Pixel expressions');
		const r = describePixelSource(t.source, t, limits);
		return { description: r.description!, program: r.program! };
	};
	const summaries = (): EffectSummary[] =>
		PIXEL_TEMPLATES.map((t) => {
			const { controls: _c, defaults: _d, presets: _p, inputs: _i, ...summary } = describeTemplate(t.id).description;
			return summary;
		});

	const backend: AuthoringSourceBackend = {
		language: PIXEL_LANGUAGE,
		sourceOf: (id) => {
			const t = templates.get(id);
			if (!t) throw new UnknownEffectError(id, 'Pixel expressions');
			return t.source;
		},
		refuse: (src) => (src.length > limits.maxSourceLength ? `the source is ${src.length} characters; the limit is ${limits.maxSourceLength}` : null),
		compile: (src, id) => {
			const t = templates.get(id);
			const r = describePixelSource(src, { id, name: t?.name ?? id, loop: t?.loop, duration: t?.duration }, limits);
			return { description: r.description, issues: r.issues };
		},
		createRenderer: (src, id, opts) => {
			const t = templates.get(id);
			const r = describePixelSource(src, { id, name: t?.name ?? id }, limits);
			if (!r.program) throw new Error(`the source doesn't compile: ${pixelIssueText(r.issues)}`);
			return createPixelRenderer(r.program, r.description!, opts);
		}
	};

	const provider: EffectProvider = {
		id: PIXEL_PROVIDER_ID,
		name: 'Pixel expressions',
		capabilities: CAPABILITIES,
		list: (o?: EffectSearchOptions) => searchEffectSummaries(summaries(), '', o),
		search: (q: string, o?: EffectSearchOptions) => searchEffectSummaries(summaries(), q, o),
		describe: (id: string) => describeTemplate(id).description,
		createRenderer: (id: string, opts: EffectRendererOptions) => {
			const { description, program } = describeTemplate(id);
			return createPixelRenderer(program, description, opts);
		},
		openAuthoring: (from: EffectAuthoringSource) => createEffectAuthoringSession(from, { history: new HistoryManager(), ...options.session, provider, source: backend })
	};
	return provider;
}
