---
"@pixerate/swift": patch
---

Public initializers for option structs hosts build outside the module: `ReplayOptions` (so `replayStrokes` is callable without `@testable import`), `BrushHostProfile`, `MixerSettings`, `ExchangeRates`, `BlenderSettings`, `SmudgeSettings`, `WetPaperInput`, `PaintDabParams`, `VectorWiggleParams` and `VectorArtContext` (#747).
