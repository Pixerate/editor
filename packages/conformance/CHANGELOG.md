# @pixerate/conformance

## 0.0.4

### Patch Changes

- 06ed24f: Swift paint documents read the image editor's vector parts as the TS core does (#742). Vector masks on pixel layers and groups are read through a port of `readShapeComponents` (live rectangles, ellipses, polygons, stars and lines, anchor lists with handles and live corners, SVG path data, hybrid edges), kept on `RasterLayer.vectorMask` and saved back; a damaged one is left out with the TS core's message. Shape and type layers are checked with the image editor's validation (components, live shapes, paints, gradients, patterns, strokes, text and paragraph styles, PSD blocks, stored pixels) and report its problem before the paint editor leaves them out, and annotation layers are reported as the shape, type or annotation layers the image editor migrates them to. `PixerateRaster` adds `JS.tan` (V8's `Math.tan`, bit-exact), and `PixeratePaint` now depends on `PixerateGeometry`.

  The new `document-load-vector-layers` paint scenario checks all of it.

## 0.0.3

### Patch Changes

- dcfa8fc: Swift paint documents with external assets and their agent tools (#742). `PixeratePaint` adds external asset stores (`PaintAssetStore`, `PaintEditorController.toJSONExternal` and `loadJSONAsync`, with the TS core's asset ids, references and problems), `createPaintEditorDocument` (the `pixerate.editor-document` contract of kind `paint`: images as content-addressed asset references, revisions from the controller's new `documentRevision`, opening clears the history, read-only mid-stroke), `editorDocument(assets:name:)` / `openEditorDocument(_:assets:)` so an envelope reopens in Swift, and `createPaintDocumentToolProvider` with `get_paint_document` / `load_paint_document` (also registered by `PaintEditorModel`). `PixerateCore` adds `EditorAssetRegistry`, `externalizeAssets`, `internalizeAssets`, `collectAssetRefs`, `persistEditorAssets` / `preloadEditorAssets` over an `EditorStorage` (`MemoryEditorStorage`), `EditorDocumentSpec` `subscribe` and `assets`, `EditorDocument.destroy()`, and `createDocumentToolProvider` (`get_<kind>_document`, `load_<kind>_document`, `undo_<kind>`, `redo_<kind>`; `EditorDocumentHistory` now reports `documentHistoryState()`).

  The paint contracts list the `paint-document` provider (`get_paint_document`, `load_paint_document`), `createPaintConformanceHost` registers it, and the new `document-tools` paint scenario calls both tools.

## 0.0.2

### Patch Changes

- eda3c4b: Light / dark (dual-colour) strokes on pixel layers, wet paint included, now follow the viewer's colour scheme (#720 part 2). The view replays the stroke log with each pair in the scheme's side into a view-only editor, so wet paint mixes the dark sides as the simulation mixed the light ones. It builds lazily in the background (the layer shows its own pixels until then), follows new strokes, events and live strokes without a full replay, and rolls back to checkpoints on undo and redo. A layer holding pixels the stroke log doesn't have (merged, moved, transformed or imported pixels) keeps its colours: `PaintDocumentState.unlogged` records why, saved with documents that hold dual-colour strokes. `setColorScheme` stays view-only: the document, history and saved file never change. New `colorSchemeView()`, `colorSchemeViewReady()`, `PaintEditorState.colorSchemeView`, the `get_color_scheme_view` agent tool and kept / updating marks in the React and Svelte layers panels. Replays push a wet stroke's points applied at one clock together (same pixels, faster).

## 0.0.1

### Patch Changes

- 434fb80: Swift chart port gaps (#719). `PixerateCore.readZip` is now a line-by-line port of `import/zip.ts`: the TS error messages, the size limit counted on the bytes actually read (a deck with a large video and one chart opens), the first of two same-named entries wins, directory names get the unsafe-path check, `unsafePaths` is `.error` / `.skip`, encrypted entries fail only when read, and ZIP64 entries without an extra field keep their 32-bit sizes. `ZipEntry` is a struct with the TS fields, and `ZipArchive` has `get`, `read(entry)` and `extractedSize`. The brush pack reader moved to `PixeratePaint` as `readBrushZip` (`BrushZipEntry`, `BrushZipError`), matching `brushes/import/zip.ts`. House-style `chart.json` profiles are validated against the chart profile schema and each check's options schema, so a bad profile is left out with the TS issue message (`ChartStyleResolver(skill:layer:chartJson:)`). Smaller fixes: code-unit string handling in the Mermaid, Sankey and treemap readers and the Office reader; NFC and NFD names kept apart (`JSKey`); `NaN` and `Infinity` written as JS writes them in SVG, OOXML and messages (`JSONValue.jsString`); `chartRasterSize` no longer traps on non-finite sizes; XML character references past U+10FFFF and `&toString;` behave as in the TS fallback parser; bar race playback keeps the end it started with; setup and tool base64 accepted as `atob` accepts it; and the PNG and SwiftUI chart renderers apply a mark's opacity to fill and stroke as one group and read `#rrggbbaa` alpha. `@pixerate/editor` exports `chartFallbackDomParser`, the XML parser its chart contracts use without a `DOMParser`; new chart conformance scenarios cover invalid style profiles and base64 setup files.
