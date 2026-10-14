---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Compare two documents into tracked changes.

- `@pixerate/editor` (also `@pixerate/editor/compare`): `diffSequences` / `diffChanges` (Myers diff with common prefix/suffix stripping and patience anchors for long inputs), `compareDocuments(original, revised, options)` returning the revised document with the differences as `insertion` / `deletion` / `formatChange` marks and `blockChange` records plus a summary (`insertions`, `deletions`, `formatChanges`, `blockChanges`, `notHonoured`), and `compareHtml`. Options: `granularity: "word" | "char"`, `ignoreCase`, `ignoreWhitespace`, `formatting`, `author`, `date`. Accepting all changes yields the revised document, rejecting all the original.
- New `DocumentCompare` extension (added by the rich-text preset with `trackChanges`) with the `setContentFromComparison(original, revised)` command, and `applyDocumentComparison(editor, …)` / `compareInEditor`; the content is set without being tracked.
- Track changes: `blockChange` records can carry `operation: "insert" | "delete"` for wholly inserted/deleted blocks (accepting a deletion or rejecting an insertion removes the block and emptied containers). They render with `data-block-operation` and the new `blockInsertedClass` / `blockDeletedClass` options, and are described as "Inserted Paragraph" / "Deleted 2 blocks". Exports (`getEditorText`, Markdown, `resolveTrackedChanges`) resolve them like inline changes.
- React: `useDocumentCompare(editor)`; Svelte: `createDocumentCompare(editor)`.
