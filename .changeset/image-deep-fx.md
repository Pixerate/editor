---
"@pixerate/editor": minor
---

Image editor at 16 and 32 bits: layer filters (develop, blur) and layer effects now composite in float in merges, `compositeDeepPixels` and the PSD merged image, instead of being drawn at 8 bits. `compositeLayerEffects` accepts float buffers, and new float filters are `applyProcess2Float`, `applyBoxBlurFloat` and `runLayerFiltersFloat`. Groups with effects and legacy-process develop filters still render at 8 bits.
