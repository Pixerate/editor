---
"@pixerate/swift": minor
---

Save without blocking the main thread: `PaintEditorController.saveSnapshot(strokeLog:thumbnailMaxSide:)` reads the document where the controller lives and leaves its PNGs to encode. `PaintSaveSnapshot.document()` then returns exactly what `toJSON(strokeLog:)` would have, and `thumbnailPng()` returns the same bytes as `exportPng(scale:)`. Both can run on any thread, and the PNGs encode in parallel. `PngDeferral` (PixerateRaster) is the mechanism underneath: inside `PngDeferral.run`, `pngDataUrl` records the pixels and returns a placeholder. The layer PNG cache and sticker thumbnails never keep a placeholder.
