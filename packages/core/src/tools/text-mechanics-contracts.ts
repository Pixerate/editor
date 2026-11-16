/**
 * The `text-mechanics` domain of `@pixerate/conformance` (#892): typing scenarios that another
 * implementation of the text mechanics checks (the Swift port in PixerateMarkdown) must
 * reproduce exactly. Each scenario types text one character at a time after `after` (and
 * before `suffix`), applying every fix as an editor would, with a fixed word-class lexicon in
 * place of a real tagger and a fixed spelling table in place of a spell checker.
 */
import {
	applyTextMechanicsEdits,
	textMechanicsCheckedRange,
	textMechanicsEditsAt,
	textMechanicsFindings,
	TEXT_MECHANICS_CHECKS,
	TEXT_MECHANICS_OFF_BY_DEFAULT,
	type TextMechanicsCheckId,
	type TextMechanicsTagger,
	type TextMechanicsWordClass
} from './text-mechanics.js';

export interface TextMechanicsScenario {
	name: string;
	/** What is typed, one character (code point) at a time. */
	typed: string;
	/** Text before the caret when typing starts. */
	after?: string;
	/** Text after the caret, which stays. */
	suffix?: string;
	profile?: 'prose' | 'chat';
	/** Checks turned off. */
	disabled?: TextMechanicsCheckId[];
	/** Checks that are off by default (typography), turned on. */
	enable?: TextMechanicsCheckId[];
	/** Spelling corrections by exact word; none means no spell checker. */
	spelling?: Record<string, string>;
	/** Word classes for this scenario, over `TEXT_MECHANICS_LEXICON` (lower-case words). */
	lexicon?: Record<string, TextMechanicsWordClass>;
}

/**
 * The word classes a tagger would give the scenarios' words. Real taggers read context; the
 * scenarios that need a word read differently ("the id field" against "id like") override it.
 */
export const TEXT_MECHANICS_LEXICON: Readonly<Record<string, TextMechanicsWordClass>> = {
	a: 'determiner',
	the: 'determiner',
	this: 'determiner',
	that: 'determiner',
	i: 'pronoun',
	it: 'pronoun',
	me: 'pronoun',
	we: 'pronoun',
	you: 'pronoun',
	nothing: 'pronoun',
	is: 'verb',
	was: 'verb',
	be: 'verb',
	have: 'verb',
	tried: 'verb',
	failed: 'verb',
	works: 'verb',
	going: 'verb',
	feel: 'verb',
	know: 'verb',
	think: 'verb',
	see: 'verb',
	really: 'adverb',
	not: 'adverb',
	now: 'adverb',
	there: 'adverb',
	soon: 'adverb',
	well: 'adverb',
	for: 'preposition',
	about: 'preposition',
	in: 'preposition',
	to: 'preposition',
	but: 'conjunction',
	and: 'conjunction',
	ok: 'adjective',
	good: 'adjective',
	fine: 'adjective',
	cheap: 'adjective',
	red: 'adjective',
	blue: 'adjective',
	best: 'adjective',
	slow: 'adjective',
	own: 'adjective',
	empty: 'adjective',
	tail: 'noun',
	colour: 'noun',
	day: 'noun',
	today: 'noun',
	field: 'noun',
	time: 'noun',
	dog: 'noun',
	like: 'verb',
	id: 'verb',
	ill: 'pronoun'
};

/** A tagger that reads words from a lexicon (for scenarios and tests). */
export function lexiconTagger(lexicon: Readonly<Record<string, TextMechanicsWordClass>>): TextMechanicsTagger {
	return (text) =>
		Array.from(text.matchAll(/[\p{L}\p{N}'’]+/gu), (m) => ({
			from: m.index!,
			to: m.index! + m[0].length,
			tag: lexicon[m[0].toLowerCase()] ?? 'other'
		}));
}

/** Plays a scenario: the text it leaves and the checks that fired, in order. */
export function runTextMechanicsScenario(scenario: TextMechanicsScenario): {
	text: string;
	checks: TextMechanicsCheckId[];
} {
	const suffix = scenario.suffix ?? '';
	const tagger = lexiconTagger({
		...TEXT_MECHANICS_LEXICON,
		...scenario.lexicon
	});
	const spelling = scenario.spelling ? (word: string) => scenario.spelling![word] : undefined;
	const disabled = new Set(scenario.disabled ?? []);
	let text = scenario.after ?? '';
	const checks: TextMechanicsCheckId[] = [];
	for (const ch of Array.from(scenario.typed)) {
		text += ch;
		const boundary = text.length - ch.length;
		const full = text + suffix;
		const edits = textMechanicsEditsAt(full, boundary, {
			profile: scenario.profile,
			enabled: (c) => !disabled.has(c) && (!TEXT_MECHANICS_OFF_BY_DEFAULT.has(c) || (scenario.enable ?? []).includes(c)),
			spelling,
			tagger
		}).sort((a, b) => b.from - a.from);
		for (const edit of edits) checks.push(...edit.checks);
		const updated = applyTextMechanicsEdits(full, edits);
		text = updated.slice(0, updated.length - suffix.length);
	}
	return { text: text + suffix, checks };
}

const TYPOGRAPHY: TextMechanicsCheckId[] = ['curly-quotes', 'dashes', 'ellipses'];

const FAKE_SPELLING = {
	becuase: 'because',
	teh: 'the',
	happenign: 'happening',
	Becuase: 'Because'
};

/** The scenarios, from Swash's writing partner tests. */
export const TEXT_MECHANICS_SCENARIOS: readonly TextMechanicsScenario[] = [
	// Capital I and contractions
	{ name: 'capital I', typed: 'so i think ' },
	{ name: "i'm", typed: "Then i'm off " },
	{ name: 'a contraction', typed: 'I dont know ' },
	{ name: 'a contraction before a comma', typed: 'It doesnt matter, ' },
	{ name: 'a capitalised contraction', typed: 'Dont go ' },
	{ name: 'an upper-case contraction', typed: 'DONT STOP ' },
	{ name: 'im', typed: 'Well im here ' },
	{
		name: 'real words without an apostrophe stay',
		typed: 'Its fine, well see '
	},
	{ name: 'its before an adverb', typed: 'its really interesting ' },
	{ name: 'its before a determiner', typed: 'I think its a good day ' },
	{ name: 'its before a verb', typed: 'its going well ' },
	{ name: 'Its before not', typed: 'Its not fine ' },
	{ name: 'its before a pronoun', typed: 'I know its me ' },
	{ name: 'its before a noun stays', typed: 'The dog wagged its tail ' },
	{ name: 'Its before a noun stays', typed: 'Its colour is red ' },
	{ name: 'its before an adjective stays', typed: 'in its own way ' },
	{ name: 'its about stays', typed: 'its about time ' },
	{ name: 'its in code stays', typed: 'See `its really` ' },
	{ name: 'wont stays', typed: 'The wont of it ' },
	{ name: 'mixed case stays', typed: 'iPhone is here ' },
	{ name: 'a name stays', typed: 'Ask McDonalds now ' },
	{
		name: 'its before an unknown word stays',
		typed: 'its really here ',
		lexicon: { really: 'other' }
	},

	// Capitals at the start of sentences
	{ name: 'after a full stop', typed: 'hello world. this is it ' },
	{ name: 'after ? and !, and OK', typed: 'Really? yes! ok ' },
	{ name: 'not after an abbreviation', typed: 'See e.g. this one ' },
	{ name: 'not after a decimal', typed: 'It costs 3.50 today ' },
	{ name: 'not after an ellipsis', typed: 'Wait... and then ' },
	{ name: 'not after an initial', typed: 'Ask J. smith ' },
	{ name: 'after a closing quote', typed: 'He said "done." then left ' },
	{ name: 'each line is a sentence', typed: 'first line\nsecond line ' },
	{ name: 'a heading', typed: '# hello there ' },
	{ name: 'a list item', typed: '- buy milk ' },
	{ name: 'a quote', typed: '> quoted text ' },
	{ name: 'bold that starts a paragraph stays', typed: '**bold** start ' },
	{ name: 'bold being typed', typed: '**bold start ' },

	// Never in code, math, links' addresses, HTML or URLs
	{ name: 'a code span', typed: '`dont i` ' },
	{ name: 'a code block', typed: '```\ndont i \n' },
	{ name: 'math', typed: '$x i y$ ' },
	{ name: 'a URL', typed: 'See https://example.com/dont i ' },
	{ name: 'an email', typed: 'Mail me@dont.com ' },
	{ name: 'a tag', typed: 'Tag #dont here ' },
	{ name: 'an identifier', typed: 'A file_dont name ' },
	{ name: 'HTML', typed: '<span>dont</span> ' },
	{ name: 'a table', typed: '| a | b |\n|---|---|\n| dont | i |' },

	// Full stops and question marks when Enter ends a line
	{ name: 'a full stop', typed: 'this is a whole sentence\n' },
	{
		name: 'a full stop, then a blank line',
		typed: 'this is a whole sentence\n\n'
	},
	{ name: 'a question mark', typed: 'how does this work then\n' },
	{ name: 'too short', typed: 'Too short\n\n' },
	{ name: 'already punctuated', typed: 'Already done here, really.\n\n' },
	{
		name: 'only the long line',
		typed: 'roses are red\nviolets are blue now\n'
	},
	{
		name: 'three lines',
		typed: "It's really interesting becuase I dont know how to do this any more\nwhat could be happenign here\nthis should be capitilised but isnt\n"
	},
	{ name: 'three words get no full stop', typed: 'ends in isnt\n' },
	{
		name: 'Enter that splits a line adds nothing',
		typed: '\n',
		after: 'Split this line here and',
		suffix: ' there'
	},
	{ name: 'not in a list item', typed: '- a list item with words\n\n' },
	{ name: 'not in a heading', typed: '# A heading with four words\n\n' },
	{ name: 'not after code', typed: 'Ends with a `code span`\n\n' },
	{
		name: 'not after a link',
		typed: 'It ends with a [link here](https://x.y)\n\n'
	},

	// Chat
	{
		name: 'chat keeps capitals and full stops out',
		typed: 'ok so i dont know\n\n',
		profile: 'chat'
	},

	// The rest of the document is untouched
	{ name: 'after a paragraph', typed: 'so i ', after: 'Intro.\n\n' },
	{
		name: 'between paragraphs',
		typed: 'dont ',
		after: 'Para one.\n\n',
		suffix: '\n\nPara two.'
	},

	// Spelling
	{
		name: 'spelling',
		typed: 'teh dog was there becuase i said so\n',
		spelling: FAKE_SPELLING
	},
	{
		name: 'spelling, then a capital',
		typed: 'becuase ',
		spelling: FAKE_SPELLING
	},
	{
		name: 'no spelling in code',
		typed: 'see `becuase` ',
		spelling: FAKE_SPELLING
	},
	{
		name: 'spelling off',
		typed: 'teh ',
		spelling: FAKE_SPELLING,
		disabled: ['spelling']
	},
	{
		name: 'no spelling for two-letter words',
		typed: 'ab ',
		spelling: { ab: 'an' }
	},
	{
		name: 'no spelling for mixed case',
		typed: 'McDonlads ',
		spelling: { McDonlads: 'McDonalds' }
	},
	{
		name: 'no corrections that split a word',
		typed: 'hte ',
		spelling: { hte: 'the end' }
	},

	// Markdown still being typed (Pixerate/Swash#121)
	{ name: 'a table row before its delimiter', typed: '| dont | i |\n|---|---|\n' },
	{ name: 'front matter being typed', typed: '---\ntitle: dont i\n---\n' },
	{ name: "an image's title", typed: '![alt](img.png "dont i") ' },
	{ name: 'a reference definition', typed: '[ref]: https://x.y "dont i"\n' },

	// Typography, when turned on
	{ name: 'curly quotes', typed: '"hello" she said ', enable: TYPOGRAPHY },
	{ name: 'a curly apostrophe', typed: "don't stop ", enable: TYPOGRAPHY },
	{ name: 'a contraction with a curly apostrophe', typed: 'dont stop ', enable: TYPOGRAPHY },
	{ name: 'an en dash', typed: 'wait -- what ', enable: TYPOGRAPHY },
	{ name: 'an em dash', typed: 'a long---winded day ', enable: TYPOGRAPHY },
	{ name: 'an em dash between words', typed: 'it works--mostly ', enable: TYPOGRAPHY },
	{ name: 'not a --flag', typed: 'use --verbose here ', enable: TYPOGRAPHY },
	{ name: 'an ellipsis', typed: 'Wait... and then ', enable: TYPOGRAPHY },
	{ name: 'single quotes and an apostrophe', typed: "it's 'quoted' text ", enable: TYPOGRAPHY },
	{ name: 'no typography in code', typed: "see `don't` ", enable: TYPOGRAPHY },
	{ name: 'quotes around a sentence end', typed: 'he said "done." then left ', enable: TYPOGRAPHY },
	{ name: "it's with a curly apostrophe", typed: 'its really odd ', enable: TYPOGRAPHY },
	{ name: 'typography is off by default', typed: 'wait -- "what" ' },

	// Chat
	{ name: 'chat shorthand is not spelling', typed: 'lol teh cat ', profile: 'chat', spelling: { lol: 'LOL', teh: 'the' } },
	{ name: "chat leaves Slack's syntax alone", typed: 'ping <!here> dont ', profile: 'chat' },
	{ name: 'no typography in chat', typed: 'wait -- dont ', profile: 'chat', enable: TYPOGRAPHY },

	// Checks turned off
	{ name: 'contractions off', typed: 'so i dont ', disabled: ['contractions'] },

	// OK, I'd and I'll, and commas before "but"
	{
		name: "OK, a comma and I'd",
		typed: 'this is ok but for now id like to see what can be done to make it better\n'
	},
	{ name: "I'll", typed: 'ill be there soon ' },
	{
		name: 'ill as an adjective stays',
		typed: 'I feel ill today ',
		lexicon: { ill: 'adjective' }
	},
	{
		name: 'id as a noun stays',
		typed: 'the id field is empty ',
		lexicon: { id: 'noun' }
	},
	{ name: 'a comma before but', typed: 'I tried but it failed ' },
	{ name: 'no comma between adjectives', typed: 'it was cheap but good ' },
	{ name: 'no comma in not … but', typed: 'not red but blue ' },
	{ name: 'no comma in nothing but', typed: 'I have nothing but the best ' },
	{ name: 'no second comma', typed: 'It works, but it is slow ' },
	{ name: 'Ok stays', typed: 'Ok so ' }
];

/** Ranges shown as being checked at a boundary. */
const CHECKED_CASES: readonly { text: string; boundary: number }[] = [
	{ text: 'so i dont ', boundary: 9 },
	{ text: 'hello there\n', boundary: 11 },
	{ text: 'see `code` ', boundary: 10 },
	{ text: 'https://x.y/dont ', boundary: 16 },
	{ text: '\n', boundary: 0 },
	{ text: 'a\n\n', boundary: 2 }
];

/** Whole texts checked at once. */
const FINDINGS_CASES: readonly { name: string; text: string }[] = [
	{ name: 'a paragraph', text: 'so i dont know. its really odd\n' },
	{
		name: 'code and a list',
		text: '# notes\n\n- buy milk\n\n```\ndont i\n```\n\nthis is the end of it\n'
	}
];

/**
 * The `text-mechanics` domain: the checks, the lexicon, and the scenarios with what they leave
 * (times are not involved).
 */
export function textMechanicsContracts(): Record<string, unknown> {
	return {
		'manifest.json': {
			domain: 'text-mechanics',
			formatVersion: 1,
			description: 'Text mechanics checks (punctuation, casing, apostrophes, spelling) as typing scenarios over Markdown source, with a fixed lexicon in place of a tagger.',
			checks: TEXT_MECHANICS_CHECKS.map(({ id, title }) => ({ id, title })),
			lexicon: TEXT_MECHANICS_LEXICON,
			files: ['typing.json', 'checked-ranges.json', 'findings.json']
		},
		'typing.json': TEXT_MECHANICS_SCENARIOS.map((scenario) => ({
			...scenario,
			expect: runTextMechanicsScenario(scenario)
		})),
		'checked-ranges.json': CHECKED_CASES.map((c) => ({
			...c,
			expect: textMechanicsCheckedRange(c.text, c.boundary)
		})),
		'findings.json': FINDINGS_CASES.map((c) => ({
			...c,
			expect: textMechanicsFindings(c.text, {
				tagger: lexiconTagger(TEXT_MECHANICS_LEXICON)
			}).map(({ from, to, replacement, checks }) => ({
				from,
				to,
				replacement,
				checks
			}))
		}))
	};
}
