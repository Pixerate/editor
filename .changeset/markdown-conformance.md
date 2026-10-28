---
'@pixerate/markdown-conformance': minor
'@pixerate/editor': minor
'@pixerate/editor-react': patch
'@pixerate/editor-svelte': patch
---

Add shared `@pixerate/markdown-conformance` package containing Markdown editing fixtures and format-command manifest.
Expose `createFormatCommands` and `formatCommandsFor` across `@pixerate/editor`, `@pixerate/editor-react`, and `@pixerate/editor-svelte` with full cross-framework parity and schema validation.
