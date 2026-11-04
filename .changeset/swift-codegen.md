---
"@pixerate/swift": minor
---

Swift generated from the contracts (#537). `scripts/gen-swift.mjs` (`pnpm gen:swift`) writes `PixeratePaint/Generated/`: `PaintToolName` (every paint tool and its provider), an `…Arguments` struct per tool with `paintToolArguments(_:_:)`, `PaintCommandID`, `PaintUITables` and `PaintContractVersions`. The new `PixerateContracts` target bundles `@pixerate/conformance` (contracts and recorded scenarios) as resources, and `PaintContracts` reads the paint contracts. `PixerateCore` can read tool definitions, providers and commands from contract JSON (`McpToolDefinition(json:)`, `ToolProviderContract`, `ShortcutCommand`) and typed tool arguments from a `JSONObject`.
