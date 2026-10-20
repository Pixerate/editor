// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { CommandRegistry } from "@pixerate/editor/commands";
import { VectorEditorController, rectSubpath, vectorNodeBounds, type VectorDocument, type VectorPathNode } from "@pixerate/editor/vector";
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

describe("variable-width strokes (React)", () => {
  const penPointer = (el: Element, type: string, x: number, y: number, pressure: number) =>
    act(() => {
      const e = new Pointer(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperty(e, "pressure", { value: pressure });
      Object.defineProperty(e, "pointerType", { value: "pen" });
      el.dispatchEvent(e);
    });

  it("draws a profiled stroke as a filled outline", async () => {
    const c = make();
    const line = c.addPath("M0 200 L200 200", { stroke: "#00f", strokeWidth: 10, strokeWidthProfile: [{ t: 0, left: 1, right: 1 }, { t: 1, left: 0, right: 0 }] });
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const outline = q(`[data-vector-id="${line}"] [data-vector-part="stroke-outline"]`);
    expect(outline.getAttribute("fill")).toBe("#00f");
    expect(outline.getAttribute("d")).toMatch(/^M/);
    expect(qa(`[data-vector-id="${line}"] [data-vector-part="stroke"]`)).toHaveLength(0);
  });

  it("drags a width point with the width tool and shows its handles", async () => {
    const c = make();
    const line = c.addPath("M0 200 L200 200", { stroke: "#000", strokeWidth: 10 });
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const svg = q("svg");
    key(svg, "w");
    expect(c.getState().tool).toBe("width");
    pointer(svg, "pointermove", 100, 202);
    expect(qa("[data-vector-width-spot]")).toHaveLength(1);
    pointer(svg, "pointerdown", 100, 202);
    pointer(svg, "pointermove", 100, 220);
    expect(q("[data-vector-status]").textContent).toBe("W 40");
    pointer(svg, "pointerup", 100, 220);
    expect((c.getNode(line) as any).strokeWidthProfile[1]).toEqual({ t: 0.5, left: 4, right: 4 });
    expect(qa("[data-vector-width-point]")).toHaveLength(3);
    expect(q('[data-vector-width-point][data-selected] [data-vector-width-side="right"]').getAttribute("cy")).toBe("220");
    key(svg, "Delete");
    expect((c.getNode(line) as any).strokeWidthProfile).toHaveLength(2);
  });

  it("Shift-selects, Alt-copies and edits width points numerically", async () => {
    const c = make();
    const profile = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ t, left: 1, right: 1 }));
    const line = c.addPath("M0 200 L200 200", { stroke: "#000", strokeWidth: 10, strokeWidthProfile: profile });
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const svg = q("svg");
    const ts = () => (c.getNode(line) as any).strokeWidthProfile.map((p: any) => Math.round(p.t * 1000) / 1000);
    key(svg, "w");
    pointer(svg, "pointerdown", 50, 200);
    pointer(svg, "pointerup", 50, 200);
    pointer(svg, "pointerdown", 150, 200, { shiftKey: true });
    pointer(svg, "pointerup", 150, 200, { shiftKey: true });
    expect(qa("[data-vector-width-point][data-selected]")).toHaveLength(2);
    // Both move with the one dragged; Delete removes both.
    pointer(svg, "pointerdown", 50, 200);
    pointer(svg, "pointermove", 70, 200);
    pointer(svg, "pointerup", 70, 200);
    expect(ts()).toEqual([0, 0.35, 0.5, 0.85, 1]);
    key(svg, "Delete");
    expect(ts()).toEqual([0, 0.5, 1]);
    // Alt-drag the centre: a copy slides.
    pointer(svg, "pointerdown", 100, 200, { altKey: true });
    pointer(svg, "pointermove", 140, 200, { altKey: true });
    pointer(svg, "pointerup", 140, 200, { altKey: true });
    expect(ts()).toEqual([0, 0.5, 0.7, 1]);
    // Double-click opens Width Point Edit beside the point.
    act(() => void svg.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 140, clientY: 200 })));
    const pos = q<HTMLInputElement>('input[aria-label="Width point position"]');
    expect(pos.value).toBe("70");
    expect(q<HTMLInputElement>('input[aria-label="Width point left side"]').value).toBe("5");
    expect(q("[data-vector-width-point-edit]").getAttribute("x")).toBe("152");
    // Keys typed in it don't reach the canvas.
    expect(key(pos, "Delete").defaultPrevented).toBe(false);
    expect(ts()).toEqual([0, 0.5, 0.7, 1]);
    await setValue(pos, "60");
    await setValue(q<HTMLInputElement>('input[aria-label="Width point left side"]'), "15");
    click(q('[data-vector-width-point-editor] button[type="submit"]'));
    expect((c.getNode(line) as any).strokeWidthProfile[2]).toEqual({ t: 0.6, left: 3, right: 1 });
    expect(qa("[data-vector-width-point-editor]")).toHaveLength(0);
    // Escape closes it without changes.
    act(() => void svg.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 120, clientY: 200 })));
    const left = q<HTMLInputElement>('input[aria-label="Width point left side"]');
    await setValue(left, "40");
    key(left, "Escape");
    expect(qa("[data-vector-width-point-editor]")).toHaveLength(0);
    expect((c.getNode(line) as any).strokeWidthProfile[2]).toEqual({ t: 0.6, left: 3, right: 1 });
    expect(c.getState().tool).toBe("width");
  });

  it("records pen pressure on pencil strokes", async () => {
    const c = make();
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const svg = q("svg");
    key(svg, "n");
    penPointer(svg, "pointerdown", 200, 200, 0.2);
    for (let i = 1; i <= 20; i++) penPointer(svg, "pointermove", 200 + i * 5, 200, 0.2 + i * 0.04);
    penPointer(svg, "pointerup", 300, 200, 0);
    const node = c.getNode(c.getState().selection[0]) as any;
    expect(node.strokeWidthProfile.length).toBeGreaterThan(1);
    expect(node.strokeWidthProfile[0].left).toBeLessThan(node.strokeWidthProfile[node.strokeWidthProfile.length - 1].left);
  });

  it("style panel picks a width profile and resets it", async () => {
    const c = make();
    const line = c.addPath("M0 200 L100 200", { stroke: "#000" });
    c.select([line]);
    await act(async () => root.render(<VectorStylePanel controller={c} />));
    const reset = q<HTMLButtonElement>('button[aria-label="Reset to uniform width"]');
    expect(reset.disabled).toBe(true);
    await setValue(q<HTMLSelectElement>('select[aria-label="Width profile"]'), "taperEnd");
    expect((c.getNode(line) as any).strokeWidthProfile).toEqual([{ t: 0, left: 1, right: 1 }, { t: 1, left: 0, right: 0 }]);
    expect(q<HTMLSelectElement>('select[aria-label="Width profile"]').value).toBe("taperEnd");
    click(q('button[aria-label="Reset to uniform width"]'));
    expect("strokeWidthProfile" in (c.getNode(line) as any)).toBe(false);
    // Nothing selected: the default for new paths.
    await act(async () => c.select([]));
    await setValue(q<HTMLSelectElement>('select[aria-label="Width profile"]'), "bulge");
    expect(c.getState().defaults.strokeWidthProfile).toHaveLength(3);
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

describe("Pathfinder, Shape Builder and paint bucket (React)", () => {
  const two = () =>
    new VectorEditorController({
      document: {
        width: 400,
        height: 300,
        nodes: [
          { id: "a", type: "path", fill: "#ff0000", stroke: null, subpaths: [rectSubpath({ x: 0, y: 0, width: 100, height: 100 })] },
          { id: "b", type: "path", fill: "#0000ff", stroke: null, subpaths: [rectSubpath({ x: 50, y: 50, width: 100, height: 100 })] },
        ],
      },
      createId: () => `p${++n}`,
    });

  it("highlights the hovered and dragged faces and merges them on release", async () => {
    const c = two();
    c.select(["a", "b"]);
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const svg = q("svg");
    key(svg, "m");
    expect(c.getState().tool).toBe("shapeBuilder");
    pointer(svg, "pointermove", 75, 75);
    expect(q("[data-vector-builder]").getAttribute("data-vector-builder")).toBe("merge");
    expect(qa("[data-vector-builder-face]")).toHaveLength(1);
    pointer(svg, "pointerdown", 20, 20);
    pointer(svg, "pointermove", 75, 75);
    expect(qa("[data-vector-builder-face]")).toHaveLength(2);
    expect(qa("[data-vector-builder-trail]")).toHaveLength(1);
    pointer(svg, "pointerup", 75, 75);
    expect(qa("[data-vector-builder-face]")).toHaveLength(0);
    expect(c.getState().undoLabel).toBe("Shape Builder");
    pointer(svg, "pointermove", 120, 120, { altKey: true });
    expect(q("[data-vector-builder]").getAttribute("data-vector-builder")).toBe("erase");
  });

  it("hatches hovered faces and erases an outline edge with Alt", async () => {
    const c = two();
    c.select(["a", "b"]);
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const svg = q("svg");
    key(svg, "m");
    pointer(svg, "pointermove", 75, 75);
    expect(qa("[data-vector-builder-hatch]")).toHaveLength(1);
    expect(q("[data-vector-builder-hatch]").getAttribute("d")).toMatch(/^M/);
    // a's corner inside b: the edge, not the face.
    pointer(svg, "pointermove", 101, 75, { altKey: true });
    expect(qa("[data-vector-builder-face]")).toHaveLength(0);
    expect(qa("[data-vector-builder-hatch]")).toHaveLength(0);
    expect(qa("[data-vector-builder-line]")).toHaveLength(1);
    pointer(svg, "pointerdown", 101, 75, { altKey: true });
    pointer(svg, "pointerup", 101, 75, { altKey: true });
    const a = c.getNode("a") as VectorPathNode;
    expect(a.subpaths[0].closed).toBe(false);
    expect(c.getState().undoLabel).toBe("Shape Builder Delete");
  });

  it("previews the paint bucket region", async () => {
    const c = make();
    c.updateNode("a", { fill: null, stroke: "#000000" });
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const svg = q("svg");
    key(svg, "b");
    pointer(svg, "pointermove", 50, 50);
    expect(q("[data-vector-builder]").getAttribute("data-vector-builder")).toBe("fill");
    expect(qa("[data-vector-builder-face]")).toHaveLength(1);
    expect(qa("[data-vector-builder-hatch]")).toHaveLength(0);
    pointer(svg, "pointerdown", 50, 50);
    pointer(svg, "pointerup", 50, 50);
    expect(c.getState().document.nodes).toHaveLength(2);
  });

  it("toolbar runs Pathfinder operations and toggles gap closing", async () => {
    const c = two();
    await act(async () => root.render(<VectorToolbar controller={c} />));
    const divide = q<HTMLButtonElement>('[data-vector-pathfinder="divide"]');
    expect(divide.disabled).toBe(true);
    expect(qa("[data-vector-pathfinder]")).toHaveLength(6);
    act(() => c.select(["a", "b"]));
    click(q('[data-vector-pathfinder="trim"]'));
    expect(c.getState().undoLabel).toBe("Trim");
    expect(qa("[data-vector-fill-gap]")).toHaveLength(0);
    click(q('[data-vector-tool="paintBucket"]'));
    const gap = q("[data-vector-fill-gap]");
    expect(gap.getAttribute("aria-pressed")).toBe("false");
    click(gap);
    expect(c.getState().editing.fillGap).toBeGreaterThan(0);
  });
});

describe("Blend (React)", () => {
  const pair = () =>
    new VectorEditorController({
      document: {
        width: 400,
        height: 300,
        nodes: [
          { id: "a", type: "path", fill: "#ff0000", stroke: null, subpaths: [rectSubpath({ x: 0, y: 0, width: 20, height: 20 })] },
          { id: "b", type: "path", fill: "#0000ff", stroke: null, subpaths: [rectSubpath({ x: 200, y: 0, width: 20, height: 20 })] },
          { id: "s", type: "path", fill: null, stroke: "#000000", subpaths: [{ closed: false, anchors: [{ x: 10, y: 200 }, { x: 110, y: 100 }, { x: 210, y: 200 }] }] },
        ],
      },
      createId: () => `bl${++n}`,
    });

  it("toolbar makes a blend, edits its spacing, replaces its spine and expands it", async () => {
    const c = pair();
    await act(async () => root.render(<VectorToolbar controller={c} />));
    const make = q<HTMLButtonElement>('[data-vector-blend-action="make"]');
    expect(make.disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-vector-blend-action="expand"]').disabled).toBe(true);
    act(() => c.select(["a", "b"]));
    click(make);
    const id = c.getState().selection[0];
    const blend = () => c.getNode(id) as any;
    expect(blend().blend).toBeTruthy();
    expect(blend().children.filter((k: any) => k.blendStep)).toHaveLength(5);
    await setValue(q<HTMLInputElement>('input[aria-label="Blend steps"]'), "2");
    expect(blend().children.filter((k: any) => k.blendStep)).toHaveLength(2);
    await setValue(q<HTMLSelectElement>('select[aria-label="Blend spacing"]'), "distance");
    expect(blend().blend.spacing).toBe("distance");
    expect(q('input[aria-label="Blend distance"]')).toBeTruthy();
    click(q('[data-vector-blend-action="orient"]'));
    expect(blend().blend.orientToSpine).toBe(true);
    expect(q('[data-vector-blend-action="orient"]').getAttribute("aria-pressed")).toBe("true");
    act(() => c.select([id, "s"]));
    click(q('[data-vector-blend-action="spine"]'));
    expect(blend().blend.spine.anchors).toHaveLength(3);
    expect(c.getNode("s")).toBeUndefined();
    click(q('[data-vector-blend-action="expand"]'));
    expect(blend().blend).toBeUndefined();
    expect(c.getState().undoLabel).toBe("Expand Blend");
  });

  it("draws the spine and the Blend tool's first pick", async () => {
    const c = pair();
    const id = c.blend({ ids: ["a", "b"], steps: 3 })!;
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    expect(qa("[data-vector-scene] path")).toHaveLength(6);
    expect(q(`[data-vector-blend-spine="${id}"]`)).toBeTruthy();
    expect(qa(`[data-vector-blend-spine="${id}"] circle`)).toHaveLength(2);
    const svg = q("svg");
    key(svg, "j");
    expect(c.getState().tool).toBe("blend");
    act(() => c.select([]));
    pointer(svg, "pointermove", 10, 200);
    expect(qa("[data-vector-blend-anchor]")).toHaveLength(3);
    pointer(svg, "pointerdown", 10, 200);
    pointer(svg, "pointerup", 10, 200);
    expect(q("[data-vector-blend-start] circle")).toBeTruthy();
    pointer(svg, "pointerdown", 100, 10);
    expect(c.getState().blendStart).toBeNull();
    expect(c.getState().undoLabel).toBe("Blend");
  });
});

describe("path effects and live booleans (React)", () => {
  const pair = () =>
    new VectorEditorController({
      document: {
        width: 400,
        height: 300,
        nodes: [
          { id: "a", type: "path", fill: "#ff0000", stroke: null, subpaths: [rectSubpath({ x: 0, y: 0, width: 100, height: 100 })] },
          { id: "b", type: "path", fill: "#0000ff", stroke: null, subpaths: [rectSubpath({ x: 50, y: 50, width: 100, height: 100 })] },
        ],
      },
      createId: () => `fx${++n}`,
    });

  it("adds, edits, toggles, reorders, removes and expands effects", async () => {
    const c = pair();
    c.select(["a"]);
    await act(async () => root.render(<VectorStylePanel controller={c} />));
    expect(q("[data-vector-effects]")).toBeTruthy();
    expect(q<HTMLButtonElement>('button[aria-label="Expand Appearance"]').disabled).toBe(true);
    await setValue(q<HTMLSelectElement>('select[aria-label="Add effect"]'), "zigzag");
    const effects = () => c.getNode("a")!.effects ?? [];
    expect(effects().map((e) => e.type)).toEqual(["zigzag"]);
    expect(qa("[data-vector-effect]")).toHaveLength(1);
    // A slider drag is one undo step.
    const slider = q<HTMLInputElement>('input[aria-label="Zig Zag Size slider"]');
    for (const v of ["7", "8", "9"]) await setValue(slider, v);
    act(() => slider.dispatchEvent(new Event("pointerup", { bubbles: true })));
    expect((effects()[0].params as any).size).toBe(9);
    expect(q<HTMLInputElement>('input[aria-label="Zig Zag Size"]').value).toBe("9");
    act(() => void c.undo());
    expect((effects()[0].params as any).size).toBe(5);
    act(() => void c.redo());
    click(q('input[aria-label="Zig Zag Smooth"]'));
    expect((effects()[0].params as any).smooth).toBe(true);
    click(q('input[aria-label="Zig Zag on"]'));
    expect(effects()[0].enabled).toBe(false);
    await setValue(q<HTMLSelectElement>('select[aria-label="Add effect"]'), "repeater");
    expect(effects().map((e) => e.type)).toEqual(["zigzag", "repeater"]);
    await setValue(q<HTMLInputElement>('input[aria-label="Repeater Position x"]'), "150");
    expect((effects()[1].params as any).position).toEqual({ x: 150, y: 0 });
    click(q('button[aria-label="Move Repeater up"]'));
    expect(effects().map((e) => e.type)).toEqual(["repeater", "zigzag"]);
    click(q('button[aria-label="Remove Zig Zag"]'));
    expect(effects().map((e) => e.type)).toEqual(["repeater"]);
    expect(q<HTMLButtonElement>('button[aria-label="Expand Appearance"]').disabled).toBe(false);
    click(q('button[aria-label="Expand Appearance"]'));
    expect(c.getNode("a")!.type).toBe("group");
    expect(c.getState().undoLabel).toBe("Expand Appearance");
  });

  it("renders effected geometry and live booleans", async () => {
    const c = pair();
    c.addEffect("repeater", { ids: ["a"], params: { copies: 3, position: { x: 120, y: 0 } } });
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    expect(qa('[data-vector-scene] [data-vector-id^="a~fx"]')).toHaveLength(3);
    act(() => void c.removeEffect("a", c.getNode("a")!.effects![0].id));
    act(() => void c.booleanOp("subtract", { ids: ["a", "b"], live: true }));
    const id = c.getState().selection[0];
    const result = q(`[data-vector-scene] [data-vector-id="${id}"] path`);
    expect(result.getAttribute("d")).toBe("M0 0L100 0L100 50L50 50L50 100L0 100Z");
  });

  it("toolbar makes live booleans", async () => {
    const c = pair();
    await act(async () => root.render(<VectorToolbar controller={c} />));
    act(() => c.select(["a", "b"]));
    click(q("[data-vector-live-boolean]"));
    expect(q("[data-vector-live-boolean]").getAttribute("aria-pressed")).toBe("true");
    click(q('button[aria-label="Union"]'));
    const g = c.getNode(c.getState().selection[0]) as any;
    expect(g.liveBoolean).toBe("union");
    expect(g.children.map((k: any) => k.id)).toEqual(["a", "b"]);
    click(q('button[aria-label="Exclude"]'));
    expect((c.getNode(g.id) as any).liveBoolean).toBe("exclude");
  });
});

describe("gradients (React)", () => {
  const fillOf = (c: VectorEditorController) => (c.getNode("a") as VectorPathNode).fill as any;

  it("renders conic patterns and the gradient tool's annotator, and drags its handles", async () => {
    const c = make();
    c.select(["a"]);
    c.setGradient({ type: "conic", stops: [{ offset: 0, color: "#ff0000" }, { offset: 0.5, color: "#00ff00" }, { offset: 1, color: "#0000ff" }] });
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const pattern = q('pattern[id$="fill-a"]');
    expect(pattern.getAttribute("patternUnits")).toBe("userSpaceOnUse");
    expect(pattern.querySelectorAll("linearGradient").length).toBe(72);
    expect(q('[data-vector-scene] path[data-vector-id="a"]').getAttribute("fill")).toBe(`url(#${pattern.id})`);
    const svg = q("svg");
    key(svg, "g");
    expect(c.getState().tool).toBe("gradient");
    expect(q('[data-vector-gradient-annotator="conic"]')).toBeTruthy();
    expect(qa("[data-vector-gradient-stop]")).toHaveLength(3);
    expect(qa("[data-vector-gradient-midpoint]")).toHaveLength(2);
    expect(q('[data-vector-gradient-handle="radius"]')).toBeTruthy();
    expect(q('[data-vector-gradient-handle="aspect"]')).toBeTruthy();
    const a = c.getGradientAnnotator()!;
    pointer(svg, "pointerdown", a.end.x, a.end.y);
    pointer(svg, "pointermove", a.end.x + 10, a.end.y + 20);
    pointer(svg, "pointerup", a.end.x + 20, a.end.y + 40);
    expect(c.getGradientAnnotator()!.end.x).toBeCloseTo(a.end.x + 20);
    expect(c.getState().undoLabel).toBe("Gradient Handle");
    // Drag a stop off the bar: removed in one step.
    const s = c.getGradientAnnotator()!.stops[1];
    pointer(svg, "pointerdown", s.x, s.y);
    pointer(svg, "pointermove", s.x, s.y + 70);
    expect(q('[data-vector-status]').textContent).toBe("Release to delete the stop");
    pointer(svg, "pointerup", s.x, s.y + 70);
    expect(fillOf(c).stops).toHaveLength(2);
    expect(qa("[data-vector-gradient-stop]")).toHaveLength(2);
    // A diamond renders four quadrants.
    act(() => void c.setGradient({ type: "diamond" }));
    expect(q('pattern[id$="fill-a"]').querySelectorAll("path")).toHaveLength(4);
  });

  it("drags out a new gradient over a shape", async () => {
    const c = make();
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const svg = q("svg");
    key(svg, "g");
    pointer(svg, "pointerdown", 10, 50);
    pointer(svg, "pointermove", 50, 50);
    pointer(svg, "pointerup", 90, 50);
    expect(fillOf(c)).toMatchObject({ type: "linear", start: { x: 10, y: 50 }, end: { x: 90, y: 50 } });
    expect(qa("linearGradient")).toHaveLength(1);
    expect(q("[data-vector-gradient-bar]").getAttribute("x2")).toBe("90");
  });

  it("gradient editor edits type, stops, midpoints, colour space, spread, stroke mode and reverse", async () => {
    const c = make();
    c.select(["a"]);
    await act(async () => root.render(<VectorStylePanel controller={c} />));
    expect(q('[data-vector-gradient-editor="fill"]')).toBeTruthy();
    expect(q("[data-vector-gradient-ramp]")).toBeNull();
    await setValue(q<HTMLSelectElement>('select[aria-label="Gradient type"]'), "radial");
    expect(fillOf(c)).toMatchObject({ type: "radial", stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#ffffff" }] });
    // Click the ramp: a stop at the middle (jsdom has no layout), selected.
    click(q('[aria-label="Add gradient stop"]'));
    expect(fillOf(c).stops.map((s: any) => s.offset)).toEqual([0, 0.5, 1]);
    expect(q('[data-vector-gradient-stop="1"]').getAttribute("aria-pressed")).toBe("true");
    await setValue(q<HTMLInputElement>('input[aria-label="Stop colour"]'), "#00ff00");
    expect(fillOf(c).stops[1].color).toBe("#00ff00");
    await setValue(q<HTMLInputElement>('input[aria-label="Stop midpoint"]'), "30");
    expect(fillOf(c).stops[1].midpoint).toBeCloseTo(0.3);
    await setValue(q<HTMLInputElement>('input[aria-label="Stop opacity"]'), "50");
    expect(fillOf(c).stops[1].opacity).toBeCloseTo(0.5);
    await setValue(q<HTMLInputElement>('input[aria-label="Stop position"]'), "25");
    expect(fillOf(c).stops[1].offset).toBeCloseTo(0.25);
    await setValue(q<HTMLSelectElement>('select[aria-label="Gradient interpolation"]'), "oklab");
    await setValue(q<HTMLSelectElement>('select[aria-label="Gradient spread"]'), "reflect");
    expect(fillOf(c)).toMatchObject({ interpolation: "oklab", spread: "reflect" });
    click(q('button[aria-label="Reverse gradient"]'));
    expect(fillOf(c).stops[0].color).toBe("#ffffff");
    click(q('button[aria-label="Delete stop"]'));
    expect(fillOf(c).stops).toHaveLength(2);
    // The stroke: a gradient along it.
    click(qa("[data-vector-gradient-editor] button").find((b) => b.textContent === "Stroke")!);
    expect(q('[data-vector-gradient-editor="stroke"]')).toBeTruthy();
    await setValue(q<HTMLSelectElement>('select[aria-label="Gradient type"]'), "linear");
    await setValue(q<HTMLSelectElement>('select[aria-label="Gradient on stroke"]'), "along");
    expect((c.getNode("a") as VectorPathNode).stroke).toMatchObject({ type: "linear", strokeMode: "along" });
    await setValue(q<HTMLSelectElement>('select[aria-label="Gradient type"]'), "solid");
    expect((c.getNode("a") as VectorPathNode).stroke).toBe("#000000");
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

  it("keeps the History buttons in step under StrictMode", async () => {
    let controller!: VectorEditorController;
    function Host() {
      controller = useVectorEditorController({ document: doc() });
      return <VectorToolbar controller={controller} />;
    }
    await act(async () =>
      root.render(
        <React.StrictMode>
          <Host />
        </React.StrictMode>,
      ),
    );
    const undo = () => q<HTMLButtonElement>('[role="group"][aria-label="History"] button[aria-label^="Undo"]');
    const redo = () => q<HTMLButtonElement>('[role="group"][aria-label="History"] button[aria-label^="Redo"]');
    expect(undo().disabled).toBe(true);
    expect(redo().disabled).toBe(true);
    await act(async () => void controller.addShape({ kind: "rect", x: 0, y: 0, width: 5, height: 5 }));
    expect(undo().disabled).toBe(false);
    expect(undo().getAttribute("aria-label")).toBe(`Undo ${controller.getState().undoLabel}`);
    expect(redo().disabled).toBe(true);
    click(undo());
    expect(controller.getState().canRedo).toBe(true);
    expect(undo().disabled).toBe(true);
    expect(undo().getAttribute("aria-label")).toBe("Undo");
    expect(redo().disabled).toBe(false);
    expect(redo().getAttribute("aria-label")).toBe(`Redo ${controller.getState().redoLabel}`);
  });
});

describe("distort and envelopes (React)", () => {
  const envelopeOf = (c: VectorEditorController, id = "a") => (c.getNode(id)!.effects ?? []).find((e) => e.type === "envelope") as any;

  it("makes, edits, releases and expands an envelope from the panel", async () => {
    const c = make();
    c.select(["a"]);
    await act(async () => root.render(<VectorStylePanel controller={c} />));
    expect(q("[data-vector-envelope]")).toBeTruthy();
    expect(q<HTMLButtonElement>('button[aria-label="Release Envelope"]').disabled).toBe(true);
    expect(q<HTMLButtonElement>('button[aria-label="Make with Top Object"]').disabled).toBe(true);
    click(q('button[aria-label="Make with Warp"]'));
    expect(envelopeOf(c).params).toMatchObject({ style: "arc", bend: 50 });
    expect(q<HTMLButtonElement>('button[aria-label="Make with Warp"]').disabled).toBe(true);
    await setValue(q<HTMLSelectElement>('select[aria-label="Envelope warp"]'), "flag");
    expect(envelopeOf(c).params.style).toBe("flag");
    // A slider drag is one undo step.
    const slider = q<HTMLInputElement>('input[aria-label="Envelope Bend % slider"]');
    for (const v of ["20", "30", "-40"]) await setValue(slider, v);
    act(() => slider.dispatchEvent(new Event("pointerup", { bubbles: true })));
    expect(envelopeOf(c).params.bend).toBe(-40);
    expect(q<HTMLInputElement>('input[aria-label="Envelope Bend %"]').value).toBe("-40");
    act(() => void c.undo());
    expect(envelopeOf(c).params.bend).toBe(50);
    act(() => void c.redo());
    await setValue(q<HTMLInputElement>('input[aria-label="Envelope Horizontal distortion %"]'), "25");
    expect(envelopeOf(c).params.horizontal).toBe(25);
    await setValue(q<HTMLSelectElement>('select[aria-label="Envelope orientation"]'), "vertical");
    expect(envelopeOf(c).params.orientation).toBe("vertical");
    await setValue(q<HTMLInputElement>('input[aria-label="Envelope mesh rows"]'), "3");
    expect(envelopeOf(c).params.rows).toBe(3);
    // Switching to Mesh makes the preset an editable mesh of that size; the sliders go.
    await setValue(q<HTMLSelectElement>('select[aria-label="Envelope warp"]'), "mesh");
    expect(envelopeOf(c).params.mesh.vs).toHaveLength(4);
    expect(q('input[aria-label="Envelope Bend % slider"]')).toBeNull();
    click(q('button[aria-label="Expand Envelope"]'));
    expect(envelopeOf(c)).toBeUndefined();
    expect(c.getState().undoLabel).toBe("Expand Appearance");
    act(() => void c.undo());
    click(q('button[aria-label="Release Envelope"]'));
    expect(envelopeOf(c)).toBeUndefined();
    expect(c.getDocument().nodes).toHaveLength(2);
  });

  it("makes an envelope with a mesh of the chosen size, and with the top object", async () => {
    const c = make();
    c.addShape({ kind: "ellipse", x: -20, y: -20, width: 140, height: 140 });
    c.select(["a", c.getDocument().nodes[1].id]);
    await act(async () => root.render(<VectorStylePanel controller={c} />));
    expect(q<HTMLButtonElement>('button[aria-label="Make with Top Object"]').disabled).toBe(false);
    click(q('button[aria-label="Make with Top Object"]'));
    expect(c.getDocument().nodes).toHaveLength(1);
    expect(envelopeOf(c).params.style).toBe("mesh");
    act(() => void c.undo());
    act(() => c.select(["a"]));
    await setValue(q<HTMLInputElement>('input[aria-label="Envelope mesh columns"]'), "3");
    click(q('button[aria-label="Make with Mesh"]'));
    expect(envelopeOf(c).params).toMatchObject({ style: "mesh", columns: 3, rows: 2 });
  });

  it("draws the envelope mesh with the Envelope tool and drags its anchors", async () => {
    const c = make();
    c.select(["a"]);
    c.envelope({ style: "mesh", rows: 2, columns: 2 });
    c.setTool("envelope");
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    expect(q("[data-vector-envelope-mesh]").getAttribute("data-vector-envelope-mesh")).toBe("a");
    expect(q("[data-vector-envelope-grid]").getAttribute("d")).toContain("C");
    expect(qa("[data-vector-envelope-anchor]")).toHaveLength(9);
    expect(qa("[data-vector-envelope-handle]")).toHaveLength(24);
    const svg = q("svg");
    pointer(svg, "pointerdown", 50, 50);
    pointer(svg, "pointermove", 60, 40);
    pointer(svg, "pointerup", 60, 40);
    expect(envelopeOf(c).params.mesh.points[3 * 7 + 3]).toEqual({ x: 60, y: 40 });
    expect(q('[data-vector-envelope-anchor="24"]').getAttribute("x")).toBe(String(60 - 3.5));
    expect(c.getState().undoLabel).toBe("Edit Envelope");
    act(() => void c.setTool("select"));
    expect(q("[data-vector-envelope-mesh]")).toBeNull();
  });

  it("toggles Free Distort from the toolbar and drags a corner in perspective on the canvas", async () => {
    const c = make();
    c.select(["a"]);
    await act(async () =>
      root.render(
        <>
          <VectorToolbar controller={c} />
          <VectorCanvas controller={c} fitOnMount={false} />
        </>,
      ),
    );
    const toggle = q("[data-vector-free-distort]");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    click(toggle);
    expect(c.getState().freeDistort).toBe(true);
    expect(q("[data-vector-selection]").getAttribute("data-free-distort")).toBe("true");
    const svg = q("svg[role=application]");
    pointer(svg, "pointerdown", 100, 100);
    pointer(svg, "pointermove", 120, 130);
    expect(q("[data-vector-distort]").getAttribute("data-vector-distort")).toBe("distort");
    expect(q("[data-vector-selection]")).toBeNull();
    pointer(svg, "pointerup", 120, 130);
    expect(q("[data-vector-distort]")).toBeNull();
    const a = (c.getNode("a") as VectorPathNode).subpaths[0].anchors;
    expect(a[2].x).toBeCloseTo(120, 9);
    expect(a[2].y).toBeCloseTo(130, 9);
    expect(a[0]).toMatchObject({ x: 0, y: 0 });
    expect(c.getState().undoLabel).toBe("Distort");
  });
});

describe("appearance stacks (react)", () => {
  const stackedDoc = (): VectorDocument => ({
    width: 400,
    height: 300,
    nodes: [
      {
        id: "a",
        type: "path",
        subpaths: [rectSubpath({ x: 0, y: 0, width: 100, height: 100 })],
        fill: "#00ff00",
        fills: [{ paint: "#ff0000" }, { paint: "#00ff00", opacity: 0.5, blendMode: "multiply" }],
        stroke: "#000000",
        strokeWidth: 2,
        strokes: [{ paint: "#0000ff", strokeWidth: 8, strokeAlign: "outside" }, { paint: "#000000", strokeWidth: 2 }],
        blendMode: "screen",
        filters: [{ id: "f1", type: "dropShadow", params: { color: "#000000", opacity: 0.25, offsetX: 0, offsetY: 4, blur: 4, spread: 0 } }],
      } as VectorPathNode,
    ],
  });

  it("draws each layer, the blend modes and the filter", async () => {
    const c = new VectorEditorController({ document: stackedDoc() });
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const g = q('g[data-vector-id="a"]');
    const filterId = /^url\(#(.+-filter-a)\)$/.exec(g.getAttribute("filter") ?? "")![1];
    expect(g.style.mixBlendMode).toBe("screen");
    expect(qa('g[data-vector-id="a"] > [data-vector-layer]').map((el) => el.getAttribute("data-vector-layer"))).toEqual(["fill-0", "fill-1", "stroke-0", "stroke-1"]);
    const fill1 = q('[data-vector-layer="fill-1"]');
    expect(fill1.getAttribute("opacity")).toBe("0.5");
    expect((fill1 as HTMLElement).style.mixBlendMode).toBe("multiply");
    expect(q('[data-vector-layer="stroke-0"]').getAttribute("data-vector-stroke-align")).toBe("outside");
    expect(container.querySelector(`filter[id="${filterId}"]`)?.querySelector("feGaussianBlur, fegaussianblur")).toBeTruthy();
  });

  it("edits the stacks, blend mode and filters from the style panel", async () => {
    const c = new VectorEditorController({ document: stackedDoc() });
    c.select(["a"]);
    await act(async () => root.render(<VectorStylePanel controller={c} />));
    const path = () => c.getNode("a") as VectorPathNode;
    // Top layer first.
    expect(qa('[data-vector-stack="fill"] [data-vector-layer]').map((el) => el.getAttribute("data-vector-layer"))).toEqual(["fill-1", "fill-0"]);
    await act(async () => q<HTMLButtonElement>('button[aria-label="Add fill"]').click());
    expect(path().fills).toHaveLength(3);
    await act(async () => q<HTMLButtonElement>('button[aria-label="Move Fill 1 up"]').click());
    expect(path().fills!.map((l) => l.paint)).toEqual(["#00ff00", "#ff0000", "#808080"]);
    await act(async () => q<HTMLButtonElement>('button[aria-label="Remove Fill 3"]').click());
    expect(path().fills).toHaveLength(2);
    const hide = q<HTMLInputElement>('input[aria-label="Stroke 1 visible"]');
    await act(async () => hide.click());
    expect(path().strokes![0].visible).toBe(false);
    const blend = q<HTMLSelectElement>('select[aria-label="Blend mode"]');
    await act(async () => {
      blend.value = "difference";
      blend.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(path().blendMode).toBe("difference");
    const add = q<HTMLSelectElement>('select[aria-label="Add filter"]');
    await act(async () => {
      add.value = "layerBlur";
      add.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(path().filters!.map((f) => f.type)).toEqual(["dropShadow", "layerBlur"]);
    await act(async () => q<HTMLButtonElement>('button[aria-label="Remove Drop Shadow"]').click());
    expect(path().filters!.map((f) => f.type)).toEqual(["layerBlur"]);
    await act(async () => q<HTMLButtonElement>('button[aria-label="Edit Stroke 1 gradient"]').click());
    expect(c.getState().gradientEdit).toMatchObject({ target: "stroke", layer: 0 });
  });
});

describe("masks (react)", () => {
  const maskDoc = (): VectorDocument => ({
    width: 400,
    height: 300,
    nodes: [
      { id: "a", type: "path", fill: "#ff0000", stroke: null, subpaths: [rectSubpath({ x: 0, y: 0, width: 100, height: 100 })] },
      { id: "m", type: "path", fill: "#ffffff", stroke: null, subpaths: [rectSubpath({ x: 20, y: 20, width: 40, height: 40 })] },
      { id: "b", type: "path", fill: "#0000ff", stroke: null, subpaths: [rectSubpath({ x: 200, y: 0, width: 50, height: 50 })] },
    ],
  });

  it("draws a clip group's contents under a clipPath, with the group's filter outside it, and the mask indicator", async () => {
    const c = new VectorEditorController({ document: maskDoc(), createId: () => "g" });
    c.makeMask("clip", { ids: ["a", "m"] });
    c.addFilter("dropShadow", { ids: ["g"] });
    c.select(["g"]);
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const g = q('[data-vector-scene] g[data-vector-id="g"]');
    expect(g.getAttribute("data-vector-mask")).toBe("clip");
    expect(g.getAttribute("filter")).toMatch(/filter-g\)$/);
    const inner = g.querySelector("g[data-vector-masked]")!;
    const clipId = /^url\(#(.+)\)$/.exec(inner.getAttribute("clip-path")!)![1];
    expect(container.querySelector(`clipPath[id="${clipId}"] path`)).toBeTruthy();
    // The clip's own paint is not drawn: only the contents are.
    expect(Array.from(inner.querySelectorAll("[data-vector-id]")).map((el) => el.getAttribute("data-vector-id"))).toEqual(["a"]);
    expect(q('[data-vector-overlay] [data-vector-mask-indicator="g"]').getAttribute("stroke-dasharray")).toBeTruthy();
  });

  it("writes filter presentation attributes the way React accepts them", async () => {
    const c = new VectorEditorController({ document: maskDoc(), createId: () => "g" });
    c.makeMask("luminance", { ids: ["a", "m"], invert: true });
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    } finally {
      console.error = original;
    }
    expect(errors.filter((e) => String(e.join(" ")).includes("flood"))).toEqual([]);
    expect(container.querySelector("feFlood, feflood")!.getAttribute("flood-color")).toBe("#000000");
  });

  it("draws an inverted opacity mask through its filter", async () => {
    const c = new VectorEditorController({ document: maskDoc(), createId: () => "g" });
    c.makeMask("alpha", { ids: ["a", "m"], invert: true });
    await act(async () => root.render(<VectorCanvas controller={c} fitOnMount={false} />));
    const inner = q('g[data-vector-id="g"] g[data-vector-masked]');
    const maskId = /^url\(#(.+)\)$/.exec(inner.getAttribute("mask")!)![1];
    const mask = container.querySelector(`mask[id="${maskId}"]`) as SVGElement;
    expect(mask.getAttribute("maskUnits")).toBe("userSpaceOnUse");
    expect((mask as unknown as HTMLElement).style.maskType).toBe("alpha");
    const filterId = /^url\(#(.+)\)$/.exec(mask.querySelector("g[filter]")!.getAttribute("filter")!)![1];
    expect(container.querySelector(`filter[id="${filterId}"] feColorMatrix, filter[id="${filterId}"] fecolormatrix`)).toBeTruthy();
    expect(mask.querySelector('[data-vector-id="m"]')).toBeTruthy();
  });

  it("makes, edits and releases masks from the panel and the toolbar", async () => {
    const c = new VectorEditorController({ document: maskDoc(), createId: () => "g" });
    c.select(["a", "m"]);
    await act(async () => root.render(<><VectorToolbar controller={c} /><VectorStylePanel controller={c} /></>));
    await act(async () => q<HTMLButtonElement>('[data-vector-mask-panel] button[aria-label="Make Clipping Mask"]').click());
    const group = () => c.getNode("g") as any;
    expect(group().mask).toEqual({ type: "clip" });
    const type = q<HTMLSelectElement>('select[aria-label="Mask type"]');
    await act(async () => {
      type.value = "luminance";
      type.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(group().mask).toEqual({ type: "luminance" });
    await act(async () => q<HTMLInputElement>('input[aria-label="Invert mask"]').click());
    expect(group().mask).toEqual({ type: "luminance", invert: true });
    await act(async () => q<HTMLButtonElement>('button[aria-label="Mask on"]').click());
    expect(c.getNode("m")!.visible).toBe(false);
    await act(async () => q<HTMLButtonElement>('button[aria-label="Edit Contents"]').click());
    expect(c.getState().selection).toEqual(["a"]);
    await act(async () => q<HTMLButtonElement>('button[aria-label="Edit Mask"]').click());
    expect(c.getState().selection).toEqual(["m"]);
    expect(q('button[aria-label="Edit Mask"]').getAttribute("aria-pressed")).toBe("true");
    await act(async () => c.select(["g"]));
    await act(async () => q<HTMLButtonElement>('[role="toolbar"] button[aria-label^="Release Mask"]').click());
    expect(c.getNode("g")).toBeUndefined();
    expect(c.getState().document.nodes.map((n) => n.id)).toEqual(["a", "m", "b"]);
  });
});

describe("text (react)", () => {
  it("types into new text through the hidden textarea, draws it as SVG text, and styles it from the panel", async () => {
    const c = new VectorEditorController({ document: { width: 400, height: 300, nodes: [] }, createId: () => `t${++n}` });
    c.setTool("type");
    await act(async () => root.render(<><VectorCanvas controller={c} fitOnMount={false} /><VectorStylePanel controller={c} /></>));
    const svg = q("svg");
    pointer(svg, "pointerdown", 40, 60);
    pointer(svg, "pointerup", 40, 60);
    const input = q<HTMLTextAreaElement>('[data-testid="vector-type-input"]');
    expect(input).not.toBeNull();
    await act(async () => {
      input.value = "Hi";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const id = c.getState().textEdit!.nodeId;
    expect((c.getNode(id) as any).text).toBe("Hi");
    expect(q('[data-vector-text-caret]')).not.toBeNull();
    // Editing keys go to the controller from the textarea; letters do not trigger tools.
    key(input, "Backspace");
    expect((c.getNode(id) as any).text).toBe("H");
    expect(key(input, "v").defaultPrevented).toBe(false);
    expect(c.getState().tool).toBe("type");
    await act(async () => {
      input.value = "ey";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(q(`[data-vector-scene] [data-vector-id="${id}"] tspan`)?.textContent).toBe("Hey");
    key(input, "Escape");
    expect(c.getState().textEdit).toBeNull();
    expect(q('[data-testid="vector-type-input"]')).toBeNull();
    // Selected text: the panel styles the whole node, one undo step.
    await act(async () => q<HTMLButtonElement>('[data-vector-text-panel] button[aria-label="Bold"]').click());
    expect((c.getNode(id) as any).font.fontWeight).toBe(700);
    await act(async () => q<HTMLButtonElement>('[data-vector-text-panel] button[aria-label="Align Centre"]').click());
    expect((c.getNode(id) as any).paragraph).toEqual({ align: "center" });
    c.undo();
    expect((c.getNode(id) as any).paragraph).toBeUndefined();
  });
});

describe("symbols (react)", () => {
  it("makes a symbol from the panel, draws instances, edits the symbol in isolation and detaches", async () => {
    const c = make();
    c.select(["a"]);
    await act(async () => root.render(<><VectorCanvas controller={c} fitOnMount={false} /><VectorStylePanel controller={c} /></>));
    await act(async () => q<HTMLButtonElement>('[data-vector-symbols-panel] [data-vector-symbol-action="make"]').click());
    const sym = c.getSymbols()[0];
    expect(qa("[data-vector-symbols-panel] [data-vector-symbol]")).toHaveLength(1);
    expect(q(`[data-vector-symbol="${sym.id}"] svg path`)).not.toBeNull();
    await act(async () => q<HTMLButtonElement>(`[data-vector-symbols-panel] button[aria-label="Place ${sym.name}"]`).click());
    expect(c.getSymbolInstances(sym.id)).toHaveLength(2);
    const instanceId = c.getState().selection[0];
    expect(q(`[data-vector-scene] [data-vector-id="${instanceId}"] path`)).not.toBeNull();
    // Isolation mode: the art alone in the scene, the rest dimmed behind, a way out.
    await act(async () => q<HTMLButtonElement>(`button[aria-label="Edit ${sym.name}"]`).click());
    expect(c.getState().symbolEdit?.symbolId).toBe(sym.id);
    expect(q("[data-vector-symbol-edit]")).not.toBeNull();
    await act(async () => q<HTMLButtonElement>('button[aria-label="Exit symbol"]').click());
    expect(c.getState().symbolEdit).toBeNull();
    await act(async () => c.select([instanceId]));
    await act(async () => q<HTMLInputElement>('input[aria-label="Scale strokes"]').click());
    expect((c.getNode(instanceId) as any).scaleStrokes).toBe(false);
    await act(async () => qa("[data-vector-instance] button").find((b) => b.textContent === "Detach")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(c.getNode(instanceId)?.type).toBe("group");
  });
});
