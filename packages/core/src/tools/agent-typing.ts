// How an agent's text edit is played out: the pure planner behind `typeAgentText` (rich text,
// `extensions/agent-caret.ts`) and the Swift `AgentTextDirector` (#878). It turns an edit into
// timed steps — optionally sweep over what it checks, select what it replaces, type the new text
// in frames, commit it as one undo step —
// and knows nothing about any editor, so every implementation plays an edit the same way. The
// plans for a few edits are exported as contracts (`agentTextContracts`) for the Swift port to match.

import { builtInTextTreatmentPlan, TEXT_TREATMENT_STAGES, type TextTreatmentTarget } from '../effects/text-treatment.js';

/** Timing of an agent's typing. */
export interface AgentTypingOptions {
	/** Typing speed in characters per second (default 60). */
	charsPerSecond?: number;
	/** Longest a single edit takes to type, in ms; longer text types faster (default 1500). */
	maxDurationMs?: number;
	/** How long a replaced range stays highlighted before typing starts, in ms (default 250). */
	selectMs?: number;
	/** How long the checking sweep over `edit.check` takes, in ms (default 480). */
	checkMs?: number;
}

export const DEFAULT_AGENT_CHARS_PER_SECOND = 60;
export const DEFAULT_AGENT_TYPING_MAX_MS = 1500;
export const DEFAULT_AGENT_SELECT_MS = 250;
/** As long as the built-in treatment's checking sweep (`BUILT_IN_TEXT_TREATMENT_CHECK_MS`). */
export const DEFAULT_AGENT_CHECK_MS = 480;
/** Typing is drawn at about 30 frames a second. */
export const AGENT_TYPING_FRAME_MS = 1000 / 30;

/** An edit: replace `from..to` (positions in the host's own units) with `text`. */
export interface AgentTextEdit {
	from: number;
	to: number;
	text: string;
	/**
	 * A range the agent looks over first (the word or line it checked), swept by the `checking`
	 * stage of its text treatment before it selects anything. Optional: without it there is no
	 * checking step.
	 */
	check?: { from: number; to: number };
}

export type AgentTypingStep =
	/** Sweep over `from..to` (what the agent checks), changing nothing, then wait `ms`. */
	| { type: 'check'; from: number; to: number; ms: number }
	/** Show the agent's selection over `from..to` (what it replaces), then wait `ms`. */
	| { type: 'select'; from: number; to: number; ms: number }
	/** Show the first `chars` characters of the text typed into the edit's range, then wait `ms`. */
	| { type: 'type'; chars: number; text: string; ms: number }
	/** Apply the whole edit as one undo step, with the caret after the new text. */
	| { type: 'commit' };

/**
 * The steps that play `edit` out: a `check` over `edit.check` when it is given (and not empty),
 * a `select` over what it replaces, the typing frames, and the commit. With `animate: false` (no
 * visible window), an infinite or zero speed, or no text to type, it is a single commit. Characters are code points (`Array.from`), so
 * a frame never splits a surrogate pair. The last frame doesn't wait: the commit follows at once.
 */
export function planAgentTyping(edit: AgentTextEdit, options: AgentTypingOptions & { animate?: boolean } = {}): AgentTypingStep[] {
	const cps = options.charsPerSecond ?? DEFAULT_AGENT_CHARS_PER_SECOND;
	const chars = Array.from(edit.text);
	const animate = (options.animate ?? true) && Number.isFinite(cps) && cps > 0 && chars.length > 0;
	if (!animate) return [{ type: 'commit' }];

	const duration = Math.min(options.maxDurationMs ?? DEFAULT_AGENT_TYPING_MAX_MS, (chars.length / cps) * 1000);
	const frames = Math.max(1, Math.min(chars.length, Math.round(duration / AGENT_TYPING_FRAME_MS)));
	const steps: AgentTypingStep[] = [];
	if (edit.check && edit.check.from < edit.check.to) {
		steps.push({ type: 'check', from: edit.check.from, to: edit.check.to, ms: options.checkMs ?? DEFAULT_AGENT_CHECK_MS });
	}
	if (edit.from < edit.to) steps.push({ type: 'select', from: edit.from, to: edit.to, ms: options.selectMs ?? DEFAULT_AGENT_SELECT_MS });
	for (let i = 1; i <= frames; i++) {
		const count = Math.round((chars.length * i) / frames);
		steps.push({ type: 'type', chars: count, text: chars.slice(0, count).join(''), ms: i < frames ? duration / frames : 0 });
	}
	steps.push({ type: 'commit' });
	return steps;
}

/** How long a plan takes to play, in ms. */
export function agentTypingDuration(steps: readonly AgentTypingStep[]): number {
	return steps.reduce((total, step) => total + ('ms' in step ? step.ms : 0), 0);
}

/** The edits whose plans make up the `agent-text` contract: replacements, insertions, deletions, long text, emoji. */
const CONTRACT_EDITS: ReadonlyArray<{ name: string; edit: AgentTextEdit; options?: AgentTypingOptions & { animate?: boolean } }> = [
	{ name: 'replace a word', edit: { from: 4, to: 8, text: "don't" } },
	{ name: 'insert a full stop', edit: { from: 12, to: 12, text: '.' } },
	{ name: 'delete a range', edit: { from: 3, to: 9, text: '' } },
	{ name: 'insert a sentence', edit: { from: 0, to: 0, text: 'The quick brown fox jumps over the lazy dog.' } },
	{ name: 'long text types faster', edit: { from: 0, to: 0, text: 'x'.repeat(200) } },
	{ name: 'emoji are whole characters', edit: { from: 0, to: 2, text: 'ok 👍🏽 done' } },
	{ name: 'slower typing', edit: { from: 1, to: 2, text: 'Hello' }, options: { charsPerSecond: 10, selectMs: 100 } },
	{ name: 'instant', edit: { from: 0, to: 4, text: 'word' }, options: { charsPerSecond: Infinity } },
	{ name: 'not animated', edit: { from: 0, to: 4, text: 'word' }, options: { animate: false } },
	{ name: 'check a sentence, then fix a word', edit: { from: 4, to: 8, text: 'there', check: { from: 0, to: 20 } } },
	{ name: 'quicker check before an insertion', edit: { from: 10, to: 10, text: ',', check: { from: 6, to: 14 } }, options: { checkMs: 200 } },
	{ name: 'an empty check is skipped', edit: { from: 2, to: 5, text: 'and', check: { from: 3, to: 3 } } },
	{ name: 'no check when not animated', edit: { from: 0, to: 4, text: 'word', check: { from: 0, to: 9 } }, options: { animate: false } },
];

/**
 * The `agent-text` domain of `@pixerate/conformance`: the default timing and the plans for a
 * set of edits, which another implementation's planner must reproduce exactly (times in ms; an
 * infinite speed is written as `null`).
 */
export function agentTextContracts(): Record<string, unknown> {
	return {
		'manifest.json': {
			domain: 'agent-text',
			formatVersion: 1,
			description: 'How an agent text edit is played out: check, select, type in frames, commit as one undo step; and the built-in text treatment that draws it.',
			defaults: {
				charsPerSecond: DEFAULT_AGENT_CHARS_PER_SECOND,
				maxDurationMs: DEFAULT_AGENT_TYPING_MAX_MS,
				selectMs: DEFAULT_AGENT_SELECT_MS,
				checkMs: DEFAULT_AGENT_CHECK_MS,
				frameMs: AGENT_TYPING_FRAME_MS,
			},
			files: ['typing-plans.json', 'treatment-plans.json'],
		},
		'typing-plans.json': CONTRACT_EDITS.map(({ name, edit, options }) => ({
			name,
			edit,
			options: options
				? Object.fromEntries(Object.entries(options).map(([k, v]) => [k, typeof v === 'number' && !Number.isFinite(v) ? null : v]))
				: {},
			steps: planAgentTyping(edit, options),
		})),
		'treatment-plans.json': treatmentContractCases(),
	};
}

/** Targets for the built-in treatment's contract: a range wrapping onto a second line with a name tag, and one line without. */
const TREATMENT_TARGETS: ReadonlyArray<{ name: string; target: TextTreatmentTarget }> = [
	{
		name: 'wrapped, with a name tag',
		target: {
			lines: [
				{ x: 40, y: 0, width: 120, height: 20 },
				{ x: 0, y: 24, width: 64.5, height: 20 },
			],
			caret: { x: 64.5, y: 24, height: 20 },
			label: 'Agent',
		},
	},
	{ name: 'one line', target: { lines: [{ x: 12.25, y: 30, width: 88, height: 17 }], caret: { x: 100.25, y: 30, height: 17 } } },
	{ name: 'nothing to draw over', target: { lines: [{ x: 0, y: 0, width: 0, height: 20 }] } },
];

/** The built-in text treatment's plans for every stage at several moments, with and without motion: another implementation must match them. */
function treatmentContractCases(): unknown[] {
	const cases: unknown[] = [];
	for (const { name, target } of TREATMENT_TARGETS) {
		for (const stage of TEXT_TREATMENT_STAGES) {
			for (const reduceMotion of [false, true]) {
				for (const time of [0, 100, 240, 333.5, 479, 480, 2000]) {
					const values = name === 'one line' ? { color: '#3366cc' } : undefined;
					cases.push({ name, stage, time, reduceMotion, target, ...(values && { values }), plan: builtInTextTreatmentPlan({ stage, time, target, reduceMotion }, values) });
				}
			}
		}
	}
	return cases;
}
