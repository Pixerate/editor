/**
 * Chart types offered as UI components (#819): a component library lists them the way this
 * library lists Flair's effects, and draws them from data without hand-written wrappers.
 *
 * `uiComponents()` returns one entry per type. Its `descriptor` is plain JSON in the shape of
 * `UiDescriptor` from `@pixerate/schemas` (`src/genui.ts`, `UiDescriptorSchema`), so a registry
 * stores it as it is; `render` draws the type from data as a standalone SVG string.
 */

import { hashValue } from '../generation/hash.js';
import { validateJsonSchema, type JsonSchema } from '../tools/schema.js';
import { layoutSparkline } from './sparkline.js';
import { DEFAULT_CHART_PALETTE, DEFAULT_CHART_THEME, createChartSpec } from './spec.js';
import { describeChart } from './summary.js';
import { chartSceneToSvg, chartToSvg } from './svg.js';
import type { ChartTheme } from './types.js';
import type { LinkFocusOptions } from '../interaction/linkFocus.js';
import {
	UI_VISUAL_DARK,
	UI_VISUAL_LIGHT,
	UI_VISUAL_PALETTE,
	braidInteraction,
	lineageInteraction,
	renderBraid,
	renderLineage,
	renderWeave,
	weaveInteraction,
	type BraidUiData,
	type LineageUiData,
	type UiVisualRenderInput,
	type WeaveUiData
} from './ui-visuals.js';

// --- Mirrors of @pixerate/schemas `genui.ts` (Pixerate/schemas#80). This library does not depend
// on @pixerate/schemas, so the shapes are copied here (as `effects/types.ts` mirrors Flair's).
// Keep them in step: a descriptor must parse with `UiDescriptorSchema`.

/** Any JSON value (schemas `JsonValue`). */
export type UiJsonValue = string | number | boolean | null | UiJsonValue[] | { [key: string]: UiJsonValue };

/** Every platform a provider can render on (schemas `PlatformTarget`). */
export type UiPlatformTarget = 'svelte' | 'react' | 'webcomponent' | 'swiftui' | 'compose' | 'html-page';

/** Which group a component type belongs to (schemas `UiComponentGroup`). */
export type UiComponentGroup = 'baseline' | 'data-visual' | 'paradigm';

/**
 * A colour role (schemas `UiColorRole`): kebab-case, one of `UI_COLOR_ROLES` (`surface`, `ink`,
 * `ink-muted`, `accent`, `border`, `danger`, …) or another kebab-case name.
 */
export type UiColorRole = string;

/** A controlled value (schemas `UiStateField`). */
export interface UiStateField {
	name: string;
	schema?: Record<string, UiJsonValue>;
	event?: string;
	description?: string;
}

/** An event a component fires (schemas `UiEvent`). */
export interface UiEvent {
	name: string;
	payload?: Record<string, UiJsonValue>;
	description?: string;
}

/** Accessibility (schemas `UiA11y`). */
export interface UiA11y {
	/** ARIA role, e.g. `img` or `figure`. */
	role?: string;
	/** Key → what it does. */
	keyboard: Record<string, string>;
	/** Where the accessible name comes from; `content` means a description built from the data. */
	labelFrom?: 'prop' | 'children' | 'aria-label' | 'content';
	/** Progress (0–1) to show, still, under prefers-reduced-motion. */
	reducedMotionAt?: number;
}

/** How a component sizes itself (schemas `UiSizing`); lengths in CSS px. */
export interface UiSizing {
	mode: 'intrinsic' | 'fill';
	minWidth?: number;
	minHeight?: number;
	/** width / height, for components that keep a shape. */
	aspectRatio?: number;
}

/** What a component type takes and does (schemas `UiComponentContract`). */
export interface UiComponentContract {
	/** JSON Schema for props (for a data visual, its data). */
	props?: Record<string, UiJsonValue>;
	state: UiStateField[];
	events: UiEvent[];
	a11y?: UiA11y;
	/** The colour roles the component draws with. */
	colorRoles: UiColorRole[];
	/** Whether it follows the page motion contract (schemas `PageMotionInfo`). */
	motion: boolean;
	sizing?: UiSizing;
}

/** What a provider attaches to an item it offers as a UI component (schemas `UiDescriptor`). */
export interface UiDescriptor {
	/** The component type id it implements, e.g. `bar-chart`. */
	implements: string;
	group?: UiComponentGroup;
	contract?: Partial<UiComponentContract>;
	platforms: UiPlatformTarget[];
	swiftReady?: boolean;
	/** Example props or data, for previews and checks. */
	example?: Record<string, UiJsonValue>;
	/** Changes whenever the item's output changes, so a sync can tell. */
	contentHash?: string;
}

// --- Chart UI components ---

export type ChartUiComponentId = 'sparkline' | 'bar-chart' | 'line-chart' | 'donut-chart' | 'lineage' | 'braid' | 'weave';

export type ChartUiThemeMode = 'light' | 'dark';

export interface ChartUiRenderOptions {
	/** Width in CSS px (1–4096). */
	width: number;
	/** Height in CSS px (1–4096). */
	height: number;
	/** Which default colours to use (default `light`). */
	theme?: ChartUiThemeMode;
	/**
	 * Colour role → CSS colour (`#hex`, `rgb()`, `var(--x, #fallback)`, …), over the theme's
	 * defaults. Roles the component does not list in `contract.colorRoles` are ignored.
	 */
	colors?: Partial<Record<UiColorRole, string>>;
	/**
	 * For components with `contract.motion`: the progress to draw, 0–1 (default 1, the picture at
	 * rest). Frame-pure, so a host animates by drawing again (the page motion contract's `seek`).
	 */
	progress?: number;
	/**
	 * For components with `interaction`: the focused key (from `interaction(data).order`), whose
	 * linked marks stay lit while the rest dim; null or absent for none.
	 */
	focus?: string | null;
	/** Opacity of marks out of focus, 0–1 (default 0.25). */
	dim?: number;
}

/** A sparkline's data (`sparkline` contract props). */
export interface SparklineUiData {
	values: number[];
	/** Accessible name, e.g. "Weekly sign-ups". */
	label?: string;
}

/** A bar chart's data (`bar-chart` contract props). */
export interface BarChartUiData {
	categories: string[];
	series: { name: string; values: number[] }[];
	title?: string;
	/** Written after every tick and value label, e.g. "%" or " kWh". */
	unit?: string;
}

/** A chart type offered as a UI component. */
export interface ChartUiComponent {
	/** Same as `descriptor.implements`. */
	id: ChartUiComponentId;
	title: string;
	description: string;
	/** Plain JSON in the shape of `UiDescriptor`; store it as it is. */
	descriptor: UiDescriptor;
	/** Each role in `descriptor.contract.colorRoles` → which chart colours it drives. */
	colorRoleUse: Record<UiColorRole, string>;
	/** The colours used for roles a render does not pass, per theme. */
	defaultColors: Record<ChartUiThemeMode, Record<UiColorRole, string>>;
	/**
	 * Draws `data` (checked against `descriptor.contract.props`) as a standalone, accessible SVG
	 * document string (`role="img"`, `<title>`, `<desc>`). Throws when the data or size is invalid,
	 * saying what is wrong.
	 */
	render(data: unknown, options: ChartUiRenderOptions): string;
	/**
	 * For components that respond to pointer and keyboard: the `createLinkFocus` options for
	 * `data` (each mark's keys, the links, the keyboard order and labels). Drive a model with
	 * hover, focus and keys, and pass its `focus` to `render`. Marks carry `data-link-focus`.
	 */
	interaction?(data: unknown): LinkFocusOptions;
}

/**
 * Per-type render versions. Bump a type's version when its drawing changes in a way its contract
 * and example renders do not show (they are hashed too), so `contentHash` changes with it.
 */
export const CHART_UI_RENDER_VERSIONS: Readonly<Record<ChartUiComponentId, number>> = { sparkline: 1, 'bar-chart': 1, 'line-chart': 1, 'donut-chart': 1, lineage: 1, braid: 1, weave: 1 };

const DARK = { surface: '#0f172a', ink: '#e2e8f0', inkMuted: '#94a3b8', border: '#334155', axis: '#64748b' } as const;

const NUMBER: JsonSchema = { type: 'number', description: 'A finite number.' };

const SPARKLINE_PROPS: JsonSchema = {
	type: 'object',
	properties: {
		values: { type: 'array', items: NUMBER, minItems: 1, maxItems: 100000, description: 'The values in order, left to right.' },
		label: { type: 'string', description: 'Accessible name, e.g. "Weekly sign-ups" (default: a description of the values).' }
	},
	required: ['values'],
	additionalProperties: false
};

const BAR_CHART_PROPS: JsonSchema = {
	type: 'object',
	properties: {
		categories: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 500, description: 'Category labels along the axis, in order.' },
		series: {
			type: 'array',
			minItems: 1,
			maxItems: 20,
			description: 'One bar per category for each series; several series are grouped side by side.',
			items: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Series name (legend).' },
					values: { type: 'array', items: NUMBER, description: 'One value per category, in category order.' }
				},
				required: ['name', 'values'],
				additionalProperties: false
			}
		},
		title: { type: 'string', description: 'Title drawn above the chart and used as its accessible name.' },
		unit: { type: 'string', description: 'Written after every tick and value, e.g. "%" or " kWh".' }
	},
	required: ['categories', 'series'],
	additionalProperties: false
};

const SPARKLINE_EXAMPLE: SparklineUiData = { values: [12, 15, 14, 18, 22, 21, 26, 24, 29, 33], label: 'Weekly sign-ups' };

const BAR_CHART_EXAMPLE: BarChartUiData = {
	title: 'Quarterly revenue',
	unit: 'k',
	categories: ['Q1', 'Q2', 'Q3', 'Q4'],
	series: [
		{ name: '2025', values: [120, 135, 128, 160] },
		{ name: '2026', values: [140, 152, 149, 181] }
	]
};

function check(id: ChartUiComponentId, data: unknown, schema: JsonSchema, options: ChartUiRenderOptions): void {
	const errors = validateJsonSchema(data, schema);
	if (errors.length) throw new Error(`${id}: invalid data: ${errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ')}`);
	const { width, height } = options ?? ({} as ChartUiRenderOptions);
	for (const [name, v] of [['width', width], ['height', height]] as const) {
		if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 4096) throw new Error(`${id}: ${name} must be a number of CSS px from 1 to 4096 (got ${String(v)}).`);
	}
	if (options.theme !== undefined && options.theme !== 'light' && options.theme !== 'dark') throw new Error(`${id}: theme must be "light" or "dark" (got ${String(options.theme)}).`);
	if (options.progress !== undefined && (typeof options.progress !== 'number' || !(options.progress >= 0 && options.progress <= 1))) throw new Error(`${id}: progress must be a number from 0 to 1 (got ${String(options.progress)}).`);
	if (options.dim !== undefined && (typeof options.dim !== 'number' || !(options.dim >= 0 && options.dim <= 1))) throw new Error(`${id}: dim must be a number from 0 to 1 (got ${String(options.dim)}).`);
}

function roleColors(roles: readonly UiColorRole[], defaults: ChartUiComponent['defaultColors'], options: ChartUiRenderOptions): Record<UiColorRole, string> {
	const out = { ...defaults[options.theme ?? 'light'] };
	for (const [role, color] of Object.entries(options.colors ?? {})) {
		if (roles.includes(role) && typeof color === 'string' && color.trim()) out[role] = color.trim();
	}
	return out;
}

function sparklineComponent(): Omit<ChartUiComponent, 'descriptor'> & { contract: UiComponentContract; example: SparklineUiData } {
	const contract: UiComponentContract = {
		props: SPARKLINE_PROPS as Record<string, UiJsonValue>,
		state: [],
		events: [],
		a11y: { role: 'img', keyboard: {}, labelFrom: 'content' },
		colorRoles: ['accent'],
		motion: false,
		sizing: { mode: 'intrinsic', minWidth: 24, minHeight: 8, aspectRatio: 5 }
	};
	const self = {
		id: 'sparkline' as const,
		title: 'Sparkline',
		description: 'A word-sized line chart of one run of values, without axes or labels.',
		contract,
		example: SPARKLINE_EXAMPLE,
		colorRoleUse: { accent: 'The line.' },
		defaultColors: { light: { accent: DEFAULT_CHART_PALETTE[0]! }, dark: { accent: DEFAULT_CHART_PALETTE[7]! } },
		render(data: unknown, options: ChartUiRenderOptions): string {
			check('sparkline', data, SPARKLINE_PROPS, options);
			const d = data as SparklineUiData;
			const colors = roleColors(contract.colorRoles, self.defaultColors, options);
			const description = describeChart(createChartSpec({ type: 'line', title: d.label ?? '', categories: d.values.map((_, i) => String(i + 1)), series: [{ id: 's1', name: d.label || 'Values', values: [...d.values] }] }));
			const scene = layoutSparkline(d.values, { kind: 'line', width: options.width, height: options.height, color: colors.accent });
			return chartSceneToSvg(scene, { ariaLabel: d.label || description, description });
		}
	};
	return self;
}

function barChartComponent(): Omit<ChartUiComponent, 'descriptor'> & { contract: UiComponentContract; example: BarChartUiData } {
	const contract: UiComponentContract = {
		props: BAR_CHART_PROPS as Record<string, UiJsonValue>,
		state: [],
		events: [],
		a11y: { role: 'img', keyboard: {}, labelFrom: 'content' },
		colorRoles: ['surface', 'ink', 'ink-muted', 'border', 'accent'],
		motion: false,
		sizing: { mode: 'fill', minWidth: 160, minHeight: 120 }
	};
	const light: Record<UiColorRole, string> = { surface: DEFAULT_CHART_THEME.surface, ink: DEFAULT_CHART_THEME.text, 'ink-muted': DEFAULT_CHART_THEME.mutedText, border: DEFAULT_CHART_THEME.grid, accent: DEFAULT_CHART_PALETTE[0]! };
	const dark: Record<UiColorRole, string> = { surface: DARK.surface, ink: DARK.ink, 'ink-muted': DARK.inkMuted, border: DARK.border, accent: DEFAULT_CHART_PALETTE[7]! };
	const self = {
		id: 'bar-chart' as const,
		title: 'Bar chart',
		description: 'Vertical bars comparing values across categories, one colour per series, with a value axis and a legend for several series.',
		contract,
		example: BAR_CHART_EXAMPLE,
		colorRoleUse: {
			surface: 'Background behind the chart (theme background and surface).',
			ink: 'Title and legend text (theme text).',
			'ink-muted': 'Tick labels and axis lines (theme mutedText and axis).',
			border: 'Grid lines (theme grid).',
			accent: 'The first series; further series take the next colours of the categorical chart palette.'
		},
		defaultColors: { light, dark },
		render(data: unknown, options: ChartUiRenderOptions): string {
			check('bar-chart', data, BAR_CHART_PROPS, options);
			const d = data as BarChartUiData;
			for (const s of d.series) {
				if (s.values.length !== d.categories.length) throw new Error(`bar-chart: series "${s.name}" has ${s.values.length} values for ${d.categories.length} categories; give one value per category.`);
			}
			const c = roleColors(contract.colorRoles, self.defaultColors, options);
			const format = d.unit ? { suffix: d.unit } : {};
			const base = createChartSpec({ type: 'bar' });
			const spec = createChartSpec({
				type: 'bar',
				title: d.title ?? '',
				categories: [...d.categories],
				series: d.series.map((s, i) => ({ id: `s${i + 1}`, name: s.name, values: [...s.values] })),
				palette: [c.accent!, ...DEFAULT_CHART_PALETTE.slice(1)],
				legend: { ...base.legend, show: d.series.length > 1 },
				yAxis: { ...base.yAxis, format }
			});
			const theme: Partial<ChartTheme> = { background: c.surface!, surface: c.surface!, text: c.ink!, mutedText: c['ink-muted']!, axis: c['ink-muted']!, grid: c.border! };
			return chartToSvg(spec, { width: options.width, height: options.height, theme, ariaLabel: d.title || describeChart(spec) });
		}
	};
	return self;
}

const LINE_CHART_PROPS: JsonSchema = {
	...BAR_CHART_PROPS,
	properties: {
		...(BAR_CHART_PROPS.properties as Record<string, JsonSchema>),
		categories: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 1000, description: 'Labels along the x axis, in order.' },
		series: { ...((BAR_CHART_PROPS.properties as Record<string, JsonSchema>).series as JsonSchema), description: 'One line per series, one value per category.' }
	}
};

const LINE_CHART_EXAMPLE: BarChartUiData = {
	title: 'Active users',
	unit: 'k',
	categories: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
	series: [
		{ name: 'Web', values: [42, 45, 51, 49, 58, 63] },
		{ name: 'Mobile', values: [30, 34, 33, 41, 46, 52] }
	]
};

/** A donut chart's data (`donut-chart` contract props). */
export interface DonutChartUiData {
	slices: { label: string; value: number }[];
	title?: string;
	unit?: string;
}

const DONUT_CHART_PROPS: JsonSchema = {
	type: 'object',
	properties: {
		slices: {
			type: 'array',
			minItems: 1,
			maxItems: 12,
			description: 'Parts of the whole, largest first reads best.',
			items: {
				type: 'object',
				properties: { label: { type: 'string', description: 'Slice label (legend).' }, value: { type: 'number', minimum: 0, description: 'Slice size, 0 or more.' } },
				required: ['label', 'value'],
				additionalProperties: false
			}
		},
		title: { type: 'string', description: 'Title drawn above the chart and used as its accessible name.' },
		unit: { type: 'string', description: 'Written after every value, e.g. "%".' }
	},
	required: ['slices'],
	additionalProperties: false
};

const DONUT_CHART_EXAMPLE: DonutChartUiData = {
	title: 'Traffic by channel',
	unit: '%',
	slices: [
		{ label: 'Search', value: 46 },
		{ label: 'Direct', value: 27 },
		{ label: 'Social', value: 17 },
		{ label: 'Email', value: 10 }
	]
};

const CHART_ROLES = ['surface', 'ink', 'ink-muted', 'border', 'accent'];
const chartLight = (): Record<UiColorRole, string> => ({ surface: DEFAULT_CHART_THEME.surface, ink: DEFAULT_CHART_THEME.text, 'ink-muted': DEFAULT_CHART_THEME.mutedText, border: DEFAULT_CHART_THEME.grid, accent: DEFAULT_CHART_PALETTE[0]! });
const chartDark = (): Record<UiColorRole, string> => ({ surface: DARK.surface, ink: DARK.ink, 'ink-muted': DARK.inkMuted, border: DARK.border, accent: DEFAULT_CHART_PALETTE[7]! });
const chartRoleUse = (accent: string) => ({
	surface: 'Background behind the chart (theme background and surface).',
	ink: 'Title and legend text (theme text).',
	'ink-muted': 'Tick labels and axis lines (theme mutedText and axis).',
	border: 'Grid lines (theme grid).',
	accent
});
const chartTheme = (c: Record<UiColorRole, string>): Partial<ChartTheme> => ({ background: c.surface!, surface: c.surface!, text: c.ink!, mutedText: c['ink-muted']!, axis: c['ink-muted']!, grid: c.border! });

function lineChartComponent(): Omit<ChartUiComponent, 'descriptor'> & { contract: UiComponentContract; example: BarChartUiData } {
	const contract: UiComponentContract = {
		props: LINE_CHART_PROPS as Record<string, UiJsonValue>,
		state: [],
		events: [],
		a11y: { role: 'img', keyboard: {}, labelFrom: 'content' },
		colorRoles: CHART_ROLES,
		motion: false,
		sizing: { mode: 'fill', minWidth: 200, minHeight: 120 }
	};
	const self = {
		id: 'line-chart' as const,
		title: 'Line chart',
		description: 'Lines showing how values change across ordered categories (time), one colour per series, with a value axis and a legend for several series.',
		contract,
		example: LINE_CHART_EXAMPLE,
		colorRoleUse: chartRoleUse('The first line; further lines take the next colours of the categorical chart palette.'),
		defaultColors: { light: chartLight(), dark: chartDark() },
		render(data: unknown, options: ChartUiRenderOptions): string {
			check('line-chart', data, LINE_CHART_PROPS, options);
			const d = data as BarChartUiData;
			for (const s of d.series) {
				if (s.values.length !== d.categories.length) throw new Error(`line-chart: series "${s.name}" has ${s.values.length} values for ${d.categories.length} categories; give one value per category.`);
			}
			const c = roleColors(contract.colorRoles, self.defaultColors, options);
			const base = createChartSpec({ type: 'line' });
			const spec = createChartSpec({
				type: 'line',
				title: d.title ?? '',
				categories: [...d.categories],
				series: d.series.map((s, i) => ({ id: `s${i + 1}`, name: s.name, values: [...s.values] })),
				palette: [c.accent!, ...DEFAULT_CHART_PALETTE.slice(1)],
				legend: { ...base.legend, show: d.series.length > 1 },
				yAxis: { ...base.yAxis, format: d.unit ? { suffix: d.unit } : {} }
			});
			return chartToSvg(spec, { width: options.width, height: options.height, theme: chartTheme(c), ariaLabel: d.title || describeChart(spec) });
		}
	};
	return self;
}

function donutChartComponent(): Omit<ChartUiComponent, 'descriptor'> & { contract: UiComponentContract; example: DonutChartUiData } {
	const contract: UiComponentContract = {
		props: DONUT_CHART_PROPS as Record<string, UiJsonValue>,
		state: [],
		events: [],
		a11y: { role: 'img', keyboard: {}, labelFrom: 'content' },
		colorRoles: ['surface', 'ink', 'accent'],
		motion: false,
		sizing: { mode: 'intrinsic', minWidth: 160, minHeight: 140, aspectRatio: 1.4 }
	};
	const roles = ['surface', 'ink', 'accent'];
	const pick = (all: Record<UiColorRole, string>) => Object.fromEntries(roles.map((r) => [r, all[r]!]));
	const self = {
		id: 'donut-chart' as const,
		title: 'Donut chart',
		description: 'Parts of a whole as slices of a ring, one colour per slice, with a legend.',
		contract,
		example: DONUT_CHART_EXAMPLE,
		colorRoleUse: {
			surface: 'Background behind the chart (theme background and surface).',
			ink: 'Title, legend and value text (theme text and mutedText).',
			accent: 'The first slice; further slices take the next colours of the categorical chart palette.'
		},
		defaultColors: { light: pick(chartLight()), dark: pick(chartDark()) },
		render(data: unknown, options: ChartUiRenderOptions): string {
			check('donut-chart', data, DONUT_CHART_PROPS, options);
			const d = data as DonutChartUiData;
			const c = roleColors(contract.colorRoles, self.defaultColors, options);
			const base = createChartSpec({ type: 'donut' });
			const spec = createChartSpec({
				type: 'donut',
				title: d.title ?? '',
				categories: d.slices.map((s) => s.label),
				series: [{ id: 's1', name: d.title || 'Values', values: d.slices.map((s) => s.value) }],
				palette: [c.accent!, ...DEFAULT_CHART_PALETTE.slice(1)],
				legend: { ...base.legend, show: true },
				yAxis: { ...base.yAxis, format: d.unit ? { suffix: d.unit } : {} }
			});
			const theme: Partial<ChartTheme> = { background: c.surface!, surface: c.surface!, text: c.ink!, mutedText: c.ink!, axis: c.ink!, grid: c.ink! };
			return chartToSvg(spec, { width: options.width, height: options.height, theme, ariaLabel: d.title || describeChart(spec) });
		}
	};
	return self;
}

// --- Data visuals on core's geometry, motion and focus (ui-visuals.ts) ---

const LABEL: JsonSchema = { type: 'string', minLength: 1, maxLength: 80, description: 'A short label.' };

const LINEAGE_PROPS: JsonSchema = {
	type: 'object',
	properties: {
		root: { ...LABEL, description: 'The root everything descends from, e.g. a team or a product.' },
		items: { type: 'array', minItems: 1, maxItems: 24, description: 'The row it fans out to, in order.', items: { type: 'object', properties: { label: LABEL }, required: ['label'], additionalProperties: false } },
		title: { type: 'string', description: 'Accessible name (default: built from the data).' }
	},
	required: ['root', 'items'],
	additionalProperties: false
};

const BRAID_PROPS: JsonSchema = {
	type: 'object',
	properties: {
		root: { ...LABEL, description: 'What the strands twist into, labelled at the braid\'s start.' },
		strands: {
			type: 'array',
			minItems: 2,
			maxItems: 6,
			description: 'The strands, each labelled at the braid\'s open end.',
			items: { type: 'object', properties: { name: LABEL, value: { type: 'number', minimum: 0, description: 'Optional weight: the heaviest strand is drawn thickest.' } }, required: ['name'], additionalProperties: false }
		},
		turns: { type: 'number', minimum: 0.5, maximum: 6, description: 'Whole twists along the braid (default 2.5).' },
		title: { type: 'string', description: 'Accessible name (default: built from the data).' }
	},
	required: ['strands'],
	additionalProperties: false
};

const WEAVE_PROPS: JsonSchema = {
	type: 'object',
	properties: {
		items: {
			type: 'array',
			minItems: 1,
			maxItems: 24,
			description: 'Items along the top, each with the tags it has; tags along the bottom in order of first appearance (at most 24).',
			items: { type: 'object', properties: { label: LABEL, tags: { type: 'array', items: LABEL, maxItems: 24, description: 'The tags this item has.' } }, required: ['label', 'tags'], additionalProperties: false }
		},
		title: { type: 'string', description: 'Accessible name (default: built from the data).' }
	},
	required: ['items'],
	additionalProperties: false
};

const LINEAGE_EXAMPLE: LineageUiData = { root: 'Platform', items: [{ label: 'Research' }, { label: 'Design' }, { label: 'Engineering' }, { label: 'Operations' }, { label: 'Customer success' }] };
const BRAID_EXAMPLE: BraidUiData = { root: '2026', strands: [{ name: 'Product', value: 5 }, { name: 'Design', value: 3 }, { name: 'Research', value: 2 }], turns: 2.5 };
const WEAVE_EXAMPLE: WeaveUiData = {
	items: [
		{ label: 'Atlas', tags: ['Design', 'Research'] },
		{ label: 'Beacon', tags: ['Data', 'Platform'] },
		{ label: 'Cinder', tags: ['Design', 'Data'] },
		{ label: 'Delta', tags: ['Platform'] },
		{ label: 'Ember', tags: ['Research', 'Data', 'Design'] }
	]
};

const FOCUS_EVENT: UiEvent = { name: 'focus', payload: { type: 'object', properties: { key: { type: ['string', 'null'] } }, required: ['key'] }, description: 'The focused key changed (hover, focus or arrow keys); null when cleared.' };
const FOCUS_STATE: UiStateField = { name: 'focus', schema: { type: ['string', 'null'] }, event: 'focus', description: 'The focused key, from interaction(data).order; its linked marks stay lit and the rest dim.' };
const FOCUS_KEYS: Record<string, string> = {
	ArrowRight: 'focus the next key',
	ArrowDown: 'focus the next key',
	ArrowLeft: 'focus the previous key',
	ArrowUp: 'focus the previous key',
	Home: 'focus the first key',
	End: 'focus the last key',
	Escape: 'clear the focus'
};

type VisualParts = Omit<ChartUiComponent, 'descriptor'> & { contract: UiComponentContract; example: object };

function visualComponent<D>(spec: {
	id: 'lineage' | 'braid' | 'weave';
	title: string;
	description: string;
	props: JsonSchema;
	example: D;
	roles: UiColorRole[];
	roleUse: Record<UiColorRole, string>;
	sizing: UiSizing;
	validate?: (data: D) => void;
	interaction: (data: D) => LinkFocusOptions;
	draw: (data: D, input: UiVisualRenderInput) => string;
}): VisualParts {
	const contract: UiComponentContract = {
		props: spec.props as Record<string, UiJsonValue>,
		state: [FOCUS_STATE],
		events: [FOCUS_EVENT],
		a11y: { role: 'img', keyboard: FOCUS_KEYS, labelFrom: 'content', reducedMotionAt: 1 },
		colorRoles: spec.roles,
		motion: true,
		sizing: spec.sizing
	};
	const all = {
		light: { surface: UI_VISUAL_LIGHT.surface, 'surface-raised': UI_VISUAL_LIGHT.raised, ink: UI_VISUAL_LIGHT.ink, 'ink-muted': UI_VISUAL_LIGHT.inkMuted, border: UI_VISUAL_LIGHT.border, accent: UI_VISUAL_PALETTE[0]! },
		dark: { surface: UI_VISUAL_DARK.surface, 'surface-raised': UI_VISUAL_DARK.raised, ink: UI_VISUAL_DARK.ink, 'ink-muted': UI_VISUAL_DARK.inkMuted, border: UI_VISUAL_DARK.border, accent: UI_VISUAL_PALETTE[7]! }
	};
	const defaultColors = {
		light: Object.fromEntries(spec.roles.map((r) => [r, all.light[r as keyof typeof all.light]])),
		dark: Object.fromEntries(spec.roles.map((r) => [r, all.dark[r as keyof typeof all.dark]]))
	};
	const self: VisualParts = {
		id: spec.id,
		title: spec.title,
		description: spec.description,
		contract,
		example: spec.example as object,
		colorRoleUse: spec.roleUse,
		defaultColors,
		render(data: unknown, options: ChartUiRenderOptions): string {
			check(spec.id, data, spec.props, options);
			spec.validate?.(data as D);
			const model = spec.interaction(data as D);
			const focus = options.focus ?? null;
			if (focus !== null && !(model.order ?? []).includes(focus)) throw new Error(`${spec.id}: focus "${focus}" is not one of its keys (${(model.order ?? []).join(', ')}).`);
			return spec.draw(data as D, { width: options.width, height: options.height, colors: roleColors(contract.colorRoles, defaultColors, options), progress: options.progress ?? 1, focus, dim: options.dim ?? 0.25 });
		},
		interaction(data: unknown): LinkFocusOptions {
			const errors = validateJsonSchema(data, spec.props);
			if (errors.length) throw new Error(`${spec.id}: invalid data: ${errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ')}`);
			return spec.interaction(data as D);
		}
	};
	return self;
}

function lineageComponent(): VisualParts {
	return visualComponent<LineageUiData>({
		id: 'lineage',
		title: 'Lineage',
		description: 'One root fanned out to a row of items with rounded connectors that never cross, labels sized to fit their columns; draws on from the root, and focusing an item lights its branch.',
		props: LINEAGE_PROPS,
		example: LINEAGE_EXAMPLE,
		roles: ['surface', 'ink', 'ink-muted', 'accent'],
		roleUse: { surface: 'Background.', ink: 'Root and item labels.', 'ink-muted': 'Connectors.', accent: 'Root and item dots.' },
		sizing: { mode: 'fill', minWidth: 240, minHeight: 160 },
		interaction: lineageInteraction,
		draw: renderLineage
	});
}

function braidComponent(): VisualParts {
	return visualComponent<BraidUiData>({
		id: 'braid',
		title: 'Braid',
		description: 'Strands twisted into one root, passing over and under, weighted by value and labelled at the open end; draws on along the braid, and focusing a strand lights it.',
		props: BRAID_PROPS,
		example: BRAID_EXAMPLE,
		roles: ['surface', 'ink', 'accent'],
		roleUse: { surface: 'Background.', ink: 'The root, its label and the strand labels.', accent: 'The first strand; further strands take the next colours of the categorical chart palette.' },
		sizing: { mode: 'fill', minWidth: 280, minHeight: 120 },
		interaction: braidInteraction,
		draw: (data, input) => renderBraid(data, input, [input.colors.accent!, ...UI_VISUAL_PALETTE.slice(1)])
	});
}

function weaveComponent(): VisualParts {
	return visualComponent<WeaveUiData>({
		id: 'weave',
		title: 'Weave',
		description: 'Items along the top joined to the tags they share along the bottom, many to many; focusing an item lights its tags, and focusing a tag lights its items.',
		props: WEAVE_PROPS,
		example: WEAVE_EXAMPLE,
		roles: ['surface', 'surface-raised', 'ink', 'ink-muted', 'border', 'accent'],
		roleUse: { surface: 'Background.', 'surface-raised': 'Tag chips.', ink: 'Item labels and dots.', 'ink-muted': 'Tag labels.', border: 'Tag chip outlines.', accent: 'Links between items and tags.' },
		sizing: { mode: 'fill', minWidth: 280, minHeight: 180 },
		validate: (data) => {
			const tags = new Set(data.items.flatMap((it) => it.tags));
			if (tags.size > 24) throw new Error(`weave: ${tags.size} different tags; at most 24 fit along the bottom.`);
		},
		interaction: weaveInteraction,
		draw: renderWeave
	});
}

const EXAMPLE_SIZES: Record<ChartUiComponentId, { width: number; height: number }> = {
	sparkline: { width: 120, height: 24 },
	'bar-chart': { width: 480, height: 300 },
	'line-chart': { width: 480, height: 300 },
	'donut-chart': { width: 360, height: 260 },
	lineage: { width: 560, height: 220 },
	braid: { width: 560, height: 200 },
	weave: { width: 560, height: 280 }
};

let cache: ChartUiComponent[] | null = null;

/**
 * The chart types and data visuals offered as UI components (group `data-visual`): `sparkline`,
 * `bar-chart`, `line-chart` and `donut-chart`, and `lineage`, `braid` and `weave`, which draw on
 * (`contract.motion`, `progress`) and light linked marks (`interaction`, `focus`). Each has a
 * `UiDescriptor`, which colour roles drive which colours, and a `render` from data, size, theme
 * and role colours to SVG.
 *
 * `descriptor.contentHash` is `hashValue` (stable JSON, FNV-1a, `h1-…`) of the type's id, its
 * render version (`CHART_UI_RENDER_VERSIONS`), contract, platforms, example, and the SVG of the
 * example drawn in light and dark. So it changes when the contract or the drawing changes, and is
 * the same on every run and machine otherwise.
 */
export function uiComponents(): ChartUiComponent[] {
	if (!cache) {
		cache = ([sparklineComponent(), barChartComponent(), lineChartComponent(), donutChartComponent(), lineageComponent(), braidComponent(), weaveComponent()] as VisualParts[]).map(({ contract, example, ...rest }) => {
			const platforms: UiPlatformTarget[] = ['html-page'];
			const size = EXAMPLE_SIZES[rest.id];
			const renders = (['light', 'dark'] as const).map((theme) => rest.render(example, { ...size, theme }));
			const contentHash = hashValue({ id: rest.id, renderVersion: CHART_UI_RENDER_VERSIONS[rest.id], contract, platforms, example, renders });
			const descriptor: UiDescriptor = {
				implements: rest.id,
				group: 'data-visual',
				contract,
				platforms,
				swiftReady: false,
				example: example as unknown as Record<string, UiJsonValue>,
				contentHash
			};
			return { ...rest, descriptor };
		});
	}
	const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
	return cache.map((c) => ({ ...c, descriptor: clone(c.descriptor), colorRoleUse: { ...c.colorRoleUse }, defaultColors: clone(c.defaultColors) }));
}
