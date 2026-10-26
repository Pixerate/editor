import { defineEditorDocument, type EditorDocument } from '../persistence/editorDocument.js';
import type { VideoEditorController } from './controller.js';
import type { VideoProject } from './types.js';

/**
 * The save / load / undo contract for a `VideoEditorController` (kind `video`, document: the
 * `VideoProject`; media stays where its asset URLs point). Recorded loads are one undo step;
 * read-only editors refuse them. The playhead and playback are not part of the document.
 */
export function createVideoEditorDocument(controller: VideoEditorController): EditorDocument<VideoProject> {
	return defineEditorDocument<VideoProject>({
		kind: 'video',
		get: () => controller.getProject(),
		load: (document, { history }) => {
			const result = controller.load(document as VideoProject, { clearHistory: history === 'reset' });
			if (!result.ok) throw new Error(result.error);
		},
		subscribe: (listener) => {
			let project = controller.getProject();
			return controller.subscribe(() => {
				if (controller.getProject() === project) return;
				project = controller.getProject();
				listener();
			});
		},
		history: {
			undo: () => controller.undo(),
			redo: () => controller.redo(),
			getState: () => controller.history.getState()
		},
		readOnly: () => (controller.getState().readOnly ? 'The video project is read-only.' : false)
	});
}
