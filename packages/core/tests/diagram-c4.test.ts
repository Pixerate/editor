// @vitest-environment jsdom
// Ported from Ursula (src/c4/c4.test.ts).
import { describe, expect, it } from "vitest";
import { applyEdit, applyEdits, parseMermaid, serializeMermaid } from "../src/diagram/index.js";
import { registerDiagramAdapter } from "../src/diagram/registry.js";
import { expectValidMermaid, mermaidDb } from "./helpers/mermaid";
import type { DiagramAdapter } from "../src/diagram/types.js";
import { autoLayoutDiagram, ensureDiagramLayout } from "../src/canvas/mermaid/layout.js";
import { C4_METRICS, c4BoundaryText, c4ElementGeometry, c4Layout, c4RelGeometry } from "../src/diagram/c4/geometry.js";
import { c4Adapter } from "../src/diagram/c4/index.js";

registerDiagramAdapter(c4Adapter as DiagramAdapter<unknown>);

const SRC = `C4Context
  title System context — Generative Diagrams
  Person(author, "Author", "Creates and edits diagrams")
  Person(viewer, "Viewer", "Reads shared diagrams")
  System(gd, "Generative Diagrams", "Mermaid editing with a visual canvas")
  System_Ext(idp, "Identity provider", "SSO")
  System_Ext(storage, "Object storage", "Exported assets")
  Rel(author, gd, "Edits diagrams in")
  Rel(viewer, gd, "Views diagrams in")
  Rel(gd, idp, "Authenticates via")
  Rel(gd, storage, "Exports to")
`;

const CONTAINERS = `C4Container
  title Containers
  Person(user, "User")
  System_Boundary(sb, "Portal") {
    Container(web, "Web app", "React", "The UI")
    ContainerDb(db, "Database", "Postgres", "Stores diagrams")
    ContainerQueue(q, "Queue", "SQS")
  }
  System_Ext(idp, "IdP")
  Rel(user, web, "Uses", "HTTPS")
  Rel(web, db, "Reads/writes")
  BiRel(web, idp, "Authenticates")
  Rel_Back(db, web, "Notifies")
  UpdateRelStyle(user, web, $textColor="blue", $offsetY="-10")
  UpdateElementStyle(web, $bgColor="grey")
`;

interface C4Db {
  getC4ShapeArray: () => {
    alias: string;
    label: { text: string };
    typeC4Shape: { text: string };
    parentBoundary: string;
    techn?: { text: string };
    descr?: { text: string };
  }[];
  getBoundaries: (parent: string) => { alias: string; label: { text: string } }[];
  getRels: () => { type: string; from: string; to: string; label: { text: string } }[];
}

describe("c4 adapter", () => {
  it("round-trips untouched", () => {
    for (const src of [SRC, CONTAINERS]) {
      const doc = parseMermaid(src);
      expect(doc.family).toBe("c4");
      expect(doc.tier).toBe("editable");
      expect(serializeMermaid(doc)).toBe(src);
    }
  });

  it("builds elements, relations and the title", async () => {
    const doc = parseMermaid(SRC);
    expect(doc.graph.title).toBe("System context — Generative Diagrams");
    expect(doc.graph.nodes.map((n) => [n.id, n.label, n.shape])).toEqual([
      ["author", "Author", "c4-person"],
      ["viewer", "Viewer", "c4-person"],
      ["gd", "Generative Diagrams", "c4-system"],
      ["idp", "Identity provider", "c4-system-ext"],
      ["storage", "Object storage", "c4-system-ext"],
    ]);
    expect(doc.graph.nodes[0]!.data).toMatchObject({
      kind: "Person",
      descr: "Creates and edits diagrams",
      details: ["Creates and edits diagrams"],
    });
    expect(doc.graph.edges.map((e) => [e.id, e.label, e.arrowStart, e.arrowEnd])).toEqual([
      ["L_author_gd_0", "Edits diagrams in", "none", "arrow_point"],
      ["L_viewer_gd_0", "Views diagrams in", "none", "arrow_point"],
      ["L_gd_idp_0", "Authenticates via", "none", "arrow_point"],
      ["L_gd_storage_0", "Exports to", "none", "arrow_point"],
    ]);
    const db = await mermaidDb<C4Db>(SRC);
    expect(db.getC4ShapeArray().map((s) => [s.alias, s.label.text])).toEqual(
      doc.graph.nodes.map((n) => [n.id, n.label]),
    );
    expect(db.getRels().map((r) => `${r.from}>${r.to}`)).toEqual(
      doc.graph.edges.map((e) => `${e.source}>${e.target}`),
    );
  });

  it("models boundaries, technology and relation kinds", async () => {
    const doc = parseMermaid(CONTAINERS);
    expect(doc.graph.groups).toMatchObject([
      { id: "sb", label: "Portal", data: { kind: "System_Boundary" } },
    ]);
    const web = doc.graph.nodes.find((n) => n.id === "web")!;
    expect(web).toMatchObject({ parentId: "sb", shape: "c4-container" });
    expect(web.data).toMatchObject({
      tech: "React",
      descr: "The UI",
      details: ["[React]", "The UI"],
    });
    expect(doc.graph.nodes.find((n) => n.id === "db")!.shape).toBe("c4-db");
    expect(doc.graph.nodes.find((n) => n.id === "q")!.shape).toBe("c4-queue");
    const arrows = doc.graph.edges.map((e) => [e.data?.kind, e.arrowStart, e.arrowEnd]);
    expect(arrows).toEqual([
      ["Rel", "none", "arrow_point"],
      ["Rel", "none", "arrow_point"],
      ["BiRel", "arrow_point", "arrow_point"],
      ["Rel_Back", "arrow_point", "none"],
    ]);
    expect(doc.graph.edges[0]!.data?.tech).toBe("HTTPS");
    const db = await mermaidDb<C4Db>(CONTAINERS);
    expect(db.getBoundaries("global").map((b) => b.alias)).toEqual(["sb"]);
    const parents = Object.fromEntries(
      db
        .getC4ShapeArray()
        .map((s) => [s.alias, s.parentBoundary === "global" ? undefined : s.parentBoundary]),
    );
    expect(Object.fromEntries(doc.graph.nodes.map((n) => [n.id, n.parentId]))).toEqual(parents);
  });

  it("adds elements with a kind matching the diagram type", async () => {
    const doc = parseMermaid(CONTAINERS);
    const next = applyEdits(doc, [
      { type: "addNode", node: { id: "el7", label: "Cache", shape: "c4-db", parentId: "sb" } },
      {
        type: "addNode",
        node: { id: "el8", label: "Mailer", shape: "c4-system-ext" },
        position: [5, 6],
      },
      { type: "addNode", node: { id: "api", label: "API", shape: "c4-container" } },
    ]);
    expect(next.source).toContain(
      '    ContainerQueue(q, "Queue", "SQS")\n    ContainerDb(el7, "Cache")\n  }\n',
    );
    expect(next.source).toContain(
      '  System_Ext(idp, "IdP")\n  System_Ext(el8, "Mailer")\n  Container(api, "API")\n  Rel(user',
    );
    expect(next.meta.layout?.el8).toEqual([5, 6]);
    expect(next.graph.nodes.find((n) => n.id === "el7")!.parentId).toBe("sb");
    await expectValidMermaid(next.source);

    const ctx = applyEdit(parseMermaid(SRC), {
      type: "addNode",
      node: { id: "gd", label: 'Say "hi"', shape: "c4-db" },
    });
    expect(ctx.source).toContain(`SystemDb(gd_2, "Say 'hi'")`);
    await expectValidMermaid(ctx.source);
  });

  it("renames, reshapes and edits element data", async () => {
    const doc = parseMermaid(CONTAINERS);
    const next = applyEdits(doc, [
      { type: "renameNode", id: "web", label: "Web UI" },
      { type: "setNodeData", id: "q", data: { descr: "Jobs" } },
      { type: "setNodeData", id: "web", data: { tech: "Vue" } },
      { type: "setNodeShape", id: "idp", shape: "c4-container-ext" },
      { type: "setNodeShape", id: "db", shape: "c4-queue" },
      { type: "setNodeShape", id: "user", shape: "c4-person-ext" },
    ]);
    expect(next.source).toContain('Container(web, "Web UI", "Vue", "The UI")');
    expect(next.source).toContain('ContainerQueue(q, "Queue", "SQS", "Jobs")');
    expect(next.source).toContain('Container_Ext(idp, "IdP")');
    expect(next.source).toContain('ContainerQueue(db, "Database", "Postgres", "Stores diagrams")');
    expect(next.source).toContain('Person_Ext(user, "User")');
    await expectValidMermaid(next.source);

    const toSystem = applyEdit(next, { type: "setNodeShape", id: "web", shape: "c4-system" });
    expect(toSystem.source).toContain('System(web, "Web UI", "The UI")');
    const descr = applyEdit(parseMermaid(SRC), {
      type: "setNodeData",
      id: "gd",
      data: { descr: "", tech: "ignored" },
    });
    expect(descr.source).toContain('System(gd, "Generative Diagrams")\n');
  });

  it("removes elements with their relations and style lines", async () => {
    const doc = parseMermaid(CONTAINERS);
    const next = applyEdit(doc, { type: "removeNodes", ids: ["web"] });
    expect(next.source).toBe(`C4Container
  title Containers
  Person(user, "User")
  System_Boundary(sb, "Portal") {
    ContainerDb(db, "Database", "Postgres", "Stores diagrams")
    ContainerQueue(q, "Queue", "SQS")
  }
  System_Ext(idp, "IdP")
`);
    await expectValidMermaid(next.source);
    const unwrapped = applyEdit(doc, { type: "removeNodes", ids: ["sb"] });
    expect(unwrapped.source).toContain('  Person(user, "User")\n  Container(web,');
    expect(unwrapped.graph.groups).toEqual([]);
    await expectValidMermaid(unwrapped.source);
  });

  it("adds, relabels, restyles, reconnects and removes relations", async () => {
    const doc = parseMermaid(CONTAINERS);
    const added = applyEdits(doc, [
      { type: "addEdge", edge: { source: "q", target: "db" } },
      {
        type: "addEdge",
        edge: { source: "user", target: "idp", label: "Signs in", arrowStart: "arrow_point" },
      },
    ]);
    expect(added.source).toContain(
      '  Rel_Back(db, web, "Notifies")\n  Rel(q, db, "Uses")\n  BiRel(user, idp, "Signs in")\n  UpdateRelStyle',
    );
    await expectValidMermaid(added.source);

    const edited = applyEdits(added, [
      { type: "setEdgeLabel", id: "L_web_db_0", label: "Queries" },
      { type: "setEdgeData", id: "L_web_db_0", data: { tech: "SQL" } },
      { type: "setEdgeStyle", id: "L_web_idp_0", arrowStart: "none" },
      { type: "setEdgeStyle", id: "L_db_web_0", arrowEnd: "arrow_point" },
      { type: "setEdgeStyle", id: "L_q_db_0", arrowStart: "arrow_point", arrowEnd: "none" },
    ]);
    expect(edited.source).toContain('  Rel(web, db, "Queries", "SQL")\n');
    expect(edited.source).toContain('  Rel(web, idp, "Authenticates")\n');
    expect(edited.source).toContain('  BiRel(db, web, "Notifies")\n');
    expect(edited.source).toContain('  Rel_Back(q, db, "Uses")\n');
    await expectValidMermaid(edited.source);
    const db = await mermaidDb<C4Db>(edited.source);
    expect(db.getRels().map((r) => r.type)).toEqual([
      "rel",
      "rel",
      "rel",
      "birel",
      "rel_b",
      "birel",
    ]);

    const moved = applyEdit(edited, {
      type: "reconnectEdge",
      id: "L_user_web_0",
      source: "user",
      target: "db",
    });
    expect(moved.source).toContain('  Rel(user, db, "Uses", "HTTPS")\n');
    expect(moved.source).toContain(
      '  UpdateRelStyle(user, db, $textColor="blue", $offsetY="-10")\n',
    );
    await expectValidMermaid(moved.source);

    const removed = applyEdit(moved, { type: "removeEdges", ids: ["L_user_db_0"] });
    expect(removed.source).not.toContain("UpdateRelStyle");
    expect(removed.graph.edges).toHaveLength(5);
    expect(applyEdit(doc, { type: "setEdgeStyle", id: "L_web_db_0", arrowEnd: "none" })).toBe(doc);
  });

  it("groups, regroups and ungroups elements", async () => {
    const doc = parseMermaid(SRC);
    const grouped = applyEdit(doc, {
      type: "groupNodes",
      groupId: "ext",
      label: "Third parties",
      nodeIds: ["storage", "idp"],
    });
    expect(grouped.source)
      .toContain(`  System(gd, "Generative Diagrams", "Mermaid editing with a visual canvas")
  System_Boundary(ext, "Third parties") {
    System_Ext(idp, "Identity provider", "SSO")
    System_Ext(storage, "Object storage", "Exported assets")
  }
  Rel(author`);
    expect(grouped.graph.nodes.find((n) => n.id === "idp")!.parentId).toBe("ext");
    await expectValidMermaid(grouped.source);

    const renamed = applyEdit(grouped, { type: "renameGroup", id: "ext", label: "External" });
    expect(renamed.source).toContain('System_Boundary(ext, "External") {');
    const moved = applyEdits(renamed, [
      { type: "setNodeParent", ids: ["gd"], parentId: "ext" },
      { type: "setNodeParent", ids: ["idp"] },
    ]);
    expect(moved.source).toContain(`  System_Boundary(ext, "External") {
    System_Ext(storage, "Object storage", "Exported assets")
    System(gd, "Generative Diagrams", "Mermaid editing with a visual canvas")
  }
  System_Ext(idp, "Identity provider", "SSO")
  Rel(`);
    await expectValidMermaid(moved.source);
    expect(applyEdit(moved, { type: "setNodeParent", ids: ["ext"], parentId: "ext" })).toBe(moved);

    const ungrouped = applyEdit(grouped, { type: "ungroup", groupId: "ext" });
    expect(ungrouped.source).toBe(SRC);

    const container = applyEdit(parseMermaid(CONTAINERS), {
      type: "groupNodes",
      groupId: "inner",
      label: "Data",
      nodeIds: ["db", "q"],
    });
    expect(container.source).toContain(`    Container(web, "Web app", "React", "The UI")
    Container_Boundary(inner, "Data") {
      ContainerDb(db, "Database", "Postgres", "Stores diagrams")
      ContainerQueue(q, "Queue", "SQS")
    }
  }`);
    expect(container.graph.groups.find((g) => g.id === "inner")!.parentId).toBe("sb");
    await expectValidMermaid(container.source);

    const deploy = applyEdit(parseMermaid('C4Deployment\n  Container(a, "A")\n'), {
      type: "groupNodes",
      groupId: "box",
      label: "Box",
      nodeIds: ["a"],
    });
    expect(deploy.source).toBe(
      'C4Deployment\n  Deployment_Node(box, "Box", "node") {\n    Container(a, "A")\n  }\n',
    );
    await expectValidMermaid(deploy.source);
  });

  it("edits the title statement", async () => {
    const doc = parseMermaid(SRC);
    const next = applyEdit(doc, { type: "setTitle", title: "Context" });
    expect(next.source.startsWith("C4Context\n  title Context\n  Person(")).toBe(true);
    expect(next.graph.title).toBe("Context");
    await expectValidMermaid(next.source);
    const cleared = applyEdit(next, { type: "setTitle", title: undefined });
    expect(cleared.source.startsWith("C4Context\n  Person(author")).toBe(true);
    const added = applyEdit(cleared, { type: "setTitle", title: "Back" });
    expect(added.source.startsWith("C4Context\n  title Back\n")).toBe(true);
  });

  it("keeps unknown lines and named arguments verbatim", async () => {
    const src = `C4Dynamic
  %% comment
  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
  accTitle: Flow
  Container(a, "A", "", "first", $tags="v1", $link="https://x")
  Container(b, "B")
  RelIndex(1, a, b, "Calls")
`;
    const doc = parseMermaid(src);
    expect(serializeMermaid(doc)).toBe(src);
    expect(doc.graph.nodes[0]!.data?.extra).toBe('$tags="v1", $link="https://x"');
    expect(doc.graph.edges[0]).toMatchObject({ id: "L_a_b_0", label: "Calls" });
    const next = applyEdits(doc, [
      { type: "renameNode", id: "a", label: "Alpha" },
      { type: "setEdgeLabel", id: "L_a_b_0", label: "Invokes" },
    ]);
    expect(next.source).toBe(`C4Dynamic
  %% comment
  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
  accTitle: Flow
  Container(a, "Alpha", "", "first", $tags="v1", $link="https://x")
  Container(b, "B")
  RelIndex(1, a, b, "Invokes")
`);
    await expectValidMermaid(next.source);
  });

  it("mirrors the diagram type, layout config and style updates for the canvas", () => {
    const doc = parseMermaid(CONTAINERS);
    expect(doc.graph.data).toMatchObject({ c4Type: "C4Container" });
    expect(doc.graph.nodes.find((n) => n.id === "web")!.data?.c4Style).toEqual({
      bgColor: "grey",
    });
    expect(doc.graph.edges[0]!.data?.c4Style).toEqual({ textColor: "blue", offsetY: "-10" });
    const dyn = parseMermaid(
      'C4Dynamic\n  UpdateLayoutConfig($c4ShapeInRow="2", $c4BoundaryInRow="1")\n  Container(a, "A")\n',
    );
    expect(dyn.graph.data).toEqual({ c4Type: "C4Dynamic", c4ShapeInRow: 2, c4BoundaryInRow: 1 });
  });
});

describe("c4 geometry", () => {
  const M = C4_METRICS;
  const node = (id: string, kind: string) =>
    parseMermaid(`C4Container\n  ${kind}(${id}, "Name", "Tech", "Some description")\n`).graph
      .nodes[0]!;

  it("uses Mermaid's shapes, widths and text lines per element kind", () => {
    const person = c4ElementGeometry(
      parseMermaid('C4Context\n  Person(u, "User", "Reads things")\n').graph.nodes[0]!,
    );
    expect(person).toMatchObject({ shape: "person", width: 216 });
    expect(person.sections.map((s) => [s.part, s.text])).toEqual([
      ["label", "User"],
      ["tech", "[Person]"],
      ["descr", "Reads things"],
    ]);
    // The head sits above the body; the text is centred in the body.
    expect(person.person!.bodyTop).toBeGreaterThan(person.person!.headRadius);
    expect(person.textCenter.y).toBeGreaterThan(person.person!.bodyTop);

    const system = c4ElementGeometry(
      parseMermaid('C4Context\n  System_Ext(s, "Mail")\n').graph.nodes[0]!,
    );
    expect(system).toMatchObject({ shape: "rounded", width: 216 });
    expect(system.type).toMatchObject({ base: "system", external: true });
    expect(system.sections.map((s) => s.text)).toEqual(["Mail", "[Software System]"]);

    const web = c4ElementGeometry(node("web", "Container"));
    expect(web.sections[1]!.text).toBe("[Container: Tech]");
    expect(web.height).toBeCloseTo(web.textHeight + 2 * M.shapePadding);
    const db = c4ElementGeometry(node("db", "ContainerDb"));
    expect(db.shape).toBe("cylinder");
    expect(db.cylinder!.ry).toBeGreaterThan(0);
    const q = c4ElementGeometry(node("q", "ComponentQueue_Ext"));
    expect(q.shape).toBe("h-cyl");
    expect(q.width).toBeGreaterThan(216);
    expect(q.type).toMatchObject({ base: "component", variant: "queue", external: true });

    // Long text wraps at the shape's width.
    const long = c4ElementGeometry(
      parseMermaid(
        'C4Context\n  System(s, "A system with a rather long name that wraps", "and a description that is long enough to wrap onto more lines")\n',
      ).graph.nodes[0]!,
    );
    expect(long.sections[0]!.lines.length).toBeGreaterThan(1);
    expect(long.sections[2]!.lines.length).toBeGreaterThan(1);
  });

  it("lays elements out in Mermaid's rows, with boundaries below their parent's elements", () => {
    const doc = parseMermaid(CONTAINERS);
    const l = c4Layout(doc.graph, doc.meta, { screenWidth: 1920 });
    const at = (id: string) => l.positions[id]!;
    // Top-level elements: one row, 216px wide, 100px apart, starting 50px in.
    expect(at("user")[1]).toBe(at("idp")[1]);
    expect(at("idp")[0] - at("user")[0]).toBe(216 + 2 * M.shapeMargin);
    // The boundary starts below them; its elements are 50px in and 100px down.
    const sb = at("sb");
    const sbSize = l.sizes.sb!;
    const rowBottom = Math.max(
      at("user")[1] + l.sizes.user!.height,
      at("idp")[1] + l.sizes.idp!.height,
    );
    expect(sb[1]).toBeGreaterThan(rowBottom);
    expect(at("web")).toEqual([sb[0] + M.shapeMargin, sb[1] + 2 * M.shapeMargin]);
    expect(at("db")[1]).toBe(at("web")[1]);
    expect(at("q")[0]).toBeGreaterThan(at("db")[0]);
    // The boundary ends 50px after its last element.
    expect(sb[0] + sbSize.width).toBeCloseTo(at("q")[0] + l.sizes.q!.width + M.shapeMargin);
  });

  it("wraps rows after c4ShapeInRow elements", () => {
    const five = ["a", "b", "c", "d", "e"].map((id) => `  System(${id}, "${id}")`).join("\n");
    const doc = parseMermaid(`C4Context\n${five}\n`);
    const l = c4Layout(doc.graph, doc.meta, { screenWidth: 4000 });
    expect(new Set(["a", "b", "c", "d"].map((id) => l.positions[id]![1])).size).toBe(1);
    expect(l.positions.e![1]).toBeGreaterThan(l.positions.a![1]);
    expect(l.positions.e![0]).toBe(l.positions.a![0]);
    const two = parseMermaid(`C4Context\n  UpdateLayoutConfig($c4ShapeInRow="2")\n${five}\n`);
    const l2 = c4Layout(two.graph, two.meta, { screenWidth: 4000 });
    expect(l2.positions.c![0]).toBe(l2.positions.a![0]);
    expect(l2.positions.c![1]).toBeGreaterThan(l2.positions.a![1]);
  });

  it("keeps dragged elements where they were dropped and re-fits their boundary", async () => {
    const doc = parseMermaid(CONTAINERS);
    const before = c4Layout(doc.graph, doc.meta);
    const moved = applyEdit(doc, {
      type: "moveNodes",
      moves: [{ id: "web", position: [40, 900] }],
    });
    const after = c4Layout(moved.graph, moved.meta);
    expect(after.positions.web).toEqual([40, 900]);
    expect(after.positions.user).toEqual(before.positions.user);
    const sb = after.positions.sb!;
    expect(sb[0]).toBe(40 - M.shapeMargin);
    expect(sb[1] + after.sizes.sb!.height).toBe(900 + after.sizes.web!.height + M.shapeMargin);
    // Registered as the family layout, synchronously.
    const registered = await ensureDiagramLayout(moved.graph, moved.meta, { family: "c4" });
    expect(registered.positions.web).toEqual([40, 900]);
    expect((await autoLayoutDiagram(doc.graph, { family: "c4" })).positions).toEqual(before.positions);
  });

  it("labels boundaries with Mermaid's default types", async () => {
    const src = `C4Deployment
  Enterprise_Boundary(e, "E") {
    System_Boundary(s, "S") {
      Container_Boundary(c, "C") {
        Container(x, "X")
      }
    }
    Boundary(b, "B", "custom") {
      System(y, "Y")
    }
  }
  Deployment_Node(d, "D", "k8s", "Cluster") {
    Container(z, "Z")
  }
`;
    const doc = parseMermaid(src);
    const db = await mermaidDb<{
      getBoundaries: (p: string) => { alias: string; type: { text: string } }[];
    }>(src);
    const mermaidTypes = new Map<string, string>();
    const walk = (parent: string) => {
      for (const b of db.getBoundaries(parent)) {
        mermaidTypes.set(b.alias, `[${b.type.text}]`);
        walk(b.alias);
      }
    };
    walk("global");
    for (const g of doc.graph.groups) expect(c4BoundaryText(g).type).toBe(mermaidTypes.get(g.id));
    const d = c4BoundaryText(doc.graph.groups.find((g) => g.id === "d")!);
    expect(d).toMatchObject({ solid: true, descr: "Cluster" });
    expect(d.descrY).toBeGreaterThan(d.typeY);
    expect(c4BoundaryText(doc.graph.groups[0]!).solid).toBe(false);
  });

  it("gives an empty boundary a size", () => {
    const doc = parseMermaid('C4Context\n  System_Boundary(b, "Empty") {\n  }\n');
    const l = c4Layout(doc.graph, doc.meta);
    expect(l.sizes.b).toEqual(M.emptyBoundary);
  });

  it("draws relations between box edges, the first straight and the rest curved", () => {
    const a = { x: 0, y: 0, width: 100, height: 50 };
    const b = { x: 300, y: 0, width: 100, height: 50 };
    const first = c4RelGeometry(a, b, 0);
    expect(first.start).toEqual({ x: 100, y: 25 });
    expect(first.end).toEqual({ x: 300, y: 25 });
    expect(first.control).toBeUndefined();
    expect(first.label).toEqual({ x: 200, y: 25 });
    const second = c4RelGeometry(a, b, 1);
    expect(second.control).toEqual({ x: 150, y: 25 });
  });
});
