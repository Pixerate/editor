// @vitest-environment jsdom
// Ported from Ursula (src/mindmap/mindmap.test.ts).
import { describe, expect, it } from "vitest";
import { applyEdit, applyEdits, parseMermaid, serializeMermaid } from "../src/diagram/index.js";
import { registerDiagramAdapter } from "../src/diagram/registry.js";
import { ensureDiagramLayout } from "../src/canvas/mermaid/layout.js";
import { expectValidMermaid, mermaidDb } from "./helpers/mermaid";
import type { DiagramAdapter } from "../src/diagram/types.js";
import { dropTarget, mindmapGeometry, shapeSize } from "../src/diagram/mindmap/geometry.js";
import { mindmapAdapter } from "../src/diagram/mindmap/index.js";

registerDiagramAdapter(mindmapAdapter as DiagramAdapter<unknown>);

const SRC = `mindmap
  root((Generative Diagrams))
    Authoring
      Canvas editing
      Source editing
      Templates
    Rendering
      Thumbnails
      Live preview
      Export to SVG/PNG
    Portability
      Mermaid round-trip
      Layout metadata
    Audiences
      Product teams
      Architects
      Analysts
`;

interface MermaidMindmapNode {
  descr: string;
  children: MermaidMindmapNode[];
}
type LabelTree = [string, LabelTree[]];

const mermaidTree = async (src: string): Promise<LabelTree> => {
  const db = await mermaidDb<{ getMindmap: () => MermaidMindmapNode }>(src);
  const walk = (n: MermaidMindmapNode): LabelTree => [n.descr, n.children.map(walk)];
  return walk(db.getMindmap());
};

const ursulaTree = (src: string): LabelTree => {
  const { graph } = parseMermaid(src);
  const label = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const children = (id: string): LabelTree[] =>
    graph.edges
      .filter((e) => e.source === id)
      .map((e) => [label.get(e.target)!, children(e.target)]);
  const root = graph.nodes.find((n) => !graph.edges.some((e) => e.target === n.id))!;
  return [root.label, children(root.id)];
};

describe("mindmap adapter", () => {
  it("round-trips untouched", () => {
    const doc = parseMermaid(SRC);
    expect(doc.family).toBe("mindmap");
    expect(doc.tier).toBe("editable");
    expect(serializeMermaid(doc)).toBe(SRC);
  });

  it("builds the topic tree", async () => {
    const { graph } = parseMermaid(SRC);
    expect(graph.direction).toBe("LR");
    expect(graph.groups).toEqual([]);
    expect(graph.nodes).toHaveLength(16);
    const root = graph.nodes[0]!;
    expect([root.id, root.label, root.shape, root.data?.form, root.data?.explicitId]).toEqual([
      "root",
      "Generative Diagrams",
      "circle",
      "circle",
      true,
    ]);
    const canvas = graph.nodes.find((n) => n.label === "Canvas editing")!;
    expect([canvas.id, canvas.shape, canvas.data?.form]).toEqual([
      "Canvas_editing",
      "text",
      "default",
    ]);
    const edge = graph.edges.find((e) => e.target === "Canvas_editing")!;
    expect(edge).toMatchObject({
      id: "L_Authoring_Canvas_editing_0",
      source: "Authoring",
      pattern: "solid",
      arrowEnd: "none",
      data: { tree: true },
    });
    expect(ursulaTree(SRC)).toEqual(await mermaidTree(SRC));
  });

  it("parses every bracket form, explicit ids and decorations", async () => {
    const src = `mindmap
  root((Hub))
    A[Square]
      ::icon(fa fa-book)
    b))Bang((
      :::urgent big
    )Cloud(
    {{Hex}}
    (Rounded)
    q["Quoted (label)"]
`;
    const { graph } = parseMermaid(src);
    expect(graph.nodes.map((n) => [n.id, n.label, n.shape, n.data?.form])).toEqual([
      ["root", "Hub", "circle", "circle"],
      ["A", "Square", "rect", "square"],
      ["b", "Bang", "odd", "bang"],
      ["Cloud", "Cloud", "stadium", "cloud"],
      ["Hex", "Hex", "hex", "hexagon"],
      ["Rounded", "Rounded", "rounded", "rounded"],
      ["q", "Quoted (label)", "rect", "square"],
    ]);
    expect(graph.nodes[1]!.data?.icon).toBe("fa fa-book");
    expect(graph.nodes[1]!.data?.details).toEqual(["fa fa-book"]);
    expect(graph.nodes[2]!.classes).toEqual(["urgent", "big"]);
    expect(serializeMermaid(parseMermaid(src))).toBe(src);
    expect(ursulaTree(src)).toEqual(await mermaidTree(src));
  });

  it("adds topics as the last child of the parent", async () => {
    const doc = parseMermaid(SRC);
    const added = applyEdit(doc, {
      type: "addNode",
      node: { id: "topic17", label: "Comments", parentId: "Authoring" },
      position: [10, 20],
    });
    expect(added.source).toContain("      Templates\n      Comments\n    Rendering\n");
    // Positions are derived from the tree: the drop position is not stored.
    expect(added.meta.layout?.Comments).toBeUndefined();
    expect(added.graph.edges.some((e) => e.id === "L_Authoring_Comments_0")).toBe(true);

    const underRoot = applyEdit(added, { type: "addNode", node: { id: "x", shape: "hex" } });
    expect(underRoot.source).toContain("      Analysts\n    {{New topic}}\n");

    // A colliding label gets an explicit id so the existing topic keeps its own.
    const dup = applyEdit(underRoot, {
      type: "addNode",
      node: { id: "y", label: "Templates", parentId: "root" },
    });
    expect(dup.source).toContain("    {{New topic}}\n    Templates_2(Templates)\n");
    expect(dup.graph.nodes.find((n) => n.label === "Templates" && !n.data?.explicitId)?.id).toBe(
      "Templates",
    );
    await expectValidMermaid(dup.source);
    expect(ursulaTree(dup.source)).toEqual(await mermaidTree(dup.source));
  });

  it("renames topics, moving metadata with derived ids", async () => {
    const doc = applyEdits(parseMermaid(SRC), [
      { type: "resizeNode", id: "Templates", size: [1, 2] },
      { type: "resizeNode", id: "root", size: [3, 4] },
    ]);
    const renamed = applyEdits(doc, [
      { type: "renameNode", id: "Templates", label: "Starter kits" },
      { type: "renameNode", id: "root", label: "the diagram module" },
    ]);
    expect(renamed.source).toContain("  root((the diagram module))\n");
    expect(renamed.source).toContain("      Starter kits\n");
    expect(renamed.meta.sizes?.Starter_kits).toEqual([1, 2]);
    expect(renamed.meta.sizes?.root).toEqual([3, 4]);
    await expectValidMermaid(renamed.source);
  });

  it("changes bracket forms", async () => {
    const doc = parseMermaid(SRC);
    const next = applyEdits(doc, [
      { type: "setNodeShape", id: "Authoring", shape: "rect" },
      { type: "setNodeShape", id: "Rendering", shape: "odd" },
      { type: "setNodeShape", id: "Portability", shape: "stadium" },
      { type: "setNodeShape", id: "Audiences", shape: "rounded" },
      { type: "setNodeShape", id: "Thumbnails", shape: "circle" },
      { type: "setNodeShape", id: "Templates", shape: "hex" },
    ]);
    expect(next.source).toContain("    [Authoring]\n");
    expect(next.source).toContain("    ))Rendering((\n");
    expect(next.source).toContain("    )Portability(\n");
    expect(next.source).toContain("    (Audiences)\n"); // the default form is `text`
    expect(next.source).toContain("      ((Thumbnails))\n");
    expect(next.source).toContain("      {{Templates}}\n");
    await expectValidMermaid(next.source);
    expect(next.graph.nodes.find((n) => n.id === "Rendering")?.shape).toBe("odd");

    const plain = applyEdit(next, { type: "setNodeShape", id: "Authoring", shape: "text" });
    expect(plain.source).toContain("    Authoring\n");
    const rootPlain = applyEdit(
      applyEdit(parseMermaid(SRC), { type: "resizeNode", id: "root", size: [5, 5] }),
      { type: "setNodeShape", id: "root", shape: "text" },
    );
    expect(rootPlain.source).toContain("  Generative Diagrams\n");
    expect(rootPlain.meta.sizes?.Generative_Diagrams).toEqual([5, 5]);
  });

  it("removes a topic with its subtree and decorations", async () => {
    const src = `mindmap
  root((Hub))
    A
      ::icon(fa fa-book)
      A1
        :::hot
      A2
    B
`;
    const next = applyEdit(parseMermaid(src), { type: "removeNodes", ids: ["A"] });
    expect(next.source).toBe("mindmap\n  root((Hub))\n    B\n");
    expect(next.graph.nodes.map((n) => n.id)).toEqual(["root", "B"]);
    await expectValidMermaid(next.source);
    expect(applyEdit(next, { type: "removeNodes", ids: ["nope"] })).toBe(next);
  });

  it("re-parents with addEdge and reconnectEdge, re-indenting the subtree", async () => {
    const doc = parseMermaid(SRC);
    const moved = applyEdit(doc, {
      type: "addEdge",
      edge: { source: "Audiences", target: "Rendering" },
    });
    expect(moved.source).toContain(
      "    Audiences\n      Product teams\n      Architects\n      Analysts\n      Rendering\n        Thumbnails\n        Live preview\n        Export to SVG/PNG\n",
    );
    expect(moved.graph.edges.some((e) => e.id === "L_Audiences_Rendering_0")).toBe(true);
    await expectValidMermaid(moved.source);
    expect(ursulaTree(moved.source)).toEqual(await mermaidTree(moved.source));

    const back = applyEdit(moved, {
      type: "reconnectEdge",
      id: "L_Audiences_Rendering_0",
      source: "root",
      target: "Rendering",
    });
    expect(back.source).toContain("      Analysts\n    Rendering\n      Thumbnails\n");
    await expectValidMermaid(back.source);

    // Cycles and no-ops are rejected.
    expect(
      applyEdit(doc, { type: "addEdge", edge: { source: "Thumbnails", target: "Rendering" } }),
    ).toBe(doc);
    expect(
      applyEdit(doc, { type: "addEdge", edge: { source: "Rendering", target: "Thumbnails" } }),
    ).toBe(doc);
    expect(applyEdit(doc, { type: "removeEdges", ids: ["L_Rendering_Thumbnails_0"] })).toBe(doc);
  });

  it("re-indents with the document's own unit", () => {
    const src = "mindmap\n\troot\n\t\tA\n\t\t\tA1\n\t\tB\n";
    const next = applyEdit(parseMermaid(src), {
      type: "addEdge",
      edge: { source: "B", target: "A" },
    });
    expect(next.source).toBe("mindmap\n\troot\n\t\tB\n\t\t\tA\n\t\t\t\tA1\n");
  });

  it("writes, updates and removes icons", async () => {
    const doc = parseMermaid(SRC);
    const withIcon = applyEdit(doc, {
      type: "setNodeData",
      id: "Authoring",
      data: { icon: "fa fa-pen" },
    });
    expect(withIcon.source).toContain(
      "    Authoring\n      ::icon(fa fa-pen)\n      Canvas editing\n",
    );
    expect(withIcon.graph.nodes.find((n) => n.id === "Authoring")?.data?.icon).toBe("fa fa-pen");
    await expectValidMermaid(withIcon.source);

    const changed = applyEdit(withIcon, {
      type: "setNodeData",
      id: "Authoring",
      data: { icon: "fa fa-book" },
    });
    expect(changed.source).toContain("      ::icon(fa fa-book)\n");
    const cleared = applyEdit(changed, {
      type: "setNodeData",
      id: "Authoring",
      data: { icon: "" },
    });
    expect(cleared.source).toBe(SRC);

    // The icon travels with its topic.
    const moved = applyEdit(withIcon, {
      type: "addEdge",
      edge: { source: "Audiences", target: "Authoring" },
    });
    expect(moved.source).toContain(
      "      Analysts\n      Authoring\n        ::icon(fa fa-pen)\n        Canvas editing\n",
    );
    await expectValidMermaid(moved.source);
  });

  it("keeps several roots, comments and unknown lines", () => {
    const src = "mindmap\n  %% a comment\n  One\n\n  Two\n    Child\n";
    const doc = parseMermaid(src);
    expect(serializeMermaid(doc)).toBe(src);
    expect(doc.graph.nodes.map((n) => n.id)).toEqual(["One", "Two", "Child"]);
    expect(doc.diagnostics.some((d) => d.severity === "warning")).toBe(true);
    const next = applyEdit(doc, { type: "renameNode", id: "Child", label: "Kid" });
    expect(next.source).toBe("mindmap\n  %% a comment\n  One\n\n  Two\n    Kid\n");
  });

  it("uses the frontmatter for the title", async () => {
    const next = applyEdit(parseMermaid(SRC), { type: "setTitle", title: "Map" });
    expect(next.source.startsWith("---\ntitle: Map\n---\nmindmap\n")).toBe(true);
    expect(next.graph.title).toBe("Map");
    await expectValidMermaid(next.source);
  });

  it("lays topics out around the root without overlaps", async () => {
    const doc = parseMermaid(SRC);
    const geo = mindmapGeometry(doc.graph);
    const topics = [...geo.topics.values()];
    expect(geo.topics.get("root")).toMatchObject({ x: 0, y: 0, depth: 0, section: -1 });
    // Sections follow the top-level branch, like Mermaid's `assignSections`.
    expect(
      ["Authoring", "Rendering", "Portability", "Audiences"].map(
        (id) => geo.topics.get(id)!.section,
      ),
    ).toEqual([0, 1, 2, 3]);
    expect(geo.topics.get("Live_preview")!.section).toBe(1);
    for (let i = 0; i < topics.length; i++)
      for (let j = i + 1; j < topics.length; j++) {
        const a = topics[i]!;
        const b = topics[j]!;
        const apart =
          Math.abs(a.x - b.x) >= (a.width + b.width) / 2 ||
          Math.abs(a.y - b.y) >= (a.height + b.height) / 2;
        expect(apart, `${a.id} / ${b.id}`).toBe(true);
      }
    // Branches spread all around the root.
    const quadrants = new Set(
      ["Authoring", "Rendering", "Portability", "Audiences"].map((id) => {
        const t = geo.topics.get(id)!;
        return `${Math.sign(t.x)}${Math.sign(t.y)}`;
      }),
    );
    expect(quadrants.size).toBe(4);
    // The layout uses the geometry and ignores stored positions.
    const layout = await ensureDiagramLayout(
      doc.graph,
      { v: 1, layout: { root: [500, 500] } },
      { family: "mindmap" },
    );
    const root = geo.topics.get("root")!;
    expect(layout.positions.root).toEqual([-root.width / 2, -root.height / 2]);
  });

  it("sizes shapes like Mermaid's mindmap shapes", () => {
    expect(shapeSize("default", 100, 24)).toEqual({ width: 140, height: 34 });
    expect(shapeSize("rounded", 100, 24)).toEqual({ width: 130, height: 54 });
    expect(shapeSize("square", 100, 24)).toEqual({ width: 140, height: 44 });
    expect(shapeSize("hexagon", 100, 24)).toEqual({ width: 142, height: 44 });
    expect(shapeSize("circle", 30, 40).width).toBe(70);
  });

  it("re-parents a topic dropped onto another topic, and stores no positions", async () => {
    const doc = parseMermaid(SRC);
    const geo = mindmapGeometry(doc.graph);
    const target = geo.topics.get("Audiences")!;
    const moved = geo.topics.get("Templates")!;
    const dropAt = (t: typeof target, m: typeof moved): [number, number] => [
      t.x - m.width / 2 + 5,
      t.y - m.height / 2,
    ];
    expect(dropTarget(geo, "Templates", [target.x, target.y])).toBe("Audiences");
    // Never onto itself or its own subtree.
    expect(dropTarget(geo, "Authoring", [moved.x, moved.y])).toBeUndefined();

    const next = applyEdit(doc, {
      type: "moveNodes",
      moves: [{ id: "Templates", position: dropAt(target, moved) }],
    });
    expect(next.source).toContain("      Analysts\n      Templates\n");
    expect(next.meta.layout?.Templates).toBeUndefined();
    await expectValidMermaid(next.source);
    expect(ursulaTree(next.source)).toEqual(await mermaidTree(next.source));

    // Dropped on empty canvas, or left where the layout has it (a layout pin): nothing changes.
    const nowhere = applyEdit(doc, {
      type: "moveNodes",
      moves: [
        { id: "Templates", position: [5000, 5000] },
        {
          id: "Thumbnails",
          position: [
            geo.topics.get("Thumbnails")!.x - geo.topics.get("Thumbnails")!.width / 2,
            geo.topics.get("Thumbnails")!.y - geo.topics.get("Thumbnails")!.height / 2,
          ],
        },
      ],
    });
    expect(nowhere.source).toBe(SRC);
    expect(nowhere.meta.layout ?? {}).toEqual({});
  });
});
