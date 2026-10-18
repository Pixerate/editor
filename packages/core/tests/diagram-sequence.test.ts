// @vitest-environment jsdom
// Ported from Ursula (src/sequence/sequence.test.ts).
import { describe, expect, it } from "vitest";
import { applyEdit, applyEdits, parseMermaid, serializeMermaid } from "../src/diagram/index.js";
import { registerDiagramAdapter } from "../src/diagram/registry.js";
import { ensureDiagramLayout } from "../src/canvas/mermaid/layout.js";
import { expectValidMermaid, mermaidDb } from "./helpers/mermaid";
import type { DiagramAdapter, MermaidDocument } from "../src/diagram/types.js";
import { sequenceAdapter, sequenceGeometry } from "../src/diagram/sequence/index.js";

registerDiagramAdapter(sequenceAdapter as DiagramAdapter<unknown>);

const SRC = `---
title: Checkout sequence
---
sequenceDiagram
  autonumber
  actor U as Customer
  participant W as Web app
  participant P as Payments API
  participant B as Bank
  U->>W: Place order
  W->>P: Create payment intent
  P-->>W: client_secret
  W->>U: Show payment form
  U->>W: Submit card details
  W->>P: Confirm payment
  P->>B: Authorise
  alt Approved
    B-->>P: Approved
    P-->>W: succeeded
    W-->>U: Order confirmed
  else Declined
    B-->>P: Declined
    P-->>W: requires_payment_method
    W-->>U: Ask for another card
  end
`;

const SMALL = `sequenceDiagram
  participant Browser
  participant App as Portal
  Browser->>App: GET /dashboard
  App-->>Browser: 302
  Note over App,Browser: Tokens never reach the browser
`;

interface SequenceDb {
  getActors: () => Map<string, { description: string; type: string; box?: { name?: string } }>;
  getMessages: () => { from?: string; to?: string; message: unknown; type: number }[];
}

/** Mermaid's view of the diagram: actors and real messages (notes and fragments excluded). */
async function mermaidView(src: string) {
  const db = await mermaidDb<SequenceDb>(src);
  return {
    actors: [...db.getActors().entries()].map(([id, a]) => [id, a.description, a.type]),
    messages: db
      .getMessages()
      .filter((m) => m.from && m.to && m.type !== 2)
      .map((m) => [m.from, m.to, m.message]),
  };
}

function ursulaView(doc: MermaidDocument) {
  return {
    actors: doc.graph.nodes.map((n) => [
      n.id,
      n.label,
      n.shape === "actor" ? "actor" : "participant",
    ]),
    messages: doc.graph.edges.map((e) => [e.source, e.target, e.label]),
  };
}

const edgeId = (doc: MermaidDocument, label: string) =>
  doc.graph.edges.find((e) => e.label === label)!.id;

describe("sequence adapter", () => {
  it("round-trips untouched", () => {
    for (const src of [SRC, SMALL]) {
      const doc = parseMermaid(src);
      expect(doc.family).toBe("sequence");
      expect(doc.tier).toBe("editable");
      expect(serializeMermaid(doc)).toBe(src);
    }
  });

  it("builds participants, messages and diagram data", async () => {
    const doc = parseMermaid(SRC);
    expect(doc.graph.nodes.map((n) => [n.id, n.label, n.shape])).toEqual([
      ["U", "Customer", "actor"],
      ["W", "Web app", "rect"],
      ["P", "Payments API", "rect"],
      ["B", "Bank", "rect"],
    ]);
    expect(doc.graph.edges).toHaveLength(13);
    expect(doc.graph.edges[0]).toMatchObject({
      id: "L_U_W_0",
      source: "U",
      target: "W",
      label: "Place order",
      pattern: "solid",
      arrowEnd: "arrow_point",
      data: { index: 0, kind: "->>", activate: false, deactivate: false },
    });
    expect(doc.graph.edges[2]).toMatchObject({ id: "L_P_W_0", pattern: "dotted" });
    expect(doc.graph.edges[7]!.data).toMatchObject({ index: 7, details: ["alt Approved"] });
    expect(doc.graph.edges[10]!.data).toMatchObject({ details: ["else Declined"] });
    expect(doc.graph.title).toBe("Checkout sequence");
    expect(doc.graph.data?.autonumber).toBe(true);
    const events = doc.graph.data?.events as { kind: string }[];
    expect(events.map((e) => e.kind)).toEqual([
      ...Array(7).fill("message"),
      "open",
      ...Array(3).fill("message"),
      "else",
      ...Array(3).fill("message"),
      "end",
    ]);
    expect(ursulaView(doc)).toEqual(await mermaidView(SRC));
  });

  it("includes participants only mentioned in messages", async () => {
    const src = "sequenceDiagram\n  participant A as Alpha\n  B->>A: hi\n  A-xC: lost\n";
    const doc = parseMermaid(src);
    expect(doc.graph.nodes.map((n) => [n.id, n.label, n.shape])).toEqual([
      ["A", "Alpha", "rect"],
      ["B", "B", "rect"],
      ["C", "C", "rect"],
    ]);
    expect(doc.graph.edges[1]).toMatchObject({ arrowEnd: "arrow_cross", pattern: "solid" });
    const view = await mermaidView(src);
    expect(new Set(ursulaView(doc).actors.map((a) => a[0]))).toEqual(
      new Set(view.actors.map((a) => a[0])),
    );
  });

  it("maps every arrow token to an edge style", () => {
    const tokens = ["->", "-->", "->>", "-->>", "<<->>", "<<-->>", "-x", "--x", "-)", "--)"];
    const src = `sequenceDiagram\n${tokens.map((t) => `  A${t}B: m`).join("\n")}\n`;
    const doc = parseMermaid(src);
    expect(doc.graph.edges.map((e) => [e.data?.kind, e.pattern, e.arrowStart, e.arrowEnd])).toEqual(
      [
        ["->", "solid", "none", "none"],
        ["-->", "dotted", "none", "none"],
        ["->>", "solid", "none", "arrow_point"],
        ["-->>", "dotted", "none", "arrow_point"],
        ["<<->>", "solid", "arrow_point", "arrow_point"],
        ["<<-->>", "dotted", "arrow_point", "arrow_point"],
        ["-x", "solid", "none", "arrow_cross"],
        ["--x", "dotted", "none", "arrow_cross"],
        ["-)", "solid", "none", "arrow_open"],
        ["--)", "dotted", "none", "arrow_open"],
      ],
    );
    expect(doc.graph.edges.map((e) => e.id)).toEqual(tokens.map((_t, i) => `L_A_B_${i}`));
  });

  it("adds, renames, reshapes and removes participants", async () => {
    const doc = parseMermaid(SMALL);
    const added = applyEdit(doc, {
      type: "addNode",
      node: { id: "P1", label: "Identity", shape: "actor" },
      position: [10, 20],
    });
    expect(added.source).toContain(
      "  participant App as Portal\n  actor P1 as Identity\n  Browser->>App",
    );
    expect(added.meta.layout?.P1).toEqual([10, 20]);

    const renamed = applyEdit(added, { type: "renameNode", id: "Browser", label: "User agent" });
    expect(renamed.source).toContain("  participant Browser as User agent\n");
    const reshaped = applyEdit(renamed, { type: "setNodeShape", id: "Browser", shape: "actor" });
    expect(reshaped.source).toContain("  actor Browser as User agent\n");
    await expectValidMermaid(reshaped.source);

    const removed = applyEdit(reshaped, { type: "removeNodes", ids: ["Browser"] });
    expect(removed.source).toBe(
      'sequenceDiagram\n  %% @pixerate {"v":1,"layout":{"P1":[10,20]}}\n  participant App as Portal\n  actor P1 as Identity\n',
    );
    await expectValidMermaid(removed.source);
  });

  it("declares undeclared participants on rename and keeps the id unique on add", async () => {
    const src = "sequenceDiagram\n  participant A\n  A->>B: hi\n";
    const renamed = applyEdit(parseMermaid(src), { type: "renameNode", id: "B", label: "Bee" });
    expect(renamed.source).toBe(
      "sequenceDiagram\n  participant A\n  participant B as Bee\n  A->>B: hi\n",
    );
    const added = applyEdit(renamed, { type: "addNode", node: { id: "A", label: "A" } });
    expect(added.source).toContain("  participant A_2 as A\n");
    expect(added.graph.nodes.map((n) => n.id)).toEqual(["A", "B", "A_2"]);
    await expectValidMermaid(added.source);
  });

  it("adds, relabels, restyles, reconnects and removes messages", async () => {
    const doc = parseMermaid(SMALL);
    const added = applyEdit(doc, { type: "addEdge", edge: { source: "App", target: "Browser" } });
    expect(added.source.endsWith("  App->>Browser: Message\n")).toBe(true);
    const id = added.graph.edges.at(-1)!.id;
    expect(id).toBe("L_App_Browser_1");

    const relabeled = applyEdit(added, { type: "setEdgeLabel", id, label: "Set-Cookie" });
    expect(relabeled.source).toContain("  App->>Browser: Set-Cookie\n");

    const styles: [Parameters<typeof applyEdit>[1], string][] = [
      [{ type: "setEdgeStyle", id, pattern: "dotted" }, "-->>"],
      [{ type: "setEdgeStyle", id, arrowEnd: "arrow_cross" }, "--x"],
      [{ type: "setEdgeStyle", id, arrowEnd: "arrow_open", pattern: "solid" }, "-)"],
      [{ type: "setEdgeStyle", id, arrowEnd: "none" }, "->"],
      [{ type: "setEdgeStyle", id, arrowStart: "arrow_point", arrowEnd: "arrow_point" }, "<<->>"],
    ];
    let cur = relabeled;
    for (const [op, token] of styles) {
      cur = applyEdit(cur, op);
      expect(cur.source).toContain(`  App${token}Browser: Set-Cookie\n`);
      await expectValidMermaid(cur.source);
    }

    const reconnected = applyEdit(cur, {
      type: "reconnectEdge",
      id,
      source: "Browser",
      target: "App",
    });
    expect(reconnected.source).toContain("  Browser<<->>App: Set-Cookie\n");
    const removed = applyEdit(reconnected, {
      type: "removeEdges",
      ids: [edgeId(reconnected, "Set-Cookie")],
    });
    expect(removed.source).toBe(SMALL);
  });

  it("edits activation and message order", async () => {
    const doc = parseMermaid(SMALL);
    const activated = applyEdit(doc, {
      type: "setEdgeData",
      id: "L_Browser_App_0",
      data: { activate: true },
    });
    expect(activated.source).toContain("  Browser->>+App: GET /dashboard\n");
    const deactivated = applyEdit(activated, {
      type: "setEdgeData",
      id: "L_App_Browser_0",
      data: { deactivate: true },
    });
    expect(deactivated.source).toContain("  App-->>-Browser: 302\n");
    expect(deactivated.graph.edges[1]!.data).toMatchObject({ deactivate: true });
    await expectValidMermaid(deactivated.source);

    // A deactivation without an active participant would be rejected by Mermaid.
    const invalid = applyEdit(doc, {
      type: "setEdgeData",
      id: "L_App_Browser_0",
      data: { deactivate: true },
    });
    expect(invalid.source).toBe(SMALL);

    const moved = applyEdit(doc, {
      type: "setEdgeData",
      id: "L_App_Browser_0",
      data: { index: 0 },
    });
    expect(moved.source).toContain("  App-->>Browser: 302\n  Browser->>App: GET /dashboard\n");
    expect(moved.graph.edges.map((e) => e.data?.index)).toEqual([0, 1]);
    const back = applyEdit(moved, {
      type: "setEdgeData",
      id: "L_App_Browser_0",
      data: { index: 5 },
    });
    expect(back.source).toContain(
      "  Note over App,Browser: Tokens never reach the browser\n  App-->>Browser: 302\n",
    );
    await expectValidMermaid(back.source);
  });

  it("moves a message into another fragment position", async () => {
    const doc = parseMermaid(SRC);
    const id = edgeId(doc, "Place order");
    const moved = applyEdit(doc, { type: "setEdgeData", id, data: { index: 8 } });
    expect(moved.source).toContain(
      "    P-->>W: succeeded\n    U->>W: Place order\n    W-->>U: Order confirmed\n",
    );
    expect(moved.graph.edges.find((e) => e.label === "Place order")!.data?.index).toBe(8);
    await expectValidMermaid(moved.source);
  });

  it("removes a participant with its messages, notes and activations", async () => {
    const src =
      "sequenceDiagram\n  participant A\n  participant B\n  participant C\n  A->>B: one\n  activate B\n  B->>C: two\n  deactivate B\n  Note over A,C: spans\n  Note right of C: c only\n";
    const removed = applyEdit(parseMermaid(src), { type: "removeNodes", ids: ["B"] });
    expect(removed.source).toBe(
      "sequenceDiagram\n  participant A\n  participant C\n  Note over A,C: spans\n  Note right of C: c only\n",
    );
    await expectValidMermaid(removed.source);
  });

  it("models boxes as groups", async () => {
    const src =
      "sequenceDiagram\n  box rgb(200,220,240) Payments\n    participant P as Payments API\n    participant B as Bank\n  end\n  box Aqua Front\n    participant W\n  end\n  box Plain\n    actor U\n  end\n  W->>P: pay\n";
    const doc = parseMermaid(src);
    expect(serializeMermaid(doc)).toBe(src);
    expect(doc.graph.groups.map((g) => [g.id, g.label, g.data?.color])).toEqual([
      ["Payments", "Payments", "rgb(200,220,240)"],
      ["Front", "Front", "Aqua"],
      ["Plain", "Plain", undefined],
    ]);
    expect(doc.graph.nodes.map((n) => [n.id, n.parentId])).toEqual([
      ["P", "Payments"],
      ["B", "Payments"],
      ["W", "Front"],
      ["U", "Plain"],
    ]);
    await expectValidMermaid(src);
    const db = await mermaidDb<SequenceDb>(src);
    expect(db.getActors().get("P")!.box?.name).toBe("Payments");

    const renamed = applyEdit(doc, { type: "renameGroup", id: "Payments", label: "Money" });
    expect(renamed.source).toContain("  box rgb(200,220,240) Money\n");
    expect(renamed.graph.groups[0]!.id).toBe("Money");

    const moved = applyEdit(renamed, { type: "setNodeParent", ids: ["W"], parentId: "Money" });
    expect(moved.source).toContain(
      "    participant B as Bank\n    participant W\n  end\n  box Plain\n",
    );
    expect(moved.graph.groups.map((g) => g.id)).toEqual(["Money", "Plain"]);
    await expectValidMermaid(moved.source);

    const out = applyEdit(moved, { type: "setNodeParent", ids: ["B"] });
    expect(out.source).toContain("    participant W\n  end\n  participant B as Bank\n");

    const added = applyEdit(out, {
      type: "addNode",
      node: { id: "X", label: "Ledger", parentId: "Money" },
    });
    expect(added.source).toContain("    participant W\n    participant X as Ledger\n  end\n");

    const ungrouped = applyEdit(added, { type: "ungroup", groupId: "Money" });
    expect(ungrouped.source).toContain(
      "sequenceDiagram\n  participant P as Payments API\n  participant W\n  participant X as Ledger\n  participant B as Bank\n",
    );
    await expectValidMermaid(ungrouped.source);
  });

  it("groups participants into a new box", async () => {
    const doc = parseMermaid(SRC);
    const grouped = applyEdit(doc, {
      type: "groupNodes",
      groupId: "g",
      label: "Backend",
      nodeIds: ["P", "B"],
    });
    expect(grouped.source).toContain(
      "  participant W as Web app\n  box Backend\n    participant P as Payments API\n    participant B as Bank\n  end\n  U->>W",
    );
    expect(grouped.graph.nodes.find((n) => n.id === "B")!.parentId).toBe("Backend");
    await expectValidMermaid(grouped.source);

    const colourish = applyEdit(doc, {
      type: "groupNodes",
      groupId: "g",
      label: "Red team",
      nodeIds: ["U"],
    });
    expect(colourish.source).toContain(
      "  box transparent Red team\n    actor U as Customer\n  end\n",
    );
    expect(colourish.graph.groups[0]!.label).toBe("Red team");
    await expectValidMermaid(colourish.source);
  });

  it("toggles autonumber and edits the title", async () => {
    const doc = parseMermaid(SRC);
    const off = applyEdit(doc, { type: "setGraphData", data: { autonumber: false } });
    expect(off.source).toContain("sequenceDiagram\n  actor U as Customer\n");
    expect(off.graph.data?.autonumber).toBe(false);
    const on = applyEdit(off, { type: "setGraphData", data: { autonumber: true } });
    expect(on.source).toBe(SRC);

    // Frontmatter title stays in the frontmatter.
    const fm = applyEdit(doc, { type: "setTitle", title: "Checkout" });
    expect(fm.source.startsWith("---\ntitle: Checkout\n---\nsequenceDiagram\n")).toBe(true);
    expect(fm.graph.title).toBe("Checkout");

    const titled = applyEdits(parseMermaid(SMALL), [{ type: "setTitle", title: "Login" }]);
    expect(
      titled.source.startsWith("sequenceDiagram\n  title Login\n  participant Browser\n"),
    ).toBe(true);
    expect(titled.graph.title).toBe("Login");
    await expectValidMermaid(titled.source);
    const cleared = applyEdit(titled, { type: "setTitle", title: undefined });
    expect(cleared.source).toBe(SMALL);
  });

  it("keeps create participants valid", async () => {
    const src =
      "sequenceDiagram\n  participant A\n  create participant B as Bee\n  A->>B: make\n  B->>A: done\n";
    const doc = parseMermaid(src);
    expect(doc.graph.nodes[1]).toMatchObject({ id: "B", label: "Bee", data: { create: true } });
    const renamed = applyEdit(doc, { type: "renameNode", id: "B", label: "Builder" });
    expect(renamed.source).toContain("  create participant B as Builder\n");
    // Removing the creating message would leave `create` dangling: it is dropped.
    const removed = applyEdit(doc, { type: "removeEdges", ids: ["L_A_B_0"] });
    expect(removed.source).toBe(
      "sequenceDiagram\n  participant A\n  participant B as Bee\n  B->>A: done\n",
    );
    await expectValidMermaid(removed.source);
  });

  it("keeps unknown lines verbatim", async () => {
    const src =
      'sequenceDiagram\n  accTitle: Login flow\n  %% comment\n  participant A\n  links A: {"Docs": "https://example.com"}\n  loop Every minute\n    A->>A: tick\n  end\n  A-->>A:  spaced   text\n';
    const doc = parseMermaid(src);
    expect(serializeMermaid(doc)).toBe(src);
    const next = applyEdit(doc, { type: "setEdgeLabel", id: "L_A_A_0", label: "tock" });
    expect(next.source).toBe(src.replace("A->>A: tick", "A->>A: tock"));
    await expectValidMermaid(next.source);
  });

  it("lays participants out in a row with boxes spanning the lifelines", async () => {
    const src =
      "sequenceDiagram\n  participant A\n  box Pair\n    participant B\n    participant C\n  end\n  A->>B: hi\n";
    const doc = parseMermaid(src);
    // Stored positions are ignored: Mermaid derives columns from the order.
    const layout = await ensureDiagramLayout(
      doc.graph,
      { v: 1, layout: { C: [900, 40] } },
      { family: "sequence" },
    );
    expect(layout.positions.A).toEqual([0, 0]);
    expect(layout.sizes.A).toEqual({ width: 150, height: 65 });
    expect(layout.positions.B![1]).toBe(0);
    expect(layout.positions.C![0]).toBeGreaterThan(layout.positions.B![0]);
    expect(layout.positions.C![1]).toBe(0);
    const [gx] = layout.positions.Pair!;
    expect(gx).toBeLessThan(layout.positions.B![0]);
    expect(gx + layout.sizes.Pair!.width).toBeGreaterThan(layout.positions.C![0] + 150);
    // The box reaches below the lifelines to the mirrored participants.
    const geo = sequenceGeometry(doc.graph);
    expect(layout.positions.Pair![1] + layout.sizes.Pair!.height).toBeGreaterThan(geo.height);
  });

  it("exposes notes, fragments and activations as ordered events with geometry", () => {
    const src = [
      "sequenceDiagram",
      "  participant A",
      "  participant B",
      "  A->>+B: start",
      "  Note over A,B: Shared state",
      "  loop Every minute",
      "    B-->>A: tick",
      "  end",
      "  B->>-A: done",
    ].join("\n");
    const doc = parseMermaid(src);
    const events = doc.graph.data?.events as { kind: string }[];
    expect(events.map((e) => e.kind)).toEqual([
      "message",
      "note",
      "open",
      "message",
      "end",
      "message",
    ]);
    expect(events[1]).toEqual({
      kind: "note",
      placement: "over",
      targets: ["A", "B"],
      text: "Shared state",
    });
    const geo = sequenceGeometry(doc.graph);
    expect(geo.messages.map((m) => m.y)).toEqual(
      [...geo.messages.map((m) => m.y)].sort((a, b) => a - b),
    );
    expect(geo.notes).toHaveLength(1);
    expect(geo.fragments).toEqual([
      expect.objectContaining({ keyword: "loop", text: "Every minute" }),
    ]);
    const frag = geo.fragments[0]!;
    expect(frag.y).toBeLessThan(geo.messages[1]!.y);
    expect(frag.y + frag.height).toBeGreaterThan(geo.messages[1]!.y);
    // B is activated by `+` on the first message and deactivated by `-` on the last.
    expect(geo.activations).toEqual([
      expect.objectContaining({
        participant: "B",
        top: geo.messages[0]!.y,
        bottom: geo.messages[2]!.y,
      }),
    ]);
  });

  it("reorders participants when one is dragged past another", async () => {
    const src = "sequenceDiagram\n  participant A\n  participant B\n  participant C\n  A->>C: hi\n";
    const doc = parseMermaid(src);
    const geo = sequenceGeometry(doc.graph);
    const c = geo.columns.get("C")!;
    // Drop A to the right of C.
    const moved = applyEdit(doc, {
      type: "moveNodes",
      moves: [{ id: "A", position: [c.x + c.width, 0] }],
    });
    expect(moved.source).toBe(
      "sequenceDiagram\n  participant B\n  participant C\n  participant A\n  A->>C: hi\n",
    );
    expect(moved.meta.layout ?? {}).toEqual({});
    await expectValidMermaid(moved.source);
    // A drop that stays in its slot changes nothing.
    const same = applyEdit(doc, {
      type: "moveNodes",
      moves: [{ id: "B", position: [geo.columns.get("B")!.x + 10, 30] }],
    });
    expect(same.source).toBe(src);
    // Undeclared participants get declarations so the new order can be written.
    const bare = parseMermaid("sequenceDiagram\n  X->>Y: hi\n  Y->>Z: ok\n");
    const bg = sequenceGeometry(bare.graph);
    const reordered = applyEdit(bare, {
      type: "moveNodes",
      moves: [{ id: "Z", position: [bg.columns.get("X")!.x - 100, 0] }],
    });
    expect(reordered.graph.nodes.map((n) => n.id)).toEqual(["Z", "X", "Y"]);
    await expectValidMermaid(reordered.source);
  });
});
