import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import type { ChartController, ChartSpecPatch } from './controller.js';
import { describeOfficeChartPlace, extractOfficeCharts, type OfficeChartsResult, type OfficeFileChart } from './office-files.js';

type ParserCtor = { new (): DOMParser };

/** A file the host has opened and lets the agent read charts from. */
export interface OfficeChartFile {
	name: string;
	data: ArrayBuffer | ArrayBufferView;
}

export interface OfficeChartToolProviderOptions {
	/** Provider id (unique per registry). Default `office-charts`. */
	id?: string;
	/** Always prefix tool names with `<namespace>__`. */
	namespace?: string;
	/**
	 * Files the user opened. With it, the tools take a `file` name (and `list_open_files` lists
	 * them); without it, they take the file's bytes as base64 `data`.
	 */
	files?: () => readonly OfficeChartFile[];
	/** Enables `load_file_chart`, which replaces this chart with one from a file. */
	controller?: ChartController;
	/** The chart cannot be edited: `load_file_chart` is hidden. A string is the reason. */
	readOnly?: boolean | string | (() => boolean | string);
	/** `DOMParser` constructor (default: the global one). */
	DOMParser?: ParserCtor;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const fail = (message: string): never => {
	throw new Error(message);
};

function fromBase64(data: string): Uint8Array {
	const clean = data.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
	let binary: string;
	try {
		binary = atob(clean);
	} catch {
		return fail('"data" is not valid base64. Pass the whole .xlsx, .pptx or .docx file encoded as base64 (a data: URL prefix is fine).');
	}
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/** The fields of a chart an agent needs to pick one, without the full spec. */
function chartSummary(chart: OfficeFileChart) {
	return {
		id: chart.id,
		place: describeOfficeChartPlace(chart),
		...(chart.sheet !== undefined ? { sheet: chart.sheet } : {}),
		...(chart.slide !== undefined ? { slide: chart.slide } : {}),
		...(chart.anchor ? { anchor: chart.anchor } : {}),
		...(chart.range ? { range: chart.range } : {}),
		...(chart.name ? { name: chart.name } : {}),
		path: chart.path,
		partKind: chart.partKind,
		title: chart.title,
		type: chart.spec.type,
		series: chart.spec.series.map((s) => s.name),
		categories: chart.spec.categories.length,
		issues: chart.issues,
		unsupported: chart.unsupported,
		lossless: chart.lossless
	};
}

/**
 * Agent tools for reading charts out of Office files (`.xlsx`, `.pptx`, `.docx`), for a
 * `ToolRegistry`. `list_file_charts` lists every chart with where it sits (sheet and anchor
 * cell, slide number) and its read problems; `get_file_chart` returns one chart's full spec;
 * with a `controller`, `load_file_chart` replaces that chart editor's chart with one of them
 * as one undo step. With `files`, the tools address the files the user opened by name
 * (`list_open_files`); otherwise they take the file as base64.
 */
export function createOfficeChartToolProvider(options: OfficeChartToolProviderOptions = {}): AgentToolProvider {
	const cache = new WeakMap<OfficeChartFile, Promise<OfficeChartsResult>>();
	const readOnlyReason = (): string | null => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (!r) return null;
		return typeof r === 'string' ? r : 'This chart is read-only.';
	};

	const source: Record<string, JsonSchema> = options.files
		? { file: { type: 'string', description: 'Name of an open file, as list_open_files returns it.' } }
		: { data: { type: 'string', description: 'The whole .xlsx, .pptx or .docx file as base64 (a data: URL prefix is allowed).' } };
	const sourceKey = options.files ? 'file' : 'data';

	const read = (args: Record<string, unknown>): Promise<OfficeChartsResult> => {
		if (!options.files) return extractOfficeCharts(fromBase64(String(args.data)), { DOMParser: options.DOMParser });
		const files = options.files();
		const file = files.find((f) => f.name === args.file);
		if (!file) return fail(`There is no open file "${String(args.file)}"; expected one of ${files.map((f) => JSON.stringify(f.name)).join(', ') || '(none; ask the user to open an .xlsx, .pptx or .docx file)'}.`);
		let result = cache.get(file);
		if (!result) {
			result = extractOfficeCharts(file.data, { DOMParser: options.DOMParser });
			cache.set(file, result);
			result.catch(() => cache.delete(file));
		}
		return result;
	};
	const chartById = async (args: Record<string, unknown>) => {
		const { charts } = await read(args);
		const chart = charts.find((c) => c.id === args.chartId);
		if (!chart) fail(`There is no chart "${String(args.chartId)}" in this file; expected one of ${charts.map((c) => `"${c.id}" (${describeOfficeChartPlace(c)})`).join(', ') || '(none: the file has no charts)'}.`);
		return chart!;
	};
	const CHART_ID: JsonSchema = { type: 'string', description: 'Chart id from list_file_charts, e.g. "chart-1".' };

	const listOpenFiles: AgentTool = {
		name: 'list_open_files',
		title: 'List open files',
		description: 'Lists the Office files the user opened that charts can be read from. Returns their names and sizes in bytes.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'List open files', ...READ },
		handler: () => ({ files: (options.files?.() ?? []).map((f) => ({ name: f.name, bytes: f.data.byteLength })) })
	};

	const listCharts: AgentTool = {
		name: 'list_file_charts',
		title: 'List the charts in an Office file',
		description:
			'Reads an Excel workbook, PowerPoint deck or Word document and lists its charts in file order: id, where it sits (sheet name and anchor cell, or slide number), title, type, series names, number of categories, read problems, features the chart editor cannot hold, and whether it reads losslessly. Pass an id to get_file_chart or load_file_chart.',
		inputSchema: { type: 'object', properties: { ...source }, required: [sourceKey], additionalProperties: false },
		annotations: { title: 'List the charts in an Office file', ...READ },
		handler: async (args) => {
			const result = await read(args);
			return { format: result.format, charts: result.charts.map(chartSummary) };
		}
	};

	const getChart: AgentTool = {
		name: 'get_file_chart',
		title: 'Get a chart from an Office file',
		description: 'Returns one chart of an Office file with its full chart spec (data, axes, series styles), where it sits and its read problems.',
		inputSchema: { type: 'object', properties: { ...source, chartId: CHART_ID }, required: [sourceKey, 'chartId'], additionalProperties: false },
		annotations: { title: 'Get a chart from an Office file', ...READ },
		handler: async (args) => {
			const chart = await chartById(args);
			return { ...chartSummary(chart), spec: chart.spec };
		}
	};

	const loadChart: AgentTool = {
		name: 'load_file_chart',
		title: 'Load a chart from an Office file',
		description: 'Replaces the chart in the editor with a chart from an Office file, as one undo step. Returns the new spec, read problems and features the editor could not keep.',
		inputSchema: { type: 'object', properties: { ...source, chartId: CHART_ID }, required: [sourceKey, 'chartId'], additionalProperties: false },
		annotations: { title: 'Load a chart from an Office file', ...DESTRUCTIVE },
		handler: async (args) => {
			const reason = readOnlyReason();
			if (reason) fail(reason);
			const chart = await chartById(args);
			const result = options.controller!.update({ ...chart.spec } as ChartSpecPatch, { label: 'Load chart from file' });
			if (!result.ok) fail(result.message ?? 'The chart could not be loaded.');
			return { id: chart.id, place: describeOfficeChartPlace(chart), spec: options.controller!.toJSON(), issues: chart.issues, unsupported: chart.unsupported, lossless: chart.lossless };
		}
	};

	return {
		id: options.id ?? 'office-charts',
		...(options.namespace ? { namespace: options.namespace } : {}),
		tools: () => [...(options.files ? [listOpenFiles] : []), listCharts, getChart, ...(options.controller && !readOnlyReason() ? [loadChart] : [])]
	};
}
