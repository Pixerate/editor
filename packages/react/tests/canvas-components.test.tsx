// @vitest-environment jsdom
// The DOM must exist before react-dom loads (see GOTCHAS: text inputs and onChange).
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { HistoryManager } from "@pixerate/editor/history";
import {
  CanvasComponentsPanel,
  CanvasInstanceInspector,
  CANVAS_COMPONENT_DRAG_TYPE,
  bindCanvasComponentProperty,
  combineCanvasComponentsAsVariants,
  createCanvasComponent,
  getInstanceData,
  getNodeOverrides,
  setCanvasComponentProperty,
  useCanvasComponents,
  type CanvasComponents,
  type CanvasNode,
} from "../src/canvas";

let container: HTMLDivElement;
let root: any;
const dom = { window: globalThis.window as any };

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T;
const qa = (sel: string) => [...container.querySelectorAll(sel)] as HTMLElement[];
async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}
async function commit(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
  });
}

const frame = (id: string, label: string, x: number, y: number): CanvasNode => ({ id, type: "group", position: { x, y }, width: 120, height: 40, data: { label } });
const rect = (id: string, parentId: string, label: string, fill: string): CanvasNode => ({
  id,
  type: "shape",
  parentId,
  position: { x: 0, y: 0 },
  width: 120,
  height: 40,
  data: { label, shape: { kind: "rect", fill } },
});
const text = (id: string, parentId: string, label: string): CanvasNode => ({ id, type: "text", parentId, position: { x: 10, y: 10 }, data: { label, name: "Label" } });

/** A Button set (Style=Primary / Style=Secondary) with a "Label" text property. */
function buttonSet(): CanvasNode[] {
  let nodes: CanvasNode[] = [
    frame("primary", "Style=Primary", 0, 0),
    rect("primary-bg", "primary", "Bg", "#2563eb"),
    text("primary-label", "primary", "Button"),
    frame("secondary", "Style=Secondary", 0, 80),
    rect("secondary-bg", "secondary", "Bg", "#e2e8f0"),
    text("secondary-label", "secondary", "Button"),
  ];
  const ok = <T,>(r: { ok: boolean; nodes?: T }) => {
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.nodes as T;
  };
  nodes = ok(createCanvasComponent(nodes, ["primary"]));
  nodes = ok(createCanvasComponent(nodes, ["secondary"]));
  nodes = ok(combineCanvasComponentsAsVariants(nodes, ["primary", "secondary"], { id: "button", name: "Button" }));
  nodes = ok(setCanvasComponentProperty(nodes, "button", "Text", { type: "text", default: "Button" }));
  nodes = ok(setCanvasComponentProperty(nodes, "button", "Show", { type: "boolean", default: true }));
  for (const v of ["primary", "secondary"]) {
    nodes = ok(bindCanvasComponentProperty(nodes, `${v}-label`, "data.label", "Text"));
    nodes = ok(bindCanvasComponentProperty(nodes, `${v}-bg`, "visible", "Show"));
  }
  return nodes;
}

function Harness({ initial, history, out }: { initial: CanvasNode[]; history?: HistoryManager; out: { components?: CanvasComponents; nodes?: CanvasNode[]; setNodes?: (n: CanvasNode[]) => void; errors: string[] } }) {
  const [nodes, setNodes] = useState(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const components = useCanvasComponents({ nodes, setNodes, history });
  out.components = components;
  out.nodes = nodes;
  out.setNodes = setNodes;
  return (
    <div>
      <CanvasComponentsPanel
        nodes={nodes}
        onInsert={(id) => {
          const r = components.createInstance(id, { position: { x: 300, y: 0 } });
          if (r.ok) setSelected(r.ids[0]);
        }}
      />
      <CanvasInstanceInspector nodes={nodes} nodeId={selected} components={components} onError={(e) => out.errors.push(e)} />
    </div>
  );
}

describe("useCanvasComponents + panel + inspector", () => {
  it("inserts instances from the panel and edits them in the inspector", async () => {
    const history = new HistoryManager();
    const out: any = { errors: [] };
    await act(async () => root.render(<Harness initial={buttonSet()} history={history} out={out} />));
    // Panel: the set with its variants.
    expect(qa("[data-component-set] [data-kind='variant']").map((b) => b.getAttribute("data-component-id"))).toEqual(["primary", "secondary"]);
    const setButton = q("[data-component-id='button']");
    // Drag carries the component id.
    const data = new Map<string, string>();
    await act(async () => {
      const ev = new dom.window.Event("dragstart", { bubbles: true }) as any;
      ev.dataTransfer = { setData: (t: string, v: string) => data.set(t, v), effectAllowed: "" };
      setButton.dispatchEvent(ev);
    });
    expect(data.get(CANVAS_COMPONENT_DRAG_TYPE)).toBe("button");
    await click(setButton);
    const inst = out.nodes.find((n: CanvasNode) => getInstanceData(n))!.id;
    expect(getInstanceData(out.nodes.find((n: CanvasNode) => n.id === inst))?.componentId).toBe("primary");
    expect(q("[data-instance-inspector]").getAttribute("data-instance-id")).toBe(inst);
    expect(q("[data-instance-main]").textContent).toBe("Style=Primary");

    // Text property, then switch variant: the value stays.
    await commit(q<HTMLInputElement>("[data-component-property='Text'] input"), "Buy now");
    const label = () => out.nodes.find((n: CanvasNode) => n.parentId === inst && n.type === "text");
    expect(label().data.label).toBe("Buy now");
    await choose(q<HTMLSelectElement>("[data-variant-property='Style'] select"), "Secondary");
    expect(getInstanceData(out.nodes.find((n: CanvasNode) => n.id === inst))?.componentId).toBe("secondary");
    expect(label().data.label).toBe("Buy now");
    // Boolean property.
    await act(async () => {
      q<HTMLInputElement>("[data-component-property='Show'] input").click();
    });
    expect(out.nodes.find((n: CanvasNode) => n.parentId === inst && n.type === "shape").hidden).toBe(true);

    // Editing the main updates the instance (auto sync), an instance edit is an override.
    await act(async () => out.setNodes(out.nodes.map((n: CanvasNode) => (n.id === "secondary-bg" ? { ...n, data: { ...n.data, shape: { ...n.data.shape, fill: "#000000" } } } : n))));
    const bg = () => out.nodes.find((n: CanvasNode) => n.parentId === inst && n.type === "shape");
    expect(bg().data.shape.fill).toBe("#000000");
    await act(async () => out.setNodes(out.nodes.map((n: CanvasNode) => (n.id === bg().id ? { ...n, data: { ...n.data, shape: { ...n.data.shape, fill: "#ff0000" } } } : n))));
    expect(getNodeOverrides(bg())).toEqual(["shape.fill"]);
    expect(q(`[data-override-layer='${bg().id}'] [data-override-group='shape.fill']`)).not.toBeNull();
    await click(q(`[data-override-group='shape.fill']`));
    expect(bg().data.shape.fill).toBe("#000000");

    // Reset all restores the property defaults; undo brings them back.
    await click(q("[data-action='reset']"));
    expect(label().data.label).toBe("Button");
    await act(async () => history.undo());
    expect(label().data.label).toBe("Buy now");

    // Go to main selects the variant; detach turns the instance into a frame.
    await click(q("[data-action='go-to-main']"));
    expect(out.nodes.find((n: CanvasNode) => n.id === "secondary").selected).toBe(true);
    await click(q("[data-action='detach']"));
    expect(getInstanceData(out.nodes.find((n: CanvasNode) => n.id === inst))).toBeUndefined();
    expect(q("[data-instance-inspector]")).toBeNull();
    expect(out.errors).toEqual([]);
  });

  it("shows a missing main and restores it", async () => {
    const out: any = { errors: [] };
    function Missing() {
      const [nodes, setNodes] = useState<CanvasNode[]>([
        { id: "i", type: "group", position: { x: 0, y: 0 }, data: { label: "Card", instance: { componentId: "gone", properties: {} }, componentSource: "gone" } },
        { id: "i:bg", type: "shape", parentId: "i", position: { x: 0, y: 0 }, data: { label: "Bg", componentSource: "bg", shape: { kind: "rect", fill: "#fff" } } },
      ]);
      const components = useCanvasComponents({ nodes, setNodes });
      out.nodes = nodes;
      return <CanvasInstanceInspector nodes={nodes} nodeId="i:bg" components={components} />;
    }
    await act(async () => root.render(<Missing />));
    expect(q("[data-instance-main]").textContent).toBe("Main component missing");
    await click(q("[data-action='restore']"));
    expect(out.nodes.map((n: CanvasNode) => n.id)).toEqual(["gone", "bg"]);
    expect(out.nodes[0].data.component).toBeDefined();
  });

  it("filters the panel and shows an empty state", async () => {
    await act(async () => root.render(<CanvasComponentsPanel nodes={[]} onInsert={() => {}} />));
    expect(q("[data-components-panel] p")?.textContent).toContain("No components yet");
    const inserted: string[] = [];
    await act(async () => root.render(<CanvasComponentsPanel nodes={buttonSet()} onInsert={(id) => inserted.push(id)} />));
    await act(async () => {
      const input = q<HTMLInputElement>("input[type='search']");
      input.value = "zzz";
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    expect(qa("[data-component-id]")).toHaveLength(0);
    await act(async () => {
      const input = q<HTMLInputElement>("input[type='search']");
      input.value = "secondary";
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    expect(qa("[data-component-id]").map((b) => b.getAttribute("data-component-id"))).toEqual(["button", "primary", "secondary"]);
    await click(q("[data-component-id='secondary']"));
    expect(inserted).toEqual(["secondary"]);
  });
});

function VariantHarness({ history, out }: { history: HistoryManager; out: { components?: CanvasComponents; nodes?: CanvasNode[]; errors: string[] } }) {
  const [nodes, setNodes] = useState(buttonSet);
  const components = useCanvasComponents({ nodes, setNodes, history });
  out.components = components;
  out.nodes = nodes;
  return (
    <div>
      <CanvasComponentsPanel nodes={nodes} onInsert={() => {}} components={components} onError={(e) => out.errors.push(e)} />
      <CanvasInstanceInspector nodes={nodes} nodeId="inst" components={components} />
    </div>
  );
}

describe("components panel: variant editing", () => {
  it("adds, renames, edits and removes variants (undoable)", async () => {
    const history = new HistoryManager();
    const out: any = { errors: [] };
    await act(async () => root.render(<VariantHarness history={history} out={out} />));
    await act(async () => {
      out.components.createInstance("primary", { id: "inst", position: { x: 300, y: 0 } });
    });
    const variants = () => qa("[data-component-set] [data-kind='variant']").map((b) => b.firstElementChild?.textContent?.replace("◇", "").trim());
    const node = (id: string) => out.nodes.find((n: CanvasNode) => n.id === id);
    expect(variants()).toEqual(["Style=Primary", "Style=Secondary"]);

    // + Variant duplicates the default variant; instances' pickers show the new value.
    await click(q("[data-action='add-variant']"));
    expect(variants()).toEqual(["Style=Primary", "Style=Secondary", "Style=Variant3"]);
    expect([...q<HTMLSelectElement>("[data-variant-property='Style'] select").options].map((o) => o.value)).toEqual(["Primary", "Secondary", "Variant3"]);

    // Rename a property and a value inline.
    await click(q("[data-action='variant-properties']"));
    await commit(q<HTMLInputElement>("input[aria-label='Rename property Style']"), "Tone");
    expect(variants()).toEqual(["Tone=Primary", "Tone=Secondary", "Tone=Variant3"]);
    await commit(q<HTMLInputElement>("input[aria-label='Rename Tone value Primary']"), "Brand");
    expect(variants()[0]).toBe("Tone=Brand");
    expect(q("[data-variant-property='Tone']")).not.toBeNull();

    // Edit a variant's values from its menu: duplicates are refused with a reason.
    await click(q("[data-variant-row='secondary'] [data-action='variant-menu']"));
    await click(q("[data-variant-menu='secondary'] [data-action='edit-variant']"));
    const submit = async (value: string) =>
      act(async () => {
        q<HTMLInputElement>("[data-variant-editor='secondary'] input[data-variant-value='Tone']").value = value;
        q("[data-variant-editor='secondary']").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      });
    await submit("Brand");
    expect(out.errors).toEqual(["A variant with Tone=Brand exists already."]);
    expect(q("[data-variant-editor='secondary']")).not.toBeNull();
    await submit("Muted");
    expect(node("secondary").data.label).toBe("Tone=Muted");
    expect(q("[data-variant-editor='secondary']")).toBeNull();

    // Remove from the context menu: the instance switches to the closest variant.
    await act(async () => {
      q("[data-component-id='primary']").dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(q<HTMLButtonElement>("[data-variant-menu='primary'] [data-action='remove-variant']").disabled).toBe(false);
    await click(q("[data-variant-menu='primary'] [data-action='remove-variant']"));
    expect(node("primary")).toBeUndefined();
    expect(getInstanceData(node("inst"))?.componentId).toBe("secondary");
    expect(variants()).toEqual(["Tone=Muted", "Tone=Variant3"]);

    await act(async () => history.undo());
    expect(getInstanceData(node("inst"))?.componentId).toBe("primary");
    expect(variants()).toEqual(["Tone=Brand", "Tone=Muted", "Tone=Variant3"]);
    expect(out.errors).toHaveLength(1);
  });

  it("hides the editing controls without components", async () => {
    await act(async () => root.render(<CanvasComponentsPanel nodes={buttonSet()} onInsert={() => {}} />));
    expect(q("[data-action='add-variant']")).toBeNull();
    expect(q("[data-action='variant-menu']")).toBeNull();
  });
});
