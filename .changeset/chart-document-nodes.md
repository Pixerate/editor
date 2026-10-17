---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Charts in documents: `createRichTextPreset({ chart: true })` adds a `chart` block node (a `ChartSpec` in `data-chart`, a static SVG in HTML, a ```` ```mermaid ```` block in markdown) and an inline `sparkline` node, with `insertChart`, `updateChart` and `insertSparkline` commands and `getDocumentCharts`. DOCX imports insert embedded charts as chart nodes when the schema has them (otherwise a caption and a data table, as before, now after the paragraph). `createReactChartNodeView` and `createSvelteChartNodeView` draw each chart with `<ChartCanvas>`: read-only until clicked, then editable with the inspector and data grid, with every edit an editor undo step. `createRichTextToolProvider` adds `list_document_charts`, `insert_chart`, `update_chart_in_document` and `insert_sparkline`. Adds `chartSceneToDomSpec` for drawing charts in ProseMirror `renderHTML`.
