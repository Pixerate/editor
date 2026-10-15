// Portions ported from filmcraft-main/crates/automation/src/server.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import type { AgentTool, AgentToolProvider, McpToolResult } from '../tools/registry.js';
import { rankCommands } from './palette.js';
import type { CommandRegistry, CommandResult } from './registry.js';

export interface CommandToolProviderOptions<TContext = any> {
	/** Provider id (default `commands`). */
	id?: string;
	/** Always prefix the tool names with `<namespace>__`. */
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
 * - `run_commands {steps: [{id, params?}], stopOnError?}`: runs steps **in order**, each as
 *   its own command (and undo step). It is not atomic: steps that succeeded before a failure
 *   stay applied. For all-or-nothing behaviour, register a command that runs the steps
 *   inside `HistoryManager.batch` (or mark it `undoable` on a registry with `history`).
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

	async function runOne(id: string, params: unknown): Promise<CommandResult> {
		if (!allowed(id)) return { ok: false, id, code: 'unknown_command', message: `Unknown command "${id}".` };
		return registry.executeAsync(id, params ?? {}, context());
	}

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
			'Runs several commands in order: {steps: [{id, params?}], stopOnError?: true}. Each step is its own command and undo step; the batch is NOT atomic (steps before a failure stay applied). Returns {completed, failed, results: [{id, ok, result | code, message}]}.',
		inputSchema: {
			type: 'object',
			properties: {
				steps: {
					type: 'array',
					minItems: 1,
					items: {
						type: 'object',
						properties: {
							id: { type: 'string', description: 'Command id.' },
							params: { type: 'object', description: 'Command parameters.' }
						},
						required: ['id'],
						additionalProperties: false
					}
				},
				stopOnError: { type: 'boolean', description: 'Stop at the first failing step (default true).' }
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
		handler: async ({ steps, stopOnError = true }) => {
			let completed = 0;
			let failed = 0;
			const results: Array<Record<string, unknown>> = [];
			for (const step of steps as Array<{ id: string; params?: unknown }>) {
				const result = await runOne(step.id, step.params);
				if (result.ok) {
					completed++;
					results.push({ id: result.id, ok: true, result: toJson(result.result) });
				} else {
					failed++;
					results.push({ id: result.id, ok: false, code: result.code, message: result.message });
					if (stopOnError) break;
				}
			}
			const summary = { completed, failed, skipped: steps.length - completed - failed, results };
			return failed > 0
				? { isError: true, content: [{ type: 'text', text: JSON.stringify(summary) }], structuredContent: summary }
				: summary;
		}
	};

	return {
		id: options.id ?? 'commands',
		namespace: options.namespace,
		tools: () => [listCommands, runCommandTool(), runCommands],
		subscribe: (notify) => registry.subscribe(notify)
	};
}
