import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	AGENT_TYPING_FRAME_MS,
	agentTextContracts,
	agentTypingDuration,
	planAgentTyping,
	type AgentTypingStep
} from '../src/tools/agent-typing';

const typed = (steps: AgentTypingStep[]) => steps.filter((s): s is Extract<AgentTypingStep, { type: 'type' }> => s.type === 'type');

describe('planAgentTyping', () => {
	it('selects what it replaces, types it in frames, then commits', () => {
		const steps = planAgentTyping({ from: 4, to: 8, text: "don't" });
		expect(steps[0]).toEqual({ type: 'select', from: 4, to: 8, ms: 250 });
		// 5 characters at 60 a second: 83 ms, two ~30 fps frames
		expect(typed(steps).map((s) => s.text)).toEqual(['don', "don't"]);
		expect(steps[steps.length - 1]).toEqual({ type: 'commit' });
		// The last frame doesn't wait: the commit follows at once
		expect(agentTypingDuration(steps)).toBeCloseTo(250 + (5 / 60) * 1000 / 2, 6);
		expect(typed(steps).at(-1)!.ms).toBe(0);
	});

	it('has no selection for an insertion, and one frame for a single character', () => {
		expect(planAgentTyping({ from: 12, to: 12, text: '.' })).toEqual([
			{ type: 'type', chars: 1, text: '.', ms: 0 },
			{ type: 'commit' }
		]);
	});

	it('commits at once when there is nothing to type, no animation, or an infinite or zero speed', () => {
		expect(planAgentTyping({ from: 3, to: 9, text: '' })).toEqual([{ type: 'commit' }]);
		expect(planAgentTyping({ from: 0, to: 4, text: 'word' }, { animate: false })).toEqual([{ type: 'commit' }]);
		expect(planAgentTyping({ from: 0, to: 4, text: 'word' }, { charsPerSecond: Infinity })).toEqual([{ type: 'commit' }]);
		expect(planAgentTyping({ from: 0, to: 4, text: 'word' }, { charsPerSecond: 0 })).toEqual([{ type: 'commit' }]);
	});

	it('caps long text at maxDurationMs, so it types faster', () => {
		const steps = planAgentTyping({ from: 0, to: 0, text: 'x'.repeat(200) });
		const frames = typed(steps);
		expect(frames.length).toBe(Math.round(1500 / AGENT_TYPING_FRAME_MS));
		expect(frames.at(-1)!.chars).toBe(200);
		expect(agentTypingDuration(steps)).toBeCloseTo(1500 * (1 - 1 / frames.length), 6);
	});

	it('never splits a character made of two UTF-16 units', () => {
		for (const step of typed(planAgentTyping({ from: 0, to: 0, text: 'ok 👍🏽 done' }))) {
			expect(step.text).toBe(Array.from('ok 👍🏽 done').slice(0, step.chars).join(''));
			expect(/[\uD800-\uDBFF]$/.test(step.text)).toBe(false);
		}
	});
});

describe('the agent-text contracts in @pixerate/conformance', () => {
	const dir = new URL('../../conformance/domains/agent-text/', import.meta.url);
	const contracts = agentTextContracts();
	const committed = (name: string) => JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as unknown;

	it('are the files the code exports, with nothing extra (run node scripts/export-contracts.mjs after a change)', () => {
		expect(readdirSync(dir).filter((f) => f.endsWith('.json')).sort()).toEqual(Object.keys(contracts).sort());
	});

	it.each(Object.keys(contracts))('%s matches the code', (name) => {
		expect(committed(name)).toEqual(JSON.parse(JSON.stringify(contracts[name])));
	});

	it('formats every file the way the export script writes it', () => {
		for (const name of Object.keys(contracts)) expect(readFileSync(new URL(name, dir), 'utf8'), name).toBe(JSON.stringify(committed(name), null, 2) + '\n');
	});

	it('records each plan with the planner', () => {
		for (const plan of committed('typing-plans.json') as Array<{ edit: { from: number; to: number; text: string }; options: Record<string, unknown>; steps: unknown }>) {
			const options = Object.fromEntries(Object.entries(plan.options).map(([k, v]) => [k, v === null ? Infinity : v]));
			expect(JSON.parse(JSON.stringify(planAgentTyping(plan.edit, options)))).toEqual(plan.steps);
		}
	});
});
