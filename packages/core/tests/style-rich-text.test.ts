// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { ToolRegistry, createRichTextToolProvider, createStyleResolver, createStyleToolProvider, memoryStyleStore } from '../src/agent';
import {
	createRichTextPreset,
	createRichTextStyleToolProvider,
	richTextBlockPos,
	richTextHeadingCase,
	richTextStyleDomain,
	richTextStyleState,
	richTextStyleSurface
} from '../src';

const makeEditor = (content: string) => new Editor({ extensions: [...createRichTextPreset()], content });
const skill = '---\nname: house\ndescription: House writing style.\ndomains: [rich-text]\n---\n\nWrite plainly.\n';

const setup = (content: string, profile: Record<string, unknown>, brand?: Record<string, unknown>) => {
	const editor = makeEditor(content);
	const files: Record<string, string> = { 'house/SKILL.md': skill, 'house/rich-text.json': JSON.stringify(profile) };
	if (brand) files['house/brand.json'] = JSON.stringify(brand);
	const styles = createStyleResolver({ layers: [{ id: 'org', store: memoryStyleStore(files) }], domains: [richTextStyleDomain] });
	const registry = new ToolRegistry();
	registry.register(createStyleToolProvider(styles));
	registry.register(createRichTextToolProvider(editor, { id: 'doc', namespace: '' }));
	registry.register(createRichTextStyleToolProvider(editor, styles, { namespace: '' }));
	return { editor, styles, registry };
};

describe('richTextStyleState', () => {
	it('reads blocks with their kinds, levels and positions, and styled runs', () => {
		const editor = makeEditor(
			'<h2>Big <strong>news</strong></h2><p>Hello <span style="color: #ff0000">red</span> text</p><ul><li><p>One</p></li></ul><blockquote><p>Quoted</p></blockquote><pre><code>let x = "y"</code></pre>'
		);
		const state = richTextStyleState(editor.state.doc as any);
		expect(state.blocks.map((b) => [b.kind, b.level, b.text])).toEqual([
			['heading', 2, 'Big news'],
			['paragraph', undefined, 'Hello red text'],
			['listItem', undefined, 'One'],
			['quote', undefined, 'Quoted'],
			['code', undefined, 'let x = "y"']
		]);
		// Positions agree with the document: "news" in the heading, "red" in the paragraph.
		const [h, p] = state.blocks;
		expect(editor.state.doc.textBetween(richTextBlockPos(h, 4), richTextBlockPos(h, 8))).toBe('news');
		expect(editor.state.doc.textBetween(richTextBlockPos(p, 6), richTextBlockPos(p, 9))).toBe('red');
		// The DOM reads inline colours back as rgb(); the colour checks parse either.
		expect(state.runs).toEqual([{ text: 'red', from: richTextBlockPos(p, 6), to: richTextBlockPos(p, 9), color: 'rgb(255, 0, 0)' }]);
		expect(richTextStyleSurface(state).colors).toEqual([{ color: 'rgb(255, 0, 0)', label: 'Text "red"', target: { from: state.runs[0].from, to: state.runs[0].to }, use: 'text' }]);
	});
});

describe('heading case', () => {
	it.each([
		['the API Of acme', 'sentence', 'The API of Acme'],
		['Planning for Q3: The Next Steps', 'sentence', 'Planning for Q3: The next steps'],
		['a guide to the iOS app', 'title', 'A Guide to the iOS App'],
		['what we learned in 2026', 'title', 'What We Learned in 2026'],
		['Quiet', 'upper', 'QUIET']
	] as const)('%j in %s case', (text, kind, want) => {
		expect(richTextHeadingCase(text, kind, ['Acme'])).toBe(want);
	});
});

describe('checks', () => {
	const run = async (content: string, profile: Record<string, unknown>, brand?: Record<string, unknown>) => {
		const { styles, editor } = setup(content, profile, brand);
		return { report: await styles.check('rich-text', richTextStyleState(editor.state.doc as any)), editor };
	};

	it('heading-case and heading-levels', async () => {
		const { report, editor } = await run('<h1>Our Big Plan</h1><h3>Next Steps For Acme</h3><h4>deep</h4>', { headingCase: 'sentence', properNouns: ['Acme'], maxHeadingLevel: 3, checks: ['heading-case', 'heading-levels'] });
		expect(report.findings.map((f) => [f.check, (f.target as any).replacement])).toEqual([
			['heading-case', 'Our big plan'],
			['heading-case', 'Next steps for Acme'],
			['heading-case', 'Deep'],
			['heading-levels', undefined],
			['heading-levels', undefined]
		]);
		expect(report.findings[3].message).toBe('Heading "Next Steps For Acme" is level 3 after level 1; use level 2 so no level is skipped.');
		expect(report.findings[4].message).toMatch(/is level 4; the house style goes to level 3/);
		const t = report.findings[0].target as any;
		expect(editor.state.doc.textBetween(t.from, t.to)).toBe('Our Big Plan');
	});

	it('list-punctuation, quotes, terms, number-format and date-format', async () => {
		const { report } = await run(
			'<ul><li><p>First item.</p></li><li><p>Second</p></li></ul><p>We "utilize" it\'s 12500 users and 1.250.000 views on 11/12/2026 and 2026-11-12.</p><pre><code>"utilize" 99999</code></pre>',
			{ listItemEnd: 'none', quotes: 'curly', terms: [{ avoid: 'utilize', use: 'use' }], thousandsSeparator: ',', dateFormat: 'day-month-year', checks: ['list-punctuation', 'quotes', 'terms', 'number-format', 'date-format'] }
		);
		expect(report.findings.map((f) => [f.check, (f.target as any).replacement])).toEqual([
			['list-punctuation', ''],
			['quotes', '“'],
			['quotes', '”'],
			['quotes', '’'],
			['terms', 'use'],
			['number-format', '12,500'],
			['number-format', '1,250,000'],
			['date-format', '12 November 2026'],
			['date-format', undefined]
		]);
		expect(report.findings.find((f) => f.check === 'date-format' && !(f.target as any).replacement)?.message).toMatch(/11\/12\/2026 can be read as two different dates/);
	});

	it('runs the brand checks on text colours and fonts', async () => {
		const { report } = await run('<p>Plain <span style="color: #9933cc">purple</span></p>', { checks: ['palette-only'] }, { colors: { primary: '#0b5fff', text: '#111111' } });
		expect(report.findings).toEqual([expect.objectContaining({ check: 'palette-only', target: expect.objectContaining({ from: expect.any(Number) }) })]);
		expect((await run('<p>x</p>', {}, { fonts: { body: 'Inter' } })).report.style.profile).toEqual({ fonts: ['Inter'] });
	});

	it('skips a check whose profile field is missing, with the reason', async () => {
		const { report } = await run('<h1>x</h1>', { checks: ['heading-case'] });
		expect(report.skipped).toEqual([{ check: 'heading-case', reason: 'The check could not run: the profile has no "headingCase".' }]);
	});
});

describe('agent path', () => {
	it('check_rich_text_style returns findings replace_range can act on', async () => {
		const { registry, editor } = setup('<h1>Our Big Plan</h1><p>We utilize it.</p>', { headingCase: 'sentence', terms: [{ avoid: 'utilize', use: 'use' }], checks: ['heading-case', 'terms'] });
		const result = await registry.callTool('check_rich_text_style', {});
		expect(result.isError).toBeFalsy();
		const out = result.structuredContent as any;
		expect(out).toMatchObject({ ok: false, fixable: 2, ran: ['heading-case', 'terms'] });
		const { from, to, replacement } = out.findings[1].target;
		await registry.callTool('replace_range', { from, to, text: replacement });
		expect(editor.state.doc.textContent).toBe('Our Big PlanWe use it.');
	});

	it('fix_rich_text_style applies every certain fix as one undo step and leaves the rest', async () => {
		const { registry, editor } = setup('<h1>Our Big Plan</h1><h3>Skipped</h3><p>"Utilize" 12500 things.</p>', { headingCase: 'sentence', quotes: 'curly', terms: [{ avoid: 'utilize', use: 'use' }], thousandsSeparator: ',', checks: ['heading-case', 'heading-levels', 'quotes', 'terms', 'number-format'] });
		const result = await registry.callTool('fix_rich_text_style', {});
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({ fixed: 5, left: [expect.objectContaining({ check: 'heading-levels' })] });
		expect(editor.state.doc.textContent).toBe('Our big planSkipped“Use” 12,500 things.');
		expect((await registry.callTool('check_rich_text_style', {})).structuredContent).toMatchObject({ fixable: 0 });
		editor.commands.undo();
		expect(editor.state.doc.textContent).toBe('Our Big PlanSkipped"Utilize" 12500 things.');
		// Only some checks.
		const some = await registry.callTool('fix_rich_text_style', { checks: ['number-format'] });
		expect(some.structuredContent).toMatchObject({ fixed: 1 });
		expect(editor.state.doc.textContent).toBe('Our Big PlanSkipped"Utilize" 12,500 things.');
	});

	it('hides fix_rich_text_style on a read-only document, and refuses bad arguments', async () => {
		const { registry, editor } = setup('<h1>Our Big Plan</h1>', { headingCase: 'sentence', checks: ['heading-case'] });
		expect((await registry.callTool('fix_rich_text_style', { checks: [] })).isError).toBe(true);
		expect((await registry.callTool('check_rich_text_style', { extra: 1 })).isError).toBe(true);
		editor.setEditable(false);
		const names = registry.listTools().tools.map((t) => t.name);
		expect(names).toContain('check_rich_text_style');
		expect(names).not.toContain('fix_rich_text_style');
		expect((await registry.callTool('fix_rich_text_style', {})).isError).toBe(true);
	});

	it('says when no style applies, and needs the domain registered', async () => {
		const editor = makeEditor('<p>x</p>');
		const styles = createStyleResolver({ layers: [{ id: 'org', store: memoryStyleStore({}) }], domains: [richTextStyleDomain] });
		const registry = new ToolRegistry();
		registry.register(createRichTextStyleToolProvider(editor, styles, { namespace: '' }));
		expect((await registry.callTool('check_rich_text_style', {})).structuredContent).toMatchObject({ ok: true, note: 'No house style applies to documents.' });
		expect(() => createRichTextStyleToolProvider(editor, createStyleResolver({ layers: [], domains: [] }))).toThrow(/no "rich-text" domain/);
	});
});
