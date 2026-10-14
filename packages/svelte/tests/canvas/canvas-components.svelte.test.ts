import { describe, it, expect, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { HistoryManager } from "@pixerate/editor/history";
import {
  CanvasComponentsPanel,
  CanvasInstanceInspector,
  CANVAS_COMPONENT_DRAG_TYPE,
  bindCanvasComponentProperty,
  combineCanvasComponentsAsVariants,
  createCanvasComponent,
  createCanvasComponents,
  getInstanceData,
  getNodeOverrides,
  setCanvasComponentProperty,
} from "../../src/canvas";
import type { CanvasNode } from "../../src/canvas/types";

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

function render(component: any, props: Record<string, any>) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target, props });
  flushSync();
  cleanups.push(() => {
    unmount(instance);
    target.remove();
  });
  return target;
}

const q = <T extends Element = HTMLElement>(root: Element, sel: string) => root.querySelector(sel) as T;
const qa = (root: Element, sel: string) => [...root.querySelectorAll(sel)] as HTMLElement[];
function choose(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
}
function commit(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new FocusEvent("blur"));
  flushSync();
}
function click(el: Element) {
  (el as HTMLElement).click();
  flushSync();
}

const frame = (id: string, label: string, x: number, y: number): CanvasNode => ({ id, type: "group", position: { x, y }, width: 120, height: 40, data: { label } }) as CanvasNode;
const rect = (id: string, parentId: string, label: string, fill: string): CanvasNode =>
  ({ id, type: "shape", parentId, position: { x: 0, y: 0 }, width: 120, height: 40, data: { label, shape: { kind: "rect", fill } } }) as CanvasNode;
const text = (id: string, parentId: string, label: string): CanvasNode =>
  ({ id, type: "text", parentId, position: { x: 10, y: 10 }, data: { label, name: "Label" } }) as CanvasNode;

function buttonSet(): CanvasNode[] {
  let nodes: any[] = [
    frame("primary", "Style=Primary", 0, 0),
    rect("primary-bg", "primary", "Bg", "#2563eb"),
    text("primary-label", "primary", "Button"),
    frame("secondary", "Style=Secondary", 0, 80),
    rect("secondary-bg", "secondary", "Bg", "#e2e8f0"),
    text("secondary-label", "secondary", "Button"),
  ];
  const ok = (r: { ok: boolean; nodes: any[] }) => {
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.nodes;
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

describe("createCanvasComponents + panel + inspector (Svelte)", () => {
  it("inserts instances from the panel and edits them in the inspector", () => {
    const history = new HistoryManager();
    const state = $state({ nodes: buttonSet(), selected: null as string | null });
    const errors: string[] = [];
    const components = createCanvasComponents({
      getNodes: () => state.nodes,
      setNodes: (n) => {
        state.nodes = n;
      },
      history,
    });
    cleanups.push(components.destroy);
    const panelProps = $state({
      get nodes() {
        return state.nodes;
      },
      oninsert: (id: string) => {
        const r = components.createInstance(id, { position: { x: 300, y: 0 } });
        if (r.ok) state.selected = r.ids[0];
      },
    });
    const panel = render(CanvasComponentsPanel, panelProps);
    const inspector = render(CanvasInstanceInspector, {
      get nodes() {
        return state.nodes;
      },
      get nodeId() {
        return state.selected;
      },
      components,
      onerror: (e: string) => errors.push(e),
    });
    expect(qa(panel, "[data-component-set] [data-kind='variant']").map((b) => b.getAttribute("data-component-id"))).toEqual(["primary", "secondary"]);
    const data = new Map<string, string>();
    const ev = new Event("dragstart", { bubbles: true }) as any;
    ev.dataTransfer = { setData: (t: string, v: string) => data.set(t, v), effectAllowed: "" };
    q(panel, "[data-component-id='button']").dispatchEvent(ev);
    expect(data.get(CANVAS_COMPONENT_DRAG_TYPE)).toBe("button");

    click(q(panel, "[data-component-id='button']"));
    const inst = state.selected!;
    expect(getInstanceData(state.nodes.find((n) => n.id === inst) as any)?.componentId).toBe("primary");
    expect(q(inspector, "[data-instance-main]").textContent?.trim()).toBe("Style=Primary");

    commit(q<HTMLInputElement>(inspector, "[data-component-property='Text'] input"), "Buy now");
    const label = () => state.nodes.find((n) => n.parentId === inst && n.type === "text")!;
    expect(label().data.label).toBe("Buy now");
    choose(q<HTMLSelectElement>(inspector, "[data-variant-property='Style'] select"), "Secondary");
    expect(getInstanceData(state.nodes.find((n) => n.id === inst) as any)?.componentId).toBe("secondary");
    expect(label().data.label).toBe("Buy now");
    click(q(inspector, "[data-component-property='Show'] input"));
    const bg = () => state.nodes.find((n) => n.parentId === inst && n.type === "shape")!;
    expect(bg().hidden).toBe(true);

    // Main edit reaches the instance (auto sync); an instance edit is an override.
    state.nodes = state.nodes.map((n) => (n.id === "secondary-bg" ? { ...n, data: { ...n.data, shape: { ...n.data.shape, fill: "#000000" } } } : n));
    flushSync();
    expect(bg().data.shape.fill).toBe("#000000");
    state.nodes = state.nodes.map((n) => (n.id === bg().id ? { ...n, data: { ...n.data, shape: { ...n.data.shape, fill: "#ff0000" } } } : n));
    flushSync();
    expect(getNodeOverrides(bg() as any)).toEqual(["shape.fill"]);
    click(q(inspector, "[data-override-group='shape.fill']"));
    expect(bg().data.shape.fill).toBe("#000000");

    click(q(inspector, "[data-action='reset']"));
    expect(label().data.label).toBe("Button");
    history.undo();
    flushSync();
    expect(label().data.label).toBe("Buy now");

    click(q(inspector, "[data-action='go-to-main']"));
    expect(state.nodes.find((n) => n.id === "secondary")!.selected).toBe(true);
    click(q(inspector, "[data-action='detach']"));
    expect(getInstanceData(state.nodes.find((n) => n.id === inst) as any)).toBeUndefined();
    expect(q(inspector, "[data-instance-inspector]")).toBeNull();
    expect(errors).toEqual([]);
  });

  it("shows a missing main and restores it", () => {
    const state = $state({
      nodes: [
        { id: "i", type: "group", position: { x: 0, y: 0 }, data: { label: "Card", instance: { componentId: "gone", properties: {} }, componentSource: "gone" } },
        { id: "i:bg", type: "shape", parentId: "i", position: { x: 0, y: 0 }, data: { label: "Bg", componentSource: "bg", shape: { kind: "rect", fill: "#fff" } } },
      ] as CanvasNode[],
    });
    const components = createCanvasComponents({ getNodes: () => state.nodes, setNodes: (n) => (state.nodes = n), autoSync: false });
    const root = render(CanvasInstanceInspector, {
      get nodes() {
        return state.nodes;
      },
      nodeId: "i:bg",
      components,
    });
    expect(q(root, "[data-instance-main]").textContent?.trim()).toBe("Main component missing");
    click(q(root, "[data-action='restore']"));
    expect(state.nodes.map((n) => n.id)).toEqual(["gone", "bg"]);
  });

  it("filters the panel and shows an empty state", () => {
    const empty = render(CanvasComponentsPanel, { nodes: [], oninsert: () => {} });
    expect(q(empty, "[data-components-panel] p")?.textContent).toContain("No components yet");
    const inserted: string[] = [];
    const root = render(CanvasComponentsPanel, { nodes: buttonSet(), oninsert: (id: string) => inserted.push(id) });
    const input = q<HTMLInputElement>(root, "input[type='search']");
    input.value = "zzz";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(qa(root, "[data-component-id]")).toHaveLength(0);
    input.value = "secondary";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(qa(root, "[data-component-id]").map((b) => b.getAttribute("data-component-id"))).toEqual(["button", "primary", "secondary"]);
    click(q(root, "[data-component-id='secondary']"));
    expect(inserted).toEqual(["secondary"]);
  });
});
