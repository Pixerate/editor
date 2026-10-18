// @vitest-environment jsdom
// Ported from Ursula (src/xychart/xychart.test.ts).
import { describe, expect, it } from "vitest";
import { applyEdit, applyEdits, parseMermaid, serializeMermaid } from "../src/diagram/index.js";
import { expectValidMermaid } from "./helpers/mermaid";

const SRC = `xychart-beta
    title "Sales revenue"
    x-axis [jan, feb, mar, "Q2 avg"]
    y-axis "Revenue (in $)" 4000 --> 11000
    bar [5000, 6000, 7500, 8200]
    line "Target" [5500, 6500, 7000, 9000.5]
`;

describe("xychart adapter", () => {
  it("round-trips untouched, including unknown lines", () => {
    const src = `---\nconfig:\n  xyChart:\n    width: 900\n---\n${SRC}    accTitle: Revenue\n`;
    const doc = parseMermaid(src);
    expect(doc.family).toBe("xychart");
    expect(doc.tier).toBe("editable");
    expect(serializeMermaid(doc)).toBe(src);
  });

  it("builds one node per series and the axes as diagram data", () => {
    const doc = parseMermaid(SRC);
    expect(doc.graph.nodes.map((n) => [n.id, n.label, n.shape, n.data?.values])).toEqual([
      ["bar1", "Bar 1", "bar", [5000, 6000, 7500, 8200]],
      ["line1", "Target", "line", [5500, 6500, 7000, 9000.5]],
    ]);
    expect(doc.graph.nodes[0]!.data?.titled).toBe(false);
    expect(doc.graph.title).toBe("Sales revenue");
    expect(doc.graph.data).toMatchObject({
      categories: ["jan", "feb", "mar", "Q2 avg"],
      yTitle: "Revenue (in $)",
      yMin: 4000,
      yMax: 11000,
      horizontal: false,
    });
    expect(doc.graph.edges).toEqual([]);
  });

  it("reads numeric x-axes, bare titles and the horizontal header", () => {
    const doc = parseMermaid(
      "xychart horizontal\n  x-axis Year 2000 --> 2004\n  y-axis Units\n  line [1, 2, 3]\n",
    );
    expect(doc.graph.data).toMatchObject({
      categories: [],
      xTitle: "Year",
      xMin: 2000,
      xMax: 2004,
      yTitle: "Units",
      horizontal: true,
    });
  });

  it("adds, renames, retypes, revalues and removes series", async () => {
    const doc = parseMermaid(SRC);
    const added = applyEdit(doc, {
      type: "addNode",
      node: { id: "x", label: "Forecast", shape: "line" },
    });
    expect(added.graph.nodes.at(-1)).toMatchObject({ id: "line2", label: "Forecast" });
    expect((added.graph.nodes.at(-1)!.data?.values as number[]).length).toBe(4);

    const next = applyEdits(added, [
      { type: "renameNode", id: "bar1", label: "Actual" },
      { type: "setNodeShape", id: "line2", shape: "bar" },
      { type: "setNodeData", id: "line1", data: { values: [1, 2, 3, 4] } },
    ]);
    expect(next.source).toContain('    bar "Actual" [5000, 6000, 7500, 8200]\n');
    expect(next.source).toContain('    line "Target" [1, 2, 3, 4]\n');
    expect(next.graph.nodes.map((n) => n.id)).toEqual(["bar1", "line1", "bar2"]);

    const removed = applyEdit(next, { type: "removeNodes", ids: ["line1"] });
    expect(removed.source).not.toContain("Target");
    await expectValidMermaid(removed.source);
  });

  it("rejects non-numeric values", () => {
    const doc = parseMermaid(SRC);
    const same = applyEdit(doc, { type: "setNodeData", id: "bar1", data: { values: ["x"] } });
    expect(same.source).toBe(SRC);
  });

  it("edits the title, axes and orientation", async () => {
    const doc = parseMermaid(SRC);
    const next = applyEdits(doc, [
      { type: "setTitle", title: "Revenue by month" },
      { type: "setGraphData", data: { categories: ["Jan", "Feb", "Mar 2026", "Apr"] } },
      { type: "setGraphData", data: { xTitle: "Month", yTitle: "" } },
      { type: "setGraphData", data: { yMin: 0 } },
      { type: "setGraphData", data: { horizontal: true } },
    ]);
    expect(next.source).toBe(`xychart-beta horizontal
    title "Revenue by month"
    x-axis "Month" [Jan, Feb, "Mar 2026", Apr]
    y-axis 0 --> 11000
    bar [5000, 6000, 7500, 8200]
    line "Target" [5500, 6500, 7000, 9000.5]
`);
    await expectValidMermaid(next.source);

    const cleared = applyEdit(next, { type: "setGraphData", data: { yMin: "", yMax: "" } });
    expect(cleared.source).not.toContain("y-axis");
    await expectValidMermaid(cleared.source);
  });

  it("builds a chart from a blank one", async () => {
    const blank = parseMermaid("xychart-beta\n");
    const next = applyEdits(blank, [
      { type: "setTitle", title: "Visits" },
      { type: "setGraphData", data: { categories: ["Mon", "Tue"] } },
      { type: "addNode", node: { id: "a", label: "", shape: "bar", data: { values: [3, 5] } } },
    ]);
    expect(next.source).toBe(`xychart-beta
    title "Visits"
    x-axis [Mon, Tue]
    bar [3, 5]
`);
    await expectValidMermaid(next.source);
  });
});
