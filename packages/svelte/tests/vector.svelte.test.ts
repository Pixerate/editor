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

describe("path effects and live booleans (svelte)", () => {
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
      createId: () => `sfx${++n}`,
    });

  it("adds, edits, toggles, reorders, removes and expands effects", () => {
    const c = pair();
    c.select(["a"]);
    const t = render(VectorStylePanel, { controller: c });
    const q = <T extends Element = HTMLElement>(sel: string) => t.querySelector(sel) as T;
    expect(q("[data-vector-effects]")).toBeTruthy();
    expect(q<HTMLButtonElement>('button[aria-label="Expand Appearance"]').disabled).toBe(true);
    setValue(q<HTMLSelectElement>('select[aria-label="Add effect"]'), "zigzag");
    const effects = () => c.getNode("a")!.effects ?? [];
    expect(effects().map((e) => e.type)).toEqual(["zigzag"]);
    expect(t.querySelectorAll("[data-vector-effect]")).toHaveLength(1);
    // A slider drag is one undo step.
    const slider = q<HTMLInputElement>('input[aria-label="Zig Zag Size slider"]');
    for (const v of ["7", "8", "9"]) setValue(slider, v);
    slider.dispatchEvent(new Event("pointerup", { bubbles: true }));
    flushSync();
    expect((effects()[0].params as any).size).toBe(9);
    expect(q<HTMLInputElement>('input[aria-label="Zig Zag Size"]').value).toBe("9");
    c.undo();
    flushSync();
    expect((effects()[0].params as any).size).toBe(5);
    c.redo();
    flushSync();
    click(q('input[aria-label="Zig Zag Smooth"]'));
    expect((effects()[0].params as any).smooth).toBe(true);
    click(q('input[aria-label="Zig Zag on"]'));
    expect(effects()[0].enabled).toBe(false);
    setValue(q<HTMLSelectElement>('select[aria-label="Add effect"]'), "repeater");
    expect(effects().map((e) => e.type)).toEqual(["zigzag", "repeater"]);
    setValue(q<HTMLInputElement>('input[aria-label="Repeater Position x"]'), "150");
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

  it("renders effected geometry and live booleans", () => {
    const c = pair();
    c.addEffect("repeater", { ids: ["a"], params: { copies: 3, position: { x: 120, y: 0 } } });
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    expect(t.querySelectorAll('[data-vector-scene] [data-vector-id^="a~fx"]')).toHaveLength(3);
    c.removeEffect("a", c.getNode("a")!.effects![0].id);
    c.booleanOp("subtract", { ids: ["a", "b"], live: true });
    flushSync();
    const id = c.getState().selection[0];
    const result = t.querySelector(`[data-vector-scene] [data-vector-id="${id}"] path`)!;
    expect(result.getAttribute("d")).toBe("M0 0L100 0L100 50L50 50L50 100L0 100Z");
  });

  it("toolbar makes live booleans", () => {
    const c = pair();
    const t = render(VectorToolbar, { controller: c });
    c.select(["a", "b"]);
    flushSync();
    click(t.querySelector("[data-vector-live-boolean]"));
    expect(t.querySelector("[data-vector-live-boolean]")!.getAttribute("aria-pressed")).toBe("true");
    click(t.querySelector('button[aria-label="Union"]'));
    const g = c.getNode(c.getState().selection[0]) as any;
    expect(g.liveBoolean).toBe("union");
    expect(g.children.map((k: any) => k.id)).toEqual(["a", "b"]);
    click(t.querySelector('button[aria-label="Exclude"]'));
    expect((c.getNode(g.id) as any).liveBoolean).toBe("exclude");
  });
});

describe("Blend (svelte)", () => {
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

  it("toolbar makes a blend, edits its spacing, replaces its spine and expands it", () => {
    const c = pair();
    const t = render(VectorToolbar, { controller: c });
    const make = t.querySelector('[data-vector-blend-action="make"]') as HTMLButtonElement;
    expect(make.disabled).toBe(true);
    expect((t.querySelector('[data-vector-blend-action="expand"]') as HTMLButtonElement).disabled).toBe(true);
    c.select(["a", "b"]);
    flushSync();
    click(make);
    const id = c.getState().selection[0];
    const blend = () => c.getNode(id) as any;
    expect(blend().blend).toBeTruthy();
    expect(blend().children.filter((k: any) => k.blendStep)).toHaveLength(5);
    setValue(t.querySelector('input[aria-label="Blend steps"]') as HTMLInputElement, "2");
    expect(blend().children.filter((k: any) => k.blendStep)).toHaveLength(2);
    setValue(t.querySelector('select[aria-label="Blend spacing"]') as HTMLSelectElement, "distance");
    expect(blend().blend.spacing).toBe("distance");
    expect(t.querySelector('input[aria-label="Blend distance"]')).toBeTruthy();
    click(t.querySelector('[data-vector-blend-action="orient"]'));
    expect(blend().blend.orientToSpine).toBe(true);
    expect(t.querySelector('[data-vector-blend-action="orient"]')!.getAttribute("aria-pressed")).toBe("true");
    c.select([id, "s"]);
    flushSync();
    click(t.querySelector('[data-vector-blend-action="spine"]'));
    expect(blend().blend.spine.anchors).toHaveLength(3);
    expect(c.getNode("s")).toBeUndefined();
    click(t.querySelector('[data-vector-blend-action="expand"]'));
    expect(blend().blend).toBeUndefined();
    expect(c.getState().undoLabel).toBe("Expand Blend");
  });

  it("draws the spine and the Blend tool's first pick", () => {
    const c = pair();
    const id = c.blend({ ids: ["a", "b"], steps: 3 })!;
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    expect(t.querySelectorAll("[data-vector-scene] path")).toHaveLength(6);
    expect(t.querySelector(`[data-vector-blend-spine="${id}"]`)).toBeTruthy();
    expect(t.querySelectorAll(`[data-vector-blend-spine="${id}"] circle`)).toHaveLength(2);
    const svg = t.querySelector("svg")!;
    key(svg, "j");
    expect(c.getState().tool).toBe("blend");
    c.select([]);
    flushSync();
    pointer(svg, "pointermove", 10, 200);
    expect(t.querySelectorAll("[data-vector-blend-anchor]")).toHaveLength(3);
    pointer(svg, "pointerdown", 10, 200);
    pointer(svg, "pointerup", 10, 200);
    expect(t.querySelector("[data-vector-blend-start] circle")).toBeTruthy();
    pointer(svg, "pointerdown", 100, 10);
    expect(c.getState().blendStart).toBeNull();
    expect(c.getState().undoLabel).toBe("Blend");
  });
});

describe("gradients (svelte)", () => {
  const fillOf = (c: VectorEditorController) => (c.getNode("a") as VectorPathNode).fill as any;

  it("renders conic patterns and the gradient tool's annotator, and drags its handles", () => {
    const c = make();
    c.select(["a"]);
    c.setGradient({ type: "conic", stops: [{ offset: 0, color: "#ff0000" }, { offset: 0.5, color: "#00ff00" }, { offset: 1, color: "#0000ff" }] });
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const pattern = t.querySelector('pattern[id$="fill-a"]')!;
    expect(pattern.getAttribute("patternUnits")).toBe("userSpaceOnUse");
    expect(pattern.querySelectorAll("linearGradient").length).toBe(72);
    expect(t.querySelector('[data-vector-scene] path[data-vector-id="a"]')!.getAttribute("fill")).toBe(`url(#${pattern.id})`);
    const svg = t.querySelector("svg")!;
    key(svg, "g");
    expect(c.getState().tool).toBe("gradient");
    expect(t.querySelector('[data-vector-gradient-annotator="conic"]')).toBeTruthy();
    expect(t.querySelectorAll("[data-vector-gradient-stop]")).toHaveLength(3);
    expect(t.querySelectorAll("[data-vector-gradient-midpoint]")).toHaveLength(2);
    expect(t.querySelector('[data-vector-gradient-handle="radius"]')).toBeTruthy();
    expect(t.querySelector('[data-vector-gradient-handle="aspect"]')).toBeTruthy();
    const a = c.getGradientAnnotator()!;
    pointer(svg, "pointerdown", a.end.x, a.end.y);
    pointer(svg, "pointermove", a.end.x + 10, a.end.y + 20);
    pointer(svg, "pointerup", a.end.x + 20, a.end.y + 40);
    expect(c.getGradientAnnotator()!.end.x).toBeCloseTo(a.end.x + 20);
    expect(c.getState().undoLabel).toBe("Gradient Handle");
    const s = c.getGradientAnnotator()!.stops[1];
    pointer(svg, "pointerdown", s.x, s.y);
    pointer(svg, "pointermove", s.x, s.y + 70);
    expect(t.querySelector("[data-vector-status]")!.textContent).toBe("Release to delete the stop");
    pointer(svg, "pointerup", s.x, s.y + 70);
    expect(fillOf(c).stops).toHaveLength(2);
    expect(t.querySelectorAll("[data-vector-gradient-stop]")).toHaveLength(2);
    c.setGradient({ type: "diamond" });
    flushSync();
    expect(t.querySelector('pattern[id$="fill-a"]')!.querySelectorAll("path")).toHaveLength(4);
  });

  it("drags out a new gradient over a shape", () => {
    const c = make();
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const svg = t.querySelector("svg")!;
    key(svg, "g");
    pointer(svg, "pointerdown", 10, 50);
    pointer(svg, "pointermove", 50, 50);
    pointer(svg, "pointerup", 90, 50);
    expect(fillOf(c)).toMatchObject({ type: "linear", start: { x: 10, y: 50 }, end: { x: 90, y: 50 } });
    expect(t.querySelectorAll("linearGradient")).toHaveLength(1);
    expect(t.querySelector("[data-vector-gradient-bar]")!.getAttribute("x2")).toBe("90");
  });

  it("gradient editor edits type, stops, midpoints, colour space, spread, stroke mode and reverse", () => {
    const c = make();
    c.select(["a"]);
    const t = render(VectorStylePanel, { controller: c });
    const q = <T extends Element = HTMLElement>(sel: string) => t.querySelector(sel) as T;
    expect(q('[data-vector-gradient-editor="fill"]')).toBeTruthy();
    expect(q("[data-vector-gradient-ramp]")).toBeNull();
    setValue(q<HTMLSelectElement>('select[aria-label="Gradient type"]'), "radial");
    expect(fillOf(c)).toMatchObject({ type: "radial", stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#ffffff" }] });
    click(q('[aria-label="Add gradient stop"]'));
    expect(fillOf(c).stops.map((s: any) => s.offset)).toEqual([0, 0.5, 1]);
    expect(q('[data-vector-gradient-stop="1"]').getAttribute("aria-pressed")).toBe("true");
    setValue(q<HTMLInputElement>('input[aria-label="Stop colour"]'), "#00ff00");
    expect(fillOf(c).stops[1].color).toBe("#00ff00");
    setValue(q<HTMLInputElement>('input[aria-label="Stop midpoint"]'), "30");
    expect(fillOf(c).stops[1].midpoint).toBeCloseTo(0.3);
    setValue(q<HTMLInputElement>('input[aria-label="Stop opacity"]'), "50");
    expect(fillOf(c).stops[1].opacity).toBeCloseTo(0.5);
    setValue(q<HTMLInputElement>('input[aria-label="Stop position"]'), "25");
    expect(fillOf(c).stops[1].offset).toBeCloseTo(0.25);
    setValue(q<HTMLSelectElement>('select[aria-label="Gradient interpolation"]'), "oklab");
    setValue(q<HTMLSelectElement>('select[aria-label="Gradient spread"]'), "reflect");
    expect(fillOf(c)).toMatchObject({ interpolation: "oklab", spread: "reflect" });
    click(q('button[aria-label="Reverse gradient"]'));
    expect(fillOf(c).stops[0].color).toBe("#ffffff");
    click(q('button[aria-label="Delete stop"]'));
    expect(fillOf(c).stops).toHaveLength(2);
    click(Array.from(t.querySelectorAll("[data-vector-gradient-editor] button")).find((b) => b.textContent === "Stroke")!);
    expect(q('[data-vector-gradient-editor="stroke"]')).toBeTruthy();
    setValue(q<HTMLSelectElement>('select[aria-label="Gradient type"]'), "linear");
    setValue(q<HTMLSelectElement>('select[aria-label="Gradient on stroke"]'), "along");
    expect((c.getNode("a") as VectorPathNode).stroke).toMatchObject({ type: "linear", strokeMode: "along" });
    setValue(q<HTMLSelectElement>('select[aria-label="Gradient type"]'), "solid");
    expect((c.getNode("a") as VectorPathNode).stroke).toBe("#000000");
  });
});

describe("distort and envelopes (svelte)", () => {
  const envelopeOf = (c: VectorEditorController, id = "a") => (c.getNode(id)!.effects ?? []).find((e) => e.type === "envelope") as any;

  it("makes, edits, releases and expands an envelope from the panel", () => {
    const c = make();
    c.select(["a"]);
    const t = render(VectorStylePanel, { controller: c });
    const q = <T extends Element = HTMLElement>(sel: string) => t.querySelector(sel) as T;
    expect(q("[data-vector-envelope]")).toBeTruthy();
    expect(q<HTMLButtonElement>('button[aria-label="Release Envelope"]').disabled).toBe(true);
    expect(q<HTMLButtonElement>('button[aria-label="Make with Top Object"]').disabled).toBe(true);
    click(q('button[aria-label="Make with Warp"]'));
    expect(envelopeOf(c).params).toMatchObject({ style: "arc", bend: 50 });
    expect(q<HTMLButtonElement>('button[aria-label="Make with Warp"]').disabled).toBe(true);
    setValue(q<HTMLSelectElement>('select[aria-label="Envelope warp"]'), "flag");
    expect(envelopeOf(c).params.style).toBe("flag");
    // A slider drag is one undo step.
    const slider = q<HTMLInputElement>('input[aria-label="Envelope Bend % slider"]');
    for (const v of ["20", "30", "-40"]) setValue(slider, v);
    slider.dispatchEvent(new Event("pointerup", { bubbles: true }));
    flushSync();
    expect(envelopeOf(c).params.bend).toBe(-40);
    expect(q<HTMLInputElement>('input[aria-label="Envelope Bend %"]').value).toBe("-40");
    c.undo();
    flushSync();
    expect(envelopeOf(c).params.bend).toBe(50);
    c.redo();
    flushSync();
    setValue(q<HTMLInputElement>('input[aria-label="Envelope Horizontal distortion %"]'), "25");
    expect(envelopeOf(c).params.horizontal).toBe(25);
    setValue(q<HTMLSelectElement>('select[aria-label="Envelope orientation"]'), "vertical");
    expect(envelopeOf(c).params.orientation).toBe("vertical");
    setValue(q<HTMLInputElement>('input[aria-label="Envelope mesh rows"]'), "3");
    expect(envelopeOf(c).params.rows).toBe(3);
    // Switching to Mesh makes the preset an editable mesh of that size; the sliders go.
    setValue(q<HTMLSelectElement>('select[aria-label="Envelope warp"]'), "mesh");
    expect(envelopeOf(c).params.mesh.vs).toHaveLength(4);
    expect(q('input[aria-label="Envelope Bend % slider"]')).toBeNull();
    click(q('button[aria-label="Expand Envelope"]'));
    expect(envelopeOf(c)).toBeUndefined();
    expect(c.getState().undoLabel).toBe("Expand Appearance");
    c.undo();
    flushSync();
    click(q('button[aria-label="Release Envelope"]'));
    expect(envelopeOf(c)).toBeUndefined();
    expect(c.getDocument().nodes).toHaveLength(2);
  });

  it("makes an envelope with a mesh of the chosen size, and with the top object", () => {
    const c = make();
    c.addShape({ kind: "ellipse", x: -20, y: -20, width: 140, height: 140 });
    c.select(["a", c.getDocument().nodes[1].id]);
    const t = render(VectorStylePanel, { controller: c });
    const q = <T extends Element = HTMLElement>(sel: string) => t.querySelector(sel) as T;
    expect(q<HTMLButtonElement>('button[aria-label="Make with Top Object"]').disabled).toBe(false);
    click(q('button[aria-label="Make with Top Object"]'));
    expect(c.getDocument().nodes).toHaveLength(1);
    expect(envelopeOf(c).params.style).toBe("mesh");
    c.undo();
    c.select(["a"]);
    flushSync();
    setValue(q<HTMLInputElement>('input[aria-label="Envelope mesh columns"]'), "3");
    click(q('button[aria-label="Make with Mesh"]'));
    expect(envelopeOf(c).params).toMatchObject({ style: "mesh", columns: 3, rows: 2 });
  });

  it("draws the envelope mesh with the Envelope tool and drags its anchors", () => {
    const c = make();
    c.select(["a"]);
    c.envelope({ style: "mesh", rows: 2, columns: 2 });
    c.setTool("envelope");
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const q = <T extends Element = HTMLElement>(sel: string) => t.querySelector(sel) as T;
    expect(q("[data-vector-envelope-mesh]").getAttribute("data-vector-envelope-mesh")).toBe("a");
    expect(q("[data-vector-envelope-grid]").getAttribute("d")).toContain("C");
    expect(t.querySelectorAll("[data-vector-envelope-anchor]")).toHaveLength(9);
    expect(t.querySelectorAll("[data-vector-envelope-handle]")).toHaveLength(24);
    const svg = q("svg");
    pointer(svg, "pointerdown", 50, 50);
    pointer(svg, "pointermove", 60, 40);
    pointer(svg, "pointerup", 60, 40);
    expect(envelopeOf(c).params.mesh.points[3 * 7 + 3]).toEqual({ x: 60, y: 40 });
    expect(q('[data-vector-envelope-anchor="24"]').getAttribute("x")).toBe(String(60 - 3.5));
    expect(c.getState().undoLabel).toBe("Edit Envelope");
    c.setTool("select");
    flushSync();
    expect(q("[data-vector-envelope-mesh]")).toBeNull();
  });

  it("toggles Free Distort from the toolbar and drags a corner in perspective on the canvas", () => {
    const c = make();
    c.select(["a"]);
    const bar = render(VectorToolbar, { controller: c });
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const q = <T extends Element = HTMLElement>(sel: string) => t.querySelector(sel) as T;
    const toggle = bar.querySelector("[data-vector-free-distort]")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    click(toggle);
    expect(c.getState().freeDistort).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(q("[data-vector-selection]").getAttribute("data-free-distort")).toBe("true");
    const svg = q("svg");
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

describe("appearance stacks (svelte)", () => {
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

  it("draws each layer, the blend modes and the filter", () => {
    const c = new VectorEditorController({ document: stackedDoc() });
    const target = render(VectorCanvas, { controller: c, fitOnMount: false });
    const g = target.querySelector('g[data-vector-id="a"]') as SVGGElement;
    const filterId = /^url\(#(.+-filter-a)\)$/.exec(g.getAttribute("filter") ?? "")![1];
    expect(g.getAttribute("style")).toContain("mix-blend-mode: screen");
    expect(Array.from(target.querySelectorAll('g[data-vector-id="a"] > [data-vector-layer]')).map((el) => el.getAttribute("data-vector-layer"))).toEqual(["fill-0", "fill-1", "stroke-0", "stroke-1"]);
    const fill1 = target.querySelector('[data-vector-layer="fill-1"]')!;
    expect(fill1.getAttribute("opacity")).toBe("0.5");
    expect(fill1.getAttribute("style")).toContain("mix-blend-mode: multiply");
    expect(target.querySelector('[data-vector-layer="stroke-0"]')!.getAttribute("data-vector-stroke-align")).toBe("outside");
    expect(target.querySelector(`filter[id="${filterId}"]`)?.querySelector("feGaussianBlur, fegaussianblur")).toBeTruthy();
  });

  it("edits the stacks, blend mode and filters from the style panel", () => {
    const c = new VectorEditorController({ document: stackedDoc() });
    c.select(["a"]);
    const target = render(VectorStylePanel, { controller: c });
    const q = (sel: string) => target.querySelector(sel) as HTMLElement;
    const path = () => c.getNode("a") as VectorPathNode;
    expect(Array.from(target.querySelectorAll('[data-vector-stack="fill"] [data-vector-layer]')).map((el) => el.getAttribute("data-vector-layer"))).toEqual(["fill-1", "fill-0"]);
    click(q('button[aria-label="Add fill"]'));
    expect(path().fills).toHaveLength(3);
    click(q('button[aria-label="Move Fill 1 up"]'));
    expect(path().fills!.map((l) => l.paint)).toEqual(["#00ff00", "#ff0000", "#808080"]);
    click(q('button[aria-label="Remove Fill 3"]'));
    expect(path().fills).toHaveLength(2);
    click(q('input[aria-label="Stroke 1 visible"]'));
    expect(path().strokes![0].visible).toBe(false);
    const blend = q('select[aria-label="Blend mode"]') as HTMLSelectElement;
    blend.value = "difference";
    blend.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(path().blendMode).toBe("difference");
    const add = q('select[aria-label="Add filter"]') as HTMLSelectElement;
    add.value = "layerBlur";
    add.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(path().filters!.map((f) => f.type)).toEqual(["dropShadow", "layerBlur"]);
    click(q('button[aria-label="Remove Drop Shadow"]'));
    expect(path().filters!.map((f) => f.type)).toEqual(["layerBlur"]);
    click(q('button[aria-label="Edit Stroke 1 gradient"]'));
    expect(c.getState().gradientEdit).toMatchObject({ target: "stroke", layer: 0 });
  });
});

describe("masks (svelte)", () => {
  const maskDoc = (): VectorDocument => ({
    width: 400,
    height: 300,
    nodes: [
      { id: "a", type: "path", fill: "#ff0000", stroke: null, subpaths: [rectSubpath({ x: 0, y: 0, width: 100, height: 100 })] },
      { id: "m", type: "path", fill: "#ffffff", stroke: null, subpaths: [rectSubpath({ x: 20, y: 20, width: 40, height: 40 })] },
      { id: "b", type: "path", fill: "#0000ff", stroke: null, subpaths: [rectSubpath({ x: 200, y: 0, width: 50, height: 50 })] },
    ],
  });

  it("draws a clip group's contents under a clipPath, with the group's filter outside it, and the mask indicator", () => {
    const c = new VectorEditorController({ document: maskDoc(), createId: () => "g" });
    c.makeMask("clip", { ids: ["a", "m"] });
    c.addFilter("dropShadow", { ids: ["g"] });
    c.select(["g"]);
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const g = t.querySelector('[data-vector-scene] g[data-vector-id="g"]')!;
    expect(g.getAttribute("data-vector-mask")).toBe("clip");
    expect(g.getAttribute("filter")).toMatch(/filter-g\)$/);
    const inner = g.querySelector("g[data-vector-masked]")!;
    const clipId = /^url\(#(.+)\)$/.exec(inner.getAttribute("clip-path")!)![1];
    expect(t.querySelector(`clipPath[id="${clipId}"] path`)).toBeTruthy();
    expect(Array.from(inner.querySelectorAll("[data-vector-id]")).map((el) => el.getAttribute("data-vector-id"))).toEqual(["a"]);
    expect(t.querySelector('[data-vector-overlay] [data-vector-mask-indicator="g"]')!.getAttribute("stroke-dasharray")).toBeTruthy();
  });

  it("draws an inverted opacity mask through its filter", () => {
    const c = new VectorEditorController({ document: maskDoc(), createId: () => "g" });
    c.makeMask("alpha", { ids: ["a", "m"], invert: true });
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const inner = t.querySelector('g[data-vector-id="g"] g[data-vector-masked]')!;
    const maskId = /^url\(#(.+)\)$/.exec(inner.getAttribute("mask")!)![1];
    const mask = t.querySelector(`mask[id="${maskId}"]`)!;
    expect(mask.getAttribute("maskUnits")).toBe("userSpaceOnUse");
    expect(mask.getAttribute("style")).toContain("mask-type: alpha");
    const filterId = /^url\(#(.+)\)$/.exec(mask.querySelector("g[filter]")!.getAttribute("filter")!)![1];
    expect(t.querySelector(`filter[id="${filterId}"] feColorMatrix, filter[id="${filterId}"] fecolormatrix`)).toBeTruthy();
    expect(mask.querySelector('[data-vector-id="m"]')).toBeTruthy();
  });

  it("makes, edits and releases masks from the panel and the toolbar", () => {
    const c = new VectorEditorController({ document: maskDoc(), createId: () => "g" });
    c.select(["a", "m"]);
    const bar = render(VectorToolbar, { controller: c });
    const t = render(VectorStylePanel, { controller: c });
    const q = (sel: string) => t.querySelector(sel) as HTMLElement;
    click(q('[data-vector-mask-panel] button[aria-label="Make Clipping Mask"]'));
    const group = () => c.getNode("g") as any;
    expect(group().mask).toEqual({ type: "clip" });
    const type = q('select[aria-label="Mask type"]') as HTMLSelectElement;
    type.value = "luminance";
    type.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(group().mask).toEqual({ type: "luminance" });
    click(q('input[aria-label="Invert mask"]'));
    expect(group().mask).toEqual({ type: "luminance", invert: true });
    click(q('button[aria-label="Mask on"]'));
    expect(c.getNode("m")!.visible).toBe(false);
    click(q('button[aria-label="Edit Contents"]'));
    expect(c.getState().selection).toEqual(["a"]);
    click(q('button[aria-label="Edit Mask"]'));
    expect(c.getState().selection).toEqual(["m"]);
    expect(q('button[aria-label="Edit Mask"]').getAttribute("aria-pressed")).toBe("true");
    c.select(["g"]);
    flushSync();
    click(bar.querySelector('button[aria-label^="Release Mask"]'));
    expect(c.getNode("g")).toBeUndefined();
    expect(c.getState().document.nodes.map((n) => n.id)).toEqual(["a", "m", "b"]);
  });
});

describe("text (svelte)", () => {
  it("types into new text through the hidden textarea, draws it as SVG text, and styles it from the panel", async () => {
    const c = new VectorEditorController({ document: { width: 400, height: 300, nodes: [] }, createId: () => `t${++n}` });
    c.setTool("type");
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const panel = render(VectorStylePanel, { controller: c });
    const svg = t.querySelector("svg")!;
    pointer(svg, "pointerdown", 40, 60);
    pointer(svg, "pointerup", 40, 60);
    const input = t.querySelector<HTMLTextAreaElement>('[data-testid="vector-type-input"]')!;
    expect(input).not.toBeNull();
    input.value = "Hi";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    const id = c.getState().textEdit!.nodeId;
    expect((c.getNode(id) as any).text).toBe("Hi");
    expect(t.querySelector("[data-vector-text-caret]")).not.toBeNull();
    key(input, "Backspace");
    expect((c.getNode(id) as any).text).toBe("H");
    expect(key(input, "v").defaultPrevented).toBe(false);
    expect(c.getState().tool).toBe("type");
    input.value = "ey";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(t.querySelector(`[data-vector-scene] [data-vector-id="${id}"] tspan`)?.textContent).toBe("Hey");
    key(input, "Escape");
    expect(c.getState().textEdit).toBeNull();
    expect(t.querySelector('[data-testid="vector-type-input"]')).toBeNull();
    click(panel.querySelector('[data-vector-text-panel] button[aria-label="Bold"]'));
    expect((c.getNode(id) as any).font.fontWeight).toBe(700);
    click(panel.querySelector('[data-vector-text-panel] button[aria-label="Align Centre"]'));
    expect((c.getNode(id) as any).paragraph).toEqual({ align: "center" });
    c.undo();
    expect((c.getNode(id) as any).paragraph).toBeUndefined();
  });
});

describe("symbols (svelte)", () => {
  it("makes a symbol from the panel, draws instances, edits the symbol in isolation and detaches", () => {
    const c = make();
    c.select(["a"]);
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const panel = render(VectorStylePanel, { controller: c });
    click(panel.querySelector('[data-vector-symbols-panel] [data-vector-symbol-action="make"]'));
    const sym = c.getSymbols()[0];
    expect(panel.querySelectorAll("[data-vector-symbols-panel] [data-vector-symbol]")).toHaveLength(1);
    expect(panel.querySelector(`[data-vector-symbol="${sym.id}"] svg path`)).not.toBeNull();
    click(panel.querySelector(`[data-vector-symbols-panel] button[aria-label="Place ${sym.name}"]`));
    expect(c.getSymbolInstances(sym.id)).toHaveLength(2);
    const instanceId = c.getState().selection[0];
    expect(t.querySelector(`[data-vector-scene] [data-vector-id="${instanceId}"] path`)).not.toBeNull();
    click(panel.querySelector(`button[aria-label="Edit ${sym.name}"]`));
    expect(c.getState().symbolEdit?.symbolId).toBe(sym.id);
    expect(t.querySelector("[data-vector-symbol-edit]")).not.toBeNull();
    click(t.querySelector('button[aria-label="Exit symbol"]'));
    expect(c.getState().symbolEdit).toBeNull();
    c.select([instanceId]);
    flushSync();
    click(panel.querySelector('input[aria-label="Scale strokes"]'));
    expect((c.getNode(instanceId) as any).scaleStrokes).toBe(false);
    click([...panel.querySelectorAll("[data-vector-instance] button")].find((b) => b.textContent === "Detach")!);
    expect(c.getNode(instanceId)?.type).toBe("group");
  });
});

describe("constraints (svelte)", () => {
  it("adds a constraint from selected anchors, shows its glyph and the DOF, and edits its value", () => {
    const c = new VectorEditorController({ document: { width: 400, height: 300, nodes: [{ id: "p", type: "path", fill: null, stroke: "#000", subpaths: [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 100, y: 4 }] }] }] } });
    c.setTool("direct");
    c.select(["p"]);
    c.selectAnchors([{ nodeId: "p", subpath: 0, index: 0 }, { nodeId: "p", subpath: 0, index: 1 }]);
    const t = render(VectorCanvas, { controller: c, fitOnMount: false });
    const panel = render(VectorStylePanel, { controller: c });
    expect([...panel.querySelectorAll("[data-vector-constraint-action]")].map((b) => b.getAttribute("data-vector-constraint-action"))).toEqual(["horizontal", "vertical", "distance", "fix"]);
    click(panel.querySelector('[data-vector-constraint-action="horizontal"]'));
    click(panel.querySelector('[data-vector-constraint-action="distance"]'));
    expect(c.getConstraints().map((k) => k.kind)).toEqual(["horizontal", "distance"]);
    expect(panel.querySelector("[data-vector-dof]")?.textContent).toMatch(/2 degrees of freedom remaining/);
    expect(t.querySelectorAll("[data-vector-constraint-glyph]").length).toBe(2);
    const input = panel.querySelector<HTMLInputElement>('input[aria-label="Value of d1"]')!;
    input.value = "40";
    input.dispatchEvent(new FocusEvent("blur"));
    flushSync();
    const a = (c.getNode("p") as VectorPathNode).subpaths[0].anchors;
    expect(Math.hypot(a[1].x - a[0].x, a[1].y - a[0].y)).toBeCloseTo(40, 5);
  });
});

describe("corner smoothing (svelte)", () => {
  it("shows the smoothing slider for rounded corners and sets it", () => {
    const c = make();
    c.select(["a"]);
    c.setCornerRadius(10);
    const t = render(VectorStylePanel, { controller: c });
    const slider = t.querySelector<HTMLInputElement>('input[aria-label="Corner smoothing"]')!;
    expect(slider).not.toBeNull();
    slider.value = "0.6";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect((c.getNode("a") as VectorPathNode).subpaths[0].anchors[0].corner).toEqual({ radius: 10, smoothing: 0.6 });
  });
});

describe("VectorPerspectivePanel (svelte)", () => {
  it("adds a grid, draws on a plane, and the canvas shows the grid", async () => {
    const { VectorPerspectivePanel } = await import("../src/vector");
    const c = make();
    const el = render(VectorPerspectivePanel, { controller: c });
    click(el.querySelector('[data-vector-perspective-preset="2"]'));
    expect(c.getPerspective()?.vanishingPoints).toHaveLength(2);
    const select = el.querySelector('select[aria-label="Draw on plane"]') as HTMLSelectElement;
    select.value = "left";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(c.getState().perspectivePlane).toBe("left");
    const canvas = render(VectorCanvas, { controller: c });
    expect(canvas.querySelector('[data-vector-perspective-plane="left"][data-active]')).not.toBeNull();
    click(Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Remove")!);
    expect(c.getPerspective()).toBeNull();
  });
});

describe("VectorLensPanel (svelte)", () => {
  it("makes the selected closed path a lens, edits its amount and removes it", async () => {
    const { VectorLensPanel } = await import("../src/vector");
    const c = make();
    c.select(["a"]);
    const el = render(VectorLensPanel, { controller: c });
    const select = el.querySelector('select[aria-label="Lens type"]') as HTMLSelectElement;
    select.value = "magnify";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect((c.getNode("a") as VectorPathNode).lens).toEqual({ type: "magnify", amount: 2 });
    const amount = el.querySelector('input[aria-label="Lens amount"]') as HTMLInputElement;
    amount.value = "3";
    amount.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect((c.getNode("a") as VectorPathNode).lens?.amount).toBe(3);
    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect((c.getNode("a") as VectorPathNode).lens).toBeUndefined();
  });
});

describe("VectorGeneratePanel (svelte)", () => {
  it("generates art from a prompt into the document", async () => {
    const { VectorGeneratePanel } = await import("../src/vector");
    const c = make();
    const models = [{ id: "sketch", media: "text" as const, name: "Sketcher" }];
    const generate = async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#f00"/></svg>' });
    const el = render(VectorGeneratePanel, { controller: c, models, generate });
    const input = el.querySelector('input[aria-label="Prompt"]') as HTMLInputElement;
    input.value = "a red square";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    click(el.querySelector("[data-vector-generate-action]"));
    await new Promise((r) => setTimeout(r, 0));
    const group = c.getState().document.nodes.at(-1) as any;
    expect(group.generation.rawPrompt).toBe("a red square");
  });
});

describe("VectorPagesPanel (svelte)", () => {
  it("adds pages and a master page, goes to a page and changes its master", async () => {
    const { VectorPagesPanel } = await import("../src/vector");
    const c = make();
    const el = render(VectorPagesPanel, { controller: c });
    click(el.querySelector('[data-vector-pages-action="add"]'));
    click(el.querySelector('[data-vector-pages-action="add"]'));
    click(el.querySelector('[data-vector-pages-action="master"]'));
    const { pages, masters } = c.getPages();
    expect(pages).toHaveLength(2);
    expect(pages.every((p) => p.masterId === masters[0].id)).toBe(true);
    click(el.querySelector(`[data-vector-page="${pages[1].id}"]`));
    expect(c.getState().selection).toEqual([pages[1].id]);
    const select = el.querySelector('select[aria-label="Master page"]') as HTMLSelectElement;
    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(c.getPages().pages[1].masterId).toBeNull();
  });
});

describe("Distort Brush (svelte)", () => {
  it("shows its options for the tool and draws the brush circle while dragging", () => {
    const c = make();
    const el = render(VectorToolbar, { controller: c });
    c.setTool("distort");
    flushSync();
    const mode = el.querySelector('select[aria-label="Distort brush"]') as HTMLSelectElement;
    mode.value = "twirl";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(c.getState().editing.distortMode).toBe("twirl");
    const canvas = render(VectorCanvas, { controller: c });
    c.pointerDown({ x: 50, y: 50 });
    c.pointerMove({ x: 60, y: 50 });
    flushSync();
    expect(canvas.querySelector("[data-vector-brush]")).not.toBeNull();
    c.pointerUp({ x: 60, y: 50 });
  });
});

describe("VectorLensPanel (svelte)", () => {
  it("makes the selected closed path a lens, edits its amount and removes it", async () => {
    const { VectorLensPanel } = await import("../src/vector");
    const c = make();
    c.select(["a"]);
    const el = render(VectorLensPanel, { controller: c });
    const select = el.querySelector('select[aria-label="Lens type"]') as HTMLSelectElement;
    select.value = "magnify";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect((c.getNode("a") as VectorPathNode).lens).toEqual({ type: "magnify", amount: 2 });
    const amount = el.querySelector('input[aria-label="Lens amount"]') as HTMLInputElement;
    amount.value = "3";
    amount.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect((c.getNode("a") as VectorPathNode).lens?.amount).toBe(3);
    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect((c.getNode("a") as VectorPathNode).lens).toBeUndefined();
  });
});
