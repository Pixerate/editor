/**
 * The `text-proposals` domain of `@pixerate/conformance` (#890): the text change feed, text
 * proposals and their agent tools as step-by-step scenarios, for the Swift port in PixerateCore
 * to reproduce exactly. A scenario starts from a text with an undo history; each step is the
 * person typing or replacing text, an agent's tool call, undo / redo, a pause that ends a typing
 * burst, or the host ending a gesture. After each step the feed is checked and the proposals are
 * brought up to date, and the contract records what the feed reported, the outcomes, the pending
 * proposals, the tool result and the text. Time is a counter and ids are `p1`, `p2`, …
 */
import { HistoryManager } from '../history/HistoryManager.js';
import { ToolRegistry } from './registry.js';
import { createTextChangeFeed } from './text-changes.js';
import { createTextProposals, type TextProposalOutcomeEvent } from './text-proposals.js';
import { createTextProposalToolProvider } from './text-proposal-tools.js';

export type TextProposalStep =
	| { op: 'type'; at: number; text: string }
	| { op: 'replace'; from: number; to: number; text: string }
	| { op: 'select'; from: number; to: number }
	| { op: 'call'; tool: 'propose_text_edit' | 'list_text_proposals' | 'accept_text_proposal' | 'reject_text_proposal'; args: Record<string, unknown>; actor?: string }
	| { op: 'reject'; id: string }
	| { op: 'clear'; origin?: string }
	| { op: 'undo' }
	| { op: 'redo' }
	| { op: 'pause' }
	| { op: 'endGesture' };

export interface TextProposalScenario {
	name: string;
	text: string;
	/** Typing burst length in ms (default 1500; 0 turns bursts off). */
	burstMs?: number;
	/** Accepting is refused with this reason. */
	readOnly?: string;
	steps: TextProposalStep[];
}

/** The scenarios of the contract. */
export const TEXT_PROPOSAL_SCENARIOS: readonly TextProposalScenario[] = [
	{
		name: 'a house-style fix proposed, the person types before it, and it is accepted as one step by the agent',
		text: 'We utilize the tool.',
		steps: [
			{ op: 'call', tool: 'propose_text_edit', args: { from: 3, to: 10, replacement: 'use', expected: 'utilize', check: 'terms', rationale: 'The house term.' }, actor: 'jazz' },
			{ op: 'type', at: 0, text: 'So ' },
			{ op: 'type', at: 3, text: 'w' },
			{ op: 'pause' },
			{ op: 'call', tool: 'list_text_proposals', args: {} },
			{ op: 'call', tool: 'accept_text_proposal', args: { proposalId: 'p1' } },
			{ op: 'undo' },
			{ op: 'redo' }
		]
	},
	{
		name: 'editing a proposal’s text drops it as stale; wrapping it in syntax re-anchors it',
		text: 'Alpha beta gamma delta.',
		steps: [
			{ op: 'call', tool: 'propose_text_edit', args: { from: 6, to: 10, replacement: 'BETA' }, actor: 'jazz' },
			{ op: 'call', tool: 'propose_text_edit', args: { from: 11, to: 16, replacement: 'GAMMA', title: 'Shout gamma' }, actor: 'jazz' },
			{ op: 'replace', from: 6, to: 10, text: 'bet' },
			{ op: 'replace', from: 10, to: 15, text: '**gamma**' },
			{ op: 'call', tool: 'accept_text_proposal', args: { proposalId: 'p2' } },
			{ op: 'call', tool: 'accept_text_proposal', args: { proposalId: 'p1' } }
		]
	},
	{
		name: 'overlapping proposals: accepting one leaves the other stale; reject and clear by origin',
		text: 'One two three four',
		steps: [
			{ op: 'call', tool: 'propose_text_edit', args: { from: 0, to: 7, replacement: '1 2' }, actor: 'a' },
			{ op: 'call', tool: 'propose_text_edit', args: { from: 4, to: 13, replacement: '2 3' }, actor: 'b' },
			{ op: 'call', tool: 'propose_text_edit', args: { from: 14, to: 18, replacement: '4' }, actor: 'b' },
			{ op: 'call', tool: 'propose_text_edit', args: { from: 18, to: 18, replacement: '!' }, actor: 'a' },
			{ op: 'call', tool: 'accept_text_proposal', args: { proposalId: 'p1' } },
			{ op: 'call', tool: 'reject_text_proposal', args: { proposalId: 'p3' } },
			{ op: 'clear', origin: 'agent:a' },
			{ op: 'call', tool: 'list_text_proposals', args: {} }
		]
	},
	{
		name: 'bad proposals and a read-only text',
		text: 'Hello world',
		readOnly: 'The note is locked.',
		steps: [
			{ op: 'call', tool: 'propose_text_edit', args: { from: 6, to: 99, replacement: 'x' } },
			{ op: 'call', tool: 'propose_text_edit', args: { from: 6, to: 11, replacement: 'there', expected: 'earth' } },
			{ op: 'call', tool: 'propose_text_edit', args: { from: 6, to: 11, replacement: 'world' } },
			{ op: 'call', tool: 'propose_text_edit', args: { from: 0, to: 0, replacement: 'Oh, ' } },
			{ op: 'call', tool: 'accept_text_proposal', args: { proposalId: 'p1' } },
			{ op: 'call', tool: 'accept_text_proposal', args: { proposalId: 'nope' } },
			{ op: 'call', tool: 'list_text_proposals', args: {} }
		]
	},
	{
		name: 'the feed: word and line boundaries, selection, a burst ended by the host, whole-word replacements and surrogate pairs',
		text: 'Hi',
		burstMs: 500,
		steps: [
			{ op: 'type', at: 2, text: ' ' },
			{ op: 'type', at: 3, text: 'there' },
			{ op: 'type', at: 8, text: '\n' },
			{ op: 'select', from: 0, to: 2 },
			{ op: 'endGesture' },
			{ op: 'endGesture' },
			{ op: 'replace', from: 3, to: 8, text: 'theirs' },
			{ op: 'type', at: 0, text: '😀' },
			{ op: 'replace', from: 0, to: 2, text: '😃' },
			{ op: 'type', at: 2, text: 'a' },
			{ op: 'type', at: 3, text: 'a' },
			{ op: 'pause' }
		]
	},
	{
		name: 'no bursts',
		text: 'abc',
		burstMs: 0,
		steps: [
			{ op: 'type', at: 3, text: 'd' },
			{ op: 'pause' },
			{ op: 'replace', from: 0, to: 4, text: '' }
		]
	}
];

/** What one step produced. */
export interface TextProposalStepResult {
	text: string;
	/** Feed changes, with `commit` as its kind. */
	changes: unknown[];
	outcomes: { id: string; outcome: string }[];
	proposals: unknown[];
	result?: unknown;
}

/** Runs a scenario as the contract records it. */
export async function runTextProposalScenario(scenario: TextProposalScenario): Promise<TextProposalStepResult[]> {
	let text = scenario.text;
	let selection = { from: text.length, to: text.length };
	let clock = 0;
	const now = () => ++clock;
	const history = new HistoryManager();
	let timer: (() => void) | undefined;
	const feed = createTextChangeFeed({
		getText: () => text,
		getSelection: () => selection,
		history,
		...(scenario.burstMs !== undefined ? { burstMs: scenario.burstMs } : {}),
		now,
		schedule: (fn) => {
			timer = fn;
			return () => {
				if (timer === fn) timer = undefined;
			};
		}
	});
	let n = 0;
	const proposals = createTextProposals({
		getText: () => text,
		applyEdit: (edit, step) => {
			const before = text;
			const after = before.slice(0, edit.from) + edit.replacement + before.slice(edit.to);
			const caret = edit.from + edit.replacement.length;
			history.execute({
				name: step.name,
				origin: step.origin,
				execute: () => {
					text = after;
					selection = { from: caret, to: caret };
				},
				undo: () => {
					text = before;
					selection = { from: edit.to, to: edit.to };
				}
			});
		},
		readOnly: () => scenario.readOnly ?? false,
		idGenerator: () => `p${++n}`,
		now
	});
	const registry = new ToolRegistry();
	registry.register(createTextProposalToolProvider(proposals, { namespace: '' }));

	const changes: unknown[] = [];
	feed.subscribe((c) => {
		const { commit, ...rest } = c;
		changes.push({ ...rest, ...(commit ? { commit: commit.kind } : {}) });
	});
	const outcomes: { id: string; outcome: string }[] = [];
	proposals.onOutcome((e: TextProposalOutcomeEvent) => outcomes.push({ id: e.proposal.id, outcome: e.outcome }));

	const out: TextProposalStepResult[] = [];
	for (const step of scenario.steps) {
		changes.length = 0;
		outcomes.length = 0;
		let result: unknown;
		switch (step.op) {
			case 'type':
				text = text.slice(0, step.at) + step.text + text.slice(step.at);
				selection = { from: step.at + step.text.length, to: step.at + step.text.length };
				break;
			case 'replace':
				text = text.slice(0, step.from) + step.text + text.slice(step.to);
				selection = { from: step.from + step.text.length, to: step.from + step.text.length };
				break;
			case 'select':
				selection = { from: step.from, to: step.to };
				break;
			case 'call': {
				const r = await registry.callTool(step.tool, step.args, step.actor ? { actor: { id: step.actor, name: step.actor } as never } : {});
				result = r.isError ? { isError: true, error: (r.structuredContent?.error as { message?: string } | undefined)?.message } : { isError: false, structuredContent: JSON.parse(JSON.stringify(r.structuredContent ?? null)) };
				break;
			}
			case 'reject':
				proposals.reject(step.id);
				break;
			case 'clear':
				result = proposals.clear(step.origin);
				break;
			case 'undo':
				history.undo();
				break;
			case 'redo':
				history.redo();
				break;
			case 'pause': {
				const fire = timer;
				timer = undefined;
				fire?.();
				break;
			}
			case 'endGesture':
				feed.endGesture();
				break;
		}
		feed.check();
		proposals.sync();
		out.push({
			text,
			changes: JSON.parse(JSON.stringify(changes)),
			outcomes: [...outcomes],
			proposals: proposals.getState().proposals.map((p) => ({ ...p })),
			...(result !== undefined ? { result } : {})
		});
	}
	return out;
}

/** The files of `packages/conformance/domains/text-proposals`. */
export async function textProposalContracts(): Promise<Record<string, unknown>> {
	const registry = new ToolRegistry();
	registry.register(createTextProposalToolProvider(createTextProposals({ getText: () => '', applyEdit: () => {} }), { namespace: '' }));
	const scenarios = [];
	for (const s of TEXT_PROPOSAL_SCENARIOS) scenarios.push({ ...s, expected: await runTextProposalScenario(s) });
	return {
		'manifest.json': {
			domain: 'text-proposals',
			formatVersion: 1,
			description:
				'The text change feed, text proposals and their agent tools, as step-by-step scenarios over a text with an undo history: typing, replacing, selecting, tool calls (actor = agent id), undo / redo, a pause that fires the burst timer, the host ending a gesture. After each step the feed is checked and proposals synced; each step records the text, the feed changes (commit as its kind), outcomes, pending proposals and the tool result. Time counts up from 1 per now() call; proposal ids are p1, p2, ….',
			files: ['tools.json', 'scenarios.json']
		},
		'tools.json': registry.listTools().tools,
		'scenarios.json': scenarios
	};
}
