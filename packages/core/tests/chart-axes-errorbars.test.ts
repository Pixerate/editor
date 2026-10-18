// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools";
import {
  ChartController,
  chartErrorAmounts,
  chartFromMermaid,
  chartFromOoxml,
  chartScaleFromPixel,
  chartScaleToPixel,
  chartToMermaid,
  chartToOoxml,
  chartValueAtPoint,
  chartXAtPoint,
  createChartSpec,
  createChartToolProvider,
  describeChartErrorBars,
  handleChartKey,
  layoutChart,
  niceLogScale,
  normalizeChartSpec,
  startChartPointDrag,
  summarizeChart,
  type ChartMark,
  type ChartSpec,
} from "../src/chart";

const finite = (m: ChartMark) => {
  const nums =
    m.kind === "rect" ? [m.x, m.y, m.width, m.height] : m.kind === "circle" ? [m.cx, m.cy, m.r] : m.kind === "line" ? [m.x1, m.y1, m.x2, m.y2] : m.kind === "text" ? [m.x, m.y] : (m.d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  return nums.every(Number.isFinite) && !(m.kind === "path" && /NaN|Infinity/.test(m.d));
};
const size = { width: 480, height: 300 };
const scene = (spec: Partial<ChartSpec>) => layoutChart(createChartSpec(spec), size);
const errorMarks = (s: ReturnType<typeof scene>) => s.marks.filter((m) => m.role === "error-bar") as Extract<ChartMark, { kind: "path" }>[];
/** The y pixels of a vertical error bar's stem (first M…L pair). */
const stemY = (d: string) => {
  const m = /^M[\d.-]+,([\d.-]+)L[\d.-]+,([\d.-]+)/.exec(d)!;
  return [Number(m[1]), Number(m[2])].sort((a, b) => a - b);
};

describe("log scales", () => {
  it("ends on powers of the base and ticks on each power, or 1-2-5 over few decades", () => {
    expect(niceLogScale(3, 4200, 5)).toEqual({ min: 1, max: 10000, step: 10, ticks: [1, 10, 100, 1000, 10000] });
    expect(niceLogScale(3, 40, 5).ticks).toEqual([1, 2, 5, 10, 20, 50, 100]);
    expect(niceLogScale(0.002, 0.3, 4).ticks).toEqual([0.001, 0.01, 0.1, 1]);
    const base2 = niceLogScale(3, 700, 5, 2);
    expect([base2.min, base2.max]).toEqual([2, 1024]);
    expect(base2.ticks.every((t) => Math.log2(t) % 1 === 0)).toBe(true);
    // Many decades are thinned to about the tick count.
    expect(niceLogScale(1, 1e20, 4).ticks.length).toBeLessThanOrEqual(7);
  });

  it("keeps positive fixed ends, ignores others, and survives junk", () => {
    expect(niceLogScale(3, 4200, 5, 10, 2, 5000)).toMatchObject({ min: 2, max: 5000 });
    expect(niceLogScale(3, 4200, 5, 10, -1, 0)).toMatchObject({ min: 1, max: 10000 });
    // A range inside one decade still has at least two ticks.
    expect(niceLogScale(20, 80, 5, 10, 20, 80).ticks.length).toBeGreaterThanOrEqual(2);
    for (const [lo, hi] of [[0, 0], [-5, -1], [NaN, Infinity], [1e-300, 1e300]]) {
      const s = niceLogScale(lo, hi, 5);
      expect(s.min).toBeGreaterThan(0);
      expect(s.max).toBeGreaterThan(s.min);
      expect(s.ticks.every((t) => t > 0 && Number.isFinite(t))).toBe(true);
    }
  });

  it("maps values to pixels by logarithm and back, linear when no base, either direction", () => {
    const log = { domain: [1, 1000] as [number, number], range: [300, 0] as [number, number], logBase: 10 };
    expect(chartScaleToPixel(10, log)).toBeCloseTo(200);
    expect(chartScaleToPixel(100, log)).toBeCloseTo(100);
    expect(chartScaleToPixel(0, log)).toBeNaN();
    expect(chartScaleFromPixel(100, log)).toBeCloseTo(100);
    const reversed = { ...log, range: [0, 300] as [number, number] };
    expect(chartScaleFromPixel(chartScaleToPixel(42, reversed), reversed)).toBeCloseTo(42);
    const lin = { domain: [0, 10] as [number, number], range: [0, 100] as [number, number] };
    expect(chartScaleToPixel(2.5, lin)).toBe(25);
    expect(chartScaleFromPixel(25, lin)).toBe(2.5);
  });
});

describe("error bar maths", () => {
  const values = [2, 4, null, 6];
  it("fixed and percent amounts per point, gaps stay empty", () => {
    expect(chartErrorAmounts({ type: "fixed", value: 1.5 }, values)).toEqual([{ center: 2, plus: 1.5, minus: 1.5 }, { center: 4, plus: 1.5, minus: 1.5 }, null, { center: 6, plus: 1.5, minus: 1.5 }]);
    expect(chartErrorAmounts({ type: "percent", value: 50 }, [4, -2])).toEqual([{ center: 4, plus: 2, minus: 2 }, { center: -2, plus: 1, minus: 1 }]);
    // Defaults: fixed 1, percent 5.
    expect(chartErrorAmounts({ type: "fixed" }, [3])[0]!.plus).toBe(1);
    expect(chartErrorAmounts({ type: "percent" }, [200])[0]!.plus).toBe(10);
  });

  it("stddev is centred on the series mean (as Excel draws it); stderr is sd / √n at each point", () => {
    // values 2, 4, 6: mean 4, sample sd 2.
    const sd = chartErrorAmounts({ type: "stddev", value: 2 }, values);
    expect(sd[0]).toEqual({ center: 4, plus: 4, minus: 4 });
    expect(sd[2]).toBeNull();
    const se = chartErrorAmounts({ type: "stderr" }, values);
    expect(se[3]!.center).toBe(6);
    expect(se[3]!.plus).toBeCloseTo(2 / Math.sqrt(3));
    expect(chartErrorAmounts({ type: "stddev" }, [5])[0]).toEqual({ center: 5, plus: 0, minus: 0 });
  });

  it("custom amounts, minus defaulting to plus, and one-sided directions", () => {
    expect(chartErrorAmounts({ type: "custom", plus: [1, null, 0, 2] }, values)).toEqual([{ center: 2, plus: 1, minus: 1 }, null, null, { center: 6, plus: 2, minus: 2 }]);
    expect(chartErrorAmounts({ type: "custom", plus: [1], minus: [3] }, [5])).toEqual([{ center: 5, plus: 1, minus: 3 }]);
    expect(chartErrorAmounts({ type: "custom", minus: [3] }, [5])).toEqual([{ center: 5, plus: 0, minus: 3 }]);
    expect(chartErrorAmounts({ type: "fixed", value: 1, direction: "plus" }, [5])).toEqual([{ center: 5, plus: 1, minus: 0 }]);
    expect(chartErrorAmounts({ type: "fixed", value: 1, direction: "minus" }, [5])).toEqual([{ center: 5, plus: 0, minus: 1 }]);
  });

  it("describes error bars in words", () => {
    expect(describeChartErrorBars({ type: "percent", value: 10 })).toBe("±10% error bars");
    expect(describeChartErrorBars({ type: "stddev", direction: "plus" })).toBe("+1 standard deviation error bars");
    expect(describeChartErrorBars({ type: "custom", plus: [1] })).toBe("custom error bars");
  });
});

describe("spec validation", () => {
  it("stores only non-default axis options", () => {
    const { spec, issues } = normalizeChartSpec({ yAxis: { scale: "log", logBase: 10, reverse: false }, xAxis: { reverse: true }, yAxis2: { scale: "log", logBase: 2 } });
    expect(issues).toEqual([]);
    expect(spec.yAxis.scale).toBe("log");
    expect("logBase" in spec.yAxis).toBe(false);
    expect("reverse" in spec.yAxis).toBe(false);
    expect(spec.xAxis.reverse).toBe(true);
    expect(spec.yAxis2.logBase).toBe(2);
    expect(normalizeChartSpec({ yAxis: { scale: "linear", logBase: 2 } }).spec.yAxis).not.toHaveProperty("logBase");
    expect(createChartSpec({}).yAxis).not.toHaveProperty("scale");
  });

  it("rejects bad axis options with sentences", () => {
    const msg = (input: unknown) => normalizeChartSpec(input).issues.map((i) => i.message).join(" ");
    expect(msg({ yAxis: { scale: "log", logBase: 1 } })).toMatch(/logBase must be a number from 2 to 1000/);
    expect(msg({ yAxis: { scale: "cubic" } })).toMatch(/yAxis.scale must be one of "linear", "log"/);
    expect(msg({ yAxis: { scale: "log", min: 0 } })).toMatch(/yAxis.min must be greater than 0 on a logarithmic axis/);
    expect(msg({ stacking: "percent", yAxis: { scale: "log" } })).toMatch(/logarithmic yAxis cannot show percent stacking/);
    expect(msg({ yAxis: { reverse: "yes" } })).toMatch(/yAxis.reverse must be true or false/);
  });

  it("checks error bars and pads custom amounts to the categories", () => {
    const ok = normalizeChartSpec({ categories: ["a", "b", "c"], series: [{ name: "S", values: [1, 2, 3], errorBars: { type: "custom", plus: [1] }, xErrorBars: { type: "fixed", value: 0.5, direction: "both", cap: true } }] });
    expect(ok.issues).toEqual([]);
    expect(ok.spec.series[0].errorBars).toEqual({ type: "custom", plus: [1, null, null] });
    expect(ok.spec.series[0].xErrorBars).toEqual({ type: "fixed", value: 0.5 });
    const msg = (errorBars: unknown) => normalizeChartSpec({ categories: ["a"], series: [{ name: "S", values: [1], errorBars }] }).issues.map((i) => i.message).join(" ");
    expect(msg({ type: "stderr", value: 2 })).toMatch(/stderr error bars take no value/);
    expect(msg({ type: "fixed", plus: [1] })).toMatch(/only applies to custom error bars/);
    expect(msg({ type: "custom", plus: [-1] })).toMatch(/must be 0 or more/);
    expect(msg({ type: "custom" })).toMatch(/Custom error bars need plus and \/ or minus amounts/);
    expect(msg({ value: 1 })).toMatch(/type is required/);
    expect(msg({ type: "fixed", value: -1 })).toMatch(/value must be a number, 0 or more/);
    expect(msg("big")).toMatch(/must be an object with a type/);
  });
});

describe("layout", () => {
  const data = { categories: ["A", "B", "C"], series: [{ id: "s", name: "S", values: [4, 8, 6], errorBars: { type: "fixed" as const, value: 2 } }] };

  it.each(["bar", "line", "area", "scatter"] as const)("draws finite error bars on %s series and scales the axis to include them", (type) => {
    const s = scene({ ...data, type });
    const bars = errorMarks(s);
    expect(bars).toHaveLength(3);
    expect(bars.every(finite)).toBe(true);
    expect(bars[0].target).toEqual({ kind: "series", seriesId: "s" });
    expect(s.valueScale!.domain[1]).toBeGreaterThanOrEqual(10);
  });

  it("puts error bars on stack tops, scaled to shares when percent-stacked, and sideways on horizontal bars", () => {
    const two = { categories: ["A"], series: [{ id: "a", name: "A", values: [2] }, { id: "b", name: "B", values: [2], errorBars: { type: "fixed" as const, value: 1 } }] };
    const stacked = scene({ ...two, stacking: "stacked" });
    const [lo, hi] = stemY(errorMarks(stacked)[0].d);
    const px = (v: number) => chartScaleToPixel(v, stacked.valueScale!);
    expect(lo).toBeCloseTo(px(5), 0);
    expect(hi).toBeCloseTo(px(3), 0);
    const percent = scene({ ...two, stacking: "percent" });
    const [plo, phi] = stemY(errorMarks(percent)[0].d);
    const ppx = (v: number) => chartScaleToPixel(v, percent.valueScale!);
    expect(plo).toBeCloseTo(ppx(1.25), 0);
    expect(phi).toBeCloseTo(ppx(0.75), 0);
    const horizontal = scene({ ...data, orientation: "horizontal" });
    const d = errorMarks(horizontal)[0].d;
    const [x1, y1, x2, y2] = /^M([\d.]+),([\d.]+)L([\d.]+),([\d.]+)/.exec(d)!.slice(1).map(Number);
    expect(y1).toBe(y2);
    expect(x2).not.toBe(x1);
  });

  it("leaves caps off when asked and draws one-sided bars", () => {
    const capped = errorMarks(scene({ ...data, type: "line" }))[0].d.match(/M/g)!.length;
    const plain = errorMarks(scene({ ...data, type: "line", series: [{ ...data.series[0], errorBars: { type: "fixed", value: 2, cap: false } }] }))[0].d.match(/M/g)!.length;
    const plus = errorMarks(scene({ ...data, type: "line", series: [{ ...data.series[0], errorBars: { type: "fixed", value: 2, direction: "plus" } }] }))[0].d.match(/M/g)!.length;
    expect([capped, plain, plus]).toEqual([3, 1, 2]);
  });

  it("lays out log value axes with power ticks, skips values of 0 or less and says so", () => {
    const s = scene({ type: "line", categories: ["a", "b", "c", "d"], yAxis: { scale: "log" }, series: [{ id: "g", name: "G", values: [1, 15, 0, 3000] }] });
    expect(s.valueScale).toMatchObject({ domain: [1, 10000], logBase: 10, ticks: [1, 10, 100, 1000, 10000] });
    expect(s.marks.every(finite)).toBe(true);
    expect(s.marks.some((m) => m.key === "point-g-2")).toBe(false);
    expect(s.warnings.find((w) => w.code === "values-skipped")?.message).toMatch(/1 value of 0 or less cannot be drawn on the logarithmic value axis/);
    expect(s.marks.find((m) => m.role === "tick-label" && m.kind === "text" && m.text === "1,000")).toBeDefined();
  });

  it("draws log bars up from the bottom of the axis, stacked bars too, and log secondary axes", () => {
    for (const stacking of ["none", "stacked"] as const) {
      const s = scene({ type: "bar", stacking, categories: ["a", "b"], yAxis: { scale: "log", logBase: 2 }, series: [{ id: "a", name: "A", values: [3, 40] }, { id: "b", name: "B", values: [5, -1], axis: "secondary" }], yAxis2: { scale: "log" } });
      expect(s.marks.every(finite)).toBe(true);
      const bar = s.marks.find((m) => m.key === "bar-a-0") as Extract<ChartMark, { kind: "rect" }>;
      expect(bar.y + bar.height).toBeCloseTo(s.plot.y + s.plot.height, 0);
      expect(s.valueScale2?.logBase).toBe(10);
      expect(s.marks.some((m) => m.key === "bar-b-1")).toBe(false);
    }
  });

  it("reverses value and category axes", () => {
    const normal = scene({ categories: ["A", "B", "C"], series: [{ id: "s", name: "S", values: [1, 2, 3] }] });
    const reversed = scene({ categories: ["A", "B", "C"], xAxis: { reverse: true }, yAxis: { reverse: true }, series: [{ id: "s", name: "S", values: [1, 2, 3] }] });
    expect(reversed.valueScale!.range).toEqual([...normal.valueScale!.range].reverse());
    const x = (s: typeof normal, key: string) => (s.marks.find((m) => m.key === key) as any).x;
    expect(x(reversed, "tick-x-0")).toBeGreaterThan(x(reversed, "tick-x-2"));
    expect(x(normal, "tick-x-0")).toBeLessThan(x(normal, "tick-x-2"));
    // Bars hang from the top on a reversed value axis.
    const bar = reversed.marks.find((m) => m.key === "bar-s-2") as Extract<ChartMark, { kind: "rect" }>;
    expect(bar.y).toBeCloseTo(reversed.plot.y, 0);
    // Stacked areas keep their baselines when categories run backwards.
    const area = scene({ type: "area", stacking: "stacked", xAxis: { reverse: true }, categories: ["A", "B", "C"], series: [{ id: "a", name: "A", values: [1, 2, 3] }, { id: "b", name: "B", values: [1, 1, 1] }] });
    expect(area.marks.every(finite)).toBe(true);
  });

  it("lays out xy charts with log and reversed axes and x / y error bars", () => {
    const s = scene({
      type: "scatter",
      categories: ["a", "b", "c", "d"],
      xAxis: { scale: "log" },
      yAxis: { reverse: true },
      series: [{ id: "p", name: "P", values: [10, 20, 15, 30], x: [1, 10, 0, 1000], errorBars: { type: "stderr" }, xErrorBars: { type: "percent", value: 30 } }],
    });
    expect(s.marks.every(finite)).toBe(true);
    expect(s.xScale!.logBase).toBe(10);
    expect(s.valueScale!.range[0]).toBeLessThan(s.valueScale!.range[1]);
    expect(errorMarks(s).filter((m) => m.key.startsWith("error-bar-x-"))).toHaveLength(3);
    expect(s.warnings.map((w) => w.message).join(" ")).toMatch(/1 point with a value of 0 or less cannot be drawn on the logarithmic x axis/);
  });

  it("drops trendline samples a log axis cannot place", () => {
    const s = scene({ type: "line", categories: ["a", "b", "c", "d"], yAxis: { scale: "log" }, series: [{ id: "t", name: "T", values: [8, 4, 2, 1], trendlines: [{ type: "linear", forward: 3 }] }] });
    expect(s.marks.every(finite)).toBe(true);
    expect(s.marks.some((m) => m.role === "trendline")).toBe(true);
  });
});

describe("interaction on log and reversed axes", () => {
  it("reads values through the log scale", () => {
    const s = scene({ type: "line", categories: ["a", "b"], yAxis: { scale: "log" }, series: [{ id: "g", name: "G", values: [1, 1000] }] });
    const pt = s.marks.find((m) => m.key === "point-g-1") as Extract<ChartMark, { kind: "circle" }>;
    expect(chartValueAtPoint(s, { x: pt.cx, y: pt.cy })).toBeCloseTo(1000);
    const xy = scene({ type: "scatter", categories: ["a", "b"], xAxis: { scale: "log", reverse: true }, series: [{ id: "p", name: "P", values: [1, 2], x: [10, 100] }] });
    const p = xy.marks.find((m) => m.key === "point-p-1") as Extract<ChartMark, { kind: "circle" }>;
    expect(chartXAtPoint(xy, { x: p.cx, y: p.cy })).toBeCloseTo(100);
  });

  it("drags by ratio on a log axis so the point follows the pointer, and nudges by powers", () => {
    const c = new ChartController({ spec: { type: "line", categories: ["a", "b"], yAxis: { scale: "log" }, series: [{ id: "g", name: "G", values: [10, 1000] }] } });
    const s = layoutChart(c.getSpec(), size);
    const pt = s.marks.find((m) => m.key === "point-g-0") as Extract<ChartMark, { kind: "circle" }>;
    const target = { x: pt.cx, y: chartScaleToPixel(100, s.valueScale!) };
    const drag = startChartPointDrag(c, s, { kind: "point", seriesId: "g", index: 0 }, { x: pt.cx, y: pt.cy })!;
    drag.move(target, { noSnap: true });
    expect(c.getSeries("g")!.values[0]).toBeCloseTo(100, 6);
    drag.move({ x: pt.cx, y: pt.cy - 7 });
    expect(Number(c.getSeries("g")!.values[0]!.toPrecision(2))).toBe(c.getSeries("g")!.values[0]);
    drag.end();
    c.select({ kind: "point", seriesId: "g", index: 1 });
    expect(handleChartKey(c, layoutChart(c.getSpec(), size), { key: "ArrowUp", shiftKey: true })).toBe(true);
    expect(c.getSeries("g")!.values[1]).toBe(10000);
    handleChartKey(c, layoutChart(c.getSpec(), size), { key: "ArrowDown" });
    expect(c.getSeries("g")!.values[1]).toBeCloseTo(7940, -1);
  });

  it("drags on a reversed axis in the direction the axis runs", () => {
    const c = new ChartController({ spec: { type: "bar", categories: ["a"], yAxis: { reverse: true, min: 0, max: 100 }, series: [{ id: "s", name: "S", values: [50] }] } });
    const s = layoutChart(c.getSpec(), size);
    const bar = s.marks.find((m) => m.key === "bar-s-0") as Extract<ChartMark, { kind: "rect" }>;
    const end = bar.y + bar.height;
    const drag = startChartPointDrag(c, s, { kind: "point", seriesId: "s", index: 0 }, { x: bar.x + 2, y: end })!;
    drag.move({ x: bar.x + 2, y: end + (s.plot.height / 100) * 20 }, { noSnap: true });
    drag.end();
    expect(c.getSeries("s")!.values[0]).toBeCloseTo(70, 0);
  });
});

describe("round trips", () => {
  const rich: Partial<ChartSpec> = {
    type: "bar",
    categories: ["A", "B", "C"],
    xAxis: { show: true, title: "", min: null, max: null, step: null, gridlines: false, format: {}, reverse: true },
    yAxis: { show: true, title: "", min: null, max: null, step: null, gridlines: true, format: {}, scale: "log", logBase: 2, reverse: true },
    series: [
      { id: "series-1", name: "Fixed", values: [3, 5, 9], errorBars: { type: "fixed", value: 0.5, direction: "plus", cap: false } },
      { id: "series-2", name: "Custom", values: [2, 4, 6], type: "line", errorBars: { type: "custom", plus: [1, null, 2], minus: [0.5, 1, null] } },
      { id: "series-3", name: "Pct", values: [1, 2, 3], type: "line", errorBars: { type: "percent", value: 10 } },
      { id: "series-4", name: "SD", values: [1, 2, 3], type: "line", errorBars: { type: "stddev", value: 2, direction: "minus" } },
      { id: "series-5", name: "SE", values: [1, 2, 3], type: "line", errorBars: { type: "stderr" } },
    ],
  };

  it("writes c:errBars, c:logBase and orientation maxMin to OOXML and reads them back losslessly", () => {
    const spec = createChartSpec(rich);
    const { xml, issues } = chartToOoxml(spec);
    expect(issues).toEqual([]);
    expect(xml).toContain('<c:scaling><c:logBase val="2"/><c:orientation val="maxMin"/>');
    expect(xml).toContain('<c:errBars><c:errBarType val="plus"/><c:errValType val="fixedVal"/><c:noEndCap val="1"/><c:val val="0.5"/></c:errBars>');
    expect(xml).toContain('<c:errValType val="stdErr"/>');
    // errBars come after trendlines and before the data (CT_BarSer / CT_LineSer order).
    for (const ser of xml.split("<c:ser>").slice(1)) expect(ser.indexOf("<c:errBars>")).toBeLessThan(ser.indexOf("<c:cat>"));
    const back = chartFromOoxml(xml);
    expect(back.unsupported).toEqual([]);
    expect(back.issues).toEqual([]);
    expect(back.lossless).toBe(true);
    expect(back.spec.xAxis.reverse).toBe(true);
    expect(back.spec.yAxis).toMatchObject({ scale: "log", logBase: 2, reverse: true });
    expect(back.spec.series.map((s) => s.errorBars)).toEqual(spec.series.map((s) => s.errorBars));
  });

  it("round-trips x and y error bars on scatter charts and log x axes", () => {
    const spec = createChartSpec({ type: "scatter", categories: ["a", "b"], xAxis: { scale: "log" } as any, series: [{ name: "P", values: [1, 2], x: [10, 100], errorBars: { type: "fixed", value: 1 }, xErrorBars: { type: "percent", value: 20 } }] });
    const { xml } = chartToOoxml(spec);
    expect(xml).toContain('<c:errDir val="x"/>');
    expect(xml).toContain('<c:errDir val="y"/>');
    const back = chartFromOoxml(xml).spec;
    expect(back.xAxis.scale).toBe("log");
    expect(back.series[0].errorBars).toEqual({ type: "fixed", value: 1 });
    expect(back.series[0].xErrorBars).toEqual({ type: "percent", value: 20 });
  });

  it("says what OOXML cannot hold", () => {
    const xBars = chartToOoxml(createChartSpec({ type: "bar", categories: ["a"], series: [{ name: "S", values: [1], xErrorBars: { type: "fixed" } }] }));
    expect(xBars.issues.join(" ")).toMatch(/x error bars, which only scatter and bubble charts can hold/);
    const pie = chartToOoxml(createChartSpec({ type: "pie", categories: ["a"], series: [{ name: "S", values: [1], errorBars: { type: "fixed" } }] }));
    expect(pie.issues.join(" ")).toMatch(/Error bars on "S" are left out/);
    const logCat = chartToOoxml(createChartSpec({ type: "bar", categories: ["a"], xAxis: { scale: "log" } as any, series: [{ name: "S", values: [1] }] }));
    expect(logCat.issues.join(" ")).toMatch(/category axis cannot be logarithmic/);
  });

  it("reads Excel's error bars and axis options from a hand-written part", () => {
    const xml =
      `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea>` +
      `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:tx><c:v>S</c:v></c:tx><c:errBars><c:errBarType val="both"/><c:errValType val="percentage"/><c:val val="7.5"/></c:errBars><c:cat><c:strLit><c:ptCount val="2"/><c:pt idx="0"><c:v>a</c:v></c:pt><c:pt idx="1"><c:v>b</c:v></c:pt></c:strLit></c:cat><c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numLit></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart>` +
      `<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="maxMin"/></c:scaling><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:logBase val="10"/><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>` +
      `</c:plotArea></c:chart></c:chartSpace>`;
    const { spec, unsupported } = chartFromOoxml(xml);
    expect(unsupported).toEqual([]);
    expect(spec.series[0].errorBars).toEqual({ type: "percent", value: 7.5 });
    expect(spec.xAxis.reverse).toBe(true);
    expect(spec.yAxis.scale).toBe("log");
    expect(spec.yAxis).not.toHaveProperty("logBase");
  });

  it("round-trips through Mermaid with the @pixerate metadata", () => {
    const spec = createChartSpec(rich);
    const text = chartToMermaid(spec);
    const back = chartFromMermaid(text);
    expect(back.issues).toEqual([]);
    expect(back.spec.yAxis).toEqual(spec.yAxis);
    expect(back.spec.xAxis).toEqual(spec.xAxis);
    expect(back.spec.series.map((s) => s.errorBars)).toEqual(spec.series.map((s) => s.errorBars));
  });
});

describe("agent tools and summaries", () => {
  const setup = () => {
    const controller = new ChartController({ spec: { type: "bar", categories: ["Q1", "Q2"], series: [{ id: "a", name: "A", values: [10, 1000] }] } });
    const registry = new ToolRegistry();
    registry.register(createChartToolProvider(controller));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result: any = await registry.callTool(name, args);
      return { error: result.isError ? (result.content[0].text as string) : null, value: result.structuredContent as any };
    };
    return { controller, call };
  };

  it("sets log and reversed axes through update_chart, and rejects invalid combinations without changing anything", async () => {
    const { controller, call } = setup();
    const ok = await call("update_chart", { yAxis: { scale: "log", logBase: 10, reverse: true }, xAxis: { reverse: true } });
    expect(ok.error).toBeNull();
    expect(ok.value.spec.yAxis).toMatchObject({ scale: "log", reverse: true });
    const before = JSON.stringify(controller.getSpec());
    const bad = await call("update_chart", { stacking: "percent" });
    expect(bad.error).toMatch(/cannot show percent stacking/);
    expect(JSON.stringify(controller.getSpec())).toBe(before);
    expect((await call("update_chart", { yAxis: { min: -5 } })).error).toMatch(/must be greater than 0 on a logarithmic axis/);
    expect((await call("update_chart", { yAxis: { logBase: 1 } })).error).toMatch(/logBase|minimum/);
    expect((await call("update_chart", { yAxis: { scale: null } })).value.spec.yAxis).not.toHaveProperty("scale");
    expect(controller.getState().undoLabel).toBeTruthy();
  });

  it("adds, changes and removes error bars through update_chart_series as single undo steps", async () => {
    const { controller, call } = setup();
    const set = await call("update_chart_series", { series: "A", errorBars: { type: "percent", value: 10, direction: "plus" } });
    expect(set.error).toBeNull();
    expect(set.value.series.errorBars).toEqual({ type: "percent", value: 10, direction: "plus" });
    expect((await call("update_chart_series", { series: "A", errorBars: { type: "custom", plus: [1, -2] } })).error).toMatch(/must be 0 or more/);
    expect((await call("update_chart_series", { series: "A", errorBars: { type: "fixed", size: 1 } })).error).toMatch(/size|additional/i);
    expect((await call("update_chart_series", { series: "A", errorBars: { value: 1 } })).error).toMatch(/type/);
    expect(controller.getSeries("a")!.errorBars).toEqual({ type: "percent", value: 10, direction: "plus" });
    const removed = await call("update_chart_series", { series: "A", errorBars: null });
    expect(removed.value.series).not.toHaveProperty("errorBars");
    controller.undo();
    expect(controller.getSeries("a")!.errorBars?.type).toBe("percent");
  });

  it("summaries and descriptions mention log axes, reversed axes and error bars", () => {
    const spec = createChartSpec({ type: "line", categories: ["a", "b"], yAxis: { scale: "log" } as any, xAxis: { reverse: true } as any, series: [{ name: "G", values: [1, 100], errorBars: { type: "percent", value: 5 } }] });
    const summary = summarizeChart(spec);
    // The 5% error bars widen the range to the next powers.
    expect(summary.valueAxis).toMatchObject({ logBase: 10, min: 0.1, max: 1000 });
    expect(summary.description).toMatch(/The value axis is logarithmic \(base 10\)\./);
    expect(summary.description).toMatch(/The category axis is reversed\./);
    expect(summary.description).toMatch(/G has ±5% error bars\./);
  });
});
