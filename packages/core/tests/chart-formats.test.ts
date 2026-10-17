// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  CHART_MERMAID_META_PREFIX,
  ChartStream,
  blendChartScenes,
  chartFromMermaid,
  chartFromOoxml,
  chartToMermaid,
  chartToOoxml,
  createChartSpec,
  findMermaidCharts,
  formatChartNumber,
  layoutChart,
  parsePartialChartJson,
  type ChartSpec,
} from "../src/chart";
import { docxToDocumentImport } from "../src";
import { buildDocx, p } from "./helpers/zip-writer";

const SPECS: Partial<ChartSpec>[] = [
  {
    type: "bar",
    title: "Revenue vs margin",
    categories: ["Q1", "Q2 2024", "Q3", "Q4"],
    series: [
      { id: "rev", name: "Revenue", values: [42, null, 51, 60], color: "#4472c4" },
      { id: "m", name: "Margin %", values: [0.28, 0.31, 0.3, 0.37], type: "line", axis: "secondary", marker: "diamond" },
    ],
    yAxis2: { format: { style: "percent" } },
    dataLabels: true,
  },
  { type: "line", categories: ["a", "b"], series: [{ name: "S", values: [1, 2] }], yAxis: { min: 0, title: "Y" } },
  { type: "area", stacking: "stacked", categories: ["a", "b"], series: [{ name: "A", values: [1, 2] }, { name: "B", values: [3, 4] }] },
  { type: "donut", categories: ["A", 'B "q"'], series: [{ name: "S", values: [5, 3] }] },
  { type: "radar", categories: ["Speed", "Power x", "Range"], series: [{ name: "A", values: [4, 3, 5] }, { name: "B b", values: [3, 5, 2] }], yAxis: { max: 10 } },
  { type: "scatter", categories: ["a", "b"], series: [{ name: "S", values: [1, 2], x: [3, 4], trendlines: [{ type: "linear", showR2: true }] }] },
  { type: "waterfall", categories: ["a", "b"], series: [{ name: "S", values: [1, -2] }] },
];

describe("Mermaid charts", () => {
  it.each(SPECS.map((s) => [s.type, s] as const))("round-trips a %s chart exactly through Mermaid", (_, input) => {
    const spec = createChartSpec(input);
    const text = chartToMermaid(spec);
    const back = chartFromMermaid(text);
    expect(back.issues).toEqual([]);
    expect(back.spec).toEqual(spec);
    // Without the metadata line it is still valid and keeps the basics.
    const plain = chartFromMermaid(chartToMermaid(spec, { meta: false }));
    expect(plain.issues).toEqual([]);
    expect(plain.spec.categories).toEqual(spec.categories);
  });

  it("writes plain Mermaid for what Mermaid can hold, and one comment for the rest", () => {
    const text = chartToMermaid(createChartSpec(SPECS[0]));
    expect(text.split("\n")[0]).toBe("xychart-beta");
    expect(text).toContain('    x-axis [Q1, "Q2 2024", Q3, Q4]');
    expect(text).toContain('    bar "Revenue" [42, 0, 51, 60]');
    expect(text).toContain('    line "Margin %" [0.28, 0.31, 0.3, 0.37]');
    const meta = text.split("\n").find((l) => l.startsWith(CHART_MERMAID_META_PREFIX))!;
    expect(JSON.parse(meta.slice(CHART_MERMAID_META_PREFIX.length))).toMatchObject({ v: 1, dataLabels: true, series: [{ color: "#4472c4", values: [42, null, 51, 60] }, { axis: "secondary", marker: "diamond" }] });
    expect(chartToMermaid(createChartSpec({ type: "line", categories: ["a"], series: [{ name: "S", values: [1] }] }))).not.toContain("@pixerate");
  });

  it("is accepted by Mermaid's own parser", async () => {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({ startOnLoad: false });
    for (const input of SPECS) {
      const text = chartToMermaid(createChartSpec(input));
      const diagram = await mermaid.mermaidAPI.getDiagramFromText(text);
      expect(["xychart", "pie", "radar"]).toContain(diagram.type);
    }
    const pie = await mermaid.mermaidAPI.getDiagramFromText(chartToMermaid(createChartSpec(SPECS[3])));
    expect([...(pie.db as any).getSections().values()]).toEqual([5, 3]);
  });

  it("reads Mermaid written by people: frontmatter titles, keyed radar curves, comments", () => {
    const read = chartFromMermaid(`---\ntitle: Pets\n---\npie showData\n  %% a comment\n  "Dogs" : 386\n  "Cats" : 85.5\n`);
    expect(read.spec).toMatchObject({ type: "pie", title: "Pets", dataLabels: true, categories: ["Dogs", "Cats"] });
    expect(read.spec.series[0].values).toEqual([386, 85.5]);
    const radar = chartFromMermaid(`radar-beta\n  axis m["Math"], s["Science"]\n  curve alice["Alice"]{ s: 9, m: 7 }\n  showLegend false\n`);
    expect(radar.spec.categories).toEqual(["Math", "Science"]);
    expect(radar.spec.series[0]).toMatchObject({ id: "alice", name: "Alice", values: [7, 9] });
    expect(radar.spec.legend.show).toBe(false);
    const xy = chartFromMermaid(`xychart-beta horizontal\n  y-axis "Sales" 0 --> 100\n  bar [1, 2, 3]\n`);
    expect(xy.spec).toMatchObject({ orientation: "horizontal", categories: ["1", "2", "3"], yAxis: { title: "Sales", min: 0, max: 100 } });
  });

  it("reports unreadable lines with their line numbers and never throws", () => {
    const read = chartFromMermaid(`xychart-beta\n  x-axis [a, b]\n  bar [1, oops]\n  wibble\n`);
    expect(read.issues.map((i) => i.line)).toEqual([3, 4]);
    expect(read.issues[0].message).toBe("Line 3: bar values must be numbers.");
    expect(read.issues[1].message).toBe('Line 4: could not read "wibble"; it was skipped.');
    expect(chartFromMermaid("flowchart LR\n A-->B")).toMatchObject({ family: null });
    expect(chartFromMermaid("").issues[0].message).toMatch(/empty/);
    expect(chartFromMermaid(`xychart-beta\n${CHART_MERMAID_META_PREFIX}{oops\n`).issues[0].message).toMatch(/not valid JSON/);
  });

  it("reads a statement that is still arriving when partial", () => {
    const read = chartFromMermaid('xychart-beta\n  x-axis [a, b, c]\n  bar "S" [5, 9,', { partial: true });
    expect(read.issues).toEqual([]);
    expect(read.spec.series[0].values).toEqual([5, 9, null]);
  });

  it("finds Mermaid charts in Markdown or chat", () => {
    const md = "Here you go:\n\n```mermaid\npie\n  \"A\" : 1\n```\n\n```mermaid\nflowchart LR\n A-->B\n```\n\n~~~\nxychart-beta\n  bar [1]\n~~~\n";
    expect(findMermaidCharts(md).map((f) => [f.family, f.line])).toEqual([["pie", 4], ["xychart", 14]]);
    expect(findMermaidCharts("radar-beta\n axis a, b, c\n")[0].family).toBe("radar");
    expect(findMermaidCharts("Just prose about pie.")).toEqual([]);
  });
});

describe("streaming charts", () => {
  it("reads JSON that is still arriving", () => {
    expect(parsePartialChartJson('{"type":"bar","series":[{"name":"A","values":[1,2')).toEqual({ type: "bar", series: [{ name: "A", values: [1, 2] }] });
    expect(parsePartialChartJson('{"title":"x","ser')).toEqual({ title: "x" });
    expect(parsePartialChartJson('{"values":[1,2.')).toEqual({ values: [1, 2] });
    expect(parsePartialChartJson("")).toBeUndefined();
  });

  it("keeps the axis growing until complete, then lets go", () => {
    const stream = new ChartStream();
    const src = 'xychart-beta\n  x-axis [a, b, c]\n  bar "S" [5, 9, 3]\n';
    expect(stream.update("xychart-be").spec).toBeNull();
    const mid = stream.update(src.slice(0, src.indexOf("9") + 1));
    expect(mid.spec!.series[0].values).toEqual([5, 9, null]);
    expect(mid.valueDomain).toEqual({ min: 0, max: 9 });
    const smaller = stream.update('xychart-beta\n  x-axis [a, b, c]\n  bar "S" [5');
    expect(smaller.valueDomain).toEqual({ min: 0, max: 9 });
    const done = stream.update(src, true);
    expect(done.valueDomain).toBeNull();
    expect(done.issues).toEqual([]);
    const json = new ChartStream("json").update('{"categories":["a"],"series":[{"name":"S","values":[4');
    expect(json.spec!.series[0].values).toEqual([4]);
  });

  it("blends scenes by mark key", () => {
    const a = layoutChart(createChartSpec({ categories: ["a"], series: [{ name: "S", values: [1] }] }), { width: 200, height: 100 });
    const b = layoutChart(createChartSpec({ categories: ["a"], series: [{ name: "S", values: [3] }] }), { width: 200, height: 100 });
    const bar = (s: typeof a) => s.marks.find((m) => m.role === "bar") as any;
    const half = blendChartScenes(a, b, 0.5);
    expect(bar(half).height).toBeCloseTo((bar(a).height + bar(b).height) / 2, 6);
    expect(blendChartScenes(a, b, 1)).toBe(b);
    expect(blendChartScenes(null, b, 0.3)).toBe(b);
  });
});

const c = (inner: string, root = "") =>
  `<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"${root}><c:chart>${inner}</c:chart></c:chartSpace>`;
const str = (items: string[]) => `<c:strCache><c:ptCount val="${items.length}"/>${items.map((s, i) => `<c:pt idx="${i}"><c:v>${s}</c:v></c:pt>`).join("")}</c:strCache>`;
const num = (items: (number | null)[], code = "General") =>
  `<c:numCache><c:formatCode>${code}</c:formatCode><c:ptCount val="${items.length}"/>${items.map((v, i) => (v === null ? "" : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join("")}</c:numCache>`;

describe("Office (OOXML) charts", () => {
  it.each(SPECS.filter((s) => s.type !== "waterfall").map((s) => [s.type, s] as const))("round-trips a %s chart through c:chartSpace", (_, input) => {
    const spec = createChartSpec(input);
    const { xml, issues } = chartToOoxml(spec);
    expect(issues).toEqual([]);
    const back = chartFromOoxml(xml);
    expect(back.unsupported).toEqual([]);
    // OOXML keeps no series ids, keeps formats as codes, and scatter charts have no category labels.
    const label = (f: ChartSpec["yAxis"]["format"]) => [0, 0.25, 1234.5, -3].map((v) => formatChartNumber(v, f)).join("|");
    const strip = (s: ChartSpec) => ({
      ...s,
      ...(s.type === "scatter" ? { categories: [] } : {}),
      series: s.series.map(({ id: _id, format, ...rest }) => ({ ...rest, ...(format ? { format: label(format) } : {}) })),
      yAxis: { ...s.yAxis, format: label(s.yAxis.format) },
      yAxis2: { ...s.yAxis2, format: label(s.yAxis2.format) },
    });
    expect(strip(back.spec)).toEqual(strip(spec));
  });

  it("reads a PowerPoint-style combo chart: secondary axis by position, not file order", () => {
    const xml = c(
      `<c:title><c:tx><c:rich><a:p><a:r><a:t>Sales</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea>` +
        `<c:lineChart><c:grouping val="standard"/><c:ser><c:idx val="1"/><c:tx><c:strRef><c:f>x</c:f>${str(["Share"])}</c:strRef></c:tx><c:marker><c:symbol val="triangle"/></c:marker><c:cat><c:strRef>${str(["A", "B"])}</c:strRef></c:cat><c:val><c:numRef>${num([0.2, 0.4], "0%")}</c:numRef></c:val></c:ser><c:axId val="3"/><c:axId val="4"/></c:lineChart>` +
        `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:tx><c:v>Units</c:v></c:tx><c:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></c:spPr><c:dPt><c:idx val="1"/><c:spPr><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></c:spPr></c:dPt><c:cat><c:strRef>${str(["A", "B"])}</c:strRef></c:cat><c:val><c:numRef>${num([10, 20])}</c:numRef></c:val><c:trendline><c:trendlineType val="poly"/><c:order val="3"/><c:dispRSqr val="1"/></c:trendline></c:ser><c:gapWidth val="150"/><c:axId val="1"/><c:axId val="2"/></c:barChart>` +
        `<c:catAx><c:axId val="1"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:max val="50"/></c:scaling><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="#,##0" sourceLinked="0"/><c:majorUnit val="10"/><c:crossAx val="1"/></c:valAx>` +
        `<c:catAx><c:axId val="3"/><c:delete val="1"/><c:axPos val="b"/><c:crossAx val="4"/></c:catAx><c:valAx><c:axId val="4"/><c:axPos val="r"/><c:crosses val="max"/><c:crossAx val="3"/></c:valAx>` +
        `</c:plotArea><c:legend><c:legendPos val="t"/></c:legend>`,
    );
    const { spec, unsupported, lossless } = chartFromOoxml(xml);
    expect(unsupported).toEqual([]);
    expect(lossless).toBe(true);
    expect(spec).toMatchObject({ type: "bar", title: "Sales", categories: ["A", "B"], legend: { show: true, position: "top" } });
    expect(spec.yAxis).toMatchObject({ max: 50, step: 10, gridlines: true, format: { code: "#,##0" } });
    expect(spec.series[0]).toMatchObject({ name: "Share", type: "line", axis: "secondary", marker: "triangle", format: { code: "0%" }, values: [0.2, 0.4] });
    expect(spec.series[1]).toMatchObject({ name: "Units", color: "#ff0000", pointColors: [null, "#00ff00"], trendlines: [{ type: "polynomial", order: 3, showR2: true }] });
    expect(spec.series[1].axis).toBeUndefined();
    expect(spec.gapWidth).toBe(0.6);
  });

  it("reads chartex waterfall, funnel and box parts", () => {
    const cx = (layout: string) =>
      `<cx:chartSpace xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chartData><cx:data id="0"><cx:strDim type="cat"><cx:lvl ptCount="3"><cx:pt idx="0">Start</cx:pt><cx:pt idx="1">Up</cx:pt><cx:pt idx="2">Down</cx:pt></cx:lvl></cx:strDim><cx:numDim type="val"><cx:lvl ptCount="3" formatCode="General"><cx:pt idx="0">10</cx:pt><cx:pt idx="1">5</cx:pt><cx:pt idx="2">-3</cx:pt></cx:lvl></cx:numDim></cx:data></cx:chartData><cx:chart><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="${layout}"><cx:tx><cx:txData><cx:v>Cash</cx:v></cx:txData></cx:tx><cx:dataId val="0"/></cx:series></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>`;
    const wf = chartFromOoxml(cx("waterfall"));
    expect(wf.spec).toMatchObject({ type: "waterfall", categories: ["Start", "Up", "Down"], showTotal: false });
    expect(wf.spec.series[0]).toMatchObject({ name: "Cash", values: [10, 5, -3] });
    expect(chartFromOoxml(cx("funnel")).spec.type).toBe("funnel");
    expect(chartFromOoxml(cx("boxWhisker")).spec.type).toBe("box");
    expect(chartFromOoxml(cx("regionMap")).issues[0].message).toMatch(/not supported/);
  });

  it("names what it cannot hold and refuses what is not a chart", () => {
    const threeD = chartFromOoxml(c(`<c:plotArea><c:bar3DChart><c:barDir val="col"/><c:ser><c:tx><c:v>S</c:v></c:tx><c:val><c:numRef>${num([1])}</c:numRef></c:val></c:ser></c:bar3DChart></c:plotArea>`));
    expect(threeD.lossless).toBe(false);
    expect(threeD.unsupported).toEqual(["3-D bar chart (drawn flat)"]);
    const stock = chartFromOoxml(c(`<c:plotArea><c:stockChart/></c:plotArea>`));
    expect(stock.issues[0].message).toBe("The chart type is not supported: stock chart.");
    expect(chartFromOoxml("<not-a-chart/>").issues[0].message).toMatch(/not a chart part/);
  });

  it("says what it could not write", () => {
    expect(chartToOoxml(createChartSpec({ type: "area", curve: "smooth", categories: ["a"], series: [{ name: "S", values: [1] }] })).issues).toEqual(['"S" is a smoothed area, which DrawingML cannot express; it is written straight.']);
    const { issues } = chartToOoxml(createChartSpec({ type: "treemap", subtitle: "x", categories: ["a"], series: [{ name: "S", values: [1] }] }));
    expect(issues).toContain("Treemaps are written as pie charts: DrawingML has no treemap type.");
    expect(issues).toContain("The subtitle is left out: DrawingML charts have one title.");
  });

  it("imports charts embedded in Word documents as a caption, a data table and a spec", async () => {
    const chart = chartToOoxml(createChartSpec({ title: "Revenue", categories: ["Q1", "Q2"], series: [{ name: "North", values: [10, 20] }] })).xml;
    const drawing = `<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Chart 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rChart"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    const bytes = await buildDocx({
      body: p(`<w:r><w:t>Before </w:t></w:r>${drawing}`),
      rels: '<Relationship Id="rChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/>',
      files: { "word/charts/chart1.xml": chart },
    });
    const result = await docxToDocumentImport(bytes, { DOMParser: window.DOMParser as any });
    expect(result.charts).toHaveLength(1);
    expect(result.charts![0]).toMatchObject({ id: "chart-1", path: "word/charts/chart1.xml", title: "Revenue", lossless: true });
    expect(result.charts![0].spec.series[0].values).toEqual([10, 20]);
    expect(result.html).toContain("[Chart: Revenue]");
    expect(result.html).toMatch(/<table>.*North.*Q1.*10.*Q2.*20.*<\/table>/s);
    const none = await docxToDocumentImport(bytes, { DOMParser: window.DOMParser as any, charts: false });
    expect(none.charts).toBeUndefined();
    expect(none.html).not.toContain("Chart:");
  });
});
