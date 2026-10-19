---
"@pixerate/editor": minor
---

Paint faster on layers with effects. When only part of a layer changes, `RasterCompositor` now rebuilds its effect maps (shadows, glows, bevels, strokes, satin) only around the change and patches them into the cached maps. Before, it rebuilt them over the whole layer. The result is byte-identical to a full rebuild. On a 2000 × 2000 layer, a 64 px dab now takes about 4 ms per update with a drop shadow (was about 200 ms), and about 9 ms with a drop shadow, a stroke and a bevel (was about 700 ms). When a call passes `dirty` rectangles, tiles that only read the change through an effect's reach keep their pixels instead of being recomposited.

Effects laid out over the layer's bounds (aligned gradients, linked patterns, noise) still rebuild in full. The effect blur now sums in fixed point (to 2⁻³²), so a blurred value no longer depends on where its row starts. New: `patchEffectMaps` updates `EffectMaps` for a shape that changed within given rectangles. `CompositeStats` gains `effectsBuilt` and `effectsPatched`.
