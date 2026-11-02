import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import { ToolRegistry, createReviewToolProvider } from '../src/agent';
import { CommentStore, createRichTextPreset, getTrackedChanges } from '../src';

beforeAll(() => {
	const dom = new JSDOM();
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
	(globalThis as any).Node = dom.window.Node;
});

const user = { id: 'user', name: 'User' };

function setup(options: { comments?: boolean; trackChanges?: boolean; content?: string } = {}) {
	const store = new CommentStore();
	let id = 0;
	const editor = new Editor({
		extensions: createRichTextPreset({
			markdown: false,
			comments: options.comments === false ? false : { store, author: user },
			trackChanges: options.trackChanges === false ? false : { author: user, generateId: () => `ch-${++id}` }
		}),
		content: options.content ?? '<p>Hello brave world</p>'
	});
	const tools = new ToolRegistry();
	tools.register(createReviewToolProvider(editor, { id: 'review', namespace: '' }));
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await tools.callTool(name, args);
		return { ...result, value: result.structuredContent as any, text: (result.content[0] as any)?.text as string };
	};
	const names = () => tools.listTools().tools.map((t) => t.name);
	return { editor, store, tools, call, names };
}

/** Positions of `text` in the first paragraph. */
const range = (editor: Editor, text: string) => {
	const from = editor.state.doc.textContent.indexOf(text) + 1;
	return { from, to: from + text.length };
};

describe('createReviewToolProvider', () => {
	it('lists comment and change tools only for installed extensions and hides writes when read-only', () => {
		expect(setup().names().sort()).toEqual(
			[
				'accept_all_changes',
				'accept_change',
				'add_comment',
				'delete_comment',
				'list_changes',
				'list_comments',
				'reject_all_changes',
				'reject_change',
				'reply_to_comment',
				'resolve_comment',
				'set_track_changes'
			].sort()
		);
		expect(setup({ trackChanges: false }).names()).not.toContain('list_changes');
		expect(setup({ comments: false }).names()).not.toContain('list_comments');
		const ro = setup();
		ro.editor.setEditable(false);
		expect(ro.names().sort()).toEqual(['list_changes', 'list_comments']);
	});

	it('adds, lists, replies to, resolves and deletes comments by id', async () => {
		const { editor, call } = setup();
		const added = await call('add_comment', { ...range(editor, 'brave'), body: 'Too bold?' });
		expect(added.isError).toBeFalsy();
		expect(added.value).toMatchObject({ quote: 'brave', body: 'Too bold?', author: 'Agent', resolved: false });
		const id = added.value.id;

		const listed = await call('list_comments');
		expect(listed.value.count).toBe(1);
		expect(listed.value.comments[0]).toMatchObject({ id, ...range(editor, 'brave') });

		const reply = await call('reply_to_comment', { commentId: id, body: 'Agreed.' });
		expect(reply.value.replyId).toBeTruthy();
		expect(reply.value.comment.replies).toEqual([{ id: reply.value.replyId, author: 'Agent', body: 'Agreed.' }]);

		expect((await call('resolve_comment', { commentId: id })).value.resolved).toBe(true);
		expect((await call('list_comments', { includeResolved: false })).value.count).toBe(0);
		expect((await call('resolve_comment', { commentId: id, resolved: false })).value.resolved).toBe(false);

		const deleted = await call('delete_comment', { commentId: id });
		expect(deleted.value).toEqual({ deleted: id, remaining: 0 });
		expect(editor.getHTML()).not.toContain('data-comment-id');
	});

	it('adds a comment as one undo step', async () => {
		const { editor, call } = setup();
		await call('add_comment', { ...range(editor, 'Hello'), body: 'Greeting' });
		expect(editor.getHTML()).toContain('data-comment-id');
		editor.commands.undo();
		expect(editor.getHTML()).not.toContain('data-comment-id');
	});

	it('refuses bad comment input with a useful error and changes nothing', async () => {
		const { editor, call } = setup();
		const before = editor.getHTML();
		const empty = await call('add_comment', { from: 3, to: 3, body: 'x' });
		expect(empty.isError).toBe(true);
		expect(empty.text).toMatch(/must be before/);
		const outside = await call('add_comment', { from: 1, to: 999, body: 'x' });
		expect(outside.text).toMatch(/outside the document/);
		const noBody = await call('add_comment', { from: 1, to: 3, body: '' });
		expect(noBody.isError).toBe(true);
		const extra = await call('add_comment', { from: 1, to: 3, body: 'x', color: 'red' });
		expect(extra.isError).toBe(true);
		const unknown = await call('resolve_comment', { commentId: 'nope' });
		expect(unknown.isError).toBe(true);
		expect(unknown.text).toMatch(/no comment "nope".*list_comments/);
		expect(editor.getHTML()).toBe(before);
	});

	it('lists, accepts and rejects tracked changes by id, one undo step each', async () => {
		const { editor, call } = setup();
		expect((await call('set_track_changes', { enabled: true })).value).toEqual({ trackingEnabled: true });
		editor.commands.insertContentAt(range(editor, 'world').to, ' and moon');
		editor.commands.deleteRange(range(editor, 'brave '));

		const listed = await call('list_changes');
		expect(listed.value.trackingEnabled).toBe(true);
		expect(listed.value.changes.map((c: any) => [c.type, c.text])).toEqual([
			['deletion', 'brave '],
			['insertion', ' and moon']
		]);
		const [deletion, insertion] = listed.value.changes;
		expect((await call('list_changes', { type: 'insertion' })).value.count).toBe(1);

		const accepted = await call('accept_change', { changeId: insertion.id });
		expect(accepted.value).toMatchObject({ accepted: { id: insertion.id, type: 'insertion' }, remaining: 1 });
		const rejected = await call('reject_change', { changeId: deletion.id });
		expect(rejected.value.remaining).toBe(0);
		expect(editor.state.doc.textContent).toBe('Hello brave world and moon');

		editor.commands.undo();
		expect(getTrackedChanges(editor).map((c) => c.id)).toEqual([deletion.id]);
	});

	it('accepts or rejects every change at once', async () => {
		const { editor, call } = setup();
		await call('set_track_changes', { enabled: true });
		editor.commands.insertContentAt(1, 'Oh, ');
		editor.commands.deleteRange(range(editor, ' world'));
		expect((await call('reject_all_changes')).value).toEqual({ rejected: 2, remaining: 0 });
		expect(editor.state.doc.textContent).toBe('Hello brave world');
		expect((await call('accept_all_changes')).value).toEqual({ accepted: 0 });
	});

	it('refuses unknown change ids with the ids that exist', async () => {
		const { editor, call } = setup();
		await call('set_track_changes', { enabled: true });
		editor.commands.insertContentAt(1, 'Oh, ');
		const result = await call('accept_change', { changeId: 'ch-404' });
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/no tracked change "ch-404".*"ch-1".*list_changes/);
		expect((await call('list_changes')).value.count).toBe(1);
	});
});
