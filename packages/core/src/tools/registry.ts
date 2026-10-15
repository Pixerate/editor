import { validateJsonSchema, type JsonSchema, type SchemaValidationError } from './schema.js';

/**
 * MCP-shaped tool definition, as returned by `tools/list`.
 */
export interface McpToolDefinition {
	name: string;
	title?: string;
	description?: string;
	inputSchema: JsonSchema & { type: 'object' };
	outputSchema?: JsonSchema;
	annotations?: {
		title?: string;
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
		[key: string]: unknown;
	};
}

export type McpToolContent =
	| { type: 'text'; text: string }
	| { type: 'image'; data: string; mimeType: string }
	| { type: string; [key: string]: unknown };

/** MCP `tools/call` result. */
export interface McpToolResult {
	content: McpToolContent[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

/** MCP `tools/list` result. */
export interface McpListToolsResult {
	tools: McpToolDefinition[];
}

export interface ToolCallContext {
	/** Name the tool was called by (possibly namespaced). */
	name: string;
	/** Id of the provider that owns the tool. */
	providerId: string;
	signal?: AbortSignal;
}

/**
 * Handler return values are normalized into an {@link McpToolResult}: a full
 * result (`{ content: [...] }`) is passed through, a string becomes a text
 * block, `undefined` becomes an empty result, and anything else is returned
 * as `structuredContent` (plain objects) plus a JSON text block.
 */
export type AgentToolHandler = (args: Record<string, any>, context: ToolCallContext) => unknown | Promise<unknown>;

export interface AgentTool extends McpToolDefinition {
	handler: AgentToolHandler;
}

/**
 * A source of tools, typically one per mounted editor, spreadsheet or canvas.
 */
export interface AgentToolProvider {
	/** Unique id within a registry, e.g. `doc-1`. Used as the namespace on collisions. */
	id: string;
	/** Always prefix this provider's tools with `<namespace>__`. */
	namespace?: string;
	/** Tools, or a function returning the current tools (re-read on every `listTools`). */
	tools: readonly AgentTool[] | (() => readonly AgentTool[]);
	/** Lets the provider signal that its tool list changed; returns an unsubscribe function. */
	subscribe?: (notify: () => void) => () => void;
}

export type ToolErrorCode = 'unknown_tool' | 'invalid_arguments' | 'tool_failed';

/** Structured error carried in `structuredContent.error` of a failed call. */
export interface ToolCallError {
	code: ToolErrorCode;
	message: string;
	tool: string;
	details?: SchemaValidationError[];
}

export class ToolRegistryError extends Error {
	readonly code: 'duplicate_provider' | 'name_collision' | 'invalid_tool';

	constructor(code: ToolRegistryError['code'], message: string) {
		super(message);
		this.name = 'ToolRegistryError';
		this.code = code;
	}
}

export interface ToolRegistryOptions {
	/**
	 * What to do when two providers contribute the same tool name:
	 * `namespace` (default) exposes every colliding tool as `<providerId>__<name>`;
	 * `error` makes `register` throw.
	 */
	onCollision?: 'namespace' | 'error';
	/** Coalescing window for `listChanged` notifications in ms (default 0: same tick). */
	listChangedDelayMs?: number;
	/** Validate arguments against `inputSchema` before calling handlers (default `true`). */
	validateArguments?: boolean;
}

/** Separator between namespace and tool name; valid in MCP and LLM tool-name charsets. */
export const TOOL_NAMESPACE_SEPARATOR = '__';

const TOOL_NAME_REGEX = /^[A-Za-z0-9_.-]{1,128}$/;
const sanitizeNamespace = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_');

interface ResolvedTool {
	name: string;
	tool: AgentTool;
	provider: AgentToolProvider;
}

interface ProviderEntry {
	provider: AgentToolProvider;
	unsubscribe?: () => void;
}

function readTools(provider: AgentToolProvider): readonly AgentTool[] {
	return typeof provider.tools === 'function' ? provider.tools() : provider.tools;
}

function toDefinition(name: string, tool: AgentTool): McpToolDefinition {
	const { handler: _handler, name: _name, ...rest } = tool;
	return { name, ...rest };
}

function errorResult(error: ToolCallError): McpToolResult {
	const details = error.details?.length
		? '\n' + error.details.map((d) => `- ${d.path}: ${d.message}`).join('\n')
		: '';
	return {
		isError: true,
		content: [{ type: 'text', text: `${error.message}${details}` }],
		structuredContent: { error: error as unknown as Record<string, unknown> }
	};
}

/** Normalizes a handler's return value into an MCP `tools/call` result. */
export function toToolResult(value: unknown): McpToolResult {
	if (
		value &&
		typeof value === 'object' &&
		Array.isArray((value as McpToolResult).content)
	) {
		return value as McpToolResult;
	}
	if (value === undefined) return { content: [] };
	if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
	const text = JSON.stringify(value);
	const isPlainObject = typeof value === 'object' && value !== null && !Array.isArray(value);
	return {
		content: [{ type: 'text', text: text ?? String(value) }],
		...(isPlainObject ? { structuredContent: value as Record<string, unknown> } : {})
	};
}

/**
 * Transport-agnostic registry of agent tools contributed by live providers.
 *
 * `listTools()` and `callTool()` return MCP `tools/list` / `tools/call`
 * result shapes, and `onListChanged` fires (coalesced) whenever the exposed
 * tool list changes, mirroring MCP's `notifications/tools/list_changed`, so an
 * MCP server can be a thin wrapper around it.
 */
export class ToolRegistry {
	/** MCP server capabilities this registry supports. */
	readonly capabilities = { tools: { listChanged: true } } as const;

	private readonly entries: ProviderEntry[] = [];
	private readonly listeners = new Set<(tools: McpToolDefinition[]) => void>();
	private readonly options: Required<ToolRegistryOptions>;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private lastSignature: string;

	constructor(options: ToolRegistryOptions = {}) {
		this.options = {
			onCollision: options.onCollision ?? 'namespace',
			listChangedDelayMs: options.listChangedDelayMs ?? 0,
			validateArguments: options.validateArguments ?? true
		};
		this.lastSignature = this.signature();
	}

	/**
	 * Registers a provider and returns a function that unregisters it.
	 * Throws a {@link ToolRegistryError} for a duplicate provider id, an invalid
	 * tool name, or (with `onCollision: 'error'`) a tool name collision.
	 */
	register(provider: AgentToolProvider): () => void {
		if (this.entries.some((e) => e.provider.id === provider.id)) {
			throw new ToolRegistryError('duplicate_provider', `Tool provider "${provider.id}" is already registered.`);
		}
		for (const tool of readTools(provider)) {
			if (!TOOL_NAME_REGEX.test(tool.name)) {
				throw new ToolRegistryError('invalid_tool', `Invalid tool name "${tool.name}" from provider "${provider.id}".`);
			}
		}
		const entry: ProviderEntry = { provider };
		this.entries.push(entry);
		try {
			const names = this.resolve(this.options.onCollision === 'error').map((t) => t.name);
			const duplicate = names.find((name, i) => names.indexOf(name) !== i);
			if (duplicate) {
				// Only possible with explicit namespaces (or duplicate names within one provider).
				throw new ToolRegistryError('name_collision', `Tool name "${duplicate}" is exposed more than once.`);
			}
		} catch (error) {
			this.entries.pop();
			throw error;
		}
		if (provider.subscribe) {
			entry.unsubscribe = provider.subscribe(() => this.notifyListChanged());
		}
		this.notifyListChanged();
		let registered = true;
		return () => {
			if (!registered) return;
			registered = false;
			this.unregister(provider);
		};
	}

	/** Removes a provider by id or instance. Returns whether it was registered. */
	unregister(providerOrId: string | AgentToolProvider): boolean {
		const index = this.entries.findIndex((e) =>
			typeof providerOrId === 'string' ? e.provider.id === providerOrId : e.provider === providerOrId
		);
		if (index === -1) return false;
		const [entry] = this.entries.splice(index, 1);
		entry.unsubscribe?.();
		this.notifyListChanged();
		return true;
	}

	/** Registered provider ids in registration order. */
	providerIds(): string[] {
		return this.entries.map((e) => e.provider.id);
	}

	/**
	 * Resolves exposed names. Tools are ordered by provider registration, then
	 * by their order within the provider.
	 */
	private resolve(throwOnCollision = false): ResolvedTool[] {
		const all: ResolvedTool[] = [];
		const counts = new Map<string, number>();
		for (const { provider } of this.entries) {
			for (const tool of readTools(provider)) {
				all.push({ name: tool.name, tool, provider });
				if (!provider.namespace) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
			}
		}
		for (const item of all) {
			const prefix = item.provider.namespace ?? ((counts.get(item.name) ?? 0) > 1 ? item.provider.id : undefined);
			if (prefix !== undefined) {
				if (throwOnCollision && !item.provider.namespace) {
					throw new ToolRegistryError(
						'name_collision',
						`Tool "${item.name}" from provider "${item.provider.id}" collides with another provider's tool.`
					);
				}
				item.name = `${sanitizeNamespace(prefix)}${TOOL_NAMESPACE_SEPARATOR}${item.name}`;
			}
		}
		return all;
	}

	/** MCP `tools/list` result for the current providers. */
	listTools(): McpListToolsResult {
		return { tools: this.resolve().map(({ name, tool }) => toDefinition(name, tool)) };
	}

	/** Whether a tool with this exposed name exists. */
	hasTool(name: string): boolean {
		return this.resolve().some((t) => t.name === name);
	}

	/** Looks up a tool definition by exposed name. */
	getTool(name: string): McpToolDefinition | undefined {
		const found = this.resolve().find((t) => t.name === name);
		return found ? toDefinition(found.name, found.tool) : undefined;
	}

	/**
	 * Calls a tool by exposed name and returns an MCP `tools/call` result.
	 * Never rejects: unknown tools, invalid arguments and handler errors come
	 * back as `isError: true` results with a {@link ToolCallError} in
	 * `structuredContent.error` (MCP transports may map `unknown_tool` to a
	 * JSON-RPC `-32602` error instead).
	 */
	async callTool(name: string, args: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {}): Promise<McpToolResult> {
		const found = this.resolve().find((t) => t.name === name);
		if (!found) {
			return errorResult({ code: 'unknown_tool', message: `Unknown tool "${name}".`, tool: name });
		}
		const input = args ?? {};
		if (this.options.validateArguments) {
			const details = validateJsonSchema(input, found.tool.inputSchema);
			if (details.length > 0) {
				return errorResult({
					code: 'invalid_arguments',
					message: `Invalid arguments for tool "${name}".`,
					tool: name,
					details
				});
			}
		}
		try {
			const value = await found.tool.handler(input as Record<string, any>, {
				name,
				providerId: found.provider.id,
				signal: options.signal
			});
			return toToolResult(value);
		} catch (error) {
			return errorResult({
				code: 'tool_failed',
				message: error instanceof Error ? error.message : String(error),
				tool: name
			});
		}
	}

	/**
	 * Subscribes to tool-list changes. Notifications are coalesced: many
	 * registrations or provider signals within the delay window produce one
	 * call, and none if the exposed list ends up unchanged (e.g. a provider
	 * unmounted and remounted). Returns an unsubscribe function.
	 */
	onListChanged(listener: (tools: McpToolDefinition[]) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Schedules a coalesced `listChanged` check; providers may call it directly. */
	notifyListChanged(): void {
		if (this.timer !== null) return;
		this.timer = setTimeout(() => this.flush(), this.options.listChangedDelayMs);
	}

	/** Runs a pending `listChanged` check immediately. */
	flush(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const signature = this.signature();
		if (signature === this.lastSignature) return;
		this.lastSignature = signature;
		const { tools } = this.listTools();
		for (const listener of Array.from(this.listeners)) listener(tools);
	}

	private signature(): string {
		try {
			return JSON.stringify(this.listTools().tools);
		} catch {
			return String(Math.random());
		}
	}

	/** Unregisters every provider and listener and cancels pending notifications. */
	dispose(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
		for (const entry of this.entries.splice(0)) entry.unsubscribe?.();
		this.listeners.clear();
	}
}

export function createToolRegistry(options?: ToolRegistryOptions): ToolRegistry {
	return new ToolRegistry(options);
}
