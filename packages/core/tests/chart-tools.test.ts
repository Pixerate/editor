// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ToolRegistry, validateJsonSchema } from "../src/tools";
import { CommandRegistry, createCommandToolProvider } from "../src/commands";
import { HistoryManager } from "../src/history/HistoryManager";
import {
  ChartController,
  ChartDirector,
  ChartPresence,
  createChartCommands,
  createChartToolProvider,
  createInstantChartClock,
  layoutChart,
  planChartCommand,
  type ChartSpec,
} from "../src/chart";
import { baseToolName } from '../src/tools';

const spec: Partial<ChartSpec> = {
  type: "bar",
  categories: ["Q1", "Q2", "Q3", "Q4"],
  series: [
    { id: "na", name: "North America", values: [10, 20, 30, 40] },
    { id: "eu", name: "Europe", values: [5, 15, 25, 35] },
  ],
};

const setup = (options: Parameters<typeof createChartToolProvider>[1] = {}) => {
  const controller = new ChartController({ spec });
  const registry = new ToolRegistry();
  registry.register(createChartToolProvider(controller, options));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result: any = await registry.callTool(name, args);
    return { error: result.isError ? (result.content[0].text as string) : null, value: result.structuredContent as any, result };
  };
  return { controller, registry, call };
};

describe("chart agent tools", () => {
  it("lists one strict, described, annotated tool per operation", async () => {
    const { registry, call } = setup();
    const tools = registry.listTools().tools;
    expect(tools.map((t) => baseToolName(t.name))).toEqual([
      "get_chart", "render_chart", "check_chart_colors", "recommend_chart", "get_chart_trendline", "list_chart_presets", "export_chart_mermaid", "export_chart_ooxml",
      "update_chart", "set_chart_data", "set_chart_values", "add_chart_series", "update_chart_series", "remove_chart_series", "add_chart_category", "remove_chart_category",
      "import_chart_csv", "import_chart_mermaid", "import_chart_ooxml", "add_chart_trendline", "remove_chart_trendline",
      "add_chart_reference_line", "update_chart_reference_line", "remove_chart_reference_line", "add_chart_reference_band", "update_chart_reference_band", "remove_chart_reference_band",
      "set_chart_callout", "highlight_chart", "set_chart_tree", "import_chart_tree_csv", "add_chart_tree_node", "update_chart_tree_node", "remove_chart_tree_node", "apply_chart_preset", "transpose_chart",
      "select_chart_element", "drag_chart_point", "press_chart_key", "undo_chart", "redo_chart",
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      // Every tool rejects an unknown argument, naming what it accepts.
      const bad = await call(tool.name, { typo: 1 });
      expect(bad.error, tool.name).toMatch(/Unknown property "typo"/);
    }
  });

  it("suggests the argument the agent meant", async () => {
    const { call } = setup();
    expect((await call("update_chart", { tpye: "line" })).error).toMatch(/Unknown property "tpye"\. Did you mean "type"\?/);
    expect(validateJsonSchema({ colour: 1 }, { type: "object", properties: { color: {} }, additionalProperties: false })[0].message).toBe('Unknown property "colour". Did you mean "color"? Allowed: color.');
  });

  it("reads the chart with a summary and closes the loop with ids", async () => {
    const { call } = setup();
    const { value } = await call("get_chart");
    expect(value.spec.series.map((s: any) => s.id)).toEqual(["na", "eu"]);
    expect(value.table[0]).toEqual(["", "North America", "Europe"]);
    expect(value.summary.series[0]).toMatchObject({ id: "na", max: 40, trend: "rising" });
    expect(value.summary.description).toMatch(/^A bar chart showing 2 series/);
    const added = (await call("add_chart_series", { name: "Asia", values: [1, 2, 3, 4], axis: "secondary", marker: null })).value;
    expect(added).toEqual({ id: "series-3", name: "Asia", values: [1, 2, 3, 4] });
    const set = (await call("set_chart_values", { cells: [{ series: added.id, category: "Q2", value: "2,500" }] })).value;
    expect(set.cells).toEqual([{ series: "series-3", category: "Q2", index: 1, value: 2500 }]);
  });

  it("fails usefully and changes nothing", async () => {
    const { call, controller } = setup();
    const before = controller.toJSON();
    expect((await call("set_chart_values", { cells: [{ series: "Mars", category: 0, value: 1 }] })).error).toMatch(/There is no series "Mars"; expected one of "na" \(North America\), "eu" \(Europe\)/);
    expect((await call("set_chart_values", { cells: [{ series: "na", category: 9, value: 1 }] })).error).toMatch(/There is no category 9; expected an index from 0 to 3/);
    expect((await call("set_chart_values", { cells: [{ series: "na", category: 0, value: 1 }, { series: "na", category: 1, value: "abc" }] })).error).toMatch(/"abc" is not a number.*Nothing was changed/);
    expect((await call("update_chart", {})).error).toMatch(/Nothing to change/);
    expect((await call("update_chart", { gapWidth: 0.95 })).error).toMatch(/must be <= 0.9|Must be <= 0.9/);
    expect((await call("add_chart_trendline", { series: "na", type: "linear", order: 3, intercept: "x" })).error).toBeTruthy();
    expect((await call("get_chart_trendline", { series: "na", index: 0 })).error).toMatch(/"North America" has no trendline 0; it has 0/);
    expect((await call("drag_chart_point", { from: { x: 0.01, y: 0.01 }, to: { x: 0.5, y: 0.5 } })).error).toMatch(/There is no bar or point at/);
    expect(controller.toJSON()).toEqual(before);
  });

  it("edits presentation, trendlines, presets and data as single undo steps", async () => {
    const { call, controller } = setup();
    await call("update_chart", { type: "line", yAxis2: { title: "Share" }, labelPosition: "inside" });
    expect(controller.getState().undoLabel).toBe("Change chart");
    const trend = (await call("add_chart_trendline", { series: "North America", type: "linear", showR2: true })).value;
    expect(trend).toMatchObject({ series: "na", index: 0, coefficients: [0, 10], r2: 1, equation: "y = 10x" });
    expect((await call("get_chart_trendline", { series: "na", index: 0 })).value).toMatchObject({ equation: "y = 10x", points: 4 });
    expect((await call("remove_chart_trendline", { series: "na", index: 0 })).value).toEqual({ series: "na", trendlines: [] });
    await call("apply_chart_preset", { layout: "labelled", colors: "okabe-ito" });
    expect(controller.getSpec().dataLabels).toBe(true);
    expect((await call("list_chart_presets")).value.layouts.map((l: any) => l.id)).toContain("labelled");
    const t = (await call("transpose_chart")).value;
    expect(t.series.map((s: any) => s.name)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect((await call("undo_chart")).value).toMatchObject({ undone: true, label: "Switch rows and columns" });
    expect((await call("redo_chart")).value).toMatchObject({ redone: true });
  });

  it("imports CSV with type detection, Mermaid and Office XML", async () => {
    const { call, controller } = setup();
    const csv = (await call("import_chart_csv", { csv: "x,y\n1,2\n2,4\n3,5", chartType: "auto" })).value;
    expect(csv.type).toBe("scatter");
    expect(controller.getSpec().series[0].x).toEqual([1, 2, 3]);
    const mm = (await call("import_chart_mermaid", { mermaid: '```mermaid\npie\n  "A" : 3\n  "B" : 1\n```' })).value;
    expect(mm.spec).toMatchObject({ type: "pie", categories: ["A", "B"] });
    expect((await call("import_chart_mermaid", { mermaid: "flowchart LR" })).error).toMatch(/expected a chart header/);
    const exported = (await call("export_chart_ooxml")).value;
    expect(exported.xml).toMatch(/^<\?xml/);
    await call("update_chart", { type: "bar" });
    const back = (await call("import_chart_ooxml", { xml: exported.xml })).value;
    expect(back).toMatchObject({ unsupported: [], lossless: true });
    expect(back.spec.type).toBe("pie");
    expect((await call("export_chart_mermaid", { meta: false })).value.mermaid).toMatch(/^pie/);
  });

  it("drives the real pointer and keyboard paths", async () => {
    const { call, controller } = setup();
    const scene = layoutChart(controller.getSpec() as ChartSpec, { width: 640, height: 400 });
    const bar = scene.marks.find((m) => m.key === "bar-na-3") as any;
    const from = { x: (bar.x + bar.width / 2) / 640, y: (bar.y + 4) / 400 };
    const dragged = (await call("drag_chart_point", { from, to: { x: from.x, y: from.y + 0.1 } })).value;
    expect(dragged).toMatchObject({ series: "na", category: "Q4", index: 3, before: 40 });
    expect(dragged.after).toBeLessThan(40);
    expect(controller.getState().undoLabel).toBe("Drag North America");
    expect((await call("select_chart_element", { kind: "point", series: "eu", category: "Q1" })).value.selection).toEqual({ kind: "point", seriesId: "eu", index: 0 });
    const key = (await call("press_chart_key", { key: "ArrowUp", shift: true })).value;
    expect(key.used).toBe(true);
    expect(key.value).toBeGreaterThan(5);
    expect((await call("select_chart_element", { kind: "axis" })).error).toMatch(/kind "axis" needs axis/);
  });

  it("renders SVG, or PNG when the host can rasterize", async () => {
    const { call } = setup();
    const svg = (await call("render_chart", { width: 300, height: 200 })).value;
    expect(svg.svg).toMatch(/^<svg[^>]*width="300"/);
    expect(Array.isArray(svg.warnings)).toBe(true);
    expect((await call("render_chart", { format: "png" })).error).toMatch(/cannot rasterize.*format "svg"/);
    const sizes: unknown[] = [];
    const png = setup({
      rasterize: (drawn, size) => {
        sizes.push(size);
        expect(drawn).toMatch(/^<svg/);
        return { data: "AAAA", mimeType: "image/png" };
      },
    });
    const { result, value } = await png.call("render_chart", { format: "png", width: 320, height: 200 });
    expect(sizes).toEqual([{ width: 320, height: 200 }]);
    expect(result.content[0]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
    expect(result.content[1]).toEqual({ type: "text", text: expect.stringMatching(/^Chart at 320 × 200\. (No layout warnings\.|Layout warnings: )/) });
    expect(value).toMatchObject({ width: 320, height: 200, mimeType: "image/png", warnings: expect.any(Array) });
  });

  it("returns the layout warnings with the image and says when to look", async () => {
    const crowded = new ChartController({
      spec: { type: "bar", categories: Array.from({ length: 60 }, (_, i) => `A long category label ${i}`), series: [{ id: "s", name: "S", values: Array.from({ length: 60 }, (_, i) => i) }] },
    });
    const registry = new ToolRegistry();
    registry.register(createChartToolProvider(crowded, { rasterize: () => ({ data: "AAAA", mimeType: "image/png" }) }));
    const result: any = await registry.callTool("render_chart", { format: "png", width: 200, height: 150 });
    expect(result.structuredContent.warnings.length).toBeGreaterThan(0);
    expect(result.content[1].text).toContain(result.structuredContent.warnings[0].message);
    const tool = registry.listTools().tools.find((t: any) => baseToolName(t.name) === "render_chart")!;
    expect(tool.description).toMatch(/costs tokens/);
    expect(tool.description).toMatch(/overlapping/);
    expect(tool.description).toMatch(/get_chart is cheaper/);
  });

  it("checks colours and recommends types", async () => {
    const { call } = setup();
    expect((await call("check_chart_colors", { colors: ["#ff0000", "#ee1100"] })).value.ok).toBe(false);
    expect((await call("check_chart_colors")).value.colors).toHaveLength(2);
    expect((await call("recommend_chart", { csv: "Month,Sales\n2024-01,1\n2024-02,2" })).value.recommendations[0].type).toBe("line");
    expect((await call("recommend_chart", { csv: "a,b\nc,d" })).error).toMatch(/no numbers to chart/);
  });

  it("hides write tools while read-only and says why", async () => {
    let locked: string | false = "The report is signed off.";
    const { registry, call } = setup({ readOnly: () => locked });
    expect(registry.listTools().tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    expect((await call("get_chart")).value.readOnly).toBe("The report is signed off.");
    expect((await call("set_chart_values", { cells: [] })).error).toMatch(/Unknown tool|unknown_tool/);
    locked = false;
    expect(registry.listTools().tools.some((t) => baseToolName(t.name) === "set_chart_values")).toBe(true);
  });

  it("acts out value edits with a cursor when given a director, still as one undo step", async () => {
    const controller = new ChartController({ spec });
    const presence = new ChartPresence();
    const clock = createInstantChartClock();
    const director = new ChartDirector(controller, presence, { scene: () => layoutChart(controller.getSpec() as ChartSpec, { width: 640, height: 400 }), clock, linger: 0 });
    const registry = new ToolRegistry();
    registry.register(createChartToolProvider(controller, { director, actor: { id: "claude", name: "Claude" } }));
    const moves: number[] = [];
    presence.subscribe((s) => moves.push(s.actors.length));
    const result: any = await registry.callTool("set_chart_values", { cells: [{ series: "na", category: 0, value: 12 }, { series: "eu", category: 1, value: 0 }] });
    expect(result.isError).toBeFalsy();
    expect(controller.getSeries("na")!.values[0]).toBe(12);
    expect(controller.getSeries("eu")!.values[1]).toBe(0);
    expect(moves.length).toBeGreaterThan(10);
    expect(clock.elapsed()).toBeGreaterThan(500);
    controller.undo();
    expect(controller.getSeries("na")!.values[0]).toBe(10);
    expect(controller.getSeries("eu")!.values[1]).toBe(15);
  });
});

describe("chart presence planning", () => {
  it("plans a value change as a drag to the new value", () => {
    const controller = new ChartController({ spec });
    const scene = layoutChart(controller.getSpec() as ChartSpec, { width: 640, height: 400 });
    const steps = planChartCommand(controller.getSpec() as ChartSpec, scene, { kind: "setValue", seriesId: "na", index: 0, value: 30, note: "Fixing Q1" });
    expect(steps.map((s) => s.type)).toEqual(["say", "move", "press", "drag", "release", "commit"]);
    const drag = steps.find((s) => s.type === "drag") as any;
    expect(drag.from).toBe(10);
    expect(drag.value).toBe(30);
    expect(drag.to.y).toBeLessThan((steps.find((s) => s.type === "move") as any).to.y);
  });

  it("fails cleanly when the target has gone", async () => {
    const controller = new ChartController({ spec });
    const director = new ChartDirector(controller, new ChartPresence(), { scene: () => layoutChart(controller.getSpec() as ChartSpec, { width: 640, height: 400 }), clock: createInstantChartClock(), linger: 0 });
    const [result] = await director.perform({ id: "a" }, [{ kind: "setValue", seriesId: "gone", index: 0, value: 1 }]);
    expect(result).toEqual({ ok: false, command: { kind: "setValue", seriesId: "gone", index: 0, value: 1 }, message: 'The series "gone" no longer exists.' });
    expect(controller.getState().canUndo).toBe(false);
  });
});

describe("run_commands: result references and atomic batches", () => {
  const setupCommands = (withHistory: boolean) => {
    const history = new HistoryManager();
    const controller = new ChartController({ spec, history });
    const commands = new CommandRegistry(withHistory ? { history } : {});
    commands.register(createChartCommands(controller));
    const tools = new ToolRegistry();
    tools.register(createCommandToolProvider(commands));
    return { controller, history, tools };
  };

  it("passes an id from one step to the next", async () => {
    const { tools, controller } = setupCommands(false);
    const result: any = await tools.callTool("run_commands", {
      steps: [
        { id: "chart.addSeries", params: { name: "Asia" } },
        { id: "chart.setValues", params: { cells: [{ series: "$0.id", category: 0, value: 7 }, { series: "$last.id", category: 1, value: 8 }] } },
        { id: "chart.updateSeries", params: { series: "$0.id", name: "$1.table.0.1" } },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(controller.getSeries("series-3")!.values.slice(0, 2)).toEqual([7, 8]);
    // "$1.table.0.1" is the header cell of the first series in step 1's table.
    expect(controller.getSeries("series-3")!.name).toBe("North America");
    const bad: any = await tools.callTool("run_commands", { steps: [{ id: "chart.setValues", params: { cells: [{ series: "$4.id", category: 0, value: 1 }] } }] });
    expect(bad.structuredContent.results[0].message).toMatch(/refers to step 4, but only 0 steps have run/);
  });

  it("makes an atomic batch one undo step and rolls it all back on failure", async () => {
    const { tools, controller, history } = setupCommands(true);
    const ok: any = await tools.callTool("run_commands", {
      atomic: true,
      label: "Rebuild Q1",
      steps: [
        { id: "chart.setValues", params: { cells: [{ series: "na", category: 0, value: 1 }] } },
        { id: "chart.update", params: { title: "Rebuilt" } },
      ],
    });
    expect(ok.isError).toBeFalsy();
    expect(history.getState().undoName).toBe("Rebuild Q1");
    history.undo();
    expect(controller.getSpec().title).toBe("");
    expect(controller.getSeries("na")!.values[0]).toBe(10);
    const failed: any = await tools.callTool("run_commands", {
      atomic: true,
      steps: [
        { id: "chart.update", params: { title: "Half done" } },
        { id: "chart.removeSeries", params: { series: "Mars" } },
      ],
    });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent.rolledBack).toBe(true);
    expect(controller.getSpec().title).toBe("");
    const none = setupCommands(false);
    const refused: any = await none.tools.callTool("run_commands", { atomic: true, steps: [{ id: "chart.undo" }] });
    expect(refused.content[0].text).toMatch(/atomic batches need a CommandRegistry created with \{ history \}/);
  });
});
