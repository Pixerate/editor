import { describe, it, expect } from "vitest";
import {
  CANVAS_TOKEN_PROPERTIES,
  TOKEN_BINDINGS_DATA_KEY,
  TOKEN_MODES_DATA_KEY,
  bindCanvasToken,
  detachTokenBindings,
  getBindableTokenProperties,
  getEffectiveTokenModes,
  getNodeTokenBindings,
  getTokensForProperty,
  inspectNodeTokens,
  parseCanvasClipboardData,
  pruneCanvasTokenModes,
  readNodeStyleProperty,
  remapPastedNodes,
  resolveCanvasTokens,
  serializeCanvasNodes,
  setCanvasTokenMode,
  writeNodeStyleProperty,
  layoutFrame,
  type CanvasNode,
} from "../src/canvas";
import { TokenError, createTokenStore, type TokenStore } from "../src/tokens";

function ids() {
  let n = 0;
  return (kind: string) => `${kind}-${++n}`;
}

function theme() {
  const store = createTokenStore({ createId: ids() });
  const c = store.createCollection("Theme", ["Light", "Dark"]);
  const bg = store.createVariable({ collectionId: c.id, name: "bg", type: "color", values: { Light: "#FFFFFF", Dark: "#000000" } });
  const [light, dark] = c.modes;
  return { store, c, bg, light, dark };
}

const rect = (id: string, parentId?: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  position: { x: 0, y: 0 },
  width: 10,
  height: 10,
  parentId,
  data: { shape: { kind: "rect", fill: "#cccccc" } },
  ...extra,
});
const frame = (id: string, parentId?: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  position: { x: 0, y: 0 },
  width: 100,
  height: 100,
  parentId,
  data: {},
  style: { backgroundColor: "#eeeeee" },
  ...extra,
});

const fill = (nodes: CanvasNode[], id: string) => {
  const node = nodes.find((n) => n.id === id)!;
  return node.data.shape ? node.data.shape.fill : readNodeStyleProperty(node.style, "backgroundColor");
};

describe("canvas token bindings", () => {
  it("bound layers follow variable values and modes, and unbinding keeps the value", () => {
    const { store, c, dark } = theme();
    const size = store.createVariable({ collectionId: c.id, name: "size/lg", type: "number", value: 48 });
    let nodes = [rect("r")];
    nodes = bindCanvasToken(nodes, ["r"], "fill", store.getState().variables[0].id, store.getState());
    nodes = bindCanvasToken(nodes, ["r"], "cornerRadius", size.id, store.getState());
    expect(fill(nodes, "r")).toBe("#ffffff");
    expect(nodes[0].data.shape.cornerRadius).toBe(48);
    expect(getNodeTokenBindings(nodes[0])).toEqual({ fill: store.getState().variables[0].id, cornerRadius: size.id });

    // Editing the variable updates the bound layer.
    store.setValue(size.id, 64);
    nodes = resolveCanvasTokens(nodes, store.getState());
    expect(nodes[0].data.shape.cornerRadius).toBe(64);
    // A mode with another value applies through the root modes.
    store.setValue(size.id, 80, dark.id);
    nodes = resolveCanvasTokens(nodes, store.getState(), { modes: { [c.id]: dark.id } });
    expect(nodes[0].data.shape.cornerRadius).toBe(80);
    expect(fill(nodes, "r")).toBe("#000000");
    // Nothing changed: same array, same nodes.
    expect(resolveCanvasTokens(nodes, store.getState(), { modes: { [c.id]: dark.id } })).toBe(nodes);

    // Unbinding keeps the value and stops following.
    nodes = bindCanvasToken(nodes, ["r"], "cornerRadius", null, store.getState());
    store.setValue(size.id, 99, dark.id);
    nodes = resolveCanvasTokens(nodes, store.getState(), { modes: { [c.id]: dark.id } });
    expect(nodes[0].data.shape.cornerRadius).toBe(80);
    expect(() => bindCanvasToken(nodes, ["r"], "cornerRadius", "nope", store.getState())).toThrow(TokenError);
    expect(() => bindCanvasToken(nodes, ["r"], "nope", size.id, store.getState())).toThrow(TokenError);
  });

  it("bindings by field and type; mistyped bindings are refused and change nothing", () => {
    const store = createTokenStore({ createId: ids() });
    const c = store.createCollection("C");
    const n = store.createVariable({ collectionId: c.id, name: "n", type: "number", value: 12 });
    const col = store.createVariable({ collectionId: c.id, name: "c", type: "color", value: "#336699" });
    const t = store.createVariable({ collectionId: c.id, name: "t", type: "string", value: "Hi" });
    const b = store.createVariable({ collectionId: c.id, name: "b", type: "boolean", value: false });
    const s = store.getState();
    let nodes: CanvasNode[] = [
      frame("f", undefined, { data: { layout: { mode: "horizontal", padding: 4 } } }),
      rect("r", undefined, { data: { shape: { kind: "rect", stroke: "#000000", strokeWidth: 1 } } }),
      { id: "t", position: { x: 0, y: 0 }, type: "text", data: { label: "Hello" }, style: "color: red; font-size: 10px" },
      frame("box", undefined, { style: "background: url(\"data:image/png;base64,AAA\"); border-radius: 2px" }),
    ];
    const checks: [string, string, string, (n: CanvasNode[]) => unknown, unknown][] = [
      ["r", "cornerRadius", n.id, (x) => x[1].data.shape.cornerRadius, 12],
      ["r", "opacity", n.id, (x) => x[1].style.opacity, 0.12],
      ["r", "strokeWidth", n.id, (x) => x[1].data.shape.strokeWidth, 12],
      ["r", "fill", col.id, (x) => x[1].data.shape.fill, "#336699"],
      ["r", "stroke", col.id, (x) => x[1].data.shape.stroke, "#336699"],
      ["f", "gap", n.id, (x) => x[0].data.layout.gap, 12],
      ["f", "paddingTop", n.id, (x) => x[0].data.layout.padding, { top: 12, right: 4, bottom: 4, left: 4 }],
      ["f", "paddingHorizontal", n.id, (x) => x[0].data.layout.padding, { top: 12, right: 12, bottom: 4, left: 12 }],
      ["f", "fill", col.id, (x) => x[0].style.backgroundColor, "#336699"],
      ["f", "cornerRadius", n.id, (x) => x[0].style.borderRadius, 12],
      ["t", "fontSize", n.id, (x) => x[2].style, "color: red; font-size: 12px"],
      ["t", "textColor", col.id, (x) => x[2].style, "color: #336699; font-size: 12px"],
      ["t", "visible", b.id, (x) => x[2].hidden, true],
      ["box", "fill", col.id, (x) => x[3].style, 'background: #336699; border-radius: 2px'],
    ];
    for (const [id, property, variable, read, want] of checks) {
      nodes = bindCanvasToken(nodes, [id], property, variable, s);
      expect(read(nodes), `${property} ← ${variable}`).toEqual(want);
    }
    const refused: [string, string, string][] = [
      ["r", "fill", n.id],
      ["r", "opacity", t.id],
      ["t", "visible", n.id],
      ["f", "gap", col.id],
    ];
    for (const [id, property, variable] of refused) {
      const before = nodes;
      expect(() => bindCanvasToken(nodes, [id], property, variable, s)).toThrow(/takes a/);
      expect(nodes).toBe(before);
    }
    // Properties that don't apply leave the node alone (gap on a node without auto layout).
    expect(bindCanvasToken(nodes, ["r"], "gap", n.id, s)).toBe(nodes);
    expect(getBindableTokenProperties(nodes[1]).map((p) => p.key)).not.toContain("gap");
    expect(getBindableTokenProperties(nodes[0]).map((p) => p.key)).toContain("paddingLeft");
  });

  it("opacity variables are percentages, clamped", () => {
    const store = createTokenStore({ createId: ids() });
    const c = store.createCollection("C");
    const fade = store.createVariable({ collectionId: c.id, name: "fade", type: "number", value: 40 });
    let nodes = bindCanvasToken([frame("f")], ["f"], "opacity", fade.id, store.getState());
    expect(nodes[0].style.opacity).toBeCloseTo(0.4);
    store.setValue(fade.id, 250);
    nodes = resolveCanvasTokens(nodes, store.getState());
    expect(nodes[0].style.opacity).toBe(1);
  });

  it("modes inherit down the tree: nearest explicit mode wins, Auto falls back", () => {
    const { store, c, bg, light, dark } = theme();
    const s = () => store.getState();
    let nodes: CanvasNode[] = [frame("outer"), frame("inner", "outer"), rect("r", "inner"), rect("free")];
    nodes = bindCanvasToken(nodes, ["r", "free"], "fill", bg.id, s());
    const steps: [string, (n: CanvasNode[]) => CanvasNode[], { modes?: Record<string, string> }, string, string][] = [
      ["nothing set: default mode", (n) => n, {}, "#ffffff", "#ffffff"],
      ["page Dark: everything on it", (n) => n, { modes: { [c.id]: dark.id } }, "#000000", "#000000"],
      ["outer Light: its subtree", (n) => setCanvasTokenMode(n, ["outer"], c.id, light.id, s(), { modes: { [c.id]: dark.id } }), { modes: { [c.id]: dark.id } }, "#ffffff", "#000000"],
      ["inner Dark: the nearest wins", (n) => setCanvasTokenMode(n, ["inner"], c.id, dark.id, s()), { modes: { [c.id]: dark.id } }, "#000000", "#000000"],
      ["inner back to Auto: outer's again", (n) => setCanvasTokenMode(n, ["inner"], c.id, null, s()), { modes: { [c.id]: dark.id } }, "#ffffff", "#000000"],
    ];
    for (const [what, step, options, nested, loose] of steps) {
      nodes = resolveCanvasTokens(step(nodes), s(), options);
      expect([fill(nodes, "r"), fill(nodes, "free")], what).toEqual([nested, loose]);
    }
    expect(getEffectiveTokenModes(nodes[2], nodes, s())).toEqual({ [c.id]: light.id });
    // Moving a layer into another container: it takes that one's mode.
    nodes = nodes.map((n) => (n.id === "free" ? { ...n, parentId: "outer" } : n));
    nodes = resolveCanvasTokens(nodes, s(), { modes: { [c.id]: dark.id } });
    expect(fill(nodes, "free")).toBe("#ffffff");
    expect(() => setCanvasTokenMode(nodes, ["outer"], c.id, "nope", s())).toThrow(TokenError);
  });

  it("new default modes reach Auto layers; explicit modes stay; removed modes go back to Auto", () => {
    const { store, c, bg, light, dark } = theme();
    let nodes = [rect("auto"), frame("pinned-frame"), rect("pinned", "pinned-frame")];
    nodes = bindCanvasToken(nodes, ["auto", "pinned"], "fill", bg.id, store.getState());
    nodes = setCanvasTokenMode(nodes, ["pinned-frame"], c.id, light.id, store.getState());
    store.setDefaultMode(c.id, dark.id);
    nodes = resolveCanvasTokens(nodes, store.getState());
    expect([fill(nodes, "auto"), fill(nodes, "pinned")]).toEqual(["#000000", "#ffffff"]);
    store.removeMode(c.id, light.id);
    nodes = resolveCanvasTokens(nodes, store.getState());
    expect(fill(nodes, "pinned")).toBe("#000000");
    nodes = pruneCanvasTokenModes(nodes, store.getState());
    expect(nodes[1].data[TOKEN_MODES_DATA_KEY]).toBeUndefined();
  });

  it("deleting a bound variable keeps the last value; aliases take its values", () => {
    const { store, c, bg, dark } = theme();
    const surface = store.createVariable({ collectionId: c.id, name: "surface", type: "color", value: { alias: bg.id } });
    let nodes = [frame("f"), rect("r", "f"), rect("r2", "f")];
    nodes = bindCanvasToken(nodes, ["r"], "fill", bg.id, store.getState());
    nodes = bindCanvasToken(nodes, ["r2"], "fill", surface.id, store.getState());
    nodes = setCanvasTokenMode(nodes, ["f"], c.id, dark.id, store.getState());

    let lastEvent: any;
    store.subscribe((e) => {
      lastEvent = e;
      if (e.deletedVariableIds.length) nodes = detachTokenBindings(nodes, e.previous, e.deletedVariableIds);
    });
    store.deleteVariables(bg.id);
    nodes = resolveCanvasTokens(nodes, store.getState());
    expect(fill(nodes, "r")).toBe("#000000");
    expect(getNodeTokenBindings(nodes[1])).toEqual({});
    expect(nodes[1].data[TOKEN_BINDINGS_DATA_KEY]).toBeUndefined();
    expect(fill(nodes, "r2")).toBe("#000000");
    expect(getNodeTokenBindings(nodes[2])).toEqual({ fill: surface.id });
    expect(lastEvent.deletedVariableIds).toEqual([bg.id]);

    // Without a detach, a binding to a missing variable keeps the last materialised value.
    const orphan = [{ ...rect("o"), data: { shape: { kind: "rect", fill: "#123456" }, tokenBindings: { fill: "gone" } } }];
    expect(resolveCanvasTokens(orphan, store.getState())).toBe(orphan);
    const detached = detachTokenBindings(orphan, store.getState());
    expect(detached[0].data.tokenBindings).toBeUndefined();
    expect(detached[0].data.shape.fill).toBe("#123456");
  });

  it("bindings and modes survive copy / paste and duplication", () => {
    const { store, c, bg, dark } = theme();
    let nodes = [frame("card"), rect("swatch", "card")];
    nodes = bindCanvasToken(nodes, ["swatch"], "fill", bg.id, store.getState());
    nodes = setCanvasTokenMode(nodes, ["card"], c.id, dark.id, store.getState());
    const payload = parseCanvasClipboardData(serializeCanvasNodes(nodes))!;
    let n = 0;
    const pasted = remapPastedNodes(payload.nodes, [], { x: 20, y: 20 }, () => `copy-${++n}`).nodes;
    expect(pasted[1].parentId).toBe("copy-1");
    expect(getNodeTokenBindings(pasted[1])).toEqual({ fill: bg.id });
    expect(pasted[0].data.tokenModes).toEqual({ [c.id]: dark.id });

    // The copy follows its own frame's mode and later edits.
    let all = resolveCanvasTokens([...nodes, ...pasted], store.getState());
    all = setCanvasTokenMode(all, ["copy-1"], c.id, null, store.getState());
    expect([fill(all, "swatch"), fill(all, "copy-2")]).toEqual(["#000000", "#ffffff"]);
    store.setValue(bg.id, "#ff0000", dark.id);
    all = resolveCanvasTokens(all, store.getState());
    expect(fill(all, "swatch")).toBe("#ff0000");

    // structuredClone-based duplication keeps them too.
    const dup = structuredClone(nodes[1]);
    expect(getNodeTokenBindings(dup)).toEqual({ fill: bg.id });
  });

  it("bound gap and padding drive auto layout", () => {
    const store = createTokenStore({ createId: ids() });
    const c = store.createCollection("Spacing", ["Compact", "Comfy"]);
    const gap = store.createVariable({ collectionId: c.id, name: "gap", type: "number", values: { Compact: 4, Comfy: 16 } });
    let nodes: CanvasNode[] = [
      frame("row", undefined, { data: { layout: { mode: "horizontal", sizing: { width: "hug", height: "hug" } } } }),
      frame("a", "row", { width: 10, height: 10 }),
      frame("b", "row", { width: 10, height: 10 }),
    ];
    nodes = bindCanvasToken(nodes, ["row"], "gap", gap.id, store.getState());
    nodes = bindCanvasToken(nodes, ["row"], "padding", gap.id, store.getState());
    const width = (ns: CanvasNode[]) => layoutFrame(ns, "row").find((u) => u.id === "row")?.width;
    expect(width(nodes)).toBe(4 + 10 + 4 + 10 + 4);
    nodes = setCanvasTokenMode(nodes, ["row"], c.id, c.modes[1].id, store.getState());
    expect(width(nodes)).toBe(16 + 10 + 16 + 10 + 16);
  });

  it("pickers offer variables of the property's type and scope; inspection reports resolution", () => {
    const store: TokenStore = createTokenStore({ createId: ids() });
    const c = store.createCollection("C");
    const radius = store.createVariable({ collectionId: c.id, name: "radius", type: "number", value: 8, scopes: ["CORNER_RADIUS"] });
    const any = store.createVariable({ collectionId: c.id, name: "any", type: "number", value: 2 });
    store.createVariable({ collectionId: c.id, name: "ink", type: "color" });
    const textFill = store.createVariable({ collectionId: c.id, name: "text-only", type: "color", scopes: ["TEXT_FILL"] });
    const s = store.getState();
    const prop = (key: string) => CANVAS_TOKEN_PROPERTIES.find((p) => p.key === key)!;
    const node = rect("r");
    expect(getTokensForProperty(s, prop("cornerRadius"), node).map((v) => v.name)).toEqual(["radius", "any"]);
    expect(getTokensForProperty(s, prop("strokeWidth"), node).map((v) => v.name)).toEqual(["any"]);
    expect(getTokensForProperty(s, prop("fill"), node).map((v) => v.name)).toEqual(["ink"]);
    expect(getTokensForProperty(s, prop("textColor"), frame("t")).map((v) => v.id)).toContain(textFill.id);
    // Binding out of scope still works (scopes are about pickers).
    const nodes = bindCanvasToken([node], ["r"], "strokeWidth", radius.id, s);
    expect(nodes[0].data.shape.strokeWidth).toBe(8);
    const info = inspectNodeTokens(nodes[0], nodes, s);
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({ variableId: radius.id, resolution: { ok: true, value: 8 } });
    expect(any.id).toBeDefined();
  });

  it("style helpers keep the style's representation and quoted semicolons", () => {
    expect(writeNodeStyleProperty("width: 10px; background: url('a;b')", "borderRadius", 4)).toBe("width: 10px; background: url('a;b'); border-radius: 4px");
    expect(writeNodeStyleProperty({ width: 10 }, "opacity", 0.5, true)).toEqual({ width: 10, opacity: 0.5 });
    expect(writeNodeStyleProperty("opacity: 1", "opacity", undefined)).toBe("");
    expect(readNodeStyleProperty("Background-Color: red", "backgroundColor")).toBe("red");
  });
});
