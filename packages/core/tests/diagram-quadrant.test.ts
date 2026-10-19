// @vitest-environment jsdom
// Ported from Ursula (src/quadrant/quadrant.test.ts).
import { describe, expect, it } from "vitest";
import { ensureDiagramLayout } from "../src/canvas/mermaid/layout.js";
import { applyEdit, applyEdits, parseMermaid, serializeMermaid } from "../src/diagram/index.js";
import { registerDiagramAdapter } from "../src/diagram/registry.js";
import { expectValidMermaid, mermaidDb } from "./helpers/mermaid";
import type { DiagramAdapter } from "../src/diagram/types.js";
import {
  POINT_BOX,
  pointPosition,
  positionToData,
  quadrantAdapter,
  quadrantGeometry,
  quadrantSpace,
  spaceInput,
} from "../src/diagram/quadrant/index.js";

registerDiagramAdapter(quadrantAdapter as DiagramAdapter<unknown>);

const SRC = `quadrantChart
  title Feature prioritisation
  x-axis Low effort --> High effort
  y-axis Low impact --> High impact
  quadrant-1 Plan carefully
  quadrant-2 Quick wins
  quadrant-3 Reconsider
  quadrant-4 Fill-ins
  Real-time collaboration: [0.85, 0.9]
  PNG export: [0.2, 0.7]
  Dark mode: [0.3, 0.45]
  Template gallery: [0.4, 0.8]
  Comments: [0.6, 0.55]
`;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface MermaidText {
  text: string;
  x: number;
  y: number;
  horizontalPos: string;
  verticalPos: string;
  rotation: number;
}
interface QuadrantData {
  points: { x: number; y: number; radius: number; fill: string; text: MermaidText }[];
  quadrants: (Box & { text: MermaidText })[];
  axisLabels: MermaidText[];
  borderLines: { x1: number; y1: number; x2: number; y2: number; strokeWidth: number }[];
  title?: MermaidText;
}

/** Mermaid's points converted back to 0–1 coordinates, keyed by label. */
const mermaidPoints = async (src: string) => {
  const db = await mermaidDb<{ getQuadrantData: () => QuadrantData }>(src);
  const data = db.getQuadrantData();
  const left = Math.min(...data.quadrants.map((q) => q.x));
  const top = Math.min(...data.quadrants.map((q) => q.y));
  const right = Math.max(...data.quadrants.map((q) => q.x + q.width));
  const bottom = Math.max(...data.quadrants.map((q) => q.y + q.height));
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    title: data.title?.text,
    quadrants: data.quadrants.map((q) => q.text.text),
    points: Object.fromEntries(
      data.points.map((p) => [
        p.text.text,
        [r((p.x - left) / (right - left)), r(1 - (p.y - top) / (bottom - top))],
      ]),
    ),
  };
};

const ursulaPoints = (src: string) =>
  Object.fromEntries(parseMermaid(src).graph.nodes.map((n) => [n.label, [n.data?.x, n.data?.y]]));

describe("quadrant adapter", () => {
  it("round-trips untouched", () => {
    const doc = parseMermaid(SRC);
    expect(doc.family).toBe("quadrant");
    expect(doc.tier).toBe("editable");
    expect(serializeMermaid(doc)).toBe(SRC);
  });

  it("builds points, locked quadrants and axis data", async () => {
    const { graph } = parseMermaid(SRC);
    expect(graph.title).toBe("Feature prioritisation");
    expect(graph.edges).toEqual([]);
    expect(graph.groups.map((g) => [g.id, g.label, g.data?.locked])).toEqual([
      ["quadrant-1", "Plan carefully", true],
      ["quadrant-2", "Quick wins", true],
      ["quadrant-3", "Reconsider", true],
      ["quadrant-4", "Fill-ins", true],
    ]);
    expect(graph.nodes.map((n) => [n.id, n.parentId, n.data?.x, n.data?.y])).toEqual([
      ["Real_time_collaboration", "quadrant-1", 0.85, 0.9],
      ["PNG_export", "quadrant-2", 0.2, 0.7],
      ["Dark_mode", "quadrant-3", 0.3, 0.45],
      ["Template_gallery", "quadrant-2", 0.4, 0.8],
      ["Comments", "quadrant-1", 0.6, 0.55],
    ]);
    expect(graph.nodes[2]!.data?.details).toEqual(["0.3, 0.45"]);
    expect(graph.data).toEqual({
      xAxisLeft: "Low effort",
      xAxisRight: "High effort",
      yAxisBottom: "Low impact",
      yAxisTop: "High impact",
    });
    const mermaid = await mermaidPoints(SRC);
    expect(mermaid.points).toEqual(ursulaPoints(SRC));
    expect(mermaid.title).toBe("Feature prioritisation");
  });

  it("parses styling, classes and quoted labels", () => {
    const src = `quadrantChart
  A: [0.3, 0.6] radius: 10, color: #ff0000
  B:::cls: [0.1, 0.2]
  "C: quoted": [1, 0]
  classDef cls color: #00ff00, radius: 5
`;
    const doc = parseMermaid(src);
    expect(serializeMermaid(doc)).toBe(src);
    expect(
      doc.graph.nodes.map((n) => [n.id, n.label, n.classes, n.data?.radius, n.data?.color]),
    ).toEqual([
      ["A", "A", [], 10, "#ff0000"],
      ["B", "B", ["cls"], undefined, undefined],
      ["C_quoted", "C: quoted", [], undefined, undefined],
    ]);
    expect(doc.graph.nodes[2]!.parentId).toBe("quadrant-4");
    expect(doc.graph.classDefs).toEqual({ cls: ["color: #00ff00", "radius: 5"] });
    expect(doc.graph.groups[0]!.label).toBe("Quadrant 1");
    // Mermaid draws no label for a quadrant without a `quadrant-N` line.
    expect(doc.graph.groups[0]!.data?.placeholder).toBe(true);
    expect(parseMermaid(SRC).graph.groups.some((g) => g.data?.placeholder)).toBe(false);
    const stroked = parseMermaid(
      "quadrantChart\n  A: [0.3, 0.6] stroke-color: #00ff00, stroke-width: 3px\n",
    );
    expect(stroked.graph.nodes[0]!.data).toMatchObject({
      strokeColor: "#00ff00",
      strokeWidth: "3px",
    });
  });

  it("lays points out from their data on Mermaid's chart, ignoring stored positions", async () => {
    const doc = parseMermaid(SRC);
    const layout = await ensureDiagramLayout(
      doc.graph,
      { v: 1, layout: { Dark_mode: [999, 999] } },
      { family: "quadrant" },
    );
    // Title (40) and x-axis strip (26) above/below, y-axis strip (26) on the left.
    expect(layout.positions["quadrant-2"]).toEqual([31, 45]);
    expect(layout.positions["quadrant-1"]).toEqual([31 + 232, 45]);
    expect(layout.positions["quadrant-3"]).toEqual([31, 45 + 212]);
    expect(layout.sizes["quadrant-4"]).toEqual({ width: 232, height: 212 });
    expect(layout.sizes.Dark_mode).toEqual({ width: POINT_BOX, height: POINT_BOX });
    expect(layout.positions.Dark_mode).toEqual([
      31 + 0.3 * 464 - POINT_BOX / 2,
      45 + 0.55 * 424 - POINT_BOX / 2,
    ]);
  });

  it("matches Mermaid's geometry", async () => {
    const sources = [
      SRC,
      // No points: the x axis moves to the top and quadrant labels are centred.
      "quadrantChart\n  title T\n  x-axis Left\n  y-axis Bottom --> Top\n  quadrant-1 One\n",
      // No title, no axes; class and inline radii.
      "quadrantChart\n  A: [0.1, 0.9] radius: 9\n  B:::big: [0.7, 0.2]\n  classDef big radius: 12, color: #ff0000\n",
    ];
    for (const src of sources) {
      const { graph } = parseMermaid(src);
      const geo = quadrantGeometry(graph);
      const db = await mermaidDb<{ getQuadrantData: () => QuadrantData }>(src);
      const data = db.getQuadrantData();
      expect(geo.quadrants.map((q) => [q.x, q.y, q.width, q.height, q.labelX, q.labelY])).toEqual(
        data.quadrants.map((q) => [q.x, q.y, q.width, q.height, q.text.x, q.text.y]),
      );
      expect(geo.quadrants.map((q) => q.labelBaseline)).toEqual(
        data.quadrants.map((q) => q.text.horizontalPos),
      );
      expect(
        geo.axisLabels.map((l) => [l.text, l.x, l.y, l.rotation, l.anchor === "start"]),
      ).toEqual(
        data.axisLabels.map((l) => [l.text, l.x, l.y, l.rotation, l.verticalPos === "left"]),
      );
      expect(geo.borders.map(({ x1, y1, x2, y2 }) => [x1, y1, x2, y2])).toEqual(
        data.borderLines.map(({ x1, y1, x2, y2 }) => [x1, y1, x2, y2]),
      );
      expect(geo.title && [geo.title.text, geo.title.x, geo.title.y]).toEqual(
        data.title && [data.title.text, data.title.x, data.title.y],
      );
      // Mermaid lists points newest first.
      const points = [...data.points].reverse();
      const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
      expect(geo.points.map((p) => [p.label, r6(p.cx), r6(p.cy), p.radius])).toEqual(
        points.map((p) => [p.text.text, r6(p.x), r6(p.y), p.radius]),
      );
    }
    const classed = quadrantGeometry(parseMermaid(sources[2]!).graph);
    expect(classed.points[1]).toMatchObject({ radius: 12, color: "#ff0000" });
  });

  it("moves points by rewriting their coordinates", async () => {
    const doc = parseMermaid(SRC);
    const space = quadrantSpace(spaceInput(doc.graph));
    const position = pointPosition(0.75, 0.2, space);
    expect(positionToData(position, space)).toEqual({ x: 0.75, y: 0.2 });
    const moved = applyEdit(doc, {
      type: "moveNodes",
      moves: [
        { id: "Dark_mode", position },
        { id: "quadrant-1", position: [5, 5] },
      ],
    });
    expect(moved.source).toContain("  Dark mode: [0.75, 0.2]\n");
    expect(moved.meta.layout ?? {}).toEqual({});
    expect(moved.graph.nodes[2]!.parentId).toBe("quadrant-4");
    await expectValidMermaid(moved.source);

    // Clamped to the chart.
    const out = applyEdit(moved, {
      type: "moveNodes",
      moves: [{ id: "Dark_mode", position: [-500, 900] }],
    });
    expect(out.source).toContain("  Dark mode: [0, 0]\n");

    // Layout pins (positions equal to the data) change nothing.
    const layout = await ensureDiagramLayout(doc.graph, doc.meta, { family: "quadrant" });
    const pinned = applyEdit(doc, {
      type: "moveNodes",
      moves: Object.entries(layout.positions).map(([id, p]) => ({ id, position: p })),
    });
    expect(pinned.source).toBe(SRC);
    expect(
      applyEdit(doc, { type: "setNodeParent", ids: ["Dark_mode"], parentId: "quadrant-1" }).source,
    ).toBe(SRC);
  });

  it("adds, renames, edits and removes points", async () => {
    const doc = parseMermaid(SRC);
    const added = applyEdits(doc, [
      { type: "addNode", node: { id: "point6", label: "Webhooks", data: { x: 0.9, y: 0.1 } } },
      { type: "addNode", node: { id: "point7" } },
    ]);
    expect(added.source).toContain(
      "  Comments: [0.6, 0.55]\n  Webhooks: [0.9, 0.1]\n  New point: [0.5, 0.5]\n",
    );
    expect(added.graph.nodes.at(-2)?.id).toBe("Webhooks");

    const dropped = applyEdit(added, {
      type: "addNode",
      node: { id: "p", label: "Dropped" },
      position: pointPosition(0.25, 0.75, quadrantSpace(spaceInput(added.graph))),
    });
    expect(dropped.source).toContain("  Dropped: [0.25, 0.75]\n");
    expect(dropped.meta.layout ?? {}).toEqual({});

    const renamed = applyEdit(dropped, {
      type: "renameNode",
      id: "PNG_export",
      label: "Export: PNG",
    });
    expect(renamed.source).toContain('  "Export: PNG": [0.2, 0.7]\n');
    expect(renamed.graph.nodes[1]!.id).toBe("Export_PNG");

    const styled = applyEdits(renamed, [
      { type: "setNodeData", id: "Comments", data: { x: 0.65, y: 1 } },
      { type: "setNodeData", id: "Comments", data: { radius: 12 } },
      { type: "setNodeData", id: "Comments", data: { color: "#ff9900" } },
    ]);
    expect(styled.source).toContain("  Comments: [0.65, 1] radius: 12, color: #ff9900\n");
    expect(styled.graph.nodes.find((n) => n.id === "Comments")?.data).toMatchObject({
      x: 0.65,
      y: 1,
      radius: 12,
      color: "#ff9900",
    });
    // Invalid colours are rejected rather than producing invalid Mermaid.
    expect(applyEdit(styled, { type: "setNodeData", id: "Comments", data: { color: "red" } })).toBe(
      styled,
    );
    const unstyled = applyEdits(styled, [
      { type: "setNodeData", id: "Comments", data: { radius: undefined } },
      { type: "setNodeData", id: "Comments", data: { color: "" } },
    ]);
    expect(unstyled.source).toContain("  Comments: [0.65, 1]\n");

    const removed = applyEdit(unstyled, { type: "removeNodes", ids: ["Dark_mode", "New_point"] });
    expect(removed.source).not.toContain("Dark mode");
    expect(removed.source).not.toContain("New point");
    await expectValidMermaid(removed.source);
    expect((await mermaidPoints(removed.source)).points).toEqual(ursulaPoints(removed.source));
  });

  it("renames quadrants, axes and the title", async () => {
    const doc = parseMermaid("quadrantChart\n  A: [0.2, 0.3]\n");
    const next = applyEdits(doc, [
      { type: "setTitle", title: "Risks" },
      { type: "setGraphData", data: { xAxisLeft: "Unlikely", xAxisRight: "Likely" } },
      { type: "setGraphData", data: { yAxisBottom: "Minor" } },
      { type: "renameGroup", id: "quadrant-2", label: "Watch" },
    ]);
    expect(next.source).toBe(
      "quadrantChart\n  title Risks\n  x-axis Unlikely --> Likely\n  y-axis Minor\n  quadrant-2 Watch\n  A: [0.2, 0.3]\n",
    );
    expect(next.graph.groups[1]!.label).toBe("Watch");
    expect(next.graph.data?.yAxisTop).toBe("");
    await expectValidMermaid(next.source);
    const mermaid = await mermaidPoints(next.source);
    expect(mermaid.title).toBe("Risks");
    expect(mermaid.quadrants).toContain("Watch");

    const edited = applyEdits(parseMermaid(SRC), [
      { type: "renameGroup", id: "quadrant-1", label: "Big bets" },
      { type: "renameGroup", id: "quadrant-4", label: "" },
      { type: "setGraphData", data: { xAxisRight: "" } },
      { type: "setGraphData", data: { yAxisBottom: "", yAxisTop: "" } },
      { type: "setTitle", title: undefined },
    ]);
    expect(edited.source).toBe(`quadrantChart
  x-axis Low effort
  quadrant-1 Big bets
  quadrant-2 Quick wins
  quadrant-3 Reconsider
  Real-time collaboration: [0.85, 0.9]
  PNG export: [0.2, 0.7]
  Dark mode: [0.3, 0.45]
  Template gallery: [0.4, 0.8]
  Comments: [0.6, 0.55]
`);
    expect(edited.graph.groups[3]!.label).toBe("Quadrant 4");
    await expectValidMermaid(edited.source);
    expect(applyEdit(edited, { type: "renameGroup", id: "nope", label: "x" })).toBe(edited);
  });

  it("rejects edge and grouping ops", () => {
    const doc = parseMermaid(SRC);
    expect(
      applyEdit(doc, { type: "addEdge", edge: { source: "Comments", target: "Dark_mode" } }),
    ).toBe(doc);
    expect(
      applyEdit(doc, { type: "groupNodes", groupId: "g", label: "G", nodeIds: ["Comments"] }),
    ).toBe(doc);
    expect(applyEdit(doc, { type: "setNodeShape", id: "Comments", shape: "rect" })).toBe(doc);
  });

  it("keeps unknown lines verbatim", () => {
    const src =
      "quadrantChart\n  accTitle: Accessible\n  %% note\n  something odd\n  A: [0.1, 0.2]\n";
    const next = applyEdit(parseMermaid(src), { type: "setNodeData", id: "A", data: { x: 0.4 } });
    expect(next.source).toBe(
      "quadrantChart\n  accTitle: Accessible\n  %% note\n  something odd\n  A: [0.4, 0.2]\n",
    );
  });
});
