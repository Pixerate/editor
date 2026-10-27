import { defineEditorDocument, type EditorDocument } from '../persistence/editorDocument.js';
import type { ParametersController, ParametersSnapshot } from './controller.js';

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The save / load / undo contract for a `ParametersController` (kind `parameters`, document:
 * `{ values, presets }` from `toJSON`). A recorded load (agents) is one undo step and refuses
 * unknown ids or invalid values; opening a file (`history: "reset"`) uses defaults for invalid
 * values and reports them in the `LoadReport`.
 */
export function createParametersEditorDocument(controller: ParametersController): EditorDocument<ParametersSnapshot> {
	return defineEditorDocument<ParametersSnapshot>({
		kind: 'parameters',
		get: () => controller.toJSON(),
		load: (document, { history }) => {
			if (!isRecord(document) || !isRecord(document.values)) throw new Error('A parameters document is { values: { <field id>: value }, presets?: [...] }.');
			if (document.presets !== undefined && !Array.isArray(document.presets)) throw new Error('presets must be an array of presets.');
			const snapshot = document as unknown as ParametersSnapshot;
			if (history === 'record') {
				const result = controller.replace(snapshot);
				if (!result.ok) throw new Error(result.message);
				return;
			}
			controller.load(snapshot, { clearHistory: true });
			return { problems: Object.entries(controller.getState().errors).map(([section, message]) => ({ section, message })) };
		},
		subscribe: (listener) => {
			let saved = JSON.stringify(controller.toJSON());
			return controller.subscribe(() => {
				const next = JSON.stringify(controller.toJSON());
				if (next === saved) return;
				saved = next;
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
