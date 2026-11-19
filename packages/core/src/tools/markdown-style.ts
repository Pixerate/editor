/**
 * House style for Markdown source (#890): the document house-style checks
 * (`richTextStyleDomain`: heading case and levels, list endings, quotation marks, terms, number
 * and date formats) run on Markdown text, with findings as UTF-16 ranges of the source.
 *
 * `markdownStyleState` reads a {@link RichTextStyleState} from the source with the prose map the
 * text mechanics use (`markdownProseMap`), so code, math, HTML, tables, front matter, link
 * destinations and syntax markers are never checked or changed. `checkMarkdownStyle` runs the
 * checks and narrows each certain fix to the characters it changes, keeping emphasis and link
 * syntax in place; `createMarkdownStyleToolProvider` offers the same `check_rich_text_style` /
 * `fix_rich_text_style` tools as a rich-text document, over a text host.
 */
import type { AgentTool, AgentToolProvider } from './registry.js';
import type { StyleCheckReport, StyleResolver, ResolvedStyle } from './style.js';
import { SHARED_STYLE_CHECKS } from './style-surface.js';
import { markdownProseMap, type MarkdownProseBlock, type MarkdownProseMap } from './markdown-prose.js';
import type { RichTextStyleBlock, RichTextStyleState, RichTextStyleTarget } from '../richTextStyle.js';

/** Stands in for an inline atom that is not prose (a code span, math, an image, inline HTML). */
export const MARKDOWN_STYLE_ATOM = '￼';

type Range = { from: number; to: number };

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * Splits a prose range into the pieces of plain text in it: emphasis and strikethrough
 * delimiters (`*`, `_`, `~~`), the brackets of a link or reference (`[text](…)`) and escaping
 * backslashes are syntax, not text.
 */
function plainPieces(source: string, ranges: readonly Range[]): Range[] {
	const markup = new Set<number>();
	const opens: number[] = [];
	for (const r of ranges) {
		let k = r.from;
		while (k < r.to) {
			const c = source[k];
			if (c === '\\' && k + 1 < r.to && /[!-/:-@[-`{-~]/.test(source[k + 1])) {
				markup.add(k);
				k += 2;
				continue;
			}
			if (c === '*' || c === '_' || c === '~') {
				let end = k;
				while (end < r.to && source[end] === c) end++;
				const before = source[k - 1];
				const after = source[end];
				// A delimiter touches text on at least one side; `_` inside a word is a letter (snake_case).
				const delimiter = !(isSpace(before) && isSpace(after)) && !(c === '_' && isWordChar(before) && isWordChar(after)) && !(c === '~' && end - k !== 2);
				if (delimiter) for (let m = k; m < end; m++) markup.add(m);
				k = end;
				continue;
			}
			if (c === '[') opens.push(k);
			else if (c === ']' && (source[k + 1] === '(' || source[k + 1] === '[') && opens.length) {
				markup.add(opens.pop()!);
				markup.add(k);
			}
			k++;
		}
	}
	const pieces: Range[] = [];
	for (const r of ranges) {
		let start = r.from;
		for (let k = r.from; k <= r.to; k++) {
			if (k === r.to || markup.has(k)) {
				if (k > start) pieces.push({ from: start, to: k });
				start = k + 1;
			}
		}
	}
	return pieces;
}

const headingLevel = (source: string, block: MarkdownProseBlock): number => {
	const text = source.slice(block.from, block.to);
	const lines = text.split('\n');
	if (lines.length > 1) {
		const underline = lines[lines.length - 1].replace(/^[ \t>]*/, '').trim();
		if (/^=+$/.test(underline)) return 1;
		if (/^-+$/.test(underline)) return 2;
	}
	const atx = /^(?:[ \t]*(?:>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+))*[ \t]{0,3}(#{1,6})(?:[ \t]|$)/.exec(text);
	return atx ? atx[1].length : 1;
};

/** The end of a heading's text: before an ATX heading's closing run of `#`s, or a setext heading's underline. */
const endOfHeadingText = (source: string, block: MarkdownProseBlock): number => {
	const line = source.slice(block.from, block.to);
	if (line.includes('\n')) return block.from + line.lastIndexOf('\n');
	const closing = /(?:^|[ \t]+)#+[ \t]*$/.exec(line);
	return closing ? block.from + closing.index : block.to;
};

/**
 * What a stretch of source that is not text reads as: a soft line break between two pieces is
 * a space, syntax alone (emphasis, link brackets and destinations) is nothing, and anything else
 * (a code span, math, an image, inline HTML) is one {@link MARKDOWN_STYLE_ATOM}.
 */
const gapText = (gap: string, between: boolean): string => {
	if (!gap) return '';
	if (between && gap.includes('\n')) return ' ';
	if (/^[\s>*+\-_~\\[\]]*(?:\((?:[^()\n]|\([^()\n]*\))*\)|\[[^\]\n]*\])?[\s*_~\\[\]]*$/.test(gap)) return '';
	return MARKDOWN_STYLE_ATOM;
};

const kindOf = (block: MarkdownProseBlock): RichTextStyleBlock['kind'] => {
	if (block.kind === 'heading') return 'heading';
	const inner = block.within[block.within.length - 1];
	return inner === 'listItem' ? 'listItem' : inner === 'quote' || inner === 'alert' ? 'quote' : inner === 'footnote' ? 'other' : 'paragraph';
};

/**
 * Reads the text blocks of Markdown `source` for the house-style checks: headings (with their
 * level, ATX or setext), paragraphs, list items, quotes and footnotes, with positions as UTF-16
 * offsets of the source. A block's text is its plain prose: syntax markers are left out, an
 * inline atom that is not prose (code span, math, image, inline HTML) reads as
 * {@link MARKDOWN_STYLE_ATOM}, and a soft line break as a space. Code, math, HTML, tables,
 * front matter and link definitions are not read. Markdown has no fonts or colours, so `runs`
 * is empty.
 */
export function markdownStyleState(source: string, map: MarkdownProseMap = markdownProseMap(source)): RichTextStyleState {
	const blocks: RichTextStyleBlock[] = [];
	let p = 0;
	for (const block of map.blocks) {
		if (block.kind !== 'heading' && block.kind !== 'paragraph') continue;
		while (p < map.prose.length && map.prose[p].to <= block.from && map.prose[p].from < block.from) p++;
		const ranges: Range[] = [];
		while (p < map.prose.length && map.prose[p].from <= block.to) {
			if (map.prose[p].to > map.prose[p].from) ranges.push(map.prose[p]);
			p++;
		}
		const pieces = plainPieces(source, ranges);
		// Where the block's inline content starts and ends: after `# `, `- `, `> `; before a heading's closing `#`s.
		const contentFrom = block.firstText >= 0 ? block.firstText : block.from;
		let contentTo = block.kind === 'heading' ? (pieces.length ? Math.max(pieces[pieces.length - 1].to, endOfHeadingText(source, block)) : block.to) : block.to;
		while (contentTo > contentFrom && /\s/.test(source[contentTo - 1])) contentTo--;
		let text = '';
		const segments: RichTextStyleBlock['segments'] = [];
		let prevEnd = contentFrom;
		for (const piece of pieces) {
			text += gapText(source.slice(prevEnd, piece.from), segments.length > 0);
			segments.push({ offset: text.length, pos: piece.from, length: piece.to - piece.from });
			text += source.slice(piece.from, piece.to);
			prevEnd = piece.to;
		}
		if (segments.length && contentTo > prevEnd) text += gapText(source.slice(prevEnd, contentTo), false);
		const kind = kindOf(block);
		const from = segments.length ? segments[0].pos : block.firstText >= 0 ? block.firstText : block.from;
		const last = segments[segments.length - 1];
		const textEnd = last ? last.pos + last.length : from;
		// A paragraph's content runs to the end of its last line, past closing syntax (`**`, a
		// link's destination, a code span), so what is added at its end goes after them.
		const to = Math.max(textEnd, contentTo);
		blocks.push({
			kind,
			...(kind === 'heading' ? { level: headingLevel(source, block) } : {}),
			text,
			from,
			to,
			segments
		});
	}
	return { blocks, runs: [] };
}

/** A source edit: replace `from..to` (UTF-16 offsets) with `replacement`. */
export interface MarkdownStyleEdit {
	from: number;
	to: number;
	replacement: string;
}

/**
 * Narrows a certain fix to the characters it changes, so the edit keeps the syntax around and
 * inside the text (emphasis, link brackets). A fix that would have to change syntax or an atom
 * to apply (a replacement of a different length across `**`) comes back without a replacement:
 * it is no longer certain.
 */
export function narrowMarkdownStyleTarget(source: string, state: RichTextStyleState, target: RichTextStyleTarget): RichTextStyleTarget {
	const block = state.blocks.find((b) => b.from <= target.from && target.from <= b.to && b.segments.length);
	if (!block) return target;
	// The end of the block's text maps past its last piece of text: to the end of its content.
	const lastSeg = block.segments[block.segments.length - 1];
	const textEnd = lastSeg.pos + lastSeg.length;
	if (target.from === target.to) return target.from >= textEnd ? { ...target, from: block.to, to: block.to } : target;
	if (target.to > textEnd) target = { ...target, to: block.to };
	if (target.replacement === undefined) return target;
	// Each character of the block's text with its source offset (null: a space or atom the reader put in).
	const chars: { ch: string; pos: number | null }[] = [];
	let seg = 0;
	for (let i = 0; i < block.text.length; i++) {
		while (seg < block.segments.length && block.segments[seg].offset + block.segments[seg].length <= i) seg++;
		const s = block.segments[seg];
		chars.push({ ch: block.text[i], pos: s && s.offset <= i ? s.pos + (i - s.offset) : null });
	}
	// A target from the block's start or to its end takes in the spaces and atoms the reader put there.
	const first = target.from <= block.segments[0].pos ? 0 : chars.findIndex((c) => c.pos !== null && c.pos >= target.from);
	let last = -1;
	if (target.to >= textEnd) last = chars.length - 1;
	else
		for (let i = chars.length - 1; i >= 0; i--) {
			const pos = chars[i].pos;
			if (pos !== null && pos < target.to) {
				last = i;
				break;
			}
		}
	if (first < 0 || last < first) return target;
	const picked = chars.slice(first, last + 1);
	const original = picked.map((c) => c.ch).join('');
	const want = target.replacement;
	let pre = 0;
	while (pre < original.length && pre < want.length && original[pre] === want[pre]) pre++;
	let suf = 0;
	while (suf < original.length - pre && suf < want.length - pre && original[original.length - 1 - suf] === want[want.length - 1 - suf]) suf++;
	// Whole words, so the edit reads as one to a person ("utilize" → "use", not "tiliz" → "s").
	while (pre > 0 && isWordChar(original[pre - 1]) && (isWordChar(original[pre]) || isWordChar(want[pre]))) pre--;
	while (suf > 0 && isWordChar(original[original.length - suf]) && (isWordChar(original[original.length - suf - 1]) || isWordChar(want[want.length - suf - 1]))) suf--;
	const middle = picked.slice(pre, picked.length - suf);
	const insert = want.slice(pre, want.length - suf);
	const uncertain = (): RichTextStyleTarget => ({ from: target.from, to: target.to });
	if (!middle.length) {
		// A pure insertion, after the last unchanged character.
		const before = picked[pre - 1];
		const after = picked[pre];
		if (after?.pos != null) return { from: after.pos, to: after.pos, replacement: insert };
		if (before?.pos != null) return { from: before.pos + 1, to: before.pos + 1, replacement: insert };
		return uncertain();
	}
	if (middle.some((c) => c.pos === null)) {
		// Only an edit that leaves the reader's spaces and atoms as they are can be applied.
		if (middle.length !== insert.length || middle.some((c, i) => c.pos === null && insert[i] !== c.ch)) return uncertain();
	}
	const real = middle.filter((c) => c.pos !== null) as { ch: string; pos: number }[];
	if (!real.length) return uncertain();
	const from = real[0].pos;
	const to = real[real.length - 1].pos + 1;
	const contiguous = real.every((c, i) => i === 0 || c.pos === real[i - 1].pos + 1) && real.length === middle.length;
	if (contiguous) return { from, to, replacement: insert };
	if (middle.length !== insert.length) return uncertain();
	// Same length across syntax: change each character in place and keep the syntax between them.
	const byPos = new Map<number, string>();
	middle.forEach((c, i) => {
		if (c.pos !== null) byPos.set(c.pos, insert[i]);
	});
	let replacement = '';
	for (let k = from; k < to; k++) replacement += byPos.get(k) ?? source[k];
	return { from, to, replacement };
}

/** A house-style finding on Markdown source. */
export type MarkdownStyleFinding = Omit<StyleCheckReport['findings'][number], 'target'> & { target?: RichTextStyleTarget };

export interface MarkdownStyleReport extends StyleCheckReport {
	findings: MarkdownStyleFinding[];
	/** The resolved style the checks ran against. */
	style: ResolvedStyle;
}

/** Why the brand's colour and font checks are skipped on Markdown. */
export const MARKDOWN_NO_SURFACE_REASON = 'Markdown source has no fonts or colours, so there is nothing for this check to read.';

export interface CheckMarkdownStyleOptions {
	/** Where the text is used (`report`, ...): skills scoped elsewhere do not apply. */
	scope?: string;
	/** Only these check ids. */
	checks?: readonly string[];
}

/**
 * Runs the document house-style checks (`rich-text` domain) on Markdown source. Findings target
 * UTF-16 ranges of the source; a certain fix is narrowed to what it changes
 * ({@link narrowMarkdownStyleTarget}). The brand's colour and font checks are reported as skipped.
 */
export async function checkMarkdownStyle(source: string, styles: StyleResolver, options: CheckMarkdownStyleOptions = {}): Promise<MarkdownStyleReport> {
	if (!styles.domains.some((d) => d.id === 'rich-text')) throw new Error('The style resolver has no "rich-text" domain; add richTextStyleDomain to its domains.');
	const state = markdownStyleState(source);
	const { style, ...report } = await styles.check('rich-text', state, options.scope !== undefined ? { scope: options.scope } : {});
	const surface = new Set(SHARED_STYLE_CHECKS.map((c) => c.id));
	const findings = report.findings
		.filter((f) => !surface.has(f.check) && (!options.checks || options.checks.includes(f.check)))
		.map((f) => {
			const target = f.target as RichTextStyleTarget | undefined;
			const { target: _target, ...rest } = f;
			return target && typeof target.from === 'number' ? { ...rest, target: narrowMarkdownStyleTarget(source, state, target) } : rest;
		});
	return {
		findings,
		ran: report.ran.filter((id) => !surface.has(id)),
		skipped: [
			...report.skipped.map((s) => (surface.has(s.check) ? { check: s.check, reason: MARKDOWN_NO_SURFACE_REASON } : s)),
			...report.ran.filter((id) => surface.has(id)).map((check) => ({ check, reason: MARKDOWN_NO_SURFACE_REASON }))
		],
		style
	};
}

/**
 * The fixes of `findings` that are certain, as non-overlapping source edits in order. Of two
 * overlapping fixes the first is kept; run the check again for the other.
 */
export function markdownStyleEdits(findings: readonly MarkdownStyleFinding[]): { edits: MarkdownStyleEdit[]; overlapping: number } {
	const certain = findings
		.map((f) => f.target)
		.filter((t): t is RichTextStyleTarget & { replacement: string } => t?.replacement !== undefined)
		.sort((a, b) => a.from - b.from || a.to - b.to);
	const edits: MarkdownStyleEdit[] = [];
	let overlapping = 0;
	let end = -1;
	for (const t of certain) {
		const prev = edits[edits.length - 1];
		// Two insertions at one place would land in an unknown order; an insertion right after a replacement is fine.
		if (t.from < end || (prev && t.from === t.to && prev.from === prev.to && prev.from === t.from)) {
			overlapping++;
			continue;
		}
		edits.push({ from: t.from, to: t.to, replacement: t.replacement });
		end = t.to;
	}
	return { edits, overlapping };
}

/** Applies non-overlapping edits (in any order) to `source`. */
export function applyMarkdownStyleEdits(source: string, edits: readonly MarkdownStyleEdit[]): string {
	let out = source;
	for (const e of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.replacement + out.slice(e.to);
	return out;
}

/** The Markdown text the house-style tools work on. */
export interface MarkdownStyleHost {
	/** The Markdown source as it is now. */
	getText(): string;
	/**
	 * Applies `edits` (UTF-16 ranges of the text as `getText` returned it; they never overlap) as
	 * one undo step named `actionName`. Leave it out for a read-only text.
	 */
	applyEdits?(edits: readonly MarkdownStyleEdit[], actionName: string): void;
	/** Why the text can't be edited now (a read-only document), or null. */
	readOnlyReason?(): string | null;
}

export interface MarkdownStyleToolProviderOptions {
	/** Provider id (unique per registry). Default `markdown-style`. */
	id?: string;
	/** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Where the tools work (`report`, ...): skills scoped elsewhere do not apply. Set by the host. */
	scope?: string;
}

const describeFinding = (source: string, f: MarkdownStyleFinding) => ({
	...f,
	...(f.target ? { text: source.slice(f.target.from, f.target.to) } : {})
});

/**
 * `check_rich_text_style` and, while the host can apply edits and isn't read-only,
 * `fix_rich_text_style`, for Markdown source: the same tools a rich-text document has, with
 * positions as UTF-16 offsets of the source.
 */
export function createMarkdownStyleToolProvider(host: MarkdownStyleHost, styles: StyleResolver, options: MarkdownStyleToolProviderOptions = {}): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'rich-text')) throw new Error('The style resolver has no "rich-text" domain; add richTextStyleDomain to its domains.');
	const writable = () => !!host.applyEdits && !host.readOnlyReason?.();
	const checkOptions = (checks?: string[]): CheckMarkdownStyleOptions => ({ ...(options.scope !== undefined ? { scope: options.scope } : {}), ...(checks ? { checks } : {}) });

	const check: AgentTool = {
		name: 'check_rich_text_style',
		title: 'Check Markdown house style',
		description:
			'Checks the Markdown text against the house style (see get_style with domain "rich-text"): runs the checks its profile turns on (heading-case, heading-levels, list-punctuation, quotes, terms, number-format, date-format) on the prose only: code, math, HTML, tables, front matter, link addresses and syntax markers are never checked. Returns findings with a severity, a sentence saying how to fix it, a target {from, to} range of UTF-16 offsets into the source (with the replacement when the fix is certain), the text there and the layer that asked; the checks that ran and those skipped (the brand\'s colour and font checks always are: Markdown has none). fix_rich_text_style applies every certain fix at once.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Check Markdown house style', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async () => {
			const source = host.getText();
			const { style, ...report } = await checkMarkdownStyle(source, styles, checkOptions());
			return {
				...report,
				findings: report.findings.map((f) => describeFinding(source, f)),
				ok: report.findings.length === 0,
				fixable: report.findings.filter((f) => f.target?.replacement !== undefined).length,
				...(style.skills.length ? {} : { note: 'No house style applies to documents.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};

	const fix: AgentTool = {
		name: 'fix_rich_text_style',
		title: 'Fix Markdown house style',
		description:
			'Applies every house-style fix whose replacement is certain (heading case, list endings, quotation marks, terms with a replacement, number and date formats) to the Markdown text, as one undo step, keeping its syntax. Pass checks to limit it to some checks. Returns how many it fixed, the edits it made ({from, to, replacement} in the source before the fix) and the findings it left for you (no certain replacement: rephrase or restructure those yourself). Run check_rich_text_style again after.',
		inputSchema: {
			type: 'object',
			properties: {
				checks: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Only fix findings of these check ids (default: all).' }
			},
			additionalProperties: false
		},
		annotations: { title: 'Fix Markdown house style', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async ({ checks }) => {
			const reason = host.readOnlyReason?.();
			if (reason) throw new Error(reason);
			if (!host.applyEdits) throw new Error('The text is read-only, so its house style cannot be fixed.');
			const source = host.getText();
			const report = await checkMarkdownStyle(source, styles, checkOptions(checks));
			const { edits, overlapping } = markdownStyleEdits(report.findings);
			if (edits.length) host.applyEdits(edits, 'Fix House Style');
			const left = report.findings.filter((f) => f.target?.replacement === undefined).map((f) => describeFinding(source, f));
			return { fixed: edits.length, edits, left, ...(overlapping ? { note: `${overlapping} overlapping fixes were left; run fix_rich_text_style again.` } : {}) };
		}
	};

	return {
		id: options.id ?? 'markdown-style',
		namespace: options.namespace,
		title: 'Markdown house style',
		description: 'Check Markdown text against the house style and apply its certain fixes.',
		skill: 'pixerate-rich-text',
		tools: () => (writable() ? [check, fix] : [check])
	};
}
