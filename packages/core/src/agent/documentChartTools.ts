import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as ProsemirrorNode } from '@tiptap/pm/model';
import { getDocumentCharts, type DocumentChart } from '../extensions/chart/chart-node.js';
import { MAX_SPARKLINE_VALUES, SPARKLINE_KINDS, normalizeSparklineValues, sparklineLabel } from '../extensions/chart/sparkline-node.js';
import { CHART_UPDATE_PROPERTIES, SERIES_PROPS, VALUE } from '../chart/schemas.js';
import { normalizeChartSpec, parseChartValue } from '../chart/spec.js';
import { describeChart } from '../chart/summary.js';
import type { ChartSpec } from '../chart/types.js';
import type { AgentTool } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const SIZE_WIDTH: JsonSchema = {
	type: ['number', 'null'],
	minimum: 50,
	maximum: 4096,
	description: 'Width in pixels, or null to fill the line (default null).'
};
const SIZE_HEIGHT: JsonSchema = { type: 'number', minimum: 50, maximum: 4096, description: 'Height in pixels (default 320).' };

/** The chart data and presentation fields an agent can pass (a `ChartSpec` without `version`). */
const SPEC_PROPERTIES: Record<string, JsonSchema> = {
	...CHART_UPDATE_PROPERTIES,
	categories: { type: 'array', items: { type: 'string' }, description: 'Category labels in order (x axis labels, or pie slices).' },
	series: {
		type: 'array',
		description: 'The series, each with one value per category (padded with gaps).',
		items: {
			type: 'object',
			properties: { id: { type: 'string', description: 'Stable id (default: from the name).' }, ...SERIES_PROPS },
			required: ['name', 'values'],
			additionalProperties: false
		}
	}
};

/** Drops `null` from series fields (null means "use the default" in the tool schema). */
function cleanSeries(series: unknown): unknown {
	if (!Array.isArray(series)) return series;
	return series.map((s) => (s && typeof s === 'object' ? Object.fromEntries(Object.entries(s).filter(([, v]) => v !== null)) : s));
}

/** Normalizes agent input as a chart, throwing every problem as one sentence list. */
function checkedSpec(input: Record<string, unknown>): ChartSpec {
	const { spec, issues } = normalizeChartSpec({ ...input, ...(input.series !== undefined ? { series: cleanSeries(input.series) } : {}) });
	if (issues.length) throw new Error(`The chart was not changed: ${issues.map((i) => i.message).join(' ')}`);
	return spec;
}

function describe(chart: DocumentChart, includeSpec: boolean) {
	const { spec, node } = chart;
	return {
		id: chart.id,
		pos: chart.pos,
		type: spec.type,
		title: spec.title,
		categories: spec.categories,
		series: spec.series.map((s) => ({ id: s.id, name: s.name })),
		width: node.attrs.width ?? null,
		height: node.attrs.height,
		description: describeChart(spec),
		...(includeSpec ? { spec } : {})
	};
}

function sparklines(doc: ProsemirrorNode) {
	const found: { pos: number; kind: string; values: (number | null)[]; label: string }[] = [];
	doc.descendants((node, pos) => {
		if (node.type.name === 'sparkline') found.push({ pos, kind: node.attrs.kind, values: node.attrs.values, label: sparklineLabel(node) });
	});
	return found;
}

function checkPosition(editor: Editor, at: number | undefined) {
	const size = editor.state.doc.content.size;
	if (at !== undefined && at > size) throw new Error(`Position ${at} is outside the document (size ${size}).`);
}

/**
 * Chart tools for a rich-text editor whose schema has the `chart` node:
 * `list_document_charts` (read), `insert_chart` and `update_chart_in_document` (writes), plus
 * `insert_sparkline` when the schema has `sparkline`. `createRichTextToolProvider` adds them.
 */
export function createDocumentChartTools(editor: () => Editor): { read: () => AgentTool[]; write: () => AgentTool[] } {
	const chartType = () => editor().schema.nodes.chart;
	const findChart = (args: { chartId?: string; pos?: number }): DocumentChart => {
		const charts = getDocumentCharts(editor().state.doc);
		const list = charts.map((c) => `"${c.id}" at ${c.pos}`).join(', ') || 'none; add one with insert_chart';
		if (args.chartId !== undefined) {
			const chart = charts.find((c) => c.id === args.chartId);
			if (!chart) throw new Error(`There is no chart "${args.chartId}" in the document. Charts: ${list}.`);
			if (args.pos !== undefined && args.pos !== chart.pos) throw new Error(`Chart "${args.chartId}" is at ${chart.pos}, not ${args.pos}; pass one of chartId or pos.`);
			return chart;
		}
		if (args.pos !== undefined) {
			const chart = charts.find((c) => c.pos === args.pos);
			if (!chart) throw new Error(`There is no chart at position ${args.pos}. Charts: ${list}.`);
			return chart;
		}
		throw new Error(`Pass chartId or pos (from list_document_charts). Charts: ${list}.`);
	};

	const listCharts: AgentTool = {
		name: 'list_document_charts',
		title: 'List charts in the document',
		description:
			'Lists the charts in the document in order: id, document position, type, title, categories, series (ids and names), size in pixels and a plain-language description of the data. Also lists inline sparklines (position, kind, values). Pass the id or position to update_chart_in_document.',
		inputSchema: {
			type: 'object',
			properties: { includeSpec: { type: 'boolean', description: 'Also return each chart\'s full spec (default false).' } },
			additionalProperties: false
		},
		annotations: { title: 'List charts in the document', ...READ },
		handler: ({ includeSpec = false }) => {
			const doc = editor().state.doc;
			return { charts: getDocumentCharts(doc).map((c) => describe(c, includeSpec)), sparklines: editor().schema.nodes.sparkline ? sparklines(doc) : [] };
		}
	};

	const insertChart: AgentTool = {
		name: 'insert_chart',
		title: 'Insert a chart',
		description:
			'Inserts a chart block at a document position (or the cursor), as one undo step. Give the categories and series (one value per category) and any presentation fields (type, titles, axes, legend, stacking, palette, …). Invalid fields change nothing and come back as sentences. Returns the new chart\'s id, position and stored spec.',
		inputSchema: {
			type: 'object',
			properties: {
				spec: { type: 'object', description: 'The chart: categories and series, plus optional presentation fields.', properties: SPEC_PROPERTIES, required: ['categories', 'series'], additionalProperties: false },
				at: { type: 'integer', minimum: 0, description: 'Document position (default: the selection). A position inside a paragraph splits it.' },
				width: SIZE_WIDTH,
				height: SIZE_HEIGHT
			},
			required: ['spec'],
			additionalProperties: false
		},
		annotations: { title: 'Insert a chart', ...WRITE },
		handler: ({ spec: input, at, width = null, height }) => {
			const ed = editor();
			checkPosition(ed, at);
			const spec = checkedSpec(input);
			const id = (ed.extensionManager.extensions.find((e) => e.name === 'chart')?.options.generateId as (() => string) | undefined)?.() ?? `chart-${Date.now().toString(36)}`;
			const node = { type: 'chart', attrs: { id, spec, width, ...(height !== undefined ? { height } : {}) } };
			// Each tool call is its own undo step, however quickly calls follow each other.
			const chain = ed.chain().command(({ tr }) => (closeHistory(tr), true));
			const ok = (at !== undefined ? chain.insertContentAt(at, node) : chain.insertContent(node)).run();
			const chart = getDocumentCharts(ed.state.doc).find((c) => c.id === id);
			if (!ok || !chart) throw new Error(`A chart cannot go at ${at ?? ed.state.selection.from}; pass a position between blocks or inside a paragraph.`);
			return { id: chart.id, pos: chart.pos, spec: chart.spec, width: chart.node.attrs.width, height: chart.node.attrs.height };
		}
	};

	const updateChart: AgentTool = {
		name: 'update_chart_in_document',
		title: 'Change a chart in the document',
		description:
			'Changes one chart (by id or position from list_document_charts) as one undo step: data (categories, series — given series replace all) and / or presentation fields, which merge into the current spec (axes and legend field by field), plus its size. All-or-nothing: invalid values change nothing and come back as sentences. Returns the chart\'s id, position and new spec.',
		inputSchema: {
			type: 'object',
			properties: {
				chartId: { type: 'string', description: 'Chart id from list_document_charts.' },
				pos: { type: 'integer', minimum: 0, description: 'Document position of the chart (from list_document_charts), instead of chartId.' },
				changes: { type: 'object', description: 'Fields to change; omitted fields keep their value.', properties: SPEC_PROPERTIES, additionalProperties: false },
				width: SIZE_WIDTH,
				height: { ...SIZE_HEIGHT, description: 'Height in pixels (default: unchanged).' }
			},
			additionalProperties: false
		},
		annotations: { title: 'Change a chart in the document', ...WRITE_IDEMPOTENT },
		handler: ({ chartId, pos, changes, width, height }) => {
			const ed = editor();
			const chart = findChart({ chartId, pos });
			if (!changes && width === undefined && height === undefined) throw new Error('Nothing to change: pass changes, width or height, e.g. {"changes": {"type": "line"}}.');
			const s = chart.spec;
			const patch = (changes ?? {}) as Record<string, any>;
			const spec = checkedSpec({
				...s,
				...patch,
				xAxis: patch.xAxis ? { ...s.xAxis, ...patch.xAxis } : s.xAxis,
				yAxis: patch.yAxis ? { ...s.yAxis, ...patch.yAxis } : s.yAxis,
				yAxis2: patch.yAxis2 ? { ...s.yAxis2, ...patch.yAxis2 } : s.yAxis2,
				legend: patch.legend ? { ...s.legend, ...patch.legend } : s.legend
			});
			const attrs = { ...chart.node.attrs, spec, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) };
			ed.view.dispatch(closeHistory(ed.state.tr.setNodeMarkup(chart.pos, undefined, attrs)));
			return { id: chart.id, pos: chart.pos, spec, width: attrs.width, height: attrs.height };
		}
	};

	const insertSparkline: AgentTool = {
		name: 'insert_sparkline',
		title: 'Insert a sparkline',
		description: 'Inserts a word-sized chart into the text at a document position (or the cursor), as one undo step. Returns its position and stored values.',
		inputSchema: {
			type: 'object',
			properties: {
				values: { type: 'array', items: VALUE, minItems: 1, maxItems: MAX_SPARKLINE_VALUES, description: 'Values in order (null for a gap).' },
				kind: { type: 'string', enum: [...SPARKLINE_KINDS], description: 'line (default), column, or win-loss (sign only).' },
				at: { type: 'integer', minimum: 0, description: 'Document position inside a paragraph (default: the selection).' },
				width: { type: 'number', minimum: 4, maximum: 1000, description: 'Width in pixels (default 80).' },
				height: { type: 'number', minimum: 4, maximum: 200, description: 'Height in pixels (default 18).' },
				color: { type: 'string', description: 'CSS colour (default: the first palette colour).' },
				label: { type: 'string', description: 'Accessible label (default: "Trend from <first> to <last>").' }
			},
			required: ['values'],
			additionalProperties: false
		},
		annotations: { title: 'Insert a sparkline', ...WRITE },
		handler: ({ values, kind = 'line', at, width = 80, height = 18, color = null, label = null }) => {
			const ed = editor();
			checkPosition(ed, at);
			const parsed = (values as unknown[]).map((v) => parseChartValue(v));
			const bad = parsed.findIndex((v) => v === undefined);
			if (bad >= 0) throw new Error(`values[${bad}] ("${String(values[bad])}") is not a number; pass numbers, numeric text or null. Nothing was inserted.`);
			const pos = at ?? ed.state.selection.from;
			if (!ed.state.doc.resolve(pos).parent.inlineContent) throw new Error(`Position ${pos} is between blocks; a sparkline goes inside a paragraph (use a position from get_text {blocks: true}).`);
			const stored = normalizeSparklineValues(parsed);
			ed.chain().command(({ tr }) => (closeHistory(tr), true)).insertContentAt(pos, { type: 'sparkline', attrs: { values: stored, kind, width, height, color, label } }).run();
			return { pos, kind, values: stored };
		}
	};

	return {
		read: () => (chartType() ? [listCharts] : []),
		write: () => (chartType() ? [insertChart, updateChart, ...(editor().schema.nodes.sparkline ? [insertSparkline] : [])] : [])
	};
}
