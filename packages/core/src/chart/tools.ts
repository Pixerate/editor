// The render-preview, pointer-gesture and key tools follow the conventions of the craft apps' MCP servers
// (vectorcraft-main/crates/mcp/src/tools.rs `render_preview`, lightcraft-main `pointer_gesture`,
// designcraft-main `key`) (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { withChartPlayback } from './playback.js';
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import { parseCsv } from '../spreadsheet/csv.js';
import { checkChartColors } from './color.js';
import type { ChartController, ChartSeriesPatch, ChartSpecPatch } from './controller.js';
import { chartHitTest, handleChartKey, startChartPointDrag } from './interaction.js';
import { layoutChart } from './layout.js';
import { chartFromMermaid, chartToMermaid } from './mermaid.js';
import { chartFromOoxml, chartToOoxml } from './ooxml.js';
import type { ChartDirector, ChartDirectorActor } from './presence.js';
import { CHART_COLOR_SCHEMES, CHART_LAYOUT_PRESETS } from './presets.js';
import { chartFromTable, recommendChartTypes } from './recommend.js';
import {
	parseChartValue,
	CHART_AXIS_KINDS,
	CHART_CURVES,
	CHART_LABEL_POSITIONS,
	CHART_LEGEND_POSITIONS,
	CHART_MARKERS,
	CHART_NUMBER_STYLES,
	CHART_ORIENTATIONS,
	CHART_SERIES_TYPES,
	CHART_STACKINGS,
	CHART_TRENDLINE_TYPES,
	CHART_TYPES,
	chartSpecColorsByCategory,
	chartDataToTable,
	chartSeriesColor,
	chartSliceColor
} from './spec.js';
import {
	AXIS,
	CATEGORY_REF,
	CHART_UPDATE_PROPERTIES,
	FORMAT,
	HEIGHT,
	REFERENCE_BAND_PATCH,
	REFERENCE_BAND_PROPS,
	REFERENCE_INDEX,
	REFERENCE_LINE_PATCH,
	REFERENCE_LINE_PROPS,
	SERIES_PROPS,
	SERIES_REF,
	TRENDLINE_PROPS,
	VALUE,
	WIDTH
} from './schemas.js';
import { describeChart, summarizeChart } from './summary.js';
import { chartSceneToSvg } from './svg.js';
import type { ChartReferenceBand, ChartReferenceLine, ChartSelection, ChartTrendline } from './types.js';

type ParserCtor = { new (): DOMParser };

export interface ChartToolProviderOptions {
	/** Provider id (unique per registry). Default `chart`. */
	id?: string;
	/** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/**
	 * The chart cannot be edited: write tools are hidden and `get_chart` says why. A string
	 * is the reason ("The report is locked").
	 */
	readOnly?: boolean | string | (() => boolean | string);
	/** Size used for summaries, previews and pointer gestures (default 640 × 400). */
	size?: { width: number; height: number };
	/** Enables `import_chart_ooxml` (reading Office chart XML needs a DOMParser). Default: the global one, if any. */
	DOMParser?: ParserCtor;
	/**
	 * Acts out `set_chart_values` and `select_chart_element` with a visible cursor (see
	 * `ChartDirector`); each call is still one undo step. Without it, edits apply at once.
	 */
	director?: ChartDirector;
	/** Who the cursor belongs to (default `{ id: 'agent', name: 'Agent' }`). */
	actor?: ChartDirectorActor;
	/** Turns SVG into an image so `render_chart` can return PNG (e.g. through a canvas). */
	rasterize?: (svg: string, size: { width: number; height: number }) => Promise<{ data: string; mimeType: string }> | { data: string; mimeType: string };
	/**
	 * The agent playback surface its calls are acted out on (default `chart`, where `ChartEditor` attaches).
	 * Set it when one registry holds several editors of this kind, each attached under its own surface id.
	 */
	playbackSurface?: string;
}

/**
 * When to look at the chart, for `render_chart`'s description (after vectorcraft's
 * `render_preview` and Ursula's VIEW_DIAGRAM_INSTRUCTIONS).
 */
export const RENDER_CHART_INSTRUCTIONS =
	'Draws the chart without changing it so you can check how it looks: SVG text by default, or a PNG image with format "png" when the host can rasterize. Returns the layout warnings (hidden or thinned labels, dropped markers) alongside. An image costs tokens, so render after a batch of edits rather than after each one, and use it to check what text cannot tell you: overlapping or cut-off labels, a crowded legend, unreadable colours, whether the chart reads at the given size. For values, ids and warnings alone, get_chart is cheaper.';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const fail = (message: string): never => {
	throw new Error(message);
};

function resolve<T>(result: { ok: boolean; message?: string } & T): T {
	if (!result.ok) fail(result.message ?? 'The change was rejected.');
	return result;
}

/**
 * Agent tools for a chart editor, for a `ToolRegistry`: one tool per operation with strict
 * schemas. Reads (`get_chart`, `render_chart`, `check_chart_colors`, `recommend_chart`,
 * `get_chart_trendline`, `list_chart_presets`, `export_chart_mermaid`, `export_chart_ooxml`)
 * are always there; writes (data, series, categories, presentation, trendlines, reference lines and bands, callouts, highlight, presets,
 * imports, selection, pointer and key input, undo / redo) are hidden while the chart is
 * read-only. Every write is one undo step and returns what it changed.
 */
export function createChartToolProvider(controller: ChartController, options: ChartToolProviderOptions = {}): AgentToolProvider {
	const size = options.size ?? { width: 640, height: 400 };
	const readOnlyReason = (): string | null => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (!r) return null;
		return typeof r === 'string' ? r : 'This chart is read-only.';
	};
	const spec = () => controller.getSpec();
	const seriesById = (ref: string) => {
		const s = spec().series.find((x) => x.id === ref) ?? spec().series.find((x) => x.name === ref);
		if (!s) fail(`There is no series "${ref}"; expected one of ${spec().series.map((x) => `"${x.id}" (${x.name})`).join(', ') || '(none yet; add one with add_chart_series)'}.`);
		return s!;
	};
	const categoryIndex = (ref: string | number) => {
		const categories = spec().categories;
		const index = typeof ref === 'number' ? ref : categories.indexOf(ref);
		if (!Number.isInteger(index) || index < 0 || index >= categories.length)
			fail(`There is no category ${JSON.stringify(ref)}; expected an index from 0 to ${categories.length - 1} or one of ${categories.slice(0, 20).map((c) => JSON.stringify(c)).join(', ')}.`);
		return index;
	};
	const table = () => chartDataToTable(spec());
	const Parser = (): ParserCtor | undefined => options.DOMParser ?? (globalThis as { DOMParser?: ParserCtor }).DOMParser;

	const getChart: AgentTool = {
		name: 'get_chart',
		title: 'Read the chart',
		description:
			'Returns the chart spec (type, titles, axes, legend, series with ids and settings), its data as a table (header row of series names, then one row per category), the current selection, and a summary at the given size: per-series min / max / mean / trend, the axes as drawn, layout warnings (hidden labels, thinned lines), a colour check and a plain-language description. Use the series ids and category indexes it returns with the write tools.',
		inputSchema: { type: 'object', properties: { width: WIDTH, height: HEIGHT }, additionalProperties: false },
		annotations: { title: 'Read the chart', ...READ },
		handler: ({ width = size.width, height = size.height }) => {
			const reason = readOnlyReason();
			return {
				spec: controller.toJSON(),
				table: table(),
				selection: controller.getState().selection,
				summary: summarizeChart(controller.toJSON(), { width, height }),
				issues: controller.getState().issues,
				...(reason ? { readOnly: reason } : {})
			};
		}
	};

	const renderChart: AgentTool = {
		name: 'render_chart',
		title: 'Render the chart',
		description: RENDER_CHART_INSTRUCTIONS,
		inputSchema: {
			type: 'object',
			properties: {
				width: WIDTH,
				height: HEIGHT,
				format: { type: 'string', enum: ['svg', 'png'], description: 'svg (default): the SVG document as text. png: an image to look at (only when the host can rasterize; costs image tokens).' }
			},
			additionalProperties: false
		},
		annotations: { title: 'Render the chart', ...READ },
		handler: async ({ width = size.width, height = size.height, format = 'svg' }) => {
			const json = controller.toJSON();
			const scene = layoutChart(json, { width, height, selection: null });
			const svg = chartSceneToSvg(scene, { ariaLabel: json.title || undefined, description: describeChart(json) });
			const warnings = scene.warnings;
			if (format === 'png') {
				if (!options.rasterize) fail('This host cannot rasterize charts; call render_chart with format "svg", or get_chart for the layout warnings.');
				const image = await options.rasterize!(svg, { width, height });
				const info = { width, height, mimeType: image.mimeType, warnings };
				const note = warnings.length ? `Layout warnings: ${warnings.map((w) => w.message).join(' ')}` : 'No layout warnings.';
				return {
					content: [
						{ type: 'image', data: image.data, mimeType: image.mimeType },
						{ type: 'text', text: `Chart at ${width} × ${height}. ${note}` }
					],
					structuredContent: info
				};
			}
			return { svg, width, height, warnings };
		}
	};

	const checkColors: AgentTool = {
		name: 'check_chart_colors',
		title: 'Check chart colours',
		description:
			'Checks whether the chart\'s colours are accessible: that colour-blind readers can tell them apart (protanopia, deuteranopia and tritanopia, by OKLab distance after simulation) as well as people with normal vision, and that they stand out from the background. Checks the chart\'s own series (or slice) colours unless colours are given. Returns the closest pair per vision, contrast ratios and problems as sentences.',
		inputSchema: {
			type: 'object',
			properties: {
				colors: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Colours to check instead of the chart\'s (hex or rgb()).' },
				surface: { type: 'string', description: 'Background colour (default white).' }
			},
			additionalProperties: false
		},
		annotations: { title: 'Check chart colours', ...READ },
		handler: ({ colors, surface }) => {
			const s = spec();
			const visible = s.series.filter((x) => !x.hidden);
			const own = chartSpecColorsByCategory(s) ? s.categories.map((_, i) => visible[0]?.pointColors?.[i] || chartSliceColor(s, i)) : visible.map((x) => chartSeriesColor(s, s.series.indexOf(x)));
			return { colors: colors ?? own, ...checkChartColors(colors ?? own, { surface }) };
		}
	};

	const recommend: AgentTool = {
		name: 'recommend_chart',
		title: 'Recommend chart types',
		description:
			'Suggests chart types for data, best first, each with a reason: from CSV text when given, else from the chart\'s current data. Uses the shape of the data (series count, points, dates, negative values).',
		inputSchema: { type: 'object', properties: { csv: { type: 'string', description: 'CSV or TSV text to analyse instead of the current data (first row may be series names, first column categories).' } }, additionalProperties: false },
		annotations: { title: 'Recommend chart types', ...READ },
		handler: ({ csv }) => {
			const rows = csv !== undefined ? parseCsv(csv, { delimiter: csv.includes('\t') ? '\t' : ',' }) : table();
			const recommendations = recommendChartTypes(rows);
			if (!recommendations.length) fail('There are no numbers to chart: give CSV with at least one numeric column.');
			return { recommendations };
		}
	};

	const getTrendline: AgentTool = {
		name: 'get_chart_trendline',
		title: 'Read a trendline fit',
		description: 'Returns a trendline\'s fitted coefficients (in x for category charts, x = 1, 2, 3, …), R², equation and the number of points, or the moving-average points.',
		inputSchema: {
			type: 'object',
			properties: { series: SERIES_REF, index: { type: 'integer', minimum: 0, description: 'Trendline index on the series (0 = first).' } },
			required: ['series', 'index'],
			additionalProperties: false
		},
		annotations: { title: 'Read a trendline fit', ...READ },
		handler: ({ series, index }) => {
			const s = seriesById(series);
			const line = s.trendlines?.[index];
			if (!line) fail(`"${s.name}" has no trendline ${index}; it has ${s.trendlines?.length ?? 0}.`);
			if (line!.type === 'moving-average') return { trendline: line, points: controller.trendlineMovingAverage(s.id, index) };
			const fit = controller.trendlineFit(s.id, index);
			if (!fit) fail(`The ${line!.type} trendline on "${s.name}" cannot be fitted: it needs more points (and positive values for log, exponential and power fits).`);
			return { trendline: line, coefficients: fit!.coefficients, r2: fit!.r2, equation: fit!.equation, points: fit!.points };
		}
	};

	const listPresets: AgentTool = {
		name: 'list_chart_presets',
		title: 'List chart presets',
		description: 'Lists the quick layouts and colour schemes apply_chart_preset accepts, with what each changes.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'List chart presets', ...READ },
		handler: () => ({
			layouts: CHART_LAYOUT_PRESETS.map(({ id, label, description }) => ({ id, label, description })),
			colorSchemes: CHART_COLOR_SCHEMES.map(({ id, label, description, palette }) => ({ id, label, description, palette }))
		})
	};

	const exportMermaid: AgentTool = {
		name: 'export_chart_mermaid',
		title: 'Export chart as Mermaid',
		description:
			'Returns the chart as Mermaid text (xychart-beta, pie or radar-beta) for Markdown or chat. With meta (default true) one "%% @pixerate {…}" comment keeps what Mermaid cannot express, so import_chart_mermaid gets the chart back exactly.',
		inputSchema: { type: 'object', properties: { meta: { type: 'boolean', description: 'Include the round-trip comment (default true).' } }, additionalProperties: false },
		annotations: { title: 'Export chart as Mermaid', ...READ },
		handler: ({ meta = true }) => ({ mermaid: chartToMermaid(controller.toJSON(), { meta }) })
	};

	const exportOoxml: AgentTool = {
		name: 'export_chart_ooxml',
		title: 'Export chart as Office XML',
		description: 'Returns the chart as a DrawingML chart part (c:chartSpace) for Word or PowerPoint files, with what could not be written as sentences.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Export chart as Office XML', ...READ },
		handler: () => chartToOoxml(controller.toJSON())
	};

	// ---------------------------------------------------------------- writes

	const updateChart: AgentTool = {
		name: 'update_chart',
		title: 'Change chart presentation',
		description:
			'Changes how the chart looks, as one undo step: type, titles, axes (xAxis = categories or numeric x, yAxis = values, yAxis2 = secondary values; each can be reversed, and value axes can be logarithmic with scale "log"), legend, stacking, orientation, curve, points, data labels and their position, palette, donut hole, bar spacing, histogram bins, waterfall total, radar rings (radarTicks) and grid shape (radarGraticule), note, highlight, reference lines and bands (whole lists), and varyColors. All-or-nothing: invalid values change nothing and come back as sentences. Returns the new spec.',
		inputSchema: {
			type: 'object',
			properties: CHART_UPDATE_PROPERTIES,
			additionalProperties: false
		},
		annotations: { title: 'Change chart presentation', ...WRITE_IDEMPOTENT },
		handler: (args) => {
			if (!Object.keys(args).length) fail('Nothing to change: pass at least one field, e.g. {"type": "line"}.');
			resolve(controller.update(args as ChartSpecPatch));
			return { spec: controller.toJSON() };
		}
	};

	const setData: AgentTool = {
		name: 'set_chart_data',
		title: 'Replace chart data',
		description: 'Replaces the categories and / or the series as one undo step. Each series has one value per category (padded with gaps). Returns the data table and the series ids.',
		inputSchema: {
			type: 'object',
			properties: {
				categories: { type: 'array', items: { type: 'string' }, description: 'Category labels in order.' },
				series: {
					type: 'array',
					description: 'The new series (replaces all).',
					items: { type: 'object', properties: { id: { type: 'string', description: 'Stable id (optional).' }, ...SERIES_PROPS }, required: ['name', 'values'], additionalProperties: false }
				}
			},
			additionalProperties: false
		},
		annotations: { title: 'Replace chart data', ...DESTRUCTIVE },
		handler: (args) => {
			if (!args.categories && !args.series) fail('Pass categories, series or both.');
			resolve(controller.setData(args as any));
			return { table: table(), series: spec().series.map((s) => ({ id: s.id, name: s.name })) };
		}
	};

	const setValues: AgentTool = {
		name: 'set_chart_values',
		title: 'Set chart values',
		description: 'Sets individual values as one undo step (all-or-nothing). Series by id or name, category by index or label. Returns the values as stored.',
		inputSchema: {
			type: 'object',
			properties: {
				cells: {
					type: 'array',
					minItems: 1,
					description: 'Values to set.',
					items: { type: 'object', properties: { series: SERIES_REF, category: CATEGORY_REF, value: VALUE }, required: ['series', 'category', 'value'], additionalProperties: false }
				}
			},
			required: ['cells'],
			additionalProperties: false
		},
		annotations: { title: 'Set chart values', ...WRITE_IDEMPOTENT },
		handler: async ({ cells }) => {
			const resolved = (cells as { series: string; category: string | number; value: unknown }[]).map((c) => ({ seriesId: seriesById(c.series).id, index: categoryIndex(c.category), value: c.value }));
			const parsed = resolved.map((c) => parseChartValue(c.value));
			const bad = resolved.find((_, i) => parsed[i] === undefined);
			if (bad) fail(`"${String(bad.value)}" is not a number; pass a number, numeric text or null for a gap. Nothing was changed.`);
			if (options.director && parsed.every((v) => typeof v === 'number')) {
				const results = await options.director.perform(options.actor ?? { id: 'agent', name: 'Agent' }, resolved.map((c, i) => ({ kind: 'setValue' as const, seriesId: c.seriesId, index: c.index, value: parsed[i] as number })));
				const failed = results.find((r) => !r.ok);
				if (failed && !failed.ok) fail(failed.message);
			} else resolve(controller.setValues(resolved));
			return { cells: resolved.map((c) => ({ series: c.seriesId, category: spec().categories[c.index], index: c.index, value: controller.getSeries(c.seriesId)!.values[c.index] })) };
		}
	};

	const addSeries: AgentTool = {
		name: 'add_chart_series',
		title: 'Add a series',
		description: 'Adds a series (values padded to the categories) and selects it. Returns its id and stored values.',
		inputSchema: {
			type: 'object',
			properties: { ...SERIES_PROPS, id: { type: 'string', description: 'Id to use (default: series-N).' }, at: { type: 'integer', minimum: 0, description: 'Position (default: last).' } },
			required: ['name'],
			additionalProperties: false
		},
		annotations: { title: 'Add a series', ...WRITE },
		handler: ({ at, ...input }) => {
			const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== null));
			const result = resolve(controller.addSeries(clean as any, { at })) as { id: string };
			const s = controller.getSeries(result.id)!;
			return { id: s.id, name: s.name, values: s.values };
		}
	};

	const updateSeries: AgentTool = {
		name: 'update_chart_series',
		title: 'Change a series',
		description: 'Renames, recolours, hides, moves to the secondary axis or changes how a series is drawn (marker, curve, labels, format, x values, bubble sizes, point colours, error bars). null resets a field. Values change with set_chart_values. Returns the series.',
		inputSchema: {
			type: 'object',
			properties: { series: SERIES_REF, ...Object.fromEntries(Object.entries(SERIES_PROPS).filter(([k]) => k !== 'values')) },
			required: ['series'],
			additionalProperties: false
		},
		annotations: { title: 'Change a series', ...WRITE_IDEMPOTENT },
		handler: ({ series, ...patch }) => {
			const id = seriesById(series).id;
			if (!Object.keys(patch).length) fail('Nothing to change: pass a field such as {"color": "#e8710a"} or {"axis": "secondary"}.');
			resolve(controller.updateSeries(id, patch as ChartSeriesPatch));
			return { series: controller.getSeries(id) };
		}
	};

	const removeSeries: AgentTool = {
		name: 'remove_chart_series',
		title: 'Delete a series',
		description: 'Deletes a series and its values. Returns the remaining series ids.',
		inputSchema: { type: 'object', properties: { series: SERIES_REF }, required: ['series'], additionalProperties: false },
		annotations: { title: 'Delete a series', ...DESTRUCTIVE },
		handler: ({ series }) => {
			resolve(controller.removeSeries(seriesById(series).id));
			return { series: spec().series.map((s) => ({ id: s.id, name: s.name })) };
		}
	};

	const addCategory: AgentTool = {
		name: 'add_chart_category',
		title: 'Add a category',
		description: 'Inserts a category (a gap in every series) and returns its index.',
		inputSchema: {
			type: 'object',
			properties: { label: { type: 'string', description: 'Category label (default: its number).' }, at: { type: 'integer', minimum: 0, description: 'Index to insert at (default: the end).' } },
			additionalProperties: false
		},
		annotations: { title: 'Add a category', ...WRITE },
		handler: ({ label, at }) => {
			const result = controller.addCategory(label, { at });
			return { index: result.index, categories: spec().categories };
		}
	};

	const removeCategory: AgentTool = {
		name: 'remove_chart_category',
		title: 'Delete a category',
		description: 'Deletes a category and its value in every series. Returns the remaining categories.',
		inputSchema: { type: 'object', properties: { category: CATEGORY_REF }, required: ['category'], additionalProperties: false },
		annotations: { title: 'Delete a category', ...DESTRUCTIVE },
		handler: ({ category }) => {
			resolve(controller.removeCategory(categoryIndex(category)));
			return { categories: spec().categories };
		}
	};

	const importCsv: AgentTool = {
		name: 'import_chart_csv',
		title: 'Import chart data from CSV',
		description:
			'Replaces the data with CSV or TSV text as one undo step. By default the first row holds series names and the first column categories (detected when "auto"). chartType "auto" also picks the recommended chart type (two unlabelled numeric columns become a scatter of x against y). Returns the data table, the chart type and cells that were not numbers.',
		inputSchema: {
			type: 'object',
			properties: {
				csv: { type: 'string', description: 'CSV or TSV text (tabs are detected).' },
				seriesIn: { type: 'string', enum: ['columns', 'rows'], description: 'Series run down columns (default) or along rows. Ignored with chartType "auto".' },
				header: { type: ['boolean', 'string'], enum: [true, false, 'auto'], description: 'The first row holds series names: true (default), false or "auto". Ignored with chartType "auto".' },
				chartType: { type: 'string', enum: ['keep', 'auto'], description: '"keep" (default) keeps the chart type; "auto" reads the table shape and picks a type.' }
			},
			required: ['csv'],
			additionalProperties: false
		},
		annotations: { title: 'Import chart data from CSV', ...DESTRUCTIVE },
		handler: ({ csv, seriesIn, header, chartType = 'keep' }) => {
			if (chartType === 'auto') {
				const rows = parseCsv(csv, { delimiter: csv.includes('\t') ? '\t' : ',' });
				const built = chartFromTable(rows);
				if (!built.series.length || !built.categories.length) fail('There is no data to import: expected at least one row of numbers.');
				resolve(controller.update({ type: built.type, stacking: built.stacking, categories: built.categories, series: built.series }, { label: 'Import data' }));
				return { type: built.type, table: table(), issues: built.issues };
			}
			const result = resolve(controller.importCsv(csv, { seriesIn, header })) as { issues?: unknown[] };
			return { type: spec().type, table: table(), issues: result.issues ?? [] };
		}
	};

	const importMermaid: AgentTool = {
		name: 'import_chart_mermaid',
		title: 'Import a Mermaid chart',
		description:
			'Replaces the chart with Mermaid xychart-beta, pie or radar-beta text as one undo step (a "%% @pixerate" comment from export_chart_mermaid restores everything else). Lines that cannot be read are skipped and listed with their line numbers. Returns the spec.',
		inputSchema: { type: 'object', properties: { mermaid: { type: 'string', description: 'Mermaid text, optionally inside a ```mermaid fence.' } }, required: ['mermaid'], additionalProperties: false },
		annotations: { title: 'Import a Mermaid chart', ...DESTRUCTIVE },
		handler: ({ mermaid }) => {
			const fenced = /```(?:mermaid)?\s*\n([\s\S]*?)```/.exec(mermaid);
			const read = chartFromMermaid(fenced ? fenced[1] : mermaid);
			if (!read.family) fail(read.issues.map((i) => i.message).join(' ') || 'Expected Mermaid starting with xychart-beta, pie or radar-beta.');
			resolve(controller.update({ ...read.spec } as ChartSpecPatch, { label: 'Import Mermaid chart' }));
			return { spec: controller.toJSON(), issues: read.issues };
		}
	};

	const importOoxml: AgentTool = {
		name: 'import_chart_ooxml',
		title: 'Import an Office chart',
		description:
			'Replaces the chart with an Office chart part (DrawingML c:chartSpace, or chartex for waterfall, funnel, treemap, histogram and box charts) as one undo step. Returns the spec, problems, and the features the editor cannot hold.',
		inputSchema: { type: 'object', properties: { xml: { type: 'string', description: 'The chart part XML, e.g. word/charts/chart1.xml.' } }, required: ['xml'], additionalProperties: false },
		annotations: { title: 'Import an Office chart', ...DESTRUCTIVE },
		handler: ({ xml }) => {
			const read = chartFromOoxml(xml, { DOMParser: Parser() });
			if (read.issues.some((i) => i.path === '' || i.path === 'plotArea')) fail(read.issues.map((i) => i.message).join(' '));
			resolve(controller.update({ ...read.spec } as ChartSpecPatch, { label: 'Import Office chart' }));
			return { spec: controller.toJSON(), issues: read.issues.map((i) => i.message), unsupported: read.unsupported, lossless: read.lossless };
		}
	};

	const addTrendline: AgentTool = {
		name: 'add_chart_trendline',
		title: 'Add a trendline',
		description: 'Fits a trendline to a series and draws it (unstacked bar, line, area, scatter and bubble charts). Returns its index and the fit: coefficients, R² and equation.',
		inputSchema: { type: 'object', properties: { series: SERIES_REF, ...TRENDLINE_PROPS }, required: ['series', 'type'], additionalProperties: false },
		annotations: { title: 'Add a trendline', ...WRITE },
		handler: ({ series, ...line }) => {
			const s = seriesById(series);
			const result = resolve(controller.addTrendline(s.id, line as ChartTrendline)) as { index: number; fit: ReturnType<ChartController['trendlineFit']> };
			return { series: s.id, index: result.index, ...(result.fit ? { coefficients: result.fit.coefficients, r2: result.fit.r2, equation: result.fit.equation } : {}) };
		}
	};

	const removeTrendline: AgentTool = {
		name: 'remove_chart_trendline',
		title: 'Delete a trendline',
		description: 'Deletes a trendline from a series. Returns the series\' remaining trendlines.',
		inputSchema: {
			type: 'object',
			properties: { series: SERIES_REF, index: { type: 'integer', minimum: 0, description: 'Trendline index on the series (0 = first).' } },
			required: ['series', 'index'],
			additionalProperties: false
		},
		annotations: { title: 'Delete a trendline', ...DESTRUCTIVE },
		handler: ({ series, index }) => {
			const s = seriesById(series);
			resolve(controller.removeTrendline(s.id, index));
			return { series: s.id, trendlines: controller.getSeries(s.id)?.trendlines ?? [] };
		}
	};

	const referenceTools = (what: 'line' | 'band') => {
		const Kind = what === 'line' ? 'Reference line' : 'Reference band';
		const list = (): readonly (ChartReferenceLine | ChartReferenceBand)[] => (what === 'line' ? spec().referenceLines : spec().referenceBands);
		const listKey = what === 'line' ? 'referenceLines' : 'referenceBands';
		const add: AgentTool = {
			name: `add_chart_reference_${what}`,
			title: `Add a reference ${what}`,
			description:
				what === 'line'
					? 'Draws a dashed line across the plot at one value: a target, a floor, an average (bar, line, area, scatter and bubble charts). The axis grows to keep it in view. Returns its index and the reference lines.'
					: 'Shades a band across the plot between two values: a target or normal range (bar, line, area, scatter and bubble charts), drawn under the data. The axis grows to keep it in view. Returns its index and the reference bands.',
			inputSchema: { type: 'object', properties: what === 'line' ? REFERENCE_LINE_PROPS : REFERENCE_BAND_PROPS, required: what === 'line' ? ['value'] : ['from', 'to'], additionalProperties: false },
			annotations: { title: `Add a reference ${what}`, ...WRITE },
			handler: (args) => {
				const result = resolve(what === 'line' ? controller.addReferenceLine(args as ChartReferenceLine) : controller.addReferenceBand(args as ChartReferenceBand)) as { index: number };
				return { index: result.index, [listKey]: list() };
			}
		};
		const update: AgentTool = {
			name: `update_chart_reference_${what}`,
			title: `Change a reference ${what}`,
			description: `Changes a reference ${what} by index (all-or-nothing); label, axis and color take null to remove them. Returns the ${what} as stored.`,
			inputSchema: { type: 'object', properties: { index: REFERENCE_INDEX(Kind), ...(what === 'line' ? REFERENCE_LINE_PATCH : REFERENCE_BAND_PATCH) }, required: ['index'], additionalProperties: false },
			annotations: { title: `Change a reference ${what}`, ...WRITE_IDEMPOTENT },
			handler: ({ index, ...patch }) => {
				if (!Object.keys(patch).length) fail(`Nothing to change: pass at least one field besides index, e.g. {"index": ${index}, "label": "Target"}.`);
				resolve(what === 'line' ? controller.updateReferenceLine(index, patch) : controller.updateReferenceBand(index, patch));
				return { index, [`reference${what === 'line' ? 'Line' : 'Band'}`]: list()[index] };
			}
		};
		const remove: AgentTool = {
			name: `remove_chart_reference_${what}`,
			title: `Delete a reference ${what}`,
			description: `Deletes a reference ${what} by index; the ones after it move up one. Returns the reference ${what}s left.`,
			inputSchema: { type: 'object', properties: { index: REFERENCE_INDEX(Kind) }, required: ['index'], additionalProperties: false },
			annotations: { title: `Delete a reference ${what}`, ...DESTRUCTIVE },
			handler: ({ index }) => {
				resolve(what === 'line' ? controller.removeReferenceLine(index) : controller.removeReferenceBand(index));
				return { [listKey]: list() };
			}
		};
		return [add, update, remove];
	};
	const [addReferenceLine, updateReferenceLine, removeReferenceLine] = referenceTools('line');
	const [addReferenceBand, updateReferenceBand, removeReferenceBand] = referenceTools('band');

	const setCallout: AgentTool = {
		name: 'set_chart_callout',
		title: 'Pin a label to a point',
		description:
			'Pins a short label to one bar or point, with a leader line, to say why it matters ("Record quarter", "Launch"); label null or "" removes it. Bar, line, area, scatter and bubble charts; the point must have a value. Selects the point and returns the series id, category index and label.',
		inputSchema: {
			type: 'object',
			properties: { series: SERIES_REF, category: CATEGORY_REF, label: { type: ['string', 'null'], description: 'The label (keep it to a few words), or null to remove it.' } },
			required: ['series', 'category', 'label'],
			additionalProperties: false
		},
		annotations: { title: 'Pin a label to a point', ...WRITE_IDEMPOTENT },
		handler: ({ series, category, label }) => {
			const s = seriesById(series);
			const index = categoryIndex(category);
			resolve(controller.setCallout(s.id, index, label));
			return { series: s.id, index, category: spec().categories[index], label: controller.getSeries(s.id)?.callouts?.[index] ?? null };
		}
	};

	const highlight: AgentTool = {
		name: 'highlight_chart',
		title: 'Highlight categories or series',
		description:
			'Draws the named categories (labels) and series (names or ids) normally and mutes the rest, to draw attention to the marks the chart is about; [] shows everything again. A point stays bright when its category or its series is named. Unknown names change nothing and are reported. Returns the category indexes and series ids that matched.',
		inputSchema: {
			type: 'object',
			properties: { names: { type: 'array', items: { type: 'string' }, description: 'Category labels and / or series names or ids, exactly as get_chart shows them. [] clears the highlight.' } },
			required: ['names'],
			additionalProperties: false
		},
		annotations: { title: 'Highlight categories or series', ...WRITE_IDEMPOTENT },
		handler: ({ names }) => {
			const result = resolve(controller.setHighlight(names)) as { categories: number[]; series: string[] };
			const s = spec();
			return { highlight: s.highlight, categories: result.categories.map((index) => ({ index, label: s.categories[index] })), series: result.series.map((id) => ({ id, name: s.series.find((x) => x.id === id)!.name })) };
		}
	};

	const applyPreset: AgentTool = {
		name: 'apply_chart_preset',
		title: 'Apply a chart style',
		description: 'Applies a quick layout (legend, labels and grid lines together) and / or a colour scheme as one undo step. See list_chart_presets for the names. Returns the new spec.',
		inputSchema: {
			type: 'object',
			properties: {
				layout: { type: 'string', enum: CHART_LAYOUT_PRESETS.map((p) => p.id), description: 'Quick layout id.' },
				colors: { type: 'string', enum: CHART_COLOR_SCHEMES.map((p) => p.id), description: 'Colour scheme id.' }
			},
			additionalProperties: false
		},
		annotations: { title: 'Apply a chart style', ...WRITE_IDEMPOTENT },
		handler: ({ layout, colors }) => {
			resolve(controller.applyPreset({ layout, colors }));
			return { spec: controller.toJSON() };
		}
	};

	const transpose: AgentTool = {
		name: 'transpose_chart',
		title: 'Switch rows and columns',
		description: 'Swaps series and categories (each category becomes a series) as one undo step. Per-series colours and settings are dropped. Returns the data table.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Switch rows and columns', ...WRITE },
		handler: () => {
			resolve(controller.transpose());
			return { table: table(), series: spec().series.map((s) => ({ id: s.id, name: s.name })) };
		}
	};

	const select: AgentTool = {
		name: 'select_chart_element',
		title: 'Select a chart element',
		description: 'Selects part of the chart (as a click would), for press_chart_key and for the user to see. kind "none" clears the selection. Returns the selection.',
		inputSchema: {
			type: 'object',
			properties: {
				kind: { type: 'string', enum: ['none', 'chart', 'title', 'subtitle', 'legend', 'axis', 'series', 'point', 'category', 'trendline'], description: 'What to select.' },
				series: { ...SERIES_REF, description: 'Series id or name (series, point, trendline).' },
				category: { ...CATEGORY_REF, description: 'Category index or label (point, category).' },
				axis: { type: 'string', enum: ['x', 'y', 'y2'], description: 'Axis (axis).' },
				index: { type: 'integer', minimum: 0, description: 'Trendline index (trendline).' }
			},
			required: ['kind'],
			additionalProperties: false
		},
		annotations: { title: 'Select a chart element', ...WRITE_IDEMPOTENT },
		handler: async ({ kind, series, category, axis, index }) => {
			let sel: ChartSelection | null;
			const need = (v: unknown, what: string) => v === undefined && fail(`kind "${kind}" needs ${what}.`);
			switch (kind) {
				case 'none':
					sel = null;
					break;
				case 'axis':
					need(axis, 'axis');
					sel = { kind, axis };
					break;
				case 'series':
					need(series, 'series');
					sel = { kind, seriesId: seriesById(series).id };
					break;
				case 'point':
					need(series, 'series');
					need(category, 'category');
					sel = { kind, seriesId: seriesById(series).id, index: categoryIndex(category) };
					break;
				case 'category':
					need(category, 'category');
					sel = { kind, index: categoryIndex(category) };
					break;
				case 'trendline':
					need(series, 'series');
					need(index, 'index');
					sel = { kind, seriesId: seriesById(series).id, index };
					break;
				default:
					sel = { kind } as ChartSelection;
			}
			if (options.director) await options.director.perform(options.actor ?? { id: 'agent', name: 'Agent' }, [{ kind: 'select', selection: sel }]);
			else controller.select(sel);
			const now = controller.getState().selection;
			if (sel && !now) fail(`Nothing to select there (e.g. the chart has no ${kind} of that kind).`);
			return { selection: now };
		}
	};

	const drag: AgentTool = {
		name: 'drag_chart_point',
		title: 'Drag a chart point',
		description:
			'Drags on the chart as a pointer would, through the same code as the mouse: from a bar or point to a new position, with the same snapping (to other values, zero and ticks), fine adjustment (fine: Alt) and axis lock on scatter charts (lockAxis: Shift). Positions are 0–1 fractions of the chart\'s width and height at the given size (use render_chart to see where marks are). One undo step. Returns what was dragged and the value before and after.',
		inputSchema: {
			type: 'object',
			properties: {
				from: { type: 'object', description: 'Start, as fractions of the chart (0,0 top-left).', properties: { x: { type: 'number', minimum: 0, maximum: 1, description: 'Fraction of the width.' }, y: { type: 'number', minimum: 0, maximum: 1, description: 'Fraction of the height.' } }, required: ['x', 'y'], additionalProperties: false },
				to: { type: 'object', description: 'End, as fractions of the chart.', properties: { x: { type: 'number', minimum: 0, maximum: 1, description: 'Fraction of the width.' }, y: { type: 'number', minimum: 0, maximum: 1, description: 'Fraction of the height.' } }, required: ['x', 'y'], additionalProperties: false },
				fine: { type: 'boolean', description: 'Move a tenth as far (Alt).' },
				lockAxis: { type: 'boolean', description: 'Scatter charts: change only the axis moved along most (Shift).' },
				width: WIDTH,
				height: HEIGHT
			},
			required: ['from', 'to'],
			additionalProperties: false
		},
		annotations: { title: 'Drag a chart point', ...WRITE },
		handler: ({ from, to, fine, lockAxis, width = size.width, height = size.height }) => {
			const scene = layoutChart(controller.toJSON(), { width, height });
			const start = { x: from.x * width, y: from.y * height };
			const target = chartHitTest(scene, start);
			if (target?.kind !== 'point') fail(`There is no bar or point at (${from.x}, ${from.y}); ${target ? `that is the ${target.kind}` : 'that is outside the chart'}. Use render_chart to find marks.`);
			const t = target as Extract<ChartSelection, { kind: 'point' }>;
			const before = controller.getSeries(t.seriesId)?.values[t.index] ?? null;
			const session = startChartPointDrag(controller, scene, t, start);
			if (!session) fail('That point cannot be dragged here (percent-stacked charts, pies and gaps cannot be dragged).');
			session!.move({ x: to.x * width, y: to.y * height }, { fine, lockAxis });
			session!.end();
			const s = controller.getSeries(t.seriesId)!;
			return { series: s.id, category: spec().categories[t.index], index: t.index, before, after: s.values[t.index], ...(s.x ? { x: s.x[t.index] } : {}) };
		}
	};

	const key: AgentTool = {
		name: 'press_chart_key',
		title: 'Press a key on the chart',
		description:
			'Sends a key to the chart as the keyboard would, acting on the selection (select_chart_element first): ← → move between categories, ↑ ↓ change the selected value by a tenth of a tick (shift: a whole tick, alt: a hundredth), Delete removes the selection, Escape clears it. Returns whether the key did anything and the new selection.',
		inputSchema: {
			type: 'object',
			properties: {
				key: { type: 'string', enum: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace', 'Escape'], description: 'Key name.' },
				shift: { type: 'boolean', description: 'Hold Shift.' },
				alt: { type: 'boolean', description: 'Hold Alt / Option.' }
			},
			required: ['key'],
			additionalProperties: false
		},
		annotations: { title: 'Press a key on the chart', ...DESTRUCTIVE },
		handler: ({ key: k, shift, alt }) => {
			const scene = layoutChart(controller.toJSON(), size);
			const used = handleChartKey(controller, scene, { key: k, shiftKey: shift, altKey: alt });
			const sel = controller.getState().selection;
			const value = sel?.kind === 'point' ? (controller.getSeries(sel.seriesId)?.values[sel.index] ?? null) : undefined;
			return { used, selection: sel, ...(value !== undefined ? { value } : {}) };
		}
	};

	const undo: AgentTool = {
		name: 'undo_chart',
		title: 'Undo a chart edit',
		description: 'Undoes the last chart edit. Returns whether something was undone and what the next undo would be.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Undo a chart edit', ...WRITE },
		handler: () => {
			const label = controller.getState().undoLabel;
			const undone = controller.undo();
			return { undone, ...(undone ? { label } : {}), next: controller.getState().undoLabel || null };
		}
	};

	const redo: AgentTool = {
		name: 'redo_chart',
		title: 'Redo a chart edit',
		description: 'Redoes the last undone chart edit. Returns whether something was redone.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Redo a chart edit', ...WRITE },
		handler: () => {
			const label = controller.getState().redoLabel;
			const redone = controller.redo();
			return { redone, ...(redone ? { label } : {}) };
		}
	};

	const reads = [getChart, renderChart, checkColors, recommend, getTrendline, listPresets, exportMermaid, exportOoxml];
	const writes = [
		updateChart,
		setData,
		setValues,
		addSeries,
		updateSeries,
		removeSeries,
		addCategory,
		removeCategory,
		importCsv,
		importMermaid,
		addTrendline,
		removeTrendline,
		addReferenceLine,
		updateReferenceLine,
		removeReferenceLine,
		addReferenceBand,
		updateReferenceBand,
		removeReferenceBand,
		setCallout,
		highlight,
		applyPreset,
		transpose,
		select,
		drag,
		key,
		undo,
		redo
	];

	return withChartPlayback({
		id: options.id ?? 'chart',
		namespace: options.namespace,
		title: 'Chart editor',
		description: 'One chart: its spec, data and values, series and categories, trendlines, reference lines and bands, callouts, highlight and presets, CSV, Mermaid and OOXML import, rendering and colour checks.',
		skill: 'pixerate-chart',
		tools: () => {
			if (readOnlyReason()) return reads;
			return [...reads, ...writes.slice(0, 10), ...(Parser() ? [importOoxml] : []), ...writes.slice(10)];
		},
		subscribe: (notify) => {
			// Re-announce when read-only state may have changed.
			let last = readOnlyReason();
			return controller.subscribe(() => {
				const now = readOnlyReason();
				if (now !== last) {
					last = now;
					notify();
				}
			});
		}
	}, { director: !!options.director, surface: options.playbackSurface });
}
