---
"@pixerate/editor": patch
---

Pasting or importing a table while the cursor is in a table cell no longer creates a nested table. A pasted table on its own (HTML, markdown or the rich clipboard) fills the cells from the cursor, growing the table when needed; pasted content that has a table among other blocks, and imported DOCX / PDF / HTML files with tables, are inserted after the outermost table. A guard moves any table another edit puts into a cell (e.g. `insertContent`) after the table. Tracked changes still record the insertions. Documents that already contain nested tables load unchanged. New exports: `handleTablePasteWithoutNesting`, `insertSliceAfterTable`, `unnestTables`, `createTableNestingPlugin`, `ALLOW_NESTED_TABLES_META`, `sliceContainsTable`, `isInTableCell`, `outermostTableDepth`.
