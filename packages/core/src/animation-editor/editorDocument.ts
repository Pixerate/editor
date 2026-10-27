import { defineEditorDocument, type EditorDocument } from '../persistence/editorDocument.js';
import type { AnimationEditorController } from './controller.js';
import type { MotionScene } from './types.js';

/**
 * The save / load / undo contract for an `AnimationEditorController` (kind `animation`,
 * document: the `MotionScene`). Recorded loads are one undo step; read-only editors refuse
 * them. The playhead and playback are not part of the document.
 */
export function createAnimationEditorDocument(controller: AnimationEditorController): EditorDocument<MotionScene> {
	return defineEditorDocument<MotionScene>({
		kind: 'animation',
		get: () => controller.getScene(),
		load: (document, { history }) => {
			const result = controller.load(document as MotionScene, { clearHistory: history === 'reset' });
			if (!result.ok) throw new Error(result.error);
		},
		subscribe: (listener) => {
			let scene = controller.getScene();
			return controller.subscribe(() => {
				if (controller.getScene() === scene) return;
				scene = controller.getScene();
				listener();
			});
		},
		history: {
			undo: () => controller.undo(),
			redo: () => controller.redo(),
			getState: () => controller.history.getState()
		},
		readOnly: () => (controller.getState().readOnly ? 'The animation is read-only.' : false)
	});
}
