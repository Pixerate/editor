import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	CHART_COLOR_SCHEMES,
	CHART_CONTRACT_FORMAT_VERSION,
	CHART_DATE_STEPS,
	CHART_ERROR_BAR_DIRECTIONS,
	CHART_ERROR_BAR_LABELS,
	CHART_ERROR_BAR_TYPES,
	CHART_LAYOUT_PRESETS,
	CHART_PALETTE_SHADES,
	CHART_TYPES,
	ChartController,
	chartContracts,
	conformanceChartTextMeasure,
	createChartCommands,
	createChartConformanceHost
} from '../src/chart';
import { runConformanceScenario, type ConformanceScenario } from '../src/tools/conformance';
import { validateJsonSchema, type JsonSchema } from '../src/tools/schema';

const dir = new URL('../../conformance/domains/chart/', import.meta.url);
const committed = (name: string) => JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as unknown;
const contracts = chartContracts();

describe('the chart contracts in @pixerate/conformance', () => {
	it('are the files the code exports, with nothing extra (run node scripts/export-contracts.mjs after a change)', () => {
		expect(readdirSync(dir).filter((f) => f.endsWith('.json')).sort()).toEqual(Object.keys(contracts).sort());
	});

	it.each(Object.keys(contracts))('%s matches the code', (name) => {
		expect(committed(name)).toEqual(JSON.parse(JSON.stringify(contracts[name])));
	});

	it('formats every file the way the export script writes it', () => {
		for (const name of Object.keys(contracts)) {
			expect(readFileSync(new URL(name, dir), 'utf8'), name).toBe(JSON.stringify(committed(name), null, 2) + '\n');
		}
	});

	it('describes a document the editor saves, and refuses one that is not', async () => {
		const host = createChartConformanceHost();
		await host.callTool('set_chart_data', {
			categories: ['Q1', 'Q2', 'Q3'],
			series: [{ name: 'Revenue', values: [120, 180, 240] }]
		});
		const file = JSON.parse(JSON.stringify(host.document()));
		host.dispose?.();
		const schema = committed('document.schema.json') as JsonSchema;
		expect(file.document.series.length).toBe(1);
		expect(validateJsonSchema(file, schema)).toEqual([]);
		expect(validateJsonSchema({ ...file, kind: 'vector' }, schema).length).toBeGreaterThan(0);
		expect(validateJsonSchema({ ...file, document: { ...file.document, type: 'not-a-chart' } }, schema).length).toBeGreaterThan(0);
	});

	it('lists every command with its params schema and undoable/readOnly flags', () => {
		const commands = committed('commands.json') as Array<{
			id: string;
			label: string;
			params?: JsonSchema;
			undoable: boolean;
			readOnly: boolean;
		}>;
		const specs = createChartCommands(new ChartController());
		expect(commands.map((c) => c.id)).toEqual(specs.map((s) => s.id));
		expect(commands.map((c) => c.id)).toEqual(expect.arrayContaining(['chart.describe', 'chart.update', 'chart.exportSvg', 'chart.undo', 'chart.redo']));
		for (const [i, c] of commands.entries()) {
			expect(c.label, c.id).toBeTruthy();
			if (c.params) expect(c.params.type, c.id).toBe('object');
			expect(c.params, c.id).toEqual(specs[i].params);
			expect(c.undoable, c.id).toBe(!!specs[i].undoable);
			expect(c.readOnly, c.id).toBe(!!specs[i].readOnly);
		}
	});

	it('lists every tool with a strict schema, a title, a description and all four annotations', () => {
		const { providers } = committed('tools.json') as {
			providers: Array<{
				id: string;
				tools: Array<{
					name: string;
					title: string;
					description: string;
					inputSchema: JsonSchema;
					annotations: Record<string, unknown>;
				}>;
			}>;
		};
		expect(providers.map((p) => p.id)).toEqual(['chart', 'chart-style', 'office-charts']);
		const names = providers.flatMap((p) => p.tools.map((t) => t.name));
		expect(new Set(names).size).toBe(names.length);
		expect(names).toEqual(
			expect.arrayContaining([
				'get_chart',
				'update_chart',
				'set_chart_data',
				'import_chart_ooxml',
				'play_chart_race',
				'render_chart',
				'check_chart_style',
				'list_open_files',
				'list_file_charts',
				'get_file_chart',
				'load_file_chart'
			])
		);
		for (const t of providers.flatMap((p) => p.tools)) {
			expect(t.title, t.name).toBeTruthy();
			expect(t.description, t.name).toBeTruthy();
			expect(t.inputSchema.type, t.name).toBe('object');
			expect(t.inputSchema.additionalProperties, t.name).toBe(false);
			expect(Object.keys(t.annotations).sort(), t.name).toEqual(
				expect.arrayContaining(['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'])
			);
		}
	});

	it('gives the UI tables the inspector reads', () => {
		const ui = committed('ui.json') as {
			layoutPresets: unknown[];
			colorSchemes: unknown[];
			errorBars: { types: string[]; directions: string[]; labels: Record<string, string> };
			paletteShades: number[];
			dateSteps: unknown[];
			types: string[];
			textMeasure: { normalEm: number; boldEm: number; boldWeight: number; formula: string };
		};
		expect(ui.layoutPresets).toEqual(JSON.parse(JSON.stringify(CHART_LAYOUT_PRESETS)));
		expect(ui.colorSchemes).toEqual(JSON.parse(JSON.stringify(CHART_COLOR_SCHEMES)));
		expect(ui.errorBars).toEqual({
			types: [...CHART_ERROR_BAR_TYPES],
			directions: [...CHART_ERROR_BAR_DIRECTIONS],
			labels: { ...CHART_ERROR_BAR_LABELS }
		});
		expect(ui.paletteShades).toEqual([...CHART_PALETTE_SHADES]);
		expect(ui.dateSteps).toEqual(JSON.parse(JSON.stringify(CHART_DATE_STEPS)));
		expect(ui.types).toEqual([...CHART_TYPES]);
		expect(ui.textMeasure).toMatchObject({ normalEm: 0.56, boldEm: 0.6, boldWeight: 600 });
	});

	it('has a manifest naming every other file, the format version and the document kind', () => {
		expect(committed('manifest.json')).toMatchObject({
			domain: 'chart',
			formatVersion: CHART_CONTRACT_FORMAT_VERSION,
			document: { kind: 'chart', formatVersion: 1 },
			files: Object.keys(contracts).filter((f) => f !== 'manifest.json').sort()
		});
	});
});

describe('the chart conformance host', () => {
	it('plays a bar race deterministically across runs with its manual raceTicker', async () => {
		const scenario: ConformanceScenario = {
			id: 'race-determinism',
			description: 'Bar race playback is deterministic.',
			setup: {
				spec: {
					type: 'barrace',
					categories: ['2021', '2022', '2023', '2024'],
					series: [
						{ id: 'series-1', name: 'Alpha', values: [10, 25, 40, 55] },
						{ id: 'series-2', name: 'Beta', values: [20, 15, 35, 60] }
					]
				}
			},
			steps: [
				{ tool: 'set_chart_race_frame', arguments: { time: 1 }, render: true },
				{ tool: 'play_chart_race', arguments: { msPerStep: 500 }, document: true, render: true }
			]
		};

		const firstHost = createChartConformanceHost(scenario.setup ?? {});
		const secondHost = createChartConformanceHost(scenario.setup ?? {});
		const first = await runConformanceScenario(scenario, firstHost);
		const second = await runConformanceScenario(scenario, secondHost);
		expect(first).toEqual(second);

		// Also verify manual ticker stepping via advanceRace produces identical intermediate frames and scenes.
		const runStepped = async () => {
			const host = createChartConformanceHost(scenario.setup ?? {});
			const started = await host.callTool('play_chart_race', { msPerStep: 400 });
			host.advanceRace(200);
			const midFrame = host.controller.getState().raceFrame;
			const midScene = host.render();
			host.advanceRace(1000);
			const endState = {
				raceFrame: host.controller.getState().raceFrame,
				racePlaying: host.controller.getState().racePlaying
			};
			host.dispose?.();
			return { started: started.structuredContent, midFrame, midScene, endState };
		};

		const runA = await runStepped();
		const runB = await runStepped();
		expect(runA.midFrame).toBe(0.5);
		expect(runA.endState).toEqual({ raceFrame: null, racePlaying: false });
		expect(runA).toEqual(runB);
	});

	it('uses the fixed measureText, counter series ids, in-memory files, and deterministic PNG error', async () => {
		expect(conformanceChartTextMeasure('Chart', 10, 400)).toBeCloseTo(5 * 10 * 0.56, 8);
		expect(conformanceChartTextMeasure('Chart', 10, 600)).toBeCloseTo(5 * 10 * 0.6, 8);

		const host = createChartConformanceHost({
			files: {
				'empty.xlsx': new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)])
			}
		});
		const added = await host.callTool('add_chart_series', { name: 'Revenue', values: [10, 20] });
		expect(added.isError).toBeFalsy();
		expect(added.structuredContent).toMatchObject({ id: 'series-1' });

		const listed = await host.callTool('list_open_files', {});
		expect(listed.isError).toBeFalsy();
		expect(listed.structuredContent).toMatchObject({ files: [{ name: 'empty.xlsx' }] });

		const exported = await host.callTool('export_chart_ooxml', {});
		expect(exported.isError).toBeFalsy();
		const xml = (exported.structuredContent as { xml: string }).xml;
		const imported = await host.callTool('import_chart_ooxml', { xml });
		expect(imported.isError).toBeFalsy();

		const png = await host.callTool('render_chart', { format: 'png' });
		expect(png.isError).toBe(true);
		expect(JSON.stringify(png)).toContain('This host cannot rasterize charts');

		expect(() => host.pixels({})).toThrow(/no pixels/);
		host.dispose?.();
	});
});
