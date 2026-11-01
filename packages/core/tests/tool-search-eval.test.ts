/**
 * Offline eval of `search_tools` over the full built-in catalogue (~470 tools): for each task in
 * `fixtures/tool-selection-cases.ts`, is a right tool among the first results? A drop below
 * the floors means search got worse for agents; improve the ranking or the tool's title and
 * description rather than lowering them. Run with `EVAL_REPORT=1` to print every miss.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { JSDOM } from 'jsdom';
import type { ToolRegistry } from '../src/tools';
import { createToolCatalogue } from './fixtures/tool-catalogue';
import { HELD_OUT_CASES, TOOL_SELECTION_CASES, type ToolSelectionCase } from './fixtures/tool-selection-cases';

let catalogue: ReturnType<typeof createToolCatalogue>;
let registry: ToolRegistry;

beforeAll(() => {
	const dom = new JSDOM();
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
	(globalThis as any).Node = dom.window.Node;
	(globalThis as any).DOMParser = dom.window.DOMParser;
	catalogue = createToolCatalogue();
	registry = catalogue.registry;
});

afterAll(() => catalogue?.dispose());

// Each search_tools call ranks all ~580 tools afresh (about 18 ms here, ~3× that on CI), so the
// 72-task eval took up to 4.5 s of the default 5 s on CI. The work is the eval itself, so the two
// eval tests get their own timeout rather than fewer tasks.
const EVAL_TIMEOUT = 30_000;

describe('search_tools over the full catalogue', () => {
	it('every case names tools that exist', () => {
		const names = new Set(registry.listTools().tools.map((t) => t.name));
		const missing = [...TOOL_SELECTION_CASES, ...HELD_OUT_CASES].flatMap((c) =>
			c.expect.filter((name) => !names.has(name)).map((name) => `${c.task}: ${name}`)
		);
		expect(missing).toEqual([]);
	});

	it('ranks a right tool first for most tasks and in the top five for nearly all', { timeout: EVAL_TIMEOUT }, async () => {
		const { top1, top5, report } = await evaluate(TOOL_SELECTION_CASES);
		expect(top1, report).toBeGreaterThanOrEqual(0.68);
		expect(top5, report).toBeGreaterThanOrEqual(0.88);
	});

	it('does about as well on tasks it was not tuned on', { timeout: EVAL_TIMEOUT }, async () => {
		const { top5, report } = await evaluate(HELD_OUT_CASES);
		expect(top5, report).toBeGreaterThanOrEqual(0.75);
	});
});

async function evaluate(cases: ToolSelectionCase[]) {
	const view = registry.view({ discovery: true });
	let top1 = 0;
	let top5 = 0;
	let reciprocal = 0;
	const misses: string[] = [];
	for (const c of cases) {
		const result = await view.callTool('search_tools', { query: c.task, limit: 10 });
		const names: string[] = (result.structuredContent as any).results.map((r: any) => r.name);
		const rank = names.findIndex((name) => c.expect.includes(name));
		if (rank === 0) top1++;
		if (rank >= 0 && rank < 5) top5++;
		if (rank >= 0) reciprocal += 1 / (rank + 1);
		if (rank !== 0) misses.push(`${rank === -1 ? '—' : `#${rank + 1}`}  ${c.task}\n      want ${c.expect.join(' | ')}\n      got  ${names.slice(0, 3).join(', ')}`);
	}
	const n = cases.length;
	const report = `top-1 ${(top1 / n).toFixed(2)}, top-5 ${(top5 / n).toFixed(2)}, MRR ${(reciprocal / n).toFixed(2)} over ${n} tasks`;
	if (process.env.EVAL_REPORT) console.log(`${report}\n\n${misses.join('\n')}`);
	return { top1: top1 / n, top5: top5 / n, report };
}
