# @pixerate/swift

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
