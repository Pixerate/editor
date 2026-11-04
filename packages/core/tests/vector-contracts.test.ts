import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFakeEffectProvider } from '../src/effects';
import { ConformanceIds, normalizeConformanceValue } from '../src/tools/conformance';
import { validateJsonSchema, type JsonSchema } from '../src/tools/schema';
import { createVectorCommands, createVectorConformanceHost, getVectorTextShaper, VECTOR_TOOLS, VectorEditorController, vectorContracts } from '../src/vector';

const dir = new URL('../../conformance/domains/vector/', import.meta.url);
const committed = (name: string) => JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as unknown;
const contracts = vectorContracts({ effects: createFakeEffectProvider() });

describe('the vector contracts in @pixerate/conformance', () => {
	it('are the files the code exports, with nothing extra (run node scripts/export-contracts.mjs after a change)', () => {
		expect(readdirSync(dir).filter((f) => f.endsWith('.json')).sort()).toEqual(Object.keys(contracts).sort());
	});

	it.each(Object.keys(contracts))('%s matches the code', (name) => {
		expect(committed(name)).toEqual(JSON.parse(JSON.stringify(contracts[name])));
	});

	it('formats every file the way the export script writes it', () => {
		for (const name of Object.keys(contracts)) expect(readFileSync(new URL(name, dir), 'utf8'), name).toBe(JSON.stringify(committed(name), null, 2) + '\n');
	});

	it('describes a document the editor saves, and refuses one that is not', async () => {
		const host = createVectorConformanceHost({}, { effects: createFakeEffectProvider() });
		await host.callTool('run_command', { id: 'vector.addShape', params: { kind: 'rect', x: 10, y: 10, width: 40, height: 20 } });
		const file = JSON.parse(JSON.stringify(host.document()));
		host.dispose?.();
		const schema = committed('document.schema.json') as JsonSchema;
		expect(file.document.nodes.length).toBe(1);
		expect(validateJsonSchema(file, schema)).toEqual([]);
		expect(validateJsonSchema({ ...file, kind: 'paint' }, schema).length).toBeGreaterThan(0);
		expect(validateJsonSchema({ ...file, document: { ...file.document, nodes: [{ id: 'x', type: 'blob' }] } }, schema).length).toBeGreaterThan(0);
	});

	it('lists every command with its params schema, and run_command offers each one', () => {
		const commands = committed('commands.json') as Array<{ id: string; label: string; params: JsonSchema; undoable: boolean; readOnly: boolean }>;
		expect(commands.map((c) => c.id)).toEqual(createVectorCommands(new VectorEditorController()).map((s) => s.id));
		expect(commands.map((c) => c.id)).toEqual(expect.arrayContaining(['vector.list', 'vector.addShape', 'vector.boolean', 'vector.exportSvg']));
		for (const c of commands) {
			expect(c.label, c.id).toBeTruthy();
			expect(c.params.type, c.id).toBe('object');
		}
		const { providers } = committed('tools.json') as { providers: Array<{ id: string; tools: Array<{ name: string; inputSchema: JsonSchema }> }> };
		const run = providers.find((p) => p.id === 'vector-commands')!.tools.find((t) => t.name === 'run_command')!;
		expect((run.inputSchema.properties!.id as JsonSchema).enum).toEqual(commands.map((c) => c.id));
	});

	it('lists every tool with a strict schema, a title and all four annotations', () => {
		const { providers } = committed('tools.json') as { providers: Array<{ id: string; tools: Array<{ name: string; title: string; description: string; inputSchema: JsonSchema; annotations: object }> }> };
		expect(providers.map((p) => p.id)).toEqual(['vector-commands', 'vector-effects', 'vector-generation']);
		const names = providers.flatMap((p) => p.tools.map((t) => t.name));
		expect(new Set(names).size).toBe(names.length);
		expect(names).toEqual(expect.arrayContaining(['list_commands', 'run_command', 'run_commands', 'apply_effect', 'generate_vector_art']));
		for (const t of providers.flatMap((p) => p.tools)) {
			expect(t.title, t.name).toBeTruthy();
			expect(t.description, t.name).toBeTruthy();
			expect(t.inputSchema.type, t.name).toBe('object');
			expect(Object.keys(t.annotations).sort(), t.name).toEqual(expect.arrayContaining(['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint']));
		}
	});

	it('gives the UI tables React and Svelte render', () => {
		const ui = committed('ui.json') as { tools: { order: string[]; groups: unknown[] }; menus: Record<string, unknown[]>; specs: Record<string, unknown>; labels: Record<string, unknown> };
		expect(ui.tools.order).toEqual([...VECTOR_TOOLS]);
		expect(ui.tools.groups.length).toBeGreaterThan(0);
		for (const [name, menu] of Object.entries(ui.menus)) expect(menu.length, name).toBeGreaterThan(0);
		expect(Object.keys(ui.specs)).toEqual(['effects', 'filters', 'lenses', 'widthPresets']);
	});

	it('has a manifest naming every other file, the format version and the document kind', () => {
		expect(committed('manifest.json')).toMatchObject({ domain: 'vector', formatVersion: 1, document: { kind: 'vector', formatVersion: 1 }, files: Object.keys(contracts).filter((f) => f !== 'manifest.json').sort() });
	});
});

describe('the vector conformance host', () => {
	it('runs commands with counter ids, saves the document and puts the text shaper back', async () => {
		const before = getVectorTextShaper();
		const host = createVectorConformanceHost({ width: 200, height: 100 }, { effects: createFakeEffectProvider() });
		const added = await host.callTool('run_command', { id: 'vector.addShape', params: { kind: 'ellipse', x: 10, y: 10, width: 30, height: 30 } });
		expect(added.isError).toBeFalsy();
		expect(JSON.stringify(added.structuredContent)).toContain('"n1"');
		const doc = host.document() as { kind: string; document: { width: number; height: number; nodes: Array<{ id: string }> } };
		expect(doc.kind).toBe('vector');
		expect(doc.document).toMatchObject({ width: 200, height: 100 });
		expect(doc.document.nodes.map((n) => n.id)).toEqual(['n1']);
		const bad = await host.callTool('run_command', { id: 'vector.nope' });
		expect(bad.isError).toBe(true);
		expect(() => host.pixels({})).toThrow(/no pixels/);
		host.dispose?.();
		expect(getVectorTextShaper()).toBe(before);
	});

	it('generates art with the fake generator the same way every time', async () => {
		const run = async () => {
			const host = createVectorConformanceHost({}, { effects: createFakeEffectProvider() });
			const r = await host.callTool('generate_vector_art', { prompt: 'a red sun', idempotencyKey: 'k1' });
			// The provenance's createdAt is the clock; the scenario runner normalises it the same way.
			const doc = normalizeConformanceValue(host.document(), new ConformanceIds());
			host.dispose?.();
			return { r: r.structuredContent, doc };
		};
		const a = await run();
		expect(a.r).toMatchObject({ model: 'fake-svg' });
		expect(await run()).toEqual(a);
	});
});
