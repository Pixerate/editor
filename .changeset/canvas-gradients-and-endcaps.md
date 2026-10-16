---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Support linear and radial gradients for canvas shapes and freehand drawing, and fix endcaps preservation on stroke completion.

- Added gradient data models, angle-to-coordinate calculations, presets (`CANVAS_GRADIENT_PRESETS`), and SVG `<defs>` generation in core.
- Updated `ShapePaint` and shape render pipelines to support gradient fills and strokes across React (`ShapeNode`) and Svelte (`ShapeNode.svelte`).
- Added live gradient rendering preview to `CanvasDrawLayer` in both React and Svelte.
- Fixed an issue where freehand pen/highlighter linecaps and joins were stripped upon finishing a stroke or creating single-point dots.
