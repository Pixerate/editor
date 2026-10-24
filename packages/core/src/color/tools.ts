/**
 * Agent tools for colour inspection, contrast verification, palette checking, harmonies, and mixing.
 */

import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import { parseColor } from './parse.js';
import { formatColor, formatHex } from './format.js';
import { relativeLuminance, contrastRatio, contrastLevel } from './contrast.js';
import { checkPaletteColors } from './vision.js';
import { colorHarmony, HARMONY_KINDS, type ColorWheel, type HarmonyKind } from './harmony.js';
import { mixColors } from './mix.js';
import { rgbToHsl, rgbToOklab, oklabToOklch, oklchToOklab, oklabToRgb } from './convert.js';
import { inSrgbGamut, toSrgbGamut } from './gamut.js';
import type { ColorFormat, ColorVision, Rgba } from './types.js';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const fail = (message: string): never => {
	throw new Error(message);
};

const COLOR_PARAM_DESC = 'Any CSS colour: hex, rgb(), hsl(), oklch(), oklab(), color(display-p3 …) or a name.';

function requireColor(input: unknown, name: string): Rgba {
	if (typeof input !== 'string' || !input.trim()) {
		fail(`"${String(input)}" is not a colour I can read; use hex (#2a4b8d), rgb(), hsl(), oklch() or a CSS colour name.`);
	}
	const parsed = parseColor(input);
	if (!parsed) {
		fail(`"${input}" is not a colour I can read; use hex (#2a4b8d), rgb(), hsl(), oklch() or a CSS colour name.`);
	}
	return parsed!;
}

export interface ColorToolProviderOptions {
	/** Provider id (unique per registry). Default 'color'. */
	id?: string;
	/** Tool-name prefix; defaults to provider id, '' for bare names. */
	namespace?: string;
}

/**
 * Creates an AgentToolProvider with colour inspection, contrast checks, palette checks,
 * harmony suggestions, and colour mixing.
 */
export function createColorToolProvider(options: ColorToolProviderOptions = {}): AgentToolProvider {
	const id = options.id ?? 'color';
	const namespace = options.namespace ?? 'color';

	const inspectColor: AgentTool = {
		name: 'inspect_color',
		title: 'Inspect colour',
		description:
			'Inspects a colour string across multiple colour spaces and formats, reporting hex, sRGB channels, HSL, OKLCH, wide-gamut status, gamut-mapped fallback, and relative luminance.',
		inputSchema: {
			type: 'object',
			properties: {
				color: { type: 'string', description: COLOR_PARAM_DESC }
			},
			required: ['color'],
			additionalProperties: false
		},
		annotations: { title: 'Inspect colour', ...READ },
		handler: (args: Record<string, any>) => {
			const { color } = args;
			const rgba = requireColor(color, 'color');
			const inGamut = inSrgbGamut(rgba);
			const mappedRgba = inGamut ? rgba : toSrgbGamut(rgba);
			const hsl = rgbToHsl(mappedRgba);
			const oklab = rgbToOklab(rgba);
			const oklch = oklabToOklch(oklab);

			const formats: ColorFormat[] = ['hex', 'rgb', 'hsl', 'oklab', 'oklch'];
			const css: Record<string, string> = {};
			for (const f of formats) {
				css[f] = formatColor(rgba, f);
			}

			return {
				hex: formatHex(mappedRgba),
				alpha: Math.round(rgba.a * 1000) / 1000,
				rgb: {
					r: Math.round(Math.min(1, Math.max(0, mappedRgba.r)) * 255),
					g: Math.round(Math.min(1, Math.max(0, mappedRgba.g)) * 255),
					b: Math.round(Math.min(1, Math.max(0, mappedRgba.b)) * 255)
				},
				hsl: {
					h: Math.round(hsl.h * 10) / 10,
					s: Math.round(hsl.s * 1000) / 1000,
					l: Math.round(hsl.l * 1000) / 1000
				},
				oklch: {
					l: Math.round(oklch.l * 1000) / 1000,
					c: Math.round(oklch.c * 1000) / 1000,
					h: Math.round(oklch.h * 10) / 10
				},
				css,
				inSrgbGamut: inGamut,
				...(inGamut ? {} : { gamutMappedHex: formatHex(mappedRgba) }),
				relativeLuminance: Math.round(relativeLuminance(mappedRgba) * 10000) / 10000
			};
		}
	};

	const checkColorContrast: AgentTool = {
		name: 'check_color_contrast',
		title: 'Check colour contrast',
		description:
			'Calculates WCAG 2 contrast ratio between foreground and background colours, checks AA and AAA thresholds, and suggests an adjusted foreground when contrast fails.',
		inputSchema: {
			type: 'object',
			properties: {
				foreground: { type: 'string', description: `Foreground text colour. ${COLOR_PARAM_DESC}` },
				background: { type: 'string', description: `Background surface colour. ${COLOR_PARAM_DESC}` },
				large: { type: 'boolean', description: 'Whether the text is large (at least 18pt / 24px regular, or 14pt / 18.5px bold). Default false.' }
			},
			required: ['foreground', 'background'],
			additionalProperties: false
		},
		annotations: { title: 'Check colour contrast', ...READ },
		handler: (args: Record<string, any>) => {
			const { foreground, background, large = false } = args;
			const fg = requireColor(foreground, 'foreground');
			const bg = requireColor(background, 'background');

			const ratio = Math.round(contrastRatio(fg, bg) * 100) / 100;
			const level = contrastLevel(ratio, { large });
			const passesAA = level === 'AA' || level === 'AAA';
			const passesAAA = level === 'AAA';

			let suggestion: string | undefined;
			if (!passesAA) {
				const lab = rgbToOklab(fg);
				const lch = oklabToOklch(lab);
				for (let d = 0.01; d <= 1; d += 0.01) {
					const downL = Math.max(0, lch.l - d);
					const upL = Math.min(1, lch.l + d);
					const downCand = toSrgbGamut(oklabToRgb(oklchToOklab({ ...lch, l: downL })));
					const upCand = toSrgbGamut(oklabToRgb(oklchToOklab({ ...lch, l: upL })));

					const downRatio = contrastRatio(downCand, bg);
					const upRatio = contrastRatio(upCand, bg);
					const downPass = contrastLevel(downRatio, { large }) !== 'fail';
					const upPass = contrastLevel(upRatio, { large }) !== 'fail';

					if (downPass && upPass) {
						suggestion = formatHex(downRatio >= upRatio ? downCand : upCand);
						break;
					} else if (downPass) {
						suggestion = formatHex(downCand);
						break;
					} else if (upPass) {
						suggestion = formatHex(upCand);
						break;
					}
				}
			}

			return {
				ratio,
				level,
				passesAA,
				passesAAA,
				...(suggestion ? { suggestion } : {})
			};
		}
	};

	const checkColorPalette: AgentTool = {
		name: 'check_color_palette',
		title: 'Check colour palette',
		description:
			'Audits a palette of colours for mutual distinctness under normal vision and colour-vision deficiencies (protanopia, deuteranopia, tritanopia), and checks contrast against a surface.',
		inputSchema: {
			type: 'object',
			properties: {
				colors: {
					type: 'array',
					items: { type: 'string' },
					minItems: 2,
					description: 'List of at least two palette colours to check.'
				},
				surface: { type: 'string', description: `Background / surface colour (default '#ffffff'). ${COLOR_PARAM_DESC}` },
				minDistance: { type: 'number', description: 'Minimum perceptual OKLab distance between series colours (default 0.08).' },
				minContrast: { type: 'number', description: 'Minimum contrast ratio against the surface (default 1.5).' },
				visions: {
					type: 'array',
					items: { type: 'string', enum: ['normal', 'protanopia', 'deuteranopia', 'tritanopia'] },
					description: 'Colour-vision conditions to simulate (defaults to all).'
				}
			},
			required: ['colors'],
			additionalProperties: false
		},
		annotations: { title: 'Check colour palette', ...READ },
		handler: (args: Record<string, any>) => {
			const { colors, surface, minDistance, minContrast, visions } = args;
			if (!Array.isArray(colors) || colors.length < 2) {
				fail('Palette check requires an array of at least 2 colours.');
			}
			for (const c of colors) {
				requireColor(c, 'colors item');
			}
			if (surface !== undefined) {
				requireColor(surface, 'surface');
			}
			return checkPaletteColors(colors, {
				surface,
				minDistance,
				minContrast,
				visions: visions as ColorVision[] | undefined
			});
		}
	};

	const suggestColorHarmony: AgentTool = {
		name: 'suggest_color_harmony',
		title: 'Suggest colour harmony',
		description:
			'Generates harmonic colour combinations (complementary, split-complementary, analogous, triadic, tetradic, square, monochromatic) on an RGB or artistic RYB colour wheel.',
		inputSchema: {
			type: 'object',
			properties: {
				base: { type: 'string', description: `Base colour. ${COLOR_PARAM_DESC}` },
				kind: {
					type: 'string',
					enum: [...HARMONY_KINDS],
					description: 'Harmony arrangement kind.'
				},
				wheel: {
					type: 'string',
					enum: ['rgb', 'ryb'],
					description: 'Colour wheel model: "rgb" (default) or "ryb" (artistic / painterly).'
				},
				spread: { type: 'number', description: 'Angular spread in degrees for analogous or split-complementary harmonies (default 30).' }
			},
			required: ['base', 'kind'],
			additionalProperties: false
		},
		annotations: { title: 'Suggest colour harmony', ...READ },
		handler: (args: Record<string, any>) => {
			const { base, kind, wheel = 'rgb', spread } = args;
			const rgba = requireColor(base, 'base');
			const hex = formatHex(toSrgbGamut(rgba));
			if (!HARMONY_KINDS.includes(kind as HarmonyKind)) {
				fail(`Unknown harmony kind "${kind}"; expected one of ${HARMONY_KINDS.join(', ')}.`);
			}
			const result = colorHarmony(hex, kind as HarmonyKind, {
				wheel: wheel as ColorWheel,
				spread
			});
			return {
				colors: result.map((c) => ({ hex: c.color, angle: c.angle }))
			};
		}
	};

	const blendColors: AgentTool = {
		name: 'blend_colors',
		title: 'Blend colours',
		description:
			'Interpolates between two colours in OKLab, OKLCH, sRGB, or sRGB-linear colour space, either at a single factor t (0–1) or as a multi-step gradient ramp.',
		inputSchema: {
			type: 'object',
			properties: {
				from: { type: 'string', description: `Start colour. ${COLOR_PARAM_DESC}` },
				to: { type: 'string', description: `End colour. ${COLOR_PARAM_DESC}` },
				t: { type: 'number', description: 'Blend position between 0 and 1 (required unless steps is provided).' },
				space: {
					type: 'string',
					enum: ['oklab', 'oklch', 'srgb', 'srgb-linear'],
					description: 'Colour space for interpolation (default "oklab").'
				},
				steps: {
					type: 'integer',
					minimum: 2,
					maximum: 32,
					description: 'When provided, returns this number of evenly spaced colours (2–32) from start to end, ignoring t.'
				}
			},
			required: ['from', 'to'],
			additionalProperties: false
		},
		annotations: { title: 'Blend colours', ...READ },
		handler: (args: Record<string, any>) => {
			const { from, to, t, space = 'oklab', steps } = args;
			requireColor(from, 'from');
			requireColor(to, 'to');

			const validSpaces = ['oklab', 'oklch', 'srgb', 'srgb-linear'] as const;
			type SpaceType = (typeof validSpaces)[number];
			if (!validSpaces.includes(space as SpaceType)) {
				fail(`Unknown space "${space}"; expected one of ${validSpaces.join(', ')}.`);
			}

			if (steps !== undefined) {
				if (!Number.isInteger(steps) || steps < 2 || steps > 32) {
					fail(`"steps" must be an integer between 2 and 32, got ${steps}.`);
				}
				const colors: string[] = [];
				for (let i = 0; i < steps; i++) {
					const factor = i / (steps - 1);
					const mixed = mixColors(from, to, factor, { space: space as SpaceType });
					if (mixed) colors.push(mixed);
				}
				return { colors };
			}

			if (t === undefined || typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1) {
				fail(`"t" must be a number between 0 and 1, got ${t}.`);
			}

			return {
				color: mixColors(from, to, t, { space: space as SpaceType })
			};
		}
	};

	return {
		id,
		namespace,
		title: 'Colour',
		description: 'Inspect colours, check contrast and accessibility, audit palettes, suggest harmonies, and interpolate colour blends.',
		skill: 'pixerate-color',
		tools: [inspectColor, checkColorContrast, checkColorPalette, suggestColorHarmony, blendColors]
	};
}
