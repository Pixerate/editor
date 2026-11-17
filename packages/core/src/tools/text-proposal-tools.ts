/**
 * Agent tools for text proposals (#890): `propose_text_edit`, `list_text_proposals`,
 * `accept_text_proposal` and `reject_text_proposal`. An agent suggests a replacement the person
 * can take or leave, instead of editing the text outright. They drive a {@link TextProposals} store.
 */

import type { AgentTool, AgentToolProvider } from './registry.js';
import type { TextProposal, TextProposals } from './text-proposals.js';

export interface TextProposalToolProviderOptions {
	/** Provider id (unique per registry). Default `text-proposals`. */
	id?: string;
	/** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Accepting is not allowed: `accept_text_proposal` refuses with this reason (a sentence). */
	readOnly?: boolean | string | (() => boolean | string);
	/** Origin of proposals from calls that name no actor (default the store's). */
	fallbackOrigin?: string;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const proposalIdArg = {
	type: 'object',
	properties: {
		proposalId: { type: 'string', minLength: 1, description: 'Id of a pending text proposal, from propose_text_edit or list_text_proposals.' }
	},
	required: ['proposalId'],
	additionalProperties: false
} as const;

const describe = (p: TextProposal) => ({
	id: p.id,
	from: p.from,
	to: p.to,
	original: p.original,
	replacement: p.replacement,
	title: p.title,
	...(p.rationale ? { rationale: p.rationale } : {}),
	...(p.check ? { check: p.check } : {}),
	origin: p.origin,
	createdAt: new Date(p.createdAt).toISOString()
});

/** The proposal tools for a text (see the module comment). */
export function createTextProposalToolProvider(proposals: TextProposals, options: TextProposalToolProviderOptions = {}): AgentToolProvider {
	const readOnlyReason = (): string | null => {
		const ro = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		return ro ? (typeof ro === 'string' ? ro : 'The text is read-only: proposals can be made and rejected but not accepted.') : null;
	};

	const proposeTool: AgentTool = {
		name: 'propose_text_edit',
		title: 'Propose a text edit',
		description:
			'Suggests replacing a range of the text without changing it: the person sees the suggestion and accepts or dismisses it, so use it for edits they did not ask for (a house-style fix, a clearer phrase). Take the range from a read or check tool (check_rich_text_style, check_text_mechanics, find_text) and pass the text you read there as expected. The proposal follows the text as the person keeps writing and is dropped if they edit what it would replace. Returns the proposal id, its range, the text it replaces and its title. Follow with accept_text_proposal only when the person asked for it.',
		inputSchema: {
			type: 'object',
			properties: {
				from: { type: 'integer', minimum: 0, description: 'Start of the range to replace, as a UTF-16 offset into the text.' },
				to: { type: 'integer', minimum: 0, description: 'End of the range (exclusive UTF-16 offset); equal to from to insert.' },
				replacement: { type: 'string', description: 'The text to put there; empty to delete the range.' },
				expected: { type: 'string', description: 'The text you read at from..to. The proposal is refused if the text there is different now. Default: not checked.' },
				title: { type: 'string', minLength: 1, description: 'What the suggestion does, in a few words, e.g. "Use the house term". Shown to the person and the undo step name once accepted. Default: Replace "…" with "…".' },
				rationale: { type: 'string', description: 'Why, in one sentence, e.g. the style rule it follows. Shown beside the suggestion.' },
				check: { type: 'string', minLength: 1, description: 'The check id behind it (terms, heading-case, contractions, ...), when it comes from a check. Default none.' }
			},
			required: ['from', 'to', 'replacement'],
			additionalProperties: false
		},
		annotations: { title: 'Propose a text edit', ...WRITE },
		handler: (args, context) => {
			const origin = context.actor?.id ? `agent:${context.actor.id}` : options.fallbackOrigin;
			const proposal = proposals.propose({
				from: args.from,
				to: args.to,
				replacement: args.replacement,
				...(args.expected !== undefined ? { expected: args.expected } : {}),
				...(args.title !== undefined ? { title: args.title } : {}),
				...(args.rationale !== undefined ? { rationale: args.rationale } : {}),
				...(args.check !== undefined ? { check: args.check } : {}),
				...(origin ? { origin } : {})
			});
			const { id, createdAt: _createdAt, ...rest } = describe(proposal);
			return { proposalId: id, ...rest };
		}
	};

	const listTool: AgentTool = {
		name: 'list_text_proposals',
		title: 'List text proposals',
		description:
			'Lists the pending text proposals (suggested replacements not yet in the text): id, current range (it moves as the person writes), the text it replaces, the replacement, title, rationale, check and who proposed it, and whether accepting is allowed. Proposals whose text the person edited are gone. Call before accept_text_proposal or reject_text_proposal.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'List text proposals', ...READ },
		handler: () => {
			proposals.sync();
			return { proposals: proposals.getState().proposals.map(describe), readOnly: readOnlyReason() };
		}
	};

	const acceptTool: AgentTool = {
		name: 'accept_text_proposal',
		title: 'Accept a text proposal',
		description:
			'Applies a pending text proposal as one undo step, recorded as made by whoever proposed it, and drops it from the pending list. Refuses, changing nothing, when the text is read-only or the text it would replace has changed (the proposal is then dropped). Returns the range the replacement now occupies, its text and the undo step name.',
		inputSchema: proposalIdArg,
		annotations: { title: 'Accept a text proposal', ...WRITE },
		handler: (args) => {
			const reason = readOnlyReason();
			if (reason) throw new Error(reason);
			return proposals.accept(args.proposalId);
		}
	};

	const rejectTool: AgentTool = {
		name: 'reject_text_proposal',
		title: 'Reject a text proposal',
		description:
			'Dismisses a pending text proposal: the suggestion disappears and the text and its history are unchanged. Use it to withdraw a suggestion that no longer fits. Returns the dismissed proposal id and title.',
		inputSchema: proposalIdArg,
		annotations: { title: 'Reject a text proposal', ...WRITE },
		handler: (args) => {
			const proposal = proposals.reject(args.proposalId);
			return { proposalId: proposal.id, title: proposal.title, rejected: true };
		}
	};

	return {
		id: options.id ?? 'text-proposals',
		...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
		title: 'Text proposals',
		description: 'Suggest text edits the person accepts or dismisses, and accept or reject pending suggestions.',
		skill: 'pixerate-rich-text',
		tools: [proposeTool, listTool, acceptTool, rejectTool]
	};
}
