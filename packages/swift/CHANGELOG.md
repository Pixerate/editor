# @pixerate/swift

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
