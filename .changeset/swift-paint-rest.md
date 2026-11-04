---
"@pixerate/swift": minor
---

The Swift paint editor writes PSD files (`exportPsd`, `export_psd`), exports time-lapses and high-resolution repaints (`export_time_lapse`, `export_high_res`), paints with the particle and bristle brushes, and takes provider effects through `EffectProvider` (with `FakeEffectProvider`): effect paper, effect layers, effect fills, light baked onto dried paint and effect paint, with every `paint-effects` tool (`createPaintEffectsToolProvider`). `PaintEditorView` gets an Export menu (PNG, PNG at 2×, PSD) and particle and bristle brushes in its brush picker. 20 of the 23 paint scenarios now pass in Swift.
