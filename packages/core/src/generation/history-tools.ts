import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { Template } from '../grammar/tokens.js';
import type { ModelCapabilities, GenerationRequest } from './capabilities.js';
import type { AssetLookup } from './assets.js';
import { recreateRequest, variationRequest, type GenerationRecord, type RecreateResult } from './record.js';
import type { GenerationRecordStore } from './store.js';

export interface GenerationHistoryToolProviderOptions {
	/** Provider id (default `generation-history`). */
	id?: string;
	namespace?: string;
	/** Where the generation records live. */
	store: GenerationRecordStore;
	/** Current models, to re-plan recreated requests and report drift (as `recreateRequest`'s `capabilities`). */
	models?: readonly ModelCapabilities[] | (() => readonly ModelCapabilities[]);
	/** Current templates, to report edits and resolve in `latest` mode. */
	templates?: readonly Template[] | (() => readonly Template[]);
	/** Current assets, to report missing or changed references (a lookup function stays live). */
	assets?: AssetLookup;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const RECORD_ID = { type: 'string', minLength: 1, description: 'Generation record id from list_generations.' } as const;

const read = <T>(value: T | (() => T) | undefined): T | undefined =>
	typeof value === 'function' ? (value as () => T)() : value;

/** Splits a request into the `model` and `request` arguments `generate` takes. */
function forGenerate(request: GenerationRequest) {
	const { model, ...rest } = request as GenerationRequest & { model?: string };
	return { model, request: rest };
}

function rebuiltResult(result: RecreateResult) {
	return {
		ok: result.ok,
		parentId: result.parentId,
		kind: result.kind,
		mode: result.mode,
		...forGenerate(result.request),
		resolvedPrompt: result.resolvedPrompt,
		drift: result.drift.map(({ type, severity, message, field, template, assetId }) => ({
			type,
			severity,
			message,
			...(field !== undefined ? { field } : {}),
			...(template !== undefined ? { template } : {}),
			...(assetId !== undefined ? { assetId } : {})
		})),
		...(result.plan ? { planErrors: result.plan.errors } : {})
	};
}

/**
 * Agent tools over a `GenerationRecordStore`, the history behind the generation history
 * panel. All are read-only: `recreate_generation` and `vary_generation` return a request to
 * pass to `generate` (from `createGenerationToolProvider`), so spending stays behind its
 * idempotency key.
 *
 * - `list_generations {model?, template?, text?, kind?, limit?, offset?}`: summaries, newest first.
 * - `get_generation {id}`: the full record (prompt, settings, seed, assets, templates).
 * - `recreate_generation {id, mode?}`: the request that reproduces a record, with drift.
 * - `vary_generation {id, seed?, values?, settings?}`: the same request with a new seed or changes.
 */
export function createGenerationHistoryToolProvider(options: GenerationHistoryToolProviderOptions): AgentToolProvider {
	const { store } = options;
	const recreateOptions = () => ({
		capabilities: read(options.models),
		templates: read(options.templates),
		assets: options.assets
	});
	const recordOrThrow = async (id: string): Promise<GenerationRecord> => {
		const record = await store.get(id);
		if (!record) throw new Error(`Unknown generation "${id}". Call list_generations for record ids.`);
		return record;
	};

	const listGenerations: AgentTool = {
		name: 'list_generations',
		title: 'List past generations',
		description:
			'Lists recorded generations newest first: id, model, kind (generate, recreate, variation), parent id, time, templates, assets and the first 160 characters of the resolved prompt. Filter to find one to inspect, recreate or vary.',
		inputSchema: {
			type: 'object',
			properties: {
				model: { type: 'string', description: 'Only this model id.' },
				template: { type: 'string', description: 'Only records that used this template name or id.' },
				text: { type: 'string', description: 'Case-insensitive text in the prompt preview.' },
				kind: { type: 'string', enum: ['generate', 'recreate', 'variation'], description: 'Only this kind of record.' },
				parentId: { type: 'string', description: 'Only records recreated or varied from this record.' },
				limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Most records to return (default 20).' },
				offset: { type: 'integer', minimum: 0, description: 'Records to skip, for paging (default 0).' }
			},
			additionalProperties: false
		},
		annotations: { title: 'List past generations', ...READ },
		handler: async ({ limit = 20, offset = 0, ...filter }) => {
			const all = await store.summaries(filter);
			return { total: all.length, records: all.slice(offset, offset + limit) };
		}
	};

	const getGeneration: AgentTool = {
		name: 'get_generation',
		title: 'Read a past generation',
		description:
			'Returns one generation record: model, raw and resolved prompt, the settings as the user set them, the strategy, the seed used, the assets and templates it used, its parent and when it ran.',
		inputSchema: { type: 'object', properties: { id: RECORD_ID }, required: ['id'], additionalProperties: false },
		annotations: { title: 'Read a past generation', ...READ },
		handler: async ({ id }) => {
			const r = await recordOrThrow(id);
			return {
				id: r.id,
				kind: r.kind,
				...(r.parentId !== undefined ? { parentId: r.parentId } : {}),
				createdAt: r.createdAt,
				model: r.provenance.modelId,
				rawPrompt: r.provenance.rawPrompt,
				resolvedPrompt: r.provenance.resolvedPrompt,
				settings: r.settings,
				strategy: r.strategy,
				...(r.seed !== undefined ? { seed: r.seed } : {}),
				assets: r.assets,
				templates: r.templates.map(({ name, templateId, version }) => ({ name, templateId, version }))
			};
		}
	};

	const recreate: AgentTool = {
		name: 'recreate_generation',
		title: 'Rebuild a past generation',
		description:
			'Builds the request that reproduces a recorded generation, without running it. Returns `model` and `request` to pass to generate, `ok` (false when something blocks an exact reproduction), and drift: templates edited or deleted, the model changed or gone, settings no longer supported, assets missing or changed. ' +
			'Report drift to the user before generating.',
		inputSchema: {
			type: 'object',
			properties: {
				id: RECORD_ID,
				mode: {
					type: 'string',
					enum: ['exact', 'latest'],
					description: 'exact (default) reproduces the recorded prompt and settings; latest uses the current templates and re-plans the settings for the current model.'
				}
			},
			required: ['id'],
			additionalProperties: false
		},
		annotations: { title: 'Rebuild a past generation', ...READ },
		handler: async ({ id, mode }) => rebuiltResult(recreateRequest(await recordOrThrow(id), { ...recreateOptions(), mode }))
	};

	const vary: AgentTool = {
		name: 'vary_generation',
		title: 'Build a variation of a past generation',
		description:
			'Builds a request for a variation of a recorded generation, without running it: the same prompt, settings and assets with a new seed (random unless given) and any changes. Returns `model` and `request` to pass to generate, plus drift.',
		inputSchema: {
			type: 'object',
			properties: {
				id: RECORD_ID,
				seed: { type: ['integer', 'null'], description: 'Seed to use; null for none. Default: a random seed different from the record\'s.' },
				values: {
					type: 'object',
					additionalProperties: { type: 'string' },
					description: 'Prompt variable values merged over the recorded ones, e.g. {"subject": "a red fox"}.'
				},
				settings: {
					type: 'object',
					description: 'Request settings merged over the recorded ones, e.g. {"aspectRatio": "16:9"} (params are merged too). See list_models for each model\'s fields.'
				},
				rawPrompt: { type: 'string', description: 'A different raw prompt (templates and variables are resolved as usual).' }
			},
			required: ['id'],
			additionalProperties: false
		},
		annotations: { title: 'Build a variation of a past generation', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		handler: async ({ id, seed, values, settings, rawPrompt }) =>
			rebuiltResult(variationRequest(await recordOrThrow(id), { seed, values, settings, rawPrompt }, recreateOptions()))
	};

	return {
		id: options.id ?? 'generation-history',
		namespace: options.namespace,
		title: 'Generation history',
		description: 'Past media generations: list and inspect them, recreate one or make variations.',
		skill: 'pixerate-generation',
		tools: [listGenerations, getGeneration, recreate, vary],
		subscribe: (notify) => store.subscribe(notify)
	};
}
