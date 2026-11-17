/**
 * The `markdown-style` domain of `@pixerate/conformance` (#890): house style on Markdown source,
 * for another implementation (the Swift port in PixerateMarkdown) to reproduce exactly. Each
 * case is a Markdown source and a resolved `rich-text.json` profile; the contract is the blocks
 * the reader finds (`markdownStyleState`), the findings each check returns with their source
 * ranges, messages and certain replacements (narrowed to what they change), and the text after
 * every certain fix is applied.
 */
import { richTextStyleDomain, type RichTextStyleProfile, type RichTextStyleTarget } from '../richTextStyle.js';
import { applyMarkdownStyleEdits, markdownStyleEdits, markdownStyleState, narrowMarkdownStyleTarget, type MarkdownStyleFinding } from './markdown-style.js';

export interface MarkdownStyleCase {
	name: string;
	source: string;
	/** The resolved profile; its `checks` say which checks run, in order. */
	profile: RichTextStyleProfile & { checks: string[] };
}

/**
 * Runs the profile's checks on `source` without a resolver (no layers, no brand): the findings
 * `checkMarkdownStyle` returns for a style made of this one profile.
 */
export function markdownStyleFindings(source: string, profile: RichTextStyleProfile & { checks: readonly string[] }): MarkdownStyleFinding[] {
	const state = markdownStyleState(source);
	const findings: MarkdownStyleFinding[] = [];
	for (const id of profile.checks) {
		const check = richTextStyleDomain.checks.find((c) => c.id === id);
		if (!check) continue;
		for (const f of check.run(state, profile as unknown as Record<string, unknown>, {}, {})) {
			const { target: raw, ...rest } = f;
			const target = raw as RichTextStyleTarget | undefined;
			findings.push({ ...rest, check: id, ...(target ? { target: narrowMarkdownStyleTarget(source, state, target) } : {}) });
		}
	}
	return findings;
}

const ALL = ['heading-case', 'heading-levels', 'list-punctuation', 'quotes', 'terms', 'number-format', 'date-format'];

/** The cases of the contract. */
export const MARKDOWN_STYLE_CASES: readonly MarkdownStyleCase[] = [
	{
		name: 'issue example: a banned term, a title-case heading and a slash date',
		source: '# Our New Release Plan\n\nWe utilize the tool from 3/4/2026 onwards.\n',
		profile: { headingCase: 'sentence', terms: [{ avoid: 'utilize', use: 'use' }], dateFormat: 'day-month-year', checks: ['heading-case', 'terms', 'date-format'] }
	},
	{
		name: 'emphasis and links keep their syntax',
		source: '## The **Big** Launch\n\nRead [the Utilize guide](https://example.com/utilize) to *utilize* it.\n',
		profile: { headingCase: 'sentence', terms: [{ avoid: 'utilize', use: 'use' }], checks: ['heading-case', 'terms'] }
	},
	{
		name: 'code, math, HTML, tables and front matter are not prose',
		source: '---\ntitle: "Utilize"\n---\n\nUse `utilize()` and $x = "y"$ here, not utilize.\n\n```\nutilize "quoted"\n```\n\n| a | utilize |\n|---|---|\n| "b" | c |\n\n<div>utilize "x"</div>\n',
		profile: { quotes: 'curly', terms: [{ avoid: 'utilize', use: 'use' }], checks: ['quotes', 'terms'] }
	},
	{
		name: 'list endings, quotes in a block quote, setext headings and levels',
		source: 'Setext Heading Here\n===================\n\n#### Too Deep\n\n- First item.\n- Second item\n  continues here.\n- [ ] A task\n\n> She said "hello" to me\n',
		profile: { headingCase: 'sentence', maxHeadingLevel: 3, listItemEnd: 'none', quotes: 'curly', checks: ['heading-case', 'heading-levels', 'list-punctuation', 'quotes'] }
	},
	{
		name: 'numbers and dates',
		source: 'We sold 12345 units on 2026-11-12 and 1,234,567 more by November 3, 2026.\n',
		profile: { thousandsSeparator: 'thin', dateFormat: 'day-month-year', checks: ['number-format', 'date-format'] }
	},
	{
		name: 'a case change across emphasis keeps the markers',
		source: '# Planning **For** Q3 _Next_ Steps\n',
		profile: { headingCase: 'sentence', checks: ALL.filter((c) => c === 'heading-case') }
	},
	{
		name: 'periods appended before closing emphasis, UTF-16 offsets after emoji',
		source: '😀 Intro\n\n* Ship it **now**\n* 🚀 Launch [the plan](#plan)\n',
		profile: { listItemEnd: 'period', checks: ['list-punctuation'] }
	}
];

const blockOf = (b: ReturnType<typeof markdownStyleState>['blocks'][number]) => ({
	kind: b.kind,
	...(b.level !== undefined ? { level: b.level } : {}),
	text: b.text,
	from: b.from,
	to: b.to
});

/** What each case must produce. */
export function runMarkdownStyleCase(c: MarkdownStyleCase) {
	const findings = markdownStyleFindings(c.source, c.profile);
	const { edits } = markdownStyleEdits(findings);
	return {
		blocks: markdownStyleState(c.source).blocks.map(blockOf),
		findings: findings.map((f) => ({
			check: f.check,
			severity: f.severity,
			message: f.message,
			...(f.target ? { from: f.target.from, to: f.target.to, ...(f.target.replacement !== undefined ? { replacement: f.target.replacement } : {}) } : {})
		})),
		fixed: applyMarkdownStyleEdits(c.source, edits)
	};
}

/** The files of `packages/conformance/domains/markdown-style`. */
export function markdownStyleContracts(): Record<string, unknown> {
	return {
		'manifest.json': {
			domain: 'markdown-style',
			formatVersion: 1,
			description:
				'House style (the rich-text domain checks) on Markdown source: the blocks the reader finds, each finding with its UTF-16 source range, message and certain replacement, and the text after every certain fix. The brand\'s colour and font checks do not apply to Markdown.',
			checks: ALL,
			files: ['cases.json']
		},
		'cases.json': MARKDOWN_STYLE_CASES.map((c) => ({ ...c, expected: runMarkdownStyleCase(c) }))
	};
}
