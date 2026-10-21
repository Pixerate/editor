---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Make agent tools easier to find in large catalogues.

- **Breaking: tool names are namespaced by default.** `ToolRegistry` now exposes every tool as `<namespace>__<name>`, using the provider's `namespace` or else its `id` (`chart__get_chart`, `image-editor__add_layer`), so names no longer change when another editor mounts. Calls by bare name still work when only one tool has that name; an ambiguous bare name fails with the full names to choose from. Pass `new ToolRegistry({ namespaces: 'on-collision' })` for the old behaviour, or `namespace: ''` on a provider to keep its bare names.
- **Toolsets.** Providers carry a `title`, `description` and `skill`, and every built-in provider sets them. `registry.toolsets()` groups tools by namespace.
- **Scoped views.** `registry.view({ toolsets, readOnly })` shows an agent only some toolsets or only read tools, refusing the rest with the reason; `setToolsets` follows the focused editor. Views are tool sources, so `createMcpServer`, `connectToolBridge` and `useToolBridge` accept them.
- **Discovery.** `registry.view({ discovery: { skills } })` lists only `list_toolsets`, `search_tools`, `enable_tools`, `disable_tools` and `get_skill` until the agent enables what it needs. `searchTools` ranks tools for a plain-words task.
- **Skills over MCP.** `createMcpServer(source, { skills, instructions: toolsetInstructions })` serves the agent skills as MCP prompts and `skill://` resources and describes the toolsets on `initialize`. The MCP bridge serves the packaged skills by default (`loadSkillFiles()` in `@pixerate/editor/bridge`).
- **React and Svelte:** `useToolRegistryView` in both; `useToolBridge` accepts a view.
