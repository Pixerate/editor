---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Read charts from Excel, PowerPoint and Word files. `extractOfficeCharts` (and `extractXlsxCharts`, `extractPptxCharts`, `extractDocxCharts`) in `@pixerate/editor/chart` return every chart in a file as a `ChartSpec` with where it sits: the sheet and anchor cell in a workbook, the slide number in a deck. DrawingML and Office 2016 chartex charts are both read. `createOfficeChartToolProvider` gives agents `list_open_files`, `list_file_charts`, `get_file_chart` and `load_file_chart`, and React and Svelte register it with `useOfficeChartToolProvider`.
