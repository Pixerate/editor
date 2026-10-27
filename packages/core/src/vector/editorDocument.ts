import { defineEditorDocument, type EditorDocument } from '../persistence/editorDocument.js';
import type { VectorEditorController } from './controller.js';
import type { VectorDocument } from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function checkVectorDocument(document: unknown): asserts document is VectorDocument {
	const hint = 'A vector document is { width, height, nodes: [...] } as get_vector_document returns it.';
	if (!isRecord(document)) throw new Error(hint);
	for (const key of ['width', 'height'] as const) {
		const v = document[key];
		if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`${key} must be a positive number. ${hint}`);
	}
	if (!Array.isArray(document.nodes)) throw new Error(`nodes must be an array. ${hint}`);
	document.nodes.forEach((node, i) => {
		if (!isRecord(node) || typeof node.id !== 'string' || typeof node.type !== 'string') throw new Error(`nodes[${i}] needs a string id and type. ${hint}`);
	});
}

/**
 * The save / load / undo contract for a `VectorEditorController` (kind `vector`, document: the
 * `VectorDocument` from `toJSON`). Recorded loads are one undo step. The tool, selection and
 * view are not part of the document.
 */
export function createVectorEditorDocument(controller: VectorEditorController): EditorDocument<VectorDocument> {
	return defineEditorDocument<VectorDocument>({
		kind: 'vector',
		get: () => controller.toJSON(),
		load: (document, { history }) => {
			checkVectorDocument(document);
			controller.setDocument(document, history === 'reset' ? { history: false } : { label: 'Load document' });
		},
		subscribe: (listener) => {
			let doc = controller.getDocument();
			return controller.subscribe(() => {
				if (controller.getDocument() === doc) return;
				doc = controller.getDocument();
				listener();
			});
		},
		history: {
			undo: () => controller.undo(),
			redo: () => controller.redo(),
			getState: () => controller.history.getState()
		}
	});
}
