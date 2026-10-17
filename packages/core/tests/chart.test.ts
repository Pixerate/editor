import { describe, it, expect, vi } from "vitest";
import { CommandRegistry } from "../src/commands";
import { HistoryManager } from "../src/history";
import {
  ChartController,
  chartDataFromTable,
  chartDataToTable,
  chartSceneToSvg,
  chartToSvg,
  chartValueAtPoint,
  createChartCommands,
  createChartSpec,
  formatChartNumber,
  layoutChart,
  niceScale,
  normalizeChartSpec,
  parseChartValue,
  sameChartSelection,
  snapChartValue,
  chartClientToScene,
  chartColorInputValue,
  describeChartSelection,
  handleChartKey,
  startChartPointDrag,
  type ChartMark,
  type ChartScene,
  type ChartSpec,
} from "../src/chart";

const sales: Partial<ChartSpec> = {
  title: "Quarterly sales",
  categories: ["Q1", "Q2", "Q3", "Q4"],
  series: [
    { id: "north", name: "North", values: [12, 18, 9, 22] },
    { id: "south", name: "South", values: [8, 11, 14, 10] },
  ],
};

const byRole = (scene: ChartScene, role: ChartMark["role"]) => scene.marks.filter((m) => m.role === role);
const layout = (spec: Partial<ChartSpec>, selection: any = null) => layoutChart(createChartSpec(spec), { width: 640, height: 400, selection });

describe("chart values and formatting", () => {
  it("parses numbers the way people type them", () => {
    expect(parseChartValue("1,234.5")).toBe(1234.5);
    expect(parseChartValue("12%")).toBe(0.12);
    expect(parseChartValue("$40")).toBe(40);
    expect(parseChartValue("(3)")).toBe(-3);
    expect(parseChartValue("  ")).toBeNull();
    expect(parseChartValue(null)).toBeNull();
    expect(parseChartValue("abc")).toBeUndefined();
    expect(parseChartValue(Infinity)).toBeUndefined();
  });

  it("picks nice ticks and keeps fixed bounds", () => {
    expect(niceScale(0, 22, 5)).toMatchObject({ min: 0, max: 25, step: 5, ticks: [0, 5, 10, 15, 20, 25] });
    expect(niceScale(0.1, 0.34, 5).ticks).toEqual([0.1, 0.15, 0.2, 0.25, 0.3, 0.35]);
    const fixed = niceScale(3, 97, 5, 0, 100);
    expect([fixed.min, fixed.max]).toEqual([0, 100]);
    expect(fixed.ticks[0]).toBe(0);
    // A flat series still gets a range.
    expect(niceScale(5, 5, 5).max).toBeGreaterThan(5);
    expect(niceScale(0, 0, 5)).toMatchObject({ min: 0, max: 1 });
  });

  it("formats numbers locale-independently", () => {
    expect(formatChartNumber(1234567)).toBe("1,234,567");
    expect(formatChartNumber(0.25, { style: "percent" })).toBe("25%");
    expect(formatChartNumber(1500, { style: "compact" })).toBe("1.5K");
    expect(formatChartNumber(2_000_000, { style: "compact" })).toBe("2M");
    expect(formatChartNumber(-12.5, { style: "currency", currency: "EUR" })).toBe("-€12.50");
    expect(formatChartNumber(3, { prefix: "~", suffix: " kg", decimals: 1 })).toBe("~3.0 kg");
    expect(formatChartNumber(null)).toBe("");
  });
});

describe("chart spec", () => {
  it("fills defaults and pads values to the categories", () => {
    const { spec, issues } = normalizeChartSpec({ categories: ["a", "b", "c"], series: [{ name: "S", values: [1] }] });
    expect(issues).toEqual([]);
    expect(spec.type).toBe("bar");
    expect(spec.series[0]).toMatchObject({ id: "series-1", values: [1, null, null] });
    expect(spec.yAxis.gridlines).toBe(true);
    expect(spec.legend).toEqual({ show: true, position: "bottom" });
  });

  it("reports bad input as sentences and still returns a drawable spec", () => {
    const { spec, issues } = normalizeChartSpec({
      type: "radar",
      categories: ["a"],
      series: [{ id: "x", name: "A", values: ["oops"] }, { id: "x", name: "B", values: [2] }],
      yAxis: { min: 10, max: 5 },
    });
    expect(spec.type).toBe("bar");
    expect(spec.series.map((s) => s.id)).toEqual(["x", "series-2"]);
    expect(spec.series[0].values).toEqual([null]);
    expect(issues.map((i) => i.path)).toEqual(["type", "series[0].values[0]", "series[1].id", "yAxis.max"]);
    expect(issues[0].message).toMatch(/type must be one of "bar"/);
  });

  it("reads tables with series in columns or rows and writes them back", () => {
    const rows = [
      ["Month", "Apples", "Pears"],
      ["Jan", "3", "1,200"],
      ["Feb", "", "x"],
    ];
    const data = chartDataFromTable(rows);
    expect(data.categories).toEqual(["Jan", "Feb"]);
    expect(data.series.map((s) => [s.name, s.values])).toEqual([
      ["Apples", [3, null]],
      ["Pears", [1200, null]],
    ]);
    expect(data.issues).toHaveLength(1);
    const transposed = chartDataFromTable(
      [
        ["", "Jan", "Feb"],
        ["Apples", 3, 4],
      ],
      { seriesIn: "rows" },
    );
    expect(transposed.categories).toEqual(["Jan", "Feb"]);
    expect(transposed.series[0]).toMatchObject({ name: "Apples", values: [3, 4] });
    expect(chartDataToTable(createChartSpec(sales))[1]).toEqual(["Q1", 12, 8]);
  });
});

describe("layoutChart", () => {
  it("draws grouped bars with clickable point targets", () => {
    const scene = layout(sales);
    const bars = byRole(scene, "bar");
    expect(bars).toHaveLength(8);
    expect(bars[0].target).toEqual({ kind: "point", seriesId: "north", index: 0 });
    expect(byRole(scene, "title")[0]).toMatchObject({ text: "Quarterly sales" });
    expect(byRole(scene, "legend-label").map((m: any) => m.text)).toEqual(["North", "South"]);
    expect(scene.valueScale).toMatchObject({ axis: "y", domain: [0, 25] });
    // Taller bars for bigger values, all inside the plot.
    const q4 = bars.find((b) => b.key === "bar-north-3") as any;
    const q3 = bars.find((b) => b.key === "bar-north-2") as any;
    expect(q4.height).toBeGreaterThan(q3.height);
    for (const b of bars as any[]) {
      expect(b.y).toBeGreaterThanOrEqual(scene.plot.y - 0.01);
      expect(b.y + b.height).toBeLessThanOrEqual(scene.plot.y + scene.plot.height + 0.01);
    }
  });

  it("stacks bars and scales percent stacks to 100%", () => {
    const stacked = layout({ ...sales, stacking: "stacked" });
    expect(stacked.valueScale!.domain[1]).toBeGreaterThanOrEqual(32);
    const percent = layout({ ...sales, stacking: "percent" });
    expect(percent.valueScale!.domain).toEqual([0, 1]);
    expect(percent.percent).toBe(true);
    expect(byRole(percent, "tick-label").some((m: any) => m.text === "100%")).toBe(true);
    expect(chartValueAtPoint(percent, { x: 0, y: 100 })).toBeUndefined();
  });

  it("draws horizontal bars along x", () => {
    const scene = layout({ ...sales, orientation: "horizontal" });
    expect(scene.valueScale!.axis).toBe("x");
    const bar = byRole(scene, "bar")[0] as any;
    expect(bar.width).toBeGreaterThan(bar.height / 4);
  });

  it("draws lines with gaps, smooth curves, points and areas", () => {
    const line = layout({ ...sales, type: "line", series: [{ id: "a", name: "A", values: [1, null, 3, 4] }] });
    const path = byRole(line, "line")[0] as any;
    expect(path.d.match(/M/g)).toHaveLength(2);
    expect(byRole(line, "point")).toHaveLength(3);
    const smooth = layout({ ...sales, type: "line", curve: "smooth" });
    expect((byRole(smooth, "line")[0] as any).d).toContain("C");
    const area = layout({ ...sales, type: "area", stacking: "stacked" });
    expect(byRole(area, "area")).toHaveLength(2);
    expect((byRole(area, "area")[0] as any).d).toMatch(/Z$/);
  });

  it("mixes series types in a combo chart", () => {
    const scene = layout({ ...sales, series: [sales.series![0], { ...sales.series![1], type: "line" }] });
    expect(byRole(scene, "bar")).toHaveLength(4);
    expect(byRole(scene, "line")).toHaveLength(1);
  });

  it("draws pies and donuts by category with percentage labels", () => {
    const pie = layout({ ...sales, type: "donut", dataLabels: true });
    const slices = byRole(pie, "slice");
    expect(slices).toHaveLength(4);
    expect(slices[0].target).toEqual({ kind: "point", seriesId: "north", index: 0 });
    expect(byRole(pie, "data-label").map((m: any) => m.text)).toContain("20%");
    expect(byRole(pie, "legend-label").map((m: any) => m.text)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(pie.valueScale).toBeUndefined();
  });

  it("marks the selection and outlines it", () => {
    const point = layout(sales, { kind: "point", seriesId: "south", index: 1 });
    expect(point.marks.find((m) => m.key === "bar-south-1")!.selected).toBe(true);
    expect(byRole(point, "selection")).toHaveLength(1);
    const series = layout({ ...sales, type: "line" }, { kind: "series", seriesId: "north" });
    expect((series.marks.find((m) => m.key === "line-north") as any).strokeWidth).toBeGreaterThan(2);
    expect(byRole(layout(sales, { kind: "title" }), "selection")).toHaveLength(1);
  });

  it("shows a message when there is nothing to draw and skips hidden series", () => {
    expect(byRole(layout({}), "empty")[0]).toMatchObject({ text: "No data" });
    const hidden = layout({ ...sales, series: [sales.series![0], { ...sales.series![1], hidden: true }] });
    expect(byRole(hidden, "bar")).toHaveLength(4);
    expect(byRole(hidden, "legend-label")[1].opacity).toBe(0.4);
  });

  it("maps scene points back to values and snaps them", () => {
    const scene = layout(sales);
    const { range, domain } = scene.valueScale!;
    expect(chartValueAtPoint(scene, { x: 0, y: range[0] })).toBeCloseTo(domain[0]);
    expect(chartValueAtPoint(scene, { x: 0, y: range[1] })).toBeCloseTo(domain[1]);
    expect(snapChartValue(scene, 12.26)).toBe(12.5);
  });

  it("writes standalone SVG without selection outlines", () => {
    const svg = chartToSvg(createChartSpec({ ...sales, title: "A < B" }), { width: 320, height: 200 });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"')).toBe(true);
    expect(svg).toContain("A &lt; B");
    expect(svg).toContain('aria-label="A &lt; B"');
    const scene = layout(sales, { kind: "title" });
    expect(chartSceneToSvg(scene)).not.toContain('data-role="selection"');
    expect(chartSceneToSvg(scene, { hideSelection: false })).toContain('data-role="selection"');
  });

  it("compares selections", () => {
    expect(sameChartSelection({ kind: "point", seriesId: "a", index: 1 }, { kind: "point", seriesId: "a", index: 1 })).toBe(true);
    expect(sameChartSelection({ kind: "axis", axis: "x" }, { kind: "axis", axis: "y" })).toBe(false);
    expect(sameChartSelection(null, { kind: "chart" })).toBe(false);
  });
});

describe("ChartController", () => {
  it("keeps a stable state snapshot and notifies on change", () => {
    const onChange = vi.fn();
    const c = new ChartController({ spec: sales, onChange });
    const listener = vi.fn();
    c.subscribe(listener);
    const first = c.getState();
    expect(c.getState()).toBe(first);
    c.setTitle("Revenue");
    expect(c.getState()).not.toBe(first);
    expect(c.getState().spec.title).toBe("Revenue");
    expect(listener).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ title: "Revenue" }));
  });

  it("edits values with validation and undo", () => {
    const c = new ChartController({ spec: sales });
    expect(c.setValue("north", 1, "1,000")).toEqual({ ok: true });
    expect(c.getSpec().series[0].values[1]).toBe(1000);
    expect(c.getState().undoLabel).toBe("Edit North · Q2");
    const bad = c.setValue("north", 1, "lots");
    expect(bad.ok).toBe(false);
    expect(c.getState().issues[0].message).toMatch(/not a number/);
    expect(c.getSpec().series[0].values[1]).toBe(1000);
    expect(c.setValue("east", 0, 1)).toMatchObject({ ok: false, message: expect.stringMatching(/no series "east"; expected one of "north", "south"/) });
    expect(c.setValue("north", 9, 1)).toMatchObject({ ok: false, message: expect.stringMatching(/out of range/) });
    c.undo();
    expect(c.getSpec().series[0].values[1]).toBe(18);
    c.redo();
    expect(c.getSpec().series[0].values[1]).toBe(1000);
  });

  it("merges a drag into one undo step", () => {
    const c = new ChartController({ spec: sales });
    c.beginGesture("drag:north:0");
    expect(c.getState().gesture).toBe("drag:north:0");
    c.setValue("north", 0, 13);
    c.setValue("north", 0, 14);
    c.setValue("north", 0, 15);
    c.endGesture();
    expect(c.getSpec().series[0].values[0]).toBe(15);
    c.undo();
    expect(c.getSpec().series[0].values[0]).toBe(12);
    expect(c.getState().canUndo).toBe(false);
  });

  it("updates presentation all-or-nothing", () => {
    const c = new ChartController({ spec: sales });
    expect(c.update({ type: "line", legend: { position: "right" }, yAxis: { title: "Units" } })).toEqual({ ok: true });
    expect(c.getSpec()).toMatchObject({ type: "line", legend: { show: true, position: "right" }, yAxis: { title: "Units", gridlines: true } });
    const bad = c.update({ stacking: "sideways" as any, title: "Nope" });
    expect(bad.ok).toBe(false);
    expect(c.getSpec().title).toBe("Quarterly sales");
    expect(c.getState().issues[0].path).toBe("stacking");
    // No-op edits record nothing.
    const depth = c.history.getState().undoCount;
    c.setType("line");
    expect(c.history.getState().undoCount).toBe(depth);
  });

  it("adds, changes, reorders and removes series", () => {
    const c = new ChartController({ spec: sales });
    const added = c.addSeries({ name: "West", values: [1, 2] });
    expect(added).toEqual({ ok: true, id: "series-3" });
    expect(c.getState().selection).toEqual({ kind: "series", seriesId: "series-3" });
    expect(c.getState().selectedSeries?.name).toBe("West");
    expect(c.getSeries("series-3")!.values).toEqual([1, 2, null, null]);
    c.updateSeries("series-3", { color: "#ff0000", type: "line" });
    expect(c.getSeries("series-3")).toMatchObject({ color: "#ff0000", type: "line" });
    c.updateSeries("series-3", { color: null, type: null });
    expect(c.getSeries("series-3")!.color).toBeUndefined();
    c.toggleSeries("north");
    expect(c.getSeries("north")!.hidden).toBe(true);
    expect(c.getState().undoLabel).toBe('Hide "North"');
    c.moveSeries("series-3", 0);
    expect(c.getSpec().series.map((s) => s.id)).toEqual(["series-3", "north", "south"]);
    c.removeSeries("series-3");
    expect(c.getState().selection).toBeNull();
    c.undo();
    expect(c.getSpec().series).toHaveLength(3);
  });

  it("adds, renames, moves and removes categories with their values", () => {
    const c = new ChartController({ spec: sales });
    expect(c.addCategory("Q0", { at: 0 })).toEqual({ ok: true, index: 0 });
    expect(c.getSpec().categories).toEqual(["Q0", "Q1", "Q2", "Q3", "Q4"]);
    expect(c.getSpec().series[0].values).toEqual([null, 12, 18, 9, 22]);
    c.renameCategory(0, "Start");
    c.moveCategory(0, 4);
    expect(c.getSpec().categories).toEqual(["Q1", "Q2", "Q3", "Q4", "Start"]);
    expect(c.getSpec().series[0].values).toEqual([12, 18, 9, 22, null]);
    c.removeCategory(4);
    expect(c.getSpec().categories).toHaveLength(4);
  });

  it("pastes a block of cells, growing the grid", () => {
    const c = new ChartController({ spec: sales });
    const result = c.pasteCells(3, -1, "Q4b\t1\t2\t3\nQ5\t4\tx\t6");
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(1);
    const spec = c.getSpec();
    expect(spec.categories).toEqual(["Q1", "Q2", "Q3", "Q4b", "Q5"]);
    expect(spec.series).toHaveLength(3);
    expect(spec.series[1].values).toEqual([8, 11, 14, 2, null]);
    expect(spec.series[2].values).toEqual([null, null, null, 3, 6]);
    c.undo();
    expect(c.getSpec().categories).toHaveLength(4);
  });

  it("imports CSV keeping series colours by name", () => {
    const c = new ChartController({ spec: { ...sales, series: [{ id: "north", name: "North", values: [], color: "#123456" }] } });
    const result = c.importCsv("Region,North,East\nJan,1,2\nFeb,3,4\n");
    expect(result).toEqual({ ok: true });
    expect(c.getSpec().categories).toEqual(["Jan", "Feb"]);
    expect(c.getSpec().series).toMatchObject([
      { id: "north", name: "North", color: "#123456", values: [1, 3] },
      { name: "East", values: [2, 4] },
    ]);
    expect(c.importCsv("").ok).toBe(false);
  });

  it("selects, keeps the selection valid and deletes what is selected", () => {
    const c = new ChartController({ spec: sales });
    c.select({ kind: "point", seriesId: "north", index: 2 });
    expect(c.getState().selectedIndex).toBe(2);
    c.deleteSelection();
    expect(c.getSpec().series[0].values[2]).toBeNull();
    c.select({ kind: "category", index: 0 });
    c.deleteSelection();
    expect(c.getSpec().categories).toEqual(["Q2", "Q3", "Q4"]);
    c.select({ kind: "legend" });
    c.deleteSelection();
    expect(c.getSpec().legend.show).toBe(false);
    c.select({ kind: "series", seriesId: "nope" });
    expect(c.getState().selection).toBeNull();
    expect(c.deleteSelection().ok).toBe(false);
  });

  it("nudges values", () => {
    const c = new ChartController({ spec: sales });
    c.nudgeValue("north", 0, 0.1);
    expect(c.getSpec().series[0].values[0]).toBe(12.1);
  });

  it("saves and loads without an undo step, reporting problems", () => {
    const c = new ChartController({ spec: sales });
    c.setTitle("Edited");
    const saved = c.toJSON();
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
    const issues = c.load({ ...saved, type: "nope" }, { clearHistory: true });
    expect(issues).toHaveLength(1);
    expect(c.getState().issues).toBe(issues);
    expect(c.getSpec().type).toBe("bar");
    expect(c.getState().canUndo).toBe(false);
  });

  it("records into a shared history and reconnects after destroy", () => {
    const history = new HistoryManager();
    const c = new ChartController({ spec: sales, history });
    c.setTitle("A");
    expect(history.getState().canUndo).toBe(true);
    c.destroy();
    const listener = vi.fn();
    c.subscribe(listener);
    history.undo();
    expect(c.getSpec().title).toBe("Quarterly sales");
    expect(listener).toHaveBeenCalled();
  });
});

describe("chart commands", () => {
  const setup = () => {
    const controller = new ChartController({ spec: sales });
    const registry = new CommandRegistry();
    registry.register(createChartCommands(controller));
    return { controller, registry };
  };

  it("describes the chart for agents", async () => {
    const { registry } = setup();
    const result: any = await registry.execute("chart.describe");
    expect(result.ok).toBe(true);
    expect(result.result.table[0]).toEqual(["", "North", "South"]);
    expect(result.result.spec.title).toBe("Quarterly sales");
  });

  it("updates, sets values by name and label, and rejects bad input with sentences", async () => {
    const { registry, controller } = setup();
    expect((await registry.execute("chart.update", { type: "area", stacking: "stacked", yAxis: { format: { style: "compact" } } })).ok).toBe(true);
    expect(controller.getSpec()).toMatchObject({ type: "area", stacking: "stacked" });
    expect((await registry.execute("chart.setValues", { cells: [{ series: "South", category: "Q3", value: "20" }] })).ok).toBe(true);
    expect(controller.getSpec().series[1].values[2]).toBe(20);
    const bad: any = await registry.execute("chart.setValues", { cells: [{ series: "East", category: 0, value: 1 }] });
    expect(bad).toMatchObject({ ok: false, code: "failed" });
    expect(bad.message).toMatch(/no series "East"/);
    const invalid: any = await registry.execute("chart.update", { type: "radar" });
    expect(invalid.ok).toBe(false);
  });

  it("replaces data, adds and removes series and categories, imports CSV and exports SVG", async () => {
    const { registry, controller } = setup();
    await registry.execute("chart.setData", { categories: ["a", "b"], series: [{ name: "S", values: [1, 2] }] });
    expect(controller.getSpec().series).toHaveLength(1);
    const added: any = await registry.execute("chart.addSeries", { name: "T", values: [3] });
    expect(added.result.id).toBe("series-2");
    await registry.execute("chart.updateSeries", { series: "T", name: "Tee", color: "#000" });
    expect(controller.getSeries("series-2")).toMatchObject({ name: "Tee", color: "#000" });
    await registry.execute("chart.addCategory", { label: "c" });
    await registry.execute("chart.removeCategory", { category: "a" });
    expect(controller.getSpec().categories).toEqual(["b", "c"]);
    await registry.execute("chart.removeSeries", { series: "Tee" });
    expect(controller.getSpec().series).toHaveLength(1);
    await registry.execute("chart.importCsv", { csv: "x,A\n1,5\n2,6" });
    expect(controller.getSpec().categories).toEqual(["1", "2"]);
    const svg: any = await registry.execute("chart.exportSvg", { width: 300, height: 200 });
    expect(svg.result.svg).toMatch(/^<svg/);
    expect((await registry.execute("chart.undo")).ok).toBe(true);
    expect(controller.getSpec().categories).toEqual(["b", "c"]);
    expect((await registry.execute("chart.redo")).ok).toBe(true);
  });
});

describe("chart interaction helpers", () => {
  it("maps client points into the scene", () => {
    expect(chartClientToScene({ width: 640, height: 400 }, { left: 10, top: 20, width: 320, height: 200 }, 170, 120)).toEqual({ x: 320, y: 200 });
  });

  it("drags a bar as one snapped undo step and refuses percent stacks", () => {
    const c = new ChartController({ spec: sales });
    const scene = layoutChart(c.getSpec() as ChartSpec, { width: 640, height: 400 });
    const target = { kind: "point" as const, seriesId: "north", index: 0 };
    const { range, domain } = scene.valueScale!;
    const pxPerUnit = (range[0] - range[1]) / (domain[1] - domain[0]);
    const drag = startChartPointDrag(c, scene, target, { x: 100, y: 200 })!;
    drag.move({ x: 100, y: 200 - pxPerUnit * 3.04 });
    drag.move({ x: 100, y: 200 - pxPerUnit * 5.01 });
    drag.end();
    expect(c.getSpec().series[0].values[0]).toBe(17);
    c.undo();
    expect(c.getSpec().series[0].values[0]).toBe(12);
    const percent = layoutChart(createChartSpec({ ...sales, stacking: "percent" }), { width: 640, height: 400 });
    expect(startChartPointDrag(c, percent, target, { x: 0, y: 0 })).toBeNull();
    expect(startChartPointDrag(c, scene, { kind: "title" }, { x: 0, y: 0 })).toBeNull();
  });

  it("handles keys for moving, nudging, deleting and clearing the selection", () => {
    const c = new ChartController({ spec: sales });
    const scene = layoutChart(c.getSpec() as ChartSpec, { width: 640, height: 400 });
    expect(handleChartKey(c, scene, { key: "ArrowUp" })).toBe(false);
    c.select({ kind: "point", seriesId: "north", index: 0 });
    expect(handleChartKey(c, scene, { key: "ArrowRight" })).toBe(true);
    expect(c.getState().selectedIndex).toBe(1);
    handleChartKey(c, scene, { key: "ArrowUp", shiftKey: true });
    expect(c.getSpec().series[0].values[1]).toBe(23);
    handleChartKey(c, scene, { key: "ArrowDown" });
    expect(c.getSpec().series[0].values[1]).toBe(22.5);
    expect(describeChartSelection(c)).toBe("North · Q2: 22.5");
    handleChartKey(c, scene, { key: "Delete" });
    expect(c.getSpec().series[0].values[1]).toBeNull();
    expect(handleChartKey(c, scene, { key: "z", metaKey: true })).toBe(false);
    handleChartKey(c, scene, { key: "Escape" });
    expect(c.getState().selection).toBeNull();
    expect(describeChartSelection(c)).toBe("Nothing selected");
  });
});

describe("chartColorInputValue", () => {
  it("gives colour inputs a #rrggbb value", () => {
    expect(chartColorInputValue("#ABCDEF")).toBe("#abcdef");
    expect(chartColorInputValue("#f0a")).toBe("#ff00aa");
    expect(chartColorInputValue("rebeccapurple")).toBe("#000000");
  });
});
