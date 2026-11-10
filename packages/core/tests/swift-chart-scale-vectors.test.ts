import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chartColorDistance,
  chartContrastRatio,
  chartLuminance,
  chartRgbToHex,
  chartRgbToOklab,
  chartTextOn,
  checkChartColors,
  cyclePaletteColor,
  parseChartColor,
  shadeChartColor,
  simulateChartVision,
} from "../src/chart/color.js";
import {
  CHART_DATE_STEPS,
  chartDateLabels,
  formatChartDate,
  parseChartDate,
} from "../src/chart/date.js";
import {
  chartErrorAmounts,
  chartErrorBarsOfType,
  defaultChartErrorBarValue,
  describeChartErrorBars,
  formatChartAmountList,
  parseChartAmountList,
} from "../src/chart/errorbars.js";
import {
  chartScaleFromPixel,
  chartScaleToPixel,
  formatChartNumber,
  linearMap,
  niceLogScale,
  niceScale,
  niceStep,
  stepDecimals,
} from "../src/chart/scale.js";
import { createChartSpec, DEFAULT_CHART_PALETTE } from "../src/chart/spec.js";
import {
  chartBoxStats,
  chartHistogram,
  chartQuantile,
  chartSquarify,
  decimateChartPoints,
  suggestChartReferences,
  summarizeChartSeries,
} from "../src/chart/stats.js";
import {
  chartMovingAverage,
  chartSupportsTrendlines,
  chartTrendlineName,
  fitChartTrendline,
  trendNumberText,
} from "../src/chart/trend.js";
import type {
  ChartErrorBars,
  ChartErrorBarType,
  ChartNumberFormat,
  ChartTrendline,
  ChartValueScale,
} from "../src/chart/types.js";
import { conformanceValuesMatch } from "../src/tools/conformance.js";

const FILE = join(
  __dirname,
  "../../swift/Tests/PixerateChartTests/Fixtures/chart-scale-vectors.json",
);

type Entry = Record<string, unknown>;
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
const vec = (
  fn: string,
  trig: boolean,
  inputs: Entry,
  compute: () => unknown,
): Entry => ({ fn, trig, ...inputs, out: json(compute()) });

function scaleEntries(): Entry[] {
  const out: Entry[] = [];
  const stepCases: [number, number][] = [
    [100, 5],
    [10, 4],
    [2.3, 5],
    [0.047, 6],
    [1e9, 8],
    [0, 5],
    [-10, 5],
    [100, 0],
  ];
  out.push(
    vec("niceStep", false, { cases: stepCases }, () =>
      stepCases.map(([span, count]) => niceStep(span, count)),
    ),
  );

  const scaleCases: [number, number, number, number | null, number | null][] = [
    [0, 100, 5, null, null],
    [3, 97, 5, null, null],
    [-42, 88, 6, null, null],
    [5, 5, 5, null, null],
    [0, 0, 5, null, null],
    [10, 90, 5, 0, 100],
    [10, 90, 5, 15, null],
    [10, 90, 5, null, 85],
    [100, 10, 5, null, null],
    [0.0012, 0.0089, 4, null, null],
    [1e12, 5.4e12, 5, null, null],
  ];
  out.push(
    vec("niceScale", false, { cases: scaleCases }, () =>
      scaleCases.map(([mn, mx, c, fMin, fMax]) =>
        niceScale(mn, mx, c, fMin, fMax),
      ),
    ),
  );

  const steps = [1, 2, 2.5, 0.5, 0.25, 0.125, 0.0005, 1e-7, 0, -1];
  out.push(
    vec("stepDecimals", false, { steps }, () =>
      steps.map((s) => stepDecimals(s)),
    ),
  );

  const formats: ChartNumberFormat[] = [
    {},
    { style: "number" },
    { style: "number", decimals: 2 },
    { style: "number", prefix: "~", suffix: " units" },
    { style: "percent" },
    { style: "percent", decimals: 1 },
    { style: "compact" },
    { style: "compact", decimals: 2 },
    { style: "currency" },
    { style: "currency", currency: "EUR", decimals: 2 },
    { style: "currency", currency: "GBP" },
    { style: "currency", currency: "JPY" },
    { style: "currency", currency: "CHF" },
    { code: '#,##0.0,,"M"', prefix: "$", suffix: "!" },
  ];
  const values: (number | null)[] = [
    null,
    0,
    -0,
    1,
    -1,
    0.25,
    0.1234,
    0.00456,
    -0.05,
    42,
    1234.5,
    -1234.56,
    999999,
    1250000,
    -4500000000,
    1.2e12,
  ];
  const fallbacks: (number | undefined)[] = [undefined, 0, 1, 2, 3];
  out.push(
    vec(
      "formatChartNumber",
      false,
      {
        formats,
        values,
        fallbacks: fallbacks.map((f) => f ?? null),
      },
      () =>
        formats.map((fmt) =>
          fallbacks.map((fb) =>
            values.map((v) => formatChartNumber(v, fmt, fb)),
          ),
        ),
    ),
  );

  const logCases: [
    number,
    number,
    number,
    number,
    number | null,
    number | null,
  ][] = [
    [1, 1000, 5, 10, null, null],
    [3, 450, 5, 10, null, null],
    [0.02, 80, 6, 10, null, null],
    [2, 64, 5, 2, null, null],
    [10, 80, 5, 10, 5, 90],
    [12, 18, 5, 10, 12, 18],
    [-5, 0, 5, 10, null, null],
  ];
  out.push(
    vec("niceLogScale", true, { cases: logCases }, () =>
      logCases.map(([lo, hi, c, b, fMin, fMax]) =>
        niceLogScale(lo, hi, c, b, fMin, fMax),
      ),
    ),
  );

  const vScales: ChartValueScale[] = [
    { axis: "y", domain: [0, 100], range: [300, 20], ticks: [0, 50, 100] },
    {
      axis: "y",
      domain: [1, 1000],
      range: [300, 20],
      ticks: [1, 10, 100, 1000],
      logBase: 10,
    },
  ];
  const testVals = [1, 10, 50, 100, 500, 1000];
  const testPxs = [20, 90, 160, 230, 300];
  out.push(
    vec(
      "chartScalePixels",
      true,
      { scales: vScales, values: testVals, pixels: testPxs },
      () => ({
        toPixel: vScales.map((s) =>
          testVals.map((v) => chartScaleToPixel(v, s)),
        ),
        fromPixel: vScales.map((s) =>
          testPxs.map((px) => chartScaleFromPixel(px, s)),
        ),
        linear: testVals.map((v) => linearMap(v, [0, 100], [50, 250])),
      }),
    ),
  );

  return out;
}

function dateEntries(): Entry[] {
  const out: Entry[] = [];
  const rawDates = [
    "2024",
    "2024-03",
    "2024/03",
    "2024-03-15",
    "2024/03/15",
    "2024-02-29",
    "2023-02-29",
    "2024-03-15T10:20:30Z",
    "Q1 2024",
    "2024 Q3",
    "2024-Q4",
    "Mar 2024",
    "March 2024",
    "2024 Mar",
    "15 Mar 2024",
    "Mar 15, 2024",
    "March 15 2024",
    "not a date",
    "12345",
    "",
  ];
  out.push(
    vec("parseChartDate", false, { inputs: rawDates }, () =>
      rawDates.map((s) => parseChartDate(s)),
    ),
  );

  const categorySets: string[][] = [
    ["2020", "2021", "2022", "2023", "2024"],
    ["2024-01", "2024-02", "2024-03", "2024-04"],
    ["2024-03-01", "2024-03-02", "2024-03-03", "2024-03-04", "2024-03-05"],
    ["2023-12-30", "2023-12-31", "2024-01-01", "2024-01-02"],
    ["Q1 2023", "Q2 2023", "Q3 2023", "Q4 2023", "Q1 2024"],
    ["Jan 2024", "Feb 2024", "Mar 2024", "missing"],
    ["North", "South", "East", "West"],
    ["2024-01"],
  ];
  const bands = [20, 60, 120];
  out.push(
    vec("chartDateLabels", false, { categorySets, bands }, () =>
      categorySets.map((cats) =>
        bands.map((band) => {
          const res = chartDateLabels(cats, band, (text) => text.length * 7);
          if (!res) return null;
          return {
            step: res.step,
            indexes: res.indexes,
            labels: Array.from(res.labels.entries()),
          };
        }),
      ),
    ),
  );

  const parsedDates = rawDates
    .map((s) => parseChartDate(s))
    .filter((d): d is number => d !== null);
  out.push(
    vec("formatChartDate", false, { dates: parsedDates }, () =>
      CHART_DATE_STEPS.map((step) =>
        parsedDates.map((d, idx) =>
          formatChartDate(d, step, idx > 0 ? parsedDates[idx - 1] : null),
        ),
      ),
    ),
  );

  return out;
}

function colorEntries(): Entry[] {
  const out: Entry[] = [];
  const colors = [
    "#4269d0",
    "#efb118",
    "#ff725c",
    "#6cc5b0",
    "#3ca951",
    "#fff",
    "#000000",
    "#336699cc",
    "#f0a8",
    "rgb(255, 0, 128)",
    "rgba(30, 144, 255, 0.5)",
    "var(--primary, #2563eb)",
    "invalid",
  ];
  out.push(
    vec("parseChartColor", false, { colors }, () =>
      colors.map((c) => parseChartColor(c)),
    ),
  );

  const rgbs = colors
    .map((c) => parseChartColor(c))
    .filter((c): c is NonNullable<typeof c> => c !== null);
  out.push(
    vec("colorMath", true, { rgbs, colors: DEFAULT_CHART_PALETTE }, () => ({
      hex: rgbs.map((c) => chartRgbToHex(c)),
      luminance: rgbs.map((c) => chartLuminance(c)),
      oklab: rgbs.map((c) => chartRgbToOklab(c)),
      contrast: colors.map((c) => chartContrastRatio(c, "#ffffff")),
      textOn: colors.map((c) => chartTextOn(c, "#000000")),
      distance: rgbs.map((c, i) =>
        chartColorDistance(c, rgbs[(i + 1) % rgbs.length]),
      ),
      protanopia: rgbs.map((c) => simulateChartVision(c, "protanopia")),
      deuteranopia: rgbs.map((c) => simulateChartVision(c, "deuteranopia")),
      tritanopia: rgbs.map((c) => simulateChartVision(c, "tritanopia")),
      checkDefault: checkChartColors(DEFAULT_CHART_PALETTE),
      checkBad: checkChartColors(["#ffffaa", "#ffffbb", "#228822", "#886622"]),
      shades: [-0.5, -0.2, 0, 0.25, 0.6].map((t) =>
        shadeChartColor("#4269d0", t),
      ),
      cycled: Array.from({ length: 25 }, (_, i) =>
        cyclePaletteColor(DEFAULT_CHART_PALETTE.slice(0, 4), i),
      ),
    })),
  );

  return out;
}

function statsEntries(): Entry[] {
  const out: Entry[] = [];
  const dataSets: (number | null)[][] = [
    [10, 20, 30, 40, 50],
    [1, 2, 2, 3, 3, 3, 4, 4, 5, 100],
    [null, 5, null, -5, 15, 25, null, 35],
    [7, 7, 7, 7],
    [],
    [null, null],
  ];
  out.push(
    vec("chartHistogram", false, { dataSets }, () =>
      dataSets.map((ds) => ({
        auto: chartHistogram(ds),
        bins4: chartHistogram(ds, 4),
      })),
    ),
  );

  const sortedSets = [
    [1, 2, 3, 4, 5],
    [10, 20, 50, 80, 90, 100],
    [42],
    [],
  ];
  const qs = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
  out.push(
    vec("chartQuantile", false, { sortedSets, qs }, () =>
      sortedSets.map((s) => qs.map((q) => chartQuantile(s, q))),
    ),
  );

  out.push(
    vec("chartBoxStats", false, { dataSets }, () =>
      dataSets.map((ds) => chartBoxStats(ds)),
    ),
  );

  const squarifyInputs = [
    [60, 40, 30, 20, 10, 5],
    [100, 0, -5, 50, 25],
    [10, 10, 10, 10],
    [],
  ];
  const rect = { x: 10, y: 20, width: 400, height: 240 };
  out.push(
    vec("chartSquarify", false, { inputs: squarifyInputs, rect }, () =>
      squarifyInputs.map((vals) => chartSquarify(vals, rect)),
    ),
  );

  const pts = Array.from({ length: 50 }, (_, i) => ({
    x: Math.floor(i / 5) + (i % 5) * 0.1,
    y: Math.sin(i) * 100,
  }));
  out.push(
    vec("decimateChartPoints", true, { points: pts }, () => ({
      keepAll: decimateChartPoints(pts, 100),
      decimated: decimateChartPoints(pts, 10),
    })),
  );

  const categories = ["Q1", "Q2", "Q3", "Q4", "Q5"];
  const seriesList = [
    { id: "s1", name: "Rising", values: [10, 20, 35, 50, 80] },
    { id: "s2", name: "Falling", values: [100, 80, 60, null, 20] },
    { id: "s3", name: "Flat", values: [50, 50.5, 49.8, 50.1, 50] },
    { id: "s4", name: "Empty", values: [null, null] },
  ];
  out.push(
    vec(
      "summarizeChartSeries",
      false,
      { seriesList, categories },
      () => ({
        summaries: seriesList.map((s) => summarizeChartSeries(s, categories)),
        references: suggestChartReferences(
          createChartSpec({ categories, series: seriesList }),
        ),
      }),
    ),
  );

  return out;
}

function trendAndErrorBarEntries(): Entry[] {
  const out: Entry[] = [];
  const points: [number, number][] = [
    [1, 2.1],
    [2, 3.9],
    [3, 6.2],
    [4, 8.0],
    [5, 9.9],
    [6, 12.1],
  ];
  const expPoints: [number, number][] = [
    [1, 2.718],
    [2, 7.389],
    [3, 20.085],
    [4, 54.598],
  ];
  const trendlines: ChartTrendline[] = [
    { type: "linear" },
    { type: "linear", intercept: 0 },
    { type: "polynomial", order: 2 },
    { type: "polynomial", order: 3, intercept: 1 },
    { type: "exponential" },
    { type: "exponential", intercept: 1 },
    { type: "logarithmic" },
    { type: "power" },
    { type: "moving-average", period: 3 },
  ];
  const evalXs = [0.5, 1, 2.5, 5, 8];
  out.push(
    vec(
      "fitChartTrendline",
      true,
      { trendlines, points, expPoints, evalXs },
      () =>
        trendlines.map((t) => {
          const pts =
            t.type === "exponential" || t.type === "power" ? expPoints : points;
          const fit = fitChartTrendline(t, pts);
          return {
            name: chartTrendlineName(t, "Revenue"),
            fit: fit
              ? {
                  type: fit.type,
                  coefficients: fit.coefficients,
                  r2: fit.r2,
                  equation: fit.equation,
                  points: fit.points,
                  evaluated: evalXs.map((x) => fit.evaluate(x)),
                }
              : null,
          };
        }),
    ),
  );

  const coeffNums = [
    0, -0, 1, -1, 0.123456, -3.5, 0.000012345, -1.2345e12, 42.1,
  ];
  out.push(
    vec("trendHelpers", false, { points, coeffNums }, () => ({
      numbers: coeffNums.map((n) => trendNumberText(n)),
      ma2: chartMovingAverage(points, 2),
      ma3: chartMovingAverage(points, 3),
      supports: [
        ["bar", "none"],
        ["bar", "stacked"],
        ["line", "none"],
        ["pie", "none"],
        ["scatter", "none"],
      ].map(([t, s]) => chartSupportsTrendlines(t, s)),
    })),
  );

  const ebValues: (number | null)[] = [10, 20, null, 40, 50];
  const errorBarsList: ChartErrorBars[] = [
    { type: "fixed" },
    { type: "fixed", value: 3, direction: "plus" },
    { type: "percent", value: 10, direction: "minus" },
    { type: "stddev", value: 1.5 },
    { type: "stderr" },
    {
      type: "custom",
      plus: [1, 2, null, 4, 5],
      minus: [0.5, 1, null, 2, 2.5],
    },
  ];
  const ebTypes: (ChartErrorBarType | null)[] = [
    null,
    "fixed",
    "percent",
    "stddev",
    "stderr",
    "custom",
  ];
  out.push(
    vec(
      "errorBars",
      true,
      { values: ebValues, bars: errorBarsList, types: ebTypes },
      () => ({
        defaults: (
          ["fixed", "percent", "stddev", "stderr", "custom"] as const
        ).map((t) => defaultChartErrorBarValue(t) ?? null),
        amounts: errorBarsList.map((b) => chartErrorAmounts(b, ebValues)),
        descriptions: errorBarsList.map((b) => describeChartErrorBars(b)),
        switched: ebTypes.map((t) =>
          chartErrorBarsOfType(t, errorBarsList[1], ebValues),
        ),
        formatted: formatChartAmountList([1, 2.5, null, 0]),
        parsed: parseChartAmountList("1, 2.5, - ; 0  4"),
      }),
    ),
  );

  return out;
}

function vectors() {
  return {
    version: 1,
    entries: [
      ...scaleEntries(),
      ...dateEntries(),
      ...colorEntries(),
      ...statsEntries(),
      ...trendAndErrorBarEntries(),
    ],
  };
}

describe("Swift chart scale, date, color, stats, trend and errorbar test vectors", () => {
  it("match the committed fixture (the Swift tests read it)", () => {
    const now = json(vectors());
    if (process.env.UPDATE_SWIFT_VECTORS) {
      mkdirSync(dirname(FILE), { recursive: true });
      writeFileSync(FILE, JSON.stringify(now) + "\n");
    }
    const committed = JSON.parse(readFileSync(FILE, "utf8"));
    if (!conformanceValuesMatch(now, committed)) expect(now).toEqual(committed);
  });
});
