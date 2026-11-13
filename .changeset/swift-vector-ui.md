---
"@pixerate/swift": minor
---

Add `PixerateVectorUI`, the vector editor's SwiftUI views for macOS 14 and iOS 17 (#625): `VectorEditorView` with a CoreGraphics canvas (`VectorCanvasView`, `VectorSceneDrawer`) that takes mouse, trackpad, Apple Pencil, touch and keyboard input (`VectorCanvasGesture`: select, move, resize, marquee, Direct Selection, the shape and Frame tools, Pen, Pencil, Scissors, Knife, Eraser, Shape Builder, Paint Bucket, Blend, Type and the distortion brush, each drag one undo step), a toolbar, layers and appearance panels rendered from the generated vector UI tables (`VectorUITables`, `VectorContracts.uiTables()`), `CoreTextVectorShaper` for real fonts, and `VectorEditorModel`, which owns the `ToolRegistry` so agents and the user edit the same document (servable over the MCP bridge). `PixerateVector` gains `vectorLayerRows` (the layers panel's rows). The Swift demo has a Vector tab with an agent panel.
