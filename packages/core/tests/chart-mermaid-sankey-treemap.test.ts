// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools";
import { ChartController, chartFromMermaid, chartToMermaid, createChartSpec, createChartToolProvider, findMermaidCharts, type ChartSpec } from "../src/chart";

const sankey: Partial<ChartSpec> = {
  type: "sankey",
  title: "Energy: 2024",
  links: [
    { source: "Solar, rooftop", target: "Grid", value: 12.5 },
    { source: "Wind", target: "Grid", value: 30 },
    { source: "Grid", target: 'Homes "A"', value: 25 },
    { source: "Grid", target: "Industry", value: 17.5 },
  ],
};

const tree: Partial<ChartSpec> = {
  type: "treemap",
  title: "Budget",
  tree: [
    { name: "Engineering", children: [{ name: "Web", value: 420 }, { name: "Apps", value: 310 }] },
    { name: "Sales", children: [{ name: "Field", value: 260 }] },
  ],
};

describe("Mermaid sankey-beta", () => {
  it("is written as CSV records with the title in frontmatter, quoting where needed", () => {
    expect(chartToMermaid(createChartSpec(sankey), { meta: false })).toBe(
      '---\ntitle: "Energy: 2024"\n---\nsankey-beta\n"Solar, rooftop",Grid,12.5\nWind,Grid,30\nGrid,"Homes ""A""",25\nGrid,Industry,17.5\n',
    );
  });

  it("round-trips exactly, and reads back without the metadata comment", () => {
    const spec = createChartSpec({ ...sankey, sankeyLinkColor: "target", sankeyNodes: ["Wind"] });
    const text = chartToMermaid(spec);
    expect(text.split("\n")[4]).toMatch(/^%% @pixerate /);
    expect(chartFromMermaid(text).spec).toEqual(spec);
    const plain = chartFromMermaid(chartToMermaid(spec, { meta: false }));
    expect(plain.issues).toEqual([]);
    expect(plain.family).toBe("sankey");
    expect(plain.spec).toMatchObject({ type: "sankey", title: "Energy: 2024", links: spec.links });
  });

  it("reads Mermaid's own examples, reporting unreadable records by line", () => {
    const read = chartFromMermaid('sankey-beta\n\n%% comment\nAgricultural waste,Bio-conversion,124.729\nBio-conversion,Liquid,0.597\n"Bio, solid",Losses,26.862\n');
    expect(read.issues).toEqual([]);
    expect(read.spec.sankeyNodes).toEqual(["Agricultural waste", "Bio-conversion", "Liquid", "Bio, solid", "Losses"]);
    expect(read.spec.series[0].values[1]).toBeCloseTo(124.729, 6);
    expect(chartFromMermaid("sankey-beta\nA,B,10\nB,C\n").issues).toEqual([{ path: "sankey", line: 3, message: "Line 3: Expected three fields (source,target,value), found 2." }]);
    // A loop in the text is refused with the chart's own sentence.
    expect(chartFromMermaid("sankey-beta\nA,B,1\nB,A,1\n").issues[0].message).toMatch(/would close a loop/);
  });

  it("reads a record that is still arriving when streaming", () => {
    const read = chartFromMermaid("sankey-beta\nA,B,10\nB,C", { partial: true });
    expect(read.issues).toEqual([]);
    expect(read.spec.links).toEqual([{ source: "A", target: "B", value: 10 }]);
    expect(chartFromMermaid("sankey-beta\n", { partial: true }).issues).toEqual([]);
  });
});

describe("Mermaid treemap-beta", () => {
  it("is written as indented quoted names, leaves with values", () => {
    expect(chartToMermaid(createChartSpec(tree), { meta: false })).toBe('treemap-beta\ntitle Budget\n    "Engineering"\n        "Web": 420\n        "Apps": 310\n    "Sales"\n        "Field": 260\n');
    // A flat treemap writes one item per category; names with a double quote use single quotes.
    expect(chartToMermaid(createChartSpec({ type: "treemap", categories: ['Say "hi"', "b"], series: [{ name: "S", values: [1, 2] }] }), { meta: false })).toBe("treemap-beta\n    'Say \"hi\"': 1\n    \"b\": 2\n");
  });

  it("round-trips treemaps and sunbursts exactly", () => {
    for (const input of [tree, { ...tree, type: "sunburst" as const, sunburstLabel: "USD k" }, { type: "treemap" as const, categories: ["a", "b"], series: [{ name: "S", values: [1, 2] }] }]) {
      const spec = createChartSpec(input);
      expect(chartFromMermaid(chartToMermaid(spec)).spec).toEqual(spec);
    }
  });

  it("follows Ursula's rules: one section round everything is the whole, deeper nesting is a sunburst", () => {
    const one = chartFromMermaid('treemap-beta\n"Company"\n    "Sales"\n        "Field": 10\n    "Eng"\n        "Web": 20\n');
    expect(one.spec).toMatchObject({ type: "treemap", title: "Company", categories: ["Sales", "Eng"] });
    expect(one.spec.series[0].values).toEqual([10, 20]);
    const deep = chartFromMermaid('treemap-beta\n"A"\n    "B"\n        "C": 1\n"D": 2\n');
    expect(deep.spec.type).toBe("sunburst");
    expect(deep.spec.tree).toEqual([{ name: "A", children: [{ name: "B", children: [{ name: "C", value: 1 }] }] }, { name: "D", value: 2 }]);
    expect(chartFromMermaid('treemap-beta\ntitle Spend\n"x": 1,200\n').spec).toMatchObject({ title: "Spend", tree: [{ name: "x", value: 1200 }] });
  });

  it("reports unreadable lines with their numbers", () => {
    expect(chartFromMermaid("treemap-beta\nSales: 3\n").issues).toEqual([{ path: "treemap", line: 2, message: 'Line 2: Names must be in quotes, e.g. `"Sales": 120`.' }]);
  });
});

describe("finding and importing them", () => {
  it("finds sankey and treemap blocks in Markdown, frontmatter included", () => {
    const md = '```mermaid\n---\ntitle: Flows\n---\nsankey-beta\nA,B,1\n```\n\n```mermaid\ntreemap-beta\n"x": 1\n```\n';
    expect(findMermaidCharts(md).map((f) => [f.family, f.line])).toEqual([["sankey", 2], ["treemap", 10]]);
  });

  it("is accepted by Mermaid's own parser", async () => {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({ startOnLoad: false });
    const sk = await mermaid.mermaidAPI.getDiagramFromText(chartToMermaid(createChartSpec(sankey)));
    expect(sk.type).toBe("sankey");
    const tm = await mermaid.mermaidAPI.getDiagramFromText(chartToMermaid(createChartSpec(tree)));
    expect(tm.type).toBe("treemap");
  });

  it("imports through import_chart_mermaid and exports through export_chart_mermaid", async () => {
    const controller = new ChartController({});
    const registry = new ToolRegistry();
    registry.register(createChartToolProvider(controller));
    const imported: any = await registry.callTool("import_chart_mermaid", { mermaid: "sankey-beta\nA,B,3\nB,C,2\n" });
    expect(imported.isError).toBeFalsy();
    expect(controller.getSpec()).toMatchObject({ type: "sankey", sankeyNodes: ["A", "B", "C"] });
    const exported: any = await registry.callTool("export_chart_mermaid", { meta: false });
    expect(exported.structuredContent.mermaid).toBe("sankey-beta\nA,B,3\nB,C,2\n");
  });
});
