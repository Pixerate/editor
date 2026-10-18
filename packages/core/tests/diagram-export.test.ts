// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../src/tools";
import { DiagramController, createDiagramToolProvider, parseMermaid } from "../src/diagram";
import {
  DIAGRAM_SVG_DARK_THEME,
  diagramFileName,
  mermaidThumbnailSvg,
  mermaidToCanvas,
  mermaidToSvg,
  rasterSize,
  rasterizeSvg,
} from "../src/canvas";

const SOURCE = `---
title: Order flow
---
flowchart LR
  A[Start & go] --> B{Ok?}
  B -- "yes <b>now</b>" --> C(Ship)
  B -.-> D((Retry))
  subgraph S [Warehouse]
    C
  end
  style A fill:#fde68a,stroke:#b45309
`;

const parse = (svg: string) => new DOMParser().parseFromString(svg, "image/svg+xml");

describe("mermaidToSvg", () => {
  it("draws groups, shaped nodes, labels and edges as well-formed SVG", () => {
    const doc = parseMermaid(SOURCE);
    const { svg, width, height, naturalWidth } = mermaidToSvg(doc);
    const dom = parse(svg);
    expect(dom.querySelector("parsererror")).toBeNull();
    const root = dom.documentElement;
    expect(root.getAttribute("viewBox")).toBe(`0 0 ${naturalWidth} ${height}`);
    expect(width).toBe(naturalWidth);
    expect(root.querySelector("title")!.textContent).toBe("Order flow");
    expect([...root.querySelectorAll("[data-node]")].map((n) => n.getAttribute("data-node"))).toEqual(["A", "B", "C", "D"]);
    expect(root.querySelector('[data-group="S"] text')!.textContent).toBe("Warehouse");
    // Text is escaped, markup in labels is dropped.
    expect(root.querySelector('[data-node="A"] text')!.textContent).toBe("Start & go");
    expect([...root.querySelectorAll("text")].some((t) => t.textContent === "yes now")).toBe(true);
    // Mermaid styles win over the theme; the diamond is a four-point polygon.
    expect(root.querySelector('[data-node="A"] path')!.getAttribute("fill")).toBe("#fde68a");
    expect(root.querySelector('[data-node="B"] path')!.getAttribute("d")).toMatch(/^M[\d.]+,[\d.]+ L[\d.]+,[\d.]+ L[\d.]+,[\d.]+ L[\d.]+,[\d.]+ Z$/);
    // Edges end on the node borders with markers, and dotted edges are dashed.
    const edges = [...root.querySelectorAll("line[data-edge]")];
    expect(edges).toHaveLength(3);
    expect(edges[0]!.getAttribute("marker-end")).toBe("url(#pd-arrow-closed)");
    expect(edges[2]!.getAttribute("stroke-dasharray")).toBe("6 4");
    expect(svg).not.toMatch(/var\(|NaN/);
  });

  it("matches the canvas layout and stored positions", () => {
    const doc = parseMermaid('flowchart LR\n  %% @pixerate {"v":1,"layout":{"a":[100,40],"b":[400,40]}}\n  a --> b');
    const { svg } = mermaidToSvg(doc, { padding: 10 });
    const root = parse(svg).documentElement;
    // Content starts at the padding: the group is shifted by (pad - minX, pad - minY).
    expect(root.querySelector("g[transform]")!.getAttribute("transform")).toBe("translate(-90 -30)");
    expect(root.querySelector('[data-node="b"]')!.getAttribute("transform")).toBe("translate(400 40)");
    const layout = mermaidToCanvas(doc).layout;
    expect(mermaidToSvg(doc, { layout, padding: 10 }).svg).toBe(svg);
  });

  it("fits thumbnails without enlarging, and themes and transparency apply", () => {
    const doc = parseMermaid(SOURCE);
    const thumb = mermaidThumbnailSvg(doc);
    expect(thumb.width).toBeLessThanOrEqual(240);
    expect(thumb.height).toBeLessThanOrEqual(160);
    expect(thumb.width / thumb.height).toBeCloseTo(thumb.naturalWidth / thumb.naturalHeight, 1);
    const tiny = mermaidToSvg(parseMermaid("flowchart LR\n  a"), { maxWidth: 2000, maxHeight: 2000 });
    expect(tiny.width).toBe(tiny.naturalWidth);
    const dark = mermaidToSvg(doc, { theme: DIAGRAM_SVG_DARK_THEME });
    expect(dark.svg).toContain(`fill="${DIAGRAM_SVG_DARK_THEME.background}"`);
    expect(mermaidToSvg(doc, { transparent: true }).svg).not.toContain('<rect width=');
  });

  it("draws class members and ER attributes, and an empty diagram", () => {
    const cls = mermaidToSvg(parseMermaid("classDiagram\n  class Animal {\n    +String name\n    +move() void\n  }"));
    expect(cls.svg).toContain("+String name");
    expect(cls.svg).toContain("+move() void");
    const er = mermaidToSvg(parseMermaid("erDiagram\n  CUSTOMER {\n    string email\n  }"));
    expect(er.svg).toContain("string email");
    const empty = mermaidToSvg(parseMermaid("flowchart TD\n"));
    expect(parse(empty.svg).querySelector("parsererror")).toBeNull();
    expect(empty.width).toBeGreaterThan(0);
  });

  it("names files after the title or family", () => {
    expect(diagramFileName(parseMermaid(SOURCE), "png")).toBe("order-flow.png");
    expect(diagramFileName(parseMermaid("stateDiagram-v2\n  [*] --> A"), "svg")).toBe("state-diagram.svg");
  });
});

describe("rasterizeSvg", () => {
  it("sizes images by scale with the longest side capped", () => {
    expect(rasterSize(400, 200)).toEqual({ width: 800, height: 400, scale: 2 });
    expect(rasterSize(4000, 1000, 2, 2048)).toEqual({ width: 2048, height: 512, scale: 0.512 });
    expect(() => rasterSize(0, 10)).toThrow(/positive width and height/);
  });

  it("draws through an Image onto a canvas over the background", async () => {
    const calls: string[] = [];
    const context = { fillStyle: "", fillRect: () => calls.push("fill"), drawImage: () => calls.push("draw") };
    const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: () => "data:image/png;base64,QUJD" };
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        calls.push(value.slice(0, 26));
        queueMicrotask(() => this.onload?.());
      }
    }
    const doc = { createElement: () => canvas, defaultView: { Image: FakeImage } } as unknown as Document;
    const image = await rasterizeSvg(mermaidToSvg(parseMermaid(SOURCE)).svg, { width: 300, height: 100, document: doc });
    expect(image).toEqual({ data: "QUJD", mimeType: "image/png", width: 600, height: 200 });
    expect(calls).toEqual(["data:image/svg+xml;charset", "fill", "draw"]);
  });

  it("says what to do without a DOM", async () => {
    await expect(rasterizeSvg("<svg/>", { width: 10, height: 10, document: {} as Document })).rejects.toThrow(/needs a browser DOM/);
  });
});

describe("render_diagram tool", () => {
  const setup = (rasterize?: any) => {
    const controller = new DiagramController({ source: SOURCE });
    const registry = new ToolRegistry();
    registry.register(createDiagramToolProvider(controller, { renderSvg: (o) => mermaidToSvg(controller.getDocument(), o), rasterize }));
    return { controller, registry };
  };

  it("returns SVG text, or a PNG image when the host can rasterize", async () => {
    const { registry } = setup();
    const svg: any = await registry.callTool("render_diagram", { maxWidth: 200 });
    expect(svg.structuredContent.format).toBe("svg");
    expect(svg.structuredContent.width).toBeLessThanOrEqual(200);
    expect(svg.structuredContent.svg).toMatch(/^<svg /);
    const noPng: any = await registry.callTool("render_diagram", { format: "png" });
    expect(noPng.isError).toBe(true);
    expect(noPng.content[0].text).toMatch(/cannot make PNG/);

    const rasterize = vi.fn(async () => ({ data: "QUJD", mimeType: "image/png" }));
    const withPng = setup(rasterize);
    const png: any = await withPng.registry.callTool("render_diagram", { format: "png" });
    expect(png.content[0]).toEqual({ type: "image", data: "QUJD", mimeType: "image/png" });
    expect(rasterize).toHaveBeenCalledOnce();
    expect((await withPng.registry.callTool("render_diagram", { format: "gif" }) as any).isError).toBe(true);
  });

  it("is only listed when the host can draw, and refuses text-only families", async () => {
    const plain = new ToolRegistry();
    plain.register(createDiagramToolProvider(new DiagramController({ source: SOURCE })));
    expect(plain.hasTool("render_diagram")).toBe(false);
    const { registry, controller } = setup();
    controller.load('sankey-beta\n  a,b,1\n', { clearHistory: true });
    const result: any = await registry.callTool("render_diagram", {});
    expect(result.content[0].text).toMatch(/kept as Mermaid text/);
  });
});
