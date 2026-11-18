---
"@pixerate/swift": minor
---

PixerateCore can host MCP itself: `MCPHTTPServer` is an in-process Streamable HTTP MCP server on 127.0.0.1 (Network.framework), so a Swift app serves its tools to MCP clients without `pixerate-mcp-bridge`. `MCPToolRouter` routes `tools/call` to one of several targets (open documents, canvases), each with its own `ToolRegistry`, through an optional target argument added to every tool, lists them with `list_<plural>`, and always advertises a fixed catalogue; `MCPServerController` is an observable start / stop / restart model with a status and a `"type": "http"` MCP config snippet. Each app passes its own default port (there is no shared default, so it doesn't collide with the bridge on 4477). The transport rules (local-only Host / Origin, `application/json` POSTs, 404 before the token, constant-time Bearer token with a 401 challenge, MCP 2025-06-18 / 2025-03-26 / 2024-11-05 negotiation) are `MCPHTTP`, extracted from Swash.
