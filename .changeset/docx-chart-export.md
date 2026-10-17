---
"@pixerate/editor": minor
---

Word export writes `chart` nodes as native Word charts: each becomes a `word/charts/chartN.xml` part (`chartToOoxml`) with its relationship and content type, referenced from an inline drawing sized from the node's `width` / `height` (no width = the page's text width; wider charts are scaled down to fit). Re-importing the file gives back the same spec (series ids are renumbered: DrawingML has none). Inline `sparkline` nodes are written as text, their label or block characters (`▁▅█`), and reported. `DocxExportReport.written` gains a `charts` count.
