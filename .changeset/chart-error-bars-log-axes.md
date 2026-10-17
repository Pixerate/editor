---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Charts: error bars, logarithmic axes and reversed axes.

- Series take `errorBars` (bar, line, area, scatter) and `xErrorBars` (scatter / bubble x): `fixed`, `percent`, `stddev` (around the series mean, as Excel), `stderr` or `custom` plus / minus amounts, with `direction` and `cap`. Drawn as `error-bar` marks, on stack tops when stacked, and included in the axis range. `chartErrorAmounts`, `describeChartErrorBars`, `chartErrorBarsOfType`.
- Value axes and the scatter x axis take `scale: "log"` with `logBase` (2–1000, default 10): power or 1-2-5 ticks (`niceLogScale`), values of 0 or less skipped with a `values-skipped` warning, refused with percent stacking. `ChartValueScale.logBase`, `chartScaleToPixel` / `chartScaleFromPixel`; drags move by ratio and ↑ ↓ step by a tenth of a power.
- Every axis takes `reverse: true`.
- Office import / export reads and writes `c:errBars`, `c:logBase` and `c:orientation maxMin` (no longer reported as unsupported); Mermaid keeps them in the `%% @pixerate` comment.
- `update_chart` / `update_chart_series` (tools and commands) describe the new fields; summaries and descriptions mention log and reversed axes and error bars.
- `<ChartInspector>` (React and Svelte): Reverse and Log scale toggles with a log base on axes, and error bar type, amount, custom amounts, direction and caps on the selected series.
