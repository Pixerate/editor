import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { EUROPE_CHART_MAP } from "../src/chart-maps/europe.js";
import {
  addChartLink,
  chartLinksFromTable,
  chartSankeyNodes,
  chartSankeyNodeValues,
  normalizeChartLinks,
  setChartLinkField,
} from "../src/chart/links.js";
import {
  chartMapBreaks,
  chartMapClass,
  chartMapRamp,
  getChartMap,
  matchChartMapRegions,
  registerChartMap,
} from "../src/chart/maps.js";
import {
  CHART_COLOR_SCHEMES,
  CHART_LAYOUT_PRESETS,
  chartPresetPatch,
  monochromeChartPalette,
} from "../src/chart/presets.js";
import {
  chartRaceMoment,
  chartRaceRanking,
  chartRaceValueAt,
} from "../src/chart/race.js";
import {
  analyzeChartTable,
  chartFromTable,
  recommendChartTypes,
} from "../src/chart/recommend.js";
import {
  CHART_TYPES,
  chartColorInputValue,
  chartColorsByCategory,
  chartDataFromTable,
  chartDataToTable,
  chartFamily,
  chartLikertColor,
  chartPointColor,
  chartSeriesColor,
  chartSeriesType,
  chartSliceColor,
  chartSpecColorsByCategory,
  chartVariesColors,
  createChartSpec,
  isCartesianChart,
  isXyChart,
  normalizeChartSpec,
  parseChartValue,
  uniqueChartSeriesId,
} from "../src/chart/spec.js";
import { describeChart, summarizeChart } from "../src/chart/summary.js";
import {
  addChartTreeRow,
  chartTreeColumnLabels,
  chartTreeDepth,
  chartTreeFromRows,
  chartTreeFromSeries,
  chartTreeFromTable,
  chartTreeTotal,
  chartTreeToRows,
  findChartTreeNode,
  normalizeChartTree,
  removeChartTreeRow,
  setChartTreeRowName,
  setChartTreeRowValue,
} from "../src/chart/tree.js";
import {
  escapeCsvField,
  parseCsv,
  parseTsv,
  serializeCsv,
  serializeTsv,
} from "../src/spreadsheet/csv.js";
import { conformanceValuesMatch } from "../src/tools/conformance.js";

const FILE = join(
  __dirname,
  "../../swift/Tests/PixerateChartTests/Fixtures/chart-model-vectors.json",
);

type Entry = Record<string, unknown>;
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
const vec = (
  fn: string,
  trig: boolean,
  inputs: Entry,
  compute: () => unknown,
): Entry => ({ fn, trig, ...inputs, out: json(compute()) });

function csvEntries(): Entry[] {
  const out: Entry[] = [];
  const csvTexts = [
    "Name,Q1,Q2\nNorth,10,20\nSouth,30,40\n",
    "\"Quoted, name\",\"Line\nbreak\",\"Escaped \"\"quote\"\"\"\r\n1,2,3",
    "a;b;c\n1;2;3",
    "",
    "single",
    "a,b,\n1,2,3\n\n",
  ];
  out.push(
    vec("parseAndSerializeCsv", false, { csvTexts }, () => ({
      parsedDefault: csvTexts.map((t) => parseCsv(t)),
      parsedSemi: parseCsv("a;b;c\n1;2;3", { delimiter: ";" }),
      escaped: ["plain", "with,comma", "with\"quote", "with\nnewline"].map((s) =>
        escapeCsvField(s),
      ),
      serializedCsv: csvTexts.map((t) => serializeCsv(parseCsv(t))),
      tsvRoundTrip: serializeTsv(parseTsv("col1\tcol2\nval1\tval2\n")),
    })),
  );
  return out;
}

function specEntries(): Entry[] {
  const out: Entry[] = [];
  const rawValues: unknown[] = [
    null,
    "",
    "-",
    "—",
    0,
    42,
    -12.5,
    "1,234.56",
    "$40",
    "€1,200",
    "12%",
    "(3.5)",
    "($1,000)",
    "1.5e3",
    "not a number",
    true,
    {},
  ];
  out.push(
    vec("parseChartValue", false, { inputs: rawValues }, () =>
      rawValues.map((v) => {
        const p = parseChartValue(v);
        return p === undefined ? "undefined" : p;
      }),
    ),
  );

  const specInputs: unknown[] = [
    {},
    "not-an-object",
    {
      type: "bar",
      title: "Quarterly Revenue",
      subtitle: "FY 2024",
      categories: ["Q1", "Q2", "Q3", "Q4"],
      series: [
        {
          id: "rev",
          name: "Revenue",
          values: [120, "150", "$180", "(20)"],
          color: "#2563eb",
          dataLabels: true,
          format: { style: "currency", currency: "USD", decimals: 0 },
          errorBars: { type: "percent", value: 5 },
          trendlines: [{ type: "linear", showEquation: true, showR2: true }],
        },
        {
          id: "rev",
          name: "Profit",
          values: [30, 45, 60],
          axis: "secondary",
          type: "line",
          marker: "diamond",
          curve: "smooth",
          pointColors: ["#ef4444", null, "#22c55e", ""],
          callouts: ["Start", null, "Peak", 100],
        },
      ],
      xAxis: { title: "Quarter", kind: "date", reverse: true },
      yAxis: {
        title: "USD",
        min: 0,
        max: 300,
        step: 50,
        scale: "log",
        logBase: 2,
      },
      referenceLines: [{ value: 100, label: "Target", axis: "y", color: "#000" }],
      referenceBands: [{ from: 200, to: 100, label: "Band", axis: "y2" }],
      highlight: ["Q1", 2, "Q1"],
      varyColors: true,
    },
    {
      type: "bad-type",
      stacking: "percent",
      yAxis: { min: 100, max: 50, step: -5, scale: "log", logBase: 1 },
      yAxis2: { min: -10, scale: "log" },
      palette: [],
      innerRadius: 2,
      gapWidth: -1,
      overlap: 5,
      bins: 0,
      parliamentMajority: 0,
      mapSteps: 20,
      mapThresholds: [10, 5],
      raceTopN: 50,
      radarTicks: 0,
      series: [
        "bad-series",
        {
          name: "S1",
          values: ["bad", 10],
          sizes: [-5, 10],
          errorBars: { type: "custom" },
          xErrorBars: { type: "stderr", value: 5 },
          trendlines: [{ type: "logarithmic", intercept: 0 }],
        },
      ],
      referenceLines: [{ value: "nope" }, { value: 10, extra: 1 }],
      referenceBands: [{ from: 10 }],
    },
    {
      type: "sunburst",
      tree: [
        {
          name: "Europe",
          value: 999,
          children: [
            { name: "France", value: 40 },
            { name: "Germany", value: 60 },
            { name: "France", value: 10 },
          ],
        },
        { name: "Asia", value: 80 },
      ],
    },
    {
      type: "sankey",
      links: [
        { source: "Visit", target: "Signup", value: 100 },
        { source: "Signup", target: "Purchase", value: 40 },
        { source: "Purchase", target: "Visit", value: 10 },
        { source: "Visit", target: "Signup", value: 50 },
        { source: "Same", target: "Same", value: 10 },
      ],
      sankeyNodes: ["Purchase", "Unused", "Visit"],
    },
  ];

  out.push(
    vec("normalizeChartSpec", false, { inputs: specInputs }, () =>
      specInputs.map((inp) => normalizeChartSpec(inp)),
    ),
  );

  const sampleSpec = createChartSpec({
    type: "bar",
    categories: ["A", "B", "C"],
    varyColors: true,
    series: [{ id: "s1", name: "S1", values: [10, 20, 30], pointColors: ["#111111", null, null] }],
  });
  const likertSpec = createChartSpec({
    type: "likert",
    categories: ["Q1", "Q2"],
    series: [
      { id: "a1", name: "Strongly disagree", values: [10, 20] },
      { id: "a2", name: "Disagree", values: [15, 25] },
      { id: "a3", name: "Neutral", values: [20, 10] },
      { id: "a4", name: "Agree", values: [30, 25] },
      { id: "a5", name: "Strongly agree", values: [25, 20] },
    ],
  });
  out.push(
    vec("specHelpers", false, { sampleSpec, likertSpec }, () => ({
      families: CHART_TYPES.map((t) => ({
        type: t,
        cartesian: isCartesianChart(t),
        byCategory: chartColorsByCategory(t),
        family: chartFamily(createChartSpec({ type: t })),
      })),
      xyScatter: isXyChart(
        createChartSpec({
          type: "scatter",
          series: [{ id: "s1", name: "S1", values: [1, 2], x: [10, 20] }],
        }),
      ),
      likertColors: [1, 2, 3, 4, 5, 6, 7].map((count) =>
        Array.from({ length: count }, (_, i) => chartLikertColor(count, i)),
      ),
      pointColors: [0, 1, 2].map((i) => chartPointColor(sampleSpec, 0, i)),
      seriesColors: [0, 1, 2, 3, 4].map((i) => chartSeriesColor(likertSpec, i)),
      sliceColors: [0, 1, 2, 3].map((i) => chartSliceColor(sampleSpec, i)),
      varies: chartVariesColors(sampleSpec),
      specByCat: chartSpecColorsByCategory(sampleSpec),
      seriesType: CHART_TYPES.map((t) =>
        chartSeriesType({ type: t }, { id: "s1", name: "S1", values: [] }),
      ),
      uniqueId: uniqueChartSeriesId([
        { id: "series-1" },
        { id: "series-2" },
        { id: "series-4" },
      ]),
      colorInput: ["#AbC", "#123456", "rgb(0,0,0)", "bad"].map((c) =>
        chartColorInputValue(c),
      ),
    })),
  );

  const tableRows = [
    ["Quarter", "Revenue", "Cost"],
    ["Q1", "100", "60"],
    ["Q2", "150", "bad"],
    ["Q3", "200", "90"],
  ];
  out.push(
    vec("chartTableData", false, { tableRows }, () => {
      const fromCols = chartDataFromTable(tableRows);
      const fromRows = chartDataFromTable(tableRows, {
        seriesIn: "rows",
        header: "auto",
      });
      const withX = chartDataFromTable(
        [
          ["X", "Y"],
          ["10", "20"],
          ["30", "40"],
        ],
        { xFromFirstColumn: true },
      );
      const toTable = chartDataToTable(
        createChartSpec({
          categories: fromCols.categories,
          series: fromCols.series,
        }),
        { categoryHeader: "Quarter" },
      );
      return { fromCols, fromRows, withX, toTable };
    }),
  );

  return out;
}

function linksTreeMapsEntries(): Entry[] {
  const out: Entry[] = [];
  const rawLinkTable = [
    ["From", "To", "Amount"],
    ["Ads", "Landing", 200],
    ["Landing", "Signup", 80],
    ["Signup", "Active", 50],
  ];
  out.push(
    vec("chartLinks", false, { rawLinkTable }, () => {
      const issues: { path: string; message: string }[] = [];
      const fromTable = chartLinksFromTable(rawLinkTable);
      const links = normalizeChartLinks(fromTable, issues);
      const nodes = chartSankeyNodes(links, ["Signup", "Ghost"], issues);
      const values = chartSankeyNodeValues(links, nodes);
      const edited = setChartLinkField(links, 1, "target", "  Checkout ");
      const added = addChartLink(links);
      return { fromTable, links, nodes, values, edited, added, issues };
    }),
  );

  const rawTreeTable = [
    ["Region", "Country", "Sales"],
    ["Europe", "France", 40],
    ["", "Germany", 60],
    ["Asia", "Japan", 50],
  ];
  out.push(
    vec("chartTree", false, { rawTreeTable }, () => {
      const issues: { path: string; message: string }[] = [];
      const tree = chartTreeFromTable(rawTreeTable, {}, issues);
      const rows = chartTreeToRows(tree);
      const depth = chartTreeDepth(tree);
      const totals = tree.map((n) => chartTreeTotal(n));
      const found = findChartTreeNode(tree, ["Europe", "Germany"]) ?? null;
      const missing = findChartTreeNode(tree, ["Europe", "Spain"]) ?? null;
      const flat = chartTreeFromSeries(["A", "B", "A"], [10, -5, 20]);
      const cols = [1, 2, 3, 4].map((d) => chartTreeColumnLabels(d));
      const renamed = setChartTreeRowName(rows, 0, 1, "Italy");
      const revalued = setChartTreeRowValue(rows, 1, 99);
      const withAdded = addChartTreeRow(rows);
      const withRemoved = removeChartTreeRow(withAdded, 0);
      const rebuilt = chartTreeFromRows(renamed, issues);
      return {
        tree,
        rows,
        depth,
        totals,
        found,
        missing,
        flat,
        cols,
        renamed,
        revalued,
        withAdded,
        withRemoved,
        rebuilt,
        issues,
      };
    }),
  );

  registerChartMap(EUROPE_CHART_MAP);
  const mapCategories = [
    "FRA",
    "germany",
    "Åland",
    "Aland",
    "ESP",
    "France",
    "Atlantis",
  ];
  out.push(
    vec("chartMaps", false, { mapCategories }, () => {
      const map = getChartMap("europe")!;
      const matched = matchChartMapRegions(map, mapCategories).map(
        (r) => r?.id ?? null,
      );
      const breaksAuto = chartMapBreaks([10, 25, 40, 80, 95], 4, []);
      const breaksFixed = chartMapBreaks([10, 25, 40, 80, 95], 4, [20, 50, 80]);
      const classes = [10, 20, 35, 50, 90].map((v) =>
        chartMapClass(v, breaksFixed),
      );
      const ramp = chartMapRamp("#4269d0", 5);
      return {
        mapId: map.id,
        regionCount: map.regions.length,
        matched,
        breaksAuto,
        breaksFixed,
        classes,
        ramp,
      };
    }),
  );

  return out;
}

function presetsRecommendSummaryEntries(): Entry[] {
  const out: Entry[] = [];
  out.push(
    vec("chartPresets", false, {}, () => ({
      layouts: CHART_LAYOUT_PRESETS,
      schemes: CHART_COLOR_SCHEMES,
      mono: monochromeChartPalette("#4269d0", 5),
      patches: [
        chartPresetPatch({ layout: "minimal" }),
        chartPresetPatch({ colors: "okabe-ito" }),
        chartPresetPatch({ layout: "presentation", colors: "warm" }),
        chartPresetPatch({ layout: "unknown" }),
        chartPresetPatch({ colors: "unknown" }),
        chartPresetPatch({}),
      ],
    })),
  );

  const tables: unknown[][][] = [
    [
      ["Quarter", "North", "South"],
      ["Q1", 10, 20],
      ["Q2", 15, 25],
      ["Q3", 30, 35],
    ],
    [
      ["Date", "Users", "Paid"],
      ["2024-01-01", 100, 20],
      ["2024-01-02", 120, 25],
      ["2024-01-03", 150, 30],
    ],
    [
      [1, 10],
      [2, 20],
      [3, 35],
      [4, 50],
    ],
    [
      ["Item", "Delta"],
      ["Start", 100],
      ["Gain", 40],
      ["Loss", -25],
    ],
    Array.from({ length: 25 }, (_, i) => [i * 3]),
  ];
  out.push(
    vec("recommendAndFromTable", false, { tables }, () =>
      tables.map((t) => ({
        shape: analyzeChartTable(t),
        recommendations: recommendChartTypes(t),
        fromAuto: chartFromTable(t),
        fromLine: chartFromTable(t, { type: "line" }),
      })),
    ),
  );

  const raceSpec = createChartSpec({
    type: "barrace",
    title: "Top Languages",
    categories: ["2020", "2021", "2022"],
    raceTopN: 2,
    series: [
      { id: "js", name: "JS", values: [50, 60, 70] },
      { id: "py", name: "Python", values: [45, 65, 80] },
      { id: "rs", name: "Rust", values: [10, 25, 40] },
    ],
  });

  const summarySpecs = [
    createChartSpec({
      type: "bar",
      title: "Sales",
      categories: ["Q1", "Q2", "Q3", "Q4"],
      series: [
        {
          id: "s1",
          name: "North",
          values: [10, 20, 30, 50],
          errorBars: { type: "percent", value: 5 },
        },
        {
          id: "s2",
          name: "South",
          values: [40, 35, 30, 20],
          axis: "secondary",
        },
      ],
      yAxis: { scale: "log", logBase: 10 },
      yAxis2: { reverse: true },
    }),
    createChartSpec({
      type: "pie",
      title: "Share",
      categories: ["A", "B", "C"],
      series: [{ id: "s1", name: "Share", values: [50, 30, 20] }],
    }),
    createChartSpec({
      type: "sunburst",
      tree: [
        {
          name: "Europe",
          children: [
            { name: "France", value: 40 },
            { name: "Germany", value: 60 },
          ],
        },
      ],
    }),
    createChartSpec({
      type: "choropleth",
      map: "europe",
      categories: ["FRA", "DEU", "Atlantis"],
      series: [{ id: "s1", name: "GDP", values: [2800, 4100, 100] }],
    }),
    raceSpec,
    createChartSpec({
      type: "sankey",
      links: [
        { source: "A", target: "B", value: 30 },
        { source: "B", target: "C", value: 20 },
      ],
    }),
    createChartSpec({
      type: "parliament",
      categories: ["Left", "Center", "Right"],
      series: [{ id: "s1", name: "Seats", values: [120, 80, 100] }],
    }),
    createChartSpec({
      type: "slope",
      categories: ["A", "B", "C"],
      series: [
        { id: "s1", name: "2023", values: [10, 30, 20] },
        { id: "s2", name: "2024", values: [25, 20, 20] },
      ],
    }),
    createChartSpec({
      type: "likert",
      categories: ["Ease of use", "Speed"],
      series: [
        { id: "s1", name: "Disagree", values: [10, 30] },
        { id: "s2", name: "Neutral", values: [20, 20] },
        { id: "s3", name: "Agree", values: [70, 50] },
      ],
    }),
    createChartSpec({
      type: "streamgraph",
      categories: ["Jan", "Feb", "Mar"],
      series: [
        { id: "s1", name: "A", values: [10, 20, 15] },
        { id: "s2", name: "B", values: [15, 25, 20] },
      ],
    }),
    createChartSpec({
      type: "waterfall",
      categories: ["Q1", "Q2", "Subtotal", "Q3", "Total"],
      series: [{ id: "s1", name: "Cash", values: [50, -20, 30, 40, 70] }],
    }),
    createChartSpec({
      type: "histogram",
      categories: ["1", "2", "3"],
      series: [{ id: "s1", name: "Scores", values: [10, 20, 30] }],
    }),
  ];

  out.push(
    vec(
      "raceAndSummary",
      false,
      { raceSpec, summarySpecs },
      () => ({
        raceValue: [0, 1, 2].map((i) => chartRaceValueAt(raceSpec.series[0], i)),
        raceMoments: [null, 0, 0.5, 1.25, 5].map((f) => chartRaceMoment(3, f)),
        raceRankings: [0, 0.5, 1, 2].map((f) => chartRaceRanking(raceSpec, f)),
        descriptions: summarySpecs.map((s) => describeChart(s)),
        summaries: summarySpecs.map((s) =>
          summarizeChart(
            s,
            { width: 640, height: 400 },
            {
              width: 640,
              height: 400,
              plot: { x: 48, y: 32, width: 560, height: 320 },
              marks: [],
              percent: false,
              theme: {
                background: "#ffffff",
                surface: "#ffffff",
                text: "#0f172a",
                mutedText: "#64748b",
                grid: "#e2e8f0",
                axis: "#94a3b8",
                selection: "#2563eb",
                positive: "#3ca951",
                negative: "#e5484d",
                fontFamily: "sans-serif",
                fontSize: 11,
                titleSize: 15,
              },
              warnings: [],
            },
          ),
        ),
      }),
    ),
  );

  return out;
}

function vectors() {
  return {
    version: 1,
    entries: [
      ...csvEntries(),
      ...specEntries(),
      ...linksTreeMapsEntries(),
      ...presetsRecommendSummaryEntries(),
    ],
  };
}

describe("Swift chart model test vectors", () => {
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
