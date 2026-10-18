// @vitest-environment jsdom
// Ported from Ursula (src/pie/pie.test.ts).
import { describe, expect, it } from "vitest";
import { applyEdit, applyEdits, parseMermaid, serializeMermaid } from "../src/diagram/index.js";
import { ensureDiagramLayout } from "../src/canvas/mermaid/layout.js";
import { expectValidMermaid, mermaidDb } from "./helpers/mermaid";
import { PIE_METRICS, pieGeometry } from "../src/diagram/pie/geometry.js";

const SRC = `pie showData
  title Support tickets by channel
  "Email" : 42
  "Chat" : 31
  "Phone" : 15
`;

describe("pie adapter", () => {
  it("round-trips untouched", () => {
    const doc = parseMermaid(SRC);
    expect(doc.family).toBe("pie");
    expect(doc.tier).toBe("editable");
    expect(serializeMermaid(doc)).toBe(SRC);
  });

  it("builds slices with values and the header flag", () => {
    const doc = parseMermaid(SRC);
    expect(doc.graph.nodes.map((n) => [n.id, n.label, n.data?.value])).toEqual([
      ["Email", "Email", 42],
      ["Chat", "Chat", 31],
      ["Phone", "Phone", 15],
    ]);
    expect(doc.graph.title).toBe("Support tickets by channel");
    expect(doc.graph.data?.showData).toBe(true);
    expect(doc.graph.edges).toEqual([]);
  });

  it("adds, renames, revalues and removes slices", async () => {
    const doc = parseMermaid(SRC);
    const added = applyEdit(doc, {
      type: "addNode",
      node: { id: "x", label: "Community", data: { value: 12 } },
    });
    expect(added.source).toContain('  "Phone" : 15\n  "Community" : 12\n');
    expect(added.graph.nodes.at(-1)?.id).toBe("Community");

    const renamed = applyEdit(added, { type: "renameNode", id: "Chat", label: "Live chat" });
    expect(renamed.source).toContain('"Live chat" : 31');
    expect(renamed.graph.nodes[1]!.id).toBe("Live_chat");

    const revalued = applyEdit(renamed, { type: "setNodeData", id: "Email", data: { value: 50 } });
    expect(revalued.source).toContain('"Email" : 50');

    const removed = applyEdit(revalued, { type: "removeNodes", ids: ["Phone"] });
    expect(removed.source).not.toContain("Phone");
    expect(removed.graph.nodes).toHaveLength(3);
    await expectValidMermaid(removed.source);
    const db = await mermaidDb<{ getSections: () => Map<string, number> }>(removed.source);
    expect([...db.getSections().entries()]).toEqual([
      ["Email", 50],
      ["Live chat", 31],
      ["Community", 12],
    ]);
  });

  it("edits the title and header flag", async () => {
    const doc = parseMermaid(SRC);
    const next = applyEdits(doc, [
      { type: "setTitle", title: "Channels" },
      { type: "setGraphData", data: { showData: false } },
    ]);
    expect(next.source.startsWith("pie\n  title Channels\n")).toBe(true);
    expect(next.graph.data?.showData).toBe(false);
    await expectValidMermaid(next.source);

    const headerTitle = parseMermaid('pie title Pets\n  "Dogs" : 3\n');
    const edited = applyEdit(headerTitle, { type: "setTitle", title: "Animals" });
    expect(edited.source).toBe('pie title Animals\n  "Dogs" : 3\n');
    const noTitle = applyEdit(parseMermaid('pie\n  "Dogs" : 3\n'), {
      type: "setTitle",
      title: "Pets",
    });
    expect(noTitle.source).toBe('pie\n  title Pets\n  "Dogs" : 3\n');
  });

  it("keeps unknown lines verbatim", () => {
    const src = 'pie\n  accTitle: Accessible\n  %% note\n  "A" : 1\n';
    const doc = parseMermaid(src);
    const next = applyEdit(doc, { type: "setNodeData", id: "A", data: { value: 2 } });
    expect(next.source).toBe('pie\n  accTitle: Accessible\n  %% note\n  "A" : 2\n');
  });

  it("ignores drop positions for new slices", () => {
    const doc = parseMermaid(SRC);
    const added = applyEdit(doc, {
      type: "addNode",
      node: { id: "x", label: "Web", data: { value: 5 } },
      position: [400, 300],
    });
    expect(added.meta.layout ?? {}).toEqual({});
  });

  it("computes Mermaid's pie geometry", async () => {
    const { graph } = parseMermaid(SRC);
    const geo = pieGeometry(graph);
    // 450 px frame, radius 450 / 2 - 40, centred.
    expect([geo.cx, geo.cy, geo.radius, geo.outerRadius]).toEqual([225, 225, 185, 186]);
    expect(geo.slices.map((s) => [s.id, s.labelText, s.colorIndex, s.drawn])).toEqual([
      ["Email", "48%", 0, true],
      ["Chat", "35%", 1, true],
      ["Phone", "17%", 2, true],
    ]);
    // Clockwise from 12 o'clock, in document order, sized by value.
    const [email, chat, phone] = geo.slices;
    expect(email!.startAngle).toBe(0);
    expect(email!.endAngle).toBeCloseTo((42 / 88) * 2 * Math.PI);
    expect(chat!.startAngle).toBe(email!.endAngle);
    expect(phone!.endAngle).toBeCloseTo(2 * Math.PI);
    expect(email!.path.startsWith("M225,40A185,185,0,0,1,")).toBe(true);
    expect(email!.path.endsWith("L225,225Z")).toBe(true);
    // Labels at 0.75 of the radius on the wedge's bisector.
    const mid = email!.endAngle / 2;
    expect(email!.labelX).toBeCloseTo(225 + 185 * 0.75 * Math.sin(mid), 2);
    expect(email!.labelY).toBeCloseTo(225 - 185 * 0.75 * Math.cos(mid), 2);
    // Legend to the right (12 squares from the centre), rows centred vertically.
    expect(geo.legend.map((l) => [l.text, l.x, l.y])).toEqual([
      ["Email [42]", 441, 192],
      ["Chat [31]", 441, 214],
      ["Phone [15]", 441, 236],
    ]);
    expect(geo.title).toEqual({ text: "Support tickets by channel", x: 225, y: 25 });
    // Every slice node shares the pie's square.
    const layout = await ensureDiagramLayout(graph, { v: 1 }, { family: "pie" });
    expect(layout.positions.Email).toEqual([geo.box.x, geo.box.y]);
    expect(layout.positions.Phone).toEqual([geo.box.x, geo.box.y]);
    expect(layout.sizes.Chat).toEqual({ width: geo.box.width, height: geo.box.height });
  });

  it("follows Mermaid for tiny slices and repeated labels", () => {
    const { graph } = parseMermaid('pie\n  "Big" : 1000\n  "Tiny" : 5\n  "Big" : 3\n');
    const geo = pieGeometry(graph);
    expect(geo.slices.map((s) => [s.id, s.drawn])).toEqual([
      ["Big", true],
      ["Tiny", false],
      ["Big_2", false],
    ]);
    // Under 1 %: no wedge, so the big slice is the whole circle; still in the legend.
    expect(geo.slices[0]!.path).toMatch(/^M225,40A185,185,0,1,1,225,410A185,185,0,1,1,225,40Z$/);
    expect(geo.slices[0]!.labelText).toBe("100%");
    expect(geo.legend.map((l) => l.text)).toEqual(["Big", "Tiny"]);
    expect(geo.title).toBeUndefined();
    expect(PIE_METRICS.minPercent).toBe(1);
  });
});
