/**
 * House style for documents (#778): the `rich-text.json` profile (heading case and levels,
 * list item endings, quotation marks, preferred terms, number and date formats, fonts and text
 * colours), its checks, and `check_rich_text_style` / `fix_rich_text_style`.
 *
 * The domain works on {@link RichTextStyleState}, a plain list of text blocks and styled runs
 * with document positions, so its checks need no editor; `richTextStyleState(doc)` reads one
 * from a ProseMirror document. Findings target `{ from, to }` ranges that `replace_range`
 * accepts, with the `replacement` when the fix is certain.
 */
import type { AgentTool, AgentToolProvider } from './tools/registry.js';
import type { StyleCheck, StyleDomain, StyleResolver } from './tools/style.js';
import type { StyleSurface, StyleSurfaceColor } from './tools/style-surface.js';
import { brandFonts, brandPalette } from './tools/brand.js';

/** A text block: a heading, paragraph, list item, quote or code block. */
export interface RichTextStyleBlock {
	kind: 'heading' | 'paragraph' | 'listItem' | 'quote' | 'code' | 'other';
	/** Heading level (1–6). */
	level?: number;
	/** The block's text (inline atoms such as images are left out). */
	text: string;
	/** Document positions of the block's content. */
	from: number;
	to: number;
	/** Where each text node of the block starts: its offset in `text` and its document position. */
	segments: { offset: number; pos: number; length: number }[];
}

/** A run of text with its character styling. */
export interface RichTextStyleRun {
	text: string;
	from: number;
	to: number;
	color?: string;
	highlight?: string;
	fontFamily?: string;
	/** px, when the run sets one. */
	fontSize?: number;
	bold?: boolean;
}

/** What the rich-text house-style checks read. */
export interface RichTextStyleState {
	blocks: RichTextStyleBlock[];
	runs: RichTextStyleRun[];
}

/** The `rich-text.json` profile, after `$token` references are resolved. */
export interface RichTextStyleProfile {
	headingCase?: 'sentence' | 'title' | 'upper';
	maxHeadingLevel?: number;
	properNouns?: string[];
	listItemEnd?: 'none' | 'period';
	quotes?: 'curly' | 'straight';
	terms?: { avoid: string; use?: string; note?: string }[];
	thousandsSeparator?: ',' | '.' | ' ' | 'thin' | 'none';
	dateFormat?: 'iso' | 'day-month-year' | 'month-day-year';
	fonts?: string[];
	palette?: string[];
}

/** A finding's target: the range to change, and the text to put there when the fix is certain. */
export interface RichTextStyleTarget {
	from: number;
	to: number;
	replacement?: string;
}

/** The structural parts of a ProseMirror node `richTextStyleState` reads (no editor import). */
interface DocNode {
	type: { name: string };
	attrs: Record<string, any>;
	isText?: boolean;
	isTextblock?: boolean;
	text?: string;
	marks?: readonly { type: { name: string }; attrs: Record<string, any> }[];
	content: { size: number };
	forEach(fn: (child: DocNode, offset: number) => void): void;
	descendants(fn: (node: DocNode, pos: number, parent: DocNode | null) => boolean | void): void;
}

const px = (value: unknown): number | undefined => {
	if (typeof value === 'number') return value;
	const m = typeof value === 'string' ? /^([\d.]+)(px|pt)?$/.exec(value.trim()) : null;
	return m ? Number(m[1]) * (m[2] === 'pt' ? 4 / 3 : 1) : undefined;
};

/** Reads the blocks and styled runs of a ProseMirror document (an editor's `state.doc`). */
export function richTextStyleState(doc: DocNode): RichTextStyleState {
	const blocks: RichTextStyleBlock[] = [];
	const runs: RichTextStyleRun[] = [];
	const ancestry: string[] = [];
	const visit = (node: DocNode, pos: number, parents: string[]) => {
		if (node.isTextblock) {
			const name = node.type.name;
			const kind: RichTextStyleBlock['kind'] =
				name === 'heading' ? 'heading' : name === 'codeBlock' ? 'code' : parents.includes('listItem') || parents.includes('taskItem') ? 'listItem' : parents.includes('blockquote') ? 'quote' : parents.some((p) => p === 'tableCell' || p === 'tableHeader') ? 'other' : name === 'paragraph' ? 'paragraph' : 'other';
			let text = '';
			const segments: RichTextStyleBlock['segments'] = [];
			node.forEach((child, offset) => {
				if (!child.isText || !child.text) return;
				const at = pos + 1 + offset;
				segments.push({ offset: text.length, pos: at, length: child.text.length });
				text += child.text;
				const run: RichTextStyleRun = { text: child.text, from: at, to: at + child.text.length };
				for (const mark of child.marks ?? []) {
					const m = mark.type.name;
					if (m === 'textStyle') {
						if (typeof mark.attrs.color === 'string' && mark.attrs.color) run.color = mark.attrs.color;
						if (typeof mark.attrs.fontFamily === 'string' && mark.attrs.fontFamily) run.fontFamily = mark.attrs.fontFamily;
						const size = px(mark.attrs.fontSize);
						if (size) run.fontSize = size;
					} else if (m === 'highlight' && typeof mark.attrs.color === 'string') run.highlight = mark.attrs.color;
					else if (m === 'bold') run.bold = true;
				}
				if (run.color || run.highlight || run.fontFamily || run.fontSize) runs.push(run);
			});
			blocks.push({ kind, ...(kind === 'heading' ? { level: Number(node.attrs.level) || 1 } : {}), text, from: pos + 1, to: pos + 1 + node.content.size, segments });
			return;
		}
		parents.push(node.type.name);
		node.forEach((child, offset) => visit(child, pos + 1 + offset, parents));
		parents.pop();
	};
	// The document node's children start at position 0.
	doc.forEach((child, offset) => visit(child, offset, ancestry));
	return { blocks, runs };
}

/** The document position of character `offset` of a block. */
export function richTextBlockPos(block: RichTextStyleBlock, offset: number): number {
	let seg = block.segments[0];
	for (const s of block.segments) if (s.offset <= offset) seg = s;
	return seg ? seg.pos + (offset - seg.offset) : block.from;
}

const profileOf = (p: Readonly<Record<string, unknown>>) => p as RichTextStyleProfile;
const targetOf = (block: RichTextStyleBlock, start: number, end: number, replacement?: string): RichTextStyleTarget => ({
	from: richTextBlockPos(block, start),
	to: richTextBlockPos(block, end),
	...(replacement !== undefined ? { replacement } : {})
});
const prose = (state: RichTextStyleState) => state.blocks.filter((b) => b.kind !== 'code');
const quote = (text: string) => `"${text.length > 60 ? `${text.slice(0, 57)}...` : text}"`;

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'or', 'over', 'per', 'so', 'the', 'to', 'up', 'via', 'vs', 'with', 'yet']);

/** `text` in the house heading case, keeping acronyms, words with digits and proper nouns. */
export function richTextHeadingCase(text: string, kind: 'sentence' | 'title' | 'upper', properNouns: readonly string[] = []): string {
	if (kind === 'upper') return text.toUpperCase();
	const nouns = new Map(properNouns.map((n) => [n.toLowerCase(), n]));
	const words = text.split(/(\s+)/);
	const wordIndexes = words.map((w, i) => (/\S/.test(w) ? i : -1)).filter((i) => i >= 0);
	const first = wordIndexes[0];
	const last = wordIndexes[wordIndexes.length - 1];
	let afterColon = false;
	return words
		.map((w, i) => {
			if (!/\S/.test(w)) return w;
			const startsSentence = i === first || afterColon;
			afterColon = /[:.!?]$/.test(w);
			const bare = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
			const lower = bare.toLowerCase();
			if (!bare) return w;
			if (nouns.has(lower)) return w.replace(bare, nouns.get(lower)!);
			// Acronyms (API, NASA), words with digits or inner capitals (iOS, Q3) stay as written.
			if ((bare.length > 1 && bare === bare.toUpperCase() && /\p{L}/u.test(bare)) || /\d/.test(bare) || /^\p{Ll}+\p{Lu}/u.test(bare) || /\p{Ll}\p{Lu}/u.test(bare.slice(1))) return w;
			const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
			if (kind === 'sentence') return w.replace(bare, startsSentence ? cap(lower) : lower);
			const small = SMALL_WORDS.has(lower) && i !== first && i !== last && !startsSentence;
			return w.replace(bare, small ? lower : cap(bare));
		})
		.join('');
}

const headingCase: StyleCheck<RichTextStyleState> = {
	id: 'heading-case',
	description: 'Headings use the house case ("headingCase": sentence, title or upper), keeping acronyms, words with digits and the profile\'s "properNouns".',
	run(state, profile) {
		const { headingCase: kind, properNouns = [] } = profileOf(profile);
		if (!kind) throw new Error('the profile has no "headingCase".');
		return state.blocks
			.filter((b) => b.kind === 'heading' && b.text.trim())
			.flatMap((b) => {
				const want = richTextHeadingCase(b.text, kind, properNouns);
				if (want === b.text) return [];
				return [{ severity: 'warning' as const, message: `Heading ${quote(b.text)} is not in ${kind} case; write ${quote(want)}.`, target: targetOf(b, 0, b.text.length, want) }];
			});
	}
};

const headingLevels: StyleCheck<RichTextStyleState> = {
	id: 'heading-levels',
	description: 'Headings go no deeper than "maxHeadingLevel" (default 6) and never skip a level (a level 2 heading before any level 3).',
	run(state, profile) {
		const max = profileOf(profile).maxHeadingLevel ?? 6;
		const out = [];
		let prev = 0;
		for (const b of state.blocks) {
			if (b.kind !== 'heading' || !b.level) continue;
			if (b.level > max) out.push({ severity: 'warning' as const, message: `Heading ${quote(b.text)} is level ${b.level}; the house style goes to level ${max}. Promote it or make it bold text.`, target: targetOf(b, 0, b.text.length) });
			else if (b.level > prev + 1) out.push({ severity: 'warning' as const, message: `Heading ${quote(b.text)} is level ${b.level} after ${prev ? `level ${prev}` : 'no heading'}; use level ${prev + 1} so no level is skipped.`, target: targetOf(b, 0, b.text.length) });
			prev = b.level;
		}
		return out;
	}
};

const listItemEnd: StyleCheck<RichTextStyleState> = {
	id: 'list-punctuation',
	description: 'List items end the house way ("listItemEnd": "none", no full stop, or "period", a full stop).',
	run(state, profile) {
		const end = profileOf(profile).listItemEnd;
		if (!end) throw new Error('the profile has no "listItemEnd".');
		const out = [];
		for (const b of state.blocks) {
			if (b.kind !== 'listItem') continue;
			const trimmed = b.text.replace(/\s+$/, '');
			if (!trimmed) continue;
			const last = trimmed.length;
			if (end === 'none' && /[^.]\.$/.test(trimmed)) out.push({ severity: 'info' as const, message: `List item ${quote(trimmed)} ends with a full stop; house list items have none.`, target: targetOf(b, last - 1, last, '') });
			if (end === 'period' && !/[.!?:…]$/.test(trimmed)) out.push({ severity: 'info' as const, message: `List item ${quote(trimmed)} has no full stop; house list items end with one.`, target: targetOf(b, last, last, '.') });
		}
		return out;
	}
};

const MAX_PER_CHECK = 200;

const quotes: StyleCheck<RichTextStyleState> = {
	id: 'quotes',
	description: 'Quotation marks and apostrophes are curly (“ ” ‘ ’) or straight (" \') as "quotes" says. Code is left alone.',
	run(state, profile) {
		const kind = profileOf(profile).quotes;
		if (!kind) throw new Error('the profile has no "quotes".');
		const out = [];
		for (const b of prose(state)) {
			const re = kind === 'curly' ? /["']/g : /[“”‘’]/g;
			for (const m of b.text.matchAll(re)) {
				if (out.length >= MAX_PER_CHECK) return out;
				const i = m.index!;
				const ch = m[0];
				const before = b.text[i - 1] ?? '';
				let want: string;
				if (kind === 'straight') want = ch === '“' || ch === '”' ? '"' : "'";
				else if (ch === "'") want = /[\p{L}\p{N}]/u.test(before) ? '’' : '‘';
				else want = !before || /[\s([{—–-]/.test(before) ? '“' : '”';
				out.push({ severity: 'info' as const, message: `Use ${want} instead of ${ch} in ${quote(b.text)}.`, target: targetOf(b, i, i + 1, want) });
			}
		}
		return out;
	}
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const terms: StyleCheck<RichTextStyleState> = {
	id: 'terms',
	description: 'Words the house style avoids ("terms": { avoid, use?, note? }) do not appear, matched as whole words in any case. Code is left alone.',
	run(state, profile) {
		const list = profileOf(profile).terms;
		if (!list?.length) throw new Error('the profile has no "terms".');
		const out = [];
		for (const term of list) {
			const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(term.avoid)}(?![\\p{L}\\p{N}])`, 'giu');
			for (const b of prose(state)) {
				for (const m of b.text.matchAll(re)) {
					if (out.length >= MAX_PER_CHECK) return out;
					const found = m[0];
					const use = term.use === undefined ? undefined : found[0] === found[0].toUpperCase() && found[0] !== found[0].toLowerCase() ? term.use.charAt(0).toUpperCase() + term.use.slice(1) : term.use;
					out.push({
						severity: 'warning' as const,
						message: `Avoid "${found}"${use !== undefined ? `; write "${use}"` : ''}${term.note ? ` (${term.note})` : ''}.`,
						target: targetOf(b, m.index!, m.index! + found.length, use)
					});
				}
			}
		}
		return out;
	}
};

const SEPARATORS = { ',': ',', '.': '.', ' ': ' ', thin: ' ', none: '' } as const;

const group = (digits: string, sep: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);

const numbers: StyleCheck<RichTextStyleState> = {
	id: 'number-format',
	description: 'Numbers of five digits or more group thousands the house way ("thousandsSeparator": ",", ".", " ", "thin" or "none"). Four-digit numbers (years) and code are left alone.',
	run(state, profile) {
		const key = profileOf(profile).thousandsSeparator;
		if (!key) throw new Error('the profile has no "thousandsSeparator".');
		const sep = SEPARATORS[key];
		const out = [];
		const re = /(?<![\d., ])(\d{1,3}(?:([,.  ])\d{3})+|\d{5,})(?![\d]|[.,]\d)/g;
		for (const b of prose(state)) {
			for (const m of b.text.matchAll(re)) {
				if (out.length >= MAX_PER_CHECK) return out;
				const found = m[1];
				const digits = found.replace(/[,.  ]/g, '');
				if (digits.length < 5) continue;
				const want = group(digits, sep);
				if (want === found) continue;
				out.push({ severity: 'info' as const, message: `Write ${found} as ${want}${key === 'thin' ? ' (thin spaces)' : ''}.`, target: targetOf(b, m.index!, m.index! + found.length, want) });
			}
		}
		return out;
	}
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH = `(${MONTHS.join('|')}|${MONTHS.map((m) => m.slice(0, 3)).join('|')})\\.?`;
const monthIndex = (name: string) => MONTHS.findIndex((m) => m.slice(0, 3).toLowerCase() === name.slice(0, 3).toLowerCase());

const dates: StyleCheck<RichTextStyleState> = {
	id: 'date-format',
	description: 'Dates are written the house way ("dateFormat": "iso" 2026-11-12, "day-month-year" 12 November 2026, or "month-day-year" November 12, 2026). Numeric dates with slashes are flagged as ambiguous.',
	run(state, profile) {
		const format = profileOf(profile).dateFormat;
		if (!format) throw new Error('the profile has no "dateFormat".');
		const write = (y: number, m: number, d: number) =>
			format === 'iso' ? `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}` : format === 'day-month-year' ? `${d} ${MONTHS[m]} ${y}` : `${MONTHS[m]} ${d}, ${y}`;
		const patterns: { re: RegExp; read: (m: RegExpMatchArray) => [number, number, number] | null; is: typeof format | 'numeric' }[] = [
			{ re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, read: (m) => [Number(m[1]), Number(m[2]) - 1, Number(m[3])], is: 'iso' },
			{ re: new RegExp(`\\b(\\d{1,2}) ${MONTH} (\\d{4})\\b`, 'gi'), read: (m) => [Number(m[3]), monthIndex(m[2]), Number(m[1])], is: 'day-month-year' },
			{ re: new RegExp(`\\b${MONTH} (\\d{1,2}),? (\\d{4})\\b`, 'gi'), read: (m) => [Number(m[3]), monthIndex(m[1]), Number(m[2])], is: 'month-day-year' },
			{ re: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, read: () => null, is: 'numeric' }
		];
		const out = [];
		for (const b of prose(state)) {
			for (const p of patterns) {
				for (const m of b.text.matchAll(p.re)) {
					if (out.length >= MAX_PER_CHECK) return out;
					const read = p.read(m);
					if (!read) {
						out.push({ severity: 'warning' as const, message: `${m[0]} can be read as two different dates; write it as ${write(2026, 10, 12).replace('2026', 'YYYY')}-style.`, target: targetOf(b, m.index!, m.index! + m[0].length) });
						continue;
					}
					const [y, mo, d] = read;
					if (mo < 0 || d < 1 || d > 31) continue;
					const want = write(y, mo, d);
					if (p.is === format && want === m[0]) continue;
					out.push({ severity: 'info' as const, message: `Write ${m[0]} as ${want}.`, target: targetOf(b, m.index!, m.index! + m[0].length, want) });
				}
			}
		}
		return out;
	}
};

/** The colours and fonts a document uses, for the shared checks. */
export function richTextStyleSurface(state: RichTextStyleState): StyleSurface {
	const colors: StyleSurfaceColor[] = [];
	const fonts: StyleSurface['fonts'] = [];
	for (const r of state.runs) {
		const label = `Text ${quote(r.text)}`;
		const target = { from: r.from, to: r.to };
		if (r.color) colors.push({ color: r.color, label, target, use: 'text', ...(r.highlight ? { background: r.highlight } : {}), ...(r.fontSize ? { fontSize: r.fontSize } : {}), ...(r.bold ? { bold: true } : {}) });
		if (r.highlight) colors.push({ color: r.highlight, label: `Highlight on ${quote(r.text)}`, target, use: 'background' });
		if (r.fontFamily) fonts.push({ family: r.fontFamily, label, target });
	}
	return { colors, fonts };
}

/** The document house-style domain: register it with `createStyleResolver({ domains })`. */
export const richTextStyleDomain: StyleDomain<RichTextStyleState> = {
	id: 'rich-text',
	title: 'Documents',
	description:
		'How documents read: heading case and depth, list item endings, quotation marks, preferred terms, number and date formats, and the fonts and text colours allowed. Findings target ranges that replace_range accepts, with the replacement when the fix is certain.',
	profileSchema: {
		type: 'object',
		properties: {
			headingCase: { type: 'string', enum: ['sentence', 'title', 'upper'], description: 'Case for headings: "sentence" (Only the first word), "title" (Major Words Capitalised) or "upper".' },
			maxHeadingLevel: { type: 'integer', minimum: 1, maximum: 6, description: 'Deepest heading level allowed (default 6).' },
			properNouns: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Names written exactly as given in any heading case, e.g. "GitHub", "Pixerate".' },
			listItemEnd: { type: 'string', enum: ['none', 'period'], description: 'How list items end: no full stop, or a full stop.' },
			quotes: { type: 'string', enum: ['curly', 'straight'], description: 'Quotation marks and apostrophes: curly (“ ” ‘ ’) or straight (" \').' },
			terms: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						avoid: { type: 'string', minLength: 1, description: 'Word or phrase to avoid (whole words, any case).' },
						use: { type: 'string', description: 'What to write instead (empty: delete it).' },
						note: { type: 'string', description: 'Why, shown with the finding.' }
					},
					required: ['avoid'],
					additionalProperties: false
				},
				description: 'Banned or replaced words and phrases.'
			},
			thousandsSeparator: { type: 'string', enum: [',', '.', ' ', 'thin', 'none'], description: 'Thousands separator for numbers of five digits or more ("thin": a narrow no-break space).' },
			dateFormat: { type: 'string', enum: ['iso', 'day-month-year', 'month-day-year'], description: 'How to write dates: 2026-11-12, 12 November 2026 or November 12, 2026.' },
			fonts: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Font families allowed in text (for fonts-allowed). Default: the brand fonts.' },
			palette: { type: 'array', items: { type: 'string', minLength: 1, description: 'A CSS colour, or a { "$token": ... } reference.' }, description: 'Text and highlight colours allowed (for palette-only). Default: the brand palette and roles.' }
		},
		additionalProperties: false
	},
	checks: [headingCase, headingLevels, listItemEnd, quotes, terms, numbers, dates],
	surface: richTextStyleSurface,
	themeFromBrand: (brand) => {
		const fonts = brandFonts(brand);
		const palette = brandPalette(brand);
		return { ...(fonts.length ? { fonts } : {}), ...(palette.length ? { palette } : {}) };
	},
	example: {
		headingCase: 'sentence',
		maxHeadingLevel: 3,
		properNouns: ['Acme', 'GitHub'],
		listItemEnd: 'none',
		quotes: 'curly',
		terms: [
			{ avoid: 'utilize', use: 'use' },
			{ avoid: 'click here', note: 'link text says where it goes' }
		],
		thousandsSeparator: ',',
		dateFormat: 'day-month-year',
		checks: ['heading-case', 'heading-levels', 'list-punctuation', 'quotes', 'terms', 'number-format', 'date-format', 'fonts-allowed']
	}
};

export interface RichTextStyleToolProviderOptions {
	/** Provider id (unique per registry). Default `rich-text-style`. */
	id?: string;
	/** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Where the tools work (`report`, ...): skills scoped elsewhere do not apply. Set by the host. */
	scope?: string;
}

/** The editor parts the provider uses (a TipTap `Editor`). */
interface StyleEditor {
	state: { doc: DocNode; tr: { insertText(text: string, from: number, to: number): unknown } };
	isEditable: boolean;
	view: { dispatch(tr: any): void };
}

/**
 * `check_rich_text_style` (runs the document house-style checks) and, while the editor is
 * editable, `fix_rich_text_style` (applies every certain fix as one undo step).
 */
export function createRichTextStyleToolProvider(target: StyleEditor | { editor: StyleEditor }, styles: StyleResolver, options: RichTextStyleToolProviderOptions = {}): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'rich-text')) throw new Error('The style resolver has no "rich-text" domain; add richTextStyleDomain to its domains.');
	const editor = (): StyleEditor => ('state' in target ? target : target.editor);
	const scope = options.scope !== undefined ? { scope: options.scope } : {};
	const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

	const run = async (only?: string[]) => {
		const { style, ...report } = await styles.check('rich-text', richTextStyleState(editor().state.doc), scope);
		const findings = only ? report.findings.filter((f) => only.includes(f.check)) : report.findings;
		return { report: { ...report, findings }, style };
	};

	const check: AgentTool = {
		name: 'check_rich_text_style',
		title: 'Check document house style',
		description:
			'Checks the document against the house style (see get_style with domain "rich-text"): runs the checks its profile turns on (heading-case, heading-levels, list-punctuation, quotes, terms, number-format, date-format, and the brand\'s palette-only, min-contrast, fonts-allowed on text colours and fonts). Returns findings with a severity, a sentence saying how to fix it, a target {from, to} range for replace_range (with the replacement when the fix is certain) and the layer that asked; the checks that ran and those skipped. fix_rich_text_style applies every certain fix at once.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Check document house style', ...READ },
		handler: async () => {
			const { report, style } = await run();
			return {
				...report,
				ok: report.findings.length === 0,
				fixable: report.findings.filter((f) => (f.target as RichTextStyleTarget | undefined)?.replacement !== undefined).length,
				...(style.skills.length ? {} : { note: 'No house style applies to documents.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};

	const fix: AgentTool = {
		name: 'fix_rich_text_style',
		title: 'Fix document house style',
		description:
			'Applies every house-style fix whose replacement is certain (heading case, list endings, quotation marks, terms with a replacement, number and date formats), as one undo step. Pass checks to limit it to some checks. Returns how many it fixed and the findings it left for you (no certain replacement: rephrase or restructure those with replace_range). Run check_rich_text_style again after.',
		inputSchema: {
			type: 'object',
			properties: {
				checks: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Only fix findings of these check ids (default: all).' }
			},
			additionalProperties: false
		},
		annotations: { title: 'Fix document house style', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async ({ checks }) => {
			const ed = editor();
			if (!ed.isEditable) throw new Error('The document is read-only, so its house style cannot be fixed.');
			const { report } = await run(checks);
			const certain = report.findings
				.map((f) => ({ f, t: f.target as RichTextStyleTarget | undefined }))
				.filter((x): x is { f: (typeof report.findings)[number]; t: RichTextStyleTarget & { replacement: string } } => x.t?.replacement !== undefined);
			// Later ranges first, so earlier positions stay valid; overlapping fixes are left for the next run.
			certain.sort((a, b) => b.t.from - a.t.from || b.t.to - a.t.to);
			const tr = ed.state.tr;
			let lowest = Infinity;
			let fixed = 0;
			for (const { t } of certain) {
				if (t.to > lowest) continue;
				tr.insertText(t.replacement, t.from, t.to);
				lowest = t.from;
				fixed++;
			}
			if (fixed) ed.view.dispatch(tr);
			const left = report.findings.filter((f) => (f.target as RichTextStyleTarget | undefined)?.replacement === undefined);
			return { fixed, left, ...(fixed < certain.length ? { note: `${certain.length - fixed} overlapping fixes were left; run fix_rich_text_style again.` } : {}) };
		}
	};

	return {
		id: options.id ?? 'rich-text-style',
		namespace: options.namespace,
		title: 'Document house style',
		description: 'Check a document against the house style and apply its certain fixes.',
		skill: 'pixerate-rich-text',
		tools: () => (editor().isEditable ? [check, fix] : [check])
	};
}
