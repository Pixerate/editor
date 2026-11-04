---
"@pixerate/swift": minor
---

Port the paint editor's dry engine to Swift (`PixeratePaint`, #540). It runs on `PixerateRaster` and passes 16 of 23 paint conformance scenarios pixel-exactly. It includes `PaintEditorController` (canvas, paper, layers, fills, undo / redo), dry brushes with paper grain and pen dynamics, blenders, smudge and the Mixer Brush, recorded strokes, replays, brushed paths and live stroke layers, symmetry, perspective and stencils, tracing and reference images, harmonies, swatches and the mixing pad, light paint from dry brushes, layer styles, saved documents and PNG export, paint proposals, and the brush library. The agent tool providers serve the tools that are ported. `PaintConformanceHost` runs the scenarios.
