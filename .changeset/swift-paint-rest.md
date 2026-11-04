---
"@pixerate/swift": minor
---

The Swift paint editor writes PSD files (`exportPsd`, `export_psd`), exports time-lapses and high-resolution repaints (`export_time_lapse`, `export_high_res`), paints with the particle and bristle brushes, and takes provider effects through `EffectProvider` (with `FakeEffectProvider`): effect paper, effect layers, effect fills, light baked onto dried paint and effect paint, with every `paint-effects` tool (`createPaintEffectsToolProvider`). Sticker brushes spray the editor's stickers onto sticker layers, and the sticker tools place, pick, change, arrange and remove them (`EditorStickers`, `Sticker`). `PaintEditorView` gets an Export menu (PNG, PNG at 2×, PSD) and particle, bristle and sticker brushes in its brush picker. 21 of the 23 paint scenarios now pass in Swift.
