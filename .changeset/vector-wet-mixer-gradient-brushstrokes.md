---
"@pixerate/editor": minor
"@pixerate/swift": patch
---

Vector brushstrokes paint with wet, mixer, smudge and blender brushes and with gradient paint (#519). Wet paint (watercolour, gouache, wet oils) runs the wet simulation in the stroke's own area for a fixed number of steps and dries, so the result is the same on every render; the scene shows the paint as laid while it settles in the background (`onVectorBrushstrokesSettled`, `settleVectorBrushstrokes`), and SVG and PDF exports wait for it. The Mixer Brush, smudge and blender act on a CPU backdrop of the fills, strokes and brushstrokes beneath the stroke (`rasterizeVectorBackdrop`), re-rendered when anything beneath changes. Gradient paint is sampled dab by dab along the path: the new `brush.paint` on a brushstroke (`vector.addBrushstroke` / `vector.setBrushstroke` `paint`; `velocity` and `time` mappings are refused), a gradient layer paint laid along, across or within the stroke, or a brush's own gradient. `VECTOR_PROFILE` now admits wet surfaces, the Mixer Brush reservoir and the blender and smudge tools.


Swift: `VECTOR_PROFILE` matches (wet surfaces, the reservoir, blender and smudge tools).
