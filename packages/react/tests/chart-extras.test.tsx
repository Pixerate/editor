// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ToolRegistry } from "@pixerate/editor/tools";
import { ChartController, ChartPresence, type ChartSpec } from "@pixerate/editor/chart";
import { ChartCanvas, ChartEditor, ChartInspector, ChartSparkline, ChartStreamingView, useChartDirector, useChartToolProvider } from "../src/chart";

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
/** jsdom has no canvas or image decoding: stub them and record the SVG handed to the image. */
function stubCanvas() {
  const loaded: string[] = [];
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      loaded.push(decodeURIComponent(value.slice(value.indexOf(",") + 1)));
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", FakeImage);
  vi.spyOn(window, "Image", "get").mockReturnValue(FakeImage as never);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillStyle: "", fillRect() {}, drawImage() {} } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,iVBORw0KGgo=");
  const downloads: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
  return { loaded, downloads };
}

const render = async (node: React.ReactNode) => act(async () => root.render(node));
async function fire(el: Element, type: string, init: any = {}) {
  await act(async () => {
    const Ctor = type.startsWith("pointer") ? (win().PointerEvent ?? win().MouseEvent) : type.startsWith("key") ? win().KeyboardEvent : win().Event;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
  });
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(win().HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new (win().Event)("change", { bubbles: true }));
  });
}

describe("ChartCanvas extras", () => {
  it("cancels a drag with Escape and shows a readout while dragging", async () => {
    const controller = new ChartController({ spec: sales });
    await render(<ChartCanvas controller={controller} width={600} height={360} responsive={false} />);
    const bar = q<SVGRectElement>('[data-chart-key="bar-north-0"]');
    const y = Number(bar.getAttribute("y"));
    await fire(bar, "pointerdown", { button: 0, clientX: 50, clientY: y });
    await fire(q("svg"), "pointermove", { clientX: 50, clientY: y - 80 });
    expect(controller.getSpec().series[0].values[0]).toBeGreaterThan(12);
    expect(q('[data-role="drag-readout"]')).not.toBeNull();
    await fire(q("svg"), "keydown", { key: "Escape" });
    expect(controller.getSpec().series[0].values[0]).toBe(12);
    expect(controller.getState().canUndo).toBe(false);
    expect(q('[data-role="drag-readout"]')).toBeNull();
  });

  it("draws agent cursors from a presence store", async () => {
    const controller = new ChartController({ spec: sales });
    const presence = new ChartPresence();
    await render(<ChartCanvas controller={controller} responsive={false} presence={presence} />);
    await act(async () => presence.set({ id: "claude", name: "Claude", x: 40, y: 50, message: "Raising Q1" }));
    const actor = q('[data-actor="claude"]');
    expect(actor.getAttribute("transform")).toBe("translate(40 50)");
    expect(actor.textContent).toBe("Raising Q1");
  });
});

describe("ChartInspector extras", () => {
  it("adds trendlines, moves series to the secondary axis, applies presets and transposes", async () => {
    const controller = new ChartController({ spec: { ...sales, type: "line" } });
    controller.select({ kind: "series", seriesId: "north" });
    await render(<ChartInspector controller={controller} />);
    await choose(q<HTMLSelectElement>('[data-option="trendline.add"]'), "linear");
    expect(controller.getSeries("north")!.trendlines).toEqual([{ type: "linear" }]);
    // The new trendline is selected; its series stays in the inspector.
    expect(controller.getState().selection).toEqual({ kind: "trendline", seriesId: "north", index: 0 });
    expect(q('[data-trendline="0"]').textContent).toContain("Linear (North)");
    await act(async () => q<HTMLInputElement>('[data-option="series.axis"]').click());
    expect(controller.getSeries("north")!.axis).toBe("secondary");
    expect(q('[data-section="axis-y2"]')).not.toBeNull();
    await choose(q<HTMLSelectElement>('[data-option="preset.colors"]'), "monochrome-green");
    expect(controller.getSpec().palette[0]).not.toBe("#4269d0");
    await act(async () => q('[data-action="transpose"]').click());
    expect(controller.getSpec().categories).toEqual(["North", "South"]);
  });
});

describe("ChartStreamingView and ChartSparkline", () => {
  it("draws a chart while its Mermaid source arrives and reports problems when complete", async () => {
    let issues: unknown[] | null = null;
    const onIssues = (i: unknown[]) => (issues = i);
    await render(<ChartStreamingView source="xychart-be" tween={0} adoptInterval={0} onIssues={onIssues} />);
    expect(q("[data-chart-streaming]").textContent).toBe("Drawing chart…");
    await render(<ChartStreamingView source={'xychart-beta\n  x-axis [a, b]\n  bar "S" [3,'} tween={0} adoptInterval={0} onIssues={onIssues} />);
    expect(container.querySelectorAll('[data-role="bar"]')).toHaveLength(1);
    expect(issues).toBeNull();
    await render(<ChartStreamingView source={'xychart-beta\n  x-axis [a, b]\n  bar "S" [3, 4]\n  oops'} complete tween={0} adoptInterval={0} onIssues={onIssues} />);
    expect(container.querySelectorAll('[data-role="bar"]')).toHaveLength(2);
    expect(q("[data-chart-streaming]").getAttribute("data-chart-streaming")).toBe("complete");
    expect((issues as any)[0].line).toBe(4);
  });

  it("draws a sparkline with an accessible label", async () => {
    await render(<ChartSparkline values={[1, 3, 2]} highLow />);
    expect(q("svg").getAttribute("aria-label")).toBe("Trend from 1 to 2");
    expect(container.querySelectorAll("circle")).toHaveLength(2);
  });
});

describe("chart agent hooks", () => {
  it("registers chart tools while mounted and acts edits out through the director", async () => {
    const registry = new ToolRegistry();
    let controller!: ChartController;
    function Host() {
      controller = React.useMemo(() => new ChartController({ spec: sales }), []);
      const { presence, director, sceneRef } = useChartDirector(controller, { speed: 1000 });
      useChartToolProvider(registry, controller, { director });
      return <ChartCanvas controller={controller} responsive={false} presence={presence} sceneRef={sceneRef} />;
    }
    await render(<Host />);
    expect(registry.listTools().tools.map((t) => t.name)).toContain("set_chart_values");
    let result: any;
    await act(async () => {
      result = await registry.callTool("set_chart_values", { cells: [{ series: "north", category: "Q1", value: 30 }] });
    });
    expect(result.isError).toBeFalsy();
    expect(controller.getSpec().series[0].values[0]).toBe(30);
    await render(null);
    expect(registry.listTools().tools).toHaveLength(0);
  });
});

describe("chart PNG previews", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rasterizes render_chart by default in the browser, with the warnings", async () => {
    const canvas = stubCanvas();
    const registry = new ToolRegistry();
    const controller = new ChartController({ spec: sales });
    function Host({ rasterize }: { rasterize?: false }) {
      useChartToolProvider(registry, controller, { rasterize });
      return null;
    }
    await render(<Host />);
    let result: any;
    await act(async () => {
      result = await registry.callTool("render_chart", { format: "png", width: 320, height: 200 });
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
    expect(result.content[1].text).toMatch(/^Chart at 320 × 200/);
    expect(result.structuredContent.warnings).toEqual(expect.any(Array));
    expect(canvas.loaded[0]).toMatch(/^<svg/);
    expect(canvas.loaded[0]).not.toContain("var(");
    await render(null);
    await render(<Host rasterize={false} />);
    await act(async () => {
      result = await registry.callTool("render_chart", { format: "png" });
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/cannot rasterize/);
  });

  it("downloads a PNG from the ChartEditor toolbar", async () => {
    const canvas = stubCanvas();
    const controller = new ChartController({ spec: sales });
    await render(<ChartEditor controller={controller} canvasProps={{ responsive: false }} pngOptions={{ filename: "sales.png" }} />);
    const button = container.querySelector('[data-action="download-png"]') as HTMLButtonElement;
    expect(button.textContent).toBe("Download PNG");
    await act(async () => {
      button.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(canvas.downloads).toEqual(["sales.png"]);
    expect(canvas.loaded[0]).toContain("Quarterly sales");
    expect(container.querySelector("[data-chart-png-error]")).toBeNull();
  });
});
