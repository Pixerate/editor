import { describe, it, expect, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { CommandRegistry } from "@pixerate/editor/commands";
import { VectorEditorController, rectSubpath, vectorNodeBounds, type VectorDocument } from "@pixerate/editor/vector";
import { VectorCanvas, VectorEditor, VectorStylePanel, VectorToolbar, createVectorEditor, useVectorCommands } from "../src/vector";

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

const doc = (): VectorDocument => ({
  width: 400,
  height: 300,
  nodes: [{ id: "a", type: "path", fill: "#ff0000", stroke: null, subpaths: [rectSubpath({ x: 0, y: 0, width: 100, height: 100 })] }],
});

let n = 0;
const make = () => new VectorEditorController({ document: doc(), createId: () => `s${++n}` });

const Pointer = ((globalThis as any).PointerEvent ?? MouseEvent) as typeof MouseEvent;
const pointer = (el: Element, type: string, x: number, y: number, init: MouseEventInit = {}) => {
  el.dispatchEvent(new Pointer(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...init }));
  flushSync();
};
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  flushSync();
  return e;
};
const click = (el: Element | null) => {
  (el as HTMLElement).click();
  flushSync();
};

describe("VectorCanvas (svelte)", () => {
  it("renders the document, the selection box and gradients", () => {
    const c = make();
    c.setStyle({ fill: { type: "linear", angle: 90, stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] } }, ["a"]);
    c.select(["a"]);
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const path = t.querySelector('[data-vector-scene] path[data-vector-id="a"]')!;
    expect(path.getAttribute("d")).toBe("M0 0L100 0L100 100L0 100Z");
    expect(path.getAttribute("fill")).toMatch(/^url\(#ve.*fill-a\)$/);
    expect(t.querySelectorAll("linearGradient")).toHaveLength(1);
    expect(t.querySelectorAll("[data-vector-selection] [data-handle]")).toHaveLength(9);
  });

  it("drags to move, then undoes with the keyboard", () => {
    const c = make();
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const svg = t.querySelector("svg")!;
    pointer(svg, "pointerdown", 50, 50);
    pointer(svg, "pointermove", 80, 70);
    pointer(svg, "pointerup", 80, 70);
    expect(vectorNodeBounds(c.getNode("a")!)).toMatchObject({ x: 30, y: 20 });
    expect(t.querySelector("[data-vector-scene] path")!.getAttribute("d")).toBe("M30 20L130 20L130 120L30 120Z");
    expect(key(svg, "z", { metaKey: true }).defaultPrevented).toBe(true);
    expect(vectorNodeBounds(c.getNode("a")!)).toMatchObject({ x: 0, y: 0 });
  });

  it("draws with the pen tool and shows anchors and the rubber band", () => {
    const c = make();
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const svg = t.querySelector("svg")!;
    key(svg, "p");
    expect(svg.getAttribute("data-tool")).toBe("pen");
    pointer(svg, "pointerdown", 200, 200);
    pointer(svg, "pointerup", 200, 200);
    pointer(svg, "pointerdown", 300, 200);
    pointer(svg, "pointerup", 300, 200);
    pointer(svg, "pointermove", 300, 280);
    expect(t.querySelectorAll("[data-vector-anchor]")).toHaveLength(2);
    expect(t.querySelector('[data-vector-overlay] path[stroke-dasharray="4 3"]')!.getAttribute("d")).toBe("M300 200L300 280");
    key(svg, "Enter");
    expect(c.getState().pen).toBeNull();
    expect(c.getState().document.nodes).toHaveLength(2);
  });

  it("ignores keys typed into inputs", () => {
    const c = make();
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const input = document.createElement("input");
    t.querySelector("svg")!.appendChild(input);
    expect(key(input, "p").defaultPrevented).toBe(false);
    expect(c.getState().tool).toBe("select");
  });

  it("shows a marquee while dragging on empty canvas", () => {
    const c = make();
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const svg = t.querySelector("svg")!;
    pointer(svg, "pointerdown", 390, 290);
    pointer(svg, "pointermove", 50, 50);
    expect(t.querySelector("[data-vector-marquee]")).not.toBeNull();
    pointer(svg, "pointerup", 50, 50);
    expect(t.querySelector("[data-vector-marquee]")).toBeNull();
    expect(c.getState().selection).toEqual(["a"]);
  });
});

describe("VectorToolbar and VectorStylePanel (svelte)", () => {
  it("switches tools and runs boolean operations", () => {
    const c = make();
    c.addShape({ kind: "rect", x: 50, y: 0, width: 100, height: 100 });
    const t = render(VectorToolbar, { controller: c });
    click(t.querySelector('[data-vector-tool="ellipse"]'));
    expect(c.getState().tool).toBe("ellipse");
    expect(t.querySelector('[data-vector-tool="ellipse"]')!.getAttribute("aria-pressed")).toBe("true");
    const union = t.querySelector('button[aria-label="Union"]') as HTMLButtonElement;
    expect(union.disabled).toBe(true);
    c.select(c.getState().document.nodes.map((node) => node.id));
    flushSync();
    expect(union.disabled).toBe(false);
    click(union);
    expect(c.getState().document.nodes).toHaveLength(1);
    expect((t.querySelector('button[aria-label^="Undo"]') as HTMLButtonElement).title).toBe("Undo Union");
  });

  it("edits the selection style, or the defaults when nothing is selected", () => {
    const c = make();
    const t = render(VectorStylePanel, { controller: c });
    expect(t.textContent).toContain("New shapes");
    const width = t.querySelector('input[aria-label="Stroke width"]') as HTMLInputElement;
    width.value = "5";
    width.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(c.getState().defaults.strokeWidth).toBe(5);
    c.select(["a"]);
    flushSync();
    expect(t.textContent).toContain("Selection");
    expect((t.querySelector('input[aria-label="Fill colour"]') as HTMLInputElement).value).toBe("#ff0000");
    click(t.querySelector('input[aria-label="Fill on"]'));
    expect((c.getNode("a") as any).fill).toBeNull();
  });
});

describe("VectorEditor and runes (svelte)", () => {
  it("renders toolbar, canvas and style panel", () => {
    const t = render(VectorEditor, { controller: make(), canvasProps: { fitOnMount: false } });
    expect(t.querySelector('[role="toolbar"]')).not.toBeNull();
    expect(t.querySelector("svg[role=application]")).not.toBeNull();
    expect(t.textContent).toContain("New shapes");
  });

  it("createVectorEditor exposes reactive state", () => {
    const editor = createVectorEditor({ document: doc() });
    expect(editor.state.document.nodes).toHaveLength(1);
    editor.controller.addShape({ kind: "rect", x: 0, y: 0, width: 5, height: 5 });
    expect(editor.state.document.nodes).toHaveLength(2);
    editor.undo();
    expect(editor.state.document.nodes).toHaveLength(1);
    expect(editor.toSvg()).toContain("<svg");
    editor.destroy();
  });

  it("useVectorCommands registers commands for the effect's lifetime", () => {
    const registry = new CommandRegistry();
    const controller = make();
    const stop = $effect.root(() => {
      useVectorCommands(registry, controller);
    });
    flushSync();
    expect(registry.has("vector.addShape")).toBe(true);
    expect(registry.execute("vector.addShape", { kind: "star", x: 0, y: 0, width: 10, height: 10 })).toMatchObject({ ok: true });
    expect(controller.getState().document.nodes).toHaveLength(2);
    stop();
    expect(registry.has("vector.addShape")).toBe(false);
  });
});
