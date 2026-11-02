---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Paint editor: live stroke layers. A stroke layer (`addLayer({ type: 'strokes' })`, `convertToLiveStrokes`) keeps its strokes as data and draws its pixels from them, so a stroke's brush, settings, colour, paint, seed and points can be changed after painting (`updateStroke`, `editStrokePoints`), and strokes can be reordered, deleted or picked by point (`reorderStroke`, `removeStrokes`, `liveStrokeAt`). Edits redraw exactly, only where they change, and are saved, undone and replayed. `rasterizeLiveStrokes` turns the layer into plain pixels. Dab, particle, bristle and Mixer Brush strokes that pick up no paint are allowed; other brushes, fills and effects are refused with the way out. New agent tools: `stroke_at`, `update_stroke`, `edit_stroke_points`, `reorder_stroke`, `remove_strokes`, `convert_to_stroke_layer` and `rasterize_stroke_layer`; `add_layer` takes `type: "strokes"` and `list_strokes` takes `live` and `layerId`. React and Svelte add `StrokePanel`, a New stroke layer button and a Select stroke tool (V) that picks and drags strokes. Rotating strokes now keeps their brush size exact.
