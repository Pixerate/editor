---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
"@pixerate/swift": minor
---

Strokes on pixel layers stay selectable and editable (#902). A pixel layer keeps the strokes painted on it since its last flattening point (a stroke or change that can't be redrawn exactly: wet, thick, sticker, smudge, blender, pick-up, scraper or antimatter paint, a fill, clear, filter, transform, merge or import) over the pixels under them, so `updateStroke`, `editStrokePoints`, `reorderStroke`, `removeStrokes`, `liveStrokeAt`, the Select stroke tool and `StrokePanel` work on them as on a stroke layer. Edits change the stroke log itself, so replays, high-resolution exports and the other colour scheme show them. New `editableStrokes`, `allEditableStrokes`, `editableStroke` and `isStrokeEditable`; `list_strokes` reports `live` for them and `notEditable` (why) for baked strokes. Documents save each layer's editable strokes (`strokeTails`: the ids and the pixels under them) when they save the stroke log.
