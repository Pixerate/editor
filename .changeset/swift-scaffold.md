---
"@pixerate/swift": minor
---

Swift scaffold: the root `Package.swift` and `PixerateCore` (Foundation only), ported from the TS core and checked against its outputs.

- The `pixerate.editor-document` envelope with step-by-step migrations and load reports.
- Undo / redo with gestures, marks, batches, origins (`user` / `agent:<id>`, `withOrigin`, sync and async) and `onCommit` events.
- The seeded RNG, bit-exact with `paint/rand.ts`.
- JSON Schema validation with the TS messages.
- `ToolRegistry` with MCP-shaped results, middleware and `originMiddleware`.
