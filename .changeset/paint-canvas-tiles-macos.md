---
"@pixerate/swift": patch
---

Fix `PaintCanvasView` on macOS drawing tile rows in reverse order (a placed picture or long strokes showed as shifted 256 px bands): `PaintTilesLayerView` is now flipped, so AppKit keeps its layer geometry y-down.
