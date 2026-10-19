---
name: pixerate-chart
description: How to build, edit and check charts in the Pixerate chart editor through its agent tools and chart.* commands - bar, column, line, area, scatter, bubble, pie, donut, radar, waterfall, histogram, box plot, funnel and treemap charts; series, categories, stacking, secondary axis, log axis, number formats, data labels, legend, trendline, error bars, colour palettes and colour-blind checks, CSV and Mermaid import, Office chart XML export, and reading charts out of open .xlsx, .pptx and .docx files. Use when a chart editor's tools (get_chart, update_chart, set_chart_values, list_file_charts...) are available or the user asks to make, restyle, fix or explain a chart.
---

# Charts

A chart editor holds one `ChartSpec`: a `type`, `title` / `subtitle`, `xAxis` / `yAxis` /
`yAxis2`, `legend`, presentation fields (stacking, orientation, curve, data labels, palette),
a list of `categories` (strings, in order) and a list of `series`. Each series has an `id`
(such as `series-1`), a `name` and one value per category (`null` is a gap), plus optional
per-series settings (type for combos, secondary axis, marker, colour, format, trendlines,
error bars). Tools take a series by id or exact name and a category by 0-based index or
exact label; `get_chart` returns both. Pie, donut, funnel and treemap draw only the first
visible series, one slice per category; histogram and box read every value of the visible
series.

Read `pixerate-agent-tools` first for tool naming, errors and `run_commands` batching.
Charts inside a rich-text document are not edited with these tools: use `insert_chart`,
`list_document_charts` and `update_chart_in_document` from the `pixerate-rich-text` skill
(a chart block goes in the prose, never inside a table row).

## Working method

1. **Read.** `get_chart` returns the spec, the data as a table, the selection and a
   summary at the given size (default 640 x 400): per-series min / max / mean / trend, the
   axes as drawn, layout warnings, a colour check and a plain-language description. If the
   data comes from a file, start with `list_open_files` and `list_file_charts`.
2. **Choose the form.** Decide what question the chart answers, then call `recommend_chart`
   (on the current data or on CSV you are about to import) and pick from its list.
3. **Load data in one call.** Use `import_chart_csv` (with `chartType: "auto"` for a fresh
   chart) or `set_chart_data` for whole tables, `set_chart_values` for individual cells.
   Avoid adding categories and series one by one when you already have the table.
4. **Style in one call.** Put type, titles, axes, legend, stacking and labels in a single
   `update_chart`; it is all-or-nothing and one undo step. Use `apply_chart_preset` for a
   coherent layout or colour scheme, `update_chart_series` for per-series settings.
5. **Check.** Read the `warnings` that `get_chart` and `render_chart` return (hidden or
   thinned labels, crowded legend, skipped values) and run `check_chart_colors`. Fix every
   problem.
6. **Look once.** `render_chart` with `format: "png"` after a batch of edits, at the size
   the chart will be shown, to check overlap and legibility. Use `undo_chart` for your own
   mistakes.

## Best practices

- **Pick the type by the question.** Comparison across categories: bar (horizontal with
  `orientation: "horizontal"` for long labels or many categories). Change over time: line
  (area when volume matters; set `xAxis.kind: "date"` for date categories). Composition:
  stacked bar or `stacking: "percent"` for shares across groups; pie or donut only for one
  whole with few parts. Distribution: histogram (`bins`, default the square root of n) or
  box. Relationship: scatter with `series.x`, bubble with `sizes` for a third measure.
  Running totals and bridges: waterfall (`showTotal`). Staged drop-off: funnel.
- **Bars start at zero.** Bar length encodes the value, so never set a non-zero `min` on the
  value axis of a bar, column or area chart. Line and scatter charts may zoom to the data
  range when the change, not the magnitude, is the point.
- **Pie and donut: at most about five slices**, all positive, adding up to a meaningful
  whole. Beyond that, use a sorted bar chart or merge small slices into "Other".
- **Sort bars** by value (largest first) unless the categories have a natural order (time,
  ranks, age bands). Reorder by sending the sorted table through `set_chart_data`.
- **Limit colours.** Keep to about seven distinct series colours; beyond that, split into
  small multiples or highlight one series and grey the rest (`color`, `pointColors`).
  Run `check_chart_colors` after any palette change; the `okabe-ito` scheme in
  `apply_chart_preset` stays distinct with colour-blindness. Do not encode meaning by
  colour alone: add labels or markers (`marker`).
- **Label directly.** With few series or few bars, prefer data labels (`dataLabels`,
  `labelPosition: "auto"` drops labels that do not fit) and the `labelled` or `minimal`
  layout over a legend plus grid. Always set a title that states the takeaway and axis
  titles with units.
- **Number formats.** Set `format` on the axis (and on series labels when they differ):
  `style: "percent"` (0.25 shows as 25%), `"currency"` with `currency`, `"compact"` (1.2K),
  fixed `decimals`, or a spreadsheet `code` such as `#,##0.0,,"M"`. Use the same format on
  the axis and the labels; avoid more decimals than the data justifies.
- **Honest dual axes.** Use `axis: "secondary"` only when two series have different units,
  title both axes with those units, and make the series visibly different (bar plus line
  via the series `type`). Never use a second axis to make two same-unit series look
  correlated.
- **Log scale** (`scale: "log"`) only for data spanning orders of magnitude or for growth
  rates; say so in the axis title. It skips values of 0 or less and refuses percent
  stacking.
- **Trendlines are models, not data.** Add one only when a fit is meaningful, show R2
  (`showR2`) and read it with `get_chart_trendline` before describing the trend; label any
  `forward` forecast as a projection. Exponential, power and log fits need positive values;
  category charts fit against x = 1, 2, 3.
- **Error bars:** say what they are (standard deviation, standard error, confidence) in the
  title or subtitle.

## Tool reference

### Read

| Tool | Use it to |
| --- | --- |
| `get_chart` | Start here. Returns spec, data table, selection, issues and a summary (min / max / mean / trend, axes as drawn, layout warnings, colour check, description) at `width` x `height` px (default 640 x 400). Also says why when the chart is read-only. Cheaper than rendering. |
| `render_chart` | Draw without changing anything: SVG text by default, or `format: "png"` for an image (only when the host can rasterize; otherwise it fails and says to use SVG). Returns the layout warnings too. Images cost tokens: render after a batch of edits, at the display size, to check overlapping or cut-off labels, a crowded legend and unreadable colours. |
| `check_chart_colors` | Check the chart's series (or slice) colours, or a `colors` list, for normal vision, protanopia, deuteranopia and tritanopia, and contrast against `surface` (default white). Returns the closest pair per vision and problems as sentences. Run after any colour change. |
| `recommend_chart` | Ranked chart types with a reason each, from `csv` when given, else the current data (series count, points, dates, negative values). Use before choosing a type. |
| `get_chart_trendline` | Read a trendline's fit (`series`, `index`): coefficients, R2, equation and point count, or the moving-average points. Fails when the fit needs more or positive values. |
| `list_chart_presets` | List the quick layouts (`standard`, `minimal`, `labelled`, `legend-right`, `presentation`, `analysis`) and colour schemes (such as `default`, `okabe-ito`, `office`, monochrome) with what each changes. |
| `export_chart_mermaid` | Get the chart as Mermaid `xychart-beta`, `pie` or `radar-beta` for Markdown or chat. With `meta` (default true) a `%% @pixerate` comment keeps everything Mermaid cannot express so `import_chart_mermaid` restores it exactly. |
| `export_chart_ooxml` | Get a DrawingML `c:chartSpace` part for Word or PowerPoint, plus sentences for anything that could not be written. |
| `list_open_files` | List the Office files the user opened (name, size in bytes). Only registered when the host shares open files; otherwise the file tools take the whole file as base64 `data`. |
| `list_file_charts` | List every chart in an `.xlsx`, `.pptx` or `.docx` (`file` name or base64 `data`) in file order: id (such as `chart-1`), place (sheet and anchor cell, or slide number), title, type, series names, category count, read problems, unsupported features and whether it reads losslessly. |
| `get_file_chart` | Return one file chart's full spec (`file` or `data`, `chartId` from `list_file_charts`) with its place and read problems, without touching the editor. Data comes from the chart's cached values, not the embedded workbook. |

### Write

Write tools are hidden while the chart is read-only. Each is one undo step and returns what
it changed.

| Tool | Use it to |
| --- | --- |
| `update_chart` | Change presentation in one all-or-nothing call: `type`, `title`, `subtitle`, `xAxis` / `yAxis` / `yAxis2` (show, title, min, max, step, gridlines, format, kind `"date"`, scale `"log"`, logBase, reverse), `legend` (show, position top / bottom / left / right), `stacking` (none / stacked / percent), `orientation`, `curve`, `points`, `dataLabels`, `labelPosition`, `palette`, `innerRadius` (donut hole, 0-0.9), `gapWidth`, `overlap`, `bins`, `showTotal`. Invalid values change nothing and come back as sentences. Returns the spec. |
| `set_chart_data` | Replace `categories` and / or all `series` (each with `name`, `values` and optional settings). Values are padded with gaps to the categories. Use for whole tables and for re-sorting. Returns the table and series ids. |
| `set_chart_values` | Set individual `cells` (`series`, `category`, `value`) all-or-nothing. Values may be numbers, numeric text (`"1,200"`, `"12%"`, `"$40"`, `"(3)"`) or `null` for a gap. Returns the stored values. Acted out with a cursor when the host has a director. |
| `add_chart_series` | Add a series (`name` required; `values`, `color`, `type` for a combo, `axis: "secondary"`, `x` / `sizes` for scatter and bubble, marker, format, error bars, `id`, `at`). Selects it and returns its id. |
| `update_chart_series` | Rename, recolour, hide, move to the secondary axis, change `type`, `marker`, `curve`, `dataLabels`, `format`, `x`, `sizes`, `pointColors`, `errorBars` / `xErrorBars` of one series; `null` resets a field. Values change with `set_chart_values`. |
| `remove_chart_series` | Delete a series and its values. Returns the remaining series ids. |
| `add_chart_category` | Insert a category (`label`, `at`; default the end) as a gap in every series. Returns its index; fill it with `set_chart_values`. |
| `remove_chart_category` | Delete a category (index or label) and its value in every series. |
| `import_chart_csv` | Replace the data with CSV or TSV text. Default: first row series names, first column categories (`seriesIn`, `header` change that). `chartType: "auto"` also picks the recommended type (two unlabelled numeric columns become a scatter). Returns the table, the type and cells that were not numbers. |
| `import_chart_mermaid` | Replace the chart with Mermaid `xychart-beta`, `pie` or `radar-beta` text (fenced or bare). Unreadable lines are skipped and listed with line numbers. |
| `import_chart_ooxml` | Replace the chart with a raw Office chart part (`c:chartSpace` or chartex XML). Only listed when the host has a `DOMParser` (every browser does). Prefer `load_file_chart` when you have the whole file. |
| `load_file_chart` | Replace the editor's chart with one from an Office file (`file` or `data`, `chartId`). Returns the spec, read problems and the features the editor could not keep; tell the user about any. |
| `add_chart_trendline` | Fit a trendline to a series (`type`: linear, exponential, logarithmic, power, polynomial with `order` 2-6, moving-average with `period`; `forward` / `backward` in x units, `intercept`, `showEquation`, `showR2`). Unstacked bar, line, area, scatter and bubble charts only. Returns its index, coefficients, R2 and equation. |
| `remove_chart_trendline` | Delete a trendline by `series` and `index`. |
| `apply_chart_preset` | Apply a quick `layout` and / or a `colors` scheme from `list_chart_presets` in one step. |
| `transpose_chart` | Swap series and categories. Drops per-series colours and settings, so restyle afterwards. |
| `select_chart_element` | Select part of the chart (`kind`: none, chart, title, subtitle, legend, axis, series, point, category, trendline) for the user to see or before `press_chart_key`. |
| `drag_chart_point` | Drag a bar or point as the mouse would, with the same snapping (`fine` = Alt, `lockAxis` = Shift on scatter). Positions are 0-1 fractions of the chart at `width` x `height`; use `render_chart` to find marks. Prefer `set_chart_values` for exact numbers. |
| `press_chart_key` | Send a key to the selection: ArrowLeft / ArrowRight move between categories, ArrowUp / ArrowDown change the value by a tenth of a tick (`shift` a whole tick, `alt` a hundredth), Delete / Backspace remove, Escape clears. |
| `undo_chart` | Undo the last chart edit. Returns the label of what was undone and the next undo. |
| `redo_chart` | Redo the last undone chart edit. |

## Commands

The `chart.*` commands (run with `run_command` / `run_commands`) mirror the tools. Prefer
the dedicated tool: it has a stricter schema and returns more (`get_chart` adds the
selection and read-only reason; `import_chart_csv` has `chartType: "auto"`;
`check_chart_colors` takes colours and a surface). Use the commands inside an atomic
`run_commands` batch when chart edits must roll back together with other edits, and for the
two operations without a tool: `chart.exportSvg` and its fixed-size accessible SVG. Hosts with
several charts may register them with another prefix.

| Command | Use it to |
| --- | --- |
| `chart.describe` | Read spec, data table and summary (as `get_chart`). |
| `chart.update` | Change presentation (as `update_chart`). |
| `chart.setData` | Replace categories and series (as `set_chart_data`). |
| `chart.setValues` | Set individual values (as `set_chart_values`). |
| `chart.addSeries` | Add a series; returns its id (as `add_chart_series`). |
| `chart.updateSeries` | Change a series' settings (as `update_chart_series`). |
| `chart.removeSeries` | Delete a series by id or name. |
| `chart.addCategory` | Insert a category at `at` (default the end). |
| `chart.removeCategory` | Delete a category by index or label. |
| `chart.addTrendline` | Fit a trendline (as `add_chart_trendline`). |
| `chart.removeTrendline` | Delete a trendline. |
| `chart.applyPreset` | Apply a quick layout and / or colour scheme. |
| `chart.transpose` | Swap series and categories. |
| `chart.importCsv` | Replace data from CSV / TSV (no automatic chart type). |
| `chart.importMermaid` | Replace the chart from Mermaid chart text. |
| `chart.exportMermaid` | Get Mermaid text (with the round-trip comment unless `meta` is false). |
| `chart.exportOoxml` | Get the DrawingML chart part. |
| `chart.exportSvg` | Get a standalone, accessible SVG (title and desc) at `width` x `height` (default 640 x 400), for saving or embedding. |
| `chart.recommend` | Suggest chart types for the data or `csv`. |
| `chart.checkColors` | Check the chart's own series colours (no parameters). |
| `chart.undo` | Undo the last chart edit. |
| `chart.redo` | Redo the last undone chart edit. |

## Pitfalls

- Series values are positional: one value per category, in category order. After
  `add_chart_category` or `remove_chart_category`, every series shifts with it.
- `set_chart_data` with only `series` keeps the categories; with only `categories` it keeps
  the series, whose values stay matched by position. Pass both to replace a table.
- Non-numeric cells are refused by `set_chart_values` ("Nothing was changed"); CSV import
  keeps going and lists them in `issues`. Check that list.
- Percent-stacked charts, pies and gaps cannot be dragged; use `set_chart_values`.
- Radar needs at least three categories (it draws as a line chart until then); trendlines
  are refused on stacked charts, pies and the other single-series families.
- `transpose_chart` and `load_file_chart` drop or replace styling; restyle and re-check
  colours afterwards.
- A `%% @pixerate` comment is what makes Mermaid round-trip exactly. Keep it when the text
  is going back into a Pixerate editor; pass `meta: false` only for plain Mermaid readers.
- File charts are read from cached values; if the user edited the workbook without saving
  the chart cache, the numbers can be stale. Say so when it matters.
- An atomic `run_commands` batch only rolls back chart edits when the host shares one history
  between the command registry and the chart; if a batch is refused for that, use the tools
  one by one and `undo_chart`.
- When the chart is read-only, only the read tools are listed and `get_chart` returns the
  reason. Tell the user; do not try to edit around it.
