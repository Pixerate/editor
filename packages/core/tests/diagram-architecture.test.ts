// @vitest-environment jsdom
// Ported from Ursula (src/architecture/architecture.test.ts).
import { describe, expect, it } from "vitest";
import { applyEdit, applyEdits, parseMermaid, serializeMermaid } from "../src/diagram/index.js";
import { registerDiagramAdapter } from "../src/diagram/registry.js";
import { expectValidMermaid, mermaidDb } from "./helpers/mermaid";
import type { DiagramAdapter } from "../src/diagram/types.js";
import { ensureDiagramLayout } from "../src/canvas/mermaid/layout.js";
import {
  ARCH_METRICS,
  architectureArrow,
  architectureEdgeRoute,
  architectureLayout,
  sideOffset,
} from "../src/diagram/architecture/geometry.js";
import { architectureAdapter } from "../src/diagram/architecture/index.js";

registerDiagramAdapter(architectureAdapter as DiagramAdapter<unknown>);

const SRC = `architecture-beta
  group api(cloud)[API tier]
  service db(database)[Postgres] in api
  service cache(disk)[Redis] in api
  service server(server)[App server] in api
  service gateway(internet)[Gateway]
  gateway:R --> L:server
  server:B --> T:db
  server:R --> L:cache
`;

interface ArchDb {
  getServices: () => { id: string; icon?: string; title?: string; in?: string }[];
  getJunctions: () => { id: string; in?: string }[];
  getGroups: () => { id: string; icon?: string; title?: string; in?: string }[];
  getEdges: () => {
    lhsId: string;
    lhsDir: string;
    rhsId: string;
    rhsDir: string;
    lhsInto?: boolean;
    rhsInto?: boolean;
    title?: string;
  }[];
}

describe("architecture adapter", () => {
  it("round-trips untouched", () => {
    const doc = parseMermaid(SRC);
    expect(doc.family).toBe("architecture");
    expect(doc.tier).toBe("editable");
    expect(serializeMermaid(doc)).toBe(SRC);
  });

  it("builds services, groups and sided edges", async () => {
    const doc = parseMermaid(SRC);
    expect(doc.graph.groups).toMatchObject([
      { id: "api", label: "API tier", data: { icon: "cloud" } },
    ]);
    expect(doc.graph.nodes.map((n) => [n.id, n.label, n.shape, n.parentId, n.data?.icon])).toEqual([
      ["db", "Postgres", "arch-service", "api", "database"],
      ["cache", "Redis", "arch-service", "api", "disk"],
      ["server", "App server", "arch-service", "api", "server"],
      ["gateway", "Gateway", "arch-service", undefined, "internet"],
    ]);
    expect(doc.graph.nodes[0]!.data?.details).toEqual(["database"]);
    expect(doc.graph.edges[0]).toMatchObject({
      id: "L_gateway_server_0",
      arrowStart: "none",
      arrowEnd: "arrow_point",
      data: { sourceSide: "R", targetSide: "L", sourceGroup: false, targetGroup: false },
    });
    const db = await mermaidDb<ArchDb>(SRC);
    expect(db.getServices().map((s) => [s.id, s.title, s.in])).toEqual(
      doc.graph.nodes.map((n) => [n.id, n.label, n.parentId]),
    );
    expect(db.getGroups().map((g) => g.id)).toEqual(["api"]);
    expect(db.getEdges().map((e) => `${e.lhsId}:${e.lhsDir}>${e.rhsDir}:${e.rhsId}`)).toEqual(
      doc.graph.edges.map(
        (e) => `${e.source}:${e.data?.sourceSide}>${e.data?.targetSide}:${e.target}`,
      ),
    );
  });

  it("adds services and junctions", async () => {
    const doc = parseMermaid(SRC);
    const next = applyEdits(doc, [
      { type: "addNode", node: { id: "svc5", label: "Queue", parentId: "api" }, position: [1, 2] },
      { type: "addNode", node: { id: "db", label: "Replica", data: { icon: "database" } } },
      { type: "addNode", node: { id: "j", shape: "sm-circ" } },
    ]);
    expect(next.source).toContain(
      "  service gateway(internet)[Gateway]\n  service svc5(server)[Queue] in api\n  service db_2(database)[Replica]\n  junction j\n  gateway:R",
    );
    expect(next.meta.layout?.svc5).toEqual([1, 2]);
    expect(next.graph.nodes.find((n) => n.id === "j")).toMatchObject({
      shape: "sm-circ",
      label: "",
      data: { junction: true },
    });
    await expectValidMermaid(next.source);
    const db = await mermaidDb<ArchDb>(next.source);
    expect(db.getJunctions().map((j) => j.id)).toEqual(["j"]);
  });

  it("renames, re-icons, reshapes and reparents nodes", async () => {
    const doc = parseMermaid(SRC);
    const next = applyEdits(doc, [
      { type: "renameNode", id: "cache", label: "Valkey" },
      { type: "setNodeData", id: "cache", data: { icon: "database" } },
      { type: "setNodeParent", ids: ["gateway"], parentId: "api" },
      { type: "setNodeParent", ids: ["db"] },
    ]);
    expect(next.source).toContain("  service db(database)[Postgres]\n");
    expect(next.source).toContain("  service cache(database)[Valkey] in api\n");
    expect(next.source).toContain("  service gateway(internet)[Gateway] in api\n");
    await expectValidMermaid(next.source);

    const junction = applyEdit(next, { type: "setNodeShape", id: "cache", shape: "sm-circ" });
    expect(junction.source).toContain("  junction cache in api\n");
    expect(applyEdit(junction, { type: "renameNode", id: "cache", label: "x" })).toBe(junction);
    const back = applyEdit(junction, { type: "setNodeShape", id: "cache", shape: "arch-service" });
    expect(back.source).toContain("  service cache(server)[cache] in api\n");
    await expectValidMermaid(back.source);
  });

  it("removes nodes with their edges", async () => {
    const next = applyEdit(parseMermaid(SRC), { type: "removeNodes", ids: ["server"] });
    expect(next.source).toBe(`architecture-beta
  group api(cloud)[API tier]
  service db(database)[Postgres] in api
  service cache(disk)[Redis] in api
  service gateway(internet)[Gateway]
`);
    await expectValidMermaid(next.source);
    const dissolved = applyEdit(parseMermaid(SRC), { type: "removeNodes", ids: ["api"] });
    expect(dissolved.source).not.toContain(" in api");
    expect(dissolved.graph.groups).toEqual([]);
    await expectValidMermaid(dissolved.source);
  });

  it("adds, restyles, re-sides, relabels, reconnects and removes edges", async () => {
    const doc = applyEdits(parseMermaid(SRC), [
      {
        type: "moveNodes",
        moves: [
          { id: "db", position: [0, 0] },
          { id: "gateway", position: [0, 200] },
        ],
      },
    ]);
    const added = applyEdits(doc, [
      { type: "addEdge", edge: { source: "db", target: "cache" } },
      { type: "addEdge", edge: { source: "gateway", target: "db" } },
      {
        type: "addEdge",
        edge: {
          source: "cache",
          target: "gateway",
          arrowEnd: "none",
          data: { sourceSide: "T", targetSide: "B" },
        },
      },
    ]);
    expect(added.source).toContain(
      "  server:R --> L:cache\n  db:R --> L:cache\n  gateway:T --> B:db\n  cache:T -- B:gateway\n",
    );
    await expectValidMermaid(added.source);

    const edited = applyEdits(added, [
      { type: "setEdgeStyle", id: "L_db_cache_0", arrowStart: "arrow_point" },
      { type: "setEdgeStyle", id: "L_server_db_0", arrowEnd: "none" },
      { type: "setEdgeData", id: "L_gateway_server_0", data: { sourceSide: "B", targetSide: "T" } },
      { type: "setEdgeLabel", id: "L_server_cache_0", label: "reads" },
    ]);
    expect(edited.source).toContain("  db:R <--> L:cache\n");
    expect(edited.source).toContain("  server:B -- T:db\n");
    expect(edited.source).toContain("  gateway:B --> T:server\n");
    expect(edited.source).toContain("  server:R -[reads]-> L:cache\n");
    await expectValidMermaid(edited.source);
    const db = await mermaidDb<ArchDb>(edited.source);
    const reads = db.getEdges().find((e) => e.lhsId === "server" && e.rhsId === "cache")!;
    expect(reads.title).toBe("reads");
    expect(edited.graph.edges.find((e) => e.id === "L_server_cache_0")!.label).toBe("reads");

    const moved = applyEdit(edited, {
      type: "reconnectEdge",
      id: "L_db_cache_0",
      source: "gateway",
      target: "cache",
    });
    expect(moved.source).toContain("  gateway:R <--> L:cache\n");
    const removed = applyEdit(moved, { type: "removeEdges", ids: ["L_gateway_cache_0"] });
    expect(removed.source).not.toContain("gateway:R <--> L:cache");
    expect(removed.graph.edges).toHaveLength(5);
    await expectValidMermaid(removed.source);
  });

  it("groups, renames and ungroups", async () => {
    const doc = parseMermaid(SRC);
    const grouped = applyEdit(doc, {
      type: "groupNodes",
      groupId: "data",
      label: "Data",
      nodeIds: ["db", "cache"],
    });
    expect(grouped.source).toContain(`  group api(cloud)[API tier]
  group data(cloud)[Data] in api
  service db(database)[Postgres] in data
  service cache(disk)[Redis] in data
`);
    expect(grouped.graph.groups.find((g) => g.id === "data")!.parentId).toBe("api");
    await expectValidMermaid(grouped.source);
    const db = await mermaidDb<ArchDb>(grouped.source);
    expect(db.getGroups().map((g) => [g.id, g.in])).toEqual([
      ["api", undefined],
      ["data", "api"],
    ]);

    const renamed = applyEdit(grouped, { type: "renameGroup", id: "data", label: "Storage" });
    expect(renamed.source).toContain("group data(cloud)[Storage] in api");
    expect(applyEdit(renamed, { type: "setNodeParent", ids: ["api"], parentId: "data" })).toBe(
      renamed,
    );

    const ungrouped = applyEdit(renamed, { type: "ungroup", groupId: "data" });
    expect(ungrouped.source).toBe(SRC);
  });

  it("edits a title statement or falls back to frontmatter", async () => {
    const withTitle = parseMermaid("architecture-beta\n  title Infra\n  service a(server)[A]\n");
    expect(withTitle.graph.title).toBe("Infra");
    const next = applyEdit(withTitle, { type: "setTitle", title: "Platform" });
    expect(next.source).toBe("architecture-beta\n  title Platform\n  service a(server)[A]\n");
    await expectValidMermaid(next.source);
    const fm = applyEdit(parseMermaid(SRC), { type: "setTitle", title: "Stack" });
    expect(fm.source.startsWith("---\ntitle: Stack\n---\narchitecture-beta\n")).toBe(true);
    expect(fm.graph.title).toBe("Stack");
    await expectValidMermaid(fm.source);
  });

  it("keeps unknown lines and icon names verbatim", async () => {
    const src = `architecture-beta
  accTitle: Infra
  %% note
  service fn(logos:aws-lambda)[Lambda]
  service bare
  something we do not model
`;
    const doc = parseMermaid(src);
    expect(serializeMermaid(doc)).toBe(src);
    expect(doc.graph.nodes.map((n) => [n.id, n.label, n.data?.icon])).toEqual([
      ["fn", "Lambda", "logos:aws-lambda"],
      ["bare", "bare", undefined],
    ]);
    const next = applyEdit(doc, { type: "renameNode", id: "fn", label: "Function" });
    expect(next.source).toBe(src.replace("[Lambda]", "[Function]"));
  });

  it("marks declarations without a label (Mermaid draws none)", () => {
    const doc = parseMermaid("architecture-beta\n  group g\n  service a(server) in g\n");
    expect(doc.graph.groups[0]!.data?.untitled).toBe(true);
    expect(doc.graph.nodes[0]!.data?.untitled).toBe(true);
    expect(parseMermaid(SRC).graph.nodes[0]!.data?.untitled).toBeUndefined();
  });

  it("draws new edges from the sides that face each other in the layout", () => {
    const doc = parseMermaid(SRC);
    const next = applyEdit(doc, { type: "addEdge", edge: { source: "db", target: "gateway" } });
    // db sits below-right of the gateway: it connects from its left side.
    expect(next.source).toContain("db:L --> R:gateway");
  });
});

describe("architecture geometry", () => {
  const A = ARCH_METRICS;
  const centre = (l: ReturnType<typeof architectureLayout>, id: string) => {
    const [x, y] = l.positions[id]!;
    const { width, height } = l.sizes[id]!;
    return [x + width / 2, y + height / 2] as const;
  };

  it("places targets in the direction of the ports", () => {
    expect(sideOffset("R", "L")).toEqual([1, 0]);
    expect(sideOffset("L", "R")).toEqual([-1, 0]);
    expect(sideOffset("B", "T")).toEqual([0, 1]);
    expect(sideOffset("T", "B")).toEqual([0, -1]);
    expect(sideOffset("R", "T")).toEqual([1, 1]);
    expect(sideOffset("T", "L")).toEqual([1, -1]);
    const doc = parseMermaid(`architecture-beta
  service a(server)[A]
  service b(database)[B]
  service c(disk)[C]
  a:R --> L:b
  c:T -- B:a
`);
    const l = architectureLayout(doc.graph);
    const [ax, ay] = centre(l, "a");
    const [bx, by] = centre(l, "b");
    const [cx, cy] = centre(l, "c");
    expect(by).toBe(ay);
    expect(bx).toBeGreaterThan(ax);
    expect(cx).toBe(ax);
    expect(cy).toBeGreaterThan(ay);
    expect(l.sizes.a).toEqual({ width: A.iconSize, height: A.iconSize });
  });

  it("matches the arrangement of Mermaid's own spatial map", async () => {
    const src = `architecture-beta
  service left_disk(disk)[Disk]
  service top_disk(disk)[Disk]
  service bottom_disk(disk)[Disk]
  service top_gateway(internet)[Gateway]
  service bottom_gateway(internet)[Gateway]
  junction junctionCenter
  junction junctionRight
  left_disk:R -- L:junctionCenter
  top_disk:B -- T:junctionCenter
  bottom_disk:T -- B:junctionCenter
  junctionCenter:R -- L:junctionRight
  top_gateway:B -- T:junctionRight
  bottom_gateway:T -- B:junctionRight
`;
    const doc = parseMermaid(src);
    const l = architectureLayout(doc.graph);
    const db = await mermaidDb<{
      getDataStructures: () => { spatialMaps: Map<string, [number, number]>[] };
    }>(src);
    const [map] = db.getDataStructures().spatialMaps;
    const ids = [...map!.keys()];
    const sign = (n: number) => Math.sign(Math.round(n)) || 0;
    for (const a of ids)
      for (const b of ids) {
        const [mx, my] = [map!.get(b)![0] - map!.get(a)![0], map!.get(b)![1] - map!.get(a)![1]];
        const [ax, ay] = centre(l, a);
        const [bx, by] = centre(l, b);
        // Mermaid's grid y axis points up; the canvas' points down.
        expect([a, b, sign(bx - ax)]).toEqual([a, b, sign(mx)]);
        expect([a, b, sign(by - ay)]).toEqual([a, b, sign(-my)]);
      }
  });

  it("wraps groups around their members and aligns members with outside neighbours", () => {
    const doc = parseMermaid(SRC);
    const l = architectureLayout(doc.graph);
    const [, gy] = centre(l, "gateway");
    const [, sy] = centre(l, "server");
    expect(gy).toBe(sy);
    const [gx, gyTop] = l.positions.api!;
    const { width, height } = l.sizes.api!;
    for (const id of ["db", "cache", "server"]) {
      const [x, y] = l.positions[id]!;
      expect(x).toBeGreaterThanOrEqual(gx + A.padding);
      expect(y).toBeGreaterThanOrEqual(gyTop + A.padding);
      expect(x + A.iconSize).toBeLessThanOrEqual(gx + width - A.padding);
      expect(y + A.iconSize).toBeLessThanOrEqual(gyTop + height - A.padding);
    }
    expect(l.positions.gateway![0] + A.iconSize).toBeLessThan(gx);
  });

  it("keeps dragged nodes and re-fits their group", async () => {
    const doc = parseMermaid(SRC);
    const moved = applyEdit(doc, {
      type: "moveNodes",
      moves: [{ id: "db", position: [600, 700] }],
    });
    const l = await ensureDiagramLayout(moved.graph, moved.meta, { family: "architecture" });
    expect(l.positions.db).toEqual([600, 700]);
    const [gx, gy] = l.positions.api!;
    expect(gx + l.sizes.api!.width).toBeGreaterThanOrEqual(600 + A.iconSize + A.padding);
    expect(gy + l.sizes.api!.height).toBeGreaterThan(700 + A.iconSize + A.padding);
  });

  it("routes edges orthogonally from the exact ports", () => {
    const straight = architectureEdgeRoute({ x: 0, y: 0 }, "R", { x: 100, y: 0 }, "L");
    expect(straight).toMatchObject({
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      axis: "X",
    });
    const bend = architectureEdgeRoute({ x: 0, y: 0 }, "R", { x: 100, y: 80 }, "T");
    expect(bend.points).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
    ]);
    expect(bend.axis).toBe("XY");
    const vertical = architectureEdgeRoute({ x: 0, y: 0 }, "B", { x: 50, y: 100 }, "T");
    expect(vertical.points).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 50 },
      { x: 50, y: 50 },
      { x: 50, y: 100 },
    ]);
    expect(vertical.rotate).toBe(-90);
    // Mermaid's arrowhead points into the node, its tip 2px inside the border.
    const points = architectureArrow({ x: 100, y: 0 }, "L")
      .split(" ")
      .map((p) => p.split(",").map(Number));
    expect(Math.max(...points.map((p) => p[0]!))).toBe(102);
    expect(Math.min(...points.map((p) => p[0]!))).toBeCloseTo(102 - A.arrowSize, 1);
  });
});
