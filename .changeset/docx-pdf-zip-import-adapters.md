---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add dependency-free DOCX, PDF and zipped-export import adapters.

- **DOCX** is now a built-in `document` adapter (`docxImportAdapter`, `createDocxImportAdapter`, `docxToDocumentImport`): headings, run formatting, hyperlinks (incl. `HYPERLINK` fields), nested lists, tables, line breaks, tabs, footnotes / endnotes and embedded images, sanitized with `sanitizeImportedHtml`. Tracked changes import as accepted by default (`trackedChanges: "original"` to reject). `getImportAccept("document")` now includes `.docx`, `.docm`, `.dotx` and the WordprocessingML MIME types, so React `useFileImport` / `useEditor({ fileImport })` and Svelte `createFileImport` / the `fileImport` prop import Word files automatically.
- **PDF** (opt-in): `createPdfImportAdapter(pdfjs)` takes an injected pdf.js-compatible object and groups text items into lines and paragraphs; `pdfTextItemsToParagraphs` is exported.
- **Zipped exports** (opt-in): `zipImportAdapter` / `createZipImportAdapter` import `.zip` archives of markdown / HTML / text / DOCX files with a heading per file and report skipped entries.
- **ZIP reader**: `readZip` / `ZipArchive` / `ZipError` parse ZIP (incl. ZIP64) and inflate with `DecompressionStream`, with entry-count, uncompressed-size, path-traversal, encryption and CRC-32 checks.
- `ImportErrorCode` gains `invalid_file` and `unsupported_environment`; `ImportError`s thrown by adapters now keep their code instead of being wrapped as `adapter_failed`. `ImportContext` exposes the running `registry`.
