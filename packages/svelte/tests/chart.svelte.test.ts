import { describe, it, expect, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { CommandRegistry } from "@pixerate/editor/commands";
import { ChartController, type ChartSpec } from "@pixerate/editor/chart";
import { ChartCanvas, ChartDataGrid, ChartEditor, ChartInspector, createChartEditor, useChartCommands } from "../src/chart";

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});

const sales: Partial<ChartSpec> = {
  title: "Quarterly sales",
  categories: ["Q1", "Q2", "Q3"],
  series: [
    { id: "north", name: "North", values: [12, 18, 9] },
    { id: "south", name: "South", values: [8, 11, 14] },
  ],
};

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

const fire = (el: Element, type: string, init: any = {}) => {
  const Ctor = type.startsWith("pointer") ? ((globalThis as any).PointerEvent ?? MouseEvent) : type.startsWith("key") ? KeyboardEvent : Event;
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
  flushSync();
};
const type = (el: HTMLInputElement | HTMLSelectElement, value: string, commit: "blur" | "enter" | "change" = "blur") => {
  el.value = value;
  fire(el, el instanceof HTMLSelectElement ? "change" : "input");
  if (commit === "blur") {
    el.dispatchEvent(new FocusEvent("blur"));
    flushSync();
  }
  if (commit === "enter") fire(el, "keydown", { key: "Enter" });
};
const click = (el: Element | null) => {
  (el as HTMLElement).click();
  flushSync();
};

describe("createChartEditor", () => {
  it("follows the controller and binds actions", () => {
    const chart = createChartEditor({ spec: sales });
    cleanups.push(chart.destroy);
    expect(chart.spec.title).toBe("Quarterly sales");
    chart.update({ title: "Revenue" });
    expect(chart.spec.title).toBe("Revenue");
    chart.undo();
    expect(chart.spec.title).toBe("Quarterly sales");
    chart.select({ kind: "legend" });
    expect(chart.selection).toEqual({ kind: "legend" });
    chart.setType("line");
    chart.setValue("north", 0, 1);
    expect(chart.state.spec).toMatchObject({ type: "line" });
    expect(chart.controller.getSpec().series[0].values[0]).toBe(1);
  });

  it("registers commands for the component's lifetime", () => {
    const registry = new CommandRegistry();
    const controller = new ChartController({ spec: sales });
    const cleanup = $effect.root(() => {
      useChartCommands(() => registry, controller, { prefix: "sales." });
    });
    flushSync();
    expect(registry.has("sales.describe")).toBe(true);
    registry.execute("sales.update", { type: "line" });
    expect(controller.getSpec().type).toBe("line");
    cleanup();
    expect(registry.has("sales.describe")).toBe(false);
  });
});

describe("ChartCanvas", () => {
  it("draws the scene as SVG and selects what is clicked", () => {
    const controller = new ChartController({ spec: sales });
    const el = render(ChartCanvas, { controller, width: 600, height: 360, responsive: false });
    expect(el.querySelectorAll('[data-role="bar"]')).toHaveLength(6);
    expect(el.querySelector('[data-role="title"]')!.textContent).toBe("Quarterly sales");
    fire(el.querySelector('[data-chart-key="bar-south-1"]')!, "pointerdown", { button: 0, clientX: 0, clientY: 0 });
    fire(el.querySelector("svg")!, "pointerup");
    expect(controller.getState().selection).toEqual({ kind: "point", seriesId: "south", index: 1 });
    expect(el.querySelector('[data-chart-key="bar-south-1"]')!.hasAttribute("data-selected")).toBe(true);
    expect(el.querySelector("svg")!.getAttribute("aria-label")).toContain("South · Q2: 11");
    fire(el.querySelector('[data-role="background"]')!, "pointerdown", { button: 0 });
    expect(controller.getState().selection).toEqual({ kind: "chart" });
  });

  it("drags a bar to change its value as one undo step", () => {
    const controller = new ChartController({ spec: sales });
    const el = render(ChartCanvas, { controller, width: 600, height: 360, responsive: false });
    // jsdom boxes are empty, so client coordinates are scene coordinates.
    const bar = el.querySelector('[data-chart-key="bar-north-0"]')!;
    const y = Number(bar.getAttribute("y"));
    const svg = el.querySelector("svg")!;
    fire(bar, "pointerdown", { button: 0, clientX: 50, clientY: y });
    fire(svg, "pointermove", { clientX: 50, clientY: y - 60 });
    fire(svg, "pointermove", { clientX: 50, clientY: y - 90 });
    fire(svg, "pointerup", { clientX: 50, clientY: y - 90 });
    expect(controller.getSpec().series[0].values[0]!).toBeGreaterThan(12);
    controller.undo();
    expect(controller.getSpec().series[0].values[0]).toBe(12);
  });

  it("edits with the keyboard and can be read-only", () => {
    const controller = new ChartController({ spec: sales });
    controller.select({ kind: "point", seriesId: "north", index: 0 });
    const el = render(ChartCanvas, { controller, responsive: false });
    fire(el.querySelector("svg")!, "keydown", { key: "ArrowUp", shiftKey: true });
    expect(controller.getSpec().series[0].values[0]).toBe(17);
    fire(el.querySelector("svg")!, "keydown", { key: "Delete" });
    expect(controller.getSpec().series[0].values[0]).toBeNull();
    const ro = render(ChartCanvas, { controller, responsive: false, editable: false });
    expect(ro.querySelector("svg")!.getAttribute("tabindex")).toBeNull();
    expect(ro.querySelectorAll('[data-role="selection"]')).toHaveLength(0);
  });
});

describe("ChartDataGrid", () => {
  it("edits values, refuses bad ones and renames series and categories", () => {
    const controller = new ChartController({ spec: sales });
    const el = render(ChartDataGrid, { controller });
    const cell = () => el.querySelector<HTMLInputElement>('[data-cell="north:1"]')!;
    expect(cell().value).toBe("18");
    type(cell(), "1,200", "enter");
    expect(controller.getSpec().series[0].values[1]).toBe(1200);
    type(cell(), "lots");
    expect(controller.getSpec().series[0].values[1]).toBe(1200);
    expect(cell().value).toBe("1200");
    type(el.querySelector<HTMLInputElement>('[aria-label="Series name"]')!, "Northern");
    expect(controller.getSeries("north")!.name).toBe("Northern");
    type(el.querySelector<HTMLInputElement>('[aria-label="Category 1"]')!, "Jan");
    expect(controller.getSpec().categories[0]).toBe("Jan");
  });

  it("selects the focused cell and follows undo", () => {
    const controller = new ChartController({ spec: sales });
    const el = render(ChartDataGrid, { controller });
    const cell = () => el.querySelector<HTMLInputElement>('[data-cell="south:2"]')!;
    cell().dispatchEvent(new FocusEvent("focus"));
    flushSync();
    expect(controller.getState().selection).toEqual({ kind: "point", seriesId: "south", index: 2 });
    controller.setValue("south", 2, 99);
    flushSync();
    expect(cell().value).toBe("99");
    controller.undo();
    flushSync();
    expect(cell().value).toBe("14");
  });

  it("pastes blocks and adds, hides and removes rows and columns", () => {
    const controller = new ChartController({ spec: sales });
    const el = render(ChartDataGrid, { controller });
    const event: any = new Event("paste", { bubbles: true, cancelable: true });
    event.clipboardData = { getData: () => "1\t2\t3\n4\t5\t6" };
    el.querySelector('[data-cell="north:2"]')!.dispatchEvent(event);
    flushSync();
    expect(controller.getSpec().categories).toHaveLength(4);
    expect(controller.getSpec().series).toHaveLength(3);
    expect(controller.getSpec().series[2].values).toEqual([null, null, 3, 6]);
    click(el.querySelector('[data-action="add-category"]'));
    expect(controller.getSpec().categories).toHaveLength(5);
    click(el.querySelector('[data-action="add-series"]'));
    expect(controller.getSpec().series).toHaveLength(4);
    click(el.querySelector('[data-series-id="north"] [data-action="toggle-series"]'));
    expect(controller.getSeries("north")!.hidden).toBe(true);
    click(el.querySelector('[data-series-id="north"] [data-action="remove-series"]'));
    expect(controller.getSeries("north")).toBeUndefined();
    click(el.querySelector('[data-category-index="0"] [data-action="remove-category"]'));
    expect(controller.getSpec().categories[0]).toBe("Q2");
  });
});

describe("ChartInspector", () => {
  it("changes type, titles, stacking, legend and axes", () => {
    const controller = new ChartController({ spec: sales });
    const el = render(ChartInspector, { controller });
    const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector(sel) as T;
    click(q('[data-chart-type="line"]'));
    expect(controller.getSpec().type).toBe("line");
    expect(q('[data-chart-type="line"]').getAttribute("aria-checked")).toBe("true");
    type(q<HTMLInputElement>('[data-option="title"]'), "Revenue");
    expect(controller.getSpec().title).toBe("Revenue");
    type(q<HTMLSelectElement>('[data-option="stacking"]'), "stacked");
    expect(controller.getSpec().stacking).toBe("stacked");
    type(q<HTMLSelectElement>('[data-option="curve"]'), "smooth");
    expect(controller.getSpec().curve).toBe("smooth");
    click(q('[data-option="legend.right"]'));
    expect(controller.getSpec().legend.position).toBe("right");
    type(q<HTMLInputElement>('[data-option="yAxis.max"]'), "50");
    expect(controller.getSpec().yAxis.max).toBe(50);
    type(q<HTMLInputElement>('[data-option="yAxis.min"]'), "60");
    expect(controller.getSpec().yAxis.min).toBeNull();
    expect(q<HTMLInputElement>('[data-option="yAxis.min"]').value).toBe("");
    type(q<HTMLSelectElement>('[data-option="yAxis.format.style"]'), "currency");
    expect(q('[data-option="yAxis.format.currency"]')).not.toBeNull();
    click(q('[data-option="xAxis.gridlines"]'));
    expect(controller.getSpec().xAxis.gridlines).toBe(true);
  });

  it("shows pie options without axes, and the selected series", () => {
    const controller = new ChartController({ spec: { ...sales, type: "donut" } });
    const el = render(ChartInspector, { controller });
    const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector(sel) as T;
    expect(q('[data-section="axis-x"]')).toBeNull();
    expect(q('[data-option="innerRadius"]')).not.toBeNull();
    expect(q('[data-section="series"]')).toBeNull();
    controller.select({ kind: "series", seriesId: "south" });
    controller.setType("bar");
    flushSync();
    expect(q('[data-section="series"]').getAttribute("data-series-id")).toBe("south");
    type(q<HTMLSelectElement>('[data-option="series.type"]'), "line");
    expect(controller.getSeries("south")!.type).toBe("line");
    click(q('[data-action="series-up"]'));
    expect(controller.getSpec().series[0].id).toBe("south");
    click(q('[data-action="series-delete"]'));
    expect(controller.getSeries("south")).toBeUndefined();
    expect(q('[data-section="series"]')).toBeNull();
  });

  it("edits the note, highlight, reference lines and bands, callouts and colour by category", () => {
    const controller = new ChartController({ spec: sales });
    const el = render(ChartInspector, { controller });
    const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector(sel) as T;
    type(q<HTMLInputElement>('[data-option="note"]'), "Source: finance");
    expect(controller.getSpec().note).toBe("Source: finance");
    type(q<HTMLInputElement>('[data-option="highlight"]'), "Q2, South");
    expect(controller.getSpec().highlight).toEqual(["Q2", "South"]);
    type(q<HTMLInputElement>('[data-option="highlight"]'), "Nope");
    expect(controller.getSpec().highlight).toEqual(["Q2", "South"]);
    click(q('[data-option="referenceLine.add"]'));
    expect(controller.getSpec().referenceLines).toEqual([{ value: 12, label: "Average" }]);
    type(q<HTMLInputElement>('[data-option="referenceLine.0.label"]'), "Target");
    type(q<HTMLInputElement>('[data-option="referenceLine.0.value"]'), "15");
    expect(controller.getSpec().referenceLines).toEqual([{ value: 15, label: "Target" }]);
    click(q('[data-option="referenceBand.add"]'));
    type(q<HTMLInputElement>('[data-option="referenceBand.0.to"]'), "20");
    expect(controller.getSpec().referenceBands[0].to).toBe(20);
    click(q('[data-action="reference-band-delete"]'));
    expect(controller.getSpec().referenceBands).toEqual([]);
    expect(q('[data-option="series.callout"]')).toBeNull();
    controller.select({ kind: "point", seriesId: "north", index: 1 });
    flushSync();
    type(q<HTMLInputElement>('[data-option="series.callout"]'), "Best month");
    expect(controller.getSeries("north")!.callouts).toEqual([null, "Best month", null]);
    expect(q('[data-option="varyColors"]')).toBeNull();
    controller.updateSeries("south", { hidden: true });
    flushSync();
    click(q('[data-option="varyColors"]'));
    expect(controller.getSpec().varyColors).toBe(true);
    controller.setType("pie");
    flushSync();
    expect(q('[data-section="annotations"]')).toBeNull();
  });

  it("sets Likert and parliament options", () => {
    const controller = new ChartController({ spec: { ...sales, type: "likert" } });
    const el = render(ChartInspector, { controller });
    const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector(sel) as T;
    type(q<HTMLSelectElement>('[data-option="likertNeutral"]'), "separate");
    type(q<HTMLSelectElement>('[data-option="likertSort"]'), "positive");
    expect(controller.getSpec()).toMatchObject({ likertNeutral: "separate", likertSort: "positive" });
    expect(q('[data-option="parliamentArc"]')).toBeNull();
    controller.setType("parliament");
    flushSync();
    expect(q('[data-option="likertSort"]')).toBeNull();
    type(q<HTMLInputElement>('[data-option="parliamentMajority"]'), "20");
    type(q<HTMLInputElement>('[data-option="parliamentLabel"]'), "MPs");
    expect(controller.getSpec()).toMatchObject({ parliamentMajority: 20, parliamentLabel: "MPs" });
    type(q<HTMLInputElement>('[data-option="parliamentMajority"]'), "");
    expect(controller.getSpec().parliamentMajority).toBeNull();
  });

  it("sets radar rings and grid shape", () => {
    const controller = new ChartController({ spec: { ...sales, type: "radar" } });
    const el = render(ChartInspector, { controller });
    const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector(sel) as T;
    type(q<HTMLInputElement>('[data-option="radarTicks"]'), "4");
    expect(controller.getSpec().radarTicks).toBe(4);
    type(q<HTMLInputElement>('[data-option="radarTicks"]'), "");
    expect(controller.getSpec().radarTicks).toBeNull();
    type(q<HTMLSelectElement>('[data-option="radarGraticule"]'), "circle");
    expect(controller.getSpec().radarGraticule).toBe("circle");
    controller.setType("bar");
    flushSync();
    expect(q('[data-option="radarGraticule"]')).toBeNull();
  });

  it("reverses axes, makes value axes logarithmic and edits error bars", () => {
    const controller = new ChartController({ spec: sales });
    const el = render(ChartInspector, { controller });
    const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector(sel) as T;
    expect(q('[data-option="xAxis.scale"]')).toBeNull();
    click(q('[data-option="yAxis.scale"]'));
    expect(controller.getSpec().yAxis.scale).toBe("log");
    expect(q('[data-option="yAxis.step"]')).toBeNull();
    type(q<HTMLInputElement>('[data-option="yAxis.logBase"]'), "2");
    expect(controller.getSpec().yAxis.logBase).toBe(2);
    type(q<HTMLInputElement>('[data-option="yAxis.logBase"]'), "1");
    expect(controller.getSpec().yAxis.logBase).toBe(2);
    click(q('[data-option="xAxis.reverse"]'));
    expect(controller.getSpec().xAxis.reverse).toBe(true);
    controller.select({ kind: "series", seriesId: "south" });
    flushSync();
    expect(q('[data-option="series.xErrorBars.type"]')).toBeNull();
    type(q<HTMLSelectElement>('[data-option="series.errorBars.type"]'), "percent");
    expect(controller.getSeries("south")!.errorBars).toEqual({ type: "percent" });
    type(q<HTMLInputElement>('[data-option="series.errorBars.value"]'), "12");
    type(q<HTMLSelectElement>('[data-option="series.errorBars.direction"]'), "plus");
    click(q('[data-option="series.errorBars.cap"]'));
    expect(controller.getSeries("south")!.errorBars).toEqual({ type: "percent", value: 12, direction: "plus", cap: false });
    type(q<HTMLSelectElement>('[data-option="series.errorBars.type"]'), "custom");
    expect(controller.getSeries("south")!.errorBars).toMatchObject({ type: "custom", plus: [0.96, 1.32, 1.68] });
    type(q<HTMLInputElement>('[data-option="series.errorBars.plus"]'), "1, -, 2");
    expect(controller.getSeries("south")!.errorBars!.plus).toEqual([1, null, 2]);
    type(q<HTMLInputElement>('[data-option="series.errorBars.minus"]'), "0.5 0.5 0.5");
    expect(controller.getSeries("south")!.errorBars!.minus).toEqual([0.5, 0.5, 0.5]);
    type(q<HTMLSelectElement>('[data-option="series.errorBars.type"]'), "");
    expect(controller.getSeries("south")!.errorBars).toBeUndefined();
    controller.setType("scatter");
    controller.updateSeries("south", { x: [1, 2, 3] });
    flushSync();
    expect(q('[data-option="xAxis.scale"]')).not.toBeNull();
    type(q<HTMLSelectElement>('[data-option="series.xErrorBars.type"]'), "fixed");
    expect(controller.getSeries("south")!.xErrorBars).toEqual({ type: "fixed" });
  });

  it("limits sections", () => {
    const controller = new ChartController({ spec: sales });
    const el = render(ChartInspector, { controller, sections: ["type"] });
    expect(Array.from(el.querySelectorAll("[data-section]")).map((n) => n.getAttribute("data-section"))).toEqual(["type"]);
  });
});

describe("ChartEditor", () => {
  it("combines toolbar, canvas, inspector and grid with undo and issues", () => {
    const controller = new ChartController({ spec: sales });
    const el = render(ChartEditor, { controller, canvasProps: { responsive: false } });
    const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector(sel) as T;
    expect(q("[data-chart-canvas]")).not.toBeNull();
    expect(q("[data-chart-inspector]")).not.toBeNull();
    expect(q("[data-chart-grid]")).not.toBeNull();
    // Side by side, the inspector is taken out of flow so the canvas alone sets the row's height and it scrolls.
    const inspector = q("[data-chart-inspector]");
    expect(inspector.className).toMatch(/md:absolute md:inset-0/);
    expect(inspector.className).toMatch(/overflow-y-auto/);
    expect(inspector.parentElement!.className).toMatch(/\brelative\b/);
    expect(q<HTMLButtonElement>('[data-action="undo"]').disabled).toBe(true);
    click(q('[data-chart-type="area"]'));
    expect(q("[data-chart-canvas] [data-role=area]")).not.toBeNull();
    click(q('[data-action="undo"]'));
    expect(controller.getSpec().type).toBe("bar");
    controller.setValue("north", 0, "nope");
    flushSync();
    expect(q("[data-chart-issues]").textContent).toMatch(/not a number/);
    controller.select({ kind: "axis", axis: "y" });
    flushSync();
    expect(q("[data-chart-selection]").textContent).toBe("Value axis");
  });
});
