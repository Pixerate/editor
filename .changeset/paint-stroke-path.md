---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Brush a path in the paint editor (#516): the `stroke_path` agent tool and `PaintEditorController.strokePath` brush SVG path data with the active brush (or `brushId` / `brush`) as if drawn by hand along it. Each subpath becomes one recorded stroke, sampled every `spacing` px, with an optional `pressure` profile spread along it (a taper). The whole path is one undo step. `samplePath` and `PATH_STROKE_TAPERS` are exported. React and Svelte add `<PathStrokePanel>`, shown in `<PaintEditor>`'s Layers tab.
