---
"@pixerate/editor": minor
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Add the `@pixerate/editor/tools` subpath: `ToolRegistry`, `createToolRegistry`, `ToolRegistryError`, the agent tool types, `validateJsonSchema` and the static `EDITOR_MCP_TOOLS` definitions, with no TipTap, ProseMirror or dagre imports. Hosts that only combine tool providers (for example `createCommandToolProvider`) no longer need TipTap installed. `@pixerate/editor/agent` still re-exports all of it, and the TipTap-bound providers (`createRichTextToolProvider`, `createEditorMcpToolProvider`, ...) stay there. The React and Svelte tool-provider helpers now import their types from `/tools`.
