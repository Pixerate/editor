// @vitest-environment jsdom
// Ported from Ursula (src/timeline/timeline.test.ts).
import { describe, expect, it } from "vitest";
import { applyEdit, applyEdits, parseMermaid, serializeMermaid } from "../src/diagram/index.js";
import { registerDiagramAdapter } from "../src/diagram/registry.js";
import type { DiagramAdapter } from "../src/diagram/types.js";
import { autoLayoutDiagram } from "../src/canvas/mermaid/layout.js";
import { expectValidMermaid, mermaidDb } from "./helpers/mermaid";
import { timelineAdapter } from "../src/diagram/timeline/index.js";
import { timelineGeometry } from "../src/diagram/timeline/geometry.js";

registerDiagramAdapter(timelineAdapter as DiagramAdapter<unknown>);

const SRC = `timeline
  title Platform milestones
  2024 : Unified portal launched
       : Design system v1
  2025 : AI chat assistant
       : Generative forms
  2026 : Design system v9
       : Generative diagrams
`;

interface TimelineDb {
  getTasks: () => { task: string; section: string; events: string[] }[];
  getSections: () => string[];
}

describe("timeline adapter", () => {
  it("round-trips untouched", () => {
    const doc = parseMermaid(SRC);
    expect(doc.family).toBe("timeline");
    expect(doc.tier).toBe("editable");
    expect(serializeMermaid(doc)).toBe(SRC);
    const odd = "timeline\n    2024 :  a :b: c\n   %% c\n       :  d\n  section  S \n";
    expect(serializeMermaid(parseMermaid(odd))).toBe(odd);
  });

  it("joins continuation lines into one period per statement", async () => {
    const doc = parseMermaid(SRC);
    expect(doc.graph.title).toBe("Platform milestones");
    expect(doc.graph.nodes.map((n) => [n.id, n.label, n.shape, n.data?.events])).toEqual([
      ["2024", "2024", "rounded", ["Unified portal launched", "Design system v1"]],
      ["2025", "2025", "rounded", ["AI chat assistant", "Generative forms"]],
      ["2026", "2026", "rounded", ["Design system v9", "Generative diagrams"]],
    ]);
    expect(doc.graph.nodes[0]!.data?.details).toEqual([
      "Unified portal launched",
      "Design system v1",
    ]);
    expect(doc.graph.edges.map((e) => [e.id, e.data?.synthetic])).toEqual([
      ["L_2024_2025_0", true],
      ["L_2025_2026_0", true],
    ]);
    const db = await mermaidDb<TimelineDb>(SRC);
    expect(db.getTasks().map((t) => [t.task.trim(), t.events])).toEqual(
      doc.graph.nodes.map((n) => [n.label, n.data?.events]),
    );
  });

  it("formats edited periods with aligned continuation lines", async () => {
    const doc = parseMermaid(SRC);
    const edited = applyEdit(doc, {
      type: "setNodeData",
      id: "2025",
      data: { events: ["AI chat assistant", "Forms: generated", "Search"] },
    });
    expect(edited.source).toContain(
      "  2025 : AI chat assistant\n       : Forms - generated\n       : Search\n  2026 : Design system v9\n",
    );
    const renamed = applyEdit(edited, { type: "renameNode", id: "2025", label: "Q1 2025" });
    expect(renamed.source).toContain(
      "  Q1 2025 : AI chat assistant\n          : Forms - generated\n          : Search\n",
    );
    expect(renamed.graph.nodes[1]!.id).toBe("Q1_2025");
    await expectValidMermaid(renamed.source);
    const db = await mermaidDb<TimelineDb>(renamed.source);
    expect(db.getTasks()[1]!.events).toEqual(["AI chat assistant", "Forms - generated", "Search"]);

    const empty = applyEdit(doc, { type: "setNodeData", id: "2026", data: { events: [] } });
    expect(empty.source.endsWith("       : Generative forms\n  2026\n")).toBe(true);
    await expectValidMermaid(empty.source);
  });

  it("adds and removes periods", async () => {
    const doc = parseMermaid(SRC);
    const added = applyEdit(doc, {
      type: "addNode",
      node: { id: "period4", label: "2027", data: { events: ["Next", "Later"] } },
      position: [1, 2],
    });
    expect(added.source.endsWith("  2027 : Next\n       : Later\n")).toBe(true);
    expect(added.meta.layout?.["2027"]).toEqual([1, 2]);
    const removed = applyEdit(added, { type: "removeNodes", ids: ["2025"] });
    expect(removed.source).not.toContain("2025");
    expect(removed.source).not.toContain("Generative forms");
    expect(removed.graph.edges.map((e) => e.id)).toEqual(["L_2024_2026_0", "L_2026_2027_0"]);
    await expectValidMermaid(removed.source);
  });

  it("supports sections", async () => {
    const doc = parseMermaid(SRC);
    const grouped = applyEdit(doc, {
      type: "groupNodes",
      groupId: "g",
      label: "Later",
      nodeIds: ["2025", "2026"],
    });
    expect(grouped.source).toBe(
      // Moved periods are indented under the new section, continuation lines included.
      "timeline\n  title Platform milestones\n  2024 : Unified portal launched\n       : Design system v1\n  section Later\n    2025 : AI chat assistant\n         : Generative forms\n    2026 : Design system v9\n         : Generative diagrams\n",
    );
    expect(grouped.graph.groups).toEqual([
      { id: "Later", label: "Later", classes: [], styles: [] },
    ]);
    const db = await mermaidDb<TimelineDb>(grouped.source);
    expect(db.getSections()).toEqual(["Later"]);
    expect(db.getTasks().map((t) => t.section)).toEqual(["", "Later", "Later"]);

    const moved = applyEdit(grouped, { type: "setNodeParent", ids: ["2024"], parentId: "Later" });
    expect(moved.graph.nodes.map((n) => [n.id, n.parentId])).toEqual([
      ["2025", "Later"],
      ["2026", "Later"],
      ["2024", "Later"],
    ]);
    expect(
      moved.source.endsWith(
        "         : Generative diagrams\n    2024 : Unified portal launched\n         : Design system v1\n",
      ),
    ).toBe(true);
    const renamed = applyEdit(grouped, { type: "renameGroup", id: "Later", label: "Recent" });
    expect(renamed.source).toContain("  section Recent\n");
    const ungrouped = applyEdit(grouped, { type: "ungroup", groupId: "Later" });
    expect(ungrouped.source).not.toContain("section");
    expect(ungrouped.graph.nodes.every((n) => n.parentId === undefined)).toBe(true);
    for (const d of [moved, renamed, ungrouped]) await expectValidMermaid(d.source);
  });

  it("edits the title and refuses edge edits", () => {
    const doc = parseMermaid(SRC);
    const titled = applyEdit(doc, { type: "setTitle", title: "Milestones" });
    expect(titled.source.startsWith("timeline\n  title Milestones\n  2024")).toBe(true);
    expect(applyEdit(doc, { type: "removeEdges", ids: ["L_2024_2025_0"] })).toBe(doc);
    expect(
      applyEdit(doc, {
        type: "reconnectEdge",
        id: "L_2024_2025_0",
        source: "2024",
        target: "2026",
      }),
    ).toBe(doc);
  });

  it("keeps unknown lines verbatim", async () => {
    const src =
      "timeline\n  accTitle: Accessible\n  %% comment: here\n  2024 : A\n  # hash: comment\n";
    const doc = parseMermaid(src);
    expect(doc.graph.nodes.map((n) => n.id)).toEqual(["2024"]);
    const next = applyEdits(doc, [{ type: "setNodeData", id: "2024", data: { events: ["B"] } }]);
    expect(next.source).toBe(
      "timeline\n  accTitle: Accessible\n  %% comment: here\n  2024 : B\n  # hash: comment\n",
    );
    await expectValidMermaid(next.source);
  });

  it("lays periods out in one row as Mermaid does", async () => {
    const doc = applyEdit(parseMermaid(SRC), {
      type: "groupNodes",
      groupId: "g",
      label: "Later",
      nodeIds: ["2026"],
    });
    const { positions, sizes } = await autoLayoutDiagram(doc.graph, { family: "timeline" });
    const geo = timelineGeometry(doc.graph);
    const top = geo.sections.get("Later")!.height + 50;
    // A column every 200px; boxes are 190 wide; periods 50px below the headers.
    expect(positions["2024"]).toEqual([0, top]);
    expect(positions["2025"]).toEqual([200, top]);
    expect(positions.Later).toEqual([400, 0]);
    expect(positions["2026"]).toEqual([400, top]);
    expect(sizes["2024"]!.width).toBe(190);
    expect(sizes.Later!.width).toBe(190);
    expect(sizes["2024"]!.height).toBeCloseTo(67.2);
  });

  it("derives events, lines, the axis and colours from the data", () => {
    const flat = timelineGeometry(parseMermaid(SRC).graph);
    expect(flat.hasSections).toBe(false);
    // Without sections every period gets the next colour of the scale.
    expect([...flat.periods.values()].map((p) => [p.x, p.y, p.colour])).toEqual([
      [0, 0, 0],
      [200, 0, 1],
      [400, 0, 2],
    ]);
    const events = flat.events.filter((e) => e.periodId === "2025");
    expect(events.map((e) => [e.text, e.x, e.y, e.height])).toEqual([
      ["AI chat assistant", 200, 200, 50],
      ["Generative forms", 200, 260, 50],
    ]);
    expect(flat.eventLines[1]).toMatchObject({ periodId: "2025", x: 295 });
    expect(flat.axis.y).toBeCloseTo(flat.periods.get("2024")!.height + 50);
    expect(flat.axis.x1).toBe(-50);
    expect(flat.axis.x2).toBe(590 + 250);
    expect(flat.addEvent.get("2025")!.y).toBeGreaterThan(260 + 50);

    // With sections: one colour per section, an empty section keeps a column.
    const withEmpty = parseMermaid(
      "timeline\n  section Early\n    2024 : A\n    2025 : B\n  section Late\n  section Last\n    2026 : C\n",
    );
    const geo = timelineGeometry(withEmpty.graph);
    expect([...geo.sections.values()].map((s) => [s.id, s.x, s.width, s.colour, s.empty])).toEqual([
      ["Early", 0, 390, 0, false],
      ["Late", 400, 190, 1, true],
      ["Last", 600, 190, 2, false],
    ]);
    expect([...geo.periods.values()].map((p) => [p.x, p.colour])).toEqual([
      [0, 0],
      [200, 0],
      [600, 2],
    ]);
  });

  it("reorders a period dragged sideways, across sections", async () => {
    const doc = applyEdit(parseMermaid(SRC), {
      type: "groupNodes",
      groupId: "g",
      label: "Later",
      nodeIds: ["2026"],
    });
    // Drop 2024 into the "Later" column, right of 2026.
    const moved = applyEdit(doc, {
      type: "moveNodes",
      moves: [{ id: "2024", position: [480, 90] }],
    });
    expect(moved.source).toBe(
      "timeline\n  title Platform milestones\n  2025 : AI chat assistant\n       : Generative forms\n  section Later\n    2026 : Design system v9\n         : Generative diagrams\n    2024 : Unified portal launched\n         : Design system v1\n",
    );
    expect(moved.meta.layout?.["2024"]).toBeUndefined();
    await expectValidMermaid(moved.source);
    const db = await mermaidDb<TimelineDb>(moved.source);
    expect(db.getTasks().map((t) => [t.task.trim(), t.section])).toEqual([
      ["2025", ""],
      ["2026", "Later"],
      ["2024", "Later"],
    ]);
    // Swap within the loose periods.
    const swapped = applyEdit(doc, {
      type: "moveNodes",
      moves: [{ id: "2025", position: [-150, 0] }],
    });
    expect(swapped.graph.nodes.map((n) => n.id)).toEqual(["2025", "2024", "2026"]);
    // Dropped in place: unchanged text.
    const same = applyEdit(doc, {
      type: "moveNodes",
      moves: [{ id: "2025", position: [210, 300] }],
    });
    expect(same.source).toBe(doc.source);
  });
});
