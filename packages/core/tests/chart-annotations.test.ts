// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools";
import { CommandRegistry, createCommandToolProvider } from "../src/commands";
import { HistoryManager } from "../src/history/HistoryManager";
import {
  ChartController,
  chartFromMermaid,
  chartFromOoxml,
  chartPointColor,
  chartToMermaid,
  chartToOoxml,
  createChartCommands,
  createChartSpec,
  createChartToolProvider,
  layoutChart,
  normalizeChartSpec,
  planChartToolPlayback,
  suggestChartReferences,
  type ChartMark,
  type ChartScene,
  type ChartSpec,
} from "../src/chart";

const sales: Partial<ChartSpec> = {
  type: "bar",
  categories: ["Q1", "Q2", "Q3", "Q4"],
  series: [
    { id: "na", name: "North America", values: [10, 20, 30, 40] },
    { id: "eu", name: "Europe", values: [5, 15, 25, 35] },
  ],
};

const SIZE = { width: 640, height: 400 };
const scene = (spec: Partial<ChartSpec>) => layoutChart(createChartSpec(spec), SIZE);
const role = (s: ChartScene, r: ChartMark["role"]) => s.marks.filter((m) => m.role === r);
const byKey = (s: ChartScene, key: string) => s.marks.find((m) => m.key === key);
const warned = (s: ChartScene, code: string) => s.warnings.filter((w) => w.code === code).map((w) => w.message);

describe("annotation fields", () => {
  it("default to nothing and normalise what they are given", () => {
    expect(createChartSpec(sales)).toMatchObject({ note: "", highlight: [], referenceLines: [], referenceBands: [], varyColors: false });
    const { spec, issues } = normalizeChartSpec({
      ...sales,
      highlight: ["Q2", "Q2", 3],
      referenceLines: [{ value: "25", label: "Target", axis: "y" }],
      referenceBands: [{ from: 30, to: 10, color: "#0a0" }],
      series: [{ name: "A", values: [1, 2, 3, 4], callouts: ["", "Peak"] }],
    });
    expect(issues).toEqual([]);
    expect(spec.highlight).toEqual(["Q2", "3"]);
    // The default axis is left out; band ends are put in order.
    expect(spec.referenceLines).toEqual([{ value: 25, label: "Target" }]);
    expect(spec.referenceBands).toEqual([{ from: 10, to: 30, color: "#0a0" }]);
    expect(spec.series[0].callouts).toEqual([null, "Peak", null, null]);
  });

  it("report bad entries as sentences and drop them", () => {
    const { spec, issues } = normalizeChartSpec({
      ...sales,
      highlight: [{}],
      referenceLines: [{ label: "No value" }, { value: 5, axis: "z" }, { value: 1, size: 3 }],
      referenceBands: [{ from: 1 }],
      varyColors: "yes",
    });
    expect(spec.referenceLines).toEqual([{ value: 5 }, { value: 1 }]);
    expect(spec.referenceBands).toEqual([]);
    expect(issues.map((i) => i.message)).toEqual([
      "highlight must list category labels or series names.",
      "referenceLines[0].value must be a number (where the line crosses the axis).",
      'referenceLines[1].axis must be one of "y", "y2", "x"; got "z".',
      'referenceLines[2] has no "size"; it takes value, label, axis and color.',
      "referenceBands[0] needs numbers for from and to (the ends of the band on its axis).",
      "varyColors must be true or false.",
    ]);
  });

  it("suggest a line at the average and a band over the middle half", () => {
    expect(suggestChartReferences(createChartSpec(sales))).toEqual({ line: { value: 22.5, label: "Average" }, band: { from: 13.8, to: 31.3, label: "Middle half" } });
    expect(suggestChartReferences(createChartSpec({ categories: ["a"], series: [] })).line.value).toBe(0);
  });
});

describe("drawing annotations", () => {
  it("draws bands under the data and lines over it, and grows the axis to show them", () => {
    const s = scene({ ...sales, referenceLines: [{ value: 55, label: "Target" }], referenceBands: [{ from: 12, to: 18, label: "Normal" }] });
    const keys = s.marks.map((m) => m.key);
    expect(keys.indexOf("reference-band-0")).toBeLessThan(keys.indexOf("bar-na-0"));
    expect(keys.indexOf("reference-line-0")).toBeGreaterThan(keys.indexOf("bar-eu-3"));
    expect(s.valueScale!.domain[1]).toBeGreaterThanOrEqual(55);
    const line = byKey(s, "reference-line-0")!;
    const label = byKey(s, "reference-label-line-0")!;
    expect(line).toMatchObject({ kind: "line", role: "reference-line", dash: "5 3" });
    expect(label).toMatchObject({ kind: "text", text: "Target", anchor: "end" });
    // A horizontal line across the whole plot.
    if (line.kind !== "line") throw new Error("expected a line");
    expect(line.y1).toBe(line.y2);
    expect(line.x2 - line.x1).toBeCloseTo(s.plot.width, 5);
    expect(byKey(s, "reference-label-band-0")).toMatchObject({ text: "Normal" });
    // Annotations are not clickable.
    expect([line, label, byKey(s, "reference-band-0")].every((m) => !m!.target)).toBe(true);
  });

  it("runs lines along the value axis of horizontal bars and on numeric x of scatter charts", () => {
    const h = byKey(scene({ ...sales, orientation: "horizontal", referenceLines: [{ value: 25 }] }), "reference-line-0")!;
    if (h.kind !== "line") throw new Error("expected a line");
    expect(h.x1).toBe(h.x2);
    const xy = scene({ type: "scatter", categories: ["a", "b"], series: [{ name: "S", values: [1, 2], x: [1, 5] }], referenceLines: [{ value: 8, axis: "x", label: "Cutoff" }] });
    const v = byKey(xy, "reference-line-0")!;
    if (v.kind !== "line") throw new Error("expected a line");
    expect(v.x1).toBe(v.x2);
    expect(xy.xScale!.domain[1]).toBeGreaterThanOrEqual(8);
  });

  it("warns about references it cannot draw", () => {
    expect(warned(scene({ ...sales, referenceLines: [{ value: 5, axis: "x" }] }), "annotations-skipped")[0]).toMatch(/x axis need a scatter or bubble chart/);
    expect(warned(scene({ ...sales, referenceLines: [{ value: 5, axis: "y2" }] }), "annotations-skipped")[0]).toMatch(/secondary axis need a series on that axis/);
    expect(warned(scene({ ...sales, yAxis: { max: 50 }, referenceLines: [{ value: 90 }] }), "annotations-skipped")[0]).toBe("The reference line at 90 is outside the value axis range and is not drawn.");
    const pie = scene({ ...sales, type: "pie", referenceLines: [{ value: 5 }] });
    expect(role(pie, "reference-line")).toHaveLength(0);
    expect(warned(pie, "annotations-skipped")[0]).toBe("Reference lines, bands and callouts are drawn on bar, line, area, scatter and bubble charts; this pie chart leaves them out.");
  });

  it("pins callouts to their bars and points with a leader, clickable as the point", () => {
    const s = scene({ ...sales, series: [{ id: "na", name: "NA", values: [10, 20, 30, 40], callouts: [null, null, null, "Record"] }] });
    const text = byKey(s, "callout-na-3")!;
    expect(text).toMatchObject({ kind: "text", text: "Record", target: { kind: "point", seriesId: "na", index: 3 } });
    const bar = byKey(s, "bar-na-3")!;
    const leader = byKey(s, "callout-leader-na-3")!;
    if (bar.kind !== "rect" || leader.kind !== "line") throw new Error("unexpected marks");
    expect(leader.x1).toBeCloseTo(bar.x + bar.width / 2, 5);
    expect(leader.y1).toBeCloseTo(bar.y, 5);
    const line = scene({ ...sales, type: "line", series: [{ id: "a", name: "A", values: [1, null, 3, 4], callouts: ["Start", "Gap", null, null] }] });
    expect(byKey(line, "callout-a-0")).toBeDefined();
    expect(warned(line, "annotations-skipped")).toEqual(["1 callout points at a gap or a hidden value and is not drawn."]);
  });

  it("keeps callouts apart when they would overlap", () => {
    const s = scene({ ...sales, series: [{ id: "a", name: "A", values: [40, 40], callouts: ["Same height", "Same height"] }, { id: "b", name: "B", values: [40, 40], callouts: ["Neighbour", null] }], categories: ["x", "y"] });
    const boxes = role(s, "callout").filter((m) => m.kind === "rect") as Extract<ChartMark, { kind: "rect" }>[];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).toBe(false);
      }
  });

  it("mutes what highlight does not name", () => {
    const opacity = (s: ChartScene, key: string) => byKey(s, key)!.opacity ?? 1;
    const byCategory = scene({ ...sales, highlight: ["Q4"] });
    expect(opacity(byCategory, "bar-na-3")).toBe(1);
    expect(opacity(byCategory, "bar-eu-3")).toBe(1);
    expect(opacity(byCategory, "bar-na-0")).toBe(0.25);
    // No series is named, so the legend stays bright.
    expect(opacity(byCategory, "legend-swatch-0")).toBe(1);
    const bySeries = scene({ ...sales, type: "line", highlight: ["Europe"] });
    expect(opacity(bySeries, "line-eu")).toBe(1);
    expect(opacity(bySeries, "line-na")).toBe(0.25);
    expect(opacity(bySeries, "legend-swatch-0")).toBe(0.25);
    // Tick labels and the axis are never muted.
    expect(role(bySeries, "tick-label").every((m) => m.opacity === undefined)).toBe(true);
    const pie = scene({ ...sales, type: "pie", highlight: ["Q1"] });
    expect(role(pie, "slice").filter((m) => (m.opacity ?? 1) < 1)).toHaveLength(3);
    const unknown = scene({ ...sales, highlight: ["Nope"] });
    expect(role(unknown, "bar").every((m) => m.opacity === undefined)).toBe(true);
    expect(warned(unknown, "highlight-unmatched")).toEqual(['Highlight names "Nope", which is neither a category nor a series.']);
  });

  it("writes the note under the chart and makes room for it", () => {
    const plain = scene(sales);
    const noted = scene({ ...sales, note: "Source: finance" });
    expect(byKey(noted, "note")).toMatchObject({ kind: "text", text: "Source: finance", anchor: "start", baseline: "bottom" });
    expect(noted.plot.height).toBeLessThan(plain.plot.height);
    expect(byKey(plain, "note")).toBeUndefined();
  });

  it("colours each category of a one-series chart with varyColors, and lists them in the legend", () => {
    const one: Partial<ChartSpec> = { ...sales, series: [sales.series![0]], varyColors: true };
    const s = scene(one);
    const fills = role(s, "bar").map((m) => (m.kind === "rect" ? m.fill : ""));
    expect(new Set(fills).size).toBe(4);
    expect(role(s, "legend-label").map((m) => (m.kind === "text" ? m.text : ""))).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    // Two visible series: one colour per series as usual.
    const two = createChartSpec({ ...sales, varyColors: true });
    expect(chartPointColor(two, 0, 0)).toBe(chartPointColor(two, 0, 3));
    // A colour set on the point still wins.
    const own = createChartSpec({ ...one, series: [{ ...sales.series![0], pointColors: ["#123456"] }] });
    expect(chartPointColor(own, 0, 0)).toBe("#123456");
  });
});

describe("annotations in files", () => {
  it("round-trip through Mermaid in the metadata comment", () => {
    const spec = createChartSpec({ ...sales, note: "Source", highlight: ["Q2"], referenceLines: [{ value: 30, label: "Target" }], referenceBands: [{ from: 5, to: 10 }], series: [{ ...sales.series![0], callouts: ["a", null, null, null] }] });
    expect(chartFromMermaid(chartToMermaid(spec)).spec).toEqual(spec);
  });

  it("keep varyColors through Office XML and list what Office cannot hold", () => {
    const spec = createChartSpec({ ...sales, series: [sales.series![0]], varyColors: true, note: "Source", referenceLines: [{ value: 3 }] });
    const out = chartToOoxml(spec);
    expect(out.xml).toContain('<c:varyColors val="1"/>');
    expect(out.issues).toContain("Reference lines and bands, the note are not written: DrawingML has no equivalent.");
    const back = chartFromOoxml(out.xml, { DOMParser });
    expect(back.spec.varyColors).toBe(true);
    expect(back.unsupported).toEqual([]);
    expect(chartToOoxml(createChartSpec(sales)).xml).not.toContain('<c:varyColors val="1"/>');
  });
});

describe("ChartController annotations", () => {
  it("adds, changes and removes reference lines and bands as single undo steps", () => {
    const c = new ChartController({ spec: sales });
    expect(c.addReferenceLine({ value: 25, label: "Target" })).toEqual({ ok: true, index: 0 });
    expect(c.getState().undoLabel).toBe('Add reference line "Target"');
    expect(c.updateReferenceLine(0, { label: null, color: "red" })).toEqual({ ok: true });
    expect(c.getSpec().referenceLines).toEqual([{ value: 25, color: "red" }]);
    expect(c.addReferenceBand({ from: 40, to: 20 })).toEqual({ ok: true, index: 0 });
    expect(c.getSpec().referenceBands).toEqual([{ from: 20, to: 40 }]);
    expect(c.removeReferenceLine(0)).toEqual({ ok: true });
    c.undo();
    expect(c.getSpec().referenceLines).toHaveLength(1);
  });

  it("refuses references the chart cannot draw, changing nothing", () => {
    const c = new ChartController({ spec: sales });
    const before = c.toJSON();
    expect(c.addReferenceLine({ value: 1, axis: "x" })).toMatchObject({ ok: false, message: 'axis "x" needs a scatter or bubble chart with numeric x values; use "y" for the value axis.' });
    expect(c.addReferenceLine({ value: 1, axis: "y2" })).toMatchObject({ ok: false, message: expect.stringMatching(/needs a visible series on the secondary axis/) });
    expect(c.addReferenceLine({ value: "x" as unknown as number })).toMatchObject({ ok: false, message: "referenceLine.value must be a number (where the line crosses the axis)." });
    expect(c.updateReferenceBand(3, { from: 1 })).toEqual({ ok: false, message: "There is no reference band 3; the chart has none yet." });
    c.update({ yAxis: { scale: "log" } });
    expect(c.addReferenceLine({ value: 0 })).toMatchObject({ ok: false, message: "That axis is logarithmic, so the values must be above 0." });
    c.update({ type: "pie", yAxis: { scale: null as unknown as undefined } });
    expect(c.addReferenceBand({ from: 1, to: 2 })).toMatchObject({ ok: false, message: "Reference lines and bands are drawn on bar, line, area, scatter and bubble charts; this is a pie chart." });
    expect(c.toJSON().referenceLines).toEqual(before.referenceLines);
  });

  it("sets and clears callouts, refusing gaps", () => {
    const c = new ChartController({ spec: { ...sales, series: [{ id: "a", name: "A", values: [1, null, 3, 4] }] } });
    expect(c.setCallout("a", 2, "Launch")).toEqual({ ok: true });
    expect(c.getSeries("a")!.callouts).toEqual([null, null, "Launch", null]);
    expect(c.getState().selection).toEqual({ kind: "point", seriesId: "a", index: 2 });
    expect(c.setCallout("a", 1, "Gap")).toMatchObject({ ok: false, message: '"A" has no value at "Q2", so there is nothing to point at; set a value first.' });
    expect(c.setCallout("a", 9, "x")).toMatchObject({ ok: false, message: "Category index 9 is out of range; expected 0 to 3." });
    expect(c.setCallout("a", 2, null)).toEqual({ ok: true });
    expect(c.getSeries("a")!.callouts).toBeUndefined();
  });

  it("highlights known names only and reports what matched", () => {
    const c = new ChartController({ spec: sales });
    expect(c.setHighlight(["Q2", "eu"])).toEqual({ ok: true, categories: [1], series: ["eu"] });
    expect(c.getSpec().highlight).toEqual(["Q2", "eu"]);
    expect(c.setHighlight(["Q9"])).toMatchObject({ ok: false, message: expect.stringMatching(/^"Q9" is neither a category nor a series\. Categories: "Q1", "Q2", "Q3", "Q4"; series: "North America", "Europe"\.$/) });
    expect(c.getSpec().highlight).toEqual(["Q2", "eu"]);
  });

  it("keeps callouts, point colours and highlight with their categories and series", () => {
    const c = new ChartController({
      spec: { ...sales, highlight: ["Q2", "Europe"], series: [{ id: "na", name: "North America", values: [10, 20, 30, 40], callouts: [null, "two", null, "four"], pointColors: [null, "#f00", null, null] }, sales.series![1]] },
    });
    c.addCategory("Q0", { at: 0 });
    expect(c.getSeries("na")).toMatchObject({ values: [null, 10, 20, 30, 40], callouts: [null, null, "two", null, "four"], pointColors: [null, null, "#f00", null, null] });
    c.moveCategory(2, 4);
    expect(c.getSeries("na")!.callouts).toEqual([null, null, null, "four", "two"]);
    c.renameCategory(4, "Second");
    expect(c.getSpec().highlight).toEqual(["Second", "Europe"]);
    c.removeCategory(4);
    expect(c.getSeries("na")!.callouts).toEqual([null, null, null, "four"]);
    expect(c.getSpec().highlight).toEqual(["Europe"]);
    c.updateSeries("eu", { name: "EMEA" });
    expect(c.getSpec().highlight).toEqual(["EMEA"]);
    c.removeSeries("eu");
    expect(c.getSpec().highlight).toEqual([]);
  });
});

describe("annotation agent tools", () => {
  const setup = (input: Partial<ChartSpec> = sales) => {
    const controller = new ChartController({ spec: input });
    const registry = new ToolRegistry();
    registry.register(createChartToolProvider(controller));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result: any = await registry.callTool(name, args);
      return { error: result.isError ? (result.content[0].text as string) : null, value: result.structuredContent as any };
    };
    return { controller, call };
  };

  it("adds, changes and removes reference lines and bands by index", async () => {
    const { call, controller } = setup();
    const added = await call("add_chart_reference_line", { value: 45, label: "Target", color: "#c00" });
    expect(added).toEqual({ error: null, value: { index: 0, referenceLines: [{ value: 45, label: "Target", color: "#c00" }] } });
    expect((await call("update_chart_reference_line", { index: 0, label: null })).value).toEqual({ index: 0, referenceLine: { value: 45, color: "#c00" } });
    expect((await call("add_chart_reference_band", { from: 10, to: 20, label: "Normal" })).value).toEqual({ index: 0, referenceBands: [{ from: 10, to: 20, label: "Normal" }] });
    expect((await call("update_chart_reference_band", { index: 0, to: 25 })).value.referenceBand).toEqual({ from: 10, to: 25, label: "Normal" });
    expect((await call("remove_chart_reference_band", { index: 0 })).value).toEqual({ referenceBands: [] });
    expect((await call("remove_chart_reference_line", { index: 0 })).value).toEqual({ referenceLines: [] });
    expect(controller.getState().undoLabel).toBe("Delete reference line");
  });

  it("refuses bad reference arguments with sentences, changing nothing", async () => {
    const { call, controller } = setup();
    const before = controller.toJSON();
    expect((await call("add_chart_reference_line", {})).error).toMatch(/value/);
    expect((await call("add_chart_reference_line", { value: 3, axis: "x" })).error).toBe('axis "x" needs a scatter or bubble chart with numeric x values; use "y" for the value axis.');
    expect((await call("add_chart_reference_band", { from: 1 })).error).toMatch(/to/);
    expect((await call("update_chart_reference_line", { index: 0, value: 2 })).error).toBe("There is no reference line 0; the chart has none yet.");
    expect((await call("update_chart_reference_band", { index: 0 })).error).toBe('Nothing to change: pass at least one field besides index, e.g. {"index": 0, "label": "Target"}.');
    expect((await call("remove_chart_reference_band", { index: 2 })).error).toBe("There is no reference band 2; the chart has none yet.");
    expect(controller.toJSON()).toEqual(before);
  });

  it("pins callouts by series name and category label", async () => {
    const { call, controller } = setup();
    expect((await call("set_chart_callout", { series: "Europe", category: "Q3", label: "Peak" })).value).toEqual({ series: "eu", index: 2, category: "Q3", label: "Peak" });
    expect(controller.getSeries("eu")!.callouts?.[2]).toBe("Peak");
    expect((await call("set_chart_callout", { series: "eu", category: 2, label: null })).value.label).toBeNull();
    expect((await call("set_chart_callout", { series: "Asia", category: 0, label: "x" })).error).toMatch(/There is no series "Asia"/);
    expect((await call("set_chart_callout", { series: "eu", category: "Q9", label: "x" })).error).toMatch(/There is no category "Q9"/);
    expect((await call("set_chart_callout", { series: "eu", category: 0 })).error).toMatch(/label/);
  });

  it("highlights by name and reports the matches", async () => {
    const { call, controller } = setup();
    expect((await call("highlight_chart", { names: ["Q4", "North America"] })).value).toEqual({
      highlight: ["Q4", "North America"],
      categories: [{ index: 3, label: "Q4" }],
      series: [{ id: "na", name: "North America" }],
    });
    expect((await call("highlight_chart", { names: ["Mars"] })).error).toMatch(/^"Mars" is neither a category nor a series/);
    expect(controller.getSpec().highlight).toEqual(["Q4", "North America"]);
    expect((await call("highlight_chart", { names: [] })).value.highlight).toEqual([]);
  });

  it("sets the note, highlight and varyColors through update_chart", async () => {
    const { call, controller } = setup({ ...sales, series: [sales.series![0]] });
    expect((await call("update_chart", { note: "Source: ONS", varyColors: true })).error).toBeNull();
    expect(controller.getSpec()).toMatchObject({ note: "Source: ONS", varyColors: true });
    expect((await call("update_chart", { referenceLines: [{ value: 1, colour: "red" }] })).error).toMatch(/Unknown property "colour"\. Did you mean "color"\?/);
  });

  it("plays back on the inspector's annotation controls", () => {
    expect(planChartToolPlayback("add_chart_reference_band", { from: 1, to: 2 })).toEqual([
      { type: "target", ref: { kind: "control", id: "referenceBand.add" } },
      { type: "press" },
      { type: "release" },
    ]);
    expect(planChartToolPlayback("set_chart_callout", { series: "eu", category: 1, label: "x" })!.map((s) => (s.type === "target" ? s.ref.kind : s.type))).toEqual(["point", "press", "release", "control", "press", "release"]);
    expect(planChartToolPlayback("highlight_chart", { names: [] })![0]).toEqual({ type: "target", ref: { kind: "control", id: "highlight" } });
  });
});

describe("annotation commands", () => {
  it("run in an atomic batch and roll back together", async () => {
    const history = new HistoryManager();
    const controller = new ChartController({ spec: sales, history });
    const commands = new CommandRegistry({ history });
    commands.register(createChartCommands(controller));
    const tools = new ToolRegistry();
    tools.register(createCommandToolProvider(commands));
    const ok: any = await tools.callTool("run_commands", {
      steps: [
        { id: "chart.addReferenceLine", params: { value: 30, label: "Target" } },
        { id: "chart.setCallout", params: { series: "na", category: "Q4", label: "Best" } },
        { id: "chart.highlight", params: { names: ["Q4"] } },
      ],
    });
    expect(ok.isError).toBeFalsy();
    expect(controller.getSpec()).toMatchObject({ referenceLines: [{ value: 30, label: "Target" }], highlight: ["Q4"] });
    const before = controller.toJSON();
    const failed: any = await tools.callTool("run_commands", {
      atomic: true,
      steps: [
        { id: "chart.addReferenceBand", params: { from: 1, to: 2 } },
        { id: "chart.highlight", params: { names: ["Nope"] } },
      ],
    });
    expect(failed.isError).toBe(true);
    expect(controller.toJSON()).toEqual(before);
  });
});
