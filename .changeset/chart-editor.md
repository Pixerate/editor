---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add a UI-agnostic chart editor (`@pixerate/editor/chart`, `@pixerate/editor-react/chart`, `@pixerate/editor-svelte/chart`). Bar, line, area, scatter, pie and donut charts (combos, stacked and 100% stacked, horizontal bars, smooth / step lines) are described by a validated JSON `ChartSpec`. `layoutChart` turns a spec into DOM-free drawing primitives with click targets, and `chartToSvg` exports them. `ChartController` edits data and presentation with selection, drag gestures and undo. The interaction helpers (`startChartPointDrag`, `handleChartKey`) are shared by both frameworks, and `createChartCommands` provides agent tools. React and Svelte add `ChartEditor`, `ChartCanvas` (click to select, drag bars and points, keyboard editing), `ChartDataGrid` (spreadsheet paste, CSV import), `ChartInspector`, and `useChartEditor` / `createChartEditor` with `useChartCommands`.
