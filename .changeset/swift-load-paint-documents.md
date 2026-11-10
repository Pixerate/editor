---
"@pixerate/swift": minor
---

Swift paint editor: open saved paintings with `PaintEditorController.loadJSON`, matching the TypeScript loader. It reads layers and their assets, strokes, wet and paint events, wet settings, thick paint, light, UV and thermochromic ink, heat, ferrofluid and magnets, cultures, age, sticker layers (with animated frames), stroke layers, image sources, effect layers and effect paper, guides, swatches and mixing pads. It returns what could not be read in the TypeScript core's words, and keeps fields it does not know so they are written back. `PaintConformanceHost` now supports save → load steps (#739).
