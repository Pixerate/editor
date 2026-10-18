import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import { ToolRegistry, createRichTextToolProvider, type RichTextToolProviderOptions } from '../src/agent';
import {
	AgentCaret,
	agentCaretPluginKey,
	clearAgentCaret,
	createRichTextPreset,
	getAgentCarets,
	markAgentChanges,
	setAgentCaret,
	typeAgentText
} from '../src';

beforeAll(() => {
	// Visible, so typing animates (a hidden document applies edits at once).
	const dom = new JSDOM('', { pretendToBeVisual: true });
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
	(globalThis as any).Node = dom.window.Node;
	(globalThis as any).requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0);
});

afterEach(() => {
	vi.useRealTimers();
});

const makeEditor = (content = '<p>Hello brave world</p>', extra: any[] = []) =>
	new Editor({ extensions: [...createRichTextPreset(), ...extra], content });

function setup(presence: RichTextToolProviderOptions['presence'] = true, content?: string) {
	const editor = makeEditor(content);
	const registry = new ToolRegistry();
	registry.register(createRichTextToolProvider(editor, { id: 'doc', presence }));
	return { editor, registry };
}

const caretEl = (editor: Editor) => editor.view.dom.querySelector<HTMLElement>('.pe-agent-caret');
/** Position of "brave" in "Hello brave world" (paragraph content starts at 1). */
const BRAVE = { from: 7, to: 12 };

describe('agent caret plugin', () => {
	it('draws a named, coloured caret and a selection highlight, added on demand', () => {
		const editor = makeEditor();
		expect(agentCaretPluginKey.getState(editor.state)).toBeUndefined();
		setAgentCaret(editor, { id: 'claude', name: 'Claude', color: 'rgb(255, 0, 0)', ...BRAVE });
		const caret = caretEl(editor)!;
		expect(caret).not.toBeNull();
		expect(caret.dataset.agentId).toBe('claude');
		expect(caret.querySelector('.pe-agent-caret-label')!.textContent).toBe('Claude');
		expect(caret.style.borderLeft).toContain('rgb(255, 0, 0)');
		expect(editor.view.dom.querySelector('.pe-agent-selection')!.textContent).toBe('brave');
		// The caret is a decoration: the document is untouched.
		expect(editor.getText()).toBe('Hello brave world');
	});

	it('works as an extension and follows the text as others edit it', () => {
		const editor = makeEditor('<p>Hello brave world</p>', [AgentCaret]);
		expect(agentCaretPluginKey.getState(editor.state)).toBeDefined();
		setAgentCaret(editor, { id: 'a', from: BRAVE.to });
		editor.view.dispatch(editor.state.tr.insertText('Oh, ', 1));
		expect(getAgentCarets(editor.state)[0]).toMatchObject({ anchor: BRAVE.to + 4, head: BRAVE.to + 4, name: 'Agent' });
	});

	it('tints changed ranges and clears one or all carets', () => {
		const editor = makeEditor();
		setAgentCaret(editor, { id: 'a', from: 1 });
		setAgentCaret(editor, { id: 'b', from: 3 });
		markAgentChanges(editor, 'a', [BRAVE]);
		expect(editor.view.dom.querySelector('.pe-agent-changed')!.textContent).toBe('brave');
		clearAgentCaret(editor, 'a');
		expect(getAgentCarets(editor.state).map((c) => c.id)).toEqual(['b']);
		clearAgentCaret(editor);
		expect(caretEl(editor)).toBeNull();
	});

	it('clamps positions to the document', () => {
		const editor = makeEditor();
		setAgentCaret(editor, { id: 'a', from: -5, to: 999 });
		expect(getAgentCarets(editor.state)[0]).toMatchObject({ anchor: 0, head: editor.state.doc.content.size });
	});
});

describe('typeAgentText', () => {
	it('types frame by frame with the caret at the end, and commits one undo step', async () => {
		const editor = makeEditor();
		const tracked: string[] = [];
		editor.on('transaction', ({ transaction }) => {
			if (transaction.docChanged && transaction.getMeta('addToHistory') !== false) tracked.push(editor.getText());
		});
		const seen: string[] = [];
		const done = typeAgentText(editor, {
			...BRAVE,
			text: 'shiny new',
			caret: { id: 'a', name: 'Claude' },
			charsPerSecond: 30,
			wait: async () => {
				seen.push(editor.getText());
			}
		});
		const range = await done;
		expect(editor.getText()).toBe('Hello shiny new world');
		expect(range).toEqual({ from: 7, to: 16 });
		// First the selection is shown, then partial text appears.
		expect(seen[0]).toBe('Hello brave world');
		expect(seen.some((t) => /^Hello sh\w* world$/.test(t) && t !== 'Hello shiny new world')).toBe(true);
		expect(getAgentCarets(editor.state)[0].head).toBe(16);
		expect(tracked).toEqual(['Hello shiny new world']);
		editor.commands.undo();
		expect(editor.getText()).toBe('Hello brave world');
	});

	it('splits paragraphs exactly as an instant edit would', async () => {
		const typed = makeEditor();
		const instant = makeEditor();
		await typeAgentText(typed, { ...BRAVE, text: 'one\ntwo', caret: { id: 'a' }, wait: async () => {} });
		await typeAgentText(instant, { ...BRAVE, text: 'one\ntwo', caret: { id: 'a' }, charsPerSecond: Infinity });
		expect(typed.getHTML()).toBe(instant.getHTML());
		expect(typed.getHTML()).toBe('<p>Hello one</p><p>two world</p>');
	});

	it('rolls back and rejects when aborted', async () => {
		const editor = makeEditor();
		const controller = new AbortController();
		let frames = 0;
		const result = typeAgentText(editor, {
			...BRAVE,
			text: 'a much longer replacement',
			caret: { id: 'a' },
			signal: controller.signal,
			wait: async () => {
				if (++frames === 3) controller.abort();
			}
		});
		await expect(result).rejects.toThrow(/cancelled; the document is unchanged/);
		expect(editor.getText()).toBe('Hello brave world');
		expect(editor.can().undo()).toBe(false);
	});

	it('keeps an edit someone else makes while the agent types', async () => {
		const editor = makeEditor();
		let frames = 0;
		await typeAgentText(editor, {
			...BRAVE,
			text: 'shiny',
			caret: { id: 'a' },
			charsPerSecond: 10,
			wait: async () => {
				if (++frames === 2) editor.view.dispatch(editor.state.tr.insertText('Oh! ', 1));
			}
		});
		expect(editor.getText()).toBe('Oh! Hello shiny world');
	});
});

describe('rich-text tools show the agent caret', () => {
	it('find_text selects the first match with the caret', async () => {
		const { editor, registry } = setup();
		await registry.callTool('find_text', { query: 'brave' });
		expect(getAgentCarets(editor.state)[0]).toMatchObject({ id: 'doc', anchor: BRAVE.from, head: BRAVE.to });
	});

	it('replace_range returns the new range, moves the caret there and tints it for a moment', async () => {
		vi.useFakeTimers();
		const { editor, registry } = setup({ name: 'Claude', changedMs: 1000, idleMs: 5000 });
		const result = await registry.callTool('replace_range', { ...BRAVE, text: 'bold' });
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({ replaced: BRAVE, range: { from: 7, to: 11 } });
		expect(getAgentCarets(editor.state)[0]).toMatchObject({ name: 'Claude', head: 11 });
		expect(editor.view.dom.querySelector('.pe-agent-changed')!.textContent).toBe('bold');
		vi.advanceTimersByTime(1000);
		expect(editor.view.dom.querySelector('.pe-agent-changed')).toBeNull();
		vi.advanceTimersByTime(4000);
		expect(caretEl(editor)).toBeNull();
	});

	it('insert_text and replace_selection return the inserted range', async () => {
		const { registry } = setup();
		const inserted = await registry.callTool('insert_text', { text: 'Big ', at: 1 });
		expect(inserted.structuredContent).toMatchObject({ inserted: 4, range: { from: 1, to: 5 } });
		await registry.callTool('set_selection', { from: 11, to: 16 });
		const replaced = await registry.callTool('replace_selection', { text: 'calm' });
		expect(replaced.structuredContent).toMatchObject({ replaced: { from: 11, to: 16 }, range: { from: 11, to: 15 } });
	});

	it('replace_text tints every replaced range', async () => {
		const { editor, registry } = setup(true, '<p>cat and cat</p>');
		await registry.callTool('replace_text', { find: 'cat', replace: 'dog' });
		expect([...editor.view.dom.querySelectorAll('.pe-agent-changed')].map((el) => el.textContent)).toEqual(['dog', 'dog']);
	});

	it('types replacements out when typing is on, as one undo step', async () => {
		vi.useFakeTimers();
		const { editor, registry } = setup({ typing: { charsPerSecond: 20 } });
		const call = registry.callTool('replace_range', { ...BRAVE, text: 'gentle' });
		await vi.advanceTimersByTimeAsync(300);
		expect(editor.getText()).not.toBe('Hello brave world');
		expect(editor.getText()).not.toBe('Hello gentle world');
		await vi.runAllTimersAsync();
		const result = await call;
		expect(result.structuredContent).toMatchObject({ range: { from: 7, to: 13 } });
		expect(editor.getText()).toBe('Hello gentle world');
		editor.commands.undo();
		expect(editor.getText()).toBe('Hello brave world');
	});

	it('cancels typing through the call signal without changing the document', async () => {
		vi.useFakeTimers();
		const { editor, registry } = setup({ typing: true });
		const controller = new AbortController();
		const call = registry.callTool('insert_text', { text: 'a long sentence to type', at: 1 }, { signal: controller.signal });
		await vi.advanceTimersByTimeAsync(100);
		controller.abort();
		await vi.runAllTimersAsync();
		const result = await call;
		expect(result.isError).toBe(true);
		expect((result.structuredContent as any).error.message).toMatch(/cancelled/);
		expect(editor.getText()).toBe('Hello brave world');
	});

	it('leaves the document alone with presence: false', async () => {
		const { editor, registry } = setup(false);
		await registry.callTool('replace_range', { ...BRAVE, text: 'bold' });
		expect(agentCaretPluginKey.getState(editor.state)).toBeUndefined();
		expect(editor.getText()).toBe('Hello bold world');
	});
});
