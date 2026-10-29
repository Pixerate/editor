/**
 * `createFakeEffectProvider`: a small, deterministic, CPU-only provider implementing the whole
 * contract. Tests and the demo use it; it is also a reference for real providers.
 *
 * Effects (ids prefixed `fake.`):
 * - `invert` (filter), `tint` (filter)
 * - `gradient` (generator, loops; its background opacity is `opacity`)
 * - `bar` (title / overlay: a lower-third bar that slides in, transparent)
 * - `crossfade` (transition)
 * - `fade-in` (motion, vector only)
 * - `badge` (a vector effect with its own picture: a disc that fades in; vector only)
 */

import { EffectDisposedError, EffectUnsupportedError, UnknownEffectError } from './errors.js';
import { createEffectAuthoringSession } from './authoring-session.js';
import { createEffectPixels, encodeEffectFloat, isEffectPixels, resolveEffectValues, searchEffectSummaries, srgbToLinear } from './helpers.js';
import type {
	EffectDescription,
	EffectImageSource,
	EffectPixels,
	EffectProvider,
	EffectProviderCapabilities,
	EffectRenderer,
	EffectRendererOptions,
	EffectRenderRequest,
	EffectSummary,
	EffectValues,
	EffectVectorMotion,
	EffectVectorTarget
} from './types.js';

const HEX = '^#[0-9a-fA-F]{6}$';
const colour = (description: string) => ({ type: 'string' as const, pattern: HEX, description });
const amount = (description: string) => ({ type: 'number' as const, minimum: 0, maximum: 1, description });

const DESCRIPTIONS: readonly EffectDescription[] = [
	{
		id: 'fake.invert',
		name: 'Invert',
		kind: 'shader',
		category: 'image',
		uses: ['filter'],
		description: 'Inverts the colours of the source.',
		tags: ['negative', 'colour'],
		transparent: false,
		loop: false,
		controls: {
			type: 'object',
			additionalProperties: false,
			properties: { amount: amount('How far to invert, 0 (unchanged) to 1 (fully inverted). Default 1.') }
		},
		defaults: { amount: 1 },
		presets: [{ name: 'Half', values: { amount: 0.5 } }],
		inputs: [{ name: 'source', kind: 'image', description: 'The picture to invert.', required: true }]
	},
	{
		id: 'fake.tint',
		name: 'Tint',
		kind: 'shader',
		category: 'image',
		uses: ['filter'],
		description: 'Mixes the source towards a colour.',
		tags: ['colour', 'wash'],
		transparent: false,
		loop: false,
		controls: {
			type: 'object',
			additionalProperties: false,
			properties: {
				color: colour('Tint colour as #rrggbb. Default #ff8800.'),
				amount: amount('How far to mix towards the colour, 0–1. Default 0.5.')
			}
		},
		defaults: { color: '#ff8800', amount: 0.5 },
		presets: [
			{ name: 'Sepia', values: { color: '#704214', amount: 0.4 } },
			{ name: 'Cool', values: { color: '#2060ff', amount: 0.25 } }
		],
		inputs: [{ name: 'source', kind: 'image', description: 'The picture to tint.', required: true }]
	},
	{
		id: 'fake.gradient',
		name: 'Gradient',
		kind: 'shader',
		category: 'gradient',
		uses: ['generator'],
		description: 'A linear gradient between two colours that can turn over time.',
		tags: ['background'],
		transparent: false,
		loop: true,
		duration: 4000,
		backgroundOpacity: 'opacity',
		controls: {
			type: 'object',
			additionalProperties: false,
			properties: {
				from: colour('Start colour as #rrggbb. Default #1e3a8a.'),
				to: colour('End colour as #rrggbb. Default #f472b6.'),
				angle: { type: 'number', minimum: 0, maximum: 360, description: 'Direction in degrees, 0 = left to right, 90 = top to bottom. Default 90.' },
				spin: { type: 'number', minimum: -360, maximum: 360, description: 'Turn per loop (4 s) in degrees. Default 0.' },
				opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Background opacity 0–1: 0 is fully transparent. Default 1.' }
			}
		},
		defaults: { from: '#1e3a8a', to: '#f472b6', angle: 90, spin: 0, opacity: 1 },
		presets: [{ name: 'Sunset', values: { from: '#f97316', to: '#7c3aed' } }],
		inputs: []
	},
	{
		id: 'fake.bar',
		name: 'Lower-third bar',
		kind: 'shader',
		category: 'broadcast',
		uses: ['title', 'overlay'],
		description: 'A coloured bar that slides in from the left in the lower third. Transparent elsewhere.',
		tags: ['lower third', 'title'],
		transparent: true,
		loop: false,
		duration: 2000,
		controls: {
			type: 'object',
			additionalProperties: false,
			properties: {
				color: colour('Bar colour as #rrggbb. Default #0ea5e9.'),
				height: { type: 'number', minimum: 0.02, maximum: 0.5, description: 'Bar height as a fraction of the picture height. Default 0.12.' },
				slide: { type: 'number', minimum: 0, maximum: 5000, description: 'Slide-in time (ms). Default 500.' }
			}
		},
		defaults: { color: '#0ea5e9', height: 0.12, slide: 500 },
		presets: [],
		inputs: []
	},
	{
		id: 'fake.crossfade',
		name: 'Crossfade',
		kind: 'shader',
		category: 'transition',
		uses: ['transition'],
		description: 'Dissolves from one picture to the next.',
		tags: ['dissolve', 'mix'],
		transparent: false,
		loop: false,
		duration: 1000,
		controls: {
			type: 'object',
			additionalProperties: false,
			properties: { curve: { type: 'string', enum: ['linear', 'smooth'], description: 'Mix curve: linear, or smooth (ease in and out). Default smooth.' } }
		},
		defaults: { curve: 'smooth' },
		presets: [],
		inputs: [
			{ name: 'from', kind: 'image', description: 'The outgoing picture.', required: true },
			{ name: 'to', kind: 'image', description: 'The incoming picture.', required: true }
		]
	},
	{
		id: 'fake.fade-in',
		name: 'Fade in',
		kind: 'motion',
		category: 'morph',
		uses: ['motion'],
		description: 'Fades vector elements in from transparent, one after another.',
		tags: ['appear', 'entrance'],
		transparent: true,
		loop: false,
		duration: 600,
		controls: {
			type: 'object',
			additionalProperties: false,
			properties: {
				ms: { type: 'number', minimum: 0, maximum: 10000, description: 'Fade time per element (ms). Default 600.' },
				stagger: { type: 'number', minimum: 0, maximum: 5000, description: 'Delay between elements (ms). Default 0.' }
			}
		},
		defaults: { ms: 600, stagger: 0 },
		presets: [{ name: 'Cascade', values: { ms: 400, stagger: 120 } }],
		inputs: []
	},
	{
		id: 'fake.badge',
		name: 'Badge',
		kind: 'vector',
		category: 'sticker',
		uses: ['title'],
		description: 'A coloured disc that fades in: a vector effect that brings its own picture.',
		tags: ['sticker', 'disc'],
		transparent: true,
		loop: false,
		duration: 500,
		controls: {
			type: 'object',
			additionalProperties: false,
			properties: {
				color: colour('Disc colour as #rrggbb. Default #f43f5e.'),
				ms: { type: 'number', minimum: 0, maximum: 10000, description: 'Fade-in time (ms). Default 500.' }
			}
		},
		defaults: { color: '#f43f5e', ms: 500 },
		presets: [],
		inputs: []
	}
];

const summaryOf = ({ controls: _c, defaults: _d, presets: _p, inputs: _i, ...summary }: EffectDescription): EffectSummary => summary;

const hexToRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function input(request: EffectRenderRequest, name: string, id: string, width: number, height: number): EffectPixels {
	const src: EffectImageSource | undefined = request.inputs?.[name];
	if (!src) throw new EffectUnsupportedError(`Effect "${id}" needs an input named "${name}".`, id);
	if (!isEffectPixels(src)) throw new EffectUnsupportedError(`The fake provider only takes EffectPixels inputs ("${name}").`, id);
	if (src.width !== width || src.height !== height) {
		throw new EffectUnsupportedError(`Input "${name}" is ${src.width}×${src.height}; the renderer is ${width}×${height}.`, id);
	}
	return src;
}

/** Per-pixel colour work in 8-bit sRGB; float output (when asked) is derived from it. */
function renderPixels(d: EffectDescription, v: Record<string, EffectValues[string]>, request: EffectRenderRequest, width: number, height: number): EffectPixels {
	const out = createEffectPixels(width, height);
	const o = out.data;
	switch (d.id) {
		case 'fake.invert': {
			const s = input(request, 'source', d.id, width, height).data;
			const k = v.amount as number;
			for (let i = 0; i < o.length; i += 4) {
				for (let c = 0; c < 3; c++) o[i + c] = s[i + c] + (255 - 2 * s[i + c]) * k;
				o[i + 3] = s[i + 3];
			}
			break;
		}
		case 'fake.tint': {
			const s = input(request, 'source', d.id, width, height).data;
			const rgb = hexToRgb(v.color as string);
			const k = v.amount as number;
			for (let i = 0; i < o.length; i += 4) {
				for (let c = 0; c < 3; c++) o[i + c] = s[i + c] + (rgb[c] - s[i + c]) * k;
				o[i + 3] = s[i + 3];
			}
			break;
		}
		case 'fake.gradient': {
			const a = hexToRgb(v.from as string);
			const b = hexToRgb(v.to as string);
			const turn = ((request.time % (d.duration ?? 4000)) / (d.duration ?? 4000)) * (v.spin as number);
			const rad = (((v.angle as number) + turn) * Math.PI) / 180;
			const dx = Math.cos(rad);
			const dy = Math.sin(rad);
			const half = (Math.abs(dx) * width + Math.abs(dy) * height) / 2 || 1;
			for (let y = 0, i = 0; y < height; y++) {
				for (let x = 0; x < width; x++, i += 4) {
					const t = clamp01(((x + 0.5 - width / 2) * dx + (y + 0.5 - height / 2) * dy) / (2 * half) + 0.5);
					for (let c = 0; c < 3; c++) o[i + c] = a[c] + (b[c] - a[c]) * t;
					o[i + 3] = 255 * clamp01(v.opacity as number);
				}
			}
			break;
		}
		case 'fake.bar': {
			const rgb = hexToRgb(v.color as string);
			const slide = v.slide as number;
			const shown = slide > 0 ? smooth(clamp01(request.time / slide)) : 1;
			const top = Math.round(height * (0.75 - (v.height as number) / 2));
			const bottom = Math.round(height * (0.75 + (v.height as number) / 2));
			const right = Math.round(width * 0.7 * shown);
			for (let y = Math.max(0, top); y < Math.min(height, bottom); y++) {
				for (let x = 0; x < right; x++) {
					const i = (y * width + x) * 4;
					o[i] = rgb[0];
					o[i + 1] = rgb[1];
					o[i + 2] = rgb[2];
					o[i + 3] = 255;
				}
			}
			break;
		}
		case 'fake.crossfade': {
			const from = input(request, 'from', d.id, width, height).data;
			const to = input(request, 'to', d.id, width, height).data;
			const p = clamp01(request.progress ?? request.time / (d.duration ?? 1000));
			const k = v.curve === 'smooth' ? smooth(p) : p;
			for (let i = 0; i < o.length; i++) o[i] = from[i] + (to[i] - from[i]) * k;
			break;
		}
		default:
			throw new EffectUnsupportedError(`"${d.id}" is a ${d.kind} effect; use applyVectorEffect.`, d.id);
	}
	return out;
}

function toFloat(p: EffectPixels): EffectPixels {
	const f = new Float32Array(p.data.length);
	for (let i = 0; i < f.length; i += 4) {
		f[i] = srgbToLinear(p.data[i] / 255);
		f[i + 1] = srgbToLinear(p.data[i + 1] / 255);
		f[i + 2] = srgbToLinear(p.data[i + 2] / 255);
		f[i + 3] = p.data[i + 3] / 255;
	}
	return encodeEffectFloat({ ...p, float: f });
}

function maskResult(out: EffectPixels, mask: EffectImageSource, source: EffectPixels | undefined, id: string): void {
	if (!isEffectPixels(mask) || mask.width !== out.width || mask.height !== out.height) {
		throw new EffectUnsupportedError('The mask must be EffectPixels the size of the renderer.', id);
	}
	const o = out.data;
	for (let i = 0; i < o.length; i += 4) {
		const k = mask.data[i + 3] / 255;
		if (source) for (let c = 0; c < 4; c++) o[i + c] = source.data[i + c] + (o[i + c] - source.data[i + c]) * k;
		else o[i + 3] *= k;
	}
}

export interface FakeEffectProviderOptions {
	/** Overrides of the capability flags, to test how editors degrade. */
	capabilities?: Partial<EffectProviderCapabilities>;
	/** Called on every render (tests count frames with it). */
	onRender?: (effectId: string, request: EffectRenderRequest) => void;
	/** Whether authoring is supported (default true). */
	authoring?: boolean;
}

/** A deterministic CPU effects provider with six effects (see the module comment). */
export function createFakeEffectProvider(options: FakeEffectProviderOptions = {}): EffectProvider {
	const supportsAuthoring = options.authoring ?? true;
	const capabilities: EffectProviderCapabilities = {
		supportsWorker: false,
		supportsFloat: true,
		supportsMask: true,
		supportsHostImages: false,
		supportsVector: true,
		supportsAuthoring,
		maxSize: 8192,
		...options.capabilities
	};
	const byId = new Map(DESCRIPTIONS.map((d) => [d.id, d]));
	const get = (id: string) => {
		const d = byId.get(id);
		if (!d) throw new UnknownEffectError(id, 'the fake provider');
		return d;
	};
	const summaries = DESCRIPTIONS.map(summaryOf);

	const provider: EffectProvider = {
		id: 'fake',
		name: 'Fake effects',
		version: '1',
		capabilities,
		list: (o) => searchEffectSummaries(summaries, '', o),
		search: (q, o) => searchEffectSummaries(summaries, q, o),
		describe: (id) => structuredClone(get(id)),
		createRenderer(id: string, ro: EffectRendererOptions): EffectRenderer {
			const d = get(id);
			if (d.kind !== 'shader') throw new EffectUnsupportedError(`"${id}" is a ${d.kind} effect; use applyVectorEffect.`, id);
			const { width, height } = ro;
			const depth = ro.depth ?? 8;
			if (!(width > 0 && height > 0) || width > capabilities.maxSize! || height > capabilities.maxSize!) {
				throw new EffectUnsupportedError(`Renderer size ${width}×${height} is outside 1–${capabilities.maxSize}.`, id);
			}
			let disposed = false;
			return {
				effectId: id,
				width,
				height,
				depth,
				async render(request) {
					if (disposed) throw new EffectDisposedError(id);
					if (!Number.isFinite(request.time) || request.time < 0) {
						throw new EffectUnsupportedError(`time must be a finite number of ms ≥ 0, got ${request.time}.`, id);
					}
					const values = resolveEffectValues(d, request.values);
					options.onRender?.(id, request);
					const out = renderPixels(d, values, request, width, height);
					if (request.mask) {
						if (!capabilities.supportsMask) throw new EffectUnsupportedError('This provider does not take masks.', id);
						const source = d.uses.includes('filter') ? (request.inputs?.source as EffectPixels) : undefined;
						maskResult(out, request.mask, source, id);
					}
					return depth > 8 && capabilities.supportsFloat ? toFloat(out) : out;
				},
				dispose() {
					disposed = true;
				}
			};
		},
		applyVectorEffect(id: string, target: EffectVectorTarget, values?: EffectValues): EffectVectorMotion {
			const d = get(id);
			if (d.kind !== 'motion' && d.kind !== 'vector') throw new EffectUnsupportedError(`"${id}" is a ${d.kind} effect, not a vector one.`, id);
			const v = resolveEffectValues(d, values);
			if (d.kind === 'vector') {
				// Its own picture: the target is not used.
				return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><circle id="badge" cx="50" cy="50" r="40" fill="${v.color}"/></svg>`, animate: [{ id: 'badge', ms: v.ms as number, attrs: { opacity: [0, 1] as const } }], duration: v.ms as number, loop: false };
			}
			const svg = typeof target === 'string' ? target : target.svg;
			const ids = typeof target === 'string' || !target.nodeIds ? [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]) : [...target.nodeIds];
			const ms = v.ms as number;
			const stagger = v.stagger as number;
			return {
				svg,
				animate: ids.map((elementId, i) => ({ id: elementId, delay: i * stagger, ms, attrs: { opacity: [0, 1] as const } })),
				duration: ms + Math.max(0, ids.length - 1) * stagger,
				loop: false
			};
		},
		...(supportsAuthoring
			? {
					openAuthoring: (from) => createEffectAuthoringSession(from, { provider })
			  }
			: {})
	};
	return provider;
}
