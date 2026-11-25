// The editor half of the tool bridge protocol, without a transport: what a page announces
// (`hello` / `tools`) and how it answers a call (`call` → `result`, `cancel` → abort). The
// WebSocket client (`connectToolBridge`) is built on it; other transports (a relay through a
// database, a worker port) use it the same way. No imports beyond the registry types.
import type { McpToolDefinition, McpToolResult, ToolSource } from './registry.js';
import { TOOL_BRIDGE_PROTOCOL } from './bridge-protocol.js';

/** What an editor offers: the fields of its `hello` message. */
export interface ToolHostInfo {
	/** Protocol version (`TOOL_BRIDGE_PROTOCOL`). */
	v: number;
	/** How the editor is listed to the agent, e.g. "Diagram — Order flow". */
	name: string;
	/** What kind of editor it is ("diagram", "chart", "canvas"…). */
	kind?: string;
	tools: McpToolDefinition[];
}

/** A call to one of an editor's tools: the fields of a `call` message. */
export interface ToolCallRequest {
	name: string;
	arguments?: Record<string, unknown>;
}

export interface ServedToolSource {
	/** What the editor offers now. */
	info(): ToolHostInfo;
	/**
	 * Runs a call through the source. Never rejects: unknown tools, bad arguments and failures
	 * come back as `isError` results. Abort `signal` to cancel it.
	 */
	handle(request: ToolCallRequest, context?: { signal?: AbortSignal }): Promise<McpToolResult>;
	/** Calls `listener` with the new info whenever the tool list changes. Returns an unsubscribe. */
	onInfoChange(listener: (info: ToolHostInfo) => void): () => void;
}

/**
 * Serves a `ToolSource` (a registry or a `registry.view()`) as an editor on a tool bridge, over
 * any transport: announce `info()` when connecting and again on `onInfoChange`, and answer each
 * call with `handle` (aborting its signal when the caller cancels).
 */
export function serveToolSource(source: ToolSource, options: { name: string; kind?: string }): ServedToolSource {
	const info = (tools: McpToolDefinition[] = source.listTools().tools): ToolHostInfo => ({
		v: TOOL_BRIDGE_PROTOCOL,
		name: options.name,
		...(options.kind ? { kind: options.kind } : {}),
		tools
	});
	return {
		info: () => info(),
		async handle(request, context = {}) {
			if (context.signal?.aborted) {
				return { isError: true, content: [{ type: 'text', text: 'The call was cancelled.' }] };
			}
			return source.callTool(request.name, request.arguments ?? {}, context.signal ? { signal: context.signal } : {});
		},
		onInfoChange: (listener) => source.onListChanged((tools) => listener(info(tools)))
	};
}
