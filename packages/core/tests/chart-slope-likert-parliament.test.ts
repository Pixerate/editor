// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools";
import {
  ChartController,
  chartFromMermaid,
  chartLikertColor,
  chartToMermaid,
  chartToOoxml,
  chartValueAtPoint,
  createChartSpec,
  createChartToolProvider,
  describeChart,
  layoutChart,
  normalizeChartSpec,
  recommendChartTypes,
  type ChartMark,
  type ChartScene,
  type ChartSpec,
} from "../src/chart";

const SIZE = { width: 640, height: 400 };
const scene = (spec: Partial<ChartSpec>) => layoutChart(createChartSpec(spec), SIZE);
const role = (s: ChartScene, r: ChartMark["role"]) => s.marks.filter((m) => m.role === r);
const byKey = (s: ChartScene, key: string) => s.marks.find((m) => m.key === key);
const rect = (m: ChartMark | undefined) => {
  if (m?.kind !== "rect") throw new Error(`expected a rect, got ${m?.kind}`);
  return m;
};

const slope: Partial<ChartSpec> = {
  type: "slope",
  categories: ["Core", "Add-ons", "Cloud"],
  series: [
    { id: "y24", name: "2024", values: [40, 30, 12] },
    { id: "y25", name: "2025", values: [52, 24, 35] },
  ],
};

const likert: Partial<ChartSpec> = {
  type: "likert",
  categories: ["Easy to use", "Good value"],
  series: [
    { id: "d", name: "Disagree", values: [10, 20] },
    { id: "n", name: "Neutral", values: [30, 30] },
    { id: "a", name: "Agree", values: [60, 50] },
  ],
};

const parliament: Partial<ChartSpec> = {
  type: "parliament",
  categories: ["Alliance", "Union", "Independents"],
  series: [{ id: "seats", name: "Seats", values: [48, 37, 15] }],
};

describe("new chart type options", () => {
  it("default sensibly and refuse bad values with sentences", () => {
    expect(createChartSpec(likert)).toMatchObject({ likertNeutral: "split", likertSort: "none", parliamentArc: 180, parliamentMajority: null, parliamentLabel: "" });
    const { spec, issues } = normalizeChartSpec({ ...parliament, likertNeutral: "middle", likertSort: "up", parliamentArc: 400, parliamentMajority: 2.5 });
    expect(spec).toMatchObject({ likertNeutral: "split", likertSort: "none", parliamentArc: 180, parliamentMajority: null });
    expect(issues.map((i) => i.message)).toEqual([
      "parliamentMajority must be a whole number of seats, 1 or more, or null for half plus one.",
      'likertNeutral must be one of "split", "separate"; got "middle".',
      'likertSort must be one of "none", "positive", "negative"; got "up".',
      "parliamentArc must be a number from 90 to 360.",
    ]);
  });
});

describe("slope charts", () => {
  it("join each category from the first series to the second, labelled at both ends", () => {
    const s = scene({ ...slope, dataLabels: true });
    const lines = role(s, "line");
    expect(lines.map((m) => m.key)).toEqual(["line-slope-0", "line-slope-1", "line-slope-2"]);
    const core = lines[0];
    if (core.kind !== "line") throw new Error("expected a line");
    // Core rises from 40 to 52: the right end is higher on screen.
    expect(core.y2).toBeLessThan(core.y1);
    expect(core.target).toEqual({ kind: "category", index: 0 });
    expect(byKey(s, "point-y25-2")?.target).toEqual({ kind: "point", seriesId: "y25", index: 2 });
    expect(byKey(s, "label-slope-left-0")).toMatchObject({ text: "Core  40", anchor: "end" });
    expect(byKey(s, "label-slope-right-2")).toMatchObject({ text: "35  Cloud", anchor: "start" });
    // The series names are the column captions; there is no legend.
    expect(role(s, "axis-title").map((m) => (m.kind === "text" ? m.text : ""))).toEqual(["2024", "2025"]);
    expect(role(s, "legend-label")).toHaveLength(0);
  });

  it("can be dragged like a line chart: the scene has a value scale", () => {
    const s = scene(slope);
    const point = byKey(s, "point-y24-0");
    if (point?.kind !== "circle") throw new Error("expected a point");
    expect(chartValueAtPoint(s, { x: point.cx, y: point.cy })).toBeCloseTo(40, 6);
  });

  it("pushes close labels apart and warns", () => {
    const s = scene({ ...slope, series: [{ name: "A", values: [10, 10.1, 10.2] }, { name: "B", values: [20, 5, 30] }] });
    const ys = ["0", "1", "2"].map((i) => byKey(s, `label-slope-left-${i}`)).map((m) => (m?.kind === "text" ? m.y : 0)).sort((a, b) => a - b);
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(11 * 1.15 - 0.01);
    expect(s.warnings.map((w) => w.code)).toContain("labels-truncated");
  });

  it("falls back to a line chart with one series and ignores extra series", () => {
    const one = scene({ ...slope, series: [slope.series![0]] });
    expect(one.warnings.find((w) => w.code === "type-fallback")?.message).toBe("A slope chart needs two series (before and after); it is drawn as a line chart until then.");
    expect(role(one, "line")).toHaveLength(1);
    const three = scene({ ...slope, series: [...slope.series!, { name: "2026", values: [1, 2, 3] }] });
    expect(three.warnings.find((w) => w.code === "values-skipped")?.message).toBe("A slope chart joins two series; 1 more is not drawn.");
  });

  it("is described by what rose and fell", () => {
    expect(describeChart(createChartSpec({ ...slope, title: "Revenue" }))).toBe("Revenue: a slope chart from 2024 to 2025: 2 of 3 rose and 1 fell. The biggest rise is Cloud (23); the biggest fall is Add-ons (-6).");
  });
});

describe("Likert charts", () => {
  it("diverge from the centre, the neutral answer straddling it", () => {
    const s = scene(likert);
    const centre = byKey(s, "axis-likert-centre");
    if (centre?.kind !== "line") throw new Error("expected the centre line");
    const neutral = rect(byKey(s, "bar-n-0"));
    expect(neutral.x + neutral.width / 2).toBeCloseTo(centre.x1, 6);
    // Disagree ends where neutral starts; agree starts where neutral ends.
    const disagree = rect(byKey(s, "bar-d-0"));
    const agree = rect(byKey(s, "bar-a-0"));
    expect(disagree.x + disagree.width).toBeCloseTo(neutral.x, 6);
    expect(agree.x).toBeCloseTo(neutral.x + neutral.width, 6);
    // Shares of the question: 60% agree is twice the width of 30% neutral.
    expect(agree.width).toBeCloseTo(neutral.width * 2, 6);
    expect(s.percent).toBe(true);
    expect(s.valueScale).toBeUndefined();
  });

  it("colours answers from orange (disagree) through grey to purple (agree)", () => {
    expect([0, 1, 2].map((i) => chartLikertColor(3, i))).toEqual(["#e66101", "#d4d4d8", "#5e3c99"]);
    expect([0, 1, 2, 3, 4].map((i) => chartLikertColor(5, i))).toEqual(["#e66101", "#fdb863", "#d4d4d8", "#b2abd2", "#5e3c99"]);
    expect(chartLikertColor(12, 0)).toBe("#b35806");
    expect(chartLikertColor(12, 11)).toBe("#542788");
    const s = scene(likert);
    expect(rect(byKey(s, "bar-a-1")).fill).toBe("#5e3c99");
    expect(role(s, "legend-swatch").map((m) => (m.kind === "rect" ? m.fill : ""))).toEqual(["#e66101", "#d4d4d8", "#5e3c99"]);
    // A series colour still wins.
    expect(rect(byKey(scene({ ...likert, series: [{ ...likert.series![0], color: "#000" }, ...likert.series!.slice(1)] }), "bar-d-0")).fill).toBe("#000");
  });

  it("sorts questions by agreement or disagreement", () => {
    const rowY = (s: ChartScene, i: number) => rect(byKey(s, `bar-a-${i}`)).y;
    const asGiven = scene(likert);
    expect(rowY(asGiven, 0)).toBeLessThan(rowY(asGiven, 1));
    const negative = scene({ ...likert, likertSort: "negative" });
    // "Good value" has more disagreement, so it comes first.
    expect(rowY(negative, 1)).toBeLessThan(rowY(negative, 0));
  });

  it("draws the neutral answer in its own column when asked", () => {
    const s = scene({ ...likert, likertNeutral: "separate" });
    const neutral = rect(byKey(s, "bar-n-0"));
    const agree = rect(byKey(s, "bar-a-0"));
    expect(neutral.x).toBeGreaterThan(agree.x + agree.width);
    expect(byKey(s, "likert-neutral-title")).toMatchObject({ text: "Neutral" });
    const even = scene({ ...likert, likertNeutral: "separate", series: [likert.series![0], likert.series![2]] });
    expect(even.warnings.find((w) => w.code === "type-fallback")?.message).toBe("A separate neutral column needs an odd number of answers; the middle answer is not set apart.");
  });

  it("is described by agreement", () => {
    expect(describeChart(createChartSpec(likert))).toBe("A likert chart of 2 questions with 3 answers from Disagree to Agree. Most positive: Easy to use (60%); least: Good value (50%).");
  });
});

describe("parliament charts", () => {
  it("draws one dot per seat, each group's seats together from the left", () => {
    const s = scene(parliament);
    const seats = role(s, "point");
    expect(seats).toHaveLength(100);
    const xs = (index: number) => seats.filter((m) => m.target?.kind === "point" && m.target.index === index).map((m) => (m.kind === "circle" ? m.cx : 0));
    const mean = (v: number[]) => v.reduce((t, x) => t + x, 0) / v.length;
    expect(xs(0)).toHaveLength(48);
    expect(mean(xs(0))).toBeLessThan(mean(xs(1)));
    expect(mean(xs(1))).toBeLessThan(mean(xs(2)));
    // Each group has one colour and the legend gives the seats.
    expect(new Set(seats.filter((m) => m.target?.kind === "point" && m.target.index === 1).map((m) => (m.kind === "circle" ? m.fill : ""))).size).toBe(1);
    expect(role(s, "legend-label").map((m) => (m.kind === "text" ? m.text : ""))).toEqual(["Alliance 48", "Union 37", "Independents 15"]);
    expect(byKey(s, "parliament-total")).toMatchObject({ text: "100" });
    expect(byKey(s, "parliament-caption")).toMatchObject({ text: "seats" });
  });

  it("draws the majority line where the majority falls", () => {
    const s = scene(parliament);
    expect(byKey(s, "majority-label")).toMatchObject({ text: "Majority 51" });
    const line = byKey(s, "majority-line");
    if (line?.kind !== "line") throw new Error("expected the majority line");
    // 51 of 100 seats on a half circle: just right of straight up.
    expect(line.x2).toBeGreaterThan(line.x1 - 0.001);
    expect(Math.abs(line.x2 - line.x1)).toBeLessThan(Math.abs(line.y2 - line.y1) * 0.2);
    const custom = scene({ ...parliament, parliamentMajority: 67, parliamentLabel: "members" });
    expect(byKey(custom, "majority-label")).toMatchObject({ text: "Majority 67" });
    expect(byKey(custom, "parliament-caption")).toMatchObject({ text: "members" });
    const tooMany = scene({ ...parliament, parliamentMajority: 500 });
    expect(byKey(tooMany, "majority-line")).toBeUndefined();
    expect(tooMany.warnings.map((w) => w.message)).toContain("The majority of 500 is more than the 100 seats; the majority line is not drawn.");
  });

  it("rounds seats, handles other sweeps and empty or huge charts", () => {
    const rounded = scene({ ...parliament, series: [{ name: "S", values: [2.6, -1, 3] }] });
    expect(role(rounded, "point")).toHaveLength(6);
    expect(rounded.warnings.map((w) => w.message)).toContain("Seats are whole numbers of 0 or more; other values were rounded.");
    expect(role(scene({ ...parliament, parliamentArc: 300 }), "point")).toHaveLength(100);
    expect(byKey(scene({ ...parliament, series: [{ name: "S", values: [0, 0, 0] }] }), "empty")).toMatchObject({ text: "No seats" });
    expect(byKey(scene({ ...parliament, series: [{ name: "S", values: [3000, 1, 1] }] }), "empty")).toMatchObject({ text: "Too many seats to draw (more than 2,000)" });
    for (const m of scene(parliament).marks) if (m.kind === "circle") expect(Number.isFinite(m.cx) && Number.isFinite(m.cy) && m.r > 0).toBe(true);
  });

  it("is described by who holds the majority", () => {
    expect(describeChart(createChartSpec(parliament))).toBe("A parliament chart of 100 seats across 3 groups: no group reaches the majority of 51; the largest is Alliance with 48.");
    expect(describeChart(createChartSpec({ ...parliament, series: [{ name: "S", values: [60, 30, 10] }] }))).toBe("A parliament chart of 100 seats across 3 groups: Alliance holds a majority with 60.");
  });
});

describe("in files, recommendations and agent tools", () => {
  it("round-trip through Mermaid and say what Office cannot hold", () => {
    for (const input of [slope, likert, { ...parliament, parliamentArc: 240 }]) {
      const spec = createChartSpec(input);
      expect(chartFromMermaid(chartToMermaid(spec)).spec).toEqual(spec);
    }
    expect(chartToMermaid(createChartSpec(parliament), { meta: false })).toMatch(/^pie/);
    expect(chartToOoxml(createChartSpec(likert)).issues).toContain("Likert charts are written as 100% stacked horizontal bars: DrawingML has no diverging bar.");
    expect(chartToOoxml(createChartSpec(likert)).xml).toContain('<c:grouping val="percentStacked"/>');
    expect(chartToOoxml(createChartSpec(parliament)).xml).toContain("<c:doughnutChart>");
    expect(chartToOoxml(createChartSpec(slope)).xml).toContain("<c:lineChart>");
  });

  it("are recommended for data that suits them", () => {
    const types = (rows: unknown[][]) => recommendChartTypes(rows).map((r) => r.type);
    expect(types([["", "2024", "2025"], ["Core", 40, 52], ["Cloud", 12, 35]])).toContain("slope");
    expect(types([["", "Disagree", "Neutral", "Agree"], ["Easy", 10, 30, 60], ["Value", 20, 30, 50]])).toContain("likert");
    expect(types([["", "Seats"], ["Alliance", 48], ["Union", 37]])).toContain("parliament");
  });

  it("are set through update_chart, with the options checked", async () => {
    const controller = new ChartController({ spec: likert });
    const registry = new ToolRegistry();
    registry.register(createChartToolProvider(controller));
    const call = async (args: Record<string, unknown>) => {
      const result: any = await registry.callTool("update_chart", args);
      return result.isError ? (result.content[0].text as string) : null;
    };
    expect(await call({ likertSort: "positive", likertNeutral: "separate" })).toBeNull();
    expect(controller.getSpec()).toMatchObject({ likertSort: "positive", likertNeutral: "separate" });
    expect(await call({ type: "parliament", parliamentArc: 270, parliamentMajority: 40, parliamentLabel: "MPs" })).toBeNull();
    expect(controller.getSpec()).toMatchObject({ type: "parliament", parliamentArc: 270, parliamentMajority: 40, parliamentLabel: "MPs" });
    const before = controller.toJSON();
    expect(await call({ parliamentArc: 45 })).toMatch(/parliamentArc/);
    expect(await call({ likertSort: "sideways" })).toMatch(/likertSort/);
    expect(controller.toJSON()).toEqual(before);
    controller.update({ parliamentMajority: null }, {});
    expect(controller.getState().undoLabel).toBe("Change majority");
  });
});
