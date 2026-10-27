// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools";
import {
  ChartController,
  addChartLink,
  chartFromMermaid,
  chartLinksFromTable,
  chartSankeyNodeValues,
  chartSankeyNodes,
  chartToMermaid,
  chartToOoxml,
  createChartSpec,
  createChartToolProvider,
  describeChart,
  layoutChart,
  normalizeChartLinks,
  setChartLinkField,
  type ChartIssue,
  type ChartLink,
  type ChartMark,
  type ChartScene,
  type ChartSpec,
} from "../src/chart";

const links: ChartLink[] = [
  { source: "Website", target: "Discovery", value: 120 },
  { source: "Events", target: "Discovery", value: 60 },
  { source: "Discovery", target: "Proposal", value: 130 },
  { source: "Discovery", target: "Lost", value: 50 },
  { source: "Proposal", target: "Won", value: 70 },
  { source: "Proposal", target: "Lost", value: 60 },
];

const SIZE = { width: 640, height: 400 };
const scene = (spec: Partial<ChartSpec>) => layoutChart(createChartSpec(spec), SIZE);
const role = (s: ChartScene, r: ChartMark["role"]) => s.marks.filter((m) => m.role === r);
const byKey = (s: ChartScene, key: string) => s.marks.find((m) => m.key === key);
const rect = (m: ChartMark | undefined) => {
  if (m?.kind !== "rect") throw new Error(`expected a rect, got ${m?.kind}`);
  return m;
};

describe("flows", () => {
  it("are checked one by one: names, values, repeats and loops", () => {
    const issues: ChartIssue[] = [];
    const out = normalizeChartLinks(
      [
        { source: "A", target: "B", value: "1,200" },
        { source: "A", target: "B", value: 3 },
        { source: "B", target: "A", value: 1 },
        { source: "C", target: "C", value: 1 },
        { source: "B", target: "C", value: 0 },
        { source: "B", value: 2 },
        { source: "B", target: "D", value: 1, width: 3 },
      ],
      issues,
    );
    expect(out).toEqual([{ source: "A", target: "B", value: 1200 }, { source: "B", target: "D", value: 1 }]);
    expect(issues.map((i) => i.message)).toEqual([
      'The flow from "A" to "B" appears twice; add the values into one flow. The second was left out.',
      'The flow from "B" to "A" would close a loop (A already leads back to B); flows must only go forwards, so it was left out.',
      'links[3] goes from "C" to itself; a flow must join two different nodes.',
      'The flow from "B" to "C" needs a value above 0; got 0.',
      "links[5] needs a source and a target (node names).",
      'links[6] has no "width"; a flow takes source, target, value and color.',
    ]);
  });

  it("make the nodes the categories and their throughput the first series", () => {
    expect(chartSankeyNodes(links)).toEqual(["Website", "Discovery", "Events", "Proposal", "Lost", "Won"]);
    expect(chartSankeyNodes(links, ["Events", "Nope"], [])).toEqual(["Events", "Website", "Discovery", "Proposal", "Lost", "Won"]);
    expect(chartSankeyNodeValues(links, ["Discovery", "Lost"])).toEqual([180, 110]);
    const spec = createChartSpec({ type: "bar", links, sankeyNodes: ["Events"] });
    expect(spec.categories[0]).toBe("Events");
    expect(spec.series[0].values).toEqual([60, 120, 180, 130, 110, 70]);
    expect(createChartSpec({ links, tree: [{ name: "x", value: 1 }] }).tree).toEqual([]);
  });

  it("read from tables and edited as rows", () => {
    expect(chartLinksFromTable([["From", "To", "Amount"], ["A", "B", 3]])).toEqual([{ source: "A", target: "B", value: 3 }]);
    expect(chartLinksFromTable([["A", "B", "3"]])).toEqual([{ source: "A", target: "B", value: "3" }]);
    expect(setChartLinkField(links, 0, "target", " Signup ")[0]).toMatchObject({ target: "Signup" });
    expect(addChartLink(links).at(-1)).toEqual({ source: "Lost", target: "Step 7", value: 60 });
    expect(addChartLink([])).toEqual([{ source: "Start", target: "Step 1", value: 1 }]);
  });
});

describe("Sankey layout", () => {
  it("puts nodes in columns by the flows into them, sinks on the right", () => {
    const s = scene({ type: "sankey", links });
    const x = (name: string) => rect(byKey(s, `node-${createChartSpec({ links }).sankeyNodes.indexOf(name)}`)).x;
    expect(x("Website")).toBeCloseTo(x("Events"), 6);
    expect(x("Discovery")).toBeGreaterThan(x("Website"));
    expect(x("Proposal")).toBeGreaterThan(x("Discovery"));
    // Lost is reached from columns 1 and 2, and Won from column 2; sinks line up on the right.
    expect(x("Lost")).toBeCloseTo(x("Won"), 6);
    expect(x("Won")).toBeGreaterThan(x("Proposal"));
  });

  it("sizes nodes and flows on one scale, flows leaving and arriving without gaps", () => {
    const s = scene({ type: "sankey", links });
    const nodes = createChartSpec({ links }).sankeyNodes;
    const discovery = rect(byKey(s, `node-${nodes.indexOf("Discovery")}`));
    const website = rect(byKey(s, `node-${nodes.indexOf("Website")}`));
    expect(discovery.height / website.height).toBeCloseTo(180 / 120, 3);
    expect(role(s, "link")).toHaveLength(6);
    expect(role(s, "link").every((m) => !m.target && m.kind === "path")).toBe(true);
    expect(byKey(s, `label-node-${nodes.indexOf("Won")}`)).toMatchObject({ text: "Won", anchor: "end" });
    expect(byKey(scene({ type: "sankey", links, dataLabels: true }), `label-node-${nodes.indexOf("Website")}`)).toMatchObject({ text: "Website 120", anchor: "start" });
    expect(role(s, "legend-label")).toHaveLength(0);
  });

  it("colours flows by source, target or grey, and keeps highlighted nodes' flows bright", () => {
    const fills = (spec: Partial<ChartSpec>) => role(scene({ type: "sankey", links, ...spec }), "link").map((m) => (m.kind === "path" ? m.fill : ""));
    const bySource = fills({});
    const byTarget = fills({ sankeyLinkColor: "target" });
    expect(bySource[0]).toBe(bySource.find((_, k) => links[k].source === "Website"));
    expect(byTarget[0]).toBe(byTarget[1]); // both reach Discovery
    expect(new Set(fills({ sankeyLinkColor: "gray" })).size).toBe(1);
    const lit = scene({ type: "sankey", links, highlight: ["Won"] });
    const opacity = role(lit, "link").map((m) => m.opacity);
    expect(opacity[4]).toBe(0.35); // Proposal → Won
    expect(opacity[0]).toBeCloseTo(0.35 * 0.25, 6);
    expect(rect(byKey(lit, "node-0")).opacity).toBe(0.25);
  });

  it("draws its table as bars until it has flows", () => {
    const s = scene({ type: "sankey", categories: ["a", "b"], series: [{ name: "S", values: [1, 2] }] });
    expect(s.warnings.find((w) => w.code === "type-fallback")?.message).toBe("A Sankey diagram needs flows (set_chart_links); it is drawn as a bar chart until then.");
    expect(role(s, "bar")).toHaveLength(2);
  });

  it("is described by its sources, sinks and largest flow", () => {
    expect(describeChart(createChartSpec({ type: "sankey", links, title: "Pipeline" }))).toBe(
      "Pipeline: a sankey chart of 6 flows between 6 nodes, from Website, Events to Lost, Won. The largest flow is Discovery → Proposal (130); all flows add up to 490.",
    );
  });
});

describe("ChartController flows", () => {
  it("adds, changes and removes flows as single undo steps", () => {
    const c = new ChartController({ spec: { type: "sankey" } });
    expect(c.addLink({ source: "A", target: "B", value: 5 })).toEqual({ ok: true, index: 0 });
    expect(c.addLink({ source: "B", target: "C", value: 3 })).toEqual({ ok: true, index: 1 });
    expect(c.getState().undoLabel).toBe("Add flow B → C");
    expect(c.addLink({ source: "C", target: "A", value: 1 })).toMatchObject({ ok: false, message: expect.stringMatching(/would close a loop/) });
    expect(c.updateLink(0, { value: 8, color: "#f00" })).toEqual({ ok: true });
    expect(c.getSpec().links[0]).toEqual({ source: "A", target: "B", value: 8, color: "#f00" });
    expect(c.updateLink(0, { color: null })).toEqual({ ok: true });
    expect(c.getSpec().links[0].color).toBeUndefined();
    expect(c.updateLink(5, { value: 1 })).toMatchObject({ ok: false, message: "There is no flow 5; expected 0 to 1." });
    expect(c.removeLink(1)).toEqual({ ok: true });
    expect(c.getSpec().categories).toEqual(["A", "B"]);
    c.undo();
    expect(c.getSpec().links).toHaveLength(2);
    expect(c.setLinks([])).toEqual({ ok: true });
    expect(c.getSpec()).toMatchObject({ links: [], sankeyNodes: [], categories: ["A", "B", "C"] });
  });

  it("refuses cell edits while the data is flows, and lets new data replace them", () => {
    const c = new ChartController({ spec: { type: "sankey", links } });
    expect(c.setValue(c.getSpec().series[0].id, 0, 1)).toMatchObject({ ok: false, message: expect.stringMatching(/This chart's data is flows \(links\)/) });
    expect(c.importCsv("a,1\nb,2", { header: false })).toEqual({ ok: true });
    expect(c.getSpec().links).toEqual([]);
    const d = new ChartController({ spec: { links } });
    expect(d.setTree([{ name: "x", value: 1 }])).toEqual({ ok: true });
    expect(d.getSpec()).toMatchObject({ links: [], categories: ["x"] });
  });

  it("imports flows from a table", () => {
    const c = new ChartController({});
    expect(c.importLinksTable([["Source", "Target", "Value"], ["A", "B", 2]])).toEqual({ ok: true });
    expect(c.getSpec().links).toEqual([{ source: "A", target: "B", value: 2 }]);
    expect(c.importLinksTable([["Source", "Target", "Value"]])).toMatchObject({ ok: false, message: expect.stringMatching(/no flows to import/) });
  });
});

describe("flows in files and agent tools", () => {
  it("round-trip through Mermaid and are written to Office as node amounts", () => {
    const spec = createChartSpec({ type: "sankey", links, sankeyLinkColor: "target", sankeyNodes: ["Events"] });
    expect(chartFromMermaid(chartToMermaid(spec)).spec).toEqual(spec);
    expect(chartToOoxml(spec).issues[0]).toBe("Sankey diagrams are written as bar charts of how much passes through each node: DrawingML has no flows.");
  });

  it("are edited through the flow tools, by index", async () => {
    const controller = new ChartController({ spec: { type: "sankey" } });
    const registry = new ToolRegistry();
    registry.register(createChartToolProvider(controller));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result: any = await registry.callTool(name, args);
      return { error: result.isError ? (result.content[0].text as string) : null, value: result.structuredContent as any };
    };
    const set = await call("set_chart_links", { links: links.slice(0, 2), nodes: ["Events"] });
    expect(set.value.nodes).toEqual([{ name: "Events", value: 60 }, { name: "Website", value: 120 }, { name: "Discovery", value: 180 }]);
    expect((await call("add_chart_link", { source: "Discovery", target: "Won", value: 40 })).value).toEqual({
      index: 2,
      link: { source: "Discovery", target: "Won", value: 40 },
      nodes: [{ name: "Discovery", value: 180 }, { name: "Won", value: 40 }],
    });
    expect((await call("update_chart_link", { index: 2, value: 45 })).value).toEqual({ index: 2, link: { source: "Discovery", target: "Won", value: 45 } });
    expect((await call("remove_chart_link", { index: 0 })).value.links).toHaveLength(2);
    expect((await call("import_chart_links_csv", { csv: "a,b,1\nb,c,2" })).value.links).toEqual([{ source: "a", target: "b", value: 1 }, { source: "b", target: "c", value: 2 }]);

    const before = controller.toJSON();
    expect((await call("add_chart_link", { source: "c", target: "a", value: 1 })).error).toMatch(/would close a loop/);
    expect((await call("add_chart_link", { source: "a", target: "b", value: 0 })).error).toMatch(/\/value: Must be > 0\./);
    expect((await call("update_chart_link", { index: 9, value: 1 })).error).toBe("There is no flow 9; expected 0 to 1.");
    expect((await call("update_chart_link", { index: 0 })).error).toMatch(/^Nothing to change/);
    expect((await call("remove_chart_link", { index: 4 })).error).toBe("There is no flow 4; expected 0 to 1.");
    expect(controller.toJSON()).toEqual(before);
  });
});
