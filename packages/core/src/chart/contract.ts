/**
 * The chart editor as language-neutral contracts (`@pixerate/conformance` `domains/chart`), so
 * another implementation (the Swift port, #694) offers the same commands, tools, controls and
 * documents: the commands in `createChartCommands`, the tools of the chart, chart-style and
 * office-charts providers, the UI tables React and Svelte render, and a JSON Schema of a saved
 * chart document. `scripts/export-contracts.mjs` writes them; `tests/chart-contract.test.ts` fails
 * when the committed files differ from what this returns.
 *
 * Everything here is data from this module's own tables and providers; nothing depends on the
 * package version, so a release does not change the files.
 */

import { createCommandToolProvider, CommandRegistry } from '../commands/index.js';
import { HistoryManager } from '../history/HistoryManager.js';
import { EDITOR_DOCUMENT_FORMAT, toEditorDocumentFile } from '../persistence/index.js';
import type { ConformanceHost } from '../tools/conformance.js';
import { ToolRegistry, type AgentToolProvider, type McpToolDefinition, type McpToolResult } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import { createStyleResolver, memoryStyleStore } from '../tools/style.js';
import { EUROPE_CHART_MAP } from '../chart-maps/index.js';
import { CHART_PALETTE_SHADES } from './color.js';
import { createChartCommands } from './commands.js';
import { ChartController, type ChartRaceTicker } from './controller.js';
import { CHART_DATE_STEPS } from './date.js';
import { createChartEditorDocument } from './editorDocument.js';
import { CHART_ERROR_BAR_DIRECTIONS, CHART_ERROR_BAR_LABELS, CHART_ERROR_BAR_TYPES } from './errorbars.js';
import { createOfficeChartToolProvider, type OfficeChartFile } from './file-tools.js';
import { estimateChartTextWidth, layoutChart, type ChartTextMeasure } from './layout.js';
import { registerChartMap, type ChartMapGeometry } from './maps.js';
import { CHART_COLOR_SCHEMES, CHART_LAYOUT_PRESETS } from './presets.js';
import { CHART_UPDATE_PROPERTIES, LINK_PROPS, SERIES_PROPS, TREE_DEFS, TRENDLINE_PROPS } from './schemas.js';
import {
	CHART_AXIS_KINDS,
	CHART_AXIS_SCALES,
	CHART_CURVES,
	CHART_LABEL_POSITIONS,
	CHART_LEGEND_POSITIONS,
	CHART_LIKERT_NEUTRALS,
	CHART_LIKERT_SORTS,
	CHART_MARKERS,
	CHART_NUMBER_STYLES,
	CHART_ORIENTATIONS,
	CHART_RADAR_GRATICULES,
	CHART_REFERENCE_AXES,
	CHART_SANKEY_LINK_COLORS,
	CHART_SERIES_TYPES,
	CHART_STACKINGS,
	CHART_TRENDLINE_TYPES,
	CHART_TYPE_LABELS,
	CHART_TYPES,
	DEFAULT_CHART_PALETTE,
	DEFAULT_CHART_THEME
} from './spec.js';
import { chartStyleDomain, createChartStyleToolProvider, type ChartStyleProfile } from './style.js';
import { createChartToolProvider } from './tools.js';
import type { ChartScene, ChartSpec } from './types.js';

/** Bumped when a contract file changes shape (not when its data changes). */
export const CHART_CONTRACT_FORMAT_VERSION = 1;

/**
 * Fixed text-width measure used by the conformance host (both the controller and the tools) and
 * required of the Swift port so layout coordinates, tick thinning and label truncation match:
 * `text.length * fontSize * (weight >= 600 ? 0.6 : 0.56)` (UTF-16 code units, matching
 * `estimateChartTextWidth`).
 */
export const conformanceChartTextMeasure: ChartTextMeasure = estimateChartTextWidth;

const NULLABLE_NUMBER_ARRAY: JsonSchema = {
	type: 'array',
	items: { type: ['number', 'null'] }
};

const CHART_TRENDLINE_JSON_SCHEMA: JsonSchema = {
	type: 'object',
	properties: TRENDLINE_PROPS,
	required: ['type'],
	additionalProperties: false
};

const CHART_LINK_JSON_SCHEMA: JsonSchema = {
	type: 'object',
	properties: LINK_PROPS,
	required: ['source', 'target', 'value'],
	additionalProperties: false
};

const CHART_SERIES_JSON_SCHEMA: JsonSchema = {
	type: 'object',
	required: ['id', 'name', 'values'],
	additionalProperties: false,
	properties: {
		id: { type: 'string', minLength: 1, description: 'Unique series id (`series-1`, `series-2`, …).' },
		...SERIES_PROPS,
		values: { ...NULLABLE_NUMBER_ARRAY, description: SERIES_PROPS.values.description },
		x: { ...NULLABLE_NUMBER_ARRAY, description: SERIES_PROPS.x.description },
		sizes: { ...NULLABLE_NUMBER_ARRAY, description: SERIES_PROPS.sizes.description },
		trendlines: {
			type: 'array',
			items: CHART_TRENDLINE_JSON_SCHEMA,
			description: 'Fitted trendlines drawn over the series.'
		}
	}
};

const CHART_SPEC_PROPERTIES: Record<string, JsonSchema> = {
	version: { type: 'integer', const: 1, description: 'Always 1.' },
	...CHART_UPDATE_PROPERTIES,
	categories: {
		type: 'array',
		items: { type: 'string' },
		description: 'Category labels along the x axis (or slice / time-point labels).'
	},
	series: {
		type: 'array',
		items: CHART_SERIES_JSON_SCHEMA,
		description: 'Data series.'
	},
	tree: {
		type: 'array',
		items: { $ref: '#/$defs/chartTreeNode' },
		description: 'Hierarchical nodes for treemap and sunburst charts.'
	},
	links: {
		type: 'array',
		items: CHART_LINK_JSON_SCHEMA,
		description: 'Directed weighted links for sankey charts.'
	}
};

/**
 * JSON Schema of a saved chart document: the `pixerate.editor-document` envelope of kind `chart`
 * around a `ChartSpec` (`createChartEditorDocument`), built from `chart/schemas.ts`.
 */
export const CHART_DOCUMENT_JSON_SCHEMA: JsonSchema = {
	type: 'object',
	description: "A saved chart document, as the chart editor's save tools and autosave write it.",
	$defs: TREE_DEFS,
	properties: {
		format: { type: 'string', const: EDITOR_DOCUMENT_FORMAT, description: `Always "${EDITOR_DOCUMENT_FORMAT}".` },
		kind: { type: 'string', const: 'chart', description: 'Always "chart".' },
		formatVersion: { type: 'integer', minimum: 1, description: 'Version of the envelope for this kind; readers migrate older ones.' },
		name: { type: 'string', description: 'Display name, when it has one.' },
		document: {
			type: 'object',
			description: 'The chart (`ChartSpec`, as get_chart returns it in `spec`).',
			properties: CHART_SPEC_PROPERTIES,
			required: Object.keys(CHART_SPEC_PROPERTIES),
			additionalProperties: false
		}
	},
	required: ['format', 'kind', 'formatVersion', 'document'],
	additionalProperties: false
};

export interface ChartCommandContractEntry {
	id: string;
	label: string;
	group?: string;
	keywords?: string[];
	description?: string;
	params?: JsonSchema;
	shortcut?: string | string[];
	scope?: string;
	undoable: boolean;
	readOnly: boolean;
	hidden?: boolean;
}

export interface ChartToolProviderContract {
	id: string;
	title?: string;
	skill?: string;
	tools: McpToolDefinition[];
}

// ---------------------------------------------------------------------------
// Minimal XML DOMParser fallback for Node hosts without globalThis.DOMParser
// ---------------------------------------------------------------------------

const XML_ENTITIES: Record<string, string> = {
	lt: '<',
	gt: '>',
	amp: '&',
	quot: '"',
	apos: "'"
};

function decodeXmlEntities(raw: string): string {
	return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, code: string) => {
		if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(parseInt(code.slice(2), 16));
		if (code.startsWith('#')) return String.fromCodePoint(parseInt(code.slice(1), 10));
		return XML_ENTITIES[code] ?? match;
	});
}

interface MiniXmlAttr {
	name: string;
	localName: string;
	prefix: string | null;
	namespaceURI: string | null;
	value: string;
}

class MiniXmlElement {
	readonly nodeType = 1;
	readonly tagName: string;
	readonly localName: string;
	readonly prefix: string | null;
	readonly namespaceURI: string | null;
	parentElement: MiniXmlElement | null = null;
	readonly childNodes: Array<MiniXmlElement | { nodeType: 3; textContent: string }> = [];
	readonly attributes: MiniXmlAttr[] = [];

	constructor(tagName: string, localName: string, prefix: string | null, namespaceURI: string | null) {
		this.tagName = tagName;
		this.localName = localName;
		this.prefix = prefix;
		this.namespaceURI = namespaceURI;
	}

	get children(): MiniXmlElement[] {
		return this.childNodes.filter((n): n is MiniXmlElement => n.nodeType === 1);
	}

	get textContent(): string {
		return this.childNodes.map((n) => n.textContent).join('');
	}

	getAttribute(name: string): string | null {
		const found = this.attributes.find((a) => a.name === name);
		return found ? found.value : null;
	}

	getElementsByTagName(name: string): MiniXmlElement[] {
		const out: MiniXmlElement[] = [];
		const visit = (el: MiniXmlElement) => {
			for (const child of el.children) {
				if (name === '*' || child.tagName === name || child.localName === name) out.push(child);
				visit(child);
			}
		};
		visit(this);
		return out;
	}

	getElementsByTagNameNS(ns: string, localName: string): MiniXmlElement[] {
		const out: MiniXmlElement[] = [];
		const visit = (el: MiniXmlElement) => {
			for (const child of el.children) {
				const nsMatch = ns === '*' || child.namespaceURI === ns;
				const nameMatch = localName === '*' || child.localName === localName;
				if (nsMatch && nameMatch) out.push(child);
				visit(child);
			}
		};
		visit(this);
		return out;
	}
}

class FallbackXmlDomParser {
	parseFromString(xml: string, _type?: string): Document {
		const stripped = xml
			.replace(/^\uFEFF/, '')
			.replace(/<\?[\s\S]*?\?>/g, '')
			.replace(/<!--[\s\S]*?-->/g, '')
			.replace(/<!DOCTYPE[^>]*>/gi, '')
			.trim();
		const tokenRe = /<!\[CDATA\[([\s\S]*?)\]\]>|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
		const stack: Array<{ el: MiniXmlElement; ns: Map<string, string> }> = [];
		let root: MiniXmlElement | null = null;
		let hasError = false;
		let lastIndex = 0;

		for (let m = tokenRe.exec(stripped); m !== null; m = tokenRe.exec(stripped)) {
			if (m.index !== lastIndex) {
				hasError = true;
				break;
			}
			lastIndex = tokenRe.lastIndex;
			const [, cdata, closeName, openName, attrText, selfClose, text] = m;
			if (cdata !== undefined) {
				const top = stack[stack.length - 1];
				if (top) top.el.childNodes.push({ nodeType: 3, textContent: cdata });
			} else if (closeName !== undefined) {
				const popped = stack.pop();
				if (!popped || popped.el.tagName !== closeName) {
					hasError = true;
					break;
				}
			} else if (openName !== undefined) {
				const parent = stack[stack.length - 1];
				const ns = new Map<string, string>(parent ? parent.ns : [['xml', 'http://www.w3.org/XML/1998/namespace']]);
				const rawAttrs: Array<[string, string]> = [];
				const attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
				for (let am = attrRe.exec(attrText ?? ''); am !== null; am = attrRe.exec(attrText ?? '')) {
					const name = am[1]!;
					const val = decodeXmlEntities(am[2] ?? am[3] ?? '');
					rawAttrs.push([name, val]);
					if (name === 'xmlns') ns.set('', val);
					else if (name.startsWith('xmlns:')) ns.set(name.slice(6), val);
				}
				const colon = openName.indexOf(':');
				const prefix = colon >= 0 ? openName.slice(0, colon) : null;
				const localName = colon >= 0 ? openName.slice(colon + 1) : openName;
				const namespaceURI = prefix ? (ns.get(prefix) ?? null) : (ns.get('') ?? null);
				const el = new MiniXmlElement(openName, localName, prefix, namespaceURI);
				for (const [name, value] of rawAttrs) {
					const ac = name.indexOf(':');
					const ap = ac >= 0 ? name.slice(0, ac) : null;
					const al = ac >= 0 ? name.slice(ac + 1) : name;
					const ans = name === 'xmlns' || ap === 'xmlns' ? 'http://www.w3.org/2000/xmlns/' : ap ? (ns.get(ap) ?? null) : null;
					el.attributes.push({ name, localName: al, prefix: ap, namespaceURI: ans, value });
				}
				if (parent) {
					el.parentElement = parent.el;
					parent.el.childNodes.push(el);
				} else if (!root) {
					root = el;
				} else {
					hasError = true;
					break;
				}
				if (!selfClose) stack.push({ el, ns });
			} else if (text !== undefined) {
				const top = stack[stack.length - 1];
				if (top) top.el.childNodes.push({ nodeType: 3, textContent: decodeXmlEntities(text) });
				else if (text.trim() !== '') {
					hasError = true;
					break;
				}
			}
		}

		if (lastIndex !== stripped.length || !root || stack.length > 0) hasError = true;
		const errorEl = new MiniXmlElement('parsererror', 'parsererror', null, null);
		const doc = {
			documentElement: root,
			getElementsByTagName(name: string) {
				if (name === 'parsererror') return hasError ? [errorEl] : [];
				if (!root) return [];
				const own = name === '*' || root.tagName === name || root.localName === name ? [root] : [];
				return [...own, ...root.getElementsByTagName(name)];
			},
			getElementsByTagNameNS(ns: string, localName: string) {
				if (!root) return [];
				const nsMatch = ns === '*' || root.namespaceURI === ns;
				const nameMatch = localName === '*' || root.localName === localName;
				const own = nsMatch && nameMatch ? [root] : [];
				return [...own, ...root.getElementsByTagNameNS(ns, localName)];
			}
		};
		return doc as unknown as Document;
	}
}

/**
 * The small XML parser the chart contracts and conformance host use where the host has no
 * `DOMParser` (Node). The Swift chart port mirrors it, so test vectors read OOXML with it.
 */
export const chartFallbackDomParser = FallbackXmlDomParser as unknown as { new (): DOMParser };

function defaultDomParser(): { new (): DOMParser } {
	return (globalThis as { DOMParser?: { new (): DOMParser } }).DOMParser ?? (FallbackXmlDomParser as unknown as { new (): DOMParser });
}

/** A provider's tools as an MCP tool list (name, title, description, inputSchema, annotations). */
function toolList(provider: AgentToolProvider): ChartToolProviderContract {
	const tools = typeof provider.tools === 'function' ? provider.tools() : provider.tools;
	return {
		id: provider.id,
		title: provider.title,
		...(provider.skill ? { skill: provider.skill } : {}),
		tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }))
	};
}

/** The UI tables the chart inspector and layout read, as plain data. */
function uiTables() {
	return {
		layoutPresets: CHART_LAYOUT_PRESETS,
		colorSchemes: CHART_COLOR_SCHEMES,
		errorBars: {
			types: CHART_ERROR_BAR_TYPES,
			directions: CHART_ERROR_BAR_DIRECTIONS,
			labels: CHART_ERROR_BAR_LABELS
		},
		paletteShades: CHART_PALETTE_SHADES,
		dateSteps: CHART_DATE_STEPS,
		types: CHART_TYPES,
		typeLabels: CHART_TYPE_LABELS,
		seriesTypes: CHART_SERIES_TYPES,
		stackings: CHART_STACKINGS,
		orientations: CHART_ORIENTATIONS,
		curves: CHART_CURVES,
		markers: CHART_MARKERS,
		labelPositions: CHART_LABEL_POSITIONS,
		legendPositions: CHART_LEGEND_POSITIONS,
		numberStyles: CHART_NUMBER_STYLES,
		trendlineTypes: CHART_TRENDLINE_TYPES,
		axisKinds: CHART_AXIS_KINDS,
		axisScales: CHART_AXIS_SCALES,
		radarGraticules: CHART_RADAR_GRATICULES,
		likertNeutrals: CHART_LIKERT_NEUTRALS,
		likertSorts: CHART_LIKERT_SORTS,
		sankeyLinkColors: CHART_SANKEY_LINK_COLORS,
		referenceAxes: CHART_REFERENCE_AXES,
		defaultPalette: DEFAULT_CHART_PALETTE,
		defaultTheme: DEFAULT_CHART_THEME,
		textMeasure: {
			normalEm: 0.56,
			boldEm: 0.6,
			boldWeight: 600,
			formula: 'text.length * size * (weight >= 600 ? 0.6 : 0.56)'
		}
	};
}

/**
 * Every chart contract file, by its path under `domains/chart/` (plain JSON values).
 */
export function chartContracts(): Record<string, unknown> {
	const controller = new ChartController({ measureText: conformanceChartTextMeasure });
	const specs = createChartCommands(controller);
	const styles = createStyleResolver({
		layers: [{ id: 'org', store: memoryStyleStore() }],
		domains: [chartStyleDomain]
	});
	const DOMParser = defaultDomParser();
	const providers = [
		createChartToolProvider(controller, { namespace: '', DOMParser, measureText: conformanceChartTextMeasure }),
		createChartStyleToolProvider(controller, styles, { namespace: '' }),
		createOfficeChartToolProvider({ namespace: '', files: () => [], controller, DOMParser })
	].map(toolList);
	const document = createChartEditorDocument(controller);
	const files: Record<string, unknown> = {
		'document.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'document.schema.json', ...CHART_DOCUMENT_JSON_SCHEMA },
		'tools.json': { providers },
		'commands.json': specs.map((s) => ({
			id: s.id,
			label: s.label,
			...(s.group ? { group: s.group } : {}),
			...(s.keywords?.length ? { keywords: s.keywords } : {}),
			...(s.description ? { description: s.description } : {}),
			...(s.params ? { params: s.params } : {}),
			...(s.shortcut !== undefined ? { shortcut: s.shortcut } : {}),
			...(s.scope ? { scope: s.scope } : {}),
			undoable: !!s.undoable,
			readOnly: !!s.readOnly,
			...(s.hidden ? { hidden: true } : {})
		})),
		'ui.json': uiTables()
	};
	files['manifest.json'] = {
		domain: 'chart',
		formatVersion: CHART_CONTRACT_FORMAT_VERSION,
		document: { kind: document.kind, formatVersion: document.formatVersion },
		counts: { providers: providers.length, tools: providers.reduce((n, p) => n + p.tools.length, 0), commands: specs.length },
		files: Object.keys(files).sort()
	};
	document.destroy?.();
	controller.destroy();
	return files;
}

export interface ChartConformanceSetup {
	/** Initial chart spec (or partial spec) loaded into the controller. */
	spec?: Partial<ChartSpec> | Record<string, unknown>;
	/** Width used by `render()` and default tool calls (default 640). */
	width?: number;
	/** Height used by `render()` and default tool calls (default 400). */
	height?: number;
	/** Read-only state or reason for the chart tool providers. */
	readOnly?: boolean | string;
	/**
	 * Open Office files for `createOfficeChartToolProvider`, either as an array of
	 * `{ name, data }` (base64 bytes or `Uint8Array`) or a `{ [name]: base64 }` map.
	 */
	files?: ReadonlyArray<{ name: string; data: string | Uint8Array }> | Record<string, string | Uint8Array>;
	/** Optional house-style profile for `check_chart_style`. */
	style?: ChartStyleProfile & { checks?: ReadonlyArray<string | Record<string, unknown>> };
	/** Extra map geometries to register alongside `EUROPE_CHART_MAP`. */
	maps?: ReadonlyArray<ChartMapGeometry>;
}

export interface ChartConformanceHost extends ConformanceHost {
	readonly controller: ChartController;
	/** Advances the manual bar-race clock by `ms` and runs any queued animation frame steps. */
	advanceRace(ms?: number): void;
}

function decodeBase64Bytes(data: string | Uint8Array): Uint8Array {
	if (data instanceof Uint8Array) return data;
	const clean = String(data).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
	const binary = atob(clean);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

function parseSetupFiles(raw: ChartConformanceSetup['files']): OfficeChartFile[] {
	if (!raw) return [];
	if (Array.isArray(raw)) {
		return raw.map((entry) => ({ name: entry.name, data: decodeBase64Bytes(entry.data) }));
	}
	return Object.entries(raw as Record<string, string | Uint8Array>).map(([name, data]) => ({
		name,
		data: decodeBase64Bytes(data)
	}));
}

/**
 * A fresh chart editor for replaying a conformance scenario (`domains/chart/fixtures`):
 * - A manual `raceTicker`: `now()` returns a counter the host advances via `advanceRace`, and
 *   `next()` queues the step instead of using timers, so `play_chart_race` records the same result
 *   on every run.
 * - Fixed `measureText` (`conformanceChartTextMeasure`) in both the controller and the tools.
 * - Series ids come from `uniqueChartSeriesId`'s counter (`series-1`, `series-2`, …).
 * - In-memory `files` decoded from `setup.files` (base64 bytes) for the Office chart tools.
 * - `render()` returns the `ChartScene` from `layoutChart` for the current state.
 * - No `rasterize` option, so `render_chart` with `format: "png"` returns its documented error.
 */
export function createChartConformanceHost(setup: ChartConformanceSetup & Record<string, unknown> = {}): ChartConformanceHost {
	registerChartMap(EUROPE_CHART_MAP);
	if (Array.isArray(setup.maps)) {
		for (const map of setup.maps) registerChartMap(map);
	}

	let raceClock = 0;
	let raceQueue: Array<() => void> = [];
	const raceTicker: ChartRaceTicker = {
		now: () => raceClock,
		next: (step) => {
			raceQueue.push(step);
			return () => {
				raceQueue = raceQueue.filter((q) => q !== step);
			};
		}
	};
	const advanceRace = (ms = 16) => {
		raceClock += ms;
		const pending = raceQueue;
		raceQueue = [];
		for (const step of pending) step();
	};

	const width = typeof setup.width === 'number' ? setup.width : 640;
	const height = typeof setup.height === 'number' ? setup.height : 400;
	const history = new HistoryManager();
	const controller = new ChartController({
		spec: setup.spec,
		history,
		raceTicker,
		measureText: conformanceChartTextMeasure
	});

	const openFiles = parseSetupFiles(setup.files);
	const styleFiles: Record<string, string> = setup.style
		? {
				'house/SKILL.md': '---\nname: house\ndescription: House chart style.\n---\nFollow the house chart style.',
				'house/chart.json': JSON.stringify(setup.style)
			}
		: {};
	const styles = createStyleResolver({
		layers: [{ id: 'org', store: memoryStyleStore(styleFiles) }],
		domains: [chartStyleDomain]
	});

	const commands = new CommandRegistry({ context: controller, history });
	commands.register(createChartCommands(controller));

	const DOMParser = defaultDomParser();
	const registry = new ToolRegistry({ validateArguments: true });
	registry.register(
		createChartToolProvider(controller, {
			namespace: '',
			size: { width, height },
			readOnly: setup.readOnly,
			DOMParser,
			measureText: conformanceChartTextMeasure
		})
	);
	registry.register(createChartStyleToolProvider(controller, styles, { namespace: '', readOnly: setup.readOnly }));
	registry.register(
		createOfficeChartToolProvider({
			namespace: '',
			files: () => openFiles,
			controller,
			readOnly: setup.readOnly,
			DOMParser
		})
	);
	registry.register(createCommandToolProvider(commands, { id: 'chart-commands', namespace: '' }));

	const document = createChartEditorDocument(controller);
	return {
		controller,
		advanceRace,
		callTool: (name, args): Promise<McpToolResult> => registry.callTool(name, args),
		document: () => toEditorDocumentFile(document),
		pixels: () => {
			throw new Error('The chart conformance host has no pixels; compare its document, results, render data and SVG export.');
		},
		render: (): ChartScene => {
			const state = controller.getState();
			return layoutChart(controller.toJSON(), {
				width,
				height,
				selection: state.selection,
				raceFrame: state.raceFrame,
				measureText: conformanceChartTextMeasure
			});
		},
		dispose: () => {
			document.destroy?.();
			controller.destroy();
		}
	};
}
