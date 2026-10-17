// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CSS_VARIABLE_CHART_THEME,
  chartFileName,
  chartRasterSize,
  chartToSvg,
  createChartSpec,
  createChartRasterizer,
  downloadChartPng,
  rasterizeChartSvg,
  resolveChartSvgPaints,
  type ChartSpec,
} from "../src/chart";

const spec: ChartSpec = createChartSpec({
  type: "bar",
  title: "Revenue 2026 / Q1",
  categories: ["Jan", "Feb"],
  series: [{ id: "a", name: "A", values: [1, 2] }],
});

/** jsdom has no canvas or image decoding: record what is drawn and hand back a fixed PNG. */
function stubCanvas(options: { failLoad?: boolean; noContext?: boolean } = {}) {
  const drawn: { src: string; width: number; height: number; fill?: string }[] = [];
  const loaded: string[] = [];
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      loaded.push(value);
      queueMicrotask(() => (options.failLoad ? this.onerror?.() : this.onload?.()));
    }
  }
  vi.stubGlobal("Image", FakeImage);
  vi.spyOn(window, "Image", "get").mockReturnValue(FakeImage as never);
  const context = {
    fillStyle: "",
    fillRect: vi.fn(function (this: { fillStyle: string }) {
      drawn.push({ src: "fill", width: 0, height: 0, fill: this.fillStyle });
    }),
    drawImage: vi.fn((_: unknown, _x: number, _y: number, width: number, height: number) => drawn.push({ src: loaded[loaded.length - 1], width, height })),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => (options.noContext ? null : context)) as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,iVBORw0KGgo=");
  return { drawn, loaded, svgDrawn: () => decodeURIComponent(loaded[loaded.length - 1].slice(loaded[loaded.length - 1].indexOf(",") + 1)) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("style");
});

describe("chartRasterSize", () => {
  it("draws at the scale with the longest side bounded", () => {
    expect(chartRasterSize(300, 200)).toEqual({ width: 600, height: 400, scale: 2 });
    expect(chartRasterSize(640, 400)).toEqual({ width: 1024, height: 640, scale: 1.6 });
    expect(chartRasterSize(640, 400, 1)).toEqual({ width: 640, height: 400, scale: 1 });
    expect(chartRasterSize(400, 2000, 2, 500)).toEqual({ width: 100, height: 500, scale: 0.25 });
    expect(() => chartRasterSize(0, 10)).toThrow(/positive width and height/);
  });
});

describe("resolveChartSvgPaints", () => {
  it("replaces CSS variables with the scope's values or the fallbacks", () => {
    const lookup = (name: string) => ({ "--foreground": " #111111 ", "--brand": "var(--foreground)" })[name] ?? "";
    const svg = '<svg><text fill="var(--foreground, #0f172a)" stroke="var(--brand)">var(--not-a-paint)</text><line stroke="var(--border, #e2e8f0)"/><rect fill="var(--missing)"/></svg>';
    const out = resolveChartSvgPaints(svg, { lookup });
    expect(out).toBe('<svg><text fill="#111111" stroke="#111111">var(--not-a-paint)</text><line stroke="#e2e8f0"/><rect/></svg>');
  });

  it("handles nested fallbacks and colour functions", () => {
    const out = resolveChartSvgPaints('<path fill="color-mix(in srgb, var(--a, var(--b, rgb(1, 2, 3))) 50%, white)"/>', { lookup: () => "" });
    expect(out).toBe('<path fill="color-mix(in srgb, rgb(1, 2, 3) 50%, white)"/>');
  });

  it("reads custom properties, colour and font from the scope element", () => {
    const scope = document.createElement("div");
    scope.style.setProperty("--foreground", "#123456");
    scope.style.color = "rgb(10, 20, 30)";
    scope.style.fontFamily = "Inter, sans-serif";
    document.body.appendChild(scope);
    const out = resolveChartSvgPaints('<svg><text fill="var(--foreground, #000)" stroke="currentColor" font-family="inherit">x</text></svg>', { scope });
    expect(out).toContain('fill="#123456"');
    expect(out).toContain('stroke="rgb(10, 20, 30)"');
    expect(out).toContain("font-family=\"Inter, sans-serif\"");
    scope.remove();
  });

  it("leaves no var( in a chart laid out with the CSS-variable theme", () => {
    const svg = chartToSvg(spec, { width: 400, height: 300, theme: CSS_VARIABLE_CHART_THEME });
    expect(svg).toContain("var(");
    const out = resolveChartSvgPaints(svg);
    expect(out).not.toContain("var(");
    expect(out).not.toMatch(/font-family="inherit"/);
    expect(out).toContain('fill="#0f172a"');
  });
});

describe("rasterizeChartSvg", () => {
  it("resolves paints, draws at the bounded size and returns base64 PNG", async () => {
    const canvas = stubCanvas();
    document.documentElement.style.setProperty("--foreground", "#abcdef");
    const svg = chartToSvg(spec, { width: 640, height: 400, theme: CSS_VARIABLE_CHART_THEME });
    const image = await rasterizeChartSvg(svg, { width: 640, height: 400 });
    expect(image).toEqual({ data: "iVBORw0KGgo=", mimeType: "image/png", width: 1024, height: 640 });
    expect(canvas.loaded[0]).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    const drawn = canvas.svgDrawn();
    expect(drawn).not.toContain("var(");
    expect(drawn).toContain('fill="#abcdef"');
    expect(canvas.drawn[0]).toMatchObject({ fill: "#ffffff" });
    expect(canvas.drawn[1]).toMatchObject({ width: 1024, height: 640 });
  });

  it("keeps transparency when asked", async () => {
    const canvas = stubCanvas();
    await rasterizeChartSvg("<svg xmlns='http://www.w3.org/2000/svg'/>", { width: 10, height: 10, background: "transparent", scale: 1 });
    expect(canvas.drawn).toHaveLength(1);
    expect(canvas.drawn[0]).toMatchObject({ width: 10, height: 10 });
  });

  it("errors usefully without a canvas or when the SVG does not load", async () => {
    stubCanvas({ noContext: true });
    await expect(rasterizeChartSvg("<svg/>", { width: 10, height: 10 })).rejects.toThrow(/needs a browser DOM.*chartToSvg/);
    vi.restoreAllMocks();
    stubCanvas({ failLoad: true });
    await expect(rasterizeChartSvg("<svg/>", { width: 10, height: 10 })).rejects.toThrow(/could not be loaded as an image/);
  });

  it("errors usefully without a document", async () => {
    vi.stubGlobal("document", undefined);
    await expect(rasterizeChartSvg("<svg/>", { width: 10, height: 10 })).rejects.toThrow(/needs a browser DOM/);
    expect(createChartRasterizer()).toBeUndefined();
  });
});

describe("createChartRasterizer and downloadChartPng", () => {
  it("makes a rasterize function for the tool provider", async () => {
    stubCanvas();
    const rasterize = createChartRasterizer({ scale: 1 })!;
    expect(await rasterize(chartToSvg(spec, { width: 300, height: 200 }), { width: 300, height: 200 })).toMatchObject({ mimeType: "image/png", width: 300, height: 200 });
  });

  it("names the file after the title and clicks a download link", async () => {
    stubCanvas();
    expect(chartFileName({ title: "" }, "png")).toBe("chart.png");
    const clicks: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download });
    });
    const result = await downloadChartPng(spec);
    expect(result).toMatchObject({ filename: "revenue-2026-q1.png", width: 1024, height: 576, mimeType: "image/png" });
    expect(clicks).toEqual([{ href: "data:image/png;base64,iVBORw0KGgo=", download: "revenue-2026-q1.png" }]);
    expect(document.querySelector("a[download]")).toBeNull();
  });
});
