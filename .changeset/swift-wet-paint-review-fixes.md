---
"@pixerate/swift": patch
---

Fix regressions from the wet painting speed-up:

- Capped wet shading goes back to the longest-unshaded tile first. Per-slot stamps were compared across tiles, so on canvases with more than 24 stale tiles the older tiles stopped updating.
- Tiles freed by drying or baking are now in the dirty rectangles, so the canvas no longer keeps their old pixels.
- `tick` keeps the steps it could not run, as the TypeScript core does, instead of dropping the backlog.
- `PaintEditorModel.brushes` follows library edits that keep a brush's id.
- `finishTile` no longer rebinds array storage to detect uniform tiles.
