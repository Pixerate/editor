# Chart editor

`@pixerate/editor/chart` is a headless chart editor. A chart is a plain JSON `ChartSpec` (data plus presentation); a DOM-free layout engine turns it into drawing primitives; a controller edits it with validation and undo. React (`@pixerate/editor-react/chart`) and Svelte (`@pixerate/editor-svelte/chart`) add the same hooks / runes and components. The core entry has no third-party imports.

## Spec

```ts
import { createChartSpec, normalizeChartSpec } from "@pixerate/editor/chart";

const spec = createChartSpec({
  type: "bar", // bar · line · area · scatter · pie · donut
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
- `normalizeChartSpec(input)` checks everything and returns `{ spec, issues }`: problems become sentences (`type must be one of "bar", …; got "radar".`) and are replaced by defaults, so the result always draws. Series values are padded or trimmed to the categories, and duplicate series ids are renamed.
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
