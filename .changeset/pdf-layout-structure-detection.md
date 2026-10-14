---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

PDF import now recovers document structure from the page layout. The new pure `analyzePdfLayout` reads multi-column pages in column order, removes running headers, footers and page numbers, re-joins hyphenated words, and detects headings (levels from font-size and weight clusters against the body size), bulleted and numbered lists (nesting by indent, ordered `start`), and tables from ruling lines (with spanning cells) or aligned column gaps (spanning header/totals rows, header rows from bold or labels over numbers). `createPdfImportAdapter` uses it by default, reads ruling lines and font weights from pdf.js, and returns a `structure` report (counts, confidences, detected items); `structure: false` (at creation or per import via the new `adapterOptions: { pdf: { structure: false } }` on `importFile`, `importFilesIntoEditor`, the file-import controller and the `FileImport` extension) restores the plain paragraph import. New helpers: `pdfLayoutBlocksToHtml`, `pdfTextItemsToRuns`, `pdfOperatorListToRules`, `summarizeImportStructure`. React's `useFileImport` and Svelte's `createFileImport` expose `structureSummary`.
