import { defineEditorDocument, type EditorDocument } from '../persistence/editorDocument.js';
import type { ChartController } from './controller.js';
import type { ChartSpec } from './types.js';

/**
 * The save / load / undo contract for a `ChartController` (kind `chart`, document: the
 * `ChartSpec`). A recorded load (agents) is one undo step and refuses a spec with any
 * problem; opening a file (`history: "reset"`) repairs problems with defaults and reports
 * them in the `LoadReport`.
 */
export function createChartEditorDocument(controller: ChartController): EditorDocument<ChartSpec> {
	return defineEditorDocument<ChartSpec>({
		kind: 'chart',
		get: () => controller.toJSON(),
		load: (document, { history }) => {
			if (history === 'record') {
				const result = controller.replace(document);
				if (!result.ok) throw new Error(result.message);
				return;
			}
			const issues = controller.load(document, { clearHistory: true });
			return { problems: issues.map((i) => ({ section: i.path || 'chart', message: i.message })) };
		},
		subscribe: (listener) => {
			let spec = controller.getSpec();
			return controller.subscribe(() => {
				if (controller.getSpec() === spec) return;
				spec = controller.getSpec();
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
