// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools";
import {
  ChartController,
  chartFromMermaid,
  chartMapBreaks,
  chartMapClass,
  chartMapRamp,
  chartToMermaid,
  chartToOoxml,
  createChartSpec,
  createChartToolProvider,
  describeChart,
  getChartMap,
  layoutChart,
  listChartMaps,
  matchChartMapRegions,
  normalizeChartSpec,
  registerChartMap,
  type ChartMapGeometry,
  type ChartMark,
  type ChartScene,
  type ChartSpec,
} from "../src/chart";
import { EUROPE_CHART_MAP } from "../src/chart-maps";

/** Three squares side by side and a dot: a map whose numbers are easy to check. */
const SQUARES: ChartMapGeometry = {
  id: "squares",
  name: "Squares",
  width: 300,
  height: 100,
  attribution: "Test map",
  land: "M0,0L300,0L300,100L0,100Z",
  regions: [
    { id: "AAA", name: "Alpha", d: "M0,0L100,0L100,100L0,100Z", center: [50, 50], area: 10000 },
    { id: "BBB", name: "Bêta", d: "M100,0L200,0L200,100L100,100Z", center: [150, 50], area: 10000 },
    { id: "CCC", name: "Gamma", d: "M200,0L300,0L300,100L200,100Z", center: [250, 50], area: 10000 },
    { id: "DOT", name: "Dot", d: "", center: [280, 20], area: 0 },
  ],
};

beforeAll(() => {
  registerChartMap(SQUARES);
  registerChartMap(EUROPE_CHART_MAP);
});

const squares: Partial<ChartSpec> = { type: "choropleth", map: "squares", categories: ["AAA", "beta", "Dot", "Nowhere"], series: [{ id: "v", name: "Value", values: [10, 30, 50, 5] }] };
const SIZE = { width: 600, height: 300 };
const scene = (spec: Partial<ChartSpec>) => layoutChart(createChartSpec(spec), SIZE);
const byKey = (s: ChartScene, key: string) => s.marks.find((m) => m.key === key);
const fill = (m: ChartMark | undefined) => (m && "fill" in m ? m.fill : undefined);

describe("maps", () => {
  it("are registered by id and matched by code or name, ignoring case and accents", () => {
    expect(getChartMap("squares")).toBe(SQUARES);
    expect(listChartMaps().map((m) => m.id)).toEqual(expect.arrayContaining(["squares", "europe"]));
    expect(matchChartMapRegions(SQUARES, ["aaa", "BETA", "Alpha", "x"]).map((r) => r?.id ?? null)).toEqual(["AAA", "BBB", null, null]);
  });

  it("split values into equal classes rounded for the legend, or at given breaks", () => {
    expect(chartMapBreaks([5, 510], 5, [])).toEqual([110, 210, 310, 410]);
    expect(chartMapBreaks([1, 1.4], 4, [])).toEqual([1.1, 1.2, 1.3]);
    expect(chartMapBreaks([3, 3], 5, [])).toEqual([]);
    expect(chartMapBreaks([1, 100], 5, [10, 50])).toEqual([10, 50]);
    expect([0, 10, 49, 50, 99].map((v) => chartMapClass(v, [10, 50]))).toEqual([0, 1, 1, 2, 2]);
    expect(chartMapRamp("#4269d0", 3)).toHaveLength(3);
  });

  it("check the map options", () => {
    expect(createChartSpec({ type: "choropleth" })).toMatchObject({ map: "europe", mapSteps: 5, mapThresholds: [] });
    expect(normalizeChartSpec({ mapSteps: 12, mapThresholds: [5, 2] }).issues.map((i) => i.message)).toEqual([
      "mapSteps must be a whole number of colour classes from 2 to 9.",
      "mapThresholds must be up to 8 numbers in ascending order (the class breaks), or [] for equal classes.",
    ]);
  });
});

describe("choropleth layout", () => {
  it("shades matched regions by class and greys the rest, behind which the land is drawn", () => {
    const s = scene(squares);
    const keys = s.marks.map((m) => m.key);
    expect(keys.indexOf("map-land")).toBeLessThan(keys.indexOf("region-AAA"));
    const [a, b, c] = ["region-AAA", "region-BBB", "region-CCC"].map((k) => byKey(s, k)!);
    expect(a).toMatchObject({ role: "region", target: { kind: "category", index: 0 } });
    expect(fill(a)).not.toBe(fill(b));
    expect(c.target).toBeUndefined(); // no data for Gamma
    expect(fill(c)).toBe(fill(byKey(s, `legend-swatch-${5}`)));
    // Scaled to fit: 300 × 100 into the area keeps its shape.
    if (a.kind !== "path") throw new Error("expected a path");
    expect(a.d.startsWith("M")).toBe(true);
  });

  it("marks regions too small to see, writes the legend and credits the map", () => {
    const s = scene({ ...squares, dataLabels: true });
    expect(byKey(s, "region-marker-DOT")).toMatchObject({ kind: "circle", target: { kind: "category", index: 2 } });
    expect(byKey(s, "region-DOT")).toBeUndefined();
    const legend = s.marks.filter((m) => m.role === "legend-label").map((m) => (m.kind === "text" ? m.text : ""));
    expect(legend).toEqual(["< 18", "18–26", "26–34", "34–42", "≥ 42", "No data"]);
    expect(byKey(s, "map-attribution")).toMatchObject({ text: "Test map" });
    expect(byKey(s, "label-AAA")).toMatchObject({ text: "10" });
    expect(s.warnings.map((w) => w.message)).toContain('1 category names no region of Squares: "Nowhere". Use codes (such as FRA) or names (France).');
  });

  it("uses given class breaks and keeps colours set on points", () => {
    const s = scene({ ...squares, mapThresholds: [20], series: [{ id: "v", name: "Value", values: [10, 30, 50, 5], pointColors: [null, "#123456"] }] });
    expect(s.marks.filter((m) => m.role === "legend-label").map((m) => (m.kind === "text" ? m.text : ""))).toEqual(["< 20", "≥ 20", "No data"]);
    expect(fill(byKey(s, "region-BBB"))).toBe("#123456");
  });

  it("draws bars when the map is not registered or nothing matches", () => {
    const missing = scene({ ...squares, map: "atlantis" });
    expect(missing.warnings.find((w) => w.code === "type-fallback")?.message).toMatch(/^The map "atlantis" is not registered, so the values are drawn as bars/);
    expect(missing.marks.filter((m) => m.role === "bar")).toHaveLength(4);
    const none = scene({ ...squares, categories: ["x", "y"] });
    expect(none.warnings.find((w) => w.code === "type-fallback")?.message).toBe("No category names a region of Squares, so the values are drawn as bars: use codes (such as FRA) or names (France) as categories.");
  });

  it("highlights regions like categories", () => {
    const s = scene({ ...squares, highlight: ["AAA"] });
    expect(byKey(s, "region-AAA")!.opacity).toBeUndefined();
    expect(byKey(s, "region-BBB")!.opacity).toBe(0.25);
  });
});

describe("the Europe outlines", () => {
  it("cover Europe's countries by ISO alpha-3 code, each placed inside the box", () => {
    const ids = EUROPE_CHART_MAP.regions.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["FRA", "DEU", "GBR", "ISL", "NOR", "TUR", "UKR", "RUS", "MLT", "LUX", "XKX", "VAT", "CYP"]));
    expect(ids.every((id) => /^[A-Z]{3}$/.test(id))).toBe(true);
    for (const r of EUROPE_CHART_MAP.regions) {
      expect(r.center[0]).toBeGreaterThanOrEqual(0);
      expect(r.center[0]).toBeLessThanOrEqual(EUROPE_CHART_MAP.width);
      expect(r.center[1]).toBeGreaterThanOrEqual(0);
      expect(r.center[1]).toBeLessThanOrEqual(EUROPE_CHART_MAP.height);
    }
    // France is drawn west of Germany and south of Norway.
    const at = (id: string) => EUROPE_CHART_MAP.regions.find((r) => r.id === id)!.center;
    expect(at("FRA")[0]).toBeLessThan(at("DEU")[0]);
    expect(at("FRA")[1]).toBeGreaterThan(at("NOR")[1]);
    expect(EUROPE_CHART_MAP.regions.find((r) => r.id === "VAT")).toMatchObject({ d: "", area: 0 });
    expect(EUROPE_CHART_MAP.attribution).toBe("Made with Natural Earth");
  });

  it("draws a map of Europe from country names or codes", () => {
    const s = scene({ type: "choropleth", categories: ["France", "DEU", "Česko", "Czechia", "Malta"], series: [{ name: "N", values: [1, 2, 3, 4, 5] }] });
    expect(byKey(s, "region-FRA")?.target).toEqual({ kind: "category", index: 0 });
    expect(byKey(s, "region-CZE")?.target).toEqual({ kind: "category", index: 3 });
    expect(byKey(s, "region-marker-MLT")).toBeDefined();
    expect(s.marks.every((m) => m.kind !== "path" || !/NaN|Infinity/.test(m.d))).toBe(true);
  });
});

describe("maps in summaries, files and agent tools", () => {
  it("are described by their highest and lowest regions", () => {
    expect(describeChart(createChartSpec({ ...squares, title: "Test" }))).toBe("Test: a map chart of Squares shading 3 regions by Value: highest Dot (50), lowest Alpha (10). 1 category names no region.");
  });

  it("round-trip through Mermaid and are written to Office as bars", () => {
    const spec = createChartSpec({ ...squares, mapThresholds: [20, 40] });
    expect(chartFromMermaid(chartToMermaid(spec)).spec).toEqual(spec);
    expect(chartToOoxml(spec).issues[0]).toMatch(/^Maps are written as bar charts of the values by region/);
  });

  it("list regions and matches for agents, and take options through update_chart", async () => {
    const controller = new ChartController({ spec: squares });
    const registry = new ToolRegistry();
    registry.register(createChartToolProvider(controller));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result: any = await registry.callTool(name, args);
      return { error: result.isError ? (result.content[0].text as string) : null, value: result.structuredContent as any };
    };
    const listed = (await call("list_chart_map_regions")).value;
    expect(listed.map).toBe("squares");
    expect(listed.regions).toEqual([{ id: "AAA", name: "Alpha" }, { id: "BBB", name: "Bêta" }, { id: "CCC", name: "Gamma" }, { id: "DOT", name: "Dot" }]);
    expect(listed.matched).toEqual([{ category: "AAA", region: "AAA" }, { category: "beta", region: "BBB" }, { category: "Dot", region: "DOT" }]);
    expect(listed.unmatched).toEqual(["Nowhere"]);
    expect((await call("list_chart_map_regions", { map: "europe" })).value.regions.length).toBe(EUROPE_CHART_MAP.regions.length);
    expect((await call("list_chart_map_regions", { map: "mars" })).error).toMatch(/^There is no map "mars"; the host has /);
    expect((await call("update_chart", { mapSteps: 3, map: "europe" })).error).toBeNull();
    expect(controller.getSpec()).toMatchObject({ mapSteps: 3, map: "europe" });
    expect((await call("update_chart", { mapThresholds: [3, 1] })).error).toMatch(/mapThresholds must be up to 8 numbers in ascending order/);
  });
});
