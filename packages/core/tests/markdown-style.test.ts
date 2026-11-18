import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	applyMarkdownStyleEdits,
	checkMarkdownStyle,
	createMarkdownStyleToolProvider,
	createStyleResolver,
	createStyleToolProvider,
	markdownStyleContracts,
	markdownStyleEdits,
	markdownStyleFindings,
	markdownStyleState,
	MARKDOWN_NO_SURFACE_REASON,
	MARKDOWN_STYLE_ATOM,
	MARKDOWN_STYLE_CASES,
	memoryStyleStore,
	richTextStyleDomain,
	runMarkdownStyleCase,
	ToolRegistry,
	type MarkdownStyleEdit
} from '../src/tools';

const skill = '---\nname: house\ndescription: House writing style.\ndomains: [rich-text]\n---\n\nWrite plainly and warmly.\n';

const resolver = (profile: Record<string, unknown>, extra: Record<string, string> = {}) =>
	createStyleResolver({
		layers: [{ id: 'org', store: memoryStyleStore({ 'house/SKILL.md': skill, 'house/rich-text.json': JSON.stringify(profile), ...extra }) }],
		domains: [richTextStyleDomain]
	});

/** A text host that records each `applyEdits` call as one undo step. */
const host = (initial: string, readOnly?: string) => {
	let text = initial;
	const steps: { edits: readonly MarkdownStyleEdit[]; name: string }[] = [];
	return {
		getText: () => text,
		applyEdits: (edits: readonly MarkdownStyleEdit[], name: string) => {
			steps.push({ edits, name });
			text = applyMarkdownStyleEdits(text, edits);
		},
		readOnlyReason: () => readOnly ?? null,
		steps,
		get text() {
			return text;
		}
	};
};

const ISSUE_SOURCE = '# Our New Release Plan\n\nWe utilize the tool from 3/4/2026 onwards.\n';
const ISSUE_PROFILE = { headingCase: 'sentence', terms: [{ avoid: 'utilize', use: 'use' }], dateFormat: 'day-month-year', checks: ['heading-case', 'terms', 'date-format'] };

describe('markdownStyleState', () => {
	const texts = (source: string) => markdownStyleState(source).blocks.map((b) => [b.kind, b.level, b.text]);

	it('reads headings, paragraphs, list items and quotes with source positions', () => {
		const source = '# Title\n\nSub\n---\n\nA *para* with [a link](http://x.y "t").\n\n1. One\n2. Two\n\n> Quoted\n> on two lines\n';
		expect(texts(source)).toEqual([
			['heading', 1, 'Title'],
			['heading', 2, 'Sub'],
			['paragraph', undefined, 'A para with a link.'],
			['listItem', undefined, 'One'],
			['listItem', undefined, 'Two'],
			['quote', undefined, 'Quoted on two lines']
		]);
		for (const b of markdownStyleState(source).blocks) for (const s of b.segments) expect(source.slice(s.pos, s.pos + s.length)).toBe(b.text.slice(s.offset, s.offset + s.length));
	});

	it('leaves out code, math, HTML, tables, front matter and link definitions, and reads inline atoms as one character', () => {
		const source = '---\ntitle: x\n---\n\nRun `npm i` then $a$ and ![img](i.png) <b>x</b>.\n\n```js\nlet a = 1\n```\n\n$$\nx\n$$\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[ref]: http://example.com\n\n<div>html</div>\n';
		expect(texts(source)).toEqual([['paragraph', undefined, `Run ${MARKDOWN_STYLE_ATOM} then ${MARKDOWN_STYLE_ATOM} and ${MARKDOWN_STYLE_ATOM} ${MARKDOWN_STYLE_ATOM}x${MARKDOWN_STYLE_ATOM}.`]]);
		expect(markdownStyleState(source).runs).toEqual([]);
	});

	it('keeps snake_case and spaced asterisks as text, and drops escapes', () => {
		expect(texts('Use my_var and 5 * 3 and \\*literal\\*.')[0][2]).toBe('Use my_var and 5 * 3 and *literal*.');
		expect(texts('About ~5 minutes, ~~not~~ more.')[0][2]).toBe('About ~5 minutes, not more.');
	});

	it('counts UTF-16 code units', () => {
		const [block] = markdownStyleState('😀 **Hi**').blocks;
		expect(block.text).toBe('😀 Hi');
		expect(block.segments.map((s) => s.pos)).toEqual([0, 5]);
	});
});

describe('markdown house-style findings', () => {
	it('narrows certain fixes to whole words and keeps emphasis and link syntax', () => {
		const source = '## The **Big** Launch\n\nRead [the Utilize guide](https://example.com/utilize) to *utilize* it.\n';
		const findings = markdownStyleFindings(source, { headingCase: 'sentence', terms: [{ avoid: 'utilize', use: 'use' }], checks: ['heading-case', 'terms'] });
		expect(findings.map((f) => [f.check, source.slice(f.target!.from, f.target!.to), f.target!.replacement])).toEqual([
			['heading-case', 'Big** Launch', 'big** launch'],
			['terms', 'Utilize', 'Use'],
			['terms', 'utilize', 'use']
		]);
		expect(applyMarkdownStyleEdits(source, markdownStyleEdits(findings).edits)).toBe('## The **big** launch\n\nRead [the Use guide](https://example.com/utilize) to *use* it.\n');
	});

	it('adds a full stop after closing syntax and code spans, never inside them', () => {
		const source = '- Ship **now**\n- Run `make`\n- See [docs](#d)\n';
		const findings = markdownStyleFindings(source, { listItemEnd: 'period', checks: ['list-punctuation'] });
		expect(applyMarkdownStyleEdits(source, markdownStyleEdits(findings).edits)).toBe('- Ship **now**.\n- Run `make`.\n- See [docs](#d).\n');
	});

	it('leaves a fix uncertain when it would have to change syntax', () => {
		// "click **here**" → "tap" changes length across `**`: no certain replacement.
		const source = 'Please click **here** now.';
		const [finding] = markdownStyleFindings(source, { terms: [{ avoid: 'click here', use: 'tap' }], checks: ['terms'] });
		expect(finding.target).toEqual({ from: 7, to: 19 });
		// "click **here**" → "select here" only changes "click": certain.
		const [narrow] = markdownStyleFindings(source, { terms: [{ avoid: 'click here', use: 'select here' }], checks: ['terms'] });
		expect(narrow.target).toEqual({ from: 7, to: 12, replacement: 'select' });
	});

	it('reproduces every case of the contract', () => {
		for (const c of MARKDOWN_STYLE_CASES) {
			const run = runMarkdownStyleCase(c);
			// Every certain fix lands on the text it names, and fixing twice changes nothing more.
			expect(markdownStyleFindings(run.fixed, c.profile).filter((f) => f.target?.replacement !== undefined), c.name).toEqual([]);
		}
	});
});

describe('checkMarkdownStyle', () => {
	it('returns the issue example: three findings, two certain', async () => {
		const report = await checkMarkdownStyle(ISSUE_SOURCE, resolver(ISSUE_PROFILE));
		expect(report.findings.map((f) => [f.check, f.target])).toEqual([
			['heading-case', { from: 6, to: 22, replacement: 'new release plan' }],
			['terms', { from: 27, to: 34, replacement: 'use' }],
			['date-format', { from: 49, to: 57 }]
		]);
		expect(report.findings.every((f) => f.layer === 'org')).toBe(true);
		expect(report.ran).toEqual(['heading-case', 'terms', 'date-format']);
	});

	it("skips the brand's colour and font checks with a reason", async () => {
		const styles = resolver({ headingCase: 'sentence', checks: ['heading-case', 'fonts-allowed'] }, { 'house/brand.json': JSON.stringify({ colors: { primary: '#123456' }, checks: ['palette-only'] }) });
		const report = await checkMarkdownStyle('# Fine heading', styles);
		expect(report.ran).toEqual(['heading-case']);
		expect(report.skipped).toEqual([
			{ check: 'fonts-allowed', reason: MARKDOWN_NO_SURFACE_REASON },
			{ check: 'palette-only', reason: MARKDOWN_NO_SURFACE_REASON }
		]);
	});

	it('refuses a resolver without the rich-text domain', async () => {
		const styles = createStyleResolver({ layers: [{ id: 'org', store: memoryStyleStore({}) }], domains: [] });
		await expect(checkMarkdownStyle('x', styles)).rejects.toThrow('add richTextStyleDomain');
	});
});

describe('createMarkdownStyleToolProvider', () => {
	const setup = (source: string, profile: Record<string, unknown> = ISSUE_PROFILE, readOnly?: string) => {
		const h = host(source, readOnly);
		const styles = resolver(profile);
		const registry = new ToolRegistry();
		registry.register(createStyleToolProvider(styles));
		registry.register(createMarkdownStyleToolProvider(h, styles, { namespace: '' }));
		return { h, registry };
	};

	it('checks, then fixes the two certain findings as one undo step and leaves the date', async () => {
		const { h, registry } = setup(ISSUE_SOURCE);
		const check = await registry.callTool('check_rich_text_style');
		expect(check.isError).toBeFalsy();
		const report = check.structuredContent as any;
		expect(report.ok).toBe(false);
		expect(report.fixable).toBe(2);
		expect(report.findings.map((f: any) => [f.check, f.text])).toEqual([
			['heading-case', 'New Release Plan'],
			['terms', 'utilize'],
			['date-format', '3/4/2026']
		]);

		const fix = (await registry.callTool('fix_rich_text_style')).structuredContent as any;
		expect(fix.fixed).toBe(2);
		expect(fix.edits).toEqual([
			{ from: 6, to: 22, replacement: 'new release plan' },
			{ from: 27, to: 34, replacement: 'use' }
		]);
		expect(fix.left.map((f: any) => [f.check, f.text])).toEqual([['date-format', '3/4/2026']]);
		expect(h.steps).toHaveLength(1);
		expect(h.steps[0].name).toBe('Fix House Style');
		expect(h.text).toBe('# Our new release plan\n\nWe use the tool from 3/4/2026 onwards.\n');
	});

	it('fixes only the checks asked for', async () => {
		const { h, registry } = setup(ISSUE_SOURCE);
		const fix = (await registry.callTool('fix_rich_text_style', { checks: ['terms'] })).structuredContent as any;
		expect(fix.fixed).toBe(1);
		expect(h.text).toContain('# Our New Release Plan');
	});

	it('rejects invalid arguments', async () => {
		const { registry } = setup(ISSUE_SOURCE);
		const result = await registry.callTool('fix_rich_text_style', { checks: [] });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain('checks');
		expect((await registry.callTool('check_rich_text_style', { extra: 1 })).isError).toBe(true);
	});

	it('only checks a read-only text, and fix refuses with the reason', async () => {
		const { registry, h } = setup(ISSUE_SOURCE, ISSUE_PROFILE, 'The note is locked.');
		expect(registry.hasTool('check_rich_text_style')).toBe(true);
		expect(registry.hasTool('fix_rich_text_style')).toBe(false);
		const provider = createMarkdownStyleToolProvider(h, resolver(ISSUE_PROFILE));
		const fix = (typeof provider.tools === 'function' ? provider.tools() : provider.tools).find((t) => t.name === 'fix_rich_text_style');
		expect(fix).toBeUndefined();
		const lenient = createMarkdownStyleToolProvider({ getText: () => 'x' }, resolver(ISSUE_PROFILE));
		expect((typeof lenient.tools === 'function' ? lenient.tools() : lenient.tools).map((t) => t.name)).toEqual(['check_rich_text_style']);
	});

	it('says when no house style applies', async () => {
		const h = host('# Hi There');
		const styles = createStyleResolver({ layers: [{ id: 'org', store: memoryStyleStore({}) }], domains: [richTextStyleDomain] });
		const registry = new ToolRegistry();
		registry.register(createMarkdownStyleToolProvider(h, styles, { namespace: '' }));
		const report = (await registry.callTool('check_rich_text_style')).structuredContent as any;
		expect(report.ok).toBe(true);
		expect(report.note).toBe('No house style applies to documents.');
	});

	it('lets an agent read the skill prose and profile with get_style', async () => {
		const { registry } = setup(ISSUE_SOURCE);
		const result = await registry.callTool('get_style', { domain: 'rich-text' });
		expect(JSON.stringify(result.content)).toContain('Write plainly and warmly.');
		expect((result.structuredContent as any).profile.headingCase).toBe('sentence');
	});
});

describe('the markdown-style contracts', () => {
	it('are current in @pixerate/conformance', () => {
		const dir = new URL('../../conformance/domains/markdown-style/', import.meta.url);
		const contracts = markdownStyleContracts();
		expect(readdirSync(dir).sort()).toEqual(Object.keys(contracts).sort());
		for (const [file, value] of Object.entries(contracts)) {
			expect(JSON.parse(readFileSync(new URL(file, dir), 'utf8')), file).toEqual(JSON.parse(JSON.stringify(value)));
		}
	});
});
