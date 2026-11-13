---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
"@pixerate/conformance": patch
---

Light / dark (dual-colour) strokes on pixel layers, wet paint included, now follow the viewer's colour scheme (#720 part 2). The view replays the stroke log with each pair in the scheme's side into a view-only editor, so wet paint mixes the dark sides as the simulation mixed the light ones. It builds lazily in the background (the layer shows its own pixels until then), follows new strokes, events and live strokes without a full replay, and rolls back to checkpoints on undo and redo. A layer holding pixels the stroke log doesn't have (merged, moved, transformed or imported pixels) keeps its colours: `PaintDocumentState.unlogged` records why, saved with documents that hold dual-colour strokes. `setColorScheme` stays view-only: the document, history and saved file never change. New `colorSchemeView()`, `colorSchemeViewReady()`, `PaintEditorState.colorSchemeView`, the `get_color_scheme_view` agent tool and kept / updating marks in the React and Svelte layers panels. Replays push a wet stroke's points applied at one clock together (same pixels, faster).
