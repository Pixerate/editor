---
"@pixerate/swift": minor
---

Add `PixeratePaintUI`, the native paint editor UI for macOS 14 and iOS 17. It has:

- `PaintEditorView`, which puts the toolbar, the brush column, the canvas and the colour, paper, layers and layer-style panels together;
- `PaintCanvasView`: CoreGraphics drawing with zoom, pan, rotation and mirroring, tile-by-tile redraw, and guide overlays;
- input from the mouse, trackpad and tablet on macOS, and from touch and Apple Pencil on iOS (pressure, tilt, roll, coalesced and predicted touches, palm rejection);
- panels rendered from the generated contract tables, and keyboard shortcuts from the contract commands;
- `PaintEditorModel`, an observable view model. It owns the editor's agent `ToolRegistry`, so changes made by agents and by the user both show up.

`PaintEditorController` gains change notifications (`subscribe`), live strokes from pointer input (`beginStroke`, `PaintLiveStroke`), `compositeTiles`, `swapColors`, `brushes` / `canPaint` and `liveStrokeArea`. `PixeratePaint` also adds view and pen-input helpers: `screenToDocument`, `documentToScreen`, `fitZoom`, `pointerToPenPoint`, `isPalmTouch`, and the guide-line functions.

New demo: a macOS app in `apps/swift-demo` (`swift run --package-path apps/swift-demo`) with an agent panel that connects the editor to `pixerate-mcp-bridge`.
