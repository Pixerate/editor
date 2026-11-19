import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TEXT_PROPOSAL_SCENARIOS, runTextProposalScenario, textProposalContracts } from '../src/tools';

describe('the text-proposals contracts', () => {
	it('are current in @pixerate/conformance', async () => {
		const dir = new URL('../../conformance/domains/text-proposals/', import.meta.url);
		const contracts = await textProposalContracts();
		expect(readdirSync(dir).sort()).toEqual(Object.keys(contracts).sort());
		for (const [file, value] of Object.entries(contracts)) {
			expect(JSON.parse(readFileSync(new URL(file, dir), 'utf8')), file).toEqual(JSON.parse(JSON.stringify(value)));
		}
	});

	it('call every tool and cover every outcome', async () => {
		const tools = new Set(TEXT_PROPOSAL_SCENARIOS.flatMap((s) => s.steps.flatMap((step) => (step.op === 'call' ? [step.tool] : []))));
		expect([...tools].sort()).toEqual(['accept_text_proposal', 'list_text_proposals', 'propose_text_edit', 'reject_text_proposal']);
		const results = JSON.stringify(await Promise.all(TEXT_PROPOSAL_SCENARIOS.map(runTextProposalScenario)));
		for (const phrase of ['"accepted"', '"rejected"', '"stale"', '"cleared"', '"gestureEnded":true', '"boundary":"line"', '"boundary":"word"', '"origin":"agent:jazz"', '"commit":"undo"', 'The note is locked.']) expect(results, phrase).toContain(phrase);
	});
});
