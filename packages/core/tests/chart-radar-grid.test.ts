// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools";
import {
  CHART_MERMAID_META_PREFIX,
  ChartController,
  chartFromMermaid,
  chartToMermaid,
  createChartSpec,
  createChartToolProvider,
  layoutChart,
  normalizeChartSpec,
  type ChartSpec,
} from "../src/chart";

const radar: Partial<ChartSpec> = {
  type: "radar",
  categories: ["Speed", "Power", "Range", "Comfort"],
  series: [{ id: "a", name: "A", values: [4, 3, 5, 2] }],
  yAxis: { min: 0, max: 10 },
};

const rings = (spec: Partial<ChartSpec>) => layoutChart(createChartSpec(spec), { width: 480, height: 320 }).marks.filter((m) => m.role === "grid");

describe("radar rings and grid shape", () => {
  it("defaults to round-number polygon rings and validates new values", () => {
    expect(createChartSpec(radar)).toMatchObject({ radarTicks: null, radarGraticule: "polygon" });
    const { spec, issues } = normalizeChartSpec({ ...radar, radarTicks: 0, radarGraticule: "square" });
    expect(spec).toMatchObject({ radarTicks: null, radarGraticule: "polygon" });
    expect(issues.map((i) => i.path)).toEqual(["radarTicks", "radarGraticule"]);
    expect(issues[0].message).toBe("radarTicks must be a whole number from 1 to 50, or null for round-number rings.");
  });

  it("draws the given number of evenly spaced rings, as polygons or circles", () => {
    const polygons = rings({ ...radar, radarTicks: 4 });
    expect(polygons).toHaveLength(4);
    expect(polygons.every((m) => m.kind === "path")).toBe(true);
    const circles = rings({ ...radar, radarTicks: 4, radarGraticule: "circle" });
    expect(circles.map((m) => m.kind)).toEqual(["circle", "circle", "circle", "circle"]);
    const radii = circles.map((m) => (m.kind === "circle" ? m.r : 0));
    // Evenly spaced from the centre (min 0) to the edge (max 10).
    for (let k = 1; k < radii.length; k++) expect(radii[k] - radii[k - 1]).toBeCloseTo(radii[0], 6);
    const labels = layoutChart(createChartSpec({ ...radar, radarTicks: 4 }), { width: 480, height: 320 }).marks.filter((m) => m.key.startsWith("tick-y-"));
    expect(labels.map((m) => (m.kind === "text" ? m.text : ""))).toEqual(["0.0", "2.5", "5.0", "7.5", "10.0"]);
  });

  it("reads and writes Mermaid ticks and graticule", () => {
    const read = chartFromMermaid(`radar-beta\n  axis a, b, c\n  curve x{1, 2, 3}\n  ticks 3\n  graticule polygon\n`);
    expect(read.issues).toEqual([]);
    expect(read.spec).toMatchObject({ radarTicks: 3, radarGraticule: "polygon" });
    // No graticule line: Mermaid draws circles.
    expect(chartFromMermaid(`radar-beta\n  axis a, b, c\n  curve x{1, 2, 3}\n`).spec).toMatchObject({ radarTicks: null, radarGraticule: "circle" });

    const text = chartToMermaid(createChartSpec({ ...radar, radarTicks: 5 }));
    expect(text).toContain("    ticks 5\n");
    expect(text).toContain("    graticule polygon\n");
    expect(chartToMermaid(createChartSpec({ ...radar, radarGraticule: "circle" }))).not.toMatch(/ticks|graticule/);
  });

  it("round-trips both settings exactly, with or without the metadata line", () => {
    for (const extra of [{ radarTicks: 7, radarGraticule: "circle" }, { radarTicks: null, radarGraticule: "polygon" }, { radarTicks: 1, radarGraticule: "polygon" }] as const) {
      const spec = createChartSpec({ ...radar, ...extra });
      const text = chartToMermaid(spec);
      expect(text).not.toContain(CHART_MERMAID_META_PREFIX);
      expect(chartFromMermaid(text).spec).toEqual(spec);
      expect(chartFromMermaid(chartToMermaid(spec, { meta: false })).spec).toMatchObject(extra);
    }
  });

  it("reports unreadable ticks and graticule values by line", () => {
    const read = chartFromMermaid(`radar-beta\n  axis a, b, c\n  ticks none\n  graticule hex\n`);
    expect(read.issues.map((i) => i.message)).toEqual([
      'Line 3: expected ticks to be a number of rings (1 or more), got "none".',
      'Line 4: expected graticule circle or polygon, got "hex".',
    ]);
    expect(read.spec).toMatchObject({ radarTicks: null, radarGraticule: "circle" });
  });

  it("is accepted by Mermaid's own parser", async () => {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({ startOnLoad: false });
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(chartToMermaid(createChartSpec({ ...radar, radarTicks: 4 })));
    expect(diagram.type).toBe("radar");
    const options = (diagram.db as any).getOptions();
    expect(options).toMatchObject({ ticks: 4, graticule: "polygon", max: 10, min: 0 });
  });

  it("is set by agents through update_chart as one undo step", async () => {
    const controller = new ChartController({ spec: radar });
    const registry = new ToolRegistry();
    registry.register(createChartToolProvider(controller));
    const call = async (args: Record<string, unknown>) => {
      const result: any = await registry.callTool("update_chart", args);
      return { error: result.isError ? (result.content[0].text as string) : null, value: result.structuredContent as any };
    };
    const ok = await call({ radarTicks: 6, radarGraticule: "circle" });
    expect(ok.error).toBeNull();
    expect(ok.value.spec ?? ok.value).toMatchObject({ radarTicks: 6, radarGraticule: "circle" });
    expect(controller.getState().undoLabel).toBe("Change chart");
    await call({ radarTicks: null });
    expect(controller.getState().undoLabel).toBe("Change radar rings");
    expect(controller.getSpec().radarTicks).toBeNull();

    const before = controller.toJSON();
    expect((await call({ radarTicks: 0 })).error).toMatch(/radarTicks/);
    expect((await call({ radarGraticule: "hexagon" })).error).toMatch(/polygon, circle|polygon|circle/);
    expect(controller.toJSON()).toEqual(before);
  });
});
