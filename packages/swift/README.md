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
| `PixeratePaint` | The paint editor. `PaintContracts` reads the paint contracts; `Generated/` holds what `scripts/gen-swift.mjs` writes from them: `PaintToolName`, an `…Arguments` struct per tool (`paintToolArguments(_:_:)` reads any of them by name), `PaintCommandID`, `PaintUITables` and `PaintContractVersions` | `PixerateCore`, `PixerateContracts` |

UI targets (`PixeratePaintUI`, …) are the only ones that will import SwiftUI, AppKit or UIKit.

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
| Brushes | `domains/brushes` | — | Not started |
| Paint | `domains/paint` | `domains/paint/fixtures` | In progress (#539, #540) |
