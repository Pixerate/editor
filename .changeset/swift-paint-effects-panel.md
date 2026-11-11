---
"@pixerate/swift": minor
---

Swift paint editor: an Effects tab (`PaintProviderEffectsPanel`) for effect paper, effect layers, fills, light and effect paint, shown while an effects provider is registered; live effect paint plays in `PaintEditorView` (`playEffects`, `showEffectTime`); `export_image` and `export_psd` take `time` to export at a moment of live effects (`withEffectTime`, `renderAnimationFrame`). A new `live-effect-paint` conformance scenario covers sticker effect paint, live strokes and the timed exports.
