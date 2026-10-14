import type { AgentTool, AgentToolProvider, ToolCallContext } from '../agent/registry.js';
import type { JsonSchema } from '../agent/schema.js';
import {
	REFERENCE_ROLES,
	supportedReferenceRoles,
	type GenerationRequest,
	type ModelCapabilities,
	type ReferenceRole
} from './capabilities.js';
import { planGenerationRequest, type GenerationPlan, type PlanStrategy } from './plan.js';
import { capabilitiesToJsonSchema } from './schema.js';
import { stableStringify } from './hash.js';

export interface GenerateContext {
	model: ModelCapabilities;
	plan: GenerationPlan;
	idempotencyKey: string;
	signal?: AbortSignal;
}

export interface EstimateContext {
	model: ModelCapabilities;
	plan: GenerationPlan;
	signal?: AbortSignal;
}

export interface GenerationToolProviderOptions {
	/** Provider id (default `generation`). */
	id?: string;
	namespace?: string;
	/** Models, or a function returning the current models (re-read on every list/call). */
	models: readonly ModelCapabilities[] | (() => readonly ModelCapabilities[]);
	/** Sends a planned request. Its resolved value is the tool result (e.g. `{ jobId }`). */
	generate: (request: GenerationRequest, context: GenerateContext) => unknown | Promise<unknown>;
	/** Optional cost/time estimate; adds the `estimate_generation` tool. */
	estimate?: (request: GenerationRequest, context: EstimateContext) => unknown | Promise<unknown>;
	/** Strategy used when the caller does not pass one (default `nearest`). */
	defaultStrategy?: PlanStrategy;
	/** Completed idempotency keys remembered (default 500, oldest evicted first). */
	maxIdempotencyKeys?: number;
	/** Lets the host signal that the model list changed. */
	subscribe?: AgentToolProvider['subscribe'];
}

export interface GenerationToolProvider extends AgentToolProvider {
	/** Forgets remembered idempotency keys (all, or one). */
	clearIdempotencyKeys(key?: string): void;
}

const STRATEGIES: PlanStrategy[] = ['nearest', 'upgrade', 'downgrade', 'error'];

/** Built-in roles plus every role a model declares, for the shared request schema. */
function knownRoles(models: readonly ModelCapabilities[]): ReferenceRole[] {
	const roles: ReferenceRole[] = [...REFERENCE_ROLES];
	for (const model of models) {
		for (const role of supportedReferenceRoles(model)) if (!roles.includes(role)) roles.push(role);
	}
	return roles;
}

const requestSchemaFor = (roles: readonly ReferenceRole[]): JsonSchema => ({
	type: 'object',
	description:
		'Generation request. Call list_models for the fields each model supports; unsupported values are adjusted per `strategy`.',
	properties: {
		prompt: { type: 'string' },
		negativePrompt: { type: 'string' },
		systemPrompt: { type: 'string' },
		aspectRatio: { type: 'string', description: 'E.g. "16:9".' },
		resolution: { type: 'string' },
		quality: { type: 'string' },
		count: { type: 'integer', minimum: 1 },
		duration: { type: 'number', minimum: 0, description: 'Seconds.' },
		seed: { type: 'integer' },
		mode: { type: 'string', enum: ['generate', 'edit', 'inpaint'] },
		references: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id: { type: 'string', minLength: 1 },
					role: {
						type: 'string',
						enum: [...roles],
						description: 'What the asset is used for. Each model lists the roles it accepts (list_models).'
					},
					url: { type: 'string' },
					mediaType: { type: 'string', description: 'MIME type or media kind, e.g. "image/png".' },
					contentHash: { type: 'string' }
				},
				required: ['id', 'role'],
				additionalProperties: false
			}
		},
		params: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } }
	},
	additionalProperties: false
});

const strategySchema: JsonSchema = {
	type: 'string',
	enum: STRATEGIES,
	description:
		'How to handle unsupported values: nearest (snap/clamp, ties up), downgrade (ties down), upgrade (ties up, never drops references), error (change nothing).'
};

function planFailure(plan: GenerationPlan) {
	return {
		isError: true,
		content: [
			{
				type: 'text',
				text: `The request cannot be sent to "${plan.model}":\n${plan.errors.map((e) => `- ${e.field}: ${e.message}`).join('\n')}`
			}
		],
		structuredContent: { error: { code: 'plan_failed', message: 'Request planning failed.' }, plan }
	};
}

/**
 * Exposes generation models to a `ToolRegistry`:
 *
 * - `list_models` (read-only): ids, presentation fields and per-model request schemas.
 * - `plan_generation` (read-only): the adjusted request, adjustments and errors.
 * - `estimate_generation` (read-only, only with `estimate`): your estimate for the planned request.
 * - `generate` (destructive): plans, then calls `generate` with the adjusted
 *   request. Requires an `idempotencyKey`: a retry with the same key and
 *   arguments returns the first call's result (or joins it while in flight)
 *   instead of generating again; the same key with different arguments is
 *   rejected. Failed calls forget their key so they can be retried.
 */
export function createGenerationToolProvider(options: GenerationToolProviderOptions): GenerationToolProvider {
	const readModels = () => (typeof options.models === 'function' ? options.models() : options.models);
	const defaultStrategy = options.defaultStrategy ?? 'nearest';
	const maxKeys = Math.max(1, options.maxIdempotencyKeys ?? 500);
	const calls = new Map<string, { signature: string; result: Promise<unknown> }>();

	const findModel = (id: unknown) => {
		const model = readModels().find((m) => m.id === id);
		if (!model) throw new Error(`Unknown model "${String(id)}". Call list_models for the available ids.`);
		return model;
	};

	const plan = (args: Record<string, any>) => {
		const model = findModel(args.model);
		const request: GenerationRequest = { ...(args.request ?? {}), model: model.id };
		return {
			model,
			plan: planGenerationRequest(request, model, {
				strategy: args.strategy ?? defaultStrategy,
				resolvedPrompt: args.resolvedPrompt
			})
		};
	};

	const planInput = (): JsonSchema & { type: 'object' } => {
		const models = readModels();
		const ids = models.map((m) => m.id);
		return {
			type: 'object',
			properties: {
				model: { type: 'string', ...(ids.length ? { enum: ids } : {}), description: 'Model id from list_models.' },
				request: requestSchemaFor(knownRoles(models)),
				strategy: strategySchema,
				resolvedPrompt: {
					type: 'string',
					description: 'The prompt with templates and variables resolved, when `request.prompt` is a template.'
				}
			},
			required: ['model', 'request'],
			additionalProperties: false
		};
	};

	const tools = (): AgentTool[] => {
		const list: AgentTool[] = [
			{
				name: 'list_models',
				title: 'List generation models',
				description:
					'Lists the available generation models with their media kind, description and the JSON Schema of the request each accepts.',
				inputSchema: {
					type: 'object',
					properties: {
						media: { type: 'string', enum: ['image', 'video', 'audio', 'text'], description: 'Only models of this kind.' }
					},
					additionalProperties: false
				},
				annotations: {
					title: 'List generation models',
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false
				},
				handler: (args) => ({
					models: readModels()
						.filter((m) => !args.media || m.media === args.media)
						.map((m) => ({
							id: m.id,
							media: m.media,
							...(m.name ? { name: m.name } : {}),
							...(m.description ? { description: m.description } : {}),
							...(m.badges?.length ? { badges: [...m.badges] } : {}),
							requestSchema: capabilitiesToJsonSchema(m)
						}))
				})
			},
			{
				name: 'plan_generation',
				title: 'Plan a generation request',
				description:
					'Checks a request against a model without generating: returns the adjusted request, every adjustment (field, from, to, reason) and errors.',
				inputSchema: planInput(),
				annotations: {
					title: 'Plan a generation request',
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false
				},
				handler: (args) => ({ plan: plan(args).plan })
			}
		];

		if (options.estimate) {
			const estimate = options.estimate;
			list.push({
				name: 'estimate_generation',
				title: 'Estimate a generation',
				description: 'Estimates cost and/or time of a request after planning it. Does not generate anything.',
				inputSchema: planInput(),
				annotations: {
					title: 'Estimate a generation',
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true
				},
				handler: async (args, context: ToolCallContext) => {
					const planned = plan(args);
					if (!planned.plan.ok) return planFailure(planned.plan);
					const value = await estimate(planned.plan.request, { ...planned, signal: context.signal });
					return { plan: planned.plan, estimate: value };
				}
			});
		}

		const generateInput = planInput();
		list.push({
			name: 'generate',
			title: 'Generate media',
			description:
				'Plans the request and starts a generation. Pass a fresh `idempotencyKey` per intended generation and reuse it when retrying, so a retry never generates twice.',
			inputSchema: {
				...generateInput,
				properties: {
					...generateInput.properties,
					idempotencyKey: {
						type: 'string',
						minLength: 1,
						maxLength: 200,
						description: 'Unique per intended generation; reuse it to retry safely.'
					}
				},
				required: ['model', 'request', 'idempotencyKey']
			},
			annotations: {
				title: 'Generate media',
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true
			},
			handler: async (args, context: ToolCallContext) => {
				const key = String(args.idempotencyKey);
				const { idempotencyKey: _key, ...rest } = args;
				const signature = stableStringify(rest);
				const existing = calls.get(key);
				if (existing) {
					if (existing.signature !== signature) {
						throw new Error(
							`Idempotency key "${key}" was already used with different arguments. Use a new key for a new generation.`
						);
					}
					return { ...(await existing.result as object), deduplicated: true };
				}
				const planned = plan(args);
				if (!planned.plan.ok) return planFailure(planned.plan);
				const result = Promise.resolve()
					.then(() =>
						options.generate(planned.plan.request, {
							...planned,
							idempotencyKey: key,
							signal: context.signal
						})
					)
					.then((value) => ({
						result: value,
						plan: planned.plan,
						idempotencyKey: key
					}));
				calls.set(key, { signature, result });
				while (calls.size > maxKeys) calls.delete(calls.keys().next().value as string);
				try {
					return await result;
				} catch (error) {
					if (calls.get(key)?.result === result) calls.delete(key);
					throw error;
				}
			}
		});
		return list;
	};

	return {
		id: options.id ?? 'generation',
		...(options.namespace ? { namespace: options.namespace } : {}),
		tools,
		...(options.subscribe ? { subscribe: options.subscribe } : {}),
		clearIdempotencyKeys(key?: string) {
			if (key === undefined) calls.clear();
			else calls.delete(key);
		}
	};
}
