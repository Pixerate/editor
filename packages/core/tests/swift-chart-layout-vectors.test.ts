import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { EUROPE_CHART_MAP } from "../src/chart-maps/europe.js";
import { ChartController } from "../src/chart/controller.js";
import {
  chartHitTest,
  describeChartSelection,
  snapChartDragValue,
} from "../src/chart/interaction.js";
import {
  chartCategoryAtPoint,
  chartValueAtPoint,
  chartXAtPoint,
  layoutChart,
  MAX_CHART_DATA_LABELS,
  MAX_CHART_LINE_POINTS,
  MAX_CHART_MARKERS,
  snapChartValue,
} from "../src/chart/layout.js";
import { registerChartMap } from "../src/chart/maps.js";
import { CHART_TYPES, normalizeChartSpec } from "../src/chart/spec.js";
import {
  layoutSparkline,
  type ChartSparklineOptions,
} from "../src/chart/sparkline.js";
import {
  blendChartScenes,
  ChartStream,
  easeChartTween,
  parsePartialChartJson,
} from "../src/chart/stream.js";
import {
  chartTooltipAt,
  chartTooltipFor,
  sameChartTooltip,
} from "../src/chart/tooltip.js";
import type { ChartLayoutOptions, ChartSelection, ChartSpec } from "../src/chart/types.js";
import { conformanceValuesMatch } from "../src/tools/conformance.js";

const FILE = join(
  __dirname,
  "../../swift/Tests/PixerateChartTests/Fixtures/chart-layout-vectors.json",
);
const FIXTURES_DIR = join(
  __dirname,
  "../../conformance/domains/chart/fixtures",
);

type Entry = Record<string, unknown>;
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
const vec = (
  fn: string,
  trig: boolean,
  inputs: Entry,
  compute: () => unknown,
): Entry => ({ fn, trig, ...json(inputs), out: json(compute()) });
const specOf = (input: unknown): ChartSpec => normalizeChartSpec(input).spec;

function fixtureEntries(): Entry[] {
  registerChartMap(EUROPE_CHART_MAP);
  const out: Entry[] = [];
  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8")) as {
      id: string;
      setup?: { width?: number; height?: number };
      steps?: Array<{
        expect?: { document?: { document?: Partial<ChartSpec> } };
      }>;
    };
    const width = raw.setup?.width ?? 640;
    const height = raw.setup?.height ?? 400;
    const docSteps = (raw.steps ?? []).filter(
      (s) => s.expect?.document?.document != null,
    );
    if (docSteps.length === 0) continue;
    const indices = Array.from(
      new Set([0, Math.floor(docSteps.length / 2), docSteps.length - 1]),
    );
    for (const idx of indices) {
      const spec = specOf(docSteps[idx]!.expect!.document!.document);
      const options: ChartLayoutOptions = { width, height };
      out.push(
        vec("layoutChart", false, { spec, options }, () =>
          layoutChart(spec, options),
        ),
      );
    }
  }
  return out;
}

function familyEntries(): Entry[] {
  registerChartMap(EUROPE_CHART_MAP);
  const out: Entry[] = [];
  const baseCategories = ["Q1", "Q2", "Q3", "Q4"];
  const baseSeries = [
    {
      id: "s1",
      name: "North",
      values: [120, 150, 180, 140],
      x: [10, 20, 30, 40],
      sizes: [5, 12, 8, 15],
      open: [110, 140, 175, 150],
      high: [130, 160, 190, 160],
      low: [100, 130, 160, 125],
    },
    {
      id: "s2",
      name: "South",
      values: [90, 110, 140, 160],
      x: [12, 24, 35, 48],
      sizes: [8, 6, 14, 10],
    },
    {
      id: "s3",
      name: "West",
      values: [60, 80, 70, 95],
    },
  ];
  for (const type of CHART_TYPES) {
    const partial: Partial<ChartSpec> = {
      type,
      title: `${type} chart`,
      subtitle: "Subtitle",
      note: "Source: Pixerate",
      categories:
        type === "choropleth"
          ? ["France", "Germany", "Spain", "Italy", "UnknownRegion"]
          : baseCategories,
      series:
        type === "choropleth"
          ? [{ id: "s1", name: "Value", values: [42, 85, 63, 51, 19] }]
          : baseSeries,
      dataLabels: true,
      tree: [
        {
          id: "root",
          name: "Root",
          children: [
            { id: "c1", name: "Branch A", value: 60 },
            {
              id: "c2",
              name: "Branch B",
              children: [
                { id: "c2a", name: "Leaf 1", value: 25 },
                { id: "c2b", name: "Leaf 2", value: 15 },
              ],
            },
          ],
        },
      ],
      links: [
        { source: "Search", target: "Landing", value: 100 },
        { source: "Social", target: "Landing", value: 50 },
        { source: "Landing", target: "Signup", value: 90 },
        { source: "Landing", target: "Drop", value: 60 },
      ],
    };
    const spec = specOf(partial);
    const options: ChartLayoutOptions = { width: 640, height: 400 };
    out.push(
      vec("layoutChart", false, { spec, options }, () =>
        layoutChart(spec, options),
      ),
    );
  }
  return out;
}

function edgeAndHelperEntries(): Entry[] {
  registerChartMap(EUROPE_CHART_MAP);
  const out: Entry[] = [];

  // 1. Empty chart
  const emptySpec = specOf({
    type: "bar",
    categories: [],
    series: [{ id: "s1", name: "S1", values: [] }],
  });
  out.push(
    vec(
      "layoutChart",
      false,
      { spec: emptySpec, options: { width: 480, height: 320, emptyMessage: "Nothing here" } },
      () => layoutChart(emptySpec, { width: 480, height: 320, emptyMessage: "Nothing here" }),
    ),
  );

  // 2. Single point, negative values, gaps, log scale with skipped values
  const edgeSpecs: Array<{ spec: ChartSpec; options?: ChartLayoutOptions }> = [
    // Crowded callouts (#792): every column, beside every horizontal bar, and on points, placed together.
    {
      spec: specOf({
        type: "bar",
        categories: ["A", "B", "C", "D", "E", "F"],
        series: [{ id: "s1", name: "Sales", values: [80, 95, 90, 100, 98, 60], callouts: ["Launch week", "Promo", "Steady", "Record high", "Close second", "Dip"] }],
      }),
    },
    {
      spec: specOf({
        type: "bar",
        orientation: "horizontal",
        categories: ["North", "South", "East", "West"],
        series: [{ id: "s1", name: "Reach", values: [120, 118, 40, 119], callouts: ["Best region by far", "Close behind", null, "Also close"] }],
      }),
    },
    {
      spec: specOf({
        type: "line",
        categories: ["1", "2", "3", "4", "5"],
        series: [
          { id: "s1", name: "A", values: [10, 12, 11, 13, 12], showMarkers: true, callouts: ["a1", null, "a3", null, "a5"] },
          { id: "s2", name: "B", values: [11, 12.5, 11.2, 12.8, 12.1], showMarkers: true, callouts: [null, "b2", "b3", "b4", null] },
        ],
      }),
    },
    {
      spec: specOf({
        type: "line",
        categories: ["Only"],
        series: [{ id: "s1", name: "Solo", values: [42], showMarkers: true }],
        dataLabels: true,
      }),
    },
    {
      spec: specOf({
        type: "bar",
        stacking: "stacked",
        orientation: "horizontal",
        categories: ["A", "B", "C", "D"],
        series: [
          { id: "s1", name: "PosNeg", values: [-40, 0, 55, -15] },
          { id: "s2", name: "Gaps", values: [20, null, -30, 45] },
        ],
        dataLabels: true,
      }),
    },
    {
      spec: specOf({
        type: "line",
        categories: ["A", "B", "C", "D", "E"],
        series: [{ id: "s1", name: "LogSeries", values: [0, -5, 10, null, 1000] }],
        yAxis: { scale: "log", showGrid: true, showLabels: true, showLine: true },
      }),
    },
    {
      spec: specOf({
        type: "combo",
        categories: ["Jan", "Feb", "Mar", "Apr"],
        series: [
          {
            id: "s1",
            name: "Revenue",
            type: "bar",
            values: [100, 140, 125, 180],
            errorBars: { type: "percent", value: 10 },
            trendlines: [{ type: "linear", showEquation: true, showR2: true, forecast: 1 }],
            callouts: [null, null, null, "Peak!"],
          },
          {
            id: "s2",
            name: "Margin",
            type: "line",
            axis: "secondary",
            values: [0.15, 0.22, 0.19, 0.28],
          },
        ],
        yAxis2: { showLabels: true, showLine: true, showGrid: false, title: "Margin %" },
        referenceLines: [{ axis: "y", value: 130, label: "Target", style: "dashed" }],
        referenceBands: [{ axis: "y", from: 100, to: 150, label: "Band" }],
        highlight: [{ seriesId: "s1", index: 1 }],
      }),
      options: {
        width: 700,
        height: 420,
        selection: { kind: "point", seriesId: "s1", index: 2 },
        readout: { seriesId: "s1", index: 2 },
      },
    },
    // Thinned labels & MAX_CHART_DATA_LABELS cap
    {
      spec: specOf({
        type: "bar",
        categories: Array.from({ length: MAX_CHART_DATA_LABELS + 10 }, (_, i) => `Category ${i + 1}`),
        series: [
          {
            id: "s1",
            name: "Many",
            values: Array.from({ length: MAX_CHART_DATA_LABELS + 10 }, (_, i) => ((i * 17) % 90) + 10),
          },
        ],
        dataLabels: true,
      }),
    },
    // Bar race with raceFrame
    {
      spec: specOf({
        type: "bar",
        barRace: true,
        categories: ["2020", "2021", "2022"],
        series: [
          { id: "s1", name: "Alpha", values: [100, 150, 220] },
          { id: "s2", name: "Beta", values: [130, 140, 190] },
          { id: "s3", name: "Gamma", values: [80, 170, 250] },
        ],
      }),
      options: { width: 640, height: 400, raceFrame: 1.35 },
    },
  ];

  for (const { spec, options } of edgeSpecs) {
    const opts = options ?? { width: 640, height: 400 };
    out.push(
      vec("layoutChart", false, { spec, options: opts }, () =>
        layoutChart(spec, opts),
      ),
    );
  }

  // 3. Sparklines
  const sparkCases: Array<{
    values: Array<number | null>;
    options: ChartSparklineOptions;
  }> = [
    {
      values: [10, 25, null, 18, 35, 12],
      options: { kind: "line", width: 140, height: 36, markers: true, highLow: true },
    },
    {
      values: [-10, 0, 20, -5, 30],
      options: { kind: "column", width: 120, height: 32, highLow: true },
    },
    {
      values: [15, -8, 0, 22, -3],
      options: { kind: "win-loss", width: 120, height: 32 },
    },
    {
      values: [5],
      options: { kind: "line", width: 80, height: 24 },
    },
    {
      values: [null, null],
      options: { kind: "line", width: 80, height: 24 },
    },
  ];
  for (const sp of sparkCases) {
    out.push(
      vec("layoutSparkline", false, { values: sp.values, options: sp.options }, () =>
        layoutSparkline(sp.values, sp.options),
      ),
    );
  }

  // 4. Tooltips & Interaction
  const sampleSpec = edgeSpecs[3]!.spec;
  const sampleOpts: ChartLayoutOptions = { width: 700, height: 420 };
  const sampleScene = layoutChart(sampleSpec, sampleOpts);
  const tooltipTargets: Array<{ index: number; seriesId?: string }> = [
    { index: 0, seriesId: "s1" },
    { index: 2, seriesId: "s2" },
    { index: 1 },
  ];
  for (const target of tooltipTargets) {
    out.push(
      vec(
        "chartTooltipFor",
        false,
        { spec: sampleSpec, index: target.index, seriesId: target.seriesId ?? null },
        () => chartTooltipFor(sampleSpec, target.index, target.seriesId),
      ),
    );
  }
  const probePoints = [
    { x: 200, y: 200 },
    { x: 350, y: 180 },
    { x: 10, y: 10 },
  ];
  for (const pt of probePoints) {
    for (const mode of ["point", "category"] as const) {
      out.push(
        vec(
          "chartTooltipAt",
          false,
          { spec: sampleSpec, options: sampleOpts, point: pt, mode },
          () => chartTooltipAt(sampleSpec, sampleScene, pt, { mode }),
        ),
      );
    }
    out.push(
      vec("chartHitTest", false, { spec: sampleSpec, options: sampleOpts, point: pt }, () =>
        chartHitTest(sampleScene, pt),
      ),
    );
    out.push(
      vec("chartValueAtPoint", false, { spec: sampleSpec, options: sampleOpts, point: pt }, () =>
        chartValueAtPoint(sampleScene, pt) ?? null,
      ),
    );
    out.push(
      vec("chartCategoryAtPoint", false, { spec: sampleSpec, options: sampleOpts, point: pt }, () =>
        chartCategoryAtPoint(sampleScene, pt) ?? null,
      ),
    );
  }

  const xySpec = specOf({
    type: "scatter",
    series: [{ id: "s1", name: "XY", x: [10, 20, 30], values: [5, 15, 25] }],
  });
  const xyOpts: ChartLayoutOptions = { width: 480, height: 320 };
  const xyScene = layoutChart(xySpec, xyOpts);
  out.push(
    vec("chartXAtPoint", false, { spec: xySpec, options: xyOpts, point: { x: 240, y: 160 } }, () =>
      chartXAtPoint(xyScene, { x: 240, y: 160 }) ?? null,
    ),
  );

  const t1 = chartTooltipFor(sampleSpec, 0, "s1");
  const t2 = chartTooltipFor(sampleSpec, 1, "s1");
  out.push(
    vec("sameChartTooltip", false, { spec: sampleSpec, i1: 0, s1: "s1", i2: 0, s2: "s1" }, () =>
      sameChartTooltip(t1, t1),
    ),
  );
  out.push(
    vec("sameChartTooltip", false, { spec: sampleSpec, i1: 0, s1: "s1", i2: 1, s2: "s1" }, () =>
      sameChartTooltip(t1, t2),
    ),
  );

  for (const v of [123.456, 0.00432, -48.75, 100]) {
    out.push(
      vec("snapChartValue", false, { spec: sampleSpec, options: sampleOpts, value: v }, () =>
        snapChartValue(sampleScene, v),
      ),
    );
    out.push(
      vec("snapChartDragValue", false, { spec: sampleSpec, options: sampleOpts, value: v }, () =>
        snapChartDragValue(sampleScene, v),
      ),
    );
  }

  const selections: Array<ChartSelection | null> = [
    null,
    { kind: "chart" },
    { kind: "title" },
    { kind: "subtitle" },
    { kind: "legend" },
    { kind: "axis", axis: "y" },
    { kind: "series", seriesId: "s1" },
    { kind: "category", index: 1 },
    { kind: "point", seriesId: "s1", index: 2 },
    { kind: "trendline", seriesId: "s1", index: 0 },
  ];
  const controller = new ChartController({ spec: sampleSpec });
  for (const sel of selections) {
    out.push(
      vec("describeChartSelection", false, { spec: sampleSpec, selection: sel }, () =>
        describeChartSelection(controller, sel),
      ),
    );
  }

  // 5. Stream & scene blending
  const partials = [
    '{"type":"bar","title":"Stream',
    '{"type":"bar","title":"Streaming","categories":["A","B"],"series":[{"id":"s1","name":"S1","values":[10,20',
    '```json\n{"type":"line","categories":["X","Y"],"series":[{"id":"s1","name":"Line","values":[5,15]}]}\n```',
    "not json at all",
  ];
  for (const text of partials) {
    out.push(vec("parsePartialChartJson", false, { text }, () => parsePartialChartJson(text)));
  }

  for (const t of [-0.2, 0, 0.25, 0.5, 0.75, 1, 1.2]) {
    out.push(vec("easeChartTween", false, { t }, () => easeChartTween(t)));
  }

  const fromSpec = specOf({
    type: "bar",
    categories: ["A", "B"],
    series: [{ id: "s1", name: "S1", values: [10, 20] }],
  });
  const toSpec = specOf({
    type: "bar",
    categories: ["A", "B"],
    series: [{ id: "s1", name: "S1", values: [30, 50] }],
  });
  const blendOpts: ChartLayoutOptions = { width: 480, height: 320 };
  const fromScene = layoutChart(fromSpec, blendOpts);
  const toScene = layoutChart(toSpec, blendOpts);
  for (const t of [0, 0.5, 1]) {
    out.push(
      vec("blendChartScenes", false, { fromSpec, toSpec, options: blendOpts, t }, () =>
        blendChartScenes(fromScene, toScene, t),
      ),
    );
  }

  const streamChunks = [
    { source: '{"type":"bar","categories":["A","B"],"series":[{"id":"s1","name":"S1","values":[10', complete: false },
    { source: '{"type":"bar","categories":["A","B"],"series":[{"id":"s1","name":"S1","values":[10,50]}]}', complete: false },
    { source: '{"type":"bar","categories":["A","B"],"series":[{"id":"s1","name":"S1","values":[10,50]}]}', complete: true },
  ];
  out.push(
    vec("chartStream", false, { chunks: streamChunks }, () => {
      const stream = new ChartStream("json");
      return streamChunks.map((c) => stream.update(c.source, c.complete));
    }),
  );

  return out;
}

describe("swift chart layout vectors", () => {
  it("matches recorded chart layout vectors", () => {
    const entries = [
      ...fixtureEntries(),
      ...familyEntries(),
      ...edgeAndHelperEntries(),
    ];
    if (process.env.UPDATE_SWIFT_VECTORS === "1") {
      mkdirSync(dirname(FILE), { recursive: true });
      writeFileSync(FILE, `${JSON.stringify({ entries }, null, 2)}\n`);
    }
    const saved = JSON.parse(readFileSync(FILE, "utf8")) as {
      entries: Entry[];
    };
    expect(conformanceValuesMatch(entries, saved.entries)).toBe(true);
  });
});
