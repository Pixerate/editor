# @pixerate/conformance

## 0.5.0

### Minor Changes

- 23c5e5a: Text mechanics (#892): typography, Markdown still being typed, and a fuller chat profile, moved from Swash's open pull requests into the editor.

  - New checks, off unless the host turns them on (`TEXT_MECHANICS_OFF_BY_DEFAULT`): `curly-quotes` (straight quotes and apostrophes become curly in prose, including in the apostrophes other fixes write), `dashes` (`--` and `---` between words become en and em dashes, never a `--flag`), and `ellipses` (`...` → `…`).
  - Markdown still being typed is left alone: a table row before its delimiter row, a link reference definition, a link or image address not yet closed, and front matter not yet closed.
  - The `chat` profile leaves chat shorthand (`lol`, `idk`, `tbh`…) to the writer, skips spelling corrections that only change case, never touches Slack syntax (`<@user>`, `<!here>`), and runs no typography.
  - 19 new typing scenarios in `@pixerate/conformance`; the Swift port in PixerateMarkdown reproduces them all.

## 0.4.0

### Minor Changes

- 8445ba8: Text mechanics checks for Markdown text (#892): the small, certain fixes a writer expects as they type, moved from Swash's writing partner into the editor so every Pixerate editor can use them.

  - `textMechanicsEditsAt(text, boundary, options)` (`/tools`): the fixes after a word boundary is typed. Capital I, missing apostrophes (`its`, `id` and `ill` only where a word-class tagger reads them as contractions), sentence capitals, a full stop or question mark at the end of a finished line, `OK`, a comma before a "but" that starts a clause, and spelling from a checker the host supplies. Code, math, HTML, tables, links' addresses and URLs are never changed. A `chat` profile turns the prose-only checks off for Slack. `textMechanicsFindings` checks a whole text as if it had been typed, and `textMechanicsCheckedRange` gives the range being checked.
  - `markdownProseMap(source)`: where the prose is in Markdown source.
  - `createTextMechanicsToolProvider(host)`: `check_text_mechanics` and, when the text can be edited, `fix_text_mechanics` (one undo step).
  - `@pixerate/conformance`: a new `text-mechanics` domain with 80 typing scenarios, checked ranges and whole-text findings, exported by `textMechanicsContracts()` and checked by a core test.
  - Swift (`PixerateMarkdown`): `TextMechanics` reproduces every scenario over `MarkdownDocument`, with `naturalLanguageTagger` for Apple's NaturalLanguage tagger.

## 0.3.0

### Minor Changes

- 2f668f9: Agents' edits to text can be drawn with a text treatment from the effects provider (#887).

  - Effects contract (`/effects`): a `text-treatment` kind and use. A provider with `capabilities.supportsTextTreatments` implements `textTreatmentPlan(id, { stage, time, target, reduceMotion? }, values?)`, which returns a layer plan for one stage of an edit (`caret`, `checking`, `selecting`, `typing`, `landed`) over the host's line rectangles. `defaultTextTreatment` names the one editors use until one is chosen. Also new: `checkTextTreatmentRequest`, `textTreatmentPlanProblems`, `planTextTreatment`, and conformance checks in `checkEffectProvider`. `createFakeEffectProvider({ textTreatments: true })` adds `fake.soft` and `fake.underline`.
  - `builtInTextTreatmentPlan` is the built-in treatment: the editors' current look, plus a soft sweep while checking. Hosts draw it when there is no provider.
  - `planAgentTyping` takes `edit.check` and `checkMs` (default 480): a `check` step before the selection, which a treatment draws as its checking sweep. `typeAgentText` takes `check` too.
  - Rich text: `setAgentTextTreatments(editor, { provider, treatment?, reduceMotion? })` draws each agent's stages in an overlay behind and above the text. Each agent can choose its own treatment (`AgentCaretInput.treatment`, the rich-text tools' `presence.treatment`) and is drawn in its own colour. Reduce Motion is followed. Without a provider that has treatments, carets are decorations as before. `AgentCaret` now has its `stage`.
  - React and Svelte: effect thumbnails label text treatments.
  - `@pixerate/conformance`: the `agent-text` domain gains `treatment-plans.json` (the built-in treatment's plans) and plans with a check step.
  - Swift (`PixerateCore`):
    - `AgentTypingStep.check`, `AgentTextEdit.check` and `AgentTypingOptions.checkMs`.
    - `AgentCaretStore` keeps each caret's stage, the range it checks or has typed, and when its stage began and its changes landed.
    - `AgentTextDirector` takes a `treatment` and records each stage.
    - `TextTreatmentPlan` and its types, `TextTreatmentProvider`, `BuiltInTextTreatment` (matches every plan in the contract), and `AgentTextTreatments.plans`, which turns the carets into plans for a `TextTreatmentRenderer`.

## 0.2.1

### Patch Changes

- c0ecb5a: Particles and relief in the chart's 3-D view, so agents can set them (#806, #807).

  - `ChartView3d` takes `particles` (`{ unit, order }`) and `relief` (`{ amount, scale, octaves, seed }`). `update_chart` `view3d` sets them; later updates merge into them, and `null` turns either off. Values out of range are refused with what fits (`view3d.relief.amount must be a fraction from 0 to 0.25.`); unknown fields are named.
  - `createChart3dScene` / `renderChart3d` draw a chart's own `view3d.particles` and `view3d.relief`, unless the host passes `particles` or `relief` itself.
  - Office files keep the 3-D view and say particles and relief were left out.
  - The chart skill's `update_chart` row and the "decoration is not data" note cover them; the `view3d` conformance scenario sets, merges, refuses and clears them.
  - Swift: `ChartView3d` keeps `particles` and `relief`, normalised and merged the same way, so documents round-trip.

## 0.2.0

### Minor Changes

- 67c1713: Agents' text edits play out the same way in TypeScript and Swift (#878).

  - `planAgentTyping(edit, options)` (`/tools`): the pure planner behind `typeAgentText`. It selects what an edit replaces, types it in ~30 fps frames (60 characters a second, at most 1.5 s), then commits. It knows no editor. `typeAgentText` now takes its timing from it, with no change in behaviour. `agentTypingDuration`, and the defaults as constants.
  - `@pixerate/conformance`: a new `agent-text` domain (`manifest.json`, `typing-plans.json`) with the plans for a set of edits, exported by `agentTextContracts()` and checked by a core test.
  - Swift (`PixerateCore`):
    - `planAgentTyping` reproduces every plan in the contract.
    - `AgentTextDirector` plays an edit on any `AgentTextTarget`: the agent's caret selects the range, the typing shows as previews outside the undo history, the original goes back, and the edit commits as one undo step. Calls run one after another per agent. An edit by the person inside the range (`noteEdit`), an unreported change, or cancelling stops the call and leaves the text as it was.
    - `AgentCaretStore`: carets, selections and changed-text tints for a host to draw, mapped through other people's edits.
    - `PresenceClock`, with `RealPresenceClock` and `InstantPresenceClock`.

### Patch Changes

- 39fce31: Paint editor: pixel layers whose pixels the stroke log can't rebuild stay marked `unlogged` after reopening, whatever saved the document (#720).

  - Saves keep the `unlogged` marks whenever there are any (not only with dual-colour strokes), and add `unloggedComplete: true` when the save keeps the stroke log and the marks are known to be complete. The saved file is the same in either colour scheme.
  - A document opened without that flag (saved before the marks, or without its log) marks each pixel layer with pixels that no logged stroke or event names at once ("Opened from an older document", "Opened without its stroke log"). A layer the log does name is checked the first time the colour scheme needs it: the log as opened is replayed in the background (the frozen scheme replay, every stroke as recorded) and compared with the opened pixels, within 8/255 per premultiplied channel and leaving out paint the replay still has wet. A layer that doesn't match keeps its colours instead of losing its imported or merged pixels in the other scheme.
  - Documents saved by #843 with marks but without the flag are checked the same way for their unmarked layers.
  - `get_color_scheme_view` reports a layer being checked as `replay` `building` with a `reason`, then `ready` or `kept` with why. The check is view state: it is never saved or undone.
  - Swift: the same saving, opening and check (`SchemeReplay(frozen:)`, `openLedger`, `runOpenedCheck`). Conformance: new `color-scheme-older-document` scenario; saved documents in the recorded scenarios gain `unloggedComplete`.

- 4190f16: Paint editor: replays of wet paint keep to the wet clock it was painted at, across pen-up, saves and sessions (#720), so the other colour scheme of a reopened wet painting matches painting it fresh in that scheme.

  - A wet stroke whose pen lifted after the simulation ran on past its last point records the clock its end was applied at (`RecordedStroke.endStep`, saved only then). The colour-scheme replay (live and after a reload), `renderHighRes` and the time-lapse step to it before ending the stroke.
  - Paint that flowed on after the last logged stroke or event is replayed after a reload: saves write the wet clock (`wet.clock`) when it is past the latest clock the saved log records, inline and through the asset store. `renderHighRes` and the time-lapse of the live painting let the paint flow on to the editor's clock too.
  - The wet clock no longer starts again at 0 when a document is reopened (or when the simulation is made again after a resize or a new canvas): it goes on from the saved clock (else the log's latest), so strokes of a later session come after those of an earlier one. Before, the scheme view of a document painted across sessions never got ready (its replay rolled back for ever). The opened log ends with a `dry` of every layer at that clock (the save dried the paint there), which a save of the unchanged document doesn't write.
  - Documents saved before this, painted across sessions (clocks that start again at 0), are put in order when opened: a `dry` at each session break, and the later session's clocks moved to go on from the next multiple of the wet free interval. Documents without these cases keep their pixels and saved files.
  - Swift: the same recording, saving, opening and replays. Conformance: new `color-scheme-wet-clock` scenario.

## 0.1.7

### Patch Changes

- 228e72e: House style for 3-D charts (closes #810). The chart profile (`chart.json`) takes a `three` section, so a brand restyles 3-D pictures the way it restyles flat ones:

  - `materials`: `mark` (bars) and `ribbon` (lines and areas; `transmission` for glass) with roughness, metalness, opacity and transmission; `floor` and `wall` with a `color` too; a `highlight` glow on focused marks.
  - `light`: a `preset` (`studio`, the default; `soft`; `rim`; `flat`) with `intensity` and an optional key `azimuth` / `elevation`.
  - `shadow` (`enabled`, `softness`), `ambientOcclusion` (contact darkening under bars) and `background`.
  - `version: 1`. A profile without the section, or with an empty one, draws exactly as before; a section from a newer version is refused with a message. Colours take `$token` references like the rest of the profile.
  - `resolveChart3dStyle`, `DEFAULT_CHART_3D_STYLE`, `CHART_3D_LIGHT_PRESETS`, `CHART_3D_STYLE_SCHEMA` (`/chart`); `Chart3dOptions.style` for `createChart3dScene` and `renderChart3d`, which expose the resolved `style` and `background`.
  - Checks: `three-contrast` (label text against the 3-D background and floor, palette against the floor and wall; only charts with a 3-D view), and `checkChart3dLabelContrast(labels, sample)` (`/three`) for the rendered picture.
  - The style-authoring skill has a 3-D recipe. Demo: two house styles (Matte paper, Glass night) on the Charts tab's 3-D view.
  - Swift: the chart profile reads the `three` section and runs `three-contrast` the same way; the chart style scenarios are re-recorded with the new check in their messages.

## 0.1.6

### Patch Changes

- be1ee7f: Tool argument validation (`validateJsonSchema`) no longer treats `Object.prototype` names such as `toString` or `constructor` as declared properties or present required ones: with `additionalProperties: false` they are reported as unknown properties (#766).

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
