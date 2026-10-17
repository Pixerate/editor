import type {
	ChartAxis,
	ChartCurve,
	ChartIssue,
	ChartLegend,
	ChartLegendPosition,
	ChartNumberFormat,
	ChartOrientation,
	ChartSeries,
	ChartSeriesType,
	ChartSpec,
	ChartStacking,
	ChartTheme,
	ChartType,
	ChartValue
} from './types.js';

export const CHART_TYPES: readonly ChartType[] = ['bar', 'line', 'area', 'scatter', 'pie', 'donut'];
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
	pie: 'Pie',
	donut: 'Donut'
};

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

export function isCartesianChart(type: ChartType): boolean {
	return type !== 'pie' && type !== 'donut';
}

export function defaultChartAxis(value: boolean): ChartAxis {
	return { show: true, title: '', min: null, max: null, gridlines: value, format: {} };
}

/** A complete spec with every default filled in. */
export function createChartSpec(partial: Partial<ChartSpec> = {}): ChartSpec {
	return normalizeChartSpec(partial).spec;
}

/** The colour a series is drawn with. */
export function chartSeriesColor(spec: Pick<ChartSpec, 'palette' | 'series'>, seriesIndex: number): string {
	const series = spec.series[seriesIndex];
	if (series?.color) return series.color;
	const palette = spec.palette.length ? spec.palette : DEFAULT_CHART_PALETTE;
	return palette[seriesIndex % palette.length];
}

/** The colour a pie slice is drawn with (by category). */
export function chartSliceColor(spec: Pick<ChartSpec, 'palette'>, index: number): string {
	const palette = spec.palette.length ? spec.palette : DEFAULT_CHART_PALETTE;
	return palette[index % palette.length];
}

/** How a series is drawn in a cartesian chart. */
export function chartSeriesType(spec: Pick<ChartSpec, 'type'>, series: ChartSeries): ChartSeriesType {
	if (series.type) return series.type;
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
	for (const key of ['currency', 'prefix', 'suffix'] as const) {
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
	return {
		show: flag(value.show, fallback.show, `${path}.show`, issues),
		title: text(value.title, fallback.title, `${path}.title`, issues),
		min,
		max,
		gridlines: flag(value.gridlines, fallback.gridlines, `${path}.gridlines`, issues),
		format: 'format' in value ? normalizeFormat(value.format, `${path}.format`, issues) : { ...fallback.format }
	};
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
	return series;
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

	let innerRadius = 0.55;
	if (value.innerRadius !== undefined) {
		const r = Number(value.innerRadius);
		if (Number.isFinite(r) && r >= 0 && r <= 0.9) innerRadius = r;
		else issues.push({ path: 'innerRadius', message: 'innerRadius must be a number from 0 to 0.9.' });
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
		legend: normalizeLegend(value.legend, issues),
		stacking: pick(value.stacking, CHART_STACKINGS, 'none', 'stacking', issues),
		orientation: pick(value.orientation, CHART_ORIENTATIONS, 'vertical', 'orientation', issues),
		curve: pick(value.curve, CHART_CURVES, 'linear', 'curve', issues),
		points: flag(value.points, true, 'points', issues),
		dataLabels: flag(value.dataLabels, false, 'dataLabels', issues),
		palette,
		innerRadius
	};
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
		legend: { ...spec.legend },
		palette: [...spec.palette]
	};
}

export function cloneChartSeries(series: ChartSeries): ChartSeries {
	return { ...series, values: [...series.values] };
}

export interface ChartTableOptions {
	/**
	 * `columns` (default): the first column holds categories and each other column is a
	 * series. `rows`: the first row holds categories and each other row is a series.
	 */
	seriesIn?: 'columns' | 'rows';
	/** The first row (or column for `rows`) holds series names (default `true`). */
	header?: boolean;
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
	const header = options.header ?? true;
	let grid = rows.map((r) => [...r]).filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''));
	if (options.seriesIn === 'rows') {
		const width = Math.max(0, ...grid.map((r) => r.length));
		grid = Array.from({ length: width }, (_, c) => grid.map((r) => r[c]));
	}
	const issues: ChartIssue[] = [];
	if (!grid.length) return { categories: [], series: [], issues };
	const width = Math.max(...grid.map((r) => r.length));
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
