---
"@pixerate/editor": minor
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
"@pixerate/swift": minor
---

Stroke layers take erasers and light paint (#720, part 1). An eraser stroke is recorded with the layer's other strokes and redrawn with them, so editing, moving or removing the strokes under it (or the eraser itself) redraws exactly, and a partly erased dual-colour pen or highlighter stroke follows the colour scheme with only what is left. Light (the highlighter's glow, neon and other `light.amount` brushes) is redrawn with the strokes through each stroke's grey light twin, so it moves, dims and disappears with them; a stroke layer's spill takes the colours the scheme shows. Region redraws are no longer clipped to the canvas, so paint and light a stroke laid past the canvas edge go when the stroke does. Wet paint is still refused on stroke layers. `evolutionStrokeRefusal` refuses breeding eraser strokes (the evolution panels use it). The Swift paint editor does the same.
