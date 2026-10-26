---
"@pixerate/editor": minor
---

Paint editor: grow the canvas on any side without losing paint. `PaintEditorController.extendCanvas({ left, top, right, bottom })` adds pixels on each side and moves everything by (left, top) together: layer offsets (masks and relief follow), sticker positions, the paper grain (new `PaperSettings.offset`), the effect paper, guides, stencils, the tracing image, and the recorded strokes and wet / paint events, so replays still match. Wet paint dries first (per-layer wet settings are kept). It is one undo step that also restores the guides. It returns the new canvas, its rect in the previous coordinates, and the new `document.origin`. The origin is saved by `toJSON` / `loadJSON` and lets a host keep its own offset in step, even through undo. New agent tool `extend_canvas`; `get_canvas_info` now returns `origin`. Fix: undoing or redoing across a canvas size change no longer leaves a wet simulation at the wrong size.
