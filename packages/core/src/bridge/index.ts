/// <reference types="node" />
/**
 * `@pixerate/editor/bridge` (Node only): one MCP server process that drives editors open in
 * browser tabs. The MCP client (Claude Desktop, Claude Code, an IDE) talks MCP over stdio;
 * pages connect their `ToolRegistry` over a localhost WebSocket with `connectToolBridge`
 * (`@pixerate/editor/tools`) and answer the calls. The bridge forwards every tool the pages
 * expose, adds an `editor` argument to pick one when several are open, and `list_editors`.
 *
 * Only 127.0.0.1 is listened on; browser origins must be local (or allowed explicitly), and
 * an optional token keeps other local pages out. MCP `notifications/cancelled` cancels the
 * call in the page. Ported from Ursula's `createRemoteBridge`, built on `createMcpServer`.
 *
 * ```ts
 * import { createToolBridge } from "@pixerate/editor/bridge";
 * await createToolBridge({ name: "my-app", token: process.env.BRIDGE_TOKEN });
 * ```
 *
 * or run `npx pixerate-mcp-bridge --token <secret>` and add it to the MCP client's config.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { createInterface } from 'node:readline';
import { TOOL_BRIDGE_DEFAULT_PORT, TOOL_BRIDGE_PROTOCOL, type ToolBridgeEditorMessage, type ToolBridgeServerMessage } from '../tools/bridge-client.js';
import { createMcpServer, type JsonRpcNotification, type JsonRpcResponse, type McpServer } from '../tools/mcp-server.js';
import { ToolRegistry, type AgentTool, type McpToolDefinition, type McpToolResult } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import type { SkillFiles } from '../tools/skills.js';
import { loadSkillFiles } from './skills.js';
import { acceptWebSocket, rejectUpgrade, wrapWebSocket, type BridgeSocket } from './websocket.js';

export { loadSkillFiles, defaultSkillsDir } from './skills.js';

export { TOOL_BRIDGE_DEFAULT_PORT, TOOL_BRIDGE_PROTOCOL } from '../tools/bridge-client.js';

export interface ToolBridgeOptions {
	/** The MCP server's name. */
	name: string;
	version?: string;
	/** Said to the model in the MCP `initialize` result, before the bridge's own usage notes. */
	instructions?: string;
	/** WebSocket port editors connect to (default 4477; 0 picks a free one). */
	port?: number;
	/** Shared secret pages must send as `?token=`. Recommended: any local page can otherwise connect. */
	token?: string;
	/** Browser origins allowed besides localhost ones (e.g. "https://app.example.com"). */
	origins?: readonly string[];
	/** How long a page has to answer a call (ms, default 60 000). */
	timeoutMs?: number;
	/**
	 * While another process holds the port, how often to try again (ms, default 2000; 0 never).
	 * Until it gets the port, tools say why.
	 */
	retryMs?: number;
	/**
	 * Where MCP messages come from and go to. Default: stdio (one JSON message per line on
	 * stdin / stdout). `false` serves no transport; call `bridge.mcp.handle` yourself.
	 */
	stdio?: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } | false;
	/** Diagnostics (default: stderr, since stdout carries MCP). */
	log?: (message: string) => void;
	/**
	 * Agent skills served as MCP resources and prompts (default: the skills shipped with the
	 * package, from `loadSkillFiles()`); `false` serves none.
	 */
	skills?: SkillFiles | false;
}

/** An editor as `list_editors` reports it. */
export interface ToolBridgeEditorInfo {
	id: string;
	name: string;
	kind?: string;
	tools: number;
	/** Seconds since the editor last connected or answered a call. */
	idleSeconds: number;
}

export interface ToolBridge {
	/** The WebSocket port editors connect to. */
	readonly port: number;
	/** The MCP server (handle messages yourself when `stdio` is false). */
	readonly mcp: McpServer;
	/** The registry the MCP server serves: `list_editors` plus every tool the pages expose. */
	readonly registry: ToolRegistry;
	/** The connected editors. */
	editors(): ToolBridgeEditorInfo[];
	/** Stops listening, disconnects editors, fails pending calls and closes MCP. */
	close(): Promise<void>;
}

interface Editor {
	id: string;
	name: string;
	kind?: string;
	socket: BridgeSocket;
	tools: McpToolDefinition[];
	activeAt: number;
	/** Bumped on connect and on every answered call; picks the most recently active editor. */
	activeSeq: number;
}

interface Pending {
	editor: Editor;
	resolve: (result: McpToolResult) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Whether a browser origin is this machine (localhost, 127.0.0.1, [::1], *.localhost). */
export function isLocalOrigin(origin: string): boolean {
	try {
		const { hostname } = new URL(origin);
		return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
	} catch {
		return false;
	}
}

const EDITOR_ARG: JsonSchema = {
	type: 'string',
	description: 'Editor id (e.g. "e1") or part of its name, from list_editors. Default: the most recently active editor that has this tool.'
};

const BRIDGE_INSTRUCTIONS =
	'Tools come from editors open in a browser. Call list_editors to see them; when several are open, pass `editor` (an id or part of a name) to pick one, otherwise the most recently active editor that has the tool answers. If no editor is connected, ask the user to open the app and connect it to the bridge. Tool names are `<toolset>__<tool>`; when an editor offers list_toolsets and search_tools, use them to find tools that are not listed yet.';

const SKILL_INSTRUCTIONS =
	"Each editor's tools are documented by an agent skill (pixerate-chart, pixerate-video-editor, ...), served here as MCP prompts and as resources at skill://<skill>/SKILL.md. Read pixerate-agent-tools and the skill for the editor at hand before working with its tools.";

/**
 * Starts a bridge: listens for editors on 127.0.0.1 and serves their tools, plus
 * `list_editors`, over MCP. Resolves once the port is bound (or known to be taken).
 */
export async function createToolBridge(options: ToolBridgeOptions): Promise<ToolBridge> {
	const log = options.log ?? ((message: string) => process.stderr.write(`[${options.name}] ${message}\n`));
	const port = options.port ?? TOOL_BRIDGE_DEFAULT_PORT;
	const retryMs = options.retryMs ?? 2000;
	const timeoutMs = options.timeoutMs ?? 60_000;
	const extraOrigins = new Set(options.origins ?? []);
	const editors = new Map<string, Editor>();
	const pending = new Map<string, Pending>();
	let editorCounter = 0;
	let activity = 0;
	const sockets = new Set<BridgeSocket>();
	let callCounter = 0;
	let listenError: string | null = null;
	let closed = false;
	let retry: ReturnType<typeof setTimeout> | undefined;

	const send = (editor: Editor, message: ToolBridgeServerMessage) => editor.socket.send(JSON.stringify(message));
	const registry = new ToolRegistry();
	const listeners = new Set<() => void>();
	const toolsChanged = () => listeners.forEach((l) => l());

	// ---------------------------------------------------------------- routing
	const describeEditors = () => [...editors.values()].map((e) => `${e.id} (${e.name})`).join(', ');
	function pickEditor(tool: string, ref: unknown): Editor {
		if (listenError) throw new Error(listenError);
		const all = [...editors.values()];
		if (!all.length) throw new Error(`No editor is connected to ws://127.0.0.1:${actualPort()}. Ask the user to open the app and connect it to the bridge.`);
		const having = all.filter((e) => e.tools.some((t) => t.name === tool));
		if (typeof ref === 'string' && ref) {
			const byId = editors.get(ref);
			const matches = byId ? [byId] : all.filter((e) => e.name.toLowerCase().includes(ref.toLowerCase()));
			if (matches.length !== 1) throw new Error(`No single editor matches "${ref}". Connected: ${describeEditors()}.`);
			const editor = matches[0]!;
			if (!editor.tools.some((t) => t.name === tool))
				throw new Error(`${editor.id} (${editor.name}) has no tool "${tool}"${having.length ? `; ${having.map((e) => e.id).join(', ')} do` : ''}.`);
			return editor;
		}
		if (!having.length) throw new Error(`No connected editor has the tool "${tool}". Connected: ${describeEditors()}.`);
		return having.sort((a, b) => b.activeSeq - a.activeSeq)[0]!;
	}

	function call(editor: Editor, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
		const id = `c${++callCounter}`;
		return new Promise((resolve, reject) => {
			const giveUp = (reason: string) => {
				if (!pending.delete(id)) return;
				clearTimeout(timer);
				send(editor, { t: 'cancel', id, reason });
				reject(new Error(reason));
			};
			const timer = setTimeout(() => giveUp(`${editor.id} (${editor.name}) did not answer within ${Math.round(timeoutMs / 1000)} s (is its tab in the background?).`), timeoutMs);
			pending.set(id, { editor, resolve, reject, timer });
			signal?.addEventListener('abort', () => giveUp('Cancelled.'), { once: true });
			send(editor, { t: 'call', id, name, arguments: args });
		});
	}

	const listEditors: AgentTool = {
		name: 'list_editors',
		title: 'List connected editors',
		description:
			'Lists the editors open in a browser and connected to this bridge: id, name, kind, how many tools each has and how long since it was last active. Pass an id or part of a name as `editor` to other tools to pick one.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'List connected editors', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: () => {
			if (listenError) throw new Error(listenError);
			return { editors: infos() };
		}
	};

	/** One tool per name across editors; the first editor's definition wins, with `editor` added. */
	const forwardedTools = (): AgentTool[] => {
		const seen = new Map<string, McpToolDefinition>();
		for (const editor of editors.values()) for (const tool of editor.tools) if (!seen.has(tool.name) && tool.name !== 'list_editors') seen.set(tool.name, tool);
		return [...seen.values()].map((tool) => {
			const schema = tool.inputSchema as JsonSchema & { properties?: Record<string, JsonSchema> };
			return {
				...tool,
				title: tool.title ?? tool.annotations?.title ?? tool.name,
				description: tool.description ?? tool.name,
				inputSchema: { ...schema, type: 'object', properties: { editor: EDITOR_ARG, ...(schema.properties ?? {}) } },
				handler: async (args: Record<string, any>, context: { signal?: AbortSignal }) => {
					const { editor: ref, ...rest } = args;
					const editor = pickEditor(tool.name, ref);
					const result = await call(editor, tool.name, rest, context.signal);
					editor.activeAt = Date.now();
					editor.activeSeq = ++activity;
					return result;
				}
			} as AgentTool;
		});
	};

	registry.register({
		id: 'bridge',
		// Forwarded tools keep the names their pages gave them.
		namespace: '',
		tools: () => [listEditors, ...forwardedTools()],
		subscribe: (notify) => {
			listeners.add(notify);
			return () => listeners.delete(notify);
		}
	});

	const infos = (): ToolBridgeEditorInfo[] =>
		[...editors.values()].map((e) => ({ id: e.id, name: e.name, ...(e.kind ? { kind: e.kind } : {}), tools: e.tools.length, idleSeconds: Math.round((Date.now() - e.activeAt) / 1000) }));

	// ------------------------------------------------------------- WebSocket
	const http: HttpServer = createServer((_req, res) => {
		res.writeHead(426, { 'Content-Type': 'text/plain' });
		res.end('This is a WebSocket endpoint for editors (connectToolBridge).');
	});
	http.on('upgrade', (req, socket) => {
		const origin = req.headers.origin;
		// No origin: not a browser (a local script, a test). Browsers always send one.
		if (origin && !extraOrigins.has(origin) && !isLocalOrigin(origin)) {
			log(`refused an editor from ${origin}`);
			return rejectUpgrade(socket, 403, 'Origin not allowed');
		}
		if (options.token) {
			const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
			if (token !== options.token) {
				log('refused an editor with a wrong token');
				return rejectUpgrade(socket, 401, 'Bad token');
			}
		}
		if (!acceptWebSocket(req, socket)) return;
		const ws = wrapWebSocket(socket);
		sockets.add(ws);
		let editor: Editor | null = null;
		ws.onMessage((text) => {
			let message: ToolBridgeEditorMessage;
			try {
				message = JSON.parse(text);
			} catch {
				return;
			}
			if (message.t === 'hello') {
				if (message.v !== TOOL_BRIDGE_PROTOCOL) {
					log(`refused an editor speaking protocol v${String(message.v)}`);
					return ws.close(1008, `This bridge speaks protocol v${TOOL_BRIDGE_PROTOCOL}; update @pixerate/editor.`);
				}
				editor = { id: `e${++editorCounter}`, name: String(message.name || 'Editor'), ...(message.kind ? { kind: message.kind } : {}), socket: ws, tools: Array.isArray(message.tools) ? message.tools : [], activeAt: Date.now(), activeSeq: ++activity };
				editors.set(editor.id, editor);
				ws.send(JSON.stringify({ t: 'welcome', v: TOOL_BRIDGE_PROTOCOL, id: editor.id } satisfies ToolBridgeServerMessage));
				log(`editor ${editor.id} connected: ${editor.name} (${editor.tools.length} tools)`);
				toolsChanged();
			} else if (message.t === 'tools' && editor) {
				editor.tools = Array.isArray(message.tools) ? message.tools : [];
				toolsChanged();
			} else if (message.t === 'result') {
				const waiting = pending.get(message.id);
				if (!waiting || waiting.editor !== editor) return;
				pending.delete(message.id);
				clearTimeout(waiting.timer);
				waiting.resolve(message.result);
			}
		});
		ws.onClose(() => {
			sockets.delete(ws);
			if (!editor) return;
			editors.delete(editor.id);
			for (const [id, waiting] of pending) {
				if (waiting.editor !== editor) continue;
				pending.delete(id);
				clearTimeout(waiting.timer);
				waiting.reject(new Error(`${editor.id} (${editor.name}) disconnected before answering.`));
			}
			log(`editor ${editor.id} disconnected`);
			toolsChanged();
		});
	});

	const actualPort = () => {
		const address = http.address();
		return address && typeof address === 'object' ? address.port : port;
	};
	const listen = () => http.listen(port, '127.0.0.1');
	const listening = new Promise<void>((resolve) => {
		http.on('listening', () => {
			if (listenError) log(`port ${port} is free now`);
			listenError = null;
			log(`waiting for editors on ws://127.0.0.1:${actualPort()}`);
			resolve();
		});
		http.on('error', (error: NodeJS.ErrnoException) => {
			const taken = error.code === 'EADDRINUSE';
			const again = taken && retryMs > 0 && !closed;
			const message = taken
				? `Port ${port} is in use (another bridge?). ${again ? 'This bridge keeps trying it; editors can connect once it is free. Or start' : 'Start'} this one on another port.`
				: String(error);
			if (message !== listenError) log(message);
			listenError = message;
			if (again) retry = setTimeout(listen, retryMs);
			// Still serve MCP, so the agent hears why nothing connects.
			resolve();
		});
	});
	listen();

	// ------------------------------------------------------------------- MCP
	let output: NodeJS.WritableStream | null = null;
	const write = (message: JsonRpcResponse | JsonRpcNotification) => output?.write(`${JSON.stringify(message)}\n`);
	const skills = options.skills === false ? {} : options.skills ?? loadSkillFiles();
	const hasSkills = Object.keys(skills).length > 0;
	const mcp = createMcpServer(registry, {
		name: options.name,
		version: options.version ?? '0.1.0',
		instructions: [options.instructions, BRIDGE_INSTRUCTIONS, hasSkills ? SKILL_INSTRUCTIONS : ''].filter(Boolean).join('\n\n'),
		...(hasSkills ? { skills } : {}),
		send: write
	});
	let lines: ReturnType<typeof createInterface> | null = null;
	if (options.stdio !== false) {
		const io = options.stdio ?? { input: process.stdin, output: process.stdout };
		output = io.output;
		lines = createInterface({ input: io.input });
		lines.on('line', (line) => {
			if (!line.trim()) return;
			void mcp.handle(line).then((response) => {
				if (response) write(response);
			});
		});
	}
	await listening;

	return {
		get port() {
			return actualPort();
		},
		mcp,
		registry,
		editors: infos,
		async close() {
			closed = true;
			clearTimeout(retry);
			for (const [id, waiting] of pending) {
				clearTimeout(waiting.timer);
				waiting.reject(new Error('The bridge closed.'));
				pending.delete(id);
			}
			for (const socket of [...sockets]) socket.terminate();
			editors.clear();
			mcp.close();
			lines?.close();
			if (http.listening) {
				const done = new Promise<void>((resolve) => http.close(() => resolve()));
				http.closeAllConnections();
				await done;
			}
		}
	};
}
