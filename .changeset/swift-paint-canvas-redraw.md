---
"@pixerate/swift": patch
---

Swift paint editor UI: `PaintCanvasView` redraws after every change again. Since 0.85.2 a change that was not a stroke (a new canvas, hiding a layer, opening a document, undo) left the old picture on screen until the next touch or view change, because the tiles moved into the `GeometryReader` content, which SwiftUI re-runs only when what it captures changes. It now captures the model's `revision`.
