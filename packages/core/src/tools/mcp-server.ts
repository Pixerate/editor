import type { ToolRegistry } from './registry.js';

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
	/** Usage hints for the client's model, sent in the `initialize` result. */
	instructions?: string;
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
 * A transport-agnostic MCP server for a {@link ToolRegistry}: wire `handle`
 * to any transport (stdio lines, a WebSocket, `postMessage`, an HTTP POST
 * handler) and pass `send` for server → client notifications.
 *
 * Supports `initialize` (with protocol version negotiation), `ping`,
 * `tools/list`, `tools/call` and `notifications/cancelled` (aborts the
 * call's `signal`), and announces `notifications/tools/list_changed` after
 * the client sends `notifications/initialized`. An unknown tool is a
 * JSON-RPC `-32602` error, as the MCP spec asks; invalid arguments and
 * handler failures are `isError` tool results the model can read and fix.
 */
export function createMcpServer(registry: ToolRegistry, options: McpServerOptions): McpServer {
	let initialized = false;
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
				const requested = String(params.protocolVersion ?? '');
				const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
					? requested
					: MCP_PROTOCOL_VERSIONS[0];
				return {
					jsonrpc: '2.0',
					id,
					result: {
						protocolVersion,
						capabilities: registry.capabilities,
						serverInfo: { name: options.name, version: options.version, ...(options.title ? { title: options.title } : {}) },
						...(options.instructions ? { instructions: options.instructions } : {})
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
					const result = await registry.callTool(name, args ?? {}, { signal: controller.signal });
					// A cancelled request gets no response (MCP cancellation semantics).
					if (controller.signal.aborted) return null;
					return { jsonrpc: '2.0', id, result };
				} finally {
					if (!isNotification) running.delete(id as JsonRpcId);
				}
			}
			default:
				if (isNotification) return null;
				return errorResponse(id, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${request.method}`);
		}
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
