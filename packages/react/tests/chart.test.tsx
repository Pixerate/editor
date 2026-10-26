// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { CommandRegistry } from "@pixerate/editor/commands";
import { ChartController, type ChartSpec } from "@pixerate/editor/chart";
import {
  ChartCanvas,
  ChartDataGrid,
  ChartEditor,
  ChartInspector,
  useChartCommands,
  useChartController,
  useChartEditor,
  type UseChartEditorResult,
} from "../src/chart";

let container: HTMLDivElement;
let root: any;
const win = () => globalThis.window as any;

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

const sales: Partial<ChartSpec> = {
  title: "Quarterly sales",
  categories: ["Q1", "Q2", "Q3"],
  series: [
    { id: "north", name: "North", values: [12, 18, 9] },
    { id: "south", name: "South", values: [8, 11, 14] },
  ],
};

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T;
const qa = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[];

async function render(node: React.ReactNode) {
  await act(async () => root.render(node));
}

async function fire(el: Element, type: string, init: any = {}) {
  await act(async () => {
    const Ctor = type.startsWith("pointer") ? (win().PointerEvent ?? win().MouseEvent) : type.startsWith("key") ? win().KeyboardEvent : win().Event;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
  });
}

async function type(input: HTMLInputElement | HTMLSelectElement, value: string, commit: "blur" | "enter" | "change" = "blur") {
  await act(async () => {
    const proto = input instanceof win().HTMLSelectElement ? win().HTMLSelectElement.prototype : win().HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new (win().Event)(input instanceof win().HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
  if (commit === "blur") await act(async () => input.dispatchEvent(new (win().FocusEvent)("focusout", { bubbles: true })));
  if (commit === "enter") await fire(input, "keydown", { key: "Enter" });
}

describe("useChartEditor", () => {
  it("follows the controller and binds actions", async () => {
    let result!: UseChartEditorResult;
    function Probe() {
      result = useChartEditor({ spec: sales });
      return <span data-title>{result.spec.title}</span>;
    }
    await render(<Probe />);
    expect(q("[data-title]").textContent).toBe("Quarterly sales");
    await act(async () => void result.update({ title: "Revenue" }));
    expect(q("[data-title]").textContent).toBe("Revenue");
    await act(async () => result.undo());
    expect(q("[data-title]").textContent).toBe("Quarterly sales");
    await act(async () => result.select({ kind: "legend" }));
    expect(result.selection).toEqual({ kind: "legend" });
  });

  it("registers commands while mounted", async () => {
    const registry = new CommandRegistry();
    let controller!: ChartController;
    function Host() {
      controller = useChartController({ spec: sales });
      useChartCommands(registry, controller, { prefix: "sales." });
      return null;
    }
    await render(<Host />);
    expect(registry.has("sales.describe")).toBe(true);
    await act(async () => void registry.execute("sales.update", { type: "line" }));
    expect(controller.getSpec().type).toBe("line");
    await act(async () => root.render(null));
    expect(registry.has("sales.describe")).toBe(false);
  });
});

describe("ChartCanvas", () => {
  it("draws the scene as SVG and selects what is clicked", async () => {
    const controller = new ChartController({ spec: sales });
    await render(<ChartCanvas controller={controller} width={600} height={360} responsive={false} />);
    expect(qa('[data-role="bar"]')).toHaveLength(6);
    expect(q('[data-role="title"]').textContent).toBe("Quarterly sales");
    await fire(q('[data-chart-key="bar-south-1"]'), "pointerdown", { button: 0, clientX: 0, clientY: 0 });
    await fire(q("svg"), "pointerup");
    expect(controller.getState().selection).toEqual({ kind: "point", seriesId: "south", index: 1 });
    expect(q('[data-chart-key="bar-south-1"]').hasAttribute("data-selected")).toBe(true);
    expect(q("svg").getAttribute("aria-label")).toContain("South · Q2: 11");
    await fire(q('[data-role="background"]'), "pointerdown", { button: 0 });
    expect(controller.getState().selection).toEqual({ kind: "chart" });
  });

  it("drags a bar to change its value as one undo step", async () => {
    const controller = new ChartController({ spec: sales });
    await render(<ChartCanvas controller={controller} width={600} height={360} responsive={false} />);
    // jsdom boxes are empty, so client coordinates are scene coordinates.
    const bar = q<SVGRectElement>('[data-chart-key="bar-north-0"]');
    const y = Number(bar.getAttribute("y"));
    await fire(bar, "pointerdown", { button: 0, clientX: 50, clientY: y });
    await fire(q("svg"), "pointermove", { clientX: 50, clientY: y - 60 });
    await fire(q("svg"), "pointermove", { clientX: 50, clientY: y - 90 });
    await fire(q("svg"), "pointerup", { clientX: 50, clientY: y - 90 });
    const value = controller.getSpec().series[0].values[0]!;
    expect(value).toBeGreaterThan(12);
    controller.undo();
    expect(controller.getSpec().series[0].values[0]).toBe(12);
  });

  it("edits with the keyboard and can be read-only", async () => {
    const controller = new ChartController({ spec: sales });
    controller.select({ kind: "point", seriesId: "north", index: 0 });
    await render(<ChartCanvas controller={controller} responsive={false} />);
    await fire(q("svg"), "keydown", { key: "ArrowUp", shiftKey: true });
    expect(controller.getSpec().series[0].values[0]).toBe(17);
    await fire(q("svg"), "keydown", { key: "Delete" });
    expect(controller.getSpec().series[0].values[0]).toBeNull();
    await render(<ChartCanvas controller={controller} responsive={false} editable={false} />);
    expect(q("svg").getAttribute("tabindex")).toBeNull();
    expect(qa('[data-role="selection"]')).toHaveLength(0);
  });
});

describe("ChartDataGrid", () => {
  it("edits values, refuses bad ones and renames series and categories", async () => {
    const controller = new ChartController({ spec: sales });
    await render(<ChartDataGrid controller={controller} />);
    const cell = q<HTMLInputElement>('[data-cell="north:1"]');
    expect(cell.value).toBe("18");
    await type(cell, "1,200", "enter");
    expect(controller.getSpec().series[0].values[1]).toBe(1200);
    expect(q<HTMLInputElement>('[data-cell="north:1"]').value).toBe("1200");
    await type(q<HTMLInputElement>('[data-cell="north:1"]'), "lots");
    expect(controller.getSpec().series[0].values[1]).toBe(1200);
    expect(q<HTMLInputElement>('[data-cell="north:1"]').value).toBe("1200");
    await type(q<HTMLInputElement>('[aria-label="Series name"]'), "Northern");
    expect(controller.getSeries("north")!.name).toBe("Northern");
    await type(q<HTMLInputElement>('[aria-label="Category 1"]'), "Jan");
    expect(controller.getSpec().categories[0]).toBe("Jan");
  });

  it("selects the focused cell and follows undo", async () => {
    const controller = new ChartController({ spec: sales });
    await render(<ChartDataGrid controller={controller} />);
    await act(async () => q<HTMLInputElement>('[data-cell="south:2"]').focus());
    expect(controller.getState().selection).toEqual({ kind: "point", seriesId: "south", index: 2 });
    await act(async () => void controller.setValue("south", 2, 99));
    expect(q<HTMLInputElement>('[data-cell="south:2"]').value).toBe("99");
    await act(async () => void controller.undo());
    expect(q<HTMLInputElement>('[data-cell="south:2"]').value).toBe("14");
  });

  it("pastes blocks and adds, hides and removes rows and columns", async () => {
    const controller = new ChartController({ spec: sales });
    await render(<ChartDataGrid controller={controller} />);
    await act(async () => {
      const event = new (win().Event)("paste", { bubbles: true, cancelable: true });
      event.clipboardData = { getData: () => "1\t2\t3\n4\t5\t6" };
      q('[data-cell="north:2"]').dispatchEvent(event);
    });
    expect(controller.getSpec().categories).toHaveLength(4);
    expect(controller.getSpec().series).toHaveLength(3);
    expect(controller.getSpec().series[2].values).toEqual([null, null, 3, 6]);
    await act(async () => q('[data-action="add-category"]').click());
    expect(controller.getSpec().categories).toHaveLength(5);
    await act(async () => q('[data-action="add-series"]').click());
    expect(controller.getSpec().series).toHaveLength(4);
    await act(async () => q('[data-series-id="north"] [data-action="toggle-series"]').click());
    expect(controller.getSeries("north")!.hidden).toBe(true);
    await act(async () => q('[data-series-id="north"] [data-action="remove-series"]').click());
    expect(controller.getSeries("north")).toBeUndefined();
    await act(async () => q('[data-category-index="0"] [data-action="remove-category"]').click());
    expect(controller.getSpec().categories[0]).toBe("Q2");
  });
});

describe("ChartInspector", () => {
  it("changes type, titles, stacking, legend and axes", async () => {
    const controller = new ChartController({ spec: sales });
    await render(<ChartInspector controller={controller} />);
    await act(async () => q('[data-chart-type="line"]').click());
    expect(controller.getSpec().type).toBe("line");
    expect(q('[data-chart-type="line"]').getAttribute("aria-checked")).toBe("true");
    await type(q<HTMLInputElement>('[data-option="title"]'), "Revenue");
    expect(controller.getSpec().title).toBe("Revenue");
    await type(q<HTMLSelectElement>('[data-option="stacking"]'), "stacked");
    expect(controller.getSpec().stacking).toBe("stacked");
    await type(q<HTMLSelectElement>('[data-option="curve"]'), "smooth");
    expect(controller.getSpec().curve).toBe("smooth");
    await act(async () => q('[data-option="legend.right"]').click());
    expect(controller.getSpec().legend.position).toBe("right");
    await type(q<HTMLInputElement>('[data-option="yAxis.max"]'), "50");
    expect(controller.getSpec().yAxis.max).toBe(50);
    await type(q<HTMLInputElement>('[data-option="yAxis.min"]'), "60");
    expect(controller.getSpec().yAxis.min).toBeNull();
    expect(q<HTMLInputElement>('[data-option="yAxis.min"]').value).toBe("");
    await type(q<HTMLSelectElement>('[data-option="yAxis.format.style"]'), "currency");
    expect(q('[data-option="yAxis.format.currency"]')).not.toBeNull();
    await act(async () => q<HTMLInputElement>('[data-option="xAxis.gridlines"]').click());
    expect(controller.getSpec().xAxis.gridlines).toBe(true);
  });

  it("shows pie options without axes, and the selected series", async () => {
    const controller = new ChartController({ spec: { ...sales, type: "donut" } });
    await render(<ChartInspector controller={controller} />);
    expect(q('[data-section="axis-x"]')).toBeNull();
    expect(q('[data-option="innerRadius"]')).not.toBeNull();
    expect(q('[data-section="series"]')).toBeNull();
    await act(async () => controller.select({ kind: "series", seriesId: "south" }));
    await act(async () => controller.setType("bar"));
    expect(q('[data-section="series"]').getAttribute("data-series-id")).toBe("south");
    await type(q<HTMLSelectElement>('[data-option="series.type"]'), "line");
    expect(controller.getSeries("south")!.type).toBe("line");
    await act(async () => q('[data-action="series-up"]').click());
    expect(controller.getSpec().series[0].id).toBe("south");
    await act(async () => q('[data-action="series-delete"]').click());
    expect(controller.getSeries("south")).toBeUndefined();
    expect(q('[data-section="series"]')).toBeNull();
  });

  it("edits the note, highlight, reference lines and bands, callouts and colour by category", async () => {
    const controller = new ChartController({ spec: sales });
    await render(<ChartInspector controller={controller} />);
    await type(q<HTMLInputElement>('[data-option="note"]'), "Source: finance");
    expect(controller.getSpec().note).toBe("Source: finance");
    await type(q<HTMLInputElement>('[data-option="highlight"]'), "Q2, South");
    expect(controller.getSpec().highlight).toEqual(["Q2", "South"]);
    await type(q<HTMLInputElement>('[data-option="highlight"]'), "Nope");
    expect(controller.getSpec().highlight).toEqual(["Q2", "South"]);
    await act(async () => q('[data-option="referenceLine.add"]').click());
    expect(controller.getSpec().referenceLines).toEqual([{ value: 12, label: "Average" }]);
    await type(q<HTMLInputElement>('[data-option="referenceLine.0.label"]'), "Target");
    await type(q<HTMLInputElement>('[data-option="referenceLine.0.value"]'), "15");
    expect(controller.getSpec().referenceLines).toEqual([{ value: 15, label: "Target" }]);
    await act(async () => q('[data-option="referenceBand.add"]').click());
    await type(q<HTMLInputElement>('[data-option="referenceBand.0.to"]'), "20");
    expect(controller.getSpec().referenceBands[0].to).toBe(20);
    await act(async () => q('[data-action="reference-band-delete"]').click());
    expect(controller.getSpec().referenceBands).toEqual([]);
    // A callout field appears for the selected point.
    expect(q('[data-option="series.callout"]')).toBeNull();
    await act(async () => controller.select({ kind: "point", seriesId: "north", index: 1 }));
    await type(q<HTMLInputElement>('[data-option="series.callout"]'), "Best month");
    expect(controller.getSeries("north")!.callouts).toEqual([null, "Best month", null]);
    // Colour by category needs exactly one visible series.
    expect(q('[data-option="varyColors"]')).toBeNull();
    await act(async () => controller.updateSeries("south", { hidden: true }));
    await act(async () => q<HTMLInputElement>('[data-option="varyColors"]').click());
    expect(controller.getSpec().varyColors).toBe(true);
    await act(async () => controller.setType("pie"));
    expect(q('[data-section="annotations"]')).toBeNull();
  });

  it("sets radar rings and grid shape", async () => {
    const controller = new ChartController({ spec: { ...sales, type: "radar" } });
    await render(<ChartInspector controller={controller} />);
    await type(q<HTMLInputElement>('[data-option="radarTicks"]'), "4");
    expect(controller.getSpec().radarTicks).toBe(4);
    await type(q<HTMLInputElement>('[data-option="radarTicks"]'), "");
    expect(controller.getSpec().radarTicks).toBeNull();
    await type(q<HTMLSelectElement>('[data-option="radarGraticule"]'), "circle");
    expect(controller.getSpec().radarGraticule).toBe("circle");
    await act(async () => controller.setType("bar"));
    expect(q('[data-option="radarGraticule"]')).toBeNull();
  });

  it("reverses axes, makes value axes logarithmic and edits error bars", async () => {
    const controller = new ChartController({ spec: sales });
    await render(<ChartInspector controller={controller} />);
    expect(q('[data-option="xAxis.scale"]')).toBeNull();
    await act(async () => q<HTMLInputElement>('[data-option="yAxis.scale"]').click());
    expect(controller.getSpec().yAxis.scale).toBe("log");
    expect(q('[data-option="yAxis.step"]')).toBeNull();
    await type(q<HTMLInputElement>('[data-option="yAxis.logBase"]'), "2");
    expect(controller.getSpec().yAxis.logBase).toBe(2);
    await type(q<HTMLInputElement>('[data-option="yAxis.logBase"]'), "1");
    expect(controller.getSpec().yAxis.logBase).toBe(2);
    await act(async () => q<HTMLInputElement>('[data-option="xAxis.reverse"]').click());
    expect(controller.getSpec().xAxis.reverse).toBe(true);
    await act(async () => controller.select({ kind: "series", seriesId: "south" }));
    expect(q('[data-option="series.xErrorBars.type"]')).toBeNull();
    await type(q<HTMLSelectElement>('[data-option="series.errorBars.type"]'), "percent");
    expect(controller.getSeries("south")!.errorBars).toEqual({ type: "percent" });
    await type(q<HTMLInputElement>('[data-option="series.errorBars.value"]'), "12");
    await type(q<HTMLSelectElement>('[data-option="series.errorBars.direction"]'), "plus");
    await act(async () => q<HTMLInputElement>('[data-option="series.errorBars.cap"]').click());
    expect(controller.getSeries("south")!.errorBars).toEqual({ type: "percent", value: 12, direction: "plus", cap: false });
    await type(q<HTMLSelectElement>('[data-option="series.errorBars.type"]'), "custom");
    expect(controller.getSeries("south")!.errorBars).toMatchObject({ type: "custom", plus: [0.96, 1.32, 1.68] });
    await type(q<HTMLInputElement>('[data-option="series.errorBars.plus"]'), "1, -, 2");
    expect(controller.getSeries("south")!.errorBars!.plus).toEqual([1, null, 2]);
    await type(q<HTMLInputElement>('[data-option="series.errorBars.minus"]'), "0.5 0.5 0.5");
    expect(controller.getSeries("south")!.errorBars!.minus).toEqual([0.5, 0.5, 0.5]);
    await type(q<HTMLSelectElement>('[data-option="series.errorBars.type"]'), "");
    expect(controller.getSeries("south")!.errorBars).toBeUndefined();
    await act(async () => controller.setType("scatter"));
    await act(async () => controller.updateSeries("south", { x: [1, 2, 3] }));
    expect(q('[data-option="xAxis.scale"]')).not.toBeNull();
    await type(q<HTMLSelectElement>('[data-option="series.xErrorBars.type"]'), "fixed");
    expect(controller.getSeries("south")!.xErrorBars).toEqual({ type: "fixed" });
  });

  it("limits sections", async () => {
    const controller = new ChartController({ spec: sales });
    await render(<ChartInspector controller={controller} sections={["type"]} />);
    expect(qa("[data-section]").map((el) => el.getAttribute("data-section"))).toEqual(["type"]);
  });
});

describe("ChartEditor", () => {
  it("combines toolbar, canvas, inspector and grid with undo and issues", async () => {
    const controller = new ChartController({ spec: sales });
    await render(<ChartEditor controller={controller} canvasProps={{ responsive: false }} />);
    expect(q("[data-chart-canvas]")).not.toBeNull();
    expect(q("[data-chart-inspector]")).not.toBeNull();
    expect(q("[data-chart-grid]")).not.toBeNull();
    // Side by side, the inspector is taken out of flow so the canvas alone sets the row's height and it scrolls.
    const inspector = q("[data-chart-inspector]");
    expect(inspector.className).toMatch(/md:absolute md:inset-0/);
    expect(inspector.className).toMatch(/overflow-y-auto/);
    expect(inspector.parentElement!.className).toMatch(/\brelative\b/);
    expect((q('[data-action="undo"]') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => q('[data-chart-type="area"]').click());
    expect(q("[data-chart-canvas] [data-role=area]")).not.toBeNull();
    await act(async () => q('[data-action="undo"]').click());
    expect(controller.getSpec().type).toBe("bar");
    await act(async () => void controller.setValue("north", 0, "nope"));
    expect(q("[data-chart-issues]").textContent).toMatch(/not a number/);
    await act(async () => controller.select({ kind: "axis", axis: "y" }));
    expect(q("[data-chart-selection]").textContent).toBe("Value axis");
  });
});
