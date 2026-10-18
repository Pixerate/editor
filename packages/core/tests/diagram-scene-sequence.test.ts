// @vitest-environment jsdom
// Ports the intent of Ursula's src/react/canvases/sequence.test.ts to the headless scene.
import { describe, expect, it } from "vitest";
import { FAMILY_TEMPLATES, parseMermaid } from "../src/diagram";
import { DIAGRAM_SCENE_LIGHT_THEME, DIAGRAM_TITLE_TARGET, ensureDiagramLayout, type DiagramMark } from "../src/canvas";
import { sequenceScene } from "../src/canvas/mermaid/families/sequence.js";
import { SEQUENCE_METRICS, sequenceGeometry } from "../src/diagram/sequence/geometry.js";

const SRC = [
  "sequenceDiagram",
  "  autonumber",
  "  participant A as Alice",
  "  participant B as Bob",
  "  A->>+B: Hello",
  "  Note over A,B: Thinking",
  "  alt Happy",
  "    B-->>-A: Hi",
  "  else Sad",
  "    B--xA: Go away",
  "  end",
].join("\n");

const RICH = `sequenceDiagram
  title Checkout
  box rgb(200,220,240) Payments
    participant P as Payments API
    participant B as Bank
  end
  box Front
    actor U as Customer
  end
  U->>P: pay
  P-)B: authorise
  B->>B: check
  loop Retry
    P->>B: poll
    opt Slow
      Note right of B: waiting
    end
  end
  activate P
  B--xP: declined
  deactivate P
`;

function scene(src: string) {
  const doc = parseMermaid(src);
  expect(doc.family).toBe("sequence");
  const layout = ensureDiagramLayout(doc.graph, doc.meta, { family: doc.family });
  const marks = sequenceScene({ graph: doc.graph, layout, theme: DIAGRAM_SCENE_LIGHT_THEME, selection: new Set() });
  return { doc, marks, geo: sequenceGeometry(doc.graph) };
}

function numericFields(m: DiagramMark): number[] {
  const out: number[] = [];
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === "number") out.push(v);
    if (k === "box" && v) out.push(...Object.values(v as Record<string, number>));
  }
  return out;
}

function expectWellFormed(marks: DiagramMark[]) {
  const keys = marks.map((m) => m.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const m of marks) {
    expect(m.role).toBeTruthy();
    expect(m.selected).toBeUndefined();
    for (const n of numericFields(m)) expect(Number.isFinite(n)).toBe(true);
    if (m.kind === "path") expect(m.d).not.toMatch(/NaN|undefined/);
  }
}

const targets = (marks: DiagramMark[]) => new Set(marks.map((m) => m.target).filter(Boolean));

describe("sequence scene", () => {
  it("draws the template", () => {
    const { doc, marks } = scene(FAMILY_TEMPLATES.sequence!);
    expectWellFormed(marks);
    const t = targets(marks);
    for (const n of doc.graph.nodes) expect(t.has(n.id)).toBe(true);
    for (const e of doc.graph.edges) expect(t.has(e.id)).toBe(true);
  });

  it("draws lifelines, mirrored participants, rows, notes, fragments and activations", () => {
    const { doc, marks, geo } = scene(SRC);
    expectWellFormed(marks);
    const t = targets(marks);
    for (const n of doc.graph.nodes) expect(t.has(n.id)).toBe(true);
    for (const e of doc.graph.edges) expect(t.has(e.id)).toBe(true);

    // One lifeline per participant, from the boxes to the mirrors, selecting the participant.
    const lifelines = marks.filter((m) => m.role === "lifeline");
    expect(lifelines.map((m) => m.target)).toEqual(["A", "B"]);
    for (const l of lifelines) {
      if (l.kind !== "line") throw new Error("lifeline is a line");
      const col = geo.columns.get(l.target!)!;
      expect([l.x1, l.x2, l.y1, l.y2]).toEqual([col.center, col.center, geo.lifelineTop, geo.lifelineBottom]);
    }
    // Participants on top, mirrored under the lifelines.
    for (const id of ["A", "B"]) {
      const col = geo.columns.get(id)!;
      const top = marks.find((m) => m.key === `participant:${id}`);
      const mirror = marks.find((m) => m.key === `mirror:${id}`);
      expect(top).toMatchObject({ kind: "rect", x: col.x, y: 0, width: col.width, height: SEQUENCE_METRICS.actorHeight, target: id });
      expect(mirror).toMatchObject({ kind: "rect", x: col.x, y: geo.lifelineBottom, width: col.width });
    }
    expect(marks.find((m) => m.key === "participant-label:A")).toMatchObject({ text: "Alice" });

    // One message each, top to bottom, on the geometry's rows and numbered.
    const messages = marks.filter((m) => m.role === "message");
    expect(messages.map((m) => m.target)).toEqual(doc.graph.edges.map((e) => e.id));
    const ys = messages.map((m) => (m.kind === "line" ? m.y1 : NaN));
    expect(ys).toEqual(geo.messages.map((r) => r.y));
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    const numbers = marks.filter((m) => m.kind === "text" && m.role === "message-number");
    expect(numbers.map((m) => (m.kind === "text" ? m.text : ""))).toEqual(["1", "2", "3"]);
    // Arrow heads and patterns: ->> filled, -->> dotted, --x a cross.
    const [hello, hi, away] = messages;
    expect(hello).toMatchObject({ markerEnd: "arrowclosed" });
    expect(hello).not.toHaveProperty("dash");
    expect(hi).toMatchObject({ markerEnd: "arrowclosed", dash: "6 4" });
    expect(away).not.toHaveProperty("markerEnd");
    expect(marks.some((m) => m.role === "message-head" && m.target === away!.target)).toBe(true);
    // The arrow stops 2px short of the target lifeline.
    const a = geo.columns.get("A")!.center;
    const b = geo.columns.get("B")!.center;
    expect(hello).toMatchObject({ x1: a, x2: b - 2 });
    expect(hi).toMatchObject({ x1: b, x2: a + 2 });
    expect(marks.find((m) => m.key === `message-label:${hello!.target}`)).toMatchObject({ text: "Hello", x: (a + b) / 2, y: geo.messages[0]!.y - 13 });

    // Note, fragment (keyword, condition, one divider) and activation from the geometry.
    const note = geo.notes[0]!;
    expect(marks.find((m) => m.key === "note:0")).toMatchObject({ x: note.x, y: note.y, width: note.width, height: note.height });
    expect(marks.find((m) => m.key === "note-text:0")).toMatchObject({ text: "Thinking" });
    const frag = geo.fragments[0]!;
    expect(marks.find((m) => m.key === "fragment:0")).toMatchObject({ x: frag.x, y: frag.y, width: frag.width, height: frag.height });
    expect(marks.find((m) => m.key === "fragment-keyword:0")).toMatchObject({ text: "alt" });
    expect(marks.find((m) => m.key === "fragment-text:0")).toMatchObject({ text: "[Happy]" });
    expect(marks.filter((m) => m.role === "fragment-divider")).toHaveLength(1);
    expect(marks.find((m) => m.key === "fragment-divider-text:0:0")).toMatchObject({ text: "[Sad]" });
    const act = geo.activations[0]!;
    expect(marks.find((m) => m.key === "activation:0")).toMatchObject({ x: act.x, y: act.top, width: SEQUENCE_METRICS.activationWidth });

    // Decorations select nothing.
    for (const m of marks.filter((m) => /^(note|fragment|activation)/.test(m.role))) expect(m.target).toBeUndefined();
    // Messages draw last, above the participants and notes.
    const lastNonMessage = marks.findLastIndex((m) => !m.role.startsWith("message"));
    expect(marks.findIndex((m) => m.role === "message")).toBeGreaterThan(lastNonMessage);
  });

  it("draws boxes, actors, self messages, nested fragments and the title", () => {
    const { doc, marks, geo } = scene(RICH);
    expectWellFormed(marks);
    const t = targets(marks);
    for (const n of doc.graph.nodes) expect(t.has(n.id)).toBe(true);
    for (const e of doc.graph.edges) expect(t.has(e.id)).toBe(true);
    for (const g of doc.graph.groups) expect(t.has(g.id)).toBe(true);

    const title = marks.find((m) => m.role === "title");
    expect(title).toMatchObject({ kind: "text", text: "Checkout", target: DIAGRAM_TITLE_TARGET });

    // Boxes span the geometry's frame, filled with their colour, labelled.
    const pay = geo.boxes.get("Payments")!;
    expect(marks.find((m) => m.key === "box:Payments")).toMatchObject({ ...pay, fill: "rgb(200,220,240)", target: "Payments" });
    expect(marks.find((m) => m.key === "box:Front")).toMatchObject({ fill: "none" });
    expect(marks.find((m) => m.key === "box-label:Payments")).toMatchObject({ text: "Payments" });

    // An actor is a stick figure over its name, not a box.
    expect(marks.find((m) => m.key === "participant:U")).toBeUndefined();
    expect(marks.filter((m) => m.role === "participant-figure" && m.target === "U")).toHaveLength(2);
    expect(marks.find((m) => m.key === "participant-label:U")).toMatchObject({ text: "Customer" });

    // The self message loops out to the right, label beside it.
    const selfRow = geo.messages.find((r) => r.self)!;
    const self = marks.find((m) => m.key === `message:${selfRow.edgeId}`)!;
    expect(self.kind).toBe("path");
    if (self.kind === "path") {
      const x = geo.columns.get("B")!.center;
      expect(self.d).toBe(`M${x},${selfRow.y - 10} H${x + 44} V${selfRow.y + 10} H${x + 4}`);
      expect(self.box).toBeDefined();
    }
    // Async (-)) is an open arrow.
    const async = doc.graph.edges.find((e) => e.label === "authorise")!;
    expect(marks.find((m) => m.key === `message:${async.id}`)).toMatchObject({ markerEnd: "arrow" });

    // Nested fragments: both drawn, outer before inner.
    expect(geo.fragments).toHaveLength(2);
    const order = marks.filter((m) => m.role === "fragment-keyword").map((m) => (m.kind === "text" ? m.text : ""));
    expect(order).toEqual(["loop", "opt"]);
    expect(marks.filter((m) => m.role === "activation")).toHaveLength(geo.activations.length);
    // No numbers without autonumber.
    expect(marks.some((m) => m.role === "message-number")).toBe(false);
  });

  it("draws an empty diagram without failing", () => {
    const { marks } = scene("sequenceDiagram\n");
    expectWellFormed(marks);
    expect(marks).toEqual([]);
  });
});
