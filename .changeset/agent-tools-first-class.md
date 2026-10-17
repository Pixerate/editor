---
"@pixerate/editor": minor
---

Make agent tools easier for models to use correctly:

- **Rich text**: new `find_text`, `replace_text` (all matches or the n-th, one undo step), `replace_range` and `set_selection` tools. `get_text { blocks: true }` returns each paragraph's document positions, so agents no longer have to turn plain-text offsets into ProseMirror positions.
- **Canvas and prompt**: `createEditorMcpToolProvider` now exposes one strict tool per operation by default (`canvas_add_node`, `canvas_connect`, …, `prompt_insert_text`, …; definitions in `EDITOR_CANVAS_TOOLS` / `EDITOR_PROMPT_TOOLS`). Pass `toolStyle: "combined"` to keep `edit_canvas` / `edit_prompt`. Edits are checked against the snapshot with the new `validateAgentCommand` (unknown or duplicate ids, self-edges, unordered ranges). Results include the ids of created nodes and edges. Errors for combined tools name the missing arguments. `highlight` passes `color` / `durationMs` through.
- **Spreadsheet**: new `set_range` (2D block as one undo step, refuses read-only targets), `insert_rows`, `delete_rows`, `insert_columns` and `delete_columns` tools.
- **MCP server**: new dependency-free `createMcpServer(registry, { name, version, send })` in `@pixerate/editor/tools`. It handles `initialize`, `ping`, `tools/list`, `tools/call`, cancellation and `notifications/tools/list_changed` over any transport.
- **Schema validation**: `validateJsonSchema` now supports `anyOf`, `oneOf`, `allOf`, `not`, local `$ref`, `exclusiveMinimum` / `exclusiveMaximum`, `multipleOf` and `uniqueItems`. Unknown-property errors list the allowed properties.
- **Metadata**: component, image-editor and command tools now have titles and a description for every argument. `reset_overrides`, `push_overrides`, `detach_instance` and `remove_variant` are marked destructive.
