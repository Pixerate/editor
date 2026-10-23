import { defineEditorDocument, type EditorDocument } from '../persistence/editorDocument.js';
import type { DiagramController } from './controller.js';

/** A diagram as it is saved: its Mermaid source (layout rides in the `%% @pixerate` comment). */
export interface DiagramEditorDocument {
	source: string;
}

/**
 * The save / load / undo contract for a `DiagramController` (kind `diagram`), for
 * `createEditorAutosave`, `createDocumentToolProvider` and the React / Svelte wrappers.
 * Recorded loads are one undo step; read-only controllers refuse them.
 */
export function createDiagramEditorDocument(controller: DiagramController): EditorDocument<DiagramEditorDocument> {
	return defineEditorDocument<DiagramEditorDocument>({
		kind: 'diagram',
		get: () => ({ source: controller.getSource() }),
		load: (document, { history }) => {
			const source = (document as Partial<DiagramEditorDocument>).source;
			if (typeof source !== 'string') throw new Error('A diagram document is { source: string } (Mermaid text).');
			const result = controller.load(source, { clearHistory: history === 'reset' });
			if (!result.ok) throw new Error(result.message);
		},
		subscribe: (listener) => {
			let source = controller.getSource();
			return controller.subscribe((state) => {
				if (state.source === source) return;
				source = state.source;
				listener();
			});
		},
		history: {
			undo: () => controller.undo(),
			redo: () => controller.redo(),
			getState: () => controller.history.getState()
		},
		readOnly: () => (controller.getState().readOnly ? 'The diagram is read-only.' : false)
	});
}
