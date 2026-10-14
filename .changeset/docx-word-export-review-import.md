---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Word (.docx) export and review import.

- Core: new `@pixerate/editor/export` subpath (also re-exported from the root): `exportDocx(editorOrJSON, { styles, comments, author, privacy, title, remoteImages })` writes a dependency-free `.docx` with paragraph styles (`styles.xml` with `basedOn` / `next` / `link`), formatting, links, bullet / ordered / task lists, block quotes, code blocks, embedded images, tables (`gridSpan` / `vMerge` / header rows), tracked insertions, deletions, moves, formatting and block changes with authors and dates, and comments with replies and resolved state; returns a report of anything dropped. `privacy: "strip-authors"` anonymises names. Also `exportDocxBlob`, `createDocxParts`, `DocxExportController`, `downloadBlob`, `writeZip`.
- Core: the DOCX importer reads comments (replies, resolved, author ids from `people.xml`) into `DocumentImport.comments` with `data-comment-id` ranges, tracked changes as review marks with `trackedChanges: "marks"`, and `styles.xml` into `DocumentImport.styles` (a style registry) with `data-style` on styled paragraphs; `Block Text` paragraphs become block quotes and `Code` paragraphs code blocks. `applyImportedReviewData` loads comments and styles into an editor (`importFilesIntoEditor` does it automatically). The HTML sanitizer now keeps `<ins>`.
- React: `useDocxExport` and `ExportDocxButton`. Svelte: `createDocxExport` and `ExportDocxButton`.
