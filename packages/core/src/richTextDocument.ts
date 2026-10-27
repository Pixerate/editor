import type { Editor, JSONContent } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { defineEditorDocument, type EditorDocument } from './persistence/editorDocument.js';

/**
 * The save / load / undo contract for a TipTap editor (kind `rich_text`, document: the
 * ProseMirror JSON from `editor.getJSON()`, marks such as tracked changes and comment anchors
 * included; comment threads stay in their own store). The document is checked against the
 * editor's schema before anything changes. Recorded loads are one undo step; opening
 * (`history: "reset"`) starts a fresh undo history. Undo needs the editor's history extension.
 */
export function createRichTextEditorDocument(editor: Editor): EditorDocument<JSONContent> {
	const commands = () => editor.commands as Partial<Record<'undo' | 'redo', () => boolean>>;
	const can = () => editor.can() as unknown as Partial<Record<'undo' | 'redo', () => boolean>>;
	return defineEditorDocument<JSONContent>({
		kind: 'rich_text',
		get: () => editor.getJSON(),
		load: (document, { history }) => {
			try {
				editor.schema.nodeFromJSON(document).check();
			} catch (error) {
				throw new Error(`A rich text document is ProseMirror JSON ({ "type": "doc", "content": [...] }) as get_rich_text_document returns it: ${error instanceof Error ? error.message : String(error)}`);
			}
			editor.commands.setContent(document as JSONContent, true);
			// A fresh state drops the undo history (and any plugin state tied to the old document).
			if (history === 'reset') editor.view.updateState(EditorState.create({ doc: editor.state.doc, plugins: editor.state.plugins }));
		},
		subscribe: (listener) => {
			editor.on('update', listener);
			return () => {
				editor.off('update', listener);
			};
		},
		history: {
			undo: () => commands().undo?.() ?? false,
			redo: () => commands().redo?.() ?? false,
			getState: () => ({ canUndo: can().undo?.() ?? false, canRedo: can().redo?.() ?? false })
		},
		readOnly: () => (editor.isEditable ? false : 'The document is read-only.')
	});
}
