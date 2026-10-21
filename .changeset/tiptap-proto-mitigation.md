---
"@pixerate/editor": patch
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Mitigate GHSA-cp6q-959q-f8rh (TipTap `mergeAttributes()` prototype pollution) within TipTap 2. The TipTap peer dependency floor rises from `^2.11.5` to `^2.27.3`, the 2.x release that carries TipTap's fix. Our nodes and marks now render through the new `safeMergeAttributes`, and untrusted JSON loses own `__proto__`, `constructor` and `prototype` keys (via the new `stripPrototypeKeys`) at `EditorController` content, the rich clipboard (`application/x.pixerate.document+json`), `compareDocuments`, `CommentStore.parse`, the persistence loaders, the style registry, and every agent tool call through `ToolRegistry.callTool`. So an own `__proto__` key from document JSON can no longer become rendered DOM attributes (such as `onerror`), even with an older TipTap.
