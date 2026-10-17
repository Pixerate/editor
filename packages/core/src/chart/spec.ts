import { cyclePaletteColor } from './color.js';
import { CHART_ERROR_BAR_DIRECTIONS, CHART_ERROR_BAR_TYPES } from './errorbars.js';
import type {
	ChartAxis,
	ChartCurve,
	ChartErrorBars,
	ChartIssue,
	ChartLabelPosition,
	ChartLegend,
	ChartLegendPosition,
	ChartMarker,
	ChartNumberFormat,
	ChartOrientation,
	ChartSeries,
	ChartSeriesType,
	ChartSpec,
	ChartStacking,
	ChartTheme,
	ChartTrendline,
	ChartTrendlineType,
	ChartType,
	ChartValue
} from './types.js';

export const CHART_TYPES: readonly ChartType[] = ['bar', 'line', 'area', 'scatter', 'bubble', 'pie', 'donut', 'radar', 'waterfall', 'histogram', 'box', 'funnel', 'treemap'];
export const CHART_MARKERS: readonly ChartMarker[] = ['circle', 'square', 'diamond', 'triangle', 'cross', 'none'];
export const CHART_TRENDLINE_TYPES: readonly ChartTrendlineType[] = ['linear', 'exponential', 'logarithmic', 'power', 'polynomial', 'moving-average'];
export const CHART_LABEL_POSITIONS: readonly ChartLabelPosition[] = ['auto', 'inside', 'outside', 'center'];
export const CHART_AXIS_KINDS: readonly NonNullable<ChartAxis['kind']>[] = ['category', 'date'];
export const CHART_AXIS_SCALES: readonly NonNullable<ChartAxis['scale']>[] = ['linear', 'log'];
export const CHART_SERIES_TYPES: readonly ChartSeriesType[] = ['bar', 'line', 'area', 'scatter'];
export const CHART_STACKINGS: readonly ChartStacking[] = ['none', 'stacked', 'percent'];
export const CHART_CURVES: readonly ChartCurve[] = ['linear', 'smooth', 'step'];
export const CHART_ORIENTATIONS: readonly ChartOrientation[] = ['vertical', 'horizontal'];
export const CHART_LEGEND_POSITIONS: readonly ChartLegendPosition[] = ['top', 'bottom', 'left', 'right'];
export const CHART_NUMBER_STYLES: readonly NonNullable<ChartNumberFormat['style']>[] = ['number', 'percent', 'currency', 'compact'];

/** Labels for pickers, shared by the React and Svelte components. */
export const CHART_TYPE_LABELS: Readonly<Record<ChartType, string>> = {
	bar: 'Bar',
	line: 'Line',
	area: 'Area',
	scatter: 'Scatter',
	bubble: 'Bubble',
	pie: 'Pie',
	donut: 'Donut',
	radar: 'Radar',
	waterfall: 'Waterfall',
	histogram: 'Histogram',
	box: 'Box plot',
	funnel: 'Funnel',
	treemap: 'Treemap'
};

/** How a chart type is laid out. */
export type ChartFamily = 'cartesian' | 'xy' | 'pie' | 'radar' | 'waterfall' | 'histogram' | 'box' | 'funnel' | 'treemap';

/** A colour-blind-friendly categorical palette (Okabe–Ito order, tuned for light and dark backgrounds). */
export const DEFAULT_CHART_PALETTE: readonly string[] = ['#4269d0', '#efb118', '#ff725c', '#6cc5b0', '#3ca951', '#ff8ab7', '#a463f2', '#97bbf5', '#9c6b4e', '#9498a0'];

export const DEFAULT_CHART_THEME: ChartTheme = {
	background: '#ffffff',
	surface: '#ffffff',
	text: '#0f172a',
	mutedText: '#64748b',
	grid: '#e2e8f0',
	axis: '#94a3b8',
	selection: '#2563eb',
	positive: '#3ca951',
	negative: '#e5484d',
	fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
	fontSize: 11,
	titleSize: 15
};

/**
 * A theme that reads the page's `--background`, `--foreground`, `--muted-foreground`,
 * `--border` and `--primary` colour variables (full colours, as the other components'
 * inline styles use them), with light fallbacks. The React and Svelte canvases use it.
 */
export const CSS_VARIABLE_CHART_THEME: ChartTheme = {
	...DEFAULT_CHART_THEME,
	background: 'transparent',
	surface: 'var(--background, #ffffff)',
	text: 'var(--foreground, #0f172a)',
	mutedText: 'var(--muted-foreground, #64748b)',
	grid: 'var(--border, #e2e8f0)',
	axis: 'var(--muted-foreground, #94a3b8)',
	selection: 'var(--primary, #2563eb)',
	fontFamily: 'inherit'
};

/** Bar, line, area and scatter: categories (or numeric x) against values, series may mix. */
export function isCartesianChart(type: ChartType): boolean {
	return type === 'bar' || type === 'line' || type === 'area' || type === 'scatter';
}

/** Whether the chart plots series against a numeric x axis (bubble charts, and scatter charts with x values). */
export function isXyChart(spec: Pick<ChartSpec, 'type' | 'series'>): boolean {
	if (spec.type === 'bubble') return true;
	return spec.type === 'scatter' && spec.series.some((s) => !s.hidden && Array.isArray(s.x) && s.x.some((v) => v !== null));
}

/** How a chart is laid out (see `ChartType`). */
export function chartFamily(spec: Pick<ChartSpec, 'type' | 'series'>): ChartFamily {
	if (isXyChart(spec)) return 'xy';
	switch (spec.type) {
		case 'pie':
		case 'donut':
			return 'pie';
		case 'radar':
		case 'waterfall':
		case 'histogram':
		case 'box':
		case 'funnel':
		case 'treemap':
			return spec.type;
		case 'bubble':
			return 'xy';
		default:
			return 'cartesian';
	}
}

/** Chart types whose legend lists categories (one colour per category) rather than series. */
export function chartColorsByCategory(type: ChartType): boolean {
	return type === 'pie' || type === 'donut' || type === 'funnel' || type === 'treemap';
}

export function defaultChartAxis(value: boolean): ChartAxis {
	return { show: true, title: '', min: null, max: null, step: null, gridlines: value, format: {} };
}

/** A complete spec with every default filled in. */
export function createChartSpec(partial: Partial<ChartSpec> = {}): ChartSpec {
	return normalizeChartSpec(partial).spec;
}

/** The colour a series is drawn with. */
export function chartSeriesColor(spec: Pick<ChartSpec, 'palette' | 'series'>, seriesIndex: number): string {
	const series = spec.series[seriesIndex];
	if (series?.color) return series.color;
	return cyclePaletteColor(spec.palette.length ? spec.palette : DEFAULT_CHART_PALETTE, seriesIndex);
}

/** The colour a pie slice is drawn with (by category). */
export function chartSliceColor(spec: Pick<ChartSpec, 'palette'>, index: number): string {
	return cyclePaletteColor(spec.palette.length ? spec.palette : DEFAULT_CHART_PALETTE, index);
}

/** The colour of one bar or point: its override, else the series colour. */
export function chartPointColor(spec: Pick<ChartSpec, 'palette' | 'series'>, seriesIndex: number, index: number): string {
	return spec.series[seriesIndex]?.pointColors?.[index] || chartSeriesColor(spec, seriesIndex);
}

/** How a series is drawn in a cartesian chart. */
export function chartSeriesType(spec: Pick<ChartSpec, 'type'>, series: ChartSeries): ChartSeriesType {
	if (series.type) return series.type;
	if (spec.type === 'bubble') return 'scatter';
	return isCartesianChart(spec.type) ? (spec.type as ChartSeriesType) : 'bar';
}

/** An id not used by any series (`series-1`, `series-2`, …). */
export function uniqueChartSeriesId(series: readonly Pick<ChartSeries, 'id'>[], base = 'series'): string {
	const used = new Set(series.map((s) => s.id));
	for (let i = series.length + 1; ; i++) {
		const id = `${base}-${i}`;
		if (!used.has(id)) return id;
	}
}

/**
 * Reads a number the way people type it in a data grid: `1,234.5`, `12%` (→ 0.12),
 * `$40`, `(3)` (→ -3). Blank → `null`. Returns `undefined` when it is not a number.
 */
export function parseChartValue(input: unknown): ChartValue | undefined {
	if (input === null || input === undefined) return null;
	if (typeof input === 'number') return Number.isFinite(input) ? input : undefined;
	if (typeof input !== 'string') return undefined;
	let text = input.trim();
	if (!text || text === '-' || text === '—') return null;
	let negative = false;
	if (/^\(.*\)$/.test(text)) {
		negative = true;
		text = text.slice(1, -1).trim();
	}
	const percent = text.endsWith('%');
	if (percent) text = text.slice(0, -1).trim();
	text = text.replace(/^[$€£¥]/, '').replace(/,/g, '').replace(/\s+/g, '');
	if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return undefined;
	let value = Number(text);
	if (percent) value /= 100;
	if (negative) value = -value;
	return Number.isFinite(value) ? value : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function pick<T extends string>(value: unknown, options: readonly T[], fallback: T, path: string, issues: ChartIssue[]): T {
	if (value === undefined) return fallback;
	if (typeof value === 'string' && (options as readonly string[]).includes(value)) return value as T;
	issues.push({ path, message: `${path} must be one of ${options.map((o) => `"${o}"`).join(', ')}; got ${JSON.stringify(value)}.` });
	return fallback;
}

function text(value: unknown, fallback: string, path: string, issues: ChartIssue[]): string {
	if (value === undefined || value === null) return fallback;
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	issues.push({ path, message: `${path} must be text.` });
	return fallback;
}

function flag(value: unknown, fallback: boolean, path: string, issues: ChartIssue[]): boolean {
	if (value === undefined) return fallback;
	if (typeof value === 'boolean') return value;
	issues.push({ path, message: `${path} must be true or false.` });
	return fallback;
}

function bound(value: unknown, path: string, issues: ChartIssue[]): number | null {
	if (value === undefined || value === null || value === '') return null;
	const n = typeof value === 'string' ? Number(value) : value;
	if (typeof n === 'number' && Number.isFinite(n)) return n;
	issues.push({ path, message: `${path} must be a number or null.` });
	return null;
}

function normalizeFormat(value: unknown, path: string, issues: ChartIssue[]): ChartNumberFormat {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) {
		issues.push({ path, message: `${path} must be an object.` });
		return {};
	}
	const out: ChartNumberFormat = {};
	if (value.style !== undefined) out.style = pick(value.style, CHART_NUMBER_STYLES, 'number', `${path}.style`, issues);
	if (value.decimals !== undefined) {
		const d = Number(value.decimals);
		if (Number.isInteger(d) && d >= 0 && d <= 10) out.decimals = d;
		else issues.push({ path: `${path}.decimals`, message: `${path}.decimals must be a whole number from 0 to 10.` });
	}
	for (const key of ['currency', 'prefix', 'suffix', 'code'] as const) {
		if (value[key] !== undefined) out[key] = text(value[key], '', `${path}.${key}`, issues);
	}
	return out;
}

export function normalizeChartAxis(value: unknown, fallback: ChartAxis, path: string, issues: ChartIssue[] = []): ChartAxis {
	if (value === undefined) return { ...fallback, format: { ...fallback.format } };
	if (!isRecord(value)) {
		issues.push({ path, message: `${path} must be an object.` });
		return { ...fallback, format: { ...fallback.format } };
	}
	let min = 'min' in value ? bound(value.min, `${path}.min`, issues) : fallback.min;
	let max = 'max' in value ? bound(value.max, `${path}.max`, issues) : fallback.max;
	if (min !== null && max !== null && min >= max) {
		issues.push({ path: `${path}.max`, message: `${path}.max (${max}) must be greater than ${path}.min (${min}).` });
		min = fallback.min;
		max = fallback.max;
	}
	let step = 'step' in value ? bound(value.step, `${path}.step`, issues) : fallback.step;
	if (step !== null && !(step > 0)) {
		issues.push({ path: `${path}.step`, message: `${path}.step must be greater than 0 (or null for automatic).` });
		step = fallback.step;
	}
	const axis: ChartAxis = {
		show: flag(value.show, fallback.show, `${path}.show`, issues),
		title: text(value.title, fallback.title, `${path}.title`, issues),
		min,
		max,
		step,
		gridlines: flag(value.gridlines, fallback.gridlines, `${path}.gridlines`, issues),
		format: 'format' in value ? normalizeFormat(value.format, `${path}.format`, issues) : { ...fallback.format }
	};
	const kind = 'kind' in value ? (value.kind === null ? undefined : pick(value.kind, CHART_AXIS_KINDS, 'category', `${path}.kind`, issues)) : fallback.kind;
	if (kind && kind !== 'category') axis.kind = kind;
	const scale = 'scale' in value ? (value.scale === null ? 'linear' : pick(value.scale, CHART_AXIS_SCALES, 'linear', `${path}.scale`, issues)) : (fallback.scale ?? 'linear');
	if (scale === 'log') {
		axis.scale = 'log';
		const base = 'logBase' in value ? value.logBase : fallback.logBase;
		if (base !== undefined && base !== null) {
			const b = Number(base);
			if (Number.isFinite(b) && b >= 2 && b <= 1000) {
				if (b !== 10) axis.logBase = b;
			} else issues.push({ path: `${path}.logBase`, message: `${path}.logBase must be a number from 2 to 1000 (default 10).` });
		}
		for (const end of ['min', 'max'] as const) {
			if (axis[end] !== null && !(axis[end]! > 0)) {
				issues.push({ path: `${path}.${end}`, message: `${path}.${end} must be greater than 0 on a logarithmic axis (or null for automatic); got ${axis[end]}.` });
				axis[end] = null;
			}
		}
	}
	if ('reverse' in value ? value.reverse !== null && flag(value.reverse, false, `${path}.reverse`, issues) : fallback.reverse) axis.reverse = true;
	return axis;
}

function normalizeLegend(value: unknown, issues: ChartIssue[]): ChartLegend {
	const fallback: ChartLegend = { show: true, position: 'bottom' };
	if (value === undefined) return fallback;
	if (!isRecord(value)) {
		issues.push({ path: 'legend', message: 'legend must be an object.' });
		return fallback;
	}
	return {
		show: flag(value.show, fallback.show, 'legend.show', issues),
		position: pick(value.position, CHART_LEGEND_POSITIONS, fallback.position, 'legend.position', issues)
	};
}

/** Values as numbers or nulls; bad entries become null and are reported. */
export function normalizeChartValues(value: unknown, length: number | undefined, path: string, issues: ChartIssue[] = []): ChartValue[] {
	if (value === undefined) return length ? Array(length).fill(null) : [];
	if (!Array.isArray(value)) {
		issues.push({ path, message: `${path} must be an array of numbers.` });
		return length ? Array(length).fill(null) : [];
	}
	const out = value.map((v, i) => {
		const parsed = parseChartValue(v);
		if (parsed === undefined) {
			issues.push({ path: `${path}[${i}]`, message: `${path}[${i}] is not a number: ${JSON.stringify(v)}.` });
			return null;
		}
		return parsed;
	});
	if (length === undefined) return out;
	if (out.length > length) return out.slice(0, length);
	while (out.length < length) out.push(null);
	return out;
}

function normalizeSeries(value: unknown, length: number, used: Set<string>, index: number, issues: ChartIssue[]): ChartSeries | null {
	const path = `series[${index}]`;
	if (!isRecord(value)) {
		issues.push({ path, message: `${path} must be an object with a name and values.` });
		return null;
	}
	let id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : '';
	if (!id || used.has(id)) {
		if (id) issues.push({ path: `${path}.id`, message: `Series id "${id}" is used twice; the second was renamed.` });
		for (let n = index + 1; ; n++) {
			id = `series-${n}`;
			if (!used.has(id)) break;
		}
	}
	used.add(id);
	const series: ChartSeries = {
		id,
		name: text(value.name, `Series ${index + 1}`, `${path}.name`, issues),
		values: normalizeChartValues(value.values, length, `${path}.values`, issues)
	};
	if (typeof value.color === 'string' && value.color.trim()) series.color = value.color.trim();
	if (value.type !== undefined && value.type !== null) series.type = pick(value.type, CHART_SERIES_TYPES, 'bar', `${path}.type`, issues);
	if (value.hidden === true) series.hidden = true;
	if (value.axis !== undefined && value.axis !== null && pick(value.axis, ['primary', 'secondary'] as const, 'primary', `${path}.axis`, issues) === 'secondary') series.axis = 'secondary';
	for (const key of ['x', 'sizes'] as const) {
		if (value[key] === undefined || value[key] === null) continue;
		const list = normalizeChartValues(value[key], length, `${path}.${key}`, issues);
		if (list.some((v) => v !== null)) series[key] = list;
	}
	if (key(value, 'sizes') && series.sizes?.some((v) => v !== null && v < 0)) {
		issues.push({ path: `${path}.sizes`, message: `${path}.sizes must not be negative.` });
		series.sizes = series.sizes.map((v) => (v !== null && v < 0 ? null : v));
	}
	if (value.pointColors !== undefined && value.pointColors !== null) {
		if (!Array.isArray(value.pointColors)) issues.push({ path: `${path}.pointColors`, message: `${path}.pointColors must be an array of colours or nulls.` });
		else {
			const colors = Array.from({ length }, (_, i) => {
				const c = (value.pointColors as unknown[])[i];
				return typeof c === 'string' && c.trim() ? c.trim() : null;
			});
			if (colors.some((c) => c !== null)) series.pointColors = colors;
		}
	}
	if (value.marker !== undefined && value.marker !== null) series.marker = pick(value.marker, CHART_MARKERS, 'circle', `${path}.marker`, issues);
	if (value.curve !== undefined && value.curve !== null) series.curve = pick(value.curve, CHART_CURVES, 'linear', `${path}.curve`, issues);
	if (value.dataLabels !== undefined && value.dataLabels !== null) series.dataLabels = flag(value.dataLabels, false, `${path}.dataLabels`, issues);
	if (value.format !== undefined && value.format !== null) {
		const format = normalizeFormat(value.format, `${path}.format`, issues);
		if (Object.keys(format).length) series.format = format;
	}
	for (const name of ['errorBars', 'xErrorBars'] as const) {
		if (!key(value, name)) continue;
		const bars = normalizeChartErrorBars(value[name], length, `${path}.${name}`, issues);
		if (bars) series[name] = bars;
	}
	if (value.trendlines !== undefined && value.trendlines !== null) {
		if (!Array.isArray(value.trendlines)) issues.push({ path: `${path}.trendlines`, message: `${path}.trendlines must be an array.` });
		else {
			const lines = value.trendlines.map((t, i) => normalizeChartTrendline(t, `${path}.trendlines[${i}]`, issues)).filter((t): t is ChartTrendline => t !== null);
			if (lines.length) series.trendlines = lines;
		}
	}
	return series;
}

const key = (value: Record<string, unknown>, name: string) => value[name] !== undefined && value[name] !== null;

/** Checks one set of error bars; `null` (reported) when it is unusable. Custom amounts are padded to `length`. */
export function normalizeChartErrorBars(value: unknown, length: number, path: string, issues: ChartIssue[] = []): ChartErrorBars | null {
	if (!isRecord(value)) {
		issues.push({ path, message: `${path} must be an object with a type (${CHART_ERROR_BAR_TYPES.join(', ')}), or null for none.` });
		return null;
	}
	const before = issues.length;
	const type = pick(value.type, CHART_ERROR_BAR_TYPES, 'fixed', `${path}.type`, issues);
	if (value.type === undefined) issues.push({ path: `${path}.type`, message: `${path}.type is required: one of ${CHART_ERROR_BAR_TYPES.map((t) => `"${t}"`).join(', ')}.` });
	const bars: ChartErrorBars = { type };
	if (key(value, 'value')) {
		const n = Number(value.value);
		if (type === 'stderr' || type === 'custom') issues.push({ path: `${path}.value`, message: `${type} error bars take no value; ${type === 'custom' ? 'pass plus and minus amounts instead' : 'the amount comes from the data'}.` });
		else if (Number.isFinite(n) && n >= 0) bars.value = n;
		else issues.push({ path: `${path}.value`, message: `${path}.value must be a number, 0 or more${type === 'percent' ? ' (a percentage, e.g. 5 for 5%)' : ''}.` });
	}
	for (const name of ['plus', 'minus'] as const) {
		if (!key(value, name)) continue;
		if (type !== 'custom') {
			issues.push({ path: `${path}.${name}`, message: `${path}.${name} only applies to custom error bars; set type to "custom".` });
			continue;
		}
		const list = normalizeChartValues(value[name], length, `${path}.${name}`, issues);
		if (list.some((v) => v !== null && v < 0)) issues.push({ path: `${path}.${name}`, message: `${path}.${name} amounts must be 0 or more (distances from the point).` });
		else bars[name] = list;
	}
	if (type === 'custom' && !bars.plus && !bars.minus && issues.length === before) issues.push({ path: `${path}.plus`, message: `Custom error bars need plus and / or minus amounts, one per category.` });
	if (key(value, 'direction')) {
		const direction = pick(value.direction, CHART_ERROR_BAR_DIRECTIONS, 'both', `${path}.direction`, issues);
		if (direction !== 'both') bars.direction = direction;
	}
	if (key(value, 'cap') && !flag(value.cap, true, `${path}.cap`, issues)) bars.cap = false;
	return issues.length > before ? null : bars;
}

/** Checks one trendline; `null` (reported) when it is unusable. */
export function normalizeChartTrendline(value: unknown, path: string, issues: ChartIssue[] = []): ChartTrendline | null {
	if (!isRecord(value)) {
		issues.push({ path, message: `${path} must be an object with a type.` });
		return null;
	}
	const type = pick(value.type, CHART_TRENDLINE_TYPES, 'linear', `${path}.type`, issues);
	const line: ChartTrendline = { type };
	const whole = (name: 'order' | 'period', min: number, max: number) => {
		if (!key(value, name)) return;
		const n = Number(value[name]);
		if (Number.isInteger(n) && n >= min && n <= max) line[name] = n;
		else issues.push({ path: `${path}.${name}`, message: `${path}.${name} must be a whole number from ${min} to ${max}.` });
	};
	if (type === 'polynomial') whole('order', 2, 6);
	if (type === 'moving-average') whole('period', 2, 1000);
	for (const name of ['forward', 'backward'] as const) {
		if (!key(value, name)) continue;
		const n = Number(value[name]);
		if (Number.isFinite(n) && n >= 0) {
			if (n > 0) line[name] = n;
		} else issues.push({ path: `${path}.${name}`, message: `${path}.${name} must be a number of x units, 0 or more.` });
	}
	if (key(value, 'intercept')) {
		const n = Number(value.intercept);
		if (!Number.isFinite(n)) issues.push({ path: `${path}.intercept`, message: `${path}.intercept must be a number or null.` });
		else if (type === 'linear' || type === 'polynomial' || type === 'exponential') {
			if (type === 'exponential' && n <= 0) issues.push({ path: `${path}.intercept`, message: `${path}.intercept must be greater than 0 for an exponential trendline.` });
			else line.intercept = n;
		} else issues.push({ path: `${path}.intercept`, message: `A ${type} trendline cannot have a fixed intercept; use linear, polynomial or exponential.` });
	}
	for (const name of ['showEquation', 'showR2'] as const) if (key(value, name) && flag(value[name], false, `${path}.${name}`, issues)) line[name] = true;
	for (const name of ['name', 'color'] as const) {
		if (!key(value, name)) continue;
		const t = text(value[name], '', `${path}.${name}`, issues).trim();
		if (t) line[name] = t;
	}
	return line;
}

/**
 * Turns any input (a partial spec, saved JSON, an agent's arguments) into a complete,
 * valid `ChartSpec`. Every value is checked; problems are reported as sentences in
 * `issues` and replaced by defaults, so the result is always drawable. Series values are
 * padded or trimmed to the number of categories.
 */
export function normalizeChartSpec(input: unknown): { spec: ChartSpec; issues: ChartIssue[] } {
	const issues: ChartIssue[] = [];
	const value = isRecord(input) ? input : {};
	if (input !== undefined && !isRecord(input)) issues.push({ path: '', message: 'A chart must be an object.' });
	const type = pick(value.type, CHART_TYPES, 'bar', 'type', issues);
	const rawSeries = Array.isArray(value.series) ? value.series : [];
	if (value.series !== undefined && !Array.isArray(value.series)) issues.push({ path: 'series', message: 'series must be an array.' });

	let categories: string[];
	if (Array.isArray(value.categories)) categories = value.categories.map((c, i) => text(c, '', `categories[${i}]`, issues));
	else {
		if (value.categories !== undefined) issues.push({ path: 'categories', message: 'categories must be an array of labels.' });
		const longest = rawSeries.reduce<number>((n, s) => Math.max(n, isRecord(s) && Array.isArray(s.values) ? s.values.length : 0), 0);
		categories = Array.from({ length: longest }, (_, i) => `${i + 1}`);
	}

	const used = new Set<string>();
	const series = rawSeries.map((s, i) => normalizeSeries(s, categories.length, used, i, issues)).filter((s): s is ChartSeries => s !== null);

	let palette = [...DEFAULT_CHART_PALETTE];
	if (Array.isArray(value.palette)) {
		const colors = value.palette.filter((c): c is string => typeof c === 'string' && c.trim() !== '');
		if (colors.length) palette = colors;
		else issues.push({ path: 'palette', message: 'palette must list at least one colour.' });
	} else if (value.palette !== undefined) issues.push({ path: 'palette', message: 'palette must be an array of colours.' });

	const fraction = (name: string, fallback: number, min: number, max: number) => {
		if (value[name] === undefined) return fallback;
		const r = Number(value[name]);
		if (value[name] !== null && Number.isFinite(r) && r >= min && r <= max) return r;
		issues.push({ path: name, message: `${name} must be a number from ${min} to ${max}.` });
		return fallback;
	};
	const innerRadius = fraction('innerRadius', 0.55, 0, 0.9);
	const gapWidth = fraction('gapWidth', 0.28, 0, 0.9);
	const overlap = fraction('overlap', -0.12, -1, 1);
	let bins: number | null = null;
	if (value.bins !== undefined && value.bins !== null) {
		const b = Number(value.bins);
		if (Number.isInteger(b) && b >= 1 && b <= 500) bins = b;
		else issues.push({ path: 'bins', message: 'bins must be a whole number from 1 to 500, or null for automatic.' });
	}

	const spec: ChartSpec = {
		version: 1,
		type,
		title: text(value.title, '', 'title', issues),
		subtitle: text(value.subtitle, '', 'subtitle', issues),
		categories,
		series,
		xAxis: normalizeChartAxis(value.xAxis, defaultChartAxis(false), 'xAxis', issues),
		yAxis: normalizeChartAxis(value.yAxis, defaultChartAxis(true), 'yAxis', issues),
		yAxis2: normalizeChartAxis(value.yAxis2, defaultChartAxis(false), 'yAxis2', issues),
		legend: normalizeLegend(value.legend, issues),
		stacking: pick(value.stacking, CHART_STACKINGS, 'none', 'stacking', issues),
		orientation: pick(value.orientation, CHART_ORIENTATIONS, 'vertical', 'orientation', issues),
		curve: pick(value.curve, CHART_CURVES, 'linear', 'curve', issues),
		points: flag(value.points, true, 'points', issues),
		dataLabels: flag(value.dataLabels, false, 'dataLabels', issues),
		labelPosition: pick(value.labelPosition, CHART_LABEL_POSITIONS, 'auto', 'labelPosition', issues),
		palette,
		innerRadius,
		gapWidth,
		overlap,
		bins,
		showTotal: flag(value.showTotal, true, 'showTotal', issues)
	};
	if (spec.stacking === 'percent')
		for (const name of ['yAxis', 'yAxis2'] as const) {
			if (spec[name].scale !== 'log') continue;
			issues.push({ path: `${name}.scale`, message: `A logarithmic ${name} cannot show percent stacking (shares from 0% to 100% include 0); use stacking "stacked" or "none", or a linear axis.` });
			delete spec[name].scale;
			delete spec[name].logBase;
		}
	return { spec, issues };
}

/** A deep copy (specs are plain JSON). */
export function cloneChartSpec(spec: ChartSpec): ChartSpec {
	return {
		...spec,
		categories: [...spec.categories],
		series: spec.series.map(cloneChartSeries),
		xAxis: { ...spec.xAxis, format: { ...spec.xAxis.format } },
		yAxis: { ...spec.yAxis, format: { ...spec.yAxis.format } },
		yAxis2: { ...spec.yAxis2, format: { ...spec.yAxis2.format } },
		legend: { ...spec.legend },
		palette: [...spec.palette]
	};
}

export function cloneChartSeries(series: ChartSeries): ChartSeries {
	const copy: ChartSeries = { ...series, values: [...series.values] };
	if (series.x) copy.x = [...series.x];
	if (series.sizes) copy.sizes = [...series.sizes];
	if (series.pointColors) copy.pointColors = [...series.pointColors];
	if (series.format) copy.format = { ...series.format };
	if (series.trendlines) copy.trendlines = series.trendlines.map((t) => ({ ...t }));
	for (const name of ['errorBars', 'xErrorBars'] as const) {
		const bars = series[name];
		if (!bars) continue;
		copy[name] = { ...bars, ...(bars.plus ? { plus: [...bars.plus] } : {}), ...(bars.minus ? { minus: [...bars.minus] } : {}) };
	}
	return copy;
}

export interface ChartTableOptions {
	/**
	 * `columns` (default): the first column holds categories and each other column is a
	 * series. `rows`: the first row holds categories and each other row is a series.
	 */
	seriesIn?: 'columns' | 'rows';
	/**
	 * The first row (or column for `rows`) holds series names (default `true`). `auto`: only
	 * when one of its value cells is not a number.
	 */
	header?: boolean | 'auto';
	/**
	 * Read the first column as numeric x values (scatter and bubble charts): every series gets
	 * them as `x`, and the categories are their labels.
	 */
	xFromFirstColumn?: boolean;
}

export interface ChartTableData {
	categories: string[];
	series: ChartSeries[];
	issues: ChartIssue[];
}

/**
 * Reads a grid of cells (from CSV, a spreadsheet range or the clipboard) as categories and
 * series. Cells that are not numbers become gaps and are reported.
 */
export function chartDataFromTable(rows: ReadonlyArray<ReadonlyArray<unknown>>, options: ChartTableOptions = {}): ChartTableData {
	let grid = rows.map((r) => [...r]).filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''));
	if (options.seriesIn === 'rows') {
		const width = Math.max(0, ...grid.map((r) => r.length));
		grid = Array.from({ length: width }, (_, c) => grid.map((r) => r[c]));
	}
	const issues: ChartIssue[] = [];
	if (!grid.length) return { categories: [], series: [], issues };
	const width = Math.max(...grid.map((r) => r.length));
	const header = options.header === 'auto' ? grid[0].slice(1).some((c) => c !== null && c !== undefined && String(c).trim() !== '' && parseChartValue(c) === undefined) : (options.header ?? true);
	const names = header ? grid[0] : [];
	const body = header ? grid.slice(1) : grid;
	const categories = body.map((r, i) => {
		const c = r[0];
		return c === null || c === undefined || String(c).trim() === '' ? `${i + 1}` : String(c).trim();
	});
	const series: ChartSeries[] = [];
	for (let col = 1; col < width; col++) {
		const name = names[col] !== undefined && String(names[col]).trim() ? String(names[col]).trim() : `Series ${col}`;
		const values = body.map((r, i) => {
			const parsed = parseChartValue(r[col] ?? null);
			if (parsed === undefined) {
				issues.push({ path: `${name}[${i}]`, message: `"${String(r[col])}" in ${name} (${categories[i]}) is not a number; it was left blank.` });
				return null;
			}
			return parsed;
		});
		series.push({ id: `series-${col}`, name, values });
	}
	if (options.xFromFirstColumn) {
		const x = body.map((r, i) => {
			const parsed = parseChartValue(r[0] ?? null);
			if (parsed === undefined) issues.push({ path: `x[${i}]`, message: `"${String(r[0])}" in the first column is not a number; that point has no x.` });
			return parsed ?? null;
		});
		for (const s of series) s.x = [...x];
	}
	return { categories, series, issues };
}

/** The chart's data as a grid: a header row of series names, then one row per category. */
export function chartDataToTable(spec: Pick<ChartSpec, 'categories' | 'series'>, options: { categoryHeader?: string } = {}): (string | number | null)[][] {
	return [
		[options.categoryHeader ?? '', ...spec.series.map((s) => s.name)],
		...spec.categories.map((category, i) => [category, ...spec.series.map((s) => s.values[i] ?? null)])
	];
}

/** A colour input value (`#rrggbb`) for a CSS colour: `#abc` expands, non-hex colours show as black. */
export function chartColorInputValue(color: string): string {
	if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
	if (/^#[0-9a-f]{3}$/i.test(color)) return `#${[...color.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
	return '#000000';
}
