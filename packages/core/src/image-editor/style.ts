/**
 * House style for images (#779): the `image-editor.json` profile (output aspect ratios and a
 * minimum size, ranges for the base adjustments, and the colours and fonts annotations may
 * use), its checks, and `check_image_style` / `fix_image_style`.
 *
 * Findings target the crop (`{ crop: { x, y, width, height } }`, the centred crop that reaches
 * the nearest house ratio, for `set_crop`), an adjustment with its clamped value
 * (`{ adjustment, value }`) or an annotation (`{ annotation: id }`).
 */
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { StyleCheck, StyleDomain, StyleFinding, StyleResolver } from '../tools/style.js';
import type { StyleSurface, StyleSurfaceColor } from '../tools/style-surface.js';
import { brandFonts, brandPalette } from '../tools/brand.js';
import type { CropBox, ImageAdjustments, ImageEditorState } from './types.js';
import type { ImageEditorController } from './controller.js';

type Finding = Omit<StyleFinding, 'check' | 'layer'>;

/** The base adjustments a profile can bound (each -100–100, blur 0–50). */
export const IMAGE_STYLE_ADJUSTMENTS = ['brightness', 'contrast', 'saturation', 'exposure', 'temperature', 'tint', 'blur'] as const;
type AdjustmentKey = (typeof IMAGE_STYLE_ADJUSTMENTS)[number];

/** The `image-editor.json` profile, after `$token` references are resolved. */
export interface ImageStyleProfile {
	/** Output aspect ratios allowed, as "width:height" ("1:1", "4:5", "16:9"). */
	aspectRatios?: string[];
	/** Smallest output, in pixels. */
	minSize?: { width?: number; height?: number };
	/** Ranges for the base adjustments: the house look's guardrails. */
	adjustments?: Partial<Record<AdjustmentKey, { min?: number; max?: number }>>;
	/** Colours annotations may use (for palette-only). Default: the brand's. */
	palette?: string[];
	/** Fonts text annotations may use (for fonts-allowed). Default: the brand's. */
	fonts?: string[];
}

/** A finding's target. */
export type ImageStyleTarget = { crop: CropBox } | { adjustment: AdjustmentKey; value: number } | { annotation: string } | { image: true };

const profileOf = (p: Readonly<Record<string, unknown>>) => p as ImageStyleProfile;
const output = (state: ImageEditorState) => state.crop ?? { x: 0, y: 0, ...state.imageDimensions };
const parseRatio = (r: string) => {
	const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(r.trim());
	return m ? Number(m[1]) / Number(m[2]) : NaN;
};

/** The largest centred crop of `box` with aspect `ratio`, in whole pixels. */
function centredCrop(box: CropBox, ratio: number): CropBox {
	let width = box.width;
	let height = Math.round(width / ratio);
	if (height > box.height) {
		height = box.height;
		width = Math.round(height * ratio);
	}
	return { x: Math.round(box.x + (box.width - width) / 2), y: Math.round(box.y + (box.height - height) / 2), width, height };
}

const aspectRatio: StyleCheck<ImageEditorState> = {
	id: 'aspect-ratio',
	description: 'The output (the crop, or the whole image) has one of the house aspect ratios ("aspectRatios", e.g. ["1:1", "4:5"]), within 1%.',
	run(state, profile) {
		const ratios = (profileOf(profile).aspectRatios ?? []).map((r) => ({ r, v: parseRatio(r) })).filter((x) => x.v > 0);
		if (!ratios.length) throw new Error('the profile has no "aspectRatios".');
		const box = output(state);
		if (!box.width || !box.height) return [];
		const have = box.width / box.height;
		if (ratios.some((x) => Math.abs(x.v - have) / x.v <= 0.01)) return [];
		const nearest = ratios.reduce((best, x) => (Math.abs(Math.log(x.v / have)) < Math.abs(Math.log(best.v / have)) ? x : best));
		const crop = centredCrop(box, nearest.v);
		return [{ severity: 'warning' as const, message: `The output is ${box.width}×${box.height} (${have.toFixed(2)}:1); the house ratios are ${ratios.map((x) => x.r).join(', ')}. Crop to ${nearest.r}, e.g. ${crop.width}×${crop.height} centred, with set_crop.`, target: { crop } satisfies ImageStyleTarget }];
	}
};

const minSize: StyleCheck<ImageEditorState> = {
	id: 'min-size',
	description: 'The output is at least the house size ("minSize": { width, height } in pixels).',
	run(state, profile) {
		const min = profileOf(profile).minSize;
		if (!min || (min.width === undefined && min.height === undefined)) throw new Error('the profile has no "minSize".');
		const box = output(state);
		if ((min.width === undefined || box.width >= min.width) && (min.height === undefined || box.height >= min.height)) return [];
		return [{ severity: 'error' as const, message: `The output is ${box.width}×${box.height}; the house minimum is ${min.width ?? '…'}×${min.height ?? '…'}. Use a larger source or a looser crop.`, target: { image: true } satisfies ImageStyleTarget }];
	}
};

const adjustmentRanges: StyleCheck<ImageEditorState> = {
	id: 'adjustment-ranges',
	description: 'The base adjustments stay within the house ranges ("adjustments": { saturation: { min, max }, ... }), so every image keeps the house look.',
	run(state, profile) {
		const ranges = profileOf(profile).adjustments;
		if (!ranges || !Object.keys(ranges).length) throw new Error('the profile has no "adjustments".');
		const out: Finding[] = [];
		for (const key of IMAGE_STYLE_ADJUSTMENTS) {
			const r = ranges[key];
			const v = state.adjustments[key as keyof ImageAdjustments];
			if (!r || typeof v !== 'number') continue;
			const want = r.min !== undefined && v < r.min ? r.min : r.max !== undefined && v > r.max ? r.max : undefined;
			if (want === undefined) continue;
			out.push({ severity: 'warning' as const, message: `${key[0].toUpperCase()}${key.slice(1)} is ${v}; the house range is ${r.min ?? '…'} to ${r.max ?? '…'}. Set it to ${want}.`, target: { adjustment: key, value: want } satisfies ImageStyleTarget });
		}
		return out;
	}
};

/** The colours and fonts the image's annotations use, for the shared checks. */
export function imageStyleSurface(state: ImageEditorState): StyleSurface {
	const colors: StyleSurfaceColor[] = [];
	const fonts: StyleSurface['fonts'] = [];
	for (const a of state.annotations) {
		const target = { annotation: a.id } satisfies ImageStyleTarget;
		const label = `${a.type[0].toUpperCase()}${a.type.slice(1)} annotation ${a.id}`;
		const any = a as unknown as Record<string, unknown>;
		if (typeof any.strokeColor === 'string') colors.push({ color: any.strokeColor, label: `${label} stroke`, target, use: 'stroke' });
		if (typeof any.fillColor === 'string' && any.fillColor) colors.push({ color: any.fillColor, label: `${label} fill`, target, use: 'fill' });
		if (a.type === 'text') {
			colors.push({ color: a.color, label, target, use: 'fill', fontSize: a.fontSize });
			if (a.fontFamily) fonts.push({ family: a.fontFamily, label, target });
		}
	}
	return { colors, fonts };
}

/** The image house-style domain: register it with `createStyleResolver({ domains })`. */
export const imageStyleDomain: StyleDomain<ImageEditorState> = {
	id: 'image-editor',
	title: 'Images',
	description: 'How images are delivered: the output aspect ratios and minimum size, ranges for the base adjustments (the house look), and the colours and fonts annotations may use.',
	profileSchema: {
		type: 'object',
		properties: {
			aspectRatios: { type: 'array', items: { type: 'string', pattern: '^\\d+(\\.\\d+)?:\\d+(\\.\\d+)?$' }, minItems: 1, description: 'Output aspect ratios allowed, as "width:height", e.g. ["1:1", "4:5", "16:9"].' },
			minSize: {
				type: 'object',
				properties: { width: { type: 'integer', minimum: 1, description: 'Least output width, px.' }, height: { type: 'integer', minimum: 1, description: 'Least output height, px.' } },
				additionalProperties: false,
				description: 'Smallest output, in pixels.'
			},
			adjustments: {
				type: 'object',
				properties: Object.fromEntries(
					IMAGE_STYLE_ADJUSTMENTS.map((k) => [
						k,
						{
							type: 'object',
							properties: { min: { type: 'number', description: `Least ${k}.` }, max: { type: 'number', description: `Greatest ${k}.` } },
							additionalProperties: false,
							description: `Range for ${k} (${k === 'blur' ? '0–50' : '-100–100'}).`
						}
					])
				),
				additionalProperties: false,
				description: 'Ranges for the base adjustments, e.g. { "saturation": { "min": -20, "max": 20 } }.'
			},
			palette: { type: 'array', items: { type: 'string', minLength: 1, description: 'A CSS colour, or a { "$token": ... } reference.' }, description: 'Colours annotations may use (for palette-only). Default: the brand palette and roles.' },
			fonts: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Fonts text annotations may use (for fonts-allowed). Default: the brand fonts.' }
		},
		additionalProperties: false
	},
	checks: [aspectRatio, minSize, adjustmentRanges],
	surface: imageStyleSurface,
	themeFromBrand: (brand) => {
		const palette = brandPalette(brand);
		const fonts = brandFonts(brand);
		return { ...(palette.length ? { palette } : {}), ...(fonts.length ? { fonts } : {}) };
	},
	example: {
		aspectRatios: ['1:1', '4:5', '16:9'],
		minSize: { width: 1080 },
		adjustments: { saturation: { min: -20, max: 20 }, contrast: { min: -10, max: 25 } },
		checks: ['aspect-ratio', 'min-size', 'adjustment-ranges', 'palette-only', 'fonts-allowed']
	}
};

export interface ImageStyleToolProviderOptions {
	/** Provider id (unique per registry). Default `image-style`. */
	id?: string;
	/** Tool-name prefix; defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Where the tools work: skills scoped elsewhere do not apply. Set by the host. */
	scope?: string;
	/** The image cannot be changed: `fix_image_style` is hidden (a string is the reason). */
	readOnly?: boolean | string | (() => boolean | string);
}

/**
 * `check_image_style` and, while the image is editable, `fix_image_style` (clamps the base
 * adjustments into the house ranges as one undo step).
 */
export function createImageStyleToolProvider(controller: ImageEditorController, styles: StyleResolver, options: ImageStyleToolProviderOptions = {}): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'image-editor')) throw new Error('The style resolver has no "image-editor" domain; add imageStyleDomain to its domains.');
	const scope = options.scope !== undefined ? { scope: options.scope } : {};
	const readOnlyReason = (): string | null => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (!r) return null;
		return typeof r === 'string' ? r : 'This image is read-only.';
	};
	const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
	const run = () => styles.check('image-editor', controller.getState(), scope);

	const check: AgentTool = {
		name: 'check_image_style',
		title: 'Check image house style',
		description:
			'Checks the image against the house style (see get_style with domain "image-editor"): aspect-ratio, min-size, adjustment-ranges, and the brand\'s palette-only, min-contrast and fonts-allowed on annotations. Returns findings with a severity, a sentence saying how to fix it, a target ({ crop } with the centred crop for set_crop, { adjustment, value } with the clamped value, { annotation: id } or { image: true }) and the layer that asked; the checks that ran and those skipped. fix_image_style clamps the adjustments at once.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Check image house style', ...READ },
		handler: async () => {
			const { style, ...report } = await run();
			return {
				...report,
				ok: report.findings.length === 0,
				...(style.skills.length ? {} : { note: 'No house style applies to images.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};

	const fix: AgentTool = {
		name: 'fix_image_style',
		title: 'Fix image house style',
		description:
			'Clamps the base adjustments into the house ranges as one undo step. Returns the adjustments it changed and the findings left for you (crop to a house ratio with set_crop and the finding\'s crop; size and annotation colours you change yourself). Run check_image_style after.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Fix image house style', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async () => {
			const reason = readOnlyReason();
			if (reason) throw new Error(reason);
			const { findings } = await run();
			const patch: Partial<ImageAdjustments> = {};
			const left: StyleFinding[] = [];
			for (const f of findings) {
				const t = f.target as ImageStyleTarget | undefined;
				if (t && 'adjustment' in t) (patch as Record<string, number>)[t.adjustment] = t.value;
				else left.push(f);
			}
			if (Object.keys(patch).length) controller.setAdjustments(patch, true);
			return { fixed: patch, left };
		}
	};

	return {
		id: options.id ?? 'image-style',
		namespace: options.namespace,
		title: 'Image house style',
		description: 'Check an image against the house style and clamp its adjustments.',
		skill: 'pixerate-image-editor',
		tools: () => (readOnlyReason() ? [check] : [check, fix])
	};
}
