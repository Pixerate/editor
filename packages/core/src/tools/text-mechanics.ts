/**
 * Text mechanics (#892): the small, certain fixes a writer expects as they type, as checks over
 * Markdown source. Capital I, missing apostrophes, sentence capitals, a full stop or question
 * mark at the end of a finished line, `OK`, a comma before a "but" that starts a clause, and
 * spelling from a checker the host supplies. Swash's writing partner fixes these as you type,
 * and agents can check and fix a whole text (`createTextMechanicsToolProvider`).
 *
 * The checks are deterministic and run per word boundary, fast enough for every keystroke
 * (`textMechanicsEditsAt`), or over a whole text (`textMechanicsFindings`). Words that are also
 * real words (`its`, `id`, `ill`) and the comma before "but" need a word-class tagger, which the
 * host supplies (`NLTagger` in Swift); without one those fixes are skipped. Positions are UTF-16
 * offsets, as JavaScript strings and `NSString` count them. The Swift port in PixerateMarkdown
 * reproduces the recorded typing scenarios exactly (`textMechanicsContracts`).
 */
import { markdownProseMap, type MarkdownProseMap } from './markdown-prose.js';

/** One kind of fix, with its own switch and its own learning. */
export type TextMechanicsCheckId =
	| 'pronoun-i'
	| 'contractions'
	| 'sentence-case'
	| 'terminal-punctuation'
	| 'capitals'
	| 'clause-comma'
	| 'spelling'
	| 'curly-quotes'
	| 'dashes'
	| 'ellipses';

export const TEXT_MECHANICS_CHECKS: readonly {
	id: TextMechanicsCheckId;
	title: string;
	description: string;
}[] = [
	{
		id: 'pronoun-i',
		title: 'Capital I',
		description: "`i` → `I`, `i'm` → `I'm`."
	},
	{
		id: 'contractions',
		title: 'Apostrophes',
		description: "Missing apostrophes: `dont` → `don't`; `its`, `id` and `ill` only when the tagger reads them as a contraction."
	},
	{
		id: 'sentence-case',
		title: 'Capitals at the start of sentences',
		description: 'A capital letter to start a sentence, a line, a heading or a paragraph.'
	},
	{
		id: 'terminal-punctuation',
		title: 'Full stops and question marks',
		description: 'A full stop or question mark at the end of a finished line of four or more words, in a paragraph.'
	},
	{ id: 'capitals', title: 'Capitals in OK', description: '`ok` → `OK`.' },
	{
		id: 'clause-comma',
		title: 'Commas before “but”',
		description: 'A comma before "but" when it joins two clauses: "It works, but it is slow".'
	},
	{
		id: 'spelling',
		title: 'Spelling',
		description: "Misspellings, as the host's spell checker corrects them."
	},
	{
		id: 'curly-quotes',
		title: 'Curly quotes',
		description: "Straight quotes and apostrophes become curly in prose: `\"done\"` → `“done”`, `don't` → `don’t`. Off unless turned on."
	},
	{
		id: 'dashes',
		title: 'Dashes',
		description: 'Dashes in prose: a spaced `--` becomes an en dash (word – word), `--` between words and `---` an em dash (word—word); never a `--flag`. Off unless turned on.'
	},
	{
		id: 'ellipses',
		title: 'Ellipses',
		description: '`...` becomes an ellipsis (…) in prose. Off unless turned on.'
	}
];

/** Checks that run only when the host turns them on (`enabled`): typography changes what a Markdown source holds. */
export const TEXT_MECHANICS_OFF_BY_DEFAULT: ReadonlySet<TextMechanicsCheckId> = new Set(['curly-quotes', 'dashes', 'ellipses']);

/** Chat shorthand the spell checker leaves alone in the `chat` profile. */
export const TEXT_MECHANICS_CHAT_WORDS: ReadonlySet<string> = new Set([
	'ok', 'okay', 'kk', 'lol', 'lmao', 'rofl', 'haha', 'hehe', 'omg', 'wtf', 'brb', 'btw', 'idk', 'ikr',
	'imo', 'imho', 'tbh', 'ngl', 'smh', 'nvm', 'pls', 'plz', 'thx', 'ty', 'tysm', 'yw', 'np', 'jk', 'fyi',
	'afaik', 'iirc', 'fwiw', 'tldr', 'icymi', 'irl', 'lgtm', 'sgtm', 'ack', 'nack', 'wip', 'eta', 'eod',
	'eow', 'ooo', 'pto', 'wfh', 'afk', 'asap', 'atm', 'rn', 'cya', 'ttyl', 'gtg', 'dm', 'dms', 'pr', 'prs',
	'yeah', 'yea', 'yep', 'yup', 'nope', 'nah', 'meh', 'hmm', 'oof', 'yay', 'tho', 'thru', 'cuz', 'cos',
	'gonna', 'wanna', 'gotta', 'kinda', 'sorta', 'dunno', 'lemme', 'gimme', 'prolly', 'probs', 'obv', 'def',
	'tmrw', 'ppl', 'msg', 'msgs', 'sec', 'mins', 'hrs', 'grats', 'congrats'
]);

/** Word classes the checks ask a tagger for. */
export type TextMechanicsWordClass = 'noun' | 'verb' | 'adjective' | 'adverb' | 'pronoun' | 'determiner' | 'preposition' | 'conjunction' | 'interjection' | 'other';

/** The words of `text` with their classes (UTF-16 ranges), punctuation and spaces left out. */
export type TextMechanicsTagger = (text: string) => { from: number; to: number; tag: TextMechanicsWordClass }[];

/** A spelling correction for the misspelt `word` at `from` in `text`, or nothing. */
export type TextMechanicsSpelling = (word: string, from: number, text: string) => string | null | undefined;

export interface TextMechanicsOptions {
	/** `chat` is a light touch for chat (Slack): no sentence capitals, full stops, `OK` or commas. Default `prose`. */
	profile?: 'prose' | 'chat';
	/** Which checks run (default: all but `TEXT_MECHANICS_OFF_BY_DEFAULT`; `spelling` only with `spelling`). */
	enabled?: (check: TextMechanicsCheckId) => boolean;
	/** For a newline boundary: whether Enter was pressed at the end of its line (not to split one). Default: what follows the newline decides. */
	enterEndedLine?: boolean;
	spelling?: TextMechanicsSpelling;
	tagger?: TextMechanicsTagger;
	/** The prose map of the text, when the host already has one (default: `markdownProseMap(text)`). */
	prose?: MarkdownProseMap;
}

/** A fix: replace `from..to` with `replacement`. */
export interface TextMechanicsEdit {
	from: number;
	to: number;
	replacement: string;
	/** The checks it applies (a word can get an apostrophe and a capital at once). */
	checks: TextMechanicsCheckId[];
}

const NEWLINE = 0x0a;

/** Characters that end a word: space, tab and sentence punctuation. */
export function isTextMechanicsBoundary(c: number): boolean {
	return c === 0x20 || c === 0x09 || c === 0x2c || c === 0x2e || c === 0x3f || c === 0x21 || c === 0x3b || c === 0x3a;
}

const LETTER = /^[\p{L}\p{M}]$/u;

/** Letters and apostrophes (`'` and `’`). */
export function isTextMechanicsWordCharacter(c: number): boolean {
	if (c === 0x27 || c === 0x2019) return true;
	if (c >= 0xd800 && c <= 0xdfff) return false;
	return LETTER.test(String.fromCharCode(c));
}

const hasUpper = (s: string) => Array.from(s).some((ch) => ch !== ch.toLowerCase() && ch === ch.toUpperCase());
const capitalise = (s: string) => {
	const chars = Array.from(s);
	return chars.length ? chars[0].toUpperCase() + chars.slice(1).join('') : s;
};

/** Missing apostrophes. Words that are also real words without one (its, well, were, ill, id, wont, lets, shell, hell, wed) aren't here. */
export const TEXT_MECHANICS_CONTRACTIONS: Readonly<Record<string, string>> = {
	dont: "don't",
	doesnt: "doesn't",
	didnt: "didn't",
	cant: "can't",
	couldnt: "couldn't",
	shouldnt: "shouldn't",
	wouldnt: "wouldn't",
	isnt: "isn't",
	arent: "aren't",
	wasnt: "wasn't",
	werent: "weren't",
	havent: "haven't",
	hasnt: "hasn't",
	hadnt: "hadn't",
	mustnt: "mustn't",
	neednt: "needn't",
	youre: "you're",
	theyre: "they're",
	youve: "you've",
	theyve: "they've",
	weve: "we've",
	youll: "you'll",
	theyll: "they'll",
	youd: "you'd",
	theyd: "they'd",
	thats: "that's",
	whats: "what's",
	theres: "there's",
	heres: "here's",
	wheres: "where's",
	whos: "who's",
	hes: "he's",
	shes: "she's",
	aint: "ain't",
	im: "I'm",
	ive: "I've"
};

const PRONOUN_FORMS: Readonly<Record<string, string>> = {
	i: 'I',
	"i'm": "I'm",
	"i've": "I've",
	"i'd": "I'd",
	"i'll": "I'll",
	'i’m': 'I’m',
	'i’ve': 'I’ve',
	'i’d': 'I’d',
	'i’ll': 'I’ll'
};

/** Words always written in capitals. Only lowercase spellings are changed (`Ok` might be a name). */
export const TEXT_MECHANICS_CAPITALS: Readonly<Record<string, string>> = {
	ok: 'OK'
};

const PRONOUN_CONTRACTIONS: Readonly<Record<string, string>> = {
	id: "I'd",
	Id: "I'd",
	ill: "I'll",
	Ill: "I'll"
};

const EXCEPT_BEFORE_BUT = new Set(['nothing', 'anything', 'everything', 'all', 'none', 'nobody', 'anyone', 'everyone', 'no', 'any', 'every', 'last', 'next', 'not', 'only']);

const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'cf', 'approx', 'mr', 'mrs', 'ms', 'dr', 'st', 'no', 'fig', 'ca', 'al']);

const QUESTION_WORDS = new Set([
	'who',
	'what',
	'when',
	'where',
	'why',
	'how',
	'which',
	'whose',
	'whom',
	'is',
	'are',
	'am',
	'was',
	'were',
	'do',
	'does',
	'did',
	'can',
	'could',
	'would',
	'should',
	'will',
	'shall',
	'may',
	'might',
	'have',
	'has',
	'had',
	"isn't",
	"aren't",
	"don't",
	"doesn't",
	"didn't",
	"can't",
	"won't",
	"wouldn't",
	"shouldn't",
	"couldn't"
]);

/** What the checks read: the text and where its prose is. */
interface Source {
	text: string;
	map: MarkdownProseMap;
	chat?: boolean;
}

const blockAt = (map: MarkdownProseMap, at: number) => map.blocks.find((b) => b.from <= at && at < Math.max(b.to, b.from + 1));
const proseAt = (map: MarkdownProseMap, at: number) => map.prose.find((r) => r.from <= at && at < r.to);

/**
 * The word at `from..to` is ordinary text in a paragraph, heading or list item: not in code,
 * math, HTML, an address, front matter or a table, and not part of a URL, path, email,
 * mention or tag.
 */
function isProse({ text, map, chat }: Source, from: number, to: number): boolean {
	if (!proseAt(map, from)) return false;
	let tokenStart = from;
	while (tokenStart > 0) {
		const c = text.charCodeAt(tokenStart - 1);
		if (c === 0x20 || c === 0x09 || c === NEWLINE) break;
		tokenStart--;
	}
	const token = text.slice(tokenStart, to);
	if (/[/@#\\:_]/.test(token)) return false;
	if (chat && /[<>]/.test(token)) return false; // Slack's <@user>, <#channel>, <!here>, <url|label>
	if (token.slice(0, token.length - (to - from)).includes('.')) return false; // file.name, e.g.word
	return true;
}

/**
 * Markdown still being typed that the parser can't see as code, math, a link or front matter
 * until it's closed: an odd number of backticks or dollar signs earlier on the line, a table row
 * (a line starting with `|`, before its delimiter row exists), a link reference definition, a
 * link or image address not yet closed with `)`, or front matter not yet closed with `---`.
 */
function insideUnclosedSpan(text: string, before: number): boolean {
	let backticks = 0;
	let dollars = 0;
	let i = before;
	for (; i > 0; i--) {
		const c = text.charCodeAt(i - 1);
		if (c === NEWLINE) break;
		if (c === 0x60) backticks++;
		if (c === 0x24 && (i < 2 || text.charCodeAt(i - 2) !== 0x5c)) dollars++;
	}
	if (backticks % 2 === 1 || dollars % 2 === 1) return true;
	const linePrefix = text.slice(i, before);
	if (/^[ \t]*\|/.test(linePrefix)) return true;
	if (/^ {0,3}\[[^[\]]+\]:/.test(linePrefix)) return true;
	if (insideUnclosedLinkDestination(linePrefix)) return true;
	return insideUnclosedFrontMatter(text, before);
}

/** A `](` on the line with no matching `)` yet. */
function insideUnclosedLinkDestination(linePrefix: string): boolean {
	let inCode = false;
	let depth = 0;
	for (let i = 0; i < linePrefix.length; i++) {
		const c = linePrefix.charCodeAt(i);
		if (c === 0x5c) {
			i++;
			continue;
		}
		if (c === 0x60) {
			inCode = !inCode;
			continue;
		}
		if (inCode) continue;
		if (depth === 0 && c === 0x5d && linePrefix.charCodeAt(i + 1) === 0x28) {
			depth = 1;
			i++;
		} else if (depth > 0) {
			if (c === 0x28) depth++;
			else if (c === 0x29) depth--;
		}
	}
	return depth > 0;
}

/** Front matter at the start of the text whose `key:` lines have begun and whose closing `---` hasn't been typed. */
function insideUnclosedFrontMatter(text: string, before: number): boolean {
	const first = text.startsWith('---\n') ? 4 : text.startsWith('---\r\n') ? 5 : -1;
	if (first < 0 || before < first) return false;
	let end = Math.min(text.length, before + 1);
	while (end < text.length && text.charCodeAt(end - 1) !== NEWLINE) end++;
	const lines = text.slice(first, end).split('\n');
	if (!/^[A-Za-z0-9_-]+[ \t]*:/.test(lines[0] ?? '')) return false;
	return !lines.slice(1).some((line) => line.trim() === '---' || line.trim() === '...');
}

/** Only opening markup (and spaces) between `from` and `to`. */
const onlyOpeningMarkup = (text: string, from: number, to: number) => {
	if (from > to) return false;
	for (let i = from; i < to; i++) {
		const c = text.charCodeAt(i);
		if (!(c === 0x20 || c === 0x2a || c === 0x5f || c === 0x7e || c === 0x22 || c === 0x201c || c === 0x28)) return false;
	}
	return true;
};

/**
 * The word at `start` begins a sentence: it's the first word of its paragraph or heading, starts
 * a line (an editor that shows each line on its own reads a line as a sentence), or follows `.`,
 * `?` or `!` (not an abbreviation, ellipsis, decimal or initial).
 */
function startsSentence({ text, map }: Source, start: number): boolean {
	const block = blockAt(map, start);
	if (!block || (block.kind !== 'paragraph' && block.kind !== 'heading')) return false;
	const run = proseAt(map, start);
	if (block.firstText >= 0 && run && run.from <= block.firstText && onlyOpeningMarkup(text, block.firstText, start)) return true;
	// Back over spaces and opening markup to the end of the previous sentence
	let i = start;
	while (i > 0) {
		const c = text.charCodeAt(i - 1);
		if (c === 0x20 || c === 0x2a || c === 0x5f || c === 0x7e || c === 0x5b || c === 0x28 || c === 0x22 || c === 0x201c) i--;
		else break;
	}
	if (i <= 0) return false;
	if (text.charCodeAt(i - 1) === NEWLINE) return true;
	if (i >= start) return false;
	const end = text.charCodeAt(i - 1);
	// Closing quotes and brackets after the stop: "Done." or (done.)
	let stop = i - 1;
	if ((end === 0x22 || end === 0x201d || end === 0x29) && stop > 0) stop--;
	const mark = text.charCodeAt(stop);
	if (mark === 0x3f || mark === 0x21) return true;
	if (mark !== 0x2e) return false;
	if (stop > 0) {
		const before = text.charCodeAt(stop - 1);
		if (before === 0x2e) return false; // ellipsis
		if (before >= 0x30 && before <= 0x39) return false; // a decimal
	}
	let wordStart = stop;
	while (wordStart > 0 && (isTextMechanicsWordCharacter(text.charCodeAt(wordStart - 1)) || text.charCodeAt(wordStart - 1) === 0x2e)) wordStart--;
	const previous = text.slice(wordStart, stop).toLowerCase();
	if (ABBREVIATIONS.has(previous)) return false;
	if (Array.from(previous).length === 1) return false; // initials: J. Smith
	return true;
}

/** The word before the one at `start` when a single space separates them, and the line up to the end of `word`. */
function previousWord(text: string, start: number, word: string) {
	if (start < 2 || text.charCodeAt(start - 1) !== 0x20) return null;
	let from = start - 1;
	while (from > 0 && isTextMechanicsWordCharacter(text.charCodeAt(from - 1))) from--;
	const to = start - 1;
	if (to <= from) return null;
	let lineStart = from;
	while (lineStart > 0 && text.charCodeAt(lineStart - 1) !== NEWLINE) lineStart--;
	return {
		from,
		to,
		text: text.slice(from, to),
		line: text.slice(lineStart, start + word.length),
		offsetInLine: from - lineStart
	};
}

const tagAt = (tagger: TextMechanicsTagger, line: string, offset: number) => tagger(line).find((t) => t.from <= offset && offset < t.to)?.tag;

/** `its` before an adverb, determiner, verb or pronoun ("its really", "its a") is "it's"; before a noun or adjective it stays. */
function itsBefore(source: Source, word: string, start: number, tagger: TextMechanicsTagger): TextMechanicsEdit | null {
	const previous = previousWord(source.text, start, word);
	if (!previous || previous.to - previous.from !== 3 || previous.text.toLowerCase() !== 'its' || !isProse(source, previous.from, previous.to)) return null;
	const tag = tagAt(tagger, previous.line, start - (previous.from - previous.offsetInLine));
	if (!tag || !['adverb', 'determiner', 'verb', 'pronoun'].includes(tag)) return null;
	const fixed = previous.text === 'its' ? "it's" : previous.text === 'ITS' ? "IT'S" : previous.text === 'Its' ? "It's" : null;
	return fixed
		? {
				from: previous.from,
				to: previous.to,
				replacement: fixed,
				checks: ['contractions']
			}
		: null;
}

/** `id` and `ill` read as a pronoun or verb in their line ("id like", "ill be") are "I'd" and "I'll"; as a noun or adjective they stay. */
function pronounContractionBefore(source: Source, word: string, start: number, tagger: TextMechanicsTagger): TextMechanicsEdit | null {
	const previous = previousWord(source.text, start, word);
	const fixed = previous ? PRONOUN_CONTRACTIONS[previous.text] : undefined;
	if (!previous || !fixed || !isProse(source, previous.from, previous.to)) return null;
	const tag = tagAt(tagger, previous.line, previous.offsetInLine);
	if (tag !== 'pronoun' && tag !== 'verb') return null;
	return {
		from: previous.from,
		to: previous.to,
		replacement: fixed,
		checks: ['contractions']
	};
}

/**
 * "but" starts a new clause when the word after it begins one (a pronoun, determiner,
 * preposition or adverb) and the clause before it has a verb and at least two words: a comma
 * goes before it. "small but mighty", "not red but blue" and "nothing but the truth" get none.
 */
function commaBeforeBut(source: Source, word: string, start: number, tagger: TextMechanicsTagger): TextMechanicsEdit | null {
	const { text } = source;
	const but = previousWord(text, start, word);
	if (!but || but.text.toLowerCase() !== 'but' || word.toLowerCase() === 'also' || !isProse(source, but.from, but.to)) return null;
	const before = previousWord(text, but.from, but.text);
	if (!before || EXCEPT_BEFORE_BUT.has(before.text.toLowerCase())) return null;
	let clauseStart = before.from;
	while (clauseStart > 0) {
		const c = text.charCodeAt(clauseStart - 1);
		if (c === NEWLINE || c === 0x2e || c === 0x3f || c === 0x21 || c === 0x3b || c === 0x3a || c === 0x2c) break;
		clauseStart--;
	}
	const clause = tagger(text.slice(clauseStart, before.to));
	if (clause.length < 2 || !clause.some((t) => t.tag === 'verb')) return null;
	const tag = tagAt(tagger, but.line, but.offsetInLine + (but.to - but.from) + 1);
	if (!tag || !['pronoun', 'determiner', 'preposition', 'adverb'].includes(tag)) return null;
	return {
		from: before.to,
		to: before.to,
		replacement: ',',
		checks: ['clause-comma']
	};
}

/**
 * A full stop or question mark for the line ended at `lineEnd` (the newline): four or more words
 * of prose ending in a letter or digit, in a paragraph that isn't in a list item, alert or
 * footnote, and only when Enter ended the line rather than splitting it.
 */
function terminalPunctuation(source: Source, lineEnd: number, enterEndedLine?: boolean): TextMechanicsEdit | null {
	const { text, map } = source;
	if (lineEnd <= 0) return null;
	const endedLine = enterEndedLine ?? (lineEnd + 1 >= text.length || text.charCodeAt(lineEnd + 1) === NEWLINE);
	if (!endedLine) return null;
	const last = lineEnd - 1;
	if (!/^[\p{L}\p{N}\p{M}]$/u.test(text[last])) return null;
	const block = blockAt(map, last);
	if (!block || block.kind !== 'paragraph' || block.within.some((c) => c === 'listItem' || c === 'alert' || c === 'footnote')) return null;
	if (!isProse(source, last, last + 1) || insideUnclosedSpan(text, last)) return null;
	let lineStart = lineEnd;
	while (lineStart > 0 && text.charCodeAt(lineStart - 1) !== NEWLINE) lineStart--;
	const words = text
		.slice(lineStart, lineEnd)
		.split(/[ \t]+/)
		.filter(Boolean);
	if (words.length < 4) return null;
	const first = words[0].toLowerCase().replace(/^[^\p{L}'’]+|[^\p{L}'’]+$/gu, '');
	return {
		from: lineEnd,
		to: lineEnd,
		replacement: QUESTION_WORDS.has(first) ? '?' : '.',
		checks: ['terminal-punctuation']
	};
}

/** The pronoun, `OK` or contraction fix for a whole word. */
function fixedWord(word: string, chat: boolean, on: (c: TextMechanicsCheckId) => boolean): { word: string; check: TextMechanicsCheckId } | null {
	if (on('pronoun-i') && PRONOUN_FORMS[word]) return { word: PRONOUN_FORMS[word], check: 'pronoun-i' };
	if (!chat && on('capitals') && TEXT_MECHANICS_CAPITALS[word]) return { word: TEXT_MECHANICS_CAPITALS[word], check: 'capitals' };
	if (!on('contractions')) return null;
	const lower = word.toLowerCase();
	const fixed = TEXT_MECHANICS_CONTRACTIONS[lower];
	if (!fixed) return null;
	if (lower === 'im' || lower === 'ive') return word === 'IM' || word === 'IVE' ? null : { word: fixed, check: 'contractions' };
	if (word === lower) return { word: fixed, check: 'contractions' };
	if (word === word.toUpperCase()) return { word: fixed.toUpperCase(), check: 'contractions' };
	if (word === capitalise(word)) return { word: capitalise(fixed), check: 'contractions' };
	return null; // mixed case: a name or a code word
}

/**
 * The fixes to make after the character at `boundary` was typed (the caret is just after it):
 * the word it ends, the words before it that the new word decides (`its`, `id`, `ill`, the
 * comma before "but"), and the line's full stop or question mark when it's a newline.
 */
export function textMechanicsEditsAt(text: string, boundary: number, options: TextMechanicsOptions = {}): TextMechanicsEdit[] {
	if (boundary < 0 || boundary >= text.length) return [];
	const typed = text.charCodeAt(boundary);
	if (!isTextMechanicsBoundary(typed) && typed !== NEWLINE) return [];
	const chat = options.profile === 'chat';
	const source: Source = { text, map: options.prose ?? markdownProseMap(text), chat };
	const on = (c: TextMechanicsCheckId) =>
		c === 'spelling' && !options.spelling ? false : chat && TEXT_MECHANICS_OFF_BY_DEFAULT.has(c) ? false : (options.enabled?.(c) ?? !TEXT_MECHANICS_OFF_BY_DEFAULT.has(c));

	let start = boundary;
	while (start > 0 && isTextMechanicsWordCharacter(text.charCodeAt(start - 1))) start--;
	if (start === boundary || !isProse(source, start, boundary) || insideUnclosedSpan(text, start)) return typographyAt(source, boundary, null, on);
	const word = text.slice(start, boundary);
	const edits: TextMechanicsEdit[] = [];

	let replacement = word;
	const checks: TextMechanicsCheckId[] = [];
	const fixed = fixedWord(word, chat, on);
	if (fixed) {
		replacement = fixed.word;
		checks.push(fixed.check);
	} else if (
		on('spelling') &&
		word.length > 2 &&
		!(chat && TEXT_MECHANICS_CHAT_WORDS.has(word.toLowerCase())) &&
		(!hasUpper(word) || (hasUpper(Array.from(word)[0]) && !hasUpper(Array.from(word).slice(1).join(''))))
	) {
		const corrected = options.spelling!(word, start, text);
		// In chat, a correction that only changes case ("lol" → "LOL") isn't one
		if (corrected && corrected !== word && !corrected.includes(' ') && !(chat && corrected.toLowerCase() === word.toLowerCase())) {
			replacement = corrected;
			checks.push('spelling');
		}
	}
	const firstChar = Array.from(replacement)[0] ?? '';
	if (!chat && on('sentence-case') && /^\p{Ll}$/u.test(firstChar) && !hasUpper(Array.from(replacement).slice(1).join('')) && startsSentence(source, start)) {
		replacement = capitalise(replacement);
		checks.push('sentence-case');
	}
	if (checks.length && replacement !== word) edits.push({ from: start, to: boundary, replacement, checks });

	if (options.tagger) {
		if (on('contractions')) {
			const its = itsBefore(source, word, start, options.tagger);
			if (its) edits.push(its);
			const pronoun = pronounContractionBefore(source, word, start, options.tagger);
			if (pronoun) edits.push(pronoun);
		}
		if (!chat && on('clause-comma')) {
			const comma = commaBeforeBut(source, word, start, options.tagger);
			if (comma) edits.push(comma);
		}
	}
	if (typed === NEWLINE && !chat && on('terminal-punctuation')) {
		const stop = terminalPunctuation(source, boundary, options.enterEndedLine);
		if (stop) edits.push(stop);
	}
	// Curly apostrophes in what the fixes write, then quotes, dashes and ellipses around the word
	if (on('curly-quotes')) {
		for (const edit of edits) {
			const curled = edit.replacement.replace(/'/g, '’');
			if (curled !== edit.replacement) {
				edit.replacement = curled;
				if (!edit.checks.includes('curly-quotes')) edit.checks.push('curly-quotes');
			}
		}
	}
	const wordEdit = edits.find((e) => e.from === start && e.to === boundary) ?? null;
	return [...edits, ...typographyAt(source, boundary, wordEdit ? { from: start, to: boundary } : null, on)];
}

const isAlphanumeric = (c: string | undefined) => !!c && /^[\p{L}\p{N}]$/u.test(c);

/**
 * Typography for the token a boundary ends (from the last space, tab or newline to the boundary
 * character itself): straight quotes and apostrophes become curly, `--` and `---` between words
 * become en and em dashes, and `...` an ellipsis. Prose only; `skip` is a range another fix
 * already rewrites (its apostrophes are curled there).
 */
function typographyAt(source: Source, boundary: number, skip: { from: number; to: number } | null, on: (c: TextMechanicsCheckId) => boolean): TextMechanicsEdit[] {
	if (!on('curly-quotes') && !on('dashes') && !on('ellipses')) return [];
	const { text, map } = source;
	let tokenStart = boundary;
	while (tokenStart > 0 && !/[ \t\n]/.test(text[tokenStart - 1])) tokenStart--;
	const end = text[boundary] === ' ' || text[boundary] === '\t' || text[boundary] === '\n' ? boundary : boundary + 1;
	if (end <= tokenStart) return [];
	const token = text.slice(tokenStart, end);
	if (/[/@#\\:_<>]/.test(token) || insideUnclosedSpan(text, tokenStart)) return [];
	const prose = (at: number) => !!proseAt(map, at) && !(skip && skip.from <= at && at < skip.to);
	const out: TextMechanicsEdit[] = [];
	for (let i = tokenStart; i < end; i++) {
		const c = text[i];
		if (on('ellipses') && c === '.' && text.slice(i, i + 3) === '...' && i + 3 <= end && text[i + 3] !== '.' && text[i - 1] !== '.' && prose(i)) {
			out.push({ from: i, to: i + 3, replacement: '…', checks: ['ellipses'] });
			i += 2;
			continue;
		}
		if (on('dashes') && c === '-' && text[i + 1] === '-' && text[i - 1] !== '-' && prose(i)) {
			const run = text[i + 2] === '-' ? 3 : 2;
			if (text[i + run] === '-') {
				i += run;
				continue;
			}
			const before = text[i - 1];
			const after = text[i + run];
			// Between words (word--word), or standing alone between spaces (word -- word); never a --flag
			const between = isAlphanumeric(before) && isAlphanumeric(after);
			const alone = (i === tokenStart || before === ' ') && (i + run === end || after === ' ' || after === '\n' || after === undefined);
			// --- is an em dash; -- is an en dash when spaced (word -- word) and an em dash between words (word--word)
			if (between || alone) out.push({ from: i, to: i + run, replacement: run === 3 || between ? '—' : '–', checks: ['dashes'] });
			i += run - 1;
			continue;
		}
		if (on('curly-quotes') && (c === '"' || c === "'") && prose(i)) {
			const before = text[i - 1];
			const opening = i === tokenStart || /[([{\u2014\u2013-]/.test(before ?? '');
			const replacement = c === '"' ? (opening ? '“' : '”') : opening && !isAlphanumeric(text[i - 1]) ? '‘' : '’';
			out.push({ from: i, to: i + 1, replacement, checks: ['curly-quotes'] });
		}
	}
	return out;
}

/**
 * What the checks look at for the boundary at `boundary`: the word before it, or the line it
 * ends when it's a newline. Null when that isn't prose, so there's nothing to show as checked.
 */
export function textMechanicsCheckedRange(text: string, boundary: number, prose?: MarkdownProseMap): { from: number; to: number } | null {
	if (boundary <= 0 || boundary >= text.length) return null;
	const source: Source = { text, map: prose ?? markdownProseMap(text) };
	const typed = text.charCodeAt(boundary);
	if (typed === NEWLINE) {
		let lineStart = boundary;
		while (lineStart > 0 && text.charCodeAt(lineStart - 1) !== NEWLINE) lineStart--;
		if (!text.slice(lineStart, boundary).trim()) return null;
		let last = boundary - 1;
		while (last > lineStart && text.charCodeAt(last) === 0x20) last--;
		return isProse(source, last, last + 1) ? { from: lineStart, to: boundary } : null;
	}
	if (!isTextMechanicsBoundary(typed)) return null;
	let start = boundary;
	while (start > 0 && isTextMechanicsWordCharacter(text.charCodeAt(start - 1))) start--;
	if (start === boundary || !isProse(source, start, boundary) || insideUnclosedSpan(text, start)) return null;
	return { from: start, to: boundary };
}

/** A finding over a whole text: a fix with a sentence saying what it does. */
export interface TextMechanicsFinding extends TextMechanicsEdit {
	message: string;
}

/**
 * Every fix the checks would make in `text`, as if it had been typed: each word boundary in
 * order, on the text the earlier fixes left, and each line end as a finished line. Fixes to the
 * same word merge (a capital and an apostrophe: `its` → `It's`). Ranges are in `text` as it
 * is, and never overlap. The word at the very end (no boundary after it) is left alone.
 */
export function textMechanicsFindings(text: string, options: Omit<TextMechanicsOptions, 'enterEndedLine' | 'prose'> = {}): TextMechanicsFinding[] {
	/** Each fix in the original text (`from`, `to`) and where it is in the working text (`at`, `end`). */
	const applied: {
		from: number;
		to: number;
		at: number;
		end: number;
		replacement: string;
		checks: TextMechanicsCheckId[];
	}[] = [];
	let current = text;
	let prose = markdownProseMap(current);
	for (let i = 0; i < current.length; i++) {
		const c = current.charCodeAt(i);
		if (!isTextMechanicsBoundary(c) && c !== NEWLINE) continue;
		const edits = textMechanicsEditsAt(current, i, {
			...options,
			prose,
			enterEndedLine: c === NEWLINE ? true : undefined
		}).sort((a, b) => b.from - a.from);
		let shiftHere = 0;
		for (const edit of edits) {
			const delta = edit.replacement.length - (edit.to - edit.from);
			const inside = applied.find((f) => f.at <= edit.from && edit.to <= f.end && (edit.from !== edit.to || (f.at < edit.from && edit.from < f.end)));
			if (inside) {
				inside.replacement = inside.replacement.slice(0, edit.from - inside.at) + edit.replacement + inside.replacement.slice(edit.to - inside.at);
				for (const check of edit.checks) if (!inside.checks.includes(check)) inside.checks.push(check);
				inside.end += delta;
				for (const f of applied)
					if (f !== inside && f.at >= edit.to) {
						f.at += delta;
						f.end += delta;
					}
			} else if (applied.some((f) => (edit.from === edit.to ? f.at === edit.from && f.end === edit.from : f.at < edit.to && edit.from < f.end))) {
				continue;
			} else {
				const before = applied.filter((f) => f.end <= edit.from).reduce((sum, f) => sum + f.replacement.length - (f.to - f.from), 0);
				for (const f of applied)
					if (f.at >= edit.to) {
						f.at += delta;
						f.end += delta;
					}
				applied.push({
					from: edit.from - before,
					to: edit.to - before,
					at: edit.from,
					end: edit.from + edit.replacement.length,
					replacement: edit.replacement,
					checks: [...edit.checks]
				});
			}
			current = current.slice(0, edit.from) + edit.replacement + current.slice(edit.to);
			if (edit.from <= i) shiftHere += delta;
		}
		if (edits.length) prose = markdownProseMap(current);
		i += shiftHere;
	}
	return applied
		.filter((f) => f.replacement !== text.slice(f.from, f.to))
		.sort((a, b) => a.from - b.from)
		.map(({ from, to, replacement, checks }) => ({
			from,
			to,
			replacement,
			checks,
			message: describe(text, { from, to, replacement, checks })
		}));
}

const describe = (text: string, edit: TextMechanicsEdit) => {
	const was = text.slice(edit.from, edit.to);
	if (!was) {
		const before = text
			.slice(Math.max(0, edit.from - 24), edit.from)
			.split('\n')
			.pop()!
			.trimStart();
		return `Add "${edit.replacement}" after "${before}".`;
	}
	return `Write "${was}" as "${edit.replacement}".`;
};

/** Applies non-overlapping edits to `text`. */
export function applyTextMechanicsEdits(text: string, edits: readonly TextMechanicsEdit[]): string {
	let out = text;
	for (const edit of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, edit.from) + edit.replacement + out.slice(edit.to);
	return out;
}
