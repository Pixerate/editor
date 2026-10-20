---
"@pixerate/editor": minor
---

Composite at 16 and 32 bits: `DeepCompositor` in `@pixerate/editor/raster` runs the layer model (blend modes, masks, clipping, groups, filter layers) in float over the layers' deep samples, in sRGB at 16 bits and linear light at 32. The image editor uses it for merges, the PSD merged image and the new `compositeDeepPixels()`, and runs adjustment layers in float there (`applyAdjustmentLayersFloat`; Levels without 8-bit quantisation).
