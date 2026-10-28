import { describe, it, expect } from "vitest";
import {
  ChartController,
  chartCategoryAtPoint,
  chartTooltipAt,
  chartTooltipFor,
  createChartToolProvider,
  layoutChart,
  normalizeChartSpec,
  sameChartTooltip,
  type ChartScene,
  type ChartSpec,
} from "../src/chart";
import { ToolRegistry } from "../src/tools";

const make = (partial: Partial<ChartSpec>) => normalizeChartSpec(partial).spec;

const stacked = make({
  type: "bar",
  stacking: "stacked",
  categories: ["2026-10-01", "2026-10-02", "2026-10-03"],
  series: [
    { id: "web", name: "Web", values: [3, 0, 5], color: "#111111" },
    { id: "cli", name: "CLI", values: [1, null, 2] },
  ],
  yAxis: { format: { suffix: " runs" } } as ChartSpec["yAxis"],
});

/** The centre of the first bar mark for a series and category. */
function barCentre(scene: ChartScene, seriesId: string, index: number) {
  const bar = scene.marks.find((m) => m.kind === "rect" && m.target?.kind === "point" && m.target.seriesId === seriesId && m.target.index === index);
  if (!bar || bar.kind !== "rect") throw new Error(`no bar for ${seriesId}[${index}]`);
  return { x: bar.x + bar.width / 2, y: bar.y + bar.height / 2 };
}

describe("chartCategoryAtPoint", () => {
  it("finds the category band under a point inside the plot", () => {
    const scene = layoutChart(stacked, { width: 600, height: 300 });
    const { plot } = scene;
    const y = plot.y + plot.height / 2;
    expect(chartCategoryAtPoint(scene, { x: plot.x + 1, y })).toBe(0);
    expect(chartCategoryAtPoint(scene, { x: plot.x + plot.width / 2, y })).toBe(1);
    expect(chartCategoryAtPoint(scene, { x: plot.x + plot.width - 1, y })).toBe(2);
    expect(chartCategoryAtPoint(scene, { x: plot.x - 5, y })).toBeUndefined();
  });

  it("follows reversed and horizontal category axes", () => {
    const reversed = layoutChart(make({ ...stacked, xAxis: { ...stacked.xAxis, reverse: true } }), { width: 600, height: 300 });
    expect(chartCategoryAtPoint(reversed, { x: reversed.plot.x + 1, y: reversed.plot.y + 10 })).toBe(2);
    const horizontal = layoutChart(make({ ...stacked, orientation: "horizontal" }), { width: 600, height: 300 });
    expect(horizontal.categoryScale?.axis).toBe("y");
    expect(chartCategoryAtPoint(horizontal, { x: horizontal.plot.x + 10, y: horizontal.plot.y + 1 })).toBe(0);
  });

  it("is absent on charts without category bands", () => {
    const pie = layoutChart(make({ type: "pie", categories: ["a", "b"], series: [{ id: "s", name: "S", values: [1, 2] }] }), { width: 300, height: 300 });
    expect(pie.categoryScale).toBeUndefined();
    expect(chartCategoryAtPoint(pie, { x: 150, y: 150 })).toBeUndefined();
  });
});

describe("chartTooltipFor", () => {
  it("lists each visible series with a value, formatted with the axis format", () => {
    const tip = chartTooltipFor(stacked, 0)!;
    expect(tip.title).toBe("2026-10-01");
    expect(tip.items).toEqual([
      { seriesId: "web", name: "Web", color: "#111111", value: 3, text: "3 runs" },
      expect.objectContaining({ seriesId: "cli", name: "CLI", value: 1, text: "1 runs" }),
    ]);
  });

  it("keeps zeros, skips gaps and hidden series, and narrows to one series", () => {
    expect(chartTooltipFor(stacked, 1)!.items.map((i) => i.seriesId)).toEqual(["web"]);
    const hidden = make({ ...stacked, series: stacked.series.map((s) => (s.id === "web" ? { ...s, hidden: true } : s)) });
    expect(chartTooltipFor(hidden, 1)).toBeNull();
    expect(chartTooltipFor(stacked, 2, "cli")!.items.map((i) => i.text)).toEqual(["2 runs"]);
  });

  it("adds shares on percent-stacked and pie charts", () => {
    const percent = chartTooltipFor(make({ ...stacked, stacking: "percent" }), 0)!;
    expect(percent.items.map((i) => i.share)).toEqual([0.75, 0.25]);
    expect(percent.items[0].text).toBe("3 runs (75%)");
    const pie = chartTooltipFor(make({ type: "pie", categories: ["a", "b"], series: [{ id: "s", name: "S", values: [1, 3] }] }), 1)!;
    expect(pie.items[0]).toMatchObject({ name: "b", share: 0.75, text: "3 (75%)" });
  });

  it("returns null for out-of-range indexes and charts without one value per category", () => {
    expect(chartTooltipFor(stacked, 9)).toBeNull();
    expect(chartTooltipFor(make({ type: "histogram", series: [{ id: "s", name: "S", values: [1, 2, 3] }] }), 0)).toBeNull();
  });
});

describe("chartTooltipAt", () => {
  const scene = layoutChart(stacked, { width: 600, height: 300 });

  it("shows the bar under the pointer in point mode", () => {
    const at = barCentre(scene, "web", 2);
    const tip = chartTooltipAt(stacked, scene, at)!;
    expect(tip.items.map((i) => i.seriesId)).toEqual(["web"]);
    expect(tip).toMatchObject({ index: 2, x: at.x, y: at.y });
  });

  it("shows the whole category anywhere in its band in category mode", () => {
    const above = { x: barCentre(scene, "web", 2).x, y: scene.plot.y + 1 };
    expect(chartTooltipAt(stacked, scene, above)).toBeNull();
    expect(chartTooltipAt(stacked, scene, above, { mode: "category" })!.items.map((i) => i.seriesId)).toEqual(["web", "cli"]);
  });

  it("returns null outside the plot", () => {
    expect(chartTooltipAt(stacked, scene, { x: 1, y: 1 }, { mode: "category" })).toBeNull();
  });

  it("compares tooltips by content", () => {
    const a = chartTooltipFor(stacked, 0, undefined, { x: 1, y: 1 });
    expect(sameChartTooltip(a, chartTooltipFor(stacked, 0, undefined, { x: 50, y: 50 }))).toBe(true);
    expect(sameChartTooltip(a, chartTooltipFor(stacked, 2))).toBe(false);
    expect(sameChartTooltip(null, null)).toBe(true);
  });
});

describe("get_chart_tooltip tool", () => {
  const setup = () => {
    const registry = new ToolRegistry();
    registry.register(createChartToolProvider(new ChartController({ spec: stacked })));
    return async (args: Record<string, unknown>) => {
      const result: any = await registry.callTool("get_chart_tooltip", args);
      return { error: result.isError ? (result.content[0].text as string) : null, value: result.structuredContent as any };
    };
  };

  it("reads a category by label or index, optionally for one series", async () => {
    const call = setup();
    expect((await call({ category: "2026-10-03" })).value).toMatchObject({ title: "2026-10-03", index: 2, items: [{ seriesId: "web", text: "5 runs" }, { seriesId: "cli", text: "2 runs" }] });
    expect((await call({ category: 2, series: "CLI" })).value.items).toEqual([expect.objectContaining({ seriesId: "cli", value: 2 })]);
  });

  it("fails usefully on unknown categories and series", async () => {
    const call = setup();
    expect((await call({ category: "nope" })).error).toMatch(/There is no category "nope"/);
    expect((await call({ category: 0, series: "Mars" })).error).toMatch(/There is no series "Mars"/);
    expect((await call({})).error).toMatch(/category/);
  });
});
