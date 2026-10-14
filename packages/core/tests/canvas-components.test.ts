// Behaviour cases re-expressed from figcraft's crates/engine/src/{components_tests.rs,
// components_behaviour_tests.rs, components_scale_tests.rs} (MIT OR Apache-2.0, © ArtCraft Team
// and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, it, expect } from "vitest";
import {
  bindCanvasComponentProperty,
  combineCanvasComponentsAsVariants,
  createCanvasComponent,
  createCanvasInstance,
  detachCanvasInstance,
  diffOverrideGroups,
  getComponentSourceId,
  getLayerName,
  getInstanceData,
  getInstanceStatus,
  getNodeOverrides,
  getVariantConflicts,
  getVariantOptions,
  inspectCanvasInstance,
  listCanvasComponents,
  parseCanvasClipboardData,
  parseVariantName,
  formatVariantName,
  pushCanvasInstanceOverrides,
  remapPastedNodes,
  resetCanvasInstanceOverrides,
  restoreCanvasMainComponent,
  serializeCanvasNodes,
  setCanvasComponentProperty,
  setCanvasInstanceProperties,
  swapCanvasInstance,
  syncAllCanvasInstances,
  syncCanvasComponents,
  syncCanvasInstance,
  wouldCreateComponentCycle,
  writeOverrideGroup,
  readOverrideGroup,
  bindCanvasToken,
  setCanvasTokenMode,
  resolveCanvasTokens,
  type CanvasComponentResult,
  type CanvasNode,
} from "../src/canvas";
import { createTokenStore } from "../src/tokens";
import { measureGrowth } from "./helpers/growth";

// ---------------------------------------------------------------------------------------------
// Harness: a document whose edits run through `syncCanvasComponents`, like the hooks do.

class Doc {
  nodes: CanvasNode[];
  constructor(nodes: CanvasNode[] = []) {
    this.nodes = nodes;
  }
  /** A user edit (any change to the node array), then the component sync. */
  edit(fn: (nodes: CanvasNode[]) => CanvasNode[]) {
    const before = this.nodes;
    this.nodes = syncCanvasComponents(before, fn(before));
    return this;
  }
  set(id: string, fn: (n: CanvasNode) => CanvasNode) {
    return this.edit((nodes) => nodes.map((n) => (n.id === id ? fn(n) : n)));
  }
  data(id: string, patch: Record<string, unknown>) {
    return this.set(id, (n) => ({ ...n, data: { ...n.data, ...patch } }));
  }
  shape(id: string, patch: Record<string, unknown>) {
    return this.set(id, (n) => ({ ...n, data: { ...n.data, shape: { ...n.data.shape, ...patch } } }));
  }
  remove(...ids: string[]) {
    return this.edit((nodes) => nodes.filter((n) => !ids.includes(n.id)));
  }
  add(...added: CanvasNode[]) {
    return this.edit((nodes) => [...nodes, ...added]);
  }
  run(op: (nodes: CanvasNode[]) => CanvasComponentResult) {
    const r = op(this.nodes);
    if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
    this.nodes = r.nodes;
    return r.ids[0];
  }
  attempt(op: (nodes: CanvasNode[]) => CanvasComponentResult) {
    const r = op(this.nodes);
    if (r.ok) this.nodes = r.nodes;
    return r;
  }
  get(id: string) {
    const n = this.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`no node ${id}`);
    return n;
  }
  has(id: string) {
    return this.nodes.some((n) => n.id === id);
  }
  kids(id: string) {
    return this.nodes.filter((n) => n.parentId === id).map((n) => n.id);
  }
  /** The copy inside instance `inst` mirroring main layer `src`. */
  copyOf(inst: string, src: string) {
    const ids = new Set([inst]);
    for (const n of this.nodes) if (n.parentId && ids.has(n.parentId)) ids.add(n.id);
    const hit = this.nodes.find((n) => ids.has(n.id) && getComponentSourceId(n) === src && n.id !== inst);
    if (!hit) throw new Error(`no copy of ${src} in ${inst}`);
    return hit.id;
  }
  fill(id: string) {
    const n = this.get(id);
    return n.data.shape?.fill ?? n.style?.backgroundColor;
  }
  label(id: string) {
    return this.get(id).data.label;
  }
  overrides(id: string) {
    return [...getNodeOverrides(this.get(id))];
  }
  /** Every instance mirrors its main's layers (structure and sources). */
  healthy() {
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    for (const n of this.nodes) if (n.parentId) expect(byId.has(n.parentId), `${n.id} has a parent`).toBe(true);
    const index = new Map(this.nodes.map((n, i) => [n.id, i]));
    for (const n of this.nodes) if (n.parentId) expect(index.get(n.parentId)! < index.get(n.id)!, `${n.parentId} before ${n.id}`).toBe(true);
    const kids = (id: string) => this.nodes.filter((x) => x.parentId === id);
    const walk = (inst: CanvasNode, main: CanvasNode, depth: number) => {
      if (depth > 16) return;
      const a = kids(inst.id).filter((k) => getComponentSourceId(k) !== undefined);
      const b = kids(main.id);
      expect(a.map((k) => getComponentSourceId(k)), `${inst.id} mirrors ${main.id}`).toEqual(b.map((k) => k.id));
      a.forEach((k, i) => {
        const ki = getInstanceData(k);
        const bi = getInstanceData(b[i]);
        if (ki && bi && ki.componentId !== bi.componentId) {
          const m = byId.get(ki.componentId);
          if (m) walk(k, m, depth + 1);
        } else walk(k, b[i], depth + 1);
      });
    };
    for (const n of this.nodes) {
      const inst = getInstanceData(n);
      if (!inst) continue;
      let inside = false;
      for (let p = byId.get(n.parentId!); p; p = byId.get(p.parentId!)) if (getInstanceData(p)) inside = true;
      const main = byId.get(inst.componentId);
      if (!inside && main) walk(n, main, 0);
    }
  }
}

const frame = (id: string, label: string, x: number, y: number, width: number, height: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  type: "group",
  position: { x, y },
  width,
  height,
  data: { label },
  ...extra,
});
const rect = (id: string, parentId: string, label: string, fill: string, x: number, y: number, width: number, height: number, extra: Record<string, unknown> = {}): CanvasNode => ({
  id,
  type: "shape",
  parentId,
  position: { x, y },
  width,
  height,
  data: { label, shape: { kind: "rect", fill, ...extra } },
});
const text = (id: string, parentId: string, label: string, x: number, y: number): CanvasNode => ({
  id,
  type: "text",
  parentId,
  position: { x, y },
  data: { label },
});

/** Card: 200×100 component with "Bg" rectangle, "Title" text and "Dot" ellipse. */
function card(doc = new Doc()) {
  doc.add(
    frame("card", "Card", 0, 0, 200, 100),
    rect("bg", "card", "Bg", "#eeeeee", 0, 0, 200, 100),
    text("title", "card", "Hello", 10, 10),
    rect("dot", "card", "Dot", "#ff0000", 170, 10, 20, 20),
  );
  doc.run((n) => createCanvasComponent(n, ["card"]));
  return doc;
}

describe("components: create", () => {
  it("turns a frame into a component and wraps other selections in a component frame", () => {
    const doc = card();
    expect(doc.get("card").data.component).toEqual({});
    doc.add(rect("a", "", "A", "#111111", 300, 300, 10, 10), rect("b", "", "B", "#222222", 320, 310, 10, 20));
    doc.set("a", (n) => ({ ...n, parentId: undefined }));
    doc.set("b", (n) => ({ ...n, parentId: undefined }));
    const id = doc.run((n) => createCanvasComponent(n, ["a", "b"], { id: "pair" }));
    expect(id).toBe("pair");
    const pair = doc.get("pair");
    expect(pair.position).toEqual({ x: 300, y: 300 });
    expect([pair.width, pair.height]).toEqual([30, 30]);
    expect(doc.get("a").parentId).toBe("pair");
    expect(doc.get("b").position).toEqual({ x: 20, y: 10 });
    expect(doc.nodes.findIndex((n) => n.id === "pair")).toBeLessThan(doc.nodes.findIndex((n) => n.id === "a"));
    // Refusals.
    expect(createCanvasComponent(doc.nodes, ["card"]).ok).toBe(false);
    expect(createCanvasComponent(doc.nodes, []).ok).toBe(false);
    expect(createCanvasComponent(doc.nodes, ["bg", "a"]).ok).toBe(false); // different parents
  });

  it("creates instances as deep copies with stable source ids", () => {
    const doc = card();
    const i = doc.run((n) => createCanvasInstance(n, "card", { id: "i1" }));
    expect(i).toBe("i1");
    doc.healthy();
    const inst = doc.get("i1");
    expect(getInstanceData(inst)?.componentId).toBe("card");
    expect(inst.position).toEqual({ x: 240, y: 0 });
    expect([inst.width, inst.height]).toEqual([200, 100]);
    expect(inst.data.component).toBeUndefined();
    expect(doc.kids("i1")).toEqual(["i1:bg", "i1:title", "i1:dot"]);
    expect(doc.label("i1:title")).toBe("Hello");
    expect(doc.fill("i1:dot")).toBe("#ff0000");
    expect(getInstanceStatus(doc.nodes, "i1")).toBe("linked");
    // A rebuild without changes changes nothing.
    expect(syncCanvasInstance(doc.nodes, "i1")).toBe(doc.nodes);
    expect(syncAllCanvasInstances(doc.nodes)).toBe(doc.nodes);
  });
});

describe("components: overrides survive main edits (figcraft overrides_survive_main_edits)", () => {
  it("keeps overridden groups, follows the rest, and resets per group or all", () => {
    const doc = card();
    doc.run((n) => createCanvasInstance(n, "card", { id: "i" }));
    const [ibg, ititle, idot] = [doc.copyOf("i", "bg"), doc.copyOf("i", "title"), doc.copyOf("i", "dot")];
    doc.shape(ibg, { fill: "#00ff00", stroke: "#0000ff", strokeWidth: 2 });
    doc.data(ibg, { label: "Background" });
    doc.data(ititle, { label: "Overridden" });
    doc.set(idot, (n) => ({ ...n, hidden: true }));
    expect(doc.overrides(ibg)).toEqual(["data.label", "shape.fill", "shape.stroke", "shape.strokeWidth"]);
    expect(doc.overrides(ititle)).toEqual(["data.label"]);
    expect(doc.overrides(idot)).toEqual(["hidden"]);
    // A layer inside an instance keeps its main's size: a resize is not an override.
    doc.set(idot, (n) => ({ ...n, width: 30 }));
    expect(doc.overrides(idot)).toEqual(["hidden"]);

    // Main edits: overridden groups stay, the rest follows.
    doc.shape("bg", { fill: "#123456", cornerRadius: 8, strokeWidth: 5 });
    doc.data("bg", { label: "Bg2" });
    doc.data("title", { label: "Main text" });
    doc.set("title", (n) => ({ ...n, style: { fontSize: 30 } }));
    doc.shape("dot", { fill: "#00ffff" });
    doc.set("dot", (n) => ({ ...n, width: 10 }));
    doc.set("card", (n) => ({ ...n, style: { backgroundColor: "#fafafa" } }));
    doc.healthy();
    expect(doc.copyOf("i", "bg")).toBe(ibg);
    expect(doc.fill(ibg)).toBe("#00ff00");
    expect(doc.label(ibg)).toBe("Background");
    expect(doc.get(ibg).data.shape.cornerRadius).toBe(8);
    expect(doc.get(ibg).data.shape.strokeWidth).toBe(2);
    expect(doc.label(ititle)).toBe("Overridden");
    expect(doc.get(ititle).style).toEqual({ fontSize: 30 });
    expect(doc.get(idot).hidden).toBe(true);
    expect(doc.get(idot).width).toBe(10);
    expect(doc.fill(idot)).toBe("#00ffff");
    expect(doc.get("i").style).toEqual({ backgroundColor: "#fafafa" });

    // Per-group reset.
    doc.run((n) => resetCanvasInstanceOverrides(n, ibg, "shape.fill"));
    expect(doc.fill(ibg)).toBe("#123456");
    expect(doc.label(ibg)).toBe("Background");
    // Reset all.
    doc.run((n) => resetCanvasInstanceOverrides(n, "i"));
    expect(doc.label(ibg)).toBe("Bg2");
    expect(doc.label(ititle)).toBe("Main text");
    expect(doc.get(idot).hidden).toBeUndefined();
    expect(doc.nodes.every((n) => getNodeOverrides(n).length === 0)).toBe(true);
    doc.healthy();
  });

  it("setting a value back to the main's clears the override", () => {
    const doc = card();
    doc.run((n) => createCanvasInstance(n, "card", { id: "i" }));
    doc.shape("i:bg", { fill: "#000000" });
    expect(doc.overrides("i:bg")).toEqual(["shape.fill"]);
    doc.shape("i:bg", { fill: "#eeeeee" });
    expect(doc.overrides("i:bg")).toEqual([]);
  });

  it("unrelated main edits still reach overridden layers", () => {
    const doc = card();
    doc.run((n) => createCanvasInstance(n, "card", { id: "i" }));
    doc.shape("i:bg", { fill: "#000000" });
    doc.shape("bg", { stroke: "#ff00ff" });
    expect(doc.get("i:bg").data.shape).toMatchObject({ fill: "#000000", stroke: "#ff00ff" });
  });
});

describe("components: structure (figcraft main_structure_edits_propagate)", () => {
  it("adds, reorders and removes layers in every instance, keeping overrides", () => {
    const doc = card();
    doc.run((n) => createCanvasInstance(n, "card", { id: "i" }));
    doc.run((n) => createCanvasInstance(n, "card", { id: "j", position: { x: 0, y: 300 } }));
    doc.shape("i:dot", { fill: "#000000" });
    doc.add(rect("star", "card", "Star", "#ffff00", 100, 50, 20, 20));
    doc.healthy();
    expect(doc.kids("i")).toHaveLength(4);
    expect(doc.kids("j")).toHaveLength(4);
    // Reorder: dot first (array order is layer order).
    doc.edit((nodes) => {
      const dot = nodes.find((n) => n.id === "dot")!;
      const rest = nodes.filter((n) => n.id !== "dot");
      const at = rest.findIndex((n) => n.id === "bg");
      return [...rest.slice(0, at), dot, ...rest.slice(at)];
    });
    doc.healthy();
    expect(doc.kids("i")[0]).toBe("i:dot");
    expect(doc.fill("i:dot")).toBe("#000000");
    // Remove layers.
    doc.remove("title", "star");
    doc.healthy();
    expect(doc.kids("i")).toEqual(["i:dot", "i:bg"]);
    expect(doc.fill("i:dot")).toBe("#000000");
  });

  it("instances never gain or lose layers: deleting hides, adding moves out", () => {
    const doc = card();
    doc.run((n) => createCanvasInstance(n, "card", { id: "i", position: { x: 300, y: 0 } }));
    doc.remove("i:bg");
    doc.healthy();
    expect(doc.get("i:bg").hidden).toBe(true);
    expect(doc.overrides("i:bg")).toEqual(["hidden"]);
    doc.add({ id: "extra", position: { x: 5, y: 5 }, parentId: "i:bg", data: { label: "Extra" } });
    expect(doc.get("extra").parentId).toBeUndefined();
    expect(doc.get("extra").position).toEqual({ x: 305, y: 5 });
    doc.healthy();
    // Deleting the whole instance is fine.
    doc.remove("i", ...doc.kids("i"));
    expect(doc.nodes.some((n) => n.id.startsWith("i:"))).toBe(false);
  });
});

/** Icon component (one "Shape" rectangle) and a Button component holding an Icon instance. */
function button(doc = new Doc()) {
  doc.add(frame("iconf", "Icon", 0, 300, 24, 24), rect("shape", "iconf", "Shape", "#111111", 2, 2, 20, 20));
  doc.run((n) => createCanvasComponent(n, ["iconf"]));
  doc.add(frame("btn", "Button", 0, 400, 120, 40));
  doc.run((n) => createCanvasInstance(n, "iconf", { id: "nested", parentId: "btn", position: { x: 8, y: 8 } }));
  doc.add(text("lbl", "btn", "Go", 40, 10));
  doc.run((n) => createCanvasComponent(n, ["btn"]));
  return doc;
}

describe("components: nested instances (figcraft nested_instances_and_swaps)", () => {
  it("propagates through nested instances, keeps overrides inside them, and swaps", () => {
    const doc = button();
    doc.run((n) => createCanvasInstance(n, "btn", { id: "i", position: { x: 300, y: 400 } }));
    doc.healthy();
    const inested = doc.copyOf("i", "nested");
    const nestedShape = doc.copyOf("nested", "shape");
    const ishape = doc.copyOf("i", nestedShape);
    expect(getInstanceData(doc.get(inested))?.componentId).toBe("iconf");
    // Override inside the nested copy, then edit the Icon main.
    doc.shape(ishape, { fill: "#ff00ff" });
    doc.shape("shape", { fill: "#222222", cornerRadius: 6 });
    doc.healthy();
    expect(doc.fill(nestedShape)).toBe("#222222");
    expect(doc.fill(ishape)).toBe("#ff00ff");
    expect(doc.get(ishape).data.shape.cornerRadius).toBe(6);
    // A main-level override on the nested instance reaches instances.
    doc.shape(nestedShape, { stroke: "#00ff00" });
    expect(doc.overrides(nestedShape)).toEqual(["shape.stroke"]);
    expect(doc.get(ishape).data.shape.stroke).toBe("#00ff00");

    // Swap the nested instance through an instance swap property.
    doc.add(frame("star", "Star icon", 100, 300, 24, 24), rect("glyph", "star", "Glyph", "#999999", 0, 0, 24, 24), rect("spark", "star", "Spark", "#ffffff", 0, 0, 4, 4));
    doc.run((n) => createCanvasComponent(n, ["star"]));
    doc.run((n) => setCanvasComponentProperty(n, "btn", "Icon", { type: "instanceSwap", default: "iconf" }));
    doc.run((n) => bindCanvasComponentProperty(n, "nested", "component", "Icon"));
    doc.healthy();
    doc.run((n) => setCanvasInstanceProperties(n, ["i"], { Icon: "star" }));
    doc.healthy();
    expect(getInstanceData(doc.get(inested))?.componentId).toBe("star");
    expect(doc.kids(inested)).toHaveLength(2);
    // Main edits keep the swap; the swapped icon follows its own main.
    doc.set("btn", (n) => ({ ...n, style: { backgroundColor: "#0000ff" } }));
    doc.add(rect("dot2", "star", "Dot", "#000000", 10, 10, 4, 4));
    doc.healthy();
    expect(getInstanceData(doc.get(inested))?.componentId).toBe("star");
    expect(doc.kids(inested)).toHaveLength(3);
    // Swapping the nested copy directly is an override that survives main edits.
    doc.run((n) => setCanvasInstanceProperties(n, ["i"], { Icon: "iconf" }));
    expect(getInstanceData(doc.get(inested))?.componentId).toBe("iconf");
    doc.run((n) => swapCanvasInstance(n, [inested], "star"));
    expect(doc.overrides(inested)).toContain("component");
    doc.set("btn", (n) => ({ ...n, style: { backgroundColor: "#00ff00" } }));
    doc.healthy();
    expect(getInstanceData(doc.get(inested))?.componentId).toBe("star");
    doc.run((n) => resetCanvasInstanceOverrides(n, inested, "component"));
    expect(getInstanceData(doc.get(inested))?.componentId).toBe("iconf");
    doc.healthy();
    // A nested instance can't be swapped into a component that contains it.
    expect(swapCanvasInstance(doc.nodes, ["nested"], "btn").ok).toBe(false);
  });

  it("prevents cycles: a component can't contain an instance of itself", () => {
    const doc = button();
    expect(createCanvasInstance(doc.nodes, "btn", { parentId: "btn" })).toMatchObject({ ok: false, code: "cycle" });
    // Indirect: Icon would contain Button, which contains Icon.
    expect(wouldCreateComponentCycle(doc.nodes, "btn", "iconf")).toBe(true);
    expect(createCanvasInstance(doc.nodes, "btn", { parentId: "iconf" })).toMatchObject({ ok: false, code: "cycle" });
    expect(wouldCreateComponentCycle(doc.nodes, "iconf", undefined)).toBe(false);
    // And not inside an instance.
    doc.run((n) => createCanvasInstance(n, "btn", { id: "i", position: { x: 300, y: 400 } }));
    expect(createCanvasInstance(doc.nodes, "iconf", { parentId: "i" })).toMatchObject({ ok: false, code: "inside-instance" });
  });
});

/** Button set: State=Default / State=Hover with Bg, Label and (Default only) Badge. */
function buttonSet(doc = new Doc()) {
  const variants: string[] = [];
  ([["Default", "#ffffff", "#222222"], ["Hover", "#eeeeee", "#0000ff"]] as const).forEach(([state, bg, label], k) => {
    const f = `v${k}`;
    doc.add(
      frame(f, `State=${state}`, k * 200, 0, 120, 40, { style: { backgroundColor: "#fafafa", borderRadius: 4 + 4 * k } }),
      rect(`${f}-bg`, f, "Bg", bg, 0, 0, 120, 40, { stroke: "#000000", strokeWidth: 1 }),
      { ...text(`${f}-label`, f, state, 10, 10), data: { label: state, name: "Label" }, style: { color: label } },
    );
    if (k === 0) doc.add(rect(`${f}-badge`, f, "Badge", "#ff0000", 90, 4, 8, 8));
    doc.add(rect(`${f}-dot`, f, "Dot", "#00aa00", 104, 4, 8, 8));
    variants.push(doc.run((n) => createCanvasComponent(n, [f])));
  });
  const set = doc.run((n) => combineCanvasComponentsAsVariants(n, variants, { id: "set", name: "Button" }));
  doc.run((n) => setCanvasComponentProperty(n, set, "Show dot", { type: "boolean", default: true }));
  for (const v of variants) doc.run((n) => bindCanvasComponentProperty(n, `${v}-dot`, "visible", "Show dot"));
  return { doc, set, variants };
}

const layer = (doc: Doc, inst: string, name: string) =>
  doc.kids(inst).find((id) => {
    const src = getComponentSourceId(doc.get(id));
    return src !== undefined && doc.has(src) && getLayerName(doc.get(src)) === name;
  });

describe("components: variants (figcraft variant_switch_keeps_compatible_overrides)", () => {
  it("combines variants and names instances after the set", () => {
    const { doc, set } = buttonSet();
    expect(getVariantOptions(doc.nodes, set)).toEqual([{ name: "State", values: ["Default", "Hover"] }]);
    expect(doc.get("v0").data.component.variant).toEqual({ State: "Default" });
    const i = doc.run((n) => createCanvasInstance(n, set, { id: "i", position: { x: 0, y: 200 } }));
    expect(getInstanceData(doc.get(i))?.componentId).toBe("v0");
    expect(doc.label(i)).toBe("Button");
    const list = listCanvasComponents(doc.nodes);
    expect(list.sets[0]).toMatchObject({ id: "set", name: "Button", defaultVariantId: "v0" });
    expect(list.components.find((c) => c.id === "v0")).toMatchObject({ setId: "set", variant: { State: "Default" }, instanceCount: 1 });
  });

  it("keeps overrides where the variants agreed, text layers keep theirs", () => {
    const { doc } = buttonSet();
    doc.run((n) => createCanvasInstance(n, "set", { id: "i", position: { x: 0, y: 200 } }));
    const bg = layer(doc, "i", "Bg")!;
    const label = layer(doc, "i", "Label")!;
    const dot = layer(doc, "i", "Dot")!;
    const badge = layer(doc, "i", "Badge")!;
    doc.shape(bg, { fill: "#ff00ff", strokeWidth: 4 }); // fill differs between variants, stroke agrees
    doc.data(label, { label: "Buy" });
    doc.set(label, (n) => ({ ...n, style: { color: "#ff8800" } }));
    doc.data(dot, { label: "My dot" });
    doc.shape(dot, { fill: "#123123" });
    doc.shape(badge, { fill: "#000000" });
    doc.set("i", (n) => ({ ...n, style: { ...n.style, backgroundColor: "#123456", borderRadius: 12 } }));
    doc.run((n) => setCanvasInstanceProperties(n, ["i"], { "Show dot": false }));
    expect(doc.get(dot).hidden).toBe(true);
    expect(doc.overrides(dot)).not.toContain("hidden");

    doc.run((n) => setCanvasInstanceProperties(n, ["i"], { State: "Hover" }));
    doc.healthy();
    expect(getInstanceData(doc.get("i"))?.componentId).toBe("v1");
    expect(doc.label("i")).toBe("Button");
    expect(doc.fill(bg)).toBe("#eeeeee"); // dropped: the variants differ
    expect(doc.get(bg).data.shape.strokeWidth).toBe(4); // kept: they agree
    expect(doc.label(label)).toBe("Buy"); // text keeps every override
    expect(doc.get(label).style).toEqual({ color: "#ff8800" });
    expect(doc.label(dot)).toBe("My dot"); // renaming doesn't break matching
    expect(doc.fill(dot)).toBe("#123123");
    expect(doc.has(badge)).toBe(false); // no layer of that name in Hover
    expect(doc.get("i").style).toMatchObject({ backgroundColor: "#123456", borderRadius: 8 });
    expect(doc.get(dot).hidden).toBe(true); // property values stay across variants
    // Unknown values and properties are refused.
    expect(setCanvasInstanceProperties(doc.nodes, ["i"], { State: "Pressed" }).ok).toBe(false);
    expect(setCanvasInstanceProperties(doc.nodes, ["i"], { Nope: 1 })).toMatchObject({ ok: false, code: "unknown-property" });
    expect(setCanvasInstanceProperties(doc.nodes, ["i"], { "Show dot": "maybe" })).toMatchObject({ ok: false, code: "type-mismatch" });
    // Switching back doesn't bring dropped overrides back.
    doc.run((n) => setCanvasInstanceProperties(n, ["i"], { State: "Default" }));
    expect(doc.fill(bg)).toBe("#ffffff");
    expect(doc.label(label)).toBe("Buy");
    doc.healthy();
  });

  it("parses, formats and checks variant names", () => {
    expect(parseVariantName("Size=Large, State=Hover")).toEqual({ Size: "Large", State: "Hover" });
    expect(formatVariantName({ State: "Hover", Size: "Large" }, ["Size"])).toBe("Size=Large, State=Hover");
    const doc = new Doc();
    doc.add(frame("a", "Size=Large, State=Default", 200, 0, 80, 40), frame("b", "Size=Small, State=Default", 0, 0, 80, 40), frame("c", "Size=Small, State=Default", 0, 80, 80, 40));
    for (const f of ["a", "b", "c"]) doc.run((n) => createCanvasComponent(n, [f]));
    const set = doc.run((n) => combineCanvasComponentsAsVariants(n, ["a", "b", "c"]));
    expect(getVariantConflicts(doc.nodes, set)).toEqual([["b", "c"]]);
    // Default: the top-left variant.
    const i = doc.run((n) => createCanvasInstance(n, set));
    expect(getInstanceData(doc.get(i))?.componentId).toBe("b");
  });
});

describe("components: detach, delete main, restore, push (figcraft detach_keeps_the_look …)", () => {
  it("detach keeps the look; nested instances stay linked to their own mains", () => {
    const doc = button();
    doc.run((n) => createCanvasInstance(n, "btn", { id: "i", position: { x: 300, y: 400 } }));
    const inested = doc.copyOf("i", "nested");
    const ishape = doc.kids(inested)[0];
    const ilabel = doc.copyOf("i", "lbl");
    doc.shape(ishape, { fill: "#abcdef" });
    doc.data(ilabel, { label: "Detached" });
    doc.set("i", (n) => ({ ...n, style: { backgroundColor: "#fedcba" } }));
    expect(detachCanvasInstance(doc.nodes, [inested])).toMatchObject({ ok: false, code: "nested-instance" });
    doc.run((n) => detachCanvasInstance(n, ["i"]));
    doc.healthy();
    expect(getInstanceData(doc.get("i"))).toBeUndefined();
    expect(doc.get("i").style).toEqual({ backgroundColor: "#fedcba" });
    expect(doc.label(ilabel)).toBe("Detached");
    expect(getComponentSourceId(doc.get(ilabel))).toBeUndefined();
    expect(getInstanceData(doc.get(inested))?.componentId).toBe("iconf");
    expect(getComponentSourceId(doc.get(ishape))).toBe("shape");
    expect(doc.fill(ishape)).toBe("#abcdef");
    doc.shape("shape", { cornerRadius: 4, fill: "#000000" });
    expect(doc.fill(ishape)).toBe("#abcdef");
    expect(doc.get(ishape).data.shape.cornerRadius).toBe(4);
    // Detached layers are ordinary layers now.
    doc.remove(ilabel);
    expect(doc.has(ilabel)).toBe(false);
  });

  it("a deleted main leaves working instances that can restore it", () => {
    const doc = card();
    doc.run((n) => createCanvasInstance(n, "card", { id: "a", position: { x: 300, y: 0 } }));
    doc.run((n) => createCanvasInstance(n, "card", { id: "b", position: { x: 600, y: 0 } }));
    doc.data("a:title", { label: "Instance A" });
    expect(restoreCanvasMainComponent(doc.nodes, "a").ok).toBe(false);
    doc.remove("card", "bg", "title", "dot");
    doc.healthy();
    expect(doc.kids("a")).toHaveLength(3);
    expect(getInstanceStatus(doc.nodes, "a")).toBe("missing-main");
    expect(inspectCanvasInstance(doc.nodes, "a")?.status).toBe("missing-main");
    expect(pushCanvasInstanceOverrides(doc.nodes, "a")).toMatchObject({ ok: false, code: "missing-main" });
    doc.shape("b:bg", { fill: "#333333" });
    // Restore from B: the main comes back with its old id in B's place.
    const r = doc.run((n) => restoreCanvasMainComponent(n, "b"));
    expect(r).toBe("card");
    expect(doc.has("b")).toBe(false);
    expect(doc.get("card").position).toEqual({ x: 600, y: 0 });
    expect(doc.get("card").data.component).toBeDefined();
    expect(doc.kids("card")).toEqual(["bg", "title", "dot"]);
    doc.healthy();
    // A re-links: main edits reach it, its override stays.
    expect(getComponentSourceId(doc.get("a:title"))).toBe("title");
    doc.shape("bg", { cornerRadius: 9 });
    expect(doc.get("a:bg").data.shape.cornerRadius).toBe(9);
    expect(doc.fill("a:bg")).toBe("#333333");
    expect(doc.label("a:title")).toBe("Instance A");
  });

  it("pushes overrides to the main and every other instance", () => {
    const doc = card();
    doc.run((n) => createCanvasInstance(n, "card", { id: "a", position: { x: 300, y: 0 } }));
    doc.run((n) => createCanvasInstance(n, "card", { id: "b", position: { x: 600, y: 0 } }));
    doc.shape("a:bg", { fill: "#445566" });
    expect(pushCanvasInstanceOverrides(doc.nodes, "b")).toMatchObject({ ok: false, code: "no-overrides" });
    doc.run((n) => pushCanvasInstanceOverrides(n, "a"));
    expect(doc.fill("bg")).toBe("#445566");
    expect(doc.fill("b:bg")).toBe("#445566");
    expect(doc.overrides("a:bg")).toEqual([]);
    doc.healthy();
  });
});

describe("components: properties (figcraft component_properties_apply_to_instances)", () => {
  it("boolean and text properties drive layers without being overrides", () => {
    const doc = card();
    doc.run((n) => setCanvasComponentProperty(n, "card", "Show dot", { type: "boolean", default: true }));
    doc.run((n) => bindCanvasComponentProperty(n, "dot", "visible", "Show dot"));
    doc.run((n) => setCanvasComponentProperty(n, "card", "Title", { type: "text", default: "Hello" }));
    doc.run((n) => bindCanvasComponentProperty(n, "title", "data.label", "Title"));
    doc.run((n) => createCanvasInstance(n, "card", { id: "i" }));
    expect(doc.label("i:title")).toBe("Hello");
    doc.run((n) => setCanvasInstanceProperties(n, ["i"], { "Show dot": false, Title: "From prop" }));
    expect(doc.get("i:dot").hidden).toBe(true);
    expect(doc.label("i:title")).toBe("From prop");
    expect(doc.overrides("i:dot")).toEqual([]);
    expect(doc.overrides("i:title")).toEqual([]);
    // Main edits keep the values.
    doc.shape("dot", { fill: "#00ff00" });
    expect(doc.get("i:dot").hidden).toBe(true);
    expect(doc.label("i:title")).toBe("From prop");
    // Rename: bindings and instance values follow.
    doc.run((n) => setCanvasComponentProperty(n, "card", "Title", { type: "text", default: "Default heading" }, { newName: "Heading" }));
    expect(doc.get("title").data.componentPropertyRefs).toEqual({ "data.label": "Heading" });
    expect(getInstanceData(doc.get("i"))?.properties).toMatchObject({ Heading: "From prop" });
    expect(doc.label("i:title")).toBe("From prop");
    doc.run((n) => createCanvasInstance(n, "card", { id: "j", position: { x: 0, y: 300 } }));
    expect(doc.label("j:title")).toBe("Default heading");
    // Wrong types and names are refused.
    expect(bindCanvasComponentProperty(doc.nodes, "dot", "visible", "Heading")).toMatchObject({ ok: false, code: "type-mismatch" });
    expect(bindCanvasComponentProperty(doc.nodes, "i:title", "data.label", "Heading").ok).toBe(false);
    expect(setCanvasComponentProperty(doc.nodes, "card", "Show dot", { type: "text", default: "x" }, { newName: "Heading" }).ok).toBe(false);
    // Unbind and delete.
    doc.run((n) => bindCanvasComponentProperty(n, "dot", "visible", null));
    expect(doc.get("i:dot").hidden).toBeUndefined();
    doc.run((n) => setCanvasComponentProperty(n, "card", "Heading", null));
    expect(doc.get("title").data.componentPropertyRefs).toBeUndefined();
    expect(getInstanceData(doc.get("i"))?.properties).not.toHaveProperty("Heading");
    expect(inspectCanvasInstance(doc.nodes, "i")?.properties.map((p) => p.name)).toEqual(["Show dot"]);
  });

  it("a text override on a property-driven layer wins", () => {
    const doc = card();
    doc.run((n) => setCanvasComponentProperty(n, "card", "Title", { type: "text", default: "Hello" }));
    doc.run((n) => bindCanvasComponentProperty(n, "title", "data.label", "Title"));
    doc.run((n) => createCanvasInstance(n, "card", { id: "i" }));
    doc.data("i:title", { label: "Typed" });
    expect(doc.overrides("i:title")).toEqual(["data.label"]);
    doc.run((n) => setCanvasInstanceProperties(n, ["i"], { Title: "Prop" }));
    expect(doc.label("i:title")).toBe("Typed");
  });
});

describe("components: resizing (figcraft resized_instances_follow_constraints_and_auto_layout)", () => {
  it("a resized instance keeps its size; its layers follow constraints", () => {
    const doc = card();
    doc.data("dot", { childLayout: { constraints: { horizontal: "right" } } });
    doc.data("bg", { childLayout: { constraints: { horizontal: "leftRight", vertical: "topBottom" } } });
    doc.run((n) => createCanvasInstance(n, "card", { id: "i", position: { x: 300, y: 0 } }));
    doc.set("i", (n) => ({ ...n, width: 300, height: 150 }));
    expect(doc.overrides("i")).toEqual(["size"]);
    expect(doc.get("i:dot").position.x).toBe(270);
    expect([doc.get("i:bg").width, doc.get("i:bg").height]).toEqual([300, 150]);
    expect(doc.overrides("i:dot")).toEqual([]);
    // Main edit: the size and the constraint layout stay.
    doc.shape("dot", { fill: "#00ff00" });
    expect(doc.get("i").width).toBe(300);
    expect(doc.get("i:dot").position.x).toBe(270);
    expect(doc.get("i:bg").width).toBe(300);
    // Main resized: instances without a size override follow.
    doc.run((n) => createCanvasInstance(n, "card", { id: "j", position: { x: 700, y: 0 } }));
    doc.set("card", (n) => ({ ...n, width: 220 }));
    expect(doc.get("j").width).toBe(220);
    expect(doc.get("i").width).toBe(300);
    // Reset all keeps the instance's own size.
    doc.run((n) => resetCanvasInstanceOverrides(n, "i"));
    expect(doc.get("i").width).toBe(300);
  });

  it("auto layout instances follow their main's layout and hug their content", () => {
    const doc = new Doc();
    doc.add(
      frame("row", "Chip", 0, 600, 50, 30, { data: { label: "Chip", layout: { mode: "horizontal", gap: 4, padding: 4, sizing: { width: "hug", height: "hug" } } } }),
      rect("a", "row", "A", "#111111", 0, 0, 10, 10),
      rect("b", "row", "B", "#222222", 0, 0, 20, 10),
    );
    doc.run((n) => createCanvasComponent(n, ["row"]));
    doc.run((n) => createCanvasInstance(n, "row", { id: "ci", position: { x: 300, y: 600 } }));
    expect(doc.get("ci:b").position.x).toBe(18);
    expect(doc.get("ci").width).toBe(42);
    doc.set("row", (n) => ({ ...n, data: { ...n.data, layout: { ...n.data.layout, gap: 10 } } }));
    expect(doc.get("ci:b").position.x).toBe(24);
    // A padding override survives main edits.
    doc.set("ci", (n) => ({ ...n, data: { ...n.data, layout: { ...n.data.layout, padding: 8 } } }));
    expect(doc.overrides("ci")).toContain("layout.padding");
    doc.set("row", (n) => ({ ...n, data: { ...n.data, layout: { ...n.data.layout, gap: 2 } } }));
    expect(doc.get("ci").data.layout).toMatchObject({ gap: 2, padding: 8 });
  });
});

describe("components: serialisation and copy / paste", () => {
  it("survives JSON save / load", () => {
    const { doc } = buttonSet();
    doc.run((n) => createCanvasInstance(n, "set", { id: "i", position: { x: 0, y: 200 } }));
    doc.data(layer(doc, "i", "Label")!, { label: "Buy" });
    const loaded = new Doc(JSON.parse(JSON.stringify(doc.nodes)));
    expect(loaded.nodes).toEqual(doc.nodes);
    loaded.shape("v0-bg", { fill: "#abcabc" });
    expect(loaded.fill(loaded.copyOf("i", "v0-bg"))).toBe("#abcabc");
    expect(loaded.label(loaded.copyOf("i", "v0-label"))).toBe("Buy");
    // Instances saved without their layers are rebuilt on load.
    const bare = loaded.nodes.filter((n) => !n.id.startsWith("i:"));
    const rebuilt = syncAllCanvasInstances(bare);
    expect(rebuilt.filter((n) => n.parentId === "i")).toHaveLength(4);
  });

  it("pasting an instance keeps the link and its overrides", () => {
    const doc = card();
    doc.run((n) => createCanvasInstance(n, "card", { id: "i", position: { x: 300, y: 0 } }));
    doc.shape("i:bg", { fill: "#010101" });
    const subtree = doc.nodes.filter((n) => n.id === "i" || n.parentId === "i");
    const payload = parseCanvasClipboardData(serializeCanvasNodes(subtree))!;
    let k = 0;
    const pasted = remapPastedNodes(payload.nodes, [], { x: 0, y: 200 }, () => `p${++k}`);
    doc.add(...pasted.nodes);
    doc.healthy();
    const root = pasted.nodes[0].id;
    expect(getInstanceData(doc.get(root))?.componentId).toBe("card");
    const pbg = doc.copyOf(root, "bg");
    expect(doc.fill(pbg)).toBe("#010101");
    expect(doc.overrides(pbg)).toEqual(["shape.fill"]);
    doc.shape("bg", { cornerRadius: 3 });
    expect(doc.get(pbg).data.shape.cornerRadius).toBe(3);
    expect(doc.fill(pbg)).toBe("#010101");
  });

  it("a pasted copy of an instance layer stops mirroring; a pasted nested instance links to its own main", () => {
    const doc = button();
    doc.run((n) => createCanvasInstance(n, "btn", { id: "i", position: { x: 300, y: 400 } }));
    const ilabel = doc.copyOf("i", "lbl");
    const inested = doc.copyOf("i", "nested");
    doc.shape(doc.kids(inested)[0], { fill: "#aaaaaa" });
    const pick = (ids: string[]) => doc.nodes.filter((n) => ids.includes(n.id)).map((n) => ({ ...n, parentId: undefined }));
    const label = { ...pick([ilabel])[0], id: "copy-label" };
    const nestedRoot = { ...pick([inested])[0], id: "copy-icon" };
    const nestedKids = doc.nodes.filter((n) => n.parentId === inested).map((n) => ({ ...n, id: `copy-${n.id}`, parentId: "copy-icon" }));
    doc.add(label, nestedRoot, ...nestedKids);
    expect(getComponentSourceId(doc.get("copy-label"))).toBeUndefined();
    expect(getComponentSourceId(doc.get("copy-icon"))).toBe("iconf");
    expect(getComponentSourceId(doc.get(nestedKids[0].id))).toBe("shape");
    expect(doc.overrides(nestedKids[0].id)).toEqual(["shape.fill"]);
    doc.shape("shape", { cornerRadius: 2 });
    expect(doc.get(nestedKids[0].id).data.shape).toMatchObject({ fill: "#aaaaaa", cornerRadius: 2 });
    doc.healthy();
  });

  it("pasting into a document without the main keeps a reference that can be restored", () => {
    const doc = card();
    doc.run((n) => createCanvasInstance(n, "card", { id: "i", position: { x: 300, y: 0 } }));
    const subtree = doc.nodes.filter((n) => n.id === "i" || n.parentId === "i");
    const other = new Doc([rect("x", "", "X", "#000000", 0, 0, 5, 5)].map((n) => ({ ...n, parentId: undefined })));
    let k = 0;
    const pasted = remapPastedNodes(subtree, [], { x: 0, y: 0 }, () => `p${++k}`);
    other.add(...pasted.nodes);
    const root = pasted.nodes[0].id;
    expect(getInstanceStatus(other.nodes, root)).toBe("missing-main");
    other.run((n) => restoreCanvasMainComponent(n, root));
    expect(other.get("card").data.component).toBeDefined();
    expect(other.kids("card")).toEqual(["bg", "title", "dot"]);
  });
});

describe("components: tokens inside instances", () => {
  function themed() {
    let n = 0;
    const store = createTokenStore({ createId: (kind) => `${kind}-${++n}` });
    const c = store.createCollection("Theme", ["Light", "Dark"]);
    const bg = store.createVariable({ collectionId: c.id, name: "bg", type: "color", values: { Light: "#ffffff", Dark: "#000000" } });
    const accent = store.createVariable({ collectionId: c.id, name: "accent", type: "color", values: { Light: "#ff0000", Dark: "#880000" } });
    return { store, c, bg, accent, dark: c.modes[1] };
  }

  it("bindings follow the main, resolve in the instance's modes and are no overrides", () => {
    const { store, c, bg, accent, dark } = themed();
    const tokens = { state: store.getState() };
    const doc = card();
    doc.nodes = bindCanvasToken(doc.nodes, ["bg"], "fill", bg.id, store.getState());
    const sync = (before: CanvasNode[], after: CanvasNode[]) => syncCanvasComponents(before, after, { tokens });
    doc.run((n) => createCanvasInstance(n, "card", { id: "i", tokens }));
    expect(doc.get("i:bg").data.tokenBindings).toEqual({ fill: bg.id });
    expect(doc.fill("i:bg")).toBe("#ffffff");
    // The instance in Dark mode.
    doc.nodes = sync(doc.nodes, setCanvasTokenMode(doc.nodes, ["i"], c.id, dark.id, store.getState()));
    expect(doc.fill("i:bg")).toBe("#000000");
    expect(doc.overrides("i:bg")).toEqual([]);
    expect(doc.overrides("i")).toEqual([]);
    // Main edits keep the instance's mode and resolve there.
    doc.nodes = sync(doc.nodes, doc.nodes.map((n) => (n.id === "bg" ? { ...n, data: { ...n.data, shape: { ...n.data.shape, cornerRadius: 5 } } } : n)));
    expect(doc.fill("i:bg")).toBe("#000000");
    expect(doc.get("i:bg").data.shape.cornerRadius).toBe(5);
    // Binding another variable in the instance is an override that survives main rebinding.
    doc.nodes = sync(doc.nodes, bindCanvasToken(doc.nodes, ["i:dot"], "fill", accent.id, store.getState()));
    expect(doc.overrides("i:dot")).toEqual(["token.fill"]);
    expect(doc.fill("i:dot")).toBe("#880000");
    doc.nodes = sync(doc.nodes, bindCanvasToken(doc.nodes, ["dot"], "fill", bg.id, store.getState()));
    expect(doc.get("i:dot").data.tokenBindings).toEqual({ fill: accent.id });
    expect(doc.fill("i:dot")).toBe("#880000");
    // Resolution alone (e.g. the tokens hook) records nothing.
    const resolved = resolveCanvasTokens(doc.nodes, store.getState());
    expect(syncCanvasComponents(doc.nodes, resolved)).toBe(resolved);
  });
});

describe("components: inspect and groups", () => {
  it("reads and writes override groups for style strings and objects", () => {
    const node: CanvasNode = { id: "n", position: { x: 0, y: 0 }, style: "background-color: red; opacity: 0.5", data: { label: "A", shape: { fill: "#fff" } } };
    expect(readOverrideGroup(node, "style.backgroundColor")).toBe("red");
    const next = writeOverrideGroup(node, "style.opacity", 1);
    expect(next.style).toBe("background-color: red; opacity: 1");
    expect(writeOverrideGroup(node, "style.opacity", "0.5")).toBe(node);
    expect(diffOverrideGroups(node, { ...node, hidden: true, data: { ...node.data, label: "B" } }).sort()).toEqual(["data.label", "hidden"]);
  });

  it("inspects an instance from any of its layers", () => {
    const { doc } = buttonSet();
    doc.run((n) => createCanvasInstance(n, "set", { id: "i", position: { x: 0, y: 200 } }));
    const bg = layer(doc, "i", "Bg")!;
    doc.shape(bg, { fill: "#000000" });
    const info = inspectCanvasInstance(doc.nodes, bg)!;
    expect(info).toMatchObject({ id: "i", rootId: "i", nested: false, componentId: "v0", status: "linked", setId: "set", variant: { State: "Default" } });
    expect(info.variantOptions).toEqual([{ name: "State", values: ["Default", "Hover"] }]);
    expect(info.properties).toEqual([{ name: "Show dot", type: "boolean", value: true, default: true }]);
    expect(info.overrides).toEqual([{ id: bg, name: "Bg", groups: ["shape.fill"] }]);
  });
});

describe("components: scale (figcraft components_scale_tests)", () => {
  /** A 10-layer component and `k` instances of it. */
  function many(k: number) {
    const doc = new Doc();
    doc.add(frame("c", "C", 0, 0, 100, 100));
    for (let i = 0; i < 10; i++) doc.add(rect(`l${i}`, "c", `L${i}`, "#ffffff", i, i, 10, 10));
    doc.run((n) => createCanvasComponent(n, ["c"]));
    for (let i = 0; i < k; i++) doc.run((n) => createCanvasInstance(n, "c", { id: `i${i}`, position: { x: 0, y: 200 + i } }));
    // An override on every instance, to keep.
    doc.edit((nodes) => nodes.map((n) => (n.id.endsWith(":l1") ? { ...n, data: { ...n.data, label: `own ${n.parentId}` } } : n)));
    return doc.nodes;
  }
  const editMain = (nodes: CanvasNode[]) => () =>
    syncCanvasComponents(nodes, nodes.map((n) => (n.id === "l3" ? { ...n, data: { ...n.data, shape: { ...n.data.shape, fill: "#000000" } } } : n)));

  it("propagates a main edit to every instance, keeping their overrides", () => {
    const nodes = many(50);
    const after = editMain(nodes)();
    const byId = new Map(after.map((n) => [n.id, n]));
    for (let i = 0; i < 50; i++) {
      expect(byId.get(`i${i}:l3`)!.data.shape.fill).toBe("#000000");
      expect(byId.get(`i${i}:l1`)!.data.label).toBe(`own i${i}`);
    }
  });

  it("grows linearly with the number of instances", () => {
    const small = many(100);
    const large = many(400);
    const ratio = measureGrowth(editMain(small), editMain(large), { limit: 10 });
    expect(ratio).toBeLessThan(10);
  });
});
