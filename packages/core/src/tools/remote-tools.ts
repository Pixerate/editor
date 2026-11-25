// The bridge half of the tool bridge protocol, without a transport: the tools of editors that
// are reached some other way (a WebSocket in `createToolBridge`, a relay through a database for
// a server), forwarded as one toolset with an `editor` argument and `list_editors`.
import type { AgentTool, AgentToolProvider, McpToolDefinition, McpToolResult } from './registry.js';
import type { JsonSchema } from './schema.js';
import type { ToolCallRequest } from './tool-host.js';

/** An editor whose tools are forwarded (what its `hello` / `tools` messages said). */
export interface RemoteToolEditor {
	id: string;
	name: string;
	kind?: string;
	tools: readonly McpToolDefinition[];
	/** When it last connected or answered a call (epoch ms), for `list_editors`. */
	activeAt?: number;
	/** Picks the default editor: the highest wins. Default: `activeAt`. */
	activity?: number;
}

/** An editor as `list_editors` reports it. */
export interface RemoteToolEditorInfo {
	id: string;
	name: string;
	kind?: string;
	tools: number;
	/** Seconds since the editor last connected or answered a call. */
	idleSeconds: number;
}

export interface RemoteToolProviderOptions {
	/** Provider id. Default `bridge`. Forwarded tools keep the names their editors gave them. */
	id?: string;
	/** The editors reachable now. */
	editors(): readonly RemoteToolEditor[];
	/** Sends a call to an editor and resolves with its result. Rejections become `isError` results. */
	call(editor: RemoteToolEditor, request: ToolCallRequest, context: { signal?: AbortSignal }): Promise<McpToolResult>;
	/** While it returns a message, every tool fails with it (e.g. the bridge could not listen). */
	unavailable?(): string | null;
	/** Said when no editor is reachable. Default: ask the user to open the app. */
	noEditorsMessage?: string | (() => string);
	/** Lets the provider signal that the editors or their tools changed. */
	subscribe?(notify: () => void): () => void;
	now?(): number;
}

const EDITOR_ARG: JsonSchema = {
	type: 'string',
	description: 'Editor id or part of its name, from list_editors. Default: the most recently active editor that has this tool.'
};

/** The forwarded tools and `list_editors` for a set of remote editors (see `RemoteToolProviderOptions`). */
export function createRemoteToolProvider(options: RemoteToolProviderOptions): AgentToolProvider {
	const now = options.now ?? Date.now;
	const noEditors = () => {
		const message = options.noEditorsMessage;
		return (typeof message === 'function' ? message() : message) ?? 'No editor is connected. Ask the user to open the app and connect it.';
	};
	const ensureAvailable = () => {
		const reason = options.unavailable?.();
		if (reason) throw new Error(reason);
	};
	const describe = (editors: readonly RemoteToolEditor[]) => editors.map((e) => `${e.id} (${e.name})`).join(', ');
	const activity = (e: RemoteToolEditor) => e.activity ?? e.activeAt ?? 0;

	function pickEditor(tool: string, ref: unknown): RemoteToolEditor {
		ensureAvailable();
		const all = [...options.editors()];
		if (!all.length) throw new Error(noEditors());
		const having = all.filter((e) => e.tools.some((t) => t.name === tool));
		if (typeof ref === 'string' && ref) {
			const byId = all.find((e) => e.id === ref);
			const matches = byId ? [byId] : all.filter((e) => e.name.toLowerCase().includes(ref.toLowerCase()));
			if (matches.length !== 1) throw new Error(`No single editor matches "${ref}". Connected: ${describe(all)}.`);
			const editor = matches[0]!;
			if (!editor.tools.some((t) => t.name === tool))
				throw new Error(`${editor.id} (${editor.name}) has no tool "${tool}"${having.length ? `; ${having.map((e) => e.id).join(', ')} do` : ''}.`);
			return editor;
		}
		if (!having.length) throw new Error(`No connected editor has the tool "${tool}". Connected: ${describe(all)}.`);
		return having.sort((a, b) => activity(b) - activity(a))[0]!;
	}

	const infos = (): RemoteToolEditorInfo[] =>
		options.editors().map((e) => ({
			id: e.id,
			name: e.name,
			...(e.kind ? { kind: e.kind } : {}),
			tools: e.tools.length,
			idleSeconds: Math.max(0, Math.round((now() - (e.activeAt ?? now())) / 1000))
		}));

	const listEditors: AgentTool = {
		name: 'list_editors',
		title: 'List connected editors',
		description:
			'Lists the editors open in a browser and connected here: id, name, kind, how many tools each has and how long since it was last active. Pass an id or part of a name as `editor` to other tools to pick one.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'List connected editors', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: () => {
			ensureAvailable();
			return { editors: infos() };
		}
	};

	/** One tool per name across editors; the first editor's definition wins, with `editor` added. */
	const forwardedTools = (): AgentTool[] => {
		const seen = new Map<string, McpToolDefinition>();
		for (const editor of options.editors()) for (const tool of editor.tools) if (!seen.has(tool.name) && tool.name !== 'list_editors') seen.set(tool.name, tool);
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
					return options.call(editor, { name: tool.name, arguments: rest }, context.signal ? { signal: context.signal } : {});
				}
			} as AgentTool;
		});
	};

	return {
		id: options.id ?? 'bridge',
		// Forwarded tools keep the names their editors gave them.
		namespace: '',
		tools: () => [listEditors, ...forwardedTools()],
		...(options.subscribe ? { subscribe: options.subscribe } : {})
	};
}
