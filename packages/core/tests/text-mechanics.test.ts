import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { markdownProseMap } from '../src/tools/markdown-prose';
import { applyTextMechanicsEdits, textMechanicsCheckedRange, textMechanicsEditsAt, textMechanicsFindings } from '../src/tools/text-mechanics';
import { createTextMechanicsToolProvider } from '../src/tools/text-mechanics-tools';
import { lexiconTagger, runTextMechanicsScenario, textMechanicsContracts, TEXT_MECHANICS_LEXICON, TEXT_MECHANICS_SCENARIOS } from '../src/tools/text-mechanics-contracts';

/** What each scenario must leave: Swash's writing partner tests (Pixerate/Swash Tests/WritingPartner). */
const EXPECTED: Record<string, string> = {
	'capital I': 'So I think ',
	"i'm": "Then I'm off ",
	'a contraction': "I don't know ",
	'a contraction before a comma': "It doesn't matter, ",
	'a capitalised contraction': "Don't go ",
	'an upper-case contraction': "DON'T STOP ",
	im: "Well I'm here ",
	'real words without an apostrophe stay': 'Its fine, well see ',
	'its before an adverb': "It's really interesting ",
	'its before a determiner': "I think it's a good day ",
	'its before a verb': "It's going well ",
	'Its before not': "It's not fine ",
	'its before a pronoun': "I know it's me ",
	'its before a noun stays': 'The dog wagged its tail ',
	'Its before a noun stays': 'Its colour is red ',
	'its before an adjective stays': 'In its own way ',
	'its about stays': 'Its about time ',
	'its in code stays': 'See `its really` ',
	'wont stays': 'The wont of it ',
	'mixed case stays': 'iPhone is here ',
	'a name stays': 'Ask McDonalds now ',
	'its before an unknown word stays': 'Its really here ',
	'after a full stop': 'Hello world. This is it ',
	'after ? and !, and OK': 'Really? Yes! OK ',
	'not after an abbreviation': 'See e.g. this one ',
	'not after a decimal': 'It costs 3.50 today ',
	'not after an ellipsis': 'Wait... and then ',
	'not after an initial': 'Ask J. smith ',
	'after a closing quote': 'He said "done." Then left ',
	'each line is a sentence': 'First line\nSecond line ',
	'a heading': '# Hello there ',
	'a list item': '- Buy milk ',
	'a quote': '> Quoted text ',
	'bold that starts a paragraph stays': '**bold** start ',
	'bold being typed': '**Bold start ',
	'a code span': '`dont i` ',
	'a code block': '```\ndont i \n',
	math: '$x i y$ ',
	'a URL': 'See https://example.com/dont I ',
	'an email': 'Mail me@dont.com ',
	'a tag': 'Tag #dont here ',
	'an identifier': 'A file_dont name ',
	HTML: '<span>dont</span> ',
	'a table': '| a | b |\n|---|---|\n| dont | i |',
	'a full stop': 'This is a whole sentence.\n',
	'a full stop, then a blank line': 'This is a whole sentence.\n\n',
	'a question mark': 'How does this work then?\n',
	'too short': 'Too short\n\n',
	'already punctuated': 'Already done here, really.\n\n',
	'only the long line': 'Roses are red\nViolets are blue now.\n',
	'three lines': "It's really interesting becuase I don't know how to do this any more.\nWhat could be happenign here?\nThis should be capitilised but isn't.\n",
	'three words get no full stop': "Ends in isn't\n",
	'Enter that splits a line adds nothing': 'Split this line here and\n there',
	'not in a list item': '- A list item with words\n\n',
	'not in a heading': '# A heading with four words\n\n',
	'not after code': 'Ends with a `code span`\n\n',
	'not after a link': 'It ends with a [link here](https://x.y)\n\n',
	'chat keeps capitals and full stops out': "ok so I don't know\n\n",
	'after a paragraph': 'Intro.\n\nSo I ',
	'between paragraphs': "Para one.\n\nDon't \n\nPara two.",
	spelling: 'The dog was there because I said so.\n',
	'spelling, then a capital': 'Because ',
	'no spelling in code': 'See `becuase` ',
	'spelling off': 'Teh ',
	'no spelling for two-letter words': 'Ab ',
	'no spelling for mixed case': 'McDonlads ',
	'no corrections that split a word': 'Hte ',
	'contractions off': 'So I dont ',
	"OK, a comma and I'd": "This is OK, but for now I'd like to see what can be done to make it better.\n",
	"I'll": "I'll be there soon ",
	'ill as an adjective stays': 'I feel ill today ',
	'id as a noun stays': 'The id field is empty ',
	'a comma before but': 'I tried, but it failed ',
	'no comma between adjectives': 'It was cheap but good ',
	'no comma in not … but': 'Not red but blue ',
	'no comma in nothing but': 'I have nothing but the best ',
	'no second comma': 'It works, but it is slow ',
	'Ok stays': 'Ok so ',
	'a table row before its delimiter': '| dont | i |\n|---|---|\n',
	'front matter being typed': '---\ntitle: dont i\n---\n',
	"an image's title": '![alt](img.png "dont i") ',
	'a reference definition': '[ref]: https://x.y "dont i"\n',
	'curly quotes': '“hello” she said ',
	'a curly apostrophe': 'Don’t stop ',
	'a contraction with a curly apostrophe': 'Don’t stop ',
	'an en dash': 'Wait – what ',
	'an em dash': 'A long—winded day ',
	'not a --flag': 'Use --verbose here ',
	'an ellipsis': 'Wait… and then ',
	'single quotes and an apostrophe': 'It’s ‘quoted’ text ',
	'no typography in code': "See `don't` ",
	'quotes around a sentence end': 'He said “done.” Then left ',
	"it's with a curly apostrophe": 'It’s really odd ',
	'typography is off by default': 'Wait -- "what" ',
	'chat shorthand is not spelling': 'lol the cat ',
	"chat leaves Slack's syntax alone": "ping <!here> don't ",
	'no typography in chat': "wait -- don't "
};

describe('text mechanics typing scenarios', () => {
	it('has an expected result for every scenario, and names are unique', () => {
		const names = TEXT_MECHANICS_SCENARIOS.map((s) => s.name);
		expect(new Set(names).size).toBe(names.length);
		expect(names.filter((n) => !(n in EXPECTED))).toEqual([]);
	});

	for (const scenario of TEXT_MECHANICS_SCENARIOS) {
		it(scenario.name, () => {
			expect(runTextMechanicsScenario(scenario).text).toBe(EXPECTED[scenario.name]);
		});
	}

	it('records which checks fired, in order', () => {
		expect(
			runTextMechanicsScenario({
				name: 'x',
				typed: 'so i dont ',
				disabled: ['contractions']
			}).checks
		).toEqual(['sentence-case', 'pronoun-i']);
		expect(
			runTextMechanicsScenario({
				name: 'x',
				typed: 'teh dog ',
				spelling: { teh: 'the' }
			}).checks
		).toEqual(['spelling', 'sentence-case']);
	});
});

describe('textMechanicsEditsAt', () => {
	const tagger = lexiconTagger(TEXT_MECHANICS_LEXICON);

	it('fixes the word a boundary ends, with the checks it applies', () => {
		expect(textMechanicsEditsAt('so i dont ', 9)).toEqual([{ from: 5, to: 9, replacement: "don't", checks: ['contractions'] }]);
		expect(textMechanicsEditsAt('dont ', 4)).toEqual([
			{
				from: 0,
				to: 4,
				replacement: "Don't",
				checks: ['contractions', 'sentence-case']
			}
		]);
	});

	it('only runs at a boundary, inside the text', () => {
		expect(textMechanicsEditsAt('dont', 3)).toEqual([]);
		expect(textMechanicsEditsAt('dont ', 5)).toEqual([]);
		expect(textMechanicsEditsAt('dont ', -1)).toEqual([]);
	});

	it('leaves the ambiguous words alone without a tagger', () => {
		expect(textMechanicsEditsAt('I think its a ', 13)).toEqual([]);
		expect(textMechanicsEditsAt('I think its a ', 13, { tagger })).toEqual([{ from: 8, to: 11, replacement: "it's", checks: ['contractions'] }]);
	});

	it('takes the enter-ended-line hint over what follows the newline', () => {
		const text = 'this is a whole line\nnext';
		expect(textMechanicsEditsAt(text, 20).some((e) => e.replacement === '.')).toBe(false);
		expect(textMechanicsEditsAt(text, 20, { enterEndedLine: true }).some((e) => e.replacement === '.')).toBe(true);
	});

	it('uses a prose map the host already has', () => {
		const text = 'see `x` dont ';
		const prose = markdownProseMap(text);
		expect(textMechanicsEditsAt(text, 12, { prose })).toEqual(textMechanicsEditsAt(text, 12));
	});
});

describe('textMechanicsCheckedRange', () => {
	it('is the word before a space, or the line before a newline, when it is prose', () => {
		expect(textMechanicsCheckedRange('so i dont ', 9)).toEqual({
			from: 5,
			to: 9
		});
		expect(textMechanicsCheckedRange('hello there\n', 11)).toEqual({
			from: 0,
			to: 11
		});
		expect(textMechanicsCheckedRange('see `code` ', 10)).toBeNull();
		expect(textMechanicsCheckedRange('https://x.y/dont ', 16)).toBeNull();
		expect(textMechanicsCheckedRange('a\n\n', 2)).toBeNull();
	});
});

describe('textMechanicsFindings', () => {
	it('finds every fix in a whole text, without overlaps, and they apply cleanly', () => {
		const text = 'so i dont know. its really odd\n';
		const findings = textMechanicsFindings(text, {
			tagger: lexiconTagger(TEXT_MECHANICS_LEXICON)
		});
		expect(findings.map((f) => [text.slice(f.from, f.to), f.replacement])).toEqual([
			['so', 'So'],
			['i', 'I'],
			['dont', "don't"],
			['its', "It's"],
			['', '.']
		]);
		expect(findings[0].message).toBe('Write "so" as "So".');
		expect(applyTextMechanicsEdits(text, findings)).toBe("So I don't know. It's really odd.\n");
	});

	it('leaves code, math and tables alone', () => {
		const text = '```\ndont i\n```\n\n| dont | i |\n|---|---|\n| a | b |\n\n$dont i$ ok\n';
		expect(textMechanicsFindings(text).map((f) => text.slice(f.from, f.to))).toEqual(['ok']);
	});
});

describe('markdownProseMap', () => {
	it('reads blocks, their containers and where their text starts', () => {
		const map = markdownProseMap('---\ntitle: x\n---\n# Head\n\n- item\n  more\n\n> [!NOTE]\n> careful\n\n> quoted\n\n    code\n\n[^1]: a note\n');
		expect(map.blocks.map((b) => [b.kind, b.within.join('/')])).toEqual([
			['frontMatter', ''],
			['heading', ''],
			['paragraph', 'listItem'],
			['paragraph', 'alert'],
			['paragraph', 'quote'],
			['code', ''],
			['paragraph', 'footnote']
		]);
	});

	it("leaves code spans, links' addresses, images and HTML out of the prose", () => {
		const text = 'see `x` and [a](http://b) ![i](j) <b>c</b> done';
		const prose = markdownProseMap(text)
			.prose.map((r) => text.slice(r.from, r.to))
			.join('|');
		expect(prose).toBe('see | and [a]| | |c| done');
	});
});

describe('the text-mechanics contracts', () => {
	it('are current in @pixerate/conformance', () => {
		const dir = new URL('../../conformance/domains/text-mechanics/', import.meta.url);
		const contracts = textMechanicsContracts();
		expect(readdirSync(dir).sort()).toEqual(Object.keys(contracts).sort());
		for (const [file, value] of Object.entries(contracts)) {
			expect(JSON.parse(readFileSync(new URL(file, dir), 'utf8')), file).toEqual(JSON.parse(JSON.stringify(value)));
		}
	});
});

describe('createTextMechanicsToolProvider', () => {
	const tools = (provider: ReturnType<typeof createTextMechanicsToolProvider>) => (typeof provider.tools === 'function' ? provider.tools() : provider.tools);
	const call = (provider: ReturnType<typeof createTextMechanicsToolProvider>, name: string, args: Record<string, unknown> = {}) =>
		tools(provider)
			.find((t) => t.name === name)!
			.handler(args, {} as never) as any;

	it('checks a text and fixes it as one undo step', () => {
		let text = 'so i dont know it\n';
		const steps: string[] = [];
		const provider = createTextMechanicsToolProvider({
			getText: () => text,
			applyEdits: (edits, actionName) => {
				text = applyTextMechanicsEdits(text, edits);
				steps.push(actionName);
			}
		});
		expect(tools(provider).map((t) => t.name)).toEqual(['check_text_mechanics', 'fix_text_mechanics']);
		const report = call(provider, 'check_text_mechanics');
		expect(report.count).toBe(4);
		expect(report.findings[2]).toMatchObject({
			check: 'contractions',
			text: 'dont',
			replacement: "don't",
			from: 5,
			to: 9
		});
		expect(report.note).toMatch(/spell/);
		expect(call(provider, 'check_text_mechanics', { checks: ['pronoun-i'] }).count).toBe(1);
		expect(call(provider, 'fix_text_mechanics')).toEqual({
			fixed: 4,
			byCheck: {
				'pronoun-i': 1,
				contractions: 1,
				'sentence-case': 1,
				'terminal-punctuation': 1
			}
		});
		expect(text).toBe("So I don't know it.\n");
		expect(steps).toEqual(['Fix Punctuation and Spelling']);
		expect(call(provider, 'check_text_mechanics').ok).toBe(true);
	});

	it('offers only the check while the text is read-only, and the fix refuses with the reason', () => {
		let reason: string | null = 'The document is locked.';
		const provider = createTextMechanicsToolProvider({
			getText: () => 'i ',
			applyEdits: () => {},
			readOnlyReason: () => reason
		});
		expect(tools(provider).map((t) => t.name)).toEqual(['check_text_mechanics']);
		reason = null;
		expect(tools(provider).map((t) => t.name)).toEqual(['check_text_mechanics', 'fix_text_mechanics']);
		const fix = tools(provider).find((t) => t.name === 'fix_text_mechanics')!;
		reason = 'The document is locked.';
		expect(() => fix.handler({}, {} as never)).toThrow('The document is locked.');
		expect(tools(createTextMechanicsToolProvider({ getText: () => '' })).map((t) => t.name)).toEqual(['check_text_mechanics']);
	});
});
