---
"@pixerate/editor": patch
"@pixerate/editor-react": patch
---

Animation editor: the React stage now redraws when shot layer and transition pictures finish rendering. Before, they appeared only after the scene or playhead changed. `AnimationEditorState.layerPictures` goes up each time pictures come in.
