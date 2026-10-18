// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools";
import {
  DiagramController,
  EDITABLE_DIAGRAM_FAMILIES,
  FAMILY_BLANKS,
  FAMILY_TEMPLATES,
  checkFieldData,
  createDiagramToolProvider,
  diagramShapes,
  familyUI,
  parseMermaid,
  pieUI,
  validateDiagramEdit,
} from "../src/diagram";
import { expectValidMermaid } from "./helpers/mermaid";

const setup = (source: string) => {
  const controller = new DiagramController({ source });
  const registry = new ToolRegistry();
  registry.register(createDiagramToolProvider(controller));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result: any = await registry.callTool(name, args);
    return { error: result.isError ? (result.content[0].text as string) : null, value: result.structuredContent as any };
  };
  return { controller, call };
};

describe("family vocabulary", () => {
  it("covers every editable family, and every template parses as that family", async () => {
    for (const family of EDITABLE_DIAGRAM_FAMILIES) {
      expect(familyUI(family)?.family, family).toBe(family);
      const doc = parseMermaid(FAMILY_TEMPLATES[family]!);
      expect(doc.family, family).toBe(family);
      expect(doc.tier, family).toBe("editable");
      expect(parseMermaid(FAMILY_BLANKS[family]!).family, family).toBe(family);
      await expectValidMermaid(FAMILY_TEMPLATES[family]!);
    }
    expect(familyUI("sankey")).toBeNull();
  });

  it("offers shapes only where there is a choice", () => {
    expect(diagramShapes("pie")).toEqual([]);
    expect(diagramShapes("mindmap").length).toBeGreaterThan(1);
    expect(diagramShapes("c4")).toContain("c4-person");
  });

  it("refuses directions for families positioned by their data", () => {
    const pie = parseMermaid(FAMILY_TEMPLATES.pie!);
    expect(validateDiagramEdit(pie, { type: "setDirection", direction: "LR" })).toMatch(/pie diagrams have no direction/);
    const git = parseMermaid(FAMILY_TEMPLATES.gitGraph!);
    expect(validateDiagramEdit(git, { type: "setDirection", direction: "LR" })).toBeNull();
  });

  it("checks field values and turns null into a cleared field", () => {
    expect(checkFieldData(pieUI.nodeFields, { value: 3 }, "a slice")).toEqual({ value: 3 });
    expect(checkFieldData(pieUI.nodeFields, { value: null }, "a slice")).toEqual({ value: undefined });
    expect(() => checkFieldData(pieUI.nodeFields, { value: -1 }, "a slice")).toThrow(/at least 0/);
    expect(() => checkFieldData(pieUI.nodeFields, { value: "3" }, "a slice")).toThrow(/takes a number; got "3"/);
    expect(() => checkFieldData(pieUI.nodeFields, { size: 3 }, "a slice")).toThrow(/Unknown field "size" for a slice; use one of "value"/);
    expect(() => checkFieldData(undefined, { size: 3 }, "a flowchart node")).toThrow(/has no data fields/);
  });
});

describe("diagram agent tools for chart families", () => {
  it("reads fields, values and settings", async () => {
    const { call } = setup(FAMILY_TEMPLATES.pie!);
    const { value } = await call("get_diagram");
    expect(value).toMatchObject({ family: "pie", editable: true, title: "Share by segment", settings: { showData: true } });
    expect(value.fields.node).toEqual([{ key: "value", label: "Value", type: "number", min: 0 }]);
    expect(value.fields.diagram[0]).toMatchObject({ key: "showData", type: "boolean" });
    expect(value.nodes[0]).toMatchObject({ label: "Segment A", data: { value: 40 } });
  });

  it("adds a slice with the family's id and defaults, or with given data", async () => {
    const { call, controller } = setup(FAMILY_TEMPLATES.pie!);
    const added = await call("add_diagram_node", { label: "Segment D" });
    expect(added.error).toBeNull();
    expect(added.value.node.id).toBe("slice4");
    expect(controller.getSource()).toContain('"Segment D" : 10');
    const valued = await call("add_diagram_node", { label: "Segment E", data: { value: 5 } });
    expect(valued.error).toBeNull();
    expect(controller.getSource()).toContain('"Segment E" : 5');
    expect((await call("add_diagram_node", { label: "Bad", data: { size: 1 } })).error).toMatch(/Unknown field "size"/);
    await expectValidMermaid(controller.getSource());
  });

  it("sets node data as one undo step and returns it", async () => {
    const { call, controller } = setup(FAMILY_TEMPLATES.pie!);
    const id = (await call("get_diagram")).value.nodes[0].id;
    const before = controller.getSource();
    const result = await call("set_diagram_node_data", { id, data: { value: 55 } });
    expect(result.error).toBeNull();
    expect(result.value.node).toMatchObject({ id, data: { value: 55 } });
    expect(controller.getSource()).toContain('"Segment A" : 55');
    await call("undo_diagram");
    expect(controller.getSource()).toBe(before);
    expect((await call("set_diagram_node_data", { id: "nope", data: { value: 1 } })).error).toMatch(/There is no node "nope"/);
    expect((await call("set_diagram_node_data", { id, data: { value: "x" } })).error).toMatch(/takes a number/);
    expect(controller.getSource()).toBe(before);
  });

  it("moves a quadrant point by its coordinates", async () => {
    const { call, controller } = setup(FAMILY_TEMPLATES.quadrant!);
    const point = (await call("get_diagram")).value.nodes.find((n: any) => n.label === "Idea A");
    expect(point.data).toMatchObject({ x: 0.3, y: 0.8 });
    const result = await call("set_diagram_node_data", { id: point.id, data: { x: 0.9 } });
    expect(result.value.node.data).toMatchObject({ x: 0.9, y: 0.8 });
    expect(controller.getSource()).toContain("Idea A: [0.9, 0.8]");
  });

  it("changes settings and the title", async () => {
    const { call, controller } = setup(FAMILY_TEMPLATES.pie!);
    const settings = await call("set_diagram_settings", { data: { showData: false } });
    expect(settings.value).toEqual({ settings: { showData: false } });
    expect(controller.getSource()).toMatch(/^pie\n/);
    expect((await call("set_diagram_settings", { data: { showData: "yes" } })).error).toMatch(/takes true or false/);
    const title = await call("set_diagram_title", { title: "Market share" });
    expect(title.value).toEqual({ title: "Market share" });
    expect(controller.getSource()).toContain("title Market share");
    expect((await call("set_diagram_title", { title: null })).value).toEqual({ title: null });
    expect(controller.getSource()).not.toContain("title");
  });

  it("sets edge data on sequence messages", async () => {
    const { call, controller } = setup(FAMILY_TEMPLATES.sequence!);
    const { value } = await call("get_diagram");
    expect(value.fields.edge.map((f: any) => f.key)).toEqual(["activate", "deactivate", "index"]);
    const result = await call("set_diagram_edge_data", { id: value.edges[0].id, data: { activate: true } });
    expect(result.error).toBeNull();
    expect(controller.getSource()).toContain("U->>+S: Request");
    expect((await call("set_diagram_edge_data", { id: "nope", data: { activate: true } })).error).toMatch(/There is no edge "nope"/);
  });

  it("refuses data on families without fields, and sets nothing on text-only families", async () => {
    const flow = setup("flowchart TD\n  A --> B\n");
    expect((await flow.call("set_diagram_settings", { data: { x: 1 } })).error).toMatch(/has no data fields/);
    const sankey = setup("sankey-beta\n  a,b,1\n");
    expect((await sankey.call("set_diagram_title", { title: "x" })).error).toMatch(/only be changed as Mermaid text/);
  });
});

describe("agent tools for what people do by dragging", () => {
  it("reorders sequence participants and journey tasks, across sections", async () => {
    const { call, controller } = setup("sequenceDiagram\n  participant A\n  participant B\n  participant C\n  A->>B: hi\n");
    const moved = await call("reorder_diagram_node", { id: "C", before: "A" });
    expect(moved.error).toBeNull();
    expect(moved.value.order).toEqual(["C", "A", "B"]);
    expect(controller.getSource().indexOf("participant C")).toBeLessThan(controller.getSource().indexOf("participant A"));
    expect((await call("reorder_diagram_node", { id: "A", before: null })).value.order).toEqual(["C", "B", "A"]);
    await call("undo_diagram");
    expect((await call("get_diagram")).value.nodes.map((n: any) => n.id)).toContain("C");
    await expectValidMermaid(controller.getSource());

    const journey = setup(FAMILY_TEMPLATES.journey!);
    const ids = (await journey.call("get_diagram")).value.nodes.map((n: any) => n.id);
    const res = await journey.call("reorder_diagram_node", { id: ids[2], before: ids[0] });
    expect(res.value.order[0]).toBe(ids[2]);
    expect(res.value.parentId).toBeDefined();
  });

  it("explains reorders it cannot make", async () => {
    const { call } = setup(FAMILY_TEMPLATES.pie!);
    expect((await call("reorder_diagram_node", { id: "slice1", before: null })).error).toMatch(/have no order to change/);
    const seq = setup(FAMILY_TEMPLATES.sequence!);
    expect((await seq.call("reorder_diagram_node", { id: "Q", before: null })).error).toMatch(/There is no node "Q"/);
  });

  it("moves architecture services into and out of a group", async () => {
    const { call, controller } = setup(FAMILY_TEMPLATES.architecture!);
    const into = await call("set_diagram_node_parent", { ids: ["edge"], parentId: "app" });
    expect(into.error).toBeNull();
    expect(into.value.nodes[0]).toMatchObject({ id: "edge", parentId: "app" });
    expect(controller.getSource()).toContain("service edge(internet)[Edge] in app");
    const out = await call("set_diagram_node_parent", { ids: ["web"], parentId: null });
    expect(out.value.nodes[0].parentId).toBeUndefined();
    expect((await call("set_diagram_node_parent", { ids: ["web"], parentId: "nope" })).error).toMatch(/There is no group "nope"/);
    expect((setup(FAMILY_TEMPLATES.pie!).call("set_diagram_node_parent", { ids: ["slice1"], parentId: null }))).resolves.toMatchObject({ error: expect.stringMatching(/have no groups/) });
    await expectValidMermaid(controller.getSource());
  });
});
