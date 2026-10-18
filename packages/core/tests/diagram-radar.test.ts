// @vitest-environment jsdom
// Ported from Ursula (src/radar/radar.test.ts).
import { describe, expect, it } from "vitest";
import { applyEdit, applyEdits, parseMermaid, serializeMermaid } from "../src/diagram/index.js";
import { expectValidMermaid } from "./helpers/mermaid";

const SRC = `radar-beta
  title Skills
  axis m["Math"], s["Science"]
  axis e["English"]
  curve alice["Alice"]{85, 90, 80}
  curve bob["Bob"]{ e: 70, m: 75, s: 60 }
  max 100
  min 0
`;

describe("radar adapter", () => {
  it("round-trips untouched", async () => {
    const doc = parseMermaid(SRC);
    expect(doc.family).toBe("radar");
    expect(doc.tier).toBe("editable");
    expect(serializeMermaid(doc)).toBe(SRC);
    await expectValidMermaid(SRC);
  });

  it("builds one node per curve with values in axis order", () => {
    const doc = parseMermaid(SRC);
    expect(doc.graph.nodes.map((n) => [n.id, n.label, n.data?.values])).toEqual([
      ["alice", "Alice", [85, 90, 80]],
      ["bob", "Bob", [75, 60, 70]],
    ]);
    expect(doc.graph.title).toBe("Skills");
    expect(doc.graph.data).toMatchObject({
      axes: ["Math", "Science", "English"],
      axisIds: ["m", "s", "e"],
      max: 100,
      min: 0,
      ticks: undefined,
    });
  });

  it("adds, renames, revalues and removes curves", async () => {
    const doc = parseMermaid(SRC);
    const next = applyEdits(doc, [
      { type: "addNode", node: { id: "curve3", label: "Carol" } },
      { type: "renameNode", id: "alice", label: "Alice B." },
      { type: "setNodeData", id: "bob", data: { values: [1, 2, 3] } },
    ]);
    expect(next.source).toContain('  curve alice["Alice B."]{85, 90, 80}\n');
    expect(next.source).toContain('  curve bob["Bob"]{1, 2, 3}\n');
    const carol = next.graph.nodes.at(-1)!;
    expect(carol).toMatchObject({ id: "curve3", label: "Carol" });
    expect((carol.data?.values as number[]).length).toBe(3);
    await expectValidMermaid(next.source);

    const removed = applyEdit(next, { type: "removeNodes", ids: ["bob"] });
    expect(removed.source).not.toContain("Bob");
    await expectValidMermaid(removed.source);
  });

  it("rewrites axes and keeps values with their axis", async () => {
    const doc = parseMermaid(SRC);
    const next = applyEdit(doc, {
      type: "setGraphData",
      data: { axes: ["Math", "Science", "English", "Art"] },
    });
    expect(next.source).toBe(`radar-beta
  title Skills
  axis m["Math"], s["Science"], e["English"], Art
  curve alice["Alice"]{85, 90, 80, 0}
  curve bob["Bob"]{75, 60, 70, 0}
  max 100
  min 0
`);
    await expectValidMermaid(next.source);

    const fewer = applyEdit(next, { type: "setGraphData", data: { axes: ["Math", "Science"] } });
    expect(fewer.graph.nodes[0]!.data?.values).toEqual([85, 90]);
    await expectValidMermaid(fewer.source);
  });

  it("sets and clears options and the title", async () => {
    const doc = parseMermaid(SRC);
    const next = applyEdits(doc, [
      { type: "setGraphData", data: { max: 120, min: "", ticks: 4, graticule: "polygon" } },
      { type: "setGraphData", data: { showLegend: false } },
      { type: "setTitle", title: "Team skills" },
    ]);
    expect(next.source).toContain("  title Team skills\n");
    expect(next.source).toContain("  max 120\n");
    expect(next.source).not.toContain("min 0");
    expect(next.source).toContain("  ticks 4\n  graticule polygon\n  showLegend false\n");
    expect(next.graph.data).toMatchObject({
      max: 120,
      ticks: 4,
      graticule: "polygon",
      showLegend: false,
    });
    await expectValidMermaid(next.source);
  });

  it("builds a chart from a blank one", async () => {
    const blank = parseMermaid("radar-beta\n");
    const next = applyEdits(blank, [
      { type: "setGraphData", data: { axes: ["Speed", "Cost", "3D"] } },
      { type: "addNode", node: { id: "", label: "Plan A", data: { values: [3, 4, 5] } } },
    ]);
    expect(next.source).toBe(`radar-beta
  axis Speed, Cost, axis_3D["3D"]
  curve Plan_A["Plan A"]{3, 4, 5}
`);
    await expectValidMermaid(next.source);
  });
});
