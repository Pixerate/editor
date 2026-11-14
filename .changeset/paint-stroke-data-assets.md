---
'@pixerate/editor': minor
'@pixerate/swift': minor
---

Paint documents saved with an asset store keep their stroke data in the store. `toJSONExternal(store)` now writes the stroke log, the wet and paint events, and each stroke layer's strokes as content-addressed JSON runs (`{ chunks: [id] }`, blobs of type `application/json` with `width` / `height` 0, ids `json-<hash>-<length>`), cut so a save after one more stroke stores one new run. The document stays a few kilobytes however many strokes it holds (100 long pen strokes: 2.6 MB inline, 3 KB external). `loadJSONAsync` reads them back, reports a run it can't read as a load problem, and remembers the runs it read, so the next save to the same store uploads only what changed. The inline `toJSON` format is unchanged, and external documents with inline strokes still load.

New `strokes: 'replay'` option for `toJSON`, `toJSONExternal` and `createPaintEditorDocument`: it saves the stroke log only when the colour-scheme replay needs it (light / dark paint on a pixel layer), with strokes kept on stroke layers written as references (`{ liveStroke, layerId }`) instead of copies. `strokes: true` / `false` are unchanged. Swift: the same stroke data runs and ids in `toJSONExternal` / `loadJSONAsync`, and `StrokeLogOption` (`toJSON(strokeLog:)`, `toJSONExternal(_:strokeLog:)`, `createPaintEditorDocument(strokeLog:)`).
