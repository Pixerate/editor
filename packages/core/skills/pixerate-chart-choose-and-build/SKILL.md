---
name: pixerate-chart-choose-and-build
description: The chart building workflow in the Pixerate chart editor - starting from the question the chart answers, choosing the chart type for it (change over time, comparison, part of a whole, distribution, relationship, flow, geography), loading clean data in order, honest axes (bars from zero, log only for orders of magnitude), units and number formats, colours that colour-blind readers can tell apart, and checking before handing it over. Use when asked to make, build, create, choose, recommend or fix a chart or graph, visualise or plot data, pick the right chart, or make a chart clearer, more honest or accessible, or when recommend_chart, set_chart_data, update_chart or check_chart_colors are available. Load with pixerate-chart, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-chart
---

# Choosing and building a chart

A chart answers one question. Name the question first ("how did revenue change over the
year?", "which region sells most?"), and the type, the order of the data, the axes and the
title follow from it. Build in few calls: data in one, style in one, then check the warnings,
the colours and the numbers before anyone sees it.

This skill is the method. `pixerate-chart` has the full tool reference; for titles, highlights,
reference lines and notes that make the point, see `pixerate-chart-annotate`.

## Goal and quality bar

- The type fits the question (see the decision table).
- The data is in a meaningful order: time in calendar order, categories sorted by value unless
  they have a natural order.
- Axes are honest: bars and areas start at zero; a log scale only when values span orders of
  magnitude, and labelled as such; a second axis only for a second unit.
- Units are stated (axis title or number `format`); the title says what the chart shows.
- Colours pass `check_chart_colors` (`ok: true`) and there are at most about seven series
  colours.
- `get_chart` `summary.warnings` and `issues` are empty.

## Inputs to confirm

- **The question** the chart must answer, and for whom (a report, a slide, a dashboard).
- **The data**: where it is (pasted, CSV, a spreadsheet, an Office file) and its units.
- **House style** if the host has one (`check_chart_style`).

## Working method

1. **Read.** `get_chart` (the spec, the data table, warnings); `list_file_charts` when the
   data is in an open Office file.
2. **Name the question and choose the type.** `recommend_chart` suggests types for the data;
   check its suggestion against the question (see the table).
   **Check:** you can say the question in one sentence and why this type answers it.
3. **Load clean data in one call.** `set_chart_data` with categories in the right order and one
   series per measure (or `import_chart_csv`); numbers as numbers, gaps as `null`.
   **Check:** `get_chart` `spec.categories` and each series' `values` line up as intended.
4. **Style in one call.** `update_chart` with `type`, `title`, axis `title` and `format`,
   `legend`, `stacking`, `orientation`, `dataLabels`. Bars from zero (`yAxis.min` null or 0).
   **Check:** `get_chart` spec; `summary.description` reads as the chart you meant.
5. **Colours.** `check_chart_colors`; fix failing pairs with `update_chart_series` `color` (a
   palette such as `#4269d0` / `#efb118` separates for most colour vision), or
   `apply_chart_preset` for a tested palette.
   **Check:** `check_chart_colors` `ok: true`.
6. **Look.** `render_chart` once after the batch; fix anything that does not read.

## Decision table

| Question | Type |
| --- | --- |
| How did it change over time? | `line` (one or a few series), `area` for totals, columns for few periods |
| Which is biggest? Compare categories | `bar`, horizontal for long labels, sorted by value |
| Part of a whole (few parts) | `pie` or `donut` (at most five slices), or a stacked bar |
| Part of a whole, nested | `treemap`, `sunburst` (`set_chart_tree`) |
| How are values distributed? | `histogram`, `box` |
| Do two measures relate? | `scatter`, `bubble` for a third measure |
| Before and after per category | `slope` |
| Contributions to a total | `waterfall` |
| Flows between stages | `sankey` (`set_chart_links`), `funnel` for one path |
| Survey answers | `likert` |
| By region on a map | `choropleth` |

## Recipes

**Trend over time.** `set_chart_data` with categories in calendar order → `update_chart`
`{ type: "line", title, yAxis: { title: "Revenue (USD thousands)" } }` → `get_chart`.

**Colour-blind fix.** `check_chart_colors` → `update_chart_series` `color` on the clashing series
→ `check_chart_colors` again.

**Honest bars.** `update_chart` `{ yAxis: { min: 0 } }`; when small differences matter, show the
differences themselves (a bar of the change) or a dot plot rather than a cut axis.

## Pitfalls

- **Truncated bar axes** exaggerate differences; bars start at zero.
- **Pie charts with many or similar slices** cannot be read; use a sorted bar.
- **Red and green** as the only distinction fail for the most common colour-vision deficiency.
- **Unsorted categories** without a natural order hide the ranking.
- **Mixed units on one axis**, or a second axis for the same unit, mislead.
- **Missing units** leave the reader guessing; put them in the axis title or format.

## Tools used

- `get_chart`, `render_chart`: the spec, data table, warnings, and a picture
- `recommend_chart`: types that suit the data
- `set_chart_data`, `import_chart_csv`, `transpose_chart`: load the data in order
- `update_chart`, `update_chart_series`, `apply_chart_preset`: type, titles, axes, formats and colours
- `check_chart_colors`, `check_chart_style`: colour-blind and house-style checks
- `list_file_charts`, `load_file_chart`: data from open Office files
- `undo_chart`: take back a step
