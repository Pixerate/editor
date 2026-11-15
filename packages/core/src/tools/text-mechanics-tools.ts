/**
 * Agent tools for the text mechanics checks (#892): `check_text_mechanics` reports the
 * punctuation, casing, apostrophe and spelling fixes a Markdown text needs, and
 * `fix_text_mechanics` applies them as one undo step. The host supplies the text and, when it
 * can be edited, a way to apply edits; the checks are the ones Swash's writing partner runs as
 * you type (`textMechanicsEditsAt`).
 */
import type { AgentTool, AgentToolProvider } from './registry.js';
import { textMechanicsFindings, TEXT_MECHANICS_CHECKS,
	TEXT_MECHANICS_OFF_BY_DEFAULT, type TextMechanicsCheckId, type TextMechanicsEdit, type TextMechanicsOptions } from './text-mechanics.js';

export interface TextMechanicsHost {
	/** The Markdown source as it is now. */
	getText(): string;
	/**
	 * Applies `edits` (UTF-16 ranges in the text as `getText` returned it; they never overlap)
	 * as one undo step named `actionName`. Leave it out for a read-only text.
	 */
	applyEdits?(edits: readonly TextMechanicsEdit[], actionName: string): void;
	/** Why the text can't be edited now (a read-only document), or null. */
	readOnlyReason?(): string | null;
}

export interface TextMechanicsToolProviderOptions extends Pick<TextMechanicsOptions, 'profile' | 'spelling' | 'tagger' | 'enabled'> {
	/** Provider id (unique per registry). Default `text-mechanics`. */
	id?: string;
	/** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
	namespace?: string;
}

const CHECK_IDS = TEXT_MECHANICS_CHECKS.map((c) => c.id);

const checksSchema = {
	type: 'array',
	items: { type: 'string', enum: CHECK_IDS },
	minItems: 1,
	uniqueItems: true,
	description: `Only these checks (default: all): ${TEXT_MECHANICS_CHECKS.map((c) => `${c.id} (${c.title})`).join(', ')}.`
} as const;

/**
 * `check_text_mechanics` and, while the host can apply edits and isn't read-only,
 * `fix_text_mechanics`.
 */
export function createTextMechanicsToolProvider(host: TextMechanicsHost, options: TextMechanicsToolProviderOptions = {}): AgentToolProvider {
	const writable = () => !!host.applyEdits && !host.readOnlyReason?.();
	const run = (only?: TextMechanicsCheckId[]) => {
		const text = host.getText();
		const findings = textMechanicsFindings(text, {
			profile: options.profile,
			spelling: options.spelling,
			tagger: options.tagger,
			enabled: (c) => (!only || only.includes(c)) && (options.enabled?.(c) ?? !TEXT_MECHANICS_OFF_BY_DEFAULT.has(c))
		});
		return { text, findings };
	};

	const check: AgentTool = {
		name: 'check_text_mechanics',
		title: 'Check punctuation and spelling',
		description:
			"Checks the Markdown text for the small, certain fixes a writer expects: capital I, missing apostrophes (dont → don't; its, id and ill only where they're contractions), capitals at the start of sentences, a full stop or question mark at the end of a finished line, OK, a comma before a \"but\" that starts a clause, and spelling. Code, math, HTML, tables, links' addresses and URLs are never changed. Returns each finding with its check id, the text it changes, the replacement, a {from, to} UTF-16 range and a sentence; fix_text_mechanics applies them all at once. This is not house style (terms, tone, formats): use the house-style tools for that.",
		inputSchema: {
			type: 'object',
			properties: { checks: checksSchema },
			additionalProperties: false
		},
		annotations: {
			title: 'Check punctuation and spelling',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		},
		handler: ({ checks }) => {
			const { text, findings } = run(checks);
			return {
				ok: findings.length === 0,
				count: findings.length,
				findings: findings.map((f) => ({
					check: f.checks[0],
					checks: f.checks,
					from: f.from,
					to: f.to,
					text: text.slice(f.from, f.to),
					replacement: f.replacement,
					message: f.message
				})),
				...(options.spelling
					? {}
					: {
							note: 'No spell checker is available here, so spelling was not checked.'
						})
			};
		}
	};

	const fix: AgentTool = {
		name: 'fix_text_mechanics',
		title: 'Fix punctuation and spelling',
		description:
			'Applies every fix check_text_mechanics finds, as one undo step. Pass checks to limit it to some of them. Returns how many it fixed. Run check_text_mechanics first to see what will change.',
		inputSchema: {
			type: 'object',
			properties: { checks: checksSchema },
			additionalProperties: false
		},
		annotations: {
			title: 'Fix punctuation and spelling',
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		},
		handler: ({ checks }) => {
			const reason = host.readOnlyReason?.();
			if (reason) throw new Error(reason);
			if (!host.applyEdits) throw new Error('This text is read-only, so its punctuation and spelling cannot be fixed.');
			const { findings } = run(checks);
			if (findings.length)
				host.applyEdits(
					findings.map(({ from, to, replacement, checks: c }) => ({
						from,
						to,
						replacement,
						checks: c
					})),
					'Fix Punctuation and Spelling'
				);
			return {
				fixed: findings.length,
				byCheck: Object.fromEntries(CHECK_IDS.map((id) => [id, findings.filter((f) => f.checks.includes(id)).length]).filter(([, n]) => n))
			};
		}
	};

	return {
		id: options.id ?? 'text-mechanics',
		namespace: options.namespace,
		title: 'Punctuation and spelling',
		description: 'Check a Markdown text for punctuation, casing, apostrophes and spelling, and apply the certain fixes.',
		skill: 'pixerate-rich-text',
		tools: () => (writable() ? [check, fix] : [check])
	};
}
