import { describe, it, expect, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { CommandRegistry } from "@pixerate/editor/commands";
import { VectorEditorController, rectSubpath, vectorNodeBounds, type VectorDocument, type VectorPathNode } from "@pixerate/editor/vector";
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

  it("draws smart guides while a drag snaps, and clears them on release", () => {
    const c = make();
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const svg = t.querySelector("svg")!;
    pointer(svg, "pointerdown", 50, 50);
    pointer(svg, "pointermove", 147, 72);
    // The right edge (197) lines up with the artboard's centre line.
    expect(vectorNodeBounds(c.getNode("a")!)).toMatchObject({ x: 100, y: 22 });
    const lines = Array.from(t.querySelectorAll("[data-vector-guides] [data-vector-guide]"));
    expect(lines).toHaveLength(1);
    expect(lines[0].getAttribute("data-vector-guide")).toBe("align");
    expect([lines[0].getAttribute("x1"), lines[0].getAttribute("x2")]).toEqual(["200", "200"]);
    expect(Array.from(t.querySelectorAll("[data-vector-guide-label]")).map((l) => l.textContent)).toEqual(["align"]);
    pointer(svg, "pointerup", 147, 72);
    expect(t.querySelectorAll("[data-vector-guide]")).toHaveLength(0);
    expect(t.querySelectorAll("[data-vector-guide-label]")).toHaveLength(0);
  });

  it("labels the anchor the pen tool will land on", () => {
    const c = make();
    c.setTool("pen");
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    pointer(t.querySelector("svg")!, "pointermove", 98, 102);
    expect(c.getState().pointer).toEqual({ x: 100, y: 100 });
    const label = t.querySelector("[data-vector-guide-label]")!;
    expect(label.getAttribute("data-vector-guide-label")).toBe("anchor");
    expect(label.textContent).toBe("anchor");
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

  it("renders rotated nodes with a rotated selection box", () => {
    const c = make();
    c.select(["a"]);
    c.rotate(30);
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    expect(t.querySelector('[data-vector-scene] path[data-vector-id="a"]')!.getAttribute("transform")).toMatch(/^matrix\(0\.866025 0\.5 -0\.5 0\.866025 /);
    expect(t.querySelector("[data-vector-selection]")!.getAttribute("transform")).toBe("rotate(30 0 0)");
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
  it("toggles snapping", () => {
    const c = make();
    const t = render(VectorToolbar, { controller: c });
    const snap = t.querySelector("[data-vector-snap]") as HTMLButtonElement;
    expect(snap.getAttribute("aria-pressed")).toBe("true");
    expect(snap.title).toMatch(/to bypass/);
    click(snap);
    expect(c.getState().snap.objects).toBe(false);
    expect(snap.getAttribute("aria-pressed")).toBe("false");
    click(snap);
    expect(c.getState().snap.objects).toBe(true);
  });

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

const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  flushSync();
};

describe("live corners, stroke alignment and arrowheads (svelte)", () => {
  it("draws aligned strokes in parts, clipped or masked, and arrowheads", () => {
    const c = make();
    c.setStyle({ stroke: "#000", strokeWidth: 4, strokeAlign: "inside" }, ["a"]);
    const line = c.addPath("M0 200 L100 200", { stroke: "#00f", endArrow: "triangle" });
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const g = t.querySelector('[data-vector-scene] g[data-vector-id="a"]')!;
    expect(g.getAttribute("data-vector-stroke-align")).toBe("inside");
    const stroke = g.querySelector('[data-vector-part="stroke"]')!;
    expect(stroke.getAttribute("stroke-width")).toBe("8");
    const clipId = stroke.getAttribute("clip-path")!.match(/url\(#(.+)\)/)![1];
    expect(g.querySelector(`clipPath[id="${clipId}"] path`)!.getAttribute("d")).toBe("M0 0L100 0L100 100L0 100Z");
    expect(g.querySelector('[data-vector-part="fill"]')!.getAttribute("fill")).toBe("#ff0000");
    c.setStyle({ strokeAlign: "outside" }, ["a"]);
    flushSync();
    expect(t.querySelector('[data-vector-id="a"] mask rect')!.getAttribute("fill")).toBe("#fff");
    expect(t.querySelector('[data-vector-id="a"] [data-vector-part="stroke"]')!.getAttribute("mask")).toMatch(/^url\(#/);
    const heads = t.querySelectorAll(`[data-vector-id="${line}"] [data-vector-part="head"]`);
    expect(heads).toHaveLength(1);
    expect(heads[0].getAttribute("fill")).toBe("#00f");
  });

  it("drags a live corner widget with the direct tool", () => {
    const c = make();
    c.setTool("direct");
    c.select(["a"]);
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    expect(t.querySelectorAll("[data-vector-corner-widget]")).toHaveLength(4);
    const svg = t.querySelector("svg")!;
    pointer(svg, "pointerdown", 10, 10);
    pointer(svg, "pointermove", 20, 20);
    expect(t.querySelector("[data-vector-status]")!.textContent).toBe("R 10");
    pointer(svg, "pointerup", 20, 20);
    expect((c.getNode("a") as any).subpaths[0].anchors.map((a: any) => a.corner?.radius)).toEqual([10, 10, 10, 10]);
    expect(t.querySelector('[data-vector-scene] path[data-vector-id="a"]')!.getAttribute("d")).toContain("C");
  });

  it("style panel edits alignment, corners and arrowheads", () => {
    const c = make();
    c.select(["a"]);
    const t = render(VectorStylePanel, { controller: c });
    const q = <T extends Element>(sel: string) => t.querySelector(sel) as T;
    setValue(q<HTMLSelectElement>('select[aria-label="Stroke alignment"]'), "outside");
    expect((c.getNode("a") as any).strokeAlign).toBe("outside");
    setValue(q<HTMLInputElement>('input[aria-label="Corner radius"]'), "12");
    expect((c.getNode("a") as any).subpaths[0].anchors.every((a: any) => a.corner?.radius === 12)).toBe(true);
    setValue(q<HTMLSelectElement>('select[aria-label="Corner kind"]'), "chamfer");
    expect((c.getNode("a") as any).subpaths[0].anchors[0].corner).toEqual({ radius: 12, kind: "chamfer" });
    // Closed shapes have no ends for arrowheads.
    expect(q('select[aria-label="End arrowhead"]')).toBeNull();
    const line = c.addPath("M0 200 L100 200", { stroke: "#000" });
    c.select([line]);
    flushSync();
    expect(q('[data-vector-style="corners"]')).toBeNull();
    setValue(q<HTMLSelectElement>('select[aria-label="End arrowhead"]'), "circle");
    expect((c.getNode(line) as any).endArrow).toBe("circle");
    setValue(q<HTMLSelectElement>('select[aria-label="Arrowhead alignment"]'), "tip");
    expect((c.getNode(line) as any).arrowAlign).toBe("tip");
    setValue(q<HTMLInputElement>('input[aria-label="End arrowhead scale"]'), "2");
    expect((c.getNode(line) as any).endArrowScale).toBe(2);
    setValue(q<HTMLSelectElement>('select[aria-label="End arrowhead"]'), "");
    expect((c.getNode(line) as any).endArrow).toBeNull();
    // Nothing selected: the defaults for new shapes.
    c.select([]);
    flushSync();
    setValue(q<HTMLInputElement>('input[aria-label="Corner radius"]'), "5");
    expect(c.getState().defaults.cornerRadius).toBe(5);
  });
});

describe("variable-width strokes (svelte)", () => {
  const penPointer = (el: Element, type: string, x: number, y: number, pressure: number) => {
    const e = new Pointer(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(e, "pressure", { value: pressure });
    Object.defineProperty(e, "pointerType", { value: "pen" });
    el.dispatchEvent(e);
    flushSync();
  };

  it("draws a profiled stroke as a filled outline", () => {
    const c = make();
    const line = c.addPath("M0 200 L200 200", { stroke: "#00f", strokeWidth: 10, strokeWidthProfile: [{ t: 0, left: 1, right: 1 }, { t: 1, left: 0, right: 0 }] });
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const outline = t.querySelector(`[data-vector-id="${line}"] [data-vector-part="stroke-outline"]`)!;
    expect(outline.getAttribute("fill")).toBe("#00f");
    expect(outline.getAttribute("d")).toMatch(/^M/);
    expect(t.querySelectorAll(`[data-vector-id="${line}"] [data-vector-part="stroke"]`)).toHaveLength(0);
  });

  it("drags a width point with the width tool and shows its handles", () => {
    const c = make();
    const line = c.addPath("M0 200 L200 200", { stroke: "#000", strokeWidth: 10 });
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const svg = t.querySelector("svg")!;
    key(svg, "w");
    expect(c.getState().tool).toBe("width");
    pointer(svg, "pointermove", 100, 202);
    expect(t.querySelectorAll("[data-vector-width-spot]")).toHaveLength(1);
    pointer(svg, "pointerdown", 100, 202);
    pointer(svg, "pointermove", 100, 220);
    expect(t.querySelector("[data-vector-status]")!.textContent).toBe("W 40");
    pointer(svg, "pointerup", 100, 220);
    expect((c.getNode(line) as any).strokeWidthProfile[1]).toEqual({ t: 0.5, left: 4, right: 4 });
    expect(t.querySelectorAll("[data-vector-width-point]")).toHaveLength(3);
    expect(t.querySelector('[data-vector-width-point][data-selected] [data-vector-width-side="right"]')!.getAttribute("cy")).toBe("220");
    key(svg, "Delete");
    expect((c.getNode(line) as any).strokeWidthProfile).toHaveLength(2);
  });

  it("Shift-selects, Alt-copies and edits width points numerically", () => {
    const c = make();
    const profile = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ t, left: 1, right: 1 }));
    const line = c.addPath("M0 200 L200 200", { stroke: "#000", strokeWidth: 10, strokeWidthProfile: profile });
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const svg = t.querySelector("svg")!;
    const q = <T extends Element = HTMLElement>(sel: string) => t.querySelector(sel) as T;
    const qa = (sel: string) => Array.from(t.querySelectorAll(sel));
    const tsOf = () => (c.getNode(line) as any).strokeWidthProfile.map((p: any) => Math.round(p.t * 1000) / 1000);
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
    expect(tsOf()).toEqual([0, 0.35, 0.5, 0.85, 1]);
    key(svg, "Delete");
    expect(tsOf()).toEqual([0, 0.5, 1]);
    // Alt-drag the centre: a copy slides.
    pointer(svg, "pointerdown", 100, 200, { altKey: true });
    pointer(svg, "pointermove", 140, 200, { altKey: true });
    pointer(svg, "pointerup", 140, 200, { altKey: true });
    expect(tsOf()).toEqual([0, 0.5, 0.7, 1]);
    // Double-click opens Width Point Edit beside the point.
    svg.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 140, clientY: 200 }));
    flushSync();
    const pos = q<HTMLInputElement>('input[aria-label="Width point position"]');
    expect(pos.value).toBe("70");
    expect(q<HTMLInputElement>('input[aria-label="Width point left side"]').value).toBe("5");
    expect(q("[data-vector-width-point-edit]").getAttribute("x")).toBe("152");
    // Keys typed in it don't reach the canvas.
    expect(key(pos, "Delete").defaultPrevented).toBe(false);
    expect(tsOf()).toEqual([0, 0.5, 0.7, 1]);
    setValue(pos, "60");
    setValue(q<HTMLInputElement>('input[aria-label="Width point left side"]'), "15");
    click(q('[data-vector-width-point-editor] button[type="submit"]'));
    expect((c.getNode(line) as any).strokeWidthProfile[2]).toEqual({ t: 0.6, left: 3, right: 1 });
    expect(qa("[data-vector-width-point-editor]")).toHaveLength(0);
    // Escape closes it without changes.
    svg.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 120, clientY: 200 }));
    flushSync();
    const left = q<HTMLInputElement>('input[aria-label="Width point left side"]');
    setValue(left, "40");
    key(left, "Escape");
    expect(qa("[data-vector-width-point-editor]")).toHaveLength(0);
    expect((c.getNode(line) as any).strokeWidthProfile[2]).toEqual({ t: 0.6, left: 3, right: 1 });
    expect(c.getState().tool).toBe("width");
  });

  it("records pen pressure on pencil strokes", () => {
    const c = make();
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const svg = t.querySelector("svg")!;
    key(svg, "n");
    penPointer(svg, "pointerdown", 200, 200, 0.2);
    for (let i = 1; i <= 20; i++) penPointer(svg, "pointermove", 200 + i * 5, 200, 0.2 + i * 0.04);
    penPointer(svg, "pointerup", 300, 200, 0);
    const node = c.getNode(c.getState().selection[0]) as any;
    expect(node.strokeWidthProfile.length).toBeGreaterThan(1);
    expect(node.strokeWidthProfile[0].left).toBeLessThan(node.strokeWidthProfile[node.strokeWidthProfile.length - 1].left);
  });

  it("style panel picks a width profile and resets it", () => {
    const c = make();
    const line = c.addPath("M0 200 L100 200", { stroke: "#000" });
    c.select([line]);
    const t = render(VectorStylePanel, { controller: c });
    const reset = () => t.querySelector<HTMLButtonElement>('button[aria-label="Reset to uniform width"]')!;
    expect(reset().disabled).toBe(true);
    setValue(t.querySelector<HTMLSelectElement>('select[aria-label="Width profile"]')!, "taperEnd");
    expect((c.getNode(line) as any).strokeWidthProfile).toEqual([{ t: 0, left: 1, right: 1 }, { t: 1, left: 0, right: 0 }]);
    expect(t.querySelector<HTMLSelectElement>('select[aria-label="Width profile"]')!.value).toBe("taperEnd");
    click(reset());
    expect("strokeWidthProfile" in (c.getNode(line) as any)).toBe(false);
    c.select([]);
    flushSync();
    setValue(t.querySelector<HTMLSelectElement>('select[aria-label="Width profile"]')!, "bulge");
    expect(c.getState().defaults.strokeWidthProfile).toHaveLength(3);
  });
});

describe("Pathfinder, Shape Builder and paint bucket (svelte)", () => {
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

  it("highlights the hovered and dragged faces and merges them on release", () => {
    const c = two();
    c.select(["a", "b"]);
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const svg = t.querySelector("svg")!;
    key(svg, "m");
    expect(c.getState().tool).toBe("shapeBuilder");
    pointer(svg, "pointermove", 75, 75);
    expect(t.querySelector("[data-vector-builder]")!.getAttribute("data-vector-builder")).toBe("merge");
    expect(t.querySelectorAll("[data-vector-builder-face]")).toHaveLength(1);
    pointer(svg, "pointerdown", 20, 20);
    pointer(svg, "pointermove", 75, 75);
    expect(t.querySelectorAll("[data-vector-builder-face]")).toHaveLength(2);
    expect(t.querySelectorAll("[data-vector-builder-trail]")).toHaveLength(1);
    pointer(svg, "pointerup", 75, 75);
    expect(t.querySelectorAll("[data-vector-builder-face]")).toHaveLength(0);
    expect(c.getState().undoLabel).toBe("Shape Builder");
    pointer(svg, "pointermove", 120, 120, { altKey: true });
    expect(t.querySelector("[data-vector-builder]")!.getAttribute("data-vector-builder")).toBe("erase");
  });

  it("hatches hovered faces and erases an outline edge with Alt", () => {
    const c = two();
    c.select(["a", "b"]);
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const svg = t.querySelector("svg")!;
    key(svg, "m");
    pointer(svg, "pointermove", 75, 75);
    expect(t.querySelectorAll("[data-vector-builder-hatch]")).toHaveLength(1);
    expect(t.querySelector("[data-vector-builder-hatch]")!.getAttribute("d")).toMatch(/^M/);
    // a's corner inside b: the edge, not the face.
    pointer(svg, "pointermove", 101, 75, { altKey: true });
    expect(t.querySelectorAll("[data-vector-builder-face]")).toHaveLength(0);
    expect(t.querySelectorAll("[data-vector-builder-hatch]")).toHaveLength(0);
    expect(t.querySelectorAll("[data-vector-builder-line]")).toHaveLength(1);
    pointer(svg, "pointerdown", 101, 75, { altKey: true });
    pointer(svg, "pointerup", 101, 75, { altKey: true });
    const a = c.getNode("a") as VectorPathNode;
    expect(a.subpaths[0].closed).toBe(false);
    expect(c.getState().undoLabel).toBe("Shape Builder Delete");
  });

  it("previews the paint bucket region", () => {
    const c = make();
    c.updateNode("a", { fill: null, stroke: "#000000" });
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const svg = t.querySelector("svg")!;
    key(svg, "b");
    pointer(svg, "pointermove", 50, 50);
    expect(t.querySelector("[data-vector-builder]")!.getAttribute("data-vector-builder")).toBe("fill");
    expect(t.querySelectorAll("[data-vector-builder-face]")).toHaveLength(1);
    expect(t.querySelectorAll("[data-vector-builder-hatch]")).toHaveLength(0);
    pointer(svg, "pointerdown", 50, 50);
    pointer(svg, "pointerup", 50, 50);
    expect(c.getState().document.nodes).toHaveLength(2);
  });

  it("toolbar runs Pathfinder operations and toggles gap closing", () => {
    const c = two();
    const t = render(VectorToolbar, { controller: c });
    const divide = t.querySelector('[data-vector-pathfinder="divide"]') as HTMLButtonElement;
    expect(divide.disabled).toBe(true);
    expect(t.querySelectorAll("[data-vector-pathfinder]")).toHaveLength(6);
    c.select(["a", "b"]);
    flushSync();
    click(t.querySelector('[data-vector-pathfinder="trim"]'));
    expect(c.getState().undoLabel).toBe("Trim");
    expect(t.querySelectorAll("[data-vector-fill-gap]")).toHaveLength(0);
    click(t.querySelector('[data-vector-tool="paintBucket"]'));
    const gap = t.querySelector("[data-vector-fill-gap]")!;
    expect(gap.getAttribute("aria-pressed")).toBe("false");
    click(gap);
    expect(c.getState().editing.fillGap).toBeGreaterThan(0);
  });
});

describe("path editing (svelte)", () => {
  it("bends a segment, previews knife strokes and shows the scissors cut point", () => {
    const c = make();
    c.setTool("direct");
    c.select(["a"]);
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const svg = t.querySelector("svg")!;
    pointer(svg, "pointerdown", 50, 0);
    pointer(svg, "pointermove", 50, -20);
    pointer(svg, "pointerup", 50, -40);
    expect(c.getState().undoLabel).toBe("Bend Segment");
    expect(t.querySelector("[data-vector-scene] path")!.getAttribute("d")).toMatch(/^M0 0C/);
    key(svg, "k");
    pointer(svg, "pointerdown", -10, 150);
    pointer(svg, "pointermove", 60, 150);
    expect(t.querySelector("[data-vector-tool-stroke]")!.getAttribute("data-vector-tool-stroke")).toBe("knife");
    pointer(svg, "pointerup", 60, 150);
    expect(t.querySelectorAll("[data-vector-tool-stroke]")).toHaveLength(0);
    key(svg, "c");
    pointer(svg, "pointermove", 100, 50);
    expect(t.querySelector("[data-vector-cut-point]")!.getAttribute("cx")).toBe("100");
  });

  it("shows the eraser swath and the pencil's lazy-mouse string", () => {
    const c = make();
    c.setEditing({ pencilSmoothing: 0.3 });
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const svg = t.querySelector("svg")!;
    key(svg, "e");
    pointer(svg, "pointerdown", 50, -20);
    pointer(svg, "pointermove", 50, 120);
    expect(t.querySelector("[data-vector-tool-stroke]")!.getAttribute("stroke-width")).toBe("10");
    pointer(svg, "pointerup", 50, 120);
    expect(c.getState().document.nodes).toHaveLength(2);
    key(svg, "n");
    pointer(svg, "pointerdown", 200, 200);
    pointer(svg, "pointermove", 210, 200);
    expect(t.querySelectorAll("[data-vector-pencil-string]")).toHaveLength(1);
    pointer(svg, "pointerup", 260, 200);
  });

  it("toolbar runs Join and Smooth, toggles settings and shows tool inputs", () => {
    const c = make();
    c.addPath("M200 0 L300 0", { stroke: "#000" });
    const t = render(VectorToolbar, { controller: c });
    const join = t.querySelector('[data-vector-path-action="join"]') as HTMLButtonElement;
    expect(join.title).toMatch(/Join \((⌘|Ctrl)\+J\)/);
    click(join);
    expect((c.getNode(c.getState().selection[0]) as any).subpaths[0].closed).toBe(true);
    expect((t.querySelector('[data-vector-path-action="average"]') as HTMLButtonElement).disabled).toBe(true);
    const curv = t.querySelector('[data-vector-edit="curvatureMoves"]')!;
    expect(curv.getAttribute("aria-pressed")).toBe("false");
    click(curv);
    expect(c.getState().editing.curvatureMoves).toBe(true);
    expect(curv.getAttribute("aria-pressed")).toBe("true");
    expect(t.querySelectorAll('input[aria-label="Eraser size"]')).toHaveLength(0);
    click(t.querySelector('[data-vector-tool="eraser"]'));
    expect((t.querySelector('input[aria-label="Eraser size"]') as HTMLInputElement).value).toBe("10");
    click(t.querySelector('[data-vector-tool="pencil"]'));
    expect(t.querySelectorAll('input[aria-label="Pencil smoothing"]')).toHaveLength(1);
    expect(t.querySelectorAll('[data-vector-tool="scissors"], [data-vector-tool="knife"]')).toHaveLength(2);
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
