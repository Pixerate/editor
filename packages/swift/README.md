# Pixerate for Swift

Native Swift versions of the Pixerate editors for macOS and iOS (#533), with no JavaScriptCore and
no WKWebView. The TypeScript core is the executable specification: the Swift code is checked
against vectors and fixtures the TS core produces.

The SwiftPM manifest is [`Package.swift`](../../Package.swift) at the repository root (so the
package works as a git dependency); its sources are here.

```swift
.package(url: "https://github.com/Pixerate/editor.git", .upToNextMinor(from: "0.1.0"))
// target dependency:
.product(name: "PixerateCore", package: "editor")
```

## Targets

| Target | What it holds | Imports |
| :--- | :--- | :--- |
| `PixerateCore` | The `pixerate.editor-document` envelope with step-by-step migrations and load reports (`persistence/migrate.ts`, `editorDocument.ts`); undo / redo with gestures, marks, batches, origins (`user` / `agent:<id>`) and commit events (`history/`); the seeded RNG, bit-exact with `paint/rand.ts`; JSON Schema validation with the same messages (`tools/schema.ts`); `ToolRegistry` with MCP-shaped results, middleware and the origin middleware (`tools/registry.ts`, `tools/origin.ts`); `ToolBridgeClient`, which connects a registry to `pixerate-mcp-bridge` so MCP clients drive the editor (`tools/bridge-client.ts`, see `docs/mcp-bridge.md`); an order-preserving `JSONValue` whose `stringified()` matches `JSON.stringify` | Foundation only |
| `PixerateContracts` | The files of `@pixerate/conformance` (`packages/conformance`), bundled as resources: each domain's contracts and recorded scenarios (`ConformanceContracts.url("domains/paint/tools.json")`) | Foundation only |
| `PixerateRaster` | The raster module (`raster/`): tiled copy-on-write surfaces (`TiledSurface`, 256 px tiles, straight 8-bit RGBA or mask bytes) with 16- and 32-bit deep samples; every blend mode, pigment mixing and the painterly modes; Gaussian blur and curves; transforms and mesh warps; the cached per-tile `RasterCompositor` and the float `DeepCompositor`, with editor profiles; layer effects (model, validation, renderer, panel view model) and patterns; the PNG / zlib codec; the PSD writer for pixel layers and groups (`exportPsd`, `PsdWriter`: records, masks, locks, PackBits channels, the merged image; layer styles are left out with a warning); viewport maths. Same pixels and bytes as the TS core; `JS` holds JavaScript's number semantics (`Math.round`, `Uint8ClampedArray` stores, V8's `exp`, `sin`, `cbrt`, …) | `PixerateCore` |
| `PixeratePaint` | The paint editor's dry engine (`paint-editor/`, `paint/`, the brush parts of `brushes/`): `PaintEditorController` with canvas, paper (`PaperSettings`, `renderPaper`), the shared layer stack, fills, undo / redo and groups; change notifications (`subscribe`), live strokes from pointer input (`beginStroke`, `PaintLiveStroke`) and tile-by-tile compositing for views (`compositeTiles`), with the view maths and pen input helpers (`screenToDocument`, `pointerToPenPoint`, `isPalmTouch`); the dry brushes on the shared dab engine with paper grain, pen dynamics, smoothing, spray and seeded jitter; the particle and bristle engines (`paint-editor/procedural.ts`); blenders, smudge and the Mixer Brush on `PaintExchange`; recorded strokes (`RecordedStroke`), replays, brushed SVG paths and live stroke layers; symmetry, perspective and stencils; tracing and reference images, harmonies, swatches and `MixingPad`; light paint with glow, rim, clarity and spill (`get_light`, `set_light_spill`, `clear_light`); wet media (`PaintWetLayers` on `WetWorld`: the TS core's TypeScript wet kernel, bit-exact, on one thread; watercolour, gouache, wet oils and the wet tools, wet paper, settings, flow maps, tilt, time, the water overlay and the deterministic dried bake for saving and export; no WebAssembly, worker or GPU engine, so `set_wet_engine` always runs the CPU); thick paint (impasto brushes laying height and material, lit at render time by `PaintLighting`; `get_relief`, `flatten_relief`); metallic and backlit paper; layer styles; saved documents (wet paint dried on save), PNG and PSD export (`exportPsd`), time-lapses (`timeLapse`, `PaintTimeLapse`) and high-resolution repaints (`renderHighRes`), which repeat wet strokes and wet events at their simulation clock; provider effects (`EffectProvider`, `FakeEffectProvider`, `createPaintEffectsToolProvider`): effect paper, effect layers, fills, light baked onto dried paint and effect paint (`PaintEffectPaint`); stickers: the editor's sticker library (`EditorStickers`), sticker layers of editable `Sticker`s and sticker brushes; proposals (`PaintProposals`); the brush library (`BrushLibrary`: presets, normalization, v1 migration, host profiles, thumbnails). Agent tools come from the contracts (`createPaintEditorToolProvider`, `createPaintEffectsToolProvider`, `createPaintBrushLibraryToolProvider`, `createPaintProposalToolProvider`); only implemented tools are registered. `PaintConformanceHost` runs the paint scenarios. Host sticker libraries are not ported yet (#545). `Generated/` holds what `scripts/gen-swift.mjs` writes from the contracts: `PaintToolName`, an `…Arguments` struct per tool (`paintToolArguments(_:_:)` reads any of them by name), `PaintCommandID`, `PaintUITables` and `PaintContractVersions` | `PixerateCore`, `PixerateContracts`, `PixerateRaster`, `PixerateConformance` |
| `PixerateConformance` | The scenario runner: replays a domain's recorded scenarios (`ConformanceScenario.load(domain:)`) against a `ConformanceHost` with the same normalization rules as the TypeScript runner, and compares results, documents and pixels (`compareConformance`, `decodeConformancePNG`) | `PixerateCore`, `PixerateContracts` |
| `PixeratePaintUI` | The paint editor's SwiftUI views (`react/src/paint-editor`, `paint-editor/ui.ts`), macOS 14 and iOS 17: `PaintEditorView` (toolbar with an Export menu: PNG, PNG at 2× repainted, PSD; brush column, canvas, colour / paper / layers / styles / wet tabs); `PaintCanvasView`, which draws the composite through CoreGraphics with the view's zoom, pan, rotation and mirroring, copying only changed tiles (`PaintCanvasPresenter`), with the guide overlay; `PaintGesture` (strokes as live `beginStroke` sessions, eyedropper, Select stroke, pan, rotate, wheel / pinch zoom, palm rejection) fed by mouse, trackpad and tablet events on macOS and touches and Apple Pencil (force, altitude, azimuth, roll, coalesced and predicted touches) on iOS; panels rendered from `PaintUITables` (tools, brush options, blend menu, paper, light, wet and stroke sliders, the wet engine choices, layer styles) and shortcuts from `PaintContracts.commands()` (`Mod` is ⌘); `PaintWetPanel` (wet paper, tilt, pause and speed, water overlay, instant dry, the layer's wet settings and flow map, the engine), `PaintLightPanel` (light direction, height and relief, Flatten relief) and `PaintLightSpillPanel`; `PaintEditorModel`, the observable view model that owns the editor's `ToolRegistry`, so agents and the user change the same editor, and ticks wet paint every frame (`runWetClock`; only tiles whose wet paint changed are redrawn). Every brush the engine paints is in the brush picker (all but stamp tips); there are no sticker or provider-effect panels yet | `PixeratePaint`, `PixerateCore`, `PixerateRaster`, SwiftUI (AppKit / UIKit for input) |
| `PixerateMarkdown` | The Markdown engine shared with [Swash](https://github.com/surrealroad/Swash) (#546), which depends on this product instead of keeping its own copy: a CommonMark 0.31.2 + GFM parser (`MarkdownDocument.parse`) with exact UTF-16 ranges for every node and syntax marker, plus alerts, front matter and math; the HTML renderer (`MarkdownHTMLRenderer`) and the HTML → Markdown paste converter (`HTMLToMarkdown`, on `XMLDocument` on macOS and a small built-in parser elsewhere); the code highlighter (`CodeHighlighter`, 26 languages); outlines and statistics (`MarkdownOutline`, `MarkdownStatistics`); and the editing engine on raw Markdown: `MarkdownFormatting` (active formats, toggles, links, footnotes), `MarkdownEditingCommands` (Return, Tab, Backspace, math braces), `FormatCommand` / `FormatCommandEdits` and the format-command manifest from `@pixerate/markdown-conformance` (`FormatManifest`, generated by `scripts/gen-swift-markdown.mjs`). Its tests run the CommonMark and GFM spec examples and the `@pixerate/markdown-conformance` corpus. No dependency on the other targets | Foundation only |

UI targets (`PixeratePaintUI`, …) are the only ones that import SwiftUI, AppKit or UIKit.

```swift
import PixeratePaintUI

struct Painting: View {
    @State private var model = try! PaintEditorModel()   // a 1024 × 768 painting with its agent tools
    var body: some View { PaintEditorView(model: model) }
}
```

On iOS, embed `PaintEditorView` (or `PaintCanvasView` with your own panels) the same way in any
SwiftUI app: add the package, depend on the `PixeratePaintUI` product and put the view in a scene.
The canvas takes touches and the Pencil directly; give the view the whole screen width on iPad,
since the two side columns are 250 points each (`PaintEditorView(model:sideWidth:)`).

## Demo

`apps/swift-demo` is a macOS SwiftUI app (its own SwiftPM package, on this one by relative path):
a Paint tab with `PaintEditorView` and an agent panel listing the editor's tools, with a switch
that connects them to `pixerate-mcp-bridge` through `ToolBridgeClient` (status, editor id, token).

```bash
swift run --package-path apps/swift-demo PixerateSwiftDemo
# connect an MCP client: start the bridge (docs/mcp-bridge.md), turn on "Connect" in the agent panel
```

`PIXERATE_DEMO_SNAPSHOT=/tmp/demo.png` makes the app write its window to that PNG after four
seconds (drawn by AppKit, so it needs no Screen Recording permission). There is no iOS app target
yet (SwiftPM can't make one without an Xcode project); the iOS simulator build of
`PixeratePaintUI` runs in CI.

## Conformance

`swift test` replays every recorded scenario of each domain (`PaintConformanceTests`) and prints how
many passed, failed and were skipped; in CI the count goes to the job summary. A scenario the Swift
port can't pass yet carries `"skip": { "swift": "… (#issue)" }` in its file. Port a feature, remove
the skips it fixes, and the scenarios must then match. `ConformanceRunnerTests` checks the runner
itself: a host that plays back the TypeScript recordings, with ids of its own, must match every
scenario, and every recorded PNG must decode to its recorded hash.

`PixerateMarkdownTests` runs the CommonMark 0.31.2 and GFM spec examples, the parser and code
highlighter checks, and the shared Markdown editing corpus (`packages/markdown-conformance/fixtures`,
read in place). The engine is Swash's, so a corpus case's `variants.swash` and `skip.swash` apply to it.

The Swift CI workflow (`.github/workflows/swift.yml`) runs `gen-swift --check` and `gen-swift-markdown --check`, then builds and
tests on macOS (and builds the demo app) and in an iOS simulator, whenever the Swift code, the contracts or their scripts
change.

## Releases

The Swift package has its own version, `@pixerate/swift` in `packages/swift/package.json`, bumped
by changesets like the npm packages. When a release changes it, the release workflow tags that
release commit `v<version>`. SwiftPM only treats `1.2.3` and `v1.2.3` tags as versions (any other
prefix is ignored, so there are no `swift-v…` tags), and changesets' own tags are
`@pixerate/editor@…`, so the plain `v…` tags only ever mean the Swift package. While it is 0.x, a
minor bump can break, so depend on it with `.upToNextMinor(from:)`.

## Keeping parity

The TypeScript core is the specification (`Agents.md` §3.5). For each domain, `@pixerate/conformance`
holds what the editor offers (tools, commands, UI tables, the document schema) and recorded
scenarios of what its tools do, including pixels. The Swift code replays the scenarios and must get
the same results; a scenario it can't pass yet is marked `"skip": { "swift": "… (#issue)" }`.

| Domain | Contracts | Scenarios | Swift |
| :--- | :--- | :--- | :--- |
| Brushes | `domains/brushes` | — | Brush model ported for painting (presets, normalization, v1 migration, host profiles; `BrushModelTests`) (#540) |
| Paint | `domains/paint` | `domains/paint/fixtures` | 23 of 23 scenarios pass, pixel-exact (#540, #545) |

## Generated code

`scripts/gen-swift.mjs` (`pnpm gen:swift`) writes `Sources/<Target>/Generated/` from the contracts,
so tool names, argument types, keyboard commands and UI tables cannot drift from the TypeScript
core. Never edit those files. After a contract changes (`pnpm contracts`), run it and commit;
`node scripts/gen-swift.mjs --check` and the core test `tests/swift-generated.test.ts` fail while
they are out of date. Argument types follow the schema: strings with an `enum` become a nested
enum, `integer` / `number` / `boolean` become `Int` / `Double` / `Bool`, arrays of those become
arrays, and anything else stays a `JSONValue`. A required argument that may be `null` is optional.

`scripts/gen-swift-markdown.mjs` writes `Sources/PixerateMarkdown/FormatManifest.generated.swift` from
`packages/markdown-conformance/manifest.json` in the same way. It fails when the manifest names a
surface or `enabledWhen` condition that `FormatSurface` / `FormatCondition` don't have, or a command id
that `FormatCommand(manifestID:params:)` doesn't map: add the case first.

## Developing

```bash
swift build
swift test
```

`swift test` builds without optimisation, where the wet kernel takes a fraction of a second per
256 px tile per step. For long wet runs (extra scenarios through `PIXERATE_PAINT_PROBE_FILES`),
test an optimised build: `swift test -c release -Xswiftc -enable-testing --filter PaintScenarioProbeTests`.

`Tests/PixerateCoreTests/Fixtures/core-vectors.json` is written by the TS core
(`packages/core/tests/swift-vectors.test.ts`): RNG outputs, number formatting, `JSON.stringify`
output, schema validation messages and migrations. That test fails when the TS core's outputs
drift from the file; after an intended change, rewrite it with
`UPDATE_SWIFT_VECTORS=1 pnpm --filter @pixerate/editor exec vitest run tests/swift-vectors.test.ts`
and run `swift test` again. `Tests/PixerateRasterTests/Fixtures/raster-vectors.json` works the
same way for the raster module (`tests/swift-raster-vectors.test.ts`): blend modes, surfaces, deep
samples, pigment, blur, curves, transforms, both compositors, every layer effect, the effects
panel, PNG / zlib bytes and the viewport. Pixels and codec bytes must match exactly; numbers that
went through `Math.exp`, `sin`, `cbrt`, … are stored as `Math.fround`, because V8 rounds those
differently in the last bit on x64 and arm64 (see GOTCHAS).

Async code runs on its caller's executor (`NonisolatedNonsendingByDefault`), as JavaScript's does,
so histories and registries (not `Sendable`) can be used from async tool handlers.
