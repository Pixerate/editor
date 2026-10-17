import { describe, it, expect, afterEach, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ToolRegistry } from "@pixerate/editor/tools";
import { ChartController, ChartPresence, type ChartSpec } from "@pixerate/editor/chart";
import { ChartCanvas, ChartEditor, ChartInspector, ChartSparkline, ChartStreamingView, createChartDirector, useChartToolProvider } from "../src/chart";

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
const choose = (el: HTMLSelectElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
};

describe("ChartCanvas extras", () => {
  it("cancels a drag with Escape and shows a readout while dragging", () => {
    const controller = new ChartController({ spec: sales });
    const target = render(ChartCanvas, { controller, width: 600, height: 360, responsive: false });
    const bar = target.querySelector('[data-chart-key="bar-north-0"]')!;
    const y = Number(bar.getAttribute("y"));
    fire(bar, "pointerdown", { button: 0, clientX: 50, clientY: y });
    fire(target.querySelector("svg")!, "pointermove", { clientX: 50, clientY: y - 80 });
    expect(controller.getSpec().series[0].values[0]).toBeGreaterThan(12);
    expect(target.querySelector('[data-role="drag-readout"]')).not.toBeNull();
    fire(target.querySelector("svg")!, "keydown", { key: "Escape" });
    expect(controller.getSpec().series[0].values[0]).toBe(12);
    expect(controller.getState().canUndo).toBe(false);
    expect(target.querySelector('[data-role="drag-readout"]')).toBeNull();
  });

  it("draws agent cursors from a presence store", () => {
    const controller = new ChartController({ spec: sales });
    const presence = new ChartPresence();
    const target = render(ChartCanvas, { controller, responsive: false, presence });
    presence.set({ id: "claude", name: "Claude", x: 40, y: 50, message: "Raising Q1" });
    flushSync();
    const actor = target.querySelector('[data-actor="claude"]')!;
    expect(actor.getAttribute("transform")).toBe("translate(40 50)");
    expect(actor.textContent?.trim()).toBe("Raising Q1");
  });
});

describe("ChartInspector extras", () => {
  it("adds trendlines, moves series to the secondary axis, applies presets and transposes", () => {
    const controller = new ChartController({ spec: { ...sales, type: "line" } });
    controller.select({ kind: "series", seriesId: "north" });
    const target = render(ChartInspector, { controller });
    choose(target.querySelector('[data-option="trendline.add"]')!, "linear");
    expect(controller.getSeries("north")!.trendlines).toEqual([{ type: "linear" }]);
    expect(target.querySelector('[data-trendline="0"]')!.textContent).toContain("Linear (North)");
    (target.querySelector('[data-option="series.axis"]') as HTMLInputElement).click();
    flushSync();
    expect(controller.getSeries("north")!.axis).toBe("secondary");
    expect(target.querySelector('[data-section="axis-y2"]')).not.toBeNull();
    choose(target.querySelector('[data-option="preset.colors"]')!, "monochrome-green");
    expect(controller.getSpec().palette[0]).not.toBe("#4269d0");
    (target.querySelector('[data-action="transpose"]') as HTMLButtonElement).click();
    flushSync();
    expect(controller.getSpec().categories).toEqual(["North", "South"]);
  });
});

describe("ChartStreamingView and ChartSparkline", () => {
  it("draws a chart while its Mermaid source arrives", () => {
    const issues: unknown[][] = [];
    const props = $state({ source: "xychart-be", complete: false, tween: 0, adoptInterval: 0, onissues: (i: unknown[]) => issues.push(i) });
    const target = render(ChartStreamingView, props);
    expect(target.querySelector("[data-chart-streaming]")!.textContent).toBe("Drawing chart…");
    props.source = 'xychart-beta\n  x-axis [a, b]\n  bar "S" [3,';
    flushSync();
    expect(target.querySelectorAll('[data-role="bar"]')).toHaveLength(1);
    props.source = 'xychart-beta\n  x-axis [a, b]\n  bar "S" [3, 4]\n  oops';
    props.complete = true;
    flushSync();
    expect(target.querySelectorAll('[data-role="bar"]')).toHaveLength(2);
    expect(target.querySelector("[data-chart-streaming]")!.getAttribute("data-chart-streaming")).toBe("complete");
    expect((issues[issues.length - 1][0] as any).line).toBe(4);
  });

  it("draws a sparkline with an accessible label", () => {
    const target = render(ChartSparkline, { values: [1, 3, 2], highLow: true });
    expect(target.querySelector("svg")!.getAttribute("aria-label")).toBe("Trend from 1 to 2");
    expect(target.querySelectorAll("circle")).toHaveLength(2);
  });
});

describe("chart agent helpers", () => {
  it("registers chart tools for the component's lifetime and acts edits out", async () => {
    const registry = new ToolRegistry();
    const controller = new ChartController({ spec: sales });
    const cleanup = $effect.root(() => {
      const { director } = createChartDirector(controller, { speed: 1000 });
      useChartToolProvider(registry, controller, { director });
    });
    flushSync();
    expect(registry.listTools().tools.map((t) => t.name)).toContain("set_chart_values");
    const result: any = await registry.callTool("set_chart_values", { cells: [{ series: "north", category: "Q1", value: 30 }] });
    expect(result.isError).toBeFalsy();
    expect(controller.getSpec().series[0].values[0]).toBe(30);
    cleanup();
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
    let cleanup = $effect.root(() => useChartToolProvider(registry, controller));
    flushSync();
    let result: any = await registry.callTool("render_chart", { format: "png", width: 320, height: 200 });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
    expect(result.content[1].text).toMatch(/^Chart at 320 × 200/);
    expect(result.structuredContent.warnings).toEqual(expect.any(Array));
    expect(canvas.loaded[0]).toMatch(/^<svg/);
    expect(canvas.loaded[0]).not.toContain("var(");
    cleanup();
    cleanup = $effect.root(() => useChartToolProvider(registry, controller, { rasterize: false }));
    flushSync();
    result = await registry.callTool("render_chart", { format: "png" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/cannot rasterize/);
    cleanup();
  });

  it("downloads a PNG from the ChartEditor toolbar", async () => {
    const canvas = stubCanvas();
    const controller = new ChartController({ spec: sales });
    const el = render(ChartEditor, { controller, canvasProps: { responsive: false }, pngOptions: { filename: "sales.png" } });
    const button = el.querySelector('[data-action="download-png"]') as HTMLButtonElement;
    expect(button.textContent).toBe("Download PNG");
    button.click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(canvas.downloads).toEqual(["sales.png"]);
    expect(canvas.loaded[0]).toContain("Quarterly sales");
    expect(el.querySelector("[data-chart-png-error]")).toBeNull();
  });
});
