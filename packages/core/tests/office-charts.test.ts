// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  ChartController,
  OfficeChartsError,
  chartToOoxml,
  createChartSpec,
  createOfficeChartToolProvider,
  describeOfficeChartPlace,
  extractDocxCharts,
  extractOfficeCharts,
  extractPptxCharts,
  extractXlsxCharts,
} from "../src/chart";
import { ToolRegistry } from "../src/tools";
import { buildDocx, buildZip, p } from "./helpers/zip-writer";

const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const CX = "http://schemas.microsoft.com/office/drawing/2014/chartex";
const REL_CHART = `${R}/chart`;
const REL_CHARTEX = "http://schemas.microsoft.com/office/2014/relationships/chartEx";

const rels = (items: [id: string, type: string, target: string][]) =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`)
    .join("")}</Relationships>`;

const rootRels = (target: string) => rels([["rId1", `${R}/officeDocument`, target]]);

const barXml = chartToOoxml(createChartSpec({ type: "bar", title: "Revenue", categories: ["Q1", "Q2"], series: [{ name: "North", values: [3, 5] }] })).xml;
const lineXml = chartToOoxml(createChartSpec({ type: "line", title: "Trend", categories: ["a", "b", "c"], series: [{ name: "S", values: [1, 2, 3] }] })).xml;
const waterfallXml = `<cx:chartSpace xmlns:cx="${CX}"><cx:chartData><cx:data id="0"><cx:strDim type="cat"><cx:lvl ptCount="2"><cx:pt idx="0">Start</cx:pt><cx:pt idx="1">Up</cx:pt></cx:lvl></cx:strDim><cx:numDim type="val"><cx:lvl ptCount="2"><cx:pt idx="0">10</cx:pt><cx:pt idx="1">5</cx:pt></cx:lvl></cx:numDim></cx:data></cx:chartData><cx:chart><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="waterfall"><cx:tx><cx:txData><cx:v>Cash</cx:v></cx:txData></cx:tx><cx:dataId val="0"/></cx:series></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>`;

const graphicFrame = (name: string, ref: string) =>
  `<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="${name}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><a:graphic><a:graphicData uri="${C}">${ref}</a:graphicData></a:graphic></xdr:graphicFrame>`;

async function buildXlsx(): Promise<Uint8Array> {
  const drawing1 = `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}" xmlns:c="${C}" xmlns:cx="${CX}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
    <xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>17</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>${graphicFrame("Chart 1", `<c:chart r:id="rId1"/>`)}<xdr:clientData/></xdr:twoCellAnchor>
    <mc:AlternateContent><mc:Choice Requires="cx1"><xdr:oneCellAnchor><xdr:from><xdr:col>27</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="1" cy="1"/>${graphicFrame("Waterfall", `<cx:chart r:id="rId2"/>`)}<xdr:clientData/></xdr:oneCellAnchor></mc:Choice><mc:Fallback/></mc:AlternateContent>
  </xdr:wsDr>`;
  const drawing2 = `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}" xmlns:c="${C}"><xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="1" cy="1"/>${graphicFrame("Chart 9", `<c:chart r:id="rId1"/>`)}<xdr:clientData/></xdr:absoluteAnchor></xdr:wsDr>`;
  return buildZip([
    { name: "_rels/.rels", data: rootRels("xl/workbook.xml") },
    {
      name: "xl/workbook.xml",
      data: `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Sales chart" sheetId="2" r:id="rId2"/><sheet name="Empty" sheetId="3" r:id="rId3"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: rels([
        ["rId1", `${R}/worksheet`, "worksheets/sheet1.xml"],
        ["rId2", `${R}/chartsheet`, "chartsheets/sheet1.xml"],
        ["rId3", `${R}/worksheet`, "worksheets/sheet2.xml"],
      ]),
    },
    { name: "xl/worksheets/sheet1.xml", data: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><sheetData/><drawing r:id="rId1"/></worksheet>` },
    { name: "xl/worksheets/_rels/sheet1.xml.rels", data: rels([["rId1", `${R}/drawing`, "../drawings/drawing1.xml"]]) },
    { name: "xl/worksheets/sheet2.xml", data: `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>` },
    { name: "xl/chartsheets/sheet1.xml", data: `<chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><drawing r:id="rId1"/></chartsheet>` },
    { name: "xl/chartsheets/_rels/sheet1.xml.rels", data: rels([["rId1", `${R}/drawing`, "../drawings/drawing2.xml"]]) },
    { name: "xl/drawings/drawing1.xml", data: drawing1 },
    { name: "xl/drawings/_rels/drawing1.xml.rels", data: rels([["rId1", REL_CHART, "../charts/chart1.xml"], ["rId2", REL_CHARTEX, "../charts/chartEx1.xml"]]) },
    { name: "xl/drawings/drawing2.xml", data: drawing2 },
    { name: "xl/drawings/_rels/drawing2.xml.rels", data: rels([["rId1", REL_CHART, "/xl/charts/chart2.xml"]]) },
    { name: "xl/charts/chart1.xml", data: barXml },
    { name: "xl/charts/chart2.xml", data: lineXml },
    { name: "xl/charts/chartEx1.xml", data: waterfallXml },
  ]);
}

async function buildPptx(): Promise<Uint8Array> {
  const slide = (frames: string) =>
    `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}" xmlns:c="${C}"><p:cSld><p:spTree>${frames}</p:spTree></p:cSld></p:sld>`;
  const frame = (name: string, rid: string) =>
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></p:xfrm><a:graphic><a:graphicData uri="${C}"><c:chart r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`;
  return buildZip([
    { name: "_rels/.rels", data: rootRels("ppt/presentation.xml") },
    // Slide order comes from sldIdLst, not part names.
    {
      name: "ppt/presentation.xml",
      data: `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
    },
    { name: "ppt/_rels/presentation.xml.rels", data: rels([["rId2", `${R}/slide`, "slides/slide1.xml"], ["rId3", `${R}/slide`, "slides/slide2.xml"]]) },
    { name: "ppt/slides/slide2.xml", data: slide("") },
    { name: "ppt/slides/slide1.xml", data: slide(frame("Revenue chart", "rId5") + frame("Missing", "rId9")) },
    { name: "ppt/slides/_rels/slide1.xml.rels", data: rels([["rId5", REL_CHART, "../charts/chart7.xml"]]) },
    { name: "ppt/charts/chart7.xml", data: barXml },
  ]);
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

describe("extractXlsxCharts", () => {
  it("reads charts on worksheets and chart sheets with sheet and anchor", async () => {
    const charts = await extractXlsxCharts(await buildXlsx());
    expect(charts.map((c) => [c.id, c.path, c.partKind, c.sheet, c.anchor, c.range, c.name, c.title])).toEqual([
      ["chart-1", "xl/charts/chart1.xml", "chart", "Data", "B2", "B2:H18", "Chart 1", "Revenue"],
      ["chart-2", "xl/charts/chartEx1.xml", "chartex", "Data", "AB4", undefined, "Waterfall", ""],
      ["chart-3", "xl/charts/chart2.xml", "chart", "Sales chart", undefined, undefined, "Chart 9", "Trend"],
    ]);
    expect(charts[0].spec).toMatchObject({ type: "bar", categories: ["Q1", "Q2"], series: [{ name: "North", values: [3, 5] }] });
    expect(charts[1].spec.type).toBe("waterfall");
    expect(charts[2].spec.type).toBe("line");
    expect(describeOfficeChartPlace(charts[0])).toBe("Data!B2");
    expect(describeOfficeChartPlace(charts[2])).toBe("Sales chart");
  });

  it("rejects other Office files and non-zip bytes with a useful error", async () => {
    await expect(extractXlsxCharts(await buildPptx())).rejects.toThrow("This is a .pptx file, not a .xlsx file.");
    await expect(extractOfficeCharts(new TextEncoder().encode("hello"))).rejects.toBeInstanceOf(OfficeChartsError);
    await expect(extractOfficeCharts(await buildZip([{ name: "a.txt", data: "x" }]))).rejects.toThrow(/names no main part/);
  });

  it("honours maxCharts", async () => {
    expect(await extractXlsxCharts(await buildXlsx(), { maxCharts: 1 })).toHaveLength(1);
  });
});

describe("extractPptxCharts", () => {
  it("numbers slides in presentation order and skips dangling references", async () => {
    const charts = await extractPptxCharts(await buildPptx());
    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({ id: "chart-1", path: "ppt/charts/chart7.xml", slide: 2, name: "Revenue chart", title: "Revenue", lossless: true });
    expect(describeOfficeChartPlace(charts[0])).toBe("Slide 2");
  });
});

describe("extractDocxCharts", () => {
  it("reads charts in the document body", async () => {
    const docx = await buildDocx({
      body: p(`<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" xmlns:r="${R}" r:id="rIdChart"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`),
      rels: `<Relationship Id="rIdChart" Type="${REL_CHART}" Target="charts/chart1.xml"/>`,
      files: { "word/charts/chart1.xml": lineXml },
    });
    const charts = await extractDocxCharts(docx);
    expect(charts.map((c) => [c.id, c.path, c.title])).toEqual([["chart-1", "word/charts/chart1.xml", "Trend"]]);
    expect(await extractOfficeCharts(docx)).toMatchObject({ format: "docx" });
  });
});

describe("createOfficeChartToolProvider", () => {
  it("lists and gets charts from base64 data", async () => {
    const registry = new ToolRegistry();
    registry.register(createOfficeChartToolProvider());
    expect(registry.listTools().tools.map((t) => t.name)).toEqual(["list_file_charts", "get_file_chart"]);
    const data = b64(await buildXlsx());
    const listed = await registry.callTool("list_file_charts", { data });
    expect(listed.isError).toBeFalsy();
    expect(listed.structuredContent).toMatchObject({
      format: "xlsx",
      charts: [
        { id: "chart-1", place: "Data!B2", sheet: "Data", anchor: "B2", range: "B2:H18", type: "bar", series: ["North"], categories: 2 },
        { id: "chart-2", partKind: "chartex", type: "waterfall" },
        { id: "chart-3", place: "Sales chart", type: "line" },
      ],
    });
    const got = await registry.callTool("get_file_chart", { data: `data:application/zip;base64,${data}`, chartId: "chart-3" });
    expect(got.structuredContent).toMatchObject({ id: "chart-3", spec: { type: "line", title: "Trend" } });
  });

  it("fails usefully on bad input", async () => {
    const registry = new ToolRegistry();
    registry.register(createOfficeChartToolProvider());
    const missing = await registry.callTool("list_file_charts", {});
    expect(missing.isError).toBe(true);
    const bad = await registry.callTool("list_file_charts", { data: "!!!" });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toContain("not valid base64");
    const unknown = await registry.callTool("get_file_chart", { data: b64(await buildPptx()), chartId: "chart-9" });
    expect(JSON.stringify(unknown.content)).toContain('expected one of \\"chart-1\\" (Slide 2)');
  });

  it("reads open files by name and loads a chart as one undo step", async () => {
    const controller = new ChartController();
    const before = controller.toJSON();
    const files = [{ name: "deck.pptx", data: await buildPptx() }];
    let readOnly: string | false = false;
    const registry = new ToolRegistry();
    registry.register(createOfficeChartToolProvider({ files: () => files, controller, readOnly: () => readOnly }));
    expect(registry.listTools().tools.map((t) => t.name)).toEqual(["list_open_files", "list_file_charts", "get_file_chart", "load_file_chart"]);
    expect((await registry.callTool("list_open_files", {})).structuredContent).toEqual({ files: [{ name: "deck.pptx", bytes: files[0].data.byteLength }] });
    const noFile = await registry.callTool("list_file_charts", { file: "nope.xlsx" });
    expect(JSON.stringify(noFile.content)).toContain('expected one of \\"deck.pptx\\"');
    const loaded = await registry.callTool("load_file_chart", { file: "deck.pptx", chartId: "chart-1" });
    expect(loaded.isError).toBeFalsy();
    expect(loaded.structuredContent).toMatchObject({ id: "chart-1", place: "Slide 2", spec: { type: "bar", title: "Revenue" } });
    expect(controller.getSpec().title).toBe("Revenue");
    controller.undo();
    expect(controller.getSpec().title).toBe(before.title);
    readOnly = "Locked";
    expect(registry.listTools().tools.map((t) => t.name)).not.toContain("load_file_chart");
  });
});
