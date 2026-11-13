// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { FAMILY_TEMPLATES, applyEdits, parseMermaid, planDiagramReorder, type MermaidDocument } from "../src/diagram";
import {
  ensureDiagramLayout,
  mermaidToScene,
  planDiagramDrag,
  previewDiagramDrag,
  withDiagramDragHandles,
  type DiagramDrag,
  type DiagramMark,
  type DiagramScene,
} from "../src/canvas";
import { expectValidMermaid } from "./helpers/mermaid";

const layoutOf = (doc: MermaidDocument) => ensureDiagramLayout(doc.graph, doc.meta, { family: doc.family });
const sceneOf = (doc: MermaidDocument, selection: string[] = []) => withDiagramDragHandles(mermaidToScene(doc, { selection })!, { selection });

/** Centre of the first draggable mark that targets `target` (optionally with `role`). */
function grab(scene: DiagramScene, target: string, role?: string): { mark: DiagramMark; at: [number, number] } {
  const mark = scene.marks.find((m) => m.target === target && m.drag && (!role || m.role === role));
  if (!mark) throw new Error(`no draggable mark for ${target}${role ? ` (${role})` : ""}`);
  const at: [number, number] =
    mark.kind === "rect" ? [mark.x + mark.width / 2, mark.y + mark.height / 2]
    : mark.kind === "circle" ? [mark.cx, mark.cy]
    : mark.kind === "text" ? [mark.x, mark.y]
    : mark.kind === "line" ? [(mark.x1 + mark.x2) / 2, (mark.y1 + mark.y2) / 2]
    : [mark.box?.x ?? 0, mark.box?.y ?? 0];
  return { mark, at };
}

function drop(doc: MermaidDocument, target: string, by: [number, number], options: { role?: string; over?: string; selection?: string[] } = {}) {
  const scene = sceneOf(doc, options.selection);
  const { mark, at } = grab(scene, target, options.role);
  const drag: DiagramDrag = { kind: mark.drag!, target, start: at, pointer: [at[0] + by[0], at[1] + by[1]], over: options.over };
  const ops = planDiagramDrag(doc, layoutOf(doc), drag);
  return { ops, drag, scene, next: ops.length ? applyEdits(doc, ops) : doc };
}

describe("dragging family pictures", () => {
  it("marks draggable marks only on families Ursula lets you drag", () => {
    expect(sceneOf(parseMermaid(FAMILY_TEMPLATES.pie!)).marks.some((m) => m.drag)).toBe(false);
    for (const family of ["gantt", "journey", "quadrant", "mindmap", "sequence", "timeline", "gitGraph", "c4", "architecture"] as const) {
      expect(sceneOf(parseMermaid(FAMILY_TEMPLATES[family]!)).marks.some((m) => m.drag), family).toBe(true);
    }
  });

  it("ignores clicks and drops that go nowhere", () => {
    const doc = parseMermaid(FAMILY_TEMPLATES.quadrant!);
    const id = doc.graph.nodes[0]!.id;
    expect(drop(doc, id, [1, 1]).ops).toEqual([]);
    expect(drop(parseMermaid(FAMILY_TEMPLATES.gantt!), "a1", [40, 0], { role: "link-handle", selection: ["a1"] }).ops).toEqual([]);
  });

  it("moves a quadrant point by rewriting its coordinates", async () => {
    const doc = parseMermaid(FAMILY_TEMPLATES.quadrant!);
    const id = doc.graph.nodes.find((n) => n.label === "Idea A")!.id;
    const { next, ops } = drop(doc, id, [50, 50]);
    expect(ops[0]).toMatchObject({ type: "moveNodes" });
    expect(next.source).not.toContain("Idea A: [0.3, 0.8]");
    expect(next.source).toMatch(/Idea A: \[0\.\d+, 0\.\d+\]/);
    expect(next.meta.layout ?? {}).toEqual({});
    await expectValidMermaid(next.source);
  });

  it("moves a Gantt bar to new dates, resizes it and links it to another task", async () => {
    const doc = parseMermaid(FAMILY_TEMPLATES.gantt!);
    const week = drop(doc, "a1", [0, 0]).scene; // just to read the scale
    const bar = week.marks.find((m) => m.kind === "rect" && m.role === "bar" && m.target === "a1")! as Extract<DiagramMark, { kind: "rect" }>;
    const pxPerDay = bar.width / 10;
    const moved = drop(doc, "a1", [pxPerDay * 3, 0], { role: "bar" }).next;
    expect(moved.source).toContain("Research :a1, 2026-01-08, 10d");

    const resized = drop(doc, "a1", [pxPerDay * 4, 0], { role: "resize-handle", selection: ["a1"] });
    expect(resized.ops[0]).toMatchObject({ type: "resizeNode", id: "a1" });
    expect(resized.next.source).toContain("Research :a1, 2026-01-05, 14d");

    const linked = drop(doc, "a1", [300, 40], { role: "link-handle", selection: ["a1"], over: "a3" });
    expect(linked.ops).toEqual([{ type: "addEdge", edge: { source: "a1", target: "a3" } }]);
    expect(linked.next.source).toMatch(/Build :a3, after a2 a1, 14d|Build :a3, after a1/);
    await expectValidMermaid(linked.next.source);
  });

  it("drags a journey face to a new score and a task to another column", async () => {
    const doc = parseMermaid(FAMILY_TEMPLATES.journey!);
    const task = doc.graph.nodes.find((n) => n.label === "Find the product")!;
    const faces = sceneOf(doc).marks.filter((m) => m.target === task.id && m.drag === "score");
    expect(faces.length).toBeGreaterThan(1);
    const up = drop(doc, task.id, [0, -200], { role: "face" });
    expect(up.ops).toEqual([{ type: "setNodeData", id: task.id, data: { score: 5 } }]);
    expect(up.next.source).toContain("Find the product: 5: Customer");

    const last = doc.graph.nodes.find((n) => n.label === "Confirm order")!;
    const moved = drop(doc, task.id, [10_000, 0], { role: "task" }).next;
    const order = moved.graph.nodes.map((n) => n.label);
    expect(order.indexOf("Find the product")).toBeGreaterThan(order.indexOf(last.label) - 1);
    await expectValidMermaid(moved.source);
  });

  it("reorders sequence participants, adds a message between lifelines and moves a message", async () => {
    const doc = parseMermaid(FAMILY_TEMPLATES.sequence!);
    const swapped = drop(doc, "U", [400, 0], { role: "participant" }).next;
    expect(swapped.source.indexOf("participant S")).toBeLessThan(swapped.source.indexOf("participant U"));

    const wired = drop(doc, "S", [-300, 0], { role: "lifeline", over: "U" });
    expect(wired.ops).toEqual([{ type: "addEdge", edge: { source: "S", target: "U" } }]);
    expect(wired.next.graph.edges).toHaveLength(3);

    const first = doc.graph.edges[0]!.id;
    const moved = drop(doc, first, [0, 120], { role: "message-label" });
    expect(moved.ops).toEqual([{ type: "setEdgeData", id: first, data: { index: 1 } }]);
    expect(moved.next.source.indexOf("Response")).toBeLessThan(moved.next.source.indexOf("Request"));
    await expectValidMermaid(moved.next.source);
  });

  it("moves a timeline period to another column", async () => {
    const doc = parseMermaid(FAMILY_TEMPLATES.timeline!);
    const first = doc.graph.nodes[0]!;
    const next = drop(doc, first.id, [10_000, 0], { role: "period" }).next;
    expect(next.graph.nodes.at(-1)!.label).toBe(first.label);
    await expectValidMermaid(next.source);
  });

  it("re-parents a mindmap topic dropped onto another topic", async () => {
    const doc = parseMermaid(FAMILY_TEMPLATES.mindmap!);
    const layout = layoutOf(doc);
    const c = doc.graph.nodes.find((n) => n.label === "Topic C")!;
    const a = doc.graph.nodes.find((n) => n.label === "Topic A")!;
    const [ax, ay] = layout.positions[a.id]!;
    const [cx, cy] = layout.positions[c.id]!;
    const next = drop(doc, c.id, [ax - cx, ay - cy], { role: "topic" }).next;
    expect(next.graph.edges.some((e) => e.source === a.id && e.target === c.id)).toBe(true);
    await expectValidMermaid(next.source);
  });

  it("merges a branch by dragging its tip onto another branch's tip", async () => {
    const doc = parseMermaid('gitGraph\n  commit id: "init"\n  branch develop\n  checkout develop\n  commit id: "feature"\n  checkout main\n  commit id: "fix"\n');
    const next = drop(doc, "feature", [0, -60], { role: "commit", over: "fix" }).next;
    expect(next.source).toContain("merge develop");
    await expectValidMermaid(next.source);
  });

  it("places C4 and architecture nodes freely, into and out of groups", async () => {
    const arch = parseMermaid(FAMILY_TEMPLATES.architecture!);
    const layout = layoutOf(arch);
    const into = layout.positions.app!;
    const [ex, ey] = layout.positions.edge!;
    const size = layout.sizes.app!;
    const inside = drop(arch, "edge", [into[0] + size.width / 2 - ex - 40, into[1] + size.height / 2 - ey - 40], { role: "icon" });
    expect(inside.ops.map((o) => o.type)).toEqual(["moveNodes", "setNodeParent"]);
    expect(inside.next.source).toMatch(/service edge\(internet\)\[Edge\] in app/);
    const out = drop(inside.next, "edge", [-2000, 0], { role: "icon" });
    expect(out.ops.at(-1)).toEqual({ type: "setNodeParent", ids: ["edge"], parentId: undefined });
    await expectValidMermaid(out.next.source);

    const c4 = parseMermaid(FAMILY_TEMPLATES.c4!);
    const moved = drop(c4, "user", [30, 40], { role: "element" }).next;
    expect(moved.meta.layout?.user).toBeDefined();
  });

  it("previews a drag: the node follows, a face snaps, a link draws a rubber band", () => {
    const doc = parseMermaid(FAMILY_TEMPLATES.quadrant!);
    const id = doc.graph.nodes[0]!.id;
    const scene = sceneOf(doc);
    const { at } = grab(scene, id, "point");
    const preview = previewDiagramDrag(scene, { kind: "move", target: id, start: at, pointer: [at[0] + 20, at[1] + 10] });
    expect(preview.marks.filter((m) => m.target === id && m.drag).every((m) => m.offset?.[0] === 20 && m.offset?.[1] === 10)).toBe(true);
    expect(preview.marks.filter((m) => m.target !== id).every((m) => !m.offset)).toBe(true);

    const journey = parseMermaid(FAMILY_TEMPLATES.journey!);
    const task = journey.graph.nodes[0]!.id;
    const js = sceneOf(journey);
    const face = grab(js, task, "face");
    const snapped = previewDiagramDrag(js, { kind: "score", target: task, start: face.at, pointer: [face.at[0], face.at[1] - 7] });
    expect(new Set(snapped.marks.filter((m) => m.drag === "score" && m.target === task).map((m) => m.offset?.[1] ?? 0))).toEqual(new Set([0]));

    const seq = parseMermaid(FAMILY_TEMPLATES.sequence!);
    const ss = sceneOf(seq);
    const life = grab(ss, "U", "lifeline");
    const band = previewDiagramDrag(ss, { kind: "connect", target: "U", start: life.at, pointer: [life.at[0] + 100, life.at[1]], over: "S" });
    expect(band.marks.at(-1)).toMatchObject({ role: "drag-link", markerEnd: "arrowclosed" });
    expect(band.marks.some((m) => m.target === "S" && m.selected)).toBe(true);
  });
});

describe("reordering by id (the agent path for sideways drags)", () => {
  const order = (doc: MermaidDocument) => {
    const layout = layoutOf(doc);
    const k = doc.family === "gantt" ? 1 : 0;
    return doc.graph.nodes.filter((n) => layout.positions[n.id]).sort((a, b) => layout.positions[a.id]![k] - layout.positions[b.id]![k]).map((n) => n.id);
  };
  const SOURCES = {
    sequence: "sequenceDiagram\n  participant A\n  participant B\n  participant C\n  participant D\n  A->>B: hi\n  C->>D: yo\n",
    journey: FAMILY_TEMPLATES.journey!,
    timeline: FAMILY_TEMPLATES.timeline!,
    gantt: FAMILY_TEMPLATES.gantt!,
  };

  it.each(Object.entries(SOURCES))("moves any %s node before any other, or to the end", async (_family, source) => {
    const doc = parseMermaid(source);
    const ids = order(doc);
    const layout = layoutOf(doc);
    for (const id of ids)
      for (const before of [...ids, null]) {
        if (before === id) continue;
        const ops = planDiagramReorder(doc, id, before, layout);
        const next = ops.length ? applyEdits(doc, ops) : doc;
        const want = ids.filter((x) => x !== id);
        want.splice(before === null ? want.length : want.indexOf(before), 0, id);
        expect(order(next), `${id} before ${before}`).toEqual(want);
      }
    const moved = applyEdits(doc, planDiagramReorder(doc, ids[0]!, null));
    await expectValidMermaid(moved.source);
  });

  it("explains what is wrong", () => {
    const pie = parseMermaid(FAMILY_TEMPLATES.pie!);
    expect(() => planDiagramReorder(pie, "x", null)).toThrow(/have no order to change; use move_diagram_nodes/);
    const seq = parseMermaid(FAMILY_TEMPLATES.sequence!);
    expect(() => planDiagramReorder(seq, "Z", null)).toThrow(/There is no node "Z"; existing ids are "U", "S"/);
    expect(() => planDiagramReorder(seq, "U", "Z")).toThrow(/no node "Z" to move before/);
  });
});
