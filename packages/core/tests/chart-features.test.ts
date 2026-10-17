import { describe, expect, it } from "vitest";
import {
  CHART_COLOR_SCHEMES,
  CHART_PALETTE_SHADES,
  CHART_TYPES,
  ChartController,
  analyzeChartTable,
  chartBoxStats,
  chartColorDistance,
  chartContrastRatio,
  chartDateLabels,
  chartFamily,
  chartFromTable,
  chartHistogram,
  chartHitTest,
  chartMovingAverage,
  chartQuantile,
  chartSquarify,
  chartToSvg,
  chartTrendlineName,
  checkChartColors,
  compileChartFormatCode,
  createChartSpec,
  cyclePaletteColor,
  decimateChartPoints,
  describeChart,
  fitChartTrendline,
  formatChartNumber,
  handleChartKey,
  layoutChart,
  layoutSparkline,
  monochromeChartPalette,
  normalizeChartSpec,
  parseChartColor,
  parseChartDate,
  recommendChartTypes,
  shadeChartColor,
  simulateChartVision,
  snapChartDragValue,
  sparklineToSvg,
  startChartPointDrag,
  summarizeChart,
  summarizeChartSeries,
  trendNumberText,
  type ChartMark,
  type ChartScene,
  type ChartSpec,
} from "../src/chart";

const numbers = (m: ChartMark): number[] => {
  switch (m.kind) {
    case "rect":
      return [m.x, m.y, m.width, m.height];
    case "circle":
      return [m.cx, m.cy, m.r];
    case "line":
      return [m.x1, m.y1, m.x2, m.y2];
    case "text":
      return [m.x, m.y];
    case "path":
      return (m.d.match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
  }
};
const finiteScene = (scene: ChartScene) => scene.marks.every((m) => numbers(m).every(Number.isFinite) && !/NaN|Infinity/.test(m.kind === "path" ? m.d : ""));
const roles = (scene: ChartScene, role: string) => scene.marks.filter((m) => m.role === role);

const sample: Partial<ChartSpec> = {
  categories: ["Q1", "Q2", "Q3", "Q4"],
  series: [
    { id: "a", name: "A", values: [10, 20, 30, 40] },
    { id: "b", name: "B", values: [5, -5, 15, 10] },
  ],
};

describe("chart spec: new fields", () => {
  it("normalizes axes, series options, trendlines and layout fields", () => {
    const { spec, issues } = normalizeChartSpec({
      ...sample,
      yAxis2: { format: { style: "percent" }, step: 0.1 },
      xAxis: { kind: "date" },
      gapWidth: 0.5,
      overlap: 0.2,
      bins: 12,
      labelPosition: "inside",
      series: [
        { id: "a", name: "A", values: [1, 2, 3, 4], axis: "secondary", marker: "diamond", curve: "step", dataLabels: true, format: { code: "0.0%" }, pointColors: ["#ff0000"], trendlines: [{ type: "polynomial", order: 3, showR2: true }] },
        { id: "x", name: "X", values: [1, 2, 3, 4], x: [1, 2, null, 4], sizes: [1, 2, 3, 4] },
      ],
    });
    expect(issues).toEqual([]);
    expect(spec.yAxis2).toMatchObject({ step: 0.1, format: { style: "percent" } });
    expect(spec.xAxis.kind).toBe("date");
    expect(spec).toMatchObject({ gapWidth: 0.5, overlap: 0.2, bins: 12, labelPosition: "inside", showTotal: true });
    expect(spec.series[0]).toMatchObject({ axis: "secondary", marker: "diamond", curve: "step", dataLabels: true, format: { code: "0.0%" }, pointColors: ["#ff0000", null, null, null] });
    expect(spec.series[0].trendlines).toEqual([{ type: "polynomial", order: 3, showR2: true }]);
    expect(spec.series[1]).toMatchObject({ x: [1, 2, null, 4], sizes: [1, 2, 3, 4] });
  });

  it("reports bad new fields as sentences and falls back", () => {
    const { spec, issues } = normalizeChartSpec({
      ...sample,
      yAxis: { step: -1 },
      gapWidth: 2,
      series: [{ id: "a", name: "A", values: [1], marker: "star", trendlines: [{ type: "logarithmic", intercept: 3 }, { type: "polynomial", order: 9 }], sizes: [-1] }],
    });
    expect(spec.yAxis.step).toBeNull();
    expect(spec.gapWidth).toBe(0.28);
    expect(issues.map((i) => i.message).join(" ")).toMatch(/step must be greater than 0/);
    expect(issues.map((i) => i.message).join(" ")).toMatch(/gapWidth must be a number from 0 to 0.9/);
    expect(issues.map((i) => i.message).join(" ")).toMatch(/marker must be one of/);
    expect(issues.map((i) => i.message).join(" ")).toMatch(/A logarithmic trendline cannot have a fixed intercept/);
    expect(issues.map((i) => i.message).join(" ")).toMatch(/order must be a whole number from 2 to 6/);
    expect(issues.map((i) => i.message).join(" ")).toMatch(/sizes must not be negative/);
  });

  it("knows each type's family", () => {
    expect(chartFamily({ type: "scatter", series: [{ id: "a", name: "A", values: [1] }] })).toBe("cartesian");
    expect(chartFamily({ type: "scatter", series: [{ id: "a", name: "A", values: [1], x: [2] }] })).toBe("xy");
    expect(chartFamily({ type: "bubble", series: [] })).toBe("xy");
    expect(chartFamily({ type: "donut", series: [] })).toBe("pie");
    expect(chartFamily({ type: "waterfall", series: [] })).toBe("waterfall");
  });
});

describe("chart layout: every type", () => {
  const specFor = (type: ChartSpec["type"]) =>
    createChartSpec({
      type,
      title: `A ${type} chart`,
      categories: ["a", "b", "c", "d", "e", "f"],
      series: [
        { id: "s1", name: "One", values: [3, -1, 4, 1, 5, 9], x: type === "scatter" || type === "bubble" ? [1, 2, 3, 4, 5, 6] : undefined, sizes: type === "bubble" ? [1, 4, 9, 2, 3, 5] : undefined },
        { id: "s2", name: "Two", values: [2, 7, 1, 8, 2, 8] },
      ],
    });

  it.each(CHART_TYPES)("lays out a %s chart with finite marks", (type) => {
    const scene = layoutChart(specFor(type), { width: 480, height: 300 });
    expect(finiteScene(scene)).toBe(true);
    expect(scene.marks.length).toBeGreaterThan(5);
    expect(roles(scene, "empty")).toHaveLength(0);
    expect(chartToSvg(specFor(type), { width: 480, height: 300 })).not.toMatch(/NaN|Infinity/);
  });

  it("draws the family's own marks", () => {
    const at = (type: ChartSpec["type"]) => layoutChart(specFor(type), { width: 480, height: 300 });
    expect(roles(at("waterfall"), "connector").length).toBeGreaterThan(0);
    expect(roles(at("box"), "box")).toHaveLength(2);
    expect(roles(at("treemap"), "cell").length).toBe(5); // the -1 is left out
    expect(roles(at("funnel"), "bar").length).toBe(6); // widths by |value|
    expect(roles(at("radar"), "grid").length).toBeGreaterThan(0);
    expect(roles(at("histogram"), "bar").length).toBeGreaterThan(0);
    expect(at("bubble").xScale).toBeDefined();
  });

  it("puts series on a secondary axis with its own scale on the right", () => {
    const spec = createChartSpec({
      categories: ["a", "b"],
      series: [
        { id: "big", name: "Big", values: [1000, 2000] },
        { id: "pct", name: "Pct", values: [0.2, 0.4], type: "line", axis: "secondary" },
      ],
      yAxis2: { format: { style: "percent" }, title: "Share" },
    });
    const scene = layoutChart(spec, { width: 400, height: 300 });
    expect(scene.valueScale!.domain[1]).toBeGreaterThanOrEqual(2000);
    expect(scene.valueScale2!.domain[1]).toBeLessThan(1);
    const y2 = scene.marks.filter((m) => m.key.startsWith("tick-y2-"));
    expect(y2.length).toBeGreaterThan(1);
    expect(y2.every((m) => m.kind === "text" && m.anchor === "start" && m.x > scene.plot.x + scene.plot.width)).toBe(true);
    expect(y2.map((m) => (m as any).text)).toContain("40%");
    expect(scene.marks.find((m) => m.key === "axis-title-y2")).toMatchObject({ text: "Share", rotate: 90 });
  });

  it("uses gap width and overlap for bar geometry", () => {
    const wide = layoutChart(createChartSpec({ ...sample, gapWidth: 0 }), { width: 400, height: 300 });
    const narrow = layoutChart(createChartSpec({ ...sample, gapWidth: 0.8 }), { width: 400, height: 300 });
    const w = (s: ChartScene) => (roles(s, "bar")[0] as any).width;
    expect(w(wide)).toBeGreaterThan(w(narrow) * 3);
    const overlapped = layoutChart(createChartSpec({ ...sample, overlap: 1 }), { width: 400, height: 300 });
    const bars = roles(overlapped, "bar") as any[];
    expect(Math.abs(bars[0].x - bars[4].x)).toBeLessThan(1); // overlap 1 (clamped to 0.99): bars share a slot
  });

  it("honours a fixed axis step", () => {
    const scene = layoutChart(createChartSpec({ ...sample, yAxis: { step: 7 } }), { width: 400, height: 300 });
    expect(scene.valueScale!.ticks.slice(0, 3)).toEqual([-7, 0, 7]);
  });

  it("draws per-point colours, markers and per-series labels", () => {
    const spec = createChartSpec({
      type: "line",
      categories: ["a", "b"],
      series: [{ id: "s", name: "S", values: [1, 2], marker: "square", pointColors: [null, "#123456"], dataLabels: true, format: { code: '0.0"x"' } }],
    });
    const scene = layoutChart(spec, { width: 300, height: 200 });
    const points = roles(scene, "point");
    expect(points.every((m) => m.kind === "path")).toBe(true);
    expect((points[1] as any).stroke).toBe("#123456");
    expect(roles(scene, "data-label").map((m) => (m as any).text)).toEqual(["1.0x", "2.0x"]);
  });

  it("fits trendlines, labels them and lists them in the legend", () => {
    const spec = createChartSpec({
      type: "scatter",
      categories: ["a", "b", "c", "d"],
      series: [{ id: "s", name: "Sales", values: [2, 4, 6, 8], trendlines: [{ type: "linear", showEquation: true, showR2: true, forward: 1 }] }],
    });
    const scene = layoutChart(spec, { width: 400, height: 300 });
    expect(roles(scene, "trendline")).toHaveLength(1);
    expect(roles(scene, "trendline-label").map((m) => (m as any).text)).toEqual(["y = 2x", "R² = 1"]);
    expect(roles(scene, "legend-label").map((m) => (m as any).text)).toContain("Linear (Sales)");
    expect(roles(scene, "trendline")[0].target).toEqual({ kind: "trendline", seriesId: "s", index: 0 });
  });

  it("reads date categories and labels them by calendar steps", () => {
    const categories = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2023, 0, 1 + i * 7)).toISOString().slice(0, 10));
    const scene = layoutChart(createChartSpec({ type: "line", xAxis: { kind: "date" }, categories, series: [{ name: "S", values: categories.map((_, i) => i) }] }), { width: 600, height: 300 });
    const labels = scene.marks.filter((m) => m.key.startsWith("tick-x-")).map((m) => (m as any).text);
    expect(labels[0]).toBe("Jan 2023");
    expect(labels.length).toBeLessThan(20);
    expect(labels).toContain("Jan 2024");
  });

  it("reports hidden labels, thinned lines and junk values instead of failing", () => {
    const many = createChartSpec({ categories: Array.from({ length: 200 }, (_, i) => `Category ${i}`), series: [{ name: "S", values: Array.from({ length: 200 }, (_, i) => i) }] });
    expect(layoutChart(many, { width: 400, height: 300 }).warnings.map((w) => w.code)).toContain("labels-hidden");
    const long = createChartSpec({ type: "line", points: false, categories: Array.from({ length: 5000 }, (_, i) => `${i}`), series: [{ name: "S", values: Array.from({ length: 5000 }, (_, i) => Math.sin(i)) }] });
    const scene = layoutChart(long, { width: 400, height: 300 });
    expect(scene.warnings.map((w) => w.code)).toContain("points-decimated");
    const labelled = layoutChart(createChartSpec({ ...long, dataLabels: true }), { width: 400, height: 300 });
    expect(labelled.warnings.find((w) => w.code === "data-labels-hidden")?.message).toBe('Data labels are off for "S": it has more than 200 points.');
    const junk = layoutChart(createChartSpec({ type: "line", categories: ["a", "b", "c"], series: [{ name: "S", values: [1, 1e308, -1e308] }] }), { width: 400, height: 300 });
    expect(finiteScene(junk)).toBe(true);
  });

  it("caps a top or bottom legend at 30% of the height", () => {
    const series = Array.from({ length: 40 }, (_, i) => ({ name: `A long series name ${i}`, values: [i] }));
    const scene = layoutChart(createChartSpec({ categories: ["a"], series }), { width: 300, height: 200 });
    expect(scene.warnings.map((w) => w.code)).toContain("legend-truncated");
    expect(scene.plot.height).toBeGreaterThan(40);
  });

  it("writes a readout next to a dragged point, inside the plot", () => {
    const scene = layoutChart(createChartSpec(sample), { width: 400, height: 300, readout: { seriesId: "a", index: 3 } });
    const text = scene.marks.find((m) => m.key === "drag-readout") as any;
    expect(text.text).toBe("Q4: 40");
    const box = scene.marks.find((m) => m.key === "drag-readout-box") as any;
    expect(box.y).toBeGreaterThanOrEqual(scene.plot.y);
    expect(box.x + box.width).toBeLessThanOrEqual(scene.plot.x + scene.plot.width + 0.01);
  });

  it("colours labels on bars by contrast and drops labels that do not fit", () => {
    const spec = createChartSpec({ categories: ["a", "b"], stacking: "stacked", dataLabels: true, palette: ["#efb118", "#1e3a8a"], series: [{ name: "Y", values: [50, 1] }, { name: "N", values: [50, 50] }] });
    const scene = layoutChart(spec, { width: 300, height: 300 });
    const labels = roles(scene, "data-label") as any[];
    expect(labels.find((l) => l.key === "label-series-1-0").fill).toBe("#0f172a");
    expect(labels.find((l) => l.key === "label-series-2-0").fill).toBe("#ffffff");
    expect(labels.find((l) => l.key === "label-series-1-1")).toBeUndefined();
  });
});

describe("trendline maths", () => {
  it("fits linear, polynomial, exponential, logarithmic and power data exactly", () => {
    const xs = [1, 2, 3, 4, 5];
    const fit = (type: any, f: (x: number) => number, extra = {}) => fitChartTrendline({ type, ...extra }, xs.map((x) => [x, f(x)] as [number, number]))!;
    const lin = fit("linear", (x) => 3 * x + 1);
    expect(lin.coefficients.map((c) => Number(c.toFixed(9)))).toEqual([1, 3]);
    expect(lin.r2).toBeCloseTo(1, 12);
    expect(lin.equation).toBe("y = 3x + 1");
    const poly = fit("polynomial", (x) => 0.5 * x * x - 2 * x + 1, { order: 2 });
    expect(poly.equation).toBe("y = 0.5x² - 2x + 1");
    expect(poly.evaluate(10)).toBeCloseTo(31, 9);
    const exp = fit("exponential", (x) => 3 * Math.exp(0.2 * x));
    expect(exp.equation).toBe("y = 3e^(0.2x)");
    const log = fit("logarithmic", (x) => 2 * Math.log(x) + 5);
    expect(log.equation).toBe("y = 2ln(x) + 5");
    expect(log.evaluate(-1)).toBeNull();
    const pow = fit("power", (x) => 4 * Math.pow(x, 1.5));
    expect(pow.equation).toBe("y = 4x^1.5");
  });

  it("forces the intercept and uses the uncentred R²", () => {
    const fit = fitChartTrendline({ type: "linear", intercept: 0 }, [[1, 2], [2, 4.1], [3, 5.9]])!;
    expect(fit.coefficients[0]).toBe(0);
    expect(fit.coefficients[1]).toBeCloseTo(1.9929, 3);
    expect(fit.r2).toBeGreaterThan(0.99);
  });

  it("returns null for degenerate data and skips points a transform cannot take", () => {
    expect(fitChartTrendline({ type: "linear" }, [[1, 1]])).toBeNull();
    expect(fitChartTrendline({ type: "linear" }, [[2, 1], [2, 3]])).toBeNull();
    expect(fitChartTrendline({ type: "polynomial", order: 3 }, [[1, 1], [2, 2], [3, 3]])).toBeNull();
    expect(fitChartTrendline({ type: "exponential" }, [[1, -1], [2, 2], [3, 4]])!.points).toBe(2);
    expect(fitChartTrendline({ type: "linear" }, [[1, 5], [2, 5]])!.r2).toBeNull();
  });

  it("computes moving averages, names and number text like a spreadsheet", () => {
    expect(chartMovingAverage([[1, 2], [2, 4], [3, 6], [4, 8]], 2)).toEqual([[2, 3], [3, 5], [4, 7]]);
    expect(chartMovingAverage([[1, 2]], 3)).toEqual([]);
    expect(chartTrendlineName({ type: "moving-average", period: 3 }, "Sales")).toBe("3 per. Mov. Avg. (Sales)");
    expect(chartTrendlineName({ type: "exponential" }, "Sales")).toBe("Expon. (Sales)");
    expect(trendNumberText(0.000012345)).toBe("1.2345E-05");
    expect(trendNumberText(2.5)).toBe("2.5");
    expect(trendNumberText(-0)).toBe("0");
  });
});

describe("chart statistics", () => {
  it("bins right-inclusive with the first bin closed", () => {
    const bins = chartHistogram([1, 2, 3, 4, 5, 6, 7, 8, 9], 3);
    expect(bins.map((b) => b.count)).toEqual([3, 3, 3]);
    expect(bins[0].from).toBe(1);
    expect(bins[0].to).toBeCloseTo(11 / 3, 9);
    expect(bins[2].to).toBe(9);
    // A value on an edge belongs to the bin that ends there.
    expect(chartHistogram([0, 5, 10], 2).map((b) => b.count)).toEqual([2, 1]);
    expect(chartHistogram([5, 5, 5])).toEqual([{ from: 5, to: 5, count: 3 }]);
    expect(chartHistogram([null, null])).toEqual([]);
    expect(chartHistogram(Array.from({ length: 100 }, (_, i) => i)).length).toBe(10);
  });

  it("computes quartiles, whiskers and outliers (Tukey)", () => {
    expect(chartQuantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    const st = chartBoxStats([1, 2, 3, 4, 5, 6, 7, 8, 100])!;
    expect(st).toMatchObject({ q1: 3, median: 5, q3: 7, upperWhisker: 8, lowerWhisker: 1, outliers: [100], count: 9 });
    expect(chartBoxStats([null])).toBeNull();
  });

  it("squarifies a treemap: areas proportional, inside the box", () => {
    const rect = { x: 0, y: 0, width: 300, height: 200 };
    const values = [6, 6, 4, 3, 2, 2, 1, 0, -2];
    const cells = chartSquarify(values, rect);
    const total = values.filter((v) => v > 0).reduce((a, b) => a + b, 0);
    cells.forEach((c, i) => {
      if (values[i] <= 0) return expect(c.width * c.height).toBe(0);
      expect(c.width * c.height).toBeCloseTo((values[i] / total) * 60000, 3);
      expect(c.x).toBeGreaterThanOrEqual(-1e-9);
      expect(c.x + c.width).toBeLessThanOrEqual(300 + 1e-6);
      expect(c.y + c.height).toBeLessThanOrEqual(200 + 1e-6);
    });
  });

  it("decimates long polylines keeping each column's extremes", () => {
    const pts = Array.from({ length: 10000 }, (_, i) => ({ x: i / 50, y: Math.sin(i) * 10 }));
    const out = decimateChartPoints(pts, 2000);
    expect(out.length).toBeLessThan(pts.length);
    expect(Math.max(...out.map((p) => p.y))).toBe(Math.max(...pts.map((p) => p.y)));
    expect(Math.min(...out.map((p) => p.y))).toBe(Math.min(...pts.map((p) => p.y)));
    expect(out[0]).toBe(pts[0]);
    expect(out[out.length - 1]).toBe(pts[pts.length - 1]);
  });

  it("summarizes a series", () => {
    expect(summarizeChartSeries({ id: "s", name: "S", values: [10, null, 30, 20] }, ["a", "b", "c", "d"])).toEqual({
      id: "s", name: "S", count: 3, gaps: 1, min: 10, max: 30, mean: 20, sum: 60, minAt: "a", maxAt: "c", trend: "rising", change: 1,
    });
  });
});

describe("chart colours", () => {
  it("parses, shades and cycles palettes", () => {
    expect(parseChartColor("#fff")).toEqual([1, 1, 1]);
    expect(parseChartColor("rgb(255, 0, 0)")).toEqual([1, 0, 0]);
    expect(parseChartColor("var(--x)")).toBeNull();
    expect(shadeChartColor("#000000", 0.5)).toBe("#808080");
    expect(shadeChartColor("var(--x)", 0.5)).toBe("var(--x)");
    const palette = ["#4269d0", "#efb118"];
    const seen = Array.from({ length: palette.length * CHART_PALETTE_SHADES.length }, (_, i) => cyclePaletteColor(palette, i));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen[0]).toBe("#4269d0");
  });

  it("measures contrast and colour-blind distinctness", () => {
    expect(chartContrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    const red = parseChartColor("#d62728")!;
    const green = parseChartColor("#2ca02c")!;
    expect(chartColorDistance(red, green)).toBeGreaterThan(0.15);
    expect(chartColorDistance(simulateChartVision(red, "deuteranopia"), simulateChartVision(green, "deuteranopia"))).toBeLessThan(chartColorDistance(red, green));
    const check = checkChartColors(["#ff0000", "#ee1100", "#ffffff"]);
    expect(check.ok).toBe(false);
    expect(check.issues.join(" ")).toMatch(/hard to tell apart/);
    expect(check.issues.join(" ")).toMatch(/barely stands out/);
    expect(checkChartColors(CHART_COLOR_SCHEMES.find((s) => s.id === "okabe-ito")!.palette.slice(0, 7), { visions: ["normal"], minContrast: 1 }).ok).toBe(true);
  });

  it("builds monochrome palettes from dark to light", () => {
    const p = monochromeChartPalette("#3366cc", 4);
    expect(p).toHaveLength(4);
    const lum = p.map((c) => parseChartColor(c)!.reduce((a, b) => a + b, 0));
    expect([...lum].sort((a, b) => a - b)).toEqual(lum);
  });
});

describe("chart number formats, dates and summaries", () => {
  it("formats labels with spreadsheet format codes", () => {
    expect(formatChartNumber(1234567, { code: '#,##0.0,,"M"' })).toBe("1.2M");
    expect(formatChartNumber(-1234, { code: "$#,##0;($#,##0)" })).toBe("($1,234)");
    expect(formatChartNumber(0.256, { code: "0.0%", prefix: "≈" })).toBe("≈25.6%");
    expect(compileChartFormatCode("yyyy-mm-dd")).toMatchObject({ isDate: true });
    expect(compileChartFormatCode("yyyy-mm-dd").format(45000)).toBe("2023-03-15");
  });

  it("reads dates and picks a calendar step that fits", () => {
    expect(parseChartDate("2024")).toBe(Date.UTC(2024, 0, 1));
    expect(parseChartDate("2024-03")).toBe(Date.UTC(2024, 2, 1));
    expect(parseChartDate("5 Mar 2024")).toBe(Date.UTC(2024, 2, 5));
    expect(parseChartDate("2024-02-30")).toBeNull();
    expect(parseChartDate("Q1")).toBeNull();
    const months = Array.from({ length: 24 }, (_, i) => `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`);
    const wide = chartDateLabels(months, 60, (t) => t.length * 6)!;
    expect(wide.step).toEqual({ unit: "month", count: 1 });
    expect(wide.labels.get(0)).toBe("Jan 2024");
    expect(wide.labels.get(1)).toBe("Feb");
    const narrow = chartDateLabels(months, 6, (t) => t.length * 6)!;
    expect(narrow.step.unit === "year" || narrow.step.count > 1).toBe(true);
    expect(chartDateLabels(["a", "b", "c"], 50, (t) => t.length)).toBeNull();
  });

  it("describes and summarizes charts for agents and screen readers", () => {
    const spec = createChartSpec({ title: "Revenue", ...sample });
    const summary = summarizeChart(spec, { width: 400, height: 300 });
    expect(summary.series.map((s) => s.max)).toEqual([40, 15]);
    expect(summary.valueAxis!.ticks.length).toBeGreaterThan(2);
    expect(summary.colors.ok).toBe(true);
    expect(summary.description).toMatch(/^Revenue: a bar chart showing 2 series over 4 categories \(Q1 to Q4\)\. A ranges from 10 \(Q1\) to 40 \(Q4\), rising, up 300% from first to last\./);
    expect(describeChart(createChartSpec({ type: "pie", categories: ["a", "b"], series: [{ name: "S", values: [3, 1] }] }))).toBe("A pie chart of S across 2 categories, totalling 4. The largest is a at 3 (75%); the smallest is b at 1 (25%).");
    expect(describeChart(createChartSpec({ type: "waterfall", categories: ["a", "b", "Total"], series: [{ name: "Cash", values: [5, -2, null] }] }))).toBe("A waterfall chart of Cash: 1 increase and 1 decrease over 3 steps, ending at a total of 3.");
  });

  it("writes an accessible SVG with <title> and <desc>", () => {
    const svg = chartToSvg(createChartSpec({ title: "Sales", ...sample }), { width: 300, height: 200 });
    expect(svg).toContain('aria-labelledby="chart-title chart-desc"');
    expect(svg).toContain('<title id="chart-title">Sales</title>');
    expect(svg).toMatch(/<desc id="chart-desc">Sales: a bar chart/);
  });
});

describe("sparklines", () => {
  it("draws lines broken at gaps, columns and win/loss bars", () => {
    const line = layoutSparkline([1, 2, null, 3, 4], { width: 80, height: 20 });
    expect(line.marks).toHaveLength(1);
    expect((line.marks[0] as any).d.match(/M/g)).toHaveLength(2);
    const col = layoutSparkline([1, -2, 3], { kind: "column", width: 60, height: 20, negativeColor: "#f00" });
    expect(col.marks.map((m) => (m as any).fill)).toEqual(["#4269d0", "#f00", "#4269d0"]);
    const wl = layoutSparkline([5, -1, 0, 2], { kind: "win-loss", width: 60, height: 20 });
    expect(wl.marks).toHaveLength(3);
    expect(new Set(wl.marks.map((m) => (m as any).height)).size).toBe(1);
    expect(layoutSparkline([1, 3, 2], { width: 60, height: 20, highLow: true }).marks.map((m) => m.key)).toEqual(["sparkline", "high", "low"]);
    expect(sparklineToSvg([1, 2], { width: 40, height: 10, ariaLabel: "Up" })).toContain('aria-label="Up"');
  });
});

describe("chart recommendations", () => {
  it("reads table shapes the spreadsheet way", () => {
    expect(analyzeChartTable([["", "North", "South"], ["A", 1, 2], ["B", 3, 4]])).toMatchObject({ headerRow: true, labelColumn: true, series: 2, points: 2 });
    // Numbers in the first row are data, not series names.
    expect(analyzeChartTable([["", "2023", "2024"], ["A", 1, 2]])).toMatchObject({ headerRow: false });
    expect(analyzeChartTable([["", "Sales"], [2021, 5], [2022, 6]])).toMatchObject({ headerRow: true, labelColumn: true });
    expect(analyzeChartTable([[1, 2], [2, 4], [3, 6]])).toMatchObject({ headerRow: false, labelColumn: false, series: 2 });
  });

  it("recommends types for the shape", () => {
    expect(recommendChartTypes([[1, 2], [2, 4], [3, 7]])[0].type).toBe("scatter");
    expect(recommendChartTypes([["Month", "Sales"], ["2024-01", 1], ["2024-02", 2], ["2024-03", 3]])[0].type).toBe("line");
    const shares = recommendChartTypes([["Item", "Share"], ["a", 1], ["b", 2], ["c", 3]]).map((r) => r.type);
    expect(shares).toContain("pie");
    expect(recommendChartTypes([["Step", "Delta"], ["a", 5], ["b", -2], ["c", 3]]).map((r) => r.type)).toContain("waterfall");
    expect(recommendChartTypes([["x"], ...Array.from({ length: 30 }, (_, i) => [i])])[0].type).toBe("histogram");
    expect(recommendChartTypes([["a", "b"], ["c", "d"]])).toEqual([]);
  });

  it("builds data from a table, taking x from the first column for scatters", () => {
    const built = chartFromTable([[1, 2], [2, 4], [3, 7]]);
    expect(built.type).toBe("scatter");
    expect(built.series).toHaveLength(1);
    expect(built.series[0].x).toEqual([1, 2, 3]);
    expect(built.series[0].values).toEqual([2, 4, 7]);
  });
});

describe("chart controller: new operations", () => {
  const make = () => new ChartController({ spec: { ...sample, type: "line" } });

  it("adds, changes and removes trendlines with the fit", () => {
    const c = make();
    const added = c.addTrendline("a", { type: "linear", showR2: true });
    expect(added).toMatchObject({ ok: true, index: 0 });
    expect((added as any).fit.equation).toBe("y = 10x");
    expect(c.getState().selection).toEqual({ kind: "trendline", seriesId: "a", index: 0 });
    expect(c.updateTrendline("a", 0, { type: "polynomial", order: 2 }).ok).toBe(true);
    expect(c.getSeries("a")!.trendlines).toEqual([{ type: "polynomial", order: 2, showR2: true }]);
    expect(c.updateTrendline("a", 0, { order: 9 })).toMatchObject({ ok: false });
    expect(c.deleteSelection().ok).toBe(true);
    expect(c.getSeries("a")!.trendlines).toBeUndefined();
    expect(c.removeTrendline("a", 0)).toMatchObject({ ok: false, message: '"A" has no trendline 0.' });
    c.update({ stacking: "stacked" });
    expect(c.addTrendline("a", { type: "linear" })).toMatchObject({ ok: false });
  });

  it("switches rows and columns, applies presets and changes the secondary axis", () => {
    const c = make();
    expect(c.transpose().ok).toBe(true);
    expect(c.getSpec().categories).toEqual(["A", "B"]);
    expect(c.getSpec().series.map((s) => s.name)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(c.getSpec().series[3].values).toEqual([40, 10]);
    c.undo();
    expect(c.applyPreset({ layout: "minimal", colors: "monochrome-blue" }).ok).toBe(true);
    expect(c.getSpec().legend.show).toBe(false);
    expect(c.getSpec().palette).toEqual(CHART_COLOR_SCHEMES.find((s) => s.id === "monochrome-blue")!.palette);
    expect(c.getState().undoLabel).toBe("Apply chart style");
    expect(c.applyPreset({ layout: "nope" })).toMatchObject({ ok: false, message: expect.stringMatching(/There is no layout "nope"; expected one of "standard"/) });
    expect(c.setAxis("y2", { title: "Share" }).ok).toBe(true);
    expect(c.getSpec().yAxis2.title).toBe("Share");
    expect(c.updateSeries("b", { axis: "secondary", marker: "triangle" }).ok).toBe(true);
    expect(c.getSeries("b")).toMatchObject({ axis: "secondary", marker: "triangle" });
    expect(c.updateSeries("b", { axis: "primary", marker: null }).ok).toBe(true);
    expect(c.getSeries("b")!.axis).toBeUndefined();
    expect(c.getSeries("b")!.marker).toBeUndefined();
  });

  it("cancels a gesture without leaving undo or redo steps", () => {
    const c = make();
    c.beginGesture("drag");
    c.setValue("a", 0, 99);
    c.setValue("a", 0, 77);
    c.cancelGesture();
    expect(c.getSeries("a")!.values[0]).toBe(10);
    expect(c.getState().canUndo).toBe(false);
    expect(c.getState().canRedo).toBe(false);
  });
});

describe("chart interaction: snapping, fine, cancel, scatter drags", () => {
  const scene = (c: ChartController) => layoutChart(c.getSpec() as ChartSpec, { width: 400, height: 300 });
  const at = (s: ChartScene, value: number) => {
    const sc = s.valueScale!;
    return sc.range[0] + ((value - sc.domain[0]) / (sc.domain[1] - sc.domain[0])) * (sc.range[1] - sc.range[0]);
  };

  it("snaps to nearby values in screen pixels, else to a tenth of a tick", () => {
    const c = new ChartController({ spec: sample });
    const s = scene(c);
    const px = (v: number) => at(s, v);
    const valueAt = (y: number) => s.valueScale!.domain[0] + ((y - s.valueScale!.range[0]) / (s.valueScale!.range[1] - s.valueScale!.range[0])) * (s.valueScale!.domain[1] - s.valueScale!.domain[0]);
    expect(snapChartDragValue(s, valueAt(px(15) + 3), { candidates: [15] })).toBe(15);
    expect(snapChartDragValue(s, valueAt(px(15) + 30), { candidates: [15] })).not.toBe(15);
  });

  it("drags finely, cancels with Escape and leaves no step", () => {
    const c = new ChartController({ spec: sample });
    const s = scene(c);
    const bar = s.marks.find((m) => m.key === "bar-a-1") as any;
    const start = { x: bar.x + bar.width / 2, y: bar.y + 2 };
    const drag = startChartPointDrag(c, s, { kind: "point", seriesId: "a", index: 1 }, start)!;
    drag.move({ x: start.x, y: start.y - 100 }, { fine: true });
    const fine = c.getSeries("a")!.values[1]!;
    expect(fine).toBeGreaterThan(20);
    expect(fine).toBeLessThan(26);
    drag.cancel();
    expect(c.getSeries("a")!.values[1]).toBe(20);
    expect(c.getState().canUndo).toBe(false);
    expect(handleChartKey(c, s, { key: "Escape" })).toBe(false);
  });

  it("drags scatter points in x and y, or one axis with lockAxis", () => {
    const c = new ChartController({ spec: { type: "scatter", categories: ["a", "b"], series: [{ id: "s", name: "S", values: [1, 2], x: [1, 2] }] } });
    const s = scene(c);
    expect(s.xScale).toBeDefined();
    const pt = s.marks.find((m) => m.key === "point-s-0") as any;
    const drag = startChartPointDrag(c, s, { kind: "point", seriesId: "s", index: 0 }, { x: pt.cx, y: pt.cy })!;
    expect(drag.xDomain).toBeDefined();
    drag.move({ x: pt.cx + 80, y: pt.cy - 5 }, { lockAxis: true });
    expect(c.getSeries("s")!.values[0]).toBe(1);
    expect(c.getSeries("s")!.x![0]).toBeGreaterThan(1);
    drag.end();
    expect(c.getState().undoLabel).toMatch(/Drag S|Change series/);
  });

  it("drags series on the secondary axis by the secondary scale", () => {
    const c = new ChartController({ spec: { categories: ["a", "b"], series: [{ id: "big", name: "Big", values: [1000, 2000] }, { id: "p", name: "P", values: [0.2, 0.4], type: "line", axis: "secondary" }] } });
    const s = scene(c);
    const pt = s.marks.find((m) => m.key === "point-p-0") as any;
    const drag = startChartPointDrag(c, s, { kind: "point", seriesId: "p", index: 0 }, { x: pt.cx, y: pt.cy })!;
    drag.move({ x: pt.cx, y: pt.cy - 20 }, { noSnap: true });
    drag.end();
    const v = c.getSeries("p")!.values[0]!;
    expect(v).toBeGreaterThan(0.2);
    expect(v).toBeLessThan(0.4);
  });

  it("hit-tests marks for agents and hosts without DOM events", () => {
    const c = new ChartController({ spec: { ...sample, title: "T" } });
    const s = scene(c);
    const bar = s.marks.find((m) => m.key === "bar-a-2") as any;
    expect(chartHitTest(s, { x: bar.x + 1, y: bar.y + bar.height - 1 })).toEqual({ kind: "point", seriesId: "a", index: 2 });
    const title = s.marks.find((m) => m.role === "title") as any;
    expect(chartHitTest(s, { x: title.x, y: title.y + 4 })).toEqual({ kind: "title" });
    expect(chartHitTest(s, { x: -10, y: -10 })).toBeNull();
  });

  it("nudges by a hundredth of a tick with Alt", () => {
    const c = new ChartController({ spec: sample });
    const s = scene(c);
    c.select({ kind: "point", seriesId: "a", index: 0 });
    const step = s.valueScale!.ticks[1] - s.valueScale!.ticks[0];
    expect(handleChartKey(c, s, { key: "ArrowUp", altKey: true })).toBe(true);
    expect(c.getSeries("a")!.values[0]).toBeCloseTo(10 + step / 100, 9);
  });
});
