---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add an MCP bridge (ported from Ursula): `@pixerate/editor/bridge` (Node only, no dependencies) runs one MCP server over stdio that drives editors open in a browser over a localhost WebSocket. It has an origin allowlist, an optional token, `list_editors`, an `editor` argument for picking an editor, cancellation, timeouts and port retry. The `pixerate-mcp-bridge` CLI starts it. Pages connect their `ToolRegistry` with `connectToolBridge` (`@pixerate/editor/tools`), which re-sends the tool list on change and reconnects after the bridge restarts. React and Svelte add `useToolBridge`.
