import { describe, it, expect, vi } from 'vitest';
import {
	createGenerationHistoryToolProvider,
	createGenerationRecord,
	createGenerationRecordStore,
	createGenerationToolProvider,
	type GenerationRecord,
	type ModelCapabilities
} from '../src/generation';
import { createMemoryStorage } from '../src/persistence';
import { ToolRegistry } from '../src/tools/registry';
import type { Template } from '../src/grammar';

const model: ModelCapabilities = {
	id: 'img-2',
	name: 'Image Two',
	media: 'image',
	aspectRatios: { options: ['1:1', '16:9'], default: '1:1' },
	seed: { min: 0, max: 99_999 }
};

const templates: Template[] = [{ id: 't-light', name: 'light', body: 'golden hour' }];

function makeRecord(overrides: Partial<Parameters<typeof createGenerationRecord>[0]> = {}): GenerationRecord {
	return createGenerationRecord({
		rawPrompt: 'A {animal} at {{light}}',
		templates,
		values: { animal: 'fox' },
		model,
		request: { prompt: 'A {animal} at {{light}}', aspectRatio: '16:9', seed: 42 },
		createdAt: '2026-01-01T00:00:00.000Z',
		id: 'rec-1',
		...overrides
	});
}

const structured = (result: { structuredContent?: Record<string, unknown> }) => result.structuredContent as any;
const errorText = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0].text;

async function setup(options: { templates?: Template[] } = {}) {
	const store = createGenerationRecordStore({ storage: createMemoryStorage() });
	await store.put(makeRecord());
	await store.put(makeRecord({ id: 'rec-2', createdAt: '2026-01-02T00:00:00.000Z', values: { animal: 'owl' } }));
	const generate = vi.fn(() => ({ jobId: 'job-1' }));
	const registry = new ToolRegistry();
	registry.register(createGenerationHistoryToolProvider({ store, models: [model], templates: options.templates ?? templates }));
	registry.register(createGenerationToolProvider({ models: [model], generate }));
	return { store, registry, generate };
}

describe('generation history tools', () => {
	it('exposes four read-only tools', async () => {
		const registry = new ToolRegistry();
		registry.register(createGenerationHistoryToolProvider({ store: createGenerationRecordStore({ storage: createMemoryStorage() }) }));
		const tools = registry.listTools().tools;
		expect(tools.map((t) => t.name)).toEqual(['list_generations', 'get_generation', 'recreate_generation', 'vary_generation']);
		for (const t of tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
	});

	it('lists newest first with filters and paging', async () => {
		const { registry } = await setup();
		const all = structured(await registry.callTool('list_generations', {}));
		expect(all.total).toBe(2);
		expect(all.records.map((r: any) => r.id)).toEqual(['rec-2', 'rec-1']);
		expect(all.records[0]).toMatchObject({ modelId: 'img-2', kind: 'generate', preview: 'A owl at golden hour' });
		const owl = structured(await registry.callTool('list_generations', { text: 'OWL' }));
		expect(owl.records.map((r: any) => r.id)).toEqual(['rec-2']);
		const paged = structured(await registry.callTool('list_generations', { limit: 1, offset: 1 }));
		expect(paged).toMatchObject({ total: 2, records: [{ id: 'rec-1' }] });
		expect((await registry.callTool('list_generations', { limit: 0 })).isError).toBe(true);
	});

	it('reads one record and names how to find ids when it is unknown', async () => {
		const { registry } = await setup();
		const record = structured(await registry.callTool('get_generation', { id: 'rec-1' }));
		expect(record).toMatchObject({
			id: 'rec-1',
			model: 'img-2',
			rawPrompt: 'A {animal} at {{light}}',
			resolvedPrompt: 'A fox at golden hour',
			seed: 42,
			templates: [{ name: 'light', templateId: 't-light' }]
		});
		const missing = await registry.callTool('get_generation', { id: 'nope' });
		expect(missing.isError).toBe(true);
		expect(errorText(missing)).toBe('Unknown generation "nope". Call list_generations for record ids.');
	});

	it('recreates a record as arguments generate accepts, and reports drift', async () => {
		const { registry, generate } = await setup();
		const rebuilt = structured(await registry.callTool('recreate_generation', { id: 'rec-1' }));
		expect(rebuilt).toMatchObject({ ok: true, parentId: 'rec-1', kind: 'recreate', mode: 'exact', model: 'img-2' });
		expect(rebuilt.request).toMatchObject({ aspectRatio: '16:9', seed: 42 });
		expect(rebuilt.request.model).toBeUndefined();

		const run = await registry.callTool('generate', { model: rebuilt.model, request: rebuilt.request, idempotencyKey: 'k1' });
		expect(run.isError).toBeFalsy();
		expect(generate).toHaveBeenCalledTimes(1);

		const edited = await setup({ templates: [{ id: 't-light', name: 'light', body: 'blue hour' }] });
		const drift = structured(await edited.registry.callTool('recreate_generation', { id: 'rec-1', mode: 'latest' }));
		expect(drift.drift.map((d: any) => d.type)).toContain('template-changed');
		expect(drift.resolvedPrompt).toBe('A fox at blue hour');
	});

	it('builds variations with a new seed or changes, without generating', async () => {
		const { registry, generate } = await setup();
		const seeded = structured(await registry.callTool('vary_generation', { id: 'rec-1', seed: 7, values: { animal: 'cat' } }));
		expect(seeded).toMatchObject({ kind: 'variation', parentId: 'rec-1', request: { seed: 7 }, resolvedPrompt: 'A cat at golden hour' });
		const random = structured(await registry.callTool('vary_generation', { id: 'rec-1' }));
		expect(random.request.seed).not.toBe(42);
		const wide = structured(await registry.callTool('vary_generation', { id: 'rec-1', settings: { aspectRatio: '1:1' } }));
		expect(wide.request.aspectRatio).toBe('1:1');
		expect(generate).not.toHaveBeenCalled();
		expect((await registry.callTool('vary_generation', { id: 'rec-1', count: 2 })).isError).toBe(true);
	});

	it('announces a changed list when the store changes', async () => {
		const store = createGenerationRecordStore({ storage: createMemoryStorage() });
		const provider = createGenerationHistoryToolProvider({ store });
		const notify = vi.fn();
		const unsubscribe = provider.subscribe!(notify);
		await store.put(makeRecord());
		expect(notify).toHaveBeenCalled();
		unsubscribe();
	});
});
