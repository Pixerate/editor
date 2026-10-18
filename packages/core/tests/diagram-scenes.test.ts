// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EDITABLE_DIAGRAM_FAMILIES, FAMILY_TEMPLATES, parseMermaid } from "../src/diagram";
import { DIAGRAM_SCENE_DARK_THEME, DIAGRAM_TITLE_TARGET, diagramRenameOp, diagramTargetLabel, hasFamilyScene, mermaidToScene, mermaidToSvg } from "../src/canvas";

const GRAPH_FAMILIES = ["flowchart", "state", "class", "er"];

describe("family pictures", () => {
  it("draws every editable family except the graph ones, and exports it as SVG", () => {
    for (const family of EDITABLE_DIAGRAM_FAMILIES) {
      const doc = parseMermaid(FAMILY_TEMPLATES[family]!);
      const scene = mermaidToScene(doc, { theme: DIAGRAM_SCENE_DARK_THEME });
      if (GRAPH_FAMILIES.includes(family)) {
        expect(scene, family).toBeNull();
        continue;
      }
      expect(hasFamilyScene(family), family).toBe(true);
      expect(scene!.marks.length, family).toBeGreaterThan(0);
      expect(scene!.width, family).toBeGreaterThan(0);
      for (const node of doc.graph.nodes) expect(scene!.marks.some((m) => m.target === node.id), `${family}:${node.id}`).toBe(true);
      const { svg } = mermaidToSvg(doc, { theme: DIAGRAM_SCENE_DARK_THEME });
      expect(svg, family).not.toMatch(/NaN|undefined/);
      expect(svg, family).toContain("data-target=");
    }
  });

  it("marks the selection and keeps text-only families out", () => {
    const doc = parseMermaid(FAMILY_TEMPLATES.pie!);
    const id = doc.graph.nodes[0]!.id;
    const scene = mermaidToScene(doc, { selection: [id] })!;
    expect(scene.marks.filter((m) => m.selected).every((m) => m.target === id)).toBe(true);
    expect(scene.marks.some((m) => m.selected)).toBe(true);
    expect(mermaidToScene(parseMermaid("sankey-beta\n  a,b,1\n"))).toBeNull();
  });

  it("maps a double-clicked target to the right rename", () => {
    const doc = parseMermaid(FAMILY_TEMPLATES.sequence!);
    const edge = doc.graph.edges[0]!;
    expect(diagramRenameOp(doc, DIAGRAM_TITLE_TARGET, "")).toEqual({ type: "setTitle", title: undefined });
    expect(diagramRenameOp(doc, "U", "You")).toEqual({ type: "renameNode", id: "U", label: "You" });
    expect(diagramRenameOp(doc, edge.id, "Ask")).toEqual({ type: "setEdgeLabel", id: edge.id, label: "Ask" });
    expect(diagramRenameOp(doc, "nope", "x")).toBeNull();
    expect(diagramTargetLabel(doc, "U")).toBe("User");
  });
});
