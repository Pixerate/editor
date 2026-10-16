// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { CommandRegistry } from "@pixerate/editor/commands";
import { VectorEditorController, rectSubpath, vectorNodeBounds, type VectorDocument } from "@pixerate/editor/vector";
import {
  VectorCanvas,
  VectorEditor,
  VectorStylePanel,
  VectorToolbar,
  useVectorCommands,
  useVectorEditor,
  useVectorEditorController,
  type UseVectorEditorResult,
} from "../src/vector";

let container: HTMLDivElement;
let root: any;

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

const doc = (): VectorDocument => ({
  width: 400,
  height: 300,
  nodes: [{ id: "a", type: "path", fill: "#ff0000", stroke: null, subpaths: [rectSubpath({ x: 0, y: 0, width: 100, height: 100 })] }],
});

let n = 0;
const make = () => new VectorEditorController({ document: doc(), createId: () => `r${++n}` });

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T;
const qa = (sel: string) => Array.from(container.querySelectorAll(sel));

const Pointer = ((globalThis as any).PointerEvent ?? MouseEvent) as typeof MouseEvent;
const pointer = (el: Element, type: string, x: number, y: number, init: MouseEventInit = {}) =>
  act(() => {
    el.dispatchEvent(new Pointer(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ...init }));
  });

const key = (el: Element, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  act(() => {
    el.dispatchEvent(e);
  });
  return e;
};

const click = (el: Element) =>
  act(() => {
    (el as HTMLElement).click();
  });

describe("VectorCanvas", () => {
  it("renders the document, the selection box and gradients", async () => {
    const c = make();
    c.setStyle({ fill: { type: "linear", angle: 90, stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] } }, ["a"]);
    c.select(["a"]);
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const path = q('[data-vector-scene] path[data-vector-id="a"]');
    expect(path.getAttribute("d")).toBe("M0 0L100 0L100 100L0 100Z");
    expect(path.getAttribute("fill")).toMatch(/^url\(#ve.*fill-a\)$/);
    expect(qa("linearGradient")).toHaveLength(1);
    expect(qa("[data-vector-selection] [data-handle]")).toHaveLength(9);
    expect(q("svg").getAttribute("role")).toBe("application");
  });

  it("drags to move, then undoes with the keyboard", async () => {
    const c = make();
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const svg = q("svg");
    pointer(svg, "pointerdown", 50, 50);
    pointer(svg, "pointermove", 80, 70);
    pointer(svg, "pointerup", 80, 70);
    expect(vectorNodeBounds(c.getNode("a")!)).toMatchObject({ x: 30, y: 20 });
    expect(q('[data-vector-scene] path').getAttribute("d")).toBe("M30 20L130 20L130 120L30 120Z");
    const e = key(svg, "z", { metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(vectorNodeBounds(c.getNode("a")!)).toMatchObject({ x: 0, y: 0 });
  });

  it("draws smart guides while a drag snaps, and clears them on release", async () => {
    const c = make();
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const svg = q("svg");
    pointer(svg, "pointerdown", 50, 50);
    pointer(svg, "pointermove", 147, 72);
    // The right edge (197) lines up with the artboard's centre line.
    expect(vectorNodeBounds(c.getNode("a")!)).toMatchObject({ x: 100, y: 22 });
    const lines = qa("[data-vector-guides] [data-vector-guide]");
    expect(lines).toHaveLength(1);
    expect(lines[0].getAttribute("data-vector-guide")).toBe("align");
    expect([lines[0].getAttribute("x1"), lines[0].getAttribute("x2")]).toEqual(["200", "200"]);
    expect(qa("[data-vector-guide-label]").map((l) => l.textContent)).toEqual(["align"]);
    pointer(svg, "pointerup", 147, 72);
    expect(qa("[data-vector-guide]")).toHaveLength(0);
    expect(qa("[data-vector-guide-label]")).toHaveLength(0);
  });

  it("labels the anchor the pen tool will land on", async () => {
    const c = make();
    c.setTool("pen");
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    pointer(q("svg"), "pointermove", 98, 102);
    expect(c.getState().pointer).toEqual({ x: 100, y: 100 });
    const label = q("[data-vector-guide-label]");
    expect(label.getAttribute("data-vector-guide-label")).toBe("anchor");
    expect(label.textContent).toBe("anchor");
  });

  it("draws with the pen tool and shows anchors and the rubber band", async () => {
    const c = make();
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const svg = q("svg");
    key(svg, "p");
    expect(svg.getAttribute("data-tool")).toBe("pen");
    pointer(svg, "pointerdown", 200, 200);
    pointer(svg, "pointerup", 200, 200);
    pointer(svg, "pointerdown", 300, 200);
    pointer(svg, "pointerup", 300, 200);
    pointer(svg, "pointermove", 300, 280);
    expect(qa("[data-vector-anchor]")).toHaveLength(2);
    expect(q('[data-vector-overlay] path[stroke-dasharray="4 3"]').getAttribute("d")).toBe("M300 200L300 280");
    key(svg, "Enter");
    expect(c.getState().pen).toBeNull();
    expect(c.getState().document.nodes).toHaveLength(2);
  });

  it("ignores keys typed into inputs", async () => {
    const c = make();
    await act(async () =>
      root.render(
        <div>
          <VectorCanvas controller={c} fitOnMount={false} />
        </div>,
      ),
    );
    const input = document.createElement("input");
    q("svg").appendChild(input);
    const e = key(input, "p");
    expect(e.defaultPrevented).toBe(false);
    expect(c.getState().tool).toBe("select");
  });

  it("renders rotated nodes with a rotated selection box", async () => {
    const c = make();
    c.select(["a"]);
    c.rotate(30);
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    expect(q('[data-vector-scene] path[data-vector-id="a"]').getAttribute("transform")).toMatch(/^matrix\(0\.866025 0\.5 -0\.5 0\.866025 /);
    expect(q("[data-vector-selection]").getAttribute("transform")).toBe("rotate(30 0 0)");
  });

  it("shows a marquee while dragging on empty canvas", async () => {
    const c = make();
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const svg = q("svg");
    pointer(svg, "pointerdown", 390, 290);
    pointer(svg, "pointermove", 50, 50);
    expect(q("[data-vector-marquee]")).not.toBeNull();
    pointer(svg, "pointerup", 50, 50);
    expect(q("[data-vector-marquee]")).toBeNull();
    expect(c.getState().selection).toEqual(["a"]);
  });
});

describe("VectorToolbar and VectorStylePanel", () => {
  it("switches tools and runs boolean operations", async () => {
    const c = make();
    c.addShape({ kind: "rect", x: 50, y: 0, width: 100, height: 100 });
    await act(async () => root.render(<VectorToolbar controller={c} />));
    click(q('[data-vector-tool="ellipse"]'));
    expect(c.getState().tool).toBe("ellipse");
    expect(q('[data-vector-tool="ellipse"]').getAttribute("aria-pressed")).toBe("true");
    const union = q('button[aria-label="Union"]') as HTMLButtonElement;
    expect(union.disabled).toBe(true);
    await act(async () => c.select(c.getState().document.nodes.map((n) => n.id)));
    expect(union.disabled).toBe(false);
    click(union);
    expect(c.getState().document.nodes).toHaveLength(1);
    expect((q('button[aria-label^="Undo"]') as HTMLButtonElement).title).toBe("Undo Union");
  });

  it("toggles snapping", async () => {
    const c = make();
    await act(async () => root.render(<VectorToolbar controller={c} />));
    const snap = q('[data-vector-snap]');
    expect(snap.getAttribute("aria-pressed")).toBe("true");
    expect(snap.title).toMatch(/to bypass/);
    click(snap);
    expect(c.getState().snap.objects).toBe(false);
    expect(snap.getAttribute("aria-pressed")).toBe("false");
    click(snap);
    expect(c.getState().snap.objects).toBe(true);
  });

  it("edits the selection style, or the defaults when nothing is selected", async () => {
    const c = make();
    await act(async () => root.render(<VectorStylePanel controller={c} />));
    expect(container.textContent).toContain("New shapes");
    const width = q<HTMLInputElement>('input[aria-label="Stroke width"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(width, "5");
      width.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(c.getState().defaults.strokeWidth).toBe(5);
    await act(async () => c.select(["a"]));
    expect(container.textContent).toContain("Selection");
    expect(q<HTMLInputElement>('input[aria-label="Fill colour"]').value).toBe("#ff0000");
    click(q('input[aria-label="Fill on"]'));
    expect((c.getNode("a") as any).fill).toBeNull();
  });
});

const setValue = async (el: HTMLInputElement | HTMLSelectElement, value: string) =>
  act(async () => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });

describe("live corners, stroke alignment and arrowheads (React)", () => {
  it("draws aligned strokes in parts, clipped or masked, and arrowheads", async () => {
    const c = make();
    c.setStyle({ stroke: "#000", strokeWidth: 4, strokeAlign: "inside" }, ["a"]);
    const line = c.addPath("M0 200 L100 200", { stroke: "#00f", endArrow: "triangle" });
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const g = q('[data-vector-scene] g[data-vector-id="a"]');
    expect(g.getAttribute("data-vector-stroke-align")).toBe("inside");
    const stroke = g.querySelector('[data-vector-part="stroke"]')!;
    expect(stroke.getAttribute("stroke-width")).toBe("8");
    const clipId = stroke.getAttribute("clip-path")!.match(/url\(#(.+)\)/)![1];
    expect(g.querySelector(`clipPath[id="${clipId}"] path`)!.getAttribute("d")).toBe("M0 0L100 0L100 100L0 100Z");
    expect(g.querySelector('[data-vector-part="fill"]')!.getAttribute("fill")).toBe("#ff0000");
    await act(async () => c.setStyle({ strokeAlign: "outside" }, ["a"]));
    expect(q('[data-vector-id="a"] mask rect').getAttribute("fill")).toBe("#fff");
    expect(q('[data-vector-id="a"] [data-vector-part="stroke"]').getAttribute("mask")).toMatch(/^url\(#/);
    const heads = qa(`[data-vector-id="${line}"] [data-vector-part="head"]`);
    expect(heads).toHaveLength(1);
    expect(heads[0].getAttribute("fill")).toBe("#00f");
  });

  it("drags a live corner widget with the direct tool", async () => {
    const c = make();
    c.setTool("direct");
    c.select(["a"]);
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    expect(qa("[data-vector-corner-widget]")).toHaveLength(4);
    const svg = q("svg");
    pointer(svg, "pointerdown", 10, 10);
    pointer(svg, "pointermove", 20, 20);
    expect(q("[data-vector-status]").textContent).toBe("R 10");
    pointer(svg, "pointerup", 20, 20);
    expect((c.getNode("a") as any).subpaths[0].anchors.map((a: any) => a.corner?.radius)).toEqual([10, 10, 10, 10]);
    expect(q('[data-vector-scene] path[data-vector-id="a"]').getAttribute("d")).toContain("C");
  });

  it("style panel edits alignment, corners and arrowheads", async () => {
    const c = make();
    c.select(["a"]);
    await act(async () => root.render(<VectorStylePanel controller={c} />));
    await setValue(q<HTMLSelectElement>('select[aria-label="Stroke alignment"]'), "outside");
    expect((c.getNode("a") as any).strokeAlign).toBe("outside");
    await setValue(q<HTMLInputElement>('input[aria-label="Corner radius"]'), "12");
    expect((c.getNode("a") as any).subpaths[0].anchors.every((a: any) => a.corner?.radius === 12)).toBe(true);
    await setValue(q<HTMLSelectElement>('select[aria-label="Corner kind"]'), "chamfer");
    expect((c.getNode("a") as any).subpaths[0].anchors[0].corner).toEqual({ radius: 12, kind: "chamfer" });
    // Closed shapes have no ends for arrowheads.
    expect(q('select[aria-label="End arrowhead"]')).toBeNull();
    const line = c.addPath("M0 200 L100 200", { stroke: "#000" });
    await act(async () => c.select([line]));
    expect(q('[data-vector-style="corners"]')).toBeNull();
    await setValue(q<HTMLSelectElement>('select[aria-label="End arrowhead"]'), "circle");
    expect((c.getNode(line) as any).endArrow).toBe("circle");
    await setValue(q<HTMLSelectElement>('select[aria-label="Arrowhead alignment"]'), "tip");
    expect((c.getNode(line) as any).arrowAlign).toBe("tip");
    await setValue(q<HTMLInputElement>('input[aria-label="End arrowhead scale"]'), "2");
    expect((c.getNode(line) as any).endArrowScale).toBe(2);
    await setValue(q<HTMLSelectElement>('select[aria-label="End arrowhead"]'), "");
    expect((c.getNode(line) as any).endArrow).toBeNull();
    // Nothing selected: the defaults for new shapes.
    await act(async () => c.select([]));
    await setValue(q<HTMLInputElement>('input[aria-label="Corner radius"]'), "5");
    expect(c.getState().defaults.cornerRadius).toBe(5);
  });
});

describe("path editing (React)", () => {
  it("bends a segment, previews knife strokes and shows the scissors cut point", async () => {
    const c = make();
    c.setTool("direct");
    c.select(["a"]);
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const svg = q("svg");
    pointer(svg, "pointerdown", 50, 0);
    pointer(svg, "pointermove", 50, -20);
    pointer(svg, "pointerup", 50, -40);
    expect(c.getState().undoLabel).toBe("Bend Segment");
    expect(q('[data-vector-scene] path').getAttribute("d")).toMatch(/^M0 0C/);
    key(svg, "k");
    pointer(svg, "pointerdown", -10, 150);
    pointer(svg, "pointermove", 60, 150);
    expect(q("[data-vector-tool-stroke]").getAttribute("data-vector-tool-stroke")).toBe("knife");
    pointer(svg, "pointerup", 60, 150);
    expect(qa("[data-vector-tool-stroke]")).toHaveLength(0);
    key(svg, "c");
    pointer(svg, "pointermove", 100, 50);
    expect(q("[data-vector-cut-point]").getAttribute("cx")).toBe("100");
  });

  it("shows the eraser swath and the pencil's lazy-mouse string", async () => {
    const c = make();
    c.setEditing({ pencilSmoothing: 0.3 });
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const svg = q("svg");
    key(svg, "e");
    pointer(svg, "pointerdown", 50, -20);
    pointer(svg, "pointermove", 50, 120);
    expect(q("[data-vector-tool-stroke]").getAttribute("stroke-width")).toBe("10");
    pointer(svg, "pointerup", 50, 120);
    expect(c.getState().document.nodes).toHaveLength(2);
    key(svg, "n");
    pointer(svg, "pointerdown", 200, 200);
    pointer(svg, "pointermove", 210, 200);
    expect(qa("[data-vector-pencil-string]")).toHaveLength(1);
    pointer(svg, "pointerup", 260, 200);
  });

  it("toolbar runs Join and Smooth, toggles settings and shows tool inputs", async () => {
    const c = make();
    c.addPath("M200 0 L300 0", { stroke: "#000" });
    await act(async () => root.render(<VectorToolbar controller={c} />));
    const join = q('[data-vector-path-action="join"]') as HTMLButtonElement;
    expect(join.title).toMatch(/Join \((⌘|Ctrl)\+J\)/);
    click(join);
    expect((c.getNode(c.getState().selection[0]) as any).subpaths[0].closed).toBe(true);
    expect((q('[data-vector-path-action="average"]') as HTMLButtonElement).disabled).toBe(true);
    const curv = q('[data-vector-edit="curvatureMoves"]');
    expect(curv.getAttribute("aria-pressed")).toBe("false");
    click(curv);
    expect(c.getState().editing.curvatureMoves).toBe(true);
    expect(curv.getAttribute("aria-pressed")).toBe("true");
    expect(qa('input[aria-label="Eraser size"]')).toHaveLength(0);
    click(q('[data-vector-tool="eraser"]'));
    const size = q<HTMLInputElement>('input[aria-label="Eraser size"]');
    expect(size.value).toBe("10");
    click(q('[data-vector-tool="pencil"]'));
    expect(qa('input[aria-label="Pencil smoothing"]')).toHaveLength(1);
    expect(qa('[data-vector-tool="scissors"], [data-vector-tool="knife"]')).toHaveLength(2);
  });
});

describe("VectorEditor and hooks", () => {
  it("renders toolbar, canvas and style panel", async () => {
    const c = make();
    await act(async () => root.render(<VectorEditor controller={c} canvasProps={{ fitOnMount: false }} />));
    expect(q('[role="toolbar"]')).not.toBeNull();
    expect(q("svg[role=application]")).not.toBeNull();
    expect(container.textContent).toContain("New shapes");
  });

  it("useVectorEditor creates a controller and re-renders on change", async () => {
    let result!: UseVectorEditorResult;
    function Probe() {
      result = useVectorEditor({ document: doc() });
      return <span data-count>{result.state.document.nodes.length}</span>;
    }
    await act(async () => root.render(<Probe />));
    expect(q("[data-count]").textContent).toBe("1");
    await act(async () => void result.controller.addShape({ kind: "rect", x: 0, y: 0, width: 5, height: 5 }));
    expect(q("[data-count]").textContent).toBe("2");
    await act(async () => result.undo());
    expect(q("[data-count]").textContent).toBe("1");
    expect(result.toSvg()).toContain("<svg");
  });

  it("useVectorCommands registers commands while mounted", async () => {
    const registry = new CommandRegistry();
    let controller!: VectorEditorController;
    function Host() {
      controller = useVectorEditorController({ document: doc() });
      useVectorCommands(registry, controller);
      return null;
    }
    await act(async () => root.render(<Host />));
    expect(registry.has("vector.addShape")).toBe(true);
    expect(registry.execute("vector.addShape", { kind: "star", x: 0, y: 0, width: 10, height: 10 })).toMatchObject({ ok: true });
    expect(controller.getState().document.nodes).toHaveLength(2);
    await act(async () => root.render(<div />));
    expect(registry.has("vector.addShape")).toBe(false);
  });
});
