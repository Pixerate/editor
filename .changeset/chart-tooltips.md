---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Chart tooltips. `<ChartCanvas tooltip>` shows the bar, point or slice under the pointer, and `tooltip="category"` shows every series anywhere in a bar, line or area chart's category band. Values are written with the series or axis format, with shares on 100% stacked and pie charts. Pass `renderTooltip` (React) or a `tooltipContent` snippet (Svelte) for custom content. The tooltip hides while a point is dragged. Core adds `chartTooltipAt`, `chartTooltipFor`, `sameChartTooltip`, `chartCategoryAtPoint` and `ChartScene.categoryScale`, and the chart tool provider adds a read-only `get_chart_tooltip` tool.
