# @pixerate/swift

## 0.65.2

### Patch Changes

- 992264e: Strokes on a pixel layer offset more than about 8.4 million px from the canvas no longer alias onto another tile of that layer (#852). Paint code that keys tiles straight from pixel coordinates now stops at the surface tile range, as `tilesInRect` does: reads past it see the default and writes drop the pixel. That covers brush coverage, the paint exchange used by the mixer, blender, smudge and sponge, clone and heal sources, culture growth, thick paint, antimatter, the scraper, procedural fills, backlight, the viewport's mip lookups and mesh warps. The wet engine already worked in canvas space. New exports: `tileKeyIn(tx, ty)`, which returns `tileKey` for a tile in range and otherwise `NO_TILE_KEY` (−1, a key no tile has). The Swift paint editor matches.

## 0.65.1

### Patch Changes

- f417bf9: Paint documents no longer alias tiles far off the canvas (#852). Surfaces hold −8388608..8388607 px on each axis (the range a tile key round-trips): `tilesInRect` stops at it, so reads past it see the default, writes drop pixels past it and no loop runs for ever past 2^53 px. A saved channel (light, fluorescent, thermochromic, ferrofluid, thick paint), culture occupancy, layer asset or deep samples that reach past it are refused with a load problem ("it lies outside the surface range, …") instead of being saved at another tile or as a blank PNG. New exports: `MIN_TILE`, `MAX_TILE`, `MIN_SURFACE_PIXEL`, `MAX_SURFACE_PIXEL`, `SURFACE_RANGE_MESSAGE`, `tileInRange`, `checkSurfaceRange` and `surfaceFromSavedPixels`. The Swift paint editor matches, and the `document-load-edge-cases` scenario records the refusals and channels on the range's first and last tiles.

## 0.65.0

### Minor Changes

- 55882c8: Swift paint editor: light / dark (dual-colour) paint follows the viewer's colour scheme, as in the TS core (#718, #720).

  - Strokes record a light / dark pair: `PaintStrokeInit.dualColor`, `setColor(dual:)`, the `set_color` tool's `dualColor`, a brush's light / dark default, and `updateStroke(dualColor:)`. A plain colour drops the pair.
  - Stroke layers keep each pair's light side in the document and show the `setColorScheme` side in the view (display, image and PSD exports, the stroke being drawn); the document, history and saved file don't change with the scheme.
  - Pixel layers, wet paint included, show the scheme's side through a replay of the stroke log into a view-only editor (`SchemeReplay`): built in the background by the host's clock (`runSchemeReplay`; `PaintEditorModel.runSchemeReplayClock` in the editor view), kept current from new strokes and events, a live stroke followed point by point, undo and redo rolled back to checkpoints. Layers holding pixels the log doesn't have are marked (`PaintDocumentState.unlogged`, saved as the `unlogged` extension with documents that hold dual-colour strokes) and keep their colours.
  - `colorSchemeView()`, `colorSchemeViewReady()` and the `get_color_scheme_view` agent tool (with `wait`); the layers panel marks kept (◐) and updating (⟳) layers; `PaintEditorView` follows the system appearance (`followsColorScheme`), and the Swift demo has a scheme switch.
  - A paint colour that came from a light / dark brush default now follows `setColorScheme` even when the colour is locked, as in the TS core.
  - `replayItem`, `advanceReplayClock` and `replayStrokeInit` are split out of `replayPainting`; a wet stroke's points applied at one clock are pushed together, as in TS.
  - Conformance: the `color-scheme-replay` scenario's Swift skip is removed; all 69 paint scenarios pass in Swift.

## 0.64.0

### Minor Changes

- 2912c39: The Swift editors can save, list and open documents and clean up their stored images, as the TS core does (follow-up to #742). `PixerateCore` adds named documents (`createEditorDocumentStore`, `SavedEditorDocument`), asset garbage collection (`collectEditorAssetGarbage`, `tryCollectEditorAssetGarbage`, `collectRetiredEditorAssets`, `withEditorAssets`, with write leases so a save in flight keeps its assets), and the store tools of `createDocumentToolProvider`: `save_<kind>_document`, `list_saved_<kind>_documents`, `open_saved_<kind>_document` and, for documents with assets on storage that lists its keys, `find_unreferenced_<kind>_assets` / `delete_unreferenced_<kind>_assets`, with the TS results and messages. `EditorStorage` gains `kind`, `remove` and key listing (`listsKeys`, `keys(_:)`); `MemoryEditorStorage` keeps insertion order like the TS memory storage, and `DirectoryEditorStorage` stores one file per key in a folder.

  Paint registers them with the host's store: `createPaintDocumentToolProvider(_:store:)` and `PaintEditorModel(documentStore:)`, which the Swift demo passes a folder in Application Support, as the TS demo's paint tab passes its IndexedDB store.

  The paint contract now lists the store tools (its conformance host has a memory document store with a fixed clock), and the new `document-store` paint scenario calls every one of them.

## 0.63.0

### Minor Changes

- 2b1bb28: Swift paint documents read the image editor's vector parts as the TS core does (#742). Vector masks on pixel layers and groups are read through a port of `readShapeComponents` (live rectangles, ellipses, polygons, stars and lines, anchor lists with handles and live corners, SVG path data, hybrid edges), kept on `RasterLayer.vectorMask` and saved back; a damaged one is left out with the TS core's message. Shape and type layers are checked with the image editor's validation (components, live shapes, paints, gradients, patterns, strokes, text and paragraph styles, PSD blocks, stored pixels) and report its problem before the paint editor leaves them out, and annotation layers are reported as the shape, type or annotation layers the image editor migrates them to. `PixerateRaster` adds `JS.tan` (V8's `Math.tan`, bit-exact), and `PixeratePaint` now depends on `PixerateGeometry`.

  The new `document-load-vector-layers` paint scenario checks all of it.

### Patch Changes

- 2b1bb28: Swift paint documents now open the last three edge cases the way the TS core does (#742). Saved channels far off the canvas are no longer refused: their tiles get the keys TS gives them, including keys that round past 2^53 (`jsTileKey`; `tileKey` switches to it outside ±2^30 tiles). Deep 16- and 32-bit samples with a fractional, text, boolean or array `width` or `height` are written where JavaScript arithmetic puts them (`writeDeepRegionUnchecked`), and an array `deep` is reported as TS reports it. A saved wet event with a non-integer `at` (`1.5`, `"0.25"`, `true`) replays at that value among the strokes instead of at 0 (`WetEvent.replayAt`).

  The new `document-load-edge-cases` paint scenario checks all three.

## 0.62.0

### Minor Changes

- 06ed24f: Swift paint documents read the image editor's vector parts as the TS core does (#742). Vector masks on pixel layers and groups are read through a port of `readShapeComponents` (live rectangles, ellipses, polygons, stars and lines, anchor lists with handles and live corners, SVG path data, hybrid edges), kept on `RasterLayer.vectorMask` and saved back; a damaged one is left out with the TS core's message. Shape and type layers are checked with the image editor's validation (components, live shapes, paints, gradients, patterns, strokes, text and paragraph styles, PSD blocks, stored pixels) and report its problem before the paint editor leaves them out, and annotation layers are reported as the shape, type or annotation layers the image editor migrates them to. `PixerateRaster` adds `JS.tan` (V8's `Math.tan`, bit-exact), and `PixeratePaint` now depends on `PixerateGeometry`.

  The new `document-load-vector-layers` paint scenario checks all of it.

## 0.61.0

### Minor Changes

- dcfa8fc: Swift paint documents with external assets and their agent tools (#742). `PixeratePaint` adds external asset stores (`PaintAssetStore`, `PaintEditorController.toJSONExternal` and `loadJSONAsync`, with the TS core's asset ids, references and problems), `createPaintEditorDocument` (the `pixerate.editor-document` contract of kind `paint`: images as content-addressed asset references, revisions from the controller's new `documentRevision`, opening clears the history, read-only mid-stroke), `editorDocument(assets:name:)` / `openEditorDocument(_:assets:)` so an envelope reopens in Swift, and `createPaintDocumentToolProvider` with `get_paint_document` / `load_paint_document` (also registered by `PaintEditorModel`). `PixerateCore` adds `EditorAssetRegistry`, `externalizeAssets`, `internalizeAssets`, `collectAssetRefs`, `persistEditorAssets` / `preloadEditorAssets` over an `EditorStorage` (`MemoryEditorStorage`), `EditorDocumentSpec` `subscribe` and `assets`, `EditorDocument.destroy()`, and `createDocumentToolProvider` (`get_<kind>_document`, `load_<kind>_document`, `undo_<kind>`, `redo_<kind>`; `EditorDocumentHistory` now reports `documentHistoryState()`).

  The paint contracts list the `paint-document` provider (`get_paint_document`, `load_paint_document`), `createPaintConformanceHost` registers it, and the new `document-tools` paint scenario calls both tools.

## 0.60.0

### Minor Changes

- 08b16f2: The Swift paint editor's Effects and Layer styles panels are easier to read. Effect controls are labelled like the web panels ("Scale", not "UScale": `humanizeParameterId` and `effectControlLabel` are new in `PixeratePaint`), choices show readable names, and pickers keep their label on iPadOS. Effect paint has one "Follows" choice (canvas, stroke, path) in place of two switches, shows the effect's name, and no longer wraps its repeat menu. Layer styles show the "Show styles" switch only once a layer has styles. Both panels take `showsHeading: false` for hosts that title the panel themselves.

## 0.59.1

### Patch Changes

- cda37b9: Specialty paints cost far less per frame in the Swift paint editor, with the same pixels as before.

  - **Light paint** (glow-wash, foxfire): a lit layer's glow tiles and spill are kept between frames (`LightCache`, as `light.ts` has), and the spill is blurred on every core. A 2048 × 1536 canvas with one long glow-wash stroke went from 116 ms to 20 ms a frame; foxfire growth from 52 ms to 3 ms.
  - **Live patterns** (turing-wash, coral-ink): the Gray-Scott step runs on every core, swaps its fields instead of copying them, and reads which cells are wet a tile at a time (`WetTileMask`; `LivePatternField.step` takes `wetTile` and `threads`, and `steppedTiles` lists the tiles it advanced). Only those tiles are shaded again. turing-wash went from 37 ms to 9 ms a frame, coral-ink from 32 ms to 8 ms.
  - **Pattern relief and thick paint**: relief is written only into tiles whose pattern or height changed, and stale thick-paint tiles are lit on every core.
  - `readRegion` and `writeRegion` copy whole rows.
  - `SpecialtyPaintBenchTests` measures a frame of each specialty brush (`SPECIALTY_BENCH=1 swift test -c release -Xswiftc -enable-testing --filter SpecialtyPaintBenchTests`).

## 0.59.0

### Minor Changes

- 64dd989: Add `PixerateVectorUI`, the vector editor's SwiftUI views for macOS 14 and iOS 17 (#625): `VectorEditorView` with a CoreGraphics canvas (`VectorCanvasView`, `VectorSceneDrawer`) that takes mouse, trackpad, Apple Pencil, touch and keyboard input (`VectorCanvasGesture`: select, move, resize, marquee, Direct Selection, the shape and Frame tools, Pen, Pencil, Scissors, Knife, Eraser, Shape Builder, Paint Bucket, Blend, Type and the distortion brush, each drag one undo step), a toolbar, layers and appearance panels rendered from the generated vector UI tables (`VectorUITables`, `VectorContracts.uiTables()`), `CoreTextVectorShaper` for real fonts, and `VectorEditorModel`, which owns the `ToolRegistry` so agents and the user edit the same document (servable over the MCP bridge). `PixerateVector` gains `vectorLayerRows` (the layers panel's rows). The Swift demo has a Vector tab with an agent panel.

## 0.58.0

### Minor Changes

- 1fd7b26: The Swift paint editor reads the house style: `check_paint_style`, `fix_paint_style` and `check_brush_style` (part of #791).

  - The paint contracts list the `paint-style` and `brush-style` providers, and the paint conformance host takes `setup.style` (`paint-editor.json`), `setup.brushStyle` (`brushes.json`), `setup.brand` (`brand.json`) and `setup.readOnly` (`PaintStyleSetup`), with eight new scenarios (`style-paint-checks`, `style-paint-fix`, `style-paint-brand`, `style-paint-skips`, `style-paint-invalid`, `style-paint-readonly`, `style-paint-none`, `style-brush-checks`).
  - `PixeratePaint` ports `paint-editor/style.ts` and `brushes/style.ts`: the `paper`, `brushes` and `max-layers` checks and the paint surface (the current colour, swatches, one colour per stroke), the `brushes`, `media` and `source-licences` checks and the surface of brush colours, profiles derived from the brand's palette, and `PaintHouseStyles`, which reports every file a skill leaves out in both domains, as `createStyleResolver` does.
  - `loadStyleProfile` in `PixerateCore` drops a string `$schema` before validating, as the TS loader does.

- 1fd7b26: The Swift vector editor reads the house style (part of #791): `createVectorStyleToolProvider` in `PixerateVector` gives `check_vector_style` and `fix_vector_style` on a style skill's `vector.json` and `brand.json`, with the stroke-widths and corner-radii checks, the shared palette-only, min-contrast, distinguishable and fonts-allowed checks on the vector style surface, the profile derived from the brand, and a fix that snaps stroke widths and corner radii as one undo step and keeps the selection. The vector conformance host registers the house-style tools and takes `style`, `brand` and `background` in its setup, with six new scenarios.

## 0.57.0

### Minor Changes

- ade8ec3: Swift charts read the house style's `brand.json` (part of #791).

  - `ChartStyleResolver(skill:layer:chartJson:brandJson:)` validates `brand.json` as `createStyleResolver` does (its schema, and its `checks` list against the shared checks), derives the chart profile from it (`chartStyleFromBrand`: palette, theme colours and a font stack), merges the skill's own `chart.json` over that, and runs the brand's checks after the profile's own. A brand that fails validation is left out with the same issue message as in the TS core.
  - `fonts-allowed` is a chart check in Swift too: the chart surface has no fonts, so it runs with no findings once a font is named and is skipped with the reason otherwise.
  - `PixerateCore` gains the brand helpers (`BRAND_COLOR_ROLES`, `brandColor`, `brandColors`, `brandPalette`, `brandFonts`, `BRAND_PROFILE_SCHEMA`, `SHARED_STYLE_CHECK_OPTIONS`) for the other domains to share.
  - The chart conformance host takes `setup.brand`, with two new scenarios: `style-brand` and `style-brand-invalid`.

## 0.56.0

### Minor Changes

- 9c1ed71: Office export of 3-D charts (#795): a chart with a 3-D view is written as Office's `bar3DChart`, `line3DChart` (with its hidden series axis) or `area3DChart`, with `c:view3D` (`rotX`, `rotY`, `depthPercent` in whole numbers), so it opens in 3-D in Office and reads back with its view. Office draws one 3-D group on one value axis, so a chart that mixes series types or uses the secondary axis is still saved flat, and the writer says why. Swift writes the same XML.

## 0.55.0

### Minor Changes

- a23396a: An isometric perspective grid for the vector editor (closes #799).

  - `VectorPerspective.isometric: { angle }` (1–89°, 30 is true isometric) with no vanishing points: planes floor, left and right, mapped in parallel (affine maps), so art keeps its size anywhere on a plane and grid lines never clip at a horizon. Drawing on a plane, laying art onto it and the grid lines work as for the other grids.
  - `vector.setPerspective` takes `isometric` (vanishing points are no longer required), and refuses vanishing points with it; `vectorIsometricPerspectivePreset(width, height, angle?)` starts one for a page.
  - React and Svelte `VectorPerspectivePanel` have an Iso preset next to 1-pt, 2-pt and 3-pt.
  - Swift: the same grid, sanitizing, plane maps and preset, with the isometric scenario extended.

## 0.54.0

### Minor Changes

- d278a50: Charts: a 3-D view (part of #795).

  - `ChartSpec.view3d?: { azimuth, elevation, depth }` (Office's `view3D`: turn 0–360°, eye height 0–90°, depth as a multiple of the bar width 0.2–20; defaults 20, 15 and 1 in `CHART_VIEW3D_DEFAULTS`). Absent means a flat chart, so existing documents are unchanged. `update_chart` (and `ChartController.update`) sets it, merges a partial view into the current one, and clears it with `null`; out-of-range values are refused with what is allowed.
  - Office 3-D bar, line and area charts now import with their view (`rotY`, `rotX`, `depthPercent`) instead of being noted as drawn flat; a view from below the floor is drawn from floor level and noted. 3-D pie and surface charts are still drawn flat. Writing a chart with a 3-D view to Office XML saves it flat and says so.
  - Swift: the same field, normalisation, update and Office import, with a new `view3d` conformance scenario and 3-D Office vectors.

## 0.53.0

### Minor Changes

- 6055c5e: Isometric (2.5D) projection for the vector and diagram editors (part of #799).

  - `isoProjector({ angle, scale, origin })` (`@pixerate/editor/tools`) maps grid points (i, j, k) to the page and gives a box's visible faces (top, right, left; a flat tile has only its top) with path data, its corners, its six-sided outline (an obstacle for label placement) and grid lines on whole multiples of a step, so a partial block lines up with whole ones. `isoOrder` sorts boxes back to front (wholly behind along an axis first, then farther, then input order; a cycle is broken at the farthest box), and `isoFaceColors` / `isoShade` shade one fill for the faces.
  - Vector: `vector.addIsoBoxes` (`VectorEditorController.addIsoBoxes`) adds editable blocks, each a group of face paths with optional grid lines, all in one group drawn back to front and centred on the artboard by default, as one undo step. Ported to the Swift vector editor with a conformance scenario.
  - Diagrams: `mermaidToSvg(doc, { projection: 'isometric' })` and `render_diagram` `projection: "isometric"` draw a laid-out diagram as blocks standing on their groups' floor tiles, with edges along the floor.

## 0.52.0

### Minor Changes

- edfaf6f: Label placement around obstacles (#792).

  - `placeLabels(labels, options)` (`@pixerate/editor/tools`): places labels near their anchors, clear of obstacles (boxes, points, segments, polygons; `labelHull` for convex hulls), of each other and of other labels' anchors. Each label tries its preferred sides (`prefer`, the corners and `center` too), stepping outwards from `distance` to `reach` and inside `bounds`, one line first and then its `wrapped` size. The most constrained labels go first, a clashing spot is used only when no clear one exists, and clashing labels go first in up to `passes` more rounds. Optional leader lines; the same input always gives the same result. Pure geometry: callers pass sizes.
  - Chart callouts are placed together with it, clear of the bars, points and each other, instead of being nudged one at a time (in TypeScript and Swift, which match exactly).
  - Diagram SVG export (`mermaidToSvg`): an edge label sits on its edge, or beside it when a node or another label is there.
  - Vector: `vector.placeCallouts` moves label nodes clear of the other art and each other and draws leader lines, as one undo step (`VectorEditorController.placeCallouts`); ported to the Swift vector editor with a conformance scenario.

## 0.51.0

### Minor Changes

- dfd74a5: House style in the editors (#776).

  - `styleSwatches(style)` lists the colours (profile palette, brand palette, brand roles) and fonts a house style offers, in picker order; `get_style` returns them as `swatches`, so agents pick from the same set as people.
  - `StyleDomain.defaults` and `styleDefaults(domain, style)` give new work its starting patch; charts use `chartStylePatch`. New agent tool `apply_chart_style` applies it as one undo step (refused on a read-only chart, `readOnly` option).
  - `STYLE_AGENT_INSTRUCTIONS`: domain-neutral prompt text for hosts while a house style is active.
  - React and Svelte: `useStyleSwatches(styles, domain, scope?)`, and `ChartEditor` / `ChartInspector` take `swatches` shown beside each series colour.
  - Swift: `apply_chart_style` in `createChartStyleToolProvider` (hidden on a read-only chart, `ChartStyleToolProviderOptions.readOnly`), with the `style-apply` scenario.

## 0.50.3

### Patch Changes

- 27412b9: House style: a style profile that is itself a `$token` reference (`chart.json` set to `{ "$token": "…" }`) no longer crashes `createStyleResolver`. The profile is left out with an issue saying why, and `get_style` / `check_chart_style` keep working (#768).

## 0.50.2

### Patch Changes

- 979e41f: House style: a style profile that is itself a `$token` reference (`chart.json` set to `{ "$token": "…" }`) no longer crashes `createStyleResolver`. The profile is left out with an issue saying why, and `get_style` / `check_chart_style` keep working (#768).

## 0.50.1

### Patch Changes

- 6be3243: Large sticker brushes spread out, and thick paint that also paints light works in Swift.

  - **Stickers at large sizes.** Past `STICKER_REACH` (64 px) a sticker brush's spacing now eases from its density toward `STICKER_LARGE_SPACING` (0.9 diameters) by `STICKER_SPREAD_SIZE` (256 px), so big stickers lie side by side along the path instead of piling onto one another. Scatter still stops at the reach, so they keep tracing the stroke. `stickerSpacing(density, size)` gives the spacing.
  - **Swift: thick paint with light.** A stroke whose light twin paints with an engine other than dab, particle, bristle and the exchange engines (the glow gel, or any impasto brush on a layer that already holds light) now lays plain dabs as in `stroke.ts`, instead of failing with "…which the Swift paint editor does not paint with yet".

- 763779b: Live biopaint growth is lighter on the main thread. Each growth frame now redraws only the tiles its new threads and digested paint touched, instead of the whole colony, and it no longer rescans each colony's occupancy for bounds it doesn't use. `runCultureClock(frameInterval:)` lets a host grow at a lower frame rate; growth speed stays the same.
- 5978a5c: The Metal-vs-CPU pixel expression tests no longer fail on a cold iOS simulator. They compare pixels, so they now allow the GPU compile up to 120 s instead of the 2 s production budget. Metal's first compile on a fresh CI simulator could take longer than that. Renderer behaviour is unchanged.

## 0.50.0

### Minor Changes

- 0508c20: Effect paint keeps translucent effects translucent, and stroke strips can keep their proportions.

  - **Effect alpha is a ceiling.** A dab used to multiply its coverage by the effect's alpha, and overlapping dabs then built a 20%-alpha glow up to solid colour. `sampleEffectField` now hands the alpha to `CoverageBuffer.accumulate` as a per-pixel ceiling (`limits`), so a stroke ends at the effect's own alpha however densely its dabs overlap.
  - **`map.width` for stroke strips.** A stroke-mapped effect strip was rendered `map.length` px wide, so its 256 rows squeezed across the tip with an aspect that was right only for a 256 px brush. The optional `width` (16..4096) sets the strip's rendered width apart from `length`, the stroke px per repeat: a host keeps the effect's proportions by setting `length` to `width × tip / EFFECT_STRIP_HEIGHT`.

- d83f2c3: Write and save authored effects in the Swift paint editor, and let agents look at them (#752).

  - Swift: `EffectAuthoringEditor`, a SwiftUI effect authoring editor matching React's and Svelte's `<EffectAuthoringEditor>` (toolbar with play, undo, redo and save preset; a preview drawn by `PixelMetalRenderer` for `pixel` sources when Metal is available, else on the CPU; the source with line numbers and issue markers; parameters with a keyframe toggle per control; a timeline), on `EffectAuthoringModel`, which follows the session an agent may also be changing. macOS 14 and iOS 17.
  - Swift: with the `author` policy, the paint editor's Effects tab offers New effect (from the `pixel.*` templates) and Edit on each authored effect, opening the editor in a sheet with Save to painting (`saveAuthoredEffect`). Hidden for `replay` and `off`.
  - Core and Swift: the paint editor's authoring tools now include `effect_authoring_view`, a PNG of the open effect at the playhead (or at `time`), in the painting's aspect with its longest side at most 256 px (`paintAuthoringViewSize`, `captureAuthoringPreview` in Swift). The `effect-authoring` conformance scenario covers it.
  - Swift: `effectAuthoringViewHandler`, `EffectAuthoringToolHost.capture`, and `effectSamplePicture` / `effectSampleInputs` (sample pictures for filter and transition previews), as in the TS core.

## 0.49.0

### Minor Changes

- 43300da: Pixel expressions can read an input picture with `sample(p)` (#754), so an effect written at run time can be a filter. `p` is a vec2 in uv (pixel centres, y down, as `uv`); the result is the `source` input as a straight-alpha vec4, bilinear with colour weighted by alpha and clamped to the edge, and transparent when there is no input. It counts 4 steps in the per-pixel cap, and the checker refuses a non-vec2 argument or the wrong number of arguments. A program that calls `sample` describes itself with `uses: ['filter']` and an image input `source` (and keeps no paint hint); any other stays a generator. In the paint editor an authored filter runs on a layer's dried paint with `apply_effect`, and the trial render times it on a picture. New exports: `pixelSample`, `pixelProgramSamples`, `PIXEL_SOURCE_INPUT`, and an optional `source` argument to `PixelEvaluator.render`. The Swift evaluator matches the TS one exactly, and the generated Metal kernel takes the source as `buffer(2)` with its size after the controls (`PixelMSLSource.sourceSizeOffset`).

## 0.48.0

### Minor Changes

- 434fb80: Swift chart port gaps (#719). `PixerateCore.readZip` is now a line-by-line port of `import/zip.ts`: the TS error messages, the size limit counted on the bytes actually read (a deck with a large video and one chart opens), the first of two same-named entries wins, directory names get the unsafe-path check, `unsafePaths` is `.error` / `.skip`, encrypted entries fail only when read, and ZIP64 entries without an extra field keep their 32-bit sizes. `ZipEntry` is a struct with the TS fields, and `ZipArchive` has `get`, `read(entry)` and `extractedSize`. The brush pack reader moved to `PixeratePaint` as `readBrushZip` (`BrushZipEntry`, `BrushZipError`), matching `brushes/import/zip.ts`. House-style `chart.json` profiles are validated against the chart profile schema and each check's options schema, so a bad profile is left out with the TS issue message (`ChartStyleResolver(skill:layer:chartJson:)`). Smaller fixes: code-unit string handling in the Mermaid, Sankey and treemap readers and the Office reader; NFC and NFD names kept apart (`JSKey`); `NaN` and `Infinity` written as JS writes them in SVG, OOXML and messages (`JSONValue.jsString`); `chartRasterSize` no longer traps on non-finite sizes; XML character references past U+10FFFF and `&toString;` behave as in the TS fallback parser; bar race playback keeps the end it started with; setup and tool base64 accepted as `atob` accepts it; and the PNG and SwiftUI chart renderers apply a mark's opacity to fill and stroke as one group and read `#rrggbbaa` alpha. `@pixerate/editor` exports `chartFallbackDomParser`, the XML parser its chart contracts use without a `DOMParser`; new chart conformance scenarios cover invalid style profiles and base64 setup files.

## 0.47.0

### Minor Changes

- 0b737c4: Swift `PaintEditorController.loadJSON` reads more of a paint document the way the TypeScript core does (#742): dual-colour stroke sides in any CSS colour (named, `rgb()`, `hsl()`, `oklab()`, `oklch()`, `color()`, normalised to hex by the new `parseCssColor` / `normalizeCssColor` / `normalizeCssDualColor` in `PixerateRaster`); saved wet and paint events kept verbatim; culture tips whose fields are not numbers kept as NaN; saved channel rects (light, fluorescence, thermochromic, thick paint, ferrofluid) read unchecked; deep 16- and 32-bit pixels and masks decoded and saved again; pixel-layer effect generators kept (`RasterLayer.generator`); and image editor smart objects, unknown adjustment kinds and annotation layers without an annotation reported with the image editor's messages. Conformance values are compared as JSON (`JSONValue.asJSON`).

## 0.46.0

### Minor Changes

- e9a5463: Stroke layers take erasers and light paint (#720, part 1). An eraser stroke is recorded with the layer's other strokes and redrawn with them, so editing, moving or removing the strokes under it (or the eraser itself) redraws exactly, and a partly erased dual-colour pen or highlighter stroke follows the colour scheme with only what is left. Light (the highlighter's glow, neon and other `light.amount` brushes) is redrawn with the strokes through each stroke's grey light twin, so it moves, dims and disappears with them; a stroke layer's spill takes the colours the scheme shows. Region redraws are no longer clipped to the canvas, so paint and light a stroke laid past the canvas edge go when the stroke does. Wet paint is still refused on stroke layers. `evolutionStrokeRefusal` refuses breeding eraser strokes (the evolution panels use it). The Swift paint editor does the same.

## 0.45.0

### Minor Changes

- dc0ba39: Specialty brushes are separated from standard media, with guided setup (#729).

  - `@pixerate/editor/brushes`: `BRUSH_SPECIALTIES`, `brushSpecialties` and `isSpecialtyBrush` name the specialty paint a brush lays (ferrofluid, UV-fluorescent and thermochromic ink, thin-film iridescence, ghost, mutation and live patterns). `brushLibraryGroups` files those brushes in a `specialty` group by kind (their `medium` is unchanged). `brushEditorSections` keeps the Light section to glowing light paint (its secondary controls only once the brush lays light), takes live patterns out of Behaviour, and adds an opt-in `specialty` section: a toggle per kind the host paints (`fluorescence.enabled`, `thermochromic.enabled`, `iridescence`, `ferro.enabled`, `ghost.enabled`, `mutation.enabled`, the `livePatterns.pattern` choice with `none`), its settings once it is on, and a `hint` saying how to use it. `setBrushEditorValue` handles those paths.
  - `@pixerate/editor/paint-editor`: `brushSpecialtyGuides(state)` gives, per specialty of the active brush, how to use it, whether the canvas is ready (UV blacklight, heat against the ink's threshold, magnets, view tilt, a mutation agent, wet time) and quick actions, each naming the agent tool and arguments that do it; `runBrushSpecialtyAction`, `paintBrushSpecialties`, `specialtyInPlay` and `warmCanvasHeat` go with it. New agent tool `get_specialty_guides`. Agent playback opens the new Specialty panel for the UV, heat, magnet and view tilt tools. The paint `ui.json` contract lists `specialties`.
  - React and Svelte: `SpecialtyGuideCard` at the top of `BrushPanel` (with `onOpenSpecialtyPanel` / `onopenspecialtypanel`), a new `SpecialtyPanel` and a Specialty tab in `PaintEditor` (marked while specialty paint is in play) holding the UV blacklight and heat, magnets (`FerroPanel`) and the view tilt, which leave `PaperPanel`. `BrushEditor` shows control hints; `BrushLibraryBrowser` lists specialty brushes by kind.
  - Swift: `get_specialty_guides`, `brushSpecialtyGuides`, `runBrushSpecialtyAction`, `PaintSpecialtyGuideCard` in `PaintBrushPanel`, `PaintSpecialtyPanel` as a Specialty tab, `PaintViewTiltPanel`, and a Specialty group in the brush picker.

## 0.44.0

### Minor Changes

- 2b21111: Paint families, a palette knife tool, and sticker brushes that trace the path at large sizes.

  - **Paint families.** Brushes gain a second facet beside their medium `category`: `family`, what the paint does (`dry`, `ink`, `wet`, `thick`, `metallic`, `spray`, `glow`, `iridescent`, `strands`, `stickers`, `living`, `ethereal`, `volatile`, `reactive`). Every preset declares one, and `resolveFamily` derives it for brushes that don't; tools have none. `PaintBrush.family`, `PAINT_FAMILIES`, `PAINT_GROUPINGS.byMedium` / `byFamily` (ordered groups with an id, label and member rule; also in the paint UI contract as `paintGroupings`) and `paintBrushGroup` let a host group its library either way. `list_brush_presets` filters by `family` and reports it, as does `describe_brush`, and the brush editor has a Family choice.
  - **Palette knife tool.** `palette-knife` is now a tool (`kind: 'tool'`, `tool: 'knife'`) that carries no paint: it scrapes and spreads the thick paint already on the layer (`brushTakesPaint` is false). Its category is `smudge`. The paint-loaded knife mark is retired; a saved brush based on it keeps working as a thick mark brush.
  - **Stickers at large sizes.** Sticker spacing and scatter scale with the sticker only up to `STICKER_REACH` (64 px), so big stickers stay on the stroke instead of landing far apart and off the path, and a stroke always ends with a sticker at its end.

## 0.43.0

### Minor Changes

- 76d5b33: Effect paint hints (#757). An effect summary can carry a `paint` hint (`map` path, stroke or canvas, up to two `colors` controls, `values`, `live`, `repeat`, `size`), and a provider can declare `capabilities.paintHints` to say only hinted effects suit paint. With it, the paint editor's paint browser (React and Svelte `PaintEffectsPanel`, Swift `PaintProviderEffectsPanel`), `search_effects` with the new `place: "paint"` and `set_effect_paint` offer only hinted effects; `set_effect_paint` refuses the rest and points to an effect layer or fill. Effect layers, fills and the paper are unchanged, and providers without the capability behave as before. Picking a hinted effect starts from its hint: its map and repeat, its values, the paint and secondary colours in its colour controls, and live; explicit arguments win. `checkEffectProvider` checks hints against the controls. Authored effects keep a hint in their document (`EffectAuthoringDocument.paint`, new tool `effect_authoring_set_paint_hint`), and the pixel expression templates carry one. `EffectsBrowser` (React and Svelte) takes a `filter`. `createFakeEffectProvider({ paintHints: true })` / `FakeEffectProvider(paintHints: true)` hint `fake.gradient` and `fake.trail`.

## 0.42.0

### Minor Changes

- d963d8f: Effects authoring: `EffectAuthoringDocument` has an optional `provider` object for the provider's own data (such as code compiled ahead of time from the document's source). The generic authoring session (TypeScript and Swift) gives it back unchanged from `exportDocument`, so it survives a paint editor's save, reopen and save again, and drops it when the source is edited, since it may describe the old source (undo brings it back). A `provider` that is not an object is refused as `invalid_values`.

## 0.41.0

### Minor Changes

- 6d8a75a: Effects written at run time can now be used as paint (#750). **Pixel expressions** are a bounded per-pixel language (no loops, no memory or API access, a cost cap) that this package evaluates itself, so agents can write effects even where generated code may not run. `createPixelEffectProvider` has templates that open with source editing, and the generic authoring session now edits source through an optional backend. The paint editor keeps authored effects in the painting with their source (`authored.<name>` ids). They work as effect paint, paper, effect layers, fills and light, and replay anywhere. New tools: `open_effect_authoring`, `save_authored_effect`, `list_authored_effects`, `remove_authored_effect` and `close_effect_authoring`. New options: an `authoredEffects` policy (`off` / `replay` (default) / `author`), `rawShaders` and `authoredEffectLimits`. The React and Svelte paint effects panels list authored effects. Swift ports the language (CPU, and Metal through generated MSL), the authoring contract and session, the tools and authored effects in paint documents.

## 0.40.0

### Minor Changes

- 13e0fb5: Swift paint editor: an Effects tab (`PaintProviderEffectsPanel`) for effect paper, effect layers, fills, light and effect paint, shown while an effects provider is registered; live effect paint plays in `PaintEditorView` (`playEffects`, `showEffectTime`); `export_image` and `export_psd` take `time` to export at a moment of live effects (`withEffectTime`, `renderAnimationFrame`). A new `live-effect-paint` conformance scenario covers sticker effect paint, live strokes and the timed exports.

## 0.39.1

### Patch Changes

- 351972c: Public initializers for option structs hosts build outside the module: `ReplayOptions` (so `replayStrokes` is callable without `@testable import`), `BrushHostProfile`, `MixerSettings`, `ExchangeRates`, `BlenderSettings`, `SmudgeSettings`, `WetPaperInput`, `PaintDabParams`, `VectorWiggleParams` and `VectorArtContext` (#747).

## 0.39.0

### Minor Changes

- aa73f87: Render one sticker stamp exactly as the paint canvas draws it, for brush and sticker previews (#738). `renderStickerStamp(art, { colour, size, frame, rotation })` (TS, `@pixerate/editor/paint-editor`) and `renderStickerStamp(_:colour:size:frame:rotation:)` (Swift) return `size × size` straight RGBA: a tintable sticker as a flat silhouette in the paint colour shaped by the art's alpha, any other in its own pixels, the frame wrapped to the art's frame count (negative frames from the last), turned clockwise about the centre. `renderStickerStampFrom(provider, ref, options)` (TS) and `renderStickerStamp(_:ref:…)` (Swift) load the art through `StickerArtCache.ensure` first, and draw editor stamps too. The canvas now tints and picks frames through the same shared helpers (`tintStickerArt`, `stickerArtFrame`), so previews and strokes can't drift; Swift matches the TS bytes.

## 0.38.0

### Minor Changes

- b729314: Swift paint editor: open saved paintings with `PaintEditorController.loadJSON`, matching the TypeScript loader. It reads layers and their assets, strokes, wet and paint events, wet settings, thick paint, light, UV and thermochromic ink, heat, ferrofluid and magnets, cultures, age, sticker layers (with animated frames), stroke layers, image sources, effect layers and effect paper, guides, swatches and mixing pads. It returns what could not be read in the TypeScript core's words, and keeps fields it does not know so they are written back. `PaintConformanceHost` now supports save → load steps (#739).

## 0.37.1

### Patch Changes

- 9dc6ae9: Paint time machine: ageing (`set_age`: varnish, fading, cracks, dust) is now one pass over the composite instead of inside each layer, in TypeScript and Swift. Multiply and Overlay layers are no longer yellowed twice, and light-spill (Linear Dodge) layers no longer pick up dust and bleach and brighten. Normal layers age as before. `bake_age` now bakes a layer that, over the painting, gives exactly what the preview showed (a Multiply glaze or a translucent wash over the paper no longer bakes to its own colour), and paint in hidden groups no longer counts as painted for the cracks.

## 0.37.0

### Minor Changes

- 47bba16: Swift paint editor: sticker drags preview without an undo step and drop as one (`previewSticker`, `cancelStickerPreview`), as in the TypeScript core.

## 0.36.1

### Patch Changes

- 9d81db4: Paint editor fixes:

  - Replayed strokes keep their own brush id: `list_strokes` reported a replayed antimatter stroke (or any replay while another brush was active) with the active brush's id (`pencil-6b`) next to the stroke brush's name. Fixed in TS and Swift.
  - Swift brush normalization drops `iridescence` from `marks.kind: "antimatter"` brushes as TS does, with the same messages.
  - Biopaint catches up on growth while closed whenever the document is replaced, not only when the canvas mounts: new `controller.onDocumentReplaced(listener)` (fired by `loadJSON`, `loadJSONAsync` and `newCanvas`) and `startCultureCatchUp(controller)`, used by the React and Svelte `PaintCanvas`; Swift adds `onDocumentReplaced` and `PaintEditorModel` catches up on it.
  - The `time-machine` conformance scenario paints with real presets, so ageing, X-ray and the scraper now run over real paint. That exposed a Swift scraper rounding difference (half-to-even instead of `Math.round`'s half-up on alpha and impasto height), now fixed.

## 0.36.0

### Minor Changes

- cd109b1: feat(stickers,paint): port `StickerProvider`, `combineStickerProviders`, `createFakeStickerProvider`, and `StickerArtCache` to Swift (`PixeratePaint`), and add animated sticker support (`animated`, `frameCount`, `frameDelay`, `frame`, and `marks.frameMode: 'perform' | 'random'`) across TypeScript and Swift (#728)

### Patch Changes

- cd109b1: fix(stickers,paint): a placed sticker's `frame` is checked against its art (`add_stickers` / `update_sticker` refuse a frame past the last, or above 0 on a static sticker, naming how many it has), frame 0 is left out instead of saved as `0` (also when a saved document has it), restamping a sticker without `frame` goes back to its first frame, and loading drops a `frame` that is not a whole number above 0. The brush editor has an "Animated frames" choice (`marks.frameMode`) for sticker brushes, in React, Svelte and the Swift brush panel. The paint conformance host takes `setup.stickers: "fake"` (the editor's stickers with the fake library), and a new `animated-stickers` scenario checks Swift against TypeScript for both frame modes (#728). In Swift, `canPaint` again leaves out brushes whose library stickers the sticker library doesn't have, or whose art failed to load.

## 0.35.0

### Minor Changes

- a1c15e8: feat(swift): live biopaint growth in the Swift paint editor (`PaintEditorController.playCultures(now:)` returning a `PaintCulturePlayer`, driven by `PaintEditorModel.runCultureClock()` in `PaintEditorView`). Each uninterrupted run commits as one "Culture growth" undo step with its `culture-grow` replay events, flushed before any other command, undo, redo, `set_age` or save; replays (`render_xray` with `strokes`, `export_high_res`, time-lapse) include growth not yet committed; pause and speed apply. Fix (TS and Swift): wet paint flowing on another layer no longer splits a live growth run and drops its replay events (#731).

## 0.34.0

### Minor Changes

- e3cbe1e: Vortex paint winds on screen in Swift (#733): `integrateVelocityFieldFrames` keeps `VORTEX_KEYFRAMES` snapshots of the integration, `vortexWindingField` blends neighbouring keyframes, and the controller plays the view-only animation (`marks.duration`) from `stepVortexAnimations`, which `PaintEditorModel.tick` calls on the editor clock. It ends on the committed pixels, and undo, redo or another stroke on the layer drops it, as in TypeScript.

## 0.33.0

### Minor Changes

- 6352bfa: feat(swift): play the antimatter blast expansion animation (`marks.duration`) in the Swift paint editor, matching TypeScript: `AntimatterStrokeDriver.renderAtTime` / `rebaseTime` / `hasBlasts` (frames from the stroke's heat field, with the mid-blast flash and shock ring), `PaintEditorController.tickBlastAnimation` / `hasActiveBlastAnimation` (view-only frames over the committed layers, keeping pre-stroke light and relief where a frame leaves them alone; cleared by undo, redo, a new canvas or stroke), driven by `PaintEditorModel.tick` on the `PaintEditorView` clock (#732)

  docs(core): the paint editor skill's antimatter reference explains that `duration` only animates the view.

## 0.32.0

### Minor Changes

- d2098bd: feat(paint): add biopaint mycelial ink (`culture` brush facet, `mycelial-ink`, `rot`, and `foxfire` presets, deterministic integer colony simulation, `get_cultures`, `grow_cultures`, `remove_cultures`, and `set_culture_options` tools, high-res replay events, and React, Svelte, and Swift `CulturePanel` / `PaintCulturePanel` controls) (#684)

## 0.31.0

### Minor Changes

- 88a0172: feat(paint): add vortex paint brush engine (`marks.kind: 'vortex'`), Euclidean distance + Lamb-Oseen displacement field (`paint/displacement.ts`), wet fluid swirl (`WetWorld.swirl`), and `vortex` / `ink-vortex` / `whirlpool` / `wet-vortex` presets (#683)

## 0.30.0

### Minor Changes

- fed3058: feat(paint): add painting time machine with non-destructive ageing preview, X-ray radiograph view, and multi-layer paint scraper brush (`set_age`, `get_age`, `bake_age`, `render_xray`, `set_xray_view`, `paint-scraper`)

## 0.29.0

### Minor Changes

- c45467b: feat(paint): add antimatter paint engine (`marks.kind: 'antimatter'`) with multi-layer fuel sensing, noise-edged radial blast fields, RGB and OKLab colour inversion, alpha annihilation, scorch rings, relief craters, ballistic sparks, view-only blast expansion animation, and presets (`antimatter`, `antimatter-flare`, `antimatter-charge`) (#682)

## 0.28.0

### Minor Changes

- b3b12be: Port chart controller, commands, agent tools, style checker, and conformance scenario runner (#701).
- b3b12be: Port chart layout, scene generation, sparklines, streaming, tooltips, and hit-testing/interaction helpers to `PixerateChart` (#700).
- b3b12be: Port chart model, number formats, scales, stats, trendlines, error bars, presets, recommendations, summaries, links, trees, maps, and CSV helpers (`PixerateChart` and `PixerateCore`).
- b3b12be: Port Office chart import and export (`PixerateCore` ZIP reader, DrawingML `c:chartSpace` and `cx:chartSpace` OOXML reader and writer, `.xlsx`/`.pptx`/`.docx` chart extraction, and `office-charts` tool provider) to Swift (#702).
- b3b12be: Port chart SVG export (`chartSceneToSvg`, `chartToSvg`, `chartSceneToDomSpec`, `sparklineToSvg`), raster helpers (`resolveChartSvgPaints`, `chartRasterSize`, `chartFileName`), diagram Sankey/Treemap parsers (`parseSankey`, `parseTreemap`, `treemapValue`), and Mermaid chart export/import (`chartToMermaid`, `chartFromMermaid`, `findMermaidCharts`) to Swift (#698).
- b3b12be: Add the `PixerateChartUI` target (`ChartEditorView`, `ChartView`, `ChartInspectorView`, `ChartTooltipOverlay`, `ChartEditorModel`, `coreTextChartMeasureText`, `ChartDisplayTicker`, `rasterizeChartScene` / `makeChartCoreGraphicsRasterizer`) and a Chart tab in `apps/swift-demo` (#699).

## 0.27.0

### Minor Changes

- 00a53de: Add ferrofluid paint and magnets (`ferro` brush facet with `amount`, `wavelength` and `threshold`, built-in presets `ferrofluid` and `ferro-ink`, per-layer liquid ferrofluid channel `doc.ferro[layerId]`, document magnets `doc.magnets`, analytical dipole magnetic field and tilted hexagonal Rosensweig relief spikes shaded by `LitCache` / `lightTile`, deterministic advection of liquid ferrofluid toward added or moved magnets, `cure_ferrofluid` to bake active spikes into permanent impasto relief, agent tools `add_magnet`, `update_magnet`, `remove_magnets`, `list_magnets`, `get_ferrofluid` and `cure_ferrofluid`, React/Svelte/Swift `<FerroPanel>` / `PaintFerroPanel` and canvas magnet overlays).

## 0.26.0

### Minor Changes

- 25834f2: Add reaction-diffusion live patterns (`livePatterns`) that grow inside wet paint and freeze when the paint dries (#644):

  - Add the `livePatterns` brush facet (`pattern`: `'spots' | 'stripes' | 'coral' | 'maze' | 'worms'`, `feed`, `kill`, `scale`, `contrast`, `secondColor`, `relief`) and built-in brush presets `turing-wash` and `coral-ink`.
  - Add a per-wet-layer half-resolution Gray-Scott field (`U, V`) in `packages/core/src/paint/live-patterns.ts` (outside the wet kernel) that steps during `advance_wet_paint` only where the wet world still holds water (`rho + sw > DRY_EPS`), shades wet and dried tiles (`secondColor` blend or pigment contrast), and optionally writes impasto height (`relief > 0`) into `doc.thick[layerId]`.
  - Add agent tools `get_live_patterns`, `set_live_patterns`, and `seed_live_patterns`, wet undo snapshots, document serialization/replay support, React/Svelte/Swift `WetPanel` controls, agent skill references, conformance scenario `live-patterns`, and the full Swift port in `PixeratePaint` and `PixeratePaintUI`.

## 0.25.0

### Minor Changes

- 7b7c216: Add mutation paint (`mutation` facet with `settle`, `patience` and `fade`; presets `mutation-wash` and `mutation-ink`): wet or dry paint strokes that settle into a pending mutation request (`onMutationRequest`, React `useMutationRequests`, Svelte `createMutationRequestStore`), sink away when claimed by an agent via `read_mutation` (releasing held wet ghost fade or fading a temporary dry layer), and are answered by the agent's presence cursor via `answer_mutation` (or kept as ordinary paint on `decline_mutation` or timeout). Includes `createMutationTools` (`list_mutations`, `read_mutation`, `answer_mutation`, `decline_mutation`), the `pixerate-paint-mutation` workflow skill with evals, Settle / Patience / Fade brush panel controls and agent connection status in React, Svelte and Swift, and full Swift parity.
- 59d0cd4: Add structural colour thin-film iridescence brush facet (`iridescence`), `ThickChannels.film` surface channel, built-in iridescent brush presets (`scarab-lacquer`, `soap-film`, `pearl-glaze`), view tilt shading (`set_view_tilt` / `get_view_tilt`), and opt-in `deviceTilt` gyroscope/orientation tracking across TypeScript core, React, Svelte, and Swift.
- 7809354: Add UV-fluorescent and thermochromic smart inks to the paint editor (`fluorescence` and `thermochromic` brush facets, `uv-marker` and `thermo-ink` presets, virtual UV blacklight view/document settings, coarse canvas heat field with diffusion, Newtonian cooling, and wet-paint drying, plus `set_uv_light`, `get_uv_light`, `paint_heat`, `advance_heat`, `clear_heat`, and `get_heat` agent tools and UI controls across React, Svelte, and Swift).

## 0.24.0

### Minor Changes

- 0a20011: feat(paint): Evolutionary strokes: breed and mutate stroke variants (`RecordedStroke` genomes) as pending paint proposals with smoothed point jitter, OKLCH colour drift, brush facet drift, seed reroll, crossover, agent tools (`breed_strokes`, `breed_proposal`, `get_proposal_genome`), React/Svelte `EvolutionPanel` UI, contact-sheet export, and Swift parity.

## 0.23.0

### Minor Changes

- f8806de: Add reference-layer region fill (`fillRegion` / `fill_region`) with morphological gap closing (`closeGap` 0..32 px), boundary expansion under anti-aliased line art (`expand` -16..16 px), soft boundary antialiasing, paper grain modulation, and optional watercolour wash fill (`wet: true`), plus enclosed region detection (`findUnfilledRegions` / `find_unfilled_regions`) and an interactive Fill tool (`G`, drag to adjust tolerance) across TypeScript, React, Svelte, and Swift.

## 0.22.0

### Minor Changes

- 0646d72: Add ghost paint and invisible ink (`ghost` facet with `linger` and `smear`): wet paint that flows and mixes visibly with the colours it meets while wet, then fades away completely without leaving a trace of its own colour, leaving only the smear where it lifted and dragged the paint already on the layer. Includes presets `ghost-wash`, `ghost-gouache`, `ghost-oil` and `invisible-ink`, `ghost.remaining` per layer in `get_wet_paint`, Linger and Smear sliders in React, Svelte and Swift brush panels, and full Swift parity.

## 0.21.0

### Minor Changes

- a2b66e5: Add path-native effect paint (`map: { by: 'path' }`) for effects with a `format: 'svg-path'` control, passing each stroke's centreline in canvas pixels (simplified to at most 256 points) to the effect's path control, with UI placement ("Along the stroke (native)") in React and Svelte and full Swift parity. A stroke painted by hand shows the effect along the path drawn so far while it is drawn (Swift: `needsPathPreview` / `renderPreview()`, which `PaintGesture` runs) and is painted along its whole path when it ends: `strokeRendering` (TS) and `needsPathRender` / `renderPath()` (Swift) cover providers that render asynchronously. `EffectRenderer` gains an optional `renderSync`.

## 0.20.1

### Patch Changes

- c2a283c: Fix `ArraySlice<UInt16>` concatenation type mismatch in `replaceVectorText`.

## 0.20.0

### Minor Changes

- 2683e36: **Swift vector editor: PDF, Lottie, Image Trace and stylise (#624).**

  - Vector PDF export (`Pdf.swift`, from `vector/pdf.ts`): `vectorDocumentToPdf` draws the scene render data as PDF paths, with linear and radial gradients as shadings, pattern paints as their tiles, opacity and blend modes as graphics states, clip masks, a page per artboard, `scale`, `title` and Flate compression; the bytes match the TS file. Notes name what is left out (filters, opacity masks, stop opacity, text without outlines).
  - Lottie export and import (`Lottie.swift`, from `vector/lottie.ts`): `vectorDocumentToLottie` with path effects as live shape modifiers and gradients as gradient fills, and `parseVectorLottie` / `lottieValueAt` reading one frame (eased and held keyframes, transforms and parenting, precomps, solids, additive masks, modifiers as live effects).
  - Image Trace (`Trace.swift`, from `vector/trace.ts`): `traceVectorImage` in threshold and colour modes, `vectorTraceContours`, `quantizeVectorTraceColors`; and the bitmap-to-vector styles (`Stylize.swift`, from `vector/stylize.ts`): `stylizeVectorImage` with mosaic, halftone, low poly and engraving.
  - The controller has `toPdf`, `toLottie`, `importLottie`, `traceImage` and `stylizeImage`; `vector.exportPdf`, `vector.exportLottie`, `vector.importLottie`, `vector.traceImage`, `vector.mosaicImage`, `vector.halftoneImage`, `vector.lowPolyImage` and `vector.hatchImage` run, so every vector command now has a Swift run, and the `import-export` scenario passes (14 of 15 vector scenarios).
  - `JS.acos` ports V8's `Math.acos` bit for bit on arm64; curve fitting, live corners and variable-width strokes use it instead of Foundation's.

- 94446bf: **Swift vector editor: text (#624).**

  - The shared text engine (`TextLayout.swift`, from `src/text`): `layoutText` with styled runs, paragraphs, line breaking (spaces, break characters, between CJK characters), alignment and justification, tracking, leading, indents, spacing, baseline shift and vertical writing (CJK upright, Latin sideways or upright), carets, hit testing, selection quads, decorations and fragment outlines.
  - A `VectorTextShaper` protocol (`resolve`, `metrics`, `measure` over UTF-16 code units, optional `outline`, `vertical` and `families`) with `MetricTextShaper` (`createMetricTextShaper`: per-class advances, 0.8 / 0.2 em ascent and descent, bold 5 % wider) as the default; `setVectorTextShaper` swaps it, and the conformance host forces the metric shaper.
  - Text nodes (`VectorText.swift`, from `vector/text.ts`): runs and styles, path measuring, point, area and path text layout with vertical orientation (`layoutVectorText`), glyph boxes or outlines (`vectorTextPaths`), carets, spans, validation (`patchVectorCharacterStyle`, `patchVectorParagraphStyle`, `sanitizeVectorTextFrame`, `sanitizeVectorTextFields`) and the pure edits, including `bakeVectorTextGeometry`.
  - Text now bounds, transforms (scale bakes into font sizes), blends (as its glyphs), draws in render data (SVG text spans, or outlines with an outline shaper), exports to SVG (`<g data-vector-text>`, or outlines with effects) and imports (our own text, live text with effects, and foreign `<text>` as point text); frames lay out point, area and path text children, and master pages fill `{page}` / `{pages}` in text.
  - The controller has `addText`, `createTextNode`, `setText`, `setTextStyle`, `styleTexts`, `setParagraphStyle`, `setTextFrame`, `setTextOrientation`, `typeOnPath`, `createOutlines`, `getTextLayout`, `setTextShaper`, `setTextDefaults` and the text panel's data (`textPanel`). The 10 text commands run, and the `text` scenario passes (13 of 15 vector scenarios).

- 3dcb648: **Swift vector editor: effect and generation agent tools; the vector domain is fully ported (#624).**

  - Provider vector effects (`ControllerEffects.swift`, from `vector/controller.ts`): `addVectorEffect`, `updateVectorEffect`, `detachVectorEffect`, `vectorEffectGroups` and the effects slot (`effectsProvider`, `setEffectsProvider`, `useEffects`). A vector effect's SVG is read with the SVG importer into a group that keeps its `providerEffect` and draws as a plain group in render data and SVG export.
  - `createVectorEffectsToolProvider` (`search_effects`, `describe_effect`, `list_applied_effects`, `apply_effect`, `update_effect`, `remove_effect`) on the shared effect tools, now `effectToolHandlers` with an `EffectToolHost` in `PixeratePaint`, which `createPaintEffectsToolProvider` uses too. `VectorEffectProvider` adds `applyVectorEffect`; `FakeEffectProvider` implements it (`badge`, `route`, `fade-in`) as the TS fake does.
  - Generation (`Generate.swift`, from `vector/generate.ts`): `generateVectorArt`, `regenerateVectorArt` (keeps the group's id, place and transform), `replaceGeneratedArt`, `vectorArtModels`, idempotency keys, `createVectorGenerationToolProvider` (`list_vector_art_models`, `generate_vector_art`, `regenerate_vector_art`) and `FAKE_VECTOR_ART_MODELS` / `fakeVectorArtGenerator`. SVG export writes `data-vector-generation` and SVG import reads it back.
  - Generation planning in `PixerateCore` for any domain (`generation/capabilities.ts`, `plan.ts`, `provenance.ts`, `hash.ts`): `ModelCapabilities`, `planGenerationRequest` with every strategy, `createProvenance` (prompts as written; templates and values are not ported), `parseProvenance`, `stableStringify`. `jsToFixed` moved to `PixerateCore`.
  - `VectorConformanceHost` registers both providers; all 15 vector scenarios pass, and `VectorConformanceTests` fails if a vector scenario is skipped.

## 0.19.3

### Patch Changes

- f09621b: Fix regressions from the wet painting speed-up:

  - Capped wet shading goes back to the longest-unshaded tile first. Per-slot stamps were compared across tiles, so on canvases with more than 24 stale tiles the older tiles stopped updating.
  - Tiles freed by drying or baking are now in the dirty rectangles, so the canvas no longer keeps their old pixels.
  - `tick` keeps the steps it could not run, as the TypeScript core does, instead of dropping the backlog.
  - `PaintEditorModel.brushes` follows library edits that keep a brush's id.
  - `finishTile` no longer rebinds array storage to detect uniform tiles.

## 0.19.2

### Patch Changes

- 1816d5c: Speed up live wet and dry painting in the Swift paint engine and UI without changing simulation or rendering results:

  - Track wet-tile shading validity per slot (`slotStamp`) and per changed base/light tile (`!==`) instead of invalidating all active tiles in the lane on every brush dab, and emit the exact changed tile rectangles from `updateSurfaces` so pointer moves only shade and recomposite the touched tiles (~22× faster pointer moves on multi-tile wet canvases).
  - Route `PaintLiveStroke.push`, `PaintWetLayers.tick`, `advance`, and `dry` through `syncDisplaysGpu` when the Metal shader is active, parallelize CPU tile shading across `wetParallel`, and flush tile halo border copies lazily in parallel before `step` and `snapshot`.
  - Add a bit-identical fast path in `pixerate_wet_step` for dry 4-cell blocks inside active tiles and skip neighbour pigment face loads on dry cells, plus raw-pointer fast paths in `WetFilm.shadeTile`, `RasterCompositor.blendTile`, `TiledSurface.contentBounds` (memoized), and `PaintCanvasPresenter.render`.
  - Separate canvas frame ticks (`revision`) from non-canvas UI state (`stateRevision`) in `PaintEditorModel`, read wet panel sliders via `wetLayerSettings` instead of scanning every active tile via `world.stats`, and make the wet simulation loop adaptive during live strokes.

## 0.19.1

### Patch Changes

- 551c558: Painting in the Swift paint canvas is smoother. `PaintCanvasPresenter` keeps the painting as one BGRA image per tile (`tiles()`), and `PaintCanvasView` shows the tiles as Core Animation layers, so a stroke rebuilds and uploads only the tiles it changed instead of converting and copying the whole canvas every frame. A live stroke tells the view where its dabs landed, so changed tiles are recomposited only there (as the TypeScript controller's `takeDirty` does), and each changed tile is finished once per frame instead of once per dab.

## 0.19.0

### Minor Changes

- 1803639: **Swift vector editor: constraints (#624).**

  - The constraint solver (`ConstraintSolve.swift`, `ConstraintLM.swift`): every constraint kind (coincident, collinear, concentric, fix, parallel, perpendicular, horizontal, vertical, tangent, smooth, symmetric, equal) and dimension (distance aligned / horizontal / vertical, angle, radius, diameter) over anchors by stable id, handles, segments and round paths, solved per connected component by the damped minimum-norm Gauss–Newton solver, with what was just edited moving least. Ported operation for operation, so solves take the same iterations and land on the same coordinates as the TS core.
  - Values are expressions over named parameters (`ConstraintExpr.swift`: `VectorExprEnv`, `evalVectorExpression`, `formatVectorValue`). `addVectorConstraint` names and measures new dimensions and refuses conflicting or redundant constraints, naming the ones involved; `vectorConstraintDof` reports the degrees of freedom left per drawing and per path; `purgeVectorConstraints` drops constraints whose anchors are gone.
  - Auto Constrain (`ConstraintAuto.swift`: `inferVectorConstraints`, `autoConstrainVector`, `withVectorAnchorIds`) and the glyph, action and panel data (`ConstraintGlyphs.swift`).
  - The controller solves the constraints after every edit and has `addConstraint`, `removeConstraints`, `setConstraintValue`, `autoConstrain`, `getConstraints`, `getParameters`, `getConstraintDof`, `constraintIssues` and `constraintPanel`. The 5 constraint commands run, and the `constraints` scenario passes (11 of 15 vector scenarios).

- da5e4d2: **Swift vector editor: frames, pages, connectors, snapping options and perspective grids (#624).**

  - Frames (`Frames.swift`): `vectorFrameDrawn` (a frame as its clip group of fill, master art and children), `sanitizeVectorFrame`, `sanitizeVectorResizing`, `vectorBoundsInside`, `vectorFrameDocument`; frames now draw, bound and mask through it in appearance, masks, render data (a clip mask in render data) and SVG export (a `<g data-vector-frame>` with its clip path) and import.
  - Pages and master pages (`Pages.swift`): `vectorPages`, `vectorMasterPages`, `vectorMasterArt` (laid out by resizing constraints, `{page}` / `{pages}` filled in) and `resolveVectorMasterPages`, run after every edit and stripped from saved documents.
  - Connectors (`Connectors.swift`): connection sites, straight / elbow / curved routes, `routeVectorConnector` and `rerouteVectorConnectors` after every edit (after the constraint solve), glue to deleted objects dropped; `data-vector-connector` and `data-vector-resizing` in the SVG round trip.
  - Perspective grids (`Perspective.swift`): planes, plane maps, flat-to-plane and back, projected paths, grid lines and presets; `vectorPolarAngles` (`Snap.swift`) and the TS snap defaults.
  - The controller has `addFrame`, `frameSelection`, `setFrame`, `setResizing`, `getFrames`, `frameToSvg`, `addPage`, `addMasterPage`, `setPageMaster`, `movePage`, `goToPage`, `getPages`, `addConnector`, `setConnector`, `getConnectors`, `getConnectionSites`, `setConnectorRoute`, `setSnap`, `setPerspective`, `setPerspectivePlane`, `attachToPerspective`, and a `viewport` that `goToPage`, `setViewport` and `zoomToFit` move. The 23 frame, page, connector, snapping and perspective commands run, and the `frames-pages-connectors` scenario passes (12 of 15 vector scenarios).

- c514aa5: **Swift vector editor: symbols and instances (#624).**

  - Symbols (`Symbols.swift`): instances carry their symbol's art (`resolveVectorSymbols` after every change, `stripVectorSymbolArt` for saved documents) and draw it as a plain group (`vectorInstanceDrawn`): the rotation on the group, scale and skew baked into the art, strokes scaled with the instance unless `scaleStrokes` is off, fill / stroke tints and hidden art nodes applied. Nested symbols resolve through each other, and a symbol that would contain itself draws nothing (`vectorSymbolUses`).
  - Instances take part in bounds, appearance, Expand Appearance, blends (instance keys blend as their art), render data and SVG export, as a `<use>` of a `<symbol>` in `defs` or, where `<use>` cannot draw an instance exactly, as its drawn art in a `<g data-vector-instance>`. SVG import reads them back, with unused symbols, and turns a `<use>` of any element into an instance.
  - The controller has `makeSymbol`, `placeSymbol`, `setInstanceOptions`, `replaceSymbol`, `detachInstances`, `renameSymbol`, `deleteSymbol`, `editSymbol` and `exitSymbolEdit` (isolation mode, with undo stepping in and out), `getSymbols`, `getSymbolInstances`, `symbolEditState`, and the symbols panel's data (`symbolsPanel`, `symbolEditBackground`). `vector.list` lists instances.
  - The 10 symbol commands run, and the `symbols` scenario passes (10 of 15 vector scenarios).

## 0.18.0

### Minor Changes

- 1864d55: **Swift vector editor: blends, envelopes and live symmetry (#624).**

  - Morphs (`Blend.swift`): `createVectorMorph` and `interpolateVectorPaths` bring two paths or groups to matching anchors (arc-length refinement, the start and winding that cost least by Procrustes fit and shape contexts) and interpolate them, turning rather than collapsing; paints mix in OKLab (`interpolateVectorColor`, `interpolateVectorPaint`, resampled gradient stops), and stroke widths, dashes, arrowhead scales and width profiles interpolate (`interpolateVectorStyle`).
  - Live blend groups (`BlendGroup.swift`): steps, distance and smooth-colour spacing, replaced spines with orientation to the spine, expand and release. The controller regenerates a blend's steps after every change and has `blend`, `setBlendOptions`, `replaceBlendSpine`, `expandBlend` and `releaseBlend`; `vector.list` lists blend options.
  - Envelopes (`Warp.swift`): the fifteen warp presets, Bézier meshes (fit, evaluate, split, resize, from an outline, outline) and the Envelope effect, drawn in bounds, render data and SVG export. The controller has `envelope`, `makeEnvelopeWithTopObject` and `releaseEnvelope`; `updateEffect` turns a preset into the mesh it stood for, transforms that skew or mirror do too, and Free Distort maps envelope meshes and blend spines.
  - Live symmetry (`Symmetry.swift`): mirror, four-quarter, diagonal and radial (kaleidoscope) symmetry groups drawn with their copies in bounds, render data and SVG export; `makeSymmetry`, `setSymmetry`, `releaseSymmetry` (with expand), `enterSymmetry` and `exitSymmetry`.
  - SVG export writes blends (`data-vector-blend`), and SVG import reads back blends, symmetry groups and path effects.
  - The 11 blend, envelope and symmetry commands run, and the `blends-and-envelopes` scenario passes (9 of 15 vector scenarios).

- 55858eb: **Swift vector editor: paint and appearance (#624).**

  - Gradients: `setGradient` (a colour becomes a gradient; type changes, `aspect`, `reverse`, stops), with `parseVectorColor`, `applyVectorGradientPatch` and `defaultVectorGradient`.
  - Fill and stroke stacks: `addPaintLayer`, `updatePaintLayer`, `removePaintLayer`, `movePaintLayer` and `setPaintLayers`; `addShape`, `addPath` and `setStyle` now take gradient paints and whole `fills` / `strokes` stacks, and shape defaults may hold stacks.
  - Blend modes and filters: `setBlendMode`, `addFilter`, `updateFilter`, `removeFilter` and `moveFilter`, with the filters drawn as SVG filters in the scene render data and the SVG export (`vectorFilterSvg`, `vectorFilterMarkup`).
  - Path effects (`PathEffects.swift`, `applyVectorEffects`): Trim Paths, Round Corners, Pucker & Bloat, Twist, Zig Zag, Wiggle Paths, Offset Paths, Merge Paths, Repeater, Contour and Block Shadow, with `addEffect`, `updateEffect`, `removeEffect`, `moveEffect` and Expand Appearance. They follow baked transforms and are drawn in render data and SVG export. Envelope, Extrude and Bevel still throw `VectorNotPorted`.
  - Masks: `makeMask` (clipping and opacity masks), `setMaskOptions` and `releaseMask`; mask groups are bounded, listed and used by booleans and the Pathfinder as their masked result.
  - Lenses: `setLens`, with backdrops resolved after every edit and stripped from saved documents, and `vectorLensDrawn`.
  - The 26 commands behind these run, and the `paint-and-appearance` scenario passes (6 of 15 vector scenarios).

- 7822816: **Swift vector editor: gradient meshes, freeform gradients and the rest of the gradient paint servers (#624).**

  - Gradient meshes and freeform gradients (`Shading.swift`): Coons patches through a lattice of coloured points (`createVectorMeshGradient`, `vectorMeshPointAt`, `vectorMeshColorAt`, `vectorMeshLines`), freeform colour fields with spreads and lines (`vectorFreeformField`, `sampleVectorFreeform`, `autoVectorFreeformGradient`), their checks (`sanitizeVectorShadedPaint`), point edits and transforms. They are drawn in render data and SVG export as patterns of flat tiles and strips (`vectorShadedSvgDefs`), and SVG import reads them back.
  - The controller has `setMeshGradient`, `setMeshPoint`, `setFreeformGradient`, `addFreeformPoint`, `setFreeformPoint`, `removeFreeformPoint`, `setFreeformLines` and `getShading`, and the 8 commands behind them run. Mesh and freeform paints passed to `setStyle`, `addShape` and paint stacks are checked instead of throwing.
  - Every gradient now has a paint server: stop midpoints, smoothness and linear / Oklab interpolation are expanded into stops (`expandVectorGradientStops`, `vectorGradientRamp`), reflected gradients with a pad or repeat spread become stop periods (`expandVectorGradientSpread`), conic and diamond gradients become patterns of gradient tiles, and gradients along or across a stroke become patterns of slices (`vectorStrokeGradientDefs`). `VectorPaintDef` is now an enum of a gradient element or a `VectorSvgPatternDef`.
  - Free Distort now takes gradient, mesh and freeform paints: node-space gradient handles and mesh / freeform points follow the map (`mapVectorPaint`); box gradients follow the new bounds.
  - The `gradients-and-shading` scenario passes (8 of 15 vector scenarios).

- a262d64: **Swift vector editor: strokes, corners and brushstrokes (#624).**

  - Width profiles (`Width.swift`): presets, side scales with monotone interpolation, width points (`insertWidthPoint`, `setWidthPoint`, `removeWidthPoints`), taper / wave and pressure generators. The controller has `setWidthProfile` and `setWidthPoint`; stroke layers, shape defaults and SVG import keep profiles.
  - Variable-width outlines (`variableStrokeOutline`, `variableStrokeRings`) and stroke parts (`vectorStrokeParts`, `vectorStrokeOutlinePath`, `hitTestVectorStroke`): alignment, arrowheads (`tip` and `extend`), caps, joins and dashes, matching the TS core exactly. Opacity masks, filter reach and the Pathfinder now take aligned, arrowed and profiled strokes.
  - `outlineStroke`: one filled path per stroke layer above a copy that keeps the fill.
  - Live corners in the controller: `setCornerRadius`, `setCornerKind` and `setCornerSmoothing`.
  - Brushstrokes as data: `addBrushstroke`, `setBrushstroke`, `setColorScheme` and `setColorLocked`, with the brushes the vector profile admits (`vectorBrushstrokeBrushes`), their checks and default colours. `PixerateVector` now depends on `PixeratePaint`. Drawing brushstrokes in render data and SVG export (the raster brush engine along a path) still throws `VectorNotPorted`, as do aligned, arrowed and profiled strokes in render data and SVG export.
  - The 9 commands behind these run, and the `strokes-and-corners` scenario passes (7 of 15 vector scenarios).

## 0.17.0

### Minor Changes

- 320fd4d: **History: remove stale steps with `dropSteps`.**

  - `HistoryManager.dropSteps(match)` removes the undo and redo steps `match` picks without running them, for steps whose changes no longer apply (remote content replaced what they change, a layer was reloaded). The other steps keep their order, a gesture merging into a removed step ends, and a mark on a removed step is no longer valid. It reports a `drop` commit event and returns how many steps were removed. Until now, integrators had to skip such steps by hand or reach into private fields.
  - History entries (`getEntries`, commit events) now carry the step's `tag`.
  - React `useHistory().dropSteps`, Svelte `createHistory().dropSteps` and Swift `HistoryManager.dropSteps` match.

  **Canvas: gesture undo keeps work done since.**

  - `createCanvasGestureRecorder` undo and redo now put back only the nodes and edges the gesture changed. Before, they restored the whole canvas from before the drag, which removed nodes and edges a collaborator or an agent had added since and undid their moves. A node the gesture changed is replaced only if it is still there (undoing a move does not bring back a node deleted since), and one the gesture added or removed is removed or put back at its index.

## 0.16.0

### Minor Changes

- b1acb12: **Swift vector editor: the controller and its commands (#622).**

  - `VectorEditorController` in `PixerateVector`: the document, selection, tool, editing options and defaults, with one undo step per change on its `HistoryManager`. Transforms (move, scale, rotate, set rotation), skew, Free Distort, align, distribute, arrange, group, ungroup, layer moves, booleans and live booleans, Pathfinder, the Shape Builder, the paint bucket, anchor edits (move, bend, delete keeping the shape), Join, Average, Smooth, Remove Redundant Points, Scissors, Knife, Eraser, the distortion brushes (smudge, twirl, attract, repel, roughen), drawing by dimensions, and SVG export of plain paths and groups.
  - `createVectorCommands`: all 150 vector commands, with their label, group, keywords, description, params schema and shortcut read from the contract (`commands.json`) and their TS enablement. The commands the controller does not have yet fail with "not ported to Swift yet (#624)".
  - `VectorConformanceHost` and `VectorConformanceTests`: the `shapes-and-paths`, `arrange-and-transform`, `booleans-and-pathfinder` and `path-editing` scenarios pass; the other ten are skipped (#624).
  - Live boolean groups now draw and are bounded as their folded operands (`expandVectorAppearance`, `vectorAppearanceShapes`).

  **Core:** `vectorContracts()` now writes each command's own `undoable` and `readOnly` flags, and `params` only for commands that take some. Before, 31 commands that run outside history were listed as undoable, and `vector.list` had an empty params schema.

- ac58b3b: **Swift vector editor: scene render data and SVG (#623).**

  - `getVectorSceneRenderData` / `VectorEditorController.sceneRenderData` in `PixerateVector`: the document-space paths, groups and paint servers the canvases draw, as the TS returns them, for paths and groups, transforms, opacity, blend modes, linear and radial gradients, paint stacks and live booleans.
  - Paint stacks (`vectorFills`, `vectorStrokes`, `withVectorFills`, `withVectorStrokes`, `normalizeVectorPaintStacks`, `vectorPaintLayerNodes`, the sanitizers) and gradient paint servers (`vectorPaintToSvg`, `vectorGradientSvgDefs`, `sanitizeVectorGradient`).
  - `vectorDocumentToSvg` now writes gradients (with `data-vector-gradient`), paint stacks (`<g data-vector-path>`), blend modes, filter stacks whose filters draw nothing, and live booleans (drawn shapes plus the hidden source) as the TS does.
  - SVG import: `parseVectorSvg` and the `vector.importSvg` command (add or replace): shapes, groups, transforms, `viewBox`, presentation attributes, `<style>` rules and `style` declarations, fill and stroke opacity, gradients through `href` chains, clip paths and masks as mask groups, and this editor's own export. Features not ported yet throw "not ported to Swift yet (#624)".
  - The conformance runner reads the `render` step flag and compares `render()` of the host. The new `svg-round-trip` scenario passes, with the four ported scenarios' render steps; the SVG steps of `import-export` replay on their own.
  - `String.jsParseFloat` and `String.jsToNumber` in `PixerateCore`: `parseFloat` and `Number` of strings as V8 reads them.

  **Core:** conformance steps take an optional `render: true`: the recorder writes `expect.render` from the host's new optional `render()`, and the replay tests compare it like a result. The vector conformance host renders `getVectorSceneRenderData` of its controller's state. New vector scenario `svg-round-trip`.

## 0.15.0

### Minor Changes

- e59fa5e: **Swift:** the first part of the Swift vector editor (#622).

  **Commands in `PixerateCore`**
  - `CommandRegistry`, `createCommandToolProvider` (`list_commands`, `run_command`, `run_commands` with `$N.path` references and atomic batches) and the palette ranking (`rankCommands`), ported from the TS core with the same results and messages.
  - Shortcut chords are formatted per platform.

  **`PixerateVector`, a new target**
  - **Document model:** `VectorDocument`, `VectorNode`, `VectorSymbol`, `VectorSubpath`, `VectorAnchor`. It reads and writes documents exactly as the TS core's `toJSON` does: key order, omitted keys, and unknown members kept.
  - **Geometry:**
    - anchors ↔ Bézier;
    - SVG path data;
    - live corners;
    - bounds, transforms and anchor edits;
    - the shape builders.

  Both are checked against vectors written by the TS core.

## 0.14.0

### Minor Changes

- 8827291: Swift paint editor: brush pack import. `importBrushPack` / `readBrushPack` read Photoshop `.abr` (versions 1, 2, 6, 7 and 10) and Procreate `.brush` / `.brushset` packs into brushes and image sources, with the `unsupported` list and licence notes, through defensive `.abr`, ZIP and binary plist readers; the `import_brush_pack` tool adds them to the library in one import. The `brush-pack-import` paint scenario passes, so no paint scenario is skipped in Swift any more (#646).

## 0.13.0

### Minor Changes

- 879a492: Swift paint editor: stamp tips (editor stamps and image sources) in the dab, pick-up, spray and particle paths, image brush sources (`BrushLibrary.addSource` / `listSources` / `getSource`, `sources` in library files, the `add_brush_source` and `list_brush_sources` tools, unknown `source:` refs refused), tip grain (`tip.grain`: texturised and moving, scale, depth, contrast, invert), `dynamics.count` and `dynamics.flip`, the `tipGrain` / `dabCount` profile capabilities, and `brushSources` in saved paintings. Stamp tips are now in `PaintEditorView`'s brush picker. The `brush-tips-and-grain` and new `stamp-tips` paint scenarios pass (#646).

## 0.12.0

### Minor Changes

- 7f04a07: Add `PixerateGeometry`, the Swift port of the vector editor's path operations (#621): the Bézier path model, curve-preserving booleans with the polygon fallback, stroke outlines, the planar map, Pathfinder, hatching, curve fitting and shape geometry, checked against test vectors from the TS core. `JSONValue.jsNumber` is now public.

## 0.11.0

### Minor Changes

- de3ed2e: Play `stroke_path` through `PaintDirector` when a director is passed (`{ kind: 'strokes' }`), pacing each subpath with the agent cursor and committing all subpaths as one undo step, `PaintEditorController.group` now accepts an async function (the step stays open, refusing other changes, until it settles; changes after an `await` go through its `within` argument), and add `speed` (`0.01..100` px/ms) to `samplePath` and `stroke_path` (#587).

### Patch Changes

- b5b703d: Vector brushstrokes paint with wet, mixer, smudge and blender brushes and with gradient paint (#519). Wet paint (watercolour, gouache, wet oils) runs the wet simulation in the stroke's own area for a fixed number of steps and dries, so the result is the same on every render; the scene shows the paint as laid while it settles in the background (`onVectorBrushstrokesSettled`, `settleVectorBrushstrokes`), and SVG and PDF exports wait for it. The Mixer Brush, smudge and blender act on a CPU backdrop of the fills, strokes and brushstrokes beneath the stroke (`rasterizeVectorBackdrop`), re-rendered when anything beneath changes. Gradient paint is sampled dab by dab along the path: the new `brush.paint` on a brushstroke (`vector.addBrushstroke` / `vector.setBrushstroke` `paint`; `velocity` and `time` mappings are refused), a gradient layer paint laid along, across or within the stroke, or a brush's own gradient. `VECTOR_PROFILE` now admits wet surfaces, the Mixer Brush reservoir and the blender and smudge tools.

  Swift: `VECTOR_PROFILE` matches (wet surfaces, the reservoir, blender and smudge tools).

## 0.10.0

### Minor Changes

- a7d3f4f: **Swift:** wet paint steps about 15× faster, with the same bits (#607). On an M4 Pro, a fully wet 2048² canvas now takes 15 ms a step instead of 223 ms.

  - **Threads:** `WetWorld` steps tiles on every core and refills their halos the same way. `WetWorld.threads` changes only the speed.
  - **SIMD:** each tile steps four cells at a time in a new C target, `PixerateWetKernel`, the counterpart of the core's WebAssembly SIMD kernel.
  - **Same results:** saved paintings, exports and conformance results are unchanged. Tests compare the SIMD kernel with the scalar one, and several threads with one, bit for bit.

## 0.9.2

### Patch Changes

- 69f399c: Brush thumbnails preview multiply light brushes (the highlighter) on their paper, as the TypeScript core does. `update_brush` keeps facets the host can't use that the brush already had (`kept`), matching the TypeScript tools (#612).

## 0.9.1

### Patch Changes

- c4ecc8d: **Paint editor (TypeScript core and Swift):**

  - **`set_effect_playback` keeps the setting a call leaves out.** `{ playing: false }` keeps the frame rate, and `{ fps: 12 }` keeps the play state. Before, the setting left out was unset (#602).
  - **`export_high_res` works on paintings with stroke-mapped effect paint.** The replay now renders the effect paint the scaled strokes ask for, so a 2× export no longer fails with "is not rendered at this canvas size" (#603).

## 0.9.0

### Minor Changes

- 0c3b944: Add `PixerateMarkdown`, the Markdown engine shared with Swash (#546), as a Foundation-only library product. It has a CommonMark 0.31.2 + GFM parser with exact source ranges for every node and syntax marker, the HTML renderer, HTML → Markdown paste conversion (on iOS too), the code highlighter, outlines and statistics. It also has the editing engine on raw Markdown: format toggles, links, list continuation, indent / outdent, Backspace and math braces, plus the format-command manifest from `@pixerate/markdown-conformance`. Its tests run the CommonMark and GFM spec examples and the shared Markdown editing corpus.

## 0.8.1

### Patch Changes

- af0e180: Sticker provider contract additions (#488):

  - **AI-generated art.** `StickerSummary.aiGenerated?: boolean`; `checkStickerProvider` rejects a value that isn't a boolean. `find_stickers` and `describe_sticker` return it, and the React and Svelte `StickerLibraryPicker` label such art "AI".
  - **Light / dark variants.** `StickerSummary.variants?: ("light" | "dark")[]` (always with `light`) and `load(id, { variant })`, defaulting to `light`. A variant the sticker lacks is refused with an `unsupported_variant` `StickerError` that names the ones it has (`checkStickerVariant` does it for providers). The old, unused `StickerDescription.variants` (`{ id, name }[]`) is replaced by this field. `insert_sticker` takes `variant` and otherwise uses the dark art when the host's background is dark (`dark` option on `createVectorStickerHost`, `createImageStickerHost` and `createCanvasStickerHost`), and returns the variant used. The paint editor's sticker brush sprays dark variants on a dark colour scheme, and each sticker keeps the variant it was drawn in (`Sticker.variant`).
  - **Collections.** `StickerSummary.collection`, `StickerSearchOptions.collection` and an optional `listCollections()`. `combineStickerProviders` namespaces collection ids as `provider:collection`. `find_stickers` filters by `collection` and returns the collections, the `StickerBrowser` has `setCollection`, and the pickers show a collection filter.
  - The fake provider has AI-generated stickers, dark variants and collections to test against.
  - Swift: `find_stickers` takes `collection` (from the regenerated contract) and refuses it, as the editor's own stickers are in no collection.

## 0.8.0

### Minor Changes

- 9347e94: **Swift:** Metal now shades the display of large wet areas (#604). With `set_wet_engine` `auto` (the default) and at least `minTiles` live tiles (16), `WetMetalEngine` shades every stale wet tile in one command buffer. It reads the CPU engine's tiles in place on shared memory, so nothing is uploaded. A fully wet 2048² canvas shades in 10 ms instead of 119 ms on an M4 Pro.

  - **Results are unchanged.** The CPU engine stays the authority, so drying, saving, export and replay are byte-identical with the GPU on or off. The display stays within 1/255 of the CPU's.
  - **Engine reports:** `set_wet_engine` and `get_wet_paint` now report the engine's real state (`not-started`, `standby`, `active`, `unavailable`, `failed`, `off`) and the GPU's name.
  - **Shader source:** the kernel is the core's `WGSL_SHADE`, translated to Metal by `pnpm gen:msl` (naga).

  **Core:** the `set_wet_engine` and `get_wet_paint` descriptions now say that Engine B is WebGPU in browsers and Metal in the Swift editors.

## 0.7.0

### Minor Changes

- 5c9669f: The Swift paint editor paints wet media (watercolour, gouache, wet oils and the wet tools on the TypeScript wet kernel's maths, bit-exact), thick paint lit at render time, light paint with rim, clarity and spill, and metallic and backlit paper. Agents get the wet, thick and light tools; `PaintEditorView` gets wet, light and spill panels and ticks the simulation. All 23 paint conformance scenarios pass.

## 0.6.0

### Minor Changes

- a2eed75: The Swift paint editor writes PSD files (`exportPsd`, `export_psd`), exports time-lapses and high-resolution repaints (`export_time_lapse`, `export_high_res`), paints with the particle and bristle brushes, and takes provider effects through `EffectProvider` (with `FakeEffectProvider`): effect paper, effect layers, effect fills, light baked onto dried paint and effect paint, with every `paint-effects` tool (`createPaintEffectsToolProvider`). Sticker brushes spray the editor's stickers onto sticker layers, and the sticker tools place, pick, change, arrange and remove them (`EditorStickers`, `Sticker`). `PaintEditorView` gets an Export menu (PNG, PNG at 2×, PSD) and particle, bristle and sticker brushes in its brush picker. 21 of the 23 paint scenarios now pass in Swift.

## 0.5.0

### Minor Changes

- ab3c272: Add `PixeratePaintUI`, the native paint editor UI for macOS 14 and iOS 17. It has:

  - `PaintEditorView`, which puts the toolbar, the brush column, the canvas and the colour, paper, layers and layer-style panels together;
  - `PaintCanvasView`: CoreGraphics drawing with zoom, pan, rotation and mirroring, tile-by-tile redraw, and guide overlays;
  - input from the mouse, trackpad and tablet on macOS, and from touch and Apple Pencil on iOS (pressure, tilt, roll, coalesced and predicted touches, palm rejection);
  - panels rendered from the generated contract tables, and keyboard shortcuts from the contract commands;
  - `PaintEditorModel`, an observable view model. It owns the editor's agent `ToolRegistry`, so changes made by agents and by the user both show up.

  `PaintEditorController` gains change notifications (`subscribe`), live strokes from pointer input (`beginStroke`, `PaintLiveStroke`), `compositeTiles`, `swapColors`, `brushes` / `canPaint` and `liveStrokeArea`. `PixeratePaint` also adds view and pen-input helpers: `screenToDocument`, `documentToScreen`, `fitZoom`, `pointerToPenPoint`, `isPalmTouch`, and the guide-line functions.

  New demo: a macOS app in `apps/swift-demo` (`swift run --package-path apps/swift-demo`) with an agent panel that connects the editor to `pixerate-mcp-bridge`.

## 0.4.0

### Minor Changes

- d948b60: Port the paint editor's dry engine to Swift (`PixeratePaint`, #540). It runs on `PixerateRaster` and passes 16 of 23 paint conformance scenarios pixel-exactly. It includes `PaintEditorController` (canvas, paper, layers, fills, undo / redo), dry brushes with paper grain and pen dynamics, blenders, smudge and the Mixer Brush, recorded strokes, replays, brushed paths and live stroke layers, symmetry, perspective and stencils, tracing and reference images, harmonies, swatches and the mixing pad, light paint from dry brushes, layer styles, saved documents and PNG export, paint proposals, and the brush library. The agent tool providers serve the tools that are ported. `PaintConformanceHost` runs the scenarios.

## 0.3.0

### Minor Changes

- 8579396: Swift generated from the contracts (#537). `scripts/gen-swift.mjs` (`pnpm gen:swift`) writes `PixeratePaint/Generated/`: `PaintToolName` (every paint tool and its provider), an `…Arguments` struct per tool with `paintToolArguments(_:_:)`, `PaintCommandID`, `PaintUITables` and `PaintContractVersions`. The new `PixerateContracts` target bundles `@pixerate/conformance` (contracts and recorded scenarios) as resources, and `PaintContracts` reads the paint contracts. `PixerateCore` can read tool definitions, providers and commands from contract JSON (`McpToolDefinition(json:)`, `ToolProviderContract`, `ShortcutCommand`) and typed tool arguments from a `JSONObject`.
- 8579396: Swift conformance runner and CI (#538). The new `PixerateConformance` target replays a domain's recorded scenarios against a `ConformanceHost`, with the same normalization rules as the TypeScript runner, and compares results, documents and pixels (with its own PNG decoder for straight RGBA). `swift test` replays every paint scenario and reports passed, failed and skipped counts; until the paint editor is ported (#540), every paint scenario is marked `skip.swift`. A new Swift workflow checks the generated Swift and builds and tests on macOS and in an iOS simulator.
- 8579396: Swift port of the raster module (#539). The new `PixerateRaster` target (Foundation only) is a faithful port of `@pixerate/editor/raster`: tiled copy-on-write surfaces with 16- and 32-bit deep samples, every blend mode including pigment mixing and the painterly modes, Gaussian blur, curves, transforms and mesh warps, the cached per-tile `RasterCompositor` and the float `DeepCompositor` with editor profiles, all ten layer effects with their model, validation and panel view model, patterns, the synchronous PNG and zlib codec, and the viewport maths. It produces the same pixels and the same PNG / zlib bytes as the TypeScript core: `packages/core/tests/swift-raster-vectors.test.ts` writes `Tests/PixerateRasterTests/Fixtures/raster-vectors.json` and the Swift tests reproduce every vector. JavaScript's number semantics are ported along with it (`JS`: `Math.round`, `Uint8ClampedArray` stores, and V8's fdlibm `exp`, `log2`, `cbrt`, `sin`, `cos`, `atan2`, `hypot`).

## 0.2.0

### Minor Changes

- 344d1ae: Swift editors can be driven over the MCP bridge (#542). `ToolBridgeClient` in `PixerateCore` connects a `ToolRegistry` to `pixerate-mcp-bridge` (protocol 1, token in `?token=`, `URLSessionWebSocketTask`), sends the tool list on connect and when it changes, answers calls through `callTool` (cancelled calls send no result) and reconnects with back-off, as `connectToolBridge` does in TypeScript.

## 0.1.0

### Minor Changes

- 58047bd: Swift generated from the contracts (#537). `scripts/gen-swift.mjs` (`pnpm gen:swift`) writes `PixeratePaint/Generated/`: `PaintToolName` (every paint tool and its provider), an `…Arguments` struct per tool with `paintToolArguments(_:_:)`, `PaintCommandID`, `PaintUITables` and `PaintContractVersions`. The new `PixerateContracts` target bundles `@pixerate/conformance` (contracts and recorded scenarios) as resources, and `PaintContracts` reads the paint contracts. `PixerateCore` can read tool definitions, providers and commands from contract JSON (`McpToolDefinition(json:)`, `ToolProviderContract`, `ShortcutCommand`) and typed tool arguments from a `JSONObject`.
- a333203: Swift conformance runner and CI (#538). The new `PixerateConformance` target replays a domain's recorded scenarios against a `ConformanceHost`, with the same normalization rules as the TypeScript runner, and compares results, documents and pixels (with its own PNG decoder for straight RGBA). `swift test` replays every paint scenario and reports passed, failed and skipped counts; until the paint editor is ported (#540), every paint scenario is marked `skip.swift`. A new Swift workflow checks the generated Swift and builds and tests on macOS and in an iOS simulator.
- b8f7180: Swift scaffold: the root `Package.swift` and `PixerateCore` (Foundation only), ported from the TS core and checked against its outputs.

  - The `pixerate.editor-document` envelope with step-by-step migrations and load reports.
  - Undo / redo with gestures, marks, batches, origins (`user` / `agent:<id>`, `withOrigin`, sync and async) and `onCommit` events.
  - The seeded RNG, bit-exact with `paint/rand.ts`.
  - JSON Schema validation with the TS messages.
  - `ToolRegistry` with MCP-shaped results, middleware and `originMiddleware`.
