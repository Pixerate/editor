// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools";
import {
  ChartController,
  addChartTreeRow,
  chartFromMermaid,
  chartFromOoxml,
  chartToMermaid,
  chartToOoxml,
  chartTreeColumnLabels,
  chartTreeFromRows,
  chartTreeFromSeries,
  chartTreeFromTable,
  chartTreeToRows,
  createChartSpec,
  createChartToolProvider,
  describeChart,
  layoutChart,
  normalizeChartSpec,
  normalizeChartTree,
  removeChartTreeRow,
  setChartTreeRowName,
  setChartTreeRowValue,
  type ChartIssue,
  type ChartMark,
  type ChartScene,
  type ChartSpec,
  type ChartTreeNode,
} from "../src/chart";

const tree: ChartTreeNode[] = [
  { name: "Europe", children: [{ name: "France", value: 40 }, { name: "Spain", value: 25 }, { name: "Germany", children: [{ name: "Berlin", value: 18 }, { name: "Munich", value: 12 }] }] },
  { name: "Americas", children: [{ name: "Canada", value: 30 }, { name: "USA", value: 55 }] },
  { name: "Asia", value: 20 },
];

const SIZE = { width: 640, height: 400 };
const scene = (spec: Partial<ChartSpec>) => layoutChart(createChartSpec(spec), SIZE);
const role = (s: ChartScene, r: ChartMark["role"]) => s.marks.filter((m) => m.role === r);
const byKey = (s: ChartScene, key: string) => s.marks.find((m) => m.key === key);

describe("the tree", () => {
  it("is checked node by node, keeping what is usable", () => {
    const issues: ChartIssue[] = [];
    const out = normalizeChartTree(
      [
        { name: "A", children: [{ name: "x", value: 1 }, { name: "x", value: 2 }, { name: "y", value: -3 }] },
        { name: "", value: 1 },
        { name: "B", value: 5, children: [{ name: "z", value: "1,200" }] },
        { name: "C", size: 3 },
      ],
      issues,
    );
    expect(out).toEqual([
      { name: "A", children: [{ name: "x", value: 1 }, { name: "y", value: 0 }] },
      { name: "B", children: [{ name: "z", value: 1200 }] },
      { name: "C", value: 0 },
    ]);
    expect(issues.map((i) => i.message)).toEqual([
      '"x" appears twice under the same group in tree[0].children; sibling names must be unique, so the second was left out.',
      '"y" needs a value of 0 or more; got -3.',
      "tree[1] needs a name.",
      '"B" is a group: its value is the sum of its children, so the value given was ignored.',
      'tree[3] has no "size"; a node takes name, value, children and color.',
    ]);
    const deep = normalizeChartTree([{ name: "1", children: [{ name: "2", children: [{ name: "3", children: [{ name: "4", children: [{ name: "5", children: [{ name: "6", children: [{ name: "7", value: 1 }] }] }] }] }] }] }], issues);
    expect(chartTreeToRows(deep)).toEqual([{ path: ["1", "2", "3", "4", "5", "6"], value: 0 }]);
    expect(issues[issues.length - 1].message).toMatch(/more than 6 levels deep/);
  });

  it("is the chart's data: top-level names are the categories, the first series their totals", () => {
    const spec = createChartSpec({ type: "bar", tree, categories: ["stale"], series: [{ id: "s", name: "Customers", values: [1], color: "#123456" }] });
    expect(spec.categories).toEqual(["Europe", "Americas", "Asia"]);
    expect(spec.series[0]).toEqual({ id: "s", name: "Customers", color: "#123456", values: [95, 85, 20] });
    expect(createChartSpec({ tree }).series[0]).toMatchObject({ name: "Values", values: [95, 85, 20] });
    expect(normalizeChartSpec({ tree: "no" }).issues[0].message).toMatch(/tree must be an array of nodes/);
  });

  it("converts to and from rows of names and a value", () => {
    const rows = chartTreeToRows(tree);
    expect(rows[3]).toEqual({ path: ["Europe", "Germany", "Munich"], value: 12 });
    expect(rows[rows.length - 1]).toEqual({ path: ["Asia"], value: 20 });
    expect(chartTreeFromRows(rows)).toEqual(tree);
    const issues: ChartIssue[] = [];
    chartTreeFromRows([{ path: ["A", "b"], value: 1 }, { path: ["A"], value: 2 }, { path: ["C"], value: 1 }, { path: ["C", "d"], value: 1 }, { path: ["E"], value: "lots" }], issues);
    expect(issues.map((i) => i.message)).toEqual([
      "Row 2 (A) names a group that already has items; it was left out.",
      'Row 4 puts items under "C", which an earlier row made an item with its own value; it was left out.',
      'Row 5 (E) needs a value of 0 or more; got "lots". It was counted as 0.',
    ]);
  });

  it("reads spreadsheet tables where group names are written once", () => {
    const read = chartTreeFromTable([
      ["Region", "Country", "Customers"],
      ["Europe", "France", 40],
      ["", "Spain", 25],
      ["Americas", "Canada", 30],
      ["", "USA", "55"],
      ["Asia", "", 20],
    ]);
    expect(read).toEqual([
      { name: "Europe", children: [{ name: "France", value: 40 }, { name: "Spain", value: 25 }] },
      { name: "Americas", children: [{ name: "Canada", value: 30 }, { name: "USA", value: 55 }] },
      { name: "Asia", value: 20 },
    ]);
    const issues: ChartIssue[] = [];
    expect(chartTreeFromTable([["only"]], {}, issues)).toEqual([]);
    expect(issues[0].message).toBe("A tree table needs at least two columns: names, then values.");
    expect(chartTreeFromSeries(["a", "b", "a"], [1, null, 3])).toEqual([{ name: "a", value: 1 }, { name: "b", value: 0 }]);
  });

  it("has helpers for editing it as a table", () => {
    const rows = chartTreeToRows(tree);
    expect(chartTreeColumnLabels(3)).toEqual(["Group", "Level 2", "Item"]);
    expect(chartTreeColumnLabels(1)).toEqual(["Item"]);
    expect(chartTreeFromRows(setChartTreeRowName(rows, 0, 0, "EU"))[0]).toMatchObject({ name: "EU", children: [{ name: "France", value: 40 }] });
    expect(setChartTreeRowName(rows, 6, 1, "Tokyo")[6].path).toEqual(["Asia", "Tokyo"]);
    expect(setChartTreeRowValue(rows, 1, "30")[1].value).toBe("30");
    expect(addChartTreeRow(rows).at(-1)).toEqual({ path: [`Item ${rows.length + 1}`], value: 0 });
    expect(removeChartTreeRow(rows, 0)).toHaveLength(rows.length - 1);
  });
});

describe("drawing grouped data", () => {
  it("nests each group's rectangles inside it, under a header", () => {
    const s = scene({ type: "treemap", tree });
    const europe = byKey(s, "group-n-0");
    if (europe?.kind !== "rect") throw new Error("expected the Europe group");
    const inside = role(s, "cell").filter((m) => m.key.startsWith("cell-n-0-") && m.kind === "rect") as Extract<ChartMark, { kind: "rect" }>[];
    expect(inside.map((m) => m.key).sort()).toEqual(["cell-n-0-0", "cell-n-0-1", "cell-n-0-2-0", "cell-n-0-2-1"]);
    for (const c of inside) {
      expect(c.x).toBeGreaterThanOrEqual(europe.x - 0.01);
      expect(c.x + c.width).toBeLessThanOrEqual(europe.x + europe.width + 0.01);
      expect(c.target).toEqual({ kind: "category", index: 0 });
    }
    expect(byKey(s, "label-group-n-0")).toMatchObject({ text: "Europe" });
    expect(byKey(s, "cell-n-2")).toMatchObject({ target: { kind: "category", index: 2 } });
    // Leaves are shades of their group's colour, and highlight works per group.
    expect(new Set(inside.map((c) => c.fill)).size).toBeGreaterThan(1);
    const muted = scene({ type: "treemap", tree, highlight: ["Asia"] });
    expect(byKey(muted, "cell-n-0-0")!.opacity).toBe(0.25);
    expect(byKey(muted, "cell-n-2")!.opacity).toBeUndefined();
  });

  it("draws a sunburst ring per level, children inside their parent's arc", () => {
    const s = scene({ type: "sunburst", tree, sunburstLabel: "customers" });
    const slices = role(s, "slice");
    expect(slices.map((m) => m.key)).toEqual(["slice-n-0", "slice-n-0-0", "slice-n-0-1", "slice-n-0-2", "slice-n-0-2-0", "slice-n-0-2-1", "slice-n-1", "slice-n-1-0", "slice-n-1-1", "slice-n-2"]);
    expect(byKey(s, "sunburst-total")).toMatchObject({ text: "200" });
    expect(byKey(s, "sunburst-caption")).toMatchObject({ text: "customers" });
    expect(byKey(s, "slice-n-1-1")?.target).toEqual({ kind: "category", index: 1 });
    expect(byKey(s, "label-slice-n-0")).toMatchObject({ text: "Europe" });
    expect(role(s, "legend-label").map((m) => (m.kind === "text" ? m.text : ""))).toEqual(["Europe", "Americas", "Asia"]);
  });

  it("draws a sunburst of the first series without a tree, and says when there is nothing to draw", () => {
    const flat = scene({ type: "sunburst", categories: ["a", "b"], series: [{ name: "S", values: [1, 3] }] });
    expect(role(flat, "slice")).toHaveLength(2);
    expect(byKey(flat, "slice-n-1")?.target).toEqual({ kind: "category", index: 1 });
    expect(byKey(scene({ type: "sunburst", tree: [{ name: "a", value: 0 }] }), "empty")).toMatchObject({ text: "No positive values" });
  });

  it("is described with its levels", () => {
    expect(describeChart(createChartSpec({ type: "sunburst", tree }))).toBe(
      "A sunburst chart of Values across 3 categories, totalling 200. The largest is Europe at 95 (48%); the smallest is Asia at 20 (10%). The data is grouped 3 levels deep with 7 items.",
    );
  });
});

describe("ChartController grouped data", () => {
  it("replaces, edits and clears the tree as single undo steps", () => {
    const c = new ChartController({ spec: { type: "treemap", tree } });
    expect(c.addTreeNode(["Asia"], { name: "Japan", value: 5 })).toMatchObject({ ok: false, message: expect.stringMatching(/"Asia" is an item with its own value, not a group/) });
    expect(c.addTreeNode(["Americas"], { name: "Brazil", value: 14 }, { at: 0 })).toEqual({ ok: true, path: ["Americas", "Brazil"] });
    expect(c.getSpec().series[0].values).toEqual([95, 99, 20]);
    expect(c.getState().undoLabel).toBe('Add "Brazil"');
    expect(c.updateTreeNode(["Europe", "Spain"], { name: "España", value: 30, color: "#f00" })).toEqual({ ok: true, path: ["Europe", "España"] });
    expect(c.updateTreeNode(["Europe"], { value: 1 })).toMatchObject({ ok: false, message: '"Europe" is a group: its value is the sum of its items. Change the items instead.' });
    expect(c.updateTreeNode(["Europe", "France"], { name: "Germany" })).toMatchObject({ ok: false, message: expect.stringMatching(/already a "Germany"/) });
    expect(c.updateTreeNode(["Mars"], { value: 1 })).toMatchObject({ ok: false, message: 'There is no node ["Mars"]. The top level has "Europe", "Americas", "Asia".' });
    expect(c.removeTreeNode(["Europe", "Germany", "Berlin"])).toEqual({ ok: true });
    expect(c.removeTreeNode(["Europe", "Germany", "Munich"])).toEqual({ ok: true });
    // An emptied group becomes an item with value 0.
    expect(c.getSpec().tree[0].children![2]).toEqual({ name: "Germany", value: 0 });
    c.undo();
    expect(c.getSpec().tree[0].children![2].children).toEqual([{ name: "Munich", value: 12 }]);
    expect(c.setTree([])).toEqual({ ok: true });
    expect(c.getSpec()).toMatchObject({ tree: [], categories: ["Europe", "Americas", "Asia"] });
  });

  it("keeps node colours when the table view edits the rows", () => {
    const c = new ChartController({ spec: { type: "treemap", tree: [{ name: "A", color: "#abc", children: [{ name: "x", value: 1, color: "#def" }] }] } });
    expect(c.setTreeRows([{ path: ["A", "x"], value: 5 }, { path: ["A", "y"], value: 2 }])).toEqual({ ok: true });
    expect(c.getSpec().tree).toEqual([{ name: "A", color: "#abc", children: [{ name: "x", value: 5, color: "#def" }, { name: "y", value: 2 }] }]);
    expect(c.setTreeRows([{ path: ["A"], value: "x" }])).toMatchObject({ ok: false, message: 'Row 1 (A) needs a value of 0 or more; got "x". It was counted as 0.' });
  });

  it("refuses cell edits while the data is grouped, and lets new data replace it", () => {
    const c = new ChartController({ spec: { type: "treemap", tree } });
    const sid = c.getSpec().series[0].id;
    const refusal = /This chart's data is grouped \(a tree\)/;
    expect(c.setValue(sid, 0, 3)).toMatchObject({ ok: false, message: expect.stringMatching(refusal) });
    expect(c.addCategory("New")).toMatchObject({ ok: false, message: expect.stringMatching(refusal) });
    expect(c.renameCategory(0, "EU")).toMatchObject({ ok: false });
    expect(c.transpose()).toMatchObject({ ok: false });
    expect(c.pasteCells(0, 0, "1\t2")).toMatchObject({ ok: false });
    expect(c.getSpec().tree).toHaveLength(3);
    expect(c.importCsv("Item,Sales\na,1\nb,2")).toEqual({ ok: true });
    expect(c.getSpec()).toMatchObject({ tree: [], categories: ["a", "b"] });
    const d = new ChartController({ spec: { tree } });
    expect(d.setData({ categories: ["x"] })).toEqual({ ok: true });
    expect(d.getSpec().tree).toEqual([]);
  });

  it("imports grouped tables", () => {
    const c = new ChartController({ spec: { type: "sunburst" } });
    expect(c.importTreeTable([["Region", "Country", "N"], ["Europe", "France", 1], ["", "Spain", 2]])).toEqual({ ok: true });
    expect(c.getSpec().categories).toEqual(["Europe"]);
    expect(c.importTreeTable([["a", "b"]], { header: true })).toMatchObject({ ok: false, message: expect.stringMatching(/no grouped data to import/) });
  });
});

describe("grouped data in files and agent tools", () => {
  it("round-trips through Mermaid and is written to Office as group totals", () => {
    const spec = createChartSpec({ type: "sunburst", tree, sunburstLabel: "customers" });
    expect(chartFromMermaid(chartToMermaid(spec)).spec).toEqual(spec);
    expect(chartToMermaid(spec, { meta: false })).toContain('treemap-beta\n    "Europe"\n        "France": 40\n');
    const out = chartToOoxml(spec);
    expect(out.issues[0]).toBe("Sunburst charts are written as doughnut charts of the top-level group totals: DrawingML has no sunburst type (Office 2016 stores it as chartex).");
    expect(out.xml).toContain("<c:doughnutChart>");
  });

  it("reads the levels of an Office sunburst (chartex) into the tree", () => {
    const xml = `<cx:chartSpace xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chartData><cx:data id="0">
      <cx:strDim type="cat">
        <cx:lvl ptCount="4"><cx:pt idx="0">France</cx:pt><cx:pt idx="1">Spain</cx:pt><cx:pt idx="2">Canada</cx:pt><cx:pt idx="3">Asia</cx:pt></cx:lvl>
        <cx:lvl ptCount="4"><cx:pt idx="0">Europe</cx:pt><cx:pt idx="2">Americas</cx:pt></cx:lvl>
      </cx:strDim>
      <cx:numDim type="size"><cx:lvl ptCount="4" formatCode="General"><cx:pt idx="0">40</cx:pt><cx:pt idx="1">25</cx:pt><cx:pt idx="2">30</cx:pt><cx:pt idx="3">20</cx:pt></cx:lvl></cx:numDim>
    </cx:data></cx:chartData><cx:chart><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="sunburst"><cx:tx><cx:txData><cx:v>Customers</cx:v></cx:txData></cx:tx><cx:dataId val="0"/></cx:series></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>`;
    const read = chartFromOoxml(xml, { DOMParser });
    expect(read.unsupported).toEqual([]);
    expect(read.spec.type).toBe("sunburst");
    // Asia's group cell is blank: it carries on from Americas, as a spreadsheet's merged group column does.
    expect(read.spec.tree).toEqual([
      { name: "Europe", children: [{ name: "France", value: 40 }, { name: "Spain", value: 25 }] },
      { name: "Americas", children: [{ name: "Canada", value: 30 }, { name: "Asia", value: 20 }] },
    ]);
  });

  it("are edited through the tree tools, with paths closing the loop", async () => {
    const controller = new ChartController({ spec: { type: "treemap" } });
    const registry = new ToolRegistry();
    registry.register(createChartToolProvider(controller));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result: any = await registry.callTool(name, args);
      return { error: result.isError ? (result.content[0].text as string) : null, value: result.structuredContent as any };
    };
    const set = await call("set_chart_tree", { tree });
    expect(set.value).toMatchObject({ depth: 3, groups: [{ name: "Europe", total: 95 }, { name: "Americas", total: 85 }, { name: "Asia", total: 20 }] });
    expect((await call("get_chart")).value.treeTable.slice(0, 2)).toEqual([["Group", "Level 2", "Item", "Value"], ["Europe", "France", "", 40]]);
    expect((await call("add_chart_tree_node", { parent: ["Americas"], node: { name: "Brazil", value: 14 } })).value).toEqual({ path: ["Americas", "Brazil"], parentTotal: 99 });
    expect((await call("update_chart_tree_node", { path: ["Americas", "Brazil"], value: 20 })).value).toEqual({ path: ["Americas", "Brazil"], node: { name: "Brazil", value: 20 } });
    expect((await call("remove_chart_tree_node", { path: ["Asia"] })).value.groups.map((g: any) => g.name)).toEqual(["Europe", "Americas"]);
    expect((await call("import_chart_tree_csv", { csv: "Dept,Team,Budget\nEng,Web,10\n,Apps,5" })).value.groups).toEqual([{ name: "Eng", total: 15 }]);

    const before = controller.toJSON();
    expect((await call("set_chart_tree", { tree: [{ name: "a", value: -1 }] })).error).toMatch(/\/tree\/0\/value: Must be >= 0\./);
    expect((await call("set_chart_tree", { tree: [{ value: 1 }] })).error).toMatch(/name/);
    expect((await call("update_chart_tree_node", { path: ["Eng"] })).error).toBe("Nothing to change: pass name, value or color with the path.");
    expect((await call("remove_chart_tree_node", { path: ["Nope"] })).error).toBe('There is no node ["Nope"]. The top level has "Eng".');
    expect((await call("set_chart_values", { cells: [{ series: controller.getSpec().series[0].id, category: 0, value: 1 }] })).error).toMatch(/grouped \(a tree\)/);
    expect(controller.toJSON()).toEqual(before);
  });
});
