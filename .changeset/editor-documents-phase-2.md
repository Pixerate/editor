---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Bring the save / load / undo contract to the chart, animation, video, parameters and vector editors.

- `createChartEditorDocument`, `createAnimationEditorDocument`, `createVideoEditorDocument`, `createParametersEditorDocument` and `createVectorEditorDocument` (kinds `chart`, `animation`, `video`, `parameters`, `vector`), for `createEditorAutosave`, `createEditorDocumentStore` and `createDocumentToolProvider`. The vector editor's document tools add `undo_vector` / `redo_vector`.
- `ChartController.replace(spec)` and `ParametersController.replace(snapshot)`: replace the whole chart or parameter set as one undo step, all-or-nothing.
- `defineEditorDocument`: an editor's `load` can return `problems` (parts repaired with defaults); they land in the `LoadReport`.
- React: `useChartEditor`, `useAnimationEditor`, `useVideoEditor`, `useParameters` and `useVectorEditor` return `editorDocument`.
- Svelte: `createChartEditor`, `createAnimationEditor`, `createVideoEditor`, `createParameters` and `createVectorEditor` return `editorDocument`.
