import { validateJsonSchema, type JsonSchema, type SchemaValidationError } from './schema.js';
import { ToolRegistryView, type ToolViewOptions } from './view.js';
import { stripPrototypeKeys } from './safe-json.js';
import type { PlaybackStep, ToolPlanner } from './playback.js';
import type { PresenceActorInfo } from './presence.js';

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
	/** Who is calling (an MCP client, a scripted agent), for agent playback's cursors and queues. */
	actor?: PresenceActorInfo;
	/**
	 * Set by agent playback when the tool's plan has `stage` steps: resolves when the cursor
	 * reaches the next one. A handler that adds several things awaits it before each
	 * (`await context.stage?.()`), so they appear one by one; without playback it is absent.
	 */
	stage?: () => Promise<void>;
	/**
	 * Set by agent playback while the handler runs: acts out cursor steps (surface coordinates) the
	 * handler only learns mid-call, such as the outline a model returned, before it lands its change.
	 * `commit`, `stage` and `open` steps are ignored. Without playback it is absent.
	 */
	perform?: (steps: readonly PlaybackStep[]) => Promise<void>;
}

/** Options for `callTool`. */
export interface ToolCallOptions {
	signal?: AbortSignal;
	/** Who is calling; agent playback gives each actor its own cursor and queue. */
	actor?: PresenceActorInfo;
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
	/**
	 * How agent playback acts this tool out (see `createAgentPlayback`): `'self'` when the
	 * handler drives its own cursor (a director), `false` to never play it. Default: play it
	 * from `plan`, or from the ids in its arguments and result.
	 */
	playback?: 'self' | false;
	/**
	 * Pure planner for agent playback: the cursor steps (surface coordinates) that act out a
	 * call with these arguments, given the state before the call. Not sent to clients.
	 */
	plan?: ToolPlanner;
}

/**
 * A source of tools, typically one per mounted editor, spreadsheet or canvas.
 * Each provider is a toolset: its tools are exposed as `<namespace>__<name>`
 * (see {@link ToolRegistryOptions.namespaces}) and grouped under that name by
 * `toolsets()`, `registry.view()` and the discovery tools.
 */
export interface AgentToolProvider {
	/** Unique id within a registry, e.g. `doc-1`. The default namespace. */
	id: string;
	/**
	 * Prefix for this provider's tools (`<namespace>__<name>`). Defaults to the
	 * `id`. Pass `''` to expose bare names (prefixed by `id` only on a collision).
	 * Providers may share a namespace when their tool names differ.
	 */
	namespace?: string;
	/** Short name of the toolset for agents and UIs, e.g. "Chart editor". */
	title?: string;
	/** What the toolset covers and when to use it, in a sentence or two. */
	description?: string;
	/** Name of the agent skill that documents these tools, e.g. `pixerate-chart`. */
	skill?: string;
	/** Tools, or a function returning the current tools (re-read on every `listTools`). */
	tools: readonly AgentTool[] | (() => readonly AgentTool[]);
	/** Lets the provider signal that its tool list changed; returns an unsubscribe function. */
	subscribe?: (notify: () => void) => () => void;
	/** The playback surface its calls are acted out on (default: the provider id). */
	playbackSurface?: string;
}

/** A tool call as a {@link ToolMiddleware} sees it (arguments already validated). */
export interface ToolMiddlewareCall {
	/** The exposed (possibly namespaced) name. */
	name: string;
	tool: AgentTool;
	provider: AgentToolProvider;
	args: Record<string, any>;
	context: ToolCallContext;
}

/**
 * Wraps every tool call of a registry (`registry.use`): call `next()` to run the handler (or
 * the next middleware) and return its value. A throw becomes an `isError` result.
 */
export type ToolMiddleware = (call: ToolMiddlewareCall, next: () => Promise<unknown>) => Promise<unknown>;

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
	 * `always` (default): every tool is exposed as `<namespace>__<name>`, where the
	 * namespace is the provider's `namespace` or else its `id`, so names don't
	 * change when another editor mounts. `on-collision`: only providers with an
	 * explicit `namespace` are prefixed; other tools keep their bare name unless
	 * two providers share it (see `onCollision`).
	 *
	 * Either way, `callTool`, `hasTool` and `getTool` also accept a bare name
	 * when exactly one exposed tool has it.
	 */
	namespaces?: 'always' | 'on-collision';
	/**
	 * What to do when two unprefixed tools share a name:
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

/** The toolset a provider belongs to: its namespace, or else its id. */
export function toolsetName(provider: Pick<AgentToolProvider, 'id' | 'namespace'>): string {
	return sanitizeNamespace(provider.namespace || provider.id);
}

/** The name a tool was registered under, without its namespace (`chart__get_chart` → `get_chart`). */
export function baseToolName(name: string): string {
	const index = name.lastIndexOf(TOOL_NAMESPACE_SEPARATOR);
	return index === -1 ? name : name.slice(index + TOOL_NAMESPACE_SEPARATOR.length);
}

/** A group of tools from one or more providers that share a namespace. */
export interface ToolsetInfo {
	/** Toolset name: the providers' namespace, or the provider id. */
	name: string;
	title?: string;
	description?: string;
	/** Agent skill that documents these tools. */
	skill?: string;
	/** Ids of the providers in this toolset. */
	providers: string[];
	/** Exposed names of its tools, in listing order. */
	tools: string[];
}

/**
 * Anything that serves tools the way a {@link ToolRegistry} does: a registry,
 * a {@link ToolRegistryView} of one, or the MCP bridge's registry.
 * `createMcpServer` and `connectToolBridge` accept any of them.
 */
export interface ToolSource {
	readonly capabilities: { tools: { listChanged: boolean } };
	listTools(): McpListToolsResult;
	hasTool(name: string): boolean;
	getTool(name: string): McpToolDefinition | undefined;
	callTool(name: string, args?: Record<string, unknown>, options?: ToolCallOptions): Promise<McpToolResult>;
	onListChanged(listener: (tools: McpToolDefinition[]) => void): () => void;
	/** The toolsets behind `listTools()`, in listing order. */
	toolsets(): ToolsetInfo[];
}

interface ResolvedTool {
	name: string;
	tool: AgentTool;
	provider: AgentToolProvider;
}

type Lookup = { found: ResolvedTool } | { found?: undefined; candidates: string[] };

/** Finds a tool by exposed name, or by bare name when exactly one tool has it. */
function lookup(tools: readonly ResolvedTool[], name: string): Lookup {
	const exact = tools.find((t) => t.name === name);
	if (exact) return { found: exact };
	const candidates = tools.filter((t) => baseToolName(t.name) === name);
	if (candidates.length === 1) return { found: candidates[0] };
	return { candidates: candidates.map((t) => t.name) };
}

/** `unknown_tool` message, naming the tools a bare name could mean. */
export function unknownToolMessage(name: string, candidates: readonly string[] = []): string {
	return candidates.length > 1
		? `Tool "${name}" is ambiguous: ${candidates.map((c) => `"${c}"`).join(', ')} all have that name. Call one of them by its full name.`
		: `Unknown tool "${name}". List the tools again; the editor that had it may have closed or become read-only.`;
}

interface ProviderEntry {
	provider: AgentToolProvider;
	unsubscribe?: () => void;
}

function readTools(provider: AgentToolProvider): readonly AgentTool[] {
	return typeof provider.tools === 'function' ? provider.tools() : provider.tools;
}

function toDefinition(name: string, tool: AgentTool): McpToolDefinition {
	const { handler: _handler, name: _name, plan: _plan, playback: _playback, ...rest } = tool;
	return { name, ...rest };
}

/** An `isError` tool result carrying a {@link ToolCallError}. */
export function errorResult(error: ToolCallError): McpToolResult {
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
export class ToolRegistry implements ToolSource {
	/** MCP server capabilities this registry supports. */
	readonly capabilities = { tools: { listChanged: true } } as const;

	private readonly entries: ProviderEntry[] = [];
	private readonly listeners = new Set<(tools: McpToolDefinition[]) => void>();
	private readonly middleware: ToolMiddleware[] = [];
	private readonly options: Required<ToolRegistryOptions>;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private lastSignature: string;

	constructor(options: ToolRegistryOptions = {}) {
		this.options = {
			namespaces: options.namespaces ?? 'always',
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

	/**
	 * Adds a middleware that wraps every tool call (first added runs outermost), e.g. agent
	 * playback's `playback.middleware`. Returns a function that removes it.
	 */
	use(middleware: ToolMiddleware): () => void {
		this.middleware.push(middleware);
		return () => {
			const index = this.middleware.indexOf(middleware);
			if (index !== -1) this.middleware.splice(index, 1);
		};
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
		const fixed = (provider: AgentToolProvider) =>
			provider.namespace ? provider.namespace : provider.namespace === undefined && this.options.namespaces === 'always' ? provider.id : undefined;
		for (const { provider } of this.entries) {
			const prefixed = fixed(provider) !== undefined;
			for (const tool of readTools(provider)) {
				all.push({ name: tool.name, tool, provider });
				if (!prefixed) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
			}
		}
		for (const item of all) {
			const explicit = fixed(item.provider);
			const prefix = explicit ?? ((counts.get(item.name) ?? 0) > 1 ? item.provider.id : undefined);
			if (prefix !== undefined) {
				if (throwOnCollision && explicit === undefined) {
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

	/** Whether a tool with this exposed name (or unique bare name) exists. */
	hasTool(name: string): boolean {
		return lookup(this.resolve(), name).found !== undefined;
	}

	/** Looks up a tool definition by exposed name (or unique bare name). */
	getTool(name: string): McpToolDefinition | undefined {
		const { found } = lookup(this.resolve(), name);
		return found ? toDefinition(found.name, found.tool) : undefined;
	}

	/** The registered providers grouped by namespace, in listing order. */
	toolsets(): ToolsetInfo[] {
		const sets = new Map<string, ToolsetInfo>();
		for (const { name, provider } of this.resolve()) {
			const key = toolsetName(provider);
			let set = sets.get(key);
			if (!set) {
				set = { name: key, providers: [], tools: [] };
				sets.set(key, set);
			}
			if (!set.providers.includes(provider.id)) set.providers.push(provider.id);
			set.title ??= provider.title;
			set.description ??= provider.description;
			set.skill ??= provider.skill;
			set.tools.push(name);
		}
		return Array.from(sets.values(), (set) => ({
			name: set.name,
			...(set.title ? { title: set.title } : {}),
			...(set.description ? { description: set.description } : {}),
			...(set.skill ? { skill: set.skill } : {}),
			providers: set.providers,
			tools: set.tools
		}));
	}

	/**
	 * A filtered, optionally self-discovering view of this registry: serve it
	 * with `createMcpServer` or `connectToolBridge` instead of the registry to
	 * show an agent only some toolsets. See {@link ToolRegistryView}.
	 */
	view(options: ToolViewOptions = {}): ToolRegistryView {
		return new ToolRegistryView(this, options);
	}

	/**
	 * Calls a tool by exposed name and returns an MCP `tools/call` result.
	 * Never rejects: unknown tools, invalid arguments and handler errors come
	 * back as `isError: true` results with a {@link ToolCallError} in
	 * `structuredContent.error` (MCP transports may map `unknown_tool` to a
	 * JSON-RPC `-32602` error instead).
	 */
	async callTool(name: string, args: Record<string, unknown> = {}, options: ToolCallOptions = {}): Promise<McpToolResult> {
		const match = lookup(this.resolve(), name);
		const found = match.found;
		if (!found) {
			return errorResult({ code: 'unknown_tool', message: unknownToolMessage(name, match.candidates), tool: name });
		}
		name = found.name;
		// Arguments are untrusted model output: drop `__proto__` / `constructor` /
		// `prototype` keys before any handler copies them (GHSA-cp6q-959q-f8rh).
		const input = stripPrototypeKeys(args ?? {});
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
			const context: ToolCallContext = {
				name,
				providerId: found.provider.id,
				signal: options.signal,
				...(options.actor ? { actor: options.actor } : {})
			};
			const call: ToolMiddlewareCall = { name, tool: found.tool, provider: found.provider, args: input as Record<string, any>, context };
			const chain = [...this.middleware];
			const run = async (i: number): Promise<unknown> =>
				i < chain.length ? chain[i]!(call, () => run(i + 1)) : found.tool.handler(call.args, context);
			const value = await run(0);
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
