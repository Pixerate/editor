// @vitest-environment jsdom
// Ported from Ursula (src/gantt/gantt.test.ts).
import { describe, expect, it } from "vitest";
import { applyEdit, applyEdits, parseMermaid, serializeMermaid } from "../src/diagram/index.js";
import { registerDiagramAdapter } from "../src/diagram/registry.js";
import type { DiagramAdapter } from "../src/diagram/types.js";
import { autoLayoutDiagram, ensureDiagramLayout } from "../src/canvas/mermaid/layout.js";
import { expectValidMermaid, mermaidDb } from "./helpers/mermaid";
import { ganttUI } from "../src/diagram/families/index.js";
import {
  GANTT_METRICS,
  formatGanttDate,
  ganttAdapter,
  ganttGeometry,
  parseGanttDate,
} from "../src/diagram/gantt/index.js";

registerDiagramAdapter(ganttAdapter as DiagramAdapter<unknown>);

const SRC = `gantt
  title Q4 delivery roadmap
  dateFormat YYYY-MM-DD
  axisFormat %b %d
  section Platform
    Design system v9 rollout     :done,    ds, 2026-10-01, 14d
    Diagram editor beta          :active,  de, 2026-10-08, 21d
    Observability upgrade        :         ob, after de, 14d
  section Product
    Onboarding redesign          :         on, 2026-10-15, 28d
    Billing self-serve           :crit,    bi, after on, 21d
  section Go-to-market
    Launch comms                 :milestone, lc, 2026-12-10, 0d
`;

interface GanttDb {
  getTasks: () => {
    id: string;
    task: string;
    section: string;
    startTime: Date;
    endTime: Date;
  }[];
  getSections: () => string[];
}

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

describe("gantt adapter", () => {
  it("round-trips untouched", () => {
    const doc = parseMermaid(SRC);
    expect(doc.family).toBe("gantt");
    expect(doc.tier).toBe("editable");
    expect(serializeMermaid(doc)).toBe(SRC);
  });

  it("builds tasks, sections, dependencies and config", async () => {
    const doc = parseMermaid(SRC);
    const { graph } = doc;
    expect(graph.title).toBe("Q4 delivery roadmap");
    expect(graph.data).toEqual({
      dateFormat: "YYYY-MM-DD",
      axisFormat: "%b %d",
      excludes: undefined,
      tickInterval: undefined,
      todayMarker: undefined,
    });
    expect(graph.groups.map((g) => g.id)).toEqual(["Platform", "Product", "Go_to_market"]);
    expect(graph.nodes.map((n) => [n.id, n.shape, n.parentId])).toEqual([
      ["ds", "task", "Platform"],
      ["de", "task", "Platform"],
      ["ob", "task", "Platform"],
      ["on", "task", "Product"],
      ["bi", "task", "Product"],
      ["lc", "milestone", "Go_to_market"],
    ]);
    expect(graph.nodes[2]!.data).toMatchObject({
      tags: [],
      start: "after de",
      end: "14d",
      explicitId: true,
      details: ["after de", "14d"],
    });
    expect(graph.nodes[0]!.label).toBe("Design system v9 rollout");
    expect(
      graph.edges.map((e) => [e.id, e.source, e.target, e.arrowEnd, e.data?.dependency]),
    ).toEqual([
      ["L_de_ob_0", "de", "ob", "arrow_point", true],
      ["L_on_bi_0", "on", "bi", "arrow_point", true],
    ]);

    // Cross-check ids, sections and the resolved schedule with Mermaid.
    const db = await mermaidDb<GanttDb>(SRC);
    expect(db.getSections()).toEqual(["Platform", "Product", "Go-to-market"]);
    const tasks = db.getTasks();
    expect(tasks.map((t) => [t.id, t.task.trim(), t.section])).toEqual(
      graph.nodes.map((n) => [n.id, n.label, graph.groups.find((g) => g.id === n.parentId)?.label]),
    );
    for (const [i, t] of tasks.entries()) {
      const n = graph.nodes[i]!;
      expect(formatGanttDate(n.data!.startTime as number)).toBe(localDate(t.startTime));
      expect(formatGanttDate(n.data!.endTime as number)).toBe(localDate(t.endTime));
    }
  });

  it("edits task data, tags, shape and ids", async () => {
    const doc = parseMermaid(SRC);
    const next = applyEdits(doc, [
      { type: "setNodeData", id: "de", data: { start: "2026-10-09", end: "3w" } },
      { type: "setNodeData", id: "ds", data: { tags: ["crit", "bogus", "done"] } },
      { type: "setNodeShape", id: "lc", shape: "task" },
      { type: "setNodeShape", id: "on", shape: "milestone" },
    ]);
    expect(next.source).toContain("    Diagram editor beta :active, de, 2026-10-09, 3w\n");
    expect(next.source).toContain(
      "    Design system v9 rollout :crit, done, ds, 2026-10-01, 14d\n",
    );
    expect(next.source).toContain("    Launch comms :lc, 2026-12-10, 0d\n");
    expect(next.source).toContain("    Onboarding redesign :milestone, on, 2026-10-15, 28d\n");
    expect(next.graph.nodes.find((n) => n.id === "on")?.shape).toBe("milestone");
    // Untouched lines keep their spacing.
    expect(next.source).toContain("    Observability upgrade        :         ob, after de, 14d\n");
    await expectValidMermaid(next.source);

    // Renaming an id moves the dependency and the stored position.
    const pinned = parseMermaid(
      SRC.replace("gantt\n", 'gantt\n  %% @ursula {"v":1,"layout":{"de":[1,99]}}\n'),
    );
    const renamed = applyEdit(pinned, { type: "setNodeData", id: "de", data: { id: "editor" } });
    expect(renamed.source).toContain("    Diagram editor beta :active, editor, 2026-10-08, 21d\n");
    expect(renamed.source).toContain("    Observability upgrade :ob, after editor, 14d\n");
    expect(renamed.meta.layout?.editor).toEqual([1, 99]);
    expect(renamed.graph.edges[0]!.id).toBe("L_editor_ob_0");
    await expectValidMermaid(renamed.source);
    // A referenced id cannot be removed; a duplicate id is refused.
    expect(applyEdit(doc, { type: "setNodeData", id: "de", data: { id: "" } })).toBe(doc);
    expect(applyEdit(doc, { type: "setNodeData", id: "de", data: { id: "ds" } })).toBe(doc);
  });

  it("adds, renames and removes tasks", async () => {
    const doc = parseMermaid(SRC);
    const node = { id: "task7", parentId: "Product", ...ganttUI.newNode!(doc.graph, "Product") };
    expect(node.data).toEqual({ start: "2026-12-10", end: "7d" });
    const added = applyEdit(doc, { type: "addNode", node, position: [0, 300] });
    expect(added.source).toContain(
      "    Billing self-serve           :crit,    bi, after on, 21d\n    New task :2026-12-10, 7d\n  section Go-to-market\n",
    );
    const created = added.graph.nodes.find((n) => n.id === "New_task");
    expect(created).toMatchObject({ parentId: "Product", data: { explicitId: false } });
    expect(added.meta.layout?.New_task).toEqual([0, 300]);

    const renamed = applyEdit(added, { type: "renameNode", id: "ds", label: "DS: v9" });
    expect(renamed.source).toContain("    DS v9 :done, ds, 2026-10-01, 14d\n");
    expect(renamed.graph.nodes[0]!.id).toBe("ds");

    // Removing a task drops references to it.
    const removed = applyEdit(renamed, { type: "removeNodes", ids: ["de"] });
    expect(removed.source).not.toContain("Diagram editor beta");
    expect(removed.source).toContain("    Observability upgrade :ob, 2026-10-29, 14d\n");
    expect(removed.graph.edges.map((e) => e.id)).toEqual(["L_on_bi_0"]);
    await expectValidMermaid(removed.source);
  });

  it("maps dependency edges to `after`", async () => {
    const doc = parseMermaid(SRC);
    const linked = applyEdits(doc, [
      { type: "addEdge", edge: { source: "ds", target: "on" } },
      { type: "addEdge", edge: { source: "ob", target: "bi" } },
    ]);
    expect(linked.source).toContain("    Onboarding redesign :on, after ds, 28d\n");
    expect(linked.source).toContain("    Billing self-serve :crit, bi, after on ob, 21d\n");
    expect(linked.graph.edges.map((e) => e.id)).toEqual([
      "L_de_ob_0",
      "L_ds_on_0",
      "L_on_bi_0",
      "L_ob_bi_0",
    ]);
    await expectValidMermaid(linked.source);

    // Cycles are refused.
    expect(applyEdit(doc, { type: "addEdge", edge: { source: "bi", target: "on" } })).toBe(doc);

    const unlinked = applyEdit(linked, { type: "removeEdges", ids: ["L_on_bi_0", "L_de_ob_0"] });
    expect(unlinked.source).toContain("    Billing self-serve :crit, bi, after ob, 21d\n");
    // The last dependency gone: the task keeps its resolved start date.
    expect(unlinked.source).toContain("    Observability upgrade :ob, 2026-10-29, 14d\n");

    const swapped = applyEdit(doc, {
      type: "reconnectEdge",
      id: "L_de_ob_0",
      source: "ds",
      target: "ob",
    });
    expect(swapped.source).toContain("    Observability upgrade :ob, after ds, 14d\n");
    const retargeted = applyEdit(doc, {
      type: "reconnectEdge",
      id: "L_de_ob_0",
      source: "de",
      target: "lc",
    });
    expect(retargeted.source).toContain("    Observability upgrade :ob, 2026-10-29, 14d\n");
    expect(retargeted.source).toContain("    Launch comms :milestone, lc, after de, 0d\n");
    for (const d of [unlinked, swapped, retargeted]) await expectValidMermaid(d.source);
  });

  it("gives a dependency source an explicit id when it lacks one", async () => {
    const src = "gantt\n  dateFormat YYYY-MM-DD\n  Research : 2026-01-05, 10d\n  Design : 7d\n";
    const doc = parseMermaid(src);
    expect(doc.graph.nodes.map((n) => [n.id, n.data?.explicitId])).toEqual([
      ["Research", false],
      ["Design", false],
    ]);
    const next = applyEdit(doc, {
      type: "addEdge",
      edge: { source: "Design", target: "Research" },
    });
    // Design followed Research; it is pinned to its resolved date so the link is not circular.
    expect(next.source).toBe(
      "gantt\n  dateFormat YYYY-MM-DD\n  Research :after Design, 10d\n  Design :Design, 2026-01-15, 7d\n",
    );
    await expectValidMermaid(next.source);
  });

  it("edits config lines and the title", async () => {
    const doc = parseMermaid(SRC);
    const next = applyEdits(doc, [
      { type: "setGraphData", data: { axisFormat: "%d/%m", excludes: "weekends" } },
      { type: "setGraphData", data: { todayMarker: "" } },
      { type: "setTitle", title: "Q4 plan" },
    ]);
    expect(
      next.source.startsWith(
        "gantt\n  title Q4 plan\n  dateFormat YYYY-MM-DD\n  axisFormat %d/%m\n  excludes weekends\n  section Platform\n",
      ),
    ).toBe(true);
    expect(next.graph.data?.excludes).toBe("weekends");
    const removed = applyEdit(next, { type: "setGraphData", data: { excludes: undefined } });
    expect(removed.source).not.toContain("excludes");
    const untitled = applyEdit(doc, { type: "setTitle", title: "" });
    expect(untitled.source.startsWith("gantt\n  dateFormat")).toBe(true);
    const bare = applyEdit(parseMermaid("gantt\n  Task : 2026-01-01, 1d\n"), {
      type: "setGraphData",
      data: { dateFormat: "YYYY-MM-DD" },
    });
    expect(bare.source).toBe("gantt\n  dateFormat YYYY-MM-DD\n  Task : 2026-01-01, 1d\n");
    for (const d of [next, removed, untitled, bare]) await expectValidMermaid(d.source);
  });

  it("edits sections", async () => {
    const doc = parseMermaid(SRC);
    const next = applyEdits(doc, [
      { type: "setNodeParent", ids: ["lc"], parentId: "Product" },
      { type: "renameGroup", id: "Product", label: "Product work" },
      { type: "groupNodes", groupId: "g", label: "Later", nodeIds: ["ob"] },
    ]);
    expect(next.source).toContain(
      "  section Later\n    Observability upgrade        :         ob, after de, 14d\n  section Product work\n",
    );
    expect(next.source).toContain(
      "    Billing self-serve           :crit,    bi, after on, 21d\n    Launch comms                 :milestone, lc, 2026-12-10, 0d\n  section Go-to-market\n",
    );
    expect(next.graph.nodes.find((n) => n.id === "lc")?.parentId).toBe("Product_work");
    const ungrouped = applyEdit(next, { type: "ungroup", groupId: "Go_to_market" });
    expect(ungrouped.source.endsWith("0d\n")).toBe(true);
    await expectValidMermaid(next.source);
    const db = await mermaidDb<GanttDb>(next.source);
    expect(db.getSections()).toEqual(["Platform", "Later", "Product work", "Go-to-market"]);
  });

  it("keeps unknown lines verbatim", async () => {
    const src = `gantt
  accTitle: Roadmap: Q4
  %% note: not a task
  dateFormat YYYY-MM-DD
  includes 2026-10-03
  weekday monday
  Kickoff : k, 2026-10-01, 1d
  click k href "https://example.com"
`;
    const doc = parseMermaid(src);
    expect(serializeMermaid(doc)).toBe(src);
    expect(doc.graph.nodes.map((n) => n.id)).toEqual(["k"]);
    const next = applyEdit(doc, { type: "setNodeData", id: "k", data: { end: "2d" } });
    expect(next.source).toBe(
      src.replace("Kickoff : k, 2026-10-01, 1d", "Kickoff :k, 2026-10-01, 2d"),
    );
    await expectValidMermaid(next.source);
  });

  it("lays tasks out like Mermaid: one row per task on a shared time scale", async () => {
    const doc = parseMermaid(SRC);
    const geo = ganttGeometry(doc.graph);
    const { positions, sizes } = await autoLayoutDiagram(doc.graph, { family: "gantt" });
    const day = geo.pxPerDay;
    const rowH = GANTT_METRICS.barHeight + GANTT_METRICS.barGap;
    // ds starts at the origin; de a week later; widths follow durations.
    expect(positions.ds![0]).toBe(0);
    expect(positions.de![0]).toBeCloseTo(7 * day);
    expect(sizes.de!.width).toBeCloseTo(21 * day);
    // Milestones are small diamonds centred on their date.
    expect(sizes.lc).toEqual({
      width: GANTT_METRICS.milestoneSize,
      height: GANTT_METRICS.milestoneSize,
    });
    // Rows in document order, sections as full-width bands with a label column.
    const ys = ["ds", "de", "ob", "on", "bi"].map((id) => positions[id]![1]);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(ys[1]! - ys[0]!).toBe(rowH);
    expect(positions.Platform).toEqual([-GANTT_METRICS.labelWidth, 0]);
    expect(sizes.Platform!.width).toBe(sizes.Product!.width);
    expect(positions.Product![1]).toBe(3 * rowH);
    // Stored positions never override the dates.
    const stored = await ensureDiagramLayout(
      doc.graph,
      { v: 1, layout: { de: [999, 40] } },
      { family: "gantt" },
    );
    expect(stored.positions.de).toEqual(positions.de);
    // Date ticks along the axis, formatted with axisFormat.
    expect(geo.ticks.length).toBeGreaterThan(3);
    expect(geo.ticks[0]!.label).toMatch(/^[A-Z][a-z]{2} \d{2}$/);
  });

  it("turns dragging a bar into date and row edits", async () => {
    const doc = parseMermaid(SRC);
    const geo = ganttGeometry(doc.graph);
    const de = geo.rowById.get("de")!;
    // Three days later, same row: the start moves, the duration is kept.
    const later = applyEdit(doc, {
      type: "moveNodes",
      moves: [{ id: "de", position: [de.x + 3 * geo.pxPerDay, de.y] }],
    });
    expect(later.source).toContain("    Diagram editor beta :active, de, 2026-10-11, 21d\n");
    expect(later.meta.layout ?? {}).toEqual({});
    await expectValidMermaid(later.source);
    // Dropping an `after` task on a date replaces the dependency with that date.
    const ob = geo.rowById.get("ob")!;
    const pinned = applyEdit(doc, {
      type: "moveNodes",
      moves: [{ id: "ob", position: [ob.x + geo.pxPerDay, ob.y] }],
    });
    expect(pinned.source).toContain("Observability upgrade :ob, 2026-10-30, 14d\n");
    expect(pinned.graph.edges.some((e) => e.target === "ob")).toBe(false);
    // Dropping on another section's row moves the task into that section.
    const bi = geo.rowById.get("bi")!;
    const moved = applyEdit(doc, {
      type: "moveNodes",
      moves: [{ id: "ds", position: [geo.rowById.get("ds")!.x, bi.y] }],
    });
    expect(moved.graph.nodes.find((n) => n.id === "ds")?.parentId).toBe("Product");
    await expectValidMermaid(moved.source);
    // A drop that lands on its own slot changes nothing.
    const same = applyEdit(doc, {
      type: "moveNodes",
      moves: [{ id: "de", position: [de.x + 1, de.y + 2] }],
    });
    expect(same.source).toBe(doc.source);
  });

  it("turns resizing a bar into a duration", async () => {
    const doc = parseMermaid(SRC);
    const geo = ganttGeometry(doc.graph);
    const resized = applyEdit(doc, {
      type: "resizeNode",
      id: "de",
      size: [10 * geo.pxPerDay, GANTT_METRICS.barHeight],
    });
    expect(resized.source).toContain("    Diagram editor beta :active, de, 2026-10-08, 10d\n");
    expect(resized.meta.sizes ?? {}).toEqual({});
    await expectValidMermaid(resized.source);
  });

  it("parses and formats dates in the diagram's format", () => {
    const ms = parseGanttDate("05/01/2026", "DD/MM/YYYY")!;
    expect(formatGanttDate(ms)).toBe("2026-01-05");
    expect(formatGanttDate(ms, "DD/MM/YYYY")).toBe("05/01/2026");
    expect(formatGanttDate(ms, "MMM D")).toBe("2026-01-05");
    expect(parseGanttDate("after x")).toBeUndefined();
  });
});
