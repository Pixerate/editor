// @vitest-environment jsdom
// Ported from Ursula (src/journey/journey.test.ts).
import { describe, expect, it } from "vitest";
import { applyEdit, applyEdits, parseMermaid, serializeMermaid } from "../src/diagram/index.js";
import { registerDiagramAdapter } from "../src/diagram/registry.js";
import type { DiagramAdapter } from "../src/diagram/types.js";
import { autoLayoutDiagram } from "../src/canvas/mermaid/layout.js";
import { expectValidMermaid, mermaidDb } from "./helpers/mermaid";
import { journeyAdapter } from "../src/diagram/journey/index.js";
import { faceY, journeyGeometry, scoreAt } from "../src/diagram/journey/geometry.js";

registerDiagramAdapter(journeyAdapter as DiagramAdapter<unknown>);

const SRC = `journey
  title Requesting a new laptop
  section Discover
    Find IT portal: 3: Employee
    Read policy: 2: Employee
  section Request
    Fill request form: 4: Employee
    Manager approval: 3: Manager
    IT review: 4: IT
  section Receive
    Device shipped: 5: IT
    Device set up: 5: Employee
`;

interface JourneyDb {
  getTasks: () => { task: string; score: number; people: string[]; section: string }[];
  getActors: () => string[];
}

describe("journey adapter", () => {
  it("round-trips untouched", () => {
    const doc = parseMermaid(SRC);
    expect(doc.family).toBe("journey");
    expect(doc.tier).toBe("editable");
    expect(serializeMermaid(doc)).toBe(SRC);
  });

  it("builds tasks, sections and sequence edges", async () => {
    const doc = parseMermaid(SRC);
    expect(doc.graph.title).toBe("Requesting a new laptop");
    expect(doc.graph.groups.map((g) => [g.id, g.label])).toEqual([
      ["Discover", "Discover"],
      ["Request", "Request"],
      ["Receive", "Receive"],
    ]);
    const portal = doc.graph.nodes[0]!;
    expect(portal).toMatchObject({
      id: "Find_IT_portal",
      label: "Find IT portal",
      shape: "rect",
      parentId: "Discover",
      data: { score: 3, actors: ["Employee"], details: ["Score 3", "Employee"] },
    });
    expect(doc.graph.edges).toHaveLength(6);
    expect(doc.graph.edges[0]).toMatchObject({
      id: "L_Find_IT_portal_Read_policy_0",
      arrowEnd: "none",
      data: { synthetic: true },
    });

    const db = await mermaidDb<JourneyDb>(SRC);
    expect(db.getTasks().map((t) => [t.task, t.score, t.people, t.section])).toEqual(
      doc.graph.nodes.map((n) => [
        n.label,
        n.data?.score,
        n.data?.actors,
        doc.graph.groups.find((g) => g.id === n.parentId)?.label,
      ]),
    );
    expect([...db.getActors()].sort()).toEqual(["Employee", "IT", "Manager"]);
  });

  it("adds, renames, edits and removes tasks", async () => {
    const doc = parseMermaid(SRC);
    const added = applyEdit(doc, {
      type: "addNode",
      node: { id: "task8", label: "Return old laptop", parentId: "Receive", data: { score: 2 } },
      position: [10, 20],
    });
    expect(added.source).toContain("    Device set up: 5: Employee\n    Return old laptop: 2\n");
    expect(added.meta.layout?.Return_old_laptop).toEqual([10, 20]);
    expect(added.graph.nodes.at(-1)?.parentId).toBe("Receive");

    // Positions are derived (moving reorders), so sizes carry the metadata here.
    const moved = applyEdit(added, { type: "resizeNode", id: "Read_policy", size: [5, 5] });
    const renamed = applyEdit(moved, {
      type: "renameNode",
      id: "Read_policy",
      label: "Read: policy",
    });
    // `:` would start the score, so it is dropped from names.
    expect(renamed.source).toContain("    Read policy: 2: Employee\n");
    expect(renamed.graph.nodes[1]!.id).toBe("Read_policy");
    const renamed2 = applyEdit(renamed, {
      type: "renameNode",
      id: "Read_policy",
      label: "Read the policy",
    });
    expect(renamed2.source).toContain("    Read the policy: 2: Employee\n");
    expect(renamed2.meta.sizes?.Read_the_policy).toEqual([5, 5]);
    expect(renamed2.meta.sizes?.Read_policy).toBeUndefined();

    const scored = applyEdit(renamed2, {
      type: "setNodeData",
      id: "IT_review",
      data: { score: 9, actors: ["IT", "Security", "IT"] },
    });
    expect(scored.source).toContain("    IT review: 5: IT, Security\n");

    const removed = applyEdit(scored, { type: "removeNodes", ids: ["Manager_approval"] });
    expect(removed.source).not.toContain("Manager approval");
    await expectValidMermaid(removed.source);
    const db = await mermaidDb<JourneyDb>(removed.source);
    expect(db.getTasks().find((t) => t.task === "IT review")).toMatchObject({
      score: 5,
      people: ["IT", "Security"],
    });
  });

  it("edits sections: group, rename, re-parent, ungroup", async () => {
    const doc = parseMermaid(SRC);
    const grouped = applyEdit(doc, {
      type: "groupNodes",
      groupId: "g1",
      label: "Approve",
      nodeIds: ["Manager_approval", "IT_review"],
    });
    expect(grouped.source).toContain(
      "  section Request\n    Fill request form: 4: Employee\n  section Approve\n    Manager approval: 3: Manager\n    IT review: 4: IT\n  section Receive\n",
    );
    expect(grouped.graph.nodes.find((n) => n.id === "IT_review")?.parentId).toBe("Approve");

    // Grouping the first task of a section re-opens the section for the rest.
    const split = applyEdit(doc, {
      type: "groupNodes",
      groupId: "g1",
      label: "Start",
      nodeIds: ["Fill_request_form"],
    });
    expect(split.source).toContain(
      "  section Start\n    Fill request form: 4: Employee\n  section Request\n    Manager approval: 3: Manager\n",
    );
    expect(split.graph.nodes.find((n) => n.id === "Manager_approval")?.parentId).toBe("Request");
    await expectValidMermaid(split.source);

    // Grouping a middle task re-opens the previous section after the block.
    const middle = applyEdit(doc, {
      type: "groupNodes",
      groupId: "g1",
      label: "Approve",
      nodeIds: ["Manager_approval"],
    });
    expect(middle.source).toContain(
      "  section Request\n    Fill request form: 4: Employee\n  section Approve\n    Manager approval: 3: Manager\n  section Request\n    IT review: 4: IT\n",
    );
    expect(middle.graph.nodes.find((n) => n.id === "IT_review")?.parentId).toBe("Request_2");
    await expectValidMermaid(middle.source);

    const renamed = applyEdit(doc, { type: "renameGroup", id: "Request", label: "Ask; for it" });
    expect(renamed.source).toContain("  section Ask for it\n");

    const reparented = applyEdit(doc, {
      type: "setNodeParent",
      ids: ["Find_IT_portal"],
      parentId: "Receive",
    });
    expect(
      reparented.source.endsWith(
        "    Device set up: 5: Employee\n    Find IT portal: 3: Employee\n",
      ),
    ).toBe(true);

    const top = applyEdit(doc, { type: "setNodeParent", ids: ["IT_review"], parentId: undefined });
    expect(top.source).toContain(
      "  title Requesting a new laptop\n  IT review: 4: IT\n  section Discover\n",
    );
    expect(top.graph.nodes[0]).toMatchObject({ id: "IT_review", parentId: undefined });

    const ungrouped = applyEdit(doc, { type: "ungroup", groupId: "Request" });
    expect(ungrouped.source).not.toContain("section Request");
    expect(ungrouped.graph.nodes.find((n) => n.id === "IT_review")?.parentId).toBe("Discover");
    for (const d of [grouped, renamed, reparented, top, ungrouped])
      await expectValidMermaid(d.source);
  });

  it("edits the title and refuses edge edits", () => {
    const doc = parseMermaid(SRC);
    const titled = applyEdit(doc, { type: "setTitle", title: "Laptop" });
    expect(titled.source.startsWith("journey\n  title Laptop\n")).toBe(true);
    const untitled = applyEdit(doc, { type: "setTitle", title: undefined });
    expect(untitled.source).not.toContain("title");
    const fresh = applyEdit(untitled, { type: "setTitle", title: "Again" });
    expect(fresh.source.startsWith("journey\n  title Again\n  section Discover\n")).toBe(true);

    const edge = doc.graph.edges[0]!;
    expect(applyEdit(doc, { type: "removeEdges", ids: [edge.id] })).toBe(doc);
    expect(
      applyEdit(doc, { type: "addEdge", edge: { source: "IT_review", target: "Read_policy" } }),
    ).toBe(doc);
    expect(applyEdit(doc, { type: "setNodeShape", id: "IT_review", shape: "diam" })).toBe(doc);
  });

  it("keeps unknown lines verbatim", async () => {
    const src =
      "journey\n  accTitle: Accessible: title\n  %% note: here\n  accDescr {\n    multi: line\n  }\n  Loose task: 3\n";
    const doc = parseMermaid(src);
    expect(doc.graph.nodes.map((n) => n.id)).toEqual(["Loose_task"]);
    const next = applyEdits(doc, [
      { type: "setNodeData", id: "Loose_task", data: { score: 4 } },
      { type: "addNode", node: { id: "x", label: "Other" } },
    ]);
    expect(next.source).toBe(
      "journey\n  accTitle: Accessible: title\n  %% note: here\n  accDescr {\n    multi: line\n  }\n  Loose task: 4\n  Other: 3\n",
    );
    await expectValidMermaid(next.source);
  });

  it("lays tasks out in one row as Mermaid does", async () => {
    const doc = parseMermaid(SRC);
    const { positions, sizes } = await autoLayoutDiagram(doc.graph, { family: "journey" });
    // leftMargin 150; a task every 200px (width 150 + taskMargin 50); sections at y = 50.
    expect(positions.Discover).toEqual([150, 50]);
    expect(sizes.Discover).toEqual({ width: 350, height: 50 });
    expect(positions.Find_IT_portal).toEqual([150, 110]);
    expect(positions.Read_policy).toEqual([350, 110]);
    expect(positions.Request).toEqual([550, 50]);
    expect(sizes.Request!.width).toBe(550);
    expect(positions.Device_set_up).toEqual([1350, 110]);
    expect(sizes.Device_set_up).toEqual({ width: 150, height: 50 });
  });

  it("puts faces by score and colours actors in Mermaid's sorted order", () => {
    const geo = journeyGeometry(parseMermaid(SRC).graph);
    expect(geo.legend.map((l) => [l.name, l.colour, l.y])).toEqual([
      ["Employee", 0, 60],
      ["IT", 1, 80],
      ["Manager", 2, 100],
    ]);
    expect(geo.tasks.get("Device_shipped")!.face).toEqual({ x: 1225, y: 300 });
    expect(geo.tasks.get("Read_policy")!.face).toEqual({ x: 425, y: 390 });
    expect(geo.tasks.get("Manager_approval")!.actors).toEqual([
      { name: "Manager", colour: 2, x: 764, y: 110 },
    ]);
    expect([...geo.sections.values()].map((s) => s.colour)).toEqual([0, 1, 2]);
    expect(geo.axis).toEqual({ x1: 150, x2: 1546, y: 200 });
    expect([scoreAt(300), scoreAt(316), scoreAt(400), scoreAt(999), scoreAt(-50)]).toEqual([
      5, 4, 2, 1, 5,
    ]);
    expect(faceY(1)).toBe(420);
  });

  it("reorders a task dragged sideways, across sections", async () => {
    const doc = parseMermaid(SRC);
    // Drop "Device set up" (column 6) between "Find IT portal" and "Read policy".
    const moved = applyEdit(doc, {
      type: "moveNodes",
      moves: [{ id: "Device_set_up", position: [300, 140] }],
    });
    expect(moved.source).toBe(
      SRC.replace("    Device set up: 5: Employee\n", "").replace(
        "    Read policy",
        "    Device set up: 5: Employee\n    Read policy",
      ),
    );
    expect(moved.graph.nodes.find((n) => n.id === "Device_set_up")?.parentId).toBe("Discover");
    expect(moved.meta.layout?.Device_set_up).toBeUndefined();
    await expectValidMermaid(moved.source);
    // Dropped in its own column: nothing changes.
    const same = applyEdit(doc, {
      type: "moveNodes",
      moves: [{ id: "Read_policy", position: [360, 300] }],
    });
    expect(same.source).toBe(SRC);
    expect(same.meta.layout?.Read_policy).toBeUndefined();
    // Past the end: last task of the last section.
    const end = applyEdit(doc, {
      type: "moveNodes",
      moves: [{ id: "Find_IT_portal", position: [5000, 110] }],
    });
    expect(
      end.source.endsWith("    Device set up: 5: Employee\n    Find IT portal: 3: Employee\n"),
    ).toBe(true);
  });
});
