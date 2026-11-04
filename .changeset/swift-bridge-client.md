---
"@pixerate/swift": minor
---

Swift editors can be driven over the MCP bridge (#542). `ToolBridgeClient` in `PixerateCore` connects a `ToolRegistry` to `pixerate-mcp-bridge` (protocol 1, token in `?token=`, `URLSessionWebSocketTask`), sends the tool list on connect and when it changes, answers calls through `callTool` (cancelled calls send no result) and reconnects with back-off, as `connectToolBridge` does in TypeScript.
