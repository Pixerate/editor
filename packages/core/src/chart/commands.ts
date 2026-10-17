import type { CommandSpec } from '../commands/registry.js';
import { parseCsv } from '../spreadsheet/csv.js';
import { checkChartColors } from './color.js';
import type { ChartController, ChartSpecPatch } from './controller.js';
import { chartFromMermaid, chartToMermaid } from './mermaid.js';
import { chartToOoxml } from './ooxml.js';
import { CHART_COLOR_SCHEMES, CHART_LAYOUT_PRESETS } from './presets.js';
import { recommendChartTypes } from './recommend.js';
import { CATEGORY_REF, CHART_UPDATE_PROPERTIES, HEIGHT, SERIES_PROPS, SERIES_REF, TRENDLINE_PROPS, VALUE, WIDTH } from './schemas.js';
import { chartColorsByCategory, chartDataToTable, chartSeriesColor, chartSliceColor } from './spec.js';
import { summarizeChart } from './summary.js';
import { chartToSvg } from './svg.js';
import type { ChartTrendline } from './types.js';

export interface ChartCommandOptions {
	/** Id prefix (default `chart.`); use one per chart when several are registered. */
	prefix?: string;
	/** Palette group (default `Chart`). */
	group?: string;
	/** Command scope. Omit for global commands. */
	scope?: string;
}

const fail = (message: string): never => {
	throw new Error(message);
};

const check = (result: { ok: boolean; message?: string }) => {
	if (!result.ok) fail(result.message ?? 'The change was rejected.');
};

/**
 * Palette and agent commands for a chart: describe, update presentation, replace data, set
 * values, add / remove series, categories and trendlines, apply presets, switch rows and
 * columns, import CSV or Mermaid, export SVG, Mermaid or Office XML, recommend types and
 * check colours. Register them in a `CommandRegistry` and agents get them through
 * `createCommandToolProvider`; `createChartToolProvider` offers the same operations as
 * individual tools. Failures throw sentences, which the registry returns as
 * `{ ok: false, code: 'failed', message }`.
 */
export function createChartCommands(controller: ChartController, options: ChartCommandOptions = {}): CommandSpec[] {
	const prefix = options.prefix ?? 'chart.';
	const base = { group: options.group ?? 'Chart', ...(options.scope ? { scope: options.scope } : {}) };
	const seriesIds = () => controller.getSpec().series.map((s) => s.id);
	const resolveSeries = (ref: string) => {
		const spec = controller.getSpec();
		const series = spec.series.find((s) => s.id === ref) ?? spec.series.find((s) => s.name === ref);
		if (!series) fail(`There is no series "${ref}"; expected one of ${seriesIds().map((id) => `"${id}"`).join(', ') || '(none yet)'}.`);
		return series!;
	};
	const resolveCategory = (ref: string | number) => {
		const categories = controller.getSpec().categories;
		const index = typeof ref === 'number' ? ref : categories.indexOf(ref);
		if (index < 0 || index >= categories.length || !Number.isInteger(index)) fail(`There is no category ${JSON.stringify(ref)}; expected an index from 0 to ${categories.length - 1} or one of the labels.`);
		return index;
	};
	const object = (properties: Record<string, unknown>, required?: string[]) => ({ type: 'object' as const, properties, ...(required ? { required } : {}), additionalProperties: false }) as any;

	return [
		{
			...base,
			id: `${prefix}describe`,
			label: 'Describe Chart',
			readOnly: true,
			keywords: ['chart', 'data', 'spec', 'get', 'summary'],
			description: 'Returns the chart spec, its data as a table (series names in the header row) and a summary: per-series min / max / mean / trend, axes as drawn, layout warnings and a colour check.',
			params: object({ width: WIDTH, height: HEIGHT }),
			run: (_ctx: unknown, params: { width?: number; height?: number } = {}) => {
				const spec = controller.getSpec();
				return { spec: controller.toJSON(), table: chartDataToTable(spec), summary: summarizeChart(controller.toJSON(), { width: params?.width ?? 640, height: params?.height ?? 400 }), issues: controller.getState().issues };
			}
		},
		{
			...base,
			id: `${prefix}update`,
			label: 'Change Chart…',
			keywords: ['chart', 'title', 'axis', 'legend', 'stack', 'style', 'format', 'type'],
			description:
				'Changes chart presentation as one undo step: type, titles, axes (xAxis = categories, yAxis = values, yAxis2 = secondary values; reverse, and scale "log" on value axes), legend, stacking, orientation, curve, points, data labels, palette, donut hole, bar spacing, histogram bins or waterfall total. Invalid values change nothing and return why.',
			params: object(CHART_UPDATE_PROPERTIES),
			run: (_ctx: unknown, params: ChartSpecPatch) => {
				check(controller.update(params));
				return { spec: controller.toJSON() };
			}
		},
		{
			...base,
			id: `${prefix}setData`,
			label: 'Replace Chart Data…',
			keywords: ['chart', 'data', 'series', 'categories'],
			description: 'Replaces the categories and series as one undo step. Each series has one value per category (padded with gaps).',
			params: object({
				categories: { type: 'array', items: { type: 'string' }, description: 'Category labels in order.' },
				series: { type: 'array', description: 'The new series.', items: object({ id: { type: 'string', description: 'Stable id (optional).' }, ...SERIES_PROPS }, ['name', 'values']) }
			}),
			run: (_ctx: unknown, params: { categories?: string[]; series?: any[] }) => {
				check(controller.setData(params));
				return { table: chartDataToTable(controller.getSpec()) };
			}
		},
		{
			...base,
			id: `${prefix}setValues`,
			label: 'Set Chart Values…',
			keywords: ['chart', 'value', 'cell', 'edit'],
			description: 'Sets individual values as one undo step. Series by id or name; category by index or label.',
			params: object({ cells: { type: 'array', minItems: 1, description: 'Values to set.', items: object({ series: SERIES_REF, category: CATEGORY_REF, value: VALUE }, ['series', 'category', 'value']) } }, ['cells']),
			run: (_ctx: unknown, params: { cells: { series: string; category: string | number; value: unknown }[] }) => {
				check(controller.setValues(params.cells.map((c) => ({ seriesId: resolveSeries(c.series).id, index: resolveCategory(c.category), value: c.value }))));
				return { table: chartDataToTable(controller.getSpec()) };
			}
		},
		{
			...base,
			id: `${prefix}addSeries`,
			label: 'Add Series',
			keywords: ['chart', 'series', 'new'],
			description: 'Adds a series (default: an empty one at the end). Returns its id.',
			params: object({ ...SERIES_PROPS, id: { type: 'string', description: 'Id to use (default series-N).' }, at: { type: 'integer', minimum: 0, description: 'Position (default: last).' } }),
			run: (_ctx: unknown, params: { at?: number; name?: string; values?: unknown[] } = {}) => {
				const { at, ...input } = params ?? {};
				const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== null));
				const result = controller.addSeries(clean as any, { at });
				check(result);
				return { id: (result as { id: string }).id };
			}
		},
		{
			...base,
			id: `${prefix}updateSeries`,
			label: 'Change Series…',
			keywords: ['chart', 'series', 'rename', 'colour', 'color', 'hide', 'axis', 'marker'],
			description: 'Renames, recolours, hides, moves to the secondary axis or changes how a series is drawn, including error bars (null resets a field).',
			params: object({ series: SERIES_REF, ...Object.fromEntries(Object.entries(SERIES_PROPS).filter(([k]) => k !== 'values')) }, ['series']),
			run: (_ctx: unknown, params: { series: string } & Record<string, unknown>) => {
				const { series, ...patch } = params;
				const id = resolveSeries(series).id;
				check(controller.updateSeries(id, patch as any));
				return { series: controller.getSeries(id) };
			}
		},
		{
			...base,
			id: `${prefix}removeSeries`,
			label: 'Delete Series',
			keywords: ['chart', 'series', 'remove'],
			description: 'Deletes a series by id or name.',
			params: object({ series: SERIES_REF }, ['series']),
			run: (_ctx: unknown, params: { series: string }) => {
				check(controller.removeSeries(resolveSeries(params.series).id));
				return { series: seriesIds() };
			}
		},
		{
			...base,
			id: `${prefix}addCategory`,
			label: 'Add Category',
			keywords: ['chart', 'category', 'row', 'label'],
			description: 'Inserts a category (gaps in every series) at `at` (default: the end).',
			params: object({ label: { type: 'string', description: 'Category label (default: its number).' }, at: { type: 'integer', minimum: 0, description: 'Index to insert at (default: the end).' } }),
			run: (_ctx: unknown, params: { label?: string; at?: number } = {}) => controller.addCategory(params?.label, { at: params?.at })
		},
		{
			...base,
			id: `${prefix}removeCategory`,
			label: 'Delete Category',
			keywords: ['chart', 'category', 'row', 'remove'],
			description: 'Deletes a category (and its values) by index or label.',
			params: object({ category: CATEGORY_REF }, ['category']),
			run: (_ctx: unknown, params: { category: string | number }) => {
				check(controller.removeCategory(resolveCategory(params.category)));
				return { categories: controller.getSpec().categories };
			}
		},
		{
			...base,
			id: `${prefix}addTrendline`,
			label: 'Add Trendline…',
			keywords: ['chart', 'trend', 'regression', 'fit', 'forecast', 'moving average'],
			description: 'Fits a trendline to a series (linear, exponential, logarithmic, power, polynomial or moving average). Returns its index and the fit.',
			params: object({ series: SERIES_REF, ...TRENDLINE_PROPS }, ['series', 'type']),
			run: (_ctx: unknown, params: { series: string } & ChartTrendline) => {
				const { series, ...line } = params;
				const result = controller.addTrendline(resolveSeries(series).id, line);
				check(result);
				const ok = result as { index: number; fit: { coefficients: number[]; r2: number | null; equation: string } | null };
				return { index: ok.index, ...(ok.fit ? { coefficients: ok.fit.coefficients, r2: ok.fit.r2, equation: ok.fit.equation } : {}) };
			}
		},
		{
			...base,
			id: `${prefix}removeTrendline`,
			label: 'Delete Trendline',
			keywords: ['chart', 'trend', 'remove'],
			description: 'Deletes a trendline from a series.',
			params: object({ series: SERIES_REF, index: { type: 'integer', minimum: 0, description: 'Trendline index (0 = first).' } }, ['series', 'index']),
			run: (_ctx: unknown, params: { series: string; index: number }) => {
				check(controller.removeTrendline(resolveSeries(params.series).id, params.index));
				return { trendlines: controller.getSeries(resolveSeries(params.series).id)?.trendlines ?? [] };
			}
		},
		{
			...base,
			id: `${prefix}applyPreset`,
			label: 'Apply Chart Style…',
			keywords: ['chart', 'quick layout', 'style', 'colours', 'colors', 'monochrome', 'theme'],
			description: 'Applies a quick layout and / or colour scheme as one undo step.',
			params: object({
				layout: { type: 'string', enum: CHART_LAYOUT_PRESETS.map((p) => p.id), description: 'Quick layout id.' },
				colors: { type: 'string', enum: CHART_COLOR_SCHEMES.map((p) => p.id), description: 'Colour scheme id.' }
			}),
			run: (_ctx: unknown, params: { layout?: string; colors?: string } = {}) => {
				check(controller.applyPreset(params ?? {}));
				return { spec: controller.toJSON() };
			}
		},
		{
			...base,
			id: `${prefix}transpose`,
			label: 'Switch Rows and Columns',
			keywords: ['chart', 'transpose', 'swap', 'rows', 'columns', 'series'],
			description: 'Swaps series and categories as one undo step.',
			run: () => {
				check(controller.transpose());
				return { table: chartDataToTable(controller.getSpec()) };
			}
		},
		{
			...base,
			id: `${prefix}importCsv`,
			label: 'Import Chart Data from CSV…',
			keywords: ['chart', 'csv', 'tsv', 'paste', 'import'],
			description: 'Replaces the data with CSV / TSV text: by default the first column holds categories and the first row series names.',
			params: object(
				{
					csv: { type: 'string', description: 'CSV or TSV text.' },
					seriesIn: { type: 'string', enum: ['columns', 'rows'], description: 'Series run down columns (default) or along rows.' },
					header: { type: ['boolean', 'string'], enum: [true, false, 'auto'], description: 'The first row holds series names (default true).' }
				},
				['csv']
			),
			run: (_ctx: unknown, params: { csv: string; seriesIn?: 'columns' | 'rows'; header?: boolean | 'auto' }) => {
				const result = controller.importCsv(params.csv, { seriesIn: params.seriesIn, header: params.header });
				check(result);
				return { table: chartDataToTable(controller.getSpec()), issues: result.issues ?? [] };
			}
		},
		{
			...base,
			id: `${prefix}importMermaid`,
			label: 'Import Mermaid Chart…',
			keywords: ['chart', 'mermaid', 'markdown', 'xychart', 'pie', 'radar', 'import'],
			description: 'Replaces the chart with Mermaid xychart-beta, pie or radar-beta text (one undo step). Unreadable lines are listed with line numbers.',
			params: object({ mermaid: { type: 'string', description: 'Mermaid text.' } }, ['mermaid']),
			run: (_ctx: unknown, params: { mermaid: string }) => {
				const read = chartFromMermaid(params.mermaid);
				if (!read.family) fail(read.issues.map((i) => i.message).join(' ') || 'Expected Mermaid starting with xychart-beta, pie or radar-beta.');
				check(controller.update({ ...read.spec } as ChartSpecPatch, { label: 'Import Mermaid chart' }));
				return { spec: controller.toJSON(), issues: read.issues };
			}
		},
		{
			...base,
			id: `${prefix}exportMermaid`,
			label: 'Copy Chart as Mermaid',
			readOnly: true,
			keywords: ['chart', 'mermaid', 'markdown', 'export'],
			description: 'Returns the chart as Mermaid text (with a round-trip comment unless meta is false).',
			params: object({ meta: { type: 'boolean', description: 'Include the %% @pixerate round-trip comment (default true).' } }),
			run: (_ctx: unknown, params: { meta?: boolean } = {}) => ({ mermaid: chartToMermaid(controller.toJSON(), { meta: params?.meta }) })
		},
		{
			...base,
			id: `${prefix}exportOoxml`,
			label: 'Export Chart as Office XML',
			readOnly: true,
			keywords: ['chart', 'office', 'word', 'powerpoint', 'docx', 'pptx', 'xml', 'export'],
			description: 'Returns the chart as a DrawingML chart part (c:chartSpace) and what could not be written.',
			run: () => chartToOoxml(controller.toJSON())
		},
		{
			...base,
			id: `${prefix}exportSvg`,
			label: 'Export Chart as SVG',
			readOnly: true,
			keywords: ['chart', 'svg', 'export', 'image'],
			description: 'Returns the chart drawn as a standalone, accessible SVG string (with <title> and <desc>).',
			params: object({ width: WIDTH, height: HEIGHT }),
			run: (_ctx: unknown, params: { width?: number; height?: number } = {}) => ({
				svg: chartToSvg(controller.toJSON(), { width: params?.width ?? 640, height: params?.height ?? 400 })
			})
		},
		{
			...base,
			id: `${prefix}recommend`,
			label: 'Recommend Chart Types',
			readOnly: true,
			keywords: ['chart', 'recommend', 'suggest', 'type'],
			description: 'Suggests chart types for the current data (or CSV), best first, each with a reason.',
			params: object({ csv: { type: 'string', description: 'CSV text to analyse instead of the current data.' } }),
			run: (_ctx: unknown, params: { csv?: string } = {}) => ({
				recommendations: recommendChartTypes(params?.csv !== undefined ? parseCsv(params.csv) : chartDataToTable(controller.getSpec()))
			})
		},
		{
			...base,
			id: `${prefix}checkColors`,
			label: 'Check Chart Colours',
			readOnly: true,
			keywords: ['chart', 'colour', 'color', 'accessibility', 'colour-blind', 'contrast'],
			description: 'Checks that the series colours can be told apart (including with colour-blindness) and stand out from the background.',
			run: () => {
				const s = controller.getSpec();
				const visible = s.series.filter((x) => !x.hidden);
				const colors = chartColorsByCategory(s.type) ? s.categories.map((_, i) => visible[0]?.pointColors?.[i] || chartSliceColor(s, i)) : visible.map((x) => chartSeriesColor(s, s.series.indexOf(x)));
				return { colors, ...checkChartColors(colors) };
			}
		},
		{
			...base,
			id: `${prefix}undo`,
			label: 'Undo Chart Edit',
			keywords: ['chart', 'undo'],
			enabled: () => controller.getState().canUndo || 'Nothing to undo',
			run: () => ({ undone: controller.undo() })
		},
		{
			...base,
			id: `${prefix}redo`,
			label: 'Redo Chart Edit',
			keywords: ['chart', 'redo'],
			enabled: () => controller.getState().canRedo || 'Nothing to redo',
			run: () => ({ redone: controller.redo() })
		}
	];
}
