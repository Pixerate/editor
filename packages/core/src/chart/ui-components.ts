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

export type ChartUiComponentId = 'sparkline' | 'bar-chart';

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
}

/**
 * Per-type render versions. Bump a type's version when its drawing changes in a way its contract
 * and example renders do not show (they are hashed too), so `contentHash` changes with it.
 */
export const CHART_UI_RENDER_VERSIONS: Readonly<Record<ChartUiComponentId, number>> = { sparkline: 1, 'bar-chart': 1 };

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

const EXAMPLE_SIZES: Record<ChartUiComponentId, { width: number; height: number }> = { sparkline: { width: 120, height: 24 }, 'bar-chart': { width: 480, height: 300 } };

let cache: ChartUiComponent[] | null = null;

/**
 * The chart types offered as UI components: `sparkline` and `bar-chart` (group `data-visual`),
 * each with a `UiDescriptor`, which colour roles drive which chart colours, and a `render` from
 * data, size, theme and role colours to SVG.
 *
 * `descriptor.contentHash` is `hashValue` (stable JSON, FNV-1a, `h1-…`) of the type's id, its
 * render version (`CHART_UI_RENDER_VERSIONS`), contract, platforms, example, and the SVG of the
 * example drawn in light and dark. So it changes when the contract or the drawing changes, and is
 * the same on every run and machine otherwise.
 */
export function uiComponents(): ChartUiComponent[] {
	if (!cache) {
		cache = [sparklineComponent(), barChartComponent()].map(({ contract, example, ...rest }) => {
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
