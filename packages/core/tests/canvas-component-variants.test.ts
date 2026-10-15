import { describe, it, expect } from "vitest";
import { HistoryManager } from "../src/history";
import {
  addCanvasVariant,
  bindCanvasComponentProperty,
  combineCanvasComponentsAsVariants,
  createCanvasComponent,
  createCanvasComponentsController,
  createCanvasInstance,
  getComponentSourceId,
  getInstanceData,
  getLayerName,
  getNextVariantValues,
  getNodeSize,
  getVariantConflicts,
  getVariantOptions,
  getVariantValues,
  inspectCanvasInstance,
  removeCanvasVariant,
  renameCanvasVariantProperty,
  renameCanvasVariantValue,
  setCanvasComponentProperty,
  setCanvasInstanceProperties,
  setCanvasVariantProperties,
  syncCanvasComponents,
  type CanvasComponentResult,
  type CanvasNode,
} from "../src/canvas";
import { CommandRegistry, createComponentCommands } from "../src/commands";
import { ToolRegistry, createCanvasComponentToolProvider } from "../src/agent";

const STYLES = { Primary: "#2563eb", Secondary: "#e2e8f0" } as const;
const SIZES = { Small: [100, 40], Large: [140, 50] } as const;

function ok(result: CanvasComponentResult): CanvasNode[] {
  if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
  return result.nodes;
}

/** Button set (Style × Size, each variant with a "Bg" rect and a "Label" text), a Label text property and two instances. */
function buttonSet(): CanvasNode[] {
  let nodes: CanvasNode[] = [];
  const ids: string[] = [];
  (["Primary", "Secondary"] as const).forEach((style, row) => {
    (["Small", "Large"] as const).forEach((size, col) => {
      const id = `${style}-${size}`.toLowerCase();
      const [w, h] = SIZES[size];
      nodes.push(
        { id, type: "group", position: { x: col * 160, y: row * 70 }, width: w, height: h, data: { label: `Style=${style}, Size=${size}` } },
        { id: `${id}-bg`, type: "shape", parentId: id, position: { x: 0, y: 0 }, width: w, height: h, data: { label: "Bg", shape: { kind: "rect", fill: STYLES[style] } } },
        { id: `${id}-label`, type: "text", parentId: id, position: { x: 10, y: 10 }, data: { label: "Button", name: "Label" } },
      );
      ids.push(id);
    });
  });
  for (const id of ids) nodes = ok(createCanvasComponent(nodes, [id]));
  nodes = ok(combineCanvasComponentsAsVariants(nodes, ids, { id: "set", name: "Button" }));
  nodes = ok(setCanvasComponentProperty(nodes, "set", "Text", { type: "text", default: "Button" }));
  for (const id of ids) nodes = ok(bindCanvasComponentProperty(nodes, `${id}-label`, "data.label", "Text"));
  nodes = ok(createCanvasInstance(nodes, "set", { id: "i1", position: { x: 0, y: 300 }, properties: { Style: "Primary", Size: "Small", Text: "Buy" } }));
  nodes = ok(createCanvasInstance(nodes, "set", { id: "i2", position: { x: 200, y: 300 }, properties: { Style: "Secondary", Size: "Large" } }));
  // An override on i1's background.
  const bg = nodes.find((n) => n.parentId === "i1" && getLayerName(n) === "Bg")!.id;
  nodes = syncCanvasComponents(nodes, nodes.map((n) => (n.id === bg ? { ...n, data: { ...n.data, shape: { ...n.data.shape, strokeWidth: 3 } } } : n)));
  return nodes;
}

const get = (nodes: CanvasNode[], id: string) => {
  const n = nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n;
};
const kids = (nodes: CanvasNode[], id: string) => nodes.filter((n) => n.parentId === id);
const mainOf = (nodes: CanvasNode[], id: string) => getInstanceData(get(nodes, id))?.componentId;
const layerOf = (nodes: CanvasNode[], inst: string, name: string) => kids(nodes, inst).find((n) => getLayerName(n) === name)!;

/** Every instance mirrors its main's layers, parents come before children. */
function healthy(nodes: CanvasNode[]) {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  for (const n of nodes) if (n.parentId) expect(index.get(n.parentId)! < index.get(n.id)!, `${n.parentId} before ${n.id}`).toBe(true);
  for (const n of nodes) {
    const inst = getInstanceData(n);
    if (!inst) continue;
    const mirrored = kids(nodes, n.id).map((k) => getComponentSourceId(k));
    expect(mirrored, `${n.id} mirrors ${inst.componentId}`).toEqual(kids(nodes, inst.componentId).map((k) => k.id));
  }
}

describe("variants: add", () => {
  it("duplicates a variant with new ids and a new value of an existing property", () => {
    const before = buttonSet();
    const r = addCanvasVariant(before, "set", { from: "primary-small", variant: { Size: "Medium" } });
    expect(r.ok).toBe(true);
    const nodes = ok(r);
    const id = r.ok ? r.ids[0] : "";
    expect(id).toBe("set-variant");
    const v = get(nodes, id);
    expect(v.parentId).toBe("set");
    expect(getVariantValues(v)).toEqual({ Style: "Primary", Size: "Medium" });
    expect(v.data.label).toBe("Style=Primary, Size=Medium");
    // Layers copied with fresh ids, same names and look; the source is untouched.
    const layers = kids(nodes, id);
    expect(layers.map(getLayerName)).toEqual(["Bg", "Label"]);
    expect(layers.every((l) => !before.some((b) => b.id === l.id))).toBe(true);
    expect(layers[0].data.shape.fill).toBe(STYLES.Primary);
    expect(layers[1].data.componentPropertyRefs).toEqual({ "data.label": "Text" });
    expect(kids(nodes, "primary-small").map((n) => n.id)).toEqual(["primary-small-bg", "primary-small-label"]);
    // Placed in a free spot in the set, which grew to fit it.
    const rects = kids(nodes, "set").filter((n) => n.id !== id).map((n) => ({ ...n.position, ...getNodeSize(n) }));
    const size = getNodeSize(v);
    for (const r2 of rects) {
      const overlaps = v.position.x < r2.x + r2.width && r2.x < v.position.x + size.width && v.position.y < r2.y + r2.height && r2.y < v.position.y + size.height;
      expect(overlaps).toBe(false);
    }
    expect(v.position.y).toBe(get(before, "primary-small").position.y);
    const set = getNodeSize(get(nodes, "set"));
    expect(set.width).toBeGreaterThanOrEqual(v.position.x + size.width);
    expect(getVariantOptions(nodes, "set")).toEqual([
      { name: "Style", values: ["Primary", "Secondary"] },
      { name: "Size", values: ["Small", "Large", "Medium"] },
    ]);
    // Instances keep working: pickers show the new value, and switching keeps overrides.
    expect(inspectCanvasInstance(nodes, "i1")!.variantOptions.find((o) => o.name === "Size")!.values).toContain("Medium");
    const switched = ok(setCanvasInstanceProperties(nodes, ["i1"], { Size: "Medium" }));
    expect(mainOf(switched, "i1")).toBe(id);
    expect(layerOf(switched, "i1", "Bg").data.shape.strokeWidth).toBe(3);
    expect(layerOf(switched, "i1", "Label").data.label).toBe("Buy");
    healthy(switched);
  });

  it("adds a new property to every variant with a default value", () => {
    const nodes = ok(addCanvasVariant(buttonSet(), "set", { from: "secondary-large", variant: { State: "Hover" }, id: "hover" }));
    expect(getVariantValues(get(nodes, "hover"))).toEqual({ Style: "Secondary", Size: "Large", State: "Hover" });
    expect(getVariantValues(get(nodes, "primary-small"))).toEqual({ Style: "Primary", Size: "Small", State: "Default" });
    expect(get(nodes, "primary-small").data.label).toBe("Style=Primary, Size=Small, State=Default");
    expect(getVariantOptions(nodes, "set").map((o) => o.name)).toEqual(["Style", "Size", "State"]);
    expect(getVariantConflicts(nodes, "set")).toEqual([]);
    // Instances stay on their variant and can pick the new property.
    expect(mainOf(nodes, "i2")).toBe("secondary-large");
    expect(inspectCanvasInstance(nodes, "i2")!.variant).toEqual({ Style: "Secondary", Size: "Large", State: "Default" });
    const hovered = ok(setCanvasInstanceProperties(nodes, ["i2"], { State: "Hover" }));
    expect(mainOf(hovered, "i2")).toBe("hover");
    healthy(hovered);
    // A custom default value.
    const custom = ok(addCanvasVariant(buttonSet(), "set", { variant: { Tone: "Loud" }, defaultValue: "Calm" }));
    expect(getVariantValues(get(custom, "secondary-small")).Tone).toBe("Calm");
  });

  it("defaults to duplicating the default variant with the next unused value", () => {
    const before = buttonSet();
    expect(getNextVariantValues(before, "set")).toEqual({ Style: "Variant5", Size: "Small" });
    const r = addCanvasVariant(before, "set");
    const nodes = ok(r);
    expect(getVariantValues(get(nodes, "set-variant"))).toEqual({ Style: "Variant5", Size: "Small" });
    expect(getNextVariantValues(nodes, "set")).toEqual({ Style: "Variant6", Size: "Small" });
    expect(ok(addCanvasVariant(nodes, "set")).some((n) => n.id === "set-variant-2")).toBe(true);
  });

  it("refuses duplicate combinations and invalid names", () => {
    const before = buttonSet();
    const dup = addCanvasVariant(before, "set", { from: "primary-small", variant: { Size: "Large" } });
    expect(dup).toMatchObject({ ok: false, code: "invalid", reason: "A variant with Style=Primary, Size=Large exists already." });
    expect(dup.nodes).toBe(before);
    // A new property whose value equals the others' default duplicates the source.
    expect(addCanvasVariant(before, "set", { variant: { State: "Default" } })).toMatchObject({ ok: false, reason: expect.stringContaining("exists already") });
    expect(addCanvasVariant(before, "set", { variant: { "Si,ze": "x" } })).toMatchObject({ ok: false, reason: expect.stringContaining('","') });
    expect(addCanvasVariant(before, "set", { variant: { Size: " " } })).toMatchObject({ ok: false, reason: "Variant values must not be empty." });
    expect(addCanvasVariant(before, "set", { variant: { Text: "x" } })).toMatchObject({ ok: false, reason: '"Text" is a component property.' });
    expect(addCanvasVariant(before, "primary-small")).toMatchObject({ ok: false, code: "not-found" });
    expect(addCanvasVariant(before, "set", { from: "i1" })).toMatchObject({ ok: false, code: "not-found" });
    expect(addCanvasVariant(before, "set", { id: "i1", variant: { Size: "Medium" } })).toMatchObject({ ok: false, reason: 'Id "i1" is taken.' });
  });

  it("uses the set's auto layout when it has one", () => {
    let nodes = buttonSet();
    nodes = nodes.map((n) => (n.id === "set" ? { ...n, data: { ...n.data, layout: { mode: "horizontal", gap: 10, padding: 20, sizing: { width: "hug", height: "hug" } } } } : n));
    nodes = syncCanvasComponents(buttonSet(), nodes);
    const added = ok(addCanvasVariant(nodes, "set", { from: "primary-small", variant: { Size: "Medium" }, id: "m" }));
    const m = get(added, "m");
    const xs = kids(added, "set").map((n) => n.position.x);
    expect(m.position.x).toBe(Math.max(...xs));
    expect(getNodeSize(get(added, "set")).width).toBeGreaterThanOrEqual(m.position.x + getNodeSize(m).width);
    // Removing closes the gap.
    const removed = ok(removeCanvasVariant(added, "m"));
    expect(getNodeSize(get(removed, "set")).width).toBeLessThan(getNodeSize(get(added, "set")).width);
  });
});

describe("variants: remove", () => {
  it("re-points instances to the closest variant, keeping overrides", () => {
    const before = buttonSet();
    const r = removeCanvasVariant(before, "primary-small");
    const nodes = ok(r);
    expect(r.ok && r.ids).toEqual(["primary-large"]); // Style matches (first of the ties in layer order)
    expect(nodes.some((n) => n.id === "primary-small" || n.parentId === "primary-small")).toBe(false);
    expect(mainOf(nodes, "i1")).toBe("primary-large");
    expect(layerOf(nodes, "i1", "Label").data.label).toBe("Buy");
    expect(layerOf(nodes, "i1", "Bg").data.shape.strokeWidth).toBe(3);
    expect(layerOf(nodes, "i1", "Bg").id).toBe(layerOf(before, "i1", "Bg").id);
    expect(getVariantOptions(nodes, "set")).toEqual([
      { name: "Style", values: ["Primary", "Secondary"] },
      { name: "Size", values: ["Large", "Small"] },
    ]);
    healthy(nodes);
  });

  it("re-points instance swap defaults and values, and refuses the last variant", () => {
    let nodes = buttonSet();
    nodes.push({ id: "card", type: "group", position: { x: 0, y: 600 }, width: 200, height: 100, data: { label: "Card" } });
    nodes = ok(createCanvasComponent(nodes, ["card"]));
    nodes = ok(setCanvasComponentProperty(nodes, "card", "Action", { type: "instanceSwap", default: "secondary-small", preferred: ["secondary-small", "secondary-large"] }));
    nodes = ok(removeCanvasVariant(nodes, "secondary-small"));
    expect(get(nodes, "card").data.component.properties.Action).toMatchObject({ default: "secondary-large", preferred: ["secondary-large"] });
    nodes = ok(removeCanvasVariant(nodes, "secondary-large"));
    nodes = ok(removeCanvasVariant(nodes, "primary-large"));
    expect(mainOf(nodes, "i1")).toBe("primary-small");
    expect(mainOf(nodes, "i2")).toBe("primary-small");
    healthy(nodes);
    const last = removeCanvasVariant(nodes, "primary-small");
    expect(last).toMatchObject({ ok: false, code: "invalid", reason: "A component set needs at least one variant: delete the set instead." });
    expect(removeCanvasVariant(nodes, "card")).toMatchObject({ ok: false, code: "not-found" });
  });
});

describe("variants: edit and rename", () => {
  it("edits a variant's values (validated); its instances follow", () => {
    const before = buttonSet();
    const nodes = ok(setCanvasVariantProperties(before, "primary-small", { Size: "Tiny" }));
    expect(get(nodes, "primary-small").data.label).toBe("Style=Primary, Size=Tiny");
    expect(mainOf(nodes, "i1")).toBe("primary-small");
    expect(inspectCanvasInstance(nodes, "i1")!.variant).toEqual({ Style: "Primary", Size: "Tiny" });
    expect(setCanvasVariantProperties(before, "primary-small", { Size: "Large" })).toMatchObject({ ok: false, reason: expect.stringContaining("exists already") });
    expect(setCanvasVariantProperties(before, "primary-small", { Size: "Small" }).nodes).toBe(before);
    expect(setCanvasVariantProperties(before, "set", { Size: "x" })).toMatchObject({ ok: false, code: "not-found" });
    const added = ok(setCanvasVariantProperties(before, "primary-small", { State: "Hover" }));
    expect(getVariantValues(get(added, "primary-large")).State).toBe("Default");
    healthy(nodes);
  });

  it("renames a property across the set; instances keep their variant", () => {
    const before = buttonSet();
    const nodes = ok(renameCanvasVariantProperty(before, "set", "Size", "Scale"));
    expect(getVariantOptions(nodes, "set").map((o) => o.name)).toEqual(["Style", "Scale"]);
    expect(get(nodes, "secondary-large").data.label).toBe("Style=Secondary, Scale=Large");
    expect(inspectCanvasInstance(nodes, "i2")!.variant).toEqual({ Style: "Secondary", Scale: "Large" });
    const switched = ok(setCanvasInstanceProperties(nodes, ["i1"], { Scale: "Large" }));
    expect(mainOf(switched, "i1")).toBe("primary-large");
    expect(renameCanvasVariantProperty(before, "set", "Size", "Style")).toMatchObject({ ok: false, reason: '"Style" exists already.' });
    expect(renameCanvasVariantProperty(before, "set", "Size", "Text")).toMatchObject({ ok: false, reason: '"Text" is a component property.' });
    expect(renameCanvasVariantProperty(before, "set", "Nope", "X")).toMatchObject({ ok: false, code: "unknown-property" });
    expect(renameCanvasVariantProperty(before, "set", "Size", "")).toMatchObject({ ok: false, code: "invalid" });
    // Stray variant keys stored on instances are renamed too.
    const stray = before.map((n) => (n.id === "i1" ? { ...n, data: { ...n.data, instance: { ...n.data.instance, properties: { ...n.data.instance.properties, Size: "Small" } } } } : n));
    expect(get(ok(renameCanvasVariantProperty(stray, "set", "Size", "Scale")), "i1").data.instance.properties).toMatchObject({ Scale: "Small" });
    healthy(nodes);
  });

  it("renames a value across the set; duplicates are refused", () => {
    const before = buttonSet();
    const nodes = ok(renameCanvasVariantValue(before, "set", "Style", "Primary", "Brand"));
    expect(get(nodes, "primary-small").data.label).toBe("Style=Brand, Size=Small");
    expect(get(nodes, "primary-large").data.label).toBe("Style=Brand, Size=Large");
    expect(get(nodes, "secondary-large").data.label).toBe("Style=Secondary, Size=Large");
    expect(inspectCanvasInstance(nodes, "i1")!.variant).toEqual({ Style: "Brand", Size: "Small" });
    expect(inspectCanvasInstance(nodes, "i1")!.variantOptions[0]).toEqual({ name: "Style", values: ["Brand", "Secondary"] });
    expect(renameCanvasVariantValue(before, "set", "Size", "Large", "Small")).toMatchObject({ ok: false, reason: expect.stringContaining("exists already") });
    expect(renameCanvasVariantValue(before, "set", "Size", "Huge", "X")).toMatchObject({ ok: false, reason: '"Size" has no value "Huge".' });
    expect(renameCanvasVariantValue(before, "set", "Size", "Large", "a=b")).toMatchObject({ ok: false, code: "invalid" });
    healthy(nodes);
  });
});

function controllerSetup() {
  const history = new HistoryManager();
  const ctx = { nodes: buttonSet() };
  const controller = createCanvasComponentsController({
    getNodes: () => ctx.nodes,
    setNodes: (n) => {
      ctx.nodes = n;
    },
    history,
  });
  return { ctx, controller, history };
}

describe("variants: controller, commands and agent tools", () => {
  it("is undoable, with reasons", () => {
    const { ctx, controller, history } = controllerSetup();
    const original = ctx.nodes;
    expect(controller.addVariant("set", { from: "primary-small", variant: { Size: "Medium" } })).toMatchObject({ ok: true, ids: ["set-variant"] });
    const added = ctx.nodes;
    history.undo();
    expect(ctx.nodes).toEqual(original);
    history.redo();
    expect(ctx.nodes).toEqual(added);

    expect(controller.removeVariant("primary-small")).toMatchObject({ ok: true });
    expect(mainOf(ctx.nodes, "i1")).toBe("primary-large");
    history.undo();
    expect(mainOf(ctx.nodes, "i1")).toBe("primary-small");
    expect(ctx.nodes).toEqual(added);

    controller.renameVariantProperty("Size", "Scale", "set");
    controller.renameVariantValue("Style", "Primary", "Brand", "set");
    controller.setVariantProperties({ Scale: "Tiny" }, "primary-small");
    expect(get(ctx.nodes, "primary-small").data.label).toBe("Style=Brand, Scale=Tiny");
    history.undo();
    history.undo();
    history.undo();
    expect(ctx.nodes).toEqual(added);

    expect(controller.canAddVariant()).toBe("Select a component set or one of its variants.");
    expect(controller.canAddVariant("set")).toBe(true);
    expect(controller.canAddVariant("set", { from: "primary-small", variant: { Size: "Large" } })).toBe("A variant with Style=Primary, Size=Large exists already.");
    expect(controller.canRemoveVariant()).toBe("Select a variant of a component set.");
    expect(controller.canRemoveVariant("primary-small")).toBe(true);
    expect(controller.canSetVariantProperties({ Size: "Large" }, "primary-small")).toContain("exists already");
    expect(controller.canRenameVariantProperty("Nope", "X", "set")).toBe('Unknown variant property "Nope".');
    expect(controller.canRenameVariantValue("Size", "Large", "Small", "primary-small")).toContain("exists already");
    expect(controller.removeVariant("i1")).toMatchObject({ ok: false });
  });

  it("acts on the selection: a selected variant is duplicated", () => {
    const { ctx, controller } = controllerSetup();
    ctx.nodes = ctx.nodes.map((n) => (n.id === "secondary-large" ? { ...n, selected: true } : n));
    const r = controller.addVariant(undefined, { variant: { Size: "Huge" } });
    expect(r.ok).toBe(true);
    const v = get(ctx.nodes, r.ok ? r.ids[0] : "");
    expect(getVariantValues(v)).toEqual({ Style: "Secondary", Size: "Huge" });
    expect(v.selected).toBeUndefined();
    expect(controller.canRemoveVariant()).toBe(true);
  });

  it("registers commands and agent tools", async () => {
    const { ctx, controller } = controllerSetup();
    const registry = new CommandRegistry();
    registry.register(createComponentCommands(controller));
    expect(registry.list().map((e) => e.id)).toEqual(
      expect.arrayContaining(["canvas.addVariant", "canvas.removeVariant", "canvas.setVariantProperties", "canvas.renameVariantProperty", "canvas.renameVariantValue"]),
    );
    expect(registry.execute("canvas.addVariant", { setId: "set", from: "primary-small", variant: { Size: "Large" } })).toMatchObject({
      ok: false,
      code: "disabled",
    });
    expect(registry.execute("canvas.addVariant", { setId: "set", variant: { Size: "Medium" } })).toMatchObject({ ok: true, result: { ids: ["set-variant"] } });
    expect(registry.execute("canvas.renameVariantValue", { setId: "set", property: "Size", value: "Medium", newValue: "Mid" })).toMatchObject({ ok: true });
    expect(get(ctx.nodes, "set-variant").data.label).toBe("Style=Primary, Size=Mid");
    expect(registry.execute("canvas.removeVariant", { id: "set-variant" })).toMatchObject({ ok: true });
    expect(ctx.nodes.some((n) => n.id === "set-variant")).toBe(false);
    // Targets without variant methods get no variant commands.
    const { addVariant: _a, removeVariant: _r, ...plain } = controller;
    expect(createComponentCommands(plain).some((c) => c.id === "canvas.addVariant")).toBe(false);

    const tools = new ToolRegistry();
    tools.register(createCanvasComponentToolProvider(controller));
    const made = await tools.callTool("add_variant", { setId: "set", variant: { State: "Hover" } });
    expect(made.isError).toBeFalsy();
    expect(getVariantOptions(ctx.nodes, "set").map((o) => o.name)).toEqual(["Style", "Size", "State"]);
    expect((await tools.callTool("rename_variant_property", { setId: "set", name: "State", newName: "Mode" })).isError).toBeFalsy();
    expect((await tools.callTool("set_variant_properties", { id: "primary-large", values: { Mode: "Pressed" } })).isError).toBeFalsy();
    expect(getVariantValues(get(ctx.nodes, "primary-large")).Mode).toBe("Pressed");
    expect((await tools.callTool("rename_variant_value", { setId: "set", property: "Mode", value: "Pressed", newValue: "Down" })).isError).toBeFalsy();
    const refused = await tools.callTool("set_variant_properties", { id: "primary-large", values: { Size: "Small", Mode: "Default" } });
    expect(refused.isError).toBe(true);
    expect((await tools.callTool("remove_variant", { id: "primary-large" })).isError).toBeFalsy();
  });
});
