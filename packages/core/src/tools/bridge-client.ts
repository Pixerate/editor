// The editor side of the tool bridge (Ursula's `connectRemote` / src/remote/protocol.ts): a page
// connects its ToolRegistry to a local MCP bridge process over a WebSocket, and the bridge's MCP
// client can then list and call the page's tools. No imports beyond the registry types, so it
// runs in browsers, workers and Node alike.
import type { McpToolDefinition, McpToolResult, ToolSource } from './registry.js';

/** Protocol version spoken between `connectToolBridge` and `createToolBridge`. */
export const TOOL_BRIDGE_PROTOCOL = 1;

/** Default port the bridge listens on (127.0.0.1 only). */
export const TOOL_BRIDGE_DEFAULT_PORT = 4477;

/** Editor → bridge messages. */
export type ToolBridgeEditorMessage =
	| { t: 'hello'; v: number; name: string; kind?: string; tools: McpToolDefinition[] }
	| { t: 'tools'; tools: McpToolDefinition[] }
	| { t: 'result'; id: string; result: McpToolResult };

/** Bridge → editor messages. */
export type ToolBridgeServerMessage =
	| { t: 'welcome'; v: number; id: string }
	| { t: 'call'; id: string; name: string; arguments: Record<string, unknown> }
	| { t: 'cancel'; id: string; reason?: string };

export type ToolBridgeStatus = 'connecting' | 'connected' | 'disconnected' | 'closed';

/** The parts of a WebSocket the client uses (the browser's, Node's global one, or `ws`). */
export interface ToolBridgeSocket {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: any) => void): void;
}

export interface ConnectToolBridgeOptions {
	/** Bridge URL (default `ws://127.0.0.1:4477`). */
	url?: string;
	/** The bridge's token, if it was started with one (sent as `?token=`). */
	token?: string;
	/** How this editor is listed to the agent (`list_editors`), e.g. "Diagram — Order flow". */
	name: string;
	/** What kind of editor this is ("diagram", "chart", "document"…), shown in `list_editors`. */
	kind?: string;
	/** Reconnect after the bridge goes away (default true), backing off up to 10 s. */
	reconnect?: boolean;
	/** WebSocket constructor (default: the global one). */
	WebSocket?: new (url: string) => ToolBridgeSocket;
	/** Called when the connection state changes. */
	onStatus?: (status: ToolBridgeStatus, detail?: string) => void;
}

export interface ToolBridgeConnection {
	readonly status: ToolBridgeStatus;
	/** The id the bridge gave this editor (`list_editors`), once connected. */
	readonly editorId: string | null;
	/** Disconnects and stops reconnecting; running calls are aborted. */
	close(): void;
}

/**
 * Connects a `ToolRegistry` (or a `registry.view()` of it) to a local MCP bridge (`createToolBridge` /
 * `pixerate-mcp-bridge`), so an MCP client (Claude Desktop, Claude Code, an IDE) can call
 * the page's tools: the registry's tool list is sent on connect and whenever it changes,
 * calls run through `registry.callTool` with an `AbortSignal` the bridge cancels, and the
 * connection comes back after the bridge restarts.
 */
export function connectToolBridge(registry: ToolSource, options: ConnectToolBridgeOptions): ToolBridgeConnection {
	const Ctor = options.WebSocket ?? (globalThis as { WebSocket?: new (url: string) => ToolBridgeSocket }).WebSocket;
	if (!Ctor) throw new Error('No WebSocket implementation: pass options.WebSocket.');
	const base = options.url ?? `ws://127.0.0.1:${TOOL_BRIDGE_DEFAULT_PORT}`;
	const url = options.token ? `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(options.token)}` : base;
	let status: ToolBridgeStatus = 'connecting';
	let editorId: string | null = null;
	let socket: ToolBridgeSocket | null = null;
	let closed = false;
	let delay = 500;
	let retry: ReturnType<typeof setTimeout> | null = null;
	const running = new Map<string, AbortController>();
	const setStatus = (next: ToolBridgeStatus, detail?: string) => {
		if (next === status && !detail) return;
		status = next;
		options.onStatus?.(next, detail);
	};
	const send = (message: ToolBridgeEditorMessage) => {
		if (socket && socket.readyState === 1) socket.send(JSON.stringify(message));
	};
	const unsubscribe = registry.onListChanged((tools) => send({ t: 'tools', tools }));

	const open = () => {
		if (closed) return;
		setStatus('connecting');
		const ws = new Ctor(url);
		socket = ws;
		ws.addEventListener('open', () => {
			delay = 500;
			send({ t: 'hello', v: TOOL_BRIDGE_PROTOCOL, name: options.name, ...(options.kind ? { kind: options.kind } : {}), tools: registry.listTools().tools });
		});
		ws.addEventListener('message', (event: { data: unknown }) => {
			let message: ToolBridgeServerMessage;
			try {
				message = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (message.t === 'welcome') {
				editorId = message.id;
				setStatus('connected');
			} else if (message.t === 'call') {
				const controller = new AbortController();
				running.set(message.id, controller);
				void registry.callTool(message.name, message.arguments ?? {}, { signal: controller.signal }).then((result) => {
					running.delete(message.id);
					if (!controller.signal.aborted) send({ t: 'result', id: message.id, result });
				});
			} else if (message.t === 'cancel') {
				running.get(message.id)?.abort(message.reason ?? 'Cancelled by the agent.');
				running.delete(message.id);
			}
		});
		ws.addEventListener('close', (event: { code?: number; reason?: string }) => {
			if (socket !== ws) return;
			socket = null;
			editorId = null;
			for (const controller of running.values()) controller.abort('The bridge disconnected.');
			running.clear();
			if (closed) return setStatus('closed');
			setStatus('disconnected', event.reason || undefined);
			if (options.reconnect === false) return;
			retry = setTimeout(open, delay);
			delay = Math.min(10_000, delay * 2);
		});
		// Errors are followed by `close`, which handles reconnecting.
		ws.addEventListener('error', () => {});
	};
	open();

	return {
		get status() {
			return status;
		},
		get editorId() {
			return editorId;
		},
		close() {
			if (closed) return;
			closed = true;
			if (retry) clearTimeout(retry);
			unsubscribe();
			for (const controller of running.values()) controller.abort('The editor disconnected.');
			running.clear();
			const ws = socket;
			socket = null;
			ws?.close(1000, 'Editor closed.');
			setStatus('closed');
		}
	};
}
