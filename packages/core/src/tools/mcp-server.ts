import type { ToolSource } from './registry.js';
import { listSkills, parseSkillFrontmatter, type SkillFiles } from './skills.js';
import { summarize } from './search.js';

/** MCP protocol revisions this server speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: JsonRpcId | null;
	method: string;
	params?: Record<string, any>;
}

export interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: JsonRpcId | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
	jsonrpc: '2.0';
	method: string;
	params?: Record<string, unknown>;
}

/** Standard JSON-RPC error codes used by the server. */
export const JSON_RPC_ERRORS = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internalError: -32603
} as const;

export interface McpServerOptions {
	/** `serverInfo` sent in the `initialize` result. */
	name: string;
	version: string;
	title?: string;
	/**
	 * Usage hints for the client's model, sent in the `initialize` result. Pass
	 * `toolsetInstructions` (or your own function) to describe the toolsets
	 * registered when the client connects.
	 */
	instructions?: string | ((source: ToolSource) => string);
	/**
	 * Agent skill files to serve as MCP resources (`skill://<name>/SKILL.md` and
	 * its reference files) and prompts (one per skill), so a client can load the
	 * guide for the tools it uses. See {@link SkillFiles}.
	 */
	skills?: SkillFiles;
	/**
	 * Sends server → client messages (`notifications/tools/list_changed`).
	 * Without it the server still answers requests but announces nothing.
	 */
	send?: (message: JsonRpcNotification) => void;
}

export interface McpServer {
	/**
	 * Handles one client message (a JSON string or a parsed object) and
	 * resolves to the response to send back, or `null` for notifications.
	 * Never rejects.
	 */
	handle(message: string | JsonRpcRequest): Promise<JsonRpcResponse | null>;
	/** Whether the client has completed the `initialize` handshake. */
	readonly initialized: boolean;
	/** Stops list-changed notifications and aborts running tool calls. */
	close(): void;
}

const errorResponse = (id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse => ({
	jsonrpc: '2.0',
	id,
	error: { code, message, ...(data !== undefined ? { data } : {}) }
});

/**
 * Instructions describing the toolsets of a tool source: what each covers, how
 * tools are named, and which skill documents it. Pass it as
 * `createMcpServer(source, { instructions: toolsetInstructions })`.
 */
export function toolsetInstructions(source: ToolSource): string {
	const sets = source.toolsets();
	const discovery = source.hasTool('list_toolsets') && source.hasTool('search_tools');
	const lines = [
		'Tools are grouped into toolsets, one per open editor or feature, and named `<toolset>__<tool>`.' +
			(discovery
				? ' Only some are listed at first: call list_toolsets to see them all, search_tools to find a tool for a task, and enable_tools to add what you need.'
				: '')
	];
	if (sets.length > 0) {
		lines.push('', 'Toolsets:');
		for (const set of sets) {
			const about = [set.title, summarize(set.description)].filter(Boolean).join(': ');
			const skill = set.skill ? ` (skill: ${set.skill})` : '';
			lines.push(`- ${set.name}${about ? ` - ${about}` : ''}${skill}, ${set.tools.length} tools`);
		}
	}
	if (sets.some((s) => s.skill)) {
		lines.push(
			'',
			'Read the skill a toolset names before using it' +
				(source.hasTool('get_skill') ? ' (get_skill).' : ' (an MCP resource or prompt when the server offers skills).')
		);
	}
	return lines.join('\n');
}

const skillUri = (path: string) => `skill://${path}`;

/**
 * A transport-agnostic MCP server for a {@link ToolRegistry} (or any {@link ToolSource}): wire `handle`
 * to any transport (stdio lines, a WebSocket, `postMessage`, an HTTP POST
 * handler) and pass `send` for server → client notifications.
 *
 * Supports `initialize` (with protocol version negotiation), `ping`,
 * `tools/list`, `tools/call`, with `skills` `resources/list`, `resources/read`,
 * `prompts/list` and `prompts/get`, and `notifications/cancelled` (aborts the
 * call's `signal`), and announces `notifications/tools/list_changed` after
 * the client sends `notifications/initialized`. An unknown tool is a
 * JSON-RPC `-32602` error, as the MCP spec asks; invalid arguments and
 * handler failures are `isError` tool results the model can read and fix.
 */
export function createMcpServer(registry: ToolSource, options: McpServerOptions): McpServer {
	const skillFiles = options.skills ?? null;
	const skills = skillFiles ? listSkills(skillFiles) : [];
	const capabilities = {
		...registry.capabilities,
		...(skills.length > 0 ? { resources: {}, prompts: {} } : {})
	};
	const readSkillPath = (path: string) => skillFiles?.[path] ?? skillFiles?.[`./${path}`];
	let initialized = false;
	// The client's name, so agent playback gives each connected client its own cursor.
	let actor: { id: string; name: string } | undefined;
	let unsubscribe: (() => void) | null = null;
	const running = new Map<JsonRpcId, AbortController>();

	const startNotifications = () => {
		if (unsubscribe || !options.send) return;
		const send = options.send;
		unsubscribe = registry.onListChanged(() => send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
	};

	async function dispatch(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
		const id = request.id ?? null;
		const isNotification = request.id === undefined || request.id === null;
		const params = request.params ?? {};

		switch (request.method) {
			case 'initialize': {
				const client = params.clientInfo as { name?: unknown; title?: unknown } | undefined;
				if (client && typeof client.name === 'string' && client.name) {
					actor = { id: `mcp:${client.name}`, name: typeof client.title === 'string' && client.title ? client.title : client.name };
				}
				const instructions = typeof options.instructions === 'function' ? options.instructions(registry) : options.instructions;
				const requested = String(params.protocolVersion ?? '');
				const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
					? requested
					: MCP_PROTOCOL_VERSIONS[0];
				return {
					jsonrpc: '2.0',
					id,
					result: {
						protocolVersion,
						capabilities,
						serverInfo: { name: options.name, version: options.version, ...(options.title ? { title: options.title } : {}) },
						...(instructions ? { instructions } : {})
					}
				};
			}
			case 'notifications/initialized':
				initialized = true;
				startNotifications();
				return null;
			case 'notifications/cancelled': {
				const requestId = params.requestId as JsonRpcId | undefined;
				if (requestId !== undefined) running.get(requestId)?.abort(params.reason);
				return null;
			}
			case 'ping':
				return { jsonrpc: '2.0', id, result: {} };
			case 'tools/list':
				return { jsonrpc: '2.0', id, result: registry.listTools() };
			case 'tools/call': {
				const name = params.name;
				if (typeof name !== 'string') {
					return errorResponse(id, JSON_RPC_ERRORS.invalidParams, 'tools/call needs a string "name".');
				}
				if (!registry.hasTool(name)) {
					return errorResponse(id, JSON_RPC_ERRORS.invalidParams, `Unknown tool: ${name}`);
				}
				const args = params.arguments;
				if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
					return errorResponse(id, JSON_RPC_ERRORS.invalidParams, '"arguments" must be an object.');
				}
				const controller = new AbortController();
				if (!isNotification) running.set(id as JsonRpcId, controller);
				try {
					const result = await registry.callTool(name, args ?? {}, { signal: controller.signal, ...(actor ? { actor } : {}) });
					// A cancelled request gets no response (MCP cancellation semantics).
					if (controller.signal.aborted) return null;
					return { jsonrpc: '2.0', id, result };
				} finally {
					if (!isNotification) running.delete(id as JsonRpcId);
				}
			}
			case 'resources/list':
			case 'prompts/list':
			case 'resources/read':
			case 'prompts/get': {
				if (skills.length === 0) break;
				if (request.method === 'resources/list') {
					const resources = skills.flatMap((skill) =>
						['SKILL.md', ...skill.references].map((file) => ({
							uri: skillUri(`${skill.name}/${file}`),
							name: file === 'SKILL.md' ? skill.name : `${skill.name}/${file}`,
							...(file === 'SKILL.md' ? { description: skill.description } : {}),
							mimeType: 'text/markdown'
						}))
					);
					return { jsonrpc: '2.0', id, result: { resources } };
				}
				if (request.method === 'resources/read') {
					const uri = String(params.uri ?? '');
					const text = uri.startsWith('skill://') ? readSkillPath(uri.slice('skill://'.length)) : undefined;
					if (text === undefined) return errorResponse(id, JSON_RPC_ERRORS.invalidParams, `Unknown resource: ${uri}`, { uri });
					return { jsonrpc: '2.0', id, result: { contents: [{ uri, mimeType: 'text/markdown', text }] } };
				}
				if (request.method === 'prompts/list') {
					return { jsonrpc: '2.0', id, result: { prompts: skills.map((s) => ({ name: s.name, description: s.description })) } };
				}
				const skill = skills.find((s) => s.name === params.name);
				const text = skill ? readSkillPath(`${skill.name}/SKILL.md`) : undefined;
				if (!skill || text === undefined) return errorResponse(id, JSON_RPC_ERRORS.invalidParams, `Unknown prompt: ${String(params.name)}`);
				return {
					jsonrpc: '2.0',
					id,
					result: {
						description: skill.description,
						messages: [{ role: 'user', content: { type: 'text', text: parseSkillFrontmatter(text).body.trim() } }]
					}
				};
			}
		}
		if (isNotification) return null;
		return errorResponse(id, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${request.method}`);
	}

	return {
		get initialized() {
			return initialized;
		},
		async handle(message) {
			let request: JsonRpcRequest;
			if (typeof message === 'string') {
				try {
					request = JSON.parse(message);
				} catch {
					return errorResponse(null, JSON_RPC_ERRORS.parseError, 'Parse error.');
				}
			} else {
				request = message;
			}
			if (
				!request ||
				typeof request !== 'object' ||
				Array.isArray(request) ||
				request.jsonrpc !== '2.0' ||
				typeof request.method !== 'string'
			) {
				const id = request && typeof request === 'object' && !Array.isArray(request) ? (request as JsonRpcRequest).id ?? null : null;
				return errorResponse(id, JSON_RPC_ERRORS.invalidRequest, 'Invalid JSON-RPC 2.0 request.');
			}
			try {
				return await dispatch(request);
			} catch (error) {
				if (request.id === undefined || request.id === null) return null;
				return errorResponse(
					request.id,
					JSON_RPC_ERRORS.internalError,
					error instanceof Error ? error.message : String(error)
				);
			}
		},
		close() {
			unsubscribe?.();
			unsubscribe = null;
			for (const controller of running.values()) controller.abort('Server closed.');
			running.clear();
		}
	};
}
