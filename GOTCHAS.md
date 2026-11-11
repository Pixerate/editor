# Known Gotchas, Pitfalls & Solutions

This document tracks known issues, framework quirks, edge cases, and pitfalls encountered across `@pixerate/editor` packages, along with their solutions and workarounds.

All contributors and AI assistants should check this file before starting work and update it whenever discovering a new issue or solution.

---

## Template for New Entries

```markdown

### [Scope/Area] Brief description of the issue

- **Issue / Symptom**: What goes wrong or behaves unexpectedly.
- **Root Cause**: Why it happens (e.g. ProseMirror transaction lifecycle, Svelte reactivity timing, Tailwind reset conflicts, bundling issues).
- **Solution / Workaround**: How to resolve it or avoid it.
```

---

## Entries

### [monorepo] Vitest Says "Cannot find native binding" When an Intel Tool Launches It on Apple Silicon

- **Issue / Symptom**: `vitest run` fails at startup with `Cannot find native binding … Cannot find module '@rolldown/binding-wasm32-wasi'`, although `@rolldown/binding-darwin-arm64` is installed and loads in plain `node`.
- **Root Cause**: A process started by an x86_64 binary (for example an Intel Homebrew `/usr/local/bin/timeout` wrapped around the command) runs a universal `node` under Rosetta, so `process.arch` is `x64` and rolldown looks only for the x64 and WASI bindings.
- **Solution / Workaround**: Run vitest directly (or under `arch -arm64`), not through an Intel wrapper. Check with `<wrapper> node -p process.arch`.

### [core|swift/paint] Sticker Spacing and Scatter Stop Growing at `STICKER_REACH`

- **Issue / Symptom**: Large sticker brushes (200 px) landed stickers ~140 px apart and up to ~120 px off the stroke, so they no longer traced the path.
- **Root Cause**: The spray's spacing and scatter were fractions of the sticker's diameter, so both grew without limit with the size.
- **Solution / Workaround**: Both scale with `min(diameter, STICKER_REACH)` (64 px), and `PenDabWalker.layEnd` lays a last sticker at the stroke's end. Keep any change to these in step in `paint-editor/stickers.ts` and `Stickers/Stickers.swift`: the conformance scenario `sticker-large-sizes` records the positions.

### [swift] A `nil` in a Ternary Becomes `JSONValue.null`

- **Issue / Symptom**: After a source edit dropped an authored effect's paint hint, the exported Swift document had `"paint": null`, and reopening it was refused (`/paint: must be an object`); TS left the field out.
- **Root Cause**: `JSONValue` conforms to `ExpressibleByNilLiteral`. In `cond ? value : nil` (or a `flatMap` closure returning it) where `value` is a `JSONValue`, the `nil` is typed as `JSONValue.null`, so the result is `.some(.null)`, not `Optional.none`. Assigning that to a `JSONObject` key writes `null` instead of removing the key.
- **Solution / Workaround**: Give the variable an explicit `JSONValue?` type and clear it with `Optional<JSONValue>.none` (as the codebase does elsewhere), or use `if let` instead of a ternary. Treat any `nil` next to a `JSONValue` as suspect.

### [core|swift/paint] Effect Paint Hints: Filter Only With the Capability, Re-Paint With an Explicit Map

- **Issue / Symptom**: (1) Giving the fake provider's effects paint hints unconditionally changed every existing effect paint test and recording (the hint's stroke map and colours applied). (2) Changing the effect paint's values (`update_effect`, the panels' controls) after picking a hinted effect would put back the hint's map, undoing "fixed to the canvas", because a canvas paint has no `map` and `setEffectPaint` applies the hint's map whenever `map` is missing.
- **Root Cause**: A hint is a starting point applied by `setEffectPaint` when the caller leaves a field out; callers that repaint with the paint's current settings leave `map` out for canvas paint.
- **Solution / Workaround**: (1) `createFakeEffectProvider({ paintHints: true })` / `FakeEffectProvider(paintHints: true)` adds the hints and the capability together; scenarios ask for it with `setup.effectPaintHints`. (2) Every repaint passes `map: paint.map ?? { by: "canvas" }` and `live: paint.live ?? false` (React and Svelte `PaintEffectsPanel`, `update_effect` on the paint, Swift `repaintEffect`). Hints sit on `EffectSummary`, so list and search can filter without describing every effect; `checkEffectProvider` reports a summary whose hint differs from its description.

### [core|swift/effects] Name Lookups in Plain Objects Match `Object.prototype` (and Wall-Clock Budgets Stay Out of Tool Results)

- **Issue / Symptom**: In pixel expressions, `let toString = 1` was refused as "a built-in value", and `toString(1)` reported a nonsense argument count, while Swift accepted both. Separately, a `save_authored_effect` result with the trial render's milliseconds made the conformance recorder fail as "not deterministic".
- **Root Cause**: `name in PIXEL_BUILTINS` (and `PIXEL_FUNCTIONS[fn]`) also finds inherited keys such as `toString` and `constructor`. Timings depend on the machine.
- **Solution / Workaround**: Look names up with `Object.hasOwn` (or a `Map`) in any table that user text indexes. Keep timing-based checks (trial render, live frame budget) as pass/refuse decisions with a message, never as numbers in a recorded result. Tests reach the budget paths with a limit of 0 (`authoredEffectLimits: { trialRenderMs: 0 }`), which every render meets or exceeds.

### [core|swift/paint] Authored Effect Ids Never Change What They Draw

- **Issue / Symptom**: If saving an edited authored effect replaced the old one under the same id, effect paint pixels cached by `effectPaintKey` (effect id and values), baked effect layers and strokes painted earlier would disagree with the document after a reload, and undo couldn't bring the old look back.
- **Root Cause**: Every cache in the paint editor keys effects by id, on the assumption (true for provider catalogs) that an id always draws the same thing.
- **Solution / Workaround**: `save_authored_effect` always adds a new id (`authored.<name>`, `-2`, `-3`, …), and `remove_authored_effect` is refused while anything uses one. The authored effects provider is rebuilt whenever `doc.authoredEffects` changes identity (save, remove, undo, load), which also clears the authored renderer's description cache. Keyframed controls are left out of the description where the effect is used, since paint passes every control value and would otherwise pin them.

### [swift/paint] Authored Pixel Effects Render on the CPU, Except Frames the View Shows

- **Issue / Symptom**: Drawing authored (pixel expression) effects with `PixelMetalRenderer` everywhere made effect paint, layers and exports differ from the TS evaluator by a level or two, and a live frame shown on the GPU could be reused by an export at the same moment (`renderAnimationFrame`, `withEffectTime`), because rendered effect paint is cached by `PaintEffectPaint.key`, which says nothing about how it was rendered.
- **Root Cause**: Metal works in `float`; the TS evaluator (and `PixelCPURenderer`) in doubles. Conformance compares pixels with a tolerance of 2 per channel, but strokes, fills and saved PNG hashes compound small differences.
- **Solution / Workaround**: Everything that ends in the document, an export or a replay renders on the CPU. Only live view frames (`showEffectTime`, while `timingLiveFrames` is set) use Metal, when `authoredEffectsGPU` is on (default) and `PixelGPU.isAvailable`; their keys go into `gpuFrameKeys` and are dropped from the cache as soon as the frame is drawn (`dropGPUFrames`). The conformance host and replay targets turn `authoredEffectsGPU` off. The paint tool provider lives in `Editor/PaintEffectAuthoringTools.swift`: SwiftPM refuses two files with the same name in one target, and `Effects/EffectAuthoringTools.swift` already holds the shared handlers.

### [swift/paint] Live Effect Frames Must Not Refresh the Panels, and the Player Re-anchors Only on Paused Ticks

- **Issue / Symptom**: (1) Playing live effect paint in `PaintEditorView` re-evaluated every panel on every frame, and marking frames "quiet" around `await player.tick` also hid real changes an agent or the user made while a frame rendered. (2) A test that paused, waited, then resumed saw the moment jump forward by the paused time.
- **Root Cause**: (1) Frames reach the model through the controller's ordinary `subscribe` listeners, and an effect frame renders asynchronously, so a model-side flag spanning the `await` covers other emits too. (2) Like `playEffects` in TS, `PaintEffectPlayer` moves its start time only on ticks that arrive while paused (the view ticks every frame, so the gap is one frame); a caller that stops ticking while paused skips that.
- **Solution / Workaround**: (1) The controller sets `emittingViewFrame` only around the frame's own `emit` in `showEffectTime`, and `PaintEditorModel.changed()` skips the panel revision for it; the canvas still redraws. (2) Keep ticking while paused (`runEffectClock` does); tests tick through the pause. Frames are view state (`effectFrames`, dropped when their layer's committed surface changes), so an export without `time` draws the frame on show, as in TS; pass `time` (or use `withEffectTime`) for a fixed moment.

### [swift] A `public struct` Without an Explicit `public init` Can't Be Built by Hosts

- **Issue / Symptom**: Code outside the module fails with "initializer is inaccessible due to 'internal' protection level" when building an options struct such as `ReplayOptions(strokeIds:)`, so the public method that takes it (`replayStrokes`) is unusable. The package's own tests never notice (#747).
- **Root Cause**: Swift's implicit memberwise initializer is always `internal`, even on a `public struct` with all-`public` fields. Test targets use `@testable import`, which exposes internal symbols.
- **Solution / Workaround**: Give every public struct a host must construct (options, settings, init values) an explicit `public init` with the same labels and order as the memberwise one, `nil` defaults for optionals (as the memberwise one has) and `@escaping` on closure fields. Prove it with a test file that uses plain `import` (`PaintPublicInitTests.swift`, `VectorPublicInitTests.swift`). Result types the module only returns don't need one.

### [swift/paint] Save → Load Conformance: Clocks, Asset Hashes and Fields Swift Doesn't Model

- **Issue / Symptom**: Adding a `reload` step to every paint scenario (save, then `loadJSON`, then compare the document) failed in three ways that were not loader bugs. (1) `culture` was not deterministic between two TS runs. (2) `culture-replay` matched pixels within tolerance but its document differed in one asset reference. (3) A hand-written wet event with a field outside `data` came back in TS but not in Swift.
- **Root Cause**: (1) `cultures.lastGrownAt` is wall-clock time, written on save when `growWhileClosed` is on. (2) Editor-document asset references are content hashes of the PNG bytes (`pixerate-asset:<len>-<hash>`), so a layer one level off anywhere changes the reference even though pixel comparison tolerates it. (3) TS keeps a saved event object verbatim; Swift's `WetEvent` / `PaintEvent` keep only the fields they model (`clock`, `at`, `kind`, `layerId`, `data`).
- **Solution / Workaround**: Leave `document` off a reload step whose document carries a clock (`culture`) or whose pixels already differ within tolerance (`culture-replay`); keep `pixels` and `expect.loaded` on it. Write test documents in the schema's shape (event payloads under `data`). Any other document difference after a reload is a real loader gap. The cross-implementation comparison only proves a feature survives saving because each side also checks its own save → load → save at every reload step (the save after reopening equals the save opened, same pixels; `lastGrownAt` aside): `reopens what it saved unchanged` in `paint-conformance.test.ts` and `RoundTripHost` in `PaintConformanceTests.swift`. Those also cover the two reload steps without a document comparison.

### [swift/paint] `loadJSON` Pairs With `toJSON`, Not `editorDocument()`

- **Issue / Symptom**: Opening the output of `editorDocument()` loads every layer empty.
- **Root Cause**: `editorDocument()` replaces each inline PNG with a content-addressed reference (`pixerate-asset:…`) and doesn't carry the bytes; the TS envelope gets them from its asset registry. Swift has no registry or async asset store yet.
- **Solution / Workaround**: Persist `toJSON()` (assets inline) and reopen it with `loadJSON`. External asset stores (`loadJSONAsync`) are not ported.

### [swift/paint] Sticker Drag Previews Rely on Document Identity

- **Issue / Symptom**: A sticker drag (`previewSticker`) must undo in one step from before the drag, but any other change in between must end the preview.
- **Root Cause**: `PaintDocumentState` is a class; the preview keeps `(base, shown)` and is live only while `shown === doc`, as TS compares objects. Setting `doc` normally emits a full redraw, so the preview sets it with `setDocSilently` and emits only the dirty rects.
- **Solution / Workaround**: Commit sticker changes through `commitStickers`, which commits from `previewBase() ?? doc` and clears the preview. Never copy the document between preview and drop (`doc.with { }` makes a new object and ends the preview).

### [core|swift/paint-editor] A Replay Recorded the Active Brush's Id With the Stroke's Brush

- **Issue / Symptom**: After `replay_strokes`, `list_strokes` showed the replayed stroke with `brushId: "pencil-6b"` (whatever brush was active) but `brushName: "Antimatter"`. Seen in `antimatter-fuel-targets`; TS and Swift agreed, so the scenario recorded the wrong id.
- **Root Cause**: Replays pass the whole recorded brush as `PaintStrokeInit.brush` (Swift: `fixedBrush`) with no `brushId`. `strokeBrush` lays per-stroke brush changes over `brushId` or the active brush and stamps that brush's id on the result, which is right for changes but wrong for a whole brush.
- **Solution / Workaround**: `strokeBrush` keeps the given brush's own (valid) id when no `brushId` is passed. When a scenario shows a field that disagrees with its neighbours, check where it is stamped; agreement between ports only proves the port is faithful.

### [swift/paint] `Math.round` Then a Clamped Store Is Not the Same as `JS.u8c` Alone

- **Issue / Symptom**: Once `time-machine.json` scraped real impasto paint, the Swift document after the scraper stroke differed from TS (layer alpha and impasto height off by 1 on a few pixels), though pixels were within tolerance.
- **Root Cause**: TS wrote `u8[i] = Math.round(x)`: `Math.round` rounds .5 up, then the store is exact. Swift wrote `JS.u8c(x)`, which emulates a bare `Uint8ClampedArray` store and rounds .5 to even. They differ only on exact halves, which `a0 * 255 * keep` hits.
- **Solution / Workaround**: Port `Math.round(x)` into a clamped array as `JS.u8c(JS.round(x))`. Use `JS.u8c(x)` alone only where TS stores the unrounded value.

### [core|swift/paint-editor] Catch-Up Work on Mount Misses a Document Opened Later

- **Issue / Symptom**: Biopaint `growWhileClosed` growth caught up when `PaintCanvas` mounted, but opening another document into the same mounted controller showed the culture as saved.
- **Root Cause**: The bindings ran `catchUpCultures()` once in their mount effect, keyed on the controller, which does not change when the document is replaced.
- **Solution / Workaround**: `controller.onDocumentReplaced` fires after `loadJSON` / `loadJSONAsync` / `newCanvas`; `startCultureCatchUp(controller)` catches up now and on each replace (skipping a refusal) and the bindings use it. Swift: `onDocumentReplaced` (fired by `newCanvas`; Swift paint cannot open documents yet) and `PaintEditorModel` catches up on it. Anything else per-document a host does on mount belongs on this signal too.

### [core/paint] Replays Re-derived Editor State That Strokes Read at Paint Time; Settings Outside History Were Lost on Undo

- **Issue / Symptom**: (1) `render_xray { strokes: totalStrokes }` differed from `render_xray` when a hidden or locked layer lay under a scraped one: the replay cut layers the live stroke never touched. (2) `set_age` → `undo_paint` of an earlier stroke reset the age in Swift, and in TS kept it in `get_age` but dropped it from the saved document. (3) The first conformance scenario saving a scraper stroke showed the Swift `migrateBrushV1` writing `medium: "paint"` for scraper brushes, which TS does not.
- **Root Cause**: (1) The scraper picks its layers from current visibility and locks (`collectScrapeableLayers`), and the historical X-ray shows and unlocks every layer before replaying, so the replay derived a different stack. Anything a stroke reads from editor state at paint time and a replay changes must be recorded with the stroke. (2) Undo restores the history entry's document snapshot, which carries whatever `age` it had when the step was made; settings that are not undo steps (`set_age`) must be put back onto the restored document. (3) A gap in Swift coverage: the old time-machine scenario's strokes used unknown brush ids, so no scraper stroke was ever saved in a scenario (`time-machine.json` now paints with real presets).
- **Solution / Workaround**: (1) Scraper strokes record `scrapeLayerIds` (top to bottom) and replays pass them as `PaintStrokeInit.scrapeLayerIds` (`scrapeLayersByIds`); strokes without the field still derive the stack. (2) Undo/redo move the age only when the entry's `before.age` and `after.age` differ (`bake_age`); otherwise the restored document takes the current age (`withAge`), in both TS and Swift. (3) Check that a scenario's steps succeed (not `isError`) before relying on it; `time-machine-history.json` covers these cases.

### [core/canvas] Animated Edge Dots Ignored `keyPoints`, and Glows Hid Straight Edges

- **Issue / Symptom**: Dots on a reversed or back-and-forth edge (`direction: "reverse"` / `"alternate"`) ran source to target anyway, and a glowing beam or pulse on a perfectly horizontal or vertical edge (a `straight` or `step` edge between aligned nodes) did not draw at all.
- **Root Cause**: `<animateMotion>` defaults to `calcMode="paced"`, which ignores `keyPoints` / `keyTimes`. SVG filters default to `filterUnits="objectBoundingBox"`, and a straight line's box has zero height (or width), so the filter region is empty and the element disappears.
- **Solution / Workaround**: `<EdgeAnimation>` (React and Svelte) always sets `calcMode="linear"` on `<animateMotion>`, and `getCanvasEdgeAnimationRender` gives the glow filter a region in user space (`filterUnits="userSpaceOnUse"`, the path's bounds plus a margin for size and glow). Keep both if you render `CanvasEdgeAnimationRender` yourself.

### [core/paint-editor] Dual-Colour Strokes: Light Side in the Document, the Scheme Only in the View

- **Issue / Symptom**: Paint shared between viewers with different themes must show each their own side of a dual colour, and a theme switch must not change, save or sync the document.
- **Root Cause**: A stroke layer's pixels are stored in the document (and in every history snapshot), so redrawing them for a scheme would bake one viewer's theme into shared pixels and make history entries disagree with the view.
- **Solution / Workaround**: The document always draws a dual-colour stroke on a stroke layer with its light side (`RecordedStroke.color` is `dualColor.light`, however it was painted). `currentLayers()` swaps in a per-layer view surface (`schemeLayers` / `schemeSurface`), cached and brought up to date from the strokes added or removed since (whole redraw on a reorder). `beginStroke` paints on that view so the stroke looks right while drawing, then redraws the stroke area for the document on commit (`withLiveStrokes(..., { record: false })`) and keeps what was painted as the view; `runStroke` paints stroke layers in the light side directly (`paintScheme`). Pixel layers bake the side painted: there are no strokes to redraw them from. Exports and PSD use the view; `toJSON` the document.

### [core|swift/paint-editor] A Live-Adjust Gesture Must Only Undo Its Own Commit

- **Issue / Symptom**: Dragging the Fill tool to adjust tolerance (or cancelling the drag) undid the user's previous edit, e.g. a stroke, when the fill itself had painted nothing.
- **Root Cause**: The gesture called `undo()` before each refill on the assumption that the last fill made an undo step. `fillRegion` returns early without committing when its mask is empty (a negative `expand` can erase the whole region) or throws, so the blind `undo()` took back an unrelated step.
- **Solution / Workaround**: Track whether the gesture's last call committed (`committed: result.bounds !== null` in `PaintGesture`, TS and Swift) and only undo when it did. Any gesture that re-applies an operation by undo-and-redo needs the same guard.

### [core|swift/paint-editor] Evolutionary Stroke Mutation Keeps Geometry Scale Separate From Brush Size When `mutation.brush` Is 0

- **Issue / Symptom**: Calling `breed_strokes` with `mutation: { geometry: 0.5, brush: 0 }` changed `brush.tip.size` on the child genome and reported a `tip.size` facet diff even though `mutation.brush` was explicitly set to `0`. Separately, when a host creates `createPaintProposals({ controller })` (`PaintProposals(controller:)` in Swift) alongside `createPaintEditorToolProvider(controller)`, `breed_strokes` and `accept_paint_proposal` would operate on different proposal stores unless linked.
- **Root Cause**: `varyStroke` scales `brush.tip.size` by $\sqrt{|\det(m)|}$ when `scale !== 1`. In addition, `breed_strokes` / `breed_proposal` / `get_proposal_genome` live on `PaintEditorController`, while `accept_paint_proposal` / `reject_paint_proposal` live on `PaintProposals`.
- **Solution / Workaround**: In `mutateStroke` (`evolution.ts` and `Evolution.swift`), restore `stroke.brush.tip.size` after `varyStroke` when `rates.brush === 0`, and round `tip.size` to `0.1` (`roundScale(..., 10)`) before `driftBrushFacets` when `rates.brush > 0`. In `createPaintProposals` and `PaintProposals.init`, call `controller.attachProposals(store)` so `controller.proposals` and the proposal tool provider always share the same pending proposal store.

### [svelte/canvas] `FloatingHorizontalScrollbar` Kept a Stale Position When Its Target Resized Quietly

- **Issue / Symptom**: The bar stayed at its old `left` and `width` after the target changed size. In one host app it stayed 1022px wide while the board it tracks was 1313px wide.
- **Root Cause**: The component measured only on window `scroll` / `resize` and target `scroll`. A target widened by a CSS variable written in an animation frame after the scroll event changes size after the last measurement, and no further event arrives.
- **Solution / Workaround**: A `ResizeObserver` on `targetElement` calls `updateMetrics`. It lives in an `$effect` rather than `onMount` so it follows the prop. It reports size changes only, so a target that moves without resizing still waits for the next scroll or resize event.

### [core/canvas] Proposal Ghosts Stay Hidden in React Flow Unless They Carry a Size

- **Issue / Symptom**: Ghost nodes from `useCanvasProposals().view` were in the DOM with their label but never showed (`visibility: hidden`), and their edges did not draw.
- **Root Cause**: React Flow (and Svelte Flow) hide a node until it has dimensions. In controlled mode the size arrives as a `dimensions` change through `onNodesChange`, which the host applies to its own state. Ghosts are drawn from the proposal store, not the host's state, so that change is applied to nothing and the ghost stays unmeasured.
- **Solution / Workaround**: `withGhosts` gives each ghost `measured` from the size it was placed with (`width` / `height`, else `defaultNodeSize`). The proposal's own nodes keep no `measured`, so an accepted node is measured normally. Any other overlay that renders nodes outside the host's state needs the same.

### [react/canvas] A History Listener Created in `useMemo` Dies Under StrictMode

- **Issue / Symptom**: `useCanvasChangeFeed` reported agent changes as `user` under `<StrictMode>`.
- **Root Cause**: StrictMode runs effect cleanups and then the effects again on the same memoised objects. Disposing the feed in a cleanup removed its `history.onCommit` listener, and the remount reused the disposed feed.
- **Solution / Workaround**: The feed is created without `history`; an effect subscribes `history.onCommit(feed.noteCommit)` and returns the unsubscribe, so the remount subscribes again. Keep subscriptions in effects, not in objects built by `useMemo` / `useRef`.

### [core/history] An Async `withOrigin` Stamps Everything Recorded Until It Settles

- **Issue / Symptom**: With `createOriginMiddleware`, a user edit made while an agent's tool call was running could be recorded as `agent:<id>`.
- **Root Cause**: There is no async context in browsers: `withOrigin` keeps the origin on a stack until the handler's promise settles, so every command recorded on that history in the meantime takes it.
- **Solution / Workaround**: Register the middleware after agent playback (`registry.use` order), so it wraps only the handler and not the time a call waits in an actor's queue. Where it matters, give commands an explicit `origin` (proposals do: `accept` records the proposer's origin on the command itself).

### [core/paint-editor] Light Paint Moves With Paint Because Every Stroke Has a Grey Twin

- **Issue / Symptom**: Laying light by each engine's coverage meant special code in every engine, and smudges, blenders, the knife, the Mixer Brush and pick-up brushes left light where it was laid, so a smeared neon line looked like lit paper, not paint.
- **Root Cause**: Every engine moves colour its own way (coverage maps, the paint exchange, smudge tips, impasto drivers).
- **Solution / Workaround**: On a layer with light (or with a brush that lays it), `PaintStrokeSession` runs a twin of the stroke over the light channel drawn as grey paint (`lightToShadow`: white, alpha = light). It uses the same engine, seed and points, the brush's light amount as its grey, a normal blend and RGB mixing (`lightTwinBrush`). Effect alpha and gradient opacity are kept in grey so light lands where colour does. `shadowToLight` turns the twin's result back into light (grey × alpha). Points are forwarded already filtered (the twin has no `inputFilter`, so stateful snappers run once). Wet and sticker strokes have no twin and refuse light above 0; stroke layers refuse it (their redraw doesn't carry light yet).

### [core/paint-editor] Impasto Material A Is Clarity's Opacity, and 0 Means Solid

- **Issue / Symptom**: Glassy thick paint needed a per-pixel clarity, and older documents already had material A = 255 everywhere impasto painted (A was written but never read).
- **Root Cause**: The material map's B and A channels were unused, but A was not zero.
- **Solution / Workaround**: B is the light rim (0..255) and A is opacity for clarity: `255 - clarity × 254`, so 255 is solid and 1 the clearest. A = 0 is "no impasto material" and also reads as solid. Clarity is drawn in `LightCache.glow` as alpha × (1 − clarity × facing), with facing from the height slope. Heights on one layer combine by maximum, so crossing beads fuse: paint one loop per layer for glassy crossings.

### [core/paint-editor] Spill Is Computed From the Committed Painting, at a Reduced Resolution

- **Issue / Symptom**: Spill (light blurred onto its surroundings) is a wide blur: redrawing it from the live stroke surface on every frame of a stroke would stall drawing on large canvases.
- **Root Cause**: The stroke's live surface is a new object every frame, so any cache keyed by it misses every time.
- **Solution / Workaround**: `lightLayers` takes spill from the document's committed layer surface, so it updates when a stroke ends. `computeSpill` downsamples by `radius / 6`, blurs three box passes (≈ Gaussian, σ ≈ radius / 2) in linear light, and upsamples bilinearly. `LightCache.spill` caches on (colour surface, light surface, radius, strength). Glow is per tile and does follow the live stroke. The spill pass is an extra Linear Dodge (Add) pixel layer inserted above its layer (`insertAfter`, id `‹layer›::light`), which PSD export writes as "‹layer› light".

### [core/video-editor] A Clip Effect's Path Is in Its Source's Pixels, Not the Frame's

- **Issue / Symptom**: A path drawn on the preview, given to a clip effect as frame points, ran in the wrong place on a clip that was contained, moved, scaled or turned.
- **Root Cause**: Clip effects render over the clip's picture as it comes from the source (a media clip's own size), before placement. Effect clips render at the project frame and are placed over it. A path control's points are "frame pixels" of the picture the effect renders.
- **Solution / Workaround**: `setEffectPath` maps frame points through `videoClipPicture` / `framePointsToPicture` (undo the clip's rotation about its placed rect's centre, then scale into the source size) at the clip's first frame. Mask outlines (`videoClipMaskOutline`) are turned with their clip first. Animated placement uses the first frame's; give the path again after big moves.

### [core/animation-editor] A Path-Fitted Vector Effect Is Placed at Its viewBox Origin, Not Fitted

- **Issue / Symptom**: A vector effect run along a path node (`add_vector_effect` `path: { node }`) landed off the node when fitted into a box: straight paths have a zero-height box (scale 0), and the effect's own padding shifted it.
- **Root Cause**: `parseVectorSvg` moves the viewBox origin to 0, and `motionPartsFromVectorEffect` fitted the picture into a box. An effect given a path in artwork units already draws in artwork units, with its viewBox around the path.
- **Solution / Workaround**: `motionPartsFromVectorEffect(…, 'viewBox')` places the picture at scale 1 with its viewBox origin where the SVG says. `addVectorEffect` uses it for `path: { node }` unless a box is given.

### [core/paint-editor] Live Effect Paint Plays in the View, Not the Document

- **Issue / Symptom**: Animating effect paint by writing each frame into the document would make every frame an undo step (or none of them exact), change what saving and exporting see as the clock runs, and fight a stroke in progress.
- **Root Cause**: The document is the undo, save and replay state, while frames depend on a clock. Effect renders are also asynchronous, and each live source needs a renderer (a WebGL context with a GPU provider) every frame.
- **Solution / Workaround**: Frames go into `animatedLayers` (view only, each with the document surface it was drawn from, so it is dropped as soon as that surface changes) through `currentLayers()`. `showEffectTime(t)` renders each live source's frame at its own `time + t`, then redraws only the live strokes' areas with the stroke-layer region redraw (`liveEffectAt` makes `drawLiveStroke` use the frame). `playEffects(clock)` keeps one render in flight, caps the rate at `fps`, and idles while paused, while a stroke is painted, or when nothing is live. Exports at a moment use `withEffectTime` (`frameOverride`), so nothing persists. `MAX_LIVE_EFFECT_SOURCES` (8) caps distinct live sources. Painted areas only ever grow per stroke (`paintedBounds`), and live strokes also redraw their geometric reach (`liveStrokeBounds`), because a frame with more alpha can paint pixels an earlier frame did not.

### [core/paint-editor] Effect Paint Along the Stroke Renders a Strip, Not the Canvas

- **Issue / Symptom**: A stroke-mapped effect (`map: { by: 'stroke' }`) sampled from the canvas-sized render showed the canvas pattern, not one that follows the stroke.
- **Root Cause**: The effect cache keyed renders by source and checked them against the canvas size.
- **Solution / Workaround**: `effectPaintSize` renders a mapped effect as a `length × 256` strip, the cache key includes `map`, and `EffectPaintPixels.map` tells the samplers to read (distance along the stroke, place across the tip) from each dab's `travel`, `direction` and `radius` (`sampleEffectField` / `sampleEffectAt` with a dab). Particle and bristle marks use their pen dab. Scaled replays scale `length` in `varyStroke`.

### [core/paint-editor] A Stroke Layer Redraws Only Where an Edit Changes, From the Strokes' Painted Areas

- **Issue / Symptom**: Redrawing a stroke layer from all of its strokes after every edit took over a second with a few dozen particle strokes, and a prefix cache (redraw from the edited stroke up) was just as slow for edits near the bottom.
- **Root Cause**: A full redraw repaints every stroke, and particle strokes cost tens of milliseconds each. But with the engines a stroke layer allows (no pick-up, smudge, blender, eraser, wet or impasto), a pixel depends only on the strokes that painted it, in order.
- **Solution / Workaround**: `drawLiveStrokes(layer, list, dirty)` keeps the layer's pixels outside `dirty` (the area the old stroke painted), draws any stroke whose area isn't known yet alone once to learn it, then redraws only the strokes whose painted area overlaps, and copies just those rectangles in. Painted areas come from each stroke's `PaintStrokeResult.bounds`, kept in a `WeakMap` keyed by the stroke object (edits make new objects; a load, canvas move or replay starts with none, so the first edit after them redraws everything). This is only exact because of the engine rule: if a new engine is allowed on stroke layers, it must not read paint it did not lay. Measured: about 20 ms per edit on a 4K canvas with 200 spread-out particle strokes; overlapping strokes add their own cost.

### [core/paint-editor] A Rotation's Determinant Isn't Exactly 1

- **Issue / Symptom**: Rotating a stroke (`edit_stroke_points` transform, `replay_strokes` rotate) changed its brush size from 40 to 39.999….
- **Root Cause**: `varyStroke` scales the brush by √|det| of the affine map, which for cos/sin rotations is 1 only up to rounding.
- **Solution / Workaround**: Treat |√det − 1| < 1e-9 as 1 in `varyStroke`.

### [core/paint-editor] A Sticker Drag Changes the Document Before It Is an Undo Step

- **Issue / Symptom**: Dragging a sticker previews by replacing the document without a history entry. If the drop then committed with the current document as "before", undo would return to the last preview position, not to where the drag started. A preview base kept across other edits would undo those edits as well.
- **Root Cause**: `commit(label, next, before = this.doc)` takes the document on screen as the undo point, and the preview put an uncommitted document there.
- **Solution / Workaround**: `previewSticker` records `{ base, shown }`, and `commitStickers` uses `base` only while `this.doc === shown` (`previewBase()`). Any other change to the document invalidates it without needing hooks in undo, load or other commits. Partial redraws (`stickerSurface(list, base, dirty)`) are only used when the layer's offset is 0, because the tiles are addressed in layer space.

### [core/paint-editor] Sticker Layers Are Redrawn From Their List, so Nothing May Clip a Sticker While It Is Sprayed

- **Issue / Symptom**: Stickers sprayed under a mask stencil came out clipped, then lost the clipping as soon as any sticker on the layer was edited (even a recolour of another one), and a replay drew them unclipped.
- **Root Cause**: The spray's tile target carried the stencil selection, but every later redraw (`stickerSurface`, used by `commitStickers` and the `stickers` replay event) draws the list with `selection: null`. The clip was never part of the stickers, only of the first drawing.
- **Solution / Workaround**: A sticker stroke never takes a selection (`runStroke` passes `null`), and a live spray under an enabled mask stencil is refused with the stencil ids and how to hide them. Replays of older strokes that recorded mask stencils draw unclipped, matching the redraw. Anything new that draws stickers must go through the sticker list, not through the stroke's target.

### [core|react|svelte/extensions] `addNodeView` Must Always Return a Factory, and SVG in a `DOMOutputSpec` Needs the Namespace

- **Issue / Symptom**: Making `LoadingNode`'s framework node view optional by returning `null` from `addNodeView()` when no `nodeView` option is set crashes the editor on the first placeholder (`addNodeView(...) is not a function`). Separately, an SVG spinner written as `["svg", …]` in `renderHTML` renders as an unknown HTML element and draws nothing.
- **Root Cause**: TipTap 2 checks only that the extension *defines* `addNodeView`, then calls `addNodeView()` for every node and invokes the result, so a `null` result is called. ProseMirror's `DOMSerializer` creates HTML elements unless the tag is prefixed with a namespace URL; children inherit the parent's namespace.
- **Solution / Workaround**: Always return a node view factory, and draw the static `renderHTML` output inside it when no framework mount is configured (see `LoadingNode.addNodeView`, and `createChartNodeView`'s static fallback). Write SVG specs as `["http://www.w3.org/2000/svg svg", attrs, ["circle", …]]` (`loadingSpinnerSpec()`).

### [core/persistence] `migrations` Never Run on Documents Stored Without the File Envelope

- **Issue / Symptom**: A host stored a canvas as the raw `{ nodes, edges }` from `getDocument()` (e.g. in a database column), added `migrations` for an older shape, and found they never ran: the old shape reached the load checks and was refused.
- **Root Cause**: `defineEditorDocument` only knows a document's version from an `EditorDocumentFile` (`{ format, kind, formatVersion, document }`). A raw document has no version, so it is taken to be the current one and `migrations` are skipped.
- **Solution / Workaround**: Store `toEditorDocumentFile(doc)` (or `serializeEditorDocument`) so the version travels with the document. For raw documents that are already stored, pass `normalize` to `createCanvasEditorDocument` / `createCanvasDocument` / `useCanvasEditorDocument`: it runs on every load, raw or migrated, before the checks, so it can recognise and rewrite the older shape.

### [core/canvas] Annotation Gestures: Seeds, One-Stroke Marks and Arrowheads

- **Issue / Symptom**: (1) A gesture's playback traced a different path from the one drawn. (2) A cross drawn as one stroke showed a connecting line between its diagonals. (3) An arrow arriving at a shallow angle had a barb reaching into the box it pointed at.
- **Root Cause**: (1) The plan and the run generate the path separately; a random default seed gave each its own wobble. (2) A stroke node holds one path, and an X has four ends, so one pen stroke cannot draw it without travelling somewhere. (3) The head follows the curved shaft's direction at the tip, which can be nearly parallel to the box's edge.
- **Solution / Workaround**: The default seed is `gestureSeed` of the request (FNV-1a over its params), so plan and run, and repeated requests, draw the same mark; `seed` changes it. `crossGesture` retraces half of the first diagonal and half of the second (the shortest retrace), so nothing is drawn outside the X. `arrowGesture` narrows a barb until it clears the target box. Gestures go through `drawStroke` unchanged, so hosts need nothing new, except `nodeBounds` for `{ nodeId }` targets.

### [core/image-editor] Provider Shader Filters Filled a Layer's Transparent Pixels

- **Issue / Symptom**: A provider filter effect (`apply_effect`, a Flair shader) applied to a cutout or a text layer painted over the whole canvas: the transparent area around the content became opaque, so the effect no longer looked like it belonged to that layer.
- **Root Cause**: An effect smart filter's result replaced its input outright (`applySmartFilters` in `layers/smart.ts`), alpha included. Many shaders ignore the source alpha and write opaque pixels everywhere, so the filter's alpha won.
- **Solution / Workaround**: `EffectSmartFilter.preserveTransparency`. When set, `keepAlphaOf` draws the result over the filter's input and gives it the input's alpha, before the filter's blend and opacity. New filters from `apply_effect` and the effects panels set it to true. A missing value means false, so older documents render as before. The provider's result is cached by input only (`preserveTransparency` is left out of that key), so toggling it does not re-run the shader. For generators and overlays, use `add_effect_layer` / `add_adjustment_layer` `clipped: true` instead.

### [core/animation-editor] Shot Layer Pictures Inside SVG Frames: Outside URLs and Transition Frames

- **Issue / Symptom**: (1) A layer's picture subject showed on the live stage but not in PNG frames, in a filter's input or in a transition's `from` / `to`. (2) Drawing a transition's frames to feed the provider asked for the same transition again.
- **Root Cause**: (1) The live stage draws inline SVG, where an `<image href="https://…">` loads. A rasterized frame is an SVG drawn through `Image`, and an SVG used as an image loads no outside resources, so those pictures came out blank. (2) A transition's `to` is the frame at the same moment, and that frame is itself a transition frame.
- **Solution / Workaround**: (1) `MotionLayersEngine.subject` turns picture URLs into `data:` URLs through the host's `loadImage`, and frames use them once they are ready. This needs the picture's server to allow cross-origin use. (2) The engine's `frameSvg` draws with `transitions: false`, and it waits for the layer pictures those frames need (`idleExcept`) before rasterizing them. Keep both when changing how frames are drawn.

### [core/effects] Effects That Draw No Pixels Must Be Kept Out of Pixel Pickers

- **Issue / Symptom**: A new effect kind that draws no pixels (a `motion` effect, a `camera` move, a `timing` effect) shows up in editors' effect browsers, `apply_effect` enums and thumbnails, where creating a renderer for it fails ("No preview", or an `unsupported` error after the agent picked it).
- **Root Cause**: Editors choose effects by `uses`, and each browser and tool used to repeat its own `kind !== 'motion'` check. A camera move whose use was `transition` would have matched every editor that offers transitions.
- **Solution / Workaround**: Camera and timing effects carry exactly the use `camera` or `timing` (`checkEffectProvider` enforces it), and every picker calls `effectOffered(effect, uses)` from `@pixerate/editor/effects`, which offers motion, camera and timing effects only where their use is named. A future kind without pixels goes into `effectOffered` and the thumbnails' label map, not into another inline check.

### [core/selection] GrabCut From a Click Selected the Whole Image; Its Seeds Decide What It Finds

- **Issue / Symptom**: Without a segmentation model, `select_object` with a `point` on a castle in mist (or anything whose surroundings reach the search window's edge) selected the whole image and took 1.5 s. A click on a fruit took its shadow too. Tuning the colour/edge balance, the GMM count, the box's background band or the working size did not help: each gained on one case and lost on another.
- **Root Cause**: The click path is GrabCut on a window around the click, with a band of the window fixed as background. The object's colour model was first fitted to the whole window inside the band, which is mostly background, so whatever the band lacked (a shadow, a hill) counted as object. When that reached the band, the window grew; at the whole image there is no band (the image's own edges have none), so the background model was empty and every pixel became object. GrabCut finds whatever the first models say: the seeds matter more than any weight.
- **Solution / Workaround**: Fit the object model first to a disk around the click (0.3 of the window's half-size), and if what is found covers less than half the disk, fit again from a disk the size of the result (an object smaller than the disk). Measure changes with `tests/evals/object-selection.eval.ts` (IoU against known masks, `inspect_mask_edge`, time, and `OBJECT_EVAL_JITTER=1` to move each box a little) and keep `tests/image-editor-object-selection-quality.test.ts` passing. A single run can mislead: K = 6 and a higher-resolution crop each looked better on one box and worse when it was moved a few pixels. A click on a small object inside a large region unlike the band (the boulders in the demo's lake, in sunset-coloured water) still led the disk into the region, which then ran off the image: a second cut from a disk 0.05 of the window is kept and used when the result reaches three of the image's sides. Box limits that remain: background inside the box but not around it (a shadow) is taken; a box at the image's edge learns no background there; parts coloured like the background are missed.

### [react|svelte/parameters] Parameter Inputs: Tab Commit, Refused Edits and Theme Tokens

- **Issue / Symptom**: (1) A typed number sometimes did not apply when the user pressed Tab. (2) After a refused edit (not a number, or clamped to the stored value), typing the same text again stayed on screen. (3) Parameter inputs, selects and sliders ignored the host's theme.
- **Root Cause**: (1) Commits ran on blur only. The React box was also keyed on `value` (`key={value}`), so a commit made during the Tab keydown remounted the focused element before the browser moved focus on. (2) The commit dedup remembered the refused text, so the next identical attempt was treated as already committed. (3) No theme hook. Inline `background-color` / `color` on buttons also beat their `hover:` / `text-muted-foreground` classes, because inline styles override class utilities.
- **Solution / Workaround**: `ParameterCommitInput` commits on Tab, native `change`, blur and Enter, and skips text equal to `value` or to the last commit. After a commit it remembers what the box *shows*, so a refused edit (the stored text put back) is tried again. React keeps the same element and syncs a changed `value` in a layout effect, so do not reintroduce `key={value}`. Theme tokens live once in core (`parameterThemeStyles` / `parameterThemeStyleText` in `@pixerate/editor/parameters`): `--pixerate-parameter-input-bg/-fg`, `-select-bg/-fg`, `-button-fg`, `-border` and `-accent`, falling back to `--background`, `--foreground`, `--input`, `--border` and `--primary`. Buttons get text and border colour only. Do not add inline styles to the `↺` reset or segmented buttons. Host controls are `components={{ input, slider, select }}` (prop or `ParameterComponentsProvider` / `setParameterComponents`). Custom selects may report string values; map them back with `matchParameterOptionValue`. The image editor's host `Range` / `Select` reach effect parameters through `imageEditorParameterComponents` adapters, not by passing those components directly, because their props differ.

### [markdown-conformance] CommonMark Delimiter Rules Shift Delimiters Across Unicode Selection Markers

- **Issue / Symptom**: In markdown serialization with selection markers (e.g. `⟦`, `⟧`), `tiptap-markdown`'s `trimInline` serializer shifted delimiters across selection markers (e.g. `**⟦wor**⟧ld` instead of `⟦**wor**⟧ld`).
- **Root Cause**: `\u27e7` (`⟧`) is classified as Unicode punctuation. CommonMark's `scanDelims.can_close` returns `false` if a closing delimiter (`**`) is preceded by punctuation (`⟧`) and followed by an alphanumeric character (`l`). `tiptap-markdown` consequently treats it as non-closing and pulls delimiters before the closing bracket.
- **Solution / Workaround**: When serializing selection markers through ProseMirror / TipTap transactions, insert temporary alphanumeric tokens (`ZCONFOPENZ`, `ZCONFCLOSEZ`, `ZCONFCARETZ`) with appropriate mark sets, run the serializer, and replace the alphanumeric tokens with `⟦`, `⟧`, and `‸`.

### [monorepo/build] Bundling Data-Only Packages with JSON Exports in ESM

- **Issue / Symptom**: Importing a data-only package's `.json` export (e.g. `@pixerate/markdown-conformance/manifest.json`) in a bundled library (`@pixerate/editor`) threw `ERR_IMPORT_ATTRIBUTE_MISSING: Module ... needs an import attribute of "type: json"` when consumed via Node ESM.
- **Root Cause**: `tsup` treats workspace packages in `dependencies` as external by default and strips the TS import attribute `with { type: 'json' }` from output chunks, leaving bare `import manifestData from ".../manifest.json"`, which Node ESM rejects.
- **Solution / Workaround**: Add the data-only package to `noExternal` in `tsup.config.ts` (e.g. `noExternal: ["tiptap-markdown", "@pixerate/markdown-conformance"]`). `esbuild` then inlines the JSON directly into the built JavaScript chunks, avoiding runtime JSON module import attribute restrictions for consumers. Because it is inlined, the data package is a `devDependency` of core, not a dependency: apps installing the editor don't get it, and `scripts/check-packages.mjs` leaves it out of its test project so it fails if a package starts needing it at runtime.

### [core|react|svelte/effects] A Vector Effect's Authoring Preview Showed the Previous Effect's Frame

- **Issue / Symptom**: Opening a `vector` effect (the fake provider's Badge) in `EffectAuthoringEditor` left the previous effect's last frame on the canvas and threw an uncaught `"fake.badge" is a vector effect; use applyVectorEffect.`; entrance effects and transitions opened on an empty or unchanged frame.
- **Root Cause**: Providers may refuse `createRenderer` for vector effects, and both editors called `createPreview(...).then(...)` with no `.catch` and never cleared the canvas on a session change. The playhead also opened at 0 ms, where slide-ins and transitions (progress 0) draw nothing useful.
- **Solution / Workaround**: The generic session records the refusal in `EffectAuthoringState.previewError` (and `effect_authoring_describe` returns it; `effect_authoring_view` refuses with it). The editors clear the canvas on every session change, catch preview and frame failures, and show the reason. Sessions start at half the length like thumbnails (`startTime` overrides). Canvas mocks in editor tests need `clearRect` as well as `putImageData`.

### [paint/wet] Wet Paint Mixing Samples Only Suspended Pigment While Settled Pigment Carries Visible Color

- **Issue / Symptom**: Overlapping wet paint strokes (such as Gouache or Watercolor) fail to mix; subsequent strokes paint with their raw color without picking up underlying wet strokes, behaving as opaque dry coats.
- **Root Cause**: In the wet simulation grid (`world.ts`), pigment deposits from water suspension (`P_P0`) into settled grain (`P_D0`) within seconds, and re-wetted dry paint is directly placed into `settled`. `WetMedium.sample` was only reading `s.pigment`, meaning once pigment settled onto the paper substrate (even while paper remained completely wet), the sampler returned zero pigment density. Additionally, gouache presets lacked evaporation damping, causing moisture to dissipate before a user could pick another color.
- **Solution / Workaround**: In `WetMedium.sample`, sum both suspended (`s.pigment`) and settled (`s.settled`) absorption channels ($K$), matching visual shader rendering (`shadeTile`). Ensure wet brush definitions specify proper `pickup` and `mixing: 'pigment'` behavior with appropriate evaporation rates to permit natural inter-stroke mixing.
### [core/typography] `document.fonts.check()` Says Yes for Fonts That Are Not Installed

- **Issue / Symptom**: A system font provider that answered `hasFont` with `document.fonts.check('16px "Some Font"')` reported every family as available, including made-up names.
- **Root Cause**: `FontFaceSet.check()` answers whether loading the matching faces *in the set* would be needed. When no `@font-face` in the set matches the family, nothing needs loading, so it returns `true`. It says nothing about installed system fonts.
- **Solution / Workaround**: `createSystemFontProvider` never uses `check()`. It answers from the metadata catalog (what is commonly installed), or from `queryLocalFonts()` when the host opts in (it prompts for permission, so it is only called when passed in). Web fonts report their own load state through `createWebFontProvider(...).loaded()`. Always ship a family inside a `resolveFontFallback` stack.

### [core/typography] Google Fonts Rejects Faces a Family Does Not Have, and Its Catalog Has No CORS

- **Issue / Symptom**: Loading `Anton` at weight 700 through `fonts.googleapis.com/css2?family=Anton:ital,wght@0,700` returns HTTP 400, so the whole stylesheet fails and no face loads. In a browser, `fetch('https://fonts.google.com/metadata/fonts')` fails with a CORS error.
- **Root Cause**: The css2 API answers only for faces the family ships (Anton has just 400), and the metadata endpoint sends no `Access-Control-Allow-Origin`. The stylesheets themselves (`fonts.googleapis.com`) and font files (`fonts.gstatic.com`) are fine cross-origin.
- **Solution / Workaround**: `createStylesheetFontProvider` asks for the nearest weight the family lists (any weight for a variable font) and falls back to `normal` when the family has no italic; the browser synthesises the rest. Google splits each family into `unicode-range` subsets, and `document.fonts.load(font)` with no text only matches the space character, so it can resolve without fetching the Latin file; the provider passes sample text (`sampleText`, default Latin letters and digits). `createGoogleFontsProvider({ catalog })` takes the metadata from the host, so a browser host fetches it through its own server and may pass the catalog already built with `googleFontsCatalog`.

### [core/color] Accessible Colour Suggestions Must Be Judged After Rounding to Hex

- **Issue / Symptom**: `check_color_contrast` (and the new typography check) sometimes suggested a foreground that failed AA when checked again, e.g. 4.48:1 for a 4.5:1 target.
- **Root Cause**: The OKLCH lightness search tested the unrounded candidate, which just passed, then returned `formatHex(candidate)`. Rounding each channel to 8 bits moves luminance enough (about 0.02 in ratio near mid-greys) to drop it below the threshold.
- **Solution / Workaround**: `suggestAccessibleForeground` (`color/suggest.ts`, shared by the colour and typography tools) parses each candidate back from its hex string before measuring it, so the returned colour is the one that was checked.

### [core/typography] `Intl.Segmenter` Has No Line Granularity, and Not Every Runtime Has `Intl.Segmenter`

- **Issue / Symptom**: Splitting text "into lines" for animation cannot use `Intl.Segmenter` (it offers `grapheme`, `word` and `sentence` only), and older runtimes throw on `new Intl.Segmenter`.
- **Root Cause**: Where a line wraps depends on the renderer's measure, which a DOM-free module does not know.
- **Solution / Workaround**: `segmentText(text, 'line')` splits on hard breaks (`\r\n`, `\n`, `\r`, U+2028/2029) and, with `maxCharacters`, wraps greedily at word boundaries, keeping UTF-16 offsets into the original string. Without `Intl.Segmenter` it falls back to code points and Unicode-property regexes. Hosts that know their layout should split by their own line boxes.

### [react|svelte/typography] A Controlled Font Picker Must Not Echo `value` Back Through `onChange`

- **Issue / Symptom**: Passing a new `value` to `FontPicker` called `onChange` with the same value, which a parent that normalises values can turn into a render loop; and a parent passing its own `model` never heard about changes made through that model (UI or agent tools), because the model's constructor `onChange` belonged to whoever created it.
- **Root Cause**: Both changes went through one notification path.
- **Solution / Workaround**: `FontPickerModel.setValue` (used for controlled updates) only updates state; user and agent changes go through `commit`, which calls `onValueChange` listeners. The React hook and the Svelte component subscribe with `onValueChange` (always calling the latest callback), so a shared model also reports agent edits made with `createFontPickerToolProvider`.

### [paint-editor] Moving the Picture Means Moving Every Document-Space Coordinate

- **Issue / Symptom**: Growing the paint canvas to the left or top by bumping layer offsets alone left the paper grain, symmetry centre, stencils and recorded strokes behind. Paint no longer sat in its grain, guides pointed at the wrong place, and replays painted shifted. Undo after a later wet stroke threw "The wet world is the wrong size".
- **Root Cause**: Many things are in document pixels rather than layer space. The grain is sampled at document (x, y) (`PaperGrain.at`). Guides live outside the undo history. Stickers are stored in document coordinates, because sticker layers are re-rendered at offset 0. Strokes and wet / paint events are replayed at their recorded positions. Sticker stamps' shading noise is also keyed on document pixels. The wet simulation is canvas-sized, and undo restored an old-size snapshot into the new-size world.
- **Solution / Workaround**: `extendCanvas` moves all of them together (`shiftDocument` / `shiftGuides` in `paint-editor/controller.ts`). It adds `PaperSettings.offset` for the grain and records the guides on the history entry. It dries wet paint first, and `PaintWetLayers` drops an empty or wrong-size world on restore. Masks and thick channels are in layer space and follow the offset. When adding anything new that holds document coordinates, shift it there too and extend `tests/paint-editor-extend.test.ts`. A sticker layer re-rendered after a shift differs by a few levels of shading noise; that is expected.

### [core/tools] A Tool-Provider Factory's Default Playback Surface Must Not Beat the Caller's

- **Issue / Symptom**: An app with one image editor per canvas node attached each `<ImageEditor>` under its own `playbackId` and wrapped `createImageEditorToolProvider(...)` in `withImagePlayback(provider, 'image4:surface')`, but every call still played on `image` (no surface there, so it ran instantly or on the wrong editor).
- **Root Cause**: The factories wrap themselves with `with*Playback(provider)`, which already set `playbackSurface: 'image'`. A second wrap used `provider.playbackSurface ?? surface`, so the default from the first wrap won over the explicit argument.
- **Solution / Workaround**: Every `with*Playback` resolves `explicit surface ?? provider.playbackSurface ?? default`, and every factory that wraps itself takes a `playbackSurface` option and passes it in. Pass `playbackSurface` to the factory (or the React / Svelte hook that registers it) rather than wrapping again. `tests/playback-surface-option.test.ts` covers each factory and two image editors on one registry.

### [color/gradient] Svelte 5 Effect vs Controller Subscription Initial State

- **Issue / Symptom**: In Svelte 5 with runes, subscribing to `GradientController` inside `$effect` with an initial `$state<GradientState>(controller.state)` can trigger reactive dependency cycle warnings or stale reads if the parent re-passes a new controller instance.
- **Root Cause**: Reading `controller.state` in field initializers captures the instance once, but reading it inside `$effect` subscribes asynchronously after the first DOM render pass.
- **Solution / Workaround**: Initialize state with `$state.raw<GradientState | null>(null)`, manage `controller.subscribe` within `$effect` (unsubscribing on cleanup), and use a derived `$derived safeState = gradientState ?? controller.state` for immediate first-render stability.

### [color/gradient] Entry Isolation: Color Module Must Never Import Gradient Module

- **Issue / Symptom**: `tests/entry-isolation.test.ts` fails when `@pixerate/editor/color` imports from `@pixerate/editor/gradient`.
- **Root Cause**: Architectural layering requires `@pixerate/editor/color` to be a lightweight foundation (color models, conversions, contrast) usable independently by charts, animations, tokens, and canvases without bundling gradient controller or parser trees.
- **Solution / Workaround**: The dependency graph is strictly one-way: `gradient` imports from `color`, never `color` from `gradient`. Enforce via `tests/entry-isolation.test.ts`.

### [color/dual] CSS `light-dark()` Requires `color-scheme: light dark;` on an Ancestor

- **Issue / Symptom**: Exported `light-dark(#ffffff, #000000)` tokens always render the light colour in the browser, even when the user or operating system is in dark mode (`prefers-color-scheme: dark`).
- **Root Cause**: The CSS Color 4 `light-dark()` function strictly requires the element or an ancestor (typically `:root`) to declare `color-scheme: light dark;` (or `color-scheme: dark;`). Without an active `color-scheme` context, browsers default to `light` regardless of media queries.
- **Solution / Workaround**: `dualColorsToCss()` with strategy `'light-dark'` automatically includes `:root { color-scheme: light dark; ... }`. When applying `light-dark()` variables manually or targeting scoped components, ensure `color-scheme: light dark;` is applied to the root or wrapper element. Use `dualColorsToCss` with strategy `'media'` or `'class'` if targeting older browsers or environments that use CSS class toggling (e.g. `.dark`) instead of native `color-scheme`.


### [monorepo/release] Two Quick Merges: The Second Release Run Versioned the First One's Changesets Again

- **Issue / Symptom**: #312 and #311 merged 17 seconds apart. The first Release run published 0.140.1 and pushed its version commit; the second failed at "Refuse versions that are already on npm" (`@pixerate/editor@0.140.1 is already on npm but main is still at 0.140.0`). Nothing was published twice, but the run failed.
- **Root Cause**: `concurrency` queued the second run behind the first, but `actions/checkout` checked out the commit that triggered it, from before the first run's version commit. That checkout still had #312's changeset, so it computed the same versions again.
- **Solution / Workaround**: `release.yml` checks out `main` on push (`ref: ${{ github.event_name == 'push' && 'main' || github.ref }}`), so a run that waited starts from the latest release commit and only versions changesets still pending. GitHub keeps only the newest waiting run per concurrency group, and that run releases everything merged while it waited, so dropped runs lose nothing. If an old run fails this way anyway, check that `main`'s `packages/*/package.json` versions match npm; the pending changesets go out with the next release.

### [core/security] An Own `__proto__` Key From JSON Becomes a Prototype, and ProseMirror Renders Inherited Attributes (GHSA-cp6q-959q-f8rh)

- **Issue / Symptom**: Document JSON such as `{"extra": {"__proto__": {"onerror": "…", "src": "x:"}}}` rendered `onerror` and `src` on a mark's `<span>`, although neither was an own key of any object we built. Dependabot flags every `@tiptap/core` 2.x for this advisory.
- **Root Cause**: `JSON.parse` makes `__proto__` an *own* key. Code that copies keys with bracket assignment (`out[key] = value`, `Object.assign`) turns it into the copy's prototype instead, and `DOMSerializer.renderSpec()` walks attributes with `for…in`, so inherited keys reach `setAttribute`. TipTap's `mergeAttributes()` did this until `@tiptap/core` 2.27.3 (backported quietly; the advisory still lists only 3.30.4 as patched). Standard schemas are safe, since ProseMirror's `computeAttrs` reads only declared attribute names. The risk needs an attribute whose `renderHTML` returns an object from content, `HTMLAttributes` from untrusted config, or our own key-by-key merges (agent tool handlers, the style registry).
- **Solution / Workaround**: In `renderHTML`, use `safeMergeAttributes` (from `@pixerate/editor`), never TipTap's `mergeAttributes`. Run untrusted JSON through `stripPrototypeKeys` before `setContent`, `Node.fromJSON` or `Slice.fromJSON`; `EditorController`, the rich clipboard, `compareDocuments`, `CommentStore.parse`, the persistence loaders and `ToolRegistry.callTool` already do. In merges of your own, skip `isUnsafeJsonKey(key)`. Keep the TipTap floor at `^2.27.3`. `tests/prototype-pollution.test.ts` mocks the unpatched `mergeAttributes`, so the regression shows even though the installed TipTap is fixed.

### [monorepo/build] `import.meta` Breaks the CommonJS Build, and tsup's `shims` Breaks Entry Isolation

- **Issue / Symptom**: `pnpm check:packages` failed with `SyntaxError: Cannot use 'import.meta' outside a module` when requiring `@pixerate/editor/bridge` from CommonJS, although the code guarded it with `typeof __dirname === 'string' ? __dirname : …import.meta.url…`. Turning on tsup's `shims: true` fixed that but made `tests/entry-isolation.test.ts` fail: browser entries (`chart`, `canvas`, `animation`…) suddenly imported `path` and `url`.
- **Root Cause**: `import.meta` is a parse-time syntax error in a CommonJS file, so a runtime guard can't save it, and tsup copies it into `.cjs` output unchanged. `shims` adds `import path from "path"` / `import { fileURLToPath } from "url"` for an ESM `__dirname`, and with code splitting that lands in a chunk every entry shares.
- **Solution / Workaround**: `tsup.config.ts` defines `import.meta.url` as `undefined` for the CJS format only (`esbuildOptions`), and the code takes `__dirname` there. Use `import.meta` only behind a `typeof __dirname` check, only in Node-only modules (`src/bridge`), and run `pnpm check:packages` after a build to catch it.

### [core/tools] Tool Names Are Namespaced by Default, So Bare-Name Assertions and Bridge Unions Break

- **Issue / Symptom**: After a provider is registered, `listTools()` returns `chart__get_chart`, not `get_chart`. Tests that compare `t.name` with a bare name fail, a page on the MCP bridge whose provider id differs from another page's (`a__echo`, `b__echo`) no longer shares tool names with it, and code that splits on `__` sees a prefix it didn't before.
- **Root Cause**: `ToolRegistry` defaults to `namespaces: 'always'`: each tool is exposed as `<namespace ?? id>__<name>` so names don't shift when another editor mounts (with the old collision-only prefixing, `duplicate_layer` became `image-editor__duplicate_layer` the moment the paint editor mounted, and a model's earlier calls stopped working). The bridge unions tools across pages by exact name and adds an `editor` argument, so pages only share a tool when they expose the same name.
- **Solution / Workaround**: Compare with `baseToolName(t.name)` (or call by bare name: `callTool`, `hasTool` and `getTool` accept it when exactly one tool has it, and say which full names it could mean otherwise). Give providers of the same kind on different pages the same `namespace` (`video`) so the bridge sees one tool per name. A registry that forwards names it didn't make (the bridge's) registers its provider with `namespace: ''`, which keeps bare names and prefixes only on a collision. `new ToolRegistry({ namespaces: 'on-collision' })` restores the old behaviour for a whole registry.

### [core/tools] A Discovery View Only Helps Clients That Refresh on `list_changed`

- **Issue / Symptom**: In a discovery view (`registry.view({ discovery: true })`), `enable_tools` succeeds but the model still can't call the enabled tool, or calls it and the client says the tool doesn't exist.
- **Root Cause**: MCP clients only let the model call tools from their last `tools/list`. The view announces each change with `notifications/tools/list_changed` (through `createMcpServer`'s `send`, or the bridge's `tools` message), and a client that ignores it keeps the old list. The view itself accepts calls to any allowed tool by name, enabled or not, but the client never sends them.
- **Solution / Workaround**: Serve discovery views only to clients that support `listChanged` (Claude Code, Claude Desktop), and make sure the server has a `send` so the notification goes out. For an API host with its own loop, re-read `view.listTools()` before every model request (as `tests/evals/tool-selection.eval.ts` does). For clients that don't refresh, scope with `toolsets` instead of discovering.

### [tests] A Growth Test Must Do the Same Work at Both Sizes, and Count It Where It Can

- **Issue / Symptom**: The `analyzePdfLayout` "grows near-linearly" test timed `bigPage(100)` against `bigPage(400)` and measured ~6× for 4× the input (an 8× step gave 10–18×), so it sat close to its limit of 10 and failed under load. It looked like ~n^1.3 growth in the layout code.
- **Root Cause**: The two sizes did different work. Every section's table had the same width, and `ruledTables` joined stacked horizontal rules of the same extent (the booktabs pass) whatever their distance, so the whole page became one ruled table (a real import bug: two same-width tables and the paragraph between them came out as one table). At 400 sections the page also passed `MAX_RULES` (2000), so later tables fell to the unruled path and column detection. No step of the code was superlinear; the fixture changed which steps ran. Timing was also too noisy: once the work was like for like, wall-clock ratios still reached 8–10× on a loaded machine, against 16× for quadratic, mostly from GC.
- **Solution / Workaround**: Assert the fixture's output scales with its size (`bigPage(200)` gives 200 headings, paragraphs, lists and tables) and keep it under the code's caps. Count work instead of timing it: for private module functions `vi.spyOn` can't reach, `arrayVisits` (`packages/core/tests/helpers/array-visits.ts`) counts the array elements visited through `for…of`, spreads, the callback methods and `indexOf`/`includes`; it is exact, so the limit can be tight (6× for 4× the input). It does not see index loops or `sort`. Check the test by making the code quadratic once (e.g. an `indexOf` per fragment in `flowLines` gives 15.9×), on a path the fixture actually reaches.

### [tests] Writing Tests That Pass on CI: Fix the Cost, Not the Timeout

- **Issue / Symptom**: PRs failed at random with "Test timed out in 5000ms" (the brush panel tests in React and Svelte in #268, #270, #282 and #283; wet-media, image-layer and raster-effect tests before them), and passed on a re-run. Each PR raised one test's timeout, and the next slow test failed the next PR. The Release workflow re-runs the suite, so one flake can stop a publish.
- **Root Cause**: GitHub's ubuntu-latest runners are ~3× slower than a laptop and run 3 test files at once, so a test that takes 1.5–2 s locally takes 5 s there on a bad run. The usual costs:
  - Rendering every item of a library on mount: `BrushPanel` paints a thumbnail stroke for each of ~55 brushes on every render, and saving a brush renders them all again. Any test rendering `BrushPanel` or `PaintEditor` paid several seconds.
  - Two tests doing the same heavy work (both core paint tests rendered every brush thumbnail).
  - Simulations run for more steps, or over a bigger canvas, than the property needs (100 + 70 wet steps to show determinism; a 900 × 700 canvas for effect maps, whose cost follows the layer's bounds).
  - Wall-clock assertions with little headroom: an "O(log n)" check allowed 2.5× for 4× the input, where log growth is ~1.2× and noise on a loaded runner can exceed 2×.
- **Solution / Workaround**:
  - Keep every test under ~1 s locally (`npx vitest run <file> --reporter=verbose` prints times). On CI, `vitest.slow-tests.ts` adds a warning annotation and a step-summary row for each test that uses 40 % of its timeout; fix those rather than waiting for them to fail.
  - Panel tests check wiring: stub expensive rendering they don't assert on. `stubBrushThumbnails()` (`packages/react|svelte/tests/paint-thumbnails.ts`) returns blank thumbnails and lets the test check one was requested per brush; the pixels are tested once in core.
  - Shrink fixtures to the smallest that still shows the property (one tile, few steps, a canvas just over the tile edges you need), and split a test that loops over many cases with `it.each` so each case gets its own timeout.
  - Count work instead of timing it where the code exposes it: recalculation stats, `vi.spyOn` call counts (e.g. interval-tree nodes visited in `spreadsheet-recalc.test.ts`), or `arrayVisits` for private module code (see "A Growth Test Must Do the Same Work at Both Sizes"). Check such a count by breaking the code once and watching the test fail. Where only time will do, use `measureGrowth` (see "Timing Tests Flake in the Release Run Unless They Use `measureGrowth`").
  - Use fake timers (`vi.useFakeTimers()`, `vi.advanceTimersByTime`) for debounces, dwell times and animations, never real `setTimeout` waits.
  - Benchmarks go in `*.bench.test.ts` files that skip unless their environment variable is set (e.g. `WET_BENCH=1`).
  - Raise a timeout only for work that is slow by design and can't be smaller (real ffmpeg runs, growth measurements), with a comment saying why.

### [monorepo/ci] PR CI Runs Only the Affected Tests

- **Issue / Symptom**: A pull request's CI passes, and the same test fails on `main` or in the Release run after the merge. Or a PR that broke a React or Svelte test shows no test run for it at all.
- **Root Cause**: On a PR, `scripts/ci-test.mjs` runs only the tests the change can affect, split over 4 shards. Pushes to `main` and the Release workflow still run everything. Vitest's import graph (`vitest list --changed`) sees imports only. React, Svelte and the demo import `@pixerate/editor` through its built `dist/`, so the graph doesn't link a `packages/core/src` change to their tests. A test that reads a file (`readFileSync`, `readdirSync`, `existsSync`…) instead of importing it isn't linked to that file either.
- **Solution / Workaround**: The script covers both: a change under a package's `src/` or `assembly/` runs every test of the packages that depend on it (from their `package.json`), and every test that calls a file-reading function runs on any non-docs PR. A change to the lockfile, a `package.json`, a tsconfig, a vitest config, the script or `ci.yml` runs everything. When a new kind of hidden dependency appears (a test that spawns a process, or reads a file through a helper in another module), add it to `GLOBAL` or `READS_DISK` in the script, with a case in `packages/core/tests/ci-test-script.test.ts`. To see what a PR will run: `BASE_SHA=$(git merge-base origin/main HEAD) node scripts/ci-test.mjs --list`.
- **Shards split by file, so one slow file sets a shard's time.** `apps/demo/src/paintScripts.test.ts` took 136 s on CI and kept its shard running for 2 minutes after the others had finished. It ran every script twice, once in an `it.each` and again in that script's own test. It's now four `paintScripts*.test.ts` files that share `paintScriptHarness.ts`, and each script runs once. Keep a test file under about 30 s on CI: the step summary of each shard's run lists its slowest tests.

### [tests] Heavy Tests Time Out Only Under the Full Parallel `pnpm test` Run

- **Issue / Symptom**: `pnpm test` (and CI, and the Release workflow) failed 2–4 different tests per run with "Test timed out in 5000ms", for example `paint-editor-extend.test.ts` ("by whole wet tiles…" at 5.6 s) and `tool-search-eval.test.ts`. The same test passes alone in about 1–2 s, so `npx vitest run <file>` never shows the problem.
- **Root Cause**: The root `vitest.config.ts` runs every project (`packages/*`, `apps/*`) in one run, and each worker runs a test file while the others take the rest of the CPU. A CPU-bound test then takes about 2× its solo time on a laptop and 3–5× on a 4-vCPU CI runner. A test at 1 s alone is at the limit there. Which tests fail depends on which heavy files happen to overlap, so each run fails a different set.
- **Solution / Workaround**:
  - Measure under load, not alone: run the full `pnpm test` and look for tests over ~30 % of their timeout locally (about 1.5 s against the 5 s default). On CI, `vitest.slow-tests.ts` lists every test over 40 % in the run summary. `gh api repos/<owner>/<repo>/check-runs/<job id>/annotations` gives the same list as data, to collect across several runs.
  - Then fix as in "Writing Tests That Pass on CI": fewer steps, smaller strokes, `it.each` per case. Where the cost is the thing under test (an eval over the whole tool catalogue, GrabCut on the scenes its floors were measured on), give that test its own timeout with a comment saying why. Don't raise the global `testTimeout`, which would hide the next slow test.
  - Lowering vitest's worker count doesn't fix it either: the run gets longer, and the tests that are slowest alone still take the most of their timeout.

### [svelte] An `$effect` That Writes State and Then Reads It Re-runs Itself Forever

- **Issue / Symptom**: The Svelte effects browser froze the page (and hung its test) when a thumbnail's render failed, for example for a vector effect the provider cannot draw as pixels. React was fine.
- **Root Cause**: `EffectThumbnail.svelte`'s `$effect` set `failed = item.kind === 'motion'` and then read it back (`if (failed) return`). That read made `failed` a dependency of the effect. The failed render set `failed = true`, which re-ran the effect. The effect reset `failed`, rendered again (failures are not cached) and failed again, in an endless microtask loop that starved timers.
- **Solution / Workaround**: Keep the value in a local (`const motion = …`), read only the inputs that pick the picture, and start async work inside `untrack`. Never read back, in the same `$effect`, state that the effect or its callbacks write.

### [core|react|svelte/canvas] Canvas Effects Vanished Without a Word After Switching Effects Provider

- **Issue / Symptom**: In the Canvas demo, a shape filled with a built-in test effect went blank when the Effects switch moved to Flair (and back the other way). Nothing said why, so the switch looked as if it did nothing.
- **Root Cause**: A shape's effect saves its effect id and the id of the provider it came from (`data.shape.effect.provider`), but nothing compared that provider id with the registered provider. The new provider was asked to render an id it does not have, the render failed, and `CanvasNodeEffectLayer` returned `null` on failure. The shared `list_applied_effects` only checked whether the effect id was in the catalog.
- **Solution / Workaround**: `canvasEffectStatus(effect, provider)` (and `controller.status`) says when an effect came from another provider. The React and Svelte effect layers draw a faint hatch with the reason (`data-canvas-effect-missing`) for that and for failed renders, the panel shows the reason, and `list_applied_effects` returns `available: false` with a `reason` for effects saved from another provider. Effects are kept, never rewritten, so switching back draws them again.

### [core/effects] GPU Effect Providers Hold a WebGL Context per Renderer, and Browsers Allow About Sixteen

- **Issue / Symptom**: With Flair as the provider, opening the effects browser printed "Too many active WebGL contexts. Oldest context will be lost." more than a hundred times. Most thumbnails showed "No preview", and effects already on clips failed with "The graphics context was lost." The engines record failures and don't retry them, so those clips stayed plain until the provider changed.
- **Root Cause**: Each Flair renderer (a `ShaderPipeline`) owns one WebGL context. The effects browser rendered every thumbnail at once, around 300 renderers in parallel. The video and image engines also kept one renderer per effect and size for as long as the provider was set. Chrome keeps about sixteen contexts alive and loses the oldest beyond that, which breaks renders still in flight.
- **Solution / Workaround**: `renderEffectThumbnail` renders one thumbnail at a time, disposes each renderer before making the next, and caches the results per provider. Both engines render through `EffectRendererPool`, which keeps at most four live renderers (`maxRenderers`) and disposes the least recently used one once its queued renders finish. If you write a provider host, keep few renderers alive and always `dispose()` them. When the demo seems to ignore a fix, check for a stale bundle in the browser cache: `vite preview` pages can keep the previous hashed chunks until a hard reload.

### [core/image-editor] An Effect Smart Filter Above One Still Rendering Must Not Be Requested

- **Issue / Symptom**: With two provider effect smart filters stacked, the upper one sometimes showed its result as if the lower one was not there, even after both had rendered.
- **Root Cause**: `applySmartFilters` is synchronous. A missing provider result passes the pixels through while it renders. Results are cached by a key made from the placed contents and the filters below. While the lower filter was still rendering, the upper filter was requested with the unfiltered input, under the key that means "after the lower filter". That wrong result was then served from the cache.
- **Solution / Workaround**: Once a filter in the stack is pending, the effect filters above it are not requested; they pass through until the next render. The surface is marked incomplete, so the controller renders it again as each result lands (`refreshEffectSurfaces`). The cache key also carries the engine's `token`, so a new or removed provider never reuses old results.

### [core/video-editor] Provider Effects Render Asynchronously, but the Canvas Draws Synchronously

- **Issue / Symptom**: An effects provider's `render` returns a promise, while `drawVideoFrame` draws a whole frame synchronously. Awaiting effects inside a draw would stall playback. Drawing the playhead's exact time while playing also missed the effect cache on every animation frame, and a layer whose media was still loading got cached with the wrong picture.
- **Root Cause**: The playhead moves continuously, so values derived from it (source time, fades, keyframes) never repeat between frames. An effect's input is read from a scratch canvas: if the media was not ready, the provider received a placeholder.
- **Solution / Workaround**: `VideoEffectsEngine` keeps rendered pictures by key, using the LUT cache's pattern. A draw asks for a picture: if it is cached it draws at once; if not it requests one, draws the layer without effects, and redraws when the engine notifies. With effects on screen, the preview evaluates the frame at the start of its frame (`videoEffectFrameTime`), so each frame has one key. Inputs go to the provider only when the draw found every media picture ready. `renderVideoFrameExact` draws, awaits `engine.idle()` and draws again until nothing is waiting, which is what exports use.

### [core/video-editor] Clip Effects Cannot Be ffmpeg Filters: Export Takes Rendered Frames

- **Issue / Symptom**: A project with provider effects (from Flair, for example) cannot be expressed as an ffmpeg filter graph.
- **Root Cause**: Provider effects are arbitrary shaders or CPU code that run in the host. ffmpeg has no equivalent.
- **Solution / Workaround**: `toVideoFfmpeg` throws, naming the clips with enabled effects, unless `frames` is passed. With `frames`, the host renders every frame with `renderVideoFrameExact` (the preview's own drawing) to PNGs or to raw RGBA on a pipe. ffmpeg then takes those as the picture and still builds the sound graph. Turning the effects off (`enabled: false`) makes a quick draft export possible again.

### [core/effects] Provider Colour Controls May Be `anyOf` With No Top-Level `type`

- **Issue / Symptom**: The effect parameter panels, the Effect Authoring workspace and `effect_authoring_describe` left out every colour control of Flair's effects. Mesh gradient showed Speed, Warp and Grain but none of its four colours, although Flair's `describe` and authoring session listed them all.
- **Root Cause**: `effectControlField` picks a field from `schema.type`. Flair writes a colour as `anyOf: [[r, g, b] channels 0–1, CSS colour string, optionally { const: "currentColor" }]` with no `type`, so the control matched nothing and returned `null`. That means "no field can edit this", and the control was dropped without a word.
- **Solution / Workaround**:
  - An `anyOf` control is edited as the branch that matches its default's shape: a hex default makes a colour field, and a channel default makes a vector field.
  - Because the schema accepts both shapes, a saved value can still be channels while the field is a colour. `effectFieldValue` shows such channel values as hex, and the default for values a colour well can't show (`currentColor`, `rgb(…)`).
  - When a provider's controls go missing in a panel, check `effectParameterFields` against the provider's real schema before blaming the provider: fields it can't map are left out without a warning.

### [core/effects] Effect Errors From a Provider May Not Be `instanceof` This Library's Classes

- **Issue / Symptom**: An editor's `catch (e) { if (e instanceof UnknownEffectError) ... }` missed errors thrown by an effects provider, so a bad effect id surfaced as a generic failure instead of a useful tool error.
- **Root Cause**: Providers live in other packages (Flair's `flairEffects()`). A provider bundled with its own copy of `@pixerate/editor/effects`, or a second install of a different version, throws errors from a different class object, and `instanceof` compares identity.
- **Solution / Workaround**: Check `isEffectError(e)` and `e.code` (`unknown_effect`, `invalid_values`, `unsupported`, `disposed`, `no_provider`) instead of `instanceof`. Providers should run `checkEffectProvider` in their own tests: it fails when an error has no `code`.

### [core/vector] Constraints Need Anchor Ids, and Every Hand-Built Anchor Copy Must Carry Them

- **Issue / Symptom**: Constraints disappeared after ordinary edits (a move, a reverse, a shape-keeping delete of a neighbour).
- **Root Cause**: Constraints refer to anchors by `VectorAnchor.id`; code that copies anchors field by field (`mapAnchor`, `reverseSubpath`, `pathMap`'s mapper, the shape-keeping delete) dropped the new field, so the solver's purge removed constraints whose anchors it could no longer find (the same trap as live corners).
- **Solution / Workaround**: Copy anchors with `cloneAnchor`, or add `...(a.id ? { id: a.id } : {})` to hand-built copies. Ids are given lazily (only to anchors a constraint refers to), so most documents never carry them. Operations that rebuild a path from scratch (booleans, Outline Stroke, Expand) do drop them, and the constraints go with them.

### [core/vector] Dimensionless Constraint Rows Converge Too Loosely Over Long Segments

- **Issue / Symptom**: Two segments constrained perpendicular were 4 × 10⁻⁶ units off at their far ends while the solve reported success.
- **Root Cause**: The solver's tolerance is in document units (1e-9 of the largest coordinate), but a cross product of unit vectors is dimensionless: a residual just under the tolerance still turns into a visible offset over a 60-unit segment.
- **Solution / Workaround**: Express every row in length units: parallel / perpendicular use one unit direction and one full segment, tangent at an anchor uses the outgoing handle's length, and angle rows are radians times the segments' mean length. New residuals should follow the same rule.

### [core/vector] The Solve After Every Edit Needs to Know What Was Just Edited

- **Issue / Symptom**: Dragging a constrained anchor left it short of the pointer; the solver pulled it back towards the rest.
- **Root Cause**: A minimum-norm solve moves every free parameter a little. Without weights, the dragged anchor takes its share of the correction.
- **Solution / Workaround**: The controller keeps the last solved document; `solveVectorConstraints(doc, previous)` gives every parameter that differs from it a weight of 10⁶, so edited geometry (dragged, typed by a command, undone) moves least and the dependent geometry follows. Checks that need exact positions should compare constrained quantities, not the dragged anchor's coordinates.

### [core/vector] Instances Carry Their Symbol's Art, Because Geometry Sees One Node at a Time

- **Issue / Symptom**: Bounds, hit-testing, rendering and export of an instance came back empty, or stale after the symbol changed.
- **Root Cause**: Every geometry helper takes a node, not the document, so an instance cannot look its symbol up. A module-level lookup would also go stale whenever an edit creates a new instance object (moves spread the node).
- **Solution / Workaround**: Instances carry `art`, the symbol's own `nodes` array, resolved by `resolveVectorSymbols` in the controller's `refreshed()` (with the blend refresh) and on load; spreads carry it along. Storage strips it (`toJSON`, `stripVectorSymbolArt`), and `vectorDocumentToSvg` resolves documents that come without it. Code that builds documents outside the controller should call `resolveVectorSymbols` before measuring instances.

### [core/vector] An Instance's Transform Scales, So Draw It Through a Group Whose Transform Stays Rigid

- **Issue / Symptom**: Strokes in scaled instances hit-tested at the wrong width, and filters and distance tolerances were off.
- **Root Cause**: Everything else in the editor relies on rigid node transforms (local distances are document distances). An instance is the one node whose transform may scale and skew.
- **Solution / Workaround**: `vectorInstanceGroup` splits the instance's matrix with `decomposeRigid`: the rotation goes on the drawn group, the scale and skew are baked into the art (`transformVectorNode`), and strokes are multiplied by √|det| unless `scaleStrokes` is false. Everything downstream sees ordinary nodes. Anything that reads `nodeMatrix(instance)` directly (it is the full matrix) must go through `vectorInstanceDrawn` instead, as `vectorChildAppearanceShapes` and the overlay outline do.

### [core/vector] Isolation Mode Swaps the Controller's Document, So Snapshots Must Carry It

- **Issue / Symptom**: After leaving a symbol, Undo put the symbol's art in place of the whole document.
- **Root Cause**: Editing a symbol in isolation makes the controller's `doc` the art, so every command works unchanged; history snapshots taken there hold that art.
- **Solution / Workaround**: Snapshots keep the isolation context (`symbolEdit`, with the host document), and `restore` steps into or out of isolation with the view following (`viewInto` / `viewOutOf`). `toJSON`, `toSvg` and `onChange` compose the whole document (`storedDocument`). Entering and leaving are not undo steps themselves.

### [core/text] `r.pos += r.u16()` Reads the Old Position Before the Call Advances It

- **Issue / Symptom**: The OpenType reader drew garbage glyph outlines (points shifted and mixed on and off curve) for a valid TrueType font.
- **Root Cause**: In `x += f()` JavaScript reads `x` before calling `f`, so `r.pos += r.u16()` added the instruction length to the position from before the two-byte length was read, landing two bytes short.
- **Solution / Workaround**: Read into a local first (`const n = r.u16(); r.pos += n;`). Watch for the same pattern with any reader whose methods move a cursor.

### [core/vector] Text Lays Out with One Page-Wide Shaper, and Caches Key on It

- **Issue / Symptom**: After loading fonts (`setTextShaper`), text kept its old glyphs: expanded appearance, bounds and outlines were cached per node object, and the node objects had not changed.
- **Root Cause**: Geometry helpers (`vectorNodeBounds`, `expandVectorAppearance`, hit-testing) are pure functions of the node, with no editor to ask for fonts, so text reaches its shaper through a module-level setting (`setVectorTextShaper`). Every cache keyed only by node object went stale when it changed.
- **Solution / Workaround**: `setVectorTextShaper` bumps a generation that the appearance caches (`shapeCache`, `outlineCache`, `expandCache`) and the text caches store with each entry, and `controller.setTextShaper` also gives every text node a new object so views keyed on the document draw again. The shaper is shared by every vector editor on the page: set it once, before documents load where possible. Web fonts must be loaded before the Canvas shaper measures them, or the fallback's widths are cached.

### [core/vector] Text Without Glyph Outlines Draws as SVG Text but Has Box Geometry

- **Issue / Symptom**: With the browser's (Canvas 2D) shaper, path effects and envelopes on text did nothing visible, and hit-testing, snapping and bounds used rectangles rather than letter shapes.
- **Root Cause**: Canvas 2D measures and draws text but cannot give glyph outlines. Without outlines, text renders as SVG `<text>` (placed character by character from our layout, so it matches the measurements), and its geometry is a box per line fragment (a box per character on a path).
- **Solution / Workaround**: Effects need geometry to act on, so `vectorAppearanceShapes` skips a text node's effects while it has no outlines (they stay stored and apply as soon as an outline shaper is set). Create Outlines refuses with the reason. Hosts that need effects on text or font-independent SVG load font files (`loadOpenTypeFont`) into `createOutlineTextShaper`; the demo's "Load fonts…" button does this.

### [react|svelte/vector] The Hidden Textarea Must Not Forward Printable Keys, and Must Stop Its Events

- **Issue / Symptom**: Typing "v" into text switched to the Select tool, and typed characters were inserted twice.
- **Root Cause**: The canvas `<svg>` handles tool shortcuts on `keydown`, and the textarea sits inside it, so its key events bubbled to the canvas; forwarding every key to `controller.keyDown` also inserted characters that the textarea's `input` event delivers again.
- **Solution / Workaround**: The textarea stops propagation of its key and clipboard events, lets printable keys (no Cmd / Ctrl) through to the browser so they arrive as `input` (and as `compositionend` for IME), and forwards only editing keys and shortcuts to `controller.keyDown`, whose text mode handles them (and swallows other Mod shortcuts while editing). Keys typed while the canvas itself has focus are inserted by the controller.

### [core/video-editor] A Frame Cache Keyed by Clip Is Thrown Away by Every Edit

- **Issue / Symptom**: Keyed by clip and timeline frame, as a sequencer's final-frame cache is, every trim, slip or move invalidated frames whose pictures had not changed. Two clips cut from one shot each decoded it again.
- **Root Cause**: Timeline keys describe where a picture shows, not what it is.
- **Solution / Workaround**: `VideoFrameCache` keys raw source frames by the file the preview plays (the asset's `src`, or the proxy it picks) and the source frame on the project's fps grid. Grades, LUTs and compositing still happen at draw time. Each entry keeps the timeline time it is next needed at (refreshed in the prefetch window) for eviction only. Decode at the middle of a frame (`videoSourceFrameTime`) so rounding never lands on the frame before. While playing, the engine draws the `<video>` element; it uses cached frames only when paused, scrubbing or mid-seek, because a playing element is already current.

### [core/video-editor] Proxies Must Match the Original Frame for Frame, and Camera Files Seek Slowly

- **Issue / Symptom**: Scrubbing 4K camera footage in the preview lagged by seconds. A proxy made with a frame-rate change or a trimmed start played the wrong frames for every clip.
- **Root Cause**: Camera and phone H.264/HEVC often has a keyframe only every one to several seconds, so each seek decodes from the previous keyframe at full size. The preview seeks a proxy to the clip's source time, so a proxy is only correct when its timeline is identical to the original's.
- **Solution / Workaround**: `videoProxyFfmpeg` scales the video only. It keeps the frame rate and start, uses `-g`/`-keyint_min` 12 with `-sc_threshold 0 -bf 0` for cheap seeks, and keeps the sound so a video element can play both. The real-ffmpeg test checks size, keyframe count, duration and that the same moment shows the same picture. Proxies never reach `toVideoFfmpeg` or `toVideoEdl`.

### [core/video-editor] A LUT Cannot Be a Canvas or SVG Filter, and ffmpeg's `lut3d` Reads Only Files

- **Issue / Symptom**: There is no CSS or canvas `filter` for a 3D LUT, SVG filters have only per-channel tables and a 4 × 5 matrix, and `lut3d=file=https://…` (or a blob URL) fails in ffmpeg.
- **Root Cause**: A 3D LUT mixes all three channels non-linearly, which neither `feComponentTransfer` nor `feColorMatrix` can express. `lut3d` opens its `file` with the local file system, not ffmpeg's protocol layer.
- **Solution / Workaround**: The preview draws a LUT layer on a scratch canvas (`willReadFrequently`), runs `getImageData` through `applyVideoLutToPixels` (tetrahedral, like `lut3d=interp=tetrahedral`), then lays it on with the layer's opacity and blend. SVG frames use `videoLutSvgApproximation`: curves along the grey axis, then a least-squares matrix, exact for LUTs that are only curves or only a matrix. The `feComposite` that mixes by strength needs the pre-LUT picture as a named `result`. The export maps `src` to a path with `resolveLut` and notes URLs. A grade with only a LUT has an empty CSS filter: set `ctx.filter = 'none'`, since `''` is ignored and the last filter stays.

### [core/video-editor] Scopes Read a Stale Picture While a `<video>` Seeks, and Nothing From a Cross-Origin One

- **Issue / Symptom**: `get_video_scopes` at another time measured the frame the preview showed before the seek. With media from another origin, reading the preview canvas threw "The operation is insecure".
- **Root Cause**: After `currentTime` is set, a `<video>` keeps `readyState >= 2` and draws its old frame until `seeked` fires. A canvas that has drawn cross-origin media without CORS is tainted, and `getImageData` throws a `SecurityError`.
- **Solution / Workaround**: `VideoPreviewEngine` marks a frame incomplete while any media layer is missing or `seeking`, and `VideoPreviewPixels.next(time)` waits for a complete drawing of that time (or times out with a reason). Serve media with `Access-Control-Allow-Origin` (the engine sets `crossOrigin = "anonymous"`); `VideoPreviewPixels.read()` turns the `SecurityError` into a message that says so. Luma computed from equal channels can come out a hair under the value (39.99999…), so scope bins are nudged before flooring.

### [core/image-editor] Quick Mask Painting Writes the Selection, Not a Layer

- **Issue / Symptom**: In Quick Mask mode, paint results report `layerId: 'quick-mask'`, which `getLayer` does not know. Code that looks up the painted layer from a result, or that limits a stroke by the selection, goes wrong.
- **Root Cause**: The `quick-mask` paint target (`LayerTarget`) is the selection as a 1-channel surface. `_strokeUpdate`, `_strokeCommit` and `fillOrClear` turn the painted surface back into `state.selection`, and undo restores it from the history entry's `selection`. The selection must not clip strokes on this target, because it is what is being painted.
- **Solution / Workaround**: Check `channel === 'quick-mask'` (or `QUICK_MASK_TARGET`) before using a result's `layerId`. New paint paths that commit through `withSurface` must branch on `quick-mask` the same way. Quick Mask surfaces are always 8-bit, even in 16- and 32-bit documents.

### [core/image-editor] A Command Built From Other Commands Must Run in `asOneStep`

- **Issue / Symptom**: Paste Into (a new layer, then its mask), Cut (copy, then clear) and a smart filter added with a selection (the filter, then its mask) took two undo steps. One undo left a layer without its mask, or a filter whose mask had already gone.
- **Root Cause**: Each public command (`addPixelLayer`, `addLayerMask`, `clearPixels`, `setSmartFilterMask`) records its own history step through `commitLayers`. `setSmartFilterMask`'s `commitToHistory = false` does not help when the step before it was recorded by a different call.
- **Solution / Workaround**: Wrap the calls in the controller's private `asOneStep(fn)`. It records one step before `fn`, and `recordHistory` is a no-op while it runs. If `fn` throws, the step is dropped and the state is restored, so a failure never leaves half a change. Test each composite command with a single `undo()`.

### [core/image-editor] AI Results Must Be Computed From the Composite When They Become Layers

- **Issue / Symptom**: Sending the original source image to an inpainting hook in a layered document would give a result that ignores everything painted on the layers above. Added as a new layer on top, it would then hide those edits inside the selection.
- **Root Cause**: `toSourceDataURL()` is the Background's source, which the old replace flow needed because the result replaced that source.
- **Solution / Workaround**: `toAIInputDataURL(options)` returns the source in replace mode and the composite without annotations (`renderSourceView({ includeAnnotations: false })`) in new-layer mode. The editors call it with the same target they pass to `applyInpaintedImage` / `applyBackgroundRemovedImage`.

### [core/image-editor] "Multi-Layer" for the AI Hooks Counts Pixel Layers and Groups Only

- **Issue / Symptom**: Counting every layer would switch old documents with adjustment layers or annotation scribbles to the new-layer behaviour, changing how inpainting worked for them.
- **Root Cause**: Since phase 1, adjustment layers and annotations are layers, but they were never separate images.
- **Solution / Workaround**: `isMultiLayer` counts pixel layers and groups. The UI shows which behaviour "Auto" will use, and `target` overrides it.

### [core/image-editor] Dirty Rectangles Are Only Safe on a Compositor That Sees One Stack

- **Issue / Symptom**: A design to recomposite only the dabs' rectangles during a stroke could leave stale pixels when the same compositor had meanwhile composited a different layer list (an export of chosen layers, `compositePixels`, a merge).
- **Root Cause**: The partial path copies the tile's previous result outside the dirty rectangle. That is only correct when the previous result was computed from the same stack, differing just inside the rectangle.
- **Solution / Workaround**: The viewport has its own `LayerCompositor`, and exports, `compositePixels`, merges and sampling use others. The controller's `pendingDirty` collects stroke rectangles and resets to `'all'` on any other change, so a render after, say, an opacity change never takes the partial path.

### [core/image-editor] A Stroke Must Recomposite From the Pre-Stroke Tile, Not the Last Live One

- **Issue / Symptom**: Compositing each new batch of dabs over the stroke's previous live result would paint overlaps twice, so strokes would go darker than their opacity.
- **Root Cause**: Stroke coverage is cumulative (build-up towards the opacity ceiling), and the stroke composites once at the stroke opacity. Compositing the coverage over pixels that already hold part of the stroke applies it again.
- **Solution / Workaround**: `PaintStrokeSession` keeps the pre-stroke surface. For each touched region it copies the pre-stroke pixels back into the live tile and composites the whole coverage there (`applyStrokeToTile` with `into` and `region`).

### [react|svelte/image-editor] Mice Report Pressure 0.5

- **Issue / Symptom**: Strokes drawn with a mouse would come out at half size with "pressure controls size" on.
- **Root Cause**: Pointer Events report `pressure` 0.5 for a pressed mouse button (and 0 for a pen on `pointerup`).
- **Solution / Workaround**: `pointerPressure` uses the reported pressure only for `pointerType === 'pen'` with a value above 0, and 1 otherwise.

### [core/image-editor] Merge Down Only Looks the Same Over an Opaque, 100 % Normal Lower Layer

- **Issue / Symptom**: Tests that expected Merge Down to leave the image unchanged failed: with a faded lower layer, or a Screen layer above a lower layer with transparent areas, the merged result looked different.
- **Root Cause**: Merging composites the upper layer onto the lower one in isolation and keeps the lower layer's opacity and blend. A faded lower layer then fades the merged content too, and the upper blend mode no longer sees the layers below the lower one where the lower one is transparent. Photoshop behaves the same way.
- **Solution / Workaround**: This is the intended behaviour. Test merges over an opaque, 100 % normal lower layer when you expect identical pixels, and check the other cases against the isolated composite. The image-editor skill tells agents the same.

### [core/image-editor] Compositing in Document Space Cannot Reproduce Every Old Render

- **Issue / Symptom**: Moving the image editor to a layer compositor that works in document space and projects afterwards changed some old documents by a level here and there: rotated by a non-quarter angle, cropped at fractional coordinates, depth-masked, faded with output opacity, or blurred with a crop or a 90° turn.
- **Root Cause**: The old renderer drew the cropped, rotated source first and adjusted the projected pixels; blur ran on that buffer (clamping at the crop edge, with its two passes swapped by a quarter turn) and the depth mask and opacity rounded alpha in a fixed order. Per-pixel operations commute with crops, flips and quarter turns, but not with resampling, and box blurs and repeated alpha rounding do not commute with each other.
- **Solution / Workaround**: Documents that still have the exact v1 / v2 shape (`isLegacyShape`) take the old base path in exactly those cases (`needsLegacyBase` in `layers/render.ts`; the list is in `docs/image-editor-layers.md`). Everything else uses the compositor. `tests/image-layers-equivalence.test.ts` requires byte equality for every random old document the compositor renders; when you change either path, keep that test green and add a routing case rather than accepting a difference.

### [core/image-editor] Consecutive Adjustment Layers Must Composite as One Float Pass

- **Issue / Symptom**: Rounding to 8 bits after every adjustment layer made migrated documents with several adjustment layers differ by one level in places.
- **Root Cause**: `applyAdjustmentLayers` evaluates the whole stack in float per pixel and rounds once at the end.
- **Solution / Workaround**: The compositor groups adjacent, unclipped adjustment layers into one step and calls `applyAdjustmentLayers` with all of them (masks as per-layer coverage planes). The prefix cache works per step, so its checkpoints sit at run boundaries.

### [core/image-editor] The Viewport Must Draw a Layered Document the Same Two-Step Way

- **Issue / Symptom**: At zooms other than 1, a few viewport pixels of a layered document differed by one level from the old render of the same pixels.
- **Root Cause**: The old path drew the rotated base canvas at scale 1, then scaled it into the viewport. Drawing the composite straight through rotation and scale in one `drawImage` samples differently on the GPU.
- **Solution / Workaround**: `layeredBase` in `renderer.ts` draws the composite into a cached base canvas through `baseProjection` (crop, rotation, flips at scale 1), then the viewport draws it with the same call the legacy path uses. Both paths are then identical at every zoom.

### [core/image-editor] Canvas PNG Round Trips Lose Partly Transparent Colours

- **Issue / Symptom**: Painted pixels with alpha below 255 came back with slightly different colours after saving layers as PNG through a canvas and loading them again.
- **Root Cause**: Canvas 2D stores premultiplied alpha, so `putImageData` / `toDataURL` / `getImageData` round colours of partly transparent pixels (and drop the colour of transparent ones). `toDataURL` is also the only synchronous canvas encoder, and there is none in Node or workers.
- **Solution / Workaround**: Layer assets use the TypeScript PNG codec in `raster/png.ts` (with `raster/zlib.ts`), which is exact, synchronous and DOM-free. Encodings are memoised per surface, so saving unchanged layers costs nothing.

### [core/tests] Failing `toEqual` on Large Typed Arrays Hangs Vitest

- **Issue / Symptom**: A deliberately broken compositor made an equivalence test run for minutes instead of failing.
- **Root Cause**: When `expect(a).toEqual(b)` fails on arrays of hundreds of thousands of elements, Vitest builds a full diff of them, which is very slow.
- **Solution / Workaround**: Compare large pixel buffers with a loop that throws at the first differing byte (`expectSameBytes` in `tests/image-layers-equivalence.test.ts`). Keep `toEqual` for small buffers.

### [core/image-editor] Lifting Stored Adjustments Must Keep a Missing `process` Legacy

- **Issue / Symptom**: Old documents without `process` loaded on process 2 after the move to layers, so they looked different and were re-saved with `process: 2`.
- **Root Cause**: `{ ...DEFAULT_ADJUSTMENTS, ...stored }` fills a missing `process` with the new default (the same trap as the process-version entry below).
- **Solution / Workaround**: `layersFromLegacy` normalises stored adjustments the way `normalizeStoredAdjustments` does: defaults only when nothing is stored, otherwise `process: normalizeProcessVersion(stored.process)`.

### [core/video-editor] Speed Ramps: Browsers Refuse Very Slow Rates, and ffmpeg Freezes Come From `fps`

- **Issue / Symptom**: The preview threw or ignored a freeze frame when it set a `<video>`'s `playbackRate` to 0. In the ffmpeg export, there was no obvious way to make one source frame last a second.
- **Root Cause**: Browsers only accept playback rates from about 1/16 up (Chrome throws below 0.0625). In ffmpeg, `setpts` can only move each source frame to a new time; it cannot repeat a frame.
- **Solution / Workaround**: `VideoPreviewEngine` treats any speed under 1/16 as frozen: it pauses the element and seeks it every tick, as when paused. The export uses `setpts` to move each source frame to the clip time the ramp first shows it (the ramp's inverse; frames inside a freeze are skipped), then `fps` repeats frames to fill slow stretches and freezes, and `tpad` holds the ends. Sound cannot be re-timed continuously, so it is cut into straight stretches, each with its own `atempo` (silence for freezes), and joined with `concat`.

### [core/video-editor] ffmpeg `geq` and `rotate` Freeze an Animated Size, and `rotate` Loses Transparency When Its Angle Moves

- **Issue / Symptom**: A clip with keyframed scale stayed at its first size in the ffmpeg export whenever it also had keyframed opacity, a wipe, an iris or a rotation. A clip with keyframed rotation rendered with an opaque box around it.
- **Root Cause**: `geq` and `rotate` set their frame size from the first frame, so a `scale=...:eval=frame` before them has its later sizes frozen. And with a time-varying angle, `rotate=...:c=none` fills the uncovered corners with opaque pixels (only a constant angle gets transparent ones). Both were hidden in tests by the frozen size: a smaller picture passed the same pixel checks.
- **Solution / Workaround**: The animated `scale` goes last in a clip's chain, after every `geq` and `rotate`, scaling by `iw` / `ih` (uniform scale and rotation about the centre commute, so the picture is the same). `rotate` uses `c=black@0`, which keeps the corners transparent for any angle. When a pixel test checks an animated size, also check it at a time when the size has changed.

### [core/video-editor] ffmpeg `blend` Is Not Symmetric, and the Input Order Differs by Mode

- **Issue / Symptom**: Overlay, hard-light, dodge, burn and soft-light layers rendered differently in the ffmpeg export from the browser preview, even though the mode names matched.
- **Root Cause**: `blend` takes a first ("top") and a second ("bottom") input, and the non-symmetric modes use them differently from CSS. Measured against the W3C compositing formulas: `overlay`, `hardlight` and `softlight` match when the backdrop (the composite) is the first input, but `dodge` and `burn` divide by their first input, so they match only when the layer comes first. ffmpeg's `softlight` uses a different formula in any order (up to about 10/255 off). `blend` also works per plane, so blending in YUV gives wrong colours.
- **Solution / Workaround**: `toVideoFfmpeg` converts both inputs to `gbrap`, puts the composite first except for color-dodge and color-burn, and adds a note for soft-light. To add a mode, measure it against the CSS formula in both orders before choosing (`tests/video-editor-ffmpeg.test.ts` has pixel checks).

### [core/video-editor] ffmpeg `loudnorm` Outputs 192 kHz Audio

- **Issue / Symptom**: A normalised export came out with 192 kHz sound, much larger than it should be, and some players or encoders refuse that rate.
- **Root Cause**: `loudnorm` upsamples to 192 kHz internally so it can measure true peaks, and it passes that rate on to whatever follows it in the graph.
- **Solution / Workaround**: Always follow it with `aresample=48000`, as `loudnormFilter` in `export.ts` does. Two-pass normalisation also needs the measuring pass to use the same target (`I`, `TP`, `LRA`) as the second pass; `toVideoLoudnessMeasure` takes the same `loudness` option for that reason.

### [core/video-editor] An Hour of 29.97 fps Is Not `01:00:00:00` in Non-Drop Timecode

- **Issue / Symptom**: With drop-frame turned off at 29.97 fps, an EDL's record timecode started at `00:59:56:12` instead of `01:00:00:00`.
- **Root Cause**: The record start was a clock time (3,600,000 ms). Non-drop timecode counts 30 labels a second while only 29.97 frames pass, so an hour of real time is 107,892 frames, which non-drop labels `00:59:56:12`. Drop-frame skips labels so that it matches the clock.
- **Solution / Workaround**: Count timecode positions in frames, not milliseconds: `videoHourFrames(fps, dropFrame)` gives the frame count of `01:00:00:00` (107,892 in drop-frame, 108,000 in non-drop), and `formatVideoTimecodeFrames` formats a frame count. Count frames at the exact NTSC rate (30000/1001), not a rounded 29.97.

### [core/video-editor] ffmpeg `afade` Curves Are Mirrored for Fade-Outs

- **Issue / Symptom**: Exponential fade-outs sounded different in the browser preview and in the ffmpeg export.
- **Root Cause**: `afade=t=out` applies the curve to the time *remaining*, gain = f(1 − progress); it does not flip the curve upside down to 1 − f(progress). For `cub`, a fade-out drops fast at first and then tails off.
- **Solution / Workaround**: `videoFadeCurveGain` takes the fraction left for a fade out, as ffmpeg does. The curve formulas were measured from ffmpeg itself (`tri`, `qsin`, `hsin`, `cub`, `ipar`), and `tests/video-editor-ffmpeg.test.ts` compares the rendered levels with `videoFrameAt`. When adding a curve, measure ffmpeg's version before writing the formula.

### [core/tools] `capture_view` Screenshots Miss Web Fonts, Pseudo-Elements and Cross-Origin Images

- **Issue / Symptom**: A canvas or DOM screenshot from `rasterizeElement` (used by `createCanvasCaptureToolProvider` and `createElementCaptureSurface`) shows text in a fallback font, leaves out `::before` / `::after` content, draws some images blank, or fails with "the canvas is tainted".
- **Root Cause**: The element is cloned with its computed styles inlined and drawn as an SVG `<foreignObject>` image. An SVG used as an image cannot load anything external, so web fonts and `<img>` URLs are not fetched; same-origin images are copied in as data URLs, cross-origin ones cannot be read. Pseudo-elements are not part of the DOM, so they are not cloned. Safari has tainted canvases that drew a `foreignObject`.
- **Solution / Workaround**: For pixel-exact output, pass `rasterize` to the surface options and use a library such as html-to-image (it embeds fonts) or a server-side renderer. Mark UI that should never show with `data-capture="exclude"` and transient overlays with `data-capture="overlay"`. Non-viewport canvas regions re-frame the xyflow viewport transform and remove everything outside it (the background pattern and screen-space layers follow the live viewport, so they would be misplaced).

### [core/video-editor] A Ripple Is Refused Because of a Music Bed or Title on Another Track

- **Issue / Symptom**: `delete_clips` / `trim_clip` with `ripple`, or `extract_range`, fails with "Rippling out … would pull track "a1" out of sync: clip "music" … is in that stretch", even though the edited track itself has room.
- **Root Cause**: Tracks are sync-locked by default (`syncLocked` unset = true). A ripple moves every unlocked sync-locked track by the same spans (merged across tracks, closed right to left), so nothing drifts out of sync. Closing time where another sync-locked track still has a clip would have to delete part of that clip, so it is refused instead. Opening time (insert, ripple trims that lengthen) never refuses: it cuts the clips across the edit point on those tracks, which is why `insert` leaves `music-1` style right-hand parts behind.
- **Solution / Workaround**: Turn `syncLocked` off on a track that should stay put (a music bed), lock it, put it in the range edit's `tracks`, or lift instead of rippling. Tests with a long music clip under a rippled cut must do one of these. A property test that inserts then extracts the same range compares tracks with continuing cuts joined up (the split parts stay split), and exactly only when nothing ran across the insert point.

### [svelte/video-editor] Shift-Dragging a Clip Overwrites Only When Shift Is Pressed After the Drag Starts

- **Issue / Symptom**: In the Svelte timeline, holding Shift before pressing on a clip adds it to the selection and the drag does nothing; overwrite only happens if Shift is pressed once the clip is moving.
- **Root Cause**: Svelte's `onclipdown` treats Shift / Cmd / Ctrl at pointer-down as additive selection and turns editing off for that gesture. The placement mode (Alt = insert, Shift = overwrite) is read from each pointer-move, so a modifier held from the start never reaches a drag.
- **Solution / Workaround**: Press Shift after the drag has started (tests send `shiftKey` on the move and up events only). React reads the modifiers on move and up too, so the same gesture works in both.

### [core/video-editor] Keyframed Clip Values Are Not Numbers, and ffmpeg's `t` Means Two Things

- **Issue / Symptom**: Code that reads `clip.opacity ?? 1`, `clip.volume` or `clip.transform.x` and does arithmetic gets `NaN` or `[object Object]` once a property is keyframed. In the ffmpeg export, an animation lands early or late by the clip's start or by its transition lead.
- **Root Cause**: `opacity`, `volume` and the transform's fields are `number | { keys }` (`VideoAnimatable`), with key times in clip time (ms from the clip's start). In the filter graph, `t` / `T` on a clip's own chain (`scale`, `geq`, `rotate`, the audio `volume`) counts from the clip's first rendered frame, which is `start − lead` when a transition plays before the cut; on `overlay` and `drawtext`, which run on the composite, it is timeline time.
- **Solution / Workaround**: Always read these through `videoValueAt(prop, clipTime, default)` (or `videoTransformAt`). In the export, convert with `(t*1000-lead)` on the clip chain and `(t*1000-start)` on the composite (`onChain` / `onTimeline` in `toVideoFfmpeg`). Do not use `st()` / `ld()` in `geq` expressions: slice threads share the variables. A title drawn as an image (`titleImage`) gets the clip without its transform when the transform is keyframed, and the export moves the full-frame image instead.

### [core/video-editor] Homebrew's ffmpeg Has No `drawtext`

- **Issue / Symptom**: Rendering a project with titles fails at once with `Filter not found`, although every other filter in the graph exists.
- **Root Cause**: `drawtext` needs ffmpeg built with libfreetype. Homebrew's `ffmpeg` formula (9.x) is built without it, and so are other slim builds.
- **Solution / Workaround**: Pass `titleImage` to `toVideoFfmpeg`. Each title then goes in as a transparent full-frame PNG, overlaid like a still with its opacity and fades. In a browser, draw `videoTitleFrame(project, clip)` with `drawVideoFrame` and save the canvas. The export's notes mention `drawtext` whenever it is used. `tests/video-editor-ffmpeg.test.ts` checks `ffmpeg -filters` and falls back to a title image.

### [react|svelte/video-editor] A Clip Dragged to Another Track Loses Its Pointer Capture

- **Issue / Symptom**: Dragging a clip into another track's row stopped following the pointer, and releasing it did nothing.
- **Root Cause**: The clip block is rendered inside its track's row. Once the drag preview moves it to another row, the framework remounts the block under a new parent, so the element that called `setPointerCapture` is gone and its `pointermove` / `pointerup` handlers never fire again.
- **Solution / Workaround**: Follow the drag with `pointermove`, `pointerup` and `pointercancel` listeners on `window`, added at pointer down and removed on release, instead of handlers on the clip element.

### [react|svelte/video-editor] Testing `<VideoPreview>` in jsdom

- **Issue / Symptom**: Preview tests log "Not implemented: HTMLCanvasElement.prototype.getContext" and "Not implemented: HTMLMediaElement's pause()" / "load()", and nothing can be asserted about drawing.
- **Root Cause**: jsdom implements neither canvas drawing nor media playback.
- **Solution / Workaround**: `VideoPreviewEngine` accepts a null context and injectable `createMedia` / `context`. In component tests, stub `HTMLCanvasElement.prototype.getContext` (null, or a recording Proxy to assert draws) and `HTMLMediaElement.prototype.pause` / `load`. In Svelte, don't put `role="img"` on the `<canvas>` (svelte-check treats canvas as interactive); an `aria-label` is enough.

### [core/video-editor] ffmpeg `drawtext` Text Needs Escaping Twice

- **Issue / Symptom**: A title with a colon, apostrophe or comma (`It's 10:30, live`) breaks the ffmpeg render with "No option name near…" or a truncated title, even though the args are passed without a shell.
- **Root Cause**: A filtergraph is parsed at two levels: the graph splits on `,` `;` `[` `]` and quotes, then each filter splits its options on `:` and drawtext expands `%`. Each level consumes one layer of backslashes.
- **Solution / Workaround**: Escape option-level characters (`\ ' : %`) first, then graph-level characters (`\ ' [ ] , ;`) — `ffmpegFilterValue` does both in that order. Do not add shell quoting on top when passing `args` to `spawn`; only `command` (the one-line string) is shell-quoted.

### [core/video-editor] A Dip Must Not Use Handles, or Valid Cuts Are Refused

- **Issue / Symptom**: Setting a dip-to-black between two clips trimmed to the very ends of their media was refused for lack of handles, and the preview played a moment of the next clip's audio before the cut.
- **Root Cause**: Crossfades and wipes play both clips past the cut (half the transition each side), so they need media beyond the out and in points. A dip only shows the outgoing clip before the cut and the incoming one after it, under the colour, but the shared overhang code treated it like a crossfade.
- **Solution / Workaround**: `videoClipOverhang`, `checkVideoProject` and the ffmpeg export treat a dip as needing no handles, and `videoFrameAt` skips the hidden half of each clip for pictures and sound. Any new transition type must decide which side of the cut each clip plays on and update all of these together.

### [core/video-editor] Snapping a Moved Clip Must Ignore the Edge That Did Not Snap

- **Issue / Symptom**: Dragging a clip so its end lands near another clip's start did not snap; the clip stayed exactly where the pointer left it.
- **Root Cause**: `planVideoClipDrag` snaps both the head and the tail and keeps whichever moved the clip less. An edge with no snap point nearby "moves" it by 0, so it always won.
- **Solution / Workaround**: Only edges that actually snapped (a non-zero shift) compete; with none, the raw position is kept.

### [svelte] A Local Named `state` Breaks `$state` Runes in the Same Component

- **Issue / Symptom**: `svelte-check` reports "Cannot use 'state' as a store. 'state' needs to be an object with a subscribe method" on every `$state(...)` call in a component, although the runes work at runtime and in tests.
- **Root Cause**: In a component with a top-level variable `state`, Svelte reads `$state` as a store auto-subscription to that variable instead of as the rune.
- **Solution / Workaround**: Don't name a component-level variable `state` in a component that uses `$state`. The animation-editor panels call the controller snapshot `editor` (`const editor = $derived(view.current)`). Older components that never use the rune, such as `ShotTimeline.svelte`, can keep `state`.

### [react|svelte/animation-editor] A Panel's Own Error Hides the Controller's Newer One

- **Issue / Symptom**: A panel showed "Effect needs a target…" (its own validation message) after a later edit was refused by the controller, so the newer, real reason never appeared.
- **Root Cause**: The panels show `localError ?? state.error`. A local message set before the refusal is never cleared, so it keeps winning.
- **Solution / Workaround**: Store the local message with the controller's `revision` at the time and show it only while `state.revision` is unchanged. Any change to the editor, including a refusal (which bumps the revision), hands the line back to `state.error`.

### [core/animation-editor] Flair Catalog Presets Hold Colours as `[r, g, b]` Arrays

- **Issue / Symptom**: Scenes imported from real Flair catalog effects (`checkbox`, `bookmark`…) had presets whose values were arrays like `[0.13, 0.7, 0.4]`, although `MotionPreset.values` expects colour strings.
- **Root Cause**: Flair's `EffectPreset.values` are `ControlValue`s. For colour controls these are channel arrays from 0 to 1, which Flair turns into hex with `rgbToHex`. The editor's mirror type assumed hex strings.
- **Solution / Workaround**: `fromFlairVectorEffect` converts arrays the same way Flair does: each channel is clamped to 0–1, multiplied by 255, rounded and written as hex. `FlairVectorEffect.presets` now types both forms.

### [core/agent-caret] Typing an Agent Edit Out Frame by Frame Breaks Undo Unless the Frames Stay Out of History

- **Issue / Symptom**: Dispatching an agent's text a few characters at a time left one undo step per frame, or merged the frames with whatever the user typed in the same half-second.
- **Root Cause**: `prosemirror-history` records every transaction unless it has `addToHistory: false`, and it groups adjacent ones by time (`newGroupDelay`, 500 ms). It has no way to group a set of transactions by their source.
- **Solution / Workaround**: `typeAgentText` dispatches frames with `addToHistory: false` (and `TRACK_CHANGES_SKIP_META`). At the end it rolls them back by applying the frames' inverted steps, then dispatches the whole edit once with history. Both dispatches happen in the same tick, so the screen never shows the rollback. If someone else edited while the agent typed (the plugin marks its span `foreign`), it replaces the typed span with the original slice instead. Also, a transaction holds only one meta per plugin key, so the typed span and the caret are set in separate transactions.

### [demo] An Agent Cursor Animated With `requestAnimationFrame` Hangs in a Hidden Tab

- **Issue / Symptom**: A scripted agent run (the demo's "Ask the agent" panel) stopped partway with its buttons disabled when the page was in a background tab or a hidden preview pane.
- **Root Cause**: The cursor glide awaited a promise resolved from a `requestAnimationFrame` loop, and browsers do not run animation frames for hidden documents, so the promise never settled and the next tool call never ran.
- **Solution / Workaround**: Jump straight to the target when `document.hidden`, and also resolve the glide from a `setTimeout` a little after its duration (as Ursula's director skips animation in hidden tabs). Never make agent tool calls wait on animation frames alone.

### [react|svelte/chart] Inline SVG Colours Must Use `var(--x, fallback)`, Not shadcn's `hsl(var(--x))`

- **Issue / Symptom**: A chart theme written as `hsl(var(--foreground))` drew black text and invisible grid lines in the demo.
- **Root Cause**: The demo (and the other components' inline styles) define `--foreground`, `--border`, `--primary`, … as full colours (`rgb(...)`) plus `--x-rgb` channels for Tailwind. Only shadcn's own CSS stores bare HSL channels, so `hsl(var(--x))` is invalid everywhere else. SVG presentation attributes also don't reliably resolve `var()`.
- **Solution / Workaround**: `CSS_VARIABLE_CHART_THEME` uses `var(--foreground, #0f172a)`-style values (as `SpreadsheetEditor` does), and the canvases put colours in `style`, not `fill=` / `stroke=` attributes. The demo defines `--muted-foreground` for it.

### [react|svelte/chart] Tooltip Colours Need Chained Fallbacks, Not a Fixed One

- **Issue / Symptom**: In the dark demo, the chart tooltip drew its title and values in near-black on a near-black background. The swatches and series names were visible.
- **Root Cause**: The tooltip used `var(--popover, #ffffff)` and `var(--popover-foreground, #0f172a)`. The demo defines `--popover` (dark) but not `--popover-foreground`, so the text fell back to the light-theme colour. A fixed fallback is only right when the host defines neither token.
- **Solution / Workaround**: Chain to the base tokens: `var(--popover, var(--background, #ffffff))` and `var(--popover-foreground, var(--foreground, #0f172a))`. Pair any token whose partner may be missing with a fallback through the base token of the same theme.

### [svelte] `bind:clientWidth` Throws in jsdom Tests

- **Issue / Symptom**: Every Svelte test mounting `ChartCanvas` failed with `ReferenceError: ResizeObserver is not defined`.
- **Root Cause**: Svelte implements `bind:clientWidth` with `ResizeObserver`, which jsdom does not provide, and the binding runs even when the measured width is unused.
- **Solution / Workaround**: Observe the element in an `$effect` guarded by `typeof ResizeObserver === "undefined"` (as the React canvas does) and fall back to the `width` prop.

### [core/chart] `load()` Keeps the Undo Stack, So Undo Can Bring Back the Old Chart

- **Issue / Symptom**: In the demo, loading a sample chart and pressing Undo replaced the sample with the previous chart from before an earlier drag.
- **Root Cause**: Edits record before / after snapshots of the whole spec; `load` swaps the spec without an undo step, so the next undo applies an older snapshot.
- **Solution / Workaround**: Call `load(spec, { clearHistory: true })` when it replaces the whole document (opening a file, switching samples). Without `clearHistory`, use it only to refresh the chart with equivalent data.

### [core/vector] `fill` / `stroke` Mirror the Top Layer of a Stack, and Code That Spreads a Node Edits That Layer

- **Issue / Symptom**: After paint stacks (`fills` / `strokes`) landed, a node copied with `{ ...node, fill: x }` or `{ ...rest, stroke: null }` either lost the change (the stack won and put the old paint back) or kept stale layers (Outline Stroke's outline node inherited every fill of the source).
- **Root Cause**: A stacked node stores its paint twice: the stacks are the truth and `fill`, `stroke` and the stroke settings mirror their top layers, so the dozens of places written for one fill and one stroke (booleans, blends, the gradient tool, the width tool, agent commands) keep reading and writing something sensible. A spread copies both, and only one side gets changed.
- **Solution / Workaround**: `normalizeVectorPaintStacks` reconciles the two. The controller runs it in `refreshed()` (every `notify` and `commit`) with `prefer: 'shorthand'`: a shorthand that no longer matches its top layer is an edit of that layer, and `null` clears the stack. Loading (`new VectorEditorController({ document })`, `setDocument`, SVG import) uses `prefer: 'stack'` instead. New code that rebuilds a node for a different purpose (an outline, a copy without strokes) must set the stacks explicitly with `withVectorFills` / `withVectorStrokes` rather than spreading, and code that edits a layer other than the top goes through `withVectorTargetPaint` or the `*PaintLayer` methods. Stacks of one plain layer are stored as the shorthand, so old documents stay byte-identical.

### [core|react|svelte/vector] Layer Blend Modes Only Mix Inside a Node That Has a Filter, Opacity or Blend Mode

- **Issue / Symptom**: A fill layer set to `multiply` darkened the artwork below the shape, until the shape got a drop shadow (or node opacity below 1, or its own blend mode); then it only darkened the shape's own lower fills.
- **Root Cause**: `mix-blend-mode` blends with everything painted before it inside the nearest isolated group. SVG `filter`, `opacity < 1` and `mix-blend-mode` on the node's `<g>` each make that group isolated, so the backdrop is no longer visible to the layers inside.
- **Solution / Workaround**: This matches how Figma and Illustrator treat layer blending inside an object with effects, so it is kept and documented (skill pitfalls). Don't wrap every node in a `<g>` "to be safe": the canvases and export only emit the group (`VectorRenderPath.layers`) when the node needs layers, and put a node's blend mode and filter on that element.

### [core/vector] Inner Shadows Need the Inverted Alpha Padded by the Filter Region, and Blur Radius Is Twice the Deviation

- **Issue / Symptom**: An inner shadow showed a hard line along one side of the shape, and a "4 px" blur looked twice as soft as in CSS or Figma.
- **Root Cause**: The inner shadow is the inverse of the silhouette (`feComponentTransfer` alpha `1 0`), offset, blurred and clipped back to the shape. The inverse only exists inside the filter region, so when the region ends close to the shape the offset pulls the region's transparent edge in. CSS `blur()` / `box-shadow` and Figma take a radius whose standard deviation is half of it; `feGaussianBlur` takes the deviation.
- **Solution / Workaround**: `vectorFilterSvg` uses `filterUnits="userSpaceOnUse"` with the region padded by `vectorFilterReach` (offset + 1.5 × blur + spread for every shadow and glow, inner ones included, plus layer blurs) around the node's paint bounds (`vectorNodeLocalPaintBounds`: geometry plus stroke reach), and writes `stdDeviation = blur / 2`. The region is in the node's own space, so it follows rigid transforms and zoom.

### [core/vector] SVG Filters Are Approximate Outside Browsers, and Background Blur Cannot Be Exported

- **Issue / Symptom**: Exported shadows look slightly different (or are missing) in some SVG tools, and there is no background blur filter.
- **Root Cause**: Renderers differ in filter support: `feMorphology` (spread, feather) and `color-interpolation-filters` are commonly ignored or approximated, and `mix-blend-mode: plus-lighter` (linear dodge) is newer than the other modes. A background blur needs the pixels behind the node; SVG's `BackgroundImage` input was never implemented by browsers, and CSS `backdrop-filter` does not apply to SVG elements.
- **Solution / Workaround**: Export writes the filter as drawn plus `data-vector-filters` (the stack as JSON) on the `<filter>`, so our own import is lossless; foreign imports read `feDropShadow` and a lone source `feGaussianBlur` back as filters and skip anything else. Background blur is left to the planned lens objects. Tell users (the skill does) to rasterize when a design must look identical everywhere.

### [core|react|svelte/vector] A Filter and a Clip on One SVG Element Clip the Shadow Away

- **Issue / Symptom**: A clip group with a drop shadow showed no shadow outside the clip, and an opacity-masked group's glow was cut to the mask.
- **Root Cause**: SVG applies an element's `filter` first, then `clip-path` / `mask`, then `opacity`. With the filter and the clip on the same `<g>`, the shadow is drawn and then clipped by the same shape that made it.
- **Solution / Workaround**: A mask group draws as two groups: the outer `<g>` carries the transform, opacity, blend mode and filter, and an inner `<g data-vector-masked>` carries `clip-path` / `mask` around the contents (`VectorRenderGroup.mask`, `VectorMaskedNodes`, `emitMaskGroup` in `svg.ts`). The filter region comes from the group's paint bounds, which include the unclipped contents, so it is big enough. Import of foreign SVG keeps the element's own filter on the inner node, which matches SVG's order.

### [core/vector] `<clipPath>` Holds Only Shapes, and an Inverted Clip Needs the Union of the Mask

- **Issue / Symptom**: A clip whose mask was a group (or had path effects) clipped everything away; an inverted clip of two overlapping circles left their overlap visible.
- **Root Cause**: A `<clipPath>` may contain shapes, text and `<use>`, not `<g>`; browsers ignore the group and the clip becomes empty. An even-odd "rectangle with the mask cut out" counts overlapping areas twice, so they flip back to shown, and a nonzero shape read even-odd loses its self-overlaps.
- **Solution / Workaround**: `vectorMaskRegionShapes` flattens the mask into one path per drawn shape in the group's space (each with its own `clip-rule`). The inverted clip (pdfcraft's `clip_out`) is one even-odd path: a rectangle round the contents plus the boolean union of those shapes (`vectorMaskRegionPath`), whose contours never overlap. For import, the mask itself is kept in a hidden `<g data-vector-part="mask-source">`, because the flattened `<clipPath>` loses its paint, effects and structure.

### [core/vector] Masks Render Differently Outside Browsers: `mask-type`, Luminance Space and Inverted Masks

- **Issue / Symptom**: An exported alpha mask hid everything (or showed a dark mask as transparent) in some SVG tools, gradient opacity masks faded at a different rate, and inverted opacity masks were missing.
- **Root Cause**: `mask-type="alpha"` is newer than `<mask>`; renderers that ignore it treat every mask as luminance, and a white-filled alpha mask is then fine but a dark one hides. Browsers compute luminance in sRGB but some renderers honour `color-interpolation="linearRGB"`, which changes how a gradient mask ramps. SVG has no inverted mask, so it is drawn through an `feColorMatrix` filter (`1 − alpha`, or brightness over black, inverted), and renderers with weak filter support drop it. A `<mask>` without `maskUnits="userSpaceOnUse"` only covers the masked element's bounding box plus 10 %, and an inverting filter only inverts inside its own region.
- **Solution / Workaround**: Masks and inverting filters use `userSpaceOnUse` regions over the contents' paint bounds plus a margin (`vectorMaskContentBounds`). Clipping masks are the portable choice; prefer luminance masks with white-to-black fills when an SVG must look right everywhere, and rasterize when it must be identical. Our own import is lossless either way (`data-vector-mask` carries the settings).

### [react/vector] Filter Primitives Built with `createElement` Need Camel-Cased Presentation Attributes

- **Issue / Symptom**: The console showed "Invalid DOM property `flood-color`. Did you mean `floodColor`?" for every drop shadow and inverted luminance mask, although they drew correctly.
- **Root Cause**: `VectorRenderFilter` primitives carry SVG attribute names (`flood-color`, `flood-opacity`) so Svelte and the SVG export can write them as they are. React maps SVG presentation attributes from camel-cased props and warns on the hyphenated spelling.
- **Solution / Workaround**: React's `VectorFilterDefs` camel-cases hyphenated keys before `createElement` (`flood-color` → `floodColor`); the core data keeps SVG names. A React test spies on `console.error` while rendering a filter. React reports each such warning once per page, so check with a fresh render, not by reloading a page whose console already showed it.

### [core/vector] The First Child Is the Mask, So Deleting or Reordering It Changes What Masks

- **Issue / Symptom**: Deleting a clip group's mask turned the bottom content shape into the new clip, and Send to Back inside a mask group swapped the mask.
- **Root Cause**: The model has no mask flag on the child: a mask group's first child is its mask (figcraft's `is_mask` masks the siblings above it instead).
- **Solution / Workaround**: `removeNodes` (delete, cut) clears `mask` on a group whose mask it removes, so the contents draw whole. Reordering inside a mask group is allowed and documented (it is how a different object becomes the mask); Make Clipping Mask moves the chosen mask to the bottom, and Release puts it back on top.

### [core/vector] Merging Faces by a Boolean Union of Their Outlines Leaves Seams

- **Issue / Symptom**: Shape Builder merges built by uniting the faces' own outlines can leave a hairline gap or a spur along the edge two faces shared, and a merged shape whose faces only touched at a corner could come out with a sliver.
- **Root Cause**: Each face's outline is rebuilt separately (pieces joined back into exact sub-curves), so two faces' copies of a shared edge or corner are not guaranteed to be bit-identical; the union then sees two nearly coincident edges instead of one.
- **Solution / Workaround**: `PlanarMap.merge` traces the union along the map's own half-edges: an edge whose two sides are both merged faces is skipped, so shared edges drop out exactly (vectorcraft's `Map::merge`). Covering shapes that lose faces are rebuilt the same way from the faces they keep, never by subtracting the merged shape. Pathfinder operations use one arrangement for all results (`pathBooleanSelect`) for the same reason.

### [core/vector] Islands Must Be Nested per Face, Not by an Even-Odd Rule Over the Network

- **Issue / Symptom**: With three nested squares, a fill of the outer ring that takes every island inside its loop as a hole (as cadcraft's `islands` does) also cuts out the innermost square, a hole inside a hole; figcraft's `faces` notes the same weakness for crossing networks.
- **Root Cause**: Taking every group of curves inside the traced loop as a hole (cadcraft's `islands`) or classifying faces with an even-odd test over the whole network ignores which face an island actually sits in.
- **Solution / Workaround**: The face walk gives each connected piece's outer boundary (a clockwise cycle); `PlanarMap` makes it a hole only of the smallest face of *another* piece around it. `regionAt` traces the loop from the ray as cadcraft does, then takes that face's holes. Adjacency lives in per-vertex angle-sorted lists with half-edge slots, so a walk step is O(1) instead of figcraft's scans over all segments.

### [react|svelte] Binding Tests Use the Built Core: Rebuild It After Changing Core State

- **Issue / Symptom**: After adding a field to `VectorOverlayRenderData`, every React and Svelte vector test failed with `Cannot read properties of undefined (reading 'map')`, including tests that never touched the new feature.
- **Root Cause**: The bindings import `@pixerate/editor/vector`, which resolves to `packages/core/dist`; the canvases read the new field from a stale build that does not produce it.
- **Solution / Workaround**: Run `pnpm --filter @pixerate/editor build` (or `pnpm build`) before running binding tests after core changes.

### [core/vector] Unioning a Variable-Width Stroke Piece by Piece Is Quadratic

- **Issue / Symptom**: Building a tapered stroke as effectcraft does — a trapezoid per flattened segment plus a wedge per bend, unioned non-zero — took 86 s for a 120-wiggle pencil line, and the polygon boolean's winding pass alone was O(edges²).
- **Root Cause**: Every piece overlaps its neighbours, so the overlay sees thousands of crossings, and `buildOverlay` cast each edge's ray against every other edge.
- **Solution / Workaround**: `variableStrokeRings` emits the boundary the pieces add up to (winding numbers add, so the non-zero fill is identical): offset sides, the join on the outer side, and on the inner side the point where the two offsets cross (that corner is covered by both trapezoids) or, when they don't cross, a detour through the centre point. Never normalise the orientation of those rings (a closed path's inner ring must stay reversed). `polygonBoolean` now bands edges along the ray axis. Very wide strokes on tight zig-zags still self-overlap heavily (seconds for extreme cases); render data is cached per node object (`vectorStrokeSvgParts`) so it is only rebuilt when the node changes.

### [core/vector] A Pen Reports Zero Pressure on `pointerup`

- **Issue / Symptom**: Pencil strokes drawn with a pen always ended in a pinched tip.
- **Root Cause**: `PointerEvent.pressure` is 0 on `pointerup` (and for buttons released), and `pointerUp` replays the last position through `pointerMove`.
- **Solution / Workaround**: `pointerUp` drops `pressure` from the input it replays, and the pencil keeps the last pressure for points without one. A mouse reports 0.5 while a button is down, so recording is limited to `pointerType === 'pen'` unless `pencilPressure: 'all'`.

### [core/vector] Width Profiles Must Follow Path Reversal and Mirroring

- **Issue / Symptom**: After Reverse Path or a flip, a one-sided or tapered stroke moved to the other end or the other side.
- **Root Cause**: Profile positions are fractions along the path and sides are relative to its direction; reversing changes both, mirroring swaps left and right.
- **Solution / Workaround**: `reversePaths` applies `reverseWidthProfile` (t → 1 − t, sides swapped) and `bakeIntoGeometry` applies `mirrorWidthProfile` when the matrix has a negative determinant.

### [core/vector] Knife Cuts: a Thin Strip Leaves Slits, and Gap-Free Chords Need Care Around Holes

- **Issue / Symptom**: Cutting a shape by subtracting a thin stroke of the knife line (as vectorcraft does with a 0.05 pt strip) leaves the pieces apart by that width, visible at high zoom and wrong for exact geometry; cutting a ring once with exact chords produced a stray "hole" piece, and the next cut started at the previous cut's end point.
- **Root Cause**: Any strip has width. With exact chords instead, a chord from the outline into a hole does not separate anything — it merges the two loops — and after a split both new loops contain the chord, so the knife's own segments lie on the boundary and its exit point is found again as a crossing.
- **Solution / Workaround**: `knifePath` (`vector/pathCut.ts`) splits one loop per chord into two loops that share it, or joins an outline and a hole into one loop with a zero-width slit; faces are regrouped by loop orientation, and holes are placed by a sample point *off* the chord segments (chords lie on two loops). Crossings are recomputed per face after each cut, only beyond the knife position of the last cut (a cursor), and collinear overlaps are not crossings, so the chord the knife just made is never hit again.

### [core/vector] Deleting a Point: Passing Through It Is a Worse Fit Than the Least-Error Cubic

- **Issue / Symptom**: Healing a deleted point with a curve forced through it (figcraft's `heal_handles`) kept the point but bulged away from the old outline — on an S-curve the new curve strayed 30 units against 2.6 for a least-squares fit.
- **Root Cause**: Two cubics meeting at a point rarely equal one cubic through that point; forcing the pass-through spends the curve's two degrees of freedom on one point instead of the whole outline.
- **Solution / Workaround**: `removeAnchorKeepingShape` samples both old segments and fits one cubic with the neighbours' tangents, searching (golden section) for the parameter where it passes the joint. `removeRedundantPoints` uses the same search: plain chord-length parameters with Newton steps could not get under 0.05 units even for two exact halves of one cubic.

### [core/vector] Snap Guides at 90° Need Exact Axis Directions

- **Issue / Symptom**: A pen point placed straight below the previous one landed at `x = -6.1e-15` instead of `0`, failing exact comparisons and leaving near-zero noise in the saved document.
- **Root Cause**: Construction guides are built from `cos` / `sin` of their angle, and `Math.cos(Math.PI / 2)` is `6.1e-17`, not 0. Projecting onto that "vertical" direction moved the point off its anchor's x by the residue times the distance.
- **Solution / Workaround**: `construction` in `vector/snap.ts` rounds direction components below `1e-12` to exactly 0, and slides compute the coordinate of the line they land on directly (`x: l.v`) instead of `at + dir * s`. Do the same for any angle-derived direction that should be axis-aligned.

### [core/vector] Gather Snap Targets Before the Gesture Changes the Document

- **Issue / Symptom**: A shape being drawn snapped to its own growing bounds, and Alt-duplicating during a move snapped the copy to nothing where the originals stood (or to itself).
- **Root Cause**: Targets are gathered once per gesture from a document snapshot. The shape tool adds the new node on press, and Alt-drag swaps the drag's base document for one with duplicates, so targets taken from the wrong snapshot include (or exclude) the wrong nodes.
- **Solution / Workaround**: The shape tool gathers drawing targets *before* inserting its node and keeps them on the drag; a move drops its targets when it duplicates, so the next move gathers them again excluding the new selection (the originals become targets). The anchor drag excludes the moving anchors and the segments through them, and the handle drag excludes its path's bounds and segments, which move with the pointer.

### [core/vector] The "Nearest Rotation" of a Mirrored Matrix Is Undefined

- **Issue / Symptom**: Flipping a rotated vector shape made its selection box snap back to axis-aligned (the rotation was lost and everything was baked into the anchors).
- **Root Cause**: Node transforms are kept rigid by splitting a matrix into a rotation and a residual. The rotation came from `atan2(b − c, a + d)`, which is the closest rotation only for matrices with a positive determinant. For a mirrored matrix such as `R(30°)·diag(−1, 1)` both terms are 0, so the angle came out as 0.
- **Solution / Workaround**: `matrixRotation` uses `atan2(−b − c, d − a)` when `det < 0` (the rotation left after undoing a horizontal flip) and lets the residual carry the reflection. Shapes keep their angle through flips.

### [svelte] A Local Variable Named `state` Breaks `$state()` in the Same Component

- **Issue / Symptom**: `svelte-check` reports `Cannot use 'state' as a store. 'state' needs to be an object with a subscribe method on it` on a line like `let svg = $state();`, in a component that also has `const state = $derived(...)`.
- **Root Cause**: In Svelte, `$name` is store auto-subscription syntax. When a binding called `state` exists in the component's scope, the compiler reads `$state(...)` as "subscribe to the store `state`" instead of the `$state` rune.
- **Solution / Workaround**: Never name a component-level binding `state` (or `derived`, `effect`, `props`). The vector components call the controller snapshot `view` (`const view = $derived(store.current)`).

### [core/vector] Gestures Applied Live Must Still Report the Change When Committed

- **Issue / Symptom**: `VectorEditorController`'s `onChange` did not fire for programmatic edits (`addShape`, `align`, …) even though the document changed and undo worked.
- **Root Cause**: Edits (and drags) update `this.doc` first and are then recorded with `history.execute(command)`, whose `execute()` restores the "after" snapshot. Because that snapshot is already the current document, the restore saw no difference and skipped `onChange`.
- **Solution / Workaround**: `commit()` sets a `committing` flag around `history.execute` so `restore()` reports the document change once. Any controller that applies a change before recording it needs the same care.

### [react/svelte vector] Wheel Zoom Needs a Non-Passive Native Listener

- **Issue / Symptom**: Ctrl/Cmd+wheel over the vector canvas zoomed the whole browser page (or scrolled it) instead of the drawing, and `preventDefault()` logged "Unable to preventDefault inside passive event listener".
- **Root Cause**: React registers `onWheel` as a passive listener, and browsers treat wheel listeners on the document as passive by default, so they cannot cancel scrolling or pinch-zoom.
- **Solution / Workaround**: Attach the wheel handler in an effect with `element.addEventListener('wheel', handler, { passive: false })` (React `useEffect`, Svelte `$effect`) and call `preventDefault()` there.

### [canvas/freehand] Freehand Stroke Endcaps Stripped on Node Creation & Single-Point Dot Disappearance

- **Issue / Symptom**: When drawing freehand strokes with pen or highlighter tools on the canvas, endcaps appear rounded/square during live drag preview, but become square/flat or completely disappear (for single-point clicks/dots) after releasing the mouse pointer.
- **Root Cause**: `CanvasDrawLayer` was rendering the live `<path>` with `strokeLinecap={draw.activeStroke.style.cap ?? 'round'}`. However, `strokeToShapeNode` in `@pixerate/editor` was not copying `strokeLinecap` or `strokeLinejoin` into `node.data.shape`. Additionally, `ShapeNode.tsx` (React) and `ShapeNode.svelte` (Svelte) were not passing `strokeLinecap` or `strokeLinejoin` down to the rendered `<path>`. In SVG, zero-length or micro-length paths (`M x y L x+0.01 y`) used for dots require round or square linecaps to have visible area.
- **Solution / Workaround**:
  1. In `strokeToShapeNode`, forward `strokeLinecap: stroke.style.cap ?? 'round'` and `strokeLinejoin: stroke.style.join ?? 'round'`.
  2. In `ShapeNode` (React and Svelte), bind `strokeLinecap={render.strokeLinecap}` and `strokeLinejoin={render.strokeLinejoin}` (or `stroke-linecap` / `stroke-linejoin`).

### [canvas/gradients] SVG Linear and Radial Gradient Rendering in Shape Nodes and Live Drawing Layers

- **Issue / Symptom**: Setting `fill` or `stroke` to a gradient definition (linear or radial) renders black or transparent if directly assigned to `fill` or `stroke` attributes in SVG.
- **Root Cause**: Unlike HTML/CSS background values, SVG `<path>` and `<rect>` elements do not accept raw CSS gradient functions in `fill` or `stroke`. They require `<defs>` containing `<linearGradient id="...">` or `<radialGradient id="...">` and reference them via `url(#id)`.
- **Solution / Workaround**:
  1. Add gradient models (`CanvasLinearGradient`, `CanvasRadialGradient`, `CanvasGradientDef`), parser (`parseCssGradient`), and SVG descriptor generator (`gradientToSvgDef`) in `@pixerate/editor`.
  2. In `getShapeRenderData`, resolve gradient fills and strokes to deterministic def IDs (`shape-fill-${id}`, `shape-stroke-${id}`) and output `fillGradient` / `strokeGradient` defs.
  3. In `ShapeNode` (React and Svelte), render `<defs>` with `<linearGradient>` / `<radialGradient>` before rendering shape paths.
  4. In `CanvasDrawLayer` (React and Svelte), resolve the active live stroke gradient to an inline `<defs>` definition (`draw-active-stroke-gradient`) so user strokes render with gradients live during dragging.

### [svelte/canvas] Svelte 5 Runes and .svelte Imports in Vitest

- **Issue / Symptom**: Running Vitest fails with `ReferenceError: $state is not defined` when executing tests against `.svelte.ts` files, or throws `TypeError: Unknown file extension ".svelte"` when importing `@xyflow/svelte`.
- **Root Cause**: Svelte 5 runes (`$state.raw`, `$derived`, etc.) and `.svelte` component distributions require compile-time transformation via `@sveltejs/vite-plugin-svelte` and a DOM environment (`jsdom`). In a monorepo, if the root Vitest config does not specify workspace project delegation, individual package configs are ignored.
- **Solution / Workaround**:
  1. Add `packages/svelte/vitest.config.ts` with `plugins: [svelte()]` from `@sveltejs/vite-plugin-svelte` and `test: { environment: 'jsdom' }`.
  2. Add root `vitest.config.ts` with `test: { projects: ['packages/*', 'apps/*'] }` so monorepo `pnpm test` delegates to package-level Vitest configurations.

### [svelte/canvas] Decoupling SvelteFlow via Optional Peer Dependencies and Subpath Exports

- **Issue / Symptom**: Adding canvas features to `@pixerate/editor-svelte` could unnecessarily bloat bundle sizes or require `@xyflow/svelte` for consumers who only need rich-text / TipTap editors.
- **Root Cause**: Putting `@xyflow/svelte` as a hard dependency in `dependencies` forces every consumer of `@pixerate/editor-svelte` to download SvelteFlow and its transitive dependencies.
- **Solution / Workaround**:
  1. Expose canvas features under the subpath export `./canvas` (`@pixerate/editor-svelte/canvas`) rather than the root entry.
  2. Define `@xyflow/svelte` under `peerDependencies` with `peerDependenciesMeta: { "@xyflow/svelte": { "optional": true } }`.
  3. Because `@pixerate/editor-svelte` ships uncompiled sources via `svelte-package`, imports of `@xyflow/svelte` and `@dagrejs/dagre` are left as-is and resolved by the consumer's bundler; never import `@xyflow/svelte` from the root entry.

### [svelte/canvas] Zero-Duration Transitions and Division by Zero in Multi-Node Animation

- **Issue / Symptom**: Running transitions with `duration: 0` (e.g. for instantaneous layout updates or synchronous unit testing) sets node positions to `{ x: NaN, y: NaN }` and stalls completion.
- **Root Cause**: Computing progress via `elapsed / item.duration` produces `0 / 0 = NaN`. Furthermore, if `staggerDelay > 0` is applied when duration is 0, subsequent items calculate negative elapsed times and get deferred to `requestAnimationFrame`.
- **Solution / Workaround**: Guard `rawProgress` with `item.duration <= 0 ? 1 : Math.min(elapsed / item.duration, 1)` and force `effectiveStagger = duration === 0 ? 0 : staggerDelay`.

### [history/react] `useSyncExternalStore` Snapshot Referential Equality

- **Issue / Symptom**: React throws `Maximum update depth exceeded` and logs `The result of getSnapshot should be cached to avoid an infinite loop` when using `useHistory`.
- **Root Cause**: In React 18/19, `useSyncExternalStore` compares the snapshot returned by `getSnapshot()` using `Object.is(prev, next)`. If `manager.getState()` computes and returns a new object literal on every call, React considers the store continuously dirty and loops infinitely.
- **Solution / Workaround**: Cache the state object (`cachedState`) in `HistoryManager` and only allocate a new snapshot reference when a mutation actually occurs (inside `notify()` or upon `execute`, `undo`, `redo`, `clear`).

### [history/shortcuts] Native Text Inputs and ContentEditable Hijacking

- **Issue / Symptom**: Registering a global window listener for Undo/Redo (`Cmd+Z`, `Ctrl+Z`) breaks normal typing, backspacing, or rich-text editing inside `<input>`, `<textarea>`, or TipTap/ProseMirror `contenteditable` nodes.
- **Root Cause**: Keyboard events bubble up to the window object where a naive shortcut handler calls `event.preventDefault()` and invokes app-level history instead of letting the browser/editor perform native or ProseMirror undo.
- **Solution / Workaround**: Guard shortcut handlers by inspecting `event.target` and `document.activeElement`. If the element is an `<input>`, `<textarea>`, or has `isContentEditable` / `contenteditable="true"`, ignore the event and do not call `preventDefault()`.

### [core/mentions] Markdown Code-Block Immunity and URL Immunity in Mention Extraction & Preprocessing

- **Issue / Symptom**: Markdown or HTML content containing code samples, terminal output, stack traces, markdown links (`[package](https://npmjs.com/@scope/package)`), or raw URLs mistakenly formats `@handle` into interactive TipTap mention nodes (`<span data-type="mention">`), or triggers false-positive mention notifications.
- **Root Cause**: Naive regex matching for `@handle` triggers inside fenced code blocks (`` ``` `` or `~~~`), inline backticks, HTML `<pre>`/`<code>` blocks, markdown URL targets `](...)`, and URL path segments.
- **Solution / Workaround**: Use `stripMarkdownCode()` prior to extraction, and in `preprocessMarkdownMentions()`, split content using `MARKDOWN_MENTION_SPLIT_REGEX` so that code blocks, inline code, existing mention spans, and URLs remain completely untouched.

### [core/mention] TipTap Suggestion onKeyDown Command Inaccessibility

- **Issue / Symptom**: When implementing a custom keyboard handler (e.g. `Enter` or `Tab`) in a TipTap suggestion popover, calling `props.command(item)` inside `onKeyDown(props)` throws `TypeError: props.command is not a function`.
- **Root Cause**: In `@tiptap/suggestion`, `onKeyDown` receives `SuggestionKeyDownProps` which only contains the `view`, `event`, and `range`. The `command(attrs)` callback is only supplied on `SuggestionProps` passed to `onStart` and `onUpdate`.
- **Solution / Workaround**: Cache the latest `suggestionProps` during `onStart` and `onUpdate`, and invoke `cachedSuggestionProps.command(item)` when executing suggestion selection from a keyboard event.

### [react/testing] React 19 Testing without `@testing-library/react`

- **Issue / Symptom**: Attempting to import `renderHook` or `act` from `@testing-library/react` in package test suites fails with `Cannot find package '@testing-library/react'`.
- **Root Cause**: `@testing-library/react` is not an installed dependency in `@pixerate/editor-react` to keep the dependency footprint light.
- **Solution / Workaround**: Use `act` directly from `react` (`import React, { act } from 'react'`) and mount test components into a JSDOM container via `createRoot(container)` from `react-dom/client`, setting `(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true`.

### [core/canvas] Incremental Dagre Layout Centroid Blending & Unplaced Nodes

- **Issue / Symptom**: When running incremental layout `ensureLayout`, nodes initialized at `{ x: 0, y: 0 }` are erroneously treated as placed nodes and kept at `(0, 0)` rather than flowed into position relative to existing nodes.
- **Root Cause**: `storedPositions` mapped all node IDs including unplaced nodes initialized with default coordinates `(0, 0)`.
- **Solution / Workaround**: Filter `storedPositions` to only include nodes with non-zero coordinates (`x !== 0 || y !== 0`) or explicitly stored positions, allowing newly spawned nodes to calculate centroid translation offsets $\Delta x$ and $\Delta y$ seamlessly.

### [react/canvas] Synthetic vs Native ClipboardEvent Handling

- **Issue / Symptom**: Calling clipboard copy/paste handlers in React tests throws `TypeError: event.preventDefault is not a function` or fails to extract text/JSON from `clipboardData`.
- **Root Cause**: In React 19 / JSDOM environments, `event` passed to clipboard handlers may either be a synthetic `React.ClipboardEvent` or a native `ClipboardEvent`.
- **Solution / Workaround**: Extract the native event via `const native = (event && 'nativeEvent' in event) ? (event as any).nativeEvent : event;` and guard `(event as any)?.preventDefault?.(); (native as any)?.preventDefault?.();`.

### [core/agent] Ephemeral Presence Artifacts in Multimodal Snapshots & Background Tab Throttling

- **Issue / Symptom**: Multimodal LLM agents executing visual snapshot tools (`view_editor`) inspect their own cursor trails and speech tags in a feedback loop, or frame animations freeze when the browser tab is hidden/backgrounded.
- **Root Cause**:
  1. Ephemeral cursor tags and narration bubbles rendered in the DOM are captured in canvas exports unless explicitly filtered out before rasterization.
  2. Browsers throttle or suspend `requestAnimationFrame` when `document.hidden` is true (background tabs, headless CI runners).
- **Solution / Workaround**:
  1. Add `EXPORT_EXCLUDED_SELECTORS` (`.pixerate-presence`, `.agent-presence`) to canvas export pipelines to strip presence DOM nodes before capturing images.
  2. Implement `Clock` with `pageHidden()` fallback to `setTimeout`, and provide `ManualClock` for step-by-step deterministic advancement in test suites and video capture runners.

### [core/tsup] TypeScript Union Distribution with `Omit<Union, Key>`

- **Issue / Symptom**: During `tsup` DTS type declaration generation, passing discriminated union objects (such as `Annotation` variants) to a function typed with `Omit<Annotation, 'id'>` throws `TS2353: Object literal may only specify known properties, and 'points' does not exist in type 'Omit<Annotation, "id">'`.
- **Root Cause**: In TypeScript, the standard `Omit<T, K>` utility is not distributive over unions (`T = A | B`). `Omit<A | B, 'id'>` evaluates to `{ [k in (keyof A & keyof B)]: ... }`, discarding member-specific properties such as `points` on `PenAnnotation` or `radiusX` on `CircleAnnotation`.
- **Solution / Workaround**: Define an explicit distributive union type (e.g. `export type CreateAnnotationPayload = Omit<PenAnnotation, 'id'> | Omit<RectAnnotation, 'id'> | ...`) or a distributive utility `type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never`.

### [image-editor/dom] Canvas Viewport Layout Feedback Loop Causing Zoom Drift on Every Action

- **Issue / Symptom**: In the image editor demo, performing any action (slider adjustment, rotate, annotation, crop preset, undo) caused the image to repeatedly zoom in.
- **Root Cause**:
  1. The `<canvas>` element was placed in normal document flow (`position: static`/`relative`) inside a flex container that had padding and no rigid height constraint (`min-h-[480px]`).
  2. On each action, the canvas resolution was updated to `canvas.width = container.clientWidth` and `canvas.height = container.clientHeight`. Because the canvas possessed intrinsic dimensions and the container had padding, the parent container expanded.
  3. On the subsequent action, `container.clientHeight` was measured larger, which increased `fitScale = Math.min((vpWidth * 0.85) / baseW, (vpHeight * 0.85) / baseH, 1)`, rendering the image larger and causing the parent container to expand further on every interaction.
  4. Additionally, when rotating 90° or 270°, the renderer did not transpose base dimensions `(cropW, cropH)` to `(cropH, cropW)`, clipping rotated images and distorting `fitScale`.
- **Solution / Workaround**:
  1. Position the canvas with `className="absolute inset-0 w-full h-full block cursor-crosshair"` within a `relative flex-1 h-full min-h-0 overflow-hidden` container. Absolute positioning removes the canvas from document flow, making it physically impossible for canvas pixel dimensions to alter or expand the parent container.
  2. Enforce explicit layout height on the editor outer frame (`h-[540px]`).

### [tailwind/monorepo] Missing Workspace Packages in Tailwind `content` Causes CSS Layout Collapse

- **Issue / Symptom**: In the demo app, the image editor canvas was centered floating over the sidebar controls, the sidebar took up 100% width below the canvas, and aspect ratio preset buttons stacked in single full-width vertical rows rather than a 3-column grid.
- **Root Cause**: `apps/demo/tailwind.config.js` only included `"./src/**/*.{js,ts,jsx,tsx}"` in its `content` array. Because `@pixerate/editor-react` and `@pixerate/editor-svelte` use Tailwind utility classes (e.g. `md:flex-row`, `md:w-80`, `grid-cols-3`, `h-[540px]`), Vite's Tailwind compiler purged all classes that were not also present in `apps/demo/src`. Without `md:flex-row` and `md:w-80`, the container stayed `flex-col`, the sidebar expanded to 100% width, and without `grid-cols-3`, the presets collapsed into a single column.
- **Solution / Workaround**:
  1. Add `"../../packages/*/src/**/*.{js,ts,jsx,tsx,svelte}"` to the `content` array in `apps/demo/tailwind.config.js`.
  2. Implement responsive heights (`h-[360px] md:h-full min-h-[320px]`) in [`ImageEditor.tsx`](file:///Users/jack/Development/editor/packages/react/src/image-editor/ImageEditor.tsx) and [`ImageEditor.svelte`](file:///Users/jack/Development/editor/packages/svelte/src/image-editor/ImageEditor.svelte) so viewport containers have a well-defined fallback layout even in single-column / mobile contexts.

### [image-editor] Crop Overlay Disappearing Outside of Drag Operations

- **Issue / Symptom**: The interactive crop rectangle, rule-of-thirds grid, and resize handles were only visible on the canvas while actively dragging a handle. When the user was not dragging (idle hover or initial tab selection), the crop overlay was completely invisible.
- **Root Cause**:
  1. The renderer condition evaluated `options.draftCrop !== undefined ? options.draftCrop : crop`. When idle, `draftCrop` was passed as `null` (since no draft drag was active). In JavaScript, `null !== undefined` is `true`, causing `activeCrop` to evaluate to `null` instead of falling back to the committed `state.crop`.
  2. Initially or upon reset, `state.crop` is `null`. Without a fallback to full natural image dimensions `{ x: 0, y: 0, width: naturalWidth, height: naturalHeight }`, no bounding box existed to render handles or hit-test against.
  3. The renderer also required `state.activeTool === 'crop'`. On initial component mount, `activeTab` defaulted to `'crop'` but `state.activeTool` was `'select'`, causing `isActivelyCropping` to evaluate to `false` and hiding the overlay until the user manually clicked the tab button.
- **Solution / Workaround**:
  1. In `renderer.ts`, determine active crop as `(options.draftCrop !== undefined && options.draftCrop !== null) ? options.draftCrop : (crop ?? (isCroppingActive ? { x: 0, y: 0, width: naturalWidth, height: naturalHeight } : null))`.
  2. In `geometry.ts`, resolve `cropOverride` similarly so `getViewportMetrics` generates a valid `cropRect` and handles can be hit-tested even before the first crop operation.
  3. In React and Svelte 5 components, synchronize `editor.setTool('crop')` with `activeTab` on mount, and provide full-image dimension fallbacks during hover cursor hit testing.

### [core/grammar] `String.prototype.replace` Interprets `$` Patterns in Replacement Strings

- **Issue / Symptom**: A template body containing `$&` (e.g. a price like `"costs $&"`) made `resolveTemplates` hang forever; bodies containing `` $` `` or `$'` produced garbled output such as `"A [A ] B"`.
- **Root Cause**: `result.replace(fullMatch, resolvedBody)` treats `$&`, `` $` ``, `$'`, `$$` and `$1` in the *replacement string* as special patterns. `$&` re-inserted the `{{tag}}` itself, and the resolver rescanned from index 0, so it looped.
- **Solution / Workaround**: Never pass user-controlled text as a string replacement. Use a function replacer (`text.replace(regex, () => body)`) or build the result by slicing at `match.index`. The resolver now uses a single-pass function replacer and recurses into each body, so no rescan is needed.

### [core/serializers] TipTap Nests Paragraphs Inside List Items, and Live-Document `innerHTML` Runs Handlers

- **Issue / Symptom**: `htmlToPlainText` returned `"one\none\ntwo\ntwo"` for a two-item list and silently dropped `<pre>` code blocks. Separately, extracting text from untrusted HTML could fire `<img onerror>` handlers.
- **Root Cause**: TipTap serializes list items as `<li><p>…</p></li>`. Collecting the `textContent` of every element matching `p, li, …` counts each item twice, and anything outside that selector list is lost. Assigning `innerHTML` on an element created by the live `document` starts loading resources (and running inline event handlers) even when the element is never attached.
- **Solution / Workaround**: Walk the DOM and emit one line per *innermost* block element, treating `<br>` as a newline. Parse untrusted HTML into a `<template>` element's `.content` (or `DOMParser`), which is inert. To insert literal text into TipTap, never pass a string to `insertContent` (it is parsed as HTML); use `tr.insertText` for single lines, or `tr.replace(from, to, Slice.maxOpen(paragraphs))` so newlines split paragraphs like the paste handler does.

### [core/markdown] Markdown Content Legitimately Contains HTML, So `html: false` Is Not an Option

- **Issue / Symptom**: `markdownToTipTapHtml` passed raw HTML (`<img onerror>`, `javascript:` links) straight through, which is an XSS risk when rendering LLM or user-supplied markdown. Turning off markdown-it's `html` option breaks mention round-trips and file-link preprocessing.
- **Root Cause**: `tiptap-markdown` serializes mention nodes as raw `<span data-type="mention">` HTML, and `preprocessMarkdownFileLinks` / `preprocessMarkdownMentions` inject HTML into the markdown before rendering. `markdown-it-task-lists` also emits its checkboxes as `html_inline` tokens.
- **Solution / Workaround**: Keep `html: true` but override markdown-it's `html_inline` and `html_block` renderer rules to run an allowlist sanitizer (tags, attributes, `data-*`, checkbox-only `<input>`, and `md.validateLink` on entity-decoded, control-character-stripped `href`/`src`). Escape every value interpolated into preprocessor HTML. `allowUnsafeHtml: true` (passed via the render `env`) opts out for trusted input.

### [svelte/packaging] Precompiled Svelte Components Break SSR, Styles and Version Compatibility

- **Issue / Symptom**: With the old `tsup` + `esbuild-svelte` build, rendering any component in SvelteKit SSR threw `document is not defined`; component `<style>` blocks (editor placeholder, spreadsheet resize handle) never reached consumers; and the hand-written `index.d.ts` files referenced unimported types and had drifted from the real exports.
- **Root Cause**: `esbuild-svelte` compiles components once, in client mode, importing private `svelte/internal/client` APIs that are not semver-stable. Scoped CSS was emitted to `dist/index.css`, which nothing imported and the `exports` map did not expose. `dts: false` meant types were maintained by hand.
- **Solution / Workaround**: Build with `svelte-package -i src -o dist` (`@sveltejs/package` v2; v3 requires TypeScript 6). It ships `.svelte` sources (compiled by the consumer for client *and* server, with styles intact) and generates `.d.ts` files with `svelte2tsx`. Requirements this imposes:
  1. Relative imports in `.ts` files must use the emitted extension: `./editor.svelte.js` for rune modules (`editor.svelte.ts`), `./history/index.js` for folders. Component imports keep `.svelte`.
  2. Keep tests out of `src/` (they live in `packages/svelte/tests/`), otherwise they are packaged.
  3. Type-check with `svelte-check`, not `tsc` (`tsc` cannot see `.svelte` files without an ambient shim, and a shim would hide real prop types).
  4. `tests/ssr.test.ts` renders components with `svelte/server` in a Node environment to guard against regressions.

### [core/tsup] `splitting: false` Duplicates Shared Modules Across Subpath Entries

- **Issue / Symptom**: Importing both `@pixerate/editor` and `@pixerate/editor/image-editor` (or any two subpaths) loaded two copies of shared modules: two `globalImageCache` instances, and `instanceof` checks failing across entries. The root entry also pulled in `@dagrejs/dagre` and the image renderer for consumers who only wanted the prompt editor.
- **Root Cause**: With `splitting: false`, tsup bundles every entry point independently, inlining all of its imports. The root barrel re-exported every module, including canvas, agent and image-editor.
- **Solution / Workaround**: Build with `splitting: true` so shared code lands in common chunks, and keep heavy or environment-specific modules (canvas, agent, image-editor) subpath-only. Framework packages must import them from the subpath (`@pixerate/editor/image-editor`), not the root.

### [monorepo/deps] TipTap Must Be a Peer Dependency to Avoid Duplicate ProseMirror Instances

- **Issue / Symptom**: Consumers could end up with two copies of `@tiptap/core` / `@tiptap/pm` (e.g. a v3 `@tiptap/react` from the app alongside core's v2), producing errors such as `Adding different instances of a keyed plugin`, `RangeError: Can not convert <> to a Fragment`, failed `instanceof` checks, or core extensions silently not applying.
- **Root Cause**: ProseMirror relies on module identity (plugin keys, `Node`/`Schema` classes). Listing `@tiptap/core` and `@tiptap/pm` under `dependencies` lets the package manager install a private copy per package when ranges differ; `@pixerate/editor-react` also advertised `^2 || ^3` while core only supported v2.
- **Solution / Workaround**: Declare `@tiptap/core`, `@tiptap/pm` (and `@tiptap/react` for React) as `peerDependencies` with one shared range, mirrored in `devDependencies` for local builds. Extension packages (`@tiptap/extension-*`, `@tiptap/starter-kit`, `@tiptap/suggestion`) can stay regular dependencies because they themselves peer-depend on `@tiptap/core`/`@tiptap/pm`. Only widen the range to a new TipTap major once it is installed and tested in CI. The demo app lists the peers explicitly.

### [monorepo/deps] TipTap Extensions Must Be Optional Peers Too, or Chart-Only Apps Still Install TipTap

- **Issue / Symptom**: Marking only `@tiptap/core` and `@tiptap/pm` optional left a chart-only app (`@pixerate/editor-svelte/chart`) installing all of TipTap anyway.
- **Root Cause**: The `@tiptap/extension-*`, `@tiptap/starter-kit` and `@tiptap/suggestion` packages were regular dependencies, and each of them has a *required* peer on `@tiptap/core` / `@tiptap/pm`. npm 7+ installs required peers of installed packages automatically, so the optional flag on our own peer did nothing.
- **Solution / Workaround**: Every TipTap, ProseMirror and markdown-it package is an optional peer (listed in `peerDependencies` and `peerDependenciesMeta`, mirrored in `devDependencies` for local builds) in core, React and Svelte. This supersedes the earlier advice above that extensions could stay regular dependencies. `packages/core/tests/optional-peers.test.ts` fails if one comes back as a dependency or loses its optional flag. Apps using rich text install them from the README install line. Keep chart, spreadsheet, canvas and other non-rich-text entries free of them (`tests/entry-isolation.test.ts`).

### [react/tiptap] `useEditor` Dependency Arrays Destroy the Editor (and Loop on Inline Objects)

- **Issue / Symptom**: `usePromptEditor({ templateColorMap: new Map(...) })` threw "Maximum update depth exceeded"; toggling `isEditing` or changing `placeholder` lost undo history, focus and the caret.
- **Root Cause**: `@tiptap/react`'s `useEditor(options, deps)` destroys and recreates the editor whenever a dependency changes by identity. An inline `Map` is a new object every render, so each render created an editor, which triggered a re-render, which created another. Options such as `editable` were also listed as deps even though they can be applied to the live instance.
- **Solution / Workaround**: Only list options that are baked into extension configuration, and key object-valued options by value (e.g. `JSON.stringify(Array.from(map.entries()))`). Apply everything else in effects on the live editor: `editor.setEditable()`, `editor.setOptions({ editorProps })` for attributes, mutate `extension.options` and dispatch an empty transaction to refresh decorations (placeholder), and `setContent(…, false)` only when the incoming value differs from the editor's current text, so echoes of `onContentChange` never reset the caret.

### [svelte/testing] `mount()` Fails with `lifecycle_function_unavailable` in Vitest

- **Issue / Symptom**: Mounting a component with `mount()` from `svelte` in a jsdom test throws `Svelte error: lifecycle_function_unavailable` from `svelte/internal/server`.
- **Root Cause**: Vitest resolves package exports with Node conditions, so `svelte` resolves to its server runtime even in the jsdom environment.
- **Solution / Workaround**: Set `resolve: { conditions: ['browser'] }` in `packages/svelte/vitest.config.ts` (guarded by `process.env.VITEST`). Tests annotated with `// @vitest-environment node` (e.g. `tests/ssr.test.ts`) still use the server build.

### [core/spreadsheet] Recalculation Must Be Topological, and Structural Edits Must Rewrite References

- **Issue / Symptom**: Formulas computed from cells evaluated later showed 0 (`A1` = `=A2*2` loaded before `A2`); cycle markers vanished or turned into `NaN` after an insert or undo; inserting a row made formulas point at the wrong cells; column formulas using `[property]` showed the same value in every row.
- **Root Cause**: `recalculateAll` evaluated row by row and never cleared the dependency graph; cycle detection only flagged the edited cell; references are stored as A1 text, so moving cells without rewriting formulas changes what they point at; `[property]` resolved against the *selected* row.
- **Solution / Workaround**: `DependencyGraph.getEvaluationPlan()` runs an iterative Tarjan SCC pass (no recursion, so long chains don't overflow) that returns cells dependencies-first plus every member of a cycle. `recalculateAll` rebuilds the graph and follows the plan. Row/column insert/delete calls `shiftFormulaReferences()` on every formula *before* mutating the grid; growing the grid during a paste is not an insertion and must not shift references. Ranges (including whole columns `A:A`) are stored whole in an interval index, never as one key per cell (see the large-sheet entry below). The controller sets the evaluating row while evaluating so `[property]` is per-row. In formula code, never use `Math.max(...values)` or `push(...values)` on range values: large ranges overflow the stack.

### [core/canvas] Streaming Layout: Debounce Starves Layouts, and Current Positions Are Not Layout Targets

- **Issue / Symptom**: During an LLM stream, `StreamingLayoutManager` ran no layouts until the stream went quiet (updates every 20ms with `throttleMs: 50` resulted in zero layouts over 500ms). When a layout did run, nodes never glided; they stayed where they were.
- **Root Cause**: `pushStreamUpdate` cleared and re-armed a single timeout on every call. That is a *debounce*: the timer only fires after `throttleMs` of silence. Separately, the caller's `currentPositions` were passed to `ensureLayout` as `storedPositions`, which pins every known node to its current spot. So each target equalled the current position and no transition was created.
- **Solution / Workaround**: Use a real throttle. Lay out immediately on the leading edge and open a window. Inside the window, keep only the latest args, then run them on the trailing edge and re-open the window. Treat `currentPositions` only as the glide *origin*. Compute targets from the graph plus explicitly pinned `layoutOptions.storedPositions`. When re-targeting mid-glide, start from the in-flight animated positions so nodes don't jump. Test with `vi.useFakeTimers()` for the throttle and a `ManualClock` for the glide. Don't mix them: `ManualClock.advance` awaits a real `setTimeout(0)` and hangs under fake timers.

### [core/canvas] Node `style` Can Be a String (SvelteFlow) or an Object (React Flow)

- **Issue / Symptom**: `runMultiNodeTransition` with a fan-out trajectory threw `style.replace is not a function` for React Flow nodes. It also overwrote the caller's node objects, which breaks React's immutable state expectations.
- **Root Cause**: The opacity logic assumed CSS-string styles (`"opacity: 0.5;"`), which is SvelteFlow's convention. React Flow / xyflow uses `CSSProperties` objects. The runner also mutated `node.position`, `node.data` and `node.style` in place.
- **Solution / Workaround**: Use `withStyleOpacity(style, opacity, emptyFormat)`. It returns `{ ...style, opacity }` for objects, rewrites the `opacity` declaration for strings, and builds a new style in the requested format when `style` is empty. React passes `styleFormat: 'object'`. Transitions now emit updated **copies** through `onUpdate(nodes)` / `onComplete(nodes)`. Merge them into state by `id` instead of reading the input nodes.

### [core/history] Exceptions Inside `batch` / `undo` / `redo` Corrupt the Stacks

- **Issue / Symptom**: If a `batch` callback threw halfway, a partial compound entry was still pushed and could be undone. If a command's `undo` threw, the command disappeared from both stacks.
- **Root Cause**: `batch` pushed the collected commands in a `finally` block. `undo`/`redo` popped the command *before* calling its closure.
- **Solution / Workaround**: In `batch`, catch the error, undo the already-executed batch commands in reverse with `isApplying = true` so the undos are not recorded, push nothing, and rethrow. In `undo`/`redo`, peek at the top command, run its closure, and pop/push only after it succeeds.

### [core/agent] Planner Must Accept the MCP Tool Schema's Vocabulary

- **Issue / Symptom**: An agent calling `edit_canvas` with `side: 'top'` got the node placed *below* the anchor. `layout` without `incremental` discarded manual positions even though the schema says `incremental` defaults to `true`.
- **Root Cause**: The tool schema (`top | right | bottom | left`, `incremental` default true) and the planner/`placeBeside` vocabulary (`right | below | left | above`, falsy default) drifted apart. Unknown sides fell through to `placeBeside`'s `default: below` branch.
- **Solution / Workaround**: Normalize sides with `normalizeSide()` and use `command.incremental ?? true`. When changing `tools.ts`, update the planner and its tests in the same change. Validate `nearNodeId` against the snapshot before anchoring or adding an edge.

### [core/image-editor] One Canonical Coordinate Space for Crop, Annotations and Masks

- **Issue / Symptom**: At 90°/270° the crop overlay was drawn with the wrong size (the left half of an 800×600 image showed as 300×800 instead of 600×400). Crop drags went the wrong way on flipped images. The depth mask ignored rotate/flip. Inpainting masks were misaligned with the image. Undo after an AI edit could not restore the image.
- **Root Cause**: Every code path invented its own mapping. The crop box was stored in natural pixels but divided by unswapped width/height on a swapped base. `canvasToImagePoint` ignored rotation, flips and the crop offset. Annotations were stored in post-crop/post-rotate display space but rendered onto natural-size mask canvases. History snapshots left out the source image.
- **Solution / Workaround**:
  1. The crop box and **all** annotations are stored in natural pixels of the current source image. Rotation, flips, crop, fit, zoom and pan are view transforms only.
  2. `geometry.ts` owns the only mapping: `target = origin + scale · R(angle) · F(flipH, flipV) · (p − regionCenter)`, exposed as `projectImagePoint` / `unprojectCanvasPoint` (exact inverse) and `applyImageProjectionToContext` (the same transform for a 2D context). The renderer (viewport, base image, depth mask, annotations, export), `getViewportMetrics`, `hitTestCrop` and `canvas↔image` conversion all build on it. Never hand-roll `translate/rotate/scale` sequences or `x / naturalWidth * renderW` maths in new code.
  3. `hitTestCrop` returns image-space handles because that is what `calculateCropDrag` needs. Map them back with `getCropCursor(handle, transform)`. An on-screen aspect ratio is inverted in image space under a quarter turn.
  4. Annotations follow the image content: rotating or flipping the image rotates or mirrors existing annotations, text included, and they are clipped to the visible region.
  5. AI hooks get `toSourceDataURL()` (natural size, untransformed) together with `toMaskDataURL()` (same space), and the result replaces the source. History entries store the source URL, element and dimensions next to the serialized edits, so `applyInpaintedImage` / `applyBackgroundRemovedImage` are single undoable steps.
  6. Exact quarter-turn `cos`/`sin` values keep round trips free of float error. Any value that changes the base render, such as `depthMask.maskSource` or the source element, must be part of the renderer's cache key.

### [core/canvas] Layer Order: xyflow Stacks by `zIndex`, Then Array Order, and Parents Must Come First

- **Issue / Symptom**: "Bring to Front" implemented by moving a node to the end of the `nodes` array had no effect when other nodes had a `zIndex`, and moving a parent group after its children broke the sub-flow.
- **Root Cause**: SvelteFlow and React Flow render nodes with CSS `z-index` from `node.zIndex` (missing = 0, plus 1000 for selected nodes when `elevateNodesOnSelect` is on) and only fall back to array order for ties. xyflow also requires a parent to appear before its children in the array.
- **Solution / Workaround**: `reorderNodes` computes the effective order (`zIndex`, then array index) per sibling group (same `parentId`), applies the operation and returns `zIndex` rank updates. It never reorders the array. Nodes whose effective `zIndex` already equals their rank are left untouched, and a no-op operation returns no updates.

### [core/canvas] Option/Alt Shortcuts Must Match `KeyboardEvent.code`, Not `key`

- **Issue / Symptom**: Align shortcuts such as `Alt+A` never fired on macOS, and `Mod+Alt+]` (bring to front) did not match.
- **Root Cause**: On macOS, Option changes the produced character (`Alt+A` gives `key === 'å'`, `Alt+]` gives `'‘'`). Keyboard layouts also move `[`/`]`.
- **Solution / Workaround**: `matchArrangeShortcut` matches bindings by `event.code` (`KeyA`, `BracketRight`) and only derives a code from `key` when `code` is empty (synthetic events). It still bails out early through `isEventFromTextInput` so the shortcuts never hijack typing.

### [svelte/canvas] SvelteFlow `Node` Is Not Assignable to Core `CanvasNode`

- **Issue / Symptom**: `svelte-check` fails with `Types of property 'class' are incompatible` when a Svelte rune passes SvelteFlow nodes into a generic core helper such as `createCanvasArrangeController<TNode>`.
- **Root Cause**: Core's structural `CanvasNode` declares `class?: string`. SvelteFlow's `Node` declares `class?: ClassValue` (strings, arrays or objects).
- **Solution / Workaround**: Keep the public Svelte API typed with the Svelte `CanvasNode` from `./types.js` and call the core controller with a loose type parameter (`createCanvasArrangeController<any>`). The core helpers only read `id`, `position`, sizes, `style`, `parentId`, `zIndex`, `data` and the interaction flags.

### [canvas] Smart-Guide Snapping Hooks Differ Between SvelteFlow and React Flow

- **Issue / Symptom**: One snapping integration does not fit both libraries. In React Flow, a position rewritten in `onNodeDrag` is overwritten by the next `onNodesChange` batch, so the node does not stay snapped.
- **Root Cause**: React Flow is controlled through `onNodesChange`, so a position must be snapped *before* `applyNodeChanges` runs. SvelteFlow binds `nodes` and calls `onnodedrag` after it has written the dragged position. Both compute each drag frame from the pointer and the drag-start position, not from the previous frame, so writing a snapped position does not accumulate offsets.
- **Solution / Workaround**: React: `onNodesChange={(c) => setNodes((n) => applyNodeChanges(arrange.snapPositionChanges(c), n))}`. A batch with `dragging: false` ends the drag and clears the guides. Svelte: `onnodedragstart={() => arrange.beginDrag()}`, `onnodedrag={({ nodes }) => arrange.drag(nodes.map((n) => n.id))}`, `onnodedragstop={() => arrange.endDrag()}`. Snap targets are indexed once per drag (`createNodeGuideIndex`) and each frame is a binary search, so dragging stays fast with hundreds of nodes.

### [core/grammar] Escapes in `VARIABLE_REGEX` Can Backtrack Catastrophically, and Sections Are Scoped Per Body

- **Issue / Symptom**: A first attempt at allowing `\}` / `\|` inside `{name|default}` with `(?:\\.|[^{}])+` froze the tab on input such as `{` followed by thousands of backslashes and no closing brace. Separately, a `{?x}` opened inside a template body and closed in the prompt (or the other way round) behaved unpredictably once templates were expanded.
- **Root Cause**: In `(?:\\.|[^{}])+` a backslash can match either branch, so each run of backslashes can be split many ways, and a failing match tries all of them (exponential). Sections that cross template boundaries depend on expansion order, and a removed section would have to be known before its templates are expanded.
- **Solution / Workaround**: Keep the alternatives disjoint: `(?:\\[\s\S]|[^{}\\])*\\?` (a backslash is only ever an escape, except one trailing backslash, which keeps the old `{a\}` match). `tests/grammar.test.ts` has a timing guard. The resolver tokenizes each template body on its own: sections must open and close in the same body, unbalanced tags stay literal and are reported as diagnostics with `templateName`, and templates inside removed sections are never expanded. Unbalanced tags must never throw. Pair them with `matchConditionalTags()` (used by the tokenizer and by `GradientText`, which pairs across the whole document because sections may span paragraphs).

### [react/testing] Text Inputs Never Fire `onChange` When JSDOM Is Installed After `react-dom` Loads

- **Issue / Symptom**: In a React test that creates a `JSDOM` in `beforeAll` (see "React 19 Testing without `@testing-library/react`"), typing into an `<input>` (native value setter plus an `input` event) never called `onChange`. Checkbox `click()`s did work.
- **Root Cause**: `react-dom` checks once, at import time, whether the DOM exists and supports the `input` event. ES imports are hoisted above `beforeAll`, so the check runs with no `window`, and React falls back to key/selection-based change detection that synthetic `input` events never trigger.
- **Solution / Workaround**: For tests that type into inputs, put `// @vitest-environment jsdom` at the top of the file instead of creating a `JSDOM` manually, so the DOM exists before `react-dom` is imported (see `packages/react/tests/variables.test.tsx`). Then set the value with `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, v)` and dispatch `new Event("input", { bubbles: true })` inside `act`.

### [core/track-changes] Tracking Must Rewrite Transactions in `appendTransaction`, Not at the Input Layer

- **Issue / Symptom**: Intercepting keys (`handleKeyDown`, `handleTextInput`) to implement suggestion mode misses most edits: browsers delete single characters natively (ProseMirror reads the DOM change, so `editor.commands.keyboardShortcut("Backspace")` does nothing in jsdom), and cut, drag-and-drop, input rules and IME all bypass key handlers. Naive tracking also broke paragraph joins, re-tracked undo/redo, turned `setContent` into one giant deletion, and parsed `<del data-change-type="deletion">` as a Strike mark.
- **Root Cause**: Only the transaction stream sees every edit. `<del>` is also claimed by StarterKit's Strike `parseHTML` at the default priority. Undo/redo (`history$` meta), remote collaboration (`y-sync$`) and other plugins' appended transactions are replays or housekeeping, not user edits.
- **Solution / Workaround**: `TrackChanges` uses `appendTransaction`. For each `ReplaceStep` it marks the inserted range and re-inserts `tr.docs[i].slice(from, to)` at `rest.map(from, -1)` with the deletion mark (dropping text the same author inserted). Slices with no inline content (paragraph splits/joins) are left alone, as is content whose parent disallows marks (code blocks). It skips transactions with `history$`, `y-sync$`, `appendedTransaction` or `TRACK_CHANGES_SKIP_META` meta. While `view.composing` is true it buffers transactions and tracks them after `compositionend`, since rewriting the DOM around an active composition breaks IMEs. The appended transaction is merged into the same undo event by prosemirror-history. Parse rules use `priority: 100`. In tests, simulate Backspace with `editor.view.dispatch(state.tr.delete(from - 1, from))`.

### [core/comments] Comment Store Updates Must Not Dispatch Synchronously Inside Commands

- **Issue / Symptom**: Redrawing comment decorations by dispatching a transaction from the `CommentStore` listener can throw `Applying a mismatched transaction` or recurse when the store changes inside a command or a plugin view `update()`.
- **Root Cause**: Commands mutate the store before their own transaction is dispatched, and `syncAnchors` runs inside the plugin view update, so a synchronous dispatch from the listener interleaves with an in-flight transaction.
- **Solution / Workaround**: Commands set a refresh meta on their own `tr`, and `decorations(state)` reads the store snapshot (cached per doc + snapshot). External store changes (UI, `load()`) schedule one refresh with `queueMicrotask`, which is skipped when the decorations already reflect the snapshot. Deleted threads are kept off-snapshot so undoing "Delete Comment" can restore them when the mark reappears.

### [core/import] `plainTextToTipTapHtml` Passes `<p>…</p>` Text Through as HTML

- **Issue / Symptom**: Importing a `.txt` file whose content is `<p><img src=x onerror=…></p>` would insert live HTML instead of literal text.
- **Root Cause**: `plainTextToTipTapHtml` treats input that already looks like paragraph HTML as HTML (so it can round-trip TipTap output) and returns it unchanged.
- **Solution / Workaround**: For untrusted text (imported files, extracted RTF text) use `plainTextToParagraphHtml`, which always escapes. Import HTML with `sanitizeImportedHtml`, which drops `<script>`/`<style>`/`<head>` with their content, strips namespaced tags such as Word's `<o:p>`, and applies the markdown allowlist in `disallowedTags: "strip"` mode.

### [core/import] Parsed HTML Slices Are Open, and Drop Positions Can Fall Between Blocks

- **Issue / Symptom**: Dropping a file with `## Heading` into `<p>x</p>` produced `<h2>Headingx</h2>`. Dropping text into a prompt editor added an empty trailing paragraph.
- **Root Cause**: `DOMParser.parseSlice` returns a slice opened as far as possible, so its first/last blocks merge into the surrounding paragraph. `view.posAtCoords` often returns a position *between* blocks (e.g. `0`); inserting an open text slice there creates a new paragraph.
- **Solution / Workaround**: For imported HTML build a closed slice (`new Slice(parser.parse(body).content, 0, 0)`) and insert it with `tr.replaceRange`. For plain text, move the position into the nearest textblock with `Selection.near(doc.resolve(pos))` and use `tr.replace` with `plainTextToSlice`.

### [core/clipboard] ProseMirror's Copy Handler Clears Extra Clipboard Types

- **Issue / Symptom**: Writing a custom MIME type (`application/x.pixerate.document+json`) in a `copy` listener had no effect.
- **Root Cause**: ProseMirror's built-in copy/cut handler calls `clipboardData.clearData()` before writing `text/html` and `text/plain`, so anything a plugin wrote earlier is lost.
- **Solution / Workaround**: Take over the event: in `handleDOMEvents.copy`/`cut`, call `view.serializeForClipboard(slice)` (which still honours `clipboardTextSerializer`, e.g. markdown), write HTML, text and the custom type, `preventDefault()`, delete the selection for `cut`, and return `true`. Return `false` when there is no writable `clipboardData` so ProseMirror's handler runs. On paste, only accept the payload when its schema signature matches; otherwise fall back. Editor-level `editorProps.handlePaste` (e.g. `usePromptEditor`'s plain-text paste) runs before plugin handlers, so the plain-text invariant still wins there, and `EditorController` disables the rich paste path in `plainTextMode`.

### [svelte/tiptap] Passing `onUpdate: undefined` to TipTap Makes Every Update Throw

- **Issue / Symptom**: Any programmatic change in an `EditableTextNodeEditor` mounted without `onUpdate` (e.g. a file drop) threw `Cannot read properties of undefined (reading 'apply')` from `Editor.emit`.
- **Root Cause**: TipTap registers `options.onUpdate`/`onCreate` as event listeners with `this.on(...)`. Spreading an explicit `undefined` overrides TipTap's no-op defaults, so `emit` calls `undefined.apply`.
- **Solution / Workaround**: Only pass callbacks that are defined (`...(onUpdate ? { onUpdate } : {})`).

### [core/agent] Tool-List Notifications Must Be Coalesced and Compared

- **Issue / Symptom**: Registering one tool provider per mounted editor sends a burst of `tools/list_changed` notifications on page load, and React StrictMode's mount → unmount → mount announces changes that didn't happen.
- **Root Cause**: Every register/unregister/provider signal changes the registry, but MCP clients only care about the resulting list.
- **Solution / Workaround**: `ToolRegistry` schedules one check per `listChangedDelayMs` window and compares a JSON signature of `listTools()` with the last announced one, so remounts and content-only editor updates notify nothing. Register providers in effects and memoize them (`useMemo`) so they aren't re-registered on every render. Colliding names are namespaced per provider (`doc-1__get_text`) rather than "first wins", so names don't depend on mount order.

### [core/spreadsheet] Moving Cells (Sort, Transpose) Is Not an Insert/Delete, and Fill Is Not a Move

- **Issue / Symptom**: After sorting, `=A2*10` in a sorted row pointed at another row's value; a total row's `=SUM(B2:B5)` broke when ranges were rewritten cell by cell; autofilled formulas either all pointed at the source row or shifted `$A$1`.
- **Root Cause**: There are three different reference rewrites. Row/column insert/delete *shifts* references (`shiftFormulaReferences`). Sort and transpose *move* cells, so a reference must follow the cell it points at regardless of `$`, and a range can only be rewritten if its cells still form the same rectangle afterwards. Copy/paste and autofill *offset* a formula, so only relative parts change and `$` parts stay.
- **Solution / Workaround**: Use `remapFormulaReferences(formula, moveCell)` for sort/transpose (applied to every formula *before* moving cells, since rewriting only depends on old positions), and `offsetFormulaReferences(formula, dRow, dCol)` for paste/autofill. Ranges spanning a sorted block keep their text (they still cover the same cells); one-row ranges inside a sorted row follow the row. Sorting areas that contain merged cells is rejected, and merges (stored by index) are adjusted in `adjustTableForStructuralChange` on row/column insert/delete.

### [core/spreadsheet] Sort and Transpose Must Move Conditional Formats and Validations Too

- **Issue / Symptom**: After sorting, a highlight or a validation list set on one row's cells stayed on that row index and applied to whatever data landed there; after transposing, rules kept their old shape.
- **Root Cause**: Rule ranges (`table.conditionalFormats`, `table.dataValidations`) are stored by index and were only adjusted for row/column insert/delete. Rule formulas are written for the first range's top-left cell, so changing the ranges silently changes what relative references mean.
- **Solution / Workaround**: `sortRows` calls `sortRules` (Excel behaviour): the part of a rule range that spans every sorted row applies to the column and stays; parts covering only some sorted rows move row by row through the permutation (`sortRuleRanges`, re-merged with `mergeRuleRanges`). Whole-row sorts move rule cells past the last column too. When the first cell of a rule changes, its formulas are re-anchored (`reanchorRuleFormula`) so `$B2` keeps meaning "this row". `transposeRange` calls `transposeRules`: cells inside the block are transposed, rule cells under the transposed block are dropped (the block replaces them), and formulas are rewritten with `transposeFormulaReferences` (relative offsets and `$` flags swap axes; `$` parts outside the block keep their text). A rule with formulas that is only partly inside the block is split into two rules (the moved part gets a new id, right after it), since one formula can't serve both layouts. Rule formulas are not remapped like cell formulas on sort. Both run inside the sort/transpose snapshot (one undo step); the overlay is rebuilt because the change recalculates everything.

### [core/spreadsheet] Filters, Hidden Rows and Categories Belong in the View Model

- **Issue / Symptom**: Filtering by deleting/hiding rows in the document made undo, formulas (`SUM` over filtered rows) and data-source syncs inconsistent; keyboard navigation landed on hidden rows; merged-cell spans broke when part of a merge was hidden or grouped elsewhere.
- **Root Cause**: Filters, user-hidden rows/columns and collapsed groups are presentation, not data. Category groups also reorder rows on screen without reordering the document.
- **Solution / Workaround**: Keep every row in `document.rows`; store user hiding as `hidden: true` on rows/columns and filter/grouping/merge state in `document.table` (so the snapshot undo covers it). Render from `controller.getViewModel()`, which returns rows (with group headers) and columns in display order, sticky offsets and `getCellSpan(row, col)` (null for cells covered by a merge). `moveCursor` steps through `viewModel.rowOrder`/`columnOrder`. `DataSourceBinder.syncRows` rebuilds record rows, so it must carry `hidden` over. A sort of a data-bound sheet lasts until the next `syncWithDataSource()`, which restores the data source's record order.

### [react|svelte/spreadsheet] Copy/Paste Events Fire on `<body>`, Not the Focused Grid; `preventDefault` on Mod+C Suppresses Them

- **Issue / Symptom**: Writing `text/html` and the custom `application/x.pixerate.spreadsheet+json` clipboard formats never happened from the grid's `onCopy`, and the keydown handler's `navigator.clipboard.writeText` overwrote the rich data.
- **Root Cause**: The async Clipboard API cannot write arbitrary MIME types; only a `copy` event's `clipboardData` can. With no text selection, browsers dispatch `copy`/`paste` at `<body>`, not at a focused non-editable `div`. Calling `preventDefault()` on the Mod+C keydown cancels the copy event entirely. In jsdom no copy event follows a synthetic keydown.
- **Solution / Workaround**: Listen for `copy`/`paste` on `document` and act only when focus is inside the grid but not in a text input (cell editor, formula bar). On Mod+C, don't prevent default; schedule a `setTimeout(0)` fallback that writes TSV with `writeText` only if no copy event handled it (the copy event fires synchronously during the keydown's default action, before any task). Tests must dispatch a `copy`/`paste` `Event` with a stubbed `clipboardData`, or wait a tick for the fallback.

### [core/spreadsheet] Formula Ranges Arrive Flat and Column-Major

- **Issue / Symptom**: Lookup functions (INDEX, VLOOKUP, XLOOKUP) picked the wrong cells.
- **Root Cause**: `EvaluationContext.resolveRange` returns one flat array, column by column (the controller's loop order), with no row/column shape.
- **Solution / Workaround**: The evaluator records each range's shape (`withRangeShape`, a `WeakMap` keyed by the array, columns taken from the range reference) and functions read ranges through `ctx.range(i)` / `rangeGet(range, row, col)`. Never assume row-major order. Custom `resolveRange` implementations must return values column-major. Functions that would return a whole row/column return a shaped array: other functions can aggregate it, `evaluateWithDiagnostics` returns it as `array` (with the top-left value as `value`), and the controller spills it (see the dynamic-arrays entry).

### [core/spreadsheet] Typed Input Must Be Parsed, or `=B1>8` Treats a Typed `7` as Text

- **Issue / Symptom**: With typed cells stored as their raw text, a typed `7` was the string `"7"`, so `=B1>8` was TRUE (text ranks above numbers), `FILTER(A:A, A:A>8)` kept small numbers, `MATCH(5, …)` missed a typed `5`, and sort put `10` before `9`.
- **Root Cause**: `CellData.value` was set to `raw` for non-formula input, and the strict Excel comparison (`"1"=1` is FALSE) is correct only if typed numbers are numbers. Patching individual functions (`numericValue` / `normalizeValue` in lookups and criteria) hid the problem without fixing operators.
- **Solution / Workaround**: `setCellValue` (and so CSV/TSV import, `importRows`, paste and autofill) stores `parseCellInput(raw).value`: numbers (`1,234`, `$5`, `10%`, `(100)`, `1e3`, `1 1/2`), booleans, error literals, ISO dates and text; `raw` stays as typed and a leading `'` forces text. `loadDocument` and the constructor re-parse stored typed cells from `raw`, so old documents with `value: "7"` work. Bound columns are different: values read from the data source are never re-parsed, and writes are coerced only for `number`/`boolean`/`date` fields. Display through `formatCellDisplay(cell)`, which applies the automatic `numberFormat` (`10%` stays `10%`, not `0.1`). Comparisons go through `compareValues` (Excel order numbers < text < booleans < errors; numbers at 15 significant digits so `0.1+0.2=0.3`); sorting through `sortCompareValues` / `compareCellValues` (blanks last). `numericValue` still accepts numeric text for lookups, criteria and SUM-style functions, because data sources can supply numbers as strings.
- **Date representation**: dates stay ISO text (`3/4/2026` → `"2026-03-04"`, with a time `"2026-03-04 18:00:00"`), because date arithmetic, DATE/TODAY and existing documents all use ISO text. A time typed alone (`10:30`) becomes a day fraction (0.4375) like Excel, shown with its `h:mm` format. ISO text can't hold Excel's fictitious 1900-02-29, so typing it keeps text (as numeric text in a formula it is serial 60). `parseNumberText` turns date text into 1900-system serials (`serialFromYmd`); `dateToSerial` counts from 1899-12-30 and so differs by one for dates before 1900-03-01.

### [core/spreadsheet] `isFormulaError` Narrows `string` to `never`

- **Issue / Symptom**: After `if (isFormulaError(text)) return text;`, TypeScript reports `Property 'trim' does not exist on type 'never'` for a `string` variable.
- **Root Cause**: `isFormulaError(value): value is string` is a type guard. For a value already typed `string`, the false branch removes `string` entirely, even though most strings are not errors.
- **Solution / Workaround**: In formula function code, use `failed()` from `functions/helpers.ts`. Its overloads only narrow unions such as `number | string` and leave plain `string` results (`ctx.text(i)`) alone. In shared helpers, test `FORMULA_ERRORS.has(value)` instead of the guard.

### [react/svelte spreadsheet] Formula Autocomplete Keys and Clicks Must Not Reach the Grid or Blur the Editor

- **Issue / Symptom**: Pressing Tab or ArrowDown to pick a formula suggestion committed the cell and moved the selection. Clicking a suggestion committed the half-typed formula. The suggestion popup was clipped inside the cell.
- **Root Cause**: The grid handles Tab/arrows/Escape in a `keydown` handler that React and Svelte 5 both delegate to the root. The cell editor commits on `blur`, and clicking elsewhere blurs it. Cells use `overflow: hidden`.
- **Solution / Workaround**: `FormulaHints` adds a native `keydown` listener on the input element itself. It runs during the target phase, before the root-delegated handlers, and calls `stopPropagation()` only while suggestions are open. Enter is never intercepted, so it still commits. Suggestions accept on `mousedown` with `preventDefault()`, so focus stays in the input. The popup uses `position: fixed` from the input's bounding rect to escape cell clipping. In Svelte, update the caret state *before* calling `onAccept`. If you only update it after `tick()`, the hints are briefly computed from the new value and the old caret.

### [core/document-structure] Derived Node State Is Missing From the Initial Document

- **Issue / Symptom**: Headings created from initial `content` had no ids, a table of contents rendered empty and footnotes were unnumbered until the first edit, so `getHTML()` right after `new Editor(...)` (e.g. markdown → HTML conversion) produced incomplete output.
- **Root Cause**: Heading ids, TOC entries, footnote numbers and cross-reference labels are stored in node attributes and kept in sync by `appendTransaction`, which never runs for the document passed to `EditorState.create`. TipTap emits `create` (and so `onCreate`) from a `setTimeout`, so a fix-up dispatched there arrives a tick late.
- **Solution / Workaround**: `syncInitialContent` (in `extensions/document-structure/utils.ts`) runs the same sync pass in `onBeforeCreate`: it parses `editor.options.content`, applies the fix, and hands TipTap the resulting node. Those extensions use a priority below the Markdown extension's (50) so markdown has already been converted to HTML when they run, and `Outline` (45) runs before the extensions that read heading ids (40).

### [core/document-structure] Custom Parse Rules Lose to `listItem` and `Link` Without a Priority

- **Issue / Symptom**: Footnotes parsed from HTML or markdown came back empty, and a cross-reference (`<a data-type="cross-reference" href="#…">`) turned into plain linked text after `getHTML()` → `setContent()`.
- **Root Cause**: ProseMirror's `DOMParser.schemaRules` orders rules by priority (default 50), then lists **all mark rules before node rules**, then schema order. `li[data-type="footnote"]` lost to StarterKit's `li` rule, and the Link mark's `a[href]` rule matched before the cross-reference node rule.
- **Solution / Workaround**: Give specific parse rules `priority: 60` (done for the TOC, footnote, cross-reference and bookmark rules). Cover new nodes with an HTML round-trip test.

### [core/markdown] tiptap-markdown Re-runs `parse.setup` Before Every Parse

- **Issue / Symptom**: Custom markdown-it rules registered in an extension's `storage.markdown.parse.setup` would be added again on every `setContent`, and `[^1]: note` footnote definitions were swallowed as link reference definitions.
- **Root Cause**: `MarkdownParser.parse` calls every extension's `setup(md)` on the same markdown-it instance for each parse. markdown-it's `reference` block rule runs before most rules and accepts `[^1]: …` as a reference definition (label `^1`), and its `link` inline rule then consumes `[^1]`.
- **Solution / Workaround**: Guard plugins with a per-instance `WeakMap` (see `document-structure/markdown-it.ts`), and register footnote/TOC block rules `before("reference")` and the reference inline rule `before("link")`.

### [core/autocorrect] Input-Rule Replacements Cannot Be Undone Separately

- **Issue / Symptom**: With TipTap input rules (e.g. Typography's `--` → `—`), Mod-z after a replacement removed the replacement *and* the surrounding typing, unlike Word where undo restores exactly what was typed. With both Typography and `Autocorrect` installed, Typography's rules won for quotes and dashes.
- **Root Cause**: TipTap's input rules insert the typed character and the replacement in one transaction, which `prosemirror-history` merges into the current typing group. TipTap's input-rule plugin is registered before extension plugins, so its `handleTextInput` runs first.
- **Solution / Workaround**: `Autocorrect` handles `handleTextInput` itself and dispatches two transactions: the typed text (normal grouping) and the correction marked with `closeHistory`, so it is its own undo step; the next typed character is also `closeHistory`-ed so it does not join the correction. `createRichTextPreset({ autocorrect })` drops Typography; do not install both.

### [core/spreadsheet] `Date.now()` + Short Random Suffix Ids Collide When Growing the Grid

- **Issue / Symptom**: A 3,000-row chain of formulas imported with `importFromTsv` sometimes evaluated to `#CYCLE!`, and only under load (full test runs). Copy/paste tests flaked the same way.
- **Root Cause**: Row and column ids were `${prefix}_${Date.now()}_${4 random base-36 chars}`. Growing the grid creates thousands of rows within a few milliseconds, so two rows could get the same id (birthday collisions on ~1.7M values). Cells are stored by row id, so the two rows shared storage and the dependency chain appeared to loop.
- **Solution / Workaround**: Generated ids (rows, columns, filter rules) include a module-wide monotonic counter. Never build ids from time plus a short random suffix where many can be created in one tick. `spreadsheet-engine.test.ts` checks that 5,000 rows created in one burst have unique ids.

### [monorepo] Feature subpaths must not import the root `@pixerate/editor` entry

- **Issue / Symptom**: A spreadsheet-only consumer still bundles TipTap, markdown-it and ProseMirror, or must install `@dagrejs/dagre`, even though the spreadsheet code uses none of them.
- **Root Cause**: The root entry re-exports the TipTap extensions and serializers, so any binding that imports a spreadsheet helper from `@pixerate/editor` (instead of `@pixerate/editor/spreadsheet`) drags the whole rich-text graph in whenever the bundler cannot tree-shake (CJS, dev builds, `sideEffects` not honoured). Separately, anything in `dependencies` is installed for every consumer, whatever entry they use.
- **Solution / Workaround**:
  1. Inside `packages/react/src/{spreadsheet,image-editor}` and `packages/svelte/src/{spreadsheet,image-editor,history}`, import from the narrow core subpath (`@pixerate/editor/spreadsheet`, `/image-editor`, `/history`), never the root.
  2. Keep feature-only third-party packages (e.g. `@dagrejs/dagre`, `@xyflow/*`) in optional `peerDependencies` plus `devDependencies`, never `dependencies`.
  3. `tests/entry-isolation.test.ts` in each package walks the built entry's import graph and fails if a forbidden package becomes reachable. These tests read `dist/`, so run `pnpm build` first.

### [core/import] `DecompressionStream` Output Must Be Pulled Incrementally to Stop Zip Bombs

- **Issue / Symptom**: A 4 KiB deflate entry that declares a 100-byte size can inflate to gigabytes; checking sizes only after `new Response(stream).arrayBuffer()` lets it exhaust memory first. jsdom's `Blob` also has no `stream()`, so `blob.stream().pipeThrough(...)` helpers fail in React/Svelte tests.
- **Root Cause**: ZIP headers are untrusted; only the bytes actually produced by the inflater count. Buffering helpers (`Response.arrayBuffer`) read the whole stream before returning.
- **Solution / Workaround**: `readZip` feeds input in 64 KiB slices and reads output chunk by chunk, cancelling the reader and aborting the writer as soon as the output exceeds the entry's declared size (or the archive's remaining `maxTotalSize` budget), then verifies CRC-32. Swallow the writer's rejection (`.catch(() => {})`) after cancelling, or it surfaces as an unhandled rejection. In tests, drive `CompressionStream` through `getWriter()` / `getReader()` instead of `Blob.stream()`.

### [core/import] DOCX Attributes Are Namespaced, and Images Need a Schema With `image`

- **Issue / Symptom**: `el.getAttribute("val")` returns `null` for `<w:b w:val="0"/>`, so formatting toggles were ignored; DOCX images vanished in editors created with `image: false`.
- **Root Cause**: WordprocessingML attributes live in the `w:` / `r:` namespaces (and Strict OOXML uses different namespace URIs). Import adapters do not know the target schema, and ProseMirror's `DOMParser` drops `<img>` when there is no `image` node.
- **Solution / Workaround**: Read attributes by `localName` (the `attr()` helper in `import/docx.ts`) and accept both transitional and strict `w:` namespaces. The DOCX adapter always emits `<img>` data URLs (PNG / JPEG / GIF / WebP only — the sanitizer's `data:` allowlist) and lets the schema decide; pass `images: false` to skip reading media entirely.

### [core/canvas] Polygon Booleans Break on Shared Edges and Touching Vertices

- **Issue / Symptom**: Uniting two shapes that share an edge (e.g. snapped side by side) or touch at a corner produced figure-eight rings, leftover zero-width slivers, or dropped the result, and the result changed when one shape moved by `1e-12`.
- **Root Cause**: Classic clipping algorithms (Greiner–Hormann, naive Martinez) assume edges cross at isolated points. Shared and collinear edges, vertices lying on edges and floating-point intersections that land a hair off both segments break their in/out bookkeeping.
- **Solution / Workaround**: `polygonBoolean` builds a planar overlay instead: points closer than `epsilon` are merged through a grid-hashed pool, segments are split at crossings, T-junctions and collinear overlaps (repeated until stable, because snapping moves segments slightly), and coincident segments are merged with a signed count per operand. Each edge's sides are classified by a winding-number ray cast from its midpoint, with the ray crossing the edge rather than running along it. Rings are traced taking the sharpest left turn, so rings touching at a vertex stay separate simple rings. Test new cases with the area identity `|A∪B| = |A| + |B| − |A∩B|` and random point membership (see `canvas-shapes.test.ts`).

### [core/canvas] SVG Arc Flags Can Be Written Without Separators

- **Issue / Symptom**: `a5 5 0 0110 0` was parsed as the flags `0`, `110` (or, with a number tokenizer, lost its leading zero), so arcs went to the wrong point.
- **Root Cause**: In SVG path data, the large-arc and sweep flags are single characters `0` or `1` and need no separator, so `0110 0` means flags `0`, `1` and `x = 10`. A regex tokenizer reads `0110` as one number.
- **Solution / Workaround**: `parseSvgPath` uses a scanner that reads exactly one character for the two flag slots of `A` / `a` and normal numbers elsewhere.

### [core/spreadsheet] Dynamic Arrays: Spill Ranges Are Only Known After Evaluation

- **Issue / Symptom**: A formula reading a spilled cell (`=A2*10` next to `A1` = `=SEQUENCE(3)`) showed 0 after loading a document or the first time the array spilled, and stayed stale when the array changed size; typing into a spilled cell or clearing a blocking cell didn't update the anchor; `=SEQUENCE(2)+A2` in A1 oscillated between a value and `#CYCLE!`.
- **Root Cause**: The dependency graph is built from formula text, but which cells an array covers depends on its *result*. Before the anchor is evaluated nothing links `A2` to `A1`, so the topological plan can evaluate `A2`'s dependents first. Spilled cells have no formula, so editing one never reached its anchor, and a blocked anchor had no edge to the cells blocking it.
- **Solution / Workaround**: Spilled values are derived state kept in the controller (never written to `document.cells`; `getCell` overlays them with `raw: ''` and `spillAnchor`). After placing a spill the controller calls `DependencyGraph.setSpillEdges(anchor, spilledKeys, blockingKeys)`: spilled cells depend on the anchor, a `#SPILL!` anchor depends on its blockers. These edges live apart from formula edges (so `setCellFormula` doesn't drop them) and `recalculateAll` clears them. `recalculateKeys` runs the plan in passes: when a pass changes which cells are spilled, it re-plans from those cells with their dependents, until nothing changes (capped). A cyclic anchor clears its values but keeps its spill edges so the cycle is still found on the next pass. `A1#` depends on the anchor only. The grid never grows to fit an array (Excel doesn't either): past the edge is `#SPILL!`. Sorting, merging or transposing a range that touches a spill is refused (`false`), like Excel's "can't change part of an array".

### [core/track-changes] Code Blocks Reject Marks via `marks: ""`, and `extendNodeSchema` Cannot Override It

- **Issue / Symptom**: Insertions and deletions inside code blocks were silently untracked, and an extension's `extendNodeSchema(() => ({ marks: "insertion deletion" }))` had no effect.
- **Root Cause**: TipTap's `CodeBlock` sets `marks: ""`, and `getSchemaByResolvedExtensions` spreads `extendNodeSchema` fields *before* the node's own fields, so the node's `marks` always wins. `NodeType.allowsMarkType` reads `markSet`, which is computed once when the schema is built.
- **Solution / Workaround**: `TrackChanges` (`trackCodeBlocks`, default on) appends the insertion/deletion mark types to `markSet` of every `code` textblock in `onBeforeCreate`, which runs after the schema is created but before the document is parsed. Formatting marks stay disallowed. Schemas built headlessly with `getSchema(extensions)` do not get the patch, so tracked marks inside code blocks are dropped there.

### [core/track-changes] Formatting and Block Changes Need Per-Step Detection and Final-State Comparison

- **Issue / Symptom**: Comparing whole documents to find formatting or block changes is slow and ambiguous; comparing per step misattributes changes when one transaction changes the same text or block twice (toggle list = wrap + join; `setNode` copies attributes, including the `blockChange` record, to the new node).
- **Root Cause**: `AddMarkStep` / `RemoveMarkStep` (and `ReplaceStep`s whose content only differs in marks) say *where* formatting changed; `ReplaceAroundStep` (setBlockType, setNodeMarkup, wrap, lift) and `AttrStep` say *which* textblocks changed. Only the old document (`oldState.doc`, or the record already stored on the old node) knows the original state.
- **Solution / Workaround**: Steps only collect ranges/textblocks (mapped to the final document). Afterwards each text segment is mapped back with the inverted mapping to the old document and its original formatting (the old `formatChange.before`, or its marks) is compared with the current marks; textblocks compare the original snapshot (type, attrs minus ignored ones like outline `id`, wrapper types) with the final one. Equal → the record is removed (the change was reverted). Textblocks with no counterpart in the old document (splits) are skipped, and `blockChange` uses `keepOnSplit: false`. Restoring wrappers on reject ports prosemirror-schema-list's `sinkListItem` / `liftToOuterList` for list items and uses `lift` / `wrap` + `join` otherwise. Limitation: outdenting a nested item that has following siblings re-parents those siblings without changing their depth, so they get no record and rejecting the outdent nests them one level deeper. Paragraph splits/joins are not tracked at all. Converting to a code block drops incompatible marks, which reject cannot restore.

### [core/compare] Whole Paragraphs Have No Inline Representation, So Compare Records Them as `blockChange` Operations

- **Issue / Symptom**: Marking an inserted paragraph's text with `insertion` (and a deleted one's with `deletion`) is not enough: rejecting the insertion (or accepting the deletion) removes the text but leaves an empty paragraph, so "reject all" never reproduced the original document after `compareDocuments`.
- **Root Cause**: ProseMirror block boundaries are not characters (unlike Word's paragraph marks), and `TrackChanges` deliberately does not track paragraph splits/joins.
- **Solution / Workaround**: `compareDocuments` records wholly inserted/deleted blocks as `blockChange` records with `operation: "insert" | "delete"` on every textblock inside (one change id per run; the text itself is not marked). `applyDecision` removes accepted deletions / rejected insertions first (`removeBlocks`), taking along containers whose textblocks are all removed (list items, lists, quotes, rows), and replaces an emptied document with an empty paragraph. The tracker never rewrites or clears records that have an `operation`. `getEditorText` strips tracked text with `<ins>`/`<del>` regexes, which cannot see whole-block operations, so documents containing them are resolved with `resolveTrackedChanges` and re-serialized before the text is extracted. Limits: atom blocks (images, rules) and textblocks without the `blockChange` attribute cannot carry a record (reported in `summary.notHonoured`); `blockChange` is `keepOnSplit: false`, so pressing Enter inside an inserted block leaves the new half untracked. Container attribute changes (task `checked`, ordered-list `start`) are not tracked either.

### [core/compare] Word Tokens With Trailing White Space Misalign Before Punctuation

- **Issue / Symptom**: With "word + trailing space" tokens (as in wordcraft), `Old line.` → `New line here.` reported `Old line` deleted and `New line here` inserted, because `line` (before `.`) and `line ` are different tokens.
- **Root Cause**: The trailing white space is part of the token key, so the same word differs by position.
- **Solution / Workaround**: Words, white-space runs and symbols are separate tokens; equal runs that are only white space between two changes are absorbed into one replacement (`stretches()`), so `a b c` → `x y z` stays a single deletion + insertion instead of alternating. Note that `ignoreCase`/`ignoreWhitespace` keep the revised text without a change, so reject-all cannot restore those differences (by design), and code blocks in a headless `getSchema()` schema (no tracked marks, see the code-block entry above) are compared as whole-block replacements.

### [react/spreadsheet] Cell Editor Drafts Must Reach the Controller

- **Issue / Symptom**: In the React `SpreadsheetEditor`, text typed into a cell was thrown away on Enter, Tab or blur (the cell kept its old value). Only the formula bar worked. Found in the demo; no jsdom test typed into the cell input.
- **Root Cause**: `useSpreadsheetEditor` returned React's own state setter as `setDraftValue`, but `commitEditing()` (called without an argument) commits `controller.draftValue`, which never changed. Svelte's `draftValue` setter already wrote through to the controller.
- **Solution / Workaround**: `setDraftValue` writes `controller.draftValue` and the React state. Any binding that keeps its own copy of the draft must keep the controller's copy in sync.

### [react|svelte/spreadsheet] Type-to-Edit Doubled the Key, and Focus Was Lost After Enter

- **Issue / Symptom**: Typing `1` on a selected cell produced `11` (React). After Enter, the next keys went nowhere because focus fell to `<body>`. In Svelte the cell input was never focused, so only the first key landed.
- **Root Cause**: The grid's keydown handler starts editing with `e.key` as the draft but did not `preventDefault()`, so the browser also typed the key into the newly focused input. When the cell input unmounts on commit, the browser moves focus to `<body>`.
- **Solution / Workaround**: Call `preventDefault()` when a printable key starts editing, focus the cell input with the caret at the end (React `autoFocus` + `onFocus`, Svelte `$effect`), and refocus the grid after Enter / Tab / Escape. In Svelte, typing in the formula bar also opens the cell editor, so only focus the cell input when no other input has focus. Browser automation that "types" with `Input.insertText` sends no keydown, so drive type-to-edit with key presses.

### [react|svelte/spreadsheet] Sticky Headers Need Opaque Backgrounds, and Fixed Menus Must Be Clamped

- **Issue / Symptom**: Scrolled cells showed through the sticky column-header row and the row numbers. The right-click menu opened near the bottom of the window ran off-screen, leaving its last items unreachable.
- **Root Cause**: The sticky cells used translucent `bg-muted/60`, `/50` and `/90`. The menu is `position: fixed` at the pointer with no viewport check, and fixed elements do not scroll with the page.
- **Solution / Workaround**: Use an opaque `bg-muted` on sticky cells. Measure the menu after render and place it with `clampMenuPosition` (core): flip above / left of the pointer, or slide back into the viewport, plus `max-height` and `overflow-y: auto`.

### [core/canvas] React Flow's Drag-Stop Change Undoes the Last Snap, and `NodeChange` Has Id-less Members

- **Issue / Symptom**: Smart guides snapped nodes while dragging, but on release the node jumped back a few pixels to the raw pointer position. Separately, `applyNodeChanges(arrange.snapPositionChanges(changes), nodes)` did not type-check with React Flow's `NodeChange[]`.
- **Root Cause**: xyflow keeps its own drag positions computed from the pointer and reports them again in the final `dragging: false` change (SvelteFlow writes them into `nodes` before `onnodedragstop`). React Flow's `NodeChange` union includes `{ type: 'add', item }`, which has no `id`, so it was not assignable to `PositionChangeLike`.
- **Solution / Workaround**: The arrange controller remembers the last snapped positions: `snapPositionChanges` rewrites the drag-stop change with them, and `endDrag()` writes them back after a SvelteFlow drop. `PositionChangeLike.id` is optional.

### [demo/theme] Library Components Read Theme Tokens Both as Tailwind Colors and as Raw CSS Variables

- **Issue / Symptom**: Without theme tokens, the spreadsheet, review panel and menus rendered unstyled in the demo (transparent popovers, invisible borders and selection).
- **Root Cause**: Components use shadcn classes (`bg-background`, `bg-primary/10`, `border-border`) and also inline styles such as `var(--primary, #6366f1)` and `var(--popover, …)`. shadcn's usual HSL-triple variables (`--primary: 240 5% 26%`) are invalid when used directly as a color, and Tailwind colors defined as plain `var(--x)` lose opacity modifiers.
- **Solution / Workaround**: The demo defines `--x-rgb` channels for Tailwind (`rgb(var(--x-rgb) / <alpha-value>)` in `apps/demo/tailwind.config.js`) and full colors `--x: rgb(var(--x-rgb))` for inline styles (`apps/demo/src/index.css`). Hosts using shadcn HSL triples should also define full-color `--primary`, `--background`, `--muted` and `--popover`.

### [core/image-editor] Changing How Saved Adjustments Render Needs a New Process Version

- **Issue / Symptom**: Improving the adjustment maths (linear-light exposure, Bradford white balance, tone LUTs) changed how every saved edit looked; `{ ...DEFAULT_ADJUSTMENTS, ...saved }` silently moved old edits to the new rendering. The old 8-bit path also clamped after each step, so exposure up then contrast down turned distinct highlights into one flat grey.
- **Root Cause**: Adjustment values have no meaning without the algorithm that interprets them, and a default spread fills a missing field with the *new* default.
- **Solution / Workaround**:
  1. `ImageAdjustments.process` selects the rendering. A missing or damaged value is process 1 (`normalizeProcessVersion`), which `applyLegacyAdjustments` renders unchanged (frozen; `tint` is ignored there). New edits and Reset get `LATEST_PROCESS_VERSION` (2). Load stored adjustments through `normalizeStoredAdjustments`, never `{ ...DEFAULT_ADJUSTMENTS, ...stored }`.
  2. Process 1 is serialized without `process` (and without a zero `tint`), so old documents round-trip byte for byte. `upgradeProcess()` is the one explicit, undoable way to move an edit forward.
  3. A future look change adds process 3 and a new branch in `applyAdjustments`; never edit process 1 or 2 output in place (bug fixes for broken output excepted). The legacy pixel snapshot in `tests/image-editor-color.test.ts` guards this.
  4. Process 2 is identity at neutral within ±1 only because the tone LUT's highlight shoulder degenerates to the identity when headroom is 1 and the encode LUT has 65 536 entries. Keep `headroom = max(1, reach)` per channel; a fixed shoulder would shift unedited highlights.
  5. The renderer's base-canvas cache key must include every field that affects pixels (`tint`, normalised `process`), or switching process shows a stale image.

### [core/image-editor] Adjustment Layers Must Not Change How Layer-Free Edits Load, Save or Render

- **Issue / Symptom**: Adding `layers` to the editor state risked re-serializing every old document (a new schema version, an empty `layers: []`), a stale preview after editing a layer, and a different look for edits that never used layers.
- **Root Cause**: Saved documents are compared and diffed as JSON; the renderer caches the adjusted base canvas by a key of the fields that affect pixels; and layer maths that ran on every pixel (even as an identity) would round values differently.
- **Solution / Workaround**:
  1. Layers live in `adjustments.layers` and are **absent** (not `[]`) when there are none: `normalizeStoredAdjustments`, `setAdjustments` and the layer methods delete the key for an empty list. Only states with layers serialize as `version: 2`; layer-free states stay `version: 1`, byte for byte. Load through `migrateSerializedImageEditorState` / `normalizeAdjustmentLayers`, which clean and clamp stored layers.
  2. `applyAdjustmentLayers` runs after the base process (1 or 2) and before blur, on the encoded 8-bit result, and skips neutral, disabled and zero-opacity layers entirely (`compileAdjustmentLayer` returns `null` for the identity), so no layers means no extra pass.
  3. The renderer's base key includes `adjustmentLayersKey(layers)`. Per-layer LUTs are cached by `kind + JSON(params)`, so slider drags only recompile the layer that changed.
  4. Levels work on whole levels (quantum 255) like Photoshop's 8-bit documents; Curves and Levels apply each channel's record before the master.

### [core/image-editor] Canvas `soft-light` Is Not Photoshop's Soft Light; Scalar Blend Fallback Must Stay Inside the Clip

- **Issue / Symptom**: Annotations drawn with `globalCompositeOperation = 'soft-light'` looked different from adjustment layers in Soft Light, and modes such as Linear Burn, Pin Light, Hard Mix, Subtract and Divide have no canvas operation at all.
- **Root Cause**: Canvas implements the W3C Compositing soft light; Photoshop's uses a different formula for a light source (`cs > 0.5`: `2·cb·(1 − cs) + √cb·(2·cs − 1)`). The other modes simply do not exist in Canvas 2D.
- **Solution / Workaround**: `BLEND_MODES[].canvas` lists an operation only where the maths match (`soft-light` is `null`). For the rest, `drawAnnotation` draws the annotation on a same-size layer with the same transform, blends it into a copy of the target pixels with `blendImageData`, and draws the result back with `globalCompositeOperation = 'copy'` under an identity transform: `copy` only replaces pixels inside the current clip, so the image-region clip still holds. Without pixel access (tainted or headless canvas) it falls back to a normal draw.

### [svelte/image-editor] Subscribing to a Controller Inside `$effect` Loops Forever

- **Issue / Symptom**: Mounting the Svelte `AdjustmentLayersPanel` threw `effect_update_depth_exceeded`, and the existing image editor test took 9 s before failing.
- **Root Cause**: `controller.subscribe(listener)` calls the listener synchronously; a listener doing `tick++` reads and writes `tick` inside the effect, so the effect depends on the state it writes.
- **Solution / Workaround**: Subscribe inside `untrack(() => controller.subscribe(...))` and return the unsubscribe function. Keep large per-render objects such as the histogram in `$state.raw`, so they are not deep-proxied on every render.

### [core/history] Keyed Gestures Merge Commands, so Commands Must Be Absolute or Untagged

- **Issue / Symptom**: A held gesture (`beginGesture`) that drags two parameters (volume and pan) into one undo step would redo only the last one, and undo would restore only one of them, if the merge kept "first undo + last redo" as the time-window `executeMerged` does.
- **Root Cause**: "Keep the first undo, take the last redo" is only correct when every merged command sets the *same* thing to an absolute value. Different parameters (or relative commands like "increment") need every command's undo and redo.
- **Solution / Workaround**: A keyed step keeps a list of parts. A merged command whose `tag` equals the last part's `tag` replaces that part's redo (absolute-command assumption, as before); anything else is appended, and undo runs the parts in reverse. Give absolute "set" commands a `tag` so long drags stay one small part; leave relative commands untagged. Gestures end on any other recorded command, undo, redo, `revertTo`, `goTo`, `clear` or `endGesture()`; reads, marks and empty batches do not end them.

### [core/history] Undo Marks Must Detect a Lost Start, Not Just a Lost Top

- **Issue / Symptom**: `revertTo(mark)` for a mark taken on an empty history (Escape on the first drag) would undo steps that existed before the drag once `maxDepth` / `maxBytes` had dropped the bottom of the stack, and a naive mark would survive `clear()`.
- **Root Cause**: A mark that points at "no top step" cannot be found in the stack, so "undo until the top is the marked step" runs to the bottom of whatever is left.
- **Solution / Workaround**: Marks carry the marked step's id plus a `dropped` counter and an `epoch` (bumped by `clear`). An empty-history mark is valid only while nothing has been dropped; any mark from an older epoch is a no-op returning 0. Reverted steps are removed outright (and undone steps made after the mark are filtered out of redo), so redo never brings a cancelled drag back.

### [core/dirty] Dirty Tracking Must Compare Values, Not Count History Steps

- **Issue / Symptom**: Navigation guards kept prompting after undoing back to the saved state, selecting text or zooming marked the document modified, and loading a file marked it dirty before the user typed anything.
- **Root Cause**: A "changed since save" boolean set by every edit never goes back to false on undo; whole-state comparison counts view state (selection, viewport); programmatic loads go through the same change paths as user edits.
- **Solution / Workaround**: Use `bindDirtyToHistory({ history, getValue, normalize })` (React `useHistoryDirty`, Svelte `createHistoryDirty`): every history change re-compares `normalize(value)` with the saved baseline (cached per `history.getRevision()`), so undo-to-saved is clean. Strip view state in `normalize`. Wrap loads/restores in `suppress(fn)`: it is re-entrant (depth counter), lasts until a returned promise settles, and rebaselines to the loaded value even if the load bypassed the history. Changes made outside the history (e.g. selection) need `refresh()`, which ignores the revision cache.

### [react|svelte/image-editor] The Agent's Cursor on `ImageEditorCanvas` Must Not Clip to the Canvas

- **Issue / Symptom**: After the canvas moved out of `ImageEditor` into `ImageEditorCanvas`, the agent's cursor vanished whenever playback clicked a tab or visited a slider: it was drawn, but outside the canvas box.
- **Root Cause**: `PresenceLayer` is `position: absolute; inset: 0; overflow: hidden` over its parent. `ImageEditor` used to put it over its whole root, so tabs and panels were inside it; the canvas component draws it over the canvas only, while `open` and `target` steps aim at the host's chrome around it.
- **Solution / Workaround**: `PresenceLayer` takes `clip={false}`, and `ImageEditorCanvas` uses it, with its root `position: relative` and only the inner canvas box `overflow: hidden`. The cursor then reaches any chrome inside the nearest clipping ancestor. Hosts whose chrome is outside a clipping ancestor (a flow node, a scroll box) should answer those refs through `locate` / `locateElement` with chrome inside it, or accept the cursor stopping at the edge.

### [react|svelte/image-editor] Mapping the Slate Palette to Tokens: `hover:text-white` Became a No-Op

- **Issue / Symptom**: After moving the image panels from slate / indigo classes to shadcn tokens, small buttons showed no hover state at all.
- **Root Cause**: The old buttons were `text-slate-300 hover:text-white`; both map to `text-foreground`, so the hover changed nothing. Light themes also lose contrast tricks that relied on a dark background (white text on `bg-slate-800`).
- **Solution / Workaround**: Hover states use a background (`hover:bg-muted`, or `hover:bg-accent hover:text-accent-foreground` on `bg-muted` buttons), and filled controls pair `bg-primary` with `text-primary-foreground`. Use the constants in `image-editor/styles.ts` rather than writing new combinations. `tests/image-editor-tokens.test.*` fails if a slate / indigo / purple / emerald / rose class comes back in any tab.

### [core/canvas] xyflow Resizers Report Raw Sizes, and SvelteFlow Writes Them After `onResize`

- **Issue / Symptom**: Resize snapping flickered back to the unsnapped size when the pointer was released (React Flow), or did nothing at all (SvelteFlow `onResize`).
- **Root Cause**: `XYResizer` keeps its own raw `prevValues`; React Flow's end change (`type: 'dimensions'`, `resizing: false`) carries those raw values, undoing the last snap. SvelteFlow's `ResizeControl` calls `onResize` *before* writing the raw `x` / `y` / `width` / `height` to `store.nodes`, so anything written from `onResize` is overwritten. The changes also do not say which handle is dragged.
- **Solution / Workaround**: React: `snapResizeChanges` remembers the last snapped size and rewrites the `resizing: false` change. Svelte: `resizerHandlers(id)` defers `resize(id)` / `endResize()` with `queueMicrotask`, after the resizer has written the raw size. The handle is inferred from the edges that moved since `beginResize` (`inferResizeHandle`). While resizing, read `width` / `height` before `measured` (`getResizingNodeRect`): `measured` is stale until xyflow re-measures.

### [core/canvas] Corner Detection on Polylines Breaks on Noisy or Coarsely Flattened Input

- **Issue / Symptom**: Curve fitting a freehand stroke produced dozens of tiny segments; fitted boolean results of small ellipses stayed polylines.
- **Root Cause**: A turning-angle test between adjacent edges reads sample jitter as corners (alternating ±0.3 px noise on 2 px steps turns ~33° per vertex), and a coarsely flattened small circle (radius ≲ 5 at tolerance 0.25) really does turn more than 30° per vertex.
- **Solution / Workaround**: `fitCubics` measures each vertex's turn to the nearest neighbours at least 4 × `tolerance` away and keeps only the sharpest vertex in that neighbourhood. For very coarse polygons raise `cornerAngleDeg`, or flatten with a smaller `tolerance`. `fitPathData` falls back to the original polyline when fitting would not remove vertices.

### [core/commands] Shortcut Handlers Must Not `preventDefault` Disabled Commands, and Mod Differs Per Platform

- **Issue / Symptom**: A global shortcut listener that calls `preventDefault()` on every bound chord blocks the browser and focused editors even when the command can't run (e.g. `Mod+Z` with nothing to undo). Separately, `Mod+Y` (redo) and an app binding on `Ctrl+Y` look different in the keymap but collide on Windows and Linux, and the collision is invisible when tests only run on macOS.
- **Root Cause**: Whether a chord should be consumed depends on the command's enablement at that moment, not only on the binding. `Mod` is ⌘ on macOS and Ctrl elsewhere, so whether two chords collide depends on the platform.
- **Solution / Workaround**: `CommandRegistry.handleKeyDown` resolves the command, checks `isEnabled`, and only then calls `preventDefault()` and runs it. `ShortcutMap.findConflicts(platform)` compares effective chords (with `Mod` resolved for that platform), and `commands.test.ts` asserts that the default keymaps have no conflicts on mac, windows and linux. Bindings that only make sense on some platforms use `platforms` (e.g. `Mod+Y` redo off macOS). Keys match by `event.code` (see "Option/Alt Shortcuts Must Match `KeyboardEvent.code`"). The one exception is `shortcutCode`: a letter key that produces a different Latin letter without Alt uses that letter, so `Mod+Z` follows the Z label on AZERTY, QWERTZ and Dvorak, as browsers do. Matching both the code and the key would fire `Mod+Z` from two different physical keys.

### [core/commands] Agent `listChanged` Only Fires When Tool Definitions Change

- **Issue / Symptom**: Registering or removing commands did not send `tools/list_changed` to agents using the command tool provider.
- **Root Cause**: `ToolRegistry` compares a JSON signature of `listTools()` (see "Tool-List Notifications Must Be Coalesced and Compared"). The three command tools (`list_commands`, `run_command`, `run_commands`) never changed, so their signature never changed either.
- **Solution / Workaround**: `run_command`'s `id` schema carries an `enum` of the visible command ids. The tool definition now changes when commands are added or removed, but not when they run or their enablement changes. `run_commands` keeps a free `id` string so that each step can report `unknown_command` on its own instead of the whole batch being rejected.

### [svelte/packaging] `Foo.svelte` and `foo.svelte.ts` Collide in `dist` on Case-Insensitive File Systems

- **Issue / Symptom**: `svelte-check` warned `Cannot write file '.../dist/commands/CommandPalette.svelte.js' because it would be overwritten by multiple input files` after adding `CommandPalette.svelte` next to a rune file `commandPalette.svelte.ts`.
- **Root Cause**: Both compile to `…alette.svelte.js` / `.d.ts`. On macOS and Windows file systems, which are case-insensitive, these are the same path, so one output silently replaces the other.
- **Solution / Workaround**: Give rune modules names that differ from component names by more than case (`palette.svelte.ts` next to `CommandPalette.svelte`).

### [monorepo/licensing] Ported Code Needs Its Notice in the Published Package, Not Just in Source

- **Issue / Symptom**: Files ported from the MIT/Apache ArtCraft apps carry a header comment and a root `THIRD_PARTY_NOTICES.md`, but neither reached npm: tsup strips comments from `dist`, and `@pixerate/editor` publishes only `dist`.
- **Root Cause**: MIT requires the copyright and permission notice in every copy, including the published package. A root-level file is outside the package's `files`.
- **Solution / Workaround**: `packages/core/THIRD_PARTY_NOTICES.md` is a copy listed in `files`. `tests/third-party-notices.test.ts` fails if it drifts from the root file. When porting more code, add a section to the root file and copy it into the package (and into `packages/react` / `packages/svelte` too if ported code lands there).

### [core/persistence] Autosave Must Not Overwrite the Previous Session's Snapshot Before the User Decides

- **Issue / Symptom**: After a crash, reopening the app showed the "Restore unsaved changes?" prompt, but the snapshot it offered was already replaced by the freshly loaded (unchanged) document, or by a clean meta written when the new session "saved".
- **Root Cause**: Autosave started as soon as the editor mounted: loading the document counted as a change, and a save in the new session retired whatever snapshot was in storage, including one this session never wrote.
- **Solution / Workaround**: `createAutosaveController` writes nothing until `ready()` (the hydration gate); `useAutosave` / `createAutosave` call it only after the recovery check found nothing or the user chose Restore / Discard. `markClean()` only writes a clean meta for a snapshot this session wrote (`createRecoveryPolicy().ownsSnapshot`), so a clean start never consumes an earlier session's snapshot. The snapshot is written before its dirty meta, so the meta never points at a missing snapshot.

### [core/persistence] Revision Listeners Can Run Before the Dirty Binding Updates

- **Issue / Symptom**: With `bindDirtyToHistory` and an autosave both subscribed to the same `HistoryManager`, undoing back to the saved state still wrote a snapshot (or a save was not noticed) depending on subscription order.
- **Root Cause**: `HistoryManager` notifies listeners in subscription order. If the autosave's listener runs first, the binding's `dirty` flag is still stale when it is read.
- **Solution / Workaround**: `createRevisionTracker` reads the dirty flag lazily in `savedRevision()`, and `AutosaveController.notify()` never ticks synchronously (it schedules a timer), so every history listener has run before the policy looks at the revisions. A stale clean read heals itself: when the binding then flips to dirty, the tracker bumps the revision.

### [core/persistence] An `EditorDocument` Must Count Document Changes, Not Controller Notifications

- **Issue / Symptom**: Autosave wrote a snapshot every time the user clicked a node, and an agent comparing `revision` from two `get_<kind>_document` calls saw a change when nothing in the document had changed.
- **Root Cause**: Controllers notify their `subscribe` listeners on every state change, including selection, hover, issues and read-only flips. Passing `controller.subscribe` straight to `defineEditorDocument` counted all of them as document revisions.
- **Solution / Workaround**: An editor's `subscribe` in `defineEditorDocument({ subscribe })` must call the listener only when the saved document changed. `createDiagramEditorDocument` keeps the last `source` and skips notifications where it is unchanged. Do the same in every adapter (compare the snapshot's identity or a cheap key, not a deep copy).

### [core/persistence] Chart and Parameter Loads Repair Bad Input, So Agent Loads Need a Strict Path

- **Issue / Symptom**: `load_chart_document` with `"series": 3` reported success and quietly replaced the chart with an empty bar chart; a parameters load with an unknown field id did the same with defaults.
- **Root Cause**: `ChartController.load` and `ParametersController.load` are built for opening files: they fix problems with defaults, report them in state and record no undo step. That is right for a recovered file and wrong for an agent, which needs to be told and to undo.
- **Solution / Workaround**: The adapters split on `history`. `"record"` (agent loads) goes through `ChartController.replace` / `ParametersController.replace`, which refuse any problem and are one undo step. `"reset"` (opening a file or a recovery) keeps the lenient `load` and returns the repaired parts as `problems`, which `defineEditorDocument` puts in the `LoadReport`. Do the same for any editor whose `load` repairs input.

### [core/rich-text] Opening a Rich Text Document Must Rebuild the Editor State to Drop Undo History

- **Issue / Symptom**: After restoring a recovered document (or opening a saved one), pressing Undo brought back the document that was there before the restore.
- **Root Cause**: `editor.commands.setContent` is an ordinary transaction, so the history plugin records it. TipTap 2 has no command that clears the undo history.
- **Solution / Workaround**: `createRichTextEditorDocument` applies `setContent(doc, true)` (so `update` listeners and the UI hear about it), then, for `history: "reset"`, swaps in `EditorState.create({ doc: editor.state.doc, plugins: editor.state.plugins })` with `editor.view.updateState`. Every plugin's state starts fresh from the new document, which is what opening a file means. Agent loads (`history: "record"`) skip the swap, so they stay one undo step.

### [core/canvas] React Flow Drags Bypass History, and the Drop Lands After `onNodeDragStop`

- **Issue / Symptom**: Dragging a node on the canvas could not be undone, and a canvas `EditorDocument` built only on the `HistoryManager` never noticed the move, so autosave wrote nothing.
- **Root Cause**: React Flow (and Svelte Flow) apply drag positions through `onNodesChange` straight into host state; nothing records a history step. When the drop's final position arrives, React has not re-rendered yet inside `onNodeDragStop`, so state read there is one frame stale.
- **Solution / Workaround**: `createCanvasGestureRecorder({ getNodes, setNodes, getEdges, setEdges, history })`: call `begin()` in `onNodeDragStart` and `end("Move")` a frame after `onNodeDragStop` (`requestAnimationFrame`), reading nodes through a ref. It records one undo step only when something other than selection or measurement changed. For change events without history, `useCanvasEditorDocument` / `createCanvasDocument` compare the nodes and edges without runtime fields, and skip frames where a node is still `dragging`.

### [core/persistence] Image and Paint Documents Keep Pixels as Assets; Storage Must Carry Them

- **Issue / Symptom**: An image or paint document is tens to hundreds of MB of PNG data URLs, too big for an agent tool result or a whole-document autosave. The existing external asset stores are async, but `EditorDocument` loads synchronously.
- **Root Cause**: `toJSON()` inlines every layer, mask, thick-paint channel, mixing pad and guide as a data URL (or base64), and making `loadDocument` async would have changed the API of every editor.
- **Solution / Workaround**: `defineEditorDocument({ assets })` runs `getDocument()` output through `externalizeAssets`, which replaces each inline image with a content-addressed `pixerate-asset:<len>-<hash>` reference held in a synchronous `EditorAssetRegistry`, and `loadDocument` swaps them back. The async part happens around storage: `withEditorAssets(storage, registry)` writes referenced assets before the document on `set`, and reads them into the registry on `get`. `createEditorAutosave`, `useEditorAutosave` / `createEditorAutosave` (Svelte) and `createEditorDocumentStore` do this whenever `doc.assets` is set. A document whose references are not loaded is refused, naming the missing assets. Assets are kept under one shared `pixerate.assets:` pool; see the next entry for how unreferenced ones are deleted.

### [core/persistence] Garbage-Collecting Shared Assets: List Keys, Read Every Value, and Never Race a Write

- **Issue / Symptom**: Every edit that changes a layer, mask, thick-paint channel, mixing pad or guide writes a new content-addressed asset, and nothing deleted them, so IndexedDB / OPFS quotas filled up with assets only an old autosave snapshot or a removed document had used. Deleting them naively has three traps: (1) `StorageAdapter` could not list keys; (2) `persistEditorAssets` caches "already written" keys per storage for the session, so after a deletion the next save skipped the asset and wrote a document pointing at nothing; (3) a save in flight writes its assets before its document, so for a moment an asset exists that no stored value refers to yet.
- **Root Cause**: Assets are shared by every document and snapshot (content addressing), the stores have no reference counts, and the asset writes and the document write are separate storage operations.
- **Solution / Workaround**: `collectEditorAssetGarbage(storage, { keep, dryRun, only })` lists keys with the new optional `StorageAdapter.keys(prefix)` (all built-in adapters; we chose listing over an index written on save because an index can drift after a crash, a lost update between tabs, or assets written before it existed, and then leaks forever, while listing reads the truth). It reads every non-asset value in the storage (documents, index, snapshots, anything else) and keeps every `pixerate-asset:` reference it finds, plus `keep` (registries, `EditorDocument`s with `assets`, refs, documents). Only well-formed asset keys are ever deleted. Before deleting, it writes a new `pixerate.assets:#collected` marker; `persistEditorAssets` reads the marker and drops its cache when it changed, so every session and tab writes deleted assets again. Writes through `withEditorAssets` and `createEditorDocumentStore` lease their references until the document is written, and a collection skips leased references (including ones leased while it runs). Where the Web Locks API exists (browsers, Node 22+), writes hold a shared lock and collection an exclusive one, so writes in other tabs are waited for too. Collection runs (best effort) after `store.remove`, and after `markClean` / `discard` in `createEditorAutosave`, React `useEditorAutosave` and Svelte `createEditorAutosave` (option `collectAssetGarbage`, default on). Those keep the assets the open document uses now, not its whole registry: `checkRecovery` reads the old snapshot's assets into the registry, so keeping the registry would keep exactly what `discard` throws away. Assets only the registry still holds (undo history) are safe to delete because the changed marker makes the next save write them again. Hosts that call `persistEditorAssets` themselves and then write the document are not protected between the two calls: use `withEditorAssets(...).set` instead. Pass the raw storage, not a `withEditorAssets` wrapper (a wrapper works but reads every asset into its registry). Node 22+ has `navigator.locks`, so a test that blocks a write and then awaits a collection deadlocks: release the write first, or stub `navigator`.

### [core/image-editor] Loading the Source Image Is Not a Document Change

- **Issue / Symptom**: Opening the Image tab marked the document as changed, so every reload offered to "restore unsaved changes" nobody made.
- **Root Cause**: `loadImage` replaces the source image, and an early `documentRevision` counted it like an edit. The source is the host's (`sourceUrl`) and is not saved in the document.
- **Solution / Workaround**: `documentRevision` counts history steps, undo, redo and stroke frames (`notify(strokeRects)`), not `loadImage` or view changes. Any change that is not saved in `toJSON()` must not bump a document revision.

### [react/persistence] Destroying an `EditorDocument` in an Effect Cleanup Breaks StrictMode

- **Issue / Symptom**: Under `<React.StrictMode>`, `useMermaidDiagram().editorDocument` stopped counting changes after mount, so autosave never wrote a snapshot.
- **Root Cause**: StrictMode runs every effect's cleanup once and then runs the effect again, but keeps `useMemo` values. A cleanup that disconnects the document from its controller leaves the memoised document disconnected for good.
- **Solution / Workaround**: `EditorDocument.destroy()` only disconnects; the next `subscribe()` or `revision()` reconnects, and the reconnect counts as one revision, because changes in the gap were not seen. Bindings call `destroy()` in their cleanup and need nothing else.

### [core/persistence] OPFS Writes: `createWritable` and `move` Are Not Everywhere

- **Issue / Symptom**: An OPFS adapter that works in Chromium rejects every write in some Safari versions, or a crash mid-write leaves a truncated file.
- **Root Cause**: `FileSystemFileHandle.createWritable()` is missing on Safari's main thread in older versions (only `createSyncAccessHandle` in workers), and `FileSystemHandle.move()` (rename) is not universally available. Writing a file in place is not atomic.
- **Solution / Workaround**: `createOpfsAdapter` writes `<file>.tmp` and renames it over `<file>` where `move` exists, and otherwise alternates two slots (`.a` / `.b`) and swaps a `.ptr` file only after the slot is complete. Without `createWritable`, `set` rejects with `StorageUnavailableError`; feature-detect with `isOpfsAvailable()` and fall back to `createIndexedDbAdapter` or `createLocalStorageAdapter`. Only localStorage writes are synchronous, so on `pagehide` it is the only backend guaranteed to finish; `flushNow()` still starts the async write for the others.

### [core/generation] Prompt Limits Count Resolved Text, So the Planner Cannot Truncate Them

- **Issue / Symptom**: A 40-character prompt such as `{{style}} portrait` passed a model's 1000-character limit in the UI, but the provider rejected it: the template expanded to 1,400 characters. Truncating `request.prompt` to fix it cut the raw template text, which did not shorten the resolved prompt and could break a `{{tag}}` in half.
- **Root Cause**: Models limit what they receive (the resolved prompt), but the request carries the raw template. The length that counts and the text you can edit are different strings.
- **Solution / Workaround**: `prompt.countResolved` defaults to `true`. Pass the resolved text as `planGenerationRequest(…, { resolvedPrompt })`. When the resolved text is over the limit, the planner reports an error under every strategy and leaves the prompt alone. It only truncates when it measured the same string it would edit. `capabilitiesToJsonSchema` puts `maxLength` on `prompt` only when `countResolved: false`; otherwise the limit appears only in the description, so schema validation of a raw template does not give false passes or failures.

### [core/generation] Retried `generate` Calls Need Idempotency Keys That Compare Arguments and Forget Failures

- **Issue / Symptom**: An agent that timed out waiting for `generate` retried and was billed for two generations. A naive "seen this key" cache then made things worse: a call that failed upstream could never be retried, and reusing a key with a different prompt silently returned the old result.
- **Root Cause**: MCP clients retry on transport errors without knowing whether the first call ran. A key on its own does not say whether the retry is the same request.
- **Solution / Workaround**: `createGenerationToolProvider` stores `key → { signature, promise }`. The signature is a stable (sorted-key) JSON of the other arguments. A retry with the same key and arguments while the call is still running joins the same promise; once it has finished, the retry returns the cached result marked `deduplicated: true`. The same key with different arguments is an error. A rejected call removes its key so it can be retried. Keys are evicted oldest-first past `maxIdempotencyKeys`. The tool keeps `destructiveHint: true` together with `idempotentHint: true`, because repeating it with the same arguments has no further effect.

### [core/generation] Nearest-Option Snapping Hits Exact Ties on Log Scales

- **Issue / Symptom**: Snapping `720p` to `["480p", "1080p"]` or `1:1` to `["9:16", "16:9"]` returned whichever option came first, which changed when the server reordered its options.
- **Root Cause**: Resolutions and aspect ratios are compared on a log scale (pixel count, width/height). Common presets form geometric series, so 720p lies exactly between 480p and 1080p (both ratios are 1.5), and 1:1 lies exactly between 9:16 and 16:9.
- **Solution / Workaround**: `snapToOption` compares distances with an epsilon and breaks ties by rank, never by option order: `downgrade` picks the lower option, while `upgrade` and `nearest` pick the higher one. Integer and step rounding use the same rule (`count: 3` against `[2, 4]`). Tests for snapping should include an exact tie.

### [core/generation] Batch Resolvers Must Resolve Each Batch's Own Promises When the Cache Is Cleared Mid-Flight

- **Issue / Symptom**: After `resolver.clear()` was called while a batch was still fetching, the `load()` promises waiting on that batch never settled.
- **Root Cause**: The batch looked up waiters in the shared in-flight map when the fetch returned, but `clear()` had already emptied that map.
- **Solution / Workaround**: `createBatchResolver` captures each batch's pending entries when the fetch starts and always resolves them. It only writes the result to the cache if the in-flight entry is still the same object, so values from before a `clear()` do not come back. A failed batch resolves its keys to `undefined` and records them as failed (`failed(key)`), so a bad response does not cause a retry storm. `clear(key)` allows a retry.

### [core/grammar] New Syntax Inside `{?…}` Collides With Names That Were Already Valid

- **Issue / Symptom**: Adding comparison conditions as `{?amount>100}…{/amount>100}` (or any new syntax inside `{?…}`) would have silently changed prompts that already used `=`, `<` or `>` in a section name, and `JSX` attribute strings like `defaultSource="a\nb"` in tests kept a literal backslash-n instead of a newline.
- **Root Cause**: A section name was "anything but `|` and `\`", so every candidate syntax inside the braces (`{?a>1}`, `{?=a>1}`, even `{?a|>1}`, which is a variable) already meant something. JSX attribute strings are not JavaScript string literals and do not process escapes.
- **Solution / Workaround**: The comparison is recognised only when the open tag is closed by its bare subject (`{?amount>100}…{/amount}`), a pairing the old grammar always reported as unbalanced; `{?a>1}…{/a>1}` keeps its old meaning. `matchConditionalTags` searches for an exact name or a comparison subject, which picks the same partner as before for every diagnostic-free prompt. `grammar.test.ts` proves this by swapping `= < >` for neutral symbols and comparing old and new results on random prompts. Record-level directives (`{!next}`) were rejected for the same reason: `{!next}` is already an "unless" section. In JSX tests, pass multi-line strings as `{"a\nb"}`.

### [core/canvas] Auto Layout Must See Flow Changes Before They Are Applied, and Must Not Ping-Pong With Measuring

- **Issue / Symptom**: Deleting a child of an auto layout frame left the frame at its old (hugging) size, and relayout after every measured `dimensions` change could keep re-writing node sizes.
- **Root Cause**: A React Flow `remove` change only carries the id; once `applyNodeChanges` has run, the node and its `parentId` are gone, so the frame to relayout is unknown. SvelteFlow calls `ondelete` after removing the nodes. Writing `width` / `height` makes xyflow re-measure the node, which emits another `dimensions` change.
- **Solution / Workaround**: Pass each `onNodesChange` batch through `autoLayout.noteChanges(changes)` *before* applying it (it records the parents of removed nodes) and flush after the nodes update (`useCanvasAutoLayout` flushes in a layout effect, the Svelte rune on a microtask; Svelte's `nodesDeleted(nodes)` reads `parentId` from the deleted node objects). Layout passes only return updates that differ by more than 1e-6 and `flush` writes nothing when there are none, so a re-measure with the same size ends the loop.

### [core/canvas] Child Order in Auto Layout Frames Is the Node Array, Which Must Keep Parents First

- **Issue / Symptom**: Moving a flow child to a new slot by splicing the node array made xyflow warn about (or misplace) the moved node's own children.
- **Root Cause**: xyflow requires every parent to come before its children in the array. Moving a node later than its descendants breaks that, and moving it earlier than its parent too.
- **Solution / Workaround**: `moveLayoutChild` puts the siblings back into the array slots they already occupied (in the new order) and then runs a stable parents-first pass. Use it (or `autoLayout.moveChild`) instead of splicing; `zIndex` stays independent of layout order.

### [react/svelte] Spreading a Controller Object Snapshots Its Getters

- **Issue / Symptom**: `useCanvasAutoLayout(...).hasPending` (and `guides` before it was re-declared) never changed after the first render.
- **Root Cause**: `{ ...controller }` copies the *value* a getter returns at spread time, not the getter.
- **Solution / Workaround**: Re-declare live properties as getters (or state) on the object the hook / rune returns after the spread, as `useCanvasAutoLayout` and `createCanvasAutoLayout` do for `hasPending` and `guides`.

### [core/spreadsheet] Number Formats Must Round the 15-Digit Decimal String, Not the Binary Value

- **Issue / Symptom**: `(2.675).toFixed(2)` is `"2.67"` and `(1.005).toFixed(2)` is `"1.00"`, but Excel shows `2.68` and `1.01` with `0.00`. Porting Rust's `format!("{:.*e}")` to `toExponential` also differs on exact ties (Rust rounds half to even, JS picks the larger digit), and `toExponential` stops at 100 digits, too few for the exact expansion of a double (up to 767 digits).
- **Root Cause**: Excel first writes a number with 15 significant digits, then rounds that decimal string half away from zero. An exact tie at the 16th digit (`1234567890123455`) goes toward zero.
- **Solution / Workaround**: Always format through `numfmt/decimal.ts` (`decimalDigits` → `fixedFromDigits`), never `toFixed`. It takes 16 digits from `toExponential(15)`; only when the 16th digit is a 5 does it check for an exact tie, using the exact decimal expansion computed with `BigInt` from the double's bits. The tie rules are covered by `tests/number-format.test.ts`.

### [core/spreadsheet] Number Formats See Dates as ISO Text, and the 1900 Leap Day

- **Issue / Symptom**: A date cell (`"2026-03-04"`) formatted with `0.00` or `dddd` must behave like Excel's serial 46085; `dateToSerial` gives serials one too low before 1900-03-01, and serial 60 (the fictitious 1900-02-29) has no ISO text.
- **Root Cause**: Our engine stores dates as ISO text and times as day fractions, while format codes work on 1900-system serial numbers.
- **Solution / Workaround**: `dateValueToSerial` (used by `NumberFormat.format`, `formatCellForDisplay` and `TEXT()`) converts ISO text with `serialFromYmd`, which counts the fictitious leap day; `renderDate` maps serial 60 to 2/29/1900 and serial 0 to 1/0/1900, as Excel does. Only ISO text is converted in cell display: other numeric-looking text stays text (Excel shows text through the `@` section). Only the 1900 date system is supported.

### [svelte/spreadsheet] Mutating a Cell Object in Place Does Not Re-Render It

- **Issue / Symptom**: Setting `cell.numberFormat` on the stored cell object and calling `notifyChange()` updated the controller, but the Svelte grid kept showing the old text (React happened to re-render).
- **Root Cause**: The Svelte grid reads cells through `{@const cell = sheetState.getCell(...)}`; Svelte deriveds compare with `===`, so the same object means nothing downstream re-runs.
- **Solution / Workaround**: Controller operations replace cell objects (`cells[colId] = { ...cell, numberFormat }`) instead of mutating them. Do the same for spilled display cells (`spillCells.set(id, {...})`).

### [core/spreadsheet] A Format-Only Blank Cell Over a Bound or Column-Formula Value

- **Issue / Symptom**: `setCellNumberFormat` on a bound record cell or a column-formula cell has nowhere to put the format: those cells are derived, and a stored blank cell normally hides the derived value (it means "cleared").
- **Root Cause**: `getCell` returns a stored cell with empty `raw` before looking at derived values.
- **Solution / Workaround**: A stored blank cell with `explicitNumberFormat` is treated as format-only: `getCell` returns the derived value with that format (`{ ...derived, numberFormat }`). Known limitation: a cleared column-formula cell that also has an explicit format therefore shows the column value again.

### [core/find-replace] JavaScript `RegExp` Backtracks, So Word Wildcards Cannot Be Translated to a `RegExp`

- **Issue / Symptom**: Translating Word's wildcard patterns to a `RegExp` (as WordCraft does for Rust's linear-time `regex` crate) freezes the tab on patterns such as `(a@)@b` (`(a+)+b`) or `*a*a*b` (`.*?a.*?a.*?b`) against a long paragraph without a match: exponential or high-polynomial backtracking inside a single `exec`, which cannot be interrupted.
- **Root Cause**: V8's irregexp is a backtracking engine. Rejecting nested quantifiers is not enough: several adjacent lazy `*` runs are polynomial (O(n^k)), and a time check between `exec` calls never runs while one call is stuck.
- **Solution / Workaround**: Special-character and wildcard patterns compile to a small program run by a Pike VM (`packages/core/src/extensions/find-replace/pattern.ts`), which is O(text × program) for any pattern; counted repeats are expanded and the program is capped at 20 000 instructions (`too_complex`), the Find text at 1 024 characters (`too_long`), and every search has a shared budget (VM steps, wall-clock `timeLimitMs`, `maxMatches`) reported as `truncated`. Only the raw `regex` option uses `RegExp`: it rejects a repeated group containing a repeat (`(a+)+`, `(\w*)*`) and checks the deadline before each `exec`, but cannot stop a single runaway call; leave regex mode out of your UI if users can search very large documents. Also: in a VM thread loop, when no thread is alive at a position (an assertion like `<` failed), advance and bump the list generation instead of stopping, or later matches are missed.

### [core/find-replace] Search Text Must Skip Tracked Deletions but Keep Their Neighbours as Context

- **Issue / Symptom**: With Track Changes on, Replace found its own struck-through text again and never advanced; `catfish` was found across a deleted space; or `fish` (whole word) was found right after a deleted space although the live text reads `catfish`.
- **Root Cause**: Tracked deletions stay in the document with a `deletion` mark, and replacing while tracking re-inserts the found text as a deletion. Simply concatenating all text nodes searches deleted text; searching each live run separately loses the neighbouring live characters that word-boundary assertions need.
- **Solution / Workaround**: Build one search string per textblock from the non-deleted runs (with a per-character map back to document positions), record a "cut" wherever deleted text was skipped, and search each cut segment with the whole string as context (the Pike VM checks assertions against the full string; the regex path searches a prefix with `lastIndex`). Paragraphs are only joined (with `\r`) when the pattern can match `^p`. Replacements go through ordinary `replaceWith`, so the `TrackChanges` `appendTransaction` turns them into tracked deletions and insertions in the same undo step.

### [core/serializers] Lazy and `[^>]*` Regexes Are Quadratic (or Cubic) on Malformed HTML

- **Issue / Symptom**: `extractMentions` took 227 s on 4,000 repetitions of `<span data-type='mention' ` (no `>`), and `htmlToPlainText` grew 4× per doubling of such input. A "linear time" test only passed because its input was small enough to stay under an absolute 1 s budget, and it flaked once the suite grew.
- **Root Cause**: `/<span\b[^>]*\b(?:a|b)[^>]*>/` backtracks over every split of the two `[^>]*` runs (cubic) when no `>` follows; `/<[^>]+>/g`, `/<pre[\s\S]*?<\/pre>/g`, ```` /```[\s\S]*?```/g ```` and `/\]\([^)]*\)/g` rescan to the end of the input from every opener that has no closer (quadratic).
- **Solution / Workaround**: Use the scanners in `packages/core/src/serializers/html-scan.ts` (`findTagSpans`, `replaceTagSpans`, `stripTags`, `replaceDelimited`). They find each closer once, reuse it until the scan passes it, and stop when none is left. `tests/html-scan.test.ts` checks they match the old regexes on random input and that time grows linearly. When testing performance, assert growth between two sizes rather than an absolute time, which depends on machine load. `preprocessMarkdownMentions` had the same problem through `MARKDOWN_MENTION_SPLIT_REGEX` (219 s on 4,000 unclosed mention spans); it now splits with `splitMarkdownMentionParts`, a single forward scan with cached closers. The regex stays exported as the reference definition only, so don't use it on untrusted input.

### [core/canvas] Token-Bound Properties Are Materialised Into the Nodes, Not Resolved at Render Time

- **Issue / Symptom**: Resolving token bindings inside node renderers would leave auto layout, measuring, exports and copy / paste seeing stale literals (a bound `gap` would never move children), and a node whose variable was deleted would show nothing.
- **Root Cause**: Auto layout, arrange, clipboard and xyflow itself read ordinary node fields (`data.layout.gap`, `style`, `data.shape.fill`); only a renderer knew about the binding. Deleted variables no longer resolve, so a render-time lookup has no value to show.
- **Solution / Workaround**: `resolveCanvasTokens` writes each resolved value into the node field it drives and returns the same array when nothing changed, so it can run after every token or node change without looping (`useCanvasTokens` / `createCanvasTokens` do this). A binding that does not resolve keeps the last written value; on delete, detach with `detachTokenBindings(nodes, event.previous, event.deletedVariableIds)` using the state from *before* the delete. Canvas undo is separate from token undo: undoing a token delete brings the variable back but not the detached bindings.

### [core/tokens] Alias Cycles Must Be Checked Across Every Mode, and W3C Names Cannot Be Both Token and Group

- **Issue / Symptom**: `a → b` in Light and `b → a` in Dark looked acyclic per mode, but resolving `a` with a context of another collection (or after the default mode moved) looped; exporting `color` and `color/bg` produced invalid DTCG JSON (a token with children).
- **Root Cause**: Aliases are resolved with the target's own collection mode, so a chain can switch modes part-way; DTCG distinguishes tokens (`$value`) from groups, and names map onto paths.
- **Solution / Workaround**: `checkTokenAlias` searches alias edges of all modes (refusing any cycle), `resolveToken` still guards with a visited set and reports `cycle`. Variable names refuse `.`, `{`, `}` and a leading `$` per group, and a name that is a prefix group of another (`color` vs `color/bg`) is refused with `name-conflict`.

### [core/import] PDF Column Gutters: One Stray Line Hides a Table's Column Gap, and Tolerating It Lets the Gap Leak Into a Column

- **Issue / Symptom**: An unruled table under a paragraph lost its columns (the paragraph's short last line crossed every column gap), and after tolerating a few crossing lines the header cell `Unit` was read as a separate full-width line, splitting `Meter` off the table.
- **Root Cause**: Gutters were the strips no narrow fragment covers. A strict "no coverage" rule fails on any stray crossing line; a coverage depth tolerance (`≤ 8 %` of narrow fragments) also accepts strips where one fragment merely *ends* or *starts* inside, so the strip starts inside a column and that fragment "crosses" it.
- **Solution / Workaround**: `readingOrder` in `packages/core/src/import/pdf-layout.ts` sweeps coverage depth with the tolerance, then shrinks each strip to the last fragment end and first fragment start inside it, so only fragments spanning the whole strip count as strays, and keeps it only when the strays are fewer than the fragments on either side (otherwise the "gutter" is the ragged end of one long line next to a short one). Short lines crossing gutters right above or below a grid are pulled into it (spanning header / totals rows) and peeled back to the neighbouring paragraph by `alignedTable` when they don't start on a column edge.

### [core/import] pdf.js: Bold Is Only Known After the Operator List, `constructPath` Changed in v5, and Clip Paths Look Like Rules

- **Issue / Symptom**: Every text item looked regular-weight (item `fontName` is an id like `g_d0_f2`, `styles[...].fontFamily` is usually `sans-serif`); rule extraction found nothing on pdf.js 5; every clipped cell (`re W n`) became a table border.
- **Root Cause**: `page.commonObjs.get(fontName)` (with `name`, `bold`, `black`, `italic`) only resolves once fonts are loaded, which `getOperatorList()` does; `get` throws for unresolved ids. pdf.js ≤ 4 encodes `constructPath` as `[ops, args, minMax]` followed by a paint operator; pdf.js 5 as `[paintOp, [Float32Array path], minMax]` with its own path codes. Clipping paths end with `endPath`, not a paint operator.
- **Solution / Workaround**: The adapter calls `getOperatorList()` before `getTextContent()`, checks `commonObjs.has(id)` before `get` (inside `try`), and `pdfOperatorListToRules` handles both `constructPath` forms, keeps path pieces only until a stroke/fill operator paints them (dropping them on `endPath`), and keeps filled rectangles only when they are thin bars. Pass `rulingLines: false` to skip the operator list.

### [core/import] PDF Running-Header Detection Normalises Digits, So Synthetic Fixtures Must Vary Words

- **Issue / Symptom**: A three-page test fixture lost its first body line on every page as a "running header".
- **Root Cause**: Edge rows are compared with digits replaced by `#` so `Page 3 of 9` matches `Page 4 of 9`; generated prose like `p1w0 p1w1 …` / `p2w0 p2w1 …` then normalises to the same text on every page.
- **Solution / Workaround**: Build multi-page fixtures from different words per page (not just different numbers). Real body text practically never repeats at the same page edge across half the pages. Separately, use loop-based `minOf` / `maxOf` instead of `Math.min(...values)` on per-page arrays: spreading tens of thousands of fragments overflows the call stack.

### [core/track-changes] A Move Is a Cut and a Later Paste, So It Must Be Linked Across Transactions

- **Issue / Symptom**: Cutting a paragraph and pasting it elsewhere with tracking on produced an unrelated deletion and insertion (two changes to accept or reject separately), and accepting the deletion of a whole paragraph left an empty paragraph behind. Typing right after moved text joined the move.
- **Root Cause**: ProseMirror's cut is one transaction (`uiEvent: "cut"`) and the paste another (`uiEvent: "paste"`); nothing in the paste says where the text came from, and `transformPasted` strips review marks from the pasted slice. Only a drag (`uiEvent: "drop"`) deletes and inserts in one transaction. Block boundaries are not characters, so removing a paragraph's text leaves the block. `adjacentAttributes` reuses a neighbouring change's attributes, including `moveId`.
- **Solution / Workaround**: The tracker gives a tracked cut a change of its own and remembers it (id, normalized text, author) in the plugin closure; the next user transaction clears it unless it is a paste by the same author of the same text (white space ignored) whose deletion is still in the document. Then the deletion marks get `moveId` = the cut's change id and the pasted text an insertion with the same `moveId`. A drop links its own deletion and insertion when their texts match. Both are gated by `isMove` (default `isMoveSized`: a paragraph or a sentence of two or more words, as in Word). `adjacentAttributes` skips marks with a `moveId`. When a move is resolved, a removed end that fills a whole top-level textblock deletes the block (`deleteWholeBlock`); nested blocks (list items, quotes) keep their emptied paragraph. `getEditorText` resolves documents with moves through `resolveTrackedChanges` for the same reason; `htmlToPlainText` on HTML alone cannot remove the emptied block. Limitation: moving text that is itself the destination of an earlier move by the same author really deletes it (own insertion), leaving the earlier move with only its source.

### [core/paragraph-styles] Style CSS Loses to Inline Attributes, `onCreate` Is Deferred, and Enter Handlers Race

- **Issue / Symptom**: (1) A style's alignment from the injected stylesheet did not show on paragraphs with direct alignment, and with `TextAlign.configure({ defaultAlignment: "left" })` it never showed. (2) The `<style>` element added in `onCreate` was missing right after `new Editor(...)`. (3) Implementing next-style as an Enter keymap makes it depend on extension order: it either never runs (core keymap's `splitBlock` first) or pre-empts other Enter handlers (lists, suggestion popups). (4) Heading 5 applied in an editor configured with `levels: [1, 2, 3, 4]` rendered as `<h1>`.
- **Root Cause**: (1) TextAlign renders `style="text-align: …"` inline, which beats any stylesheet rule; with a non-null default every paragraph has it. (2) TipTap emits `create` in a `setTimeout`. (3) TipTap orders keymaps by priority and then reversed extension order. (4) Heading's `renderHTML` falls back to the first configured level.
- **Solution / Workaround**: (1) Applying a style resets `textAlign` to its default (`null`), so the stylesheet's alignment shows; when the default is not `null`, the style's alignment is written to the attribute instead. (2) CSS is injected in `onBeforeCreate` and removed in `onDestroy`. (3) Next-style runs in `appendTransaction`: when a single transaction turned an empty-selection caret at the end of a styled textblock into a new empty sibling block, the new block gets the style's `next` (merged into the same undo step). Splitting mid-paragraph keeps the style (`keepOnSplit: true`). (4) `isParagraphStyleAvailable` checks the heading extension's `levels`; `setParagraphStyle` refuses and the gallery hides unavailable styles. Style values are sanitized (`safeCSSValue`) and ids restricted to `[A-Za-z][A-Za-z0-9_-]*` because both end up in a stylesheet.

### [core/mentions] A Mention Role Attribute Named `role` Would Capture Existing Entity Fields

- **Issue / Symptom**: Adding a `role` node attribute to the Mention extension made `data-role="admin"` appear on user mentions. Apps pass their whole entity (with a job-title `role` field) as suggestion props, and TipTap keeps every prop that matches a declared attribute.
- **Root Cause**: TipTap's mention `command` inserts `{ type, attrs: props }`, so any attribute name you declare picks up a same-named field from existing entity objects. Before, undeclared attributes were dropped.
- **Solution / Workaround**: The node attribute is `assetRole` (rendered as `data-role`). `extractMentionsFromDoc` reports it as `role`. Text syntax (`@fox:style`) is opt-in (`{ roles }`), because `@john:hi` already meant "mention john, then `:hi`". Only `preprocessMarkdownMentions` and `extractMentions` with `roles` set, and `findTextMentions`, read it.

### [core/generation] `generation` Must Not Import the Mention Serializers, and Recreate Must Not Re-Plan Twice

- **Issue / Symptom**: Re-exporting `findTextMentions` from `@pixerate/editor/generation` broke the entry-isolation test, which pulled ProseMirror into the generation bundle. Separately, recreating a record by re-planning the original settings in `exact` mode changed values the user never saw change: a record planned when `4k` snapped to `2k` re-snapped to `4k` once the model gained `4k`.
- **Root Cause**: `serializers/mentions.ts` imports `escapeHtml` from `plain-text.ts`, which imports ProseMirror. An exact reproduction has to start from what was sent (the planned request), not from what the user asked for.
- **Solution / Workaround**: The text-only mention helpers live in the dependency-free `serializers/mention-text.ts`, and both entries re-export them. `exact` plans the recorded planned request (any change is `setting-unsupported`). `latest` plans the recorded original settings (differences are `setting-changed`). Mentions are kept in `record.mentions` so `latest` can rebuild them. Capability hashes leave out presentation fields and `timing`, so renaming a model is not drift.

### [svelte/packaging] `import type` in a `.svelte` File Still Counts as an Entry Dependency

- **Issue / Symptom**: The Svelte entry-isolation test failed for `generation/index.js` with `@pixerate/editor/grammar` after `GenerationHistory.svelte` gained `import type { Template } from '@pixerate/editor/grammar'`. The React build of the same import passed.
- **Root Cause**: `svelte-package` ships `.svelte` sources as they are, so type-only imports stay in the published file (tsup erases them from React's JS).
- **Solution / Workaround**: In Svelte components, take types only from the entry's own core subpath. Derive the rest when needed (`type Template = NonNullable<RecreateOptions['templates']>[number]`).

### [core/image-editor] Iterated Box Blurs Must Run on Padded Lines, or a Zero-Edge Feather Loses Mass

- **Issue / Symptom**: Feathering a selection with a large radius (the three-box-pass Gaussian used above σ 8) was up to 0.18 off a direct Gaussian next to the image border; the direct kernel below σ 8 matched to 1/255.
- **Root Cause**: "Zero beyond the image" means one convolution of the zero-padded signal. Running each box pass on the clipped line throws away the coverage the previous pass spread outside the image, so every pass loses more of it at the edges.
- **Solution / Workaround**: `gaussianBlur` (`selection/modify.ts`) runs the three passes on a line padded by the passes' total radius (zeros, or replicated ends for `clamp`) and only crops at the end. The remaining difference (≤ 0.03) is the box approximation itself; `tests/image-editor-selection.test.ts` checks both regimes against a direct Gaussian and that the cost does not grow with the radius.

### [core/image-editor] Selections Are Immutable Masks Shared by History; Layer Masks Are RLE Strings

- **Issue / Symptom**: Encoding the selection into every undo snapshot made each slider commit cost O(pixels); a `Uint8Array` inside an adjustment layer did not survive the `JSON.parse(JSON.stringify(...))` copies the controller makes of layers; adding a `selection: null` or `mask: undefined` key would have changed how every existing document serializes.
- **Root Cause**: History entries are built from `serializeState()` on every recorded change, layers are deep-copied as JSON everywhere, and saved documents are compared as JSON.
- **Solution / Workaround**:
  1. `SelectionMask` objects are never mutated; every operation returns a new one, and history entries keep a reference next to the serialized state (`HistoryEntry.selection`). Only `toJSON()` run-length encodes it, and only when something is selected.
  2. `AdjustmentLayer.mask` stores the RLE string (`{ width, height, rle, density?, feather?, enabled? }`); `decodeLayerMask` / `layerMaskCoverage` decode on render behind a small LRU keyed by the string. `normalizeAdjustmentLayer` only sets `mask` when it is usable and leaves default density / feather / enabled out.
  3. The renderer's base key includes a hash of the mask (`layerMaskKey`), and `buildLayerMaskPlanes` returns `undefined` for mask-free stacks so they take the old code path.
  4. Layer masks live in natural pixels like annotations: `projectMaskCoverage` unprojects each base pixel through the same `ImageProjection` as the image (crop, rotation, flips), so never draw a mask with hand-rolled transforms.

### [react/image-editor] `useImageEditor({ image })` Reloads Whenever `image` Is a New Object

- **Issue / Symptom**: A test host doing `useImageEditor({ image: fakeImage(20, 10) })` hung the render (the test timed out on the first `act`).
- **Root Cause**: The hook reloads the source when `options.image` changes identity; `loadImage` notifies, the host re-renders, builds a new image object, and the cycle repeats.
- **Solution / Workaround**: Pass a stable `image` (a string, or an element created once outside the render). Selection tools also need pixels: a new source clears the sampled pixels, so call `controller.setSamplePixels(...)` after loading when there is no canvas (tests, workers, cross-origin images).

### [core/spreadsheet] Multiple Sheets: `document` Is the Sheet Being Worked On, and Dependency Keys Must Name Their Sheet

- **Issue / Symptom**: With several sheets, `A1` in the dependency graph meant a different cell on every sheet, so editing `Data!A1` recalculated the wrong formulas (or none), and cross-sheet cycles went undetected. Rewriting the whole controller to take a sheet argument would have touched every method.
- **Root Cause**: The controller was written for one `document` (`getCell`, spills, `evalSingleCellByKey`, table operations all read `this.document`), and graph keys were bare A1 text.
- **Solution / Workaround**: Each sheet is a runtime (`doc` plus its spill maps and saved selection). `document` and the spill maps are getters on the *current* runtime, which is the active sheet except inside `withSheet(rt, fn)`: cross-sheet reads (`resolveCell(col, row, sheet)`), recalculation and imports into another sheet switch to that sheet's runtime and back (in `finally`). Graph keys are always `SHEETID!A1` (`qualify` / `unqualify`, upper-cased, so whole-column keys become `SHEETID!A:`); spill maps keep bare keys because they are per sheet. One workbook-wide graph keeps recalculation topological across sheets. Notify bindings with the *active* sheet (`this.active.doc`), not the current one. Use sheet ids, not names, for keys, name scopes and undo entries: names change.

### [core/spreadsheet] Sheet Prefixes in Formulas: `Sheet1` Looks Like a Cell, `!=` Is an Operator

- **Issue / Symptom**: Rewriting `Sheet1:Sheet3!A1` after a rename produced `'Sheet1:End'!A1`; `=A1!=B1` and `='text'!=1` stopped parsing once `X!` became a sheet prefix; a quoted-prefix look-ahead could rescan the rest of a formula full of apostrophes from every quote.
- **Root Cause**: The lexer's cell pattern (`[A-Za-z]+\d+`) has no column limit, so it calls `Sheet1` a cell reference; Excel only quotes names that are cells within its grid (columns up to `XFD`). `!=` is this engine's alias for `<>`. `'` also starts this engine's single-quoted strings.
- **Solution / Workaround**: `sheetNameNeedsQuotes` uses a bounded cell test (1–3 letters ≤ XFD, row ≤ 1048576) plus R1C1 and boolean look-alikes. The lexer treats `X!` as a prefix only when `!` is not followed by `=`, and looks for `'name'!` at most 64 characters ahead (31-character names with doubled quotes), falling back to a string; the workbook test checks the growth ratio. Tokens carry `sheet`, `sheetEnd`, `refStart` and `end`, so `mapFormulaReferences` rewrites only the reference text after the prefix and keeps the prefix unless the result is `#REF!`.

### [core/spreadsheet] LAMBDA Needs Environment Chains, Not a Scope Stack, and Names Must Not See the Caller's Variables

- **Issue / Symptom**: With LET's scope stack, a lambda created in one LET and called inside another saw the caller's variables (`LET(k,10,f,LAMBDA(x,x+k),LET(k,1000,f(1)))` gave 1001), a defined name `=Rate*2` could pick up a LET variable named `Rate`, and runaway recursion (`Loop = LAMBDA(n, Loop(n+1))`) overflowed the JavaScript stack.
- **Root Cause**: Closures capture the environment where they are created; a stack only knows where they are called. A defined name is evaluated where it is used, but its formula belongs to the name's scope.
- **Solution / Workaround**: Variables live in linked `FormulaEnvironment`s; `FormulaLambda` keeps its creation environment (and, for sheet-scoped names, the sheet unqualified references mean), and calls install `{ params, parent: lambda.env }`. Defined names evaluate with `env = null` and a name stack that reports self-reference as `#CYCLE!`. Calls deeper than `MAX_LAMBDA_DEPTH` return `#NUM!`, and a `RangeError` from a smaller stack is caught in `evaluateWithDiagnostics` and reported as `#NUM!` too, so every save/restore of evaluator state must be in `finally`. Omitted arguments bind `''` but are recorded per environment, so `ISOMITTED(x)` is FALSE for an explicitly passed blank cell. Dependencies through names are expanded when a formula is registered (the cells a name refers to become the formula's dependencies), and any name change runs `recalculateAll`, because a new sheet-scoped name can shadow a workbook one.

### [core/spreadsheet] Defined Names Lived Only in `getWorkbook()`, So Apps Saving `onDocumentChange` Lost Them

- **Issue / Symptom**: An app that saves only the document from `onDocumentChange` (the single-sheet API, `useSpreadsheetEditor`, `createReactiveSpreadsheet`) lost every defined name on reload, and formulas using them showed `#NAME?`. `new SpreadsheetController({ document })` had nowhere to read names from.
- **Root Cause**: Names were kept in the controller's workbook-wide `this.names`, and only `getWorkbook().names` saved them. A sheet document had no field for them.
- **Solution / Workaround**: `SpreadsheetDocument.names` holds the names a sheet uses: all workbook-scoped names plus its own sheet-scoped names. `this.names` stays the source of truth. `notifyChange` (and the constructor) rewrites every live sheet document's `names` with copies (`syncDocumentNames`), so the document passed to `onDocumentChange`, `controller.document` and the bindings' copies are always current, after undo and redo too. When names are loaded from a document, any `sheetId` means "this sheet", because the sheet's id can change on load. `loadDocument` replaces that sheet's names, and also the workbook names when it is the only sheet. With several sheets, it merges the workbook names instead (the document's names win). `addSheet({ document })` only adds names that are missing. When a workbook is loaded, `workbook.names` wins and names found only in `sheets[*].names` are added (first sheet wins), so a workbook rebuilt from saved documents works. To avoid duplicating names in every sheet, `getWorkbook()` and workbook undo snapshots leave out the per-sheet copies (`withoutNames`). If they kept them, an undo could bring back stale names. The constructor makes shallow copies of `options.workbook.sheets`, so `names` is never written into the caller's objects. Without these copies, reusing those objects later (for example in `loadWorkbook`) brought back names the caller had dropped.

### [core/spreadsheet] One Edit Can Change the Conditional Look of Cells It Does Not Touch

- **Issue / Symptom**: Re-evaluating conditional formats only at the edited cell left colour scales, data bars, top-N, above-average and duplicate highlights stale in the rest of the range, and missed formula rules (`=$A1>B$1`) and cells whose formulas depend on the edited cell.
- **Root Cause**: Scales, bars, icons, top/bottom, averages and duplicates are computed from statistics over the whole applies-to range; formula rules can read any cell; and a typed value changes every dependent formula's value.
- **Solution / Workaround**: The controller records every cell key its evaluation plan visits (the edited cell, its dependents and their spilled cells) and `ConditionalFormatEngine.update(rules, changed)` re-evaluates: the whole range of statistical rules whose range contains a changed cell (dropping their cached statistics), the whole range of rules that use formulas, and only the changed cells for local rules (cell value with constants, text, blanks, errors, dates). Any other document change (structural edits, sort, undo, rule edits) re-evaluates everything. A test compares incremental and full results.

### [core/spreadsheet] Custom Validation Formulas Must See the Value Being Entered

- **Issue / Symptom**: `=COUNTIF($A$1:$A$9,A1)=1` (no duplicates) accepted a duplicate, and `=A1>10` checked the cell's old value.
- **Root Cause**: Validation runs before the input is committed, so evaluating the rule formula against the sheet reads the cell's current value.
- **Solution / Workaround**: `DataValidationSheet.evaluateFormula(formula, row, col, entered)` receives the parsed input; the controller sets a temporary `valueOverride` that `resolveCellByCoord` and `resolveRangeByCoords` return for that cell, restored in `finally`. Rule formulas (validation and conditional formatting) are written for the top-left cell of the first range and offset with `offsetFormulaReferences` for other cells, so `$` parts stay put.

### [react|svelte/spreadsheet] The Validation Alert Steals Focus, Which Blurs (and Re-commits) the Cell Editor

- **Issue / Symptom**: After a rejected Enter, the dialog took focus, the cell input's `onBlur` called `commitEditing()` again and the alert re-opened in a loop; Enter also moved the cursor down although nothing was committed.
- **Root Cause**: The cell editor commits on blur, and the grid's Enter/Tab handler always called `moveCursor` after `commitEditing`.
- **Solution / Workaround**: While `controller.validationPrompt` is set, `commitEditing` / `commitCellInput` return `{ status: 'pending' }` without doing anything. Enter/Tab only move when the result is `committed`. The dialog backdrop calls `preventDefault()` on `mousedown` so clicks don't move focus, and after `resolveValidationPrompt` the editors refocus the cell input (retry) or the grid. Unchanged input is not validated, so blurring an untouched editor never alerts.

### [svelte/spreadsheet] `{@const}` Calling a Controller Method Does Not Re-run on Controller State

- **Issue / Symptom**: Turning on "Circle invalid data" drew no circles in Svelte (React re-renders everything and showed them).
- **Root Cause**: `{@const circled = sheetState.controller.isInvalidDataCircled(r, c)}` reads only non-reactive controller state, so Svelte never re-evaluates it when the document state changes.
- **Solution / Workaround**: Compute such values in a `$derived.by` that reads `sheetState.document` first (`void sheetState.document`), e.g. the set of circled cells, and look cells up in it. The conditional-format overlay is exposed the same way (`sheetState.conditionalFormatOverlay`).

### [core/canvas] Tangent Curves Look Like Ties (or Clusters of Hits) to a Curve Boolean Engine

- **Issue / Symptom**: Uniting two externally tangent circles, or a circle touching another from inside, traced a figure-eight ring or split curves into dozens of tiny pieces; repeated split passes kept finding "new" intersections next to the touch point.
- **Root Cause**: Near a tangency the two curves stay within `epsilon` of each other over an arc of length about `√(ε·R)`, far longer than `ε`. Subdivision reports a hit for every flat sub-curve pair along it, and the vertex where they meet sits anywhere in that stretch, so the tangent directions there differ by numerical noise (`√(ε/R)` radians) and ordering the edges around the vertex by tangent angle picks an arbitrary one.
- **Solution / Workaround**: In `packages/core/src/canvas/pathops/boolean.ts`, consecutive hits of one pair between which the curves never separate by more than a few `ε` are one contact (shared end points take part in the clustering, so hits next to an existing vertex are dropped). When tangent angles at a vertex tie within `1e-3` rad, edges are ordered by the chord to a point a short way along each curve, which separates them by curvature.

### [core/canvas] Stroking With a Width Larger Than the Curvature Radius Leaves Spurious Holes

- **Issue / Symptom**: Outline Stroke of a small circle with a thick stroke (or Offset Path growing a small curved shape) left a hole in the middle that the stroke really covers.
- **Root Cause**: The inner offset of a curve turns inside out where the offset distance exceeds its radius of curvature; its loops wind the other way, so the non-zero fill of the raw outline cancels to 0 there.
- **Solution / Workaround**: After normalising, drop a face (and its descendants) when a point deep inside it is closer to the source path than the offset distance: holes when growing or stroking, islands when insetting (`dropSpurious` in `packages/core/src/canvas/pathops/stroke.ts`). The deep point must be taken in the face (the ring minus its direct children); a ring's own interior can lie inside a legitimate hole, e.g. the middle of a stroked square.

### [core/canvas] Gauss–Legendre Areas Need Both Halves

- **Issue / Symptom**: Exact Bézier areas (lines and curves) came out twice too large next to the shoelace formula.
- **Root Cause**: The area is `½ ∫ (x y′ − y x′) dt`, and mapping Gauss–Legendre nodes from `[-1, 1]` onto `[0, 1]` contributes another `½`. A line's term `x0 y1 − x1 y0` is already the integral, so it needs only the first `½`.
- **Solution / Workaround**: `segmentAreaTerm` divides the 3-point Gauss–Legendre sum (exact for the degree-5 integrand of a cubic) by 4 and the line term by 2; tests compare `bezierPathSignedArea` of rectangles and quadratics with closed forms.

### [core/extensions] TipTap Command Typings Vanish From the Published Declarations

- **Issue / Symptom**: `editor.chain().focus().toggleBold().run()` (and `toggleHeading`, `toggleBulletList`, `toggleTaskList`, `setTextAlign`, …) failed to typecheck with "Property 'toggleBold' does not exist on type 'ChainedCommands'" in the demo, and in any app that uses `createRichTextPreset` without depending on the TipTap extension packages itself. The Vite build doesn't typecheck, so it went unnoticed.
- **Root Cause**: Each extension package adds its commands by augmenting `@tiptap/core`'s `Commands` interface in its own `.d.ts`. That augmentation only applies when the consumer's TypeScript program loads that file. Core imports the extensions as runtime values, which leave no trace in the emitted declarations, and tsup's declaration bundler drops `/// <reference types="…" />` directives, so nothing pulled the packages in.
- **Solution / Workaround**: `rich-text-preset.ts` exports `RichTextPresetCommandPackages`, a type naming `typeof import("@tiptap/…")` for every package whose commands the preset installs; the bundled `.d.ts`/`.d.cts` then import those packages (resolved from core's own dependencies). Add a package there when the preset gains an extension with commands. `apps/demo` now has a `typecheck` script, so `pnpm typecheck` (run in CI) catches regressions.

### [tests] Timing Tests Flake in the Release Run Unless They Use `measureGrowth`

- **Issue / Symptom**: Release runs failed (so nothing was published) on "grows linearly" tests whose code was fine, e.g. `pdf-layout` at 10.4× against a limit of 10, `html-scan` at 31×, `mention-roles` at 20×.
- **Root Cause**: Each test timed its own sizes once or best-of-three, often for well under a millisecond. On a loaded CI runner (or with many test files in parallel) a single GC pause or descheduling dominates such a sample, so a linear function can look quadratic.
- **Solution / Workaround**: Use `measureGrowth(small, large, { limit })` (or `growthRatio(unit, run)` for repeated strings) from `packages/core/tests/helpers/growth.ts`: it repeats each sample until it takes at least 10 ms, alternates small and large, keeps the best of several runs, and retries while the ratio is at or above the limit. `tests/growth-helper.test.ts` checks it still fails real quadratic work. Prefer 4× size steps (linear ≈ 4×, quadratic ≈ 16×) and keep absolute-time limits at least 20× above the measured local time.

### [core/canvas] Animated Nodes: Render the Evaluated Frame, but Send Edits Back Through `applyDisplayChanges`

- **Issue / Symptom**: Dragging an animated node in React Flow snapped it back on the next frame. Writing the evaluated values into the stored nodes baked one frame's values into the base, so scrubbing showed wrong values afterwards. Rotating a node through `style.transform` moved it to the flow origin.
- **Root Cause**: The canvas shows `applyAnimation(nodes, time)`, but xyflow reports changes against the nodes it renders. Applying those changes to the stored nodes either loses them (the animated value wins on the next frame) or stores evaluated values. xyflow positions nodes with `transform: translate(…)` on the same element as `node.style`, so a `transform` in the style replaces it.
- **Solution / Workaround**:
  - Render `display()` / `displayNodes` and pass edits through `applyDisplayChanges(applyNodeChanges(changes, displayNodes))`. It calls `recordAnimationChanges`, which keys animated properties at the playhead (all changed properties in record mode) and restores their stored values; other changes pass through.
  - The keying is one undo step that only restores `data.animation`, merged by tag while a drag continues.
  - Rotation and scale are written to the CSS individual transform properties `style.rotate` / `style.scale`, which compose with xyflow's `transform`.
  - Run `applyAnimation` after `resolveCanvasTokens`, never before.

### [core/canvas] Keyframe Caches Keyed by Array Identity Go Stale When the Array Is Edited in Place

- **Issue / Symptom**: After `keys[0] = { ...keys[0], easing: 'hold' }`, `evaluateTrack(keys, t)` kept interpolating linearly.
- **Root Cause**: `normalizeKeyframes` (sort, drop invalid, merge duplicate times) is cached in a `WeakMap` keyed by the keyframe array so every frame does not re-sort. An in-place edit keeps the same array.
- **Solution / Workaround**: The cache stores a shallow copy of the elements and is reused only while every element is still the same object (an O(n) identity check, no sort). Editing functions always write new arrays and keyframe objects. Treat keyframe objects as immutable: mutating `k.time` in place is still not detected.

### [core/canvas] Frame Times Are Not Exact, and Keying at the Playhead Must Not Snap

- **Issue / Symptom**: A keyframe recorded at 500 ms was stored as `500.00000000000006`, so it no longer matched refs at 500. Pressing "Add keyframe" with the playhead at 250 ms keyed 233.333 ms.
- **Root Cause**: `Math.round(t / (1000 / fps)) * (1000 / fps)` is not exact in binary floating point. Snapping every keyed time to a frame moves keys the user placed deliberately.
- **Solution / Workaround**: `snapTimeToFrame` rounds its result to a microsecond, and refs compare times with `ANIMATION_TIME_EPSILON`. Only keyframe drags snap to frames, when no other target is in range. Keys at the playhead use the playhead time unchanged.

### [core/canvas] CSS Cannot Reproduce OKLab Colour Tweens or Split `x` / `y` Timing

- **Issue / Symptom**: Exported CSS animations faded colours through a different (muddier) midpoint than the canvas. When `x` and `y` had different easings, one of them followed the wrong curve.
- **Root Cause**: CSS keyframes interpolate colours in sRGB and cannot choose a space. `translate` takes both axes, and a keyframe block has one `animation-timing-function` for every property in it.
- **Solution / Workaround**: Export one `@keyframes` per CSS property, so each track keeps its own per-segment easing. Use `rotate` / `scale` / `translate` instead of a combined `transform`. Colour segments between different colours, `x` / `y` pairs whose key times or easings differ, and motion paths are sampled at `sampleFps` with linear timing and reported as `exact: false`.

### [svelte/canvas] Timeline Rows Do Not Refresh After Undo When the Nodes Are Not `$state`

- **Issue / Symptom**: In tests (and apps that keep nodes in a plain variable or store), undoing a keyframe move left the Svelte timeline showing the moved diamonds.
- **Root Cause**: The rows are a `$derived` of `animation.timelineRows()`, which reads the nodes through `getNodes()`. Undo changes the nodes without changing the controller's state snapshot (time, selection and duration are equal), so nothing reactive was read.
- **Solution / Workaround**: `createCanvasAnimation` bumps a `revision` `$state` whenever it writes the nodes (edits, undo and redo all go through its `setNodes`). `<AnimationTimeline>` and `displayNodes` read `revision`. Changes made outside the rune need a `revision` prop bump or `refresh()`.

### [react/svelte] `ReturnType` of a Generic Hook Fixes the Default Type Parameter

- **Issue / Symptom**: The demo's `useCanvasAnimation<DemoNode>(…)` result could not be passed to `<AnimationTimeline animation>`: "Two different types with this name exist, but they are unrelated."
- **Root Cause**: `type CanvasAnimation = ReturnType<typeof useCanvasAnimation>` instantiates the hook with `TNode = CanvasNode`. Methods taking or returning `TNode[]` make the result invariant in `TNode`.
- **Solution / Workaround**: Make the alias generic (`CanvasAnimation<TNode> = ReturnType<typeof useCanvasAnimation<TNode>>`, likewise `SvelteCanvasAnimation<TNode>`), and have components accept `CanvasAnimation<any>`.

### [core/tables] prosemirror-tables `deleteRow` / `deleteColumn` Say They Can Run on the Whole Table

- **Issue / Symptom**: `editor.can().deleteRow()` returned `true` in a one-row table, so the toolbar enabled "Delete row", but running it did nothing (`runTableAction` returned `false`, the command registry reported a failure).
- **Root Cause**: prosemirror-tables only checks "the selection covers every row/column" inside its `if (dispatch)` branch, so a dry run (`can()`, no `dispatch`) never sees it. `mergeCells` / `splitCell` / `goToNextCell` do check without dispatching.
- **Solution / Workaround**: `getTableActionState` checks `selectedRect(state)` itself for `deleteRow` / `deleteColumn` and returns "These are all the rows: delete the table instead." Don't trust `can()` alone for prosemirror-tables commands; test enablement by running the action, not only by asking.

### [core/tables] Table Cells Accept `block+`, So Pastes and Imports Nested Tables Inside Cells

- **Issue / Symptom**: Pasting HTML or markdown that contained a table plus other blocks, pasting a table through the rich clipboard, or importing a DOCX / PDF / HTML file while the cursor was in a table cell put a `table` inside the `tableCell`, although `insertTable` refuses to nest.
- **Root Cause**: TipTap's cell content is `block+` and `table` is in the `block` group, so the schema allows nesting. prosemirror-tables' `handlePaste` only takes over for cell selections and for slices that are nothing but a table (`pastedCells`); everything else falls through to the default paste. `RichClipboard`'s `handlePaste` runs before the table plugins and called `replaceSelection` directly, and `insertImportedDocument` used `replaceRange` at the cursor. ProseMirror content expressions cannot say "any block except table", and narrowing the schema would make existing documents with nested tables fail to load or be restructured by the parser.
- **Solution / Workaround**: `packages/core/src/extensions/table/nesting.ts`. `handleTablePasteWithoutNesting` (the `Table` extension's `tableNesting` plugin and `RichClipboard`) hands cell selections and table-only slices to prosemirror-tables' `handlePaste` (fills cells from the cursor, growing the table), and inserts other slices that contain a table after the outermost table (`insertSliceAfterTable`). `insertImportedDocument` always inserts after the table (an import never overwrites cells). The plugin's `appendTransaction` moves any table a local edit puts into a cell to after its outermost table, checking only tables that start inside the ranges the transaction changed. It skips whole-document replacements (`setContent`), undo/redo, `y-sync$`, other plugins' appended transactions (Track Changes re-inserts a deleted nested table for review) and `ALLOW_NESTED_TABLES_META`, so existing nested tables are kept. Map changed ranges with `assoc` pointing inwards and drop empty ranges: otherwise a pure deletion's empty range grows over content a later transaction re-inserts at the same position.

### [core/track-changes] Deleted Table Rows and Columns Have No Inline Text to Mark, So They Are Whole-Block Changes

- **Issue / Symptom**: With tracking on, Delete Row put the row back with its text struck through, but accepting left an empty row; Delete Column really deleted the empty cells of the column and restored only the cells with text, leaving a ragged table that `fixTables` then padded in the wrong place. Inserted rows (empty paragraphs) were not tracked at all.
- **Root Cause**: The tracker only restores deleted slices that contain inline content and only marks inserted inline content; rows, cells and tables are structure, like paragraph boundaries (see "Whole Paragraphs Have No Inline Representation").
- **Solution / Workaround**: Closed slices made only of `tableRole` nodes (table, row, cell, header cell) are tracked as whole-block operations: a deletion is re-inserted unchanged and every textblock inside gets `blockChange: { operation: "delete" }`; inserted tables/rows/cells (found by walking the step's slice, skipping open edge nodes) get `operation: "insert"`, with any insertion marks inside removed. `removeBlocks` already removes containers whose textblocks are all removed, so accepting/rejecting removes whole rows, cells or the table. Rows the same author inserted are really deleted. Merging/splitting cells (span changes plus cell deletions in one step) cannot be represented and is refused while tracking; cell attribute changes (`setCellAttribute`, column widths) are `ReplaceAroundStep`s that leave the textblocks' wrapper types unchanged, so they stay untracked. Header toggles change the wrapper type and are tracked as ordinary block changes (rejecting restores the cell type via `restoreWrappers`).

### [core/markdown] tiptap-markdown's Table Serializer Does Not Escape `|`, and Its HTML Fallback Was Escaped by Our Sanitizer

- **Issue / Symptom**: A cell containing `A|B` exported as `| A|B | 3 |`, which reads back as three cells. Tables with spans were exported as HTML containing `<colgroup><col>`, which `markdownToTipTapHtml` turned into literal `&lt;colgroup&gt;` text. Header alignment was lost.
- **Root Cause**: tiptap-markdown 0.8 writes cells with `renderInline` and its text serializer escapes markdown characters but not the pipe; it always writes `---` delimiters. TipTap's `table` `renderHTML` emits a `<colgroup>`, and `colgroup` / `col` were missing from the embedded-HTML allowlist.
- **Solution / Workaround**: The `Table` extension provides `storage.markdown.serialize` (tiptap-markdown merges it over its default and keeps the default parser): cells are rendered in place mid-line and their output is rewritten with `|` → `\|` and newlines → spaces; delimiters come from the header cells' `align`. Non-GFM tables are written as HTML (a block that parses back). `colgroup`, `col` and `colwidth` are in the sanitizer allowlist; `style` is still dropped.

### [react|svelte/tables] Toolbar Tests: `focus()` Needs `requestAnimationFrame`, and the Bubble Menu Element Is Detached

- **Issue / Symptom**: Table commands run through the command registry failed in jsdom with "requestAnimationFrame is not defined"; `document.querySelector` could not find a `TableBubbleMenu`'s toolbar; a table store test started "inside a table" before any selection was made.
- **Root Cause**: `chain().focus()` schedules with `requestAnimationFrame`, which plain JSDOM setups don't define. TipTap's `BubbleMenuView` removes its element from the DOM until tippy shows it, so a React portal or Svelte child rendered into it is not in the document. A document that starts with a table puts the initial selection in its first cell.
- **Solution / Workaround**: Polyfill `requestAnimationFrame` in tests that focus. Find bubble menu content through `editor.view.pluginViews` (`view.element`). Move the selection out of the table before asserting the "outside" state.

### [core/export] DOCX Round Trips: `<ins>` Was Not in the Sanitizer Allowlist, the Hyperlink Style Underlines, and Word Has No Change or Thread Ids

- **Issue / Symptom**: Tracked insertions imported from Word vanished as marks (only their text stayed); exported links came back underlined; one tracked change became several after export and re-import; comment threads and moves lost their link to each other.
- **Root Cause**: `sanitizeImportedHtml` stripped `<ins>` (not in `ALLOWED_HTML_TAGS`), so `ins[data-change-type]` never reached the `insertion` mark. Word marks links with the `Hyperlink` character style, whose underline the importer applied as formatting. WordprocessingML gives every `w:ins` / `w:del` element its own `w:id` and has no thread or change id: replies point at the `w14:paraId` of their parent comment's last paragraph (`commentsExtended.xml`), moves are paired only by the `w:name` of their `w:moveFromRangeStart` / `w:moveToRangeStart`, and author ids exist only in `people.xml`.
- **Solution / Workaround**: `ins` is now allowed (attributes still go through the allowlist; this also means `<ins>` in markdown renders instead of being escaped). The importer ignores the `Hyperlink` style's formatting inside hyperlinks, merges adjacent changes with the same kind, author, date and move into one change id, maps move range names to fresh move ids, attaches replies to the root of their chain, and reads author ids from `people.xml` (the export writes it unless `privacy: "strip-authors"`). Ids are regenerated on import (`createReviewId`), so comparing round trips must use bodies, authors and texts, not ids. Other limits: `Title` paragraphs come back as `<h1>` (existing import rule), headings with custom styles lose `data-style`, block-change wrappers (lists, quotes) are not exported, and dates keep whole seconds only.

### [core/export] Word Needs a Paragraph Between and After Tables, and `w:delText` Is Only for Real Deletions

- **Issue / Symptom**: Two adjacent tables merged into one in Word; a document or cell ending in a table was reported as damaged; moved-away text showed as missing.
- **Root Cause**: Word joins consecutive `w:tbl` elements, requires every `w:tc` to end with a `w:p`, and expects a paragraph before the final `w:sectPr`. Moved-away text (`w:moveFrom`) must stay in `w:t` (ECMA-376 §17.13.5.22); only `w:del` content uses `w:delText`.
- **Solution / Workaround**: The exporter writes an empty `w:p` between adjacent tables, at the end of cells that are empty or end with a table, and after a final table (which the importer reads back as an empty paragraph), and writes `w:delText` only for deletions without a `moveId`.

### [core/canvas] Component Sync Needs the Nodes From Before the Edit, and No-Op Rebuilds Must Keep Node Identity

- **Issue / Symptom**: Deciding overrides by comparing an instance layer with its main layer recorded the main's *old* value as an override whenever the main was edited before its instances were rebuilt (the instance simply had not caught up). Separately, rebuilding instances on every React Flow change re-rendered forever.
- **Root Cause**: "Differs from the main" is ambiguous on its own: it means either "the user changed the instance" or "the user changed the main". Rebuilding an instance creates new node objects even when nothing changed, so a hook that sets nodes after a sync triggers another change, and another sync.
- **Solution / Workaround**: `syncCanvasComponents(before, after)` diffs each node against its version *before the edit*: only groups that changed on an instance layer become overrides (and only while they differ from the main), while changes inside a main rebuild its instances. Rebuilt nodes that deep-equal their previous version keep their identity, so a no-op sync returns `after` itself. The controller keeps the last synced array and syncs against it; its own actions and undo / redo set that snapshot, so changes made by a rebuild are never re-read as edits.

### [core/canvas] Token-Bound Values and Component Property Values Look Like Overrides

- **Issue / Symptom**: An instance in Dark mode (its own `data.tokenModes`) would show every bound fill as overridden; binding another variable inside an instance recorded both `token.fill` and `shape.fill`. Conversely, filtering out every group a component property drives meant that typing over a property-driven label, or swapping a nested instance whose main an instance-swap property drives, recorded no override at all.
- **Root Cause**: Bound values are materialised into the nodes (see the token entry above), so a layer resolved in another mode really does differ from its main. Property values are written by the rebuild, not by the user, so they never need filtering out of user edits.
- **Solution / Workaround**: Value groups written by a node's token bindings are never overrides (found by probing `property.write` with a different value and diffing); a different binding is the override (`token.<key>`). Property values are applied during the rebuild, which the sync never re-reads as an edit, so a user edit to a property-driven layer is an override that wins over the property, as in Figma. Only `rebaseInstance` (detach, paste, restore), which compares values rather than edits, skips property-driven groups.

### [core/canvas] Variant Switches Match Layers by Name, and Text Layers Are Often Named by Their Content

- **Issue / Symptom**: Switching an instance from `State=Default` to `State=Hover` lost the text override on its label and gave the label a new id.
- **Root Cause**: Layers of two variants are different nodes, so the rebuild matches old copies to the new variant's layers by their name path (`Frame/Label`). `getLayerName` falls back to `data.label`, which for text nodes is the text itself, and that differs between variants ("Default" / "Hover").
- **Solution / Workaround**: Give layers that must match across variants (or swaps) a stable `data.name`; it wins over `data.label` for matching. Matching inside one main uses the source id first, so plain main edits never depend on names.

### [core/canvas] Removing a Variant Must Re-Point Its Instances Before Deleting It

- **Issue / Symptom**: Deleting a variant and re-pointing its instances to another variant in the same edit kept every override of the instances, including ones the two variants disagreed on (a fill that only made sense on the removed variant stuck).
- **Root Cause**: A variant switch filters overrides by diffing the old source layer (`data.componentSource`, in the old variant) against the new one. When the old variant is already gone, the source can't be found, so nothing is filtered.
- **Solution / Workaround**: `removeCanvasVariant` syncs twice: first it re-points the instances (and instance swap values) while the variant still exists, then deletes the variant's subtree. Likewise, when editing variant values (`setCanvasVariantProperties`, renames), write the explicit `data.component.variant` and the formatted name together, since a variant without `variant` falls back to parsing its name.

### [core/spreadsheet] Large Sheets: Ranges Expanded per Cell, Whole-Sheet Undo Snapshots and Quadratic Id Lookups

- **Issue / Symptom**: On a 50k-row sheet a CSV import took 23 s, loading 100 formulas over `$A$1:$A$50000` took 3.2 s and editing one of their inputs 0.8 s, and even an edit nothing depended on took ~25 ms.
- **Root Cause**: The dependency graph expanded every range into one key per cell (100 × 50k set entries), and planning scanned those lists; `rows.find((r) => r.id === …)` in `getCell` / `setCellValue` / `getCellKey` made imports O(n²) (and range reads over blank cells too); every single-cell edit serialised the whole sheet (`JSON.stringify`) for undo.
- **Solution / Workaround**: `DependencyGraph` keeps ranges whole (`SHEETID!A1:A50000`) in a per-column interval index (ported from gridcraft's `Intervals`: sorted starts plus a max-end segment tree, insertions/removals merged lazily on the next query) and a per-sheet index for ranges wider than 64 columns; `getDependents` is O(log n + k). Planning turns each distinct range into one virtual node whose edges are the planned cells inside it (binary search), so ranges shared by many formulas cost once. `getDependencies` now returns range keys (`A1:A3`, `A:`) instead of expanded cells; use `dependsOn(formula, cell)` to ask about one cell. Rows and columns are found through a validated `PositionCache` (never `find` in a per-cell path). Single-cell edits push a `cells` undo entry (the cell's previous state); `getRecalculationStats()` gives deterministic work counts for tests. Paste/import inside the grid recalculates the written cells with their dependents in one plan; when the grid grows (or for `loadWorkbook`), `recalculateAll` evaluates everything once.

### [core/spreadsheet] Spill Edges Can Close False Cycles: Blockers Don't Order, and New Input Makes Old Edges Stale

- **Issue / Symptom**: Random edit sequences left `#CYCLE!` (or skipped spills) that a full recalculation of the same workbook didn't show, e.g. an anchor blocked by a cell whose formula (indirectly) read the anchor, `A1` = `=SEQUENCE(4)` then pasting `=MAX(A2:A9)*2` into A1 and `=SEQUENCE(3)` into A2, or replacing an anchor's formula with one reading the cells it used to spill into. The old graph had the same bugs.
- **Root Cause**: A blocked anchor's edges to its blockers were ordering edges, but whether a cell blocks depends on its input, not its value. Spilled-cell → anchor edges outlive the input that made them true (a cell that now has its own formula, an anchor with a new formula) until the anchor is evaluated again, so the plan made before that sees cycles that no longer exist, and a cyclic anchor keeps its edges.
- **Solution / Workaround**: Blocker edges are only followed for propagation (`getDependents`), never for ordering or cycle detection. Writing a cell drops the spill edges it anchored and its edge to the anchor whose values it held (`dropStaleSpillEdges`). Because dropped edges lose ordering, `placeSpill` reports every spilled cell not previously linked to the anchor as a spill change, so its dependents are recalculated in the next pass. `tests/spreadsheet-recalc.test.ts` compares incremental and full recalculation on random sheets with ranges, spills, cross-sheet, 3-D and name references, pastes, undo and redo: run more seeds after changing recalculation.

### [core/spreadsheet] Per-Plan Range Cache and Blank-Skipping Ranges Are Only Safe in Narrow Cases

- **Issue / Symptom**: Caching a range's values for a whole recalculation, or leaving blank cells out of ranges, can return stale or wrong results.
- **Root Cause**: Formulas evaluated later in the same plan (or spills re-placed) change cells inside a cached range; `COUNTBLANK`, `COUNTIF(…,"")`, `INDEX`, `MATCH` and array results depend on blank positions.
- **Solution / Workaround**: The controller caches only ranges of 256+ cells, only while `runEvaluationPlan` runs and no `valueOverride` (validation) is set; evaluating a cell drops cached ranges covering its column, and any spill change drops the sheet's entries; hits return a copy. Blanks are skipped only for direct `Range` arguments of `SUM`, `PRODUCT`, `AVERAGE`, `COUNT`, `COUNTA`, `MIN` and `MAX` (`RangeResolveOptions.skipBlanks`, a hint resolvers may ignore). Keep document order: floating-point sums depend on it.

### [react|svelte/spreadsheet] Virtualised Grid: jsdom Has No Layout, Merges Cross the Window, and Scroll-Into-View Must Not Track Scrolling

- **Issue / Symptom**: In jsdom the window computed from `clientHeight` (0) rendered no rows and `scroll` events never fired after programmatic scrolling; a merged cell whose top-left row was above the window vanished (or its `rowspan` covered the spacer); an effect that scrolled the active cell into view snapped back whenever the user scrolled away.
- **Root Cause**: jsdom does no layout (sizes are 0, no `ResizeObserver`), but it stores `scrollTop`. A merge is rendered from its top-left cell. An effect reading the viewport state re-runs on every scroll.
- **Solution / Workaround**: The core helpers (`getSpreadsheetViewWindow`, `getSpreadsheetScrollToCell`) assume a 1200×600 viewport when the size is 0, and widen the window until no merge crosses its edges. The bindings update their viewport state directly after scrolling to the active cell, and only re-render when the window changes. The scroll-into-view effect depends only on the active cell and the mode (`untrack` in Svelte, refs in React). Frozen rows/columns are rendered before the spacers so sticky offsets still work; group rows get the same spacer cells as body rows (`leadingColumns`, `leftSpace`, `rightSpace`). Small sheets (≤ 200 rows, ≤ 60 columns) render every cell, so existing DOM tests are unchanged. Browser automation must press keys (not `insertText`) to type into the grid.

### [react/svelte spreadsheet] Scrolled Rows Show Through Frozen Rows in a Collapsed-Border Table

- **Issue / Symptom**: With frozen rows and a sheet scrolled far down (e.g. the demo's 10,000-row "Large" sheet), thin slivers of the scrolling rows' text appeared along the top of every frozen row. Hit-testing showed no gap; hiding the scrolled rows made the slivers disappear.
- **Root Cause**: The grid `<table>` used `border-collapse: collapse` with the row separator on the `<tr>` (`border-b`). In the collapsing border model the shared borders belong to the table grid, not the cells, so when frozen cells are `position: sticky` their backgrounds don't cover the border band and the browser paints the rows scrolled underneath through it.
- **Solution / Workaround**: The table uses `border-separate border-spacing-0`, and the row separator is drawn on the cells (`[&>*>tr:not([data-spacer])>*]:border-b`; spacer rows get none so the virtual-scroll heights stay exact). Don't switch the grid back to `border-collapse` while frozen panes are sticky cells. Consumers' Tailwind must scan the package sources (as for every other class the components use) for the arbitrary variant to compile.

### [core/tools] The Tool Registry Lives in `/tools` So Non-Text Hosts Don't Need TipTap

- **Issue / Symptom**: A host that only wanted `ToolRegistry` (an effect editor exposing `createCommandToolProvider`, a canvas-only or spreadsheet-only app) had to install `@tiptap/core`, `@tiptap/pm` and `@dagrejs/dagre`, because importing `@pixerate/editor/agent` loads them. Consumers worked around it by copying `callTool` / `toolDefinitions` helpers or importing the tool types from `/generation`.
- **Root Cause**: `/agent` re-exports `providers.ts`, which imports `@tiptap/core` and `@tiptap/pm/state` at load time for `createRichTextToolProvider`, and `planner.ts`, which imports `canvas/layout.ts` (dagre). The registry itself depends on none of them.
- **Solution / Workaround**: The registry, the JSON Schema validator and the static MCP tool definitions live in `src/tools/` and ship as `@pixerate/editor/tools`; `/agent` re-exports `../tools/index.js` so existing imports keep working. Dependency-free modules (`commands`, `generation`, `image-editor`) import from `../tools/*.js`, never from `../agent/*`. Anything that needs TipTap or the planner (including `createEditorMcpToolProvider`, whose `layout` operation runs dagre) stays in `/agent`. `tests/entry-isolation.test.ts` fails if `tools/index.js` or `tools/index.cjs` reaches any third-party package.

### [core/animation] The `/animation` Entry Must Not Reach Canvas Code, and tsup Chunks Can Pull It In Silently

- **Issue / Symptom**: Keyframe evaluation used to live under `src/canvas/animation/`, so the only way to get `evaluateTrack` or `AnimationPlayer` was `@pixerate/editor/canvas`, which statically imports the optional `@dagrejs/dagre` peer.
- **Root Cause**: The node-independent parts (easing, OKLab colour, keyframes, `evaluateTrack`, player, clock) shared files with node code (`model.ts` / `evaluate.ts` import `CanvasNode`, `arrange`, `tokenBindings`). With `splitting: true`, one stray import from `src/animation/` into `src/canvas/` would put canvas code (and dagre) into a chunk the `/animation` entry loads, with no type error.
- **Solution / Workaround**: The node-independent code lives in `src/animation/` and imports nothing from `src/canvas/` (only `src/tokens/color.ts`). `src/canvas/clock.ts` and `src/canvas/animation/{easing,color,player}.ts` are one-line re-exports, and the canvas `model.ts` / `evaluate.ts` re-export the keyframe types and `evaluateTrack`, so `/canvas` still exports the same bindings. `tests/entry-isolation.test.ts` checks the built `dist/animation/index.js` reaches no packages; `tests/animation-entry.test.ts` checks `/canvas` re-exports the same functions and that nothing node-specific leaked into `/animation`. Add new node-independent helpers to `src/animation/`, never the other way round.

### [svelte] A Variable Named `state` Turns `$state(...)` Into a Store Subscription

- **Issue / Symptom**: `svelte-check` reports `Block-scoped variable '$state' used before its declaration` and `Cannot use 'state' as a store` in a component that declares `let state = $state.raw(...)` (for example a `ParametersState` snapshot).
- **Root Cause**: In a `.svelte` file, `$name` means "subscribe to the store `name`" whenever a variable called `name` is in scope. Declaring `state` makes the compiler read `$state` as a store reference instead of the rune.
- **Solution / Workaround**: Never name a component-level variable `state` (or `derived`, `effect`, `props`). The parameters panel keeps its snapshot in `view`. Props named `state` are fine only in components that use no `$state` rune.

### [core/commands] A Command's `params` Can Be a Getter, but Only While the Spec Is Not Spread

- **Issue / Symptom**: The JSON Schema agents see for `parameters.set` must follow the parameter schema, which changes with `ParametersController.setSchema`, but `CommandSpec.params` is a plain property read by `list()` and validated on every `execute()`.
- **Root Cause**: `CommandRegistry` stores the spec object as given and reads `spec.params` each time, so a getter works. Spreading the spec (`{ ...spec, scope }`) evaluates the getter once and freezes the schema.
- **Solution / Workaround**: Define `params` with `get params() { … }` on the object literal that is registered, and add shared fields (`group`, `scope`) by spreading them *into* that literal, not by spreading the spec into a new object. Note the registry validates params against this schema before `run`, so range and enum errors come back as `invalid_params` with `validateJsonSchema` wording (`/values/speed Must be <= 4.`); only checks the JSON Schema cannot express (vector component bounds, text patterns) reach the controller's sentence errors.

### [core/parameters] Command `execute` Runs Before `HistoryManager` Records the Step

- **Issue / Symptom**: A store that rebuilds its snapshot inside a history command's `execute` / `undo` reports stale `canUndo` / `canRedo` / `undoLabel` (the undo button stays disabled after the first edit).
- **Root Cause**: `HistoryManager.execute` calls `command.execute()` first and only then pushes the step and notifies; `undo` / `redo` likewise notify after the closure ran.
- **Solution / Workaround**: Notify from the command (so values update immediately) and also subscribe to the history, re-notifying only when the undo / redo fields actually changed. `ParametersController` does both, which keeps one snapshot per edit in the common case and never leaves the history fields stale.

### [core/animation] Parametric Elastic Easing Boundary Guarantees and Sampling

- **Issue / Symptom**: Parametric damped harmonic oscillators ($e^{-\lambda t} \cos(\omega t)$) used for elastic animations can drift from boundary conditions due to floating point inaccuracies, resulting in jumps at $t = 0$ or $t = 1$. Furthermore, CSS transitions cannot natively parse parameterised spring/elastic curves like `cubic-bezier`.
- **Root Cause**: When computing $t = 0$ or $t = 1$, damped sine/cosine equations evaluate to fractional residuals ($1 \pm \epsilon$) unless strictly bounded. Additionally, CSS transitions require standard cubic beziers or modern CSS `linear(...)` piecewise approximations.
- **Solution / Workaround**: In `elasticAt`, clamp boundary evaluations explicitly ($t \le 0 \to 0$, $t \ge 1 \to 1$). In `easingToCss`, sample elastic curves over discrete intervals (e.g. 20 samples) to generate a standards-compliant CSS `linear(...)` function for performant GPU rendering.

### [core/parameters] Range Mapper Degenerate Interval Safeguards

- **Issue / Symptom**: Passing identical bounds for the input range (`from: [v, v]`) to `createRangeMapper` or `mapRange` produces `NaN` or `Infinity` upon interpolation.
- **Root Cause**: The domain normalization formula $(value - inMin) / (inMax - inMin)$ results in division by zero ($0 / 0 = NaN$) when $inMin == inMax$.
- **Solution / Workaround**: Check for degenerate intervals (`inSpan === 0`). When degenerate, bypass division and return the lower target bound (`toMin`), preserving safety and avoiding cascading `NaN`s in downstream transform math.

### [react/dependencies] Peer Dependency Range Alignment with Sibling Pixerate Packages

- **Issue / Symptom**: Installing `@pixerate/editor-react` alongside `@pixerate/flair@0.13.0` or sibling ecosystem packages triggers `npm ERR! code ERESOLVE` peer dependency collision errors on clean `npm install`.
- **Root Cause**: `@pixerate/flair@0.13.0` declares `peerDependencies: { "@pixerate/editor": ">=0.29.0 <1" }`, while `@pixerate/editor-react` previously kept `@pixerate/editor` under direct `dependencies` pinned to an exact version (`workspace:*` resolving to `0.27.0` or `0.29.0`), causing npm's strict peer dependency resolver to detect conflicting version constraints.
- **Solution / Workaround**: Move `@pixerate/editor` to `peerDependencies` with the ecosystem-aligned range `">=0.29.0 <1"` in `@pixerate/editor-react` (paired with `devDependencies: { "@pixerate/editor": "workspace:*" }` for local monorepo builds and tests) and omit it from direct `dependencies`.

### [core/canvas] Freehand Eraser Gesture Undo Snapshot Preservation

- **Issue / Symptom**: Dragging an eraser across multiple nodes and subsequently executing undo either restored erased strokes out of order (distorting z-index ordering) or failed to restore earlier nodes in the same drag stroke when batching deletions.
- **Root Cause**: If each node erasure removes the node dynamically or splices indices step-by-step without a baseline snapshot, undoing the compound command by re-inserting elements or reversing individual removals drifts relative to remaining nodes or fails to preserve original sibling ordering.
- **Solution / Workaround**: In `createCanvasDrawController`, capture `dragStartNodes = [...options.getNodes()]` upon `startStroke` when `tool === 'eraser'`. During `endStroke`, if any nodes were deleted, register a single history command whose `undo` action restores the exact pre-drag snapshot (`options.setNodes(dragStartNodes)`), ensuring absolute fidelity of node list order, layer hierarchy, and z-indexes across continuous eraser sweeps.

### [changesets/release] Peer Dependency Range Assertions in Package Tests

- **Issue / Symptom**: The `Release` workflow fails at the `pnpm test` step after `pnpm version-packages` (`changeset version`), with an assertion error such as `expected '>=0.30.0 <1.0.0-0' to be '>=0.29.0 <1'`.
- **Root Cause**: `@changesets/cli` automatically synchronizes and bumps `peerDependencies` across monorepo workspace packages when a core package version increments. Any unit tests asserting strict exact string equality against a static version string fail as soon as Changeset bumps the package in the release pipeline.
- **Solution / Workaround**: Test package.json `peerDependencies` using regex patterns that accommodate dynamic minor/patch version increases (e.g. `expect(pkg.peerDependencies["@pixerate/editor"]).toMatch(/^>=0\.\d+\.0.*<1/)`) while still enforcing exclusion from direct `dependencies`.

### [react|svelte/canvas] Pointer-Events and Spacebar Panning in Freehand Drawing Overlays

- **Issue / Symptom**: When an interactive SVG drawing overlay (`CanvasDrawLayer`) covers the canvas, standard xyflow panning, node dragging, and canvas selection are blocked. Conversely, if pointer events are disabled, drawing gestures cannot be captured. Furthermore, users cannot pan the canvas without first switching away from the drawing tool.
- **Root Cause**: An overlay with `pointer-events: auto` intercepts all pointer gestures before they reach React Flow or Svelte Flow's pane and node layers.
- **Solution / Workaround**:
  1. Set `pointer-events: auto` on `CanvasDrawLayer` only when `tool !== 'select'`. When `tool === 'select'`, set `pointer-events: none` to let xyflow handle selection, dragging, and box selection natively.
  2. Implement spacebar hold detection (`isSpacePressed` via `keydown` / `keyup`). While spacebar is held down, toggle the overlay's pointer events to `none` and switch the cursor to `grab`, allowing users to hold Space and drag to pan the xyflow canvas seamlessly without changing their active drawing tool.

### [core/vector] Live Corners Vanish When an Anchor Is Copied Field by Field

- **Issue / Symptom**: A rounded corner turns sharp after moving, scaling, reversing or pasting a path, with no error.
- **Root Cause**: The radius lives on the anchor (`anchor.corner`), and several helpers build anchor copies by hand (`{ x, y, in, out, type }`), so any copy that lists the fields drops it.
- **Solution / Workaround**: Copy anchors with `cloneAnchor`, or add `...(a.corner ? { corner: { ...a.corner } } : {})` to hand-built copies (`bakeIntoGeometry`, `reverseSubpath`, `curvatureMoveAnchor`, `subpathsIn` do). Tests in `vector-corners-strokes.test.ts` move, scale, rotate and paste a rounded path.

### [core/vector] `subpathsToBezier` Draws Live Corners, So Its Segments No Longer Match the Anchors

- **Issue / Symptom**: Code that walks the Bézier commands of a path and maps segment `i` back to anchor `i` gets the wrong segment (or one too many) on a path with corner radii.
- **Root Cause**: `subpathsToBezier` runs `expandVectorCorners`, the one place live corners are cut; a cut corner adds an anchor and trims both neighbouring segments.
- **Solution / Workaround**: Use `subpathSegment(sp, i)` / `nearestSegment` for anchor-indexed segments, or `subpathsToBezier(subpaths, { corners: false })` for the sharp outline. `expandVectorCornersOf` also returns `sources`, the stored anchor each drawn anchor came from.

### [core/vector] One Cubic per Corner Cut Loses Accuracy at Sharp Angles

- **Issue / Symptom**: The round cut of a very acute corner (a star's tip) is visibly not quite circular when zoomed far in.
- **Root Cause**: A cubic arc's radial error grows with roughly the sixth power of the angle it turns through: about 0.03 % of the radius for a 90° turn, about 0.6 % for the 150° turn of a 30° corner.
- **Solution / Workaround**: Acceptable for drawing (figcraft does the same); the tests assert < 1 % at 30°. If an exact arc ever matters, split cuts turning more than 90° into two cubics in `cutCorner`.

### [core|react|svelte/vector] Clip Paths and Masks for Aligned Strokes Need Node-Local Coordinates and Explicit Mask Bounds

- **Issue / Symptom**: An inside / outside stroke is clipped in the wrong place on rotated nodes, or an outside stroke (and its arrowheads) is cropped at the shape's bounding box.
- **Root Cause**: `clipPathUnits` / `maskContentUnits` default to `userSpaceOnUse`, which is the user space of the *referencing* element, transform included, so the clip shape must use the node's own coordinates (the same `d` as the fill), not document ones. A `<mask>` without `maskUnits="userSpaceOnUse"` and a box covers only the object's bounding box plus 10 %, which cuts a wide outside stroke.
- **Solution / Workaround**: `vectorStrokeSvgParts` returns `clip.bounds` (the outline's bounds padded by `vectorStrokeReach`) and both canvases and the SVG export write `<mask maskUnits="userSpaceOnUse" x y width height>` with a white rect and the shape in black, inside the node's own `<g transform>`. Ids come from the canvas `idPrefix`, so two canvases on a page don't share clips.

### [core/vector] `render.ts` and `svg.ts` Import Each Other's Module Graph

- **Issue / Symptom**: Moving a render helper that the SVG exporter needs into `render.ts` creates an import cycle (`svg.ts → render.ts → controller.ts → svg.ts`).
- **Root Cause**: `render.ts` already imports `vectorPaintToSvg` from `svg.ts`, and the controller imports `svg.ts` for `toSvg` / `loadSvg`.
- **Solution / Workaround**: Keep helpers both need in `svg.ts` (or lower: `stroke.ts`, `corners.ts`, `geometry.ts`), e.g. `vectorStrokeSvgParts` and the `VectorRenderStrokeParts` type, and import them into `render.ts`. `stroke.ts` and `corners.ts` import only path ops and types, so `geometry.ts` can use them.

### [core/vector] Width Handles Only Hit-Test on Paths the Overlay Already Shows

- **Issue / Symptom**: A width-tool press or double-click on a width point added a new point (or opened the editor on a stroke spot) instead of grabbing the existing one, when no pointer move had hovered the path first (tests, touch, a double-click straight after a tool switch).
- **Root Cause**: `getVectorWidthHandles` lists the points of the hovered, selected and dragged paths only, and `hitWidthHandle` searched that list.
- **Solution / Workaround**: `hitWidthHandle` falls back to the points of the stroke under the pointer (`strokeSpotAt`) when the shown ones miss. Keep any new width gesture going through it rather than `getVectorWidthHandles(state)` directly.

### [core/vector] Moving Several Width Points Re-Sorts the Profile and Renumbers Them

- **Issue / Symptom**: After a multi-point move (or a copy, or `setWidthPoint` with a new `t`) the selection pointed at the wrong points, or a step's two halves swapped.
- **Root Cause**: Width points are addressed by index into a profile kept sorted by `t`; a group move or a copy can pass other points. `setWidthPoint` from `width.ts` clamps a single point between its neighbours to keep indices stable, but group moves and the numeric editor deliberately don't.
- **Solution / Workaround**: Sort stably with the old index as the tie-break and carry an old → new map (`shiftWidthPoints` in `controller.ts`, `drag.renumber`); insert copies and moved points with `insertWidthPoint(…, { step: true })` and use the returned index. Undo restores the profile but not the selection, so `restore` drops selected refs whose index no longer exists and closes the width-point editor.

### [react|svelte/vector] HTML Inside the Canvas `<svg>` Must Stop Its Events

- **Issue / Symptom**: Typing Delete in the width-point editor deleted width points, clicking it started a width drag, and copying from its inputs copied the drawing.
- **Root Cause**: The editor lives in a `<foreignObject>` inside the canvas `<svg>`, whose `pointerdown` (focus + pointer capture), `keydown`, `dblclick` and clipboard handlers see every bubbling event. `isVectorTextTarget` only covers keys typed into text fields, not buttons.
- **Solution / Workaround**: `VectorWidthPointEditor` stops propagation of pointer, double-click, key and clipboard events on its `<form>` (Svelte's delegated handlers honour `stopPropagation` too) and hands focus back to the closest `<svg>` when it closes.

### [core/vector] Shape Builder Edges Run Between Junctions, Not Anchors, and Cutting One Flattens Live Corners

- **Issue / Symptom**: Alt-erasing what looks like one side of a rectangle can take two sides (and the corner between them); a cut path loses its live corner radii; and a filled open path's erased edge can bring back its invisible closing segment.
- **Root Cause**: `PlanarMap.chains()` only breaks a run where other paths meet it (or it ends), so a corner inside another shape is mid-edge. The edges are cut out of the document-space outline from `vectorPathWorldBezier`, which already has live corners cut into curves. A filled open subpath that encloses an area is closed in the map, so its edges may run over the closing segment.
- **Solution / Workaround**: Pick test points and expectations by junctions, not anchors. `cutOutPiece` treats filled open subpaths as rings with an invisible closing span (`real..len`) and stops kept runs at it, so it never becomes a visible segment. The cut result is mapped back through the inverse of the node's matrix and written with `bezierToSubpaths`, keeping the node's transform; the corner radii are not kept. `VectorShapeBuilderMap.edges` is a lazy getter: spreading the map evaluates it, so pass the map itself around.

### [tests] `randomize()` Tests Flake When the Random Value Lands on the Default

- **Issue / Symptom**: The React and Svelte parameters binding tests occasionally failed in CI at `expect(state.modified).toBe(true)` right after `randomize(["speed"])`.
- **Root Cause**: The controller used `Math.random`, and the field snaps to its step: any draw in about [0.2375, 0.2625) gives back the default `speed` of 1, so nothing is modified (about a 1 in 40 chance).
- **Solution / Workaround**: Give the controller a fixed source in tests (`new ParametersController({ schema, random: () => 0.75 })`) or call `randomize({ seed })`, and assert the value it picks. Never assert a change after an unseeded randomize.

### [core/vector] Picking a Morph's Start Anchor by Position Squashes Turned Shapes

- **Issue / Symptom**: Blending a horizontal bar into the same bar turned 90° gave a middle step that was a fat square (area up a third) instead of the bar half turned, even with the Procrustes in-between.
- **Root Cause**: effectcraft's `correspond` scores each cyclic start by how far corresponding anchors are apart once both shapes are centred and scaled. That cost is not rotation-invariant: the start that pairs each corner with the nearest one (a squash) beats the one that pairs it with the turned corner, and Procrustes then finds no rotation to follow. Its absolute-angle shape-context histograms push the same way.
- **Solution / Workaround**: `bestStart` in `vector/blend.ts` scores what is left after the best-fit rotation and scale (`1 − (dot² + cross²) / n²` on unit-RMS point sets, O(n) per start), plus `0.1 · (1 − cos θ)` so the least turning wins among equal fits (circles, squares), plus shape contexts whose angles are measured from the contour's direction (rotation-invariant).

### [core/vector] Largest-Remainder Anchor Allocation Must Treat Rounding Noise as a Tie

- **Issue / Symptom**: A star and the same star turned did not keep their area through a blend: the in-betweens came out slightly distorted.
- **Root Cause**: When a contour's segments all have the same length, the fractional parts of their anchor shares differ only by floating-point noise, and that noise — different for the turned copy — decided which segments got the extra anchors. The two shapes were refined differently, so no start lined them up exactly.
- **Solution / Workaround**: `refineMorphContour` sorts remainders with a 1e-9 tolerance and breaks ties by segment index, so congruent shapes are split alike.

### [core/vector] `mapTree` Visits the Node It Just Returned

- **Issue / Symptom**: Adding a shape to a blend with `mapTree(nodes, (n) => n.id === key ? null : n.id === blend ? { ...blend, children: [...children, key] } : n)` reported success, but the key vanished from the document.
- **Root Cause**: The controller's `mapTree` recurses into the children of whatever the callback returns, so the moved key was found inside the new group and removed again.
- **Solution / Workaround**: Remove first, then insert with `spliceTree` (or any pass that does not re-run the callback on its own output).

### [core/vector] Blend Steps Are Rebuilt in `notify()` and `commit()`, Keyed by Key Identity

- **Issue / Symptom**: A live blend has to follow every edit of its keys (drags included) without each tool knowing about blends, and undo must restore steps that match the keys.
- **Root Cause**: Steps are derived data stored in the document (so the scene, bounds, hit-tests and SVG export see them), and the controller mutates `this.doc` in many places.
- **Solution / Workaround**: `refreshVectorBlends` runs on the document in `notify()` (live during drags) and at the start of `commit()` (so history snapshots hold the refreshed document). It returns the same objects when nothing changed: generated children are cached per first key and reused while the keys are the same objects and the blend options serialise the same, and morph correspondences are cached per key pair. Steps are locked (`locked: true`) so the select tool picks the blend group and the direct tool only reaches keys; transforms of the group bake its replaced spine with the children (`bakeIntoGeometry`).

### [core/vector] Expanded Appearance Paths Have Ids That Are Not in the Document

- **Issue / Symptom**: After path effects and live booleans were routed through `vectorPathEntries`, the Pathfinder and `booleanOp` failed to put their result back: `findVectorNode([root], entry.node.id)` found nothing, so the result replaced no node.
- **Root Cause**: `expandVectorAppearance` turns a node drawing several shapes (a repeater, a live group) into a group of paths with ids `<id>~fx<n>`. Those are derived nodes, never stored; only the top node keeps its stored id.
- **Solution / Workaround**: Look entries up through the expanded tree as well (`controller.holds(rootId, id)` checks `findVectorNode` on the node and on `expandVectorAppearance(node)`), drop the roots by their stored ids, and give derived nodes fresh ids before storing them (Expand Appearance does). Code that edits the shapes it reads (the Shape Builder) must ask for the stored geometry with `vectorPathEntries(doc, roots, { expand: false })`.

### [core/vector] Merged Undo Steps Need the Command's `tag` Equal to Its Gesture Key

- **Issue / Symptom**: A slider drag committed with `history.executeMerged(command, { key })` folded into one undo step, but the step kept growing: every move added another undo / redo part.
- **Root Cause**: `HistoryManager.executeMerged` only replaces the top step's last part ("the same absolute command again") when the new command's `tag` equals that part's tag; otherwise it appends a part.
- **Solution / Workaround**: The controller's `commit(name, before, merge)` sets `tag: merge` on the snapshot command, so the step keeps the pre-drag `before` and only the latest `after`. Ending the drag calls `endMergedEdit()` (`history.endGesture()`) so the next drag of the same control starts a new step.

### [core/vector] Wiggle's Hash Needs Exact 64-bit Arithmetic

- **Issue / Symptom**: A wiggle ported with JavaScript numbers gave different (and less random) noise than the source, and lost precision past 2⁵³.
- **Root Cause**: effectcraft's `splitmix` / `hash` rely on wrapping `u64` multiplication and shifts; `Math.imul` is 32-bit and doubles lose the low bits.
- **Solution / Workaround**: `pathEffects.ts` runs `splitmix` on `BigInt`s masked to 64 bits (`BigInt.asUintN(64, …)` for negative lattice indices) and converts only the final `h >> 11` to a number. It is called a few thousand times per wiggle, which is cheap; results are cached per node anyway.

### [core|react/vector] StrictMode's Double Effect Destroys the Controller `useVectorEditorController` Keeps

- **Issue / Symptom**: In the dev demo (React StrictMode) the toolbar's History buttons lagged one step: after an edit Undo stayed disabled, after an undo Redo stayed disabled — though `controller.getState()` was right whenever it was next read.
- **Root Cause**: `useVectorEditorController` creates the controller once in a ref and calls `controller.destroy()` in an effect cleanup. StrictMode runs effects, cleans them up and runs them again, so `destroy()` dropped the controller's history subscription while the same controller stayed in use. History-only changes (labels, `canUndo`/`canRedo`) then reached the UI only with the next document change.
- **Solution / Workaround**: The controller's history connection is idempotent (`connect()`), made in the constructor and again on every `subscribe()`, catching up on history changes missed while disconnected. StrictMode's re-run of `useSyncExternalStore`'s subscribe effect reconnects it. Any core controller whose `destroy()` a React hook calls from a ref-kept instance needs the same treatment (or must be created inside the effect).

### [core/vector] `objectBoundingBox` Gradients Paint Nothing on a Straight Line

- **Issue / Symptom**: A gradient stroke on a horizontal or vertical line (or a stroke part drawn on a different element than the fill) disappears or shifts.
- **Root Cause**: SVG maps `objectBoundingBox` gradients onto the painted element's own geometry box; a box with no height (or width) is singular, so browsers paint nothing, and each element of a stroke drawn in parts has its own box.
- **Solution / Workaround**: The vector editor writes every gradient in `userSpaceOnUse` with the shape's box as the `gradientTransform` (`vectorBoxMatrix`), computed once per node from its outline, and a side with no extent takes the other side's (centred). Fill, stroke parts and effect copies then share one frame.

### [core/vector] A Linear Gradient's t Is a Projection, Not a Frame Coordinate

- **Issue / Symptom**: A `userSpaceOnUse` linear gradient on a sheared shape exported to SVG paints at the wrong angle, though the editor's own sampling is right.
- **Root Cause**: The model measures t as the u coordinate in the start / end / width frame (exact under any affine map), but SVG's `x1 y1 x2 y2` measures the projection onto x1 → x2, which only agrees while the width axis is square to the main axis.
- **Solution / Workaround**: `vectorGradientSvgDefs` writes `x1 y1 x2 y2` when the frame is square and `x1=0 x2=1` with the frame as `gradientTransform` otherwise. Keep that check if the export changes.

### [core/vector] Adaptive Stop Expansion Must Probe Near the Ends of Each Piece

- **Issue / Symptom**: Oklab or linear-light gradients exported as stops were off by two colour levels just after a stop whose colour has a zero channel.
- **Root Cause**: Converting back to sRGB applies the gamma curve, whose slope is steepest next to 0, so the error of a straight piece peaks close to its end; checking only the quarter points missed it.
- **Solution / Workaround**: `expandVectorGradientStops` checks each piece at 3 %, 10 %, 25 %, 50 %, 75 %, 90 % and 97 % before accepting it. The tests compare 2000 samples against the true ramp.

### [core/vector] Gradient Samples on a Period's Edge or a Conic Centre Are Ambiguous

- **Issue / Symptom**: Tests comparing a `repeat` gradient (or a conic one) with its exported paint server fail at a few grid points with a completely different colour.
- **Root Cause**: At t exactly on a whole number, `repeat` gives 0 or 1 depending on rounding (the first or last stop), and a conic gradient's angle is undefined at its centre and jumps at its seam.
- **Solution / Workaround**: Skip sample points within 1e-4 of a period edge, the centre and the seam; anywhere else the paint server must match the model within 2 / 255. The canvases' checkerboard is also a `<pattern>`: select a gradient pattern by its id (`pattern[id$="fill-a"]`), not by tag.

### [core|react|svelte/vector] Pattern Content Starts at the Tile's Corner

- **Issue / Symptom**: Conic and diamond fills (patterns of gradient tiles) drew nothing, or the wrong part of the sweep, in the browser although every `<pattern>`, tile and gradient was there.
- **Root Cause**: Without a `viewBox`, an SVG `<pattern>`'s content coordinate system has its origin at the tile's `(x, y)`, not at the user-space origin, so content written in user space was shifted by the tile's position (outside the tile).
- **Solution / Workaround**: `patternAttrs` gives every pattern a `viewBox` equal to its tile (`x y width height`), which maps content coordinates one to one onto the user space. Keep it when rendering `VectorSvgPatternDef.attrs`.

### [core/vector] Warp Meshes Must Extrapolate Outside Their Box

- **Issue / Symptom**: Curved shapes under an envelope gained far more anchors than straight ones and came out lumpy near the box edges, although the warp itself was smooth.
- **Root Cause**: The envelope's box is the paths' tight curve bounds, so Bézier handles routinely lie outside it. The ported `locate` clamped the box fraction to 0–1, which squashed every handle outside the box onto the border; the adaptive mapper then saw the mapped control polygon stray from the mapped curve and kept splitting.
- **Solution / Workaround**: `locate` in `warp.ts` no longer clamps: outside 0–1 the end patches' polynomials simply continue, so handles past the box map smoothly. Callers that need a point on the surface (`vectorMeshParamAt`) clamp their own parameters.

### [react|svelte/vector] Two Panels Editing One Effect Collide on Their Labels

- **Issue / Symptom**: After switching an envelope to Mesh, tests still found the "Envelope Bend % slider" the Envelope panel had just hidden.
- **Root Cause**: The generic Effects panel builds a control per entry of `VECTOR_EFFECT_PARAM_SPECS` and labels it `${effect label} ${param label}`, so it rendered the envelope's bend, distortion, orientation and mesh-size controls with exactly the Envelope panel's labels, regardless of the style.
- **Solution / Workaround**: `getVectorEffectsPanel` returns no `specs` for an envelope (it still lists it to toggle, reorder and remove); `VectorEnvelopePanel` edits it. The specs stay in `VECTOR_EFFECT_PARAM_SPECS` because `normalizeVectorEffectParams` validates against them.

### [core/vector] Free Distort Takes Over Mod on the Selection Box

- **Issue / Symptom**: Mod-dragging a box handle normally scales without snapping; in Free Distort mode it skews (sides) or, with Shift+Alt, makes a symmetric perspective (corners).
- **Root Cause**: Illustrator's Free Transform modifiers (Cmd on a side shears, Cmd+Alt+Shift on a corner is perspective) clash with the editor's "hold Mod to bypass snapping".
- **Solution / Workaround**: The distort modifiers apply only while `state.freeDistort` is on (the toolbar's Distort toggle); out of that mode the box scales as before. Distort drags never snap.

### [core/agent] Agents Can't Turn Plain Text into ProseMirror Positions

- **Issue / Symptom**: An agent read the document with `get_text`, counted characters to the word it wanted, and called `insert_text { at }`. The text landed a few characters off, more so further down the document.
- **Root Cause**: Editing tools take ProseMirror document positions. Each block boundary adds positions that don't exist in the plain text (`<p>a</p><p>b</p>`: "b" is at 4, not at offset 2), and inline nodes count as one position. Plain-text offsets and document positions only agree at the start of the first paragraph.
- **Solution / Workaround**: Never ask a model to compute positions. `find_text` returns `{from, to}` for each match, and `get_text { blocks: true }` returns each textblock's `from`/`to`. Edits by content go through `replace_text`, which searches and replaces in one transaction (last match first, so earlier positions stay valid). Any new tool that takes positions must have a read tool that returns them.

### [core/agent] The Planner Is Lenient, So Tool Providers Must Validate First

- **Issue / Symptom**: `edit_canvas { operation: "remove_nodes", nodeIds: ["typo"] }` reported `applied: 1`, and nothing happened. An added node without an id got a generated id the agent never saw, so its next `connect` call used a made-up id.
- **Root Cause**: `planAgentCommand` is built for UI choreography. It falls back instead of failing (unknown anchor → place beside the last node) and plans steps for ids that don't exist, leaving `applySteps` to ignore them. The provider returned only step types.
- **Solution / Workaround**: `createEditorMcpToolProvider` runs `validateAgentCommand(command, snapshot)` before planning. Unknown ids, an id that already exists, self-edges and unordered ranges come back as tool errors naming the bad id. Results include `created: { nodes, edges }` with the generated ids. Hosts that call the planner directly should call `validateAgentCommand` too. Prompt positions are host-defined, so only their order is checked.

### [core/tools] `anyOf` / `oneOf` Errors Must Point at the Closest Branch

- **Issue / Symptom**: With composition keywords, a validator that only says "does not match any schema" leaves a model guessing. A model that retries blindly tends to swap to the other branch instead of fixing the one field it got wrong.
- **Root Cause**: Every branch fails for its own reasons, and reporting all of them buries the useful one.
- **Solution / Workaround**: `validateJsonSchema` reports one summary error plus the errors of the branch with the fewest errors (usually the one whose `const` discriminator matched). `$ref` only resolves local pointers (`#`, `#/$defs/...`) and stops after 32 hops, so recursive schemas (`items: { $ref: "#" }`) work and cycles can't hang the registry. Keywords it doesn't know are ignored, so tool authors should stick to the documented list.

### [core/tools] MCP Distinguishes Protocol Errors from Tool Errors

- **Issue / Symptom**: A server that reports every failure the same way breaks clients. If a call to a tool that was removed (its editor unmounted) comes back as a normal tool result, the model keeps retrying it. If a cancelled `tools/call` still sends its late result, the client sees a response to a request it no longer tracks.
- **Root Cause**: The MCP spec puts an unknown tool or malformed `params` at the JSON-RPC level (`-32602`), while invalid arguments and execution failures are `isError` results the model reads. Cancellation (`notifications/cancelled`) means the server must not respond to that request.
- **Solution / Workaround**: `createMcpServer` returns `-32602` for unknown tools and non-object `arguments`, passes `invalid_arguments` / `tool_failed` through as `isError` results, aborts the call's `AbortSignal` on cancellation and resolves `handle()` to `null` for it. `notifications/tools/list_changed` is only sent after `notifications/initialized`.

### [core/chart] Tick Steps Below the Float Spacing Stall a Running Sum

- **Issue / Symptom**: `niceScale(1e16, 1e16 + 4)` returned up to 1000 identical ticks, and axis labels with a 2.5 step merged (`0 | 3 | 5 | 8 | 10`).
- **Root Cause**: Ticks were built with `t += step`. Near 1e16 the float spacing is 2, so adding 1 rounds back to the same value and the loop only stops at its cap. Separately, label decimals came from the step's order of magnitude, which says 0 decimals for 2.5 and 1 for 0.25. `clean()` (`toPrecision(12)`) also flattens 1e16 + 2 to 1e16.
- **Solution / Workaround**: Compute tick `i` as `(firstIndex + i) * step`, drop neighbours that round to the same float, and only `clean` when that moves a value by less than a millionth of the step. `stepDecimals` counts the decimals of the step itself. When `hi - lo` overflows (±`Number.MAX_VALUE`), take the step from the half span and double it.

### [core/chart] A Drag Must Freeze the Value Axis and Drop No-op Steps

- **Issue / Symptom**: Dragging a bar past the axis maximum rescaled the axis under the pointer, so the bar seemed to run away. Dragging back to the start, or setting a value to what it already was, still left an undo step.
- **Root Cause**: Every move relaid the chart with a fresh `niceScale` over the new data. The controller recorded every commit and merged gesture steps without comparing them to the starting spec.
- **Solution / Workaround**: `startChartPointDrag` returns `valueDomain`. Canvases keep it in state and pass it to `layoutChart({ valueDomain })` until `end()`. `ChartController.commit` returns early when the next spec is structurally equal to the current one, and `endGesture` calls `history.revertTo(mark)` when the spec is back where the gesture began.

### [svelte] A Variable Named `state` Breaks `$state` in the Same Component

- **Issue / Symptom**: `let state = $state.raw(...)` in `ChartPresenceLayer.svelte` failed svelte-check with "Block-scoped variable '$state' used before its declaration" and "Cannot use 'state' as a store".
- **Root Cause**: In a component, `$name` means "subscribe to the store `name`". With a local variable called `state`, the compiler reads `$state` as a store subscription to it, not as the rune.
- **Solution / Workaround**: Never name a component variable `state` (or `derived`, `effect`, `props`). Use `current`, `view` or similar.

### [core/import] Imported HTML Drops `data:image/svg+xml` Images

- **Issue / Symptom**: Charts imported from DOCX as SVG `<img>` tags vanished from the HTML.
- **Root Cause**: `sanitizeImportedHtml` validates `src` with markdown-it's `validateLink`, which only allows `data:image/(gif|png|jpeg|webp)`. SVG data URLs are rejected on purpose (SVG can carry script when opened directly).
- **Solution / Workaround**: The DOCX importer writes each chart as `<div data-type="chart" data-chart="{spec}">` around a caption and a data table, and returns the full spec in `DocumentImport.charts`. With the `chart` node in the schema the div becomes a live chart; without it the div is a plain wrapper and the caption and table stay. The chart node's own HTML carries its static SVG inline (the sanitizer drops it with its content on import; the spec in `data-chart` is what is parsed). Do not widen the URL allowlist for SVG.

### [core/chart] Atomic `run_commands` Only Covers Edits in the Registry's History

- **Issue / Symptom**: `run_commands { atomic: true }` left chart edits applied after a later step failed.
- **Root Cause**: The batch is a `history.batch` on the `CommandRegistry`'s own `history`. A `ChartController` created without `history` records into its own `HistoryManager`, which the batch never sees.
- **Solution / Workaround**: Share one `HistoryManager` between the registry (`new CommandRegistry({ history })`) and the controllers (`new ChartController({ history })`). Without a registry history, atomic batches are refused with a sentence.

### [core/chart] A User Drag During an Agent Performance Ends the Agent's Undo Step

- **Issue / Symptom**: If the user drags a bar while `ChartDirector` is acting out an agent's edits, the agent's edits before and after the drag become separate undo steps.
- **Root Cause**: `ChartController` holds one gesture at a time; `beginGesture` from the user's drag ends the director's gesture.
- **Solution / Workaround**: Accepted: both sets of edits still apply and undo correctly, only the grouping differs. Hosts that need strict grouping can disable editing (`editable={false}`) while `presence` shows an active actor.

### [monorepo] A Patch Changeset Moves the React Peer Range Off `.0`

- **Issue / Symptom**: The Release run failed after merging a patch changeset: `expected '>=0.46.1 <1.0.0-0' to match /^>=0\.\d+\.0.*<1/` in `packages/react/tests/react.test.ts`. PR CI passed because it runs the tests before `changeset version`.
- **Root Cause**: `updateInternalDependencies: "patch"` makes `changeset version` raise the react package's `@pixerate/editor` peer range to the new core version, which ends in `.1` after a patch release. The test assumed it always ends in `.0`.
- **Solution / Workaround**: The test accepts any `>=0.x.y <1` range. To catch this class of failure before merging, run `pnpm version-packages && pnpm test`, then discard the version changes.

### [monorepo] Dependabot Bumps Can Load Two Copies of `prosemirror-model`

- **Issue / Symptom**: After a grouped Dependabot bump (#136), table, track-changes and document-structure tests failed with `Can not convert <…> to a Fragment (looks like multiple versions of prosemirror-model were loaded)`.
- **Root Cause**: `prosemirror-markdown@1.13.8` resolved `prosemirror-model@1.25.12`, while the TipTap packages stayed on 1.25.11. ProseMirror checks node types by identity, so nodes from one copy are rejected by the other.
- **Solution / Workaround**: Run `pnpm dedupe` and commit the lockfile. After any dependency bump, check that `pnpm-lock.yaml` has a single `prosemirror-model@` entry.

### [core/extensions] An Attribute's `parseHTML` Overrides the Parse Rule's `getAttrs`

- **Issue / Symptom**: A ```` ```mermaid ```` block parsed into a chart node with an empty spec, although the `pre` parse rule's `getAttrs` returned the spec read from the code.
- **Root Cause**: TipTap wraps every parse rule: it calls the rule's `getAttrs`, then each attribute's own `parseHTML(element)`, and spreads the attribute values over the rule's. Only `null` / `undefined` leave the rule's value in place, so `parseHTML: (el) => read(el) ?? fallback` always wins.
- **Solution / Workaround**: When a node has several parse rules, attribute `parseHTML` must return `null` when its source is missing (the chart's `spec` and `height` do); the attribute `default` still applies when neither sets it.

### [core/extensions] `addNodeView` Cannot Opt Out by Returning `null`

- **Issue / Symptom**: A node whose `addNodeView` returned `null` when no framework view was configured would throw when ProseMirror created the node view.
- **Root Cause**: TipTap only checks that the `addNodeView` *field* exists, then calls the factory it returns for every node; a `null` factory is called like a function.
- **Solution / Workaround**: Always return a factory. `createChartNodeView(mount, renderStatic)` mounts the framework component when there is one, and otherwise draws (and redraws on update) the same static SVG as `renderHTML`.

### [core/agent] Quick Agent Edits Merge Into One Undo Step

- **Issue / Symptom**: `insert_chart` followed by two `update_chart_in_document` calls was undone in one Mod-Z, removing the chart. The text tools did the same: two quick `replace_text` calls and an `insert_text` went in one undo.
- **Root Cause**: `prosemirror-history` groups transactions that arrive within `newGroupDelay` (500 ms), and tool calls come back to back.
- **Solution / Workaround**: Every rich text tool that writes marks its transaction with `closeHistory(tr)` (`@tiptap/pm/history`), so each call starts its own undo step: the chart tools, the formatting tools (`format_text`, `set_block_type`, `set_text_align`, in the selection step of their chain), `replace_text`, the plain write behind `insert_text` / `replace_range` / `replace_selection`, and the final commit of typed-out agent text (`typeAgentText`). A new write tool must do the same; `tests/rich-text-format-tools.test.ts` checks four quick calls take four undos.

### [react|svelte/chart] A Chart Node View Keeps Its Own Controller in Step With the Document

- **Issue / Symptom**: Writing every `ChartController` change into the document turned one bar drag into dozens of document steps, and undo in the editor left the canvas showing the old chart.
- **Root Cause**: The canvas, inspector and data grid edit a `ChartController`; the document stores the spec as a node attribute. They are two sources of truth.
- **Solution / Workaround**: `ChartNodeView` (core) subscribes to the controller and writes the spec with `setNodeMarkup` only when no gesture is running, skipping specs equal to the node's. Its `update(node)` loads a changed spec into the controller with `clearHistory: true` (undo, agent tools, collaborators). While the inspector is open `stopEvent` returns `true`, so inputs and keys stay in the inspector, and `ignoreMutation` always returns `true`. The React view renders in its own root (`createRoot`), so app context does not reach it, and it unmounts in a microtask because ProseMirror can destroy node views during a React render. The Svelte component takes the state as `view`, not `state` (see "A Variable Named `state` Breaks `$state`").

### [svelte/packaging] `Foo.svelte` and `foo.svelte.ts` Collide on Case-Insensitive Disks

- **Issue / Symptom**: `svelte-check` warned "Cannot write file `dist/chart-node/chartNodeView.svelte.js` because it would be overwritten by multiple input files", next to `ChartNodeView.svelte`.
- **Root Cause**: A component `ChartNodeView.svelte` and a rune module `chartNodeView.svelte.ts` both emit `…/[Cc]hartNodeView.svelte.js` / `.d.ts`; macOS and Windows file systems treat the names as one file.
- **Solution / Workaround**: Give rune modules a name that differs from every component in the folder by more than case (here `createChartNodeView.svelte.ts`).

### [core/export] Charts Round-Trip Through Word Without Their Series Ids

- **Issue / Symptom**: A chart exported with `exportDocx` and imported again has the same data, colours and options, but its series ids are `series-1`, `series-2`, … instead of the originals, and colours come back lower-case.
- **Root Cause**: `chartToOoxml` writes a DrawingML `c:chartSpace`, which has no place for a series id; `chartFromOoxml` numbers series on read and writes colours as lower-case hex. The import also does not read the drawing's `wp:extent`, so the node's `width` / `height` fall back to the defaults.
- **Solution / Workaround**: Compare round-tripped specs without series ids (as `tests/docx-export.test.ts` does), and do not key anything that must survive a Word round trip on series ids. Sparklines have no Word equivalent here and are exported as text (label, or `▁▅█` bars).

### [react|svelte/canvas] Streamed Nodes Lose Their Edges in React Flow

- **Issue / Symptom**: In the Mermaid streaming view, only the last edges to arrive were drawn; earlier ones vanished while nodes glided between layouts.
- **Root Cause**: Every tween frame passes new node objects. Without `measured`, React Flow treats a changed node object as unmeasured and drops its handle bounds, and edges whose handles have no bounds are not rendered.
- **Solution / Workaround**: Keep the sizes React Flow reports (`dimensions` changes in `onNodesChange`) and pass them back as `node.measured` (see `MermaidDiagramDemo.tsx`). Controlled editors that already apply `applyNodeChanges` are not affected.

### [core/canvas] Moving One Node of an Auto-Laid Mermaid Diagram Shifted the Others

- **Issue / Symptom**: Dragging one node of a diagram without a `%% @pixerate` layout moved every other node by the same offset.
- **Root Cause**: `ensureDiagramLayout` keeps stored positions and aligns the auto layout of the rest on them (Ursula's blend). With one stored node, the whole auto layout is shifted to match it.
- **Solution / Workaround**: Pin the current positions on the first move: `mermaidMovesFromCanvas(..., { stored: doc.meta.layout })` (the React / Svelte bindings do) and `createDiagramToolProvider(controller, { getPositions })` for agent moves.

### [core/bridge] `http.close()` Hangs While a WebSocket Peer Stays Open

- **Issue / Symptom**: Closing the tool bridge in tests hung until the test timed out.
- **Root Cause**: Upgraded sockets are no longer HTTP connections, so `server.closeAllConnections()` does not touch them, but `server.close()` still waits for them. A peer that never answers a close frame keeps the server open.
- **Solution / Workaround**: The bridge tracks every upgraded socket and destroys them on `close()`. A closed WebSocket is also destroyed one second after its close frame if the peer stays silent.

### [svelte/tests] Node's WebSocket Fails Under jsdom ("event" must be an instance of Event)

- **Issue / Symptom**: A Svelte test that opened a real WebSocket under the jsdom environment threw `The "event" argument must be an instance of Event`.
- **Root Cause**: jsdom replaces the global `Event`, and Node's built-in WebSocket (undici) rejects events that are not its own. Under the `node` environment, the Svelte tests resolve the server build, where `$effect.root` does not run.
- **Solution / Workaround**: Test the network path in core under the `node` environment (`tests/tool-bridge.test.ts`). Test runes with a fake socket passed as `options.WebSocket`.

### [core/chart] Agent Cursors Never Disappeared After `linger`

- **Issue / Symptom**: A `ChartDirector` cursor stayed on the chart after its command finished, although `linger` should hide it.
- **Root Cause**: The queue stored `run.catch(...)` but the linger check compared the stored promise with `run`, which never matched, so the cursor was never removed.
- **Solution / Workaround**: The per-actor queue now lives in `PerformanceQueue` (`animation/presence.ts`), shared by the chart and diagram directors, and compares against the promise it stored.

### [core/tests] Undestroyed TipTap Editors Crash Later Test Files ("document is not defined")

- **Issue / Symptom**: The full test run reported an unhandled `ReferenceError: document is not defined` from `prosemirror-view`'s `DOMObserver.flush`, attributed to `chart-node.test.ts`, while that file passed on its own.
- **Root Cause**: Editors created in a test and never destroyed keep ProseMirror's DOM observer timers. Under load, a timer fires after the file's jsdom environment is torn down.
- **Solution / Workaround**: Destroy every editor a test creates. `chart-node.test.ts` tracks them in an `afterEach`.

### [core/chart] Don't Recover a Category Index From a Pixel

- **Issue / Symptom**: With `xAxis.reverse`, stacked areas filled down to the wrong series' baseline.
- **Root Cause**: The area layout turned each point's x pixel back into a category index (`(c - catStart) / band - 0.5`), which assumes categories run left to right.
- **Solution / Workaround**: Points carry their index (`Pt.i`) and everything maps index → pixel through `catCenter(i)` (which handles reversing, and fractional indexes for trendlines). Never invert pixels to find data.

### [core/chart] Straight Trendlines Need Sampling on a Log Axis

- **Issue / Symptom**: A linear trendline vanished on a logarithmic value axis whenever one end of it went to 0 or below.
- **Root Cause**: Linear fits were drawn from two samples (the ends). On a log axis the line is a curve, and an end with no pixel (value ≤ 0 → NaN) was dropped, leaving one point and no path.
- **Solution / Workaround**: `drawTrendlines` samples linear fits like the others (200 steps) when either axis is logarithmic and drops samples with non-finite pixels. Value → pixel on log axes goes through `chartScaleToPixel`, which returns NaN for values ≤ 0; `ScaleInfo.px` clamps those to the lower end instead, so bars and area baselines still start at the bottom.

### [core/chart] Property Tests: Series Names Can Be the Text "NaN"

- **Issue / Symptom**: Adding new random steps to `chart-property.test.ts` made a seed fail with `NaN` in the SVG, although every mark was finite.
- **Root Cause**: The extra steps shifted the random sequence; a paste then named a series `NaN` (junk cell text), which the SVG legend and `<desc>` write verbatim. The test searched the whole SVG for `NaN|Infinity`.
- **Solution / Workaround**: Check geometry attributes only (`x=`, `y=`, `d=`, `cx=`, `width=`, …). When adding steps to the property test, expect other seeds to explore new paths and read the failure before assuming the new feature is at fault.

### [core/chart] A Chart SVG Drawn to a Canvas Comes Out Black

- **Issue / Symptom**: A PNG made from a live chart's SVG (or `chartToSvg` with `CSS_VARIABLE_CHART_THEME`) had black text, axes and grid lines, and a serif font, although the chart looked right on the page.
- **Root Cause**: An SVG loaded through an `<img>` (which is how it reaches a canvas) is a separate document: the page's stylesheets and custom properties do not apply. `fill="var(--foreground, #0f172a)"` then has no `--foreground`, and some browsers treat `var()` in a presentation attribute as invalid outright, falling back to the initial paint (black). `currentColor` and `font-family="inherit"` have nothing to inherit either.
- **Solution / Workaround**: Run `resolveChartSvgPaints(svg, { scope })` before drawing (`rasterizeChartSvg` does): it replaces `var()` with the custom property's computed value on `scope` (or the fallback), `currentColor` with the scope's colour and `inherit` fonts with its font, and drops attributes left empty. Pass the chart's container as `scope` when the theme is scoped to a wrapper (e.g. `.dark`). Agent tools render with `DEFAULT_CHART_THEME` (concrete colours), so their PNGs do not depend on the page. jsdom has no canvas: tests stub `getContext`, `toDataURL` and `Image`.

### [core/chart] PowerPoint Slide Order Is Not Part-Name Order, and Excel Chartex Hides in `mc:AlternateContent`

- **Issue / Symptom**: Reading `ppt/slides/slideN.xml` by name numbers charts on the wrong slide after slides were reordered; looking for `c:chart` only in an Excel drawing misses waterfall, funnel, treemap, histogram and box charts.
- **Root Cause**: PowerPoint keeps part names when slides move; the order lives in `p:sldIdLst` in `presentation.xml`. Office 2016 charts are `cx:chart` references (chartex namespace, `chartEx` relationship) inside `mc:AlternateContent/mc:Choice`, with a picture or empty `mc:Fallback`.
- **Solution / Workaround**: `extractPptxCharts` walks `p:sldId r:id` in order and numbers slides by position. `extractOfficeCharts` matches any `chart` element in the DrawingML chart, strict chart or chartex namespace (wherever it is nested) and dedupes by target part, so a fallback that also points at a chart is not read twice.

### [core/animation-editor] A Segment's Value Is the Latest One *Started*, Not a Keyframe Track

- **Issue / Symptom**: Treating an animation scene's compiled segments like keyframes (sorting by end, or blending overlapping segments) made entering nodes visible before they entered, and made the Flair export disagree with the editor's own frames.
- **Root Cause**: The animation editor (and Flair's `svgFrame`) give a property the value of the latest segment to have started, holding its `from` before the first one. That is what hides a node until its `enter`. Segments of one command can start later than segments of a command compiled after it (an `enter: "draw"` fades its fill in at 60%), so tracks are not in start order while compiling.
- **Solution / Workaround**: `activeSegment` scans the whole track for the latest start (ties go to the later segment) instead of breaking early, and `compileMotionScene` sorts each track by start once it is done. A `draw` on a stroke with no draw-on yet starts from 0, like an enter.

### [core/animation-editor] Flair's Easings Are Cubic Polynomials, Not CSS Curves

- **Issue / Symptom**: Exported Flair motion was sampled into dozens of 33 ms linear steps for plain moves.
- **Root Cause**: Flair's `out` is `1 − (1 − t)³` and `in-out` the piecewise cubic, which differ from CSS `ease-out` / `ease-in-out` by up to ~7%. Separately, a move animates `x` and `y` as two segments, so an interval had two active segments and fell back to sampling.
- **Solution / Workaround**: The editor's defaults are `MOTION_EASE_OUT` (`cubic-bezier(1/3, 1, 2/3, 1)`, exactly Flair's `out`) and `MOTION_EASE_IN_OUT` (within 1% of Flair's `in-out`). `flairEaseFor` matches a curve to a Flair name within 1%, and the exporter writes one change when every active segment spans the same interval with the same curve.

### [core/animation-editor] Additive Layers Live on Their Own Tracks, Not on the Pose's

- **Issue / Symptom**: A shake that started during a slide cut the slide off: the box jumped back and shook in place. Putting additive deltas on the same track as the pose counted them twice once a later move started from the composed value.
- **Root Cause**: A track's value is its latest *started* segment, and every `from` is read from the track. An offset added in the same place leaks into the next segment's `from`.
- **Solution / Workaround**:
  - Segments with `blend: 'add'` go on `motionAddTrackKey(node, property)` and run from 0 (offsets, turns) or 1 (scales). `withMotionLayers` adds or multiplies every started layer onto the pose.
  - Commands read `from` from the pose track only (`valueAt`), so layers never feed back into it.
  - The overlap check skips add tracks. The Flair export puts layers on the node's transform channel: alone in a stretch they are one exact change, and overlapping the pose they are sampled (Flair has no layers).
  - Emphasis defaults to `add`; `blend: 'replace'` gives the old take-over.

### [core] The Entry-Isolation Test Reads `-import"` in a String as an Import

- **Issue / Symptom**: `tests/entry-isolation.test.ts` reported a third-party package named `, artwork, shots, …` for `/animation-editor` after a default scene name `'flair-import'` was added.
- **Root Cause**: The test scans the built files with a regex for `import … "x"`. Its lookbehind does not exclude `-`, so `"flair-import"` followed by a quote matches as an import of whatever text runs to the next quote.
- **Solution / Workaround**: Don't end string literals in shipped code with `-import` or `-export` (`'from-flair'` is used instead). If such a name is needed, tighten the test's lookbehind to exclude `-`.

### [core/animation-editor] Repeats Are Laid Out as Segments, and a Mirrored Cycle Runs Its Curve Backwards

- **Issue / Symptom**: A mirrored repeat that swapped `from` and `to` played a different curve on the way back (an ease-in came back as an ease-in, not an ease-out). After a repeat, the next command started from the wrong value.
- **Root Cause**: Swapping the ends keeps the ease running forward. Real time reversal shows at `u` what the forward run showed at `1 − u`.
- **Solution / Workaround**:
  - `compileRepeated` compiles one cycle, then copies its segments for each further cycle. Later commands read values through the same tracks, so they start where the repeat ended.
  - A mirrored copy keeps its ends and sets `reverse`: `segmentProgress` evaluates the ease at `1 − u`.
  - The Flair export writes such a copy from its value at the start to its value at the end, with `reverseCubicBezier` (`[1 − x2, 1 − y2, 1 − x1, 1 − y1]`). A reversed spring has no curve, so it is sampled.
  - `offset` adds the cycle's change once per cycle, and only to numbers. Colours and shapes repeat like `loop`.
  - `duration` is one cycle. `motionCommandDuration` includes every repeat, and `motionCycleDuration` is one.

### [core/animation-editor] `match` Morphs Parts, So the `into` Group Stays Hidden and Its Extra Parts Never Show

- **Issue / Symptom**: After a `match`, parts that only the end state has (a new avatar, say) were missing. The `into` group, if visible, sat on top of the target the whole time.
- **Root Cause**: `match` morphs each part of the target into its partner (shape, paint and place, as `morph` does) and fades out parts with no partner. Nothing of `into` is drawn: it is a description of the end state.
- **Solution / Workaround**: Keep `into` hidden (`visible: false`). For every part the end state adds, put a partner in the target with the same name or id, which can start tiny or with no fill. `check` reports `match-unpaired` (a note) for parts of `into` with no partner, and `match-self` when one group holds the other.

### [core/animation-editor] Flair's Click Trigger Plays Nothing Until the First Click, Then Steps 0 and 1 Together

- **Issue / Symptom**: The first click-trigger export put shot 0 on step 0, expecting it to play on load. In Flair's player (checked in a browser with 0.40) nothing played on load, and the first click played shots 0 and 1 together. A hover-triggered scene with several steps would play only its first.
- **Root Cause**: A triggered `SvgPlayer` does not autoplay. It draws time 0 and waits. Each click (`advance`) records a step start at the current time and plays. Step 0 starts at time 0, which the first click is also at, so steps 0 and 1 start together. After the last step a click goes back to step 1. Hover, press and scroll ignore steps altogether.
- **Solution / Workaround**:
  - For `click`, `toFlairSvgMotion` puts shot n on step n + 1 (each change's `delay` measured from its shot's start) and leaves step 0 empty. Each click plays one shot, and after the last the first plays again. Other triggers keep everything on step 0.
  - For a toggle, make the last shot put things back the way the scene starts.
  - Importing a click effect (`clickSteps`) folds step 0 into the first shot, the way Flair plays it.
  - The checks note a looped triggered scene (`trigger-loop`), a one-shot click scene (`click-one-shot`) and cues on click (`click-cue`, since clicks decide when shots start).
  - Flair's `EffectDocument` has no trigger, so `toFlairEffectDocument` keeps the steps but plays through.

### [core/animation-editor] Stroke Order Puts `drawEnd` on Each Path, and a Group's Own `drawEnd` Overrides It

- **Issue / Symptom**: A group drawn on in sequence, then drawn again with a plain `draw` on the group, ignored the per-stroke timing. Checks warned "enters while it is already showing" for a group whose strokes were each still undrawn.
- **Root Cause**: With `order`, `pace` or `comet`, `drawEnd` (and `drawStart`) segments go on each path, not on the group. Frames visit children first, then apply the group's own `drawEnd` to every path in it, replacing a child's trim.
- **Solution / Workaround**:
  - Draw a group either per stroke (with an order) or as a whole; don't mix them in one scene.
  - `visibleAt` counts a group as drawn when its own `drawEnd` and at least one stroke's are above zero.
  - The Flair export finds the owning node per path, so per-stroke windows export as exact `draw` changes. A comet's tail (`drawStart`) does not export, because Flair draws from the start of the path. Lottie writes it as the trim's start.

### [core/animation-editor] Averaging Frames in SVG Needs `plus-lighter`, Not Stacked Opacity

- **Issue / Symptom**: Motion blur made by stacking N frames at opacity 1/N came out too faint and tinted towards the first frame. A running average (layer k at 1/(k+1)) was right on an opaque background, but wrong wherever frames are transparent: a shape in only the first layer stayed fully opaque.
- **Root Cause**: The normal "over" composite is not a sum, so N layers at 1/N do not average.
- **Solution / Workaround**:
  - `motionStageSvg` adds the moments with `mix-blend-mode: plus-lighter`, each at opacity 1/N, inside an `isolation: isolate` group. That is an exact average of premultiplied colour, transparency included.
  - The background is drawn once underneath. Compositing is linear, so this equals the average of whole frames.
  - Element ids stay on the last moment only.
  - Exports (Flair, Lottie) and `motionFrameToSvg` stay sharp; the exporters note it.

### [core/animation-editor] Emphasis Behaviours Must Match Flair Number for Number

- **Issue / Symptom**: An exported wiggle or shake would play differently in Flair from the editor's preview, even though both "wiggle with seed 3".
- **Root Cause**: Flair plays an `SvgAnimation.behavior` (Flair ≥ 0.38) by swinging every number in the value from `from` towards `to` by `behaviorProgress`. A wriggle wanders each number on its own noise channel, keyed by that number's position in the value. The editor can't import Flair (Flair depends on the editor), so it carries its own copy of the maths (`animation/behavior.ts`: SplitMix64 hashing, quintic value noise, FNV-1a seeds from ids).
- **Solution / Workaround**:
  - Keep `animation/behavior.ts` identical to Flair's `vector/motion.ts`, `scene/behavior.ts` and `time/noise.ts`. `tests/animation-behavior.test.ts` pins values computed by Flair's own code; recompute them when Flair changes.
  - Emphasis segments store the peak in `to` (a pulse's swollen scale, a shake's far point) and a `behavior`. The exporter sends `to` with behaviours ignored (`trackValue(…, raw)`).
  - `MotionSegment.index` must match the number's position in the exported transform `translate(dx dy) rotate(r cx cy) …`: x is 0, y is 1 and the angle is 2. If the transform string's order changes, change the indices too.
  - A behaviour exports as one change only when every segment active over that interval shares the same span, ease and behaviour. Otherwise it is sampled.

### [core/animation-editor] Reveal Clips Live on the Frame, Not in the Vector Model

- **Issue / Symptom**: `wipe`, `iris` and `split` (Flair's `entrance.wipe` / `iris` / `split` and `exit.wipe`) need a clip path, but a frame is a `VectorDocument`, which has no clips. Clipping in document units would also disagree with Flair as soon as the node moves or scales.
- **Root Cause**: Flair reveals through a `<clipPath clipPathUnits="objectBoundingBox">` on a wrapper group, so the clip is in the units of the wrapped element's current box (0–1 across it) and follows the element. Its padding (`stroke reach / box + 0.02`, at most 1) is a share of the box, and a box with no width or height (a lone straight line) cannot be clipped.
- **Solution / Workaround**:
  - The clip rides beside the document: `clipRect` (`[x, y, width, height]`) and `clipCircle` (`[cx, cy, r]`) tracks in unit-box space, rounded to 4 places like Flair's `clipParts`, and `MotionFrame.clips` by node id. `motionFrameToSvg` (and so both `<AnimationStage>`s) writes the wrapper through `vectorDocumentToSvg`'s `wrap` option. Anything that draws a `MotionFrame` without `motionFrameToSvg` must apply `clips` itself.
  - The Flair export writes the same wrappers (`<id>--reveal`, `<id>--iris`, clip `…-clip`, shape `…-clip-shape`) and animates only the shape attributes that change. Clip wrappers sit outside the follow wrappers, so the box they measure is the node as it moves, as in the editor.
  - A clip stays after its reveal (open, or shut after a wipe out). Every `enter` opens leftover clips at once, and a reveal sets opacity at its start, or a later fade in (whose `from` holds back to time 0) would hide it all along.
  - A reveal of a node with no box fades instead, and `checkMotionScene` warns `reveal-no-box`.

### [core/animation-editor] Follows Are Measured in the Parent's Units, and Offsets Turn With Them

- **Issue / Symptom**: A follow was sampled into dozens of transform steps for Flair, and a follow inside a rotated or scaled group turned to the wrong angle.
- **Root Cause**: Flair's `along` moves a wrapper by `translate(point) rotate(angle)` measured on the path's own `d` (`getPointAtLength`), in the units of the wrapper's parent. The editor measured length and angle in document space and added the follow to the node's own offset, so an offset made during an oriented follow did not turn with the path as it does under Flair's wrapper.
- **Solution / Workaround**: `motionFollowRoute` maps the path into the node's parent's units and the follow is measured there. `motionNodeOffset` composes scale, turn and offset about the centre, then `translate(−centre)`, the path's turn and the point, the same as Flair's `<id>--follow` / `<id>--follow-centre` wrappers. The export writes the route as a `<defs>` path in those units (so a hidden path, or one in another group, still works) and one `along` per follow. Overshooting eases on an oriented follow are sampled: past the path's ends Flair measures no direction and stops turning.

### [core/animation-editor] Back Eases Cannot Go to Flair on Colours or Opacity

- **Issue / Symptom**: Writing an overshooting cubic-bezier (`ease-out-back`, `ease-in-back`, any curve with `y1` or `y2` outside 0–1) as a Flair `ease` tuple on a `fill` / `stroke` change would make Flair produce invalid hex colours, and on opacity or draw-on it would disagree with the editor.
- **Root Cause**: Flair's `lerpAttr` blends hex channels with the eased progress unclamped, so a progress past 1 or below 0 gives channel values outside 0–255. The editor clamps opacity and draw-on to 0–1 when it evaluates them.
- **Solution / Workaround**: `toFlairSvgMotion` only writes an overshooting curve on channels that extrapolate the same in both (transforms and the camera `view`); elsewhere it samples. Curves that stay in 0–1 (`ease-in`, `ease`, …) are written as tuples on every channel.

### [svelte] `role="listitem"` on a `<button>` Is an a11y Warning

- **Issue / Symptom**: `svelte-check` / vite-plugin-svelte warns `a11y_no_interactive_element_to_noninteractive_role` for a list of shot buttons.
- **Root Cause**: Svelte refuses non-interactive roles on interactive elements.
- **Solution / Workaround**: Wrap the buttons in `role="group"` with an `aria-label` and leave the buttons' own role alone (React matches it for parity).

### [monorepo/release] A Release That Fails Part-Way Can Publish Versions Whose Changelog Lands Later

- **Issue / Symptom**: After #152 merged, the Release run succeeded but printed "No unpublished projects to publish". npm's `@pixerate/editor@0.54.0` lacked `/animation-editor`, although `main`'s CHANGELOG for 0.54.0 lists it.
- **Root Cause**: The Release run for #151 versioned and published the packages, then failed ("Some packages failed to publish") before it pushed its `chore(release)` commit. `main` kept the pending changesets, so the next run computed the same versions from them, folded in #152's changeset, and found 0.54.0 / 0.41.0 / 0.49.0 already on npm.
- **Solution / Workaround**: After a failed Release, compare `npm view @pixerate/editor version` with `main`'s `packages/core/package.json`. If npm has a version that `main` has not committed yet, merge a new changeset so the next release bumps past it. Check what was published with `npm view @pixerate/editor@<version> exports`.
- **It also happened from a race (#154 / #155)**: #154's release published 0.56.0, but #155 merged while that release was running, so pushing its version commit was rejected (non-fast-forward). The push step ended in `|| echo "Failed to push tags"`, so the run still showed green. #155's release then recomputed 0.56.0 and failed with `E409 Cannot publish over previously staged version`. An extra changeset doesn't help here: changesets merges every pending minor into one bump, giving the same version again. The fix was to commit #154's version bump on its own, keeping #155's changeset pending.
- **Since then**: the release workflow pushes the version commit to `main` *before* publishing, rebasing onto merges that landed meanwhile and failing loudly if it can't. It also refuses to publish when a version `main` hasn't recorded is already on npm.

### [core/canvas] Self-Registering Modules Are Dropped Because the Package Is `sideEffects: false`

- **Issue / Symptom**: A module that only calls `registerFamilyScene(...)` at import time (and exports nothing anyone uses) works in tests but draws nothing in an app build: the family falls back to plain boxes.
- **Root Cause**: `packages/core/package.json` declares `"sideEffects": false`, so consumers' bundlers may drop any module whose exports are unused, together with its top-level registration call. Family *layouts* are safe only because `diagram/registry.ts` imports each adapter module for its exported adapter, which keeps the module (and its `registerFamilyLayout` call).
- **Solution / Workaround**: Family scenes export a function each (`pieScene`, `ganttScene`, …) and `canvas/mermaid/families/index.ts` collects them in `BUILTIN_FAMILY_SCENES`, which `scene.ts` imports to seed its registry. Keep new built-in registries static like this; reserve `register*` for hosts adding their own.

### [core/diagram] Tests That Parse Mermaid With Titles Need the jsdom Environment

- **Issue / Symptom**: Ported Ursula tests failed with `TypeError: DOMPurify.sanitize is not a function` inside Mermaid's `setDiagramTitle` (pie, quadrant, C4, gitGraph…), while flowchart tests passed.
- **Root Cause**: Mermaid sanitises titles and labels with DOMPurify, which needs a `window`. Ursula ran every test under jsdom from its vitest config; core's config uses the Node environment, and flowchart parsing happens to skip the sanitiser.
- **Solution / Workaround**: Start any test that calls Mermaid (`expectValidMermaid`, `mermaidDb`, `mermaidSummary`) with `// @vitest-environment jsdom`.

### [core/diagram] `pie` Is No Longer a Text-Only Example

- **Issue / Symptom**: Tests and examples that used `pie` to show "this family is kept as text" (validation refusals, `render_diagram` refusals, `<MermaidThumbnail fallback>`) started failing once the statement adapters were ported.
- **Root Cause**: Pie, mindmap, quadrant, C4, architecture, sequence, gitGraph, Gantt, timeline, journey, XY and radar are now `editable` and drawn as scenes.
- **Solution / Workaround**: Use `sankey-beta` (or block, packet, kanban, treemap) as the render-only example.

### [core/animation-editor] lottie-web Ignores `hd: true` on Shape Groups

- **Issue / Symptom**: A hidden node (`visible: false`, such as the demo's "arc" follow route) showed up in the Export Lottie preview, though the editor's own stage never draws it.
- **Root Cause**: `toLottie` wrote each node as a `gr` group and marked hidden ones `hd: true`. lottie-web 5.12 honours `hd` only on paths, fills and strokes; for a `gr` it builds and draws the children anyway.
- **Solution / Workaround**: Leave hidden nodes out of the file. Nothing in a Lottie file refers to another shape by id: follows and morphs are sampled into keyframes from the scene, so a hidden route or morph target is not needed in the output. To hide a shape you must keep, set its transform opacity to 0 instead of relying on `hd`.

### [core/agent] A Tool Missing From the Agent-Skills Test Because It Only Registers in a Browser

- **Issue / Symptom**: `tests/agent-skills.test.ts` passed while `pixerate-chart` listed `import_chart_ooxml` only in prose; with the tool in a table row the test reported it as stale.
- **Root Cause**: Some providers add tools only when a global is present (`createChartToolProvider` registers `import_chart_ooxml` only when a `DOMParser` exists). Vitest runs core in Node, so the tool list the test builds lacked it. The per-skill tests are also generated by `describe.each` at collection time, before any `beforeAll`, so a DOM set up in `beforeAll` is too late.
- **Solution / Workaround**: The test sets up jsdom (`document`, `window`, `Node`, `DOMParser`) at module level, so it sees the tool list a browser host gets. If a new tool depends on another browser global, provide that global there too, and give the tool a table row like any other.

### [core/image-editor] PSD Blend Keys and Other 4-Character Codes Can End in Spaces

- **Issue / Symptom**: An exported PSD with a Multiply layer could not be reopened: "Unexpected end of data reading a 32768-byte section". Every byte after the blend mode was shifted by one.
- **Root Cause**: Photoshop's keys are always 4 bytes, and several end in a space (`mul `, `div `, `hue `, `sat `, `lum `, and descriptor keys like `Rd  `, `Bl  `). The map had `mul` without the space, so the record was 1 byte short.
- **Solution / Workaround**: Keep the spaces in every key table. `writeLayerRecord` now refuses a blend key that is not 4 characters, so a typo fails at export with the key named.

### [core/image-editor] Photoshop's Merged Image Is Matted Over White

- **Issue / Symptom**: Partly transparent pixels of a PSD's merged image read lighter than the layers composite to (a red layer at 80 % read as `255, 51, 51, 204`, not `255, 0, 0, 204`), and our exported merged image looked darker in viewers that use it.
- **Root Cause**: Photoshop stores the merged image's colour blended over white where it is transparent (`c × a + 255 × (1 − a)`). The PSD spec does not say so.
- **Solution / Workaround**: `matteWhite` before writing the merged image, `unmatteWhite` after reading one with alpha (`psd/pixels.ts`). Without a merged alpha channel the file is simply flattened over white; compare against our composite flattened the same way.

### [react] jsdom Cannot Build a Blob From Node's Typed Arrays

- **Issue / Symptom**: "Cannot read properties of undefined (reading '_buffer')" when the LayersPanel's Export PSD ran in a jsdom test.
- **Root Cause**: Vitest's jsdom environment gives `Blob` from jsdom but `Uint8Array` from Node, and jsdom's Blob only accepts its own realm's buffers. `URL.createObjectURL` exists (it is Node's), so `downloadPsd` took the browser branch.
- **Solution / Workaround**: In tests, set `URL.createObjectURL` to `undefined` around the click so `downloadPsd` skips the download and only returns the warnings, then restore it. Browsers are unaffected.

### [svelte/tests] Vitest 5 Makes `globalThis.document` Read-Only

- **Issue / Symptom**: After the vitest 4 → 5 upgrade, Svelte tests that build their own JSDOM fail before running: `TypeError: Cannot set property document of [object Window] which has only a getter`.
- **Root Cause**: Vitest 5's test environment defines `document` and `window` on the global as getter-only properties, so `globalThis.document = …` throws in strict mode.
- **Solution / Workaround**: Use `vi.stubGlobal("document", dom.window.document)` and `vi.stubGlobal("window", dom.window)` (they redefine the property) instead of assigning. This also works on vitest 4.

### [core/video-editor] A Blend Inside a Compound Clip Must Use the Backdrop's Alpha in ffmpeg

- **Issue / Symptom**: Built the obvious way, a `multiply` (or any non-normal) clip inside a nested sequence comes out black in the export wherever nothing else in the sequence is beneath it, while the preview shows the clip's own colour there.
- **Root Cause**: A sequence is built as a sub-graph on a transparent frame (`color=black@0,format=yuva420p`). ffmpeg's `blend` filter mixes the colour planes with no regard for alpha, so over a clear backdrop it blends with black. The canvas and CSS follow the compositing spec: the blended colour is `(1 − αb) × layer + αb × B(backdrop, layer)`, so where the backdrop is clear the layer shows unblended.
- **Solution / Workaround**: Inside a sequence (`scope.within.length > 0` in `buildFfmpeg`), the blend result gets the backdrop's alpha (`alphaextract` + `alphamerge`) and is overlaid on an opaque copy of the layer before the layer's own alpha is applied. At the top level the backdrop is opaque, so the graph is unchanged there. `overlay` itself needs no help: on a main input with alpha it un-premultiplies, so laying layers on a transparent base gives straight-alpha "over", the same as the canvas.

### [core/video-editor] SVG Groups for Compound Clips Need `isolation: isolate`

- **Issue / Symptom**: Without it, a screened clip inside a compound clip lightens the picture beneath the compound in SVG frames, not just the compound's own layers.
- **Root Cause**: `mix-blend-mode` blends with everything behind it up to the nearest isolated group. A plain `<g>` is not isolated unless something on it (opacity < 1, a filter, a blend mode) creates a stacking context, so a compound at full opacity with no grade let its children blend through.
- **Solution / Workaround**: `videoFrameToSvg` always puts `isolation:isolate` on a compound's `<g>`. The canvas does the same by drawing the compound's layers on their own scratch canvas.

### [core/video-editor] One Scratch Canvas Is Not Enough Once Groups Nest

- **Issue / Symptom**: With one shared offscreen canvas, a LUT layer inside a compound (or a compound inside a compound) would clear the very canvas its parent compound is being drawn on.
- **Root Cause**: `drawVideoFrame` needs an offscreen canvas for each compound level being drawn and one for a LUT layer at that level, all at the same time.
- **Solution / Workaround**: `VideoDrawOptions.scratch(width, height, slot)` takes a slot: `2 × depth` for a compound's layers and `2 × depth + 1` for a LUT layer at that depth. Return one canvas per slot (`VideoPreviewEngine` keeps a map). A host scratch that ignores the slot still works for LUTs on projects without compounds.

### [core/video-editor] Layers and Sounds Inside Compounds Are Keyed by Clip Path

- **Issue / Symptom**: Keyed by the inner clip's own id, two compound clips playing the same sequence at once would fight over one `<video>` element in the preview (seeking it back and forth every frame).
- **Root Cause**: The preview keeps one media element per `layer.clip` / `audio.clip`. A sequence's clip ids are unique, but the same sequence can play in two places at once.
- **Solution / Workaround**: `videoFrameAt` names nested layers and sounds by the path of clip ids from the project's own track (`comp/inner`, `comp/mid/shot`). Use `videoFrameLeafLayers` to walk a frame's pictures with compounds opened up (the preview and `videoFrameRequestsAt` do).

### [core/paint] Pigment Mixing: Newton Stalls on Dark Saturated Colours, and Pure Primaries Tint Slowly

- **Issue / Symptom**: (1) Building the pigment spectrum table, a few lattice nodes (very dark pure blues and reds) came back with the wrong colour, up to 22 levels off, and some greys turned black after a "fix". (2) Pure sRGB red mixed 1:1 with white gives a coral `#ff3f37`, not a pastel pink, and a 0.1 % touch of yellow visibly shifts pure blue.
- **Root Cause**: (1) The sigmoid-polynomial fit (`R = ½ + z/2√(1+z²)`, z quadratic in λ) needs very large coefficients near the gamut edge. Warm-starting from a saturated neighbour, or from a flat grey, leaves damped Newton where the gradient vanishes. A "dimming" continuation that started at full brightness broke greys, because a grey's coefficients go to ±∞ at white. (2) Reproducing a pure sRGB primary exactly needs reflectance troughs near 0.004. Their K/S is above 100, so they dominate any mix. K/S also has a square-root slope where a band reflects fully, so a little of a paint that absorbs that band moves the mix fast.
- **Solution / Workaround**: (1) `fitNode` tries the neighbour start, then a flat-grey start, then a dimming continuation from half brightness. It keeps whichever fits closest. A few very dark reds and purples still miss by up to 3 levels, and the round-trip test bound is 3.5/255. (2) This is how Kubelka-Munk behaves with ideal colorants, so it is not a bug. Real paint colours (`#e32636`, not `#ff0000`) tint more gently. Give white a higher `strength` for faster tints. Don't "fix" it by raising the reflectance floor: that breaks the round trip of saturated colours. Don't add an RGB residual either: that is the design Mixbox uses, and we stay clear of it.

### [core/raster] The Pigment Blend Mode Is Not a `B(Cb, Cs)` Function

- **Issue / Symptom**: Adding `pigment` like the other modes (a `blendChannel` / `blendRgb` case) gives the wrong result at any opacity below 100 %: blue over yellow at 50 % comes out grey-ish, not green, and it changes with the backdrop alpha in odd ways.
- **Root Cause**: Every other mode computes `B(Cb, Cs)` and then mixes it with the backdrop linearly, `(1 − α)·Cb + α·B`. Paint mixing is the non-linear part itself: the interpolation has to happen in K/S space, so no choice of `B` gives it. `isSeparableBlendMode` must also say false, or the compositor would use its per-channel LUT.
- **Solution / Workaround**: `blendPixel`, `blendTile` (compositor), `blendImageData`, the brush and adjustment layers special-case `pigment`: `Co = lerpPigment(Cb, Cs, αs / αo)` with the usual `αo = αs + αb(1 − αs)` (over an opaque backdrop the share is just `αs`; over a clear one it is the source). `blendRgb('pigment')` returns `Cs` and must not be used for it. The 8-bit paths go through `mixPigment8`, which caches K/S per packed RGB (cleared at 16 384 colours); a 1024² layer over random noise costs about 0.2–0.75 s against 15 ms for Normal, so keep the dirty rectangles tight. PSD has no such mode: `toPsd` warns and `exportPsd` writes `norm` (`BLEND_TO_PSD` is `Partial`).

### [core/raster] A Running-Sum Blur Is Not Exactly Zero After It Passes a Shape

- **Issue / Symptom**: A drop shadow with Noise speckled whole rows of the canvas far from the shape, and a tiled render differed from a whole-image render by up to 53 levels.
- **Root Cause**: The effect blur is two box passes as running sums (`inner += next - leaving`). After the window leaves a shape the sum is about 1e-16, not 0. Noise adds speckle to any coverage above 0, so it lit up that residue. The residue runs to the end of the row, so how far it reaches depends on where the map's region ends.
- **Solution / Workaround**: `tentLine` (`raster/effects/render.ts`) flushes values below `BLUR_EPS` (1e-7) to 0, and `noise` skips coverage at or below it. Keep both if you change the blur. Effects with noise also count as non-local in `effectsAreLocal`. The running sums are now also exact (inputs rounded to multiples of 2⁻³², `BLUR_FIX`), so a blurred value no longer depends on where its line starts; see "Patched Effect Maps Must Equal a Full Build".

### [core/raster] Chiselled Bevels Streak When Distances Go to Pixel Centres

- **Issue / Symptom**: Chisel Hard and Soft bevels and embosses on round shapes showed radial streaks, worst on the outside half of an emboss.
- **Root Cause**: The exact distance transform measures to the nearest covered pixel's centre. Its gradient jumps at the Voronoi cell borders of those centres, and the chisel lights the height map by its gradient, so every border shows as a streak. Placing the edge by coverage (`d - (a - 0.5)`) moves each cell but keeps the borders.
- **Solution / Workaround**: `edgeDistances` measures to the straight edge through the nearest edge pixel: its normal is the coverage gradient (Sobel) there, and its position is the pixel's coverage. Smooth bevels blur the shape and do not need this. Photocraft solves it with a fuller sharp-edge refinement that was not ported.

### [core/raster] Layer Effects Read Pixels Beyond the Tile, So Tile Signatures and Dirty Rects Must Grow

- **Issue / Symptom**: A shadow cast into a neighbouring tile did not update after a stroke near the tile edge, and a tile with no layer pixels never showed the shadow at all.
- **Root Cause**: The compositor caches a tile by the surface tiles it reads and recomposites only inside `dirty` rectangles. A layer with effects changes pixels up to its effects' reach (`effectsMargin`) away from its own pixels.
- **Solution / Workaround**: Effect maps are built once over the layer's region (its bounds grown by the margin) and cropped per tile, so tiles always match a whole-image render. `effectSig` reads the layer's tiles within the margin around the tile, or the whole region when an effect is laid out over the layer's bounds (aligned gradients, gradient strokes, linked patterns, noise). `compositeTiles` grows every dirty rectangle by the stack's largest margin. Do not put the region rect into a local stack's signature: the region grows as you paint elsewhere, and every tile would recomposite.

### [core/raster] Patched Effect Maps Must Equal a Full Build

- **Issue / Symptom**: Rebuilding a layer's effect maps over its whole region on every stroke update cost about 200 ms for a 2000 × 2000 layer with a drop shadow (about 700 ms with a stroke and a bevel as well). Rebuilding only a window around the change and pasting it in can differ from a full build in three ways: the window's edge acts as the shape's edge, the blur's running sums pick up different float rounding from a different start, and neighbouring tiles still recomposite in full.
- **Root Cause**: A local effect map pixel depends only on the shape within `effectsMargin`, so pixels near the window's edge are wrong. A running sum's float error depends on every value since the start of the line. That is usually far below a byte, but a contour LUT lookup right at an index boundary can flip one. A tile next to the change reads it within the margin, so its signature changes. It then had no part in the `dirty` rects and was recomposited whole.
- **Solution / Workaround**: `patchEffectMaps` rebuilds the map pixels within the margin of each change (plus any part of the region that is new) from a window grown by the margin again (twice the margin around the change), and pastes only the inner part. `tentLine` sums fixed-point integers (`BLUR_FIX`), so the sums are exact wherever a line starts. The compositor finds the change from the per-tile shape signatures it keeps with the maps, narrowed to the call's `dirty` rects when the maps are from the previous call and the layer is a plain pixel layer (filters and feathered or parametric masks spread a change beyond `dirty`). It falls back to a full build for non-local effects, reaches past `MAX_EFFECT_REACH`, or windows covering half the region. A tile that has no part in the grown `dirty` rects keeps its pixels when its entry is from the previous call and every step whose signature changed is a pixel layer with local effects (`changedOnlyNearby`). Without that last check, tiles that a far change does alter (an aligned gradient over the layer's bounds, a spatial filter, a feathered mask) would go stale. Distance maps far from the shape can still hold different values (a window sees no site beyond itself), but they are past every effect's reach, so the painted result is the same. Test any new effect with the incremental painting test in `raster-effects.test.ts`.

### [core/raster] The Raster Isolation Test Rejects the Word "document" in Strings

- **Issue / Symptom**: `raster-module.test.ts` failed on `effects/model.ts` with "expected true to be false", and no import was wrong.
- **Root Cause**: The test strips comments, then looks for `document`, `window` and canvas globals anywhere in the source, string literals included. An error message saying "a document pattern" matched.
- **Solution / Workaround**: Word user-facing strings in `src/raster` without those words, or say "file" instead. Comments are fine.

### [core/paint] Mixer Brush: Strokes Paint Into Live Tiles, and Full Flow Drifts to the Loaded Colour

- **Issue / Symptom**: (1) A Mixer Brush stroke built on the brush's `CoverageMap` never smeared: every dab picked up the pre-stroke pixels, so a wet brush could not drag colour along. Painting into live tile buffers in place then left the canvas showing the old pixels mid-stroke. (2) With `flow` 1, a blue brush dragged through yellow in pigment mode came out teal, not green, and RGB mode looked almost the same as a plain brush.
- **Root Cause**: (1) The brush composites the stroke's coverage once over the pre-stroke pixels, which is right for a brush (dabs never exceed the opacity) and wrong for a mixer, whose dabs must read what earlier dabs laid down. The raster compositor's cache signatures compare `Tile` objects by identity, so mutating `tile.data` in place is invisible to it. (2) At full flow each dab covers what is under it, so the next dab's pickup mostly sees the brush's own paint and the mix settles towards the reservoir colour.
- **Solution / Workaround**: (1) `MixerStroke` paints dab by dab through a `MixerTarget` (`readTile` / `writeTile`). `PaintStrokeSession` copies a base tile on first write and, at each update, wraps every tile written since the last update in a new `Tile` object before handing the surface to `_strokeUpdate`. Never mutate a tile that came from a committed surface or the shared uniform-tile cache. (2) This is the model, not a bug: use a flow around 0.3–0.6 for blending (the skill says so). The pigment test uses flow 0.5 and checks the hue lands in the greens.

### [core/image-editor] Compare PSD Effects by What They Render, Not by Bytes or Ids

- **Issue / Symptom**: An effects block opened from a PSD and saved again unchanged was regenerated, which dropped descriptor keys we do not model. Or an edited effect was written back as the stale original.
- **Root Cause**: Export decides between the original block and a regenerated one by comparing the effects. Parsing gives every effect a fresh id. JSON round trips drop `undefined` fields. Object key order depends on who built the object.
- **Solution / Workaround**: `exportPsd` re-parses the stored block and compares `effectsFingerprint` of both sides. The fingerprint ignores ids and `psd`, sorts keys and skips `undefined`. Anything else that can differ without changing the render must be normalised the same way on both sides. Photoshop's `lmfx` (several instances per kind) wins over `lfx2` on read. We always write `lfx2` (`lfxs` on groups) with the `…Multi` keys, and pad odd-length blocks inside their length.

### [demo/image-editor] The Demo Shows a Crop by Default, So Edge Effects Look Missing

- **Issue / Symptom**: In the demo's Image tab, an inner glow or inner stroke on the Background showed on the top and left edges only. The new effects section was also missing until the packages were rebuilt.
- **Root Cause**: The sample photo opens with a freeform crop over part of the image, so the right and bottom edges in view are the crop's, not the layer's, and effects are drawn at the layer's edges. Separately, the demo imports `@pixerate/editor-react` and `@pixerate/editor` from their `dist`, so a running dev server shows the last build.
- **Solution / Workaround**: Clear the crop (Transform & Crop › Clear Crop) before judging effects at the image edges. Run `pnpm --filter @pixerate/editor --filter @pixerate/editor-react build` and reload after changing the packages.

### [core/raster] Free Transform Previews Are Bound by Writing Pixels, Not by Sampling

- **Issue / Symptom**: Dragging a Free Transform handle on a 4000 × 3000 layer took 200–700 ms per update even with one sample per 4 × 4 block, so the preview lagged far behind the pointer.
- **Root Cause**: Each update read the full-resolution source into float windows for every destination tile, and then copied each block sample into the output with small `TypedArray.fill` calls (about three million per update). Sampling itself was a small part of the cost.
- **Solution / Workaround**: A `FreeTransformSession` keeps a box-reduced copy of each moving surface per preview factor (`reduceSurface`) and transforms that through the map composed with the scale, so a preview at 25 % reads a sixteenth of the pixels. `transformSurface` with `step` samples one block row first, then writes packed 32-bit pixels down the block rows. The mesh warp rasterizes only each block's first pixel when previewing. Commit always resamples the full source at full quality. Measure with `RASTER_TRANSFORM_BENCH=1` (`tests/raster-transform.bench.test.ts`).

### [core/raster] The Raster Module May Import Only Itself and `src/geom`

- **Issue / Symptom**: `raster-module.test.ts` rejected `raster/transform.ts` for importing the homography maths.
- **Root Cause**: The isolation test allowed only relative imports inside `src/raster`. The projective maps and warp meshes live in `src/geom`, shared by the vector editor, the image editor and the raster resampler.
- **Solution / Workaround**: The test also accepts imports that resolve into `src/geom`, and checks that `src/geom` imports nothing but itself. Keep `src/geom` free of DOM and editor imports. The vector modules re-export the moved functions under their old `vector…` names, so their API is unchanged.

### [core/image-editor] Layer Pixels and Masks Are in Layer Space, So a Transform Must Be Conjugated by the Offset

- **Issue / Symptom**: A layer moved with `offset_layer` jumped when it was transformed, and an unlinked mask moved with its layer.
- **Root Cause**: A pixel layer's surface and its mask are stored in layer space (document = layer + `offset`). The transform's frame and corners are in document pixels.
- **Solution / Workaround**: `FreeTransformSession` resamples each part through `T(offset) · H · T(−offset)` and keeps the offset. `offsetLayer` translates an unlinked mask (`linked: false`) by the opposite move, so it stays where it is in the document. Tests reading pixels must subtract the layer's offset (`pixelAt` in `tests/image-free-transform.test.ts`).

### [core/raster] A Mesh Warp Has No Anti-Aliased Fringe at the Source Edge

- **Issue / Symptom**: The same affine map through `warpSurface` and `transformSurface` differed by up to 255 at the result's border.
- **Root Cause**: `transformSurface` samples up to a pixel past the source rectangle, so the edge pixels are partly covered. `warpSurface` (ported from photocraft) rasterizes triangles of the forward-mapped grid and only fills pixels whose centres fall inside them.
- **Solution / Workaround**: Expected: compare the two only where both are opaque. A warp's edge is a little harder than a transform's.

### [core/image-editor] PSD Mask Flag Bit 0 Means "Unlinked"

- **Issue / Symptom**: Photoshop's mask link (the chain icon) had no field in our model, so an unlinked mask came back linked after a round trip.
- **Root Cause**: The PSD layer-mask flags document bit 0 as "position relative to layer". Photoshop sets it when the mask is unlinked; photocraft reads `linked = flags & 1 == 0`.
- **Solution / Workaround**: `RasterMask.linked === false` maps to `MASK_FLAG_UNLINKED` on import and export, and to `linked: false` in saved documents. Missing means linked.

### [core/image-editor] Free Transform Handles Overlap on a Small Frame, So Hit-Test by Distance

- **Issue / Symptom**: Dragging a corner of a small layer moved the reference point instead of scaling.
- **Root Cause**: The hit tolerance is a fixed number of screen pixels (6), converted to document pixels by the zoom. On a frame a few dozen screen pixels across, the centre reference point and every handle are all within reach, and the reference point was tested first.
- **Solution / Workaround**: `FreeTransformTool.hit` returns the nearest handle within the tolerance, and the reference point only when it is strictly nearer. Ctrl/Cmd+T is reserved by some browsers (a new tab), so the editors also show Free Transform buttons in the Layers, Paint and Select tabs.

### [core/image-editor] The Warp Mesh Lives in the Frame's Own Space, Before the Corner Map

- **Issue / Symptom**: After a perspective, the warp mesh drawn on screen sat a little off the warped pixels near the far edge, and dragging a mesh point after a rotation moved it in the wrong direction.
- **Root Cause**: A Free Transform is a warp of the untransformed frame followed by the corner map (`transformMap`), as in photocraft. The mesh's control points are in the frame's space. Mapping control points through a projective map does not give the Bézier patch of the mapped surface, only a close one, and pointer moves are in document space.
- **Solution / Workaround**: `FreeTransformTool` maps pointer positions into the frame's space through the inverse corner map before `dragWarpMeshPoint` / `pullWarpMesh`, and draws the control points through the corner map. The drawing is exact for affine corners and approximate for perspective, but the resampling always uses the exact composition. Leaving Warp mode keeps the mesh, so a warp and a perspective commit together.

### [core/paint-editor] Procedural Paper Grain Only Tiles With Whole Lattice Periods and an Even Thread Count

- **Issue / Symptom**: Generated paper showed a visible seam every 256 px: fibre and streak patterns (charcoal paper, gesso) broke at the tile edge, and the canvas weave flipped from over to under across it.
- **Root Cause**: Value noise wraps only when every octave's lattice has a whole number of cells across the tile. Stretching the coordinates (`x / stretch`) to make fibres leaves a fractional period. The weave alternates by `(column + row) % 2`, which only lines up with the next tile when the number of threads across it is even.
- **Solution / Workaround**: `TileableNoise` takes separate cell counts per axis (`cellsX`, `cellsY`) instead of a stretch, and the canvas and linen patterns round the thread count to an even number. The paper test checks `at(x + 256, y) === at(x, y)` for every pattern; keep it when you add one.

### [core/paint-editor] A Mixer Brush Preset With a Low Load Runs Dry in a Few Dozen Dabs

- **Issue / Symptom**: The paint editor's Mixer Brush preset painted a short smear at the start of a stroke and then nothing.
- **Root Cause**: The shared Mixer Brush drains its reservoir by `MIXER_DRAIN × (1 − load)` per dab (photocraft's model). At `load` 0.5 that is 4 % a dab, so after 50 dabs (about 100 px of a 30 px brush at 0.08 spacing) 13 % is left.
- **Solution / Workaround**: The preset uses `load` 0.95 and spacing 0.1. Lower loads are right for a brush that should run out (oil paint loading), not for a general mixer. Blender and smudge have no reservoir (`loadsColor: false`), so load does not matter for them.

### [core/paint-editor] A Rotated or Mirrored View Must Turn the Pen's Azimuth and Twist Too

- **Issue / Symptom**: With the canvas view rotated, a tilted pencil shaded in a different direction on screen than with the view upright, and barrel-rotation brushes turned the wrong way when the view was mirrored.
- **Root Cause**: Pointer Events report tilt, azimuth and twist in screen space. The view maps positions to document space, but nothing mapped the pen's orientation.
- **Solution / Workaround**: `pointerToPenPoint(event, x, y, view)` converts tilt to altitude / azimuth and then `viewPenToDocument` subtracts the view rotation (and reflects for mirroring) from the azimuth and twist. Bindings must pass the view; recorded strokes store document-space values, so replays do not depend on the view.

### [core/paint-editor] View-Only Layers Must Stay Out of Exports and the Export Compositor

- **Issue / Symptom**: A tracing image could end up in an exported PNG or PSD, or a preview after a stroke could show stale tracing pixels.
- **Root Cause**: The tracing image is drawn by the shared compositor as a content layer (`ImageNode`) between the paper and the paint. Exports, `pickColor` and `render_preview` use the same stack builder, and a compositor caches tiles by each step's signature, so a stack with the underlay and one without must not share a compositor (see "Dirty Rectangles Are Only Safe on a Compositor That Sees One Stack").
- **Solution / Workaround**: `renderLayers(options, view)` adds `underlayLayers()` only for the viewport (`compositeTiles`, on `viewCompositor`); exports and picks use `exportCompositor` without it. The tracing node's `version` changes whenever its image, placement or the canvas size changes, so its tiles recomposite; its opacity is a normal layer property. Tests check that `compositePixels` never shows the tracing image.

### [core/paint-editor] Perspective Snapping Must Be Applied Before a Stroke Is Recorded

- **Issue / Symptom**: Replaying a stroke painted with perspective snapping wobbled off the guide line, or snapped to a different vanishing point after the guide moved.
- **Root Cause**: A replay feeds the recorded points back in. If the raw pointer samples were recorded, the replay either had to re-snap (to whatever the guide is now) or painted the unsnapped path.
- **Solution / Workaround**: The snapper runs as the session's `inputFilter`, before the samples are painted and pushed to `session.points`, so recordings hold the snapped path and replays never snap. Symmetry is the opposite: the stroke records its raw path plus the copies as affine maps (`copies`), so a varied replay can conjugate them and stay symmetric about the moved centre.

### [react|svelte/paint-editor] Paper Controls Are Undo Steps, So Commit on Release, Not on Every Input

- **Issue / Symptom**: Dragging the paper's grain-depth slider, or the colour picker, in the React paint editor left dozens of "Paper" entries in the undo history.
- **Root Cause**: `setPaper` is one undo step per call. React's `onChange` on a range or colour input fires on every `input` event, not on release. Brush settings are editor state, so updating them live is fine, but paper settings are document state.
- **Solution / Workaround**: `PaintSlider` takes `onCommit`, which runs on the native `change` event (attached with `addEventListener` in React, `onchange` in Svelte), and keeps a local draft value while dragging. `CommitColorInput` does the same for the React colour input. Tests dispatch `input` then `change` and check for exactly one undo step.

### [core/image-editor] A Smart Object's Pixels Are a Cache the Compositor Draws Like a Pixel Layer

- **Issue / Symptom**: A smart object's `surface` looks like a pixel layer's, but painting into it, or changing `placement` / `smartFilters` / `contents` with a plain object spread, leaves the layer showing stale pixels (and the next transform throws the paint away).
- **Root Cause**: `SmartObjectLayer.surface` is the rendered result of contents → placement → smart filters, kept on the layer so the compositor, effects, thumbnails, history and export see it like any pixel layer (the raster engine treats it as one through the `isPixelLike` profile hook). Nothing re-renders it implicitly.
- **Solution / Workaround**: Change smart objects only through the operations in `layers/smart.ts` (`setSmartPlacement`, `replaceContents`, the smart filter functions, `rerender`), which render again. Painting targets `pixels` are refused on smart objects; the filter mask is painted through channel `filter-mask` and re-renders on every update. The render is clipped to the canvas grown by `SMART_RENDER_MARGIN` (512 px), so scaling a smart object up can never hit the resampler's size limit, and smart filters run over the canvas only, like pixel-layer filters (which is what makes a converted pixel layer render byte for byte the same).

### [core/image-editor] Free Transform on a Smart Object Edits Its Placement, in Contents Pixels

- **Issue / Symptom**: Composing a new transform onto a smart object's existing one works for corners, but not for a warp: a Bézier warp of the document after a rotation is not a Bézier warp of the contents, so the placement could not hold it, and chained transforms would have to resample.
- **Root Cause**: A placement is a warp in the contents' own pixels followed by a corner map (the same shape as `FreeTransformGeometry`). A warp drawn over a rotated document box would be a degree-6 surface in contents space.
- **Solution / Workaround**: For a smart object, `FreeTransformSession` starts from the placement itself: `box` is the contents' rectangle (contents pixels), `startGeometry` / `geometry` hold the current corners and warp, and commit writes them back and re-renders from the contents. Relative helpers (`transformLayer`, `flipLayer`, `rotateLayer90`, the options bar) apply their change to `startGeometry`'s corners, not to `identityTransform(box)`. `get_transform_frame` reports `smartObject: true` with the contents' rectangle as the frame, and warp meshes for smart objects are in contents pixels. A linked mask follows a warp-free change by the change's homography; with a warp involved it stays (the result's `moved` says so).

### [core/image-editor] A Placed Layer's Quad Maps the Warp's Box, Not Always the Source Rectangle

- **Issue / Symptom**: A warped smart object from Photoshop came in stretched, and one we wrote back moved when Photoshop re-rendered it.
- **Root Cause**: `SoLd`'s `Trnf` / `nonAffineTransform` quad is where a *frame* lands: the bounding box of a single-patch custom warp's 16 control points (which may spill past the source), else the source rectangle (always the source rectangle for a non-parallelogram quad, as photocraft reads it). `Sz  ` is in document units, which differ from the embedded file's pixels when resolutions differ, and preset warps have their own `bounds`.
- **Solution / Workaround**: `placementFromPlaced` builds the frame first, maps the contents' rectangle through `rectToQuad(frame, quad)` to get our corners, and refits a warp whose bounds are not the contents' rectangle (`fitWarpMesh`, exact for an affine reparameterisation); the importer scales a warp from `Sz` units to the contents' pixels. `soldBytes` / `plldBytes` invert it (`quadFromCorners`). A mesh of several patches cannot be written (`warpNone` plus a warning; the layer's pixels still show it), and Photoshop's newer Cylinder warp is not read.

### [core/image-editor] Photoshop Extends Smart Filter Masks With White

- **Issue / Symptom**: A smart filter mask made from a selection (black outside it) came back from a PSD revealing the filter everywhere outside the selected area.
- **Root Cause**: The filter mask lives in the `FEid` / `FXid` block as a rectangle and a plane; outside the rectangle Photoshop treats it as white (`filterMaskExtendWithWhite`). Writing only the painted bounds of a mask whose default is black loses the black.
- **Solution / Workaround**: `filterMaskItem` writes a mask whose default is not white over the whole canvas (plus anything painted outside it); reading uses default 255. The filter mask's enabled / linked flags are in `filterFX` (`filterMaskEnable`, `filterMaskLinked`), not in the block.

### [core/paint-editor] Live Agent Strokes Run Slower Than Their Point Times With Big Brushes

- **Issue / Symptom**: In the demo, the landscape script's 672 ms soft-pastel stroke (90 px tip on a 1200 × 800 canvas) took about 4 s to paint through `PaintDirector`.
- **Root Cause**: The director pushes the points due in each 16 ms frame and then waits a frame. Each push lays the dabs and re-composites the touched tiles, and React then uploads those tiles. With a big tip this takes longer than a frame, so the wall-clock time adds up beyond the schedule.
- **Solution / Workaround**: Accepted. The result is the same as `paintStroke` with the same seed (tested), and only the pacing differs. Hosts that want strokes to land faster can pass a higher `speed` or a lower `maxStrokeMs`, or leave out the director so strokes apply at once.

### [core/raster] Painterly Blend Modes Reach Every `BLEND_MODES` Consumer, and Tint Must Replace Hue, Not Average It

- **Issue / Symptom**: (1) After adding `watercolor`, `tint`, `highlight` and `shadow` to `BLEND_MODES`, they showed up in the image editor's layer, effect and smart-filter menus and agent enums, and its PSD export silently wrote them as Normal. (2) The first `tint` turned yellow under a blue tint into grey instead of light blue. (3) `watercolor` with a white source changed the backdrop by a level or two.
- **Root Cause**: (1) Those menus and enums are built from `BLEND_MODES` and filter out only `pigment`; `BLEND_TO_PSD` is `Partial`, so any mode without a PSD key falls back to `norm`. (2) Interpolating Oklab `a, b` from the backdrop's towards the source's passes through the neutral axis when the hues are opposite. (3) The spectral uplift round-trips a colour only to within about 3.5/255, so `R_b·R_white` is not exactly `R_b`.
- **Solution / Workaround**: (1) The painterly modes are real `B(Cb, Cs)` functions (`blendRgb` / `blendChannel`), so they work wherever a mode is accepted (compositor, adjustment layers, effects, brushes, canvas fallback); there is nothing to filter. Writers of formats without them must call `standardBlendMode(mode)` (the paint editor's `exportPsd` does, with a warning); the image editor's `toPsd` does not yet. (2) Tint replaces the hue: `ab = ab_s·√(4·L_b·(1 − L_b))`, then cuts chroma (never lightness) into the gamut. (3) `watercolor` short-circuits a white source to the backdrop and a white backdrop to the source, so "white is clear" is exact; other colours are quantised to 8 bits and their spectra cached like `mixPigment8`'s.

### [core/paint] Repeated Small Pigment Mixes Drift Towards the Lighter Paint

- **Issue / Symptom**: Working blue and yellow together 1:1 on the mixing pad with the palette knife came out as a light olive (`#b2b52f`), far from the Kubelka-Munk mix of equal parts (`#5f9746`). Black and white 1:1 gave a light grey instead of a near black.
- **Root Cause**: Two simplifications compound over hundreds of small mixes. (1) The Mixer Brush samples the footprint as an RGB average (`TileMedium.sample`), so a footprint across blue and yellow is already greyish before any pigment maths. (2) Pixels hold only RGB. A mixed colour's scattering is re-estimated from its luminance, not carried as the sum of its parts, so mixing mixtures is not linear in K and S. Dark mixtures are treated as weak, and the light paint wins over time.
- **Solution / Workaround**: Treat brush and knife smearing as the look of mixing, not as a measurement. `MixingPad.mix` (`mix_on_pad`) lays blobs, works them with the knife, and then paints a fully mixed core of `mixPigments` of the parts, so the colour it returns is the true mix. Agents that need a number use `mix_colors`. A carrier that keeps K and S per pixel (the wet layer) can fix the drift for wet media. Don't try to fix it by changing the Mixer Brush's sampling, because that changes every existing Mixer Brush stroke.

### [core/paint-editor] Dab-by-Dab Brushes Need the Opacity Ceiling Applied as Increments

- **Issue / Symptom**: A dab brush given a pick-up ratio or multi-colour (so it paints dab by dab instead of through one coverage buffer) built up to full opacity wherever its dabs overlapped, ignoring the brush opacity. It looked very different from the same brush with pick-up 0.
- **Root Cause**: The dry engine composites the stroke's accumulated coverage once, so overlapping dabs never pass `opacity`. Laying each dab's own coverage at `opacity` composites it again and again.
- **Solution / Workaround**: `PaintDabStroke` keeps a stroke `CoverageMap` for dab brushes. It lays only what each dab adds: `k = (c₁ − c₀)·o / (1 − c₀·o)`. Successive source-over composites with these `k` multiply out to the single composite at `c·o`, so a one-colour Normal stroke matches the dry engine to within rounding (tested at ≤ 3 levels). Other blend modes are applied per increment, which is close to but not exactly the single composite. The Mixer Brush keeps photocraft's per-dab deposit with no ceiling.

### [core/paint] A Smudge Must Pick Up What Was Under It, Not What It Just Laid

- **Issue / Symptom**: Smudge strokes dragged paint across the whole canvas whatever `length` was set to.
- **Root Cause**: The finger's patch was refreshed from the pixels after the dab had covered them with the patch itself, so the patch kept picking up its own paint and never faded.
- **Solution / Workaround**: `SmudgeTip.dab` reads each pixel before writing it. It lays the patch over that pixel and refreshes the patch from that original pixel by `1 − length`. A short `length` now fades within a few dabs, and the test checks that reach grows with `length`.

### [core|react|svelte/paint-editor] Brush Thumbnails Redrew on Every State Change

- **Issue / Symptom**: Dragging any brush slider in the paint editor's brush panel was slow, and the new engine-section UI tests timed out (over 5 s) once the library had a blender.
- **Root Cause**: `getState()` built `brushes: [...BUILTIN_BRUSHES, ...userBrushes]` fresh for every snapshot. React's `useMemo` and Svelte's `$derived.by` both saw a new array, so every brush thumbnail was repainted after every change. In Svelte, a `$derived.by` that reads `snap.brushes` also reruns whenever the snapshot object changes, even if the array is the same.
- **Solution / Workaround**: The controller caches the library list (`library`) and drops the cache only when the user brushes change (save, remove, import), so `state.brushes` keeps its identity. Svelte reads it through its own `$derived(snap.brushes)` (and `$derived(snap.document.paper)`), which only fires when the value changes. A core test checks that the list stays the same object across `setBrush` and `setColor`.

### [core/image-editor] A Shape Layer's Pixels Are a Render of Its Paths

- **Issue / Symptom**: Changing a shape layer's `components`, `fill` or `stroke` with a plain object spread left it showing the old pixels; painting into its `surface` was thrown away by the next edit.
- **Root Cause**: `ShapeLayer.surface` is a cache rendered from the paths (document space, offset 0, clipped to the canvas grown by 512 px), so the compositor, effects, masks, thumbnails and PSD export treat it like a pixel layer (`isPixelLike`). Nothing re-renders it implicitly.
- **Solution / Workaround**: Change shapes through `updateShapeLayer`, `rerenderShape`, `offsetShape` or `transformShapeComponents` + `renderShape` (`layers/shape.ts`), which render again. Painting `pixels` on a shape is refused; `rasterize_layer` makes it a pixel layer. Moves and Free Transform map the paths, never the pixels.

### [core/image-editor] The Accumulation Rasterizer Over-Counts Where Overlapping Parts Share an Edge Pixel

- **Issue / Symptom**: A rotated rectangle's stroke, an arrow's bar under its head and pen strokes came out up to 47 levels too opaque along some edges compared with what the canvas drew.
- **Root Cause**: The signed-area (font-rs) rasterizer is exact only for paths that do not overlap themselves. Stroke outlines from `strokeOutlineRings` overlap at joins, and a line shape's bar and arrowhead are separate overlapping subpaths. Where two overlapping parts' edges both cross a pixel, their areas add before the fill rule clamps them. Cleaning the outline with `outlineStroke` or `polygonBoolean` fixes the geometry but takes seconds for a few hundred pen points.
- **Solution / Workaround**: `rasterizeCoverage` (exact area) is used only for single-contour fills. Strokes and multi-contour components go through `rasterizeCoverageSampled`: 16 sub-rows per pixel row with exact horizontal coverage of the spans the fill rule keeps, so overlaps count once (edges within 1/32 px vertically). Curved strokes of up to 64 commands still get a clean `outlineStroke`, because raw rings of a curve tighter than half the width turn inside out. `tests/image-shape-migration.test.ts` compares every annotation kind with a 16 × 16 point-sampled reference of the old canvas drawing.

### [core/image-editor] Migrated Annotations Keep Their Annotation So v1 / v2 Documents Write Back Byte for Byte

- **Issue / Symptom**: Rebuilding an annotation from a shape (for the `annotations` view or a v1 / v2 save) changed numbers (an ellipse's box `x − rx` back to `x` is not exact in floating point) and broke byte-identical round trips.
- **Root Cause**: Pen, rectangle, ellipse, line and arrow annotations now load as shape layers, but old documents and the `annotations` / `updateAnnotation` API still speak annotations.
- **Solution / Workaround**: A migrated `ShapeLayer` keeps the source `annotation` while it is still exactly that annotation (`legacyView` and `isLegacyShape` read it; its blend mode moves to the layer). `updateAnnotation` rebuilds the layer from the merged annotation (back to an annotation layer when a colour can't be read). Any shape edit, a duplicate or a transform drops the field, and the layer leaves the `annotations` view. Plain migrated layers at the top of the stack still draw through the renderer's crisp annotation overlay, as before. Text and image annotations stay annotation layers.

### [core/image-editor] Type Layers Draw Through a Shaper, Which Node and jsdom Do Not Have

- **Issue / Symptom**: `addTextLayer` threw "Type layers need a text shaper" in tests, and a text annotation loaded in Node showed nothing.
- **Root Cause**: Layout is ours, but fonts are not: metrics, advances and drawing come from a `TextShaper`. The default is `createCanvasTextShaper`, which needs a 2D canvas with `measureText` (jsdom's canvas has no context). A family is "missing" when it measures the same as both `monospace` and `serif`, so web fonts must be loaded before layout.
- **Solution / Workaround**: Pass `textShaper` (for tests, `createOutlineTextShaper` with a font object; `tests/helpers/box-font.ts` is a deterministic box font) or call `setTextShaper`. Without one, type layers keep their stored pixels (`rendering: 'stored'`, saved as a PNG asset in v3 JSON) and edits that would draw them are refused. Migrated text annotations are created undrawn there and draw on the first edit where a shaper exists; at the top of the stack they still draw through the annotation overlay as before.

### [core/image-editor] A Text Annotation's `top` Baseline Is the Em Box, Not the Font's Ascent

- **Issue / Symptom**: Migrated text annotations would sit a few pixels off if their first baseline were placed by the font's ascent.
- **Root Cause**: The old renderer drew with `textBaseline = 'top'`, which is the top of the em square. Fonts' ascent (`fontBoundingBoxAscent`) differs from the em box.
- **Solution / Workaround**: Migrated type layers use `frame: { kind: 'point', origin: 'top' }`: the first baseline is one ascent below the origin, and the Canvas 2D shaper's `metrics` report `emHeightAscent` (falling back to the font box). `tests/image-type-tools.test.ts` checks that the new drawing calls match the old ones. Canvas also turned every whitespace character into a space, so migration replaces line breaks with spaces.

### [core/image-editor] Photoshop's Shape Paths: Joined Subpaths, a Leading Subtract and Its Own Pixel Snapping

- **Issue / Symptom**: Custom shapes lost their holes, shapes whose first component subtracted came in as their complement, and some shapes' stored pixels sat half a pixel or a stroke's fringe away from what our renderer draws for the same path.
- **Root Cause**: In `vsms` / `vmsk` path records, operation -1 after a component's first subpath means "same component" (its subpaths are filled together, so opposite windings cut holes). A first component that subtracts starts from a full canvas. Photoshop also snaps 1 px strokes to the pixel grid ("Align Edges") and some files' stored pixels are offset by half a pixel from their paths.
- **Solution / Workaround**: `componentsFromVectorBlock` starts a component at every subpath whose operation is not -1, and turns a leading subtract into `inverted: true` with the later operations swapped for their duals (combine ↔ subtract). We draw shapes from their paths on import (across 546 shape layers of the public corpus the alpha matches Photoshop's within antialiasing for all but a few snapped strokes and offset icons) and write the vector blocks back byte for byte while `shapeSignature` says the shape is unchanged.

### [core/image-editor] EngineData Runs Cover One More Character Than the Text

- **Issue / Symptom**: Text read from a `TySh` lost its last character's style, or Photoshop refused a written file.
- **Root Cause**: EngineData's `Editor/Text` always ends with an extra `\r`, and the last paragraph run and the last style run each cover it; the descriptor's `Txt ` does not. Line breaks are `\r`. Box text keeps its own origin in `BoxBounds`, separate from the `TySh` transform.
- **Solution / Workaround**: Read the text from `Txt ` (else the engine text minus its last `\r`), fit runs to it with `fitRuns`, and write the engine text with the extra `\r` and both last runs one longer (`buildEngineData`). Box text folds `BoxBounds`' top-left into our transform so our box starts at (0, 0). EngineData sizes are text-space units, which are our pixels, so no resolution conversion is needed for type (unlike `vstk` widths in points).

### [react|svelte/image-editor] On-Canvas Text Editing Types Into a Hidden Textarea

- **Issue / Symptom**: Keys typed right after clicking the canvas with the Type tool were lost, and IME (composed) text never arrived when keys were read from `window`.
- **Root Cause**: The canvas cannot take text input. Focus has to move to an element that can, and that element only exists once the click has opened a `TextEditSession` (after the pointer is released). Composed text comes as `compositionend` / `input`, not as `keydown` keys.
- **Solution / Workaround**: Both editors render a 1 px transparent `<textarea data-testid="type-input">` while a session is open and focus it on the next tick after mouse-up. `keydown` goes to `TextEditSession.handleKey` (single characters, Backspace, Delete, Enter, arrows, Home / End, Cmd/Ctrl+A) unless `isComposing`; `compositionend` and `input` insert the composed or pasted text and clear the textarea. Cmd/Ctrl+Z / C / X / V are left to the browser. All edits of one session are one undo step (the first change records history, the rest pass `commitToHistory: false`). Automated tests type into the textarea; a browser driver that types immediately after the click can beat the focus.

### [core/image-editor] Browsers Decode Images to sRGB, So an Opened Image's Own Profile Is Not Kept

- **Issue / Symptom**: A Display P3 JPEG opened with `loadImage` showed as sRGB in `get_color_profile`, and assigning its embedded profile afterwards made it look oversaturated.
- **Root Cause**: An `<img>` drawn to a 2D canvas is colour-managed by the browser into the canvas's sRGB space, so the pixels the editor reads are already sRGB numbers. The file's profile no longer describes them.
- **Solution / Workaround**: Keep sRGB for images that came through the browser decoder (the default). Only PSDs (decoded by us) take their embedded profile as the document's. To keep a wide-gamut working space for a photo, `convert_to_profile` after opening (out-of-sRGB colours are already clipped), or decode the file yourself without colour conversion and `assignProfile(readJpegIcc(bytes))`.

### [core/cms] The Synthetic CMYK Profile Is Built on First Use

- **Issue / Symptom**: The first `set_proof_setup` or `convert_colors` with `coated-cmyk` took one to three seconds; later calls were instant.
- **Root Cause**: The profile is generated from a printing model (its B2A tables are a damped least-squares separation at every grid node) instead of shipping 230 KB of measured data, and `builtinProfile` caches the result.
- **Solution / Workaround**: Expected. Call `builtinProfile('coated-cmyk')` early (e.g. idle time) to warm it. Tests that touch it need a timeout of about a minute on slow CI machines.

### [core/image-editor] A CMYK Document Is Edited as RGB, and Its Adjustment Layers Do Not Translate

- **Issue / Symptom**: A Curves layer that looked right in a CMYK document looked different when the exported CMYK PSD was opened in Photoshop.
- **Root Cause**: Pixels are always RGB in the working space here; CMYK mode only changes the viewport (a soft proof through the CMYK profile) and what `toPsd` writes (pixels separated through the profile, stored inverted with 255 = no ink). Adjustment layers are written with their RGB parameters, and Photoshop applies them to the C, M, Y and K channels of a CMYK file.
- **Solution / Workaround**: `toPsd` warns when a CMYK or Lab file has visible adjustment layers. Merge or flatten them first when the file must look the same in Photoshop. Out-of-gamut RGB colours clip in the separation, so check them with Proof Setup's gamut warning (and test colours in gamut: saturated sRGB blues are not).

### [core/vector] A Frame's Size Field Must Not Apply Each Keystroke

- **Issue / Symptom**: Typing a new width such as 400 into a frame's size field squashed children that stretch with the frame (`leftRight` / `topBottom`), and their margins came back wrong.
- **Root Cause**: Resizing a frame lays its children out again by their constraints. Applied on every keystroke, the frame went through widths 4, 40 and 400. At width 4 a stretched child's span became a sliver, and its margins could not be recovered from that.
- **Solution / Workaround**: Both frame panels apply x, y, width and height on Enter or blur (React: an uncontrolled input keyed by the value; Svelte: `onchange`), never per keystroke. Code that drives `setFrame` in steps should go straight to the final size, or start every step from the original document.

### [core/vector] Frames Draw, Hit and Bound Through Different Paths

- **Issue / Symptom**: An empty frame could not be selected, and children outside a clipping frame stayed clickable, while the frame itself drew correctly.
- **Root Cause**: Drawing goes through `expandVectorAppearance`, which turns a frame into a clip group (`vectorFrameDrawn`). Hit-testing and bounds instead start from the stored node, where a frame is just a group.
- **Solution / Workaround**: `vectorNodeBounds` and `hitTestVectorNode` handle frames first: the bounds are the rectangle (plus the children when it does not clip), and a hit is any point inside the rectangle. `vectorAppearanceShapes`, `expandVectorAppearance` and `vectorMaskRegionShapes` swap in the drawn clip group. Any new code that walks groups should check `isVectorFrame` before treating a frame as a plain group.

### [core/vector] Connector Anchors Are Overwritten After Every Edit

- **Issue / Symptom**: Moving a glued connector's anchors, or setting its subpaths through `updateNode`, appeared to do nothing.
- **Root Cause**: `rerouteVectorConnectors` runs in the controller's `refreshed`, after every edit (and after the constraint solve). It writes each glued connector's geometry again from its ends' sites. Only a free end keeps its stored point.
- **Solution / Workaround**: To reshape a connector, change its `route`, `radius` or `gap`, or unglue the end (`setConnector({ end: null })`); the end then stays where it is. The method is `addConnector`, not `connect`, because `connect()` is the controller's private history subscription.

### [core/vector] Tracking Acquisition Runs on a Timer, so Tests Need Fake Timers

- **Issue / Symptom**: In tests, resting the pointer on an anchor never acquired it for tracking. In a page, a point was acquired even though the pointer had stopped moving.
- **Root Cause**: Acquisition happens when the pointer has rested on a point for 400 ms (`TRACKING_DWELL_MS`). It cannot wait for the next pointer move, because a resting pointer sends none, so the controller sets a `setTimeout`. The timer is cleared when the candidate changes, when tools switch, on `clearTracking` and on `destroy`.
- **Solution / Workaround**: Tests use `vi.useFakeTimers()` and `vi.advanceTimersByTime(TRACKING_DWELL_MS + 10)`, or call `acquireTrackingPoint` directly. Turn tracking off with `setSnap({ tracking: false })` where it is not wanted.

### [core/vector] Typed Entry Takes Digit Keys While the Pen Draws

- **Issue / Symptom**: Digit shortcuts did nothing while a pen path was in progress.
- **Root Cause**: Like CAD direct distance entry, `keyDown` turns `0`–`9`, `.`, `-` and `@` into a typed entry while the pen has a path open (`state.typedEntry`). Enter places the point, Backspace edits the entry and Escape drops it.
- **Solution / Workaround**: Bind digit shortcuts with a modifier, or finish the path first (Escape, or switch tools). Hosts that show the entry should read `overlay.typedEntry`.

### [core/raster] Deep Samples Ride Next to the 8-bit Tile, and 8-bit Writers Drop Them

- **Issue / Symptom**: In a 16-bit document, a brush stroke (or a filter, transform or merge) left the tiles it touched at 8-bit precision, while the rest of the layer kept its 16-bit samples.
- **Root Cause**: High bit depth is additive: a `Tile` may carry `deep` samples (`Uint16Array`, or `Float32Array` in linear light) and its `data` is always their 8-bit rendering. Every existing 8-bit path (compositor, viewport, brushes, the paint editor) reads and writes `data` only, and a tile it rewrites is built by `finishTile` without `deep`.
- **Solution / Workaround**: Read at depth with `tileSamples16` / `tileSamples32` / `readDeepRegion` (a tile without `deep` converts exactly as a bit-depth change would), and write with `deepTile` / `writeDeepRegion`, which also keep `data` in step. Never build a tile by spreading another one and replacing `data`: its old `deep` would no longer match. The brush, eraser, Fill, Clear, Dodge, Burn and transforms are depth-aware (`applyStrokeToDeepTile`, `applyToneToDeepTile`, `transformSurface` / `warpSurface` resampling deep surfaces); the Mixer Brush, Smudge, Sponge, Clone and healing run their 8-bit code on float working tiles (next entry). For everything else, `keepDeepSamples` runs at each layer commit (`commitLayers`, `_strokeCommit`): a rewritten tile gets its old deep samples back wherever its 8-bit value did not change, so only the pixels an 8-bit tool changed lose precision. Never run it across a bit-depth change: going down to 8 bits would bring the samples back.

### [core/paint] Dab Tools Run at Depth on Float Working Tiles, so Never Round a Write

- **Issue / Symptom**: The Mixer Brush, Smudge, Sponge, Clone and healing on a 16-bit layer came out at 8-bit precision even with deep tiles in and out, and pigment mixing on a float tile picked stale colours.
- **Root Cause**: Their engines (`TileMedium`, `SmudgeTip`, `applyRetouchToTile`) read `px / 255` and wrote `Math.round(v * 255)`. On a float working tile the read is exact but the write rounds every pixel to a whole level. The pigment caches key on `(r << 16) | (g << 8) | b`, which truncates fractions.
- **Solution / Workaround**: On a deep document `PaintStrokeSession` hands them `Float32Array` working tiles on the same 0..255 sRGB-encoded scale (`workTileOf`, back with `deepOfWorkTile`, which copies the exact original samples for pixels still equal to what was read). Write through `put255` (rounds bytes as before, keeps fractions on floats), pass `Math.round(px[i])` to `mixPigment8` / `pigment8`, and skip byte-keyed caches on floats. Sources for Clone and healing read the same scale (`TilePixelSource` over working tiles, or `compositeDeep` encoded to it).

### [core/raster] A Deep Mask Is Coverage, Not Colour

- **Issue / Symptom**: A 32-bit mask read back from a PSD or painted at depth came out darker or lighter than its 16-bit copy, and a soft mask on a 16-bit layer banded in the deep composite.
- **Root Cause**: Deep RGBA samples at 32 bits are linear light, but a mask holds coverage. Running a one-channel surface through the colour transfer functions would linearise it. And the compositor read mask coverage through `readRegion`, the 8-bit rendering, whatever the mask held.
- **Solution / Workaround**: The deep helpers already take `channels`: for 1 they treat samples as plain 0..1 coverage (16-bit `v / 65535`, 32-bit as is). Always pass the surface's channel count (`tileSamples(tile, ch, …)`, `deepTile(d, ch, …)`, `applyStrokeToDeepTile(…, { channels })`). The compositor's `maskTile` reads `readDeepRegion(mask.surface, rect, 32)` when the mask has deep tiles (depth cached per surface). PSD masks at 16/32 bits are big-endian planes (`toMaskDeep`, `deepMaskPlane`). 16-bit CMYK files keep deep masks and layers too (`cmykToRgb16` through the profile at 16 bits); Photoshop has no 32-bit CMYK or Lab, so those modes export at 16 bits at most (`colorModePlanes16`). The 16-bit Lab planes use the importer's encoding (L/100, (a+128)/255 over 0..65535).

### [core/paint] A Deep Eraser Must Zero the Colour of Pixels It Clears

- **Issue / Symptom**: In a 16-bit document, Edit › Clear left full tiles of transparent pixels behind instead of removing them, so the layer kept its memory and its bounds.
- **Root Cause**: Erasing only scales alpha, as the 8-bit eraser does. A transparent 16-bit pixel that keeps an RGB sample that isn't a multiple of 257 has no exact 8-bit equivalent, so `deepTile` keeps the tile deep instead of dropping it as empty.
- **Solution / Workaround**: `applyStrokeToDeepTile` sets RGB to 0 when a pixel's alpha reaches 0 (the colour of a fully transparent pixel is invisible). The tile then becomes all zeros, which `deepTile` turns into no tile.

### [core/image-editor] 16- and 32-bit PSDs Keep Their Layers in an Lr16 / Lr32 Block, and 32-bit Is Linear Light

- **Issue / Symptom**: A 16-bit PSD written with the layer records in the usual layer-info section read back fine here but is not how Photoshop writes such files; and 32-bit values read as sRGB looked washed out.
- **Root Cause**: Photoshop stores the layer info of 16- and 32-bit files in a global `Lr16` / `Lr32` tagged block and leaves the layer-info section empty. Its 32-bit mode is scene-referred linear light, so float samples can exceed 1.
- **Solution / Workaround**: `writePsd` puts the layer info into `Lr16` / `Lr32` when the header depth is 16 or 32 (`readPsd` reads both places). 32-bit channels are ZIP with prediction (byte planes, then deltas); 16-bit channels are RLE. Our `Float32Array` samples are linear too; converting to 16 or 8 bits encodes to sRGB and clips colour above 1.

### [core/image-editor] Levels Quantise to 256 Levels, Which Bands a 16-bit Image

- **Issue / Symptom**: A strong Levels adjustment over a smooth 16-bit gradient came out with about thirty flat bands in the 16-bit composite.
- **Root Cause**: To match Photoshop at 8 bits, the Levels table rounds its input to whole levels and the stretch to whole steps (`LEVELS_QUANTUM`). Fed 16-bit values, that rounding throws the extra precision away. A default parameter hid a second bug: passing `undefined` to turn the rounding off brings the default back.
- **Solution / Workaround**: `compileAdjustmentLayer(layer, { deep: true })` builds Levels without the quantum (`toneLuts(layer, null)`), and `applyAdjustmentLayersFloat` (the deep compositor's filter run) uses those compiled ops through their own cache key. The 8-bit path is unchanged. Use `null`, not `undefined`, to switch off a parameter that has a default.

### [core/raster] The Deep Compositor Draws Effect, Filter and Annotation Layers at 8 Bits

- **Issue / Symptom**: In a 16-bit merge, a layer with a drop shadow or a develop filter kept only 8-bit precision, and a Multiply shadow over a coloured backdrop looked slightly different from the viewport.
- **Root Cause**: `DeepCompositor` hands those layers to the 8-bit compositor it wraps, rendered alone (normal blend, full opacity, over transparency), converts the result and blends it in float with the layer's blend mode and opacity. An effect's own blend mode therefore sees a transparent backdrop.
- **Solution / Workaround**: Fixed for pixel-like layers. Their filters run in float (`pixelFiltersDeep` → `runLayerFiltersFloat`), and their effects composite in float over the real backdrop (`runEffects`: `effectsInput` from the 8-bit compositor gives the area, the effect maps and context; `compositeLayerEffects` takes float buffers). Effect maps are still built from the 8-bit shape, which is coverage and plenty for shadows and glows. At 32 bits the effects composite in sRGB-encoded values (their colours and blend modes are defined there) and are decoded back. Groups with effects composite their children in float as the effects' content, and legacy-process develop filters have a float path too (`applyLegacyFloat`). Still at 8 bits: annotation layers (drawn by the editor) and smart objects, whose contents and smart filters render at 8 bits.

### [core/image-editor] Retouch Sources Must Be Captured When the Stroke Starts

- **Issue / Symptom**: A Healing Brush stroke sampling Current & Below or All came out matched to its own clone instead of to the photo, and a Clone Stamp stroke running over its own source copied the same pixels on and on.
- **Root Cause**: While a stroke is drawn, `_strokeUpdate` puts the live surface into `state.layers`, so a composite built at the end of the stroke (or a source that reads the live tiles) sees the stroke itself.
- **Solution / Workaround**: `retouchStroke` builds every `PixelSource` (the layer's pre-stroke surface, or a `TilePixelSource` over a compositor and the layer list as they were) in `beginStroke`, and the heal's `finalPaint` reads only those. Sources cache their tiles, so make a new one per stroke.

### [core/paint] Sequential Retouching on a Mask Needs an RGBA View, and an Empty Mask Tile Is Black, Not Transparent

- **Issue / Symptom**: The Smudge did nothing on a "hide all" mask, and on other masks it skipped whole tiles.
- **Root Cause**: `TileMedium` and `SmudgeTip` work on RGBA tiles, where a missing tile means transparent and a locked layer skips transparent pixels. A mask has one byte per pixel, and a missing tile (default 0) holds the value black.
- **Solution / Workaround**: `PaintStrokeSession` wraps a one-channel target in `rgbaViewOfGrey`: it expands every tile it reads (an empty one as zeros) to opaque grey RGBA with transparency locked, and `flush` writes the red channel back through `writeTile` after each push. The Sponge refuses masks, since a mask has no saturation.

### [core/vector] Mesh and Freeform Fills Are Not `VectorGradient`s

- **Issue / Symptom**: A mesh or freeform fill disappeared after a transform, and code that read `fill.stops` crashed on it.
- **Root Cause**: `VectorPaint` now also holds `{ type: 'mesh' }` and `{ type: 'freeform' }` paints. They have points and colours, not stops, so `isVectorGradient` is false for them. Code that treated every paint object as a gradient, such as transform baking or blend colour distance, skipped them or broke.
- **Solution / Workaround**: Check `isVectorShadedPaint` (or `isVectorMeshGradient` / `isVectorFreeformGradient`) next to `isVectorGradient`. `transformVectorPaint` and `mapVectorPaint` move both kinds of point, and `vectorPaintToSvg` draws them as a pattern. Freeform is drawn as gradient strips, not flat cells: flat cells showed visible blocks at normal zoom.

### [core/vector] Lottie Paints Act on Every Shape Above Them

- **Issue / Symptom**: An imported Lottie donut came in as two filled discs, and a shape with a stroke above its fill lost the fill.
- **Root Cause**: In Lottie, a fill, stroke or modifier applies to every shape item above it in its group, nested groups included. Shapes that share a paint therefore form one compound path. Items listed first draw on top, which is the reverse of our bottom-to-top order.
- **Solution / Workaround**: `parseVectorLottie` splits a group's items at its paint items. The shapes before them become one compound path, with all the paints and modifiers after them (top first, so the stack is reversed). The export writes strokes before fills and repeaters after the paint, so the painted result is what gets copied.


### [core/vector] PDF Viewers Show Hairlines Between Pattern Tiles

- **Issue / Symptom**: Conic, diamond, mesh and freeform fills in an exported PDF can show faint lines between their tiles in some viewers.
- **Root Cause**: These paints have no PDF shading equivalent here, so the PDF draws them as many abutting tiles, and each tile's edge is anti-aliased on its own. Overlap only hides the seams in some cases: a later tile covers an earlier one where they overlap, but not the gap anti-aliasing leaves along wedge edges.
- **Solution / Workaround**: Linear and radial gradients are exact PDF shadings, so prefer them for print. For the other kinds, accept the seams or expand the appearance first. A future fix could write conic gradients as a type 1 (function-based) shading.

### [core/paint] The Wet Kernels Only Agree Bit for Bit If Every Operation Is the Same f32 Operation

- **Issue / Symptom**: After adding the edge field, the TypeScript and WebAssembly wet kernels drifted apart (different state hashes after a few steps), although the maths was "the same".
- **Root Cause**: The TypeScript kernel is the specification and must round every intermediate to f32 (`Math.fround`) in exactly the SIMD kernel's order. One constant, `0.99`, was multiplied as an f64 literal in TypeScript but splatted as an f32 in AssemblyScript. (Rounding an f64 `+ − × ÷ √` of two f32 values once to f32 *is* the f32 operation, so `F(a * b)` matches `f32x4.mul`; an f64 constant breaks that.)
- **Solution / Workaround**: Declare every non-trivial constant once as `F(value)` (`DECAY`, `W0`…) and use it; never write a decimal literal inside a kernel expression unless it is exact in binary (0.25, 0.5, 1.5, 4.5). Keep masked SIMD lanes' maths identical to the scalar branch (compute both, select). `tests/paint-wet-kernel.test.ts` compares the two kernels' state hashes and checks that `kernel-wasm.ts` was generated from the current `assembly/wet.ts` (`pnpm --filter @pixerate/editor build:wasm`).

### [core/paint] Wet Media Is Only Deterministic If Nothing Depends on When Batches End

- **Issue / Symptom**: The same strokes could dry differently depending on frame rate, worker count or how many steps each frame ran.
- **Root Cause**: Anything decided at a batch boundary (waking tiles, baking and freeing dry ones) depends on where the boundaries fall, and frames decide those.
- **Solution / Workaround**: Time is the step `clock`, never wall time; edits (dabs) happen between batches and record the clock. Batches are at most `MAX_BATCH` (32) steps and never cross a multiple of `FREE_INTERVAL`. Tiles wake when anything *alive* (water on the surface or in the paper) comes within `STRIP` (64) cells of their edge, which stays ahead of anything that moves a cell a step, so an earlier or later wake-up changes nothing. Dry tiles are baked and freed only on multiples of `FREE_INTERVAL`, from the last step's flags (not the batch's), and only when no neighbour is alive. Dry cells must compute to exactly zero (that is why the edge field is 0 where dry). The tests run the same scene in different batchings and on 1–10 workers (in a browser) and compare hashes.

### [core/paint] `Math.exp` and `Math.pow` Differ Between JavaScript Engines, So the Dry-on-Save Bake Uses Its Own

- **Issue / Symptom**: A wet painting baked in Chrome and in Safari could differ by a level on a few pixels, which breaks "the saved file is the same everywhere".
- **Root Cause**: Only `+ − × ÷` and `Math.sqrt` are correctly rounded in JavaScript; `exp`, `log`, `pow`, `sin`, `cos` come from each engine's own maths library.
- **Solution / Workaround**: `film.ts` has `dexp` / `dlog` / `dpow` built from `+ − ×` only, and the sRGB tables and the `e^(−x)` table are made with them. Paper heights are quantised to 1/65536 and dab coverage to 1/4096 before they reach the simulation, so last-bit differences in the grain generator or the dab rasterizer (which use `Math.sin`) almost never matter. Flow maps use `dsincos`.

### [core/paint] A Glaze Must Be Shaded Over What Is Below as the Compositor Blends It

- **Issue / Symptom**: Blue glazed over a dried yellow wash came out blue-grey instead of green.
- **Root Cause**: The film was laid over the layer pixel mixed with the paper in *linear* light, but the compositor blends a semi-transparent pixel over the paper in *encoded* sRGB. A dark yellow channel at alpha 0.9 is 10 % of the paper in linear light (bright) but 0.1 × 255 encoded (dark), so the glaze saw a much lighter yellow than the screen showed.
- **Solution / Workaround**: `filmPixel` / `shadeTile` blend the pixel over the paper in encoded values first (`a·C + (1 − a)·P`) and only then convert to linear (`srgbByteToLinear` interpolates the byte table). The result goes back as colour plus alpha over the paper colour (exact over the paper), never lowering the pixel's own alpha.

### [core/paint] Web Workers From a Library: `Function.prototype.toString` Needs a Self-Contained Function

- **Issue / Symptom**: A worker built from a function's source failed with "x is not defined" in a consumer's minified bundle.
- **Root Cause**: `toString()` gives only the function body; anything it refers to outside itself (an imported constant, a helper) is not in the worker.
- **Solution / Workaround**: `wetWorkerMain` uses nothing outside its own body: every address and size arrives in the `init` message, and the kernel (halo exchange included) is in the wasm module. The pool runs it from a Blob URL, so hosts serve no extra file. CSPs that forbid `blob:` workers make the pool fail, and the world falls back to one thread with a warning.

### [core|demo/paint] Threads Need Cross-Origin Isolation; GitHub Pages Cannot Send the Headers

- **Issue / Symptom**: In the deployed demo wet paint runs on one thread and the Wet panel says why; locally it uses every core.
- **Root Cause**: Shared wasm memory needs `SharedArrayBuffer`, which browsers give only to cross-origin isolated pages (`Cross-Origin-Opener-Policy: same-origin` plus `Cross-Origin-Embedder-Policy: require-corp` or `credentialless`). GitHub Pages cannot set response headers.
- **Solution / Workaround**: The demo's Vite dev and preview servers send COOP `same-origin` and COEP `credentialless` (which, unlike `require-corp`, still loads cross-origin images without CORP headers). Without isolation the world steps on one thread (wasm SIMD, about 1/8 the speed on a 10-core machine) and `wetSupport().message` explains how to turn threads on. Results are identical either way.

### [core/paint-editor] Wet Layer Pixels Change Without Undo Steps, and Undo Restores a Snapshot

- **Issue / Symptom**: Undoing a watercolour stroke while other paint was still wet showed the wrong wet paint, and a fill on a wet layer could be overwritten by the next frame.
- **Root Cause**: A wet layer's pixels are the simulation's display: every frame replaces the layer's surface in the document (not an undo step). History entries hold documents, but the wet state lives in the world.
- **Solution / Workaround**: Every operation that changes wet paint takes a world snapshot before it (`beginWetOp`) and after it, kept on the history entry within `undoMemory` (oldest dropped: undoing past them leaves that paint dry). Undo and redo restore the snapshot with the document. Non-wet operations on a wet layer (a dry brush, fill, merge, duplicate, resize) dry it first inside the same undo step. Operations that touch the world while a worker batch runs throw; async callers (the agent tools, the Wet panel) `await controller.wetIdle()` first.

### [core/paint-editor] Thick Paint Is Lit at Render Time, So Relit Tiles Must Be Cached by Their Inputs' Identity

- **Issue / Symptom**: Moving the light, or painting one impasto dab, relit every tile of every thick layer and made strokes stutter on large canvases.
- **Root Cause**: A lit tile depends on its colour tile, its material tile, the light and the height of nine tiles (slopes reach across tile borders). Without a cache every composite relights everything.
- **Solution / Workaround**: `LitCache` keeps each lit tile with the identities of its inputs (colour, material, the 3 × 3 height tiles, the light key) and reuses it while they are the same objects. The live impasto stroke hands out new `Tile` objects for the height tiles it touched (`ThickStrokeDriver.channels()`), so only those and their neighbours relight. The layer's own pixels stay the unlit colour (albedo); exports, PSD layers and merges use the lit pixels, and merging drops the upper layer's relief.

### [core/paint-editor] A Replay Is Only Exact If Every Change Between Strokes Is Data, at the Right Place and Clock

- **Issue / Symptom**: A time-lapse of a painting with a ground fill showed strokes on bare paper; a replayed watercolour bloomed differently from the original.
- **Root Cause**: Strokes were recorded, but fills, clears and drying were not, and wet strokes replayed all their points at once although the simulation ran between them while the user painted.
- **Solution / Workaround**: Fills, clears and relief flattening are recorded as `paintEvents` with `at` (strokes recorded before them); wet events also carry `at` and their `clock`. Wet strokes record the clock of every point (`RecordedStroke.steps`), and `replayPainting` steps the scratch editor's simulation to each clock before pushing that point (`advanceWet` steps even when nothing is wet, so clocks stay in line). The replay test paints a live stroke with time passing between points and compares the replay byte for byte. Imported pixels, merges and transforms are still not data: those layers replay empty.

### [core/paint-editor] Simulated Brushes Must Step by Distance, Not by Input Sample

- **Issue / Symptom**: A spring-ink line drawn with a mouse looked different from the same path painted by `paint_stroke`, and a replay did not match the original.
- **Root Cause**: Particle and bristle simulations advance a step per update; pointer events arrive at whatever rate the device sends them, so steps per pixel differed.
- **Solution / Workaround**: `MarkStroke` walks the smoothed path with a fine dab walk (about 1.5 px per step) and advances the simulation once per walked dab, so the number of steps depends only on the path. Randomness comes from `rand01(seed, index, stream)`. The test pushes the same points in chunks of three and compares the pixels.

### [core/paint-editor] A Sticker Layer's Pixels Are Drawn From Its Stickers, So Other Paint Is Refused There

- **Issue / Symptom**: Editing a sticker after painting a pencil line on the same layer would wipe the line.
- **Root Cause**: Every sticker edit redraws the layer from its sticker list (`stickerSurface`), the only way to keep stickers editable objects with exact pixels.
- **Solution / Workaround**: Sticker spray needs an empty layer (or a sticker layer), and other brushes and fills on a sticker layer are refused with a message to add a layer. Sticker edits record a `stickers` paint event with the whole list, so replays rebuild the same layer.

### Wet-media tests time out on CI when the scene is "small"
- **Issue / Symptom**: `paint-wet-kernel.test.ts` took ~130 s on CI (Ubuntu, Node 24) and the physics tests in `paint-wet.test.ts` 5–9 s each, although they looked modest locally.
- **Root Cause**: The TypeScript spec kernel costs ~45–70 ms per 256² tile-step, and a disc centred on a tile seam (e.g. 256, 256) wakes four tiles. A 600×420 scene for 160 steps is ~1000 TS tile-steps; CI runners are ~3× slower than a laptop and run test files in parallel.
- **Solution / Workaround**: Keep CI scenes to one tile (centre marks at 128 on a 256 grid) unless the test is about tiles, use `evaporation: 1` for tests that wait for drying, and keep the TS-vs-wasm parity scene to 2 tiles and a few steps (bit differences show from the first step). The full parity and batching scenes run with `WET_BENCH=1`.

### [core/paint] WebGPU Shading Looks 240 Levels Off in Straight RGBA, Yet Is Within 1/255 on Screen
- **Issue / Symptom**: Comparing Engine B's shaded wet tiles with the CPU's byte by byte found channels up to 243 apart, all at alpha 1..40.
- **Root Cause**: Wet layer pixels are stored as straight (unpremultiplied) colour over the paper; the colour is `(film − (1 − a)·paper) / a`. At a tiny alpha a one-level difference in the composited film (GPU `exp`/`pow` against the CPU's tables) becomes a huge difference in the straight colour, though the pixel looks the same.
- **Solution / Workaround**: Compare what shows: each pixel composited over the paper (`a·rgb + (1 − a)·paper`). Both engines round colour and alpha to bytes, so allow up to ~1.5 levels and require almost no pixels over 1 (`tests/paint-wet-gpu.test.ts`).

### [core/paint] WGSL Kernels: Reserved Words, Dynamic Indexing and One Hot Atomic
- **Issue / Symptom**: The halo shader failed to compile only with "is invalid due to a previous error"; the step ran at half the expected speed.
- **Root Cause**: `from` is a reserved word in WGSL. `createComputePipeline` errors don't name the line: `getCompilationInfo()` on the shader module does. Speed: every one of the 65,536 threads of a tile did `atomicOr` on one flag word each step, and loops over 9 directions indexed private arrays dynamically (spilled to memory).
- **Solution / Workaround**: Read `getCompilationInfo()` and put its messages in the error (`gpu.ts`). OR flags into a `var<workgroup>` atomic and let one thread per workgroup touch global memory. Generate the per-direction code unrolled from TypeScript. The step is then bandwidth-bound (~47 floats per cell-step for this model).

### [core/paint] Engine B Cannot Make the Simulation Faster While the CPU Is the Authority
- **Issue / Symptom**: A WebGPU wet step is 1.5–2× the wasm engine, yet turning it on doesn't let wet paint run more steps per second.
- **Root Cause**: Saved output must never depend on the GPU (GPU results are close, not bit-identical, and differ between browsers), so the CPU still runs every step; edits and pick-up read CPU state.
- **Solution / Workaround**: Engine B mirrors the CPU (the same slot layout; edits upload only the rows `markEdited` reports; each batch is also stepped on the GPU) and takes over the display: `displayGpu` shades every stale tile in one dispatch instead of 24 tiles of main-thread JS per frame. A GPU result is dropped when the lane's stamp changed while it was in flight. Between strokes the GPU may run ahead, but only within the CPU batch in flight (`gpuLead`, at most 16 steps): edits only happen between batches, so the GPU never has to be rewound. Making the GPU the live engine ("option B": the CPU follows by replaying strokes) is a possible later upgrade for very large, fully wet canvases; it needs async pick-up readback, accepts a live picture that differs from the saved one within 1/255, and makes save wait for the replay.

### [core/tests] Node WebGPU (Dawn): One Instance per Process, Opt-In Tests
- **Issue / Symptom**: The GPU bench crashed the vitest worker with SIGSEGV.
- **Root Cause**: Each test called the `webgpu` package's `create()`, making a new Dawn instance per test.
- **Solution / Workaround**: Create the provider once per file and reuse it. The package is ~140 MB and CI has no GPU, so it is not a dependency: GPU tests run when `WET_GPU` names a local install (`WET_GPU=/path/to/node_modules/webgpu`); without it only the capability checks run.

### [core/paint] A Gradient Stroke's Colour Lags Half a Tip Behind the Pen
- **Issue / Symptom**: With gradient paint by distance, the colour at a pixel was that of a dab up to a radius behind, and tests sampling "the pixel at 100 px of travel" found a mixed colour.
- **Root Cause**: Build-up stops at the stroke's opacity ceiling: the first dab to reach a pixel lays most of its coverage, and later dabs only top up the antialiased edge. Each pixel's colour is the coverage-weighted mix of the dabs that added to it (`CoverageMap.colors`), as paint would be.
- **Solution / Workaround**: Expected: it is what a loaded brush does. Test colours half a tip ahead of the travel you mean, or check closeness, not exact bytes, at antialiased edges.

### [core/paint-editor] Migrating the Multi-Colour Brush Bit for Bit Needs Its Arithmetic, Not Just Its Gradient
- **Issue / Symptom**: Converting `behavior.multicolor` to an equivalent gradient changed a few pixels of old strokes.
- **Root Cause**: The old brush computed the colour position as `(index / length) % colours` and `j / (steps − 1) · (n − 1)`; a gradient sampler that finds the segment by comparing offsets computes `(t − o₀) / (o₁ − o₀)`, which differs in the last bits and can flip a byte after pigment mixing.
- **Solution / Workaround**: `PaintGradientSampler` uses the same arithmetic when the stops are evenly spaced (`uniform`): the segment by `f = t · (n − 1)`, and for repeating `distance` in dabs `f = (travel / (length / segments)) % segments`. `tests/paint-gradient-migration.test.ts` keeps the pixel hashes the old code gave; keep them passing.

### [core/paint] Stop Colours "paint" / "secondary" Must Be Resolved Before a Stroke Is Recorded
- **Issue / Symptom**: A replayed gradient stroke would follow whatever the editor colours are at replay time.
- **Root Cause**: Gradients may name the editor's colours (presets that follow the chosen colours, migrated multi-colour brushes without colours of their own).
- **Solution / Workaround**: `resolvePaintGradient` replaces them with the stroke's colours when it starts, and the stroke records the resolved gradient (`RecordedStroke.paint`); replays pass it back as `paint`, which wins over the brush's and the editor's.

### [core/vector] A Swept Shape's Edge Bands Must All Wind The Same Way

- **Issue / Symptom**: A block shadow (`sweepPath`) came out with holes along some sides of the shape.
- **Root Cause**: The sweep puts one band (edge, edge moved, back) per flattened edge into a single `nonzero` operand. Edges facing against the sweep direction give bands that wind the other way, so where two bands overlap their windings cancel to zero.
- **Solution / Workaround**: Swap an edge's ends when the cross product of the edge and the sweep is negative, and skip edges parallel to the sweep. Every band then winds the same way and `nonzero` unites them.

### [core/paint] Stepping Part of a Wet World: Held Tiles Must Survive the Parity Flip

- **Issue / Symptom**: To simulate only the wet tiles in view, the obvious approach is to take the other tiles out of the active list for a step. After an odd number of steps those tiles jumped back to an older state.
- **Root Cause**: Every slot holds two ping-pong sets, and one global `parity` says which is current. A step writes the new state into the other set and flips `parity` for all tiles, including tiles that were not stepped. Their current set then becomes the stale one.
- **Solution / Workaround**: `WetWorld.stepRegion` copies each held tile's current set into the other set before stepping, so the tile reads the same state whatever the parity, and it puts the tiles back afterwards (with `syncList` and `refreshHalos`). Held tiles keep their last flags, so they are never freed as dead. Water that reaches a held tile stops at its edge until it is stepped again. With a region covering every live tile, the result is bit-identical to `step`.

### [core/canvas] Lazy Paint for Brushed Strokes: Keep Every Paint Import in `brushstrokeRender.ts`, and Keep Types Out of the Graph

- **Issue / Symptom**: (1) A canvas consumer that never uses brushes would load the whole brush engine and the paint presets if a canvas file imported `src/paint` or `src/paint-editor` statically. (2) After brushed strokes were added, `pnpm build` died in the DTS step with `ERR_WORKER_OUT_OF_MEMORY`. Nothing was wrong with the code.
- **Root Cause**: (1) tsup puts a statically imported module into a chunk that the canvas entry imports. (2) The DTS worker was already close to its heap limit (about 4.4 GB RSS on main). It overflowed once `commands` imported canvas types (`DrawStrokeInput`), the canvas shape types imported `BrushSettings` from the paint engine, and an exported `typeof import('./brushstrokeRender.js')` dragged the paint editor's types into the canvas declarations.
- **Solution / Workaround**: Every value import of the paint engine for the canvas lives in `src/canvas/brushstrokeRender.ts`, which `brushstroke.ts` loads with `import()`. `brushstrokeScaleBucket` sits in the import-free `paint/brushstroke-scale.ts` so the canvas can use it statically. `entry-isolation.test.ts` checks that the canvas entry's static graph has no brush engine code. The data types (`CanvasBrush`, `CanvasBrushstroke`, …) live in the import-free `canvas/brushTypes.ts`, the renderer type is a hand-written interface, and `commands/builtins.ts` describes its targets structurally instead of importing canvas types. Declarations now come from `tsc` (see "[monorepo/build] Declarations Come From `tsc`"), but type imports across entries still make every entry's declarations heavier, so keep them out.

### [core/canvas] Scene Transitions Capture the Stage: Keep the Transition Canvas Out of the Second Capture

- **Issue / Symptom**: A provider transition between canvas scenes needs a picture of the view before and after the jump. If the canvas that plays the transition sits on the stage when the "after" view is captured, the after frame contains the before frame, and the transition dissolves into itself.
- **Root Cause**: `transitionCanvasView` covers the stage with its canvas as soon as the "before" view is captured (so the jump is hidden), and `rasterizeElement` captures every descendant of the stage.
- **Solution / Workaround**: The transition canvas is marked `data-capture="overlay"`, which is in `CAPTURE_OVERLAY_SELECTORS`, so captures leave it out. Any other layer you put over the stage during a transition needs the same mark. If capturing fails (no provider, an unknown effect, a capture error), `transitionCanvasView` removes its canvas and just jumps.

### [core/paint-editor] Effects Render Asynchronously: Render First, Commit After, and Refuse if the Layer Changed

- **Issue / Symptom**: Provider effects (`setPaperEffect`, `fillLayerWithEffect`, `applyLightEffect`) return promises. If the controller committed the undo step before the render, or wrote the result onto the layer as it is after the render, a stroke painted while the effect rendered would be lost or the effect would land on paint it never saw.
- **Root Cause**: The paint controller's history holds whole document states, and the wet simulation keeps changing wet layers between steps. Anything can change during the `await`.
- **Solution / Workaround**: Each effect method validates first, renders, then re-checks (no stroke in progress, the layer still exists with the same surface and offset) and commits in one synchronous step; otherwise it throws "changed while the effect rendered; apply the effect again". Fills and light refuse layers that hold wet paint ("dry it first"), so no wet snapshot has to be rolled back if the render fails. Slider drags pass `commitToHistory: false` after the first change, which folds into the last step only when it has the same label.

### [core/vector] Sorting Extrude Faces By Their Middles Draws Concave Shapes Wrong

- **Issue / Symptom**: On concave outlines (an L, a star), some side faces of an extrusion were drawn over faces that should cover them.
- **Root Cause**: Painter's order by each face's midpoint depth is only right when faces don't overlap unevenly. Two faces overlap only over the viewing rays (lines along the extrusion, or rays to the vanishing point) that cross both edges, and their order there can differ from the order of their middles.
- **Solution / Workaround**: `vectorExtrudeFaces` compares each pair of faces at a ray inside their shared range: the edge further along the ray is in front. It then sorts topologically, using the midpoint order to break ties. The edges of a simple outline don't cross, so the relation has no cycles. It's O(n²) in faces, which is fine for flattened outlines.

### [core/vector] A Perspective Plane Map Has A Horizon: Points Beyond It Come Back Mirrored

- **Issue / Symptom**: Art attached to a perspective plane far past a vanishing point came out flipped on the other side of the page.
- **Root Cause**: A projective map divides by `w = h6·x + h7·y + 1`. Where `w` passes 0 (the plane's horizon) points go to infinity, and beyond it they come back on the other side, mirrored.
- **Solution / Workaround**: `vectorPerspectiveFlatToPlane` / `vectorPerspectivePlaneToFlat` return null where `w` is not positive. `vectorPerspectiveMapPath` returns null if any sample does, and attaching refuses with a message. Grid lines are cut where `w` falls below 0.05.

### [core/vector] A Bevel's Inset Corners Must Know Which Side Is Inside, Ring By Ring

- **Issue / Symptom**: Holes (a frame, the counter of an "O") were bevelled into the hole, and thin parts had faces poking out the other side.
- **Root Cause**: A ring's winding alone doesn't say where the inside is: holes may wind either way under `evenodd`. And a mitred inset corner `width` deep can cross the opposite outline wherever the shape is thinner than the bevel.
- **Solution / Workaround**: `vectorBevelFaces` finds each ring's inside by testing a point just off its longest edge against all rings with the shape's fill rule. It then cuts each corner's inset to half the distance at which it would cross any outline edge.

### [core/vector] Distortion Brush Strokes Re-Apply From The Stroke's Start, Not Dab By Dab

- **Issue / Symptom**: Smudging back and forth made outlines heavy with anchors and slow, and a smudge stopped working once it had pulled the outline beyond the path's first bounds.
- **Root Cause**: Re-fitting the curves after every dab (`mapBezierPath`) adds anchors each time. A dab whose reach was tested against the path's original bounds skipped points earlier dabs had dragged out.
- **Solution / Workaround**: The drag keeps the document from the stroke's start and every dab. Each move recomputes `distortVectorPath(base, mode, dabs)`, which composes all the dab maps into one map and re-fits once. The reach test grows the bounds by how far the earlier dabs can have moved points.

### [core/vector] A Lens Depends On Other Nodes, So Its Backdrop Is Resolved Into The Node

- **Issue / Symptom**: A lens didn't follow edits to the art below it, because render data is cached per node object and the lens node itself hadn't changed.
- **Root Cause**: What a lens draws depends on nodes other than itself. The per-node caches (`renderCache`, `expandCache`, `shapeCache`) can't see that.
- **Solution / Workaround**: The backdrop lives on the lens as a derived `lensView`. `resolveVectorLenses` sets it in the controller's refresh, as connectors' routes and instances' art are set. It keeps node objects (and so caches) when the backdrop's nodes are the same objects, and `toJSON()` strips it. Code drawing a caller's document resolves it first (`getVectorSceneRenderData`, `vectorDocumentToSvg`, `vectorDocumentToPdf`, `vectorDocumentToLottie`).

### [core/vector] Generation Calls Cost Money, So Retries Must Not Generate Twice

- **Issue / Symptom**: An agent that retried `generate_vector_art` after a timeout got two copies of the art (and two charges).
- **Root Cause**: Model calls are slow and paid for. A retry after a lost response is indistinguishable from a new request unless the caller says otherwise.
- **Solution / Workaround**: `generateVectorArt` and `regenerateVectorArt` require an `idempotencyKey`, remembered per controller. A repeat with the same key and input returns the first call's result, or joins it while it runs. The same key with other input is refused. A failed call forgets its key so it can be retried. UIs make a fresh key per click, and scripts that replay make one per run.

### [core/vector] A Page's Master Art Is Placed By The Master's Frame, So Put It In The Master's Space

- **Issue / Symptom**: Art added to a master page showed on its pages shifted by the distance between the master and the page.
- **Root Cause**: The master's children are in the master frame's space. Each is laid onto a page by `vectorFrameChildMatrix(resizing, box, masterFrame, pageFrame)`, which moves art relative to the master frame's corner. Art drawn at the page's coordinates but added to the master sits outside the master's rectangle.
- **Solution / Workaround**: Place master art inside the master page's own rectangle: `vector.listPages` and `vector.addMasterPage` give each master's `bounds`. Give each object a `resizing` (e.g. `vertical: "bottom"` for a footer) so it follows pages of other sizes.

### [core/vector] Brushstroke Images Are Cached By Path And Layer Objects, So Edits Must Make New Ones

- **Issue / Symptom**: After a brushstroke layer was changed in place (in a test, or in a host mutating a document), the canvas kept drawing the old stroke.
- **Root Cause**: `vectorBrushstrokeImages` caches per path object and layer object (a `WeakMap` of `Map`s), and the shared `BrushstrokeCache` keys on the samples, brush and colour. Mutating a layer object keeps the stale entry.
- **Solution / Workaround**: Change brushstrokes through `setBrushstroke` / `updatePaintLayer`, which make new path and layer objects, as every other edit does. Treat document nodes as immutable.

### [core/paint] Standalone Brushstrokes Lost Their Grain: Full Pressure and Overlapping Dabs Fill the Valleys

- **Issue / Symptom**: On the canvas, charcoal, pastel and pencil drew the same smooth line. Applying the paint editor's per-dab `grainCatch` to `renderBrushstroke` barely changed it.
- **Root Cause**: `grainCatch` fills the valleys as pressure rises, and a mouse reports full pressure. Also, each dab's coverage builds up towards its ceiling (`c ← c + v·(ceil − c)`), so with tight spacing (charcoal 0.05, about 20 dabs over each pixel) a valley that loses half of every dab still ends up almost full. The paint editor relies on light, repeated passes over a shaded paper; a standalone stroke has neither.
- **Solution / Workaround**: `renderBrushstroke`'s `character` applies `strokeGrainCatch` once to the finished stroke's coverage, at the stroke's mean pressure. Its valleys lose up to `depth × (1.4 − 0.6 × pressure)`, so texture survives at full pressure. The paint editor keeps `grainCatch` per dab. The grain is sampled in path units via `origin` / `unit` (not image pixels), so it is the same at every zoom bucket and lines up across strokes.

### [monorepo/build] Declarations Come From `tsc`, Not tsup's DTS Worker, and Need Extensions and `.d.cts` Twins

- **Issue / Symptom**: `@pixerate/editor`'s build ran out of memory on CI (`ERR_WORKER_OUT_OF_MEMORY` in tsup's `dts` worker) and needed an 8 GB heap. Locally it peaked at 2.9 GB RSS and took 72 s. The npm package was 52 MB unpacked, 57% of it source maps. Separately, a `node16` consumer that `require`d any subpath got TS1479 ("the referenced file is an ECMAScript module") in their own file, because the single `types` condition pointed at `.d.ts` in a `"type": "module"` package; the `.d.cts` files tsup wrote were never referenced.
- **Root Cause**: tsup's `dts: true` rolls up one declaration bundle per entry (about 30) with rollup-plugin-dts in one worker, so memory grows with entries times program size. The type checker itself is cheap: `tsc --noEmit --extendedDiagnostics` uses about 1 GB with 209k instantiations, and `--generateTrace` with `@typescript/analyze-trace` finds no hot spots (the slowest expression takes 72 ms). Plain `tsc` emit has two traps: our sources use extensionless relative imports (`moduleResolution: "bundler"`), which tsc copies into the declarations and which `node16` ESM resolution can't follow (every type behind them silently becomes `any` under `skipLibCheck`), and it writes only `.d.ts`.
- **Solution / Workaround**: Core and React build JavaScript with tsup (`dts: false`), then run `tsc -p tsconfig.build.json` (`emitDeclarationOnly`, one `.d.ts` per source file, no declaration maps) and `scripts/finalize-declarations.mjs dist`, which adds `.js` / `/index.js` to extensionless relative specifiers and writes a `.d.cts` twin of every file with `.cjs` specifiers. Each `exports` entry nests `types` under `import` (`.d.ts`) and `require` (`.d.cts`). The build now peaks at about 1.2 GB (the `tsc` step) and CI runs on Node's default heap; CI records the peak in the job summary. `pnpm check:packages` packs all three packages, type-checks a consumer of every subpath with `bundler`, `node16` ESM and `node16` CommonJS (with `skipLibCheck: false` on our own declarations) and imports every core and React subpath with `import` and `require`; CI and Release run it. No source maps are published: maps without `sourcesContent` still cost 8.4 MB and point at `src/`, which isn't shipped, while leaving maps out of `files` but in the build would leave `sourceMappingURL` comments pointing at missing files (webpack's source-map-loader warns on each). The JavaScript isn't minified, so stack traces stay readable. If you need maps while debugging the demo, set `sourcemap: true` in the package's `tsup.config.ts` locally.

### [monorepo/types] CommonJS `node16` Consumers See TipTap's Types as ESM-Only

- **Issue / Symptom**: Type-checking our `.d.cts` files with `skipLibCheck: false` under `module: node16` reports TS1479, TS1541 and TS1542 on every import of `@tiptap/*` and `tiptap-markdown` (135 in all).
- **Root Cause**: Those packages are `"type": "module"` and give one `.d.ts` for both `import` and `require`, so TypeScript treats their types as ESM-only. A consumer that imports TipTap directly from CommonJS gets the same errors.
- **Solution / Workaround**: Nothing to fix on our side: their types still resolve (not `any`), and `skipLibCheck` hides the errors. `scripts/check-packages.mjs` tolerates exactly these codes, only in our declaration files and only for third-party specifiers, so a broken import of our own still fails it.

### [svelte/types] `node16` Consumers Type `.svelte` Imports Through Svelte's Ambient `*.svelte` Module

- **Issue / Symptom**: Under `moduleResolution: node16`, `export type { ChartInspectorSection } from "./ChartInspector.svelte"` in `@pixerate/editor-svelte/chart` failed with "Module '\"*.svelte\"' has no exported member".
- **Root Cause**: With `bundler` resolution TypeScript finds `ChartInspector.svelte.d.ts` next to the component. With `node16` it doesn't try that file and falls back to Svelte's ambient `declare module "*.svelte"`, which has only a default export (components still type, as a generic `Component`).
- **Solution / Workaround**: Keep types that the package exports in `.ts` files (`src/chart/types.ts`), not in a component's `<script module>`, and import them into the component. `pnpm check:packages` checks every Svelte subpath under `node16`.

### [core/tools] A Shared Schema Inlined at Every Use Multiplies a Toolset's Definition Size

- **Issue / Symptom**: The `animation` toolset listed about 827k characters of tool definitions (~200k tokens), and `edit_animation` alone took 303k. Every host that listed the toolset paid for it, even with scoping.
- **Root Cause**: The full command schema (a 20-branch `oneOf`, each branch repeating the shared fields and the easing schema) was a JS constant spread into every tool that takes commands or shots. JSON serialization copies it at every reference: three times in `edit_animation` (inside `insert_shots`, `update_shot` and `add_commands` ops), and once more in each of five other tools.
- **Solution / Workaround**: Put shared shapes in the tool's `$defs` and refer to them with `{ $ref: '#/$defs/<name>' }`. `validateJsonSchema` resolves local refs against the tool's root schema, and `withDefs` in `animation-editor/tools.ts` adds only the defs a tool uses. For a big discriminated union, carry one flattened strict object (every field once, with `additionalProperties: false` and descriptions saying which types take each field), check the per-type rules in the handler or edit layer with errors that name the field, and serve each type's full schema from a read tool (`describe_animation_command`). `tests/animation-editor.test.ts` keeps a size budget on the toolset, so measure with `JSON.stringify` of `registry.listTools().tools` before adding a large schema.

### [core/tools] Agent Playback Plans See the State Before the Call

- **Issue / Symptom**: A tool's `plan` that looks up the id the call is about to create finds nothing, so the cursor goes nowhere; or the post-roll ring sits where a node used to be.
- **Root Cause**: `AgentPlayback` runs `plan(args, state)` before the handler (the call has not happened yet), and the post-roll locates result ids right after the handler returns. A host that updates React state asynchronously still has the old nodes in `getNodes()` at that moment.
- **Solution / Workaround**: Plan toward where the change will land (the canvas planner already computes a new node's position; `planCanvasToolPlayback` uses it) and leave created ids to the post-roll, which reads them from the result. Give the surface's `getNodes` a live copy that `applySteps` updates synchronously (the demo's `live` ref in `CanvasTab.tsx`), not React state that renders later.

### [core/tools] `run_command` Plays on the Surface Named by the Command, Not the Provider

- **Issue / Symptom**: `commands__run_command { id: 'canvas.alignMiddle' }` ran instantly even though the canvas surface was attached.
- **Root Cause**: The command tools belong to the `commands` provider, which has no surface. Playback looks a surface up by the plan's `surface`, then the provider's `playbackSurface`, id and namespace.
- **Solution / Workaround**: The command tool's plan names the surface from the command: `CommandSpec.playbackSurface`, else its `scope`, else the id's prefix (`canvas.` → `canvas`). Attach the surface under that name (the canvas demo attaches `canvas`, which is also the canvas tool provider's id), or set `playbackSurface` on the command.

### [core/tools] Playback Waits Must Be Timed by the Clock, Not Counted in Frames

- **Issue / Symptom**: In a background tab, a glide of 50 frames took 50 seconds and blocked the tool call.
- **Root Cause**: Browsers throttle `setTimeout` in hidden tabs to about once a second, and suspend `requestAnimationFrame`.
- **Solution / Workaround**: `AgentPlayback` tweens by elapsed `clock.now()` (a throttled tab just draws fewer frames, never takes longer), and the canvas surfaces report `visible() === false` while `document.visibilityState` is `hidden`, so calls then run instantly. Never make a tool call wait on animation frames.

### [react|svelte/vector] The Agent Cursor Is an HTML Layer Inside the Vector Canvas's SVG

- **Issue / Symptom**: `<PresenceLayer>` is an absolutely positioned `div`, but `<VectorCanvas>`'s root is an `<svg>`, so the layer has nowhere to sit without wrapping the canvas (which would break layouts and tests that expect the `svg` as the root).
- **Root Cause**: HTML can't be a child of an SVG element except through `foreignObject`.
- **Solution / Workaround**: The canvas draws the layer in a full-size `<foreignObject data-vector-presence pointer-events="none">` as its last child, so it is on top and never takes pointer events. It is only rendered while a playback is attached. In jsdom tests the surface reports itself hidden (no layout), so override its `visible` to test playback.

### [react|svelte/image-editor] Agent Playback Mixes the Canvas and the Panels in One Coordinate Space

- **Issue / Symptom**: The agent's cursor has to reach both the image (document pixels, zoomed and panned on the canvas) and the editor's own tabs and sliders (plain DOM), but a playback surface has one coordinate space.
- **Root Cause**: Plans speak document pixels, while the panels sit outside the canvas, where no document point is drawn.
- **Solution / Workaround**: The surface stays in document pixels, and `locate` maps a panel element's client rectangle *into* document pixels with `canvasToImagePoint`. The layer maps every point back out with `imageToCanvasPoint`, relative to the editor's root, so a point outside the image still lands on the right control. Panels change the layout (the Paint tab's side panel is taller), so map at draw time from live refs, never from a cached rectangle.

### [core/tools] A NaN Playback Target Hung the Tool Call Forever

- **Issue / Symptom**: A tool call under agent playback never returned; the test runner sat silent until its timeout.
- **Root Cause**: A surface's `locate` built a rectangle from a lookup that missed (`rows[undefined]`), so a coordinate was `NaN`. The glide loop stops when its progress reaches 1, and `NaN >= 1` is never true, so it waited one frame after another for ever.
- **Solution / Workaround**: `AgentPlayback` treats a rectangle with any non-finite number as "not found", never glides toward or from a non-finite point, and skips a `type` step whose duration is not a positive finite number. Locators may return null freely; never let a missed lookup turn into `NaN`.

### [demo] Editing a Skill File Mid-Run Replaces the Demo's Tool Registry

- **Issue / Symptom**: A scripted agent run failed with `Unknown tool "image__render_preview"` halfway through, after a `SKILL.md` was edited.
- **Root Cause**: `apps/demo/src/agentTools.ts` imports the skills with `import.meta.glob`, so Vite's hot reload re-evaluates that module and creates a new, empty `demoToolRegistry` while the old editors are still registered with the old one.
- **Solution / Workaround**: Reload the page after editing skills before playing demo scripts, or run demo sweeps only after the edits.

### [react|svelte/video-editor] A Collapsed Layout Makes a Playback Surface Report Itself Hidden

- **Issue / Symptom**: Video scripts in a narrow demo pane ran with no agent cursor.
- **Root Cause**: At narrow widths the editor's grid column collapses to zero width, so the timeline's box is 0 px wide and the surface's `visible()` (box has a size) is false. Playback then runs calls instantly, as designed.
- **Solution / Workaround**: This is intended (there is nothing on screen to point at). Check playback at a desktop width; give hosts a layout where the timeline keeps a width.

### [react|svelte/chart|paint] A Director and Playback Must Share One Presence Store

- **Issue / Symptom**: With a `ChartDirector` (or `PaintDirector`) and agent playback both on, two agent cursors could show: the director's in the chart SVG while it dragged a value, and playback's over the inspector for the next call.
- **Root Cause**: Each kept its own `PresenceStore`, in different coordinates, so neither knew where the other's cursor was.
- **Solution / Workaround**: Pass the director's presence to the editor (`canvasProps.presence` / `presence`). The editor's playback surface then uses that same store (the shared-presence argument of `usePlaybackSurface` / `createPlaybackSurface`) in the director's coordinates: chart scene units or paint document pixels. DOM controls are mapped into those coordinates. The editor draws the one cursor layer and turns the canvas's own layer off. The tool providers mark the director's tools `playback: 'self'`.

### [ci] Re-running a Release That Failed at Publish Publishes Nothing

- **Issue / Symptom**: The Release run for #317 failed at "Publish changed packages to npm" with `E503 Service Unavailable` from npm. Re-running the failed job succeeded but published nothing. A manual `workflow_dispatch` run then failed at "Version packages" with `No unreleased changesets found`. npm stayed one version behind `main`.
- **Root Cause**: The workflow pushes its version commit before publishing, so `main` already had the new versions and no pending changesets. A re-run checks out the tip of `main` and skips ("No pending changesets found"). A manual run forces the release path, but `changeset version` exits 1 when there is nothing to version.
- **Solution / Workaround**: The version step now runs only when changesets are pending. To publish a release whose publish step failed, start the workflow by hand: `gh workflow run release.yml --ref main`. It builds, tests and runs `changeset publish`, which publishes the versions npm is missing. Then compare `npm view @pixerate/editor version` with `main`.

### [core/animation] Pointer Input Between Frames Reads a Stale Playhead

- **Issue / Symptom**: Recorded takes came out with drags quantised to frame times, and with a `ManualClock` every sample recorded since the last frame landed on the same time (a whole drag became an instant jump).
- **Root Cause**: `AnimationPlayer.currentTime` is the time at the last frame it ticked. Pointer events arrive between frames, and a `ManualClock` only ticks the player when `advance` resolves its frame promises, so the clock had moved on but the playhead had not.
- **Solution / Workaround**: Read `player.liveTime` (the playhead at the clock's time now) for input timestamps. `currentTime` stays the right value for drawing. In tests, `await clock.advance(ms)`: it is async and ticks frames only after it settles.

### [react/gradient] Controlled Pickers Built on a Long-Lived Controller

- **Issue / Symptom**: React `FillPicker` stopped reporting gradient edits after switching from solid to gradient. Bound to a parent's value, every edit also added a "Set Gradient" undo step and moved the selection back to the first stop.
- **Root Cause**: The `GradientController` is created once, so the `onChange` passed to it kept the `mode` and `onChange` values from the first render. Each value the parent passed back was loaded with `setGradient`, which records an undo step and resets the selection, even when it was only the picker's own change returning.
- **Solution / Workaround**: Read the latest props through a ref inside controller callbacks (pass `readOnly` as a function for the same reason). Load host values with `controller.load()`, which adds no undo step and keeps the selection, and skip a value equal to the CSS the picker just emitted. Svelte's `$state` avoids the stale `mode`, but the echo and undo problems apply there too.

### [demo] `vite build` Does Not Typecheck the Demo

- **Issue / Symptom**: `pnpm --filter demo build` passed while the demo passed an options object where `createGradientToolProvider` expects a controller, so every gradient tool failed at runtime.
- **Root Cause**: Vite strips types without checking them. Only `pnpm typecheck` (run in CI) checks the demo, and it also runs `svelte-check` on the Svelte package.
- **Solution / Workaround**: Run `pnpm typecheck` before pushing, as well as `pnpm build`, `pnpm test` and the demo build.

### [svelte] Types Exported From a `.svelte` Module Script Break node16 Resolution

- **Issue / Symptom**: `pnpm check:packages` failed under node16 (ESM) with `Module '"*.svelte"' has no exported member 'FillMode'`, while `svelte-check`, the build and the bundler check all passed.
- **Root Cause**: The published `index.d.ts` re-exported the type from `./FillPicker.svelte`. Consumers with `moduleResolution: node16` see `.svelte` imports through the ambient `*.svelte` declaration, which only has a default export.
- **Solution / Workaround**: Put types that a package entry re-exports in a `.ts` file (e.g. `gradient/types.ts`) and import them into the component from there. Run `pnpm check:packages` after changing a Svelte entry's exports.

### [react|svelte/playback] A Surface That Always Defines `open` Makes Every `open` Step Wait

- **Issue / Symptom**: On surfaces without panels (the node canvas, spreadsheets, a plain element surface), every tool whose plan starts with an `open` step paused for about a third of a second before acting, and the cursor pressed on nothing.
- **Root Cause**: `AgentPlayback` skips an `open` step only when `surface.open` is undefined. `usePlaybackSurface` / `createPlaybackSurface` always built `open: (ref) => o().open?.(ref)`, so every attached surface looked able to open things, and playback glided, pressed and waited 220 ms for a no-op.
- **Solution / Workaround**: The helpers expose `open` as a getter that is undefined unless the current options have one (options are still read per step). Surfaces that wrap them pass `open` through the same way (`get open()` or `open: o.open ? … : undefined`), never as an unconditional arrow.

### [svelte/rich-text] Typography Resets the Colour of Bold Text

- **Issue / Symptom**: Making coloured or gradient text bold in `EditableTextNodeEditor` turned it white (or the theme's bold colour). Italic, links and inline code did the same.
- **Root Cause**: The editor content uses Tailwind Typography (`prose`), which sets `color: var(--tw-prose-bold)` on `strong` (and its own colours on `a` and `code`). A colour mark renders as a span around the `strong`, so the span's colour (or a gradient's `text-transparent`) never reaches the text.
- **Solution / Workaround**: Inline marks inside `.pixerate-editor-content` use `color: inherit`. Colour marks that wrap text must not rely on the inner element keeping their colour.

### [image-editor] A Canvas Sized From `clientWidth` Blurs Under a Host CSS Transform

- **Issue / Symptom**: An `ImageEditorCanvas` inside a node that the host scales with a CSS transform (e.g. a 220px node shown at 500px) rendered at 220px and was stretched, so it looked blurry. It was also soft on high-DPI screens.
- **Root Cause**: `clientWidth` / `clientHeight` are layout sizes that ignore transforms, and the backing store was set to exactly that size, without `devicePixelRatio`. A `ResizeObserver` does not fire when only a transform changes.
- **Solution / Workaround**: `measureCanvasViewport` keeps the layout size for the projection and pointer mapping. It sets the backing store to layout × `devicePixelRatio` × (on-screen size from `getBoundingClientRect()` ÷ layout size). `renderToCanvas({ pixelRatio })` sets a base `setTransform`, so everything still draws in CSS pixels. Pointer mapping must divide by the CSS viewport, never `canvas.width`, which is now larger. `watchCanvasViewport` also measures again on window `resize`, `transitionend` and `animationend`. jsdom has no layout, so the canvas there uses `DEFAULT_CANVAS_VIEWPORT` (800 × 500). Tests that place pointer events compute points against it.

### [image-editor] Agent Error Text Shown to People

- **Issue / Symptom**: Painting a new image in `ImageEditorCanvas` reported "No layer given and none is active; pass layerId (see list_layers) to paint." through `onerror`.
- **Root Cause**: `LayerOperationError` messages are written for agents (they name tools and arguments), and `PaintGesture` / `BrushOptionsBar` showed `err.message` as it was. A new image also had no active layer, so the first stroke always failed.
- **Solution / Workaround**: Give a refusal a second, person-facing message (`new LayerOperationError(agentText, personText)`) and show it with `userErrorMessage(err)` in UI code. Tool results keep `message`. New images, and documents saved without an active layer, now open on `defaultActiveLayerId` (the topmost paintable pixel layer). Deleting the active layer moves to `activeLayerAfterRemoval`.

### [canvas] Dagre Explosion Reflow Ignored the Parent-to-Child Edges

- **Issue / Symptom**: Exploding with `displacementStrategy: 'dagre'` barely moved downstream nodes: children landed in the same rank as the node that exploded, and nodes they connect to moved one rank instead of two.
- **Root Cause**: The coordinators built the parent-to-child edges (`connectParentToChildren`) after computing the reflow, so dagre saw the children as unconnected roots.
- **Solution / Workaround**: `computeCanvasExplosionLayout` builds the edges first and passes the child edges plus the generated parent edges to `calculateReflowDisplacement`. Both coordinators now go through it, so do not compute displacement before deciding the edges.

### [canvas] Clamping Displaced Rows to `minY` Made Them Overlap or Move Backwards

- **Issue / Symptom**: With a floor such as `minY` below a pinned timeline header, a plain `Math.max(minY, y)` piled every row pushed past it onto the same y, and rows that started above the floor were pulled down into it.
- **Root Cause**: A per-node clamp knows nothing about the other rows or where the node started.
- **Solution / Workaround**: `calculateDirectionalDisplacement` groups moved nodes into rows (lanes in `row-lane` mode, else equal original y), stacks clamped rows `rowSpacing` apart from `minY` (`maxY` stacks upward), and never moves a node past its starting y in the other direction. Rows clamped back to their start are dropped from the result.

### [react/canvas] Destroying a Headless Controller in an Effect Cleanup Breaks StrictMode

- **Issue / Symptom**: In `<StrictMode>`, a hook that created a controller once (in a ref) and called `controller.destroy()` from `useEffect`'s cleanup stopped responding: the first explode did nothing.
- **Root Cause**: StrictMode runs effect cleanup and then the effect again on mount, without re-rendering, so the ref still holds the destroyed controller.
- **Solution / Workaround**: `useCanvasExplosionState` only ends a running collapse in the cleanup (`finishCollapse()`, which clears the timer) and leaves the controller usable. `useSyncExternalStore` handles subscribe / unsubscribe. Use `destroy()` only where the owner really goes away (the Svelte rune calls it from its `$effect` teardown).

### [react/canvas] React Flow `Edge` Is Not Assignable to Core `CanvasEdge`

- **Issue / Symptom**: `useCanvasExplosion<BoxNode, Edge>(...)` fails to typecheck with `Types of property 'label' are incompatible`.
- **Root Cause**: React Flow's `Edge.label` is a `ReactNode`; core's structural `CanvasEdge.label` is a string.
- **Solution / Workaround**: Pass a loose edge type parameter (`useCanvasExplosion<BoxNode, any>`), as the demo does. The coordinator only reads `id`, `source`, `target` and `style` of edges.

### [core/video-editor] An Adjustment Clip at Part Opacity Must Mix Over the Unadjusted Picture

- **Issue / Symptom**: Drawn naively, an adjustment clip at 50% opacity (or fading in) fades the pictures beneath it towards the background, instead of mixing the adjusted look with the unadjusted picture.
- **Root Cause**: An adjustment clip is evaluated as a group layer that holds the pictures it changes (like a compound clip), so the renderers can grade and run effects on the composite. Moving the pictures into the group took them out of the frame, so the group's opacity mixed against the background.
- **Solution / Workaround**: When the adjusted copy does not cover everything fully (opacity below 1, fades, a blend mode, a mask, a wipe or iris), `videoFrameAt` keeps the unadjusted layers in place and draws the group over them. At full opacity it replaces them, so the pictures are drawn once. Scope `underneath` is applied while the tracks are evaluated (it wraps what has been drawn so far). Scopes `all` and `track` are applied after every track, because they reach tracks above the adjustment clip.

### [core/video-editor] An Adjustment Clip's `track` Field Overwrote the Track in Tool Results

- **Issue / Symptom**: Designing the adjustment clip with a `track` field (the track it targets) broke `get_video_project` and every tool result. Clip outputs are built as `{ track: <the track it is on>, ...clip }`, so the clip's own field replaced the track it sits on.
- **Root Cause**: Clip fields are spread into tool results and inspector rows alongside the location fields.
- **Solution / Workaround**: The target is `targetTrack`. Avoid clip fields named `track`, `end` or `source`, which tool outputs add.

### [core/video-editor] A Feathered Mask on the Canvas Needs the Blur Scaled to Canvas Pixels

- **Issue / Symptom**: Mask feathers looked right at preview scale 1 but too soft or too hard at other resolutions.
- **Root Cause**: The mask is cut on a scratch canvas by filling its outline with `globalCompositeOperation = 'destination-in'` (`destination-out` when inverted) and `filter: blur()`. A canvas filter's blur radius is in canvas pixels and ignores the current transform, while the outline is drawn in frame pixels through `setTransform(scale…)`.
- **Solution / Workaround**: `applyVideoMask` sets `blur(feather × scale / 2 px)`. SVG uses `feGaussianBlur stdDeviation = feather / 2` inside the mask, in user space. Mask outlines are polygons (`videoMaskPolygon`) so the canvas, SVG and agents (`videoMaskContains`) all cut the same shape. The scratch context needs `moveTo`, `lineTo`, `closePath` and `fill`. They are optional in `VideoScratchCanvas`, so hosts with minimal contexts still compile. Without them the mask is skipped.

### [core/video-editor] ffmpeg's `lut3d` Cannot Protect Skin Tones, and Most Adjustment Clips Are Not Filters

- **Issue / Symptom**: Exports did not match the preview for LUTs with `preserveSkinTones`, or for adjustment clips with masks, fades, part opacity or scope `track`.
- **Root Cause**: Skin protection is a per-pixel mix weighted by the pixel's chroma, which `lut3d` cannot express. An adjustment clip changes the composite of several overlays. ffmpeg's timeline `enable` can switch a grade on the composite for the clip's span, but cannot fade or mask it without splitting the whole graph.
- **Solution / Workaround**: `toVideoFfmpeg` draws a full-opacity grade or LUT on the composite with `enable='between(t,…)'` for scopes `underneath` and `all`. It refuses masks and other adjustment clips (`videoFfmpegUnsupportedFeatures` names them) unless given `frames` rendered with `renderVideoFrameExact`. Skin protection is applied in the preview and frame renders; the export adds a note. EDLs leave adjustment clips out rather than writing black events.

### [core/video-editor] Loudness Cannot Be Measured From Min / Max Peaks

- **Issue / Symptom**: Loudness worked out from the waveform peaks the editor already keeps does not match LUFS meters: a sine and a square wave at the same peak read the same.
- **Root Cause**: LUFS (ITU-R BS.1770) is a gated mean of K-weighted energy over 400 ms blocks. Peaks keep only the extremes of each block, which says nothing about energy or frequency weighting.
- **Solution / Workaround**: `buildVideoAudioPeaks` also stores the K-weighted mean square per 100 ms hop (`peaks.loudness`, from the decoded samples it already has). `videoAudioLoudness` gates any stretch of it into LUFS. Peaks built by older code or by a host without `loudness` make the loudness tools fail with a message saying to rebuild them. Tests check a full-scale 997 Hz sine at -3.0 LUFS.

### [core/video-editor] Plans Must Be Re-Checked, and Their Ids Allocated Only When They Are Made

- **Issue / Symptom**: A plan proposed before other edits could apply ops to clips that had moved or gone. A refused proposal also used up the next plan id, so agents told to apply "plan1" found "plan2".
- **Root Cause**: A plan is a list of edits worked out against the project as it was. The id counter advanced before the edits were validated.
- **Solution / Workaround**: The controller remembers the project each plan was made against. `isPlanStale` compares it with the current one, and `applyPlan` re-runs the edits on the current project, refusing (with the plan kept open) when they no longer apply. Ids are reserved only after `planVideoEdits` succeeds. Plans are view state: they are not in the project or the undo history, and applying one is a single undo step labelled with its title.

### [core/video-editor] Spring and Elastic Easings Have No Video Keyframe Equivalent

- **Issue / Symptom**: Writing an effect authored with spring or elastic keyframes back to a clip effect failed, because video keys only take linear, hold, the CSS named eases and cubic-bezier.
- **Root Cause**: Springs and elastics are physical simulations, not curves through two handles.
- **Solution / Workaround**: `videoEffectValuesFromDocument` samples those segments into 12 linear steps and says so in `notes`. Non-numeric keyframed controls (colours) keep their first value, also noted. Converting video keys to an authoring document is lossless (`videoEaseToAnimationEasing`).

### [svelte] A Local Variable Named `state` Is Read as a Store

- **Issue / Symptom**: `svelte-check` failed with "Cannot use 'state' as a store" and "Untyped function calls may not accept type arguments" on `let anchor = $state<number | null>(null)` in a component that also declared `const state = $derived(...)`.
- **Root Cause**: In Svelte 5, a top-level variable named `state` makes `$state` look like an auto-subscription to a store called `state`, not the rune.
- **Solution / Workaround**: Never name a component-level variable `state` (or `derived`, `effect`, `props`) when the component uses runes. `TranscriptEditor.svelte` uses `ts` for the transcript state.

### [chart] Per-Category Lists Drifted When Categories Were Added, Removed or Moved

- **Issue / Symptom**: After inserting, deleting or reordering a category, a series' point colours (and its numeric x values, bubble sizes and custom error amounts) stayed where they were while the values moved, so colours and sizes landed on the wrong bars. Callouts, which are also one per category, would have done the same.
- **Root Cause**: `addCategory`, `removeCategory` and `moveCategory` spliced only `series.values`. Normalising afterwards pads or trims the other lists to the category count, which hides the mismatch instead of fixing it.
- **Solution / Workaround**: The controller edits every per-category list of a series together (`pointLists`: values, x, sizes, pointColors, callouts and custom error-bar plus / minus). Any new per-category series field must be added to `pointLists`. Names in `highlight` are kept in step the same way: renaming a category or series renames its entry, and removing one drops it.

### [core/tools] House-Style Profiles Must Merge Field by Field, or Locks and Sources Cover Whole Objects

- **Issue / Symptom**: With an org layer marked `locked` that set `theme.font` in its `chart.json`, a user layer's `theme.size` was refused as "locked", and `sources` reported `theme: "org"` instead of one entry per field.
- **Root Cause**: The first profile merged into the empty result assigned the whole `theme` object at once, so the merge recorded (and locked) the path `theme`, not `theme.font`. Every later field under `theme` then matched the lock.
- **Solution / Workaround**: `mergeProfile` in `src/tools/style.ts` always recurses into plain objects (creating an empty one when the target has none) and records sources and locks only at leaves; arrays are leaves and replace. Keep it that way when adding profile fields, and cover new nested fields in `tests/style.test.ts`. Also note that a chart's `theme` is a render option, not part of `ChartSpec`, so chart style checks cannot see fonts: hosts pass the resolved profile's `theme` to the renderer, and the checks cover what the spec holds (colours and type).

### [chart-maps] Douglas–Peucker Erases Islands Stored as One Closed Arc

- **Issue / Symptom**: Building the Europe map dropped the outlines of Iceland, Malta, the Faroes and Åland (they came out empty and were drawn as markers), though they are far larger than the simplification tolerance.
- **Root Cause**: In TopoJSON an island is often a single arc that starts and ends at the same point. Douglas–Peucker measures each point's distance to the line between the arc's ends; with both ends at one point that line has length 0, the cross-product distance is 0 for every point, and the whole ring collapses to its endpoints.
- **Solution / Workaround**: When an arc's ends coincide, measure from that point instead (`scripts/build-europe-chart-map.mjs`). Simplify per arc (not per ring) so neighbouring countries keep identical borders, and check the script's "no outline left" warnings: only Vatican City should be a marker.

### [image-editor] Layer Styles Showed in Two Places, and the "Smart Filters" Panel Was Really Layer Styles

- **Issue / Symptom**: A host that renders every `layerPanels()` id (Pixerate's image studio) showed a plain pixel layer with an "Effects" panel whose Add menu mixed "Filter…" with Bevel & Emboss, Stroke, Drop Shadow…. Users couldn't tell what it was for, next to the effect layer's own Effects controls. Without a provider, a smart object got a "Smart Filters" panel that showed only the layer's styles.
- **Root Cause**: Layer styles (`layerEffectsPanel`, built in, no provider) and Flair filters (provider smart filters) were put into one "Effects" panel because both change how a layer looks. In Svelte's `LayerPanel`, the `smart-filters` id rendered `<LayerEffectsPanel>`, the styles list, under a filters title.
- **Solution / Workaround**: Layer styles describe the layer itself, so they live in Layer Properties (`<LayerPanel panelId="properties">` renders `<LayerEffectsPanel>` as "Layer Style"). They also stay in `<LayersPanel>`'s section. `provider-effects` holds only provider things: an effect layer's controls and its filters ("Add filter…"). `layerPanels` no longer returns `effects` or `smart-filters`. When adding a new kind of layer decoration, put it with the layer's properties when it works without a provider, and under Effects only when it comes from the effects provider.
### [svelte/effects] An `$effect` Re-runs When the Object a Getter Reads Through Changes, Not Only Its Result

- **Issue / Symptom**: Dragging an effect layer's Frame slider stopped after a few pixels; the drag couldn't continue.
- **Root Cause**: The panel passes `() => generator?.effect`. Inside `$effect` that getter subscribes to the `generator` derived, and every edit of the layer replaces the generator object, so the effect re-ran on each scrub step even though the id string was unchanged. It cleared `description`, `effectLayerTiming` returned null, and `{#if timing}` unmounted the slider under the pointer.
- **Solution / Workaround**: Read getter arguments through `$derived` before the `$effect` (`const id = $derived(effect())`), so it only re-runs when the value changes. Don't clear async-loaded state that live controls depend on when the input is the same.

### [image-editor] Marching Ants Drawn Thick and Still in a Zoomed Host

- **Issue / Symptom**: In Pixerate's image studio (the canvas inside a CSS-scaled node), the selection outline was a thick black-and-white dashed band, and it never moved.
- **Root Cause**: `drawAnts` (and `drawDraftPath`) sized the line as `1 / projection.scale`, one CSS pixel. The other overlay chrome divides by `hostScale` (`u`) as well, but the ants didn't, so a host zoomed 3× drew them 3 screen pixels wide. `RenderOptions.antsOffset` existed, but neither `ImageEditorCanvas` ever changed it, so the dashes stood still.
- **Solution / Workaround**: Pass `projection.scale / u` to both, so the ants stay one screen pixel wide. The canvases run `startMarchingAnts` while a selection shows as ants and pass the offset on each render. Any new overlay that should stay a fixed size on screen must also divide by `u`, not only by the projection scale.

### [image-editor] `SelectionMask.data` Is a Getter Over Tiles: Read It Once, Never Write It

- **Issue / Symptom**: After selections moved to tiles, every agent tool on a 12 MP image took about half a second, although the selection operations themselves took under 10 ms.
- **Root Cause**: A `SelectionMask` stores its coverage as 256 × 256 tiles (`mask.surface`). `data` builds the full array on first read and caches it for the few masks read most recently. `describeSelection` summed `mask.data[i]` in a 12-million-step loop, going through the getter and its cache lookup on every step.
- **Solution / Workaround**: The getter now returns the most recently read mask's array straight away. Still, read `const d = mask.data` once outside a loop, and prefer the tile helpers for whole-mask questions (`selectionArea`, `bounds`, `combineSelections`, `invertSelection`), since they skip empty and uniform tiles. Never write into `data` or a buffer you passed to `createSelectionMask`, because the cached array and the tiles are shared between masks and history steps. Build a new mask with `createSelectionMask`, `selectionFromRegion` (only a rectangle's bytes) or `selectionFromTiles` (a painted surface, shared without copying).

### [image-editor] A Vector Mask Applied Twice When the Compositor Resolved Layers Again

- **Issue / Symptom**: A vector mask at density 0.5 showed the layer at a quarter opacity instead of half.
- **Root Cause**: `LayerCompositor` turns each layer with a vector mask into a copy whose raster `mask` already includes the path (`resolveVectorMasks`), in `composite`, `compositeTiles` and `tile`. The base `composite` calls `this.compositeTiles`, which is overridden, so the stack was resolved twice. The copy still had `vectorMask`, so the second pass multiplied the path in again.
- **Solution / Workaround**: The resolved copy deletes `vectorMask`, so resolving again is a no-op. Any future step that turns a layer property into its raster mask (or anything else the engine reads) must remove the property it consumed, because entry points that override each other can run the step more than once.

### [core/text] Vertical Text Lays Out in Line Space: Some Layout Fields Are Not Text Space

- **Issue / Symptom**: With vertical text, code that drew a caret from `caretAt(...).x/top/bottom`, a selection from `line.chars` and `line.baseline`, or an ink box from `fragment.x/y` put it on a horizontal line far from the columns.
- **Root Cause**: `computeLayout` lays every orientation out in *line space* (x along the line, y across lines stacking down) and, for vertical text, turns that 90° clockwise into text space with `layout.matrix` / `line.matrix`. `LaidLine`, `LaidChar`, `LaidFragment.x/y/carets` and `caretAt().x/top/bottom` stay in line space; `bounds`, `fragment.glyphs`, `caretAt().from/to`, `textSelectionQuads`, `textDecorations`, `textFragmentOutline` and `textIndexAt`'s input are text space.
- **Solution / Workaround**: Draw carets from `caretAt().from` / `to`, selections from `textSelectionQuads`, glyphs from `fragment.glyphs` (or `drawTextFragment` / `textFragmentOutline`), and map any other line-space box with `transformTextRect(line.matrix, …)` or `lineToTextSpace`. Move between lines with `textLineMove` and map arrow keys with `textArrowStep` (vertical: ↑ ↓ along a column, ← → between columns). For horizontal text the matrix is absent and both spaces are the same, so a mistake only shows with vertical text: test both.

### [core/text] Kerning Must Not Reach Upright Characters in Vertical Text

- **Issue / Symptom**: Upright CJK glyphs drifted off the column centre when a kerned pair (or any pair the shaper kerns) sat next to each other.
- **Root Cause**: Advances come from `shaper.measure` over a whole style segment, so the caret after a character includes kerning with its neighbour. Upright characters are centred on the column by their horizontal advance; using the segment's caret difference took a kern meant for side-by-side glyphs.
- **Solution / Workaround**: Layout measures each upright character on its own (`shaper.measure(char)`) for its width, and takes its advance down the column from `shaper.vertical` (`vhea` / `vmtx`), or ascent + descent when the shaper has none. Sideways characters keep the segment's (kerned) advances, as horizontal text does.

### [core/image-editor/psd] Vertical Type in PSD: `Ornt`, `WritingDirection` and `BaselineDirection`

- **Issue / Symptom**: Vertical Photoshop type came in laid out horizontally, and our vertical type would have gone out horizontal.
- **Root Cause**: The orientation lives in the `TySh` descriptor (`Ornt`: `Hrzn` / `Vrtc`) and in EngineData's `Rendered.Shapes.WritingDirection` and `Lines.WritingDirection` (0 horizontal, 2 vertical). Upright Latin (Standard Vertical Roman Alignment off) is the style's `BaselineDirection`.
- **Solution / Workaround**: Import reads `Ornt` into `TypeLayer.orientation` and `BaselineDirection` 1 into `upright` (2, rotated, is what ag-psd and our export write as the default; 3, tate-chu-yoko, is approximated with a note). Export writes all three. The value mapping and Photoshop's vertical point origin (we use the top of the first column's centre line, and a box's right edge) are inferred, not verified against Photoshop files: check a real vertical PSD before relying on exact placement. `typeSignature` adds `'vertical'` only for vertical layers so horizontal layers loaded from older documents keep their stored `TySh`.

### [vector/trace] Marching Squares Cuts Square Corners, So a Traced Rectangle Came Out Skewed

- **Issue / Symptom**: `selection_to_path` on a rectangular selection gave a four-anchor path whose sides were slightly slanted, about half a pixel over the length of a side, instead of a rectangle.
- **Root Cause**: Marching squares puts a contour point on each crossing between pixel centres, so a square corner becomes a half-pixel diagonal. Simplifying within the tolerance (0.5–1 px) then keeps one point of each diagonal, joining sides that should be axis-aligned at a slight angle. Simplification also always keeps a ring's first point, so a ring that starts mid-edge keeps a redundant anchor.
- **Solution / Workaround**: `traceField` takes `squareCorners: true` (used for selections). It replaces each half-pixel diagonal between an axis-aligned run and a perpendicular one with the corner where the runs meet, and starts the ring at a turn. Interpolated (anti-aliased) edges aren't axis-aligned, so they're left alone. Diagonal tests need about ±0.02 px of slack, because a threshold of 128/255 moves crossings slightly off the half pixel. Leave it off for image tracing, where pixel-art corners may be meant to be cut.

### [core/image-editor/selection] Magnetic Lasso: Backspace Did Nothing Because the Anchor Came Straight Back

- **Issue / Symptom**: With the Magnetic Lasso, Backspace removed the last anchor, but the anchor count didn't drop: a new anchor appeared in the same place.
- **Root Cause**: After removing the anchor, the gesture rebuilt the live path to the pointer, and that rebuild places anchors every `frequency` px. The pointer was still far from the previous anchor, so it placed one again at once.
- **Solution / Workaround**: `followEdges(point, false)` rebuilds the live path without placing anchors. Anchors are only placed again once the pointer moves. Use the same flag for any other rebuild that isn't caused by pointer movement.

### [core/image-editor/selection] Graph Cut Took Hundreds of Milliseconds on a Small Grid With Fractional Capacities

- **Issue / Symptom**: A Quick Selection stroke on a plain background took over 300 ms in max-flow on a 116 × 87 grid, while the same stroke elsewhere took 2 ms.
- **Root Cause**: The capacities were floating-point colour costs. After subtracting a path's flow, a residual that should be zero was left a hair above it, so the search kept finding paths that could carry almost nothing and pushed thousands of them.
- **Solution / Workaround**: Round capacities to whole numbers (`UNITS = 64` steps per unit of cost) before handing them to `GridGraph`. With integers the bottleneck edge reaches exactly zero. The whole-image case dropped from about 430 ms to about 110 ms. Do the same for any other graph built on `GridGraph`.

### [core/image-editor/selection] Decontaminating a Layer via Copy Read Black as the Background

- **Issue / Symptom**: With output `new-layer` and Decontaminate Colors, edge pixels turned dark and bluish instead of taking the subject's colour.
- **Root Cause**: The background colour was estimated from the new layer's own pixels. Layer via Copy creates a surface that covers only the selection's bounds, so `readRegion` returned transparent black outside them, and those zeros were averaged in as the background.
- **Solution / Workaround**: `decontaminateLayer` estimates colours from the source layer, whose background is still there, and writes only RGB into the new layer, keeping the new layer's alpha. Any edge-colour estimate on a cut-out layer should read the layer it was cut from.

### [core/image-editor/selection] A Selection Job in a Worker Can't Be Interrupted, Only Ended

- **Issue / Symptom**: Cancelling a long selection (Select Subject on a large image) did nothing until it had finished.
- **Root Cause**: The segmentations are synchronous. A worker handles one message at a time, so a "cancel" message waits until the running job returns.
- **Solution / Workaround**: `SelectionWorkerClient` cancels by terminating the worker and rejecting its pending jobs with an `AbortError`. The next job starts a fresh worker from the factory and sends the pixels again, because the new worker has none of the old one's cached images. That is why `setSelectionWorker` takes a factory, not a `Worker`. On the page, without a worker, a job can't be stopped part-way: the signal is checked before and after it, and an aborted job's result is discarded.

### [core/image-editor] Library Worker Entry: Bundled by the Host, Inert When Imported Elsewhere

- **Issue / Symptom**: The algorithms the selection worker needs import many modules, so the `Function.prototype.toString` Blob trick used for the wet-paint worker can't build it. Also, `check:packages` imports every subpath in Node, where a worker entry that set `self.onmessage` would fail.
- **Root Cause**: A worker made from one function's source contains only that function. Node has no `self`.
- **Solution / Workaround**: `@pixerate/editor/image-editor/selection-worker` is a normal package entry that the host bundles as a worker, for example `import SelectionWorker from '…/selection-worker?worker'` in Vite. It starts only when `self` exists, `window` doesn't, and `self.postMessage` is a function, so importing it anywhere else does nothing. `SelectionWorkerLike` types its event handlers loosely so a DOM `Worker` fits without a cast.

### [svelte] A Session That Emits Synchronously When Opened Loops an `$effect`

- **Issue / Symptom**: Opening the Svelte Content-Aware Fill workspace failed with `effect_update_depth_exceeded`. The Select and Mask workspace, written the same way, worked.
- **Root Cause**: The `$effect` subscribed `() => tick++` and called `session.open()`. `ContentAwareFillSession.open` emits before its first `await`, so `tick++`, which reads `tick`, ran inside the effect. The effect then depended on `tick` and reran every time it emitted. `SelectAndMaskSession.open` awaits the pixels before emitting, so it never hit this.
- **Solution / Workaround**: Run the subscribe-and-open inside `untrack(() => ...)` in the effect. Do this for any effect that starts something that may notify synchronously.

### [core/image-editor] Stored Path Anchors Have No Smooth/Corner Type

- **Issue / Symptom**: Dragging one handle of a smooth anchor on a path, shape or vector mask bent it into a corner: the opposite handle stayed put.
- **Root Cause**: `normalizeSubpaths` (behind every path, shape and vector mask setter) keeps only `x`, `y`, `in`, `out` and `corner`, so the vector editor's `type: 'smooth' | 'symmetric'` is gone by the next drag, and `moveAnchorHandle` treats an untyped anchor as a corner.
- **Solution / Workaround**: Before moving a handle, give the anchor `type: a.type ?? inferAnchorType(a)` (handles in line count as smooth), then drop `type` from the result. `PathEditGesture` does this; Alt-drag still breaks the handles on purpose.

### [core/raster] A Tile From the Compositor's Cache Must Be Copied Before It Is Changed

- **Issue / Symptom**: An effect applied to a layer's content tile in the blend step (the live edge cast) can leak into later renders, or into other layers that share the tile.
- **Root Cause**: `contentTile` returns the surface's own tile data when the tile is aligned and unfiltered, and filtered tiles come from `contentCache`. Both are shared buffers, not copies.
- **Solution / Workaround**: Copy the tile (`new Uint8ClampedArray(content)`) before changing it, as `runStep` does for `edge.ambient`. Anything that depends only on the layer's own pixels and mask belongs in its pixel filters instead (`PixelFilterSpec`, cached per surface), as decontamination and despill do. The deep compositor draws those layers alone at 8 bits, so strip the live cast from the solo layer and apply it in float.

### [core/image-editor] Marching Ants Flash Instead of Marching on Diagonal Edges

- **Issue / Symptom**: On a selection with diagonal or curved edges, the marching ants did not move along the edge. The whole outline flashed between black and white. Straight horizontal and vertical edges marched correctly.
- **Root Cause**: The outline was stroked as one `moveTo` / `lineTo` subpath per pixel-boundary segment. Canvas restarts the dash pattern at the start of every subpath. On a staircase each segment is one image pixel long, shorter than a dash at most zooms, so every segment was wholly dash or wholly gap, and all of them changed together as the offset moved.
- **Solution / Workaround**: Join the segments into polylines (`selectionOutlinePaths`) and stroke each as a single subpath, so the dash runs continuously along the edge. This applies to any dashed outline built from short segments.

### [core/image-editor] Hybrid Mask Edges Are Addressed by Segment Index

- **Issue / Symptom**: After an anchor was inserted on a vector mask's subpath, a soft (feather or matte) edge moved to the neighbouring segment.
- **Root Cause**: `VectorMask.edges` names segments by `{ component, subpath, segment }` index. Inserting or deleting an anchor renumbers the segments after it. The path tools edit components without knowing about edges, and nothing in an anchor identifies its segment.
- **Solution / Workaround**: Edges that no longer address a segment are dropped (`validVectorMaskEdges`) whenever the path is replaced or edited. Ones that still address a segment keep their index, so check `get_vector_mask` `edges` after adding or removing anchors and set them again. A lasting fix would give segments ids that travel with their anchors.

### [core/image-editor] A Selection Command Only Keeps the Recipe If It Records a Step

- **Issue / Symptom**: A new selection command (or an existing one changed to call `setSelection` differently) left the selection frozen. Its recipe vanished even though the command could be replayed.
- **Root Cause**: `setSelection` keeps or extends the recipe only when the caller passed a step through `withRecipeStep`. Without one it drops the recipe, which is the safe default for commands a recipe cannot describe. A command that calls `setSelection` directly therefore freezes the selection.
- **Solution / Workaround**: Wrap the `setSelection` (or `shapeCommand`) call in `withRecipeStep(step, …)`, with a step `replaySelectionRecipe` can reproduce from JSON alone. Add the op to `readRecipeStep` and `replaySelectionRecipe` first. Commands that depend on something a step can't hold (a brush gesture, a model, a loaded mask) should keep dropping the recipe.

### [core/image-editor] Anti-Aliased Edges Counted as Soft in `inspect_mask_edge`

- **Issue / Symptom**: `inspect_mask_edge` reported "Very soft" (`softFraction` 1) for a clean Magic Wand or ellipse selection of a hard-edged object, so its `issues` were never empty for curved subjects.
- **Root Cause**: Every partly selected pixel in the edge band counted as soft. Anti-aliasing makes every pixel on a curved or diagonal edge partly selected, and the wand's anti-aliasing ramps over two pixels.
- **Solution / Workaround**: A partly selected pixel counts as soft only when it has no fully selected and no unselected pixel within 2 px, so the measure picks up feathered and matted transitions and not anti-aliasing. When writing a mask metric, test it on an anti-aliased hard edge as well as on a soft one.

### [core/spreadsheet] Imported Text Is Parsed as en-US Typing, Silently

- **Issue / Symptom**: Cleaning a day-first export left wrong dates with no error: `02/04/2026` (2 April) was stored as `2026-02-04`, while `31/03/2026` stayed text. `1,250` from a comma-decimal export became 1250, and `007` became 7.
- **Root Cause**: `setCellValue`, `set_range` and imports run each string through `parseCellInput`, which reads input as a person in the US types it (month-first dates, comma thousands). Only `raw` keeps what came in.
- **Solution / Workaround**: Read `raw` as well as `values` when cleaning or testing imported data. Rewrite a day-first column's dates from `raw` as ISO text, and write codes that must keep their zeros with a leading `'`. Test fixtures that type data the same way get the same parsing.

### [svelte/image-editor] Host Sidebars Built From `layerPanels` Missed the Masking Panels

- **Area**: `layerPanels` (core `layers/panel.ts`), Svelte `LayerPanel`
- **Symptom**: An app that lays out its own sidebar from `layerPanels` + `LayerPanel` (Pixerate's Image Studio) had no Refine Edge, Check Edge, Show Last Change, Separate Subject, Channels, Paths, Edge Colour or vector mask edge controls, and a layer with a mask showed a "Panel mask" placeholder. Only the editor's own `ImageEditor` and `LayersPanel` mounted them.
- **Root Cause**: New panels were mounted directly in `ImageEditor.svelte` / `LayersPanel.svelte`; `layerPanels` and `LayerPanel` were not updated, and `layerPanels` already returned a `mask` id that `LayerPanel` had no case for.
- **Solution**: Every panel a feature adds must be reachable through `layerPanels` and rendered by `LayerPanel` (`selection` includes Refine Edge; `channels`, `paths` and `mask` are their own ids). `image-editor-controls.svelte.test.ts` mounts every id `layerPanels` returns and fails on a placeholder.

### [core/skills] A Workflow Eval That Accepts Only Its Own Solution

- **Area**: `skills/*/evals/*.json`
- **Symptom**: An agent that followed the workflow skill still failed the eval. In `neutralise-cast` Pixie fixed white balance with the base sliders, which the skill allows; in `grounding-shadow` she cut the product out with `separate_subject` (a masked layer).
- **Root Cause**: The checks were written from the eval's own `solution`: "an adjustment layer exists", "a pixel layer has the product's bounds", and a card brightness only that solution's levels produced.
- **Solution**: Write each check from the skill's quality bar and the user's words, and accept every route the skill offers (`$in` for alternatives, `$expr` across layers). `agent-skill-evals-alternatives.test.ts` proves the other routes pass; add a case when an eval's check names one specific way.

### [core/paint-editor] Effect Paint Is Rendered Before Strokes, Not During Them

- **Issue / Symptom**: Painting with a provider effect (`set_effect_paint`) cannot render the effect dab by dab: a stroke started while the effect was still rendering, or a replay of a loaded painting, had no colours to paint with, and a GPU provider rendering per dab would be far too slow.
- **Root Cause**: Stroke sessions (`paint-editor/stroke.ts`) and the CPU engines are synchronous (pointer input, `paintStroke`, `replayStrokes`), while effect renders are asynchronous (`EffectRendererPool`). Replays must also be exact, so the colours cannot depend on render timing.
- **Solution / Workaround**: The effect is rendered once at the canvas size when it is chosen and cached by `effectPaintKey(source)` (`JSON.stringify` of the source). Engines get the pixels through `StrokeSessionInit.effect`: `DryStroke`, `ParticleStroke` and `BristleStroke` fill the per-pixel colour `field` of `CoverageMap.accumulate` (alpha multiplies coverage); `PaintDabStroke` samples at the dab centre. Strokes throw while it renders (`effectPaintRendering`). Wet and impasto drivers load the brush with the effect at the dab centre, then deposit a per-pixel `field` from `effectDabField`, shifted by how far the exchange's mixed paint moved from that centre colour (picked-up paint drags through the pattern); wet coverage is re-quantised to `COVERAGE_STEPS` after the alpha so replays stay exact. Sticker sprays sample the effect at each sticker's centre and skip stickers where it is transparent. `stroke.paint` records the source, not pixels; `replayPainting` and the `replay_strokes` tool call `prepareEffectPaints` / `prepareStrokeEffects` first, and `replayStrokes` throws naming the effect and provider when they are missing. Keep `PaintEffectPaint` out of the shared `PaintSource` union, which the image editor also uses.

### [core/raster] A Chiselled Bevel Reads the Shape Further Than It Paints

- **Issue / Symptom**: Painting on a layer with a chisel-soft pillow emboss (`size: 8, soften: 2`) left pixels 4–6 levels off a fresh composite from the first dirty dab on. With satin in the same stack the mismatch disappeared.
- **Root Cause**: `effectsMargin` (from `effectReach`) is both how far an effect paints and how far `patchEffectMaps` rebuilds around a change, so it must cover every pixel a map pixel depends on. A bevel's reach was `size + soften + 1`, which fits the smooth technique. Chiselled heights read the nearest edge up to `size + 2` px away (`edgeDistances`), plus one px for its Sobel normal; chisel-soft and soften then blur the heights again and the lighting reads one more px. Satin's larger margin covered the shortfall.
- **Solution / Workaround**: `effectReach` adds those terms for chisel techniques. When an effect's renderer changes, recount its dependency radius (not only how far it paints) and test the effect alone, not only in a stack with a wider effect, in the incremental painting test in `raster-effects.test.ts`.
### [core/tools] `listTools()` Returns New Definition Objects on Every Call

- **Issue / Symptom**: A cache keyed by `McpToolDefinition` or `ToolsetInfo` objects (a `WeakMap`, or reusing a result when the `tools` array is the same) never hits on the real `search_tools` path, so `searchTools` kept re-indexing all ~580 tools (~14 ms per query, even one matching nothing).
- **Root Cause**: `ToolRegistry.listTools()` builds each definition afresh (`toDefinition` spreads the `AgentTool`), `toolsets()` builds new `ToolsetInfo` objects, and `ToolRegistryView` filters them into new arrays per call. Some providers also build new tools, schemas included, on every `tools()` read (rich text formatting, `run_command`, the effects providers).
- **Solution / Workaround**: Key per-tool caches by content: `search.ts` caches token sets by the text itself (`tokenCache`, cleared past 20k entries) and argument text by `inputSchema` object, which the spread keeps. That survives fresh listings and invalidates on any change to a name, title, description or toolset text. Don't rely on definition identity across `listTools()` calls.

### [core/animation-editor] Camera Moves Are Timed Without the Provider and Drawn With It

- **Issue / Symptom**: A shot's camera move (`camera.in` / `during`) needs the provider's `cameraView`, but `compileMotionScene`, `checkMotionScene`, Lottie and the Flair import are pure and provider-free; a scene saved with `{ "in": "camera-whip-pan" }` timed its move as 1000 ms without a provider and as the move's 450 ms with one. And a whip pan sampled at the export's fps was tweened across its cut, because the jump between two samples can be smaller than half a framing.
- **Root Cause**: `durationMs` lives in the provider's catalog, and the camera box track is all the compiled timeline knows. The cut of a move is somewhere between two samples.
- **Solution / Workaround**: `setShotCameraMove` writes a transition's `ms` (the move's `durationMs` when none is given) and a preset's values onto the shot, so timing and values never need the provider; only the view does. The box track stays the degraded path, and `motionCameraViewAt` overrides it inside a move's window (and after a hold move until the next framing). `toFlairSvgMotion` finds a cut by halving towards the larger change (`viewJump`): a smooth move shrinks to nothing, a jump keeps its size, and the cut is written as a change of no length.
### [svelte/image-editor] Selection and Shape Panel Options Never Reached a Host's Canvas

- **Area**: Svelte `LayerPanel`, `ImageEditorCanvas` (`selectionOptions`, `shapeOptions`, `typeOptions`)
- **Symptom**: In a host sidebar built from `layerPanels` + `LayerPanel` (Pixerate's Image Studio), picking Lasso in the Selection panel or Ellipse in Shape Options changed nothing on the canvas: it kept selecting with the Magic Wand and drawing rectangles.
- **Root Cause**: `LayerPanel` kept its own `$state` copies of the options. The canvas takes them as props from the host, which never saw the panel's copies.
- **Solution**: `LayerPanel` takes bindable `selectionOptions`, `shapeOptions` and `typeOptions`. A host binds the same state to the panel and the canvas. Unbound, the panel still keeps its own (the editor's own `ImageEditor` is unaffected).

### [monorepo] Vitest "Cannot find native binding" When Run Through an Intel `timeout`

- **Area**: Local test runs on Apple Silicon (rolldown native binding)
- **Symptom**: `vitest` fails at startup with "Cannot find native binding … Cannot find module '@rolldown/binding-wasm32-wasi'", though `@rolldown/binding-darwin-arm64` is installed and loads from plain `node`.
- **Root Cause**: The command was wrapped in Homebrew's `/usr/local/bin/timeout`, an x86_64 binary. A universal `node` started from it runs under Rosetta as `x64`, so rolldown looks for `binding-darwin-x64`.
- **Solution**: Run vitest without the Intel wrapper, or prefix it with `arch -arm64`. Check with `node -p process.arch` under the same wrapper.

### [core] A Masked Layer's Stored Pixels Are Not What It Shows

- **Area**: `extractNormalizedLayerItems`, `separateSubject` (image editor)
- **Symptom**: After Separate Subject, a host's layer list (Pixerate's image node composition layers) showed the subject layer as a whole copy of the photo, though the editor showed only the subject.
- **Root Cause**: Separate Subject's subject is a duplicate of the source layer (for a photo, the document-backed Background) with a mask from the selection. The layer items took each layer's stored pixels, or the document image for a `source: 'document'` layer, and ignored masks. Layer via Copy bakes the selected pixels, so it looked right.
- **Solution**: Items for masked pixel layers use `controller.getMaskedLayerImage(id)`: the layer's pixels through its raster and vector masks, cropped to what shows, cached per layer object. Anything that turns layers into images outside the compositor must apply masks the same way.
### [core/video-editor] A Camera Cut Is Two Keys at One Time

- **Issue / Symptom**: Baking a whip pan (a camera move that cuts half way) into a clip's transform keys either tweened across the cut (one key a frame either side, interpolated) or was refused by `sortVideoKeys` / `parseVideoKeyframes` ("Two keys are at 200 ms"), and a zero-length segment made `videoKeyframeFfmpegExpr` divide by zero.
- **Root Cause**: Video keyframes allowed one key per time, so a discontinuity could only be faked with a `hold` ease from the frame before, which loses the motion up to the cut.
- **Solution / Workaround**: Two keys may share a time (a jump): the first is the value just before, the second the value from there on. `videoValueAt` already takes the last key at or before a time, so it reads the second at the jump; a stable sort keeps the pair's order; three at a time are refused; the ffmpeg expression treats a zero-length segment as a step. Speed ramps (`timeRemap`) still refuse jumps (`sortVideoKeys(keys, { jumps: false })`). Camera moves are baked keys: after a trim, `camera-stale` asks to set the move again.

### [demo] Content in an `EditorPanel` Is Not Inside the Tab's DOM, and Hidden Views Stay Mounted

- **Issue / Symptom**: A tab's `ref.current.querySelector(...)` (or a capture of the tab's element) doesn't find a control that is clearly on the page. An agent tool keeps working, and its provider stays registered, after you switch to another view of the same tab.
- **Root Cause**: `EditorPage` (`apps/demo/src/components/EditorPage.tsx`) lays every editor out as views plus a side rail and an Options menu. `EditorPanel` portals its children into the rail or the menu, so React context still reaches them but the DOM nodes live outside the view. Views mount the first time they're opened and then only get `hidden`, so their state (and tool providers) survive switching views. Rail panels and the Options menu are mounted while closed for the same reason.
- **Solution / Workaround**: Keep anything a tab finds through the DOM (the editor surface, capture targets, agent playback containers) in the view itself, not in an `EditorPanel`. A provider that agents must see as soon as the tab opens has to register from the tab component or its first view, not from a later view. To show a panel from code (an export finishing), call `useOpenPanel()(id)`.

### [core/paint] Wet Light Is a Fifth Mass Channel: Keep All Three Kernels and Every Loop in Step

- **Issue / Symptom**: Glowing watercolour (#494) adds light to the wet simulation. A loop over the pigment channels that still says `q < 4` (blot, blend, wet smudge, partial dry, snapshots, GPU uploads) silently leaves light behind: it stops moving with the paint, or comes back after undo.
- **Root Cause**: Light is stored as a fifth "pigment" channel so the step moves it with the same flux, bleed, settling and lifting: suspended light at `P_P0 + 4` (`P_L`) in each set and settled light at `P_D0 + 4` (`P_DL`). `SET_PLANES` went from 18 to 19 and `SLOT_PLANES` from 43 to 46, so every hard-coded plane number moved (the edge is now plane 18, the deposits 38..42, the height 43). `MAX_WET_SLOTS` came down from 352 to 328 to stay inside wasm32's 4 GB.
- **Solution / Workaround**: Loop to `MASS_CHANNELS` (5) wherever light should follow the paint, and to `PIGMENT_CHANNELS` (4) only for colour maths (`sample`, `stats`). Change `stepSlotTs` first (the specification), then `assembly/wet.ts` (run `pnpm build:wasm`) and `gpu-kernels.ts`. `tests/paint-wet-kernel.test.ts` lays light in its scene and compares TypeScript with WebAssembly bit for bit, and `tests/paint-wet-light.test.ts` checks that light never changes the water or pigment bits and that light laid in proportion to a pigment channel stays exactly in proportion. Cost on a fully wet 2048² canvas (one wasm thread, M-series): about 8% more time per step and 7% more memory.

### [core/paint] A Wet Bake Keeps the Film's Hiding in Alpha, and Glowing Paint Bakes as Its Own Hue

- **Issue / Symptom**: Backlit paper needs to tell a transparent glaze from gouache of the same colour after both have dried, and a glowing glaze on dark paper first came out as a near-black pixel with nothing for its glow to colour.
- **Root Cause**: A wet bake writes the film as colour plus alpha over the paper colour. Any alpha from the least the colour needs (`aMin`) up to 1 composites the same over the paper, so the bake used to pick `aMin` and the paint's opacity was lost. A transparent glaze over dark paper is darker than the paper in every channel, so its stored colour is close to black, and glow is `light × the layer's colour`.
- **Solution / Workaround**: `filmPixel`, `shadeTile` and the GPU shade write `alpha = aMin + hide·(1 − aMin)`, where `hide = 1 − e^(−HIDE·S)`. Watercolour (S = 0) bakes exactly as before; gouache and oil come out more opaque, with the same look over the paper. `backlight.ts` reads it back as `hide = (a − aMin) / (1 − aMin)`. Where a cell holds light, its film moves towards the film over white by `min(1, light)`, so glowing paint shows its own hue whatever is under it.

### [core/paint-editor] Backlit Paper Is an Approximation Outside Watercolour on the Paper, and Is Added at the Top

- **Issue / Symptom**: The backlight looks right for washes straight on the paper. Through stacks of layers, blend modes, or paint lighter than the paper, it is only close.
- **Root Cause**: Each pixel's transmission is read from its colour over the paper: `T = min(1, e / p)` per channel (linear), times `1 − hide` from the alpha above `aMin`. That is exact for a glaze on the paper. Paint lighter than the paper in a channel passes that channel fully. Upper layers are read against the paper, not against what is under them. Blend modes are not modelled. Light passing through the paint has to show over everything, so the "Backlight" Linear Dodge layer goes at the top of the stack, not just above the paper (a layer above it would cover it). It is drawn opaque, its colour the light added, because the compositor blends in sRGB with the W3C formula, so light paint's colour-over-alpha encoding would act like Screen. The added value is the linear light, added in sRGB, which is an approximation of adding light.
- **Solution / Workaround**: Test backlight with glazes straight on the paper, on paper that is not white (white paper plus any light clips at 255). Its spill is drawn from the committed painting, like light paint's, so a live stroke does not redo the blur every frame. The result is cached per 256 px tile on the layer tiles under it.

### [core/paint-editor] A Strand of Springs Resonates: Lightly Damped Chains Fly Apart

- **Issue / Symptom**: The first `elastic` and `fuzzy` particle strands (#487) flew apart at the start of a stroke with low `damping` or high `stiffness`: zigzags hundreds of pixels long, then the stroke settled. A ribbon over them filled the whole canvas and took seconds per stroke.
- **Root Cause**: Each mass in a strand chases the one before it (`v = (v + k·e)·damp`), so a strand is a chain of six damped springs. Each lightly damped link has a resonance gain well above 1, and the chain multiplies it link by link, so the jolt of the pen starting is amplified thousands of times. The `string` kind has the same structure; its presets are damped enough, and its motion is kept as it was.
- **Solution / Workaround**: The new kinds clamp each link's velocity kept per step to just under critical damping for this update, `1 / (1 + 0.8·√k)²` (`chainDamp` in `procedural.ts`; critical is `1 / (1 + √k)²`). Any new chained or cascaded spring motion should do the same. Elastic links are also slack under compression (they only pull when stretched past their rest length): pushing them apart from a coincident start kicked the chain in random directions.

### [core/paint-editor] Ribbon Fill Is Telescoped Into the Coverage, or Its Seams Show

- **Issue / Symptom**: Filling each band of a particle ribbon as its own polygon into the stroke's `CoverageMap` leaves faint lines wherever bands meet (between neighbouring strands and between steps).
- **Root Cause**: `CoverageMap.accumulate` builds up as `c ← c + v·(ceil − c)`, not by adding. Two bands that each cover half of a pixel on their shared edge give `0.75·ceil` there, against `ceil` inside.
- **Solution / Workaround**: `addPolygonArea` uses a half-open crossing rule, so bands that share an edge split its pixels exactly (their areas add to 1). The ribbon keeps a per-stroke map of the area filled so far, `s`, and lays `v = (s₁ − s₀)/(1 − s₀)` for each new band. The product of the `(1 − v)` terms telescopes to `1 − s`, so the coverage is `ceil·s` however the bands are grouped. Bands are laid one pair at a time, over that pair's own bounds: a union rectangle over many flow particles cost seconds per stroke.

### [core/paint-editor] Paint Layers Already Carried `effects`; Share the Image Editor's Layer Style Code, Don't Fork It

- **Issue / Symptom**: A paint layer with `effects` set by hand was already drawn with its glow, saved and written to PSD, yet the paint editor had no way to add, change or undo one, and no panel or agent tool for it (#487).
- **Root Cause**: `PaintLayer` is the shared `RasterLayer`, which has `effects`; the shared compositor renders them, the image serializer keeps them and the PSD writer writes them as layer styles. Only the editing layer (controller methods, tools, panel) lived in the image editor and was typed to `ImageEditorController` / `ImageLayer`.
- **Solution / Workaround**: The paint controller has its own `addLayerEffect` / `updateLayerEffect` / `removeLayerEffect` / `setLayerEffectsEnabled` (built on `raster/effects/model`, with `commitOrAmend` for slider drags). The six tools are `createLayerEffectTools(host, { layers, error })` in `image-editor/effect-tools.ts`, and the React and Svelte `LayerEffectsPanel` take any `LayerEffectsController`. Reuse those for another editor. A host without a global light (the paint editor) gets no `set_global_light`, and its shadows follow the default 120° / 30°. Layers derived from a layer for export (light spill, backlight) are built fresh, so they don't copy its effects; keep it that way, or the glow is doubled.

### [core/paint-editor] Provider Stickers Draw From Loaded Art: Load It First, or the Redraw Is Refused

- **Issue / Symptom**: A sticker brush with a host library's sticker (#488) painted nothing the first time, and a sticker layer edited before its art arrived would have lost those stickers on the redraw.
- **Root Cause**: The spray and the sticker layer redraw are synchronous, and a `StickerProvider` loads art asynchronously (and may need a browser to rasterise SVG). The editor's own stamps are procedural and need nothing; any other sticker has no pixels until `load()` has returned and been rasterised.
- **Solution / Workaround**: `PaintEditorController.prepareStickers(refs)` loads and rasterises art once into a cache (`StickerArtCache`, 256 px on the longest side, scaled when drawn). `setBrush` and `loadJSON` start it; every agent tool that sprays, places or redraws stickers awaits it first. A spray before the art lands skips those stickers and reports them in `skippedStickers`. `commitStickers` refuses (`requireStickerArt`) when a sticker on the layer has no art yet, rather than redrawing it away. PNG data URLs decode anywhere. SVG and `https:` art use `createImageBitmap` and `OffscreenCanvas`, or the host's `rasterizeSticker` option, so Node tests use providers that offer PNG.

### [core/paint-editor] Sticker Brushes and Stickers Hold Refs Now; Bare Stamps Still Read

- **Issue / Symptom**: Code that compared `brush.sticker.stamps` with stamp names (`includes('star')`) or read `sticker.stamp` stopped matching: stamps are `editor:star`, and a host library's sticker has no `stamp`.
- **Root Cause**: Sticker brushes and placed stickers name any sticker from any library by ref (`provider:id`). `normalizeStickerSettings` and document loading turn a bare editor stamp into its `editor:` ref, and `Sticker.ref` replaces `stamp`, which is kept (optional) only for editor stamps.
- **Solution / Workaround**: Compare refs (`normalizeStickerRef`, `editorStampOf`, `stickerStamp(sticker)`). `toggleStickerRef` replaces `toggleStamp` for brush lists. The editor's stamps still draw procedurally, so old brushes and documents paint the same pixels (checked by a digest in `tests/stickers.test.ts`). A combined provider (`combineStickerProviders`) is `namespaced`: its ids are already refs, so use `stickerRefOf` / `stickerIdFor` rather than joining ids by hand.

### [core/stickers] Only the Image Editor Feeds an Inserted Sticker to an Effect; Vector and Canvas Have No Image Node

- **Issue / Symptom**: `insert_sticker` works in the vector, image and canvas editors, but treating the inserted sticker with an effect that takes a picture (a holo foil) only works in the image editor. On the canvas, a multi-colour sticker comes in as its outline in one colour.
- **Root Cause**: The image editor's smart filters render an effect with a layer as its picture. The vector editor has no raster image node (its provider effects draw vector art and take no picture), and the canvas has no image node either (its effects fill or overlay shape nodes). So a sticker goes into the vector editor as editable paths (it needs SVG art) and onto the canvas as a path shape from its `silhouette`.
- **Solution / Workaround**: In the image editor, `apply_effect` takes any effect with a picture input as well as filter effects (`applyImageInputs` on the shared effect tools), and the layer goes to `layerImageInput(d)`: `source`, else the first required image input. Effect summaries don't list inputs, so its `effect` argument is then any id, checked when applied. Effects on stickers in the vector editor and on the canvas need image nodes there first (follow-up to #488).

### [swift] The Swift Core Must Read and Write JSON the Way JavaScript Does

- **Issue / Symptom**: Ported code that used `JSONSerialization` or `Codable` produced schema validation messages in a different order, `Unknown property` errors for the wrong key first, and serialised documents that differed from the TS core's (`1e-07` for `1e-7`, keys reordered).
- **Root Cause**: JavaScript objects keep insertion order, except that integer-like keys ("2", "10") come first, ascending. `JSON.stringify` prints numbers as `Number.prototype.toString` (plain digits from 1e-6 up to 1e21, exponents with no leading zero outside). Messages and listings in the TS core depend on both, and Foundation's JSON follows neither.
- **Solution / Workaround**: `PixerateCore` has its own `JSONValue` / `JSONObject` (insertion order with JavaScript's integer-key rule), parser and `stringified()` (`jsNumber`). Use them for anything compared with the TS core. `packages/core/tests/swift-vectors.test.ts` writes the vectors the Swift tests read (`UPDATE_SWIFT_VECTORS=1` to rewrite after an intended change), and fails when the TS outputs drift from the committed file.

### [swift] Async Code Runs on the Caller's Executor; `Cancellable` Does Not Cancel on Release

- **Issue / Symptom**: `swift build` refused `ToolRegistry.callTool` ("sending 'call' risks causing data races"), and a dropped `onCommit` result would have unsubscribed at once.
- **Root Cause**: Under Swift 6, a nonisolated `async` function runs on the generic executor, so calling non-`Sendable` handlers, histories and registries from it crosses isolation. Separately, a `Cancellable` that cancels in `deinit` (as Combine's `AnyCancellable` does) ends a subscription as soon as its result is ignored, unlike the TS unsubscribe functions.
- **Solution / Workaround**: `Package.swift` enables `NonisolatedNonsendingByDefault`, so async code runs on its caller's executor, as JavaScript's does. Keep new targets on the same `settings`. `PixerateCore.Cancellable` only cancels when `cancel()` is called.
### [core/brushes] Facet Defaults Depend on the Engine: Migrate by Diffing Against a Skeleton of the Same Engine

- **Issue / Symptom**: Migrating v1 brushes (`PaintBrush`) to facet brushes by "store the field when it differs from its default", with one default per facet field, resolves Mixer Brushes, smudges and blenders back wrong: their pick-up, mixing or strength come back changed.
- **Root Cause**: One facet field lands in a different engine field per engine, with a different default. `behaviour.exchange.pickup` is `behavior.pickup` (default 0) on a dab brush but `mixer.wet` (default 0.5) on a Mixer Brush; `behaviour.mixing` defaults to `pigment` except on the Mixer Brush and the smudge (`rgb`); `behaviour.strength` is the blender's, the smudge's (0.7) or the wet tool's. A single default table can't describe that.
- **Solution / Workaround**: `BRUSH_FIELDS` in `brushes/resolve.ts` lists each facet field with the engine field it sets and the engines that read it. `resolveBrush` writes through it; `migrateBrushV1` builds a skeleton facet brush that resolves to the same engine (kind, tool, tip shape, marks kind, surface, an empty reservoir), resolves it, and stores only the fields that differ from that. Add a new engine setting as one `BRUSH_FIELDS` row, and both directions follow. `tests/brushes.test.ts` round-trips every preset and hand-built edge cases. Settings of blocks the engine never reads are dropped on migration, and the v1 `category` is derived again (`resolveCategory`), so those two are the only lossy parts.

### [core/brushes] Keep the Brush Model Off the Renderers: Import Mark Settings From `mark-settings.ts`

- **Issue / Symptom**: `@pixerate/editor/brushes` needs the sticker, particle and bristle settings (types, defaults, normalisers), which lived in `stickers.ts` and `procedural.ts` next to the stroke renderers. esbuild splits chunks by module, so importing them would put the renderers in every host that only reads brushes.
- **Root Cause**: Code splitting assigns whole modules to chunks; tree-shaking does not split a module's unused classes into a chunk the entry never loads.
- **Solution / Workaround**: The settings live in `paint-editor/mark-settings.ts`, which has no imports. `stickers.ts` and `procedural.ts` re-export them, so existing imports still work. Inside `brushes/` (and any future dependency-light module), import from `mark-settings.ts`. `entry-isolation.test.ts` checks that `brushes/index.js` reaches no stroke renderer. It does still reach the v1 `BUILTIN_BRUSHES` list, which shares `paint-editor/brushes.ts` with `normalizePaintBrush`, until the paint editor reads its presets from `BRUSH_PRESETS`.

### [core/brushes] Particle Stamp Lists Keep Repeats

- **Issue / Symptom**: `uniqueItems` on `tip.stamps` rejected the `bokeh-dots` and `twinkle-sparks` presets.
- **Root Cause**: For particle marks, repeated stamps weight the order (`['dot', 'dot', 'ring']` is two dots per ring). Only sticker (`objects`) marks count each stamp once, and `normalizeStickerSettings` dedupes those itself.
- **Solution / Workaround**: The schema allows repeats in `tip.stamps`. Don't dedupe stamp lists in shared code.

### [core/brushes] Host Filters Admit Brushes Whose Settings They Ignore: Profiles Need an "Ignored" Level

- **Issue / Symptom**: A host profile with only "supported / refused" couldn't reproduce the canvas and vector brush lists. Brushstrokes don't pick paint up and have no timing, yet `dirty-round` (pick-up), the gradient brushes and `ink-pen` (velocity thinning) are all in today's lists, and vector lists the light brushes too.
- **Root Cause**: The hand-written filters check the engine (`dab`) and, on canvas, light. They don't check the settings a brushstroke silently paints without.
- **Solution / Workaround**: Each capability in `BrushHostProfile` is `full`, `ignored` or `none`. `ignored` lets the brush through with a warning ("paints this brush without picking paint up"); `none` refuses it with a fix. Canvas has light `none` and vector light `ignored`. `tests/brush-library.test.ts` checks that `listPresets(CANVAS_PROFILE)` and `listPresets(VECTOR_PROFILE)` match `listCanvasBrushes()` and `vectorBrushstrokeBrushes()`. Keep them matching until phase 4 switches those editors to the profiles.

### [core/skills] Every Table Row Starting With a Backticked Word Counts as a Documented Tool

- **Issue / Symptom**: A reference skill's explanatory tables (a facet table whose first cells were `` `kind` ``, `` `tip` ``…) made `agent-skills.test.ts` report them as stale tools.
- **Root Cause**: The test reads every table row whose first cell is a backticked name (`^| \`name\` |`) as a documented tool, whatever table it is in.
- **Solution / Workaround**: Only tool and command tables start their rows with a backticked name. Start other tables' first cells with plain words ("Kind", "Canvas (`canvas`)").

### [core/brushes] The Stored-Brush Schema Is Too Strict for Patches

- **Issue / Symptom**: `update_brush { id, tip: { size: 20 } }` was refused with "Missing required property shape".
- **Root Cause**: `BRUSH_JSON_SCHEMA` requires `tip.shape`, which is right for a stored brush. The tools reused its facet schemas, and the registry validates arguments against the input schema before the handler runs.
- **Solution / Workaround**: `brushes/tools.ts` uses a copy of the facet schemas with `tip.required` removed. A patch keeps the brush's shape, and a new brush without one gets a round tip (reported in `problems`). Keep the stored-brush schema strict; relax only the tool inputs that merge.

### [core/paint-editor] Recorded Strokes Keep Facet Brushes on Disk but Engine Brushes in Memory (v1 Documents Still Replay)

- **Issue / Symptom**: Paint documents of version 1 store every stroke's brush flat, as the engine painted it (`brushToJSON`). Version 2 stores facet brushes. Converting the strokes in memory to facets would make every replay, time-lapse and `update_stroke` resolve brushes again, and any drift would change pixels.
- **Root Cause**: The engine needs the flat brush. `resolveBrush(migrateBrushV1(b))` paints exactly as `b`, but it is not deep-equal to `b`: the library category is derived again, and engine blocks the brush's engine never reads go back to their defaults.
- **Solution / Workaround**: `RecordedStroke.brush` stays the engine brush. Only `strokeToJSON` (strokes and `liveStrokes` in `toJSON`) writes facets, and `normalizeBrushStroke` reads either form per stroke: a brush with `kind` and no `engine` is a facet brush. `PAINT_SCHEMA_VERSION` is 2, so an older editor refuses a new document instead of misreading it. `tests/fixtures/paint-document-v1.json` is a version 1 document that must replay to its saved pixels, before and after re-saving it as version 2. When comparing brushes across the two forms, leave out `category` and `builtin`.

### [core/paint-editor] The Brush Library Is Async but the Paint Controller Is Not

- **Issue / Symptom**: A `brushId` for a saved brush, passed with a library on persistent storage, came up as the default pencil. `saveBrush` and `importBrushes` now return promises. `list_brush_presets` showed a brush that `set_brush` didn't know yet.
- **Root Cause**: `BrushLibrary` reads its storage asynchronously. The controller's state, `setBrush` and the strokes are synchronous, so it keeps a copy of the library (each brush as facets and as the engine paints it) and refreshes it when the library notifies.
- **Solution / Workaround**: The built-in presets (and the `brushes` option) are in the copy from the start. A `brushId` the library hasn't listed yet is chosen once it has. Await `controller.whenBrushesLoaded()` after writing to a shared library from somewhere else (another editor, the brushes__* tools) before using the new id. The controller's own `saveBrush` / `removeBrush` / `importBrushes` refresh before they resolve.

### [core/paint-editor] A Facet Patch Can't Remove Anything, and the Editor Must Replace, Not Merge

- **Issue / Symptom**: Two problems. `set_brush { paint: null }` used to drop a brush's own gradient, but facet patches only merge. And after the brush editor changed a stamp tip back to round, the old `tip.stamps` came back.
- **Root Cause**: `mergeBrushPatch` lays objects over objects; leaving a key out keeps its value. The editor sends the whole brush, and merging it over the active brush keeps every key the new brush no longer has.
- **Solution / Workaround**: `set_brush` takes `unset` (as `update_brush` does): `unset: ['colour']` drops the gradient. The brush editor calls `setBrushSpec` (a whole brush, replaced) instead of `setBrushFacets` (a patch). `setBrushEditorValue` starts a facet afresh when its kind changes (marks kind, tip shape, mark or tool).

### [core/paint-editor] Engine Edits Lose the Brush's Hints Unless They Are Carried Over

- **Issue / Symptom**: Editing a highlighter's size with a slider (`setBrush({ tip: { size } })`, the engine form) and saving it lost its variety, palette and `light.spill` radius of 0. A saved highlighter then spilled light again in hosts that apply the hint.
- **Root Cause**: `migrateBrushV1` builds facets from what the engine reads. Medium, variety, description, tags, suggested colours, light spill and glow, and motion hints aren't in the engine brush.
- **Solution / Workaround**: `brushSpecOf(next, from)` migrates the edited brush and carries the hints over from the facets it was edited from. It keeps them only if the brush still resolves to the same engine brush (a wet variety on a dab brush would change it). The controller keeps the active brush's facets next to its engine form, and uses them for `getBrushSpec()` and saving.

### [conformance] Contract Files Are Generated: Change the Code, Then Run `pnpm contracts`

- **Issue / Symptom**: `brush-contracts.test.ts` fails with "matches the code" after a change to a preset, the brush schema, a profile, the resolver, migration, the library tools or the editor sections.
- **Root Cause**: `packages/conformance/domains/brushes/*.json` are snapshots of `brushContracts()`, committed so the Swift port can conform to them. They are meant to change whenever the behaviour they describe changes.
- **Solution / Workaround**: Build the core, then run `pnpm contracts` (`node scripts/export-contracts.mjs`) and commit the changed files with the change that caused them. Never edit them by hand. Keep the package version out of the contracts: a release would change every file. Bump `BRUSH_CONTRACT_FORMAT_VERSION` only when a file changes shape. `@pixerate/conformance` is private, so changesets skip it: a first npm publish needs npm's trusted publishing set up for the new name first.

### [core/paint-editor] A Brush's Default Colour Is Taken When the Brush Is Chosen, Not When It Paints

- **Issue / Symptom**: Should the highlighter paint yellow? Applying `colour.default` at every stroke would override the colour the user just picked. Ignoring it would make the highlighter paint the last colour used.
- **Root Cause**: The colour belongs to the user. A brush's default is only a suggestion, unless `colour.own` is set.
- **Solution / Workaround**: The rule:
  - Choosing a brush (`setBrush` / `setBrushFacets` with an id, or a patch that sets `colour.default`) makes a solid or light / dark default the paint colour, unless `setColorLocked(true)` (`set_color` `locked`, "Keep my colour").
  - A colour taken from a light / dark default resolves again when `setColorScheme` changes, until the user picks another colour.
  - `colour.own` brushes paint their default at every stroke, resolved when the stroke starts. The stroke records the hex, so replays in another scheme stay exact.
  - Gradient defaults were already the brush's own paint. Effect defaults stay a suggestion.
  - The image editor's `setBrushPreset` takes the default as the foreground unless `keepColour`.
  - Canvas: `selectBrush(id, { keepColour })` takes the default (`CanvasBrushPreset.defaultColor`) for the controller's `colorScheme`, unless `setColorLocked(true)` (`canvas.setColorLocked`). Like paint, a light / dark default taken this way resolves again on `setColorScheme` until `setStyle` sets a colour (or the pen / highlighter switch resets the style); locking afterwards doesn't stop it following, since the colour is still the brush's. `drawStroke` with a brush and no `style.color` paints in it, so agents get the ballpoint's blue without asking; the lock doesn't apply there, since `drawStroke` ignores the picker's style anyway.
  - Vector: `addBrushstroke` and `setBrushstroke` with another brush take its default unless `keepColour` or `setColorLocked(true)` (`vector.setColorLocked`); an explicit `color` always wins. Existing strokes keep their colour when the scheme changes: vector has no current brush colour to follow.
  - A host that keeps the picked brush in its own state (the demo's canvas tab did) undoes an agent's `canvas.selectBrush` on the next render. Read the brush from the draw style instead.

### [core/paint-editor] Stamp Tips and Spray Run in Both Dab Engines

- **Issue / Symptom**: A stamp tip, or `marks: scatter`, painted round single dabs when the brush also picked paint up or used gradient paint.
- **Root Cause**: A dab brush paints through `DryStroke`, or through `PaintDabStroke` (the exchange path) when it picks paint up or takes gradient paint. At first only `DryStroke` asked `stampSampler` for the tip and scattered droplets.
- **Solution / Workaround**: Both engines rasterise stamp tips (`rasterizeStampDab`) and expand dabs into droplets with the shared `sprayDroplets(dab, spray, seed)`. In the exchange path each droplet picks up and lays paint, so a dirty spray mixes droplet by droplet. Keep droplet generation in that one helper so the two engines can't drift. The normaliser still drops scatter marks on bristle, wet and thick brushes and on the Mixer Brush, which have engines of their own. Provider sticker art must be loaded first (`prepareStickers`, which `set_brush` and `paint_stroke` call); until it is, the tip paints round. Canvas, vector and image profiles refuse stamp tips and scatter marks.

### [core/brushes] `BUILTIN_BRUSHES` Is Derived From `BRUSH_PRESETS`; Don't Import It Into `brushes/resolve`

- **Issue / Symptom**: Every facet preset in `BRUSH_PRESETS` used to need a hand-written flat twin in the paint editor's `BUILTIN_BRUSHES`. Deriving the list from the presets created an import cycle, because `brushes/resolve` imported `paint-editor/brushes` for `normalizePaintBrush`.
- **Root Cause**: The engine brush type and its normaliser lived in the same module as the built-in list that has to resolve the presets.
- **Solution / Workaround**: The engine brush (`PaintBrush`, its settings, `normalizePaintBrush`) lives in `paint-editor/brush-model.ts`, which `brushes/resolve` imports. `paint-editor/brushes.ts` re-exports it and builds `BUILTIN_BRUSHES` as `BRUSH_PRESETS.map((spec) => resolveBrush(spec, { builtin: true }))`. Add a preset to `BRUSH_PRESETS` only, then run `pnpm contracts`: `tests/brushes.test.ts` checks each built-in brush against the committed `resolved.json`. Never import `paint-editor/brushes` (or anything that does) from `brushes/resolve`, `brushes/presets` or `brush-model.ts`; use `brush-model` for engine types and the normaliser.

### [core/canvas] Canvas and Vector Strokes Copy a Saved Brush Into the Stroke

- **Issue / Symptom**: A canvas stroke or vector brushstroke drawn with a saved brush (`my-pencil`) stored only the id. A document opened without that library, or after the brush was removed, couldn't render it. The canvas renderer is a lazy chunk with no access to the host's library anyway.
- **Root Cause**: Presets are in the code, but saved brushes live in an async `BrushLibrary` the host passes in. Rendering is synchronous (`renderShapeBrushstrokeNow`, `vectorBrushstrokeImages`) and also runs where there is no library (SVG export, a document opened elsewhere).
- **Solution / Workaround**: Strokes embed the saved brush's facets: `CanvasBrushstroke.spec` and `VectorBrushstroke.spec`. Presets are never embedded. Resolution prefers the spec, and the spec is checked against `CANVAS_PROFILE` / `VECTOR_PROFILE` on every read. `drawStroke` and `addBrushstroke` look the brush up in the library. Hand-drawn strokes, which finish synchronously, take `style.brushSpec`, set by the brush picker alongside `brush` (`useCanvasBrushes({ library })` lists saved brushes with their `spec`). Changing a brush in the library later doesn't change strokes already drawn.

### [react/brushes] `BrushLibraryBrowser` Lives in Its Own Subpath

- **Issue / Symptom**: Using the paint editor's `BrushLibraryBrowser` in the canvas, vector or image editor would make those entries import `@pixerate/editor-react/paint-editor`, and its whole bundle with it.
- **Root Cause**: Subpath entries are bundled apart. `entry-isolation.test.ts` allows each one only its own core subpaths.
- **Solution / Workaround**: The browser and `useBrushLibrary` / `brushLibraryState` are in `@pixerate/editor-react/brushes` and `@pixerate/editor-svelte/brushes`. The paint editor re-exports the browser. Entries that draw a brush picker list `brushes` among their allowed core subpaths. Its thumbnails are pixels or an image URL, so canvas swatch data URLs work as they are.

### [core/vector] A Controller That Follows a Shared Library Must Survive `destroy()`

- **Issue / Symptom**: Unsubscribing from the brush library in `VectorEditorController.destroy()` left a controller that React StrictMode reuses (mount, unmount, mount) without saved brushes.
- **Root Cause**: `destroy()` is documented as reversible: a later `subscribe` reconnects. A library subscription made in the constructor isn't remade.
- **Solution / Workaround**: The library snapshot (`snapshotBrushLibrary`) stays subscribed for the controller's life. It only re-reads the library, so it is cheap. Read saved brushes synchronously from the snapshot, and await `whenBrushesLoaded()` before using a brush saved elsewhere.

### [core/brushes] `normalizeBrushSpec` Reads Gradients Leniently; Tools Must Check Them Strictly

- **Issue / Symptom**: `set_brush { colour: { default: <gradient with unsorted stops> } }` was accepted, and the stops were sorted silently. The old `set_brush { paint }` refused it with "sorted by offset".
- **Root Cause**: The normaliser reads documents, presets and libraries, where a fix-and-report is right. A tool argument should be refused.
- **Solution / Workaround**: The paint controller runs `readStrokePaint` (strict) on a gradient `colour.default` in `setBrushFacets`, `setBrushSpec` and `brushChanges` before normalising.

### [core/canvas] A Drop Changes Nothing the Change Feed Compares, So Followers Never Heard the Gesture End

- **Issue / Symptom**: An agent following the canvas (jazz) stopped responding after the user dragged a node. It waited forever for the drag to finish.
- **Root Cause**: During a drag, each move is reported with `inGesture: true`. The drop often only clears `dragging`, a runtime field the feed ignores when diffing, so `check()` found no change and reported nothing. Followers never got a change with `inGesture: false`.
- **Solution / Workaround**: The feed remembers whether the last snapshot was mid-gesture and reports the first change after a gesture as `gestureEnded: true`, even when nothing else changed (empty arrays). Followers that wait for gestures should treat `gestureEnded` as the end of the user's action.

### [core/paint-editor] A Change Feed Must Hear the Commit Before the Change, and a Group Only at Its End

- **Issue / Symptom**: The paint change feed tagged an accepted agent proposal, and agent strokes, as the user's.
- **Root Cause**: The controller notified state listeners (`emit`) before commit listeners (`onCommit`), so the feed diffed the document before it knew who made the step. Inside `group`, each inner change emitted on its own, before the group's single commit.
- **Solution / Workaround**: `commit`, `undo`, `redo` and merges call `notifyCommit` before `emit`. Inside `group`, inner changes don't emit; the group emits once, after its commit event. Keep that order in any new path that records a step.

### [core/paint-editor] A Paint Preview Can't Include Wet Paint

- **Issue / Symptom**: Previewing a watercolour stroke would leave the wet simulation changed after the preview rolled the document back.
- **Root Cause**: `previewPaint` restores the document, history and counters, but the wet simulation (`WetWorld`, workers) has state of its own that isn't part of the document.
- **Solution / Workaround**: `sessionFor` refuses wet brushes while `previewing`, before the simulation is touched. Paint proposals accept only dry engines (dab, particle, bristle, mixer without pickup).

### [react/paint-editor] `usePaintChangeFeed` Creates Its Feed in the Effect

- **Issue / Symptom**: Under StrictMode, the change feed stopped reporting anything after mount.
- **Root Cause**: A feed made in `useMemo` subscribes to the controller once. StrictMode runs the unmount cleanup (`dispose`) and remounts, which reuses the disposed feed.
- **Solution / Workaround**: Create the feed inside the effect, dispose it in that effect's cleanup, and keep it in state, so each mount has a live one. `feed` is `null` until mounted.

### [core/paint-editor] `stroke_path` Paints Through the Paint Editor's Engine, Not `paintPathStroke`

- **Issue / Symptom**: `paintPathStroke` in `@pixerate/editor/paint` looks like the obvious way to brush a vector path in the paint editor, but its strokes were not recorded, ignored the paper grain, pick-up, wet and thick paint, and could not be replayed or edited.
- **Root Cause**: `paintPathStroke` is the image editor's raster brush (the older `paint` module). The paint editor paints through its own engines (`runStroke`), which record every stroke as data.
- **Solution / Workaround**: `strokePath` samples the SVG path into pen points (`samplePath`: flatten, then resample every `spacing` px, with a pressure profile spread along each subpath and optional `speed` stamping `t`) and runs each subpath through `runStroke`, committing once, so the whole path is one undo step and every subpath is a recorded stroke. When `options.director` is set, `stroke_path` sends `{ kind: 'strokes', strokes, label }` to `PaintDirector`, which plays each subpath live inside `c.group(label, async (within) => ...)` so the whole path is still one undo step. An async `group` stays open until its promise settles, so while it is pending `requireIdle` refuses every other change (the user's strokes, undo, other groups) with "…is still being painted"; otherwise they would fold into the agent's step or be thrown away with it on a rollback. Changes the group makes after an `await` must go through `within(() => …)` (the director wraps each `beginStroke`). On a hosted layer the tool moves the path by `-origin` (`bezierPathToSvg` `offset`), because the coordinate mapping only rewrites point fields.

### [core/paint-editor] The Paint Contracts Take an Effect Provider

- **Issue / Symptom**: `paintContracts()` listed no effect tools, and bundling the fake effect provider into `@pixerate/editor/paint-editor` to fix that would ship test code to every paint host.
- **Root Cause**: `createPaintEffectsToolProvider` lists its tools only once the controller has an effect provider.
- **Solution / Workaround**: `paintContracts({ effects })` takes the provider. `scripts/export-contracts.mjs` and `tests/paint-contracts.test.ts` pass `createFakeEffectProvider()` from `effects/index.js`, so the committed `tools.json` doesn't depend on a real catalogue. Keyboard shortcuts live in `PAINT_SHORTCUTS`, which `handlePaintShortcut` dispatches from; add a key there, not in the handler, so `commands.json` stays true.

### [swift] SwiftPM Ignores Prefixed Version Tags
- **Issue / Symptom**: A tag like `swift-v0.1.0` (or changesets' `@pixerate/swift@0.1.0`) cannot be used with `.package(url:from:)`; SwiftPM finds no versions.
- **Root Cause**: SwiftPM only reads tags of the form `1.2.3` or `v1.2.3` as versions and ignores every other prefix. Pixerate/schemas#70 hit the same thing.
- **Solution / Workaround**: The release workflow tags the release commit `v<version>` when `@pixerate/swift` changes ("Tag the Swift package"). Changesets tags npm packages as `@pixerate/<name>@<version>`, so plain `v…` tags only ever mean the Swift package. Never add `swift-v…` tags.
### [conformance] Recorded Scenarios Need Seeds, the TypeScript Wet Kernel and No Clock Values
- **Issue / Symptom**: `scripts/record-conformance.mjs` refused steps as "not deterministic": a `paint_stroke` without a `seed` picks a random one, `get_wet_paint` reported a `typescript` backend on one run and `wasm` on the next, and `list_paint_proposals` returned a `createdAt` time. Layer ids (`pl<time><n>`) differ on every run too.
- **Root Cause**: The editor seeds strokes randomly, loads the WebAssembly wet kernel in the background (whichever is ready first runs), and stamps proposals and ids with the clock.
- **Solution / Workaround**: Scenarios pass a `seed` to every stroke. `createPaintConformanceHost` forces the TypeScript wet kernel on one thread with the GPU off, and wet steps `ignore` the backend fields. Normalization numbers clock-made ids (`isGeneratedId`) as `@1`, `@2`, … and turns ISO times into `"<time>"`; counter ids (`s1`, `stencil1`, `pad1`) stay, because another implementation can match them. A comment containing a JSON pointer like `/layers/*` + `/engine` ends a `/** */` block early: describe the `*` segment in words.

### [swift] Generated Swift Names: `Type` Members and Required Arguments That May Be Null
- **Issue / Symptom**: The first generated `PaintToolArguments.swift` did not compile ("type member must not be named 'Type'"), and reading `set_paper_effect` arguments threw "effect is required." for `{ "effect": null }`, a call the schema allows.
- **Root Cause**: An argument called `type` with an `enum` became a nested `enum Type`, which Swift reserves for metatypes (`Protocol`, `Self` and `Any` too). `effect` is required but its schema is `anyOf: [string, null]`, so a present `null` is valid and reads as `nil`.
- **Solution / Workaround**: `scripts/gen-swift.mjs` names such nested enums `TypeOption` (and so on), and makes a required argument optional in Swift when its schema allows `null` (the registry has already checked it is there). The Swift test reads every argument the recorded scenarios pass into its typed struct, which is how this was found.

### [swift] Assigning `nil` to a `JSONObject` Member Writes JSON `null`
- **Issue / Symptom**: `omitConformancePaths` in Swift left `"backend": null` where the TypeScript version removed `backend`.
- **Root Cause**: `JSONValue` is `ExpressibleByNilLiteral` (so `nil` can be written for JSON `null` in literals). In `o[key] = cond ? nil : value`, the `nil` is typed as `JSONValue` (`.null`), not as `Optional.none`, so the subscript stores a null member instead of removing it.
- **Solution / Workaround**: Remove members with `o[key] = Optional<JSONValue>.none` (or a plain `o[key] = nil` statement where the right side is not inferred as `JSONValue`). The runner test compares the result with the TypeScript cases, which caught it. The same applies to any `JSONValue?` built from a conditional: `func paint(_ v: JSONValue) -> JSONValue? { v == "undefined" ? nil : v }` returns `.some(.null)`, never `nil`; write `Optional<JSONValue>.none` there too (`VectorBlendVectorTests` hit it for paints that are `undefined` in the TS).

### [monorepo] Changesets Skips Private Packages Unless `privatePackages.version` Is On
- **Issue / Symptom**: `@pixerate/swift` changesets (#559, #593) stayed in `.changeset/` after their releases, the package stayed at 0.0.0, and "Tag the Swift package" never tagged a version. `changeset version` printed "All files have been updated" and changed nothing.
- **Root Cause**: `@changesets/config` 4 defaults `privatePackages` to `{ version: false, tag: false }`, so a private package's changesets are never applied.
- **Solution / Workaround**: `.changeset/config.json` sets `"privatePackages": { "version": true, "tag": false }`: private packages are versioned (the release workflow tags `v<version>` for `@pixerate/swift` itself) and changesets adds no `name@version` tags for them. Check with `changeset status --verbose` that a private package's changeset shows up under "Packages to be bumped".
### [swift] The Swift Tool Bridge Client Lives on the Main Actor
- **Issue / Symptom**: `ToolRegistry` is not `Sendable`, while `URLSessionWebSocketTask` calls back on its session's queue, so a bridge client that touched the registry from those callbacks would not compile under Swift 6 (or would race).
- **Root Cause**: Editors and their registries are main-thread objects, as in the browser; socket callbacks are not.
- **Solution / Workaround**: `ToolBridgeClient` and `URLSessionToolBridgeSocket` are `@MainActor`; the session uses `delegateQueue: .main` and receive callbacks hop with `Task { @MainActor in … }`. Tool calls run in main-actor tasks; `cancel` cancels the task and drops its result, since the Swift `callTool` has no abort signal. Tests drive the client through a fake `ToolBridgeSocket`; `ToolBridgeLiveTests` uses a real bridge when `PIXERATE_BRIDGE_TEST_PORT` is set.
### [monorepo] The Feature Matrix Is Generated From `parity/features.json`
- **Issue / Symptom**: The README "Feature parity" tables and the demo's parity tab had drifted apart (the demo had its own 166 rows with different wording), and the counts in the README's area headings were wrong (Video editor said 19 with 25 rows).
- **Root Cause**: Both were edited by hand, and nothing checked them against each other or against the packages' exports.
- **Solution / Workaround**: Edit `parity/features.json` and run `node scripts/parity.mjs`, which writes the README section (counts included) and `apps/demo/src/parityFeatures.generated.ts`. `--check` (run by `tests/parity-manifest.test.ts`) fails when they are stale or when a cell names a component (`<X>`), hook (`useX`), factory (`createX`) or type (`PascalCase`) in backticks that its package does not export; a Swift cell is checked against `public` declarations in `packages/swift/Sources`. Lowercase names such as option or method names are not checked; a name that looks like an API but isn't an export goes in `notExports` with the reason.
### [swift] V8's `Math.exp`, `sin`, `cbrt`, … Are Not the Platform's libm, and Differ Between arm64 and x64
- **Issue / Symptom**: Ported raster maths using Foundation's `exp`, `sin`, `cos`, `cbrt`, `atan2` and `hypot` disagreed with Node in the last bit for 1–36 % of inputs (`hypot` worst), which shows in 8-bit pixels now and then. A straight Swift port of V8's fdlibm still differed for about 0.02 % of `exp` inputs and 0.5 % of `sin` / `cos` inputs.
- **Root Cause**: V8 implements these itself (`src/base/ieee754.cc`, fdlibm; `Math.hypot` is a Torque builtin computing `sqrt((a/m)² + (b/m)²)·m`), not with the system libm. On arm64 (Apple silicon) V8's C++ is compiled with FP contraction, so every `a * b + c` inside one fdlibm expression is a fused multiply-add; x64 Node builds have no FMA and round some results differently. `pow` and `sqrt` agree with Foundation.
- **Solution / Workaround**: `PixerateRaster`'s `JS` enum ports V8's fdlibm functions with explicit `fma` exactly where clang contracts (verified bit for bit against Node 25 on arm64 over 200 000 inputs per function; `testV8MathOnArm64` keeps a few). Because the TS vector test also runs on x64 CI, `swift-raster-vectors.test.ts` stores numbers that went through these functions as `Math.fround` and keeps pixels as bytes or Float32 samples, and rounds its own sin / cos inputs (rotation matrices, the warp map) to floats, so the fixture does not depend on the machine.

### [swift] `Uint8ClampedArray` Stores Round Half to Even; `Math.round` Rounds Half Up
- **Issue / Symptom**: Transform, mip and box-reduce pixels were one level off where a value landed exactly on .5, and `Math.round(-2.5)` ports gave -3.
- **Root Cause**: Writing a number into a `Uint8ClampedArray` clamps to 0..255 and rounds to nearest, ties to even (NaN is 0); the TS code often stores unrounded values (`out[o] = acc / al`). `Math.round` rounds ties toward +∞, while Swift's `.rounded()` rounds them away from zero.
- **Solution / Workaround**: Use `JS.u8c(v)` for every `Uint8ClampedArray` store and `JS.round(v)` for `Math.round` (`JS.u8c(JS.round(v))` where the TS rounds first). Typed-array stores that wrap (`Uint16Array`, `| 0`) are `JS.u16` / `JS.i32`, and `Float32Array` stores are `Float(v)`. The rounding test in `RasterVectorTests` pins these.

### [swift] JS `Map` Order and Object Identity in the Raster Caches
- **Issue / Symptom**: The compositor's caches and tile maps rely on `Map` insertion order (LRU eviction, `changedTiles` order) and on object identity (`WeakMap`s keyed by layers, tiles and layer arrays; `compositeTiles` reporting whether a tile buffer is the cached one).
- **Root Cause**: Swift dictionaries are unordered, and Swift arrays (the layer lists and pixel buffers) have no identity.
- **Solution / Workaround**: `OrderedMap` reproduces `Map` order (set keeps the place, delete then set moves to the end), `IdentityCache` stands in for `WeakMap` (entries hold their key weakly and are found only while it lives), layers and tiles are classes, and a composited tile is a `TileResult` object so `changed` compares identity. The steps and effect reach the TS memoises per layer array are rebuilt per call (one pass over the layers).

### [swift] Paint Coverage Maps Store `Float32` but the Maths Goes On in Doubles
- **Issue / Symptom**: Dry strokes in Swift were one level off in a few pixels where dabs overlapped, though each dab matched on its own.
- **Root Cause**: The TS stroke coverage is a `Float32Array`. `cov[i] = next` rounds what is stored, but the same statement then uses the unrounded `next` (a double) to weight the colour. Storing `Float(next)` and reading it back for the weight loses that bit.
- **Solution / Workaround**: Store `Float(...)` exactly where the TS writes to a `Float32Array`, and keep using the local `Double` wherever the TS keeps using the JS number. `CoverageMap.accumulate` in `PixeratePaint/Paint/Brush.swift` follows this pattern.

### [swift] Saved Paint Documents Hash the PNG Data URL, so PNG Bytes Must Be Exact
- **Issue / Symptom**: Document comparisons failed on asset references (`pixerate-asset:<len>-<hash>`), not on pixels.
- **Root Cause**: `createEditorDocument` externalizes every inline data URL under a cyrb53 hash of the whole string, so any difference in zlib or PNG chunk bytes changes the reference, even with identical pixels.
- **Solution / Workaround**: Encode layers with `PixerateRaster`'s byte-exact `encodePng`, crop to `contentBounds` exactly as `serializeLayers` does, and hash UTF-16 code units (`hash53` in `Editor/Serialize.swift`).

### [swift] TS Object Identity of Strokes and Document States
- **Issue / Symptom**: Live stroke layers redrew the wrong strokes, and `paintedBounds` merged strokes that were different objects with equal content.
- **Root Cause**: The TS code compares documents and recorded strokes with `!==` (a changed document is a new object; a live layer's strokes are found by identity). Swift structs have no identity, and equal copies compare equal.
- **Solution / Workaround**: `PaintDocumentState` is a class that is never mutated in place (`with { }` makes the copy), so `!==` keeps its meaning. Every `RecordedStroke` carries a `key` from `newStrokeKey()` that copies keep and new strokes don't; code that compares strokes by identity compares keys.

### [swift] Replayed and Brushed-Path Strokes Record the Active Brush's Id
- **Issue / Symptom**: `replay_strokes` and `stroke_path` results had a different `brushId` from the TS recordings.
- **Root Cause**: In TS, a replay paints each recorded brush through the controller's active brush session, so the stroke it records takes the active brush's id with the recorded settings. Building the brush straight from the record keeps the old id.
- **Solution / Workaround**: Do what the TS does: normalize the recorded brush on top of the active one (`renormalized`) before painting, and record the active id.

### [swift] Light Paint Lives in a Twin Session, Not in the Layer
- **Issue / Symptom**: Glowing dry brushes changed the layer's pixels, or their light was lost on undo.
- **Root Cause**: The TS keeps light in a separate per-layer channel (`document.light`). Each stroke runs a light twin of the paint session that lays `light.amount` into that channel, and the compositor adds glow and spill as extra view layers.
- **Solution / Workaround**: `PaintStrokeSession` owns an optional light twin committed with the stroke into `PaintDocumentState.light` (an `OrderedMap`, in layer order). `lightLayers` draws it when rendering. Wet light has no twin: it is a mass channel of the wet simulation, shaded by `WetWorld.lightDisplay` and committed with the stroke; thick paint's rim and clarity come from the material channel (`glowSurface`).

### [swift] `ImageRenderer` Draws AppKit and UIKit Views as a Yellow "No" Placeholder
- **Issue / Symptom**: An `ImageRenderer` snapshot of `PaintEditorView` or `PaintCanvasView` came out as a yellow square with a red no-entry sign, and the side panels came out empty.
- **Root Cause**: `ImageRenderer` only draws SwiftUI's own rendering. `NSViewRepresentable` / `UIViewRepresentable` views (the canvas's input view) are drawn as placeholders, and the placeholder covers the whole `ZStack`. On macOS most standard controls (segmented pickers, buttons, sliders, `ScrollView`) are AppKit views too, so they come out the same way or empty.
- **Solution / Workaround**: Snapshot the canvas with `PaintCanvasView(model:interactive: false)`, which leaves out the input view; its drawing is a SwiftUI `Canvas`, which renders. Check the whole editor in a running app instead: the demo writes its window with `PIXERATE_DEMO_SNAPSHOT=<png>` (`NSView.cacheDisplay`). That capture draws controls without their text, so read it for layout only. Set `model.viewport` and call `fitView()` before rendering, because `onAppear` doesn't run under `ImageRenderer`.

### [swift] A `swift run` SwiftUI App Stays in the Background, and `screencapture` Returns Black
- **Issue / Symptom**: `swift run --package-path apps/swift-demo` opened a window behind other apps that didn't take key presses, and `screencapture -x` from a terminal or agent produced an all-black image.
- **Root Cause**: A SwiftPM executable is not an app bundle, so it starts with no regular activation policy. `screencapture` needs the Screen Recording permission for the calling process; without it, macOS returns black frames rather than an error.
- **Solution / Workaround**: The demo's app delegate calls `NSApp.setActivationPolicy(.regular)` and `NSApp.activate(ignoringOtherApps:)` at launch. To check rendering without the permission, use `PIXERATE_DEMO_SNAPSHOT` (see above). Grant Screen Recording to the terminal when a real screenshot is needed.

### [swift] Live Strokes Show Less Than the Committed Stroke Until They End
- **Issue / Symptom**: The composite drawn while a `beginStroke` session was open didn't equal the pixels after `end()`, although the ended stroke matched `paint_stroke` exactly.
- **Root Cause**: Smoothing and spacing hold back the tail of the stroke until `finish()` (the TS session works the same way), so the last dabs are only laid when the pen lifts.
- **Solution / Workaround**: Compare live and `paint_stroke` pixels after `end()`. Tests check that the open stroke shows some paint, not all of it. Pushing samples one at a time or in coalesced batches gives the same committed pixels as one `paint_stroke` call with the recorded points and seed (`PaintLiveStrokeTests`, `PaintEditorModelTests`).

### [swift] The Vortex Winding Animation Needs a Clock, and Finds Its Stroke by Id
- **Issue / Symptom**: A Swift vortex stroke with `marks.duration > 0` committed its final pixels and the canvas showed them at once; `windingAnimation()` existed but nothing played it. A first port that queued "the last session's animation" could also have played a time-lapse replay's winding after an unrelated commit.
- **Root Cause**: TS starts each animation from `playEffects`' clock and blends `VORTEX_KEYFRAMES` snapshots of the integration (`integrateVelocityFieldFrames`, `vortexWindingField`); Swift had neither the keyframes nor a clock driving the controller. Separately, `endStroke` (where the Swift session is last seen) also runs for replays and previews, which never commit.
- **Solution / Workaround**: `endStroke` notes the session's winding with the recorded stroke's id (`noteVortexAnimation`), and the three commit sites (`paintStroke`, `PaintLiveStroke.end`, `strokePath`) queue it only when `result.strokeId` matches (`ControllerVortexAnimation.swift`). `PaintEditorModel.tick` calls `stepVortexAnimations(now)` every frame while no stroke is open; until a clock has stepped, `renderLayers(view: true)` shows the committed pixels, so headless callers and tools never see a frame. An animation is dropped once its layer's surface is not the committed one (`!==`), which covers undo, redo and new strokes. Keyframes leave the final field bit for bit unchanged (`testKeyframesLeaveTheFinalFieldUnchanged`); `swift-paint-vortex-vectors.test.ts` writes the TS keyframes and a mid-animation frame the Swift test compares with.

### [swift] Apple Pencil and Tablet Angles Are Mapped Without a Device Check
- **Issue / Symptom**: Pen tilt maths takes Pointer Events' conventions (`tiltX` / `tiltY` in degrees, `altitudeAngle` / `azimuthAngle` in radians, azimuth clockwise from +x with y down). AppKit and UIKit report their own.
- **Root Cause**: UIKit's `altitudeAngle` (π/2 upright) and `azimuthAngle(in:)` (in the view's y-down space) are used as they are. AppKit's `NSEvent.tilt` is -1…1 per axis (right and towards the user positive) and is scaled by 90°. `rollAngle` (Pencil Pro, iOS 17.5) and `NSEvent.rotation` become `twist` in degrees. Force is `force / maximumPossibleForce`.
- **Solution / Workaround**: These follow the platform documentation and the unit tests, but nobody has checked them on a Pencil or a Wacom tablet yet. If shading leans the wrong way on a device, fix it in `PaintInputNSView.pointer` / `PaintInputUIView.pointer` (`PixeratePaintUI/PaintCanvasView.swift`), not in the engine.

### [swift] A Path Dependency's Package Identity Is Its Directory Name
- **Issue / Symptom**: `.product(name: "PixeratePaintUI", package: "editor")` in `apps/swift-demo` fails to resolve in a git worktree or in a checkout whose directory has another name.
- **Root Cause**: SwiftPM names a local package after the last component of its path, not after the `name:` in its manifest.
- **Solution / Workaround**: The demo declares `.package(name: "Pixerate", path: "../..")` and refers to `package: "Pixerate"`, which resolves whatever the checkout directory is called.

### [swift] Provider Effect Ids Are an Enum in TS Only Once the Catalog Has Loaded
- **Issue / Symptom**: `apply_effect` with a generator id, or `set_paper_effect` with a filter id, failed in TS with `invalid_arguments` ("Expected one of …") but in Swift with `tool_failed` and the controller's message ("… is a generator effect, and light on dried paint takes filter effects …").
- **Root Cause**: `createEffectToolProvider` fetches the provider's catalog in the background and only then narrows `effect` arguments to an `enum` of matching ids. The contracts (`tools.json`) are exported without a catalog, so their schemas, which the Swift tools use, take any id; the TS host's schemas change shape once the fetch lands.
- **Solution / Workaround**: Scenarios should not depend on the enum (the recorded ones do not); both ports refuse the wrong use, only with different codes. Compare a wrong-use call by its outcome, not its code, when testing by hand.

### [swift] The Swift PSD Writer Leaves Layer Styles Out
- **Issue / Symptom**: `export_psd` in Swift writes the same bytes as the TS core for pixel layers, groups, masks, locks and the merged image, but a layer with layer styles gets no `lfx2` block and an extra warning naming it.
- **Root Cause**: Only the part of `image-editor/psd/export.ts` that paint layers need without styles was ported (`PixerateRaster/PSD.swift`); the descriptor writer, `writeLfx2` and pattern embedding were not.
- **Solution / Workaround**: The merged image still shows the styles. Port `psd/descriptor.ts` and `writeLfx2` (and `Patt` for pattern effects) when a scenario exports styled layers to PSD, and drop the warning.

### [swift] Replays Read Paint Events, so Moving the Document Must Move Them Too
- **Issue / Symptom**: After `extend_canvas` with `left` or `top`, a Swift time-lapse or high-res export put a sticker layer's stickers (and a stroke layer's strokes) back where they were before the canvas grew, and the saved `paintEvents` differed from the TS core's.
- **Root Cause**: Replays repaint sticker and stroke layers from their `paintEvents` (`stickers`, `live-strokes`), not from the document's current lists. The TS `extendCanvas` moves the stickers and strokes inside those events (rounding sticker centres to hundredths); the Swift `shiftDocument` only moved the document's own lists.
- **Solution / Workaround**: `shiftDocument` moves `stickers` and `live-strokes` event data (and the in-memory strokes of `PaintEvent`) with the same rounding as the TS core. Anything new that moves paint must move the events too; a replay after the move is the test.

### [swift] The Wet Kernel's f32 Maths Is Swift `Float`, but Edits Mix in Doubles
- **Issue / Symptom**: Porting the wet edits (dabs, water, drying, blending) as `Float` arithmetic, like the step, makes the wet state drift from the TS core by the last bit, which the simulation then grows over the following steps.
- **Root Cause**: The TS kernel wraps every intermediate in `Math.fround`, and an f32 `+ − × ÷ √` computed in f64 and rounded once is exactly the f32 operation, so the step is plain `Float` arithmetic in the TS order. The edits are not: `f32[i] += W9[k] * dw` adds a double product (the lattice weights are doubles) and rounds once on store, and `Math.max` / `Math.min` keep JavaScript's signed zeros and NaN rules.
- **Solution / Workaround**: `wetStepSlot` uses `Float` with `fmax` / `fmin` (JS semantics); the edits in `WetWorld` read the float, compute in `Double` and store `Float(...)` once, exactly where the TS writes a `Float32Array`. The film bake uses the TS core's own `dexp` / `dlog` tables, never `exp` or `pow`. Eight extra scenarios (strokes over time, two tiles, glazing and the wet tools, saving and replays, impasto, backlit and metallic paper, effect paint and PSD export, extending a wet canvas) matched the TS core result for result and pixel for pixel.

### [swift] V8's Three-Argument `Math.hypot` Sums with Kahan Compensation
- **Issue / Symptom**: Metallic paper and impasto lighting could be one level off where `Math.hypot(x, y, z)` was ported as `sqrt(x² + y² + z²)`.
- **Root Cause**: V8's `Math.hypot` builtin divides by the largest argument and adds the squares with Kahan summation; with two arguments the compensation is always zero, so only the three-argument form differs.
- **Solution / Workaround**: Use `JS.hypot(x, y, z)` (`PixerateRaster`), which does the same; `testThreeArgumentHypot` pins it against Node.

### [swift] Wet Results Report the TS Kernel's Words, and the Conformance Host Must Turn the GPU Off
- **Issue / Symptom**: Extra wet scenarios failed on `get_wet_paint` with `"gpu": "auto"` against a recorded `"off"`, and a Swift wording for the backend message would fail every wet scenario.
- **Root Cause**: `createPaintConformanceHost` builds its editor with `wet: { kernel: 'typescript', threads: 0, gpu: 'off' }`; scenarios ignore `/engine` and `/backend` but compare `gpu` and `message` ("Wet paint runs in plain JavaScript until the WebAssembly kernel has loaded.").
- **Solution / Workaround**: `PaintConformanceHost` passes `PaintWetOptions(gpu: "off")`, and `WetWorld.backend()` reports the TypeScript kernel on one thread with the TS message. If the TS core changes either, change the Swift side with it.

### [swift] Wet Paint Changes the Document Without an Undo Step
- **Issue / Symptom**: Committing a live wet stroke against the editor's current document gives it an undo step that goes back to the wet pixels painted so far, not to the layer before the stroke.
- **Root Cause**: The wet layer's display is the layer's pixels: `PaintWetLayers.syncDisplays` writes them into `doc` as the paint flows (not an undo step), so `doc` at the end of a stroke already holds wet pixels. The TS controller keeps the document from when the stroke began for a wet stroke's undo step, and the wet simulation's snapshots in the history entry (`HistoryEntry.wet`).
- **Solution / Workaround**: `PaintLiveStroke` keeps the document from `beginStroke` and commits a wet stroke against it; `beginWetOp` snapshots the world before any change to wet paint, and `commit` stores both snapshots. Cancel restores the snapshot and the layers.

### [swift] Long Wet Runs Are Slow in Debug Builds
- **Issue / Symptom**: An extra scenario with a few hundred wet steps over two tiles took minutes under `swift test`, where the TS core takes seconds.
- **Root Cause**: `swift test` builds without optimisation, and each wet step visits all 65 536 cells of every live 256 px tile with a few hundred float operations each.
- **Solution / Workaround**: Keep committed scenarios short (the recorded ones run in seconds). Test optimised, as CI does: `swift test -Xswiftc -O -Xswiftc -enable-testing` (`-enable-testing` keeps `@testable import` working). A clean build and test went from 115 s to 45 s locally (build 21 → 31 s, tests 94 → 14 s); on CI the macOS tests took ~3 min and the iOS simulator ~4.5 min unoptimised. Timing checks (parse time growth and the like) should still allow for debug builds, where they are noisier.

### [swift] Metal Only Shades Wet Paint: Stepping on the GPU Would Not Make It Faster
- **Issue / Symptom**: A Metal copy of the TS core's Engine B (a GPU mirror that also steps each batch) would have doubled the work without letting wet paint run more steps per second.
- **Root Cause**: The CPU engine is the authority (saving, export, replay and pick-up read its exact bits), so it runs every step whatever the GPU does. In Swift it stepped on the main thread at 3.5 ms per 256 px tile-step (a fully wet 2048² canvas: 223 ms a step, M4 Pro, release); the web hides its step in a worker, which Swift does not have. Shading (1.9 ms per tile on the CPU) is the only part a GPU can take over without changing results.
- **Solution / Workaround**: `WetMetalEngine` only shades the display (10 ms for those 64 tiles). Slots are page-aligned (`WET_SLOT_ALLOCATION`) and wrapped with `makeBuffer(bytesNoCopy:)`, so Metal reads the CPU's state in place: no upload and no mirror to keep in step. Shading waits for its command buffer, so the CPU never writes a slot the GPU is reading. Making wet paint itself faster in Swift took a faster CPU step, not GPU steps: tiles on every core and SIMD (see below), 15 ms for that canvas.

### [swift] naga's CLI Leaves Metal Buffer Indices as Placeholders
- **Issue / Symptom**: The MSL that `naga shade.wgsl shade.metal` writes compiles to nothing usable: every kernel argument is `[[user(fake0)]]`.
- **Root Cause**: naga's Metal backend takes binding slots from a per-pipeline map, which its CLI has no option for, so it writes placeholders.
- **Solution / Workaround**: `scripts/gen-msl.mjs` replaces each placeholder with `[[buffer(n)]]`, using the argument's WGSL `@binding(n)`, and puts naga's hidden `_buffer_sizes` argument after the last binding (`WET_SHADE_SIZES_INDEX`). It fails if an argument has no WGSL binding; `tests/swift-shaders.test.ts` checks each binding. Metal compiles the MSL with `mathMode = .safe` (`fastMathEnabled = false` before macOS 15 / iOS 18), or `exp` / `pow` drift further from the CPU's.

### [swift] PixerateMarkdown Is Swash's Engine: Its API Is Public on Purpose
- **Issue / Symptom**: Narrowing a `public` declaration in `PixerateMarkdown` (or renaming one) builds and tests fine here, then breaks the Swash app, its Quick Look extension or its `swiftc` test runners at the next version bump.
- **Root Cause**: The engine moved out of Swash (`Swash/Markdown/`, where everything was internal) in #546, so the app reaches into it across a module boundary: node links (`parent`, `firstChild`, `next`), parser state, formatting helpers, `MarkdownEdit(text:selection:)`. Swash's runners also compile `SpecStructure.swift`, `ParserChecks.swift` and `CodeHighlighterChecks.swift` from `Tests/PixerateMarkdownTests` with `@testable import`.
- **Solution / Workaround**: Treat a narrowed or renamed API as breaking: a minor bump of `@pixerate/swift` while it is 0.x (Swash pins `upToNextMinor`), and a Swash PR that follows it. Keep those three test files free of XCTest. Public structs need an explicit `public init` (the memberwise one is internal), and public types are not inferred `Sendable`, so add the conformance where it holds. `MarkdownHTMLRenderer.Options` is not `Sendable` (its `imageSource` closure is called from main-actor code in Swash), so `Options.spec` is a computed property rather than a `static let`.

### [swift] HTMLToMarkdown Has Two Parsers, and macOS Tests Only One
- **Issue / Symptom**: A paste-conversion change passes `swift test` on macOS and fails in the iOS simulator job, or the other way round.
- **Root Cause**: `HTMLToMarkdown` uses Foundation's `XMLDocument` (tidy HTML) on macOS. iOS has no `XMLDocument`, so there it runs on `HTMLLiteDOM`, which mimics the subset of that API the converter uses (aliased in `HTMLToMarkdown.swift`). The two trees differ in whitespace (tidy trims and moves it), so they can't be compared node for node; only the Markdown output agrees.
- **Solution / Workaround**: The paste cases in `ParserChecks` run on both: on `HTMLLiteDOM` in the iOS simulator job, or on macOS with `swift test --filter PixerateMarkdownTests -Xswiftc -DPIXERATE_HTML_LITE` (use a separate `--scratch-path`, since the flag rebuilds every target). Add new paste cases there, not only as macOS tests.

### [swift] The Markdown Format Manifest Is Generated, Like the Contracts
- **Issue / Symptom**: Editing `packages/markdown-conformance/manifest.json` fails the core test `swift-generated.test.ts` and the Swift CI job, or a new command never appears in Swash's Format menu.
- **Root Cause**: `PixerateMarkdown/FormatManifest.generated.swift` is written from the manifest by `scripts/gen-swift-markdown.mjs` (it used to be generated in Swash from its npm copy). The generator refuses surfaces, `enabledWhen` conditions and command ids the Swift engine doesn't implement.
- **Solution / Workaround**: After changing the manifest, add any new `FormatSurface` / `FormatCondition` case or `FormatCommand(manifestID:params:)` mapping, run `pnpm gen:swift` (it runs both generators) and commit the Swift file. Swash picks up the change when it bumps its pin.

### [swift] One Canvas-Sized CGImage per Frame Makes SwiftUI Convert and Upload the Whole Painting
- **Issue / Symptom**: Painting in `PaintCanvasView` felt slow on an iPad simulator. A Time Profiler trace put about 40% of the samples in `vConvert_PermuteChannels_ARGB8888` under RenderBox's `TextureCache::prepare_cgimage`, and another 7–10% in `_platform_memmove` from `CGContext.makeImage()`. Splitting the image into per-tile `CGImage`s drawn in the same SwiftUI `Canvas` removed the conversion but not the uploads: `RB::Texture::replace` still ran for every tile every frame.
- **Root Cause**: The presenter kept one RGBA (`premultipliedLast`) bitmap and made a new canvas-sized `CGImage` after every change, so each frame RenderBox swizzled the whole canvas to BGRA and uploaded all of it, however few pixels the stroke touched. RenderBox's texture cache did not keep ~70 tile textures alive between frames either, so per-tile images drawn through `Canvas` were uploaded again each frame.
- **Solution / Workaround**: `PaintCanvasPresenter` keeps a BGRA (`premultipliedFirst | byteOrder32Little`) bitmap and makes one `CGImage` per tile (`tiles()`), rebuilding only changed tiles. On screen, `PaintTilesView` shows them as Core Animation layers under the view transform: a layer's texture is uploaded again only when its `contents` object changes. Stills (`interactive: false`, `ImageRenderer`) still draw the tiles through `Canvas`, because `ImageRenderer` draws platform views as placeholders. Each tile image reaches 2 px into its right and lower neighbours, which are drawn after it, so tile edges don't show seams when the view is scaled or rotated; because of that overlap, a changed tile also rebuilds the images of the tiles to its left and above. Draw `tiles()`, not `image()` (which copies the whole bitmap).

### [core|react|svelte/brushes] A Host's Brush Editor Must Hide What It Can't Use, Never Strip It
- **Issue / Symptom**: Opening a paint brush with light (or a wet surface, or a bristle tip) in a limited host's editor and saving a size change would either be refused by the host check or, if the editor "cleaned" the brush for the host, lose the light for the paint editor and every other host on the shared library.
- **Root Cause**: Every host saves to the one shared library, so the stored brush is the paint editor's too. `checkBrush` refuses the whole brush for one facet, and some editor changes reset whole facets (`setBrushEditorValue` on `kind`, `marks.kind` or `tip.shape` starts them afresh), so offering a control whose current value the host refuses (a Tip menu on a bristle brush in Canvas) would wipe the bristles on the first click.
- **Solution / Workaround**: `brushEditorSections` gives a facet the host refuses or paints without (`ignored`) no control at all, including the engine's own controls when the brush's engine is one the host lacks, and `brushEditorScope` names them for a note. Saving goes through `saveBrushEdit` / `checkBrushEdit` (`withKeptIssues`): errors the original already had are kept, only errors the edit adds refuse it, and a new brush (`newBrushFor`, built with `degrade(…, { ignored: true })`) must pass outright. `update_brush` uses the same rule (`kept` in its result), in TypeScript and Swift.

### [core/vector] Re-Pick a Saved Brush After Editing It, or the Brushstroke Keeps the Old Copy
- **Issue / Symptom**: After "Edit brush…" saved a change to a library brush in place, the vector brushstroke using it still painted the old brush.
- **Root Cause**: A brushstroke embeds a copy of a saved brush (`spec`) so the document renders without the library, and `setBrushstroke` only dropped that copy when the brush id changed. The controller's library snapshot is also re-read asynchronously after a library change, so looking the brush up straight after the save can still find the old one.
- **Solution / Workaround**: `setBrushstroke` with a `brushId` (even the same one) drops the copy and looks the brush up again. The panels `await controller.refreshBrushes()` before calling it with the saved id (`keepColour: true`). Strokes that are not re-picked keep their copy, as documented.

### [react|svelte/brushes] Brush Editor Previews Come From the Host, or the Subpath Entries Leak
- **Issue / Symptom**: `tests/entry-isolation.test.ts` failed for the React and Svelte `image-editor`, `vector` and Svelte `brushes` entries once "Edit brush…" had a default preview, and once the Svelte `BrushEditor` moved out of `paint-editor`.
- **Root Cause**: The test follows every import (dynamic and type-only too), and each subpath entry may reach only its own core entry. A lazy `import('@pixerate/editor/paint-editor')` or `('@pixerate/editor/canvas')` for the preview counts, and so did `PaintSlider`'s `import type { SliderControl }` and the paint panels' `button` / `chip` classes from `paintEditorRune`.
- **Solution / Workaround**: The preview renderer is the host's: the image and vector controllers take a `brushPreview` option (the demo passes `paintBrushPreviewRenderer()` and `renderCanvasBrushPreview`), and the panels fall back to it. The Svelte brush components take their classes from `brushes/styles.ts`, and `PaintSlider` writes out its slider type.

### [core|react|svelte/brushes] A Preview Colour Picked for the UI Vanishes on the Renderer's Paper
- **Issue / Symptom**: In the Brushes tab most previews were almost invisible: near-white strokes on cream paper in the Paint and Image hosts, and the ballpoint's navy or the fineliner's near-black on the dark panel behind transparent Canvas and Vector previews. The highlighter showed yellow on dark paper.
- **Root Cause**: The editor passed one `previewColor` (#e2e8f0, chosen for the dark UI) for every brush without a solid default, but the paint engine draws on its own paper (cream), while the canvas renderer is transparent and shows whatever is behind it. A light / dark default was always resolved for `'light'`, and every brush with light got dark paper, multiply highlighters included.
- **Solution / Workaround**: `brushPreviewColours(brush, { paper, profile })` chooses against the surface the preview is really drawn on: the renderer's `paper` (`BrushPreviewRenderer.paper`; the paint renderer sets it) or the box behind a transparent preview (`previewPaper`, swatches' `background`). It takes the brush's default for that background's scheme, else a medium colour, and shifts its OKLCH lightness to 3:1. Light paint previews on dark paper only when it is not multiply (`brushPreviewsOnDark`), in the TS thumbnail and Swift alike. Don't add defaults to presets just for previews: a default becomes the user's paint colour when they choose the brush.

### [swift] Swift SIMD Code for the Wet Step Ran Lane by Lane; the Fast Kernel Is C
- **Issue / Symptom**: The wet step ported to `SIMD8<Float>` / `SIMD4<Float>` with `replacing(with:where:)` selects (the shape of the core's WebAssembly kernel) ran slower than the scalar kernel: 4–5 ms per tile-step against 3.5.
- **Root Cause**: The Swift compiler lowered the masks, selects and comparisons lane by lane (scalar `fcsel`, `csel` and 16-bit mask loads and stores in the release build), even with bitwise selects.
- **Solution / Workaround**: The SIMD kernel is C with clang vector extensions (`PixerateWetKernel/wet_kernel.c`), which compiles to NEON: 1.4 ms per tile-step on one thread. Its `#pragma clang fp contract(off)` is what keeps the bits: with contraction on, clang fuses multiply-adds in optimised builds only, and `WetKernelTests` then finds tens of thousands of floats differing from the scalar kernel. A debug build never fuses, so that test only proves the pragma in an optimised build (CI's). `Math.max` / `Math.min` are compare-and-select with the NaN and signed-zero rules, not `fmaxf` or NEON `FMAX` (which may keep a NaN's payload). The scalar Swift kernel stays as the readable reference that the tests compare against.

### [swift] Wet Tiles Step on Several Threads with the Same Bits
- **Issue / Symptom**: Stepping tiles one after another left all but one core idle (a fully wet 2048² canvas took 223 ms a step).
- **Root Cause**: Nothing needed it: within a step each tile reads only its own slot (its halo holds the neighbours' last values) and writes only its own next set and deposits, and halos are refilled from the neighbours' interiors after every tile has stepped.
- **Solution / Workaround**: `runHere` steps the tiles with `DispatchQueue.concurrentPerform`, then fills the halos the same way, and merges the flags in tile order. `WetWorld.threads` (default: every core) changes only the speed; `WetKernelTests` compares 1 and 8 threads bit for bit. Edits and the display still run between batches on the calling thread.

### [swift] `xcodebuild -quiet` Hides Why an iOS Test Failed
- **Issue / Symptom**: A failing iOS simulator job only listed `Failing tests: MarkdownSpecTests.testParseTimeGrowth()`, with no assertion message, so a flaky timing check could not be told from a real slowdown.
- **Root Cause**: `-quiet` drops the test output, assertion messages included, and leaves only the summary.
- **Solution / Workaround**: The job passes `-resultBundlePath`, and on failure prints each failure's test and message with `xcrun xcresulttool get test-results summary` (also as `::error` annotations) and uploads the bundle as the `ios-xcresult` artifact. Keep `-quiet`; read the failure step or the artifact.

### [core/vector] Listed Command Shortcuts Depend on the Platform; Contracts Take the Spec's
- **Issue / Symptom**: `vector/commands.json` would have changed between a Mac and a Linux CI runner had it used `CommandRegistry.list()`.
- **Root Cause**: A listed command's `shortcuts` are "canonical chord text bound on the registry's platform", so `Mod+G` comes out as the Mac or the Ctrl chord depending on where the export runs.
- **Solution / Workaround**: `vectorContracts()` writes each spec's own `shortcut` as written (`Mod` for Cmd or Ctrl), as paint's `PAINT_SHORTCUTS` do. Anything exported for another implementation must not go through platform-resolving APIs.

### [svelte/runes] Destructuring ProseMirror `$from` / `$to` in `.svelte.ts` Files Fails Compilation
- **Issue / Symptom**: Writing `const { $from, from, to } = selection;` inside a `.svelte.ts` rune module fails with `CompileError: The $ prefix is reserved, and cannot be used for variables and imports`.
- **Root Cause**: The Svelte 5 compiler reserves all local identifier names prefixed with `$` inside `.svelte` and `.svelte.ts` files for runes and store auto-subscriptions.
- **Solution / Workaround**: Rename `$`-prefixed ProseMirror properties when destructuring in `.svelte.ts` files (e.g. `const { $from: resolvedFrom, from, to } = selection;`) or access them as property lookups (`selection.$from`).

### [svelte/runes] A Getter-Based Wrapper Must Not Re-Apply Unchanged Controlled Content
- **Issue / Symptom**: In Svelte's `usePromptEditor`, changing an unrelated prop (e.g. `placeholder`) reset the editor to the parent's `content`, throwing away text the parent had not taken up from `onContentChange`. React's hook did not do this.
- **Root Cause**: A Svelte `$effect` re-reads the whole props getter whenever any prop changes, whereas React's content `useEffect` only runs when `content` changes. Comparing `content` against the editor's text on every run therefore overwrote un-echoed edits.
- **Solution / Workaround**: `syncPromptEditor(editor, config, previous)` in core applies content only when `config.content !== previous.content` and it differs from the editor's text. Pass the previous config from both bindings.
### [ci] Vitest Hides the Benchmarks' Tables Unless `--silent=false`
- **Issue / Symptom**: `DEEP_BENCH=1 vitest run tests/raster-deep.bench.test.ts` passed but printed no timing table; the same happened for `WET_BENCH` and `SELECTION_BENCH`, so the scheduled benchmark job would have recorded nothing for them.
- **Root Cause**: Vitest 5 drops the console output of passing tests by default, and those benchmarks only `console.log` their results (the image-layers, spreadsheet and transform benchmarks also write `*_BENCH_OUT` files).
- **Solution / Workaround**: Run them with `vitest run --silent=false` (as `.github/workflows/scheduled-suites.yml` does, teeing the log into the step summary and artifact), or add a `*_BENCH_OUT` file to the benchmark.
### [monorepo] Node10 Consumers Need `typesVersions` for Every Subpath, and the Check Needs `esModuleInterop`
- **Issue / Symptom**: With `moduleResolution: "node"` (node10), `import … from "@pixerate/editor/grammar"` had no types, and the first node10 consumer in `scripts/check-packages.mjs` reported 166 errors like "Module react can only be default-imported using the 'allowSyntheticDefaultImports' flag".
- **Root Cause**: node10 ignores `exports`, so it only finds subpath declarations through `typesVersions["*"]`. Separately, our emitted React declarations use `import React from "react"`, which node10 only accepts with `allowSyntheticDefaultImports` (on by default for `bundler` and `node16`, off for node10).
- **Solution / Workaround**: Every non-root `exports` key needs a matching `typesVersions["*"]` entry (`check-packages` fails otherwise). The node10 consumer sets `esModuleInterop: true`, which `tsc --init` writes and which implies `allowSyntheticDefaultImports`.
### [core/vector] Regenerating Vector Art Without a Seed Picks a Random One
- **Issue / Symptom**: The vector scenario recorder refused `effects-and-generation`: the document after `regenerate_vector_art` differed between its two runs, in the generation provenance's `seed`.
- **Root Cause**: Without a `seed`, generation and regeneration draw a fresh random seed (so a new take looks different), and record it in the provenance.
- **Solution / Workaround**: Scenarios pass a `seed` to both `generate_vector_art` and `regenerate_vector_art`. The provenance's `createdAt` is normalised to `"<time>"` by the runner, so it needs nothing.

### [core] Trig Results Differ in the Last Bits Between Mac and Linux, So Recordings Compare Numbers Within 1e-9
- **Issue / Symptom**: The vector `blends-and-envelopes` scenario, recorded on an M-series Mac, failed on the Linux CI runner: a blend step's rotation matrix read `0.6595295122134215` where the recording had `0.6595295122134217`.
- **Root Cause**: V8's `Math.sin` / `Math.cos` are fdlibm ports compiled per CPU, and clang fuses multiply-adds on arm64 but not on x64, so results can differ in the last bits. Anything stored straight from trig (orient-to-spine transforms, rotations) is then machine-dependent.
- **Solution / Workaround**: The TS replay tests compare with `conformanceValuesMatch` (numbers equal within a relative `CONFORMANCE_NUMBER_TOLERANCE`, 1e-9), as the Swift runner always has; on a mismatch they fall back to `toEqual` to show the diff. Recordings stay exact. Strings are still compared exactly, so text that formats such a number (SVG path data, messages) should round it, as `exportSvg`'s `precision` does.

### [swift] PixerateMarkdown's Timing Checks Use Thread CPU Time, Not the Wall Clock
- **Issue / Symptom**: `MarkdownSpecTests.testParseTimeGrowth` kept failing on the iOS simulator job: "angle brackets ×10.8", then, after remeasuring up to four rounds, "open brackets 5k 4.3 ms 20k 93.9 ms ×22.0" (×4.0 locally in debug and release).
- **Root Cause**: Not a stall but CPU contention: other suites run alongside on the simulator, and the wet-paint tests step tiles on every core. A 90 ms parse kept being interrupted while a 4 ms one slipped through between interruptions, and wall-clock time counted the interruptions, so even the best of 20 runs was ~5× slow.
- **Solution / Workaround**: Every timing in the checks uses `TimingBudget.cpuMilliseconds`, the calling thread's CPU time (`CLOCK_THREAD_CPUTIME_ID`), which leaves out time other threads and processes held the CPU. With twice as many busy processes as cores the ratios stay ×4.0–4.1. Time any growth or budget check this way; never raise the limit to fix such a flake.
### [core/brushes] Brush Image Sources Are `source:` Stamp Refs, Not Stickers

- **Issue / Symptom**: An image tip (`tip.stamps: ['source:leaf']`) painted round, or `create_brush` refused it with "can't load sticker", or objects marks dropped it.
- **Root Cause**: Image tips reuse the stamp-tip path, so a source ref goes wherever sticker refs go. The sticker art cache (`StickerArtCache`) knows nothing about the brush library, and a sticker provider called with `source:…` fails. Objects marks lay editable stickers on a sticker layer, which an image source is not.
- **Solution / Workaround**: Read stamp art through one lookup that sends `source:` refs to `BrushSourceArtCache` and everything else to the sticker cache (`PaintEditorController.stampArt`; preview renderers take `paintBrushPreviewRenderer(paper, { library })`). `brushStickerRefs` leaves `source:` refs out, and the library tools check them against `library.getSource`, not the sticker provider. `normalizeBrushSpec` drops source refs from objects marks with a problem. The provider id `source` is reserved, like `editor`.

### [core/paint-editor] New Engine Fields Stay Off Brushes That Don't Use Them

- **Issue / Symptom**: Adding `dynamics.count`, `dynamics.flip` or `tipGrain` to every resolved `PaintBrush` changed `resolved.json`, the recorded paint documents and every Swift contract test, though no preset used them.
- **Root Cause**: The conformance contracts and documents compare the whole resolved brush, so a new always-present field with a default is a change for every brush.
- **Solution / Workaround**: `normalizePaintBrush` writes `count`, `flip` and `tipGrain` only when they are not the defaults (one dab, no flip, no grain), and the facet → engine map (`BRUSH_FIELDS`) maps them like any other field. Keep later engine additions optional the same way, so ports (Swift) only need them for the brushes that use them.

### [core/brushes] Tip Grain Hardness and Flip Only Apply to Image Sources and Stamps

- **Issue / Symptom**: Lowering hardness on an editor-stamp or sticker tip changes nothing, while an image-source tip fades towards its edges.
- **Root Cause**: Stamp tips never read hardness; applying it to every stamp would change the pixels of strokes already recorded with stamp brushes, so replays would no longer match.
- **Solution / Workaround**: `stampSampler(ref, art, hardness)` softens only `source:` refs. `dynamics.flip` mirrors any dab, but only stamps and image tips look different mirrored.

### [core/vector] Wet Brushstrokes Settle in the Background, So the Scene Shows Them as Laid First
- **Issue / Symptom**: A watercolour brushstroke looked like a soft marker on the canvas for a few seconds, then bled and granulated; an early test of `vectorBrushstrokeImages` got the "as laid" image, not the final one.
- **Root Cause**: A wet vector brushstroke runs the wet simulation in its own small `WetWorld` for `VECTOR_WET_STEPS` (120) steps and then dries it. On the TypeScript kernel a step costs about 25 ms per 256 px tile, so a stroke takes seconds. Rendering is synchronous, so `vectorBrushstrokeImages` returns the step-0 bake at once and queues a `WetBrushstrokeJob` that runs in 12 ms slices on timers; `onVectorBrushstrokesSettled` fires when one is done, and the controller notifies its subscribers so the canvases redraw.
- **Solution / Workaround**: Anything that must show the final paint asks for it: `vectorBrushstrokeImages(node, layer, { settle: 'now' })`, `getVectorSceneRenderData(state, { brushstrokes: 'settled' })` (PDF export does), or `settleVectorBrushstrokes()` (tests, agents). SVG export always settles. The bytes depend only on the path, brush, colour, seed and step count, never on how the slices fell. Each stroke's world uses `kernel: 'typescript'`: `auto` would start a WebAssembly load per stroke (the kernels give the same bits, so this is only about cost). A worker for the jobs is a possible follow-up.

### [core/vector] Mixer, Smudge and Blender Brushstrokes Depend on What Lies Beneath Them
- **Issue / Symptom**: A smudge brushstroke kept smearing a square's old colour after the square was recoloured; with only `brushstroke.ts` imported, a smudge drew nothing over shapes.
- **Root Cause**: These strokes run the paint editor's `PaintDabStroke` over a CPU backdrop of the scene beneath them (`backdrop.ts`, drawn from `getVectorSceneRenderData` of the document cut off at the path, with the path keeping only its fills and lower strokes), so the image depends on other nodes. The backdrop is drawn by `render.ts`, which `brushstroke.ts` can't import (render imports it), so `render.ts` registers it with `setVectorBackdropSource` when it loads. The layer cache checks the identities of every node drawn before the path (at each level of its group chain), its ancestors' transform and opacity, the document's symbols, the path's fills and lower strokes, and a counter of settled wet strokes.
- **Solution / Workaround**: Treat document nodes as immutable (edits through the controller already make new objects), and pass the document: `vectorBrushstrokeImages(node, layer, { document })` (the scene and SVG export do). Import from `@pixerate/editor/vector`, whose index loads `render.ts`. The result is the pixels the stroke changed, drawn over the art, so a smudge can drag paint onto bare paper but can't take paint away from the art below. Text drawn as SVG text, placed images, filters, masks and blend modes are not in the backdrop.

### [core/vector] Drive the Paint Editor's Stroke Engines from a Path with Smoothing Off
- **Issue / Symptom**: Wet and mixer vector brushstrokes cut corners and lagged behind the end of the path.
- **Root Cause**: `PaintDabStroke` and `WetStrokeDriver` smooth pen input (`PenSmoother` with `tip.smoothing` and `pressureSmoothing`), which suits a hand but not a path that is already exact data.
- **Solution / Workaround**: `brushstrokeMedia.ts` places the stroke with `tip.smoothing` and `pressureSmoothing` set to 0 (and the tip size scaled to image pixels) before handing the brush to the engines.

### [swift] Geometry Vectors Compare Trig Results Within 1e-9, and Everything Else Bit for Bit
- **Issue / Symptom**: The geometry fixture (`geometry-vectors.json`) is recorded on an arm64 Mac, but `swift-geometry-vectors.test.ts` also runs on x64 Linux CI, and the Swift tests run on macOS and the iOS simulator. Arcs, circles, round joins and caps, rotated shapes and `bezierPathPointAtLength`'s `angle` go through `sin` / `cos` / `atan2` / `tan`, whose last bits differ by machine. A string comparison of the fixture, as the raster vectors do, would fail on x64.
- **Root Cause**: V8's trig functions are fdlibm ports compiled per CPU, with fused multiply-adds on arm64 only (see the `[core]` trig entry). `PixerateGeometry` uses `JS.sin` / `JS.cos` / `JS.atan2` / `JS.acos` but Foundation's `tan` (`jtan`), which V8 does not match bit for bit either.
- **Solution / Workaround**: The TS test compares the committed fixture with `conformanceValuesMatch` (relative 1e-9) rather than as a string, and every entry carries `trig`. `GeometryVectorTests` compares `trig: false` entries exactly and `trig: true` ones within 1e-9. An entry is marked `trig: false` when trig only orders edges round a vertex (`atan2` in the boolean, planar and polygon engines) or picks a branch far from its threshold (miter limit, curve fitting's corner `acos`). When adding vectors, keep trig-generated inputs out (curve-fit circles use a rational parametrisation), and mark an entry `trig: true` whenever an output number passes through trig. Every JS `Map` the TS iterates is an `OrderedMap`, and every `sort` is `jsSorted`, a stable merge sort that moves an element only when the comparator is positive. Without them, booleans trace rings and divide pieces in a different order.

### [swift] Vector Nodes Must Keep JavaScript's Key Order, Including Where a Key Moves

- **Issue / Symptom**: A typed Swift model of vector nodes (a struct per node type, encoded field by field) wrote documents whose keys came out in a fixed order: `strokeDasharray` before `subpaths`, `transform` where it was read, anchors always `x, y, in, out`. The TS documents differ: `setStyle` appends style keys after `subpaths`, `transformVectorNode` deletes `transform` and appends it again, `bezierToSubpaths` can write `out` before `in`, and `setAnchorCorner` moves `corner` to the end.
- **Root Cause**: TS nodes are plain objects edited by spreads, assignments and `delete`. A spread keeps each existing key's place, an assignment to a missing key appends it, and `JSON.stringify` writes that order. Any model with a fixed field order can only match it by accident.
- **Solution / Workaround**: `PixerateVector` keeps nodes, symbols and the document as `JSONObject`s with typed slots for `subpaths`, `children`, `nodes` and `symbols` (a placeholder holds each slot's place), so assignments behave as in JavaScript. `VectorAnchor` and `VectorSubpath` are typed but track their key order (setting a missing field appends it, setting `nil` deletes it) and keep untyped members and explicit `null`s. Port each TS builder with its literal's order (`VectorSubpath(closed:anchors:)` where the TS writes `{ closed, anchors }`). The vector model vectors compare key order, and the Swift tests round-trip every recorded vector scenario document.

### [core/brushes] Brush Packs Are Undocumented, Untrusted Binary Files

- **Issue / Symptom**: A `.abr` from another Photoshop version, a truncated download or a crafted file can claim tips of 60000×60000 px, run past its end, or nest a property list into itself, which a naive reader turns into a huge allocation, an out-of-bounds read or endless recursion.
- **Root Cause**: Neither `.abr` nor Procreate's `Brush.archive` is documented. The ABR v6+ tip header is found by skipping a fixed 47 (subversion 1) or 301 (subversion 2) bytes after each tip's length, as GIMP and Krita do; preset names and spacing live in a Photoshop descriptor (`desc`) that is only matched by its keys (`Nm  TEXT`, `sampledDataTEXT`, `SpcnUntF#Prc`). Procreate packs are ZIPs of a binary plist plus white-on-black PNGs.
- **Solution / Workaround**: `brushes/import` bounds-checks every read (`Reader.need`), caps tip size (5000×5000), tip and brush counts, ZIP entry and total sizes (inflated with `maxOutput`), plist object counts and depth, and refuses plist cycles. A tip that fails is reported in `unsupported` and the rest import; only a file with nothing readable throws (`BrushPackError`). Procreate sources are read with `channel: 'lightness'` (white paints), ABR masks as they are (255 paints). The fuzz test in `brush-pack-import.test.ts` flips bytes in every fixture and expects only `BrushPackError`s. Fixture packs are generated by `tests/helpers/brush-packs.ts`; never commit third-party packs.

### [core] `normalizeAdjustmentLayer` Drops What It Does Not Know, So Tools Must Check `params` First
- **Issue / Symptom**: `add_adjustment_layer` with `{ kind: "levels", params: { "master.gamma": 1.18 } }` returned success and a neutral layer. An agent had no sign that its adjustment was lost.
- **Root Cause**: `normalizeAdjustmentLayer` rebuilds `params` from the keys each kind uses and fills the rest with neutral values. That is right for stored and hand-written documents. `list_controls` also shows dotted ids (`master.gamma`), which only `set_adjustments` resolves, while `params` is nested.
- **Solution / Workaround**: A tool taking `params` calls `assertAdjustmentParams(kind, params)` before changing anything. It walks them beside `defaultAdjustmentParams(kind)`, so a new parameter only needs its default. Keep the normaliser lenient: documents must still load.

### [conformance] A Paint Scenario Can't Paint with a Brush in the Step After `create_brush`
- **Issue / Symptom**: A recorded paint scenario that calls `create_brush` and then `paint_stroke` with that `brushId` records `Unknown brush "<id>"` for the stroke, although the brush was saved.
- **Root Cause**: The TS paint editor reads the shared brush library again when it changes (`refreshBrushes`), and that read is asynchronous: the next tool call can run before the new brush is in the editor's list. The Swift library is synchronous, so a Swift run would paint where the recording says it failed.
- **Solution / Workaround**: Put a read of the library between them (`describe_brush` with the new id, or `list_brush_sources`), as `stamp-tips.json` and `brush-tips-and-grain.json` do. Check a fresh recording's results for `Unknown brush` before committing it.

### [swift] Dab Flips Ride on `PenDab`, Not on `Dab`
- **Issue / Symptom**: Porting `dynamics.flip` by adding `flip` to `Dab` would touch every engine that builds dabs, and a spray droplet or a light-paint twin could lose it.
- **Root Cause**: In TS `PenDab extends Dab`, so `{ ...d }` copies `flip` into every mark made from a dab. In Swift `PenDab` holds a `Dab` (`d.dab`), and the stamp rasterizer takes a `Dab`.
- **Solution / Workaround**: `flip` is a field of `PenDab`, passed explicitly to `rasterizeStampDab(_:_:…)` with the dab's own index as the stamp seed. `sprayDroplets` copies the whole `PenDab`, so droplets keep it. New per-dab state from the walker belongs on `PenDab` the same way, and engine JSON keeps the TS key order (`dynamics.count` / `flip` after `scatter`, `tipGrain` between `spray` and `paint`), written only when not the default.

### [swift] Porting a Binary Reader: JavaScript Reads Past the End as 0, Swift Traps
- **Issue / Symptom**: A line-by-line port of the TS brush pack readers (`zip.ts`, `bplist.ts`) crashed on truncated or corrupted packs where the TS code only threw or read nonsense.
- **Root Cause**: In JavaScript `bytes[p]` past the end is `undefined`, which bit operations read as 0, and `Number` sizes never overflow. Swift traps on an out-of-range index and on `Int(Double)` of a huge value.
- **Solution / Workaround**: Read single bytes through `byteAt` (0 past the end, as JavaScript reads them), read 8-byte plist sizes as `Double` and bounds-check before converting, and clamp UIDs. `BrushPackImportTests` corrupts each fixture pack 150 times with the TS test's own generator, and every failure must be a `BrushPackError`. The Swift plist reader also caps the objects read in all (shared objects are read again at each reference), which the TS reader doesn't need to finish small files but a hostile one could exploit.

### [swift] JavaScript `toLowerCase` and `trim` Are Not Swift's `lowercased()` and Whitespace
- **Issue / Symptom**: A Swift port of the command palette ranking (`fuzzyMatch`, `exactBonus`) could rank or match differently from the TS core on non-ASCII queries and labels.
- **Root Cause**: V8's `toLowerCase` applies the final-sigma rule (`ΟΔΟΣ` → `οδος`), which Swift's `lowercased()` skips, and JavaScript's `trim` whitespace set (U+FEFF among others) differs from Swift's `whitespacesAndNewlines` (which includes U+0085, JavaScript's doesn't).
- **Solution / Workaround**: Use `String.jsLowercased` and `String.jsTrimmed` (`PixerateCore/JSString.swift`) wherever the TS calls `toLowerCase` or `trim` on text that compares across ports. `tests/swift-command-vectors.test.ts` pins them against Node, with astral characters, `İ` and final sigma.

### [core/vector] Contracts Must Export a Command Spec's Own Flags, Not Defaults
- **Issue / Symptom**: Building the Swift vector commands straight from `domains/vector/commands.json` made `vector.list`, `vector.select`, `vector.setTool`, `vector.exportSvg` and 27 other commands undoable, and gave `vector.list` a params schema `list_commands` would show.
- **Root Cause**: `vectorContracts` in `vector/contract.ts` first wrote `undoable: s.undoable !== false` and an empty `params` schema for a spec without one, while `CommandRegistry` runs a command in a history batch only when `!!spec.undoable` and lists `params` only when the spec has it. A spec that left `undoable` unset was not undoable in TS but `true` in the contract (31 commands).
- **Solution / Workaround**: The contract now writes the spec's own flags (`!!s.undoable`, `!!s.readOnly`) and `params` only when the spec has them, and `tests/vector-contracts.test.ts` compares each command's `params`, `undoable` and `readOnly` with its spec. `createVectorCommands` in Swift takes them from the contract as they are. Export a spec's fields as the registry reads them, never with a default of your own.

### [swift] Swift Vector Documents Compare by Value Where the TS Compares by Identity
- **Issue / Symptom**: The TS `VectorEditorController` decides whether an edit made an undo step (`before.doc === after.doc`) and which paths a distortion brush changed (`findVectorNode(next.nodes, id) !== this.getNode(id)`) by object identity. Swift `VectorDocument` and `VectorNode` are values.
- **Root Cause**: TS edits build new objects for whatever they touch (spreads, `mapTree`), so identity means "was rewritten", even when the new object has equal content.
- **Solution / Workaround**: The Swift `commit` compares documents with `==`: an edit that leaves the document equal records no undo step (the TS would record one that changes nothing; no result or document differs). Where identity carries meaning (the distortion brushes' `ids`), the Swift tracks the nodes it rewrote explicitly instead of comparing. Port other `!==` checks the same way, never by comparing content.

### [swift] Vector Scenario Ids Come from a Counter, So `newId` Calls Must Happen in TS Order
- **Issue / Symptom**: A vector scenario result such as `{ "ids": ["n9", "n10", "n11"], "selection": ["n12"] }` (Pathfinder) fails when the Swift asks for the group's id before the pieces' ids.
- **Root Cause**: `createVectorConformanceHost` makes ids `n1`, `n2`, … and the vector host's `isGeneratedId` matches nothing, so ids are compared as they are. Every `createId` call counts, including the ones `newId` and `freshIds` skip because the id is taken.
- **Solution / Workaround**: Call `newId()` / `freshIds` exactly where the TS does (before `change`, inside a loop, after the loop), and keep `VectorConformanceHost.isGeneratedId` returning false. To see what the TS does at a step, bundle the core with the repo's esbuild (`node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild packages/core/src/vector/contract.ts --bundle --platform=node --format=esm --outfile=<scratch>/vector.mjs`) and replay the scenario against `createVectorConformanceHost` in Node.

### [swift] A Lens's Backdrop Is Nodes Inside a Node, So Swift Stores It as JSON and Compares It by Value
- **Issue / Symptom**: Porting `resolveVectorLenses` as written needs a `VectorNode` that holds other `VectorNode`s in a member (`lensView`), and its `sameView` check compares the backdrop's nodes by identity (`n === m`), with a 1e-12 matrix tolerance only for the `~below` wrapper groups.
- **Root Cause**: The TS stores the derived backdrop on the lens as live node objects and keeps them when nothing changed, so the controller's refresh returns the same document object. Swift nodes are values with typed slots for `subpaths` and `children` only.
- **Solution / Workaround**: `Lens.swift` stores `lensView` as the nodes' JSON (`toJSON()`), rebuilds the nodes when drawing (`vectorLensDrawn`), and refreshes a lens only when that JSON differs from the backdrop it would get (the wrapper matrices are computed the same way each time, so value equality matches the TS check). `VectorEditorController.refreshed` resolves lenses after every change and `toJSON` strips them (`stripVectorLensViews`), as the TS `toJSON` does, so saved documents never hold a backdrop.

### [swift] Porting Appearance Code: `undefined` in Spreads, JavaScript's `%`, and BigInt Hashes
- **Issue / Symptom**: Line-by-line ports of `appearance.ts`, `pathEffects.ts` and `lens.ts` can leave stale members on shape sources, turn negative trim offsets or heat-map positions the wrong way, or trap in Wiggle Paths' hash.
- **Root Cause**: The TS restyles sources with spreads such as `{ ...s.source, fills: undefined, strokes: undefined }`; the key stays in the object but `JSON.stringify` and every `?.length` / `Array.isArray` read treat it as absent. `x % 1` keeps the sign of `x`: that is Swift's `truncatingRemainder(dividingBy:)`, not `remainder(dividingBy:)`, which rounds to the nearest multiple. Wiggle hashes with `BigInt` masked to 64 bits and `BigInt.asUintN(64, BigInt(t))` for lattice times that can be negative.
- **Solution / Workaround**: Remove the member (`node[key] = Optional<JSONValue>.none`) wherever the TS spreads `undefined`; key order is not compared for these shapes. Write `((x / 360).truncatingRemainder(dividingBy: 1) + 1).truncatingRemainder(dividingBy: 1)` for the TS `((x % 1) + 1) % 1`. Port the hash with `UInt64` and wrapping operators (`&+`, `&*`), and convert negative times as two's complement (`0 &- UInt64(-t)`). `swift-vector-appearance-vectors.test.ts` checks every ported effect, mask, filter, lens and gradient edit against the TS (and replays the commands' failures) through `Fixtures/vector-appearance-vectors.json`.

### [conformance] A Swift `skip` Must Be Written the Way the Recorder Writes Fixtures
- **Issue / Symptom**: Hand-editing a fixture to add `"skip": { "swift": … }` can make `node scripts/record-conformance.mjs --check` report the file out of date.
- **Root Cause**: The recorder rewrites each scenario as `JSON.stringify({ ...scenario, steps }, null, 2) + "\n"`, keeping the scenario's own key order. Any other spacing or key order differs from what it writes.
- **Solution / Workaround**: Add skips with a script that parses the file, inserts `skip` (the vector fixtures put it after `setup`, before `steps`) and writes `JSON.stringify(value, null, 2) + "\n"`. The reason names what is missing and the issue, e.g. `"Symbols and instances are not ported yet (#624)."`.

### [swift] `swift test --skip-build` Replays the Fixtures of the Last Build
- **Issue / Symptom**: After editing a recorded scenario (`packages/conformance/domains/*/fixtures`), `swift test --skip-build` still passed against the old expectations; a deliberately broken expectation was not caught.
- **Root Cause**: `PixerateContracts` ships the conformance package as SwiftPM resources, which are copied into the test bundle when it is built. `--skip-build` reuses the copies from the last build.
- **Solution / Workaround**: Run `swift build --build-tests` (with the same flags as `swift test`) after re-recording or adding a scenario, then `swift test --skip-build`. To check that a comparison really bites, break an expectation, rebuild, run, and restore the file.

### [core/vector] Gradient Paint Servers Mix Number and String Attributes, and Render Steps Compare Their Types
- **Issue / Symptom**: A port of `vectorGradientSvgDefs` whose attributes were all numbers (or all strings) fails the `render: true` steps of the vector scenarios, though the SVG it would draw is the same.
- **Root Cause**: The TS writes some attributes through `fmt` (`x1: "0.5"`, `fx`, `fy`, `fr`: strings rounded to 6 places, `-0` as `"0"`) and others as plain numbers (`cx: 0`, `cy: 0`, `r: 1`, and `x1: 0 … x2: 1` for a skewed frame). Render data is compared as JSON, where `"0"` is not `0`; only the SVG export turns both into the same text.
- **Solution / Workaround**: Keep each attribute's JS type: `SvgGradientDef.attrs` is a `JSONObject` filled in the TS order with the TS value type (`gradientFmt` returns a string). Stop offsets are strings (`"50%"`) and `stopOpacity` a number.

### [core/vector] SVG Import Never Sees `IDENTITY_MATRIX` Itself, So Every Shape Is Transformed and Normalised
- **Issue / Symptom**: Porting `parseVectorSvg`'s `placed` with its `m === IDENTITY_MATRIX` shortcut taken for untransformed shapes would skip `transformVectorNode` and `normalizeVectorPaintStacks(…, 'stack')`, and could leave stacks or key order different from the TS.
- **Root Cause**: `visitOne` always builds `m` with `multiplyMatrices`, which returns a new array, so the identity-object check in `placed` is never true there; only `parseSvgTransform` returns the shared `IDENTITY_MATRIX` (for an attribute with no transform in it).
- **Solution / Workaround**: The Swift importer always runs `placed` (transform, stroke scaling, normalisation), and `parseSvgTransform` returns `nil` where the TS returns the identity object, so callers that compare by identity can tell. Port other `=== IDENTITY_MATRIX` checks by asking where the matrix came from, not by comparing values.

### [swift] ICU's `\s` and `\w` Are Not JavaScript's, and Neither Is `String.split`
- **Issue / Symptom**: Regular expressions copied from the TS SVG importer into `NSRegularExpression` matched differently on non-ASCII input (`\w` took accented letters in tag names, `\s` missed U+FEFF and vertical tab), and splitting number lists with `(?=-)(?<![eE])` gave an empty first token.
- **Root Cause**: ICU's `\w` is Unicode word characters and its `\s` is `[\t\n\f\r\p{Z}]`; JavaScript's are `[A-Za-z0-9_]` and its WhiteSpace + LineTerminator set. JavaScript's `split` skips an empty match at the start of the remaining string (ECMA-262 `@@split`), which a naive loop over matches does not.
- **Solution / Workaround**: `SvgImport.swift` spells the classes out (`WS`, `W`) and splits with `NSRegularExpression.split`, a port of `@@split` (anchored matches with transparent bounds, so lookbehinds see the text before). Numbers read from markup go through `String.jsParseFloat` and `String.jsToNumber` (`PixerateCore`), not `Double(_:)`, which refuses `"5."`, `" 12 "`, `"0x1F"` and `"3px"`.

### [swift] A Width Profile of All-1 Scales Is No Profile, So Test Stroke Extras on the Sanitised Profile
- **Issue / Symptom**: The first Swift `hasStrokeExtras` (render data and SVG export) treated any non-empty `strokeWidthProfile` as a variable-width stroke (and the first mask outline refused it), while the TS draws `[{ t: 0, left: 1, right: 1 }, { t: 1, left: 1, right: 1 }]` (what `vector.setWidthProfile` with an empty `taper` stores) as a plain stroke.
- **Root Cause**: `stroke.ts` reads the profile through `strokeWidthProfileOf`, which sanitises it and returns `null` when `isUniformWidthProfile`; the stored array itself stays as given.
- **Solution / Workaround**: Ask `strokeWidthProfileOf(style)` (`VectorStroke.swift`), never the raw array, whether a stroke is profiled: `hasStrokeExtras`, `vectorStrokeReach`, `arrowheadWeight` and `vectorStrokeLineArea` all do. Only `withStyle` and `sanitizeVectorStrokeSettings` look at the raw array, to store or drop it.

### [swift] Variable-Width Outlines Need V8's Trig, but `Math.acos` Only Sets a Step Count
- **Issue / Symptom**: `variableStrokeOutline` refits its rings with `fitCubics` and unions them with the polygon boolean, so one bit of difference in a ring point can move a fitted anchor by more than the conformance tolerance (the `strokes-and-corners` outline is compared to 1e-9).
- **Root Cause**: Round joins inside curves and round caps place their points with `Math.cos`, `Math.sin` and `Math.atan2`, which are V8's fdlibm, not the platform's libm (see "V8's `Math.exp`, `sin`, …" above). `arcPoints` also calls `Math.acos`, but only to choose how many points an arc gets (`Math.ceil` of a ratio).
- **Solution / Workaround**: `VariableStroke.swift` uses `JS.cos`, `JS.sin`, `JS.atan2` and `JS.hypot`; `Math.acos` stays Foundation's, as in `PixerateGeometry` (`jacos`). If a fixture ever disagrees on the number of arc points, port fdlibm `acos` into `JS` rather than adjusting the tolerance. `vector-stroke-vectors.json` covers round joins, round and square caps, dashes and U-turns.

### [swift] Brushstroke Layers Are Data in the Vector Port; Drawing Them Needs the Raster Brush Engine
- **Issue / Symptom**: `vector.addBrushstroke` and `vector.setBrushstroke` work in Swift, but the scene render data and SVG export of a path with a visible brushstroke throw `VectorNotPorted`.
- **Root Cause**: The TS renders a brushstroke by running the paint engine along the flattened path (`renderBrushstroke`, the wet simulation, or a backdrop for the Mixer Brush, smudge and blender) and embeds the PNG; the Swift paint engine is not wired to vector paths yet. Listing, checking and storing brushstrokes only needs the brush presets and `checkBrush`, which `PixeratePaint` has.
- **Solution / Workaround**: `PixerateVector` depends on `PixeratePaint` and imports it only in `Brushstroke.swift`, which turns brushes into plain data (`VectorBrushstrokeBrushInfo`, JSON layers); the rest of the module never sees paint types. Saved library brushes are supported by the functions (`user`) but the Swift controller has no `brushLibrary` option yet, so commands see the presets only.

### [swift] Freeform Fills Make Paint Servers Too Big for Test Vectors, and Render Data Keys Come in Another Order
- **Issue / Symptom**: `swift-vector-shading-vectors.test.ts` first wrote a 3.4 MB fixture, and digests of the Swift render data never matched the TS ones although every def compared equal.
- **Root Cause**: A freeform gradient is drawn as about a hundred strips, each a linear gradient of up to 96 stops, whatever the shape's size, so every exported SVG or render data holding one is close to a megabyte. Separately, Swift's render data builds node objects in a different key order from `render.ts` (`id`, `transform`, `opacity`, then `kind`); the other vector tests compare keys as sets, so it never showed.
- **Solution / Workaround**: The test stores `{ length, sha256 }` of the exported SVG text and of the render data stringified with every object's keys sorted (`canon` in TS, `sortedKeys` in `VectorShadingVectorTests`), and keeps freeform paint servers in the entries small with `freeformCells`. When a digest fails, write both sides to files and diff them.

### [core/vector] Mesh and Freeform Paints Cannot Go Through `setStyle`, `addShape` or `addFill` Commands
- **Issue / Symptom**: `vector.setStyle` with `fill: { type: "mesh", … }` (or `vector.addFill` with a freeform paint) fails with `invalid_params … /fill Expected string, got object.`, although `checkPaint` in `commands.ts` has a branch that checks mesh and freeform paints.
- **Root Cause**: The `PAINT` params schema allows a string, `null` or a gradient object with `required: ['type', 'stops']`. A mesh or freeform paint has no `stops`, so argument validation rejects it before `checkPaint` runs; the shaded branch is only reached by callers that skip the schema.
- **Solution / Workaround**: Agents give paths meshes and freeform gradients with `vector.setMeshGradient` / `vector.setFreeformGradient` and edit them with the point commands. The controller (`setStyle`, paint stacks) and SVG import still take them, and the Swift port checks them the same way (`sanitizeVectorShadedPaint`). Widening `PAINT` would make the shaded branch reachable; the recorded scenarios and Swift vectors pin the current errors.

### [swift] A Spread's New Values Read the Object Before the Spread
- **Issue / Symptom**: The first Swift port of `transformVectorEffects` and Free Distort's `mapEffects` turned an envelope preset under a skew into the flat identity mesh, not the warp it stood for.
- **Root Cause**: The TS writes `{ ...e.params, style: 'mesh', mesh: mapVectorMeshPoints(vectorEnvelopeMesh(e.params, bounds), f) }`: every value in the literal is computed from the old `e.params` (style still a preset). The port set `params["style"] = "mesh"` first and then called `vectorEnvelopeMesh(params, …)`, which for a `mesh` style without a mesh returns the identity mesh.
- **Solution / Workaround**: When porting a spread with computed members, compute every new value from the original object before assigning any of them (`let mesh = …; params["style"] = "mesh"; params["mesh"] = mesh.json`). `swift-vector-blend-vectors.test.ts` covers presets under a skew, a mirror and a distort.

### [swift] Live Blend Steps Are Cached by Value, and Refreshing Them Cannot Throw
- **Issue / Symptom**: The TS regenerates a blend's steps in `refreshed()` after every change, caching them per first-key object and morphs per key pair, so an unchanged blend costs nothing. Swift nodes are values, and `refreshed()` cannot throw, while the morph can (`VectorNotPorted` for text or instance keys).
- **Root Cause**: Identity caches have no Swift equivalent; regenerating every blend on every `notify()` would run every morph again.
- **Solution / Workaround**: `VectorBlendCache` (owned by the controller) keeps each blend's children by blend id and reuses them while the blend's JSON and its keys compare equal, which gives the TS result. `refreshed()` calls `refreshVectorBlends` with `try?`: a blend whose steps cannot be made keeps the children it has. Steps are ids `<blend>~<n>`, renamed by Expand with the controller's counter in tree order, so expanding must create ids exactly where the TS does.

### [core/vector] Replace Spine Drops a Rotated Path's Rotation
- **Issue / Symptom**: `vector.replaceSpine` with a path that has a rotation (`transform`) makes a spine that runs the way the path ran before it was turned: a horizontal line rotated 90° gives a horizontal spine.
- **Root Cause**: `replaceBlendSpine` maps the path into the blend's space with `transformVectorNode({ subpaths: [first] }, m).subpaths[0]`. `transformVectorNode` puts the rigid part of `m` (rotation and translation) into the node's `transform` and bakes only the residual into the anchors, and that `transform` is thrown away.
- **Solution / Workaround**: Not fixed: the Swift port (`ControllerBlends.swift`) does the same, so both agree. A fix maps the anchors through the whole matrix (as `bakeIntoGeometry` does with `mapAnchor`), then re-records the scenarios that replace a spine and updates the Swift port with it.


### [swift] An Instance's Art Is JSON in the Node, and Isolation Mode Has No View to Move
- **Issue / Symptom**: Porting `resolveVectorSymbols` as written needs instances that hold other nodes (`art`, the symbol's own `nodes` array), compared by identity (`n.art === art`) so an unchanged document comes back as the same object; `vectorInstanceDrawn` is cached per instance object. And `editSymbol` / `exitSymbolEdit` move the TS viewport (`viewInto` / `viewOutOf`), which `getVectorSymbolEditBackground` reads.
- **Root Cause**: Swift nodes are values with typed slots for `subpaths` and `children` only, and the Swift controller has no viewport.
- **Solution / Workaround**: `Symbols.swift` stores `art` as the symbol nodes' JSON, replaces it only when that JSON differs (value equality gives the TS result), and parses it back in `vectorInstanceDrawn` (uncached). `refreshed()` resolves symbols after every change (after syncing the edited symbol's art in isolation mode), `loadedDocument` strips and resolves, and `toJSON` / `toSvg` go through `storedDocument()` and `stripVectorSymbolArt`, so saved documents never hold `art`. Snapshots carry the isolation context, so undo steps in and out of a symbol. `symbolEditBackground` composes its `matrix(…)` with the controller's fixed view, so its `transform` starts `translate(0 0) scale(1)` where the TS starts with the moved view; `VectorSymbolVectorTests` compares only the `matrix(…)` part.

### [swift] SVG Import Elements Keep Attributes in a Dictionary, So Port `Map`-Order Searches by Walking the Tree
- **Issue / Symptom**: `ownInstance` in `svg.ts` finds the symbol a `<g data-vector-instance>` names with `[...byId.values()].find(…)`, which depends on the order `byId` was filled (document order, the first element per `id`). The Swift importer's `byId` is a dictionary.
- **Root Cause**: Swift dictionaries are unordered; iterating `byId.values` would pick an arbitrary match when two of our symbols claim the same id.
- **Solution / Workaround**: `SvgImport.swift` walks the tree in document order (`ownSymbolElements`) and keeps an element only when `byId[id] === el`, which is the same set in the same order. Do the same for any other `Map` iteration in the importer.

### [swift] The Constraint Solver's Parameters Grow While a Constraint Is Read, and the TS Reads Them Through an Alias
- **Issue / Symptom**: A port of `interpret` (`constraints/solve.ts`) that copies `m.x0` at the top of the function (as `const x0 = m.x0` reads) gets an index out of range or the wrong orientation for tangent, distance-to-a-segment, angle and smooth constraints; a port that keeps slots in a dictionary numbers parameters differently and lists the degrees of freedom per path in another order.
- **Root Cause**: `const x0 = m.x0` in the TS is an alias of the model's array, which `P()`, `L()`, `C()` and `joint()` keep appending to as they allocate slots; the signs and scales taken from "the starting geometry" read values allocated after the alias was taken. Slots live in a `Map`, so parameter offsets, the write-back and `vectorConstraintDof`'s `nodes` follow first allocation.
- **Solution / Workaround**: `ConstraintSolve.swift`'s `Model` is a class, and every orientation reads `m.x0` after the references it needs are allocated, in the TS call order. Slots keep their allocation order (`slotKeys`), components keep the order of their first constraint, and Swift arrays stand in for `Float64Array`s. With that, the iterative solve stops on the same iteration as the TS: `vector-constraint-vectors.json` compares solved documents bit for bit (only angle rows go through `atan2`).

### [swift] `toFixed` Rounds Exact Ties Up, `printf` Rounds Them to Even
- **Issue / Symptom**: `formatVectorValue` (the value a new dimension gets, `toFixed(6)` with trailing zeros trimmed) written with `String(format: "%.6f")` gave `0.007812` for 1/128 where the TS gives `0.007813`.
- **Root Cause**: ECMA-262 `toFixed` picks the larger of two equally near results; `printf` rounds an exactly representable tie to even. Ties at 6 decimals are rare (a binary fraction with exactly 7 decimals ending in 5, such as 1/128), so most values agree.
- **Solution / Workaround**: `jsToFixed` (`ConstraintExpr.swift`) prints with `printf`, then checks the exact expansion 40 digits further and rounds a tie up by hand; negative values keep their sign (`(-4e-7).toFixed(6)` is `-0.000000`, which `formatVectorValue` turns into `0`). Use it wherever the TS calls `toFixed`.

### [swift] The Solve After Every Edit Skips by Value Where the TS Skips by Identity
- **Issue / Symptom**: The TS `solved()` returns the document untouched when its `nodes`, `constraints` and `parameters` are the very objects it last solved (`lastSolved`), so a component that could not converge keeps its compromise and its `constraintIssues` until something changes. Swift documents are values.
- **Root Cause**: Identity means "not edited since the solve" in the TS; Swift has no identity for these members.
- **Solution / Workaround**: `VectorEditorController.solved` compares them with `==` (constraints and parameters as their JSON). The only difference is an edit that rebuilds equal content (an undo back to the solved document), which the TS solves again and the Swift does not. When the constraints hold, solving again moves nothing, so both end with the same document; a conflicting component may move a little further in the TS. Commands that solve themselves (`addConstraint`, `setConstraintValue`, `autoConstrain`) set `lastSolved` to their result, as the TS does.

### [swift] Master Art and Connector Routes Are Derived in the Refresh, Compared by Value, and Keep What They Have When the Port Cannot Draw
- **Issue / Symptom**: Porting `resolveVectorMasterPages` and `rerouteVectorConnectors` as written needs nodes inside a node (`masterArt`) cached per master object (`vectorMasterArt`'s `WeakMap`), and both run in the controller's `refreshed()`, which cannot throw in Swift, while `vectorNodeBounds` and `transformVectorNode` throw `VectorNotPorted` for text.
- **Root Cause**: Swift nodes are values with typed slots for `subpaths` and `children` only; identity caches and "the same object when nothing changed" have no Swift equivalent.
- **Solution / Workaround**: `Pages.swift` stores `masterArt` as the drawn nodes' JSON, replaces it only when that JSON differs (value equality gives the TS result) and `toJSON` strips it (`stripVectorMasterArt`); `vectorFrameDrawn` parses it back. `refreshed()` reroutes connectors after the constraint solve and resolves master pages before lenses, in the TS order. A connector whose routing throws, or a page whose master art throws (master text), keeps what it has (`try?`), like a blend whose steps cannot be made. Drop those fallbacks once text geometry is ported.

### [swift] The Drawing Plane the Commands Report Is Derived From the Grid, Not the Stored Field
- **Issue / Symptom**: After `vector.setPerspectivePlane({ plane: "side" })` on a one-point grid and `vector.setPerspective` with two vanishing points, a port that returned its stored plane reported `drawingOn: "side"`; the TS reports `null`.
- **Root Cause**: The TS controller keeps the chosen plane in a private field (cleared only when the grid is removed), and `computeState()` publishes `perspectivePlane` only while the current grid still has that plane. The commands read `getState().perspectivePlane`.
- **Solution / Workaround**: `VectorEditorController` stores `drawingPlane` and exposes `perspectivePlane` as a computed property that checks `vectorPerspectivePlanes(grid)`. Port other state fields from `computeState()`, not from the private fields behind them.

### [swift] Going to a Page Moves the Viewport, Which the Render Data's Transform Shows
- **Issue / Symptom**: A command replay that ran `vector.goToPage` and then compared the scene render data failed on `transform` alone (`translate(0 0) scale(1)` against `translate(40 -440) scale(1)`), while the scenario's own steps passed (they record no render data after it).
- **Root Cause**: `goToPage` brings the page into view (`zoomToFit` with a canvas size, otherwise `setViewport` with the page's corner 40 px in), and `getVectorSceneRenderData` writes the viewport into `transform`. The Swift controller had a fixed zoom of 1 and no viewport.
- **Solution / Workaround**: The controller has a `viewport` (`VectorViewport`) that only `setViewport`, `zoomToFit` and `goToPage` move, with the TS zoom range (0.05–64); `zoom` (pick distances) and `sceneRenderData` read it. Pointer panning and wheel zoom are still not ported; isolation mode still does not move the view.

### [core/vector] A Frame Used as a Mask Covers Only What It Draws
- **Issue / Symptom**: A clip group whose mask is an empty frame without a fill hides all its contents, although the frame has a rectangle and bounds.
- **Root Cause**: `vectorMaskRegionShapes` swaps a frame for `vectorFrameDrawn` (a clip group of its fill and children), so the region is the fill and the children clipped to the rectangle. The rectangle itself is only the clip, which covers nothing on its own.
- **Solution / Workaround**: Give a frame used as a mask a fill (or contents) where it should let art through. The Swift port follows the TS (`VectorModelTests.testUnportedFeaturesThrow` pins it).

### [swift] Text Layout Tells Run Styles Apart by Identity, and Merges Neighbours by Their JSON
- **Issue / Symptom**: A port of `computeLayout` (`text/layout.ts`) that compares run styles by value, or merges runs with a field-by-field equality, cuts lines into different fragments from the TS whenever two runs end up with equal styles, or with equal values in a different key order.
- **Root Cause**: Inside a layout the TS compares styles by object identity (`styleAt(runs, j) === style`, `new Set(lineChars.map((c) => c.style))`, `lineChars[m].style === st`); every run's style is its own object, so identity means "the same run". Only `compact` (in `fitRuns`, `restyleRange`, `spliceRuns`) merges neighbours, and it compares `JSON.stringify` output, so key order counts.
- **Solution / Workaround**: `TextLayout.swift` keeps run styles as `JSONObject`s, identifies a character's style by its run index (`runIndexAt`, -1 for the default style), and `compactRuns` compares `stringified()` text. Text is `[UInt16]` throughout (JavaScript strings), and the metric shaper classifies code units, not characters. `swift-vector-text-vectors.test.ts` covers runs that differ only by fill, surrogate pairs and CJK.

### [swift] The Text Shaper Is Process-Wide, and Text Layout Is Not Cached
- **Issue / Symptom**: A Swift test that sets an outline shaper (`FakeOutlineShaper`) and leaves it set makes every later test lay text out with it: bounds, render data and `vector.listFonts` change in suites that never touched the shaper.
- **Root Cause**: As in the TS (`setVectorTextShaper`), geometry helpers such as `vectorNodeBounds` are pure functions of the node and reach fonts through one module-level shaper. The TS caches layouts per node object and shaper generation; Swift nodes are values, so the port lays text out again on every call.
- **Solution / Workaround**: `VectorConformanceHost` sets a fresh `MetricTextShaper` when it is created, and tests that change the shaper reset it in `tearDown` (`setVectorTextShaper(nil)` goes back to the metric default). Apps set their shaper once, before documents load (`controller.setTextShaper`). If layout ever shows up in profiles, cache by the node's JSON and the shaper generation (`vectorTextShaperGeneration`), never by node identity.

### [swift] Curve Fitting Breaks Ties Between Equal Corners Exactly, So `Math.acos` Must Be V8's
- **Issue / Symptom**: Image Trace of a symmetric ring in Swift fitted its hole with two cubics starting at another anchor, where the TS fits three; every other traced shape matched.
- **Root Cause**: `findCorners` (`canvas/curveFit.ts`) keeps only the sharpest vertex of a neighbourhood and breaks ties by index (`turns[k] === turns[i] && k < i`). A symmetric outline has turns that are equal up to the last bit, and the turn is `Math.acos` of a dot product. Foundation's `acos` differs from V8's fdlibm port for about 15 % of inputs, enough to make a different vertex the sharpest.
- **Solution / Workaround**: `JS.acos` (`PixerateRaster`) ports fdlibm `e_acos.c` with `fma` where clang contracts on arm64; it matched Node 25 on 200 000 inputs, and `testV8MathOnArm64` keeps a few. `jacos` in `PixerateGeometry`, live corners and variable-width strokes use it. When a port compares floating-point results for equality or order (ties, `>` against a sibling), every function feeding them must be V8's, not only the ones whose values are compared.

### [swift] Porting the PDF and Lottie Writers: Typed Paint Servers, UTF-16 Strings and JavaScript's `Number()`
- **Issue / Symptom**: The vector PDF writer reads the scene render data, whose paint servers the Swift renderer kept only as JSON; Lottie import read values the TS reads differently (`lottieValueAt([1, 2])` is `[]`, `Number([5])` is 5); a PDF title with non-ASCII text came out with the wrong number of `?`.
- **Root Cause**: The TS `Page` fills from the typed `defs` map of `getVectorSceneRenderData`. In JavaScript an array is an object, so `[1, 2].k` is `undefined`; `Number()`, `??` (null and undefined both fall through) and template literals each convert JSON values their own way. `pdfString` replaces each UTF-16 code unit outside printable ASCII, so a character outside the BMP is two `?`. Image Trace's `squareContourCorners` compares `out[0] === ring[0]` by identity.
- **Solution / Workaround**: `vectorSceneRender` returns the render data with its `[VectorPaintDef]`; `getVectorSceneRenderData` wraps it. `Lottie.swift` reads untrusted values through `jsNumberOf` (`Number()`), `nn` (`??`) and `jsTemplate` (template literals), and treats arrays as objects without members in `lottieValueAt`. `pdfString` walks `utf16`. The corner squaring tracks whether the first point was kept as it was instead of comparing values. `swift-vector-io-vectors.test.ts` compares PDFs byte for byte (compressed through the ported `deflate`), Lottie exports, imports and round trips, traces and styles, and replays the commands with their failures through `Fixtures/vector-io-vectors.json`.

### [swift] The Effect Tools' `effect` Argument Has No Enum in Swift, So Unoffered Effects Reach the Handler
- **Issue / Symptom**: A replay of `apply_effect` with a motion effect (`fake.fade-in`) on the vector editor gave `invalid_arguments` ("Expected one of …") in the TS and `tool_failed` ("… is a motion effect; the vector editor adds vector effects …") in Swift.
- **Root Cause**: The shared TS effect tools (`effects/tools.ts`) fetch the provider's catalog in the background and, once it lands, list the offered ids (up to 60) as an `enum` in `apply_effect`'s `effect` schema; until then (and in `tools.json`, which is exported before any fetch) the schema is a plain string. The Swift tools build their definitions from the contracts, so they never have the enum.
- **Solution / Workaround**: Both refuse the effect before changing anything, with a message saying why. Scenarios and test vectors use offered effect ids for `apply_effect` (`swift-vector-tools-vectors.test.ts` leaves the unoffered case out and `VectorToolsVectorTests` checks the controller's message instead). Porting the live enum needs an async catalog load before the registry validates, which Swift's synchronous `tools()` can't do without a task that captures the editor.

### [swift] Generated Art: Ids Come From the SVG Parser, Provenance Times From the Clock, and the Prompt Grammar Is Not Ported
- **Issue / Symptom**: `generate_vector_art` returns child ids like `node-1` while `regenerate_vector_art` returns `n5`; provenance `createdAt` differs on every run; a prompt with `{{template}}` tags gets a source map of several segments.
- **Root Cause**: `generateVectorArt` adds the parsed SVG's nodes as they are (the group id is `generated`; ids are only refreshed when they clash), while `replaceGeneratedArt` gives the new children fresh ids. `createProvenance` stamps `Date.now()`. With no templates or values, `resolvePrompt` keeps each `{{tag}}` as its own locked segment.
- **Solution / Workaround**: The Swift port does the same (`Generate.swift`), and the conformance runner normalises timestamps. `PixerateCore`'s `createProvenance` records prompts as written (no templates, bindings or values: the prompt grammar lives only in the TS core) and builds that source map with the TS template regex, in UTF-16 offsets. Test vectors normalise only the times the run makes: an SVG imported in a replay keeps its fixed `createdAt`, since escaping a normalised `<time>` inside an attribute gives `&lt;time&gt;` in Swift's export but not in the TS run that imported the real time.

### [swift] Idempotency Keys Keep a Thrown Error, but Forget a Failed Result
- **Issue / Symptom**: A retry of `generate_vector_art` after a generator error that throws (not one the tool reports) returned the same error without calling the generator again, while a retry after an `ok: false` result (bad prompt, unknown model) ran again.
- **Root Cause**: The TS `once` stores the promise per key and deletes the key in a `.then` only when the result is not `ok`; a rejected promise never reaches that `.then`, so it stays. Generator failures inside `produce` are caught and become `ok: false` results, so only errors outside it (an SVG feature `VectorNotPorted` in Swift) are kept.
- **Solution / Workaround**: `VectorGenerationRuns` mirrors it: the outcome (`Result`) is kept per key, waiting calls with the same key and input share it, a failed result removes the key, a thrown error stays. A different input under a used key is refused (compared by `stableStringify`, keys sorted by UTF-16 units).

### [swift] Wet Brush Dab Invalidation Must Be Per-Tile, Not Per-Lane
- **Issue / Symptom**: Painting with a wet brush over a canvas with many active wet tiles (e.g., 16–25 tiles) lagged badly on pointer moves (~43 ms/move on M4 Pro, Release), even when the dab touched only 1 tile.
- **Root Cause**: Five things stacked on each pointer move and tick:
  1. `WetWorld.markEdited` bumped a single lane-wide `stamp`, invalidating the cached shaded `RasterTile` of every active tile in the lane, and `setBase` / `setLight` cleared the entire `lane.shaded` / `lane.lightShaded` cache whenever `rewet` lifted dried pigment on one tile.
  2. `PaintEditorController.updateSurfaces` assigned `doc` (whose `didSet` called `emit()` with `dirty == nil`, wiping out `dirtySince`) and then called `emit()` again without tile bounds, forcing the view compositor to scan and re-composite every changed tile across the canvas.
  3. `PaintLiveStroke.push` and `PaintWetLayers.tick` called `syncDisplays()` (CPU-only) instead of `syncDisplaysGpu()`.
  4. `WetWorld.refreshHalos()` copied borders for all active tiles synchronously after every single dab inside `paint`, `addWater`, `dry`, and `setPaper` rather than lazily before `step` / `snapshot`.
  5. `PaintEditorModel` bumped one `@Observable` `revision` counter for both canvas frame updates (`pointerMove`, `tick`) and UI state changes, which re-evaluated all SwiftUI chrome (`ContextBar`, `ToolRail`, open panels—including `PaintWetPanel`, which called `world.stats(id)` and scanned all 65,536 pixels of every active tile) on every pointer move and 60 Hz wet tick.
- **Solution / Workaround**: `WetLane` tracks per-slot stamps (`slotStamp[key]`), and `setBase` / `setLight` invalidate only tiles whose `RasterTile` identity (`!==`) changed; `updateSurfaces` sets `doc` via `setDocSilently` and emits the exact changed tile rectangles once; `push`, `tick`, `advance`, and `dry` use `syncDisplaysGpu()`; `refreshHalos()` marks `halosDirty = true` and flushes in parallel at the start of `runHere` and `snapshot()`; `pixerate_wet_step` skips completely dry 4-cell blocks and dry-cell pigment face loads (bit-identical to the scalar reference); and `PaintEditorModel` separates `revision` (canvas + step label) from `stateRevision` (chrome + panels) and reads wet slider settings via `wetLayerSettings` instead of `world.stats(id)`.

### [swift] Wet Slot Stamps Say "Changed", Not "How Long Ago"
- **Issue / Symptom**: On canvases with more than `DISPLAY_TILES_PER_TICK` stale wet tiles, older tiles stopped updating while the newest kept reshading. Tiles freed between shadings kept their old pixels on screen.
- **Root Cause**: `slotStamp` counts one tile's own changes, so its values can't be compared between tiles, and the "longest unshaded" sort did exactly that. Separately, once `updateSurfaces` emitted exact rectangles, a freed tile was in no rectangle because `display` only reported tiles it reshaded.
- **Solution / Workaround**: Order shading by `shaded[tk].at`, the lane stamp when the tile was shaded. `free` records the tile in `lane.freedRects`, and `display` drains that into `changed`.

### [swift] Light Changes Must Dirty the Whole Canvas
- **Issue / Symptom**: Emitting tile rectangles from `updateLights` looks like an easy win for lit wet layers, but would leave stale glow on the neighbouring tiles.
- **Root Cause**: Light spills past the tile it is painted in (`computeSpill` blurs it by `LightSpill.radius`), so a light change reaches pixels outside its tiles.
- **Solution / Workaround**: Keep `emit(nil)` in `updateLights`. Any narrower rectangle has to grow by the full reach of the spill blur.

### [core|swift/paint] Path-Native Effect Paint (`map: { by: 'path' }`) Samples in Canvas Space and Renders Per Stroke Path
- **Issue / Symptom**: If `EffectPaintPixels.map` is populated for `map: { by: 'path' }` as it is for `map: { by: 'stroke' }`, dabs sample the canvas-sized effect through `stripIndex` `(u, v)` strip coordinates instead of canvas `(x, y)`, scrambling the path effect's pixels; and if `paintStroke` only uses the initial render from `setEffectPaint`, the effect's path control stays at its default `""` instead of the stroke's centreline.
- **Root Cause**: `by: 'stroke'` renders a `length × 256` strip once and bends it in `sampleEffectField` / `sampleEffectAt` via `EffectPaintPixels.map`. `by: 'path'` instead passes the stroke's centreline `[x0, y0, x1, y1, …]` in canvas pixels (resampled to at most `MAX_EFFECT_PATH_POINTS = 256` points) to the effect's `format: 'svg-path'` control (`withStrokePath`) and renders at the canvas size, so each dab samples the rendered canvas image directly at document `(x, y)` (`EffectPaintPixels.map` must stay `undefined` / `nil`).
- **Solution / Workaround**: Keep `EffectPaintPixels.map` only when `p.map?.by === 'stroke'`. In `varyStroke`, `editStrokePoints`, `paint_stroke`, `stroke_path` and `replay_strokes`, update the stroke's effect paint via `withStrokePath` and pre-render the path-specific `PaintEffectPaint` before running the synchronous stroke (`prepareStrokePathEffect`, `prepareStrokeEdit`, `prepareStrokeEffects`). `renderSync` / `SyncEffectRenderer` is only a shortcut for renderers that have it, such as the fake one: test with a provider that lacks it too. A stroke with no render throws; it must never fall back to the effect's render without a path, which paints the wrong picture while the recorded stroke claims the right one.

### [core|swift/paint] A Hand-Painted Path Stroke Is Only a Preview Until the Pen Lifts
- **Issue / Symptom**: With `map: { by: 'path' }`, a stroke from `beginStroke` painted the effect's no-path picture, recorded the path anyway (so a replay looked different), and was lost entirely when that picture was empty under it (`end` commits nothing when no pixel changed). A test that probes pixels where `fake.trail` also draws with no path (the line across the middle, y = 32) can't tell the difference.
- **Root Cause**: The path isn't known until the stroke ends, so the live session can only sample the render without one, and renders are asynchronous while `end()` is synchronous.
- **Solution / Workaround**: The live stroke commits nothing. TS: the session's commit calls `finishPathStroke` before its check for changed pixels, which runs `paintStroke` with the path's render, at once if `renderSync` can, otherwise when it lands. Until then `strokeRendering` is set, `requireIdle` refuses and the preview stays up, so `result.strokeId` fills in late. Swift: `end()` throws while `needsPathRender`, leaving the stroke open; `PaintGesture` awaits `renderPath()` first. Wet brushes can't be painted twice, so `sessionFor` refuses them by hand. While the pen is down the preview follows the path drawn so far: each sample starts a render of the path so far when none is running (TS `previewPathStroke`; Swift `renderPreview()`, which `PaintGesture` loops while `needsPathPreview`), and when it lands the stroke so far is painted again with it (TS `PaintStrokeSession.repaintEffect`; Swift swaps in a second session, `shown`). Those renders stay out of the effect paint cache, or a long drag would push out the editor's own no-path render and the next stroke on an async provider would fail; the release reuses the last one (or the one in flight) when its path is the whole stroke.

### [core|swift/paint] Each Path Stroke Has a Canvas-Sized Render, So the Effect Cache Can't Be Sized for Them
- **Issue / Symptom**: Raising the effect paint cache to fit path strokes holds hundreds of MB for everyone, and growing it per replay holds one canvas per stroke for good (about 33 MB each at 4K). Keeping it small makes a stroke layer redraw throw once its path strokes outnumber it.
- **Root Cause**: Stroke layers redraw synchronously and need every overlapping stroke's render, and `replayStrokes` needs all of them before it starts, but `replayPainting` is asynchronous and needs one at a time.
- **Solution / Workaround**: The limit stays 6 and rises only for what must be held together: the path strokes on stroke layers (`trimEffectPaints`) and the running batch (`effectPaintBatch`, cleared when `replayStrokes` ends). `replayPainting` prepares path strokes one by one, just before each is painted.

### [core|swift/paint] Thin-Film Iridescence (`ThickChannels.film`) Shades Flat Paint and Needs `#if canImport(CoreMotion) && os(iOS)` in Swift
- **Issue / Symptom**: Flat brushes (`dab`, `mixer`, `particle`, `bristle`, `wet`) with `iridescence` showed no colour shift when `LitCache.lit` / `lightTile` returned early on `ch.height.tiles.size === 0` or `light.relief === 0`; and in Swift, guarding `CMMotionManager` with `#if canImport(CoreMotion)` alone failed to compile on macOS with `'CMMotionManager' is unavailable in macOS`.
- **Root Cause**: `LitCache` and `lightTile` originally skipped tiles without height slopes, whereas flat iridescent strokes store `film` tiles with an empty `height` surface and rely on a flat normal `(0, 0, 1)` plus the half-vector from `lighting` and `viewTilt`. On macOS, the SDK ships `CoreMotion.framework` (for headphone motion), so `canImport(CoreMotion)` is true even though `CMMotionManager` is marked `API_UNAVAILABLE(macos)`.
- **Solution / Workaround**: `LitCache.lit` and `lightTile` check both `hasRelief` (`height` non-empty and `light.relief > 0`) and `film` (and include `film` tile identity and `viewTilt` in the `LitCache` key). Guard `CMMotionManager` with `#if canImport(CoreMotion) && os(iOS)` in `PaintEditorModel.swift`.
### [core|swift/paint] Ghost Paint Uses the Wet Light Channel as a Linear Tracer, Suspended Rewet, and Zero Pickup
- **Issue / Symptom**: A ghost stroke (`brush.ghost`) must mix visibly with wet paint and smear dried paint, then fade away leaving bare paper byte-identical and no ghost colour tint on smeared paint, without adding planes to the wet kernels. Three subtle traps break this if missed:
  1. Calling ordinary `world.rewet` before `world.drag` fails to smear dried paint on the same dab.
  2. Allowing brush colour pickup (`behavior.pickup > 0`) leaves a residual colour tint after the ghost fades.
  3. Depositing the ghost tracer through `world.paint(..., light)` sets `lane.lit = true`, making the stroke glow and baking the tracer into `doc.light`.
- **Root Cause**:
  1. `world.rewet` writes lifted dried pigment into the settled planes (`P_DR`, `P_DG`, `P_DB`, `P_DS`), which only enter the suspended planes (`P_R`, `P_G`, `P_B`, `P_S`) when the kernel steps (`liftRate`), whereas `world.drag` only advects suspended planes during the stroke dab.
  2. `WetMedium.deposit` converts the brush's mixed RGB colour into Kubelka-Munk K and S non-linearly, so pigment mixed inside the brush reservoir cannot be separated from the single `lane.ghost` pigment vector by linear subtraction.
  3. The wet world has a single light mass channel (`P_L`, `P_DL`), which normally drives `lane.lit`, `shadeLightSlot`, `lightDisplay` and `bakeKey` into `doc.light`.
- **Solution / Workaround**:
  1. `world.rewet` accepts `suspend = true` for ghost strokes, placing 65% of lifted pigment directly into the suspended planes and seeding water to at least `WET_MASK_H * 4` so `world.drag` moves it immediately on the same dab.
  2. `normalizePaintBrush` and `resolveBrush` force `behavior.pickup = 0` whenever `brush.ghost` is set, and `sessionFor` refuses gradient, effect and multi-colour paint on ghost brushes.
  3. When `lane.ghost` is active, `world.paint` does not set `lane.lit`, `shadeSlot` / `bakedLight` / `lightDisplay` skip light shading, and `afterBatch` / `bakeKey` / `dry` run `fadeGhost` (clearing sub-`1e-4` float dust when the tracer reaches 0 so bare paper is byte-identical). Ghost and light strokes refuse to share a layer while either is active.

### [core|swift/paint] Mutation Paint: Held Wet Evaporation, Temporary Dry Layers, and Undo Reconciliation
- **Issue / Symptom**: Implementing mutation paint (#686) across wet and dry brushes exposes four lifecycle traps:
  1. Model calls take seconds, while watercolour evaporates in seconds, baking a wet mutation stroke before `read_mutation` can claim and fade it.
  2. Dry paint cannot be subtracted from a shared layer once other paint lands over it, but creating a temporary layer must not change `activeLayerId`, show in the layer panel, or add an extra undo entry when merged down on `decline_mutation` / `patience` timeout.
  3. If an agent answers a mutation while the user's active brush is still a mutation brush (`mutation-ink` or `mutation-wash`) and omits `brushId` or passes a partial `brush` patch, `answer_mutation`'s own stroke would inherit `mutation` (and `ghost.trigger: "agent"`) and trigger an infinite mutation loop.
  4. In `advanceWet(steps:seconds:)`, advancing mutation timers only when `wet.advance(n) > 0` skips dry mutations (`mutation-ink`) whenever no wet lanes exist on the canvas.
- **Root Cause**:
  1. `WetWorld` steps evaporation continuously unless `evaporation` is held at 0, and `afterBatch` fades ghost lanes immediately unless `lane.ghost.held` is set.
  2. `mergeLayerDown` commits a new history step and changes `activeLayerId`, whereas temporary dry mutation layers (`layer.temporary = true`) are an internal staging detail that must fold cleanly into the target layer across `doc`, `undoStack`, and `redoStack`.
  3. `normalizePaintBrush` inherits `base.mutation` and auto-derives `ghost: { trigger: 'agent' }` from `mutation` unless `mutation: null` (and `ghost: null` when auto-derived) are explicitly stripped.
  4. `wet.advance(n)` returns `0` when `world` has no active wet lanes, even when `advance_wet_paint` was called with `seconds` to advance simulated time.
- **Solution / Workaround**:
  1. Wet mutation brushes set `ghost.trigger = 'agent'`, which starts `lane.ghost.held = true`; `recordMutationStroke` saves the layer's evaporation and holds it at `0` via `wet.setParams(layerId, { evaporation: 0 })` until `read_mutation` (`releaseGhost`) or `decline_mutation` / timeout (`keepGhost`) restores it.
  2. Dry mutation strokes paint onto a `temporary: true` pixel layer directly above the target layer while keeping `doc.activeLayerId` on the target layer, filtering `temporary` layers from `getState().layers`, and reconciling `doc`, `undoStack`, and `redoStack` in-place when merging down or removing after fade.
  3. `answerMutation` always injects `mutation: null` (and `ghost: null` when the base brush's ghost was `trigger: 'agent'` and the stroke did not explicitly set `ghost`), and sets `answeringMutation = true` so answer strokes never record a new mutation.
  4. `advanceWet` advances mutation timers by `seconds ?? n / wet.speed` regardless of whether `wet.advance(n)` stepped any wet lanes.

### [swift] `JSONValue: ExpressibleByNilLiteral` Turns `cond ? nil : jsonValue` Into `.some(.null)` Instead of `Optional.none`
- **Issue / Symptom**: In a Swift function returning `JSONValue?` (such as `engineChanges`'s inner `diff(_:_:)`), writing `return a == b ? nil : b` where `b` has type `JSONValue` (non-optional) returns `.some(.null)` instead of `nil` (`Optional<JSONValue>.none`), populating every unchanged key of a diff object with `null`.
- **Root Cause**: `JSONValue` conforms to `ExpressibleByNilLiteral` (`init(nilLiteral: ()) { self = .null }`). In a ternary expression `cond ? nil : b` where `b` is a non-optional `JSONValue`, Swift unifies both branches to the non-optional type `JSONValue` (turning `nil` into `JSONValue.null`) and then wraps the result in `Optional.some`, rather than typing the ternary as `Optional<JSONValue>`.
- **Solution / Workaround**: Always write `.none` instead of `nil` in ternary expressions returning `JSONValue?` when the other branch is a non-optional `JSONValue` (e.g., `return a == b ? .none : b` and `return out.isEmpty ? .none : .object(out)`). The same trap hits `compactMap { cond ? nil : item.toJSON() }`, which keeps `.null` elements: give the closure an explicit `-> JSONValue?` return type and use `if cond { return nil }`.

### [core|swift/paint] Ferrofluid and Thin-Film Share `LitCache.lit`, and Code That Builds `ThickChannels` Must Carry `film`
- **Issue / Symptom**: Merging ferrofluid (#703) with thin-film iridescence (#693) broke in two quiet ways: a single combined lighting loop re-shaded ferrofluid-free thick paint (the two features gate relief differently), and `cure_ferrofluid` dropped the layer's iridescent film because `bakeFerroIntoThick` built `{ height, material }` (TS fails to typecheck; Swift's `ThickChannels.init` silently defaults `film` to empty).
- **Root Cause**: The thick / film pass skips height and material when `light.relief <= 0` and only visits colour tiles; the ferrofluid pass also lights tiles that only hold ferrofluid, and lights thick relief even at relief 0 so the spikes still show. One loop can't keep both behaviours.
- **Solution / Workaround**: `LitCache.lit(color, ch, light, viewTilt, ferro?)` hands off to `litFerro` as soon as the layer has ferrofluid tiles. Otherwise it runs the thick / film pass unchanged. `litFerro` keeps the ferrofluid behaviour and also passes the tile's film and `viewTilt` into `lightTile`, so either feature on its own renders exactly as before (the `ferrofluid.json` and `thick-paint-and-light.json` fixtures don't change). Anything that builds a new `ThickChannels` from an old one, such as baking ferrofluid, passes `film: base.film` along. In Swift, don't rely on the default argument.
### [core|swift/paint] Live-Pattern Relief Rebuilds `ThickChannels`, So It Must Carry the Thin-Film `film` Channel and Ghost Lane State Along
- **Issue / Symptom**: After merging live patterns (#705) with ghost paint, mutation paint and thin-film iridescence, a wet stroke on a layer with `livePatterns.relief > 0` could drop the layer's `film` channel (iridescence vanished), and a restored or re-created wet lane could lose its ghost fade or its reaction-diffusion field.
- **Root Cause**: The relief pass rebuilds the layer's thick channels from `height` and `material` only (`ThickChannels(height:material:)` defaults `film` to empty in Swift). `newLane` / `WetLane.init`, `ensureLane`, `snapshot` and `restore` each grew a ghost argument on one branch and a `livePatterns` argument on the other, and either one is easy to drop when merging.
- **Solution / Workaround**: Build relief from the previous channels with `film` included (`{ ...prevCh, height }` in TS, `ThickChannels(height:material:film: base.film)` in Swift), then pass the result through `withLayerThick`. Lane constructors take `(…, width, height, ghost, livePatterns)` in that order in both TS and Swift. Snapshots carry `ghost` and `livePatterns`. Wet layer settings persist `params` (with held evaporation restored), `flow`, `ghost` (not agent-triggered) and `livePatterns`.

### [core|swift/paint] Vortex Paint New-Engine Checklist, Nearest Material Resampling, and Host Profile Marks
- **Issue / Symptom**: Adding the `vortex` brush engine (`marks.kind: 'vortex'`, #683) exposes three subtle pitfalls:
  1. Bilinearly resampling `ThickChannels.material` along with `height` and colour introduces faint glossy/metallic halos around clear pixels where `A = 0` means "no material".
  2. When a dry `vortex` brush (`engine === 'vortex'`) strokes a layer that currently holds live wet paint, the default `beginStroke` dry branch would dry and bake the wet lane before running `VortexStrokeDriver` unless routed to the wet driver.
  3. Adding `"vortex"` to `BRUSH_MARKS_KINDS` in TypeScript without also adding it to `BRUSH_MARKS_KINDS` in Swift (`Brushes/Profiles.swift`) causes `PAINT_PROFILE.accepts` to filter out vortex presets (`vortex`, `ink-vortex`, `whirlpool`, `wet-vortex`) in Swift's `list_brush_presets`.
- **Root Cause**:
  1. `ThickChannels.material` packs `(gloss, metallic, rim, 255)` with `A = 0` denoting no material rather than premultiplied opacity, so bilinear interpolation across the `A = 0` boundary fabricates intermediate material values.
  2. `PaintEditorController.beginStroke` only routes `brush.engine === 'wet'` to `WetStrokeDriver` unless `brush.engine === 'vortex' && wet.isWet(doc.activeLayerId)` is also routed with `brush.wet.tool = 'vortex'`.
  3. `PAINT_PROFILE` in both TypeScript (`brushes/types.ts`) and Swift (`Brushes/Profiles.swift`) uses `BRUSH_MARKS_KINDS` to validate preset marks compatibility.
- **Solution / Workaround**:
  1. Warp colour with premultiplied bilinear sampling (`warpTiledSurfaceRgba`), `height` and `film` with bilinear `warpTiledSurfaceChannel`, and `material` with nearest-neighbour `warpTiledSurfaceNearest`.
  2. Route `brush.engine === 'vortex'` on a wet layer (or `wet.tool === 'vortex'`) through `WetStrokeDriver`, which calls `WetWorld.swirl` at `end()` (`rewet` + per-cell velocity impulse capped at `0.1`).
  3. Keep `BRUSH_MARKS_KINDS` in sync across `packages/core/src/brushes/types.ts` and `packages/swift/Sources/PixeratePaint/Brushes/Profiles.swift`, and verify all four new-engine dispatch points (`PaintStrokeSession`, `liveStrokeRefusal`, `resolveEngine`, `renderBrushThumbnail`) plus symmetry copies (`copy.mirrorX !== copy.mirrorY` flips the vortex spin sign).

### [core|swift/paint] Wet Vortex Swirl Lifetime, Clipped Integration Travel, and Gradient Ink
- **Issue / Symptom**:
  1. Wet paint stirred by a vortex brush kept circulating forever, each stroke made it worse, `get_wet_layer` still said `flow: none`, and growing the canvas left/up left the swirl where it was.
  2. Big vortex tips (tip 300, `turns: 6`) wound far less than `turns` said: more turns barely changed the result.
  3. An inked vortex stroke (`ink > 0`) with gradient paint came out in the single colour.
- **Root Cause**:
  1. `WetWorld.swirl` wrapped `lane.flow` in a new closure per stroke and forced `flowStrength = 1`, turning a one-off stir into a permanent, chained flow map the editor's wet settings knew nothing about (and `extend` keeps `l.flow` when the setting is `none`).
  2. `integrateVelocityField` capped the sub-steps at 240 and clipped each sub-step at ~0.45 grid cells, so the fastest cells lost most of their travel once `turns × radius` needed more steps.
  3. `DryStroke` has no `paint` option (passing one in an options object is silently ignored); gradient paint only works through `PaintDabStroke` with `engine: 'dab'` (its paint exchange samples the gradient).
- **Solution / Workaround**:
  1. Keep the swirl as `lane.swirl` (`WetSwirlState`): one slot, replaced by the next stroke (symmetry copies at the same clock share it), added on top of the flow planes in `fillFlow` and divided by the kernel strength (`kernelFlowStrength`: the user's, or 1 only while a swirl exists). Age it only at `FREE_INTERVAL` boundaries (`afterBatch`, and the idle-skip branch of `step`) so results do not depend on how steps are chunked. Snapshots carry it; `moveWetSnapshot` / `moveSnapshot` translate its patches.
  2. Take as many sub-steps as needed up to `MAX_INTEGRATION_STEPS`, and beyond that raise the sub-step cap to `peak / steps` so the travel is never clipped.
  3. For gradient ink, paint the ink with `PaintDabStroke` (`engine: 'dab'`, `pickup: 0`, `EMPTY_MIXER_LOAD`) over a copy-on-write tile target (`layGradientInk`).

### [core|swift/paint] Biopaint Integer Simulation and 1-Channel Light Surfaces
- **Issue / Symptom**: A floating-point mycelial tip simulation drifts between TypeScript and Swift after dozens of ticks when trig or noise rounds on a pixel boundary, and writing bioluminescence (`glow > 0`) as 4-channel RGBA into `doc.light[layerId]` fails to composite any glow on dark paper (`foxfire` renders identical to `glow = 0`).
- **Root Cause**: `Math.cos`/`Math.sin` vs Darwin libm can differ by 1 ULP, which flips `Math.floor` on fixed-point coordinates and snowballs through sensing and branching. Separately, `doc.light[layerId]` is a 1-channel (`channels: 1`) luminance `TiledSurface` read via `readByte(x, y)` in `compositeLights` (`paint-editor/light.ts` and `Thick.swift`), not a 4-channel RGBA surface.
- **Solution / Workaround**: Run the entire mycelial simulation (`paint/culture.ts` and `Culture.swift`) in 32-bit integers: `CULTURE_FP = 256` fixed-point positions, headings in `0..1023` indexed into a 257-entry integer `QUARTER_COS` table, `cultureHash32` integer noise, integer square root `isqrt`, and permille (`0..1000`) parameters. Allocate `doc.light[layerId]` with `emptySurface(1, 0)` and write bioluminescence with `writeByte(px, py, max(prev, glowA))`.

### [core/paint] Integer Helpers Ported to Swift Must Not Use `>>` on Values Past Int32
- **Issue / Symptom**: Biopaint seeded a straight stroke segment longer than ~181 px as a single spore station in TypeScript, while Swift laid many stations along it, so tips, pixels and recorded documents diverged.
- **Root Cause**: `isqrt` halved with `>> 1`. JavaScript shifts truncate to int32, and segment lengths are squared in 1/256 px fixed point (`(182 * 256)²` > 2³¹), so the result went negative. Swift's `>>` works on 64-bit `Int` and stayed right.
- **Solution / Workaround**: Use `Math.floor(x / 2)` (exact up to 2⁵³) in TS integer code whose operands can pass 2³¹, and keep `>>` / `|0` / `Math.imul` only where int32 wrapping is the intended, ported behaviour. Test the helper with values past 2³¹.

### [core/paint] Flushing a Live Preview Inside `commit` Loses It When `next` Was Built From the Preview
- **Issue / Symptom**: Adding a layer (or any non-stroke command) while biopaint was growing live dropped the `culture-grow` paint events, so replay and high-res export lost the threads.
- **Root Cause**: Callers build `next` (and the default `before`) from `this.doc`, the live preview document, before calling `commit`. `commit` then flushed the preview (adding the events to a new document and pushing "Culture growth"), and the caller's `next` replaced that document without the events.
- **Solution / Workaround**: `flushCultureInto(next, before)` flushes first and carries the flushed events into `next` (and moves `before` to the flushed document). `commitOrAmend`, `redo` and `setCultureOptions` flush too. Any new live-preview mechanism must rebase what callers built from the preview, not only flush it.

### [core|swift/paint] Biopaint Occupancy: a Stroke Must Free Only the Thread Pixels It Changed, on Every Layer It Changed
- **Issue / Symptom**: After any ordinary stroke on a layer with a living culture (even one far from the threads), the next growth digested the culture's own threads, recorded `fades`, and the replay (`replayPainting`, `export_high_res`) no longer matched the live pixels. An antimatter stroke over threads left them marked as the culture's own in TypeScript, but Swift freed them on the active layer only.
- **Root Cause**: `clearOccupancyUnderStroke` cleared every thread pixel whose alpha after the stroke was at least its alpha before, which is true of every pixel the stroke never touched, in every tile of the layer. The antimatter commit path (`applyAntimatterOutputs`) returned before `applyStrokeCulture`, while Swift's `endStroke` ran it for the active layer's surface. Separately, `applyCultureGrowReplay` applied a run's fades before its segments and without occupancy, so growth with `digest > 0` replayed only approximately.
- **Solution / Workaround**: Skip tiles the stroke did not replace and pixels whose RGBA is unchanged. For antimatter, clear occupancy for every changed target layer that has a culture (`applyAntimatterOutputs` in TS, the antimatter branch of `endStroke` in Swift). Scenario `culture-antimatter` checks both. Replay needs no format change: each recorded fade is followed by the on-food segment (`alpha` `CULTURE_FEED_SEGMENT_ALPHA`, 180) that ends on its pixel, so replay lands each fade just before that segment, and it passes the replay editor's own colony occupancy (rebuilt by replaying the seeding strokes and later strokes) so fades spare threads and segments mark theirs. Scale 1 replays exactly (scenario `culture-replay`). Keep 180 unique to fed segments, or record an explicit order.

### [core|swift/paint] A Vortex Must Move Biopaint Occupancy With the Paint, and Live Growth Must Wait Out View Animations
- **Issue / Symptom**: After a vortex stroke over a living culture, the colony digested its own swirled threads as food, and its old thread positions still repelled tips. Live growth on a layer winding a vortex animation (or playing an antimatter blast) cut the animation short at the next growth tick.
- **Root Cause**: The generic stroke path ran `clearOccupancyUnderStroke` on the warped layer, so every moved thread pixel counted as new foreign paint, and the occupancy stayed where the threads had been. View animations (`vortexAnimations`, `blastLayers`) only play while the layer's surface is the committed one, and any growth step replaces it.
- **Solution / Workaround**: For dry vortex strokes, free occupancy only under the ink the stroke laid (`clearOccupancyUnderStroke(existing, before, preWarpSurface())`), then warp the occupancy with the stroke's field (`VortexStrokeDriver.warpMask`: bilinear `warpTiledSurfaceChannel`, as for impasto height; point sampling breaks 1-px threads apart). Do the same in Swift. `playCultures` skips layers with an active vortex or blast animation. Scenario `culture-vortex` checks the warped occupancy in TS and Swift. When a new engine is added to a list that biopaint shares (`FILM` in `brushes/resolve`), check whether it should carry spores: culture now has its own `CULTURE_ENGINES`.

### [core/paint] Live Culture Growth Is Not in `doc.paintEvents` Until It Is Flushed
- **Issue / Symptom**: While biopaint grew live (`playCultures`), `render_xray` with `strokes: k`, `export_high_res` and time-lapse replays left out the growth on screen, and `set_age` during growth lost that growth's replay events for good (the threads stayed, but replay and export no longer drew them).
- **Root Cause**: Live growth keeps its `culture-grow` events in `culturePreview.events` and adds them to the document only when the preview is flushed. Replays read `this.doc`, and `setAge` replaced `this.doc` (via `withAge`) without flushing, so `flushCulturePreview` saw `shown !== this.doc` and dropped the preview.
- **Solution / Workaround**: Replays read `withCulturePreviewEvents()` (the shown document plus the pending events, committing nothing). Anything that replaces `this.doc` outside `commit` (like `setAge` / `setCultureOptions`) calls `flushCulturePreview()` first.

### [core|swift/paint] Wet Paint Flowing During Live Culture Growth Dropped the Run's Replay Events
- **Issue / Symptom**: With watercolour still wet on one layer and biopaint growing live on another, the growth never became a "Culture growth" undo step and its `culture-grow` events were missing from the saved document, so replay and `export_high_res` lost the threads.
- **Root Cause**: The wet host (`updateSurfaces` / `updateLights` / `updateHeights`) replaces the document on every wet step without an undo step. The live run (`culturePreview`) is only valid while `shown === doc`, so the next growth tick or flush took the replaced document for an interruption: it dropped the run (pixels kept, events and undo step lost) and started a new one.
- **Solution / Workaround**: The wet host replaces the document through `replaceDocKeepingGrowth` (TS) / `setDocSilentlyKeepingGrowth` (Swift), which moves the run's `shown` to the new document. Anything else that swaps `doc` outside `commit` while growth plays must either flush first (`setAge`, `setCultureOptions`) or rebase the run like this. In Swift, `playCultures(now:)` returns a `PaintCulturePlayer` the UI ticks (`PaintEditorModel.runCultureClock`); animations that must not be grown over (vortex winding, antimatter blast) feed their layers into `animatingLayerIds()`.

### [core|swift/paint] Antimatter Multi-Layer Strokes: Quantised Fuel Coverage, Recorded Targets, and Signed OKLab Powers
- **Issue / Symptom**: Implementing antimatter paint (#682) across TypeScript and Swift exposes four subtle traps:
  1. Measuring fuel over continuous 2×2 supersampled dab coverage shifts the accumulated fuel at `scale > 1` (`renderHighRes`), causing blasts to fire at different dabs during high-res export.
  2. Replaying an antimatter stroke after layer visibility changes modifies a different set of layers unless the original target list was recorded.
  3. If the controller's light twin runs for `engine === 'antimatter'`, it overwrites the active layer's `doc.light` with a normal dab trail instead of clearing light in blast cores and drawing spark light.
  4. In Swift, inverting OKLab `a` and `b` channels (`-a`, `-b`) can push linear RGB slightly negative before clamping, and `pow(negative, 1 / 2.4)` returns `NaN` in C/Swift `pow`.
- **Root Cause**:
  1. `rasterizeDab` supersamples edges at higher resolution when `scale` increases, slightly changing continuous mean coverage across the tip footprint.
  2. Normal strokes only write to `stroke.layerId`, whereas antimatter strokes read fuel from all visible layers and write to all visible editable pixel layers.
  3. `PaintStrokeSession` normally creates a `lightTwin` dab engine whenever `init.light` is passed.
  4. IEEE 754 `pow(x, y)` for `x < 0` and non-integer `y` is `NaN`.
- **Solution / Workaround**:
  1. Quantise each pixel's coverage to 4 fixed steps (`Math.round(cov * 4) / 4`) and sample fuel on a 16×16 grid normalized to the brush tip so 1×, 2×, TS, and Swift measure identical fuel.
  2. Record `targets?: string[]` on `RecordedStroke` as the stroke's fuel layers (every visible, non-temporary pixel layer, editable or not), pass `targets` through `replay_strokes` and `replayPainting`, and on replay read fuel from exactly those layers (see the next entry).
  3. Skip `init.light`, `init.thick`, `init.film`, `init.ferro`, `init.fluor`, and `init.thermo` in `PaintStrokeSession` when `brush.engine === 'antimatter'`; `AntimatterStrokeDriver` updates `surface`, `light`, and `thick` (preserving `material` and `film`) per target layer directly.
  4. In `srgbToLinear` and `linearToSrgb`, preserve the sign with `abs(v)` before calling `pow`.

### [core|swift/paint] Antimatter Outputs: `null` Light / Thick Means "Unchanged", Targets Mean Fuel Layers, and Blast Times Need Rebasing
- **Issue / Symptom**: (1) An antimatter blast on one part of a layer deleted that layer's light paint (`doc.light`) or impasto relief (`doc.thick`) everywhere else, in TS only. (2) TS and Swift replayed antimatter strokes differently: TS recorded only the changed layers but replayed fuel from every visible layer, and Swift recorded every visible layer but replayed fuel from the recorded ones only. Fuel also differed for layers in a group with opacity < 1 and for temporary (mutation) layers. (3) An agent stroke whose points have `t` from 0 never animated its blasts, and a blast frame wiped the live effect frame (and the other way round).
- **Root Cause**: (1) `AntimatterLayerOutput.light` / `.thick` are `null` when the stroke left that channel alone, but the controller wrote `o.light ?? emptyLight()` for layers that already had light (and the live view put `null`, meaning "no light", in `liveLightMulti`). (2) The two ports read `RecordedStroke.targets` in different ways, and Swift's `visiblePixelLayers` ignored group opacity and `temporary`. (3) Blast birth times come from `PenPoint.t` (any origin) but were compared with the view clock, and blast frames shared the `animatedLayers` map that `showEffectTime` replaces and `clearBlastAnimation` cleared.
- **Solution / Workaround**: (1) Treat `null` as unchanged everywhere: write a channel only when the output has one, and in the view map only non-null values (during a blast animation, `null` falls back to the target's pre-stroke `baseLight` / `baseThick`). (2) `targets` is the list of fuel layers. A replay with `targets` reads fuel from exactly those layers, whatever is visible now, and changes the editable ones. The walk (`antimatterTargetsOf` in TS, `antimatterTargets` in Swift) is the same in both ports: it multiplies group opacity and skips temporary layers (scenarios `antimatter-fuel-targets`, `antimatter-group-opacity`). (3) `startBlastAnimation` always calls `driver.rebaseTime(clock.now())`, and blast frames live in their own `blastLayers` map, which `animatedView` lays over the effect frames.

### [swift/paint] Antimatter Blast Animation: the Port Lacked the Mid-Blast Flash, and Redo Brings Back the Same Document
- **Issue / Symptom**: Porting the blast expansion animation (#732) to Swift: (1) mid-animation frames had no white core flash or shock ring, though committed pixels matched TS exactly; (2) after undo and redo the old animation resumed, because the frames were guarded only by "the document is still the one the stroke committed".
- **Root Cause**: (1) `drawActiveExtras` was ported for commits only, where every blast's progress is 1 and TS skips the `progress < 1` flash / ring block, so leaving it out changed nothing any conformance scenario could see. (2) `redo` sets `doc` back to the history entry's `after`, which is the very document instance the animation recorded as `committedDoc`, so an identity check alone cannot tell that the user left and came back.
- **Solution / Workaround**: (1) Port `drawActiveExtras` in full; `PaintBlastAnimationTests` compares frame hashes at 0, 100 and 400 ms with values recorded from the TS core (`blastLayers` while `playEffects` runs on a fake clock), so re-record them from TS if the blast drawing changes. (2) Call `clearBlastAnimation()` explicitly in `undo`, `redo`, `newCanvas`, `beginStroke` and `paintStroke`, as `controller.ts` does, and keep the identity check for other document changes (a fill, wet ticks). Swift has no `playEffects`: blast birth times are rebased on the first `tickBlastAnimation(now)` (the editor view's clock, `PaintEditorModel.tick`), so with no clock (agents, tests, exports) the view shows the committed painting. Any new code that replaces a layer's surface while `blastAnimatingLayerIds` holds the layer (live culture growth, for example) ends the animation; skip those layers, as TS `playCultures` does.

### [core|swift/paint] Historical X-Ray Replay (`render_xray` with `strokes: k`) Must Temporarily Show and Unlock Layers During Replay
- **Issue / Symptom**: Calling `render_xray({ strokes: k })` on a painting with a hidden or locked underpainting layer fails with `Layer "…" is hidden; show it (update_layer visible true) to paint on it.` when `replayPainting` replays historical strokes onto that layer.
- **Root Cause**: `createReplayTarget` copies `this.doc.layers` with their current `visible` and `locks` state. In a pentimento workflow, a layer is painted on first and hidden or locked later, so `target.paintStroke` refuses to replay the earlier stroke onto the now-hidden or locked layer.
- **Solution / Workaround**: In `renderXray` (both TypeScript `controller.ts` and Swift `Age.swift`), record the set of currently hidden layer IDs, temporarily set `visible: true, locks: undefined` across `target.doc.layers` before calling `replayPainting`, and restore the original `visible` flags on `dried` before calling `renderXrayPixels` so `hiddenLayerCount` remains accurate.

### [swift/chart] Excel Number Formatting Requires V8's Shortest-Round-Trip Decimal Digits (`String(number)`, `toExponential`, `toPrecision`)
- **Issue / Symptom**: Porting `decimalDigits` (`spreadsheet/numfmt/decimal.ts`) with `String(format: "%e", ...)` or Foundation's `Decimal` rounds 15-digit floats differently from V8's `String(Math.abs(n))`, shifting exact half-way rounding ties in `fixed`, `formatGeneralFit`, scientific notation (`0.00E+00`) and continued-fraction approximations (`# ?/?`).
- **Root Cause**: The TS number-format engine extracts base-10 mantissa digits and exponent directly from JavaScript's `String(Math.abs(n))` (ECMA-262 shortest round-trip representation) and uses `n.toExponential` / `n.toPrecision` inside `formatGeneralFit`.
- **Solution / Workaround**: `Decimal.swift` parses the output of `JSONValue.jsNumber(abs(n))`, and `JSString.swift` implements `jsToExponential` and `jsToPrecision` on top of `jsExactDecimal` (with ECMA-262 ties-away-from-zero rounding) so `PixerateCore/NumberFormat/` and `PixerateChart` match the TypeScript formatter bit-for-bit across all number-format, scale and model test vectors.

### [swift] `String.contains`, `hasPrefix` and `replacingOccurrences` Compare Characters, Not the Code Units JS Compares
- **Issue / Symptom**: In the chart port (#694), `serializeCsv([["a\r\nb"]])` wrote an unquoted line break, `escapeSvg` left `"` unescaped when a combining mark followed it (an attribute injection through a chart title), and the OOXML writer left a raw `&` in `R&\u{301}D`.
- **Root Cause**: A Swift `String` is a collection of grapheme clusters. `"\r\n"` is one `Character`, so it `contains` neither `"\r"` nor `"\n"`. `"&\u{301}"` is one `Character`, so `for ch in text { case "&" }` never matches it, and `replacingOccurrences(of: "\"", …)` skips `"\u{301}`. JS `includes`, `startsWith`, `replace` and `/["\r\n]/` all work on UTF-16 code units.
- **Solution / Workaround**: When porting a JS string test or replace, use `jsIncludes`, `jsStartsWith`, `jsEndsWith` and `jsReplacingAll` (`PixerateCore/JSString.swift`), which compare UTF-16 code units. Write escapers over `text.unicodeScalars` and append with `out.unicodeScalars.append`. Likewise, ICU regexes differ from JS: `\d`, `\w` and `\b` are Unicode-aware (spell out `[0-9]`, `[A-Za-z0-9_]`, `(?![A-Za-z0-9_])`), and `\s` misses `\v` and the BOM U+FEFF that JS's `\s` matches.

### [core/persistence] A `save` That Throws Synchronously Left Remote Sync "In Flight" Forever
- **Issue / Symptom**: After one failed save, `createEditorRemoteSync` never saved again: every later `flush()` awaited the old promise and returned without calling `save`.
- **Root Cause**: The in-flight promise was cleared in the save IIFE's `finally`. A non-async `save` that throws synchronously settles the IIFE before `inFlightPromise = run` runs, so the `finally` cleared nothing and the assignment then stored an already-settled promise that nothing cleared.
- **Solution / Workaround**: Assign the promise first, then clear it after awaiting it (`if (inFlightPromise === run) inFlightPromise = null`), never inside the async body. The same applies to any "one at a time" guard built on an async IIFE.

### [core/persistence] Remote Saves Must Be Compare-and-Set, or Two Sessions Overwrite Each Other
- **Issue / Symptom**: With `version = max(local, server + 1)`, two sessions editing one document without a shared room silently replaced each other's work on every save (last writer wins).
- **Root Cause**: A read-then-write save does not check what changed in between, and bumping the version past the server's only hides the race.
- **Solution / Workaround**: `save` receives `baseVersion` (the last confirmed server version). Write only where the stored version still equals it (a database transaction or conditional update, not a fetch followed by a set) and return `{ conflict: true }` otherwise. `onConflict` gets `base` (last confirmed snapshot) and `document` (this session's), merges this session's changes into the server document, loads it with `apply` (not broadcast as a local change) and returns the server version; the controller then saves again. `maxConflictRetries` (default 3) stops a loop.

### [core|swift/paint] An Animated Sticker's Frame Is Saved Only Past the First, and "Perform" Needs Stroke Times

- **Issue / Symptom**: `add_stickers` / `update_sticker` with `frame: 0` saved `"frame": 0` while sprays left it out, so the same sticker saved two ways; a frame past the art's last (or `frame: 1` on a static sticker) was stored and silently drawn as `frame % frameCount`; restamping a sticker kept a frame the new art may not have. A `perform` sticker brush (the default) painted every sticker in the first frame when the agent sent points without `t`.
- **Root Cause**: `normalizeStickerUpdate` only checks that `frame` is a whole number; it doesn't know the art. `sampleArt` wraps any frame into range, which hides bad ones. `perform` picks `floor(dab.time / frameDelay) % frameCount`, where `dab.time` is ms since the stroke's first *timed* sample, and is `null` (so 0) without times.
- **Solution / Workaround**: The controllers pass every placed or changed sticker through `stickerWithFrame(sticker, art)` (TS `paint-editor/stickers.ts`, Swift `Stickers.swift`): frame 0 is removed, a frame >= the art's frame count is refused naming the range, and art that has not loaded is left to the redraw's own refusal. A new `ref` without `frame` resets it to 0. Document loading (TS `readThick`, Swift `Sticker(json:)`) keeps only whole frames above 0, and Swift's `Sticker.json` never writes frame 0. For `perform`, give stroke points `t` (ms), or use `frameMode: "random"`. The `animated-stickers` paint scenario (`setup.stickers: "fake"`, whose `weather-wind` has 4 frames of 100 ms) holds Swift to the TS frames, documents and pixels.


### [core|swift/paint] A Sticker Preview Must Go Through the Canvas's Own Drawing, and Its Box Is One Pixel Smaller

- **Issue / Symptom**: App previews of a sticker brush (a swatch, a stroke preview, a picker) didn't match what the stroke painted when they tinted or picked frames some other way (for example the sticker library's own recolouring), since the canvas paints tintable art as a flat silhouette. A stamp compared byte for byte with turned art also showed colour in pixels whose alpha was 0.
- **Root Cause**: The tint rule (tintable art takes the paint colour, keeping only its alpha) and the frame choice (wrapped to the frame count, negatives from the last) lived inside the private `drawArtSticker` / `sampleArt`. The canvas draws a sticker into `stickerRect`, which is one pixel larger on each side than its diameter and axis-aligned, so turned art is cut at that box. Bilinear sampling at turned positions gives tiny coverage to transparent neighbours, which rounds to alpha 0 but still writes the neighbour's colour.
- **Solution / Workaround**: Use `renderStickerStamp` (TS `paint-editor/stickers.ts`, Swift `Stickers.swift`); it draws the sticker through `stickerSurface` with the shared `tintStickerArt` and `stickerArtFrame`, so it can't drift. Its output is `size × size` (the sticker centred at `size / 2`), leaving out the canvas's one-pixel ring, which only bilinear bleed of upscaled art and the corners of turned art reach. Its pixels equal the canvas's for a sticker centred at whole x, y plus `size / 2`. Compare stamps with alpha-0 pixels treated as equal. `swift-sticker-stamp-vectors.test.ts` holds Swift to the TS bytes.

### [core|swift/paint] Ageing Each Layer Yellowed Multiply Layers Twice and Brightened Light Spill

- **Issue / Symptom**: With the time machine on (`set_age`), a Multiply or Overlay layer came out yellower and darker than the same colours painted flat, and an Add (Linear Dodge) light-spill layer lifted dark paper well above its unaged glow. Normal layers looked right.
- **Root Cause**: Ageing (`agePixel`: fade, varnish, cracks, dust) ran inside every visible pixel layer before compositing. Varnish multiplies blue down, so a Multiply layer over an aged ground absorbed it twice; fading and dust pull colours toward fixed offsets, which an Add layer then *added* to the paper.
- **Solution / Workaround**: Ageing is a compositor filter node at the top of the painting (`ageNode` / `ViewLayer.age`, `ageCompositeRegion` in TS `paint-editor/age.ts` and Swift `Age.swift`), above the painted layers and light spill and below the backlight. The paper node no longer ages itself (that would age the paper twice). The node carries the visible painted layers as a field: where any of them has alpha the cracks use the painted layer count and the tallest thick height, and bare paper ages as one layer with no impasto (what the paper node did). The node's `layerKey` is only the age settings and layer count, so a stroke re-ages only the tiles it touches; a thick-height change that leaves a layer's (lit) pixels unchanged would not re-age, which does not happen in practice. Crack relief is still carved per layer in `litLayers`. The field and the painted layer count come from `paintedPixelLayers` (visible, non-empty, not inside a hidden group; with `layerIds`, only the picked layers): `flattenLayers` walks into hidden groups, and their paint is in no signature below the node, so it marked paper as paint and never re-aged when it changed. `bake_age` cannot just commit the aged paint without the paper: laid Normal over the unaged painting, a Multiply or Add layer bakes to its own colour and a translucent wash loses the paper's ageing under it. `bakeAgedPixels` (TS `age.ts`, Swift `Age.swift`) keeps the paint's alpha (raised where the change needs more, such as a dark crack under a light wash) and solves the colour so that over the unaged composite (paper included, backlight left out, as it stays on top) it gives the aged one; bare paper stays clear. When building the stack in `renderLayers`, copy the layer list before pushing the age node or backlight: without any light, thermo or UV pass it is `this.doc.layers` itself, and pushing onto it puts the backlight into the document.
