# @pixerate/swift

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
