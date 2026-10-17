# Chart editor

`@pixerate/editor/chart` is a headless chart editor. A chart is a plain JSON `ChartSpec` (data plus presentation); a DOM-free layout engine turns it into drawing primitives; a controller edits it with validation and undo. React (`@pixerate/editor-react/chart`) and Svelte (`@pixerate/editor-svelte/chart`) add the same hooks / runes and components. The core entry has no third-party imports.

## Spec

```ts
import { createChartSpec, normalizeChartSpec } from "@pixerate/editor/chart";

const spec = createChartSpec({
  type: "bar", // bar · line · area · scatter · bubble · pie · donut · radar · waterfall · histogram · box · funnel · treemap
  title: "Quarterly revenue",
  categories: ["Q1", "Q2", "Q3", "Q4"],
  series: [
    { id: "na", name: "North America", values: [42, 48, 51, 60] },
    { id: "eu", name: "Europe", values: [31, null, 35, 41] }, // null is a gap
    { id: "target", name: "Target", values: [90, 95, 105, 120], type: "line" }, // a combo series
  ],
  stacking: "none", // none · stacked · percent
  yAxis: { format: { style: "currency", currency: "USD" } },
});
```

- `xAxis` is always the category axis and `yAxis` the value axis, whatever the orientation. Horizontal bars (`orientation: "horizontal"`) draw categories down the left and values along the bottom.
- Pies and donuts draw the first visible series, one slice per category; the legend lists categories.
- Bars and areas stack separately; lines and scatter series are never stacked. `percent` scales each category's stack to 100% (dragging is disabled there, since values are shown as shares).
- `normalizeChartSpec(input)` checks everything and returns `{ spec, issues }`: problems become sentences (`type must be one of "bar", …; got "gauge".`) and are replaced by defaults, so the result always draws. Series values are padded or trimmed to the categories, and duplicate series ids are renamed.
- `parseChartValue` reads numbers the way people type them: `1,234.5`, `12%` (0.12), `$40`, `(3)` (−3), blank for a gap.

## Layout and rendering

```ts
import { layoutChart, chartToSvg } from "@pixerate/editor/chart";

const scene = layoutChart(spec, { width: 640, height: 400, selection: { kind: "series", seriesId: "eu" } });
// scene.marks: rect / path / circle / line / text primitives in draw order,
// each with a `role` ("bar", "tick-label", …) and, when clickable, the `target` it selects.

const svg = chartToSvg(spec, { width: 800, height: 450 }); // standalone SVG string, no selection outlines
```

`layoutChart` is pure: the same spec and size give the same scene, in a browser, Node.js or a worker. Text widths are estimated from character counts; pass `measureText(text, size, weight)` (for example with a canvas 2D context) for exact fits. `theme` sets colours and type; the framework canvases use `CSS_VARIABLE_CHART_THEME`, which reads `--foreground`, `--muted-foreground`, `--border`, `--background` and `--primary` (full colours, with light fallbacks). Set `surface` to the page colour when `background` is transparent: it fills hollow points and separates slices.

## Controller

```ts
import { ChartController } from "@pixerate/editor/chart";

const chart = new ChartController({ spec });

chart.update({ type: "line", curve: "smooth", legend: { position: "right" } }); // all-or-nothing
chart.setAxis("y", { min: 0, title: "Revenue" });
chart.setValue("eu", 1, "29,800");          // one undo step
chart.addSeries({ name: "APAC", values: [18, 22] });
chart.pasteCells(0, -1, "Q1\t1\t2\nQ2\t3\t4"); // grid paste: column -1 is the category column
chart.importCsv("Month,Coffee,Tea\nJan,120,80");

chart.select({ kind: "point", seriesId: "eu", index: 1 });
chart.deleteSelection(); // point → gap, series / category → removed, title → cleared, legend / axis → hidden

chart.undo();
const saved = chart.toJSON();
chart.load(saved, { clearHistory: true });
```

- `getState()` returns the same object until something changes (`spec`, `selection`, `selectedSeries`, `selectedIndex`, `issues`, `canUndo`, `undoLabel`, …), so it works with `useSyncExternalStore` and Svelte runes.
- Rejected edits change nothing, return `{ ok: false, message, issues }` and show the problems in `state.issues` until the next successful edit.
- Pass `history` to record into a `HistoryManager` shared with the rest of the app. `beginGesture(key)` / `endGesture()` merge a drag into one undo step.
- `load` does not record an undo step. Pass `clearHistory: true` when it replaces the whole chart (opening a document), or an undo would bring back the chart from before the load.

## Interaction

The canvases share these helpers, so pointer and keyboard behaviour is the same everywhere:

- `startChartPointDrag(controller, scene, target, point)` starts dragging a bar or point; `move(point)` follows the pointer along the value axis, snapped to a tenth of the tick step, and `end()` closes the undo step. The value changes by the distance moved, so stacked bars work too.
- `handleChartKey(controller, scene, event)`: ← → move a point or category selection, ↑ ↓ change the value (Shift: a whole tick step), Delete / Backspace delete the selection, Escape clears it.
- `chartClientToScene(scene, rect, clientX, clientY)` maps pointer coordinates into the scene; `describeChartSelection` gives a readout for toolbars and screen readers.

## React and Svelte

```tsx
import { ChartEditor, useChartController, useChartCommands } from "@pixerate/editor-react/chart";

function Revenue() {
  const controller = useChartController({ spec });
  useChartCommands(registry, controller); // chart.* palette / agent commands while mounted
  return <ChartEditor controller={controller} height={400} />;
}
```

```svelte
<script lang="ts">
  import { ChartController } from "@pixerate/editor/chart";
  import { ChartEditor, useChartCommands } from "@pixerate/editor-svelte/chart";

  const controller = new ChartController({ spec });
  useChartCommands(registry, controller);
</script>

<ChartEditor {controller} height={400} />
```

`ChartEditor` combines a toolbar (undo, redo, selection readout), `ChartCanvas`, `ChartInspector` and `ChartDataGrid`; each is also exported on its own. `ChartCanvas` follows its container's width (`responsive={false}` for a fixed `width`) and takes `editable={false}` for a read-only chart. `ChartInspector` takes `sections` to show only some of `type`, `titles`, `options`, `legend`, `axes` and `series`. `useChartEditor` / `createChartEditor` expose the state with bound actions.

## Agent commands

`createChartCommands(controller, { prefix })` returns `CommandSpec`s for a `CommandRegistry`: `chart.describe` (spec plus a data table), `chart.update`, `chart.setData`, `chart.setValues` (series by id or name, category by index or label), `chart.addSeries`, `chart.updateSeries`, `chart.removeSeries`, `chart.addCategory`, `chart.removeCategory`, `chart.importCsv`, `chart.exportSvg`, `chart.undo` and `chart.redo`. Parameters are JSON Schema; failures throw sentences, which the registry returns as `{ ok: false, code: "failed", message }`.

## Chart types

| Type | Data | Notes |
| --- | --- | --- |
| `bar`, `line`, `area`, `scatter` | one value per category per series | combos via `series.type`; `series.axis: "secondary"` uses `yAxis2` on the right (top for horizontal bars) |
| `scatter` with `series.x`, `bubble` | `x`, `values` (y) and `sizes` per category | numeric x axis (`xAxis` min / max / step / format); bubble area ∝ size |
| `pie`, `donut`, `funnel`, `treemap` | the first visible series, one item per category | colours per category; `pointColors` overrides |
| `radar` | one spoke per category, one polygon per series | needs 3 categories (draws as a line chart until then) |
| `waterfall` | the first series as increases / decreases | categories labelled "total" / "subtotal" are running totals; `showTotal` appends one |
| `histogram` | every value of the visible series | `bins` (default √n, 1–100); right-inclusive bins |
| `box` | one box per visible series | Tukey whiskers (1.5 × IQR), outliers, mean ✕ |

Other spec fields: `xAxis.kind: "date"` (categories read as dates, labelled with calendar steps that fit), `axis.step` (fixed tick distance), `format.code` (spreadsheet codes such as `#,##0.0,,"M"`, using the spreadsheet's own format engine), `gapWidth` / `overlap` (bar spacing), `labelPosition` (`auto` drops labels that do not fit and picks dark or white text by contrast), and per series `marker`, `curve`, `dataLabels`, `format`, `pointColors` and `trendlines`.

## Trendlines

```ts
chart.addTrendline("sales", { type: "polynomial", order: 2, forward: 2, showEquation: true, showR2: true });
chart.trendlineFit("sales", 0); // { coefficients, r2, equation, points, evaluate(x) }
```

Linear, exponential, logarithmic, power, polynomial (2–6) and moving-average fits, as spreadsheets compute them. Category charts fit against x = 1, 2, 3, …. Trendlines need an unstacked bar, line, area, scatter or bubble chart.

## Layout warnings, summaries and accessibility

`layoutChart` returns `scene.warnings` for anything it had to leave out (hidden or shortened labels, a truncated legend, thinned lines, skipped non-finite values). `summarizeChart(spec, size)` adds per-series min / max / mean / trend, the axes as drawn, a colour check and `describeChart`'s plain-language description, which `chartToSvg` also writes as `<desc>`. `checkChartColors` tests a palette with normal vision and three colour-vision deficiencies. `CHART_LAYOUT_PRESETS` and `CHART_COLOR_SCHEMES` (including monochrome and Okabe–Ito) apply through `applyPreset`.

## Mermaid and Office files

```ts
const text = chartToMermaid(spec); // xychart-beta, pie or radar-beta + one "%% @pixerate {…}" comment
const { spec, issues } = chartFromMermaid(text); // issues carry 1-based line numbers; never throws
findMermaidCharts(markdownOrChat); // fenced or bare charts

const { xml, issues } = chartToOoxml(spec); // c:chartSpace with literal data
const { spec, unsupported, lossless } = chartFromOoxml(xml, { DOMParser }); // also chartex parts
```

The comment keeps what Mermaid cannot express, so text round-trips exactly while any Mermaid renderer still draws the basic chart. DOCX imports return embedded charts in `DocumentImport.charts` and write each as a `<div data-type="chart">` holding its spec: a live chart in editors with the chart node (below), otherwise a caption and a data table (see GOTCHAS for why not an SVG image).

### Charts in Excel, PowerPoint and Word files

`extractOfficeCharts(bytes, { DOMParser })` opens an `.xlsx`, `.pptx` or `.docx` file with the built-in ZIP reader, works out which it is from the main part, and reads every chart with `chartFromOoxml` (DrawingML and Office 2016 chartex). `extractXlsxCharts`, `extractPptxCharts` and `extractDocxCharts` do the same but throw when the file is the wrong kind.

```ts
import { extractOfficeCharts, describeOfficeChartPlace } from "@pixerate/editor/chart";

const { format, charts } = await extractOfficeCharts(await file.arrayBuffer());
for (const chart of charts) {
  // chart-1 · Sales!B2 · bar · "Revenue"  (xlsx: sheet, anchor "B2", range "B2:H18"; pptx: slide 3)
  console.log(chart.id, describeOfficeChartPlace(chart), chart.spec.type, chart.title, chart.unsupported, chart.lossless);
}
controller.load(charts[0].spec);
```

- **Excel**: each sheet's `<drawing r:id>` → `xl/drawings/drawingN.xml` → `c:chart` / `cx:chart r:id` → `xl/charts/chartN.xml`. Charts carry the sheet name, the anchor cell of the `xdr:from` marker and, for two-cell anchors, the covered range. Chart sheets have a sheet name but no anchor.
- **PowerPoint**: slides in `p:sldIdLst` order (not part-name order) → `p:graphicFrame` → chart part, with the 1-based slide number.
- **Word**: charts in the body, the same ones `docxImportAdapter` returns in `DocumentImport.charts`.

Data comes from the cached values in the chart part; the embedded workbook is not read. There is no `.xlsx` cell import yet, so charts are not attached to a spreadsheet import result.

For agents, `createOfficeChartToolProvider({ files, controller, readOnly })` registers `list_open_files` (with `files`), `list_file_charts`, `get_file_chart` and, with a `controller`, `load_file_chart` (one undo step, hidden while read-only). With `files` the tools take an open file's `name`; without it they take the file as base64 `data`. React and Svelte register it with `useOfficeChartToolProvider(registry, options)`.

## Charts in documents

`createRichTextPreset({ chart: true })` adds a `chart` block node and an inline `sparkline` node to the rich-text editor (`chart: { sparkline: false }` leaves the sparkline out).

```ts
import { createRichTextPreset, getDocumentCharts } from "@pixerate/editor";
import { createReactChartNodeView } from "@pixerate/editor-react"; // or createSvelteChartNodeView from @pixerate/editor-svelte

const extensions = createRichTextPreset({ chart: { nodeView: createReactChartNodeView() } });
editor.commands.insertChart({ spec: { type: "bar", categories: ["Q1", "Q2"], series: [{ name: "Sales", values: [3, 5] }] }, height: 280 });
editor.commands.updateChart(id, { spec: nextSpec });
editor.commands.insertSparkline({ values: [3, 5, 4, 8], kind: "line" });
getDocumentCharts(editor.state.doc); // [{ id, pos, node, spec }]
```

- **Attributes**: `id` (unique; copies and imports get fresh ids), `spec` (a normalized `ChartSpec`), `width` (`null` fills the line) and `height` (default 320).
- **HTML**: `<div data-type="chart" data-chart="{…}" data-chart-id data-width data-height>` with a static SVG inside (drawn with `chartSceneToDomSpec` in `DEFAULT_CHART_THEME`, or the node's `theme` option), so exported HTML shows the chart without script. Parsing reads `data-chart`; a missing or broken spec keeps the div's fallback content.
- **Markdown**: a ` ```mermaid ` block from `chartToMermaid` (the fence grows past any backticks in the text). `xychart-beta`, `pie` and `radar-beta` blocks parse back into charts, including hand-written ones; other Mermaid diagrams stay code blocks. Sparklines are written as their `<span data-type="sparkline">`, which the markdown sanitizer allows.
- **Plain text**: `[Chart: title]`, and a sparkline's label.
- **In the editor**: the node view (`ChartNodeView` in core, mounted by `createReactChartNodeView` or `createSvelteChartNodeView`) draws `<ChartCanvas>` read-only. A click selects the chart and opens it for editing: the canvas becomes interactive, the data grid and the inspector open in a panel below it (side by side when the document is wide enough). Every edit is a document transaction (drags once they end), so the editor's undo covers them; undo, `updateChart` and agent edits load back into the canvas. Done, Escape or moving the selection closes it; a read-only editor never opens it. Without a `nodeView`, the editor shows the static SVG. The React view renders in its own root, so React context does not reach it.
- **Agents**: `createRichTextToolProvider` adds `list_document_charts` (always), and `insert_chart`, `update_chart_in_document` (by `chartId` or `pos`; fields merge into the spec, axes and legend field by field, given series replace all) and `insert_sparkline` while the editor is editable. Invalid input changes nothing and comes back as sentences; each call is one undo step.
- **DOCX**: imported charts become chart nodes when the schema has the node; otherwise they stay a caption and a table. `exportDocx` writes chart nodes back as native Word charts (`word/charts/chartN.xml`, sized from the node; no width = the page text width) and sparklines as text (their label, or `▁▅█` bars).

## Streaming, agent cursors and sparklines

- `ChartStream` reads Mermaid or JSON that is still arriving; the axis only grows until `complete`. `<ChartStreamingView source complete />` (React and Svelte) tweens between layouts with `blendChartScenes`.
- `ChartDirector` acts agent commands out on the canvas: a cursor (from `ChartPresence`, drawn by `ChartCanvas`'s `presence` prop) moves to a bar, drags it to the new value and the call commits as one undo step. `useChartDirector` (React) / `createChartDirector` (Svelte) wire it up; pass `director` to the tool provider to animate `set_chart_values` and `select_chart_element`.
- `layoutSparkline` / `<ChartSparkline>` draw word-sized line, column and win/loss charts.

## Interaction

Drags snap to nearby values (zero, the start value, other series at the category, neighbours, ticks) within 6 px, then to a tenth of a tick. `move(point, { fine, lockAxis, noSnap })` maps to Alt, Shift and Ctrl / ⌘ in the canvases; `cancel()` (Escape) takes the drag back with no undo step. Scatter charts with x values drag in both directions. `chartHitTest` finds the mark under a point for hosts without DOM events.

## Agent tools

`createChartToolProvider(controller, { readOnly, director, rasterize, DOMParser })` registers 28 tools, one per operation: `get_chart`, `render_chart`, `check_chart_colors`, `recommend_chart`, `get_chart_trendline`, `list_chart_presets`, `export_chart_mermaid`, `export_chart_ooxml`, `update_chart`, `set_chart_data`, `set_chart_values`, `add_chart_series`, `update_chart_series`, `remove_chart_series`, `add_chart_category`, `remove_chart_category`, `import_chart_csv` (with `chartType: "auto"`), `import_chart_mermaid`, `import_chart_ooxml`, `add_chart_trendline`, `remove_chart_trendline`, `apply_chart_preset`, `transpose_chart`, `select_chart_element`, `drag_chart_point` and `press_chart_key` (through the same code as the pointer and keyboard), `undo_chart` and `redo_chart`. Write tools are hidden while `readOnly` is set, and `get_chart` says why.

### PNG previews

`render_chart` returns SVG text by default and, with `format: "png"`, an image block plus a text block with the layout warnings (also in `structuredContent.warnings`). Its description tells the model that an image costs tokens and is for checking what text cannot show (overlapping or cut-off labels, a crowded legend, colours). PNG needs a `rasterize(svg, { width, height })` option; the React and Svelte `useChartToolProvider` pass `createChartRasterizer()` in the browser (pass `rasterize: false` to turn PNG off, or your own function, e.g. resvg on a server).

```ts
import { rasterizeChartSvg, downloadChartPng, chartToSvg } from '@pixerate/editor/chart';

const svg = chartToSvg(spec, { width: 640, height: 400 });
const { data, mimeType, width, height } = await rasterizeChartSvg(svg, { width: 640, height: 400 }); // base64 PNG, 1024 × 640
await downloadChartPng(spec, { width: 800, height: 450, filename: 'revenue.png' });
```

`rasterizeChartSvg(svg, { width, height, scale = 2, maxSize = 1024, background = '#ffffff', scope })` first runs `resolveChartSvgPaints`: `var(--x, fallback)` becomes the variable's value on `scope` (default the root element), `currentColor` its colour and `font-family="inherit"` its font. An SVG drawn through an `<img>` or canvas does not see the page's CSS, so without this step a chart laid out with `CSS_VARIABLE_CHART_THEME` (what the canvases use) draws its text and grid black. It then draws through an `Image` onto a canvas (longest side ≤ `maxSize`) and throws a message saying what to do instead when there is no DOM or 2D canvas. `<ChartEditor>`'s toolbar has a Download PNG button (`pngOptions` sets size, theme, scale and file name).

For several commands at once, `run_commands` accepts `"$0.id"` / `"$last.path"` references to earlier results and `atomic: true` (one undo step, all or nothing) when the registry shares a `history` with the controllers.
