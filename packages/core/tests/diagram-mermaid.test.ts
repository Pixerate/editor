// @vitest-environment jsdom
// Ported from Ursula (src/flowchart/flowchart.test.ts, src/lines-grammar/lines-grammar.test.ts, src/source/find.test.ts, src/regressions.test.ts).
import { describe, expect, it } from "vitest";
import { applyEdit, findMermaidSources, parseMermaid, serializeMermaid } from "../src/diagram";
import { expectValidMermaid, loadMermaid, mermaidSummary, normaliseSummary, diagramSummary } from "./helpers/mermaid";


const KITCHEN_SINK = `---
title: Order flow
---
%%{init: {"theme":"base"}}%%
flowchart LR
  %% a comment
  A[Start] --> B{Decision?}
  B -- yes --> C(Round):::hot
  B -. no .-> D[[Subroutine]]
  subgraph S1 [Fulfilment]
    direction TB
    C --> E[(DB)]
    subgraph S2
      F((Inner)) & G>Asym] --> H{{Hex}}
    end
  end
  E ==> I[/Para/] --> J[\\Para2\\]
  I e1@--> K[/Trap\\]
  K ----> L[\\Trap2/]
  L -->|"quoted label"| M(((Double)))
  M --o N --x O
  O <--> P
  P ~~~ Q
  classDef hot fill:#f96,stroke:#333
  class N,O hot
  style A fill:#bbf
  linkStyle 0 stroke:red
  click A "https://example.com" _blank
  R@{ shape: docs, label: "Stacked" }
  e1@{ animate: true }
`;

describe("flowchart adapter", () => {
  it("round-trips an untouched document byte-for-byte", () => {
    const doc = parseMermaid(KITCHEN_SINK);
    expect(doc.family).toBe("flowchart");
    expect(doc.tier).toBe("editable");
    expect(serializeMermaid(doc)).toBe(KITCHEN_SINK);
  });

  it("preserves CRLF line endings and trailing whitespace", () => {
    const src = "flowchart TD\r\n  A --> B\r\n\r\n";
    expect(serializeMermaid(parseMermaid(src))).toBe(src);
    const noTrailing = "flowchart TD\n  A --> B";
    expect(serializeMermaid(parseMermaid(noTrailing))).toBe(noTrailing);
  });

  it("builds the same graph Mermaid does", async () => {
    const doc = parseMermaid(KITCHEN_SINK);
    const ours = normaliseSummary(diagramSummary(doc.graph));
    const theirs = normaliseSummary(await mermaidSummary(KITCHEN_SINK));
    expect(ours.edges).toEqual(theirs.edges);
    expect(ours.nodes).toEqual(theirs.nodes);
  });

  it("reads node attributes", () => {
    const doc = parseMermaid(KITCHEN_SINK);
    const byId = Object.fromEntries(doc.graph.nodes.map((n) => [n.id, n]));
    expect(byId.A!.link).toBe("https://example.com");
    expect(byId.A!.linkTarget).toBe("_blank");
    expect(byId.A!.styles).toEqual(["fill:#bbf"]);
    expect(byId.C!.classes).toEqual(["hot"]);
    expect(byId.N!.classes).toEqual(["hot"]);
    expect(byId.R!.shape).toBe("docs");
    expect(byId.R!.label).toBe("Stacked");
    expect(doc.graph.classDefs.hot).toEqual(["fill:#f96", "stroke:#333"]);
    expect(doc.graph.direction).toBe("LR");
    expect(doc.graph.title).toBe("Order flow");
    const e1 = doc.graph.edges.find((e) => e.id === "e1")!;
    expect(e1.userDefinedId).toBe(true);
    expect(e1.animate).toBe(true);
    expect(doc.graph.edges[0]!.styles).toEqual(["stroke:red"]);
    const groups = Object.fromEntries(doc.graph.groups.map((g) => [g.id, g]));
    expect(groups.S1!.label).toBe("Fulfilment");
    expect(groups.S1!.direction).toBe("TB");
    expect(groups.S2!.parentId).toBe("S1");
  });

  it("handles `;`-separated statements and header variants", () => {
    const src = "graph TD;\n  A-->B; B-->C;\n  C --> D";
    const doc = parseMermaid(src);
    expect(doc.graph.edges.map((e) => `${e.source}>${e.target}`)).toEqual(["A>B", "B>C", "C>D"]);
    expect(serializeMermaid(doc)).toBe(src);
  });

  it("renames a node, touching only its statement", () => {
    const src = "flowchart LR\n  A[Start] --> B\n  B --> C";
    const next = applyEdit(parseMermaid(src), {
      type: "renameNode",
      id: "B",
      label: "Middle step",
    });
    expect(next.source).toBe("flowchart LR\n  A[Start] --> B[Middle step]\n  B --> C");
    expect(next.graph.nodes.find((n) => n.id === "B")!.label).toBe("Middle step");
  });

  it("quotes labels that need it and keeps shapes", () => {
    const src = "flowchart LR\n  A{Go?} --> B";
    const next = applyEdit(parseMermaid(src), {
      type: "renameNode",
      id: "A",
      label: "Ready (yes/no)?",
    });
    expect(next.source).toBe('flowchart LR\n  A{"Ready (yes/no)?"} --> B');
  });

  it("changes shape, including data-syntax-only shapes", () => {
    const src = "flowchart LR\n  A[Start] --> B";
    const a = applyEdit(parseMermaid(src), { type: "setNodeShape", id: "A", shape: "diam" });
    expect(a.source).toBe("flowchart LR\n  A{Start} --> B");
    const b = applyEdit(a, { type: "setNodeShape", id: "A", shape: "docs" });
    expect(b.source).toBe('flowchart LR\n  A@{ shape: docs, label: "Start" } --> B');
    const c = applyEdit(b, { type: "setNodeShape", id: "A", shape: "rounded" });
    expect(c.source).toBe('flowchart LR\n  A@{ shape: rounded, label: "Start" } --> B');
  });

  describe("image nodes", () => {
    const SRC = `flowchart TD
  A@{ img: "https://example.com/r760.png", label: "PowerEdge R760", pos: "b", w: 320, h: 61, constraint: "on" }
  A --> B[Switch]
`;

    it("reads an img node as an image, keeping its picture, size and label position", () => {
      const doc = parseMermaid(SRC);
      const a = doc.graph.nodes.find((n) => n.id === "A")!;
      expect(a).toMatchObject({ shape: "image", label: "PowerEdge R760" });
      expect(a.data).toEqual({
        img: "https://example.com/r760.png",
        pos: "b",
        w: 320,
        h: 61,
        constraint: "on",
      });
      expect(serializeMermaid(doc)).toBe(SRC);
    });

    it("writes edited image nodes without a shape key, which Mermaid infers from img", async () => {
      const renamed = applyEdit(parseMermaid(SRC), { type: "renameNode", id: "A", label: "R760" });
      expect(serializeMermaid(renamed)).toContain(
        'A@{ label: "R760", img: "https://example.com/r760.png", pos: "b", w: 320, h: 61, constraint: "on" }',
      );
      await expectValidMermaid(serializeMermaid(renamed));
    });

    it("adds an image node with its data, and keeps img consistent with the shape", async () => {
      const added = applyEdit(parseMermaid("flowchart TD\n  A[Start]\n"), {
        type: "addNode",
        node: {
          id: "P",
          label: "PA-440",
          shape: "image",
          classes: [],
          styles: [],
          data: { img: "/hw/pa-440.png", w: 140, h: 31, constraint: "on" },
        },
      });
      const source = serializeMermaid(added);
      expect(source).toContain(
        'P@{ label: "PA-440", img: "/hw/pa-440.png", w: 140, h: 31, constraint: "on" }',
      );
      await expectValidMermaid(source);
      expect(parseMermaid(source).graph.nodes.find((n) => n.id === "P")!.shape).toBe("image");

      // A new image node without a picture yet stays an image (img: "").
      const blank = applyEdit(added, { type: "setNodeShape", id: "A", shape: "image" });
      expect(serializeMermaid(blank)).toContain('A@{ label: "Start", img: "" }');
      expect(parseMermaid(serializeMermaid(blank)).graph.nodes[0]!.shape).toBe("image");

      // Leaving the image shape drops the image keys, which would otherwise win.
      const back = applyEdit(added, { type: "setNodeShape", id: "P", shape: "rect" });
      expect(serializeMermaid(back)).toContain('P@{ shape: rect, label: "PA-440" }');
    });
  });

  it("adds and removes nodes, splitting chains and fixing linkStyle indices", () => {
    const src = "flowchart LR\n  A --> B --> C\n  linkStyle 1 stroke:red";
    const doc = parseMermaid(src);
    const removed = applyEdit(doc, { type: "removeNodes", ids: ["B"] });
    expect(removed.source).toBe("flowchart LR\n  A\n  C");
    expect(removed.graph.edges).toHaveLength(0);
    const added = applyEdit(removed, {
      type: "addNode",
      node: { id: "Z", label: "New", shape: "cyl" },
      position: [10, 20],
    });
    expect(added.source).toBe(
      'flowchart LR\n  %% @pixerate {"v":1,"layout":{"Z":[10,20]}}\n  A\n  C\n  Z[(New)]',
    );
    expect(added.meta.layout).toEqual({ Z: [10, 20] });
  });

  it("adds, edits, reconnects and removes edges", () => {
    const src = "flowchart LR\n  A --> B";
    let doc = parseMermaid(src);
    doc = applyEdit(doc, {
      type: "addEdge",
      edge: { source: "B", target: "C", label: "next", pattern: "dotted" },
    });
    expect(doc.source).toBe("flowchart LR\n  A --> B\n  B -.->|next| C");
    const edge = doc.graph.edges[1]!;
    doc = applyEdit(doc, { type: "setEdgeLabel", id: edge.id, label: "then" });
    expect(doc.source).toBe("flowchart LR\n  A --> B\n  B -.->|then| C");
    doc = applyEdit(doc, {
      type: "setEdgeStyle",
      id: doc.graph.edges[1]!.id,
      pattern: "thick",
      arrowEnd: "arrow_cross",
      length: 2,
    });
    expect(doc.source).toBe("flowchart LR\n  A --> B\n  B ===x|then| C");
    doc = applyEdit(doc, {
      type: "reconnectEdge",
      id: doc.graph.edges[1]!.id,
      source: "A",
      target: "C",
    });
    expect(doc.source).toBe("flowchart LR\n  A --> B\n  A ===x|then| C");
    doc = applyEdit(doc, { type: "removeEdges", ids: [doc.graph.edges[0]!.id] });
    // Deleting an edge never deletes nodes: B survives as a bare mention.
    expect(doc.source).toBe("flowchart LR\n  B\n  A ===x|then| C");
    expect(doc.graph.nodes.map((n) => n.id).sort()).toEqual(["A", "B", "C"]);
  });

  it("reads back an edge label containing a pipe", async () => {
    let doc = parseMermaid("flowchart LR\n  A --> B");
    doc = applyEdit(doc, { type: "setEdgeLabel", id: doc.graph.edges[0]!.id, label: "p|q" });
    expect(doc.source).toBe('flowchart LR\n  A -->|"p|q"| B');
    expect(doc.graph.edges.map((e) => [e.source, e.target, e.label])).toEqual([["A", "B", "p|q"]]);
    const theirs = normaliseSummary(await mermaidSummary(doc.source));
    expect(normaliseSummary(diagramSummary(doc.graph)).edges).toEqual(theirs.edges);
  });

  it("reads Ursula's `%% @ursula` comment and `ursula:` frontmatter, and writes `@pixerate`", () => {
    const doc = parseMermaid('flowchart LR\n  %% @ursula {"v":1,"layout":{"a":[1,2]}}\n  a --> b');
    expect(doc.meta.layout).toEqual({ a: [1, 2] });
    expect(serializeMermaid(doc)).toBe('flowchart LR\n  %% @pixerate {"v":1,"layout":{"a":[1,2]}}\n  a --> b');
    const req = parseMermaid('---\nursula: {"v":1,"layout":{"r":[5,6]}}\n---\nrequirementDiagram\n  requirement r {\n  }\n');
    expect(req.meta.layout).toEqual({ r: [5, 6] });
    const moved = applyEdit(req, { type: "moveNodes", moves: [{ id: "r", position: [7, 8] }] });
    expect(moved.source.startsWith('---\npixerate: {"v":1,"layout":{"r":[7,8]}}\n---')).toBe(true);
  });

  it("imports positions from a legacy `%% @layout` comment", () => {
    const src = 'flowchart LR\n  a --> b\n%% @layout {"a":[10,20],"b":[300,20]}';
    const doc = parseMermaid(src);
    expect(doc.meta.layout).toEqual({ a: [10, 20], b: [300, 20] });
    expect(doc.graph.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    // Rewritten as `@pixerate` once serialised, so the file never carries two.
    const moved = applyEdit(doc, { type: "moveNodes", moves: [{ id: "a", position: [50, 60] }] });
    expect(moved.source).toBe(
      'flowchart LR\n  %% @pixerate {"v":1,"layout":{"a":[50,60],"b":[300,20]}}\n  a --> b',
    );
  });

  it("prefers `@pixerate` / `@ursula` positions over legacy ones and drops a malformed legacy line", () => {
    const both = parseMermaid(
      'flowchart TD\n  %% @ursula {"v":1,"layout":{"a":[1,2]}}\n  a --> b\n  %% @layout {"a":[9,9],"b":[5,5]}',
    );
    expect(both.meta.layout).toEqual({ a: [1, 2], b: [5, 5] });
    const bad = parseMermaid("flowchart TD\n  a --> b\n  %% @layout {oops");
    expect(bad.meta.layout).toBeUndefined();
    expect(bad.graph.nodes).toHaveLength(2);
  });

  it("isolates one pair of a fan-out when editing", () => {
    const src = "flowchart LR\n  A[Start] --> B & C";
    const doc = parseMermaid(src);
    const toC = doc.graph.edges.find((e) => e.target === "C")!;
    const next = applyEdit(doc, { type: "setEdgeLabel", id: toC.id, label: "alt" });
    expect(next.source).toBe("flowchart LR\n  A[Start] --> B\n  A -->|alt| C");
  });

  it("groups, renames, redirects and ungroups subgraphs", () => {
    let doc = parseMermaid("flowchart LR\n  A --> B\n  C");
    doc = applyEdit(doc, { type: "groupNodes", groupId: "G", label: "Group", nodeIds: ["A", "B"] });
    expect(doc.source).toBe(
      "flowchart LR\n  A --> B\n  C\n  subgraph G [Group]\n    A\n    B\n  end",
    );
    expect(doc.graph.nodes.find((n) => n.id === "A")!.parentId).toBe("G");
    doc = applyEdit(doc, { type: "renameGroup", id: "G", label: "Renamed" });
    expect(doc.graph.groups[0]!.label).toBe("Renamed");
    doc = applyEdit(doc, { type: "setGroupDirection", id: "G", direction: "TB" });
    expect(doc.source).toContain("subgraph G [Renamed]\n    direction TB\n");
    doc = applyEdit(doc, { type: "ungroup", groupId: "G" });
    expect(doc.source).toBe("flowchart LR\n  A --> B\n  C\n  A\n  B");
    expect(doc.graph.groups).toHaveLength(0);
  });

  it("sets direction, title, classDefs, classes, styles and links", () => {
    let doc = parseMermaid("graph TD\n  A --> B");
    doc = applyEdit(doc, { type: "setDirection", direction: "LR" });
    expect(doc.source.startsWith("graph LR\n")).toBe(true);
    doc = applyEdit(doc, { type: "setTitle", title: "Hello" });
    expect(doc.source.startsWith("---\ntitle: Hello\n---\ngraph LR")).toBe(true);
    doc = applyEdit(doc, { type: "setClassDef", name: "hot", styles: ["fill:#f00"] });
    doc = applyEdit(doc, { type: "setNodeClasses", id: "A", classes: ["hot", "big"] });
    expect(doc.source).toContain("A:::hot --> B");
    expect(doc.source).toContain("class A big");
    doc = applyEdit(doc, { type: "setNodeStyles", id: "B", styles: ["stroke:#0f0"] });
    expect(doc.source).toContain("style B stroke:#0f0");
    doc = applyEdit(doc, {
      type: "setNodeLink",
      id: "A",
      link: "https://x.y",
      target: "_blank",
      tooltip: "Go",
    });
    expect(doc.source).toContain('click A href "https://x.y" "Go" _blank');
    expect(doc.graph.nodes.find((n) => n.id === "A")!.link).toBe("https://x.y");
    doc = applyEdit(doc, { type: "setTitle", title: undefined });
    expect(doc.source.startsWith("graph LR")).toBe(true);
  });

  it("stores layout metadata as a comment that Mermaid ignores", async () => {
    const doc = applyEdit(parseMermaid("flowchart LR\n  A --> B"), {
      type: "moveNodes",
      moves: [
        { id: "A", position: [0, 0] },
        { id: "B", position: [200.4, 10.6] },
      ],
    });
    expect(doc.source).toBe(
      'flowchart LR\n  %% @pixerate {"v":1,"layout":{"A":[0,0],"B":[200,11]}}\n  A --> B',
    );
    const reparsed = parseMermaid(doc.source);
    expect(reparsed.meta.layout).toEqual({ A: [0, 0], B: [200, 11] });
    const theirs = await mermaidSummary(doc.source);
    expect(theirs.edges).toHaveLength(1);
  });

  it("every edited document is still valid Mermaid", async () => {
    let doc = parseMermaid(KITCHEN_SINK);
    doc = applyEdit(doc, { type: "renameNode", id: "B", label: "Is it ready?" });
    doc = applyEdit(doc, { type: "setNodeShape", id: "C", shape: "hex" });
    doc = applyEdit(doc, { type: "addEdge", edge: { source: "Q", target: "R", label: "done" } });
    doc = applyEdit(doc, { type: "removeNodes", ids: ["D"] });
    doc = applyEdit(doc, {
      type: "groupNodes",
      groupId: "Tail",
      label: "Tail",
      nodeIds: ["P", "Q"],
    });
    const ours = normaliseSummary(diagramSummary(doc.graph));
    const theirs = normaliseSummary(await mermaidSummary(doc.source));
    expect(ours.edges).toEqual(theirs.edges);
    expect(ours.nodes).toEqual(theirs.nodes);
  });
});


const STATE = `stateDiagram-v2
  direction LR
  [*] --> Idle
  Idle --> Running : start
  state "Doing work" as Running
  state Running {
    direction TB
    [*] --> Step1
    Step1 --> Step2 : next
    Step2 --> [*]
  }
  state fork_state <<fork>>
  Running --> fork_state
  fork_state --> A
  fork_state --> B
  note right of Idle
    Waiting for input
  end note
  Idle : entry / reset
  classDef warm fill:#fc9
  class A warm
  B:::warm --> [*]
`;

const CLASS = `classDiagram
  direction LR
  class Animal {
    <<abstract>>
    +int age
    +String gender
    +isMammal() bool
  }
  class Duck["Rubber Duck"]:::toy
  Animal <|-- Duck : extends
  Animal "1" *-- "many" Leg
  Duck ..> Pond : swims in
  Zebra : +bool is_wild
  namespace Farm {
    class Cow
  }
  note for Duck "Squeaks"
  classDef toy fill:#ff0
`;

const ER = `erDiagram
  direction LR
  CUSTOMER ||--o{ ORDER : places
  CUSTOMER {
    string name PK "full name"
    int id
  }
  ORDER }|..|| "LINE ITEM" : contains
  ORDER[Purchase] {
    int number
  }
`;

async function mermaidEdgeCount(src: string): Promise<{ nodes: number; edges: number }> {
  const mermaid = await loadMermaid();
  const d = await mermaid.mermaidAPI.getDiagramFromText(src);
  const data = (
    d.db as unknown as {
      getData: () => { nodes: { id: string; shape?: string }[]; edges: { id: string }[] };
    }
  ).getData();
  // Mermaid materialises notes as extra nodes/edges; the diagram module keeps notes as passthrough text.
  const isNote = (x: { id: string; shape?: string }) =>
    /note/i.test(x.id) || /note/i.test(x.shape ?? "");
  return {
    nodes: data.nodes.filter((n) => !isNote(n)).length,
    edges: data.edges.filter((e) => !isNote(e)).length,
  };
}

describe("state diagram grammar", () => {
  it("round-trips untouched", () => {
    expect(serializeMermaid(parseMermaid(STATE))).toBe(STATE);
  });

  it("builds the graph", () => {
    const doc = parseMermaid(STATE);
    expect(doc.family).toBe("state");
    expect(doc.tier).toBe("editable");
    expect(doc.graph.direction).toBe("LR");
    const ids = doc.graph.nodes.map((n) => n.id).sort();
    expect(ids).toEqual([
      "A",
      "B",
      "Idle",
      "Running_end",
      "Running_start",
      "Step1",
      "Step2",
      "fork_state",
      "root_end",
      "root_start",
    ]);
    const running = doc.graph.groups.find((g) => g.id === "Running")!;
    expect(running.label).toBe("Doing work");
    expect(running.direction).toBe("TB");
    expect(doc.graph.nodes.find((n) => n.id === "Step1")!.parentId).toBe("Running");
    expect(doc.graph.nodes.find((n) => n.id === "fork_state")!.shape).toBe("fork");
    expect(doc.graph.nodes.find((n) => n.id === "Idle")!.data?.descriptions).toEqual([
      "entry / reset",
    ]);
    expect(doc.graph.nodes.find((n) => n.id === "A")!.classes).toEqual(["warm"]);
    expect(doc.graph.nodes.find((n) => n.id === "B")!.classes).toEqual(["warm"]);
    expect(doc.graph.edges).toHaveLength(9);
    expect(doc.graph.edges.find((e) => e.source === "Idle")!.label).toBe("start");
  });

  it("edits and stays valid", async () => {
    let doc = parseMermaid(STATE);
    doc = applyEdit(doc, { type: "renameNode", id: "Idle", label: "Waiting" });
    expect(doc.source).toContain('state "Waiting" as Idle');
    doc = applyEdit(doc, {
      type: "addNode",
      node: { id: "Done", label: "All done" },
      position: [1, 2],
    });
    doc = applyEdit(doc, {
      type: "addEdge",
      edge: { source: "A", target: "Done", label: "finish" },
    });
    expect(doc.source).toContain("A --> Done : finish");
    const toEnd = doc.graph.edges.find((e) => e.target === "root_end" && e.source === "B")!;
    doc = applyEdit(doc, { type: "removeEdges", ids: [toEnd.id] });
    expect(doc.source).not.toContain("B:::warm --> [*]");
    doc = applyEdit(doc, { type: "addEdge", edge: { source: "Done", target: "root_end" } });
    expect(doc.source).toContain("Done --> [*]");
    doc = applyEdit(doc, { type: "setNodeShape", id: "Done", shape: "choice" });
    expect(doc.source).toContain('state "All done" as Done <<choice>>');
    doc = applyEdit(doc, { type: "setDirection", direction: "TB" });
    expect(doc.source).toContain("direction TB\n  [*] --> Idle");
    doc = applyEdit(doc, {
      type: "groupNodes",
      groupId: "Tail",
      label: "Tail",
      nodeIds: ["A", "B"],
    });
    expect(doc.graph.nodes.find((n) => n.id === "A")!.parentId).toBe("Tail");
    const counts = await mermaidEdgeCount(doc.source);
    expect(counts.edges).toBe(doc.graph.edges.length);
  });
});

describe("class diagram grammar", () => {
  it("round-trips untouched", () => {
    expect(serializeMermaid(parseMermaid(CLASS))).toBe(CLASS);
  });

  it("builds the graph", () => {
    const doc = parseMermaid(CLASS);
    expect(doc.family).toBe("class");
    const animal = doc.graph.nodes.find((n) => n.id === "Animal")!;
    expect((animal.data!.members as unknown[]).length).toBe(3);
    expect(animal.data!.annotations).toEqual(["abstract"]);
    const duck = doc.graph.nodes.find((n) => n.id === "Duck")!;
    expect(duck.label).toBe("Rubber Duck");
    expect(duck.classes).toEqual(["toy"]);
    expect(doc.graph.nodes.find((n) => n.id === "Cow")!.parentId).toBe("Farm");
    const inh = doc.graph.edges.find((e) => e.source === "Animal" && e.target === "Duck")!;
    expect(inh.arrowStart).toBe("extension");
    expect(inh.label).toBe("extends");
    const comp = doc.graph.edges.find((e) => e.target === "Leg")!;
    expect(comp.arrowStart).toBe("composition");
    expect(comp.data).toEqual({ cardinalityStart: "1", cardinalityEnd: "many" });
    expect(doc.graph.edges.find((e) => e.target === "Pond")!.pattern).toBe("dotted");
    expect(
      (doc.graph.nodes.find((n) => n.id === "Zebra")!.data!.members as { raw: string }[])[0]!.raw,
    ).toBe("+bool is_wild");
  });

  it("edits and stays valid", async () => {
    let doc = parseMermaid(CLASS);
    doc = applyEdit(doc, { type: "renameNode", id: "Animal", label: "Creature" });
    expect(doc.source).toContain('class Animal["Creature"] {');
    expect(doc.source).toContain("+isMammal() bool");
    doc = applyEdit(doc, {
      type: "addNode",
      node: { id: "Tail", data: { members: [{ raw: "+int length", kind: "attribute" }] } },
    });
    expect(doc.source).toContain("class Tail {\n    +int length\n  }");
    doc = applyEdit(doc, {
      type: "addEdge",
      edge: { source: "Animal", target: "Tail", arrowStart: "aggregation", arrowEnd: "none" },
    });
    expect(doc.source).toContain("Animal o-- Tail");
    const e = doc.graph.edges.find((e) => e.target === "Tail")!;
    doc = applyEdit(doc, {
      type: "setEdgeStyle",
      id: e.id,
      arrowStart: "none",
      arrowEnd: "extension",
      pattern: "dotted",
    });
    expect(doc.source).toContain("Animal ..|> Tail");
    doc = applyEdit(doc, { type: "removeNodes", ids: ["Pond"] });
    expect(doc.source).not.toContain("Pond");
    const counts = await mermaidEdgeCount(doc.source);
    expect(counts.edges).toBe(doc.graph.edges.length);
  });
});

describe("ER diagram grammar", () => {
  it("round-trips untouched", () => {
    expect(serializeMermaid(parseMermaid(ER))).toBe(ER);
  });

  it("builds the graph", () => {
    const doc = parseMermaid(ER);
    expect(doc.family).toBe("er");
    expect(doc.graph.nodes.map((n) => n.id).sort()).toEqual(["CUSTOMER", "LINE ITEM", "ORDER"]);
    const customer = doc.graph.nodes.find((n) => n.id === "CUSTOMER")!;
    const attrs = customer.data!.attributes as { name: string; keys: string[]; comment?: string }[];
    expect(attrs[0]).toMatchObject({ name: "name", keys: ["PK"], comment: "full name" });
    expect(doc.graph.nodes.find((n) => n.id === "ORDER")!.label).toBe("Purchase");
    const rel = doc.graph.edges[0]!;
    expect(rel).toMatchObject({
      source: "CUSTOMER",
      target: "ORDER",
      label: "places",
      arrowStart: "only_one",
      arrowEnd: "zero_or_more",
      pattern: "solid",
    });
    expect(doc.graph.edges[1]).toMatchObject({
      arrowStart: "one_or_more",
      arrowEnd: "only_one",
      pattern: "dotted",
    });
  });

  it("edits and stays valid", async () => {
    let doc = parseMermaid(ER);
    doc = applyEdit(doc, {
      type: "addNode",
      node: { id: "PRODUCT", data: { attributes: [{ raw: "string sku PK" }] } },
    });
    doc = applyEdit(doc, {
      type: "addEdge",
      edge: {
        source: "LINE ITEM",
        target: "PRODUCT",
        label: "refers to",
        arrowStart: "zero_or_more",
        arrowEnd: "only_one",
      },
    });
    expect(doc.source).toContain('"LINE ITEM" }o--|| PRODUCT : "refers to"');
    const e = doc.graph.edges.find((e) => e.target === "PRODUCT")!;
    doc = applyEdit(doc, { type: "setEdgeLabel", id: e.id, label: "uses" });
    expect(doc.source).toContain('"LINE ITEM" }o--|| PRODUCT : uses');
    doc = applyEdit(doc, { type: "renameNode", id: "CUSTOMER", label: "Client" });
    expect(doc.source).toContain('CUSTOMER["Client"] {');
    const counts = await mermaidEdgeCount(doc.source);
    expect(counts.edges).toBe(doc.graph.edges.length);
    expect(counts.nodes).toBe(doc.graph.nodes.length);
  });
});


describe("findMermaidSources", () => {
  it("takes a bare diagram as one source", () => {
    expect(findMermaidSources("flowchart LR\n  A --> B\n\n")).toEqual([
      { source: "flowchart LR\n  A --> B\n", family: "flowchart" },
    ]);
  });

  it("titles a diagram from its frontmatter", () => {
    const [found] = findMermaidSources("---\ntitle: Order flow\n---\nsequenceDiagram\n  A->>B: hi");
    expect(found?.family).toBe("sequence");
    expect(found?.title).toBe("Order flow");
    expect(found?.source.startsWith("---\ntitle: Order flow")).toBe(true);
  });

  it("finds every mermaid block in Markdown, titled by the heading above it", () => {
    const md = [
      "# Design notes",
      "Some prose.",
      "## Checkout",
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "```",
      "```ts",
      "const flowchart = 1;",
      "```",
      "## Timeline",
      "~~~~ Mermaid",
      "timeline",
      "  2026 : Launch",
      "~~~~",
    ].join("\n");
    expect(findMermaidSources(md)).toEqual([
      { source: "flowchart TD\n  A --> B\n", family: "flowchart", title: "Checkout" },
      { source: "timeline\n  2026 : Launch\n", family: "timeline", title: "Timeline" },
    ]);
  });

  it("accepts an unmarked fence that holds a diagram", () => {
    expect(findMermaidSources("```\npie title Pets\n  \"Dogs\" : 3\n```").map((f) => f.family)).toEqual(["pie"]);
  });

  it("ignores prose and other code", () => {
    expect(findMermaidSources("Timeline of events for the launch")).toEqual([]);
    expect(findMermaidSources("```js\ngraph()\n```")).toEqual([]);
    expect(findMermaidSources("")).toEqual([]);
    expect(findMermaidSources("```mermaid\nnot a diagram\n```")).toEqual([]);
  });

  it("strips a byte order mark and keeps C4 headers", () => {
    expect(findMermaidSources("﻿C4Context\n  title System")[0]?.family).toBe("c4");
  });

  it("reads closing-hash headings as titles", () => {
    expect(findMermaidSources("## Order flow ##\n```mermaid\ngraph TD\n  A --> B\n```")[0]?.title).toBe("Order flow");
    expect(findMermaidSources("# C#\n```mermaid\ngraph TD\n  A --> B\n```")[0]?.title).toBe("C#");
  });

  it("stays fast on long runs of whitespace and fence characters", () => {
    const start = performance.now();
    findMermaidSources(`# ${"\t".repeat(50_000)}x\n~~~${"~".repeat(50_000)}\n\`\`\`${" ".repeat(50_000)}\nflowchart${"\t".repeat(50_000)}`);
    expect(performance.now() - start).toBeLessThan(500);
  });
});


describe("regressions", () => {
  it("edits members of `;`-joined flowchart lines without losing the others", () => {
    const doc = parseMermaid("graph TD;\n  A-->B; B-->C;\n  C --> D");
    const renamed = applyEdit(doc, { type: "renameNode", id: "B", label: "Mid" });
    expect(renamed.source).toBe("graph TD;\n  A --> B[Mid]\n  B-->C\n  C --> D");
    const removed = applyEdit(doc, { type: "removeNodes", ids: ["A"] });
    expect(removed.source).toBe("graph TD;\n  B-->C\n  C --> D");
    expect(removed.graph.edges.map((e) => `${e.source}>${e.target}`)).toEqual(["B>C", "C>D"]);
    const label = applyEdit(doc, { type: "setEdgeLabel", id: doc.graph.edges[1]!.id, label: "go" });
    expect(label.source).toBe("graph TD;\n  A-->B\n  B -->|go| C\n  C --> D");
  });

  it("rewrites class bodies when members change", () => {
    const doc = parseMermaid("classDiagram\n  class A {\n    +int x\n  }\n  class B\n  A --> B");
    const edited = applyEdit(doc, {
      type: "setNodeData",
      id: "A",
      data: { members: [{ raw: "+int x" }, { raw: "+go() void" }] },
    });
    expect(edited.source).toBe(
      "classDiagram\n  class A {\n    +int x\n    +go() void\n  }\n  class B\n  A --> B",
    );
    const withBody = applyEdit(edited, {
      type: "setNodeData",
      id: "B",
      data: { members: [{ raw: "-String name" }] },
    });
    expect(withBody.source).toContain("class B {\n    -String name\n  }");
    const cleared = applyEdit(withBody, { type: "setNodeData", id: "A", data: { members: [] } });
    expect(cleared.source).toContain("classDiagram\n  class A\n  class B {");
  });

  it("rewrites ER attribute blocks", () => {
    const doc = parseMermaid("erDiagram\n  A ||--o{ B : has\n  A {\n    int id PK\n  }");
    const edited = applyEdit(doc, {
      type: "setNodeData",
      id: "A",
      data: { attributes: [{ raw: "int id PK" }, { raw: "string name" }] },
    });
    expect(edited.source).toBe(
      "erDiagram\n  A ||--o{ B : has\n  A {\n    int id PK\n    string name\n  }",
    );
    expect(
      (edited.graph.nodes.find((n) => n.id === "A")!.data!.attributes as unknown[]).length,
    ).toBe(2);
  });

  it("removes several flowchart edges at once without hitting the wrong ones", () => {
    const doc = parseMermaid("flowchart LR\n  A --> B --> C\n  A & B --> D\n  C --> E\n  E --> F");
    const byPair = (d: typeof doc, s: string, t: string) =>
      d.graph.edges.find((e) => e.source === s && e.target === t)!.id;
    const removed = applyEdit(doc, {
      type: "removeEdges",
      ids: [byPair(doc, "A", "B"), byPair(doc, "B", "D"), byPair(doc, "E", "F")],
    });
    expect(removed.graph.edges.map((e) => `${e.source}>${e.target}`).sort()).toEqual([
      "A>D",
      "B>C",
      "C>E",
    ]);
    expect(removed.graph.nodes.map((n) => n.id).sort()).toEqual(["A", "B", "C", "D", "E", "F"]);
  });

  it("supports setTitle on render-only documents", () => {
    const doc = parseMermaid("sankey-beta\n  A,B,10");
    const titled = applyEdit(doc, { type: "setTitle", title: "Hello" });
    expect(titled.source).toBe("---\ntitle: Hello\n---\nsankey-beta\n  A,B,10");
    expect(serializeMermaid(parseMermaid(titled.source))).toBe(titled.source);
  });

  it("removing a group id in a flowchart unwraps the subgraph and dedents", () => {
    const doc = parseMermaid("flowchart LR\n  subgraph G [Group]\n    A --> B\n  end\n  B --> C");
    const removed = applyEdit(doc, { type: "removeNodes", ids: ["G"] });
    expect(removed.source).toBe("flowchart LR\n    A --> B\n  B --> C");
    const ungrouped = applyEdit(doc, { type: "ungroup", groupId: "G" });
    expect(ungrouped.source).toBe("flowchart LR\n  A --> B\n  B --> C");
  });

  it("keeps otherwise-unmentioned bare nodes when their only edge is removed", () => {
    const doc = parseMermaid("flowchart LR\n  A --> B\n  B --> C");
    const removed = applyEdit(doc, { type: "removeEdges", ids: [doc.graph.edges[0]!.id] });
    expect(removed.source).toBe("flowchart LR\n  A\n  B --> C");
    const mid = applyEdit(parseMermaid("flowchart LR\n  A --> B --> C\n  A --> C"), {
      type: "removeNodes",
      ids: ["B"],
    });
    expect(mid.source).toBe("flowchart LR\n  A --> C");
  });

  it("does not mistake a plain state named like a pseudo-state for [*]", () => {
    const doc = parseMermaid("stateDiagram-v2\n  Game_end\n  Idle --> Game_end");
    const edited = applyEdit(doc, {
      type: "addEdge",
      edge: { source: "Idle", target: "Game_end", label: "x" },
    });
    expect(edited.source).toContain("Idle --> Game_end : x");
    const toEnd = applyEdit(doc, { type: "addEdge", edge: { source: "Idle", target: "root_end" } });
    expect(toEnd.source).toContain("Idle --> [*]");
  });

  it("ER groupNodes is a no-op", () => {
    const doc = parseMermaid("erDiagram\n  A ||--o{ B : has");
    expect(applyEdit(doc, { type: "groupNodes", groupId: "g", label: "g", nodeIds: ["A"] })).toBe(
      doc,
    );
  });
});
