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
 * - `trail` (an overlay that draws a line along its `path` control, transparent)
 * - `route` (a vector effect that draws its `path` control as a line; vector only)
 *
 * It writes words as path data (`pathFromText`): a zig-zag per letter, font `zig`.
 *
 * With `camera: true` it also has camera moves (no pixels): `glide` and `whip` (transitions; the
 * whip cuts halfway) and `drift` (a hold that zooms in slowly).
 *
 * With `timing: true` it also has timing effects (no pixels; they retime video footage): `speed`
 * (slow or fast, blending frames), `freeze` (holds one frame, then plays on) and `echo` (fading
 * copies of the frames before, averaged or lightened).
 *
 * With `templates: true` it also has two sequence templates (see `fake-templates.ts`):
 * `fake.title-sequence` and `fake.picture-reveal`.
 */

import { EffectDisposedError, EffectUnsupportedError, UnknownEffectError } from './errors.js';
import { createEffectAuthoringSession } from './authoring-session.js';
import { fakeTemplateMethods } from './fake-templates.js';
import {
	checkTimingFootage,
	checkTimingRequest,
	createEffectPixels,
	encodeEffectFloat,
	isEffectPixels,
	normaliseTimingSample,
	resolveEffectValues,
	sampleCameraViews,
	searchEffectSummaries,
	srgbToLinear
} from './helpers.js';
import type {
	CameraMoveContext,
	CameraView,
	EffectDescription,
	EffectImageSource,
	EffectPixels,
	EffectProvider,
	EffectProviderCapabilities,
	EffectRenderer,
	EffectRendererOptions,
	EffectRenderRequest,
	EffectSummary,
	EffectTextPathOptions,
	EffectValues,
	EffectVectorMotion,
	EffectVectorTarget,
	TimingFrame,
	TimingSample,
	TimingSampleRequest
} from './types.js';

const HEX = '^#[0-9a-fA-F]{6}$';
const colour = (description: string) => ({ type: 'string' as const, pattern: HEX, description });
const amount = (description: string) => ({ type: 'number' as const, minimum: 0, maximum: 1, description });

/** A path control: SVG path data fitted into the frame, points in frame pixels, or "" for none. */
const pathControl = (what: string) => ({
	description: `${what}: SVG path data (fitted into the frame, contain, 8% margin), or points [x0, y0, x1, y1, …] in frame pixels from the top left (used as given), or "" for none.`,
	anyOf: [
		{ type: 'string' as const, format: 'svg-path', description: 'SVG path data, or "" for no path.' },
		{ type: 'array' as const, items: { type: 'number' as const, description: 'x or y, frame pixels.' }, description: 'Points x0, y0, x1, y1, … in frame pixels.' }
	]
});

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
	},
	{
		id: 'fake.trail',
		name: 'Trail',
		kind: 'shader',
		category: 'path',
		uses: ['overlay'],
		description: 'A line drawn along its path control over transparency; with no path, a line across the middle.',
		tags: ['path', 'line'],
		transparent: true,
		loop: false,
		accepts: ['path'],
		controls: {
			type: 'object',
			additionalProperties: false,
			properties: {
				path: pathControl('Where the line runs'),
				color: colour('Line colour as #rrggbb. Default #22d3ee.'),
				width: { type: 'number', minimum: 1, maximum: 64, description: 'Line width in pixels. Default 6.' }
			}
		},
		defaults: { path: '', color: '#22d3ee', width: 6 },
		presets: [],
		inputs: []
	},
	{
		id: 'fake.route',
		name: 'Route',
		kind: 'vector',
		category: 'path',
		uses: ['title'],
		description: 'A vector line along its path control, its picture fitted to the path (viewBox = the path bounds); with no path, a short wave.',
		tags: ['path', 'route'],
		transparent: true,
		loop: false,
		duration: 400,
		accepts: ['path'],
		controls: {
			type: 'object',
			additionalProperties: false,
			properties: {
				path: pathControl('The route'),
				color: colour('Line colour as #rrggbb. Default #f59e0b.')
			}
		},
		defaults: { path: '', color: '#f59e0b' },
		presets: [],
		inputs: []
	}
];

/** The numbers of SVG path data in order (commands are read as straight lines between their end points). */
function pathNumbers(d: string): number[] {
	return [...d.matchAll(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)].map((m) => Number(m[0]));
}

/** A path control's value as points in frame pixels: lists as given, path data fitted (contain, 8% margin), "" as `fallback`. */
function framePoints(value: unknown, width: number, height: number, fallback: number[]): number[] {
	if (Array.isArray(value)) return value.length >= 4 ? (value as number[]) : fallback;
	if (typeof value !== 'string' || !value.trim()) return fallback;
	const n = pathNumbers(value);
	if (n.length < 4) return fallback;
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (let i = 0; i + 1 < n.length; i += 2) {
		x0 = Math.min(x0, n[i]); x1 = Math.max(x1, n[i]);
		y0 = Math.min(y0, n[i + 1]); y1 = Math.max(y1, n[i + 1]);
	}
	const m = 0.08;
	const k = Math.min((width * (1 - 2 * m)) / Math.max(1e-9, x1 - x0), (height * (1 - 2 * m)) / Math.max(1e-9, y1 - y0));
	const ox = (width - (x1 - x0) * k) / 2 - x0 * k;
	const oy = (height - (y1 - y0) * k) / 2 - y0 * k;
	return n.map((v, i) => (i % 2 ? v * k + oy : v * k + ox));
}

const CAMERA_DESCRIPTIONS: readonly EffectDescription[] = [
	{
		id: 'fake.glide',
		name: 'Glide',
		kind: 'camera',
		category: 'camera',
		uses: ['camera'],
		description: 'Moves the camera smoothly from one framing to the next.',
		tags: ['move', 'smooth'],
		transparent: false,
		loop: false,
		duration: 800,
		camera: { role: 'transition', durationMs: 800 },
		controls: {
			type: 'object',
			additionalProperties: false,
			properties: { curve: { type: 'string', enum: ['linear', 'smooth'], description: 'Speed curve: linear, or smooth (ease in and out). Default smooth.' } }
		},
		defaults: { curve: 'smooth' },
		presets: [],
		inputs: []
	},
	{
		id: 'fake.whip',
		name: 'Whip pan',
		kind: 'camera',
		category: 'camera',
		uses: ['camera'],
		description: 'Whips the camera away from one framing, cuts halfway in a blur, and lands on the next.',
		tags: ['move', 'fast', 'cut'],
		transparent: false,
		loop: false,
		duration: 400,
		camera: { role: 'transition', durationMs: 400, cut: 0.5 },
		controls: {
			type: 'object',
			additionalProperties: false,
			properties: { blur: { type: 'number', minimum: 0, maximum: 100, description: 'Motion blur at the cut, in stage pixels. Default 40.' } }
		},
		defaults: { blur: 40 },
		presets: [{ name: 'Clean', values: { blur: 0 } }],
		inputs: []
	},
	{
		id: 'fake.drift',
		name: 'Drift',
		kind: 'camera',
		category: 'camera',
		uses: ['camera'],
		description: 'Zooms slowly into the middle of the framing while the shot holds.',
		tags: ['ken burns', 'slow'],
		transparent: false,
		loop: false,
		duration: 4000,
		camera: { role: 'hold', durationMs: 4000 },
		controls: {
			type: 'object',
			additionalProperties: false,
			properties: { scale: { type: 'number', minimum: 1, maximum: 2, description: 'Zoom at the end of the hold, as a multiple of the framing\'s zoom. Default 1.15.' } }
		},
		defaults: { scale: 1.15 },
		presets: [],
		inputs: []
	}
];

const TIMING_DESCRIPTIONS: readonly EffectDescription[] = [
	{
		id: 'fake.speed',
		name: 'Speed change',
		kind: 'timing',
		category: 'timing',
		uses: ['timing'],
		description: 'Footage played slower or faster throughout; slowed frames blend the two either side, sped-up ones average the frames they pass over.',
		tags: ['retime', 'slow motion', 'time-lapse'],
		transparent: false,
		loop: false,
		controls: {
			type: 'object',
			additionalProperties: false,
			properties: {
				speed: { type: 'number', minimum: 0.1, maximum: 8, description: 'Playback speed as a multiple of real time, 0.1–8 (0.5 is half speed). Default 0.5.' },
				smooth: { type: 'boolean', description: 'Blend frames: in-betweens when slowed, motion blur when sped up. Default true.' }
			}
		},
		defaults: { speed: 0.5, smooth: true },
		presets: [
			{ name: 'Slow motion', values: { speed: 0.25 } },
			{ name: 'Double speed', values: { speed: 2 } }
		],
		inputs: []
	},
	{
		id: 'fake.freeze',
		name: 'Freeze frame',
		kind: 'timing',
		category: 'timing',
		uses: ['timing'],
		description: 'Footage that stops on one frame, holds it, then plays on from where it stopped.',
		tags: ['retime', 'freeze', 'hold'],
		transparent: false,
		loop: false,
		controls: {
			type: 'object',
			additionalProperties: false,
			properties: {
				at: { type: 'number', minimum: 0, maximum: 1, description: 'Where it freezes, as a share of the footage, 0–1. Default 0.5.' },
				hold: { type: 'number', minimum: 0, maximum: 10000, description: 'How long it holds (ms). Default 1000.' }
			}
		},
		defaults: { at: 0.5, hold: 1000 },
		presets: [{ name: 'Opening still', values: { at: 0, hold: 2000 } }],
		inputs: []
	},
	{
		id: 'fake.echo',
		name: 'Frame echo',
		kind: 'timing',
		category: 'timing',
		uses: ['timing'],
		description: 'Each frame with fading copies of the frames just before it, so moving things leave a trail.',
		tags: ['retime', 'echo', 'trail'],
		transparent: false,
		loop: false,
		controls: {
			type: 'object',
			additionalProperties: false,
			properties: {
				echoes: { type: 'integer', minimum: 1, maximum: 8, description: 'Copies of earlier frames, 1–8. Default 3.' },
				spacing: { type: 'number', minimum: 10, maximum: 500, description: 'Footage time between copies (ms). Default 100.' },
				decay: { type: 'number', minimum: 0.1, maximum: 0.95, description: 'Each copy\'s weight as a share of the one after it, 0.1–0.95. Default 0.5.' },
				lighten: { type: 'boolean', description: 'Keep the brightest of the copies (light trails) instead of averaging them. Default false.' }
			}
		},
		defaults: { echoes: 3, spacing: 100, decay: 0.5, lighten: false },
		presets: [{ name: 'Light trails', values: { echoes: 6, spacing: 50, decay: 0.8, lighten: true } }],
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
		case 'fake.trail': {
			const rgb = hexToRgb(v.color as string);
			const pts = framePoints(v.path, width, height, [0, height / 2, width, height / 2]);
			const r = (v.width as number) / 2;
			// Discs along each segment, a pixel apart.
			for (let i = 0; i + 3 < pts.length; i += 2) {
				const [ax, ay, bx, by] = [pts[i], pts[i + 1], pts[i + 2], pts[i + 3]];
				const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
				for (let s = 0; s <= steps; s++) {
					const cx = ax + ((bx - ax) * s) / steps;
					const cy = ay + ((by - ay) * s) / steps;
					for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(height - 1, Math.ceil(cy + r)); y++)
						for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(width - 1, Math.ceil(cx + r)); x++) {
							if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
							const i4 = (y * width + x) * 4;
							o[i4] = rgb[0];
							o[i4 + 1] = rgb[1];
							o[i4 + 2] = rgb[2];
							o[i4 + 3] = 255;
						}
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

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The view with the scene point `(cx, cy)` in the middle of the stage at `zoom`. */
const viewAt = (cx: number, cy: number, zoom: number, ctx: CameraMoveContext): CameraView => ({ zoom, scrollX: ctx.stage.width / (2 * zoom) - cx, scrollY: ctx.stage.height / (2 * zoom) - cy });
const centreOf = (v: CameraView, ctx: CameraMoveContext): [number, number] => [ctx.stage.width / (2 * v.zoom) - v.scrollX, ctx.stage.height / (2 * v.zoom) - v.scrollY];

/** Where a fake camera move puts the camera (pure). */
function cameraViewOf(d: EffectDescription, ctx: CameraMoveContext, v: Record<string, EffectValues[string]>): CameraView {
	const { from, to, u } = ctx;
	const [x0, y0] = centreOf(from, ctx);
	const [x1, y1] = centreOf(to, ctx);
	switch (d.id) {
		case 'fake.glide': {
			const k = v.curve === 'smooth' ? smooth(u) : u;
			return viewAt(lerp(x0, x1, k), lerp(y0, y1, k), lerp(from.zoom, to.zoom, k), ctx);
		}
		case 'fake.whip': {
			// Out along the line to the next framing, a board's width at most, then in from behind it.
			const out = u < 0.5;
			const at = out ? from : to;
			const off = out ? Math.pow(u * 2, 3) : 1 - (1 - Math.pow(1 - (u - 0.5) * 2, 3));
			const dist = Math.hypot(x1 - x0, y1 - y0);
			const [dx, dy] = dist > 1e-6 ? [(x1 - x0) / dist, (y1 - y0) / dist] : [1, 0];
			const reach = (ctx.stage.width / at.zoom) * off * (out ? 1 : -1);
			const [cx, cy] = centreOf(at, ctx);
			const blur = (v.blur as number) * off;
			return { ...viewAt(cx + dx * reach, cy + dy * reach, at.zoom, ctx), ...(blur > 0 ? { blur, blurAngle: (Math.atan2(dy, dx) * 180) / Math.PI } : {}) };
		}
		case 'fake.drift':
			return viewAt(x0, y0, from.zoom * lerp(1, v.scale as number, smooth(u)), ctx);
		default:
			throw new EffectUnsupportedError(`"${d.id}" is a ${d.kind} effect, not a camera move.`, d.id);
	}
}

/** Ms a fake timing effect's clip lasts for `footage` ms of footage (pure). */
function timingLengthOf(d: EffectDescription, footage: number, v: Record<string, EffectValues[string]>): number {
	switch (d.id) {
		case 'fake.speed':
			return footage / (v.speed as number);
		case 'fake.freeze':
			return footage + (v.hold as number);
		case 'fake.echo':
			return footage;
		default:
			throw new EffectUnsupportedError(`"${d.id}" is a ${d.kind} effect, not a timing effect.`, d.id);
	}
}

/** The raw footage frames of a fake timing effect at `request.time` (pure); `normaliseTimingSample` tidies them. */
function timingFramesOf(d: EffectDescription, request: Required<TimingSampleRequest>, v: Record<string, EffectValues[string]>): { frames: TimingFrame[]; lighten?: boolean } {
	const { time, fps } = request;
	const frameMs = 1000 / fps;
	switch (d.id) {
		case 'fake.speed': {
			const speed = v.speed as number;
			const s = time * speed;
			if (!v.smooth) return { frames: [{ time: s, weight: 1 }] };
			if (speed <= 1) {
				// The two frames either side, by nearness.
				const i = s / frameMs;
				const f = Math.floor(i + 1e-6);
				const frac = Math.max(0, i - f);
				return { frames: [{ time: f * frameMs, weight: 1 - frac }, { time: (f + 1) * frameMs, weight: frac }] };
			}
			// The frames a sped-up frame passes over, averaged.
			const n = Math.ceil(speed);
			return { frames: Array.from({ length: n }, (_, k) => ({ time: s + (k * speed * frameMs) / n, weight: 1 })) };
		}
		case 'fake.freeze': {
			const at = Math.floor(((v.at as number) * request.footage) / frameMs + 1e-6) * frameMs;
			const hold = v.hold as number;
			return { frames: [{ time: time < at ? time : time < at + hold ? at : time - hold, weight: 1 }] };
		}
		case 'fake.echo': {
			const frames: TimingFrame[] = [];
			for (let k = 0; k <= (v.echoes as number); k++) {
				const t = time - k * (v.spacing as number);
				if (t < 0) break;
				frames.push({ time: t, weight: Math.pow(v.decay as number, k) });
			}
			return { frames, lighten: v.lighten as boolean };
		}
		default:
			throw new EffectUnsupportedError(`"${d.id}" is a ${d.kind} effect, not a timing effect.`, d.id);
	}
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
	/** Adds the camera moves and `cameraView` / `sampleCameraMove` (default false). */
	camera?: boolean;
	/** Adds the timing effects and `timingLength` / `timingSample` (default false). */
	timing?: boolean;
	/** Adds two sequence templates and `listTemplates` / `describeTemplate` / `instantiateTemplate` (default false). */
	templates?: boolean;
}

/** A deterministic CPU effects provider with nine effects, and camera moves, timing effects and templates on request (see the module comment). */
export function createFakeEffectProvider(options: FakeEffectProviderOptions = {}): EffectProvider {
	const supportsAuthoring = options.authoring ?? true;
	const capabilities: EffectProviderCapabilities = {
		supportsWorker: false,
		supportsFloat: true,
		supportsMask: true,
		supportsHostImages: false,
		supportsVector: true,
		supportsAuthoring,
		...(options.camera ? { supportsCamera: true } : {}),
		...(options.timing ? { supportsTiming: true } : {}),
		...(options.templates ? { supportsTemplates: true } : {}),
		maxSize: 8192,
		...options.capabilities
	};
	const all = [...DESCRIPTIONS, ...(options.camera ? CAMERA_DESCRIPTIONS : []), ...(options.timing ? TIMING_DESCRIPTIONS : [])];
	const byId = new Map(all.map((d) => [d.id, d]));
	const get = (id: string) => {
		const d = byId.get(id);
		if (!d) throw new UnknownEffectError(id, 'the fake provider');
		return d;
	};
	const summaries = all.map(summaryOf);
	const camera = (id: string, ctx: CameraMoveContext, values?: EffectValues): CameraView => {
		const d = get(id);
		if (d.kind !== 'camera') throw new EffectUnsupportedError(`"${id}" is a ${d.kind} effect, not a camera move.`, id);
		if (!(ctx.u >= 0 && ctx.u <= 1)) throw new EffectUnsupportedError(`u must be 0–1 through the move, got ${ctx.u}.`, id);
		return cameraViewOf(d, ctx, resolveEffectValues(d, values));
	};
	const timingEffect = (id: string) => {
		const d = get(id);
		if (d.kind !== 'timing') {
			const ids = TIMING_DESCRIPTIONS.map((t) => `"${t.id}"`).join(', ');
			throw new EffectUnsupportedError(`"${id}" is a ${d.kind} effect, not a timing effect; the timing effects are ${ids}.`, id);
		}
		return d;
	};
	const timingLength = (id: string, footageMs: number, values?: EffectValues): number => {
		const d = timingEffect(id);
		checkTimingFootage(footageMs, id);
		return timingLengthOf(d, footageMs, resolveEffectValues(d, values));
	};
	const timingSample = (id: string, request: TimingSampleRequest, values?: EffectValues): TimingSample => {
		const d = timingEffect(id);
		const fps = checkTimingRequest(request, id);
		const raw = timingFramesOf(d, { time: request.time, footage: request.footage, fps }, resolveEffectValues(d, values));
		return normaliseTimingSample(raw.frames, { ...request, fps }, raw.lighten ? 'lighten' : 'average');
	};

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
			if (d.kind === 'camera') throw new EffectUnsupportedError(`"${id}" is a camera move: it moves a scene's camera and draws no pixels. Use cameraView.`, id);
			if (d.kind === 'timing') throw new EffectUnsupportedError(`"${id}" is a timing effect: it retimes video footage and draws no pixels of its own. Use timingSample and blend the footage frames it names.`, id);
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
				render(request) {
					try {
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
						const res = depth > 8 && capabilities.supportsFloat ? toFloat(out) : out;
						return Object.assign(Promise.resolve(res), { value: res });
					} catch (e) {
						return Promise.reject(e);
					}
				},
				dispose() {
					disposed = true;
				}
			};
		},
		pathFromText(text: string, opts?: EffectTextPathOptions): string {
			if (typeof text !== 'string' || !text.trim()) throw new EffectUnsupportedError('There are no words to write; pass some text.');
			if (opts?.font !== undefined && opts.font !== 'zig') throw new EffectUnsupportedError(`The fake provider has no font "${opts.font}"; its only font is "zig".`);
			// A zig-zag per letter, 10 units wide, on a line 10 high.
			return [...text].map((_, i) => `M${i * 10} 10 L${i * 10 + 3} 0 L${i * 10 + 6} 10`).join(' ');
		},
		applyVectorEffect(id: string, target: EffectVectorTarget, values?: EffectValues): EffectVectorMotion {
			const d = get(id);
			if (d.kind !== 'motion' && d.kind !== 'vector') throw new EffectUnsupportedError(`"${id}" is a ${d.kind} effect, not a vector one.`, id);
			const v = resolveEffectValues(d, values);
			if (d.id === 'fake.route') {
				// The path as a line; the picture's viewBox is the path's bounds, so it lands on the path at scale 1.
				const pts = Array.isArray(v.path) && v.path.length >= 4 ? (v.path as number[]) : typeof v.path === 'string' && pathNumbers(v.path).length >= 4 ? pathNumbers(v.path) : [0, 20, 25, 0, 50, 20, 75, 40, 100, 20];
				const xs = pts.filter((_, i) => i % 2 === 0);
				const ys = pts.filter((_, i) => i % 2 === 1);
				const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
				const [w, h] = [Math.max(1, Math.max(...xs) - x0), Math.max(1, Math.max(...ys) - y0)];
				const dpath = 'M' + pts.map((p) => +p.toFixed(3)).join(' ').replace(/^(\S+ \S+) /, '$1 L');
				return {
					svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${w} ${h}" width="${w}" height="${h}"><path id="route" d="${dpath}" fill="none" stroke="${v.color}" stroke-width="2"/></svg>`,
					animate: [{ id: 'route', ms: 400, attrs: { opacity: [0, 1] as const } }],
					duration: 400,
					loop: false
				};
			}
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
		...(options.camera
			? {
					cameraView: camera,
					sampleCameraMove: (id, request) => {
						const d = get(id);
						const { from, to, ms, stage, fps, values } = request;
						return sampleCameraViews((u) => camera(id, { from, to, u, ms, stage }, values), { ms, fps, cut: d.camera?.cut });
					}
			  }
			: {}),
		...(options.timing ? { timingLength, timingSample } : {}),
		...(options.templates ? fakeTemplateMethods() : {}),
		...(supportsAuthoring
			? {
					openAuthoring: (from) => createEffectAuthoringSession(from, { provider })
			  }
			: {})
	};
	return provider;
}
