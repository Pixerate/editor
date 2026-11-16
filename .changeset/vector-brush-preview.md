---
"@pixerate/editor": minor
---

New `renderVectorBrushPreview` (`@pixerate/editor/vector`): the vector host's `preview_brush` and brush editor renderer, drawing every brush `VECTOR_PROFILE` admits. Dry brushes look as `renderCanvasBrushPreview` draws them; wet paint (watercolour, gouache, wet oils) runs the brushstroke's wet simulation and shows it settled, in slices that yield to the event loop; the Mixer Brush, smudge and blender act on a backdrop of two colour bands when they move paint. Before, the vector host used `renderCanvasBrushPreview`, which refused wet and backdrop media that vector brushstrokes paint.
