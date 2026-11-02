import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { TextSelection } from '@tiptap/pm/state';
import { getCommentStore } from '../extensions/comments.js';
import type { CommentThread, ReviewAuthor } from '../extensions/comment-store.js';
import {
	getTrackChangesStore,
	getTrackedChanges,
	isTrackChangesEnabled,
	type TrackedChange,
	type TrackedChangeType
} from '../extensions/track-changes.js';
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { RichTextToolTarget, ToolProviderOptions } from './providers.js';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const CHANGE_TYPES: TrackedChangeType[] = ['insertion', 'deletion', 'format', 'block', 'move'];

export interface ReviewToolProviderOptions extends ToolProviderOptions {
	/** Who the agent's comments, replies and resolutions are attributed to (default `{ id: 'agent', name: 'Agent' }`). */
	author?: ReviewAuthor;
}

const toEditor = (target: RichTextToolTarget): Editor =>
	'commands' in target ? (target as Editor) : (target as { editor: Editor }).editor;

function describeThread(thread: CommentThread) {
	return {
		id: thread.id,
		from: thread.anchor?.from ?? null,
		to: thread.anchor?.to ?? null,
		quote: thread.anchor?.quote ?? thread.lastQuote ?? '',
		author: thread.author.name,
		body: thread.body,
		replies: thread.replies.map((r) => ({ id: r.id, author: r.author.name, body: r.body })),
		resolved: thread.resolved,
		orphaned: thread.orphaned
	};
}

function describeChange(change: TrackedChange) {
	return {
		id: change.id,
		type: change.type,
		author: change.author.name,
		from: change.from,
		to: change.to,
		text: change.text,
		description: change.description,
		...(change.move ? { movedFrom: change.move.fromText, movedTo: change.move.toText } : {})
	};
}

/**
 * Review tools for a rich-text editor with the `Comments` and / or `TrackChanges` extensions.
 * Comments: `list_comments` (read), `add_comment`, `reply_to_comment`, `resolve_comment` and
 * `delete_comment`. Tracked changes: `list_changes` (read), `accept_change`, `reject_change`,
 * `accept_all_changes`, `reject_all_changes` and `set_track_changes`. Each group appears only
 * when its extension is installed, and the write tools only while the editor is editable.
 * Every write that changes the document is one undo step.
 */
export function createReviewToolProvider(target: RichTextToolTarget, options: ReviewToolProviderOptions): AgentToolProvider {
	const editor = () => toEditor(target);
	const author = options.author ?? { id: 'agent', name: 'Agent' };

	const store = () => {
		const s = getCommentStore(editor());
		if (!s) throw new Error('This editor has no Comments extension.');
		return s;
	};
	const findThread = (id: string): CommentThread => {
		const thread = store().getThread(id);
		if (!thread) {
			const ids = store().getSnapshot().threads.map((t) => `"${t.id}"`).join(', ') || 'none; add one with add_comment';
			throw new Error(`There is no comment "${id}". Comments: ${ids}. Call list_comments for current ids.`);
		}
		return thread;
	};
	const findChange = (id: string): TrackedChange => {
		const changes = getTrackedChanges(editor().state.doc);
		const change = changes.find((c) => c.id === id);
		if (!change) {
			const ids = changes.map((c) => `"${c.id}"`).join(', ') || 'none';
			throw new Error(`There is no tracked change "${id}". Changes: ${ids}. Call list_changes for current ids; accepting or rejecting one removes it.`);
		}
		return change;
	};
	const commentId = { type: 'string', description: 'Comment thread id from list_comments.' } as const;
	const changeId = { type: 'string', description: 'Tracked change id from list_changes.' } as const;
	const body = (what: string) => ({ type: 'string', minLength: 1, description: `${what} (plain text, not empty).` }) as const;

	const listComments: AgentTool = {
		name: 'list_comments',
		title: 'List comments',
		description:
			'Lists comment threads in document order: id, the commented range {from, to} and its quoted text, author, body, replies (id, author, body), and whether each is resolved or orphaned (its text was deleted; from / to are null). Pass an id to reply_to_comment, resolve_comment or delete_comment.',
		inputSchema: {
			type: 'object',
			properties: { includeResolved: { type: 'boolean', description: 'Also list resolved threads (default true).' } },
			additionalProperties: false
		},
		annotations: { title: 'List comments', ...READ },
		handler: ({ includeResolved = true }) => {
			const threads = store().getSnapshot().threads.filter((t) => includeResolved || !t.resolved);
			return { count: threads.length, comments: threads.map(describeThread) };
		}
	};

	const addComment: AgentTool = {
		name: 'add_comment',
		title: 'Add a comment',
		description:
			'Comments on the text between from and to (document positions, e.g. from find_text), as one undo step. Returns the new thread (id, range, quoted text, body). The user\'s selection moves to the commented text.',
		inputSchema: {
			type: 'object',
			properties: {
				from: { type: 'integer', minimum: 0, description: 'Start of the commented text (document position).' },
				to: { type: 'integer', minimum: 0, description: 'End of the commented text (document position, after from).' },
				body: body('The comment')
			},
			required: ['from', 'to', 'body'],
			additionalProperties: false
		},
		annotations: { title: 'Add a comment', ...WRITE },
		handler: ({ from, to, body: text }) => {
			const ed = editor();
			const size = ed.state.doc.content.size;
			if (from >= to) throw new Error(`"from" (${from}) must be before "to" (${to}); a comment needs some text.`);
			if (to > size) throw new Error(`Position ${to} is outside the document (size ${size}).`);
			if (!ed.state.doc.textBetween(from, to, ' ', ' ').trim()) throw new Error(`There is no text between ${from} and ${to}; use find_text to get the positions of a phrase.`);
			const before = new Set(store().getSnapshot().threads.map((t) => t.id));
			const ok = ed
				.chain()
				.command(({ tr }) => {
					closeHistory(tr);
					tr.setSelection(TextSelection.create(tr.doc, from, to));
					return true;
				})
				.addComment({ body: text, author })
				.run();
			const thread = store().getSnapshot().threads.find((t) => !before.has(t.id));
			if (!ok || !thread) throw new Error(`A comment cannot go on ${from}..${to}; pick a range of text from find_text.`);
			return describeThread(thread);
		}
	};

	const replyToComment: AgentTool = {
		name: 'reply_to_comment',
		title: 'Reply to a comment',
		description: 'Adds a reply to a comment thread. Replying to a resolved thread re-opens it. Returns the reply id and the thread.',
		inputSchema: {
			type: 'object',
			properties: { commentId, body: body('The reply') },
			required: ['commentId', 'body'],
			additionalProperties: false
		},
		annotations: { title: 'Reply to a comment', ...WRITE },
		handler: ({ commentId: id, body: text }) => {
			findThread(id);
			const reply = store().addReply(id, { body: text, author });
			return { replyId: reply!.id, comment: describeThread(findThread(id)) };
		}
	};

	const resolveComment: AgentTool = {
		name: 'resolve_comment',
		title: 'Resolve a comment',
		description:
			'Marks a comment thread resolved (or re-opens it with resolved: false). The thread and its text stay; resolved threads are hidden from the highlights. Returns the thread.',
		inputSchema: {
			type: 'object',
			properties: { commentId, resolved: { type: 'boolean', description: 'true resolves, false re-opens (default true).' } },
			required: ['commentId'],
			additionalProperties: false
		},
		annotations: { title: 'Resolve a comment', ...WRITE_IDEMPOTENT },
		handler: ({ commentId: id, resolved = true }) => {
			findThread(id);
			store().resolveThread(id, resolved, author);
			return describeThread(findThread(id));
		}
	};

	const deleteComment: AgentTool = {
		name: 'delete_comment',
		title: 'Delete a comment',
		description:
			'Deletes a comment thread and its replies, and removes its highlight from the text (one undo step). Prefer resolve_comment when the point was addressed. Returns the deleted id and how many comments remain.',
		inputSchema: { type: 'object', properties: { commentId }, required: ['commentId'], additionalProperties: false },
		annotations: { title: 'Delete a comment', ...DESTRUCTIVE },
		handler: ({ commentId: id }) => {
			findThread(id);
			editor()
				.chain()
				.command(({ tr }) => (closeHistory(tr), true))
				.deleteComment(id)
				.run();
			return { deleted: id, remaining: store().getSnapshot().threads.length };
		}
	};

	const listChanges: AgentTool = {
		name: 'list_changes',
		title: 'List tracked changes',
		description:
			'Lists tracked changes (suggestions) in document order: id, type (insertion, deletion, format, block, move), author, range {from, to}, the changed text and a plain-language description; moves add movedFrom / movedTo. Also says whether tracking is on. Pass an id to accept_change or reject_change.',
		inputSchema: {
			type: 'object',
			properties: { type: { type: 'string', enum: CHANGE_TYPES, description: 'Only list changes of this type (default: all).' } },
			additionalProperties: false
		},
		annotations: { title: 'List tracked changes', ...READ },
		handler: ({ type }) => {
			const changes = getTrackedChanges(editor().state.doc).filter((c) => !type || c.type === type);
			return { trackingEnabled: isTrackChangesEnabled(editor()), count: changes.length, changes: changes.map(describeChange) };
		}
	};

	const decide = (decision: 'accept' | 'reject'): AgentTool => {
		const verb = decision === 'accept' ? 'Accept' : 'Reject';
		return {
			name: `${decision}_change`,
			title: `${verb} a tracked change`,
			description:
				decision === 'accept'
					? 'Accepts one tracked change as one undo step: inserted text stays, deleted text goes, new formatting or block type is kept, a move keeps its destination. Returns the change and how many remain.'
					: 'Rejects one tracked change as one undo step: inserted text goes, deleted text comes back, formatting or block type reverts, a move goes back to its source. Returns the change and how many remain.',
			inputSchema: { type: 'object', properties: { changeId }, required: ['changeId'], additionalProperties: false },
			annotations: { title: `${verb} a tracked change`, ...WRITE },
			handler: ({ changeId: id }) => {
				const change = findChange(id);
				const chain = editor().chain().command(({ tr }) => (closeHistory(tr), true));
				const ok = (decision === 'accept' ? chain.acceptChange(id) : chain.rejectChange(id)).run();
				if (!ok) throw new Error(`Tracked change "${id}" could not be ${decision}ed.`);
				return { [`${decision}ed`]: describeChange(change), remaining: getTrackedChanges(editor().state.doc).length };
			}
		};
	};

	const decideAll = (decision: 'accept' | 'reject'): AgentTool => {
		const verb = decision === 'accept' ? 'Accept' : 'Reject';
		return {
			name: `${decision}_all_changes`,
			title: `${verb} all tracked changes`,
			description: `${verb}s every tracked change in the document as one undo step. Review them with list_changes first; prefer ${decision}_change for one at a time. Returns how many were ${decision}ed.`,
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			annotations: { title: `${verb} all tracked changes`, ...DESTRUCTIVE },
			handler: () => {
				const count = getTrackedChanges(editor().state.doc).length;
				if (count === 0) return { [`${decision}ed`]: 0 };
				const chain = editor().chain().command(({ tr }) => (closeHistory(tr), true));
				(decision === 'accept' ? chain.acceptAllChanges() : chain.rejectAllChanges()).run();
				return { [`${decision}ed`]: count, remaining: getTrackedChanges(editor().state.doc).length };
			}
		};
	};

	const setTrackChanges: AgentTool = {
		name: 'set_track_changes',
		title: 'Turn tracking on or off',
		description:
			'Turns change tracking (suggestion mode) on or off. While on, every edit, the agent\'s included, is recorded as a tracked change the user can accept or reject. Returns whether tracking is now on.',
		inputSchema: {
			type: 'object',
			properties: { enabled: { type: 'boolean', description: 'true records edits as tracked changes; false edits directly.' } },
			required: ['enabled'],
			additionalProperties: false
		},
		annotations: { title: 'Turn tracking on or off', ...WRITE_IDEMPOTENT },
		handler: ({ enabled }) => {
			editor().commands.setTrackChanges(enabled);
			return { trackingEnabled: isTrackChangesEnabled(editor()) };
		}
	};

	const acceptChange = decide('accept');
	const rejectChange = decide('reject');
	const acceptAll = decideAll('accept');
	const rejectAll = decideAll('reject');

	return {
		id: options.id,
		namespace: options.namespace,
		title: 'Review',
		description: 'Comments and tracked changes (suggestions) in a rich text document: list, add, reply to and resolve comments; list, accept and reject changes.',
		skill: 'pixerate-rich-text',
		tools: () => {
			const ed = editor();
			if (!ed || ed.isDestroyed) return [];
			const comments = !!getCommentStore(ed);
			const changes = !!getTrackChangesStore(ed);
			const tools: AgentTool[] = [...(comments ? [listComments] : []), ...(changes ? [listChanges] : [])];
			if (!ed.isEditable) return tools;
			if (comments) tools.push(addComment, replyToComment, resolveComment, deleteComment);
			if (changes) tools.push(acceptChange, rejectChange, acceptAll, rejectAll, setTrackChanges);
			return tools;
		},
		subscribe: (notify) => {
			const ed = editor();
			ed.on('update', notify);
			ed.on('destroy', notify);
			return () => {
				ed.off('update', notify);
				ed.off('destroy', notify);
			};
		}
	};
}
