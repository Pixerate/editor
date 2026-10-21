// Portions ported from filmcraft-main/crates/automation/src/server.rs, and `$N.path` result references with
// atomic batches from vectorcraft-main/crates/mcp/src/tools.rs (`command_batch`) (MIT OR Apache-2.0, © ArtCraft
// Team and contributors). See THIRD_PARTY_NOTICES.md.
import type { AgentTool, AgentToolProvider, McpToolResult } from '../tools/registry.js';
import { derivePlaybackSteps, type PlaybackPlanResult, type PlaybackStep } from '../tools/playback.js';
import { rankCommands } from './palette.js';
import type { CommandRegistry, CommandResult } from './registry.js';

export interface CommandToolProviderOptions<TContext = any> {
	/** Provider id (default `commands`). */
	id?: string;
	/** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Context for enablement and runs (default: the registry's). */
	context?: TContext | (() => TContext);
	/** Only expose global commands plus these scopes. */
	scope?: string | readonly string[];
	/** Commands agents may not see or run (e.g. ones that open dialogs). */
	exclude?: (id: string) => boolean;
}

const toJson = (value: unknown): unknown => {
	if (value === undefined) return null;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return String(value);
	}
};

function errorResult(result: Extract<CommandResult, { ok: false }>): McpToolResult {
	return {
		isError: true,
		content: [{ type: 'text', text: `${result.code}: ${result.message}` }],
		structuredContent: {
			error: { code: result.code, message: result.message, command: result.id, ...(result.details ? { details: result.details } : {}) }
		}
	};
}

/**
 * Exposes a `CommandRegistry` to agents through a `ToolRegistry`:
 *
 * - `list_commands {query?, enabledOnly?}`: ids, labels, params schemas, shortcuts and
 *   enablement (with the reason a command is disabled).
 * - `run_command {id, params?}`: runs one command; disabled commands, unknown params and
 *   failures come back as `isError` results with a `{code, message}` error.
 * - `run_commands {steps: [{id, params?}], stopOnError?, atomic?, label?}`: runs steps **in
 *   order**. A param string `"$0.id"` or `"$last.id"` is replaced by that path of an earlier
 *   step's result (e.g. `addSeries` then `setValues` on the new series). By default each step
 *   is its own undo step and steps before a failure stay applied; `atomic: true` (on a
 *   registry with `history`) runs them as one undo step named `label` and takes everything
 *   back when one fails.
 *
 * The id enum in `run_command`'s schema follows the registered commands, so the
 * `ToolRegistry` announces `listChanged` when commands are added or removed.
 */
export function createCommandToolProvider<TContext = any>(
	registry: CommandRegistry<TContext>,
	options: CommandToolProviderOptions<TContext> = {}
): AgentToolProvider {
	const context = (): TContext => {
		const c = options.context;
		if (c === undefined) return registry.context;
		return (typeof c === 'function' ? (c as () => TContext)() : c) as TContext;
	};
	const visible = () =>
		registry.list({ scope: options.scope, context: context() }).filter((e) => !options.exclude?.(e.id));
	const allowed = (id: string) => registry.has(id) && !options.exclude?.(id) && visible().some((e) => e.id === id);

	/** Replaces `"$N.path"` / `"$last.path"` strings with values from earlier results. */
	function resolveRefs(value: unknown, results: unknown[]): unknown {
		if (typeof value === 'string') {
			const m = /^\$(\d+|last)((?:\.[\w-]+|\[\d+\])*)$/.exec(value);
			if (!m) return value;
			const index = m[1] === 'last' ? results.length - 1 : Number(m[1]);
			if (index < 0 || index >= results.length) throw new Error(`"${value}" refers to step ${m[1]}, but only ${results.length} step${results.length === 1 ? ' has' : 's have'} run.`);
			let cur: unknown = results[index];
			for (const part of m[2].match(/[\w-]+/g) ?? []) {
				if (cur === null || typeof cur !== 'object' || !(part in (cur as object))) throw new Error(`"${value}": step ${index}'s result has no "${part}".`);
				cur = (cur as Record<string, unknown>)[part];
			}
			return cur;
		}
		if (Array.isArray(value)) return value.map((v) => resolveRefs(v, results));
		if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, results)]));
		return value;
	}

	async function runOne(id: string, params: unknown): Promise<CommandResult> {
		if (!allowed(id)) return { ok: false, id, code: 'unknown_command', message: `Unknown command "${id}".` };
		return registry.executeAsync(id, params ?? {}, context());
	}

	/** Agent playback for one command: its own plan, else a visit to the ids its params name. */
	function planOne(id: string, params: unknown): PlaybackPlanResult | null {
		const spec = registry.get(id);
		if (!spec) return null;
		const surface = spec.playbackSurface ?? spec.scope ?? (id.includes('.') ? id.slice(0, id.indexOf('.')) : undefined);
		const planned = spec.plan?.(context(), (params ?? {}) as never);
		const own = !planned ? [] : Array.isArray(planned) ? planned : planned.steps;
		const steps = own.length ? own : derivePlaybackSteps(params);
		return {
			steps,
			...(surface ? { surface } : {}),
			...(planned && !Array.isArray(planned) && planned.surface ? { surface: planned.surface } : {}),
			...(spec.readOnly ? { readOnly: true } : {})
		};
	}

	const hasRefs = (value: unknown): boolean =>
		typeof value === 'string' ? value.startsWith('$') : Array.isArray(value) ? value.some(hasRefs) : !!value && typeof value === 'object' && Object.values(value).some(hasRefs);

	const listCommands: AgentTool = {
		name: 'list_commands',
		title: 'List commands',
		description:
			'Lists the commands you can run with run_command: id, label, group, params (JSON Schema), shortcuts, and whether each is enabled now (with the reason when it is not).',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Fuzzy filter on label, keywords, group and id.' },
				enabledOnly: { type: 'boolean', description: 'Only commands that can run now (default false).' }
			},
			additionalProperties: false
		},
		annotations: { title: 'List commands', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: ({ query = '', enabledOnly = false }) => {
			let entries = visible();
			if (enabledOnly) entries = entries.filter((e) => e.enabled);
			if (String(query).trim()) entries = rankCommands(String(query), entries, { disabledLast: false }).map((r) => r.entry);
			return {
				commands: entries.map((e) => ({
					id: e.id,
					label: e.label,
					...(e.group ? { group: e.group } : {}),
					...(e.description ? { description: e.description } : {}),
					...(e.params ? { params: e.params } : {}),
					...(e.shortcuts.length ? { shortcuts: e.shortcuts } : {}),
					enabled: e.enabled,
					...(e.disabledReason ? { disabledReason: e.disabledReason } : {}),
					readOnly: e.readOnly
				}))
			};
		}
	};

	const runCommandTool = (): AgentTool => {
		const ids = visible().map((e) => e.id);
		return {
			name: 'run_command',
			title: 'Run a command',
			description:
				'Runs one command by id with optional params (see list_commands for each command\'s params schema). Unknown params are rejected.',
			inputSchema: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Command id from list_commands.', ...(ids.length ? { enum: ids } : {}) },
					params: { type: 'object', description: 'Command parameters.' }
				},
				required: ['id'],
				additionalProperties: false
			},
			annotations: { title: 'Run a command', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
			plan: ({ id, params }) => planOne(String(id), params),
			handler: async ({ id, params }) => {
				const result = await runOne(String(id), params);
				return result.ok ? { id: result.id, ok: true, result: toJson(result.result) } : errorResult(result);
			}
		};
	};

	const runCommands: AgentTool = {
		name: 'run_commands',
		title: 'Run several commands',
		description:
			'Runs several commands in order: {steps: [{id, params?}], stopOnError?: true, atomic?: false, label?}. A param string "$0.id" or "$last.id" is replaced by that path of an earlier step\'s result, so you can use an id a step created without another round trip. Not atomic by default (each step is its own undo step and steps before a failure stay applied); atomic: true makes the batch one undo step named label and takes everything back if a step fails. Returns {completed, failed, skipped, results: [{id, ok, result | code, message}]}.',
		inputSchema: {
			type: 'object',
			properties: {
				steps: {
					type: 'array',
					minItems: 1,
					maxItems: 256,
					description: 'Commands to run in order (at most 256).',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string', description: 'Command id.' },
							params: { type: 'object', description: 'Command parameters; strings like "$0.id" or "$last.series[0]" refer to earlier results.' }
						},
						required: ['id'],
						additionalProperties: false
					}
				},
				stopOnError: { type: 'boolean', description: 'Stop at the first failing step (default true). Ignored when atomic.' },
				atomic: { type: 'boolean', description: 'Run every step as one undo step, all or nothing (default false). Needs a registry created with a history.' },
				label: { type: 'string', description: 'Undo step name for an atomic batch (default "Run commands").' }
			},
			required: ['steps'],
			additionalProperties: false
		},
		annotations: {
			title: 'Run several commands',
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false
		},
		// Plays the steps' own plans one after another, then runs the batch once. Steps whose
		// params refer to earlier results can't be planned before the batch runs and are skipped.
		plan: ({ steps }) => {
			const list = (steps ?? []) as Array<{ id: string; params?: unknown }>;
			let surface: string | undefined;
			const out: PlaybackStep[] = [];
			for (const s of list) {
				if (hasRefs(s.params)) continue;
				const planned = planOne(s.id, s.params);
				if (!planned) continue;
				surface ??= planned.surface;
				if (planned.surface && planned.surface !== surface) continue;
				out.push(...planned.steps.filter((step) => step.type !== 'commit'));
			}
			return out.length || surface ? { steps: out.length ? [...out, { type: 'commit' }] : [], ...(surface ? { surface } : {}) } : null;
		},
		handler: async ({ steps, stopOnError = true, atomic = false, label = 'Run commands' }) => {
			let completed = 0;
			let failed = 0;
			const results: Array<Record<string, unknown>> = [];
			const values: unknown[] = [];
			const list = steps as Array<{ id: string; params?: unknown }>;
			const step = (s: { id: string; params?: unknown }, run: (id: string, params: unknown) => CommandResult): boolean => {
				let params: unknown;
				try {
					params = resolveRefs(s.params, values);
				} catch (error) {
					failed++;
					results.push({ id: s.id, ok: false, code: 'invalid_params', message: (error as Error).message });
					return false;
				}
				const result = run(s.id, params);
				if (result.ok) {
					completed++;
					const value = toJson(result.result);
					values.push(value);
					results.push({ id: result.id, ok: true, result: value });
					return true;
				}
				failed++;
				values.push(null);
				results.push({ id: result.id, ok: false, code: result.code, message: result.message });
				return false;
			};
			if (atomic) {
				const history = registry.history;
				if (!history) {
					const message = 'atomic batches need a CommandRegistry created with { history }; run the steps without atomic, or ask the host to share its history.';
					return { isError: true, content: [{ type: 'text', text: message }], structuredContent: { error: { code: 'unsupported', message } } };
				}
				const syncRun = (id: string, params: unknown): CommandResult => {
					if (!allowed(id)) return { ok: false, id, code: 'unknown_command', message: `Unknown command "${id}".` };
					const r = registry.execute(id, params ?? {}, context());
					if (r.ok && r.result && typeof (r.result as Promise<unknown>).then === 'function') return { ok: false, id, code: 'failed', message: `"${id}" runs asynchronously and cannot be part of an atomic batch.` };
					return r;
				};
				try {
					history.batch(String(label), () => {
						for (const s of list) if (!step(s, syncRun)) throw new Error('rollback');
					});
				} catch {
					// The batch rolled back: nothing stays applied.
				}
				const summary = { completed: failed ? 0 : completed, failed, skipped: list.length - completed - failed, rolledBack: failed > 0, results };
				return failed > 0 ? { isError: true, content: [{ type: 'text', text: JSON.stringify(summary) }], structuredContent: summary } : summary;
			}
			for (const s of list) {
				let params: unknown;
				try {
					params = resolveRefs(s.params, values);
				} catch (error) {
					failed++;
					values.push(null);
					results.push({ id: s.id, ok: false, code: 'invalid_params', message: (error as Error).message });
					if (stopOnError) break;
					continue;
				}
				const result = await runOne(s.id, params);
				if (result.ok) {
					completed++;
					const value = toJson(result.result);
					values.push(value);
					results.push({ id: result.id, ok: true, result: value });
				} else {
					failed++;
					values.push(null);
					results.push({ id: result.id, ok: false, code: result.code, message: result.message });
					if (stopOnError) break;
				}
			}
			const summary = { completed, failed, skipped: list.length - completed - failed, results };
			return failed > 0
				? { isError: true, content: [{ type: 'text', text: JSON.stringify(summary) }], structuredContent: summary }
				: summary;
		}
	};

	return {
		id: options.id ?? 'commands',
		namespace: options.namespace,
		title: 'Commands',
		description: 'The app\'s commands (menu and keyboard actions) with their params schemas: list them, run one, or run several as one undo step.',
		skill: 'pixerate-agent-tools',
		tools: () => [listCommands, runCommandTool(), runCommands],
		subscribe: (notify) => registry.subscribe(notify)
	};
}
