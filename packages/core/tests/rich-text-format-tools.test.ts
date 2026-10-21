import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import { createRichTextPreset } from '../src';
import { ToolRegistry, baseToolName } from '../src/tools';
import { createRichTextToolProvider } from '../src/agent';

beforeAll(() => {
	const dom = new JSDOM();
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
	(globalThis as any).Node = dom.window.Node;
});

const setup = (html: string) => {
	const editor = new Editor({ extensions: createRichTextPreset({ table: false }), content: html });
	const registry = new ToolRegistry();
	registry.register(createRichTextToolProvider(editor, { id: 'doc', presence: false }));
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await registry.callTool(name, args);
		return { ...result, data: result.structuredContent as any, text: (result.content[0] as any)?.text as string };
	};
	const find = async (query: string) => {
		const { from, to } = (await call('find_text', { query })).data.matches[0];
		return { from, to } as { from: number; to: number };
	};
	return { editor, registry, call, find };
};

describe('rich text formatting tools', () => {
	it('lists strict tools for what the schema supports, and none while read-only', () => {
		const { editor, registry } = setup('<p>x</p>');
		const tools = registry.listTools().tools;
		const names = tools.map((t) => baseToolName(t.name));
		expect(names).toEqual(expect.arrayContaining(['format_text', 'set_block_type', 'set_text_align']));
		const format = tools.find((t) => t.name === 'doc__format_text')!;
		expect(Object.keys(format.inputSchema.properties!)).toEqual(['from', 'to', 'bold', 'italic', 'underline', 'strike', 'code', 'link', 'highlight', 'color', 'fontSize']);
		const block = tools.find((t) => t.name === 'doc__set_block_type')!;
		expect((block.inputSchema.properties as any).type.enum).toEqual(['paragraph', 'heading', 'bullet_list', 'ordered_list', 'task_list', 'blockquote', 'code_block']);
		expect((block.inputSchema.properties as any).level.enum).toEqual([1, 2, 3, 4]);
		editor.setEditable(false);
		expect(registry.listTools().tools.map((t) => baseToolName(t.name))).toEqual(['get_text', 'find_text']);
		editor.destroy();
	});

	it('formats a found range in one undo step and keeps the selection', async () => {
		const { editor, call, find } = setup('<p>Hello brave new world</p>');
		editor.commands.setTextSelection(1);
		const range = await find('brave new');
		const result = await call('format_text', { ...range, bold: true, italic: true, color: '#ff0000' });
		expect(result.isError).toBeUndefined();
		expect(result.data).toEqual({ range, text: 'brave new', formatting: { bold: true, italic: true, color: '#ff0000' } });
		// Mark nesting follows the schema's mark order, so check each mark rather than one string.
		const html = editor.getHTML();
		for (const part of ['<strong>', '<em>', 'style="color:', '>brave new<']) expect(html).toContain(part);
		expect(editor.state.selection.from).toBe(1);

		editor.commands.undo();
		expect(editor.getHTML()).toBe('<p>Hello brave new world</p>');
		editor.commands.redo();

		// Clearing one mark over part of the range leaves the rest.
		const brave = await find('brave');
		const cleared = await call('format_text', { ...brave, bold: false, color: null });
		expect(cleared.data.formatting).toEqual({ italic: true });
		const whole = await call('format_text', { ...range, underline: true });
		expect(whole.data.formatting).toEqual({ bold: 'partly', italic: true, underline: true, color: 'mixed' });
		editor.destroy();
	});

	it('sets links, highlights and font sizes, and refuses unsafe links without changing anything', async () => {
		const { editor, call, find } = setup('<p>Read the docs today</p>');
		const docs = await find('docs');
		const linked = await call('format_text', { ...docs, link: 'https://example.com/docs', highlight: 'yellow', fontSize: '18px' });
		expect(linked.data.formatting).toEqual({ link: 'https://example.com/docs', highlight: 'yellow', fontSize: '18px' });
		expect(editor.getHTML()).toContain('href="https://example.com/docs"');
		const before = editor.getHTML();
		const unsafe = await call('format_text', { ...docs, link: 'javascript:alert(1)' });
		expect(unsafe.isError).toBe(true);
		expect(unsafe.text).toBe('Links may not use javascript:, data: or vbscript: URLs. Nothing was changed.');
		expect(editor.getHTML()).toBe(before);
		const removed = await call('format_text', { ...docs, link: null, highlight: null, fontSize: null });
		expect(removed.data.formatting).toEqual({});
		expect(editor.getHTML()).toBe('<p>Read the docs today</p>');
		editor.destroy();
	});

	it('uses the selection when no range is given, and fails usefully', async () => {
		const { editor, call } = setup('<p>Hello world</p>');
		editor.commands.setTextSelection({ from: 7, to: 12 });
		expect((await call('format_text', { bold: true })).data.text).toBe('world');
		expect((await call('format_text', {})).text).toMatch(/^Pass at least one formatting property: bold, italic/);
		expect((await call('format_text', { from: 3, bold: true })).text).toBe('Pass both "from" and "to", or neither to use the selection.');
		expect((await call('format_text', { from: 3, to: 3, bold: true })).text).toMatch(/^The range is empty/);
		expect((await call('format_text', { from: 5, to: 2, bold: true })).text).toBe('"from" (5) must not be after "to" (2).');
		expect((await call('format_text', { from: 1, to: 999, bold: true })).text).toBe('Position 999 is outside the document (size 13).');
		const unknown = await call('format_text', { from: 1, to: 3, subscript: true });
		expect(unknown.data.error.code).toBe('invalid_arguments');
		expect(unknown.text).toContain('/subscript');
		editor.destroy();
	});

	it('turns paragraphs into headings, lists, quotes and back', async () => {
		const { editor, call, find } = setup('<p>Title</p><p>one</p><p>two</p>');
		const title = await find('Title');
		const heading = await call('set_block_type', { ...title, type: 'heading', level: 2 });
		expect(heading.data.blocks).toEqual([{ type: 'heading', from: 1, to: 6, text: 'Title', level: 2 }]);

		const one = await find('one');
		const two = await find('two');
		const list = await call('set_block_type', { from: one.from, to: two.to, type: 'bullet_list' });
		expect(list.data.blocks.map((b: any) => [b.type, b.text, b.in])).toEqual([
			['paragraph', 'one', 'bulletList'],
			['paragraph', 'two', 'bulletList']
		]);
		expect(editor.getHTML()).toContain('<ul class="list-disc pl-4"><li><p>one</p></li><li><p>two</p></li></ul>');

		// One call switches between kinds, as one undo step.
		const ordered = await call('set_block_type', { ...list.data.range, type: 'ordered_list' });
		expect(ordered.data.blocks.map((b: any) => b.in)).toEqual(['orderedList', 'orderedList']);
		editor.commands.undo();
		expect(editor.getHTML()).toContain('<ul');

		const tasks = await call('set_block_type', { ...list.data.range, type: 'task_list' });
		expect(tasks.data.blocks.map((b: any) => [b.in, b.checked])).toEqual([['taskList', false], ['taskList', false]]);
		const quote = await call('set_block_type', { ...tasks.data.range, type: 'blockquote' });
		expect(quote.data.blocks.map((b: any) => b.in)).toEqual(['blockquote', 'blockquote']);
		const plain = await call('set_block_type', { ...quote.data.range, type: 'paragraph' });
		expect(plain.data.blocks.map((b: any) => [b.type, b.in])).toEqual([['paragraph', undefined], ['paragraph', undefined]]);
		expect(editor.getHTML()).toBe('<h2 class="font-bold tracking-tight">Title</h2><p>one</p><p>two</p>');
		editor.destroy();
	});

	it('checks heading levels', async () => {
		const { editor, call } = setup('<p>Title</p>');
		expect((await call('set_block_type', { from: 1, to: 6, type: 'heading' })).text).toBe('Pass a heading "level" (1, 2, 3, 4).');
		expect((await call('set_block_type', { from: 1, to: 6, type: 'paragraph', level: 2 })).text).toBe('"level" only applies to type "heading".');
		expect((await call('set_block_type', { from: 1, to: 6, type: 'heading', level: 5 })).data.error.code).toBe('invalid_arguments');
		expect(editor.getHTML()).toBe('<p>Title</p>');
		editor.destroy();
	});

	it('aligns paragraphs and headings', async () => {
		const { editor, call } = setup('<h1>Title</h1><p>body</p>');
		const centred = await call('set_text_align', { from: 1, to: 12, align: 'center' });
		expect(centred.data.blocks.map((b: any) => [b.type, b.align])).toEqual([['heading', 'center'], ['paragraph', 'center']]);
		const reset = await call('set_text_align', { from: 8, to: 8, align: null });
		expect(reset.data.blocks).toEqual([{ type: 'paragraph', from: 8, to: 12, text: 'body' }]);
		expect((await call('set_text_align', { from: 1, to: 6, align: 'diagonal' })).data.error.code).toBe('invalid_arguments');
		editor.destroy();
	});
});

describe('rich text tool undo steps', () => {
	it('makes every write call its own undo step, however quickly calls follow each other', async () => {
		const { editor, call } = setup('<p>one two</p>');
		await call('replace_text', { find: 'one', replace: 'ONE' });
		await call('replace_text', { find: 'two', replace: 'TWO' });
		await call('insert_text', { text: '!', at: 8 });
		await call('format_text', { from: 1, to: 4, bold: true });
		const states: string[] = [];
		for (let i = 0; i < 4; i++) {
			editor.commands.undo();
			states.push(editor.getText());
		}
		expect(states).toEqual(['ONE TWO!', 'ONE TWO', 'ONE two', 'one two']);
		expect(editor.getHTML()).toBe('<p>one two</p>');
		editor.destroy();
	});
});
