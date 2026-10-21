import type { AgentTool, McpListToolsResult, McpToolDefinition, McpToolResult, ToolSource, ToolsetInfo } from './registry.js';
import { baseToolName, errorResult, toToolResult, unknownToolMessage } from './registry.js';
import { validateJsonSchema } from './schema.js';
import { searchTools } from './search.js';
import { listSkills, readSkillFile, type SkillFiles } from './skills.js';

export interface ToolDiscoveryOptions {
	/** Toolsets listed from the start (default none: the agent enables what it needs). */
	enabled?: readonly string[];
	/** Skill files `get_skill` serves (see {@link SkillFiles}). Without them there is no `get_skill`. */
	skills?: SkillFiles;
	/** Default and maximum number of `search_tools` results (default 10, at most 50). */
	searchLimit?: number;
}

export interface ToolViewOptions {
	/**
	 * Toolsets the agent may see and call (names from `registry.toolsets()`), or a
	 * predicate. Default: all. Change it later with `setToolsets`, e.g. to follow
	 * the focused editor.
	 */
	toolsets?: readonly string[] | ((toolset: ToolsetInfo) => boolean);
	/** Only expose tools annotated `readOnlyHint: true`; write tools are refused with the reason. */
	readOnly?: boolean;
	/**
	 * Serve discovery tools (`list_toolsets`, `search_tools`, `enable_tools`,
	 * `disable_tools` and, with skills, `get_skill`) and list only the toolsets
	 * and tools that are enabled, so a large catalogue costs the agent a handful
	 * of tool definitions until it asks for more. Tools that are allowed but not
	 * enabled can still be called by name.
	 */
	discovery?: boolean | ToolDiscoveryOptions;
}

/** Names of the tools a discovery view adds. */
export const TOOL_DISCOVERY_TOOLS = ['list_toolsets', 'search_tools', 'enable_tools', 'disable_tools', 'get_skill'] as const;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const LISTING = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const SELECTION_SCHEMA = {
	type: 'object',
	properties: {
		tools: {
			type: 'array',
			items: { type: 'string', minLength: 1 },
			uniqueItems: true,
			description: 'Exposed tool names, as `search_tools` returns them (e.g. "chart__add_chart_trendline"). Default: none.'
		},
		toolsets: {
			type: 'array',
			items: { type: 'string', minLength: 1 },
			uniqueItems: true,
			description: 'Toolset names from `list_toolsets` (e.g. "chart"); covers every tool in each. Default: none.'
		}
	},
	additionalProperties: false
} as const;

interface Catalogue {
	/** Tool definitions the view allows, in listing order. */
	tools: McpToolDefinition[];
	/** Allowed toolsets, each with only its allowed tools. */
	sets: ToolsetInfo[];
	setOf: Map<string, ToolsetInfo>;
}

/**
 * A filtered view of a {@link ToolSource} (usually a `ToolRegistry`, from
 * `registry.view()`) that is itself a `ToolSource`, so `createMcpServer`,
 * `connectToolBridge` and further views accept it.
 *
 * - **Scope** an agent to some toolsets (`toolsets`) or to read tools
 *   (`readOnly`). Tools outside the scope are neither listed nor callable.
 * - **Discover** (`discovery`): list only what the agent enabled, plus tools to
 *   browse and search the rest and to enable it. `listChanged` fires whenever
 *   the listing changes.
 */
export class ToolRegistryView implements ToolSource {
	readonly capabilities = { tools: { listChanged: true } } as const;

	private allow: ToolViewOptions['toolsets'];
	private readonly readOnly: boolean;
	private readonly discovery: ToolDiscoveryOptions | null;
	private readonly enabledSets = new Set<string>();
	private readonly enabledTools = new Set<string>();
	private readonly listeners = new Set<(tools: McpToolDefinition[]) => void>();
	private readonly meta: AgentTool[];
	private unsubscribe: (() => void) | null = null;
	private lastSignature = '';

	constructor(
		private readonly source: ToolSource,
		options: ToolViewOptions = {}
	) {
		this.allow = options.toolsets;
		this.readOnly = options.readOnly ?? false;
		this.discovery = options.discovery ? (options.discovery === true ? {} : options.discovery) : null;
		for (const name of this.discovery?.enabled ?? []) this.enabledSets.add(name);
		this.meta = this.discovery ? this.createDiscoveryTools() : [];
	}

	/** Changes which toolsets the agent may use (`undefined`: all). Fires `listChanged` if the listing changes. */
	setToolsets(toolsets: ToolViewOptions['toolsets']): void {
		this.allow = toolsets;
		this.changed();
	}

	/**
	 * Lists more tools in a discovery view, as the `enable_tools` tool does.
	 * Throws for names the view does not allow. Returns the tool names newly listed.
	 */
	enableTools(selection: { tools?: readonly string[]; toolsets?: readonly string[] }): string[] {
		const cat = this.catalogue();
		const { tools, toolsets } = this.checkSelection(cat, selection);
		const before = new Set(this.listed(cat).map((t) => t.name));
		for (const name of toolsets) this.enabledSets.add(name);
		for (const name of tools) this.enabledTools.add(name);
		this.changed();
		return this.listed(cat)
			.map((t) => t.name)
			.filter((name) => !before.has(name));
	}

	/** Stops listing tools in a discovery view, as `disable_tools` does. Returns the tool names no longer listed. */
	disableTools(selection: { tools?: readonly string[]; toolsets?: readonly string[] }): string[] {
		const cat = this.catalogue();
		const { tools, toolsets } = this.checkSelection(cat, selection);
		const before = this.listed(cat).map((t) => t.name);
		for (const name of toolsets) {
			this.enabledSets.delete(name);
			for (const tool of cat.sets.find((s) => s.name === name)?.tools ?? []) this.enabledTools.delete(tool);
		}
		for (const name of tools) this.enabledTools.delete(name);
		this.changed();
		const after = new Set(this.listed(cat).map((t) => t.name));
		return before.filter((name) => !after.has(name));
	}

	/** Allowed toolsets, each with only its allowed tools. */
	toolsets(): ToolsetInfo[] {
		return this.catalogue().sets;
	}

	listTools(): McpListToolsResult {
		const cat = this.catalogue();
		return { tools: [...this.meta.map(toDefinition), ...this.listed(cat)] };
	}

	hasTool(name: string): boolean {
		return this.meta.some((t) => t.name === name) || this.find(this.catalogue(), name).found !== undefined;
	}

	getTool(name: string): McpToolDefinition | undefined {
		const meta = this.meta.find((t) => t.name === name);
		if (meta) return toDefinition(meta);
		return this.find(this.catalogue(), name).found;
	}

	async callTool(name: string, args: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {}): Promise<McpToolResult> {
		const meta = this.meta.find((t) => t.name === name);
		if (meta) {
			const details = validateJsonSchema(args ?? {}, meta.inputSchema);
			if (details.length > 0) {
				return errorResult({ code: 'invalid_arguments', message: `Invalid arguments for tool "${name}".`, tool: name, details });
			}
			try {
				return toToolResult(await meta.handler(args ?? {}, { name, providerId: 'discovery', signal: options.signal }));
			} catch (error) {
				return errorResult({ code: 'tool_failed', message: error instanceof Error ? error.message : String(error), tool: name });
			}
		}
		const cat = this.catalogue();
		const match = this.find(cat, name);
		if (match.found) return this.source.callTool(match.found.name, args, options);
		return errorResult({ code: 'unknown_tool', message: match.message, tool: name });
	}

	onListChanged(listener: (tools: McpToolDefinition[]) => void): () => void {
		if (this.listeners.size === 0) {
			this.lastSignature = this.signature();
			this.unsubscribe = this.source.onListChanged(() => this.changed());
		}
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) {
				this.unsubscribe?.();
				this.unsubscribe = null;
			}
		};
	}

	/** Stops following the source and drops every listener. */
	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.listeners.clear();
	}

	private changed(): void {
		if (this.listeners.size === 0) return;
		const signature = this.signature();
		if (signature === this.lastSignature) return;
		this.lastSignature = signature;
		const { tools } = this.listTools();
		for (const listener of Array.from(this.listeners)) listener(tools);
	}

	private signature(): string {
		return JSON.stringify(this.listTools().tools);
	}

	private allowsSet(set: ToolsetInfo): boolean {
		const allow = this.allow;
		if (!allow) return true;
		return typeof allow === 'function' ? allow(set) : allow.includes(set.name);
	}

	private catalogue(): Catalogue {
		const defs = new Map(this.source.listTools().tools.map((t) => [t.name, t]));
		const tools: McpToolDefinition[] = [];
		const sets: ToolsetInfo[] = [];
		const setOf = new Map<string, ToolsetInfo>();
		for (const set of this.source.toolsets()) {
			if (!this.allowsSet(set)) continue;
			const names = set.tools.filter((name) => {
				const def = defs.get(name);
				return def !== undefined && (!this.readOnly || def.annotations?.readOnlyHint === true);
			});
			if (names.length === 0) continue;
			const allowed = { ...set, tools: names };
			sets.push(allowed);
			for (const name of names) setOf.set(name, allowed);
		}
		// Keep the source's listing order.
		for (const def of defs.values()) if (setOf.has(def.name)) tools.push(def);
		return { tools, sets, setOf };
	}

	private listed(cat: Catalogue): McpToolDefinition[] {
		if (!this.discovery) return cat.tools;
		return cat.tools.filter((t) => this.enabledTools.has(t.name) || this.enabledSets.has(cat.setOf.get(t.name)!.name));
	}

	/** Resolves an exposed or unique bare name among the allowed tools, or explains why it isn't one. */
	private find(cat: Catalogue, name: string): { found: McpToolDefinition; message?: undefined } | { found?: undefined; message: string } {
		const exact = cat.tools.find((t) => t.name === name);
		if (exact) return { found: exact };
		const bare = cat.tools.filter((t) => baseToolName(t.name) === name);
		if (bare.length === 1) return { found: bare[0] };
		if (bare.length > 1) return { message: unknownToolMessage(name, bare.map((t) => t.name)) };
		const hidden = this.source.getTool(name);
		if (hidden) {
			const set = this.source.toolsets().find((s) => s.tools.includes(hidden.name));
			const reason =
				set && !this.allowsSet(set)
					? `its toolset "${set.name}" is not available to this agent`
					: 'it changes content and this agent has read-only access';
			return { message: `Tool "${name}" is not available: ${reason}.` };
		}
		const hint = this.discovery ? ' Call search_tools to find the right tool.' : '';
		return { message: `${unknownToolMessage(name)}${hint}` };
	}

	/** Normalizes names to exposed tool and toolset names, or throws naming every unknown one. */
	private checkSelection(cat: Catalogue, selection: { tools?: readonly string[]; toolsets?: readonly string[] }) {
		const tools: string[] = [];
		const errors: string[] = [];
		for (const name of selection.tools ?? []) {
			const match = this.find(cat, name);
			if (match.found) tools.push(match.found.name);
			else errors.push(match.message);
		}
		const toolsets: string[] = [];
		for (const name of selection.toolsets ?? []) {
			if (cat.sets.some((s) => s.name === name)) toolsets.push(name);
			else errors.push(`Unknown toolset "${name}".`);
		}
		if (errors.length > 0) {
			throw new Error(`${errors.join(' ')} Nothing was changed. Call list_toolsets or search_tools for valid names.`);
		}
		if (tools.length === 0 && toolsets.length === 0) {
			throw new Error('Pass at least one name in `tools` or `toolsets`.');
		}
		return { tools, toolsets };
	}

	private createDiscoveryTools(): AgentTool[] {
		const discovery = this.discovery!;
		const limit = Math.min(Math.max(1, discovery.searchLimit ?? 10), 50);
		const skills = discovery.skills ? listSkills(discovery.skills) : [];
		const enabledState = (set: ToolsetInfo) => {
			if (this.enabledSets.has(set.name)) return 'all';
			return set.tools.some((t) => this.enabledTools.has(t)) ? 'some' : 'none';
		};
		const listedCount = () => this.listed(this.catalogue()).length;

		const tools: AgentTool[] = [
			{
				name: 'list_toolsets',
				title: 'List toolsets',
				description:
					'Lists the groups of editor tools available here (one per open editor or feature): name, title, what it covers, its agent skill, how many tools it has and whether they are in your tool list (`enabled`: all, some or none). Start here, then call search_tools or enable_tools.',
				annotations: READ_ONLY,
				inputSchema: { type: 'object', properties: {}, additionalProperties: false },
				handler: () => {
					const cat = this.catalogue();
					return {
						toolsets: cat.sets.map((set) => ({
							name: set.name,
							...(set.title ? { title: set.title } : {}),
							...(set.description ? { description: set.description } : {}),
							...(set.skill ? { skill: set.skill } : {}),
							tools: set.tools.length,
							enabled: enabledState(set)
						})),
						...(skills.length > 0 ? { skills: skills.map((s) => s.name) } : {})
					};
				}
			},
			{
				name: 'search_tools',
				title: 'Search tools',
				description: `Finds tools for a task across every toolset, best match first: name, toolset, title, a one-sentence summary, whether it only reads, and whether it is in your tool list. Describe the task in a few words ("add a trendline", "remove background noise from audio"). Call enable_tools with the names you need, then call them.`,
				annotations: READ_ONLY,
				inputSchema: {
					type: 'object',
					properties: {
						query: { type: 'string', minLength: 1, description: 'What you want to do, in plain words or likely tool-name words.' },
						toolset: { type: 'string', minLength: 1, description: 'Only search this toolset (a name from list_toolsets). Default: all toolsets.' },
						limit: { type: 'integer', minimum: 1, maximum: 50, description: `Maximum number of results. Default: ${limit}.` }
					},
					required: ['query'],
					additionalProperties: false
				},
				handler: (args) => {
					const cat = this.catalogue();
					if (args.toolset !== undefined && !cat.sets.some((s) => s.name === args.toolset)) {
						throw new Error(`Unknown toolset "${args.toolset}". Call list_toolsets for the names.`);
					}
					const listed = new Set(this.listed(cat).map((t) => t.name));
					const results = searchTools(cat.tools, cat.sets, args.query, { toolset: args.toolset, limit: args.limit ?? limit }).map(
						(r) => ({ ...r, enabled: listed.has(r.name) })
					);
					return {
						results,
						...(results.length === 0 ? { hint: 'No tool matched. Try other words, or call list_toolsets.' } : {}),
						...(results.some((r) => !r.enabled) ? { next: 'Call enable_tools with the names you need; they are then added to your tool list.' } : {})
					};
				}
			},
			{
				name: 'enable_tools',
				title: 'Enable tools',
				description:
					'Adds tools to your tool list: single tools by name (from search_tools) and/or whole toolsets (from list_toolsets). Returns the names added and how many tools are listed now. Prefer single tools over large toolsets. Unknown names fail and change nothing.',
				annotations: LISTING,
				inputSchema: SELECTION_SCHEMA,
				handler: (args) => {
					const added = this.enableTools(args);
					return { added, listed: listedCount() };
				}
			},
			{
				name: 'disable_tools',
				title: 'Disable tools',
				description:
					'Removes tools you no longer need from your tool list, by name and/or whole toolset, to keep it short. They can still be enabled again. Returns the names removed and how many tools are listed now.',
				annotations: LISTING,
				inputSchema: SELECTION_SCHEMA,
				handler: (args) => {
					const removed = this.disableTools(args);
					return { removed, listed: listedCount() };
				}
			}
		];

		if (skills.length > 0) {
			tools.push({
				name: 'get_skill',
				title: 'Get skill',
				description:
					"Reads an agent skill: the guide to a toolset's tools (when to use each, the working method, pitfalls). Read the skill a toolset names in list_toolsets before working with it. Returns markdown; pass `file` for one of its reference files.",
				annotations: READ_ONLY,
				inputSchema: {
					type: 'object',
					properties: {
						name: { type: 'string', enum: skills.map((s) => s.name), description: 'Skill name, as list_toolsets reports it.' },
						file: { type: 'string', minLength: 1, description: 'A reference file of the skill, e.g. "references/commands.md". Default: the skill itself (SKILL.md).' }
					},
					required: ['name'],
					additionalProperties: false
				},
				handler: (args) => {
					const skill = skills.find((s) => s.name === args.name)!;
					const file = args.file ?? 'SKILL.md';
					const text = readSkillFile(discovery.skills!, skill.name, file);
					if (text === undefined) {
						const files = skill.references.length ? ` Its files: ${skill.references.join(', ')}.` : ' It has no reference files.';
						throw new Error(`Skill "${skill.name}" has no file "${file}".${files}`);
					}
					const sets = this.catalogue().sets.filter((s) => s.skill === skill.name);
					const prefixed = sets.filter((s) => s.tools.some((t) => t.startsWith(`${s.name}__`)));
					const notes: string[] = [];
					if (prefixed.length > 0) {
						notes.push(
							`> Tool names in this skill are bare. Here they are prefixed by toolset: ${prefixed.map((s) => `\`${s.name}__\``).join(', ')} (e.g. \`${prefixed[0].tools[0]}\`). A bare name also works when only one toolset has it.`
						);
					}
					if (file === 'SKILL.md' && skill.references.length > 0) {
						notes.push(`> Reference files (call get_skill with \`file\`): ${skill.references.join(', ')}.`);
					}
					return {
						content: [{ type: 'text', text: notes.length ? `${notes.join('\n')}\n\n${text}` : text }],
						structuredContent: { name: skill.name, file, toolsets: sets.map((s) => s.name), references: skill.references }
					};
				}
			});
		}
		return tools;
	}
}

function toDefinition(tool: AgentTool): McpToolDefinition {
	const { handler: _handler, ...rest } = tool;
	return rest;
}
