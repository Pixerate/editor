/**
 * Agent tools for typography: font discovery and fallback stacks, modular scales and hierarchies,
 * fluid sizes, readability and accessibility audits, text segmentation, and a font picker.
 */

import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import { checkTypographyAccessibility } from './accessibility.js';
import { createSystemFontProvider, guessFontCategory } from './catalog.js';
import { auditTextReadability } from './metrics.js';
import type { FontPickerModel } from './picker.js';
import { filterFonts, findFont, type FontProvider } from './registry.js';
import { MODULAR_SCALE_RATIO_NAMES, computeFluidSize, computeTypeScale, generateTypeHierarchy, resolveScaleRatio, typeHierarchyToCss } from './scale.js';
import { segmentText } from './segment.js';
import { parseFontFamily, resolveFontFallback } from './stack.js';
import { FONT_CATEGORIES, FONT_STYLES, FONT_WEIGHTS, type FontCategory, type FontStyle, type FontWeight } from './types.js';
import { normalizeFontWeight } from './weight.js';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const CATEGORY_SCHEMA: JsonSchema = { type: 'string', enum: FONT_CATEGORIES, description: 'Font category: sans-serif, serif, monospace, display or handwriting.' };
const WEIGHT_SCHEMA: JsonSchema = {
	oneOf: [
		{ type: 'integer', enum: FONT_WEIGHTS, description: 'Numeric weight 100–900 in steps of 100.' },
		{ type: 'string', enum: ['normal', 'bold'], description: 'normal (400) or bold (700).' }
	],
	description: 'Font weight: 100–900 in steps of 100, or normal / bold. Default 400.'
};
const STYLE_SCHEMA: JsonSchema = { type: 'string', enum: FONT_STYLES, description: 'Font style: normal, italic or oblique. Default normal.' };
const RATIO_SCHEMA: JsonSchema = {
	oneOf: [
		{ type: 'string', enum: MODULAR_SCALE_RATIO_NAMES, description: 'Named ratio.' },
		{ type: 'number', exclusiveMinimum: 1, maximum: 4, description: 'Custom ratio above 1 and at most 4.' }
	],
	description: `Scale ratio: a name (${MODULAR_SCALE_RATIO_NAMES.join(', ')}) or a number above 1 and at most 4. Default major-third (1.25).`
};

const rejectUnknownRatio = (ratio: unknown) => {
	if (ratio === undefined) return;
	if (typeof ratio === 'string' || typeof ratio === 'number') resolveScaleRatio(ratio as never);
};

export interface TypographyToolProviderOptions {
	/** Provider id (unique per registry). Default 'typography'. */
	id?: string;
	/** Tool-name prefix; defaults to 'typography', '' for bare names. */
	namespace?: string;
	/** Where `list_fonts`, `resolve_font_stack` and `load_font` look. Default: the system font catalog. */
	provider?: FontProvider;
}

/**
 * An AgentToolProvider with font discovery, fallback stacks, type scales and hierarchies, fluid
 * sizes, readability and type-aware contrast audits, and text segmentation. `load_font` is only
 * listed when the font provider can load fonts.
 */
export function createTypographyToolProvider(options: TypographyToolProviderOptions = {}): AgentToolProvider {
	const fonts = options.provider ?? createSystemFontProvider();

	const listFonts: AgentTool = {
		name: 'list_fonts',
		title: 'List fonts',
		description:
			'Lists the fonts the host offers, optionally filtered by category, source, weight, style or a name query (families starting with the query first). Returns { fonts: [{ family, category, weights, styles, isVariable?, source }], total, truncated }. Use a family from here with resolve_font_stack, load_font or set_font_selection.',
		inputSchema: {
			type: 'object',
			properties: {
				category: CATEGORY_SCHEMA,
				source: { type: 'string', enum: ['system', 'web', 'custom'], description: 'Only fonts from this source: system (installed), web (loaded over the network) or custom (host-supplied).' },
				weight: WEIGHT_SCHEMA,
				style: STYLE_SCHEMA,
				query: { type: 'string', description: 'Case-insensitive part of the family name.' },
				limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Most fonts to return (default 50, max 500).' }
			},
			additionalProperties: false
		},
		annotations: { title: 'List fonts', ...READ },
		handler: async (args: Record<string, any>) => {
			const all = await fonts.listFonts();
			const kept = filterFonts(all, { category: args.category, source: args.source, weight: args.weight, style: args.style, query: args.query });
			const limit = args.limit ?? 50;
			return { fonts: kept.slice(0, limit), total: kept.length, truncated: kept.length > limit };
		}
	};

	const resolveFontStack: AgentTool = {
		name: 'resolve_font_stack',
		title: 'Resolve font stack',
		description:
			'Builds a resilient CSS font-family value for a family (or an existing stack): the family, then a tested cross-platform fallback stack for its category, ending in a generic family. Returns { stack, families, category, available } where available says whether the font provider lists the first family.',
		inputSchema: {
			type: 'object',
			properties: {
				family: { type: 'string', description: 'A family name (Inter) or a CSS font-family value ("Inter", Arial).' },
				category: { ...CATEGORY_SCHEMA, description: `${CATEGORY_SCHEMA.description} Default: from the catalog, or guessed from the name.` }
			},
			required: ['family'],
			additionalProperties: false
		},
		annotations: { title: 'Resolve font stack', ...READ },
		handler: async (args: Record<string, any>) => {
			const families = parseFontFamily(String(args.family ?? ''));
			if (!families.length) throw new Error('family must name at least one font, e.g. "Inter".');
			const first = families[0]!;
			const listed = findFont(await fonts.listFonts(), first);
			const category: FontCategory = args.category ?? listed?.category ?? guessFontCategory(first);
			const stack = resolveFontFallback(args.family, category);
			return { stack, families: parseFontFamily(stack), category, available: !!listed || !!(await fonts.hasFont(first)) };
		}
	};

	const suggestTypeScale: AgentTool = {
		name: 'suggest_type_scale',
		title: 'Suggest type scale',
		description:
			'Computes a modular type scale: size = baseSize × ratio^step for each step, with a recommended unitless line-height and tracking (em) per size. Returns { ratio, baseSize, steps: [{ name, step, size, lineHeight, letterSpacing }] }. For named heading tokens use generate_type_hierarchy instead.',
		inputSchema: {
			type: 'object',
			properties: {
				baseSize: { type: 'number', exclusiveMinimum: 0, maximum: 512, description: 'Size of step 0 in px (default 16).' },
				ratio: RATIO_SCHEMA,
				steps: { type: 'array', items: { type: 'integer', minimum: -12, maximum: 12, description: 'Step exponent.' }, minItems: 1, maxItems: 25, description: 'Integer steps to compute, -12 to 12 (default -2 to 5).' }
			},
			additionalProperties: false
		},
		annotations: { title: 'Suggest type scale', ...READ },
		handler: (args: Record<string, any>) => {
			const baseSize = args.baseSize ?? 16;
			const ratio = resolveScaleRatio(args.ratio ?? 'major-third');
			return { ratio, baseSize, steps: computeTypeScale(baseSize, ratio, args.steps) };
		}
	};

	const generateHierarchy: AgentTool = {
		name: 'generate_type_hierarchy',
		title: 'Generate type hierarchy',
		description:
			'Generates typographic tokens caption, body-sm, body, h4, h3, h2, h1 and display on one modular scale, with line-heights (1.5 for body sizes, tighter for headings) and tracking. Returns { ratio, ratioName?, baseSize, steps: { <name>: { size, lineHeight, letterSpacing, step } }, css } where css declares --<prefix>-<name>-size / -line-height / -letter-spacing custom properties.',
		inputSchema: {
			type: 'object',
			properties: {
				baseSize: { type: 'number', exclusiveMinimum: 0, maximum: 512, description: 'Body size in px (default 16).' },
				ratio: RATIO_SCHEMA,
				prefix: { type: 'string', pattern: '^[a-z][a-z0-9-]*$', description: 'Custom property prefix (default "font").' },
				selector: { type: 'string', description: 'CSS selector for the custom properties (default ":root").' }
			},
			additionalProperties: false
		},
		annotations: { title: 'Generate type hierarchy', ...READ },
		handler: (args: Record<string, any>) => {
			rejectUnknownRatio(args.ratio);
			const hierarchy = generateTypeHierarchy({ baseSize: args.baseSize, ratio: args.ratio });
			return { ...hierarchy, css: typeHierarchyToCss(hierarchy, { prefix: args.prefix, selector: args.selector }) };
		}
	};

	const fluidSize: AgentTool = {
		name: 'compute_fluid_type_size',
		title: 'Compute fluid type size',
		description:
			'Computes a font size that scales linearly with viewport width between two breakpoints, as a CSS clamp() with rem bounds (so browser zoom and font settings still apply). Returns { clampCss, slope, intercept, samples: [{ viewport, size }] } with sizes at both breakpoints and the midpoint.',
		inputSchema: {
			type: 'object',
			properties: {
				minSize: { type: 'number', exclusiveMinimum: 0, description: 'Size in px at minViewport and below.' },
				maxSize: { type: 'number', exclusiveMinimum: 0, description: 'Size in px at maxViewport and above.' },
				minViewport: { type: 'number', exclusiveMinimum: 0, description: 'Viewport width in px where scaling starts (e.g. 375).' },
				maxViewport: { type: 'number', exclusiveMinimum: 0, description: 'Viewport width in px where scaling stops (e.g. 1440).' },
				rootFontSize: { type: 'number', exclusiveMinimum: 0, description: 'Root font size in px for rem values (default 16).' }
			},
			required: ['minSize', 'maxSize', 'minViewport', 'maxViewport'],
			additionalProperties: false
		},
		annotations: { title: 'Compute fluid type size', ...READ },
		handler: (args: Record<string, any>) => {
			const fluid = computeFluidSize(args as never);
			const mid = (args.minViewport + args.maxViewport) / 2;
			return {
				clampCss: fluid.clampCss,
				slope: fluid.slope,
				intercept: fluid.intercept,
				samples: [args.minViewport, mid, args.maxViewport].map((viewport: number) => ({ viewport, size: fluid.evaluateAt(viewport) }))
			};
		}
	};

	const auditReadability: AgentTool = {
		name: 'audit_text_readability',
		title: 'Audit text readability',
		description:
			'Audits body text for line length (45–75 characters per line), line spacing (at least 1.5, WCAG 1.4.8), long runs of capitals, tiny sizes and tight tracking, and estimates reading time. Line length comes from the text\'s own line breaks, or is estimated from width and fontSize when both are given. Returns { lineLength: { characters, words, source, status, recommendation? }, lineSpacing: { ratio, assumed, meetsRecommended, recommendation? }, allCaps, wordCount, estimatedReadingTimeSeconds, issues }.',
		inputSchema: {
			type: 'object',
			properties: {
				text: { type: 'string', maxLength: 100000, description: 'The text as it is set, with its line breaks.' },
				fontSize: { type: 'number', exclusiveMinimum: 0, description: 'Font size in px.' },
				lineHeight: { type: 'number', exclusiveMinimum: 0, description: 'Unitless line-height (1.5 = 150 %). Default: assumed 1.2 (browser normal).' },
				letterSpacing: { type: 'number', description: 'Tracking in em (default 0).' },
				width: { type: 'number', exclusiveMinimum: 0, description: 'Column width in px; with fontSize, estimates characters per line.' },
				category: { ...CATEGORY_SCHEMA, description: `${CATEGORY_SCHEMA.description} Used to estimate character width (default sans-serif).` }
			},
			required: ['text'],
			additionalProperties: false
		},
		annotations: { title: 'Audit text readability', ...READ },
		handler: (args: Record<string, any>) => {
			if (args.width !== undefined && args.fontSize === undefined) throw new Error('width needs fontSize to estimate characters per line; pass both, or neither to measure the text\'s own lines.');
			return auditTextReadability(args.text, { size: args.fontSize, lineHeight: args.lineHeight, letterSpacing: args.letterSpacing, width: args.width, category: args.category });
		}
	};

	const checkAccessibility: AgentTool = {
		name: 'check_typography_accessibility',
		title: 'Check typography accessibility',
		description:
			'Checks text colour against its background with the real font size and weight: decides WCAG 2 large text (24px, or 18.67px bold) itself, reports the ratio, level and required AA / AAA ratios, flags tiny or thin type, and suggests a passing foreground (same hue, nearest OKLCH lightness) when AA fails. Returns { ratio, large, level, passesAA, passesAAA, required: { AA, AAA }, suggestion?, largeTextMinSize, issues }.',
		inputSchema: {
			type: 'object',
			properties: {
				foreground: { type: 'string', description: 'Text colour: hex, rgb(), hsl(), oklch() or a CSS colour name.' },
				background: { type: 'string', description: 'Surface colour behind the text, same formats.' },
				fontSize: { type: 'number', exclusiveMinimum: 0, description: 'Font size in CSS px (12pt = 16px).' },
				fontWeight: WEIGHT_SCHEMA
			},
			required: ['foreground', 'background', 'fontSize'],
			additionalProperties: false
		},
		annotations: { title: 'Check typography accessibility', ...READ },
		handler: (args: Record<string, any>) => checkTypographyAccessibility({ font: { size: args.fontSize, weight: args.fontWeight }, foreground: args.foreground, background: args.background })
	};

	const segment: AgentTool = {
		name: 'segment_text',
		title: 'Segment text',
		description:
			'Splits text into graphemes (letters as people see them, emoji included), words, sentences or lines, with UTF-16 start/end offsets, for staggering live text in animation without converting it to outlines. Returns { segments: [{ text, start, end, index, isWordLike? }], count }.',
		inputSchema: {
			type: 'object',
			properties: {
				text: { type: 'string', maxLength: 100000, description: 'Text to split.' },
				granularity: { type: 'string', enum: ['grapheme', 'word', 'sentence', 'line'], description: 'grapheme, word, sentence or line (line breaks, plus wrapping with maxCharacters).' },
				locale: { type: 'string', description: 'BCP 47 locale for word and sentence rules (default: the runtime locale).' },
				wordsOnly: { type: 'boolean', description: 'For word: drop spaces and punctuation (default false).' },
				maxCharacters: { type: 'integer', minimum: 1, description: 'For line: wrap lines longer than this many characters at word boundaries.' }
			},
			required: ['text', 'granularity'],
			additionalProperties: false
		},
		annotations: { title: 'Segment text', ...READ },
		handler: (args: Record<string, any>) => {
			if (args.wordsOnly !== undefined && args.granularity !== 'word') throw new Error('wordsOnly only applies to granularity "word".');
			if (args.maxCharacters !== undefined && args.granularity !== 'line') throw new Error('maxCharacters only applies to granularity "line".');
			const segments = segmentText(args.text, args.granularity, { locale: args.locale, wordsOnly: args.wordsOnly, maxCharacters: args.maxCharacters });
			return { segments, count: segments.length };
		}
	};

	const loadFont: AgentTool = {
		name: 'load_font',
		title: 'Load font',
		description:
			'Loads a font face through the host so it can render (web fonts are fetched; installed fonts are ready at once). Call it before rendering or capturing text in a family from list_fonts. Returns { family, weight, style, loaded }; loaded false means the face could not be loaded and a fallback will show.',
		inputSchema: {
			type: 'object',
			properties: {
				family: { type: 'string', description: 'Family name from list_fonts.' },
				weight: WEIGHT_SCHEMA,
				style: STYLE_SCHEMA
			},
			required: ['family'],
			additionalProperties: false
		},
		annotations: { title: 'Load font', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		handler: async (args: Record<string, any>) => {
			const listed = findFont(await fonts.listFonts(), String(args.family));
			if (!listed) throw new Error(`Font "${args.family}" is not offered by this host; call list_fonts to see the families you can load.`);
			const weight = normalizeFontWeight(args.weight as FontWeight | undefined);
			const style: FontStyle = args.style ?? 'normal';
			const loaded = await fonts.loadFont!(listed.family, weight, style);
			return { family: listed.family, weight, style, loaded };
		}
	};

	return {
		id: options.id ?? 'typography',
		namespace: options.namespace ?? 'typography',
		title: 'Typography',
		description:
			'List and load fonts, build fallback stacks, generate type scales and hierarchies, compute fluid sizes, audit readability and type-aware contrast, and split text for animation.',
		skill: 'pixerate-typography',
		tools: [listFonts, resolveFontStack, suggestTypeScale, generateHierarchy, fluidSize, auditReadability, checkAccessibility, segment, ...(fonts.loadFont ? [loadFont] : [])]
	};
}

export interface FontPickerToolProviderOptions {
	/** Provider id (unique per registry). Default 'font-picker'. */
	id?: string;
	/** Tool-name prefix; defaults to 'fontpicker', '' for bare names. */
	namespace?: string;
	/** Refuse `set_font_selection` (with this reason) while true; read tools still work. */
	readOnly?: () => string | false;
}

/**
 * Tools that read and change a mounted {@link FontPickerModel}, so an agent can choose a font in
 * the same control a person uses.
 */
export function createFontPickerToolProvider(model: FontPickerModel, options: FontPickerToolProviderOptions = {}): AgentToolProvider {
	const snapshot = () => ({ value: model.value, css: model.css, availableWeights: model.availableWeights, availableStyles: model.availableStyles });

	const getSelection: AgentTool = {
		name: 'get_font_selection',
		title: 'Get font selection',
		description:
			'Returns the font picker\'s current value and what the chosen family offers: { value: { family, weight, style, size, lineHeight, letterSpacing, category? }, css: { fontFamily, fontWeight, fontStyle, fontSize, lineHeight, letterSpacing }, availableWeights, availableStyles }.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Get font selection', ...READ },
		handler: () => snapshot()
	};

	const setSelection: AgentTool = {
		name: 'set_font_selection',
		title: 'Set font selection',
		description:
			'Changes the font picker in one step: any of family (from list_fonts), weight, style, size, lineHeight and letterSpacing. A weight the family lacks snaps to the nearest one it has. Everything is validated before anything changes. Returns the new selection, as get_font_selection does.',
		inputSchema: {
			type: 'object',
			properties: {
				family: { type: 'string', description: 'Family name the picker lists (see list_fonts).' },
				weight: WEIGHT_SCHEMA,
				style: STYLE_SCHEMA,
				size: { type: 'number', minimum: 1, maximum: 1000, description: 'Font size in px, 1–1000.' },
				lineHeight: { type: 'number', minimum: 0.5, maximum: 4, description: 'Unitless line-height, 0.5–4.' },
				letterSpacing: { type: 'number', minimum: -0.5, maximum: 1, description: 'Tracking in em, -0.5–1.' }
			},
			additionalProperties: false
		},
		annotations: { title: 'Set font selection', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: (args: Record<string, any>) => {
			const reason = options.readOnly?.();
			if (reason) throw new Error(`The font picker is read-only: ${reason}`);
			if (!Object.keys(args).length) throw new Error('Pass at least one of family, weight, style, size, lineHeight or letterSpacing.');
			const { fonts } = model.getState();
			if (args.family !== undefined && fonts.length && !findFont(fonts, args.family)) {
				throw new Error(`Font "${args.family}" is not in the picker; call list_fonts and pass one of its families.`);
			}
			if (args.style !== undefined) {
				const font = args.family !== undefined ? findFont(fonts, args.family) : model.selectedFont;
				if (font && font.styles.length && !font.styles.includes(args.style)) throw new Error(`"${font.family}" has no ${args.style} style; it offers ${font.styles.join(', ')}.`);
			}
			if (args.family !== undefined) model.selectFamily(args.family);
			if (args.weight !== undefined) model.setWeight(args.weight);
			if (args.style !== undefined) model.setStyle(args.style);
			if (args.size !== undefined) model.setSize(args.size);
			if (args.lineHeight !== undefined) model.setLineHeight(args.lineHeight);
			if (args.letterSpacing !== undefined) model.setLetterSpacing(args.letterSpacing);
			return snapshot();
		}
	};

	const listPickerFonts: AgentTool = {
		name: 'list_picker_fonts',
		title: 'List picker fonts',
		description:
			'Lists the families this font picker offers, optionally filtered by category and a name query, newest recent families first in recent. Returns { fonts: [{ family, category, weights, styles, isVariable?, source }], recent: [family], total, truncated }.',
		inputSchema: {
			type: 'object',
			properties: {
				category: CATEGORY_SCHEMA,
				query: { type: 'string', description: 'Case-insensitive part of the family name.' },
				limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Most fonts to return (default 50, max 500).' }
			},
			additionalProperties: false
		},
		annotations: { title: 'List picker fonts', ...READ },
		handler: (args: Record<string, any>) => {
			const state = model.getState();
			const kept = filterFonts(state.fonts, { category: args.category, query: args.query });
			const limit = args.limit ?? 50;
			return { fonts: kept.slice(0, limit), recent: state.recent.map((f) => f.family), total: kept.length, truncated: kept.length > limit };
		}
	};

	return {
		id: options.id ?? 'font-picker',
		namespace: options.namespace ?? 'fontpicker',
		title: 'Font picker',
		description: 'Read and change the font picker on screen: family, weight, style, size, line height and letter spacing.',
		skill: 'pixerate-typography',
		tools: [getSelection, listPickerFonts, setSelection]
	};
}
