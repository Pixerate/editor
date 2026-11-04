# Pixerate for Swift

Native Swift versions of the Pixerate editors for macOS and iOS (#533), with no JavaScriptCore and
no WKWebView. The TypeScript core is the executable specification: the Swift code is checked
against vectors and fixtures the TS core produces.

The SwiftPM manifest is [`Package.swift`](../../Package.swift) at the repository root (so the
package works as a git dependency); its sources are here.

```swift
.package(url: "https://github.com/Pixerate/editor.git", from: "…")
// target dependency:
.product(name: "PixerateCore", package: "editor")
```

## Targets

| Target | What it holds | Imports |
| :--- | :--- | :--- |
| `PixerateCore` | The `pixerate.editor-document` envelope with step-by-step migrations and load reports (`persistence/migrate.ts`, `editorDocument.ts`); undo / redo with gestures, marks, batches, origins (`user` / `agent:<id>`) and commit events (`history/`); the seeded RNG, bit-exact with `paint/rand.ts`; JSON Schema validation with the same messages (`tools/schema.ts`); `ToolRegistry` with MCP-shaped results, middleware and the origin middleware (`tools/registry.ts`, `tools/origin.ts`); an order-preserving `JSONValue` whose `stringified()` matches `JSON.stringify` | Foundation only |
| `PixerateContracts` | The files of `@pixerate/conformance` (`packages/conformance`), bundled as resources: each domain's contracts and recorded scenarios (`ConformanceContracts.url("domains/paint/tools.json")`) | Foundation only |
| `PixeratePaint` | The paint editor. `PaintContracts` reads the paint contracts; `Generated/` holds what `scripts/gen-swift.mjs` writes from them: `PaintToolName`, an `…Arguments` struct per tool (`paintToolArguments(_:_:)` reads any of them by name), `PaintCommandID`, `PaintUITables` and `PaintContractVersions` | `PixerateCore`, `PixerateContracts` |
| `PixerateConformance` | The scenario runner: replays a domain's recorded scenarios (`ConformanceScenario.load(domain:)`) against a `ConformanceHost` with the same normalization rules as the TypeScript runner, and compares results, documents and pixels (`compareConformance`, `decodeConformancePNG`) | `PixerateCore`, `PixerateContracts` |

UI targets (`PixeratePaintUI`, …) are the only ones that will import SwiftUI, AppKit or UIKit.

## Conformance

`swift test` replays every recorded scenario of each domain (`PaintConformanceTests`) and prints how
many passed, failed and were skipped; in CI the count goes to the job summary. A scenario the Swift
port can't pass yet carries `"skip": { "swift": "… (#issue)" }` in its file. Port a feature, remove
the skips it fixes, and the scenarios must then match. `ConformanceRunnerTests` checks the runner
itself: a host that plays back the TypeScript recordings, with ids of its own, must match every
scenario, and every recorded PNG must decode to its recorded hash.

The Swift CI workflow (`.github/workflows/swift.yml`) runs `gen-swift --check`, then builds and
tests on macOS and in an iOS simulator, whenever the Swift code, the contracts or their scripts
change.

## Generated code

`scripts/gen-swift.mjs` (`pnpm gen:swift`) writes `Sources/<Target>/Generated/` from the contracts,
so tool names, argument types, keyboard commands and UI tables cannot drift from the TypeScript
core. Never edit those files. After a contract changes (`pnpm contracts`), run it and commit;
`node scripts/gen-swift.mjs --check` and the core test `tests/swift-generated.test.ts` fail while
they are out of date. Argument types follow the schema: strings with an `enum` become a nested
enum, `integer` / `number` / `boolean` become `Int` / `Double` / `Bool`, arrays of those become
arrays, and anything else stays a `JSONValue`. A required argument that may be `null` is optional.

## Developing

```bash
swift build
swift test
```

`Tests/PixerateCoreTests/Fixtures/core-vectors.json` is written by the TS core
(`packages/core/tests/swift-vectors.test.ts`): RNG outputs, number formatting, `JSON.stringify`
output, schema validation messages and migrations. That test fails when the TS core's outputs
drift from the file; after an intended change, rewrite it with
`UPDATE_SWIFT_VECTORS=1 pnpm --filter @pixerate/editor exec vitest run tests/swift-vectors.test.ts`
and run `swift test` again.

Async code runs on its caller's executor (`NonisolatedNonsendingByDefault`), as JavaScript's does,
so histories and registries (not `Sendable`) can be used from async tool handlers.
