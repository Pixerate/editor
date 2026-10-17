import type { CommandSpec } from '../commands/registry.js';
import type { ChartController, ChartSpecPatch } from './controller.js';
import { CHART_CURVES, CHART_LEGEND_POSITIONS, CHART_NUMBER_STYLES, CHART_ORIENTATIONS, CHART_SERIES_TYPES, CHART_STACKINGS, CHART_TYPES, chartDataToTable } from './spec.js';
import { chartToSvg } from './svg.js';

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

const VALUE = { type: ['number', 'string', 'null'], description: 'A number, numeric text ("1,200", "12%") or null for a gap.' } as const;

const FORMAT = {
	type: 'object',
	properties: {
		style: { type: 'string', enum: [...CHART_NUMBER_STYLES] },
		decimals: { type: 'integer', minimum: 0, maximum: 10 },
		currency: { type: 'string', description: 'ISO code for style "currency", e.g. "EUR".' },
		prefix: { type: 'string' },
		suffix: { type: 'string' }
	},
	additionalProperties: false
} as const;

const AXIS = {
	type: 'object',
	properties: {
		show: { type: 'boolean' },
		title: { type: 'string' },
		min: { type: ['number', 'null'], description: 'Fixed lower bound, or null for automatic.' },
		max: { type: ['number', 'null'], description: 'Fixed upper bound, or null for automatic.' },
		gridlines: { type: 'boolean' },
		format: FORMAT
	},
	additionalProperties: false
} as const;

const SERIES = {
	type: 'object',
	properties: {
		id: { type: 'string' },
		name: { type: 'string' },
		values: { type: 'array', items: VALUE, description: 'One value per category.' },
		color: { type: 'string', description: 'CSS colour.' },
		type: { type: 'string', enum: [...CHART_SERIES_TYPES], description: 'Draw this series differently (combo charts).' },
		hidden: { type: 'boolean' }
	},
	required: ['name', 'values'],
	additionalProperties: false
} as const;

/**
 * Palette and agent commands for a chart: describe, update presentation, replace data, set
 * values, add / remove series and categories, import CSV and export SVG. Register them in a
 * `CommandRegistry` and agents get them through `createCommandToolProvider`. Failures throw
 * sentences, which the registry returns as `{ ok: false, code: 'failed', message }`.
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

	return [
		{
			...base,
			id: `${prefix}describe`,
			label: 'Describe Chart',
			readOnly: true,
			keywords: ['chart', 'data', 'spec', 'get'],
			description: 'Returns the chart spec (type, titles, axes, legend, options) and its data as a table with series names in the header row.',
			run: () => {
				const spec = controller.getSpec();
				return { spec: controller.toJSON(), table: chartDataToTable(spec), issues: controller.getState().issues };
			}
		},
		{
			...base,
			id: `${prefix}update`,
			label: 'Change Chart…',
			keywords: ['chart', 'title', 'axis', 'legend', 'stack', 'style', 'format'],
			description: 'Changes chart presentation as one undo step: type, titles, axes (x = categories, y = values), legend, stacking, orientation, curve, points, data labels, palette or donut hole. Invalid values change nothing and return why.',
			params: {
				type: 'object',
				properties: {
					type: { type: 'string', enum: [...CHART_TYPES] },
					title: { type: 'string' },
					subtitle: { type: 'string' },
					xAxis: AXIS,
					yAxis: AXIS,
					legend: { type: 'object', properties: { show: { type: 'boolean' }, position: { type: 'string', enum: [...CHART_LEGEND_POSITIONS] } }, additionalProperties: false },
					stacking: { type: 'string', enum: [...CHART_STACKINGS] },
					orientation: { type: 'string', enum: [...CHART_ORIENTATIONS] },
					curve: { type: 'string', enum: [...CHART_CURVES] },
					points: { type: 'boolean' },
					dataLabels: { type: 'boolean' },
					palette: { type: 'array', items: { type: 'string' }, minItems: 1 },
					innerRadius: { type: 'number', minimum: 0, maximum: 0.9 }
				},
				additionalProperties: false
			},
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
			params: {
				type: 'object',
				properties: {
					categories: { type: 'array', items: { type: 'string' } },
					series: { type: 'array', items: SERIES }
				},
				additionalProperties: false
			},
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
			params: {
				type: 'object',
				properties: {
					cells: {
						type: 'array',
						minItems: 1,
						items: {
							type: 'object',
							properties: { series: { type: 'string' }, category: { type: ['string', 'integer'] }, value: VALUE },
							required: ['series', 'category', 'value'],
							additionalProperties: false
						}
					}
				},
				required: ['cells']
			},
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
			params: { type: 'object', properties: { ...SERIES.properties, at: { type: 'integer', minimum: 0 } }, additionalProperties: false },
			run: (_ctx: unknown, params: { at?: number; name?: string; values?: unknown[] } = {}) => {
				const { at, ...input } = params ?? {};
				const result = controller.addSeries(input as any, { at });
				check(result);
				return { id: (result as { id: string }).id };
			}
		},
		{
			...base,
			id: `${prefix}updateSeries`,
			label: 'Change Series…',
			keywords: ['chart', 'series', 'rename', 'colour', 'color', 'hide'],
			description: 'Renames, recolours, hides or changes how a series is drawn (null colour / type resets it).',
			params: {
				type: 'object',
				properties: {
					series: { type: 'string', description: 'Series id or name.' },
					name: { type: 'string' },
					color: { type: ['string', 'null'] },
					type: { type: ['string', 'null'], enum: [...CHART_SERIES_TYPES, null] },
					hidden: { type: 'boolean' }
				},
				required: ['series'],
				additionalProperties: false
			},
			run: (_ctx: unknown, params: { series: string; name?: string; color?: string | null; type?: any; hidden?: boolean }) => {
				const { series, ...patch } = params;
				const id = resolveSeries(series).id;
				check(controller.updateSeries(id, patch));
				return { series: controller.getSeries(id) };
			}
		},
		{
			...base,
			id: `${prefix}removeSeries`,
			label: 'Delete Series',
			keywords: ['chart', 'series', 'remove'],
			description: 'Deletes a series by id or name.',
			params: { type: 'object', properties: { series: { type: 'string' } }, required: ['series'], additionalProperties: false },
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
			params: { type: 'object', properties: { label: { type: 'string' }, at: { type: 'integer', minimum: 0 } }, additionalProperties: false },
			run: (_ctx: unknown, params: { label?: string; at?: number } = {}) => controller.addCategory(params?.label, { at: params?.at })
		},
		{
			...base,
			id: `${prefix}removeCategory`,
			label: 'Delete Category',
			keywords: ['chart', 'category', 'row', 'remove'],
			description: 'Deletes a category (and its values) by index or label.',
			params: { type: 'object', properties: { category: { type: ['string', 'integer'] } }, required: ['category'], additionalProperties: false },
			run: (_ctx: unknown, params: { category: string | number }) => {
				check(controller.removeCategory(resolveCategory(params.category)));
				return { categories: controller.getSpec().categories };
			}
		},
		{
			...base,
			id: `${prefix}importCsv`,
			label: 'Import Chart Data from CSV…',
			keywords: ['chart', 'csv', 'tsv', 'paste', 'import'],
			description: 'Replaces the data with CSV / TSV text: by default the first column holds categories and the first row series names.',
			params: {
				type: 'object',
				properties: {
					csv: { type: 'string' },
					seriesIn: { type: 'string', enum: ['columns', 'rows'] },
					header: { type: 'boolean' }
				},
				required: ['csv'],
				additionalProperties: false
			},
			run: (_ctx: unknown, params: { csv: string; seriesIn?: 'columns' | 'rows'; header?: boolean }) => {
				const result = controller.importCsv(params.csv, { seriesIn: params.seriesIn, header: params.header });
				check(result);
				return { table: chartDataToTable(controller.getSpec()), issues: result.issues ?? [] };
			}
		},
		{
			...base,
			id: `${prefix}exportSvg`,
			label: 'Export Chart as SVG',
			readOnly: true,
			keywords: ['chart', 'svg', 'export', 'image'],
			description: 'Returns the chart drawn as a standalone SVG string.',
			params: { type: 'object', properties: { width: { type: 'number', minimum: 50 }, height: { type: 'number', minimum: 50 } }, additionalProperties: false },
			run: (_ctx: unknown, params: { width?: number; height?: number } = {}) => ({
				svg: chartToSvg(controller.getSpec() as any, { width: params?.width ?? 640, height: params?.height ?? 400 })
			})
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
