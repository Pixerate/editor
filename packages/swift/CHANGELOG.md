# @pixerate/swift

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
