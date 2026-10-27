---
name: pixerate-chart
description: How to build, edit and check charts in the Pixerate chart editor through its agent tools and chart.* commands - bar, column, line, area, scatter, bubble, pie, donut, radar, waterfall, histogram, box plot, funnel, treemap (flat or grouped), sunburst, Sankey, slope, Likert (survey), parliament, bar chart race and choropleth map charts; series, categories, stacking, secondary axis, log axis, number formats, data labels, legend, trendline, error bars, reference lines and target bands, callouts, highlighting, footnotes, colour palettes and colour-blind checks, CSV and Mermaid import, Office chart XML export, and reading charts out of open .xlsx, .pptx and .docx files. Use when a chart editor's tools (get_chart, update_chart, set_chart_values, list_file_charts...) are available or the user asks to make, restyle, fix or explain a chart.
---

# Charts

A chart editor holds one `ChartSpec`: a `type`, `title` / `subtitle`, `xAxis` / `yAxis` /
`yAxis2`, `legend`, presentation fields (stacking, orientation, curve, data labels, palette),
a list of `categories` (strings, in order) and a list of `series`. Each series has an `id`
(such as `series-1`), a `name` and one value per category (`null` is a gap), plus optional
per-series settings (type for combos, secondary axis, marker, colour, format, trendlines,
error bars, callouts). Annotations sit on the spec: `note` (footnote), `highlight` (names of
categories and series to keep bright), `referenceLines`, `referenceBands` and `varyColors`. Tools take a series by id or exact name and a category by 0-based index or
exact label; `get_chart` returns both. Pie, donut, funnel, treemap and parliament draw only
the first visible series, one slice (or group of seats) per category; histogram and box read
every value of the visible series. A slope chart joins the first series (before) to the
second (after) for each category; a Likert chart reads each category as a question and the
series as its answers, ordered from most negative to most positive.

Grouped data lives in `spec.tree` (items `{name, value}`, groups `{name, children}`, up to 6
levels). When a tree is set it *is* the data: the categories are its top-level group names
and the first series their totals, so a treemap nests the groups, a sunburst draws them as
rings, and any other type draws the totals. Nodes are addressed by `path`, the names from the
top down (`["Europe", "France"]`); `get_chart` returns them as `treeTable`.

A choropleth (`choropleth`) shades the regions of a map (`map`, `europe` by default) by the
first series: each category names a region by code (ISO alpha-3 for countries, such as FRA;
Kosovo is XKX) or by name (France). The host registers the map outlines; when no map is
registered or no category matches, the chart draws bars and warns.

A bar race (`barrace`) reads the ordinary table differently: each category is a time point
and each series a name, and it draws the top `raceTopN` names at one moment as ranked bars.
Which moment is shown is view state (`set_chart_race_frame`, `play_chart_race`), not part of
the chart.

Flows live in `spec.links` (`{source, target, value}` between named nodes). They work the same
way: when set they are the data, the categories are the nodes (stacked in `sankeyNodes`
order) and the first series how much passes through each. Flows are addressed by index in
`spec.links`. A chart holds a tree or flows, not both.

Read `pixerate-agent-tools` first for tool naming, errors and `run_commands` batching.
Charts inside a rich-text document are not edited with these tools: use `insert_chart`,
`list_document_charts` and `update_chart_in_document` from the `pixerate-rich-text` skill
(a chart block goes in the prose, never inside a table row).

## Working method

0. **House style.** When the host has one (`list_toolsets` shows a `style` field on the chart
   toolset), call `get_style` with `domain: "chart"` first and start from its palette and
   defaults.
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
5. **Point the reader at the message.** Once the data and style are right, annotate:
   `add_chart_reference_line` for a target or average, `add_chart_reference_band` for a
   normal or target range, `set_chart_callout` on the one or two points the title talks
   about, `highlight_chart` to mute what does not matter, and `note` (in `update_chart`) for
   the source.
6. **Check.** Read the `warnings` that `get_chart` and `render_chart` return (hidden or
   thinned labels, crowded legend, skipped values) and run `check_chart_colors`. With a house
   style, also run `check_chart_style` and fix each finding with `update_chart_series` or
   `update_chart` (its `target` names the series or point). Fix every problem.
7. **Look once.** `render_chart` with `format: "png"` after a batch of edits, at the size
   the chart will be shown, to check overlap and legibility. Use `undo_chart` for your own
   mistakes.

## Best practices

- **Pick the type by the question.** Comparison across categories: bar (horizontal with
  `orientation: "horizontal"` for long labels or many categories). Change over time: line
  (area when volume matters; set `xAxis.kind: "date"` for date categories). Composition:
  stacked bar or `stacking: "percent"` for shares across groups; pie or donut only for one
  whole with few parts. Distribution: histogram (`bins`, default the square root of n) or
  box. Relationship: scatter with `series.x`, bubble with `sizes` for a third measure.
  Running totals and bridges: waterfall (`showTotal`). Staged drop-off: funnel. What rose
  and what fell between two points in time: slope (two series, the names are the column
  captions). Agree-to-disagree survey answers: likert (`likertSort: "positive"` ranks the
  questions; `likertNeutral: "separate"` keeps the middle answer out of the comparison).
  Parts of parts (regions → countries, budget → departments → teams): a treemap with grouped
  data for comparing sizes, a sunburst for showing the levels (`sunburstLabel` captions the
  total in the middle). Load the levels with `import_chart_tree_csv` or `set_chart_tree`.
  Flows from stage to stage (a pipeline, a budget, energy or traffic sources): sankey; load
  rows of source, target, value with `import_chart_links_csv` or `set_chart_links`.
  A ranking that changes over time (sales by product per year, top cities per decade): barrace,
  with time points as categories and one series per name; keep `raceTopN` to about 10.
  A value by country across Europe: choropleth. Call `list_chart_map_regions` for the codes,
  load one row per country with `set_chart_data`, and keep to about five classes.
  Seats or votes per group with a majority: parliament (`parliamentMajority`,
  `parliamentArc`, `parliamentLabel`).
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
- **Annotate sparingly.** One or two reference lines, one band and a couple of callouts at
  most; every label competes with the data. Label every reference line (`label`) so the
  reader knows what it is, and keep callouts to a few words that say *why* the point
  matters ("Launch", "Strike"), not its value (that is what data labels are for).
- **Highlight instead of recolouring.** To show one bar or series against the rest, use
  `highlight_chart` (it mutes the rest and keeps the palette) rather than greying series by
  hand. Name categories to pick bars or points, series to pick whole lines. Clear it with
  `names: []`.
- **One series, many categories:** `varyColors: true` gives each bar its own palette colour
  and a category legend. Use it only when colour carries meaning (brands, teams); a ranked
  bar chart reads better in one colour.
- **Cite the source** in `note` ("Source: ONS, 2025"); it sits under the chart, apart from
  the title.
- **Error bars:** say what they are (standard deviation, standard error, confidence) in the
  title or subtitle.

## Tool reference

### Read

| Tool | Use it to |
| --- | --- |
| `get_chart` | Start here. Returns spec, data table, selection, issues and a summary (min / max / mean / trend, axes as drawn, layout warnings, colour check, description) at `width` x `height` px (default 640 x 400). Also says why when the chart is read-only. Cheaper than rendering. |
| `render_chart` | Draw without changing anything: SVG text by default, or `format: "png"` for an image (only when the host can rasterize; otherwise it fails and says to use SVG). Returns the layout warnings too. Images cost tokens: render after a batch of edits, at the display size, to check overlapping or cut-off labels, a crowded legend and unreadable colours. |
| `check_chart_style` | Check the chart against the house style (`get_style` with `domain: "chart"`): runs the checks its profile turns on (`palette-only`, `distinguishable`, `min-contrast`, `allowed-type`). Returns `ok`, findings (severity, a sentence saying how to fix it, a `target` selection such as `{ kind: "series", seriesId }`, and the layer that asked), the checks that `ran` and those `skipped` with the reason. Run after a batch of edits and again after fixing. |
| `check_chart_colors` | Check the chart's series (or slice) colours, or a `colors` list, for normal vision, protanopia, deuteranopia and tritanopia, and contrast against `surface` (default white). Returns the closest pair per vision and problems as sentences. Run after any colour change. |
| `recommend_chart` | Ranked chart types with a reason each, from `csv` when given, else the current data (series count, points, dates, negative values). Use before choosing a type. |
| `get_chart_trendline` | Read a trendline's fit (`series`, `index`): coefficients, R2, equation and point count, or the moving-average points. Fails when the fit needs more or positive values. |
| `get_chart_race_ranking` | Read who leads a bar race at a moment (`time`: a category label or index, fractional between time points; default the moment shown): the top `raceTopN` with rank, series id and value. Read-only; use it to describe the race instead of rendering frames. |
| `list_chart_map_regions` | List the registered maps and the regions of one (default the chart's map) with the ids and names categories may use, plus which of the chart's categories matched a region and which did not. Call it before loading map data and after, to fix unmatched labels. |
| `list_chart_presets` | List the quick layouts (`standard`, `minimal`, `labelled`, `legend-right`, `presentation`, `analysis`) and colour schemes (such as `default`, `okabe-ito`, `office`, monochrome) with what each changes. |
| `export_chart_mermaid` | Get the chart as Mermaid for Markdown or chat: `xychart-beta`, `pie` or `radar-beta`, `sankey-beta` for Sankey diagrams with flows (title in frontmatter), `treemap-beta` for treemaps and sunbursts with their levels. With `meta` (default true) a `%% @pixerate` comment keeps everything Mermaid cannot express so `import_chart_mermaid` restores it exactly. |
| `export_chart_ooxml` | Get a DrawingML `c:chartSpace` part for Word or PowerPoint, plus sentences for anything that could not be written. |
| `list_open_files` | List the Office files the user opened (name, size in bytes). Only registered when the host shares open files; otherwise the file tools take the whole file as base64 `data`. |
| `list_file_charts` | List every chart in an `.xlsx`, `.pptx` or `.docx` (`file` name or base64 `data`) in file order: id (such as `chart-1`), place (sheet and anchor cell, or slide number), title, type, series names, category count, read problems, unsupported features and whether it reads losslessly. |
| `get_file_chart` | Return one file chart's full spec (`file` or `data`, `chartId` from `list_file_charts`) with its place and read problems, without touching the editor. Data comes from the chart's cached values, not the embedded workbook. |

### Write

Write tools are hidden while the chart is read-only. Each is one undo step and returns what
it changed.

| Tool | Use it to |
| --- | --- |
| `update_chart` | Change presentation in one all-or-nothing call: `type`, `title`, `subtitle`, `xAxis` / `yAxis` / `yAxis2` (show, title, min, max, step, gridlines, format, kind `"date"`, scale `"log"`, logBase, reverse), `legend` (show, position top / bottom / left / right), `stacking` (none / stacked / percent), `orientation`, `curve`, `points`, `dataLabels`, `labelPosition`, `palette`, `innerRadius` (donut hole, 0-0.9), `gapWidth`, `overlap`, `bins`, `showTotal`, `radarTicks` (radar ring count 1-50, null for round numbers), `radarGraticule` (radar rings as `polygon` or `circle`), `note` (footnote, "" for none), `highlight` (whole list of names), `referenceLines` / `referenceBands` (whole lists; prefer the add tools), `varyColors` (one colour per category on a one-series chart), `likertNeutral` (`split` / `separate`), `likertSort` (`none` / `positive` / `negative`), `parliamentArc` (90-360 degrees), `parliamentMajority` (seats, null for half plus one), `parliamentLabel` (caption under the total), `sunburstLabel` (caption under a sunburst's total), `sankeyLinkColor` (`source` / `target` / `gray`), `sankeyNodes` (node stacking order), `raceTopN` (bars per moment, 1-30), `map` (registered map id), `mapSteps` (2-9 equal colour classes), `mapThresholds` (ascending class breaks instead). Invalid values change nothing and come back as sentences. Returns the spec. |
| `set_chart_data` | Replace `categories` and / or all `series` (each with `name`, `values` and optional settings). Values are padded with gaps to the categories. Use for whole tables and for re-sorting. Returns the table and series ids. |
| `set_chart_values` | Set individual `cells` (`series`, `category`, `value`) all-or-nothing. Values may be numbers, numeric text (`"1,200"`, `"12%"`, `"$40"`, `"(3)"`) or `null` for a gap. Returns the stored values. Acted out with a cursor when the host has a director. |
| `add_chart_series` | Add a series (`name` required; `values`, `color`, `type` for a combo, `axis: "secondary"`, `x` / `sizes` for scatter and bubble, marker, format, error bars, `id`, `at`). Selects it and returns its id. |
| `update_chart_series` | Rename, recolour, hide, move to the secondary axis, change `type`, `marker`, `curve`, `dataLabels`, `format`, `x`, `sizes`, `pointColors`, `errorBars` / `xErrorBars` of one series; `null` resets a field. Values change with `set_chart_values`. |
| `remove_chart_series` | Delete a series and its values. Returns the remaining series ids. |
| `add_chart_category` | Insert a category (`label`, `at`; default the end) as a gap in every series. Returns its index; fill it with `set_chart_values`. |
| `remove_chart_category` | Delete a category (index or label) and its value in every series. |
| `import_chart_csv` | Replace the data with CSV or TSV text. Default: first row series names, first column categories (`seriesIn`, `header` change that). `chartType: "auto"` also picks the recommended type (two unlabelled numeric columns become a scatter). Returns the table, the type and cells that were not numbers. |
| `import_chart_mermaid` | Replace the chart with Mermaid `xychart-beta`, `pie`, `radar-beta`, `sankey-beta` (becomes flows) or `treemap-beta` (becomes grouped data: one level of sections is a treemap, deeper nesting a sunburst) text (fenced or bare). Unreadable lines are skipped and listed with line numbers. |
| `import_chart_ooxml` | Replace the chart with a raw Office chart part (`c:chartSpace` or chartex XML). Only listed when the host has a `DOMParser` (every browser does). Prefer `load_file_chart` when you have the whole file. |
| `load_file_chart` | Replace the editor's chart with one from an Office file (`file` or `data`, `chartId`). Returns the spec, read problems and the features the editor could not keep; tell the user about any. |
| `add_chart_trendline` | Fit a trendline to a series (`type`: linear, exponential, logarithmic, power, polynomial with `order` 2-6, moving-average with `period`; `forward` / `backward` in x units, `intercept`, `showEquation`, `showR2`). Unstacked bar, line, area, scatter and bubble charts only. Returns its index, coefficients, R2 and equation. |
| `remove_chart_trendline` | Delete a trendline by `series` and `index`. |
| `add_chart_reference_line` | Draw a dashed line across the plot at `value` (a target, floor or average) with an optional `label`, `color` and `axis` (`y` default, `y2` for the secondary axis, `x` for numeric x on scatter and bubble). Bar, line, area, scatter and bubble charts; the axis grows to keep it in view. Returns its `index`. |
| `update_chart_reference_line` | Change a reference line by `index` (from `add_chart_reference_line` or `spec.referenceLines`); `null` removes the label, colour or axis. Returns the line as stored. |
| `remove_chart_reference_line` | Delete a reference line by `index`; later ones move up. Returns the rest. |
| `add_chart_reference_band` | Shade a range from `from` to `to` (a target or normal range) under the data, with an optional `label`, `color` and `axis`. Same charts as reference lines. Returns its `index`. |
| `update_chart_reference_band` | Change a reference band by `index`; `null` removes the label, colour or axis. |
| `remove_chart_reference_band` | Delete a reference band by `index`. Returns the rest. |
| `set_chart_callout` | Pin a short `label` to one bar or point (`series`, `category`) with a leader line; `label: null` removes it. The point needs a value. Bar, line, area, scatter and bubble charts. Selects the point. |
| `highlight_chart` | Keep the named categories and series (`names`) bright and mute everything else; `[]` clears it. Unknown names change nothing and are listed. Returns the matched category indexes and series ids. |
| `set_chart_tree` | Replace the data with grouped data (`tree`: items `{name, value}`, groups `{name, children}`, up to 6 levels, sibling names unique) for grouped treemaps and sunbursts; `[]` goes back to plain data and keeps the totals. Returns the tree, group totals and depth. |
| `import_chart_tree_csv` | Replace the data with grouped data from CSV / TSV: names in every column but the last (group, ..., item), the value last; a blank group name repeats the one above. The quickest way to load a spreadsheet's hierarchy. |
| `add_chart_tree_node` | Add an item or a group (`node`) under the group at `parent` (a path; `[]` for the top level) at `at`. Returns its `path` and the parent's new total. |
| `update_chart_tree_node` | Rename a node, set an item's `value`, or set a node's `color` (null for the palette) by `path`. Groups have no value of their own. Returns the path (new after a rename). |
| `remove_chart_tree_node` | Delete a node and everything under it by `path`. Returns the group totals left. |
| `set_chart_links` | Replace the data with flows (`links`: `{source, target, value}`, value above 0, no loops, each pair once) for a Sankey diagram, and optionally the node stacking order (`nodes`); `[]` goes back to plain data. Returns the flows and each node's throughput. |
| `import_chart_links_csv` | Replace the data with flows from CSV / TSV rows of source, target, value (the Mermaid `sankey-beta` and spreadsheet layout). |
| `add_chart_link` | Add one flow (new names add nodes). Refused for a repeated pair or a loop. Returns its `index` and its two nodes' throughput. |
| `update_chart_link` | Change a flow's source, target, value or colour by `index` (from `spec.links`). |
| `remove_chart_link` | Delete a flow by `index`; nodes no flow uses any more go. Returns the flows left. |
| `set_chart_race_frame` | Show the bar race at a moment (`time`, or null for the last) and stop playback. View state, not an undo step. Returns the moment and the ranking shown. |
| `play_chart_race` | Start playing the race for the user from the moment shown, one time point every `msPerStep` ms; returns at once with the duration. |
| `apply_chart_preset` | Apply a quick `layout` and / or a `colors` scheme from `list_chart_presets` in one step. |
| `transpose_chart` | Swap series and categories. Drops per-series colours and settings, so restyle afterwards. |
| `select_chart_element` | Select part of the chart (`kind`: none, chart, title, subtitle, legend, axis, series, point, category, trendline) for the user to see or before `press_chart_key`. |
| `drag_chart_point` | Drag a bar or point as the mouse would, with the same snapping (`fine` = Alt, `lockAxis` = Shift on scatter). Positions are 0-1 fractions of the chart at `width` x `height`; use `render_chart` to find marks. Prefer `set_chart_values` for exact numbers. |
| `press_chart_key` | Send a key to the selection: ArrowLeft / ArrowRight move between categories, ArrowUp / ArrowDown change the value by a tenth of a tick (`shift` a whole tick, `alt` a hundredth), Delete / Backspace remove, Escape clears. |
| `undo_chart` | Undo the last chart edit. Returns the label of what was undone and the next undo. |
| `redo_chart` | Redo the last undone chart edit. |

### Save and open

The host may add the shared document tools (see `pixerate-agent-tools`). A chart document is the `ChartSpec`.

| Tool | Use |
| --- | --- |
| `get_chart_document` | Take a copy of the whole chart as `{ kind, formatVersion, revision, document }` before a risky rewrite, or to hand it on. To read the chart, use `get_chart`: it is smaller and says more. Refuses very large documents. |
| `load_chart_document` | Put back a copy from `get_chart_document` (its `document`, or the whole result). Checked first: when anything is wrong nothing changes and the error says what. One undo step (`undo_chart` brings the previous chart back). Every problem in the spec is refused, the same as `update_chart`; for data from a file use the import tools. |
| `save_chart_document` | Save the chart under a `name` in the host's storage (the same name replaces that copy). Returns the `key`. Only listed when the host has storage. Save when the user asks, not after every edit. |
| `list_saved_chart_documents` | List saved charts (`key`, `name`, `savedAt`), newest first. |
| `open_saved_chart_document` | Replace the chart with a saved one by `key`. One undo step. Ask before opening over changes the user has not saved. |

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
| `chart.addReferenceLine` | Add a reference line (as `add_chart_reference_line`). |
| `chart.updateReferenceLine` | Change a reference line by index. |
| `chart.removeReferenceLine` | Delete a reference line by index. |
| `chart.addReferenceBand` | Add a reference band (as `add_chart_reference_band`). |
| `chart.updateReferenceBand` | Change a reference band by index. |
| `chart.removeReferenceBand` | Delete a reference band by index. |
| `chart.setCallout` | Pin or remove a point's callout (as `set_chart_callout`). |
| `chart.highlight` | Highlight categories and series (as `highlight_chart`). |
| `chart.setTree` | Replace the grouped data (as `set_chart_tree`). |
| `chart.importTreeCsv` | Replace the data with grouped data from CSV / TSV. |
| `chart.addTreeNode` | Add an item or group; returns its path. |
| `chart.updateTreeNode` | Rename, revalue or recolour a node by path. |
| `chart.removeTreeNode` | Delete a node by path. |
| `chart.setLinks` | Replace the flows (as `set_chart_links`). |
| `chart.importLinksCsv` | Replace the data with flows from CSV / TSV. |
| `chart.addLink` | Add a flow; returns its index. |
| `chart.updateLink` | Change a flow by index. |
| `chart.removeLink` | Delete a flow by index. |
| `chart.mapRegions` | List a map's regions and the unmatched categories (as `list_chart_map_regions`). |
| `chart.raceRanking` | Read a bar race ranking (as `get_chart_race_ranking`). |
| `chart.setRaceFrame` | Show a bar race moment. |
| `chart.playRace` | Play the bar race. |
| `chart.pauseRace` | Pause bar race playback (the palette command people use; agents use `set_chart_race_frame`). |
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

- With agent playback on, value changes and selections are dragged by the chart's director, and other changes are clicked on the inspector option, data grid or toolbar they belong to. Results are unchanged.
- Series values are positional: one value per category, in category order. After
  `add_chart_category` or `remove_chart_category`, every series shifts with it.
- `set_chart_data` with only `series` keeps the categories; with only `categories` it keeps
  the series, whose values stay matched by position. Pass both to replace a table.
- Non-numeric cells are refused by `set_chart_values` ("Nothing was changed"); CSV import
  keeps going and lists them in `issues`. Check that list.
- Percent-stacked charts, pies and gaps cannot be dragged; use `set_chart_values`.
- Radar needs at least three categories (it draws as a line chart until then); trendlines
  are refused on stacked charts, pies and the other single-series families.
- Likert answers must be entered in order, most negative first: the chart puts the first
  half left of the centre line and colours them orange, the last half right in purple.
  Values are counts or shares; each question is scaled to its own total.
- A slope chart needs exactly two visible series; with one it draws a line chart (a
  `type-fallback` warning), and a third is not drawn. Hide the extra series or move them.
- Parliament seats are rounded to whole numbers; more than 2,000 seats are not drawn.
- While a chart has grouped data or flows, cell edits (`set_chart_values`, adding, renaming or deleting
  categories, `transpose_chart`) are refused, because the totals come from the tree or flows.
  Edit the nodes or flows, or replace the data (`set_chart_data`, `import_chart_csv`), which
  clears them.
- On a choropleth, a value is a shade, not a size: use it for rates and shares (per person,
  per cent), not raw totals, which make big countries look important. Say the unit in the
  title. Equal classes (`mapSteps`) suit evenly spread values; set `mapThresholds` for
  meaningful breaks (targets, round numbers) or skewed data. Regions without data are grey.
- Microstates (Malta, Luxembourg, Andorra, Monaco, San Marino, Liechtenstein, Vatican City)
  are drawn as markers so they can be seen and clicked.
- Office export has no maps: it writes the values as bars and says so.
- A bar race fills gaps with the last known value (0 before a name's first), and values and
  places ease between time points, so a name can sit between two places mid-swap. `render_chart`
  takes `time` to draw one moment. Office and Mermaid export cannot animate: they get every
  name at every time point as clustered bars.
- Sankey columns come from the flows: a node sits one column after the furthest node that
  flows into it, and nodes with no outgoing flow line up on the right. Within a column nodes
  stack in `sankeyNodes` order; if flows cross badly, reorder `sankeyNodes` (for instance,
  put the nodes the big flows join next to each other) and render again. Without flows a
  Sankey chart draws its table as bars (a `type-fallback` warning).
- Highlighting a Sankey node keeps every flow into or out of it bright.
- Highlight, selection and colours work per top-level group: every item in a group selects
  and highlights that group. Give a node its own `color` with `update_chart_tree_node`.
- Office export writes a grouped treemap or sunburst as a pie or doughnut of the group totals
  (DrawingML has no hierarchy); Office chartex imports keep the levels.
- Reference lines, bands and callouts are drawn on bar, line, area, scatter and bubble
  charts only. Switching to another type keeps them in the spec but leaves them out of the
  drawing (an `annotations-skipped` warning says so); they come back when you switch back.
- Reference values on a log axis must be above 0, and `axis: "y2"` needs a visible series on
  the secondary axis. A line outside a fixed `min` / `max` is not drawn.
- Callouts and highlight names follow the data: removing a category drops its callouts and
  its highlight entry, renaming a category or series keeps it highlighted.
- Mermaid `treemap-beta` names cannot hold both kinds of quote and `sankey-beta` has no
  colours or node order; keep the `%% @pixerate` comment (`meta`, the default) when the text
  comes back to a Pixerate editor, and it restores them exactly.
- Office export has no reference lines, bands, callouts, highlight or note; `export_chart_ooxml`
  lists them as not written. `varyColors` is kept.
- Radar `radarTicks` and `radarGraticule` are Mermaid's `ticks` and `graticule`. A
  `radar-beta` block with no `graticule` line imports as `circle`, because that is what
  Mermaid draws; set `radarGraticule: "polygon"` if the user wants the editor's default look.
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
