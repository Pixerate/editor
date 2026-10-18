// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools";
import { DiagramController, FLOWCHART_SHAPES, STATE_SHAPES, createDiagramToolProvider, parseMermaid, validateDiagramEdit } from "../src/diagram";
import {
  DiagramStream,
  streamedDiagramText,
  blendDiagramLayout,
  connectedDiagramOnly,
  diagramCanvasHeight,
  diagramLayoutBounds,
  ensureDiagramLayout,
  estimateDiagramCanvasHeight,
  mermaidMovesFromCanvas,
  mermaidNodePaint,
  mermaidLabelLines,
  mermaidShapePaths,
  mermaidEdgeMarker,
  mermaidToCanvas,
  type DiagramLayout,
} from "../src/canvas";
import { expectValidMermaid, mermaidSummary, normaliseSummary, diagramSummary } from "./helpers/mermaid";

const SOURCE = `%% Order flow, kept as written
flowchart LR
  A[Start] --> B{Decision?}
  B -- yes --> C(Ship)
  subgraph S [Warehouse]
    C --> D[(Stock)]
  end
`;

const setup = (options: Parameters<typeof createDiagramToolProvider>[1] = {}, source = SOURCE) => {
  const controller = new DiagramController({ source });
  const registry = new ToolRegistry();
  registry.register(createDiagramToolProvider(controller, options));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result: any = await registry.callTool(name, args);
    return { error: result.isError ? (result.content[0].text as string) : null, value: result.structuredContent as any };
  };
  return { controller, registry, call };
};

const layout = (positions: DiagramLayout["positions"], size = { width: 100, height: 50 }) => ({
  positions,
  sizes: Object.fromEntries(Object.keys(positions).map((id) => [id, size])),
});

describe("DiagramController", () => {
  it("applies edits as one undo step and keeps untouched text", () => {
    const controller = new DiagramController({ source: SOURCE });
    const result = controller.apply(
      [
        { type: "renameNode", id: "A", label: "Begin" },
        { type: "addEdge", edge: { source: "D", target: "A", label: "restock" } },
      ],
      "Two edits",
    );
    expect(result.ok).toBe(true);
    const source = controller.getSource();
    expect(source).toContain("%% Order flow, kept as written");
    expect(source).toContain("  B -- yes --> C(Ship)");
    expect(source).toContain("A[Begin]");
    expect(controller.getState().undoLabel).toBe("Two edits");
    controller.undo();
    expect(controller.getSource()).toBe(SOURCE);
    controller.redo();
    expect(controller.getSource()).toBe(source);
  });

  it("rejects invalid edits all-or-nothing with a useful message", () => {
    const controller = new DiagramController({ source: SOURCE });
    const result = controller.apply([
      { type: "renameNode", id: "A", label: "x" },
      { type: "renameNode", id: "nope", label: "y" },
    ]);
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toMatch(/There is no node "nope"; existing node ids are/);
    expect(controller.getSource()).toBe(SOURCE);
    expect(controller.getState().issue).toMatch(/nope/);
    expect(controller.getState().canUndo).toBe(false);
  });

  it("validates ids, shapes, groups and directions", () => {
    const doc = parseMermaid(SOURCE);
    expect(validateDiagramEdit(doc, { type: "addNode", node: { id: "A" } })).toMatch(/already used/);
    expect(validateDiagramEdit(doc, { type: "addNode", node: { id: "bad id" } })).toMatch(/not a valid Mermaid id/);
    expect(validateDiagramEdit(doc, { type: "setNodeShape", id: "A", shape: "blob" })).toMatch(/Unknown shape "blob"; use one of "rect"/);
    expect(validateDiagramEdit(doc, { type: "addNode", node: { id: "Z", parentId: "Q" } })).toMatch(/There is no group "Q"; existing groups are "S"/);
    expect(validateDiagramEdit(doc, { type: "setDirection", direction: "XY" })).toMatch(/Unknown direction/);
    expect(validateDiagramEdit(parseMermaid("erDiagram\n  A ||--o{ B : has"), { type: "groupNodes", groupId: "G", label: "g", nodeIds: ["A"] })).toMatch(/no groups/);
    expect(validateDiagramEdit(parseMermaid("sankey-beta\n  a,b,1"), { type: "renameNode", id: "a", label: "b" })).toMatch(/only be edited as Mermaid text/);
  });

  it("merges a drag into one undo step and refuses edits when read-only", () => {
    const controller = new DiagramController({ source: "flowchart TD\n  a --> b" });
    controller.beginGesture("drag");
    controller.apply({ type: "moveNodes", moves: [{ id: "a", position: [10, 10] }] }, "Move");
    controller.apply({ type: "moveNodes", moves: [{ id: "a", position: [40, 50] }] }, "Move");
    controller.endGesture();
    expect(controller.getDocument().meta.layout).toEqual({ a: [40, 50] });
    controller.undo();
    expect(controller.getDocument().meta.layout).toBeUndefined();
    controller.setReadOnly(true);
    expect(controller.getState().editable).toBe(false);
    expect(controller.apply({ type: "renameNode", id: "a", label: "x" })).toEqual({ ok: false, message: "The diagram is read-only." });
  });

  it("notifies subscribers, drops stale selection and clears history on load", () => {
    const controller = new DiagramController({ source: SOURCE });
    const seen: number[] = [];
    controller.subscribe((s) => seen.push(s.revision));
    controller.select(["A", "missing"]);
    expect(controller.getState().selection).toEqual(["A"]);
    controller.apply({ type: "removeNodes", ids: ["A"] });
    expect(controller.getState().selection).toEqual([]);
    controller.load("stateDiagram-v2\n  [*] --> Idle", { clearHistory: true });
    expect(controller.getState()).toMatchObject({ family: "state", canUndo: false, editable: true });
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(controller.nextId()).toBe("N1");
  });
});

describe("diagram agent tools", () => {
  it("lists strict, described, annotated tools and hides writes when read-only", async () => {
    const { registry } = setup();
    const tools = registry.listTools().tools;
    expect(tools.map((t) => t.name)).toEqual([
      "get_diagram",
      "export_diagram_mermaid",
      "find_mermaid_diagrams",
      "load_diagram_mermaid",
      "add_diagram_node",
      "remove_diagram_nodes",
      "rename_diagram_node",
      "set_diagram_node_shape",
      "set_diagram_node_style",
      "set_diagram_node_data",
      "connect_diagram_nodes",
      "remove_diagram_edges",
      "set_diagram_edge_label",
      "set_diagram_edge_data",
      "reconnect_diagram_edge",
      "set_diagram_direction",
      "set_diagram_title",
      "set_diagram_settings",
      "group_diagram_nodes",
      "ungroup_diagram_group",
      "move_diagram_nodes",
      "undo_diagram",
      "redo_diagram",
    ]);
    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys(tool.annotations ?? {}).sort()).toEqual(["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint", "title"]);
    }
    const locked = setup({ readOnly: "The report is locked." });
    expect(locked.registry.listTools().tools.map((t) => t.name)).toEqual(["get_diagram", "export_diagram_mermaid", "find_mermaid_diagrams"]);
    expect((await locked.call("get_diagram")).value.readOnly).toBe("The report is locked.");
  });

  it("reads the diagram with ids the write tools take", async () => {
    const { call } = setup();
    const { value } = await call("get_diagram", { includeSource: true });
    expect(value.family).toBe("flowchart");
    expect(value.nodes.map((n: any) => n.id)).toEqual(["A", "B", "C", "D"]);
    expect(value.nodes.find((n: any) => n.id === "D")).toMatchObject({ shape: "cyl", parentId: "S" });
    expect(value.edges[1]).toMatchObject({ source: "B", target: "C", label: "yes" });
    expect(value.groups).toEqual([{ id: "S", label: "Warehouse" }]);
    expect(value.shapes).toContain("diam");
    expect(value.source).toBe(SOURCE);
  });

  it("closes the loop: add, connect, label, reconnect, remove", async () => {
    const { call, controller } = setup();
    const added = await call("add_diagram_node", { label: "Refund", from: "B", edgeLabel: "no", shape: "rounded" });
    expect(added.error).toBeNull();
    expect(added.value.node).toEqual({ id: "N1", label: "Refund", shape: "rounded" });
    expect(added.value.edge).toMatchObject({ source: "B", target: "N1", label: "no" });

    const connected = await call("connect_diagram_nodes", { source: "N1", target: "A" });
    const edgeId = connected.value.edge.id;
    expect(connected.value.edge).toMatchObject({ source: "N1", target: "A" });

    const labelled = await call("set_diagram_edge_label", { id: edgeId, label: "retry" });
    expect(labelled.value.edge.label).toBe("retry");

    const reconnected = await call("reconnect_diagram_edge", { id: edgeId, source: "N1", target: "C" });
    expect(reconnected.value.edge).toMatchObject({ source: "N1", target: "C", label: "retry" });

    const removed = await call("remove_diagram_nodes", { ids: ["N1"] });
    expect(removed.value.removed).toEqual(["N1"]);
    expect(removed.value.removedEdges).toHaveLength(2);
    expect(controller.getSource()).toBe(SOURCE);
    await expectValidMermaid(controller.getSource());
  });

  it("renames, reshapes, styles, groups, moves and changes direction", async () => {
    const { call, controller } = setup();
    expect((await call("rename_diagram_node", { id: "S", label: "Depot" })).value.node).toEqual({ id: "S", label: "Depot" });
    expect((await call("set_diagram_node_shape", { id: "B", shape: "hex" })).value.node.shape).toBe("hex");
    expect((await call("set_diagram_node_style", { id: "A", styles: ["fill:#fde68a"] })).value.styles).toEqual(["fill:#fde68a"]);
    expect((await call("group_diagram_nodes", { nodeIds: ["A", "B"], label: "Intake" })).value.group).toEqual({ id: "G1", label: "Intake", nodeIds: ["A", "B"] });
    expect((await call("ungroup_diagram_group", { id: "G1" })).value.members.sort()).toEqual(["A", "B"]);
    expect((await call("move_diagram_nodes", { moves: [{ id: "A", x: 12, y: 34 }] })).value.moved).toEqual([{ id: "A", x: 12, y: 34 }]);
    expect((await call("set_diagram_direction", { direction: "TB" })).value.direction).toBe("TB");
    const source = controller.getSource();
    expect(source).toContain('%% @pixerate {"v":1,"layout":{"A":[12,34]}}');
    await expectValidMermaid(source);
    // Mermaid reads the edited diagram the same way.
    expect(normaliseSummary(diagramSummary(parseMermaid(source).graph))).toEqual(normaliseSummary(await mermaidSummary(source)));
    const exported = await call("export_diagram_mermaid", { withLayout: false });
    expect(exported.value.source).not.toContain("@pixerate");
    const undone = await call("undo_diagram");
    expect(undone.value).toEqual({ undone: true, label: "Change direction" });
    expect((await call("redo_diagram")).value).toEqual({ redone: true, label: "Change direction" });
  });

  it("pins auto-laid nodes when moving one, given the canvas positions", async () => {
    const controller = new DiagramController({ source: SOURCE });
    const registry = new ToolRegistry();
    registry.register(createDiagramToolProvider(controller, { getPositions: () => mermaidToCanvas(controller.getDocument()).layout.positions }));
    const before = mermaidToCanvas(controller.getDocument()).layout.positions;
    await registry.callTool("move_diagram_nodes", { moves: [{ id: "A", x: before.A![0], y: before.A![1] + 80 }] });
    const after = mermaidToCanvas(controller.getDocument()).layout.positions;
    // Stored positions are whole pixels.
    expect(Math.abs(after.B![0] - before.B![0]) + Math.abs(after.B![1] - before.B![1])).toBeLessThanOrEqual(1);
    expect(Math.abs(after.A![1] - (before.A![1] + 80))).toBeLessThanOrEqual(0.5);
  });

  it("fails usefully without changing anything", async () => {
    const { call, controller } = setup();
    expect((await call("rename_diagram_node", { id: "Z", label: "x" })).error).toMatch(/There is no node "Z"; existing node ids are "A", "B", "C", "D"/);
    expect((await call("set_diagram_node_shape", { id: "A", shape: "blob" })).error).toMatch(/Unknown shape "blob"/);
    expect((await call("add_diagram_node", { label: "x", id: "A" })).error).toMatch(/already used/);
    expect((await call("add_diagram_node", { label: "x", x: 1 })).error).toMatch(/both x and y/);
    expect((await call("add_diagram_node", { label: "x", edgeLabel: "e" })).error).toMatch(/needs "from"/);
    expect((await call("set_diagram_edge_label", { id: "nope", label: "x" })).error).toMatch(/There is no edge "nope"; existing edge ids are/);
    expect((await call("set_diagram_direction", { direction: "XY" })).error).toBeTruthy();
    expect((await call("connect_diagram_nodes", { source: "A" })).error).toBeTruthy();
    expect((await call("load_diagram_mermaid", { source: "just some prose" })).error).toMatch(/no Mermaid header/);
    expect((await call("load_diagram_mermaid", { source: "```mermaid\nflowchart LR\n a-->b\n```\n```mermaid\npie\n \"a\": 1\n```" })).error).toMatch(/holds 2 diagrams/);
    expect(controller.getSource()).toBe(SOURCE);
    expect(controller.getState().canUndo).toBe(false);
  });

  it("finds and loads Mermaid from Markdown, and keeps other families as text", async () => {
    const { call, controller } = setup();
    const md = "Here:\n\n```mermaid\nclassDiagram\n  Animal <|-- Dog\n```\n";
    const found = await call("find_mermaid_diagrams", { text: md });
    expect(found.value.diagrams).toEqual([{ source: "classDiagram\n  Animal <|-- Dog\n", family: "class" }]);
    const loaded = await call("load_diagram_mermaid", { source: md });
    expect(loaded.value).toMatchObject({ family: "class", editable: true, nodes: 2, edges: 1 });
    expect((await call("undo_diagram")).value.undone).toBe(true);
    expect(controller.getSource()).toBe(SOURCE);
    await call("load_diagram_mermaid", { source: "sankey-beta\n  a,b,1\n" });
    const sankey = await call("add_diagram_node", { label: "x" });
    expect(sankey.error).toMatch(/only be changed as Mermaid text/);
    expect((await call("get_diagram")).value).toMatchObject({ family: "sankey", editable: false });
  });

  it("edits state, class and ER diagrams so Mermaid still parses them", async () => {
    for (const source of [
      "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy : start\n",
      "classDiagram\n  class Animal {\n    +String name\n  }\n  Animal <|-- Dog\n",
      "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n",
    ]) {
      const { call, controller } = setup({}, source);
      const first = (await call("get_diagram")).value.nodes.find((n: any) => !n.synthetic).id;
      const added = await call("add_diagram_node", { label: "Extra", id: "Extra", from: first });
      expect(added.error).toBeNull();
      expect(added.value.edge).toMatchObject({ source: first, target: "Extra" });
      await expectValidMermaid(controller.getSource());
      expect(controller.getSource().startsWith(source.trimEnd().split("\n")[0])).toBe(true);
    }
  });
});

describe("Mermaid on the canvas", () => {
  it("lays out nodes and groups with child positions relative to their group", () => {
    const doc = parseMermaid(SOURCE);
    const { nodes, edges, layout } = mermaidToCanvas(doc, { editable: true });
    expect(nodes[0]).toMatchObject({ id: "S", type: "mermaid-group" });
    const c = nodes.find((n) => n.id === "C")!;
    expect(c).toMatchObject({ type: "mermaid-node", parentId: "S", draggable: true });
    expect(c.position.x).toBeCloseTo(layout.positions.C![0] - layout.positions.S![0]);
    expect(edges.map((e) => [e.source, e.target, e.label])).toEqual([
      ["A", "B", undefined],
      ["B", "C", "yes"],
      ["C", "D", undefined],
    ]);
    expect(edges[0]!.type).toBe("mermaid-edge");
  });

  it("keeps stored positions and blends new nodes in beside them", () => {
    const doc = parseMermaid('flowchart LR\n  %% @pixerate {"v":1,"layout":{"a":[1000,500],"b":[1250,500]}}\n  a --> b --> c');
    const result = ensureDiagramLayout(doc.graph, doc.meta);
    expect(result.positions.a).toEqual([1000, 500]);
    expect(result.positions.c![0]).toBeGreaterThan(1250);
    expect(Math.abs(result.positions.c![1] - 500)).toBeLessThan(100);
  });

  it("turns canvas drags into absolute moveNodes edits, carrying group contents", () => {
    const doc = parseMermaid(SOURCE);
    const { nodes, layout } = mermaidToCanvas(doc);
    const group = nodes.find((n) => n.id === "S")!;
    const dragged = nodes.map((n) => (n.id === "S" ? { ...n, position: { x: group.position.x + 100, y: group.position.y } } : n));
    // The dragged copy wins over a stale copy in `all`.
    const op = mermaidMovesFromCanvas(layout, [dragged.find((n) => n.id === "S")!], nodes)!;
    const byId = Object.fromEntries(op.moves.map((m) => [m.id, m.position]));
    expect(byId.S![0]).toBeCloseTo(layout.positions.S![0] + 100);
    expect(byId.C![0]).toBeCloseTo(layout.positions.C![0] + 100);
    expect(mermaidMovesFromCanvas(layout, [nodes.find((n) => n.id === "A")!], nodes)).toBeNull();
    // With the stored positions given, the rest of an auto-laid diagram is pinned in place.
    const a = nodes.find((n) => n.id === "A")!;
    const pinned = mermaidMovesFromCanvas(layout, [{ ...a, position: { x: a.position.x, y: a.position.y + 50 } }], nodes, { stored: {} })!;
    expect(pinned.moves.map((m) => m.id).sort()).toEqual(["A", "B", "C", "D", "S"]);
    const moved = parseMermaid(SOURCE);
    const next = ensureDiagramLayout(moved.graph, { v: 1, layout: Object.fromEntries(pinned.moves.map((m) => [m.id, m.position])) });
    expect(next.positions.B).toEqual(layout.positions.B); // not yet rounded: written straight into meta
    expect(next.positions.A![1]).toBeCloseTo(layout.positions.A![1] + 50);
  });
});

describe("Mermaid shape geometry", () => {
  it("draws every flowchart and state shape inside its box", () => {
    for (const name of [...FLOWCHART_SHAPES.map((s) => s.name), ...STATE_SHAPES.map((s) => s.name), "stateStart", "stateEnd", "classBox", "erBox"]) {
      const paths = mermaidShapePaths(name, 120, 60);
      expect(paths.length, name).toBeGreaterThan(0);
      for (const { d } of paths) {
        expect(d, name).not.toMatch(/NaN|Infinity/);
        const numbers = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
        expect(Math.max(...numbers), name).toBeLessThanOrEqual(130);
      }
    }
    expect(mermaidShapePaths("stateStart", 28, 28)[0]!.paint).toBe("filled");
    expect(mermaidShapePaths("unknown-shape", 10, 10)).toHaveLength(1);
  });

  it("maps Mermaid styles, labels and arrow heads", () => {
    expect(mermaidNodePaint({ fill: "#f00", "stroke-dasharray": "4 2" })).toMatchObject({ "--pixerate-diagram-node-bg": "#f00", "stroke-dasharray": "4 2" });
    expect(mermaidNodePaint({}, true)["--pixerate-diagram-node-border"]).toContain("--primary");
    expect(mermaidLabelLines('"`Two<br/>**lines**`"')).toEqual(["Two", "**lines**"]);
    expect([mermaidEdgeMarker("none"), mermaidEdgeMarker("arrow_open"), mermaidEdgeMarker("arrow_point")]).toEqual([null, "arrow", "arrowclosed"]);
  });
});

describe("diagram view helpers (ported from Ursula)", () => {
  it("measures the extent of a layout", () => {
    expect(diagramLayoutBounds(layout({ a: [10, 20], b: [200, 300] }))).toEqual({ x: 10, y: 20, width: 290, height: 330 });
    expect(diagramLayoutBounds({ positions: {}, sizes: {} })).toBeNull();
  });

  it("clamps the canvas height and pads the content", () => {
    expect(diagramCanvasHeight(layout({ a: [0, 0] }))).toBe(320);
    expect(diagramCanvasHeight(layout({ a: [0, 0], b: [0, 350] }))).toBe(448);
    expect(diagramCanvasHeight(layout({ a: [0, 0], b: [0, 5000] }))).toBe(560);
    expect(diagramCanvasHeight(layout({ a: [0, 0] }), { min: 0, padding: 0 })).toBe(50);
  });

  it("estimates a height within the same bounds before layout", () => {
    const doc = parseMermaid("flowchart TD\n  a --> b --> c --> d --> e --> f --> g --> h");
    const estimate = estimateDiagramCanvasHeight(doc.graph);
    expect(estimate).toBeGreaterThanOrEqual(320);
    expect(estimate).toBeLessThanOrEqual(560);
    const real = diagramCanvasHeight(ensureDiagramLayout(doc.graph, doc.meta));
    expect(Math.abs(estimate - real)).toBeLessThanOrEqual(240);
  });

  it("blends shared ids, snaps new ones and drops removed ones", () => {
    const from = layout({ a: [0, 0], gone: [5, 5] });
    const to = layout({ a: [100, 200], fresh: [50, 50] }, { width: 200, height: 50 });
    const mid = blendDiagramLayout(from, to, 0.5);
    expect(mid.positions).toEqual({ a: [50, 100], fresh: [50, 50] });
    expect(mid.sizes.a).toEqual({ width: 150, height: 50 });
    expect(blendDiagramLayout(from, to, 1)).toBe(to);
  });

  it("keeps only connected nodes and the groups around them", () => {
    const doc = parseMermaid("flowchart TD\n  subgraph outer\n    subgraph inner\n      a --> b\n    end\n  end\n  subgraph lonely\n    c\n  end\n  d");
    const g = connectedDiagramOnly(doc.graph);
    expect(g.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(g.groups.map((x) => x.id).sort()).toEqual(["inner", "outer"]);
    const full = parseMermaid("flowchart TD\n  a --> b");
    expect(connectedDiagramOnly(full.graph)).toBe(full.graph);
  });
});

describe("DiagramStream", () => {
  it("holds back unconnected nodes and re-lays out only when the structure changes", () => {
    const stream = new DiagramStream();
    expect(stream.update("```mermaid\nflowch").layout).toBeNull();
    const first = stream.update("```mermaid\nflowchart LR\n  A[Start] --> B\n  C");
    expect(first.relaid).toBe(true);
    expect(first.document.graph.nodes.map((n) => n.id)).toEqual(["A", "B"]);
    const label = stream.update("```mermaid\nflowchart LR\n  A[Start here] --> B\n  C");
    expect(label.relaid).toBe(false);
    expect(label.layout).toBe(first.layout);
    const grown = stream.update("```mermaid\nflowchart LR\n  A[Start here] --> B\n  C --> B\n```", true);
    expect(grown.relaid).toBe(true);
    expect(Object.keys(grown.layout!.positions).sort()).toEqual(["A", "B", "C"]);
    stream.reset();
    expect(stream.update("flowchart LR\n  x --> y").relaid).toBe(true);
  });

  it("finds the diagram after a model's prose, before and after the fence closes", () => {
    expect(streamedDiagramText("Here:\n\n```mermaid\nflowchart LR\n  a --> b")).toBe("flowchart LR\n  a --> b");
    expect(streamedDiagramText("Here:\n```mermaid\nflowchart LR\n  a --> b\n```\nMore prose")).toBe("flowchart LR\n  a --> b");
    expect(streamedDiagramText("Here:\n```mermaid\nflowchart LR\n  a --> b\n``")).toBe("flowchart LR\n  a --> b");
    expect(streamedDiagramText("flowchart LR\n  a --> b")).toBe("flowchart LR\n  a --> b");
    const stream = new DiagramStream();
    expect(stream.update("Here is the plan:\n\n```mermaid\nflowchart TD\n  a --> b").document.graph.nodes).toHaveLength(2);
  });
});
