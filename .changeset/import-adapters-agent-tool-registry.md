---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add file import adapters, a rich-text clipboard MIME type and a dynamic agent tool registry.

- **Import adapters** (`@pixerate/editor`): `registerImportAdapter`, `findImportAdapter`, `importFile`, `getImportAccept` and `ImportAdapterRegistry`, with built-in markdown, HTML (sanitized), plain-text and RTF adapters for the `document` target. DOCX/PDF/zip or CSV → spreadsheet adapters can be registered. New serializers: `sanitizeHtml`, `sanitizeImportedHtml`, `plainTextToParagraphHtml`, `rtfToPlainText`.
- **Drag-and-drop / picker import**: opt-in `FileImport` extension (`createRichTextPreset({ fileImport: true })`), `importFilesIntoEditor`, `FileImportController`; React `useFileImport` and `useEditor({ fileImport })` / `usePromptEditor({ fileImport })`; Svelte `createFileImport` and the `fileImport` prop on `EditableTextNodeEditor`.
- **Rich clipboard**: opt-in `RichClipboard` extension writes `application/x.pixerate.document+json` (slice JSON + schema signature) on copy/cut and prefers it on paste when schemas match; `richClipboard` option in React `useEditor` and on the Svelte editor.
- **Agent tool registry** (`@pixerate/editor/agent`): `ToolRegistry` with MCP-shaped `listTools` / `callTool`, JSON-Schema-lite argument validation (`validateJsonSchema`), structured errors, namespacing on name collisions and coalesced `onListChanged`. Providers: `createRichTextToolProvider`, `createSpreadsheetToolProvider`, `createEditorMcpToolProvider`. The planner gains `toolCallToAgentCommand`, `planToolCall` and a `tool:call` command / `step:tool_call` step. React and Svelte `useAgentToolProvider`.
- Fix (Svelte): `EditableTextNodeEditor` no longer passes `undefined` `onUpdate`/`onCreate` to TipTap, which made editor updates throw when those props were omitted.
