/**
 * Model eval: does Claude pick the right tool from the full built-in catalogue (~470 tools),
 * and what does each way of exposing them cost? Calls the Claude API, so it is not part of
 * `pnpm test`. Run it on purpose:
 *
 *   pnpm --filter @pixerate/editor eval:tools
 *
 * Env: ANTHROPIC_API_KEY (or an `ant auth login` profile), EVAL_MODES (comma list of
 * full, scoped, discovery; default all), EVAL_CASES (number of cases; default all),
 * EVAL_MODEL (default claude-opus-5-5), EVAL_OUT (write the JSON report to this path).
 *
 * Modes, for each task in fixtures/tool-selection-cases.ts:
 * - full: every tool listed up front (the tool definitions are cached between tasks).
 * - scoped: only the toolsets that hold a right answer, as a host scoping to the open editor would.
 * - discovery: `registry.view({ discovery })`; the model starts with list_toolsets /
 *   search_tools / enable_tools / disable_tools, and the tool list is refreshed after each turn
 *   as an MCP client does on `list_changed`.
 * A task passes when the first editor tool (not a discovery tool) the model calls is one of
 * its right answers. Nothing is executed beyond the discovery tools.
 */
import Anthropic from '@anthropic-ai/sdk';
import { JSDOM } from 'jsdom';
import { writeFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { TOOL_DISCOVERY_TOOLS, type McpToolDefinition, type ToolSource } from '../../src/tools';
import { createToolCatalogue } from '../fixtures/tool-catalogue';
import { HELD_OUT_CASES, TOOL_SELECTION_CASES, type ToolSelectionCase } from '../fixtures/tool-selection-cases';

const dom = new JSDOM();
globalThis.document = dom.window.document as any;
globalThis.window = dom.window as any;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).DOMParser = dom.window.DOMParser;

type Mode = 'full' | 'scoped' | 'discovery';
const MODES = (process.env.EVAL_MODES ?? 'full,scoped,discovery').split(',').map((m) => m.trim()) as Mode[];
const MODEL = process.env.EVAL_MODEL ?? 'claude-opus-5-5';
const ALL_CASES = [...TOOL_SELECTION_CASES, ...HELD_OUT_CASES];
const CASES = ALL_CASES.slice(0, Number(process.env.EVAL_CASES ?? ALL_CASES.length));
const MAX_TURNS = 6;
const CONCURRENCY = 4;

const SYSTEM =
	"You operate the editors open in the user's app through tools. For the user's task, call the one editor tool that performs it directly. " +
	'Do not read state first: assume any ids, positions or values you need are known and use plausible placeholders. ' +
	'If the tool you need is not in your list, find it with the discovery tools first.';

const DISCOVERY = new Set<string>(TOOL_DISCOVERY_TOOLS);

interface CaseResult {
	task: string;
	mode: Mode;
	pass: boolean;
	picked: string | null;
	expect: string[];
	turns: number;
	inputTokens: number;
	outputTokens: number;
	toolsListed: number;
	error?: string;
	/** What the model said when it stopped without calling an editor tool. */
	reply?: string;
}

/**
 * The SDK refuses to run where it sees a browser (`window`), and the rich text editor in the
 * catalogue needs jsdom's. This is Node, so hide jsdom's `window` while the client is made.
 */
function createClient(): Anthropic {
	const win = (globalThis as any).window;
	delete (globalThis as any).window;
	try {
		return new Anthropic();
	} finally {
		(globalThis as any).window = win;
	}
}

const toApiTool = (def: McpToolDefinition): Anthropic.Beta.BetaTool => ({
	name: def.name,
	description: def.description ?? def.title ?? def.name,
	input_schema: def.inputSchema as Anthropic.Beta.BetaTool.InputSchema
});

/** The tool list for a request, with the cache breakpoint on the last tool so the definitions are reused across tasks. */
function apiTools(defs: readonly McpToolDefinition[]): Anthropic.Beta.BetaTool[] {
	const tools = defs.map(toApiTool);
	if (tools.length > 0) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } };
	return tools;
}

async function runCase(client: Anthropic, source: ToolSource, mode: Mode, c: ToolSelectionCase): Promise<CaseResult> {
	const result: CaseResult = { task: c.task, mode, pass: false, picked: null, expect: c.expect, turns: 0, inputTokens: 0, outputTokens: 0, toolsListed: 0 };
	const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: c.task }];
	for (let turn = 0; turn < MAX_TURNS; turn++) {
		const defs = source.listTools().tools;
		result.toolsListed = Math.max(result.toolsListed, defs.length);
		const response = await client.beta.messages.create({
			model: MODEL,
			max_tokens: 16000,
			// Refusals fall back server-side to a model picked by category.
			betas: ['server-side-fallback-2026-07-01'],
			fallbacks: 'default',
			output_config: { effort: 'medium' },
			system: SYSTEM,
			tools: apiTools(defs),
			tool_choice: { type: 'auto' },
			messages
		} as Anthropic.Beta.MessageCreateParamsNonStreaming);
		result.turns++;
		const usage = response.usage;
		result.inputTokens += usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
		result.outputTokens += usage.output_tokens;
		if (response.stop_reason === 'refusal') {
			result.error = `refusal (${response.stop_details?.category ?? 'no category'})`;
			return result;
		}
		const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
		if (uses.length === 0) {
			result.error = 'no tool call';
			const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
			if (text) result.reply = text.slice(0, 600);
			return result;
		}
		const editorCall = uses.find((u) => !DISCOVERY.has(u.name));
		if (editorCall) {
			result.picked = source.getTool(editorCall.name)?.name ?? editorCall.name;
			result.pass = c.expect.includes(result.picked);
			return result;
		}
		// Only discovery calls: run them, then continue with the refreshed tool list.
		messages.push({ role: 'assistant', content: response.content });
		const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];
		for (const use of uses) {
			const out = await source.callTool(use.name, use.input as Record<string, unknown>);
			const text = out.content.map((part) => ('text' in part ? String(part.text) : '')).join('\n');
			toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: text, ...(out.isError ? { is_error: true } : {}) });
		}
		messages.push({ role: 'user', content: toolResults });
	}
	result.error = `no editor tool within ${MAX_TURNS} turns`;
	return result;
}

async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i]);
			}
		})
	);
	return out;
}

describe('tool selection by a model', () => {
	it(
		'picks the right tool with each way of exposing the catalogue',
		async () => {
			const client = createClient();
			const { registry, dispose } = createToolCatalogue();
			const setOf = (name: string) => registry.toolsets().find((s) => s.tools.includes(name))!.name;
			const results: CaseResult[] = [];
			try {
				for (const mode of MODES) {
					// Full mode runs one case first, so the rest read the cached tool definitions.
					const run = (c: ToolSelectionCase) => {
						const source: ToolSource =
							mode === 'full'
								? registry
								: mode === 'scoped'
									? registry.view({ toolsets: [...new Set(c.expect.map(setOf))] })
									: registry.view({ discovery: true });
						return runCase(client, source, mode, c).catch((error) => ({
							task: c.task, mode, pass: false, picked: null, expect: c.expect, turns: 0, inputTokens: 0, outputTokens: 0, toolsListed: 0,
							error: error instanceof Anthropic.APIError ? `API ${error.status}: ${error.message}` : String(error)
						}));
					};
					const [first, ...rest] = CASES;
					results.push(await run(first), ...(await pool(rest, CONCURRENCY, run)));
				}
			} finally {
				dispose();
			}

			const summary = MODES.map((mode) => {
				const rows = results.filter((r) => r.mode === mode);
				const n = rows.length;
				return {
					mode,
					accuracy: +(rows.filter((r) => r.pass).length / n).toFixed(3),
					avgInputTokens: Math.round(rows.reduce((s, r) => s + r.inputTokens, 0) / n),
					avgOutputTokens: Math.round(rows.reduce((s, r) => s + r.outputTokens, 0) / n),
					avgTurns: +(rows.reduce((s, r) => s + r.turns, 0) / n).toFixed(2),
					avgToolsListed: Math.round(rows.reduce((s, r) => s + r.toolsListed, 0) / n),
					errors: rows.filter((r) => r.error).length
				};
			});
			console.table(summary);
			for (const r of results.filter((r) => !r.pass)) {
				console.log(`[${r.mode}] ${r.task}\n    picked ${r.picked ?? '-'}${r.error ? ` (${r.error})` : ''}; want ${r.expect.join(' | ')}${r.reply ? `\n    said: ${r.reply.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
			}
			if (process.env.EVAL_OUT) writeFileSync(process.env.EVAL_OUT, JSON.stringify({ model: MODEL, summary, results }, null, 2));
			expect(results.length).toBe(MODES.length * CASES.length);
			// A run where every call failed (bad key, no credits) measured nothing.
			for (const row of summary) expect(row.errors, `${row.mode}: every task errored`).toBeLessThan(CASES.length);
		},
		60 * 60 * 1000
	);
});
