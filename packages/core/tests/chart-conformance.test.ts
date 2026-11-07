import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createChartConformanceHost } from '../src/chart';
import { conformanceValuesMatch, runConformanceScenario, type ConformanceScenario } from '../src/tools/conformance';
import { validateJsonSchema, type JsonSchema } from '../src/tools/schema';

/**
 * Replays the chart scenarios of `@pixerate/conformance` (`domains/chart/fixtures`), the ones the
 * Swift port replays too, and checks this core still produces what they record. After an intended
 * change, run `pnpm --filter @pixerate/editor build && pnpm conformance:record chart` and commit.
 */
const dir = new URL('../../conformance/domains/chart/fixtures/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const scenarios = files.map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as ConformanceScenario);
const schema = JSON.parse(readFileSync(new URL('../../conformance/schema/fixture.schema.json', import.meta.url), 'utf8')) as JsonSchema;
const contract = (name: string) => JSON.parse(readFileSync(new URL(`../${name}`, dir), 'utf8'));

/** Every command id a step runs, through run_command or one of run_commands' steps. */
function commandIds(s: ConformanceScenario): string[] {
	return s.steps.flatMap((step) => {
		const args = (step.arguments ?? {}) as { id?: string; steps?: Array<{ id: string }> };
		if (step.tool === 'run_command' && args.id) return [args.id];
		if (step.tool === 'run_commands') return (args.steps ?? []).map((x) => x.id);
		return [];
	});
}

describe('the chart conformance scenarios', () => {
	it('are valid scenarios, each named after its file, with no pixel snapshots', () => {
		expect(scenarios.length).toBeGreaterThan(0);
		for (const [i, s] of scenarios.entries()) {
			expect(validateJsonSchema(s, schema), files[i]).toEqual([]);
			expect(`${s.id}.json`).toBe(files[i]);
			for (const step of s.steps) {
				expect(step.expect, `${s.id} ${step.tool} is recorded`).toBeDefined();
				expect(step.pixels, `${s.id} ${step.tool}: the chart editor has no pixels`).toBeUndefined();
			}
		}
	});

	it('use every chart tool at least once (a new tool needs a scenario)', () => {
		const tools = (contract('tools.json') as { providers: Array<{ tools: Array<{ name: string }> }> }).providers.flatMap((p) => p.tools.map((t) => t.name));
		const used = new Set(scenarios.flatMap((s) => s.steps.map((step) => step.tool)));
		expect(tools.filter((t) => !used.has(t))).toEqual([]);
		expect([...used].filter((t) => !tools.includes(t) && t !== 'list_commands' && t !== 'run_command' && t !== 'run_commands')).toEqual([]);
	});

	it('run every chart command at least once (a new command needs a scenario)', () => {
		const commands = (contract('commands.json') as Array<{ id: string }>).map((c) => c.id);
		const used = new Set(scenarios.flatMap(commandIds));
		expect(commands.filter((c) => !used.has(c))).toEqual([]);
		expect([...used].filter((c) => !commands.includes(c))).toEqual([]);
	});

	it.each(scenarios.map((s) => [s.id, s] as const))('%s replays as recorded', async (_id, scenario) => {
		const outputs = await runConformanceScenario(scenario, createChartConformanceHost(scenario.setup ?? {}));
		scenario.steps.forEach((step, i) => {
			const command = (step.arguments as { id?: string } | undefined)?.id;
			const label = `step ${i + 1} (${step.tool}${step.tool === 'run_command' && command ? ` ${command}` : ''})`;
			const out = outputs[i]!;
			// Numbers within CONFORMANCE_NUMBER_TOLERANCE match (trig may differ in the last bits across CPUs); toEqual shows the diff.
			if (!conformanceValuesMatch(out.result, step.expect!.result)) expect(out.result, label).toEqual(step.expect!.result);
			expect(out.isError, label).toBe(step.expect!.isError === true);
			if (step.document && !conformanceValuesMatch(out.document, step.expect!.document)) expect(out.document, `${label} document`).toEqual(step.expect!.document);
			if (step.render && !conformanceValuesMatch(out.render, step.expect!.render)) expect(out.render, `${label} render`).toEqual(step.expect!.render);
		});
	}, 60_000);
});
