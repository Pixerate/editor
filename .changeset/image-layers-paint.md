---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Image editor painting: a brush engine ported from photocraft, in the new shared `@pixerate/editor/paint` subpath (round computed tip with size, hardness, angle, roundness and spacing; opacity versus flow build-up; smoothing; pen pressure to size and opacity), Brush and Eraser strokes on pixel layers and layer masks (black hides, white reveals) limited by the selection and by transparency locks, Edit › Fill and Clear, and the Move tool. `beginStroke` returns a live stroke session (one undo step per stroke); `paintStroke`, `fillPixels`, `clearPixels`, `setPaintOptions`, `swapPaintColors` and `resetPaintColors` drive it, and `PaintGesture` / `handlePaintShortcut` give hosts the pointer handling and Photoshop shortcuts (B, E, V, [ ], Shift+[ ], 0–9, D, X). New agent tools `paint_stroke`, `fill_pixels` and `clear_pixels`. React and Svelte get `<BrushOptionsBar>` and a Paint tab in `<ImageEditor>` with pointer capture, coalesced events and a brush cursor.
