# @pixerate/conformance

## 0.1.5

### Patch Changes

- 518f091: Opening a paint or image editor document with a malformed annotation layer no longer refuses the whole document with a bare `TypeError` (#848). The annotation migration checks every field it reads (a pen's `points`, a text's `text`, geometry, `strokeWidth`, `opacity`, `rotation`, `fontSize`, `fontFamily`, `fontWeight`), reports `Layer "X": the annotation could not be read (points must be an array of { x, y } points.)` and leaves only that layer out. Wrong types that used to load as `NaN` geometry are reported the same way, and an arrow without `strokeWidth` gets the 12 px arrowhead of a 1 px canvas line instead of `NaN`. The Swift paint editor reports the same problems, and the `document-load-vector-layers` scenario covers them.

## 0.1.4

### Patch Changes

- 9209cc8: The image editor's `parseCssColor` no longer reads `Object.prototype` names such as `constructor` and `__proto__` as colours; shape and type layers using them are refused with a colour problem (#849).

## 0.1.3

### Patch Changes

- f1b7882: Vector masks stored as SVG path data now save → reopen → save unchanged: anchor lists keep their anchor `type` (`corner`, `smooth`, `symmetric`), and the closing anchor merged from SVG path data writes `in` before `out`, like every other anchor. The Swift paint editor reads and writes them the same way, and `document-load-vector-layers` now reloads its SVG-path masks.

## 0.1.2

### Patch Changes

- f417bf9: Paint documents no longer alias tiles far off the canvas (#852). Surfaces hold −8388608..8388607 px on each axis (the range a tile key round-trips): `tilesInRect` stops at it, so reads past it see the default, writes drop pixels past it and no loop runs for ever past 2^53 px. A saved channel (light, fluorescent, thermochromic, ferrofluid, thick paint), culture occupancy, layer asset or deep samples that reach past it are refused with a load problem ("it lies outside the surface range, …") instead of being saved at another tile or as a blank PNG. New exports: `MIN_TILE`, `MAX_TILE`, `MIN_SURFACE_PIXEL`, `MAX_SURFACE_PIXEL`, `SURFACE_RANGE_MESSAGE`, `tileInRange`, `checkSurfaceRange` and `surfaceFromSavedPixels`. The Swift paint editor matches, and the `document-load-edge-cases` scenario records the refusals and channels on the range's first and last tiles.

## 0.1.1

### Patch Changes

- 55882c8: Swift paint editor: light / dark (dual-colour) paint follows the viewer's colour scheme, as in the TS core (#718, #720).

  - Strokes record a light / dark pair: `PaintStrokeInit.dualColor`, `setColor(dual:)`, the `set_color` tool's `dualColor`, a brush's light / dark default, and `updateStroke(dualColor:)`. A plain colour drops the pair.
  - Stroke layers keep each pair's light side in the document and show the `setColorScheme` side in the view (display, image and PSD exports, the stroke being drawn); the document, history and saved file don't change with the scheme.
  - Pixel layers, wet paint included, show the scheme's side through a replay of the stroke log into a view-only editor (`SchemeReplay`): built in the background by the host's clock (`runSchemeReplay`; `PaintEditorModel.runSchemeReplayClock` in the editor view), kept current from new strokes and events, a live stroke followed point by point, undo and redo rolled back to checkpoints. Layers holding pixels the log doesn't have are marked (`PaintDocumentState.unlogged`, saved as the `unlogged` extension with documents that hold dual-colour strokes) and keep their colours.
  - `colorSchemeView()`, `colorSchemeViewReady()` and the `get_color_scheme_view` agent tool (with `wait`); the layers panel marks kept (◐) and updating (⟳) layers; `PaintEditorView` follows the system appearance (`followsColorScheme`), and the Swift demo has a scheme switch.
  - A paint colour that came from a light / dark brush default now follows `setColorScheme` even when the colour is locked, as in the TS core.
  - `replayItem`, `advanceReplayClock` and `replayStrokeInit` are split out of `replayPainting`; a wet stroke's points applied at one clock are pushed together, as in TS.
  - Conformance: the `color-scheme-replay` scenario's Swift skip is removed; all 69 paint scenarios pass in Swift.

## 0.1.0

### Minor Changes

- 2912c39: The Swift editors can save, list and open documents and clean up their stored images, as the TS core does (follow-up to #742). `PixerateCore` adds named documents (`createEditorDocumentStore`, `SavedEditorDocument`), asset garbage collection (`collectEditorAssetGarbage`, `tryCollectEditorAssetGarbage`, `collectRetiredEditorAssets`, `withEditorAssets`, with write leases so a save in flight keeps its assets), and the store tools of `createDocumentToolProvider`: `save_<kind>_document`, `list_saved_<kind>_documents`, `open_saved_<kind>_document` and, for documents with assets on storage that lists its keys, `find_unreferenced_<kind>_assets` / `delete_unreferenced_<kind>_assets`, with the TS results and messages. `EditorStorage` gains `kind`, `remove` and key listing (`listsKeys`, `keys(_:)`); `MemoryEditorStorage` keeps insertion order like the TS memory storage, and `DirectoryEditorStorage` stores one file per key in a folder.

  Paint registers them with the host's store: `createPaintDocumentToolProvider(_:store:)` and `PaintEditorModel(documentStore:)`, which the Swift demo passes a folder in Application Support, as the TS demo's paint tab passes its IndexedDB store.

  The paint contract now lists the store tools (its conformance host has a memory document store with a fixed clock), and the new `document-store` paint scenario calls every one of them.

## 0.0.5

### Patch Changes

- 2b1bb28: Swift paint documents now open the last three edge cases the way the TS core does (#742). Saved channels far off the canvas are no longer refused: their tiles get the keys TS gives them, including keys that round past 2^53 (`jsTileKey`; `tileKey` switches to it outside ±2^30 tiles). Deep 16- and 32-bit samples with a fractional, text, boolean or array `width` or `height` are written where JavaScript arithmetic puts them (`writeDeepRegionUnchecked`), and an array `deep` is reported as TS reports it. A saved wet event with a non-integer `at` (`1.5`, `"0.25"`, `true`) replays at that value among the strokes instead of at 0 (`WetEvent.replayAt`).

  The new `document-load-edge-cases` paint scenario checks all three.

- 2b1bb28: Swift paint documents read the image editor's vector parts as the TS core does (#742). Vector masks on pixel layers and groups are read through a port of `readShapeComponents` (live rectangles, ellipses, polygons, stars and lines, anchor lists with handles and live corners, SVG path data, hybrid edges), kept on `RasterLayer.vectorMask` and saved back; a damaged one is left out with the TS core's message. Shape and type layers are checked with the image editor's validation (components, live shapes, paints, gradients, patterns, strokes, text and paragraph styles, PSD blocks, stored pixels) and report its problem before the paint editor leaves them out, and annotation layers are reported as the shape, type or annotation layers the image editor migrates them to. `PixerateRaster` adds `JS.tan` (V8's `Math.tan`, bit-exact), and `PixeratePaint` now depends on `PixerateGeometry`.

  The new `document-load-vector-layers` paint scenario checks all of it.

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
